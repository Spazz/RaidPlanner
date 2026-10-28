// Realm lists as of 2026-10-14.
// Sources: Warcraft Logs classic. / fresh. server lists (queried 2026-10-14); Blizzard / Warcraft Tavern
// 2024-11-21 Anniversary realm announcement; warcraft.wiki.gg Classic realms list (2024-11-20).
// The Classic Era list may be stale (no current official Blizzard Era list exists). WoW Forever has no realms:
// it uses rulesets instead. The server accepts any realm name; this list is a convenience that supplies slugs.

// maxLevel: the level cap of the version. A Battle.net character at it joins a member's profile by itself (worker/bnet-auto-add.js); lower ones are picked by hand.
// WoW Forever has no Battle.net namespace yet (worker/battlenet.js NAMESPACES), so the rule cannot fire there until Blizzard publishes one.
export const GAME_VERSIONS = [
  { key: 'tbc', label: 'TBC Anniversary', maxLevel: 70 },
  { key: 'classic', label: 'Classic Era', maxLevel: 60 },
  { key: 'forever', label: 'WoW Forever', maxLevel: 60 },
];

// The level cap of a game version, or null for a version this list does not know.
export function maxLevelOf(gameVersion) {
  const version = GAME_VERSIONS.find((row) => row.key === gameVersion);
  return version ? version.maxLevel : null;
}

export const REGIONS = ['US', 'EU', 'KR', 'TW'];

export const FOREVER_RULESETS = ['Normal', 'PvP', 'RP', 'Hardcore'];

