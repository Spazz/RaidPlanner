/**
 * PartyPlanner Web - slim phone layout tests
 * Run: node mobile-tests.js
 *
 * What Node can check about the <=600px layout (the pixel measurements are checked in a browser):
 *   - the phone context summary is a real <button> with aria-expanded, collapsed by default, and
 *     its toggle flips aria-expanded / hidden; every control it hides is still in the page
 *   - the phone has no summary line; the missing-buffs link lives on line 2 of the context row and
 *     the desktop chips stay untouched
 *   - the player editor's short view holds exactly the agreed controls and the More view holds the
 *     rest, with every original element ID preserved
 *   - phone-only chrome is hidden outside the media query, and no markup uses inline styles
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = read('index.html');
const css = read('app.css');
const renderJs = read('js/render.js');
const appJs = read('js/app.js');

function between(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing "${start}"`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `missing "${end}" after "${start}"`);
  return src.slice(a, b);
}

// ── Phone context summary ──────────────────────────────────────────

check('phone summary is a real button with aria-expanded=false and aria-controls', () => {
  const m = html.match(/<button\b[^>]*id="phone-summary-toggle"[^>]*>/);
  assert.ok(m, 'button#phone-summary-toggle missing');
  assert.match(m[0], /type="button"/);
  assert.match(m[0], /aria-expanded="false"/);
  const controls = m[0].match(/aria-controls="([^"]+)"/);
  assert.ok(controls, 'aria-controls missing');
  assert.match(html, new RegExp(`id="${controls[1]}"[^>]*\\bhidden\\b`), 'controlled body must exist and start hidden');
});

check('phone summary has the two text lines and an Edit control', () => {
  for (const id of ['phone-summary-main', 'phone-summary-sub', 'phone-summary-edit-label', 'phone-summary-chevron']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="phone-summary-edit-label">Edit</);
});

check('every existing phone control is still in the page (inside the expandable body or the notes slot)', () => {
  const panel = between(html, 'id="phone-context-panel"', '<div class="roster-bar">');
  for (const id of ['mobile-plan-title', 'raid-selector-phone-slot', 'btn-ideal-comp-link-phone', 'phone-context-notes-slot']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} missing from the context panel`);
  }
  const body = between(panel, 'id="phone-context-body"', 'id="phone-context-notes-slot"');
  assert.ok(body.includes('id="raid-selector-phone-slot"'));
  assert.ok(!html.includes('phone-strategy-seg'), 'the optimizer strategy control is gone (Optimize always runs Max DPS)');
  for (const id of ['raid-notes-panel', 'raid-notes-textarea', 'readiness-text', 'summary-bar', 'plan-feedback']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(appJs, /'raid-notes-panel:phone-context-notes-slot'/, 'raid notes move into the panel on phones');
});

check('toggling the summary flips aria-expanded, hidden and the label, and remembers the choice', () => {
  const src = between(appJs, 'const PHONE_CONTEXT_STORAGE_KEY', '(function initPhoneContextToggle');
  const el = (extra = {}) => Object.assign({ attrs: {}, hidden: true, textContent: '', innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } }, extra);
  const nodes = { 'phone-summary-toggle': el(), 'phone-context-body': el(), 'phone-summary-edit-label': el({ textContent: 'Edit' }), 'phone-summary-chevron': el() };
  const stored = {};
  const ctx = vm.createContext({
    document: { getElementById: id => nodes[id] || null },
    sessionStorage: {},
    safeSetItem: (_, k, v) => { stored[k] = v; },
  });
  vm.runInContext(`${src}\nthis.setPhoneContextOpen = setPhoneContextOpen;`, ctx);
  ctx.setPhoneContextOpen(true);
  assert.equal(nodes['phone-summary-toggle'].attrs['aria-expanded'], 'true');
  assert.equal(nodes['phone-context-body'].hidden, false);
  assert.equal(nodes['phone-summary-edit-label'].textContent, 'Done');
  assert.equal(stored.pp_phone_context_open, '1');
  ctx.setPhoneContextOpen(false);
  assert.equal(nodes['phone-summary-toggle'].attrs['aria-expanded'], 'false');
  assert.equal(nodes['phone-context-body'].hidden, true);
  assert.equal(nodes['phone-summary-edit-label'].textContent, 'Edit');
  assert.equal(stored.pp_phone_context_open, '0');
});

const phoneCssAll = () => { const c = css.slice(css.lastIndexOf('/* ── Slim phone layout')); return c.slice(c.indexOf('@media (max-width: 600px)')); };

// ── Phone missing-buffs link (replaces the old 34px summary line) ──

function renderPhone(missing, { notes = '', seated = 25, size = 25 } = {}) {
  const els = {};
  const node = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', hidden: false, attrs: {}, listeners: {},
    classList: { toggle(c, on) { this.on = on; } }, setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.listeners[t] = fn; } });
  const src = 'let lastMissingCoverageCount = ' + JSON.stringify(missing) + ';\n' +
    between(renderJs, 'let phoneFeedbackOpen', 'function renderSummaryBar') +
    between(read('js/modals.js'), 'function renderPhoneSummary', 'function undoPlanChange');
  const ctx = vm.createContext({
    document: { getElementById: node },
    State: { roster: Array(seated).fill({}), selectedRaid: 'x', optimizerMode: 'max_dps', rosterName: 'Random 25-man Roster', notes },
    Config: { Raids: { x: { name: 'Karazhan', size } } },
    strategyLabel: () => 'Max DPS', setSidebarExpanded() {},
  });
  vm.runInContext(src + '\nrenderPhoneSummary(); renderPhoneMissing();', ctx);
  return { els, ctx };
}

check('the 34px phone summary line (counts, role letters) is gone from the summary bar', () => {
  const bar = between(renderJs, 'function renderSummaryBar', 'function updateStatus');
  assert.doesNotMatch(bar, /summary-phone|role-t|btn-summary-missing/);
  assert.match(bar, /class="summary-chip bench"/, 'desktop chips are still rendered');
  assert.match(phoneCssAll(), /\.summary-bar \{ display: none; \}/);
  assert.doesNotMatch(css, /height: 34px; padding: 0 12px/);
});

check('missing link is a real button outside the Edit toggle, with the count in warning colour', () => {
  assert.match(html, /<button type="button" class="summary-missing" id="btn-summary-missing" aria-expanded="false" aria-controls="plan-feedback" hidden><\/button>/);
  const toggle = html.match(/<button[^>]*id="phone-summary-toggle"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(toggle, /btn-summary-missing/, 'must not be nested inside the toggle button');
  const { els } = renderPhone(7);
  assert.equal(els['btn-summary-missing'].hidden, false);
  assert.equal(els['btn-summary-missing'].innerHTML, '<b>7</b> missing &#9656;');
  assert.equal(els['btn-summary-missing'].attrs['aria-expanded'], 'false');
  assert.match(phoneCssAll(), /\.summary-missing b \{[^}]*var\(--warning\)/);
  assert.match(phoneCssAll(), /\.summary-missing \{[^}]*font-size: 11px/);
});

check('line 2 carries the plan title, seated count and notes marker', () => {
  assert.equal(renderPhone(7).els['phone-summary-sub'].textContent, 'Random 25-man Roster · 25/25');
  assert.equal(renderPhone(7, { notes: 'x', seated: 20, size: 10 }).els['phone-summary-sub'].textContent, 'Random 25-man Roster · 20/10 · notes');
});

check('missing link is hidden at zero missing and when coverage is not modeled', () => {
  assert.equal(renderPhone(0).els['btn-summary-missing'].hidden, true);
  assert.equal(renderPhone(null).els['btn-summary-missing'].hidden, true);
  assert.equal(renderPhone(1).els['btn-summary-missing'].innerHTML, '<b>1</b> missing &#9656;');
});

check('feedback closes when the missing count drops to zero', () => {
  const { els, ctx } = renderPhone(7);
  vm.runInContext('setPhoneFeedbackOpen(true); lastMissingCoverageCount = 0; renderPhoneMissing();', ctx);
  assert.equal(vm.runInContext('phoneFeedbackOpen', ctx), false);
  assert.equal(els['plan-feedback'].classList.on, false);
});

check('clicking the missing link toggles the feedback text and opens the coverage panel', () => {
  const { els, ctx } = renderPhone(7);
  els['buff-sidebar'] = { scrolled: false, scrollIntoView() { this.scrolled = true; } };
  const click = els['btn-summary-missing'].listeners.click;
  assert.ok(click, 'direct click handler on the button');
  vm.runInContext('initSummaryMissing_ran = true', ctx);
  click();
  assert.equal(els['plan-feedback'].classList.on, true);
  assert.equal(els['btn-summary-missing'].attrs['aria-expanded'], 'true');
  assert.ok(els['buff-sidebar'].scrolled);
  click();
  assert.equal(els['plan-feedback'].classList.on, false);
});

// ── Player editor sheet ────────────────────────────────────────────

// Walks the editor's HTML template with a tag stack and reports which view every id lives in.
function editorViews() {
  const tpl = between(renderJs, "editor.innerHTML = `", "const overlay = document.createElement('div');");
  const voids = new Set(['input', 'br', 'img']);
  const views = { short: new Set(), more: new Set(), always: new Set() };
  const stack = [];
  const tagRe = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(tpl))) {
    const [, closing, tag, attrs] = m;
    if (closing) { stack.pop(); continue; }
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
    const entry = { more: /\bpe-more-only\b/.test(cls), short: /\bpe-short-only\b/.test(cls) };
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id) {
      const inMore = entry.more || stack.some(s => s.more);
      const inShort = entry.short || stack.some(s => s.short);
      (inMore ? views.more : inShort ? views.short : views.always).add(id);
    }
    if (!voids.has(tag.toLowerCase()) && !/\/\s*$/.test(attrs)) stack.push(entry);
  }
  return { tpl, views };
}

check('editor short view holds exactly the agreed controls', () => {
  const { views } = editorViews();
  // Always visible on phones: name, class, spec, the backup row's swap, the More row, the actions.
  const visible = new Set([...views.short, ...views.always].filter(id => !['pe-role', 'pe-error'].includes(id)));
  const expected = ['pe-name', 'pe-class', 'pe-spec', 'pe-backup-swap', 'pe-more-toggle', 'pe-remove', 'pe-cancel', 'pe-save',
    'pe-prefer', 'pe-remove-preference', 'pe-sheet-swatch', 'pe-sheet-name', 'pe-sheet-sub'];
  assert.deepEqual([...visible].sort(), expected.sort());
});

check('editor More view holds the rest, with the original IDs preserved', () => {
  const { views, tpl } = editorViews();
  for (const id of ['pe-more-back', 'pe-destination', 'pe-move', 'pe-backup-for', 'pe-backup-save', 'pe-backup-clear']) {
    assert.ok(views.more.has(id), `${id} should be under More`);
  }
  assert.ok(views.always.has('pe-error'), 'the error line stays visible in both views');
  // Unlock lives in a more-only row; drummer, constraints and Why here? are rendered inside the More group.
  assert.match(tpl, /<div class="player-move pe-more-only">\s*<span>Locked by comp template<\/span>\s*<button[^>]*id="pe-unlock"/);
  const group = between(tpl, '<div class="pe-more-group pe-more-only">', '<div class="player-editor-actions">');
  for (const call of ['renderDrummerEditor(', 'renderConstraintEditor(', 'renderWhyHere(']) assert.ok(group.includes(call), call);
  // Handlers keep resolving by the same IDs.
  for (const id of ['pe-save', 'pe-cancel', 'pe-remove', 'pe-move', 'pe-backup-swap', 'pe-backup-clear', 'pe-unlock', 'pe-name', 'pe-class', 'pe-spec']) {
    assert.ok(renderJs.includes(`'#${id}'`), `handler lookup for #${id}`);
  }
});

check('the needs-review notice is not part of either hidden group', () => {
  const { tpl } = editorViews();
  const notice = tpl.match(/<div class="player-editor-review-notice">/);
  assert.ok(notice, 'notice markup present');
  assert.doesNotMatch(css.slice(css.lastIndexOf('/* ── Slim phone layout')), /player-editor-review-notice/);
});

check('the sheet switches views with one class and moves focus into the sheet', () => {
  assert.match(renderJs, /editor\.classList\.toggle\('pe-more-open', open\)/);
  assert.match(renderJs, /\(open \? moreBack : moreToggle\)\.focus\(\)/);
  assert.match(renderJs, /else if \(window\.matchMedia\('\(max-width: 600px\)'\)\.matches\) nameInput\.focus\(\)/);
  assert.match(renderJs, /aria-label="Back to the short menu"/);
});

// ── CSS ────────────────────────────────────────────────────────────

const phoneCss = css.slice(css.lastIndexOf('/* ── Slim phone layout'));
const phoneBlock = phoneCss.slice(phoneCss.indexOf('@media (max-width: 600px)'));

check('phone-only chrome is hidden outside the media query', () => {
  const base = phoneCss.slice(0, phoneCss.indexOf('@media'));
  for (const sel of ['.phone-summary-wrap', '.summary-missing', '.phone-summary', '.pe-sheet-handle', '.pe-sheet-header', '.pe-more-row']) {
    assert.ok(base.includes(sel), `${sel} must default to hidden`);
  }
  assert.match(base, /display:\s*none/);
});

check('phone block defines the sheet views, the zoom reset and the fixed row heights', () => {
  for (const frag of ['.addon-frame { zoom: 1;', '.player-editor:not(.pe-more-open) .pe-more-only { display: none; }',
    '.player-editor.pe-more-open .pe-short-only', 'height: 44px', 'height: 40px', 'height: 60px']) {
    assert.ok(phoneBlock.includes(frag), frag);
  }
});

check('no inline style or handler attributes in the new markup', () => {
  const INLINE = /[\s`'"](?:style|on[a-z]{3,})\s*=\s*(?:["'`\\]|\$\{)/i;
  assert.doesNotMatch(between(html, 'id="phone-context-panel"', '<div class="roster-bar">'), INLINE);
  assert.doesNotMatch(editorViews().tpl, INLINE);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
