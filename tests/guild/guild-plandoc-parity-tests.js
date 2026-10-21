/**
 * Raidsmith guild tracker - the server's plan validator against the Planner's own (worker/plan-doc.js planShapeProblem vs js/storage.js PlanStore.valid)
 * Run: node tests/guild/guild-plandoc-parity-tests.js
 *
 * A plan the Planner reads must be a plan the server stores, and the other way round: both are run over the same fixtures - real PlanStore.capture()
 * objects of all three game versions, and each of their fields broken in every way a bad client could break it. The server's own limits and identity rules
 * (planDocProblem) sit on top and are pinned separately. Also pinned: the raid keys the server knows per version are the Planner's GameVersions.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const app = require('../load-app');

const ROOT = path.join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'PlanStore', 'nextUid']);
const { State, Config, GameVersions, PlanStore, nextUid } = ctx.api;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A real captured plan: players seated, bench, unplaced, a note, an override, like the Planner leaves behind.
function capturePlan(version, raid, planId = 'raid:r_x') {
  const mk = (name, cls, spec, role) => ({ uid: nextUid(), name, class: cls, spec, role, groupNumber: 1, imported: false });
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.planId = planId;
  State.rosterName = 'Gruul night';
  State.groups = [[mk('Aldric', 'WARRIOR', 'Protection', 'tank'), mk('Brindle', 'PRIEST', 'Holy', 'healer')], [mk('Cassia', 'MAGE', 'Fire', 'dps')]];
  State.bench = [mk('Dunmar', 'ROGUE', 'Combat', 'dps')];
  State.unplaced = [];
  State.roster = [...State.groups.flat(), ...State.bench];
  State.notes = 'MT swaps at 50%';
  State.buffOverrides = {};
  State.sizeBenched = [];
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  return PlanStore.capture();
}
const clone = (value) => JSON.parse(JSON.stringify(value));

const PLAN_KEYS = ['planId', 'groups', 'bench', 'unplaced', 'campfires', 'gameVersion', 'selectedRaid', 'rosterName', 'sourceEventId', 'eventStartTime', 'optimizerMode',
  'buffOverrides', 'preferredSlots', 'preserveGroupOrder', 'notes', 'sizeBenched', 'assignments', 'backups', 'playerConstraints', 'drummers'];
const BREAKS = [undefined, null, '', 'text', 0, 7, true, false, [], [[]], {}, { a: 1 }, [null], ['x']];

check('GameVersions raids are the raid keys the server accepts, per version', async () => {
  const { VERSION_RAIDS } = await load('worker/plan-doc.js');
  assert.deepEqual(Object.keys(VERSION_RAIDS).sort(), Object.keys(GameVersions).sort());
  for (const version of Object.keys(GameVersions)) assert.deepEqual([...VERSION_RAIDS[version]], [...GameVersions[version].raids], version);
});

check('real captured plans of every version and raid: both validators accept them, and the server accepts them for their raid', async () => {
  const { planShapeProblem, planDocProblem } = await load('worker/plan-doc.js');
  let seen = 0;
  for (const version of Object.keys(GameVersions)) {
    for (const raid of GameVersions[version].raids) {
      const plan = capturePlan(version, raid);
      assert.equal(Boolean(PlanStore.valid(plan)), true, `${version}/${raid} PlanStore`);
      assert.equal(planShapeProblem(plan), null, `${version}/${raid} server`);
      assert.equal(planDocProblem(plan, { raidId: 'r_x', gameVersion: version }), null, `${version}/${raid} server rules`);
      seen++;
    }
  }
  assert(seen >= 25, `only ${seen} plans`);
});

check('every field of a captured plan broken in many ways: PlanStore.valid and planShapeProblem always agree', async () => {
  const { planShapeProblem } = await load('worker/plan-doc.js');
  const base = capturePlan('tbc', 'gruul');
  let compared = 0;
  let rejected = 0;
  for (const key of PLAN_KEYS) {
    for (const broken of BREAKS) {
      const plan = clone(base);
      if (broken === undefined) delete plan[key]; else plan[key] = clone(broken);
      const client = Boolean(PlanStore.valid(plan));
      assert.equal(planShapeProblem(plan) === null, client, `${key} = ${JSON.stringify(broken)}: PlanStore says ${client}`);
      compared++;
      if (!client) rejected++;
    }
  }
  assert(compared >= 250 && rejected >= 100, `${compared} compared, ${rejected} rejected`);
});

check('players: every field of a seated or benched player, broken, and odd containers - the validators agree', async () => {
  const { planShapeProblem } = await load('worker/plan-doc.js');
  const base = capturePlan('tbc', 'gruul');
  const agree = (plan, label) => {
    const client = Boolean(PlanStore.valid(plan));
    assert.equal(planShapeProblem(plan) === null, client, `${label}: PlanStore says ${client}`);
  };
  for (const field of ['uid', 'name', 'class', 'spec', 'role']) {
    for (const broken of [undefined, null, '', 5, true, [], {}]) {
      for (const where of ['group', 'bench']) {
        const plan = clone(base);
        const player = where === 'group' ? plan.groups[0][0] : plan.bench[0];
        if (broken === undefined) delete player[field]; else player[field] = broken;
        agree(plan, `${where} player ${field} = ${JSON.stringify(broken)}`);
      }
    }
  }
  for (const odd of [null, 0, '', 'x', [], {}, true]) {
    const inGroup = clone(base); inGroup.groups[1] = [odd]; agree(inGroup, `group slot ${JSON.stringify(odd)}`);
    const inBench = clone(base); inBench.bench = [odd]; agree(inBench, `bench slot ${JSON.stringify(odd)}`);
  }
  const extra = clone(base); extra.groups[0][0].somethingNew = { deep: [1, 2] }; extra.futureKey = 1; agree(extra, 'unknown keys');
  const noGroups = clone(base); noGroups.groups = []; agree(noGroups, 'no groups');
});

check('optimizer modes: the four the Planner reads (three retired) pass, anything else fails, on both sides', async () => {
  const { planShapeProblem } = await load('worker/plan-doc.js');
  const base = capturePlan('tbc', 'gruul');
  for (const mode of ['max_dps', 'tank_mit', 'balanced', 'relaxed', 'MAX_DPS', 'turbo', '', null, undefined, 1]) {
    const plan = clone(base);
    if (mode === undefined) delete plan.optimizerMode; else plan.optimizerMode = mode;
    assert.equal(planShapeProblem(plan) === null, Boolean(PlanStore.valid(plan)), `mode ${String(mode)}`);
  }
});

check('version and raid: gameVersion with or without a raid of it, the raid-derived fallback, the TBC default, a raid of another version', async () => {
  const { planShapeProblem } = await load('worker/plan-doc.js');
  const base = capturePlan('tbc', 'gruul');
  const raids = [...new Set(Object.values(GameVersions).flatMap((profile) => profile.raids)), 'nope', undefined, null, 5, ''];
  const versions = [...Object.keys(GameVersions), 'tbc-anniversary', 'TBC', '', null, undefined, 5, false, {}];
  let compared = 0;
  for (const version of versions) {
    for (const raid of raids) {
      const plan = clone(base);
      if (version === undefined) delete plan.gameVersion; else plan.gameVersion = version;
      if (raid === undefined) delete plan.selectedRaid; else plan.selectedRaid = raid;
      assert.equal(planShapeProblem(plan) === null, Boolean(PlanStore.valid(plan)), `gameVersion ${JSON.stringify(version)} selectedRaid ${JSON.stringify(raid)}`);
      compared++;
    }
  }
  assert(compared > 300);
  // The one known difference: a gameVersion that is an inherited object property name makes the Planner's own check throw; the server refuses it.
  const odd = clone(base);
  odd.gameVersion = 'toString';
  assert.throws(() => PlanStore.valid(odd));
  assert.notEqual(planShapeProblem(odd), null);
  assert.notEqual(planShapeProblem({ ...clone(base), gameVersion: '__proto__' }), null);
});

check('non-plans: nothing, a string, an array, a number are refused by both', async () => {
  const { planShapeProblem } = await load('worker/plan-doc.js');
  for (const value of [null, undefined, '', 'plan', 0, 5, true, [], [1], () => 1]) {
    assert.equal(planShapeProblem(value) === null, Boolean(PlanStore.valid(value)), String(value));
    assert.notEqual(planShapeProblem(value), null);
  }
});

check('the server rules on top: the raid\'s own planId, the guild\'s version, and the limits - and capture() of a full raid fits them', async () => {
  const { planDocProblem, MAX_DOC_PLAYERS, MAX_DOC_GROUPS } = await load('worker/plan-doc.js');
  const plan = capturePlan('tbc', 'gruul', 'raid:r_abc');
  assert.equal(planDocProblem(plan, { raidId: 'r_abc', gameVersion: 'tbc' }), null);
  assert.equal(planDocProblem(plan, { raidId: 'r_other', gameVersion: 'tbc' }).field, 'planId');
  assert.equal(planDocProblem(plan, { raidId: 'r_abc', gameVersion: 'classic' }).field, 'gameVersion');
  assert.equal(planDocProblem({ ...clone(plan), planId: 'plan:123' }, { raidId: 'r_abc', gameVersion: 'tbc' }).field, 'planId');
  const noVersion = clone(plan); delete noVersion.gameVersion;
  assert.equal(planDocProblem(noVersion, { raidId: 'r_abc', gameVersion: 'tbc' }).field, 'gameVersion', 'the server wants the version spelled out');
  assert.equal(MAX_DOC_GROUPS, 8);
  assert.equal(MAX_DOC_PLAYERS, 200);
  // A 40-man raid: 8 groups of 5, a bench, unplaced sign-ups - the biggest plan the Planner builds.
  const full = clone(plan);
  const player = (i) => ({ uid: `u${i}`, name: `Player${String.fromCharCode(97 + (i % 26))}`, class: 'WARRIOR', spec: 'Arms', role: 'dps' });
  full.groups = Array.from({ length: 8 }, (_, g) => Array.from({ length: 5 }, (__, i) => player(g * 5 + i)));
  full.bench = Array.from({ length: 30 }, (_, i) => player(100 + i));
  full.unplaced = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}` }));
  assert.equal(planDocProblem(full, { raidId: 'r_abc', gameVersion: 'tbc' }), null);
  assert.equal(Boolean(PlanStore.valid(full)), true);
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
