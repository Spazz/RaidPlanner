/**
 * PartyPlanner Web - Wave 6 "Input & UX" tests
 * Run: node input-tests.js
 *
 * Same vm loader pattern as classic-tests.js/version-tests.js: the logic
 * half of index.html's <script> (everything before the '// ── UI RENDERING'
 * split marker) runs in a sandboxed context and the pieces under test are
 * pulled out through globalThis.api.
 *
 * Covers:
 *  - Import.parsePlainRoster (feature-backlog-2.md #6): every documented
 *    input format, CSV with/without a header, mixed garbage lines,
 *    duplicate names, and version-specific (Classic faction-lock) flagging.
 *  - PlanSession redo semantics (feature-backlog-2.md #7): undo/redo
 *    round-trip, a new change clearing the redo stack, and the 30-deep cap.
 *  - isTypingTarget (feature-backlog-2.md #8): the pure guard the global
 *    keyboard-shortcut dispatcher uses to avoid hijacking text input.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
app.compileFull(); // Compile the FULL script (including UI wiring) to catch syntax errors.
const ctx = app.sandbox(['State', 'Config', 'Rulesets', 'Import', 'PlanStore', 'PlanSession', 'isTypingTarget', 'nextUid']);
const { State, Config, Rulesets, Import, PlanStore, PlanSession, isTypingTarget, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function resetState() {
  State.groups = [];
  State.roster = [];
  State.bench = [];
  State.preferredSlots = [];
  State.buffOverrides = {};
  State.planId = null;
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
}

// ── 1. parsePlainRoster — one format at a time ──────────────────
check('Space-separated "Name Class Spec" resolves class/spec/role, order-independent', () => {
  const a = Import.parsePlainRoster('Thrall Shaman Enhancement', 'tbc');
  assert.equal(a.entries.length, 1);
  assert.deepEqual(
    { name: a.entries[0].name, class: a.entries[0].class, spec: a.entries[0].spec, role: a.entries[0].role, status: a.entries[0].status },
    { name: 'Thrall', class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps', status: 'ok' }
  );
  const b = Import.parsePlainRoster('Thrall Enhancement Shaman', 'tbc'); // spec then class
  assert.equal(b.entries[0].class, 'SHAMAN');
  assert.equal(b.entries[0].spec, 'Enhancement');
  assert.equal(b.entries[0].status, 'ok');
});

check('Dash-separated "Name - Spec Class" and "Name - Class Spec" both resolve', () => {
  const a = Import.parsePlainRoster('Jaina - Frost Mage', 'tbc');
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].name, 'Jaina');
  assert.equal(a.entries[0].class, 'MAGE');
  assert.equal(a.entries[0].spec, 'Frost');
  assert.equal(a.entries[0].role, 'caster_dps');
  assert.equal(a.entries[0].status, 'ok');
  const b = Import.parsePlainRoster('Jaina - Mage Frost', 'tbc');
  assert.equal(b.entries[0].class, 'MAGE');
  assert.equal(b.entries[0].spec, 'Frost');
});

check('CSV row "Name,Class,Spec,Role" resolves and honors an explicit role column', () => {
  const r = Import.parsePlainRoster('Uthar,Paladin,Retribution,melee_dps', 'tbc');
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.name, 'Uthar');
  assert.equal(e.class, 'PALADIN');
  assert.equal(e.spec, 'Retribution');
  assert.equal(e.role, 'melee_dps');
  assert.equal(e.status, 'ok');
  assert.equal(r.hasHeader, false);
});

check('CSV with an optional header row is skipped, not treated as a player', () => {
  const r = Import.parsePlainRoster('Name,Class,Spec\nGrom,Warrior,Fury\nVol,Priest,Holy', 'tbc');
  assert.equal(r.hasHeader, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].name, 'Grom');
  assert.equal(r.entries[0].class, 'WARRIOR');
  assert.equal(r.entries[1].class, 'PRIEST');
  assert.equal(r.entries[1].spec, 'Holy');
});

check('CSV row with an unrecognized class lands in unparsed, not entries', () => {
  const r = Import.parsePlainRoster('Bob,Deathknight,Blood', 'tbc');
  assert.equal(r.entries.length, 0);
  assert.equal(r.unparsed.length, 1);
  assert.equal(r.unparsed[0], 'Bob,Deathknight,Blood');
});

check('CSV row missing the spec column is imported but flagged for review', () => {
  const r = Import.parsePlainRoster('Bob,Warrior', 'tbc');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].class, 'WARRIOR');
  assert.equal(r.entries[0].status, 'needsReview');
  assert.match(r.entries[0].reason, /defaulted/i);
});

check('Discord-style "@Name (Spec Class)" resolves', () => {
  const r = Import.parsePlainRoster('@Illidan (Demonology Warlock)', 'tbc');
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.name, 'Illidan');
  assert.equal(e.class, 'WARLOCK');
  assert.equal(e.spec, 'Demonology');
  assert.equal(e.role, 'caster_dps');
  assert.equal(e.status, 'ok');
});

check('WoW /who-style "Name Level 60 Race Class" line: class only, spec defaulted and flagged', () => {
  const r = Import.parsePlainRoster('Grunty Level 60 Orc Warrior', 'tbc');
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.name, 'Grunty');
  assert.equal(e.class, 'WARRIOR');
  assert.ok(e.spec, 'a default spec is still assigned so the row is usable');
  assert.equal(e.status, 'needsReview');
  assert.match(e.reason, /spec not specified/i);
});

check('Mixed garbage lines are collected in unparsed, never crash the parser', () => {
  const text = [
    'Thrall Shaman Enhancement',
    'asdkjasd',
    '-----',
    '   ',
    'just some random words here',
  ].join('\n');
  const r = Import.parsePlainRoster(text, 'tbc');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'Thrall');
  assert.ok(r.unparsed.length >= 2, 'garbage lines are reported, not silently dropped or thrown');
  assert.ok(r.unparsed.includes('asdkjasd'));
});

check('Duplicate names: first is clean, later ones are flagged for review', () => {
  const text = 'Thrall Shaman Enhancement\nThrall Shaman Elemental';
  const r = Import.parsePlainRoster(text, 'tbc');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].status, 'ok');
  assert.equal(r.entries[1].status, 'needsReview');
  assert.match(r.entries[1].reason, /duplicate/i);
  // Both still resolved correctly — a duplicate is flagged, not corrupted.
  assert.equal(r.entries[1].class, 'SHAMAN');
  assert.equal(r.entries[1].spec, 'Elemental');
});

check('Comma-separated list without a header parses every row', () => {
  const text = 'Anduin,Priest,Holy\nVarian,Warrior,Protection';
  const r = Import.parsePlainRoster(text, 'tbc');
  assert.equal(r.hasHeader, false);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].role, 'healer');
  assert.equal(r.entries[1].role, 'tank');
});

check('Empty or whitespace-only text yields no entries and no crash', () => {
  const r1 = Import.parsePlainRoster('', 'tbc');
  assert.equal(r1.entries.length, 0);
  assert.equal(r1.unparsed.length, 0);
  const r2 = Import.parsePlainRoster('   \n   \n', 'tbc');
  assert.equal(r2.entries.length, 0);
});

// ── 2. Version-specific class validity (Classic Era faction lock) ──
check('Classic ruleset: a paste with both Shaman and Paladin is flagged, not rejected', () => {
  assert.equal(Rulesets.classic.rules.factionLock, true, 'sanity check on the fixture this test relies on');
  const text = 'Thrall Shaman Enhancement\nUther Paladin Retribution\nGrom Warrior Fury';
  const r = Import.parsePlainRoster(text, 'classic');
  assert.equal(r.entries.length, 3, 'nothing is rejected outright, only flagged');
  const shaman = r.entries.find(e => e.class === 'SHAMAN');
  const paladin = r.entries.find(e => e.class === 'PALADIN');
  const warrior = r.entries.find(e => e.class === 'WARRIOR');
  assert.equal(shaman.status, 'needsReview');
  assert.match(shaman.reason, /faction lock/i);
  assert.equal(paladin.status, 'needsReview');
  assert.match(paladin.reason, /faction lock/i);
  assert.equal(warrior.status, 'ok', 'a class with no faction restriction is unaffected');
});
check('Classic ruleset: an all-Horde paste (Shaman only, no Paladin) is not flagged for faction', () => {
  const r = Import.parsePlainRoster('Thrall Shaman Enhancement\nGrom Warrior Fury', 'classic');
  const shaman = r.entries.find(e => e.class === 'SHAMAN');
  assert.equal(shaman.status, 'ok');
});
check('TBC (no faction lock) never flags a mixed Shaman/Paladin paste for faction', () => {
  const r = Import.parsePlainRoster('Thrall Shaman Enhancement\nUther Paladin Retribution', 'tbc');
  assert.ok(r.entries.every(e => !e.reason || !/faction lock/i.test(e.reason)));
});

// ── 3. Redo semantics (feature-backlog-2.md #7) ─────────────────
function captureNamed(name) {
  State.roster[0].name = name;
  PlanSession.observe();
}
check('Undo then redo returns to the pre-undo state', () => {
  resetState();
  State.planId = 'plan:redo-test';
  State.groups = [[{ uid: nextUid(), name: 'A', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }]];
  State.roster = State.groups.flat();
  PlanSession.previous = null; PlanSession.undo = []; PlanSession.redo = []; PlanSession.ready = true; PlanSession.replaying = false;
  PlanSession.observe(); // establishes the baseline snapshot

  captureNamed('B');
  captureNamed('C');
  assert.equal(State.roster[0].name, 'C');
  assert.equal(PlanSession.undo.length, 2, 'two real changes recorded (A->B, B->C)');
  assert.equal(PlanSession.redo.length, 0);

  assert.equal(PlanSession.undoLast(), true);
  PlanSession.observe(); // the app always re-observes after replaying, same as undoPlanChange()
  assert.equal(State.roster[0].name, 'B', 'undo moved back one step');
  assert.equal(PlanSession.redo.length, 1);

  assert.equal(PlanSession.redoLast(), true);
  PlanSession.observe();
  assert.equal(State.roster[0].name, 'C', 'redo restored the undone step');
  assert.equal(PlanSession.redo.length, 0);
  PlanSession.ready = false;
});

check('A new change after an undo clears the redo stack', () => {
  resetState();
  State.planId = 'plan:redo-clear-test';
  State.groups = [[{ uid: nextUid(), name: 'A', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }]];
  State.roster = State.groups.flat();
  PlanSession.previous = null; PlanSession.undo = []; PlanSession.redo = []; PlanSession.ready = true; PlanSession.replaying = false;
  PlanSession.observe();

  captureNamed('B');
  assert.equal(PlanSession.undoLast(), true);
  PlanSession.observe();
  assert.equal(PlanSession.redo.length, 1, 'redo has one entry after the undo');

  captureNamed('D'); // a genuinely new change, not a replay
  assert.equal(PlanSession.redo.length, 0, 'the new change invalidated the redo stack');
  PlanSession.ready = false;
});

check('Undo and redo stacks both respect the 30-deep cap', () => {
  resetState();
  State.planId = 'plan:redo-depth-test';
  State.groups = [[{ uid: nextUid(), name: 'N0', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }]];
  State.roster = State.groups.flat();
  PlanSession.previous = null; PlanSession.undo = []; PlanSession.redo = []; PlanSession.ready = true; PlanSession.replaying = false;
  PlanSession.observe();

  for (let i = 1; i <= 35; i++) captureNamed('N' + i);
  assert.equal(PlanSession.undo.length, 30, 'undo stack caps at 30 even after 35 changes');

  let undone = 0;
  while (PlanSession.undoLast()) { PlanSession.observe(); undone++; }
  assert.equal(undone, 30, 'only the capped number of steps can be undone');
  assert.equal(PlanSession.redo.length, 30, 'redo stack caps at 30 too');

  let redone = 0;
  while (PlanSession.redoLast()) { PlanSession.observe(); redone++; }
  assert.equal(redone, 30);
  assert.equal(State.roster[0].name, 'N35', 'redoing everything returns to the latest state');
  PlanSession.ready = false;
});

// ── 4. Keyboard-shortcut input guard (feature-backlog-2.md #8) ──
check('isTypingTarget guards input/textarea/select/contenteditable, nothing else', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'input' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget({}), false, 'an object with no tagName is never a typing target');
});

console.log(`\nInput/UX tests: ${passed} passed, 0 failed, ${passed} total`);
