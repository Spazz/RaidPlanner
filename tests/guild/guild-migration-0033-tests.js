/**
 * Raidsmith guild tracker - migration 0033 tests (user-hierarchy build, lane B3, release R3: team requests, open raids, the scheduler index)
 * Run: node tests/guild/guild-migration-0033-tests.js
 *
 * Builds a database at migration 0032 (the schema release R2 runs on), seeds a populated world, applies migrations/0033_team_requests_open_raids.sql
 * on the node:sqlite D1 stand-in (foreign keys ON) and checks: the new columns and their defaults and CHECKs, the team_requests table (CHECKs, the
 * one-open-request index, the composite tenant keys, every cascade, the FKs to users ON DELETE SET NULL), the one-sign-up-per-account index, the
 * partial scheduler index and that the due query uses it, that the statements of release R2 still work on the new schema (its INSERTs name their
 * columns; the team, character, person, guild and account deletes it runs), PRAGMA foreign_key_check, and that the tail of the file is rerunnable.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const FILE = '0033_team_requests_open_raids.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8').split(/\r?\n/).join('\n');

const exec = (db, sql) => db.sqlite.exec(sql);
const rows = (db, sql) => db.sqlite.prepare(sql).all().map((row) => ({ ...row }));
const one = (db, sql) => Object.values(db.sqlite.prepare(sql).get())[0];
const columns = (db, table) => rows(db, `PRAGMA table_info(${table})`);
const fails = (db, sql, pattern) => assert.throws(() => exec(db, sql), pattern);

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The database release R2 runs on: every migration before 0033.
function worldAt0032() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0033-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0033')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

function seed(db) {
  exec(db, `
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES
      ('g1', 'G1', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1),
      ('g2', 'G2', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1);
    INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1), ('t1b', 'g1', 'T1b', 25, 0, 1), ('t2', 'g2', 'T2', 25, 0, 1);
    INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES
      ('u_a', 'ak1', '110000000000000001', 'A', 100, 900), ('u_b', 'ak2', '110000000000000002', 'B', 200, 900);
    INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p1', 'g1', 'raider', 'u_a', 1, 1), ('p2', 'g1', 'raider', NULL, 1, 1), ('p3', 'g2', 'raider', NULL, 1, 1);
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at) VALUES
      ('c1', 'g1', 'p1', 't1', 'One', 'one', 'MAGE', 1, 1, 1),
      ('c1b', 'g1', 'p1', NULL, 'OneAlt', 'onealt', 'ROGUE', 0, 1, 1),
      ('c2', 'g1', 'p2', 't1', 'Two', 'two', 'MAGE', 1, 1, 1),
      ('c3', 'g2', 'p3', 't2', 'Three', 'three', 'MAGE', 1, 1, 1);
    INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES
      ('r1', 'g1', 't1', '2026-10-10', 1000, 1, 1), ('r2', 'g1', 't1', '2026-10-17', 2000, 1, 1);
    INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('r1', 'raidsmith', 1, 'signed', 0, 'g1', 'p1');
  `);
}

function migrated() {
  const db = worldAt0032();
  seed(db);
  const before = {
    raids: rows(db, 'SELECT * FROM raids ORDER BY id'),
    signups: rows(db, 'SELECT * FROM raid_signups ORDER BY raid_id, signup_id'),
    guilds: one(db, 'SELECT COUNT(*) FROM guilds'),
  };
  exec(db, MIGRATION);
  return { db, before };
}

check('the new columns: raids.guests_open (0/1, DEFAULT 0, NOT NULL) and raid_signups.guest_user_id (nullable FK to users); existing rows keep every old value', () => {
  const { db, before } = migrated();
  const opens = columns(db, 'raids').find((c) => c.name === 'guests_open');
  assert.deepEqual([opens.type, opens.notnull, opens.dflt_value], ['INTEGER', 1, '0']);
  const guest = columns(db, 'raid_signups').find((c) => c.name === 'guest_user_id');
  assert.deepEqual([guest.type, guest.notnull, guest.dflt_value], ['TEXT', 0, null]);
  const raids = rows(db, 'SELECT * FROM raids ORDER BY id');
  assert.deepEqual(raids.map((r) => r.guests_open), [0, 0]);
  assert.deepEqual(raids.map(({ guests_open, ...rest }) => rest), before.raids, 'every old column of every raid is untouched');
  const signups = rows(db, 'SELECT * FROM raid_signups ORDER BY raid_id, signup_id');
  assert.deepEqual(signups.map(({ guest_user_id, ...rest }) => rest), before.signups);
  assert.deepEqual(signups.map((s) => s.guest_user_id), [null]);
  exec(db, "UPDATE raids SET guests_open = 1 WHERE id = 'r2'");
  fails(db, "UPDATE raids SET guests_open = 2 WHERE id = 'r2'", /CHECK constraint/);
  fails(db, "UPDATE raids SET guests_open = NULL WHERE id = 'r2'", /NOT NULL constraint/);
  assert.equal(one(db, 'SELECT COUNT(*) FROM guilds'), before.guilds);
});

check('team_requests: the columns, the status CHECK, the decided-at rule, the note length and the defaults', () => {
  const { db } = migrated();
  assert.deepEqual(columns(db, 'team_requests').map((c) => c.name),
    ['id', 'guild_id', 'team_id', 'character_id', 'requested_by', 'status', 'note', 'decided_by', 'decided_at', 'created_at']);
  exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at) VALUES ('q1', 'g1', 't1b', 'c1b', 'u_a', 5)");
  assert.equal(one(db, "SELECT status FROM team_requests WHERE id = 'q1'"), 'pending');
  fails(db, "UPDATE team_requests SET status = 'maybe' WHERE id = 'q1'", /CHECK constraint/);
  fails(db, "UPDATE team_requests SET status = 'approved' WHERE id = 'q1'", /CHECK constraint/); // decided without a decision time
  fails(db, "UPDATE team_requests SET decided_at = 9 WHERE id = 'q1'", /CHECK constraint/); // a pending request has no decision time
  exec(db, "UPDATE team_requests SET status = 'approved', decided_by = 'u_b', decided_at = 9 WHERE id = 'q1'");
  fails(db, `UPDATE team_requests SET note = '${'x'.repeat(201)}' WHERE id = 'q1'`, /CHECK constraint/);
  exec(db, `UPDATE team_requests SET note = '${'x'.repeat(200)}' WHERE id = 'q1'`);
});

check('one open request per character: a second pending row is refused, a decided one is not in the way, and two characters can both ask', () => {
  const { db } = migrated();
  const add = (id, character, status = 'pending') => exec(db,
    `INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, status, decided_at, created_at)
     VALUES ('${id}', 'g1', 't1b', '${character}', 'u_a', '${status}', ${status === 'pending' ? 'NULL' : 5}, 5)`);
  add('q1', 'c1b');
  fails(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q2', 'g1', 't1', 'c1b', 6)", /UNIQUE constraint/);
  add('q3', 'c1', 'withdrawn');
  add('q4', 'c1');
  exec(db, "UPDATE team_requests SET status = 'rejected', decided_at = 7 WHERE id = 'q1'");
  add('q5', 'c1b');
  assert.deepEqual(rows(db, 'SELECT id, status FROM team_requests ORDER BY id'),
    [{ id: 'q1', status: 'rejected' }, { id: 'q3', status: 'withdrawn' }, { id: 'q4', status: 'pending' }, { id: 'q5', status: 'pending' }]);
});

check('tenant keys: a request must name a team and a character of ITS guild (composite FKs), and the guild itself', () => {
  const { db } = migrated();
  fails(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g1', 't2', 'c1b', 1)", /FOREIGN KEY/); // g2's team
  fails(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g1', 't1', 'c3', 1)", /FOREIGN KEY/); // g2's character
  fails(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g9', 't1', 'c1b', 1)", /FOREIGN KEY/);
  exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g1', 't1', 'c1b', 1)");
});

check('the cascades: deleting the team, the character, the person or the guild takes its requests along', () => {
  const ask = (db) => exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g1', 't1b', 'c1b', 1)");
  const count = (db) => one(db, 'SELECT COUNT(*) FROM team_requests');
  for (const [label, remove] of [
    ['team', "DELETE FROM teams WHERE id = 't1b'"],
    ['character', "DELETE FROM characters WHERE id = 'c1b'"],
    ['person (its characters cascade, then the request)', "DELETE FROM players WHERE id = 'p1'"],
    ['guild', "DELETE FROM guilds WHERE id = 'g1'"],
  ]) {
    const { db } = migrated();
    ask(db);
    assert.equal(count(db), 1);
    exec(db, remove);
    assert.equal(count(db), 0, label);
  }
});

check('FKs to users are ON DELETE SET NULL: Delete my data (DELETE FROM users) keeps the request row, unlinked', () => {
  const { db } = migrated();
  exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, status, decided_by, decided_at, created_at) VALUES ('q1', 'g1', 't1b', 'c1b', 'u_a', 'approved', 'u_b', 5, 1)");
  exec(db, "DELETE FROM users WHERE id = 'u_a'");
  assert.deepEqual(rows(db, "SELECT requested_by, decided_by FROM team_requests WHERE id = 'q1'"), [{ requested_by: null, decided_by: 'u_b' }]);
  exec(db, "DELETE FROM users WHERE id = 'u_b'");
  assert.deepEqual(rows(db, "SELECT requested_by, decided_by FROM team_requests WHERE id = 'q1'"), [{ requested_by: null, decided_by: null }]);
  const fk = rows(db, 'PRAGMA foreign_key_list(team_requests)').filter((f) => f.table === 'users');
  assert.deepEqual(fk.map((f) => [f.from, f.on_delete]).sort(), [['decided_by', 'SET NULL'], ['requested_by', 'SET NULL']]);
  const signupFks = Object.fromEntries(rows(db, 'PRAGMA foreign_key_list(raid_signups)').filter((f) => f.table === 'users').map((f) => [f.from, f.on_delete]));
  assert.equal(signupFks.guest_user_id, 'SET NULL');
});

check('one sign-up per account per raid: the unique index covers guest_user_id only (NULL rows of release R2 never collide), another raid or account is fine', () => {
  const { db } = migrated();
  const guest = (raid, id, user) => exec(db,
    `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, guest, guest_user_id)
     VALUES ('${raid}', 'raidsmith', ${id}, 'Guest${id}', 'signed', ${id}, 'g1', 1, ${user ? `'${user}'` : 'NULL'})`);
  guest('r2', 10, null);
  guest('r2', 11, null); // the join-link guests of release R2: no account, any number
  guest('r2', 12, 'u_a');
  fails(db, "INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, guest, guest_user_id) VALUES ('r2', 'raidsmith', 13, 'Again', 'signed', 13, 'g1', 1, 'u_a')", /UNIQUE constraint/);
  guest('r2', 14, 'u_b');
  guest('r1', 15, 'u_a');
  exec(db, "DELETE FROM users WHERE id = 'u_a'");
  assert.deepEqual(rows(db, "SELECT signup_id, guest_user_id FROM raid_signups WHERE signup_id IN (12, 15) ORDER BY signup_id"), [{ signup_id: 12, guest_user_id: null }, { signup_id: 15, guest_user_id: null }]);
});

check('the scheduler index: partial on pinned guilds, and the due query of worker/roster-sync.js plans through it', async () => {
  const { db } = migrated();
  const index = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'guilds_next_sync_pinned'")[0];
  assert(index && /ON guilds\(next_sync_at\) WHERE blizzard_guild_id IS NOT NULL/.test(index.sql), 'a partial index on next_sync_at for pinned guilds');
  const { COMPLETE_PIN_SQL } = await import('../../worker/roster-pin.js');
  const plan = rows(db, `EXPLAIN QUERY PLAN SELECT id FROM guilds WHERE next_sync_at <= 5 AND ${COMPLETE_PIN_SQL} ORDER BY next_sync_at, id LIMIT 1`)
    .map((r) => r.detail).join(' | ');
  assert(/guilds_next_sync_pinned/.test(plan), `the due query uses the partial index: ${plan}`);
});

check('release R2 still works on the new schema: its INSERTs (they name their columns), the deletes of a team, a character, a person, a raid, an account and a guild', () => {
  const { db } = migrated();
  // worker/routes/raids.js and schedule.js (R2): INSERT INTO raids (column list) ... without guests_open.
  exec(db, `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, log_mode, open_flags, policy_fp, version, created_at, updated_at, size, time_known)
            VALUES ('r3', 'g1', 't1', '2026-10-24', 3000, NULL, 'log', 0, '', 1, 1, 1, 25, 1)`);
  assert.equal(one(db, "SELECT guests_open FROM raids WHERE id = 'r3'"), 0);
  // worker/routes/join.js (R2): the guest INSERT names its columns and leaves guest_user_id out.
  exec(db, `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, standby, class_name, spec_name, position, guild_id, player_id,
                                      character_id, note, updated_by, created_at, updated_at, guest, join_link_id)
            VALUES ('r3', 'raidsmith', 1, NULL, 'Pug', 'signed', 0, 'Mage', 'Fire1', 1, 'g1', NULL, NULL, NULL, NULL, 1, 1, 1, NULL)`);
  assert.equal(one(db, "SELECT guest_user_id FROM raid_signups WHERE raid_id = 'r3'"), null);
  exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at) VALUES ('q1', 'g1', 't1b', 'c1b', 'u_a', 1)");
  exec(db, "DELETE FROM raids WHERE id = 'r3'");
  exec(db, "DELETE FROM users WHERE id = 'u_a'"); // Delete my data
  exec(db, "DELETE FROM characters WHERE id = 'c1b'");
  exec(db, "DELETE FROM teams WHERE id = 't1b'");
  exec(db, "DELETE FROM guilds WHERE id = 'g2'");
  assert.equal(one(db, 'SELECT COUNT(*) FROM team_requests'), 0);
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
});

check('PRAGMA foreign_key_check is clean after the migration on a populated world', () => {
  const { db } = migrated();
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
});

check('the tail of the file is rerunnable: after the two ALTERs every statement is IF NOT EXISTS, and running the tail again changes nothing', () => {
  const { db } = migrated();
  const tail = MIGRATION.slice(MIGRATION.lastIndexOf('ALTER TABLE raid_signups'));
  const afterAlters = tail.slice(tail.indexOf('\n') + 1);
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS raid_signups_guest_user/.test(afterAlters));
  const statements = afterAlters.split(/\n(?=CREATE|--)/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
  assert(statements.length >= 6, 'the table and the five indexes');
  for (const statement of statements) assert(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /.test(statement), `not rerunnable: ${statement.slice(0, 60)}`);
  exec(db, "INSERT INTO team_requests (id, guild_id, team_id, character_id, created_at) VALUES ('q1', 'g1', 't1b', 'c1b', 1)");
  const schemaBefore = JSON.stringify(rows(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"));
  exec(db, afterAlters);
  exec(db, afterAlters);
  assert.equal(JSON.stringify(rows(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")), schemaBefore, 'schema unchanged');
  assert.equal(one(db, 'SELECT COUNT(*) FROM team_requests'), 1, 'data unchanged');
  // The ALTERs are NOT rerunnable (SQLite has no IF NOT EXISTS for a column): the header says so and what to do.
  assert.throws(() => exec(db, 'ALTER TABLE raids ADD COLUMN guests_open INTEGER NOT NULL DEFAULT 0'), /duplicate column/);
  assert(/RERUN\./.test(MIGRATION) && /Time Travel/.test(MIGRATION));
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
