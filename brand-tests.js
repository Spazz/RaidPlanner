/**
 * PartyPlanner Web - brand-is-home tests (4.3.1)
 * Run: node brand-tests.js
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
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');
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

check('the title bar holds an h1.sr-only that can take focus', () => {
  const bar = html.slice(html.indexOf('<div class="title-bar">'));
  assert.match(bar.slice(0, 200), /^<div class="title-bar">\s*<h1 class="sr-only" tabindex="-1">Raidsmith<\/h1>/);
});

check('the phone block keeps the 44px tap area around the version button', () => {
  const at = css.indexOf('@media (max-width: 600px)');
  const block = css.slice(css.indexOf('/* Version tabs in the shell', at));
  const v = block.match(/\.version-btn::before\s*\{([^}]*)\}/);
  assert.ok(v, 'no .version-btn::before in the phone block');
  assert.match(v[1], /inset:\s*-6px 0/, '32px button + 6px up and down = a 44px tall tap area');
  assert.match(block, /\.version-btn\s*\{[^}]*min-height:\s*32px[^}]*position:\s*relative/);
});

check('the plan name is larger and gold, with the underline-only hover', () => {
  const rule = css.match(/\.roster-name\s*\{([^}]*)\}/)[1];
  assert.match(rule, /font-size:\s*15px/);
  assert.match(rule, /font-weight:\s*700/);
  assert.match(rule, /color:\s*var\(--btn-primary-bg\)/, 'the plan name uses the Optimize button gold');
  assert.match(rule, /letter-spacing:\s*0\.08em/);
  assert.match(css, /\.roster-name:hover\s*\{[^}]*var\(--btn-primary-bg\)[^}]*underline/);
  assert.match(css, /\.roster-name svg\s*\{[^}]*opacity:\s*0\.7/);
  assert.match(css, /#phone-plan-name-slot \.roster-name\s*\{[^}]*font-size:\s*15px/);
  assert.match(css, /#roster-name-text\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/);
});

check('the Coverage summary rows keep a gap between label and count (narrow rail rows)', () => {
  assert.match(css, /\.sidebar-summary-row\s*\{[^}]*gap:\s*6px/);
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

check('the title bar runs h1.sr-only, then the plan name', () => {
  const bar = html.slice(html.indexOf('<div class="title-bar">'));
  const h1 = bar.indexOf('<h1 class="sr-only" tabindex="-1">'), name = bar.indexOf('id="roster-name"');
  assert.ok(h1 >= 0 && h1 < name, 'order h1, roster-name');
  assert.ok(!/title-home/.test(html + css));
});

check('the title bar is 32px tall', () => {
  assert.match(css.match(/\.title-bar\s*\{([^}]*)\}/)[1], /height:\s*32px/);
});

check('the version button and menu sit before Share, with radio items in era order', () => {
  const bar = html.slice(html.indexOf('<div class="title-right'));
  assert.ok(bar.indexOf('id="version-menu-wrap"') < bar.indexOf('id="btn-share-menu"'));
  const btn = bar.match(/<button [^>]*id="btn-version-menu"[^>]*>/)[0];
  assert.match(btn, /title="Switch game version"/);
  assert.match(btn, /aria-label="Game version: TBC Anniversary"/);
  assert.match(bar, /<div class="menu" id="version-menu" role="menu" aria-label="Game version" hidden>/);
  const items = [...bar.slice(bar.indexOf('id="version-menu"')).matchAll(/<button [^>]*role="menuitemradio"[^>]*data-version="(\w+)"[^>]*>([^<]*)/g)];
  assert.deepEqual(items.map(m => m[1]), ['classic', 'tbc', 'forever']);
  assert.deepEqual(items.map(m => m[2]), ['WoW Classic', 'TBC Anniversary', 'WoW Forever']);
  assert.match(bar, /WoW Forever<span class="game-beta">Beta<\/span>/);
});

function runSync(version, confirmCalls, docExtra = {}) {
  const code = sliceBetween(renderJs, 'const VERSION_BUTTON_TEXT', '// Switching version refits');
  const attrs = {}, text = {};
  const button = { dataset: {}, focused: 0, focus() { this.focused++; }, setAttribute: (k, v) => { attrs.button = Object.assign(attrs.button || {}, { [k]: v }); } };
  const items = ['classic', 'tbc', 'forever'].map(v => ({ dataset: { version: v }, checked: null, setAttribute(k, val) { if (k === 'aria-checked') this.checked = val; } }));
  const tabs = [];
  const els = { 'btn-version-menu': button, 'version-btn-text': { set textContent(v) { text.btn = v; } }, 'btn-landing-random': {}, 'btn-optimize': {} };
  const sandbox = {
    State: { gameVersion: version, selectedRaid: 'r' }, Config: { Raids: { r: { size: 25 } } },
    GameVersions: { classic: { note: '' }, tbc: { note: '' }, forever: { note: '' } },
    renderRaidSizeControl() {}, switchGameVersion: v => confirmCalls.push(v),
    document: Object.assign({ body: {}, activeElement: null, querySelector: () => null, getElementById: id => els[id], querySelectorAll: sel => (sel === '#version-menu [data-version]' ? items : tabs) }, docExtra),
  };
  vm.runInNewContext(code + '\nsyncVersionControls();', sandbox);
  return { button, attrs, text, items };
}
check('syncVersionControls sets the version button text, data-version, aria-label and the items aria-checked', () => {
  const expected = { classic: ['Classic', 'WoW Classic'], tbc: ['TBC', 'TBC Anniversary'], forever: ['Forever', 'WoW Forever Beta'] };
  for (const v of Object.keys(expected)) {
    const r = runSync(v, []);
    assert.equal(r.text.btn, expected[v][0]);
    assert.equal(r.button.dataset.version, v);
    assert.equal(r.attrs.button['aria-label'], 'Game version: ' + expected[v][1]);
    assert.deepEqual(r.items.map(i => i.checked), ['classic', 'tbc', 'forever'].map(x => String(x === v)));
  }
});
check('picking a version item calls switchGameVersion with its version', () => {
  const calls = [];
  const r = runSync('tbc', calls);
  r.items[0].onclick(); r.items[2].onclick();
  assert.deepEqual(calls, ['classic', 'forever']);
});
check('after a version pick resolves, focus returns to the version button unless a dialog or a visible element has it', async () => {
  const hiddenItem = { closest: sel => (sel === '#version-menu' ? {} : null) };
  const visible = { closest: () => null };
  const cases = [
    [{ activeElement: hiddenItem }, 1, 'focus on the hidden menu item'],
    [{ activeElement: null }, 1, 'no focus'],
    [{ activeElement: visible }, 0, 'focus already on a visible element'],
    [{ activeElement: hiddenItem, querySelector: sel => (sel === 'dialog[open]' ? {} : null) }, 0, 'a dialog is open'],
  ];
  for (const [doc, focused, why] of cases) {
    const r = runSync('tbc', [], doc);
    r.items[0].onclick();
    await new Promise(res => setTimeout(res, 0));
    assert.equal(r.button.focused, focused, why);
  }
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

check('the phone slot list moves the version wrap beside the plan-name toggle in the top bar', () => {
  assert.match(appJs, /const slots = \['version-menu-wrap:phone-version-slot', 'btn-undo:phone-bar-undo-slot'/);
  const bar = sliceBetween(html, 'id="shell-topbar-plan"', 'id="shell-topbar-account"');
  const line1 = bar.indexOf('class="phone-summary-line1"'), b = bar.indexOf('id="phone-summary-toggle"'), c = bar.indexOf('id="phone-version-slot"');
  assert.ok(line1 > 0 && line1 < b && b < c, 'line 1, toggle, version slot');
  const wrap = html.slice(html.indexOf('id="phone-summary-wrap"'), html.indexOf('id="phone-context-body"'));
  assert.ok(!wrap.includes('phone-summary-line1') && wrap.includes('class="phone-summary-line2"'), 'the wrap keeps line 2 only');
});

check('the Share menu has three headed groups, then Share and export last', () => {
  const menu = sliceBetween(html, '<div class="menu" id="share-menu"', '<button type="button" class="menu-item" role="menuitem" id="btn-share-main"');
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
  assert.match(bar, /<nav class="game-version-nav" aria-label="Game version">/);
  assert.equal((bar.match(/class="game-version-tab"/g) || []).length, 3);
  assert.ok(!/href="#(?:faq|whats-new)"/.test(html), 'no link to the moved sections');
  assert.ok(!html.includes('landing-nav') && !html.includes('landing-brand') && !/>Features</.test(html) && !html.includes('class="features"') && !html.includes('id="features"'));
  assert.ok(!/\.landing-nav|\.features|\.feature\b/.test(css), 'dead CSS removed');
  const landing = sliceBetween(html, '<main class="landing" id="landing-view">', '</main>');
  assert.equal((landing.match(/<h1[ >]/g) || []).length, 1);
  assert.match(landing, /^<main class="landing" id="landing-view">\s*<h1 class="sr-only" tabindex="-1">Raidsmith<\/h1>/);
});

check('the hero wordmark is phone-only', () => {
  assert.match(html, /<div class="hero-copy">\s*<div class="hero-wordmark" aria-hidden="true">/);
  assert.match(css, /\.hero-wordmark\s*\{\s*display:\s*none/);
  const block = css.slice(css.indexOf('/* Version tabs in the shell'));
  assert.match(block, /\.hero-wordmark\s*\{\s*display:\s*flex/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
