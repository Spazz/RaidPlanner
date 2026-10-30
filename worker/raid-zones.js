// The raid zones a raid can be created with by hand, per game version, and how many players each takes: the raid names and sizes of
// js/rules/{tbc,classic,forever}.js (planning templates left out), which are also the zone names Warcraft Logs reports use. tests pin the parity.
export const RAID_ZONE_SIZES = {
  tbc: {
    'Karazhan': 10, 'Gruul\'s Lair': 25, 'Magtheridon\'s Lair': 25, 'Serpentshrine Cavern': 25, 'Tempest Keep': 25, 'Zul\'Aman': 10,
    'Hyjal Summit': 25, 'Black Temple': 25, 'Sunwell Plateau': 25,
  },
  classic: {
    'Molten Core': 40, 'Onyxia\'s Lair': 40, 'Blackwing Lair': 40, 'Zul\'Gurub': 20, 'Ruins of Ahn\'Qiraj': 20, 'Temple of Ahn\'Qiraj': 40, 'Naxxramas': 40,
  },
  forever: { 'Barrow Deeps': 10, 'Hyjal Summit': 20, 'Onyxia\'s Lair': 40 },
};

export const RAID_ZONES = Object.fromEntries(Object.entries(RAID_ZONE_SIZES).map(([version, zones]) => [version, Object.keys(zones)]));

// The sizes a raid or a team can have (the Planner's raid templates are 10 / 20 / 25 / 40 players).
export const RAID_SIZES = [10, 20, 25, 40];

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function zonesFor(gameVersion) {
  return has(RAID_ZONES, gameVersion) ? RAID_ZONES[gameVersion] : [];
}

export const isRaidSize = (value) => Number.isInteger(value) && RAID_SIZES.includes(value);

// The raid size a new team starts with, per game version: the size most guilds of that version raid at (TBC 25, Classic 40, WoW Forever 20).
// Editable per team afterwards; a version nobody listed starts at 25.
export const DEFAULT_TEAM_SIZES = { tbc: 25, classic: 40, forever: 20 };
export const defaultTeamSize = (gameVersion) => (has(DEFAULT_TEAM_SIZES, gameVersion) ? DEFAULT_TEAM_SIZES[gameVersion] : 25);

// ---------------------------------------------------------------------------
// Zone names in free text (Raid-Helper titles, Warcraft Logs zone names, stored values). js/guild/zones.js carries the SAME alias table for the pages;
// tests pin the parity. Canonical name -> the short names it is known by (the canonical name itself always matches too). Only zone names, NEVER boss
// names: "Team KJ" is a team, not Sunwell. Matching ignores case and apostrophes ("gruuls", "gruul's", "zul'aman", "zulaman") and whole words only.
export const ZONE_ALIASES = {
  tbc: {
    'Karazhan': ['kara'],
    "Gruul's Lair": ['gruul', 'gruuls'],
    "Magtheridon's Lair": ['mag', 'mags', 'magtheridon'],
    'Serpentshrine Cavern': ['ssc', 'serpentshrine'],
    'Tempest Keep': ['tk', 'the eye'],
    "Zul'Aman": ['za', 'zulaman'],
    'Hyjal Summit': ['hyjal', 'mh', 'mount hyjal'],
    'Black Temple': ['bt'],
    'Sunwell Plateau': ['swp', 'sunwell'],
  },
  classic: {
    'Molten Core': ['mc'],
    "Onyxia's Lair": ['ony', 'onyxia'],
    'Blackwing Lair': ['bwl'],
    "Zul'Gurub": ['zg', 'zulgurub'],
    "Ruins of Ahn'Qiraj": ['aq20', 'ruins'],
    "Temple of Ahn'Qiraj": ['aq40'],
    'Naxxramas': ['naxx'],
  },
  forever: {
    'Barrow Deeps': ['barrow'],
    'Hyjal Summit': ['hyjal', 'mh', 'mount hyjal'],
    "Onyxia's Lair": ['ony', 'onyxia'],
  },
};

// The most zones one raid carries (the stored value is "A + B + C"; the three longest names of any version fit its 60-character column).
export const MAX_ZONES = 3;

