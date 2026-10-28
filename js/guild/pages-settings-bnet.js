// ── PAGE: GUILD SETTINGS > BATTLE.NET ───────────────────────────
// What the Battle.net guild roster import needs to know about the guild: the in-game guild name when it differs, the realm of a
// ruleset guild (WoW Forever), and names for the ten guild ranks (Battle.net gives rank NUMBERS only; 0 is the guild master).
// GET / PUT /api/guild/:gid/bnet. Needs guild.teams to save; the tab is not shown without it.
// The In-game guild panel above the form (lane B8a-setup, board G0) is where the in-game guild setup starts: not linked, linked (setup goes on) or switched (the roster decides). Its primary
// opens #/g/:gid/setup for the Owner (the Worker's `pinOpen` lets the guild link at all). Once the guild is pinned the guild name and realm below are the pin's: read-only.
(function (G) {
  'use strict';

  const RANK_COUNT = 10;
  const NOTE = 'Battle.net gives guild ranks as numbers only. Name them here and the guild roster import shows your names.';

  function st() { return G.app.state; }
  function xs() { return st().bnetSettings; }
  function plain(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ── the In-game guild panel ──
  // The state: none | linked | ingame | manual (ranks set by hand: nothing to link to). The words come from the facts the answer carries; the date the link was made is not one of them.
  function ingameFact(label, valueHtml, actionHtml) {
    return '<div class="gs-ro-row gs-su-fact"><div class="gs-su-fact-main"><dt class="gs-ro-label">' + esc(label) + '</dt><dd class="gs-ro-value">' + valueHtml + '</dd></div>' + (actionHtml || '') + '</div>';
  }
  function ingameSub(text) { return '<span class="gs-fine gs-su-sub">' + esc(text) + '</span>'; }

  function ingamePanelHtml(gd, d) {
    const setup = G.pages.setup;
    const info = setup.pinInfo(d);
    const guild = gd.guild.name;
    const you = !!(gd.owner && gd.owner.you);
    const zone = gd.guild.timeZone;
    const roster = d.roster || { members: 0, fetchedAt: null };
    const setupHref = G.router.format({ name: 'setup', gid: gd.guild.id });
    let head = '';
    let guildRow;
    if (info.state === 'none') {
      guildRow = 'Not linked yet' + ingameSub(guild + ' follows Discord roles for members and ranks.') + (you && !d.pinOpen ? ingameSub('Linking to the in-game guild is not open for this guild yet.') : '');
      if (you && d.pinOpen) head = G.ui.buttonHtml({ label: 'Set up the in-game guild', variant: 'primary', href: setupHref });
    } else if (info.state === 'manual') {
      guildRow = 'Not used' + ingameSub('Members and ranks are set by hand in this guild.');
    } else {
      const where = esc(setup.pinnedGuildName(d, gd, null) + ' on ' + setup.realmLabel(d, gd));
      guildRow = info.state === 'linked' ? where + ingameSub('Not switched yet: ' + guild + ' still follows Discord roles.') : where + ingameSub('Members and ranks come from the guild roster.');
      if (info.state === 'linked' && you) head = G.ui.buttonHtml({ label: 'Continue setup', variant: 'primary', href: setupHref });
      if (info.state === 'ingame' && G.shell.isGuildMaster(gd.me && gd.me.roles)) head = G.ui.buttonHtml({ label: 'Sync now', attrs: { 'data-action': 'bnet-sync-now', 'data-key': 'bnet-sync-now' } });
    }
    const when = roster.fetchedAt ? G.ui.formatStamp(roster.fetchedAt, zone) : '';
    const rosterRow = roster.members > 0 ? esc(plain(roster.members, 'member', 'members')) + (when ? ingameSub((info.state === 'ingame' ? 'Last checked ' : 'Last read ') + when) : '') : '<span class="gs-muted">Not read yet</span>';
    return '<div class="gs-hd-panel gs-card-sec gs-su-panel" id="bnet-ingame" data-state="' + info.state + '"><div class="gs-card-sec-head"><h2 class="gs-h2">In-game guild</h2>' + head + '</div><dl class="gs-ro-list gs-su-facts">' +
      ingameFact('Guild', guildRow) + ingameFact('Roster', rosterRow) + '</dl></div>';
  }

  // opts: { guildData, data (GET /bnet or null), alert, notice }
  function settingsHtml(opts) {
    const gd = opts.guildData;
    const d = opts.data;
    let body;
    if (!d) {
      body = G.ui.settingsLoadingHtml();
    } else {
      const status = !d.configured
        ? '<p class="gs-warn" id="bnet-set-not-configured" role="status">Battle.net isn\'t set up on this server, so the guild roster import cannot run yet.</p>'
        : (!d.supported ? '<p class="gs-warn" id="bnet-set-unsupported" role="status">' + esc(d.message) + ' You can still fill this in so it is ready when Battle.net adds it.</p>' : '');
      const ruleset = d.realmKind === 'ruleset';
      const pinned = !!(d.pin && d.pin.pinned); // the pin's guild and realm: read-only (the Worker answers 409 pinned for a changed one)
      const editName = d.canEdit && !pinned;
      const labels = (d.rankLabels || []).map(function (label, rank) {
        const id = 'bnet-rank-' + rank;
        return '<div class="gs-field gs-field-inline"><label class="gs-label" for="' + id + '">Rank ' + rank + '</label>' +
          '<input class="gs-input" type="text" id="' + id + '" name="rank' + rank + '" maxlength="24" autocomplete="off" placeholder="' + esc((d.rankDefaults || [])[rank] || '') + '" value="' + esc(label) + '"' + (d.canEdit ? '' : ' disabled') + '></div>';
      }).join('');
      body = status + ingamePanelHtml(gd, d) +
        '<form class="gs-form gs-bnet-form" id="bnet-form" data-submit="bnet-settings" novalidate' + (d.canEdit ? G.ui.dirtyFormAttrs() : '') + '>' +
        '<div class="gs-hd-panel gs-set-body"><div class="gs-field"><label class="gs-label" for="bnet-guild-name">In-game guild name</label>' +
        '<input class="gs-input" type="text" id="bnet-guild-name" name="guildName" maxlength="32" autocomplete="off" placeholder="' + esc(gd.guild.name) + '" value="' + esc(d.guildName || '') + '"' + (editName ? '' : (pinned ? ' readonly' : ' disabled')) + ' data-field="guildName">' +
        '<p class="gs-fine">' + (pinned ? 'The in-game guild this guild is linked to decides this.' : 'Leave empty to use the Raidsmith guild name (' + esc(gd.guild.name) + ').') + '</p><p class="gs-field-error" id="bnet-err-guildName" role="alert" hidden></p></div>' +
        (ruleset
          ? '<div class="gs-field"><label class="gs-label" for="bnet-realm">Realm the guild lives on</label>' +
            '<input class="gs-input" type="text" id="bnet-realm" name="realmSlug" maxlength="50" autocomplete="off" placeholder="old-blanchy" value="' + esc(d.realmSlug || '') + '"' + (editName ? '' : (pinned ? ' readonly' : ' disabled')) + ' data-field="realmSlug">' +
            '<p class="gs-fine">A WoW Forever guild has no realm of its own in Raidsmith. Battle.net looks guilds up by realm, so type the realm\'s name or its URL form.</p><p class="gs-field-error" id="bnet-err-realmSlug" role="alert" hidden></p></div>'
          : '<p class="gs-fine" id="bnet-realm-line">Realm: ' + esc(gd.guild.realm) + ' (' + esc(gd.guild.region) + ')' + (d.realmSlug ? ', Battle.net name <code class="gs-code">' + esc(d.realmSlug) + '</code>' : '') + '.</p>') +
        '<fieldset class="gs-pol-field"><legend class="gs-label">Rank names</legend><p class="gs-fine">' + esc(NOTE) + '</p><div class="gs-bnet-ranks">' + labels + '</div>' +
        '<p class="gs-field-error" id="bnet-err-rankLabels" role="alert" hidden></p></fieldset></div>' +
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
    const body = { rankLabels: labels };
    if (d.pin && d.pin.pinned) return body; // the guild name and realm are the pin's: only the rank names are saved
    body.guildName = form.elements.guildName.value.trim();
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

  // Sync now (POST /roster-sync, the Guild Master's): read the roster again, then the panel shows the new count and time.
  G.handlers.click['bnet-sync-now'] = function (el) {
    const x = xs();
    if (!x || !x.data || (el && el.disabled)) return;
    if (el) el.disabled = true;
    G.api.post('/api/guild/' + encodeURIComponent(x.gid) + '/roster-sync', {}).then(function () { return load(x.gid); }).then(function () {
      const cur = xs();
      if (cur && cur.gid === x.gid) { cur.notice = cur.data.roster && cur.data.roster.members ? 'The guild roster was read again: ' + plain(cur.data.roster.members, 'member', 'members') + '.' : ''; st().pageAlert = ''; }
      G.app.render();
    }, function (err) {
      if (el) el.disabled = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      st().pageAlert = c.text;
      G.app.render();
    });
  };

  G.pages.settingsBnet = { RANK_COUNT: RANK_COUNT, NOTE: NOTE, settingsHtml: settingsHtml, ingamePanelHtml: ingamePanelHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
