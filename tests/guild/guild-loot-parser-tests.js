/**
 * Raidsmith guild, Phase 4 (loot) - tests for js/guild/gargul.js, the parser of Gargul's "Detailed (JSON)" export.
 * Run: node tests/guild/guild-loot-parser-tests.js
 *
 * The parser is pure: it is loaded alone in a vm with no DOM. tests/fixtures/gargul-detailed-sample.json is a hand-made
 * export in the shape Gargul v8.0.1 writes (field names confirmed against the source, see the header of gargul.js):
 * 15 entries over two raid days with invented names and realms. JSON cannot carry a comment, so the source reference
 * of the fixture is this note: entries follow Classes/Exporter.lua getLootEntries(raw) and Classes/AwardedLoot.lua
 * addWinner of https://github.com/papa-smurf/Gargul at 7cc1fc1713ca74375398c36fb48d4dca2c7d32a6 (tag v8.0.1).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SOURCE = read('js/guild/gargul.js');
const sandbox = { console, JSON, Math, Date, Object, Array, String, Number, RegExp };
vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox, { filename: 'js/guild/gargul.js' });
const P = sandbox.Guild.gargul;
const plain = v => JSON.parse(JSON.stringify(v));
const FIXTURE_TEXT = read('tests/fixtures/gargul-detailed-sample.json');
const FIXTURE = JSON.parse(FIXTURE_TEXT);
const BOM = String.fromCharCode(0xFEFF);
const CHECKSUM = '74190331205118463999';
const LINK = id => '|cffa335ee|Hitem:' + id + '::::::::70:::::::|h[Warp Slicer]|h|r';

// A minimal good entry; each test overrides what it probes.
function entry(over) {
  return Object.assign({ checksum: CHECKSUM, itemLink: LINK(30311), itemID: 30311, awardedTo: 'Thoren-Ashmere', awardedBy: 'Lead-Ashmere', timestamp: 1791681160, winnerClass: 2, OS: false, SR: false, WL: false, PL: false, TMB: false, winningRollType: 'MS' }, over || {});
}
const one = (over, wrap) => P.parse(JSON.stringify(wrap ? wrap([entry(over)]) : [entry(over)]));

check('source: the header names Gargul, the commit and the files the field names came from', () => {
  assert(SOURCE.includes('papa-smurf/Gargul') && SOURCE.includes('7cc1fc1713ca74375398c36fb48d4dca2c7d32a6') && SOURCE.includes('v8.0.1'));
  assert(SOURCE.includes('Classes/Exporter.lua') && SOURCE.includes('Classes/AwardedLoot.lua'));
  assert(/winnerClass is a NUMBER/.test(SOURCE) && /epoch SECONDS/.test(SOURCE) && /20-digit/.test(SOURCE), 'the facts that corrected the plan notes are recorded');
});

check('fixture: 15 entries, two raid days, every flag, a realm-less name, one entry without a checksum, one disenchant', () => {
  assert.equal(FIXTURE.length, 15);
  assert(Array.isArray(FIXTURE), 'a bare array, like the real export');
  for (const f of ['OS', 'SR', 'WL', 'PL', 'TMB']) assert(FIXTURE.some(e => e[f] === true), f);
  assert(FIXTURE.some(e => e.awardedTo === 'Ruvik'), 'realm-less name');
  assert.equal(FIXTURE.filter(e => !e.checksum).length, 1);
  assert(FIXTURE.some(e => e.awardedTo === '||de||'));
  const days = new Set(FIXTURE.map(e => new Date(e.timestamp * 1000 - 5 * 3600 * 1000).toISOString().slice(0, 10)));
  assert.deepEqual([...days].sort(), ['2026-10-10', '2026-10-11'], 'two raid days in Central time');
  assert(FIXTURE.every(e => Object.keys(e).every(k => /^[A-Za-z]+$/.test(k))), 'camelCase / upper case keys like Gargul writes');
});

check('fixture: parses to 14 awards (one of them a disenchant) and 1 skipped row with its reason', () => {
  const r = P.parse(FIXTURE_TEXT);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 15);
  assert.equal(r.awards.length, 14);
  assert.deepEqual(plain(r.skipped.map(s => [s.index, s.reason])), [[9, 'Missing checksum']]);
  assert(r.skipped[0].label.includes('Eye of Gruul') && r.skipped[0].label.includes('Halric-Ashmere'));
  assert.deepEqual(plain(r.awardRows), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15], 'the disenchant keeps its row number (14)');
});

check('fixture: the first award is fully normalized (seconds to ms, link to name and quality, class number to name)', () => {
  const a = P.parse(FIXTURE_TEXT).awards[0];
  assert.deepEqual(plain(a), {
    checksum: '74190331205118463920', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1791681160000,
    winnerName: 'Thoren', winnerRealm: 'Ashmere', winnerClass: 'PALADIN', disenchanted: false, rollType: 'MS', flags: ['PL', 'TMB'], awardedBy: 'Lootmaster-Ashmere',
  });
});

check('disenchant: awardedTo "||de||" becomes an award with no winner and disenchanted true (Gargul\'s PRIEST class fallback is dropped)', () => {
  const r = P.parse(FIXTURE_TEXT);
  const de = r.awards.find(a => a.checksum === '74190331205118463934');
  assert.deepEqual(plain(de), {
    checksum: '74190331205118463934', itemId: 22520, itemName: 'The Phylactery of Kel\'Thuzad', quality: 4, awardedAt: 1791774300000,
    winnerName: null, winnerRealm: null, winnerClass: null, disenchanted: true, rollType: null, flags: [], awardedBy: 'Lootmaster-Ashmere',
  });
  assert.equal(r.awards.filter(a => a.disenchanted).length, 1, 'only the ||de|| row');
  assert(r.awards.filter(a => !a.disenchanted).every(a => typeof a.winnerName === 'string' && a.winnerClass !== undefined), 'every other award keeps its winner');
  const spaced = one({ awardedTo: '  ||de||  ', winnerClass: 5, OS: true, winningRollType: undefined });
  assert.equal(spaced.awards.length, 1);
  assert.deepEqual(plain([spaced.awards[0].winnerName, spaced.awards[0].winnerRealm, spaced.awards[0].winnerClass, spaced.awards[0].disenchanted, spaced.awards[0].flags]), [null, null, null, true, ['OS']], 'flags are kept as Gargul wrote them');
  assert.equal(one({ awardedTo: 'Thoren-Ashmere' }).awards[0].disenchanted, false, 'a normal award says so');
  assert.equal(one({ awardedTo: '||DE||' }).awards.length, 0, 'the mark is exactly ||de||; anything else must be a character name');
  assert.equal(one({ awardedTo: '||de||' }).skipped.length, 0);
});

check('disenchant: the other row checks still apply (checksum, item and time are needed; a duplicate checksum is reported)', () => {
  const reason = over => one(Object.assign({ awardedTo: '||de||' }, over)).skipped.map(s => s.reason)[0];
  assert.equal(reason({ checksum: undefined }), 'Missing checksum');
  assert.equal(reason({ itemID: undefined, itemLink: undefined }), 'Missing item ID');
  assert.equal(reason({ timestamp: undefined }), 'Missing or invalid award time');
  const dup = P.parse(JSON.stringify([entry({ awardedTo: '||de||' }), entry({ awardedTo: 'Thoren-Ashmere' })]));
  assert.deepEqual(plain(dup.skipped.map(s => [s.index, s.reason])), [[2, 'Duplicate checksum in this paste']]);
  assert.equal(dup.awards[0].disenchanted, true, 'the first one stays');
});

check('fixture: flags, qualities, classes, realm-less and other-realm winners come through', () => {
  const awards = P.parse(FIXTURE_TEXT).awards;
  const by = n => awards.find(a => a.winnerName === n);
  assert.deepEqual(plain(by('Dorrin').flags), ['OS']);
  assert.equal(by('Dorrin').rollType, 'OS');
  assert.deepEqual(plain(by('Kaelith').flags), ['SR']);
  assert.deepEqual(plain(by('Brogan').flags), ['WL', 'TMB']);
  assert.deepEqual(plain(by('Ysolde').flags), ['SR', 'PL', 'TMB']);
  assert.equal(by('Ruvik').winnerRealm, null);
  assert.equal(by('Tarn').winnerRealm, 'Brightfen');
  assert.equal(by('Veyla').quality, 3, 'a rare');
  assert.equal(by('Nimue').quality, 5, 'a legendary');
  assert.equal(by('Ruvik').winnerClass, 'SHAMAN');
  assert(awards.every(a => a.awardedAt > 1.79e12 && a.awardedAt < 1.80e12));
  assert.equal(new Set(awards.map(a => a.checksum)).size, 14, 'checksums are unique');
});

check('fixture: every award has exactly the keys of the Worker contract', () => {
  const keys = ['awardedAt', 'awardedBy', 'checksum', 'disenchanted', 'flags', 'itemId', 'itemName', 'quality', 'rollType', 'winnerClass', 'winnerName', 'winnerRealm'];
  for (const a of P.parse(FIXTURE_TEXT).awards) assert.deepEqual(Object.keys(a).sort(), keys);
});

check('input: a BOM, surrounding whitespace and pretty printing are fine', () => {
  const r = P.parse(BOM + '\n\n  ' + FIXTURE_TEXT + '  \n');
  assert.equal(r.ok, true);
  assert.equal(r.awards.length, 14);
  assert.equal(P.parse(JSON.stringify(FIXTURE)).awards.length, 14, 'compact too (Gargul writes it on one line)');
});

check('input: an object holding the array, a keyed AwardHistory table, a single array property', () => {
  const rows = [entry({ checksum: 'AAAAAAAA11' }), entry({ checksum: 'BBBBBBBB22' })];
  for (const key of ['awards', 'entries', 'loot', 'data', 'AwardHistory']) {
    const o = {}; o[key] = rows;
    assert.equal(P.parse(JSON.stringify(o)).awards.length, 2, key);
  }
  assert.equal(P.parse(JSON.stringify({ version: 1, whatever: rows })).awards.length, 2, 'one array of objects');
  const keyed = {}; keyed.CCCCCCCC33 = entry({ checksum: undefined }); keyed.DDDDDDDD44 = entry({ checksum: undefined });
  const r = P.parse(JSON.stringify(keyed));
  assert.deepEqual(plain(r.awards.map(a => a.checksum)), ['CCCCCCCC33', 'DDDDDDDD44'], 'the key is the checksum in Gargul\'s own table');
});

check('input: text that is not an export gives a readable error and no awards', () => {
  const bad = ['', '   ', 'dateTime,character,itemID,offspec,id\n2026-10-10,Thoren,28770,0,123', '{ not json', '"just a string"', '42', '{}', '{"a":1,"b":2}', 'null'];
  for (const text of bad) {
    const r = P.parse(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert(r.error && r.error.length > 10 && r.awards.length === 0, text);
  }
  assert(/Detailed \(JSON\)/.test(P.parse('a,b,c').error), 'names the setting to change');
  assert.equal(P.parse(undefined).ok, false);
  assert.equal(P.parse(12).ok, false);
  assert.equal(P.parse('x'.repeat(P.MAX_FILE_CHARS + 1)).ok, false, 'over the size cap');
});

check('input: an empty list parses with nothing in it; non-object rows are skipped', () => {
  const r = P.parse('[]');
  assert.deepEqual(plain(r), { ok: true, error: null, rows: 0, awards: [], awardRows: [], skipped: [] });
  const s = P.parse(JSON.stringify([1, 'a', null, [], entry()]));
  assert.equal(s.awards.length, 1);
  assert.deepEqual(plain(s.skipped.map(x => [x.index, x.reason])), [[1, 'Not an award entry'], [2, 'Not an award entry'], [3, 'Not an award entry'], [4, 'Not an award entry']]);
});

check('rows: missing or malformed checksum, item, winner and time are skipped with a reason, checks in a fixed order', () => {
  const reason = over => one(over).skipped.map(s => s.reason)[0];
  assert.equal(reason({ checksum: undefined }), 'Missing checksum');
  assert.equal(reason({ checksum: '' }), 'Missing checksum');
  assert.equal(reason({ checksum: null }), 'Missing checksum');
  assert(/8 to 40/.test(reason({ checksum: 'short' })));
  assert(/8 to 40/.test(reason({ checksum: 'has a space in it 12345' })));
  assert(/8 to 40/.test(reason({ checksum: 'x'.repeat(41) })));
  assert(/8 to 40/.test(reason({ checksum: 74190331205118463920 })), 'a number loses digits: not accepted');
  assert.equal(reason({ itemID: undefined, itemLink: undefined }), 'Missing item ID');
  assert.equal(reason({ itemID: 0, itemLink: 'garbage' }), 'Missing item ID');
  assert.equal(reason({ itemID: -4, itemLink: undefined }), 'Missing item ID');
  assert.equal(reason({ itemID: 1.5, itemLink: undefined }), 'Missing item ID');
  assert.equal(reason({ awardedTo: undefined }), 'Missing winner');
  assert.equal(reason({ awardedTo: '   ' }), 'Missing winner');
  assert.equal(reason({ awardedTo: 42 }), 'Missing winner');
  assert.equal(reason({ awardedTo: 'R2D2-Ashmere' }), 'Winner name is not a character name');
  assert.equal(reason({ timestamp: undefined }), 'Missing or invalid award time');
  assert.equal(reason({ timestamp: 'soon' }), 'Missing or invalid award time');
  assert.equal(reason({ timestamp: -5 }), 'Missing or invalid award time');
  assert.equal(reason({ timestamp: 1000 }), 'Missing or invalid award time', 'before the game existed');
  assert.equal(reason({ checksum: undefined, itemID: undefined, awardedTo: undefined }), 'Missing checksum', 'the first problem wins');
});

check('rows: the Worker\'s own limits are applied here, so one bad row never fails a whole request', () => {
  const ok = over => one(over).awards.length === 1;
  assert(ok({ checksum: 'abcdefgh' }) && ok({ checksum: 'x'.repeat(40) }) && ok({ checksum: 'A-b_c.d~e!f#' }), 'printable ASCII, 8 to 40');
  assert(!ok({ checksum: 'abcdefg' }) && !ok({ checksum: 'x'.repeat(41) }) && !ok({ checksum: 'abcdefgh\u00e9' }) && !ok({ checksum: 'abcd efgh' }));
  assert.equal(one({ checksum: '  abcdefgh\t' }).awards[0].checksum, 'abcdefgh', 'surrounding whitespace is trimmed, never sent');
  assert(ok({ itemID: 2147483647, itemLink: undefined }) && !ok({ itemID: 2147483648, itemLink: undefined }));
  assert.equal(one({ awardedTo: 'Thoren-()' }).awards[0].winnerRealm, null, 'a realm with no key is read as no realm (the guild realm), not refused');
  assert.equal(one({ awardedTo: 'Thoren-Dun Morogh' }).awards[0].winnerRealm, 'Dun Morogh');
  const bad = P.parse(JSON.stringify([entry({ checksum: 'AAAAAAAA01' }), entry({ checksum: 'x' }), entry({ checksum: 'AAAAAAAA03' })]));
  assert.deepEqual(plain(bad.awardRows), [1, 3], 'the row number of each award, for naming a row the Worker refuses');
  assert.equal(bad.awards.length, bad.awardRows.length);
  for (const a of P.parse(FIXTURE_TEXT).awards) {
    assert(Number.isInteger(a.awardedAt) && Number.isInteger(a.itemId) && (a.quality === null || Number.isInteger(a.quality)) && Array.isArray(a.flags));
    if (a.disenchanted) assert(a.winnerName === null && a.winnerRealm === null && a.winnerClass === null, 'a disenchant has no winner at all');
    else assert(/^[A-Z]+$/.test(a.winnerClass) && a.winnerName.length >= 2 && a.winnerName.length <= 12);
    assert((a.itemName || '').length <= 100 && (a.rollType || '').length <= 24 && (a.awardedBy || '').length <= 64);
  }
});

check('rows: a duplicate checksum inside the paste keeps the first and reports the rest', () => {
  const r = P.parse(JSON.stringify([entry({ itemID: 1, itemLink: undefined }), entry({ itemID: 2, itemLink: undefined }), entry({ checksum: 'ZZZZZZZZ99' })]));
  assert.equal(r.awards.length, 2);
  assert.equal(r.awards[0].itemId, 1);
  assert.deepEqual(plain(r.skipped.map(s => [s.index, s.reason])), [[2, 'Duplicate checksum in this paste']]);
});

check('item: id from itemID (number or digits), else from the link; name and quality from the link colour', () => {
  assert.equal(one({ itemID: '30311' }).awards[0].itemId, 30311);
  const linkOnly = one({ itemID: undefined }).awards[0];
  assert.equal(linkOnly.itemId, 30311);
  assert.equal(linkOnly.itemName, 'Warp Slicer');
  const idOnly = one({ itemLink: undefined }).awards[0];
  assert.equal(idOnly.itemName, null);
  assert.equal(idOnly.quality, null);
  const colours = { '9d9d9d': 0, 'ffffff': 1, '1eff00': 2, '0070dd': 3, 'a335ee': 4, 'ff8000': 5, 'e6cc80': 6, '00ccff': 7 };
  for (const [c, q] of Object.entries(colours)) {
    assert.equal(P.parseItemLink('|cff' + c + '|Hitem:5::::::::70:::::::|h[X]|h|r').quality, q, c);
  }
  assert.equal(P.parseItemLink('|cff123456|Hitem:5|h[X]|h|r').quality, null, 'an unknown colour');
  assert.equal(P.parseItemLink('|CFFA335EE|Hitem:5|h[X]|h|r').quality, 4, 'upper case hex');
});

check('item: links copied through chat (doubled pipes) and odd names still parse; the name is cleaned and capped', () => {
  const doubled = P.parseItemLink('||cffa335ee||Hitem:28770::::::::70:::::::||h[Nathrezim Mindblade]||h||r');
  assert.deepEqual(plain(doubled), { itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 });
  const long = P.parseItemLink('|cffa335ee|Hitem:9|h[' + 'N'.repeat(150) + ']|h|r');
  assert.equal(long.itemName.length, 100);
  const ctl = P.parseItemLink('|cffa335ee|Hitem:9|h[Bad' + String.fromCharCode(7) + 'Name]|h|r');
  assert.equal(ctl.itemName, 'BadName');
  assert.equal(P.parseItemLink('[Warp Slicer]'), null);
  assert.equal(P.parseItemLink(null), null);
  assert.equal(P.parseItemLink(42), null);
  assert.equal(P.parseItemLink('|cffa335ee|Hitem:abc|h[X]|h|r'), null);
});

check('winner: Name-Realm split at the first hyphen, display-case name, realm kept as sent, realm-less is null', () => {
  assert.deepEqual(plain(P.parseWinner('Thoren-Ashmere')), { name: 'Thoren', realm: 'Ashmere' });
  assert.deepEqual(plain(P.parseWinner('tHOREN-ashmere')), { name: 'Thoren', realm: 'ashmere' });
  assert.deepEqual(plain(P.parseWinner('Ruvik')), { name: 'Ruvik', realm: null });
  assert.deepEqual(plain(P.parseWinner('Ruvik-')), { name: 'Ruvik', realm: null });
  assert.deepEqual(plain(P.parseWinner('  Ruvik-Azjol-Nerub ')), { name: 'Ruvik', realm: 'Azjol-Nerub' }, 'the rest after the first hyphen is the realm');
  assert.deepEqual(plain(P.parseWinner('Sølhand-Ashmere')), { name: 'Sølhand', realm: 'Ashmere' });
  assert.deepEqual(plain(P.parseWinner('Ælfric')), { name: 'Ælfric', realm: null });
  for (const bad of ['A-Ashmere', 'Thirteenletter-X', 'Ba d', "O'Neil", 'R2D2', '-Ashmere', '', 42, null]) assert.equal(P.parseWinner(bad), null, String(bad));
  assert.equal(one({ awardedTo: 'ruvik' }).awards[0].winnerRealm, null);
});

check('class: the number Gargul writes becomes the class id; names work too; anything else is null', () => {
  const cls = v => one({ winnerClass: v }).awards[0].winnerClass;
  const expected = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' };
  for (const [n, name] of Object.entries(expected)) assert.equal(cls(Number(n)), name, n);
  assert.equal(cls('11'), 'DRUID');
  assert.equal(cls('mage'), 'MAGE');
  assert.equal(cls(' Warlock '), 'WARLOCK');
  for (const other of [6, 10, 12, 13, 0, 99, 'DEATHKNIGHT', 'bard', null, undefined, {}]) assert.equal(cls(other), null, String(other));
});

check('time: epoch seconds become ms; a value already in ms is kept; digits as text work; junk is skipped', () => {
  const at = v => one({ timestamp: v }).awards[0].awardedAt;
  assert.equal(at(1791681160), 1791681160000);
  assert.equal(at('1791681160'), 1791681160000);
  assert.equal(at(1791681160000), 1791681160000);
  assert.equal(at(1791681160.4), 1791681160400);
  assert.equal(one({ timestamp: 4102444800000 }).awards.length, 1, '2100-01-01 is the last accepted instant, like the Worker');
  assert.equal(one({ timestamp: 4102444800001 }).awards.length, 0, 'after it');
  assert.equal(one({ timestamp: Date.UTC(2004, 10, 22) / 1000 }).awards.length, 0, 'the day before the game');
  assert.equal(one({ timestamp: Date.UTC(2004, 10, 23) / 1000 }).awards.length, 1);
  assert.equal(one({ timestamp: null }).awards.length, 0);
});

check('flags: true, 1, "1" and "true" count; false, 0, absent and unknown flags do not; order is fixed', () => {
  assert.deepEqual(plain(one({ TMB: true, OS: 1, SR: '1', WL: 'true', PL: true }).awards[0].flags), ['OS', 'SR', 'WL', 'PL', 'TMB']);
  assert.deepEqual(plain(one({ OS: false, SR: 0, WL: '0', PL: null, TMB: undefined, BR: true, GDKP: true }).awards[0].flags), []);
  assert.deepEqual(plain(one({ PL: true }).awards[0].flags), ['PL']);
});

check('roll type and awarded by: trimmed and capped; "-" and empty are null; a bonus roll without a type is named', () => {
  const a = over => one(over).awards[0];
  assert.equal(a({ winningRollType: '-' }).rollType, null);
  assert.equal(a({ winningRollType: '  ' }).rollType, null);
  assert.equal(a({ winningRollType: undefined }).rollType, null);
  assert.equal(a({ winningRollType: 'x'.repeat(40) }).rollType.length, 24);
  assert.equal(a({ winningRollType: undefined, isBonusLoot: true }).rollType, 'Bonus Roll');
  assert.equal(a({ winningRollType: 'Bonus Roll', isBonusLoot: true }).rollType, 'Bonus Roll');
  assert.equal(a({ awardedBy: undefined }).awardedBy, null);
  assert.equal(a({ awardedBy: 'y'.repeat(100) }).awardedBy.length, 64);
  assert.equal(a({ awardedBy: 7 }).awardedBy, null);
});

check('unknown fields are ignored and the parser never mutates what it read', () => {
  const extra = entry({ Rolls: [{ player: 'x', amount: 1 }], GDKPCost: 5, whatever: { deep: [1, 2, 3] }, itemGUID: 'Item-1' });
  const before = JSON.stringify(extra);
  const r = P.parse(JSON.stringify([extra]));
  assert.equal(r.awards.length, 1);
  assert.equal(JSON.stringify(extra), before);
});

check('chunk: requests of at most 500, in order, nothing dropped', () => {
  const list = Array.from({ length: 1201 }, (_, i) => i);
  const parts = P.chunk(list, P.MAX_PER_REQUEST);
  assert.deepEqual(plain(parts.map(p => p.length)), [500, 500, 201]);
  assert.deepEqual(plain([].concat(...parts)), list);
  assert.deepEqual(plain(P.chunk([], 500)), []);
  assert.equal(P.chunk(list.slice(0, 500)).length, 1);
  assert.equal(P.MAX_PER_REQUEST, 500);
});

check('safety: gargul.js is ASCII only in code, touches no DOM and runs alone', () => {
  SOURCE.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    assert(!/[^\x00-\x7f]/.test(line), `gargul.js:${i + 1} non-ASCII`);
  });
  const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\}\)\(typeof window[^\n]*/, '');
  assert(!/\bdocument\b|\bwindow\b|innerHTML|fetch\(/.test(code), 'no DOM or network');
  assert(sandbox.Guild.gargul && Object.keys(sandbox.Guild).join() === 'gargul', 'only G.gargul is added');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
