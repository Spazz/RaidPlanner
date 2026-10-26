/**
 * Raidsmith guild tracker - lane B7a of the user-hierarchy build: the audit_log trigger (migration 0034), audit pruning and failure coalescing, and blocks with
 * tombstones (worker/block-tombstones.js, worker/block-effects.js, worker/routes/person-blocks.js)
 * Run: node tests/guild/guild-b7a-blocks-tests.js
 *
 *   trigger ......... audit_log allows only: UPDATE setting actor_user_id NULL (the user-delete foreign key), DELETE once the guild row is gone (the guild-delete
 *                     cascade), DELETE of the PRUNABLE set older than 180 days; everything else aborts. The cascade and the SET NULL are pinned on the D1 stand-in.
 *   audit ........... the actor snapshot (short id + role), failure coalescing (one row + counter, one summary row per hour), the daily prune + retention jobs
 *   tombstones ...... the keyring (key, version, old keys), the HMAC (guild id inside), typed values, write on block, delete on unblock, no key = flagged + repaired
 *   block ........... people.js: tombstones, blocked_by, off every team and upcoming sign-ups, the target must be in the guild's Users set
 *   person block .... POST/DELETE /roster/:pid/block: marker + tombstones, the outranks test, permission
 *   match ........... tombstoneMatchStatements: a normal account, the Owner and a GM-tier account, an account equal or senior to the blocker; the Discord sign-in and
 *                     link callbacks; the review queue (attention kind block_review); Delete my data does not undo a block
 *   retention ....... the audit prune, rate_limits, fresh-auth markers, consumed approvals; the backfill/repair job is bounded
 * The trigger judges age by the DATABASE clock, so the age checks build their rows from Date.now() (the Worker world runs on a fixed 2027 clock).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');
const { adminOf, memberOf, signIn } = require('../guild-world');
const { load, runChecks, scenario, SERVER, discord } = require('../guild-b3-world');
const { NAMESPACE, REALM_ID, seatOnRoster } = require('../guild-seat');

const ROOT = path.join(__dirname, '..', '..');
const KEY = 'test-tombstone-key-0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const tomb = () => load('worker/block-tombstones.js');
const hmacOf = async (gid, value, secret = KEY) => (await tomb()).tombstoneHmac(secret, gid, value);

async function world(options = {}) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY }, ...options });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.lead('tla', [s.alpha], 'Leadalpha');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  return s;
}

const BNET_ID = '987654321';
// A member with a person on Alpha, a Battle.net link and one Battle.net-proven character (identity key idkey:<NAMESPACE>:<REALM_ID>:7001).
async function proven(s, key = 'm1', name = 'Mone') {
  const made = await s.person({ name });
  await s.link(made.pid, key);
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${s.uids[key]}', '${BNET_ID}', 'Mone#1234', 1, '{}', 1)`);
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids[key]}', proof_bnet_account_id = '${BNET_ID}', namespace = '${NAMESPACE}',
            blizzard_realm_id = ${REALM_ID}, blizzard_char_id = 7001 WHERE id = '${made.cid}'`);
  return made;
}
const tombstones = (s, ref) => s.rows('SELECT block_ref, key_version, hmac FROM block_tombstones WHERE guild_id = ?' + (ref ? ' AND block_ref = ?' : '') + ' ORDER BY hmac', ...(ref ? [s.gid, ref] : [s.gid]));

// ---------------------------------------------------------------------------
// The trigger

function fakeWithAudit() {
  const db = createD1Fake();
  db.sqlite.exec(`
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES
      ('g1', 'G1', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1), ('g2', 'G2', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1);
    INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u_a', 'ak1', '110000000000000001', 'A', 1, 1);
  `);
  const insert = (id, guild, action, at, actor = 'u_a') => db.sqlite.prepare(
    "INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, created_at, actor_short_id, actor_role) VALUES (?, ?, ?, ?, 'user', 'u_a', ?, 'ab12CD34', 'officer')",
  ).run(id, guild, actor, action, at);
  return { db, sqlite: db.sqlite, insert };
}
const refuses = (sqlite, sql, pattern) => assert.throws(() => sqlite.exec(sql), pattern);
const countOf = (sqlite, where = '1 = 1') => sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).get().n;

check('trigger: an UPDATE is allowed only when it sets actor_user_id to NULL and changes nothing else', () => {
  const { sqlite, insert } = fakeWithAudit();
  insert('a1', 'g1', 'team.create', 5);
  for (const sql of [
    "UPDATE audit_log SET action = 'x' WHERE id = 'a1'", "UPDATE audit_log SET entity_id = 'y' WHERE id = 'a1'", "UPDATE audit_log SET before = '{}' WHERE id = 'a1'",
    "UPDATE audit_log SET after = '{}' WHERE id = 'a1'", "UPDATE audit_log SET created_at = 6 WHERE id = 'a1'", "UPDATE audit_log SET guild_id = 'g2' WHERE id = 'a1'",
    "UPDATE audit_log SET actor_role = 'owner' WHERE id = 'a1'", "UPDATE audit_log SET actor_short_id = 'zz' WHERE id = 'a1'", "UPDATE audit_log SET id = 'a9' WHERE id = 'a1'",
    "UPDATE audit_log SET entity_type = 'guild' WHERE id = 'a1'",
    // NULL plus another change is still a change.
    "UPDATE audit_log SET actor_user_id = NULL, action = 'x' WHERE id = 'a1'", "UPDATE audit_log SET actor_user_id = NULL, actor_role = NULL WHERE id = 'a1'",
  ]) refuses(sqlite, sql, /audit_log rows cannot be changed/);
  sqlite.exec("INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u_b', 'ak2', '110000000000000002', 'B', 1, 1)");
  refuses(sqlite, "UPDATE audit_log SET actor_user_id = 'u_b' WHERE id = 'a1'", /cannot be changed/);
  sqlite.exec("UPDATE audit_log SET actor_user_id = NULL WHERE id = 'a1'");
  assert.deepEqual({ ...sqlite.prepare('SELECT actor_user_id, action, actor_short_id, actor_role FROM audit_log').get() }, { actor_user_id: null, action: 'team.create', actor_short_id: 'ab12CD34', actor_role: 'officer' });
  // A batch that includes a refused statement rolls back whole.
  sqlite.exec('BEGIN');
  assert.throws(() => sqlite.exec("UPDATE audit_log SET actor_user_id = NULL; UPDATE audit_log SET action = 'q'"), /cannot be changed/);
  sqlite.exec('ROLLBACK');
});

check('trigger: a DELETE is refused while the guild lives, for a row with no guild, and for the prunable set inside 180 days; allowed for the prunable set past it', () => {
  const { sqlite, insert } = fakeWithAudit();
  const old = Date.now() - 200 * DAY;
  const fresh = Date.now() - 100 * DAY;
  insert('keep1', 'g1', 'team.create', old);               // not prunable: never, however old
  insert('keep2', null, 'discord.link', old);              // no guild, not prunable
  insert('keep3', 'g1', 'rank_map.update', old);           // configuration row
  insert('fresh1', 'g1', 'fresh.failed', fresh);           // prunable but only 100 days old
  insert('edge1', 'g1', 'guild.claim_failed', Date.now() - 179 * DAY);
  insert('gone1', 'g1', 'fresh.failed', old);
  insert('gone2', 'g1', 'person.core_rank', old);
  insert('gone3', 'g1', 'person.ingame_rank', old);
  insert('gone4', 'g1', 'person.former', old);
  insert('gone5', 'g1', 'guild.claim_failed', old);
  for (const id of ['keep1', 'keep2', 'keep3', 'fresh1', 'edge1']) refuses(sqlite, `DELETE FROM audit_log WHERE id = '${id}'`, /audit_log rows cannot be deleted/);
  // A statement that reaches one protected row fails whole: the allowed rows it also matched stay.
  refuses(sqlite, "DELETE FROM audit_log WHERE guild_id = 'g1'", /cannot be deleted/);
  assert.equal(countOf(sqlite), 10);
  sqlite.exec("DELETE FROM audit_log WHERE id IN ('gone1', 'gone2', 'gone3', 'gone4', 'gone5')");
  assert.equal(countOf(sqlite), 5);
  // The migration's list and the code's list are the same set.
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', '0034_audit_log_trigger.sql'), 'utf8');
  const listed = /OLD\.action IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z_.]+)'/g).map((entry) => entry.slice(1, -1)).sort();
  return load('worker/audit.js').then(({ PRUNABLE_ACTIONS, AUDIT_ACTIONS }) => {
    assert.deepEqual(listed, [...PRUNABLE_ACTIONS].sort());
    for (const action of PRUNABLE_ACTIONS) assert(AUDIT_ACTIONS.includes(action), `${action} is an audited action`);
    assert(/15552000000/.test(sql), '180 days in milliseconds');
  });
});

check('trigger: the guild-delete cascade and the user-delete SET NULL still work, and each reaches only its own rows', () => {
  const { sqlite, insert } = fakeWithAudit();
  insert('x1', 'g1', 'team.create', 5);
  insert('x2', 'g1', 'access.remove', 6);
  insert('y1', 'g2', 'team.create', 7);
  insert('z1', null, 'account.delete', 8);
  sqlite.exec("DELETE FROM guilds WHERE id = 'g1'");
  assert.deepEqual(sqlite.prepare('SELECT id FROM audit_log ORDER BY id').all().map((row) => row.id), ['y1', 'z1'], 'the cascade deleted the guild\'s rows only');
  sqlite.exec("DELETE FROM users WHERE id = 'u_a'");
  assert.deepEqual(sqlite.prepare('SELECT id, actor_user_id, actor_short_id, actor_role FROM audit_log ORDER BY id').all().map((row) => ({ ...row })),
    [{ id: 'y1', actor_user_id: null, actor_short_id: 'ab12CD34', actor_role: 'officer' }, { id: 'z1', actor_user_id: null, actor_short_id: 'ab12CD34', actor_role: 'officer' }],
    'SET NULL kept the snapshot');
  // Deleting the last guild takes its rows too, with the user already gone.
  sqlite.exec("DELETE FROM guilds WHERE id = 'g2'");
  assert.equal(countOf(sqlite), 1);
});

check('trigger through the Worker: Delete my data and deleting a guild work with the trigger on, and the snapshot outlives the account', async () => {
  const s = await world();
  const before = await s.rows('SELECT COUNT(*) AS n FROM audit_log WHERE guild_id = ?', s.gid);
  assert(before[0].n > 0);
  // m1 does something audited, then deletes the account.
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, { reason: 'x' }, 200);
  const row = await s.one("SELECT actor_user_id, actor_short_id, actor_role FROM audit_log WHERE action = 'access.remove'");
  assert.deepEqual([row.actor_user_id, row.actor_short_id, row.actor_role], [s.uids.o1, s.uids.o1.slice(2, 10), 'officer']);
  await s.ok('o1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  const after = await s.one("SELECT actor_user_id, actor_short_id, actor_role FROM audit_log WHERE action = 'access.remove'");
  assert.deepEqual([after.actor_user_id, after.actor_short_id, after.actor_role], [null, s.uids.o1.slice(2, 10), 'officer']);
  // The Guild Master deletes the account and, with nobody else a member, the guild: every audit row of the guild cascades away.
  const solo = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  assert((await solo.rows('SELECT COUNT(*) AS n FROM audit_log WHERE guild_id = ?', solo.gid))[0].n > 0);
  await solo.ok('gm', 'DELETE', '/auth/me', { deleteGuildIds: [solo.gid] }, 200);
  assert.equal((await solo.rows('SELECT COUNT(*) AS n FROM audit_log WHERE guild_id = ?', solo.gid))[0].n, 0);
  assert.equal((await solo.rows('SELECT COUNT(*) AS n FROM guilds'))[0].n, 0);
});

check('previous release safety: nothing in worker/ updates or deletes audit_log rows except the daily prune; every statement on it is an INSERT', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /(UPDATE|DELETE FROM|REPLACE INTO|INSERT OR REPLACE INTO)\s+audit_log\b/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(ROOT, 'worker'));
  assert.deepEqual(offenders, ['worker/retention.js'], 'only the prune rule deletes (and it deletes the prunable set only)');
});

// ---------------------------------------------------------------------------
// Audit: the snapshot, failure coalescing, the prune

check('audit rows carry the actor snapshot: a short id and the role (owner, guild_master, officer, team_lead, member); none for a row with no actor or no guild', async () => {
  const s = await world();
  const { auditStatement } = await load('worker/audit.js');
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => 5 };
  const write = async (userId, guildId, action) => {
    await s.w.db.batch([auditStatement(ctx, { guildId, actorUserId: userId, action, entityType: 'guild', entityId: guildId })]);
    return s.one('SELECT actor_short_id, actor_role FROM audit_log WHERE action = ?', action);
  };
  const shortOf = (key) => s.uids[key].slice(2, 10);
  assert.deepEqual(await write(s.uids.gm, s.gid, 'guild.update'), { actor_short_id: shortOf('gm'), actor_role: 'owner' }, 'the Owner seat (legacy: the stored Guild Master row)');
  assert.deepEqual(await write(s.uids.o1, s.gid, 'team.rename'), { actor_short_id: shortOf('o1'), actor_role: 'officer' });
  assert.deepEqual(await write(s.uids.tla, s.gid, 'team.archive'), { actor_short_id: shortOf('tla'), actor_role: 'team_lead' });
  assert.deepEqual(await write(s.uids.m1, s.gid, 'team.restore'), { actor_short_id: shortOf('m1'), actor_role: 'member' });
  assert.deepEqual(await write(null, s.gid, 'notify.disabled'), { actor_short_id: null, actor_role: null }, 'a Worker-made row has no actor');
  assert.deepEqual(await write(s.uids.m1, null, 'discord.link'), { actor_short_id: shortOf('m1'), actor_role: null }, 'an account\'s own row has no guild, so no role');
  // A hand-over: the Owner seat moves, and a derived Guild Master who is not the Owner reads guild_master.
  s.setOwner('o1');
  assert.deepEqual(await write(s.uids.gm, s.gid, 'guild.export'), { actor_short_id: shortOf('gm'), actor_role: 'guild_master' });
  assert.deepEqual(await write(s.uids.o1, s.gid, 'guild.claim'), { actor_short_id: shortOf('o1'), actor_role: 'owner' });
});

check('failure coalescing: one row per user, guild and hour (count 1) + a counter; the daily job writes ONE summary row per busy hour and drops the counter; a rerun adds nothing', async () => {
  const s = await world();
  const { failureAuditStatements, flushFailureCounters, FAILURE_WINDOW_MS } = await load('worker/audit.js');
  const T = Math.floor(1_800_000_000_000 / FAILURE_WINDOW_MS) * FAILURE_WINDOW_MS;
  let at = T + 60_000;
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => at };
  const fail = (userKey, action = 'fresh.failed') => s.w.db.batch(failureAuditStatements(ctx, { guildId: s.gid, userId: s.uids[userKey], action }));
  for (let i = 0; i < 6; i++) { at += 10_000; await fail('m1'); }
  const rows = () => s.rows("SELECT action, actor_user_id, entity_id, after, actor_role FROM audit_log WHERE action IN ('fresh.failed', 'guild.claim_failed') ORDER BY created_at, id");
  assert.equal((await rows()).length, 1, 'six failures in one hour leave one row');
  assert.deepEqual(JSON.parse((await rows())[0].after), { count: 1, windowStart: T });
  assert.equal((await s.one("SELECT count FROM rate_limits WHERE key LIKE 'auditfail:fresh.failed:%'")).count, 6);
  await fail('m2');                                          // another user: its own row
  await fail('m1', 'guild.claim_failed');                    // another action: its own row
  assert.equal((await rows()).length, 3);
  at = T + FAILURE_WINDOW_MS + 5_000;                         // the next hour
  await fail('m1'); await fail('m1');
  assert.equal((await rows()).length, 4, 'a new hour starts a new row');
  // Nothing is summarised while the hour is open; once it is over the busy hours get one counted row each.
  assert.equal(await flushFailureCounters({ db: s.w.db, now: () => T + 10_000, randomBytes: s.w.randomBytes }), 0);
  at = T + 2 * FAILURE_WINDOW_MS + 1;
  const written = await flushFailureCounters({ db: s.w.db, now: () => at, randomBytes: s.w.randomBytes });
  assert.equal(written, 2, 'hour 1 of m1 (6 failures) and hour 2 of m1 (2 failures); the single failures need no summary');
  const summaries = (await rows()).filter((row) => JSON.parse(row.after).coalesced);
  assert.deepEqual(summaries.map((row) => JSON.parse(row.after).count).sort(), [2, 6]);
  assert.equal(summaries[0].entity_id, s.uids.m1);
  assert.equal(await flushFailureCounters({ db: s.w.db, now: () => at, randomBytes: s.w.randomBytes }), 0, 'a rerun finds no counters');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'auditfail:%' AND count > 1"), 0);
  // The helper refuses what it does not coalesce.
  assert.throws(() => failureAuditStatements(ctx, { guildId: s.gid, userId: s.uids.m1, action: 'team.create' }), /not a coalesced failure action/);
  assert.throws(() => failureAuditStatements(ctx, { guildId: null, userId: s.uids.m1, action: 'fresh.failed' }), /guild and a user/);
});

check('failure coalescing: a user deleted since the failures keeps the counted row with no actor; a guild deleted since keeps nothing', async () => {
  const s = await world();
  const { failureAuditStatements, flushFailureCounters, FAILURE_WINDOW_MS } = await load('worker/audit.js');
  const T = Math.floor(1_800_000_000_000 / FAILURE_WINDOW_MS) * FAILURE_WINDOW_MS;
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => T + 1000 };
  for (let i = 0; i < 3; i++) await s.w.db.batch(failureAuditStatements(ctx, { guildId: s.gid, userId: s.uids.m1, action: 'guild.claim_failed' }));
  s.exec(`DELETE FROM users WHERE id = '${s.uids.m1}'`);
  await flushFailureCounters({ db: s.w.db, now: () => T + 2 * FAILURE_WINDOW_MS, randomBytes: s.w.randomBytes });
  const row = await s.one("SELECT actor_user_id, entity_id, actor_short_id FROM audit_log WHERE action = 'guild.claim_failed' AND after LIKE '%coalesced%'");
  assert.deepEqual([row.actor_user_id, row.entity_id, row.actor_short_id], [null, s.uids.m1, s.uids.m1.slice(2, 10)]);
  const other = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  await other.member('x1', 'Xone');
  const octx = { db: other.w.db, randomBytes: other.w.randomBytes, now: () => T + 1000 };
  for (let i = 0; i < 3; i++) await other.w.db.batch(failureAuditStatements(octx, { guildId: other.gid, userId: other.uids.x1, action: 'fresh.failed' }));
  other.exec(`DELETE FROM guilds WHERE id = '${other.gid}'`);
  assert.equal(await flushFailureCounters({ db: other.w.db, now: () => T + 2 * FAILURE_WINDOW_MS, randomBytes: other.w.randomBytes }), 0);
  assert.equal(await other.w.count('rate_limits', "key LIKE 'auditfail:%'"), 0, 'the counter is dropped all the same');
});

check('retention: the prunable audit rows go after 180 days, every other row stays; rate_limits, fresh-auth markers and consumed approvals go in the same run; one failing rule does not stop the rest', async () => {
  const s = await world();
  const rt = await load('worker/retention.js');
  const rl = await load('worker/ratelimit.js');
  const nowMs = Date.now();
  const put = (id, action, ageDays) => s.exec(`INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, created_at) VALUES ('${id}', '${s.gid}', NULL, '${action}', 'user', 'u_x', ${nowMs - ageDays * DAY})`);
  put('old_core', 'person.core_rank', 200); put('old_rank', 'person.ingame_rank', 181); put('old_former', 'person.former', 400); put('old_claim', 'guild.claim_failed', 300); put('old_fresh', 'fresh.failed', 190);
  put('new_core', 'person.core_rank', 100); put('new_fresh', 'fresh.failed', 179);
  put('old_config', 'rank_map.update', 400); put('old_block', 'access.remove', 400); put('old_owner', 'guild_master.transfer', 400); put('old_create', 'guild.create', 400); put('old_claim_ok', 'guild.claim', 400);
  s.exec('DELETE FROM rate_limits');
  s.exec(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old', ${nowMs - rl.LONGEST_WINDOW_MS - 1000}, 1), ('live', ${nowMs - 1000}, 1)`);
  s.exec(`INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES ('m_old', 'h', 'claim', ${nowMs - 16 * 60000}), ('m_new', 'h', 'claim', ${nowMs - 14 * 60000})`);
  const approval = (hash, used) => s.exec(`INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at) VALUES ('${hash}', '${s.gid}', '${s.uids.gm}', 'm', 'rs_x', 1, ${nowMs + 600000}, ${used})`);
  approval('a_old', nowMs - 31 * DAY); approval('a_recent', nowMs - 29 * DAY);
  const deleted = await rt.runRetention({ db: s.w.db, now: () => nowMs, log: () => {} });
  assert.equal(deleted.auditPrunable, 5);
  assert.deepEqual((await s.rows("SELECT id FROM audit_log WHERE id LIKE 'new_%' OR id LIKE 'old_%' ORDER BY id")).map((r) => r.id),
    ['new_core', 'new_fresh', 'old_block', 'old_claim_ok', 'old_config', 'old_create', 'old_owner']);
  assert.deepEqual([deleted.rateLimits, deleted.freshActMarkers, deleted.dryRunApprovals], [1, 1, 1]);
  assert.deepEqual((await s.rows('SELECT key FROM rate_limits ORDER BY key')).map((r) => r.key), ['live']);
  // The trigger is what protects the rest: even a hand-written DELETE of a configuration row is refused.
  await assert.rejects(s.w.db.prepare("DELETE FROM audit_log WHERE id = 'old_config'").run(), /cannot be deleted/);
  // A failing rule is logged and the others still run.
  s.exec('DROP TABLE fresh_act_markers');
  put('old_core2', 'person.core_rank', 250);
  const logs = [];
  const again = await rt.runRetention({ db: s.w.db, now: () => nowMs, log: (line) => logs.push(line) });
  assert.equal(again.freshActMarkers, null);
  assert.equal(again.auditPrunable, 1);
  assert(logs.some((line) => /^retention: freshActMarkers failed/.test(line)));
});

check('retention: the daily cron runs the audit prune and the tombstone repair', async () => {
  const s = await world();
  const sched = await load('worker/scheduler.js');
  const nowMs = Date.now();
  s.exec(`INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, created_at) VALUES ('cron_old', '${s.gid}', NULL, 'person.former', 'person', ${nowMs - 200 * DAY})`);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.m2}', '${s.uids.o1}', NULL, 1)`);
  const logs = [];
  await sched.runCron({
    cron: sched.DAILY_CRON, db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => nowMs, randomBytes: s.w.randomBytes, log: (line) => logs.push(line),
  });
  assert.equal(await s.w.count('audit_log', "id = 'cron_old'"), 0);
  assert.equal((await tombstones(s, `u:${s.uids.m2}`)).length, 1, 'the legacy block got its tombstone (the R4 backfill)');
  assert(logs.some((line) => /^tombstone repair: 1 block repaired/.test(line)), logs.join(' | '));
});

// ---------------------------------------------------------------------------
// The keyring, the HMAC and the typed values

check('keyring: the current key and version, old keys, short or malformed values are refused without echoing a secret; the status is booleans and versions only', async () => {
  const t = await tomb();
  assert.deepEqual(t.tombstoneKeyStatus({}), { configured: false, version: null, oldVersions: [] });
  assert.equal(t.readKeyring({ TOMBSTONE_KEY: KEY }).current.version, 1, 'the version defaults to 1');
  assert.equal(t.readKeyring({ TOMBSTONE_KEY: KEY, TOMBSTONE_KEY_VERSION: '3' }).current.version, 3);
  assert.deepEqual(t.tombstoneKeyStatus({ TOMBSTONE_KEY: KEY, TOMBSTONE_KEY_VERSION: '3', TOMBSTONE_OLD_KEYS: `1:${'a'.repeat(20)}, 2:${'b'.repeat(20)}` }), { configured: true, version: 3, oldVersions: [1, 2] });
  const short = t.readKeyring({ TOMBSTONE_KEY: 'too-short' });
  assert.equal(short.current, null);
  assert(short.problems.length === 1 && !short.problems[0].includes('too-short'));
  assert.equal(t.readKeyring({ TOMBSTONE_KEY: KEY, TOMBSTONE_KEY_VERSION: '0' }).current, null);
  assert.equal(t.readKeyring({ TOMBSTONE_KEY: KEY, TOMBSTONE_KEY_VERSION: 'x' }).current, null);
  const ring = t.readKeyring({ TOMBSTONE_KEY: KEY, TOMBSTONE_OLD_KEYS: `bad,1:short,:${'c'.repeat(20)},2:${'d'.repeat(20)}` });
  assert.deepEqual([...ring.keys.keys()], [1, 2], 'the current key (version 1) and the one valid old entry; the current wins a clash');
  assert.equal(ring.keys.get(1), KEY);
  assert.equal(ring.problems.length, 3);
  assert(ring.problems.every((text) => !/short|dddd|cccc/.test(text)));
  assert.equal(t.tombstoneKeyStatus({ TOMBSTONE_KEY: KEY }).configured, true);
  assert(!JSON.stringify(t.tombstoneKeyStatus({ TOMBSTONE_KEY: KEY })).includes(KEY));
});

check('HMAC: deterministic, base64url, differs by guild, by value and by key; typed values are validated, deduplicated and capped', async () => {
  const t = await tomb();
  const a = await t.tombstoneHmac(KEY, 'g_one', 'discord:11000000000009');
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a, await t.tombstoneHmac(KEY, 'g_one', 'discord:11000000000009'));
  assert.notEqual(a, await t.tombstoneHmac(KEY, 'g_two', 'discord:11000000000009'), 'the guild id is inside the input');
  assert.notEqual(a, await t.tombstoneHmac(KEY, 'g_one', 'bnet:11000000000009'), 'the type is inside the value');
  assert.notEqual(a, await t.tombstoneHmac(`${KEY}x`, 'g_one', 'discord:11000000000009'));
  assert.deepEqual(t.typedValuesOf({ bnetAccountId: '123', discordId: '456', identityKeys: ['idkey:profile-classicann-us:4001:7', { namespace: 'ns-x', realmId: 5, charId: 6 }, { namespace: 'n', blizzardRealmId: 1, blizzardCharId: 2 }] }),
    ['bnet:123', 'discord:456', 'idkey:profile-classicann-us:4001:7', 'idkey:ns-x:5:6', 'idkey:n:1:2']);
  assert.deepEqual(t.typedValuesOf({ bnetAccountId: 'abc', discordId: 'bad id!', identityKeys: ['idkey:a:b:c', 'discord:1', { namespace: 'a b', realmId: 1, charId: 1 }, null, 7] }), [], 'malformed keys are dropped, never hashed');
  assert.deepEqual(t.typedValuesOf({ bnetAccountId: 5, discordId: '5', identityKeys: ['idkey:n:1:2', 'idkey:n:1:2'] }), ['bnet:5', 'discord:5', 'idkey:n:1:2']);
  assert.equal(t.typedValuesOf({ identityKeys: Array.from({ length: 300 }, (_, i) => `idkey:n:1:${i + 1}`) }).length, 100);
  assert.deepEqual(t.typedValuesOf(null), []);
});

// ---------------------------------------------------------------------------
// Block and unblock (an account)

check('block: writes the tombstones (Discord id, Battle.net id, Battle.net-proven characters) under u:<user>, stores blocked_by, audits, and unblock deletes them by block_ref', async () => {
  const s = await world();
  await proven(s);
  const res = await s.call('o1', 'POST', `/people/${s.uids.m1}/block`, { reason: 'Left the raid mid-pull' });
  assert.equal(res.status, 200, res.text);
  const block = await s.one('SELECT * FROM guild_blocks WHERE user_id = ?', s.uids.m1);
  assert.deepEqual([block.blocked_by, block.reason, block.pending_review, block.tombstone_missing], [s.uids.o1, 'Left the raid mid-pull', 0, 0]);
  const expected = [await hmacOf(s.gid, `discord:${discord('m1').id}`), await hmacOf(s.gid, `bnet:${BNET_ID}`), await hmacOf(s.gid, `idkey:${NAMESPACE}:${REALM_ID}:7001`)].sort();
  const stored = await tombstones(s);
  assert.deepEqual(stored.map((row) => row.hmac), expected);
  assert(stored.every((row) => row.block_ref === `u:${s.uids.m1}` && row.key_version === 1));
  assert(!JSON.stringify(stored).includes(discord('m1').id) && !JSON.stringify(stored).includes(BNET_ID), 'no raw key is stored');
  const audit = JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'access.remove'")).after);
  assert.deepEqual(audit, { blocked: true, reasonSet: true }, 'the audit row keeps its shape; the tombstones are the block\'s own rows');
  assert.equal(s.w.logs.filter((line) => /TOMBSTONE_KEY/.test(line)).length, 0);
  // A second block is a no-op: nothing doubles.
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, { reason: 'again' }, 200);
  assert.equal((await tombstones(s)).length, 3);
  assert.equal(await s.w.count('audit_log', "action = 'access.remove'"), 1);
  // Unblock deletes them (and only this block's).
  await s.ok('o1', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  assert.equal((await tombstones(s)).length, 4, 'm2 has a Discord id only');
  await s.ok('o1', 'DELETE', `/people/${s.uids.m1}/block`, undefined, 200);
  assert.deepEqual((await tombstones(s)).map((row) => row.block_ref), [`u:${s.uids.m2}`]);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.m1), 0);
  assert.equal(await s.w.count('audit_log', "action = 'access.restore'"), 1);
});

check('block: takes the person off every team and withdraws the upcoming Raidsmith sign-ups, standing sign-ups and pending team requests; past and Raid-Helper rows stay', async () => {
  const s = await world();
  const { pid, cid } = await proven(s);
  const altId = await s.alt(pid, 'Mtwo');
  s.setTeam(altId, s.bravo);
  const other = await s.person({ name: 'Other', teamId: s.alpha });                // another person on the same team stays put
  const now = s.w.clock.now;
  s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES
      ('r_past', '${s.gid}', '${s.alpha}', '2027-01-01', ${now - DAY}, 1, 1), ('r_next', '${s.gid}', '${s.alpha}', '2027-01-20', ${now + 2 * DAY}, 1, 1), ('r_bravo', '${s.gid}', '${s.bravo}', '2027-01-21', ${now + 3 * DAY}, 1, 1)`);
  const signup = (raid, source, id, player) => s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${raid}', '${source}', ${id}, 'signed', 0, '${s.gid}', '${player}')`);
  signup('r_past', 'raidsmith', 1, pid); signup('r_next', 'raidsmith', 2, pid); signup('r_bravo', 'raidsmith', 3, pid); signup('r_next', 'raid_helper', 4, pid); signup('r_next', 'raidsmith', 5, other.pid);
  s.exec(`INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, created_at, updated_at) VALUES ('sg_AAAAAAAAAAAAAAAAAAAAAA', '${s.gid}', '${s.alpha}', '${pid}', 2, 'signed', 1, 1)`);
  const versions = async () => Object.fromEntries((await s.rows('SELECT id, version FROM raids')).map((row) => [row.id, row.version]));
  const before = await versions();
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  assert.deepEqual((await s.rows('SELECT id, team_id FROM characters WHERE player_id = ? ORDER BY name', pid)).map((row) => row.team_id), [null, null], 'off Alpha and Bravo');
  assert.equal(await s.teamOf(other.cid), s.alpha, 'someone else is untouched');
  assert.deepEqual((await s.rows('SELECT raid_id, source, signup_id FROM raid_signups ORDER BY signup_id')).map((row) => `${row.raid_id}/${row.source}/${row.signup_id}`),
    ['r_past/raidsmith/1', 'r_next/raid_helper/4', 'r_next/raidsmith/5'], 'the upcoming Raidsmith sign-ups of the person are gone');
  assert.equal(await s.w.count('standing_signups'), 0);
  const after = await versions();
  assert(after.r_next > before.r_next && after.r_bravo > before.r_bravo, 'the upcoming raids that read them are re-versioned');
  assert(after.r_past >= before.r_past, 'past raids are only marked stale, never lose their sign-ups');
  assert.equal(await s.w.count('characters', 'id = ?', cid), 1, 'the characters stay on the roster');
  // Open-raid guest sign-ups and pending team requests of the account go too.
  const guestCid = (await s.one('SELECT id FROM characters WHERE player_id = ? AND is_main = 1', other.pid)).id;
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, guest, guest_user_id, nickname) VALUES ('r_next', 'raidsmith', 9, 'signed', 0, '${s.gid}', 1, '${s.uids.m2}', 'Guestm2')`);
  s.exec(`INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at) VALUES ('tq_AAAAAAAAAAAAAAAAAAAAAA', '${s.gid}', '${s.bravo}', '${guestCid}', '${s.uids.m2}', 1)`);
  await s.ok('o1', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  assert.equal(await s.w.count('raid_signups', 'signup_id = 9'), 0);
  assert.equal(await s.w.count('team_requests'), 0);
  assert.equal(await s.w.count('raid_signups', 'signup_id = 5'), 1);
});

check('block: the target must be in THIS guild\'s Users set (a member, an account that reaches it, or one that holds a role or a block here); an outsider and an account of another guild are 404', async () => {
  const s = await world();
  await s.outsider('stranger', 'Stranger');
  const refused = await s.call('o1', 'POST', `/people/${s.uids.stranger}/block`, {});
  assert.deepEqual([refused.status, refused.json.error], [404, 'not_found']);
  assert.equal((await s.call('o1', 'POST', `/people/u_${'A'.repeat(22)}/block`, {})).status, 404);
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal(await s.w.count('block_tombstones'), 0);
  // The seniority rules are unchanged: an Officer cannot block an Officer or the Guild Master; a Team Lead cannot block at all.
  assert.equal((await s.call('o1', 'POST', `/people/${s.uids.o2}/block`, {})).status, 403);
  assert.equal((await s.call('o1', 'POST', `/people/${s.uids.gm}/block`, {})).status, 403);
  assert.equal((await s.call('tla', 'POST', `/people/${s.uids.m1}/block`, {})).status, 403);
  assert.equal(await s.w.count('block_tombstones'), 0);
  // A member of ANOTHER guild of the same database is not in this guild's set.
  const other = '900000000000000092';
  const admin = (await signIn(s.w, discord('admin2', 'Adminb'), [adminOf(other)])).jar;
  const made = await s.w.call(admin, 'POST', '/api/guild', { serverId: other, name: 'Other Guild', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['One', 'Two'] });
  assert.equal(made.status, 201, made.text);
  const far = await signIn(s.w, discord('far', 'Faraway'), [memberOf(other)]);
  const farId = (await s.w.call(far.jar, 'GET', '/auth/me')).json.user.id;
  assert.equal(await s.w.count('user_servers', 'user_id = ? AND server_id = ?', farId, other), 1);
  assert.equal((await s.call('o1', 'POST', `/people/${farId}/block`, {})).status, 404);
  assert.equal(await s.w.count('guild_blocks'), 0);
});

check('block: TOMBSTONE_KEY unset - the block still applies, flagged tombstone_missing with ONE operator error line; setting the key and running the daily job repairs it', async () => {
  const s = await world({ env: {} });
  await proven(s);
  const res = await s.call('o1', 'POST', `/people/${s.uids.m1}/block`, {});
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(await s.one('SELECT pending_review, tombstone_missing FROM guild_blocks WHERE user_id = ?', s.uids.m1), { pending_review: 0, tombstone_missing: 1 });
  assert.equal(await s.w.count('block_tombstones'), 0);
  assert.equal(s.w.logs.filter((line) => /TOMBSTONE_KEY/.test(line)).length, 1, 'one operator error line');
  // The blocked account is blocked all the same.
  assert.equal((await s.call('m1', 'GET', '')).json.error, 'access_removed');
  // The job without the key says so and changes nothing.
  const t = await tomb();
  const logs = [];
  assert.equal(await t.repairTombstones({ db: s.w.db, env: {}, now: () => 100, log: (line) => logs.push(line) }), null);
  assert(/TOMBSTONE_KEY is not set/.test(logs[0]) && /1 block waits/.test(logs[0]), logs.join('|'));
  assert.equal(await s.w.count('block_tombstones'), 0);
  // With the key it writes the tombstones from the account's current keys and clears the flag.
  const done = await t.repairTombstones({ db: s.w.db, env: { TOMBSTONE_KEY: KEY }, now: () => 200, log: (line) => logs.push(line) });
  assert.deepEqual(done, { repaired: 1, noKeys: 0 });
  assert.deepEqual((await tombstones(s)).map((row) => row.hmac), [await hmacOf(s.gid, `discord:${discord('m1').id}`), await hmacOf(s.gid, `bnet:${BNET_ID}`), await hmacOf(s.gid, `idkey:${NAMESPACE}:${REALM_ID}:7001`)].sort());
  assert.equal((await s.one('SELECT tombstone_missing FROM guild_blocks WHERE user_id = ?', s.uids.m1)).tombstone_missing, 0);
  assert(logs.some((line) => /^tombstone repair: 1 block repaired/.test(line)));
  assert.deepEqual(await t.repairTombstones({ db: s.w.db, env: { TOMBSTONE_KEY: KEY }, now: () => 300, log: () => {} }), { repaired: 0, noKeys: 0 }, 'nothing left to repair');
});

check('repair / backfill: blocks made before this build (no tombstones, no flag) are repaired at most 25 a run, from the account\'s current ids, pending-review blocks are left to an officer', async () => {
  const s = await world();
  const t = await tomb();
  const total = t.REPAIR_LIMIT + 7;
  for (let i = 0; i < total; i++) {
    const id = `u_legacy${String(i).padStart(15, '0')}`;
    s.exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('${id}', 'dk_${i}', '12000000000${String(i).padStart(7, '0')}', 'L${i}', 1, 1)`);
    s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${id}', '${s.uids.o1}', NULL, ${i + 1})`);
  }
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES ('${s.gid}', '${s.uids.m2}', NULL, 'match', 5, 1)`);
  const logs = [];
  const run = () => t.repairTombstones({ db: s.w.db, env: { TOMBSTONE_KEY: KEY }, now: () => 50, log: (line) => logs.push(line) });
  assert.deepEqual(await run(), { repaired: t.REPAIR_LIMIT, noKeys: 0 });
  assert.equal(await s.w.count('block_tombstones'), t.REPAIR_LIMIT);
  assert.deepEqual(await run(), { repaired: 7, noKeys: 0 });
  assert.equal(await s.w.count('block_tombstones'), total);
  assert.deepEqual(await run(), { repaired: 0, noKeys: 0 });
  assert(logs.some((line) => new RegExp(`^tombstone repair: ${t.REPAIR_LIMIT} blocks repaired`).test(line)), logs.join('|'));
  assert.equal(await s.w.count('block_tombstones', 'block_ref = ?', `u:${s.uids.m2}`), 0, 'the pending-review block is not repaired');
  // The tombstone of a legacy block hashes the account's Discord id for THIS guild.
  assert.equal((await tombstones(s, 'u:u_legacy000000000000000'))[0].hmac, await hmacOf(s.gid, 'discord:120000000000000000'));
});

// ---------------------------------------------------------------------------
// An account-less person

// An 'ingame' guild with a rank map (0 GM, 1 Officer, 2 Team Lead, 4 nothing) and roster people with no account.
async function ingameWorld() {
  const s = await world();
  const people = {};
  const seat = async (name, id, rank, userKey = null) => {
    people[name] = await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.alpha, userId: userKey ? s.uids[userKey] : null, who: 'gm' }, { name, id, rank, link: !!userKey });
    return people[name];
  };
  // The acting accounts are members of an 'ingame' guild only through a person on the roster.
  await seat('Seatgm', 8100, 3, 'gm'); await seat('Seatoone', 8101, 3, 'o1'); await seat('Seatotwo', 8102, 3, 'o2'); await seat('Seattla', 8103, 3, 'tla'); await seat('Seatmone', 8104, 3, 'm1'); await seat('Seatmtwo', 8105, 3, 'm2');
  await seat('Memberguy', 8001, 4); await seat('Officerguy', 8002, 1); await seat('Gmguy', 8003, 0); await seat('Leadguy', 8004, 2);
  const altId = await s.alt(people.Memberguy.pid, 'Memberalt');
  s.exec(`UPDATE characters SET namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = 8201 WHERE id = '${altId}'`);
  s.setTeam(altId, s.bravo);
  people.Memberguy.altId = altId;
  const map = (rank, role) => s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('${s.gid}', 'ingame', '${rank}', 'R${rank}', 'raider', ${role ? `'${role}'` : 'NULL'})`);
  map(0, 'guild_master'); map(1, 'officer'); map(2, 'team_lead'); map(4, null);
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  s.people = people;
  return s;
}
const blockPerson = (s, who, name, body = {}) => s.call(who, 'POST', `/roster/${s.people[name].pid}/block`, body);

check('person block: a marker + tombstones for its Discord id and identity keys under p:<player>, off every team, audited as person.block; DELETE lifts it and the tombstones', async () => {
  const s = await ingameWorld();
  const who = s.people.Memberguy;
  s.exec(`UPDATE players SET discord_user_id = '130000000000000001' WHERE id = '${who.pid}'`);
  s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r_next', '${s.gid}', '${s.alpha}', '2027-01-20', ${s.w.clock.now + DAY}, 1, 1)`);
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('r_next', 'raidsmith', 1, 'signed', 0, '${s.gid}', '${who.pid}')`);
  const res = await blockPerson(s, 'o1', 'Memberguy', { reason: 'Harassment' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { blocked: true, personId: who.pid, tombstoneMissing: false });
  assert.deepEqual(await s.one('SELECT blocked_by, reason, tombstone_missing FROM person_blocks WHERE player_id = ?', who.pid), { blocked_by: s.uids.o1, reason: 'Harassment', tombstone_missing: 0 });
  const stored = await tombstones(s, `p:${who.pid}`);
  assert.deepEqual(stored.map((row) => row.hmac), [await hmacOf(s.gid, 'discord:130000000000000001'), await hmacOf(s.gid, `idkey:${NAMESPACE}:${REALM_ID}:8001`), await hmacOf(s.gid, `idkey:${NAMESPACE}:${REALM_ID}:8201`)].sort());
  assert.deepEqual(await s.rows('SELECT team_id FROM characters WHERE player_id = ?', who.pid), [{ team_id: null }, { team_id: null }]);
  assert.equal(await s.w.count('raid_signups'), 0);
  const audit = await s.one("SELECT actor_user_id, actor_role, entity_type, entity_id, after FROM audit_log WHERE action = 'person.block'");
  assert.deepEqual([audit.actor_user_id, audit.actor_role, audit.entity_type, audit.entity_id, JSON.parse(audit.after)], [s.uids.o1, 'officer', 'person', who.pid, { blocked: true, reasonSet: true }]);
  // Again is a no-op; unblock lifts the marker and the tombstones.
  assert.equal((await blockPerson(s, 'o1', 'Memberguy')).status, 200);
  assert.equal(await s.w.count('audit_log', "action = 'person.block'"), 1);
  const lifted = await s.call('o1', 'DELETE', `/roster/${who.pid}/block`);
  assert.deepEqual([lifted.status, lifted.json], [200, { blocked: false, personId: who.pid, tombstoneMissing: false }]);
  assert.equal(await s.w.count('person_blocks'), 0);
  assert.equal(await s.w.count('block_tombstones'), 0);
  assert.equal(await s.w.count('audit_log', "action = 'person.unblock'"), 1);
  assert.equal((await s.call('o1', 'DELETE', `/roster/${who.pid}/block`)).status, 200, 'lifting what is not there is fine');
});

check('person block: the outranks test - strictly senior to the rank the person would have (the rank-map role of its characters); the Owner passes; the same test guards the unblock', async () => {
  const s = await ingameWorld();
  // An Officer (rank 1) blocks the Member-mapped person, not the Officer-mapped, Team Lead-mapped-above... nor the GM-mapped person.
  assert.equal((await blockPerson(s, 'o1', 'Memberguy')).status, 200);
  assert.equal((await blockPerson(s, 'o1', 'Leadguy')).status, 200, 'rank 2 (Team Lead) is junior to an Officer');
  for (const name of ['Officerguy', 'Gmguy']) {
    const refused = await blockPerson(s, 'o1', name);
    assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], name);
  }
  assert.equal(await s.w.count('person_blocks'), 2);
  // The Owner (the stored Guild Master row in this legacy-owner guild) passes for every rank, the GM-mapped one included.
  assert.equal((await blockPerson(s, 'gm', 'Officerguy')).status, 200);
  assert.equal((await blockPerson(s, 'gm', 'Gmguy')).status, 200);
  // A Guild Master who is not the Owner is judged by rank: rank 0 is not strictly senior to the GM-mapped person.
  s.exec(`DELETE FROM person_blocks WHERE player_id = '${s.people.Gmguy.pid}'`);
  s.setOwner('o2');
  const nonOwner = await blockPerson(s, 'gm', 'Gmguy');
  assert.deepEqual([nonOwner.status, nonOwner.json.error], [403, 'forbidden']);
  assert.equal((await blockPerson(s, 'o2', 'Gmguy')).status, 200, 'the Owner seat holder passes');
  // The unblock is guarded the same way: the Officer cannot lift the block on the Officer-mapped person (made by the Owner).
  assert.equal((await s.call('o1', 'DELETE', `/roster/${s.people.Officerguy.pid}/block`)).status, 403);
  assert.equal((await s.call('o1', 'DELETE', `/roster/${s.people.Memberguy.pid}/block`)).status, 200);
  assert.equal(await s.w.count('person_blocks', 'player_id = ?', s.people.Officerguy.pid), 1);
});

check('person block: a person with an account (linked, or holding a Discord id a user has) is blocked through the account; permission is guild.access; unknown ids and other guilds\' people are 404', async () => {
  const s = await ingameWorld();
  const linked = await s.person({ name: 'Linkedguy' });
  await s.member('m9', 'Memberninesix');
  s.exec(`UPDATE players SET user_id = '${s.uids.m9}' WHERE id = '${linked.pid}'`);
  s.people.Linkedguy = linked;
  const refused = await blockPerson(s, 'o1', 'Linkedguy');
  assert.deepEqual([refused.status, refused.json.error], [409, 'has_account']);
  const byDiscord = await s.person({ name: 'Discordguy' });
  s.exec(`UPDATE players SET discord_user_id = '${discord('m1').id}' WHERE id = '${byDiscord.pid}'`);
  s.people.Discordguy = byDiscord;
  assert.equal((await blockPerson(s, 'o1', 'Discordguy')).json.error, 'has_account');
  assert.equal(await s.w.count('person_blocks'), 0);
  assert.equal((await blockPerson(s, 'tla', 'Memberguy')).status, 403, 'a Team Lead has no guild.access');
  assert.equal((await blockPerson(s, 'm1', 'Memberguy')).status, 403);
  assert.equal((await s.call('o1', 'POST', `/roster/p_${'A'.repeat(22)}/block`, {})).status, 404);
  assert.equal((await s.call('o1', 'POST', '/roster/nope/block', {})).status, 404);
  assert.equal((await s.call('o1', 'POST', `/roster/${s.people.Memberguy.pid}/block`, { reason: 'x'.repeat(201) })).status, 400);
  assert.equal((await s.w.call({}, 'POST', `${s.base}/roster/${s.people.Memberguy.pid}/block`, {})).status, 401);
  assert.equal(await s.w.count('block_tombstones'), 0);
});

check('person block: no TOMBSTONE_KEY - the marker applies flagged tombstone_missing (one operator line); the daily job repairs it', async () => {
  const s = await world({ env: {} });
  const who = await s.person({ name: 'Keyless' });
  s.exec(`UPDATE players SET discord_user_id = '130000000000000009' WHERE id = '${who.pid}'`);
  const res = await s.call('o1', 'POST', `/roster/${who.pid}/block`, {});
  assert.deepEqual(res.json, { blocked: true, personId: who.pid, tombstoneMissing: true });
  assert.equal(s.w.logs.filter((line) => /TOMBSTONE_KEY/.test(line)).length, 1);
  assert.equal(await s.w.count('block_tombstones'), 0);
  const t = await tomb();
  assert.deepEqual(await t.repairTombstones({ db: s.w.db, env: { TOMBSTONE_KEY: KEY }, now: () => 9, log: () => {} }), { repaired: 1, noKeys: 0 });
  assert.deepEqual((await tombstones(s, `p:${who.pid}`)).map((row) => row.hmac), [await hmacOf(s.gid, 'discord:130000000000000009')]);
  assert.equal((await s.one('SELECT tombstone_missing FROM person_blocks WHERE player_id = ?', who.pid)).tombstone_missing, 0);
});

// ---------------------------------------------------------------------------
// The match

const signInAgain = async (s, key, name) => {
  const { jar } = await signIn(s.w, discord(key, name), [memberOf(SERVER)]);
  s.jars[key] = jar;
  s.uids[key] = (await s.w.call(jar, 'GET', '/auth/me')).json.user.id;
  return jar;
};

check('match: Delete my data does not undo a block - the same Discord account signs up again and is blocked pending review (blocked_by NULL), enforced, in the officers\' review queue, audited', async () => {
  const s = await world();
  await proven(s);
  const oldId = s.uids.m1;
  await s.ok('o1', 'POST', `/people/${oldId}/block`, { reason: 'x' }, 200);
  assert.equal((await tombstones(s)).length, 3);
  await s.ok('m1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  // m1 is blocked: Delete my data is the account's own route, which still works.
  assert.equal(await s.w.count('users', 'id = ?', oldId), 0, 'the account is gone');
  assert.equal(await s.w.count('guild_blocks'), 0, 'and its block row went with it');
  assert.equal((await tombstones(s)).length, 3, 'the tombstones stayed');
  await signInAgain(s, 'm1', 'Memberone');
  assert.notEqual(s.uids.m1, oldId, 'a new account');
  const block = await s.one('SELECT * FROM guild_blocks WHERE user_id = ?', s.uids.m1);
  assert.deepEqual([block.blocked_by, block.pending_review, block.tombstone_missing, block.reason], [null, 1, 0, 'Matched an earlier block of the same person']);
  const res = await s.call('m1', 'GET', '');
  assert.deepEqual([res.status, res.json.error], [403, 'access_removed'], 'a pending block ENFORCES');
  const audit = await s.one("SELECT actor_user_id, entity_id, after FROM audit_log WHERE action = 'block.match'");
  assert.deepEqual([audit.actor_user_id, audit.entity_id, JSON.parse(audit.after)], [null, s.uids.m1, { refs: 1, kinds: ['discord'] }]);
  // The officers' review queue: an attention item, never dismissable, only for the holders of guild.access.
  const items = (await s.ok('o1', 'GET', '/attention')).items.filter((item) => item.kind === 'block_review');
  assert.deepEqual(items.map((item) => [item.id, item.count, item.pending, item.held, item.teamId, item.severity]), [['block_review', 1, 1, 0, null, 'action']]);
  assert.equal((await s.ok('tla', 'GET', '/attention')).items.filter((item) => item.kind === 'block_review').length, 0, 'a Team Lead does not see it');
  const dismiss = await s.call('o1', 'POST', '/attention/dismissals', { itemId: 'block_review' });
  assert.deepEqual([dismiss.status, dismiss.json.error], [400, 'not_dismissable']);
  // Signing in again changes nothing (no second block, no second audit row).
  await signInAgain(s, 'm1', 'Memberone');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.m1), 1);
  assert.equal(await s.w.count('audit_log', "action = 'block.match'"), 1);
  // An officer lifts it: the earlier tombstones go with it, so the next sign-in is clean.
  await s.ok('o1', 'DELETE', `/people/${s.uids.m1}/block`, undefined, 200);
  assert.equal(await s.w.count('block_tombstones'), 0);
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal((await s.ok('o1', 'GET', '/attention')).items.filter((item) => item.kind === 'block_review').length, 0);
  await signInAgain(s, 'm1', 'Memberone');
  assert.equal(await s.w.count('guild_blocks'), 0);
});

check('match: the same Battle.net account or Battle.net-proven character on a brand-new account matches; another guild\'s tombstones never do; a key version with no key cannot match', async () => {
  const s = await world();
  const t = await tomb();
  await proven(s);
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  s.exec(`DELETE FROM users WHERE id = '${s.uids.m1}'`);
  const run = async (userId, keys, env = s.w.env, log = null) => {
    const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId, keys, env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, log });
    if (statements.length) await s.w.db.batch(statements);
    return statements.length;
  };
  const fresh = await s.member('fresh1', 'Freshone');
  assert.equal(await run(fresh, { bnetAccountId: '111' }), 0, 'another Battle.net account');
  assert.equal(await run(fresh, { identityKeys: [`idkey:${NAMESPACE}:${REALM_ID}:7002`], discordId: '1' }), 0);
  assert.equal(await run(fresh, { bnetAccountId: BNET_ID }), 2, 'the Battle.net account id');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND pending_review = 1', fresh), 1);
  const second = await s.member('fresh2', 'Freshtwo');
  assert.equal(await run(second, { identityKeys: [{ namespace: NAMESPACE, realmId: REALM_ID, charId: 7001 }] }), 2, 'the Battle.net-proven character (identity key)');
  assert.deepEqual(JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'block.match' AND entity_id = ?", second)).after).kinds, ['idkey']);
  // The block's tombstone is per guild: the same ids in another guild hash differently, so nothing there matches.
  assert.notEqual(await hmacOf(s.gid, `bnet:${BNET_ID}`), await hmacOf('g_other', `bnet:${BNET_ID}`));
  // No key at all: nothing matches and one line says so. A version without a key: its tombstones cannot be matched and a line says so.
  const third = await s.member('fresh3', 'Freshthree');
  const logs = [];
  assert.equal(await run(third, { bnetAccountId: BNET_ID }, {}, (line) => logs.push(line)), 0);
  assert.equal(await run(third, { bnetAccountId: BNET_ID }, { TOMBSTONE_KEY: `${KEY}-rotated`, TOMBSTONE_KEY_VERSION: '2' }, (line) => logs.push(line)), 0);
  assert(logs.some((line) => /key version 1/.test(line)), logs.join('|'));
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', third), 0);
});

check('match: key rotation - tombstones of every version stay verifiable through TOMBSTONE_OLD_KEYS, new blocks use the current key', async () => {
  const s = await world();
  const t = await tomb();
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  const newKey = 'rotated-tombstone-key-abcdef0123456789';
  const rotated = { TOMBSTONE_KEY: newKey, TOMBSTONE_KEY_VERSION: '2', TOMBSTONE_OLD_KEYS: `1:${KEY}` };
  // A new block under the new key (m2) is version 2; the old one stays version 1.
  s.w.env.TOMBSTONE_KEY = newKey; s.w.env.TOMBSTONE_KEY_VERSION = '2'; s.w.env.TOMBSTONE_OLD_KEYS = `1:${KEY}`;
  await s.ok('o1', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  assert.deepEqual((await tombstones(s)).map((row) => [row.block_ref, row.key_version]).sort(), [[`u:${s.uids.m1}`, 1], [`u:${s.uids.m2}`, 2]].sort());
  assert.equal((await tombstones(s, `u:${s.uids.m2}`))[0].hmac, await hmacOf(s.gid, `discord:${discord('m2').id}`, newKey));
  // Both blocked people come back as new accounts: both are matched.
  const old = { m1: discord('m1').id, m2: discord('m2').id };
  s.exec(`DELETE FROM users WHERE id IN ('${s.uids.m1}', '${s.uids.m2}')`);
  const probe = async (key) => {
    const fresh = await s.member(`probe_${key}`, `Probe${key}`);
    const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId: fresh, keys: { discordId: old[key] }, env: rotated, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
    return statements.length;
  };
  assert.equal(await probe('m1'), 2, 'the version-1 tombstone through the old key');
  assert.equal(await probe('m2'), 2, 'the version-2 tombstone through the current key');
});

check('match: the Owner and a GM-tier account are never blocked by a match - only an officer review item, once a day however often they sign in', async () => {
  const s = await world();
  const t = await tomb();
  // An old block's tombstone for the Guild Master's own Discord id (the id was once somebody else's account).
  s.exec(`INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('${s.gid}', 'u:u_${'o'.repeat(22)}', 1, '${await hmacOf(s.gid, `discord:${discord('gm').id}`)}', 1)`);
  const { jar } = await signIn(s.w, discord('gm', 'Gmb3'), [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '8' }]);
  s.jars.gm = jar;
  assert.equal(await s.w.count('guild_blocks'), 0, 'the Owner is not blocked');
  assert.equal((await s.call('gm', 'GET', '')).status, 200);
  let held = await s.rows("SELECT entity_id, after FROM audit_log WHERE action = 'block.match_held'");
  assert.deepEqual(held.map((row) => [row.entity_id, JSON.parse(row.after).reason]), [[s.uids.gm, 'owner']]);
  await signIn(s.w, discord('gm', 'Gmb3'), []);
  assert.equal(await s.w.count('audit_log', "action = 'block.match_held'"), 1, 'one row a day');
  s.w.advance(25 * 60 * 60 * 1000);
  await signIn(s.w, discord('gm', 'Gmb3'), []);
  assert.equal(await s.w.count('audit_log', "action = 'block.match_held'"), 2, 'and again the next day');
  const item = (await s.ok('o1', 'GET', '/attention')).items.find((entry) => entry.kind === 'block_review');
  assert.deepEqual([item.count, item.pending, item.held], [1, 0, 1], 'one account held back, counted once');
  // A GM-tier account that is not the Owner: the seat moves to o2, the Guild Master row stays with gm.
  s.setOwner('o2');
  s.w.advance(25 * 60 * 60 * 1000);
  await signIn(s.w, discord('gm', 'Gmb3'), []);
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal(JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'block.match_held' ORDER BY created_at DESC LIMIT 1")).after).reason, 'gm');
});

check('match: an account whose character holds the in-game Guild Master rank (rank map) is GM tier through its identity key - held back, never blocked', async () => {
  const s = await ingameWorld();
  const t = await tomb();
  s.exec(`INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('${s.gid}', 'u:u_${'o'.repeat(22)}', 1, '${await hmacOf(s.gid, 'discord:150000000000000001')}', 1)`);
  const acct = await s.member('ranked', 'Rankedone');
  const keys = { discordId: '150000000000000001', identityKeys: [`idkey:${NAMESPACE}:${REALM_ID}:8003`] };
  const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId: acct, keys, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
  assert.equal(statements.length, 1);
  await s.w.db.batch(statements);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', acct), 0);
  assert.equal(JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'block.match_held'")).after).reason, 'gm');
  // The same Discord id on an account with no such character is blocked.
  const plain = await s.member('plainone', 'Plainone');
  const second = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId: plain, keys: { discordId: '150000000000000001' }, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
  assert.equal(second.length, 2);
});

check('match: a hit on an account equal or senior to the officer who made the block inserts no block, only a review item; a junior account is blocked pending review (A9-05)', async () => {
  const s = await world();
  const t = await tomb();
  await s.member('m3', 'Memberthree');
  // o1 (Officer) blocks m1; the Guild Master (the Owner) blocks m2.
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  await s.ok('gm', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  const roleOf = async (id) => (await s.one("SELECT actor_role FROM audit_log WHERE action = 'access.remove' AND entity_id = ?", id)).actor_role;
  assert.deepEqual([await roleOf(s.uids.m1), await roleOf(s.uids.m2)], ['officer', 'owner']);
  const match = async (userId, keys) => {
    const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId, keys, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
    if (statements.length) await s.w.db.batch(statements);
    return statements.length;
  };
  const m1Keys = { discordId: discord('m1').id };
  const m2Keys = { discordId: discord('m2').id };
  // The blocked people leave; their keys come back on accounts of various ranks.
  s.exec(`DELETE FROM users WHERE id IN ('${s.uids.m1}', '${s.uids.m2}')`);
  assert.equal(await match(s.uids.o2, m1Keys), 1, 'a second Officer ranks the same as the Officer who blocked: held back');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.o2), 0);
  assert.equal(JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'block.match_held' AND entity_id = ?", s.uids.o2)).after).reason, 'senior');
  assert.equal(await match(s.uids.tla, m1Keys), 2, 'a Team Lead is junior to an Officer: blocked pending review');
  assert.equal((await s.one('SELECT pending_review, blocked_by FROM guild_blocks WHERE user_id = ?', s.uids.tla)).pending_review, 1);
  // The Owner blocked m2: an Officer (rank 1) is junior to the Owner (rank 0) and IS blocked; the Owner's own account is held back.
  assert.equal(await match(s.uids.o1, m2Keys), 2);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.o1), 1);
  assert.equal(await match(s.uids.m3, m1Keys), 2, 'a plain member is blocked');
  const item = (await s.ok('gm', 'GET', '/attention')).items.find((entry) => entry.kind === 'block_review');
  assert.deepEqual([item.count, item.pending, item.held], [4, 3, 1]);
  // The same account is never matched twice.
  assert.equal(await match(s.uids.m3, m1Keys), 0);
});

check('match: a person block is matched through its Discord id (p:<player>); a block with no readable blocker snapshot (made before this build) counts as an Officer\'s', async () => {
  const s = await ingameWorld();
  const t = await tomb();
  const who = s.people.Memberguy;
  s.exec(`UPDATE players SET discord_user_id = '140000000000000001' WHERE id = '${who.pid}'`);
  assert.equal((await blockPerson(s, 'gm', 'Memberguy')).status, 200);
  assert.equal((await s.one("SELECT actor_role FROM audit_log WHERE action = 'person.block'")).actor_role, 'owner');
  const match = async (userId, keys) => {
    const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId, keys, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
    if (statements.length) await s.w.db.batch(statements);
    return statements.length;
  };
  const claimer = await s.member('claimer', 'Claimerone');
  assert.equal(await match(claimer, { discordId: '140000000000000001' }), 2, 'the person\'s Discord id is recognised on a new account');
  assert.equal((await s.one('SELECT pending_review FROM guild_blocks WHERE user_id = ?', claimer)).pending_review, 1);
  // A tombstone whose block has no audit row at all (a block of an earlier release, repaired later): the blocker counts as an Officer.
  s.exec(`INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('${s.gid}', 'u:u_${'q'.repeat(22)}', 1, '${await hmacOf(s.gid, 'discord:160000000000000001')}', 1)`);
  assert.equal(await match(s.uids.o2, { discordId: '160000000000000001' }), 1, 'an Officer ranks with the blocker: held back');
  assert.equal(await match(s.uids.tla, { discordId: '160000000000000001' }), 2, 'a Team Lead is junior: blocked pending review');
});

check('match: the Discord LINK callback - an account that links a Discord id with a tombstone is blocked pending review at once; sign-in and link never fail because of a match error', async () => {
  const s = await world();
  await s.member('m3', 'Memberthree');
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  await s.ok('m1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  // m3 loses its Discord id (as a Battle.net-only account has none) and links the blocked person's Discord id.
  s.exec(`UPDATE users SET discord_id = NULL WHERE id = '${s.uids.m3}'`);
  s.w.discord.next = { user: { id: discord('m1').id, username: 'memberone', global_name: 'Memberone', avatar: null }, servers: [memberOf(SERVER)] };
  const login = await s.w.req('GET', '/auth/login?mode=link', { jar: s.jars.m3 });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars.m3 });
  assert.equal(callback.headers.get('Location'), '/#/linked', 'the link itself succeeded');
  assert.deepEqual(await s.one('SELECT pending_review, blocked_by FROM guild_blocks WHERE user_id = ?', s.uids.m3), { pending_review: 1, blocked_by: null });
  assert.equal(await s.w.count('audit_log', "action = 'block.match' AND entity_id = ?", s.uids.m3), 1);
  // A match that throws is logged and the sign-in still completes.
  const t = await load('worker/block-tombstones.js');
  const logs = [];
  const broken = { db: { prepare() { throw new Error('boom'); }, batch() { throw new Error('boom'); } }, env: {}, now: () => 1, randomBytes: s.w.randomBytes, log: (line) => logs.push(line) };
  assert.equal(await t.matchAccountAtSignIn(broken, s.uids.m3), 0);
  assert(logs.some((line) => /^tombstone match failed: boom/.test(line)));
});

check('match: only the guilds the account reaches and that HAVE tombstones are looked at, and the Discord callbacks add no write when nothing matches', async () => {
  const s = await world();
  const t = await tomb();
  assert.deepEqual(await t.candidateGuildIds(s.w.db, s.uids.m1, discord('m1').id), [], 'no tombstones anywhere');
  await s.ok('o1', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  assert.deepEqual(await t.candidateGuildIds(s.w.db, s.uids.m1, discord('m1').id), [s.gid], 'm1 reaches the guild through its Discord server');
  assert.deepEqual(await t.candidateGuildIds(s.w.db, s.uids.m1, null), [s.gid]);
  const outsider = await s.outsider('out1', 'Outsider');
  assert.deepEqual(await t.candidateGuildIds(s.w.db, outsider, '999'), [], 'an account in no server of the guild and linked to nobody');
  // A clean sign-in writes no block and no audit row.
  const before = await s.w.count('audit_log');
  await signInAgain(s, 'm1', 'Memberone');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.m1), 0);
  assert.equal(await s.w.count('audit_log'), before);
});

check('config audit events: rank-map edits and webhook changes are audited and permanent; the retention job and the trigger leave them alone', async () => {
  const s = await world();
  const { AUDIT_ACTIONS, PRUNABLE_ACTIONS } = await load('worker/audit.js');
  for (const action of ['rank_map.update', 'notify.update', 'access.remove', 'access.restore', 'guild.claim', 'guild.create', 'guild_master.transfer', 'person.block', 'block.match', 'block.match_held']) {
    assert(AUDIT_ACTIONS.includes(action), `${action} is audited`);
    assert(!PRUNABLE_ACTIONS.includes(action), `${action} is never pruned`);
  }
  assert(!/guild\.(pin|flip)|owner\.(restore|identity)/.test(fs.readFileSync(path.join(ROOT, 'worker', 'audit.js'), 'utf8')), 'the events whose code paths do not exist yet are not declared early');
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => Date.now() - 400 * DAY };
  const { auditStatement } = await load('worker/audit.js');
  await s.w.db.batch([auditStatement(ctx, { guildId: s.gid, actorUserId: s.uids.gm, action: 'rank_map.update', entityType: 'guild', entityId: s.gid })]);
  const rt = await load('worker/retention.js');
  await rt.runRetention({ db: s.w.db, now: () => Date.now(), log: () => {} });
  assert.equal(await s.w.count('audit_log', "action = 'rank_map.update'"), 1);
});

runChecks(checks);
