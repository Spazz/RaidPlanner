/* ================================================================
   PARTY PLANNER WEB - rules data: TBC
   ----------------------------------------------------------------
   WoW TBC: party buffs and raid debuffs with their weights, the optimizer tuning numbers, raids, utilities,
   the reference compositions and the blessing catalog.

   Source of truth: from Phase 2 of the rules data refactor on, this file replaces the hand-written tables in
   js/rules.js and js/optimizer.js and is edited by hand. Until then the app still reads those tables and
   rules-migration-tests.js pins that Rulesets.compile() rebuilds them from this file exactly. Generated once
   on 2026-10-11 by tools/generate-rules-data.js from the then-live tables. Design and vocabulary:
   tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-synergy-sheet.md (Lokgol TBC synergy tiers) and
   gruul_dps_data.txt (DPS weights).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing.
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.tbc = {
  // Party buffs the optimizer places, in display order. buffType drives the slot rule in code: one totem per element
  // per shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present.
  // weight.dps is what a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name,
  // else 0 (multiplied by the recipient's specDpsWeight); weight.mitigation is the value to a tank (per CLASS:Spec, '*'
  // = any tank); weight.sustain is one number for healer groups. exclusiveBuffs lists the ids that share one slot per
  // party with this one (the better-valued member wins). priority only orders the buff list per role in the UI. spellId
  // is the max-rank spell, a verification handle.
  buffs: {
    WINDFURY: {
      name: 'Windfury Totem',
      spellId: null,
      desc: 'Enchants nearby party members\' main-hand weapons with wind, granting each hit a 20% chance to trigger an extra attack with bonus AP.',
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
          'PALADIN:Retribution': 12,
          'WARRIOR:Fury': 11,
          'WARRIOR:Arms': 10,
          'SHAMAN:Enhancement': 9,
          'ROGUE:Combat': 8,
          'ROGUE:Assassination': 8,
          'ROGUE:Subtlety': 8,
          'DRUID:Feral': 0,
          melee_dps: 8,
          tank: 3,
        },
        mitigation: {
          'WARRIOR:Protection': 4,
          'PALADIN:Protection': 1,
          'DRUID:Feral': 0,
        },
      },
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: null,
      desc: 'Increases agility of nearby party members by 77.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps'],
      priority: 60,
      weight: {
        dps: {
          'DRUID:Feral': 4,
          melee_dps: 2,
          ranged_dps: 3,
          tank: 2,
        },
        mitigation: {
          'WARRIOR:Protection': 4,
          'PALADIN:Protection': 7,
          'DRUID:Feral': 9,
        },
      },
    },
    WRATH_OF_AIR: {
      name: 'Wrath of Air Totem',
      spellId: null,
      desc: 'Increases spell power of nearby party members by 101.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'caster_dps', 'healer'],
      priority: 85,
      weight: {
        dps: {
          caster_dps: 4,
          healer: 2,
        },
        mitigation: { 'PALADIN:Protection': 5 },
      },
    },
    TOTEM_OF_WRATH: {
      name: 'Totem of Wrath',
      spellId: null,
      desc: 'Increases spell hit chance of nearby party members by 3% and spell critical strike chance by 3%.',
      buffType: 'totem',
      totemElement: 'fire',
      scope: 'party',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Elemental',
      targetRoles: ['caster_dps', 'healer'],
      priority: 80,
      weight: {
        dps: {
          'WARLOCK:Destruction': 12,
          caster_dps: 6,
          healer: 1,
        },
      },
    },
    MANA_SPRING: {
      name: 'Mana Spring Totem',
      spellId: null,
      desc: 'Restores 20 mana every 2 seconds to nearby party members.',
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
          'MAGE:Arcane': 3,
          healer: 2,
          caster_dps: 1,
        },
        sustain: 3,
      },
    },
    MANA_TIDE: {
      name: 'Mana Tide Totem',
      spellId: null,
      desc: 'Restores 24% of total mana to nearby party members over 12 seconds.',
      buffType: 'totem',
      totemElement: 'water',
      cooldownTotem: true,
      scope: 'party',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Restoration',
      targetRoles: ['healer', 'caster_dps'],
      priority: 70,
      weight: {
        dps: {
          'MAGE:Arcane': 5,
          healer: 4,
        },
        sustain: 5,
      },
    },
    STRENGTH_OF_EARTH: {
      name: 'Strength of Earth',
      spellId: null,
      desc: 'Increases strength of nearby party members by 86.',
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
          'WARRIOR:Protection': 5,
          'PALADIN:Protection': 2,
          'DRUID:Feral': 3,
        },
      },
    },
    DEVOTION_AURA: {
      name: 'Devotion Aura',
      spellId: null,
      desc: 'Increases armor of nearby party members by 861.',
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
    CONCENTRATION_AURA: {
      name: 'Concentration Aura',
      spellId: null,
      desc: 'Reduces the duration of silence and interrupt effects by 30% and gives 35% resistance to pushback while casting.',
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
        sustain: 3,
      },
    },
    RETRIBUTION_AURA: {
      name: 'Retribution Aura',
      spellId: null,
      desc: 'Causes 26 Holy damage to any enemy that strikes nearby party members.',
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
      spellId: null,
      desc: 'Increases Holy damage done by party members by 10%. Improved Sanctity Aura also increases all damage done by party members by 2%.',
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
          melee_dps: 2,
          ranged_dps: 2,
          caster_dps: 2,
          tank: 1,
        },
      },
    },
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: null,
      desc: 'Increases melee and ranged critical strike chance of nearby party members by 5%.',
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
          melee_dps: 5,
          ranged_dps: 5,
          tank: 2,
        },
        mitigation: {
          'DRUID:Feral': 6,
          '*': 2,
        },
      },
    },
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: null,
      desc: 'Increases spell critical strike chance of nearby party members by 5%.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['caster_dps'],
      priority: 72,
      weight: {
        dps: {
          'WARLOCK:Destruction': 12,
          caster_dps: 5,
        },
      },
    },
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: null,
      desc: 'Increases attack power of nearby party members by 125.',
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
    FEROCIOUS_INSP: {
      name: 'Ferocious Inspiration',
      spellId: null,
      desc: 'When your pet scores a critical hit, all party members gain 3% increased damage for 10 seconds.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'HUNTER',
      sourceSpec: 'Beast Mastery',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps', 'caster_dps'],
      priority: 58,
      weight: {
        dps: {
          melee_dps: 3,
          ranged_dps: 3,
          caster_dps: 3,
          tank: 1,
        },
      },
    },
    TREE_OF_LIFE: {
      name: 'Tree of Life',
      spellId: null,
      desc: 'Increases healing received by nearby party members by 25% of the Druid\'s spirit.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Restoration',
      targetRoles: ['tank', 'healer'],
      priority: {
        tank: 90,
        healer: 10,
        melee_dps: 10,
        ranged_dps: 10,
        caster_dps: 10,
      },
      weight: {
        dps: { healer: 1 },
        mitigation: { '*': 12 },
      },
    },
    UNLEASHED_RAGE: {
      name: 'Unleashed Rage',
      spellId: null,
      desc: 'Increases melee attack power of nearby party members by 10% after landing a melee critical strike.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Enhancement',
      targetRoles: ['tank', 'melee_dps'],
      priority: {
        melee_dps: 88,
        tank: 60,
      },
      weight: {
        dps: {
          melee_dps: 5,
          tank: 2,
        },
      },
    },
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: null,
      desc: 'Increases attack power of nearby party members by 305 for 2 minutes.',
      buffType: 'warriorShout',
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
    COMMANDING_SHOUT: {
      name: 'Commanding Shout',
      spellId: null,
      desc: 'Increases maximum health of nearby party members by 1080 for 2 minutes. The planner models one shout per warrior, so a second warrior covers the other.',
      buffType: 'warriorShout',
      scope: 'party',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      priority: 35,
      weight: {
        dps: {},
        mitigation: { '*': 5 },
      },
    },
    BLOOD_PACT: {
      name: 'Blood Pact',
      spellId: null,
      desc: 'Increases max health of nearby party members by 1330.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      priority: 40,
      weight: {
        dps: { tank: 1 },
        mitigation: { '*': 6 },
      },
    },
    VAMPIRIC_TOUCH: {
      name: 'Vampiric Touch',
      spellId: null,
      desc: 'Restores mana to nearby party members equal to 5% of Shadow damage dealt.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['healer', 'caster_dps'],
      priority: {
        caster_dps: 75,
        healer: 55,
      },
      weight: {
        dps: {
          'MAGE:Arcane': 7,
          'PRIEST:Holy': 10,
          WARLOCK: 2,
          MAGE: 6,
          caster_dps: 4,
          healer: 3,
        },
        sustain: 3,
      },
    },
  },

  // Raid debuffs, applied to the enemy. weight is the Open-slot tier (same scale as weight.dps); targetRoles, and
  // targetSchool which narrows casters to one school, say who profits. competesWith and supersededBy model the
  // non-stacking debuff slots. debuffType is descriptive only.
  debuffs: {
    JUDGEMENT_CRUSADER: {
      name: 'Judgement of the Crusader',
      spellId: null,
      desc: 'Attackers have a 3% increased chance to critically hit the target, which also takes 219 increased Holy damage.',
      debuffType: 'holyVulnerability',
      sourceClass: 'PALADIN',
      sourceSpec: 'Retribution',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    JUDGEMENT_LIGHT: {
      name: 'Judgement of Light',
      spellId: null,
      desc: 'Melee attackers have a chance to heal themselves for 95 health.',
      debuffType: 'healOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      weight: 1,
    },
    JUDGEMENT_WISDOM: {
      name: 'Judgement of Wisdom',
      spellId: null,
      desc: 'Attacks and spells against the target have a chance to restore 74 mana.',
      debuffType: 'manaOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['caster_dps'],
      weight: 1,
    },
    SUNDER_ARMOR: {
      name: 'Sunder Armor',
      spellId: null,
      desc: 'Reduces the target\'s armor by up to 2600 (5 stacks).',
      debuffType: 'armor',
      sourceClass: 'WARRIOR',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['EXPOSE_ARMOR'],
    },
    DEMORALIZING_SHOUT: {
      name: 'Demoralizing Shout',
      spellId: null,
      desc: 'Reduces the target\'s melee attack power by 300 (420 with Improved Demoralizing Shout).',
      debuffType: 'attackPower',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_ROAR', 'CURSE_WEAKNESS'],
    },
    THUNDER_CLAP: {
      name: 'Thunder Clap',
      spellId: null,
      desc: 'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).',
      debuffType: 'attackSpeed',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
    },
    BLOOD_FRENZY: {
      name: 'Blood Frenzy',
      spellId: null,
      desc: 'Increases Physical damage taken by the target by 4%.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'WARRIOR',
      sourceSpec: 'Arms',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 4,
    },
    EXPOSE_ARMOR: {
      name: 'Expose Armor',
      spellId: null,
      desc: 'Reduces the target\'s armor by 2050 (3075 with Improved Expose Armor).',
      debuffType: 'armor',
      sourceClass: 'ROGUE',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['SUNDER_ARMOR'],
    },
    HEMORRHAGE: {
      name: 'Hemorrhage',
      spellId: null,
      desc: 'Increases Physical damage taken by the target by 42, for 10 charges.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'ROGUE',
      sourceSpec: 'Subtlety',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 1,
    },
    FAERIE_FIRE_BALANCE: {
      name: 'Faerie Fire',
      spellId: null,
      desc: 'Reduces the target\'s armor by 610 and, with Improved Faerie Fire, gives attackers +3% chance to hit.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    FAERIE_FIRE_FERAL: {
      name: 'Faerie Fire (Feral)',
      spellId: null,
      desc: 'Reduces the target\'s armor by 610.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 2,
      supersededBy: 'FAERIE_FIRE_BALANCE',
    },
    MANGLE: {
      name: 'Mangle',
      spellId: null,
      desc: 'Increases damage taken from bleed effects by 30%.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 1,
    },
    DEMORALIZING_ROAR: {
      name: 'Demoralizing Roar',
      spellId: null,
      desc: 'Reduces the target\'s melee attack power by 232.',
      debuffType: 'attackPower',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_SHOUT', 'CURSE_WEAKNESS'],
    },
    INSECT_SWARM: {
      name: 'Insect Swarm',
      spellId: null,
      desc: 'Reduces the target\'s chance to hit by 2%.',
      debuffType: 'hitChance',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank'],
      weight: 1,
    },
    CURSE_ELEMENTS: {
      name: 'Curse of the Elements',
      spellId: null,
      desc: 'Reduces resistance to Fire/Frost/Shadow by 88 and increases Arcane/Fire/Frost/Shadow damage taken by 10%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      targetRoles: ['caster_dps'],
      weight: 6,
      competesWith: ['CURSE_RECKLESSNESS', 'CURSE_WEAKNESS'],
    },
    CURSE_RECKLESSNESS: {
      name: 'Curse of Recklessness',
      spellId: null,
      desc: 'Increases melee attack power by 135 but reduces armor by 800.',
      debuffType: 'armor',
      sourceClass: 'WARLOCK',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_WEAKNESS'],
    },
    CURSE_WEAKNESS: {
      name: 'Curse of Weakness',
      spellId: null,
      desc: 'Reduces the target\'s melee attack power by 350.',
      debuffType: 'attackPower',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_RECKLESSNESS', 'DEMORALIZING_SHOUT', 'DEMORALIZING_ROAR'],
    },
    SHADOW_EMBRACE: {
      name: 'Shadow Embrace',
      spellId: null,
      desc: 'Reduces the target\'s Physical damage dealt by 5%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      sourceSpec: 'Affliction',
      targetRoles: ['tank'],
      weight: 1,
    },
    IMPROVED_SHADOW_BOLT: {
      name: 'Improved Shadow Bolt',
      spellId: null,
      desc: 'Increases Shadow damage taken by the target by 20%, for 5 charges.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      sourceSpec: 'Destruction',
      targetRoles: ['caster_dps'],
      targetSchool: 'shadow',
      weight: 6,
    },
    WINTERS_CHILL: {
      name: 'Winter\'s Chill',
      spellId: null,
      desc: 'Increases the target\'s chance to be critically hit by Frost spells by 10%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'MAGE',
      sourceSpec: 'Frost',
      targetRoles: ['caster_dps'],
      targetSchool: 'frost',
      weight: 3,
    },
    IMPROVED_SCORCH: {
      name: 'Improved Scorch',
      spellId: null,
      desc: 'Increases Fire damage taken by the target by 15%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'MAGE',
      sourceSpec: 'Fire',
      targetRoles: ['caster_dps'],
      targetSchool: 'fire',
      weight: 6,
    },
    SHADOW_WEAVING: {
      name: 'Shadow Weaving',
      spellId: null,
      desc: 'Increases Shadow damage taken by the target by 10%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['caster_dps'],
      targetSchool: 'shadow',
      weight: 4,
    },
    MISERY: {
      name: 'Misery',
      spellId: null,
      desc: 'Increases Spell damage taken by the target by 5%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['caster_dps'],
      weight: 4,
    },
    VAMPIRIC_EMBRACE: {
      name: 'Vampiric Embrace',
      spellId: null,
      desc: 'Heals the caster\'s party for 15% of the Priest\'s damage dealt to the target.',
      debuffType: 'other',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['melee_dps', 'ranged_dps', 'caster_dps'],
      weight: 2,
    },
    STORMSTRIKE: {
      name: 'Stormstrike',
      spellId: null,
      desc: 'Increases Nature damage taken by the target by 20%, for 2 charges.',
      debuffType: 'magicVulnerability',
      sourceClass: 'SHAMAN',
      sourceSpec: 'Enhancement',
      targetRoles: ['caster_dps'],
      targetSchool: 'nature',
      weight: 3,
    },
    SCORPID_STING: {
      name: 'Scorpid Sting',
      spellId: null,
      desc: 'Reduces the target\'s chance to hit with melee/ranged attacks by 5%.',
      debuffType: 'hitChance',
      sourceClass: 'HUNTER',
      targetRoles: ['tank'],
      weight: 1,
    },
    HUNTERS_MARK: {
      name: 'Hunter\'s Mark',
      spellId: null,
      desc: 'Grants attackers 110 increased melee/ranged attack power against the target.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    EXPOSE_WEAKNESS: {
      name: 'Expose Weakness',
      spellId: null,
      desc: 'Grants attackers bonus attack power equal to 25% of the Hunter\'s Agility.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      sourceSpec: 'Survival',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
    },
  },

  // Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies,
  // so a top DPS is placed where it gets buffed before its buff goes to a weaker group.
  specDpsWeight: {
    'WARLOCK:Affliction': 1.0,
    'HUNTER:Beast Mastery': 1.0,
    'MAGE:Arcane': 0.95,
    'WARLOCK:Destruction': 0.9,
    'ROGUE:Combat': 0.9,
    'SHAMAN:Elemental': 0.9,
    'HUNTER:Marksmanship': 0.9,
    'HUNTER:Survival': 0.85,
    'ROGUE:Assassination': 0.85,
    'ROGUE:Subtlety': 0.8,
    'MAGE:Fire': 0.85,
    'MAGE:Frost': 0.8,
    'WARLOCK:Demonology': 0.85,
    'PRIEST:Shadow': 0.8,
    'WARRIOR:Fury': 0.8,
    'WARRIOR:Arms': 0.8,
    'SHAMAN:Enhancement': 0.8,
    'PALADIN:Retribution': 0.7,
    'DRUID:Balance': 0.6,
    'DRUID:Feral': 0.6,
    'PALADIN:Protection': 0.5,
    'WARRIOR:Protection': 0.5,
  },

  // Weight for a role when the spec has no entry above (0.8 when the role is missing too).
  roleDpsWeight: {
    melee_dps: 0.8,
    ranged_dps: 0.9,
    caster_dps: 0.85,
    tank: 0.5,
    healer: 1.0,
  },

  // Default air totem per recipient role.
  bestAirTotem: {
    tank: 'WINDFURY',
    melee_dps: 'WINDFURY',
    ranged_dps: 'GRACE_OF_AIR',
    caster_dps: 'WRATH_OF_AIR',
    healer: 'WRATH_OF_AIR',
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
  },

  // Tank classes in the order they are picked to anchor the healer/tank group, first wins; every other class ranks
  // after them.
  tankAnchorOrder: ['PALADIN', 'WARRIOR'],

  // Penalty weight for a second copy of the same party-buff provider in one group; the penalty is triangular (a third
  // copy costs more than the second) and every matching entry adds. A matcher is { class, spec? }: no spec = every spec
  // of the class.
  stackPenalty: [
    { class: 'SHAMAN', weight: 10 },
    { class: 'SHAMAN', spec: 'Enhancement', weight: 30 },
    { class: 'PALADIN', spec: 'Retribution', weight: 8 },
    { class: 'DRUID', spec: 'Feral', weight: 30 },
    { class: 'DRUID', spec: 'Balance', weight: 4 },
  ],

  // DPS specs the healer/tank group takes as its one overflow seat (exempt from the DPS-guest penalty there).
  healerGroupDps: [
    { class: 'WARLOCK', spec: 'Affliction' },
  ],

  // Every tuning number and flag the optimizer reads (rules.* before this file), plus modeConfig (objective weights per
  // optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  conventions: {
    meleeWantsWindfury: true,
    meleeWantsWindfuryCost: 13,
    enhWindfuryBonus: 0.4,
    retEnhPairBonus: 8,
    ferociousInspiration: true,
    rosterShapedIdentities: true,
    hunterSpread: 2,
    hunterInCasterGroup: 20,
    hunterSpreadEnh: 24,
    extraEleNeedsBoomkin: 30,
    healerGroupDpsPull: 7,
    loneRestoTankCost: 25,
    tankGroupHealerCost: 15,
    rotationSearch: true,
    hunterTankGuestCost: 12,
    surplusEnhCost: 25,
    healerCapOverFloor: 1,
    modeConfig: {
      max_dps: { dps: 1.0, mit: 0.25, structure: 0.7, cohesion: 0.4 },
      tank_mit: { dps: 0.7, mit: 1.2, structure: 1.0, cohesion: 0.4 },
      balanced: { dps: 0.7, mit: 0.5, structure: 1.0, cohesion: 1.0 },
      relaxed: { dps: 0.2, mit: 0.3, structure: 1.0, cohesion: 1.5 },
    },
    openSlots: {
      utilityBonus: 6,
      specRepeat: 6,
      classCrowd: 4,
      classCrowdFree: 5,
    },
  },

  // Raids of this version in picker order; planning templates last.
  raids: {
    kara: { name: 'Karazhan', size: 10, groups: 2, tier: 'Tier 4' },
    gruul: { name: 'Gruul\'s Lair', size: 25, groups: 5, tier: 'Tier 4' },
    mag: { name: 'Magtheridon\'s Lair', size: 25, groups: 5, tier: 'Tier 4' },
    ssc: { name: 'Serpentshrine Cavern', size: 25, groups: 5, tier: 'Tier 5' },
    tk: { name: 'Tempest Keep', size: 25, groups: 5, tier: 'Tier 5' },
    za: { name: 'Zul\'Aman', size: 10, groups: 2, tier: 'Tier 5' },
    hyjal: { name: 'Hyjal Summit', size: 25, groups: 5, tier: 'Tier 6' },
    bt: { name: 'Black Temple', size: 25, groups: 5, tier: 'Tier 6' },
    swp: { name: 'Sunwell Plateau', size: 25, groups: 5, tier: 'Tier 6' },
  },

  // Class-presence utility checklist for the readiness sidebar: one-off or in-combat abilities, not always-on party
  // auras. providers lists { class, spec?, note? }; no spec = any spec of the class.
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
    BLOODLUST: {
      name: 'Bloodlust / Heroism',
      providers: [{ class: 'SHAMAN' }],
      desc: 'Raid-wide haste cooldown. Bloodlust (Horde) and Heroism (Alliance) are the same effect under different names.',
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
    MISDIRECTION: {
      name: 'Misdirection',
      providers: [{ class: 'HUNTER' }],
      desc: 'Redirects the hunter\'s threat to another party/raid member for their next few attacks — commonly used to give the tank a head start on pull threat.',
    },
  },

  // Reference compositions for the Compare-to-ideal tab: groups of five seats { class, spec, role }, group 1 first.
  idealComp: {
    // 25-man: 1 tank, 5 healers, 19 DPS (Ferals flex tank as needed).
    25: [
      // Group 1: Melee — LotP + WF + physical DPS
      [
        { class: 'DRUID', spec: 'Feral', role: 'melee_dps' },           // LotP, flex tank
        { class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' },    // WF + SoE
        { class: 'PALADIN', spec: 'Retribution', role: 'melee_dps' },
        { class: 'WARRIOR', spec: 'Arms', role: 'melee_dps' },
        { class: 'HUNTER', spec: 'Beast Mastery', role: 'ranged_dps' }, // FI + TSA
      ],
      // Group 2: Melee — LotP + WF + physical DPS
      [
        { class: 'DRUID', spec: 'Feral', role: 'melee_dps' },        // LotP, flex tank
        { class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' }, // WF + SoE
        { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' },
        { class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' },
        { class: 'HUNTER', spec: 'Survival', role: 'ranged_dps' },
      ],
      // Group 3: Casters — Mana Tide + Shadow Weaving + healer support
      [
        { class: 'MAGE', spec: 'Arcane', role: 'caster_dps' },
        { class: 'MAGE', spec: 'Arcane', role: 'caster_dps' },
        { class: 'SHAMAN', spec: 'Restoration', role: 'healer' }, // Mana Tide + WoA
        { class: 'PRIEST', spec: 'Shadow', role: 'caster_dps' },  // Shadow Weaving
        { class: 'PRIEST', spec: 'Holy', role: 'healer' },
      ],
      // Group 4: Casters — ToW + Moonkin Aura + Warlock stack
      [
        { class: 'WARLOCK', spec: 'Destruction', role: 'caster_dps' },
        { class: 'WARLOCK', spec: 'Destruction', role: 'caster_dps' },
        { class: 'WARLOCK', spec: 'Destruction', role: 'caster_dps' },
        { class: 'SHAMAN', spec: 'Elemental', role: 'caster_dps' },    // WoA + ToW
        { class: 'DRUID', spec: 'Balance', role: 'caster_dps' },       // Moonkin Aura
      ],
      // Group 5: Healers + Tank
      [
        { class: 'PALADIN', spec: 'Holy', role: 'healer' },
        { class: 'SHAMAN', spec: 'Restoration', role: 'healer' },     // Mana Tide
        { class: 'DRUID', spec: 'Restoration', role: 'healer' },
        { class: 'PALADIN', spec: 'Protection', role: 'tank' },
        { class: 'WARLOCK', spec: 'Affliction', role: 'caster_dps' },
      ],
    ],
    // 10-man: 2 tanks, 2 healers, 6 DPS.
    10: [
      // Group 1: Tanks + Melee + Shaman
      [
        { class: 'WARRIOR', spec: 'Protection', role: 'tank' },
        { class: 'DRUID', spec: 'Feral', role: 'tank' },             // LotP
        { class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' }, // WF + SoE
        { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' },
        { class: 'PALADIN', spec: 'Holy', role: 'healer' },          // Devotion Aura
      ],
      // Group 2: Casters + Healer
      [
        { class: 'SHAMAN', spec: 'Elemental', role: 'caster_dps' },     // WoA + ToW
        { class: 'WARLOCK', spec: 'Affliction', role: 'caster_dps' },
        { class: 'MAGE', spec: 'Arcane', role: 'caster_dps' },
        { class: 'HUNTER', spec: 'Beast Mastery', role: 'ranged_dps' }, // FI
        { class: 'PRIEST', spec: 'Holy', role: 'healer' },
      ],
    ],
  },

  // Greater Blessing catalog: the TBC copy of Assignments.DEFAULT_BLESSINGS (Classic and Forever keep using the
  // default).
  blessings: {
    KINGS: { name: 'Blessing of Kings', desc: 'Increases all stats by 10%.' },
    MIGHT: { name: 'Blessing of Might', desc: 'Increases attack power.' },
    WISDOM: { name: 'Blessing of Wisdom', desc: 'Restores mana over time.' },
    SALVATION: { name: 'Blessing of Salvation', desc: 'Reduces threat generated by 30%.' },
    LIGHT: { name: 'Blessing of Light', desc: 'Increases healing received and armor.' },
  },
};
