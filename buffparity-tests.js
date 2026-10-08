/**
 * PartyPlanner Web - display / scorer buff parity tests
 * Run: node buffparity-tests.js
 *
 * The buffs a group shows (getGroupBuffs), the reasons explainPlacement cites and the
 * buffs groupScore credits must all come from one resolution
 * (Optimizer.resolveBuffSources valued by Optimizer.buffValueFn). Before they did, two
 * shamans both showed Windfury / Strength of Earth while the scorer credited one, and
 * "Provides X" explanations named buffs the optimizer never counted.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Import', 'Optimizer', 'getGroupBuffs', 'explainPlacement', 'activeRules', 'nextUid', 'COOLDOWN_TOTEMS']);
const { State, Config, GameVersions, Import, Optimizer, getGroupBuffs, explainPlacement, activeRules, nextUid, COOLDOWN_TOTEMS } = ctx.api;
const Scenarios = require('./scenarios.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function mk(cls, spec, role, name) {
  return { uid: nextUid(), name: name || `${cls}-${spec}`, class: cls, spec, role, imported: false };
}
function resetState(gameVersion = 'tbc', mode = 'max_dps') {
  State.gameVersion = gameVersion;
  State.selectedRaid = 'bt';
  State.optimizerMode = mode;
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.groups = []; State.bench = []; State.roster = [];
}
function seat(groups) {
  State.groups = groups;
  State.bench = [];
  State.roster = groups.flat();
}

// Display ids keyed to their source.
function displayed(group, gi) {
  return new Map(getGroupBuffs(group, gi).map(b => [b.id, b.sourceUid]));
}
// What the scorer credits, minus a standing totem that a cooldown totem of the same shaman replaces in the badge row.
function credited(group, gi) {
  const rules = activeRules();
  const value = Optimizer.buffValueFn(group, gi, State.groups, State.optimizerMode);
  const sources = Optimizer.resolveBuffSources(group, value);
  const out = new Map();
  for (const [id, player] of sources) {
    const replaced = [...sources].some(([cd, p]) => p === player && cd !== id && COOLDOWN_TOTEMS.has(cd) && rules.totemElements[cd] === rules.totemElements[id]);
    if (!replaced) out.set(id, player.uid);
  }
  return out;
}
const sorted = (map) => [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));

check('two Enhancement shamans give two different totems, not Windfury twice', () => {
  resetState();
  const a = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamA');
  const b = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamB');
  seat([[a, b, mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Survival', 'ranged_dps')]]);
  const buffs = getGroupBuffs(State.groups[0], 0);
  const ids = buffs.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'a buff appears once per group');
  for (const shaman of [a, b]) {
    const elements = buffs.filter(x => x.sourceUid === shaman.uid).map(x => activeRules().totemElements[x.id]).filter(Boolean);
    assert.equal(new Set(elements).size, elements.length, 'one totem per element per shaman');
  }
  assert.equal(ids.filter(id => id === 'WINDFURY').length, 1, 'Windfury is shown once');
  assert.ok(buffs.some(x => x.sourceUid === a.uid) && buffs.some(x => x.sourceUid === b.uid), 'both shamans contribute a totem');
});

check('resolveGroupBuffs is the key set of resolveBuffSources', () => {
  resetState();
  const group = [mk('SHAMAN', 'Restoration', 'healer'), mk('PALADIN', 'Holy', 'healer'), mk('DRUID', 'Feral', 'melee_dps'), mk('PRIEST', 'Shadow', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps')];
  seat([group]);
  const value = Optimizer.buffValueFn(group, 0, State.groups, 'max_dps');
  assert.deepEqual([...Optimizer.resolveGroupBuffs(group, value)], [...Optimizer.resolveBuffSources(group, value).keys()]);
});

check('parity: every shown buff is credited by the scorer and vice versa, with the same source, on optimized boards', () => {
  let boards = 0;
  for (const gameVersion of ['tbc', 'classic', 'forever']) {
    for (const mode of gameVersion === 'tbc' ? ['max_dps', 'tank_mit', 'balanced'] : ['max_dps']) {
      for (const sc of Scenarios.scenarios.slice(0, 16)) {
        resetState(gameVersion, mode);
        if (sc.raid) State.selectedRaid = sc.raid;
        let r;
        try { r = Import.importRaidHelper(JSON.stringify(Scenarios.toRaidHelperJson(sc))); } catch { continue; }
        if (!r.success) continue;
        State.optimizerMode = mode;
        boards++;
        State.groups.forEach((group, gi) => {
          assert.deepEqual(sorted(displayed(group, gi)), sorted(credited(group, gi)), `${gameVersion}/${mode}/${sc.id} group ${gi + 1}: display and scorer disagree`);
        });
      }
    }
  }
  assert.ok(boards > 20, `parity should cover many boards (covered ${boards})`);
});

check('explainPlacement only cites buffs the scorer credits to that player', () => {
  resetState();
  const a = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamA');
  const b = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamB');
  const group = [a, b, mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Survival', 'ranged_dps')];
  seat([group]);
  const value = Optimizer.buffValueFn(group, 0, State.groups, State.optimizerMode);
  const sources = Optimizer.resolveBuffSources(group, value);
  for (const shaman of [a, b]) {
    const cited = explainPlacement(shaman, group, 0).filter(r => r.kind === 'provides').map(r => r.text);
    const creditedNames = [...sources].filter(([, p]) => p === shaman).map(([id]) => Config.Buffs[id].name);
    for (const text of cited) {
      assert.ok(creditedNames.some(n => text.includes(n)), `"${text}" is not a buff the scorer credits to ${shaman.name}`);
    }
  }
  const windfuryCitations = [a, b].filter(s => explainPlacement(s, group, 0).some(r => r.kind === 'provides' && r.text.includes('Windfury'))).length;
  assert.equal(windfuryCitations, 1, 'only one of the two shamans is credited with Windfury');
});

check('a manual totem override pins that shaman and keeps the other shaman off the same totem', () => {
  resetState();
  const a = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamA');
  const b = mk('SHAMAN', 'Enhancement', 'melee_dps', 'ShamB');
  const group = [a, b, mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Survival', 'ranged_dps')];
  seat([group]);
  State.buffOverrides[`0:${b.uid}:air`] = { buffId: 'WINDFURY', originalBuffId: 'GRACE_OF_AIR' };
  const buffs = getGroupBuffs(group, 0);
  const wf = buffs.filter(x => x.id === 'WINDFURY');
  assert.equal(wf.length, 1, 'Windfury shown once');
  assert.equal(wf[0].sourceUid, b.uid, 'the override owner provides it');
  assert.equal(wf[0].isOverride, true, 'and it is flagged as an override');
  const airFromA = buffs.filter(x => x.sourceUid === a.uid && activeRules().totemElements[x.id] === 'air');
  assert.ok(airFromA.every(x => x.id !== 'WINDFURY'), 'the other shaman picks a different air totem');
});

check('a shaman with nobody to buff shows no totem the scorer would not credit', () => {
  resetState();
  seat([[mk('SHAMAN', 'Enhancement', 'melee_dps')]]);
  const value = Optimizer.buffValueFn(State.groups[0], 0, State.groups, State.optimizerMode);
  assert.deepEqual([...getGroupBuffs(State.groups[0], 0).map(b => b.id)].sort(), [...Optimizer.resolveGroupBuffs(State.groups[0], value)].sort());
});

check('an unmodeled ruleset shows no buffs', () => {
  resetState();
  seat([[mk('SHAMAN', 'Enhancement', 'melee_dps')]]);
  GameVersions.pending = { name: 'Pending', modeled: false };
  State.gameVersion = 'pending';
  try { assert.equal(getGroupBuffs(State.groups[0], 0).length, 0); } finally { delete GameVersions.pending; State.gameVersion = 'tbc'; }
});

console.log(`\nBuff parity tests: ${passed} passed, 0 failed, ${passed} total`);
