/**
 * PartyPlanner Web - slim phone layout tests
 * Run: node tests/planner/mobile-tests.js
 *
 * What Node can check about the <=600px layout (the pixel measurements are checked in a browser):
 *   - the phone context summary is a real <button> with aria-expanded, collapsed by default, and
 *     its toggle flips aria-expanded / hidden; every control it hides is still in the page
 *   - line 1 of the context row is the plan name (the toggle); line 2 holds the seated count, the
 *     Raid size control as separate controls
 *   - the player editor's short view holds exactly the agreed controls and the More view holds the
 *     rest, with every original element ID preserved
 *   - phone-only chrome is hidden outside the media query, and no markup uses inline styles
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const read = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
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
  for (const id of ['phone-plan-name-slot', 'raid-size-phone-slot', 'btn-ideal-comp-link-phone', 'phone-context-notes-slot']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} missing from the context panel`);
  }
  const line2 = between(panel, 'class="phone-summary-line2"', 'id="phone-context-body"');
  assert.ok(line2.includes('id="raid-size-phone-slot"') && line2.includes('id="phone-summary-sub"'), 'seated count and size control sit on line 2');
  const body = between(panel, 'id="phone-context-body"', 'id="phone-context-notes-slot"');
  assert.ok(body.includes('id="phone-plan-name-slot"'), 'the rename button moves into the Edit body');
  assert.ok(!html.includes('phone-strategy-seg'), 'the optimizer strategy control is gone (Optimize always runs Max DPS)');
  assert.ok(!html.includes('raid-select'), 'the raid dropdown is gone');
  for (const id of ['raid-notes-panel', 'raid-notes-textarea', 'raid-check', 'btn-coverage', 'coverage-dialog', 'notice-slot']) {
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

// ── Phone plan name / seated count (the readiness link is gone: the Raid check strip is the phone's readiness) ──

function renderPhone({ notes = '', seated = 25, size = 25 } = {}) {
  const els = {};
  const node = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', hidden: false });
  const src = between(read('js/modals.js'), 'function renderPhoneSummary', 'function undoPlanChange');
  const ctx = vm.createContext({
    document: { getElementById: node },
    State: { roster: Array(seated).fill({}), selectedRaid: 'x', optimizerMode: 'max_dps', rosterName: 'Random 25-man Roster', notes },
    Config: { Raids: { x: { name: 'Karazhan', size } } },
  });
  vm.runInContext(src + '\nrenderPhoneSummary();', ctx);
  return { els, ctx };
}

check('line 1 is the plan name; line 2 carries the seated count and notes marker', () => {
  assert.equal(renderPhone().els['phone-summary-main'].textContent, 'Random 25-man Roster');
  assert.equal(renderPhone().els['phone-summary-sub'].textContent, '25/25');
  assert.equal(renderPhone({ notes: 'x', seated: 20, size: 10 }).els['phone-summary-sub'].textContent, '20/10 · notes');
});

check('the phone readiness link, the readiness banner and the summary bar are gone from the page and the code', () => {
  assert.doesNotMatch(html, /btn-summary-missing|phone-missing-slot|id="readiness-banner"|id="readiness-text"|id="summary-bar"|id="coverage-sheet"/);
  assert.doesNotMatch(renderJs, /phoneReadinessLabel|renderPhoneMissing|lastReadiness/);
  assert.doesNotMatch(css, /\.summary-missing|\.phone-missing-slot|\.summary-bar|\.readiness-banner|\.coverage-sheet|body\.coverage-/);
  assert.doesNotMatch(appJs, /openCoverageSheet|closeCoverageSheet|setSidebarExpanded/);
});

// ── Raid check strip + Coverage dialog (phones) ──

const guildCss = read('guild.css');
const stripCss = guildCss.slice(guildCss.indexOf('Planner board on Forge (T6), lane 2'), guildCss.indexOf('/* Watch list: Reviewed'));
const stripPhoneCss = stripCss.slice(stripCss.lastIndexOf('@media (width <= 600px)'));

check('phone strip: counts line, 44px icon buttons, a full-width 44px covered button, no zoom', () => {
  assert.ok(stripCss.lastIndexOf('@media (width <= 600px)') > 0, 'the strip has a phone block');
  assert.match(stripPhoneCss, /\.gs-pb-tile \{ flex-direction: row;/, 'tiles read as one counts line');
  assert.match(stripPhoneCss, /\.gs-pb-gap \{ width: 44px; height: 44px; \}/);
  assert.match(stripPhoneCss, /\.gs-pb-covered \{ width: 100%;[^}]*min-height: 44px/);
  assert.match(stripPhoneCss, /\.gs-pb-floor \{ display: none; \}/);
  // above 600 px the planner frame is zoomed 1.5, so the strip undoes it; the phone frame has no zoom
  assert.match(stripCss, /@media \(min-width: 601px\) \{ \.gs-pb-check, \.gs-pb-manual, \.gs-pb-groupsline \{ zoom: 0\.6666667; \} \}/);
});

check('phone dialog: a full-height sheet with 44px targets', () => {
  assert.match(stripPhoneCss, /\.gs-pb-cov \{ width: 100vw; height: 100dvh;/);
  assert.match(stripPhoneCss, /\.gs-pb-cov \.gs-btn \{ min-height: 44px; \}/);
  assert.match(stripPhoneCss, /\.gs-pb-cov \.insight-btn \{ min-height: 44px; \}/);
  assert.match(stripPhoneCss, /change-remove \{ width: 44px; height: 44px; \}/);
});

// The dialog functions of js/app.js in a vm with a fake dialog: showModal/close flip `open`, close fires the 'close' listeners.
function coverageDialogHarness() {
  const log = [];
  const nodes = {};
  const node = id => nodes[id] || (nodes[id] = { id, attrs: {}, listeners: {}, hidden: false,
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
  const dialog = node('coverage-dialog');
  Object.assign(dialog, { open: false, showModal() { this.open = true; log.push('showModal'); },
    close() { this.open = false; log.push('close'); this.listeners.close && this.listeners.close(); } });
  const ctx = vm.createContext({
    document: { getElementById: node },
    FocusTrap: { open: (el, trigger) => log.push('trap-open:' + el.id + ':' + trigger.id), close: el => log.push('trap-close:' + el.id) },
  });
  const src = between(appJs, '// ── COVERAGE DIALOG', '// ── PHONE "MORE" SHEET');
  vm.runInContext(src + '\nthis.openCoverageDialog = openCoverageDialog; this.closeCoverageDialog = closeCoverageDialog;', ctx);
  return { ctx, nodes, log, dialog };
}

check('the covered button opens the modal dialog behind a focus trap; Close, Escape and the backdrop end it and release the trap', () => {
  const { ctx, nodes, log, dialog } = coverageDialogHarness();
  nodes['btn-coverage'].listeners.click();
  assert.deepEqual(log, ['showModal', 'trap-open:coverage-dialog:btn-coverage']);
  assert.equal(nodes['btn-coverage'].attrs['aria-expanded'], 'true');
  nodes['btn-coverage'].listeners.click();
  assert.equal(log.length, 2, 'opening an open dialog does nothing');
  nodes['btn-close-coverage'].listeners.click();
  assert.deepEqual(log.slice(2), ['close', 'trap-close:coverage-dialog'], 'the close event releases the trap (which hands focus back to the button)');
  assert.equal(nodes['btn-coverage'].attrs['aria-expanded'], 'false');
  // Escape: the browser closes the dialog itself and fires close
  ctx.openCoverageDialog(); log.length = 0;
  dialog.open = false; dialog.listeners.close();
  assert.deepEqual(log, ['trap-close:coverage-dialog']);
  // a click on the backdrop is a click whose target is the dialog element
  ctx.openCoverageDialog(); log.length = 0;
  dialog.listeners.click({ target: {} });
  assert.equal(dialog.open, true, 'a click inside does not close it');
  dialog.listeners.click({ target: dialog });
  assert.equal(dialog.open, false);
  assert.doesNotThrow(() => ctx.closeCoverageDialog(), 'closing a closed dialog is a no-op');
});

check('the planner closes the dialog when a guild page covers it, and the tooltip portal follows into an open dialog', () => {
  assert.match(between(appJs, 'function closePlannerOverlays()', 'removeSpotlightCallout'), /closePlayerEditor/);
  assert.match(between(appJs, 'function closePlannerOverlays()', '// ── EXPOSE FOR TESTING'), /closeCoverageDialog\(\);/);
  assert.match(appJs, /const host = icon\.closest\('dialog\[open\]'\) \|\| document\.body;\s*if \(portal\.parentNode !== host\) host\.appendChild\(portal\);/);
});

check('the More sheet no longer has a Coverage sheet to close first', () => {
  assert.doesNotMatch(between(appJs, 'const openSheet = () => {', 'sheet.classList.add'), /Coverage/);
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
  for (const id of ['pe-more-back', 'pe-backup-for', 'pe-backup-save', 'pe-backup-clear']) {
    assert.ok(views.more.has(id), `${id} should be under More`);
  }
  // Moving is a row of group chips (no ids) in the short view, in the desktop template too; the select and button are gone.
  const chips = between(tpl, '<div class="pe-move-section pe-short-only">', '<h4 class="pe-section-title pe-desktop-only">Player</h4>');
  assert.match(chips, /class="pe-chips"[^>]*>\$\{moveChipsHTML\(opts\.uid\)\}/);
  assert.doesNotMatch(chips, /pe-more-only/);
  assert.doesNotMatch(tpl, /pe-destination|id="pe-move"/);
  assert.ok(views.always.has('pe-error'), 'the error line stays visible in both views');
  // Unlock lives in a more-only row; drummer, constraints and Why here? are rendered inside the More group.
  assert.match(tpl, /<div class="player-move pe-more-only">\s*<span>Locked by comp template<\/span>\s*<button[^>]*id="pe-unlock"/);
  const group = between(tpl, '<div class="pe-more-group pe-more-only">', '<div class="player-editor-actions">');
  for (const call of ['renderDrummerEditor(', 'renderConstraintEditor(', 'renderWhyHere(']) assert.ok(group.includes(call), call);
  // Handlers keep resolving by the same IDs.
  for (const id of ['pe-save', 'pe-cancel', 'pe-remove', 'pe-backup-swap', 'pe-backup-clear', 'pe-unlock', 'pe-name', 'pe-class', 'pe-spec']) {
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
  assert.doesNotMatch(between(html, '<main class="addon-frame gs-forge" id="app"', '<!-- These raw export formats'), INLINE);
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

check('Coverage dialog text is 13-14px, the row icon 28px, and the fix buttons are Forge buttons (36px, 44px on phones)', () => {
  assert.match(stripCss, /\.gs-pb-cov \.buff-row-name \{[^}]*font-size: 14px/);
  assert.match(stripCss, /\.gs-pb-cov \.buff-row-insight \{[^}]*font-size: 13px/);
  assert.match(stripCss, /\.gs-pb-cov \.buff-row-source \{[^}]*font-size: 13px/);
  assert.match(stripCss, /\.gs-pb-cov \.buff-row-icon \{[^}]*width: 28px; height: 28px/);
  assert.match(renderJs, /class="insight-btn gs-btn" data-insight-switch/);
  assert.match(renderJs, /class="insight-btn gs-btn" data-insight-swap/);
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
  // The tabs sit alone in the shell's top bar on the landing view, so their hit area has no neighbour to overlap.
  // Plan-name toggle (line 1, in the shell's top bar): its row plus the upward inset reach 44px, and nothing
  // extends down into line 2.
  const summary = phoneBlock.replace(/\r\n/g, '\n').match(/\.phone-summary \{\n[^}]*\}/)[0]; // the multi-line rule
  const before = rule('.phone-summary::before').match(/inset: -(\d+)px -(\d+)px (-?\d+)/);
  const rowHeight = px(summary, /min-height: (\d+)px/);
  const up = Number(before[1]);
  const down = Number(before[3]);
  assert.ok(rowHeight + up + down >= 44, `plan-name toggle reaches ${rowHeight + up + down}px`);
  assert.equal(down, 0, 'the toggle hit area does not reach into line 2');
});

check('the buff icon fallback label stays visible (12px floor) where the image is missing; an icon with an image hides it', () => {
  const board = read('guild.css');
  const r = board.match(/\.gs-pb-board \.buff-icon \.buff-label \{([^}]*)\}/);
  assert(r, 'board rule for the label');
  assert.match(r[1], /font-size: 12px/);
  assert.doesNotMatch(r[1], /display: none/);
  assert.match(board, /\.gs-pb-board \.buff-icon\.has-icon \.buff-label \{ display: none; \}/);
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

// ── Player editor: desktop drawer and group chips ──────────────────

// The editor's move helpers (closePlayerEditor .. performEditorMove) run against the real logic half with a stub page.
function moveHarness(groupSizes, { benchSize = 0 } = {}) {
  const calls = { commit: 0, toasts: [] };
  const classes = [];
  const g = {
    document: { querySelector: () => null, getElementById: () => null, querySelectorAll: sel => sel === '.editing' ? [{ classList: { remove: c => classes.push(c) } }] : [] },
    FocusTrap: { close() {} },
    removeSpotlightCallout() {},
    classColorClass: c => 'cc-' + c.toLowerCase(),
    commit: () => { calls.commit++; },
    showToast: t => { calls.toasts.push(t); },
    window: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  const src = between(renderJs, 'function closePlayerEditor', '// ── Keep-together / Keep-apart editor');
  const ctx = app.sandbox(['State', 'RosterEdit', 'closePlayerEditor', 'moveChipsHTML', 'moveSwapListHTML', 'performEditorMove'], { globals: g, extraSource: src });
  const { State, RosterEdit } = ctx.api;
  const mk = (name, cls, spec, n) => ({ uid: 'u-' + name, name: name + '-Realm', class: cls, spec, role: 'melee_dps', groupNumber: n });
  State.groups = groupSizes.map((n, gi) => Array.from({ length: n }, (_, i) => mk(`G${gi + 1}P${i + 1}`, 'WARRIOR', 'Arms', gi + 1)));
  State.bench = Array.from({ length: benchSize }, (_, i) => mk('Bench' + (i + 1), 'MAGE', 'Fire', 0));
  State.roster = State.groups.flat();
  return { ...ctx.api, calls, classes };
}

check('move chips: one per group; current, room and full are told apart', () => {
  const h = moveHarness([5, 3, 5, 5, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.RosterEdit.MoveTargets('u-G2P1'))), [
    { groupIdx: 0, count: 5, state: 'full' }, { groupIdx: 1, count: 3, state: 'current' }, { groupIdx: 2, count: 5, state: 'full' },
    { groupIdx: 3, count: 5, state: 'full' }, { groupIdx: 4, count: 4, state: 'room' }]);
  const html = h.moveChipsHTML('u-G2P1');
  assert.equal((html.match(/data-move-group="/g) || []).length, 5);
  assert.match(html, /data-move-group="1" disabled aria-current="true"><b class="pe-chip-num">2<\/b><span class="pe-chip-sep">&middot;<\/span><span class="pe-chip-count">3\/5<\/span><small class="pe-chip-state">current/);
  assert.match(html, /pe-chip-room" data-move-group="4"[^>]*>.*?4\/5.*?>room</);
  assert.match(html, /pe-chip-full" data-move-group="0"[^>]*>.*?5\/5.*?>swap</);
  assert.doesNotMatch(html, /\bid=/, 'chips carry no ids');
});

check('move chips: a benched player has no current chip; a 10-man raid has two chips', () => {
  const h = moveHarness([5, 2], { benchSize: 1 });
  assert.deepEqual(h.RosterEdit.MoveTargets('u-Bench1').map(t => t.state), ['full', 'room']);
  assert.doesNotMatch(h.moveChipsHTML('u-Bench1'), /aria-current|disabled/);
  assert.equal((h.moveChipsHTML('u-G1P1').match(/data-move-group="/g) || []).length, 2);
  assert.equal(h.RosterEdit.MoveTargets('nobody').length, 0);
});

check('a room chip moves the player at once: closes, commits and toasts "Moved <Name> to Group N"', () => {
  const h = moveHarness([5, 3]);
  const result = h.performEditorMove('u-G1P1', 1);
  assert.equal(result.success, true);
  assert.equal(h.State.groups[1].length, 4);
  assert.deepEqual(h.calls.toasts, ['Moved G1P1 to Group 2']);
  assert.equal(h.calls.commit, 1);
  assert.deepEqual(h.classes, ['editing'], 'the editor closed (the edited card lost its outline)');
});

check('a full chip lists the group to swap with; a swap row moves and swaps with the right toast', () => {
  const h = moveHarness([5, 5], { benchSize: 1 });
  const list = h.moveSwapListHTML('u-G1P2', 1);
  assert.match(list, /<p class="pe-swap-prompt">Group 2 is full\. Pick who goes to Group 1\.<\/p>/);
  assert.equal((list.match(/data-swap-uid="/g) || []).length, 5);
  assert.match(list, /data-swap-uid="u-G2P3" data-swap-group="1"[^>]*><span class="pe-swap-name cc-warrior">G2P3<\/span><small>Arms<\/small><em>Swap<\/em>/);
  assert.match(h.moveSwapListHTML('u-Bench1', 1), /Group 2 is full\. Pick who goes to the bench\./);
  assert.equal(h.performEditorMove('u-G1P2', 1).success, false, 'a full group needs a swap partner');
  assert.equal(h.calls.toasts.length, 0, 'a failed move toasts nothing and the editor stays open');
  assert.equal(h.performEditorMove('u-G1P2', 1, 'u-G2P3').success, true);
  assert.deepEqual(h.calls.toasts, ['Moved G1P2 to Group 2; G2P3 to Group 1']);
  assert.equal(h.State.groups[0][1].uid, 'u-G2P3');
  assert.equal(h.performEditorMove('u-Bench1', 0, 'u-G1P1').success, true);
  assert.equal(h.calls.toasts[1], 'Moved Bench1 to Group 1; G1P1 to the bench');
  assert.equal(h.State.bench[0].uid, 'u-G1P1');
});

check('the edited card gets the "editing" class on open and loses it on close', () => {
  const open = between(renderJs, 'function showPlayerEditor', 'const nameInput = editor.querySelector');
  assert.match(open, /anchorEl\.classList\.add\('editing'\)/);
  const closeFn = between(renderJs, 'function closePlayerEditor', '// ── Editor drawer');
  assert.match(closeFn, /querySelectorAll\('\.editing'\)\.forEach\(el => el\.classList\.remove\('editing'\)\)/);
  assert.match(css, /\.player-slot\.editing, \.bench-slot\.editing \{ outline: 2px solid var\(--accent-gold\)/);
});

check('desktop focus lands on the first chip that can be pressed; add mode keeps #pe-class', () => {
  assert.match(renderJs, /else \(editor\.querySelector\('\[data-move-group\]:not\(\[disabled\]\)'\) \|\| nameInput\)\.focus\(\);/);
  assert.match(renderJs, /if \(isAdd\) classSel\.focus\(\);/);
  assert.doesNotMatch(renderJs, /#pe-destination/);
});

check('the drawer follows the title bar and stops following when the editor closes', () => {
  const calls = { added: [], removed: [], fns: [] };
  const win = { addEventListener: (t, fn, c) => { calls.added.push([t, c]); calls.fns.push(fn); }, removeEventListener: (t, fn, c) => calls.removed.push([t, c]) };
  let frameFn = null;
  const bar = { getBoundingClientRect: () => ({ bottom: 96.4 }) };
  const g = { window: win, document: { querySelector: s => s === '.title-bar' ? bar : null },
    requestAnimationFrame: fn => { frameFn = fn; return 7; }, cancelAnimationFrame: () => {} };
  const src = between(renderJs, 'let stopEditorDrawerTracking', 'const MOVE_HINT');
  const ctx = vm.createContext(g);
  vm.runInContext(src + ';\nthis.api = { placeEditorDrawer, trackEditorDrawer, stopTrackingEditorDrawer };', ctx);
  const editor = { style: {} };
  ctx.api.placeEditorDrawer(editor);
  assert.equal(editor.style.top, '96.4px');
  ctx.api.trackEditorDrawer(editor);
  assert.deepEqual(calls.added, [['scroll', true], ['resize', undefined]]);
  bar.getBoundingClientRect = () => ({ bottom: 40 });
  calls.fns[0]();
  frameFn();
  assert.equal(editor.style.top, '40px', 'a scroll moves the drawer with the title bar');
  ctx.api.stopTrackingEditorDrawer();
  assert.deepEqual(calls.removed, [['scroll', true], ['resize', undefined]]);
  g.document.querySelector = () => null;
  ctx.api.placeEditorDrawer(editor);
  assert.equal(editor.style.top, '0px', 'no title bar: the drawer starts at the top');
});

check('the first-run tip is skipped, still unseen, when there is no room left of the drawer', () => {
  const src = between(renderJs, 'function showSpotlightCallout', '// Small, hand-curated');
  const seen = [];
  const rectOf = left => ({ getBoundingClientRect: () => ({ left, top: 100, bottom: 140, right: left + 300, width: 300, height: 40 }) });
  const ctx = vm.createContext({
    document: { querySelector: () => null }, window: { innerWidth: 640, innerHeight: 700 },
    localStorage: {}, Spotlight: { dismiss: (_, id) => seen.push(id) }, esc: s => s,
  });
  vm.runInContext(src + '\nthis.api = showSpotlightCallout;', ctx);
  const show = (edgeLeft) => ctx.api('x', rectOf(300), 'text', { side: 'left', edgeEl: rectOf(edgeLeft) });
  assert.equal(show(240), false, 'drawer at 240 leaves no room for a 260px tip');
  assert.equal(seen.length, 0, 'and the tip is not marked seen');
});

check('drawer CSS: 380px, fixed to the right edge, outside the phone block; no text under 12px', () => {
  const norm = css.replace(/\r\n/g, '\n');
  const base = norm.slice(0, norm.lastIndexOf('/* ── Slim phone layout'));
  const rule = base.match(/\n\.player-editor \{([^}]*)\}/);
  assert.ok(rule, 'a .player-editor rule outside the phone block');
  assert.match(rule[1], /position: fixed; top: 0; right: 0; bottom: 0;/);
  assert.match(rule[1], /width: 380px/);
  assert.match(rule[1], /z-index: 200/);
  const drawerRules = base.slice(base.indexOf('/* ── Player editor: a drawer'), base.indexOf('/* Constraint / lock badges'));
  const small = [...drawerRules.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter(m => Number(m[1]) < 12);
  assert.deepEqual(small.map(m => m[0]), [], 'font sizes in the drawer rules');
  assert.match(phoneBlock, /\.player-editor \{[^}]*position: fixed !important; left: 0 !important; right: 0 !important; top: auto !important; bottom: 0;/, 'the phone block still makes it a bottom sheet');
  assert.match(phoneBlock, /\.pe-chip \{[^}]*height: 44px; min-height: 44px/, 'phone chips are 44px tall');
  assert.match(phoneBlock, /\.pe-swap-row \{ height: 44px/, 'phone swap rows are 44px tall');
  assert.match(phoneBlock, /\.pe-chip-room \.pe-chip-count \{ color: var\(--success\)/, 'a room chip is highlighted on phones');
  assert.match(phoneBlock, /\.pe-chip-current \.pe-chip-count \{ color: var\(--accent-gold\)/);
  assert.match(css, /\.pe-section-title, \.player-why-here h4 \{\s*font-family: var\(--font-cond\); font-size: 12px/, 'section headings are 12px');
  assert.match(renderJs, /if \(!c\.disabled\) c\.setAttribute\('aria-pressed'/, 'the current chip gets no aria-pressed');
  assert.match(css, /\.spotlight-callout\.arrow-right::before/);
});

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
