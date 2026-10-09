/* ================================================================
   PARTY PLANNER WEB — Full TBC Raid Group Builder
   Ported from the WoW addon Lua codebase
   ================================================================ */

// ── UTILITIES ───────────────────────────────────────────────────
// Regex-based (not DOM-round-trip) so it also escapes the characters that
// matter in HTML ATTRIBUTE position, not just text-node position: the old
// document.createElement/textContent trick only produced &amp;/&lt;/&gt;,
// which left every `attr="${esc(name)}"` call site open to attribute-
// injection from a raw " or ' in a player/template/roster name. Also keeps
// esc() DOM-free so it can be unit-tested under Node and used by PrintSheet.
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
let _uid = 0;
function nextUid() { return 'p' + (++_uid); }

// ── CHAT-SAFE TEXT (shared by every raid-chat/Discord text exporter) ──
// WoW's client fonts and chat parser render printable ASCII plus the accented
// Latin letters that real WoW character names commonly use (Latin-1
// Supplement / Latin Extended-A/B — e.g. "Thràll", "Jaïna", "Äsh"), but not
// emoji, CJK, symbols, or box-drawing glyphs. Deleting those accented letters
// outright (the old per-exporter behavior) corrupted player names
// ("Thràll" -> "Thrll"). This normalizes common "smart" punctuation to plain
// ASCII first (so meaning survives), strips everything else outside the safe
// ranges, and collapses whitespace runs the stripping leaves behind.
function chatSafe(str) {
  let s = String(str == null ? '' : str)
    .replace(/[‐-―−]/g, '-')        // hyphen/dash variants, minus sign
    .replace(/[‘’‚‛]/g, "'")   // curly single quotes
    .replace(/[“”„‟]/g, '"')   // curly double quotes
    .replace(/…/g, '...')                      // ellipsis
    .replace(/[•‣◦⁃∙·]/g, '-') // bullets / middle dot
    .replace(/[←→↔⇐⇒⇔]/g, '->'); // arrows
  // Keep printable ASCII plus Latin-1 Supplement / Latin Extended-A/B letters
  // (U+00C0-U+024F), excluding the multiplication (U+00D7) and division
  // (U+00F7) signs that live in that block but aren't letters. Everything
  // else (emoji, CJK, symbols, box drawing, control chars) is dropped.
  s = s.replace(/[^\x20-\x7EÀ-ÖØ-öø-ɏ]/g, '');
  return s.replace(/ {2,}/g, ' ');
}
// Truncates `str` to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte character in half, appending '.' when truncation happens
// (mirrors the old char-count cap's truncation marker). WoW's /raid chat
// 255-character limit is actually a 255-BYTE limit, and an accented letter
// kept by chatSafe() can take 2 bytes.
function clipUtf8Bytes(str, maxBytes = 255) {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return str;
  let end = maxBytes - 1; // reserve a byte for the trailing '.'
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--; // don't split a UTF-8 continuation byte
  return new TextDecoder().decode(bytes.slice(0, end)) + '.';
}
// Shared by the global keyboard-shortcut dispatcher (past the UI split
// marker) and input-tests.js. True when the given target is actively
// capturing text input, so a shortcut keystroke must not be hijacked from
// a player-name field, a raid-notes textarea, the JSON-paste box, etc.
// Duck-typed on purpose so it can be unit-tested with plain mock objects.
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!el.isContentEditable;
}

