// ── RAID ZONES (pure) ───────────────────────────────────────────
// The page copy of worker/raid-zones.js's zone parser (tests/guild/guild-zones-worker-tests.js pins the two alias tables and their results).
// Free text (a Raid-Helper title, a log's zone name, a stored value) -> the version's canonical zone names. Zone names only, never boss names.
//   G.zones.ALIASES         version -> canonical name -> short names (the canonical name itself always matches too)
//   G.zones.MAX_ZONES       3
//   G.zones.zonesFor(v)     the version's raid names from RulesData (planning templates left out), [] without rules
//   G.zones.parse(text, v)  canonical names in first-appearance order, unique, at most MAX_ZONES
//   G.zones.split(value, v) the canonical list of a STORED zone value ('Black Temple + Hyjal Summit', an old 'BT / Hyjal'); unknown text -> []
//   G.zones.join(list)      'A + B' or null
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
  function zonesFor(version) {
    const rules = typeof RulesData !== 'undefined' && RulesData ? RulesData[version] : null;
    const raids = rules && rules.raids ? rules.raids : {};
    return Object.keys(raids).filter(function (k) { return raids[k].tier !== 'Planning templates'; }).map(function (k) { return raids[k].name; });
  }

  G.zones = { ALIASES: ALIASES, MAX_ZONES: MAX_ZONES, zonesFor: zonesFor, parse: parse, split: parse, join: join };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
