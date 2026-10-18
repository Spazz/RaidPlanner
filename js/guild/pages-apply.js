// ── PAGE: THE APPLICATION FORM (#/apply/:gid, works signed out; a T3 form page) ─
// What an applicant sees: the guild, the officers' questions and a form for their character (name, class, spec, realm for a realm guild, the team they
// want, how to reach them, the answers). No account is needed; an applicant who is signed in is told their account comes along and is linked if an
// officer accepts them. GET /api/apply/:gid (also hands the browser the cookie the POST needs), POST /api/apply/:gid. A hidden "website" field catches
// scripts: it stays empty for a person. The Worker limits applications per browser and per guild (worker/routes/applications.js).
// Fields are the kit's (label above, 44 px on a phone, "(required)" in words) and are checked when the person leaves one and again on Send: the message sits under the
// field and says what to do; Send focuses the first one.
(function (G) {
  'use strict';

  const NAME_HINT = 'Your character\'s name, 2 to 12 letters.';
  const NAME_HINT_FOREVER = 'Your character\'s name: a first name, then a surname if it has one, 2 to 12 letters each.';

  function st() { return G.app.state; }
  function optionsOf(data) { return G.ui.rosterOptions({ rosterOptions: data.rosterOptions }); }

  function whereText(guild) {
    const line = G.ui.realmLine(guild);
    return (guild.realmKind === 'ruleset' || !guild.region ? line : line + ' (' + guild.region + ')') + ' - ' + G.ui.gameVersionLabel(guild.gameVersion);
  }

  // The field ids (ap-<name>) by the Worker's field names; an answer is ap-q-<question id>.
  function fieldId(field) {
    if (field === 'teamId') return 'ap-team';
    if (typeof field === 'string' && field.indexOf('answers.') === 0) return 'ap-q-' + field.slice('answers.'.length);
    return 'ap-' + field;
  }

  function questionHtml(q, draft) {
    const id = 'ap-q-' + q.id;
    const value = draft && draft.answers && draft.answers[q.id] ? draft.answers[q.id] : '';
    const attrs = { 'data-change': 'apply-field' };
    const base = { id: id, name: 'q:' + q.id, label: q.label + (q.required ? '' : ' (optional)'), required: !!q.required, value: value, attrs: attrs };
    if (q.type === 'long') return G.ui.fieldHtml(Object.assign(base, { kind: 'textarea', rows: 4, maxlength: 1500 }));
    if (q.type === 'choice') return G.ui.fieldHtml(Object.assign(base, { kind: 'select', options: [{ value: '', label: 'Choose one' }].concat(q.options.map(function (o) { return { value: o, label: o }; })) }));
    return G.ui.fieldHtml(Object.assign(base, { kind: 'text', maxlength: 200, autocomplete: 'off' }));
  }

  function signinNoteHtml(data) {
    if (data.signedInAs) return G.ui.bannerHtml({ tone: 'info', dismissible: false, text: 'Signed in as ' + data.signedInAs + '. If an officer accepts you, your account is linked to your character.' });
    return '<p class="gs-fine">You can apply without an account. If you sign in first, your account is linked to your character when an officer accepts you. <a href="' + esc(G.router.format({ name: 'signin' })) + '">Sign in</a>, then open this page again.</p>';
  }

  function formHtml(x) {
    const data = x.data;
    const d = x.draft || {};
    const options = optionsOf(data);
    const realmGuild = data.guild.realmKind !== 'ruleset';
    const field = function (o) { return G.ui.fieldHtml(Object.assign({ attrs: { 'data-change': 'apply-field' } }, o)); };
    const team = data.teams.length > 1
      ? field({ id: 'ap-team', name: 'teamId', label: 'Team', kind: 'select', required: true, value: d.teamId || '', options: [{ value: '', label: 'Choose a team' }].concat(data.teams.map(function (t) { return { value: t.id, label: t.name }; })) })
      : '';
    const classSelect = G.ui.fieldHtml({ id: 'ap-class', name: 'class', label: 'Class', kind: 'select', required: true, value: d.class || '', attrs: { 'data-change': 'apply-class' },
      options: G.ui.classChoices(options, 'Choose a class') });
    return '<form class="gs-apply-form" data-submit="apply-form" novalidate aria-describedby="ap-intro">' +
      '<div data-error-summary-slot></div>' +
      field({ id: 'ap-name', name: 'name', label: 'Character name', kind: 'text', required: true, value: d.name || '', maxlength: 40, autocomplete: 'off', help: data.guild.gameVersion === 'forever' ? NAME_HINT_FOREVER : NAME_HINT }) +
      classSelect +
      field({ id: 'ap-spec', name: 'spec', label: 'Spec', kind: 'select', required: true, value: d.spec || '', options: G.ui.specChoices(options, d.class || '', 'Choose a spec') }) +
      (realmGuild ? field({ id: 'ap-realm', name: 'realm', label: 'Realm', kind: 'text', value: d.realm === undefined ? data.guild.realm : d.realm, maxlength: 40, autocomplete: 'off' }) : '') +
      team +
      field({ id: 'ap-contact', name: 'contact', label: 'How can the officers reach you? (optional)', kind: 'text', value: d.contact || '', maxlength: 100, autocomplete: 'off', placeholder: 'Discord name, BattleTag' }) +
      data.questions.map(function (q) { return questionHtml(q, d); }).join('') +
      '<div class="gs-hp" aria-hidden="true"><label for="ap-website">Leave this empty</label><input type="text" id="ap-website" name="website" tabindex="-1" autocomplete="off" value=""></div>' +
      '<p class="gs-alert" id="ap-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Send application', variant: 'primary', type: 'submit', disabled: !!x.busy, attrs: { 'data-key': 'ap-submit' } }) + '</div></form>';
  }

  function doneHtml(data) {
    return G.ui.bannerHtml({ tone: 'success', dismissible: false, title: 'Application sent', text: 'The officers of ' + data.guild.name + ' will look at it. You do not need to do anything else.', id: 'ap-done-h' });
  }

  // opts: { state } (st().apply) -> the page.
  function applyHtml(opts) {
    const x = opts.state;
    if (!x || x.status === 'loading') return G.pages.signin.loadingHtml();
    if (x.status === 'closed') {
      return G.pages.signin.messageHtml('Not taking applications', 'This guild is not taking applications right now. Ask an officer in the guild\'s Discord.', {});
    }
    if (x.status === 'error') return G.pages.signin.messageHtml('Could not open the form', x.message || 'Something went wrong. Try again in a moment.', { retry: true });
    const data = x.data;
    return G.ui.formPageHtml({
      pageClass: 'gs-apply',
      head: { title: 'Apply to ' + data.guild.name, context: whereText(data.guild) },
      bodyHtml: x.done ? doneHtml(data) : '<p class="gs-lead gs-lead-sm" id="ap-intro">Tell the officers who you play and a little about yourself.</p>' + signinNoteHtml(data) + formHtml(x),
    });
  }

  function load(route) {
    const gid = route.gid;
    const x = st().apply = { gid: gid, status: 'loading', data: null, draft: {}, busy: false, error: '', done: false, message: '' };
    return G.api.apply.form(gid).then(function (data) {
      if (st().apply !== x) return x;
      x.status = 'ok';
      x.data = data;
      return x;
    }, function (err) {
      if (st().apply !== x) return x;
      x.status = err && err.status === 404 ? 'closed' : 'error';
      x.message = G.api.classify(err).text;
      return x;
    });
  }

  // ── the form ──
  function cur() {
    const x = st().apply;
    return x && x.status === 'ok' && !x.done ? x : null;
  }

  G.handlers.change['apply-class'] = function (sel) {
    const x = cur();
    const form = sel.closest ? sel.closest('form') : null;
    if (!x || !form) return;
    form.elements.spec.innerHTML = G.ui.specOptionsHtml(optionsOf(x.data), sel.value, '', 'Choose a spec');
    G.ui.setFieldError(form, 'ap-class', rulesFor(x.data)['ap-class'](sel.value));
  };

  // A field is checked when the person leaves it (the change event) and again on Send.
  G.handlers.change['apply-field'] = function (el) {
    const x = cur();
    const form = el.closest ? el.closest('form') : null;
    const rule = x && el.id ? rulesFor(x.data)[el.id] : null;
    if (!form || !rule) return;
    G.ui.setFieldError(form, el.id, rule(el.value));
  };

  function readForm(form, x) {
    const v = function (name) { return form.elements[name] ? String(form.elements[name].value == null ? '' : form.elements[name].value) : ''; };
    const answers = {};
    x.data.questions.forEach(function (q) { answers[q.id] = v('q:' + q.id); });
    const draft = { name: v('name').trim(), class: v('class'), spec: v('spec'), contact: v('contact').trim(), teamId: v('teamId'), answers: answers };
    if (form.elements.realm) draft.realm = v('realm').trim();
    return draft;
  }

  // The body of POST: keys with nothing to say are left out; the hidden field travels as it is (empty for a person).
  function bodyFrom(draft, data, website) {
    const body = { name: draft.name, class: draft.class, spec: draft.spec, website: website || '' };
    if (draft.teamId) body.teamId = draft.teamId;
    else if (data.teams.length === 1) body.teamId = data.teams[0].id;
    if (draft.realm) body.realm = draft.realm;
    if (draft.contact) body.contact = draft.contact;
    const answers = {};
    data.questions.forEach(function (q) { if (draft.answers && draft.answers[q.id]) answers[q.id] = draft.answers[q.id]; });
    body.answers = answers;
    return body;
  }

  // The first thing the Worker would refuse that can be seen here: { field, text } or null.
  function problemOf(draft, data) {
    if (!draft.name) return { field: 'name', text: 'Enter your character\'s name.' };
    if (!draft.class) return { field: 'class', text: 'Choose a class.' };
    if (!draft.spec) return { field: 'spec', text: 'Choose a spec.' };
    if (data.teams.length > 1 && !draft.teamId) return { field: 'teamId', text: 'Choose a team.' };
    const missing = data.questions.filter(function (q) { return q.required && !String((draft.answers || {})[q.id] || '').trim(); })[0];
    if (missing) return { field: 'answers.' + missing.id, text: 'Answer this question.' };
    return null;
  }

  // The rules of the form by field id (ui.validateForm): what to do, not what is wrong.
  function rulesFor(data) {
    const blank = function (message) { return function (value) { return String(value == null ? '' : value).trim() ? '' : message; }; };
    const rules = {
      'ap-name': blank('Enter your character\'s name.'),
      'ap-class': blank('Choose a class.'),
      'ap-spec': blank('Choose a spec.'),
    };
    if (data.teams.length > 1) rules['ap-team'] = blank('Choose a team.');
    data.questions.forEach(function (q) { if (q.required) rules['ap-q-' + q.id] = blank('Answer this question.'); });
    return rules;
  }

  // Is there a message slot under that field? (A refusal that names a field nobody can see goes to the general line.)
  function hasErrorSlot(form, id) {
    const inForm = form && form.querySelector ? form.querySelector('#' + id + '-err') : null;
    return !!(inForm || (typeof document !== 'undefined' && document.getElementById && document.getElementById(id + '-err')));
  }

  // The draft by field id: what the rules check (the form was just read into it).
  function valuesOf(draft, data) {
    const given = { 'ap-name': draft.name, 'ap-class': draft.class, 'ap-spec': draft.spec, 'ap-team': draft.teamId };
    data.questions.forEach(function (q) { given['ap-q-' + q.id] = (draft.answers || {})[q.id] || ''; });
    return given;
  }

  function clearErrors(form) {
    if (typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply .gs-field-error'), function (el) { el.hidden = true; el.textContent = ''; });
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply [aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    G.ui.setText('ap-error', '');
  }

  G.handlers.submit['apply-form'] = function (form) {
    const x = cur();
    if (!x || x.busy) return;
    clearErrors(form);
    x.draft = readForm(form, x);
    if (!G.ui.validateForm(form, rulesFor(x.data), valuesOf(x.draft, x.data)).ok) return;
    x.busy = true; x.error = '';
    const website = form.elements.website ? form.elements.website.value : '';
    G.ui.setBusy(form, true);
    G.api.apply.submit(x.gid, bodyFrom(x.draft, x.data, website)).then(function () {
      x.busy = false; x.done = true;
      G.app.render(true);
    }, function (err) {
      x.busy = false;
      G.ui.setBusy(form, false);
      const text = G.api.classify(err).text;
      if (err && err.field && hasErrorSlot(form, fieldId(err.field))) { G.ui.setFieldError(form, fieldId(err.field), text); G.ui.focusFirstInvalid(form); return; }
      x.error = text;
      G.ui.setText('ap-error', text);
    });
  };

  G.pages.apply = { NAME_HINT: NAME_HINT, applyHtml: applyHtml, formHtml: formHtml, load: load, bodyFrom: bodyFrom, problemOf: problemOf, rulesFor: rulesFor, fieldId: fieldId };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
