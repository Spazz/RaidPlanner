// ── RAID ZONES (pure) ───────────────────────────────────────────
// The page copy of worker/raid-zones.js's zone parser (tests/guild/guild-zones-worker-tests.js pins the two alias tables and their results).
// Free text (a Raid-Helper title, a log's zone name, a stored value) -> the version's canonical zone names. Zone names only, never boss names.
//   G.zones.ALIASES         version -> canonical name -> short names (the canonical name itself always matches too)
//   G.zones.MAX_ZONES       3
//   G.zones.zonesFor(v)     the version's raid names from RulesData (planning templates left out), [] without rules
//   G.zones.zoneChoicesFor(v) the same raids as [{ name, tier }] (the picker's tiles)
//   G.zones.parse(text, v)  canonical names in first-appearance order, unique, at most MAX_ZONES
//   G.zones.split(value, v) the canonical list of a STORED zone value ('Black Temple + Hyjal Summit', an old 'BT / Hyjal'); unknown text -> []
//   G.zones.join(list)      'A + B' or null
//   G.zones.artImagesHtml(names, { size: 'sm'|'md', max, lazy, alt })  the zone art pictures of a raid ('' when no zone has art); alt: true = the zone name, else '' (decorative)
(function (G) {
  'use strict';

  const ALIASES = {
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

  const MAX_ZONES = 3;

  function wordsOf(text) {
    return String(text).toLowerCase().replace(/['\u2019\u2018`\u00b4]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  }

  const indexes = {};
  function indexOf(version) {
    if (!Object.prototype.hasOwnProperty.call(ALIASES, version)) return null;
    if (!indexes[version]) {
      const index = Object.create(null);
      Object.keys(ALIASES[version]).forEach(function (zone) {
        [zone].concat(ALIASES[version][zone]).forEach(function (phrase) {
          const words = wordsOf(phrase);
          (index[words[0]] = index[words[0]] || []).push({ words: words, zone: zone });
        });
      });
      Object.keys(index).forEach(function (first) { index[first].sort(function (a, b) { return b.words.length - a.words.length; }); });
      indexes[version] = index;
    }
    return indexes[version];
  }

  function parse(text, version) {
    const index = indexOf(version);
    if (!index || typeof text !== 'string') return [];
    const words = wordsOf(text);
    const found = [];
    for (let i = 0; i < words.length && found.length < MAX_ZONES; i++) {
      const hit = (index[words[i]] || []).find(function (entry) { return entry.words.every(function (word, k) { return words[i + k] === word; }); });
      if (!hit) continue;
      if (found.indexOf(hit.zone) < 0) found.push(hit.zone);
      i += hit.words.length - 1;
    }
    return found;
  }

  function join(list) {
    return Array.isArray(list) && list.length ? list.join(' + ') : null;
  }

  // The raid names of a game version (the planner's raid list, planning templates left out), as pages-raids.js zonesOf reads them.
  function zoneChoicesFor(version) {
    const rules = typeof RulesData !== 'undefined' && RulesData ? RulesData[version] : null;
    const raids = rules && rules.raids ? rules.raids : {};
    return Object.keys(raids).filter(function (k) { return raids[k].tier !== 'Planning templates'; }).map(function (k) { return { name: raids[k].name, tier: raids[k].tier || '' }; });
  }
  function zonesFor(version) { return zoneChoicesFor(version).map(function (c) { return c.name; }); }

  // The short name on a tile, its tint class (guild.css, .gs-hd-tile.is-<tint>) and `art`: the key of the loading-screen crop in icons/raids/<art>-sm.webp
  // (192x108) and -md.webp (480x270). Any other zone gets its first letters, a neutral tile and no art (Barrow Deeps).
  const TILES = {
    'karazhan': { abbr: 'KARA', tint: 'kara', art: 'kara' },
    "gruul's lair": { abbr: 'GRUUL', tint: 'gruul', art: 'gruul' },
    "magtheridon's lair": { abbr: 'MAG', tint: 'mag', art: 'mag' },
    'serpentshrine cavern': { abbr: 'SSC', tint: 'ssc', art: 'ssc' },
    'tempest keep': { abbr: 'TK', tint: 'tk', art: 'tk' },
    'hyjal summit': { abbr: 'HYJAL', tint: 'hyjal', art: 'hyjal' },
    'black temple': { abbr: 'BT', tint: 'bt', art: 'bt' },
    "zul'aman": { abbr: 'ZA', tint: 'za', art: 'za' },
    'sunwell plateau': { abbr: 'SWP', tint: 'swp', art: 'swp' },
    'molten core': { abbr: 'MC', tint: 'mc', art: 'mc' },
    "onyxia's lair": { abbr: 'ONY', tint: 'ony', art: 'ony' },
    'blackwing lair': { abbr: 'BWL', tint: 'bwl', art: 'bwl' },
    "zul'gurub": { abbr: 'ZG', tint: 'zg', art: 'zg' },
    "ruins of ahn'qiraj": { abbr: 'AQ20', tint: 'aq20', art: 'aq20' },
    "temple of ahn'qiraj": { abbr: 'AQ40', tint: 'aq40', art: 'aq40' },
    'naxxramas': { abbr: 'NAXX', tint: 'naxx', art: 'naxx' },
  };
  const ART_SIZES = { sm: { w: 192, h: 108 }, md: { w: 480, h: 270 } };
  const ART_KEYS = Object.keys(TILES).map(function (k) { return TILES[k].art; });

  function tile(name) {
    const known = TILES[String(name).toLowerCase()];
    if (known) return known;
    const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
    const abbr = words.length > 1 ? words.slice(0, 4).map(function (w) { return w.charAt(0); }).join('') : (words[0] || '').slice(0, 3);
    return { abbr: abbr.toUpperCase() || '?', tint: 'other' };
  }

  // The art pictures of a raid, in zone order, at most `max` (default MAX_ZONES): an <img class="gs-hd-artimg"> per zone with art (the -<size> crop), a plain filler span for a zone
  // without art among zones with art. '' when no zone has art (the caller then uses its plain markup). o: { size ('sm' | 'md', default 'md'), max, lazy, alt (true: the zone name) }.
  function artImagesHtml(names, o) {
    const opts = o || {};
    const size = opts.size === 'sm' ? 'sm' : 'md';
    const max = opts.max > 0 ? opts.max : MAX_ZONES;
    const esc = G.ui && G.ui.esc ? G.ui.esc : function (s) { return String(s); };
    const tiles = (Array.isArray(names) ? names : []).slice(0, max).map(function (name) { return { name: name, tile: tile(name) }; });
    if (!tiles.some(function (z) { return !!z.tile.art; })) return '';
    const dim = ART_SIZES[size];
    return tiles.map(function (z) {
      return z.tile.art
        ? '<img class="gs-hd-artimg" src="/icons/raids/' + z.tile.art + '-' + size + '.webp" alt="' + (opts.alt ? esc(z.name) : '') + '" width="' + dim.w + '" height="' + dim.h + '"' + (opts.lazy ? ' loading="lazy"' : '') + '>'
        : '<span class="gs-hd-artimg is-fill" aria-hidden="true"></span>';
    }).join('');
  }
  G.zones = { tile: tile, ART_SIZES: ART_SIZES, ART_KEYS: ART_KEYS, ALIASES: ALIASES, MAX_ZONES: MAX_ZONES, zonesFor: zonesFor, zoneChoicesFor: zoneChoicesFor, parse: parse, split: parse, join: join, artImagesHtml: artImagesHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
