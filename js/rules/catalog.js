/* ================================================================
   RAIDSMITH WEB - rules data: shared catalog
   ----------------------------------------------------------------
   Pure data shared by every game version: classes, roles, specs and their icons, the Raid-Helper maps, and
   the icon, abbreviation and CSS-class lookups of every buff and debuff id (including the ids that only
   Classic or Forever use). The per-version files (tbc.js, classic.js, forever.js) own everything else.
   Rulesets.compile() takes this catalog as its second argument.

   Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated
   once on 2026-10-11 from the then-live tables by tools/generate-rules-data.js (now a guarded record of the
   mapping, which refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load.
   Ids never change: saved plans and share links store them, and rules-data-tests.js pins them. Every number
   is explained: see README.md, Editing the rules. Design and vocabulary: tasks/rules-data-refactor.md.

   Research behind the numbers: tasks/research-*.md (see the version files).

   Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): Ferocious
   Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums,
   Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh,
   the healer cap, Open-slot choose() pricing. Also in code, not in these files: the Ideal-comp builders
   (js/app.js, faction-aware per version) and the blessing catalog (js/analysis.js,
   Assignments.DEFAULT_BLESSINGS).
   ================================================================ */

// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.
var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;

RulesData.catalog = {
  // Class ids in display order (the TBC list; Classic and Forever reuse it).
  classes: ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'],

  // Class colours (hex).
  classColors: {
    WARRIOR: '#C69B6D',
    PALADIN: '#F48CBA',
    HUNTER: '#AAD372',
    ROGUE: '#FFF468',
    PRIEST: '#d0d0d0',
    SHAMAN: '#0070DD',
    MAGE: '#3FC7EB',
    WARLOCK: '#8788EE',
    DRUID: '#FF7C0A',
  },

  // Role ids, keyed by their constant name.
  roles: {
    TANK: 'tank',
    HEALER: 'healer',
    MELEE_DPS: 'melee_dps',
    RANGED_DPS: 'ranged_dps',
    CASTER_DPS: 'caster_dps',
  },

  // Specs per class by talent-tree slot: the spec name and the role it fills.
  specs: {
    WARRIOR: {
      1: { name: 'Arms', role: 'melee_dps' },
      2: { name: 'Fury', role: 'melee_dps' },
      3: { name: 'Protection', role: 'tank' },
    },
    PALADIN: {
      1: { name: 'Holy', role: 'healer' },
      2: { name: 'Protection', role: 'tank' },
      3: { name: 'Retribution', role: 'melee_dps' },
    },
    HUNTER: {
      1: { name: 'Beast Mastery', role: 'ranged_dps' },
      2: { name: 'Marksmanship', role: 'ranged_dps' },
      3: { name: 'Survival', role: 'ranged_dps' },
    },
    ROGUE: {
      1: { name: 'Assassination', role: 'melee_dps' },
      2: { name: 'Combat', role: 'melee_dps' },
      3: { name: 'Subtlety', role: 'melee_dps' },
    },
    PRIEST: {
      1: { name: 'Discipline', role: 'healer' },
      2: { name: 'Holy', role: 'healer' },
      3: { name: 'Shadow', role: 'caster_dps' },
    },
    SHAMAN: {
      1: { name: 'Elemental', role: 'caster_dps' },
      2: { name: 'Enhancement', role: 'melee_dps' },
      3: { name: 'Restoration', role: 'healer' },
    },
    MAGE: {
      1: { name: 'Arcane', role: 'caster_dps' },
      2: { name: 'Fire', role: 'caster_dps' },
      3: { name: 'Frost', role: 'caster_dps' },
    },
    WARLOCK: {
      1: { name: 'Affliction', role: 'caster_dps' },
      2: { name: 'Demonology', role: 'caster_dps' },
      3: { name: 'Destruction', role: 'caster_dps' },
    },
    DRUID: {
      1: { name: 'Balance', role: 'caster_dps' },
      2: { name: 'Feral', role: 'melee_dps' },
      3: { name: 'Restoration', role: 'healer' },
    },
  },

  // Icon slugs (icons/<slug>.jpg) for the spec markers of the player rows (Wowhead icon slugs, self-hosted in icons/).
  specIcons: {
    WARRIOR: {
      Arms: 'ability_rogue_eviscerate',
      Fury: 'ability_warrior_innerrage',
      Protection: 'ability_warrior_defensivestance',
    },
    PALADIN: {
      Holy: 'spell_holy_holybolt',
      Protection: 'spell_holy_devotionaura',
      Retribution: 'spell_holy_auraoflight',
    },
    HUNTER: {
      'Beast Mastery': 'ability_hunter_beasttaming',
      Marksmanship: 'ability_marksmanship',
      Survival: 'ability_hunter_swiftstrike',
    },
    ROGUE: {
      Assassination: 'ability_rogue_eviscerate',
      Combat: 'ability_backstab',
      Subtlety: 'ability_stealth',
    },
    PRIEST: {
      Discipline: 'spell_holy_wordfortitude',
      Holy: 'spell_holy_holybolt',
      Shadow: 'spell_shadow_shadowwordpain',
    },
    SHAMAN: {
      Elemental: 'spell_nature_lightning',
      Enhancement: 'spell_nature_lightningshield',
      Restoration: 'spell_nature_magicimmunity',
    },
    MAGE: {
      Arcane: 'spell_holy_magicalsentry',
      Fire: 'spell_fire_firebolt02',
      Frost: 'spell_frost_frostbolt02',
    },
    WARLOCK: {
      Affliction: 'spell_shadow_deathcoil',
      Demonology: 'spell_shadow_metamorphosis',
      Destruction: 'spell_shadow_rainoffire',
    },
    DRUID: {
      Balance: 'spell_nature_starfall',
      Feral: 'ability_racial_bearform',
      Restoration: 'spell_nature_healingtouch',
    },
  },

  // Raid-Helper class name -> class id (Tank and Bench carry no class).
  raidHelperClassMap: {
    Hunter: 'HUNTER',
    Druid: 'DRUID',
    Warrior: 'WARRIOR',
    Priest: 'PRIEST',
    Mage: 'MAGE',
    Shaman: 'SHAMAN',
    Paladin: 'PALADIN',
    Rogue: 'ROGUE',
    Warlock: 'WARLOCK',
    Tank: null,
    Bench: null,
  },

  // Least-wrong per-class default role for a Raid-Helper sign-up that only chose a class, no spec (backlog #2,
  // 2026-09-26) - this class's single most common raid role. Every one of these is a guess the leader should confirm,
  // hybrids (Shaman/Druid) no more so than any other entry here - Import._resolveRaidHelperEntry always pairs this with
  // needsReview so the guess is never mistaken for a confidently-resolved sign-up.
  defaultRoleForClass: {
    WARRIOR: 'melee_dps',
    PALADIN: 'healer',
    HUNTER: 'ranged_dps',
    ROGUE: 'melee_dps',
    PRIEST: 'healer',
    SHAMAN: 'healer',
    MAGE: 'caster_dps',
    WARLOCK: 'caster_dps',
    DRUID: 'healer',
  },

  // Raid-Helper spec name -> class, spec and role.
  raidHelperSpecMap: {
    Arms: { class: 'WARRIOR', spec: 'Arms', role: 'melee_dps' },
    Fury: { class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' },
    Protection: { class: 'WARRIOR', spec: 'Protection', role: 'tank' },
    Holy1: { class: 'PALADIN', spec: 'Holy', role: 'healer' },
    Protection1: { class: 'PALADIN', spec: 'Protection', role: 'tank' },
    Retribution: { class: 'PALADIN', spec: 'Retribution', role: 'melee_dps' },
    Beastmastery: { class: 'HUNTER', spec: 'Beast Mastery', role: 'ranged_dps' },
    Marksmanship: { class: 'HUNTER', spec: 'Marksmanship', role: 'ranged_dps' },
    Survival: { class: 'HUNTER', spec: 'Survival', role: 'ranged_dps' },
    Assassination: { class: 'ROGUE', spec: 'Assassination', role: 'melee_dps' },
    Combat: { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' },
    Subtlety: { class: 'ROGUE', spec: 'Subtlety', role: 'melee_dps' },
    Discipline: { class: 'PRIEST', spec: 'Discipline', role: 'healer' },
    Holy: { class: 'PRIEST', spec: 'Holy', role: 'healer' },
    Shadow: { class: 'PRIEST', spec: 'Shadow', role: 'caster_dps' },
    Smite: { class: 'PRIEST', spec: 'Discipline', role: 'caster_dps' },
    Elemental: { class: 'SHAMAN', spec: 'Elemental', role: 'caster_dps' },
    Enhancement: { class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' },
    Restoration1: { class: 'SHAMAN', spec: 'Restoration', role: 'healer' },
    Restoration: { class: 'DRUID', spec: 'Restoration', role: 'healer' },
    Arcane: { class: 'MAGE', spec: 'Arcane', role: 'caster_dps' },
    Fire: { class: 'MAGE', spec: 'Fire', role: 'caster_dps' },
    Frost: { class: 'MAGE', spec: 'Frost', role: 'caster_dps' },
    Affliction: { class: 'WARLOCK', spec: 'Affliction', role: 'caster_dps' },
    Demonology: { class: 'WARLOCK', spec: 'Demonology', role: 'caster_dps' },
    Destruction: { class: 'WARLOCK', spec: 'Destruction', role: 'caster_dps' },
    Balance: { class: 'DRUID', spec: 'Balance', role: 'caster_dps' },
    Feral: { class: 'DRUID', spec: 'Feral', role: 'melee_dps' },
    Guardian: { class: 'DRUID', spec: 'Feral', role: 'tank' },
    Dreamstate: { class: 'DRUID', spec: 'Balance', role: 'healer' },
  },

  // Icon slugs (icons/<slug>.jpg) per buff id. One entry per buff id of any version: ids are reused wherever two
  // versions have the same spell, so only the totems new to Classic (Tranquil Air, Stoneskin) have entries of their
  // own.
  buffIcons: {
    WINDFURY: 'spell_nature_windfury',
    GRACE_OF_AIR: 'spell_nature_invisibilitytotem',
    WRATH_OF_AIR: 'spell_nature_slowingtotem',
    TOTEM_OF_WRATH: 'spell_fire_totemofwrath',
    MANA_SPRING: 'spell_nature_manaregentotem',
    MANA_TIDE: 'spell_frost_summonwaterelemental',
    STRENGTH_OF_EARTH: 'spell_nature_earthbindtotem',
    DEVOTION_AURA: 'spell_holy_devotionaura',
    CONCENTRATION_AURA: 'spell_holy_mindsooth',
    RETRIBUTION_AURA: 'spell_holy_auraoflight',
    SANCTITY_AURA: 'spell_holy_mindvision',
    LEADER_OF_THE_PACK: 'spell_nature_unyeildingstamina',
    MOONKIN_AURA: 'spell_nature_starfall',
    TREE_OF_LIFE: 'ability_druid_treeoflife',
    UNLEASHED_RAGE: 'spell_nature_unleashedrage',
    BATTLE_SHOUT: 'ability_warrior_battleshout',
    COMMANDING_SHOUT: 'ability_warrior_rallyingcry',
    VAMPIRIC_TOUCH: 'spell_holy_stoicism',
    TRUESHOT_AURA: 'ability_trueshot',
    FEROCIOUS_INSP: 'ability_hunter_ferociousinspiration',
    BLOOD_PACT: 'spell_shadow_bloodboil',
    TRANQUIL_AIR: 'spell_nature_brilliance',
    STONESKIN: 'spell_nature_stoneskintotem',
    // Not a buff entry: the group-card drum icon reuses these lookup maps (see getDrumsCoverage).
    DRUMS: 'inv_misc_drum_06',
  },

  // Short badge label per buff id.
  buffAbbreviations: {
    WINDFURY: 'WF',
    GRACE_OF_AIR: 'GoA',
    WRATH_OF_AIR: 'WoA',
    TOTEM_OF_WRATH: 'ToW',
    MANA_SPRING: 'MS',
    MANA_TIDE: 'MT',
    STRENGTH_OF_EARTH: 'SoE',
    DEVOTION_AURA: 'Dev',
    CONCENTRATION_AURA: 'Conc',
    RETRIBUTION_AURA: 'Ret',
    SANCTITY_AURA: 'Sanc',
    LEADER_OF_THE_PACK: 'LotP',
    MOONKIN_AURA: 'Moon',
    TREE_OF_LIFE: 'ToL',
    TRUESHOT_AURA: 'TSA',
    FEROCIOUS_INSP: 'FI',
    UNLEASHED_RAGE: 'UR',
    BATTLE_SHOUT: 'BS',
    COMMANDING_SHOUT: 'CS',
    BLOOD_PACT: 'BP',
    VAMPIRIC_TOUCH: 'VT',
    TRANQUIL_AIR: 'TqA',
    STONESKIN: 'SSk',
    // Not a buff entry: the group-card drum icon reuses these lookup maps (see getDrumsCoverage).
    DRUMS: 'Drm',
  },

  // Badge CSS class per buff id.
  buffCSSClass: {
    WINDFURY: 'buff-wf',
    GRACE_OF_AIR: 'buff-goa',
    WRATH_OF_AIR: 'buff-woa',
    TOTEM_OF_WRATH: 'buff-tow',
    MANA_SPRING: 'buff-ms',
    MANA_TIDE: 'buff-mt',
    STRENGTH_OF_EARTH: 'buff-soe',
    DEVOTION_AURA: 'buff-dev',
    CONCENTRATION_AURA: 'buff-conc',
    RETRIBUTION_AURA: 'buff-ret',
    SANCTITY_AURA: 'buff-sanc',
    LEADER_OF_THE_PACK: 'buff-lotp',
    MOONKIN_AURA: 'buff-moon',
    TREE_OF_LIFE: 'buff-tol',
    TRUESHOT_AURA: 'buff-tsa',
    FEROCIOUS_INSP: 'buff-fi',
    UNLEASHED_RAGE: 'buff-ur',
    BATTLE_SHOUT: 'buff-bs',
    COMMANDING_SHOUT: 'buff-cs',
    BLOOD_PACT: 'buff-bp',
    VAMPIRIC_TOUCH: 'buff-vt',
    TRANQUIL_AIR: 'buff-tqa',
    STONESKIN: 'buff-sst',
    // Not a buff entry: the group-card drum icon reuses these lookup maps (see getDrumsCoverage).
    DRUMS: 'buff-drums',
  },

  // Icon slugs (icons/<slug>.jpg) per debuff id. Best-effort Wowhead slugs - entries left blank fall back to the text
  // abbreviation (same graceful-degradation pattern as Config.BuffIconURL).
  debuffIcons: {
    JUDGEMENT_CRUSADER: 'spell_holy_holysmite',
    JUDGEMENT_LIGHT: 'spell_holy_healingaura',
    JUDGEMENT_WISDOM: 'spell_holy_sealofwisdom',
    SUNDER_ARMOR: 'ability_warrior_sunder',
    DEMORALIZING_SHOUT: 'ability_warrior_warcry',
    THUNDER_CLAP: 'spell_nature_thunderclap',
    BLOOD_FRENZY: 'ability_warrior_bloodfrenzy',
    EXPOSE_ARMOR: 'ability_warrior_riposte',
    HEMORRHAGE: 'spell_shadow_lifedrain',
    FAERIE_FIRE_BALANCE: 'spell_nature_faeriefire',
    FAERIE_FIRE_FERAL: 'spell_nature_faeriefire',
    FAERIE_FIRE: 'spell_nature_faeriefire',
    MANGLE: 'ability_druid_mangle2',
    DEMORALIZING_ROAR: 'ability_druid_demoralizingroar',
    INSECT_SWARM: 'spell_nature_insectswarm',
    CURSE_ELEMENTS: 'spell_shadow_chilltouch',
    CURSE_RECKLESSNESS: 'spell_shadow_curseofmannoroth',
    SHADOW_EMBRACE: 'spell_shadow_shadowembrace',
    IMPROVED_SHADOW_BOLT: 'spell_shadow_shadowbolt',
    SHADOW_WEAVING: 'spell_shadow_blackplague',
    STORMSTRIKE: 'ability_shaman_stormstrike',
  },

  // Short label per debuff id.
  debuffAbbreviations: {
    JUDGEMENT_CRUSADER: 'JotC',
    JUDGEMENT_LIGHT: 'JoL',
    JUDGEMENT_WISDOM: 'JoW',
    SUNDER_ARMOR: 'Sun',
    DEMORALIZING_SHOUT: 'DS',
    THUNDER_CLAP: 'TC',
    BLOOD_FRENZY: 'BF',
    EXPOSE_ARMOR: 'EA',
    HEMORRHAGE: 'Hem',
    FAERIE_FIRE_BALANCE: 'FF',
    FAERIE_FIRE_FERAL: 'FF',
    FAERIE_FIRE: 'FF',
    MANGLE: 'Man',
    DEMORALIZING_ROAR: 'DR',
    INSECT_SWARM: 'IS',
    CURSE_ELEMENTS: 'CoE',
    CURSE_RECKLESSNESS: 'CoR',
    CURSE_WEAKNESS: 'CoW',
    SHADOW_EMBRACE: 'SE',
    IMPROVED_SHADOW_BOLT: 'ISB',
    WINTERS_CHILL: 'WC',
    IMPROVED_SCORCH: 'Scorch',
    SHADOW_WEAVING: 'SW',
    MISERY: 'Mis',
    VAMPIRIC_EMBRACE: 'VE',
    STORMSTRIKE: 'SS',
    SCORPID_STING: 'Scorp',
    HUNTERS_MARK: 'HM',
    EXPOSE_WEAKNESS: 'EW',
  },
};
