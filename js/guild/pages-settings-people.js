// ── PAGE: GUILD SETTINGS > PEOPLE AND ROLES ─────────────────────
// One sortable table (phone: cards), then the Access removed list. Row actions come only from the server's
// `actions` flags; every mutation returns the full people response, which replaces the page's data.
(function (G) {
  'use strict';

  const COLUMN_LABELS = { person: 'Person', roster: 'Roster', roles: 'Roles', lastSeen: 'Last seen' };

  function countText(n) {
    return n === 1 ? '1 person has signed in' : n + ' people have signed in';
  }

  // Name, a compact "you" badge on the same line, and the Discord username underneath when it differs.
  function personTextHtml(p, isMe) {
    const user = p.username && p.username !== p.displayName ? '<span class="gs-person-user">@' + esc(p.username) + '</span>' : '';
    return '<span class="gs-person-text"><span class="gs-person-line"><span class="gs-person-name">' + esc(p.displayName) + '</span>' + (isMe ? '<span class="gs-you">you</span>' : '') + '</span>' + user + '</span>';
  }

  function nameCellHtml(entry) {
    const p = entry.person;
    return '<span class="gs-person">' + G.ui.avatarHtml(p, 'gs-avatar-md') + personTextHtml(p, entry.isMe) + '</span>';
  }

  // roster: null | { personId, name, class } (the person's Main). A linked person opens their record, in the class colour.
  function rosterCellHtml(entry, gid) {
    if (entry.roster == null) return '<span class="gs-muted">Not linked</span>';
    const r = entry.roster;
    if (typeof r === 'string') return esc(r);
    const name = esc((r && r.name) || '');
    if (!r || !r.personId || !gid) return name;
    return '<a class="gs-char-link ' + G.ui.classClass(r.class) + '" href="' + esc(G.router.format({ name: 'person', gid: gid, pid: r.personId })) + '">' + name + '</a>';
  }

  function lastSeenHtml(entry, now) {
    const full = G.ui.formatDateTime(entry.lastSeenAt);
    return '<span' + (full ? ' title="' + esc(full) + '"' : '') + '>' + esc(G.ui.relativeTime(entry.lastSeenAt, now)) + '</span>';
  }

  function rowActionsHtml(entry) {
    const a = entry.actions || {};
    const name = entry.person.displayName;
    const id = entry.person.id;
    let html = '';
    if (a.editRoles || a.makeGuildMaster) {
      html += '<button type="button" class="gs-btn gs-btn-sm" data-action="person-edit-roles" data-uid="' + esc(id) + '" data-key="edit-' + esc(id) + '" aria-label="Edit roles for ' + esc(name) + '">Edit roles</button>';
    }
    if (a.removeAccess) {
      html += '<button type="button" class="gs-btn gs-btn-sm gs-btn-danger-text" data-action="person-remove" data-uid="' + esc(id) + '" data-key="remove-' + esc(id) + '" aria-label="Remove access for ' + esc(name) + '">Remove access</button>';
    }
    return html;
  }

  function sortHeaderHtml(column, sort) {
    const aria = G.peopleSort.ariaSort(sort, column);
    const dir = aria === 'descending' ? 'desc' : aria === 'ascending' ? 'asc' : '';
    return '<th scope="col"' + (aria ? ' aria-sort="' + aria + '"' : '') + '><button type="button" class="gs-sort" data-action="sort" data-col="' + column + '" data-key="sort-' + column + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(COLUMN_LABELS[column]) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></th>';
  }

  // opts: { people, teams, sort, query, now, gid }. The table (wide screens) and the card list (phones) share the rows.
  function tableHtml(opts) {
    const rows = G.peopleSort.sortPeople(G.peopleSort.filterPeople(opts.people, opts.query), opts.sort);
    if (!rows.length) {
      return '<p class="gs-empty">' + (opts.query ? 'No one matches your search.' : 'No one has signed in yet.') + '</p>';
    }
    const body = rows.map(function (e) {
      return '<tr><td>' + nameCellHtml(e) + '</td><td>' + rosterCellHtml(e, opts.gid) + '</td><td><div class="gs-chips">' + G.ui.roleChipsHtml(e.roles, opts.teams) + '</div></td><td class="gs-nowrap">' + lastSeenHtml(e, opts.now) +
        '</td><td><div class="gs-row-actions">' + rowActionsHtml(e) + '</div></td></tr>';
    }).join('');
    const cards = rows.map(function (e) {
      return '<li class="gs-person-card">' + G.ui.avatarHtml(e.person, 'gs-avatar-lg') + '<div class="gs-card-body">' + personTextHtml(e.person, e.isMe) +
        '<span class="gs-card-line">' + rosterCellHtml(e, opts.gid) + '</span><div class="gs-chips">' + G.ui.roleChipsHtml(e.roles, opts.teams) + '</div>' +
        '<span class="gs-card-line gs-muted">Last seen: ' + lastSeenHtml(e, opts.now) + '</span><div class="gs-row-actions">' + rowActionsHtml(e) + '</div></div></li>';
    }).join('');
    return '<div class="gs-table-wrap gs-people-table"><table class="gs-table" aria-label="People who have signed in"><thead><tr>' +
      sortHeaderHtml('person', opts.sort) + sortHeaderHtml('roster', opts.sort) + sortHeaderHtml('roles', opts.sort) + sortHeaderHtml('lastSeen', opts.sort) +
      '<th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<ul class="gs-person-cards" aria-label="People who have signed in">' + cards + '</ul>';
  }

  function removedHtml(opts) {
    const removed = Array.isArray(opts.removed) ? opts.removed : [];
    if (!removed.length) return '';
    return '<h2 class="gs-h2" id="removed-heading">Access removed (' + removed.length + ')</h2><div class="gs-panel gs-panel-flush"><ul class="gs-removed" aria-labelledby="removed-heading">' + removed.map(function (r) {
      const by = r.removedBy && r.removedBy.displayName ? 'Removed by ' + r.removedBy.displayName + ' on ' + G.ui.formatDate(r.removedAt) : 'Removed on ' + G.ui.formatDate(r.removedAt);
      const text = by + (r.reason ? ' - ' + r.reason : '');
      const restore = r.actions && r.actions.restoreAccess
        ? '<button type="button" class="gs-btn gs-btn-sm" data-action="person-restore" data-uid="' + esc(r.person.id) + '" data-key="restore-access-' + esc(r.person.id) + '" aria-label="Restore access for ' + esc(r.person.displayName) + '">Restore access</button>'
        : '';
      return '<li class="gs-removed-item"><span class="gs-person gs-person-dim">' + G.ui.avatarHtml(r.person, 'gs-avatar-md') + personTextHtml(r.person, false) + '</span>' +
        '<span class="gs-removed-text">' + esc(text) + '</span>' + restore + '</li>';
    }).join('') + '</ul></div>';
  }

  function sortSelectHtml(sort) {
    return '<div class="gs-phone-sort"><label class="gs-label" for="people-sort-select">Sort by</label><select class="gs-input" id="people-sort-select" data-change="people-sort-select">' +
      G.peopleSort.COLUMNS.map(function (c) { return '<option value="' + c + '"' + (sort && sort.column === c ? ' selected' : '') + '>' + esc(COLUMN_LABELS[c]) + '</option>'; }).join('') + '</select></div>';
  }

  // opts: { guildData, data, sort, query, notice, alert, now }
  function peopleHtml(opts) {
    const data = opts.data || { people: [], removed: [], signedInCount: 0 };
    const teams = opts.guildData.teams;
    return '<section class="gs-section" aria-labelledby="people-heading"><h2 class="gs-sr" id="people-heading">People</h2>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span><button type="button" class="gs-linkbtn" data-action="dismiss-notice" data-key="dismiss-notice">Dismiss</button></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      '<div class="gs-toolbar"><p class="gs-count">' + esc(countText(data.signedInCount != null ? data.signedInCount : (data.people || []).length)) + '</p>' +
      '<div class="gs-search"><label class="gs-sr" for="people-search">Search people</label>' + G.icons.icon('search', 18) +
      '<input class="gs-input gs-input-search" type="search" id="people-search" placeholder="Search people" data-input="people-search" autocomplete="off" value="' + esc(opts.query || '') + '"></div>' +
      sortSelectHtml(opts.sort) + '</div>' +
      '<div id="people-table">' + tableHtml({ people: data.people, teams: teams, sort: opts.sort, query: opts.query, now: opts.now, gid: opts.guildData.guild.id }) + '</div>' +
      removedHtml({ removed: data.removed }) + '</section>';
  }

  // ── dialogs ──
  function rolesDialogHtml(entry, teams, guildName) {
    const roles = G.peopleSort.normalizeRoles(entry.roles);
    const isOfficer = roles.some(function (r) { return r.role === 'officer'; });
    const leadIds = roles.filter(function (r) { return r.role === 'team_lead' && r.teamId != null; }).map(function (r) { return r.teamId; });
    const a = entry.actions || {};
    const canEdit = !!a.editRoles;
    const name = entry.person.displayName;
    const active = G.shell.activeTeams(teams);
    const checks = '<div class="gs-check"><input type="checkbox" id="dlg-role-officer" name="officer"' + (isOfficer ? ' checked' : '') + '><label for="dlg-role-officer">Officer: whole guild</label></div>' +
      (active.length
        ? active.map(function (t, i) {
          return '<div class="gs-check"><input type="checkbox" id="dlg-role-lead-' + i + '" name="teamLead" value="' + esc(t.id) + '"' + (leadIds.indexOf(t.id) >= 0 ? ' checked' : '') + '><label for="dlg-role-lead-' + i + '">' + (active.length === 1 ? 'Team Lead' : 'Team Lead: ' + esc(t.name)) + '</label></div>';
        }).join('')
        : '<p class="gs-fine">There are no active teams, so no Team Lead roles to give.</p>');
    const gm = a.makeGuildMaster
      ? '<div class="gs-gm"><h3 class="gs-legend">Guild Master</h3>' +
        '<button type="button" class="gs-btn" id="dlg-gm-ask" data-action="gm-ask">Make Guild Master</button>' +
        '<div id="dlg-gm-confirm" hidden><p class="gs-fine">Make ' + esc(name) + ' the Guild Master of ' + esc(guildName) + '? You become an Officer.</p>' +
        '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="gm-cancel">Cancel</button>' +
        '<button type="button" class="gs-btn gs-btn-molten" data-action="gm-confirm">Make Guild Master</button></div></div></div>'
      : '';
    return '<form class="gs-dialog-form" data-submit="roles-form" data-uid="' + esc(entry.person.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Edit roles for ' + esc(name) + '</h2>' +
      '<fieldset class="gs-fieldset"' + (canEdit ? '' : ' disabled') + '><legend class="gs-legend">Roles</legend>' + checks + '</fieldset>' +
      '<p class="gs-fine" id="dlg-help">Officers manage the whole guild. Team Leads manage their team\'s roster, raids and attendance, including officer notes.</p>' +
      gm +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions" id="dlg-roles-footer"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button>' +
      (canEdit ? '<button type="submit" class="gs-btn gs-btn-molten">Save</button>' : '') + '</div></form>';
  }

  function removeDialogHtml(entry, guildName) {
    const name = entry.person.displayName;
    return '<form class="gs-dialog-form" data-submit="remove-form" data-uid="' + esc(entry.person.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Remove ' + esc(name) + '\'s access?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">' + esc(name) + ' can\'t open ' + esc(guildName) + '\'s pages until an officer restores access. Their roster entry and attendance stay.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason (optional)</label><input class="gs-input" type="text" id="dlg-reason" name="reason" maxlength="200" autocomplete="off"></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove access</button></div></form>';
  }

  // ── behaviour ──
  function ctxGuild() {
    const s = G.app.state;
    return s.currentGid ? { gid: s.currentGid, gd: s.guilds[s.currentGid], data: s.people[s.currentGid] } : null;
  }

  function entryById(c, uid) {
    return (c && c.data && c.data.people ? c.data.people : []).filter(function (e) { return e.person.id === uid; })[0] || null;
  }

  function peopleUrl(gid, uid, tail) {
    return '/api/guild/' + encodeURIComponent(gid) + '/people/' + encodeURIComponent(uid) + (tail || '');
  }

  function applyPeople(gid, res) {
    G.app.state.people[gid] = res;
    G.app.state.pageAlert = '';
    G.app.render();
  }

  // Runs a mutation from a dialog form: busy state, error mapping, close on success.
  function runFromDialog(form, gid, promise, after) {
    G.ui.setBusy(form, true);
    promise.then(function (res) {
      applyPeople(gid, res);
      return after ? after() : null;
    }).then(function () {
      G.ui.closeDialogOf(form);
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (err.code === 'conflict') { G.ui.closeDialogOf(form); G.app.handleError(err); return; }
      if (c.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (c.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(c.title, c.text); return; }
      G.ui.setText('dlg-error', c.text);
    });
  }

  G.handlers.click['person-edit-roles'] = function (el) {
    const c = ctxGuild();
    const entry = entryById(c, el.getAttribute('data-uid'));
    if (!entry) return;
    G.ui.openDialog(rolesDialogHtml(entry, c.gd.teams, c.gd.guild.name), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['person-remove'] = function (el) {
    const c = ctxGuild();
    const entry = entryById(c, el.getAttribute('data-uid'));
    if (!entry) return;
    G.ui.openDialog(removeDialogHtml(entry, c.gd.guild.name), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    const input = document.getElementById('dlg-reason');
    if (input) input.focus();
  };

  G.handlers.click['person-restore'] = function (el) {
    const c = ctxGuild();
    if (!c) return;
    el.disabled = true;
    G.api.del(peopleUrl(c.gid, el.getAttribute('data-uid'), '/block'), {}).then(function (res) {
      applyPeople(c.gid, res);
    }, function (err) {
      el.disabled = false;
      G.app.handleError(err, { pageAlert: true });
    });
  };

  G.handlers.click['gm-ask'] = function (el) {
    el.hidden = true;
    const footer = document.getElementById('dlg-roles-footer');
    if (footer) footer.hidden = true;
    const box = document.getElementById('dlg-gm-confirm');
    if (box) { box.hidden = false; const first = box.querySelector('button'); if (first) first.focus(); }
  };
  G.handlers.click['gm-cancel'] = function () {
    const box = document.getElementById('dlg-gm-confirm');
    const ask = document.getElementById('dlg-gm-ask');
    const footer = document.getElementById('dlg-roles-footer');
    if (footer) footer.hidden = false;
    if (box) box.hidden = true;
    if (ask) { ask.hidden = false; ask.focus(); }
  };
  G.handlers.click['gm-confirm'] = function (el) {
    const form = el.closest('form');
    const c = ctxGuild();
    if (!form || !c) return;
    const uid = form.getAttribute('data-uid');
    runFromDialog(form, c.gid, G.api.post(peopleUrl(c.gid, uid, '/guild-master'), {}), function () {
      // The viewer's own roles changed, so what they may do changed too.
      return G.app.refreshGuild(c.gid);
    });
  };

  G.handlers.submit['roles-form'] = function (form) {
    const c = ctxGuild();
    if (!c) return;
    const leadIds = Array.prototype.map.call(form.querySelectorAll('input[name="teamLead"]:checked'), function (i) { return i.value; });
    const body = { officer: !!form.elements.officer.checked, teamLeadTeamIds: leadIds };
    runFromDialog(form, c.gid, G.api.put(peopleUrl(c.gid, form.getAttribute('data-uid'), '/roles'), body));
  };

  G.handlers.submit['remove-form'] = function (form) {
    const c = ctxGuild();
    if (!c) return;
    const reason = form.elements.reason.value.trim();
    runFromDialog(form, c.gid, G.api.post(peopleUrl(c.gid, form.getAttribute('data-uid'), '/block'), { reason: reason }));
  };

  G.handlers.click.sort = function (el) {
    G.app.state.peopleSort = G.peopleSort.nextSort(G.app.state.peopleSort, el.getAttribute('data-col'));
    G.app.render();
  };

  G.handlers.change['people-sort-select'] = function (el) {
    G.app.state.peopleSort = G.peopleSort.nextSort({ column: '', dir: 'asc' }, el.value);
    G.app.render();
  };

  G.handlers.input['people-search'] = function (el) {
    const s = G.app.state;
    s.peopleQuery = el.value;
    const c = ctxGuild();
    const host = document.getElementById('people-table');
    if (!c || !host) return;
    host.innerHTML = tableHtml({ people: c.data.people, teams: c.gd.teams, sort: s.peopleSort, query: s.peopleQuery, now: Date.now(), gid: c.gid });
  };

  G.handlers.click['dismiss-notice'] = function () {
    G.app.state.notice = '';
    G.app.render();
  };

  G.pages.people = {
    COLUMN_LABELS: COLUMN_LABELS,
    countText: countText,
    peopleHtml: peopleHtml,
    tableHtml: tableHtml,
    removedHtml: removedHtml,
    rolesDialogHtml: rolesDialogHtml,
    removeDialogHtml: removeDialogHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