export const REALMS = {
  tbc: {
    US: [
      { name: "Dreamscythe", slug: "dreamscythe", type: "PvE" },
      { name: "Nightslayer", slug: "nightslayer", type: "PvP" },
      { name: "Maladath (AU)", slug: "maladath", type: "PvP" },
    ],
    EU: [
      { name: "Thunderstrike", slug: "thunderstrike", type: "PvE" },
      { name: "Spineshatter", slug: "spineshatter", type: "PvP" },
    ],
    KR: [],
    TW: [],
  },
  classic: {
    US: [
      { name: "Atiesh", slug: "atiesh", type: "PvE" },
      { name: "Arugal (AU)", slug: "arugal-au", type: "PvP" },
      { name: "Bloodsail Buccaneers", slug: "bloodsail-buccaneers", type: "RP" },
      { name: "Faerlina", slug: "faerlina", type: "PvP" },
      { name: "Fairbanks", slug: "fairbanks", type: "PvP" },
      { name: "Grobbulus", slug: "grobbulus", type: "PvP RP" },
      { name: "Herod", slug: "herod", type: "PvP" },
      { name: "Mankrik", slug: "mankrik", type: "PvE" },
      { name: "Myzrael", slug: "myzrael", type: "PvE" },
      { name: "Pagle", slug: "pagle", type: "PvE" },
      { name: "Remulos (AU)", slug: "remulos-au", type: "PvE" },
      { name: "Thalnos", slug: "thalnos", type: "PvP" },
      { name: "Whitemane", slug: "whitemane", type: "PvP" },
      { name: "Stalagg", slug: "stalagg", type: "PvP" },
      { name: "Blaumeux", slug: "blaumeux", type: "PvP" },
      { name: "Skeram", slug: "skeram", type: "PvP" },
      { name: "Incendius", slug: "incendius", type: "PvP" },
      { name: "Bigglesworth", slug: "bigglesworth", type: "PvP" },
      { name: "Old Blanchy", slug: "old-blanchy", type: "PvE" },
      { name: "Westfall", slug: "westfall", type: "PvE" },
      { name: "Kurinnaxx", slug: "kurinnaxx", type: "PvP" },
      { name: "Kromcrush", slug: "kromcrush", type: "PvP" },
      { name: "Deviate Delight", slug: "deviate-delight", type: "PvP RP" },
      { name: "Smolderweb", slug: "smolderweb", type: "PvP" },
      { name: "Sulfuras", slug: "sulfuras", type: "PvP" },
      { name: "Ashkandi", slug: "ashkandi", type: "PvE" },
      { name: "Kirtonos", slug: "kirtonos", type: "PvP" },
      { name: "Rattlegore", slug: "rattlegore", type: "PvP" },
      { name: "Felstriker", slug: "felstriker", type: "PvP" },
      { name: "Yojamba (AU)", slug: "yojamba-au", type: "PvP" },
      { name: "Thunderfury", slug: "thunderfury", type: "PvP" },
      { name: "Benediction", slug: "benediction", type: "PvP" },
      { name: "Azuresong", slug: "azuresong", type: "PvE" },
      { name: "Windseeker", slug: "windseeker", type: "PvE" },
      { name: "Anathema", slug: "anathema", type: "PvP" },
      { name: "Netherwind", slug: "netherwind", type: "PvP" },
      { name: "Earthfury", slug: "earthfury", type: "PvP" },
      { name: "Heartseeker", slug: "heartseeker", type: "PvP" },
      { name: "Arcanite Reaper", slug: "arcanite-reaper", type: "PvP" },
      { name: "Loatheb", slug: "loatheb", type: "PvP" },
      { name: "Sul'thraze", slug: "sulthraze", type: "PvP" },
      { name: "Skyfury", slug: "skyfury", type: "PvP" },
      { name: "Maladath", slug: "maladath", type: "PvE" },
      { name: "Eranikus", slug: "eranikus" },
      { name: "Angerforge", slug: "angerforge", type: "PvP" },
      { name: "Skull Rock", slug: "skull-rock", type: "Hardcore" },
      { name: "Defias Pillager", slug: "defias-pillager", type: "Hardcore" },
      { name: "Doomhowl", slug: "doomhowl", type: "Hardcore" },
    ],
    EU: [
      { name: "Golemagg", slug: "golemagg", type: "PvP" },
      { name: "Hydraxian Waterlords", slug: "hydraxian-waterlords", type: "RP" },
      { name: "Mirage Raceway", slug: "mirage-raceway", type: "PvE" },
      { name: "Pyrewood Village", slug: "pyrewood-village", type: "PvE" },
      { name: "Shazzrah", slug: "shazzrah", type: "PvP" },
      { name: "Zandalar Tribe", slug: "zandalar-tribe", type: "PvP RP" },
      { name: "Auberdine", slug: "auberdine", type: "PvE" },
      { name: "Sulfuron", slug: "sulfuron", type: "PvP" },
      { name: "Everlook", slug: "everlook", type: "PvE" },
      { name: "Lucifron", slug: "lucifron", type: "PvP" },
      { name: "Хроми", slug: "chromie", type: "PvE" },
      { name: "Пламегор", slug: "flamegor", type: "PvP" },
      { name: "Gehennas", slug: "gehennas", type: "PvP" },
      { name: "Firemaw", slug: "firemaw", type: "PvP" },
      { name: "Flamelash", slug: "flamelash", type: "PvP" },
      { name: "Gandling", slug: "gandling", type: "PvP" },
      { name: "Mograine", slug: "mograine", type: "PvP" },
      { name: "Nethergarde Keep", slug: "nethergarde-keep", type: "PvE" },
      { name: "Razorgore", slug: "razorgore", type: "PvP" },
      { name: "Stonespine", slug: "stonespine", type: "PvP" },
      { name: "Noggenfogger", slug: "noggenfogger", type: "PvP" },
      { name: "Amnennar", slug: "amnennar", type: "PvP" },
      { name: "Ashbringer", slug: "ashbringer", type: "PvP" },
      { name: "Dreadmist", slug: "dreadmist", type: "PvP" },
      { name: "Skullflame", slug: "skullflame", type: "PvP" },
      { name: "Ten Storms", slug: "ten-storms", type: "PvP" },
      { name: "Dragon's Call", slug: "dragons-call", type: "PvP" },
      { name: "Lakeshire", slug: "lakeshire", type: "PvE" },
      { name: "Transcendence", slug: "transcendence", type: "PvP" },
      { name: "Finkle", slug: "finkle", type: "PvP" },
      { name: "Bloodfang", slug: "bloodfang", type: "PvP" },
      { name: "Judgement", slug: "judgement", type: "PvP" },
      { name: "Earthshaker", slug: "earthshaker", type: "PvP" },
      { name: "Venoxis", slug: "venoxis", type: "PvP" },
      { name: "Змейталак", slug: "wyrmthalak", type: "PvP" },
      { name: "Рок-Делар", slug: "rhokdelar", type: "PvP" },
      { name: "Razorfen", slug: "razorfen", type: "PvE" },
      { name: "Patchwerk", slug: "patchwerk", type: "PvP" },
      { name: "Heartstriker", slug: "heartstriker", type: "PvP" },
      { name: "Mandokir", slug: "mandokir", type: "PvP" },
      { name: "Вестник Рока", slug: "harbinger-of-doom", type: "PvP" },
      { name: "Dragonfang", slug: "dragonfang", type: "PvP" },
      { name: "Celebras", slug: "celebras", type: "RP" },
      { name: "Thekal", slug: "thekal", type: "PvP" },
      { name: "Giantstalker", slug: "giantstalker", type: "PvE" },
      { name: "Jin'do", slug: "jindo", type: "PvP" },
      { name: "Nek'Rosh", slug: "nekrosh", type: "Hardcore" },
      { name: "Stitches", slug: "stitches", type: "Hardcore" },
      { name: "Soulseeker", slug: "soulseeker", type: "Hardcore" },
    ],
    KR: [
      { name: "로크홀라", slug: "lokholar", type: "PvP" },
      { name: "소금 평원", slug: "shimmering-flats", type: "PvE" },
      { name: "얼음피", slug: "iceblood", type: "PvP" },
      { name: "라그나로스", slug: "ragnaros", type: "PvP" },
      { name: "힐스브래드", slug: "hillsbrad", type: "PvP" },
      { name: "서리한", slug: "frostmourne", type: "PvP" },
      { name: "몰다르의 투지", slug: "moldars-moxie" },
      { name: "펜구스의 흉포", slug: "fengus-ferocity" },
      { name: "막고라", slug: "makgora", type: "Hardcore" },
    ],
    TW: [
      { name: "伊弗斯", slug: "ivus", type: "PvP" },
      { name: "瑪拉頓", slug: "maraudon", type: "PvE" },
      { name: "阿拉希盆地", slug: "arathi-basin", type: "PvP" },
      { name: "魚人", slug: "murloc", type: "PvE" },
      { name: "逐風者", slug: "windseeker", type: "PvP" },
      { name: "古雷曼格", slug: "golemagg", type: "PvP" },
      { name: "札里克", slug: "zeliek", type: "PvP" },
      { name: "烏蘇雷", slug: "wushoolay", type: "PvP" },
      { name: "木喉要塞", slug: "timbermaw-hold" },
      { name: "摩爾達的勇氣", slug: "moldars-moxie" },
      { name: "芬古斯的狂暴", slug: "fengus-ferocity" },
      { name: "特雷姆斯", slug: "teremus", type: "Hardcore" },
      { name: "虛無行者", slug: "voidwalker", type: "Hardcore" },
    ],
  },
  forever: {
    US: [],
    EU: [],
    KR: [],
    TW: [],
  },
};

export function isVersion(key) {
  return typeof key === 'string' && GAME_VERSIONS.some((version) => version.key === key);
}

// Case-insensitive match of a typed realm name against the list for a version and region -> the entry or null.
export function findRealm(version, region, name) {
  if (typeof name !== 'string') return null;
  const wanted = name.trim().toLowerCase();
  const list = REALMS[version] && REALMS[version][region];
  if (!wanted || !Array.isArray(list)) return null;
  return list.find((realm) => realm.name.toLowerCase() === wanted) || null;
}
