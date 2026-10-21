/**
 * PartyPlanner Web - brand-is-home tests (4.3.1)
 * Run: node tests/site/brand-tests.js
 *
 * The era band is gone (step 2b): the shell's brand and Planner item are the way home, the planner's header row
 * lives in the shell's top bar and starts with the plan name.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const read = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('app.css');
const appJs = read('js/app.js');
const renderJs = read('js/render.js');

check('btn-home and title-home are gone', () => {
  assert.ok(!/btn-home/.test(html + appJs), 'btn-home left in html or app.js');
  assert.ok(!/title-home/.test(html + css), 'title-home left in html or css');
});

check('the era band, the brand link and the planner-home link are gone, with their handlers and CSS', () => {
  assert.ok(!/id="era-band"|class="game-header"|game-header-brand|game-header-links/.test(html), 'era band markup left in index.html');
  assert.ok(!/brand-home|planner-home|phone-home-slot/.test(html + appJs + css), 'brand-home / planner-home / phone-home-slot left');
  assert.ok(!/\.game-header(?![\w-])|\.game-header-(?:inner|brand|links)/.test(css), 'era band CSS left in app.css');
});

check('the plan view has no title bar: its h1 is the plan name button in the head, after the Your plans back link', () => {
  assert.ok(!html.includes('class="title-bar"') && !/\.title-bar/.test(css), 'the title bar is gone');
  const head = html.slice(html.indexOf('<header class="gs-pb-planhead"'), html.indexOf('</header>', html.indexOf('<header class="gs-pb-planhead"')));
  const back = head.indexOf('id="btn-back-plans"'), h1 = head.indexOf('<h1 class="gs-pb-h1 plan-only" tabindex="-1">'), name = head.indexOf('id="roster-name"');
  assert.ok(back >= 0 && back < h1 && h1 < name, 'order back link, h1, roster-name');
  assert.ok(!/title-home/.test(html + css));
});

check('the plan name is a 28px white h1 button with the underline-only hover and an ellipsis that lets it give way first', () => {
  const g = read('guild.css');
  assert.match(g, /\.gs-pb-h1 \{[^}]*font: 700 28px\/1\.1 var\(--font-cond\)[^}]*text-transform: uppercase; color: var\(--text-primary\)/);
  assert.match(g, /\.gs-pb-name:hover \{ text-decoration: underline;/);
  assert.match(g, /\.gs-pb-name svg \{[^}]*opacity: 0\.6/);
  assert.match(g, /#roster-name-text \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.roster-name\b|\.version-btn|\.share-btn|\.btn-icon\b/, 'the title-bar button rules are gone from app.css');
});

// ── 4.4.0: one planner header row, one landing brand row, Share menu headings ──
function sliceBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'cannot slice ' + from);
  return src.slice(a, b);
}

check('showView sets body[data-planner-view], fires planner:view, ends the full landing and scrolls only while the planner is active', () => {
  const body = sliceBetween(appJs, 'function showView(view) {', '\n}\n') + '\n}';
  const els = { 'landing-view': { hidden: false }, app: { hidden: true } };
  const classes = new Set(['landing-full']);
  const events = [];
  const scrolls = [];
  let active = true;
  const sandbox = {
    State: { activeTab: 'plan' },
    document: {
      getElementById: id => els[id],
      body: { dataset: {}, classList: { remove: c => classes.delete(c), add: c => classes.add(c), contains: c => classes.has(c) } },
      dispatchEvent: e => { events.push(e.type + ':' + e.detail.view); return true; },
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    renderLanding() {}, switchTab() {}, scheduleSpotlightQueue() {}, plannerActive: () => active, window: { scrollTo: () => scrolls.push(1) },
  };
  vm.runInNewContext(body + '\nglobalThis.showView = showView;', sandbox);
  sandbox.showView('app');
  assert.equal(sandbox.document.body.dataset.plannerView, 'app');
  assert.equal(els.app.hidden, false);
  assert.equal(els['landing-view'].hidden, true);
  assert.ok(!classes.has('landing-full'), 'opening the planner ends the full landing');
  sandbox.showView('landing');
  assert.equal(sandbox.document.body.dataset.plannerView, 'landing');
  assert.deepEqual(events, ['planner:view:app', 'planner:view:landing']);
  assert.equal(scrolls.length, 2);
  active = false;
  sandbox.showView('app');
  assert.equal(scrolls.length, 2, 'no scroll while a guild page covers the planner');
  assert.equal(sandbox.document.body.dataset.plannerView, 'app', 'the attribute still follows the view');
  assert.ok(!/era-band|eraBand/.test(body), 'showView no longer touches the era band');
});

check('the version segments live in Raid settings, in era order; the title-bar version button and menu are gone', () => {
  assert.ok(!/btn-version-menu|id="version-menu|version-btn-text|version-menu-wrap/.test(html + appJs + renderJs));
  const dialog = sliceBetween(html, '<dialog id="raid-settings-dialog"', '</dialog>');
  const items = [...dialog.slice(dialog.indexOf('id="raid-version-control"')).matchAll(/<button [^>]*data-version="(\w+)"[^>]*aria-label="([^"]+)"[^>]*>([^<]*)/g)];
  assert.deepEqual(items.map(m => m[1]), ['classic', 'tbc', 'forever']);
  assert.deepEqual(items.map(m => m[2]), ['WoW Classic', 'TBC Anniversary', 'WoW Forever Beta']);
  assert.deepEqual(items.map(m => m[3]), ['Classic', 'TBC', 'Forever beta']);
  assert.match(dialog, /id="raid-size-control" role="group" aria-labelledby="raid-size-label"/);
});

function runSync(version, { modeled = true } = {}) {
  const code = sliceBetween(renderJs, 'function syncVersionControls', '// Switching version refits');
  const optimize = { disabled: null, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const reason = { hidden: true, textContent: '' };
  const segs = ['classic', 'tbc', 'forever'].map(v => ({ dataset: { version: v }, pressed: null, setAttribute(k, val) { if (k === 'aria-pressed') this.pressed = val; } }));
  const tabs = ['classic', 'tbc', 'forever'].map(v => ({ dataset: { version: v }, pressed: null, setAttribute(k, val) { if (k === 'aria-pressed') this.pressed = val; } }));
  const els = { 'btn-landing-random': {}, 'btn-optimize': optimize, 'optimize-reason': reason };
  const sandbox = {
    State: { gameVersion: version, selectedRaid: 'r' }, Config: { Raids: { r: { size: 25 } } },
    GameVersions: { classic: { modeled: true }, tbc: { modeled }, forever: { modeled: true } },
    renderRaidSizeControl() {}, switchGameVersion() {},
    document: { getElementById: id => els[id], querySelectorAll: sel => (sel === '#raid-version-control [data-version]' ? segs : tabs) },
  };
  vm.runInNewContext(code + '\nsyncVersionControls();', sandbox);
  return { optimize, reason, segs, tabs };
}
check('syncVersionControls marks the era tabs and the Raid settings segments; an unmodeled version disables Optimize and says why beside it', () => {
  for (const v of ['classic', 'tbc', 'forever']) {
    const r = runSync(v);
    assert.deepEqual(r.segs.map(s => s.pressed), ['classic', 'tbc', 'forever'].map(x => String(x === v)));
    assert.deepEqual(r.tabs.map(s => s.pressed), ['classic', 'tbc', 'forever'].map(x => String(x === v)));
    assert.equal(r.optimize.disabled, false);
    assert.equal(r.reason.hidden, true);
  }
  const off = runSync('tbc', { modeled: false });
  assert.equal(off.optimize.disabled, true);
  assert.equal(off.optimize.attrs['aria-describedby'], 'optimize-reason');
  assert.equal(off.reason.hidden, false);
  assert.match(off.reason.textContent, /needs rules for this version/);
});
check('picking a version in Raid settings closes the dialog first (never stacked), switches, and reopens it when the confirm is declined', () => {
  const src = sliceBetween(appJs, 'function openRaidSettingsDialog', '// ── PHONE "MORE" SHEET');
  assert.match(src, /raid-version-control'\)\.addEventListener\('click', async \(e\) => \{[\s\S]*closeRaidSettingsDialog\(\);\s*const switched = await switchGameVersion\(button\.dataset\.version\);\s*if \(!switched && State\.view === 'app'\) openRaidSettingsDialog\(\);/);
  assert.match(src, /raid-size-control'\)\.addEventListener\('click', \(e\) => \{ if \(e\.target\.closest\('\[data-raid-size\]'\)\) closeRaidSettingsDialog\(\); \}\);/);
});

check('Menu keyboard navigation includes menuitemradio items', () => {
  const code = sliceBetween(renderJs, 'const Menu = {', 'Menu._onDocMouseDown');
  const all = [{ role: 'menuitem' }, { role: 'menuitemradio' }, { role: 'other' }].map(o => Object.assign(o, { hidden: false, disabled: false }));
  const menu = { querySelectorAll: sel => all.filter(o => sel.split(',').some(p => p.trim() === '[role="' + o.role + '"]')) };
  const sandbox = { document: {}, window: {} };
  vm.runInNewContext(code + '\nglobalThis.Menu = Menu;', sandbox);
  assert.equal(JSON.stringify(sandbox.Menu.items(menu).map(o => o.role)), JSON.stringify(["menuitem", "menuitemradio"]));
  assert.match(code, /closest\('\[role="menuitem"\], \[role="menuitemradio"\]'\)/);
});

check('the More menu lists Changes, Raid settings, Reference comp, Raid notes, then Plan, Sign-ups and Data & help', () => {
  const menu = sliceBetween(html, '<div class="menu gs-menu-list gs-pb-menu" id="settings-menu"', 'id="btn-phone-more"');
  const labels = [...menu.matchAll(/<div class="menu-heading[^"]*" id="menu-heading-\w+">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ['Plan', 'Sign-ups', 'Data &amp; help']);
  const ids = [...menu.matchAll(/ id="(btn-[\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['btn-changes', 'btn-raid-settings', 'btn-ideal-comp-link', 'btn-raid-notes-toggle',
    'btn-new-plan', 'btn-load', 'btn-save', 'btn-templates', 'btn-split-plan', 'btn-clear',
    'btn-refresh', 'btn-attendance', 'btn-random', 'btn-export-backup', 'btn-import-backup', 'btn-shortcuts-help', 'btn-show-tips-again']);
});

check('the Share menu has three headed groups, then Share and export last', () => {
  const menu = sliceBetween(html, '<div class="menu gs-menu-list gs-pb-menu" id="share-menu"', '<button type="button" class="menu-item" role="menuitem" id="btn-share-main"');
  const groups = [...menu.matchAll(/<div role="group" aria-labelledby="(menu-heading-\w+)">\s*<div class="menu-heading" id="\1">([^<]+)<\/div>([\s\S]*?)<\/div>\s*(?=<div class="menu-sep"><\/div>)/g)];
  assert.deepEqual(groups.map(g => [g[1], g[2]]), [['menu-heading-game', 'Into the game'], ['menu-heading-raid', 'Send to the raid'], ['menu-heading-other', 'Other']]);
  const ids = g => [...g[3].matchAll(/id="(btn-[\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids(groups[0]), ['btn-copy-mrt', 'btn-copy-mrt-note']);
  assert.deepEqual(ids(groups[1]), ['btn-share', 'btn-copy-chat', 'btn-copy-chat-compact']);
  assert.deepEqual(ids(groups[2]), ['btn-print-sheet']);
  assert.equal((menu.match(/class="menu-sep"/g) || []).length, 3, 'a separator after each group');
  const after = html.slice(html.indexOf('id="btn-share-main"'));
  assert.ok(after.indexOf('</div>') > after.indexOf('btn-share-main'));
});

check('the landing has no brand row of its own: version tabs in the top bar, no landing-nav, no Features, no cards', () => {
  const bar = sliceBetween(html, 'id="shell-topbar-plan"', 'id="shell-topbar-account"');
  assert.match(bar, /<nav class="game-version-nav gs-fg-segs" aria-label="Game version">/);
  assert.equal((bar.match(/class="game-version-tab gs-fg-seg"/g) || []).length, 3, 'three Forge segments');
  assert.ok(!/href="#(?:faq|whats-new)"/.test(html), 'no link to the moved sections');
  assert.ok(!html.includes('landing-nav') && !html.includes('landing-brand') && !/>Features</.test(html) && !html.includes('class="features"') && !html.includes('id="features"'));
  assert.ok(!/\.landing-nav|\.features|\.feature\b/.test(css), 'dead CSS removed');
  const landing = sliceBetween(html, '<main class="landing" id="landing-view">', '</main>');
  assert.equal((landing.match(/<h1[ >]/g) || []).length, 1);
  assert.match(landing, /^<main class="landing" id="landing-view">\s*<h1 class="sr-only" tabindex="-1">Raidsmith<\/h1>/);
});

check('top-bar rules: the planner slot hides on guild sections and static pages and holds the version tabs on the landing only', () => {
  assert.match(css, /body\.shell-section-guild #shell-topbar-plan, body\.shell-section-page #shell-topbar-plan \{ display: none; \}/);
  assert.match(css, /#shell-topbar-plan \{[^}]*flex: 1 1 0;[^}]*min-width: 0/);
  assert.match(css, /body\[data-planner-view="landing"\]:not\(\.has-planner-guild\):not\(\.shell-pending\) #shell-topbar-plan \.game-version-nav \{ display: inline-flex/, 'tabs: landing only, never in a guild, not while the session question is open');
  assert.match(css, /#shell-topbar-plan \{[^}]*justify-content: flex-end/, 'the tabs sit at the right of the bar, before the account area');
  assert.match(css, /#shell-topbar-plan \.game-version-nav \{ display: none; \}/, 'the plan view leaves the slot empty: its head is inside the page');
  assert.doesNotMatch(css, /#shell-topbar-plan \.(title-bar|phone-summary-line1|roster-name)/);
  assert.ok(!/#shell-topbar-plan \{[^}]*position:\s*sticky/.test(css), 'the top bar is not sticky');
});

check('landing modes: full when signed out or on How it works, compact when signed in, only the import card while pending', () => {
  assert.match(css, /\.landing-compact-head, \.landing-compact-help \{ display: none; \}/);
  for (const part of ['.hero-copy', '#how-it-works', '#version-comparison', '.landing-footer']) {
    assert.ok(css.includes('body:not(.is-signed-out):not(.landing-full) #landing-view ' + part), 'compact hides ' + part);
    assert.ok(css.includes('body.shell-pending #landing-view ' + part), 'pending hides ' + part);
  }
  assert.match(css, /body:not\(\.is-signed-out\):not\(\.landing-full\):not\(\.shell-pending\) #landing-view \.landing-compact-head,/);
});

check('#planner-root reproduces the old body layout: centred column, 16px gutters above 1100px, safe areas only below', () => {
  const rule = css.match(/\n\.planner-root \{([^}]*)\}/)[1];
  assert.match(rule, /flex-direction: column/);
  assert.match(rule, /align-items: center/);
  assert.match(rule, /padding: 0 max\(16px, env\(safe-area-inset-right, 0px\)\) 8px max\(16px, env\(safe-area-inset-left, 0px\)\)/);
  assert.match(css, /@media \(max-width: 1100px\) \{\s*\.planner-root \{ padding: 0 env\(safe-area-inset-right, 0px\) 0 env\(safe-area-inset-left, 0px\); \}/);
});

check('the hero wordmark is phone-only', () => {
  assert.match(html, /<div class="hero-copy">\s*<div class="hero-wordmark" aria-hidden="true">/);
  assert.match(css, /\.hero-wordmark\s*\{\s*display:\s*none/);
  const block = css.slice(css.indexOf('/* Version tabs in the shell'));
  assert.match(block, /\.hero-wordmark\s*\{\s*display:\s*flex/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
