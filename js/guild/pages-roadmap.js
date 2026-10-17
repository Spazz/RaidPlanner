// ── PAGE: FUTURE ENHANCEMENTS (#/roadmap) ───────────────────────
// What is being built next and the ideas under review (the list is js/guild/roadmap-data.js), plus the idea box: a signed-in
// person suggests an idea (POST /api/roadmap/ideas) and reads the submitted ones (GET). The roadmap sections never wait for the
// API: the submitted-ideas part has its own loading and error lines and is repainted in place, so a form being typed in is not
// rewritten. Signed-out visitors read the same sections and get a sign-in link in place of the form. The filter and the open
// Shipped section live in memory (G.app.state.roadmap), like the other pages' filters.
(function (G) {
  'use strict';

  // The same list as the CHECK in migrations/0007_roadmap_ideas.sql and IDEA_AREAS in worker/routes/roadmap.js (guild-roadmap-worker-tests.js keeps them equal).
  const AREAS = ['loot', 'roster', 'raids', 'attendance', 'signups', 'planner', 'discord', 'battlenet', 'platform', 'guilds', 'other'];
  const AREA_LABELS = {
    loot: 'Loot', roster: 'Roster', raids: 'Raids', attendance: 'Attendance', signups: 'Sign-ups', planner: 'Planner',
    discord: 'Discord', battlenet: 'Battle.net', platform: 'Platform', guilds: 'Guilds', other: 'Other',
  };
  const STATUSES = ['in_progress', 'next', 'idea', 'done'];
  const SOURCES = ['user', 'backlog', 'pm'];
  const SOURCE_LABELS = { user: 'You asked', backlog: 'Agreed backlog', pm: 'Product Manager idea' };
  const SECTIONS = [
    { status: 'in_progress', title: 'In progress', empty: 'Nothing is in progress right now.' },
    { status: 'next', title: 'Next up', empty: 'Nothing is lined up next.' },
    { status: 'idea', title: 'Ideas', empty: 'No ideas are under review.' },
    { status: 'done', title: 'Shipped', empty: 'Nothing has shipped yet.' },
  ];
  // The status chip of a submitted idea: its pill colour and the words beside it.
  const IDEA_STATUS = {
    new: { label: 'New', kind: 'info', note: 'Waiting for review' },
    added: { label: 'Added to the roadmap', kind: 'ok', note: '' },
    declined: { label: 'Declined', kind: 'muted', note: '' },
    done: { label: 'Done', kind: 'ok', note: '' },
  };
  const MIN_TITLE = 3;
  const MAX_TITLE = 120;
  const MAX_DETAILS = 2000;
  const IDEAS_SHOWN = 5;
  const THANKS = 'Thanks - your idea is saved and will be reviewed.';
  let ideasToken = 0;

  function emptyDraft() { return { title: '', area: '', details: '' }; }

  // The page's in-memory state; a fresh one is what a visit starts with.
  function freshView() {
    return { area: 'all', shippedOpen: false, ideasAll: false, draft: emptyDraft(), notice: '', ideas: { status: 'loading', list: [], error: '' } };
  }

  function viewState() {
    const state = G.app.state;
    if (!state.roadmap) state.roadmap = freshView();
    return state.roadmap;
  }

  function itemsOf(data) { return data && Array.isArray(data.items) ? data.items : []; }
  function has(map, key) { return Object.prototype.hasOwnProperty.call(map, key); }
  function areaLabel(area) { return has(AREA_LABELS, area) ? AREA_LABELS[area] : String(area == null ? '' : area); }
  function sourceLabel(source) { return has(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : String(source == null ? '' : source); }

  // ── the roadmap ──
  function cardHtml(item) {
    const done = item.status === 'done';
    const date = done ? 'Shipped ' + G.ui.formatDay(item.shipped) : 'Added ' + G.ui.formatDay(item.added);
    return '<li class="gs-rm-card" id="rm-item-' + esc(item.id) + '" tabindex="-1"><h3 class="gs-rm-title">' + esc(item.title) + '</h3>' +
      '<p class="gs-rm-summary">' + esc(item.summary) + '</p>' +
      (item.why ? '<p class="gs-fine gs-rm-why">' + esc(item.why) + '</p>' : '') +
      '<div class="gs-chips gs-rm-meta"><span class="gs-chip">' + esc(areaLabel(item.area)) + '</span><span class="gs-chip gs-chip-src">' + esc(sourceLabel(item.source)) +
      '</span><span class="gs-fine">' + esc(date) + '</span></div></li>';
  }

  // Shipped items, newest first (ties keep the file's order); the other statuses keep the file's order.
  function itemsFor(items, status) {
    const list = items.filter(function (item) { return item.status === status; });
    if (status !== 'done') return list;
    return list.slice().sort(function (a, b) { return a.shipped < b.shipped ? 1 : (a.shipped > b.shipped ? -1 : 0); });
  }

  function filtersHtml(items, area) {
    const counts = {};
    items.forEach(function (item) { counts[item.area] = (counts[item.area] || 0) + 1; });
    const buttons = [{ id: 'all', label: 'All', n: items.length }].concat(AREAS.filter(function (a) { return counts[a]; }).map(function (a) {
      return { id: a, label: AREA_LABELS[a], n: counts[a] };
    }));
    return '<div class="gs-segs gs-rm-filters" role="group" aria-label="Filter by area">' + buttons.map(function (b) {
      return '<button type="button" class="gs-seg" data-action="roadmap-area" data-area="' + esc(b.id) + '" data-key="rm-area-' + esc(b.id) + '" aria-pressed="' + (b.id === area ? 'true' : 'false') + '">' +
        esc(b.label) + ' <span class="gs-seg-count">' + b.n + '</span></button>';
    }).join('') + '</div>';
  }

  function sectionHtml(section, items, filtered, view) {
    const list = itemsFor(items, section.status);
    const count = '<span class="gs-rm-count">' + list.length + '</span>';
    const body = list.length
      ? '<ul class="gs-rm-list">' + list.map(cardHtml).join('') + '</ul>'
      : '<p class="gs-empty">' + esc(filtered ? 'Nothing here for this area.' : section.empty) + '</p>';
    const id = 'rm-h-' + section.status;
    const inner = section.status === 'done'
      ? '<details class="gs-how gs-rm-shipped"' + (view.shippedOpen ? ' open' : '') + '><summary data-action="roadmap-shipped" data-key="rm-shipped">Show shipped items</summary>' + body + '</details>'
      : body;
    return '<section class="gs-rm-section" aria-labelledby="' + id + '"><h2 class="gs-h2 gs-h2-plain" id="' + id + '">' + esc(section.title) + ' ' + count + '</h2>' + inner + '</section>';
  }

  // ── the idea box ──
  function fieldHtml(id, label, control, hint) {
    return '<div class="gs-field"><label class="gs-label" for="' + id + '">' + label + '</label>' + control + (hint ? '<p class="gs-fine" id="' + id + '-hint">' + hint + '</p>' : '') +
      '<p class="gs-field-error" id="' + id + '-error" role="alert" hidden></p></div>';
  }

  function describedBy(id, hint) { return ' aria-describedby="' + id + (hint ? '-hint ' + id : '') + '-error"'; }

  function formHtml(view) {
    const d = view.draft || emptyDraft();
    const areaOptions = G.ui.optionsHtml([{ value: '', label: 'Choose an area' }].concat(AREAS.map(function (a) { return { value: a, label: AREA_LABELS[a] }; })), d.area);
    return '<section class="gs-panel gs-rm-suggest" aria-labelledby="rm-suggest-h"><h2 class="gs-h2 gs-h2-plain" id="rm-suggest-h">Suggest an idea</h2>' +
      '<p class="gs-fine">Tell us what would make Raidsmith better. Everyone who is signed in can read the ideas below, without your name.</p>' +
      '<form class="gs-rm-form" data-submit="roadmap-idea" aria-labelledby="rm-suggest-h" novalidate>' +
      fieldHtml('rm-title', 'Title', '<input class="gs-input" type="text" id="rm-title" name="title" value="' + esc(d.title) + '" maxlength="' + MAX_TITLE + '" autocomplete="off" required data-input="roadmap-draft"' + describedBy('rm-title') + '>') +
      fieldHtml('rm-area', 'Area', '<select class="gs-input" id="rm-area" name="area" required data-change="roadmap-draft"' + describedBy('rm-area') + '>' + areaOptions + '</select>') +
      fieldHtml('rm-details', 'Details (optional)', '<textarea class="gs-input gs-textarea" id="rm-details" name="details" rows="4" maxlength="' + MAX_DETAILS + '" data-input="roadmap-draft"' + describedBy('rm-details', true) + '>' + esc(d.details) + '</textarea>',
        'What would it fix or make easier? Up to ' + MAX_DETAILS + ' characters.') +
      '<p class="gs-alert" id="rm-form-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="rm-submit">Submit idea</button>' +
      '<span class="gs-rm-status" id="rm-status" role="status">' + esc(view.notice || '') + '</span></div></form></section>';
  }

  function signinHtml() {
    return '<section class="gs-panel gs-rm-suggest" aria-labelledby="rm-suggest-h"><h2 class="gs-h2 gs-h2-plain" id="rm-suggest-h">Suggest an idea</h2>' +
      '<p class="gs-rm-signin"><a href="/auth/login">Sign in to suggest an idea</a></p></section>';
  }

  function ideaHtml(idea, items) {
    const status = has(IDEA_STATUS, idea.status) ? IDEA_STATUS[idea.status] : IDEA_STATUS.new;
    const linked = idea.roadmapId ? items.filter(function (item) { return item.id === idea.roadmapId; })[0] : null;
    const follow = (status.note ? '<span class="gs-fine">' + esc(status.note) + '</span>' : '') +
      (linked ? '<a href="' + esc(G.router.format({ name: 'roadmap' })) + '" data-action="roadmap-goto" data-item="' + esc(linked.id) + '">See it on the roadmap</a>' : '');
    return '<li class="gs-rm-card"><h3 class="gs-rm-title">' + esc(idea.title) + '</h3>' +
      '<div class="gs-chips gs-rm-meta"><span class="gs-pill gs-pill-' + status.kind + '">' + esc(status.label) + '</span>' + follow + '</div>' +
      (idea.details ? '<p class="gs-rm-summary gs-rm-details">' + esc(idea.details) + '</p>' : '') +
      (idea.triageNote ? '<p class="gs-fine gs-rm-why">Note: ' + esc(idea.triageNote) + '</p>' : '') +
      '<div class="gs-chips gs-rm-meta"><span class="gs-chip">' + esc(areaLabel(idea.area)) + '</span>' + (idea.mine ? '<span class="gs-chip gs-chip-plain">Yours</span>' : '') +
      '<span class="gs-fine">Submitted ' + esc(G.ui.formatDate(idea.createdAt)) + '</span></div></li>';
  }

  // The inside of #rm-ideas, which is repainted on its own when the list loads or an idea is added.
  function ideasInnerHtml(view, items) {
    const ideas = view.ideas || { status: 'loading', list: [], error: '' };
    const list = Array.isArray(ideas.list) ? ideas.list : [];
    const shown = view.ideasAll ? list : list.slice(0, IDEAS_SHOWN);
    let body = '';
    if (ideas.status === 'loading' && !list.length) body = '<p class="gs-fine" role="status">Loading the submitted ideas...</p>';
    else if (ideas.status === 'error') {
      body = '<p class="gs-alert" role="alert">The submitted ideas could not be loaded. ' + esc(ideas.error) + '</p>' +
        '<div><button type="button" class="gs-btn gs-btn-sm" data-action="roadmap-ideas-retry" data-key="rm-ideas-retry">Try again</button></div>';
    } else if (!list.length) body = '<p class="gs-empty">No ideas yet. Yours can be the first.</p>';
    if (shown.length) body += '<ul class="gs-rm-list">' + shown.map(function (idea) { return ideaHtml(idea, items); }).join('') + '</ul>';
    if (list.length > IDEAS_SHOWN) {
      body += '<div><button type="button" class="gs-btn gs-btn-sm" data-action="roadmap-ideas-all" data-key="rm-ideas-all" aria-expanded="' + (view.ideasAll ? 'true' : 'false') + '">' +
        (view.ideasAll ? 'Show fewer ideas' : 'Show all ' + list.length + ' ideas') + '</button></div>';
    }
    return '<h2 class="gs-h2 gs-h2-plain" id="rm-ideas-h">Submitted ideas</h2>' + body;
  }

  // opts: { me (null when signed out), data (default G.roadmap), view (default: a fresh visit) }
  function roadmapHtml(opts) {
    const o = opts || {};
    const data = o.data || G.roadmap || { updated: '', items: [] };
    const view = o.view || freshView();
    const items = itemsOf(data);
    const filtered = view.area !== 'all' && items.some(function (item) { return item.area === view.area; });
    const shown = filtered ? items.filter(function (item) { return item.area === view.area; }) : items;
    const updated = G.ui.formatDay(data.updated);
    const signedIn = !!(o.me && o.me.user);
    return '<div class="gs-page gs-page-narrow gs-rm-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Future enhancements</h1>' +
      '<p class="gs-lead gs-lead-sm">What\'s being built next and ideas under review. Updated as work ships.</p>' +
      (updated ? '<p class="gs-sub">Last updated ' + esc(updated) + '</p>' : '') + '</div>' +
      (signedIn ? formHtml(view) + '<section class="gs-rm-ideas" id="rm-ideas" aria-labelledby="rm-ideas-h">' + ideasInnerHtml(view, items) + '</section>' : signinHtml()) +
      filtersHtml(items, filtered ? view.area : 'all') +
      SECTIONS.map(function (section) { return sectionHtml(section, shown, filtered, view); }).join('') + '</div>';
  }

  // ── loading and repainting the submitted ideas ──
  function paintIdeas() {
    const el = document.getElementById('rm-ideas');
    if (!el) return;
    const active = document.activeElement;
    const key = active && active.getAttribute ? active.getAttribute('data-key') : null;
    el.innerHTML = ideasInnerHtml(viewState(), itemsOf(G.roadmap));
    if (key) G.ui.focusByKey(key, { preventScroll: true });
  }

  // Not awaited by the route: the roadmap shows at once and the ideas fill in. A list already read stays up while it reloads.
  function load() {
    const view = viewState();
    const token = ++ideasToken;
    if (view.ideas.status !== 'ok') view.ideas = { status: 'loading', list: [], error: '' };
    return G.api.get('/api/roadmap/ideas').then(function (res) {
      if (token !== ideasToken) return;
      view.ideas = { status: 'ok', list: Array.isArray(res && res.ideas) ? res.ideas : [], error: '' };
      paintIdeas();
    }, function (err) {
      if (token !== ideasToken) return;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      view.ideas = { status: 'error', list: view.ideas.list, error: c.text };
      paintIdeas();
    });
  }

  // ── the form ──
  // -> { field: message }, the same limits the Worker enforces.
  function validate(draft) {
    const d = draft || emptyDraft();
    const errs = {};
    const titleLength = Array.from(String(d.title).trim()).length;
    if (titleLength < MIN_TITLE || titleLength > MAX_TITLE) errs.title = 'Give your idea a title of ' + MIN_TITLE + ' to ' + MAX_TITLE + ' characters.';
    if (AREAS.indexOf(d.area) < 0) errs.area = 'Pick the area your idea belongs to.';
    if (Array.from(String(d.details).trim()).length > MAX_DETAILS) errs.details = 'The details can be at most ' + MAX_DETAILS + ' characters.';
    return errs;
  }

  function showFieldError(form, field, text) {
    if (!document.getElementById('rm-' + field + '-error')) return false;
    G.ui.setText('rm-' + field + '-error', text);
    const input = form.querySelector('#rm-' + field);
    if (input) input.setAttribute('aria-invalid', 'true');
    return true;
  }

  function clearErrors(form) {
    Array.prototype.forEach.call(form.querySelectorAll('.gs-field-error'), function (p) { G.ui.setText(p.id, ''); });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
    G.ui.setText('rm-form-error', '');
  }

  function setStatus(text) {
    const el = document.getElementById('rm-status');
    if (el) el.textContent = text;
  }

  function keepDraft(el) {
    const name = el.getAttribute('name');
    const view = viewState();
    if (name !== 'title' && name !== 'area' && name !== 'details') return;
    view.draft[name] = el.value;
    view.notice = '';
    setStatus('');
  }

  G.handlers.input['roadmap-draft'] = keepDraft;
  G.handlers.change['roadmap-draft'] = keepDraft;

  G.handlers.submit['roadmap-idea'] = function (form) {
    clearErrors(form);
    const view = viewState();
    view.draft = { title: form.elements.title.value, area: form.elements.area.value, details: form.elements.details.value };
    view.notice = '';
    setStatus('');
    const errs = validate(view.draft);
    const fields = Object.keys(errs);
    if (fields.length) {
      fields.forEach(function (f) { showFieldError(form, f, errs[f]); });
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    const body = { title: view.draft.title.trim(), area: view.draft.area };
    if (view.draft.details.trim()) body.details = view.draft.details.trim();
    G.ui.setBusy(form, true);
    G.api.post('/api/roadmap/ideas', body).then(function (res) {
      G.ui.setBusy(form, false);
      view.draft = emptyDraft();
      view.notice = THANKS;
      form.elements.title.value = '';
      form.elements.area.value = '';
      form.elements.details.value = '';
      setStatus(THANKS);
      if (res && res.idea) view.ideas = { status: 'ok', list: [res.idea].concat((view.ideas.list || []).filter(function (i) { return i.id !== res.idea.id; })), error: '' };
      paintIdeas();
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (err.field && showFieldError(form, err.field, c.text)) {
        const input = form.querySelector('#rm-' + err.field);
        if (input) input.focus();
        return;
      }
      G.ui.setText('rm-form-error', c.text);
    });
  };

  // ── filter, Shipped, jump to an item, ideas list ──
  G.handlers.click['roadmap-area'] = function (el) {
    const area = el.getAttribute('data-area');
    viewState().area = AREAS.indexOf(area) >= 0 ? area : 'all';
    G.app.render();
  };

  // The summary opens or closes its <details> after this runs, so the new state is the opposite of what the box shows now.
  G.handlers.click['roadmap-shipped'] = function (el) {
    const box = el.closest ? el.closest('details') : null;
    const view = viewState();
    view.shippedOpen = box ? !box.open : !view.shippedOpen;
  };

  // "See it on the roadmap" (an idea that became an item): clears what hides the card, then scrolls to it.
  G.handlers.click['roadmap-goto'] = function (el, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const id = el.getAttribute('data-item');
    const item = itemsOf(G.roadmap).filter(function (i) { return i.id === id; })[0];
    if (!item) return;
    const view = viewState();
    if (view.area !== 'all' && view.area !== item.area) view.area = 'all';
    if (item.status === 'done') view.shippedOpen = true;
    G.app.render();
    const card = document.getElementById('rm-item-' + id);
    if (!card) return;
    if (card.scrollIntoView) card.scrollIntoView({ block: 'start' });
    card.focus();
  };

  G.handlers.click['roadmap-ideas-all'] = function () {
    const view = viewState();
    view.ideasAll = !view.ideasAll;
    paintIdeas();
  };

  G.handlers.click['roadmap-ideas-retry'] = function () {
    const view = viewState();
    view.ideas = { status: 'loading', list: view.ideas.list, error: '' };
    paintIdeas();
    load();
  };

  G.pages.roadmap = {
    AREAS: AREAS, AREA_LABELS: AREA_LABELS, STATUSES: STATUSES, SOURCES: SOURCES, SOURCE_LABELS: SOURCE_LABELS, IDEA_STATUS: IDEA_STATUS, THANKS: THANKS,
    MIN_TITLE: MIN_TITLE, MAX_TITLE: MAX_TITLE, MAX_DETAILS: MAX_DETAILS,
    freshView: freshView, viewState: viewState, validate: validate, roadmapHtml: roadmapHtml, ideasInnerHtml: ideasInnerHtml, load: load,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
