/**
 * Raidsmith guild tracker - lane B6b part 2b of the user-hierarchy build: the Guild Master's claim of the Owner seat (worker/gm-claim.js, worker/routes/bnet.js,
 * worker/routes/fresh.js, worker/routes/claim-review.js, worker/bnet-match.js claimCharacterStatements, worker/rehome.js toPlanned)
 * Run: node tests/guild/guild-b6b3-claim-tests.js [name filter]
 *
 *   - the start step refuses a guild with no in-game seat to claim (409 claim_not_available) and a live Owner's own claim (409 already_owner); a suspended seat holder may claim;
 *   - the claim runs INSIDE the Battle.net fresh-auth callback and leaves no grant on the session; the decision is live Blizzard data only (the rank-0 member of the pinned guild's
 *     roster is one of the claimant's own characters, same Blizzard guild id): not the GM, a wrong guild, two rank-0 members -> /#/fresh?error=not_gm, nothing written, claim_failed
 *     counted; a Blizzard failure -> provider; the decision reads no characters, players, guild_blocks or tombstones;
 *   - the batch: the seat moves from the seat as read (NULL, a live Owner, a suspended one), a lost race applies NOTHING (conflict), a swapped statement order is refused; the
 *     claimant's block and the tombstones of their keys go, the dry-run approvals go (approval_invalid), the public page is unpublished, the audit row says who the previous holder was;
 *     bearer artifacts are not touched;
 *   - the claimant is LIVE right after: a squatter who typed the GM's name, hand-linked it to their own account, blocked the GM and left a tombstone on the key changes nothing and keeps
 *     every row (re-home), a GM that is new since the last sync is made live by applying the fetched roster first, and the claimant stays in after two more sign-ins;
 *   - the review list (Owner only), the claim_review attention item (dismissable), the statement budget of the whole callback on a 1,200-member roster and the query plans.
 * Drives worker/index.js over the node:sqlite D1 stand-in. Battle.net is tools/fake-battlenet.js on a local port with its profile and roster answers overridden so that the
 * account's characters and the guild's roster carry the same ids.
 */
const assert = require('node:assert/strict');
const { load, runChecks, STEP } = require('../guild-b3-world');
const { makeProven, rolesOf } = require('../guild-ingame');
const { scansSince } = require('../guild-plans');
const { NAMESPACE, REALM_ID } = require('../guild-seat');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__claimWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__claimWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 150)); } // (the sockets of the last world finish closing before process.exit)
    },
  });
}

const {
  SLUG, BLIZZARD_GUILD_ID, ID, ACCOUNT, KEY, OLD_KEY, DONE, refused, entry, profileOf, rosterBody, claimWorld, rosterRow, claim, tieToGuild, seatOf, auditRows, charactersOf, personOf, jsonOf, signInAgain, addBulkMembers,
} = require('../guild-claim');

// ---------------------------------------------------------------------------
// 1. The happy path

check('the claim: the GM of a live roster takes the seat from a live Owner and is LIVE at once (person, character, proof), inside the callback, with no grant left behind', async () => {
  const s = await claimWorld();
  assert.equal(await seatOf(s), s.uids.gm);
  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm, 'the seat moved to the claimant');
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'live: the Owner row and the derived Guild Master');
  assert.deepEqual(rolesOf(s, 'gm'), [], 'the previous Owner holds what their own rank gives: nothing');
  const person = await personOf(s, 'igm');
  assert(person, 'a person was made for the claimant');
  const characters = await charactersOf(s, person.id);
  assert.equal(characters.length, 1);
  assert.deepEqual([characters[0].name, characters[0].owner_proof, characters[0].proof_user_id, characters[0].blizzard_char_id, characters[0].is_main],
    ['Gmlive', 'bnet', s.uids.igm, ID.gm, 1]);
  assert.equal(characters[0].proof_bnet_account_id, ACCOUNT.igm.id);
  assert.deepEqual(await s.grantOf('igm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null }, 'no grant on the session: the claim ran inside the callback');
  const rows = await auditRows(s, 'guild.claim');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].actor_user_id, rows[0].actor_role, rows[0].entity_id], [s.uids.igm, 'owner', s.gid]);
  assert.deepEqual(jsonOf(rows[0].before), { guildMasterUserId: s.uids.gm, suspended: false });
  assert.deepEqual(jsonOf(rows[0].after), { guildMasterUserId: s.uids.igm, via: 'gm_claim' });
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'gm_claim'"), 1, 'one marker');
  // What the callback has used when the claim starts (the first statement of the claim is the identity read): the constant the claim counts its own statements on top of.
  const { STATEMENTS_BEFORE_CLAIM } = await load('worker/routes/bnet.js');
  const before = outcome.statements.findIndex((statement) => /u.discord_linked_at/.test(statement.sql));
  assert(before > 0 && before <= STATEMENTS_BEFORE_CLAIM, `the callback used ${before} statements before the claim; STATEMENTS_BEFORE_CLAIM says ${STATEMENTS_BEFORE_CLAIM}`);
  console.log(`      measured: the claim callback ran ${outcome.statements.length} D1 statements (${before} before the claim) and ${outcome.blizzard.length} Blizzard requests`);
});

// ---------------------------------------------------------------------------
// 2. The start step

check('start: only a guild with an in-game seat to claim (409 claim_not_available otherwise), never to the live Owner (409 already_owner); a suspended seat holder and the in-game Guild Master may start', async () => {
  const s = await claimWorld();
  const start = (who) => s.call(who, 'POST', '/fresh/start', { purpose: 'gm_claim', params: {} });
  const own = await start('gm');
  assert.deepEqual([own.status, own.json.error], [409, 'already_owner'], own.text);
  assert.equal((await start('igm')).status, 200, 'the in-game Guild Master (no member yet)');
  s.bnet.state.account = ACCOUNT.igm;
  for (const [sql, label] of [
    ["rank_source = 'manual'", 'a manual guild'],
    ['rank_source = NULL', 'a legacy guild'],
    ['blizzard_guild_id = NULL', 'a pin without the Blizzard guild id'],
    ['pinned_guild_slug = NULL', 'a pin without the guild slug'],
    ["pinned_namespace = 'profile-classicann-eu'", 'a pin in another namespace than the guild\'s region'],
  ]) {
    const saved = await s.one('SELECT rank_source, blizzard_guild_id, pinned_guild_slug, pinned_namespace FROM guilds WHERE id = ?', s.gid);
    s.exec(`UPDATE guilds SET ${sql} WHERE id = '${s.gid}'`);
    const refusal = await start('igm');
    assert.deepEqual([refusal.status, refusal.json.error], [409, 'claim_not_available'], `${label}: ${refusal.text}`);
    s.w.db.sqlite.prepare('UPDATE guilds SET rank_source = ?, blizzard_guild_id = ?, pinned_guild_slug = ?, pinned_namespace = ? WHERE id = ?')
      .run(saved.rank_source, saved.blizzard_guild_id, saved.pinned_guild_slug, saved.pinned_namespace, s.gid);
  }
  const member = await start('mem');
  assert.deepEqual([member.status, member.json.error], [409, 'identity_not_linked'], 'the claim is confirmed with Battle.net: a member with no Battle.net linked has nothing to confirm with');
  s.suspendOwner();
  assert.equal((await start('gm')).status, 200, 'a suspended seat holder may claim: it restores them when they are the live GM');
});

