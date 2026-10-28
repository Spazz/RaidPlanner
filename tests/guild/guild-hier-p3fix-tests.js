/**
 * Raidsmith guild tracker - the PART 3 FIX ROUND of the user-hierarchy build (branch guild/hier-p3fix; the seven items of the lane prompt)
 * Run: node tests/guild/guild-hier-p3fix-tests.js [name filter]
 *
 *   1  L2 (tasks/open/audit-b6b3-security.md): the answer of a hand-over goes to the PREVIOUS Owner and carries the People list / removed list only when their new context may read it
 *      (the gate of GET /people); otherwise the bare { handedOver: true }; the client drops the stale list and leaves the tab;
 *   2  a 'manual' guild's Owner is always a member (the Owner exemption of the in-game rule), in the route gate, My guilds, the People list, the pure rule and the flip dry run;
 *   3  hand-over and guild delete need the fresh sign-in in a manual guild too, with the Owner's own identity (Discord or Battle.net);
 *   4  Delete my data is refused ("Hand the guild over first.") when a manual guild's Owner seat would end up empty, at the read AND inside the write (a member who joined in between);
 *   5  a blocked account that links a NEW Battle.net account gets a block tombstone for it in each guild that blocks it;
 *   6  a failed first roster sync during the setup pin hands the sync lease back: Sync now works at once;
 *   7  a malformed Blizzard roster during a Guild Master claim is a Battle.net problem: not counted as a failed claim, and the claimant's start budget is given back.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { ACCOUNT, ID, claimWorld, claim, entry, refused, DONE, tieToGuild, seatOf } = require('../guild-claim');
const { freshScenario } = require('../guild-fresh');
const { flip, makeProven } = require('../guild-ingame');
const { pinWorld, pin, pinRow } = require('../guild-pin');

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
      globalThis.__pinWorlds = worlds;
      try { await fn(); } finally { await Promise.all(worlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 100)); }
    },
  });
}
const HOUR = 60 * 60 * 1000;
const NAME = 'Writers B3';
const KEY = 'a-test-tombstone-key-of-16-plus-chars';

async function world(options) {
  const s = await freshScenario(options);
  globalThis.__fixWorlds.push(s);
  s.people = {};
  s.seat = async () => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
  s.audit = (action) => s.rows('SELECT actor_user_id, entity_id, actor_role, before, after FROM audit_log WHERE action = ? ORDER BY created_at, id', action);
  s.handover = (who, target) => s.call(who, 'POST', `/people/${s.uids[target]}/guild-master`, {});
  s.deleteGuild = (who) => s.call(who, 'DELETE', `/api/guild/${s.gid}`, { confirmName: NAME });
  return s;
}

// A hook on db.batch: `action` runs once, just before the first batch with a statement that matches.
function beforeBatch(s, matcher, action) {
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => matcher.test(statement.sql))) { fired = true; action(); }
    return real(statements);
  };
  return () => { s.w.db.batch = real; };
}

// The in-game guild of the Owner suites: the live Owner 'own' (rank 4, proved by Battle.net), a derived Guild Master 'dgm' (rank 0, proved) and a plain member 'mem'.
async function ingameWorld() {
  const s = await world({ teams: ['Alpha', 'Bravo'] });
  for (const [key, name, rank, proof] of [['own', 'Seatowner', 4, 'bnet'], ['dgm', 'Derivedgm', 0, 'bnet'], ['mem', 'Plainmember', 5, 'officer']]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
    makeProven(s, key, s.people[key], { rank, proof, link: proof === 'bnet' });
  }
  flip(s, { owner: 'own' });
  return s;
}

// A guild whose rank source is 'manual': the seat is on 'own' (a Discord account that has NO person of its own and, to prove the Discord server grants nothing, is in no server),
// 'mem' and 'mem2' are members linked to a person. The creator 'gm' holds nothing any more (a stored Guild Master row grants nothing once the guild has a rank source).
async function manualWorld(options = {}) {
  const s = await world(options);
  await s.member('own', 'Seatowner');
  for (const [key, name] of [['mem', 'Memberone'], ['mem2', 'Membertwo']]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
  }
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  s.exec(`UPDATE guilds SET rank_source = 'manual', owner_user_id = '${s.uids.own}' WHERE id = '${s.gid}'`);
  s.exec(`DELETE FROM user_servers WHERE user_id = '${s.uids.own}'`);
  return s;
}

// ---------------------------------------------------------------------------
// 1. L2: the hand-over answer

check('L2: the hand-over answer carries the People list only when the previous Owner may still read it (the gate of GET /people); a Raider gets the bare answer and no blocked person leaks', async () => {
  const s = await ingameWorld();
  // A block with a reason, so the removed list has something worth withholding.
  assert.equal((await s.call('dgm', 'POST', `/people/${s.uids.mem}/block`, { reason: 'Sentinel reason' })).status, 200);
  assert.equal((await s.ok('own', 'GET', '/people')).removed.length, 1, 'the Owner reads the list a moment before');
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.dgm } });
  const done = await s.handover('own', 'dgm');
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { handedOver: true }, 'a plain Raider now: no People list, no removed list');
  assert(!done.text.includes('Sentinel reason') && !done.text.includes('Plainmember'), done.text);
  assert.equal(await s.seat(), s.uids.dgm);
  // The same list by the ordinary route is refused for the same account at the same moment: the two answers agree.
  assert.equal((await s.call('own', 'GET', '/people')).status, 403);
  assert.equal((await s.call('own', 'GET', '')).status, 200, 'and the previous Owner is still a member');
});

check('L2: a previous Owner who is a derived Officer after the hand-over still gets the list (guild.access); the full answer is unchanged for them', async () => {
  const s = await ingameWorld();
  s.exec(`UPDATE guild_roster SET rank = 1 WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${(await s.one('SELECT blizzard_char_id AS id FROM characters WHERE id = ?', s.people.own.cid)).id}`);
  assert.deepEqual((await s.one('SELECT 1 AS officer FROM effective_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?', s.gid, s.uids.own, 'officer')), { officer: 1 });
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.dgm } });
  const done = await s.handover('own', 'dgm');
  assert.equal(done.status, 200, done.text);
  assert(Array.isArray(done.json.people) && Array.isArray(done.json.removed), done.text);
  assert.equal(done.json.handedOver, undefined);
  assert(done.json.people.some((entryOf) => entryOf.person.id === s.uids.own && entryOf.isMe));
  assert.equal((await s.call('own', 'GET', '/people')).status, 200, 'the ordinary route agrees');
});

check('L2: a previous Owner who is no member after the hand-over (a manual guild, no person of their own) still gets the bare answer', async () => {
  const s = await manualWorld();
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem } });
  const done = await s.handover('own', 'mem');
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { handedOver: true });
  const gone = await s.call('own', 'GET', '');
  assert.deepEqual([gone.status, gone.json.error], [403, 'not_member']);
});

// ---------------------------------------------------------------------------
// 2. The Owner exemption of a manual guild

check('manual guild: the Owner is always a member - no person, no Discord server - in the route gate, My guilds and the People list; an unlinked account is not; the exemption leaves with the seat', async () => {
  const s = await manualWorld();
  const gate = await s.call('own', 'GET', '');
  assert.equal(gate.status, 200, gate.text);
  const me = await s.ok('own', 'GET', '/auth/me');
  assert.deepEqual(me.guilds.map((guild) => guild.id), [s.gid], 'My guilds');
  const people = await s.ok('own', 'GET', '/people');
  const own = people.people.find((entryOf) => entryOf.person.id === s.uids.own);
  assert(own && own.isMe, 'the Owner is in the People list');
  assert.deepEqual(own.roles.map((role) => role.role), ['guild_master']);
  assert.equal(people.people.length, 3, 'the Owner and the two linked members');
  // Everybody else still needs a link: the creator holds a stored row that grants nothing here, and the Discord server grants nothing.
  const creator = await s.call('gm', 'GET', '');
  assert.deepEqual([creator.status, creator.json.error], [403, 'not_member']);
  assert.equal((await s.call('mem', 'GET', '')).status, 200, 'a linked member');
  // A block row on the Owner is ignored, as for an in-game Owner.
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.own}', '${s.uids.mem}', 1)`);
  assert.equal((await s.call('own', 'GET', '')).status, 200);
  s.exec(`DELETE FROM guild_blocks WHERE guild_id = '${s.gid}'`);
  // The seat moves: the old Owner (no person) is no member, the new one is.
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem } });
  assert.equal((await s.handover('own', 'mem')).status, 200);
  assert.deepEqual([(await s.call('own', 'GET', '')).status, (await s.ok('own', 'GET', '/auth/me')).guilds.length], [403, 0]);
  assert.equal((await s.call('mem', 'GET', '')).status, 200);
});

check('manual guild: the pure rule and every SQL fragment of worker/membership.js agree - the Owner counts, the Discord server does not; the candidate set holds the Owner', async () => {
  const m = await load('worker/membership.js');
  assert.equal(m.reachesOf({ source: 'manual', owner: true }), true);
  assert.equal(m.reachesOf({ source: 'manual', linked: true }), true);
  assert.equal(m.reachesOf({ source: 'manual', inServer: true }), false);
  assert.equal(m.reachesOf({ source: 'manual' }), false);
  assert.equal(m.membershipOf({ blocked: true, source: 'manual', owner: true }), 'member', 'a block does not apply to the Owner');
  assert.equal(m.membershipOf({ blocked: true, source: 'manual', linked: true }), 'blocked');
  assert.equal(m.reachesOf({ source: null, owner: true }), false, 'a legacy guild is unchanged: the Owner needs the server or a link');
  const s = await manualWorld();
  const row = await s.one(
    `SELECT ${m.memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member, ${m.reachesGuildSql('u.id', 'g.id', 'g.discord_server_id')} AS reaches,
            u.id IN (${m.memberCandidatesSql('g.id', 'g.discord_server_id')}) AS candidate
       FROM users u, guilds g WHERE u.id = ? AND g.id = ?`, s.uids.own, s.gid);
  assert.deepEqual([row.member, row.reaches, row.candidate], [1, 1, 1]);
  const creator = await s.one(`SELECT ${m.memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member FROM users u, guilds g WHERE u.id = ? AND g.id = ?`, s.uids.gm, s.gid);
  assert.equal(creator.member, 0);
  const bound = m.boundMember(s.uids.own, s.gid, null);
  assert.equal((await s.w.db.prepare(`SELECT ${bound.sql} AS ok`).bind(...bound.params).first()).ok, 1, 'the bound form says the same');
});

check('manual guild: the flip dry run counts the Owner as a member TODAY and names the exemption when they would lose it', async () => {
  const s = await world();
  await s.member('mem', 'Linkedone');
  const made = await s.person({ name: 'Linkedone' });
  await s.link(made.pid, 'mem');
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  await s.setOwner('gm'); // the seat holder, with no person of their own
  const res = await s.call('gm', 'POST', '/flip/dry-run', {});
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.rankSource, 'manual');
  assert.deepEqual(res.json.access.members, { today: 2, afterFlip: 0 }, 'the Owner (exemption) and the linked member today; after the flip neither is on the in-game roster');
  assert.deepEqual(res.json.access.loses.reasons, { owner_exemption: 1, no_roster_character: 1 });
  const lost = Object.fromEntries(res.json.access.loses.samples.map((sample) => [sample.reason, sample]));
  assert.equal(lost.owner_exemption.userId, s.uids.gm);
  // A legacy guild keeps its labels: an Owner who is a member through the Discord server only is still 'discord_only'.
  s.exec(`UPDATE guilds SET rank_source = NULL WHERE id = '${s.gid}'`);
  s.exec(`INSERT OR IGNORE INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES ('ra_p3fix_gm', '${s.gid}', '${s.uids.gm}', 'guild_master', NULL, NULL, 1)`);
  const legacy = await s.call('gm', 'POST', '/flip/dry-run', {});
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.json.access.loses.reasons.owner_exemption, undefined);
});

// ---------------------------------------------------------------------------
// 3. The fresh sign-in for a manual guild's Owner

check('manual guild: hand-over and guild delete are refused without the fresh sign-in; the real Discord flow lets the Owner through; the new Owner deletes the same way', async () => {
  const s = await manualWorld();
  const noGrant = await s.handover('own', 'mem');
  assert.deepEqual([noGrant.status, noGrant.json.error, noGrant.json.purpose], [403, 'fresh_required', 'handover'], noGrant.text);
  assert.deepEqual(noGrant.json.params, { targetUserId: s.uids.mem });
  assert.equal(await s.seat(), s.uids.own);
  const noDelete = await s.deleteGuild('own');
  assert.deepEqual([noDelete.status, noDelete.json.error, noDelete.json.purpose], [403, 'fresh_required', 'guild_delete'], noDelete.text);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1);
  // The start step offers the Owner's identity (Discord here) and writes the grant at the callback.
  const flow = await s.fresh('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem }, provider: 'discord' });
  assert.equal(flow.start.json.provider, 'discord');
  assert.equal(flow.location, '/#/fresh?done=handover');
  const done = await s.handover('own', 'mem');
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.seat(), s.uids.mem);
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'handover'"), 1, 'the grant was consumed');
  assert.equal((await s.audit('guild_master.transfer')).length, 1);
  // The new Owner: refused alone, deletes with their own sign-in.
  assert.equal((await s.deleteGuild('mem')).json.error, 'fresh_required');
  const deleteFlow = await s.fresh('mem', { purpose: 'guild_delete', guildId: s.gid, provider: 'discord' });
  assert.equal(deleteFlow.location, '/#/fresh?done=guild_delete');
  assert.equal((await s.deleteGuild('mem')).status, 200);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 0);
});

check('manual guild: an Owner whose account has Battle.net only confirms with Battle.net (Discord is not offered); the same grant rules hold', async () => {
  const s = await manualWorld();
  await s.bnetSignUp('bown', ACCOUNT.igm);
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.bown}' WHERE id = '${s.gid}'`);
  assert.equal((await s.call('bown', 'GET', '')).status, 200, 'a Battle.net-only Owner is a member by the exemption');
  const params = { targetUserId: s.uids.mem };
  const noDiscord = await s.call('bown', 'POST', '/fresh/start', { purpose: 'handover', params, provider: 'discord' });
  assert.deepEqual([noDiscord.status, noDiscord.json.error], [409, 'identity_not_linked']);
  assert.deepEqual([(await s.handover('bown', 'mem')).status, (await s.deleteGuild('bown')).status], [403, 403]);
  const flow = await s.fresh('bown', { purpose: 'handover', guildId: s.gid, params, account: ACCOUNT.igm });
  assert.equal(flow.start.json.provider, 'bnet', 'the only identity the account has');
  assert.equal(flow.location, '/#/fresh?done=handover');
  assert.equal((await s.handover('bown', 'mem')).status, 200);
  assert.equal(await s.seat(), s.uids.mem);
  // Delete, as the Battle.net-only Owner of another manual guild would.
  const t = await manualWorld();
  await t.bnetSignUp('bown', ACCOUNT.igm);
  t.exec(`UPDATE guilds SET owner_user_id = '${t.uids.bown}' WHERE id = '${t.gid}'`);
  const deleteFlow = await t.fresh('bown', { purpose: 'guild_delete', guildId: t.gid, account: ACCOUNT.igm });
  assert.equal(deleteFlow.location, '/#/fresh?done=guild_delete');
  const deleted = await t.deleteGuild('bown');
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(await t.w.count('guilds', 'id = ?', t.gid), 0);
});

// ---------------------------------------------------------------------------
// 4. Delete my data and a manual guild's seat

check('Delete my data: the Owner of a manual guild with members is refused at the read ("Hand the guild over first."); handing over first lets the account go', async () => {
  const s = await manualWorld();
  const refusedRead = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([refusedRead.status, refusedRead.json.error, refusedRead.json.message], [409, 'hand_over_guild_master', 'Hand the guild over first.'], refusedRead.text);
  assert.deepEqual(refusedRead.json.guilds, [{ id: s.gid, name: NAME }]);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.own), 1);
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem } });
  assert.equal((await s.handover('own', 'mem')).status, 200);
  await s.grant('own', { purpose: 'account_delete' });
  const gone = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.own), 0);
  assert.equal(await s.seat(), s.uids.mem, 'the seat is where the hand-over put it');
});

check('Delete my data: a member who joins a manual guild AFTER the read cannot empty the seat - the write refuses, nothing is deleted, the grant is kept; with a stored Officer to take the seat the delete goes on', async () => {
  const s = await manualWorld();
  const unlinkAll = () => s.exec(`UPDATE players SET user_id = NULL WHERE guild_id = '${s.gid}'`);
  const linkAll = () => ['mem', 'mem2'].forEach((key) => s.exec(`UPDATE players SET user_id = '${s.uids[key]}' WHERE id = '${s.people[key].pid}'`));
  unlinkAll();
  const impact = (await s.ok('own', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([impact.handOverFirst, impact.guildsDeleted.map((guild) => guild.id)], [[], [s.gid]], 'alone at the read: the guild would go with the account');
  await s.grant('own', { purpose: 'account_delete' });
  const restore = beforeBatch(s, /DELETE FROM users WHERE id/, linkAll);
  const raced = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [s.gid] });
  restore();
  assert.deepEqual([raced.status, raced.json.error, raced.json.message], [409, 'hand_over_guild_master', 'Hand the guild over first.'], raced.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.own), 1, 'the account is still there');
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1, 'and so is the guild');
  assert.equal(await s.seat(), s.uids.own, 'the seat did not move and was not emptied');
  assert.equal(await s.w.count('audit_log', "action IN ('account.delete', 'guild.delete', 'guild.succession')"), 0);
  assert.equal(await s.w.count('fresh_act_markers'), 0, 'no marker: nothing of the batch applied');
  assert.equal((await s.grantOf('own')).fresh_purpose, 'account_delete', 'the grant was not spent: it is still good after the hand-over');
  // The way out: hand the guild over (a new grant, for that act), then the account goes.
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem } });
  assert.equal((await s.handover('own', 'mem')).status, 200);
  await s.grant('own', { purpose: 'account_delete' });
  assert.equal((await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);

  // With a stored Officer who is a member, the seat does not end up empty: it passes to them, as the plan says (the rule is "no successor").
  const t = await manualWorld();
  assert.equal((await t.call('own', 'PUT', `/people/${t.uids.mem2}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 200);
  t.exec(`UPDATE players SET user_id = NULL WHERE id = '${t.people.mem.pid}'`);
  t.exec(`UPDATE players SET user_id = NULL WHERE id = '${t.people.mem2.pid}'`);
  await t.grant('own', { purpose: 'account_delete' });
  const joined = beforeBatch(t, /DELETE FROM users WHERE id/, () => ['mem', 'mem2'].forEach((key) => t.exec(`UPDATE players SET user_id = '${t.uids[key]}' WHERE id = '${t.people[key].pid}'`)));
  const passed = await t.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [t.gid] });
  joined();
  assert.equal(passed.status, 200, passed.text);
  assert.equal(await t.seat(), t.uids.mem2, 'the stored Officer took the seat');
  assert.equal(await t.w.count('guilds', 'id = ?', t.gid), 1);
});

check('Delete my data: the in-write guard touches manual guilds only - an in-game guild keeps its succession rules, and a lost grant is still "fresh_required"', async () => {
  const { manualSeatKeptGuard } = await load('worker/succession.js');
  const s = await ingameWorld();
  const kept = manualSeatKeptGuard(s.uids.own);
  assert.equal((await s.w.db.prepare(`SELECT ${kept.sql} AS kept`).bind(...kept.params).first()).kept, 1, 'an in-game guild with members: not this guard\'s business');
  const m = await manualWorld();
  const guard = manualSeatKeptGuard(m.uids.own);
  assert.equal((await m.w.db.prepare(`SELECT ${guard.sql} AS kept`).bind(...guard.params).first()).kept, 0, 'a manual guild with members and no Officer: the seat would be empty');
  // No grant at all: the 403 comes first, whatever the seat.
  const unlinkAll = () => m.exec(`UPDATE players SET user_id = NULL WHERE guild_id = '${m.gid}'`);
  unlinkAll();
  const noGrant = await m.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [m.gid] });
  assert.deepEqual([noGrant.status, noGrant.json.error], [403, 'fresh_required']);
  // A grant lost between the read and the write (the guard passes) is a lost grant, not a seat problem.
  await m.grant('own', { purpose: 'account_delete' });
  const restore = beforeBatch(m, /DELETE FROM users WHERE id/, () => m.exec(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = '${m.uids.own}'`));
  const lost = await m.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [m.gid] });
  restore();
  assert.deepEqual([lost.status, lost.json.error], [403, 'fresh_required'], lost.text);
  assert.equal(await m.w.count('users', 'id = ?', m.uids.own), 1);
});

// ---------------------------------------------------------------------------
// 5. A blocked account links a NEW Battle.net account

const BNET = { bl: { id: '740000001', battletag: 'Blocked#0001' }, other: { id: '740000002', battletag: 'Other#0002' } };
const tombstonesOf = (s, ref) => s.rows('SELECT block_ref, key_version, hmac FROM block_tombstones WHERE guild_id = ? AND block_ref = ? ORDER BY hmac', s.gid, ref);

check('blocked account + a NEW Battle.net account: the new account id is tombstoned under the block, matches a brand-new account, and an unblock lifts it with the rest', async () => {
  const t = await load('worker/block-tombstones.js');
  const s = await world({ env: { TOMBSTONE_KEY: KEY } });
  await s.member('bl', 'Blockedone');
  await s.member('ok', 'Okayone');
  assert.equal((await s.call('gm', 'POST', `/people/${s.uids.bl}/block`, { reason: 'Rude' })).status, 200);
  const ref = `u:${s.uids.bl}`;
  assert.equal((await tombstonesOf(s, ref)).length, 1, 'the Discord id, from the block');
  const match = async (userId, keys) => {
    const statements = await t.tombstoneMatchStatements(s.w.db, { guildId: s.gid, userId, keys, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes });
    if (statements.length) await s.w.db.batch(statements);
    return statements.length;
  };
  const stranger = await s.member('stranger', 'Strangerone');
  assert.equal(await match(stranger, { bnetAccountId: BNET.bl.id }), 0, 'before the link nothing knows that Battle.net account');

  // A member who is NOT blocked links a Battle.net account: nothing is written, and the link costs the extra read of no statement.
  const mark = s.w.db.statementLog.length;
  assert.equal(await s.linkBnet('ok', BNET.other), '/#/characters');
  assert.equal(s.w.db.statementLog.slice(mark).some((statement) => /FROM guild_blocks WHERE user_id = \? AND pending_review = 0 ORDER BY guild_id/.test(statement.sql)), false);
  assert.equal(await s.w.count('block_tombstones', 'guild_id = ?', s.gid), 1);

  // The blocked account links a new one.
  assert.equal(await s.linkBnet('bl', BNET.bl), '/#/characters');
  const rows = await tombstonesOf(s, ref);
  assert.equal(rows.length, 2, 'the new account id is a key of the block now');
  const wanted = await t.tombstoneHmac(KEY, s.gid, `bnet:${BNET.bl.id}`);
  assert(rows.some((row) => row.hmac === wanted), 'with the HMAC of bnet:<id> in this guild');
  assert.equal(await match(stranger, { bnetAccountId: BNET.bl.id }), 2, 'a brand-new account presenting it is blocked for review');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND pending_review = 1', stranger), 1);
  // Linking it again (a refresh) writes nothing new.
  assert.equal(await s.linkBnet('bl', BNET.bl), '/#/characters');
  assert.equal((await tombstonesOf(s, ref)).length, 2);
  // Unblock lifts every tombstone of the block, the new one included.
  assert.equal((await s.call('gm', 'DELETE', `/people/${s.uids.bl}/block`, {})).status, 200);
  assert.equal((await tombstonesOf(s, ref)).length, 0);
});

check('blocked account + a NEW Battle.net account: a pending-review block is not tombstoned (an officer decides it first); without a usable TOMBSTONE_KEY the block is flagged for the daily repair, which then adds the key', async () => {
  const t = await load('worker/block-tombstones.js');
  const s = await world(); // no TOMBSTONE_KEY
  await s.member('bl', 'Blockedone');
  await s.member('pend', 'Pendingone');
  assert.equal((await s.call('gm', 'POST', `/people/${s.uids.bl}/block`, {})).status, 200);
  assert.equal(await s.w.count('guild_blocks', 'tombstone_missing = 1'), 1, 'made without a key: flagged already');
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES ('${s.gid}', '${s.uids.pend}', NULL, 'Matched an earlier block of the same person', 1, 1)`);
  s.exec(`UPDATE guild_blocks SET tombstone_missing = 0 WHERE user_id = '${s.uids.bl}'`);
  s.w.logs.length = 0;
  assert.equal(await s.linkBnet('bl', BNET.bl), '/#/characters');
  assert.equal(await s.w.count('block_tombstones'), 0, 'no key, no tombstone');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND tombstone_missing = 1', s.uids.bl), 1, 'flagged for the repair');
  assert(s.w.logs.some((line) => /TOMBSTONE_KEY is not set/.test(line)), 'and the operator line says why');
  assert.equal(await s.linkBnet('pend', BNET.other), '/#/characters');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND tombstone_missing = 1', s.uids.pend), 0, 'a pending-review block is left alone');
  // The key arrives: the daily repair writes the tombstones from the account's CURRENT keys, the new Battle.net account among them.
  const env = { ...s.w.env, TOMBSTONE_KEY: KEY };
  const repaired = await t.repairTombstones({ db: s.w.db, env, now: () => s.w.clock.now, log: () => {} });
  assert.equal(repaired.repaired, 1);
  const rows = await tombstonesOf(s, `u:${s.uids.bl}`);
  const wanted = await t.tombstoneHmac(KEY, s.gid, `bnet:${BNET.bl.id}`);
  assert(rows.some((row) => row.hmac === wanted), 'the repair added the new Battle.net account');
  assert.equal(await s.w.count('guild_blocks', 'user_id = ? AND tombstone_missing = 1', s.uids.bl), 0);
});

check('blocked account + a NEW Battle.net account: the guild list is bounded (the rest is flagged for the repair) and a block lifted meanwhile gets nothing', async () => {
  const t = await load('worker/block-tombstones.js');
  const s = await world({ env: { TOMBSTONE_KEY: KEY } });
  await s.member('bl', 'Blockedone');
  assert.equal((await s.call('gm', 'POST', `/people/${s.uids.bl}/block`, {})).status, 200);
  // A block lifted between the read and the write: the guard on the insert finds no block row.
  const ctx = { db: s.w.db, env: s.w.env, now: () => s.w.clock.now, log: () => {} };
  const real = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => { s.exec(`DELETE FROM guild_blocks WHERE user_id = '${s.uids.bl}'`); return real(statements); };
  const used = await t.tombstoneNewBnetAccount(ctx, { userId: s.uids.bl, bnetAccountId: BNET.bl.id });
  s.w.db.batch = real;
  assert.equal(used, 2, 'one read and one statement');
  assert.equal((await tombstonesOf(s, `u:${s.uids.bl}`)).length, 1, 'only the one from the block itself (the insert found no block row)');
  assert.equal(await t.tombstoneNewBnetAccount(ctx, { userId: s.uids.bl, bnetAccountId: BNET.bl.id }), 1, 'an account that blocks nowhere costs one read');
  assert.equal(t.NEW_KEY_GUILD_LIMIT, 10);
});

// ---------------------------------------------------------------------------
// 6. A failed first sync during the setup pin

check('setup pin: a first sync that FAILED hands the lease back (Sync now and the cron retry at once); a good first sync keeps the lease; a lease claimed since is not undone', async () => {
  const sync = await load('worker/roster-sync.js');
  // A good pin: the lease stays one interval ahead, Sync now is refused for the hour.
  const good = await pinWorld();
  const okPin = await pin(good);
  assert.equal(okPin.status, 200, okPin.text);
  assert.equal(okPin.json.sync.status, 'applied');
  assert((await pinRow(good)).next_sync_at > good.w.clock.now + 5 * HOUR);
  const tooSoon = await good.call('gm', 'POST', '/roster-sync', {});
  assert.deepEqual([tooSoon.status, tooSoon.json.error], [429, 'sync_too_soon']);

  // A pin whose first sync fails (the roster batch throws): the pin stands, the answer says so, and the lease is handed back.
  const s = await pinWorld();
  const real = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /^INSERT INTO guild_roster/.test(statement.sql))) throw new Error('D1 hiccup');
    return real(statements);
  };
  const failed = await pin(s);
  s.w.db.batch = real;
  assert.equal(failed.status, 200, failed.text);
  assert.deepEqual([failed.json.pinned, failed.json.sync.status, failed.json.sync.reason], [true, 'failed', 'batch_failed']);
  const row = await pinRow(s);
  assert.equal(row.pinned_guild_slug, 'writers-b3', 'the pin stands');
  assert(row.next_sync_at <= s.w.clock.now, `due now (${row.next_sync_at} vs ${s.w.clock.now})`);
  // Sync now works at once, and the roster lands.
  const retry = await s.call('gm', 'POST', '/roster-sync', {});
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.status, 'applied');
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), 2);
  assert((await pinRow(s)).next_sync_at > s.w.clock.now + 5 * HOUR, 'and the new lease is a full interval');

  // The release undoes only the lease it wrote: a claim made since moved the column and stays.
  const t = await pinWorld();
  await pin(t);
  const leased = (await pinRow(t)).next_sync_at;
  assert.equal(await sync.releaseSyncLease(t.w.db, t.gid, { leasedUntil: leased + 1, nowMs: t.w.clock.now }), false);
  assert.equal((await pinRow(t)).next_sync_at, leased);
  assert.equal(await sync.releaseSyncLease(t.w.db, t.gid, { leasedUntil: leased, nowMs: t.w.clock.now }), true);
  assert.equal((await pinRow(t)).next_sync_at, t.w.clock.now);
  assert.equal(await sync.claimSyncLease(t.w.db, t.gid, t.w.clock.now), true, 'the cron claims it now');
});

// ---------------------------------------------------------------------------
// 7. A malformed Blizzard roster during a Guild Master claim

check('claim: a roster that is malformed in itself (cut off, duplicate names, no rank 0, two rank 0) is "provider": no failed claim is counted and the claimant\'s start budget comes back', async () => {
  const s = await claimWorld();
  tieToGuild(s, 'igm'); // a tie, so a COUNTED failure would be written into the guild's log
  const fillers = Array.from({ length: 1201 }, (_, i) => ({ name: `Filler${i}`, id: 30000 + i, rank: 5 }));
  const clean = [...s.live.roster];
  const variants = [
    ['truncated', fillers],
    ['duplicate_name', [{ name: 'Memberone', id: 9999, rank: 5 }]],
    ['no_rank_zero', null],
    ['several_rank_zero', [{ name: 'Secondgm', id: 9300, rank: 0 }]],
  ];
  const budget = async () => ({
    session: (await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:s:${s.sessionHash('igm')}`)),
    account: (await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:${s.uids.igm}`)),
  });
  for (const [reason, extra] of variants) {
    s.live.roster = extra === null ? clean.filter((member) => member.rank !== 0) : [...clean, ...extra];
    s.w.logs.length = 0;
    const out = await claim(s, 'igm');
    assert.equal(out.start.status, 200, reason);
    assert.equal(out.location, refused('provider'), reason);
    assert(s.w.logs.some((line) => line.includes(`the roster is not usable: ${reason}`)), `${reason}: ${s.w.logs.join(' | ')}`);
  }
  s.live.roster = clean;
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 0, 'no row in the guild\'s log');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'auditfail:%'"), 0, 'no failure counter');
  assert.deepEqual(await budget(), { session: { count: 0 }, account: { count: 0 } }, 'four starts, four refunds');
  assert.equal(await seatOf(s), s.uids.gm);
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'gm_claim'"), 0);
  // Retrying a broken answer never locks the real Guild Master out: twelve attempts (the budget is ten) and the claim still starts and works.
  s.live.roster = clean.filter((member) => member.rank !== 0);
  for (let i = 0; i < 12; i++) assert.equal((await claim(s, 'igm')).start.status, 200, `attempt ${i + 1}`);
  s.live.roster = clean;
  const real = await claim(s, 'igm');
  assert.equal(real.location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
});

check('claim: a roster of ANOTHER Blizzard guild or realm, a claimant who is not the Guild Master and a Blizzard failure keep their answers: not_gm counted and not refunded, provider uncounted', async () => {
  const s = await claimWorld();
  tieToGuild(s, 'igm');
  const sessionCount = async () => (await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:s:${s.sessionHash('igm')}`)).count;
  s.live.guildId = 3999;
  assert.equal((await claim(s, 'igm')).location, refused('not_gm'));
  s.live.guildId = 3000;
  s.live.realmId = 4999;
  assert.equal((await claim(s, 'igm')).location, refused('not_gm'));
  s.live.realmId = 4001;
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 1, 'one row per user, guild and hour');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key LIKE ?', `auditfail:guild.claim_failed:%`)).count, 2, 'both counted');
  assert.equal(await sessionCount(), 2, 'and their starts are not given back');
  s.live.profiles[ACCOUNT.igm.id] = [entry('Gmalt', ID.alt, { cls: 5 })];
  assert.equal((await claim(s, 'igm')).location, refused('not_gm'), 'a valid roster whose rank 0 is somebody else\'s character');
  assert.equal(await sessionCount(), 3);
  s.bnet.state.fail.roster = 500;
  assert.equal((await claim(s, 'igm')).location, refused('provider'), 'Blizzard down');
  s.bnet.state.fail.roster = 0;
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 1);
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key LIKE ?', `auditfail:guild.claim_failed:%`)).count, 3);
});

runChecks(checks);
