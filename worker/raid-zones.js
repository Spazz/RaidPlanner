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

// The size of a zone in a game version, or null when the zone is not one of that version's raids (a free-text zone from a log, none at all).
export function zoneSize(gameVersion, zone) {
  if (typeof zone !== 'string' || !has(RAID_ZONE_SIZES, gameVersion)) return null;
  const sizes = RAID_ZONE_SIZES[gameVersion];
  return has(sizes, zone) ? sizes[zone] : null;
}

// How many players a raid is planned for: the raid's own size when an officer set one, else its zone's size in the guild's version, else the team's.
// raid: { size (raids.size, NULL = automatic), zone }.
export function effectiveRaidSize(raid, teamSize, gameVersion) {
  if (isRaidSize(raid.size)) return raid.size;
  const fromZone = zoneSize(gameVersion, raid.zone);
  return fromZone === null ? teamSize : fromZone;
}

// The two fields every raid reply carries: `size` is the number the raid is planned for, `sizeOverride` what an officer set (null = automatic).
export function raidSizeFields(raid, teamSize, gameVersion) {
  return { size: effectiveRaidSize(raid, teamSize, gameVersion), sizeOverride: isRaidSize(raid.size) ? raid.size : null };
}