// ---------------------------------------------------------------------------
// 3. The decision: live Blizzard data only

const SNAPSHOT_TABLES = ['players', 'characters', 'character_name_aliases', 'person_joins', 'guild_blocks', 'block_tombstones', 'dry_run_approvals', 'role_assignments', 'raid_signups', 'fresh_act_markers', 'roster_syncs'];
const snapshotOf = async (s) => ({
  tables: Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, s.w.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((row) => ({ ...row }))])),
  guild: await s.one('SELECT owner_user_id, public_enabled, roster_hash, last_good_fetched_at FROM guilds WHERE id = ?', s.gid),
  audit: (await s.rows('SELECT action FROM audit_log WHERE guild_id = ? ORDER BY created_at, id', s.gid)).map((row) => row.action),
});
const TOUCHES_STORED = /\b(characters|players|guild_blocks|block_tombstones|person_blocks)\b/;

check('refused: not the rank-0 member / another Blizzard guild or realm -> not_gm, NOTHING written but the counted claim_failed row (one per hour, a counter); two rank-0 members / no rank-0 member -> provider, not counted', async () => {
  const s = await claimWorld();
  await s.bnetSignUp('oth', ACCOUNT.oth);
  s.live.profiles[ACCOUNT.oth.id] = [entry('Memberone', ID.mem)];
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.igm}', '${s.uids.gm}', 1)`);
  // Both claimants have a tie to the guild (a failure of a stranger is logged only: guild-b6b-fix-tests.js).
  tieToGuild(s, 'oth');
  tieToGuild(s, 'igm');
  const before = await snapshotOf(s);

  const notGm = await claim(s, 'oth');
  assert.equal(notGm.location, refused('not_gm'), 'the roster is fine and its Guild Master is somebody else');
  let after = await snapshotOf(s);
  assert.deepEqual(after.tables, before.tables, 'not one row of the guild moved');
  assert.deepEqual(after.guild, before.guild);
  assert.deepEqual(after.audit, [...before.audit, 'guild.claim_failed']);
  const failedRow = (await auditRows(s, 'guild.claim_failed'))[0];
  assert.equal(failedRow.actor_user_id, s.uids.oth);
  assert.equal(jsonOf(failedRow.after).count, 1);
  assert.equal(jsonOf(failedRow.after).detail, 'gm_claim:not_rank_zero');
  const counterKey = `auditfail:guild.claim_failed:${s.gid}:${s.uids.oth}:${Math.floor(s.w.clock.now / 3600000)}`;
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', counterKey)).count, 1);
  assert.deepEqual(notGm.statements.filter((statement) => TOUCHES_STORED.test(statement.sql)).map((statement) => /AS tied/.test(statement.sql)), [true],
    'a refusal reads stored data for ONE thing, after the verdict: whether the account has a tie to the guild (where the failure is counted)');
  assert.equal(await seatOf(s), s.uids.gm);

  // The same account again within the hour: counted (the counter), not written again.
  assert.equal((await claim(s, 'oth')).location, refused('not_gm'));
  assert.equal((await auditRows(s, 'guild.claim_failed')).length, 1, 'one row per user, guild and hour');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', counterKey)).count, 2);

  // The roster of ANOTHER Blizzard guild (the pin says 3000): even the real GM is refused.
  s.live.guildId = 3999;
  const wrongGuild = await claim(s, 'igm');
  assert.equal(wrongGuild.location, refused('not_gm'));
  assert.equal((await auditRows(s, 'guild.claim_failed')).length, 2, 'the real GM, a different user, a row of their own');
  assert.equal(jsonOf((await auditRows(s, 'guild.claim_failed'))[1].after).detail, 'gm_claim:guild_id_mismatch');
  s.live.guildId = BLIZZARD_GUILD_ID;
  s.live.realmId = 4999;
  assert.equal((await claim(s, 'igm')).location, refused('not_gm'), 'another Blizzard realm id as well');
  s.live.realmId = REALM_ID;

  // A roster with two rank-0 members, and one with none, is not a roster the sync would trust: a Battle.net problem ("provider"), not a failed claim, so it is not counted
  // (lane P3 fix; tests/guild/guild-hier-p3fix-tests.js has the budget side).
  const counted = await s.w.count('audit_log', "action = 'guild.claim_failed'");
  const counterOf = async (user) => (await s.one('SELECT count FROM rate_limits WHERE key = ?', `auditfail:guild.claim_failed:${s.gid}:${s.uids[user]}:${Math.floor(s.w.clock.now / 3600000)}`)).count;
  const igmCount = await counterOf('igm');
  s.live.roster.push({ name: 'Secondgm', id: 9300, rank: 0 });
  assert.equal((await claim(s, 'igm')).location, refused('provider'));
  s.live.roster = s.live.roster.filter((member) => member.rank !== 0);
  assert.equal((await claim(s, 'igm')).location, refused('provider'));
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), counted, 'no row for a malformed roster');
  assert.equal(await counterOf('igm'), igmCount, 'and no count');

  after = await snapshotOf(s);
  assert.deepEqual(after.tables, before.tables, 'still nothing written but the failure counters');
  assert.equal(after.guild.owner_user_id, s.uids.gm);
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim'"), 0);
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'gm_claim'"), 0);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.igm), 1, 'the block of the claimant is still there: a refused claim removes nothing');
});

check('refused: a Blizzard failure is "provider" and counts nothing; the account that comes back from Battle.net must be the linked one (mismatch, counted as a failed sign-in check)', async () => {
  const s = await claimWorld();
  tieToGuild(s, 'igm');
  const before = await snapshotOf(s);
  for (const which of ['roster', 'profile', 'token', 'userinfo']) {
    s.bnet.state.fail[which] = which === 'profile' ? 403 : 500;
    const down = await claim(s, 'igm');
    assert.equal(down.location, refused('provider'), which);
    s.bnet.state.fail[which] = 0;
  }
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 0, 'a Blizzard failure is nobody\'s failure');
  // The Battle.net account that comes back is not the one linked to the signed-in account.
  const other = await claim(s, 'igm', { account: ACCOUNT.oth });
  assert.equal(other.location, refused('mismatch'));
  assert.equal(await s.w.count('audit_log', "action = 'fresh.failed'"), 1, 'counted with the other fresh-auth failures');
  const after = await snapshotOf(s);
  assert.deepEqual(after.tables, before.tables);
  assert.equal(after.guild.owner_user_id, s.uids.gm);
  assert.equal((await claim(s, 'igm')).location, DONE, 'and the real claim still works afterwards');
});