const wordsOf = (text) => String(text).toLowerCase().replace(/['\u2019\u2018`\u00b4]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

// version -> { first word -> [{ words, zone }] longest phrase first }.
const phraseIndexes = {};
function phraseIndexOf(gameVersion) {
  if (!has(ZONE_ALIASES, gameVersion)) return null;
  if (!phraseIndexes[gameVersion]) {
    const index = Object.create(null);
    for (const [zone, aliases] of Object.entries(ZONE_ALIASES[gameVersion])) {
      for (const phrase of [zone, ...aliases]) {
        const words = wordsOf(phrase);
        (index[words[0]] = index[words[0]] || []).push({ words, zone });
      }
    }
    for (const list of Object.values(index)) list.sort((a, b) => b.words.length - a.words.length);
    phraseIndexes[gameVersion] = index;
  }
  return phraseIndexes[gameVersion];
}

// The canonical zones a text names, in first-appearance order, each once, at most MAX_ZONES. [] for anything else (also a non-string).
export function parseZones(text, gameVersion) {
  const index = phraseIndexOf(gameVersion);
  if (!index || typeof text !== 'string') return [];
  const words = wordsOf(text);
  const found = [];
  for (let i = 0; i < words.length && found.length < MAX_ZONES; i++) {
    const hit = (index[words[i]] || []).find((entry) => entry.words.every((word, k) => words[i + k] === word));
    if (!hit) continue;
    if (!found.includes(hit.zone)) found.push(hit.zone);
    i += hit.words.length - 1;
  }
  return found;
}

// The canonical zones of a STORED value (a single name, "A + B", an old "BT / Hyjal"); unknown free text -> [].
export const splitZoneValue = (value, gameVersion) => parseZones(value, gameVersion);

// The stored value of a zone list: 'A + B', or null for none.
export const joinZones = (list) => (Array.isArray(list) && list.length ? list.join(' + ') : null);

// The size of a zone in a game version, or null when the zone is not one of that version's raids (a free-text zone from a log, none at all).
// A stored value of several zones ("A + B") takes the largest of them.
export function zoneSize(gameVersion, zone) {
  if (typeof zone !== 'string' || !has(RAID_ZONE_SIZES, gameVersion)) return null;
  const sizes = RAID_ZONE_SIZES[gameVersion];
  if (has(sizes, zone)) return sizes[zone];
  const zones = splitZoneValue(zone, gameVersion);
  return zones.length ? Math.max(...zones.map((name) => sizes[name])) : null;
}

// How many players a raid is planned for: the raid's own size when an officer set one, else its zone's size in the guild's version (the largest zone
// when it has several), else the team's.
// raid: { size (raids.size, NULL = automatic), zone }.
export function effectiveRaidSize(raid, teamSize, gameVersion) {
  if (isRaidSize(raid.size)) return raid.size;
  const fromZone = zoneSize(gameVersion, raid.zone);
  return fromZone === null ? teamSize : fromZone;
}

// The two fields every raid reply carries: `size` is the number the raid is planned for, `sizeOverride` what an officer set (null = automatic).
// The zone fields every raid reply carries next to `zone` (the stored text): `zones` the canonical list, `zoneSource` 'hand' | 'event' | 'log' | null.
export function raidZoneFields(raid, gameVersion) {
  return { zones: splitZoneValue(raid.zone, gameVersion), zoneSource: raid.zone_source === undefined ? null : raid.zone_source };
}

export function raidSizeFields(raid, teamSize, gameVersion) {
  return { size: effectiveRaidSize(raid, teamSize, gameVersion), sizeOverride: isRaidSize(raid.size) ? raid.size : null };
}

// The zones a Raid-Helper event names: its title first (the display title when the title is empty); only when that gives nothing its description, and only when
// that gives nothing the name of the channel it was posted in. event: { title, displayTitle?, description?, channelName? } -> canonical names, [] for none.
export function inferEventZones(event, gameVersion) {
  if (!event) return [];
  for (const text of [event.title || event.displayTitle, event.description, event.channelName]) {
    const zones = parseZones(text, gameVersion);
    if (zones.length) return zones;
  }
  return [];
}
