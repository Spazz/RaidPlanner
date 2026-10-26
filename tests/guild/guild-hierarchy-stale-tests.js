/**
 * Raidsmith guild tracker - the R2 stale-marking tool (tools/hierarchy/mark-all-stale.sql), lane B1a-2
 * Run: node tests/guild/guild-hierarchy-stale-tests.js
 *
 * Marks every raid's attendance stale the way every input write does (policy_fp = '', version + 1), only where it is not stale yet, so a second run changes
 * nothing. The stored attendance rows and decisions stay as they are; the raid page and the team page then show the raid as needing a recalculation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');
const { ROOT, load } = require('../guild-world');

const SQL = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/mark-all-stale.sql'), 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function seed() {
  const db = createD1Fake();
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1), ('g2', 'H', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1), ('t2', 'g2', 'T2', 25, 0, 1)");
  db.sqlite.exec("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p1', 'g1', 'raider', 1, 1)");
  const raid = (id, guild, team, fp, version, extra = '') => db.sqlite.exec(
    `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, open_flags, policy_fp, version, created_at, updated_at${extra ? ', computed_at' : ''})
     VALUES ('${id}', '${guild}', '${team}', '2026-10-1${version}', 1000, 'log', 0, '${fp}', ${version}, 1, 1${extra ? ', 5' : ''})`,
  );
  raid('r_fresh_a', 'g1', 't1', 'fp-aaaa', 1, 'x');
  raid('r_fresh_b', 'g1', 't1', 'fp-bbbb', 2, 'x');
  raid('r_stale', 'g1', 't1', '', 3);
  raid('r_other_guild', 'g2', 't2', 'fp-cccc', 4, 'x');
  db.sqlite.exec("INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES ('r_fresh_a', 'g1', 't1', 'p1', 'present', 1, 1)");
  return db;
}
const snapshot = (db) => db.sqlite.prepare('SELECT * FROM raids ORDER BY id').all().map((row) => ({ ...row }));
const without = (rows) => rows.map(({ policy_fp, version, ...rest }) => rest);

check('every raid that is not stale yet becomes stale and is re-versioned; nothing else about a raid changes', async () => {
  const db = seed();
  const before = snapshot(db);
  const result = await db.prepare(SQL).run();
  assert.equal(result.meta.changes, 3, 'the three fresh raids (two of g1, one of g2)');
  const after = snapshot(db);
  assert.deepEqual(without(after), without(before), 'no other column of any raid changed');
  for (const row of after) assert.equal(row.policy_fp, '', row.id);
  const version = (rows, id) => rows.find((row) => row.id === id).version;
  assert.deepEqual(['r_fresh_a', 'r_fresh_b', 'r_other_guild'].map((id) => version(after, id) - version(before, id)), [1, 1, 1], 'the version bump discards a recompute that read the old inputs');
  assert.equal(version(after, 'r_stale'), version(before, 'r_stale'), 'an already stale raid is not touched');
});

check('idempotent: a second run changes nothing, not even a version', async () => {
  const db = seed();
  await db.prepare(SQL).run();
  const once = snapshot(db);
  const again = await db.prepare(SQL).run();
  assert.equal(again.meta.changes, 0);
  assert.deepEqual(snapshot(db), once);
});

check('the stored attendance is left as it is, and the raid now reads as stale to the page', async () => {
  const db = seed();
  const rows = () => db.sqlite.prepare('SELECT * FROM attendance ORDER BY raid_id, player_id').all().map((row) => ({ ...row }));
  const before = rows();
  await db.prepare(SQL).run();
  assert.deepEqual(rows(), before, 'results, decisions and flags stay until the recompute');
  const { raidState } = await load('worker/attendance-view.js');
  const { makePolicyResolver } = await load('worker/attendance-store.js');
  const resolver = makePolicyResolver({ region: 'US' }, []); // the pages always read a raid with the team's current policy
  const raid = db.sqlite.prepare("SELECT * FROM raids WHERE id = 'r_fresh_a'").get();
  assert.equal(raidState({ ...raid }, 1), 'stale', 'a raid with a log and an empty fingerprint is stale');
  assert.equal(raidState({ ...raid }, 1, resolver), 'stale');
  assert.equal(raidState({ ...raid }, 0, resolver), 'awaiting_log', 'a raid with no log yet is still awaiting one');
  assert.equal(raidState({ ...raid, log_mode: 'manual' }, 0, resolver), 'stale', 'a hand-entered raid is stale too');
});

check('the statement is one UPDATE on raids and nothing else (a whole-or-nothing script)', async () => {
  const code = SQL.split('\n').filter((line) => !line.trim().startsWith('--') && line.trim()).join(' ');
  assert.match(code, /^UPDATE raids SET policy_fp = '', version = version \+ 1 WHERE policy_fp != '';$/);
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