check('the decision reads no characters, players, guild_blocks or tombstones: nothing stored is read before the roster and the profile are in hand (the D1 statementLog)', async () => {
  const s = await claimWorld();
  let atRoster = null;
  const served = s.bnet.state.override.roster;
  s.bnet.state.override.roster = (request) => { atRoster = s.w.db.statementLog.length; return served(request); };
  const mark = s.w.db.statementLog.length;
  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert(atRoster !== null);
  const before = s.w.db.statementLog.slice(mark, atRoster);
  assert(before.length >= 3, `the callback's own reads came first (${before.length})`);
  assert(!before.some((statement) => TOUCHES_STORED.test(statement.sql)), 'nothing stored that a squatter can write was read before the verdict');
  // What stored data it reads afterwards is the planning of the character part and nothing else: the roster row of the GM's key with whoever holds the key or the name, and the
  // claimant's own persons. (Blocks and tombstones are only DELETEd, by the batch, never read.)
  const reads = s.w.db.statementLog.slice(atRoster).filter((statement) => /^s*(SELECT|WITH)/i.test(statement.sql) && TOUCHES_STORED.test(statement.sql));
  assert.equal(reads.length, 2, 'two planning reads');
  assert(/CROSS JOIN guild_roster gr/.test(reads[0].sql) && /LEFT JOIN players p ON p.user_id = u.id/.test(reads[1].sql));
});

// ---------------------------------------------------------------------------
// 4. The batch

const tomb = () => load('worker/block-tombstones.js');
const hmacOf = async (s, value, secret = KEY) => (await tomb()).tombstoneHmac(secret, s.gid, value);
const tombstoneRows = (s) => s.rows('SELECT block_ref, key_version, hmac FROM block_tombstones WHERE guild_id = ? ORDER BY block_ref, hmac', s.gid);
const insertTombstone = async (s, ref, value, { version = 2, secret = KEY } = {}) => s.exec(
  `INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('${s.gid}', '${ref}', ${version}, '${await hmacOf(s, value, secret)}', 1)`,
);

// A hook on db.batch: `action` runs just before the first batch whose statements satisfy `when`.
function beforeBatch(s, when, action) {
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && when(statements)) { fired = true; action(); }
    return real(statements);
  };
  return () => { s.w.db.batch = real; };
}
const isClaimBatch = (statements) => statements.some((statement) => /UPDATE guilds SET owner_user_id/.test(statement.sql));

check('the batch: the seat moves, the claimant\'s block and the tombstones of their keys go (every key version), outstanding dry-run approvals go, the public page is unpublished, bearer artifacts and a grant of another purpose are untouched', async () => {
  const s = await claimWorld();
  const rank = await s.call('gm', 'POST', '/rank-map/dry-run', { ranks: [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }] });
  assert.equal(rank.status, 200, rank.text);
  s.exec(`INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at) VALUES ('used-token', '${s.gid}', '${s.uids.gm}', 'x', '', 1, 2, 1)`);
  assert.equal(await s.w.count('dry_run_approvals', 'guild_id = ?', s.gid), 2, 'an outstanding token and a used one');
  s.exec(`UPDATE guilds SET public_enabled = 1, public_sections = '["roster"]' WHERE id = '${s.gid}'`);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.igm}', '${s.uids.gm}', 'squatter', 1)`);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.mem}', '${s.uids.gm}', 'other block', 1)`);
  await insertTombstone(s, `u:${s.uids.igm}`, `bnet:${ACCOUNT.igm.id}`);
  await insertTombstone(s, 'p:p_SomeBlockedPerson0000000', `idkey:${NAMESPACE}:${REALM_ID}:${ID.gm}`);
  await insertTombstone(s, 'p:p_SomeBlockedPerson0000000', `idkey:${NAMESPACE}:${REALM_ID}:${ID.gm}`, { version: 1, secret: OLD_KEY });
  await insertTombstone(s, `u:${s.uids.igm}`, 'something-the-claimant-no-longer-holds');
  await insertTombstone(s, 'p:p_SomeBlockedPerson0000000', `idkey:${NAMESPACE}:${REALM_ID}:${ID.alt}`);
  await insertTombstone(s, `u:${s.uids.mem}`, 'bnet:999999999');
  assert.equal((await tombstoneRows(s)).length, 6);
  // Bearer artifacts, and a grant of another purpose on the claimant's session.
  s.exec(`INSERT INTO api_keys (id, guild_id, token_hash, name, datasets, created_by, created_at) VALUES ('ak_${'a'.repeat(22)}', '${s.gid}', '${'a'.repeat(64)}', 'Spreadsheet', '[]', '${s.uids.gm}', 1)`);
  s.exec(`INSERT INTO guest_links (id, guild_id, token_hash, role_id, created_by, created_at) VALUES ('gl_${'b'.repeat(22)}', '${s.gid}', 'guest-hash', 'guest', '${s.uids.gm}', 1)`);
  const bearerBefore = JSON.stringify([s.w.db.sqlite.prepare('SELECT * FROM api_keys').all(), s.w.db.sqlite.prepare('SELECT * FROM guest_links').all(), s.w.db.sqlite.prepare('SELECT * FROM team_notifications').all()]);
  await s.grant('igm', { purpose: 'source_switch', guildId: s.gid, params: {} });
  const grantBefore = await s.grantOf('igm');

  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.igm), 0, 'the claimant\'s block is gone');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.mem), 1, 'another account\'s block stays');
  assert.deepEqual((await tombstoneRows(s)).map((row) => [row.block_ref, row.key_version]), [['p:p_SomeBlockedPerson0000000', 2], [`u:${s.uids.mem}`, 2]],
    'only the tombstones of keys that are not the claimant\'s stay: the alt that is not on this roster and another account\'s');
  assert.deepEqual((await s.rows('SELECT token_hash FROM dry_run_approvals WHERE guild_id = ?', s.gid)).map((row) => row.token_hash), ['used-token'], 'the outstanding approval is gone, the used one is history');
  assert.equal((await s.one('SELECT public_enabled, public_sections FROM guilds WHERE id = ?', s.gid)).public_enabled, 0, 'the public page is unpublished');
  assert.equal((await s.one('SELECT public_sections FROM guilds WHERE id = ?', s.gid)).public_sections, '["roster"]', 'and keeps its settings');
  assert.equal(JSON.stringify([s.w.db.sqlite.prepare('SELECT * FROM api_keys').all(), s.w.db.sqlite.prepare('SELECT * FROM guest_links').all(), s.w.db.sqlite.prepare('SELECT * FROM team_notifications').all()]), bearerBefore,
    'API keys, guest links and webhooks are not touched (U R7-Q1)');
  assert.deepEqual(await s.grantOf('igm'), grantBefore, 'a grant of another purpose stays what it was');
  assert.deepEqual(jsonOf((await auditRows(s, 'guild.claim'))[0].after), { guildMasterUserId: s.uids.igm, via: 'gm_claim', unpublished: true });
  // The old Owner's token: the old Owner is no longer the Owner (403), whatever token they hold.
  const old = await s.call('gm', 'PUT', '/rank-map', { ranks: [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }], token: rank.json.token });
  assert.equal(old.status, 403, old.text);
});

check('the batch: a seat nobody holds (NULL) is claimed; a SUSPENDED Owner is claimed away from (the audit row says so) and loses nothing but the seat', async () => {
  const vacant = await claimWorld();
  vacant.exec(`UPDATE guilds SET owner_user_id = NULL WHERE id = '${vacant.gid}'`);
  assert.equal((await claim(vacant, 'igm')).location, DONE);
  assert.equal(await seatOf(vacant), vacant.uids.igm);
  assert.deepEqual(jsonOf((await auditRows(vacant, 'guild.claim'))[0].before), { guildMasterUserId: null, suspended: false });

  const suspended = await claimWorld({ ownerLive: false });
  assert.deepEqual(rolesOf(suspended, 'gm'), [], 'suspended: the seat and nothing else');
  assert.equal((await claim(suspended, 'igm')).location, DONE);
  assert.equal(await seatOf(suspended), suspended.uids.igm);
  assert.deepEqual(jsonOf((await auditRows(suspended, 'guild.claim'))[0].before), { guildMasterUserId: suspended.uids.gm, suspended: true });
  assert.equal(await suspended.w.count('characters', 'player_id = ?', suspended.people.gm.pid), 1, 'the previous Owner keeps their person and character');
  assert.equal(await suspended.w.count('players', 'id = ?', suspended.people.gm.pid), 1);
});

check('the batch: a suspended seat holder who is the live GM claims again and is restored (the seat does not move), and an outstanding approval of theirs is gone (409 approval_invalid)', async () => {
  const s = await claimWorld();
  // igm is the Owner, live: a person on the roster at rank 0 with a character proved by Battle.net.
  const made = await s.person({ name: 'Gmlive' });
  await s.link(made.pid, 'igm');
  makeProven(s, 'igm', made, { rank: 0, id: ID.gm, bnetId: ACCOUNT.igm.id });
  s.exec(`UPDATE guild_roster SET name = 'Gmlive', name_key = 'gmlive' WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${ID.gm}`);
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.igm}' WHERE id = '${s.gid}'`);
  const ranks = [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }];
  const dry = await s.call('igm', 'POST', '/rank-map/dry-run', { ranks });
  assert.equal(dry.status, 200, dry.text);
  // Their character stops being proved: suspended.
  s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${made.cid}'`);
  assert.equal((await s.call('igm', 'POST', '/rank-map/dry-run', { ranks })).status, 403, 'suspended: no Owner powers');
  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
  assert.deepEqual(jsonOf((await auditRows(s, 'guild.claim'))[0].before), { guildMasterUserId: s.uids.igm, suspended: true });
  assert.equal(await s.w.count('players', 'guild_id = ? AND user_id = ?', s.gid, s.uids.igm), 1, 'no second person');
  assert.deepEqual((await s.one('SELECT owner_proof, proof_user_id FROM characters WHERE id = ?', made.cid)), { owner_proof: 'bnet', proof_user_id: s.uids.igm }, 'restored: the character is proved again');
  const stale = await s.call('igm', 'PUT', '/rank-map', { ranks, token: dry.json.token });
  assert.deepEqual([stale.status, stale.json.error], [409, 'approval_invalid'], 'the dry run is re-armed');
});

