// The raid zones a raid can be created with by hand, per game version: the raid names of js/rules/{tbc,classic,forever}.js
// (planning templates left out), which are also the zone names Warcraft Logs reports use. tests pin the parity.
export const RAID_ZONES = {
  tbc: ['Karazhan', 'Gruul\'s Lair', 'Magtheridon\'s Lair', 'Serpentshrine Cavern', 'Tempest Keep', 'Zul\'Aman', 'Hyjal Summit', 'Black Temple', 'Sunwell Plateau'],
  classic: ['Molten Core', 'Onyxia\'s Lair', 'Blackwing Lair', 'Zul\'Gurub', 'Ruins of Ahn\'Qiraj', 'Temple of Ahn\'Qiraj', 'Naxxramas'],
  forever: ['Barrow Deeps', 'Hyjal Summit', 'Onyxia\'s Lair'],
};

export function zonesFor(gameVersion) {
  return Object.prototype.hasOwnProperty.call(RAID_ZONES, gameVersion) ? RAID_ZONES[gameVersion] : [];
}
