// ── RANDOM ROSTER GENERATOR ──────────────────────────────────────

const RandomRoster = {
  // Specs grouped by role for quick lookup, cached per gameVersion+faction
  // combo (a faction-locked ruleset excludes the other faction's Shaman or
  // Paladin from the pool, so the cache key has to include it).
  _specsByRole: null,
  _specsByRoleKey: null,

  _buildSpecsByRole(faction) {
    const key = State.gameVersion + ':' + (faction || 'any');
    if (this._specsByRole && this._specsByRoleKey === key) return this._specsByRole;
    const byRole = { tank: [], healer: [], melee_dps: [], ranged_dps: [], caster_dps: [] };
    for (const [cls, specs] of Object.entries(Config.Specs)) {
      if (faction === 'horde' && cls === 'PALADIN') continue;
      if (faction === 'alliance' && cls === 'SHAMAN') continue;
      for (const [, spec] of Object.entries(specs)) {
        byRole[spec.role].push({ class: cls, spec: spec.name, role: spec.role });
      }
    }
    this._specsByRole = byRole;
    this._specsByRoleKey = key;
    return byRole;
  },

  _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  _randomName(usedNames) {
    const syllables = ['Tha','Mor','Kel','Zar','Gor','Ven','Ash','Dra','Lor','Fen',
      'Bri','Nox','Syl','Kor','Tal','Myr','Vor','Gal','Ren','Ula','Kae','Ori','Zan',
      'Thi','Nym','Eld','Rho','Isa','Val','Hel','Sar','Mal','Dun','Tor','Ari','Fyn'];
    for (let attempt = 0; attempt < 100; attempt++) {
      const len = 2 + Math.floor(Math.random() * 2); // 2-3 syllables
      let name = '';
      for (let i = 0; i < len; i++) name += (i === 0 ? this._pick(syllables) : this._pick(syllables).toLowerCase());
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
    }
    return 'Player' + Math.floor(Math.random() * 9999);
  },

  generate() {
    State.campfires = Campfires.empty();
    State.preferredSlots = [];
    State.preserveGroupOrder = false;
    // A random roster is an entirely new cast of (randomly-named) players —
    // notes, name-keyed constraints, bench backups and drum tags from
    // whatever was loaded before would otherwise dangle, referencing nobody
    // in the new roster, and reappear confusingly if a later import happens
    // to reuse one of those names.
    State.notes = '';
    State.playerConstraints = [];
    State.drummers = [];
    Assignments.restore(null);
    Backups.restore(null);
    const raidInfo = Config.Raids[State.selectedRaid];
    const size = raidInfo ? raidInfo.size : 25;
    const numGroups = raidInfo ? raidInfo.groups : 5;

    const tanks = (size === 40) ? 4 : 2;
    const healers = (size === 10) ? 2 : (size === 40) ? 10 : 5;
    const dps = size - tanks - healers;

    // Faction-locked rulesets (Classic) generate a single-faction roster —
    // Shaman = Horde only, Paladin = Alliance only in Classic Era — instead
    // of a roster that could never occur in that game version.
    const rules = activeRules();
    const faction = (rules.rules && rules.rules.factionLock) ? (Math.random() < 0.5 ? 'horde' : 'alliance') : null;
    const byRole = this._buildSpecsByRole(faction);
    const roster = [];
    const usedNames = new Set();

    const makePlayer = (specInfo) => ({
      uid: nextUid(),
      name: this._randomName(usedNames),
      class: specInfo.class,
      spec: specInfo.spec,
      role: specInfo.role,
      groupNumber: 0,
      imported: true,
    });

    // Tanks
    for (let i = 0; i < tanks; i++) roster.push(makePlayer(this._pick(byRole.tank)));

    // Healers
    for (let i = 0; i < healers; i++) roster.push(makePlayer(this._pick(byRole.healer)));

    // DPS — split roughly half melee, half ranged/caster
    const meleeCount = Math.floor(dps / 2);
    const rangedCount = dps - meleeCount;
    for (let i = 0; i < meleeCount; i++) roster.push(makePlayer(this._pick(byRole.melee_dps)));
    for (let i = 0; i < rangedCount; i++) {
      // Mix ranged_dps and caster_dps
      const pool = [...byRole.ranged_dps, ...byRole.caster_dps];
      roster.push(makePlayer(this._pick(pool)));
    }

    // Shuffle and distribute into groups
    this._shuffle(roster);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    for (let i = 0; i < roster.length; i++) {
      const gi = i % numGroups;
      roster[i].groupNumber = gi + 1;
      groups[gi].push(roster[i]);
    }

    State.roster = roster;
    State.groups = groups;
    State.rosterName = 'Random ' + size + '-man Roster';
    State.sourceEventId = null;
    State.eventStartTime = null;
    State.bench = [];
    State.unplaced = [];
    State.buffOverrides = {};
  },
};

// ── OPTIMIZER ────────────────────────────────────────────────────
// Received-value scorer: the objective is what each group member RECEIVES
// from the party buffs present in their group (per-spec DPS weights, and
// per-tank-class mitigation weights for the tank group), plus structural
// terms (healer coverage, role cohesion, spreading pressure). All phases
// (greedy placement, swap refinement, de-isolation) share one groupScore().

// Mode weights over the objective components:
//   dps       — party-buff DPS value received by members (DPS_VALUE)
//   mit       — mitigation value of buffs reaching tanks in the tank group (MIT_VALUE)
//   structure — healer coverage + spreading pressure
//   cohesion  — role-family clustering around each group's identity
const MODE_CONFIG = {
  max_dps:  { dps: 1.0, mit: 0.25, structure: 0.7, cohesion: 0.4 },
  tank_mit: { dps: 0.7, mit: 1.2,  structure: 1.0, cohesion: 0.4 },
  balanced: { dps: 0.7, mit: 0.5,  structure: 1.0, cohesion: 1.0 },
  relaxed:  { dps: 0.2, mit: 0.3,  structure: 1.0, cohesion: 1.5 },
};

// Toolbar copy for the optimizer-strategy split-button menu (nav redesign).
// Pure data — no DOM — so nav-tests.js can check every MODE_CONFIG key has a
// matching entry here with no stragglers. Wording is checked against what
// each mode's weights above (and the optimizer's relaxed-mode short-circuit,
// see Optimizer.refineRounds) actually do, not just guessed from the name:
//  - max_dps: dps is the dominant weight (1.0, highest of any mode).
//  - tank_mit: mit is the dominant weight (1.2, highest of any mode).
//  - balanced: dps/mit are both mid-range and close together (0.7/0.5),
//    unlike either mode above that leans hard on one or the other.
//  - relaxed: dps/mit are both the lowest of any mode AND
//    Optimizer.refineRounds() skips its swap/move refinement passes
//    entirely for 'relaxed', so it makes noticeably fewer placement changes
//    than the other three — "fewer moves" describes the algorithm's own
//    pass count, not a literal diff against the board before the click.
const STRATEGY_DESCRIPTIONS = {
  max_dps:  { label: 'Max DPS',          description: 'Buffs go where they add the most damage' },
  tank_mit: { label: 'Tank Mitigation',  description: 'Protect tanks first, then damage' },
  balanced: { label: 'Balanced',         description: 'Even trade between damage and survival' },
  relaxed:  { label: 'Relaxed',          description: 'Keeps role groups together, skips extra fine-tuning' },
};
// Falls back to Max DPS for an unrecognized/legacy mode string (e.g. a share
// link or saved plan from before a mode existed) — same fallback MODE_CONFIG
// consumers already use ("MODE_CONFIG[mode] || MODE_CONFIG.max_dps").
function strategyLabel(mode) {
  return (STRATEGY_DESCRIPTIONS[mode] || STRATEGY_DESCRIPTIONS.max_dps).label;
}

// ── SYNERGY MODEL (researched TBC party-buff values) ──
// DPS_VALUE[buffId] — tier value of a buff to the RECEIVING player (relative
// scale, NOT a measured % gain), resolved key ('CLASS:Spec') → class → role
// → 0. Ordering cross-checked against Lokgol's TBC synergy sheet (0-4 tiers;
// see tasks/research-synergy-sheet.md): WF is the top tier, ToW / Moonkin /
// LotP / FI the next, WoA / SoE / GoA / UR / Sanctity below that.
// Notable modeling choices:
//  - Windfury: Ret > Fury > Arms > Rogues (main-hand only). Feral druids get
//    NOTHING from WF (weapon imbues don't work in forms) — hence the 0 key.
//    Hunters don't benefit either (melee-weapon imbue; role table omits ranged).
//  - Ferocious Inspiration is 3% damage for the whole party, any role.
//  - Vampiric Touch is a party mana battery: a Holy Priest spamming Circle of
//    Healing needs it most, then Arcane/other mages. Warlocks barely do —
//    Life Tap covers their mana — so a lock no longer outbids the priest for
//    the Shadow Priest's group.
const DPS_VALUE = {
  WINDFURY:           { key: { 'PALADIN:Retribution': 12, 'WARRIOR:Fury': 11, 'WARRIOR:Arms': 10, 'SHAMAN:Enhancement': 9, 'ROGUE:Combat': 8, 'ROGUE:Assassination': 8, 'ROGUE:Subtlety': 8, 'DRUID:Feral': 0 }, role: { melee_dps: 8, tank: 3 } },
  GRACE_OF_AIR:       { key: { 'DRUID:Feral': 4 }, role: { melee_dps: 2, ranged_dps: 3, tank: 2 } },
  WRATH_OF_AIR:       { role: { caster_dps: 4, healer: 2 } },
  TOTEM_OF_WRATH:     { key: { 'WARLOCK:Destruction': 8 }, role: { caster_dps: 6, healer: 1 } },
  STRENGTH_OF_EARTH:  { role: { melee_dps: 2, tank: 2 } },
  MANA_SPRING:        { key: { 'MAGE:Arcane': 3 }, role: { healer: 2, caster_dps: 1 } },
  MANA_TIDE:          { key: { 'MAGE:Arcane': 5 }, role: { healer: 4 } },
  DEVOTION_AURA:      { role: {} },
  CONCENTRATION_AURA: { role: { healer: 2, caster_dps: 1 } },
  RETRIBUTION_AURA:   { role: { melee_dps: 1, tank: 1 } },
  SANCTITY_AURA:      { role: { melee_dps: 2, ranged_dps: 2, caster_dps: 2, tank: 1 } },
  LEADER_OF_THE_PACK: { role: { melee_dps: 5, ranged_dps: 5, tank: 2 } },
  MOONKIN_AURA:       { key: { 'WARLOCK:Destruction': 7 }, role: { caster_dps: 5 } },
  TREE_OF_LIFE:       { role: { healer: 1 } },
  TRUESHOT_AURA:      { role: { melee_dps: 3, ranged_dps: 4 } },
  FEROCIOUS_INSP:     { role: { melee_dps: 3, ranged_dps: 3, caster_dps: 3, tank: 1 } },
  UNLEASHED_RAGE:     { role: { melee_dps: 5, tank: 2 } },
  BATTLE_SHOUT:       { role: { melee_dps: 3, ranged_dps: 2, tank: 2 } },
  COMMANDING_SHOUT:   { role: {} },
  BLOOD_PACT:         { role: { tank: 1 } },
  VAMPIRIC_TOUCH:     { key: { 'MAGE:Arcane': 7, 'PRIEST:Holy': 10 }, class: { WARLOCK: 2, MAGE: 6 }, role: { caster_dps: 4, healer: 3 } },
};

// MIT_VALUE[buffId] — survivability value for a TANK receiving the buff,
// keyed per tank class:spec ('*' = any tank). Researched priorities:
//  - Prot Warrior: armor (Devotion, ~5-7% phys DR) + block value (SoE)
//  - Prot Paladin: armor + dodge (Grace of Air) + spell power (Wrath of Air
//    feeds Holy Shield / Consecration threat; worth more to them than WF)
//  - Feral Druid: agility scaling (GoA) + Imp LotP heal; low Devotion value
//    (high base armor), zero Windfury (no weapon imbues in forms)
//  - Tree of Life (+25% healing received, party-only) is huge for any tank
const MIT_VALUE = {
  DEVOTION_AURA:      { 'WARRIOR:Protection': 10, 'PALADIN:Protection': 10, 'DRUID:Feral': 5 },
  GRACE_OF_AIR:       { 'WARRIOR:Protection': 4, 'PALADIN:Protection': 7, 'DRUID:Feral': 9 },
  WRATH_OF_AIR:       { 'PALADIN:Protection': 5 },
  BLOOD_PACT:         { '*': 6 },
  TREE_OF_LIFE:       { '*': 12 },
  STRENGTH_OF_EARTH:  { 'WARRIOR:Protection': 5, 'PALADIN:Protection': 2, 'DRUID:Feral': 3 },
  LEADER_OF_THE_PACK: { 'DRUID:Feral': 6, '*': 2 },
  WINDFURY:           { 'WARRIOR:Protection': 4, 'PALADIN:Protection': 1, 'DRUID:Feral': 0 },
  BATTLE_SHOUT:       { '*': 2 },
  COMMANDING_SHOUT:   { '*': 5 },
  RETRIBUTION_AURA:   { '*': 1 },
};

// Healer-sustain buffs: extra value in the tank group per healer present
// (capped at 2) — Mana Tide/Spring keep tank healers casting, VT feeds
// their mana, Concentration Aura protects their casts.
const SUSTAIN_VALUE = { MANA_SPRING: 3, MANA_TIDE: 5, VAMPIRIC_TOUCH: 3, CONCENTRATION_AURA: 3 };

// DPS_WEIGHT['CLASS:Spec'] — the recipient's expected DPS output relative to
// the raid's top spec (1.0). A party buff is worth what it multiplies: the
// same tier on a 950-DPS hunter beats it on a 500-DPS boomkin, so a top DPS
// is placed where THEY get buffed before their buff goes to a weaker group.
// Calibrated from a live Gruul log (PartyPlannerWeb/gruul_dps_data.txt):
// Aff ~1000, BM ~950/880, Arcane ~930/880/760, Destro ~930/810/640,
// Combat ~900/740, Ele ~870, Fury ~730, Enh ~730, Ret ~630, Boomkin ~510,
// Prot Pal ~470, Feral tank ~460. Unlogged specs are placed by class analogy.
const DPS_WEIGHT = {
  'WARLOCK:Affliction': 1.0, 'HUNTER:Beast Mastery': 1.0, 'MAGE:Arcane': 0.95,
  'WARLOCK:Destruction': 0.9, 'ROGUE:Combat': 0.9, 'SHAMAN:Elemental': 0.9,
  'HUNTER:Marksmanship': 0.9, 'HUNTER:Survival': 0.85, 'ROGUE:Assassination': 0.85,
  'ROGUE:Subtlety': 0.8, 'MAGE:Fire': 0.85, 'MAGE:Frost': 0.8, 'WARLOCK:Demonology': 0.85,
  'PRIEST:Shadow': 0.8, 'WARRIOR:Fury': 0.8, 'WARRIOR:Arms': 0.8, 'SHAMAN:Enhancement': 0.8,
  'PALADIN:Retribution': 0.7, 'DRUID:Balance': 0.6, 'DRUID:Feral': 0.6,
  'PALADIN:Protection': 0.5, 'WARRIOR:Protection': 0.5,
};
const DPS_WEIGHT_BY_ROLE = { melee_dps: 0.8, ranged_dps: 0.9, caster_dps: 0.85, tank: 0.5, healer: 1.0 };

