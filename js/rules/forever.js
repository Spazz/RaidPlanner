/* ================================================================
   RAIDSMITH WEB - rules data: WoW Forever (beta)
   ----------------------------------------------------------------
   WoW Forever (beta): party buffs and raid debuffs with their weights, the optimizer tuning numbers and
   raids. Rules follow the beta data of 2026-10-10 (build 1.60.1.70338) plus the development notes of 2026-10-16 (Blizzard
   forum post #6: seven buffs became raid-wide); Forever has no faction lock.

   Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated
   once on 2026-10-11 from the then-live tables by tools/generate-rules-data.js (now a guarded record of the
   mapping, which refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load.
   Ids never change: saved plans and share links store them, and rules-data-tests.js pins them. Every number
   is explained: see README.md, Editing the rules. Design and vocabulary: tasks/reference/rules-data-refactor.md.

   Research behind the numbers: tasks/reference/research-forever.md (WoW Forever beta audit of 2026-10-10 against build
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
  // Party and raid-wide buffs, in display order. A party buff is what the optimizer places; a raid-wide buff (scope 'raid')
  // reaches every group wherever its provider sits, so it never drives placement (same rule as Bloodlust). buffType drives the slot rule in code: one totem per element
  // per shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present.
  // weight.dps is what a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name,
  // else 0 (multiplied by the recipient's specDpsWeight); weight.dps: {} (a buff worth nothing to any recipient's DPS)
  // is written out on purpose, the key is explicit; weight.mitigation is the value to a tank (per CLASS:Spec, '*' = any
  // tank); weight.sustain is one number for healer groups. exclusiveBuffs lists the ids that share one slot per party
  // with this one (the better-valued member wins); Forever lists none today. priority only orders the buff list per role in the UI. spellId is
  // the max-rank spell, a verification handle.
  //
  // Vanilla/Classic Era baseline (no new classes or specs - the six new race/class combos and the Skyborne race only
  // widen WHO can play a class, never WHAT a class does), with the Forever deltas confirmed on 2026-10-10 against beta
  // build 1.60.1.70338 layered on. Source: tasks/reference/research-forever.md, "Audit 2026-10-10", which supersedes the 09-26
  // browser pass.
  //
  // Tranquil Air Totem, Wrath of Air Totem and Totem of Wrath do not exist in Forever and are left out of the buffs (no
  // Tranquil Air, no Wrath of Air/Totem of Wrath). The totems listed here cover three elements: air, earth and water.
  // Since the 2026-10-16 development notes Windfury, Grace of Air and Strength of Earth are raid-wide, and Grace of Air is no
  // longer exclusive with Windfury: two shamans give the raid both air totems, one shaman still drops one per element.
  // The fire element exists in Forever too (Flametongue Totem, raid-wide and exclusive with Windfury) but is not modeled
  // yet, see the known gaps below.
  // Sanctity Aura and Improved Devotion/Retribution/Concentration Aura were removed; auras carry no healing-taken
  // rider.
  //
  // The weights started as Classic's (the recipient DPS-weight ordering is the same: no new classes or specs) and
  // differ only where Forever's buff catalog does: Tranquil Air is dropped (it does not exist); Leader of the Pack
  // buffs melee and ranged crit and Moonkin Aura spell crit only; Windfury is worth something to Ferals (its procs work in
  // Cat and Bear form, so Classic's 'DRUID:Feral': 0, a weapon-enchant rule, is overridden); Trueshot Aura buffs ranged
  // attack power only and Battle Shout melee only; Sanctity Aura does not exist; the paladin auras
  // carry no healing-taken rider, so the sustain weights equal Classic's. A trailing "research-forever W<n>" comment on
  // a weight names the item of the 2026-10-10 audit (tasks/reference/research-forever.md, "Audit 2026-10-10") that states why it
  // is what it is, and "audit CONFIRMED" refers to that audit's list of unchanged facts. The audit gives facts, not
  // weight values. A weight without a comment has no audit item behind it.
  //
  // Known gaps, not modeled yet: hunter pet effects (Wolf Furious Howl party AP, Tallstrider armor, Carrion Bird AP;
  // need a per-player pet tag), Flametongue Totem, Healing Stream Totem, Vampiric Embrace, Vindication, Salvation and
  // Mass Salvation, the Fire/Frost/Shadow Resistance Auras, Dark Inspiration (tasks/reference/research-forever.md, "Audit 2026-10-16").
  buffs: {
    // Windfury Totem is a buff in Forever, no longer a weapon enchant, and its procs work in Cat/Bear form (Blizzard
    // 09-30 and 10-07), so a Feral gets value from it ('DRUID:Feral' weights, unlike Classic's 0). Raid-wide since the
    // development notes of 2026-10-16 ("Grace of Air Totem, Strength of Earth Totem, Windfury Totem, and Flametongue Totem
    // are now Raid wide"), so it is not scored per group; conventions.meleeWantsWindfury* and meleeGroupWindfuryBias keep a
    // tie-break nudge toward a shaman in a melee group.
    // preferSpec: 'Enhancement' is kept on purpose (earlier user decision), not a value claim: every shaman spec drops the
    // same totem.
    WINDFURY: {
      name: 'Windfury Totem',
      spellId: 10614,
      desc: 'Raid-wide buff in Forever (no longer a weapon enchant): each main-hand hit has a 20% chance to grant an extra attack with 246 extra attack power. Works in Cat and Bear form. Not active alongside Flametongue Totem, but it no longer excludes Grace of Air. 5 min.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'raid',
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
          'DRUID:Feral': 8, // research-forever W4: Windfury works for Ferals in Forever (Classic has 0)
          melee_dps: 7,
          tank: 3,
        },
        mitigation: {
          'WARRIOR:Protection': 3,
          'PALADIN:Protection': 1,
          'DRUID:Feral': 3, // research-forever W4: Windfury works for Ferals in Forever
        },
      },
      // No exclusiveBuffs: the dev notes of 2026-10-16 say "Grace of Air Totem is no longer exclusive with Windfury Totem
      // and Flametongue Totem. Windfury Totem and Flametongue Totem retain their exclusivity." Flametongue is not modeled,
      // so Windfury has no exclusive partner left.
    },
    GRACE_OF_AIR: {
      name: 'Grace of Air Totem',
      spellId: 25359,
      desc: 'Increases agility of the raid by 89. Raid-wide in Forever, and no longer exclusive with Windfury Totem.',
      buffType: 'totem',
      totemElement: 'air',
      scope: 'raid',
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
    STRENGTH_OF_EARTH: {
      name: 'Strength of Earth Totem',
      spellId: 25361,
      desc: 'Increases strength of the raid by 53. Raid-wide in Forever.',
      buffType: 'totem',
      totemElement: 'earth',
      scope: 'raid',
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
        sustain: 2, // research-forever W6: no healing-taken rider, so the same as Classic
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
    // Battle Shout is a plain passive here (no warrior shout slot) and buffs melee only. Raid-wide since the development
    // notes of 2026-10-16 ("Battle Shout is now Raid wide"); only its reach changed, not who profits.
    BATTLE_SHOUT: {
      name: 'Battle Shout',
      spellId: 25289,
      desc: 'Increases melee attack power of raid members by 139 for 3 minutes (melee only; hunters gain nothing). Raid-wide in Forever.',
      buffType: 'passive',
      scope: 'raid',
      sourceClass: 'WARRIOR',
      targetRoles: ['tank', 'melee_dps'],
      priority: {
        melee_dps: 65,
        tank: 50,
      },
      weight: {
        dps: {
          melee_dps: 3, // research-forever W10: melee attack power only (no ranged_dps key)
          tank: 2,
        },
        mitigation: { '*': 2 },
      },
    },
    // Trueshot Aura is the Marksmanship 21-point talent in Forever and buffs ranged attack power only (sourceSpec,
    // targetRoles). Raid-wide since the development notes of 2026-10-16 ("Trueshot Aura is now Raid wide").
    TRUESHOT_AURA: {
      name: 'Trueshot Aura',
      spellId: 20906,
      desc: 'Marksmanship talent (21-point, row 4); higher ranks are trained once the talent is known. Increases ranged attack power of raid members by 75 at rank 4 (the level-60 rank 5 reads 50 in the beta). Ranged attack power only. Raid-wide in Forever.',
      buffType: 'passive',
      scope: 'raid',
      sourceClass: 'HUNTER',
      sourceSpec: 'Marksmanship',
      targetRoles: ['ranged_dps'],
      priority: 62,
      weight: {
        dps: { ranged_dps: 4 }, // research-forever W1: ranged attack power only (no melee_dps key)
      },
    },
    // Leader of the Pack and Moonkin Aura were one shared +3% all-school crit aura until the development notes of 2026-10-16
    // ("Moonkin Aura now only increases Spell Critical Strike chance, and is Raid wide." / "Leader of the Pack now only
    // increases Melee and Ranged Critical Strike chance, and is Raid wide."). They now cover different kinds of crit, so each
    // buffs only its own roles. The notes do not say whether the two stack; they are no longer exclusive here, which is
    // INFERRED from the split and not confirmed by Blizzard (tasks/reference/research-forever.md, "Audit 2026-10-16").
    LEADER_OF_THE_PACK: {
      name: 'Leader of the Pack',
      spellId: 17007,
      desc: 'Feral 21-point talent. While in Cat, Bear or Dire Bear Form, increases melee and ranged critical strike chance of the raid by 3% (no longer spell crit). Raid-wide in Forever. Stacking with Moonkin Aura is inferred from the split, not confirmed by Blizzard.',
      buffType: 'passive',
      scope: 'raid',
      sourceClass: 'DRUID',
      sourceSpec: 'Feral',
      targetRoles: ['tank', 'melee_dps', 'ranged_dps'],
      priority: {
        melee_dps: 78,
        ranged_dps: 78,
        tank: 65,
      },
      weight: {
        dps: {
          melee_dps: 4,
          ranged_dps: 4, // research-forever, audit CONFIRMED: +3% crit for attacks (spells dropped 2026-10-16)
          tank: 2,
        },
        mitigation: {
          'DRUID:Feral': 5,
          '*': 2,
        },
      },
    },
    // Moonkin Aura: spell crit only since 2026-10-16, so it serves casters and healers (a healer's spells crit too); melee,
    // ranged and tanks get nothing from it. The healer weight (2) is half the caster weight (4): healer spells gain from crit
    // through heal crit only, and 2 is the same floor Concentration Aura (caster 1, healer 2) and Mana Spring (2, 2) already
    // give a healer. A healer's roleDpsWeight is 1.0, so the received value is 2 x 1.0 = 2.0, still below every caster spec's
    // (4 x specDpsWeight: 2.4 for Balance up to 3.8 for Fire).
    MOONKIN_AURA: {
      name: 'Moonkin Aura',
      spellId: 24907,
      desc: 'While in Moonkin Form, increases spell critical strike chance of the raid by 3% (no longer melee or ranged crit). Raid-wide in Forever. Stacking with Leader of the Pack is inferred from the split, not confirmed by Blizzard.',
      buffType: 'passive',
      scope: 'raid',
      sourceClass: 'DRUID',
      sourceSpec: 'Balance',
      targetRoles: ['caster_dps', 'healer'],
      priority: {
        caster_dps: 72,
        healer: 60,
      },
      weight: {
        dps: {
          caster_dps: 4,
          healer: 2, // lower than the caster weight: healers gain heal crit only
        },
      },
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
  // it's the least-bad default. Both air totems are raid-wide and no longer exclusive (2026-10-16), so this is only the
  // pick a lone shaman makes; with two shamans the raid gets both.
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
  // Same single-point-of-failure spreading as Classic (Optimizer.spreadProviders/_spreadPass), narrowed on 2026-10-16:
  // only providers of a PARTY-scoped buff are spread. The Feral/Balance druid entry is gone (Leader of the Pack and Moonkin
  // Aura are raid-wide, so a druid never needs to sit in a particular group). SHAMAN stays for the water totems (Mana
  // Spring, Mana Tide are party buffs: the caster/healer spread pass); Optimizer.spreadProviders no longer spreads shamans
  // over the melee groups, because Windfury, Grace of Air and Strength of Earth are raid-wide. PALADIN stays: the auras
  // are party buffs.
  spreadProviders: [
    { class: 'SHAMAN' },
    { class: 'PALADIN' },
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

  // TBC-only: this version has no duplicate-provider penalty (an empty list adds none). See tbc.js.
  stackPenalty: [],

  // TBC-only: this version has no overflow DPS seat in the healer group (an empty list matches nobody). See tbc.js.
  healerGroupDps: [],

  // Every tuning number and flag the optimizer reads (rules.* in js/optimizer.js), plus modeConfig (objective weights
  // per optimizer mode: only max_dps is supported, the other entries stay so old plans and share links validate) and
  // openSlots (Open-slot pricing scalars).
  //
  // These are small hooks the optimizer consults instead of hardcoded class/spec checks, so a version can turn one
  // off or swap its value. Every key is present in every version file (Rulesets.CONVENTIONS in js/rules.js is the
  // closed list, and Rulesets.compile stops the page at load on a missing, an unknown or a mistyped key, so a
  // misspelled knob cannot be ignored): a number of 0 switches that cost or bonus off and a flag of false switches
  // that rule off for this version; a count is a threshold, not a switch (tankGroupHealerMax and classCrowdFree say
  // what 0 does there), and healerCapOverFloor: null means no cap (the only key whose off state has no number). The
  // line above each key gives its unit, what it trades against and the boards-tests.js fixtures that move when it
  // changes; node boards-tests.js shows who moves after an edit of your own. The 2026-10-10 TBC comp rules (tbc.js)
  // are off here.
  conventions: {
    // ---- Switches: on or off for the whole version ----

    // meleeWantsWindfury: Shaman exists on both factions - no faction gate needed.
    //
    // flag: charge a melee group that has no shaman a tie-break cost (meleeWantsWindfuryCost) and explain its shaman as a
    // tie-break seat; Windfury is raid-wide since 2026-10-16, so this is a nudge, never a coverage rule (see the cost);
    // trades a shaman's melee-group seat against its other seats only when nothing else differs; off: no fixture moves.
    meleeWantsWindfury: true,
    // ferociousInspiration: a TBC-only Beast Mastery talent; it does not exist in Forever.
    //
    // flag: credit each extra Beast Mastery hunter in a group with ferociousInspirationStacking of the FI value; trades
    // BM pairs against spreading hunters; on: no fixture moves.
    ferociousInspiration: false,
    // flag: the melee/caster group count follows the roster's physical vs caster DPS headcount, not a half-and-half
    // split; trades melee-group seats against caster-group seats; on moves foreverMixed40.
    rosterShapedIdentities: false,
    // flag: the refine rounds also try 3-cycle rotations, plus a guarded final refine after de-isolation; trades
    // Optimize time for boards that plain swaps cannot reach; on: no fixture moves.
    rotationSearch: false,

    // ---- Windfury and shamans ----

    // 6 was the cost Classic and Forever had always used (TBC: 13, comp rule 1, see tbc.js). Forever's Windfury became
    // raid-wide on 2026-10-16, so a melee group without a shaman misses nothing; user decision 2026-10-16 "keep but
    // weaken": this is a tie-break only. Scale: the smallest party-buff credit a placement can gain is Retribution Aura's
    // 0.25 for one tank (mitigation 1 x modeConfig.max_dps.mit 0.25). Worst swing of one shaman move: two groups of 4 melee
    // (a 5-seat group with the shaman), each swinging 4 x 0.7 (structure) x (cost x dpsWeight <= 1.0 + meleeGroupWindfuryBias)
    // = 2.8 x 0.04 = 0.112, so 0.224 for both groups, strictly below 0.25 at cost 0.02 + bias 0.02.
    //
    // points per melee DPS (x dpsWeight x structure) in a melee group with no shaman (while meleeWantsWindfury is on);
    // trades a shaman's melee-group seat against its other seats only on a tie; x2: no fixture moves.
    meleeWantsWindfuryCost: 0.02,
    // multiplier: Windfury's value in a group holding an Enhancement shaman is scaled by 1 + this; trades an Enh
    // shaman's Windfury against an Ele or Resto shaman's; 0 -> 0.4 moves foreverMixed40.
    enhWindfuryBonus: 0,
    // Was Classic's Windfury-over-Grace-of-Air structural nudge (8). Windfury is raid-wide and no longer exclusive with Grace of
    // Air (2026-10-16), so it only breaks ties now: a small bonus for a shaman in a melee group, sized with
    // meleeWantsWindfuryCost (see there for the 0.25 ceiling arithmetic).
    //
    // points per non-shaman melee DPS (x structure) added where Windfury is dropped in a melee-identity group (the air
    // totem pick of a group and, as Windfury is raid-wide, the group score); trades a shaman's melee-group seat against its
    // other seats only on a tie; x2: no fixture moves.
    meleeGroupWindfuryBias: 0.02,
    // points (x structure) for a group holding both a Retribution Paladin and an Enhancement Shaman; trades the pair
    // against the Ret's seat in a shaman-less group; 0 -> 8 moves foreverMixed40.
    retEnhPairBonus: 0,
    // points per Enhancement shaman (x structure) parked in a tank or caster group when Enh outnumber the melee groups;
    // trades the spare Enh's seat against a DPS that receives buffs; 0 -> 25: no fixture moves.
    surplusEnhCost: 0,
    // multiplier of FI's value credited per extra Beast Mastery hunter in a group (read only while ferociousInspiration
    // is on); trades BM pairs against spreading hunters; x2: no fixture moves.
    ferociousInspirationStacking: 0.5,

    // ---- Hunters ----

    // points per Survival hunter (x structure) sharing a group with another hunter, unless 2+ Enh are on the board;
    // trades a duplicated hunter seat against buffs elsewhere; 0 -> 2: no fixture moves.
    hunterSpread: 0,
    // points (x structure) per hunter beyond a fair share in a group, triangular, with 2+ Enh on the board (needs
    // hunterSpread); trades hunter spread against Windfury-group buffs; 0 -> 24: no fixture moves; 0 -> 24 with
    // hunterSpread 0 -> 2 moves foreverMixed40.
    hunterSpreadEnh: 0,
    // points per hunter (x structure) in a caster group (casters outnumber melee and hunters); trades hunters in
    // physical groups against the buffs a caster group gives them; 0 -> 20 moves foreverMixed40.
    hunterInCasterGroup: 0,
    // points per hunter guest (x structure) in the tank group, in place of tankGroupGuestCost; 0 = hunters ride free;
    // trades a spare hunter's seat with the healers against its buffs elsewhere; 0 -> 12: no fixture moves.
    hunterTankGuestCost: 0,

    // ---- The tank group (the anchor tank with its healers) ----

    // count: healers the tank group is built around (pull of tankGroupHealerPull each up to it); below it a shortfall
    // costs and at it the overflow seat opens; keep it at or below tankGroupHealerMax (rules-data-tests.js checks
    // it); trades healer seats against DPS seats; 3 -> 4 moves foreverMixed40; 3 -> 2: no fixture moves.
    tankGroupHealers: 3,
    // Three healers (tankGroupHealers) is the MT group's core; each of them is pulled into it with this much.
    //
    // points per healer (x structure) in the tank group, up to tankGroupHealers of them; trades a healer's seat with
    // the tank group against its own buffs in a DPS group; x2 moves forever10.
    tankGroupHealerPull: 10,
    // The MT group holds up to four healers (the MT plus a healer party). It is one number on purpose: the
    // extra-healer pull (tankGroupExtraHealerPull) begins when the group holds this many, and each healer past it
    // costs tankGroupHealerOverflowCost. 0 is not an off switch here: every healer would then pay
    // tankGroupHealerOverflowCost and the extra pull would apply at any count; to switch the rule off set
    // tankGroupExtraHealerPull and tankGroupHealerOverflowCost to 0.
    //
    // count: healers the tank group holds before each further one costs tankGroupHealerOverflowCost; trades healer
    // seats against DPS seats; x2: no fixture moves; 4 -> 5: no fixture moves; 4 -> 3 moves foreverMixed40,
    // forever20.
    tankGroupHealerMax: 4,
    // A 4th healer is allowed but only lightly pulled, so a healer that does better in a DPS group goes there instead
    // of padding the MT group (tbc.js has the Holy Priest and Vampiric Touch example).
    //
    // points (x structure), once, when the tank group holds tankGroupHealerMax healers or more; trades a 4th healer's
    // seat in the tank group against its buffs in a DPS group; x2 moves foreverMixed40.
    tankGroupExtraHealerPull: 3,
    // A fifth healer only stays in the MT group for the mana totems it receives; past four (tankGroupHealerMax), they
    // move on.
    //
    // points per healer (x structure) past tankGroupHealerMax in the tank group; trades a surplus healer's mana
    // totems in the tank group against a seat elsewhere; x2: no fixture moves; off: no fixture moves.
    tankGroupHealerOverflowCost: 15,
    // weight.sustain is counted per healer in the tank group, up to this many, and scales with the structure weight:
    // it is a healing-structure concern (keeping the tank healers casting: Mana Tide and Spring, Concentration Aura
    // protecting their casts), not a mitigation one. It is what keeps a lone Resto Shaman with the tank healers
    // instead of chasing Mana Tide value in a mage group.
    //
    // count: healers in the tank group counted for a buff's weight.sustain, at most this many; trades the tank
    // group's pull on sustain providers against their buffs in a DPS group; x2 moves foreverMixed40, forever10;
    // 2 -> 1: no fixture moves.
    sustainHealers: 2,
    // points per healer below tankGroupHealers in the tank group (x structure); trades a tank-group healer against a
    // DPS guest; 0 -> 15 moves forever10.
    tankGroupHealerCost: 0,
    // points (x structure) when the roster's only shaman is a Resto outside a tank group that is short of healers;
    // trades the Windfury pull on that shaman against the tank healers; 0 -> 25: no fixture moves.
    loneRestoTankCost: 0,
    // points per melee or caster DPS guest (x structure) in the tank group, except the one overflow seat; trades a
    // guest's buffs against a healer seat; x2: no fixture moves.
    tankGroupGuestCost: 12,
    // points (x structure) for the one healerGroupDps DPS seated in the tank group once it holds its
    // tankGroupHealers; inert while healerGroupDps is [], as it is in this file; trades that overflow seat against a
    // melee or caster group; 0 -> 7: no fixture moves.
    healerGroupDpsPull: 0,

    // ---- Role cohesion and group size ----

    // points per DPS member (x cohesion) whose role is the group's identity (a hunter counts as melee in a melee
    // group); trades role clustering against buff value; x2 moves foreverMixed40.
    cohesionMatch: 12,
    // unreachable today (points per DPS member, x cohesion, whose role is ROLE_COMPAT-compatible with the group's
    // identity); the identities Optimizer.roleIdentitiesFor assigns are melee_dps, caster_dps and tank, tank groups
    // skip the cohesion block, hunters in a caster group take the neutral branch above it, and ROLE_COMPAT pairs
    // neither a melee member with a caster group nor a caster member with a melee group, so every DPS member either
    // matches or mismatches; kept so a ROLE_COMPAT edit can use it; trades role clustering against buff value; x2: no
    // fixture moves.
    cohesionCompatible: 6,
    // points subtracted per DPS member (x cohesion) whose role fits neither; trades role clustering against buff value;
    // x2: no fixture moves.
    cohesionMismatch: 12,
    // points per (group size squared) (x structure) subtracted from every group, a convex push toward emptier groups;
    // trades synergy against evenly filled groups; x2 moves foreverMixed40.
    groupSizePressure: 0.8,
    // A tank in a caster group is off-role there: without this, Blood Pact's mitigation value alone pulled spare
    // tanks into the warlock group. A structural rule, not a cohesion preference, so it holds in every mode, and it
    // outweighs the tank group's pull on a 4th healer (tankGroupExtraHealerPull): that healer trades out to the
    // casters instead.
    //
    // points per tank (x structure) seated in a caster group; trades the buffs a caster group gives a spare tank
    // (Blood Pact) against its seat in a tank or melee group; x2: no fixture moves; off moves foreverMixed40,
    // forever20, forever10.
    tankInCasterGroupCost: 25,

    // ---- Bench and Open slots ----

    // Healer cap (user decision 2026-10-11): when DPS would otherwise be benched, seat at most floor + this many
    // healers: 4 in a 20-man, 3 in a 10-man, 10 in a 40-man. The 20-man floor is expected to drop to 2-3 later, which
    // means moving Config.RaidFloors into the version files.
    //
    // count: seated healers are capped at the raid size's healer floor plus this when DPS would otherwise be benched;
    // null = no cap; trades healer seats against benched DPS; 0 -> null moves forever20over; 0 -> 1 moves
    // forever20over.
    healerCapOverFloor: 0,
    // Open-slot points subtracted for suggesting an Elemental shaman beyond one per Boomkin; trades another Ele against
    // other specs for an empty seat; 0 -> 30: no fixture moves.
    extraEleNeedsBoomkin: 0,

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
        // structure and cohesion; x2 moves foreverMixed40, forever20, forever10.
        dps: 1.0,
        // multiplier on the mitigation value of buffs that reach tanks (weight.mitigation); also scales tank-debuff
        // pricing in Open slots (openSlots.tankDebuffScale); trades tank mitigation against DPS buffs; x2 moves
        // foreverMixed40.
        mit: 0.25,
        // multiplier on healer coverage, spreading pressure and every structural cost and bonus above (those marked x
        // structure); trades composition rules against buff value; x2 moves foreverMixed40.
        structure: 0.7,
        // multiplier on the three cohesion terms; trades role clustering against buff value; x2 moves foreverMixed40,
        // forever10.
        cohesion: 0.4,
      },
      tank_mit: { dps: 0.7, mit: 1.2, structure: 1.0, cohesion: 0.4 },
      balanced: { dps: 0.7, mit: 0.5, structure: 1.0, cohesion: 1.0 },
      relaxed: { dps: 0.2, mit: 0.3, structure: 1.0, cohesion: 1.5 },
    },
    // Every Forever roster in boards-tests.js is a full raid, so none of them prices an Open slot: no probe of these
    // scalars can move a fixture, which is why every measured line below ends in "no fixture moves".
    openSlots: {
      // Open-slot pricing (OpenSlots._raidValue), on top of the party buffs. utilityBonus: flat bonus for a spec that
      // provides a utility nobody in the raid brings yet (Power Infusion, ...).
      //
      // Open-slot points for a spec that covers a utility nobody in the raid brings yet; trades a utility against
      // party-buff gain; x2: no fixture moves.
      utilityBonus: 6,
      // specRepeat: cost for every copy of the candidate's spec already in the raid.
      //
      // Open-slot points subtracted per copy of the candidate's spec already in the raid; trades another copy of a spec
      // against variety; x2: no fixture moves.
      specRepeat: 6,
      // classCrowd: cost for piling onto a class the raid already has plenty of: classCrowd x max(0, copies of the
      // class already in the raid - classCrowdFree + 1).
      //
      // Open-slot points per copy of the candidate's class beyond classCrowdFree; trades a crowded class against
      // variety; x2: no fixture moves.
      classCrowd: 4,
      // classCrowdFree: see classCrowd.
      //
      // 0 is not an off switch here: every copy of a class would then cost classCrowd, the first one included (the
      // candidate's own copy counts, OpenSlots._raidValue); set classCrowd to 0 to switch the rule off.
      //
      // count: copies of one class the raid holds before the next one costs classCrowd; trades a crowded class against
      // variety; x2: no fixture moves.
      classCrowdFree: 5,
      // OpenSlots._raidValue prices a tank debuff at its weight x the raid's tank count x modeConfig.max_dps.mit x
      // this. 4 is the reciprocal of max_dps.mit 0.25, so a tank debuff is worth its weight per tank today, and mit
      // also reprices tank debuffs in Open slots.
      //
      // multiplier on tank count x the mode's mit for a tank debuff's Open-slot weight; trades a spec that brings a
      // tank debuff against the party-buff gain of other specs; x2: no fixture moves; off: no fixture moves.
      tankDebuffScale: 4,
    },
  },

  // Raids of this version in picker order; planning templates last.
  //
  // The real WoW Forever raids are confirmed via a full-page browser read of Wowhead's raids-overview guide
  // (tasks/reference/research-forever.md, "Browser verification" section, "Raids" table) - launching December 9, 2026. The 'f_'
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
