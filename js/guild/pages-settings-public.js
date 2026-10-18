// -- PAGE: GUILD SETTINGS > PUBLIC PAGE --------------------------
// A public page anyone with the address can read: off by default, and the Guild Master or an officer with guild.roles turns it on and ticks what it
// shows. GET / PUT /api/guild/:gid/public. The built-in Public role is the ceiling: a section it does not allow is shown closed (change that in Roles).
// The page itself (G.pages.view) never shows officer notes, Discord names or IDs, or accounts.
(function (G) {
  'use strict';

  const SECTION_ITEMS = [
    { key: 'roster', label: 'Roster names and classes' },
    { key: 'raids', label: 'Upcoming and recent raids' },
    { key: 'progress', label: 'Boss progress (first kills, wipes, best clear)' },
    { key: 'attendance', label: 'Attendance percentages' },
    { key: 'loot', label: 'Loot awards' },
  ];
  const INTRO = 'The public page is off by default. When it is on, anyone who has the address can read the sections you tick below, without signing in or having an account.';
  const NEVER = 'It never shows officer notes, Discord names or IDs, or accounts.';
  const CLOSED = 'Closed by the Public role (change it in Roles)';

  function st() { return G.app.state; }
  function xs() { return st().publicSettings; }

  function sectionHtml(item, d) {
    const id = 'public-sec-' + item.key;
    const closed = !!d.allowed && d.allowed[item.key] === false;
    const checked = !closed && Array.isArray(d.sections) && d.sections.indexOf(item.key) >= 0;
    return '<div class="gs-check"><input type="checkbox" id="' + id + '" name="section" value="' + esc(item.key) + '"' + (checked ? ' checked' : '') + (closed ? ' disabled aria-describedby="' + id + '-why"' : '') + '>' +
      '<label for="' + id + '">' + esc(item.label) + '</label></div>' +
      (closed ? '<p class="gs-fine gs-public-why" id="' + id + '-why">' + esc(CLOSED) + '</p>' : '');
  }

  function addressHtml(d, origin) {
    const url = origin + (typeof d.path === 'string' ? d.path : '');
    return '<div class="gs-panel gs-public-url"><label class="gs-label" for="public-url">Public address</label>' +
      '<div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="public-url" readonly autocomplete="off" spellcheck="false" value="' + esc(url) + '">' +
      '<button type="button" class="gs-btn" data-action="public-copy" data-key="public-copy">Copy link</button></div>' +
      '<p class="gs-fine" id="public-copy-status" role="status"></p></div>';
  }

  // opts: { guildData, data (GET /public or null), alert, notice, origin (optional: the address the page is served from) }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    if (!d) {
      body = G.pages.signin.loadingHtml();
    } else {
      const origin = typeof opts.origin === 'string' ? opts.origin : G.ui.pageOrigin();
      body = '<p class="gs-fine" id="public-intro">' + esc(INTRO) + '</p>' +
        '<form class="gs-form gs-public-form" data-submit="public-settings" novalidate>' +
        '<div class="gs-check"><input type="checkbox" id="public-enabled" name="enabled"' + (d.enabled ? ' checked' : '') + '><label for="public-enabled">Show a public page</label></div>' +
        '<fieldset class="gs-pol-field"><legend class="gs-label">What it shows</legend>' +
        SECTION_ITEMS.map(function (item) { return sectionHtml(item, d); }).join('') + '</fieldset>' +
        '<p class="gs-fine" id="public-never">' + esc(NEVER) + '</p>' +
        '<p class="gs-alert" id="public-form-error" role="alert" hidden></p>' +
        '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="public-save">Save</button></div></form>' +
        (d.enabled ? addressHtml(d, origin) : '');
    }
    return '<section class="gs-section" aria-labelledby="public-set-h"><div class="gs-section-head"><h2 class="gs-h2" id="public-set-h">Public page</h2></div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  function load(gid) {
    return G.api.publicPage.get(gid).then(function (data) {
      st().publicSettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  // -- behaviour --
  G.handlers.click['public-copy'] = function () {
    G.ui.copyInput(document.getElementById('public-url')).then(function (copied) {
      G.ui.setText('public-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected link.');
    });
  };

  G.handlers.submit['public-settings'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    G.ui.setText('public-form-error', '');
    const sections = [];
    Array.prototype.forEach.call(form.querySelectorAll('input[name="section"]'), function (box) {
      if (box.checked && !box.disabled) sections.push(box.value);
    });
    G.ui.setBusy(form, true);
    G.api.publicPage.save(x.gid, { enabled: !!form.elements.enabled.checked, sections: sections }).then(function (res) {
      const cur = xs();
      if (cur && cur.gid === x.gid) { cur.data = res; cur.notice = 'Saved.'; }
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      G.ui.setText('public-form-error', c.text);
    });
  };

  G.pages.settingsPublic = { SECTION_ITEMS: SECTION_ITEMS, INTRO: INTRO, NEVER: NEVER, CLOSED: CLOSED, settingsHtml: settingsHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
