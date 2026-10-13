/**
 * PartyPlanner Web - slim phone layout tests
 * Run: node mobile-tests.js
 *
 * What Node can check about the <=600px layout (the pixel measurements are checked in a browser):
 *   - the phone context summary is a real <button> with aria-expanded, collapsed by default, and
 *     its toggle flips aria-expanded / hidden; every control it hides is still in the page
 *   - line 1 of the context row is the plan name (the toggle); line 2 holds the seated count, the
 *     Raid size control and the missing-buffs link as separate controls; the desktop chips stay untouched
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

check('every phone control is in the context row: line 2 slots, the Edit body, the notes slot', () => {
  const panel = between(html, 'id="phone-context-panel"', '<!-- These raw export formats');
  for (const id of ['phone-plan-name-slot', 'raid-size-phone-slot', 'btn-summary-missing', 'btn-ideal-comp-link-phone', 'phone-context-notes-slot']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} missing from the context panel`);
  }
  const line2 = between(panel, 'class="phone-summary-line2"', 'id="phone-context-body"');
  assert.ok(line2.includes('id="raid-size-phone-slot"') && line2.includes('id="btn-summary-missing"'), 'size control and readiness link sit on line 2');
  const body = between(panel, 'id="phone-context-body"', 'id="phone-context-notes-slot"');
  assert.ok(body.includes('id="phone-plan-name-slot"'), 'the rename button moves into the Edit body');
  assert.ok(!html.includes('phone-strategy-seg'), 'the optimizer strategy control is gone (Optimize always runs Max DPS)');
  assert.ok(!html.includes('raid-select'), 'the raid dropdown is gone');
  for (const id of ['raid-notes-panel', 'raid-notes-textarea', 'readiness-text', 'summary-bar', 'readiness-banner']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const pair of ['raid-notes-panel:phone-context-notes-slot', 'raid-size-wrap:raid-size-phone-slot', 'roster-name:phone-plan-name-slot']) {
    assert.ok(appJs.includes(`'${pair}'`), `${pair} relocation on phones`);
  }
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

// ── Phone readiness link (replaces the old 34px summary line) ──

// `readiness` is a missing-party-buff count, a full {missingCoverage, tanksShort,
// healersShort, mixedFactions} object, or null (nothing loaded / not modeled).
function renderPhone(readiness, { notes = '', seated = 25, size = 25 } = {}) {
  const els = {};
  const node = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', hidden: false, attrs: {}, listeners: {},
    classList: { toggle(c, on) { this.on = on; } }, setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.listeners[t] = fn; } });
  const value = typeof readiness === 'number'
    ? { missingCoverage: readiness, tanksShort: 0, healersShort: 0, mixedFactions: false } : readiness;
  const src = between(renderJs, 'let lastReadiness', 'function renderSummaryBar') +
    between(read('js/modals.js'), 'function renderPhoneSummary', 'function undoPlanChange');
  const ctx = vm.createContext({
    document: { getElementById: node },
    State: { roster: Array(seated).fill({}), selectedRaid: 'x', optimizerMode: 'max_dps', rosterName: 'Random 25-man Roster', notes },
    Config: { Raids: { x: { name: 'Karazhan', size } } },
    setSidebarExpanded() {},
    ReadinessBanner: { calls: [], set(minimized) { this.calls.push(minimized); } },
  });
  vm.runInContext(src + `\nlastReadiness = ${JSON.stringify(value)};\nrenderPhoneSummary(); renderPhoneMissing();`, ctx);
  return { els, ctx };
}

check('the 34px phone summary line (counts, role letters) is gone from the summary bar', () => {
  const bar = between(renderJs, 'function renderSummaryBar', 'function updateStatus');
  assert.doesNotMatch(bar, /summary-phone|role-t|btn-summary-missing/);
  assert.match(bar, /class="summary-chip bench"/, 'desktop chips are still rendered');
  assert.match(phoneCssAll(), /\.summary-bar \{ display: none; \}/);
  assert.doesNotMatch(css, /height: 34px; padding: 0 12px/);
});

check('readiness link is a real phone-only button outside the Edit toggle, with the count in warning colour', () => {
  const line2 = between(html, 'class="phone-summary-line2"', 'id="phone-context-body"');
  assert.match(line2, /<button type="button" class="summary-missing" id="btn-summary-missing" aria-expanded="false" aria-controls="readiness-banner" title="Show coverage details" hidden><\/button>/);
  assert.doesNotMatch(between(html, '<div class="toolbar">', '<div class="phone-context-panel"'), /btn-summary-missing/, 'desktop shows the banner itself, not the link');
  const toggle = html.match(/<button[^>]*id="phone-summary-toggle"[\s\S]*?<\/button>/)[0];
  const inner = toggle.slice(toggle.indexOf('>') + 1);
  assert.doesNotMatch(inner, /btn-summary-missing|raid-size|<button|<select|<input/, 'nothing interactive is nested inside the toggle button');
  const { els } = renderPhone(7);
  assert.equal(els['btn-summary-missing'].hidden, false);
  assert.equal(els['btn-summary-missing'].innerHTML, '<b>7</b> missing &#9656;');
  assert.match(css, /\.summary-missing b \{[^}]*var\(--warning\)/);
  assert.match(phoneCssAll(), /\.phone-missing-slot \.summary-missing \{[^}]*font-size: 12px/);
});

check('the link counts the party buffs the banner counts, from renderReadiness', () => {
  const readiness = between(read('js/modals.js'), 'function renderReadiness', '// ── RAID NOTES');
  assert.match(readiness, /coverageChip\(gaps\)/);
  assert.match(readiness, /const gaps = liveCoverageGaps\(\);\s*const missing = gaps\.buffs \+ gaps\.debuffs;/);
  assert.match(readiness, /lastReadiness = \{ missingCoverage: missing,/);
  assert.doesNotMatch(renderJs, /lastMissingCoverageCount/, 'the buffs + debuffs total no longer feeds the link');
});

check('the link names the most serious warning: tanks, healers, factions, then missing buffs', () => {
  const label = r => renderPhone({ missingCoverage: 0, tanksShort: 0, healersShort: 0, mixedFactions: false, ...r }).els['btn-summary-missing'];
  assert.equal(label({ healersShort: 1 }).innerHTML, '<b>&#9888; 1 healer short</b> &#9656;');
  assert.equal(label({ tanksShort: 2, healersShort: 1 }).innerHTML, '<b>&#9888; 2 tanks short</b> &#9656;');
  assert.equal(label({ mixedFactions: true }).innerHTML, '<b>&#9888; Mixed factions</b> &#9656;');
  assert.equal(label({ missingCoverage: 3, healersShort: 1 }).innerHTML, '<b>&#9888; 1 healer short</b> &#9656;', 'a shortage outranks missing buffs; (the banner lists the rest)');
  assert.equal(label({ missingCoverage: 3, mixedFactions: true }).innerHTML, '<b>&#9888; Mixed factions</b> &#9656;');
  assert.equal(label({ missingCoverage: 3 }).innerHTML, '<b>3</b> missing &#9656;', 'buffs only when the roster itself is fine');
  assert.equal(label({}).hidden, true);
});

check('the link counts party buffs plus raid debuffs, and shows for debuffs alone', () => {
  const link = n => renderPhone({ missingCoverage: n, tanksShort: 0, healersShort: 0, mixedFactions: false }).els['btn-summary-missing'];
  assert.equal(link(6).hidden, false);
  assert.equal(link(13).innerHTML, '<b>13</b> missing &#9656;');
  const readiness = between(read('js/modals.js'), 'function renderReadiness', '// ── RAID NOTES');
  assert.match(readiness, /const missing = gaps\.buffs \+ gaps\.debuffs;/);
});

check('the phone link is a flex box that keeps the space between its number and its words', () => {
  const rule = phoneCssAll().match(/\.phone-missing-slot \.summary-missing \{[^}]*\}/)[0];
  assert.match(rule, /display: flex/);
  assert.match(rule, /\bgap: [\d.]+(em|px)/, 'flex drops the whitespace after </b>, so a gap restores it');
});

check('the readiness banner is shown on desktop and on phones (phones only start it minimized)', () => {
  assert.doesNotMatch(css, /\.plan-feedback|feedback-open/, 'the old strip rules are gone');
  assert.doesNotMatch(phoneCssAll(), /\.readiness-banner \{ display: none/);
  assert.doesNotMatch(renderJs, /setPhoneFeedbackOpen|phoneFeedbackOpen/, 'the strip open/close state is gone');
});

check('line 1 is the plan name; line 2 carries the seated count and notes marker', () => {
  assert.equal(renderPhone(7).els['phone-summary-main'].textContent, 'Random 25-man Roster');
  assert.equal(renderPhone(7).els['phone-summary-sub'].textContent, '25/25');
  assert.equal(renderPhone(7, { notes: 'x', seated: 20, size: 10 }).els['phone-summary-sub'].textContent, '20/10 · notes');
});

check('readiness link is hidden when nothing is wrong and when coverage is not modeled', () => {
  assert.equal(renderPhone(0).els['btn-summary-missing'].hidden, true);
  assert.equal(renderPhone(null).els['btn-summary-missing'].hidden, true);
  assert.equal(renderPhone(1).els['btn-summary-missing'].innerHTML, '<b>1</b> missing &#9656;');
});

check('clicking the missing link expands the banner (and keeps it expanded) and opens the coverage panel', () => {
  const { els, ctx } = renderPhone(7);
  els['buff-sidebar'] = { scrolled: false, scrollIntoView() { this.scrolled = true; } };
  const click = els['btn-summary-missing'].listeners.click;
  assert.ok(click, 'direct click handler on the button');
  click();
  assert.deepEqual(ctx.ReadinessBanner.calls, [false], 'the banner is told to expand (not to toggle)');
  assert.ok(els['buff-sidebar'].scrolled);
  click();
  assert.deepEqual(ctx.ReadinessBanner.calls, [false, false], 'a second click does not minimize it');
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
  // (.summary-missing is no longer phone-only: desktop shows it at the end of the action row.)
  for (const sel of ['.phone-summary-wrap', '.phone-summary', '.pe-sheet-handle', '.pe-sheet-header', '.pe-more-row']) {
    assert.ok(base.includes(sel), `${sel} must default to hidden`);
  }
  assert.match(base, /display:\s*none/);
});

check('phone block defines the sheet views, the zoom reset and the fixed row heights', () => {
  for (const frag of ['.addon-frame { zoom: 1;', '.player-editor:not(.pe-more-open) .pe-more-only { display: none; }',
    '.player-editor.pe-more-open .pe-short-only', 'height: 44px', 'height: 40px', 'height: calc(60px + env(safe-area-inset-bottom']) {
    assert.ok(phoneBlock.includes(frag), frag);
  }
});

check('no inline style or handler attributes in the new markup', () => {
  const INLINE = /[\s`'"](?:style|on[a-z]{3,})\s*=\s*(?:["'`\\]|\$\{)/i;
  assert.doesNotMatch(between(html, '<main class="addon-frame" id="app"', '<!-- These raw export formats'), INLINE);
  assert.doesNotMatch(editorViews().tpl, INLINE);
});


// ── Phone sizing (4.3.0) ───────────────────────────────────────────
const rule = (sel, src = phoneBlock) => {
  const line = src.replace(/\r\n/g, '\n').split('\n').find(l => l.trim().startsWith(sel + ' {'));
  assert.ok(line, 'phone block has a rule for ' + sel);
  return line;
};

check('phone banner actions stack full width at 44px with 13px text; banner text is 14px / 1.4', () => {
  assert.match(rule('.sync-banner-actions'), /flex-direction: column/);
  assert.match(rule('.sync-banner-actions'), /width: 100%/);
  const btn = rule('.sync-banner .btn, .sync-banner .link-btn, .sync-banner-actions .btn');
  assert.match(btn, /width: 100%/);
  assert.match(btn, /min-height: 44px/);
  assert.match(btn, /font-size: 13px/);
  assert.match(rule('.sync-banner'), /font-size: 14px; line-height: 1\.4/);
});

check('the landing import card is ordered before the hero text without touching the DOM', () => {
  assert.match(rule('.hero .import-card'), /order: 1/);
  assert.match(rule('.hero .hero-copy'), /order: 2/);
  const hero = between(html, '<section class="hero">', '</section>');
  assert.ok(hero.indexOf('class="hero-copy"') < hero.indexOf('id="import-card"'), 'DOM order is unchanged');
});

check('Coverage rail text and the Switch / Swap in button reach the approved sizes', () => {
  assert.match(rule('.buff-row-name'), /font-size: 13px/);
  assert.match(rule('.buff-row-insight'), /font-size: 12px/);
  assert.match(rule('.buff-row-source'), /font-size: 11px/);
  const b = rule('.insight-btn');
  assert.match(b, /min-height: 36px/);
  assert.match(b, /font-size: 12px/);
  assert.match(b, /padding: 0 14px/);
  assert.match(rule('.buff-row-icon'), /width: 22px; height: 22px/);
});

check('version tabs, raid size buttons and the plan-name toggle get 44px hit areas', () => {
  assert.match(rule('.game-version-tab::before'), /inset: -9px 0/);
  assert.match(rule('#raid-size-phone-slot .raid-size-seg button::before'), /inset: -7px 0/);
  assert.match(rule('.phone-summary::before'), /inset: -6px -12px 0/);
  assert.ok(phoneBlock.includes('.phone-summary { position: relative; }'));
});

check('the phone hit areas add up to 44px and do not overlap their neighbours', () => {
  const px = (line, re) => Number(line.match(re)[1]);
  // Version tabs: grid row inside the 1px-bordered 28px nav, grown by the ::before inset on both sides.
  const nav = rule('.game-version-nav');
  const tabHeight = px(nav, /height: (\d+)px/) - 2 * px(nav, /border: (\d+)px/);
  const tabInset = px(rule('.game-version-tab::before'), /inset: -(\d+)px 0/);
  assert.ok(tabHeight + 2 * tabInset >= 44, `tabs reach ${tabHeight + 2 * tabInset}px`);
  const headerHeight = px(rule('.game-header-inner'), /height: (\d+)px/);
  const tabOvershoot = (tabHeight + 2 * tabInset - headerHeight) / 2; // how far the tab hit area spills below the header
  // Plan-name toggle: its row plus the upward inset reach 44px; the inset stays inside the wrap's top padding
  // (past the tabs' spill) and nothing extends down into line 2.
  const summary = phoneBlock.replace(/\r\n/g, '\n').match(/\.phone-summary \{\n[^}]*\}/)[0]; // the multi-line rule
  const before = rule('.phone-summary::before').match(/inset: -(\d+)px -(\d+)px (-?\d+)/);
  const rowHeight = px(summary, /min-height: (\d+)px/);
  const up = Number(before[1]);
  const down = Number(before[3]);
  assert.ok(rowHeight + up + down >= 44, `plan-name toggle reaches ${rowHeight + up + down}px`);
  assert.equal(down, 0, 'the toggle hit area does not reach into line 2');
  const wrapTop = px(rule('.phone-summary-wrap'), /padding: (\d+)px/);
  assert.ok(up + tabOvershoot <= wrapTop, `toggle (${up}px up) clears the tabs (${tabOvershoot}px spill) within ${wrapTop}px of padding`);
});

check('the buff icon fallback label stays visible on phones at 9px', () => {
  const r = rule('.buff-icon .buff-label');
  assert.match(r, /font-size: 9px/);
  assert.doesNotMatch(r, /display: none/);
});

check('landing restore link and saved-plan Delete buttons get 44px tap areas on phones', () => {
  const r = rule('#btn-landing-restore, .landing .row-actions .link-btn.del');
  assert.match(r, /min-height: 44px/);
});

check('side safe areas pad the page on notched landscape phones, keeping existing padding', () => {
  const flat = css.replace(/\r\n/g, '\n');
  assert.match(flat, /body \{[^}]*padding: 8px max\(16px, env\(safe-area-inset-right, 0px\)\) 8px max\(16px, env\(safe-area-inset-left, 0px\)\);/);
  assert.match(flat, /@media \(max-width: 1100px\) \{[^@]*body \{ padding: 0 env\(safe-area-inset-right, 0px\) 0 env\(safe-area-inset-left, 0px\); \}/);
});

check('opening the reference comp on a phone moves focus to Back to my raid', () => {
  const src = appJs.replace(/\r\n/g, '\n');
  assert.match(src, /if \(tab === 'ideal' && window\.matchMedia\('\(max-width: 600px\)'\)\.matches\) \{\s*const back = document\.getElementById\('btn-back-to-raid'\);\s*if \(back\) back\.focus\(\);/);
});

check('the bench is one column at phone width and no 560px two-column rule remains', () => {
  assert.match(rule('.bench-list'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /max-width:\s*560px\)\s*\{\s*\.bench-list/);
  // The only two-column bench rule left is the 900px one; the phone rule above overrides it.
  const twoCol = css.replace(/\r\n/g, '\n').split('\n').filter(l => /\.bench-list \{ grid-template-columns: repeat\(2/.test(l));
  assert.equal(twoCol.length, 1);
});

check('the tray status tabs wrap on phones instead of scrolling', () => {
  const r = rule('.tray-tabs');
  assert.match(r, /flex-wrap: wrap/);
  assert.match(r, /overflow-x: visible/);
});

check('the viewport covers the safe area; the bottom bar and frame pad for the inset', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(rule('#phone-action-bar'), /padding: 8px 8px calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(rule('.addon-frame'), /calc\(68px \+ env\(safe-area-inset-bottom/);
});

check('the reference view status bar reads "Reference N-man comp"', () => {
  assert.match(appJs, /textContent = `Reference \$\{raidInfo\.size\}-man comp`/);
  assert.doesNotMatch(appJs, /Ideal \$\{raidInfo/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
