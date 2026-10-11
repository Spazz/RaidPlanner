/* ================================================================
   PARTY PLANNER WEB - rules data: WoW Forever (beta)
   ----------------------------------------------------------------
   WoW Forever (beta): party buffs and raid debuffs with their weights, the optimizer tuning numbers and
   raids. Rules follow the beta data of 2026-10-10 (build 1.60.1.70338); Forever has no faction lock.

   Source of truth: from Phase 2 of the rules data refactor on, this file replaces the hand-written tables in
   js/rules.js and js/optimizer.js and is edited by hand. Until then the app still reads those tables and
   rules-migration-tests.js pins that Rulesets.compile() rebuilds them from this file exactly. Generated once
   on 2026-10-11 by tools/generate-rules-data.js from the then-live tables. Design and vocabulary:
   tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-forever.md (WoW Forever beta audit of 2026-10-10 against build
   1.60.1.70338).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing.
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.forever = {
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
      desc: 'Party-wide buff in Forever (no longer a weapon enchant): each main-hand hit has a 20% chance to grant an extra attack with 246 extra attack power. Works in Cat and Bear form. A party has only one of Windfury, Grace of Air and Flametongue Totem, even from two shamans. Party, 30 yards, 5 min.',
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
          'DRUID:Feral': 8,
          melee_dps: 7,
          tank: 3,
        },
        mitigation: {
          'WARRIOR:Protection': 3,
          'PALADIN:Protection': 1,
          'DRUID:Feral': 3,
        },
      },
      exclusiveBuffs: ['GRACE_OF_AIR'],
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: null,
      desc: 'Increases agility of nearby party members by 89. Not active alongside Windfury Totem in the same party. Party, 30 yards.',
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
      exclusiveBuffs: ['WINDFURY'],
    },
    STRENGTH_OF_EARTH: {
      name: 'Strength of Earth Totem',
      spellId: null,
      desc: 'Increases strength of nearby party members by 53. Party, 30 yards.',
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
      spellId: null,
      desc: 'Reduces Physical damage taken by nearby party members by 30 per hit. Party, 30 yards.',
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
      spellId: null,
      desc: 'Restores 10 mana every 2 seconds to nearby party members. Group, 30 yards.',
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
      spellId: null,
      desc: 'Restores 290 mana every 3 seconds to nearby party members for 12 seconds (rank 3; 5 min cooldown). The 16-point Restoration talent. Group, 30 yards.',
      buffType: 'totem',
      totemElement: 'water',
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
      spellId: null,
      desc: 'Increases armor of nearby party members by 735. Party, 30 yards.',
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
    RETRIBUTION_AURA: {
      name: 'Retribution Aura',
      spellId: null,
      desc: 'Causes 20 Holy damage (plus 6% of the paladin\'s spell power) to any enemy that strikes nearby party members in melee. Party, 30 yards.',
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
    CONCENTRATION_AURA: {
      name: 'Concentration Aura',
      spellId: null,
      desc: 'Gives nearby party members a 35% chance to resist interruption from damage while casting. Party, 30 yards.',
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
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: null,
      desc: 'Increases melee attack power of nearby party members by 139 for 3 minutes (melee only; hunters gain nothing). Party, 20 yards (30 with Booming Voice), not raid-wide.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank', 'melee_dps'],
      priority: {
        melee_dps: 65,
        tank: 50,
      },
      weight: {
        dps: {
          melee_dps: 3,
          tank: 2,
        },
        mitigation: { '*': 2 },
      },
    },
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: null,
      desc: 'Marksmanship talent (21-point, row 4); higher ranks are trained once the talent is known. Increases ranged attack power of nearby party members by 75 at rank 4 (the level-60 rank 5 reads 50 in the beta). Ranged attack power only. Party, 45 yards.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'HUNTER',
      sourceSpec: 'Marksmanship',
      targetRoles: ['ranged_dps'],
      priority: 62,
      weight: {
        dps: { ranged_dps: 4 },
      },
    },
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: null,
      desc: 'Feral 21-point talent. While in Cat, Bear or Dire Bear Form, increases critical strike chance (melee, ranged and spell) of nearby party members by 3%. Mutually exclusive with Moonkin Aura — a group with both only benefits from one. Party, 45 yards.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps', 'caster_dps'],
      priority: {
        melee_dps: 78,
        ranged_dps: 78,
        caster_dps: 70,
        tank: 65,
      },
      weight: {
        dps: {
          melee_dps: 4,
          ranged_dps: 4,
          caster_dps: 3,
          tank: 2,
        },
        mitigation: {
          'DRUID:Feral': 5,
          '*': 2,
        },
      },
      exclusiveBuffs: ['MOONKIN_AURA'],
    },
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: null,
      desc: 'While in Moonkin Form, increases critical strike chance (melee, ranged and spell) of nearby party members by 3%. Mutually exclusive with Leader of the Pack — a group with both only benefits from one. Party, 45 yards.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps', 'caster_dps'],
      priority: {
        caster_dps: 72,
        melee_dps: 60,
        ranged_dps: 60,
        tank: 50,
      },
      weight: {
        dps: {
          caster_dps: 4,
          melee_dps: 2,
          ranged_dps: 2,
          tank: 1,
        },
      },
      exclusiveBuffs: ['LEADER_OF_THE_PACK'],
    },
    BLOOD_PACT: {
      name: 'Blood Pact',
      spellId: null,
      desc: 'Increases Stamina of nearby party members by 54 (via the Imp; Improved Imp no longer scales it). Party, 30 yards.',
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
  debuffs: {
    SUNDER_ARMOR: {
      name: 'Sunder Armor',
      spellId: null,
      desc: 'Reduces the target\'s armor by 450 per stack, up to 5 stacks (2250 total). Shares its slot with Expose Armor; the stronger effect stays.',
      debuffType: 'armor',
      sourceClass: 'WARRIOR',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['EXPOSE_ARMOR'],
    },
    EXPOSE_ARMOR: {
      name: 'Expose Armor',
      spellId: null,
      desc: 'Reduces the target\'s armor by 450 per combo point (2250 at 5), the same as five Sunder Armor stacks. Shares the slot with Sunder Armor.',
      debuffType: 'armor',
      sourceClass: 'ROGUE',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['SUNDER_ARMOR'],
    },
    FAERIE_FIRE: {
      name: 'Faerie Fire',
      spellId: null,
      desc: 'Reduces the target\'s armor by 505 for 40 seconds. Baseline for every Druid spec and castable in Cat, Bear and Dire Bear form. Does not stack with Curse of Recklessness.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_RECKLESSNESS'],
    },
    HUNTERS_MARK: {
      name: 'Hunter\'s Mark',
      spellId: null,
      desc: 'Increases the ranged attack power of all attackers against the target by 71 for 2 minutes (Improved Hunter\'s Mark is baseline). Ranged attack power only.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      targetRoles: ['ranged_dps'],
      weight: 3,
    },
    DEMORALIZING_SHOUT: {
      name: 'Demoralizing Shout',
      spellId: null,
      desc: 'Reduces the target\'s melee attack power by 210 for 45 seconds.',
      debuffType: 'attackPower',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_ROAR'],
    },
    DEMORALIZING_ROAR: {
      name: 'Demoralizing Roar',
      spellId: null,
      desc: 'Reduces the melee attack power of nearby enemies by 207 for 30 seconds (Bear form; equal to Demoralizing Shout at 60).',
      debuffType: 'attackPower',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_SHOUT'],
    },
    INSECT_SWARM: {
      name: 'Insect Swarm',
      spellId: null,
      desc: 'Reduces the target\'s chance to hit by 2% for 12 seconds (16-point Balance talent).',
      debuffType: 'hitChance',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank'],
      weight: 1,
    },
    THUNDER_CLAP: {
      name: 'Thunder Clap',
      spellId: null,
      desc: 'Increases the time between the target\'s attacks by 20% for 30 seconds (up to 4 targets).',
      debuffType: 'attackSpeed',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
    },
    CURSE_ELEMENTS: {
      name: 'Curse of the Elements',
      spellId: null,
      desc: 'Increases all magic damage taken by 10% and reduces all magic resistances by 75 for 5 minutes. One curse per warlock on a target (Curse of Shadows no longer exists).',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      targetRoles: ['caster_dps'],
      weight: 6,
      competesWith: ['CURSE_RECKLESSNESS'],
    },
    CURSE_RECKLESSNESS: {
      name: 'Curse of Recklessness',
      spellId: null,
      desc: 'Reduces the target\'s armor by 505 for 2 minutes (no attack power effect in Forever). Does not stack with Faerie Fire.',
      debuffType: 'armor',
      sourceClass: 'WARLOCK',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_ELEMENTS', 'FAERIE_FIRE'],
    },
    JUDGEMENT_CRUSADER: {
      name: 'Judgement of the Crusader',
      spellId: null,
      desc: 'Increases Holy damage taken by the target by 161 for 40 seconds, refreshed by the paladin\'s melee hits. Judgement no longer consumes the Seal; one Judgement per paladin on a target.',
      debuffType: 'holyVulnerability',
      sourceClass: 'PALADIN',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    JUDGEMENT_LIGHT: {
      name: 'Judgement of Light',
      spellId: null,
      desc: 'Melee attacks against the target have a chance to heal the attacker for 61. 40 seconds.',
      debuffType: 'healOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      weight: 1,
    },
    JUDGEMENT_WISDOM: {
      name: 'Judgement of Wisdom',
      spellId: null,
      desc: 'Attacks and spells against the target have a chance to restore 59 mana to the attacker. 40 seconds.',
      debuffType: 'manaOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['caster_dps'],
      weight: 1,
    },
  },

  // Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies,
  // so a top DPS is placed where it gets buffed before its buff goes to a weaker group.
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
    caster_dps: 'GRACE_OF_AIR',
    healer: 'GRACE_OF_AIR',
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
    Retribution: 'RETRIBUTION_AURA',
    Protection: 'DEVOTION_AURA',
    Holy: 'CONCENTRATION_AURA',
  },

  // Providers spread one per group instead of two stacking in one group while another group has none
  // (Optimizer.spreadProviders). spec may be a list; no spec = any spec of the class.
  spreadProviders: [
    { class: 'SHAMAN' },
    { class: 'PALADIN' },
    { class: 'DRUID', spec: ['Feral', 'Balance'] },
  ],

  // true: Shaman is Horde-only and Paladin Alliance-only; false: both classes exist on both factions.
  factionLock: false,

  // Tank classes in the order they are picked to anchor the healer/tank group, first wins; every other class ranks
  // after them.
  tankAnchorOrder: ['WARRIOR', 'PALADIN'],

  // Every tuning number and flag the optimizer reads (rules.* before this file), plus modeConfig (objective weights per
  // optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  conventions: {
    meleeWantsWindfury: true,
    ferociousInspiration: false,
    meleeGroupWindfuryBias: 8,
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
    f_barrow: { name: 'Barrow Deeps', size: 10, groups: 2, tier: 'Launch (Dec 9, 2026)' },
    f_hyjal: { name: 'Hyjal Summit', size: 20, groups: 4, tier: 'Launch (Dec 9, 2026)' },
    f_ony: { name: 'Onyxia\'s Lair', size: 40, groups: 8, tier: 'Launch (Dec 9, 2026)' },
    forever10: { name: '10-player template', size: 10, groups: 2, tier: 'Planning templates' },
    forever20: { name: '20-player template', size: 20, groups: 4, tier: 'Planning templates' },
    forever40: { name: '40-player template', size: 40, groups: 8, tier: 'Planning templates' },
  },
};
