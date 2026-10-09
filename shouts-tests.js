/**
 * PartyPlanner Web - warrior shout tests
 * Run: node shouts-tests.js
 *
 * A warrior casts ONE shout per group (Battle Shout or Commanding Shout,
 * Rulesets.tbc.shouts); a second warrior covers the other. Covers the resolver
 * (scorer) and getGroupBuffs (display) agreeing, the lone-warrior choice, the
 * "needs a 2nd warrior" missing-buff insight, and Classic/Forever being untouched.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'Optimizer', 'getGroupBuffs', 'getMissingBuffInsights', 'getRaidBuffCoverage', 'renderInsightLine', 'nextUid'], {
  extraSource: app.slice('function isKnownClass(', 'function preferredColorClass(')
    + app.slice('function renderInsightLine(', 'function renderBuffRowList('),
});
const { State, Config, Optimizer, getGroupBuffs, getMissingBuffInsights, getRaidBuffCoverage, renderInsightLine, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// Arrays built inside the vm context are not deepEqual to host arrays; compare as JSON.
const same = (actual, expected, msg) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

function player(cls, spec, role, name) {
  return { uid: nextUid(), name: name || `${cls}-${spec}-${nextUid()}`, class: cls, spec, role, groupNumber: 1 };
}
const warrior = (spec = 'Fury', role = 'melee_dps', name) => player('WARRIOR', spec, role, name);
const mage = () => player('MAGE', 'Fire', 'caster_dps');
const prot = (name) => warrior('Protection', 'tank', name);

function useTbc(mode = 'max_dps') {
  State.gameVersion = 'tbc';
  State.optimizerMode = mode;
  State.buffOverrides = {};
  State.bench = [];
}
function shoutsOf(group, groups = [group, [], [], [], []]) {
  return getGroupBuffs(group, 0, groups).filter(b => b.id === 'BATTLE_SHOUT' || b.id === 'COMMANDING_SHOUT');
}

check('Commanding Shout is a TBC warrior buff valued only for tanks', () => {
  useTbc();
  const cs = Config.Buffs.COMMANDING_SHOUT;
  assert(cs, 'TBC has Commanding Shout');
  assert.equal(cs.sourceClass, 'WARRIOR');
  same(cs.benefitsRoles, ['tank']);
});

check('a lone warrior casts exactly one shout', () => {
  useTbc('tank_mit');
  const group = [prot()];
  const shouts = shoutsOf(group);
  assert.equal(shouts.length, 1);
  assert.equal(shouts[0].sourceUid, group[0].uid);
});

check('a lone warrior with only casters around keeps Battle Shout (nothing to tie-break on)', () => {
  useTbc();
  const group = [warrior(), mage(), mage()];
  same(shoutsOf(group).map(b => b.id), ['BATTLE_SHOUT']);
});

check('a lone Protection Warrior guarding himself in Tank Mitigation picks the shout worth more', () => {
  useTbc('tank_mit');
  const group = [prot(), mage()];
  same(shoutsOf(group).map(b => b.id), ['COMMANDING_SHOUT']);
});

check('two warriors in a group cover both shouts, each from a different warrior', () => {
  useTbc('tank_mit');
  const group = [prot(), warrior(), mage()];
  const shouts = shoutsOf(group);
  same(shouts.map(b => b.id).sort(), ['BATTLE_SHOUT', 'COMMANDING_SHOUT']);
  assert.notEqual(shouts[0].sourceUid, shouts[1].sourceUid);
});

check('a third warrior adds no third shout', () => {
  useTbc('tank_mit');
  const group = [prot(), warrior(), warrior('Arms')];
  assert.equal(shoutsOf(group).length, 2);
});

check('scorer and display resolve the same buffs (a second warrior adds buff value in the tank group)', () => {
  useTbc('tank_mit');
  const one = [prot(), mage()];
  const two = [prot(), warrior(), mage()];
  for (const group of [one, two]) {
    const groups = [group, [], [], [], []];
    groups._roleIdentities = ['tank', 'melee_dps', 'caster_dps', 'caster_dps', 'caster_dps'];
    const value = Optimizer.buffValueFn(group, 0, groups, 'tank_mit');
    const scored = [...Optimizer.resolveGroupBuffs(group, value)].sort();
    const shown = getGroupBuffs(group, 0, groups, 'tank_mit').map(b => b.id).sort();
    same(shown, scored);
  }
  const buffTotal = (group) => {
    const groups = [group, [], [], [], []];
    groups._roleIdentities = ['tank', 'melee_dps', 'caster_dps', 'caster_dps', 'caster_dps'];
    const value = Optimizer.buffValueFn(group, 0, groups, 'tank_mit');
    return [...Optimizer.resolveGroupBuffs(group, value)].reduce((sum, id) => sum + value(id), 0);
  };
  assert(buffTotal(two) > buffTotal(one), 'the second shout adds buff value');
});

check('Commanding Shout is reported as shared (not "nobody") when the only seated warrior casts Battle Shout', () => {
  useTbc();
  const w = warrior();
  State.groups = [[w, mage()], [], [], [], []];
  const insights = getMissingBuffInsights();
  assert.equal(getRaidBuffCoverage(State.groups).has('COMMANDING_SHOUT'), false);
  assert.equal(insights.COMMANDING_SHOUT.kind, 'shared');
  assert.equal(insights.COMMANDING_SHOUT.player, w);
});

check('the shared insight says to recruit a 2nd warrior for one, and to group two together for two or more', () => {
  useTbc();
  State.groups = [[warrior(), mage()], [], [], [], []];
  let insight = getMissingBuffInsights().COMMANDING_SHOUT;
  assert.equal(insight.casters, 1);
  assert(/Needs a 2nd warrior/.test(renderInsightLine('COMMANDING_SHOUT', insight)));
  // Two warriors seated in different groups: each picks Battle Shout, so the fix is grouping them.
  State.groups = [[warrior(), mage()], [warrior('Arms')], [], [], []];
  insight = getMissingBuffInsights().COMMANDING_SHOUT;
  assert.equal(insight.kind, 'shared');
  assert.equal(insight.casters, 2);
  const html = renderInsightLine('COMMANDING_SHOUT', insight);
  assert(/Group two warriors together/.test(html) && !/Needs a 2nd warrior/.test(html));
});

check('with two seated warriors both shouts are covered and neither is reported missing', () => {
  useTbc();
  State.groups = [[warrior(), warrior('Arms'), mage()], [], [], [], []];
  const insights = getMissingBuffInsights();
  assert(!insights.COMMANDING_SHOUT && !insights.BATTLE_SHOUT);
});

check('with no warrior the shouts stay "nobody in roster"', () => {
  useTbc();
  State.groups = [[mage()], [], [], [], []];
  const insights = getMissingBuffInsights();
  assert.equal(insights.COMMANDING_SHOUT.kind, 'none');
  assert.equal(insights.BATTLE_SHOUT.kind, 'none');
});

for (const version of ['classic', 'forever']) {
  check(`${version}: no Commanding Shout, every warrior is still just Battle Shout`, () => {
    State.gameVersion = version;
    State.optimizerMode = 'max_dps';
    State.buffOverrides = {};
    assert.equal(Config.Buffs.COMMANDING_SHOUT, undefined);
    const group = [prot(), warrior()];
    const ids = getGroupBuffs(group, 0, [group, [], [], []]).map(b => b.id).filter(id => /SHOUT/.test(id));
    same(ids, ['BATTLE_SHOUT']);
  });
}

console.log(`\nShout tests: ${passed} passed, 0 failed, ${passed} total`);
