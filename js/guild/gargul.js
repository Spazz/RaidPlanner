// ── GARGUL DETAILED (JSON) EXPORT -> NORMALIZED AWARDS ──────────
// Pure and tolerant: reads the text of Gargul's `/gl export` with the "Detailed (JSON)" format and returns the awards the
// Worker takes (POST /raids/:rid/loot[/preview], max 500 per request), plus a reason for every row it could not use. Unknown fields
// are ignored, a missing optional field becomes null. The Worker validates the normalized rows again.
//
// Field names were confirmed against Gargul's source (papa-smurf/Gargul, tag v8.0.1, commit 7cc1fc1713ca74375398c36fb48d4dca2c7d32a6):
//   Classes/Exporter.lua  getLootEntries(raw) (l.225) and refreshExportString (l.194-198): the Detailed (JSON) format is
//                         GL.JSON:encode(<the raw AwardHistory entries, sorted by timestamp>), i.e. a JSON ARRAY of entries.
//                         Export settings (all default on) can leave out disenchanted, off-spec and bonus-roll entries.
//   Classes/AwardedLoot.lua  addWinner (l.439), AwardEntry (l.588-613): checksum, isBonusLoot, itemLink, itemID, itemGUID,
//                         awardedTo, awardedBy, timestamp, softresID, received, winnerClass, BRCost, GDKPCost, GDKPSession,
//                         OS, SR, WL, PL, TMB (booleans), winningRollType, Rolls. editWinner (l.317) changes awardedTo /
//                         awardedBy and keeps the checksum.
//   https://github.com/papa-smurf/Gargul/blob/7cc1fc1713ca74375398c36fb48d4dca2c7d32a6/Classes/Exporter.lua
//   https://github.com/papa-smurf/Gargul/blob/7cc1fc1713ca74375398c36fb48d4dca2c7d32a6/Classes/AwardedLoot.lua
// The checks mirror the Worker's (worker/loot-import.js readAwards), which refuses a whole request for one bad row:
// checksum 8-40 printable ASCII without spaces, item id 1..2147483647, time 2004-11-23..2100 in ms, a 2-12 letter winner (a disenchant has none).
// Facts the parser relies on (they differ from the first plan notes in two places):
//   - timestamp is epoch SECONDS (GetServerTime), UTC.
//   - checksum is a 20-digit string (two string hashes joined, cut to 20, right-padded with "0"); entries that predate
//     checksums have none (Exporter.lua l.246 invents one only for the non-raw formats), so they are skipped here.
//   - awardedTo is "Name-Realm" (addRealm always appends the realm; the realm has spaces and hyphens removed). A disenchanted
//     item has awardedTo "||de||" (Exporter.disenchantedItemIdentifier) and no winner. It is kept as an award with winnerName,
//     winnerRealm and winnerClass null and disenchanted true (Gargul's winnerClass on such an entry is only the PRIEST fallback);
//     the Worker stores it with the tag DE and no winner.
//   - winnerClass is a NUMBER (Constants.UnitClasses: 1 WARRIOR, 2 PALADIN, 3 HUNTER, 4 ROGUE, 5 PRIEST, 7 SHAMAN, 8 MAGE,
//     9 WARLOCK, 11 DRUID), not the class name, and Gargul falls back to PRIEST when it cannot tell, so it is only a hint.
//   - OS / SR / WL / PL / TMB are booleans (the other export formats print 1 / 0, so 1 is read as true too).
//   - winningRollType is the roll bracket name ("MS", "OS", "Bonus Roll", ...) and is absent for hand-made awards.
// This file is safe to load alone: nothing here touches the page.
(function (G) {
  'use strict';

  const MAX_PER_REQUEST = 500;
  const MAX_FILE_CHARS = 8 * 1024 * 1024;
  const DISENCHANT_MARK = '||de||';
  const FLAG_KEYS = ['OS', 'SR', 'WL', 'PL', 'TMB'];
  const CLASS_IDS = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];
  const CLASS_BY_NUMBER = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' };
  // Item link colour -> quality (WoW's own colours; 0 poor ... 7 heirloom).
  const QUALITY_BY_COLOR = { '9d9d9d': 0, 'ffffff': 1, '1eff00': 2, '0070dd': 3, 'a335ee': 4, 'ff8000': 5, 'e6cc80': 6, '00ccff': 7 };
  const CHECKSUM = /^[\x21-\x7e]{8,40}$/;
  const NAME_PATTERN = /^(?:\p{L}\p{M}{0,2})+$/u;
  const LINK = /\|c([0-9a-f]{8})\|Hitem:(\d+)[^|]*\|h\[([^\]]*)\]\|h\|r/i;
  const ARRAY_KEYS = ['awards', 'entries', 'loot', 'data', 'AwardHistory'];
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
  const MAX_ITEM_ID = 2147483647;
  const WOW_RELEASE_MS = Date.UTC(2004, 10, 23);
  const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clean(s, max) { return String(s).replace(CONTROL, '').trim().slice(0, max); }

  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

  function positiveInt(v) {
    const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : v;
    return typeof n === 'number' && isFinite(n) && n > 0 && n <= MAX_ITEM_ID && Math.floor(n) === n ? n : null;
  }

  // "|cffa335ee|Hitem:28770::::::::70:::::::|h[Nathrezim Mindblade]|h|r" -> { itemId, itemName, quality }, or null.
  // A link copied through chat can carry doubled pipes ("||c"): they are read as single ones.
  function parseItemLink(link) {
    if (typeof link !== 'string') return null;
    const m = LINK.exec(link.replace(/\|\|/g, '|'));
    if (!m) return null;
    const color = m[1].slice(2).toLowerCase();
    const name = clean(m[3], 100);
    return { itemId: positiveInt(m[2]), itemName: name || null, quality: has(QUALITY_BY_COLOR, color) ? QUALITY_BY_COLOR[color] : null };
  }

  // What an officer types into an "Item" box: an item id, a Wowhead link ("https://www.wowhead.com/tbc/item=28770/name", also ".../item/28770/..." and
  // "?item=28770") or a chat item link -> { itemId, itemName } (the name only when a chat link carries it), or null.
  function parseItemRef(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    if (/^\d{1,10}$/.test(t)) { const id = positiveInt(t); return id ? { itemId: id, itemName: null } : null; }
    const link = parseItemLink(t);
    if (link && link.itemId) return { itemId: link.itemId, itemName: link.itemName };
    const m = /(?:[?&#\/]item=|\/item\/)(\d{1,10})(?!\d)/i.exec(t);
    const id = m ? positiveInt(m[1]) : null;
    return id ? { itemId: id, itemName: null } : null;
  }

  // "Name-Realm" -> { name, realm } with the name in its display form (first letter upper case, the rest lower case);
  // realm is null without one. null when the name is not a character name (letters only, 2 to 12 of them).
  function parseWinner(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    const dash = text.indexOf('-');
    const namePart = (dash < 0 ? text : text.slice(0, dash)).normalize('NFC').trim();
    if (!NAME_PATTERN.test(namePart)) return null;
    const letters = Array.from(namePart);
    const name = (letters[0].toUpperCase() + letters.slice(1).join('').toLowerCase()).normalize('NFC');
    const len = Array.from(name).length;
    if (len < 2 || len > 12 || !NAME_PATTERN.test(name)) return null;
    const realm = dash < 0 ? '' : clean(text.slice(dash + 1), 40);
    // A realm with nothing left once spaces, hyphens and brackets go has no key: the Worker would refuse the row, so it is read as no realm.
    return { name: name, realm: realm && realmKey(realm) ? realm : null };
  }

  // The Worker's realm key (worker/roster-data.js realmKey): no brackets, spaces, apostrophes or hyphens.
  function realmKey(realm) {
    return realm.normalize('NFC').toLowerCase().replace(/\([^)]*\)/g, '').replace(new RegExp("[\\s'" + String.fromCharCode(0x2019) + '-]+', 'g'), '');
  }

  function classOf(v) {
    if (typeof v === 'number' && has(CLASS_BY_NUMBER, v)) return CLASS_BY_NUMBER[v];
    if (typeof v === 'string') {
      const t = v.trim();
      if (has(CLASS_BY_NUMBER, t)) return CLASS_BY_NUMBER[t];
      const up = t.toUpperCase();
      if (CLASS_IDS.indexOf(up) >= 0) return up;
    }
    return null;
  }

  // Epoch seconds (a number or digits) -> ms. A value that is already in ms (after 2001 in ms) is kept as it is.
  function timeOf(v) {
    const n = typeof v === 'string' && /^\d{1,13}(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    const ms = n >= 1e11 ? Math.round(n) : Math.round(n * 1000);
    return ms >= WOW_RELEASE_MS && ms <= FAR_FUTURE_MS ? ms : null;
  }

  function labelOf(row) {
    if (!isPlain(row)) return '';
    const link = parseItemLink(row.itemLink);
    const item = (link && link.itemName) || (positiveInt(row.itemID) ? 'Item ' + positiveInt(row.itemID) : '');
    const who = typeof row.awardedTo === 'string' ? clean(row.awardedTo, 40) : '';
    return [item, who ? 'to ' + who : ''].filter(Boolean).join(' ');
  }

  // One export entry -> { award } or { reason }. The checks run in a fixed order, so a row with several problems always
  // reports the first.
  function normalizeRow(row, fallbackChecksum) {
    if (!isPlain(row)) return { reason: 'Not an award entry' };
    const rawChecksum = has(row, 'checksum') ? row.checksum : fallbackChecksum;
    if (rawChecksum == null || rawChecksum === '') return { reason: 'Missing checksum' };
    const checksum = typeof rawChecksum === 'string' ? rawChecksum.trim() : '';
    if (!CHECKSUM.test(checksum)) return { reason: 'Checksum is not 8 to 40 characters without spaces' };

    const link = parseItemLink(row.itemLink);
    const itemId = positiveInt(row.itemID) || (link && link.itemId) || null;
    if (!itemId) return { reason: 'Missing item ID' };

    if (typeof row.awardedTo !== 'string' || !row.awardedTo.trim()) return { reason: 'Missing winner' };
    const disenchanted = row.awardedTo.trim() === DISENCHANT_MARK;
    const winner = disenchanted ? { name: null, realm: null } : parseWinner(row.awardedTo);
    if (!winner) return { reason: 'Winner name is not a character name' };

    const awardedAt = timeOf(row.timestamp);
    if (awardedAt == null) return { reason: 'Missing or invalid award time' };

    let rollType = typeof row.winningRollType === 'string' ? clean(row.winningRollType, 24) : '';
    if (rollType === '-') rollType = '';
    if (!rollType && row.isBonusLoot === true) rollType = 'Bonus Roll';
    const by = typeof row.awardedBy === 'string' ? clean(row.awardedBy, 64) : '';

    return { award: {
      checksum: checksum,
      itemId: itemId,
      itemName: link ? link.itemName : null,
      quality: link ? link.quality : null,
      awardedAt: awardedAt,
      winnerName: winner.name,
      winnerRealm: winner.realm,
      winnerClass: disenchanted ? null : classOf(row.winnerClass),
      disenchanted: disenchanted,
      rollType: rollType || null,
      flags: FLAG_KEYS.filter(function (k) { return truthy(row[k]); }),
      awardedBy: by || null,
    } };
  }

  // The rows of a parsed export: an array, an object holding one, or Gargul's own AwardHistory table (an object of entries
  // keyed by checksum). Returns { rows, keys } or null.
  function rowsOf(value) {
    if (Array.isArray(value)) return { rows: value, keys: null };
    if (!isPlain(value)) return null;
    for (let i = 0; i < ARRAY_KEYS.length; i++) {
      if (Array.isArray(value[ARRAY_KEYS[i]])) return { rows: value[ARRAY_KEYS[i]], keys: null };
    }
    const names = Object.keys(value);
    const arrays = names.filter(function (k) { return Array.isArray(value[k]) && value[k].some(isPlain); });
    if (arrays.length === 1) return { rows: value[arrays[0]], keys: null };
    if (names.length && names.every(function (k) { return isPlain(value[k]); })) {
      return { rows: names.map(function (k) { return value[k]; }), keys: names };
    }
    return null;
  }

  // text -> { ok, error, rows (number of entries read), awards: [normalized], awardRows: [row number of each award], skipped: [{ index, label, reason }] }.
  // index is the 1-based position of the entry in the export. ok is false only when no list of entries can be found.
  function parse(text) {
    const fail = function (error) { return { ok: false, error: error, rows: 0, awards: [], awardRows: [], skipped: [] }; };
    if (typeof text !== 'string') return fail('Paste the Gargul export first.');
    const body = text.replace(/^\uFEFF/, '').trim();
    if (!body) return fail('Paste the Gargul export first.');
    if (body.length > MAX_FILE_CHARS) return fail('That export is larger than 8 MB. Export fewer dates in Gargul and try again.');
    let value;
    try { value = JSON.parse(body); } catch (e) {
      return fail('This is not JSON. In Gargul open /gl export, choose the "Detailed (JSON)" format in its settings, and copy the text again.');
    }
    const found = rowsOf(value);
    if (!found) return fail('No list of awards was found in this text. Use the "Detailed (JSON)" format of /gl export.');
    const awards = [];
    const awardRows = [];
    const skipped = [];
    const seen = {};
    found.rows.forEach(function (row, i) {
      const r = normalizeRow(row, found.keys ? found.keys[i] : null);
      if (r.award && seen[r.award.checksum]) {
        skipped.push({ index: i + 1, label: labelOf(row), reason: 'Duplicate checksum in this paste' });
      } else if (r.award) {
        seen[r.award.checksum] = true;
        awards.push(r.award);
        awardRows.push(i + 1);
      } else {
        skipped.push({ index: i + 1, label: labelOf(row), reason: r.reason });
      }
    });
    return { ok: true, error: null, rows: found.rows.length, awards: awards, awardRows: awardRows, skipped: skipped };
  }

  function chunk(list, size) {
    const n = size > 0 ? size : MAX_PER_REQUEST;
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  G.gargul = {
    MAX_PER_REQUEST: MAX_PER_REQUEST,
    MAX_FILE_CHARS: MAX_FILE_CHARS,
    FLAG_KEYS: FLAG_KEYS,
    parse: parse,
    parseItemLink: parseItemLink,
    parseItemRef: parseItemRef,
    parseWinner: parseWinner,
    chunk: chunk,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
