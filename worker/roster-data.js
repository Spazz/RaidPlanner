// Pure data and rules for the roster (no I/O). Spec names and the Raid-Helper maps mirror js/rules/catalog.js;
// guild-config-tests.js pins the parity. Druid's Feral is split in two (DPS and Tank) because a roster
// records what a character plays, not a talent tree.

export const CLASSES = [
  { id: 'WARRIOR', name: 'Warrior' },
  { id: 'PALADIN', name: 'Paladin' },
  { id: 'HUNTER', name: 'Hunter' },
  { id: 'ROGUE', name: 'Rogue' },
  { id: 'PRIEST', name: 'Priest' },
  { id: 'SHAMAN', name: 'Shaman' },
  { id: 'MAGE', name: 'Mage' },
  { id: 'WARLOCK', name: 'Warlock' },
  { id: 'DRUID', name: 'Druid' },
];
export const CLASS_IDS = CLASSES.map((entry) => entry.id);

// Spec label -> role ('tank' | 'healer' | 'dps'), per class, in display order.
export const SPEC_ROLE = {
  WARRIOR: { Arms: 'dps', Fury: 'dps', Protection: 'tank' },
  PALADIN: { Holy: 'healer', Protection: 'tank', Retribution: 'dps' },
  HUNTER: { 'Beast Mastery': 'dps', Marksmanship: 'dps', Survival: 'dps' },
  ROGUE: { Assassination: 'dps', Combat: 'dps', Subtlety: 'dps' },
  PRIEST: { Discipline: 'healer', Holy: 'healer', Shadow: 'dps' },
  SHAMAN: { Elemental: 'dps', Enhancement: 'dps', Restoration: 'healer' },
  MAGE: { Arcane: 'dps', Fire: 'dps', Frost: 'dps' },
  WARLOCK: { Affliction: 'dps', Demonology: 'dps', Destruction: 'dps' },
  DRUID: { Balance: 'dps', 'Feral (DPS)': 'dps', 'Feral (Tank)': 'tank', Restoration: 'healer' },
};
export const SPECS = Object.fromEntries(Object.entries(SPEC_ROLE).map(([id, specs]) => [id, Object.keys(specs)]));

export const STATUSES = ['raider', 'trial', 'reserve', 'inactive'];
// Why a person went Inactive (optional; only kept while the status is Inactive).
export const LEFT_REASONS = ['left', 'kicked', 'break', 'other'];
// A person can be created (or imported) in these; Inactive is only ever set on an existing person.
export const CREATE_STATUSES = ['raider', 'trial', 'reserve'];

