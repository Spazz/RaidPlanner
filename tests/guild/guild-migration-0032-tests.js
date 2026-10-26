/**
 * Raidsmith guild tracker - migration 0032 (user-hierarchy build, lane B2, release R2): one character per person per team
 * Run: node tests/guild/guild-migration-0032-tests.js
 *
 * A database migrated up to 0031 holds the duplicates release R1 allowed (a person's alts on the Main's team); then:
 *   - tools/hierarchy/r2-report.sql counts what 0032 will change (counts only) with the same rule: keep the Main, else the earliest created, the rest go teamless;
 *   - 0032 takes the others off their team, records every changed (character, old team) in characters_team_before_0032 FIRST, and adds the unique index
 *     characters_team_person (team_id, player_id) WHERE team_id IS NOT NULL; characters on no team stay outside it;
 *   - it is rerun-safe (a second run changes nothing), needs no table rebuild, and the commented rollback block in its header restores team_id from the side
 *     table (a character placed again since, or on a team deleted since, is left alone);
 *   - after it the report says 0 everywhere.
 * Every other suite runs on a database that has 0032 applied, so the Worker's own writers are proven against the index there.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, '0032_characters_team_person.sql'), 'utf8').replace(/\r\n/g, '\n');
const REPORT = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/r2-report.sql'), 'utf8').replace(/\r\n/g, '\n');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const q = (value) => (value === null || value === undefined ? 'NULL' : `'${value}'`);

// The database as release R1 left it: every migration before 0032.
function before0032() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0032-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0032')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

// [id, player, team, main, created]
const CHARACTERS = [
  // p_a: the Main and two alts all on t1 -> the Main stays, both alts go teamless.
  ['a_main', 'p_a', 't1', 1, 50], ['a_alt1', 'p_a', 't1', 0, 10], ['a_alt2', 'p_a', 't1', 0, 20],
  // p_b: the Main is on t2; three alts on t1 -> the EARLIEST created stays (b_old), the tie (created 7) goes by id (b_tie1 over b_tie2).
  ['b_main', 'p_b', 't2', 1, 1], ['b_old', 'p_b', 't1', 0, 3], ['b_tie1', 'p_b', 't1', 0, 7], ['b_tie2', 'p_b', 't1', 0, 7],
  // p_c: a clean person (one per team, one teamless) -> untouched.
  ['c_main', 'p_c', 't1', 1, 1], ['c_alt', 'p_c', 't2', 0, 2], ['c_none', 'p_c', null, 0, 3],
  // p_d: two alts on t2 and a Main on no team -> the earlier alt stays.
  ['d_main', 'p_d', null, 1, 1], ['d_late', 'p_d', 't2', 0, 9], ['d_early', 'p_d', 't2', 0, 4],
  // p_e: several characters on NO team -> no duplicate, all stay.
  ['e_main', 'p_e', null, 1, 1], ['e_alt1', 'p_e', null, 0, 2], ['e_alt2', 'p_e', null, 0, 3],
];
const LOSERS = ['a_alt1', 'a_alt2', 'b_tie2', 'b_tie1', 'd_late'];
const KEEPERS_OF_DUPLICATES = ['a_main', 'b_old', 'd_early'];
const OLD_TEAM = { a_alt1: 't1', a_alt2: 't1', b_tie1: 't1', b_tie2: 't1', d_late: 't2' };

function seed(db) {
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1), ('t2', 'g1', 'T2', 25, 0, 1)");
  for (const player of ['p_a', 'p_b', 'p_c', 'p_d', 'p_e']) {
    db.sqlite.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('${player}', 'g1', 'raider', 1, 1)`);
  }
  for (const [id, player, team, main, created] of CHARACTERS) {
    db.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
                    VALUES ('${id}', 'g1', '${player}', ${q(team)}, 'N${id}', 'n${id}', 'MAGE', ${main}, ${created}, ${created})`);
  }
  // Sign-ups that name some of them: two standing, and Raid-Helper-source rows on one upcoming and one finished raid.
  db.sqlite.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, created_at, updated_at, time_known) VALUES
                    ('r_old', 'g1', 't1', '2020-01-01', 1577883600000, 'log', 1, 1, 1),
                    ('r_new', 'g1', 't1', '2099-01-01', 4070908800000, 'log', 1, 1, 1)`);
  db.sqlite.exec(`INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES
                    ('sg_1', 'g1', 't1', 'p_a', 2, 'signed', 'a_alt1', 1, 1),
                    ('sg_2', 'g1', 't1', 'p_a', 4, 'signed', 'a_main', 1, 1),
                    ('sg_3', 'g1', 't2', 'p_d', 2, 'late', 'd_late', 1, 1)`);
  db.sqlite.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, character_id, nickname) VALUES
                    ('r_new', 'raid_helper', 1, 'signed', 1, 'g1', 'p_a', 'a_alt2', 'A'),
                    ('r_new', 'raid_helper', 2, 'signed', 2, 'g1', 'p_b', 'b_old', 'B'),
                    ('r_old', 'raid_helper', 1, 'signed', 1, 'g1', 'p_a', 'a_alt2', 'A')`);
}

const teamsOf = (db) => Object.fromEntries(db.sqlite.prepare('SELECT id, team_id FROM characters ORDER BY id').all().map((row) => [row.id, row.team_id]));
const report = async (db) => ({ ...(await db.prepare(REPORT).first()) });
const sideTable = (db) => db.sqlite.prepare('SELECT character_id, old_team_id FROM characters_team_before_0032 ORDER BY character_id').all().map((row) => ({ ...row }));

check('the report counts what 0032 will change, with counts only, and changes nothing', async () => {
  const db = before0032();
  seed(db);
  const snapshot = JSON.stringify(db.sqlite.prepare('SELECT * FROM characters ORDER BY id').all());
  const result = await db.prepare(REPORT).all();
  assert.equal(result.results.length, 1, 'one row');
  assert.deepEqual(Object.keys(result.results[0]), ['characters_made_teamless', 'people_affected', 'standing_signups_naming_them', 'upcoming_signups_naming_them']);
  assert.deepEqual({ ...result.results[0] }, { characters_made_teamless: 5, people_affected: 3, standing_signups_naming_them: 2, upcoming_signups_naming_them: 1 });
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM characters ORDER BY id').all()), snapshot, 'read-only');
  assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(REPORT.split('\n').filter((line) => !line.startsWith('--')).join('\n')), 'a single SELECT');
  for (const value of Object.values(result.results[0])) assert(Number.isInteger(value), 'counts only: no names, ids or values');
});

check('0032 keeps the Main, else the earliest created; the others go teamless and are recorded with their old team; the unique index is there', async () => {
  const db = before0032();
  seed(db);
  assert.equal(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'characters_team_person'").get(), undefined, 'no index before');
  db.sqlite.exec(MIGRATION);
  const teams = teamsOf(db);
  for (const id of LOSERS) assert.equal(teams[id], null, `${id} goes teamless`);
  for (const id of KEEPERS_OF_DUPLICATES) assert.notEqual(teams[id], null, `${id} stays`);
  assert.deepEqual([teams.a_main, teams.b_old, teams.d_early], ['t1', 't1', 't2']);
  assert.deepEqual([teams.c_main, teams.c_alt, teams.c_none, teams.b_main, teams.d_main, teams.e_main, teams.e_alt1, teams.e_alt2], ['t1', 't2', null, 't2', null, null, null, null], 'everyone else is untouched');
  assert.deepEqual(sideTable(db), LOSERS.slice().sort().map((id) => ({ character_id: id, old_team_id: OLD_TEAM[id] })), 'every changed (character, old team) is recorded');
  const index = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'characters_team_person'").get();
  assert.match(index.sql, /UNIQUE INDEX characters_team_person ON characters \(team_id, player_id\) WHERE team_id IS NOT NULL/);
  // The index refuses a second character of a person on a team and allows any number on no team.
  assert.throws(() => db.sqlite.exec("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('x1', 'g1', 'p_c', 't1', 'Xone', 'xone', 'MAGE', 1, 1)"),
    /UNIQUE constraint failed: characters\.team_id, characters\.player_id/);
  db.sqlite.exec("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('x2', 'g1', 'p_c', NULL, 'Xtwo', 'xtwo', 'MAGE', 1, 1)");
  db.sqlite.exec("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('x3', 'g1', 'p_c', NULL, 'Xthree', 'xthree', 'MAGE', 1, 1)");
  // Nothing but characters.team_id changed; the sign-ups still name their characters.
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM standing_signups WHERE character_id IS NOT NULL").get().n, 3);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM raid_signups WHERE character_id IS NOT NULL").get().n, 3);
});

check('0032 is rerun-safe, needs no table rebuild, and leaves a clean database alone', async () => {
  const db = before0032();
  seed(db);
  db.sqlite.exec(MIGRATION);
  const once = { teams: teamsOf(db), side: sideTable(db) };
  db.sqlite.exec(MIGRATION);
  assert.deepEqual({ teams: teamsOf(db), side: sideTable(db) }, once, 'a second run changes nothing');
  // A character placed on a team again since is not touched by a rerun, whatever the side table says.
  db.sqlite.exec("UPDATE characters SET team_id = 't2' WHERE id = 'a_alt1'");
  db.sqlite.exec(MIGRATION);
  assert.equal(teamsOf(db).a_alt1, 't2', 'the rerun does not take it off again');
  assert.deepEqual(sideTable(db), once.side);
  const code = MIGRATION.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  assert(!/DROP TABLE|RENAME|CREATE TABLE characters\b|PRAGMA/i.test(code), 'no table rebuild');
  assert(!/\bDELETE\b/i.test(code), 'it deletes nothing');
  // A database without any duplicate: only the empty side table and the index.
  const clean = before0032();
  clean.sqlite.exec("INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'UTC', 'tbc', 1)");
  clean.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)");
  clean.sqlite.exec("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p1', 'g1', 'raider', 1, 1)");
  clean.sqlite.exec("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at) VALUES ('c1', 'g1', 'p1', 't1', 'Cone', 'cone', 'MAGE', 1, 1, 1)");
  clean.sqlite.exec(MIGRATION);
  assert.deepEqual(sideTable(clean), []);
  assert.equal(teamsOf(clean).c1, 't1');
});

check('the rollback block in the header restores team_id from the side table; it skips a character placed again and a team that is gone', async () => {
  const db = before0032();
  seed(db);
  const original = teamsOf(db);
  db.sqlite.exec(MIGRATION);
  // The commented block of the header, uncommented.
  const lines = MIGRATION.split('\n');
  const start = lines.findIndex((line) => line.startsWith('-- ROLLBACK'));
  assert(start > 0, 'the header carries a ROLLBACK block');
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('--   ')) break;
    block.push(line.replace(/^--\s{3}/, ''));
  }
  const rollback = block.filter((line) => !line.trim().startsWith('--')).join('\n');
  assert(/DROP INDEX IF EXISTS characters_team_person;/.test(rollback) && /UPDATE characters SET team_id/.test(rollback), rollback);
  // Meanwhile: one of them was placed on another team again, one team was deleted (a character on it is taken off first).
  db.sqlite.exec("UPDATE characters SET team_id = 't2' WHERE id = 'a_alt2'");
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t3', 'g1', 'T3', 25, 0, 1)");
  db.sqlite.exec("UPDATE characters_team_before_0032 SET old_team_id = 't3' WHERE character_id = 'b_tie1'");
  db.sqlite.exec("DELETE FROM teams WHERE id = 't3'");
  const dropFirst = rollback.split(';').map((part) => part.trim()).filter(Boolean);
  for (const part of dropFirst) db.sqlite.exec(`${part};`);
  assert.equal(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'characters_team_person'").get(), undefined, 'the index is gone');
  const after = teamsOf(db);
  for (const id of ['a_alt1', 'b_tie2', 'd_late']) assert.equal(after[id], original[id], `${id} is back on its team`);
  assert.equal(after.a_alt2, 't2', 'a character placed again since is left alone');
  assert.equal(after.b_tie1, null, 'a team that is gone is skipped');
  // With the index gone the old shape is possible again.
  db.sqlite.exec("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('x1', 'g1', 'p_c', 't1', 'Xone', 'xone', 'MAGE', 1, 1)");
});

check('after 0032 the report says 0 everywhere', async () => {
  const db = before0032();
  seed(db);
  db.sqlite.exec(MIGRATION);
  assert.deepEqual(await report(db), { characters_made_teamless: 0, people_affected: 0, standing_signups_naming_them: 0, upcoming_signups_naming_them: 0 });
});

check('the report and the migration use the same rule, over every shape of a group (property check on generated data)', async () => {
  const db = before0032();
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'UTC', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1), ('t2', 'g1', 'T2', 25, 0, 1)");
  // Deterministic pseudo-random groups: persons 1..40, each with up to 6 characters on t1 / t2 / none, created times with ties, the Main anywhere or nowhere in a group.
  let seedValue = 12345;
  const next = (n) => { seedValue = (seedValue * 1103515245 + 12345) % 2147483648; return seedValue % n; };
  const expectedLosers = new Set();
  for (let p = 1; p <= 40; p++) {
    db.sqlite.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('pp${p}', 'g1', 'raider', 1, 1)`);
    const count = 1 + next(6);
    const chars = [];
    for (let i = 0; i < count; i++) chars.push({ id: `c${String(p).padStart(2, '0')}${i}`, team: [null, 't1', 't2'][next(3)], main: i === 0 ? 1 : 0, created: 1 + next(4) });
    for (const c of chars) {
      db.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
                      VALUES ('${c.id}', 'g1', 'pp${p}', ${q(c.team)}, 'N${c.id}', 'n${c.id}', 'MAGE', ${c.main}, ${c.created}, ${c.created})`);
    }
    for (const team of ['t1', 't2']) {
      const group = chars.filter((c) => c.team === team).sort((a, b) => (b.main - a.main) || (a.created - b.created) || (a.id < b.id ? -1 : 1));
      for (const loser of group.slice(1)) expectedLosers.add(loser.id);
    }
  }
  assert((await report(db)).characters_made_teamless === expectedLosers.size && expectedLosers.size > 10, 'the report agrees with the statement of the rule here');
  db.sqlite.exec(MIGRATION);
  const changed = new Set(sideTable(db).map((row) => row.character_id));
  assert.deepEqual([...changed].sort(), [...expectedLosers].sort());
  const nowTeamless = db.sqlite.prepare("SELECT id FROM characters WHERE team_id IS NULL AND id IN (SELECT character_id FROM characters_team_before_0032)").all().map((row) => row.id);
  assert.deepEqual(nowTeamless.sort(), [...expectedLosers].sort());
  const dupes = db.sqlite.prepare('SELECT COUNT(*) AS n FROM (SELECT team_id, player_id FROM characters WHERE team_id IS NOT NULL GROUP BY team_id, player_id HAVING COUNT(*) > 1)').get().n;
  assert.equal(dupes, 0);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 7).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
