/**
 * Raidsmith guild tracker - the IDENTITY SPLIT FIX BATCH of the user-hierarchy build (branch guild/hier-idfix; the six items of the lane prompt)
 * Run: node tests/guild/guild-hier-idfix-tests.js [name filter]
 *
 *   1  a link the 0039 backfill wrote from a Discord ID match (players.user_id_backfilled = 1) is the account's person and no membership in a legacy guild: an account that left the
 *      Discord server is out; a confirmed link, a Battle.net proof of the account and a new owner still count; manual and in-game guilds read no flag;
 *   2  the flip dry run links nobody: a Discord ID recorded on a person is never an owner, so a member whose person only records their Discord ID loses access as needs_claim, the
 *      person is listed in the needsClaim section, and nothing is written (the numbers are pinned in guild-b5-flip-tests.js);
 *   3  PUT /roster/:pid/rank runs the Seniority guard, before the write and inside it; dismissing a suggestion changes nobody's rank and stays open;
 *   4  the Link account dialog says what it does (the copy is pinned in guild-accounts-ui-tests.js);
 *   5  a blocked account that links a NEW Discord account gets the block tombstone for that Discord id, in each guild that blocks it;
 *   6  a Blizzard outage (5xx) during a Guild Master claim gives the start budgets back like a malformed roster; a definite refusal (403) stays counted.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { ownPerson } = require('../guild-owner-fixture');
const { ACCOUNT, claimWorld, claim, refused, DONE, tieToGuild, seatOf } = require('../guild-claim');
const { freshScenario } = require('../guild-fresh');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      const worlds = [];
      globalThis.__fixWorlds = worlds;
      globalThis.__claimWorlds = worlds;
      try { await fn(); } finally { await Promise.all(worlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 100)); }
    },
  });
}
const KEY = 'a-test-tombstone-key-of-16-plus-chars';

// ---------------------------------------------------------------------------
// 1. A backfilled link is ownership, not membership

const guildGet = (s, who) => s.call(who, 'GET', '');
const memberGuildIds = async (s, who) => (await s.ok(who, 'GET', '/auth/me')).guilds.map((guild) => guild.id);
const flagOf = async (s, pid) => (await s.one('SELECT user_id, user_id_backfilled AS flag FROM players WHERE id = ?', pid));
const leaveServer = (s, ...keys) => s.exec(`DELETE FROM user_servers WHERE user_id IN (${keys.map((key) => `'${s.uids[key]}'`).join(', ')})`);

check('a backfilled link is the account\'s person but no membership in a legacy guild: out of the Discord server = out of the guild; a confirmed link, a proof and a new owner still count', async () => {
  const { ownPersonStatement } = await load('worker/membership.js');
  const s = await scenario();
  for (const [key, name] of [['bf', 'Backfilledone'], ['conf', 'Confirmedone'], ['prf', 'Provedone'], ['rel', 'Relinkedone']]) await s.member(key, name);
  const person = {};
  for (const key of ['bf', 'conf', 'prf', 'rel']) {
    person[key] = await s.person({ name: `${key}main` });
    ownPerson(s.w.db.sqlite, person[key].pid, s.uids[key]);
  }
  // bf, prf and rel carry a link the backfill wrote; conf has a link an officer, a proof or a claim made (flag 0).
  s.exec(`UPDATE players SET user_id_backfilled = 1 WHERE id IN ('${person.bf.pid}', '${person.prf.pid}', '${person.rel.pid}')`);
  for (const key of ['bf', 'conf', 'prf', 'rel']) assert.equal((await guildGet(s, key)).status, 200, `${key}: in the server, a member`);
  leaveServer(s, 'bf', 'conf', 'prf', 'rel');

  // The backfilled account is out: no guild, 403 not_member. Its person is still its own.
  const gone = await guildGet(s, 'bf');
  assert.deepEqual([gone.status, gone.json.error], [403, 'not_member'], gone.text);
  assert.deepEqual(await memberGuildIds(s, 'bf'), []);
  assert.equal((await ownPersonStatement(s.w.db, s.gid, s.uids.bf).first()).id, person.bf.pid, 'ownership is untouched');
  // The confirmed link still lets its account in (a legacy link is a membership).
  assert.equal((await guildGet(s, 'conf')).status, 200);
  assert.deepEqual(await memberGuildIds(s, 'conf'), [s.gid]);

  // A Battle.net proof of the very account on a character of the person confirms the link.
  assert.equal((await guildGet(s, 'prf')).status, 403, 'before the proof');
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.prf}', proof_bnet_account_id = '4711', proof_at = 1 WHERE id = '${person.prf.cid}'`);
  assert.deepEqual(await flagOf(s, person.prf.pid), { user_id: s.uids.prf, flag: 0 });
  assert.equal((await guildGet(s, 'prf')).status, 200, 'after the proof');
  // A proof of ANOTHER account on the person confirms nothing.
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.conf}', proof_bnet_account_id = '4712', proof_at = 1 WHERE id = '${person.bf.cid}'`);
  assert.deepEqual(await flagOf(s, person.bf.pid), { user_id: s.uids.bf, flag: 1 }, 'the flag stays');
  assert.equal((await guildGet(s, 'bf')).status, 403);
  // A proof written by an INSERT (a character created with its proof) does the same.
  s.exec(`INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, owner_proof, proof_user_id, proof_bnet_account_id, proof_at)
          VALUES ('c_new_proof', '${s.gid}', '${person.bf.pid}', 'Newproof', 'newproof', 'Nightslayer', 'nightslayer', 'MAGE', 0, 1, 1, 'raider', 'bnet', '${s.uids.bf}', '4713', 1)`);
  assert.deepEqual(await flagOf(s, person.bf.pid), { user_id: s.uids.bf, flag: 0 });
  assert.equal((await guildGet(s, 'bf')).status, 200, 'a proof of the account behind the link');

  // A change of owner clears the flag: an unlink (user_id NULL) leaves no flag behind, and the next link, whoever made it, is a plain one.
  assert.equal((await guildGet(s, 'rel')).status, 403);
  s.exec(`UPDATE players SET user_id = NULL WHERE id = '${person.rel.pid}'`);
  assert.deepEqual(await flagOf(s, person.rel.pid), { user_id: null, flag: 0 });
  ownPerson(s.w.db.sqlite, person.rel.pid, s.uids.rel);
  assert.deepEqual(await flagOf(s, person.rel.pid), { user_id: s.uids.rel, flag: 0 });
  assert.equal((await guildGet(s, 'rel')).status, 200, 'linked again: a member');
});

check('manual and in-game guilds read no flag: a backfilled link is a link there (their rules are unchanged); a legacy account that is still in the Discord server is a member either way', async () => {
  const s = await scenario();
  await s.member('bf', 'Backfilledone');
  await s.member('in', 'Inserverone');
  const bf = await s.person({ name: 'Bfmain' });
  const inServer = await s.person({ name: 'Inmain' });
  ownPerson(s.w.db.sqlite, bf.pid, s.uids.bf);
  ownPerson(s.w.db.sqlite, inServer.pid, s.uids.in);
  s.exec(`UPDATE players SET user_id_backfilled = 1 WHERE id IN ('${bf.pid}', '${inServer.pid}')`);
  leaveServer(s, 'bf');
  assert.equal((await guildGet(s, 'bf')).status, 403, 'legacy: out');
  assert.equal((await guildGet(s, 'in')).status, 200, 'legacy: in the server, a member with a backfilled link');
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  assert.equal((await guildGet(s, 'bf')).status, 200, 'manual: a link is a link');
  assert.deepEqual(await memberGuildIds(s, 'bf'), [s.gid]);
});

check('the flag column: default 0 for every new person, NOT NULL, and no statement of the code writes it besides the migration and the two clearing triggers', async () => {
  const s = await scenario();
  const created = await s.person({ name: 'Plainmain' });
  assert.equal((await flagOf(s, created.pid)).flag, 0);
  const column = (await s.rows("SELECT name, type, \"notnull\" AS nn, dflt_value AS dflt FROM pragma_table_info('players') WHERE name = 'user_id_backfilled'"))[0];
  assert.deepEqual({ ...column }, { name: 'user_id_backfilled', type: 'INTEGER', nn: 1, dflt: '0' });
  const triggers = (await s.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%backfill%' OR name LIKE '%confirms_link' ORDER BY name")).map((row) => row.name);
  assert.deepEqual(triggers, ['characters_bnet_proof_confirms_link', 'characters_bnet_proof_update_confirms_link', 'players_user_change_clears_backfill']);
  // A source scan: only membership.js reads the flag (worker/); nothing writes it.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'worker');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const users = walk(dir).filter((file) => fs.readFileSync(file, 'utf8').includes('user_id_backfilled')).map((file) => path.relative(dir, file).split(path.sep).join('/'));
  assert.deepEqual(users, ['membership.js'], 'only the one membership definition reads the flag');
});

// ---------------------------------------------------------------------------
// 2. The flip links nobody

check('the flip dry run writes nothing and links nobody: a member whose person only records their Discord ID loses access as needs_claim, and that person is in the needsClaim section', async () => {
  const s = await scenario();
  await s.member('rec', 'Recordedone');
  const person = await s.person({ name: 'Recordedmain' });
  const discordId = (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.rec)).discord_id;
  s.exec(`UPDATE players SET discord_user_id = '${discordId}' WHERE id = '${person.pid}'`);
  const before = JSON.stringify(await s.rows('SELECT id, user_id, user_id_backfilled, discord_user_id FROM players ORDER BY id'));
  const res = await s.call('gm', 'POST', '/flip/dry-run', {});
  assert.equal(res.status, 200, res.text);
  const lost = res.json.access.loses.samples.find((entry) => entry.reason === 'needs_claim');
  assert(lost, res.text);
  assert.deepEqual([lost.personId, lost.name, lost.userId], [person.pid, 'Recordedmain', undefined]);
  assert.equal(res.json.discordOwned, undefined);
  assert.deepEqual(res.json.needsClaim.samples.map((entry) => entry.personId), [person.pid]);
  assert(!res.text.includes(discordId), 'no Discord id in the answer');
  assert.equal(JSON.stringify(await s.rows('SELECT id, user_id, user_id_backfilled, discord_user_id FROM players ORDER BY id')), before, 'nothing was linked');
});

// ---------------------------------------------------------------------------
// 3. PUT /roster/:pid/rank and the Seniority guard

const LADDER = [
  { id: 'member', name: 'Member', rules: {} },
  { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2 } },
];
async function rankWorld() {
  const s = await scenario();
  const [alpha] = s.tids;
  s.alpha = alpha;
  await s.officer('off1', 'Offone');
  await s.lead('tl', [alpha], 'Leadone');
  await s.lead('tl2', [alpha], 'Leadtwo');
  await s.member('m1', 'Memone');
  s.ppl = {};
  for (const [key, owner] of [['senior', 'off1'], ['peer', 'tl2'], ['own', 'tl'], ['junior', 'm1'], ['nobody', null]]) {
    s.ppl[key] = await s.person({ name: `${key}main` });
    if (owner) ownPerson(s.w.db.sqlite, s.ppl[key].pid, s.uids[owner]);
  }
  const view = await s.ok('gm', 'GET', '/attendance/policy');
  const saved = await s.call('gm', 'PUT', '/attendance/policy', { policy: { ladder: { ranks: LADDER } }, expectedVersion: view.versions.guild });
  assert.equal(saved.status, 200, saved.text);
  s.put = (who, key, rank, extra = {}) => s.call(who, 'PUT', `/roster/${s.ppl[key].pid}/rank`, { teamId: alpha, rank, ...extra });
  s.rankOf = async (key) => (await s.one('SELECT rank, rank_on, version FROM players WHERE id = ?', s.ppl[key].pid));
  return s;
}

check('PUT rank: a Team Lead cannot rank a senior or an equal; an unlinked person, a junior and their own person are fine; an Officer above them and the Guild Master may', async () => {
  const s = await rankWorld();
  const audits = () => s.w.count('audit_log', "action = 'person.rank'");
  // Seed a dismissal so a refused call can be seen to leave it alone.
  s.exec(`INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, dismissed_by, created_at) VALUES ('${s.gid}', '${s.ppl.senior.pid}', 'promote', 'raider', 9999999999999, '${s.uids.gm}', 1)`);
  for (const [key, label] of [['senior', 'an Officer\'s person'], ['peer', 'a peer\'s person']]) {
    const before = await s.rankOf(key);
    const res = await s.put('tl', key, 'raider');
    assert.deepEqual([res.status, res.json.error], [403, 'seniority'], `${label}: ${res.text}`);
    assert.deepEqual(await s.rankOf(key), before, `${label}: unchanged`);
    const cleared = await s.put('tl', key, null);
    assert.deepEqual([cleared.status, cleared.json.error], [403, 'seniority'], `${label}, clearing: ${cleared.text}`);
    // Nothing about the rank leaks to a junior: not even the 409 that names it.
    const stale = await s.put('tl', key, 'raider', { expectedRank: 'member' });
    assert.deepEqual([stale.status, stale.json.error], [403, 'seniority'], `${label}, stale expectation: ${stale.text}`);
  }
  assert.equal(await audits(), 0);
  assert.equal(await s.w.count('rank_dismissals'), 1, 'the dismissal stands');
  for (const key of ['junior', 'own', 'nobody']) {
    const res = await s.put('tl', key, 'raider');
    assert.equal(res.status, 200, `${key}: ${res.text}`);
    assert.equal((await s.rankOf(key)).rank, 'raider', key);
  }
  assert.equal(await audits(), 3);
  // The senior Officer's own person is theirs to rank, and the Guild Master may rank anyone, the Officer included.
  assert.equal((await s.put('off1', 'senior', 'raider')).status, 200);
  assert.equal((await s.put('gm', 'senior', 'member')).status, 200);
  assert.equal((await s.put('gm', 'peer', 'raider')).status, 200);
  assert.equal((await s.rankOf('peer')).rank, 'raider');
  // The same Officer rank is "equal": an Officer cannot rank another Officer's person; they can rank the Team Lead's.
  await s.officer('off2', 'Offtwo');
  assert.deepEqual([(await s.put('off2', 'senior', 'raider')).status], [403]);
  assert.equal((await s.put('off2', 'own', 'member')).status, 200);
  // A no-change call from someone who may not touch the person is refused too (the guard comes first).
  assert.equal((await s.put('tl', 'senior', 'member')).status, 403);
});

check('PUT rank: the guard sits inside the write - a person promoted between the pre-check and the batch changes nothing (403, the dismissal and the log untouched)', async () => {
  const s = await rankWorld();
  s.exec(`INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, dismissed_by, created_at) VALUES ('${s.gid}', '${s.ppl.junior.pid}', 'promote', 'raider', 9999999999999, '${s.uids.gm}', 1)`);
  const db = s.w.db;
  const batch = db.batch.bind(db);
  let promote = () => s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
    VALUES ('ra_idfix', '${s.gid}', '${s.uids.m1}', 'officer', NULL, '${s.uids.gm}', 1)`);
  db.batch = async (statements) => {
    if (promote && statements.some((statement) => /^UPDATE players SET rank = /.test(statement.sql))) {
      const run = promote;
      promote = null;
      run();
    }
    return batch(statements);
  };
  const before = await s.rankOf('junior');
  const res = await s.put('tl', 'junior', 'raider');
  db.batch = batch;
  assert.equal(promote, null, 'the promotion ran between the read and the batch');
  assert.deepEqual([res.status, res.json.error], [403, 'seniority'], res.text);
  assert.deepEqual(await s.rankOf('junior'), before, 'the rank did not move');
  assert.equal(await s.w.count('audit_log', "action = 'person.rank'"), 0);
  assert.equal(await s.w.count('rank_dismissals'), 1, 'a write that did not happen keeps the dismissal');
});

check('dismissing a suggestion changes nobody\'s rank or standing, so it stays open to whoever may review the team (a senior\'s suggestion included)', async () => {
  const s = await rankWorld();
  const res = await s.call('tl', 'POST', `/roster/${s.ppl.senior.pid}/rank/dismiss`, { teamId: s.alpha, kind: 'promote', to: 'raider' });
  assert.equal(res.status, 200, res.text);
  assert.equal((await s.rankOf('senior')).rank, null);
});

// ---------------------------------------------------------------------------
// 5. A blocked account that links a NEW Discord account

const OTHER = { id: '777000000000000001', username: 'blockedone', globalName: 'Blockedone' };
const tombstonesOf = (s, ref) => s.rows('SELECT block_ref, hmac FROM block_tombstones WHERE guild_id = ? AND block_ref = ? ORDER BY hmac', s.gid, ref);
const blockRow = (s, key, extra = '') => s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at${extra ? ', pending_review' : ''}) VALUES ('${s.gid}', '${s.uids[key]}', '${s.uids.gm}', 'Rude', 1${extra ? ', 1' : ''})`);

check('blocked account + a NEW Discord account: the new Discord id is tombstoned under the block, matches a brand-new account; an unblocked account, a pending-review block and a refresh write nothing', async () => {
  const t = await load('worker/block-tombstones.js');
  const s = await freshScenario({ env: { TOMBSTONE_KEY: KEY } });
  globalThis.__fixWorlds.push(s);
  await s.bnetSignUp('bl', { id: '740000011', battletag: 'Blo#0011' });
  await s.bnetSignUp('ok', { id: '740000012', battletag: 'Okay#0012' });
  await s.bnetSignUp('pend', { id: '740000013', battletag: 'Pend#0013' });
  blockRow(s, 'bl');
  blockRow(s, 'pend', 'pending');
  assert.equal((await tombstonesOf(s, `u:${s.uids.bl}`)).length, 0, 'a Battle.net-only account has no key yet');

  // An account that is not blocked links Discord: nothing is written.
  assert.equal(await s.linkDiscord('ok', { ...OTHER, id: '777000000000000002' }), '/#/linked');
  assert.equal(await s.w.count('block_tombstones'), 0);
  // A pending-review block waits for an officer's Keep.
  assert.equal(await s.linkDiscord('pend', { ...OTHER, id: '777000000000000003' }), '/#/linked');
  assert.equal(await s.w.count('block_tombstones'), 0);
  // The blocked account links a NEW Discord account.
  assert.equal(await s.linkDiscord('bl', OTHER), '/#/linked');
  assert.equal((await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.bl)).discord_id, OTHER.id);
  const rows = await tombstonesOf(s, `u:${s.uids.bl}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hmac, await t.tombstoneHmac(KEY, s.gid, `discord:${OTHER.id}`), 'the HMAC of discord:<id> in this guild');
  // A brand-new account that presents this Discord id is recognised (blocked for review).
  const stranger = await s.member('stranger', 'Strangerone');
  const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId: stranger, keys: { discordId: OTHER.id }, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
  assert(statements.length > 0, 'the tombstone matches');
  await s.w.db.batch(statements);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND pending_review = 1', stranger), 1);
  // The same Discord account again (a refresh) writes nothing new.
  assert.equal(await s.linkDiscord('bl', OTHER), '/#/linked');
  assert.equal((await tombstonesOf(s, `u:${s.uids.bl}`)).length, 1);
  // An unblock lifts the tombstone with the rest.
  assert.equal((await s.call('gm', 'DELETE', `/people/${s.uids.bl}/block`, {})).status, 200);
  assert.equal((await tombstonesOf(s, `u:${s.uids.bl}`)).length, 0);
});

check('blocked account + a NEW Discord account without a usable TOMBSTONE_KEY: the block is flagged for the daily repair, which adds the Discord id from the account\'s current keys', async () => {
  const t = await load('worker/block-tombstones.js');
  const s = await freshScenario();
  globalThis.__fixWorlds.push(s);
  await s.bnetSignUp('bl', { id: '740000021', battletag: 'Blo#0021' });
  blockRow(s, 'bl');
  s.w.logs.length = 0;
  assert.equal(await s.linkDiscord('bl', OTHER), '/#/linked');
  assert.equal(await s.w.count('block_tombstones'), 0, 'no key, no tombstone');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND tombstone_missing = 1', s.uids.bl), 1, 'flagged for the repair');
  assert(s.w.logs.some((line) => /TOMBSTONE_KEY is not set/.test(line)), 'and the operator line says why');
  const env = { ...s.w.env, TOMBSTONE_KEY: KEY };
  const repaired = await t.repairTombstones({ db: s.w.db, env, now: () => s.w.clock.now, log: () => {} });
  assert.equal(repaired.repaired, 1);
  const rows = await tombstonesOf(s, `u:${s.uids.bl}`);
  assert(rows.some((row) => row.hmac === null) === false);
  assert(rows.map((row) => row.hmac).includes(await t.tombstoneHmac(KEY, s.gid, `discord:${OTHER.id}`)), 'the repair added the new Discord account');
});

// ---------------------------------------------------------------------------
// 6. A Blizzard outage during a Guild Master claim

check('claim: a Blizzard outage (5xx on the roster or on the account profile) is "provider" and gives the start budgets back; a definite refusal (403) is "provider" too but stays counted', async () => {
  const s = await claimWorld();
  tieToGuild(s, 'igm');
  const count = async (key) => ((await s.one('SELECT count FROM rate_limits WHERE key = ?', key)) || { count: 0 }).count;
  const budget = async () => ({
    session: await count(`fresh:s:${s.sessionHash('igm')}`),
    account: await count(`fresh:${s.uids.igm}`),
    callback: await count(`bnetcb:${ACCOUNT.igm.id}`),
  });
  const start = await budget(); // the callback window already holds the Battle.net sign-in that made the account
  // Twelve attempts while Blizzard is down (the start budget is ten): all start, all end "try again later", nothing is counted against the claimant.
  for (const [call, status] of [['roster', 500], ['profile', 503]]) {
    s.bnet.state.fail[call] = status;
    s.w.logs.length = 0;
    for (let i = 0; i < 6; i++) {
      const out = await claim(s, 'igm');
      assert.equal(out.start.status, 200, `${call} attempt ${i + 1}`);
      assert.equal(out.location, refused('provider'), `${call} attempt ${i + 1}`);
    }
    s.bnet.state.fail[call] = 0;
    assert(s.w.logs.some((line) => line.includes('gm claim: Blizzard step failed: unavailable')), s.w.logs.join(' | '));
  }
  assert.deepEqual(await budget(), start, 'twelve starts, twelve refunds');
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 0, 'no failed claim in the log');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'auditfail:%'"), 0, 'no failure counter');
  // Blizzard is back: the real claim goes through.
  const real = await claim(s, 'igm');
  assert.equal(real.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
});

check('claim: a definite Blizzard refusal (403) keeps the budgets counted - only an outage is given back', async () => {
  const s = await claimWorld();
  tieToGuild(s, 'igm');
  s.bnet.state.fail.roster = 403;
  for (let i = 0; i < 3; i++) assert.equal((await claim(s, 'igm')).location, refused('provider'), `attempt ${i + 1}`);
  s.bnet.state.fail.roster = 0;
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:s:${s.sessionHash('igm')}`)).count, 3, 'every start stays counted');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:${s.uids.igm}`)).count, 3);
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 0, 'still not a failed claim');
});

runChecks(checks);
