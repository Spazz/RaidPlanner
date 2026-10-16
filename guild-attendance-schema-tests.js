/**
 * Raidsmith guild tracker - attendance schema tests (Phase 3, migrations/0003_attendance.sql)
 * Run: node guild-attendance-schema-tests.js
 *
 * Applies 0003 over a database seeded by 0001 + 0002 (the permission rename), then checks the new tables on the
 * node:sqlite D1 stand-in (tests/d1-fake.js): CHECKs, composite foreign keys, cascades, restrict, the unique indexes
 * and the sign-up person SET NULL.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
const MIGRATIONS = path.join(ROOT, 'migrations');
const MIGRATION_0003 = fs.readFileSync(path.join(MIGRATIONS, '0003_attendance.sql'), 'utf8');

let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const exec = (db, sql) => db.sqlite.exec(sql);
const rows = (db, sql) => db.sqlite.prepare(sql).all().map((row) => ({ ...row }));
const count = (db, table, where = '1 = 1') => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const fails = (db, sql, pattern) => assert.throws(() => exec(db, sql), pattern, sql.slice(0, 90));

// A database with only 0001 + 0002 applied (for the upgrade test), or with everything.
function worldBefore0003() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0003-'));
  for (const name of ['0001_foundation.sql', '0002_roster.sql']) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

function seed(db) {
  for (const [guild, server] of [['g1', 'd1'], ['g2', 'd2']]) {
    exec(db, `INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
              VALUES ('${guild}', 'G', 'R', 'realm', 'US', '${server}', 'America/Chicago', 'tbc', 1)`);
    exec(db, `INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('${guild}_t1', '${guild}', 'T1', 25, 0, 1), ('${guild}_t2', '${guild}', 'T2', 25, 0, 1)`);
  }
  for (const [id, guild] of [['p1', 'g1'], ['p2', 'g1'], ['q1', 'g2']]) {
    exec(db, `INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('${id}', '${guild}', 'raider', 1, 1)`);
  }
}

const raidSql = (id, over = {}) => {
  const v = { guild: 'g1', team: 'g1_t1', on: '2026-10-10', startsAt: 1000, extra: '', ...over };
  return `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at${v.extra ? ', ' + v.extra.split('|')[0] : ''})
          VALUES ('${id}', '${v.guild}', '${v.team}', '${v.on}', ${v.startsAt}, 1, 1${v.extra ? ', ' + v.extra.split('|')[1] : ''})`;
};
const reportSql = (raid, code, guild = 'g1', flavour = 'fresh') =>
  `INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${raid}', '${guild}', '${code}', '${flavour}', 1, 1)`;
const CODE_A = 'AAAAAAAAAAAAAAAA';
const CODE_B = 'BBBBBBBBBBBBBBBB';
const pullSql = (raid, code, fight, id = null) =>
  `INSERT INTO raid_pulls (${id ? 'id, ' : ''}raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (${id ? id + ', ' : ''}'${raid}', '${code}', ${fight}, 50609, 'Illidan', 0, 10, 20)`;
const signupSql = (raid, source, id, over = {}) => {
  const v = { kind: 'signed', player: null, guild: 'g1', ...over };
  return `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id, player_id)
          VALUES ('${raid}', '${source}', ${id}, '990000000000000001', 'Nick', '${v.kind}', 1, '${v.guild}', ${v.player ? `'${v.player}'` : 'NULL'})`;
};
const attendanceSql = (raid, player, outcome = 'present', extra = '') =>
  `INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ('${raid}', 'g1', 'g1_t1', '${player}', '${outcome}'${extra ? ', ' + extra.split('|')[1] : ''})`;

check('0003 over a database seeded by 0001 + 0002: nights.* become raids.*, attendance.policy is added for Guild Master and Officer only', () => {
  const db = worldBefore0003();
  const before = rows(db, "SELECT role_id, action, scope FROM role_permissions WHERE action LIKE 'nights.%' ORDER BY role_id, action");
  assert.deepEqual(before, [
    { role_id: 'guild_master', action: 'nights.edit', scope: 'guild' }, { role_id: 'guild_master', action: 'nights.view', scope: 'guild' },
    { role_id: 'member', action: 'nights.view', scope: 'guild' },
    { role_id: 'officer', action: 'nights.edit', scope: 'guild' }, { role_id: 'officer', action: 'nights.view', scope: 'guild' },
    { role_id: 'team_lead', action: 'nights.edit', scope: 'team' },
  ]);
  const total = count(db, 'role_permissions');
  exec(db, MIGRATION_0003);
  assert.equal(count(db, 'role_permissions', "action LIKE 'nights.%'"), 0);
  assert.deepEqual(rows(db, "SELECT role_id, action, scope FROM role_permissions WHERE action LIKE 'raids.%' ORDER BY role_id, action"),
    before.map((row) => ({ ...row, action: row.action.replace('nights.', 'raids.') })).sort((a, b) => (a.role_id + a.action < b.role_id + b.action ? -1 : 1)));
  assert.deepEqual(rows(db, "SELECT role_id, scope FROM role_permissions WHERE action = 'attendance.policy' ORDER BY role_id"),
    [{ role_id: 'guild_master', scope: 'guild' }, { role_id: 'officer', scope: 'guild' }]);
  assert.equal(count(db, 'role_permissions'), total + 2, 'only the two new rows were added');
  // Every other permission row is untouched.
  assert.equal(count(db, 'role_permissions', "action IN ('attendance.view', 'attendance.review')"), 7);
  assert.deepEqual(rows(db, "SELECT scope FROM role_permissions WHERE role_id = 'member' AND action = 'attendance.view'"), [{ scope: 'own_teams' }]);
});

check('0003 applies cleanly over existing data: guilds and teams keep their rows and gain the WCL columns', () => {
  const db = worldBefore0003();
  seed(db);
  exec(db, MIGRATION_0003);
  assert.deepEqual(rows(db, 'SELECT id, wcl_guild_id FROM guilds ORDER BY id'), [{ id: 'g1', wcl_guild_id: null }, { id: 'g2', wcl_guild_id: null }]);
  assert.deepEqual(rows(db, "SELECT wcl_uploaders FROM teams WHERE id = 'g1_t1'"), [{ wcl_uploaders: '[]' }]);
  exec(db, "UPDATE guilds SET wcl_guild_id = 123 WHERE id = 'g1'");
  fails(db, "UPDATE guilds SET wcl_guild_id = 0 WHERE id = 'g1'", /CHECK constraint failed/);
  fails(db, "UPDATE guilds SET wcl_guild_id = -4 WHERE id = 'g1'", /CHECK constraint failed/);
  exec(db, "UPDATE guilds SET wcl_guild_id = NULL WHERE id = 'g1'");
  exec(db, `UPDATE teams SET wcl_uploaders = '["Daolith"]' WHERE id = 'g1_t1'`);
  fails(db, "UPDATE teams SET wcl_uploaders = 'not json' WHERE id = 'g1_t1'", /CHECK constraint failed/);
});

check('migration file: ASCII only, no unsupported column-list SET NULL, and the earlier migrations are not edited by it', () => {
  assert(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(MIGRATION_0003), 'ASCII only');
  assert(!/SET NULL \(/.test(MIGRATION_0003));
  assert(!/DROP TABLE|ALTER TABLE (players|characters|users|sessions)/.test(MIGRATION_0003));
  const names = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  assert.deepEqual(names.slice(0, 3), ['0001_foundation.sql', '0002_roster.sql', '0003_attendance.sql']);
});

check('policies: one row per guild + team (the guild default included), JSON checked, team FK within the guild, cascades', () => {
  const db = createD1Fake();
  seed(db);
  const sql = (id, guild, team, policy = '{}') => `INSERT INTO attendance_policies (id, guild_id, team_id, policy, updated_at) VALUES ('${id}', '${guild}', ${team ? `'${team}'` : 'NULL'}, '${policy}', 1)`;
  exec(db, sql('ap1', 'g1', null));
  fails(db, sql('ap2', 'g1', null), /UNIQUE constraint failed/);
  exec(db, sql('ap3', 'g1', 'g1_t1', '{"fillIn":"recordOnly"}'));
  fails(db, sql('ap4', 'g1', 'g1_t1'), /UNIQUE constraint failed/);
  exec(db, sql('ap5', 'g2', null));
  exec(db, sql('ap6', 'g1', 'g1_t2'));
  fails(db, sql('ap7', 'g1', 'g2_t1'), /FOREIGN KEY constraint failed/);
  fails(db, sql('ap8', 'g2', 'g1_t1'), /FOREIGN KEY constraint failed/);
  fails(db, sql('ap9', 'g1', 'g1_t1', 'not json'), /CHECK constraint failed/);
  assert.equal(rows(db, "SELECT version FROM attendance_policies WHERE id = 'ap1'")[0].version, 1);
  exec(db, "DELETE FROM teams WHERE id = 'g1_t2'");
  assert.equal(count(db, 'attendance_policies', "id = 'ap6'"), 0, 'a team delete removes its override');
  exec(db, "DELETE FROM guilds WHERE id = 'g1'");
  assert.deepEqual(rows(db, 'SELECT id FROM attendance_policies'), [{ id: 'ap5' }]);
});

check('raids: date, event id, zone and manual-reason CHECKs; one raid per team and date; one raid per event; team FK within the guild', () => {
  const db = createD1Fake();
  seed(db);
  exec(db, raidSql('r1'));
  assert.deepEqual(rows(db, "SELECT log_mode, open_flags, policy_fp, version FROM raids WHERE id = 'r1'"), [{ log_mode: 'log', open_flags: 0, policy_fp: '', version: 1 }]);
  for (const bad of ['2026-02-30', '2026-19-01', 'tomorrow', '']) fails(db, raidSql('rx', { on: bad }), /CHECK constraint failed/);
  fails(db, raidSql('rx'), /UNIQUE constraint failed/); // same team, same date
  exec(db, raidSql('r2', { on: '2026-10-11' }));
  exec(db, raidSql('r3', { team: 'g1_t2' })); // another team, same date
  for (const bad of ['12345', '12345678901234567890123456', '12345678a', '']) fails(db, raidSql('rx', { on: '2026-10-12', extra: `event_id|'${bad}'` }), /CHECK constraint failed/);
  exec(db, raidSql('r4', { on: '2026-10-12', extra: "event_id|'1556782596615307326'" }));
  fails(db, raidSql('r5', { on: '2026-10-13', extra: "event_id|'1556782596615307326'" }), /UNIQUE constraint failed/);
  exec(db, raidSql('r6', { guild: 'g2', team: 'g2_t1', on: '2026-10-13', extra: "event_id|'1556782596615307326'" })); // another guild may reuse the id
  fails(db, raidSql('rx', { on: '2026-10-14', extra: `zone|'${'z'.repeat(61)}'` }), /CHECK constraint failed/);
  fails(db, raidSql('rx', { on: '2026-10-14', extra: `event_title|'${'t'.repeat(101)}'` }), /CHECK constraint failed/);
  fails(db, raidSql('rx', { on: '2026-10-14', extra: `plan_label|'${'p'.repeat(81)}'` }), /CHECK constraint failed/);
  // Manual raids need a 3 to 200 character reason; a log raid needs none.
  fails(db, raidSql('rx', { on: '2026-10-14', extra: "log_mode|'manual'" }), /CHECK constraint failed/);
  fails(db, raidSql('rx', { on: '2026-10-14', extra: "log_mode, manual_reason|'manual', 'ab'" }), /CHECK constraint failed/);
  fails(db, raidSql('rx', { on: '2026-10-14', extra: `log_mode, manual_reason|'manual', '${'r'.repeat(201)}'` }), /CHECK constraint failed/);
  fails(db, raidSql('rx', { on: '2026-10-14', extra: "log_mode|'other'" }), /CHECK constraint failed/);
  exec(db, raidSql('r7', { on: '2026-10-14', extra: "log_mode, manual_reason|'manual', 'Nobody logged it'" }));
  // The team belongs to the raid's guild.
  fails(db, raidSql('rx', { guild: 'g1', team: 'g2_t1', on: '2026-10-15' }), /FOREIGN KEY constraint failed/);
  // A team with raids cannot be deleted; deleting the guild removes them.
  fails(db, "DELETE FROM teams WHERE id = 'g1_t2'", /FOREIGN KEY constraint failed/);
  exec(db, "DELETE FROM guilds WHERE id = 'g1'");
  assert.deepEqual(rows(db, 'SELECT id FROM raids'), [{ id: 'r6' }]);
});

check('reports and pulls: 16-character codes, flavours, a code backs one raid per guild, pulls hang off their report and cascade', () => {
  const db = createD1Fake();
  seed(db);
  exec(db, raidSql('r1'));
  exec(db, raidSql('r2', { on: '2026-10-11' }));
  exec(db, reportSql('r1', CODE_A));
  fails(db, reportSql('r1', CODE_A), /UNIQUE constraint failed/);
  fails(db, reportSql('r2', CODE_A), /UNIQUE constraint failed/); // a report backs one raid
  for (const bad of ['SHORT', 'AAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAA-', 'AAAAAAAAAAAAAA A']) fails(db, reportSql('r1', bad), /CHECK constraint failed/);
  fails(db, reportSql('r1', CODE_B, 'g1', 'retail'), /CHECK constraint failed/);
  exec(db, reportSql('r1', CODE_B, 'g1', 'classic'));
  exec(db, reportSql('r2', 'CCCCCCCCCCCCCCCC', 'g2')); // the unique code index is per guild (raid r2 is in g1; the row only carries a guild_id)
  exec(db, pullSql('r1', CODE_A, 1, 1));
  exec(db, pullSql('r1', CODE_A, 2, 2));
  fails(db, pullSql('r1', CODE_A, 1), /UNIQUE constraint failed/);
  fails(db, pullSql('r1', 'ZZZZZZZZZZZZZZZZ', 1), /FOREIGN KEY constraint failed/);
  fails(db, pullSql('r2', CODE_A, 3), /FOREIGN KEY constraint failed/); // report CODE_A belongs to r1
  exec(db, pullSql('r1', CODE_B, 1, 3));
  fails(db, "INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES ('r1', 'AAAAAAAAAAAAAAAA', 9, 1, 'x', 2, 1, 2)", /CHECK constraint failed/);
  fails(db, `INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES ('r1', '${CODE_A}', 9, 1, '${'n'.repeat(61)}', 0, 1, 2)`, /CHECK constraint failed/);
  // Presence per pull: class check, a name once per pull, cascade from the pull.
  const presence = (pull, name, cls = 'MAGE', realmKey = '') =>
    `INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key, class) VALUES (${pull}, 'r1', 'g1', '${name}', '${name.toLowerCase()}', '${realmKey}', ${cls ? `'${cls}'` : 'NULL'})`;
  exec(db, presence(1, 'Kajuk'));
  exec(db, presence(1, 'Genow', null));
  exec(db, presence(2, 'Kajuk'));
  exec(db, presence(1, 'Kajuk', 'MAGE', 'otherrealm'));
  fails(db, presence(1, 'Kajuk'), /UNIQUE constraint failed/);
  fails(db, presence(1, 'Zed', 'DEATHKNIGHT'), /CHECK constraint failed/);
  fails(db, presence(99, 'Zed'), /FOREIGN KEY constraint failed/);
  exec(db, "DELETE FROM raid_pulls WHERE id = 1");
  assert.equal(count(db, 'raid_presence', 'pull_id = 1'), 0, 'deleting a pull deletes its presence');
  assert.equal(count(db, 'raid_presence', 'pull_id = 2'), 1);
  exec(db, `DELETE FROM raid_reports WHERE raid_id = 'r1' AND code = '${CODE_A}'`);
  assert.equal(count(db, 'raid_pulls', "report_code = 'AAAAAAAAAAAAAAAA'"), 0, 'deleting a report deletes its pulls');
  assert.equal(count(db, 'raid_presence', 'pull_id = 2'), 0, 'and their presence');
  assert.equal(count(db, 'raid_pulls', 'id = 3'), 1);
  exec(db, "DELETE FROM raids WHERE id = 'r1'");
  assert.equal(count(db, 'raid_pulls') + count(db, 'raid_reports', "raid_id = 'r1'"), 0, 'deleting a raid deletes everything under it');
});

check('sign-ups: kinds and sources checked, the same ordinal may live in two sources, the person link is SET NULL on delete and must be in the guild', () => {
  const db = createD1Fake();
  seed(db);
  exec(db, raidSql('r1'));
  exec(db, signupSql('r1', 'raid_helper', 1, { player: 'p1' }));
  exec(db, signupSql('r1', 'plan', 1, { player: 'p1' }));
  fails(db, signupSql('r1', 'plan', 1), /UNIQUE constraint failed/);
  exec(db, signupSql('r1', 'raidsmith', 1)); // reserved, allowed by the schema
  fails(db, signupSql('r1', 'discord', 2), /CHECK constraint failed/);
  for (const kind of ['signed', 'late', 'bench', 'tentative', 'absence']) exec(db, signupSql('r1', 'raid_helper', 10 + ['signed', 'late', 'bench', 'tentative', 'absence'].indexOf(kind), { kind }));
  fails(db, signupSql('r1', 'raid_helper', 20, { kind: 'maybe' }), /CHECK constraint failed/);
  fails(db, "INSERT INTO raid_signups (raid_id, kind, position, guild_id, signup_id) VALUES ('r1', 'signed', 1, 'g1', 30), ('r1', 'signed', 1, 'g1', 30)", /UNIQUE constraint failed/);
  fails(db, `INSERT INTO raid_signups (raid_id, signup_id, nickname, kind, position, guild_id) VALUES ('r1', 31, '${'n'.repeat(65)}', 'signed', 1, 'g1')`, /CHECK constraint failed/);
  assert.equal(rows(db, "SELECT source FROM raid_signups WHERE signup_id = 30 OR signup_id = 31").length, 0);
  assert.deepEqual(rows(db, "SELECT source FROM raid_signups WHERE raid_id = 'r1' AND signup_id = 2"), []);
  exec(db, "INSERT INTO raid_signups (raid_id, signup_id, kind, position, guild_id) VALUES ('r1', 40, 'signed', 1, 'g1')");
  assert.equal(rows(db, 'SELECT source FROM raid_signups WHERE signup_id = 40')[0].source, 'raid_helper', 'the default source');
  // A person of another guild is refused, on insert and on update.
  fails(db, signupSql('r1', 'raid_helper', 50, { player: 'q1' }), /signup_person_guild/);
  fails(db, signupSql('r1', 'raid_helper', 51, { player: 'nobody' }), /signup_person_guild/);
  fails(db, "UPDATE raid_signups SET player_id = 'q1' WHERE raid_id = 'r1' AND source = 'plan' AND signup_id = 1", /signup_person_guild/);
  exec(db, "UPDATE raid_signups SET player_id = 'p2' WHERE raid_id = 'r1' AND source = 'plan' AND signup_id = 1");
  // Deleting the person keeps the sign-up row (guild_id intact), clears only player_id.
  exec(db, "DELETE FROM players WHERE id = 'p1'");
  assert.deepEqual(rows(db, "SELECT source, player_id, guild_id FROM raid_signups WHERE raid_id = 'r1' AND source = 'raid_helper' AND signup_id = 1"), [{ source: 'raid_helper', player_id: null, guild_id: 'g1' }]);
  assert.equal(count(db, 'raid_signups', "player_id = 'p2'"), 1);
  // Delete my data scrubs the Discord id and nickname and leaves the rest.
  exec(db, "UPDATE raid_signups SET discord_user_id = NULL, nickname = NULL WHERE discord_user_id = '990000000000000001'");
  assert.equal(count(db, 'raid_signups', 'discord_user_id IS NOT NULL OR nickname IS NOT NULL'), 0);
  assert(count(db, 'raid_signups') >= 8);
  exec(db, "DELETE FROM raids WHERE id = 'r1'");
  assert.equal(count(db, 'raid_signups'), 0);
});

check('manual attendance and the plan: ticks need a person of the guild and cascade; plan groups are 0 to 8, one name once', () => {
  const db = createD1Fake();
  seed(db);
  exec(db, raidSql('r1'));
  const tick = (player, guild = 'g1') => `INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES ('r1', '${guild}', '${player}')`;
  exec(db, tick('p1'));
  fails(db, tick('p1'), /UNIQUE constraint failed/);
  fails(db, tick('q1'), /FOREIGN KEY constraint failed/);
  fails(db, tick('p2', 'g2'), /FOREIGN KEY constraint failed/);
  exec(db, tick('p2'));
  const plan = (name, group) => `INSERT INTO raid_plan (raid_id, name, name_key, group_number) VALUES ('r1', '${name}', '${name.toLowerCase()}', ${group})`;
  exec(db, plan('Kajuk', 0));
  exec(db, plan('Genow', 8));
  exec(db, plan('Daolith', 1));
  fails(db, plan('Kajuk', 2), /UNIQUE constraint failed/);
  fails(db, plan('Zed', 9), /CHECK constraint failed/);
  fails(db, plan('Zed', -1), /CHECK constraint failed/);
  exec(db, "DELETE FROM players WHERE id = 'p1'");
  assert.equal(count(db, 'raid_manual'), 1, 'deleting a person removes their tick');
  exec(db, "DELETE FROM raids WHERE id = 'r1'");
  assert.equal(count(db, 'raid_manual') + count(db, 'raid_plan'), 0);
});

check('attendance rows: outcome, credit, source and review CHECKs; one row per raid and person; cascades from the raid and the person', () => {
  const db = createD1Fake();
  seed(db);
  exec(db, raidSql('r1'));
  for (const outcome of ['present', 'bench', 'missed', 'missed_notice', 'late', 'left_early', 'late_left', 'fill_in', 'no_signup', 'tentative']) {
    exec(db, `INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome) VALUES ('r1', 'g1', 'g1_t1', 'p${outcome === 'present' ? 1 : 2}', '${outcome}') ON CONFLICT (raid_id, player_id) DO UPDATE SET outcome = excluded.outcome`);
  }
  assert.deepEqual(rows(db, 'SELECT outcome, credit, attended, presence_source, flags, needs_review, pulls_present FROM attendance WHERE player_id = \'p1\''),
    [{ outcome: 'present', credit: null, attended: 0, presence_source: 'log', flags: '[]', needs_review: 0, pulls_present: 0 }]);
  fails(db, attendanceSql('r1', 'p1', 'present'), /UNIQUE constraint failed/);
  exec(db, "DELETE FROM attendance");
  fails(db, attendanceSql('r1', 'p1', 'absent'), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p1', 'present', 'credit|1.5'), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p1', 'present', 'credit|-0.1'), /CHECK constraint failed/);
  exec(db, attendanceSql('r1', 'p1', 'late', 'credit|0.5'));
  exec(db, attendanceSql('r1', 'p2', 'missed', 'credit|0'));
  fails(db, attendanceSql('r1', 'p2', 'present'), /UNIQUE constraint failed/);
  exec(db, "DELETE FROM attendance WHERE player_id = 'p2'");
  fails(db, attendanceSql('r1', 'p2', 'present', "presence_source|'robot'"), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p2', 'present', 'needs_review|2'), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p2', 'present', "flags|'not json'"), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p2', 'present', "decided_reason|'ab'"), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'p2', 'present', `decided_reason|'${'r'.repeat(201)}'`), /CHECK constraint failed/);
  fails(db, attendanceSql('r1', 'q1', 'present'), /FOREIGN KEY constraint failed/); // a person of another guild
  exec(db, attendanceSql('r1', 'p2', 'present', "presence_source, flags, decided_reason|'officer', '[\"left_early\"]', 'Told us ahead'"));
  assert.equal(count(db, 'attendance'), 2);
  exec(db, "DELETE FROM players WHERE id = 'p2'");
  assert.equal(count(db, 'attendance'), 1, 'deleting a person cascades their attendance');
  exec(db, "DELETE FROM raids WHERE id = 'r1'");
  assert.equal(count(db, 'attendance'), 0, 'deleting a raid cascades its rows');
});

check('guests: one row per name and realm key per guild, cascaded with the guild; a guild delete removes every attendance table', () => {
  const db = createD1Fake();
  seed(db);
  const guest = (guild, key, realm = '') => `INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_at) VALUES ('${guild}', '${key}', '${realm}', '${key}', 1)`;
  exec(db, guest('g1', 'visitor'));
  fails(db, guest('g1', 'visitor'), /UNIQUE constraint failed/);
  exec(db, guest('g1', 'visitor', 'otherrealm'));
  exec(db, guest('g2', 'visitor'));
  fails(db, guest('nope', 'x'), /FOREIGN KEY constraint failed/);
  exec(db, raidSql('r1'));
  exec(db, reportSql('r1', CODE_A));
  exec(db, pullSql('r1', CODE_A, 1, 1));
  exec(db, `INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key) VALUES (1, 'r1', 'g1', 'Kajuk', 'kajuk')`);
  exec(db, signupSql('r1', 'raid_helper', 1, { player: 'p1' }));
  exec(db, attendanceSql('r1', 'p1'));
  exec(db, "INSERT INTO attendance_policies (id, guild_id, team_id, policy, updated_at) VALUES ('ap1', 'g1', NULL, '{}', 1)");
  exec(db, "DELETE FROM guilds WHERE id = 'g1'");
  for (const table of ['raids', 'raid_reports', 'raid_pulls', 'raid_presence', 'raid_signups', 'raid_manual', 'raid_plan', 'attendance', 'attendance_policies']) assert.equal(count(db, table), 0, table);
  assert.deepEqual(rows(db, 'SELECT guild_id FROM attendance_guests'), [{ guild_id: 'g2' }]);
});

check('indexes: the partial and expression indexes of the plan exist', () => {
  const db = createD1Fake();
  const names = rows(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((row) => row.name);
  for (const name of ['attendance_policies_scope', 'raids_team_day', 'raids_event', 'raids_flags', 'raid_reports_code', 'raid_pulls_raid', 'raid_presence_raid',
    'raid_presence_name', 'raid_signups_discord', 'attendance_player', 'attendance_credit_team', 'attendance_review']) {
    assert(names.includes(name), name);
  }
  const triggers = rows(db, "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((row) => row.name);
  assert(triggers.includes('raid_signups_same_guild_insert') && triggers.includes('raid_signups_same_guild_update'));
  assert.equal(rows(db, "SELECT sql FROM sqlite_master WHERE name = 'raids_event'")[0].sql.includes('WHERE event_id IS NOT NULL'), true);
});

async function main() {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 10).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
