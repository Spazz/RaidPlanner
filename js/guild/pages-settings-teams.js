// ── PAGE: GUILD SETTINGS > TEAMS ────────────────────────────────
// Add team, Rename, Archive, Restore. Archived teams are listed apart. Buttons show only with guild.teams.
(function (G) {
  'use strict';

  const NOTE = 'Each character is locked to one team. Archived teams keep their history.';

  function leadsText(team) {
    const leads = Array.isArray(team.leads) ? team.leads : [];
    if (!leads.length) return '<span class="gs-muted">No team lead</span>';
    return leads.map(function (p) { return '<span class="gs-lead-name">' + esc(p.displayName) + '</span>'; }).join(', ');
  }

  function activeRow(team, canEdit) {
    const actions = canEdit
      ? '<button type="button" class="gs-btn gs-btn-sm" data-action="team-rename" data-team="' + esc(team.id) + '" data-key="rename-' + esc(team.id) + '" aria-label="Rename ' + esc(team.name) + '">Rename</button>' +
        '<button type="button" class="gs-btn gs-btn-sm" data-action="team-archive" data-team="' + esc(team.id) + '" data-key="archive-' + esc(team.id) + '" aria-label="Archive ' + esc(team.name) + '">Archive</button>'
      : '';
    return '<tr><th scope="row" class="gs-cell-strong">' + esc(team.name) + '</th><td>' + esc(team.size) + '-man</td><td>' + esc(team.players == null ? 0 : team.players) + '</td><td>' + leadsText(team) +
      '</td><td><div class="gs-row-actions">' + actions + '</div></td></tr>';
  }

  function archivedRow(team, canEdit) {
    const action = canEdit
      ? '<button type="button" class="gs-btn gs-btn-sm" data-action="team-restore" data-team="' + esc(team.id) + '" data-key="restore-' + esc(team.id) + '" aria-label="Restore ' + esc(team.name) + '">Restore</button>'
      : '';
    return '<li class="gs-archived-item"><span class="gs-cell-strong">' + esc(team.name) + '</span><span class="gs-muted">' + esc(team.size) + '-man</span>' + action + '</li>';
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
        ? '<div class="gs-table-wrap"><table class="gs-table gs-table-teams" aria-label="Teams"><thead><tr><th scope="col">Team</th><th scope="col">Size</th><th scope="col">Players</th><th scope="col">Team Lead</th><th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' +
          active.map(function (t) { return activeRow(t, canEdit); }).join('') + '</tbody></table></div>'
        : '<p class="gs-empty">No active teams.' + (canEdit ? ' Add a team to get started.' : '') + '</p>') +
      '<p class="gs-fine">' + esc(NOTE) + '</p>' +
      (archived.length
        ? '<h2 class="gs-h2" id="archived-heading">Archived teams (' + archived.length + ')</h2><div class="gs-panel gs-panel-flush"><ul class="gs-archived" aria-labelledby="archived-heading">' + archived.map(function (t) { return archivedRow(t, canEdit); }).join('') + '</ul></div>'
        : '') +
      '</section>';
  }

  function teamDialogHtml(mode, team, gid) {
    const rename = mode === 'rename';
    return '<form class="gs-dialog-form" data-submit="team-form" data-mode="' + (rename ? 'rename' : 'add') + '" data-gid="' + esc(gid) + '"' + (rename ? ' data-team="' + esc(team.id) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (rename ? 'Rename ' + esc(team.name) : 'Add team') + '</h2>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-team-name">Team name</label>' +
      '<input class="gs-input" type="text" id="dlg-team-name" name="name" autocomplete="off" required value="' + (rename ? esc(team.name) : '') + '">' +
      '<p class="gs-field-error" id="dlg-team-name-error" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">' + (rename ? 'Save' : 'Add team') + '</button></div></form>';
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
    G.ui.openDialog(teamDialogHtml(mode, team, gd.guild.id), { labelledBy: 'dlg-title' });
    const input = document.getElementById('dlg-team-name');
    if (input) { input.focus(); input.select(); }
  }

  G.handlers.click['team-add'] = function () { openTeamDialog('add', null); };
  G.handlers.click['team-rename'] = function (el) {
    const team = findTeam(currentGuildData(), el.getAttribute('data-team'));
    if (team) openTeamDialog('rename', team);
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
    const name = form.elements.name.value.trim();
    G.ui.setText('dlg-team-name-error', '');
    G.ui.setText('dlg-error', '');
    if (!name) { G.ui.setText('dlg-team-name-error', 'Enter a team name.'); form.elements.name.focus(); return; }
    G.ui.setBusy(form, true);
    const done = function () { G.ui.closeDialogOf(form); };
    const fail = function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (c.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(c.title, c.text); return; }
      if (err.code === 'team_name_taken') { G.ui.setText('dlg-team-name-error', c.text); form.elements.name.setAttribute('aria-invalid', 'true'); form.elements.name.focus(); return; }
      G.ui.setText('dlg-error', c.text);
    };
    if (mode === 'rename') {
      patchTeam(gid, form.getAttribute('data-team'), { name: name }, fail).then(function (ok) { if (ok) done(); });
    } else {
      G.api.post('/api/guild/' + encodeURIComponent(gid) + '/teams', { name: name }).then(function (res) {
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
