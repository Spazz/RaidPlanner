// ── PAGE PIECE: THE PUBLISHED LINE-UP OF A RAID ─────────────────
// GET /raids/:rid/roster (the route keeps its name; the words on screen are "line-up", glossary D1). Officers (raids.edit), once the raid has a plan, publish it as
// the line-up (POST), publish it again when the plan changed, or unpublish it (DELETE), and see who confirmed. A member with a group sees it in the raid page's You bar
// (pages-raid-you.js) and a chip on the Raids list, with Confirm and Can't come (POST .../roster/confirm and .../roster/decline; the decline asks first and turns the sign-up into an Absence). The data loads itself after
// the raid page is drawn (afterRender), so the raid page reads exactly what it did before; pages-raid.js draws the pieces and drops this copy when the raid changes.
(function (G) {
  'use strict';

  const STATUS_LABELS = { pending: 'Waiting', confirmed: 'Confirmed', declined: 'Can\'t come' };
  const STATUS_PILLS = { pending: 'info', confirmed: 'ok', declined: 'warn' };
  const PUBLISH_TEXT = 'Members will see their group and can confirm or say they can\'t come.';
  const REPUBLISH_TEXT = 'Members keep the answer they gave for a group that did not change. Everyone else is asked again.';
  const TELL_DISCORD = 'The team\'s Discord channel also gets a post with the line-up.';
  const TELL_NO_DISCORD = 'Nothing is posted to Discord: the team has no channel post for line-ups switched on.';
  const UNPUBLISH_TEXT = 'Members stop seeing their group, and the answers given so far are dropped.';
  const DECLINE_TEXT = 'Your sign-up for this raid becomes Can\'t come. You can change your mind until the raid starts.';

  function A() { return G.pages.attendance; }
  function a() { return A().attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function pill(status) { return '<span class="gs-pill gs-pill-' + (STATUS_PILLS[status] || 'muted') + '">' + esc(STATUS_LABELS[status] || status) + '</span>'; }

  // ── a member's group ──
  // "Holy Paladin (Gorrim)": spec and class, then the character. Parts that are missing are left out.
  function seatWho(m) {
    const role = [m.spec, m.class ? G.ui.className(m.class) : ''].filter(Boolean).join(' ');
    return (role ? role + ' ' : '') + (m.name ? '(' + m.name + ')' : '');
  }

  // "You're in Group 3 as Holy Paladin (Gorrim)" / "You're on the bench".
  function seatText(m) {
    if (!m.group) return 'You\'re on the bench';
    const who = seatWho(m).trim();
    return 'You\'re in Group ' + m.group + (who ? ' as ' + who : '');
  }

  // ── the officers' card ──
  function groupsOf(entries) {
    const by = {};
    entries.forEach(function (e) { const g = Number(e.group) || 0; (by[g] = by[g] || []).push(e); });
    return Object.keys(by).map(Number).sort(function (x, y) { return (x === 0 ? 99 : x) - (y === 0 ? 99 : y); }).map(function (g) { return { group: g, entries: by[g] }; });
  }

  // A row of the Line-up panel: spec icon, class-coloured name, muted spec; a chip only for an answer that is not the default (Confirmed shows nothing).
  function entryHtml(e, myPersonId) {
    const status = e.status === 'confirmed' || e.status === 'declined' ? e.status : 'pending';
    const chip = e.guest ? '<span class="gs-hd-chip is-grey">Guest</span>' : status === 'pending' ? '<span class="gs-hd-chip is-grey">Waiting</span>' : status === 'declined' ? '<span class="gs-hd-chip is-rose">Can\'t come</span>' : '';
    const me = !!(myPersonId && e.personId && e.personId === myPersonId);
    return '<li class="gs-rb-row' + (me ? ' is-you' : '') + '">' + G.ui.specIconHtml(e.class, e.spec, 20) + '<span class="gs-rb-id"><span class="gs-rb-nm">' + G.ui.classNameHtml(e.name, e.class) + '</span>' +
      (e.spec ? '<span class="gs-rb-sp">' + esc(e.spec) + '</span>' : '') + '</span>' + (chip ? '<span class="gs-rb-chips">' + chip + '</span>' : '') + (me ? '<span class="gs-you">You</span>' : '') + '</li>';
  }

  function countsText(c) {
    const x = c || {};
    return (x.confirmed || 0) + ' confirmed, ' + (x.pending || 0) + ' waiting' + (x.declined ? ', ' + x.declined + ' can\'t come' : '') + (x.guests ? ', ' + x.guests + ' guests' : '');
  }

  // Whether the line-up can be published now (the raid page's More menu offers it too): an officer, a raid that has not started, a plan, nothing published yet.
  function canPublish(data, state) {
    if (!data || !data.can || !data.can.edit || !state || state.status !== 'ok' || !state.data || state.data.published) return false;
    return !!(data.raid && data.raid.upcoming && data.sources && data.sources.plan);
  }

  function groupColumnHtml(g, myPersonId) {
    const title = g.group ? 'Group ' + g.group : 'Bench';
    const key = function (e) { return String(e.name || '').toLowerCase(); };
    return '<section class="gs-rb-col" aria-label="' + esc(title) + '"><h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(title) + '</span><span class="gs-fg-ghn">' + g.entries.length + '</span></h3><ul class="gs-rb-list">' +
      g.entries.slice().sort(function (x, y) { return key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0; }).map(function (e) { return entryHtml(e, myPersonId); }).join('') + '</ul></section>';
  }

  // opts: { guildData, data (the raid detail), state, myPersonId (the viewer's person, to tint their row) }. Hidden without raids.edit; before a plan exists nothing to publish; after the start the list only.
  function cardHtml(opts) {
    const gd = opts.guildData;
    const s = opts.state;
    const data = opts.data;
    if (!data.can || !data.can.edit || !s) return '';
    const upcoming = !!(data.raid && data.raid.upcoming);
    const panel = function (headHtml, body) {
      return '<section class="gs-hd-panel gs-rb gs-ro" aria-labelledby="ro-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="ro-h">Line-up</h2>' + headHtml + '</div><div class="gs-rb-pb">' + body + '</div></section>';
    };
    if (s.status === 'error') {
      return upcoming ? panel('', '<p class="gs-alert" role="alert">' + esc(s.message || 'Could not load the line-up.') + '</p><div class="gs-row-actions"><button type="button" class="gs-btn" data-action="ro-retry" data-key="ro-retry">Try again</button></div>') : '';
    }
    if (s.status !== 'ok' || !s.data) return '';
    const d = s.data;
    const err = '<p class="gs-alert" id="ro-error" role="alert"' + (s.error ? '' : ' hidden') + '>' + esc(s.error || '') + '</p>';
    if (!d.published) {
      if (!upcoming || !(data.sources && data.sources.plan)) return '';
      return panel('', '<p class="gs-fine">Publish the plan as the line-up. ' + esc(PUBLISH_TEXT) + '</p>' +
        '<div class="gs-row-actions"><button type="button" class="gs-btn" data-action="roster-publish" data-op="publish" data-key="ro-publish">Publish line-up</button></div>' + err);
    }
    const entries = Array.isArray(d.entries) ? d.entries : [];
    const when = d.publishedAt && G.pages.raids.momentText ? G.pages.raids.momentText(d.publishedAt, gd) : '';
    const by = d.publishedBy ? (typeof d.publishedBy === 'object' ? d.publishedBy.displayName || d.publishedBy.name : d.publishedBy) : '';
    const meta = '<span class="gs-rb-mut">Published' + (when ? ' ' + esc(when) : '') + (by ? ' by ' + esc(by) : '') + '</span><span class="gs-rb-mut" id="ro-counts">' + esc(countsText(d.counts)) + '</span>';
    const actions = upcoming
      ? '<span class="gs-rb-acts"><button type="button" class="gs-btn" data-action="roster-publish" data-op="republish" data-key="ro-republish">Re-publish line-up</button>' +
        '<button type="button" class="gs-btn" data-action="roster-publish" data-op="unpublish" data-key="ro-unpublish">Unpublish</button></span>'
      : '';
    const changed = d.planChanged && upcoming
      ? '<div class="gs-notice" role="status"><span>The plan changed since you published.</span><button type="button" class="gs-btn" data-action="roster-publish" data-op="republish" data-key="ro-changed">Re-publish</button></div>'
      : '';
    const groups = groupsOf(entries).map(function (g) { return groupColumnHtml(g, opts.myPersonId); }).join('');
    return panel(meta + actions, changed + (groups ? '<div class="gs-rb-cols gs-rb-cols3">' + groups + '</div>' : '<p class="gs-empty">No one is in the line-up.</p>') + err);
  }

  // ── data ──
  function load(gid, rid, forRaid) {
    const s = a().raidRoster = { gid: gid, rid: rid, status: 'loading', data: null, busy: false, error: '', message: '', forRaid: forRaid || null };
    return G.api.raidRoster.get(gid, rid).then(function (data) {
      if (a().raidRoster !== s) return null;
      s.status = 'ok';
      s.data = data;
      G.app.render();
      return null;
    }, function (err) {
      if (a().raidRoster !== s) return null;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return null; }
      s.status = err && (err.status === 403 || err.status === 404) ? 'denied' : 'error';
      s.message = cl.text;
      G.app.render();
      return null;
    });
  }

  // The state of the open raid's line-up, or null while it is not read for that raid.
  function stateFor(gid, rid) {
    const s = a().raidRoster;
    return s && s.gid === gid && s.rid === rid ? s : null;
  }

  // The raid changed (a plan, an event or the results): the line-up is read again after the next draw, the old copy stays until then.
  function invalidate() {
    const s = a().raidRoster;
    if (s) s.forRaid = null;
  }

  // Called by the app after each render of a guild page: the raid page reads the line-up once per raid detail. Officers always (a started raid shows the list); members
  // only before the start.
  function afterRender(r) {
    const gd = currentGd();
    if (!gd || !r || r.name !== 'raid') return;
    const x = a().raid;
    if (!x || x.gid !== gd.guild.id || x.rid !== r.rid || !x.data || !x.data.raid) return;
    const edit = !!(x.data.can && x.data.can.edit);
    if (!edit && !x.data.raid.upcoming) return;
    const s = a().raidRoster;
    if (s && s.forRaid === x && s.rid === r.rid && s.gid === gd.guild.id) return;
    load(gd.guild.id, r.rid, x);
  }

  function cur() {
    const s = a().raidRoster;
    const gd = currentGd();
    const x = a().raid;
    return s && gd && x && s.gid === gd.guild.id && s.rid === x.rid && s.status === 'ok' ? { s: s, gd: gd, gid: gd.guild.id, rid: x.rid, x: x } : null;
  }

  G.handlers.click['ro-retry'] = function () {
    const c = a().raidRoster;
    const gd = currentGd();
    if (!c || !gd) return;
    load(gd.guild.id, c.rid, c.forRaid);
    G.app.render();
  };

  // ── officers: publish, re-publish, unpublish (each asks first) ──
  // Publishing says who hears about it: members see the line-up on their raid page, and the team's Discord channel is posted to when its webhook has line-up posts on
  // (the Worker tells the officer's reply: discordPost). Unpublishing posts nothing.
  function tellText(discordPost) { return 'Who is told: members, on their raid page. ' + (discordPost ? TELL_DISCORD : TELL_NO_DISCORD); }

  function confirmDialogHtml(op, discordPost) {
    const base = op === 'unpublish' ? UNPUBLISH_TEXT : op === 'republish' ? REPUBLISH_TEXT : PUBLISH_TEXT;
    const text = op === 'unpublish' ? base : base + ' ' + tellText(discordPost);
    const title = op === 'unpublish' ? 'Unpublish the line-up?' : op === 'republish' ? 'Publish the line-up again?' : 'Publish the line-up?';
    const button = op === 'unpublish' ? 'Unpublish line-up' : op === 'republish' ? 'Re-publish line-up' : 'Publish line-up';
    return '<form class="gs-dialog-form" data-submit="roster-confirm-form" data-op="' + esc(op) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + esc(title) + '</h2><p class="gs-confirm-text" id="dlg-text">' + esc(text) + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn ' + (op === 'unpublish' ? 'gs-btn-danger' : 'gs-btn-molten') + '">' + esc(button) + '</button></div></form>';
  }

  G.handlers.click['roster-publish'] = function (el) {
    const c = cur();
    if (!c) return;
    const op = el.getAttribute('data-op');
    G.ui.openDialog(confirmDialogHtml(op === 'unpublish' || op === 'republish' ? op : 'publish', !!(c.s.data && c.s.data.discordPost)), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['roster-confirm-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const op = form.getAttribute('data-op');
    const call = op === 'unpublish' ? G.api.raidRoster.unpublish(c.gid, c.rid) : G.api.raidRoster.publish(c.gid, c.rid);
    return G.ui.runDialog(form, call, function (res) {
      c.s.data = res && typeof res === 'object' && 'published' in res ? res : { published: false };
      c.s.error = '';
      G.app.render();
    });
  };

  // ── members: confirm or say they can't come ──
  // After either answer the sign-up changed (a decline makes it Absent, a confirm after it brings the old one back): the Sign-ups panel is read again.
  function afterAnswer(c, res) {
    c.s.busy = false;
    c.s.error = '';
    if (res && typeof res === 'object') c.s.data = res;
    G.app.render();
    if (G.pages.raidSignups && c.x.data) G.pages.raidSignups.loadFor(c.gd, c.x.data).then(function () { G.app.render(); }, function () { /* the panel keeps what it had */ });
  }

  function answerFailed(c, err) {
    c.s.busy = false;
    const cl = G.api.classify(err);
    if (cl.view === 'signin') { G.app.requireSignin(); return; }
    if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
    c.s.error = cl.text;
    G.app.render();
  }

  G.handlers.click['seat-confirm'] = function () {
    const c = cur();
    if (!c || c.s.busy) return;
    c.s.busy = true;
    c.s.error = '';
    G.app.render();
    return G.api.raidRoster.confirm(c.gid, c.rid).then(function (res) { afterAnswer(c, res); }, function (err) { answerFailed(c, err); });
  };

  function declineDialogHtml(from, rid) {
    return '<form class="gs-dialog-form" data-submit="roster-decline-form" data-from="' + (from === 'home' ? from : 'page') + '" data-rid="' + esc(rid) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Tell the officers you can\'t come?</h2><p class="gs-confirm-text" id="dlg-text">' + esc(DECLINE_TEXT) + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Can\'t come</button></div></form>';
  }

  G.handlers.click['seat-decline'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(declineDialogHtml('page', c.rid), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['roster-decline-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const rid = form.getAttribute('data-rid');
    if (form.getAttribute('data-from') === 'home') {
      return G.ui.runDialog(form, G.api.raidRoster.decline(gid, rid), function () { return G.pages.homeMember.afterDecline(); });
    }
    const c = cur();
    if (!c) return;
    return G.ui.runDialog(form, G.api.raidRoster.decline(c.gid, c.rid), function (res) { afterAnswer(c, res); });
  };

  G.pages.raidRoster = {
    STATUS_LABELS: STATUS_LABELS,
    seatText: seatText,
    cardHtml: cardHtml,
    canPublish: canPublish,
    countsText: countsText,
    confirmDialogHtml: confirmDialogHtml,
    declineDialogHtml: declineDialogHtml,
    stateFor: stateFor,
    invalidate: invalidate,
    afterRender: afterRender,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
