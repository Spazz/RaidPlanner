/**
 * Raidsmith guild tracker - migration 0036 tests (user-hierarchy build, release R4: retired placeholders do not count, a person delete does not walk its guild)
 * Run: node tests/guild/guild-migration-0036-tests.js
 *
 * Builds a database at migration 0035 (the schema the previous release runs on), seeds a populated world with retired placeholders (`~ph:` name keys), applies
 * migrations/0036_character_visibility.sql on the node:sqlite D1 stand-in (foreign keys ON) and checks: nothing but one index and three triggers changed (no table,
 * column or row), the new characters_cap (visible characters only; a placeholder is never refused; 20 visible characters are still the limit), the two placeholder-Main
 * triggers (an insert into a person whose only Main is a placeholder takes the Main, in the order the unique index needs; nothing else is touched), the query plan of a
 * person delete (the cascade finds the person's own characters through characters_guild_player instead of walking the guild), that the previous release's statements
 * still work on the new schema, PRAGMA foreign_key_check, that the file is rerunnable and that the rollback in its header restores the old trigger.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const FILE = '0036_character_visibility.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8').split(/\r?\n/).join('\n');

const exec = (db, sql) => db.sqlite.exec(sql);
const rows = (db, sql, ...values) => db.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
const one = (db, sql, ...values) => Object.values(db.sqlite.prepare(sql).get(...values))[0];
const fails = (db, sql, pattern) => assert.throws(() => exec(db, sql), pattern);

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The database release R3 runs on: every migration before 0036.
function worldAt0035() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0036-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0036')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

let counter = 0;
// A character row, named columns only (the way every writer of the previous release inserts).
function character(db, { id, person, guild = 'g1', name = null, isMain = 0, placeholder = false }) {
  counter++;
  const key = placeholder ? `~ph:${id}` : (name || `nm${counter}`).toLowerCase();
  exec(db, `INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank)
            VALUES ('${id}', '${guild}', '${person}', '${name || `Nm${counter}`}', '${key}', 'Realm', 'realm', 'MAGE', ${isMain}, 1, 1, '${placeholder ? 'social' : 'raider'}')`);
}
function person(db, id, guild = 'g1') {
  exec(db, `INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('${id}', '${guild}', 'raider', 1, 1)`);
}
const mainsOf = (db, personId) => rows(db, 'SELECT id FROM characters WHERE player_id = ? AND is_main = 1 ORDER BY id', personId).map((row) => row.id);

function seed(db) {
  exec(db, `
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES
      ('g1', 'G1', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1),
      ('g2', 'G2', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1);
  `);
  for (const [guild, id] of [['g1', 'p_full'], ['g1', 'p_ph'], ['g1', 'p_vis'], ['g1', 'p_none'], ['g1', 'p_other'], ['g2', 'p_g2']]) person(db, id, guild);
  // p_ph: a placeholder Main + one visible alt; p_vis: a visible Main + a placeholder; p_full: 20 visible characters; p_none: no Main at all; p_g2: another guild.
  character(db, { id: 'c_ph', person: 'p_ph', placeholder: true, isMain: 1 });
  character(db, { id: 'c_ph_alt', person: 'p_ph', name: 'Phalt' });
  character(db, { id: 'c_vis', person: 'p_vis', name: 'Vismain', isMain: 1 });
  character(db, { id: 'c_vis_ph', person: 'p_vis', placeholder: true });
  for (let i = 0; i < 20; i++) character(db, { id: `c_full${i}`, person: 'p_full', name: `Full${String.fromCharCode(97 + i)}`, isMain: i === 0 ? 1 : 0 });
  character(db, { id: 'c_none', person: 'p_none', name: 'Nomain' });
  character(db, { id: 'c_g2', person: 'p_g2', guild: 'g2', name: 'Gtwo', isMain: 1 });
}

const schemaOf = (db) => JSON.stringify(rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
const before = worldAt0035();
seed(before);
const db = worldAt0035();
seed(db);
const schemaBefore = rows(db, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").map((row) => `${row.type}:${row.name}`);
const dumpBefore = JSON.stringify(rows(db, 'SELECT * FROM characters ORDER BY id'));
const countsBefore = Object.fromEntries(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((row) => [row.name, one(db, `SELECT COUNT(*) FROM ${row.name}`)]));
const planBefore = rows(db, "EXPLAIN QUERY PLAN DELETE FROM players WHERE id = 'p_none' AND guild_id = 'g1'").map((row) => row.detail);
const capBefore = rows(db, "SELECT sql FROM sqlite_master WHERE name = 'characters_cap'")[0].sql;
exec(db, MIGRATION);

check('only three triggers and one index appear (characters_cap is replaced): no table, no column, no row changes', () => {
  const after = rows(db, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").map((row) => `${row.type}:${row.name}`);
  assert.deepEqual(after.filter((entry) => !schemaBefore.includes(entry)).sort(),
    ['index:characters_guild_player', 'trigger:characters_placeholder_main_after', 'trigger:characters_placeholder_main_before']);
  assert.deepEqual(schemaBefore.filter((entry) => !after.includes(entry)), [], 'nothing was dropped (characters_cap is recreated under its name)');
  assert.equal(JSON.stringify(rows(db, 'SELECT * FROM characters ORDER BY id')), dumpBefore, 'no row changed');
  for (const [table, n] of Object.entries(countsBefore)) assert.equal(one(db, `SELECT COUNT(*) FROM ${table}`), n, table);
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  assert.notEqual(rows(db, "SELECT sql FROM sqlite_master WHERE name = 'characters_cap'")[0].sql, capBefore, 'characters_cap was rewritten');
  assert.deepEqual(rows(db, "SELECT name FROM pragma_index_info('characters_guild_player') ORDER BY seqno").map((row) => row.name), ['guild_id', 'player_id']);
});

check('characters_cap counts the visible characters only: placeholders use up none of the 20, a placeholder is never refused, 20 visible characters are still the limit', () => {
  // p_ph: 1 visible + 1 placeholder. Fill it to 19 visible characters, then 5 placeholders on top: the 20th visible one still fits, the 21st does not.
  for (let i = 0; i < 18; i++) character(db, { id: `c_ph_fill${i}`, person: 'p_ph', name: `Phfill${String.fromCharCode(97 + i)}` });
  for (let i = 0; i < 5; i++) character(db, { id: `c_ph_more${i}`, person: 'p_ph', placeholder: true });
  assert.equal(one(db, "SELECT COUNT(*) FROM characters WHERE player_id = 'p_ph'"), 25, '25 rows, 19 of them visible');
  character(db, { id: 'c_ph_20th', person: 'p_ph', name: 'Phtwentieth' });
  fails(db, "INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at) VALUES ('c_ph_21st', 'g1', 'p_ph', 'X', 'phtwentyfirst', 'R', 'r', 'MAGE', 0, 1, 1)", /character_limit/);
  // A placeholder is not refused even at 20 visible characters (a re-home leaves one behind on a full person).
  character(db, { id: 'c_ph_late', person: 'p_ph', placeholder: true });
  // A person of 20 ordinary rows is refused at the 21st exactly as before.
  fails(db, "INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at) VALUES ('c_full_x', 'g1', 'p_full', 'Y', 'fullx', 'R', 'r', 'MAGE', 0, 1, 1)", /character_limit/);
  // The guild cap is unchanged.
  assert.equal(rows(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'characters' AND name = 'characters_guild_cap'").length, 1);
});

check('a character inserted into a person whose only Main is a placeholder becomes the Main and the placeholder steps down - for an insert with is_main = 1 (before) and 0 (after)', () => {
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  // is_main = 0: the usual insert of an alt.
  person(d, 'p_a');
  character(d, { id: 'c_a_ph', person: 'p_a', placeholder: true, isMain: 1 });
  character(d, { id: 'c_a_new', person: 'p_a', name: 'Anew', isMain: 0 });
  assert.deepEqual(mainsOf(d, 'p_a'), ['c_a_new'], 'the new character is the Main');
  assert.equal(one(d, "SELECT is_main FROM characters WHERE id = 'c_a_ph'"), 0, 'the placeholder gave it up');
  // is_main = 1: the unique index would reject it without the BEFORE trigger.
  person(d, 'p_b');
  character(d, { id: 'c_b_ph', person: 'p_b', placeholder: true, isMain: 1 });
  character(d, { id: 'c_b_new', person: 'p_b', name: 'Bnew', isMain: 1 });
  assert.deepEqual(mainsOf(d, 'p_b'), ['c_b_new']);
  // Several in one statement: the first takes the Main once, the others stay alts.
  person(d, 'p_c');
  character(d, { id: 'c_c_ph', person: 'p_c', placeholder: true, isMain: 1 });
  exec(d, `INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at)
           VALUES ('c_c_1', 'g1', 'p_c', 'Cone', 'cone', 'R', 'r', 'MAGE', 0, 1, 1), ('c_c_2', 'g1', 'p_c', 'Ctwo', 'ctwo', 'R', 'r', 'MAGE', 0, 1, 1),
                  ('c_c_3', 'g1', 'p_c', 'Cthree', 'cthree', 'R', 'r', 'MAGE', 0, 1, 1)`);
  assert.deepEqual(mainsOf(d, 'p_c'), ['c_c_1'], 'exactly one Main, the first inserted');
  // The migration's own order in a batch, as the sign-in match writes it: demote the placeholder explicitly, then insert the Main (a no-op for the trigger).
  person(d, 'p_d');
  character(d, { id: 'c_d_ph', person: 'p_d', placeholder: true, isMain: 1 });
  exec(d, "UPDATE characters SET is_main = 0 WHERE player_id = 'p_d' AND is_main = 1 AND substr(name_key, 1, 4) = '~ph:'");
  character(d, { id: 'c_d_new', person: 'p_d', name: 'Dnew', isMain: 1 });
  assert.deepEqual(mainsOf(d, 'p_d'), ['c_d_new']);
});

check('nothing else is touched: a person with a visible Main, a person with no Main, an insert of a placeholder, a person of another guild and the other people\'s Mains stay as they are', () => {
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  const mains = () => JSON.stringify(rows(d, 'SELECT id, player_id, is_main FROM characters ORDER BY id'));
  const start = mains();
  // A visible Main with a placeholder on the side: a new alt stays an alt.
  character(d, { id: 'c_vis_alt', person: 'p_vis', name: 'Visalt' });
  assert.deepEqual(mainsOf(d, 'p_vis'), ['c_vis']);
  // A person with no Main at all keeps having none: the trigger is for the placeholder-Main case only.
  character(d, { id: 'c_none_alt', person: 'p_none', name: 'Nonealt' });
  assert.deepEqual(mainsOf(d, 'p_none'), []);
  // A placeholder inserted next to a placeholder Main (re-home) does not take the Main.
  character(d, { id: 'c_ph_second', person: 'p_ph', placeholder: true });
  assert.deepEqual(mainsOf(d, 'p_ph'), ['c_ph']);
  // Another person of another guild is untouched, and every other row is as it was.
  assert.deepEqual(mainsOf(d, 'p_g2'), ['c_g2']);
  const delta = JSON.parse(mains()).filter((row) => !JSON.parse(start).some((old) => old.id === row.id));
  assert.deepEqual(delta.map((row) => [row.id, row.is_main]), [['c_none_alt', 0], ['c_ph_second', 0], ['c_vis_alt', 0]]);
  for (const old of JSON.parse(start)) assert.equal(JSON.parse(mains()).find((row) => row.id === old.id).is_main, old.is_main, old.id);
  // A person with a placeholder Main that already has a VISIBLE alt (seeded before the migration): an update leaves it alone; only an INSERT triggers.
  assert.deepEqual(mainsOf(d, 'p_ph'), ['c_ph']);
  assert.equal(one(d, "SELECT is_main FROM characters WHERE id = 'c_ph_alt'"), 0);
});

check('deleting a person: the cascade finds its characters through characters_guild_player - before the migration it searched the whole guild (characters_guild_id)', () => {
  const search = (plan) => plan.filter((detail) => /SEARCH characters USING (COVERING )?INDEX/.test(detail));
  assert(search(planBefore).some((detail) => /characters_guild_id \(guild_id=\?\)/.test(detail)), `before: ${planBefore.join(' | ')}`);
  const after = rows(db, "EXPLAIN QUERY PLAN DELETE FROM players WHERE id = 'p_none' AND guild_id = 'g1'").map((row) => row.detail);
  assert(search(after).some((detail) => /characters_guild_player \(guild_id=\? AND player_id=\?\)/.test(detail)), `after: ${after.join(' | ')}`);
  assert(!search(after).some((detail) => /characters_guild_id/.test(detail)), 'no walk of the guild any more');
  // And it still cascades.
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  exec(d, "DELETE FROM players WHERE id = 'p_full' AND guild_id = 'g1'");
  assert.equal(one(d, "SELECT COUNT(*) FROM characters WHERE player_id = 'p_full'"), 0);
  assert.equal(one(d, "SELECT COUNT(*) FROM characters WHERE player_id = 'p_g2'"), 1, 'another guild untouched');
});

check('the previous release\'s statements still work on the new schema: its character INSERT (named columns), the Main swap, a delete of a character and of a person, the cap of 20', () => {
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  person(d, 'p_old');
  // The way routes/roster.js of the previous release adds a person with a Main and an alt.
  exec(d, `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at, core_rank, owner_proof)
           VALUES ('c_old1', 'g1', 'p_old', NULL, 'Oldone', 'oldone', 'Realm', 'realm', 'MAGE', 'Fire', NULL, 1, 5, 5, 'raider', 'officer'),
                  ('c_old2', 'g1', 'p_old', NULL, 'Oldtwo', 'oldtwo', 'Realm', 'realm', 'ROGUE', NULL, NULL, 0, 5, 5, 'raider', 'officer')`);
  exec(d, "UPDATE characters SET is_main = 0 WHERE id = 'c_old1'");
  exec(d, "UPDATE characters SET is_main = 1 WHERE id = 'c_old2'");
  assert.deepEqual(mainsOf(d, 'p_old'), ['c_old2']);
  exec(d, "DELETE FROM characters WHERE id = 'c_old1'");
  for (let i = 0; i < 19; i++) character(d, { id: `c_old_f${i}`, person: 'p_old', name: `Oldfill${String.fromCharCode(97 + i)}` });
  fails(d, "INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at) VALUES ('c_old_x', 'g1', 'p_old', 'X', 'oldx', 'R', 'r', 'MAGE', 0, 1, 1)", /character_limit/);
  exec(d, "DELETE FROM players WHERE id = 'p_old'");
  assert.equal(one(d, "SELECT COUNT(*) FROM characters WHERE player_id = 'p_old'"), 0);
  assert.deepEqual(rows(d, 'PRAGMA foreign_key_check'), []);
});

check('rerun: the whole file is harmless a second time (the trigger is recreated, the rest is IF NOT EXISTS) and changes neither schema nor data', () => {
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  const schemaOnce = schemaOf(d);
  const dataOnce = JSON.stringify(rows(d, 'SELECT * FROM characters ORDER BY id'));
  exec(d, MIGRATION);
  exec(d, MIGRATION);
  assert.equal(schemaOf(d), schemaOnce);
  assert.equal(JSON.stringify(rows(d, 'SELECT * FROM characters ORDER BY id')), dataOnce);
  for (const statement of MIGRATION.split('\n').filter((line) => /^(CREATE|DROP)/.test(line))) {
    assert(/^(DROP TRIGGER IF EXISTS|CREATE TRIGGER( IF NOT EXISTS)?|CREATE INDEX IF NOT EXISTS)/.test(statement), `not rerunnable: ${statement}`);
  }
  const code = MIGRATION.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  assert(!/CREATE TABLE|ALTER TABLE|DROP TABLE|DELETE FROM|INSERT INTO/.test(code), 'triggers and one index, no table work');
});

check('the rollback in the header restores the old characters_cap and drops the rest; the migration then applies again', () => {
  const d = worldAt0035();
  seed(d);
  exec(d, MIGRATION);
  const lines = MIGRATION.split('\n');
  const start = lines.findIndex((line) => line.startsWith('-- ROLLBACK:'));
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('--'));
  const rollback = lines.slice(start + 1, end).map((line) => line.replace(/^--\s?/, ''));
  const script = rollback.join('\n');
  assert(/DROP INDEX IF EXISTS characters_guild_player;/.test(script) && /CREATE TRIGGER characters_cap/.test(script), script);
  exec(d, script);
  const names = rows(d, "SELECT name FROM sqlite_master WHERE name LIKE 'characters_%'").map((row) => row.name);
  assert(!names.includes('characters_guild_player') && !names.includes('characters_placeholder_main_before') && !names.includes('characters_placeholder_main_after'), names.join(','));
  const restored = rows(d, "SELECT sql FROM sqlite_master WHERE name = 'characters_cap'")[0].sql.replace(/\s+/g, ' ');
  assert.equal(restored, capBefore.replace(/\s+/g, ' '), 'the old trigger, word for word');
  exec(d, MIGRATION);
  assert.equal(rows(d, "SELECT name FROM sqlite_master WHERE name = 'characters_guild_player'").length, 1);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
