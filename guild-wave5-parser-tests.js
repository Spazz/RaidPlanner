/**
 * Raidsmith guild tracker - PM wave 5 parser tests (js/guild/tmb.js, softres.js and the item reference of gargul.js).
 * Run: node guild-wave5-parser-tests.js
 *
 * Hand-made fixtures: the export text is produced here the way the sites do (JSON -> zlib -> base64), so the real DecompressionStream path runs.
 * The format facts the parsers rely on are recorded in the file headers (Gargul commit 7cc1fc1). The rows each parser returns are also run through
 * the Worker's own validation (worker/loot-board.js readListRows), so the two sides cannot drift apart.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
async function main() {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

const sandbox = { console, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, Uint8Array, atob, TextDecoder, DecompressionStream, setTimeout };
vm.createContext(sandbox);
for (const file of ['js/guild/gargul.js', 'js/guild/tmb.js', 'js/guild/softres.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
const G = sandbox.Guild;
const plain = (value) => JSON.parse(JSON.stringify(value));
const encode = (value) => zlib.deflateSync(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')).toString('base64');

const TMB = {
  wishlists: {
    28770: ['thornwick|1|1|1', 'mendra|2|1|1', 'quillfeather|1|2|1', 'Mendra|2|1|1'],
    30311: ['aldric||3||1||1', 'thornwick-nightslayer|2|1|0'],
    29000: ['quillfeather|4|2|1'],           // a wishlist on an item nobody has a prio on: left out
    31000: ['zed|?|1|1', 'a|1|1|1', 'thorn3wick|1|1|1', 'brindle|abc|2|1'],
    x: ['aldric|1|1|1'],
  },
  groups: { 1: 'Main' }, notes: { 28770: 'bis' }, tiers: {}, loot: 'text',
};

check('TMB: base64 + zlib JSON becomes prio and wishlist rows (both entry forms, a realm suffix, "?" order, duplicates, a wishlist on an item with no prio left out)', async () => {
  const r = await G.tmb.parse(encode(TMB));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows, 12, 'every entry string that was looked at');
  assert.deepEqual(plain(r.entries), [
    { name: 'Thornwick', itemId: 28770, kind: 'prio', prio: 1 },
    { name: 'Mendra', itemId: 28770, kind: 'prio', prio: 2 },
    { name: 'Quillfeather', itemId: 28770, kind: 'wish', prio: 1 },
    { name: 'Aldric', itemId: 30311, kind: 'prio', prio: 3 },
    { name: 'Thornwick', itemId: 30311, kind: 'prio', prio: 2 },
    { name: 'Zed', itemId: 31000, kind: 'prio', prio: null },
    { name: 'Brindle', itemId: 31000, kind: 'wish', prio: null },
  ]);
  assert.deepEqual(plain(r.stats), { items: 3, characters: 6, prio: 5, wish: 2, wishLeftOut: 1 });
  assert.deepEqual(plain(r.skipped).map((s) => [s.label, s.reason]), [['item 31000', 'Name is not a character name'], ['item 31000', 'Name is not a character name'], ['item x', 'Item ID is not valid']]);
  assert.equal(r.skippedCount, 3);
});

check('TMB: a wrapped paste, raw JSON and a leading byte-order mark all read; a text that is not an export says what to paste', async () => {
  const text = encode(TMB);
  const wrapped = text.replace(/(.{40})/g, '$1\r\n  ');
  for (const variant of [wrapped, `\uFEFF${text}\n`, JSON.stringify(TMB)]) {
    const r = await G.tmb.parse(variant);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.entries.length, 7);
  }
  const bad = async (input, pattern) => {
    const r = await G.tmb.parse(input);
    assert.equal(r.ok, false, String(input).slice(0, 40));
    assert.match(r.error, pattern, String(input).slice(0, 40));
    assert.deepEqual(plain(r.entries), []);
  };
  await bad('', /Paste the TMB export first/);
  await bad('   ', /Paste the TMB export first/);
  await bad(null, /Paste the TMB export first/);
  await bad('hello world, this is not it!', /not a TMB export/);
  await bad(Buffer.from('plain text, not zlib at all').toString('base64'), /not a TMB export/);
  await bad(encode('this is text, not json'), /not valid data/);
  await bad(encode({ nothing: true }), /No wishlists were found/);
  await bad(encode({ wishlists: [] }), /No wishlists were found/);
  await bad('{"wishlists": {', /not valid data/);
  await bad('x'.repeat(8 * 1024 * 1024 + 1), /larger than 8 MB/);
});

check('TMB: too many rows are refused with a count; an export that unpacks far larger than any real one is refused (a zip bomb)', async () => {
  const many = {};
  for (let item = 1; item <= 60; item++) many[item] = Array.from({ length: 100 }, (_, i) => `${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}x|${i + 1}|1|1`);
  const r = await G.tmb.parse(encode({ wishlists: many }));
  assert.equal(r.ok, false);
  assert.match(r.error, /6000 rows; at most 5000/);
  const bomb = await G.tmb.parse(zlib.deflateSync(Buffer.alloc(45 * 1024 * 1024)).toString('base64'));
  assert.equal(bomb.ok, false);
  assert.match(bomb.error, /far larger/);
});

check('TMB: the rows pass the Worker\'s own validation', async () => {
  const { readListRows } = await import(pathToFileURL(path.join(ROOT, 'worker/loot-board.js')).href);
  const r = await G.tmb.parse(encode(TMB));
  const stored = readListRows('tmb', plain(r.entries));
  assert.equal(stored.length, 7);
  assert.deepEqual(stored.map((row) => row.nameKey), ['thornwick', 'mendra', 'quillfeather', 'aldric', 'thornwick', 'zed', 'brindle']);
});

const SOFTRES = {
  metadata: { id: 'abc123', url: 'https://softres.it/raid/abc123', createdAt: 1, updatedAt: 2, hidden: false },
  softreserves: [
    { name: 'Pugone', class: 'Mage', note: '', plusOnes: 0, items: [{ id: 28770 }, { id: 28770 }, { id: 30311, name: ' Some Sword ' }, { id: 0 }, { id: 'x' }] },
    { name: 'thornwick', class: 'Warrior', items: [{ id: 28770 }] },
    { name: 'R2', class: 'Mage', items: [{ id: 1 }] },
    { name: 'Nolist', class: 'Mage' },
    { name: 'Manycopy', class: 'Rogue', items: Array.from({ length: 25 }, () => ({ id: 777 })) },
  ],
  hardreserves: [{ id: 5, for: 'Guildbank', note: '' }, { id: 0 }, { id: 6 }],
  bonusrolls: [],
};

check('softres: copies are counted per item, names normalized, bad players reported, hard-reserves counted', async () => {
  const r = await G.softres.parse(encode(SOFTRES));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows, 5);
  assert.deepEqual(plain(r.entries), [
    { name: 'Pugone', itemId: 28770, copies: 2 },
    { name: 'Pugone', itemId: 30311, copies: 1, itemName: 'Some Sword' },
    { name: 'Thornwick', itemId: 28770, copies: 1 },
    { name: 'Manycopy', itemId: 777, copies: 20 },
  ]);
  assert.deepEqual(plain(r.stats), { items: 3, characters: 3, reserves: 24, hardReserves: 2 });
  assert.deepEqual(plain(r.skipped).map((s) => [s.label, s.reason]), [['player 3', 'Name is not a character name'], ['player 4', 'No list of items']]);
  const wrapped = await G.softres.parse(encode(SOFTRES).replace(/(.{30})/g, '$1\n'));
  assert.equal(wrapped.ok, true);
  const raw = await G.softres.parse(JSON.stringify(SOFTRES));
  assert.equal(raw.entries.length, 4);
});

check('softres: bad pastes explain what to paste, and the rows pass the Worker\'s validation', async () => {
  const bad = async (input, pattern) => {
    const r = await G.softres.parse(input);
    assert.equal(r.ok, false);
    assert.match(r.error, pattern);
  };
  await bad('', /Paste the softres.it export first/);
  await bad('not an export at all!', /not a softres.it export/);
  await bad(encode({ metadata: { id: 'x' } }), /No soft-reserves were found/);
  await bad(encode({ softreserves: 'x' }), /No soft-reserves were found/);
  const { readListRows } = await import(pathToFileURL(path.join(ROOT, 'worker/loot-board.js')).href);
  const r = await G.softres.parse(encode(SOFTRES));
  const stored = readListRows('softres', plain(r.entries));
  assert.deepEqual(stored.map((row) => [row.nameKey, row.itemId, row.copies, row.itemName]), [['pugone', 28770, 2, null], ['pugone', 30311, 1, 'Some Sword'], ['thornwick', 28770, 1, null], ['manycopy', 777, 20, null]]);
});

check('item reference: an id, a Wowhead link of any shape, a chat item link; anything else is nothing', () => {
  const ref = (text) => plain(G.gargul.parseItemRef(text));
  assert.deepEqual(ref('28770'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('  28770  '), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('https://www.wowhead.com/tbc/item=28770/nathrezim-mindblade'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('https://www.wowhead.com/classic/item=19019'), { itemId: 19019, itemName: null });
  assert.deepEqual(ref('wowhead.com/item=28770'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('https://www.wowhead.com/tbc/item/28770/nathrezim-mindblade'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('https://www.wowhead.com/tbc/item=28770#comments'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('https://www.wowhead.com/?item=28770'), { itemId: 28770, itemName: null });
  assert.deepEqual(ref('|cffa335ee|Hitem:28770::::::::70:::::::|h[Nathrezim Mindblade]|h|r'), { itemId: 28770, itemName: 'Nathrezim Mindblade' });
  for (const text of ['', '   ', 'a sword', '0', '-5', '99999999999', 'https://www.wowhead.com/tbc/spell=1234', 'https://www.wowhead.com/tbc/item=', null, undefined, 5]) assert.equal(G.gargul.parseItemRef(text), null, String(text));
});

main().catch((error) => { console.error(error); process.exit(1); });
