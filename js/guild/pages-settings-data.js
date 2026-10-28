// -- PAGE: GUILD SETTINGS > GUILD DATA ---------------------------
// The Guild Master's two guild-wide actions (Phase 8): a copy of the guild's data as one JSON file, and deleting the guild (type its name to confirm).
// GET /api/guild/:gid/export is a plain download link (the browser sends the session cookie); DELETE /api/guild/:gid takes { confirmName }.
// Only the Guild Master gets the tab; anyone else who types the address is told so, and the Worker answers 403 to them anyway.
(function (G) {
  'use strict';

  const EXPORT_TEXT = 'Download a copy of the guild as one JSON file: the roster, the notes you are allowed to read, raids, attendance and loot.';
  const EXPORT_LEAVES_OUT = 'The file leaves out Discord IDs and names, accounts and role assignments, Battle.net data, guest and calendar links, and notes you cannot read.';
  const DELETE_TEXT = 'Deleting the guild removes it and everything in it for good: the roster, raids, attendance, loot, roles, guest links and the public page. Members keep their accounts. This cannot be undone.';

  function st() { return G.app.state; }

  function isGuildMaster(gd) {
    const roles = gd && gd.me && Array.isArray(gd.me.roles) ? gd.me.roles : [];
    return roles.some(function (r) { return r && r.role === 'guild_master'; });
  }

  // opts: { guildData, alert }
  function dataHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    let body;
    if (!isGuildMaster(gd)) {
      body = '<p class="gs-fine" id="gdata-gm-only">Only the Guild Master can export or delete the guild.</p>';
    } else {
      body = '<div class="gs-panel gs-hd-panel gs-gdata-card" aria-labelledby="gdata-export-h"><h3 class="gs-h3" id="gdata-export-h">Export guild data</h3>' +
        '<p>' + esc(EXPORT_TEXT) + '</p><p class="gs-fine">' + esc(EXPORT_LEAVES_OUT) + '</p>' +
        '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.api.guildData.exportUrl(gid)) + '" download data-key="gdata-export">Download guild data</a></div></div>' +
        '<div class="gs-panel gs-hd-panel gs-gdata-card gs-gdata-danger" aria-labelledby="gdata-delete-h"><h3 class="gs-h3" id="gdata-delete-h">Delete this guild</h3>' +
        '<p>' + esc(DELETE_TEXT) + '</p><p class="gs-fine">Download the data first if you want a copy.</p>' +
        '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-danger-outline" data-action="guild-delete-open" data-key="guild-delete">Delete ' + esc(gd.guild.name) + '...</button></div></div>';
    }
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions"></div>' +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  function deleteDialogHtml(guildName) {
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="guild-delete-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Delete ' + esc(guildName) + '?</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(DELETE_TEXT) + ' Type the guild name to confirm.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-confirm">Guild name</label>' +
      '<input class="gs-input" type="text" id="dlg-confirm" name="confirmName" data-field="confirmName" autocomplete="off" spellcheck="false" aria-describedby="dlg-help dlg-err-confirmName">' +
      '<p class="gs-field-error" id="dlg-err-confirmName" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button>' +
      '<button type="submit" class="gs-btn gs-btn-danger">Delete guild</button></div></form>';
  }

  function main(r, gd, ctx) {
    return G.shell.settingsFrameHtml(ctx, 'data', dataHtml({ guildData: gd, alert: st().pageAlert }));
  }

  // -- behaviour --
  function currentGuild() {
    const s = st();
    return s.currentGid ? s.guilds[s.currentGid] : null;
  }

  G.handlers.click['guild-delete-open'] = function () {
    const gd = currentGuild();
    if (!gd || !isGuildMaster(gd)) return;
    G.ui.openDialog(deleteDialogHtml(gd.guild.name), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.submit['guild-delete-form'] = function (form) {
    const gd = currentGuild();
    if (!gd) return;
    G.ui.setText('dlg-error', '');
    G.ui.setText('dlg-err-confirmName', '');
    const typed = form.elements.confirmName ? String(form.elements.confirmName.value) : '';
    // The Owner is asked to sign in again first (403 fresh_required, purpose guild_delete): the dialog's second step, with the typed name kept for the repeat.
    G.fresh.runDialog(form, G.api.guildData.remove(gd.guild.id, typed), {
      gid: gd.guild.id, act: { kind: 'guild_delete', data: { confirmName: typed } }, stepLabel: 'Delete guild - step 2 of 2', primaryLabel: 'Sign in and delete',
      returnTo: G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'data' }),
    }, function () {
      G.app.afterGuildDeleted(gd.guild.id);
    });
  };

  // Repeats after the fresh sign-in (#/fresh?done=guild_delete): the delete with the name the person typed, then the start page.
  G.fresh.registerAct('guild_delete', function (act) {
    const name = act.data && typeof act.data.confirmName === 'string' ? act.data.confirmName : '';
    return G.api.guildData.remove(act.gid, name).then(function () { return G.app.forgetGuild(act.gid); }).then(function () { return '#/'; });
  });

  G.pages.settingsData = { EXPORT_TEXT: EXPORT_TEXT, EXPORT_LEAVES_OUT: EXPORT_LEAVES_OUT, DELETE_TEXT: DELETE_TEXT, isGuildMaster: isGuildMaster, dataHtml: dataHtml, deleteDialogHtml: deleteDialogHtml, main: main };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
