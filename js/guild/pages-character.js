// ── PAGE: CHARACTER (T2 object page, OWNER ONLY; user-hierarchy build, lane B8b "character"; boards CH1-CH6) ─────────────────────────────────────────────
// #/characters/<character id>: one character of the viewer's own profile, reached from a card on My characters. GET /api/me/characters/:cid answers the whole page
// (worker/character-page.js; contract in tasks/open/b8b-character-contract.md); it is a 404 for everyone but the owner, and the page then says so.
//   Head: spec icon, the name in its class colour, ONE chip (Main or Alt), the context line "Class - Spec / Off - Realm - Level 70", then at most Request team (only while the Worker
//   says canRequestTeam; it opens the Request team dialog of pages-team-requests.js with THIS character first) and More with Remove from my profile (only while canRemove: never a
//   Main, never a Battle.net-proven character in an in-game guild). The desktop head has no back link (the breadcrumb "My characters > <name>" is the trail); a phone shows it.
//   Below: the Team panel (the team and the core rank on it, "No team", or the request waiting with Withdraw request), Loot (what this character won), Raids (the raids it was
//   in, with Bosses: bosses killed with it present out of the kills that night; none on a raid entered by hand), and Details (name, Main spec and Off spec with Change, Main or Alt,
//   realm, level, in-game rank, added). No attendance outcome or credit, no tiles and no sign-ups: those belong to the person.
//   Loot and Raids show 10 rows, then "Showing 10 of N" and Show all. The Raids heads sort (ui.sortItems, key 'character-raids'); the first draw is newest first.
(function (G) {
  'use strict';

  const SHOWN = 10;
  const RAIDS_KEY = 'character-raids';
  // Which lists show every row: reset when another character opens.
  let all = { cid: null, loot: false, raids: false };

  function st() { return G.app.state; }
  function url(cid) { return '/api/me/characters/' + encodeURIComponent(cid); }
  function cur() {
    const s = st();
    const c = s.character;
    const gd = c && c.data ? s.guilds[c.data.guild.id] : null;
    return c && gd ? { cid: c.cid, gid: c.data.guild.id, gd: gd, data: c.data } : null;
  }

  // GET the page; kept in app state as { cid, data }. The caller (app.js) draws the guild around it.
  function load(cid) {
    return G.api.get(url(cid)).then(function (data) {
      if (!st().character || st().character.cid !== cid) { all = { cid: cid, loot: false, raids: false }; G.ui.clearTableSort(RAIDS_KEY); }
      st().character = { cid: cid, data: data };
      return data;
    });
  }

  function nameFor(r) {
    const c = st().character;
    return c && r && c.cid === r.cid && c.data ? c.data.character.name : '';
  }

  // ── head ──
  function contextHtml(data) {
    const c = data.character;
    const parts = [G.ui.specLineHtml(c.class, c.mainSpec, c.offSpec)];
    if (c.realm) parts.push(esc(c.realm));
    if (c.level !== null && c.level !== undefined) parts.push('Level ' + esc(c.level));
    return parts.map(function (x) { return '<span>' + x + '</span>'; }).join('<span class="gs-sumsep" aria-hidden="true"></span>');
  }

  function headOpts(gd, data) {
    const c = data.character;
    const more = data.can.remove
      ? { id: 'character-more', key: 'character-more', items: [{ label: 'Remove from my profile', key: 'mi-character-remove', danger: true, data: { action: 'character-remove-open' } }] } : null;
    return {
      title: c.name, back: { href: G.router.format({ name: 'characters' }), label: 'My characters' }, iconHtml: G.ui.specIconHtml(c.class, c.mainSpec, 28), titleClass: G.ui.classClass(c.class),
      chipsHtml: '<span class="gs-hd-chip is-grey">' + (c.isMain ? 'Main' : 'Alt') + '</span>', contextHtml: contextHtml(data), more: more,
      actionHtml: data.can.requestTeam ? G.ui.buttonHtml({ label: 'Request team', ariaLabel: 'Request a team for ' + c.name, attrs: { 'data-action': 'character-request-open', 'data-key': 'character-request-open' } }) : '',
    };
  }

  // ── team ──
  function teamPanelHtml(data) {
    const c = data.character;
    let text;
    if (data.team) {
      text = '<span class="gs-ch-team-v">' + esc(data.team.name) + '</span><span class="gs-ch-team-sub">Core rank ' + esc(c.coreRankLabel) + '</span>';
    } else if (data.request) {
      text = '<span class="gs-ch-team-v">Requested ' + esc(data.request.team.name) + '</span><span class="gs-ch-team-sub">Asked ' + esc(G.ui.agoText(data.request.createdAt)) + '</span>';
    } else {
      text = '<span class="gs-ch-team-v is-none">No team</span>';
    }
    const withdraw = !data.team && data.request
      ? G.ui.buttonHtml({ label: 'Withdraw request', ariaLabel: 'Withdraw the request for ' + c.name, attrs: { 'data-action': 'character-request-withdraw', 'data-key': 'character-request-withdraw' } }) : '';
    return '<section class="gs-hd-panel gs-ch-team" aria-label="Team"><div class="gs-ch-team-t"><span class="gs-fg-lbl">Team</span>' + text + '</div>' + withdraw + '</section>';
  }

  // ── shared: a list that shows 10 rows and then "Showing 10 of N" + Show all ──
  function footHtml(shown, total, action) {
    if (total <= shown) return '';
    return '<p class="gs-fine gs-ch-pfoot">Showing ' + shown + ' of ' + total + ' <button type="button" class="gs-linkbtn" data-action="' + action + '" data-key="' + action + '">Show all ' + total + '</button></p>';
  }

  // ── loot ──
  function totalsText(totals) {
    const t = totals || {};
    return ['MS', 'OS', 'DE', 'BANK'].map(function (k) { return (k === 'BANK' ? 'Bank' : k) + ' ' + esc(Number(t[k]) || 0); }).join(' &middot; ');
  }

  function lootPanelHtml(gd, data) {
    const awards = Array.isArray(data.loot.awards) ? data.loot.awards : [];
    const rows = all.loot ? awards : awards.slice(0, SHOWN);
    const body = awards.length
      ? '<div class="gs-pr-body"><ul class="gs-loot-list gs-ch-loot" aria-label="Loot ' + esc(data.character.name) + ' won">' + rows.map(function (a) {
        return G.pages.loot.awardRowHtml(gd, a, { when: 'date', raidLink: true, character: true });
      }).join('') + '</ul></div>' + footHtml(rows.length, awards.length, 'character-loot-all')
      : '<div class="gs-pr-body"><p class="gs-fine">No loot yet.</p></div>';
    return '<section class="gs-hd-panel gs-pr-panel" id="char-loot" aria-labelledby="char-loot-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="char-loot-h">Loot</h2>' +
      (awards.length ? '<span class="gs-pr-mut">' + totalsText(data.loot.totals) + '</span>' : '') + '</div>' + body + '</section>';
  }

  // ── raids ──
  function raidName(raid) { return raid.zone || raid.title || 'Raid'; }
  function bossesText(raid) {
    return raid.bosses && raid.bosses.kills > 0 ? raid.bosses.killed + ' / ' + raid.bosses.kills : '';
  }

  function sortHead(col, label, cls, defaultDir) {
    const state = G.ui.tableSortState[RAIDS_KEY];
    const dir = state ? (state.col === col ? state.dir : '') : (defaultDir || '');
    return '<span class="gs-fg-lbl ' + cls + '" role="columnheader" aria-sort="' + (dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
      '<button type="button" class="gs-sort" data-action="table-sort" data-table="' + RAIDS_KEY + '" data-sort="' + col + '" data-key="tsort-' + RAIDS_KEY + '-' + col + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(label) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></span>';
  }

  function raidRowHtml(gid, raid) {
    const bosses = bossesText(raid);
    return '<div class="gs-ch-raid" role="row"><span class="gs-ch-raid-d" role="cell">' + esc(G.ui.shortDay(raid.raidOn)) + '</span>' +
      '<span class="gs-ch-raid-n" role="cell"><a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: raid.raidId })) + '">' + esc(raidName(raid)) + '</a></span>' +
      '<span class="gs-ch-raid-t" role="cell">' + esc(raid.team.name) + '</span>' +
      '<span class="gs-ch-raid-b" role="cell">' + (bosses ? esc(bosses) : '<span class="gs-sr">No boss count</span><span aria-hidden="true">-</span>') + '</span></div>';
  }

  function raidsPanelHtml(gd, data) {
    const raids = G.ui.sortItems(RAIDS_KEY, Array.isArray(data.raids) ? data.raids : [], {
      date: function (r) { return r.raidOn; }, raid: raidName, team: function (r) { return r.team.name; }, bosses: function (r) { return r.bosses && r.bosses.kills > 0 ? r.bosses.killed : null; },
    });
    const rows = all.raids ? raids : raids.slice(0, SHOWN);
    const body = raids.length
      ? '<div class="gs-ch-raids" role="table" aria-label="Raids ' + esc(data.character.name) + ' was in"><div class="gs-ch-raid is-head" role="row">' +
        sortHead('date', 'Date', 'gs-ch-raid-d', 'desc') + sortHead('raid', 'Raid', 'gs-ch-raid-n') + sortHead('team', 'Team', 'gs-ch-raid-t') + sortHead('bosses', 'Bosses', 'gs-ch-raid-b') + '</div>' +
        rows.map(function (r) { return raidRowHtml(gd.guild.id, r); }).join('') + '</div>' + footHtml(rows.length, raids.length, 'character-raids-all')
      : '<div class="gs-pr-body"><p class="gs-fine">No raids yet.</p></div>';
    return '<section class="gs-hd-panel gs-pr-panel" id="char-raids" aria-labelledby="char-raids-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="char-raids-h">Raids</h2></div>' + body + '</section>';
  }

  // ── details ──
  function kvHtml(label, valueHtml, actionHtml) {
    return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + valueHtml + '</span>' + (actionHtml ? '<span class="gs-pr-end">' + actionHtml + '</span>' : '') + '</div>';
  }

  function changeHtml(which, label) {
    return G.ui.buttonHtml({ label: 'Change', size: 'sm', ariaLabel: 'Change ' + label, attrs: { 'data-action': 'character-spec-open', 'data-which': which, 'data-key': 'character-change-' + which } });
  }

  function detailsPanelHtml(data) {
    const c = data.character;
    const rows = [
      kvHtml('Name', esc(c.name)),
      kvHtml('Main spec', c.mainSpec ? esc(c.mainSpec) : '<span class="gs-muted">Not set</span>', data.can.editSpecs ? changeHtml('main', 'main spec') : ''),
      kvHtml('Off spec', c.offSpec ? esc(c.offSpec) : '<span class="gs-muted">None</span>', data.can.editSpecs ? changeHtml('off', 'off spec') : ''),
      kvHtml('Role', c.isMain ? 'Main' : 'Alt'),
    ];
    if (c.realm) rows.push(kvHtml('Realm', esc(c.realm)));
    if (c.level !== null && c.level !== undefined) rows.push(kvHtml('Level', esc(c.level) + ' <span class="gs-fine">&middot; From Battle.net</span>'));
    if (c.inGameRank) rows.push(kvHtml('In-game rank', esc(c.inGameRank) + ' <span class="gs-fine">&middot; From the guild roster</span>'));
    if (c.addedOn) rows.push(kvHtml('Added', esc(G.ui.shortDay(c.addedOn))));
    return '<section class="gs-hd-panel gs-pr-panel" id="char-details" aria-labelledby="char-details-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="char-details-h">Details</h2></div>' + rows.join('') + '</section>';
  }

  // opts: { guildData, state: { cid, data } (GET /api/me/characters/:cid), alert }
  function pageHtml(opts) {
    const gd = opts.guildData;
    const data = opts.state.data;
    const cols = '<div class="gs-pr-cols"><div class="gs-pr-left">' + lootPanelHtml(gd, data) + raidsPanelHtml(gd, data) + '</div><div class="gs-pr-right">' + detailsPanelHtml(data) + '</div></div>';
    return G.ui.objectPageHtml({
      head: headOpts(gd, data), noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'), pageClass: 'gs-char-page gs-forge gs-pr',
      sections: [{ id: 'char-team', bare: true, bodyHtml: teamPanelHtml(data) }, { id: 'char-cols', bare: true, bodyHtml: cols }],
    });
  }

  // ── dialogs ──
  function specDialogHtml(gd, data, which) {
    const c = data.character;
    const main = which === 'main';
    const field = G.ui.fieldHtml({
      id: 'dlg-spec', name: 'spec', label: main ? 'Main spec' : 'Off spec', kind: 'select', value: (main ? c.mainSpec : c.offSpec) || '',
      options: G.ui.specChoices(G.ui.rosterOptions(gd), c.class, main ? 'Not set' : 'None'), attrs: { 'data-field': main ? 'mainSpec' : 'offSpec' },
    });
    return G.ui.dialogHtml({ kind: 'form', title: 'Change ' + (main ? 'main' : 'off') + ' spec for ' + c.name, bodyHtml: field, primary: { label: 'Save' }, formAttrs: { 'data-submit': 'character-spec-form', 'data-which': which } });
  }

  // Past raids and loot are matched by name, so they stay where they are (the Worker deletes only the character row, its team and any request it holds).
  function removeDialogHtml(data) {
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Remove ' + data.character.name + ' from your profile?', text: data.character.name + ' leaves your profile. Past raids and loot stay under its name.',
      primary: { label: 'Remove' }, formAttrs: { 'data-submit': 'character-remove-form' },
    });
  }

  // ── behaviour ──
  // The Request team dialog (pages-team-requests.js openFor) takes this page's context: the person's characters in the shape of a person record, this one first, and what to do
  // after a request was sent.
  function requestContext() {
    const c = cur();
    if (!c) return null;
    const self = c.data.character;
    const asRow = { id: self.id, name: self.name, class: self.class, mainSpec: self.mainSpec, offSpec: self.offSpec, isMain: self.isMain, team: c.data.team ? { id: c.data.team.id, name: c.data.team.name } : { id: null, name: null } };
    return { gid: c.gid, gd: c.gd, rec: { person: { isMe: true }, characters: [asRow].concat(c.data.siblings) }, firstId: self.id, after: reload };
  }

  function apply(c, data) {
    st().character = { cid: c.cid, data: data };
    st().pageAlert = '';
    G.app.render();
  }

  // The page read again (a request was sent or withdrawn); the viewer's request list follows.
  function reload() {
    const c = cur();
    if (!c) return Promise.resolve(null);
    return Promise.all([G.api.get(url(c.cid)), G.pages.teamRequests.read(c.gid)]).then(function (res) { apply(c, res[0]); return null; }, function (err) { G.app.handleError(err, { pageAlert: true }); return null; });
  }

  G.handlers.click['character-request-open'] = function () {
    const c = requestContext();
    if (c) G.pages.teamRequests.openFor(c);
  };

  G.handlers.click['character-spec-open'] = function (el) {
    const c = cur();
    const which = el.getAttribute('data-which') === 'off' ? 'off' : 'main';
    if (!c) return;
    G.ui.openDialog(specDialogHtml(c.gd, c.data, which), { labelledBy: 'dlg-title' });
    const select = typeof document !== 'undefined' ? document.getElementById('dlg-spec') : null;
    if (select && select.focus) select.focus();
  };

  G.handlers.submit['character-spec-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const which = form.getAttribute('data-which') === 'off' ? 'off' : 'main';
    const value = form.elements.spec.value || null;
    G.ui.runDialog(form, G.api.patch(url(c.cid), which === 'off' ? { offSpec: value } : { mainSpec: value }), function (res) { apply(c, res); }, function (err) {
      const current = err && err.body && err.body.current;
      if (current && current.character) st().character = { cid: c.cid, data: current };
      st().pageAlert = err.message;
      G.app.render();
    });
  };

  G.handlers.click['character-remove-open'] = function () {
    const c = cur();
    if (!c || !c.data.can.remove) return;
    G.ui.openDialog(removeDialogHtml(c.data), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['character-remove-form'] = function (form) {
    const c = cur();
    if (!c) return;
    G.ui.runDialog(form, G.api.del(url(c.cid), {}), function () {
      st().character = null;
      G.app.go(G.router.format({ name: 'characters' }));
    });
  };

  G.handlers.click['character-request-withdraw'] = function (el) {
    const c = cur();
    if (!c || !c.data.request || el.disabled) return null;
    el.disabled = true;
    return G.api.del('/api/guild/' + encodeURIComponent(c.gid) + '/team-requests/' + encodeURIComponent(c.data.request.id), {}).then(reload, function (err) {
      el.disabled = false;
      // Decided meanwhile (409 request_decided): the next read shows what happened.
      return reload().then(function () { st().pageAlert = err && err.message ? err.message : ''; G.app.render(); });
    });
  };

  G.handlers.click['character-loot-all'] = function () { all.loot = true; G.app.render(); };
  G.handlers.click['character-raids-all'] = function () { all.raids = true; G.app.render(); };

  G.pages.character = { load: load, nameFor: nameFor, pageHtml: pageHtml, requestContext: requestContext, reload: reload };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
