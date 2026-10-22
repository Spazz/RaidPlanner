// ── PAGE: GUILD SETTINGS > LOOT (who sees loot, how the balance counts) ──
// The same model as Settings > Attendance: a stored policy is an OVERRIDE object (only the keys set at that level); the
// page edits one level at a time ("Guild default" or one team) as a draft, says "Guild default" / "Changed for this team" (+ Reset) per key in a
// team scope, and saves with PUT /loot/policy { teamId | null, override, version }. GET /loot/policy answers with
// { defaults, guild, teams, resolved, versions }. The path helpers come from pages-settings-attendance.js.
(function (G) {
  'use strict';

  const RADIO = 'radio';
  const BOOL = 'bool';
  const GROUPS = [
    { id: 'visibility', title: 'Who sees loot', fields: [
      { path: 'visibility.members', type: RADIO, label: 'Members see', options: [['own', 'Their own loot only'], ['ownTeams', 'The loot of their teams'], ['guild', 'The loot of the whole guild']],
        help: 'Officers and team leads always see the loot of their teams, and they are the only ones who import, re-tag or delete.' },
    ] },
    { id: 'members', title: 'What members see', intro: 'Members always see the latest raid nights and their own loot by raid day. These two are extra.', fields: [
      { path: 'visibility.standings', type: BOOL, label: 'Who is due (standings)', help: 'Shows members the standings and the Who is due card. Off by default.' },
      { path: 'visibility.itemLookup', type: BOOL, label: 'Look up an item', help: 'Lets members search an item and see who received it. Off by default.' },
    ] },
    { id: 'balance', title: 'Balance', fields: [
      { path: 'balance.mode', type: RADIO, label: 'The balance ranks people by', options: [['perRaid', 'Counted items per raid attended'], ['count', 'Plain item counts']] },
      { path: 'balance.countTags', type: 'checks', label: 'Tags that count', options: [['MS', 'Main spec (MS)'], ['OS', 'Off-spec (OS)']],
        help: 'Disenchanted and Bank awards never count. Pick at least one tag.' },
    ] },
  ];

  function S() { return G.pages.settingsAtt; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function fid(path) { return path.replace(/\./g, '-'); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

  // ── view ──
  // Where the value comes from, as muted text (no chip): the guild's, or changed for this team with its Reset (the same lpol-reset action).
  function chipsOf(scope, eff, field) {
    if (scope === 'guild') return '';
    if (!eff.overridden) return '<span class="gs-pol-src">Guild default</span>';
    return '<span class="gs-pol-src is-over">Changed for this team</span>' +
      '<button type="button" class="gs-btn gs-btn-ghost gs-btn-sm gs-pol-reset" data-action="lpol-reset" data-path="' + esc(field.path) + '" data-key="lpol-reset-' + esc(fid(field.path)) + '">Reset</button>';
  }

  function fieldHtml(field, scope, draft, view) {
    const eff = S().effective(view, scope, draft, field.path);
    const id = fid(field.path);
    const set = Array.isArray(eff.value) ? eff.value : [];
    if (field.type === BOOL) {
      return '<fieldset class="gs-fieldset gs-pol-field" id="lpf-' + id + '"><legend class="gs-sr">' + esc(field.label) + '</legend><div class="gs-pol-markers">' + chipsOf(scope, eff, field) + '</div>' +
        '<div class="gs-check"><input type="checkbox" id="lp-' + id + '" value="1"' + (eff.value === true ? ' checked' : '') + ' data-change="lpol-change" data-type="' + BOOL + '" data-path="' + esc(field.path) + '" data-key="lp-' + id + '"' +
        ' aria-describedby="lphelp-' + id + '"><label for="lp-' + id + '">' + esc(field.label) + '</label></div>' +
        (field.help ? '<p class="gs-fine" id="lphelp-' + id + '">' + esc(field.help) + '</p>' : '') + '<p class="gs-field-error" id="lperr-' + id + '" role="alert" hidden></p></fieldset>';
    }
    const inner = '<div class="gs-radios">' + field.options.map(function (o, i) {
      const on = field.type === RADIO ? eff.value === o[0] : set.indexOf(o[0]) >= 0;
      return '<div class="gs-check"><input type="' + (field.type === RADIO ? 'radio' : 'checkbox') + '" id="lp-' + id + '-' + i + '"' + (field.type === RADIO ? ' name="lp-' + id + '"' : '') + ' value="' + esc(o[0]) + '"' + (on ? ' checked' : '') +
        ' data-change="lpol-change" data-type="' + field.type + '" data-path="' + esc(field.path) + '" data-key="lp-' + id + '-' + i + '"><label for="lp-' + id + '-' + i + '">' + esc(o[1]) + '</label></div>';
    }).join('') + '</div>';
    return '<fieldset class="gs-fieldset gs-pol-field" id="lpf-' + id + '"><legend class="gs-legend">' + esc(field.label) + '</legend>' +
      '<div class="gs-pol-markers">' + chipsOf(scope, eff, field) + '</div>' + inner +
      (field.help ? '<p class="gs-fine" id="lphelp-' + id + '">' + esc(field.help) + '</p>' : '') + '<p class="gs-field-error" id="lperr-' + id + '" role="alert" hidden></p></fieldset>';
  }

  function groupHtml(g, scope, draft, view) {
    return '<section class="gs-att-section" aria-labelledby="lpg-' + g.id + '"><h2 class="gs-hd-sl" id="lpg-' + g.id + '">' + esc(g.title) + '</h2>' +
      (g.intro ? '<p class="gs-fine">' + esc(g.intro) + '</p>' : '') + '<div class="gs-hd-panel"><div class="gs-att-grp">' + g.fields.map(function (f) { return fieldHtml(f, scope, draft, view); }).join('') + '</div></div></section>';
  }

  // How many settings differ from what is saved at this level (the Save bar's count). The guild default stores only what differs from the built-in rules.
  function normalized(s, o) { return s.scope === 'guild' ? S().pruneToDifferences(o, s.view.defaults || {}) : o; }
  function changeCount(s) { return G.ui.saveBar.draftChanges(normalized(s, S().overrideFor(s.view, s.scope)), normalized(s, s.draft)); }

  // opts: { guildData, s: { view, scope, draft }, alert, notice }
  function settingsHtml(opts) {
    const gd = opts.guildData;
    const s = opts.s;
    const teams = G.shell.activeTeams(gd.teams);
    const scopeOpts = [{ value: 'guild', label: 'Guild default' }].concat(teams.map(function (t) { return { value: t.id, label: t.name + ' override' }; }));
    const scopeField = '<div class="gs-roster-status"><label class="gs-label" for="lpol-scope">Applies to</label><select class="gs-input" id="lpol-scope" data-change="lpol-scope" data-key="lpol-scope">' + G.ui.optionsHtml(scopeOpts, s.scope) + '</select></div>';
    const scopeNote = s.scope === 'guild'
      ? '<p class="gs-fine">These rules apply to every team unless a team has its own override.</p>'
      : '<p class="gs-fine">Only the rules marked "Changed for this team" differ from the guild default. Everything else follows it.</p>';
    return '<div class="gs-settings-att gs-settings-loot">' + scopeField + scopeNote + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      '<form class="gs-pol-form" data-submit="lpol-form" novalidate>' + GROUPS.map(function (g) { return groupHtml(g, s.scope, s.draft, s.view); }).join('') +
      '<p class="gs-fine">Changes apply to all loot at once: the balance is worked out from the awards each time it is opened.</p><p class="gs-alert" id="lpol-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="button" class="gs-btn" data-action="lpol-reset-all" data-key="lpol-reset-all">' + (s.scope === 'guild' ? 'Reset to defaults' : 'Remove the team override') + '</button></div>' +
      G.ui.saveBarHtml({ count: changeCount(s), discardAttrs: { 'data-action': 'lpol-discard', 'data-key': 'lpol-discard' } }) + '</form></div>';
  }

  // ── data ──
  function adopt(gid, view, scope) {
    a().settingsLoot = { gid: gid, view: view, scope: scope, draft: S().overrideFor(view, scope) };
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.loot.policy(gid).then(function (view) {
      const prev = a().settingsLoot;
      const scope = prev && prev.gid === gid && prev.scope && (prev.scope === 'guild' || (view.resolved && view.resolved[prev.scope])) ? prev.scope : 'guild';
      adopt(gid, view, scope);
      return null;
    });
  }

  function main(r, gd, ctx) {
    const s = a().settingsLoot;
    if (!s || s.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'loot', settingsHtml({ guildData: gd, s: s, alert: st().pageAlert, notice: a().lootPolNotice }));
  }

  function cur() { const s = a().settingsLoot; return s && currentGd() ? s : null; }

  // ── handlers ──
  G.handlers.change['lpol-scope'] = function (el) {
    const s = cur();
    if (!s) return;
    s.scope = el.value;
    s.draft = S().overrideFor(s.view, s.scope);
    a().lootPolNotice = '';
    st().pageAlert = '';
    G.app.render();
  };

  G.handlers.change['lpol-change'] = function (el) {
    const s = cur();
    if (!s) return;
    const path = el.getAttribute('data-path');
    let v;
    if (el.getAttribute('data-type') === BOOL) v = !!el.checked;
    else if (el.getAttribute('data-type') === RADIO) v = el.value;
    else {
      const boxes = el.closest('fieldset').querySelectorAll('input[type="checkbox"]');
      v = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.value; });
    }
    S().setPath(s.draft, path, v);
    G.app.render();
  };

  G.handlers.click['lpol-reset'] = function (el) {
    const s = cur();
    if (!s) return;
    S().delPath(s.draft, el.getAttribute('data-path'));
    G.app.render();
  };

  G.handlers.click['lpol-discard'] = function () {
    const s = cur();
    if (!s) return;
    s.draft = S().overrideFor(s.view, s.scope);
    st().pageAlert = '';
    G.app.render();
  };

  G.handlers.click['lpol-reset-all'] = function () {
    const s = cur();
    if (!s) return;
    s.draft = {};
    G.app.render();
  };

  function showError(form, err) {
    const c = G.api.classify(err);
    const slot = err && err.field ? document.getElementById('lperr-' + fid(err.field)) : null;
    if (slot) {
      slot.textContent = c.text;
      slot.hidden = false;
      const input = form.querySelector('[data-path="' + err.field + '"]');
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
      return;
    }
    G.ui.setText('lpol-error', c.text);
  }

  G.handlers.submit['lpol-form'] = function (form) {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    const gid = gd.guild.id;
    const body = s.scope === 'guild' ? S().pruneToDifferences(s.draft, s.view.defaults || {}) : clone(s.draft);
    G.ui.setText('lpol-error', '');
    Array.prototype.forEach.call(form.querySelectorAll('.gs-pol-field .gs-field-error'), function (e) { e.hidden = true; e.textContent = ''; });
    const tags = S().effective(s.view, s.scope, s.draft, 'balance.countTags').value;
    if (Array.isArray(tags) && !tags.length) {
      showError(form, { field: 'balance.countTags', status: 400, code: 'invalid', message: 'Pick at least one tag to count.' });
      return;
    }
    G.ui.setBusy(form, true);
    G.api.loot.savePolicy(gid, s.scope === 'guild' ? null : s.scope, body, S().versionFor(s.view, s.scope)).then(function (view) {
      adopt(gid, view, s.scope);
      a().lootPolNotice = '';
      G.app.markSettingsSaved('loot');
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      G.ui.setBusy(form, false);
      if (err && (err.code === 'stale' || err.code === 'conflict')) {
        const current = err.body && err.body.current;
        st().pageAlert = 'Someone else changed these settings. The page now shows their version; make your change again.';
        if (current && current.defaults) { adopt(gid, current, s.scope); G.app.render(); } else G.app.routeAll({ force: true });
        return;
      }
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      showError(form, err);
    });
  };

  G.pages.settingsLoot = {
    GROUPS: GROUPS,
    settingsHtml: settingsHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
