/**
 * Raidsmith guild tracker - lane B5 of the user-hierarchy build: the flip dry run, membership part (POST /api/guild/:gid/flip/dry-run; worker/flip-preview.js,
 * worker/routes/flip.js)
 * Run: node tests/guild/guild-b5-flip-tests.js
 *
 *   - Owner only (a Guild Master by role who does not hold the seat, an Officer: 403, no token written), rate limited like the rank-map dry run (10 per 10 minutes, 429),
 *     409 already_ingame once the guild is in-game;
 *   - it lists every account that would lose access (Discord-server-only members, members whose recorded person they must claim, linked persons with no roster character,
 *     all-Former persons), every account that would gain it (the Owner exemption, a person linked by the 0039 backfill whose account left the server), and the persons that
 *     only record an account's Discord ID (they need a claim: the flip links nobody; whether the Owner's own person is one of them), and the lists agree with what the 'ingame'
 *     rule really does once the flip has been made by hand;
 *   - counts plus at most 25 samples per list; no Discord ID and no BattleTag anywhere in the answer;
 *   - the token is a single-use 'flip:' approval bound to the Owner, the previewed lists and the roster sync id; it is no rank-map token, and a rank-map token is no flip token.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { NAMESPACE, REALM_ID, seatOnRoster } = require('../guild-seat');
const { flip, makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const FLIP = '/flip/dry-run';
const ONE_RANK = [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }];
const rosterRow = (s, key, rank = 4) => s.exec(
  `INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
   VALUES ('${s.gid}', '${NAMESPACE}', ${REALM_ID}, ${key}, 'Row${key}', 'row${key}', 'nightslayer', 'MAGE', 70, ${rank})`,
);
const keyCharacter = (s, characterId, key, leftOn = null) => s.exec(
  `UPDATE characters SET namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = ${key}, left_on = ${leftOn ? `'${leftOn}'` : 'NULL'} WHERE id = '${characterId}'`,
);
const discordIdOf = async (s, key) => (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids[key])).discord_id;
const carryDiscord = async (s, personId, key) => s.exec(`UPDATE players SET discord_user_id = '${await discordIdOf(s, key)}' WHERE id = '${personId}'`);

// A legacy guild (the Guild Master is the Owner through the stored row) with one account of every kind the flip treats differently.
async function world() {
  const s = await scenario();
  const names = {
    keep: 'Keepone', offroster: 'Offrosterone', former: 'Formerone', unkeyed: 'Unkeyedone', dcown: 'Dcownone', dcoff: 'Dcoffone', donly: 'Donlyone', conflict: 'Conflictone', blocked: 'Blockedone',
  };
  for (const [key, name] of Object.entries(names)) await s.member(key, name);
  await s.outsider('gainer', 'Gainerone');
  await s.outsider('leaver', 'Leaverone');
  // linked, on the roster: stays
  await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.tids[0], userId: s.uids.keep }, { name: 'Keepmain', id: 51000 });
  // linked, character keyed but off the roster: no_roster_character
  const off = await s.person({ name: 'Offmain' });
  keyCharacter(s, off.cid, 51001);
  await s.link(off.pid, 'offroster');
  // linked, keyed and on the roster, but Former: all_former
  const former = await s.person({ name: 'Formermain' });
  keyCharacter(s, former.cid, 51002, '2026-10-01');
  rosterRow(s, 51002);
  await s.link(former.pid, 'former');
  // linked, no identity key at all: no_roster_character (and an unkeyed character to report)
  const unkeyed = await s.person({ name: 'Unkeyedmain' });
  await s.link(unkeyed.pid, 'unkeyed');
  // persons that only record a Discord ID (nobody owns them; the flip links nobody): dcown (on the roster), dcoff (off the roster), the Guild Master (the Owner's own person), the
  // gainer (not in the server, so no member today and none after)
  const dcown = await s.person({ name: 'Dcownmain' });
  keyCharacter(s, dcown.cid, 51003);
  rosterRow(s, 51003);
  await carryDiscord(s, dcown.pid, 'dcown');
  const dcoff = await s.person({ name: 'Dcoffmain' });
  keyCharacter(s, dcoff.cid, 51004);
  await carryDiscord(s, dcoff.pid, 'dcoff');
  const gmPerson = await s.person({ name: 'Gmmain' });
  await carryDiscord(s, gmPerson.pid, 'gm');
  const gainer = await s.person({ name: 'Gainermain' });
  keyCharacter(s, gainer.cid, 51005);
  rosterRow(s, 51005);
  await carryDiscord(s, gainer.pid, 'gainer');
  // an account that has a linked person (on the roster) AND a second person carrying its Discord ID: the account has its person, the second needs no claim
  await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.tids[0], userId: s.uids.conflict }, { name: 'Conflictmain', id: 51006 });
  const twin = await s.person({ name: 'Twinmain' });
  await carryDiscord(s, twin.pid, 'conflict');
  // linked and on the roster, but blocked: in no list
  await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.tids[0], userId: s.uids.blocked }, { name: 'Blockedmain', id: 51007 });
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('${s.gid}', '${s.uids.blocked}', 1)`);
  // a person the 0039 backfill linked (user_id_backfilled = 1) whose account left the Discord server: not a member today (the flag), a member after the flip (on the roster)
  const leaver = await s.person({ name: 'Leavermain' });
  keyCharacter(s, leaver.cid, 51008);
  rosterRow(s, 51008);
  await s.link(leaver.pid, 'leaver');
  s.exec(`UPDATE players SET user_id_backfilled = 1 WHERE id = '${leaver.pid}'`);
  s.persons = { off, former, unkeyed, dcown, dcoff, gmPerson, gainer, twin, leaver };
  return s;
}

const dry = (s, who = 'gm') => s.call(who, 'POST', FLIP, {});
const bySample = (list) => Object.fromEntries(list.samples.map((entry) => [entry.name, entry]));

check('the dry run lists who loses access (discord_only, needs_claim, no_roster_character, all_former), who gains it, and the persons that only record a Discord ID, with counts and no Discord ID or BattleTag', async () => {
  const s = await world();
  const res = await dry(s);
  assert.equal(res.status, 200, res.text);
  const body = res.json;
  assert(typeof body.token === 'string' && body.token.length >= 40);
  assert.equal(body.expiresAt, s.w.clock.now + 10 * 60 * 1000);
  assert.equal(body.rankSource, null);
  assert.equal(body.rosterSyncId, '');
  const { loses, gains, members } = body.access;
  // The Owner (the Guild Master, whose person only a Discord ID owns) is a member today and will be SUSPENDED after the flip (no character of theirs is proven by Battle.net on the
  // roster): the Owner exemption ends with suspension (lane B6b part 3a), so they are in the list like anybody else.
  assert.deepEqual(loses.reasons, { discord_only: 1, needs_claim: 3, no_roster_character: 2, all_former: 1 });
  assert.equal(loses.count, 7);
  const lost = bySample(loses);
  assert.deepEqual(Object.keys(lost).sort(), ['Dcoffmain', 'Dcownmain', 'Donlyone', 'Formermain', 'Gmmain', 'Offmain', 'Unkeyedmain']);
  // A Discord ID on a person is not an owner: these members keep nothing through it, and the sample names the person they would claim.
  for (const [name, key] of [['Dcownmain', 'dcown'], ['Dcoffmain', 'dcoff'], ['Gmmain', 'gmPerson']]) {
    assert.equal(lost[name].reason, 'needs_claim', name);
    assert.equal(lost[name].personId, s.persons[key].pid, name);
    assert.equal(lost[name].userId, undefined, name);
  }
  assert.equal(lost.Donlyone.reason, 'discord_only');
  assert.equal(lost.Donlyone.personId, null);
  assert.equal(lost.Donlyone.userId, s.uids.donly, 'an account with no person is named by its account id');
  assert.equal(lost.Offmain.reason, 'no_roster_character');
  assert.equal(lost.Offmain.personId, s.persons.off.pid);
  assert.equal(lost.Offmain.userId, undefined, 'a person is named by the person');
  assert.equal(lost.Formermain.reason, 'all_former');
  assert.equal(lost.Unkeyedmain.reason, 'no_roster_character');
  assert.equal(lost.Unkeyedmain.unkeyedCharacters, 1, 'the character with no identity key is counted for the name binding');
  assert.equal(lost.Offmain.unkeyedCharacters, 0);
  // Only the account behind a person the backfill linked gains, and by the link, not by a Discord ID: the recorded person of an account outside the server gains nothing.
  assert.equal(gains.count, 1);
  assert.deepEqual(gains.reasons, { linked_person: 1 });
  assert.deepEqual(gains.samples.map((entry) => [entry.name, entry.reason, entry.personId]), [['Leavermain', 'linked_person', s.persons.leaver.pid]]);
  assert(!JSON.stringify(gains).includes('Gainermain'));
  assert.deepEqual(members, { today: 9, afterFlip: 3 }, 'keep, conflict and the backfilled leaver');
  assert.equal(body.discordOwned, undefined, 'the flip links nobody: the section that listed the persons it would link is gone');
  const claims = body.needsClaim;
  assert.deepEqual([claims.count, claims.onRoster, claims.ownerIncluded], [4, 2, true], 'dcown, dcoff, the Guild Master\'s person, the gainer; the twin\'s account has its own person');
  assert.deepEqual(claims.samples.map((entry) => [entry.name, entry.onRoster]).sort(), [['Dcoffmain', false], ['Dcownmain', true], ['Gainermain', true], ['Gmmain', false]]);
  // The blocked account is in no list; the account that keeps access is in none either.
  assert(!JSON.stringify(body).includes('Blockedone') && !JSON.stringify(body).includes('Keepmain') && !JSON.stringify(body).includes('Conflictmain'));
  // No Discord ID, no BattleTag, no Discord handle of anyone.
  const discordIds = (await s.rows('SELECT discord_id FROM users WHERE discord_id IS NOT NULL')).map((row) => row.discord_id);
  assert(discordIds.length >= 10);
  for (const id of discordIds) assert(!res.text.includes(id), `the answer carries a Discord ID (${id})`);
  assert(!/battletag/i.test(res.text));
  // The token row.
  const row = await s.one('SELECT approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at FROM dry_run_approvals');
  assert.deepEqual([row.approver_user_id, row.roster_sync_id, row.used_at], [s.uids.gm, '', null]);
  assert(/^flip:/.test(row.map_hash));
  assert.equal(row.expires_at - row.created_at, 10 * 60 * 1000);
  const { hashToken } = await load('worker/session.js');
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals WHERE token_hash = ?', await hashToken(body.token))).length, 1, 'only the hash of the token is kept');
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals WHERE token_hash = ?', body.token)).length, 0);
});

check('the lists are what the in-game rule really does: after the flip is made by hand (the source alone: nobody is linked) the accounts that lose and gain access are exactly the listed ones', async () => {
  const s = await world();
  const m = await load('worker/membership.js');
  const accounts = ['gm', 'keep', 'offroster', 'former', 'unkeyed', 'dcown', 'dcoff', 'donly', 'conflict', 'blocked', 'gainer', 'leaver'];
  const memberNow = async () => {
    const out = {};
    for (const key of accounts) {
      out[key] = (await s.w.db.prepare(`SELECT ${m.memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member FROM users u, guilds g WHERE u.id = ? AND g.id = ?`).bind(s.uids[key], s.gid).first()).member === 1;
    }
    return out;
  };
  const before = await memberNow();
  const body = (await dry(s)).json;
  // The flip, by hand: the source. It links nobody; a Discord ID recorded on a person is bookkeeping.
  s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  // The Owner (the Guild Master) is not live: no character of theirs is proven by Battle.net on the roster, so the exemption ended with the flip and they are listed like anybody else.
  const after = await memberNow();
  const lost = accounts.filter((key) => before[key] && !after[key]).sort();
  const gained = accounts.filter((key) => !before[key] && after[key]).sort();
  assert.deepEqual(lost, ['dcoff', 'dcown', 'donly', 'former', 'gm', 'offroster', 'unkeyed']);
  assert.deepEqual(gained, ['leaver']);
  assert.equal(body.access.loses.count, lost.length);
  assert.equal(body.access.gains.count, gained.length);
  assert.equal(body.access.members.today, accounts.filter((key) => before[key]).length);
  assert.equal(body.access.members.afterFlip, accounts.filter((key) => after[key]).length);
  assert.equal(before.blocked || after.blocked, false);
});

check('the Owner exemption ends with suspension: an Owner who is not a member today (not in the server, linked to no one) gains nothing and is SUSPENDED after the flip; one in the server loses access with them; a live Owner stays in', async () => {
  const { previewFlip } = await load('worker/flip-preview.js');
  const s = await scenario();
  await s.outsider('seat', 'Seatholder');
  await s.setOwner('seat');
  // Such an Owner can call the route too (lane B6b part 3a closes B5 open point (c): the Owner question comes before the membership one).
  const route = await dry(s, 'seat');
  assert.equal(route.status, 200, route.text);
  const { payload } = await previewFlip(s.w.db, s.gid);
  assert.deepEqual(payload.access.gains.reasons, {}, 'a suspended Owner is no member after the flip: the exemption ends with suspension');
  assert.deepEqual(payload.access.gains.samples, []);
  // The Guild Master by role is a derived GM now: a member today (in the server), not after the flip (no roster character).
  assert.deepEqual(payload.access.loses.reasons, { discord_only: 1 });
  assert.equal(payload.access.loses.samples[0].userId, s.uids.gm);
  assert.deepEqual(payload.access.members, { today: 1, afterFlip: 0 });
  assert.deepEqual([payload.owner.live, payload.owner.willBeSuspended, payload.owner.reason], [false, true, 'no_roster']);
  // An Owner who is in the server is a member today and, with no character proved by Battle.net, suspended after: they lose access with the Guild Master by role.
  await s.member('own', 'Ownerinserver');
  await s.setOwner('own');
  const res = await dry(s, 'own');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.access.gains.count, 0);
  assert.deepEqual(res.json.access.loses.reasons, { discord_only: 2 });
  // A LIVE Owner (linked to a person whose character is proven by Battle.net on the roster) is a member today and stays one: in neither list.
  const live = await scenario();
  const mine = await live.person({ name: 'Liveowner' });
  await live.link(mine.pid, 'gm');
  makeProven(live, 'gm', mine, { rank: 4 });
  const ok = await dry(live);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.access.members, { today: 1, afterFlip: 1 });
  assert.equal(ok.json.access.loses.count + ok.json.access.gains.count, 0);
  assert.deepEqual([ok.json.owner.live, ok.json.owner.reason], [true, 'live']);
});

check('at most 25 samples per list, the counts stay whole', async () => {
  const s = await scenario();
  for (let i = 0; i < 31; i++) {
    const id = `u_bulk${String(i).padStart(2, '0')}`;
    s.exec(`INSERT INTO users (id, account_key, discord_id, username, global_name, created_at, last_seen_at) VALUES ('${id}', '${id}', '7${String(i).padStart(17, '0')}', 'bulk${i}', 'Bulk ${i}', 1, 1)`);
    s.exec(`INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('${id}', '${s.serverId}', 1)`);
  }
  const { json } = await dry(s);
  assert.equal(json.access.loses.count, 32, 'every server member, the Owner included (suspended after the flip: no character proved by Battle.net)');
  assert.equal(json.access.loses.samples.length, 25);
  assert.equal(json.needsClaim.samples.length, 0);
  assert(json.access.loses.samples.every((entry) => entry.reason === 'discord_only' && /^u_/.test(entry.userId) && /^Bulk \d+$/.test(entry.name)));
});

check('Owner only: a Guild Master by role who does not hold the seat and an Officer are refused (403, no token written); the Owner is allowed', async () => {
  const s = await scenario();
  await s.officer('off', 'Officerone');
  await s.member('own', 'Ownerseat');
  await s.setOwner('own');
  for (const who of ['gm', 'off']) {
    const refused = await dry(s, who);
    assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], who);
    assert(/Owner/.test(refused.json.message), refused.json.message);
  }
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0);
  assert.equal((await s.rows("SELECT key FROM rate_limits WHERE key LIKE 'flip:%'")).length, 0, 'a refusal does not use the Owner\'s allowance');
  assert.equal((await dry(s, 'own')).status, 200);
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 1);
  // The signed-out and a non-member of the guild get the usual refusals.
  const signedOut = await s.w.call({}, 'POST', `${s.base}${FLIP}`, {});
  assert.equal(signedOut.status, 401);
  await s.outsider('stranger', 'Stranger');
  assert.deepEqual([(await dry(s, 'stranger')).status, (await dry(s, 'stranger')).json.error], [403, 'not_member']);
});

check('rate limited like the rank-map dry run: ten in ten minutes, then 429; the allowance comes back after the window', async () => {
  const s = await scenario();
  for (let i = 0; i < 10; i++) assert.equal((await dry(s)).status, 200, `run ${i + 1}`);
  const over = await dry(s);
  assert.deepEqual([over.status, over.json.error], [429, 'rate_limited']);
  assert(/flip dry runs/.test(over.json.message), over.json.message);
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 10, 'a limited call writes no token');
  s.w.advance(11 * 60 * 1000);
  assert.equal((await dry(s)).status, 200);
  const { FLIP_DRY_RUN_LIMIT, FLIP_DRY_RUN_WINDOW_MS, RANK_MAP_LIMIT, RANK_MAP_WINDOW_MS } = await load('worker/ratelimit.js');
  assert.deepEqual([FLIP_DRY_RUN_LIMIT, FLIP_DRY_RUN_WINDOW_MS], [RANK_MAP_LIMIT, RANK_MAP_WINDOW_MS]);
});

check('a guild that is already in-game answers 409 already_ingame, before the rate limit and without a token; a manual guild previews against its own rule', async () => {
  const s = await scenario();
  // An in-game guild: the Owner is live (a Battle.net-proven character on the roster) and the stored Guild Master row is gone, as after the flip.
  const owned = await s.person({ name: 'Gmowner' });
  await s.link(owned.pid, 'gm');
  makeProven(s, 'gm', owned, { rank: 4 });
  flip(s, { owner: 'gm' });
  for (let i = 0; i < 12; i++) {
    const res = await dry(s);
    assert.deepEqual([res.status, res.json.error], [409, 'already_ingame'], `call ${i + 1}`);
  }
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0);
  assert.equal((await s.rows("SELECT key FROM rate_limits WHERE key LIKE 'flip:%'")).length, 0);
  // 'manual': today's rule is "linked"; the Discord-server-only members do not count as members today, so they are in no list.
  const m = await scenario();
  await m.member('donly', 'Donlyone');
  const person = await m.person({ name: 'Linkedmain' });
  await m.link(person.pid, 'donly');
  const gmPerson = await m.person({ name: 'Gmmain' });
  await m.link(gmPerson.pid, 'gm');
  makeProven(m, 'gm', gmPerson, { rank: 4 }); // a LIVE Owner: the exemption holds
  await m.member('plain', 'Plainone');
  m.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${m.gid}'`);
  await m.setOwner('gm'); // the seat: a stored Guild Master row alone no longer counts once the rank source is chosen
  const res = await dry(m);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.rankSource, 'manual');
  assert.deepEqual(res.json.access.members, { today: 2, afterFlip: 1 }, 'linked donly and gm today; after: only the Owner (donly\'s character is on no roster)');
  assert.deepEqual(res.json.access.loses.reasons, { no_roster_character: 1 });
  assert(!JSON.stringify(res.json).includes('Plainone'), 'a Discord-only account is no member of a manual guild, so it loses nothing');
});

check("the token is a 'flip:' approval bound to the Owner, the previewed lists and the roster sync id; it is no rank-map token, and a rank-map token is no flip token", async () => {
  const s = await world();
  s.exec(`UPDATE guilds SET last_good_sync_id = 'rs_known' WHERE id = '${s.gid}'`);
  const { approvalProblem, loadApproval } = await load('worker/dry-run.js');
  const { hashToken } = await load('worker/session.js');
  const { previewFlip } = await load('worker/flip-preview.js');
  const flip = (await dry(s)).json;
  assert.equal(flip.rosterSyncId, 'rs_known');
  const row = await loadApproval(s.w.db, await hashToken(flip.token));
  assert.deepEqual([row.guild_id, row.approver_user_id, row.roster_sync_id, row.used_at], [s.gid, s.uids.gm, 'rs_known', null]);
  assert(/^flip:[0-9a-f]+$/.test(row.map_hash), row.map_hash);
  // B9's check: recompute the state with the same function; the token fits it exactly while nothing moved.
  const state = async () => previewFlip(s.w.db, s.gid);
  const fits = async (over = {}) => approvalProblem(row, { guildId: s.gid, approverUserId: s.uids.gm, stateHash: (await state()).stateHash, rosterSyncId: 'rs_known', now: s.w.clock.now, ...over });
  assert.equal(await fits(), null);
  assert.equal(await fits({ approverUserId: s.uids.keep }), 'invalid', 'another account\'s token');
  assert.equal(await fits({ rosterSyncId: 'rs_newer' }), 'stale', 'a newer roster');
  assert.equal(await fits({ now: row.expires_at }), 'invalid', 'expired');
  assert.equal(await state().then((x) => x.stateHash), (await state()).stateHash, 'the same state hashes the same');
  // The lists are covered: one more account that would lose access makes the token stale.
  await s.member('late', 'Lateone');
  assert.equal(await fits(), 'stale', 'a new Discord-only member');
  s.exec(`DELETE FROM user_servers WHERE user_id = '${s.uids.late}'`);
  assert.equal(await fits(), null, 'and back');
  s.exec(`UPDATE guild_roster SET blizzard_char_id = blizzard_char_id + 100000 WHERE blizzard_char_id = 51003`);
  assert.equal(await fits(), 'stale', 'a roster that no longer holds a person that needs a claim');
  s.exec(`UPDATE guild_roster SET blizzard_char_id = 51003 WHERE blizzard_char_id = 151003`);
  assert.equal(await fits(), null);
  // A flip token is no rank-map token: the PUT refuses it as stale and does not burn it.
  const refused = await s.call('gm', 'PUT', '/rank-map', { ranks: ONE_RANK, token: flip.token });
  assert.deepEqual([refused.status, refused.json.error], [409, 'approval_stale']);
  assert.equal((await loadApproval(s.w.db, await hashToken(flip.token))).used_at, null, 'not consumed');
  assert.equal((await s.rows('SELECT source_key FROM source_rank_maps')).length, 0);
  // A rank-map token is no flip token: its state hash starts 'rankmap:' and so never equals a flip hash.
  const rankmap = (await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: ONE_RANK }, 200)).token;
  const rankRow = await loadApproval(s.w.db, await hashToken(rankmap));
  assert(/^rankmap:/.test(rankRow.map_hash));
  assert.equal(approvalProblem(rankRow, { guildId: s.gid, approverUserId: s.uids.gm, stateHash: (await state()).stateHash, rosterSyncId: rankRow.roster_sync_id, now: s.w.clock.now }), 'stale');
  // And the rank-map token still does its own job.
  await s.ok('gm', 'PUT', '/rank-map', { ranks: ONE_RANK, token: rankmap }, 200);
});

runChecks(checks);
