/* ================================================================
   PARTY PLANNER WEB - rules data: Classic Era
   ----------------------------------------------------------------
   WoW Classic Era: party buffs and raid debuffs with their weights, the optimizer tuning numbers, raids and
   utilities. Faction-aware: Horde shamans, Alliance paladins.

   Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated
   once on 2026-10-11 from the then-live tables by tools/generate-rules-data.js (now a guarded record of the
   mapping, which refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load.
   Ids never change: saved plans and share links store them, and rules-data-tests.js pins them. Every number
   is explained: see README.md, Editing the rules. Design and vocabulary: tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-classic-buffs.md (Classic Era buffs, debuffs and raids).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing. Also in code, not in these files: the Ideal-comp builders
   (js/app.js, faction-aware per version) and the blessing catalog (js/analysis.js,
   Assignments.DEFAULT_BLESSINGS).
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.classic = {
  // Party buffs the optimizer places, in display order. buffType drives the slot rule in code: one totem per element
  // per shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present.
  // weight.dps is what a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name,
  // else 0 (multiplied by the recipient's specDpsWeight); weight.dps: {} (a buff worth nothing to any recipient's DPS)
  // is written out on purpose, the key is explicit; weight.mitigation is the value to a tank (per CLASS:Spec, '*' = any
  // tank); weight.sustain is one number for healer groups. exclusiveBuffs lists the ids that share one slot per party
  // with this one (the better-valued member wins). priority only orders the buff list per role in the UI. spellId is
  // the max-rank spell, a verification handle.
  //
  // Buff and debuff numbers and existence are sourced from tasks/research-classic-buffs.md (compiled 2026-09-26). Where
  // that research flags a value UNCONFIRMED, the description stays qualitative rather than inventing a number. Ids are
  // reused from the TBC file wherever Classic has the same spell (so the shared catalog's icon, abbreviation and
  // CSS-class maps need no Classic-specific entries beyond the two brand-new totems, Tranquil Air and Stoneskin); each
  // version still owns its own desc and weights since Classic ranks differ from TBC's (e.g. Leader of the Pack is 3%
  // here, 5% in TBC).
  //
  // Totem and aura slots work as in TBC, minus the elements and auras that don't exist in Classic Era (Wrath of Air,
  // Totem of Wrath). The weights have the same shape as TBC's, scaled to what actually exists in Classic Era (no Wrath
  // of Air / Totem of Wrath / Ferocious Inspiration / Tree of Life). Values are heuristics, not measured percentages -
  // same disclaimer as TBC's weights.
  buffs: {
    WINDFURY: {
      name: 'Windfury Totem',
      spellId: 10614,
      desc: 'Enchants nearby party members\' main-hand weapons with wind, granting each hit a 20% chance to trigger an extra attack with up to 315 bonus attack power.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      preferSpec: 'Enhancement',
      targetRoles: ['tank', 'melee_dps'],
      priority: {
        melee_dps: 100,
        tank: 70,
      },
      weight: {
        dps: {
          'WARRIOR:Fury': 11,
          'ROGUE:Combat': 10,
          'ROGUE:Assassination': 9,
          'ROGUE:Subtlety': 8,
          'WARRIOR:Arms': 9,
          'SHAMAN:Enhancement': 8,
          'DRUID:Feral': 0,
          melee_dps: 7,
          tank: 3,
        },
        mitigation: {
          'WARRIOR:Protection': 3,
          'PALADIN:Protection': 1,
          'DRUID:Feral': 0,
        },
      },
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: 25359,
      desc: 'Increases agility of nearby party members by up to 77.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps'],
      priority: 60,
      weight: {
        dps: {
          melee_dps: 2,
          ranged_dps: 4,
          tank: 2,
        },
        mitigation: {
          'WARRIOR:Protection': 3,
          'PALADIN:Protection': 5,
          'DRUID:Feral': 8,
        },
      },
    },
    TRANQUIL_AIR: {
      name: 'Tranquil Air Totem',
      spellId: 25908,
      desc: 'Reduces the threat generated by nearby party members by 20%.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['caster_dps', 'healer'],
      priority: 40,
      weight: {
        dps: {
          caster_dps: 2,
          healer: 1,
        },
      },
    },
    STRENGTH_OF_EARTH: {
      name: 'Strength of Earth Totem',
      spellId: 25361,
      desc: 'Increases strength of nearby party members by up to 77.',
      buffType: 'totem',
      totemElement: 'earth',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'melee_dps'],
      priority: 55,
      weight: {
        dps: {
          melee_dps: 2,
          tank: 2,
        },
        mitigation: {
          'WARRIOR:Protection': 4,
          'PALADIN:Protection': 2,
          'DRUID:Feral': 3,
        },
      },
    },
    STONESKIN: {
      name: 'Stoneskin Totem',
      spellId: 10408,
      desc: 'Reduces melee damage taken by nearby party members by up to 30 per hit.',
      buffType: 'totem',
      totemElement: 'earth',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank'],
      priority: 45,
      weight: {
        dps: {},
        mitigation: { '*': 6 },
      },
    },
    MANA_SPRING: {
      name: 'Mana Spring Totem',
      spellId: 10497,
      desc: 'Restores mana to nearby party members every 2 seconds (up to 10 per tick at max rank).',
      buffType: 'totem',
      totemElement: 'water',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['healer', 'caster_dps'],
      priority: {
        healer: 58,
        caster_dps: 48,
      },
      weight: {
        dps: {
          caster_dps: 2,
          healer: 2,
        },
        sustain: 3,
      },
    },
    MANA_TIDE: {
      name: 'Mana Tide Totem',
      spellId: 17359,
      desc: 'Restores mana to nearby party members over 12 seconds (rank 1: 170 mana every 3 seconds; higher ranks UNCONFIRMED).',
      buffType: 'totem',
      totemElement: 'water',
      // cooldownTotem: the scorer credits Mana Tide on top of the shaman's standing element totem; it does not occupy
      // the water slot (see Optimizer.resolveGroupBuffs).
      cooldownTotem: true,
      scope: 'party',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Restoration',
      targetRoles: ['healer'],
      priority: 70,
      weight: {
        dps: { healer: 4 },
        sustain: 5,
      },
    },
    DEVOTION_AURA: {
      name: 'Devotion Aura',
      spellId: 10293,
      desc: 'Increases armor of nearby party members by up to 735.',
      buffType: 'paladinAura',
      scope: 'party',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      priority: 75,
      weight: {
        dps: {},
        mitigation: {
          'WARRIOR:Protection': 10,
          'PALADIN:Protection': 10,
          'DRUID:Feral': 5,
        },
      },
    },
    // Aura order is behaviour: a paladin keeps the EARLIER aura on a value tie, and the aura picker and the sidebar buff
    // list show them in this order, so keep Devotion, Concentration, Retribution (then Sanctity).
    CONCENTRATION_AURA: {
      name: 'Concentration Aura',
      spellId: 19746,
      desc: 'Gives nearby party members a 35% chance to resist interruption from damage while casting.',
      buffType: 'paladinAura',
      scope: 'party',
      sourceClass: 'PALADIN',
      targetRoles: ['healer', 'caster_dps'],
      priority: {
        healer: 65,
        caster_dps: 55,
      },
      weight: {
        dps: {
          healer: 2,
          caster_dps: 1,
        },
        sustain: 2,
      },
    },
    RETRIBUTION_AURA: {
      name: 'Retribution Aura',
      spellId: 10301,
      desc: 'Causes Holy damage to any enemy that strikes nearby party members in melee.',
      buffType: 'paladinAura',
      scope: 'party',
      sourceClass: 'PALADIN',
      targetRoles: ['tank', 'melee_dps'],
      priority: 30,
      weight: {
        dps: {
          melee_dps: 1,
          tank: 1,
        },
        mitigation: { '*': 1 },
      },
    },
    SANCTITY_AURA: {
      name: 'Sanctity Aura',
      spellId: 20218,
      desc: 'Increases Holy damage done by nearby party members by 10%.',
      buffType: 'paladinAura',
      scope: 'party',
      sourceClass: 'PALADIN',
      sourceSpec: 'Retribution',
      targetRoles: ['melee_dps', 'ranged_dps', 'caster_dps', 'tank'],
      priority: {
        melee_dps: 80,
        ranged_dps: 80,
        caster_dps: 80,
        tank: 40,
      },
      weight: {
        dps: {
          melee_dps: 1,
          ranged_dps: 1,
          caster_dps: 1,
          tank: 1,
        },
      },
    },
    // Battle Shout is a plain passive here: there is no warrior shout slot, every warrior is simply credited Battle
    // Shout.
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: 25289,
      desc: 'Increases attack power of nearby party members for 2 minutes. Party-only in Classic Era; exact rank value UNCONFIRMED.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps'],
      priority: {
        melee_dps: 65,
        tank: 50,
      },
      weight: {
        dps: {
          melee_dps: 3,
          ranged_dps: 2,
          tank: 2,
        },
        mitigation: { '*': 2 },
      },
    },
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: 20906,
      desc: 'Increases attack power of nearby party members. Exact value UNCONFIRMED.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'HUNTER',
      sourceSpec: 'Marksmanship',
      targetRoles: ['melee_dps', 'ranged_dps'],
      priority: 62,
      weight: {
        dps: {
          melee_dps: 3,
          ranged_dps: 4,
        },
      },
    },
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: 17007,
      desc: 'Increases melee and ranged critical strike chance of nearby party members by 3%.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps'],
      priority: {
        melee_dps: 78,
        tank: 65,
      },
      weight: {
        dps: {
          melee_dps: 4,
          ranged_dps: 4,
          tank: 2,
        },
        mitigation: {
          'DRUID:Feral': 5,
          '*': 2,
        },
      },
    },
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: 24907,
      desc: 'Increases spell critical strike chance of nearby party members by 3%.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['caster_dps'],
      priority: 72,
      weight: {
        dps: { caster_dps: 4 },
      },
    },
    BLOOD_PACT: {
      name: 'Blood Pact',
      spellId: 11767,
      desc: 'Increases max health of nearby party members (Wowhead Classic: +38 Stamina).',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      priority: 40,
      weight: {
        dps: { tank: 1 },
        mitigation: { '*': 4 },
      },
    },
  },

  // Raid debuffs, applied to the enemy. weight is the Open-slot tier (same scale as weight.dps); targetRoles, and
  // targetSchool which narrows casters to one school, say who profits. competesWith and supersededBy model the
  // non-stacking debuff slots. debuffType is descriptive only.
  //
  // Same non-stacking-slot model as the TBC debuffs (competesWith/supersededBy), Classic Era numbers.
  debuffs: {
    JUDGEMENT_CRUSADER: {
      name: 'Judgement of the Crusader',
      spellId: 20303,
      desc: 'Increases Holy damage taken by the target by 30. Improved Seal of the Crusader also grants attackers +3% critical strike chance against it.',
      debuffType: 'holyVulnerability',
      sourceClass: 'PALADIN',
      sourceSpec: 'Retribution',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    JUDGEMENT_LIGHT: {
      name: 'Judgement of Light',
      spellId: 20346,
      desc: 'Melee attackers have a chance to heal themselves. Exact value UNCONFIRMED.',
      debuffType: 'healOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      weight: 1,
    },
    JUDGEMENT_WISDOM: {
      name: 'Judgement of Wisdom',
      spellId: 20355,
      desc: 'Attacks and spells against the target have a chance to restore mana. Exact value UNCONFIRMED.',
      debuffType: 'manaOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['caster_dps'],
      weight: 1,
    },
    SUNDER_ARMOR: {
      name: 'Sunder Armor',
      spellId: 11597,
      desc: 'Reduces the target\'s armor by up to 900 (5 stacks of 180).',
      debuffType: 'armor',
      sourceClass: 'WARRIOR',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['EXPOSE_ARMOR'],
    },
    DEMORALIZING_SHOUT: {
      name: 'Demoralizing Shout',
      spellId: 11556,
      desc: 'Reduces the target\'s melee attack power. Exact value UNCONFIRMED (community estimate ~140).',
      debuffType: 'attackPower',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_ROAR', 'CURSE_WEAKNESS'],
    },
    THUNDER_CLAP: {
      name: 'Thunder Clap',
      spellId: 11581,
      desc: 'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).',
      debuffType: 'attackSpeed',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
    },
    EXPOSE_ARMOR: {
      name: 'Expose Armor',
      spellId: 11198,
      desc: 'Reduces the target\'s armor by 1700 at 5 combo points (2550 with Improved Expose Armor).',
      debuffType: 'armor',
      sourceClass: 'ROGUE',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['SUNDER_ARMOR'],
    },
    FAERIE_FIRE_BALANCE: {
      name: 'Faerie Fire',
      spellId: 9907,
      desc: 'Reduces the target\'s armor by 505.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    FAERIE_FIRE_FERAL: {
      name: 'Faerie Fire (Feral)',
      spellId: 17392,
      desc: 'Reduces the target\'s armor by 505. Same debuff as Faerie Fire.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 2,
      supersededBy: 'FAERIE_FIRE_BALANCE',
    },
    DEMORALIZING_ROAR: {
      name: 'Demoralizing Roar',
      spellId: 9898,
      desc: 'Reduces the target\'s melee attack power. Exact value UNCONFIRMED (community estimate ~140).',
      debuffType: 'attackPower',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_SHOUT', 'CURSE_WEAKNESS'],
    },
    INSECT_SWARM: {
      name: 'Insect Swarm',
      spellId: 24977,
      desc: 'Reduces the target\'s chance to hit by 2%.',
      debuffType: 'hitChance',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank'],
      weight: 1,
    },
    CURSE_RECKLESSNESS: {
      name: 'Curse of Recklessness',
      spellId: 11717,
      desc: 'Increases melee attack power by 90 but reduces armor by 640.',
      debuffType: 'armor',
      sourceClass: 'WARLOCK',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_WEAKNESS'],
    },
    CURSE_ELEMENTS: {
      name: 'Curse of the Elements',
      spellId: 11722,
      desc: 'Reduces resistance to Fire and Frost by 75 and increases Fire/Frost damage taken by 10%. Fire and Frost only in Classic Era.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      targetRoles: ['caster_dps'],
      weight: 6,
      competesWith: ['CURSE_RECKLESSNESS', 'CURSE_WEAKNESS'],
    },
    CURSE_WEAKNESS: {
      name: 'Curse of Weakness',
      spellId: 11708,
      desc: 'Reduces the target\'s melee damage dealt. Exact value UNCONFIRMED; shares a debuff slot with Demoralizing Shout/Roar.',
      debuffType: 'attackPower',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_RECKLESSNESS', 'DEMORALIZING_SHOUT', 'DEMORALIZING_ROAR'],
    },
    WINTERS_CHILL: {
      name: 'Winter\'s Chill',
      spellId: 28595,
      desc: 'Increases the target\'s chance to be critically hit by Frost spells by up to 10% (5 stacks).',
      debuffType: 'magicVulnerability',
      sourceClass: 'MAGE',
      sourceSpec: 'Frost',
      targetRoles: ['caster_dps'],
      targetSchool: 'frost',
      weight: 3,
    },
    IMPROVED_SCORCH: {
      name: 'Improved Scorch',
      spellId: 12873,
      desc: 'Increases Fire damage taken by the target by up to 15% (5 stacks).',
      debuffType: 'magicVulnerability',
      sourceClass: 'MAGE',
      sourceSpec: 'Fire',
      targetRoles: ['caster_dps'],
      targetSchool: 'fire',
      weight: 6,
    },
    SHADOW_WEAVING: {
      name: 'Shadow Weaving',
      spellId: 15334,
      desc: 'Increases Shadow damage taken by the target by up to 15% (5 stacks of 3%).',
      debuffType: 'magicVulnerability',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['caster_dps'],
      targetSchool: 'shadow',
      weight: 4,
    },
    STORMSTRIKE: {
      name: 'Stormstrike',
      spellId: 17364,
      desc: 'Increases Nature damage taken by the target by 20% for the next 2 hits. Enhancement Shaman is Horde-only in Classic Era.',
      debuffType: 'magicVulnerability',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Enhancement',
      targetRoles: ['caster_dps'],
      targetSchool: 'nature',
      weight: 3,
    },
  },

  // Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies,
  // so a top DPS is placed where it gets buffed before its buff goes to a weaker group.
  //
  // Rough Classic Era ordering: Fury Warrior/Rogues/Fire+Frost Mage/Destro Warlock highest, Hunters next, Shadow
  // Priest/Feral cat/Elemental/Enhancement/Balance/Retribution lower. Heuristic, not log-calibrated (no Classic parse
  // data available yet, unlike TBC's).
  specDpsWeight: {
    'WARRIOR:Fury': 1.0,
    'ROGUE:Combat': 0.98,
    'ROGUE:Assassination': 0.95,
    'ROGUE:Subtlety': 0.9,
    'MAGE:Fire': 0.95,
    'MAGE:Frost': 0.9,
    'WARLOCK:Destruction': 0.95,
    'WARLOCK:Affliction': 0.9,
    'WARLOCK:Demonology': 0.85,
    'MAGE:Arcane': 0.8,
    'WARRIOR:Arms': 0.85,
    'HUNTER:Marksmanship': 0.85,
    'HUNTER:Beast Mastery': 0.85,
    'HUNTER:Survival': 0.8,
    'PRIEST:Shadow': 0.7,
    'DRUID:Feral': 0.68,
    'SHAMAN:Elemental': 0.65,
    'SHAMAN:Enhancement': 0.65,
    'DRUID:Balance': 0.6,
    'PALADIN:Retribution': 0.55,
    'WARRIOR:Protection': 0.45,
    'PALADIN:Protection': 0.45,
  },

  // Weight for a role when the spec has no entry above (0.8 when the role is missing too).
  roleDpsWeight: {
    melee_dps: 0.8,
    ranged_dps: 0.85,
    caster_dps: 0.8,
    tank: 0.5,
    healer: 1.0,
  },

  // Default air totem per recipient role.
  bestAirTotem: {
    tank: 'WINDFURY',
    melee_dps: 'WINDFURY',
    ranged_dps: 'GRACE_OF_AIR',
    caster_dps: 'TRANQUIL_AIR',
    healer: 'TRANQUIL_AIR',
  },

  // Default paladin aura per recipient role.
  bestPaladinAura: {
    tank: 'DEVOTION_AURA',
    melee_dps: 'RETRIBUTION_AURA',
    ranged_dps: 'CONCENTRATION_AURA',
    caster_dps: 'CONCENTRATION_AURA',
    healer: 'CONCENTRATION_AURA',
  },

  // The aura a paladin spec runs when several auras are valued equally.
  specAura: {
    Retribution: 'SANCTITY_AURA',
    Protection: 'DEVOTION_AURA',
    Holy: 'CONCENTRATION_AURA',
  },

  // Classes whose buff is a single-point-of-failure per group (Shaman Windfury/totems, Paladin auras, Feral Leader of
  // the Pack) - spread one per group instead of letting two stack in one group while another has none. See
  // Optimizer.spreadProviders(). spec may be a list; no spec = any spec of the class. Only one of SHAMAN/PALADIN is
  // ever actually present under the faction lock below, so listing both is harmless - whichever class has no members in
  // the roster is a no-op.
  spreadProviders: [
    { class: 'SHAMAN' },
    { class: 'PALADIN' },
    { class: 'DRUID', spec: 'Feral' },
  ],

  // true: Shaman is Horde-only and Paladin Alliance-only; false: both classes exist on both factions.
  //
  // Classic Era faction lock: Shaman = Horde only, Paladin = Alliance only. Gates the Windfury structural penalty, the
  // missing-buff insight list, random-roster generation and the ideal-comp Horde/Alliance pick.
  factionLock: true,

  // Tank classes in the order they are picked to anchor the healer/tank group, first wins; every other class ranks
  // after them.
  //
  // Warrior is the premier tank on both factions; Prot Paladin is a rare off-tank and only possible on Alliance
  // (faction lock).
  tankAnchorOrder: ['WARRIOR', 'PALADIN'],

  // Every tuning number and flag the optimizer reads (rules.* before this file), plus modeConfig (objective weights per
  // optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  //
  // These are small hooks the optimizer consults instead of hardcoded class/spec checks, so a version can turn one off
  // or swap its value; a key that is absent is off (the Classic and Forever files leave out the TBC-only ones).
  conventions: {
    // meleeWantsWindfury: gated off for Alliance rosters - see the Faction.current() call sites.
    meleeWantsWindfury: true,
    // ferociousInspiration: Ferocious Inspiration does not exist in Classic Era.
    ferociousInspiration: false,
    // Structural nudge (see Optimizer.groupScore's buffValue) so a melee group's shaman actually drops Windfury instead
    // of losing the per-element totem choice to Grace of Air when the group also holds several hunters. TBC has no such
    // value (absent = no-op) because its weight tables were tuned, and its scenario suite pinned, without it.
    meleeGroupWindfuryBias: 8,
    // modeConfig: the objective weights per optimizer mode over the score's components. dps: party-buff DPS value
    // received by members (weight.dps); mit: mitigation value of buffs reaching tanks in the tank group
    // (weight.mitigation); structure: healer coverage + spreading pressure; cohesion: role-family clustering around
    // each group's identity.
    //
    // DEPRECATED (4.2.0, user decision 2026-10-10): only max_dps is supported. The nav slim-down (4.0.0) removed the
    // strategy selector, and app.js / PlanStore.restore() force State.optimizerMode = 'max_dps', so tank_mit / balanced
    // / relaxed are unreachable from the UI. They stay only so old saved plans and share links still validate and old
    // tests still run. Do not tune weights or write code for them; when a non-max_dps check conflicts with a max_dps
    // improvement, delete the check. The scenario runner gates on max_dps only (--mode all is a one-off probe).
    modeConfig: {
      max_dps: { dps: 1.0, mit: 0.25, structure: 0.7, cohesion: 0.4 },
      tank_mit: { dps: 0.7, mit: 1.2, structure: 1.0, cohesion: 0.4 },
      balanced: { dps: 0.7, mit: 0.5, structure: 1.0, cohesion: 1.0 },
      relaxed: { dps: 0.2, mit: 0.3, structure: 1.0, cohesion: 1.5 },
    },
    openSlots: {
      // Open-slot pricing (OpenSlots._raidValue), on top of the party buffs. utilityBonus: flat bonus for a spec that
      // provides a utility nobody in the raid brings yet (Power Infusion, ...).
      utilityBonus: 6,
      // specRepeat: cost for every copy of the candidate's spec already in the raid.
      specRepeat: 6,
      // classCrowd: cost for piling onto a class the raid already has plenty of: classCrowd x max(0, copies of the
      // class already in the raid - classCrowdFree + 1).
      classCrowd: 4,
      // classCrowdFree: see classCrowd.
      classCrowdFree: 5,
    },
  },

  // Raids of this version in picker order; planning templates last.
  //
  // The real Classic Era raids come in phase order (tasks/research-classic-buffs.md); their ids are unique across
  // versions, so they never collide with another version's raids. The classicN planning templates come after the real
  // raids so old saved plans (keyed on classicN) keep working.
  raids: {
    mc: { name: 'Molten Core', size: 40, groups: 8, tier: 'Phase 1' },
    ony: { name: 'Onyxia\'s Lair', size: 40, groups: 8, tier: 'Phase 1' },
    bwl: { name: 'Blackwing Lair', size: 40, groups: 8, tier: 'Phase 3' },
    zg: { name: 'Zul\'Gurub', size: 20, groups: 4, tier: 'Phase 4' },
    aq20: { name: 'Ruins of Ahn\'Qiraj', size: 20, groups: 4, tier: 'Phase 5' },
    aq40: { name: 'Temple of Ahn\'Qiraj', size: 40, groups: 8, tier: 'Phase 5' },
    naxx: { name: 'Naxxramas', size: 40, groups: 8, tier: 'Phase 6' },
    classic10: { name: '10-player template', size: 10, groups: 2, tier: 'Planning templates' },
    classic20: { name: '20-player template', size: 20, groups: 4, tier: 'Planning templates' },
    classic40: { name: '40-player template', size: 40, groups: 8, tier: 'Planning templates' },
  },

  // Class-presence utility checklist for the readiness sidebar: one-off or in-combat abilities, not always-on party
  // auras. providers lists { class, spec?, note? }; no spec = any spec of the class.
  //
  // Same shape as the TBC utilities, with the Classic-Era differences: Tranquilizing Shot exists here
  // (Magmadar/Flamegor/Huhuran/Chromaggus enrage removal) and neither Bloodlust/Heroism nor Misdirection exist yet
  // (both are TBC-only). Faction-locked providers (SHAMAN/PALADIN) are filtered per-roster by
  // Readiness._factionFilteredProviders(), not here.
  utilities: {
    BATTLE_REZ: {
      name: 'Battle Resurrection',
      providers: [
        { class: 'DRUID', note: 'Rebirth' },
        { class: 'WARLOCK', note: 'Soulstone — must be pre-cast before the pull' },
      ],
      desc: 'Revives a fallen raid member mid-encounter, or lets one pre-flagged player self-resurrect once via a pre-pull Soulstone.',
    },
    REMOVE_CURSE: {
      name: 'Remove Curse',
      providers: [{ class: 'MAGE' }, { class: 'DRUID' }],
      desc: 'Removes a Curse debuff from a friendly target.',
    },
    CURE_POISON: {
      name: 'Cure/Abolish Poison',
      providers: [{ class: 'DRUID' }, { class: 'SHAMAN' }, { class: 'PALADIN', note: 'Cleanse' }],
      desc: 'Removes a Poison debuff from a friendly target.',
    },
    CURE_DISEASE: {
      name: 'Cure Disease',
      providers: [{ class: 'PRIEST' }, { class: 'SHAMAN' }, { class: 'PALADIN', note: 'Cleanse' }],
      desc: 'Removes a Disease debuff from a friendly target.',
    },
    DISPEL_MAGIC: {
      name: 'Dispel Magic',
      providers: [{ class: 'PRIEST' }, { class: 'PALADIN', note: 'Cleanse' }],
      desc: 'Removes a harmful Magic effect from a friendly target.',
    },
    FEAR_BREAK: {
      name: 'Fear Break (Tremor Totem)',
      providers: [{ class: 'SHAMAN' }],
      desc: 'Tremor Totem breaks, and grants brief immunity to, Fear/Charm/Sleep effects on nearby party members.',
    },
    TRANQ_SHOT: {
      name: 'Tranquilizing Shot',
      providers: [{ class: 'HUNTER' }],
      desc: 'Removes one Enrage effect and one Magic effect from the target. Required for Magmadar, Flamegor, Princess Huhuran and Chromaggus.',
    },
    INNERVATE: {
      name: 'Innervate',
      providers: [{ class: 'DRUID' }],
      desc: 'Restores a large amount of mana to the target over time — usually kept for another healer or self-cast.',
    },
    POWER_INFUSION: {
      name: 'Power Infusion',
      providers: [{ class: 'PRIEST', spec: 'Discipline' }],
      desc: 'Discipline talent. Increases the target\'s spell damage and reduces mana cost for a short time.',
    },
  },
};
