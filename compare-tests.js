/**
 * PartyPlanner Web - "current board vs optimized" tests
 * Run: node compare-tests.js
 *
 * Optimizer.compareToOptimized() scores the board as it stands against what a
 * plain Optimize click would lay out from the same players, without touching
 * State, and judges both by the acceptance function (total groupScore AND the
 * rule breaks Optimize's later phases remove). describeComparison() words it.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'Import', 'Optimizer', 'nextUid']);
const { State, Config, Import, Optimizer } = ctx.api;
const Scenarios = require('./scenarios.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function load(id, mode = 'max_dps') {
  const sc = Scenarios.scenarios.find(s => s.id === id);
  State.gameVersion = 'tbc';
  State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
  State.playerConstraints = []; State.drummers = []; State.preferredSlots = [];
  State.selectedRaid = sc.raid || 'bt';
  State.rosterName = 'Compare';
  State.optimizerMode = mode;
  assert(Import.importRaidHelper(JSON.stringify(Scenarios.toRaidHelperJson(sc))).success);
}

// Everything compareToOptimized could disturb, in one comparable string.
function fingerprint() {
  return JSON.stringify({
    groups: State.groups.map(g => g.map(p => [p.uid, p.name, p.groupNumber, !!p.locked])),
    bench: State.bench.map(p => [p.uid, p.groupNumber]),
    roster: State.roster.map(p => p.uid),
    identities: State.groups._roleIdentities,
    mode: State.optimizerMode,
  });
}

check('right after Optimize the board matches the optimized one (same verdict, zero delta, no rule breaks)', () => {
  for (const id of ['F01', 'F05', 'F08']) {
    load(id);
    const cmp = Optimizer.compareToOptimized();
    assert.equal(cmp.verdict, 'same', id);
    assert(Math.abs(cmp.delta) < 1e-9, `${id} delta ${cmp.delta}`);
    assert.equal(cmp.current.breaks, 0);
  }
});

check('a scrambled board scores below the optimized one and Optimize is reported as better', () => {
  load('F01');
  // Deal the same players round-robin: every group ends up a mix of every role.
  const everyone = State.groups.flat();
  State.groups = [0, 1, 2, 3, 4].map(i => everyone.filter((_, k) => k % 5 === i));
  const cmp = Optimizer.compareToOptimized();
  assert(cmp.delta > 0.5, 'optimized scores higher: ' + cmp.delta);
  assert(cmp.verdict === 'optimize-better' || cmp.verdict === 'optimize-fixes', cmp.verdict);
  assert(/^Current board \d+ vs optimized \d+: /.test(Optimizer.describeComparison(cmp)));
});

check('comparing never mutates the board, bench, roster, identities or players', () => {
  load('F27'); // 30 players: bench in play
  const everyone = State.groups.flat();
  State.groups = [0, 1, 2, 3, 4].map(i => everyone.filter((_, k) => k % 5 === i));
  const before = fingerprint();
  const first = Optimizer.compareToOptimized();
  assert.equal(fingerprint(), before);
  const second = Optimizer.compareToOptimized();
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'deterministic');
  assert.equal(fingerprint(), before);
});

check('an isolated player counts as a rule break and Optimize is credited with fixing it', () => {
  load('F01');
  const melee = State.groups.flat().find(p => p.role === 'melee_dps');
  const casters = State.groups.flat().filter(p => p.role === 'caster_dps').slice(0, 4);
  assert(melee && casters.length === 4);
  const rest = State.groups.flat().filter(p => p !== melee && !casters.includes(p));
  State.groups = [[melee, ...casters], ...[0, 1, 2, 3].map(i => rest.slice(i * 5, i * 5 + 5))];
  State.groups._roleIdentities = undefined;
  const cmp = Optimizer.compareToOptimized();
  assert(cmp.current.isolated >= 1, 'isolated groups: ' + cmp.current.isolated);
  assert(cmp.optimized.breaks < cmp.current.breaks);
  assert.equal(cmp.verdict, 'optimize-fixes');
  assert(/isolated/.test(Optimizer.describeComparison(cmp)));
});

check('a broken keep-together pair counts against the current board', () => {
  load('F01');
  const [a, b] = [State.groups[0][0], State.groups[1][0]];
  State.playerConstraints = [{ type: 'together', a: a.name, b: b.name }];
  const ev = Optimizer.evaluateBoard(State.groups, 'max_dps');
  assert.equal(ev.constraintBreaks, 1);
  assert.equal(ev.breaks, 1);
});

check('a group without a tagged drummer counts as a drum gap on TBC', () => {
  load('F01');
  State.drummers = [{ player: State.groups[0][0].name, drum: 'Battle' }];
  const ev = Optimizer.evaluateBoard(State.groups, 'max_dps');
  assert.equal(ev.drumGaps, State.groups.filter(g => g.length).length - 1);
});

check('nothing to compare: empty board or open requests give null', () => {
  load('F01');
  State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  assert.equal(Optimizer.compareToOptimized(), null);
  State.preferredSlots = [];
  State.groups = [[], [], [], [], []];
  assert.equal(Optimizer.compareToOptimized(), null);
  assert.equal(Optimizer.describeComparison(null), '');
});

check('more seated players than the raid holds gives null (the two scores would cover different players)', () => {
  load('F01');
  assert(Optimizer.compareToOptimized(), 'a full raid compares');
  const extra = State.groups[0][0];
  State.groups[4].push({ ...extra, uid: ctx.api.nextUid(), name: 'Extra1' }, { ...extra, uid: ctx.api.nextUid(), name: 'Extra2' },
    { ...extra, uid: ctx.api.nextUid(), name: 'Extra3' });
  assert(State.groups.flat().length > 25);
  assert.equal(Optimizer.compareToOptimized(), null);
});

check('describeComparison words every verdict', () => {
  const side = (score, extra = {}) => ({ score, isolated: 0, constraintBreaks: 0, drumGaps: 0, breaks: 0, ...extra });
  const text = (verdict, current, optimized, delta) => Optimizer.describeComparison({ verdict, current, optimized, delta });
  assert.equal(text('same', side(412.2), side(412.2), 0), 'Current board 412 vs optimized 412: already as good as Optimize.');
  assert.equal(text('optimize-better', side(400), side(431.4), 31.4), 'Current board 400 vs optimized 431: Optimize adds 31.');
  assert.equal(text('current-ahead', side(440), side(431), -9), 'Current board 440 vs optimized 431: Optimize would not improve this board.');
  assert.equal(text('optimize-fixes', side(440, { isolated: 1, constraintBreaks: 2, breaks: 3 }), side(431), -9),
    'Current board 440 vs optimized 431: Optimize fixes 1 isolated group, 2 constraints broken.');
});

console.log(`\nCompare tests: ${passed} passed, 0 failed, ${passed} total`);
