// ── PAGE: GUILD SETTINGS > GENERAL ──────────────────────────────
// The guild's name, its realm (a realm guild; a Forever guild has a ruleset instead) and its time zone, edited by the Guild Master alone with PATCH
// /api/guild/:gid (Save bar: Save / Discard; the reply is the whole guild payload). The game version, region, ruleset and Discord server are shown read-only, each
// with the reason: they were chosen when the guild was created and the buff and comp rules, the Battle.net lookups and the sign-in all hang on them.
// An officer who reaches Guild settings reads the same page without fields. The realm field suggests the realms the server sent in /auth/me create.options
// (a list for people who may create guilds; without it the field is plain text, and the Worker accepts any name).
(function (G) {
  'use strict';

  const NAME_MAX = 60;
  const REALM_MAX = 64;
  const ONLY_MASTER = 'Only the Guild Master can change the name, realm or time zone.';
  const ZONE_HELP = 'Changing it changes how times read ("8:00 PM ET" becomes "8:00 PM CT"). Raids keep their moment in time; a team\'s weekly schedule is read in the new zone.';

  function st() { return G.app.state; }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function isMaster(gd) { return G.shell.isGuildMaster(gd.me && gd.me.roles); }

  // The realm names the server listed for this guild's version and region (empty when the viewer was not sent the list).
  function realmSuggestions(guild) {
    const options = st().me && st().me.create && st().me.create.options;
    const byVersion = options && options.realms && options.realms[guild.gameVersion];
    const list = byVersion && byVersion[guild.region];
    return Array.isArray(list) ? list.map(function (r) { return r.name; }) : [];
  }

  function zoneOptions(current) {
    const zones = G.pages.create.allTimeZones();
    const list = zones.indexOf(current) >= 0 ? zones : [current].concat(zones);
    const now = Date.now();
    return list.map(function (z) { return { value: z, label: z + ' (' + G.ui.zoneLabel(z, now) + ')' }; });
  }

  function readOnlyRowHtml(label, value, reason) {
    return '<div class="gs-ro-row"><dt class="gs-ro-label">' + esc(label) + '</dt><dd class="gs-ro-value">' + esc(value) + '</dd>' + (reason ? '<dd class="gs-fine gs-ro-reason">' + esc(reason) + '</dd>' : '') + '</div>';
  }

  // The values that cannot change, each with why. Shown to everyone who opens the page.
  function fixedCardHtml(guild) {
    const ruleset = guild.realmKind === 'ruleset';
    const rows = [
      readOnlyRowHtml('Game version', G.ui.gameVersionLabel(guild.gameVersion), 'The buff and comp rules differ per version. To change it, create a new guild.'),
      readOnlyRowHtml('Region', guild.region, 'Battle.net looks guilds up by region and realm. To change it, create a new guild.'),
    ];
    if (ruleset) rows.push(readOnlyRowHtml('Ruleset', guild.realm, 'A WoW Forever guild lives on a ruleset, chosen when the guild was created. To change it, create a new guild.'));
    if (guild.discordServerId) rows.push(readOnlyRowHtml('Linked Discord server', 'ID ' + guild.discordServerId,
      'Members sign in through this server. The roles it gives are on the Discord roles page.'));
    return '<section class="gs-card-sec gs-hd-panel gs-card-fixed" aria-labelledby="general-fixed-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="general-fixed-h">Set when the guild was created</h2></div>' +
      '<dl class="gs-ro-list">' + rows.join('') + '</dl></section>';
  }

  // The people who may not edit see the three values as text.
  function readOnlyCardHtml(guild) {
    const rows = [readOnlyRowHtml('Guild name', guild.name, ''), guild.realmKind === 'ruleset' ? '' : readOnlyRowHtml('Realm', guild.realm, ''), readOnlyRowHtml('Time zone', guild.timeZone + ' (' + G.ui.zoneLabel(guild.timeZone, Date.now()) + ')', '')];
    return '<section class="gs-card-sec gs-hd-panel" aria-labelledby="general-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="general-h">Guild</h2></div><dl class="gs-ro-list">' + rows.join('') + '</dl>' +
      '<p class="gs-fine" id="general-only-master">' + esc(ONLY_MASTER) + '</p></section>';
  }

  // opts: { guildData, error (a message for the whole form), values ({ name, realm, timeZone } to show instead of the saved ones), errors ({ id: message }) }
  function generalHtml(opts) {
    const gd = opts.guildData;
    const guild = gd.guild;
    if (!isMaster(gd)) return readOnlyCardHtml(guild) + fixedCardHtml(guild);
    const v = Object.assign({ name: guild.name, realm: guild.realm, timeZone: guild.timeZone }, opts.values || {});
    const errors = opts.errors || {};
    const suggestions = realmSuggestions(guild);
    const realmField = guild.realmKind === 'ruleset' ? '' :
      G.ui.fieldHtml({ id: 'general-realm', name: 'realm', label: 'Realm', kind: 'text', value: v.realm, maxlength: REALM_MAX, autocomplete: 'off', required: true,
        help: suggestions.length ? 'Pick a listed realm or type its name.' : 'The realm your guild plays on.', error: errors['general-realm'],
        attrs: suggestions.length ? { list: 'general-realm-list' } : null }) +
      (suggestions.length ? '<datalist id="general-realm-list">' + suggestions.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>' : '');
    const form = '<form class="gs-general-form" id="general-form" data-submit="general-form" novalidate' + G.ui.dirtyFormAttrs() + '>' +
      '<section class="gs-card-sec gs-hd-panel" aria-labelledby="general-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="general-h">Guild</h2></div><div class="gs-card-sec-body">' +
      '<div data-error-summary-slot></div>' +
      G.ui.fieldHtml({ id: 'general-name', name: 'name', label: 'Guild name', kind: 'text', value: v.name, maxlength: NAME_MAX, autocomplete: 'off', required: true,
        help: 'Shown in the sidebar and on the public page.', error: errors['general-name'] }) +
      realmField +
      G.ui.fieldHtml({ id: 'general-zone', name: 'timeZone', label: 'Time zone', kind: 'select', options: zoneOptions(guild.timeZone), selected: v.timeZone, required: true,
        help: ZONE_HELP, error: errors['general-zone'] }) +
      '<p class="gs-alert" id="general-error" role="alert"' + (opts.error ? '' : ' hidden') + '>' + esc(opts.error || '') + '</p></div>' +
      '</section>' + fixedCardHtml(guild) + G.ui.saveBarHtml({}) + '</form>';
    return form;
  }

  function main(r, gd, ctx) {
    return G.shell.settingsFrameHtml(ctx, 'general', generalHtml({ guildData: gd, error: st().pageAlert }));
  }

  // The rules of the form, by field id (the Worker's own limits: 1 to 60 characters of plain text, a realm of 1 to 64, a real time zone).
  function rules(guild) {
    const zones = G.pages.create.allTimeZones();
    return {
      'general-name': function (value) {
        const t = String(value == null ? '' : value).trim();
        if (!t) return 'Enter the guild name.';
        if (Array.from(t).length > NAME_MAX) return 'The name can be at most ' + NAME_MAX + ' characters.';
        return '';
      },
      'general-realm': function (value) {
        if (guild.realmKind === 'ruleset') return '';
        const t = String(value == null ? '' : value).trim();
        if (!t) return 'Enter the realm.';
        if (Array.from(t).length > REALM_MAX) return 'The realm name can be at most ' + REALM_MAX + ' characters.';
        return '';
      },
      'general-zone': function (value) {
        return value && (zones.length === 0 || zones.indexOf(value) >= 0 || value === guild.timeZone) ? '' : 'Pick a time zone.';
      },
    };
  }

  // Only what changed goes to the Worker.
  function bodyOf(guild, form) {
    const body = {};
    const name = String(form.elements.name.value || '').trim();
    if (name !== guild.name) body.name = name;
    if (form.elements.realm) {
      const realm = String(form.elements.realm.value || '').trim();
      if (realm !== guild.realm) body.realm = realm;
    }
    if (form.elements.timeZone.value !== guild.timeZone) body.timeZone = form.elements.timeZone.value;
    return body;
  }

  const FIELD_OF = { name: 'general-name', realm: 'general-realm', timeZone: 'general-zone' };

  G.handlers.submit['general-form'] = function (form) {
    const gd = currentGd();
    if (!gd || !isMaster(gd)) return;
    const guild = gd.guild;
    G.ui.setText('general-error', '');
    const check = G.ui.validateForm(form, rules(guild));
    if (!check.ok) return;
    const body = bodyOf(guild, form);
    if (!Object.keys(body).length) { G.ui.saveBar.bind(form); return; }
    G.ui.setBusy(form, true);
    G.api.patch('/api/guild/' + encodeURIComponent(guild.id), body).then(function (res) {
      st().guilds[guild.id] = res;
      st().pageAlert = '';
      G.app.markSettingsSaved('general');
      // The guild's name is on the switcher and the account menu: read the account's guilds again, then draw.
      return Promise.resolve(G.app.loadMe()).then(function () { G.app.render(); }, function () { G.app.render(); });
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      const id = err && err.field ? FIELD_OF[err.field] : null;
      if (id && form.querySelector('#' + id)) { G.ui.setFieldError(form, id, c.text); G.ui.focusFirstInvalid(form); return; }
      G.ui.setText('general-error', c.text);
    });
  };

  G.pages.settingsGeneral = {
    NAME_MAX: NAME_MAX, REALM_MAX: REALM_MAX, ONLY_MASTER: ONLY_MASTER, ZONE_HELP: ZONE_HELP,
    generalHtml: generalHtml, bodyOf: bodyOf, rules: rules, realmSuggestions: realmSuggestions, main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
