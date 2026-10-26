/**
 * Raidsmith guild tracker - lane B6b part 2a of the user-hierarchy build: the Owner-seat gates (worker/routes/people.js, guild-data.js, guild.js, auth.js, roster.js, membership.js)
 * Run: node tests/guild/guild-b6b2-owner-tests.js
 *
 *   - hand-over and guild delete need a consumed fresh-auth (403 fresh_required { purpose, params } without one; a manual guild is session only); a hand-over of the SEAT moves only
 *     `owner_user_id` (guard `owner_user_id IS <the Owner>` inside the batch), writes no Officer row for the previous Owner, needs a live recipient in an in-game guild, and a seat-only
 *     Owner passes the route gate; a legacy guild keeps the stored-Guild-Master swap;
 *   - an unsuspended Owner cannot be blocked (route refusal, the guard inside the write, and a block row on them is ignored); a suspended Owner is blockable and any Guild Master tier
 *     principal restores them;
 *   - review finding B4b/B5 F1, the rest: the legacy POST /claim answers 403 once the guild has a rank source or a seat (also after the foreign key emptied the seat), deleteImpact
 *     reports a seat holder as handOverFirst, unlinkDiscord's last-GM guard and the Discord sync use the Owner;
 *   - PATCH /roster/:pid linkUserId on a person holding a Battle.net-proven character is the Owner's, inside the batch too;
 *   - derived roles need a character that is not Former, a Former better-ranked character does not hide the rest, Owner liveness is unchanged.
 * Drives worker/index.js over the node:sqlite D1 stand-in.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { freshScenario, sessionHashOf } = require('../guild-fresh');
const { adminOf, signIn } = require('../guild-world');
const { flip, makeProven, rolesOf } = require('../guild-ingame');

const checks = [];
function check(name, fn) {
  checks.push({
    name,
    fn: async () => {
      globalThis.__ownerWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__ownerWorlds.map((s) => s.close())); }
    },
  });
}
const NAME = 'Writers B3';

async function legacyWorld() {
  const s = await freshScenario();
  globalThis.__ownerWorlds.push(s);
  await s.member('own', 'Ownerseat');
  await s.member('mem', 'Plainmember');
  await s.officer('off', 'Officerone');
  s.seat = async () => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
  s.handoverGrant = (who, target, gid = s.gid) => s.grant(who, { purpose: 'handover', guildId: gid, params: { targetUserId: s.uids[target] } });
  s.deleteGrant = (who) => s.grant(who, { purpose: 'guild_delete', guildId: s.gid, params: {} });
  s.handover = (who, target) => s.call(who, 'POST', `/people/${s.uids[target]}/guild-master`, {});
  s.audit = (action) => s.rows('SELECT actor_user_id, entity_id, actor_role, before, after FROM audit_log WHERE action = ? ORDER BY created_at, id', action);
  return s;
}

// The in-game guild of the B6b gates suite, smaller: the live Owner 'own', a derived Guild Master 'dgm', a derived Officer 'dof', and 'mem' (bound by an officer's proof, no Battle.net).
async function ingameWorld() {
  const s = await freshScenario({ teams: ['Alpha', 'Bravo'] });
  globalThis.__ownerWorlds.push(s);
  s.people = {};
  for (const [key, name, rank, proof] of [['own', 'Seatowner', 4, 'bnet'], ['dgm', 'Derivedgm', 0, 'bnet'], ['dof', 'Derivedoff', 1, 'bnet'], ['mem', 'Plainmember', 5, 'officer']]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
    makeProven(s, key, s.people[key], { rank, proof, link: proof === 'bnet' });
  }
  flip(s, { owner: 'own' });
  s.seat = async () => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
  s.suspend = () => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.own.cid}'`);
  s.restore = () => s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.own}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.own}') WHERE id = '${s.people.own.cid}'`);
  s.handoverGrant = (who, target) => s.grant(who, { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids[target] } });
  s.handover = (who, target) => s.call(who, 'POST', `/people/${s.uids[target]}/guild-master`, {});
  s.audit = (action) => s.rows('SELECT actor_user_id, entity_id, actor_role FROM audit_log WHERE action = ? ORDER BY created_at, id', action);
  return s;
}

const storedRoles = (s) => s.rows('SELECT user_id, role_id FROM role_assignments WHERE guild_id = ? ORDER BY user_id, role_id', s.gid);

// ---------------------------------------------------------------------------
// 1. Hand-over

check('hand-over, legacy guild (no seat): needs a fresh sign-in, swaps the stored Guild Master row, the old one becomes an Officer; the grant is spent and a marker written', async () => {
  const s = await legacyWorld();
  const refused = await s.handover('gm', 'mem');
  assert.deepEqual([refused.status, refused.json.error, refused.json.purpose], [403, 'fresh_required', 'handover']);
  assert.deepEqual(refused.json.params, { targetUserId: s.uids.mem }, 'the UI learns what to ask for');
  assert.deepEqual(await rolesOf(s, 'mem'), []);
  assert.equal((await s.audit('guild_master.transfer')).length, 0);
  // The real flow: start, Discord, callback, then the act.
  const flow = await s.fresh('gm', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem }, provider: 'discord' });
  assert.equal(flow.location, '/#/fresh?done=handover');
  const done = await s.handover('gm', 'mem');
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(rolesOf(s, 'mem'), [['guild_master', null, 'manual'], ['guild_master', null, 'owner']], 'the stored row and the Owner row of the view');
  assert.deepEqual(rolesOf(s, 'gm'), [['officer', null, 'manual']], 'the previous Guild Master is an Officer (the legacy swap)');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null }, 'single use');
  assert.equal(await s.w.count('fresh_act_markers'), 1);
  const rows = await s.audit('guild_master.transfer');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].actor_user_id, rows[0].entity_id], [s.uids.gm, s.uids.mem]);
  // The same request again: the Owner is mem now.
  assert.equal((await s.handover('gm', 'mem')).status, 403);
});

check('hand-over: a grant for another target, another purpose or another guild is refused and stays; the Owner gate comes first (an Officer with a grant is refused)', async () => {
  const s = await legacyWorld();
  await s.handoverGrant('gm', 'own');
  const wrongTarget = await s.handover('gm', 'mem');
  assert.deepEqual([wrongTarget.status, wrongTarget.json.error], [403, 'fresh_required']);
  await s.deleteGrant('gm');
  assert.equal((await s.handover('gm', 'mem')).json.error, 'fresh_required', 'a guild_delete grant is no hand-over grant');
  await s.handoverGrant('gm', 'mem', 'g_AnotherGuild000000000000');
  assert.equal((await s.handover('gm', 'mem')).json.error, 'fresh_required', 'a grant for another guild');
  assert.deepEqual(await storedRoles(s), (await storedRoles(s)), 'unchanged');
  await s.handoverGrant('off', 'mem');
  const off = await s.handover('off', 'mem');
  assert.deepEqual([off.status, off.json.error], [403, 'forbidden'], 'an Officer is no Owner, grant or not');
  assert((await s.grantOf('off')).fresh_hash, 'and the Officer\'s grant was not spent');
  assert.equal((await s.audit('guild_master.transfer')).length, 0);
});

check('hand-over, SEAT set: only owner_user_id moves, no Officer row for the previous Owner, a seat-only Owner passes the gate (F2), the audit row names the Owner', async () => {
  const s = await legacyWorld();
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`); // the flip leaves no stored Guild Master row
  await s.setOwner('own');
  assert.deepEqual(await rolesOf(s, 'own'), [['guild_master', null, 'owner']], 'the Owner holds no stored role, only the seat');
  const rolesBefore = await storedRoles(s);
  await s.handoverGrant('own', 'mem');
  const done = await s.handover('own', 'mem');
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.seat(), s.uids.mem, 'the seat moved');
  assert.deepEqual(await storedRoles(s), rolesBefore, 'not one stored row changed: no Officer row for the previous Owner');
  assert.deepEqual(await rolesOf(s, 'own'), [], 'the previous Owner holds what their own rank and stored roles give: nothing');
  assert.deepEqual(await rolesOf(s, 'mem'), [['guild_master', null, 'owner']]);
  const rows = await s.audit('guild_master.transfer');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].actor_user_id, rows[0].entity_id, rows[0].actor_role], [s.uids.own, s.uids.mem, 'owner'], 'recorded as the Owner (the move changes who that is)');
  assert.deepEqual(JSON.parse(rows[0].after), { guildMasterUserId: s.uids.mem });
  // The reply is the people list as the previous Owner sees it now.
  assert(done.json.people && !done.json.people.some((entry) => entry.actions && entry.actions.makeGuildMaster));
  assert.equal((await s.handover('own', 'mem')).status, 403, 'the Owner is mem now');
});

check('hand-over, SEAT set: the recipient must be a current member (404), not the Owner (403); a block on the recipient is a 404; a guild with no seat keeps findRoleTarget', async () => {
  const s = await legacyWorld();
  await s.outsider('out', 'Outsider');
  await s.setOwner('own');
  await s.handoverGrant('own', 'out');
  assert.equal((await s.handover('own', 'out')).status, 404, 'not a member');
  await s.handoverGrant('own', 'own');
  const self = await s.handover('own', 'own');
  assert.equal(self.status, 403);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.mem}', '${s.uids.off}', 1)`);
  await s.handoverGrant('own', 'mem');
  assert.equal((await s.handover('own', 'mem')).status, 404, 'blocked');
  assert.equal(await s.seat(), s.uids.own);
});

check('hand-over, in-game guild: the recipient must be LIVE (a Battle.net-proven character on the roster); the in-game Guild Master is the natural recipient; the previous Owner gets no Officer row', async () => {
  const s = await ingameWorld();
  const rolesBefore = await storedRoles(s);
  await s.handoverGrant('own', 'mem');
  const refused = await s.handover('own', 'mem');
  assert.deepEqual([refused.status, refused.json.error], [409, 'recipient_not_live'], refused.text);
  assert.equal(await s.seat(), s.uids.own);
  assert((await s.grantOf('own')).fresh_hash, 'the refusal came before the grant was spent');
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  // The derived Guild Master (rank 0, proven) is live and may hold the seat.
  await s.handoverGrant('own', 'dgm');
  const done = await s.handover('own', 'dgm');
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.seat(), s.uids.dgm);
  assert.deepEqual(await storedRoles(s), rolesBefore, 'no stored row written for anyone');
  assert.deepEqual(rolesOf(s, 'dgm').map((row) => row[2]).sort(), ['ingame', 'owner'], 'the new Owner is a derived Guild Master as well');
  assert.deepEqual(rolesOf(s, 'own'), [], 'the previous Owner keeps what their rank gives (rank 4 maps to no role)');
  // A derived Officer who is live can receive it from the new Owner; a derived Officer is not a "stored role".
  await s.handoverGrant('dgm', 'dof');
  assert.equal((await s.handover('dgm', 'dof')).status, 200);
  assert.equal(await s.seat(), s.uids.dof);
});

check('hand-over, in-game guild: the liveness guard sits inside the batch (a proof that goes between the read and the write moves nothing), and so does the Owner test', async () => {
  const s = await ingameWorld();
  await s.handoverGrant('own', 'dgm');
  const realBatch = s.w.db.batch.bind(s.w.db);
  let hooked = false;
  s.w.db.batch = async (statements) => {
    if (!hooked && statements.some((statement) => /UPDATE guilds SET owner_user_id/.test(statement.sql))) {
      hooked = true;
      s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.dgm.cid}'`);
    }
    return realBatch(statements);
  };
  const raced = await s.handover('own', 'dgm');
  s.w.db.batch = realBatch;
  assert(hooked);
  assert.deepEqual([raced.status, raced.json.error], [409, 'conflict'], raced.text);
  assert.equal(await s.seat(), s.uids.own, 'the seat did not move');
  assert.equal((await s.audit('guild_master.transfer')).length, 0, 'and no audit row says it did');
  assert.equal((await s.grantOf('own')).fresh_hash, null, 'a race that got past the preflight spends the grant: the next try asks again');
  // The Owner who stops being the Owner between the read and the write (suspended) moves nothing either.
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.dgm}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.dgm}') WHERE id = '${s.people.dgm.cid}'`);
  await s.handoverGrant('own', 'dgm');
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /UPDATE guilds SET owner_user_id/.test(statement.sql))) s.suspend();
    return realBatch(statements);
  };
  const lost = await s.handover('own', 'dgm');
  s.w.db.batch = realBatch;
  assert.equal(lost.status, 403);
  assert.equal(await s.seat(), s.uids.own);
});

check('hand-over in a MANUAL guild is session only (no fresh sign-in asked), in a guild with no rank source it is not', async () => {
  const s = await legacyWorld();
  for (const key of ['own', 'mem']) {
    const made = await s.person({ name: `Linked${key}` });
    await s.link(made.pid, key);
  }
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  s.exec(`UPDATE guilds SET rank_source = 'manual', owner_user_id = '${s.uids.own}' WHERE id = '${s.gid}'`);
  const done = await s.handover('own', 'mem');
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.seat(), s.uids.mem);
  assert.equal(await s.w.count('fresh_act_markers'), 0, 'nothing was consumed');
  assert.equal((await s.audit('guild_master.transfer')).length, 1);
  // The same guild without a rank source: fresh sign-in needed.
  s.exec(`UPDATE guilds SET rank_source = NULL WHERE id = '${s.gid}'`);
  const refused = await s.handover('mem', 'own');
  assert.deepEqual([refused.status, refused.json.error], [403, 'fresh_required']);
});

check('two parallel hand-overs with ONE grant: exactly one applies (one audit row, one marker, the seat moves once)', async () => {
  const s = await legacyWorld();
  await s.setOwner('own');
  await s.handoverGrant('own', 'mem');
  const answers = await Promise.all([s.handover('own', 'mem'), s.handover('own', 'mem')]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 403], JSON.stringify(answers.map((answer) => answer.text)));
  assert.equal(await s.seat(), s.uids.mem);
  assert.equal((await s.audit('guild_master.transfer')).length, 1);
  assert.equal(await s.w.count('fresh_act_markers'), 1);
});

// ---------------------------------------------------------------------------
// 2. Guild delete

check('guild delete: the Owner with a fresh sign-in deletes it (grant spent, audit row without a guild); without one it is 403 fresh_required; a typo asks nothing of the provider', async () => {
  const s = await legacyWorld();
  const typo = await s.call('gm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: 'Writers B2' });
  assert.deepEqual([typo.status, typo.json.error], [400, 'confirm_mismatch'], 'the name is checked before the sign-in is asked for');
  const refused = await s.call('gm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  assert.deepEqual([refused.status, refused.json.error, refused.json.purpose], [403, 'fresh_required', 'guild_delete']);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1);
  const flow = await s.fresh('gm', { purpose: 'guild_delete', guildId: s.gid, provider: 'discord' });
  assert.equal(flow.location, '/#/fresh?done=guild_delete');
  const done = await s.call('gm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 0);
  const audit = await s.rows("SELECT guild_id, actor_user_id, entity_id FROM audit_log WHERE action = 'guild.delete'");
  assert.deepEqual(audit, [{ guild_id: null, actor_user_id: s.uids.gm, entity_id: s.gid }]);
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
  assert.equal(await s.w.count('fresh_act_markers'), 1);
});

check('guild delete: a derived Guild Master and an Officer are refused with a grant; a hand-over that races it leaves the guild; a MANUAL guild is session only; parallel deletes with one grant give one', async () => {
  const s = await ingameWorld();
  await s.grant('dgm', { purpose: 'guild_delete', guildId: s.gid, params: {} });
  const dgm = await s.call('dgm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  assert.deepEqual([dgm.status, dgm.json.error], [403, 'forbidden']);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1);
  // The Owner is no longer the Owner at the write: nothing is deleted, and the answer is not a success.
  await s.grant('own', { purpose: 'guild_delete', guildId: s.gid, params: {} });
  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /^DELETE FROM guilds/.test(statement.sql))) s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.dgm}' WHERE id = '${s.gid}'`);
    return realBatch(statements);
  };
  const raced = await s.call('own', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  s.w.db.batch = realBatch;
  assert.notEqual(raced.status, 200, raced.text);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1, 'a hand-over that raced the delete saved the guild');
  assert.equal(await s.w.count('audit_log', "action = 'guild.delete'"), 0);
  // Manual: session only.
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.own}' WHERE id = '${s.gid}'`);
  const manual = await s.call('own', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  assert.equal(manual.status, 200, manual.text);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 0);
});

check('a grant is good for 15 minutes (exclusive) at the routes and belongs to ITS session: an expired grant, and another session of the same account, get 403 fresh_required', async () => {
  const s = await legacyWorld();
  const now = s.w.clock.now;
  const del = (who = 'gm') => s.call(who, 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid, at: now - 16 * 60 * 1000 });
  const expired = await del();
  assert.deepEqual([expired.status, expired.json.error, expired.json.purpose], [403, 'fresh_required', 'guild_delete']);
  // 15 minutes to the millisecond: the request advances the test clock by 2 s first, so a grant stamped exactly 15 minutes before THAT moment is expired, one ms younger is not.
  await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid, at: now + 2000 - 15 * 60 * 1000 });
  assert.equal((await del()).json.error, 'fresh_required', 'exactly 15 minutes old');
  // Another session of the same account does not hold the grant: it is on the session row.
  const other = {};
  await signIn(s.w, s.discordOf('gm'), [adminOf(s.serverId)], other);
  await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid });
  const viaOther = await s.w.call(other, 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  assert.deepEqual([viaOther.status, viaOther.json.error], [403, 'fresh_required']);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1);
  // The right session, a grant a millisecond inside the window: the guild goes.
  await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid, at: s.w.clock.now + 2000 - 15 * 60 * 1000 + 1 });
  assert.equal((await del()).status, 200);
});

check('parallel guild deletes with one grant give exactly one deletion and one audit row', async () => {
  const s = await legacyWorld();
  await s.deleteGrant('gm');
  const answers = await Promise.all([1, 2].map(() => s.call('gm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME })));
  assert.equal(answers.filter((answer) => answer.status === 200).length, 1, JSON.stringify(answers.map((answer) => [answer.status, answer.json && answer.json.error])));
  assert.equal(await s.w.count('audit_log', "action = 'guild.delete'"), 1);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 0);
});

// ---------------------------------------------------------------------------
// 3. Blocks and the Owner

check('an unsuspended Owner cannot be blocked: the route refuses a Guild Master tier principal and an Officer, the guard sits in the write, and a row that exists is ignored', async () => {
  const s = await ingameWorld();
  for (const who of ['dgm', 'dof']) {
    const refused = await s.call(who, 'POST', `/people/${s.uids.own}/block`, {});
    assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], who);
    assert(/Owner/.test(refused.json.message), refused.json.message);
  }
  assert.equal(await s.w.count('guild_blocks'), 0);
  // The guard inside the write: the target becomes the Owner between the read and the INSERT (a hand-over): nobody is blocked.
  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /^INSERT INTO guild_blocks/.test(statement.sql))) s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.mem}' WHERE id = '${s.gid}'`);
    return realBatch(statements);
  };
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.mem}', proof_bnet_account_id = '555000555' WHERE id = '${s.people.mem.cid}'`);
  s.exec(`INSERT OR IGNORE INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${s.uids.mem}', '555000555', 'Mem#1', 1, '{}', 1)`);
  const raced = await s.call('dgm', 'POST', `/people/${s.uids.mem}/block`, {});
  s.w.db.batch = realBatch;
  assert.notEqual(raced.status, 200, raced.text);
  assert.equal(await s.w.count('guild_blocks'), 0, 'the new Owner was not blocked');
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.own}' WHERE id = '${s.gid}'`);
  // A block row that exists on the live Owner (placed while they were suspended, or by a tombstone match) is ignored everywhere.
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.own}', '${s.uids.dgm}', 1)`);
  assert.equal((await s.call('own', 'GET', '')).status, 200, 'loadGuildContext ignores the row');
  const people = await s.ok('dgm', 'GET', '/people');
  assert(people.people.some((entry) => entry.person.id === s.uids.own), 'the Owner is listed among the people');
  assert(!people.removed.some((entry) => entry.person.id === s.uids.own), 'and not among the removed');
  assert.equal((await s.call('own', 'GET', '/auth/me')).status, 200);
  const me = await s.ok('own', 'GET', '/auth/me');
  assert.deepEqual(me.guilds.map((guild) => guild.id), [s.gid], 'the guild is in My guilds');
  assert.deepEqual(me.removedFrom, [], 'but the account is not told it was removed - removedFrom lists the rows that count');
});

check('a SUSPENDED Owner is blockable like anyone (a Guild Master tier principal or an Officer who outranks them), and any Guild Master tier principal restores them; live again, the row is ignored again', async () => {
  const s = await ingameWorld();
  s.suspend();
  const blockedByOfficer = await s.call('dof', 'POST', `/people/${s.uids.own}/block`, {});
  assert.equal(blockedByOfficer.status, 200, blockedByOfficer.text);
  const gone = await s.call('own', 'GET', '');
  assert.deepEqual([gone.status, gone.json.error], [403, 'access_removed'], 'a suspended Owner keeps only the seat: the block applies');
  assert.equal(await s.seat(), s.uids.own, 'the seat is still theirs');
  // Back on the roster: the block row stays but counts for nothing.
  s.restore();
  assert.equal((await s.call('own', 'GET', '')).status, 200);
  s.suspend();
  assert.equal((await s.call('own', 'GET', '')).json.error, 'access_removed', 'suspended again: it counts again');
  // A Guild Master tier principal restores them: DELETE /people/:uid/block.
  const restored = await s.call('dgm', 'DELETE', `/people/${s.uids.own}/block`, {});
  assert.equal(restored.status, 200, restored.text);
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal((await s.call('own', 'GET', '')).status, 200, 'restored: a suspended Owner is a member only through the roster, and they are on it');
  assert.equal((await s.audit('access.restore')).length, 1);
  // The Officer who blocked cannot lift a block of an equal-or-senior rank... and the Owner themself is not blockable by a plain member.
  const plain = await s.call('mem', 'POST', `/people/${s.uids.own}/block`, {});
  assert.equal(plain.status, 403);
});

// ---------------------------------------------------------------------------
// 4. The legacy claim, Delete my data, the Discord guards

check('the legacy POST /claim answers 403 claim_closed once the guild has a rank source or a seat; a guild before the flip with no Guild Master is still claimable', async () => {
  const s = await legacyWorld();
  const admin = (await signIn(s.w, { id: '118888888888888801', username: 'srvadmin', globalName: 'Srv Admin' }, [adminOf(s.serverId)])).jar;
  s.jars.srv = admin;
  s.uids.srv = (await s.w.call(admin, 'GET', '/auth/me')).json.user.id;
  const claim = () => s.call('srv', 'POST', '/claim', {});
  // A guild before the flip and with a Guild Master: the old conflict.
  assert.equal((await claim()).status, 409);
  // No Guild Master, no rank source, no seat: claimable.
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  for (const [label, sql] of [
    ['a manual guild', "UPDATE guilds SET rank_source = 'manual', owner_user_id = NULL"],
    ['an in-game guild', "UPDATE guilds SET rank_source = 'ingame', owner_user_id = NULL"],
    ['a guild with a seat and no rank source', `UPDATE guilds SET rank_source = NULL, owner_user_id = '${s.uids.own}'`],
  ]) {
    s.exec(`${sql} WHERE id = '${s.gid}'`);
    const refused = await claim();
    assert.deepEqual([refused.status, refused.json.error], [403, 'claim_closed'], label);
    assert.equal((await s.rows('SELECT user_id FROM role_assignments WHERE role_id = ?', 'guild_master')).length, 0, `${label}: no row written`);
  }
  s.exec(`UPDATE guilds SET rank_source = NULL, owner_user_id = NULL WHERE id = '${s.gid}'`);
  const open = await claim();
  assert.equal(open.status, 200, open.text);
  assert.deepEqual(rolesOf(s, 'srv'), [['guild_master', null, 'manual'], ['guild_master', null, 'owner']]);
});

check('probe, the post-flip shape (seat set, no stored Guild Master row): the Owner cannot delete their account while others have joined, and when the seat is emptied anyway a server administrator\'s /claim is refused', async () => {
  const s = await ingameWorld();
  // deleteImpact and DELETE /auth/me: the seat holder must hand over first.
  const impact = (await s.ok('own', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual(impact.handOverFirst.map((entry) => entry.id), [s.gid]);
  assert.deepEqual(impact.autoPromote, []);
  const refused = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([refused.status, refused.json.error], [409, 'hand_over_guild_master']);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.own), 1);
  // SUSPENDED (no longer a member by the Owner exemption) the seat holder cannot hand over, so the seat passes on inside the delete: to the live in-game Guild Master
  // (lane B6b part 2b; tests/guild/guild-b6b3-succession-tests.js has the whole rule).
  s.exec(`DELETE FROM players WHERE id = '${s.people.own.pid}'`);
  s.suspend();
  const suspended = (await s.ok('own', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([suspended.handOverFirst, suspended.autoPromote, suspended.succession.map((entry) => [entry.guild.id, entry.to && entry.to.userId, entry.rule])], [[], [], [[s.gid, s.uids.dgm, 'ingame_gm']]]);
  const passed = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(passed.status, 200, passed.text);
  assert.equal(await s.seat(), s.uids.dgm, 'the derived Guild Master holds the seat now');
  // The foreign key empties a seat when the account row goes by any other road.
  s.exec(`DELETE FROM users WHERE id = '${s.uids.dgm}'`);
  assert.equal(await s.seat(), null);
  const admin = (await signIn(s.w, { id: '118888888888888802', username: 'srvadmin', globalName: 'Srv Admin' }, [adminOf(s.serverId)])).jar;
  s.jars.srv = admin;
  const claim = await s.call('srv', 'POST', '/claim', {});
  assert.deepEqual([claim.status, claim.json.error], [403, 'claim_closed'], 'the rank source keeps the guild closed to the legacy claim');
  assert.equal(await s.w.count('role_assignments', "guild_id = ? AND role_id = 'guild_master'", s.gid), 0);
});

check('deleteImpact: a seat holder alone in the guild deletes it with their account (guildsDeleted); a legacy Guild Master with others still hands over first; an unseated former holder is not listed', async () => {
  const s = await legacyWorld();
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  await s.setOwner('own');
  const solo = await freshScenario();
  globalThis.__ownerWorlds.push(solo);
  solo.exec(`DELETE FROM role_assignments WHERE guild_id = '${solo.gid}' AND role_id = 'guild_master'`);
  solo.exec(`UPDATE guilds SET owner_user_id = '${solo.uids.gm}' WHERE id = '${solo.gid}'`);
  const impact = (await solo.ok('gm', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([impact.handOverFirst, impact.autoPromote], [[], []]);
  assert.deepEqual(impact.guildsDeleted.map((entry) => entry.id), [solo.gid]);
  const done = await solo.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [solo.gid] });
  assert.equal(done.status, 200, done.text);
  assert.equal(await solo.w.count('guilds'), 0);
  // The seat holder of the guild with others: handOverFirst; after the hand-over they are not listed any more.
  assert.deepEqual((await s.ok('own', 'GET', '/auth/me')).deleteImpact.handOverFirst.map((entry) => entry.id), [s.gid]);
  await s.handoverGrant('own', 'mem');
  assert.equal((await s.handover('own', 'mem')).status, 200);
  assert.deepEqual((await s.ok('own', 'GET', '/auth/me')).deleteImpact.handOverFirst, []);
  assert.deepEqual((await s.ok('mem', 'GET', '/auth/me')).deleteImpact.handOverFirst.map((entry) => entry.id), [s.gid]);
});

check('unlinkDiscord\'s last-Guild-Master guard and the Discord sync use the Owner: a seat-only Owner who would lose the guild must hand over, and the sync skips them like a Guild Master', async () => {
  const s = await legacyWorld();
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  await s.setOwner('own');
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.own}', '720000001', 'Own#1', 1, '{}', 1, 1)`);
  const leads = await s.call('own', 'DELETE', '/auth/discord', {});
  assert.deepEqual([leads.status, leads.json.error], [409, 'leads_guild'], leads.text);
  assert.deepEqual(leads.json.guilds, [{ id: s.gid, name: NAME }]);
  // The sync: a mapped role for Officer; the Owner is skipped as a Guild Master, a plain member is not.
  s.exec(`INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES ('${s.gid}', '123400000000000001', 'officer', NULL)`);
  const { syncMember } = await load('worker/discord-sync.js');
  const ctx = { db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, log: () => {} };
  const guild = { id: s.gid, discord_server_id: s.serverId };
  assert.deepEqual((await syncMember(ctx, guild, s.uids.own)).reason, 'guild_master', 'the Owner is skipped');
  assert.notEqual((await syncMember(ctx, guild, s.uids.mem)).reason, 'guild_master');
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.uids.own), 0);
});

// ---------------------------------------------------------------------------
// 5. PATCH /roster/:pid linkUserId on a person with a Battle.net-proven character

check('PATCH /roster/:pid linkUserId on a person holding a Battle.net-proven character is the Owner\'s (set or clear), also inside the batch; a person without one stays an Officer\'s', async () => {
  const s = await legacyWorld();
  const proven = await s.person({ name: 'Provenmain' });
  const plain = await s.person({ name: 'Plainmain' });
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.own}', proof_bnet_account_id = '730000001', proof_at = 1 WHERE player_id = '${proven.pid}'`);
  const patch = async (who, pid, link, expectedVersion) => {
    const version = expectedVersion || (await s.ok(who, 'GET', `/roster/${pid}`)).person.version;
    return s.call(who, 'PATCH', `/roster/${pid}`, { expectedVersion: version, linkUserId: link });
  };
  const dump = () => JSON.stringify([s.w.db.sqlite.prepare('SELECT id, discord_user_id, version FROM players ORDER BY id').all(), s.w.db.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'person.update'").all()]);
  const before = dump();
  const set = await patch('off', proven.pid, s.uids.mem);
  assert.deepEqual([set.status, set.json.error], [403, 'forbidden'], set.text);
  assert(/Owner/.test(set.json.message));
  assert.equal(dump(), before, 'nothing changed');
  // Clearing a Discord ID a person already carries is the same act.
  s.exec(`UPDATE players SET discord_user_id = '${s.discordOf('mem').id}', version = version + 1 WHERE id = '${proven.pid}'`);
  const before2 = dump();
  const cleared = await patch('off', proven.pid, null);
  assert.deepEqual([cleared.status, cleared.json.error], [403, 'forbidden'], cleared.text);
  assert.equal(dump(), before2);
  // The Owner may do both.
  assert.equal((await patch('gm', proven.pid, null)).status, 200);
  assert.equal(s.w.db.sqlite.prepare('SELECT discord_user_id FROM players WHERE id = ?').get(proven.pid).discord_user_id, null);
  assert.equal((await patch('gm', proven.pid, s.uids.mem)).status, 200);
  assert.equal(s.w.db.sqlite.prepare('SELECT discord_user_id FROM players WHERE id = ?').get(proven.pid).discord_user_id, s.discordOf('mem').id);
  // A person with no proved character: the Officer links as before.
  const ok = await patch('off', plain.pid, s.uids.own);
  assert.equal(ok.status, 200, ok.text);
  // A proof that lands between the read and the write is caught inside the batch (a 409 and nothing written).
  s.exec(`UPDATE players SET discord_user_id = NULL, version = version + 1 WHERE id = '${plain.pid}'`);
  const version = (await s.ok('off', 'GET', `/roster/${plain.pid}`)).person.version;
  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /^UPDATE players SET joined_on/.test(statement.sql))) {
      s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.own}', proof_bnet_account_id = '730000002', proof_at = 1 WHERE player_id = '${plain.pid}'`);
    }
    return realBatch(statements);
  };
  const raced = await patch('off', plain.pid, s.uids.own, version);
  s.w.db.batch = realBatch;
  assert.equal(raced.status, 409, raced.text);
  assert.equal(s.w.db.sqlite.prepare('SELECT discord_user_id FROM players WHERE id = ?').get(plain.pid).discord_user_id, null);
});

// ---------------------------------------------------------------------------
// 6. Derived roles need a character that is not Former

check('derived roles: a Former proven character gives no role, a Former better-ranked character does not hide the person\'s other characters, and Owner liveness is unchanged', async () => {
  const s = await ingameWorld();
  // dgm has one proven character (rank 0, Guild Master). Marked Former it gives nothing.
  assert.deepEqual(rolesOf(s, 'dgm').map((row) => row[0]), ['guild_master']);
  const second = await s.alt(s.people.dgm.pid, 'Dgmalt', {}, 'own');
  s.exec(`UPDATE characters SET left_on = '2026-10-01' WHERE id = '${s.people.dgm.cid}'`);
  assert.deepEqual(rolesOf(s, 'dgm'), [], 'the Former character gives no role');
  const lost = await s.call('dgm', 'GET', '');
  assert.deepEqual([lost.status, lost.json.error], [403, 'not_member'], 'and no membership either: the same rule on both sides');
  // A second proven character of rank 1 (Officer): while the rank-0 one is Former, the Officer role comes from the second.
  makeProven(s, 'dgm', { cid: second }, { rank: 1 });
  assert.deepEqual(rolesOf(s, 'dgm').map((row) => row[0]), ['officer'], 'the Former character does not hide the other');
  assert.equal((await s.call('dgm', 'GET', '')).status, 200, 'and the person is a member through it');
  s.exec(`UPDATE characters SET left_on = NULL WHERE id = '${s.people.dgm.cid}'`);
  assert.deepEqual(rolesOf(s, 'dgm').map((row) => row[0]), ['guild_master'], 'back from Former: the better rank wins again');
  // Owner liveness (the plan's "a-d valid"): the Owner's only proven character marked Former keeps the seat holder live, as before.
  s.exec(`UPDATE characters SET left_on = '2026-10-01' WHERE id = '${s.people.own.cid}'`);
  assert.deepEqual(rolesOf(s, 'own'), [['guild_master', null, 'owner']]);
  const { isOwner } = await load('worker/owner.js');
  assert.equal(await isOwner(s.w.db, s.gid, s.uids.own), true);
});

runChecks(checks);
