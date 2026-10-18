// -- PAGE: GUILD SETTINGS > NOTIFICATIONS ------------------------
// Per team, a Discord channel webhook and what Raidsmith posts to it: the roster when it is published, loot after an import, raid reminders 24 h and 2 h
// before, a reminder for people who have not answered a raid (N hours before its sign-up deadline) and one for rostered people who have not confirmed
// (6 h before). Everything is off until an officer switches it on. GET /api/guild/:gid/notifications, PUT /api/guild/:gid/teams/:tid/notifications
// (guild.teams). The webhook address is a secret: it goes in through the field and never comes back, only its last four characters do.
// Members opt out of being pinged by name on Linked accounts ("Don't mention me in reminders").
(function (G) {
  'use strict';

  const INTRO = 'Raidsmith can post to a Discord channel for each team. In Discord, open the channel\'s settings, then Integrations, then Webhooks, make a webhook and copy its address here. ' +
    'Nothing is posted until you switch a post on. Posts are plain messages with a link to the raid; they never use @everyone or @here.';
  const SECRET = 'The address is a secret. Raidsmith stores it and never shows it again, only its last four characters.';
  const MENTION_HELP = 'Optional. A role to ping in every post, written like <@&123456789012345678>. In Discord, turn on Developer Mode, then right-click the role and Copy Role ID.';
  const SWITCHES = [
    { key: 'roster', label: 'Post the roster when published' },
    { key: 'loot', label: 'Post loot after an import' },
    { key: 'reminders', label: 'Post upcoming raid reminders (24 h and 2 h before)' },
    { key: 'noreply', label: 'Remind people who haven\'t answered' },
    { key: 'confirm', label: 'Remind rostered people who haven\'t confirmed (6 h before the raid)' },
  ];

  function st() { return G.app.state; }
  function xs() { return st().notifySettings; }
  function idOf(team, part) { return 'notify-' + team.id + '-' + part; }
  function hoursOf() {
    const x = xs();
    return x && x.data && x.data.options && Array.isArray(x.data.options.noreplyHours) ? x.data.options.noreplyHours : [6, 12, 24, 48];
  }

  function webhookStatusHtml(team) {
    const w = team.webhook || {};
    if (!w.set) return '<p class="gs-fine">No webhook yet.</p>';
    if (w.state === 'disabled') {
      return '<p class="gs-warn" role="status">The webhook ending in <code>' + esc(w.hint || '') + '</code> was switched off: Discord refused it' +
        (w.disabledStatus ? ' (' + esc(w.disabledStatus) + ')' : '') + ', so the channel or the webhook is gone. Paste a new address to turn posts back on.</p>';
    }
    return '<p class="gs-fine">Webhook saved, ending in <code>' + esc(w.hint || '') + '</code>.</p>';
  }

  function switchHtml(team, item) {
    const id = idOf(team, item.key);
    const on = !!(team.post && team.post[item.key]);
    let html = '<div class="gs-check"><input type="checkbox" id="' + esc(id) + '" name="' + esc(item.key) + '"' + (on ? ' checked' : '') + '><label for="' + esc(id) + '">' + esc(item.label) + '</label></div>';
    if (item.key === 'noreply') {
      const hours = hoursOf();
      html += '<div class="gs-field gs-notify-hours"><label class="gs-label" for="' + esc(idOf(team, 'hours')) + '">How long before the sign-up deadline</label>' +
        '<select class="gs-input" id="' + esc(idOf(team, 'hours')) + '" name="noreplyHours">' +
        G.ui.optionsHtml(hours.map(function (h) { return { value: String(h), label: h + ' hours' }; }), String(team.noreplyHours)) + '</select>' +
        '<p class="gs-fine">Lists the raiders and trials on this team with no sign-up and no away notice. A person with a linked Discord account is pinged by name unless they opted out on Linked accounts.</p></div>';
    }
    return html;
  }

  function teamHtml(team) {
    const w = team.webhook || {};
    return '<section class="gs-card-sec gs-notify-team" aria-labelledby="' + esc(idOf(team, 'h')) + '"><div class="gs-card-sec-head"><h3 class="gs-h2" id="' + esc(idOf(team, 'h')) + '">' + esc(team.name) + '</h3>' +
      (w.set ? '<span class="gs-pill ' + (w.state === 'disabled' ? 'gs-pill-warn' : 'gs-pill-ok') + '">' + (w.state === 'disabled' ? 'Switched off' : 'Webhook set') + '</span>' : '<span class="gs-pill gs-pill-muted">No webhook</span>') + '</div>' +
      '<form class="gs-card-sec-body gs-notify-form" data-submit="notify-save" data-team="' + esc(team.id) + '" novalidate>' +
      webhookStatusHtml(team) +
      '<div class="gs-field"><label class="gs-label" for="' + esc(idOf(team, 'url')) + '">' + (w.set ? 'New webhook address' : 'Webhook address') + '</label>' +
      '<input class="gs-input gs-code" type="text" id="' + esc(idOf(team, 'url')) + '" name="webhookUrl" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/..." aria-describedby="' + esc(idOf(team, 'url-help')) + '">' +
      '<p class="gs-fine" id="' + esc(idOf(team, 'url-help')) + '">' + esc(SECRET) + (w.set ? ' Leave this empty to keep the saved one.' : '') + '</p></div>' +
      '<div class="gs-field"><label class="gs-label" for="' + esc(idOf(team, 'role')) + '">Role to mention</label>' +
      '<input class="gs-input gs-code" type="text" id="' + esc(idOf(team, 'role')) + '" name="roleMention" autocomplete="off" spellcheck="false" placeholder="&lt;@&amp;123456789012345678&gt;" value="' + esc(team.roleMention ? '<@&' + team.roleMention + '>' : '') + '" aria-describedby="' + esc(idOf(team, 'role-help')) + '">' +
      '<p class="gs-fine" id="' + esc(idOf(team, 'role-help')) + '">' + esc(MENTION_HELP) + '</p></div>' +
      '<fieldset class="gs-pol-field"><legend class="gs-label">What to post</legend>' + SWITCHES.map(function (item) { return switchHtml(team, item); }).join('') + '</fieldset>' +
      '<p class="gs-alert" id="' + esc(idOf(team, 'error')) + '" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="notify-save-' + esc(team.id) + '">Save ' + esc(team.name) + '</button>' +
      (w.set ? '<button type="button" class="gs-btn gs-btn-danger-outline" data-action="notify-remove" data-team="' + esc(team.id) + '" data-key="notify-remove-' + esc(team.id) + '">Remove webhook</button>' : '') + '</div></form></section>';
  }

  // opts: { guildData, data (GET /notifications or null), alert, notice }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    if (!d) body = G.pages.signin.loadingHtml();
    else if (!d.teams || !d.teams.length) body = '<p class="gs-empty">This guild has no active teams.</p>';
    else body = '<div class="gs-notify-teams">' + d.teams.map(teamHtml).join('') + '</div>';
    return '<section class="gs-section" aria-labelledby="notify-h"><div class="gs-section-head"><h2 class="gs-h2" id="notify-h">Notifications</h2></div>' +
      '<p class="gs-lead gs-lead-sm">' + esc(INTRO) + '</p>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  function load(gid) {
    return G.api.notifications.get(gid).then(function (data) {
      st().notifySettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  // -- behaviour --
  function teamOf(x, id) {
    return ((x && x.data && x.data.teams) || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  // The body of PUT for one form: the address only when something was typed (a saved address is never sent back), everything else as it stands.
  function bodyFrom(form) {
    const body = { roleMention: String(form.elements.roleMention.value || '').trim() };
    const url = String(form.elements.webhookUrl.value || '').trim();
    if (url) body.webhookUrl = url;
    SWITCHES.forEach(function (item) { body[item.key] = !!form.elements[item.key].checked; });
    body.noreplyHours = Number(form.elements.noreplyHours.value);
    return body;
  }

  function save(x, teamId, body, form, done) {
    if (form) G.ui.setBusy(form, true);
    G.api.notifications.save(x.gid, teamId, body).then(function (res) {
      const cur = xs();
      if (cur && cur.gid === x.gid && cur.data) {
        cur.data.teams = cur.data.teams.map(function (t) { return t.id === teamId ? res.team : t; });
        cur.notice = done(res.team);
      }
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      if (form) G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      G.ui.setText('notify-' + teamId + '-error', c.text);
    });
  }

  G.handlers.submit['notify-save'] = function (form) {
    const x = xs();
    const teamId = form.getAttribute('data-team');
    if (!x || !x.data || !teamOf(x, teamId)) return;
    G.ui.setText('notify-' + teamId + '-error', '');
    save(x, teamId, bodyFrom(form), form, function (team) { return 'Saved for ' + team.name + '.'; });
  };

  G.handlers.click['notify-remove'] = function (el) {
    const x = xs();
    const teamId = el.getAttribute('data-team');
    if (!x || !x.data || !teamOf(x, teamId) || el.disabled) return;
    el.disabled = true;
    save(x, teamId, { webhookUrl: null }, null, function (team) { return 'Removed the webhook of ' + team.name + '.'; });
  };

  G.pages.settingsNotify = {
    INTRO: INTRO, SECRET: SECRET, SWITCHES: SWITCHES, bodyFrom: bodyFrom, teamHtml: teamHtml, settingsHtml: settingsHtml, load: load,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
