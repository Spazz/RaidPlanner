/**
 * PartyPlanner Web - Wave 7 tests: Attendance history (feature-backlog-2.md
 * #2). The optimizer mode comparison (#5) was removed with the strategy
 * picker in the nav slim-down. The landing "What's New" /
 * version-comparison feature (#9) is static markup with no logic surface,
 * per the backlog's own test note, so it isn't covered here (see the
 * worktree's browser smoke check instead).
 * Run: node insights-tests.js
 *
 * Same vm loader pattern as classic-tests.js/rosters-tests.js: the logic
 * half of index.html's <script> (everything above '// ── UI RENDERING') is
 * executed in a sandboxed context and the pieces under test are pulled out
 * through globalThis.api.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'MODE_CONFIG', 'Optimizer', 'RandomRoster', 'PlanSession', 'PlanStore', 'computeAttendance', 'nextUid', 'getRaidBuffCoverage', 'getRaidDebuffCoverage']);
const { State, Config, GameVersions, MODE_CONFIG, Optimizer, RandomRoster, PlanSession, PlanStore,
  computeAttendance, nextUid, getRaidBuffCoverage, getRaidDebuffCoverage } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function resetState(version, raid) {
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.groups = [];
  State.bench = [];
  State.roster = [];
  State.planId = null;
  State.sourceEventId = null;
  State.rosterName = 'Test Roster';
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.notes = '';
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  State.backups = {};
  State.campfires = { professions: [], fires: [] };
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// A minimal, valid saved-roster entry shape (Import.exportRoster()'s output).
function entry(version, timestamp, players, bench) {
  return { gameVersion: version, timestamp, raid: version === 'classic' ? 'mc' : version === 'forever' ? 'f_ony' : 'bt',
    players: players.map(name => ({ name, class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 })),
    bench: (bench || []).map(name => ({ name, class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 0 })) };
}

// ════════════════════════════════════════════════════════════════
// ATTENDANCE (feature-backlog-2.md #2)
// ════════════════════════════════════════════════════════════════

check('computeAttendance: seated/benched/absent counts, isolated per game version', () => {
  const savedRosters = {
    'Raid 1': entry('tbc', 1000, ['Alice', 'Bob']),
    'Raid 2': entry('tbc', 2000, ['Alice'], ['Bob']),
    'Raid 3': entry('tbc', 3000, ['Alice']), // Bob is absent this entry
    'Classic Raid': entry('classic', 1500, ['Carol']),
  };
  const result = computeAttendance(savedRosters);

  assert.ok(result.tbc && result.classic, 'both versions present in the result');
  assert.equal(result.classic.length, 1, 'Classic history is isolated from TBC names');
  assert.equal(result.classic[0].name, 'Carol');
  assert.equal(result.classic[0].seated, 1);
  assert.equal(result.classic[0].benched, 0);
  assert.equal(result.classic[0].absent, 0);
  assert.equal(result.classic[0].lastSeen, 1500);

  const alice = result.tbc.find(r => r.name === 'Alice');
  const bob = result.tbc.find(r => r.name === 'Bob');
  assert.ok(alice && bob, 'both TBC names present');
  assert.equal(alice.seated, 3, 'Alice was seated in all 3 TBC entries');
  assert.equal(alice.benched, 0);
  assert.equal(alice.absent, 0);
  assert.equal(alice.lastSeen, 3000, 'lastSeen tracks the most recent appearance');

  assert.equal(bob.seated, 1, 'Bob seated once (Raid 1)');
  assert.equal(bob.benched, 1, 'Bob benched once (Raid 2)');
  assert.equal(bob.absent, 1, 'Bob absent once (Raid 3, present in neither list)');
  assert.equal(bob.lastSeen, 2000, 'lastSeen only advances on seated/benched appearances, not absences');
  assert.equal(bob.entries, 3, 'Bob is scored against every TBC entry once he is known');
});

check('computeAttendance: sorted alphabetically by name within a version', () => {
  const savedRosters = { R1: entry('tbc', 1000, ['Zed', 'Amy', 'Mo']) };
  const names = computeAttendance(savedRosters).tbc.map(r => r.name);
  // JSON.stringify comparison, not assert.deepEqual: `names` is an array
  // produced inside the vm context (a different realm), so it fails a
  // strict deepEqual against a same-shaped literal from this file even
  // though the contents are identical — same convention rosters-tests.js/
  // classic-tests.js use for cross-realm comparisons.
  assert.equal(JSON.stringify(names), JSON.stringify(['Amy', 'Mo', 'Zed']));
});

check('computeAttendance: ignores entries missing a valid timestamp or players array', () => {
  const savedRosters = {
    NoTimestamp: { gameVersion: 'tbc', players: [{ name: 'X', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }] },
    NoPlayers: { gameVersion: 'tbc', timestamp: 1000 },
    Good: entry('tbc', 2000, ['X']),
  };
  const result = computeAttendance(savedRosters);
  assert.equal(result.tbc.length, 1);
  assert.equal(result.tbc[0].entries, 1, 'only the well-formed entry is counted');
});

check('computeAttendance: empty or missing storage returns an empty report, not an error', () => {
  assert.equal(JSON.stringify(computeAttendance({})), '{}');
  assert.equal(JSON.stringify(computeAttendance(null)), '{}');
  assert.equal(JSON.stringify(computeAttendance(undefined)), '{}');
});

check('computeAttendance: a name that only ever appears on the bench is never "seated"', () => {
  const savedRosters = { R1: entry('tbc', 1000, [], ['Bench Bob']) };
  const row = computeAttendance(savedRosters).tbc[0];
  assert.equal(row.name, 'Bench Bob');
  assert.equal(row.seated, 0);
  assert.equal(row.benched, 1);
});

console.log(`\nInsights tests (attendance history): ${passed} passed, 0 failed, ${passed} total`);
