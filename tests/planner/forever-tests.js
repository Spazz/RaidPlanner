/**
 * PartyPlanner Web - WoW Forever ruleset tests
 * Run: node tests/planner/forever-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> is executed in a sandboxed context and the pieces under test are
 * pulled out through globalThis.api. Covers the Phase C Forever ruleset
 * (tasks/reference/research-forever.md "Browser verification" section, corrected by its
 * "Audit 2026-10-10"): Tranquil Air (and Wrath of Air/Totem of Wrath) absence,
 * Trueshot Aura a Marksmanship talent (ranged only), Sanctity Aura removed, one
 * Faerie Fire, no faction lock (mixed Shaman+Paladin rosters are
 * normal), the three real raids, provider-spread across all 4 optimizer modes,
 * overflow-optimize idempotence, and a save/share round trip — plus
 * Classic/TBC spot-checks to prove nothing regressed. The 2026-10-16 development notes
 * (tasks/reference/research-forever.md "Audit 2026-10-16"): Battle Shout, Trueshot Aura, Moonkin Aura,
 * Leader of the Pack, Windfury, Grace of Air and Strength of Earth are raid-wide, Grace of Air
 * is not exclusive with Windfury, Leader of the Pack (melee/ranged crit) and Moonkin Aura
 * (spell crit) are not exclusive, and the Windfury nudges stay below any party buff.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Rulesets', 'Import', 'Optimizer', 'OpenSlots', 'getGroupBuffs', 'getMissingBuffInsights', 'getRaidDebuffCoverage', 'Faction', 'enforceRaidCapacity', 'nextUid', 'dpsValueFor', 'RulesData']);
const {State,Config,GameVersions,Rulesets,Import,Optimizer,OpenSlots,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid,dpsValueFor,RulesData} = ctx.api;

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

// ── 2. Trueshot Aura is a Marksmanship talent ──
check('Trueshot Aura is a Marksmanship talent that buffs ranged attack power only', () => {
  const trueshot = Rulesets.forever.buffs.TRUESHOT_AURA;
  assert.equal(trueshot.sourceSpec, 'Marksmanship', 'Trueshot Aura must be Marksmanship-gated in Forever');
  assert.deepEqual([...trueshot.benefitsRoles], ['ranged_dps']);
});
check('Only a Marksmanship Hunter provides Trueshot Aura', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  const survivalGroup = numberGroups([[mk('HUNTER', 'Survival', 'ranged_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  assert(!getGroupBuffs(survivalGroup, 0).map(b => b.id).includes('TRUESHOT_AURA'), 'a Survival Hunter does not provide Trueshot Aura');
  const marksmanshipGroup = numberGroups([[mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  assert(getGroupBuffs(marksmanshipGroup, 0).map(b => b.id).includes('TRUESHOT_AURA'), 'a Marksmanship Hunter provides Trueshot Aura');
});

// ── 3. Leader of the Pack + Moonkin Aura: raid-wide, no longer one exclusive slot (2026-10-16) ──
check('A group with both a Feral and a Balance druid gets both crit auras (stacking is inferred, not confirmed)', () => {
  const group = numberGroups([[mk('DRUID', 'Feral', 'melee_dps'), mk('DRUID', 'Balance', 'caster_dps'), mk('WARRIOR', 'Fury', 'melee_dps')]])[0];
  const buffs = getGroupBuffs(group, 0);
  const critBuffs = buffs.filter(b => b.id === 'LEADER_OF_THE_PACK' || b.id === 'MOONKIN_AURA');
  assert.equal(critBuffs.length, 2, `expected both crit auras, got ${critBuffs.map(b => b.id).join(',')}`);
  assert(!getRaidDebuffCoverage([group]).has('LEADER_OF_THE_PACK'), 'sanity: crit auras are buffs, not debuffs');
  assert.equal(Rulesets.forever.rules.exclusiveBuffs, undefined, 'Forever lists no exclusive buff set');
  for (const id of ['LEADER_OF_THE_PACK', 'MOONKIN_AURA']) {
    assert(/inferred from the split/.test(Rulesets.forever.buffs[id].desc), `${id} desc says stacking is inferred, not confirmed`);
  }
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
    // Crit druids are not spread any more: Leader of the Pack and Moonkin Aura are raid-wide (2026-10-16).
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

// ── 10. Beta data refresh (tasks/reference/research-forever.md, "Audit 2026-10-10") ──
// A lone group is scored on its own in the one supported strategy, so these
// checks do not depend on what earlier checks left in State.
const groupBuffs = group => getGroupBuffs(group, 0, [group], 'max_dps');

check('Sanctity Aura does not exist in Forever', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  assert(!Rulesets.forever.buffs.SANCTITY_AURA, 'Sanctity Aura must not be a Forever buff');
  assert(!Rulesets.forever.paladinAuras.SANCTITY_AURA, 'Sanctity Aura must not be a Forever paladin aura');
  assert.equal(Rulesets.forever.rules.specAura.Retribution, 'RETRIBUTION_AURA', 'a Ret paladin breaks aura ties toward Retribution Aura');
  assert.equal(Rulesets.forever.dpsValue.SANCTITY_AURA, undefined, 'a removed buff has no DPS value');
  assert.equal(Rulesets.forever.sustainValue.SANCTITY_AURA, undefined, 'a removed buff has no sustain value');
  const group = numberGroups([[mk('PALADIN', 'Retribution', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')]])[0];
  const paladinBuffs = groupBuffs(group).filter(b => b.sourceClass === 'PALADIN');
  assert.equal(paladinBuffs.length, 1, 'a Ret paladin still runs exactly one aura');
});
check('One Faerie Fire for every Druid spec', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  const { debuffs } = Rulesets.forever;
  assert(debuffs.FAERIE_FIRE, 'Forever has a single Faerie Fire');
  assert.equal(debuffs.FAERIE_FIRE.sourceSpec, undefined, 'Faerie Fire is not spec-gated');
  assert(!debuffs.FAERIE_FIRE_FERAL && !debuffs.FAERIE_FIRE_BALANCE, 'the Feral/Balance Faerie Fire split is gone');
  assert(getRaidDebuffCoverage([[mk('DRUID', 'Restoration', 'healer')]]).has('FAERIE_FIRE'), 'any Druid spec covers Faerie Fire');
  assert(debuffs.CURSE_RECKLESSNESS.competesWith.includes('FAERIE_FIRE'), 'Curse of Recklessness does not stack with Faerie Fire');
  assert(debuffs.FAERIE_FIRE.competesWith.includes('CURSE_RECKLESSNESS'), 'and Faerie Fire does not stack with it');
  assert(Config.DebuffAbbreviations.FAERIE_FIRE && Config.DebuffIcons.FAERIE_FIRE, 'the debuff catalog can draw it (abbreviation and icon)');
});
check('Two shamans in one party give Windfury and Grace of Air (no longer exclusive)', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  const enhancement = mk('SHAMAN', 'Enhancement', 'melee_dps');
  const restoration = mk('SHAMAN', 'Restoration', 'healer');
  const group = numberGroups([[enhancement, restoration, mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'), mk('WARRIOR', 'Arms', 'melee_dps')]])[0];
  const buffs = groupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assert(buffIds.includes('WINDFURY'), 'the party gets Windfury');
  assert(buffIds.includes('GRACE_OF_AIR'), 'the second shaman adds Grace of Air');
  assert(buffIds.includes('STRENGTH_OF_EARTH') || buffIds.includes('STONESKIN'), 'and an earth totem');
  assert(buffIds.includes('MANA_SPRING'), 'and a water totem');
  for (const shaman of [enhancement, restoration]) {
    assert(buffs.some(b => b.sourceUid === shaman.uid), `${shaman.name} is credited with some buff`);
  }
});
check('Windfury is worth something to a Feral in Forever', () => {
  const feral = mk('DRUID', 'Feral', 'melee_dps');
  try {
    State.gameVersion = 'forever';
    assert(dpsValueFor('WINDFURY', feral) > 0, 'Windfury procs work in Cat form, so a Forever Feral wants the totem');
    assert(Rulesets.forever.mitValue.WINDFURY['DRUID:Feral'] > 0, 'and so does a Feral tank');
    State.gameVersion = 'classic';
    assert.equal(dpsValueFor('WINDFURY', feral), 0, 'Classic Windfury is a weapon enchant a Feral cannot use');
    assert.equal(Rulesets.classic.mitValue.WINDFURY['DRUID:Feral'], 0, 'Classic stays untouched for a Feral tank too');
  } finally {
    State.gameVersion = 'forever';
  }
});
check('Battle Shout benefits melee only in Forever', () => {
  const roles = Rulesets.forever.buffs.BATTLE_SHOUT.benefitsRoles;
  assert(!roles.includes('ranged_dps'), 'hunters gain nothing from Battle Shout');
  assert.deepEqual([...roles].sort(), ['melee_dps', 'tank']);
});
check("Hunter's Mark and Insect Swarm are Forever raid debuffs", () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  assert(getRaidDebuffCoverage([[mk('HUNTER', 'Survival', 'ranged_dps')]]).has('HUNTERS_MARK'), 'any Hunter covers Hunter\'s Mark');
  assert(getRaidDebuffCoverage([[mk('DRUID', 'Balance', 'caster_dps')]]).has('INSECT_SWARM'), 'a Balance Druid covers Insect Swarm');
  assert(!getRaidDebuffCoverage([[mk('DRUID', 'Feral', 'melee_dps')]]).has('INSECT_SWARM'), 'a Feral Druid does not');
});
check("Open-slot pricing counts Forever's Hunter's Mark for ranged DPS only", () => {
  const hunter = mk('HUNTER', 'Survival', 'ranged_dps');
  const melee = [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')];
  const price = raid => OpenSlots._raidValue(hunter, raid, 'max_dps');
  try {
    State.gameVersion = 'forever';
    assert.deepEqual({ ...Rulesets.forever.debuffs.HUNTERS_MARK.value }, { tier: 3, who: 'ranged' });
    assert.equal(price(melee), price([]), 'melee players add nothing to a ranged-only debuff');
    State.gameVersion = 'tbc';
    assert(price(melee) > price([]), 'TBC Hunter\'s Mark still counts every physical attacker');
  } finally {
    State.gameVersion = 'forever';
  }
});

// ── 2026-10-16: raid-wide buffs ──
const RAID_WIDE_IDS = ['BATTLE_SHOUT', 'TRUESHOT_AURA', 'MOONKIN_AURA', 'LEADER_OF_THE_PACK', 'WINDFURY', 'GRACE_OF_AIR', 'STRENGTH_OF_EARTH'];
check('Seven Forever buffs are raid-wide; every other Forever buff, and every Classic and TBC buff, is party-scoped', () => {
  const data = RulesData.forever.buffs;
  for (const id of RAID_WIDE_IDS) assert.equal(data[id].scope, 'raid', `${id} is raid-wide`);
  for (const [id, entry] of Object.entries(data)) if (!RAID_WIDE_IDS.includes(id)) assert.equal(entry.scope, 'party', `${id} stays party-scoped`);
  for (const id of RAID_WIDE_IDS) assert.equal(Rulesets.forever.buffs[id].scope, 'raid', `compiled ${id} carries the raid scope`);
  for (const version of ['tbc', 'classic']) {
    for (const [id, buff] of Object.entries(Rulesets[version].buffs)) assert.equal(buff.scope, undefined, `${version} ${id} has no raid scope`);
  }
  assert(!/not raid-wide|\bParty,/.test(RAID_WIDE_IDS.map(id => data[id].desc).join(' ')), 'no raid-wide desc still says "Party," or "not raid-wide"');
});
check('Windfury and Grace of Air are not exclusive; Flametongue stays unmodeled', () => {
  const buffs = Rulesets.forever.buffs;
  assert.equal(buffs.WINDFURY.exclusiveBuffs, undefined);
  assert.equal(buffs.GRACE_OF_AIR.exclusiveBuffs, undefined);
  assert(!buffs.FLAMETONGUE_TOTEM && !Object.values(buffs).some(b => /^Flametongue/.test(b.name)), 'Flametongue Totem is not modeled');
  assert.equal(Rulesets.forever.rules.exclusiveBuffs, undefined, 'the compiled rules hold no exclusive set');
  assert.equal(Rulesets.forever.buffs.WINDFURY.preferSpec, 'Enhancement', 'Windfury keeps preferSpec Enhancement (earlier user decision)');
});
check('Moonkin Aura is spell crit only: casters and healers, healers at a lower weight; Leader of the Pack is melee and ranged', () => {
  const moon = Rulesets.forever.buffs.MOONKIN_AURA, lotp = Rulesets.forever.buffs.LEADER_OF_THE_PACK;
  assert.deepEqual([...moon.benefitsRoles].sort(), ['caster_dps', 'healer']);
  assert.deepEqual([...lotp.benefitsRoles].sort(), ['melee_dps', 'ranged_dps', 'tank']);
  const dps = Rulesets.forever.dpsValue;
  assert.deepEqual(Object.keys(dps.MOONKIN_AURA.role).sort(), ['caster_dps', 'healer']);
  assert(dps.MOONKIN_AURA.role.healer > 0 && dps.MOONKIN_AURA.role.healer < dps.MOONKIN_AURA.role.caster_dps, 'healer weight is lower than the caster weight');
  assert.equal(dps.LEADER_OF_THE_PACK.role.caster_dps, undefined, 'Leader of the Pack gives casters nothing');
  assert.equal(lotp.priority.caster_dps, undefined);
  assert(!moon.priority.melee_dps && !moon.priority.ranged_dps && !moon.priority.tank, 'Moonkin Aura has no melee, ranged or tank priority');
  const caster = mk('MAGE', 'Frost', 'caster_dps'), healer = mk('PRIEST', 'Holy', 'healer'), melee = mk('WARRIOR', 'Fury', 'melee_dps'), hunter = mk('HUNTER', 'Marksmanship', 'ranged_dps');
  State.gameVersion = 'forever';
  assert(dpsValueFor('MOONKIN_AURA', caster) > dpsValueFor('MOONKIN_AURA', healer) && dpsValueFor('MOONKIN_AURA', healer) > 0);
  assert.equal(dpsValueFor('MOONKIN_AURA', melee) + dpsValueFor('MOONKIN_AURA', hunter), 0, 'no melee or ranged credit from Moonkin Aura');
  assert.equal(dpsValueFor('LEADER_OF_THE_PACK', caster), 0);
  assert(dpsValueFor('LEADER_OF_THE_PACK', melee) > 0 && dpsValueFor('LEADER_OF_THE_PACK', hunter) > 0);
});
check('Raid-wide buffs reach every group: a shaman, a warrior, a Feral and a Balance druid in four groups are listed in all four', () => {
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  const groups = numberGroups([
    [mk('SHAMAN', 'Enhancement', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')],
    [mk('SHAMAN', 'Elemental', 'caster_dps'), mk('MAGE', 'Fire', 'caster_dps')],
    [mk('WARRIOR', 'Fury', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps'), mk('DRUID', 'Balance', 'caster_dps')],
    [mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('PRIEST', 'Holy', 'healer')],
  ]);
  State.groups = groups; State.bench = []; State.buffOverrides = {};
  for (let gi = 0; gi < groups.length; gi++) {
    const ids = getGroupBuffs(groups[gi], gi, groups).map(b => b.id);
    for (const id of ['BATTLE_SHOUT', 'TRUESHOT_AURA', 'MOONKIN_AURA', 'LEADER_OF_THE_PACK', 'WINDFURY', 'GRACE_OF_AIR', 'STRENGTH_OF_EARTH']) {
      assert(ids.includes(id), `group ${gi + 1} lists ${id}`);
    }
  }
});
check('Raid-wide buffs are credited once per raid, wherever the provider sits: the credit never drives placement but does value the seat', () => {
  State.gameVersion = 'forever';
  State.optimizerMode = 'max_dps';
  const cfg = Rulesets.forever.modeConfig.max_dps;
  const total = groups => groups.reduce((sum, g) => sum + Optimizer.raidWideCredit(g, groups, 'max_dps', cfg), 0);
  const build = (providerGroup) => {
    const feral = mk('DRUID', 'Feral', 'melee_dps');
    const groups = numberGroups([[mk('ROGUE', 'Combat', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps')], [mk('MAGE', 'Fire', 'caster_dps'), mk('MAGE', 'Frost', 'caster_dps')]]);
    groups[providerGroup].push(feral);
    return groups;
  };
  const inMelee = build(0), inCasters = build(1);
  assert(total(inMelee) > 0, 'a seated Feral is credited with Leader of the Pack for the raid');
  assert(Math.abs(total(inMelee) - total(inCasters)) < 1e-9, 'the same credit whichever group the Feral sits in');
  const noFeral = numberGroups([[mk('ROGUE', 'Combat', 'melee_dps'), mk('WARRIOR', 'Fury', 'melee_dps')], [mk('MAGE', 'Fire', 'caster_dps'), mk('MAGE', 'Frost', 'caster_dps')]]);
  assert(total(inMelee) > total(noFeral), 'seating the Feral raises the credit (the bench and Open slots see the seat)');
  // A second shaman is what gives the raid its second air totem: the 2nd-ranked air totem is credited only then.
  const shaman = () => mk('SHAMAN', 'Elemental', 'caster_dps');
  const one = numberGroups([[shaman(), mk('MAGE', 'Fire', 'caster_dps')], [mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')]]);
  const two = numberGroups([[shaman(), mk('MAGE', 'Fire', 'caster_dps')], [shaman(), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')]]);
  const gain = total(two) - total(one);
  assert(gain > 0, 'a second shaman adds the second air totem');
  assert(Optimizer.raidWideCredit(one[0], one, 'max_dps', cfg) > 0, 'the credit sits with the shaman group');
});
check('The Windfury nudges are strictly smaller than the smallest party-buff credit a placement can gain', () => {
  const rules = Rulesets.forever.rules, cfg = Rulesets.forever.modeConfig.max_dps;
  // Smallest party-buff credit: every party-scoped weight x the lowest spec weight it can reach, and each mitigation weight x modeConfig.mit.
  let smallest = Infinity;
  const specWeights = Object.values(Rulesets.forever.dpsWeight);
  const roleWeights = Object.values(Rulesets.forever.dpsWeightByRole);
  for (const [id, buff] of Object.entries(Rulesets.forever.buffs)) {
    if (buff.scope === 'raid') continue;
    const dps = Rulesets.forever.dpsValue[id];
    if (dps) {
      for (const part of ['key', 'class', 'role']) for (const base of Object.values(dps[part] || {})) {
        if (base > 0) smallest = Math.min(smallest, base * Math.min(...specWeights, ...roleWeights));
      }
    }
    for (const base of Object.values(Rulesets.forever.mitValue[id] || {})) if (base > 0) smallest = Math.min(smallest, base * cfg.mit);
    if (Rulesets.forever.sustainValue[id] > 0) smallest = Math.min(smallest, Rulesets.forever.sustainValue[id] * cfg.structure);
  }
  assert(Number.isFinite(smallest) && smallest > 0);
  // Worst swing of one shaman move: two groups, each with 4 melee DPS (5 seats with the shaman), at the top dpsWeight 1.0.
  const perGroup = 4 * cfg.structure * (rules.meleeWantsWindfuryCost * 1.0 + rules.meleeGroupWindfuryBias);
  assert(2 * perGroup < smallest, `nudge swing ${2 * perGroup} stays below the smallest party-buff credit ${smallest}`);
  assert(rules.meleeWantsWindfuryCost > 0 && rules.meleeGroupWindfuryBias > 0, 'the nudges are kept, not removed');
});
check('Forever spreadProviders no longer lists the crit-aura druids, and Optimizer skips the melee pass for raid-wide-only providers', () => {
  const spec = Rulesets.forever.rules.spreadProviders;
  assert(!spec.some(s => s.class === 'DRUID'), 'no Feral/Balance spread');
  State.gameVersion = 'forever';
  assert.equal(Optimizer.providesPartyBuffTo({ class: 'SHAMAN' }, 'melee_dps'), false, 'every shaman buff for melee is raid-wide');
  assert.equal(Optimizer.providesPartyBuffTo({ class: 'PALADIN' }, 'melee_dps'), true, 'Retribution Aura is a party aura');
  assert.equal(Optimizer.providesPartyBuffTo({ class: 'SHAMAN' }, 'healer'), true, 'Mana Spring is a party totem');
  State.gameVersion = 'classic';
  assert.equal(Optimizer.providesPartyBuffTo({ class: 'SHAMAN' }, 'melee_dps'), true, 'Classic Windfury is still a party buff');
  assert.equal(Optimizer.providesPartyBuffTo({ class: 'DRUID', spec: 'Feral' }, 'melee_dps'), true, 'Classic Leader of the Pack is still a party buff');
  State.gameVersion = 'forever';
});

console.log(`\nForever ruleset tests: ${passed} passed, 0 failed, ${passed} total`);
