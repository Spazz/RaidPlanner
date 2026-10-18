/**
 * Raidsmith - PM wave 3, Planner side: buff and debuff coverage of a planned roster (tests)
 * Run: node wave3-planner-tests.js
 *
 * The guild pages (intent board, recruitment needs) read which raid buffs and debuffs a roster nobody has placed yet would cover through
 * rosterBuffCoverage(roster, gameVersion, raidSize) in js/analysis.js. It must say what the Planner itself says: these tests lay the same fixed rosters
 * out the way Optimize does, put them on the board (State.groups, State.gameVersion) and compare with the functions the coverage rail uses
 * (getRaidBuffCoverage, getRaidDebuffCoverage, factionRelevantBuffs). They also check that the call touches no State, that an unknown version has no
 * answer, and that spec labels of the guild map onto the Planner's specs (Feral as DPS or tank).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const ctx = app.sandbox(['State', 'Config', 'Optimizer', 'rosterBuffCoverage', 'getRaidBuffCoverage', 'getRaidDebuffCoverage', 'factionRelevantBuffs', 'nextUid', 'GameVersions']);
const { State, Config, Optimizer, rosterBuffCoverage, getRaidBuffCoverage, getRaidDebuffCoverage, factionRelevantBuffs, nextUid } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 5).join('\n      ')}`); }
}

// A 25-man style roster in the guild's spec labels.
const RAID = [
  ['WARRIOR', 'Protection'], ['WARRIOR', 'Fury'], ['WARRIOR', 'Arms'], ['PALADIN', 'Holy'], ['PALADIN', 'Retribution'], ['PRIEST', 'Holy'], ['PRIEST', 'Shadow'],
  ['SHAMAN', 'Restoration'], ['SHAMAN', 'Enhancement'], ['SHAMAN', 'Elemental'], ['DRUID', 'Restoration'], ['DRUID', 'Balance'], ['DRUID', 'Feral (DPS)'],
  ['HUNTER', 'Marksmanship'], ['HUNTER', 'Beast Mastery'], ['ROGUE', 'Combat'], ['ROGUE', 'Subtlety'], ['MAGE', 'Fire'], ['MAGE', 'Arcane'],
  ['WARLOCK', 'Destruction'], ['WARLOCK', 'Affliction'], ['WARRIOR', 'Protection'], ['PRIEST', 'Discipline'], ['HUNTER', 'Survival'], ['MAGE', 'Frost'],
].map(([cls, spec]) => ({ class: cls, spec }));
const PLANNER_SPEC = (entry) => (entry.class === 'DRUID' && /^Feral/.test(entry.spec) ? 'Feral' : entry.spec);
const roleOf = (entry) => {
  if (entry.class === 'DRUID' && /Tank/.test(entry.spec)) return 'tank';
  return Object.values(Config.Specs[entry.class]).find(s => s.name === PLANNER_SPEC(entry)).role;
};

// The Planner's own reading: the roster as players, planned like Optimize, put on the board, read with the coverage rail's functions.
function viaPlanner(roster, gameVersion, raidSize) {
  const saved = { gameVersion: State.gameVersion, groups: State.groups, bench: State.bench, roster: State.roster };
  try {
    State.gameVersion = gameVersion;
    const players = roster.map((entry, i) => ({ uid: 'cmp' + i, name: 'P' + i, class: entry.class, spec: PLANNER_SPEC(entry), role: roleOf(entry), imported: false }));
    const { groups } = Optimizer.plan(players, { gameVersion, numGroups: Math.ceil(raidSize / 5), raidSize });
    State.groups = groups; State.bench = []; State.roster = groups.flat();
    const buffs = getRaidBuffCoverage(groups);
    return {
      seated: groups.flat().length,
      coveredBuffs: [...buffs].sort(),
      coveredDebuffs: [...getRaidDebuffCoverage(groups)].sort(),
      allBuffs: Object.keys(factionRelevantBuffs()).sort(),
      allDebuffs: Object.keys(Config.Debuffs).sort(),
    };
  } finally {
    Object.assign(State, saved);
  }
}

for (const [version, size] of [['tbc', 25], ['classic', 40], ['forever', 20]]) {
  check(`${version}: the coverage of a ${size}-man roster is what the Planner says of the same roster on its board`, () => {
    const roster = RAID.slice(0, size === 40 ? RAID.length : Math.min(RAID.length, size));
    const expected = viaPlanner(roster, version, size);
    const got = rosterBuffCoverage(roster, version, size);
    assert.equal(got.gameVersion, version);
    assert.equal(got.size, size);
    assert.equal(got.seated, expected.seated);
    assert.deepEqual(plain(got.buffs.map(b => b.id).sort()), expected.allBuffs, 'the same list of buffs');
    assert.deepEqual(plain(got.debuffs.map(d => d.id).sort()), expected.allDebuffs, 'the same list of debuffs');
    assert.deepEqual(plain(got.buffs.filter(b => b.covered).map(b => b.id).sort()), expected.coveredBuffs, 'covered buffs');
    assert.deepEqual(plain(got.debuffs.filter(d => d.covered).map(d => d.id).sort()), expected.coveredDebuffs, 'covered debuffs');
    assert(expected.coveredBuffs.length > 0 && expected.coveredDebuffs.length > 0, 'the fixture covers something');
    for (const entry of got.buffs.concat(got.debuffs)) {
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.sourceClass, 'string');
    }
  });
}

check('a small roster misses what it lacks and covers what it has; adding the class covers it', () => {
  const small = [{ class: 'WARRIOR', spec: 'Protection' }, { class: 'MAGE', spec: 'Fire' }, { class: 'PRIEST', spec: 'Holy' }];
  const cov = rosterBuffCoverage(small, 'tbc', 25);
  const covered = id => cov.buffs.concat(cov.debuffs).find(e => e.id === id).covered;
  assert.equal(covered('WINDFURY'), false);
  assert.equal(covered('SUNDER_ARMOR'), true, 'a warrior supplies Sunder Armor');
  assert.equal(covered('CURSE_ELEMENTS'), false);
  const more = rosterBuffCoverage(small.concat([{ class: 'SHAMAN', spec: 'Enhancement' }, { class: 'WARLOCK', spec: 'Destruction' }]), 'tbc', 25);
  const coveredMore = id => more.buffs.concat(more.debuffs).find(e => e.id === id).covered;
  assert.equal(coveredMore('WINDFURY'), true);
  assert.equal(coveredMore('CURSE_ELEMENTS'), true);
});

check('nothing is read or written on the board: State is unchanged, whichever version is asked for, and the answer is repeatable', () => {
  State.gameVersion = 'tbc';
  State.groups = []; State.bench = []; State.roster = [];
  const before = JSON.stringify(plain(State));
  const uidBefore = nextUid();
  const first = rosterBuffCoverage(RAID, 'forever', 20);
  const second = rosterBuffCoverage(RAID, 'forever', 20);
  assert.deepEqual(plain(first), plain(second), 'deterministic');
  rosterBuffCoverage(RAID, 'classic', 40);
  assert.equal(JSON.stringify(plain(State)), before);
  assert.equal(State.gameVersion, 'tbc');
  assert.notEqual(nextUid(), uidBefore);
});

check('an unknown version has no answer; an empty roster covers nothing; unknown specs are left out; more players than seats still answers', () => {
  assert.equal(rosterBuffCoverage(RAID, 'nope', 25), null);
  const empty = rosterBuffCoverage([], 'tbc', 25);
  assert.equal(empty.seated, 0);
  assert.equal(empty.buffs.every(b => !b.covered) && empty.debuffs.every(d => !d.covered), true);
  const odd = rosterBuffCoverage([{ class: 'WARRIOR', spec: 'Fury' }, { class: 'WARRIOR', spec: 'Nope' }, { class: 'DEMON', spec: 'x' }, null, { class: 'MAGE' }], 'tbc', 25);
  assert.equal(odd.seated, 1);
  const crowd = rosterBuffCoverage(RAID.concat(RAID, RAID), 'tbc', 25);
  assert.equal(crowd.seated, 25, 'the raid takes its size; the rest sit out');
  assert.equal(rosterBuffCoverage(RAID, 'tbc', undefined).size, 25, 'no size means 25');
});

check('Feral labels: Feral (DPS) and Feral (Tank) are the Planner\'s Feral druid as melee DPS and as tank', () => {
  const dps = rosterBuffCoverage([{ class: 'DRUID', spec: 'Feral (DPS)' }], 'tbc', 25);
  const tank = rosterBuffCoverage([{ class: 'DRUID', spec: 'Feral (Tank)' }], 'tbc', 25);
  assert.equal(dps.seated, 1);
  assert.equal(tank.seated, 1);
  assert(dps.buffs.filter(b => b.covered).length > 0 && tank.buffs.filter(b => b.covered).length > 0, 'a Feral druid covers something either way');
  assert.equal(rosterBuffCoverage([{ class: 'DRUID', spec: 'Feral' }], 'tbc', 25).seated, 1, 'the Planner\'s own label works too');
});

check('Classic is faction aware: a roster with a shaman is not asked for paladin blessings, one with a paladin is not asked for totems', () => {
  const horde = rosterBuffCoverage([{ class: 'SHAMAN', spec: 'Enhancement' }, { class: 'WARRIOR', spec: 'Fury' }], 'classic', 40);
  const alliance = rosterBuffCoverage([{ class: 'PALADIN', spec: 'Retribution' }, { class: 'WARRIOR', spec: 'Fury' }], 'classic', 40);
  assert(!horde.buffs.some(b => b.sourceClass === 'PALADIN'), 'no paladin buffs listed for a Horde roster');
  assert(!alliance.buffs.some(b => b.sourceClass === 'SHAMAN'), 'no shaman buffs listed for an Alliance roster');
  assert(horde.buffs.some(b => b.sourceClass === 'SHAMAN'));
  assert(alliance.buffs.some(b => b.sourceClass === 'PALADIN'));
});

console.log(`\nWave 3 Planner tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
