// ── PAGE: IMPORT FROM THE BATTLE.NET GUILD ROSTER (Phase 5) ─────
// A preview-then-commit page like the Warcraft Logs import. The preview reads the guild's roster from Battle.net (ranks are numbers, named by
// the guild's rank labels), the officer filters it by level, rank and name and ticks the characters to add, and the commit sends only WHICH
// ones: the Worker reads the roster again and takes class and realm from Blizzard. Each ticked character becomes a person with that
// character as Main on the team the officer is working on.
// Pure parts: rowMatches, visibleRows, counts, commitBody, bnetHtml.
(function (G) {
  'use strict';

  const START_STATUSES = ['raider', 'trial', 'reserve'];
  const MAX_COMMIT = 250;
  const NOT_SET_UP = 'Battle.net isn\'t set up on this server.';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function rosterHref(gid) { return G.router.format({ name: 'section', gid: gid, section: 'roster' }); }
  function st() { return G.app.state; }
  function apiBase(gid) { return '/api/guild/' + encodeURIComponent(gid) + '/roster/import/bnet/'; }
  function cur() {
    const s = st();
    const i = s.imports && s.imports.bnet;
    return i && i.gid === s.currentGid ? i : null;
  }

  // ── pure state helpers ──
  // view: { minLevel (number), ranks: { <rank>: boolean }, query, showRoster }
  function rowMatches(row, view) {
    if (row.status === 'on_roster' && !view.showRoster) return false;
    if (typeof view.minLevel === 'number' && view.minLevel > 1 && (row.level == null || row.level < view.minLevel)) return false;
    if (view.ranks && view.ranks[row.rank] === false) return false;
    const q = String(view.query || '').trim().toLowerCase();
    return !q || String(row.name).toLowerCase().indexOf(q) >= 0;
  }

  function visibleRows(preview, view) {
    return ((preview && preview.rows) || []).filter(function (row) { return rowMatches(row, view); });
  }

  // ticked: { <row key>: true }. Only rows that are new can be added; a tick on a row that is no longer shown still counts.
  function tickedRows(preview, ticked) {
    return ((preview && preview.rows) || []).filter(function (row) { return row.status === 'new' && ticked[row.key] === true; });
  }

  function counts(preview, view, ticked) {
    const shown = visibleRows(preview, view);
    const addable = shown.filter(function (row) { return row.status === 'new'; });
    const picked = tickedRows(preview, ticked);
    return {
      total: ((preview && preview.rows) || []).length,
      shown: shown.length,
      addable: addable.length,
      allShownTicked: addable.length > 0 && addable.every(function (row) { return ticked[row.key] === true; }),
      ticked: picked.length,
      tooMany: picked.length > MAX_COMMIT,
    };
  }

  function commitBody(teamId, preview, ticked, defaultStatus) {
    const picked = tickedRows(preview, ticked);
    return {
      body: { teamId: teamId, defaultStatus: defaultStatus, members: picked.map(function (row) { return { name: row.name, realmSlug: row.realmSlug }; }) },
      sent: picked.map(function (row) { return row.key; }),
    };
  }

  function newView(preview) {
    const ranks = {};
    ((preview && preview.ranks) || []).forEach(function (r) { ranks[r.rank] = true; });
    return { minLevel: 1, ranks: ranks, query: '', showRoster: false };
  }

  // ── markup ──
  function statusNote(row) {
    if (row.status === 'on_roster') return '<span class="gs-fine">On the roster' + (row.person && row.person.name ? ' (' + esc(row.person.name) + ')' : '') + '</span>';
    if (row.status === 'other_realm') return '<span class="gs-fine">Another realm: ' + esc(row.realm) + '</span>';
    return '';
  }

  function rowHtml(row, s) {
    const id = 'bnet-tick-' + esc(row.key);
    const addable = row.status === 'new';
    return '<tr><td data-label="Add"><label class="gs-tick"><input type="checkbox" id="' + id + '" data-change="bnet-tick" data-row="' + esc(row.key) + '" data-key="' + id + '" aria-label="Add ' + esc(row.name) + '"' +
      (s.ticked[row.key] === true && addable ? ' checked' : '') + (addable ? '' : ' disabled') + '></label></td>' +
      '<th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(row.name, row.class) + '</th>' +
      '<td data-label="Class">' + esc(G.ui.className(row.class)) + '</td>' +
      '<td data-label="Level">' + (row.level == null ? '<span class="gs-muted">-</span>' : esc(row.level)) + '</td>' +
      '<td data-label="Rank">' + esc(row.rank) + ' <span class="gs-fine">' + esc(rankName(s.preview, row.rank)) + '</span></td>' +
      '<td data-label="Note">' + statusNote(row) + '</td></tr>';
  }

  function rankName(preview, rank) {
    const r = ((preview && preview.ranks) || []).filter(function (x) { return x.rank === rank; })[0];
    return r ? r.label : 'Rank ' + rank;
  }

  function listHtml(s) {
    const c = counts(s.preview, s.view, s.ticked);
    const shown = visibleRows(s.preview, s.view);
    const table = shown.length
      ? '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-import gs-table-bnet-import" aria-label="Guild members"><thead><tr><th scope="col"><label class="gs-tick"><input type="checkbox" id="bnet-tick-all" data-change="bnet-tick-all" data-key="bnet-tick-all" aria-label="Select all shown"' +
        (c.allShownTicked ? ' checked' : '') + (c.addable ? '' : ' disabled') + '></label></th><th scope="col">Character</th><th scope="col">Class</th><th scope="col">Level</th><th scope="col">Rank</th><th scope="col">Note</th></tr></thead><tbody>' +
        shown.map(function (row) { return rowHtml(row, s); }).join('') + '</tbody></table></div>'
      : '<p class="gs-empty" id="bnet-none">' + (c.total ? 'No one matches these filters.' : 'Battle.net lists no members for this guild.') + '</p>';
    return table + '<p class="gs-fine" id="bnet-showing">Showing ' + esc(c.shown) + ' of ' + esc(c.total) + '.</p>';
  }

  function footerHtml(gid, s) {
    const c = counts(s.preview, s.view, s.ticked);
    const summary = c.tooMany ? esc(plural(c.ticked, 'character', 'characters')) + ' ticked: add at most ' + MAX_COMMIT + ' at a time' : esc(plural(c.ticked, 'character', 'characters')) + ' ticked';
    return '<div class="gs-import-bar" id="bnet-footer"><p class="gs-import-sum" role="status">' + summary + '</p><div class="gs-actions"><a class="gs-btn" href="' + esc(rosterHref(gid)) + '">Cancel</a>' +
      '<button type="button" class="gs-btn gs-btn-molten" data-action="bnet-commit" data-key="bnet-commit"' + (!c.ticked || c.tooMany || s.status === 'saving' ? ' disabled' : '') + '>Add ' + esc(plural(c.ticked, 'person', 'people')) + '</button></div></div>';
  }

  function filtersHtml(s) {
    const v = s.view;
    const ranks = (s.preview.ranks || []).map(function (r) {
      const id = 'bnet-rank-' + r.rank;
      return '<span class="gs-check"><input type="checkbox" id="' + id + '" data-change="bnet-rank" data-rank="' + esc(r.rank) + '" data-key="' + id + '"' + (v.ranks[r.rank] !== false ? ' checked' : '') + '>' +
        '<label for="' + id + '">' + esc(r.label) + ' <span class="gs-fine">(' + esc(r.count) + ')</span></label></span>';
    }).join('');
    return '<div class="gs-bnet-filters"><div class="gs-field gs-field-inline"><label class="gs-label" for="bnet-min-level">Minimum level</label>' +
      '<input class="gs-input gs-input-sm" type="number" id="bnet-min-level" min="1" max="100" inputmode="numeric" data-input="bnet-min-level" data-key="bnet-min-level" value="' + esc(v.minLevel) + '"></div>' +
      '<div class="gs-field gs-field-inline"><label class="gs-label" for="bnet-search">Name</label><input class="gs-input gs-input-sm" type="search" id="bnet-search" data-input="bnet-search" data-key="bnet-search" autocomplete="off" value="' + esc(v.query) + '"></div>' +
      '<div class="gs-check"><input type="checkbox" id="bnet-show-roster" data-change="bnet-show-roster" data-key="bnet-show-roster"' + (v.showRoster ? ' checked' : '') + '><label for="bnet-show-roster">Show characters already on the roster</label></div>' +
      '<div class="gs-field gs-field-inline"><label class="gs-label" for="bnet-start">New people start as</label><select class="gs-input" id="bnet-start" data-change="bnet-start" data-key="bnet-start">' +
      G.ui.optionsHtml(START_STATUSES.map(function (x) { return { value: x, label: G.ui.statusLabel(x) }; }), s.defaultStatus) + '</select></div></div>' +
      (ranks ? '<fieldset class="gs-bnet-ranks-filter"><legend class="gs-label">Ranks</legend><div class="gs-bnet-rank-list">' + ranks + '</div></fieldset>' : '');
  }

  function infoHtml(gd, d) {
    if (!d) return G.pages.signin.loadingHtml();
    const settingsHref = esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'battlenet' }));
    const settingsLink = d.canEdit ? ' <a href="' + settingsHref + '">Open Guild settings &gt; Battle.net</a>.' : ' Ask an officer to set it in Guild settings.';
    if (!d.configured) return '<p class="gs-warn" id="bnet-import-not-set-up" role="status">' + esc(NOT_SET_UP) + '</p>';
    if (!d.supported) return '<p class="gs-warn" id="bnet-import-unsupported" role="status">' + esc(d.message) + '</p>';
    if (d.realmNeeded) return '<p class="gs-warn" id="bnet-import-realm" role="status">Battle.net needs the realm this guild lives on.' + settingsLink + '</p>';
    return '<p class="gs-fine" id="bnet-import-target">Reads <strong>' + esc(d.effectiveGuildName) + '</strong> on ' + esc(d.realmKind === 'ruleset' ? d.realmSlug : gd.guild.realm) + ' (' + esc(gd.guild.region) + '). ' +
      'Wrong guild name?' + (d.canEdit ? ' <a href="' + settingsHref + '">Change it in Guild settings</a>.' : ' Ask an officer to change it in Guild settings.') + '</p>';
  }

  function errorHtml(s) {
    if (!s.error) return '';
    return '<div class="gs-alert gs-import-alert" role="alert" id="gs-page-alert"><span>' + esc(s.error) + '</span>' +
      (s.offerReload ? '<button type="button" class="gs-btn gs-btn-sm" data-action="bnet-load" data-key="bnet-reload">Load the roster again</button>' : '') + '</div>';
  }

  // opts: { guildData, bnet } where bnet is the page state (ensureState).
  function bnetHtml(opts) {
    const gd = opts.guildData;
    const s = opts.bnet;
    const d = s.info;
    const gid = gd.guild.id;
    const ready = !!(d && d.configured && d.supported && !d.realmNeeded);
    let result = '';
    if (s.preview) {
      const when = G.ui.formatDateTime(s.preview.fetchedAt);
      result = '<section aria-labelledby="bnet-result" class="gs-import-result"><div class="gs-import-result-head"><h2 class="gs-h2" id="bnet-result">' + esc(s.preview.guild.name) + ' &middot; ' +
        esc(plural(s.preview.rows.length, 'member', 'members')) + (when ? ' &middot; read ' + esc(when) : '') + '</h2>' +
        '<p class="gs-fine">Tick the characters to add. Each becomes a person with that character as Main; their Discord account is linked later, when they claim it on My characters. Battle.net data is not kept: only the people you add are saved.</p></div>' +
        filtersHtml(s) + '<div id="bnet-list">' + listHtml(s) + '</div></section>';
    }
    return '<div class="gs-page gs-import-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Import from Battle.net</h1>' +
      '<p class="gs-lead gs-lead-sm">Reads your in-game guild\'s member list from Battle.net and adds the characters you pick to the roster.</p></div>' +
      infoHtml(gd, d) +
      (ready ? '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="bnet-load" data-key="bnet-load"' + (s.status === 'loading' ? ' disabled' : '') + '>' + (s.preview ? 'Load the roster again' : 'Load the guild roster') + '</button></div>' : '') +
      errorHtml(s) + result + (s.preview ? footerHtml(gid, s) : '') + '</div>';
  }

  // ── state and behaviour ──
  function ensureState(gid, teamId) {
    const s = st();
    if (!s.imports) s.imports = {};
    const c = s.imports.bnet;
    if (c && c.gid === gid && c.teamId === teamId) return c;
    s.imports.bnet = { gid: gid, teamId: teamId, status: 'idle', error: '', offerReload: false, info: null, preview: null, view: newView(null), ticked: {}, defaultStatus: 'trial', rowErrors: {} };
    return s.imports.bnet;
  }

  // The settings summary (is it set up, does the version have data, what will be read) into the page state.
  function loadInfo(s) {
    return G.api.get('/api/guild/' + encodeURIComponent(s.gid) + '/bnet').then(function (info) {
      s.info = info;
      return info;
    });
  }

  function failure(s, err, offerReload) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return false; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return false; }
    s.error = c.text;
    s.offerReload = !!offerReload;
    return true;
  }

  function refreshList() {
    const s = cur();
    const list = document.getElementById('bnet-list');
    const footer = document.getElementById('bnet-footer');
    const gd = st().guilds[st().currentGid];
    if (!s || !s.preview || !list || !gd) return;
    list.innerHTML = listHtml(s);
    if (footer) footer.outerHTML = footerHtml(gd.guild.id, s);
  }

  G.handlers.click['bnet-load'] = function () {
    const s = cur();
    if (!s || s.status === 'loading') return;
    s.status = 'loading';
    s.error = '';
    s.offerReload = false;
    G.app.render();
    G.api.post(apiBase(s.gid) + 'preview', { teamId: s.teamId }).then(function (res) {
      s.status = 'ready';
      s.preview = res;
      s.view = newView(res);
      s.ticked = {};
      s.rowErrors = {};
      G.app.render();
    }, function (err) {
      s.status = 'idle';
      s.preview = null;
      if (failure(s, err, false)) G.app.render();
    });
  };

  G.handlers.input['bnet-min-level'] = function (el) {
    const s = cur();
    if (!s) return;
    const n = Number(el.value);
    s.view.minLevel = isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    refreshList();
  };
  G.handlers.input['bnet-search'] = function (el) { const s = cur(); if (s) { s.view.query = el.value; refreshList(); } };
  G.handlers.change['bnet-show-roster'] = function (el) { const s = cur(); if (s) { s.view.showRoster = el.checked; refreshList(); } };
  G.handlers.change['bnet-rank'] = function (el) { const s = cur(); if (s) { s.view.ranks[el.getAttribute('data-rank')] = el.checked; refreshList(); } };
  G.handlers.change['bnet-start'] = function (el) { const s = cur(); if (s && START_STATUSES.indexOf(el.value) >= 0) s.defaultStatus = el.value; };
  G.handlers.change['bnet-tick'] = function (el) {
    const s = cur();
    if (!s) return;
    s.ticked[el.getAttribute('data-row')] = el.checked;
    refreshList();
  };
  G.handlers.change['bnet-tick-all'] = function (el) {
    const s = cur();
    if (!s || !s.preview) return;
    visibleRows(s.preview, s.view).forEach(function (row) { if (row.status === 'new') s.ticked[row.key] = el.checked; });
    refreshList();
  };

  G.handlers.click['bnet-commit'] = function () {
    const s = cur();
    if (!s || !s.preview || s.status === 'saving') return;
    const c = counts(s.preview, s.view, s.ticked);
    if (!c.ticked || c.tooMany) return;
    const built = commitBody(s.teamId, s.preview, s.ticked, s.defaultStatus);
    s.status = 'saving';
    s.error = '';
    s.rowErrors = {};
    G.app.render();
    G.api.post(apiBase(s.gid) + 'commit', built.body).then(function (res) {
      s.status = 'ready';
      const people = res && typeof res.people === 'number' ? res.people : c.ticked;
      G.app.applyFlags(s.gid, res);
      st().rosterNotice = 'Added ' + plural(people, 'person', 'people') + ' from the Battle.net guild roster.';
      st().imports.bnet = null;
      G.app.go(rosterHref(s.gid));
    }, function (err) {
      s.status = 'ready';
      if (err && err.index != null && built.sent[err.index] != null && err.code !== 'roster_changed') {
        s.rowErrors[built.sent[err.index]] = err.message;
        s.error = err.message + ' Untick it and try again.';
        s.offerReload = false;
        G.app.render();
        return;
      }
      const reload = err && ['roster_changed', 'name_taken', 'person_limit', 'character_limit'].indexOf(err.code) >= 0;
      if (failure(s, err, reload)) G.app.render();
    });
  };

  G.pages.importBnet = {
    START_STATUSES: START_STATUSES,
    MAX_COMMIT: MAX_COMMIT,
    NOT_SET_UP: NOT_SET_UP,
    rowMatches: rowMatches,
    visibleRows: visibleRows,
    tickedRows: tickedRows,
    counts: counts,
    commitBody: commitBody,
    newView: newView,
    bnetHtml: bnetHtml,
    listHtml: listHtml,
    footerHtml: footerHtml,
    ensureState: ensureState,
    loadInfo: loadInfo,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
