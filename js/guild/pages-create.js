// ── PAGE: CREATE GUILD (one page) ───────────────────────────────
// Server radios come from /auth/me create.servers; POST /api/guild creates the guild and opens People and roles.
(function (G) {
  'use strict';

  const REGIONS = ['US', 'EU', 'KR', 'TW'];
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

  // Guilds on the viewer's servers that have no Guild Master: /auth/me create.claimable.
  function claimableList(me) {
    const c = me && me.create && me.create.claimable;
    return Array.isArray(c) ? c : [];
  }

  function claimHtml(claimable) {
    if (!claimable.length) return '';
    return '<section class="gs-claim" aria-labelledby="claim-heading"><h2 class="gs-h2" id="claim-heading">Guilds without a Guild Master</h2>' +
      '<p class="gs-fine">You manage the Discord server of each guild below. Claim a guild to become its Guild Master.</p>' +
      '<ul class="gs-claim-list">' + claimable.map(function (g, i) {
        const cid = 'claim-confirm-' + i;
        return '<li class="gs-claim-item"><div class="gs-claim-main"><div class="gs-claim-text"><span class="gs-claim-guild">' + esc(g.guildName) + '</span>' +
          '<span class="gs-claim-server gs-muted">' + esc(g.serverName) + '</span></div>' +
          G.ui.buttonHtml({ label: 'Claim', ariaLabel: 'Claim ' + g.guildName, attrs: { 'data-action': 'claim-ask', 'data-key': 'claim-' + g.guildId, 'aria-expanded': 'false', 'aria-controls': cid } }) + '</div>' +
          '<div class="gs-claim-confirm" id="' + cid + '" role="group" aria-label="Confirm claiming ' + esc(g.guildName) + '" hidden>' +
          '<p class="gs-confirm-text">You become Guild Master of ' + esc(g.guildName) + '.</p>' +
          // The page's one primary is Create guild below; this confirm step is a secondary.
          '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Claim ' + g.guildName, attrs: { 'data-action': 'claim-go', 'data-gid': g.guildId, 'data-name': g.guildName } }) +
          G.ui.buttonHtml({ label: 'Cancel', variant: 'ghost', attrs: { 'data-action': 'claim-cancel' } }) + '</div></div></li>';
      }).join('') + '</ul></section>';
  }

  const OTHER_VALUE = '__other__';
  const OTHER_LABEL = 'Other (type it)';
  const MAX_TEAMS = 10;
  const MIN_SEVERAL = 2;
  const TEAM_NAME_MAX = 40;
  const NO_REALMS_HINT = 'No TBC Anniversary realms in this region.';
  const ONE_TEAM_HELP = 'We\'ll set up one team for you. You can add more later in Guild settings.';

  // The version / region / realm data the server sent in /auth/me create.options (set by createHtml).
  let createOptions = { versions: [], regions: REGIONS, realms: {}, rulesets: [] };

  function readOptions(create) {
    const o = (create && create.options) || {};
    return {
      versions: Array.isArray(o.versions) ? o.versions : [],
      regions: Array.isArray(o.regions) && o.regions.length ? o.regions : REGIONS,
      realms: o.realms && typeof o.realms === 'object' ? o.realms : {},
      rulesets: Array.isArray(o.rulesets) ? o.rulesets : [],
    };
  }

  function realmList(version, region) {
    const byRegion = createOptions.realms[version];
    const list = byRegion && byRegion[region];
    return Array.isArray(list) ? list : [];
  }

  function optionHtml(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  // The realm (or ruleset) controls for a version + region. state: { choice, other }. These sit directly in the
  // Guild grid (the host uses display: contents), so a re-render only swaps this block.
  function realmFieldsHtml(version, region, state) {
    const st = state || {};
    if (version === 'forever') {
      const choice = createOptions.rulesets.indexOf(st.choice) >= 0 ? st.choice : (createOptions.rulesets[0] || '');
      return fieldHtml('cg-realm', 'Ruleset', '<select class="gs-input" id="cg-realm" name="realm" data-change="cg-realm-refresh">' +
        createOptions.rulesets.map(function (r) { return optionHtml(r, r, r === choice); }).join('') + '</select>');
    }
    const list = realmList(version, region);
    const names = list.map(function (r) { return r.name; });
    const choice = (st.choice === OTHER_VALUE || names.indexOf(st.choice) >= 0) ? st.choice : (names[0] || OTHER_VALUE);
    const showOther = choice === OTHER_VALUE;
    const options = list.map(function (r) { return optionHtml(r.name, r.type ? r.name + ' - ' + r.type : r.name, r.name === choice); }).join('') +
      optionHtml(OTHER_VALUE, OTHER_LABEL, showOther);
    const hint = (!list.length && version === 'tbc') ? '<p class="gs-fine gs-realm-hint" id="cg-realm-hint">' + esc(NO_REALMS_HINT) + '</p>' : '';
    const select = fieldHtml('cg-realm', 'Realm', '<select class="gs-input" id="cg-realm" name="realm" data-change="cg-realm-refresh"' + (hint ? ' aria-describedby="cg-realm-hint"' : '') + '>' + options + '</select>' + hint);
    const other = showOther
      ? fieldHtml('cg-realm-other', 'Realm name', '<input class="gs-input" type="text" id="cg-realm-other" name="realmOther" value="' + esc(st.other || '') + '" maxlength="64" autocomplete="off" required>')
      : '';
    return select + other;
  }

  function teamFieldHtml(index, value) {
    const n = index + 1;
    const id = 'cg-team-' + index;
    const input = '<input class="gs-input" type="text" id="' + id + '" name="teamName" value="' + esc(value) + '" maxlength="' + TEAM_NAME_MAX + '" autocomplete="off" required>';
    const remove = index >= MIN_SEVERAL
      ? G.ui.buttonHtml({ label: 'Remove', size: 'sm', ariaLabel: 'Remove team ' + n, attrs: { 'data-action': 'cg-team-remove', 'data-index': String(index), 'data-key': 'cg-team-remove-' + index } })
      : '';
    const control = remove ? '<div class="gs-team-row">' + input + remove + '</div>' : input;
    return fieldHtml(id, 'Team ' + n + ' name', control);
  }

  // The block under the "more than one team" radios. names: the team name fields' current values.
  function teamsFieldsHtml(multiple, names) {
    if (!multiple) return '<p class="gs-fine" id="cg-one-team-help">' + esc(ONE_TEAM_HELP) + '</p>';
    const values = Array.isArray(names) ? names.slice() : [];
    while (values.length < MIN_SEVERAL) values.push('');
    const add = values.length < MAX_TEAMS
      ? G.ui.buttonHtml({ label: 'Add another team', attrs: { 'data-action': 'cg-team-add', 'data-key': 'cg-team-add' } })
      : '';
    return '<div class="gs-grid">' + values.map(function (v, i) { return teamFieldHtml(i, v); }).join('') + '</div>' +
      '<p class="gs-field-error" id="cg-teams-error" role="alert" hidden></p>' +
      '<div class="gs-team-tools">' + add + '<span class="gs-fine">All teams are 25-man.</span></div>';
  }

  function teamsRadioHtml(multiple) {
    function card(id, value, label, checked) {
      return '<label class="gs-server" for="' + id + '"><input type="radio" id="' + id + '" name="multipleTeams" value="' + value + '"' + (checked ? ' checked' : '') + ' data-change="cg-teams-refresh">' +
        '<span class="gs-server-name">' + esc(label) + '</span></label>';
    }
    return '<span class="gs-label" id="cg-teams-q">Does your guild run more than one raid team?</span>' +
      '<div class="gs-server-grid" role="radiogroup" aria-labelledby="cg-teams-q">' +
      card('cg-teams-one', 'one', 'No, one team', !multiple) + card('cg-teams-many', 'many', 'Yes, several teams', multiple) + '</div>';
  }

  // Why /auth/me create.allowed is false, in words. create.reason: needs_discord (a Battle.net-only account), reauth (the server list from the sign-in
  // expired), no_server (no Discord server the account owns or administers is free); anything else (not_approved, or an older answer) is the plain refusal.
  function cannotCreateHtml(create) {
    const reason = create && create.reason;
    const signin = G.pages.signin;
    if (reason === 'needs_discord') {
      return signin.messageHtml('Connect Discord to create a guild', 'A guild belongs to a Discord server, so creating one needs a Discord sign-in. Connect Discord to this account, then come back.',
        { actionsHtml: G.ui.buttonHtml({ label: 'Connect Discord', variant: 'primary', href: '#/linked', attrs: { 'data-key': 'create-connect-discord' } }) });
    }
    if (reason === 'reauth') {
      return signin.messageHtml('Sign in again to find your servers', 'Raidsmith looks at the Discord servers you manage when you sign in, and keeps that list for half an hour. Sign in with Discord again to create a guild.',
        { actionsHtml: G.ui.buttonHtml({ label: 'Sign in with Discord', variant: 'primary', href: '/auth/login' }) });
    }
    if (reason === 'no_server') {
      return signin.messageHtml('No Discord server to create a guild for', 'You can create a guild for a Discord server you own or administer (Administrator or Manage Server) that has no guild yet. Raidsmith found none on your account. If you were just given those rights, sign in again.',
        { actionsHtml: G.ui.buttonHtml({ label: 'Sign in again', href: '/auth/login' }) });
    }
    return signin.messageHtml('You cannot create a guild', 'This account is not set up to create a guild. If your guild already exists, open it from the list on the left, or sign in again.');
  }

  // opts: { me, timeZones, defaultTimeZone, alert }
  function createHtml(opts) {
    const o = opts || {};
    const create = (o.me && o.me.create) || { allowed: false };
    if (!create.allowed) return cannotCreateHtml(create);
    createOptions = readOptions(create);
    const claim = claimHtml(claimableList(o.me));
    const alertHtml = o.alert ? G.ui.alertHtml(o.alert, 'gs-page-alert') : '';
    const servers = Array.isArray(create.servers) ? create.servers : [];
    const stale = !!create.stale;
    let zones = Array.isArray(o.timeZones) ? o.timeZones.slice() : [];
    const def = o.defaultTimeZone || '';
    if (def && zones.indexOf(def) < 0) zones.unshift(def);
    if (!zones.length) zones = ['UTC'];
    const selectedZone = def || zones[0];
    const versions = createOptions.versions;
    const firstVersion = versions.length ? versions[0].key : 'tbc';
    const firstRegion = createOptions.regions[0] || 'US';

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
    // One account may create a limited number of guilds (create.limit: { created, max }); at the limit the form stays but cannot be sent.
    const limit = create.limit && typeof create.limit === 'object' ? create.limit : null;
    const atLimit = !!limit && limit.created >= limit.max;
    const limitBanner = atLimit
      ? '<p class="gs-alert" id="cg-limit" role="alert">You have created ' + esc(limit.created) + ' guilds, the most one account can. Delete a guild you no longer use (Guild settings, Guild data) to make room.</p>'
      : '';
    const disabled = stale || !servers.length || atLimit;

    return alertHtml + claim + '<form class="gs-form" data-submit="create-guild" aria-label="Create a guild" novalidate>' +
      '<div><h1 class="gs-h1" tabindex="-1">Create a guild</h1><p class="gs-lead gs-lead-sm">Pick your guild\'s Discord server. Everyone in that server who signs in becomes a Member.</p></div>' +
      staleBanner + limitBanner +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">Discord server</legend>' + serverList +
      '<p class="gs-field-error" id="cg-server-error" role="alert" hidden></p>' +
      '<p class="gs-fine">Only servers you own or administer are listed.</p></fieldset></div>' +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">Guild</legend><div class="gs-grid">' +
      fieldHtml('cg-version', 'Game version', '<select class="gs-input" id="cg-version" name="gameVersion" data-change="cg-realm-refresh">' +
        versions.map(function (v) { return optionHtml(v.key, v.label, v.key === firstVersion); }).join('') + '</select>') +
      fieldHtml('cg-region', 'Region', '<select class="gs-input" id="cg-region" name="region" data-change="cg-realm-refresh">' +
        createOptions.regions.map(function (r) { return optionHtml(r, r, r === firstRegion); }).join('') + '</select>') +
      '<div class="gs-realm-host" id="cg-realm-host">' + realmFieldsHtml(firstVersion, firstRegion, {}) + '</div>' +
      fieldHtml('cg-name', 'Guild name', '<input class="gs-input" type="text" id="cg-name" name="name" autocomplete="off" required>') +
      fieldHtml('cg-timezone', 'Time zone', '<select class="gs-input" id="cg-timezone" name="timeZone">' + zones.map(function (z) { return '<option value="' + esc(z) + '"' + (z === selectedZone ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('') + '</select>') +
      '</div></fieldset></div>' +
      '<div class="gs-panel"><fieldset class="gs-fieldset"><legend class="gs-legend">Raid teams</legend>' +
      '<div class="gs-teams-q">' + teamsRadioHtml(false) + '</div>' +
      '<div class="gs-teams-host" id="cg-teams-host">' + teamsFieldsHtml(false, []) + '</div>' +
      '</fieldset></div>' +
      '<p class="gs-alert" id="cg-form-error" role="alert" hidden></p>' +
      '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Create guild', variant: 'primary', type: 'submit', disabled: !!disabled, attrs: { 'data-key': 'create-guild' } }) +
      G.ui.buttonHtml({ label: 'Cancel', variant: 'ghost', href: '#/' }) + '<span class="gs-fine">You become this guild\'s Guild Master.</span>' +
      '<a href="/auth/login" id="cg-reauth" hidden>Sign in again</a></div></form>';
  }

  function teamInputs(form) {
    return Array.prototype.slice.call(form.querySelectorAll('input[name="teamName"]'));
  }

  function isMultiple(form) {
    const checked = form.querySelector('input[name="multipleTeams"]:checked');
    return !!checked && checked.value === 'many';
  }

  function readForm(form) {
    const checked = form.querySelector('input[name="serverId"]:checked');
    const version = form.elements.gameVersion.value;
    const choice = form.elements.realm ? form.elements.realm.value : '';
    const typed = form.elements.realmOther ? form.elements.realmOther.value.trim() : '';
    const multipleTeams = isMultiple(form);
    const data = {
      serverId: checked ? checked.value : '',
      gameVersion: version,
      region: form.elements.region.value,
      realm: version !== 'forever' && choice === OTHER_VALUE ? typed : choice,
      name: form.elements.name.value.trim(),
      timeZone: form.elements.timeZone.value,
      multipleTeams: multipleTeams,
    };
    if (multipleTeams) data.teamNames = teamInputs(form).map(function (i) { return i.value.trim(); });
    return data;
  }

  // -> { key: message }. Team name errors are keyed 'teamNames:<index>'.
  function validate(d) {
    const errs = {};
    if (!d.serverId) errs.serverId = 'Pick the Discord server for your guild.';
    if (!d.gameVersion) errs.gameVersion = 'Pick a game version.';
    if (!d.realm) errs.realm = d.gameVersion === 'forever' ? 'Pick a ruleset.' : 'Enter your realm.';
    else if (d.gameVersion !== 'forever' && Array.from(d.realm).length > 64) errs.realm = 'The realm name can be at most 64 characters.';
    if (!d.name) errs.name = 'Enter a guild name.';
    if (d.multipleTeams) {
      const seen = {};
      d.teamNames.forEach(function (n, i) {
        const key = 'teamNames:' + i;
        if (!n) { errs[key] = 'Enter a name for team ' + (i + 1) + '.'; return; }
        if (Array.from(n).length > TEAM_NAME_MAX) { errs[key] = 'Team names can be at most ' + TEAM_NAME_MAX + ' characters.'; return; }
        if (seen[n.toLowerCase()]) { errs[key] = 'Each team needs a different name.'; return; }
        seen[n.toLowerCase()] = true;
      });
    }
    return errs;
  }

  // An error key -> [inputId, errorId] of the elements it marks, or null.
  function errorTarget(form, key) {
    if (key === 'serverId') return ['', 'cg-server-error'];
    if (key === 'gameVersion') return ['cg-version', 'cg-version-error'];
    if (key === 'region') return ['cg-region', 'cg-region-error'];
    if (key === 'name') return ['cg-name', 'cg-name-error'];
    if (key === 'timeZone') return ['cg-timezone', 'cg-timezone-error'];
    if (key === 'realm') {
      return form.querySelector('#cg-realm-other') ? ['cg-realm-other', 'cg-realm-other-error'] : ['cg-realm', 'cg-realm-error'];
    }
    if (key === 'teamNames') return ['', 'cg-teams-error'];
    const m = /^teamNames:(\d+)$/.exec(key);
    if (m) return ['cg-team-' + m[1], 'cg-team-' + m[1] + '-error'];
    return null;
  }

  function clearErrors(form) {
    Array.prototype.forEach.call(form.querySelectorAll('.gs-field-error'), function (p) { G.ui.setText(p.id, ''); });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    G.ui.setText('cg-form-error', '');
    const re = document.getElementById('cg-reauth');
    if (re) re.hidden = true;
  }

  function showFieldError(form, key, text) {
    const target = errorTarget(form, key);
    if (!target) return false;
    if (!document.getElementById(target[1])) return false;
    G.ui.setText(target[1], text);
    const input = target[0] ? form.querySelector('#' + target[0]) : null;
    if (input) input.setAttribute('aria-invalid', 'true');
    return true;
  }

  // The realm block re-renders when the version, region or realm choice changes; typed text is kept.
  G.handlers.change['cg-realm-refresh'] = function (el) {
    const form = el.closest('form');
    const host = form && form.querySelector('#cg-realm-host');
    if (!host) return;
    const realmEl = form.elements.realm;
    const otherEl = form.elements.realmOther;
    host.innerHTML = realmFieldsHtml(form.elements.gameVersion.value, form.elements.region.value, {
      choice: realmEl ? realmEl.value : '',
      other: otherEl ? otherEl.value : '',
    });
    if (el.id === 'cg-realm') {
      const other = form.querySelector('#cg-realm-other');
      if (other) other.focus();
    }
  };

  function renderTeams(form, multiple, names, focusIndex) {
    const host = form.querySelector('#cg-teams-host');
    if (!host) return;
    host.innerHTML = teamsFieldsHtml(multiple, names);
    if (typeof focusIndex === 'number') {
      const input = form.querySelector('#cg-team-' + focusIndex);
      if (input) input.focus();
    }
  }

  G.handlers.change['cg-teams-refresh'] = function (el) {
    const form = el.closest('form');
    if (!form) return;
    renderTeams(form, isMultiple(form), teamInputs(form).map(function (i) { return i.value; }));
  };

  G.handlers.click['cg-team-add'] = function (el) {
    const form = el.closest('form');
    if (!form) return;
    const names = teamInputs(form).map(function (i) { return i.value; });
    if (names.length >= MAX_TEAMS) return;
    names.push('');
    renderTeams(form, true, names, names.length - 1);
  };

  G.handlers.click['cg-team-remove'] = function (el) {
    const form = el.closest('form');
    const index = parseInt(el.getAttribute('data-index'), 10);
    if (!form || !(index >= MIN_SEVERAL)) return;
    const names = teamInputs(form).map(function (i) { return i.value; });
    names.splice(index, 1);
    renderTeams(form, true, names, Math.min(index, names.length - 1));
  };

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
      if (err.code === 'conflict') { G.app.handleError(err); return; }
      if (err.field === 'teamNames' && typeof err.index === 'number' && showFieldError(form, 'teamNames:' + err.index, c.text)) return;
      if (err.field && showFieldError(form, err.field, c.text)) return;
      if (err.code === 'server_taken') { showFieldError(form, 'serverId', c.text); return; }
      if (err.code === 'reauth_required') {
        const re = document.getElementById('cg-reauth');
        if (re) re.hidden = false;
      }
      G.ui.setText('cg-form-error', c.text);
    });
  };

  G.handlers.click['claim-ask'] = function (el) {
    const item = el.closest('.gs-claim-item');
    const box = item && item.querySelector('.gs-claim-confirm');
    if (!box) return;
    box.hidden = false;
    el.hidden = true;
    const first = box.querySelector('button');
    if (first) first.focus();
  };

  G.handlers.click['claim-cancel'] = function (el) {
    const item = el.closest('.gs-claim-item');
    if (!item) return;
    const box = item.querySelector('.gs-claim-confirm');
    const ask = item.querySelector('[data-action="claim-ask"]');
    if (box) box.hidden = true;
    if (ask) { ask.hidden = false; ask.focus(); }
  };

  G.handlers.click['claim-go'] = function (el) {
    if (el.disabled) return;
    const gid = el.getAttribute('data-gid');
    const name = el.getAttribute('data-name') || '';
    const box = el.closest('.gs-claim-confirm');
    const btns = box ? box.querySelectorAll('button') : [el];
    for (let i = 0; i < btns.length; i++) btns[i].disabled = true;
    G.api.post('/api/guild/' + encodeURIComponent(gid) + '/claim', {}).then(function (res) {
      G.app.afterGuildClaimed(res, name);
    }, function (err) {
      for (let i = 0; i < btns.length; i++) btns[i].disabled = false;
      // 403 claim_closed: the guild takes its Guild Master from the in-game roster, so a server administrator cannot claim it. The Worker's sentence says who can; the way on is that claim.
      if (err && err.code === 'claim_closed' && box) { showClaimClosed(box, gid, err.message); return; }
      G.app.handleError(err, { pageAlert: true });
    });
  };

  // The claim box after claim_closed: the Worker's sentence and the claim an in-game Guild Master makes with Battle.net (purpose gm_claim; the callback decides, #/fresh answers).
  function showClaimClosed(box, gid, message) {
    box.innerHTML = '<p class="gs-fine" id="claim-closed-text" role="alert">' + esc(message) + '</p><div class="gs-actions">' +
      G.ui.buttonHtml({ label: 'Claim with Battle.net', attrs: { 'data-action': 'claim-gm-start', 'data-gid': gid, 'data-key': 'claim-gm-' + gid } }) +
      G.ui.buttonHtml({ label: 'Cancel', variant: 'ghost', attrs: { 'data-action': 'claim-cancel' } }) + '</div><p class="gs-alert" id="claim-gm-error" role="alert" hidden></p>';
    const first = box.querySelector ? box.querySelector('button') : null;
    if (first && first.focus) first.focus();
  }

  G.handlers.click['claim-gm-start'] = function (el) {
    if (el.disabled) return;
    const gid = el.getAttribute('data-gid');
    el.disabled = true;
    G.ui.setText('claim-gm-error', '');
    G.fresh.start({ gid: gid, purpose: 'gm_claim', params: {}, act: { kind: 'gm_claim' }, returnTo: G.router.format({ name: 'new' }) }).then(null, function (err) {
      el.disabled = false;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      G.ui.setText('claim-gm-error', G.fresh.errorText(err, 'gm_claim', 1));
    });
  };

  G.pages.create = {
    showClaimClosed: showClaimClosed,
    claimHtml: claimHtml,
    claimableList: claimableList,
    cannotCreateHtml: cannotCreateHtml,
    REGIONS: REGIONS,
    CREATED_NOTICE: CREATED_NOTICE,
    browserTimeZone: browserTimeZone,
    allTimeZones: allTimeZones,
    createHtml: createHtml,
    realmFieldsHtml: realmFieldsHtml,
    teamsFieldsHtml: teamsFieldsHtml,
    validate: validate,
    setOptions: function (create) { createOptions = readOptions(create); },
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