check('a lost race applies NOTHING: the seat moved between the read and the batch (a hand-over, another claim) -> conflict, no marker, no audit row, the block, the tombstones and the approvals are still there', async () => {
  const s = await claimWorld();
  s.exec(`UPDATE guilds SET public_enabled = 1 WHERE id = '${s.gid}'`);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.igm}', '${s.uids.gm}', 1)`);
  await insertTombstone(s, `u:${s.uids.igm}`, `bnet:${ACCOUNT.igm.id}`);
  s.exec(`INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at) VALUES ('open', '${s.gid}', '${s.uids.gm}', 'x', '', 1, 2, NULL)`);
  const before = await snapshotOf(s);
  const restore = beforeBatch(s, isClaimBatch, () => s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.mem}' WHERE id = '${s.gid}'`));
  const raced = await claim(s, 'igm');
  restore();
  assert.equal(raced.location, refused('conflict'));
  assert.equal(await seatOf(s), s.uids.mem, 'the hand-over stands');
  const after = await snapshotOf(s);
  assert.deepEqual(after.tables, before.tables, 'nothing else applied: no person, no character, no marker, the block and the tombstones stay');
  assert.equal(after.guild.public_enabled, 1, 'the public page is still published');
  assert.deepEqual(after.audit, before.audit, 'and no audit row says otherwise');
  // The same claim once the seat is somebody else's and quiet: it simply works.
  assert.equal((await claim(s, 'igm')).location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
});

