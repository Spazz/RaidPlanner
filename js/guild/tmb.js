// ── THATSMYBIS (TMB) GARGUL EXPORT -> NORMALIZED PRIO / WISHLIST ROWS ──────
// Pure and tolerant, like gargul.js: reads the text of ThatsMyBIS "Export Gargul" and returns the rows the Worker keeps for a raid
// (PUT /raids/:rid/loot-lists, source 'tmb'), plus a reason for every entry it could not use. Unknown fields are ignored. The Worker validates the rows again.
//
// Format facts, confirmed against Gargul's importer (papa-smurf/Gargul, tag v8.0.1, commit 7cc1fc1713ca74375398c36fb48d4dca2c7d32a6):
//   Classes/TMB.lua  TMB:import (l.680-935) and TMB:decompress (l.1244): the text is base64 of a zlib stream of one JSON object; Gargul decodes it as
//                    Base64.decode -> LibDeflate:DecompressZlib -> JSON. The JSON starts {"wishlists": and holds
//                      wishlists  object: item id (string key) -> list of entry strings, one per character,
//                                 "name|order|type|group" (current), or with doubled pipes "name||order||type||group" (the older, longer form:
//                                 name is part 1, order part 3, type part 5; Gargul picks the form by counting parts: more than 4 = the older one),
//                      groups, notes, tiers, loot  raid groups, item notes, item tiers and the loot-priority text: not needed by the board.
//                    type: 1 = prio (Constants.lua tmbTypePrio), anything else = wishlist (tmbTypeWish = 2). order is the place in line (1 = first);
//                    a non-numeric order ("?") is kept as "no order". Names are lower case in the export. A character can carry "-realm".
//                    A TMB export holds NO received flag and NO item names: "received" on the board comes from Gargul awards of earlier raids,
//                    item names from the guild's own award history (or the plain "Item 12345").
//   Data/Constants.lua  tmbTypePrio = 1, tmbTypeWish = 2.
//   Utils/Strings.lua   GL:explode splits on the delimiter and trims every part.
// The checks mirror the Worker's (worker/loot-board.js readListRows): item id 1..2147483647, a 2-12 letter character, prio 0..9999, at most 5000 rows.
// Wishlist rows of an item nobody has a prio on are left out (the board shows an item only when someone is in line by prio or soft-reserve).
// decodePaste is shared with softres.js (load order: this file first). This file is safe to load alone: nothing here touches the page.
(function (G) {
  'use strict';

  const MAX_TEXT_CHARS = 8 * 1024 * 1024;
  const MAX_DECODED_BYTES = 40 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const MAX_ITEM_ID = 2147483647;
  const MAX_PRIO = 9999;
  const NAME_PATTERN = /^(?:\p{L}\p{M}{0,2})+$/u;
  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const PRIO_TYPE = 1;
  const SHOWN_SKIPPED = 20;

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function positiveInt(v) {
    const n = typeof v === 'string' && /^\s*\d{1,10}\s*$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && isFinite(n) && n > 0 && n <= MAX_ITEM_ID && Math.floor(n) === n ? n : null;
  }

  // "thornwick" / "Thornwick-Realm" -> "Thornwick"; null when it is not a character name (letters only, 2 to 12 of them).
  function displayName(raw) {
    if (typeof raw !== 'string') return null;
    const dash = raw.indexOf('-');
    const part = (dash < 0 ? raw : raw.slice(0, dash)).normalize('NFC').trim();
    if (!NAME_PATTERN.test(part)) return null;
    const letters = Array.from(part);
    const name = (letters[0].toUpperCase() + letters.slice(1).join('').toLowerCase()).normalize('NFC');
    const len = Array.from(name).length;
    return len >= 2 && len <= 12 && NAME_PATTERN.test(name) ? name : null;
  }

  // ── decoding (also used by softres.js) ──
  // The text of a Gargul export -> bytes. Whitespace is dropped (a paste is often wrapped); standard base64 only, as Gargul's decoder.
  function base64Bytes(text) {
    const clean = text.replace(/\s+/g, '');
    if (!clean || clean.length % 4 === 1 || !BASE64.test(clean)) return null;
    let binary;
    try { binary = atob(clean); } catch (e) { return null; }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // zlib bytes -> text (the browser's DecompressionStream('deflate') reads the zlib wrapper). Stops at MAX_DECODED_BYTES.
  function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('no-stream'));
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(function () { /* the reader reports a bad stream */ });
    writer.close().catch(function () { /* same */ });
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) return chunks;
        total += step.value.length;
        if (total > MAX_DECODED_BYTES) { reader.cancel().catch(function () { /* nothing to do */ }); throw new Error('too-big'); }
        chunks.push(step.value);
        return pump();
      });
    }
    return pump().then(function (parts) {
      const all = new Uint8Array(total);
      let at = 0;
      parts.forEach(function (part) { all.set(part, at); at += part.length; });
      return new TextDecoder('utf-8', { fatal: false }).decode(all);
    });
  }

  // The pasted export -> Promise of { ok: true, value } (the parsed JSON) or { ok: false, error }. `what` names the export in the messages.
  // Raw JSON (a paste that is already decoded) is read as it is.
  function decodePaste(text, what, help) {
    const fail = function (error) { return { ok: false, error: error }; };
    if (typeof text !== 'string' || !text.trim()) return Promise.resolve(fail('Paste the ' + what + ' export first.'));
    const body = text.replace(/^\uFEFF/, '').trim();
    if (body.length > MAX_TEXT_CHARS) return Promise.resolve(fail('That export is larger than 8 MB.'));
    function parseJson(json) {
      try { return { ok: true, value: JSON.parse(json) }; } catch (e) { return fail('The export unpacked, but it is not valid data. ' + help); }
    }
    if (body.charAt(0) === '{' || body.charAt(0) === '[') return Promise.resolve(parseJson(body));
    const bytes = base64Bytes(body);
    if (!bytes) return Promise.resolve(fail('This is not a ' + what + ' export. ' + help));
    return inflate(bytes).then(parseJson, function (e) {
      if (e && e.message === 'no-stream') return fail('This browser cannot unpack the export. Use a current Chrome, Edge, Firefox or Safari.');
      if (e && e.message === 'too-big') return fail('That export is far larger than a ' + what + ' export is.');
      return fail('This is not a ' + what + ' export. ' + help);
    });
  }

  // ── TMB rows ──
  // One entry of a wishlists list -> { name, prio, kind } or { reason }. A string "name|order|type|group" (or the doubled-pipe form), or an object
  // with name / character, prio / order and type.
  function readEntry(entry) {
    let name;
    let order;
    let type;
    if (typeof entry === 'string') {
      const parts = entry.split('|').map(function (p) { return p.trim(); });
      const older = parts.length > 4;
      name = parts[0];
      order = older ? parts[2] : parts[1];
      type = older ? parts[4] : parts[2];
    } else if (isPlain(entry)) {
      name = has(entry, 'name') ? entry.name : entry.character;
      order = has(entry, 'prio') ? entry.prio : entry.order;
      type = entry.type;
    } else {
      return { reason: 'Not a character entry' };
    }
    const shown = displayName(name);
    if (!shown) return { reason: 'Name is not a character name' };
    const n = typeof order === 'string' && /^\s*\d{1,5}\s*$/.test(order) ? Number(order) : order;
    const prio = typeof n === 'number' && isFinite(n) && n >= 0 && n <= MAX_PRIO && Math.floor(n) === n ? n : null;
    return { name: shown, prio: prio, kind: Number(type) === PRIO_TYPE ? 'prio' : 'wish' };
  }

  // The decoded JSON -> { rows (entries read), entries, skipped, stats } or { error }.
  function normalize(value) {
    if (!isPlain(value) || !isPlain(value.wishlists)) {
      return { error: 'No wishlists were found in this text. On ThatsMyBIS use the Gargul export ("Export Gargul") and paste the text exactly as it is.' };
    }
    const entries = [];
    const skipped = [];
    const seen = {};
    let read = 0;
    let wishLeftOut = 0;
    Object.keys(value.wishlists).forEach(function (key) {
      const itemId = positiveInt(key);
      const list = value.wishlists[key];
      if (!Array.isArray(list)) return;
      list.forEach(function (raw) {
        read += 1;
        if (!itemId) { skipped.push({ label: 'item ' + key, reason: 'Item ID is not valid' }); return; }
        const r = readEntry(raw);
        if (r.reason) { skipped.push({ label: 'item ' + itemId, reason: r.reason }); return; }
        const id = itemId + '|' + r.name + '|' + r.kind + '|' + r.prio;
        if (seen[id]) return;
        seen[id] = true;
        entries.push({ name: r.name, itemId: itemId, kind: r.kind, prio: r.prio });
      });
    });
    const prioItems = {};
    entries.forEach(function (e) { if (e.kind === 'prio') prioItems[e.itemId] = true; });
    const kept = entries.filter(function (e) {
      if (e.kind === 'prio' || prioItems[e.itemId]) return true;
      wishLeftOut += 1;
      return false;
    });
    const items = {};
    const people = {};
    kept.forEach(function (e) { items[e.itemId] = true; people[e.name] = true; });
    return {
      rows: read,
      entries: kept,
      skipped: skipped,
      stats: {
        items: Object.keys(items).length,
        characters: Object.keys(people).length,
        prio: kept.filter(function (e) { return e.kind === 'prio'; }).length,
        wish: kept.filter(function (e) { return e.kind === 'wish'; }).length,
        wishLeftOut: wishLeftOut,
      },
    };
  }

  // text -> Promise of { ok, error, rows, entries: [{ name, itemId, kind, prio }], skipped: [{ label, reason }], stats }.
  function parse(text) {
    const empty = function (error) { return { ok: false, error: error, rows: 0, entries: [], skipped: [], stats: null }; };
    return decodePaste(text, 'TMB', 'In ThatsMyBIS open the Gargul export ("Export Gargul") and paste the text exactly as it is.').then(function (decoded) {
      if (!decoded.ok) return empty(decoded.error);
      const n = normalize(decoded.value);
      if (n.error) return empty(n.error);
      if (n.entries.length > MAX_ROWS) return empty('This export holds ' + n.entries.length + ' rows; at most ' + MAX_ROWS + ' fit on one raid.');
      return { ok: true, error: null, rows: n.rows, entries: n.entries, skipped: n.skipped.slice(0, SHOWN_SKIPPED), skippedCount: n.skipped.length, stats: n.stats };
    });
  }

  G.tmb = {
    MAX_ROWS: MAX_ROWS,
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    SHOWN_SKIPPED: SHOWN_SKIPPED,
    parse: parse,
    normalize: normalize,
    decodePaste: decodePaste,
    displayName: displayName,
    positiveInt: positiveInt,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
