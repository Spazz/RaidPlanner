/**
 * PartyPlanner Web - state change pipeline tests
 * Run: node commit-tests.js
 *
 * commit(mutator) is the one path a plan change takes: apply -> reconcilePlan() ->
 * persistWorkingPlan() -> renderGroups(). renderGroups() only draws. The pipeline lives in
 * the UI half of the scripts, so these tests load just its pieces (plus the helpers it
 * calls) into the logic sandbox, with persist/render replaced by recording stubs.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const pipeline = [
  app.slice('function getDominantRoleLabel', 'function renderCampfires'),
  app.slice('// ── STATE CHANGE PIPELINE', 'function renderGroups'),
  app.slice('function cleanupOverrides', 'function getSwappableBuffs'),
].join('\n');
const stubs = `
const calls = [];
function persistWorkingPlan() { calls.push({ step: 'persist', roster: State.roster.length, firstGroup: State.groups[0] && State.groups[0].map(p => p.name).join(',') }); }
function renderGroups() { calls.push({ step: 'render', roster: State.roster.length }); }
`;
const ctx = app.sandbox(
  ['State', 'Config', 'Import', 'Constraints', 'Campfires', 'PlanStore', 'nextUid', 'commit', 'reconcilePlan', 'calls'],
  { extraSource: stubs + pipeline },
);
const { State, Config, Import, Constraints, Campfires, nextUid, commit, reconcilePlan, calls } = ctx.api;

let passed = 0;
const steps = () => [...calls].map(c => c.step);
function check(name, fn) {
  calls.length = 0;
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function player(name, cls, spec, role) {
  return { uid: nextUid(), name, class: cls, spec, role, imported: false };
}
function seat(groups) {
  State.groups = groups;
  groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  State.roster = groups.flat();
  State.bench = [];
}
function resetState(gameVersion = 'tbc') {
  State.gameVersion = gameVersion;
  State.selectedRaid = 'bt';
  State.activeTab = 'plan';
  State.preferredSlots = [];
  State.playerConstraints = [];
  State.drummers = [];
  State.backups = {};
  State.buffOverrides = {};
  State.campfires = Campfires.empty();
  State.groups = []; State.bench = []; State.roster = [];
  State.preserveGroupOrder = false;
}

check('commit() runs the mutator, then reconciles, then persists once, then renders once', () => {
  resetState();
  const tank = player('Tank', 'WARRIOR', 'Protection', 'tank');
  const healer = player('Healer', 'PRIEST', 'Holy', 'healer');
  const mage = player('Mage', 'MAGE', 'Fire', 'caster_dps');
  seat([[mage], [tank, healer]]);
  const order = [];
  commit(() => { order.push('mutate'); seat([[mage], [tank, healer], [player('New', 'ROGUE', 'Combat', 'melee_dps')]]); });
  assert.deepEqual(steps(), ['persist', 'render']);
  assert.equal(calls[0].roster, 4, 'persist sees the reconciled roster, not the pre-mutation one');
  assert.equal(calls[1].roster, 4);
  assert.deepEqual(order, ['mutate']);
});

check('commit() persists the reconciled board: the tank group is first when it is saved', () => {
  resetState();
  const tank = player('Tank', 'WARRIOR', 'Protection', 'tank');
  const healer = player('Healer', 'PRIEST', 'Holy', 'healer');
  const mage = player('Mage', 'MAGE', 'Fire', 'caster_dps');
  seat([[mage], [tank, healer]]);
  commit();
  assert.equal(calls[0].step, 'persist');
  assert.equal(calls[0].firstGroup, 'Tank,Healer', 'persist runs after sortTankGroupFirst');
  assert.equal(State.groups[0][0], tank);
  assert.equal(tank.groupNumber, 1);
});

check('commit() with no mutator still reconciles, persists and renders; it returns the mutator result', () => {
  resetState();
  seat([[player('A', 'MAGE', 'Fire', 'caster_dps')]]);
  assert.equal(commit(), undefined);
  assert.deepEqual(steps(), ['persist', 'render']);
  calls.length = 0;
  assert.equal(commit(() => 42), 42);
});

check('reconcile drops constraints, backups and overrides that point at players who are gone, before persist', () => {
  resetState();
  const a = player('Alice', 'MAGE', 'Fire', 'caster_dps');
  const b = player('Bob', 'MAGE', 'Frost', 'caster_dps');
  seat([[a, b]]);
  Constraints.add('Alice', 'Bob', 'together');
  Constraints.add('Alice', 'Ghost', 'apart');
  State.buffOverrides[`0:${b.uid}:aura`] = { buffId: 'DEVOTION_AURA', originalBuffId: 'CONCENTRATION_AURA' };
  State.buffOverrides[`0:nobody:aura`] = { buffId: 'DEVOTION_AURA', originalBuffId: 'CONCENTRATION_AURA' };
  commit();
  assert.deepEqual([...State.playerConstraints.map(c => c.b)], ['Bob']);
  assert.deepEqual([...Object.keys(State.buffOverrides)], [`0:${b.uid}:aura`], 'the stale override is gone');
});

check('reconcile cleans campfires only on Forever while the plan tab shows them', () => {
  resetState('forever');
  seat([[player('Fisher', 'MAGE', 'Frost', 'caster_dps')]]);
  const stale = () => ({ professions: [], fires: [{ name: 'Fire', capacity: 3, assets: [{ player: 'Fisher', asset: 279966 }] }] });
  State.campfires = stale();
  State.activeTab = 'assignments';
  commit();
  assert.equal(State.campfires.fires[0].assets.length, 1, 'untouched while the campfire panel is hidden');
  State.activeTab = 'plan';
  commit();
  assert.equal(State.campfires.fires[0].assets.length, 0, 'an asset nobody is qualified for is dropped');
  resetState('tbc');
  State.campfires = stale();
  commit();
  assert.equal(State.campfires.fires[0].assets.length, 1, 'TBC does not clean campfires');
});

check('reconcilePlan() alone neither persists nor renders', () => {
  resetState();
  seat([[player('A', 'MAGE', 'Fire', 'caster_dps')]]);
  reconcilePlan();
  assert.equal(calls.length, 0);
});

check('renderGroups() only draws: it neither reconciles nor persists, and only commit() calls it', () => {
  const source = app.script;
  const body = app.slice('function renderGroups() {', 'function renderBuffCatalog');
  assert.ok(!/persistWorkingPlan\s*\(/.test(body), 'renderGroups persists');
  assert.ok(!/\.reconcile\w*\s*\(/.test(body), 'renderGroups reconciles');
  assert.ok(!/cleanupOverrides\s*\(|Campfires\.clean/.test(body), 'renderGroups prunes state');
  // Every other call site must go through commit(): the only renderGroups() call is the one in commit().
  const calls = source.split('\n').filter(line => /\brenderGroups\s*\(/.test(line) && !/^\s*(\/\/|function renderGroups)/.test(line));
  assert.equal(calls.length, 1, `renderGroups() is called from outside commit(): ${calls.join(' | ')}`);
  assert.match(calls[0], /renderGroups\(\);/);
});

console.log(`\nCommit pipeline tests: ${passed} passed, 0 failed, ${passed} total`);