// Fold the value tables above into the TBC ruleset now that they exist —
// dpsWeightFor/dpsValueFor/mitValueFor read them back out through
// activeRules() so a future ruleset only needs its own tables here.
Object.assign(Rulesets.tbc, {
  dpsValue: DPS_VALUE, mitValue: MIT_VALUE, sustainValue: SUSTAIN_VALUE,
  dpsWeight: DPS_WEIGHT, dpsWeightByRole: DPS_WEIGHT_BY_ROLE,
});

// ── CLASSIC ERA SYNERGY MODEL ──
// Same shape as the TBC tables above, scaled to what actually exists in
// Classic Era (no Wrath of Air/Totem of Wrath/Ferocious Inspiration/Tree of
// Life). Values are heuristics, not measured percentages — same disclaimer
// as DPS_VALUE above.
const DPS_VALUE_CLASSIC = {
  WINDFURY:           { key: { 'WARRIOR:Fury': 11, 'ROGUE:Combat': 10, 'ROGUE:Assassination': 9, 'ROGUE:Subtlety': 8, 'WARRIOR:Arms': 9, 'SHAMAN:Enhancement': 8, 'DRUID:Feral': 0 }, role: { melee_dps: 7, tank: 3 } },
  GRACE_OF_AIR:       { role: { melee_dps: 2, ranged_dps: 4, tank: 2 } },
  TRANQUIL_AIR:       { role: { caster_dps: 2, healer: 1 } },
  STRENGTH_OF_EARTH:  { role: { melee_dps: 2, tank: 2 } },
  STONESKIN:          { role: {} },
  MANA_SPRING:        { role: { caster_dps: 2, healer: 2 } },
  MANA_TIDE:          { role: { healer: 4 } },
  DEVOTION_AURA:      { role: {} },
  RETRIBUTION_AURA:   { role: { melee_dps: 1, tank: 1 } },
  CONCENTRATION_AURA: { role: { healer: 2, caster_dps: 1 } },
  SANCTITY_AURA:      { role: { melee_dps: 1, ranged_dps: 1, caster_dps: 1, tank: 1 } },
  BATTLE_SHOUT:       { role: { melee_dps: 3, ranged_dps: 2, tank: 2 } },
  TRUESHOT_AURA:      { role: { melee_dps: 3, ranged_dps: 4 } },
  LEADER_OF_THE_PACK: { role: { melee_dps: 4, ranged_dps: 4, tank: 2 } },
  MOONKIN_AURA:       { role: { caster_dps: 4 } },
  BLOOD_PACT:         { role: { tank: 1 } },
};
const MIT_VALUE_CLASSIC = {
  DEVOTION_AURA:      { 'WARRIOR:Protection': 10, 'PALADIN:Protection': 10, 'DRUID:Feral': 5 },
  STONESKIN:          { '*': 6 },
  GRACE_OF_AIR:       { 'WARRIOR:Protection': 3, 'PALADIN:Protection': 5, 'DRUID:Feral': 8 },
  STRENGTH_OF_EARTH:  { 'WARRIOR:Protection': 4, 'PALADIN:Protection': 2, 'DRUID:Feral': 3 },
  LEADER_OF_THE_PACK: { 'DRUID:Feral': 5, '*': 2 },
  WINDFURY:           { 'WARRIOR:Protection': 3, 'PALADIN:Protection': 1, 'DRUID:Feral': 0 },
  BATTLE_SHOUT:       { '*': 2 },
  RETRIBUTION_AURA:   { '*': 1 },
  BLOOD_PACT:         { '*': 4 },
};
const SUSTAIN_VALUE_CLASSIC = { MANA_SPRING: 3, MANA_TIDE: 5, CONCENTRATION_AURA: 2 };

// DPS_WEIGHT_CLASSIC — rough Classic Era ordering: Fury Warrior/Rogues/
// Fire+Frost Mage/Destro Warlock highest, Hunters next, Shadow Priest/Feral
// cat/Elemental/Enhancement/Balance/Retribution lower. Heuristic, not
// log-calibrated (no Classic parse data available yet, unlike DPS_WEIGHT above).
const DPS_WEIGHT_CLASSIC = {
  'WARRIOR:Fury': 1.0, 'ROGUE:Combat': 0.98, 'ROGUE:Assassination': 0.95, 'ROGUE:Subtlety': 0.9,
  'MAGE:Fire': 0.95, 'MAGE:Frost': 0.9, 'WARLOCK:Destruction': 0.95, 'WARLOCK:Affliction': 0.9, 'WARLOCK:Demonology': 0.85,
  'MAGE:Arcane': 0.8, 'WARRIOR:Arms': 0.85,
  'HUNTER:Marksmanship': 0.85, 'HUNTER:Beast Mastery': 0.85, 'HUNTER:Survival': 0.8,
  'PRIEST:Shadow': 0.7, 'DRUID:Feral': 0.68, 'SHAMAN:Elemental': 0.65, 'SHAMAN:Enhancement': 0.65,
  'DRUID:Balance': 0.6, 'PALADIN:Retribution': 0.55,
  'WARRIOR:Protection': 0.45, 'PALADIN:Protection': 0.45,
};
const DPS_WEIGHT_BY_ROLE_CLASSIC = { melee_dps: 0.8, ranged_dps: 0.85, caster_dps: 0.8, tank: 0.5, healer: 1.0 };

Object.assign(Rulesets.classic, {
  dpsValue: DPS_VALUE_CLASSIC, mitValue: MIT_VALUE_CLASSIC, sustainValue: SUSTAIN_VALUE_CLASSIC,
  dpsWeight: DPS_WEIGHT_CLASSIC, dpsWeightByRole: DPS_WEIGHT_BY_ROLE_CLASSIC,
});

// ── FOREVER SYNERGY MODEL ──
// Same roster of specs as Classic (no new classes/specs in Forever), so the
// recipient DPS-weight ordering is identical — shared directly by reference
// rather than copy-pasted. The buff-value tables differ only where Forever's
// buff catalog differs from Classic's: Tranquil Air is dropped (doesn't
// exist), and the four Paladin auras get a small sustain bump for their new
// +1% healing-taken effect (Concentration Aura's existing sustain value goes
// from 2 to 3; the other three, which had none, get a light +1).
const DPS_VALUE_FOREVER = { ...DPS_VALUE_CLASSIC };
delete DPS_VALUE_FOREVER.TRANQUIL_AIR;
// Forever's Leader of the Pack and Moonkin Aura are the same 3% crit aura for
// melee, ranged AND spell crit (one slot, see rules.exclusiveBuffs), so each
// is worth something to every role, unlike Classic's melee-only LotP and
// caster-only Moonkin it was copied from. Scaled to the priorities above.
DPS_VALUE_FOREVER.LEADER_OF_THE_PACK = { role: { melee_dps: 4, ranged_dps: 4, caster_dps: 3, tank: 2 } };
DPS_VALUE_FOREVER.MOONKIN_AURA = { role: { caster_dps: 4, melee_dps: 2, ranged_dps: 2, tank: 1 } };
const MIT_VALUE_FOREVER = { ...MIT_VALUE_CLASSIC };
const SUSTAIN_VALUE_FOREVER = { ...SUSTAIN_VALUE_CLASSIC, CONCENTRATION_AURA: 3, DEVOTION_AURA: 1, RETRIBUTION_AURA: 1, SANCTITY_AURA: 1 };
Object.assign(Rulesets.forever, {
  dpsValue: DPS_VALUE_FOREVER, mitValue: MIT_VALUE_FOREVER, sustainValue: SUSTAIN_VALUE_FOREVER,
  dpsWeight: DPS_WEIGHT_CLASSIC, dpsWeightByRole: DPS_WEIGHT_BY_ROLE_CLASSIC,
});

function dpsWeightFor(player) {
  const rules = activeRules();
  const w = (rules.dpsWeight || {})[player.class + ':' + player.spec];
  if (w != null) return w;
  const r = (rules.dpsWeightByRole || {})[player.role];
  return r != null ? r : 0.8;
}

function dpsValueFor(buffId, player) {
  const v = (activeRules().dpsValue || {})[buffId];
  if (!v) return 0;
  const key = player.class + ':' + player.spec;
  let base = 0;
  if (v.key && v.key[key] != null) base = v.key[key];
  else if (v.class && v.class[player.class] != null) base = v.class[player.class];
  else if (v.role && v.role[player.role] != null) base = v.role[player.role];
  return base * dpsWeightFor(player);
}

function mitValueFor(buffId, tank) {
  const v = (activeRules().mitValue || {})[buffId];
  if (!v) return 0;
  const key = tank.class + ':' + tank.spec;
  if (v[key] != null) return v[key];
  if (v['*'] != null) return v['*'];
  return 0;
}

// Totems the scorer credits on top of the shaman's standing element totem
// (see Optimizer.resolveGroupBuffs).
const COOLDOWN_TOTEMS = new Set(['MANA_TIDE']);

const ROLE_COMPAT = {
  tank:       ['melee_dps', 'healer'],
  healer:     ['tank', 'caster_dps'],
  melee_dps:  ['tank', 'ranged_dps'],
  ranged_dps: ['melee_dps', 'caster_dps'],
  caster_dps: ['healer', 'ranged_dps'],
};

// ?dev only: wraps fn in performance.mark/measure ("pp:optimize", "pp:compare") so the
// browser's Performance panel and performance.getEntriesByType('measure') show what
// Optimize and Compare cost. Production (no ?dev) just calls fn.
function devPerfEnabled() {
  return typeof location !== 'undefined' && /[?&]dev(?:[&=]|$)/.test(location.search || '') &&
    typeof performance !== 'undefined' && typeof performance.mark === 'function' && typeof performance.measure === 'function';
}
function devMeasure(name, fn) {
  if (!devPerfEnabled()) return fn();
  performance.mark(name + ':start');
  try {
    return fn();
  } finally {
    performance.mark(name + ':end');
    performance.measure(name, name + ':start', name + ':end');
    performance.clearMarks(name + ':start');
    performance.clearMarks(name + ':end');
  }
}

