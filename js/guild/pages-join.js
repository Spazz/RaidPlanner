// ── PAGE: A RAID'S GUEST SIGN-UP LINK (#/join/<token>, works signed out; a T3 form page) ─
// What a guest sees: the guild and the raid an officer made the link for, and a small form - the character's name, class and spec, and a note. No account is
// needed (and a member of another guild may use it). POST /api/join/view (also hands the browser the cookie the sign-up needs), POST /api/join. A hidden
// "website" field catches scripts. The Worker limits sign-ups per browser, per link and per raid (worker/routes/join.js). Guests are listed as Guests.
// The raid's start is written in the GUILD's zone ("Wed Oct 21, 8:00 PM ET", guild.timeZone in the payload), not the visitor's. Fields are the kit's and are checked
// when the person leaves one and again on Sign up.
(function (G) {
  'use strict';

  const NAME_HINT = 'Your character\'s name, 2 to 12 letters.';
  const NAME_HINT_FOREVER = 'Your character\'s name: a first name, then a surname if it has one, 2 to 12 letters each.';

  function st() { return G.app.state; }
  function optionsOf(data) { return G.ui.rosterOptions({ rosterOptions: data.rosterOptions }); }

  function whenText(raid, zone) {
    if (raid.timeKnown === false) return G.ui.weekdayDay(raid.raidOn) || raid.raidOn;
    return G.ui.dateTimeInZone(raid.startsAt, zone) || G.ui.weekdayDay(raid.raidOn) || raid.raidOn;
  }

  function raidLine(data) {
    const raid = data.raid;
    const what = [raid.title, raid.zone].filter(Boolean).join(' - ');
    return [what, raid.teamName, whenText(raid, data.guild.timeZone)].filter(Boolean).join(' - ');
  }

  // The form of a join link and of an open raid (pages-open-raid.js). o: { submit (the data-submit name, default 'join-form'), identityHtml (replaces the Character name and
  // Class fields: the open sign-up of an in-game guild picks a Battle.net character instead), specClass (the class whose specs the Spec select lists) }.
  function formHtml(x, o) {
    const opts = o || {};
    const data = x.data;
    const d = x.draft || {};
    const options = optionsOf(data);
    const check = { 'data-change': 'join-field' };
    const identity = opts.identityHtml != null ? opts.identityHtml :
      G.ui.fieldHtml({ id: 'jn-name', name: 'name', label: 'Character name', kind: 'text', required: true, value: d.name || '', maxlength: 40, autocomplete: 'off', attrs: check,
        help: data.guild.gameVersion === 'forever' ? NAME_HINT_FOREVER : NAME_HINT }) +
      G.ui.fieldHtml({ id: 'jn-class', name: 'class', label: 'Class', kind: 'select', required: true, value: d.class || '', attrs: { 'data-change': 'join-class' }, options: G.ui.classChoices(options, 'Choose a class') });
    return '<form class="gs-apply-form" data-submit="' + esc(opts.submit || 'join-form') + '" novalidate aria-describedby="jn-intro">' +
      '<div data-error-summary-slot></div>' + identity +
      G.ui.fieldHtml({ id: 'jn-spec', name: 'spec', label: 'Spec', kind: 'select', required: true, value: d.spec || '', attrs: check, options: G.ui.specChoices(options, opts.specClass != null ? opts.specClass : (d.class || ''), 'Choose a spec') }) +
      G.ui.fieldHtml({ id: 'jn-note', name: 'note', label: 'A note for the officers (optional)', kind: 'text', value: d.note || '', maxlength: data.noteMax || 120, autocomplete: 'off', placeholder: 'Your guild, gear, anything they should know' }) +
      '<div class="gs-hp" aria-hidden="true"><label for="jn-website">Leave this empty</label><input type="text" id="jn-website" name="website" tabindex="-1" autocomplete="off" value=""></div>' +
      '<p class="gs-alert" id="jn-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Sign up as a guest', variant: 'primary', type: 'submit', disabled: !!x.busy, attrs: { 'data-key': 'jn-submit' } }) + '</div></form>';
  }

  function doneHtml(data) {
    return G.ui.bannerHtml({ tone: 'success', dismissible: false, title: 'You are signed up', id: 'jn-done-h',
      text: 'The officers of ' + data.guild.name + ' can see you for ' + whenText(data.raid, data.guild.timeZone) + '. You do not need to do anything else.' });
  }

  // The places left, as a sentence that follows the intro; nothing when the number is missing (an open raid with no guest limit has none to show).
  function spotsText(left) {
    if (typeof left !== 'number') return '';
    return left === 1 ? ' One spot is left on the link.' : ' ' + left + ' spots are left on the link.';
  }

  // opts: { state } (st().join) -> the page.
  function joinHtml(opts) {
    const x = opts.state;
    if (!x || x.status === 'loading') return G.pages.signin.loadingHtml();
    if (x.status === 'gone') return G.pages.signin.messageHtml(x.title || 'This link does not work', x.message || 'Ask the officer who sent it for a new one.', {});
    if (x.status === 'error') return G.pages.signin.messageHtml('Could not open the sign-up', x.message || 'Something went wrong. Try again in a moment.', { retry: true });
    const data = x.data;
    return G.ui.formPageHtml({
      pageClass: 'gs-apply',
      head: { title: 'Sign up for ' + data.guild.name, context: raidLine(data) },
      bodyHtml: x.done ? doneHtml(data) : '<p class="gs-lead gs-lead-sm" id="jn-intro">An officer shared this link so you can join this raid as a guest.' + esc(spotsText(data.spotsLeft)) + '</p>' + formHtml(x),
    });
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
    G.ui.setFieldError(form, 'jn-class', RULES['jn-class'](sel.value));
  };

  // A field is checked when the person leaves it (the change event) and again on Sign up.
  G.handlers.change['join-field'] = function (el) {
    const form = el.closest ? el.closest('form') : null;
    const rule = el.id ? RULES[el.id] : null;
    if (!form || !rule) return;
    G.ui.setFieldError(form, el.id, rule(el.value));
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

  // The rules of the form by field id (ui.validateForm): what to do, not what is wrong.
  const blank = function (message) { return function (value) { return String(value == null ? '' : value).trim() ? '' : message; }; };
  const RULES = { 'jn-name': blank('Enter your character\'s name.'), 'jn-class': blank('Choose a class.'), 'jn-spec': blank('Choose a spec.') };

  // Is there a message slot under that field? (A refusal that names a field nobody can see goes to the general line.)
  function hasErrorSlot(form, id) {
    const inForm = form && form.querySelector ? form.querySelector('#' + id + '-err') : null;
    return !!(inForm || (typeof document !== 'undefined' && document.getElementById && document.getElementById(id + '-err')));
  }

  function clearErrors() {
    if (typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply .gs-field-error'), function (el) { el.hidden = true; el.textContent = ''; });
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply [aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    G.ui.setText('jn-error', '');
  }

  G.handlers.submit['join-form'] = function (form) {
    const x = cur();
    if (!x || x.busy) return;
    clearErrors();
    x.draft = readForm(form);
    if (!G.ui.validateForm(form, RULES, { 'jn-name': x.draft.name, 'jn-class': x.draft.class, 'jn-spec': x.draft.spec }).ok) return;
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
      const id = err && err.field ? 'jn-' + (err.field === 'spec' || err.field === 'class' || err.field === 'name' || err.field === 'note' ? err.field : '') : '';
      if (id && id !== 'jn-' && hasErrorSlot(form, id)) { G.ui.setFieldError(form, id, text); G.ui.focusFirstInvalid(form); return; }
      x.error = text;
      G.ui.setText('jn-error', text);
    });
  };

  G.pages.join = { NAME_HINT: NAME_HINT, joinHtml: joinHtml, formHtml: formHtml, load: load, bodyFrom: bodyFrom, problemOf: problemOf, whenText: whenText, raidLine: raidLine, spotsText: spotsText, RULES: RULES };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
