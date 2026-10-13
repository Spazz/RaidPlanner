/**
 * PartyPlanner Web - keyboard access for buff icons and the buff picker
 * Run: node buffkeys-tests.js
 *
 * Swappable buff icons and picker rows are <button>s (Enter/Space open and pick for free),
 * with an accessible name; non-swappable icons (drums) stay divs. After a pick the
 * re-render rebuilds the cards, so focus is handed back to the same icon.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const norm = (s) => s.replace(/\r\n/g, '\n');
const renderSrc = norm(app.slice('function renderGroups() {', '// Buff picker delegation'));
const pickerSrc = norm(app.slice('function showBuffPicker(', 'function closeBuffPicker'));

check('swappable buff icons render as buttons with an accessible name; drums stay divs', () => {
  const m = renderSrc.match(/const iconTag = isSwappable \? 'button' : 'div';/);
  assert(m, 'icon tag is chosen from isSwappable');
  assert(/const iconAttrs = isSwappable \? ` type="button" aria-label="\$\{esc\(b\.buff\.name\)\}: choose another buff"` : '';/.test(renderSrc),
    'button type and escaped aria-label only on swappable icons');
  assert(/<\$\{iconTag\} class="buff-icon [^`]*<\/\$\{iconTag\}>/.test(renderSrc), 'icon uses the chosen tag for open and close');
  assert(/<div class="buff-icon \$\{Config\.BuffCSSClass\.DRUMS\}/.test(renderSrc), 'drum icon is still a div');
  assert(!/<div class="buff-icon \$\{css\}/.test(renderSrc), 'no swappable-capable icon is a bare div any more');
});

check('picker items and the reset row are buttons', () => {
  assert(/<button type="button" class="buff-picker-item/.test(pickerSrc));
  assert(/<button type="button" class="buff-picker-reset"/.test(pickerSrc));
  assert(!/<div class="buff-picker-(item|reset)/.test(pickerSrc), 'no div pickers left');
});

check('Escape in the picker closes it and returns focus to the icon', () => {
  assert(/picker\.addEventListener\('keydown'[\s\S]*?e\.key !== 'Escape'[\s\S]*?closeBuffPicker\(\);[\s\S]*?buffIcon\.focus\(/.test(pickerSrc));
});

check('focus is restored to the same icon after a pick, even though the buff id changed', () => {
  const src = app.slice('let pendingBuffIconFocus', 'function seatedSlotHTML');
  const mk = (dataset) => { const i = { dataset, focused: null, focus(o) { i.focused = o; document.activeElement = i; } }; return i; };
  const document = { activeElement: null, icons: [], querySelectorAll(sel) { assert.equal(sel, '.buff-icon.swappable'); return this.icons; } };
  const c = app.sandbox(['rememberBuffIconFocus', 'restoreBuffIconFocus'], { globals: { document }, extraSource: src });
  const { rememberBuffIconFocus, restoreBuffIconFocus } = c.api;

  // Pick replaces the default (WF) with another totem (GoA) in group 1; the rebuilt icon carries the new id.
  rememberBuffIconFocus(1, 'u5', ['GOA', 'WF']);
  const otherGroup = mk({ group: '2', buffId: 'GOA', uid: 'u5' });
  const otherPlayer = mk({ group: '1', buffId: 'GOA', uid: 'u9' });
  const rebuilt = mk({ group: '1', buffId: 'GOA', uid: 'u5' });
  document.icons = [otherGroup, otherPlayer, rebuilt];
  restoreBuffIconFocus();
  assert.equal(document.activeElement, rebuilt);
  assert.deepEqual({ ...rebuilt.focused }, { preventScroll: true });

  // The key is single-use: a later render steals nothing.
  document.activeElement = null;
  restoreBuffIconFocus();
  assert.equal(document.activeElement, null);

  // Icon gone (e.g. the source left the group): nothing to focus, no error.
  rememberBuffIconFocus(0, 'u1', ['WF']);
  document.icons = [otherGroup];
  restoreBuffIconFocus();
  assert.equal(document.activeElement, null);

  // Wired in: picks remember the icon before the re-render, and the render restores it.
  assert(/rememberBuffIconFocus\(groupIndex, sourceUid, \[pickId, existingOriginal\]\);\s*closeBuffPicker\(\);\s*commit\(\);/.test(pickerSrc));
  assert(/restorePlayerSlotFocus\(focusedSlot\);\s*restoreBuffIconFocus\(\);/.test(renderSrc));
});

check('the button reset keeps the old look: a zero-specificity reset exists for icon and picker buttons', () => {
  const css = norm(app.css);
  const m = css.match(/:where\(button\.buff-icon, button\.buff-picker-item, button\.buff-picker-reset\)\s*\{([^}]*)\}/);
  assert(m, 'reset rule for the buff buttons');
  for (const decl of ['appearance: none', 'background: transparent', 'border: 0', 'font: inherit', 'line-height: inherit', 'color: inherit']) {
    assert(m[1].includes(decl), 'reset sets ' + decl);
  }
  assert(/:where\(button\.buff-picker-item, button\.buff-picker-reset\)\s*\{\s*width: 100%/.test(css), 'picker rows fill the picker like the divs did');
  assert(/\.buff-icon\.swappable:focus-visible[^{]*\{[^}]*outline/.test(css), 'keyboard focus is visible');
});

console.log(`\n${passed} buff keyboard checks passed`);
