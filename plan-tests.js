/**
 * PartyPlanner Web - Optimizer.plan() tests
 * Run: node plan-tests.js
 *
 * plan(players, opts) is the pure layout step behind Optimize: explicit inputs in, a
 * layout out, no State and no DOM. optimize() reads State, calls plan() and applies the
 * result. These tests call plan() directly - with State booby-trapped so any read or
 * write fails - and check the adapter lands on exactly the layout plan() returns.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'Optimizer', 'Faction', 'LayoutScope', 'Constraints', 'Drummers', 'nextUid']);
const { State, Config, Optimizer, Faction, LayoutScope, Constraints, Drummers, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// A TBC 25-man: 2 tanks, 5 healers, 6 melee, 3 ranged, 9 casters.
const MIX = [
  ['WARRIOR', 'Protection', 'tank'], ['PALADIN', 'Protection', 'tank'],
  ['PRIEST', 'Holy', 'healer'], ['PRIEST', 'Discipline', 'healer'], ['DRUID', 'Restoration', 'healer'], ['SHAMAN', 'Restoration', 'healer'], ['PALADIN', 'Holy', 'healer'],
  ['WARRIOR', 'Fury', 'melee_dps'], ['WARRIOR', 'Arms', 'melee_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['ROGUE', 'Assassination', 'melee_dps'], ['SHAMAN', 'Enhancement', 'melee_dps'], ['DRUID', 'Feral', 'melee_dps'],
  ['HUNTER', 'Marksmanship', 'ranged_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps'], ['HUNTER', 'Survival', 'ranged_dps'],
  ['MAGE', 'Fire', 'caster_dps'], ['MAGE', 'Frost', 'caster_dps'], ['MAGE', 'Arcane', 'caster_dps'], ['WARLOCK', 'Destruction', 'caster_dps'],
  ['WARLOCK', 'Affliction', 'caster_dps'], ['PRIEST', 'Shadow', 'caster_dps'], ['DRUID', 'Balance', 'caster_dps'], ['SHAMAN', 'Elemental', 'caster_dps'], ['MAGE', 'Fire', 'caster_dps'],
];
function roster(size = 25) {
  const players = [];
  for (let i = 0; i < size; i++) {
    const [cls, spec, role] = MIX[i % MIX.length];
    players.push({ uid: nextUid(), name: `${cls}-${spec}-${i}`, class: cls, spec, role, imported: false, groupNumber: 0 });
  }
  return players;
}
const opts = (extra) => ({ gameVersion: 'tbc', numGroups: 5, raidSize: 25, mode: 'max_dps', ...extra });
const names = (groups) => groups.map(g => g.map(p => p.name));
const sortedNames = (groups) => groups.map(g => g.map(p => p.name).sort().join(',')).sort().join(' | ');

/** Runs fn with every State property booby-trapped: any read or write throws. */
function withoutState(fn) {
  const saved = Object.getOwnPropertyDescriptors(State);
  for (const key of Object.keys(saved)) {
    Object.defineProperty(State, key, {
      configurable: true,
      get() { throw new Error(`plan() read State.${key}`); },
      set() { throw new Error(`plan() wrote State.${key}`); },
    });
  }
  try { return fn(); } finally { Object.defineProperties(State, saved); }
}

function resetState(gameVersion = 'tbc') {
  State.gameVersion = gameVersion;
  State.selectedRaid = 'bt';
  State.optimizerMode = 'max_dps';
  State.preferredSlots = [];
  State.playerConstraints = [];
  State.drummers = [];
  State.buffOverrides = {};
  State.groups = []; State.bench = []; State.roster = [];
}
function seatRoundRobin(players, numGroups) {
  const groups = Array.from({ length: numGroups }, () => []);
  players.forEach((p, i) => { groups[i % numGroups].push(p); p.groupNumber = (i % numGroups) + 1; });
  State.groups = groups;
  State.bench = [];
  State.roster = groups.flat();
}

check('plan() lays out a roster without reading or writing State', () => {
  resetState();
  const players = roster();
  const { groups, bench } = withoutState(() => Optimizer.plan(players, opts()));
  assert.equal(groups.length, 5);
  assert.equal(bench.length, 0);
  assert.equal(groups.flat().length, 25, 'everyone is seated');
  assert.ok(groups.every(g => g.length <= 5), 'no group over 5');
  assert.equal(new Set(groups.flat()).size, 25, 'nobody is seated twice');
});

