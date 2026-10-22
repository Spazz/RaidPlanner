// ── PAGE: GUILD SETTINGS > APPLICATIONS ─────────────────────────
// The switch for the guild's apply page (#/apply/:gid) and the questions on it: up to 8, each short text, long text or a choice, required or not. Off by
// default. GET / PUT /api/guild/:gid/applications/settings (guild.teams). The inbox itself is Roster > Applications (pages-applications.js).
(function (G) {
  'use strict';

  const MAX_QUESTIONS = 8;
  const TYPES = [['short', 'Short text'], ['long', 'Long text'], ['choice', 'Choice']];
  const LABEL_MAX = 120;
  const INTRO = 'When applications are on, anyone with the apply address can send a character and answer your questions, signed in or not. They land in Roster > Applications for your officers.';

  function a() { return G.pages.attendance.attState(); }
  function st() { return G.app.state; }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }

  function draftFrom(data) {
    return {
      enabled: !!data.enabled,
      questions: (Array.isArray(data.questions) ? data.questions : []).map(function (q) {
        return { id: q.id, label: q.label, type: q.type, options: (q.options || []).join('\n'), required: !!q.required };
      }),
    };
  }

  // The body of PUT: a question keeps its id; a new one has none.
  function bodyFrom(draft) {
    return {
      enabled: !!draft.enabled,
      questions: draft.questions.map(function (q) {
        const out = { label: String(q.label || '').trim(), type: q.type, required: !!q.required };
        if (q.id) out.id = q.id;
        if (q.type === 'choice') out.options = String(q.options || '').split('\n').map(function (o) { return o.trim(); }).filter(Boolean);
        return out;
      }),
    };
  }

  // The first thing the Worker would refuse that can be seen here: { index, text } or null.
  function problemOf(draft) {
    for (let i = 0; i < draft.questions.length; i++) {
      const q = draft.questions[i];
      const label = String(q.label || '').trim();
      if (!label) return { index: i, text: 'Write the question.' };
      if (Array.from(label).length > LABEL_MAX) return { index: i, text: 'A question is at most ' + LABEL_MAX + ' characters.' };
      if (q.type === 'choice') {
        const options = String(q.options || '').split('\n').map(function (o) { return o.trim(); }).filter(Boolean);
        if (options.length < 2) return { index: i, text: 'A choice needs at least two options, one per line.' };
        if (options.length > 8) return { index: i, text: 'A choice has at most 8 options.' };
      }
    }
    return null;
  }

  // How many things differ from what is saved (the Save bar's count).
  function changeCount(x) { return G.ui.saveBar.draftChanges(bodyFrom(draftFrom(x.data)), bodyFrom(x.draft)); }

  function load(r, gd) {
    return G.api.applications.settings(gd.guild.id).then(function (data) {
      a().settingsApply = { gid: gd.guild.id, data: data, draft: draftFrom(data), note: '', error: '', busy: false };
      return null;
    });
  }

  function questionHtml(q, i) {
    const n = i + 1;
    return '<li class="gs-q-row"><div class="gs-q-head"><h3 class="gs-h3">Question ' + n + '</h3><button type="button" class="gs-btn gs-btn-ghost" data-action="applyq-remove" data-index="' + i + '" data-key="aq-remove-' + i + '" aria-label="Remove question ' + n + '">Remove</button></div>' +
      '<div class="gs-field"><label class="gs-label" for="aq-label-' + i + '">Question</label><input class="gs-input" type="text" id="aq-label-' + i + '" name="label-' + i + '" maxlength="' + LABEL_MAX + '" autocomplete="off" value="' + esc(q.label) + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="aq-type-' + i + '">Answer</label><select class="gs-input" id="aq-type-' + i + '" name="type-' + i + '" data-change="applyq-type" data-index="' + i + '">' +
      G.ui.optionsHtml(TYPES.map(function (t) { return { value: t[0], label: t[1] }; }), q.type) + '</select></div>' +
      (q.type === 'choice' ? '<div class="gs-field"><label class="gs-label" for="aq-options-' + i + '">Options, one per line</label><textarea class="gs-input gs-textarea" id="aq-options-' + i + '" name="options-' + i + '" rows="4">' + esc(q.options) + '</textarea></div>' : '') +
      '<div class="gs-check"><input type="checkbox" id="aq-required-' + i + '" name="required-' + i + '"' + (q.required ? ' checked' : '') + '><label for="aq-required-' + i + '">Required</label></div></li>';
  }

  function addressHtml(d, origin) {
    const url = origin + (typeof d.path === 'string' ? d.path : '');
    return '<div class="gs-panel gs-hd-panel gs-set-body gs-public-url"><label class="gs-label" for="apply-url">Apply address</label>' +
      '<div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="apply-url" readonly autocomplete="off" spellcheck="false" value="' + esc(url) + '">' +
      '<button type="button" class="gs-btn" data-action="apply-copy" data-key="apply-copy">Copy link</button></div>' +
      '<p class="gs-fine" id="apply-copy-status" role="status"></p></div>';
  }

  // opts: { guildData, state: a().settingsApply, alert, origin }
  function settingsHtml(opts) {
    const x = opts.state;
    const d = x.data;
    const draft = x.draft;
    const counts = d.counts || {};
    const full = draft.questions.length >= MAX_QUESTIONS;
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions"></div>' +
      '<p class="gs-lead gs-lead-sm">' + esc(INTRO) + '</p>' + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') +
      (d.enabled ? addressHtml(d, opts.origin == null ? G.ui.pageOrigin() : opts.origin) : '') +
      '<form class="gs-apply-settings" id="apply-form" data-submit="apply-settings-form" data-input="apply-dirty" data-change="apply-dirty" novalidate>' +
      '<div class="gs-hd-panel gs-set-body"><div class="gs-check"><input type="checkbox" id="apply-enabled" name="enabled"' + (draft.enabled ? ' checked' : '') + '><label for="apply-enabled">Take applications</label></div></div>' +
      '<section class="gs-hd-panel gs-q-panel" aria-labelledby="apply-q-h"><div class="gs-q-panel-head"><h3 class="gs-h3 gs-set-h" id="apply-q-h">Your questions (' + draft.questions.length + ' of ' + MAX_QUESTIONS + ')</h3>' +
      '<p class="gs-fine">Every application asks for the character name, class and spec, the realm and the team. These are on top of that.</p></div>' +
      (draft.questions.length ? '<ol class="gs-q-list">' + draft.questions.map(questionHtml).join('') + '</ol>' : '<p class="gs-empty gs-q-empty">No questions yet.</p>') +
      '<div class="gs-row-actions gs-q-add"><button type="button" class="gs-btn" data-action="applyq-add" data-key="aq-add"' + (full ? ' disabled' : '') + '>Add a question</button></div></section>' +
      '<p class="gs-alert" id="apply-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      G.ui.saveBarHtml({ count: changeCount(x), busy: x.busy, discardAttrs: { 'data-action': 'apply-discard', 'data-key': 'apply-discard' } }) + '</form>' +
      (counts.new || counts.reviewing ? '<p class="gs-fine">' + esc((counts.new || 0) + ' new and ' + (counts.reviewing || 0) + ' being reviewed') + ' in <a href="' + esc(G.router.format({ name: 'applications', gid: opts.guildData.guild.id })) + '">the inbox</a>.</p>' : '') + '</section>';
  }

  function main(r, gd, ctx) {
    const x = a().settingsApply;
    if (!x || x.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'applications', settingsHtml({ guildData: gd, state: x, alert: st().pageAlert }));
  }

  // ── handlers ──
  function cur() {
    const x = a().settingsApply;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id ? x : null;
  }

  // The form's values into the draft, before anything redraws the page.
  function sync(x) {
    if (typeof document === 'undefined') return;
    const form = document.querySelector('.gs-apply-settings');
    if (!form) return;
    x.draft.enabled = !!form.elements.enabled.checked;
    x.draft.questions.forEach(function (q, i) {
      const el = function (name) { return form.elements[name + '-' + i]; };
      if (el('label')) q.label = el('label').value;
      if (el('type')) q.type = el('type').value;
      if (el('options')) q.options = el('options').value;
      if (el('required')) q.required = !!el('required').checked;
    });
  }

  G.handlers.click['applyq-add'] = function () {
    const x = cur();
    if (!x || x.draft.questions.length >= MAX_QUESTIONS) return;
    sync(x);
    x.draft.questions.push({ id: '', label: '', type: 'short', options: '', required: false });
    x.note = ''; x.error = '';
    G.app.render();
    G.ui.focusByKey('aq-add', { preventScroll: true });
  };

  G.handlers.click['applyq-remove'] = function (el) {
    const x = cur();
    if (!x) return;
    sync(x);
    x.draft.questions.splice(Number(el.getAttribute('data-index')), 1);
    x.note = ''; x.error = '';
    G.app.render();
  };

  G.handlers.change['applyq-type'] = function () {
    const x = cur();
    if (!x) return;
    sync(x);
    G.app.render();
  };

  // Typing, ticking or choosing in the form: the draft follows, and the Save bar with it (nothing is drawn again).
  G.handlers.input['apply-dirty'] = G.handlers.change['apply-dirty'] = function () {
    const x = cur();
    if (!x) return;
    sync(x);
    G.ui.saveBar.setCount(null, changeCount(x));
  };

  G.handlers.click['apply-discard'] = function () {
    const x = cur();
    if (!x) return;
    x.draft = draftFrom(x.data);
    x.error = '';
    G.app.render();
  };

  G.handlers.click['apply-copy'] = function () {
    const input = document.getElementById('apply-url');
    G.ui.copyInput(input).then(function (copied) {
      G.ui.setText('apply-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected link.');
    });
  };

  G.handlers.submit['apply-settings-form'] = function () {
    const x = cur();
    if (!x || x.busy) return;
    sync(x);
    const problem = problemOf(x.draft);
    if (problem) {
      x.error = 'Question ' + (problem.index + 1) + ': ' + problem.text;
      G.app.render();
      return;
    }
    x.busy = true; x.error = ''; x.note = '';
    G.app.render();
    G.api.applications.saveSettings(x.gid, bodyFrom(x.draft)).then(function (data) {
      x.data = data; x.draft = draftFrom(data); x.busy = false;
      x.note = data.enabled ? 'Applications are on.' : 'Applications are off.';
      G.app.markSettingsSaved('applications');
      G.app.render();
    }, function (err) {
      x.busy = false;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      x.error = (typeof err.index === 'number' ? 'Question ' + (err.index + 1) + ': ' : '') + cl.text;
      G.app.render();
    });
  };

  G.pages.settingsApply = { MAX_QUESTIONS: MAX_QUESTIONS, TYPES: TYPES, draftFrom: draftFrom, bodyFrom: bodyFrom, problemOf: problemOf, load: load, main: main, settingsHtml: settingsHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
