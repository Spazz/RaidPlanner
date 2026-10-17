// ── PAGE: ROSTER ────────────────────────────────────────────────
// The roster list for one team: header, Import menu, Add person, the trial strip, filters and a sortable table
// (phone: cards), the empty roster, and the Add person dialog. Data comes from GET /roster?team=; every
// mutation goes through the person record page's handlers or the import pages.
(function (G) {
  'use strict';

  const COLUMN_LABELS = { player: 'Player', mainSpec: 'Main spec', offSpec: 'Off spec', status: 'Status', joined: 'Joined', alts: 'Alts', signIn: 'Sign-in' };
  const ROLE_FILTER_LABELS = { all: 'All', tank: 'Tanks', healer: 'Healers', dps: 'DPS' };
  const STATUS_FILTER_LABELS = { active: 'Active', raider: 'Raider', trial: 'Trial', reserve: 'Reserve', inactive: 'Inactive', decide: 'Trials to decide', everyone: 'Everyone' };
  const TRIAL_DAYS = 28;

  function personHref(gid, pid) { return G.router.format({ name: 'person', gid: gid, pid: pid }); }
  function importHref(gid, source) { return G.router.format({ name: 'import', gid: gid, source: source }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function severalTeams(gd) { return G.shell.activeTeams(gd && gd.teams).length > 1; }

  // ── header, strip, filters ──
  function subHtml(gd, data) {
    const people = Array.isArray(data.people) ? data.people : [];
    const active = G.rosterSort.activeCount(people);
    if (severalTeams(gd) || (data.team && data.team.archived)) {
      return esc(data.team && data.team.name) + ' &middot; ' + esc(plural(active, 'person', 'people'));
    }
    return esc(gd.guild.name) + ' &middot; ' + esc(active + ' active, ' + G.rosterSort.inactiveCount(people) + ' inactive');
  }

  function importMenuHtml(gid) {
    return '<div class="gs-import-menu"><button type="button" class="gs-btn" data-action="roster-import-menu" data-key="roster-import" aria-haspopup="menu" aria-expanded="false" aria-controls="roster-import-list">Import' + G.icons.icon('chevronDown', 16) + '</button>' +
      '<div class="gs-menu" id="roster-import-list" role="menu" aria-label="Import" hidden>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(importHref(gid, 'raid-helper')) + '"><span>From a Raid-Helper event</span></a>' +
      '<div class="gs-menu-sep" role="separator"></div>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(importHref(gid, 'wcl')) + '"><span>From a Warcraft Logs report</span></a>' +
      '<div class="gs-menu-sep" role="separator"></div>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(importHref(gid, 'bnet')) + '"><span>From the Battle.net guild roster</span></a></div></div>';
  }

  function headHtml(gd, data) {
    const canAdd = !!(data.can && data.can.edit) && !(data.team && data.team.archived);
    return '<div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Roster</h1><p class="gs-sub">' + subHtml(gd, data) + '</p></div>' +
      (canAdd ? '<div class="gs-roster-actions">' + importMenuHtml(gd.guild.id) + '<button type="button" class="gs-btn gs-btn-molten" data-action="roster-add" data-key="roster-add">Add person</button></div>' : '') + '</div>';
  }

  // "2 trials need a decision: Frostwhisper's ends in 5 days, Sølvhand's ended 2 days ago."
  function trialStripHtml(data) {
    if (!(data.can && data.can.edit)) return '';
    const flagged = G.rosterSort.trialsToDecide(data.people, data.team && data.team.id);
    if (!flagged.length) return '';
    const parts = flagged.map(function (p) {
      return esc(p.main.name) + '\'s ' + esc(G.ui.trialCopy(p.trialFlag).toLowerCase());
    });
    return '<div class="gs-trial-strip" role="status"><p class="gs-trial-strip-text">' + esc(plural(flagged.length, 'trial needs', 'trials need')) + ' a decision: ' + parts.join(', ') + '.</p>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="roster-show-trials" data-key="roster-show-trials">Show them</button></div>';
  }

  function filtersHtml(data, f) {
    const counts = G.rosterSort.roleCounts(data.people);
    const roleBtns = G.rosterSort.ROLES.map(function (r) {
      return '<button type="button" class="gs-seg" data-action="roster-role" data-role="' + r + '" data-key="role-' + r + '" aria-pressed="' + (f.role === r ? 'true' : 'false') + '">' +
        esc(ROLE_FILTER_LABELS[r]) + ' <span class="gs-seg-count">' + counts[r] + '</span></button>';
    }).join('');
    // Trial flags are for editors, so only they get the "Trials to decide" filter.
    const canEdit = !!(data.can && data.can.edit);
    const statuses = G.rosterSort.STATUS_FILTERS.filter(function (s) { return canEdit || s !== 'decide'; });
    const statusOpts = G.ui.optionsHtml(statuses.map(function (s) { return { value: s, label: STATUS_FILTER_LABELS[s] }; }), f.status);
    return '<div class="gs-roster-filters"><div class="gs-search"><label class="gs-sr" for="roster-search">Search people or characters</label>' + G.icons.icon('search', 18) +
      '<input class="gs-input gs-input-search" type="search" id="roster-search" placeholder="Search people or characters" data-input="roster-search" autocomplete="off" value="' + esc(f.query) + '"></div>' +
      '<div class="gs-segs" role="group" aria-label="Filter by role">' + roleBtns + '</div>' +
      '<div class="gs-roster-status"><label class="gs-label" for="roster-status">Status</label><select class="gs-input" id="roster-status" data-change="roster-status" data-key="roster-status">' + statusOpts + '</select></div></div>';
  }

  // ── table and cards ──
  function sortHeaderHtml(column, sort) {
    const aria = G.rosterSort.ariaSort(sort, column);
    const dir = aria === 'descending' ? 'desc' : aria === 'ascending' ? 'asc' : '';
    return '<th scope="col"' + (aria ? ' aria-sort="' + aria + '"' : '') + '><button type="button" class="gs-sort" data-action="roster-sort" data-col="' + column + '" data-key="rsort-' + column + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(COLUMN_LABELS[column]) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></th>';
  }

  function altTagHtml(p) {
    if (!p.shown || !p.main || p.shown.id === p.main.id) return '';
    return '<span class="gs-char-sub">Alt of ' + esc(p.main.name) + ' (' + esc(p.main.team && p.main.team.name) + ')</span>';
  }

  function nameCellHtml(gid, p) {
    const s = p.shown;
    const link = '<a class="gs-char-link ' + G.ui.classClass(s.class) + '" href="' + esc(personHref(gid, p.id)) + '">' + esc(s.name) + '</a>';
    return '<span class="gs-char-cell">' + G.ui.roleDotHtml(s.role) + '<span class="gs-char-text">' + link + altTagHtml(p) + '</span></span>';
  }

  // Trial flag chips are for officers: shown when the viewer can edit this team and it is the person's home team.
  function flagChipHtml(p, opts) {
    return opts && opts.showFlags && p.main && p.main.team && p.main.team.id === opts.teamId ? G.ui.trialChipHtml(p.trialFlag) : '';
  }

  function statusCellHtml(p, opts) {
    return '<span class="gs-status-cell">' + G.ui.statusChipHtml(p.status, p) + flagChipHtml(p, opts) + '</span>';
  }

  function offSpecHtml(s) { return s.offSpec ? esc(s.offSpec) : '<span class="gs-muted">-</span>'; }

  function rowHtml(gid, p, opts) {
    const s = p.shown;
    return '<tr><th scope="row" class="gs-cell-strong">' + nameCellHtml(gid, p) + '</th><td>' + esc(G.ui.className(s.class)) + (s.mainSpec ? ' &middot; ' + esc(s.mainSpec) : '') + '</td><td>' + offSpecHtml(s) + '</td><td>' + statusCellHtml(p, opts) + '</td><td class="gs-nowrap">' +
      esc(G.ui.formatDay(p.joinedOn) || '-') + '</td><td><span class="gs-muted">-</span></td><td>' + esc(p.altCount || 0) + '</td><td>' + esc(G.ui.signInLabel(p.signIn)) + '</td></tr>';
  }

  function cardHtml(gid, p, opts) {
    const s = p.shown;
    const flag = flagChipHtml(p, opts);
    return '<li class="gs-roster-card"><div class="gs-card-top">' + nameCellHtml(gid, p) + G.ui.statusChipHtml(p.status, p) + '</div>' +
      '<div class="gs-card-line">' + G.ui.specLineHtml(s.class, s.mainSpec, s.offSpec) + '</div>' +
      '<div class="gs-card-meta">' + flag + '<span class="gs-fine">Alts ' + esc(p.altCount || 0) + ' &middot; Sign-in: ' + esc(G.ui.signInLabel(p.signIn)) + '</span></div></li>';
  }

  // opts: { gid, teamId, people, filter, sort }. The results block is the part the search box redraws.
  function resultsHtml(opts) {
    const rows = G.rosterSort.sortPeople(G.rosterSort.filterPeople(opts.people, opts.filter, opts.teamId), opts.sort);
    if (!rows.length) return '<p class="gs-empty">No one matches these filters.</p>';
    return '<div class="gs-table-wrap gs-roster-table"><table class="gs-table gs-table-roster" aria-label="Roster"><thead><tr>' +
      G.rosterSort.COLUMNS.slice(0, 5).map(function (c) { return sortHeaderHtml(c, opts.sort); }).join('') +
      '<th scope="col">Attendance</th>' + sortHeaderHtml('alts', opts.sort) + sortHeaderHtml('signIn', opts.sort) +
      '</tr></thead><tbody>' + rows.map(function (p) { return rowHtml(opts.gid, p, opts); }).join('') + '</tbody></table></div>' +
      '<ul class="gs-roster-cards" aria-label="Roster">' + rows.map(function (p) { return cardHtml(opts.gid, p, opts); }).join('') + '</ul>';
  }

  function emptyHtml(gd, data) {
    const canEdit = !!(data.can && data.can.edit) && !(data.team && data.team.archived);
    const gid = gd.guild.id;
    const body = canEdit
      ? '<p class="gs-lead gs-lead-sm">Nobody is on this roster yet. Import a Raid-Helper event to add everyone who signed up, or add people one at a time.</p>' +
        '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(importHref(gid, 'raid-helper')) + '">Import from a Raid-Helper event</a>' +
        '<button type="button" class="gs-btn" data-action="roster-add" data-key="roster-add">Add person</button></div>'
      : '<p class="gs-lead gs-lead-sm">Your officers haven\'t added anyone yet.</p>';
    return '<section class="gs-empty-card" aria-labelledby="roster-empty-heading"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="roster-empty-heading">No one on the roster yet</h2>' + body + '</section>';
  }

  // opts: { guildData, data (GET /roster?team=), view: { sort, role, status, query }, notice, alert }
  function rosterHtml(opts) {
    const gd = opts.guildData;
    const data = opts.data || { people: [], team: {}, can: {} };
    const people = Array.isArray(data.people) ? data.people : [];
    const view = Object.assign({}, G.rosterSort.DEFAULT_FILTER, { sort: G.rosterSort.DEFAULT_SORT }, opts.view || {});
    const filter = { role: view.role, status: view.status, query: view.query };
    const archived = !!(data.team && data.team.archived);
    return '<div class="gs-page">' + headHtml(gd, data) +
      (archived ? '<div class="gs-notice" role="status"><span>Archived team. Its characters stay on this roster, but no one can be added to it.</span></div>' : '') +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span><button type="button" class="gs-linkbtn" data-action="dismiss-roster-notice" data-key="dismiss-roster-notice">Dismiss</button></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      (people.length
        ? trialStripHtml(data) + filtersHtml(data, filter) +
          '<div id="roster-results">' + resultsHtml({ gid: gd.guild.id, teamId: data.team && data.team.id, people: people, filter: filter, sort: view.sort, showFlags: !!(data.can && data.can.edit) }) + '</div>'
        : emptyHtml(gd, data)) +
      '</div>';
  }

  // A guild with no active team has no roster to show.
  function noTeamHtml(canManageTeams, gid) {
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Roster</h1></div><section class="gs-empty-card"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg">No active team</h2><p class="gs-lead gs-lead-sm">The roster belongs to a team, and this guild has no active team.' + (canManageTeams ? '' : ' Ask a Guild Master or Officer to add one.') + '</p>' +
      (canManageTeams ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'settings', gid: gid, tab: 'teams' })) + '">Open Teams</a></div>' : '') + '</section></div>';
  }

  // ── Add person dialog ──
  function teamFieldHtml(gd, selectedId, idPrefix) {
    const active = G.shell.activeTeams(gd.teams);
    if (active.length < 2) return '';
    return '<div class="gs-field"><label class="gs-label" for="' + idPrefix + '-team">Team</label><select class="gs-input" id="' + idPrefix + '-team" name="teamId" data-field="teamId">' +
      G.ui.optionsHtml(active.map(function (t) { return { value: t.id, label: t.name }; }), selectedId) + '</select><p class="gs-field-error" id="dlg-err-teamId" role="alert" hidden></p></div>';
  }

  function linkOptionsHtml(users, selected) {
    const items = [{ value: '', label: 'Not linked' }].concat((Array.isArray(users) ? users : []).map(function (u) {
      return { value: u.id, label: u.displayName + (u.username && u.username !== u.displayName ? ' (@' + u.username + ')' : '') };
    }));
    return G.ui.optionsHtml(items, selected);
  }

  // opts: { guildData, teamId, today, linkable: [person] }
  function addPersonDialogHtml(opts) {
    const gd = opts.guildData;
    const ro = G.ui.rosterOptions(gd);
    const trialEnd = G.ui.addDays(opts.today, TRIAL_DAYS);
    return '<form class="gs-dialog-form" data-submit="add-person-form" data-gid="' + esc(gd.guild.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Add person</h2>' +
      '<p class="gs-fine" id="dlg-help">Start with their Main character. You can add Alts on their record.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-name">Character name</label><input class="gs-input" type="text" id="dlg-name" name="name" data-field="name" maxlength="40" autocomplete="off" required>' +
      '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-class">Class</label><select class="gs-input" id="dlg-class" name="class" data-field="class" data-change="roster-class-change">' + G.ui.classOptionsHtml(ro, '', 'Choose a class') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-class" role="alert" hidden></p></div>' +
      '<div class="gs-grid gs-grid-2"><div class="gs-field"><label class="gs-label" for="dlg-mainspec">Main spec</label><select class="gs-input" id="dlg-mainspec" name="mainSpec" data-field="mainSpec">' + G.ui.specOptionsHtml(ro, '', '', 'Not set') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-mainSpec" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-offspec">Off spec</label><select class="gs-input" id="dlg-offspec" name="offSpec" data-field="offSpec">' + G.ui.specOptionsHtml(ro, '', '', 'None') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-offSpec" role="alert" hidden></p></div></div>' +
      teamFieldHtml(gd, opts.teamId, 'dlg') +
      '<fieldset class="gs-fieldset"><legend class="gs-legend">Status</legend><div class="gs-radios">' +
      ['raider', 'trial', 'reserve'].map(function (s) {
        return '<div class="gs-check"><input type="radio" id="dlg-status-' + s + '" name="status" value="' + s + '"' + (s === 'trial' ? ' checked' : '') + ' data-change="roster-status-change"><label for="dlg-status-' + s + '">' + esc(G.ui.statusLabel(s)) + '</label></div>';
      }).join('') + '</div></fieldset>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-joined">Joined</label><input class="gs-input" type="date" id="dlg-joined" name="joinedOn" data-field="joinedOn" value="' + esc(opts.today) + '"><p class="gs-field-error" id="dlg-err-joinedOn" role="alert" hidden></p></div>' +
      '<div class="gs-field" id="dlg-trialend-field"><label class="gs-label" for="dlg-trialend">Trial ends</label><input class="gs-input" type="date" id="dlg-trialend" name="trialEnd" data-field="trialEnd" value="' + esc(trialEnd) + '" aria-describedby="dlg-trialend-help">' +
      '<p class="gs-fine" id="dlg-trialend-help">Officers get a flag 7 days before this date.</p><p class="gs-field-error" id="dlg-err-trialEnd" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-link">Discord account (optional)</label><select class="gs-input" id="dlg-link" name="linkUserId" data-field="linkUserId" aria-describedby="dlg-link-help">' + linkOptionsHtml(opts.linkable, '') + '</select>' +
      '<p class="gs-fine" id="dlg-link-help">Lists members who have signed in to Raidsmith and are not on the roster yet.</p><p class="gs-field-error" id="dlg-err-linkUserId" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add person</button></div></form>';
  }

  // ── behaviour ──
  function st() { return G.app.state; }

  function rosterUi() {
    const s = st();
    if (!s.rosterUi) s.rosterUi = { sort: { column: G.rosterSort.DEFAULT_SORT.column, dir: G.rosterSort.DEFAULT_SORT.dir }, role: 'all', status: 'active', query: '' };
    return s.rosterUi;
  }

  function currentGd() {
    const s = st();
    return s.currentGid ? s.guilds[s.currentGid] : null;
  }

  function refreshResults() {
    const s = st();
    const host = document.getElementById('roster-results');
    const gd = currentGd();
    if (!host || !s.roster || !gd) return;
    const v = rosterUi();
    host.innerHTML = resultsHtml({ gid: gd.guild.id, teamId: s.roster.data.team.id, people: s.roster.data.people, filter: { role: v.role, status: v.status, query: v.query }, sort: v.sort, showFlags: !!(s.roster.data.can && s.roster.data.can.edit) });
  }

  G.handlers.click['roster-sort'] = function (el) {
    const v = rosterUi();
    v.sort = G.rosterSort.nextSort(v.sort, el.getAttribute('data-col'));
    G.app.render();
  };
  G.handlers.click['roster-role'] = function (el) {
    const role = el.getAttribute('data-role');
    if (G.rosterSort.ROLES.indexOf(role) < 0) return;
    rosterUi().role = role;
    G.app.render();
  };
  G.handlers.change['roster-status'] = function (el) {
    if (G.rosterSort.STATUS_FILTERS.indexOf(el.value) < 0) return;
    rosterUi().status = el.value;
    G.app.render();
  };
  G.handlers.input['roster-search'] = function (el) {
    rosterUi().query = el.value;
    refreshResults();
  };
  G.handlers.click['roster-show-trials'] = function () {
    rosterUi().status = 'decide';
    G.app.render();
  };
  G.handlers.click['dismiss-roster-notice'] = function () {
    st().rosterNotice = '';
    G.app.render();
  };

  G.handlers.click['roster-import-menu'] = function (btn) {
    const menu = document.getElementById('roster-import-list');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = menu.querySelector('[role="menuitem"]'); if (first) first.focus(); }
  };

  function loadLinkable(gid) {
    const s = st();
    if (!s.linkable) s.linkable = {};
    if (s.linkable[gid]) return Promise.resolve(s.linkable[gid]);
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/roster/linkable').then(function (res) {
      s.linkable[gid] = res && Array.isArray(res.users) ? res.users : [];
      return s.linkable[gid];
    }, function () { return []; });
  }
  G.pages.roster = G.pages.roster || {};
  G.pages.roster.loadLinkable = loadLinkable;

  G.handlers.click['roster-add'] = function () {
    const s = st();
    const gd = currentGd();
    if (!gd || !s.roster) return;
    loadLinkable(gd.guild.id).then(function (users) {
      if (G.router.parse(window.location.hash).name !== 'section') return; // the page changed while the list loaded
      G.ui.openDialog(addPersonDialogHtml({ guildData: gd, teamId: s.roster.data.team.id, today: s.roster.data.today, linkable: users }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-name');
      if (input) input.focus();
    });
  };

  // A class change resets both spec selects to the new class's specs.
  G.handlers.change['roster-class-change'] = function (el) {
    const gd = currentGd();
    const form = el.closest('form');
    if (!gd || !form) return;
    const ro = G.ui.rosterOptions(gd);
    form.elements.mainSpec.innerHTML = G.ui.specOptionsHtml(ro, el.value, '', 'Not set');
    form.elements.offSpec.innerHTML = G.ui.specOptionsHtml(ro, el.value, '', 'None');
  };

  G.handlers.change['roster-status-change'] = function (el) {
    const field = document.getElementById('dlg-trialend-field');
    if (field) field.hidden = el.value !== 'trial';
  };

  function dateOrNull(v) { return v ? v : null; }

  // The shared character fields (name, class, specs) as a request body piece, or an error string.
  function readCharacter(form) {
    const name = form.elements.name.value.trim();
    const cls = form.elements.class.value;
    const mainSpec = form.elements.mainSpec.value;
    const offSpec = form.elements.offSpec.value;
    G.ui.setText('dlg-err-name', '');
    G.ui.setText('dlg-err-class', '');
    G.ui.setText('dlg-err-offSpec', '');
    if (!name) { G.ui.setText('dlg-err-name', 'Enter a character name.'); form.elements.name.focus(); return null; }
    if (!cls) { G.ui.setText('dlg-err-class', 'Choose a class.'); form.elements.class.focus(); return null; }
    if (offSpec && offSpec === mainSpec) { G.ui.setText('dlg-err-offSpec', 'Off spec must differ from main spec.'); form.elements.offSpec.focus(); return null; }
    return { name: name, class: cls, mainSpec: mainSpec || null, offSpec: offSpec || null };
  }

  G.pages.roster.readCharacter = readCharacter;

  G.handlers.submit['add-person-form'] = function (form) {
    const gid = form.getAttribute('data-gid');
    const s = st();
    G.ui.setText('dlg-error', '');
    const ch = readCharacter(form);
    if (!ch) return;
    const status = form.querySelector('input[name="status"]:checked').value;
    const body = Object.assign({}, ch, {
      teamId: form.elements.teamId ? form.elements.teamId.value : s.roster.data.team.id,
      status: status,
      joinedOn: dateOrNull(form.elements.joinedOn.value),
      trialEnd: status === 'trial' ? dateOrNull(form.elements.trialEnd.value) : null,
      linkUserId: form.elements.linkUserId.value || null,
    });
    G.ui.runDialog(form, G.api.post('/api/guild/' + encodeURIComponent(gid) + '/roster', body), function (res) {
      G.app.applyFlags(gid, res);
      if (s.linkable) delete s.linkable[gid];
      if (res && res.person && res.person.id) {
        G.app.setPerson(gid, res);
        G.app.go(personHref(gid, res.person.id));
      } else {
        G.app.go(G.router.format({ name: 'section', gid: gid, section: 'roster' }));
      }
    });
  };

  Object.assign(G.pages.roster, {
    COLUMN_LABELS: COLUMN_LABELS,
    STATUS_FILTER_LABELS: STATUS_FILTER_LABELS,
    TRIAL_DAYS: TRIAL_DAYS,
    rosterHtml: rosterHtml,
    resultsHtml: resultsHtml,
    trialStripHtml: trialStripHtml,
    filtersHtml: filtersHtml,
    emptyHtml: emptyHtml,
    noTeamHtml: noTeamHtml,
    addPersonDialogHtml: addPersonDialogHtml,
    teamFieldHtml: teamFieldHtml,
    linkOptionsHtml: linkOptionsHtml,
    personHref: personHref,
    importHref: importHref,
    importMenuHtml: importMenuHtml,
  });
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
