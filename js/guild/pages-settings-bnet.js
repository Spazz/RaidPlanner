// ── PAGE: GUILD SETTINGS > BATTLE.NET ───────────────────────────
// What the Battle.net guild roster import needs to know about the guild: the in-game guild name when it differs, the realm of a
// ruleset guild (WoW Forever), and names for the ten guild ranks (Battle.net gives rank NUMBERS only; 0 is the guild master).
// GET / PUT /api/guild/:gid/bnet. Needs guild.teams to save; the tab is not shown without it.
(function (G) {
  'use strict';

  const RANK_COUNT = 10;
  const NOTE = 'Battle.net gives guild ranks as numbers only. Name them here and the guild roster import shows your names.';

  function st() { return G.app.state; }
  function xs() { return st().bnetSettings; }

  // opts: { guildData, data (GET /bnet or null), alert, notice }
  function settingsHtml(opts) {
    const gd = opts.guildData;
    const d = opts.data;
    let body;
    if (!d) {
      body = G.pages.signin.loadingHtml();
    } else {
      const status = !d.configured
        ? '<p class="gs-warn" id="bnet-set-not-configured" role="status">Battle.net isn\'t set up on this server, so the guild roster import cannot run yet.</p>'
        : (!d.supported ? '<p class="gs-warn" id="bnet-set-unsupported" role="status">' + esc(d.message) + ' You can still fill this in so it is ready when Battle.net adds it.</p>' : '');
      const ruleset = d.realmKind === 'ruleset';
      const labels = (d.rankLabels || []).map(function (label, rank) {
        const id = 'bnet-rank-' + rank;
        return '<div class="gs-field gs-field-inline"><label class="gs-label" for="' + id + '">Rank ' + rank + '</label>' +
          '<input class="gs-input" type="text" id="' + id + '" name="rank' + rank + '" maxlength="24" autocomplete="off" placeholder="' + esc((d.rankDefaults || [])[rank] || '') + '" value="' + esc(label) + '"' + (d.canEdit ? '' : ' disabled') + '></div>';
      }).join('');
      body = status +
        '<form class="gs-form gs-bnet-form" id="bnet-form" data-submit="bnet-settings" novalidate' + (d.canEdit ? G.ui.dirtyFormAttrs() : '') + '>' +
        '<div class="gs-field"><label class="gs-label" for="bnet-guild-name">In-game guild name</label>' +
        '<input class="gs-input" type="text" id="bnet-guild-name" name="guildName" maxlength="32" autocomplete="off" placeholder="' + esc(gd.guild.name) + '" value="' + esc(d.guildName || '') + '"' + (d.canEdit ? '' : ' disabled') + ' data-field="guildName">' +
        '<p class="gs-fine">Leave empty to use the Raidsmith guild name (' + esc(gd.guild.name) + ').</p><p class="gs-field-error" id="bnet-err-guildName" role="alert" hidden></p></div>' +
        (ruleset
          ? '<div class="gs-field"><label class="gs-label" for="bnet-realm">Realm the guild lives on</label>' +
            '<input class="gs-input" type="text" id="bnet-realm" name="realmSlug" maxlength="50" autocomplete="off" placeholder="old-blanchy" value="' + esc(d.realmSlug || '') + '"' + (d.canEdit ? '' : ' disabled') + ' data-field="realmSlug">' +
            '<p class="gs-fine">A WoW Forever guild has no realm of its own in Raidsmith. Battle.net looks guilds up by realm, so type the realm\'s name or its URL form.</p><p class="gs-field-error" id="bnet-err-realmSlug" role="alert" hidden></p></div>'
          : '<p class="gs-fine" id="bnet-realm-line">Realm: ' + esc(gd.guild.realm) + ' (' + esc(gd.guild.region) + ')' + (d.realmSlug ? ', Battle.net name <code class="gs-code">' + esc(d.realmSlug) + '</code>' : '') + '.</p>') +
        '<fieldset class="gs-pol-field"><legend class="gs-label">Rank names</legend><p class="gs-fine">' + esc(NOTE) + '</p><div class="gs-bnet-ranks">' + labels + '</div>' +
        '<p class="gs-field-error" id="bnet-err-rankLabels" role="alert" hidden></p></fieldset>' +
        '<p class="gs-alert" id="bnet-form-error" role="alert" hidden></p>' +
        (d.canEdit ? G.ui.saveBarHtml({}) : '<p class="gs-fine">Only people who can edit teams can change these.</p>') +
        '</form>';
    }
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions"></div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  function load(gid) {
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/bnet').then(function (data) {
      st().bnetSettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  function formBody(form, d) {
    const labels = [];
    for (let i = 0; i < RANK_COUNT; i++) labels.push(form.elements['rank' + i] ? form.elements['rank' + i].value : '');
    const body = { guildName: form.elements.guildName.value.trim(), rankLabels: labels };
    if (d.realmKind === 'ruleset' && form.elements.realmSlug) body.realmSlug = form.elements.realmSlug.value.trim();
    return body;
  }

  G.handlers.submit['bnet-settings'] = function (form) {
    const x = xs();
    if (!x || !x.data || !x.data.canEdit) return;
    ['bnet-err-guildName', 'bnet-err-realmSlug', 'bnet-err-rankLabels', 'bnet-form-error'].forEach(function (id) { G.ui.setText(id, ''); });
    G.ui.setBusy(form, true);
    G.api.put('/api/guild/' + encodeURIComponent(x.gid) + '/bnet', formBody(form, x.data)).then(function (res) {
      xs().data = res;
      xs().notice = '';
      G.app.markSettingsSaved('battlenet');
      G.app.render();
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      const sink = err.field && document.getElementById('bnet-err-' + err.field) ? 'bnet-err-' + err.field : 'bnet-form-error';
      G.ui.setText(sink, c.text);
    });
  };

  G.pages.settingsBnet = { RANK_COUNT: RANK_COUNT, NOTE: NOTE, settingsHtml: settingsHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
