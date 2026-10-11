/* ================================================================
   PARTY PLANNER WEB - rules data: WoW Forever (beta)
   ----------------------------------------------------------------
   WoW Forever (beta): party buffs and raid debuffs with their weights, the optimizer tuning numbers and
   raids. Rules follow the beta data of 2026-10-10 (build 1.60.1.70338); Forever has no faction lock.

   Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated
   once on 2026-10-11 from the then-live tables by tools/generate-rules-data.js (now a guarded record of the
   mapping, which refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load.
   Ids never change: saved plans and share links store them, and rules-data-tests.js pins them. Every number
   is explained: see README.md, Editing the rules. Design and vocabulary: tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-forever.md (WoW Forever beta audit of 2026-10-10 against build
   1.60.1.70338).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing. Also in code, not in these files: the Ideal-comp builders
   (js/app.js, faction-aware per version) and the blessing catalog (js/analysis.js,
   Assignments.DEFAULT_BLESSINGS).
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.forever = {
  // Party buffs the optimizer places, in display order. buffType drives the slot rule in code: one totem per element
  // per shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present.
  // weight.dps is what a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name,
  // else 0 (multiplied by the recipient's specDpsWeight); weight.dps: {} (a buff worth nothing to any recipient's DPS)
  // is written out on purpose, the key is explicit; weight.mitigation is the value to a tank (per CLASS:Spec, '*' = any
  // tank); weight.sustain is one number for healer groups. exclusiveBuffs lists the ids that share one slot per party
  // with this one (the better-valued member wins). priority only orders the buff list per role in the UI. spellId is
  // the max-rank spell, a verification handle.
  //
  // Vanilla/Classic Era baseline (no new classes or specs - the six new race/class combos and the Skyborne race only
  // widen WHO can play a class, never WHAT a class does), with the Forever deltas confirmed on 2026-10-10 against beta
  // build 1.60.1.70338 layered on. Source: tasks/research-forever.md, "Audit 2026-10-10", which supersedes the 09-26
  // browser pass.
  //
  // Tranquil Air Totem, Wrath of Air Totem and Totem of Wrath do not exist in Forever and are left out of the buffs (no
  // Tranquil Air, no Wrath of Air/Totem of Wrath - only the four totem elements that still exist in Forever). Sanctity
  // Aura and Improved Devotion/Retribution/Concentration Aura were removed; auras carry no healing-taken rider.
  //
  // The weights started as Classic's (the recipient DPS-weight ordering is the same: no new classes or specs) and
  // differ only where Forever's buff catalog does: Tranquil Air is dropped (it does not exist); Leader of the Pack and
  // Moonkin Aura are the same crit aura for every role; Windfury is worth something to Ferals (it is a party buff whose
  // procs work in Cat and Bear form, so Classic's 'DRUID:Feral': 0, a weapon-enchant rule, is overridden); Trueshot
  // Aura buffs ranged attack power only and Battle Shout melee only; Sanctity Aura does not exist; the paladin auras
  // carry no healing-taken rider, so the sustain weights equal Classic's.
  //
  // Known gaps, not modeled yet: hunter pet effects (Wolf Furious Howl party AP, Tallstrider armor, Carrion Bird AP;
  // need a per-player pet tag), Flametongue Totem, Healing Stream Totem, Vampiric Embrace, Vindication.
  buffs: {
    // Windfury Totem is a party-wide buff in Forever, no longer a weapon enchant, and its procs work in Cat/Bear form
    // (Blizzard 09-30 and 10-07), so a Feral gets value from it ('DRUID:Feral' weights, unlike Classic's 0).
    // preferSpec: 'Enhancement' is kept on purpose as a placement convention (keep melee together), not a value claim:
    // every shaman spec drops the same totem.
    WINDFURY: {
      name: 'Windfury Totem',
      spellId: 10614,
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
      // A party gets only one of Windfury / Grace of Air / Flametongue even from two shamans (Blizzard 10-07: "Parties
      // cannot benefit from this totem at the same time as Grace of Air or Flametongue Totem"; dev notes 09-24: no
      // stacking "even if used by different Shamans in the same group"), so a second shaman in a group adds only
      // earth/water totems. Buff ids that occupy one shared slot per group: resolveGroupBuffs and getGroupBuffs keep
      // only the higher-value member of each listed set.
      exclusiveBuffs: ['GRACE_OF_AIR'],
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: 25359,
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
      spellId: 25361,
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
      spellId: 10408,
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
      spellId: 10497,
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
      spellId: 17359,
      desc: 'Restores 290 mana every 3 seconds to nearby party members for 12 seconds (rank 3; 5 min cooldown). The 16-point Restoration talent. Group, 30 yards.',
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
    // Aura order is behaviour: a paladin keeps the EARLIER aura on a value tie, and the aura picker and the sidebar buff
    // list show them in this order, so keep Devotion, Concentration, Retribution.
    CONCENTRATION_AURA: {
      name: 'Concentration Aura',
      spellId: 19746,
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
    RETRIBUTION_AURA: {
      name: 'Retribution Aura',
      spellId: 10301,
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
    // Battle Shout is a plain passive here (no warrior shout slot) and buffs melee only.
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: 25289,
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
    // Trueshot Aura is the Marksmanship 21-point talent in Forever and buffs ranged attack power only (sourceSpec,
    // targetRoles).
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: 20906,
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
    // Leader of the Pack and Moonkin Aura are the same +3% all-school crit aura in Forever (melee, ranged AND spell
    // crit) and mutually exclusive (exclusiveBuffs), so each is worth something to every role, unlike Classic's
    // melee-only LotP and caster-only Moonkin they were copied from. The weights are scaled to the priority values.
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: 17007,
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
      // Leader of the Pack / Moonkin Aura are one crit aura: a group with both only benefits from one (exclusiveBuffs;
      // the higher-value member is kept).
      exclusiveBuffs: ['MOONKIN_AURA'],
    },
    // See Leader of the Pack: the same crit aura, one shared slot.
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: 24907,
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
      spellId: 11767,
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
  //
  // Same non-stacking-slot model as the TBC debuffs (competesWith/supersededBy). Debuffs list only confirmed raid
  // debuffs. Personal-only effects are left out on purpose: Shadow Weaving, Winter's Chill, Improved Scorch, Improved
  // Shadow Bolt, Hemorrhage, Stormstrike ("from the caster" auras); Mangle is now Primal Bite without a debuff; Curse
  // of Shadows is gone.
  debuffs: {
    SUNDER_ARMOR: {
      name: 'Sunder Armor',
      spellId: 11597,
      desc: 'Reduces the target\'s armor by 450 per stack, up to 5 stacks (2250 total). Shares its slot with Expose Armor; the stronger effect stays.',
      debuffType: 'armor',
      sourceClass: 'WARRIOR',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['EXPOSE_ARMOR'],
    },
    EXPOSE_ARMOR: {
      name: 'Expose Armor',
      spellId: 11198,
      desc: 'Reduces the target\'s armor by 450 per combo point (2250 at 5), the same as five Sunder Armor stacks. Shares the slot with Sunder Armor.',
      debuffType: 'armor',
      sourceClass: 'ROGUE',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['SUNDER_ARMOR'],
    },
    // Faerie Fire is one baseline spell for every Druid spec (castable in forms); it does not stack with Curse of
    // Recklessness.
    FAERIE_FIRE: {
      name: 'Faerie Fire',
      spellId: 9907,
      desc: 'Reduces the target\'s armor by 505 for 40 seconds. Baseline for every Druid spec and castable in Cat, Bear and Dire Bear form. Does not stack with Curse of Recklessness.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_RECKLESSNESS'],
    },
    // targetRoles is ranged_dps only: Forever's Hunter's Mark gives ranged attack power only, so it helps hunters only
    // (the same spell differs by version, so this entry carries its own weight and targetRoles).
    HUNTERS_MARK: {
      name: 'Hunter\'s Mark',
      spellId: 14325,
      desc: 'Increases the ranged attack power of all attackers against the target by 71 for 2 minutes (Improved Hunter\'s Mark is baseline). Ranged attack power only.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      targetRoles: ['ranged_dps'],
      weight: 3,
    },
    DEMORALIZING_SHOUT: {
      name: 'Demoralizing Shout',
      spellId: 11556,
      desc: 'Reduces the target\'s melee attack power by 210 for 45 seconds.',
      debuffType: 'attackPower',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_ROAR'],
    },
    DEMORALIZING_ROAR: {
      name: 'Demoralizing Roar',
      spellId: 9898,
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
      spellId: 24977,
      desc: 'Reduces the target\'s chance to hit by 2% for 12 seconds (16-point Balance talent).',
      debuffType: 'hitChance',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank'],
      weight: 1,
    },
    THUNDER_CLAP: {
      name: 'Thunder Clap',
      spellId: 11581,
      desc: 'Increases the time between the target\'s attacks by 20% for 30 seconds (up to 4 targets).',
      debuffType: 'attackSpeed',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
    },
    CURSE_ELEMENTS: {
      name: 'Curse of the Elements',
      spellId: 1311680,
      desc: 'Increases all magic damage taken by 10% and reduces all magic resistances by 75 for 5 minutes. One curse per warlock on a target (Curse of Shadows no longer exists).',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      targetRoles: ['caster_dps'],
      weight: 6,
      competesWith: ['CURSE_RECKLESSNESS'],
    },
    CURSE_RECKLESSNESS: {
      name: 'Curse of Recklessness',
      spellId: 11717,
      desc: 'Reduces the target\'s armor by 505 for 2 minutes (no attack power effect in Forever). Does not stack with Faerie Fire.',
      debuffType: 'armor',
      sourceClass: 'WARLOCK',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_ELEMENTS', 'FAERIE_FIRE'],
    },
    JUDGEMENT_CRUSADER: {
      name: 'Judgement of the Crusader',
      spellId: 20303,
      desc: 'Increases Holy damage taken by the target by 161 for 40 seconds, refreshed by the paladin\'s melee hits. Judgement no longer consumes the Seal; one Judgement per paladin on a target.',
      debuffType: 'holyVulnerability',
      sourceClass: 'PALADIN',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    JUDGEMENT_LIGHT: {
      name: 'Judgement of Light',
      spellId: 20346,
      desc: 'Melee attacks against the target have a chance to heal the attacker for 61. 40 seconds.',
      debuffType: 'healOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      weight: 1,
    },
    JUDGEMENT_WISDOM: {
      name: 'Judgement of Wisdom',
      spellId: 20355,
      desc: 'Attacks and spells against the target have a chance to restore 59 mana to the attacker. 40 seconds.',
      debuffType: 'manaOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['caster_dps'],
      weight: 1,
    },
  },

  // Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies,
  // so a top DPS is placed where it gets buffed before its buff goes to a weaker group.
  //
  // Same roster of specs as Classic (no new classes or specs in Forever), so the ordering started out identical to
  // Classic's (a rough heuristic, not log-calibrated). It is its own copy now, edited apart from Classic's.
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
  //
  // No Tranquil Air exists for casters/healers to fall back to - Grace of Air (agility) is the only other air totem, so
  // it's the least-bad default.
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
  //
  // Sanctity Aura no longer exists, so a Ret paladin's own aura is Retribution Aura; specAura only breaks value ties
  // between equally valued auras.
  specAura: {
    Retribution: 'RETRIBUTION_AURA',
    Protection: 'DEVOTION_AURA',
    Holy: 'CONCENTRATION_AURA',
  },

  // Providers spread one per group instead of two stacking in one group while another group has none
  // (Optimizer.spreadProviders). spec may be a list; no spec = any spec of the class.
  //
  // Same single-point-of-failure spreading as Classic (Optimizer.spreadProviders/_spreadPass), plus the Feral/Balance
  // druid crit auras - now mutually exclusive with each other (see exclusiveBuffs), so a group needs exactly one
  // crit-aura druid, not one of each. The array form of spec groups Feral and Balance together for _spreadPass's
  // matcher (one druid of either spec already satisfies a group; a second of either is surplus).
  spreadProviders: [
    { class: 'SHAMAN' },
    { class: 'PALADIN' },
    { class: 'DRUID', spec: ['Feral', 'Balance'] },
  ],

  // true: Shaman is Horde-only and Paladin Alliance-only; false: both classes exist on both factions.
  //
  // No faction lock in Forever: the six new race/class combos put Paladin and Shaman on both factions, so a raid can
  // field both totems and auras, and a mixed shaman+paladin roster is normal rather than a data problem.
  factionLock: false,

  // Tank classes in the order they are picked to anchor the healer/tank group, first wins; every other class ranks
  // after them.
  //
  // Both Warrior and Paladin tank on either faction now; Warrior stays the conventional premier tank (vanilla baseline
  // unchanged), Paladin a strong and now cross-faction off-tank.
  tankAnchorOrder: ['WARRIOR', 'PALADIN'],

  // Every tuning number and flag the optimizer reads (rules.* before this file), plus modeConfig (objective weights per
  // optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  //
  // These are small hooks the optimizer consults instead of hardcoded class/spec checks, so a version can turn one off
  // or swap its value; a key that is absent is off (the Classic and Forever files leave out the TBC-only ones).
  conventions: {
    // meleeWantsWindfury: Shaman exists on both factions - no faction gate needed.
    meleeWantsWindfury: true,
    // ferociousInspiration: a TBC-only Beast Mastery talent; it does not exist in Forever.
    ferociousInspiration: false,
    // Same Windfury-over-Grace-of-Air structural nudge as Classic - see conventions.meleeGroupWindfuryBias in
    // classic.js for the full rationale.
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
  // The real WoW Forever raids are confirmed via a full-page browser read of Wowhead's raids-overview guide
  // (tasks/research-forever.md, "Browser verification" section, "Raids" table) - launching December 9, 2026. The 'f_'
  // prefix keeps these unique from Classic's 'ony' key (Onyxia exists in both games). The foreverN planning templates
  // come after the real raids so old saved plans (keyed on foreverN) keep working; they are planning capacities chosen
  // by the user, not claims about beta raid sizes.
  raids: {
    f_barrow: { name: 'Barrow Deeps', size: 10, groups: 2, tier: 'Launch (Dec 9, 2026)' },
    f_hyjal: { name: 'Hyjal Summit', size: 20, groups: 4, tier: 'Launch (Dec 9, 2026)' },
    f_ony: { name: 'Onyxia\'s Lair', size: 40, groups: 8, tier: 'Launch (Dec 9, 2026)' },
    forever10: { name: '10-player template', size: 10, groups: 2, tier: 'Planning templates' },
    forever20: { name: '20-player template', size: 20, groups: 4, tier: 'Planning templates' },
    forever40: { name: '40-player template', size: 40, groups: 8, tier: 'Planning templates' },
  },

  // Class-presence utility checklist for the readiness sidebar: one-off or in-combat abilities, not always-on party
  // auras. providers lists { class, spec?, note? }; no spec = any spec of the class.
  // Utilities: copied from the Classic list on 2026-10-11; verify for Forever. Forever has its own copy on purpose
  // (the games are independent), so edit it without touching Classic's.
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
