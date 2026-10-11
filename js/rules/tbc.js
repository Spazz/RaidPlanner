/* ================================================================
   PARTY PLANNER WEB - rules data: TBC
   ----------------------------------------------------------------
   WoW TBC: party buffs and raid debuffs with their weights, the optimizer tuning numbers, raids and
   utilities.

   Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated
   once on 2026-10-11 from the then-live tables by tools/generate-rules-data.js (now a guarded record of the
   mapping, which refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load.
   Ids never change: saved plans and share links store them, and rules-data-tests.js pins them. Every number
   is explained: see README.md, Editing the rules. Design and vocabulary: tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-synergy-sheet.md (Lokgol TBC synergy tiers) and
   gruul_dps_data.txt (DPS weights).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing. Also in code, not in these files: the Ideal-comp builders
   (js/app.js, faction-aware per version) and the blessing catalog (js/analysis.js,
   Assignments.DEFAULT_BLESSINGS).
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.tbc = {
  // Party buffs the optimizer places, in display order. buffType drives the slot rule in code: one totem per element
  // per shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present.
  // weight.dps is what a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name,
  // else 0 (multiplied by the recipient's specDpsWeight); weight.dps: {} (a buff worth nothing to any recipient's DPS)
  // is written out on purpose, the key is explicit; weight.mitigation is the value to a tank (per CLASS:Spec, '*' = any
  // tank); weight.sustain is one number for healer groups. exclusiveBuffs lists the ids that share one slot per party
  // with this one (the better-valued member wins). priority only orders the buff list per role in the UI. spellId is
  // the max-rank spell, a verification handle.
  //
  // The weights are tier values on a relative scale, NOT measured % gains. Ordering cross-checked against Lokgol's TBC
  // synergy sheet (0-4 tiers; tasks/research-synergy-sheet.md): WF is the top tier, ToW / Moonkin / LotP / FI the next,
  // WoA / SoE / GoA / UR / Sanctity below that. A trailing "synergy sheet tier N for X" comment on a weight gives the
  // sheet's own rating of that recipient, for comparison: this file's scale is its own, so compare the order of the
  // buffs, not the numbers. A weight without one has no tier in the sheet, which does not model Mana Spring, Mana Tide
  // or Concentration Aura, does not list Retribution Aura and rates Trueshot Aura only as "party physical".
  // buffType and totemElement say which element a totem occupies and which auras a paladin can run (from the addon's
  // Optimizer.lua); bestAirTotem and bestPaladinAura below are the default pick per role.
  //
  // weight.mitigation, researched priorities: Prot Warrior: armor (Devotion, ~5-7% phys DR) + block value (SoE). Prot
  // Paladin: armor + dodge (Grace of Air) + spell power (Wrath of Air feeds Holy Shield / Consecration threat; worth
  // more to them than WF). Feral Druid: agility scaling (GoA) + Imp LotP heal; low Devotion value (high base armor),
  // zero Windfury (no weapon imbues in forms). Tree of Life (+25% healing received, party-only) is huge for any tank.
  //
  // weight.sustain: healer-sustain buffs give extra value in the tank group per healer present (capped at 2) - Mana
  // Tide/Spring keep tank healers casting, VT feeds their mana, Concentration Aura protects their casts.
  buffs: {
    // Windfury: Ret > Fury > Arms > Rogues (main-hand only). Feral druids get NOTHING from WF (weapon imbues don't work
    // in forms), hence the 0 key. Hunters don't benefit either (melee-weapon imbue; the role table omits ranged).
    WINDFURY: {
      name: 'Windfury Totem',
      spellId: 25587,
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
          'DRUID:Feral': 0, // synergy sheet tier 0 for Feral/Bear
          melee_dps: 8, // synergy sheet tier 4 for melee
          tank: 3,
        },
        mitigation: {
          'WARRIOR:Protection': 4, // synergy sheet tier 4 for Prot War
          'PALADIN:Protection': 1, // synergy sheet tier 4 for Prot Pal; this file's 1 differs (sheet notes, item 3)
          'DRUID:Feral': 0, // synergy sheet tier 0 for Feral/Bear
        },
      },
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: 25359,
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
          melee_dps: 2, // synergy sheet tier 2 for melee
          ranged_dps: 3, // synergy sheet tier 2 for hunters
          tank: 2,
        },
        mitigation: {
          'WARRIOR:Protection': 4,
          'PALADIN:Protection': 7,
          'DRUID:Feral': 9, // synergy sheet tier 3 for Bear
        },
      },
    },
    WRATH_OF_AIR: {
      name: 'Wrath of Air Totem',
      spellId: 3738,
      desc: 'Increases spell power of nearby party members by 101.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'caster_dps', 'healer'],
      priority: 85,
      weight: {
        dps: {
          caster_dps: 4, // synergy sheet tier 2 for casters
          healer: 2, // synergy sheet tier 2 for healers
        },
        mitigation: { 'PALADIN:Protection': 5 }, // synergy sheet tier 2 for tanks (Prot Pal spell power)
      },
    },
    // 2026-10-10 comp rules 2/3: the crit auras (this and Moonkin Aura) are worth clearly more to Destruction Locks
    // (they scale with spell crit far more than Arcane/Affliction) so the Ele and the Boomkin join the Destro group;
    // Arcane's Mana Spring/Tide keys stay, they draw the Resto Shaman to the mages.
    TOTEM_OF_WRATH: {
      name: 'Totem of Wrath',
      spellId: 30706,
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
          caster_dps: 6, // synergy sheet tier 3 for casters
          healer: 1, // synergy sheet tier 1 for healers
        },
      },
    },
    MANA_SPRING: {
      name: 'Mana Spring Totem',
      spellId: 25570,
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
      spellId: 16190,
      desc: 'Restores 24% of total mana to nearby party members over 12 seconds.',
      buffType: 'totem',
      totemElement: 'water',
      // cooldownTotem: the scorer credits Mana Tide on top of the shaman's standing element totem; it does not occupy
      // the water slot (see Optimizer.resolveGroupBuffs).
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
      spellId: 25528,
      desc: 'Increases strength of nearby party members by 86.',
      buffType: 'totem',
      totemElement: 'earth',
      scope: 'party',
      sourceClass: 'SHAMAN',
      targetRoles: ['tank', 'melee_dps'],
      priority: 55,
      weight: {
        dps: {
          melee_dps: 2, // synergy sheet tier 2 for melee
          tank: 2, // synergy sheet tier 2 for tanks
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
      spellId: 27149,
      desc: 'Increases armor of nearby party members by 861.',
      buffType: 'paladinAura',
      scope: 'party',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      priority: 75,
      weight: {
        dps: {},
        mitigation: {
          'WARRIOR:Protection': 10, // synergy sheet tier 2 for tanks
          'PALADIN:Protection': 10, // synergy sheet tier 2 for tanks
          'DRUID:Feral': 5, // synergy sheet tier 2 for tanks
        },
      },
    },
    CONCENTRATION_AURA: {
      name: 'Concentration Aura',
      spellId: 19746,
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
      spellId: 27150,
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
      spellId: 20218,
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
          melee_dps: 2, // synergy sheet tier 2 for everyone (Imp Sanctity Aura)
          ranged_dps: 2, // synergy sheet tier 2 for everyone (Imp Sanctity Aura)
          caster_dps: 2, // synergy sheet tier 2 for everyone (Imp Sanctity Aura)
          tank: 1, // synergy sheet tier 2 for everyone (Imp Sanctity Aura)
        },
      },
    },
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: 17007,
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
          melee_dps: 5, // synergy sheet tier 3 for melee
          ranged_dps: 5, // synergy sheet tier 3 for hunters
          tank: 2,
        },
        mitigation: {
          'DRUID:Feral': 6, // synergy sheet tier 3 for Bear (self)
          '*': 2,
        },
      },
    },
    // The Destruction Lock key is the 2026-10-10 comp rules 2/3 weight, see Totem of Wrath.
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: 24907,
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
          caster_dps: 5, // synergy sheet tier 3 for casters
        },
      },
    },
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: 27066,
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
    // Ferocious Inspiration is 3% damage for the whole party, any role.
    FEROCIOUS_INSP: {
      name: 'Ferocious Inspiration',
      spellId: 34460,
      desc: 'When your pet scores a critical hit, all party members gain 3% increased damage for 10 seconds.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'HUNTER',
      sourceSpec: 'Beast Mastery',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps', 'caster_dps'],
      priority: 58,
      weight: {
        dps: {
          melee_dps: 3, // synergy sheet tier 3 for everyone
          ranged_dps: 3, // synergy sheet tier 3 for everyone
          caster_dps: 3, // synergy sheet tier 3 for everyone
          tank: 1, // synergy sheet tier 3 for everyone; this file weights tanks lower
        },
      },
    },
    TREE_OF_LIFE: {
      name: 'Tree of Life',
      spellId: 33891,
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
        dps: { healer: 1 }, // synergy sheet tier 1 for others
        mitigation: { '*': 12 }, // synergy sheet tier 3-4 for tanks
      },
    },
    UNLEASHED_RAGE: {
      name: 'Unleashed Rage',
      spellId: 30811,
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
          melee_dps: 5, // synergy sheet tier 2 for melee
          tank: 2,
        },
      },
    },
    // Battle Shout and Commanding Shout fill the warrior shout slot: each warrior casts ONE of them per group (the
    // resolver picks by group value; a second warrior covers the other).
    //
    // A ruleset with no warriorShout entry simply credits every warrior Battle Shout as a passive (Classic, Forever).
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: 2048,
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
          melee_dps: 3, // synergy sheet tier 3 for melee (Imp Battle Shout)
          ranged_dps: 2,
          tank: 2, // synergy sheet tier 2 for tanks (Imp Battle Shout)
        },
        mitigation: { '*': 2 }, // synergy sheet tier 2 for tanks (Imp Battle Shout)
      },
    },
    COMMANDING_SHOUT: {
      name: 'Commanding Shout',
      spellId: 469,
      desc: 'Increases maximum health of nearby party members by 1080 for 2 minutes. The planner models one shout per warrior, so a second warrior covers the other.',
      buffType: 'warriorShout',
      scope: 'party',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      priority: 35,
      weight: {
        dps: {},
        mitigation: { '*': 5 }, // synergy sheet tier 2 for tanks
      },
    },
    BLOOD_PACT: {
      name: 'Blood Pact',
      spellId: 27268,
      desc: 'Increases max health of nearby party members by 1330.',
      buffType: 'passive',
      scope: 'party',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      priority: 40,
      weight: {
        dps: { tank: 1 },
        mitigation: { '*': 6 }, // synergy sheet tier 2 for tanks (Imp Blood Pact)
      },
    },
    // Vampiric Touch is a party mana battery: a Holy Priest spamming Circle of Healing needs it most, then Arcane/other
    // mages. Warlocks barely do - Life Tap covers their mana - so a lock no longer outbids the priest for the Shadow
    // Priest's group.
    VAMPIRIC_TOUCH: {
      name: 'Vampiric Touch',
      spellId: 34917,
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
          caster_dps: 4, // synergy sheet tier 3-4 for casters
          healer: 3, // synergy sheet tier 3-4 for healers
        },
        sustain: 3,
      },
    },
  },

  // Raid debuffs, applied to the enemy. weight is the Open-slot tier (same scale as weight.dps); targetRoles, and
  // targetSchool which narrows casters to one school, say who profits. competesWith and supersededBy model the
  // non-stacking debuff slots. debuffType is descriptive only.
  //
  // family/competesWith/supersededBy model non-stacking debuff slots - see
  // https://www.warcrafttavern.com/tbc/guides/warlock-curses/ and
  // https://www.warcrafttavern.com/tbc/guides/rogue-expose-armor/ for the mechanics.
  //
  // A raid debuff is worth what a party buff of the same value would be to every raid member it actually helps. weight
  // is on the weight.dps scale (Trueshot Aura's 125 AP = 3-4 per player) and targetRoles says who it helps:
  // ['melee_dps', 'ranged_dps'] = physical (melee and hunters), ['caster_dps'] = casters (with targetSchool: one spell
  // school), ['tank'] = defensive (tier per tank, mitigation-weighted), all three DPS roles = every DPS. Expose
  // Weakness (~225 AP to every physical attacker) is why a Survival Hunter beats a Marksmanship one whose Trueshot Aura
  // only reaches its own party. An entry carries its own weight and targetRoles when the same spell differs by version
  // (Forever's Hunter's Mark).
  debuffs: {
    JUDGEMENT_CRUSADER: {
      name: 'Judgement of the Crusader',
      spellId: 27159,
      desc: 'Attackers have a 3% increased chance to critically hit the target, which also takes 219 increased Holy damage.',
      debuffType: 'holyVulnerability',
      sourceClass: 'PALADIN',
      sourceSpec: 'Retribution',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    JUDGEMENT_LIGHT: {
      name: 'Judgement of Light',
      spellId: 27162,
      desc: 'Melee attackers have a chance to heal themselves for 95 health.',
      debuffType: 'healOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['tank'],
      weight: 1,
    },
    JUDGEMENT_WISDOM: {
      name: 'Judgement of Wisdom',
      spellId: 27164,
      desc: 'Attacks and spells against the target have a chance to restore 74 mana.',
      debuffType: 'manaOnHit',
      sourceClass: 'PALADIN',
      targetRoles: ['caster_dps'],
      weight: 1,
    },
    SUNDER_ARMOR: {
      name: 'Sunder Armor',
      spellId: 25225,
      desc: 'Reduces the target\'s armor by up to 2600 (5 stacks).',
      debuffType: 'armor',
      sourceClass: 'WARRIOR',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['EXPOSE_ARMOR'],
    },
    DEMORALIZING_SHOUT: {
      name: 'Demoralizing Shout',
      spellId: 25203,
      desc: 'Reduces the target\'s melee attack power by 300 (420 with Improved Demoralizing Shout).',
      debuffType: 'attackPower',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['DEMORALIZING_ROAR', 'CURSE_WEAKNESS'],
    },
    THUNDER_CLAP: {
      name: 'Thunder Clap',
      spellId: 25264,
      desc: 'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).',
      debuffType: 'attackSpeed',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank'],
      weight: 2,
    },
    BLOOD_FRENZY: {
      name: 'Blood Frenzy',
      spellId: 29859,
      desc: 'Increases Physical damage taken by the target by 4%.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'WARRIOR',
      sourceSpec: 'Arms',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 4,
    },
    EXPOSE_ARMOR: {
      name: 'Expose Armor',
      spellId: 26866,
      desc: 'Reduces the target\'s armor by 2050 (3075 with Improved Expose Armor).',
      debuffType: 'armor',
      sourceClass: 'ROGUE',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
      competesWith: ['SUNDER_ARMOR'],
    },
    HEMORRHAGE: {
      name: 'Hemorrhage',
      spellId: 26864,
      desc: 'Increases Physical damage taken by the target by 42, for 10 charges.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'ROGUE',
      sourceSpec: 'Subtlety',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 1,
    },
    FAERIE_FIRE_BALANCE: {
      name: 'Faerie Fire',
      spellId: 26993,
      desc: 'Reduces the target\'s armor by 610 and, with Improved Faerie Fire, gives attackers +3% chance to hit.',
      debuffType: 'armor',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    FAERIE_FIRE_FERAL: {
      name: 'Faerie Fire (Feral)',
      spellId: 27011,
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
      spellId: 33983,
      desc: 'Increases damage taken from bleed effects by 30%.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 1,
    },
    DEMORALIZING_ROAR: {
      name: 'Demoralizing Roar',
      spellId: 26998,
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
      spellId: 27013,
      desc: 'Reduces the target\'s chance to hit by 2%.',
      debuffType: 'hitChance',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['tank'],
      weight: 1,
    },
    CURSE_ELEMENTS: {
      name: 'Curse of the Elements',
      spellId: 27228,
      desc: 'Reduces resistance to Fire/Frost/Shadow by 88 and increases Arcane/Fire/Frost/Shadow damage taken by 10%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      targetRoles: ['caster_dps'],
      weight: 6,
      competesWith: ['CURSE_RECKLESSNESS', 'CURSE_WEAKNESS'],
    },
    CURSE_RECKLESSNESS: {
      name: 'Curse of Recklessness',
      spellId: 27226,
      desc: 'Increases melee attack power by 135 but reduces armor by 800.',
      debuffType: 'armor',
      sourceClass: 'WARLOCK',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_WEAKNESS'],
    },
    CURSE_WEAKNESS: {
      name: 'Curse of Weakness',
      spellId: 30909,
      desc: 'Reduces the target\'s melee attack power by 350.',
      debuffType: 'attackPower',
      sourceClass: 'WARLOCK',
      targetRoles: ['tank'],
      weight: 2,
      competesWith: ['CURSE_ELEMENTS', 'CURSE_RECKLESSNESS', 'DEMORALIZING_SHOUT', 'DEMORALIZING_ROAR'],
    },
    SHADOW_EMBRACE: {
      name: 'Shadow Embrace',
      spellId: 32394,
      desc: 'Reduces the target\'s Physical damage dealt by 5%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'WARLOCK',
      sourceSpec: 'Affliction',
      targetRoles: ['tank'],
      weight: 1,
    },
    IMPROVED_SHADOW_BOLT: {
      name: 'Improved Shadow Bolt',
      spellId: 17803,
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
      spellId: 28595,
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
      spellId: 12873,
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
      spellId: 15334,
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
      spellId: 33195,
      desc: 'Increases Spell damage taken by the target by 5%.',
      debuffType: 'magicVulnerability',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['caster_dps'],
      weight: 4,
    },
    // No Open-slot tier was ever listed for this one: it is priced at the old default for an unlisted debuff (tier 2,
    // every DPS role).
    VAMPIRIC_EMBRACE: {
      name: 'Vampiric Embrace',
      spellId: 15286,
      desc: 'Heals the caster\'s party for 15% of the Priest\'s damage dealt to the target.',
      debuffType: 'other',
      sourceClass: 'PRIEST',
      sourceSpec: 'Shadow',
      targetRoles: ['melee_dps', 'ranged_dps', 'caster_dps'],
      weight: 2,
    },
    STORMSTRIKE: {
      name: 'Stormstrike',
      spellId: 17364,
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
      spellId: 3043,
      desc: 'Reduces the target\'s chance to hit with melee/ranged attacks by 5%.',
      debuffType: 'hitChance',
      sourceClass: 'HUNTER',
      targetRoles: ['tank'],
      weight: 1,
    },
    HUNTERS_MARK: {
      name: 'Hunter\'s Mark',
      spellId: 14325,
      desc: 'Grants attackers 110 increased melee/ranged attack power against the target.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 3,
    },
    EXPOSE_WEAKNESS: {
      name: 'Expose Weakness',
      spellId: 34503,
      desc: 'Grants attackers bonus attack power equal to 25% of the Hunter\'s Agility.',
      debuffType: 'physicalVulnerability',
      sourceClass: 'HUNTER',
      sourceSpec: 'Survival',
      targetRoles: ['melee_dps', 'ranged_dps'],
      weight: 6,
    },
  },

  // Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies:
  // the same tier on a 950-DPS hunter beats it on a 500-DPS boomkin, so a top DPS is placed where THEY get buffed
  // before their buff goes to a weaker group.
  //
  // Calibrated from a live Gruul log (PartyPlannerWeb/gruul_dps_data.txt): Aff ~1000, BM ~950/880, Arcane ~930/880/760,
  // Destro ~930/810/640, Combat ~900/740, Ele ~870, Fury ~730, Enh ~730, Ret ~630, Boomkin ~510, Prot Pal ~470, Feral
  // tank ~460. Unlogged specs are placed by class analogy.
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
  //
  // 2026-10-10 comp rule 4 (one Feral per group) and the any-shaman-drops-WF spread: raised from SHAMAN 10 / Feral 8 so
  // a second copy in a group is worth less than a seat elsewhere. Party-buff providers whose second copy in one group
  // mostly duplicates the first (totems share elements, LotP/Moonkin/Sanctity don't stack) while another group goes
  // without. See Optimizer.groupScore.
  stackPenalty: [
    { class: 'SHAMAN', weight: 10 },
    // Extra weight on a second Enh (Windfury copies do not stack); only Enh, since raising it for every shaman broke
    // T46's bench trade.
    { class: 'SHAMAN', spec: 'Enhancement', weight: 30 },
    { class: 'PALADIN', spec: 'Retribution', weight: 8 },
    { class: 'DRUID', spec: 'Feral', weight: 30 },
    { class: 'DRUID', spec: 'Balance', weight: 4 },
  ],

  // DPS specs the reference comp parks in the healer/tank group as its one overflow seat (exempt from the DPS-guest
  // penalty there). See Optimizer.groupScore.
  healerGroupDps: [
    { class: 'WARLOCK', spec: 'Affliction' },
  ],

  // Every tuning number and flag the optimizer reads (rules.* in js/optimizer.js), plus modeConfig (objective weights
  // per optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  //
  // These are small hooks the optimizer consults instead of hardcoded class/spec checks, so a version can turn one off
  // or swap its value. Every key is present in every version file (Rulesets.CONVENTIONS in js/rules.js is the closed
  // list, and Rulesets.compile stops the page at load on a missing, an unknown or a mistyped key, so a misspelled
  // knob cannot be ignored): a number of 0 and a flag of false switch that rule off for this version, and
  // healerCapOverFloor: null means no cap (the only key whose off state has no number). The line above each key gives
  // its unit, what it trades against and the boards-tests.js fixtures that move when it changes; node boards-tests.js
  // shows who moves after an edit of your own.
  conventions: {
    // ---- Switches: on or off for the whole version ----

    // meleeWantsWindfury: a melee group with no shaman is missing WF.
    //
    // flag: charge a melee group that has no shaman (meleeWantsWindfuryCost) and explain its shaman as keeping Windfury
    // coverage; trades Windfury coverage against the shaman's other seats; off moves F01, F03, F05, F13, F14, +24 more.
    meleeWantsWindfury: true,
    // ferociousInspiration: a BM Hunter's FI stacks multiplicatively per hunter.
    //
    // flag: credit each extra Beast Mastery hunter in a group with ferociousInspirationStacking of the FI value; trades
    // BM pairs against spreading hunters; off moves F03, F13, F15, F32, P17, +1 more.
    ferociousInspiration: true,
    // rosterShapedIdentities: the melee/caster group count follows the DPS mix (Optimizer.roleIdentitiesFor).
    //
    // flag: the melee/caster group count follows the roster's physical vs caster DPS headcount, not a half-and-half
    // split; trades melee-group seats against caster-group seats; off moves F01, F03, F05, F06, F07, +27 more.
    rosterShapedIdentities: true,
    // Search depth beyond swaps/exchanges (2026-10-10 comp rules: the reference comp needs moves like the suggested Ret
    // rotating to the Enh Shaman's group while a displaced player takes its seat): 3-cycle rotations in the refine
    // rounds plus a guarded final refine after de-isolation. False in Classic and Forever, so their boards are
    // unchanged (and their 40-man boards skip the extra cost). See Optimizer.refineRotations.
    //
    // flag: the refine rounds also try 3-cycle rotations, plus a guarded final refine after de-isolation; trades
    // Optimize time for boards that plain swaps cannot reach; off moves F01, F02, F03, F05, F09, +18 more.
    rotationSearch: true,

    // ---- Windfury and shamans ----

    // 2026-10-10 comp rule 1 (any shaman drops Windfury for melee): per-melee cost (x dpsWeight x structure) of a melee
    // group with no shaman; sized so a spare Ele/Resto is worth pulling to it. 14 breaks drums-tests (spreadDrummers);
    // 13 is the highest value that keeps it green.
    //
    // points per melee DPS (x dpsWeight x structure) in a melee group with no shaman (while meleeWantsWindfury is on);
    // trades Windfury coverage against the shaman's other seats; x2 moves F05, F12, F14, F16, F17, +28 more.
    meleeWantsWindfuryCost: 13,
    // 2026-10-10 user decision: Windfury from an Enhancement Shaman is worth more to melee than from an Ele/Resto; the
    // WINDFURY value in a group holding an Enh is scaled by (1 + this).
    //
    // multiplier: Windfury's value in a group holding an Enhancement shaman is scaled by 1 + this; trades an Enh
    // shaman's Windfury against an Ele or Resto shaman's; x2 moves F01, F04, F05, F06, F07, +41 more.
    enhWindfuryBonus: 0.4,
    // Classic and Forever use 8 (see classic.js for the rationale). TBC has no such nudge (0 = off) because its weight
    // tables were tuned, and its scenario suite pinned, without it.
    //
    // points per non-shaman melee DPS (x structure) added to Windfury's value in a melee-identity group; trades
    // Windfury against Grace of Air for the shaman's air totem; 0 -> 8 moves F01, F05, F07, F14, F15, +14 more.
    meleeGroupWindfuryBias: 0,
    // 2026-10-10 user decision "Ret sits with an Enh": flat bonus (x structure) for a group holding both a Retribution
    // Paladin and an Enhancement Shaman; gives the pairing a clear margin over swapping the Ret into a shaman-less
    // group (T02 was +0.03 without it).
    //
    // points (x structure) for a group holding both a Retribution Paladin and an Enhancement Shaman; trades the pair
    // against the Ret's seat in a shaman-less group; x2 moves T04, T32, T42.
    retEnhPairBonus: 8,
    // 2026-10-10 duplicate-stacks decision: an Enh Shaman beyond the melee-group count is redundant (Windfury is per
    // group), so seating one in a tank/caster group costs this (x structure); the bench trade then benches the spare
    // Enh rather than a DPS that receives buffs.
    //
    // points per Enhancement shaman (x structure) parked in a tank or caster group when Enh outnumber the melee groups;
    // trades the spare Enh's seat against a DPS that receives buffs; x2: no fixture moves; off moves F37, T47.
    surplusEnhCost: 25,
    // multiplier of FI's value credited per extra Beast Mastery hunter in a group (read only while ferociousInspiration
    // is on); trades BM pairs against spreading hunters; x2 moves F03, F04, F06, F08, F14, +12 more.
    ferociousInspirationStacking: 0.5,

    // ---- Hunters ----

    // A Survival Hunter brings no party buff in TBC (FI is Beast Mastery's, TSA is Marksmanship's), so sharing a group
    // with another hunter duplicates a seat; the reference comp spreads one hunter per melee group. Penalty per such
    // Survival Hunter. See Optimizer.groupScore.
    //
    // points per Survival hunter (x structure) sharing a group with another hunter, unless 2+ Enh are on the board;
    // trades a duplicated hunter seat against buffs elsewhere; x2 moves T42.
    hunterSpread: 2,
    // 2026-10-10 user decision: with 2+ Enhancement Shamans on the board, hunters spread one per melee group whatever
    // their spec. Cost per hunter beyond a fair share (ceil(hunters / melee groups)) in a group, triangular in the
    // excess, x cfg.structure; 24 (not 12): a 3rd hunter in a leftover melee group (T48) must cost more than the melee
    // buffs lost by pulling a non-hunter out of a Windfury group (swap probes: up to ~21); sized above the FI stacking
    // bonus a BM pair earns. With 0-1 Enh the Survival-only tax (hunterSpread) applies and BM pairs stack freely.
    //
    // points (x structure) per hunter beyond a fair share in a group, triangular, with 2+ Enh on the board (needs
    // hunterSpread); trades hunter spread against Windfury-group buffs; x2 moves F01, F27, F30, F39, T18, +3 more.
    hunterSpreadEnh: 24,
    // 2026-10-10 user decision: hunters stay out of caster groups as a HEAVY WEIGHT (never a hard ban). Cost per hunter
    // in a caster_dps-identity group, x cfg.structure.
    //
    // points per hunter (x structure) in a caster group (casters outnumber melee and hunters); trades hunters in
    // physical groups against the buffs a caster group gives them; x2 moves F16, F23, F37, F41, T02.
    hunterInCasterGroup: 20,
    // 2026-10-10 comp rules: a hunter in the tank group's guest seat pays this (x structure), the same 12 a melee or
    // caster guest pays there. The base penalty never charged ranged_dps, so a spare hunter was parked with the healers
    // for free (F01) while a warlock, which at least gives the tank Blood Pact, sat with the hunters. 0 in
    // Classic/Forever.
    //
    // points per hunter guest (x structure) in the tank group, in place of tankGroupGuestCost; 0 = hunters ride free;
    // trades a spare hunter's seat with the healers against its buffs elsewhere; x2 moves F37, F46, P01.
    hunterTankGuestCost: 12,

    // ---- The tank group (the anchor tank with its healers) ----

    // count: healers the tank group is built around (pull of 10 each up to it, shortfall costs, overflow seat opens
    // at it); the fourth-healer bonus (3) and the cost per healer past four (15) are still literals in
    // js/optimizer.js, so keep this at 4 or below; trades healer seats against DPS seats; 3 -> 4 moves F02, F05, F07,
    // F09, F10, +37 more; 3 -> 2 moves F09, F10, F13, F14, F15, +12 more.
    tankGroupHealers: 3,
    // 2026-10-10 comp rules (reference G5 keeps 3 healers + 1 overflow DPS): cost per healer below 3 in the tank group
    // (x structure), so pushing hunters out of caster groups never trades a tank-group healer for a guest.
    //
    // points per healer below tankGroupHealers in the tank group (x structure); trades a tank-group healer against a
    // DPS guest; x2 moves F13, F14, F15, F29.
    tankGroupHealerCost: 15,
    // 2026-10-10 user decision "a roster's only Resto Shaman stays with the tank-group healers": a tank group with
    // under 3 healers and no shaman pays this (x structure) when the roster's lone shaman is a Resto elsewhere, so
    // the Windfury coverage pull cannot strip the tank healers.
    //
    // points (x structure) when the roster's only shaman is a Resto outside a tank group that is short of healers;
    // trades the Windfury pull on that shaman against the tank healers; x2: no fixture moves; off: no fixture moves.
    loneRestoTankCost: 25,
    // points per melee or caster DPS guest (x structure) in the tank group, except the one overflow seat; trades a
    // guest's buffs against a healer seat; x2 moves F01, F14, F17, F43, F46, +4 more.
    tankGroupGuestCost: 12,
    // 2026-10-10 comp rules (reference G5 = healers + one Affliction lock): pulls the leftover Affliction lock into the
    // healer-group overflow seat (x cfg.structure). Knife-edge: 8+ breaks tests.js, below 7 breaks T21.
    //
    // points (x structure) for the one healerGroupDps DPS seated in the tank group once it holds its tankGroupHealers;
    // trades that overflow seat against a melee or caster group; x2 moves F04, F10, F11, F18, F19, +28 more.
    healerGroupDpsPull: 7,

    // ---- Role cohesion and group size ----

    // points per DPS member (x cohesion) whose role is the group's identity (a hunter counts as melee in a melee
    // group); trades role clustering against buff value; x2 moves F02, F05, F09, F16, F21, +27 more.
    cohesionMatch: 12,
    // unreachable today (points per DPS member, x cohesion, whose role is ROLE_COMPAT-compatible with the group's
    // identity); the identities Optimizer.roleIdentitiesFor assigns are melee_dps, caster_dps and tank, tank groups
    // skip the cohesion block, hunters in a caster group take the neutral branch above it, and ROLE_COMPAT pairs
    // neither a melee member with a caster group nor a caster member with a melee group, so every DPS member either
    // matches or mismatches; kept so a ROLE_COMPAT edit can use it; trades role clustering against buff value; x2: no
    // fixture moves; off: no fixture moves.
    cohesionCompatible: 6,
    // points subtracted per DPS member (x cohesion) whose role fits neither; trades role clustering against buff value;
    // x2 moves F03, F09, F14, F15, F46, +6 more.
    cohesionMismatch: 12,
    // points per (group size squared) (x structure) subtracted from every group, a convex push toward emptier groups;
    // trades synergy against evenly filled groups; x2 moves F03, F05, F21, F23, F28, +27 more.
    groupSizePressure: 0.8,

    // ---- Bench and Open slots ----

    // Healer cap (user decision 2026-10-10): when DPS would otherwise be benched, seat at most floor + this many
    // healers (6 in a 25-man, 4 in a 10-man). null (no cap) in Classic/Forever.
    //
    // count: seated healers are capped at the raid size's healer floor plus this when DPS would otherwise be benched;
    // null = no cap; trades healer seats against benched DPS; 1 -> null moves P09.
    healerCapOverFloor: 1,
    // 2026-10-10 comp rules 2/3: the Ele amplifies the warlock group together with the Boomkin, so OpenSlots.choose()
    // does not suggest an Ele beyond one per Boomkin (cost in _raidValue points).
    //
    // Open-slot points subtracted for suggesting an Elemental shaman beyond one per Boomkin; trades another Ele against
    // other specs for an empty seat; x2: no fixture moves; off moves F25, F39, P05, P12, T31, +7 more.
    extraEleNeedsBoomkin: 30,

    // ---- Objective weights and Open-slot pricing ----

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
      max_dps: {
        // multiplier on every party-buff DPS value a member receives (weight.dps); trades DPS buffs against mitigation,
        // structure and cohesion; x2 moves F01, F02, F03, F04, F05, +84 more.
        dps: 1.0,
        // multiplier on the mitigation value of buffs that reach tanks (weight.mitigation); also scales tank-debuff
        // pricing in Open slots; trades tank mitigation against DPS buffs; x2 moves F01, F03, F04, F05, F07, +66 more.
        mit: 0.25,
        // multiplier on healer coverage, spreading pressure and every structural cost and bonus above (those marked x
        // structure); trades composition rules against buff value; x2 moves F01, F03, F04, F05, F12, +63 more.
        structure: 0.7,
        // multiplier on the three cohesion terms; trades role clustering against buff value; x2 moves F02, F03, F05,
        // F09, F14, +32 more.
        cohesion: 0.4,
      },
      tank_mit: { dps: 0.7, mit: 1.2, structure: 1.0, cohesion: 0.4 },
      balanced: { dps: 0.7, mit: 0.5, structure: 1.0, cohesion: 1.0 },
      relaxed: { dps: 0.2, mit: 0.3, structure: 1.0, cohesion: 1.5 },
    },
    openSlots: {
      // Open-slot pricing (OpenSlots._raidValue), on top of the party buffs. utilityBonus: flat bonus for a spec that
      // provides a utility nobody in the raid brings yet (Power Infusion, ...).
      //
      // Open-slot points for a spec that covers a utility nobody in the raid brings yet; trades a utility against
      // party-buff gain; x2 moves F30, F43, T41.
      utilityBonus: 6,
      // specRepeat: cost for every copy of the candidate's spec already in the raid.
      //
      // Open-slot points subtracted per copy of the candidate's spec already in the raid; trades another copy of a spec
      // against variety; x2 moves F25, F29, F30, F39, T32, +5 more.
      specRepeat: 6,
      // classCrowd: cost for piling onto a class the raid already has plenty of: classCrowd x max(0, copies of the
      // class already in the raid - classCrowdFree + 1).
      //
      // Open-slot points per copy of the candidate's class beyond classCrowdFree; trades a crowded class against
      // variety; x2: no fixture moves; off moves F29.
      classCrowd: 4,
      // classCrowdFree: see classCrowd.
      //
      // count: copies of one class the raid holds before the next one costs classCrowd; trades a crowded class against
      // variety; x2 moves F29.
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

  // Class-presence utility checklist (the readiness sidebar's "Utility" section, Readiness.utilityCoverage()) -
  // separate from buffs and debuffs because these are one-off or in-combat abilities, not always-on party auras.
  // providers lists { class, spec?, note? }; no spec = any spec of the class. See tasks/feature-backlog.md #3.
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
};
