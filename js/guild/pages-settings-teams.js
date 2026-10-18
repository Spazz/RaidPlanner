// ── PAGE: GUILD SETTINGS > TEAMS ────────────────────────────────
// Add team (name and raid size), Rename, change the raid Size (10 / 20 / 25 / 40; PATCH /teams/:tid { size }), Archive, Restore. Archived teams are
// listed apart. Buttons show only with guild.teams.
(function (G) {
  'use strict';

  const NOTE = 'Each character is locked to one team. Archived teams keep their history.';

  function leadsText(team) {
    const leads = Array.isArray(team.leads) ? team.leads : [];
    if (!leads.length) return '<span class="gs-muted">No team lead</span>';
    return leads.map(function (p) { return '<span class="gs-lead-name">' + esc(p.displayName) + '</span>'; }).join(', ');
  }

  function activeRow(team, canEdit) {
    const actions = teamActionsHtml(team, canEdit);
    return '<tr><th scope="row" class="gs-cell-strong">' + esc(team.name) + '</th><td>' + esc(team.size) + '-man</td><td>' + esc(team.players == null ? 0 : team.players) + '</td><td>' + leadsText(team) +
      '</td><td><div class="gs-row-actions">' + actions + '</div></td></tr>';
  }

  function teamActionsHtml(team, canEdit) {
    if (!canEdit) return '';
    return '<button type="button" class="gs-btn gs-btn-sm" data-action="team-rename" data-team="' + esc(team.id) + '" data-key="rename-' + esc(team.id) + '" aria-label="Rename ' + esc(team.name) + '">Rename</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="team-size" data-team="' + esc(team.id) + '" data-key="size-' + esc(team.id) + '" aria-label="Change the raid size of ' + esc(team.name) + '">Size</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="team-archive" data-team="' + esc(team.id) + '" data-key="archive-' + esc(team.id) + '" aria-label="Archive ' + esc(team.name) + '">Archive</button>';
  }

  // Phone layout (600 px and below): one card per team, like the People cards.
  function activeCard(team, canEdit) {
    const n = team.players == null ? 0 : team.players;
    return '<li class="gs-team-card"><span class="gs-team-name">' + esc(team.name) + '</span>' +
      '<span class="gs-card-line gs-muted">' + esc(team.size) + '-man - ' + esc(n) + (n === 1 ? ' player' : ' players') + '</span>' +
      '<span class="gs-card-line">' + leadsText(team) + '</span>' +
      '<div class="gs-row-actions">' + teamActionsHtml(team, canEdit) + '</div></li>';
  }

  // Every archived team keeps a way (players counts non-inactive people only, so it can be 0 with characters left) to its roster: the roster page opens it with ?team= in the hash.
  function openRosterLink(team, gid) {
    if (!gid) return '';
    return '<a class="gs-btn gs-btn-sm" href="' + esc(G.router.format({ name: 'section', gid: gid, section: 'roster', team: team.id })) + '" aria-label="Open roster of ' + esc(team.name) + '">Open roster</a>';
  }

  function archivedRow(team, canEdit, gid) {
    const action = openRosterLink(team, gid) + (canEdit
      ? '<button type="button" class="gs-btn gs-btn-sm" data-action="team-restore" data-team="' + esc(team.id) + '" data-key="restore-' + esc(team.id) + '" aria-label="Restore ' + esc(team.name) + '">Restore</button>'
      : '');
    const n = team.players == null ? 0 : team.players;
    return '<li class="gs-archived-item"><span class="gs-cell-strong gs-archived-name">' + esc(team.name) + '</span><span class="gs-muted">' + esc(team.size) + '-man - ' + esc(n) + (n === 1 ? ' player' : ' players') + '</span>' + action + '</li>';
  }

  // opts: { guildData, alert }
  function teamsHtml(opts) {
    const gd = opts.guildData;
    const canEdit = G.shell.hasAction(gd.me && gd.me.can, 'guild.teams');
    const teams = Array.isArray(gd.teams) ? gd.teams : [];
    const active = teams.filter(function (t) { return !t.archived; });
    const archived = teams.filter(function (t) { return t.archived; });
    return '<section class="gs-section" aria-labelledby="teams-heading"><div class="gs-section-head"><h2 class="gs-h2" id="teams-heading">Teams</h2>' +
      (canEdit ? '<button type="button" class="gs-btn" data-action="team-add" data-key="team-add">Add team</button>' : '') + '</div>' +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      (active.length
        ? '<div class="gs-table-wrap gs-teams-table"><table class="gs-table gs-table-teams" aria-label="Teams"><thead><tr><th scope="col">Team</th><th scope="col">Size</th><th scope="col">Players</th><th scope="col">Team Lead</th><th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' +
          active.map(function (t) { return activeRow(t, canEdit); }).join('') + '</tbody></table></div>' +
          '<ul class="gs-team-cards" aria-label="Teams">' + active.map(function (t) { return activeCard(t, canEdit); }).join('') + '</ul>'
        : '<p class="gs-empty">No active teams.' + (canEdit ? ' Add a team to get started.' : '') + '</p>') +
      '<p class="gs-fine">' + esc(NOTE) + '</p>' +
      (archived.length
        ? '<h2 class="gs-h2" id="archived-heading">Archived teams (' + archived.length + ')</h2><div class="gs-panel gs-panel-flush gs-archived-wrap"><ul class="gs-archived" aria-labelledby="archived-heading">' + archived.map(function (t) { return archivedRow(t, canEdit, gd.guild.id); }).join('') + '</ul></div>'
        : '') +
      '</section>';
  }

  // The Raid size select: 10 / 20 / 25 / 40. A team whose stored size is none of those (nothing stopped one before) must pick one before saving.
  function sizeFieldHtml(selected) {
    const known = G.ui.RAID_SIZES.indexOf(selected) >= 0;
    const choices = known ? G.ui.sizeChoices() : [{ value: '', label: 'Choose a size' }].concat(G.ui.sizeChoices());
    return '<div class="gs-field"><label class="gs-label" for="dlg-team-size">Raid size</label>' +
      '<select class="gs-input" id="dlg-team-size" name="size" data-field="size" data-key="dlg-team-size" aria-describedby="dlg-team-size-help">' + G.ui.optionsHtml(choices, known ? selected : '') + '</select>' +
      '<p class="gs-fine" id="dlg-team-size-help">How many players this team\'s raids are for. A raid in a zone with its own size, or one an officer sets, uses that instead.</p>' +
      '<p class="gs-field-error" id="dlg-err-size" role="alert" hidden></p></div>';
  }

  // mode: 'add' (name and size), 'rename' (name), 'size' (size).
  function teamDialogHtml(mode, team, gid, gameVersion) {
    const rename = mode === 'rename';
    const size = mode === 'size';
    const add = !rename && !size;
    return '<form class="gs-dialog-form" data-submit="team-form" data-mode="' + (rename ? 'rename' : size ? 'size' : 'add') + '" data-gid="' + esc(gid) + '"' + (add ? '' : ' data-team="' + esc(team.id) + '"') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (rename ? 'Rename ' + esc(team.name) : size ? 'Raid size of ' + esc(team.name) : 'Add team') + '</h2>' +
      (size ? '' : '<div class="gs-field"><label class="gs-label" for="dlg-team-name">Team name</label>' +
        '<input class="gs-input" type="text" id="dlg-team-name" name="name" autocomplete="off" required value="' + (rename ? esc(team.name) : '') + '">' +
        '<p class="gs-field-error" id="dlg-team-name-error" role="alert" hidden></p></div>') +
      (rename ? '' : sizeFieldHtml(add ? G.ui.defaultTeamSize(gameVersion) : team.size)) +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">' + (add ? 'Add team' : 'Save') + '</button></div></form>';
  }

  function currentGuildData() {
    const s = G.app.state;
    return s.currentGid ? s.guilds[s.currentGid] : null;
  }

  function findTeam(gd, id) {
    return (gd && Array.isArray(gd.teams) ? gd.teams : []).filter(function (t) { return t.id === id; })[0] || null;
  }

  function openTeamDialog(mode, team) {
    const gd = currentGuildData();
    if (!gd) return;
    G.ui.openDialog(teamDialogHtml(mode, team, gd.guild.id, gd.guild.gameVersion), { labelledBy: 'dlg-title' });
    const input = document.getElementById(mode === 'size' ? 'dlg-team-size' : 'dlg-team-name');
    if (input) { input.focus(); if (input.select) input.select(); }
  }

  G.handlers.click['team-add'] = function () { openTeamDialog('add', null); };
  G.handlers.click['team-rename'] = function (el) {
    const team = findTeam(currentGuildData(), el.getAttribute('data-team'));
    if (team) openTeamDialog('rename', team);
  };
  G.handlers.click['team-size'] = function (el) {
    const team = findTeam(currentGuildData(), el.getAttribute('data-team'));
    if (team) openTeamDialog('size', team);
  };
  G.handlers.click['dialog-cancel'] = function (el) { G.ui.closeDialogOf(el); };

  function patchTeam(gid, id, body, onError) {
    return G.api.patch('/api/guild/' + encodeURIComponent(gid) + '/teams/' + encodeURIComponent(id), body).then(function (res) {
      const gd = G.app.state.guilds[gid];
      const team = findTeam(gd, id);
      if (team && res && res.team) Object.assign(team, res.team);
      G.app.state.pageAlert = '';
      G.app.render();
      return true;
    }, function (err) {
      onError(err);
      return false;
    });
  }

  function archiveOrRestore(el, archived) {
    const gd = currentGuildData();
    const id = el.getAttribute('data-team');
    if (!gd || !findTeam(gd, id)) return;
    patchTeam(gd.guild.id, id, { archived: archived }, function (err) {
      G.app.handleError(err, { pageAlert: true });
    });
  }

  G.handlers.click['team-archive'] = function (el) { archiveOrRestore(el, true); };
  G.handlers.click['team-restore'] = function (el) { archiveOrRestore(el, false); };

  G.handlers.submit['team-form'] = function (form) {
    const gid = form.getAttribute('data-gid');
    const mode = form.getAttribute('data-mode');
    const named = mode !== 'size';
    const sized = mode !== 'rename';
    const name = named ? form.elements.name.value.trim() : '';
    const size = sized ? Number(form.elements.size.value) : null;
    G.ui.setText('dlg-team-name-error', '');
    G.ui.setText('dlg-err-size', '');
    G.ui.setText('dlg-error', '');
    if (named && !name) { G.ui.setText('dlg-team-name-error', 'Enter a team name.'); form.elements.name.focus(); return; }
    if (sized && G.ui.RAID_SIZES.indexOf(size) < 0) { G.ui.setText('dlg-err-size', 'Choose a size.'); form.elements.size.focus(); return; }
    const done = function () { G.ui.closeDialogOf(form); };
    // The size the team has already needs no call.
    const current = mode === 'size' ? findTeam(G.app.state.guilds[gid], form.getAttribute('data-team')) : null;
    if (current && current.size === size) { done(); return; }
    G.ui.setBusy(form, true);
    const fail = function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (err.code === 'conflict') { G.ui.closeDialogOf(form); G.app.handleError(err); return; }
      if (c.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (c.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(c.title, c.text); return; }
      if (err.code === 'team_name_taken' && form.elements.name) { G.ui.setText('dlg-team-name-error', c.text); form.elements.name.setAttribute('aria-invalid', 'true'); form.elements.name.focus(); return; }
      if (err.field === 'size' && form.elements.size) { G.ui.setText('dlg-err-size', c.text); form.elements.size.setAttribute('aria-invalid', 'true'); form.elements.size.focus(); return; }
      G.ui.setText('dlg-error', c.text);
    };
    if (mode === 'rename') {
      patchTeam(gid, form.getAttribute('data-team'), { name: name }, fail).then(function (ok) { if (ok) done(); });
    } else if (mode === 'size') {
      patchTeam(gid, form.getAttribute('data-team'), { size: size }, fail).then(function (ok) { if (ok) done(); });
    } else {
      G.api.post('/api/guild/' + encodeURIComponent(gid) + '/teams', { name: name, size: size }).then(function (res) {
        const gd = G.app.state.guilds[gid];
        if (gd && res && res.team) gd.teams.push(Object.assign({ players: 0, leads: [] }, res.team));
        G.app.state.pageAlert = '';
        G.app.render();
        done();
      }, fail);
    }
  };

  G.pages.teams = { NOTE: NOTE, teamsHtml: teamsHtml, teamDialogHtml: teamDialogHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