check('a swapped statement order is refused (the marker needs the seat move to have happened) and two claims from the same read give one winner: one marker, one set of guarded writes', async () => {
  const s = await claimWorld();
  const { claimHeadStatements } = await load('worker/gm-claim.js');
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => s.w.clock.now };
  const pin = { guildSlug: 'writers-b3', realmSlug: SLUG, namespace: NAMESPACE, blizzardGuildId: BLIZZARD_GUILD_ID, blizzardRealmId: REALM_ID };
  const head = (markerId, from = s.uids.gm) => claimHeadStatements(ctx, {
    guildId: s.gid, userId: s.uids.igm, from, bnetAccountId: ACCOUNT.igm.id, pin, markerId, tokenHash: 'session-hash', nowMs: s.w.clock.now, hmacs: [],
  });
  const probe = (name, guard) => s.w.db.prepare(`INSERT INTO rate_limits (key, window_start, count) SELECT ?, 1, 1 WHERE ${guard.sql}`).bind(name, ...guard.params);

  // Something changed a row just before, so a stale changes() = 1 is what the marker would read when it runs first.
  s.exec("INSERT INTO rate_limits (key, window_start, count) VALUES ('stale', 1, 1)");
  const swapped = head('am_swapped');
  const [move, marker, ...rest] = swapped.statements;
  const results = await s.w.db.batch([marker, move, probe('probe:swapped', swapped.guard)]);
  assert.equal(results[0].meta.changes, 0, 'the marker was refused: the seat is not the claimant\'s yet');
  assert.equal(results[2].meta.changes, 0, 'and the act did not apply');
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  assert.equal(await s.w.count('rate_limits', "key = 'probe:swapped'"), 0);
  assert.equal(rest.length, 4);

  // Two claims from the same read of the seat (the seat is igm's now: both name the previous holder gm).
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  const [a, b] = [head('am_a'), head('am_b')];
  await Promise.all([
    s.w.db.batch([...a.statements, probe('guarded:a', a.guard), s.w.db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('unguarded:a', 1, 1)")]),
    s.w.db.batch([...b.statements, probe('guarded:b', b.guard), s.w.db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('unguarded:b', 1, 1)")]),
  ]);
  assert.equal(await s.w.count('fresh_act_markers'), 1, 'one marker');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'guarded:%'"), 1, 'one guarded write');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'unguarded:%'"), 2, 'the statement that forgot the guard ran twice: the guard is what makes the claim single');
});

check('the character part is a convenience: a statement of it that fails (here a trigger) rolls that batch back, the claim is retried without it and still takes the seat', async () => {
  const s = await claimWorld();
  s.exec("CREATE TRIGGER claim_boom BEFORE INSERT ON characters WHEN NEW.name_key = 'gmlive' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm, 'the seat is the authority');
  assert.equal(await s.w.count('players', 'guild_id = ? AND user_id = ?', s.gid, s.uids.igm), 0, 'no person: the character part rolled back whole');
  assert(s.w.logs.some((line) => /gm claim deferred: character/.test(line)));
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim'"), 1);
  // The next sign-in match places the character (the claimant is a suspended Owner until then): remove the trigger and sign in again.
  s.exec('DROP TRIGGER claim_boom');
  s.bnet.state.account = ACCOUNT.igm;
  const jar = {};
  const first = await s.w.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const state = new URL(first.headers.get('Location')).searchParams.get('state');
  const signedIn = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  assert.equal(signedIn.headers.get('Location'), '/#/');
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'the sign-in match made the claimant live');
});

// ---------------------------------------------------------------------------
// 5. A squatter, and a GM who is new since the last sync

// The squatter 'sq': a Discord member linked to a person with a character on the roster (so they stay a member), who typed the GM's name in as an id-less alt of their own person.
async function squatterWorld(options) {
  const s = await claimWorld(options);
  await s.member('sq', 'Squatter');
  s.people.sq = await s.person({ name: 'Squatter' });
  await s.link(s.people.sq.pid, 'sq');
  makeProven(s, 'sq', s.people.sq, { rank: 5, id: ID.squat, proof: 'officer', link: false });
  s.exec(`UPDATE guild_roster SET name = 'Squatter', name_key = 'squatter' WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${ID.squat}`);
  s.live.roster.push({ name: 'Squatter', id: ID.squat, rank: 5 });
  s.typed = await s.alt(s.people.sq.pid, 'Gmlive', { class: 'MAGE', mainSpec: 'Fire' });
  return s;
}

// Every row the person holds in the tables a re-home must leave alone (the join tables bar the characters and the sign-ups) and its character count.
async function personCounts(s, personId) {
  const { JOIN_TABLES } = await load('worker/person-join.js');
  const out = { characters: await s.w.count('characters', 'player_id = ?', personId), players: await s.w.count('players', 'id = ?', personId) };
  for (const table of Object.keys(JOIN_TABLES)) {
    if (['characters', 'raid_signups', 'standing_signups'].includes(table)) continue;
    out[table] = await s.w.count(table, 'player_id = ?', personId);
  }
  return out;
}


check('a squatter pre-binds the GM\'s name (typed, id-less), hand-links it to their own account, blocks the GM and leaves a tombstone on the GM\'s key: the GM still claims, is live, block and tombstones are gone, the squatter keeps every row and everything stays after two more GM sign-ins', async () => {
  const s = await squatterWorld();
  s.exec(`INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES ('an_${'q'.repeat(22)}', '${s.gid}', '${s.people.sq.pid}', 'away', '2026-01-01', '2026-01-05', 1, 1)`);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.igm}', '${s.uids.gm}', 'the squatter asked', 1)`);
  await insertTombstone(s, `u:${s.uids.igm}`, `bnet:${ACCOUNT.igm.id}`);
  await insertTombstone(s, `p:${s.people.sq.pid}`, `idkey:${NAMESPACE}:${REALM_ID}:${ID.gm}`);
  const typed = await s.one('SELECT id, player_id, blizzard_char_id, owner_proof, name FROM characters WHERE id = ?', s.typed);
  assert.deepEqual([typed.player_id, typed.blizzard_char_id, typed.name], [s.people.sq.pid, null, 'Gmlive'], 'the typed, id-less character is on the squatter\'s person');
  const countsBefore = await personCounts(s, s.people.sq.pid);
  assert.equal(countsBefore.characters, 2);
  assert.equal(countsBefore.away_notices, 1);
  const sqRoles = rolesOf(s, 'sq');

  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE, `${s.w.logs.slice(-3).join(' | ')}`);
  assert.equal(await seatOf(s), s.uids.igm);
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'live at once');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.igm), 0, 'the pre-block is gone');
  assert.deepEqual((await tombstoneRows(s)), [], 'and so are the tombstones on the GM\'s keys');
  // The character that carried the GM's name is the GM's now: bound to the key, proved by Battle.net, on the claimant's person (the same row: its evidence follows).
  const person = await personOf(s, 'igm');
  const moved = await s.one('SELECT id, player_id, blizzard_char_id, owner_proof, proof_user_id, is_main, name FROM characters WHERE id = ?', s.typed);
  assert.deepEqual([moved.player_id, moved.blizzard_char_id, moved.owner_proof, moved.proof_user_id, moved.is_main], [person.id, ID.gm, 'bnet', s.uids.igm, 1]);
  // The squatter keeps every row: per-table counts equal (the moved character left a placeholder), the person and the account link stay.
  assert.deepEqual(await personCounts(s, s.people.sq.pid), countsBefore, 'per-table row counts of the squatter are equal before and after');
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', s.people.sq.pid)).user_id, s.uids.sq);
  const placeholders = await s.rows("SELECT id, name, left_on FROM characters WHERE player_id = ? AND name_key LIKE '~ph:%'", s.people.sq.pid);
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].name, 'Gmlive');
  assert.equal(await s.w.count('character_name_aliases', "character_id = ? AND name_key = 'gmlive'", placeholders[0].id), 1, 'evidence dated before now resolves to the squatter\'s person');
  const rehomes = await auditRows(s, 'character.rehome');
  assert.equal(rehomes.length, 1);
  assert.deepEqual(jsonOf(rehomes[0].after), { personId: person.id, reason: 'gm_claim' });
  assert.equal(rehomes[0].actor_user_id, s.uids.igm);
  assert.deepEqual(rolesOf(s, 'sq'), sqRoles, 'the squatter holds what they held');
  assert.equal((await s.call('sq', 'GET', '')).status, 200, 'and is still a member');

  // Two more sign-ins of the GM, each with a fresh tombstone on their keys (a block of an Officer): the Owner is held back (block.match_held), never blocked.
  for (let round = 1; round <= 2; round++) {
    await insertTombstone(s, `u:u_Squatter${round}00000000000000`, `bnet:${ACCOUNT.igm.id}`);
    await insertTombstone(s, `u:u_Squatter${round}00000000000000`, `idkey:${NAMESPACE}:${REALM_ID}:${ID.gm}`);
    s.w.advance(26 * 60 * 60 * 1000);
    await signInAgain(s, 'igm');
    assert.equal(await s.w.count('guild_blocks', 'user_id = ?', s.uids.igm), 0, `sign-in ${round}: not blocked`);
    assert.equal(await seatOf(s), s.uids.igm);
    assert.equal((await s.call('igm', 'GET', '')).status, 200, `sign-in ${round}: still in the guild`);
    assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']]);
  }
  const held = await auditRows(s, 'block.match_held');
  assert.equal(held.length, 2, 'one held-back row a day');
  assert.equal(jsonOf(held[0].after).reason, 'owner');
  assert.deepEqual(await personCounts(s, s.people.sq.pid), countsBefore, 'the squatter still keeps every row');
  assert.equal((await s.call('sq', 'GET', '')).status, 200);
});

