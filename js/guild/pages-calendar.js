// ── PAGES: CALENDAR LINK (the "Subscribe in your calendar" dialog of the Raids page) ──
// A private, revocable link per person and team (/cal/<token>.ics) that adds the team's raids to Google, Apple or Outlook Calendar.
//   GET /calendar?team= -> { team, subscribed, createdAt, lastUsedAt }      (the link itself is never sent again: the Worker keeps a hash)
//   POST /calendar { teamId } -> 201 { ..., url, webcalUrl }                (creates the link, or replaces the old one, which stops working)
//   DELETE /calendar { teamId } -> { team, subscribed: false }              (turns it off)
// The dialog reads the status first and walks through its states in place. The one-time address lives only in this module's `view` while the dialog
// is open: it is not kept in the app state or in browser storage, and it is gone when the dialog closes.
(function (G) {
  'use strict';

  const INTRO = 'A private link that adds this team\'s raids (30 days back, 60 days ahead) to Google, Apple or Outlook Calendar. Anyone with the link can see the raid times and sign-up counts, so keep it private. You can turn it off at any time.';
  const ONE_TIME = 'Copy it now - for your safety Raidsmith cannot show it again.';
  const REPLACE_TEXT = 'Replace your link? The old link stops working at once, so any calendar that uses it stops updating until you subscribe with the new one.';
  const OFF_TEXT = 'Turn off your link? Any calendar that uses it stops updating. You can create a new link later.';
  const REVOKED_TEXT = 'Calendar link turned off.';
  // Where the keyboard goes when a state is drawn (an id inside that state).
  const FOCUS = { off: 'cal-create', on: 'cal-replace-ask', created: 'cal-url', 'confirm-replace': 'cal-replace', 'confirm-off': 'cal-off', revoked: 'cal-close', error: 'cal-close' };
  const LIVE = {
    off: 'Your calendar link is off.', on: 'Your calendar link is on.', created: 'Your calendar link is ready. Copy it now.',
    'confirm-replace': 'Replace your link? Confirm below.', 'confirm-off': 'Turn off your link? Confirm below.', revoked: REVOKED_TEXT,
  };

  let view = null;     // { gid, teamId, teamName, phase, from, status, link: { url, webcalUrl } | null, busy, error, announced } while the dialog is open
  let dialog = null;

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function byId(id) { return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null; }

  // ── view ──
  // An address the link button may point at: webcal:// or https:// exactly as the Worker sent it, nothing else.
  function safeHref(url) {
    return typeof url === 'string' && /^(webcal|https):\/\/[^\s"'<>]+$/.test(url) ? url : '';
  }

  // "created Oct 3, 2026, last used yesterday".
  function usageText(status) {
    const s = status || {};
    const parts = [];
    const created = G.ui.formatDate(s.createdAt);
    if (created) parts.push('created ' + created);
    if (typeof s.lastUsedAt === 'number' && isFinite(s.lastUsedAt)) {
      const rel = G.ui.relativeTime(s.lastUsedAt);
      parts.push('last used ' + (/^(Today|Yesterday|\d+ days ago)$/.test(rel) ? rel.toLowerCase() : 'on ' + rel));
    } else {
      parts.push('not used yet');
    }
    return parts.join(', ');
  }

  function buttonHtml() {
    return '<button type="button" class="gs-btn" data-action="cal-open" data-key="cal-open">' + G.icons.icon('raids', 18) + '<span>Subscribe in your calendar</span></button>';
  }

  function actionsHtml(v, buttons) {
    const dis = v.busy ? ' disabled' : '';
    const html = buttons.map(function (b) {
      return '<button type="button" class="gs-btn' + (b.cls ? ' ' + b.cls : '') + '" id="' + b.id + '" data-action="' + b.action + '"' + dis + '>' + esc(b.label) + '</button>';
    }).join('');
    return '<div class="gs-dialog-actions">' + html + '</div>';
  }

  const CLOSE = { id: 'cal-close', action: 'dialog-cancel', label: 'Close' };
  const BACK = { id: 'cal-back', action: 'cal-back', label: 'Back' };

  function linkBlockHtml(link) {
    const open = safeHref(link.webcalUrl) || safeHref(link.url);
    return '<div class="gs-field"><label class="gs-label" for="cal-url">Your calendar link</label><div class="gs-cal-url">' +
      '<input class="gs-input" type="text" id="cal-url" readonly value="' + esc(link.url) + '" data-key="cal-url">' +
      '<button type="button" class="gs-btn" id="cal-copy" data-action="cal-copy">Copy</button></div>' +
      '<p class="gs-fine" id="cal-copied" hidden></p></div>' +
      '<p class="gs-warn" role="note">' + esc(ONE_TIME) + '</p>' +
      (open ? '<p class="gs-cal-open"><a class="gs-btn" id="cal-open-app" href="' + esc(open) + '">Open in my calendar app</a></p>' : '');
  }

  // The part of the dialog that changes with the state.
  function mainHtml(v) {
    const error = '<p class="gs-alert" id="cal-error" role="alert"' + (v.error ? '' : ' hidden') + '>' + esc(v.error) + '</p>';
    let text = '';
    let buttons;
    switch (v.phase) {
      case 'loading':
        text = '<p class="gs-lead gs-lead-sm">Loading...</p>';
        buttons = [CLOSE];
        break;
      case 'error':
        buttons = [CLOSE, { id: 'cal-retry', action: 'cal-retry', label: 'Try again', cls: 'gs-btn-molten' }];
        break;
      case 'off':
        text = '<p class="gs-confirm-text" id="cal-text">' + esc(INTRO) + '</p>';
        buttons = [CLOSE, { id: 'cal-create', action: 'cal-create', label: 'Create my link', cls: 'gs-btn-molten' }];
        break;
      case 'on':
        text = '<p class="gs-confirm-text" id="cal-text">Your link is on (' + esc(usageText(v.status)) + ').</p>' +
          '<p class="gs-fine">The link itself cannot be shown again. If you lost it, replace it to get a new one.</p>';
        buttons = [CLOSE, { id: 'cal-replace-ask', action: 'cal-replace-ask', label: 'Replace link' }, { id: 'cal-off-ask', action: 'cal-off-ask', label: 'Turn off', cls: 'gs-btn-danger-outline' }];
        break;
      case 'created':
        text = '<p class="gs-confirm-text" id="cal-text">Your private link is ready. Add it to your calendar app as a subscription.</p>' + (v.link ? linkBlockHtml(v.link) : '');
        buttons = [CLOSE, { id: 'cal-replace-ask', action: 'cal-replace-ask', label: 'Replace link' }, { id: 'cal-off-ask', action: 'cal-off-ask', label: 'Turn off', cls: 'gs-btn-danger-outline' }];
        break;
      case 'confirm-replace':
        text = '<p class="gs-confirm-text" id="cal-text">' + esc(REPLACE_TEXT) + '</p>';
        buttons = [BACK, { id: 'cal-replace', action: 'cal-replace', label: 'Replace link', cls: 'gs-btn-molten' }];
        break;
      case 'confirm-off':
        text = '<p class="gs-confirm-text" id="cal-text">' + esc(OFF_TEXT) + '</p>';
        buttons = [BACK, { id: 'cal-off', action: 'cal-off', label: 'Turn off', cls: 'gs-btn-danger' }];
        break;
      default: // 'revoked'
        text = '<p class="gs-confirm-text" id="cal-text">' + esc(REVOKED_TEXT) + '</p>';
        buttons = [CLOSE];
    }
    return text + error + actionsHtml(v, buttons);
  }

  // The whole dialog: only #cal-main is rewritten when the state changes, so the live region stays put and a screen reader announces it.
  function dialogHtml(v) {
    return '<div class="gs-dialog-form gs-cal"><h2 class="gs-dialog-title" id="cal-title">Subscribe in your calendar</h2>' +
      (v.teamName ? '<p class="gs-fine">Raids of ' + esc(v.teamName) + '</p>' : '') +
      '<div class="gs-cal-main" id="cal-main">' + mainHtml(v) + '</div><p class="gs-sr" id="cal-live" role="status"></p></div>';
  }

  // ── behaviour ──
  function redraw() {
    if (!view || !dialog) return;
    const main = dialog.querySelector ? dialog.querySelector('#cal-main') : null;
    if (main) main.innerHTML = mainHtml(view);
    const target = byId(FOCUS[view.phase] || 'cal-close');
    if (target && target.focus) {
      target.focus();
      if (view.phase === 'created' && target.select) target.select();
    }
    if (LIVE[view.phase] && view.announced !== view.phase) G.ui.announce('cal-live', LIVE[view.phase]);
    view.announced = view.phase;
  }

  function goto(v, phase) {
    v.phase = phase;
    v.busy = false;
    v.error = '';
    redraw();
  }

  // A failed call: sign-in and access problems close the dialog and go where every page sends them; the rest is a message in the dialog,
  // which stays in the state it was in (`phase` moves it, for the status read).
  function fail(v, err, phase) {
    if (view !== v) return;
    const c = G.api.classify(err);
    if (c.view === 'signin' || c.view === 'message') {
      if (dialog && dialog.close) dialog.close();
      if (c.view === 'signin') G.app.requireSignin(); else G.app.showFailure(c.title, c.text);
      return;
    }
    v.busy = false;
    v.error = c.text;
    if (phase) v.phase = phase;
    redraw();
  }

  function loadStatus(v) {
    v.phase = 'loading';
    v.error = '';
    redraw();
    return G.api.calendar.status(v.gid, v.teamId).then(function (res) {
      if (view !== v) return null;
      v.status = res;
      goto(v, res && res.subscribed ? 'on' : 'off');
      return null;
    }, function (err) { fail(v, err, 'error'); return null; });
  }

  function open(gid, teamId, teamName) {
    const v = { gid: gid, teamId: teamId, teamName: teamName || '', phase: 'loading', from: 'off', status: null, link: null, busy: false, error: '' };
    const dlg = G.ui.openDialog(dialogHtml(v), { labelledBy: 'cal-title' });
    if (!dlg) return null;
    view = v;
    dialog = dlg;
    if (dlg.addEventListener) {
      dlg.addEventListener('close', function () {
        if (view === v) { view = null; dialog = null; } // the one-time address goes with the dialog
      });
    }
    return loadStatus(v);
  }

  // Create or Replace: the same POST; the answer carries the address to show once.
  function makeLink(v) {
    v.busy = true;
    v.error = '';
    redraw();
    return G.api.calendar.create(v.gid, v.teamId).then(function (res) {
      if (view !== v) return null;
      if (!res || typeof res.url !== 'string' || !res.url) {
        fail(v, { status: 500, code: 'error', message: 'The link could not be created. Try again.' });
        return null;
      }
      v.status = res;
      v.link = { url: res.url, webcalUrl: typeof res.webcalUrl === 'string' ? res.webcalUrl : '' };
      goto(v, 'created');
      return null;
    }, function (err) { fail(v, err); return null; });
  }

  G.handlers.click['cal-open'] = function () {
    const gid = st().currentGid;
    const gd = gid ? st().guilds[gid] : null;
    const x = a().raids;
    if (!gd || !x || x.gid !== gid || !x.teamId) return null;
    const team = G.pages.attendance.teamOf(gd, x.teamId);
    return open(gid, x.teamId, team ? team.name : '');
  };

  G.handlers.click['cal-retry'] = function () { return view ? loadStatus(view) : null; };
  G.handlers.click['cal-create'] = function () { return view && !view.busy ? makeLink(view) : null; };
  G.handlers.click['cal-replace'] = function () { return view && !view.busy ? makeLink(view) : null; };

  G.handlers.click['cal-replace-ask'] = function () {
    if (!view || view.busy) return;
    view.from = view.phase;
    goto(view, 'confirm-replace');
  };

  G.handlers.click['cal-off-ask'] = function () {
    if (!view || view.busy) return;
    view.from = view.phase;
    goto(view, 'confirm-off');
  };

  G.handlers.click['cal-back'] = function () {
    if (!view || view.busy) return;
    goto(view, view.from === 'created' || view.from === 'on' ? view.from : 'on');
  };

  G.handlers.click['cal-off'] = function () {
    const v = view;
    if (!v || v.busy) return null;
    v.busy = true;
    v.error = '';
    redraw();
    return G.api.calendar.revoke(v.gid, v.teamId).then(function () {
      if (view !== v) return null;
      v.link = null;
      v.status = { subscribed: false };
      goto(v, 'revoked');
      return null;
    }, function (err) { fail(v, err); return null; });
  };

  // The planner's copyText does the copying (every clipboard write in the app goes through it): a toast when it worked, a dialog with the text
  // selected when the browser refused. The toast sits behind this modal, so the result is also said here. Without copyText (a page that does not
  // load the planner's scripts) the box is selected for Ctrl+C.
  G.handlers.click['cal-copy'] = function () {
    const v = view;
    if (!v || !v.link) return null;
    const input = byId('cal-url');
    const say = function (text) { G.ui.setText('cal-copied', text); G.ui.announce('cal-live', text); };
    const select = function () { if (input && input.focus) { input.focus(); if (input.select) input.select(); } };
    if (typeof copyText === 'function') {
      return Promise.resolve(copyText(v.link.url, 'Calendar link copied')).then(function (copied) {
        if (copied === false) say('Your browser would not copy it. The link is in a dialog, selected: press Ctrl+C.'); else say('Copied.');
      });
    }
    select();
    say('The link is selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.');
    return null;
  };

  G.pages.calendar = {
    INTRO: INTRO,
    ONE_TIME: ONE_TIME,
    safeHref: safeHref,
    usageText: usageText,
    buttonHtml: buttonHtml,
    dialogHtml: dialogHtml,
    mainHtml: mainHtml,
    viewState: function () { return view; },
    open: open,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