check('plan() ignores State: the same inputs give the same layout whatever State holds', () => {
  resetState('tbc');
  const clean = sortedNames(Optimizer.plan(roster(), opts()).groups);
  // A different ruleset, mode, constraint list and drummer list in State must change nothing.
  resetState('classic');
  State.optimizerMode = 'relaxed';
  State.playerConstraints = [{ a: 'WARRIOR-Fury-7', b: 'MAGE-Fire-16', type: 'together' }];
  State.drummers = [{ player: 'WARRIOR-Fury-7', drum: '' }];
  const dirty = sortedNames(Optimizer.plan(roster(), opts()).groups);
  assert.equal(dirty, clean);
});

check('plan() is the layout optimize() applies', () => {
  resetState();
  seatRoundRobin(roster(), 5);
  const planned = Optimizer.plan(State.groups.flat(), opts({ faction: Faction.current() }));
  Optimizer.optimize();
  assert.equal(sortedNames(State.groups), sortedNames(planned.groups));
  State.groups.forEach((g, gi) => g.forEach(p => assert.equal(p.groupNumber, gi + 1, 'the adapter stamps each seated player')));
  assert.equal(State.roster.length, 25);
});

check('plan() does not depend on input order', () => {
  resetState();
  const players = roster();
  const forward = sortedNames(Optimizer.plan(players.slice(), opts()).groups);
  const backward = sortedNames(Optimizer.plan(players.slice().reverse(), opts()).groups);
  assert.equal(backward, forward);
});

check('plan() benches the overflow and leaves State.bench alone', () => {
  resetState();
  const players = roster(30);
  State.bench = [];
  const { groups, bench } = withoutState(() => Optimizer.plan(players, opts()));
  assert.equal(groups.flat().length, 25);
  assert.equal(bench.length, 5);
  assert.equal(new Set([...groups.flat(), ...bench]).size, 30, 'every player is seated or benched exactly once');
  assert.ok(bench.every(p => p.groupNumber === 0), 'benched players carry no group');
  assert.equal(State.bench.length, 0, 'plan() does not touch State.bench');
  // The adapter appends the overflow to the bench and seats the rest.
  seatRoundRobin(roster(30).slice(0, 25), 5);
  const extras = roster(30).slice(25);
  State.groups[4].push(...extras);
  State.roster = State.groups.flat();
  Optimizer.optimize();
  assert.equal(State.groups.flat().length, 25);
  assert.equal(State.bench.length, 5);
});

check('plan() is stable: planning its own result changes nothing, over capacity too', () => {
  resetState();
  const first = Optimizer.plan(roster(30), opts());
  const again = Optimizer.plan(first.groups.flat(), opts());
  assert.equal(sortedNames(again.groups), sortedNames(first.groups));
  const under = Optimizer.plan(roster(18), opts());
  assert.equal(sortedNames(Optimizer.plan(under.groups.flat(), opts()).groups), sortedNames(under.groups));
});

check('plan() honors constraints passed in opts, not State.playerConstraints', () => {
  resetState();
  const players = roster();
  const a = players[7], b = players[16]; // a Fury Warrior and a Fire Mage the optimizer would not seat together
  const base = Optimizer.plan(players.slice(), opts()).groups;
  assert.notEqual(base.findIndex(g => g.includes(a)), base.findIndex(g => g.includes(b)), 'fixture: they start apart');
  const together = withoutState(() => Optimizer.plan(players.slice(), opts({ constraints: [{ a: a.name, b: b.name, type: 'together' }] }))).groups;
  assert.equal(together.findIndex(g => g.includes(a)), together.findIndex(g => g.includes(b)), 'kept together');
  assert.equal(State.playerConstraints.length, 0);
});

check('plan() honors drummers passed in opts, exactly as State.drummers drives optimize()', () => {
  resetState();
  const players = roster();
  const drummers = players.filter(p => p.role === 'melee_dps' || p.role === 'caster_dps').slice(0, 5).map(p => ({ player: p.name, drum: '' }));
  const withOpts = withoutState(() => Optimizer.plan(players, opts({ drummers })));
  assert.equal(State.drummers.length, 0);
  // The same tags set on State drive the adapter to the same board.
  seatRoundRobin(roster(), 5);
  State.drummers = drummers;
  Optimizer.optimize();
  assert.equal(sortedNames(State.groups), sortedNames(withOpts.groups));
});

