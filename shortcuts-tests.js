/**
 * PartyPlanner Web - keyboard shortcut tests
 * Run: node shortcuts-tests.js
 *
 * Runs the real global keydown handler from js/app.js against a stub document and checks:
 * which key clicks which toolbar button, that nothing fires while typing, while a dialog,
 * menu or editor is open, or with Ctrl/Cmd held; that the shortcuts help and the menu
 * <kbd> hints list exactly the shortcuts the handler has; and that the Ctrl+S labels
 * say "Save a copy" (the plan autosaves, so Save is not "the" save).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const chunk = app.slice('const SHORTCUT_BUTTONS', '// ── INITIALIZE');

function harness({ view = 'app', dialogOpen = false, menuOpen = false, editor = false } = {}) {
  const clicks = [];
  const handlers = {};
  const element = (id) => ({ id, click: () => clicks.push(id), classList: { contains: () => false }, addEventListener() {}, set innerHTML(v) {}, showModal() {} });
  const document = {
    getElementById: (id) => (id === 'active-player-editor' ? (editor ? element(id) : null) : element(id)),
    querySelector: (sel) => (sel === 'dialog[open]' ? (dialogOpen ? {} : null) : sel === '.menu:not([hidden])' ? (menuOpen ? {} : null) : null),
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
  };
  const ctx = app.sandbox(['State', 'SHORTCUT_BUTTONS', 'SHORTCUTS_HELP'], { globals: { document }, extraSource: chunk });
  ctx.api.State.view = view;
  const press = (key, { target = { tagName: 'BODY' }, ...mods } = {}) => {
    const e = { key, target, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...mods };
    for (const fn of handlers.keydown) fn(e);
    return e;
  };
  return { clicks, press, api: ctx.api };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('M, L and C click the MRT note, share link and raid chat buttons; O and E still work', () => {
  const h = harness();
  for (const key of ['m', 'l', 'c', 'o', 'e']) assert(h.press(key).defaultPrevented, key);
  assert.equal(JSON.stringify(h.clicks), JSON.stringify(['btn-copy-mrt-note', 'btn-share', 'btn-copy-chat', 'btn-optimize', 'btn-share-main']));
  h.press('M'); // caps lock / shift
  assert.equal(h.clicks.at(-1), 'btn-copy-mrt-note');
});

check('shortcuts stay quiet while typing, with a dialog or menu or the player editor open, on the landing page, and with Ctrl/Cmd/Alt held', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const h = harness();
    h.press('m', { target: { tagName } });
    assert.equal(h.clicks.length, 0, tagName);
  }
  const editable = harness();
  editable.press('c', { target: { tagName: 'DIV', isContentEditable: true } });
  assert.equal(editable.clicks.length, 0, 'contenteditable');
  for (const state of [{ dialogOpen: true }, { menuOpen: true }, { editor: true }, { view: 'landing' }]) {
    const h = harness(state);
    for (const key of ['m', 'l', 'c']) h.press(key);
    assert.equal(h.clicks.length, 0, JSON.stringify(state));
  }
  const h = harness();
  h.press('c', { ctrlKey: true });   // browser copy
  h.press('l', { metaKey: true });   // browser address bar
  h.press('m', { altKey: true });
  assert.equal(h.clicks.length, 0, 'modifier combos are never eaten');
});

check('existing shortcuts are unchanged (1, 2, ?, Ctrl+Z/Y/S)', () => {
  const h = harness();
  h.press('z', { ctrlKey: true });
  h.press('y', { metaKey: true });
  h.press('s', { ctrlKey: true });
  assert.equal(JSON.stringify(h.clicks), JSON.stringify(['btn-undo', 'btn-redo', 'btn-save']));
});

check('no two shortcuts share a key and none collides with 1, 2 or ?', () => {
  const { SHORTCUT_BUTTONS } = harness().api;
  const keys = Object.keys(SHORTCUT_BUTTONS);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert(/^[a-z]$/.test(key), key);
});

check('every shortcut button exists in the page and the help lists its key', () => {
  const { api } = harness();
  const helpKeys = api.SHORTCUTS_HELP.map(([keys]) => keys);
  for (const [key, id] of Object.entries(api.SHORTCUT_BUTTONS)) {
    assert(app.html.includes(`id="${id}"`), `${id} is in index.html`);
    assert(helpKeys.includes(key.toUpperCase()), `help lists ${key.toUpperCase()}`);
  }
});

check('the share menu items carry a <kbd> hint and aria-keyshortcuts for M, L, C and E', () => {
  const hints = { 'btn-share': 'L', 'btn-copy-mrt-note': 'M', 'btn-copy-chat': 'C', 'btn-share-main': 'E' };
  for (const [id, key] of Object.entries(hints)) {
    const tag = app.html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>[\\s\\S]*?</button>'))[0];
    assert(tag.includes(`aria-keyshortcuts="${key}"`), `${id} aria-keyshortcuts`);
    assert(tag.includes(`<kbd class="menu-kbd" aria-hidden="true">${key}</kbd>`), `${id} kbd`);
  }
});

check('Ctrl+S is labelled "Save a copy" everywhere (menu, tooltip, help)', () => {
  const save = app.html.match(/<button[^>]*id="btn-save"[^>]*>[\s\S]*?<\/button>/)[0];
  assert(/aria-label="Save a copy/.test(save) && /title="Save a copy \(Ctrl\+S\)/.test(save));
  assert(!/Save roster|Save current roster/.test(app.html + app.script));
  const row = harness().api.SHORTCUTS_HELP.find(([keys]) => keys === 'Ctrl/Cmd + S');
  assert(/^Save a copy/.test(row[1]) && /saves itself/.test(row[1]));
});

console.log(`\nShortcut tests: ${passed} passed, 0 failed, ${passed} total`);
