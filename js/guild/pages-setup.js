// ── PAGE: GUILD SETUP (lane B8a-setup; boards G1-G6 and P1 of the B8a admin canvas, template T5 flow) ──
// #/g/:gid/setup is the in-game guild flow: In-game guild -> Ranks -> Preview -> Switch over. It starts from Guild settings > Battle.net (the In-game guild panel) and sits under Guild
// settings (crumb "<guild> / Guild settings / Guild setup", shell.js). ONLY THE OWNER acts: the pin, the rank map, the flip dry run and the flip are Owner-only in the Worker; anyone else
// who opens the page sees the facts and no button.
//   1 In-game guild  the guild name is typed, the realm shown from the guild; the Battle.net sign-in carries the name (Guild.fresh purpose `pin`), then POST /bnet/pin (the act `pin`).
//   2 Ranks          GET /rank-map: every in-game rank with its name, core rank and permission; "Not mapped" ranks are left out of the PUT. Next = POST /rank-map/dry-run, then PUT.
//   3 Preview        POST /flip/dry-run: Owner panel, summary, count tiles and the Access / Ranks / Permissions / Characters panels. The characters matched by name only carry a tick each
//                    (default ticked). The preview and its token are for ONE selection of ticks (the answer's confirmedCharacterIds): a changed tick dims the counts that depend on it, shows
//                    "Update preview" (the dry run again with the ticked ids) and keeps Next / Switch over off until the preview matches the ticks.
//   4 Switch over    the facts again; the primary opens a confirm, its step 2 is the Battle.net sign-in (purpose `source_switch`, the act `source_switch` repeats POST /flip with the
//                    token and the ids the token was made for). The preview token lives 10 minutes: an older one, or the answer approval_invalid / approval_stale, shows "out of date" and
//                    runs the preview again (with the same ticks).
//   done             the result banner from the flip's `applied` counts.
// Pure parts (tests): refusalOf, rowsOf, mapBody, gapsOf, confirmedIds, pinnedGuildName, realmLabel. State: one module `view`; `handoff` carries what a repeated act (run on #/fresh) leaves for this page.
(function (G) {
  'use strict';

  const STEPS = ['In-game guild', 'Ranks', 'Preview', 'Switch over'];
  const PREVIEW_TTL_MS = 10 * 60 * 1000; // the dry run's token (worker/dry-run.js APPROVAL_TTL_MS)
  const FIRST_ROWS = 5;
  const FLIP_PURPOSE = 'source_switch';
  const CORE_LABEL = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' };
  const OWNER_ONLY = 'Only the Owner of the guild can set up the in-game guild.';
  // The lead of step 1 (board G1): Raidsmith's own guild name, the in-game guild comes with the form. The linked step (G1b) has none.
  function leadOf(gd) { return 'Raidsmith reads ' + gd.guild.name + '\'s guild roster from Battle.net. Confirm it is you, then name the guild to follow.'; }
  const RANKS_LEAD = 'Battle.net gives guild ranks as numbers only. Name each rank for the site, say what it counts as, and give it a permission if it needs one. Ranks nobody holds can stay unmapped.';
  const OUT_OF_DATE = 'This preview is out of date: the guild changed since you ran it. Run it again to see what would change now.';
  const TICKS_CHANGED = 'You changed which characters are matched. The counts and lists above are for the earlier ticks.';
  const SIGN_IN_TEXT = 'Sign in with Battle.net, then the switch runs. You come back to this page.';

  let view = null;    // the page's state (see newView)
  let handoff = null; // what a repeated act leaves for the page it returns to: { gid, pin, banner, flip, switched, rerun }

  function st() { return G.app.state; }
  function plural(n, one, many) { return G.ui.plural(n, one, many); }
  function setupHref(gid) { return G.router.format({ name: 'setup', gid: gid }); }
  function bnetHref(gid) { return G.router.format({ name: 'settings', gid: gid, tab: 'battlenet' }); }
  function path(gid, tail) { return '/api/guild/' + encodeURIComponent(gid) + tail; }
  function list(v) { return Array.isArray(v) ? v : []; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function nowMs() { return G.fresh.now(); }

  // ── names (pure) ──
  const loose = function (text) { return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, ''); };
  const titleOfSlug = function (slug) {
    return String(slug == null ? '' : slug).split('-').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  };

  // The pinned in-game guild's name as the page can say it: Battle.net's own spelling from the pin answer, else a name the guild already holds that has the pin's slug, else the slug in words.
  function pinnedGuildName(d, gd, pinResult) {
    const pin = d && d.pin ? d.pin : null;
    if (!pin || !pin.guildSlug) return '';
    const candidates = [pinResult && pinResult.guildName, d.effectiveGuildName, gd && gd.guild ? gd.guild.name : null];
    for (let i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'string' && candidates[i] && loose(candidates[i]) === loose(pin.guildSlug)) return candidates[i];
    }
    return titleOfSlug(pin.guildSlug);
  }

  // "Dreamscythe (US)": the realm the guild is read from. The pin's slug when linked, else the guild's own realm (a ruleset guild: the realm saved in Battle.net settings).
  // withoutRegion: "Dreamscythe" (the linked banner of board G1b).
  function realmLabel(d, gd, withoutRegion) {
    const guild = gd && gd.guild ? gd.guild : {};
    const slug = d && d.pin && d.pin.realmSlug ? d.pin.realmSlug : (d ? d.realmSlug : '');
    const region = guild.region && !withoutRegion ? ' (' + String(guild.region).toUpperCase() + ')' : '';
    if (guild.realm && (!slug || loose(guild.realm) === loose(slug))) return guild.realm + region;
    return slug ? titleOfSlug(slug) + region : (guild.realm ? guild.realm + region : '');
  }

  // The state of the guild's link to its in-game guild: none | linked (pinned, still on the Discord rule) | ingame (switched) | manual (ranks set by hand).
  function pinInfo(d) {
    const pin = d && d.pin ? d.pin : {};
    const source = pin.rankSource === undefined ? null : pin.rankSource;
    return {
      touched: !!pin.pinned, complete: !!pin.complete, source: source,
      state: source === 'ingame' ? 'ingame' : (source === 'manual' ? 'manual' : (pin.complete ? 'linked' : 'none')),
    };
  }

  function isOwner(gd) { return !!(gd && gd.owner && gd.owner.you); }
  function isGuildMaster(gd) { return G.shell.isGuildMaster(gd && gd.me && gd.me.roles); }

  // ── the rank map (pure) ──
  // One form row per in-game rank. An unused rank nobody mapped shows an empty name (its placeholder is "Rank 6").
  function rowsOf(map) {
    return list(map && map.ranks).map(function (r) {
      return {
        rank: r.rank, members: num(r.members), label: r.mapped || num(r.members) > 0 ? String(r.label == null ? '' : r.label) : '',
        core: r.coreRank || '', role: r.rank === 0 ? 'guild_master' : (r.roleId || ''),
      };
    });
  }
  function labelOf(row, defaults) {
    const text = String(row.label == null ? '' : row.label).replace(/\s+/g, ' ').trim();
    return text || (defaults && defaults[row.rank]) || (row.rank === 0 ? 'Guild Master' : 'Rank ' + row.rank);
  }
  // The body of the dry run and the PUT: "Not mapped" ranks (no core rank) are left out.
  function mapBody(rows, defaults) {
    return list(rows).filter(function (r) { return !!r.core; }).map(function (r) {
      return { rank: r.rank, label: labelOf(r, defaults), coreRank: r.core, roleId: r.rank === 0 ? 'guild_master' : (r.role || null) };
    });
  }
  // The ranks somebody holds that have no core rank yet (the flip refuses until none is left).
  function gapsOf(rows) { return list(rows).filter(function (r) { return r.members > 0 && !r.core; }); }
  function sameAsStored(map, body) {
    const stored = list(map && map.ranks).filter(function (r) { return r.mapped; }).map(function (r) {
      return { rank: r.rank, label: r.label, coreRank: r.coreRank, roleId: r.roleId || null };
    });
    return JSON.stringify(stored) === JSON.stringify(body.map(function (r) { return { rank: r.rank, label: r.label, coreRank: r.coreRank, roleId: r.roleId || null }; }));
  }
  function rankName(v, rank) {
    const row = v && v.rows ? v.rows.filter(function (r) { return r.rank === rank; })[0] : null;
    return row && (row.label || '').trim() ? row.label.trim() : (rank === 0 ? 'Guild Master' : 'Rank ' + rank);
  }

  // ── the name binding (pure): the ticks of "Bound by name only" ──
  // The page keeps what is UNTICKED (default: everything ticked). The samples (at most 25) show a tick each; the candidates beyond them share one tick (v.restTicked).
  function bindingOf(preview) {
    const b = preview && preview.boundByName ? preview.boundByName : {};
    const samples = list(b.samples);
    const sampleIds = samples.map(function (s) { return s.characterId; });
    const rest = list(b.ids).filter(function (id) { return sampleIds.indexOf(id) < 0; });
    return { count: num(b.count), ids: list(b.ids), samples: samples, rest: rest, classMismatch: num(b.classMismatch) };
  }
  function confirmedIds(v) {
    const b = bindingOf(v.preview);
    return b.ids.filter(function (id) { return b.rest.indexOf(id) >= 0 ? v.restTicked : !v.unticked[id]; });
  }
  // The preview and its token are for ONE selection of characters: the answer's `confirmedCharacterIds` (an answer without it is for every candidate). The switch sends exactly these.
  function previewIds(v) {
    const p = v && v.preview;
    return p && Array.isArray(p.confirmedCharacterIds) ? p.confirmedCharacterIds : bindingOf(p).ids;
  }
  function sameIds(a, b) { return a.length === b.length && a.slice().sort().join('\n') === b.slice().sort().join('\n'); }
  // The ticks on the page are not the ones the preview was made for: its counts are out of date until "Update preview" runs it again with these ticks.
  function ticksChanged(v) { return !!(v && v.preview) && !sameIds(confirmedIds(v), previewIds(v)); }

  // ── refusals (pure): one title and one sentence per code ──
  // refusalOf(err, ctx) -> { tone, title, text, actions }; ctx: { guildName (the in-game guild typed), ownerName, rows }. The Worker's own message is used where it carries the facts (a count, a list of ranks).
  const ACTION_LINKED = { label: 'Link Battle.net', href: '#/linked' };
  function ranksText(err, ctx) {
    const gaps = err && err.body && Array.isArray(err.body.ranks) ? err.body.ranks : [];
    if (!gaps.length) return 'Some ranks on the roster have no core rank yet.';
    return 'Not mapped yet: ' + gaps.map(function (g) { return (ctx && ctx.rows ? rankName({ rows: ctx.rows }, g.rank) : 'Rank ' + g.rank) + ' (' + plural(num(g.members), 'member', 'members') + ')'; }).join(', ') + '.';
  }
  const REFUSALS = {
    // the pin and its sign-in
    pin_not_open: { title: 'Linking to the in-game guild is not open yet.', text: 'Whoever runs this server switches it on for a guild.' },
    forbidden: { title: 'Only the Owner can do this.', text: OWNER_ONLY },
    identity_too_new: {
      title: 'This Battle.net account was linked a few days ago.',
      text: function (err) {
        const at = err && err.body && typeof err.body.eligibleAt === 'number' ? G.ui.formatDate(err.body.eligibleAt) : '';
        return at ? 'It can confirm this from ' + at + '.' : 'It can confirm this once it has been linked for 7 days.';
      },
    },
    identity_not_linked: { title: 'Link Battle.net to your account first.', text: 'The guild roster is read through Battle.net.', actions: [ACTION_LINKED] },
    bnet_unsupported: { title: 'Battle.net cannot read guilds of this game version.', text: function (err) { return err.message; } },
    bnet_not_configured: { title: 'Battle.net is not set up on this server.', text: 'Whoever runs this server has to set it up before a guild can be linked.' },
    bad_request: { title: 'Check what you typed.', text: function (err) { return err.message; } },
    bnet_guild_not_found: {
      title: function (err, ctx) { return 'Battle.net has no guild called ' + (ctx && ctx.guildName ? ctx.guildName : 'that') + ' on this realm.'; },
      text: 'Check how the guild name is spelled in game.',
    },
    bnet_guild_refused: { title: 'Battle.net would not show this roster.', text: 'Blizzard has had this fault on some realms before. Try again later.' },
    bnet_unavailable: { title: 'Battle.net did not answer.', text: 'Try again in a moment.' },
    bnet_roster_invalid: { title: 'Battle.net sent a roster that looks incomplete.', text: 'Nothing was read from it. Try again later.' },
    pin_not_on_roster: {
      title: function (err, ctx) { return 'None of your characters is on the ' + (ctx && ctx.guildName ? ctx.guildName : 'in-game guild') + ' roster.'; },
      text: 'Check the guild name, or sign in with the Battle.net account that holds your character.',
    },
    pin_taken: { title: 'Another Raidsmith guild already follows this in-game guild.', text: 'One in-game guild belongs to one Raidsmith guild.' },
    pin_locked: { title: 'This guild is linked to another in-game guild.', text: 'Only the same in-game guild can be linked again, after a rename or a realm move.' },
    roster_too_large: { title: 'That in-game guild is too large to link.', text: 'Raidsmith reads at most 1,200 members from Battle.net.' },
    roster_over_caps: { title: 'That in-game guild has too many members.', text: function (err) { return err.message; } },
    fresh_required: { title: 'The sign-in did not count.', text: 'Start again and sign in with Battle.net.' },
    rate_limited: { title: 'Too many tries.', text: function (err) { return G.api.classify(err).text; } },
    conflict: { title: 'The guild changed while this was running.', text: 'Nothing was saved. Reload the page and try again.' },
    // the rank map
    rank_zero_only: { title: 'Only rank 0 can be Guild Master.', text: 'Every other rank tops out at Officer.' },
    // the preview and the switch
    already_ingame: { title: 'This guild already follows the in-game guild.', text: 'There is nothing left to preview or switch.' },
    effective_roles_missing: { title: 'The switch cannot run on this server yet.', text: function (err) { return err.message; } },
    approval_required: { title: 'The preview did not come with its approval.', text: 'Run the preview again.' },
    approval_invalid: { title: 'This preview is out of date.', text: 'The guild changed since you ran it. Run it again to see what would change now.', stale: true },
    approval_stale: { title: 'This preview is out of date.', text: 'The guild changed since you ran it. Run it again to see what would change now.', stale: true },
    confirmation_required: { title: 'Say which characters to match by name.', text: 'Run the preview again, then tick the ones to match.' },
    bad_confirmation: { title: 'Some ticked characters are not on the preview.', text: 'Run the preview again, then tick the ones to match.' },
    confirmation_changed: { title: 'The ticked characters changed.', text: 'Update the preview, then switch over.' },
    source_not_legacy: { title: 'This guild does not take its members from the Discord server.', text: 'Only a guild that follows Discord roles can be switched to the in-game guild here.' },
    not_pinned: { title: 'Link the guild first.', text: 'Link the guild to its in-game guild in step 1, then switch.' },
    no_good_sync: { title: 'The guild roster has not been read yet.', text: 'Read it in step 1, then switch.' },
    no_owner: { title: 'This guild has no Owner yet.', text: 'There is nobody to switch it over.' },
    owner_would_be_suspended: {
      title: 'You would be suspended after the switch.',
      text: 'None of your characters is confirmed by Battle.net on the guild roster. Sign in with Battle.net first, then run the preview again.', bar: 'Sign in with Battle.net before you switch.',
    },
    rank_map_incomplete: { title: 'Map every in-game rank first.', text: ranksText, bar: 'Map every in-game rank first.' },
  };
  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const resolve = function (value, err, ctx) { return typeof value === 'function' ? value(err, ctx) : value; };

  function refusalOf(err, ctx) {
    const code = err && err.code ? err.code : 'error';
    const spec = has(REFUSALS, code) ? REFUSALS[code] : null;
    if (!spec) return { tone: 'warning', code: code, title: 'That did not go through.', text: G.api.classify(err).text, actions: [] };
    return {
      tone: 'warning', code: code, title: resolve(spec.title, err, ctx), text: resolve(spec.text, err, ctx), bar: spec.bar || null, stale: !!spec.stale, actions: spec.actions ? spec.actions.slice() : [],
    };
  }
  // The same refusal as one sentence (a dialog's inline error).
  function refusalLine(err, ctx) {
    const r = refusalOf(err, ctx);
    return r.title + ' ' + r.text;
  }
  const staleCode = function (code) { return code === 'approval_invalid' || code === 'approval_stale'; };

  // ── the view ──
  function newView(gid, gd, carried) {
    const c = carried || {};
    return {
      gid: gid, gd: gd, owner: isOwner(gd), loading: true, step: 1, bnet: null, pinResult: c.pin || null, banner: c.banner || null, error: null, fieldError: {}, busy: false,
      pinName: '', pinRealm: '', map: null, rows: [], preview: null, previewAt: 0, previewLoading: false, updating: false, unticked: {}, restTicked: true, expanded: {},
      result: c.flip || null, switched: !!c.switched, dialogStale: false, syncError: '',
    };
  }
  function takeHandoff(gid) {
    const h = handoff && handoff.gid === gid ? handoff : null;
    handoff = null;
    return h || {};
  }
  function render() { if (G.app && G.app.render) G.app.render(); }
  // A step change: the page starts at its top, with the heading focused.
  function settle() {
    try {
      if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
      const h = typeof document !== 'undefined' && document.getElementById ? document.getElementById('page-title') : null;
      if (h && h.focus) h.focus({ preventScroll: true });
    } catch (e) { /* no layout to move */ }
  }
  function go(v, step) {
    v.step = step; v.error = null; v.banner = null; v.fieldError = {};
    render();
    settle();
  }

  // A failed call: a sign-out goes to the sign-in, a "you cannot open this" answer is a page, everything else is the banner of the step.
  function fail(v, err, extra) {
    v.busy = false;
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
    const refusal = refusalOf(err, { guildName: v.pinName, rows: v.rows });
    if (extra && extra.actions) refusal.actions = refusal.actions.concat(extra.actions);
    v.error = refusal;
    render();
  }

  // ── reads and steps ──
  function ensureMap(v) {
    if (v.map) return Promise.resolve(v.map);
    return G.api.get(path(v.gid, '/rank-map')).then(function (map) {
      if (view === v) { v.map = map; v.rows = rowsOf(map); }
      return map;
    });
  }

  // The page's ticks are the ones the answer was made for (a new answer starts in sync).
  function adoptTicks(v, preview) {
    const b = bindingOf(preview);
    const ids = previewIds({ preview: preview });
    v.unticked = {};
    b.ids.forEach(function (id) { if (ids.indexOf(id) < 0) v.unticked[id] = true; });
    v.restTicked = b.rest.every(function (id) { return ids.indexOf(id) >= 0; });
  }

  // The flip dry run. ids: the characters to count as matched (the ticks), or null = every candidate. keep: an update of a preview that is on the page (it stays, dimmed, until the answer).
  function runPreview(v, ids, keep) {
    if (keep) v.updating = true; else v.previewLoading = true;
    v.error = null;
    render();
    return G.api.post(path(v.gid, '/flip/dry-run'), ids ? { confirmedCharacterIds: ids } : {}).then(function (res) {
      if (view !== v) return;
      v.previewLoading = false; v.updating = false; v.preview = res; v.previewAt = nowMs(); adoptTicks(v, res);
      render();
    }, function (err) {
      if (view !== v) return;
      v.previewLoading = false; v.updating = false;
      if (err && err.code === 'already_ingame') { v.preview = null; markSwitched(v, null); return; }
      if (err && err.code === 'bad_confirmation' && ids) {
        // A ticked character is no candidate any more (the roster moved): start again from every candidate ticked.
        v.preview = null; v.banner = { tone: 'info', title: 'The list of characters to match changed.', text: 'Every one is ticked again.' };
        return runPreview(v, null, false);
      }
      if (!keep) v.preview = null;
      fail(v, err, { actions: [{ label: 'Run the preview again', attrs: { 'data-action': 'setup-preview-again', 'data-key': 'setup-preview-again' } }] });
    });
  }
  // A preview on the page keeps its ticks when it runs again (the step was left and entered, or the token was too old).
  function enterPreview(v) {
    v.step = 3; v.error = null; v.banner = null; v.dialogStale = false; v.previewAt = 0;
    settle();
    return runPreview(v, v.preview ? confirmedIds(v) : null, false);
  }
  // The guild follows the in-game guild now (a switch just done, or found done): the result step.
  function markSwitched(v, applied) {
    v.busy = false;
    if (v.bnet && v.bnet.pin) v.bnet.pin.rankSource = 'ingame';
    v.step = STEPS.length + 1; v.result = applied || v.result; v.error = null; v.banner = null; v.switched = true;
    render();
    settle();
    if (G.app && G.app.refreshGuild) G.app.refreshGuild(v.gid); // the nav and the guild's facts follow the new rank source
  }

  // Read the roster again: the Guild Master's Sync now (the Worker refuses anyone else).
  function readAgainActions(v) {
    return isGuildMaster(v.gd) ? [{ label: 'Read it again', attrs: { 'data-action': 'setup-sync', 'data-key': 'setup-sync' } }] : [];
  }
  function pinBanner(v) {
    const res = v.pinResult;
    if (!res) return null;
    const d = v.bnet;
    const name = res.guildName || pinnedGuildName(d, v.gd, res);
    const members = d && d.roster ? num(d.roster.members) : num(res.sync && res.sync.members);
    const read = res.sync && (res.sync.status === 'applied' || res.sync.status === 'unchanged') || members > 0;
    return read
      ? { tone: 'success', title: 'Linked to ' + name + ' on ' + realmLabel(d, v.gd, true) + '.', text: plural(members, 'member', 'members') + ' read from the guild roster.' }
      : { tone: 'warning', title: 'Linked to ' + name + '.', text: v.syncError || 'The guild roster could not be read just now.', actions: readAgainActions(v) };
  }

  function load(r, gd) {
    const carried = takeHandoff(r.gid);
    const v = view = newView(r.gid, gd, carried);
    return G.api.get(path(r.gid, '/bnet')).then(function (d) {
      if (view !== v) return null;
      v.bnet = d; v.loading = false;
      v.pinName = d.effectiveGuildName || (gd && gd.guild ? gd.guild.name : '');
      v.pinRealm = d.realmSlug || '';
      const info = pinInfo(d);
      if (info.state === 'ingame') { v.step = STEPS.length + 1; v.pinResult = null; return null; }
      if (carried.pin && !v.banner) v.banner = pinBanner(v);
      if (!v.owner || info.state !== 'linked') return null;
      if (carried.rerun && num(d.roster && d.roster.members) > 0) {
        // A repeated switch could not run (the preview was out of date, or the flip refused): the Preview step again, with the reason above it.
        v.step = 3;
        return ensureMap(v).then(function () { return runPreview(v, Array.isArray(carried.ids) ? carried.ids : null, false); }, function () { return null; });
      }
      return null;
    }, function (err) {
      if (view === v) v.loading = false;
      throw err;
    });
  }

  // ── html pieces (the markup of the approved boards, p1.js) ──
  function sl(text) { return '<h3 class="gs-hd-sl">' + esc(text) + '</h3>'; }
  function lead(text) { return '<p class="gs-fine gs-su-lead">' + esc(text) + '</p>'; }
  function sub(text) { return '<span class="gs-fine gs-su-sub">' + esc(text) + '</span>'; }
  function chip(tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; }
  function fact(label, valueHtml, actionHtml) {
    return '<div class="gs-ro-row gs-su-fact"><div class="gs-su-fact-main"><dt class="gs-ro-label">' + esc(label) + '</dt><dd class="gs-ro-value">' + valueHtml + '</dd></div>' + (actionHtml || '') + '</div>';
  }
  function factPanel(title, rowsHtml, o) {
    const x = o || {};
    return '<div class="gs-hd-panel gs-card-sec' + (x.cls ? ' ' + x.cls : '') + '"><div class="gs-card-sec-head"><h2 class="gs-h2">' + esc(title) + '</h2>' + (x.headHtml || '') + '</div><dl class="gs-ro-list gs-su-facts">' + rowsHtml + '</dl></div>';
  }
  function kv(label, valueHtml) { return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + valueHtml + '</span></div>'; }
  function banner(b) {
    if (!b) return '';
    return G.ui.bannerHtml({ tone: b.tone || 'warning', title: b.title, text: b.text, actions: b.actions, dismissible: false });
  }
  function nameOf(sample) { return sample && sample.name ? sample.name : 'Unnamed account'; }
  function boldName(text) { return '<span class="gs-su-name">' + esc(text) + '</span>'; }
  // The Owner is named one way on every screen of the flow (boards G3 to G5): the account's name from the guild's Owner block, not the person the preview lists them under.
  function ownerName(v, gd) {
    const o = v && v.preview && v.preview.owner ? v.preview.owner : {};
    return gd && gd.owner && gd.owner.name ? gd.owner.name : (o.name || 'The Owner');
  }
  // "3 stay, 1 gains access, 0 lose it": the three counts of who is a member after the switch, each with its own verb.
  function movesText(s) { return plural(s.stay, 'stays', 'stay') + ', ' + plural(s.gains, 'gains access', 'gain access') + ', ' + plural(s.loses, 'loses it', 'lose it'); }
  function trialText(n) { return n + ' of them ' + (n === 1 ? 'becomes' : 'become') + ' Trial'; }
  // "2 roles from Discord become hand-set" (withNoun) / "2 from Discord become hand-set" (the dialog, board G4).
  function handSetText(n, withNoun) { return (withNoun ? plural(n, 'role', 'roles') : String(n)) + ' from Discord ' + (n === 1 ? 'becomes' : 'become') + ' hand-set'; }

  // ── step 1: In-game guild (boards G1, G1b, G6 #4) ──
  function pinPanelHtml(v, gd) {
    const d = v.bnet;
    const info = pinInfo(d);
    const done = info.complete;
    const ruleset = d.realmKind === 'ruleset';
    const ro = done || !v.owner ? ' readonly' : '';
    const nameValue = done ? pinnedGuildName(d, gd, v.pinResult) : v.pinName;
    const nameErr = v.fieldError && v.fieldError.name;
    const realmErr = v.fieldError && v.fieldError.realm;
    const realmField = ruleset
      ? '<div class="gs-field"><label class="gs-label" for="pin-realm">Realm the guild lives on</label><input class="gs-input" type="text" id="pin-realm" maxlength="50" autocomplete="off" placeholder="old-blanchy" value="' +
        esc(done ? (d.pin.realmSlug || '') : v.pinRealm) + '"' + ro + ' data-input="setup-pin-realm"><p class="gs-fine">As the realm is named, or in its URL form.</p>' +
        (realmErr ? '<p class="gs-field-error" role="alert">' + esc(realmErr) + '</p>' : '') + '</div>'
      : '<p class="gs-fine" id="pin-realm">Realm: ' + esc(realmLabel(d, gd)) + '</p>';
    const fields = '<div class="gs-hd-panel gs-card-sec"><div class="gs-card-sec-head"><h2 class="gs-h2">Which guild</h2></div><div class="gs-su-form">' +
      '<div class="gs-field"><label class="gs-label" for="pin-name">In-game guild name</label><input class="gs-input" type="text" id="pin-name" maxlength="32" autocomplete="off" value="' + esc(nameValue) + '"' + ro +
      ' data-input="setup-pin-name"' + (nameErr ? ' aria-invalid="true"' : '') + '><p class="gs-fine">As it is spelled in game.</p>' + (nameErr ? '<p class="gs-field-error" role="alert">' + esc(nameErr) + '</p>' : '') + '</div>' +
      realmField + '</div></div>';
    const linked = G.fresh.linkedOf(st().me);
    const tag = linked && linked.bnet ? (linked.bnet === 'linked' ? 'Linked' : linked.bnet) : null;
    const who = factPanel('Confirm it is you', fact('Battle.net account', tag ? esc(tag) + sub(done ? (v.pinResult ? 'Confirmed just now.' : 'Confirmed when the guild was linked.') : 'Raidsmith checks that this account holds a character on the guild\'s roster.')
      : '<span class="gs-muted">Not linked yet</span>' + sub('Link Battle.net to your account first: the guild roster is read through it.')), done ? { cls: 'is-done' } : {});
    return fields + who;
  }

  function step1Html(v, gd) {
    const d = v.bnet;
    const info = pinInfo(d);
    const members = num(d.roster && d.roster.members);
    let html = banner(v.banner) + banner(v.error);
    if (!v.owner) {
      const who = gd && gd.owner && gd.owner.name ? gd.owner.name : 'the Owner';
      return banner({ tone: 'info', title: 'Only ' + who + ' can set up the in-game guild.', text: 'You can see how far it is here.' }) + readOnlyFacts(v, gd);
    }
    html += (info.complete ? '' : lead(leadOf(gd))) + pinPanelHtml(v, gd);
    if (info.complete && members === 0 && !v.banner) {
      html += banner({ tone: 'warning', title: 'The guild roster has not been read yet.', text: v.syncError || 'Battle.net did not give it just now.', actions: readAgainActions(v) });
    }
    return html;
  }
  function step1Bar(v, gd) {
    if (!v.owner) return null;
    const d = v.bnet;
    const info = pinInfo(d);
    const realm = realmLabel(d, gd);
    if (info.complete) {
      const members = num(d.roster && d.roster.members);
      return {
        text: pinnedGuildName(d, gd, v.pinResult) + ', ' + realm + (members ? ': ' + plural(members, 'member', 'members') + '.' : '. The roster has not been read yet.'),
        commit: { label: 'Next', disabled: v.busy || members === 0, attrs: { 'data-action': 'setup-pin-next', 'data-key': 'setup-pin-next' } },
      };
    }
    return {
      text: (v.pinName ? v.pinName + ', ' : '') + realm + '.',
      commit: { label: 'Confirm with Battle.net', disabled: v.busy, attrs: { 'data-action': 'setup-pin', 'data-key': 'setup-pin' } },
    };
  }

  // What a person who is not the Owner sees: the facts, no button.
  function readOnlyFacts(v, gd) {
    const d = v.bnet;
    const info = pinInfo(d);
    const members = num(d.roster && d.roster.members);
    const guildRow = info.state === 'none'
      ? '<span class="gs-muted">Not linked yet</span>'
      : esc(pinnedGuildName(d, gd, null) + ' on ' + realmLabel(d, gd));
    return factPanel('In-game guild', fact('Guild', guildRow) + fact('Roster', members ? esc(plural(members, 'member', 'members')) + (d.roster.fetchedAt ? sub('Last read ' + G.ui.formatStamp(d.roster.fetchedAt, gd.guild.timeZone)) : '') : '<span class="gs-muted">Not read yet</span>'));
  }

  // ── step 2: Ranks (boards G2, G6 #1) ──
  const ROLE_NONE = { value: '', label: 'None' };
  function roleOptions(map) {
    const roles = list(map && map.roles).filter(function (r) { return !r.rankZeroOnly; }).map(function (r) {
      return { value: r.id, label: r.id === 'team_lead' ? 'Team Lead (their own team)' : r.name };
    });
    return [ROLE_NONE].concat(roles);
  }
  function coreOptions(map) {
    const cores = list(map && map.coreRanks);
    return [{ value: '', label: 'Not mapped' }].concat((cores.length ? cores : Object.keys(CORE_LABEL).map(function (id) { return { id: id, label: CORE_LABEL[id] }; })).map(function (c) { return { value: c.id, label: c.label }; }));
  }
  function ranksTableHtml(v) {
    const core = coreOptions(v.map);
    const roles = roleOptions(v.map);
    const defaults = v.bnet && v.bnet.rankDefaults ? v.bnet.rankDefaults : [];
    const head = '<th scope="col">In-game rank</th><th scope="col">Name on the site</th><th scope="col">Core rank</th><th scope="col">Permission</th><th scope="col" class="gs-num">Members</th>';
    const rows = v.rows.map(function (r) {
      const unused = r.members === 0;
      const gap = unused ? false : !r.core;
      const cls = [unused ? 'is-unused' : '', gap ? 'is-gap' : ''].filter(Boolean).join(' ');
      const id = 'rk-' + r.rank;
      const roleCell = r.rank === 0
        ? '<label class="gs-sr" for="' + id + '-p">Rank 0: permission</label><select class="gs-input" id="' + id + '-p" disabled><option>Guild Master</option></select>'
        : '<label class="gs-sr" for="' + id + '-p">Rank ' + r.rank + ': permission</label><select class="gs-input" id="' + id + '-p" data-change="setup-rank-role" data-rank="' + r.rank + '" data-key="' + id + '-p">' + G.ui.optionsHtml(roles, r.role) + '</select>';
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row" class="gs-cell-strong">Rank ' + r.rank + '</th>' +
        '<td data-label="Name on the site"><label class="gs-sr" for="' + id + '-n">Rank ' + r.rank + ': name on the site</label><input class="gs-input" type="text" id="' + id + '-n" maxlength="32" autocomplete="off" placeholder="' +
        esc(defaults[r.rank] || 'Rank ' + r.rank) + '" value="' + esc(r.label) + '" data-input="setup-rank-label" data-rank="' + r.rank + '"></td>' +
        '<td data-label="Core rank"><label class="gs-sr" for="' + id + '-c">Rank ' + r.rank + ': core rank</label><select class="gs-input" id="' + id + '-c" data-change="setup-rank-core" data-rank="' + r.rank + '" data-key="' + id + '-c"' +
        (gap ? ' aria-invalid="true"' : '') + '>' + G.ui.optionsHtml(core, r.core) + '</select></td>' +
        '<td data-label="Permission">' + roleCell + '</td>' +
        '<td data-label="Members" class="gs-num">' + (unused ? '<span class="gs-muted">0</span>' : r.members) + '</td></tr>';
    }).join('');
    return '<div class="gs-table-wrap gs-hd-panel"><table class="gs-table gs-table-stack gs-table-ranks" aria-label="In-game ranks"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function step2Html(v) {
    if (!v.map) return banner(v.error) + G.ui.loadingHtml({ label: 'Loading the ranks', rows: 4 });
    const gaps = gapsOf(v.rows);
    const gapBanner = gaps.length ? banner({
      tone: 'warning', title: 'Map every in-game rank first.',
      text: 'Not mapped yet: ' + gaps.map(function (g) { return rankName(v, g.rank) + ' (' + plural(g.members, 'member', 'members') + ')'; }).join(', ') + '.',
    }) : '';
    return banner(v.error) + lead(RANKS_LEAD) + gapBanner + ranksTableHtml(v);
  }
  function step2Bar(v) {
    const used = v.rows.filter(function (r) { return r.members > 0; });
    const gaps = gapsOf(v.rows);
    const text = !used.length ? 'No rank is in use yet.' : (gaps.length ? gaps.length + ' of ' + used.length + ' ranks in use are not mapped.' : used.length + ' of ' + used.length + ' ranks in use are mapped.');
    return {
      text: text, back: { label: 'Back', attrs: { 'data-action': 'setup-back', 'data-key': 'setup-back' } },
      commit: { label: 'Next', disabled: v.busy || !v.map || gaps.length > 0, attrs: { 'data-action': 'setup-ranks-next', 'data-key': 'setup-ranks-next' } },
    };
  }

  // ── step 3: Preview (boards G3, G6 #2, P1) ──
  const WHY_LOSE = {
    discord_only: 'Only in Discord: no person of the guild is theirs', needs_claim: 'Their person waits for their claim', no_roster_character: 'No character of theirs is on the roster',
    all_former: 'Every character of theirs has left the guild', owner_exemption: 'Is in the guild only as its Owner',
  };
  const WHY_GAIN = { linked_person: 'Their person is on the roster', owner: 'They hold the Owner seat' };
  const WHY_PERM_LOSE = { owner_not_live: 'The Owner would be suspended', guild_master_row_removed: 'Their Guild Master role is removed' };

  // One group of a panel: head with its count, the table (the first rows, then "Show all" for the samples the answer carries), and a line when the answer carries fewer than the count.
  function groupHtml(v, key, title, count, cols, rows, o) {
    const x = o || {};
    const open = !!v.expanded[key] || x.all; // x.all: a group the Owner decides on row by row (the ticks) shows every row it has
    const shown = open || rows.length <= FIRST_ROWS ? rows : rows.slice(0, FIRST_ROWS);
    const head = '<tr>' + cols.map(function (c) { return '<th scope="col"' + (c.num ? ' class="gs-num"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr>';
    const body = shown.map(function (r) {
      return '<tr>' + r.map(function (cell, i) {
        return i === 0 ? '<th scope="row" class="gs-cell-strong">' + cell + '</th>' : '<td data-label="' + esc(cols[i].label) + '"' + (cols[i].num ? ' class="gs-num"' : '') + '>' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('');
    let more = '';
    if (shown.length < rows.length) {
      more = '<p class="gs-su-showall gs-fine">Showing ' + shown.length + ' of ' + count + ' ' + G.ui.buttonHtml({ label: 'Show all', variant: 'link', attrs: { 'data-action': 'setup-show-all', 'data-group': key, 'data-key': 'setup-more-' + key } }) + '</p>';
    } else if (count > rows.length) {
      more = '<p class="gs-su-showall gs-fine">Showing ' + rows.length + ' of ' + count + '.</p>';
    }
    return '<div class="gs-su-group' + (x.cls ? ' ' + x.cls : '') + '" data-group="' + esc(key) + '"><h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(title) + '</span><span class="gs-fg-ghn">' + count + '</span></h3>' + (x.leadHtml || '') +
      (rows.length ? '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-prev" aria-label="' + esc(title) + '"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' : '') + more + (x.noteHtml || '') + '</div>';
  }
  function noneGroup(title, text) {
    return '<div class="gs-su-group"><h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(title) + '</span><span class="gs-fg-ghn">0</span></h3><p class="gs-su-none gs-fine">' + esc(text) + '</p></div>';
  }
  // stale: the counts of this panel are for earlier ticks (dimmed until the preview is updated).
  function previewPanel(title, innerHtml, stale) {
    return '<section class="gs-hd-panel gs-su-list' + (stale ? ' is-stale' : '') + '" aria-label="' + esc(title) + '"><h2 class="gs-h2 gs-su-list-h">' + esc(title) + '</h2>' + innerHtml + '</section>';
  }
  function coreName(id) { return has(CORE_LABEL, id) ? CORE_LABEL[id] : (id ? String(id).charAt(0).toUpperCase() + String(id).slice(1) : 'Social'); }
  function teamOf(sample) { return sample.teamName ? sample.teamName : '<span class="gs-muted">Whole guild</span>'; }
  function roleLine(sample) { return esc(sample.roleName || sample.roleId || '') + (sample.teamName ? ', ' + esc(sample.teamName) : ''); }

  function ownerPanelHtml(v, gd) {
    const o = v.preview.owner || {};
    const name = ownerName(v, gd);
    if (o.exists === false) return factPanel('Owner', fact('Nobody', chip('rose', 'No Owner') + sub('This guild has no Owner yet, so there is nobody to switch it over.')), { cls: 'gs-su-owner is-bad' });
    if (o.live) {
      const via = o.via && o.via.characterName ? o.via.characterName + ' (rank ' + o.via.rank + ', ' + rankName(v, o.via.rank) + ')' : 'A character of this account';
      return factPanel('Owner', fact(name, chip('green', 'Live') + sub(via + ' is on the roster and confirmed by Battle.net, so ' + name + ' keeps every Owner power.')), { cls: 'gs-su-owner' });
    }
    return factPanel('Owner', fact(name, chip('rose', 'Would be suspended') +
      sub('No character of this account is confirmed on the guild roster. After the switch the Owner seat would be suspended and only the powers of your in-game rank would remain.'),
      G.ui.buttonHtml({ label: 'Sign in with Battle.net', href: '/auth/bnet/login' })), { cls: 'gs-su-owner is-bad' });
  }

  function tickHtml(id, label, on, key, off) {
    return '<label class="gs-su-chkbox"><input type="checkbox" class="gs-su-chk" id="bn-' + esc(key) + '" data-change="setup-bind" data-id="' + esc(id) + '" data-key="setup-bind-' + esc(key) + '"' + (on ? ' checked' : '') +
      (off ? ' disabled' : '') + ' aria-label="' + esc(label) + '"></label>';
  }

  function accessPanelHtml(v) {
    const p = v.preview;
    const loses = p.access.loses;
    const gains = p.access.gains;
    const claim = p.needsClaim || {};
    const loseRows = list(loses.samples).map(function (s) { return [boldName(nameOf(s)), esc(has(WHY_LOSE, s.reason) ? WHY_LOSE[s.reason] : s.reason)]; });
    const gainRows = list(gains.samples).map(function (s) { return [boldName(nameOf(s)), esc(has(WHY_GAIN, s.reason) ? WHY_GAIN[s.reason] : s.reason)]; });
    const claimRows = list(claim.samples).map(function (s) { return [boldName(nameOf(s)), s.onRoster ? 'Yes' : '<span class="gs-muted">No</span>']; });
    const claimNote = num(claim.count) ? '<p class="gs-su-none gs-fine">' + esc(num(claim.onRoster) + ' of the ' + num(claim.count) + (num(claim.count) === 1 ? ' is' : ' are') + ' on the roster. The switch links nobody: each player claims theirs with This is me.') + '</p>' : '';
    return previewPanel('Access',
      (num(loses.count) ? groupHtml(v, 'lose', 'Lose access', num(loses.count), [{ label: 'Account' }, { label: 'Why' }], loseRows) : noneGroup('Lose access', 'Nobody loses access.')) +
      (num(gains.count) ? groupHtml(v, 'gain', 'Gain access', num(gains.count), [{ label: 'Account' }, { label: 'Why' }], gainRows) : noneGroup('Gain access', 'Nobody gains access.')) +
      (num(claim.count) ? groupHtml(v, 'claim', 'Waiting for their claim', num(claim.count), [{ label: 'Person' }, { label: 'On the roster' }], claimRows, { noteHtml: claimNote }) : noneGroup('Waiting for their claim', 'Nobody is waiting for a claim.')),
      ticksChanged(v));
  }

  function ranksPanelHtml(v) {
    const r = v.preview.ranks || {};
    const transitions = list(r.transitions).map(function (t) { return [esc(coreName(t.from)), esc(coreName(t.to)), String(num(t.count))]; });
    // Board G3: the characters that become Trial (the Worker lists them first), each with the in-game rank that makes them Trial.
    const trial = list(r.samples).filter(function (s) { return s.to === 'trial'; }).map(function (s) {
      const rank = s.rosterRank === null || s.rosterRank === undefined ? '<span class="gs-muted">-</span>' : esc(rankName(v, s.rosterRank));
      return [G.ui.classNameHtml(s.name, s.class), esc(coreName(s.from)), rank];
    });
    return previewPanel('Ranks',
      (num(r.changed) ? groupHtml(v, 'trans', 'Core rank changes', num(r.changed), [{ label: 'Today' }, { label: 'After the switch' }, { label: 'Characters', num: true }], transitions, { noteHtml: '' }) : noneGroup('Core rank changes', 'No character changes core rank.')) +
      (num(r.becomesTrial) ? groupHtml(v, 'trial', 'Become Trial', num(r.becomesTrial), [{ label: 'Character' }, { label: 'Today' }, { label: 'In-game rank' }], trial) : noneGroup('Become Trial', 'No character becomes Trial.')),
      ticksChanged(v));
  }

  function permissionsPanelHtml(v) {
    const perms = v.preview.permissions || {};
    const gains = perms.gains || { count: 0, samples: [] };
    const loses = perms.loses || { count: 0, samples: [] };
    const discord = perms.discordRoles || { count: 0, samples: [] };
    const gainRows = list(gains.samples).map(function (s) { return [boldName(nameOf(s)), esc(s.roleName || s.roleId || ''), teamOf(s)]; });
    const loseRows = list(loses.samples).map(function (s) { return [boldName(nameOf(s)), esc(s.roleName || s.roleId || ''), esc(has(WHY_PERM_LOSE, s.reason) ? WHY_PERM_LOSE[s.reason] : s.reason)]; });
    const discordRows = list(discord.samples).map(function (s) { return [boldName(nameOf(s)), roleLine(s), s.handTwin ? 'Also set by hand: the copy is removed' : '<span class="gs-muted">Kept</span>']; });
    return previewPanel('Permissions',
      (num(gains.count) ? groupHtml(v, 'permgain', 'New permissions', num(gains.count), [{ label: 'Account' }, { label: 'Permission' }, { label: 'Team' }], gainRows) : noneGroup('New permissions', 'No permission is given.')) +
      (num(discord.count) ? groupHtml(v, 'discordroles', 'Roles from Discord that become hand-set', num(discord.count), [{ label: 'Account' }, { label: 'Role' }, { label: 'Note' }], discordRows) : '') +
      (num(loses.count) ? groupHtml(v, 'permlose', 'Lose permissions', num(loses.count), [{ label: 'Account' }, { label: 'Permission' }, { label: 'Why' }], loseRows) : noneGroup('Lose permissions', 'No permission is taken away.')));
  }

  function rankLabelOfRoster(v, rank) { return rankName(v, rank); }
  function charactersPanelHtml(v) {
    const off = v.preview.notOnRoster || {};
    const bind = bindingOf(v.preview);
    const offRows = list(off.samples).map(function (s) { return [G.ui.classNameHtml(s.character, s.class), s.person ? esc(s.person) : '<span class="gs-muted">-</span>', s.after === 'former' ? 'Former' : 'Social']; });
    const stale = ticksChanged(v);
    const bindRows = bind.samples.map(function (s, i) {
      return [tickHtml(s.characterId, 'Match ' + s.name + ' to the roster', !v.unticked[s.characterId], String(i), v.updating), G.ui.classNameHtml(s.name, s.class), esc(rankLabelOfRoster(v, s.rosterRank))];
    });
    if (bind.rest.length) {
      bindRows.push([tickHtml('*rest*', 'Match the other ' + bind.rest.length + ' characters to the roster', v.restTicked, 'rest', v.updating), '<span class="gs-muted">' + esc(plural(bind.rest.length, 'more character', 'more characters')) + '</span>', '']);
    }
    // The ticks moved since the preview ran: say so right where they are set, with the way out. The counts and lists that depend on them are dimmed until it is updated.
    const ticksNote = stale || v.updating
      ? '<div class="gs-su-ticknote">' + G.ui.bannerHtml({
        tone: 'info', text: TICKS_CHANGED, dismissible: false, id: 'setup-ticks-changed',
        actions: [{ label: 'Update preview', busy: !!v.updating, busyLabel: 'Updating the preview...', attrs: { 'data-action': 'setup-preview-update', 'data-key': 'setup-preview-update' } }],
      }) + '</div>'
      : '';
    const note = '<p class="gs-su-none gs-fine">' + esc('Unticked characters are not matched: they stay Social and off the roster.' +
      (bind.classMismatch ? ' ' + plural(bind.classMismatch, 'more has', 'more have') + ' the right name with another class and ' + (bind.classMismatch === 1 ? 'is' : 'are') + ' not matched.' : '')) + '</p>';
    return previewPanel('Characters',
      (num(off.count) ? groupHtml(v, 'notonroster', 'Not on the guild roster', num(off.count), [{ label: 'Character' }, { label: 'Person' }, { label: 'After the switch' }], offRows, { cls: stale ? 'is-stale' : '' }) : noneGroup('Not on the guild roster', 'Every character is on the guild roster.')) +
      (bind.count ? groupHtml(v, 'bound', 'Matched by name only', bind.count, [{ label: 'Match' }, { label: 'Character' }, { label: 'Roster rank' }], bindRows, { noteHtml: note, leadHtml: ticksNote, all: true }) : ''));
  }

  function statHtml(n, label) { return '<div class="gs-hd-panel gs-su-stat"><span class="gs-fg-lbl">' + esc(label) + '</span><span class="gs-su-stat-n">' + n + '</span></div>'; }

  function summaryOf(v, gd) {
    const p = v.preview;
    const members = p.access.members || { today: 0, afterFlip: 0 };
    const loses = num(p.access.loses.count);
    const gains = num(p.access.gains.count);
    return { after: num(members.afterFlip), stay: Math.max(0, num(members.today) - loses), gains: gains, loses: loses, changed: num(p.ranks && p.ranks.changed), trial: num(p.ranks && p.ranks.becomesTrial), perms: num(p.permissions && p.permissions.gains && p.permissions.gains.count) };
  }

  function blockersOf(v) { return v.preview ? list(v.preview.blockers) : []; }
  function blockerText(b) {
    const r = refusalOf({ code: b.code, message: b.message, body: b });
    return r.bar || r.title;
  }

  function step3Html(v, gd) {
    if (v.previewLoading || (!v.preview && !v.error)) return banner(v.banner) + G.ui.loadingHtml({ label: 'Checking what the switch would change', rows: 5 });
    if (!v.preview) return banner(v.banner) + banner(v.error);
    const p = v.preview;
    const s = summaryOf(v, gd);
    const blockers = blockersOf(v);
    const blockBanner = blockers.filter(function (b) { return b.code !== 'owner_would_be_suspended'; }).slice(0, 1).map(function (b) {
      return banner({ tone: 'warning', title: refusalOf({ code: b.code, message: b.message, body: b }, { rows: v.rows }).title, text: refusalOf({ code: b.code, message: b.message, body: b }, { rows: v.rows }).text });
    }).join('');
    const stale = ticksChanged(v);
    const summary = '<p class="gs-su-summary' + (stale ? ' is-stale' : '') + '"><strong>' + esc(plural(s.after, 'account is a member', 'accounts are members') + ' of ' + gd.guild.name + ' after the switch.') + '</strong> ' +
      esc(movesText(s) + '.') + '</p>';
    const tiles = '<div class="gs-su-stats' + (stale ? ' is-stale' : '') + '">' + statHtml(s.loses, 'Lose access') + statHtml(s.gains, 'Gain access') + statHtml(s.changed, 'Core rank changes') + statHtml(s.trial, 'Become Trial') + statHtml(s.perms, 'New permissions') + '</div>';
    return banner(v.banner) + banner(v.error) + blockBanner + ownerPanelHtml(v, gd) + summary + tiles + accessPanelHtml(v) + ranksPanelHtml(v) + permissionsPanelHtml(v) + charactersPanelHtml(v);
  }
  function barTextOf(v, gd) {
    const s = summaryOf(v, gd);
    return plural(s.after, 'member', 'members') + ' after the switch, ' + plural(s.changed, 'core rank changes', 'core ranks change') + '.';
  }
  const UPDATE_FIRST = 'The ticks changed. Update the preview to go on.';
  function step3Bar(v, gd) {
    const back = { label: 'Back', attrs: { 'data-action': 'setup-back', 'data-key': 'setup-back' } };
    if (v.previewLoading || !v.preview) return { text: v.previewLoading ? 'Checking what the switch would change.' : 'The preview did not run.', back: back, commit: { label: 'Next', disabled: true } };
    const blockers = blockersOf(v);
    if (blockers.length) return { text: blockerText(blockers[0]), back: back, commit: { label: 'Next', disabled: true } };
    // The counts are for other ticks than the page shows: nothing goes on until the preview matches them.
    if (ticksChanged(v)) return { text: UPDATE_FIRST, back: back, commit: { label: 'Next', disabled: true } };
    return { text: barTextOf(v, gd), back: back, commit: { label: 'Next', attrs: { 'data-action': 'setup-preview-next', 'data-key': 'setup-preview-next' } } };
  }

  // ── step 4: Switch over (boards G4, G6 #3) ──
  function bindLine(v) {
    const total = bindingOf(v.preview).ids.length;
    if (!total) return '';
    const on = previewIds(v).length; // the selection the preview (and its token) is for
    return fact('Name matches', esc(on === total ? plural(total, 'character is', 'characters are') + ' matched to the roster by name' : on + ' of ' + plural(total, 'character is', 'characters are') + ' matched to the roster by name'));
  }
  function step4Html(v, gd) {
    if (!v.preview) return banner(v.error) + G.ui.loadingHtml({ label: 'Loading the preview', rows: 3 });
    const p = v.preview;
    const s = summaryOf(v, gd);
    const claim = p.needsClaim || {};
    const discord = p.permissions && p.permissions.discordRoles ? p.permissions.discordRoles : { count: 0 };
    const o = p.owner || {};
    const ownerLine = o.exists === false ? 'Nobody yet' : esc(ownerName(v, gd) + (o.live && o.via ? ', live through ' + o.via.characterName : ', would be suspended'));
    const facts = fact('Members', esc(plural(s.after, 'account is a member', 'accounts are members') + ' after the switch: ' + movesText(s))) +
      (num(claim.count) ? fact('Claims', esc(plural(num(claim.count), 'person waits', 'people wait') + ' for their player to claim them with This is me; the switch links nobody')) : '') +
      fact('Ranks', esc(plural(s.changed, 'character changes', 'characters change') + ' core rank, ' + trialText(s.trial))) +
      (num(discord.count) ? fact('Roles', esc(handSetText(num(discord.count), true) + '; Discord stops giving roles')) : '') +
      bindLine(v) + fact('Owner', ownerLine);
    return banner(v.error) + ownerPanelHtml(v, gd) + factPanel('What the switch does', facts);
  }
  function step4Bar(v, gd) {
    const back = { label: 'Back', attrs: { 'data-action': 'setup-back', 'data-key': 'setup-back' } };
    if (!v.preview) return { text: 'The preview did not run.', back: back, commit: { label: 'Switch over', disabled: true } };
    const blockers = blockersOf(v);
    if (blockers.length) return { text: blockerText(blockers[0]), back: back, commit: { label: 'Switch over', disabled: true } };
    if (ticksChanged(v)) return { text: UPDATE_FIRST, back: back, commit: { label: 'Switch over', disabled: true } };
    return { text: barTextOf(v, gd), back: back, commit: { label: 'Switch over', attrs: { 'data-action': 'setup-switch', 'data-key': 'setup-switch' } } };
  }

  function switchDialogHtml(v, gd, o) {
    const x = o || {};
    const s = summaryOf(v, gd);
    const body = '<div class="gs-hd-panel gs-su-joins"><h3 class="gs-fg-lbl">What changes</h3>' +
      kv('Members', esc(s.after + ' after the switch: ' + movesText(s))) + kv('Ranks', esc(plural(s.changed, 'character changes', 'characters change') + ' core rank')) +
      (v.preview && v.preview.permissions && num(v.preview.permissions.discordRoles && v.preview.permissions.discordRoles.count) ? kv('Roles', esc(handSetText(num(v.preview.permissions.discordRoles.count)))) : '') +
      kv('Owner', esc(ownerName(v, gd))) + '</div>' + (x.error ? '<p class="gs-alert" role="alert">' + esc(x.error) + '</p>' : '');
    return G.ui.dialogHtml({
      kind: 'confirm', title: 'Switch ' + gd.guild.name + ' to its in-game guild?', text: 'From now on the guild roster decides who is a member and what rank they hold. You cannot switch back from the app.',
      bodyHtml: body, primary: { label: x.primaryLabel || 'Switch over' }, className: 'gs-forge', formAttrs: { 'data-submit': 'setup-switch-form' },
    });
  }

  // ── done (board G5) ──
  function doneHtml(v, gd) {
    const d = v.bnet;
    const a = v.result;
    const guild = gd.guild.name;
    const members = num(d && d.roster && d.roster.members);
    const rosterRow = fact('Roster', members ? esc(plural(members, 'member', 'members')) + (d.roster.fetchedAt ? sub('Last checked ' + G.ui.formatStamp(d.roster.fetchedAt, gd.guild.timeZone)) : '') : '<span class="gs-muted">Not read yet</span>');
    const actions = (G.shell.canSeeUsers(gd.me && gd.me.can) ? [{ label: 'Open Users', href: G.router.format({ name: 'users', gid: v.gid, segment: null }) }] : []).concat([{ label: 'Open the roster', href: G.router.format({ name: 'section', gid: v.gid, section: 'roster' }) }]);
    if (!a) {
      return G.ui.bannerHtml({ tone: 'success', title: guild + ' follows the in-game guild.', text: 'Members and ranks come from the guild roster.', actions: actions, dismissible: false, id: 'setup-result' }) +
        factPanel(guild + ' now', fact('Guild', esc(pinnedGuildName(d, gd, null) + ' on ' + realmLabel(d, gd))) + rosterRow);
    }
    const text = plural(num(a.membersAfter), 'account is a member', 'accounts are members') + ': ' + num(a.stay) + ' stayed, ' + num(a.gains) + ' gained access and ' + num(a.loses) + ' lost it. ' +
      plural(num(a.rankChanges), 'character changed', 'characters changed') + ' core rank, ' + num(a.becameTrial) + ' of them ' + (num(a.becameTrial) === 1 ? 'is' : 'are') + ' on Trial.';
    const o = a.owner || {};
    const facts = fact('Members', esc(plural(num(a.membersAfter), 'account', 'accounts') + ' after the switch')) +
      (num(a.needsClaim) ? fact('Claims', esc(plural(num(a.needsClaim), 'person waits', 'people wait') + ' for their player to claim them with This is me')) : '') +
      fact('Roles', esc(plural(num(a.discordRolesMadeManual), 'role from Discord is', 'roles from Discord are') + ' now hand-set, ' + plural(num(a.newPermissions), 'new permission', 'new permissions') + ' from ranks')) +
      (num(a.boundByName) ? fact('Name matches', esc(plural(num(a.boundByName), 'character is', 'characters are') + ' matched to the roster by name')) : '') +
      fact('Owner', esc(ownerName(null, gd)) + (o.live === false ? ' ' + chip('rose', 'Suspended') : '')) + rosterRow;
    return G.ui.bannerHtml({ tone: 'success', title: guild + ' now follows the in-game guild.', text: text, actions: actions, dismissible: false, id: 'setup-result' }) + factPanel(guild + ' now', facts);
  }

  // ── the page ──
  function headOf(v, gd) {
    const done = v.step > STEPS.length;
    return {
      title: 'Guild setup', context: done ? gd.guild.name + ' follows its in-game guild.' : gd.guild.name + ' follows its in-game guild once you switch over: members and ranks come from the guild roster.',
      back: { href: bnetHref(gd.guild.id), label: 'Battle.net' },
    };
  }
  function bodyOf(v, gd) {
    if (v.step > STEPS.length) return { body: doneHtml(v, gd), bar: null };
    if (pinInfo(v.bnet).state === 'manual') {
      return { body: banner({ tone: 'info', title: 'Members and ranks are set by hand in this guild.', text: 'Only a guild that follows Discord roles can be switched to its in-game guild here.' }) + readOnlyFacts(v, gd), bar: null };
    }
    if (!v.owner) return { body: step1Html(v, gd), bar: null };
    if (v.step === 1) return { body: step1Html(v, gd), bar: step1Bar(v, gd) };
    if (v.step === 2) return { body: step2Html(v), bar: step2Bar(v) };
    if (v.step === 3) return { body: step3Html(v, gd), bar: step3Bar(v, gd) };
    return { body: step4Html(v, gd), bar: step4Bar(v, gd) };
  }

  // opts: { guildData, route, view (tests pass their own) }
  function setupHtml(opts) {
    const gd = opts.guildData;
    const v = opts.view || view;
    if (!v || v.loading || v.gid !== gd.guild.id) {
      // Reading the guild's link: the page's own head and steps stay, the body is the skeleton.
      return G.ui.flowPageHtml({ pageClass: 'gs-setup-page gs-forge', head: { title: 'Guild setup', context: gd.guild.name, back: { href: bnetHref(gd.guild.id), label: 'Battle.net' } }, steps: STEPS, current: 1, stepsLabel: 'Guild setup steps', bodyHtml: G.ui.loadingHtml({ label: 'Loading the setup', rows: 3 }) });
    }
    v.gd = gd;
    const parts = bodyOf(v, gd);
    return G.ui.flowPageHtml({
      pageClass: 'gs-setup-page gs-forge', head: headOf(v, gd), steps: STEPS, current: v.step, stepsLabel: 'Guild setup steps',
      bodyHtml: parts.body, commitBarHtml: parts.bar ? G.ui.commitBarHtml(Object.assign({ note: '' }, parts.bar)) : '',
    });
  }

  // ── behaviour ──
  function cur() { return view && view.owner && !view.loading ? view : null; }

  G.handlers.input['setup-pin-name'] = function (el) { const v = cur(); if (v) v.pinName = el.value; };
  G.handlers.input['setup-pin-realm'] = function (el) { const v = cur(); if (v) v.pinRealm = el.value; };

  // Step 1: the sign-in carries the name; the act `pin` posts it on the way back.
  G.handlers.click['setup-pin'] = function () {
    const v = cur();
    if (!v || v.busy || pinInfo(v.bnet).complete) return;
    const name = String(v.pinName || '').replace(/\s+/g, ' ').trim();
    const realm = v.bnet.realmKind === 'ruleset' ? String(v.pinRealm || '').trim() : String(v.bnet.realmSlug || '');
    v.fieldError = {}; v.error = null;
    if (!name) v.fieldError.name = 'Type the guild\'s name as it is spelled in game.';
    if (!realm) v.fieldError.realm = 'Type the realm the guild lives on.';
    if (v.fieldError.name || v.fieldError.realm) { render(); return; }
    const linked = G.fresh.linkedOf(st().me);
    if (linked && !linked.bnet) { v.error = refusalOf({ code: 'identity_not_linked' }); render(); return; }
    v.busy = true;
    render();
    G.fresh.start({
      gid: v.gid, purpose: 'pin', provider: 'bnet', params: { guildName: name, realmSlug: realm }, act: { kind: 'pin', data: { guildName: name, realmSlug: realm } }, returnTo: setupHref(v.gid),
    }).then(null, function (err) { if (view === v) fail(v, err); });
  };

  G.handlers.click['setup-pin-next'] = function () {
    const v = cur();
    if (!v || v.busy || !pinInfo(v.bnet).complete || num(v.bnet.roster && v.bnet.roster.members) === 0) return;
    v.busy = true; v.error = null;
    render();
    ensureMap(v).then(function () { if (view !== v) return; v.busy = false; go(v, 2); }, function (err) { if (view === v) fail(v, err); });
  };

  // Read the roster again (the Guild Master's Sync now) when the first read did not give one.
  G.handlers.click['setup-sync'] = function () {
    const v = cur();
    if (!v || v.busy) return;
    v.busy = true; v.syncError = '';
    render();
    G.api.post(path(v.gid, '/roster-sync'), {}).then(function () {
      return G.api.get(path(v.gid, '/bnet'));
    }).then(function (d) {
      if (view !== v) return;
      v.busy = false; v.bnet = d; v.syncError = num(d.roster && d.roster.members) ? '' : 'Battle.net did not give it just now.';
      if (v.pinResult) v.banner = pinBanner(v);
      render();
    }, function (err) {
      if (view !== v) return;
      v.busy = false;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      v.syncError = G.api.classify(err).text;
      if (v.pinResult) v.banner = pinBanner(v);
      render();
    });
  };

  G.handlers.click['setup-back'] = function () {
    const v = cur();
    if (!v || v.busy || v.step <= 1) return;
    go(v, v.step - 1);
  };

  // Step 2: the table.
  function rowOf(el) {
    const v = cur();
    const rank = Number(el && el.getAttribute ? el.getAttribute('data-rank') : NaN);
    return v ? v.rows.filter(function (r) { return r.rank === rank; })[0] || null : null;
  }
  G.handlers.input['setup-rank-label'] = function (el) { const r = rowOf(el); if (r) r.label = el.value; };
  G.handlers.change['setup-rank-core'] = function (el) { const r = rowOf(el); if (!r) return; r.core = el.value; render(); };
  G.handlers.change['setup-rank-role'] = function (el) { const r = rowOf(el); if (!r) return; r.role = el.value; render(); };

  G.handlers.click['setup-ranks-next'] = function () {
    const v = cur();
    if (!v || v.busy || !v.map || gapsOf(v.rows).length) return;
    const body = mapBody(v.rows, v.bnet && v.bnet.rankDefaults);
    if (sameAsStored(v.map, body)) { enterPreview(v); return; }
    v.busy = true; v.error = null;
    render();
    // The dry run is the Worker's own check; its token goes straight into the PUT (the Owner reads the effect of the map on the Preview step).
    G.api.post(path(v.gid, '/rank-map/dry-run'), { ranks: body }).then(function (dry) {
      return G.api.put(path(v.gid, '/rank-map'), { ranks: body, token: dry.token });
    }).then(function (map) {
      if (view !== v) return;
      v.busy = false; v.map = map; v.rows = rowsOf(map);
      enterPreview(v);
    }, function (err) {
      if (view !== v) return;
      v.busy = false;
      if (staleCode(err && err.code)) { v.error = { tone: 'warning', title: 'The guild changed while the map was being saved.', text: 'Nothing was saved. Press Next to check it again.', actions: [] }; render(); return; }
      fail(v, err);
    });
  };

  // Step 3.
  G.handlers.click['setup-preview-again'] = function () { const v = cur(); if (v && !v.previewLoading) enterPreview(v); };
  G.handlers.click['setup-preview-next'] = function () {
    const v = cur();
    if (!v || !v.preview || blockersOf(v).length || v.updating || ticksChanged(v)) return;
    go(v, 4);
  };
  // The ticks changed: run the dry run again for exactly them (the counts of the page are for the old ticks until it answers).
  G.handlers.click['setup-preview-update'] = function () {
    const v = cur();
    if (!v || !v.preview || v.previewLoading || v.updating || !ticksChanged(v)) return;
    runPreview(v, confirmedIds(v), true);
  };
  G.handlers.click['setup-show-all'] = function (el) {
    const v = cur();
    const key = el && el.getAttribute ? el.getAttribute('data-group') : null;
    if (!v || !key) return;
    v.expanded[key] = true;
    render();
  };
  G.handlers.change['setup-bind'] = function (el) {
    const v = cur();
    const id = el && el.getAttribute ? el.getAttribute('data-id') : null;
    if (!v || !id) return;
    if (id === '*rest*') v.restTicked = !!el.checked;
    else if (el.checked) delete v.unticked[id]; else v.unticked[id] = true;
    render();
  };

  // Step 4: the confirm. Its step 2 is the Battle.net sign-in (Guild.fresh); the act `source_switch` repeats the flip when the person comes back.
  G.handlers.click['setup-switch'] = function () {
    const v = cur();
    if (!v || !v.preview || blockersOf(v).length || v.updating || ticksChanged(v)) return;
    v.dialogStale = false;
    G.ui.openDialog(switchDialogHtml(v, v.gd), { labelledBy: 'dlg-title' });
  };

  function previewAgain(v, form) {
    G.ui.closeDialogOf(form);
    enterPreview(v);
  }

  G.handlers.submit['setup-switch-form'] = function (form) {
    const v = cur();
    if (!v || !v.preview) return;
    if (v.dialogStale) { previewAgain(v, form); return; }
    const dlg = form && form.closest ? form.closest('dialog') : null;
    const showStale = function () {
      v.dialogStale = true;
      if (dlg) G.ui.replaceDialogBody(dlg, switchDialogHtml(v, v.gd, { error: OUT_OF_DATE, primaryLabel: 'Run the preview again' }));
      return new Promise(function () { /* the dialog took over */ });
    };
    if (nowMs() - v.previewAt >= PREVIEW_TTL_MS) { showStale(); return; }
    // The ids the token was minted for (the Worker refuses any other selection).
    const body = { token: v.preview.token, confirmedCharacterIds: previewIds(v).slice() };
    const request = G.api.post(path(v.gid, '/flip'), body).then(null, function (err) {
      if (err && staleCode(err.code)) return showStale();
      if (err && err.code === 'already_ingame') {
        G.ui.closeDialogOf(form);
        markSwitched(v, null);
        return new Promise(function () { /* the page moved on */ });
      }
      if (G.fresh.isRequired(err) || G.api.classify(err).view !== 'inline') throw err;
      // Every other refusal reads as one sentence in the dialog.
      throw new G.api.ApiError(err.status, { error: err.code, message: refusalLine(err, { rows: v.rows }) });
    });
    G.fresh.runDialog(form, request, {
      gid: v.gid, act: { kind: FLIP_PURPOSE, data: { token: body.token, tokenAt: v.previewAt, confirmedCharacterIds: body.confirmedCharacterIds } }, returnTo: setupHref(v.gid),
      stepLabel: 'Switch over - step 2 of 2', primaryLabel: 'Sign in with Battle.net', text: SIGN_IN_TEXT,
    }, function (res) { markSwitched(v, res && res.applied ? res.applied : null); });
  };

  // ── the acts the sign-in repeats (Guild.fresh.registerAct; run by #/fresh?done=<purpose>) ──
  // Each answers the address of this page. A refusal that is not the sign-in's own is kept for the page (a banner), so the person lands on the step it belongs to.
  function giveUp(err) { return G.fresh.isRequired(err) || G.api.classify(err).view !== 'inline'; }

  G.fresh.registerAct('pin', function (pending) {
    const data = pending.data || {};
    const gid = pending.gid;
    if (!gid) return Promise.resolve(null);
    return G.api.post(path(gid, '/bnet/pin'), { guildName: data.guildName, realmSlug: data.realmSlug }).then(function (res) {
      handoff = { gid: gid, pin: res };
      return setupHref(gid);
    }, function (err) {
      if (giveUp(err)) throw err;
      const banner = refusalOf(err, { guildName: data.guildName });
      handoff = { gid: gid, banner: banner };
      return setupHref(gid);
    });
  });

  G.fresh.registerAct(FLIP_PURPOSE, function (pending) {
    const data = pending.data || {};
    const gid = pending.gid;
    if (!gid || typeof data.token !== 'string') return Promise.resolve(null);
    const staleNote = { tone: 'warning', title: 'This preview is out of date.', text: 'The guild changed since you ran it. This is the preview as it is now.' };
    const ticks = list(data.confirmedCharacterIds); // the preview that runs again keeps the ticks
    if (nowMs() - num(data.tokenAt) >= PREVIEW_TTL_MS) { handoff = { gid: gid, rerun: true, ids: ticks, banner: staleNote }; return Promise.resolve(setupHref(gid)); }
    return G.api.post(path(gid, '/flip'), { token: data.token, confirmedCharacterIds: ticks }).then(function (res) {
      handoff = { gid: gid, flip: res && res.applied ? res.applied : null, switched: true };
      return setupHref(gid);
    }, function (err) {
      if (giveUp(err)) throw err;
      if (err && err.code === 'already_ingame') { handoff = { gid: gid, switched: true }; return setupHref(gid); }
      handoff = { gid: gid, rerun: true, ids: ticks, banner: staleCode(err && err.code) ? staleNote : refusalOf(err) };
      return setupHref(gid);
    });
  });

  G.pages.setup = {
    STEPS: STEPS, PREVIEW_TTL_MS: PREVIEW_TTL_MS, REFUSAL_CODES: Object.keys(REFUSALS),
    load: load,
    main: function (r, gd) { return setupHtml({ guildData: gd, route: r }); },
    setupHtml: setupHtml,
    switchDialogHtml: switchDialogHtml,
    refusalOf: refusalOf, refusalLine: refusalLine, rowsOf: rowsOf, mapBody: mapBody, gapsOf: gapsOf, confirmedIds: confirmedIds, bindingOf: bindingOf,
    pinnedGuildName: pinnedGuildName, realmLabel: realmLabel, pinInfo: pinInfo,
    view: function () { return view; }, reset: function () { view = null; handoff = null; },
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