// ── CONFIG ──────────────────────────────────────────────────────
const Config = {
  ClassColors: {
    WARRIOR: '#C69B6D', PALADIN: '#F48CBA', HUNTER: '#AAD372',
    ROGUE: '#FFF468', PRIEST: '#d0d0d0', SHAMAN: '#0070DD',
    MAGE: '#3FC7EB', WARLOCK: '#8788EE', DRUID: '#FF7C0A',
  },

  Roles: { TANK:'tank', HEALER:'healer', MELEE_DPS:'melee_dps', RANGED_DPS:'ranged_dps', CASTER_DPS:'caster_dps' },

  Specs: {
    WARRIOR: { 1:{name:'Arms',role:'melee_dps'},2:{name:'Fury',role:'melee_dps'},3:{name:'Protection',role:'tank'} },
    PALADIN: { 1:{name:'Holy',role:'healer'},2:{name:'Protection',role:'tank'},3:{name:'Retribution',role:'melee_dps'} },
    HUNTER:  { 1:{name:'Beast Mastery',role:'ranged_dps'},2:{name:'Marksmanship',role:'ranged_dps'},3:{name:'Survival',role:'ranged_dps'} },
    ROGUE:   { 1:{name:'Assassination',role:'melee_dps'},2:{name:'Combat',role:'melee_dps'},3:{name:'Subtlety',role:'melee_dps'} },
    PRIEST:  { 1:{name:'Discipline',role:'healer'},2:{name:'Holy',role:'healer'},3:{name:'Shadow',role:'caster_dps'} },
    SHAMAN:  { 1:{name:'Elemental',role:'caster_dps'},2:{name:'Enhancement',role:'melee_dps'},3:{name:'Restoration',role:'healer'} },
    MAGE:    { 1:{name:'Arcane',role:'caster_dps'},2:{name:'Fire',role:'caster_dps'},3:{name:'Frost',role:'caster_dps'} },
    WARLOCK: { 1:{name:'Affliction',role:'caster_dps'},2:{name:'Demonology',role:'caster_dps'},3:{name:'Destruction',role:'caster_dps'} },
    DRUID:   { 1:{name:'Balance',role:'caster_dps'},2:{name:'Feral',role:'melee_dps'},3:{name:'Restoration',role:'healer'} },
  },

  Buffs: {
    WINDFURY:          { name:'Windfury Totem',       sourceClass:'SHAMAN', preferSpec:'Enhancement', benefitsRoles:['tank','melee_dps'], priority:{melee_dps:100, tank:70}, desc:'Enchants nearby party members\' main-hand weapons with wind, granting each hit a 20% chance to trigger an extra attack with bonus AP.' },
    GRACE_OF_AIR:      { name:'Grace of Air Totem',   sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:60, desc:'Increases agility of nearby party members by 77.' },
    WRATH_OF_AIR:      { name:'Wrath of Air Totem',   sourceClass:'SHAMAN', benefitsRoles:['tank','caster_dps','healer'], priority:85, desc:'Increases spell power of nearby party members by 101.' },
    TOTEM_OF_WRATH:    { name:'Totem of Wrath',       sourceClass:'SHAMAN', sourceSpec:'Elemental', benefitsRoles:['caster_dps','healer'], priority:80, desc:'Increases spell hit chance of nearby party members by 3% and spell critical strike chance by 3%.' },
    MANA_SPRING:       { name:'Mana Spring Totem',    sourceClass:'SHAMAN', benefitsRoles:['healer','caster_dps'], priority:{healer:58, caster_dps:48}, desc:'Restores 20 mana every 2 seconds to nearby party members.' },
    MANA_TIDE:         { name:'Mana Tide Totem',      sourceClass:'SHAMAN', sourceSpec:'Restoration', benefitsRoles:['healer','caster_dps'], priority:70, desc:'Restores 24% of total mana to nearby party members over 12 seconds.' },
    STRENGTH_OF_EARTH: { name:'Strength of Earth',    sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps'], priority:55, desc:'Increases strength of nearby party members by 86.' },
    DEVOTION_AURA:     { name:'Devotion Aura',        sourceClass:'PALADIN', benefitsRoles:['tank'], priority:75, desc:'Increases armor of nearby party members by 861.' },
    CONCENTRATION_AURA:{ name:'Concentration Aura',   sourceClass:'PALADIN', benefitsRoles:['healer','caster_dps'], priority:{healer:65, caster_dps:55}, desc:'Reduces the duration of silence and interrupt effects by 30% and gives 35% resistance to pushback while casting.' },
    RETRIBUTION_AURA:  { name:'Retribution Aura',     sourceClass:'PALADIN', benefitsRoles:['tank','melee_dps'], priority:30, desc:'Causes 26 Holy damage to any enemy that strikes nearby party members.' },
    SANCTITY_AURA:     { name:'Sanctity Aura',        sourceClass:'PALADIN', sourceSpec:'Retribution', benefitsRoles:['melee_dps','ranged_dps','caster_dps','tank'], priority:{melee_dps:80, ranged_dps:80, caster_dps:80, tank:40}, desc:'Increases Holy damage done by party members by 10%. Improved Sanctity Aura also increases all damage done by party members by 2%.' },
    LEADER_OF_THE_PACK:{ name:'Leader of the Pack',   sourceClass:'DRUID', sourceSpec:'Feral', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:{melee_dps:78, tank:65}, desc:'Increases melee and ranged critical strike chance of nearby party members by 5%.' },
    MOONKIN_AURA:      { name:'Moonkin Aura',         sourceClass:'DRUID', sourceSpec:'Balance', benefitsRoles:['caster_dps'], priority:72, desc:'Increases spell critical strike chance of nearby party members by 5%.' },
    TRUESHOT_AURA:     { name:'Trueshot Aura',        sourceClass:'HUNTER', sourceSpec:'Marksmanship', benefitsRoles:['melee_dps','ranged_dps'], priority:62, desc:'Increases attack power of nearby party members by 125.' },
    FEROCIOUS_INSP:    { name:'Ferocious Inspiration',sourceClass:'HUNTER', sourceSpec:'Beast Mastery', benefitsRoles:['tank','melee_dps','ranged_dps','caster_dps'], priority:58, desc:'When your pet scores a critical hit, all party members gain 3% increased damage for 10 seconds.' },
    TREE_OF_LIFE:      { name:'Tree of Life',          sourceClass:'DRUID', sourceSpec:'Restoration', benefitsRoles:['tank','healer'], priority:{tank:90, healer:10, melee_dps:10, ranged_dps:10, caster_dps:10}, desc:'Increases healing received by nearby party members by 25% of the Druid\'s spirit.' },
    UNLEASHED_RAGE:    { name:'Unleashed Rage',        sourceClass:'SHAMAN', sourceSpec:'Enhancement', benefitsRoles:['tank','melee_dps'], priority:{melee_dps:88, tank:60}, desc:'Increases melee attack power of nearby party members by 10% after landing a melee critical strike.' },
    BATTLE_SHOUT:      { name:'Battle Shout',          sourceClass:'WARRIOR', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:{melee_dps:65, tank:50}, desc:'Increases attack power of nearby party members by 305 for 2 minutes.' },
    BLOOD_PACT:        { name:'Blood Pact',           sourceClass:'WARLOCK', benefitsRoles:['tank'], priority:40, desc:'Increases max health of nearby party members by 1330.' },
    VAMPIRIC_TOUCH:    { name:'Vampiric Touch',       sourceClass:'PRIEST', sourceSpec:'Shadow', benefitsRoles:['healer','caster_dps'], priority:{caster_dps:75, healer:55}, desc:'Restores mana to nearby party members equal to 5% of Shadow damage dealt.' },
  },

  BuffAbbreviations: {
    WINDFURY:'WF', GRACE_OF_AIR:'GoA', WRATH_OF_AIR:'WoA', TOTEM_OF_WRATH:'ToW',
    MANA_SPRING:'MS', MANA_TIDE:'MT', STRENGTH_OF_EARTH:'SoE',
    DEVOTION_AURA:'Dev', CONCENTRATION_AURA:'Conc', RETRIBUTION_AURA:'Ret', SANCTITY_AURA:'Sanc',
    LEADER_OF_THE_PACK:'LotP', MOONKIN_AURA:'Moon', TREE_OF_LIFE:'ToL', TRUESHOT_AURA:'TSA', FEROCIOUS_INSP:'FI',
    UNLEASHED_RAGE:'UR', BATTLE_SHOUT:'BS', BLOOD_PACT:'BP', VAMPIRIC_TOUCH:'VT',
    TRANQUIL_AIR:'TqA', STONESKIN:'SSk',
    // Not a Config.Buffs entry (see getDrumsCoverage) — just reusing the same
    // abbreviation/CSS/icon lookup maps for the group-card drum icon.
    DRUMS:'Drm',
  },

  BuffCSSClass: {
    WINDFURY:'buff-wf', GRACE_OF_AIR:'buff-goa', WRATH_OF_AIR:'buff-woa', TOTEM_OF_WRATH:'buff-tow',
    MANA_SPRING:'buff-ms', MANA_TIDE:'buff-mt', STRENGTH_OF_EARTH:'buff-soe',
    DEVOTION_AURA:'buff-dev', CONCENTRATION_AURA:'buff-conc', RETRIBUTION_AURA:'buff-ret', SANCTITY_AURA:'buff-sanc',
    LEADER_OF_THE_PACK:'buff-lotp', MOONKIN_AURA:'buff-moon', TREE_OF_LIFE:'buff-tol', TRUESHOT_AURA:'buff-tsa', FEROCIOUS_INSP:'buff-fi',
    UNLEASHED_RAGE:'buff-ur', BATTLE_SHOUT:'buff-bs', BLOOD_PACT:'buff-bp', VAMPIRIC_TOUCH:'buff-vt',
    TRANQUIL_AIR:'buff-tqa', STONESKIN:'buff-sst', DRUMS:'buff-drums',
  },

  // Icon files are self-hosted in icons/ (one <name>.jpg per slug, fetched once from the
  // Wowhead CDN); every spec/class/role/buff/debuff icon goes through this one URL builder.
  IconURL(name) {
    return name ? `/icons/${name}.jpg` : '';
  },

  // Wowhead icon slugs (= icons/<slug>.jpg) for each buff
  BuffIcons: {
    WINDFURY:           'spell_nature_windfury',
    GRACE_OF_AIR:       'spell_nature_invisibilitytotem',
    WRATH_OF_AIR:       'spell_nature_slowingtotem',
    TOTEM_OF_WRATH:     'spell_fire_totemofwrath',
    MANA_SPRING:        'spell_nature_manaregentotem',
    MANA_TIDE:          'spell_frost_summonwaterelemental',
    STRENGTH_OF_EARTH:  'spell_nature_earthbindtotem',
    DEVOTION_AURA:      'spell_holy_devotionaura',
    CONCENTRATION_AURA: 'spell_holy_mindsooth',
    RETRIBUTION_AURA:   'spell_holy_auraoflight',
    SANCTITY_AURA:      'spell_holy_mindvision',
    LEADER_OF_THE_PACK: 'spell_nature_unyeildingstamina',
    MOONKIN_AURA:       'spell_nature_starfall',
    TREE_OF_LIFE:       'ability_druid_treeoflife',
    UNLEASHED_RAGE:     'spell_nature_unleashedrage',
    BATTLE_SHOUT:       'ability_warrior_battleshout',
    VAMPIRIC_TOUCH:     'spell_holy_stoicism',
    TRUESHOT_AURA:      'ability_trueshot',
    FEROCIOUS_INSP:     'ability_hunter_ferociousinspiration',
    BLOOD_PACT:         'spell_shadow_bloodboil',
    TRANQUIL_AIR:       'spell_nature_brilliance',
    STONESKIN:          'spell_nature_stoneskintotem',
    DRUMS:              'inv_misc_drum_06',
  },
  BuffIconURL(id) {
    return this.IconURL(this.BuffIcons[id]);
  },

  // ── Raid debuffs (applied to enemy targets, not the raid) ──
  // family/competesWith/supersededBy model non-stacking debuff slots — see
  // https://www.warcrafttavern.com/tbc/guides/warlock-curses/ and
  // https://www.warcrafttavern.com/tbc/guides/rogue-expose-armor/ for the mechanics.
  Debuffs: {
    JUDGEMENT_CRUSADER:  { name:'Judgement of the Crusader', sourceClass:'PALADIN', sourceSpec:'Retribution', desc:'Attackers have a 3% increased chance to critically hit the target, which also takes 219 increased Holy damage.' },
    JUDGEMENT_LIGHT:      { name:'Judgement of Light',        sourceClass:'PALADIN', desc:'Melee attackers have a chance to heal themselves for 95 health.' },
    JUDGEMENT_WISDOM:     { name:'Judgement of Wisdom',       sourceClass:'PALADIN', desc:'Attacks and spells against the target have a chance to restore 74 mana.' },
    SUNDER_ARMOR:         { name:'Sunder Armor',              sourceClass:'WARRIOR', desc:'Reduces the target\'s armor by up to 2600 (5 stacks).', competesWith:['EXPOSE_ARMOR'] },
    DEMORALIZING_SHOUT:   { name:'Demoralizing Shout',        sourceClass:'WARRIOR', desc:'Reduces the target\'s melee attack power by 300 (420 with Improved Demoralizing Shout).', competesWith:['DEMORALIZING_ROAR','CURSE_WEAKNESS'] },
    THUNDER_CLAP:         { name:'Thunder Clap',              sourceClass:'WARRIOR', desc:'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).' },
    BLOOD_FRENZY:         { name:'Blood Frenzy',              sourceClass:'WARRIOR', sourceSpec:'Arms', desc:'Increases Physical damage taken by the target by 4%.' },
    EXPOSE_ARMOR:         { name:'Expose Armor',              sourceClass:'ROGUE', desc:'Reduces the target\'s armor by 2050 (3075 with Improved Expose Armor).', competesWith:['SUNDER_ARMOR'] },
    HEMORRHAGE:           { name:'Hemorrhage',                sourceClass:'ROGUE', sourceSpec:'Subtlety', desc:'Increases Physical damage taken by the target by 42, for 10 charges.' },
    FAERIE_FIRE_BALANCE:  { name:'Faerie Fire',                sourceClass:'DRUID', sourceSpec:'Balance', desc:'Reduces the target\'s armor by 610 and, with Improved Faerie Fire, gives attackers +3% chance to hit.' },
    FAERIE_FIRE_FERAL:    { name:'Faerie Fire (Feral)',        sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s armor by 610.', supersededBy:'FAERIE_FIRE_BALANCE' },
    MANGLE:               { name:'Mangle',                     sourceClass:'DRUID', sourceSpec:'Feral', desc:'Increases damage taken from bleed effects by 30%.' },
    DEMORALIZING_ROAR:    { name:'Demoralizing Roar',          sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s melee attack power by 232.', competesWith:['DEMORALIZING_SHOUT','CURSE_WEAKNESS'] },
    INSECT_SWARM:         { name:'Insect Swarm',               sourceClass:'DRUID', sourceSpec:'Balance', desc:'Reduces the target\'s chance to hit by 2%.' },
    CURSE_ELEMENTS:       { name:'Curse of the Elements',      sourceClass:'WARLOCK', desc:'Reduces resistance to Fire/Frost/Shadow by 88 and increases Arcane/Fire/Frost/Shadow damage taken by 10%.', competesWith:['CURSE_RECKLESSNESS','CURSE_WEAKNESS'] },
    CURSE_RECKLESSNESS:   { name:'Curse of Recklessness',      sourceClass:'WARLOCK', desc:'Increases melee attack power by 135 but reduces armor by 800.', competesWith:['CURSE_ELEMENTS','CURSE_WEAKNESS'] },
    CURSE_WEAKNESS:       { name:'Curse of Weakness',          sourceClass:'WARLOCK', desc:'Reduces the target\'s melee attack power by 350.', competesWith:['CURSE_ELEMENTS','CURSE_RECKLESSNESS','DEMORALIZING_SHOUT','DEMORALIZING_ROAR'] },
    SHADOW_EMBRACE:       { name:'Shadow Embrace',             sourceClass:'WARLOCK', sourceSpec:'Affliction', desc:'Reduces the target\'s Physical damage dealt by 5%.' },
    IMPROVED_SHADOW_BOLT: { name:'Improved Shadow Bolt',       sourceClass:'WARLOCK', sourceSpec:'Destruction', desc:'Increases Shadow damage taken by the target by 20%, for 5 charges.' },
    WINTERS_CHILL:        { name:'Winter\'s Chill',            sourceClass:'MAGE', sourceSpec:'Frost', desc:'Increases the target\'s chance to be critically hit by Frost spells by 10%.' },
    IMPROVED_SCORCH:      { name:'Improved Scorch',            sourceClass:'MAGE', sourceSpec:'Fire', desc:'Increases Fire damage taken by the target by 15%.' },
    SHADOW_WEAVING:       { name:'Shadow Weaving',             sourceClass:'PRIEST', sourceSpec:'Shadow', desc:'Increases Shadow damage taken by the target by 10%.' },
    MISERY:               { name:'Misery',                     sourceClass:'PRIEST', sourceSpec:'Shadow', desc:'Increases Spell damage taken by the target by 5%.' },
    VAMPIRIC_EMBRACE:     { name:'Vampiric Embrace',           sourceClass:'PRIEST', sourceSpec:'Shadow', desc:'Heals the caster\'s party for 15% of the Priest\'s damage dealt to the target.' },
    STORMSTRIKE:          { name:'Stormstrike',                sourceClass:'SHAMAN', sourceSpec:'Enhancement', desc:'Increases Nature damage taken by the target by 20%, for 2 charges.' },
    SCORPID_STING:        { name:'Scorpid Sting',              sourceClass:'HUNTER', desc:'Reduces the target\'s chance to hit with melee/ranged attacks by 5%.' },
    HUNTERS_MARK:         { name:'Hunter\'s Mark',              sourceClass:'HUNTER', desc:'Grants attackers 110 increased melee/ranged attack power against the target.' },
    EXPOSE_WEAKNESS:      { name:'Expose Weakness',            sourceClass:'HUNTER', sourceSpec:'Survival', desc:'Grants attackers bonus attack power equal to 25% of the Hunter\'s Agility.' },
  },

  DebuffAbbreviations: {
    JUDGEMENT_CRUSADER:'JotC', JUDGEMENT_LIGHT:'JoL', JUDGEMENT_WISDOM:'JoW',
    SUNDER_ARMOR:'Sun', DEMORALIZING_SHOUT:'DS', THUNDER_CLAP:'TC', BLOOD_FRENZY:'BF',
    EXPOSE_ARMOR:'EA', HEMORRHAGE:'Hem',
    FAERIE_FIRE_BALANCE:'FF', FAERIE_FIRE_FERAL:'FF', MANGLE:'Man', DEMORALIZING_ROAR:'DR', INSECT_SWARM:'IS',
    CURSE_ELEMENTS:'CoE', CURSE_RECKLESSNESS:'CoR', CURSE_WEAKNESS:'CoW', SHADOW_EMBRACE:'SE', IMPROVED_SHADOW_BOLT:'ISB',
    WINTERS_CHILL:'WC', IMPROVED_SCORCH:'Scorch',
    SHADOW_WEAVING:'SW', MISERY:'Mis', VAMPIRIC_EMBRACE:'VE',
    STORMSTRIKE:'SS',
    SCORPID_STING:'Scorp', HUNTERS_MARK:'HM', EXPOSE_WEAKNESS:'EW',
  },

  // Best-effort Wowhead icon slugs — entries left blank fall back to the text
  // abbreviation above (same graceful-degradation pattern as BuffIconURL).
  DebuffIcons: {
    JUDGEMENT_CRUSADER: 'spell_holy_holysmite',
    JUDGEMENT_LIGHT:    'spell_holy_healingaura',
    JUDGEMENT_WISDOM:   'spell_holy_sealofwisdom',
    SUNDER_ARMOR:       'ability_warrior_sunder',
    DEMORALIZING_SHOUT: 'ability_warrior_warcry',
    THUNDER_CLAP:       'spell_nature_thunderclap',
    BLOOD_FRENZY:       'ability_warrior_bloodfrenzy',
    EXPOSE_ARMOR:       'ability_warrior_riposte',
    HEMORRHAGE:         'spell_shadow_lifedrain',
    FAERIE_FIRE_BALANCE:'spell_nature_faeriefire',
    FAERIE_FIRE_FERAL:  'spell_nature_faeriefire',
    MANGLE:             'ability_druid_mangle2',
    DEMORALIZING_ROAR:  'ability_druid_demoralizingroar',
    INSECT_SWARM:       'spell_nature_insectswarm',
    CURSE_ELEMENTS:     'spell_shadow_chilltouch',
    CURSE_RECKLESSNESS: 'spell_shadow_curseofmannoroth',
    SHADOW_EMBRACE:     'spell_shadow_shadowembrace',
    IMPROVED_SHADOW_BOLT:'spell_shadow_shadowbolt',
    SHADOW_WEAVING:     'spell_shadow_blackplague',
    STORMSTRIKE:        'ability_shaman_stormstrike',
  },
  DebuffIconURL(id) {
    return this.IconURL(this.DebuffIcons[id]);
  },

  Raids: {
    kara:  { name:'Karazhan',            size:10, groups:2, tier:'Tier 4' },
    gruul: { name:"Gruul's Lair",        size:25, groups:5, tier:'Tier 4' },
    mag:   { name:"Magtheridon's Lair",  size:25, groups:5, tier:'Tier 4' },
    ssc:   { name:'Serpentshrine Cavern',size:25, groups:5, tier:'Tier 5' },
    tk:    { name:'Tempest Keep',        size:25, groups:5, tier:'Tier 5' },
    za:    { name:"Zul'Aman",            size:10, groups:2, tier:'Tier 5' },
    hyjal: { name:'Hyjal Summit',        size:25, groups:5, tier:'Tier 6' },
    bt:    { name:'Black Temple',        size:25, groups:5, tier:'Tier 6' },
    swp:   { name:'Sunwell Plateau',     size:25, groups:5, tier:'Tier 6' },
  },
  RaidOrder: ['kara','gruul','mag','ssc','tk','za','hyjal','bt','swp'],
  TierOrder: ['Tier 4', 'Tier 5', 'Tier 6'],

  // Minimum tanks and healers a raid of this size must seat before DPS
  // compete for the remaining seats (when more signed up than the raid
  // holds), and the roles OpenSlots suggests first for empty seats. Readiness
  // reports "N healers short" against them. These are planning floors chosen
  // for this tool, not a game rule — 20/40 are Classic Era raid sizes.
  RaidFloors: {
    10: { tank: 2, healer: 3 },
    20: { tank: 2, healer: 4 },
    25: { tank: 2, healer: 5 },
    40: { tank: 4, healer: 10 },
  },

  RaidHelperClassMap: {
    Hunter:'HUNTER', Druid:'DRUID', Warrior:'WARRIOR', Priest:'PRIEST',
    Mage:'MAGE', Shaman:'SHAMAN', Paladin:'PALADIN', Rogue:'ROGUE', Warlock:'WARLOCK',
    Tank:null, Bench:null,
  },

  // Least-wrong per-class default role for a Raid-Helper sign-up that only
  // chose a class, no spec (backlog #2, 2026-09-26) — this class's single
  // most common raid role. Every one of these is a guess the leader should
  // confirm, hybrids (Shaman/Druid) no more so than any other entry here —
  // Import._resolveRaidHelperEntry always pairs this with needsReview so the
  // guess is never mistaken for a confidently-resolved sign-up.
  DefaultRoleForClass: {
    WARRIOR:'melee_dps', PALADIN:'healer', HUNTER:'ranged_dps', ROGUE:'melee_dps',
    PRIEST:'healer', SHAMAN:'healer', MAGE:'caster_dps', WARLOCK:'caster_dps', DRUID:'healer',
  },

  RaidHelperSpecMap: {
    Arms:        {class:'WARRIOR',spec:'Arms',      role:'melee_dps'},
    Fury:        {class:'WARRIOR',spec:'Fury',       role:'melee_dps'},
    Protection:  {class:'WARRIOR',spec:'Protection', role:'tank'},
    Holy1:       {class:'PALADIN',spec:'Holy',       role:'healer'},
    Protection1: {class:'PALADIN',spec:'Protection', role:'tank'},
    Retribution: {class:'PALADIN',spec:'Retribution',role:'melee_dps'},
    Beastmastery:{class:'HUNTER', spec:'Beast Mastery',role:'ranged_dps'},
    Marksmanship:{class:'HUNTER', spec:'Marksmanship',role:'ranged_dps'},
    Survival:    {class:'HUNTER', spec:'Survival',    role:'ranged_dps'},
    Assassination:{class:'ROGUE',spec:'Assassination',role:'melee_dps'},
    Combat:      {class:'ROGUE', spec:'Combat',       role:'melee_dps'},
    Subtlety:    {class:'ROGUE', spec:'Subtlety',     role:'melee_dps'},
    Discipline:  {class:'PRIEST',spec:'Discipline',   role:'healer'},
    Holy:        {class:'PRIEST',spec:'Holy',          role:'healer'},
    Shadow:      {class:'PRIEST',spec:'Shadow',        role:'caster_dps'},
    Smite:       {class:'PRIEST',spec:'Discipline',    role:'caster_dps'},
    Elemental:   {class:'SHAMAN',spec:'Elemental',     role:'caster_dps'},
    Enhancement: {class:'SHAMAN',spec:'Enhancement',   role:'melee_dps'},
    Restoration1:{class:'SHAMAN',spec:'Restoration',   role:'healer'},
    Restoration: {class:'DRUID', spec:'Restoration',   role:'healer'},
    Arcane:      {class:'MAGE',  spec:'Arcane',        role:'caster_dps'},
    Fire:        {class:'MAGE',  spec:'Fire',          role:'caster_dps'},
    Frost:       {class:'MAGE',  spec:'Frost',         role:'caster_dps'},
    Affliction:  {class:'WARLOCK',spec:'Affliction',   role:'caster_dps'},
    Demonology:  {class:'WARLOCK',spec:'Demonology',   role:'caster_dps'},
    Destruction: {class:'WARLOCK',spec:'Destruction',   role:'caster_dps'},
    Balance:     {class:'DRUID', spec:'Balance',        role:'caster_dps'},
    Feral:       {class:'DRUID', spec:'Feral',          role:'melee_dps'},
    Guardian:    {class:'DRUID', spec:'Feral',          role:'tank'},
    Dreamstate:  {class:'DRUID', spec:'Balance',        role:'healer'},
  },
};

// Version profiles own their raid catalog and rule availability. Forever templates
// are planning capacities chosen by the user, not claims about beta raid sizes.
// `modeled` is derived below from Rulesets — a version is modeled iff it has one.
const GameVersions = {
  tbc: { name:'WoW TBC', defaultRaid:'bt', raids:[...Config.RaidOrder], note:'TBC party buffs and optimization rules.' },
  classic: { name:'WoW Classic', defaultRaid:'mc', raids:[], note:'WoW Classic Era party buffs, composition and optimizer rules. Faction-aware: Horde shamans, Alliance paladins.' },
  forever: { name:'WoW Forever (Beta)', defaultRaid:'f_ony', raids:[], note:'Rules follow Wowhead Forever beta data as of 2026-09-26: Paladin and Shaman on both factions (no faction lock), Trueshot Aura baseline for every Hunter, Leader of the Pack/Moonkin Aura merged into one exclusive crit buff, and the confirmed Barrow Deeps/Hyjal Summit/Onyxia\'s Lair raids.' },
};
// Real Classic Era raids, in phase order (tasks/research-classic-buffs.md).
// Unique keys so they never collide with TBC's Config.Raids entries.
const CLASSIC_RAIDS = {
  mc:   { name:'Molten Core',            size:40, groups:8, tier:'Phase 1' },
  ony:  { name:"Onyxia's Lair",          size:40, groups:8, tier:'Phase 1' },
  bwl:  { name:'Blackwing Lair',         size:40, groups:8, tier:'Phase 3' },
  zg:   { name:"Zul'Gurub",              size:20, groups:4, tier:'Phase 4' },
  aq20: { name:"Ruins of Ahn'Qiraj",     size:20, groups:4, tier:'Phase 5' },
  aq40: { name:'Temple of Ahn\'Qiraj',   size:40, groups:8, tier:'Phase 5' },
  naxx: { name:'Naxxramas',              size:40, groups:8, tier:'Phase 6' },
};
for (const [key, raid] of Object.entries(CLASSIC_RAIDS)) {
  Config.Raids[key] = raid;
  GameVersions.classic.raids.push(key);
}
// Real WoW Forever raids, confirmed via a full-page browser read of Wowhead's
// raids-overview guide (tasks/research-forever.md, "Browser verification"
// section, "Raids" table) — launching December 9, 2026. 'f_' prefix keeps
// these unique from Classic's 'ony' key (Onyxia exists in both games).
const FOREVER_RAIDS = {
  f_barrow: { name:'Barrow Deeps',   size:10, groups:2, tier:'Launch (Dec 9, 2026)' },
  f_hyjal:  { name:'Hyjal Summit',   size:20, groups:4, tier:'Launch (Dec 9, 2026)' },
  f_ony:    { name:"Onyxia's Lair",  size:40, groups:8, tier:'Launch (Dec 9, 2026)' },
};
for (const [key, raid] of Object.entries(FOREVER_RAIDS)) {
  Config.Raids[key] = raid;
  GameVersions.forever.raids.push(key);
}
// Classic/Forever planning templates — kept after the real raids above so old
// saved plans (keyed on classicN/foreverN) keep working.
for (const version of ['classic', 'forever']) {
  for (const size of [10, 20, 40]) {
    const key = version + size;
    GameVersions[version].raids.push(key);
    Config.Raids[key] = {name:`${size}-player template`, size, groups:size/5, tier:'Planning templates'};
  }
}

// ── RULESET REGISTRY ────────────────────────────────────────────
// Every piece of version-specific game-rules data (buffs, specs, optimizer
// value tables, class-specific scoring hooks) is looked up through here, one
// key per GameVersion. Classic/Forever stay null (empty ruleset) until their
// data lands in a later phase — see activeRules(). A few TBC tables (the
// Optimizer's DPS_VALUE/MIT_VALUE/etc. and IdealComp) are defined further
// down the file; they're folded into Rulesets.tbc right after they're built.
const Rulesets = {
  tbc: {
    buffs: Config.Buffs,
    debuffs: Config.Debuffs,
    specs: Config.Specs,
    raidHelperSpecMap: Config.RaidHelperSpecMap,
    classList: ['WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID'],
    // TBC talent-tree icons for the player rows' spec marker (Wowhead icon slugs, self-hosted in icons/).
    specIcons: {
      WARRIOR: { Arms:'ability_rogue_eviscerate', Fury:'ability_warrior_innerrage', Protection:'ability_warrior_defensivestance' },
      PALADIN: { Holy:'spell_holy_holybolt', Protection:'spell_holy_devotionaura', Retribution:'spell_holy_auraoflight' },
      HUNTER:  { 'Beast Mastery':'ability_hunter_beasttaming', Marksmanship:'ability_marksmanship', Survival:'ability_hunter_swiftstrike' },
      ROGUE:   { Assassination:'ability_rogue_eviscerate', Combat:'ability_backstab', Subtlety:'ability_stealth' },
      PRIEST:  { Discipline:'spell_holy_wordfortitude', Holy:'spell_holy_holybolt', Shadow:'spell_shadow_shadowwordpain' },
      SHAMAN:  { Elemental:'spell_nature_lightning', Enhancement:'spell_nature_lightningshield', Restoration:'spell_nature_magicimmunity' },
      MAGE:    { Arcane:'spell_holy_magicalsentry', Fire:'spell_fire_firebolt02', Frost:'spell_frost_frostbolt02' },
      WARLOCK: { Affliction:'spell_shadow_deathcoil', Demonology:'spell_shadow_metamorphosis', Destruction:'spell_shadow_rainoffire' },
      DRUID:   { Balance:'spell_nature_starfall', Feral:'ability_racial_bearform', Restoration:'spell_nature_healingtouch' },
    },
    // Totem / aura exclusivity (from Optimizer.lua): which element a totem
    // occupies, which auras a paladin can run, and the default pick per role.
    totemElements: {
      WINDFURY:'air', GRACE_OF_AIR:'air', WRATH_OF_AIR:'air',
      TOTEM_OF_WRATH:'fire', MANA_SPRING:'water', MANA_TIDE:'water',
      STRENGTH_OF_EARTH:'earth',
    },
    paladinAuras: { DEVOTION_AURA:true, CONCENTRATION_AURA:true, RETRIBUTION_AURA:true, SANCTITY_AURA:true },
    bestAirTotem: { tank:'WINDFURY', melee_dps:'WINDFURY', ranged_dps:'GRACE_OF_AIR', caster_dps:'WRATH_OF_AIR', healer:'WRATH_OF_AIR' },
    bestPaladinAura: { tank:'DEVOTION_AURA', melee_dps:'RETRIBUTION_AURA', ranged_dps:'CONCENTRATION_AURA', caster_dps:'CONCENTRATION_AURA', healer:'CONCENTRATION_AURA' },
    // Small hooks the optimizer consults instead of hardcoded class/spec
    // checks, so a future ruleset can turn them off or swap the logic.
    rules: {
      tankAnchorRank: p => p.class === 'PALADIN' ? 0 : p.class === 'WARRIOR' ? 1 : 2,
      meleeWantsWindfury: true,     // a melee group with no shaman is missing WF
      ferociousInspiration: true,   // BM Hunter FI stacks multiplicatively per hunter
      rosterShapedIdentities: true, // melee/caster group count follows the DPS mix (Optimizer.roleIdentitiesFor)
      specAura: { Retribution: 'SANCTITY_AURA', Protection: 'DEVOTION_AURA' },
      // A Survival Hunter brings no party buff in TBC (FI is Beast Mastery's, TSA is
      // Marksmanship's), so sharing a group with another hunter duplicates a seat; the
      // reference comp spreads one hunter per melee group. Penalty per such Survival
      // Hunter. See Optimizer.groupScore.
      hunterSpread: 2,
      // DPS specs the reference comp parks in the healer/tank group as its one overflow
      // seat (exempt from the DPS-guest penalty there). See Optimizer.groupScore.
      healerGroupDps: p => p.class === 'WARLOCK' && p.spec === 'Affliction',
      // Party-buff providers whose second copy in one group mostly duplicates
      // the first (totems share elements, LotP/Moonkin/Sanctity don't stack)
      // while another group goes without. See Optimizer.groupScore.
      stackPenalty: [
        { match: p => p.class === 'SHAMAN', weight: 10 },
        { match: p => p.class === 'PALADIN' && p.spec === 'Retribution', weight: 8 },
        { match: p => p.class === 'DRUID' && p.spec === 'Feral', weight: 8 },
        { match: p => p.class === 'DRUID' && p.spec === 'Balance', weight: 4 },
      ],
    },
    // Class-presence utility checklist (readiness sidebar's "Utility" section,
    // Readiness.utilityCoverage() below) — separate from Buffs/Debuffs because
    // these are one-off/in-combat abilities, not always-on party auras.
    // `providers` is a list of {class, spec?, note?}; spec omitted means any
    // spec of that class qualifies. See tasks/feature-backlog.md #3.
    utilities: {
      BATTLE_REZ: { name:'Battle Resurrection', providers:[{class:'DRUID', note:'Rebirth'}, {class:'WARLOCK', note:'Soulstone — must be pre-cast before the pull'}], desc:'Revives a fallen raid member mid-encounter, or lets one pre-flagged player self-resurrect once via a pre-pull Soulstone.' },
      REMOVE_CURSE: { name:'Remove Curse', providers:[{class:'MAGE'}, {class:'DRUID'}], desc:'Removes a Curse debuff from a friendly target.' },
      CURE_POISON: { name:'Cure/Abolish Poison', providers:[{class:'DRUID'}, {class:'SHAMAN'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a Poison debuff from a friendly target.' },
      CURE_DISEASE: { name:'Cure Disease', providers:[{class:'PRIEST'}, {class:'SHAMAN'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a Disease debuff from a friendly target.' },
      DISPEL_MAGIC: { name:'Dispel Magic', providers:[{class:'PRIEST'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a harmful Magic effect from a friendly target.' },
      FEAR_BREAK: { name:'Fear Break (Tremor Totem)', providers:[{class:'SHAMAN'}], desc:'Tremor Totem breaks, and grants brief immunity to, Fear/Charm/Sleep effects on nearby party members.' },
      BLOODLUST: { name:'Bloodlust / Heroism', providers:[{class:'SHAMAN'}], desc:'Raid-wide haste cooldown. Bloodlust (Horde) and Heroism (Alliance) are the same effect under different names.' },
      INNERVATE: { name:'Innervate', providers:[{class:'DRUID'}], desc:'Restores a large amount of mana to the target over time — usually kept for another healer or self-cast.' },
      POWER_INFUSION: { name:'Power Infusion', providers:[{class:'PRIEST', spec:'Discipline'}], desc:'Discipline talent. Increases the target\'s spell damage and reduces mana cost for a short time.' },
      MISDIRECTION: { name:'Misdirection', providers:[{class:'HUNTER'}], desc:'Redirects the hunter\'s threat to another party/raid member for their next few attacks — commonly used to give the tank a head start on pull threat.' },
    },
  },
  classic: null,
  forever: null,
};

// ── CLASSIC ERA RULESET ─────────────────────────────────────────
// Buff/debuff numbers and existence are sourced from tasks/research-classic-buffs.md
// (compiled 2026-09-26). Where that research flags a value UNCONFIRMED, the
// description below stays qualitative rather than inventing a number.
// Ids are reused from Rulesets.tbc wherever Classic has the same spell (so the
// global BuffIcons/BuffAbbreviations/BuffCSSClass/DebuffIcons/DebuffAbbreviations
// maps in Config need no Classic-specific entries beyond the two brand-new
// totems below); each ruleset still owns its own desc/value since Classic
// ranks differ from TBC's (e.g. Leader of the Pack is 3% here, 5% in TBC).
Rulesets.classic = {
  buffs: {
    WINDFURY:          { name:'Windfury Totem',      sourceClass:'SHAMAN', preferSpec:'Enhancement', benefitsRoles:['tank','melee_dps'], priority:{melee_dps:100, tank:70}, desc:'Enchants nearby party members\' main-hand weapons with wind, granting each hit a 20% chance to trigger an extra attack with up to 315 bonus attack power.' },
    GRACE_OF_AIR:      { name:'Grace of Air Totem',  sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:60, desc:'Increases agility of nearby party members by up to 77.' },
    TRANQUIL_AIR:      { name:'Tranquil Air Totem',  sourceClass:'SHAMAN', benefitsRoles:['caster_dps','healer'], priority:40, desc:'Reduces the threat generated by nearby party members by 20%.' },
    STRENGTH_OF_EARTH: { name:'Strength of Earth Totem', sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps'], priority:55, desc:'Increases strength of nearby party members by up to 77.' },
    STONESKIN:         { name:'Stoneskin Totem',     sourceClass:'SHAMAN', benefitsRoles:['tank'], priority:45, desc:'Reduces melee damage taken by nearby party members by up to 30 per hit.' },
    MANA_SPRING:       { name:'Mana Spring Totem',   sourceClass:'SHAMAN', benefitsRoles:['healer','caster_dps'], priority:{healer:58, caster_dps:48}, desc:'Restores mana to nearby party members every 2 seconds (up to 10 per tick at max rank).' },
    MANA_TIDE:         { name:'Mana Tide Totem',     sourceClass:'SHAMAN', sourceSpec:'Restoration', benefitsRoles:['healer'], priority:70, desc:'Restores mana to nearby party members over 12 seconds (rank 1: 170 mana every 3 seconds; higher ranks UNCONFIRMED).' },
    DEVOTION_AURA:     { name:'Devotion Aura',       sourceClass:'PALADIN', benefitsRoles:['tank'], priority:75, desc:'Increases armor of nearby party members by up to 735.' },
    RETRIBUTION_AURA:  { name:'Retribution Aura',    sourceClass:'PALADIN', benefitsRoles:['tank','melee_dps'], priority:30, desc:'Causes Holy damage to any enemy that strikes nearby party members in melee.' },
    CONCENTRATION_AURA:{ name:'Concentration Aura',  sourceClass:'PALADIN', benefitsRoles:['healer','caster_dps'], priority:{healer:65, caster_dps:55}, desc:'Gives nearby party members a 35% chance to resist interruption from damage while casting.' },
    SANCTITY_AURA:     { name:'Sanctity Aura',       sourceClass:'PALADIN', sourceSpec:'Retribution', benefitsRoles:['melee_dps','ranged_dps','caster_dps','tank'], priority:{melee_dps:80, ranged_dps:80, caster_dps:80, tank:40}, desc:'Increases Holy damage done by nearby party members by 10%.' },
    BATTLE_SHOUT:      { name:'Battle Shout',        sourceClass:'WARRIOR', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:{melee_dps:65, tank:50}, desc:'Increases attack power of nearby party members for 2 minutes. Party-only in Classic Era; exact rank value UNCONFIRMED.' },
    TRUESHOT_AURA:     { name:'Trueshot Aura',       sourceClass:'HUNTER', sourceSpec:'Marksmanship', benefitsRoles:['melee_dps','ranged_dps'], priority:62, desc:'Increases attack power of nearby party members. Exact value UNCONFIRMED.' },
    LEADER_OF_THE_PACK:{ name:'Leader of the Pack',  sourceClass:'DRUID', sourceSpec:'Feral', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:{melee_dps:78, tank:65}, desc:'Increases melee and ranged critical strike chance of nearby party members by 3%.' },
    MOONKIN_AURA:      { name:'Moonkin Aura',        sourceClass:'DRUID', sourceSpec:'Balance', benefitsRoles:['caster_dps'], priority:72, desc:'Increases spell critical strike chance of nearby party members by 3%.' },
    BLOOD_PACT:        { name:'Blood Pact',          sourceClass:'WARLOCK', benefitsRoles:['tank'], priority:40, desc:'Increases max health of nearby party members (Wowhead Classic: +38 Stamina).' },
  },
  // Debuffs applied to the enemy target — same non-stacking-slot model as
  // Rulesets.tbc.debuffs (competesWith/supersededBy), Classic Era numbers.
  debuffs: {
    JUDGEMENT_CRUSADER: { name:'Judgement of the Crusader', sourceClass:'PALADIN', sourceSpec:'Retribution', desc:'Increases Holy damage taken by the target by 30. Improved Seal of the Crusader also grants attackers +3% critical strike chance against it.' },
    JUDGEMENT_LIGHT:     { name:'Judgement of Light',       sourceClass:'PALADIN', desc:'Melee attackers have a chance to heal themselves. Exact value UNCONFIRMED.' },
    JUDGEMENT_WISDOM:    { name:'Judgement of Wisdom',      sourceClass:'PALADIN', desc:'Attacks and spells against the target have a chance to restore mana. Exact value UNCONFIRMED.' },
    SUNDER_ARMOR:        { name:'Sunder Armor',             sourceClass:'WARRIOR', desc:'Reduces the target\'s armor by up to 900 (5 stacks of 180).', competesWith:['EXPOSE_ARMOR'] },
    DEMORALIZING_SHOUT:  { name:'Demoralizing Shout',       sourceClass:'WARRIOR', desc:'Reduces the target\'s melee attack power. Exact value UNCONFIRMED (community estimate ~140).', competesWith:['DEMORALIZING_ROAR','CURSE_WEAKNESS'] },
    THUNDER_CLAP:        { name:'Thunder Clap',             sourceClass:'WARRIOR', desc:'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).' },
    EXPOSE_ARMOR:        { name:'Expose Armor',             sourceClass:'ROGUE', desc:'Reduces the target\'s armor by 1700 at 5 combo points (2550 with Improved Expose Armor).', competesWith:['SUNDER_ARMOR'] },
    FAERIE_FIRE_BALANCE: { name:'Faerie Fire',               sourceClass:'DRUID', sourceSpec:'Balance', desc:'Reduces the target\'s armor by 505.' },
    FAERIE_FIRE_FERAL:   { name:'Faerie Fire (Feral)',       sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s armor by 505. Same debuff as Faerie Fire.', supersededBy:'FAERIE_FIRE_BALANCE' },
    DEMORALIZING_ROAR:   { name:'Demoralizing Roar',         sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s melee attack power. Exact value UNCONFIRMED (community estimate ~140).', competesWith:['DEMORALIZING_SHOUT','CURSE_WEAKNESS'] },
    INSECT_SWARM:        { name:'Insect Swarm',              sourceClass:'DRUID', sourceSpec:'Balance', desc:'Reduces the target\'s chance to hit by 2%.' },
    CURSE_RECKLESSNESS:  { name:'Curse of Recklessness',     sourceClass:'WARLOCK', desc:'Increases melee attack power by 90 but reduces armor by 640.', competesWith:['CURSE_ELEMENTS','CURSE_WEAKNESS'] },
    CURSE_ELEMENTS:      { name:'Curse of the Elements',     sourceClass:'WARLOCK', desc:'Reduces resistance to Fire and Frost by 75 and increases Fire/Frost damage taken by 10%. Fire and Frost only in Classic Era.', competesWith:['CURSE_RECKLESSNESS','CURSE_WEAKNESS'] },
    CURSE_WEAKNESS:      { name:'Curse of Weakness',         sourceClass:'WARLOCK', desc:'Reduces the target\'s melee damage dealt. Exact value UNCONFIRMED; shares a debuff slot with Demoralizing Shout/Roar.', competesWith:['CURSE_ELEMENTS','CURSE_RECKLESSNESS','DEMORALIZING_SHOUT','DEMORALIZING_ROAR'] },
    WINTERS_CHILL:       { name:'Winter\'s Chill',           sourceClass:'MAGE', sourceSpec:'Frost', desc:'Increases the target\'s chance to be critically hit by Frost spells by up to 10% (5 stacks).' },
    IMPROVED_SCORCH:     { name:'Improved Scorch',           sourceClass:'MAGE', sourceSpec:'Fire', desc:'Increases Fire damage taken by the target by up to 15% (5 stacks).' },
    SHADOW_WEAVING:      { name:'Shadow Weaving',            sourceClass:'PRIEST', sourceSpec:'Shadow', desc:'Increases Shadow damage taken by the target by up to 15% (5 stacks of 3%).' },
    STORMSTRIKE:         { name:'Stormstrike',                sourceClass:'SHAMAN', sourceSpec:'Enhancement', desc:'Increases Nature damage taken by the target by 20% for the next 2 hits. Enhancement Shaman is Horde-only in Classic Era.' },
  },
  specs: Rulesets.tbc.specs,
  raidHelperSpecMap: Rulesets.tbc.raidHelperSpecMap,
  classList: Rulesets.tbc.classList,
  specIcons: Rulesets.tbc.specIcons,
  // Totem/aura exclusivity — same shape as TBC's, minus the elements/auras
  // that don't exist in Classic Era (Wrath of Air, Totem of Wrath).
  totemElements: {
    WINDFURY:'air', GRACE_OF_AIR:'air', TRANQUIL_AIR:'air',
    STRENGTH_OF_EARTH:'earth', STONESKIN:'earth',
    MANA_SPRING:'water', MANA_TIDE:'water',
  },
  paladinAuras: { DEVOTION_AURA:true, CONCENTRATION_AURA:true, RETRIBUTION_AURA:true, SANCTITY_AURA:true },
  bestAirTotem: { tank:'WINDFURY', melee_dps:'WINDFURY', ranged_dps:'GRACE_OF_AIR', caster_dps:'TRANQUIL_AIR', healer:'TRANQUIL_AIR' },
  bestPaladinAura: { tank:'DEVOTION_AURA', melee_dps:'RETRIBUTION_AURA', ranged_dps:'CONCENTRATION_AURA', caster_dps:'CONCENTRATION_AURA', healer:'CONCENTRATION_AURA' },
  rules: {
    // Warrior is the premier tank on both factions; Prot Paladin is a rare
    // off-tank and only possible on Alliance (faction lock below).
    tankAnchorRank: p => p.class === 'WARRIOR' ? 0 : p.class === 'PALADIN' ? 1 : 2,
    meleeWantsWindfury: true,      // gated off for Alliance rosters — see Faction.current() call sites
    ferociousInspiration: false,   // Ferocious Inspiration does not exist in Classic Era
    specAura: { Retribution: 'SANCTITY_AURA', Protection: 'DEVOTION_AURA', Holy: 'CONCENTRATION_AURA' },
    // Classic Era faction lock: Shaman = Horde only, Paladin = Alliance only.
    // Gates the Windfury structural penalty, the missing-buff insight list,
    // random-roster generation and the ideal-comp Horde/Alliance pick.
    factionLock: true,
    // Classes whose buff is a single-point-of-failure per group (Shaman
    // Windfury/totems, Paladin auras, Feral Leader of the Pack) — spread one
    // per group instead of letting two stack in one group while another has
    // none. See Optimizer.spreadProviders(). Only one of SHAMAN/PALADIN is
    // ever actually present under the faction lock above, so listing both is
    // harmless — whichever class has no members in the roster is a no-op.
    spreadProviders: [{ class: 'SHAMAN' }, { class: 'PALADIN' }, { class: 'DRUID', spec: 'Feral' }],
    // Structural nudge (see Optimizer.groupScore's buffValue) so a melee
    // group's shaman actually drops Windfury instead of losing the per-element
    // totem choice to Grace of Air when the group also holds several hunters.
    // TBC has no such value (undefined = no-op) because its DPS_VALUE/
    // DPS_WEIGHT tables were tuned, and its scenario suite pinned, without it.
    meleeGroupWindfuryBias: 8,
  },
  // Same shape as Rulesets.tbc.utilities, with the Classic-Era differences:
  // Tranquilizing Shot exists here (Magmadar/Flamegor/Huhuran/Chromaggus
  // enrage removal) and neither Bloodlust/Heroism nor Misdirection exist yet
  // (both are TBC-only). Faction-locked providers (SHAMAN/PALADIN) are
  // filtered per-roster by Readiness._factionFilteredProviders(), not here.
  utilities: {
    BATTLE_REZ: { name:'Battle Resurrection', providers:[{class:'DRUID', note:'Rebirth'}, {class:'WARLOCK', note:'Soulstone — must be pre-cast before the pull'}], desc:'Revives a fallen raid member mid-encounter, or lets one pre-flagged player self-resurrect once via a pre-pull Soulstone.' },
    REMOVE_CURSE: { name:'Remove Curse', providers:[{class:'MAGE'}, {class:'DRUID'}], desc:'Removes a Curse debuff from a friendly target.' },
    CURE_POISON: { name:'Cure/Abolish Poison', providers:[{class:'DRUID'}, {class:'SHAMAN'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a Poison debuff from a friendly target.' },
    CURE_DISEASE: { name:'Cure Disease', providers:[{class:'PRIEST'}, {class:'SHAMAN'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a Disease debuff from a friendly target.' },
    DISPEL_MAGIC: { name:'Dispel Magic', providers:[{class:'PRIEST'}, {class:'PALADIN', note:'Cleanse'}], desc:'Removes a harmful Magic effect from a friendly target.' },
    FEAR_BREAK: { name:'Fear Break (Tremor Totem)', providers:[{class:'SHAMAN'}], desc:'Tremor Totem breaks, and grants brief immunity to, Fear/Charm/Sleep effects on nearby party members.' },
    TRANQ_SHOT: { name:'Tranquilizing Shot', providers:[{class:'HUNTER'}], desc:'Removes one Enrage effect and one Magic effect from the target. Required for Magmadar, Flamegor, Princess Huhuran and Chromaggus.' },
    INNERVATE: { name:'Innervate', providers:[{class:'DRUID'}], desc:'Restores a large amount of mana to the target over time — usually kept for another healer or self-cast.' },
    POWER_INFUSION: { name:'Power Infusion', providers:[{class:'PRIEST', spec:'Discipline'}], desc:'Discipline talent. Increases the target\'s spell damage and reduces mana cost for a short time.' },
  },
};

// ── WOW FOREVER RULESET ─────────────────────────────────────────
// Vanilla/Classic Era baseline (no new classes or specs — the six new
// race/class combos and the Skyborne race only widen WHO can play a class,
// never WHAT a class does), with the confirmed Forever deltas layered on.
// Source: tasks/research-forever.md, the "## Browser verification
// (2026-09-26)" section, which is sourced from live Wowhead spell pages and
// the raids/camping/talent-calc guide pages and supersedes every earlier
// UNCONFIRMED claim in that file. Deltas modeled here:
//   - No faction lock: six new race/class combos (Undead Paladin, Dwarf
//     Shaman, etc.) put Paladin and Shaman on both factions — see the
//     `rules.factionLock: false` below and the Faction module call sites.
//   - Tranquil Air Totem, Wrath of Air Totem and Totem of Wrath do not exist
//     (confirmed absent via /forever/search) — omitted from `buffs` and
//     `totemElements` entirely.
//   - Every Paladin Aura (Devotion/Retribution/Concentration/Sanctity) gained
//     a uniform +1% party healing-taken secondary effect; Improved Devotion
//     Aura was removed as a talent.
//   - Trueshot Aura moved from a 31-point Marksmanship talent to a baseline
//     ability every Hunter trains at level 32 — no `sourceSpec` restriction.
//   - Leader of the Pack and Moonkin Aura were both reworked into the same
//     generalized +3% crit (all schools) party aura and made mutually
//     exclusive with each other — modeled via `rules.exclusiveBuffs` below
//     (see resolveGroupBuffs/getGroupBuffs, which dedupe an exclusive set
//     down to whichever member is worth more to the group, so a group with
//     both a Feral and a Balance druid is only ever credited with one).
// Debuffs below are limited to what the verification pass confirmed exists
// as a target debuff. Excluded as unverified or not-a-raid-debuff per that
// same section: Shadow Weaving and Stormstrike (confirmed PERSONAL-only
// effects in Forever, not raid debuffs), Winter's Chill (tooltip read as
// personal-only this pass; ambiguous, left out pending re-verification),
// Improved Scorch (not re-checked before a Wowhead CloudFront rate-limit
// ended the session), and exact numbers for Curse of the Elements/
// Recklessness and the three Judgements (existence confirmed, tooltip
// values blocked by the same rate-limit — worded qualitatively instead of
// invented). Curse of Weakness, Mangle, Insect Swarm, Blood Frenzy,
// Hemorrhage and other TBC/talent-only debuffs were not part of the
// verification pass at all and are left out.
Rulesets.forever = {
  buffs: {
    WINDFURY:          { name:'Windfury Totem',      sourceClass:'SHAMAN', preferSpec:'Enhancement', benefitsRoles:['tank','melee_dps'], priority:{melee_dps:100, tank:70}, desc:'Enchants nearby party members\' main-hand weapons with wind, granting each hit a 20% chance to trigger an extra attack with 246 bonus attack power. Party, 30 yards.' },
    GRACE_OF_AIR:      { name:'Grace of Air Totem',  sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:60, desc:'Increases agility of nearby party members by 89. Party, 30 yards.' },
    STRENGTH_OF_EARTH: { name:'Strength of Earth Totem', sourceClass:'SHAMAN', benefitsRoles:['tank','melee_dps'], priority:55, desc:'Increases strength of nearby party members by 53. Party, 30 yards.' },
    STONESKIN:         { name:'Stoneskin Totem',     sourceClass:'SHAMAN', benefitsRoles:['tank'], priority:45, desc:'Reduces melee damage taken by nearby party members by 30 per hit. Party, 30 yards.' },
    MANA_SPRING:       { name:'Mana Spring Totem',   sourceClass:'SHAMAN', benefitsRoles:['healer','caster_dps'], priority:{healer:58, caster_dps:48}, desc:'Restores 10 mana every 2 seconds to nearby party members. Group, 30 yards.' },
    MANA_TIDE:         { name:'Mana Tide Totem',     sourceClass:'SHAMAN', sourceSpec:'Restoration', benefitsRoles:['healer'], priority:70, desc:'Restores 88 mana every 3 seconds to nearby party members for 12 seconds. Still a 1-point Restoration talent, not baseline. Group, 30 yards.' },
    DEVOTION_AURA:     { name:'Devotion Aura',       sourceClass:'PALADIN', benefitsRoles:['tank'], priority:75, desc:'Increases armor of nearby party members by 735. Also increases healing taken by nearby party members by 1%. Party, 30 yards.' },
    RETRIBUTION_AURA:  { name:'Retribution Aura',    sourceClass:'PALADIN', benefitsRoles:['tank','melee_dps'], priority:30, desc:'Causes Holy damage to any enemy that strikes nearby party members in melee. Also increases healing taken by nearby party members by 1%. Party, 30 yards.' },
    CONCENTRATION_AURA:{ name:'Concentration Aura',  sourceClass:'PALADIN', benefitsRoles:['healer','caster_dps'], priority:{healer:65, caster_dps:55}, desc:'Gives nearby party members a 35% chance to resist interruption from damage while casting. Also increases healing taken by nearby party members by 1%. Party, 30 yards.' },
    SANCTITY_AURA:     { name:'Sanctity Aura',       sourceClass:'PALADIN', sourceSpec:'Retribution', benefitsRoles:['melee_dps','ranged_dps','caster_dps','tank'], priority:{melee_dps:80, ranged_dps:80, caster_dps:80, tank:40}, desc:'Increases Holy damage done by nearby party members by 10%. Also increases healing taken by nearby party members by 1%. Improved Devotion Aura no longer exists as a talent. Party, 30 yards.' },
    BATTLE_SHOUT:      { name:'Battle Shout',        sourceClass:'WARRIOR', benefitsRoles:['tank','melee_dps','ranged_dps'], priority:{melee_dps:65, tank:50}, desc:'Increases attack power of nearby party members by 140 for 3 minutes. Party, 20 yards (not raid-wide).' },
    TRUESHOT_AURA:     { name:'Trueshot Aura',       sourceClass:'HUNTER', benefitsRoles:['melee_dps','ranged_dps'], priority:62, desc:'Baseline for every Hunter spec — trained at level 32, no longer Marksmanship-only. Increases ranged attack power of nearby party members by 40. Party, 45 yards, 30 minutes.' },
    LEADER_OF_THE_PACK:{ name:'Leader of the Pack',  sourceClass:'DRUID', sourceSpec:'Feral', benefitsRoles:['tank','melee_dps','ranged_dps','caster_dps'], priority:{melee_dps:78, ranged_dps:78, caster_dps:70, tank:65}, desc:'While in Cat, Bear or Dire Bear Form, increases critical strike chance (melee, ranged and spell) of nearby party members by 3%. Mutually exclusive with Moonkin Aura — a group with both only benefits from one. Party, 45 yards.' },
    MOONKIN_AURA:      { name:'Moonkin Aura',        sourceClass:'DRUID', sourceSpec:'Balance', benefitsRoles:['tank','melee_dps','ranged_dps','caster_dps'], priority:{caster_dps:72, melee_dps:60, ranged_dps:60, tank:50}, desc:'While in Moonkin Form, increases critical strike chance (melee, ranged and spell) of nearby party members by 3%. Mutually exclusive with Leader of the Pack — a group with both only benefits from one. Party, 45 yards.' },
    BLOOD_PACT:        { name:'Blood Pact',          sourceClass:'WARLOCK', benefitsRoles:['tank'], priority:40, desc:'Increases Stamina of nearby party members by 54 (via the Imp). Party, 30 yards.' },
  },
  debuffs: {
    SUNDER_ARMOR:        { name:'Sunder Armor',              sourceClass:'WARRIOR', desc:'Reduces the target\'s armor by 450 per stack, up to 5 stacks (2250 total).', competesWith:['EXPOSE_ARMOR'] },
    EXPOSE_ARMOR:        { name:'Expose Armor',              sourceClass:'ROGUE', desc:'Reduces the target\'s armor at 5 combo points. Confirmed to exist in Forever; exact value UNCONFIRMED.', competesWith:['SUNDER_ARMOR'] },
    FAERIE_FIRE_BALANCE: { name:'Faerie Fire',                sourceClass:'DRUID', sourceSpec:'Balance', desc:'Reduces the target\'s armor by 505.' },
    FAERIE_FIRE_FERAL:   { name:'Faerie Fire (Feral)',        sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s armor by 505. Same debuff as Faerie Fire.', supersededBy:'FAERIE_FIRE_BALANCE' },
    DEMORALIZING_SHOUT:  { name:'Demoralizing Shout',        sourceClass:'WARRIOR', desc:'Reduces the target\'s melee attack power. Exact value UNCONFIRMED.', competesWith:['DEMORALIZING_ROAR'] },
    DEMORALIZING_ROAR:   { name:'Demoralizing Roar',          sourceClass:'DRUID', sourceSpec:'Feral', desc:'Reduces the target\'s melee attack power. Exact value UNCONFIRMED.', competesWith:['DEMORALIZING_SHOUT'] },
    THUNDER_CLAP:        { name:'Thunder Clap',              sourceClass:'WARRIOR', desc:'Reduces the target\'s attack speed by 10% (20% with Improved Thunder Clap).' },
    CURSE_ELEMENTS:      { name:'Curse of the Elements',      sourceClass:'WARLOCK', desc:'Increases damage taken from the Warlock\'s curse school and reduces resistance to it. Confirmed to exist in Forever (multiple spell ids found, suggesting a reworked/talent-scaling version); exact value UNCONFIRMED.', competesWith:['CURSE_RECKLESSNESS'] },
    CURSE_RECKLESSNESS:  { name:'Curse of Recklessness',      sourceClass:'WARLOCK', desc:'Increases the target\'s melee attack power but reduces its armor. Confirmed to exist in Forever; exact value UNCONFIRMED.', competesWith:['CURSE_ELEMENTS'] },
    JUDGEMENT_CRUSADER:  { name:'Judgement of the Crusader',  sourceClass:'PALADIN', desc:'Increases Holy damage taken by the target. Judgement is a single unified spell in Forever and no longer consumes the active Seal. Confirmed to exist; exact value UNCONFIRMED.' },
    JUDGEMENT_LIGHT:     { name:'Judgement of Light',        sourceClass:'PALADIN', desc:'Melee attackers have a chance to heal themselves. Confirmed to exist; exact value UNCONFIRMED.' },
    JUDGEMENT_WISDOM:    { name:'Judgement of Wisdom',       sourceClass:'PALADIN', desc:'Attacks and spells against the target have a chance to restore mana. Confirmed to exist; exact value UNCONFIRMED.' },
  },
  specs: Rulesets.tbc.specs,
  raidHelperSpecMap: Rulesets.tbc.raidHelperSpecMap,
  classList: Rulesets.tbc.classList,
  specIcons: Rulesets.tbc.specIcons,
  // No Tranquil Air (absent), no Wrath of Air/Totem of Wrath (absent) — only
  // the four totem elements that still exist in Forever.
  totemElements: {
    WINDFURY:'air', GRACE_OF_AIR:'air',
    STRENGTH_OF_EARTH:'earth', STONESKIN:'earth',
    MANA_SPRING:'water', MANA_TIDE:'water',
  },
  paladinAuras: { DEVOTION_AURA:true, CONCENTRATION_AURA:true, RETRIBUTION_AURA:true, SANCTITY_AURA:true },
  // No Tranquil Air exists for casters/healers to fall back to — Grace of Air
  // (agility) is the only other air totem, so it's the least-bad default.
  bestAirTotem: { tank:'WINDFURY', melee_dps:'WINDFURY', ranged_dps:'GRACE_OF_AIR', caster_dps:'GRACE_OF_AIR', healer:'GRACE_OF_AIR' },
  bestPaladinAura: { tank:'DEVOTION_AURA', melee_dps:'RETRIBUTION_AURA', ranged_dps:'CONCENTRATION_AURA', caster_dps:'CONCENTRATION_AURA', healer:'CONCENTRATION_AURA' },
  rules: {
    // Both Warrior and Paladin tank on either faction now; Warrior stays the
    // conventional premier tank (vanilla baseline unchanged), Paladin a
    // strong and now cross-faction off-tank.
    tankAnchorRank: p => p.class === 'WARRIOR' ? 0 : p.class === 'PALADIN' ? 1 : 2,
    meleeWantsWindfury: true,     // Shaman exists on both factions — no faction gate needed
    ferociousInspiration: false,  // TBC-only Beast Mastery talent; does not exist in Forever
    specAura: { Retribution: 'SANCTITY_AURA', Protection: 'DEVOTION_AURA', Holy: 'CONCENTRATION_AURA' },
    // No faction lock: the six new race/class combos put Paladin and Shaman
    // on both factions, so a raid can field both totems and auras, and a
    // mixed shaman+paladin roster is normal rather than a data problem.
    factionLock: false,
    // Same single-point-of-failure spreading as Classic (Optimizer.spreadProviders/
    // _spreadPass), plus the Feral/Balance druid crit auras — now mutually
    // exclusive with each other (see exclusiveBuffs below), so a group needs
    // exactly one crit-aura druid, not one of each. The array form of `spec`
    // groups Feral and Balance together for _spreadPass's matcher (one druid
    // of either spec already satisfies a group; a second of either is surplus).
    spreadProviders: [{ class: 'SHAMAN' }, { class: 'PALADIN' }, { class: 'DRUID', spec: ['Feral', 'Balance'] }],
    // Same Windfury-over-Grace-of-Air structural nudge as Classic — see
    // Rulesets.classic.rules.meleeGroupWindfuryBias for the full rationale.
    meleeGroupWindfuryBias: 8,
    // Buff ids that occupy one shared slot per group — resolveGroupBuffs and
    // getGroupBuffs keep only the higher-value member of each listed set.
    exclusiveBuffs: [['LEADER_OF_THE_PACK', 'MOONKIN_AURA']],
  },
};

const EMPTY_RULESET = {
  buffs: {}, debuffs: {}, totemElements: {}, paladinAuras: {}, bestAirTotem: {}, bestPaladinAura: {},
  dpsValue: {}, mitValue: {}, sustainValue: {}, dpsWeight: {}, dpsWeightByRole: {}, rules: {}, idealComp: null,
};
// The inputs Optimizer.plan() was given, while it runs. The layout algorithm leans
// on lookups that read State ambiently (the active ruleset, the roster's faction,
// the keep-together/apart pairs, the tagged drummers); inside a plan they read this
// instead, so a plan never touches State. Null outside a plan.
const LayoutScope = {
  current: null,
  run(inputs, fn) {
    const previous = this.current;
    this.current = inputs;
    try { return fn(); } finally { this.current = previous; }
  },
};

function activeVersion() {
  return LayoutScope.current ? LayoutScope.current.gameVersion : State.gameVersion;
}
function activeRules() {
  return Rulesets[activeVersion()] || EMPTY_RULESET;
}
// A version is modeled iff it has a ruleset.
for (const version of Object.keys(GameVersions)) {
  Object.defineProperty(GameVersions[version], 'modeled', { get: () => !!Rulesets[version] });
}

Object.defineProperties(Config, {
  Buffs: {get() { return activeRules().buffs || {}; }},
  Debuffs: {get() { return activeRules().debuffs || {}; }},
  RaidOrder: {get() { return GameVersions[State.gameVersion].raids; }},
  // Classic/Forever have no spec/class differences modeled yet — fall back
  // to the TBC baseline (existing behavior for every unmodeled version).
  Specs: {get() { return activeRules().specs || Rulesets.tbc.specs; }},
  RaidHelperSpecMap: {get() { return activeRules().raidHelperSpecMap || Rulesets.tbc.raidHelperSpecMap; }},
  // Utility checklist (Battle Rez, cleanses, Bloodlust, ...) — see
  // Rulesets.tbc.utilities / Rulesets.classic.utilities. Any ruleset without
  // its own table yet (e.g. Forever) borrows Classic's rather than showing an
  // empty "Utility" section.
  Utilities: {get() { return activeRules().utilities || Rulesets.classic.utilities; }},
});
function versionForRaid(raid) {
  return Object.keys(GameVersions).find(v => GameVersions[v].raids.includes(raid));
}
function validVersionRaid(version, raid) {
  return !!GameVersions[version] && GameVersions[version].raids.includes(raid);
}

// TBC baseline aliases — plain bindings for code (and tests) that always want
// the TBC tables directly. Version-aware call sites use activeRules() instead.
const TOTEM_ELEMENTS = Rulesets.tbc.totemElements;
const PALADIN_AURAS = Rulesets.tbc.paladinAuras;
const BEST_AIR_TOTEM = Rulesets.tbc.bestAirTotem;
const BEST_PALADIN_AURA = Rulesets.tbc.bestPaladinAura;

// Auras a given paladin can actually run (Sanctity Aura is Retribution-only).
function paladinAurasFor(player) {
  return Object.keys(activeRules().paladinAuras || {}).filter(id => {
    const b = Config.Buffs[id];
    return !b || !b.sourceSpec || b.sourceSpec === player.spec;
  });
}

function getBuffPriority(buff, role) {
  if (!buff) return 0;
  if (typeof buff.priority === 'number') return buff.priority;
  if (typeof buff.priority === 'object') {
    if (role && buff.priority[role] != null) return buff.priority[role];
    return Math.max(...Object.values(buff.priority));
  }
  return 0;
}

