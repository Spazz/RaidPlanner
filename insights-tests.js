/**
 * PartyPlanner Web - Wave 7 tests: Attendance history + optimizer mode
 * comparison (feature-backlog-2.md #2 and #5). The landing "What's New" /
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
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({ TextEncoder, TextDecoder, console });
vm.runInContext(script.split('// ── UI RENDERING')[0] +
  '\nglobalThis.api={State,Config,GameVersions,MODE_CONFIG,Optimizer,RandomRoster,PlanSession,PlanStore,' +
  'computeAttendance,compareOptimizerModes,nextUid,getRaidBuffCoverage,getRaidDebuffCoverage};', ctx);
const { State, Config, GameVersions, MODE_CONFIG, Optimizer, RandomRoster, PlanSession, PlanStore,
  computeAttendance, compareOptimizerModes, nextUid, getRaidBuffCoverage, getRaidDebuffCoverage } = ctx.api;

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

// ════════════════════════════════════════════════════════════════
// COMPARE OPTIMIZER MODES (feature-backlog-2.md #5)
// ════════════════════════════════════════════════════════════════

function runCompareModesSuite(label, version, raid) {
  resetState(version, raid);
  RandomRoster.generate();
  // Give PlanSession something plan-shaped to track, mirroring a real loaded
  // roster, so "the undo stack is unchanged" is a meaningful assertion.
  State.planId = 'plan:test-' + label;
  PlanSession.ready = true;
  PlanSession.undo = [{ fake: 'previous-snapshot' }];
  PlanSession.previous = clone(PlanStore.capture());

  const beforeState = clone(State);
  const beforeUndo = clone(PlanSession.undo);

  const results = compareOptimizerModes();

  check(`${label}: compareOptimizerModes returns exactly the 4 MODE_CONFIG keys`, () => {
    assert.ok(results, 'compareOptimizerModes should return a result for a modeled, non-empty roster');
    assert.deepEqual(Object.keys(results).sort(), Object.keys(MODE_CONFIG).sort());
  });

  check(`${label}: compareOptimizerModes leaves State byte-for-byte unchanged`, () => {
    assert.deepEqual(clone(State), beforeState);
  });

  check(`${label}: compareOptimizerModes never touches the undo stack`, () => {
    assert.deepEqual(clone(PlanSession.undo), beforeUndo);
  });

  check(`${label}: every candidate layout matches what Optimizer.optimize() produces directly`, () => {
    for (const mode of Object.keys(MODE_CONFIG)) {
      resetState(version, raid);
      State.groups = clone(beforeState.groups);
      State.bench = clone(beforeState.bench);
      State.optimizerMode = mode;
      Optimizer.optimize();

      const candidate = results[mode];
      assert.equal(candidate.seatedCount, State.groups.flat().length, `${mode}: seated count matches`);
      assert.equal(candidate.benchedCount, State.bench.length, `${mode}: benched count matches`);
      assert.equal(candidate.buffsCoveredCount, getRaidBuffCoverage(State.groups).size, `${mode}: buff coverage matches`);
      const directDebuffCoverage = getRaidDebuffCoverage(State.groups).size;
      const candidateMissingDebuffs = Object.keys(Config.Debuffs).length - candidate.missingDebuffs.length;
      assert.equal(candidateMissingDebuffs, directDebuffCoverage, `${mode}: debuff coverage matches`);

      // Exact layout equality: same players (by uid) in the same groups, same
      // bench. Compared via JSON.stringify, not assert.deepEqual: these
      // arrays are built by a mix of vm-context code (Optimizer.optimize())
      // and this file's own code across the two branches, so their realm
      // (and therefore Array constructor identity) isn't guaranteed to
      // match even when the contents are identical — same convention as
      // computeAttendance's cross-realm checks above.
      const directNamesByGroup = State.groups.map(g => g.map(p => p.uid).sort());
      const candidateNamesByGroup = candidate.groups.map(g => g.map(p => p.uid).sort());
      assert.equal(JSON.stringify(candidateNamesByGroup), JSON.stringify(directNamesByGroup), `${mode}: group-by-group layout matches exactly`);
      assert.equal(
        JSON.stringify(candidate.bench.map(p => p.uid).sort()),
        JSON.stringify(State.bench.map(p => p.uid).sort()),
        `${mode}: bench matches exactly`
      );
    }
  });
}

runCompareModesSuite('TBC 25-man', 'tbc', 'bt');
runCompareModesSuite('Classic 40-man', 'classic', 'mc');
runCompareModesSuite('Forever 40-man', 'forever', 'f_ony');

check('compareOptimizerModes: returns null for an empty roster (nothing to compare)', () => {
  resetState('tbc', 'bt');
  assert.equal(compareOptimizerModes(), null);
});

check('compareOptimizerModes: returns null for an unmodeled version (no ruleset to run)', () => {
  // Every shipped version (tbc/classic/forever) has a ruleset today — same
  // situation version-tests.js documents for activeRules()'s empty-ruleset
  // fallback — so exercise the branch with a synthetic version key that has
  // no matching Rulesets entry, the same "modeled iff it has a ruleset" rule
  // every real version follows.
  GameVersions.fictional = { name: 'Fictional', defaultRaid: 'bt', raids: [], note: 'test-only', modeled: false };
  resetState('fictional', 'bt');
  State.groups = [[{ uid: nextUid(), name: 'X', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }]];
  try {
    assert.equal(compareOptimizerModes(), null);
  } finally {
    delete GameVersions.fictional;
  }
});

console.log(`\nInsights tests (attendance history + compare optimizer modes): ${passed} passed, 0 failed, ${passed} total`);