check('plan() keeps a frozen group as it is and arranges the rest around it', () => {
  resetState();
  const players = roster();
  seatRoundRobin(players, 5);
  const frozen = State.groups.map((g, i) => (i === 2 ? g.slice() : null));
  const keep = frozen[2].map(p => p.name);
  const input = State.groups.flat();
  const { groups } = withoutState(() => Optimizer.plan(input, opts({ frozen })));
  assert.deepEqual([...names(groups)[2]].sort(), [...keep].sort(), 'the frozen group keeps its members');
  assert.equal(groups.flat().length, 25);
  assert.equal(groups._frozen, undefined, 'the freeze does not outlive the run');
  assert.equal(groups._cap, undefined);
});

check('plan() honors a comp-template lock', () => {
  resetState();
  const players = roster();
  const locked = players[16]; // a Fire Mage
  locked.locked = true;
  locked.groupNumber = 2;
  const { groups } = Optimizer.plan(players, opts());
  assert.ok(groups[1].includes(locked), 'the locked player sits in the group they were locked to');
});

check('plan() restores the layout scope, including when it throws', () => {
  resetState();
  assert.equal(LayoutScope.current, null);
  Optimizer.plan(roster(), opts());
  assert.equal(LayoutScope.current, null);
  assert.throws(() => Optimizer.plan(null, opts()));
  assert.equal(LayoutScope.current, null);
});

check('plan() defaults the mode to max_dps and the faction to the players detected one', () => {
  resetState('classic');
  const players = roster().filter(p => p.class !== 'PALADIN'); // Horde: shamans, no paladins
  const explicit = Optimizer.plan(players, { gameVersion: 'classic', numGroups: 8, raidSize: 40, mode: 'max_dps', faction: 'horde' });
  const implicit = Optimizer.plan(players, { gameVersion: 'classic', numGroups: 8, raidSize: 40 });
  assert.equal(sortedNames(implicit.groups), sortedNames(explicit.groups));
});

// ── Optimize on real scenarios (ported from compare-tests.js, removed with the
// strategy picker): checked with live functions only. Own sandbox, so the
// booby-trapped State above never sees these runs.
const live = app.sandbox(['State', 'Import', 'Optimizer']).api;
const Scenarios = require('./scenarios.js');
function loadScenario(id) {
  const sc = Scenarios.scenarios.find(s => s.id === id);
  const S = live.State;
  S.gameVersion = 'tbc';
  S.roster = []; S.groups = []; S.bench = []; S.unplaced = []; S.buffOverrides = {};
  S.playerConstraints = []; S.drummers = []; S.preferredSlots = [];
  S.selectedRaid = sc.raid || 'bt'; S.rosterName = 'Scenario'; S.optimizerMode = 'max_dps';
  assert(live.Import.importRaidHelper(JSON.stringify(Scenarios.toRaidHelperJson(sc))).success, id);
  live.Optimizer.optimize();
}
const boardScore = groups => groups.reduce((sum, g, gi) => sum + live.Optimizer.groupScore(g, gi, groups, 'max_dps'), 0);

check('after Optimize no group is left isolated (F01, F05, F08)', () => {
  for (const id of ['F01', 'F05', 'F08']) {
    loadScenario(id);
    const isolated = live.State.groups.filter(g => g.length && live.Optimizer.wouldIsolate(g, -1));
    assert.equal(isolated.length, 0, `${id}: ${isolated.length} isolated group(s)`);
  }
});

check('Optimize scores above a round-robin scramble of the same players (F01)', () => {
  loadScenario('F01');
  const optimized = live.State.groups;
  const optimizedScore = boardScore(optimized);
  // Deal the same players round-robin: every group ends up a mix of every role.
  // Scored under the optimized board's group identities, so only placement differs.
  const everyone = optimized.flat();
  const scrambled = optimized.map((_, i) => everyone.filter((__, k) => k % optimized.length === i));
  scrambled._roleIdentities = optimized._roleIdentities;
  const scrambledScore = boardScore(scrambled);
  assert.ok(optimizedScore > scrambledScore, `optimized ${optimizedScore.toFixed(1)} vs scrambled ${scrambledScore.toFixed(1)}`);
});

console.log(`\nOptimizer.plan tests: ${passed} passed, 0 failed, ${passed} total`);
