/**
 * PartyPlanner Web - Classic Era ruleset tests
 * Run: node classic-tests.js
 *
 * Same vm loader pattern as version-tests.js: the logic half of index.html's
 * <script> is executed in a sandboxed context and the pieces under test are
 * pulled out through globalThis.api. Covers the Phase B Classic Era ruleset:
 * forbidden TBC-only buffs, faction-aware buff/insight filtering, the new
 * real raids (20/40-man), overflow-optimize idempotence, and a save/share
 * round trip — plus a TBC spot-check to prove nothing regressed.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// IdealComp is defined past the '// ── UI RENDERING' split marker (like the
// rest of the render layer), so this pulls out only the ruleset/optimizer/
// import logic before it — same cut point as version-tests.js/tests.js. The
// Horde/Alliance/20-man fixtures below are built inline instead.
const ctx = vm.createContext({TextEncoder, TextDecoder, console});
vm.runInContext(script.split('// ── UI RENDERING')[0] + '\nglobalThis.api={State,Config,GameVersions,Rulesets,Import,Optimizer,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid};', ctx);
const {State,Config,GameVersions,Rulesets,Import,Optimizer,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid} = ctx.api;

// Same conventions as Rulesets.classic.idealComp's Horde/Alliance builders
// (tasks/research-classic-buffs.md 40-man conventions): one shaman per melee
// group for Windfury (Horde), one Retribution/Holy paladin spread per group
// (Alliance), Feral LotP one per melee group, Resto/Imp riding with healers.
function mk(cls, spec, role) {
  return { uid: nextUid(), name: cls + '-' + spec, class: cls, spec, role, imported: false };
}
function numberGroups(groups) {
  groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  return groups;
}
function hordeMelee(shamanSpec) {
  return [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('SHAMAN', shamanSpec, shamanSpec === 'Enhancement' ? 'melee_dps' : 'caster_dps'), mk('DRUID', 'Feral', 'melee_dps')];
}
function buildHorde40() {
  return numberGroups([
    [mk('WARRIOR', 'Protection', 'tank'), ...hordeMelee('Enhancement')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Arms', 'melee_dps'), mk('ROGUE', 'Assassination', 'melee_dps'), mk('SHAMAN', 'Enhancement', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('HUNTER', 'Beast Mastery', 'ranged_dps'), mk('HUNTER', 'Survival', 'ranged_dps'), mk('ROGUE', 'Subtlety', 'melee_dps'), mk('SHAMAN', 'Elemental', 'caster_dps')],
    [mk('MAGE', 'Fire', 'caster_dps'), mk('MAGE', 'Frost', 'caster_dps'), mk('MAGE', 'Arcane', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('SHAMAN', 'Elemental', 'caster_dps')],
    [mk('WARLOCK', 'Affliction', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('WARLOCK', 'Demonology', 'caster_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('SHAMAN', 'Elemental', 'caster_dps')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('SHAMAN', 'Restoration', 'healer'), mk('SHAMAN', 'Restoration', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('SHAMAN', 'Restoration', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('PRIEST', 'Discipline', 'healer'), mk('WARLOCK', 'Affliction', 'caster_dps')],
    [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('MAGE', 'Fire', 'caster_dps'), mk('PRIEST', 'Shadow', 'caster_dps')],
  ]);
}
function buildAlliance40() {
  return numberGroups([
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('PALADIN', 'Retribution', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Arms', 'melee_dps'), mk('ROGUE', 'Assassination', 'melee_dps'), mk('PALADIN', 'Retribution', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('HUNTER', 'Beast Mastery', 'ranged_dps'), mk('HUNTER', 'Survival', 'ranged_dps'), mk('ROGUE', 'Subtlety', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps')],
    [mk('MAGE', 'Fire', 'caster_dps'), mk('MAGE', 'Frost', 'caster_dps'), mk('MAGE', 'Arcane', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('PRIEST', 'Shadow', 'caster_dps')],
    [mk('WARLOCK', 'Affliction', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('WARLOCK', 'Demonology', 'caster_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('PRIEST', 'Discipline', 'healer')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('PALADIN', 'Holy', 'healer'), mk('PALADIN', 'Holy', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('PALADIN', 'Holy', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer'), mk('WARLOCK', 'Affliction', 'caster_dps')],
    [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('MAGE', 'Fire', 'caster_dps'), mk('PRIEST', 'Shadow', 'caster_dps')],
  ]);
}
function buildHorde20() {
  return numberGroups([
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('SHAMAN', 'Enhancement', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('MAGE', 'Fire', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('SHAMAN', 'Elemental', 'caster_dps'), mk('PRIEST', 'Shadow', 'caster_dps')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('SHAMAN', 'Restoration', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer'), mk('WARLOCK', 'Affliction', 'caster_dps')],
    [mk('ROGUE', 'Assassination', 'melee_dps'), mk('HUNTER', 'Survival', 'ranged_dps'), mk('MAGE', 'Arcane', 'caster_dps'), mk('PRIEST', 'Discipline', 'healer'), mk('DRUID', 'Balance', 'caster_dps')],
  ]);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── 1. Forbidden TBC-only content must not exist in Classic ──
check('Classic has no TBC-only buff ids', () => {
  const forbiddenBuffIds = ['WRATH_OF_AIR', 'TOTEM_OF_WRATH', 'FEROCIOUS_INSP', 'UNLEASHED_RAGE', 'TREE_OF_LIFE', 'VAMPIRIC_TOUCH'];
  for (const id of forbiddenBuffIds) assert(!Rulesets.classic.buffs[id], `Classic must not have buff ${id}`);
  assert(!Rulesets.classic.buffs.BLOODLUST && !Rulesets.classic.buffs.HEROISM && !Rulesets.classic.buffs.CRUSADER_AURA);
});
check('Classic has no TBC-only debuff ids, and Classic-era wording for shared ones', () => {
  const forbiddenDebuffIds = ['MISERY', 'VAMPIRIC_EMBRACE', 'HEMORRHAGE', 'BLOOD_FRENZY', 'MANGLE', 'SHADOW_EMBRACE', 'IMPROVED_SHADOW_BOLT', 'SCORPID_STING', 'HUNTERS_MARK', 'EXPOSE_WEAKNESS'];
  for (const id of forbiddenDebuffIds) assert(!Rulesets.classic.debuffs[id], `Classic must not have debuff ${id}`);
  // Sanctity Aura is plain +10% Holy in Classic — no Improved Sanctity Aura (TBC talent).
  assert(!/improved sanctity/i.test(Rulesets.classic.buffs.SANCTITY_AURA.desc));
  // Curse of the Elements is Fire/Frost only in Classic — no Shadow/Arcane.
  assert(!/shadow|arcane/i.test(Rulesets.classic.debuffs.CURSE_ELEMENTS.desc));
  // Faerie Fire has no Improved Faerie Fire (+hit chance) clause in Classic.
  assert(!/improved faerie fire|chance to hit/i.test(Rulesets.classic.debuffs.FAERIE_FIRE_BALANCE.desc));
});

// ── 2. Horde 40-man: melee groups get Windfury from their shaman, no paladin auras ──
check('Horde 40-man: melee-identity groups with a shaman provide Windfury', () => {
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  State.groups = buildHorde40();
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(Faction.current(), 'horde');
  assert.equal(State.groups.length, 8);
  assert.equal(State.roster.length, 40);

  let checkedAtLeastOne = false;
  for (let gi = 0; gi < State.groups.length; gi++) {
    const group = State.groups[gi];
    const roleCounts = {};
    for (const p of group) roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
    const dominant = Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0][0];
    const hasShaman = group.some(p => p.class === 'SHAMAN');
    const hasMeleeCore = group.some(p => p.class === 'WARRIOR' || p.class === 'ROGUE');
    if (dominant !== 'melee_dps' || !hasShaman || !hasMeleeCore) continue;
    checkedAtLeastOne = true;
    const buffIds = getGroupBuffs(group, gi).map(b => b.id);
    assert(buffIds.includes('WINDFURY'), `Group ${gi + 1}: melee group with a shaman should provide Windfury`);
  }
  assert(checkedAtLeastOne, 'fixture should contain at least one shaman-covered melee group');
});
check('Horde 40-man: no paladin-sourced buffs anywhere, none nagged as missing', () => {
  for (let gi = 0; gi < State.groups.length; gi++) {
    const buffs = getGroupBuffs(State.groups[gi], gi);
    assert(!buffs.some(b => b.sourceClass === 'PALADIN'), `Group ${gi + 1} must not produce a paladin aura`);
  }
  const insights = getMissingBuffInsights();
  for (const id of ['DEVOTION_AURA', 'RETRIBUTION_AURA', 'CONCENTRATION_AURA', 'SANCTITY_AURA']) {
    assert(!(id in insights), `Horde raid should not be nagged about ${id}`);
  }
});

// ── 3. Alliance 40-man: no shaman totems anywhere, paladins spread ──
check('Alliance 40-man: no shaman totems, no totem buffs nagged as missing', () => {
  State.groups = buildAlliance40();
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(Faction.current(), 'alliance');
  assert.equal(State.roster.length, 40);

  for (let gi = 0; gi < State.groups.length; gi++) {
    const buffs = getGroupBuffs(State.groups[gi], gi);
    assert(!buffs.some(b => b.sourceClass === 'SHAMAN'), `Group ${gi + 1} must not produce a shaman totem`);
  }
  const insights = getMissingBuffInsights();
  for (const id of ['WINDFURY', 'GRACE_OF_AIR', 'TRANQUIL_AIR', 'STRENGTH_OF_EARTH', 'STONESKIN', 'MANA_SPRING', 'MANA_TIDE']) {
    assert(!(id in insights), `Alliance raid should not be nagged about totem ${id}`);
  }
});
check('Alliance 40-man: paladins spread across multiple groups', () => {
  const paladinGroups = new Set();
  State.groups.forEach((g, gi) => { if (g.some(p => p.class === 'PALADIN')) paladinGroups.add(gi); });
  assert(paladinGroups.size >= 3, 'paladins should not all be stacked in one group');
});

// ── 4. Mixed roster: faction detection + the flag the readiness warning gates on ──
check("Mixed Horde/Alliance roster is detected as 'mixed'", () => {
  State.groups = [[
    { uid: 'x1', name: 'ShamGuy', class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps', groupNumber: 1 },
    { uid: 'x2', name: 'PalGuy', class: 'PALADIN', spec: 'Retribution', role: 'melee_dps', groupNumber: 1 },
  ]];
  State.bench = [];
  assert.equal(Faction.current(), 'mixed');
  assert.equal(Rulesets.classic.rules.factionLock, true, 'the readiness-panel mixed warning is gated on this flag');
});

// ── 5. 20-man (ZG): 4 groups, floors, optimize doesn't break the shape ──
check("Zul'Gurub is a real 20-man Classic raid with 4 groups", () => {
  assert.equal(Config.Raids.zg.size, 20);
  assert.equal(Config.Raids.zg.groups, 4);
  State.selectedRaid = 'zg';
  State.groups = buildHorde20();
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(State.groups.length, 4);
  assert.equal(State.roster.length, 20);
  Optimizer.optimize();
  assert.equal(State.groups.length, 4);
  assert(State.groups.every(g => g.length <= 5));
  assert.equal(State.groups.flat().length + State.bench.length, 20);
});

// ── 6. Overflow optimize is idempotent under, at and over capacity ──
check('Optimize is idempotent at/under/over Molten Core (40) capacity', () => {
  State.gameVersion = 'classic';
  for (const n of [39, 40, 45]) {
    State.selectedRaid = 'mc';
    const signUps = Array.from({ length: n }, (_, i) => ({ name: `C${i}`, className: 'Mage', specName: 'Frost' }));
    const res = Import.importRaidHelper(JSON.stringify({ signUps }));
    assert.equal(res.success, true, `import of ${n} should succeed`);
    const groupsBefore = JSON.stringify(State.groups);
    const benchBefore = JSON.stringify(State.bench);
    Optimizer.optimize();
    assert.equal(JSON.stringify(State.groups), groupsBefore, `second Optimize must not change groups at n=${n}`);
    assert.equal(JSON.stringify(State.bench), benchBefore, `second Optimize must not change the bench at n=${n}`);
    assert.equal(State.groups.flat().length + State.bench.length, n);
  }
});

// ── 7. Save/share round-trip of a real Classic raid key ──
check('Share string round-trips a Classic raid (Blackwing Lair)', () => {
  State.gameVersion = 'classic';
  State.selectedRaid = 'bwl';
  State.groups = buildHorde40();
  State.bench = [];
  State.roster = State.groups.flat();
  State.planId = 'classic-share-test';
  const share = Import.exportShareString();
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  const res = Import.importAddonString(share);
  assert.equal(res.success, true);
  assert.equal(State.gameVersion, 'classic');
  assert.equal(State.selectedRaid, 'bwl');
  assert.equal(State.roster.length, 40);
});

// ── 8. TBC behavior is unchanged ──
check('TBC ruleset is untouched by the Classic ruleset addition', () => {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  assert(Object.keys(Config.Buffs).length > 0);
  assert(!Config.Buffs.TRANQUIL_AIR && !Config.Buffs.STONESKIN, 'new Classic-only totems must not leak into TBC');
  assert.equal(Config.Raids.bt.groups, 5);
  State.groups = [[{ uid: 't1', name: 'W', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 1 }]];
  State.bench = [];
  State.roster = State.groups.flat();
  Optimizer.optimize();
  assert(State.groups.flat().length <= 25);
});

// ── Performance: a 40-player Classic optimize should stay well under 2s ──
check('40-player Classic optimize finishes well under 2s', () => {
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  State.groups = buildHorde40().map(g => g.slice());
  // Scramble the seating so optimize has real work to do, not an already-ideal board.
  const pool = State.groups.flat();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const numGroups = 8;
  State.groups = Array.from({ length: numGroups }, () => []);
  pool.forEach((p, i) => { const gi = i % numGroups; p.groupNumber = gi + 1; State.groups[gi].push(p); });
  State.bench = [];
  State.roster = State.groups.flat();
  const start = Date.now();
  Optimizer.optimize();
  const ms = Date.now() - start;
  console.log(`  (40-player Classic Optimizer.optimize() took ${ms}ms)`);
  assert(ms < 2000, `optimize took ${ms}ms, expected well under 2000ms`);
  assert.equal(State.groups.flat().length, 40);
});

console.log(`\nClassic ruleset tests: ${passed} passed, 0 failed, ${passed} total`);
