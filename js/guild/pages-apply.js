// ── PAGE: THE APPLICATION FORM (#/apply/:gid, works signed out) ─
// What an applicant sees: the guild, the officers' questions and a form for their character (name, class, spec, realm for a realm guild, the team they
// want, how to reach them, the answers). No account is needed; an applicant who is signed in is told their account comes along and is linked if an
// officer accepts them. GET /api/apply/:gid (also hands the browser the cookie the POST needs), POST /api/apply/:gid. A hidden "website" field catches
// scripts: it stays empty for a person. The Worker limits applications per browser and per guild (worker/routes/applications.js).
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

  function fieldError(id) { return '<p class="gs-field-error" id="ap-err-' + id + '" role="alert" hidden></p>'; }

  function questionHtml(q, draft) {
    const id = 'ap-q-' + q.id;
    const value = draft && draft.answers && draft.answers[q.id] ? draft.answers[q.id] : '';
    const req = q.required ? ' required' : '';
    let control;
    if (q.type === 'long') control = '<textarea class="gs-input gs-textarea" id="' + id + '" name="q:' + esc(q.id) + '" rows="4" maxlength="1500"' + req + '>' + esc(value) + '</textarea>';
    else if (q.type === 'choice') control = '<select class="gs-input" id="' + id + '" name="q:' + esc(q.id) + '"' + req + '>' + G.ui.optionsHtml([{ value: '', label: 'Choose one' }].concat(q.options.map(function (o) { return { value: o, label: o }; })), value) + '</select>';
    else control = '<input class="gs-input" type="text" id="' + id + '" name="q:' + esc(q.id) + '" maxlength="200" autocomplete="off"' + req + ' value="' + esc(value) + '">';
    return '<div class="gs-field"><label class="gs-label" for="' + id + '">' + esc(q.label) + (q.required ? '' : ' <span class="gs-fine">(optional)</span>') + '</label>' + control + fieldError('answers.' + q.id) + '</div>';
  }

  function signinNoteHtml(data) {
    if (data.signedInAs) return '<p class="gs-notice" role="status"><span>Signed in as ' + esc(data.signedInAs) + '. If an officer accepts you, your account is linked to your character.</span></p>';
    return '<p class="gs-fine">You can apply without an account. If you sign in first, your account is linked to your character when an officer accepts you. <a href="' + esc(G.router.format({ name: 'signin' })) + '">Sign in</a>, then open this page again.</p>';
  }

  function formHtml(x) {
    const data = x.data;
    const d = x.draft || {};
    const options = optionsOf(data);
    const realmGuild = data.guild.realmKind !== 'ruleset';
    const team = data.teams.length > 1
      ? '<div class="gs-field"><label class="gs-label" for="ap-team">Team</label><select class="gs-input" id="ap-team" name="teamId" required>' +
        G.ui.optionsHtml([{ value: '', label: 'Choose a team' }].concat(data.teams.map(function (t) { return { value: t.id, label: t.name }; })), d.teamId || '') + '</select>' + fieldError('teamId') + '</div>'
      : '';
    return '<form class="gs-apply-form" data-submit="apply-form" novalidate aria-describedby="ap-intro">' +
      '<div class="gs-field"><label class="gs-label" for="ap-name">Character name</label><input class="gs-input" type="text" id="ap-name" name="name" maxlength="40" autocomplete="off" required aria-describedby="ap-name-hint" value="' + esc(d.name || '') + '">' +
      '<p class="gs-fine" id="ap-name-hint">' + esc(data.guild.gameVersion === 'forever' ? NAME_HINT_FOREVER : NAME_HINT) + '</p>' + fieldError('name') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="ap-class">Class</label><select class="gs-input" id="ap-class" name="class" data-change="apply-class" required>' + G.ui.classOptionsHtml(options, d.class || '', 'Choose a class') + '</select>' + fieldError('class') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="ap-spec">Spec</label><select class="gs-input" id="ap-spec" name="spec" required>' + G.ui.specOptionsHtml(options, d.class || '', d.spec || '', 'Choose a spec') + '</select>' + fieldError('spec') + '</div>' +
      (realmGuild ? '<div class="gs-field"><label class="gs-label" for="ap-realm">Realm</label><input class="gs-input" type="text" id="ap-realm" name="realm" maxlength="40" autocomplete="off" value="' + esc(d.realm === undefined ? data.guild.realm : d.realm) + '">' + fieldError('realm') + '</div>' : '') +
      team +
      '<div class="gs-field"><label class="gs-label" for="ap-contact">How can the officers reach you? <span class="gs-fine">(optional)</span></label><input class="gs-input" type="text" id="ap-contact" name="contact" maxlength="100" autocomplete="off" placeholder="Discord name, BattleTag" value="' + esc(d.contact || '') + '">' + fieldError('contact') + '</div>' +
      data.questions.map(function (q) { return questionHtml(q, d); }).join('') +
      '<div class="gs-hp" aria-hidden="true"><label for="ap-website">Leave this empty</label><input type="text" id="ap-website" name="website" tabindex="-1" autocomplete="off" value=""></div>' +
      '<p class="gs-alert" id="ap-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="ap-submit"' + (x.busy ? ' disabled' : '') + '>Send application</button></div></form>';
  }

  function doneHtml(data) {
    return '<section class="gs-empty-card" aria-labelledby="ap-done-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="ap-done-h" tabindex="-1">Application sent</h2><p class="gs-lead gs-lead-sm">The officers of ' + esc(data.guild.name) + ' will look at it. You do not need to do anything else.</p></section>';
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
    return '<div class="gs-page gs-page-narrow gs-apply"><div class="gs-page-head"><div><h1 class="gs-h1" tabindex="-1">Apply to ' + esc(data.guild.name) + '</h1><p class="gs-sub">' + esc(whereText(data.guild)) + '</p></div></div>' +
      (x.done ? doneHtml(data) : '<p class="gs-lead gs-lead-sm" id="ap-intro">Tell the officers who you play and a little about yourself.</p>' + signinNoteHtml(data) + formHtml(x)) + '</div>';
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

  function showFieldError(form, field, text) {
    const sink = typeof document !== 'undefined' ? document.getElementById('ap-err-' + field) : null;
    if (sink) { sink.textContent = text; sink.hidden = false; return true; }
    return false;
  }

  function clearErrors() {
    if (typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('.gs-apply [role="alert"]'), function (el) { el.hidden = true; el.textContent = ''; });
  }

  G.handlers.submit['apply-form'] = function (form) {
    const x = cur();
    if (!x || x.busy) return;
    clearErrors();
    x.draft = readForm(form, x);
    const problem = problemOf(x.draft, x.data);
    if (problem) {
      if (!showFieldError(form, problem.field, problem.text)) { x.error = problem.text; G.app.render(); }
      return;
    }
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
      if (err && err.field && showFieldError(form, err.field, text)) return;
      x.error = text;
      G.ui.setText('ap-error', text);
    });
  };

  G.pages.apply = { NAME_HINT: NAME_HINT, applyHtml: applyHtml, formHtml: formHtml, load: load, bodyFrom: bodyFrom, problemOf: problemOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