check('the typed name sits on an UNOWNED person and the claimant has none: that person is linked to the claimant (its history stays on it); the claimant already has a person: the character is re-homed to it', async () => {
  const linked = await claimWorld();
  const holder = await linked.person({ name: 'Gmlive' });
  linked.exec(`UPDATE characters SET is_main = 1 WHERE id = '${holder.cid}'`);
  const alt = await linked.alt(holder.pid, 'Gmhistory', { class: 'ROGUE', mainSpec: 'Combat' });
  assert.equal((await claim(linked, 'igm')).location, DONE);
  const person = await personOf(linked, 'igm');
  assert.equal(person.id, holder.pid, 'the unowned person IS the claimant\'s person now');
  assert.deepEqual(await linked.one('SELECT player_id, blizzard_char_id, owner_proof FROM characters WHERE id = ?', holder.cid), { player_id: holder.pid, blizzard_char_id: ID.gm, owner_proof: 'bnet' });
  assert.equal((await linked.one('SELECT player_id FROM characters WHERE id = ?', alt)).player_id, holder.pid, 'the rest of that person stays with it');
  assert.deepEqual(rolesOf(linked, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']]);
  assert.equal(await linked.w.count('audit_log', "action = 'character.rehome'"), 0, 'nothing was re-homed');

  // The claimant has a person already (made by their sign-in: the alt Gmalt is on the roster): the typed GM name on another unowned person is re-homed to it.
  const existing = await claimWorld();
  rosterRow(existing, { name: 'Gmalt', id: ID.alt, rank: 5, cls: 'PRIEST' });
  existing.live.roster.push({ name: 'Gmalt', id: ID.alt, rank: 5, cls: 5 });
  const bothCharacters = existing.live.profiles[ACCOUNT.igm.id];
  existing.live.profiles[ACCOUNT.igm.id] = [entry('Gmalt', ID.alt, { cls: 5 })];
  await signInAgain(existing, 'igm');
  existing.live.profiles[ACCOUNT.igm.id] = bothCharacters;
  assert.equal(await existing.w.count('characters', 'blizzard_char_id = ?', ID.gm), 0, 'the sign-in matched the alt only: no character for the GM yet');
  const own = await personOf(existing, 'igm');
  assert(own, 'the sign-in made the claimant\'s person from the alt on the roster');
  const typed = await existing.person({ name: 'Gmlive' });
  assert.equal((await claim(existing, 'igm')).location, DONE);
  assert.equal((await personOf(existing, 'igm')).id, own.id, 'the same person');
  const names = (await charactersOf(existing, own.id)).map((row) => [row.name, row.owner_proof, row.is_main]);
  assert.deepEqual(names, [['Gmalt', 'bnet', 1], ['Gmlive', 'bnet', 0]], 'the GM character joined the person (not its Main: it has one)');
  assert.equal(await existing.w.count('players', 'id = ?', typed.pid), 1, 'the person it came from stays');
  assert.equal(await existing.w.count('audit_log', "action = 'character.rehome'"), 1);
  assert.deepEqual(rolesOf(existing, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']]);
});

check('the GM is NEW since the last sync (the stored roster does not hold the key): the fetched roster is applied first as one good sync, then the claimant is live; one more batch, inside the budget', async () => {
  const s = await claimWorld({ stored: false });
  assert.equal(await s.w.count('guild_roster', 'guild_id = ? AND blizzard_char_id = ?', s.gid, ID.gm), 0);
  const hashBefore = (await s.one('SELECT roster_hash FROM guilds WHERE id = ?', s.gid)).roster_hash;
  const outcome = await claim(s, 'igm');
  assert.equal(outcome.location, DONE);
  assert.equal(await s.w.count('guild_roster', 'guild_id = ? AND blizzard_char_id = ?', s.gid, ID.gm), 1, 'the stored roster holds the GM now');
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), 3, 'the whole fetched roster replaced the stored one');
  const guild = await s.one('SELECT roster_hash, last_good_sync_id, last_good_fetched_at FROM guilds WHERE id = ?', s.gid);
  assert.notEqual(guild.roster_hash, hashBefore);
  const sync = await s.one('SELECT good, counts FROM roster_syncs WHERE id = ?', guild.last_good_sync_id);
  assert.equal(sync.good, 1, 'a good roster_syncs row, the one the dry-run tokens bind to');
  assert.equal(jsonOf(sync.counts).members, 3);
  assert.equal(await seatOf(s), s.uids.igm);
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'live: the claimant\'s character is on the stored roster');
  assert(outcome.statements.length <= 45, `${outcome.statements.length} statements`);
  console.log(`      measured: a claim that applies a 3-member roster first ran ${outcome.statements.length} D1 statements`);
  // The same claim, but the roster was applied by the cron a moment ago (nothing differs): no second apply.
  const again = await claimWorld({ stored: false });
  const hash = await (await load('worker/roster-sync.js')).rosterHash((await load('worker/battlenet.js')).parseGuildRoster(rosterBody(again.live.roster), NAMESPACE));
  again.exec(`UPDATE guilds SET roster_hash = '${hash}' WHERE id = '${again.gid}'`);
  assert.equal((await claim(again, 'igm')).location, DONE);
  assert.equal(await again.w.count('roster_syncs', 'guild_id = ? AND good = 1', again.gid), 0, 'a roster the guild already has is not applied again');
  assert.equal(await seatOf(again), again.uids.igm, 'the claim itself still stands (the claimant waits for the next sync to be live)');
});

// ---------------------------------------------------------------------------
// 6. The review list and the attention item

check('claim-review: the Owner only (403 for the previous Owner, an Officer and everyone else); before a claim it lists what stands, after it names the claim; the bearer counts and tab are there', async () => {
  const s = await claimWorld();
  s.exec(`UPDATE guilds SET public_enabled = 1 WHERE id = '${s.gid}'`);
  // What the previous Owner set up: an Officer with a Team Lead role on Alpha, hand-linked accounts and officer-proof characters (the fixture), bearer artifacts.
  const roles = await s.call('gm', 'PUT', `/people/${s.uids.mem}/roles`, { officer: true, teamLeadTeamIds: [s.tids[0]] });
  assert.equal(roles.status, 200, roles.text);
  s.exec(`INSERT INTO api_keys (id, guild_id, token_hash, name, datasets, created_by, created_at) VALUES ('ak_${'a'.repeat(22)}', '${s.gid}', '${'a'.repeat(64)}', 'Spreadsheet', '[]', '${s.uids.gm}', 1)`);
  s.exec(`INSERT INTO api_keys (id, guild_id, token_hash, name, datasets, revoked_at, created_by, created_at) VALUES ('ak_${'c'.repeat(22)}', '${s.gid}', '${'c'.repeat(64)}', 'Old', '[]', 5, '${s.uids.gm}', 1)`);
  s.exec(`INSERT INTO guest_links (id, guild_id, token_hash, role_id, created_by, created_at) VALUES ('gl_${'b'.repeat(22)}', '${s.gid}', 'guest-hash', 'guest', '${s.uids.gm}', 1)`);

  for (const who of ['mem']) {
    const refusal = await s.call(who, 'GET', '/claim-review');
    assert.deepEqual([refusal.status, refusal.json.error], [403, 'forbidden'], `${who}: an Officer is not the Owner`);
  }
  const before = await s.ok('gm', 'GET', '/claim-review', undefined, 200);
  assert.equal(before.claim, null, 'no claim yet');
  assert.deepEqual(before.bearer, { name: 'settings', tab: 'dataaccess', apiKeys: 1, guestLinks: 1, joinLinks: 0, webhooks: 0 }, 'live artifacts only (the revoked key is not counted)');

  assert.equal((await claim(s, 'igm')).location, DONE);
  const gone = await s.call('gm', 'GET', '/claim-review');
  assert.deepEqual([gone.status, gone.json.error], [403, 'forbidden'], 'the previous Owner is not the Owner any more');
  const review = await s.ok('igm', 'GET', '/claim-review', undefined, 200);
  const row = await s.one("SELECT id, created_at FROM audit_log WHERE guild_id = ? AND action = 'guild.claim'", s.gid);
  assert.deepEqual(review.claim, {
    id: row.id, at: row.created_at, by: { id: s.uids.igm, name: 'Igm' }, previousOwner: { id: s.uids.gm, name: 'Gmb3' }, previousWasSuspended: false, publicUnpublished: true,
  });
  // Stored roles: the Officer and the Team Lead rows the previous Owner made, with who and when.
  const mine = review.roles.filter((entry) => entry.userId === s.uids.mem);
  assert.deepEqual(mine.map((entry) => [entry.roleId, entry.teamId, entry.source, entry.assignedBy && entry.assignedBy.id]).sort(),
    [['officer', null, 'manual', s.uids.gm], ['team_lead', s.tids[0], 'manual', s.uids.gm]].sort());
  assert(mine.every((entry) => typeof entry.assignedAt === 'number' && entry.name && entry.roleName));
  assert.equal(mine.find((entry) => entry.roleId === 'team_lead').teamName, 'Alpha');
  // The rank map: the permission each in-game rank gives; the table does not record who set it.
  assert.deepEqual(review.rankMap.rows.map((row) => [row.rank, row.roleId]), [[0, 'guild_master'], [1, 'officer'], [2, 'team_lead'], [3, null], [4, null], [5, null]]);
  assert.deepEqual([review.rankMap.setBy, review.rankMap.setAt, review.handLinks.setBy, review.handLinks.setAt], [null, null, null, null]);
  // Hand-links: the account linked by an officer to a person that no Battle.net proof backs, and the officer-proof characters.
  assert.deepEqual(review.handLinks.persons.map((entry) => [entry.userId, entry.mainName]), [[s.uids.mem, 'Memberone']]);
  assert.deepEqual(review.handLinks.characters.map((entry) => [entry.name, entry.proof]), [['Memberone', 'officer']]);
  assert.equal(review.handLinks.truncated, false);
  assert.deepEqual(review.bearer, { name: 'settings', tab: 'dataaccess', apiKeys: 1, guestLinks: 1, joinLinks: 0, webhooks: 0 }, 'a claim touches none of them');
  // A dev View-as never passes an Owner gate.
  assert.equal((await s.call('mem', 'GET', '/claim-review')).status, 403);
});

check('the claim_review attention item: the new Owner only, until dismissed (server-decided), and a later claim brings it back; nobody else gets it', async () => {
  const s = await claimWorld();
  const items = async (who) => (await s.ok(who, 'GET', '/attention')).items.filter((item) => item.kind === 'claim_review');
  assert.equal((await s.call('gm', 'PUT', `/people/${s.uids.mem}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.deepEqual(await items('gm'), [], 'nothing before a claim');
  assert.equal((await claim(s, 'igm')).location, DONE);
  const first = await items('igm');
  assert.deepEqual(first.map((item) => [item.id, item.severity, item.teamId, item.link]), [['claim_review', 'action', null, { name: 'settings', tab: 'claimreview' }]]);
  assert.equal(typeof first[0].claimedAt, 'number');
  assert.equal((await s.call('gm', 'GET', '/attention')).status, 403, 'the previous Owner holds no right to see the Home to-dos any more, so does not get it');
  assert.deepEqual(await items('mem'), [], 'an Officer does not get it');
  const attention = await s.ok('igm', 'GET', '/attention');
  assert(attention.total >= 1);
  const dismissed = await s.call('igm', 'POST', '/attention/dismissals', { itemId: 'claim_review' });
  assert.equal(dismissed.status, 200, dismissed.text);
  assert.deepEqual(await items('igm'), [], 'dismissed');
  assert.equal((await s.ok('igm', 'GET', '/attention')).hidden.filter((entry) => entry.item.kind === 'claim_review').length, 1, 'listed under Hidden, restorable');
  // A later claim (the seat went elsewhere, the GM claims it back) brings the item back: the fingerprint is the claim's audit row.
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  s.w.advance(60 * 1000);
  assert.equal((await claim(s, 'igm')).location, DONE);
  assert.equal((await items('igm')).length, 1, 'the second claim is a new claim');
  assert.equal((await auditRows(s, 'guild.claim')).length, 2);
  const restore = await s.call('igm', 'DELETE', '/attention/dismissals/claim_review');
  assert.equal(restore.status, 200, restore.text);
});

// ---------------------------------------------------------------------------
// 7. Budgets and query plans on a 1,200-member in-game guild (the roster the Blizzard fetch allows at most)

const MEMBERS = 1200;

// claimWorld() plus bulk members: every one a person with a character bound to a roster row (every third proved by Battle.net), on the stored roster, the live roster holds exactly
// MEMBERS members in all (the GM among them: a roster of more than 1,200 is cut off by the fetch and is not a good one). stored: false = the stored roster lacks the GM.
async function bigClaimWorld({ stored = true, squatter = false } = {}) {
  const s = squatter ? await squatterWorld({ stored }) : await claimWorld({ stored });
  addBulkMembers(s, MEMBERS - s.live.roster.length);
  assert.equal(s.live.roster.length, MEMBERS);
  return s;
}

// The SCANs of the tables this lane's statements read or write that scansSince does not cover (it has characters, guild_roster, players, role_assignments and guilds): every one
// of these has an index the guild's rows are found by.
const CLAIM_TABLES = ['block_tombstones', 'guild_blocks', 'dry_run_approvals', 'audit_log', 'character_name_aliases', 'person_blocks', 'fresh_act_markers', 'bnet_links', 'source_rank_maps',
  'attention_dismissals', 'api_keys', 'guest_links', 'raid_join_links', 'team_notifications'];
function tableScans(db, statements) {
  const found = [];
  for (const { sql, values } of statements) {
    for (const row of db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)) {
      const match = /^SCAN (?:TABLE )?(S+)/.exec(row.detail);
      if (match && CLAIM_TABLES.includes(match[1])) found.push(`${row.detail} :: ${sql.replace(/s+/g, ' ').slice(0, 110)}`);
    }
  }
  return found;
}
const ALLOWED_SCANS = /^$/;

async function measured(s, key = 'igm') {
  const mark = s.w.db.statementLog.length;
  const outcome = await claim(s, key);
  assert.equal(outcome.location, DONE, s.w.logs.slice(-4).join(' | '));
  const scans = tableScans(s.w.db, outcome.statements).filter((line) => !ALLOWED_SCANS.test(line));
  assert.deepEqual(scans, [], 'no table of the guild is walked');
  assert.deepEqual(scansSince(s.w.db, mark), [], 'and none of characters, guild_roster, players, role_assignments or guilds (view aliases included)');
  assert(outcome.statements.length <= 45, `${outcome.statements.length} D1 statements (the Workers Free limit is 50 per invocation, the plan 45)`);
  assert(outcome.blizzard.length >= 4 && outcome.blizzard.length <= 5, `${outcome.blizzard.length} Blizzard requests: token, user info, the account profile, the client token (cached), the roster`);
  return outcome;
}

check('budget, 1,200 members, the stored roster holds the GM: the claim callback (person, character, proof, the rest) stays far inside 45 D1 statements and 5 Blizzard requests, no table walked', async () => {
  const s = await bigClaimWorld();
  const outcome = await measured(s);
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']]);
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), MEMBERS, 'the stored roster was not touched (it holds the GM)');
  console.log(`      measured: ${outcome.statements.length} D1 statements, ${outcome.blizzard.length} Blizzard requests (the stored roster holds the GM)`);
});

check('budget, 1,200 members, the GM is new since the last sync: the 1,200-member roster is applied first (one batch) and the claim still fits in 45; the live roster replaced the stored one', async () => {
  const s = await bigClaimWorld({ stored: false });
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), MEMBERS - 1);
  const outcome = await measured(s);
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), MEMBERS, 'the whole fetched roster is stored');
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'and the claimant is live');
  console.log(`      measured: ${outcome.statements.length} D1 statements, ${outcome.blizzard.length} Blizzard requests (the roster applied first, 4 insert chunks)`);
});

check('budget, 1,200 members, a squatter holds the name (the stored roster has the GM): the re-home path is the heaviest one that still fits, and the claimant is live', async () => {
  const s = await bigClaimWorld({ squatter: true });
  const outcome = await measured(s);
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'live');
  assert.equal(await s.w.count('audit_log', "action = 'character.rehome'"), 1);
  console.log(`      measured: ${outcome.statements.length} D1 statements, ${outcome.blizzard.length} Blizzard requests (a squatter's character re-homed)`);
});

check('budget, 1,200 members, the GM is new AND a squatter holds the name: the worst case. Whatever does not fit is skipped on purpose (logged), never the claim; the callback stays inside 45', async () => {
  const s = await bigClaimWorld({ stored: false, squatter: true });
  const outcome = await measured(s);
  assert.equal(await seatOf(s), s.uids.igm, 'the claim is the one thing that always happens');
  const live = rolesOf(s, 'igm').some((entry) => entry[2] === 'ingame');
  console.log(`      measured: ${outcome.statements.length} D1 statements; claimant live: ${live}; log: ${s.w.logs.filter((line) => /gm claim/.test(line)).join(' | ') || '-'}`);
  if (!live) {
    // The part that did not fit says so, and the next sign-in match finishes the job.
    assert(s.w.logs.some((line) => /gm claim deferred: (budget|character|roster)/.test(line)));
    await signInAgain(s, 'igm');
    assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'the next sign-in made the claimant live');
  }
});

check('query plans: the Home read (the claim fact rides the block-review statement, one probe of the partial index), the review list and the succession read walk no table of the guild', async () => {
  const s = await bigClaimWorld();
  assert.equal((await claim(s, 'igm')).location, DONE);
  const mark = s.w.db.statementLog.length;
  await s.ok('igm', 'GET', '/attention');
  await s.ok('igm', 'GET', '/claim-review');
  // The statements of this lane: the claim read of the Home batch and the six reads of the review route (the rest of the Home batch is older and has its own suite).
  const run = s.w.db.statementLog.slice(mark).filter((statement) => /guild.claim|FROM role_assignments|source_rank_maps|owner_proof IN|FROM api_keys|FROM players p JOIN users/.test(statement.sql));
  assert(run.length >= 6, `${run.length} statements of this lane`);
  assert.deepEqual(tableScans(s.w.db, run).filter((line) => !ALLOWED_SCANS.test(line)), []);
  assert.deepEqual(scansSince({ sqlite: s.w.db.sqlite, statementLog: run }, 0), []);
  const claimRead = run.find((statement) => /c\.action = 'guild\.claim'/.test(statement.sql) && /claim_id/.test(statement.sql));
  assert(claimRead, 'the attention read asks for the claim');
  const plan = s.w.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${claimRead.sql}`).all(...claimRead.values).map((row) => row.detail);
  assert(plan.some((detail) => /audit_log_guild_claim/.test(detail)), `the claim lookup uses the partial index: ${plan.join(' / ')}`);
});

check('guild.claim and guild.succession are never pruned: not in PRUNABLE_ACTIONS, and the audit trigger refuses to delete their rows even past 180 days (a failed-claim row, the control, goes)', async () => {
  const { PRUNABLE_ACTIONS } = await load('worker/audit.js');
  assert(!PRUNABLE_ACTIONS.includes('guild.claim') && !PRUNABLE_ACTIONS.includes('guild.succession'));
  assert(PRUNABLE_ACTIONS.includes('guild.claim_failed'));
  const s = await claimWorld();
  const old = s.w.clock.now - 400 * 24 * 60 * 60 * 1000;
  for (const action of ['guild.claim', 'guild.succession', 'guild.claim_failed']) {
    s.exec(`INSERT INTO audit_log (id, guild_id, action, entity_type, entity_id, created_at) VALUES ('al_old_${action.replace('.', '_')}', '${s.gid}', '${action}', 'guild', '${s.gid}', ${old})`);
  }
  const attempt = (action) => s.w.db.sqlite.prepare('DELETE FROM audit_log WHERE id = ?').run(`al_old_${action.replace('.', '_')}`);
  assert.throws(() => attempt('guild.claim'), /audit_log/);
  assert.throws(() => attempt('guild.succession'), /audit_log/);
  attempt('guild.claim_failed');
  assert.equal(await s.w.count('audit_log', "id LIKE 'al_old_%'"), 2);
});

runChecks(checks);
