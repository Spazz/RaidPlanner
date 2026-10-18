// ── PAGE: A RAID'S GUEST SIGN-UP LINK (#/join/<token>, works signed out) ─
// What a guest sees: the guild and the raid an officer made the link for, and a small form - the character's name, class and spec, and a note. No account is
// needed (and a member of another guild may use it). POST /api/join/view (also hands the browser the cookie the sign-up needs), POST /api/join. A hidden
// "website" field catches scripts. The Worker limits sign-ups per browser, per link and per raid (worker/routes/join.js). Guests are listed as Guests.
(function (G) {
  'use strict';

  const NAME_HINT = 'Your character\'s name, 2 to 12 letters.';
  const NAME_HINT_FOREVER = 'Your character\'s name: a first name, then a surname if it has one, 2 to 12 letters each.';

  function st() { return G.app.state; }
  function optionsOf(data) { return G.ui.rosterOptions({ rosterOptions: data.rosterOptions }); }

  function fieldError(id) { return '<p class="gs-field-error" id="jn-err-' + id + '" role="alert" hidden></p>'; }

  function whenText(raid) {
    const day = G.ui.weekdayDay(raid.raidOn) || raid.raidOn;
    if (raid.timeKnown === false) return day;
    return day + ', ' + new Date(raid.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function raidLine(data) {
    const raid = data.raid;
    const what = [raid.title, raid.zone].filter(Boolean).join(' - ');
    return [what, raid.teamName, whenText(raid)].filter(Boolean).join(' - ');
  }

  function formHtml(x) {
    const data = x.data;
    const d = x.draft || {};
    const options = optionsOf(data);
    return '<form class="gs-apply-form" data-submit="join-form" novalidate aria-describedby="jn-intro">' +
      '<div class="gs-field"><label class="gs-label" for="jn-name">Character name</label><input class="gs-input" type="text" id="jn-name" name="name" maxlength="40" autocomplete="off" required aria-describedby="jn-name-hint" value="' + esc(d.name || '') + '">' +
      '<p class="gs-fine" id="jn-name-hint">' + esc(data.guild.gameVersion === 'forever' ? NAME_HINT_FOREVER : NAME_HINT) + '</p>' + fieldError('name') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="jn-class">Class</label><select class="gs-input" id="jn-class" name="class" data-change="join-class" required>' + G.ui.classOptionsHtml(options, d.class || '', 'Choose a class') + '</select>' + fieldError('class') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="jn-spec">Spec</label><select class="gs-input" id="jn-spec" name="spec" required>' + G.ui.specOptionsHtml(options, d.class || '', d.spec || '', 'Choose a spec') + '</select>' + fieldError('spec') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="jn-note">A note for the officers <span class="gs-fine">(optional)</span></label><input class="gs-input" type="text" id="jn-note" name="note" maxlength="' + esc(data.noteMax || 120) + '" autocomplete="off" placeholder="Your guild, gear, anything they should know" value="' + esc(d.note || '') + '">' + fieldError('note') + '</div>' +
      '<div class="gs-hp" aria-hidden="true"><label for="jn-website">Leave this empty</label><input type="text" id="jn-website" name="website" tabindex="-1" autocomplete="off" value=""></div>' +
      '<p class="gs-alert" id="jn-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="jn-submit"' + (x.busy ? ' disabled' : '') + '>Sign up as a guest</button></div></form>';
  }

  function doneHtml(data) {
    return '<section class="gs-empty-card" aria-labelledby="jn-done-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="jn-done-h" tabindex="-1">You are signed up</h2><p class="gs-lead gs-lead-sm">The officers of ' + esc(data.guild.name) + ' can see you for ' + esc(whenText(data.raid)) + '. You do not need to do anything else.</p></section>';
  }

  // opts: { state } (st().join) -> the page.
  function joinHtml(opts) {
    const x = opts.state;
    if (!x || x.status === 'loading') return G.pages.signin.loadingHtml();
    if (x.status === 'gone') return G.pages.signin.messageHtml(x.title || 'This link does not work', x.message || 'Ask the officer who sent it for a new one.', {});
    if (x.status === 'error') return G.pages.signin.messageHtml('Could not open the sign-up', x.message || 'Something went wrong. Try again in a moment.', { retry: true });
    const data = x.data;
    return '<div class="gs-page gs-page-narrow gs-apply"><div class="gs-page-head"><div><h1 class="gs-h1" tabindex="-1">Sign up for ' + esc(data.guild.name) + '</h1><p class="gs-sub">' + esc(raidLine(data)) + '</p></div></div>' +
      (x.done ? doneHtml(data) : '<p class="gs-lead gs-lead-sm" id="jn-intro">An officer shared this link so you can join this raid as a guest. ' + esc(data.spotsLeft === 1 ? 'One spot is left on the link.' : data.spotsLeft + ' spots are left on the link.') + '</p>' + formHtml(x)) + '</div>';
  }

  function load(route) {
    const x = st().join = { token: route.token, status: 'loading', data: null, draft: {}, busy: false, error: '', done: false, message: '', title: '' };
    return G.api.join.view(route.token).then(function (data) {
      if (st().join !== x) return x;
      x.status = 'ok';
      x.data = data;
      return x;
    }, function (err) {
      if (st().join !== x) return x;
      x.status = err && (err.status === 404 || err.status === 410) ? 'gone' : 'error';
      x.title = err && err.status === 404 ? 'This link is not valid' : (err && err.status === 410 ? 'This link has stopped working' : '');
      x.message = G.api.classify(err).text;
      return x;
    });
  }

  function cur() {
    const x = st().join;
    return x && x.status === 'ok' && !x.done ? x : null;
  }

  G.handlers.change['join-class'] = function (sel) {
    const x = cur();
    const form = sel.closest ? sel.closest('form') : null;
    if (!x || !form) return;
    form.elements.spec.innerHTML = G.ui.specOptionsHtml(optionsOf(x.data), sel.value, '', 'Choose a spec');
  };

  function readForm(form) {
    const v = function (name) { return form.elements[name] ? String(form.elements[name].value == null ? '' : form.elements[name].value) : ''; };
    return { name: v('name').trim(), class: v('class'), spec: v('spec'), note: v('note').trim() };
  }

  // The body of POST: a note with nothing in it is left out; the hidden field travels as it is (empty for a person).
  function bodyFrom(draft, token, website) {
    const body = { token: token, name: draft.name, class: draft.class, spec: draft.spec, website: website || '' };
    if (draft.note) body.note = draft.note;
    return body;
  }

  function problemOf(draft) {
    if (!draft.name) return { field: 'name', text: 'Enter your character\'s name.' };
    if (!draft.class) return { field: 'class', text: 'Choose a class.' };
    if (!draft.spec) return { field: 'spec', text: 'Choose a spec.' };
    return null;
  }

  function showFieldError(field, text) {
    const sink = typeof document !== 'undefined' ? document.getElementById('jn-err-' + field) : null;
    if (sink) { sink.textContent = text; sink.hidden = false; return true; }
    return false;
  }

  function clearErrors() {
    if (typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply [role="alert"]'), function (el) { el.hidden = true; el.textContent = ''; });
  }

  G.handlers.submit['join-form'] = function (form) {
    const x = cur();
    if (!x || x.busy) return;
    clearErrors();
    x.draft = readForm(form);
    const problem = problemOf(x.draft);
    if (problem) {
      if (!showFieldError(problem.field, problem.text)) { x.error = problem.text; G.app.render(); }
      return;
    }
    x.busy = true; x.error = '';
    const website = form.elements.website ? form.elements.website.value : '';
    G.ui.setBusy(form, true);
    G.api.join.submit(bodyFrom(x.draft, x.token, website)).then(function () {
      x.busy = false; x.done = true;
      G.app.render(true);
    }, function (err) {
      x.busy = false;
      G.ui.setBusy(form, false);
      const text = G.api.classify(err).text;
      if (err && err.field && showFieldError(err.field, text)) return;
      x.error = text;
      G.ui.setText('jn-error', text);
    });
  };

  G.pages.join = { NAME_HINT: NAME_HINT, joinHtml: joinHtml, formHtml: formHtml, load: load, bodyFrom: bodyFrom, problemOf: problemOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
