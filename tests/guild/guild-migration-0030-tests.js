/**
 * Raidsmith guild tracker - migration 0030 tests (core ranks + proof/identity columns + characters rebuild)
 * Run: node tests/guild/guild-migration-0030-tests.js
 *
 * Builds a database at migration 0029, seeds people of every status / left_reason with mains, alts and sign-ups linked to characters,
 * applies migrations/0030_core_ranks.sql on the node:sqlite D1 stand-in (foreign keys ON) and checks counts, links, ranks, left_on /
 * left_reason, trial dates, the proof and identity-key columns, the nullable team and the core_ranks foreign key. Then it stops the file
 * after every statement group of the rebuild, runs the whole file again on a fresh database and compares the outcome with a clean run
 * (the documented rerun behaviour in the file header).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createD1Fake } = require('../d1-fake');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const MIGRATION_0030 = fs.readFileSync(path.join(MIGRATIONS, '0030_core_ranks.sql'), 'utf8');

const exec = (db, sql) => db.sqlite.exec(sql);
const rows = (db, sql) => db.sqlite.prepare(sql).all().map((row) => ({ ...row }));
const one = (db, sql) => Object.values(db.sqlite.prepare(sql).get())[0];

function worldAt0029() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0030-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0030')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

// person id, status, left_reason, left_on, trial_start, trial_end
const PEOPLE = [
  ['p_raider', 'raider', null, null, null, null],
  ['p_trial', 'trial', null, null, '2026-10-01', '2026-10-15'],
  ['p_reserve', 'reserve', null, null, null, null],
  ['p_left', 'inactive', 'left', '2026-09-20', null, null],
  ['p_kicked', 'inactive', 'kicked', '2026-09-21', null, null],
  ['p_break', 'inactive', 'break', '2026-09-22', null, null],
  ['p_other', 'inactive', 'other', null, null, null],
  ['p_noreason', 'inactive', null, null, null, null],
];

function seed(db) {
  exec(db, `INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
            VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  exec(db, `INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)`);
  exec(db, `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r1', 'g1', 't1', '2026-10-10', 1000, 1, 1), ('r2', 'g1', 't1', '2026-10-11', 2000, 1, 1)`);
  const q = (v) => (v === null ? 'NULL' : `'${v}'`);
  for (const [id, status, reason, leftOn, ts, te] of PEOPLE) {
    exec(db, `INSERT INTO players (id, guild_id, status, left_reason, left_on, trial_start, trial_end, created_at, updated_at)
              VALUES ('${id}', 'g1', '${status}', ${q(reason)}, ${q(leftOn)}, ${q(ts)}, ${q(te)}, 1, 1)`);
    exec(db, `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
              VALUES ('${id}_main', 'g1', '${id}', 't1', 'M${id}', 'm${id}', 'MAGE', 1, 5, 6),
                     ('${id}_alt', 'g1', '${id}', 't1', 'A${id}', 'a${id}', 'ROGUE', 0, 5, 6)`);
  }
  PEOPLE.forEach(([id], i) => {
    exec(db, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, character_id)
              VALUES ('r1', 'raidsmith', ${i + 1}, 'signed', ${i}, 'g1', '${id}', '${id}_${i % 2 ? 'alt' : 'main'}')`);
  });
  exec(db, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('r2', 'raidsmith', 100, 'signed', 50, 'g1', 'p_raider')`);
  exec(db, `INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at)
            VALUES ('sg_1', 'g1', 't1', 'p_raider', 2, 'signed', 'p_raider_alt', 1, 1),
                   ('sg_2', 'g1', 't1', 'p_trial', 2, 'late', NULL, 1, 1)`);
}

const CHAR_COLUMNS = 'id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at';
const NEW_COLUMNS = [
  'id', 'guild_id', 'player_id', 'team_id', 'name', 'name_key', 'realm', 'realm_key', 'class', 'main_spec', 'off_spec', 'is_main', 'created_at', 'updated_at',
  'core_rank', 'left_on', 'left_reason', 'trial_start', 'trial_end', 'owner_proof', 'proof_user_id', 'proof_bnet_account_id', 'proof_at',
  'namespace', 'blizzard_char_id', 'blizzard_realm_id',
];
const db = worldAt0029();
seed(db);
const tableNames = (d = db) => rows(d, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
const countsBefore = Object.fromEntries(tableNames().map((t) => [t, one(db, `SELECT COUNT(*) FROM ${t}`)]));
const sigBefore = rows(db, 'SELECT raid_id, source, signup_id, character_id FROM raid_signups ORDER BY signup_id');
const stdBefore = rows(db, 'SELECT id, character_id FROM standing_signups ORDER BY id');
const charsBefore = rows(db, `SELECT ${CHAR_COLUMNS} FROM characters ORDER BY id`);
exec(db, MIGRATION_0030);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('row counts of every pre-existing table are unchanged, side tables are gone', () => {
  for (const [table, n] of Object.entries(countsBefore)) assert.equal(one(db, `SELECT COUNT(*) FROM ${table}`), n, table);
  assert.deepEqual(tableNames().filter((t) => t.startsWith('_')), []);
});
check('existing character columns are identical', () => {
  assert.deepEqual(rows(db, `SELECT ${CHAR_COLUMNS} FROM characters ORDER BY id`), charsBefore);
});
check('characters has exactly the amended columns: no source_rank_key', () => {
  assert.deepEqual(rows(db, 'PRAGMA table_info(characters)').map((r) => r.name), NEW_COLUMNS);
});
check('every raid_signups and standing_signups character link is restored', () => {
  assert.deepEqual(rows(db, 'SELECT raid_id, source, signup_id, character_id FROM raid_signups ORDER BY signup_id'), sigBefore);
  assert.deepEqual(rows(db, 'SELECT id, character_id FROM standing_signups ORDER BY id'), stdBefore);
  assert.equal(sigBefore.filter((r) => r.character_id).length, 8);
  assert.equal(stdBefore.filter((r) => r.character_id).length, 1);
});
check('core_ranks holds only id, label, sort and the four rows', () => {
  assert.deepEqual(rows(db, 'PRAGMA table_info(core_ranks)').map((r) => r.name), ['id', 'label', 'sort']);
  assert.deepEqual(rows(db, 'SELECT id, label, sort FROM core_ranks ORDER BY sort'), [
    { id: 'raider', label: 'Raider', sort: 1 },
    { id: 'trial', label: 'Trial', sort: 2 },
    { id: 'reserve', label: 'Reserve', sort: 3 },
    { id: 'social', label: 'Social', sort: 4 },
  ]);
});
check('core_rank backfill covers every character of the person', () => {
  const want = { p_raider: 'raider', p_trial: 'trial', p_reserve: 'reserve', p_left: 'social', p_kicked: 'social', p_break: 'social', p_other: 'social', p_noreason: 'social' };
  const all = rows(db, 'SELECT player_id, core_rank FROM characters');
  assert.equal(all.length, 16);
  for (const r of all) assert.equal(r.core_rank, want[r.player_id], r.player_id);
});
check('left_on and left_reason only for left / kicked, copied from players', () => {
  const got = Object.fromEntries(rows(db, 'SELECT id, left_on, left_reason FROM characters WHERE is_main = 1').map((r) => [r.id, r]));
  assert.deepEqual(got.p_left_main, { id: 'p_left_main', left_on: '2026-09-20', left_reason: 'left' });
  assert.deepEqual(got.p_kicked_main, { id: 'p_kicked_main', left_on: '2026-09-21', left_reason: 'kicked' });
  for (const k of ['p_break_main', 'p_other_main', 'p_noreason_main', 'p_raider_main', 'p_trial_main']) {
    assert.equal(got[k].left_on, null, k);
    assert.equal(got[k].left_reason, null, k);
  }
  assert.equal(one(db, 'SELECT COUNT(*) FROM characters WHERE left_on IS NOT NULL'), 4, 'both characters of the two leavers');
  assert.equal(one(db, 'SELECT COUNT(*) FROM characters WHERE left_reason IS NOT NULL'), 4);
});
check('left_reason keeps the players.left_reason CHECK', () => {
  assert.throws(() => exec(db, "UPDATE characters SET left_reason = 'gone' WHERE id = 'p_raider_main'"), /CHECK/);
  exec(db, "UPDATE characters SET left_reason = 'break' WHERE id = 'p_raider_main'");
  exec(db, "UPDATE characters SET left_reason = NULL WHERE id = 'p_raider_main'");
});
check('trial dates land on the main character of a trial person only', () => {
  assert.deepEqual(rows(db, "SELECT trial_start, trial_end FROM characters WHERE id = 'p_trial_main'"), [{ trial_start: '2026-10-01', trial_end: '2026-10-15' }]);
  assert.equal(one(db, 'SELECT COUNT(*) FROM characters WHERE trial_start IS NOT NULL OR trial_end IS NOT NULL'), 1);
});
check('owner_proof is officer on every existing row, the other proof and identity columns are NULL', () => {
  assert.equal(one(db, "SELECT COUNT(*) FROM characters WHERE owner_proof = 'officer'"), 16);
  assert.equal(one(db, `SELECT COUNT(*) FROM characters WHERE proof_user_id IS NOT NULL OR proof_bnet_account_id IS NOT NULL OR proof_at IS NOT NULL
                          OR namespace IS NOT NULL OR blizzard_char_id IS NOT NULL OR blizzard_realm_id IS NOT NULL`), 0);
});
check('owner_proof is nullable, DEFAULT officer for old writers, CHECK bnet|officer|hand', () => {
  exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c_old', 'g1', 'p_raider', 't1', 'Old', 'old', 'MAGE', 1, 1)");
  assert.equal(one(db, "SELECT owner_proof FROM characters WHERE id = 'c_old'"), 'officer');
  for (const v of ['bnet', 'hand', 'officer']) exec(db, `UPDATE characters SET owner_proof = '${v}' WHERE id = 'c_old'`);
  exec(db, "UPDATE characters SET owner_proof = NULL WHERE id = 'c_old'");
  assert.equal(one(db, "SELECT owner_proof IS NULL FROM characters WHERE id = 'c_old'"), 1);
  assert.throws(() => exec(db, "UPDATE characters SET owner_proof = 'discord' WHERE id = 'c_old'"), /CHECK/);
  exec(db, "DELETE FROM characters WHERE id = 'c_old'");
});
check('proof_user_id is a foreign key to users that SETs NULL on delete', () => {
  exec(db, "INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES ('u_proof', 'ak_proof', 'U', 1, 1)");
  assert.throws(() => exec(db, "UPDATE characters SET proof_user_id = 'nobody' WHERE id = 'p_raider_main'"), /FOREIGN KEY/);
  exec(db, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = 'u_proof', proof_bnet_account_id = 'b1', proof_at = 5 WHERE id = 'p_raider_main'");
  exec(db, "DELETE FROM users WHERE id = 'u_proof'");
  assert.deepEqual(rows(db, "SELECT owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters WHERE id = 'p_raider_main'"),
    [{ owner_proof: 'bnet', proof_user_id: null, proof_bnet_account_id: 'b1', proof_at: 5 }]);
  exec(db, "UPDATE characters SET owner_proof = 'officer', proof_bnet_account_id = NULL, proof_at = NULL WHERE id = 'p_raider_main'");
});
check('identity key columns exist, accept integers, and no identity unique index exists yet (0031 owns it)', () => {
  exec(db, "UPDATE characters SET namespace = 'profile-classicann-us', blizzard_char_id = 11, blizzard_realm_id = 22 WHERE id IN ('p_raider_main', 'p_raider_alt')");
  assert.equal(one(db, "SELECT COUNT(*) FROM characters WHERE blizzard_char_id = 11"), 2, 'no unique index on the identity key');
  exec(db, "UPDATE characters SET namespace = NULL, blizzard_char_id = NULL, blizzard_realm_id = NULL WHERE id IN ('p_raider_main', 'p_raider_alt')");
  const idx = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'characters'");
  assert.equal(idx.filter((r) => /blizzard|namespace/.test(r.sql || '')).length, 0);
});
check('team_id accepts NULL, DEFAULT core_rank keeps current writers working, composite team FK still bites', () => {
  exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c_free', 'g1', 'p_raider', NULL, 'Free', 'free', 'MAGE', 1, 1)");
  assert.equal(one(db, "SELECT core_rank FROM characters WHERE id = 'c_free'"), 'raider');
  assert.throws(() => exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c_bad', 'g1', 'p_raider', 'nope', 'Bad', 'bad', 'MAGE', 1, 1)"), /FOREIGN KEY/);
  assert.throws(() => exec(db, "DELETE FROM teams WHERE id = 't1'"), /FOREIGN KEY/);
});
check('core_rank is a foreign key to core_ranks, not an enum', () => {
  assert.throws(() => exec(db, "UPDATE characters SET core_rank = 'nope' WHERE id = 'p_raider_main'"), /FOREIGN KEY/);
  exec(db, "INSERT INTO core_ranks (id, label, sort) VALUES ('guest', 'Guest', 9)");
  exec(db, "UPDATE characters SET core_rank = 'guest' WHERE id = 'p_raider_main'");
});
check('indexes, triggers and referencing FKs survive the rebuild', () => {
  const idx = rows(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'characters'").map((r) => r.name);
  for (const n of ['characters_guild_name', 'characters_one_main', 'characters_player', 'characters_team', 'characters_unassigned', 'characters_core_rank']) assert.ok(idx.includes(n), n);
  assert.throws(() => exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at) VALUES ('c_main2', 'g1', 'p_raider', 't1', 'Two', 'two', 'MAGE', 1, 1, 1)"), /UNIQUE/);
  const tr = rows(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'characters'").map((r) => r.name).sort();
  assert.deepEqual(tr, ['characters_cap', 'characters_guild_cap']);
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  exec(db, "DELETE FROM characters WHERE id = 'p_raider_alt'");
  assert.equal(one(db, "SELECT character_id FROM standing_signups WHERE id = 'sg_1'"), null, 'SET NULL still works');
});

// ---- rerun safety (the file header documents each case) ----
const snapshot = (d) => JSON.stringify({
  characters: rows(d, 'SELECT * FROM characters ORDER BY id'),
  sig: rows(d, 'SELECT raid_id, source, signup_id, character_id FROM raid_signups ORDER BY raid_id, source, signup_id'),
  std: rows(d, 'SELECT id, character_id FROM standing_signups ORDER BY id'),
  cores: rows(d, 'SELECT * FROM core_ranks ORDER BY sort'),
  schema: rows(d, "SELECT type, name FROM sqlite_master WHERE tbl_name IN ('characters', 'core_ranks') ORDER BY type, name"),
  tables: tableNames(d).sort(),
  fk: rows(d, 'PRAGMA foreign_key_check'),
});
function freshWorld() {
  const d = worldAt0029();
  seed(d);
  return d;
}
const cleanSnapshot = (() => { const d = freshWorld(); exec(d, MIGRATION_0030); return snapshot(d); })();
const STOPS = [
  ['after the core_ranks rows', /\('social',\s*'Social',\s*4\);/],
  ['after CREATE TABLE _sig_char', /PRIMARY KEY \(raid_id, source, signup_id\)\s*\);/],
  ['after the _sig_char fill', /NOT EXISTS \(SELECT 1 FROM _sig_char\);/],
  ['after the _std_char fill', /NOT EXISTS \(SELECT 1 FROM _std_char\);/],
  ['after CREATE TABLE characters_new', /trial_end >= trial_start\)\s*\);/],
  ['after the copy into characters_new', /FROM characters c JOIN players p ON p\.id = c\.player_id;/],
  ['after the RENAME', /ALTER TABLE characters_new RENAME TO characters;/],
  ['after the indexes', /characters_core_rank ON characters\(guild_id, core_rank\);/],
  ['after the triggers', /'guild_characters_cap'\); END;/],
  ['after the link restore', /WHERE EXISTS \(SELECT 1 FROM _std_char s WHERE s\.id = standing_signups\.id\);/],
  ['after DROP of _sig_char', /DROP TABLE IF EXISTS _sig_char;/],
  ['after DROP of _std_char', /DROP TABLE IF EXISTS _std_char;/],
];
const endOf = (re) => { const m = MIGRATION_0030.match(re); assert.ok(m, String(re)); return m.index + m[0].length; };

check('a rerun of the whole file after a complete run gives the same result', () => {
  const d = freshWorld();
  exec(d, MIGRATION_0030);
  exec(d, MIGRATION_0030);
  assert.equal(snapshot(d), cleanSnapshot);
});
for (const [label, re] of STOPS) {
  check(`stop ${label}, then rerun the whole file: same result as a clean run`, () => {
    const d = freshWorld();
    exec(d, MIGRATION_0030.slice(0, endOf(re)));
    exec(d, MIGRATION_0030);
    assert.equal(snapshot(d), cleanSnapshot);
  });
}
check('stop right after DROP TABLE characters: the rerun fails changing nothing, the saved links survive, the tail finishes it', () => {
  const d = freshWorld();
  const stop = endOf(/DROP TABLE characters;/);
  exec(d, MIGRATION_0030.slice(0, stop));
  assert.equal(one(d, 'SELECT COUNT(*) FROM raid_signups WHERE character_id IS NOT NULL'), 0, 'DROP nulled the links');
  const before = { sig: one(d, 'SELECT COUNT(*) FROM _sig_char'), std: one(d, 'SELECT COUNT(*) FROM _std_char'), copy: one(d, 'SELECT COUNT(*) FROM characters_new') };
  assert.deepEqual(before, { sig: 8, std: 1, copy: 16 });
  assert.throws(() => exec(d, MIGRATION_0030), /no such table: characters/);
  assert.deepEqual({ sig: one(d, 'SELECT COUNT(*) FROM _sig_char'), std: one(d, 'SELECT COUNT(*) FROM _std_char'), copy: one(d, 'SELECT COUNT(*) FROM characters_new') }, before, 'side tables not overwritten');
  exec(d, MIGRATION_0030.slice(stop));
  assert.equal(snapshot(d), cleanSnapshot);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of checks) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