const Optimizer = {
  // Every Optimize replaces the previous run's suggested Open slots: drop
  // them and lay out the real players, then suggest the specs the raid is
  // missing (OpenSlots.choose) and seat each one in the group it belongs in,
  // moving one seated player out to an empty seat when that group is full
  // (a suggested Disc Priest with the MT and healers, not wherever a seat
  // happened to be empty). Any seat still empty after that (inside a group
  // frozen by the leader's own request) is filled in place.
  optimize() {
    devMeasure('pp:optimize', () => {
      State.preferredSlots = PreferredSlots.manual();
      this._optimizeSeats();
      OpenSlots.seat(OpenSlots.choose());
      OpenSlots.fill();
    });
  },

  // The adapter between State and plan(): reads the board and its settings,
  // asks plan() for a layout, and applies the result.
  _optimizeSeats() {
    if (!GameVersions[State.gameVersion].modeled) {
      enforceRaidCapacity(State.groups, State.bench, Config.Raids[State.selectedRaid].groups);
      State.roster = State.groups.flat();
      return;
    }
    const inputs = {
      gameVersion: State.gameVersion,
      mode: State.optimizerMode || 'max_dps',
      constraints: State.playerConstraints || [],
      drummers: State.drummers || [],
      faction: Faction.current(),
    };
    // Groups with open requests keep their existing layout. Optimize the remaining
    // groups without consuming the space deliberately left for future sign-ups.
    // The whole board is arranged with those groups frozen in place, not the
    // free groups on their own: arranging four free groups as a 4-group raid
    // collapsed the group identities (a caster group turned "melee"), which
    // put Ele Shamans, Boomkins and Destro locks into melee-identity groups.
    if (State.preferredSlots.length) {
      const frozen = State.groups.map((g, i) => PreferredSlots.forGroup(i).length ? g.slice() : null);
      const free = State.groups.filter((g, i) => !frozen[i]).flat();
      if (frozen.some(f => !f) && free.length) {
        const { groups } = this.plan(State.groups.flat(), {
          ...inputs, numGroups: State.groups.length, raidSize: Config.Raids[State.selectedRaid].size, frozen,
        });
        this._applyPlan(groups, []);
      }
      return;
    }
    const raidInfo = Config.Raids[State.selectedRaid];
    const pool = [];
    for (const group of State.groups) {
      for (const player of group) pool.push(player);
    }
    if (pool.length === 0) return;
    const { groups, bench } = this.plan(pool, {
      ...inputs, numGroups: raidInfo ? raidInfo.groups : 5, raidSize: raidInfo ? raidInfo.size : 25,
    });
    this._applyPlan(groups, bench);
  },

  // Writes a plan() result to the board: overflow joins the bench, every seated
  // player learns their group, and the roster follows the groups.
  _applyPlan(groups, bench) {
    if (!State.bench) State.bench = [];
    State.bench.push(...bench);
    for (let gi = 0; gi < groups.length; gi++) {
      for (const p of groups[gi]) p.groupNumber = gi + 1;
    }
    State.groups = groups;
    State.roster = groups.flat();
  },

  // ── BOARD COMPARISON (read-only) ────────────────────────────
  // "Current board X vs optimized Y". Never touches State: plan() gets copies of the
  // seated players and both boards are only scored. groupScore alone is not the
  // acceptance criterion (Optimize's later phases exist to remove an isolated
  // player, fill drum coverage and honour keep-together/apart pairs), so a board
  // is judged by its total groupScore AND those rule breaks.

  // The group identities to score `groups` under: the board's own while they still
  // describe it (Optimize stamps them), otherwise read off what each group holds.
  boardIdentities(groups) {
    const own = groups._roleIdentities;
    if (own && own.length === groups.length) return own;
    const held = groups.map(g => g.slice());
    held._frozenGroups = new Set(held.map((_, gi) => gi));
    held._frozen = new Set(groups.flat());
    return this.frozenIdentitiesFor(held, groups.flat());
  },

  // { score, isolated, constraintBreaks, drumGaps, breaks } for a board. `identities`
  // defaults to boardIdentities(); the returned object never aliases `groups`.
  evaluateBoard(groups, mode, identities) {
    const board = groups.map(g => g.slice());
    board._roleIdentities = identities || this.boardIdentities(groups);
    let score = 0;
    board.forEach((g, gi) => { score += this.groupScore(g, gi, board, mode); });
    const isolated = board.filter(g => this.wouldIsolate(g, -1)).length;
    const constraintBreaks = Constraints.violations(board).length;
    const drumGaps = activeVersion() === 'tbc' && Drummers.tagged().length
      ? board.filter(g => g.length > 0 && !g.some(p => Drummers.isDrummer(p.name))).length : 0;
    return { score, isolated, constraintBreaks, drumGaps, breaks: isolated + constraintBreaks + drumGaps };
  },

  // The seated board against what a plain Optimize click would lay out from the same
  // players under the same strategy, or null when there is nothing to compare (not
  // modeled, empty, or open requests, which make Optimize freeze groups instead).
  // verdict: 'same' | 'optimize-better' | 'current-ahead' | 'optimize-fixes'.
  compareToOptimized() {
    if (!GameVersions[State.gameVersion].modeled) return null;
    if ((State.preferredSlots || []).length) return null;
    const groups = State.groups || [];
    const seated = groups.flat();
    if (!seated.length) return null;
    const mode = State.optimizerMode || 'max_dps';
    const raidInfo = Config.Raids[State.selectedRaid];
    const { groups: planned } = this.plan(seated.map(p => ({ ...p })), {
      gameVersion: State.gameVersion, mode, constraints: State.playerConstraints || [], drummers: State.drummers || [],
      faction: Faction.current(), numGroups: raidInfo ? raidInfo.groups : 5, raidSize: raidInfo ? raidInfo.size : 25,
    });
    const current = this.evaluateBoard(groups, mode);
    const optimized = this.evaluateBoard(planned, mode, planned._roleIdentities);
    const delta = optimized.score - current.score;
    const EPSILON = 0.5; // the same bar refineSwaps uses before it moves anyone
    const verdict = optimized.breaks < current.breaks ? 'optimize-fixes'
      : optimized.breaks > current.breaks ? 'current-ahead'
      : delta > EPSILON ? 'optimize-better'
      : delta < -EPSILON ? 'current-ahead' : 'same';
    return { mode, current, optimized, delta, verdict };
  },

  // One line for the strategy menu.
  describeComparison(cmp) {
    if (!cmp) return '';
    const x = Math.round(cmp.current.score), y = Math.round(cmp.optimized.score);
    const breaks = [
      cmp.current.isolated ? `${cmp.current.isolated} isolated group${cmp.current.isolated === 1 ? '' : 's'}` : '',
      cmp.current.constraintBreaks ? `${cmp.current.constraintBreaks} constraint${cmp.current.constraintBreaks === 1 ? '' : 's'} broken` : '',
      cmp.current.drumGaps ? `${cmp.current.drumGaps} without drums` : '',
    ].filter(Boolean).join(', ');
    const head = `Current board ${x} vs optimized ${y}`;
    if (cmp.verdict === 'same') return `${head}: already as good as Optimize.`;
    if (cmp.verdict === 'optimize-fixes') return `${head}: Optimize fixes ${breaks}.`;
    if (cmp.verdict === 'current-ahead') return `${head}: Optimize would not improve this board.`;
    return `${head}: Optimize adds ${Math.round(cmp.delta)}.`;
  },

  // Lays `players` out into groups from explicit inputs only: it reads and
  // writes no State and no DOM (the rule lookups it leans on read `opts`
  // through LayoutScope while it runs), so a caller can plan any roster under
  // any settings without staging a board first. Deterministic for a given
  // player set and opts, whatever order or arrangement the players arrive in.
  //
  // opts: { gameVersion, numGroups, raidSize, mode = 'max_dps', max = 5,
  //   constraints = [], drummers = [], faction (default: detected from players),
  //   frozen (per-group player arrays or null: those groups keep their members
  //   and stay at their current size, see arrange) }.
  // Returns { groups, bench }: `groups` is the board (it also carries
  // _roleIdentities/_anchors for later scoring) and `bench` the players left
  // over when the roster exceeds the raid. Seated players are stamped with
  // their group (groupNumber) by the caller; the players passed in are not
  // copied, so a benched one comes back with groupNumber 0 and a stale
  // comp-template lock is cleared, exactly as arrange() has always done.
  plan(players, opts) {
    const { gameVersion, numGroups, raidSize, mode = 'max_dps', max = 5, constraints = [], drummers = [], frozen = null } = opts;
    const faction = opts.faction !== undefined ? opts.faction : Faction.detect(players);
    return LayoutScope.run({ gameVersion, faction, constraints, drummers }, () => {
      // Over capacity: decide WHO sits first (floors, greedy, bench trades),
      // then lay the seated set out exactly as a seated-only run would. The
      // selection search takes a different path than a plain layout of the same
      // players, so laying out from its intermediate board would leave the next
      // Optimize click (which never sees the bench) in a different local optimum
      // and reshuffle a board the first click just produced.
      let seated = players, bench = [];
      if (!frozen && players.length > numGroups * max) {
        ({ seated, bench } = this.selectSeated(players, numGroups, raidSize, max, mode));
      }
      const groups = this.arrange(seated, numGroups, raidSize, max, mode, frozen ? { frozen } : undefined);
      // The freeze only applies to this run; the board keeps _roleIdentities.
      if (frozen) { delete groups._frozen; delete groups._frozenGroups; delete groups._cap; }
      return { groups, bench };
    });
  },

  // Canonical order. Greedy placement and swap refinement break ties by
  // iteration order, so the result must not depend on how the board
  // happened to be arranged before the click — otherwise every Optimize
  // lands in a different local optimum and the second click reshuffles
  // a layout the first one just produced.
  sortedPool(players) {
    return players.slice().sort((a, b) => {
      const ka = a.role + '|' + a.class + '|' + a.spec + '|' + (a.name || '');
      const kb = b.role + '|' + b.class + '|' + b.spec + '|' + (b.name || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  },

  // Seated-only refinement: pairwise swaps alone cannot change group sizes,
  // so a group the greedy phase filled last stays starved while other groups
  // sit full; single-player moves into open slots fix that. Alternate until
  // neither neighbourhood improves. Skipped for relaxed.
  refineRounds(groups, max, mode) {
    if (mode === 'relaxed') return;
    for (let round = 0; round < 6; round++) {
      this.refineSwaps(groups, max, mode);
      const moved = this.refineMoves(groups, max, mode);
      const exchanged = this.refinePairExchanges(groups, mode);
      if (!moved && !exchanged) break;
    }
  },

  // Lays out a set of players that fits the raid. Deterministic for a given
  // set: the same players always produce the same board, whatever order or
  // arrangement they arrive in.
  //
  // opts.frozen[gi] (an array of that group's players, or null) seats those
  // players first, pins them, and caps the group at its current size so its
  // open seats stay reserved (see _optimizeSeats' preferred-slot path).
  arrange(players, numGroups, raidSize, max, mode, opts) {
    const pool = this.sortedPool(players);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    groups._cap = groups.map(() => max);
    groups._frozen = new Set();
    groups._frozenGroups = new Set();
    for (const [gi, members] of ((opts && opts.frozen) || []).entries()) {
      if (!members || gi >= numGroups) continue;
      groups._frozenGroups.add(gi);
      for (const p of members) {
        const i = pool.indexOf(p);
        if (i < 0) continue;
        pool.splice(i, 1);
        groups[gi].push(p);
        groups._frozen.add(p);
      }
      groups._cap[gi] = groups[gi].length;
    }

    // Phase 0: Seat locked players (comp-template placements, backlog #1)
    // into their fixed group before anything else runs, and pull them out of
    // the pool so no later phase treats them as available. isPinned() (below)
    // then keeps every refinement phase from moving them again — the same
    // mechanism the seeded anchor tank already relies on. A no-op unless a
    // template was just applied (nothing else ever sets .locked), so this
    // changes nothing for the existing scenario-tests fixtures.
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      if (!p.locked) continue;
      const gi = p.groupNumber ? p.groupNumber - 1 : -1;
      if (gi >= 0 && gi < numGroups && this.hasRoom(groups, gi, max)) {
        groups[gi].push(p);
        pool.splice(i, 1);
      } else {
        p.locked = false; // stale/out-of-range group index — fall back to normal placement
      }
    }

    // Phase 1: Seed groups with role identities
    this.seedGroups(pool, groups, numGroups, raidSize, max, mode);

    // Phase 2: Greedy marginal-gain placement of remaining players
    this.greedyPlace(pool, groups, max, mode);

    // Phase 3: Refinement
    this.refineRounds(groups, max, mode);

    // Phase 3b: Guest optimization — the tank group is filled last by the
    // greedy phase (it's the least attractive), so its leftover DPS guests
    // are near-arbitrary. Re-audit them with a zero swap threshold: any
    // strictly better guest choice is taken, even ones too small for
    // refineSwaps' churn threshold.
    this.optimizeTankGuests(groups, mode);

    // Phase 4: De-isolation — always runs, every mode. A player who benefits
    // from nobody in their group (e.g. the lone melee DPS in an otherwise
    // all-caster/healer group) is worse than a small buff-score inefficiency,
    // but refineSwaps only takes a swap that clears SWAP_THRESHOLD, so an
    // isolated player can survive it if no single swap scores well enough.
    this.deIsolate(groups, mode, max);

    // Phase 5: Spread scarce single-point-of-failure providers (ruleset-gated;
    // a no-op unless rules.spreadProviders is set — TBC is untouched). Must
    // run LAST: de-isolating a group that lost its second shaman to this pass
    // can leave the remaining one as that group's only caster-family member,
    // which deIsolate would then "fix" by pulling it out again — silently
    // re-creating the exact stack this phase exists to prevent. Nothing runs
    // after it, so its rebalance is what the board actually ships with.
    // spreadProviders itself now refuses to pick a source whose removal would
    // strand a melee/caster DPS deIsolate just fixed (see its wouldIsolate()
    // guard) — the mirror case of the one this comment already described,
    // and the one that used to survive into Relaxed mode's shipped board
    // since nothing ran after Phase 5 to catch it there. `mode` is passed
    // through so its very last-resort source tier (spareProtected) — a
    // deliberate softening of the "never touch a guest's only buff" courtesy,
    // needed to fully close Relaxed's known gaps — only engages for Relaxed;
    // every other mode already reaches full coverage via refineRounds before
    // Phase 5 even runs, so leaving their spreadProviders behavior untouched
    // avoids trading a fixed gap for a fresh one elsewhere (see spreadProviders).
    this.spreadProviders(groups, mode);

    // Phase 5b: Spread TBC drummers (feature-backlog-3 #5). A Leatherworker's
    // Drums is party-scoped exactly like Windfury/an aura, but drummers are
    // tagged per-player independent of class/spec, so spreadProviders' class-
    // matching machinery doesn't apply — this is a small, dedicated pass
    // instead. Strict no-op unless State.drummers is non-empty on a TBC
    // roster, so the TBC scenario suite (which never tags any) is completely
    // untouched. Runs before Phase 6 so any constraint it happens to disturb
    // is still fixed up right after, same ordering reasoning as Phase 5.
    this.spreadDrummers(groups, mode);

    // Phase 6: Hard player constraints (backlog #3) — keep-together/keep-apart
    // pairs win over every structural/buff preference above, so this must run
    // absolutely last (same "nothing runs after it" reasoning as Phase 5). A
    // no-op unless State.playerConstraints is non-empty, so the TBC scenario
    // suite (which never sets it) is untouched. Readiness.balanceWarnings()
    // recomputes Constraints.violations() live from State.groups every render
    // rather than trusting a cached report, so a later manual drag that
    // breaks a constraint is still caught even though enforce() only runs
    // here, right after Optimize.
    Constraints.enforce(groups, max);
    return groups;
  },

  // A melee group's Windfury (or an Alliance melee group's aura, or a melee
  // group's Leader of the Pack) depends on exactly one class member being
  // present. groupScore's per-group penalties (meleeWantsWindfury etc.) can
  // still let greedy placement + pairwise swaps settle on two of that class
  // stacked in one group while a same-identity group has zero: the stack
  // isn't penalized (nothing scores an *excess* of a buff down), and undoing
  // it is a two-hop trade no single pairwise swap can discover on its own —
  // exactly the class of local optimum documented in tasks/lessons.md
  // (2026-08-19, "model-optimal is not the acceptance criterion"). This phase
  // looks at the whole board instead of one group at a time and rebalances
  // that specific case. No-op unless the active ruleset sets
  // rules.spreadProviders (Classic only — see Rulesets.classic.rules).
  spreadProviders(groups, mode) {
    const rules = activeRules();
    const specs = (rules.rules && rules.rules.spreadProviders) || [];
    if (!specs.length) return;
    // Every group that actually holds melee dps (Windfury/aura/LotP
    // convention). Checked by ACTUAL role membership, not the abstract seed
    // identity from seedGroups — a group seeded 'caster_dps' can still end up
    // holding melee dps members (overflow, ROLE_COMPAT cohesion), and those
    // players need Windfury exactly as much as a 'melee_dps'-seeded group's
    // do. Melee coverage runs first and always wins ties over caster
    // coverage below, per this task's stated priority order.
    this._spreadPass(groups, specs, 'melee_dps', { mode });

    // Surplus shamans (more shamans than melee-identity groups) then cover
    // caster groups with Mana Spring. This used to be left entirely to
    // groupScore's ordinary buff-value pull, which under-covered casters in
    // practice (a lone extra shaman often scored better riding with the tank
    // group's healers than hopping to an already-full caster group). Restricted
    // to SHAMAN only — Paladin/Feral have no caster-facing equivalent buff —
    // and passes `protectRoles: ['melee_dps']` so this pass can never treat a
    // melee group's sole shaman as "spare" just because that melee group
    // itself has no caster_dps members; only a genuine surplus (2+ in one
    // group) or an idle shaman sitting somewhere with neither a melee_dps NOR
    // a caster_dps member relying on it (e.g. alone with the tank/healer
    // group) is fair game as a source. A no-op unless the ruleset actually
    // lists SHAMAN as a spread provider (Classic/Forever; TBC has none).
    const shamanSpec = specs.filter(s => s.class === 'SHAMAN');
    if (shamanSpec.length) this._spreadPass(groups, shamanSpec, ['caster_dps', 'healer'], { protectRoles: ['melee_dps'], mode });
  },

  // TBC-only (feature-backlog-3 #5): spread Leatherworker drummers one per
  // party before letting any group hold two. Deliberately simpler than
  // _spreadPass above — drums aren't tied to a class/spec or a benefiting
  // role, so none of that machinery's role-targeting guards apply.
  // Every group that already has >=1 drummer is left alone; a group with
  // zero only gets one moved in if another group has a genuine surplus
  // (2+), and only by swapping with a non-pinned member (isPinned covers
  // both `.locked` and the seeded anchor tank, same guard every other phase
  // uses) — never into/out of an empty seat, since a full 25/40-man raid has
  // none.
  //
  // Drums are worth less than the buffs a swap can take away, so a candidate
  // swap (needy member <-> surplus drummer) is skipped when it would remove
  // the only provider of a buff either group's members actually use (the
  // melee group's sole Feral = Leader of the Pack, the caster group's sole
  // Boomkin, ...) or leave a melee/caster DPS with no same-family peer
  // (wouldIsolate, the same lookahead spreadProviders uses; a group that was
  // already isolated before the swap doesn't block it). Of the swaps that
  // remain, the one losing the least groupScore across the two groups wins.
  // Bounded, deterministic, and a strict no-op with zero drummers tagged, so
  // the TBC scenario suite (which never tags any) is completely unaffected.
  spreadDrummers(groups, mode = State.optimizerMode || 'max_dps') {
    if (activeVersion() !== 'tbc') return;
    if (!Drummers.tagged().length) return;
    const isDrummer = p => Drummers.isDrummer(p.name);
    const pairScore = (a, b) => this.groupScore(groups[a], a, groups, mode) + this.groupScore(groups[b], b, groups, mode);
    // Buff ids a group resolves that at least one of its members gets value from.
    // The warrior shouts count as one buff (Battle or Commanding Shout): a swap may
    // turn a group's second shout into nothing, never its only one.
    const shouts = activeRules().shouts || [];
    const family = (id) => shouts.includes(id) ? 'SHOUT' : id;
    const usedBuffs = (grp) => [...this.resolveGroupBuffs(grp, () => 1)].filter(id =>
      grp.some(m => dpsValueFor(id, m) > 0 || (m.role === 'tank' && mitValueFor(id, m) > 0)));
    const keepsBuffs = (before, after) => {
      const kept = new Set([...this.resolveGroupBuffs(after, () => 1)].map(family));
      return usedBuffs(before).every(id => kept.has(family(id)));
    };
    const isolatedNow = (gi) => this.wouldIsolate(groups[gi], -1);

    for (let iter = 0; iter < 8; iter++) {
      const counts = groups.map(g => g.filter(isDrummer).length);
      const needy = [];
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].length > 0 && counts[gi] === 0) needy.push(gi);
      }
      if (!needy.length) break; // every non-empty group already has a drummer

      // Try each needy group in turn (a pinned-out needy group, or one whose
      // only surplus sources are themselves all pinned, must not block a
      // DIFFERENT needy group from being fixed this same round).
      let moved = false;
      for (const toGi of needy) {
        // Surplus groups (2+), most-surplus first, so a group with 3 gives
        // up its spare before one with exactly 2 does.
        const surplus = groups
          .map((g, gi) => ({ gi, count: counts[gi] }))
          .filter(x => x.gi !== toGi && x.count >= 2)
          .sort((a, b) => b.count - a.count);

        let best = null;
        for (const { gi: fromGi } of surplus) {
          const toIsolated = isolatedNow(toGi), fromIsolated = isolatedNow(fromGi);
          const before = pairScore(toGi, fromGi);
          for (let targetIdx = 0; targetIdx < groups[toGi].length; targetIdx++) {
            const target = groups[toGi][targetIdx];
            if (this.isPinned(target, toGi, groups)) continue;
            for (let sourceIdx = 0; sourceIdx < groups[fromGi].length; sourceIdx++) {
              const source = groups[fromGi][sourceIdx];
              if (!isDrummer(source) || this.isPinned(source, fromGi, groups)) continue;
              if (!toIsolated && this.wouldIsolate(groups[toGi], targetIdx, source)) continue;
              if (!fromIsolated && this.wouldIsolate(groups[fromGi], sourceIdx, target)) continue;

              const toBefore = groups[toGi], fromBefore = groups[fromGi];
              const toAfter = toBefore.map(p => p === target ? source : p);
              const fromAfter = fromBefore.map(p => p === source ? target : p);
              if (!keepsBuffs(toBefore, toAfter) || !keepsBuffs(fromBefore, fromAfter)) continue;

              groups[toGi][targetIdx] = source;
              groups[fromGi][sourceIdx] = target;
              const delta = pairScore(toGi, fromGi) - before;
              groups[toGi][targetIdx] = target;
              groups[fromGi][sourceIdx] = source;
              if (!best || delta > best.delta) best = { toGi, targetIdx, fromGi, sourceIdx, delta };
            }
          }
        }

        if (best) {
          const source = groups[best.fromGi][best.sourceIdx];
          groups[best.fromGi][best.sourceIdx] = groups[best.toGi][best.targetIdx];
          groups[best.toGi][best.targetIdx] = source;
          moved = true;
          break; // recompute counts fresh before tackling the next needy group
        }
      }
      if (!moved) break; // nothing resolvable this round (locks, or every swap costs a sole provider) — stop rather than spin
    }
  },

  // One rebalancing pass for a single target role. Repeatedly finds a group
  // that actually holds a member of that role but has zero of the class, and
  // moves a provider in from elsewhere: straight into an open seat, or
  // swapped for whichever non-pinned member of the needy group benefits
  // least (lowest dpsWeightFor) if the needy group is full.
  //
  // Two source tiers, tried in priority order:
  //   - "surplus" groups holding 2+ (a real excess — taking one never drops
  //     that group below one).
  //   - failing that, "spare" groups holding exactly 1 that this pass's role
  //     doesn't actually need there (e.g. a shaman parked with 3 Warlocks and
  //     no melee dps during the melee pass, or riding with the tank/healer
  //     group) — a lone provider sitting somewhere it isn't needed outranks
  //     a melee group getting none at all. This is what lets 4 shamans still
  //     reach all 4 melee groups even when greedy placement already spread
  //     them to exactly one-each in the wrong 4 groups first.
  // The tank/healer group is never itself a needy target — it doesn't need
  // Windfury — but it's fair game as a source under either tier, per this
  // task's stated priority: melee groups first, then casters, then healers.
  _spreadPass(groups, specs, wantsRole, opts) {
    // wantsRole is usually one role ('melee_dps'), but the caster-facing Mana
    // Spring/Tide pass passes ['caster_dps','healer'] — both roles actually
    // benefit from a shaman's water totem, and a "caster-identity" group that
    // greedy placement filled almost entirely with overflow healers (no real
    // caster_dps member at all) still needs sustain coverage exactly like one
    // with casters in it.
    const wantsRoles = Array.isArray(wantsRole) ? wantsRole : [wantsRole];
    // Roles this pass must never strip coverage from, even when the group has
    // no member of THIS pass's wantsRole(s). Used by the caster-facing Mana
    // Spring pass (protectRoles: ['melee_dps']) so it can't mistake a melee
    // group's sole shaman for "spare" just because that melee group happens
    // to have no caster_dps/healer member of its own — the shaman is still
    // needed there for Windfury, which is a different pass's job to have
    // already set up.
    const protectRoles = ((opts && opts.protectRoles) || []).filter(r => !wantsRoles.includes(r));
    // Relaxed-only: whether the very last fallback tier (spareProtected,
    // below) is allowed to engage at all. It's a deliberate softening of the
    // "never touch a guest's only buff" courtesy, and only Relaxed actually
    // needs it — every other mode already reaches full provider coverage via
    // refineRounds before Phase 5 runs, so letting spareProtected fire there
    // too just trades one mode's already-closed gap for a fresh one
    // elsewhere (confirmed via classic-forever-scenarios.js: enabling it
    // unconditionally regressed tank_mit on the Forever mixed 40 fixture).
    const allowProtectedFallback = (opts && opts.mode) === 'relaxed';
    // Last-resort-only source identity: the melee-facing (Windfury) pass must
    // never be the one that strips the raid's caster-identity group of its
    // own natural mana-sustain shaman just because that group has no
    // melee_dps member to "protect" it (protectRoles above only guards the
    // reverse direction — the caster-facing pass never touching a melee
    // group's shaman). Concretely: with exactly enough shamans for one per
    // melee group plus one spare, greedy placement can seat that spare
    // shaman right in the caster-identity group (where it's doing exactly
    // the job invariant (d) wants), and a melee-identity group elsewhere can
    // come up needy for Windfury with the tank/healer group ALSO holding a
    // spare shaman. Both groups are equally "spare" by the hasWantedRole
    // check, and plain gi-ascending order can pick the caster group first —
    // taking the one shaman that was already correctly placed instead of the
    // one riding along with a healer-stacked tank group that doesn't need it
    // for anything this suite checks. Demoting the opposing identity to a
    // last-resort tier (tried only when no other source exists, so Windfury
    // coverage — checked unconditionally, every mode — never regresses)
    // fixes that without touching the caster-facing pass's own logic.
    const oppositeIdentity = wantsRoles.includes('melee_dps') ? 'caster_dps'
      : (wantsRoles.includes('caster_dps') || wantsRoles.includes('healer')) ? 'melee_dps'
      : null;
    const isLastResortSource = gi => !!(oppositeIdentity && groups._roleIdentities && groups._roleIdentities[gi] === oppositeIdentity);
    // A group can be the fixed point for more than one tracked provider type
    // at once (e.g. a melee group holding both the shaman the SHAMAN pass
    // placed and the paladin the PALADIN pass is about to place). Without
    // this, the swap-eviction branch below picks whoever has the lowest
    // dpsWeightFor as the outgoing member — which happily evicts that very
    // shaman (a healer-role Resto Shaman's weight is high, but an
    // Enhancement Shaman's class:spec weight is low) the moment it's the
    // weakest body in the group, silently undoing an earlier spec's fix
    // later in this same pass. See tasks/lessons.md "model-optimal is not
    // the acceptance criterion" — the earlier fix is the convention; it must
    // survive a later spec's pass, not be sacrificed to it.
    const isSoleOtherProvider = (cand, group, currentSpec) => {
      for (const other of specs) {
        if (other === currentSpec) continue;
        const m = p => p.class === other.class && (!other.spec || (Array.isArray(other.spec) ? other.spec.includes(p.spec) : p.spec === other.spec));
        if (m(cand) && group.filter(m).length <= 1) return true;
      }
      return false;
    };
    // Outer fixed-point loop over the WHOLE spec list. A single pass over
    // specs in order (old behavior) lets a later spec's swap silently
    // re-break an earlier spec's already-fixed group: the swap-eviction
    // branch's "displaced" member lands in the FROM group, which can hand
    // that group a melee_dps member it didn't have before (so it only
    // becomes shaman-needy AFTER the shaman pass already finished). Re-running
    // every spec until nothing moves catches that follow-on need instead of
    // shipping the board mid-fix. Bounded rounds since isSoleOtherProvider
    // above stops any single spec from undoing another's OWN placement, so
    // this converges quickly in practice.
    for (let round = 0; round < 6; round++) {
      let changedAny = false;
      for (const spec of specs) {
        // spec.spec may be a single spec name (Classic: 'Feral') or an array of
        // specs that share one provider slot (Forever: Feral+Balance druids
        // both cover the same now-exclusive crit aura — see rules.exclusiveBuffs).
        const matches = p => p.class === spec.class && (!spec.spec || (Array.isArray(spec.spec) ? spec.spec.includes(p.spec) : p.spec === spec.spec));
        for (let iter = 0; iter < 6; iter++) {
          const needy = [];
          const surplus = [], surplusLast = [];
          const spare = [], spareLast = [], spareProtected = [];
          for (let gi = 0; gi < groups.length; gi++) {
            const count = groups[gi].filter(matches).length;
            const isTank = this.isTankGroup(gi, groups);
            // Excludes members that are themselves this pass's provider class —
            // an Enhancement Shaman's own role IS melee_dps, so without this a
            // shaman stranded alone among casters would count as "already
            // satisfying" the group's melee need (itself) and never be
            // considered spare.
            const hasWantedRole = !isTank && groups[gi].some(p => wantsRoles.includes(p.role) && !matches(p));
            // No `!isTank` guard here (unlike hasWantedRole above): a stray
            // melee_dps guest who ended up in the tank/healer group is still
            // relying on whatever shaman happens to be sitting there for
            // Windfury — that placement was never guaranteed by design, but
            // this pass must not actively break it. hasWantedRole's `!isTank`
            // only says the tank group is never a Windfury-pass TARGET; it
            // doesn't make its sole shaman fair game for a DIFFERENT pass to
            // take away from a melee_dps player who has no other source.
            const protectedElsewhere = protectRoles.some(r => groups[gi].some(p => p.role === r && !matches(p)));
            if (hasWantedRole && count === 0) { needy.push(gi); continue; }
            const lastResort = isLastResortSource(gi);
            if (count >= 2) (lastResort ? surplusLast : surplus).push(gi);
            else if (count === 1 && !hasWantedRole) {
              if (protectedElsewhere && allowProtectedFallback) {
                // protectedElsewhere used to disqualify a group outright —
                // but "never touch a guest's only buff source" is a
                // courtesy, not a structural guarantee (that placement was
                // never guaranteed by design, per the comment above), while a
                // genuinely needy group elsewhere going completely uncovered
                // IS one of the invariants this suite checks unconditionally.
                // Demoting it to a final fallback tier — tried only when
                // every unprotected option is exhausted, and only in Relaxed
                // (see allowProtectedFallback) — lets a raid with just enough
                // providers for "one per real need plus one spare" still
                // reach its last needy group instead of stranding that spare
                // behind an incidental guest's nice-to-have.
                spareProtected.push(gi);
              } else if (!protectedElsewhere) {
                (lastResort ? spareLast : spare).push(gi);
              }
            }
          }
          // Try, in order: a real surplus outside the opposing identity, a
          // spare outside it, the opposing identity's own surplus/spare, and
          // finally a spare that's only protected by the soft guest-courtesy
          // rule above — each tier is only consulted once every earlier one
          // has nothing left to offer.
          const source = surplus.length ? surplus : spare.length ? spare
            : surplusLast.length ? surplusLast : spareLast.length ? spareLast : spareProtected;
          if (!needy.length || !source.length) break;

          // toGi/toGroup and whichever member a full toGroup would have to
          // evict (`displaced`) don't depend on which source group supplies
          // the provider, so resolve them once up front — the source search
          // below needs `displaced` to run its wouldIsolate() lookahead.
          const toGi = needy[0];
          const toGroup = groups[toGi];
          let displaced = null, displacedIdx = -1;
          if (!this.hasRoom(groups, toGi, 5)) {
            let bestIdx = -1, bestWeight = Infinity;
            for (let pi = 0; pi < toGroup.length; pi++) {
              if (this.isPinned(toGroup[pi], toGi, groups) || matches(toGroup[pi])) continue;
              if (isSoleOtherProvider(toGroup[pi], toGroup, spec)) continue;
              const w = dpsWeightFor(toGroup[pi]);
              if (w < bestWeight) { bestWeight = w; bestIdx = pi; }
            }
            if (bestIdx < 0) break; // no room to swap into — leave this group needy
            displacedIdx = bestIdx;
            displaced = toGroup[bestIdx];
          }

          // Pick the first source group with a non-pinned provider whose
          // departure — and, on a full toGroup, `displaced`'s arrival in
          // their seat — wouldn't strand a melee/caster DPS teammate behind.
          // Without this, moving a group's only Feral Druid/Shaman/Paladin
          // out to cover a needier group can silently re-isolate whoever was
          // relying on it for their only same-family peer; nothing runs after
          // Phase 5 (spreadProviders) to catch that, so it shipped straight
          // through in Relaxed mode, where refineRounds isn't there beforehand
          // to have already prevented the conditions that cause it.
          let fromGi = -1, providerIdx = -1;
          for (const gi of source) {
            const fg = groups[gi];
            for (let pi = 0; pi < fg.length; pi++) {
              if (!matches(fg[pi]) || this.isPinned(fg[pi], gi, groups)) continue;
              if (this.wouldIsolate(fg, pi, displaced)) continue;
              fromGi = gi; providerIdx = pi; break;
            }
            if (fromGi >= 0) break;
          }
          if (fromGi < 0) break; // every candidate source would strand someone — leave this group needy

          const fromGroup = groups[fromGi];
          const provider = fromGroup[providerIdx];

          if (displaced === null) {
            fromGroup.splice(providerIdx, 1);
            toGroup.push(provider);
          } else {
            toGroup[displacedIdx] = provider;
            fromGroup[providerIdx] = displaced;
          }
          changedAny = true;
        }
      }
      if (!changedAny) break;
    }
  },

  // Decides who sits when more players are in the pool than the raid holds.
  // Returns { seated, bench }: the leftovers (groupNumber 0) are the bench, and
  // the caller lays the seated players out with arrange().
  selectSeated(players, numGroups, raidSize, max, mode) {
    const pool = this.sortedPool(players);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);

    this.seedGroups(pool, groups, numGroups, raidSize, max, mode);

    // Role floors. The raid's minimum tanks and healers get a seat before DPS
    // compete for the rest, so a late-signing healer is never benched behind
    // a twelfth mage. Within a role the greedy scorer still picks who sits.
    const floors = this.floorsFor(raidSize);
    for (const role of ['tank', 'healer']) {
      const have = groups.flat().filter(p => p.role === role).length;
      const need = Math.max(0, (floors[role] || 0) - have);
      if (need > 0) this.greedyPlace(pool, groups, max, mode, { eligible: p => p.role === role, limit: need });
    }

    this.greedyPlace(pool, groups, max, mode);

    // Bench the leftovers instead of dropping them from the roster. They stay
    // eligible for the bench refinement below; Tentative/Bench sign-ups and
    // anyone benched by hand are not in this list and are never pulled in.
    const overflow = [];
    for (const p of pool.splice(0)) { p.groupNumber = 0; overflow.push(p); }

    this.refineRounds(groups, max, mode);

    // Bench refinement. Greedy placement benches whoever is left when the
    // seats run out, which punishes pure recipients (a Combat Rogue gives
    // nothing, so he only scores once a melee group already has Windfury and
    // Leader of the Pack) even when they are worth far more to the raid than
    // a fourth tank. Trade benched overflow players against seated ones
    // whenever the raid total rises, then let the seated-only refinement
    // settle the new layout before the next trade is judged.
    if (this.refineBench(groups, overflow, raidSize, mode)) this.refineRounds(groups, max, mode);

    return { seated: groups.flat(), bench: overflow };
  },

  // Minimum tanks/healers for a raid size (see Config.RaidFloors).
  floorsFor(raidSize) {
    const exact = Config.RaidFloors[raidSize];
    if (exact) return exact;
    return raidSize <= 10 ? Config.RaidFloors[10] : Config.RaidFloors[25];
  },

  // One 'tank' identity group; the rest split as evenly as possible between
  // melee_dps and caster_dps (melee gets the extra when odd). Generalizes the
  // original 5-group [melee,melee,caster,caster,tank] pattern (still returned
  // unchanged for numGroups===5) to any raid size — Classic's 4-group 20-mans
  // and 8-group 40-mans included. 2-group 10-mans (TBC kara/za) keep their
  // own no-tank-group pattern; the seed pass below falls back to group 0.
  //
  // With `players` and rules.rosterShapedIdentities (TBC), the melee/caster
  // split follows the roster's physical vs caster DPS headcount instead, so
  // a caster-heavy raid gets one melee group and three caster groups rather
  // than casters and their shamans squeezed into a half-empty "melee" group.
  roleIdentitiesFor(numGroups, players) {
    if (numGroups <= 2) return ['melee_dps', 'caster_dps'].slice(0, numGroups);
    return this.dpsIdentitiesFor(numGroups - 1, players).concat('tank');
  },

  // Melee groups first, then caster groups, for `count` DPS-identity groups.
  dpsIdentitiesFor(count, players) {
    let meleeGroups = Math.ceil(count / 2);
    if (players && activeRules().rules.rosterShapedIdentities) {
      const phys = players.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps').length;
      const cast = players.filter(p => p.role === 'caster_dps').length;
      if (phys + cast > 0) {
        meleeGroups = Math.round(count * phys / (phys + cast));
        if (phys > 0) meleeGroups = Math.max(meleeGroups, 1);
        if (cast > 0) meleeGroups = Math.min(meleeGroups, count - 1);
      }
    }
    meleeGroups = Math.max(0, Math.min(meleeGroups, count));
    return Array.from({ length: count }, (_, i) => i < meleeGroups ? 'melee_dps' : 'caster_dps');
  },

  // Identities for a board with groups frozen around open requests: a frozen
  // group is whatever it already holds (tanks/healers -> the tank group), and
  // the free groups share the remaining identities among the free players.
  // Without this, freezing the group that held the tanks left an empty
  // "tank" identity that the healers and mages then piled into.
  frozenIdentitiesFor(groups, players) {
    const ids = groups.map(() => null);
    let haveTank = false;
    for (const gi of groups._frozenGroups) {
      const g = groups[gi];
      if (!g.length) continue;
      const support = g.filter(p => p.role === 'tank' || p.role === 'healer').length;
      const phys = g.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps').length;
      const cast = g.filter(p => p.role === 'caster_dps').length;
      if (!haveTank && support * 2 >= g.length) { ids[gi] = 'tank'; haveTank = true; }
      else ids[gi] = phys >= cast ? 'melee_dps' : 'caster_dps';
    }
    const freeIdx = groups.map((_, gi) => gi).filter(gi => !groups._frozenGroups.has(gi));
    const freePlayers = players.filter(p => !groups._frozen.has(p));
    const freeIds = haveTank
      ? this.dpsIdentitiesFor(freeIdx.length, freePlayers)
      : this.roleIdentitiesFor(freeIdx.length, freePlayers);
    freeIdx.forEach((gi, i) => { ids[gi] = freeIds[i] || null; });
    return ids;
  },

  // ── PHASE 1: SEED GROUPS ─────────────────────────────────────
  seedGroups(pool, groups, numGroups, raidSize, max, mode) {
    const everyone = pool.concat(groups.flat());
    groups._roleIdentities = groups._frozenGroups && groups._frozenGroups.size
      ? this.frozenIdentitiesFor(groups, everyone)
      : this.roleIdentitiesFor(numGroups, everyone);

    // Seed the healer/tank group with ONE anchor tank (reference comp: only
    // the Prot Paladin rides with the healers). Every other tank is placed
    // by the scorer like anyone else — a Feral tank is still that melee
    // group's Leader of the Pack, a spare Prot tank lands where its aura and
    // the totems it receives are worth most. tank_mit consolidates up to 3
    // tanks here so mitigation buffs cover all of them.
    const tankIdx = groups._roleIdentities.indexOf('tank');
    const targetIdx = tankIdx >= 0 ? tankIdx : 0;
    const minTanks = mode === 'tank_mit' ? 3 : 1;
    const anchorRank = activeRules().rules.tankAnchorRank || (() => 0);
    const tanks = pool.filter(p => p.role === 'tank').sort((a, b) => anchorRank(a) - anchorRank(b));
    groups._anchors = new Set();
    for (const t of tanks.slice(0, minTanks)) {
      if (!this.hasRoom(groups, targetIdx, max)) break;
      groups[targetIdx].push(pool.splice(pool.indexOf(t), 1)[0]);
      groups._anchors.add(t);
    }

    // Healers are NOT seeded per group. In TBC healing is cross-group — a
    // healer's party placement is purely a buff decision (reference comp:
    // both melee groups have zero healers; surplus healers ride with the
    // tanks). groupScore()'s tank-group healer pull and each healer's own
    // buff synergies (Resto Shaman → casters for Mana Tide/WoA, Resto
    // Druid → tanks for ToL) drive their placement instead.
  },

  // ── PHASE 2: GREEDY MARGINAL-GAIN PLACEMENT ──────────────────
  // Each step places the (player, group) pair with the highest marginal
  // groupScore gain. Because groupScore measures what members RECEIVE, this
  // both attracts buffers to groups that want their buffs and attracts
  // beneficiaries to groups that already have the buffs.
  // opts.eligible restricts which pool members may be placed this pass;
  // opts.limit caps how many are placed. Both are used by the role-floor
  // pass; the general pass leaves them undefined.
  greedyPlace(pool, groups, max, mode, opts) {
    const eligible = (opts && opts.eligible) || (() => true);
    const limit = (opts && opts.limit != null) ? opts.limit : Infinity;
    let placed = 0;
    while (pool.length > 0 && placed < limit) {
      let bestGain = -Infinity;
      let bestPlayerIdx = -1;
      let bestGroupIdx = -1;

      for (let gi = 0; gi < groups.length; gi++) {
        if (!this.hasRoom(groups, gi, max)) continue;
        const base = this.groupScore(groups[gi], gi, groups, mode);
        for (let pi = 0; pi < pool.length; pi++) {
          if (!eligible(pool[pi])) continue;
          groups[gi].push(pool[pi]);
          const gain = this.groupScore(groups[gi], gi, groups, mode) - base;
          groups[gi].pop();
          if (gain > bestGain) {
            bestGain = gain;
            bestPlayerIdx = pi;
            bestGroupIdx = gi;
          }
        }
      }

      // No group has space (or no eligible player left) — stop placing
      if (bestGroupIdx < 0) break;

      groups[bestGroupIdx].push(pool.splice(bestPlayerIdx, 1)[0]);
      placed++;
    }
  },

  // ── SCORING ──────────────────────────────────────────────────
  // A comp-template lock (backlog #1) pins a player absolutely, in any group.
  // Otherwise, only the seeded anchor tank(s) are pinned to the healer/tank
  // group — any other tank that drifts in during placement is a regular
  // member the refinement phases may move out again (a Feral tank belongs
  // with melee).
  isPinned(player, gi, groups) {
    if (player.locked) return true;
    if (groups._frozen && groups._frozen.has(player)) return true;
    if (player.role !== 'tank' || !this.isTankGroup(gi, groups)) return false;
    return groups._anchors ? groups._anchors.has(player) : true;
  },

  // Open seat in group gi: below the raid's party size and, for a group
  // frozen around an open request, below its reserved size.
  hasRoom(groups, gi, max) {
    return groups[gi].length < (groups._cap ? groups._cap[gi] : max);
  },

  isTankGroup(gi, groups) {
    const ids = groups._roleIdentities;
    if (!ids) return gi === 0;
    const t = ids.indexOf('tank');
    return t >= 0 ? gi === t : gi === 0;
  },

  // Buffs the group actually gets: passives deduped, one totem per element
  // per shaman (chosen by group value — models totem assignments/twisting),
  // one distinct aura per paladin (best available by group value). The scorer
  // only needs the ids; getGroupBuffs shows the same resolution with sources.
  resolveGroupBuffs(group, valueFn) {
    return new Set(this.resolveBuffSources(group, valueFn).keys());
  },

  // The resolution behind resolveGroupBuffs, with source tracking: a Map of
  // buffId -> the player providing it (the first to provide it, for passives).
  // `opts` is display-only: { overrideFor(player, slot) -> buffId|undefined }
  // pins a shaman's air/fire/water/earth totem or a paladin's 'aura' to a manual
  // choice (resolved first, so no auto pick duplicates it),
  // `overridden` collects the ids that came from such a choice, and
  // `preferSpecAura` lets a paladin's own aura (Retribution: Sanctity) win a tie
  // between equally valued auras. The scorer passes none, so its choices (and
  // every optimizer outcome) stay exactly as they were.
  resolveBuffSources(group, valueFn, opts) {
    const rules = activeRules();
    const shouts = rules.shouts || [];
    const overrideFor = opts && opts.overrideFor;
    const sources = new Map();
    const usedAuras = new Set();
    const pinned = new Map(); // player -> Set of slots fixed by an override
    if (overrideFor) {
      for (const p of group) {
        const slots = p.class === 'SHAMAN' ? ['air', 'fire', 'water', 'earth'] : p.class === 'PALADIN' ? ['aura'] : [];
        for (const slot of slots) {
          const id = overrideFor(p, slot);
          if (!id) continue;
          if (!pinned.has(p)) pinned.set(p, new Set());
          pinned.get(p).add(slot);
          if (slot === 'aura') usedAuras.add(id);
          if (sources.has(id)) continue;
          sources.set(id, p);
          if (opts.overridden) opts.overridden.add(id);
        }
      }
    }
    for (const p of group) {
      const fixed = pinned.get(p);
      if (p.class === 'SHAMAN') {
        const byElement = {};
        for (const [id, buff] of Object.entries(Config.Buffs)) {
          if (buff.sourceClass !== 'SHAMAN') continue;
          if (buff.sourceSpec && buff.sourceSpec !== p.spec) continue;
          const el = rules.totemElements[id];
          // Mana Tide is a short cooldown dropped over Mana Spring, not a
          // standing totem: the same shaman provides both. Scoring it as the
          // water slot made a second Resto Shaman look like it "unlocked"
          // Mana Spring, so two piled into the tank group.
          if (el && !COOLDOWN_TOTEMS.has(id)) (byElement[el] = byElement[el] || []).push(id);
          else if (!sources.has(id)) sources.set(id, p); // shaman passives (e.g. Unleashed Rage)
        }
        for (const el of Object.keys(byElement)) {
          if (fixed && fixed.has(el)) continue;
          let best = null, bestV = 0;
          for (const id of byElement[el]) {
            if (sources.has(id)) continue; // another shaman already provides it
            const v = valueFn(id);
            if (v > bestV) { bestV = v; best = id; }
          }
          if (best) sources.set(best, p);
        }
      } else if (p.class === 'PALADIN') {
        if (fixed) continue;
        const specPick = opts && opts.preferSpecAura ? (rules.rules.specAura || {})[p.spec] : null;
        const open = paladinAurasFor(p).filter(id => !usedAuras.has(id));
        let best = null, bestV = -1;
        for (const id of open) {
          const v = valueFn(id);
          if (v > bestV || (v === bestV && id === specPick)) { bestV = v; best = id; }
        }
        if (best) { usedAuras.add(best); if (!sources.has(best)) sources.set(best, p); }
      } else {
        for (const [id, buff] of Object.entries(Config.Buffs)) {
          if (buff.sourceClass !== p.class) continue;
          if (buff.sourceSpec && buff.sourceSpec !== p.spec) continue;
          if (rules.totemElements[id] || rules.paladinAuras[id] || shouts.includes(id)) continue;
          if (!sources.has(id)) sources.set(id, p);
        }
        // One shout per warrior: the best-valued one nobody else in the group already
        // casts (a tie, e.g. in a caster group, keeps the first listed - Battle Shout).
        if (p.class === 'WARRIOR') {
          let best = null, bestV = -1;
          for (const id of shouts) {
            if (sources.has(id) || !Config.Buffs[id]) continue;
            const v = valueFn(id);
            if (v > bestV) { bestV = v; best = id; }
          }
          if (best) sources.set(best, p);
        }
      }
    }
    // Exclusive buff sets (Forever: Leader of the Pack / Moonkin Aura share
    // one crit-aura slot) — keep only whichever member is worth more to this
    // group, so a group with both a Feral and a Balance druid scores exactly
    // one of them instead of double-counting.
    for (const set of (rules.rules && rules.rules.exclusiveBuffs) || []) {
      const present = set.filter(id => sources.has(id));
      if (present.length < 2) continue;
      let best = present[0], bestV = valueFn(best);
      for (const id of present.slice(1)) {
        const v = valueFn(id);
        if (v > bestV) { bestV = v; best = id; }
      }
      for (const id of present) if (id !== best) sources.delete(id);
    }
    return sources;
  },

  // The value function behind every buff decision for a group: what one buff
  // is worth to THIS group in the given mode. groupScore sums it over the
  // buffs resolveGroupBuffs credits; getGroupBuffs resolves the displayed
  // buffs with the same function so display, explanations and scoring agree.
  buffValueFn(group, gi, groups, mode) {
    const cfg = MODE_CONFIG[mode] || MODE_CONFIG.max_dps;
    const rules = activeRules();
    const roleIdentity = (groups._roleIdentities && groups._roleIdentities[gi]) || 'melee_dps';
    const isTank = this.isTankGroup(gi, groups);
    const healerCount = group.reduce((n, p) => n + (p.role === 'healer' ? 1 : 0), 0);
    const tanks = group.filter(p => p.role === 'tank');

    // Value of one buff to this group = summed received DPS value, plus
    // mitigation + healer-sustain value when it reaches the tank group.
    // Mitigation counts for a tank wherever they sit — an off-tank in a
    // melee group still takes hits, so Devotion/GoA/SoE reaching them matter.
    // Healer-sustain value is only meaningful in the healer/tank group, and
    // it is a healing-structure concern (keeping the tank healers casting),
    // not a mitigation one — so it scales with the structure weight. This is
    // what keeps a lone Resto Shaman with the tank healers instead of chasing
    // Mana Tide value in a mage group.
    return (id) => {
      let v = 0;
      for (const m of group) v += dpsValueFor(id, m) * cfg.dps;
      for (const t of tanks) v += mitValueFor(id, t) * cfg.mit;
      if (isTank && rules.sustainValue[id]) v += rules.sustainValue[id] * Math.min(healerCount, 2) * cfg.structure;
      // Windfury-over-other-air-totem convention (Classic/Forever only — see
      // rules.meleeGroupWindfuryBias, unset/false for TBC so this is a no-op
      // there). A shaman's per-element totem choice (resolveGroupBuffs) picks
      // whichever totem scores highest via THIS function; without a
      // structural push, a melee group whose only shaman rides with several
      // hunters can have its Windfury outbid by Grace of Air on raw DPS_VALUE
      // (hunters get more from GoA than Ret/melee gets from WF) even though
      // the melee DPS convention (any shaman drops WF for melee — see
      // tasks/lessons.md 2026-08-19) says the group's melee should get it
      // regardless. Scaled per actual melee_dps member so an empty or
      // hunter-only "melee" group doesn't invent a preference it has no one
      // to give it to.
      if (id === 'WINDFURY' && rules.rules.meleeGroupWindfuryBias && roleIdentity === 'melee_dps') {
        const meleeCount = group.reduce((n, p) => n + (p.role === 'melee_dps' && p.class !== 'SHAMAN' ? 1 : 0), 0);
        if (meleeCount > 0) v += rules.rules.meleeGroupWindfuryBias * meleeCount * cfg.structure;
      }
      return v;
    };
  },

  // The single objective all phases share. Higher = better group.
  groupScore(group, gi, groups, mode) {
    const cfg = MODE_CONFIG[mode] || MODE_CONFIG.max_dps;
    const rules = activeRules();
    const roleIdentity = (groups._roleIdentities && groups._roleIdentities[gi]) || 'melee_dps';
    const isTank = this.isTankGroup(gi, groups);
    const healerCount = group.reduce((n, p) => n + (p.role === 'healer' ? 1 : 0), 0);
    const tanks = group.filter(p => p.role === 'tank');

    const buffValue = this.buffValueFn(group, gi, groups, mode);

    let score = 0;
    for (const id of this.resolveGroupBuffs(group, buffValue)) score += buffValue(id);

    // Ferocious Inspiration stacks multiplicatively per BM Hunter (1.03^n) —
    // the only party buff that does. resolveGroupBuffs dedupes it like any
    // passive, so credit each additional BM hunter's copy here.
    const bmCount = group.reduce((n, p) => n + (p.class === 'HUNTER' && p.spec === 'Beast Mastery' ? 1 : 0), 0);
    if (rules.rules.ferociousInspiration && bmCount > 1) score += (bmCount - 1) * buffValue('FEROCIOUS_INSP') * 0.5;

    // Reference comp: one hunter per melee group. A Survival Hunter adds no party
    // buff (rules.hunterSpread), so pairing it with another hunter is a duplicate
    // that spreads out; a second Beast Mastery hunter is exempt (its FI stacks, above).
    if (rules.rules.hunterSpread) {
      const hunterCount = group.reduce((n, p) => n + (p.class === 'HUNTER' ? 1 : 0), 0);
      if (hunterCount > 1) score -= rules.rules.hunterSpread * cfg.structure * group.reduce((n, p) => n + (p.class === 'HUNTER' && p.spec === 'Survival' ? 1 : 0), 0);
    }

    // Structural placement rules (from the user's reference TBC comp):
    //  - Healers gravitate to the tank group. Healing is cross-group in TBC,
    //    so a healer in a DPS group displaces a DPS from a buffed slot for no
    //    healing gain — unless the healer's own buffs earn the spot (a Resto
    //    Shaman's Mana Tide/WoA in a caster group easily outbids this pull).
    //  - DPS guests in the tank group pay a penalty that only genuine
    //    synergy can override (an Enh Shaman + Fury Warrior Windfury pack
    //    riding with the tanks is fine; a lone Rogue receiving nothing
    //    there is not).
    if (isTank) {
      // Three healers is the MT group's core; a 4th is allowed but only
      // lightly pulled, so a Holy Priest who'd get Vampiric Touch in the
      // Shadow Priest's group goes there instead of padding the MT group.
      score += (Math.min(healerCount, 3) * 10 + (healerCount >= 4 ? 3 : 0)) * cfg.structure;
      // The MT group holds up to four healers (the MT plus a healer party).
      // A fifth only stays for the mana totems it receives; past four, they
      // move on.
      score -= Math.max(0, healerCount - 4) * 15 * cfg.structure;
      // The reference comp seats one overflow Affliction Warlock with the healers (it
      // needs none of the party buffs a DPS group offers) once the three-healer core is
      // there, so that seat is not a penalized guest. Without this the guest penalty
      // handed the seat to a 4th healer and moved the Warlock in with the mages.
      let overflowSeatOpen = healerCount >= 3;
      for (const p of group) {
        if (p.role !== 'melee_dps' && p.role !== 'caster_dps') continue;
        if (overflowSeatOpen && rules.rules.healerGroupDps && rules.rules.healerGroupDps(p)) {
          overflowSeatOpen = false;
          continue;
        }
        score -= 12 * cfg.structure;
      }
    }

    // Windfury coverage — a melee group without any shaman is a melee group
    // without Windfury. Each melee DPS there pays roughly what a mid-value WF
    // would have given them, so a Resto or Ele shaman is drawn to the melee
    // group that has nobody to drop it (reference comp rule 1: any shaman
    // drops WF for melee), and melee spread across shaman-covered groups
    // instead of piling into the one Enhancement group. Skipped for a
    // faction-locked Alliance roster, which can never field a shaman at all.
    const canHaveShaman = !rules.rules.factionLock || Faction.current() !== 'alliance';
    if (rules.rules.meleeWantsWindfury && canHaveShaman && roleIdentity === 'melee_dps' && !group.some(p => p.class === 'SHAMAN')) {
      for (const p of group) {
        if (p.role === 'melee_dps') score -= 6 * dpsWeightFor(p) * cfg.structure;
      }
    }

    // Role cohesion — DPS members clustered with their group's identity.
    // Ranged DPS (hunters) count as full members of melee groups: they
    // bring FI/TSA to the physical party and receive LotP/GoA there
    // (reference comp rule: BM/Surv hunters ride in the melee groups).
    if (roleIdentity !== 'tank') {
      for (const p of group) {
        if (p.role === 'healer' || p.role === 'tank') continue;
        const matches = p.role === roleIdentity || (roleIdentity === 'melee_dps' && p.role === 'ranged_dps');
        if (matches) score += 12 * cfg.cohesion;
        // Hunters ride with the physical groups. In a caster group they are
        // neutral rather than "compatible": Unleashed Rage (melee-only) no
        // longer holds them in a melee group, and without this a leftover
        // hunter drifted in beside the Ele Shaman and mages.
        else if (p.role === 'ranged_dps' && roleIdentity === 'caster_dps') continue;
        else if (ROLE_COMPAT[p.role] && ROLE_COMPAT[p.role].includes(roleIdentity)) score += 6 * cfg.cohesion;
        else score -= 12 * cfg.cohesion;
      }
      // A tank in a caster group is off-role there: without this, Blood Pact's
      // mitigation value alone pulled spare tanks into the warlock group. A
      // structural rule, not a cohesion preference, so it holds in every mode,
      // and it outweighs the tank group's pull on a 4th healer: that healer
      // trades out to the casters instead.
      if (roleIdentity === 'caster_dps') score -= 25 * cfg.structure * tanks.length;
    }

    // Duplicate providers (rules.stackPenalty): the second shaman/Ret/Feral in
    // a group adds only leftovers, so the stack must outbid a group that has
    // none. Triangular, so a third copy costs more than the second.
    for (const { match, weight } of rules.rules.stackPenalty || []) {
      const n = group.reduce((c, p) => c + (match(p) ? 1 : 0), 0);
      if (n > 1) score -= weight * (n * (n - 1) / 2) * cfg.structure;
    }

    // Spreading pressure — convex penalty so the marginal cost of joining a
    // fuller group is higher, nudging placement toward emptier groups when
    // synergy gains are comparable.
    score -= 0.8 * group.length * group.length * cfg.structure;

    return score;
  },

  // ── PHASE 3: SWAP REFINEMENT ─────────────────────────────────
  // Hill-climbs pairwise swaps against the same groupScore() objective the
  // greedy phase used, so refinement can never "improve" toward a different
  // goal than placement optimized for.
  refineSwaps(groups, max, mode) {
    const SWAP_THRESHOLD = 0.5;
    for (let iter = 0; iter < 4; iter++) {
      let improved = false;
      for (let gi = 0; gi < groups.length; gi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          for (let pi = 0; pi < groups[gi].length; pi++) {
            // Never swap the anchor tank out of the tank-identity group
            if (this.isPinned(groups[gi][pi], gi, groups)) continue;
            for (let pj = 0; pj < groups[gj].length; pj++) {
              if (this.isPinned(groups[gj][pj], gj, groups)) continue;
              const currentScore = this.groupScore(groups[gi], gi, groups, mode)
                                 + this.groupScore(groups[gj], gj, groups, mode);

              // Tentatively swap
              const tmp = groups[gi][pi];
              groups[gi][pi] = groups[gj][pj];
              groups[gj][pj] = tmp;

              const newScore = this.groupScore(groups[gi], gi, groups, mode)
                             + this.groupScore(groups[gj], gj, groups, mode);

              if (newScore > currentScore + SWAP_THRESHOLD) {
                improved = true;
              } else {
                // Revert swap
                groups[gj][pj] = groups[gi][pi];
                groups[gi][pi] = tmp;
              }
            }
          }
        }
      }
      if (!improved) break;
    }
  },

  // ── PHASE 3d: BENCH REFINEMENT ───────────────────────────────
  // For each overflow player on the bench, try them in place of every seated
  // player and take the trade that raises the raid total the most. Seeded
  // anchor tanks stay put, and a trade never drops tanks or healers below
  // the raid's floors. The displaced player joins the overflow list so they
  // can be reconsidered. Returns true when at least one trade was made.
  refineBench(groups, overflow, raidSize, mode) {
    const BENCH_THRESHOLD = 0.5;
    const floors = this.floorsFor(raidSize);
    const total = () => groups.reduce((sum, g, gi) => sum + this.groupScore(g, gi, groups, mode), 0);
    const roleCount = (role) => groups.reduce((n, g) => n + g.filter(p => p.role === role).length, 0);
    let traded = false;

    for (let round = 0; round < 10; round++) {
      let best = null;
      const base = total();
      for (let bi = 0; bi < overflow.length; bi++) {
        const incoming = overflow[bi];
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          for (let si = 0; si < g.length; si++) {
            const out = g[si];
            if (this.isPinned(out, gi, groups)) continue;
            if (out.role !== incoming.role && (out.role === 'tank' || out.role === 'healer')) {
              if (roleCount(out.role) - 1 < (floors[out.role] || 0)) continue;
            }
            g[si] = incoming;
            const gain = total() - base;
            g[si] = out;
            if (gain > BENCH_THRESHOLD && (!best || gain > best.gain)) best = { bi, gi, si, gain };
          }
        }
      }
      if (!best) break;
      const g = groups[best.gi];
      const incoming = overflow[best.bi];
      const out = g[best.si];
      g[best.si] = incoming;
      overflow[best.bi] = out;
      out.groupNumber = 0;
      traded = true;
    }
    return traded;
  },

  // ── PHASE 3c: 2-FOR-2 EXCHANGES ──────────────────────────────
  // Trades two players from one group for two from another. Catches
  // rebalances a single swap can't reach because each half looks worse on
  // its own (e.g. Ele Shaman out to the warlocks AND a Holy Priest in with
  // the Shadow Priest). Only the two groups involved change, so the delta
  // is just their two scores. Returns true if anything changed.
  refinePairExchanges(groups, mode) {
    const THRESHOLD = 0.5;
    let changedAny = false;
    for (let iter = 0; iter < 10; iter++) {
      let best = null, bestGain = THRESHOLD;
      for (let gi = 0; gi < groups.length; gi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          const A = groups[gi], B = groups[gj];
          if (A.length < 2 || B.length < 2) continue;
          const before = this.groupScore(A, gi, groups, mode) + this.groupScore(B, gj, groups, mode);
          for (let a1 = 0; a1 < A.length; a1++) {
            if (this.isPinned(A[a1], gi, groups)) continue;
            for (let a2 = a1 + 1; a2 < A.length; a2++) {
              if (this.isPinned(A[a2], gi, groups)) continue;
              for (let b1 = 0; b1 < B.length; b1++) {
                if (this.isPinned(B[b1], gj, groups)) continue;
                for (let b2 = b1 + 1; b2 < B.length; b2++) {
                  if (this.isPinned(B[b2], gj, groups)) continue;
                  const pa1 = A[a1], pa2 = A[a2], pb1 = B[b1], pb2 = B[b2];
                  A[a1] = pb1; A[a2] = pb2; B[b1] = pa1; B[b2] = pa2;
                  const gain = this.groupScore(A, gi, groups, mode) + this.groupScore(B, gj, groups, mode) - before;
                  A[a1] = pa1; A[a2] = pa2; B[b1] = pb1; B[b2] = pb2;
                  if (gain > bestGain) { bestGain = gain; best = { gi, gj, a1, a2, b1, b2 }; }
                }
              }
            }
          }
        }
      }
      if (!best) break;
      const { gi, gj, a1, a2, b1, b2 } = best;
      const A = groups[gi], B = groups[gj];
      const pa1 = A[a1], pa2 = A[a2];
      A[a1] = B[b1]; A[a2] = B[b2]; B[b1] = pa1; B[b2] = pa2;
      changedAny = true;
    }
    return changedAny;
  },

  // ── PHASE 3a: MOVE REFINEMENT ────────────────────────────────
  // Hill-climbs single-player moves into open slots against the total of
  // groupScore() over all groups. Returns true if anything moved.
  refineMoves(groups, max, mode) {
    const total = () => {
      let s = 0;
      for (let gi = 0; gi < groups.length; gi++) s += this.groupScore(groups[gi], gi, groups, mode);
      return s;
    };
    let movedAny = false;
    for (let iter = 0; iter < 25; iter++) {
      let bestGain = 0.5, bestGi = -1, bestPi = -1, bestGj = -1;
      const before = total();
      for (let gi = 0; gi < groups.length; gi++) {
        for (let pi = 0; pi < groups[gi].length; pi++) {
          const p = groups[gi][pi];
          if (this.isPinned(p, gi, groups)) continue;
          for (let gj = 0; gj < groups.length; gj++) {
            if (gj === gi || !this.hasRoom(groups, gj, max)) continue;
            groups[gi].splice(pi, 1);
            groups[gj].push(p);
            const gain = total() - before;
            groups[gj].pop();
            groups[gi].splice(pi, 0, p);
            if (gain > bestGain) { bestGain = gain; bestGi = gi; bestPi = pi; bestGj = gj; }
          }
        }
      }
      if (bestGi < 0) break;
      groups[bestGj].push(groups[bestGi].splice(bestPi, 1)[0]);
      movedAny = true;
    }
    return movedAny;
  },

  // ── PHASE 3b: TANK-GROUP GUEST OPTIMIZATION ──────────────────
  // For each DPS guest in the tank group, try swapping with every non-tank,
  // non-sole-healer member of every other group; take any strictly positive
  // improvement. Repeats until stable (bounded).
  optimizeTankGuests(groups, mode) {
    const ids = groups._roleIdentities;
    if (!ids) return;
    const tIdx = ids.indexOf('tank');
    if (tIdx < 0) return;
    for (let iter = 0; iter < 4; iter++) {
      let improved = false;
      for (let pi = 0; pi < groups[tIdx].length; pi++) {
        const guest = groups[tIdx][pi];
        if (guest.role === 'healer' || this.isPinned(guest, tIdx, groups)) continue;
        let bestGain = 0.5, bestGj = -1, bestPj = -1;
        for (let gj = 0; gj < groups.length; gj++) {
          if (gj === tIdx) continue;
          for (let pj = 0; pj < groups[gj].length; pj++) {
            const q = groups[gj][pj];
            if (q.role === 'tank' || this.isPinned(q, gj, groups)) continue;
            const before = this.groupScore(groups[tIdx], tIdx, groups, mode)
                         + this.groupScore(groups[gj], gj, groups, mode);
            groups[tIdx][pi] = q;
            groups[gj][pj] = guest;
            const after = this.groupScore(groups[tIdx], tIdx, groups, mode)
                        + this.groupScore(groups[gj], gj, groups, mode);
            groups[gj][pj] = q;
            groups[tIdx][pi] = guest;
            const gain = after - before;
            if (gain > bestGain) { bestGain = gain; bestGj = gj; bestPj = pj; }
          }
        }
        if (bestGj >= 0) {
          const q = groups[bestGj][bestPj];
          groups[bestGj][bestPj] = guest;
          groups[tIdx][pi] = q;
          improved = true;
        }
      }
      if (!improved) break;
    }
  },

  // Shared by deIsolate and spreadProviders' wouldIsolate() guard so the two
  // phases can never disagree about what "isolated" means — a role belongs to
  // the 'melee' family (tank/melee_dps/ranged_dps), the 'caster' family
  // (caster_dps/healer), or neither (null).
  roleFamily(role) {
    return (role === 'melee_dps' || role === 'tank' || role === 'ranged_dps') ? 'melee' :
      (role === 'caster_dps' || role === 'healer') ? 'caster' : null;
  },

  // Would removing the player at `removeIdx` from `group` (optionally
  // replacing them with `insertPlayer`, for a swap) leave some OTHER
  // melee_dps/caster_dps member without a same-family peer? Same isolation
  // definition deIsolate uses, run as a lookahead before spreadProviders
  // commits to a source group — see spreadProviders' Phase 5 comment for why
  // this guard exists: nothing runs after Phase 5 to undo a fresh isolation.
  wouldIsolate(group, removeIdx, insertPlayer) {
    const next = group.filter((_, i) => i !== removeIdx);
    if (insertPlayer) next.push(insertPlayer);
    return next.some((x, xi) => {
      if (x.role !== 'melee_dps' && x.role !== 'caster_dps') return false;
      const fam = this.roleFamily(x.role);
      return !next.some((y, yi) => yi !== xi && this.roleFamily(y.role) === fam);
    });
  },

  // ── PHASE 4: DE-ISOLATION ─────────────────────────────────────
  // Finds any melee_dps/caster_dps player with zero role-compatible peers in
  // their own group and fixes it with whichever swap or open-seat move costs
  // the least groupScore. Candidates that don't strand someone else win
  // first; among those, the score decides — an unscored pick used to trade a
  // caster group's only Resto Shaman for a lone mage, wrecking both groups.
  deIsolate(groups, mode, max = 5) {
    const family = role => this.roleFamily(role);
    const score = (gi) => this.groupScore(groups[gi], gi, groups, mode);
    const isolated = (group) => group.some((x, xi) =>
      (x.role === 'melee_dps' || x.role === 'caster_dps') &&
      !group.some((y, yi) => yi !== xi && family(y.role) === family(x.role)));
    // Apply a change, measure it, undo it. Returns { clean, delta }.
    const trial = (gi, gj, apply, undo) => {
      const before = score(gi) + score(gj);
      apply();
      const res = { clean: !isolated(groups[gi]) && !isolated(groups[gj]), delta: score(gi) + score(gj) - before };
      undo();
      return res;
    };
    const better = (a, b) => !b || (a.clean !== b.clean ? a.clean : a.delta > b.delta);

    // A single pass can fix one isolated player by pulling their swap
    // partner out of ITS group — which can leave a different player newly
    // isolated (or not notice one uncovered earlier in the same pass, since
    // groups already scanned aren't revisited). Iterate to a fixed point,
    // same as refineSwaps, capped so a pathological roster can't loop forever.
    for (let iter = 0; iter < 6; iter++) {
      let swapped = false;

      for (let gi = 0; gi < groups.length; gi++) {
        for (let pi = 0; pi < groups[gi].length; pi++) {
          const p = groups[gi][pi];
          if (p.role !== 'melee_dps' && p.role !== 'caster_dps') continue;
          const pFam = family(p.role);
          const hasPeer = groups[gi].some((x, xi) => xi !== pi && family(x.role) === pFam);
          if (hasPeer) continue;

          if (this.isPinned(p, gi, groups)) continue;
          let best = null;
          const consider = (cand) => { if (better(cand, best)) best = cand; };
          for (let gj = 0; gj < groups.length; gj++) {
            if (gj === gi) continue;
            const G = groups[gi], H = groups[gj];

            // Move p into an open seat beside a same-family peer.
            if (this.hasRoom(groups, gj, max) && H.some(x => family(x.role) === pFam)) {
              const r = trial(gi, gj, () => { G.splice(pi, 1); H.push(p); }, () => { H.pop(); G.splice(pi, 0, p); });
              consider({ ...r, apply: () => { G.splice(pi, 1); H.push(p); } });
            }

            for (let pj = 0; pj < H.length; pj++) {
              const q = H[pj];
              // Invariant outranks fixing DPS isolation: never pull a tank
              // out of the tank-identity group.
              if (this.isPinned(q, gj, groups)) continue;

              // Move a same-family peer q into p's open seat.
              if (this.hasRoom(groups, gi, max) && family(q.role) === pFam) {
                const r = trial(gi, gj, () => { H.splice(pj, 1); G.push(q); }, () => { G.pop(); H.splice(pj, 0, q); });
                consider({ ...r, apply: () => { H.splice(pj, 1); G.push(q); } });
              }

              // Swap p with q: p only needs gj to keep OTHER pFam members
              // once q leaves — q's own family is irrelevant to fixing p.
              const pHasPeerAfter = H.some((x, xj) => xj !== pj && family(x.role) === pFam);
              if (!pHasPeerAfter) continue;
              const swap = () => { G[pi] = q; H[pj] = p; };
              const r = trial(gi, gj, swap, () => { G[pi] = p; H[pj] = q; });
              consider({ ...r, apply: swap });
            }
          }

          if (best) {
            best.apply();
            swapped = true;
          }
        }
      }

      if (!swapped) break;
    }
  },
};

