// ── PAGE: GUILD SETTINGS > OWNER REVIEW (lane B8a-owner, board O5; template T3) ──
// The new Owner's page after a Guild Master claim: what the previous Owner set up and left live. The tab is shown only to the Owner while GET /api/guild/:gid says owner.reviewOpen
// (shell.js settingsTabs); the Home item claim_review links here. Reads GET /api/guild/:gid/claim-review (worker/routes/claim-review.js, Owner only):
//   claim      who took the seat, from whom, when, whether the public page was switched off
//   roles      every stored role assignment (who, role, team, how, set by, set on)
//   rankMap    the permission each in-game rank gives (the schema records who set the map and when nowhere, so none is drawn)
//   handLinks  people linked to an account by hand and characters an officer or a hand added (no maker or date either)
//   bearer     how many API keys, guest links, raid join links and webhooks are live; they belong to the guild and a claim never turns them off
// One primary, "Mark as reviewed": it dismisses the Home item (POST /attention/dismissals { itemId: 'claim_review' }), which closes this page too; Home's Hidden list restores it.
(function (G) {
  'use strict';

  const TABLES = { roles: 'claimreview-roles', ranks: 'claimreview-ranks', hand: 'claimreview-hand' };
  const CORE_RANKS = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' };
  const LIST_CAP = 300; // worker/routes/claim-review.js: the lists hold at most this many rows each

  // The page's state: { gid, status: 'ready' | 'error', data, error, forbidden, busy, failure }.
  let view = null;

  function st() { return G.app.state; }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function plural(n, one, many) { return G.ui.plural(n, one, many); }
  function nameOf(ref, fallback) { return ref && typeof ref.name === 'string' && ref.name ? ref.name : fallback; }
  function routeHref(gid, route) { return G.router.format(Object.assign({ gid: gid }, route)); }

  // "Oct 29" in the guild's zone (with the year when it is not this year).
  function dateOf(ms, zone) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const day = G.ui.dayInZone(ms, zone);
    if (!day) return '';
    const withYear = G.ui.dateTimeInZone(ms, zone, { year: 'auto', noZone: true });
    const year = /,\s*(\d{4}),/.exec(withYear || '');
    return day.replace(/^\S+\s+/, '') + (year ? ', ' + year[1] : '');
  }

  // ── the claim summary ──
  function summaryHtml(claim, gd) {
    if (!claim) return '';
    const previous = nameOf(claim.previousOwner, '');
    const held = previous ? previous + ' held it before' + (claim.previousWasSuspended ? ' and was suspended' : '') + '.' : 'The seat was vacant before.';
    const stays = 'Everything ' + (previous ? previous + ' set up' : 'that was set up before') + ' stays live until you change it.';
    const text = [held, stays, claim.publicUnpublished ? 'The public page was switched off.' : ''].filter(Boolean).join(' ');
    const when = dateOf(claim.at, gd.guild.timeZone);
    return G.ui.bannerHtml({
      tone: 'info', dismissible: false, id: 'claimreview-summary', title: nameOf(claim.by, 'The Guild Master') + ' took the Owner seat' + (when ? ' on ' + when : '') + '.', text: text,
      actions: claim.publicUnpublished ? [{ label: 'Open Public page', href: routeHref(gd.guild.id, { name: 'settings', tab: 'public' }) }] : [],
    });
  }

  // ── tables (every head sorts: ui.sortThHtml / ui.sortItems) ──
  // cols: [{ key, label }]; rows: [[html per column]] already in the order to show.
  function tableHtml(key, label, cols, rows) {
    const head = cols.map(function (c) { return G.ui.sortThHtml(key, c.key, c.label); }).join('');
    const body = rows.map(function (cells) {
      return '<tr>' + cells.map(function (html, i) {
        return i === 0 ? '<th scope="row" class="gs-cell-strong">' + html + '</th>' : '<td data-label="' + esc(cols[i].label) + '">' + html + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="gs-table-wrap gs-hd-panel"><table class="gs-table gs-table-stack gs-ow-grid" aria-label="' + esc(label) + '"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function sectionHtml(id, title, count, introHtml, bodyHtml, extraHtml) {
    return '<section class="gs-ow-sec" aria-labelledby="' + id + '"><div class="gs-ow-sechead"><h3 class="gs-fg-gh" id="' + id + '"><span class="gs-fg-ght">' + esc(title) + '</span>' +
      (count == null ? '' : '<span class="gs-fg-ghn">' + esc(String(count)) + '</span>') + '</h3>' + (extraHtml || '') + '</div>' +
      (introHtml ? '<p class="gs-fine">' + introHtml + '</p>' : '') + bodyHtml + '</section>';
  }

  function emptyHtml(text) { return G.ui.emptyStateHtml({ kind: 'good', text: text }); }
  function countOf(list, truncated) { return list.length + (truncated ? '+' : ''); }
  function mutedHtml(text) { return '<span class="gs-muted">' + esc(text) + '</span>'; }
  function howOf(role) { return role.source === 'discord' ? 'From Discord' : 'By hand'; }

  function rolesHtml(d, gd) {
    const gid = gd.guild.id;
    const zone = gd.guild.timeZone;
    const items = listOf(d.roles);
    const rows = G.ui.sortItems(TABLES.roles, items, {
      user: function (r) { return r.name; }, role: function (r) { return r.roleName; }, team: function (r) { return r.teamName || 'Whole guild'; },
      how: howOf, setby: function (r) { return r.assignedBy ? r.assignedBy.name : null; }, seton: function (r) { return r.assignedAt; },
    }).map(function (r) {
      return [esc(r.name || ''), esc(r.roleName || ''), r.teamName ? esc(r.teamName) : mutedHtml('Whole guild'), esc(howOf(r)),
        r.assignedBy && r.assignedBy.name ? esc(r.assignedBy.name) : mutedHtml('Not recorded'), esc(dateOf(r.assignedAt, zone))];
    });
    const cols = [{ key: 'user', label: 'User' }, { key: 'role', label: 'Role' }, { key: 'team', label: 'Team' }, { key: 'how', label: 'How' }, { key: 'setby', label: 'Set by' }, { key: 'seton', label: 'Set on' }];
    const intro = 'Hand-set and stored roles, oldest first. Change them on <a class="gs-ow-link" href="' + esc(routeHref(gid, { name: 'users', segment: null })) + '">Users</a>.';
    const note = d.rolesTruncated ? '<p class="gs-fine">Showing the first ' + LIST_CAP + '. The Activity log lists the rest.</p>' : '';
    return sectionHtml('claimreview-roles-h', 'Roles', countOf(items, d.rolesTruncated), intro, items.length ? tableHtml(TABLES.roles, 'Roles set by hand', cols, rows) + note : emptyHtml('No roles are set up.'));
  }

  function ranksHtml(d, gd) {
    const items = listOf(d.rankMap && d.rankMap.rows);
    const rows = G.ui.sortItems(TABLES.ranks, items, {
      rank: function (r) { return r.rank; }, name: function (r) { return r.label; }, core: function (r) { return r.coreRank ? (CORE_RANKS[r.coreRank] || r.coreRank) : null; },
      permission: function (r) { return r.roleName || 'None'; },
    }).map(function (r) {
      return ['Rank ' + esc(String(r.rank)), esc(r.label || ''), r.coreRank ? esc(CORE_RANKS[r.coreRank] || r.coreRank) : mutedHtml('Not mapped'), r.roleName ? esc(r.roleName) : mutedHtml('None')];
    });
    const cols = [{ key: 'rank', label: 'In-game rank' }, { key: 'name', label: 'Name on the site' }, { key: 'core', label: 'Core rank' }, { key: 'permission', label: 'Permission' }];
    const open = G.ui.buttonHtml({ label: 'Open Battle.net settings', size: 'sm', href: routeHref(gd.guild.id, { name: 'settings', tab: 'battlenet' }) });
    return sectionHtml('claimreview-ranks-h', 'Rank permissions', items.length, 'What each in-game rank gives. Rank changes are made on Battle.net settings.',
      items.length ? tableHtml(TABLES.ranks, 'Rank permissions', cols, rows) : emptyHtml('No in-game ranks are mapped.'), open);
  }

  // Hand links: the people an officer linked to an account, and the characters an officer or a hand added, in one list.
  function handLinkRows(d) {
    const links = d && d.handLinks ? d.handLinks : {};
    const persons = listOf(links.persons).map(function (p) {
      return { name: p.mainName || p.accountName || '', account: p.accountName || '', how: 'Linked by an officer', personId: p.personId, cls: '' };
    });
    const characters = listOf(links.characters).map(function (c) {
      return { name: c.name || '', account: '', how: c.proof === 'hand' ? 'Character added by hand' : 'Character added by an officer', personId: c.personId, cls: c.class || '' };
    });
    return persons.concat(characters);
  }

  function handHtml(d, gd) {
    const gid = gd.guild.id;
    const items = handLinkRows(d);
    const rows = G.ui.sortItems(TABLES.hand, items, {
      person: function (r) { return r.name; }, account: function (r) { return r.account || null; }, how: function (r) { return r.how; },
    }).map(function (r) {
      const shown = r.cls ? G.ui.classNameHtml(r.name, r.cls) : esc(r.name);
      const who = r.personId ? '<a class="gs-ow-link" href="' + esc(routeHref(gid, { name: 'person', pid: r.personId })) + '">' + shown + '</a>' : shown;
      return [who, r.account ? esc(r.account) : mutedHtml('-'), esc(r.how)];
    });
    const cols = [{ key: 'person', label: 'Person' }, { key: 'account', label: 'Linked account' }, { key: 'how', label: 'How' }];
    const truncated = !!(d.handLinks && d.handLinks.truncated);
    const note = truncated ? '<p class="gs-fine">Showing the first ' + LIST_CAP + ' of each. The Activity log lists the rest.</p>' : '';
    return sectionHtml('claimreview-hand-h', 'Hand links', countOf(items, truncated), 'People and characters tied together by hand, not by Battle.net.',
      items.length ? tableHtml(TABLES.hand, 'Hand links', cols, rows) + note : emptyHtml('Nothing is linked by hand.'));
  }

  // The links, keys and webhooks the guild has live: a claim never turns any of them off; the new Owner decides. The tab of the links page comes from the Worker (bearer.tab).
  function bearerHtml(d, gd) {
    const gid = gd.guild.id;
    const b = d.bearer && typeof d.bearer === 'object' ? d.bearer : {};
    const n = function (v) { const x = Number(v); return isFinite(x) && x > 0 ? Math.floor(x) : 0; };
    const keys = [[n(b.apiKeys), 'API key', 'API keys'], [n(b.guestLinks), 'guest link', 'guest links'], [n(b.joinLinks), 'raid join link', 'raid join links']]
      .filter(function (e) { return e[0] > 0; }).map(function (e) { return plural(e[0], e[1], e[2]); });
    const hooks = n(b.webhooks);
    const fact = function (label, value, button) {
      return '<div class="gs-ro-row gs-ow-fact"><div class="gs-ow-fact-main"><dt class="gs-ro-label">' + esc(label) + '</dt><dd class="gs-ro-value">' + esc(value) + '</dd></div>' + button + '</div>';
    };
    const body = '<div class="gs-hd-panel gs-ow-facts"><dl class="gs-ro-list">' +
      fact('Links and keys', keys.length ? keys.join(', ') : 'None are live', G.ui.buttonHtml({ label: 'Open Links and keys', href: routeHref(gid, { name: 'settings', tab: typeof b.tab === 'string' && b.tab ? b.tab : 'links' }) })) +
      fact('Team webhooks', hooks ? plural(hooks, 'webhook', 'webhooks') : 'None are live', G.ui.buttonHtml({ label: 'Open Notifications', href: routeHref(gid, { name: 'settings', tab: 'notifications' }) })) + '</dl></div>';
    return sectionHtml('claimreview-bearer-h', 'Links, keys and webhooks', null, '', body);
  }

  function doneHtml(busy, failure) {
    return '<div class="gs-ow-done">' + (failure ? G.ui.alertHtml(failure, 'claimreview-error') : '') +
      G.ui.buttonHtml({ label: 'Mark as reviewed', variant: 'primary', busy: !!busy, busyLabel: 'Marking as reviewed...', attrs: { 'data-action': 'claimreview-done', 'data-key': 'claimreview-done' } }) + '</div>';
  }

  // opts: { guildData, data (GET .../claim-review), busy, failure }
  function settingsHtml(opts) {
    const o = opts || {};
    const gd = o.guildData;
    const d = o.data;
    if (!d || !d.claim) return G.ui.emptyStateHtml({ kind: 'first', icon: 'check', title: 'Nothing to review', text: 'No Guild Master has taken the Owner seat in this guild.' });
    return '<div class="gs-ow-review">' + summaryHtml(d.claim, gd) + rolesHtml(d, gd) + ranksHtml(d, gd) + handHtml(d, gd) + bearerHtml(d, gd) + doneHtml(o.busy, o.failure) + '</div>';
  }

  // GET /api/guild/:gid/claim-review (Owner only); Home reads it too, for the previous Owner's name.
  function read(gid) { return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/claim-review'); }

  // The read. A failure is kept for main() to say (the page never throws into the router).
  function load(r) {
    const gid = r.gid;
    view = { gid: gid, status: 'ready', data: null, error: '', forbidden: false, busy: false, failure: '' };
    const mine = view;
    return read(gid).then(function (res) {
      mine.data = res;
    }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      mine.status = 'error';
      mine.forbidden = !!err && err.status === 403;
      mine.error = c.text;
    });
  }

  function main(r, gd, ctx) {
    if (!view || view.gid !== gd.guild.id) return G.shell.settingsFrameHtml(ctx, 'claimreview', G.ui.loadingHtml({ label: 'Loading the review', rows: 5 }));
    let body;
    if (view.status === 'error') {
      body = view.forbidden
        ? G.ui.emptyStateHtml({ kind: 'first', icon: 'check', title: 'Nothing to review', text: 'The Owner review is for the Owner of the guild.' })
        : G.ui.errorRegionHtml({ title: 'Could not load the Owner review', text: view.error, retry: { attrs: { 'data-action': 'claimreview-retry', 'data-key': 'claimreview-retry' } } });
    } else {
      body = settingsHtml({ guildData: gd, data: view.data, busy: view.busy, failure: view.failure });
    }
    return G.shell.settingsFrameHtml(ctx, 'claimreview', body);
  }

  G.handlers.click['claimreview-retry'] = function () {
    const gid = st().currentGid;
    if (!gid) return null;
    return load({ gid: gid }).then(function () { G.app.render(); });
  };

  // Mark as reviewed: the Home item is dismissed (the Worker keys it to this claim: a later claim brings it back), the Owner review tab closes with it and Home opens.
  G.handlers.click['claimreview-done'] = function () {
    const x = view;
    if (!x || x.busy) return null;
    const gid = x.gid;
    x.busy = true;
    x.failure = '';
    G.app.render();
    return G.api.attention.dismiss(gid, 'claim_review').then(function () {
      x.busy = false;
      const gd = st().guilds && st().guilds[gid];
      if (gd && gd.owner) gd.owner.reviewOpen = false;
      G.ui.toast('Marked as reviewed.');
      G.app.go(G.router.format({ name: 'section', gid: gid, section: 'home' }));
    }, function (err) {
      x.busy = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      x.failure = c.text;
      G.app.render();
      G.ui.focusByKey('claimreview-done', { preventScroll: true });
    });
  };

  G.pages.settingsClaimReview = {
    load: load,
    read: read,
    main: main,
    settingsHtml: settingsHtml,
    handLinkRows: handLinkRows,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
