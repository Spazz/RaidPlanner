/**
 * PartyPlanner Web - State and persistence tests (Phase 1, group G4)
 * Run: node state-persistence-tests.js
 *
 * B6  Split Raid B save: a failed save must leave the plan unsplit and say so.
 * B16 PP:1 import: starts a fresh plan instead of merging into the open one.
 * B18 loadRoster: a player whose group is out of range goes to the bench.
 * B22 Event start time: stored with the plan, used by chat export and print sheet.
 *
 * Same vm loader pattern as rosters-tests.js. SplitFlow lives in the UI half of
 * index.html, so it is sliced in with minimal DOM stubs.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

// Minimal DOM: every id resolves to a recording element.
const elements = {};
function el(id) {
  return elements[id] || (elements[id] = {
    id, hidden: false, textContent: '', innerHTML: '', closed: 0,
    classList: { add() {}, remove() {} },
    close() { this.closed++; },
    showModal() {},
    addEventListener() {},
  });
}
const toasts = [];
const rendered = { count: 0 };
const fakeStorage = {
  data: new Map(), failWrites: false,
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; },
  setItem(k, v) {
    if (this.failWrites) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.data.set(k, v);
  },
};

const SPLIT_SOURCE = app.slice('const SplitFlow = {', "document.getElementById('btn-split-offer')");
const ctx = app.sandbox(
  ['State', 'Config', 'Import', 'PlanStore', 'PrintSheet', 'NO_ROSTER_NAME', 'RaidSplit', 'Assignments', 'Backups',
    'nextUid', 'SplitFlow', 'Optimizer'],
  {
    globals: {
      document: { getElementById: el },
      localStorage: fakeStorage,
      showToast: (m) => { toasts.push(m); },
      commit: () => { rendered.count++; },
    },
    extraSource: SPLIT_SOURCE,
  }
);
const { State, Config, Import, PlanStore, PrintSheet, NO_ROSTER_NAME, RaidSplit, nextUid, SplitFlow } = ctx.api;

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]);
  }
}
const json = (x) => JSON.stringify(x);
// Values come from the vm realm, so compare structurally through JSON.
const same = (actual, expected, message) => assert.equal(json(actual), json(expected), message);

function mk(cls, spec, role, groupNumber, name) {
  return { uid: nextUid(), name: name || `${cls}-${spec}-${nextUid()}`, class: cls, spec, role, groupNumber: groupNumber || 0, imported: true };
}

function resetState() {
  PlanStore.startFresh();
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  State.planId = null;
  State.optimizerMode = 'max_dps';
  State.rosterName = 'Test Roster';
}

function seat(players, numGroups) {
  const groups = Array.from({ length: numGroups }, () => []);
  players.forEach((p, i) => { const gi = i % numGroups; p.groupNumber = gi + 1; groups[gi].push(p); });
  State.groups = groups;
  State.roster = groups.flat();
}

// ════════════════════════════════════════════════════════════════
// B16: PP:1 import starts a fresh plan
// ════════════════════════════════════════════════════════════════

function dirtyPlan() {
  resetState();
  seat([mk('WARRIOR', 'Protection', 'tank'), mk('PRIEST', 'Holy', 'healer'), mk('MAGE', 'Fire', 'caster_dps')], 5);
  State.bench = [mk('ROGUE', 'Combat', 'melee_dps', 0, 'OldBench')];
  State.unplaced = [{ uid: nextUid(), name: 'OldAbsent', signupStatus: 'absent', class: null, spec: null, role: null }];
  State.notes = 'Friday notes';
  State.sourceEventId = '123456789';
  State.eventStartTime = Date.UTC(2020, 0, 15, 20);
  State.buffOverrides = { 'x:y:z': { buffId: 'a' } };
  State.playerConstraints = [{ a: 'A', b: 'B', type: 'together' }];
  State.drummers = [{ player: 'D', drum: 'Battle' }];
  State.backups = { Old: 'OldBench' };
  State.assignments = { tankHealers: { Healer: 'Tank' }, blessings: {}, debuffs: {} };
  State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  State.preserveGroupOrder = true;
}

function pp1String() {
  resetState();
  seat([mk('WARRIOR', 'Protection', 'tank', 0, 'NewTank'), mk('PRIEST', 'Holy', 'healer', 0, 'NewHealer')], 5);
  const str = Import.exportAddonString();
  assert.ok(str.startsWith('PP:1:bt:'), 'fixture is a PP:1 string: ' + str);
  return str;
}

check('B16: PP:1 import drops the previous plan bench, notes, assignments and constraints', () => {
  const str = pp1String();
  dirtyPlan();
  const res = Import.importAddonString(str);
  assert.equal(res.success, true);
  same(State.roster.map(p => p.name).sort(), ['NewHealer', 'NewTank']);
  assert.equal(State.bench.length, 0, 'old bench is gone');
  assert.equal(State.unplaced.length, 0, 'old unplaced is gone');
  assert.equal(State.notes, '');
  assert.equal(State.sourceEventId, null);
  assert.equal(State.eventStartTime, null);
  assert.equal(json(State.buffOverrides), '{}');
  assert.equal(json(State.playerConstraints), '[]');
  assert.equal(json(State.drummers), '[]');
  assert.equal(json(State.backups), '{}');
  assert.equal(json(State.assignments), json({ tankHealers: {}, blessings: {}, debuffs: {} }));
  assert.equal(json(State.preferredSlots), '[]');
  assert.equal(State.preserveGroupOrder, false);
});

check('B16: a PP:1 string that fails validation leaves the open plan untouched', () => {
  dirtyPlan();
  const before = json(PlanStore.capture());
  const res = Import.importAddonString('PP:1:notaraid:A.WR.Pro.T');
  assert.equal(res.success, false);
  assert.equal(json(PlanStore.capture()), before);
});

check('B16: PP:2 import still replaces the previous plan (regression guard)', () => {
  resetState();
  seat([mk('WARRIOR', 'Protection', 'tank', 0, 'ShareTank')], 5);
  const share = Import.exportShareString();
  dirtyPlan();
  assert.equal(Import.importAddonString(share).success, true);
  same(State.roster.map(p => p.name), ['ShareTank']);
  assert.equal(State.bench.length, 0);
  assert.equal(State.notes, '');
});

// ════════════════════════════════════════════════════════════════
// B18: out-of-range group goes to the bench
// ════════════════════════════════════════════════════════════════

function rosterData(players, extra) {
  return {
    name: 'Range Test', raid: 'kara', gameVersion: 'tbc',
    players: players.map(([name, groupNumber]) => ({ name, class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber })),
    bench: [], ...extra,
  };
}

check('B18: loadRoster benches players whose group number is outside the raid', () => {
  resetState();
  // Karazhan has 2 groups.
  assert.equal(Import.loadRoster(rosterData([['InA', 1], ['InB', 2], ['TooHigh', 9], ['Zero', 0], ['Negative', -3], ['Fraction', 1.5]])), true);
  same(State.groups.map(g => g.map(p => p.name)), [['InA'], ['InB']]);
  same(State.roster.map(p => p.name), ['InA', 'InB'], 'roster only holds seated players');
  same(State.bench.map(p => p.name).sort(), ['Fraction', 'Negative', 'TooHigh', 'Zero']);
  assert.ok(State.bench.every(p => p.groupNumber === 0), 'benched players carry groupNumber 0');
});

check('B18: nobody is lost across a save and reload of the exported roster', () => {
  resetState();
  Import.loadRoster(rosterData([['InA', 1], ['TooHigh', 9]]));
  const total = State.roster.length + State.bench.length;
  assert.equal(total, 2);
  const exported = JSON.parse(json(Import.exportRoster('x')));
  resetState();
  Import.loadRoster(exported);
  assert.equal(State.roster.length + State.bench.length, total, 'same head count after reload');
  same(State.bench.map(p => p.name), ['TooHigh']);
});

check('B18: out-of-range players join the existing bench after the saved bench entries', () => {
  resetState();
  const data = rosterData([['InA', 1], ['TooHigh', 9]], {
    bench: [{ name: 'Saved', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0 }],
  });
  Import.loadRoster(data);
  same(State.bench.map(p => p.name), ['Saved', 'TooHigh']);
});

check('B18: in-range rosters load exactly as before', () => {
  resetState();
  Import.loadRoster(rosterData([['InA', 1], ['InB', 2], ['InC', 2]]));
  same(State.groups.map(g => g.length), [1, 2]);
  assert.equal(State.bench.length, 0);
  assert.equal(State.roster.length, 3);
});

// ════════════════════════════════════════════════════════════════
// B22: event start time
// ════════════════════════════════════════════════════════════════

const EVENT_MS = Date.UTC(2020, 0, 15, 20, 0, 0); // a day that is never "today"
const EVENT_DAY = new Date(EVENT_MS).toLocaleDateString();
const TODAY = new Date().toLocaleDateString();

check('B22: PlanStore.eventStart reads Raid-Helper seconds, milliseconds and start_time', () => {
  assert.equal(PlanStore.eventStart({ startTime: EVENT_MS / 1000 }), EVENT_MS);
  assert.equal(PlanStore.eventStart({ startTime: EVENT_MS }), EVENT_MS);
  assert.equal(PlanStore.eventStart({ start_time: String(EVENT_MS / 1000) }), EVENT_MS);
});

check('B22: PlanStore.eventStart rejects missing and nonsense values', () => {
  for (const bad of [undefined, null, {}, { startTime: 0 }, { startTime: -5 }, { startTime: 'soon' }, { startTime: NaN },
    { startTime: 1e20 }, { startTime: {} }, { startTime: [] }]) {
    assert.equal(PlanStore.eventStart(bad), null, 'rejects ' + json(bad));
  }
});

check('B22: nameFor keeps using the event day', () => {
  resetState();
  assert.ok(PlanStore.nameFor({ title: 'Kara', startTime: EVENT_MS / 1000 }, '1').endsWith(EVENT_DAY));
  assert.ok(PlanStore.nameFor({ title: 'Kara' }, '1').endsWith(TODAY));
});

check('B22: exportRoster and loadRoster carry the event start; bad values clear it', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps')], 5);
  State.eventStartTime = EVENT_MS;
  const exported = JSON.parse(json(Import.exportRoster('x')));
  assert.equal(exported.eventStartTime, EVENT_MS);
  State.eventStartTime = null;
  Import.loadRoster(exported);
  assert.equal(State.eventStartTime, EVENT_MS);
  for (const bad of ['yesterday', -1, NaN, 1e20, {}, null, undefined]) {
    Import.loadRoster({ ...exported, eventStartTime: bad });
    assert.equal(State.eventStartTime, null, 'cleared by ' + String(bad));
  }
  const { eventStartTime, ...legacy } = exported;
  State.eventStartTime = EVENT_MS;
  Import.loadRoster(legacy);
  assert.equal(State.eventStartTime, null, 'a roster saved before this field existed clears the previous plan date');
});

check('B22: the working plan persists the event start through capture and restore', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps')], 5);
  State.planId = 'event:1';
  State.eventStartTime = EVENT_MS;
  const captured = PlanStore.capture();
  assert.equal(captured.eventStartTime, EVENT_MS);
  State.eventStartTime = null;
  assert.equal(PlanStore.restore(JSON.parse(json(captured))), true);
  assert.equal(State.eventStartTime, EVENT_MS);
  // A plan saved before this field existed must not inherit the open plan's date.
  const { eventStartTime, ...legacy } = JSON.parse(json(captured));
  State.eventStartTime = EVENT_MS;
  assert.equal(PlanStore.restore(legacy), true);
  assert.equal(State.eventStartTime, null);
  assert.equal(PlanStore.restore({ ...legacy, eventStartTime: 'junk' }), true);
  assert.equal(State.eventStartTime, null);
});

check('B22: startFresh clears the event start', () => {
  State.eventStartTime = EVENT_MS;
  PlanStore.startFresh();
  assert.equal(State.eventStartTime, null);
});

check('B22: the share link carries the event start, and a plain link stays compact', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps', 0, 'Sharer')], 5);
  const plain = Import.exportShareString();
  assert.ok(!decodeURIComponent(plain).includes('eventStartTime'), 'no event, no extra tail');
  State.eventStartTime = EVENT_MS;
  const withDate = Import.exportShareString();
  resetState();
  assert.equal(Import.importAddonString(withDate).success, true);
  assert.equal(State.eventStartTime, EVENT_MS);
  assert.equal(Import.importAddonString(plain).success, true);
  assert.equal(State.eventStartTime, null);
});

check('B22: a Raid-Helper diff carries a rescheduled event start, and only when the response has one', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps', 0, 'Mage1')], 5);
  State.eventStartTime = EVENT_MS;
  const later = EVENT_MS + 7 * 86400000;
  const diff = Import.diffRaidHelperSignUps(json({ startTime: later / 1000, signUps: [{ name: 'Mage1', className: 'Mage', specName: 'Fire' }] }));
  assert.equal(diff.eventStartTime, later);
  // A response with no start time carries nothing to overwrite the stored one with.
  const bare = Import.diffRaidHelperSignUps(json({ signUps: [{ name: 'Mage1', className: 'Mage', specName: 'Fire' }] }));
  assert.equal('eventStartTime' in bare, false);
});

check('B22: chat export uses the event date, falling back to today without one', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps')], 5);
  State.eventStartTime = EVENT_MS;
  const header = Import.exportChatText().split('\n')[0];
  assert.ok(header.includes(EVENT_DAY), header);
  assert.ok(Import.exportChatText({ compact: true }).split('\n')[0].includes(EVENT_DAY));
  State.eventStartTime = null;
  assert.ok(Import.exportChatText().split('\n')[0].includes(TODAY));
});

check('B22: print sheet uses the event date, falling back to today without one', () => {
  resetState();
  seat([mk('MAGE', 'Fire', 'caster_dps')], 5);
  State.eventStartTime = EVENT_MS;
  assert.ok(PrintSheet.build().includes(EVENT_DAY));
  State.eventStartTime = null;
  assert.ok(PrintSheet.build().includes(TODAY));
});

// ════════════════════════════════════════════════════════════════
// B6: Split Raid B save
// ════════════════════════════════════════════════════════════════

function bigRoster() {
  const specs = [
    ['WARRIOR', 'Protection', 'tank'], ['PALADIN', 'Holy', 'healer'], ['PRIEST', 'Holy', 'healer'],
    ['MAGE', 'Fire', 'caster_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps'],
    ['WARLOCK', 'Destruction', 'caster_dps'], ['SHAMAN', 'Enhancement', 'melee_dps'],
  ];
  const players = [];
  for (let i = 0; i < 50; i++) {
    const [cls, spec, role] = specs[i % specs.length];
    players.push(mk(cls, spec, role, 0, `P${i}`));
  }
  return players;
}

function prepareSplit() {
  resetState();
  fakeStorage.data.clear();
  fakeStorage.failWrites = false;
  toasts.length = 0;
  for (const k of Object.keys(elements)) delete elements[k];
  const players = bigRoster();
  const seated = players.slice(0, 25);
  seat(seated, 5);
  State.bench = players.slice(25);
  State.planId = 'plan:abc';
  State.sourceEventId = '555555555';
  State.eventStartTime = EVENT_MS;
  SplitFlow.pending = RaidSplit.split([...State.roster, ...State.bench], State.selectedRaid, State.gameVersion);
  assert.ok(SplitFlow.pending, 'fixture split computed');
}

check('B6: a failed Raid B save leaves the plan unsplit and says so', () => {
  prepareSplit();
  const before = json({ g: State.groups, b: State.bench, r: State.roster, p: State.planId, a: State.assignments, bk: State.backups });
  fakeStorage.failWrites = true;
  SplitFlow.create();
  const after = json({ g: State.groups, b: State.bench, r: State.roster, p: State.planId, a: State.assignments, bk: State.backups });
  assert.equal(after, before, 'State is exactly as before');
  assert.equal(el('split-dialog').closed, 0, 'dialog stays open');
  assert.notEqual(SplitFlow.pending, null, 'the split can be retried');
  assert.equal(el('split-dialog-error').hidden, false, 'error is visible inside the dialog');
  const message = el('split-dialog-error-text').textContent;
  assert.match(message, /not split/i);
  assert.match(message, /export/i, 'points at the export path');
  assert.equal(el('split-banner').hidden, false, 'offer banner is not dismissed');
  assert.ok(!toasts.some(t => /^Split into two raids/.test(t)), 'no success toast');
  assert.equal(fakeStorage.data.size, 0);
});

check('B6: a failed save also leaves the players exactly as they were', () => {
  prepareSplit();
  const before = json([...State.roster, ...State.bench]);
  fakeStorage.failWrites = true;
  SplitFlow.create();
  assert.equal(json([...State.roster, ...State.bench]), before, 'no group numbers or lock flags touched');
});

check('B6: a retry after the failure succeeds and clears the error', () => {
  prepareSplit();
  fakeStorage.failWrites = true;
  SplitFlow.create();
  fakeStorage.failWrites = false;
  SplitFlow.create();
  assert.equal(el('split-dialog-error').hidden, true, 'error cleared');
  assert.equal(el('split-dialog').closed, 1);
  assert.equal(SplitFlow.pending, null);
});

check('B6: a successful split saves Raid B first and keeps Raid A in place', () => {
  prepareSplit();
  const allNames = new Set([...State.roster, ...State.bench].map(p => p.name));
  SplitFlow.create();
  const stored = JSON.parse(fakeStorage.getItem('pp_working_plans'));
  assert.equal(stored.length, 1);
  const b = stored[0].data;
  assert.equal(b.planId, 'plan:abc:B');
  assert.equal(b.sourceEventId, '555555555');
  assert.equal(b.eventStartTime, EVENT_MS, 'Raid B keeps the event date');
  assert.match(b.rosterName, /Raid B$/);
  const bNames = [...b.groups.flat(), ...b.bench].map(p => p.name);
  const aNames = [...State.roster, ...State.bench].map(p => p.name);
  assert.equal(new Set([...aNames, ...bNames]).size, aNames.length + bNames.length, 'nobody in both raids');
  same([...aNames, ...bNames].sort(), [...allNames].sort(), 'nobody lost');
  assert.equal(State.roster.length, 25);
  assert.equal(State.planId, 'plan:abc');
  assert.equal(el('split-dialog').closed, 1);
  assert.equal(SplitFlow.pending, null);
  assert.ok(toasts.some(t => /^Split into two raids/.test(t)));
  assert.equal(el('split-dialog-error').hidden, true);
  assert.equal(el('split-banner').hidden, true, 'offer banner dismissed');
});

check('B6: a split of a plan with no ID creates one only when the save succeeds', () => {
  prepareSplit();
  State.planId = null;
  fakeStorage.failWrites = true;
  SplitFlow.create();
  assert.equal(State.planId, null, 'failure does not stamp a plan ID');
  fakeStorage.failWrites = false;
  SplitFlow.create();
  assert.match(State.planId, /^plan:/);
  assert.equal(JSON.parse(fakeStorage.getItem('pp_working_plans'))[0].data.planId, State.planId + ':B');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