// ── OPEN SLOT SUGGESTIONS ───────────────────────────────────────
// When fewer players are seated than the raid holds, Optimize ends by giving
// every empty seat an Open preferred slot for the class/spec that adds the
// most there. Missing tanks and healers (Optimizer.floorsFor) come first;
// every other seat goes to the DPS spec with the best marginal groupScore
// under the current mode, one seat at a time so each pick sees the last.
// Suggestions carry `auto: true`: replaced on every Optimize, never freeze
// their group (PreferredSlots.manual), and become manual once edited.
const OpenSlots = {
  // Classes the raid can bring: under a faction lock (Classic) no Paladin for
  // Horde or Shaman for Alliance, same as the Random roster's list.
  candidates() {
    const faction = activeRules().rules?.factionLock ? Faction.current() : null;
    return Object.values(RandomRoster._buildSpecsByRole(faction)).flat();
  },

  // Raid-level worth of a suggested spec on top of its party buffs: it covers
  // a raid debuff or utility nobody brings yet (Expose Weakness, Power
  // Infusion, ...), and it costs a little for every copy of its spec already
  // in the raid and for piling onto a class the raid already has plenty of.
  // groupScore alone only sees party buffs, so a Resto Shaman (Windfury for
  // one Arms Warrior) beat a Disc Priest and a second Ret beat a Survival Hunter.
  // A raid debuff is worth what a party buff of the same value would be to
  // every raid member it actually helps. `tier` is on the DPS_VALUE scale
  // (Trueshot Aura's 125 AP = 3-4 per player), `who` names the players it
  // helps: 'physical' (melee/hunters), 'caster', a spell school, or 'tank'
  // (defensive: tier per tank, mitigation-weighted). Unlisted debuffs (other
  // rulesets) count tier 2 for every DPS. Expose Weakness (~225 AP to every
  // physical attacker) is why a Survival Hunter beats a Marksmanship one
  // whose Trueshot Aura only reaches its own party.
  DEBUFF_VALUE: {
    EXPOSE_WEAKNESS: { tier: 6, who: 'physical' }, SUNDER_ARMOR: { tier: 6, who: 'physical' },
    EXPOSE_ARMOR: { tier: 6, who: 'physical' }, BLOOD_FRENZY: { tier: 4, who: 'physical' },
    JUDGEMENT_CRUSADER: { tier: 3, who: 'physical' }, FAERIE_FIRE_BALANCE: { tier: 3, who: 'physical' },
    FAERIE_FIRE_FERAL: { tier: 2, who: 'physical' }, CURSE_RECKLESSNESS: { tier: 3, who: 'physical' },
    HUNTERS_MARK: { tier: 3, who: 'physical' }, MANGLE: { tier: 1, who: 'physical' }, HEMORRHAGE: { tier: 1, who: 'physical' },
    CURSE_ELEMENTS: { tier: 6, who: 'caster' }, MISERY: { tier: 4, who: 'caster' }, JUDGEMENT_WISDOM: { tier: 1, who: 'caster' },
    IMPROVED_SHADOW_BOLT: { tier: 6, who: 'shadow' }, SHADOW_WEAVING: { tier: 4, who: 'shadow' },
    IMPROVED_SCORCH: { tier: 6, who: 'fire' }, WINTERS_CHILL: { tier: 3, who: 'frost' }, STORMSTRIKE: { tier: 3, who: 'nature' },
    DEMORALIZING_SHOUT: { tier: 2, who: 'tank' }, DEMORALIZING_ROAR: { tier: 2, who: 'tank' },
    CURSE_WEAKNESS: { tier: 2, who: 'tank' }, THUNDER_CLAP: { tier: 2, who: 'tank' },
    SHADOW_EMBRACE: { tier: 1, who: 'tank' }, INSECT_SWARM: { tier: 1, who: 'tank' },
    SCORPID_STING: { tier: 1, who: 'tank' }, JUDGEMENT_LIGHT: { tier: 1, who: 'tank' },
  },
  // Who a school debuff helps: the specs that mostly cast that school.
  DEBUFF_SCHOOLS: {
    shadow: p => p.class === 'WARLOCK' || (p.class === 'PRIEST' && p.spec === 'Shadow'),
    fire: p => p.class === 'MAGE' && p.spec === 'Fire',
    frost: p => p.class === 'MAGE' && p.spec === 'Frost',
    nature: p => p.class === 'SHAMAN' && p.spec === 'Elemental' || (p.class === 'DRUID' && p.spec === 'Balance'),
  },
  UTILITY_BONUS: 6,
  SPEC_REPEAT: 6,
  CLASS_CROWD: 4,
  CLASS_CROWD_FREE: 5,
  // Debuffs any member of the source class can apply at a base rank, which a
  // spec improves (Improved Hunter's Mark). Once the base spell is covered the
  // improving spec still adds half, until one of that spec is in the raid.
  IMPROVED_DEBUFFS: { HUNTERS_MARK: 'Marksmanship' },
  _raidValue(candidate, raid, mode) {
    const cfg = MODE_CONFIG[mode] || MODE_CONFIG.max_dps;
    const withCandidate = raid.concat(candidate);
    const helps = {
      physical: p => p.role === 'melee_dps' || p.role === 'ranged_dps',
      caster: p => p.role === 'caster_dps',
      all: p => p.role !== 'tank' && p.role !== 'healer',
      ...this.DEBUFF_SCHOOLS,
    };
    const weightOf = (who) => who === 'tank'
      ? withCandidate.filter(p => p.role === 'tank').length * cfg.mit * 4
      : withCandidate.filter(helps[who] || helps.all).reduce((sum, p) => sum + dpsWeightFor(p), 0) * cfg.dps;
    let v = 0;
    const covered = getRaidDebuffCoverage([raid]);
    for (const [id, d] of Object.entries(Config.Debuffs || {})) {
      if (!canProvideBuff(d, candidate)) continue;
      // Covered by the base spell: only the improving spec, absent so far, still adds.
      const improvedBy = this.IMPROVED_DEBUFFS[id];
      const improvesOnly = covered.has(id) && improvedBy === candidate.spec && !raid.some(p => p.class === d.sourceClass && p.spec === improvedBy);
      if (covered.has(id) && !improvesOnly) continue;
      if (d.supersededBy && covered.has(d.supersededBy)) continue;
      if ((d.competesWith || []).some(other => covered.has(other))) continue;
      const { tier, who } = this.DEBUFF_VALUE[id] || { tier: 2, who: 'all' };
      const share = improvesOnly ? 0.5 : 1;
      v += tier * share * weightOf(who);
    }
    for (const u of Readiness.utilityCoverage([raid], [])) {
      if (u.covered) continue;
      if ((Config.Utilities[u.id].providers || []).some(prov => Readiness._providerMatches(prov, candidate))) v += this.UTILITY_BONUS;
    }
    v -= this.SPEC_REPEAT * raid.filter(p => p.class === candidate.class && p.spec === candidate.spec).length;
    v -= this.CLASS_CROWD * Math.max(0, raid.filter(p => p.class === candidate.class).length - this.CLASS_CROWD_FREE + 1);
    return v;
  },

  // Where a player (moved real player, or a suggestion) may sit without
  // breaking group conventions: the tank group takes healers, and tanks only
  // as suggestions (a real Feral tank stays with melee); spare tanks and
  // physical DPS go to melee groups; casters and healers to caster groups.
  _fits(member, identity, suggested) {
    if (identity === 'tank') return member.role === 'healer' || (member.role === 'tank' && suggested);
    if (identity === 'caster_dps') return member.role === 'caster_dps' || member.role === 'healer';
    return member.role === 'melee_dps' || member.role === 'ranged_dps' || member.role === 'tank';
  },

  // The specs to suggest for the raid's open seats outside groups frozen by
  // the leader's own requests: tank/healer floors first, then whatever adds
  // the most (party-buff gain in its group + _raidValue), one at a time so
  // each pick sees the last. A pick may go into a full group when moving one
  // seated player out to an empty seat costs the real raid less than the pick
  // gains there; that move is priced on real players only, so a suggestion
  // never takes Windfury from someone who has it for a player who may never
  // sign up. Returns picks as { class, spec, role, group, move }.
  choose() {
    if (!GameVersions[State.gameVersion].modeled) return [];
    const raid = Config.Raids[State.selectedRaid];
    if (!raid || !State.groups.length) return [];
    const max = RosterEdit.MAX_GROUP_SIZE;
    const mode = State.optimizerMode || 'max_dps';
    const frozen = State.groups.map((g, gi) => PreferredSlots.forGroup(gi).length > 0);
    const requests = State.preferredSlots.map(p => ({ ...p, role: RosterEdit.RoleForSpec(p.class, p.spec) }));
    const seats = State.groups.reduce((n, g, gi) => n + (frozen[gi] ? 0 : Math.max(0, max - g.length)), 0);
    let open = Math.min(seats, raid.size - State.groups.flat().length - requests.length);
    if (open <= 0) return [];

    const board = State.groups.map(g => [...g]);
    board._roleIdentities = State.groups._roleIdentities;
    board._anchors = State.groups._anchors;
    const score = (b, gi, group = b[gi]) => Optimizer.groupScore(group, gi, b, mode);
    const fits = (m, gj) => this._fits(m, (board._roleIdentities || [])[gj], !board.flat().includes(m));
    // Cheapest way to free a seat in full group gi: move one real, unpinned
    // player to a non-frozen group with room. cost = real score lost.
    const roomIn = (gi) => {
      let best = null;
      for (const m of board[gi]) {
        if (m.openSlot || Optimizer.isPinned(m, gi, board)) continue;
        const without = board[gi].filter(p => p !== m);
        for (let gj = 0; gj < board.length; gj++) {
          if (gj === gi || frozen[gj] || board[gj].length >= max || !fits(m, gj)) continue;
          const cost = score(board, gi) + score(board, gj) - score(board, gi, without) - score(board, gj, [...board[gj], m]);
          if (!best || cost < best.cost) best = { m, gj, without, cost };
        }
      }
      return best;
    };
    const floors = Optimizer.floorsFor(raid.size);
    const everyone = () => board.flat().concat(requests);
    const roleCount = (role) => everyone().filter(p => p.role === role).length;
    const candidates = this.candidates();
    const picks = [];
    while (open > 0) {
      const role = roleCount('tank') < floors.tank ? 'tank'
        : roleCount('healer') < floors.healer ? 'healer' : null;
      const pool = candidates.filter(c => role ? c.role === role : (c.role !== 'tank' && c.role !== 'healer'));
      const rooms = board.map((g, gi) => (!frozen[gi] && g.length >= max) ? roomIn(gi) : null);
      let best = null;
      for (const candidate of pool) {
        const raidValue = this._raidValue(candidate, everyone(), mode);
        for (let gi = 0; gi < board.length; gi++) {
          if (frozen[gi] || !fits(candidate, gi)) continue;
          const room = board[gi].length >= max ? rooms[gi] : null;
          if (board[gi].length >= max && !room) continue;
          const base = room ? room.without : board[gi];
          const gain = score(board, gi, [...base, candidate]) - score(board, gi, base) - (room ? room.cost : 0) + raidValue;
          if (!best || gain > best.gain) best = { candidate, gi, room, gain };
        }
      }
      if (!best) break;
      const { candidate, gi, room } = best;
      if (room) {
        board[gi].splice(board[gi].indexOf(room.m), 1);
        board[room.gj].push(room.m);
      }
      board[gi].push({ ...candidate, uid: 'open-' + picks.length, name: '', openSlot: true });
      picks.push({ class: candidate.class, spec: candidate.spec, role: candidate.role, group: gi,
        move: room ? { player: room.m, to: room.gj } : null });
      open--;
    }
    return picks;
  },

  // Applies choose()'s picks: each becomes an auto Open slot in its group,
  // after moving out the seated player it made room with.
  seat(picks) {
    for (const pick of picks) {
      if (pick.move) {
        const { player, to } = pick.move;
        const from = State.groups.findIndex(g => g.includes(player));
        if (from >= 0) State.groups[from].splice(State.groups[from].indexOf(player), 1);
        State.groups[to].push(player);
        player.groupNumber = to + 1;
      }
      State.preferredSlots.push({ group: pick.group, class: pick.class, spec: pick.spec, auto: true });
    }
    this._settle();
    State.roster = State.groups.flat();
  },

  // A real player may trade seats with a suggested slot in another group when
  // that scores better, so a suggestion never keeps a seat a real player
  // wants more (the Holy Priest takes the Shadow Priest's group for Vampiric
  // Touch; the suggested Disc moves to the MT group instead).
  _settle() {
    const mode = State.optimizerMode || 'max_dps';
    const groups = State.groups;
    const ids = groups._roleIdentities || [];
    const frozen = groups.map((g, gi) => PreferredSlots.manual().some(p => p.group === gi));
    const autos = State.preferredSlots.filter(p => p.auto);
    const virtual = (slot) => ({ class: slot.class, spec: slot.spec, role: RosterEdit.RoleForSpec(slot.class, slot.spec), uid: 'open', name: '' });
    const board = () => {
      const b = groups.map((g, gi) => [...g, ...autos.filter(a => a.group === gi).map(virtual)]);
      b._roleIdentities = ids;
      b._anchors = groups._anchors;
      return b;
    };
    for (let iter = 0; iter < 8; iter++) {
      const b = board();
      const score = (gi, grp = b[gi]) => Optimizer.groupScore(grp, gi, b, mode);
      let best = null;
      for (const slot of autos) {
        const a = slot.group;
        const v = virtual(slot);
        for (let gb = 0; gb < groups.length; gb++) {
          if (gb === a || frozen[gb] || !this._fits(v, ids[gb], true)) continue;
          for (const p of groups[gb]) {
            if (Optimizer.isPinned(p, gb, groups) || !this._fits(p, ids[a], false)) continue;
            const withoutSlot = [...b[a]];
            withoutSlot.splice(withoutSlot.findIndex(x => x.uid === 'open' && x.class === v.class && x.spec === v.spec), 1);
            const delta = score(a, [...withoutSlot, p]) + score(gb, [...b[gb].filter(x => x !== p), v]) - score(a) - score(gb);
            if (delta > 0.5 && (!best || delta > best.delta)) best = { slot, p, gb, delta };
          }
        }
      }
      if (!best) break;
      const { slot, p, gb } = best;
      groups[gb].splice(groups[gb].indexOf(p), 1);
      groups[slot.group].push(p);
      p.groupNumber = slot.group + 1;
      slot.group = gb;
    }
  },

  // Fills seats still empty after Optimize's own suggestions (inside groups
  // frozen by the leader's requests) in place. Returns how many were added.
  fill() {
    if (!GameVersions[State.gameVersion].modeled) return 0;
    const raid = Config.Raids[State.selectedRaid];
    if (!raid || !State.groups.length) return 0;

    const max = RosterEdit.MAX_GROUP_SIZE;
    const mode = State.optimizerMode || 'max_dps';
    // Scratch board: seated players plus the leader's own requests, so the
    // suggestions build on what's already planned. Never touches State.groups.
    const board = State.groups.map((group, gi) => [
      ...group,
      ...PreferredSlots.forGroup(gi).map(p => ({ ...p, role: RosterEdit.RoleForSpec(p.class, p.spec), uid: 'open', name: '' })),
    ]);
    board._roleIdentities = State.groups._roleIdentities;
    let open = Math.min(raid.size, State.groups.length * max) - board.flat().length;
    if (open <= 0) return 0;

    const floors = Optimizer.floorsFor(raid.size);
    const roleCount = (role) => board.flat().filter(p => p.role === role).length;
    const candidates = this.candidates();
    const added = [];
    while (open > 0) {
      const role = roleCount('tank') < floors.tank ? 'tank'
        : roleCount('healer') < floors.healer ? 'healer' : null;
      const pool = candidates.filter(c => role ? c.role === role : (c.role !== 'tank' && c.role !== 'healer'));
      const choice = this._best(pool, board, mode, max);
      if (!choice) break;
      board[choice.gi].push({ ...choice.candidate, uid: 'open', name: '' });
      added.push({ group: choice.gi, class: choice.candidate.class, spec: choice.candidate.spec, auto: true });
      open--;
    }
    State.preferredSlots.push(...added);
    return added.length;
  },

  // The (spec, group) pair that raises its group's score the most. Ties keep
  // the first found (spec list order, then lowest group), so it's stable.
  _best(pool, board, mode, max) {
    let best = null;
    for (let gi = 0; gi < board.length; gi++) {
      if (board[gi].length >= max) continue;
      const before = Optimizer.groupScore(board[gi], gi, board, mode);
      for (const candidate of pool) {
        const gain = Optimizer.groupScore([...board[gi], candidate], gi, board, mode) - before
                   + this._raidValue(candidate, board.flat(), mode);
        if (!best || gain > best.gain) best = { candidate, gi, gain };
      }
    }
    return best;
  },
};

