/**
 * Raidsmith - PM wave 8, Planner side: WoW Forever two-part character names ("Thrall Stormrage") survive the Planner (tests)
 * Run: node wave8-planner-tests.js
 *
 * A Forever character may have a first name and a surname, so a name with a space has to ride through everything that carries names: a Raid-Helper import,
 * the share code (PP:2, base64url) and its player list for the guild tracker, the v1 addon string, a saved roster, the MRT export, the chat text, and a plain
 * pasted roster. The guild tracker's side (the plan route, the plan reader) is in guild-wave8-worker-tests.js and guild-wave8-ui-tests.js.
 * These drive the pure half in a vm sandbox (the same loader as the other suites).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const Scenarios = require('./scenarios.js');

// The browser's own base64 helpers: the sandbox has none.
const globals = {
  btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
  atob: (text) => Buffer.from(text, 'base64').toString('binary'),
  escape: global.escape, unescape: global.unescape,
};
const ctx = app.sandbox(['State', 'Config', 'Import', 'Optimizer'], { globals });
const { State, Import } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
}

const NAMES = ['Thrall Stormrage', 'Jaina Proudmoore', 'Arthas', 'Sylvanas Windrunner', 'Kael Thas'];
function reset(version = 'forever', raid = 'f_ony') {
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
  State.rosterName = 'Wave 8'; State.planId = null; State.notes = '';
}
const seated = () => [...State.groups.flat(), ...State.bench].map(p => p.name).sort();

function importNames(names) {
  reset();
  const keys = ['destro', 'destro', 'destro', 'destro', 'destro'];
  const signUps = names.map((name, i) => Scenarios.signUp(keys[i % keys.length], name, undefined, i + 1));
  const result = Import.importRaidHelper(JSON.stringify({ title: 'Wave 8', signUps }));
  assert(result.success, JSON.stringify(result));
}

check('a Raid-Helper import keeps a name with a space as it is, in a group or on the bench', () => {
  importNames(NAMES);
  assert.deepEqual(seated(), [...NAMES].sort());
  assert(State.groups.flat().some(p => p.name === 'Thrall Stormrage'));
});

check('the share string holds names raw (a space is no delimiter); the guild tracker\'s player list and a full load read them back', () => {
  importNames(NAMES);
  const shared = Import.exportShareString();
  assert(shared.includes('Thrall Stormrage.WL.'), 'raw in the string');
  assert(!shared.includes('%20Stormrage'), 'not percent-encoded just for a space');
  const read = plain(Import.readSharePlayers(shared));
  assert.equal(read.success, true, JSON.stringify(read));
  assert.deepEqual(read.players.map(p => p.name).sort(), [...NAMES].sort());
  assert.deepEqual(read.players.find(p => p.name === 'Kael Thas').groupNumber >= 0, true);
  // Through the link's own base64url code and back.
  const code = Import.encodeSharePayload(shared);
  assert(/^[A-Za-z0-9_-]+$/.test(code));
  assert.equal(Import.decodeSharePayload(code), shared);
  // Loading it replaces the roster and the names come out the same.
  const before = seated();
  reset();
  const loaded = Import.importAddonString(Import.decodeSharePayload(code));
  assert.equal(loaded.success, true, JSON.stringify(loaded));
  assert.deepEqual(seated(), before);
});

check('a name with a delimiter AND a space is percent-encoded together and still round-trips', () => {
  importNames(['Thrall Stormrage', 'Dot.Name Here', 'Plain']);
  const shared = Import.exportShareString();
  assert(shared.includes('Thrall%20Stormrage'), 'every name is encoded once one has a delimiter');
  const read = plain(Import.readSharePlayers(shared));
  assert.deepEqual(read.players.map(p => p.name).sort(), ['Dot.Name Here', 'Plain', 'Thrall Stormrage']);
});

check('the v1 addon string (still read) carries a name with a space', () => {
  reset();
  const loaded = Import.importAddonString('PP:1:f_ony:Thrall Stormrage.WR.Fury.M,Jaina Proudmoore.MA.Fire.C:Arthas.PR.Holy.H');
  assert.equal(loaded.success, true, JSON.stringify(loaded));
  assert.deepEqual(seated(), ['Arthas', 'Jaina Proudmoore', 'Thrall Stormrage']);
});

check('the MRT export puts a name with a space between its quotes, once, in its own slot', () => {
  importNames(NAMES);
  const mrt = Import.exportMrtString();
  assert(mrt.startsWith('MRTRGR0'));
  const payload = decodePrint(mrt.slice('MRTRGR0'.length));
  assert(payload.startsWith('0,{') && payload.endsWith('}'), payload);
  for (const name of NAMES) assert.equal(payload.split(`"${name}"`).length - 1, 1, `${name} once`);
  assert.match(payload, /\[\d+\]="Thrall Stormrage"/);
});

check('the chat text prints a name with a space as it is', () => {
  importNames(NAMES);
  const chat = Import.exportChatText({});
  const lines = Array.isArray(chat) ? chat.join('\n') : String(chat);
  assert(lines.includes('Thrall Stormrage'), lines.slice(0, 200));
});

check('a saved roster (exportRoster -> loadRoster) keeps the names', () => {
  importNames(NAMES);
  const data = plain(Import.exportRoster('Wave 8'));
  reset();
  Import.loadRoster(data);
  assert.deepEqual(seated(), [...NAMES].sort());
});

check('a plain pasted roster reads "First Surname Class Spec" on a Forever ruleset and still reads "Name Class Spec" everywhere else', () => {
  const parse = (text, version) => Import.parsePlainRoster(text, version);
  const forever = parse('Thrall Stormrage Shaman Enhancement\nJaina Proudmoore - Mage Fire\nArthas Menethil,Priest,Holy\nKael Thas Mage Frost\nAldric Warrior Fury', 'forever');
  assert.deepEqual(plain(forever.entries.map(e => [e.name, e.class, e.spec])), [
    ['Thrall Stormrage', 'SHAMAN', 'Enhancement'], ['Jaina Proudmoore', 'MAGE', 'Fire'], ['Arthas Menethil', 'PRIEST', 'Holy'], ['Kael Thas', 'MAGE', 'Frost'], ['Aldric', 'WARRIOR', 'Fury'],
  ]);
  assert.equal(forever.unparsed.length, 0);
  // A class or a spec after the first word is never swallowed into the name.
  assert.equal(parse('Aldric Fury Warrior', 'forever').entries[0].name, 'Aldric');
  // TBC and Classic: the first word is the name, as before.
  assert.equal(parse('Thrall Stormrage Shaman Enhancement', 'tbc').entries[0].name, 'Thrall');
  assert.equal(parse('Thrall Stormrage Shaman Enhancement', 'classic').entries[0].name, 'Thrall');
});

// A test-local port of LibDeflate:DecodeForPrint, independent of the encoder in js/import.js (the same one mrt-tests.js uses).
function decodePrint(str) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
  const val = c => alphabet.indexOf(c);
  const out = [];
  let i = 0;
  while (i + 4 <= str.length) {
    const x = [0, 1, 2, 3].map(k => val(str[i + k]));
    i += 4;
    let cache = x[0] + x[1] * 64 + x[2] * 4096 + x[3] * 262144;
    const b1 = cache % 256; cache = (cache - b1) / 256;
    const b2 = cache % 256; const b3 = (cache - b2) / 256;
    out.push(b1, b2, b3);
  }
  let cache = 0, bits = 0;
  while (i < str.length) { cache += val(str[i]) * Math.pow(2, bits); bits += 6; i++; }
  while (bits >= 8) { const b = cache % 256; out.push(b); cache = (cache - b) / 256; bits -= 8; }
  return Buffer.from(out).toString('utf8');
}

console.log(`\nWave 8 Planner tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