// Own-property lookup for maps indexed by external text ('constructor' and '__proto__' are not keys) -> value or undefined.
export function ownValue(map, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function roleOf(classId, spec) {
  const specs = ownValue(SPEC_ROLE, classId);
  return (specs && ownValue(specs, spec)) || null;
}

export function isSpecOf(classId, spec) {
  const specs = ownValue(SPEC_ROLE, classId);
  return !!specs && ownValue(specs, spec) !== undefined;
}

// Raid-Helper spec name -> { class, spec } (the keys of catalog.raidHelperSpecMap).
export const RAID_HELPER_SPEC = {
  Arms: { class: 'WARRIOR', spec: 'Arms' },
  Fury: { class: 'WARRIOR', spec: 'Fury' },
  Protection: { class: 'WARRIOR', spec: 'Protection' },
  Holy1: { class: 'PALADIN', spec: 'Holy' },
  Protection1: { class: 'PALADIN', spec: 'Protection' },
  Retribution: { class: 'PALADIN', spec: 'Retribution' },
  Beastmastery: { class: 'HUNTER', spec: 'Beast Mastery' },
  Marksmanship: { class: 'HUNTER', spec: 'Marksmanship' },
  Survival: { class: 'HUNTER', spec: 'Survival' },
  Assassination: { class: 'ROGUE', spec: 'Assassination' },
  Combat: { class: 'ROGUE', spec: 'Combat' },
  Subtlety: { class: 'ROGUE', spec: 'Subtlety' },
  Discipline: { class: 'PRIEST', spec: 'Discipline' },
  Holy: { class: 'PRIEST', spec: 'Holy' },
  Shadow: { class: 'PRIEST', spec: 'Shadow' },
  Smite: { class: 'PRIEST', spec: 'Discipline' },
  Elemental: { class: 'SHAMAN', spec: 'Elemental' },
  Enhancement: { class: 'SHAMAN', spec: 'Enhancement' },
  Restoration1: { class: 'SHAMAN', spec: 'Restoration' },
  Restoration: { class: 'DRUID', spec: 'Restoration' },
  Arcane: { class: 'MAGE', spec: 'Arcane' },
  Fire: { class: 'MAGE', spec: 'Fire' },
  Frost: { class: 'MAGE', spec: 'Frost' },
  Affliction: { class: 'WARLOCK', spec: 'Affliction' },
  Demonology: { class: 'WARLOCK', spec: 'Demonology' },
  Destruction: { class: 'WARLOCK', spec: 'Destruction' },
  Balance: { class: 'DRUID', spec: 'Balance' },
  Feral: { class: 'DRUID', spec: 'Feral (DPS)' },
  Guardian: { class: 'DRUID', spec: 'Feral (Tank)' },
  Dreamstate: { class: 'DRUID', spec: 'Balance' },
};

// Raid-Helper class name -> class id. Tank, Bench, Tentative, Absence and Late are meta-values with no class.
export const RAID_HELPER_CLASS = {
  Warrior: 'WARRIOR', Paladin: 'PALADIN', Hunter: 'HUNTER', Rogue: 'ROGUE', Priest: 'PRIEST',
  Shaman: 'SHAMAN', Mage: 'MAGE', Warlock: 'WARLOCK', Druid: 'DRUID',
};
export const RAID_HELPER_META = ['Tank', 'Bench', 'Tentative', 'Absence', 'Late'];

// Warcraft Logs actor subType -> class id; anything else (Pet, NPC, ...) is dropped.
export const WCL_CLASS = { ...RAID_HELPER_CLASS };

export const WCL_FLAVOURS = ['www', 'classic', 'fresh'];
export const DEFAULT_WCL_FLAVOUR = { tbc: 'fresh', classic: 'classic' };

// ---------------------------------------------------------------------------
// Names

// Letters, each followed by at most two combining marks; the first code point is a letter.
const NAME_PATTERN = /^(?:\p{L}\p{M}{0,2})+$/u;

// The WoW display form of a character name (first letter upper case, the rest lower case), or null. The 2 to 12
// code point limit is measured on the mapped form ('ß' upper-cases to 'SS').
export function cleanCharacterName(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const text = raw.normalize('NFC').trim();
  if (!NAME_PATTERN.test(text)) return null;
  const letters = Array.from(text);
  const mapped = (letters[0].toUpperCase() + letters.slice(1).join('').toLowerCase()).normalize('NFC');
  const length = Array.from(mapped).length;
  if (length < 2 || length > 12 || !NAME_PATTERN.test(mapped)) return null;
  return mapped;
}

export function nameKey(name) {
  return String(name).normalize('NFC').toLowerCase();
}

// "Maladath (AU)" and "Maladath" compare equal; '' for a ruleset guild (pass null / '').
export function realmKey(realm) {
  if (typeof realm !== 'string') return '';
  return realm.normalize('NFC').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s'’-]+/g, '');
}

const TOKEN_SPLIT = /[\/\\()[\]{}|,;:&+\s-]+/;
const STOP_WORDS = new Set([
  'warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage', 'warlock', 'druid',
  'arms', 'fury', 'protection', 'holy', 'retribution', 'beast', 'mastery', 'beastmastery', 'marksmanship', 'survival',
  'assassination', 'combat', 'subtlety', 'discipline', 'shadow', 'elemental', 'enhancement', 'restoration',
  'arcane', 'fire', 'frost', 'affliction', 'demonology', 'destruction', 'balance', 'feral', 'guardian',
  'prot', 'resto', 'ret', 'enh', 'ele', 'disc', 'destro', 'affli', 'demo', 'bm', 'mm', 'surv', 'sub', 'boomkin', 'bear', 'cat',
  'tank', 'heal', 'heals', 'healer', 'dps', 'melee', 'ranged', 'caster',
  'main', 'alt', 'alts', 'officer', 'gm', 'raider', 'trial',
]);

// Candidate character names inside a Discord nickname, in order. The first is the suggested Main; the rest are
// Alt suggestions (they may be real names: "Character(RealName)"), so a caller starts them unticked.
export function nicknameTokens(nickname) {
  if (typeof nickname !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const token of nickname.normalize('NFC').split(TOKEN_SPLIT)) {
    if (!token || STOP_WORDS.has(token.toLowerCase())) continue;
    const name = cleanCharacterName(token);
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    found.push(name);
  }
  return found;
}

// Invisible and direction-changing characters: zero-width and direction marks, line/paragraph separators, bidi
// embeddings and isolates, the Arabic letter mark, the word joiner and the byte order mark.
const INVISIBLE_CHARS = '\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\u061c\ufeff';
// Single-line text: control characters (all of C0 and C1) plus the invisible ones.
export const SINGLE_LINE_STRIP = new RegExp(`[\u0000-\u001f\u007f-\u009f${INVISIBLE_CHARS}]`, 'g');
// Multi-line text keeps the tab and the newline.
export const MULTI_LINE_STRIP = new RegExp(`[\u0000-\u0008\u000b-\u001f\u007f${INVISIBLE_CHARS}]`, 'g');

// Control characters, bidi overrides and invisible characters removed, trimmed, cut to 64 code points. null when nothing is left.
export function cleanNickname(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(SINGLE_LINE_STRIP, '').trim();
  const cut = Array.from(text).slice(0, 64).join('').trim();
  return cut || null;
}

// ---------------------------------------------------------------------------
// Dates

// YYYY-MM-DD of the instant in the time zone.
export function todayIn(timeZone, nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs));
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export const TRIAL_FLAG_DAYS = 7;

// null, or { kind: 'ends', days } (0..7 days left) / { kind: 'ended', days } (days is negative).
export function trialFlag(status, trialEnd, today) {
  if (status !== 'trial' || !isRealDate(trialEnd) || !isRealDate(today)) return null;
  const days = Math.round((Date.parse(`${trialEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days < 0) return { kind: 'ended', days };
  if (days <= TRIAL_FLAG_DAYS) return { kind: 'ends', days };
  return null;
}

// The roster options the guild payload carries.
export function rosterOptions() {
  return {
    classes: CLASSES.map((entry) => ({ ...entry })),
    specs: Object.fromEntries(Object.entries(SPECS).map(([id, specs]) => [id, [...specs]])),
    roles: Object.fromEntries(Object.entries(SPEC_ROLE).map(([id, specs]) => [id, { ...specs }])),
  };
}
