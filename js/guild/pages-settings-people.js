// ── PAGE: GUILD SETTINGS > ACCOUNTS (the sign-in accounts and their roles) ──
// One sortable table (phone: cards), then the Access removed list. Row actions come only from the server's
// `actions` flags; every mutation returns the full people response, which replaces the page's data.
// Roles a person holds come in two kinds: set by hand (the Edit roles boxes) and only given by Discord (listed read-only, "From Discord"). The guild's
// own roles ("Other roles") are listed from state.rolesList[gid], which the People tab loads for people who can manage roles.
(function (G) {
  'use strict';

  const COLUMN_LABELS = { person: 'Person', roster: 'Roster', roles: 'Roles', lastSeen: 'Last seen' };

  function countText(n) {
    return n === 1 ? '1 account has signed in' : n + ' accounts have signed in';
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
    const full = G.ui.formatDateTime(entry.lastSeenAt, G.ui.guildZone());
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
    if (a.syncDiscord) {
      html += '<button type="button" class="gs-btn gs-btn-sm" data-action="person-sync" data-uid="' + esc(id) + '" data-key="sync-' + esc(id) + '" aria-label="Sync Discord roles for ' + esc(name) + '">Sync now</button>';
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
    return '<div class="gs-table-wrap gs-people-table"><table class="gs-table" aria-label="Accounts that have signed in"><thead><tr>' +
      sortHeaderHtml('person', opts.sort) + sortHeaderHtml('roster', opts.sort) + sortHeaderHtml('roles', opts.sort) + sortHeaderHtml('lastSeen', opts.sort) +
      '<th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<ul class="gs-person-cards" aria-label="Accounts that have signed in">' + cards + '</ul>';
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
    // Sync everyone: the bot is set up and a Discord role is mapped (the Worker says so), and the viewer may sync.
    const canSyncAll = !!(data.discord && data.discord.configured && data.discord.mapped) && G.shell.hasAction(opts.guildData.me && opts.guildData.me.can, 'guild.access');
    return '<section class="gs-section" aria-labelledby="settings-title">' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span><button type="button" class="gs-linkbtn" data-action="dismiss-notice" data-key="dismiss-notice">Dismiss</button></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      '<div class="gs-toolbar"><p class="gs-count">' + esc(countText(data.signedInCount != null ? data.signedInCount : (data.people || []).length)) + '</p>' +
      (canSyncAll ? '<button type="button" class="gs-btn gs-btn-sm" data-action="people-sync-all" data-key="sync-all">Sync everyone who signed in</button>' : '') +
      '<div class="gs-search"><label class="gs-sr" for="people-search">Search accounts</label>' + G.icons.icon('search', 18) +
      '<input class="gs-input gs-input-search" type="search" id="people-search" placeholder="Search accounts" data-input="people-search" autocomplete="off" value="' + esc(opts.query || '') + '"></div>' +
      sortSelectHtml(opts.sort) + '</div>' +
      '<div id="people-table">' + tableHtml({ people: data.people, teams: teams, sort: opts.sort, query: opts.query, now: opts.now, gid: opts.guildData.guild.id }) + '</div>' +
      removedHtml({ removed: data.removed }) + '</section>';
  }

  // ── dialogs ──
  // A role of the Worker's GET /roles list that the guild made itself.
  function isCustomListRole(r) {
    return !!r && typeof r.id === 'string' && (r.kind === 'custom' || (r.kind === undefined && G.peopleSort.isCustomRoleId(r.id)));
  }

  function customCheckHtml(id, role, teamId, checked, label) {
    return '<div class="gs-check"><input type="checkbox" id="' + id + '" name="customRole" data-role="' + esc(role.id) + '" data-team="' + esc(teamId || '') + '"' + (checked ? ' checked' : '') + '>' +
      '<label for="' + id + '">' + esc(label) + '</label></div>';
  }

  // The "Other roles" boxes: the guild's own roles, one box each, or one per active team for a role that is given for a team.
  function customChecksHtml(custom, hand, active) {
    return custom.map(function (role, ri) {
      if (!role.needsTeam) {
        return customCheckHtml('dlg-role-custom-' + ri, role, '', hand.some(function (h) { return h.role === role.id; }), role.name);
      }
      if (!active.length) return '<p class="gs-fine">' + esc(role.name) + ' is given for one team, and there are no active teams.</p>';
      return active.map(function (t, ti) {
        return customCheckHtml('dlg-role-custom-' + ri + '-' + ti, role, t.id, hand.some(function (h) { return h.role === role.id && h.teamId === t.id; }), role.name + ': ' + t.name);
      }).join('');
    }).join('');
  }

  // entry: a person of the people list. customRoles (optional): the guild's own roles from GET /roles (anything else in that list is ignored).
  // The boxes show what an officer set by hand; a role only Discord gives is listed under them, and ticking its box makes it permanent.
  function rolesDialogHtml(entry, teams, guildName, customRoles) {
    const all = G.peopleSort.normalizeRoles(entry.roles);
    const roles = all.filter(function (r) { return !r.fromDiscord; });
    const fromDiscord = all.filter(function (r) { return r.fromDiscord; });
    const isOfficer = roles.some(function (r) { return r.role === 'officer'; });
    const leadIds = roles.filter(function (r) { return r.role === 'team_lead' && r.teamId != null; }).map(function (r) { return r.teamId; });
    const a = entry.actions || {};
    const canEdit = !!a.editRoles;
    const name = entry.person.displayName;
    const active = G.shell.activeTeams(teams);
    const custom = (Array.isArray(customRoles) ? customRoles : []).filter(isCustomListRole);
    const others = custom.length
      ? '<fieldset class="gs-fieldset gs-other-roles"' + (canEdit ? '' : ' disabled') + '><legend class="gs-legend">Other roles</legend>' + customChecksHtml(custom, roles, active) + '</fieldset>'
      : '';
    const discordLine = fromDiscord.length
      ? '<p class="gs-fine gs-from-discord" id="dlg-from-discord">From Discord: ' + esc(fromDiscord.map(function (r) {
        return G.peopleSort.roleLabels([{ role: r.role, name: r.name, teamId: r.teamId }], teams)[0].label;
      }).join(', ')) + '. A role from Discord lasts only while Discord gives it. Tick its box to keep it.</p>'
      : '';
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
    return '<form class="gs-dialog-form" data-submit="roles-form" data-uid="' + esc(entry.person.id) + '"' + (custom.length ? ' data-custom="1"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Edit roles for ' + esc(name) + '</h2>' +
      '<fieldset class="gs-fieldset"' + (canEdit ? '' : ' disabled') + '><legend class="gs-legend">Roles</legend>' + checks + '</fieldset>' + others + discordLine +
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

  // The guild's own roles, from the list the People tab loaded (the whole GET /roles answer, or just its roles).
  function customRolesFor(gid) {
    const v = G.app.state.rolesList ? G.app.state.rolesList[gid] : null;
    const list = Array.isArray(v) ? v : (v && Array.isArray(v.roles) ? v.roles : []);
    return list.filter(isCustomListRole);
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
    G.ui.openDialog(rolesDialogHtml(entry, c.gd.teams, c.gd.guild.name, customRolesFor(c.gid)), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
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

  // ── Discord sync ──
  const SYNC_PROBLEMS = {
    bad_token: 'Discord did not accept the bot\'s token',
    bot_missing: 'the bot is not in your Discord server',
    rate_limited: 'Discord asked for a pause, so try again in a minute',
  };
  const SYNC_LIMIT = 400;

  // sync: the `sync` part of the Sync now answer: { status: 'changed' | 'unchanged' | 'skipped', added, removed }.
  function syncNotice(name, sync) {
    const s = sync || {};
    if (s.status === 'changed') return 'Synced ' + name + ': ' + G.ui.plural(Number(s.added) || 0, 'role', 'roles') + ' added, ' + (Number(s.removed) || 0) + ' removed.';
    if (s.status === 'unchanged') return name + ' already matches Discord.';
    return name + ' was left as is.';
  }

  G.handlers.click['person-sync'] = function (el) {
    const c = ctxGuild();
    if (!c) return;
    const uid = el.getAttribute('data-uid');
    const entry = entryById(c, uid);
    const name = entry ? entry.person.displayName : 'This person';
    el.disabled = true;
    G.api.discord.syncPerson(c.gid, uid).then(function (res) {
      const people = Object.assign({}, res);
      delete people.sync;
      G.app.state.people[c.gid] = people;
      G.app.state.pageAlert = '';
      G.app.state.notice = syncNotice(name, res && res.sync);
      G.app.render();
    }, function (err) {
      el.disabled = false;
      G.app.handleError(err, { pageAlert: true });
    });
  };

  // Sync everyone: the call is repeated with the `next` cursor until it is null; totals add up across the calls.
  function syncAllFrom(gid, totals, after, guard) {
    return G.api.discord.syncAll(gid, after).then(function (res) {
      const r = res || {};
      ['processed', 'changed', 'unchanged', 'skipped', 'failed'].forEach(function (k) { totals[k] += Number(r[k]) || 0; });
      if (r.problem) totals.problem = r.problem;
      if (r.next && !r.problem && r.next !== after && guard < SYNC_LIMIT) return syncAllFrom(gid, totals, r.next, guard + 1);
      return totals;
    });
  }

  function reloadPeople(gid) {
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/people').then(function (res) {
      G.app.state.people[gid] = res;
    }, function () { /* the list stays as it was */ });
  }

  function syncAllNotice(t) {
    let text = 'Synced ' + G.ui.plural(t.processed, 'person', 'people') + ': ' + t.changed + ' changed.';
    if (t.failed > 0) text += ' ' + t.failed + ' could not be read.';
    if (t.problem) text += ' It stopped early: ' + (Object.prototype.hasOwnProperty.call(SYNC_PROBLEMS, t.problem) ? SYNC_PROBLEMS[t.problem] : 'Discord could not be reached') + '.';
    return text;
  }

  G.handlers.click['people-sync-all'] = function (el) {
    const c = ctxGuild();
    if (!c) return;
    const totals = { processed: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, problem: null };
    el.disabled = true;
    syncAllFrom(c.gid, totals, null, 0).then(function () {
      return reloadPeople(c.gid).then(function () {
        G.app.state.pageAlert = '';
        G.app.state.notice = syncAllNotice(totals);
        G.app.render();
      });
    }, function (err) {
      el.disabled = false;
      const done = function () {
        if (totals.processed > 0) G.app.state.notice = syncAllNotice(totals);
        G.app.handleError(err, { pageAlert: true });
      };
      // Whoever was synced before the error is on the list now.
      return totals.processed > 0 ? reloadPeople(c.gid).then(done) : done();
    });
  };

  G.handlers.submit['roles-form'] = function (form) {
    const c = ctxGuild();
    if (!c) return;
    const leadIds = Array.prototype.map.call(form.querySelectorAll('input[name="teamLead"]:checked'), function (i) { return i.value; });
    const body = { officer: !!form.elements.officer.checked, teamLeadTeamIds: leadIds };
    // The guild's own roles are sent only when the dialog listed them; without `roles` the server leaves them as they are.
    if (form.getAttribute && form.getAttribute('data-custom') === '1') {
      body.roles = Array.prototype.map.call(form.querySelectorAll('input[name="customRole"]:checked'), function (box) {
        return { roleId: box.getAttribute('data-role'), teamId: box.getAttribute('data-team') || null };
      });
    }
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
