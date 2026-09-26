/**
 * PartyPlanner Web - WoW Forever ruleset tests
 * Run: node forever-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> is executed in a sandboxed context and the pieces under test are
 * pulled out through globalThis.api. Covers the Phase C Forever ruleset
 * (tasks/research-forever.md "Browser verification" section): Tranquil Air
 * (and Wrath of Air/Totem of Wrath) absence, Trueshot Aura baseline on every
 * Hunter spec, the Leader of the Pack/Moonkin Aura exclusive crit slot, no
 * faction lock (mixed Shaman+Paladin rosters are normal), the three real
 * raids, provider-spread across all 4 optimizer modes, overflow-optimize
 * idempotence, and a save/share round trip — plus Classic/TBC spot-checks to
 * prove nothing regressed.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({TextEncoder, TextDecoder, console});
vm.runInContext(script.split('// ── UI RENDERING')[0] + '\nglobalThis.api={State,Config,GameVersions,Rulesets,Import,Optimizer,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid};', ctx);
const {State,Config,GameVersions,Rulesets,Import,Optimizer,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid} = ctx.api;

function mk(cls, spec, role) {
  return { uid: nextUid(), name: cls + '-' + spec, class: cls, spec, role, imported: false };
}
function numberGroups(groups) {
  groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  return groups;
}
function importSignUps(spec) {
  const signUps = [];
  let i = 0;
  for (const [count, className, specName] of spec) {
    for (let k = 0; k < count; k++) signUps.push({ name: 'FP' + (i++), className, specName });
  }
  return Import.importRaidHelper(JSON.stringify({ signUps }));
}
// True if some class/spec (by matches()) is stacked 2+ in a non-tank group
// while a DIFFERENT non-tank group holding a melee dps member has none —
// same shape as classic-tests.js's regression check, reused for Forever's
// mixed Shaman/Paladin/crit-druid provider set.
function hasStackingViolation(matches) {
  return State.groups.some((g, gi) => {
    if (Optimizer.isTankGroup(gi, State.groups)) return false;
    if (g.filter(matches).length < 2) return false;
    return State.groups.some((g2, gi2) => gi2 !== gi
      && !Optimizer.isTankGroup(gi2, State.groups)
      && g2.some(p => p.role === 'melee_dps')
      && g2.filter(matches).length === 0);
  });
}
const MODES = ['max_dps', 'tank_mit', 'balanced', 'relaxed'];

// A mixed Shaman+Paladin 40-man fixture (no faction lock in Forever, so both
// classes coexist freely — unlike Classic's Horde-only/Alliance-only comps).
function buildForeverMixed40() {
  return numberGroups([
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('SHAMAN', 'Enhancement', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Arms', 'melee_dps'), mk('ROGUE', 'Assassination', 'melee_dps'), mk('PALADIN', 'Retribution', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps')],
    [mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('HUNTER', 'Survival', 'ranged_dps'), mk('HUNTER', 'Beast Mastery', 'ranged_dps'), mk('ROGUE', 'Subtlety', 'melee_dps'), mk('SHAMAN', 'Elemental', 'caster_dps')],
    [mk('MAGE', 'Fire', 'caster_dps'), mk('MAGE', 'Frost', 'caster_dps'), mk('MAGE', 'Arcane', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('PALADIN', 'Holy', 'healer')],
    [mk('WARLOCK', 'Affliction', 'caster_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'), mk('WARLOCK', 'Demonology', 'caster_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('SHAMAN', 'Elemental', 'caster_dps')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('SHAMAN', 'Restoration', 'healer'), mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer'), mk('PALADIN', 'Holy', 'healer')],
    [mk('WARRIOR', 'Protection', 'tank'), mk('PALADIN', 'Holy', 'healer'), mk('PRIEST', 'Discipline', 'healer'), mk('SHAMAN', 'Restoration', 'healer'), mk('WARLOCK', 'Affliction', 'caster_dps')],
    [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('MAGE', 'Fire', 'caster_dps'), mk('PRIEST', 'Shadow', 'caster_dps')],
  ]);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── 1. Forbidden/absent Forever content ──
check('Forever has no Tranquil Air, Wrath of Air or Totem of Wrath, and no faction lock', () => {
  assert(!Rulesets.forever.buffs.TRANQUIL_AIR, 'Tranquil Air must not exist in Forever');
  assert(!Rulesets.forever.buffs.WRATH_OF_AIR, 'Wrath of Air must not exist in Forever');
  assert(!Rulesets.forever.buffs.TOTEM_OF_WRATH, 'Totem of Wrath must not exist in Forever');
  assert(!Rulesets.forever.totemElements.TRANQUIL_AIR);
  assert.equal(Rulesets.forever.rules.factionLock, false, 'Forever must not be faction-locked');
});
check('Forever has no Shadow Weaving/Stormstrike/Winter\'s Chill/Improved Scorch raid debuffs', () => {
  for (const id of ['SHADOW_WEAVING', 'STORMSTRIKE', 'WINTERS_CHILL', 'IMPROVED_SCORCH', 'CURSE_WEAKNESS']) {
    assert(!Rulesets.forever.debuffs[id], `Forever must not list ${id} as a raid debuff`);
  }
  assert(Rulesets.forever.debuffs.SUNDER_ARMOR, 'Sunder Armor should still exist');
  assert(Rulesets.forever.debuffs.CURSE_ELEMENTS, 'Curse of the Elements should still exist');
});

// ── 2. Trueshot Aura is baseline for every Hunter spec ──
check('Trueshot Aura has no sourceSpec restriction (baseline for every Hunter)', () => {
  assert(!Rulesets.forever.buffs.TRUESHOT_AURA.sourceSpec, 'Trueshot Aura must not be spec-gated in Forever');
});
check('A non-Marksmanship Hunter provides Trueshot Aura', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  const group = numberGroups([[mk('HUNTER', 'Survival', 'ranged_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  const buffIds = getGroupBuffs(group, 0).map(b => b.id);
  assert(buffIds.includes('TRUESHOT_AURA'), 'Survival Hunter should still provide Trueshot Aura');
});

// ── 3. Leader of the Pack + Moonkin Aura share one exclusive crit slot ──
check('A group with both a Feral and a Balance druid is credited with only one crit aura', () => {
  const group = numberGroups([[mk('DRUID', 'Feral', 'melee_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  const buffs = getGroupBuffs(group, 0);
  const critBuffs = buffs.filter(b => b.id === 'LEADER_OF_THE_PACK' || b.id === 'MOONKIN_AURA');
  assert.equal(critBuffs.length, 1, `expected exactly one crit aura, got ${critBuffs.map(b => b.id).join(',')}`);
  assert(!getRaidDebuffCoverage([group]).has('LEADER_OF_THE_PACK'), 'sanity: crit auras are buffs, not debuffs');
});
check('A group with only a Feral druid still gets Leader of the Pack', () => {
  const group = numberGroups([[mk('DRUID', 'Feral', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  const buffIds = getGroupBuffs(group, 0).map(b => b.id);
  assert(buffIds.includes('LEADER_OF_THE_PACK'));
  assert(!buffIds.includes('MOONKIN_AURA'));
});

// ── 4. Mixed Shaman+Paladin roster: both totems and auras, no faction warning ──
check('Mixed Shaman+Paladin group provides both a totem and an aura', () => {
  const group = numberGroups([[mk('SHAMAN', 'Enhancement', 'melee_dps'), mk('PALADIN', 'Retribution', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  State.groups = [group];
  State.bench = [];
  State.roster = group;
  assert.equal(Faction.current(), 'mixed', 'sanity: this fixture is a mixed Shaman+Paladin group');
  const buffs = getGroupBuffs(group, 0);
  assert(buffs.some(b => b.sourceClass === 'SHAMAN'), 'shaman should still provide a totem');
  assert(buffs.some(b => b.sourceClass === 'PALADIN'), 'paladin should still provide an aura');
  // The readiness-panel "mixed roster" warning (index.html renderReadiness) is
  // gated on rules.factionLock — false here, so it never fires for Forever.
  assert.equal(Rulesets.forever.rules.factionLock, false);
});

// ── 5. The three real Forever raids ──
check('Forever raids: Barrow Deeps (10, 2 groups), Hyjal Summit (20, 4 groups), Onyxia\'s Lair (40, 8 groups)', () => {
  assert.equal(Config.Raids.f_barrow.size, 10);
  assert.equal(Config.Raids.f_barrow.groups, 2);
  assert.equal(Config.Raids.f_hyjal.size, 20);
  assert.equal(Config.Raids.f_hyjal.groups, 4);
  assert.equal(Config.Raids.f_ony.size, 40);
  assert.equal(Config.Raids.f_ony.groups, 8);
  for (const key of ['f_barrow', 'f_hyjal', 'f_ony']) assert(GameVersions.forever.raids.includes(key));
  assert.equal(GameVersions.forever.defaultRaid, 'f_ony');
});
check('Barrow Deeps (10-man) optimizes into 2 groups within the 10-man floors', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_barrow';
  const roster = [
    [2, 'Warrior', 'Protection'], [3, 'Priest', 'Holy'], [1, 'Shaman', 'Enhancement'], [1, 'Paladin', 'Retribution'],
    [1, 'Mage', 'Frost'], [1, 'Rogue', 'Combat'], [1, 'Hunter', 'Beastmastery'],
  ];
  assert.equal(importSignUps(roster).success, true);
  Optimizer.optimize();
  assert.equal(State.groups.length, 2);
  assert(State.groups.every(g => g.length <= 5));
  assert.equal(State.groups.flat().length, 10);
  const tanks = State.groups.flat().filter(p => p.role === 'tank').length;
  const healers = State.groups.flat().filter(p => p.role === 'healer').length;
  assert(tanks >= Config.RaidFloors[10].tank, 'should seat at least the 10-man tank floor');
  assert(healers >= Config.RaidFloors[10].healer, 'should seat at least the 10-man healer floor');
});
check("Hyjal Summit (20-man) optimizes into 4 groups", () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_hyjal';
  const roster = [
    [2, 'Warrior', 'Protection'], [4, 'Priest', 'Holy'], [2, 'Shaman', 'Enhancement'], [2, 'Paladin', 'Retribution'],
    [3, 'Mage', 'Frost'], [3, 'Rogue', 'Combat'], [2, 'Hunter', 'Beastmastery'], [2, 'Warlock', 'Destruction'],
  ];
  assert.equal(importSignUps(roster).success, true);
  Optimizer.optimize();
  assert.equal(State.groups.length, 4);
  assert(State.groups.every(g => g.length <= 5));
  assert.equal(State.groups.flat().length, 20);
});

// ── 6. Provider-spread across Shaman, Paladin AND crit druids (all 4 modes) ──
// Same class of two-hop rebalance the Classic Windfury/aura tests cover
// (Optimizer.spreadProviders() / _spreadPass()), extended here to prove the
// generalized `spec: ['Feral','Balance']` matcher spreads crit-aura druids
// as one shared provider type, on top of the existing Shaman/Paladin spread.
function mixedProviderRoster() {
  return [
    [4, 'Warrior', 'Protection'], [5, 'Warrior', 'Fury'], [5, 'Rogue', 'Combat'], [2, 'Druid', 'Feral'], [2, 'Druid', 'Balance'],
    [4, 'Hunter', 'Marksmanship'], [4, 'Mage', 'Frost'], [3, 'Warlock', 'Destruction'], [1, 'Priest', 'Shadow'],
    [3, 'Priest', 'Holy'], [1, 'Druid', 'Restoration'], [2, 'Shaman', 'Restoration1'], [1, 'Shaman', 'Enhancement'], [1, 'Shaman', 'Elemental'],
    [1, 'Paladin', 'Retribution'], [1, 'Paladin', 'Holy1'],
  ];
}
check('Mixed Forever roster (Shaman+Paladin+crit druids): no stacking violation in any optimizer mode', () => {
  const isShaman = p => p.class === 'SHAMAN';
  const isPaladin = p => p.class === 'PALADIN';
  const isCritDruid = p => p.class === 'DRUID' && (p.spec === 'Feral' || p.spec === 'Balance');
  for (const mode of MODES) {
    State.gameVersion = 'forever';
    State.selectedRaid = 'f_ony';
    State.optimizerMode = mode;
    const res = importSignUps(mixedProviderRoster());
    assert.equal(res.success, true, `mode ${mode}: import should succeed`);
    assert.equal(Faction.current(), 'mixed', `mode ${mode}: Forever roster with both classes is 'mixed', not an error state`);
    assert.equal(State.groups.flat().filter(isShaman).length, 4, `mode ${mode}: all 4 shamans should be seated`);
    assert.equal(State.groups.flat().filter(isPaladin).length, 2, `mode ${mode}: both paladins should be seated`);
    assert.equal(State.groups.flat().filter(isCritDruid).length, 4, `mode ${mode}: all 4 crit druids should be seated`);
    assert(!hasStackingViolation(isShaman), `mode ${mode}: a group has 2+ shamans while another melee group has none`);
    assert(!hasStackingViolation(isPaladin), `mode ${mode}: a group has 2+ paladins while another melee group has none`);
    assert(!hasStackingViolation(isCritDruid), `mode ${mode}: a group has 2+ crit druids while another melee group has none`);
  }
});

// ── 7. Overflow optimize is idempotent under, at and over capacity ──
check("Optimize is idempotent at/under/over Onyxia's Lair (40) capacity", () => {
  State.gameVersion = 'forever';
  for (const n of [39, 40, 45]) {
    State.selectedRaid = 'f_ony';
    const signUps = Array.from({ length: n }, (_, i) => ({ name: `FC${i}`, className: 'Mage', specName: 'Frost' }));
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

// ── 8. Save/share round trip of a real Forever raid key ──
check("Share string round-trips a Forever raid (Onyxia's Lair, key 'f_ony')", () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  State.groups = buildForeverMixed40();
  State.bench = [];
  State.roster = State.groups.flat();
  State.planId = 'forever-share-test';
  const share = Import.exportShareString();
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  const res = Import.importAddonString(share);
  assert.equal(res.success, true);
  assert.equal(State.gameVersion, 'forever');
  assert.equal(State.selectedRaid, 'f_ony');
  assert.equal(State.roster.length, 40);
});

// ── 9. Classic and TBC are unchanged by the Forever ruleset addition ──
check('Classic ruleset is untouched by the Forever ruleset addition', () => {
  assert.equal(Rulesets.classic.rules.factionLock, true, 'Classic must still be faction-locked');
  assert(Rulesets.classic.buffs.TRANQUIL_AIR, 'Classic must still have Tranquil Air');
  assert(!Rulesets.classic.rules.exclusiveBuffs, 'Classic must not have the Forever-only LotP/Moonkin exclusivity');
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  const group = numberGroups([[mk('DRUID', 'Feral', 'melee_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  const buffIds = getGroupBuffs(group, 0).map(b => b.id);
  assert(buffIds.includes('LEADER_OF_THE_PACK') && buffIds.includes('MOONKIN_AURA'), 'Classic keeps LotP and Moonkin Aura independent (no exclusivity)');
});
check('TBC ruleset is untouched by the Forever ruleset addition', () => {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  assert(Object.keys(Config.Buffs).length > 0);
  assert(!Config.Buffs.STONESKIN, 'Classic/Forever-only totems must not leak into TBC');
  assert.equal(Config.Raids.bt.groups, 5);
  // Config.Raids is one shared object across versions by design (see
  // architecture-map.md) — Forever's raid keys exist globally, but TBC's own
  // raid list (GameVersions.tbc.raids, which Config.RaidOrder reads) must
  // never surface them.
  assert(!GameVersions.tbc.raids.includes('f_ony'), 'TBC raid list must not include Forever raid keys');
  State.groups = [[{ uid: 't1', name: 'W', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 1 }]];
  State.bench = [];
  State.roster = State.groups.flat();
  Optimizer.optimize();
  assert(State.groups.flat().length <= 25);
});

console.log(`\nForever ruleset tests: ${passed} passed, 0 failed, ${passed} total`);
