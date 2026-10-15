// ── PAGE: CREATE GUILD (one page) ───────────────────────────────
// Server radios come from /auth/me create.servers; POST /api/guild creates the guild and opens People and roles.
(function (G) {
  'use strict';

  const REGIONS = ['US', 'EU', 'KR', 'TW'];
  const FIELD_IDS = { serverId: 'cg-server', name: 'cg-name', realm: 'cg-realm', region: 'cg-region', timeZone: 'cg-timezone', teamName: 'cg-team' };
  const CREATED_NOTICE = 'Ask your officers and raiders to sign in. Anyone already signed in clicks Sign in again.';

  function browserTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  function allTimeZones() {
    let zones = [];
    try { if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = []; }
    return zones;
  }

  function fieldHtml(id, label, control) {
    return '<div class="gs-field"><label class="gs-label" for="' + id + '">' + label + '</label>' + control +
      '<p class="gs-field-error" id="' + id + '-error" role="alert" hidden></p></div>';
  }

  // opts: { me, timeZones, defaultTimeZone }
  function createHtml(opts) {
    const o = opts || {};
    const create = (o.me && o.me.create) || { allowed: false };
    if (!create.allowed) {
      return G.pages.signin.messageHtml('You cannot create a guild', 'This account is not set up to create a guild. If your guild already exists, open it from the list on the left, or sign in again.');
    }
    const servers = Array.isArray(create.servers) ? create.servers : [];
    const stale = !!create.stale;
    let zones = Array.isArray(o.timeZones) ? o.timeZones.slice() : [];
    const def = o.defaultTimeZone || '';
    if (def && zones.indexOf(def) < 0) zones.unshift(def);
    if (!zones.length) zones = ['UTC'];
    const selectedZone = def || zones[0];

    const serverList = servers.length
      ? '<div class="gs-server-grid">' + servers.map(function (s, i) {
        const id = 'cg-server-' + i;
        return '<label class="gs-server" for="' + id + '"><input type="radio" id="' + id + '" name="serverId" value="' + esc(s.id) + '"' + (i === 0 ? ' checked' : '') + '>' +
          '<span class="gs-server-name">' + esc(s.name) + '</span><span class="gs-badge">' + esc(G.ui.serverAccessLabel(s.access)) + '</span></label>';
      }).join('') + '</div>'
      : '<p class="gs-fine">No servers to list. You need to own or administer a Discord server that does not have a guild yet.</p>';

    const staleBanner = stale
      ? '<p class="gs-alert" role="alert">Sign in again to refresh your server list. <a href="/auth/login">Sign in again</a></p>'
      : '';
    const disabled = stale || !servers.length;

    return '<form class="gs-form" data-submit="create-guild" aria-label="Create a guild" novalidate>' +
      '<div><h1 class="gs-h1" tabindex="-1">Create a guild</h1><p class="gs-lead gs-lead-sm">Pick your guild\'s Discord server. Everyone in that server who signs in becomes a Member.</p></div>' +
      staleBanner +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">Discord server</legend>' + serverList +
      '<p class="gs-field-error" id="cg-server-error" role="alert" hidden></p>' +
      '<p class="gs-fine">Only servers you own or administer are listed.</p></fieldset></div>' +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">Guild</legend><div class="gs-grid">' +
      fieldHtml('cg-name', 'Guild name', '<input class="gs-input" type="text" id="cg-name" name="name" autocomplete="off" required>') +
      fieldHtml('cg-realm', 'Realm', '<input class="gs-input" type="text" id="cg-realm" name="realm" autocomplete="off" required>') +
      fieldHtml('cg-region', 'Region', '<select class="gs-input" id="cg-region" name="region">' + REGIONS.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join('') + '</select>') +
      fieldHtml('cg-timezone', 'Time zone', '<select class="gs-input" id="cg-timezone" name="timeZone">' + zones.map(function (z) { return '<option value="' + esc(z) + '"' + (z === selectedZone ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('') + '</select>') +
      '<div class="gs-field"><span class="gs-label">Game version</span><div class="gs-static"><span class="gs-badge">TBC Anniversary</span></div></div>' +
      '</div></fieldset></div>' +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">First team</legend><div class="gs-grid">' +
      fieldHtml('cg-team', 'Team name', '<input class="gs-input" type="text" id="cg-team" name="teamName" value="Team A" autocomplete="off" required>') +
      '<div class="gs-field"><span class="gs-label">Size</span><div class="gs-static">25-man</div></div>' +
      '</div></fieldset></div>' +
      '<p class="gs-alert" id="cg-form-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="create-guild"' + (disabled ? ' disabled' : '') + '>Create guild</button>' +
      '<a href="#/">Cancel</a><span class="gs-fine">You become this guild\'s Guild Master.</span>' +
      '<a href="/auth/login" id="cg-reauth" hidden>Sign in again</a></div></form>';
  }

  function readForm(form) {
    const checked = form.querySelector('input[name="serverId"]:checked');
    return {
      serverId: checked ? checked.value : '',
      name: form.elements.name.value.trim(),
      realm: form.elements.realm.value.trim(),
      region: form.elements.region.value,
      timeZone: form.elements.timeZone.value,
      teamName: form.elements.teamName.value.trim(),
    };
  }

  function validate(d) {
    const errs = {};
    if (!d.serverId) errs.serverId = 'Pick the Discord server for your guild.';
    if (!d.name) errs.name = 'Enter a guild name.';
    if (!d.realm) errs.realm = 'Enter your realm.';
    if (!d.teamName) errs.teamName = 'Enter a name for the first team.';
    return errs;
  }

  function clearErrors(form) {
    Object.keys(FIELD_IDS).forEach(function (k) {
      G.ui.setText(FIELD_IDS[k] + '-error', '');
      const input = form.querySelector('#' + FIELD_IDS[k]);
      if (input) input.removeAttribute('aria-invalid');
    });
    G.ui.setText('cg-form-error', '');
    G.ui.setText('cg-server-error', '');
    const re = document.getElementById('cg-reauth');
    if (re) re.hidden = true;
  }

  function showFieldError(form, key, text) {
    const id = FIELD_IDS[key];
    if (!id) return false;
    const target = key === 'serverId' ? 'cg-server-error' : id + '-error';
    G.ui.setText(target, text);
    const input = form.querySelector('#' + id);
    if (input) input.setAttribute('aria-invalid', 'true');
    return true;
  }

  G.handlers.submit['create-guild'] = function (form) {
    clearErrors(form);
    const data = readForm(form);
    const errs = validate(data);
    const keys = Object.keys(errs);
    if (keys.length) {
      keys.forEach(function (k) { showFieldError(form, k, errs[k]); });
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    G.ui.setBusy(form, true);
    G.api.post('/api/guild', data).then(function (res) {
      G.app.afterGuildCreated(res, CREATED_NOTICE);
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (err.field && showFieldError(form, err.field, c.text)) return;
      if (err.code === 'server_taken') { showFieldError(form, 'serverId', c.text); return; }
      if (err.code === 'reauth_required') {
        const re = document.getElementById('cg-reauth');
        if (re) re.hidden = false;
      }
      G.ui.setText('cg-form-error', c.text);
    });
  };

  G.pages.create = {
    REGIONS: REGIONS,
    CREATED_NOTICE: CREATED_NOTICE,
    browserTimeZone: browserTimeZone,
    allTimeZones: allTimeZones,
    createHtml: createHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
