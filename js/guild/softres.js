// ── SOFTRES.IT GARGUL EXPORT -> NORMALIZED SOFT-RESERVE ROWS ───────────────
// Pure and tolerant, like gargul.js and tmb.js: reads the text of softres.it "Gargul Export" and returns the rows the Worker keeps for a raid
// (PUT /raids/:rid/loot-lists, source 'softres'): one per character and item, with how many copies they reserved. Unknown fields are ignored.
//
// Format facts, confirmed against Gargul's importer (papa-smurf/Gargul, tag v8.0.1, commit 7cc1fc1713ca74375398c36fb48d4dca2c7d32a6):
//   Classes/SoftRes.lua  SoftRes:import (l.895) and SoftRes:importGargulData (l.1166-1350): the text is base64 of a zlib stream of one JSON object
//                        (Base64.decode -> LibDeflate:DecompressZlib -> JSON). Gargul refuses it unless metadata.id and softreserves are there; this
//                        reader needs only softreserves. A text with a comma is read by Gargul as CSV instead (not supported here).
//                          metadata       { id, url, createdAt, updatedAt, raidStartsAt, hidden, discordUrl, ... }
//                          softreserves   list of { name, class, note, plusOnes, items: [{ id, ... }] }. A player who reserved the same item twice lists
//                                         its id twice; the count of an id is therefore the number of copies reserved.
//                          hardreserves   list of { id, for, note }: items nobody may roll for. They are counted for the preview, not stored.
//                          bonusrolls     Gargul turns them into Boosted Roll points; not needed here.
//                        softres.it has no realm tag on a name (the Gargul source says so), so a name is matched to a roster character by name alone.
// The checks mirror the Worker's (worker/loot-board.js readListRows): item id 1..2147483647, a 2-12 letter character, 1..20 copies, at most 5000 rows.
// Needs js/guild/tmb.js (decodePaste, displayName, positiveInt) loaded first. This file is safe to load alone: nothing here touches the page.
(function (G) {
  'use strict';

  const MAX_ROWS = 5000;
  const MAX_COPIES = 20;
  const SHOWN_SKIPPED = 20;
  const HELP = 'On softres.it open the raid and use "Gargul Export", then paste the text exactly as it is.';

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function T() { return G.tmb; }

  // The decoded JSON -> { rows (reserving players read), entries, skipped, stats } or { error }.
  function normalize(value) {
    if (!isPlain(value) || !Array.isArray(value.softreserves)) return { error: 'No soft-reserves were found in this text. ' + HELP };
    const entries = [];
    const skipped = [];
    value.softreserves.forEach(function (player, index) {
      const label = 'player ' + (index + 1);
      if (!isPlain(player) || !Array.isArray(player.items)) { skipped.push({ label: label, reason: 'No list of items' }); return; }
      const name = T().displayName(player.name);
      if (!name) { skipped.push({ label: label, reason: 'Name is not a character name' }); return; }
      const copies = {};
      const order = [];
      const names = {};
      player.items.forEach(function (item) {
        const id = T().positiveInt(isPlain(item) ? item.id : item);
        if (!id) return;
        if (!has(copies, id)) { copies[id] = 0; order.push(id); }
        copies[id] += 1;
        if (isPlain(item) && typeof item.name === 'string' && item.name.trim() && !has(names, id)) names[id] = item.name.trim().slice(0, 100);
      });
      order.forEach(function (id) {
        const row = { name: name, itemId: id, copies: Math.min(MAX_COPIES, copies[id]) };
        if (has(names, id)) row.itemName = names[id];
        entries.push(row);
      });
    });
    const items = {};
    const people = {};
    entries.forEach(function (e) { items[e.itemId] = true; people[e.name] = true; });
    return {
      rows: value.softreserves.length,
      entries: entries,
      skipped: skipped,
      stats: {
        items: Object.keys(items).length,
        characters: Object.keys(people).length,
        reserves: entries.reduce(function (sum, e) { return sum + e.copies; }, 0),
        hardReserves: Array.isArray(value.hardreserves) ? value.hardreserves.filter(function (h) { return isPlain(h) && T().positiveInt(h.id); }).length : 0,
      },
    };
  }

  // text -> Promise of { ok, error, rows, entries: [{ name, itemId, copies, itemName? }], skipped: [{ label, reason }], stats }.
  function parse(text) {
    const empty = function (error) { return { ok: false, error: error, rows: 0, entries: [], skipped: [], stats: null }; };
    return T().decodePaste(text, 'softres.it', HELP).then(function (decoded) {
      if (!decoded.ok) return empty(decoded.error);
      const n = normalize(decoded.value);
      if (n.error) return empty(n.error);
      if (n.entries.length > MAX_ROWS) return empty('This export holds ' + n.entries.length + ' rows; at most ' + MAX_ROWS + ' fit on one raid.');
      return { ok: true, error: null, rows: n.rows, entries: n.entries, skipped: n.skipped.slice(0, SHOWN_SKIPPED), skippedCount: n.skipped.length, stats: n.stats };
    });
  }

  G.softres = {
    MAX_ROWS: MAX_ROWS,
    SHOWN_SKIPPED: SHOWN_SKIPPED,
    parse: parse,
    normalize: normalize,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
