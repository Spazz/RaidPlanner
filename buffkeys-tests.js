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
  assert(/const iconAttrs = isSwappable\s*\? ` type="button" aria-label="\$\{esc\(swappableBuffLabel\(b, from\)\)\}"`\s*: ` role="img" aria-label="\$\{esc\(b\.buff\.name\)\}"`;/.test(renderSrc),
    'button type and escaped label on swappable icons; role=img and the escaped buff name on the others');
  assert(/<\$\{iconTag\} class="buff-icon [^`]*<\/\$\{iconTag\}>/.test(renderSrc), 'icon uses the chosen tag for open and close');
  assert(/<div class="buff-icon \$\{Config\.BuffCSSClass\.DRUMS\}[^`]*role="img" aria-label="Drums"/.test(renderSrc), 'drum icon is still a div, named for assistive tech');
  assert(!/<div class="buff-icon \$\{css\}/.test(renderSrc), 'no swappable-capable icon is a bare div any more');
});

check('swappable icon names read "<buff> from <player>" and offer the picker hint only with a real choice', () => {
  const c = app.sandbox(['swappableBuffLabel'], { extraSource: app.slice('function getSwappableBuffs', 'function closeBuffPicker') });
  const { swappableBuffLabel } = c.api;
  const buff = (id, name, spec) => ({ id, buff: { name }, sourceClass: 'SHAMAN', sourceSpec: spec });
  // Windfury has three air totems to pick from; Strength of Earth has only itself.
  assert.equal(swappableBuffLabel(buff('WINDFURY', 'Windfury', 'Enhancement'), 'Bob'), 'Windfury from Bob: choose another buff');
  assert.equal(swappableBuffLabel(buff('STRENGTH_OF_EARTH', 'Strength of Earth', 'Enhancement'), 'Bob'), 'Strength of Earth from Bob');
  assert.equal(swappableBuffLabel(buff('STRENGTH_OF_EARTH', 'Strength of Earth', undefined), ''), 'Strength of Earth');
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

check('Open slot cards say Suggested (Optimize) or Requested (leader) in both the line and the badge', () => {
  // Runs the real renderGroups on one group holding an auto entry and a leader's entry; everything it calls but the cards is stubbed.
  let html = '';
  const noop = () => {};
  // Any other element the surrounding script touches while loading answers every method with a no-op.
  const lenient = (own) => new Proxy(own, { get: (t, k) => (k in t ? t[k] : (k === 'classList' ? { toggle: noop, add: noop, remove: noop, contains: () => false } : (k === 'style' || k === 'dataset') ? {} : noop)) });
  const container = lenient({ set innerHTML(v) { html = v; }, get innerHTML() { return html; } });
  const el = lenient({ textContent: '' });
  const c = app.sandbox(['State', 'PreferredSlots', 'renderGroups'], { extraSource: renderSrc + ' function renderBuffCatalog() {} function renderUtilityCatalog() {} function renderBalanceWarnings() {} function renderSummaryBar() {} function updateStatus() {} function renderManualChanges() {} function syncVersionControls() {} function syncRaidNotesUI() {} function renderCampfires() {} function renderAssignments() {} function renderReadiness() {}', globals: {
    document: lenient({ getElementById: id => id === 'groups-container' ? container : el, querySelectorAll: () => [] }),
    capturePlayerSlotFocus: noop, restorePlayerSlotFocus: noop, restoreBuffIconFocus: noop, getGroupBuffs: () => [],
    getDominantRoleLabel: () => 'MELEE', getSpecIcon: () => '', preferredColorClass: () => '', seatedSlotHTML: () => '',
    getRaidDebuffCoverage: () => new Set(), renderBuffCatalog: noop, renderUtilityCatalog: noop, renderBalanceWarnings: noop,
    renderSummaryBar: noop, updateStatus: noop, SignupTray: { render: noop }, renderManualChanges: noop, ChangesPanel: { render: noop },
    syncVersionControls: noop, syncRaidNotesUI: noop, RaidHelperSync: { updateControls: noop }, renderCampfires: noop,
    renderAssignments: noop, renderReadiness: noop, Drummers: { isDrummer: () => false },
    classColorClass: () => "", setInterval: noop, setTimeout: noop, clearTimeout: noop, clearInterval: noop,
  } });
  const { State, renderGroups } = c.api;
  State.groups = [[]];
  State.preferredSlots = [{ group: 0, class: 'MAGE', spec: 'Frost', auto: true }, { group: 0, class: 'PRIEST', spec: 'Holy' }];
  renderGroups();
  const cards = html.split('<div class="player-slot preferred-slot').slice(1);
  assert.equal(cards.length, 2, 'both Open slots render');
  const words = (card) => [card.match(/<span class="player-spec" title="([^"]*)">([^<]*)</), card.match(/<span class="preferred-badge">([^<]*)</)];
  const [autoSpec, autoBadge] = words(cards[0]);
  assert.equal(autoSpec[2], 'Suggested by Optimize');
  assert.equal(autoSpec[1], 'Suggested by Optimize', 'the full text is on hover');
  assert.equal(autoBadge[1], 'SUGGESTED');
  const [ownSpec, ownBadge] = words(cards[1]);
  assert.equal(ownSpec[2], 'Requested, awaiting sign-up');
  assert.equal(ownBadge[1], 'REQUESTED');
});

check('the Open slot spec line stays on one line and ends in an ellipsis', () => {
  assert(/\.preferred-slot \.player-spec \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/.test(norm(app.css)));
});

check('.player-spec is 10.5px on desktop and 11px in the phone block; Open slot colours are unchanged', () => {
  const css = norm(app.css);
  assert(/\n\.player-spec \{ font-size: 10\.5px;/.test(css));
  const phone = css.slice(css.lastIndexOf('/* ── Slim phone layout'));
  assert(/\.player-spec \{ font-size: 11px; \}/.test(phone));
  assert(/\.preferred-slot \{ border: 1px dashed var\(--preferred-color\);/.test(css));
  assert(/\.preferred-badge \{ color: var\(--preferred-color\); font-size: 9px;/.test(css));
});

console.log(`\n${passed} buff keyboard checks passed`);
