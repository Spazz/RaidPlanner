/**
 * Raidsmith guild tracker - lane B7b part 2 of the user-hierarchy build: Manage users (POST /api/guild/:gid/users/block, /users/unblock, /users/add-to-person)
 * Run: node tests/guild/guild-b7b-manage-tests.js
 *
 *   gate ............ guild.access (Officers and up); Add to a person also roster.edit for the whole guild; the body is shaped before anything is read; its own per-user write limit
 *   block ........... every name gets the single route's guards (self, Guild Master, Owner, rank, already blocked, an account-less person's in-game rank), a Former member and a
 *                     non-member are blockable, the effects (tombstones, off the teams, upcoming and standing sign-ups, pending requests, audit) equal the single routes' - the
 *                     same database after the bulk call as after one single call per name
 *   unblock ......... the single DELETE routes' guards and effects (own tombstones, the earlier blocks' refs only as far as the actor's rank lets them, the ignored Owner row)
 *   races ........... a guard that fails between the read and the write skips that name and writes nothing for it (no effects, no audit row)
 *   budget .......... the statements per request do not grow with the names (45 per request on the free plan), no scan of the big evidence tables
 *   add to a person . names seen in a log, loot, a sign-up or an application become alts of a person: refused in an in-game guild, bookkeeping elsewhere, never players.user_id
 */
const assert = require('node:assert/strict');
const { discord, load, runChecks, scenario: baseScenario } = require('../guild-b3-world');
const { memberOf, newJar, signIn } = require('../guild-world');
const { flip, ingameize, makeProven } = require('../guild-ingame');
const { scansSince, statementsSince } = require('../guild-plans');
const { exec, rowsOf, addRaid, addLoot, addPresence, addSignup, addApplication, addManual, leave } = require('../guild-evidence');
const { bigWorld: baseBigWorld } = require('../guild-users-fixture');
const { sentinelWorld, sentinelsOf } = require('../guild-sentinels');

const KEY = 'test-tombstone-key-0123456789abcdef';
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The write limit of the Manage users routes is 10 a minute and the fixtures below call far more than that within a few simulated seconds: a request of the helpers (s.call, s.ok)
// to those routes starts with an empty window. The limit itself is checked through s.w.call, which this leaves alone.
function unlimited(s) {
  const call = s.call.bind(s);
  s.call = (who, method, tail, body) => {
    if (/\/users\/(block|unblock|add-to-person)$/.test(tail)) s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'usersw:%'");
    return call(who, method, tail, body);
  };
  return s;
}
const scenario = async (options) => unlimited(await baseScenario(options));

const BLOCK = '/users/block';
const UNBLOCK = '/users/unblock';
const ADD = '/users/add-to-person';
const keyOfName = (name) => `n_${Buffer.from(name.toLowerCase(), 'utf8').toString('hex')}`;
const reasons = (res) => Object.fromEntries(res.skipped.map((entry) => [entry.key, entry.reason]));
const doneKeys = (res) => res.done.map((entry) => entry.key);

// A guild of the legacy rank source: the Guild Master (Owner), two Officers, a Team Lead and six members, each member with a person (Mone ... Msix) on Alpha linked to the account.
// An upcoming raid and a past one.
async function world({ env = { TOMBSTONE_KEY: KEY }, members = 6 } = {}) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  await s.officer('off2', 'Officertwo');
  await s.lead('tl', [s.alpha], 'Teamlead');
  s.people = {};
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  for (let i = 0; i < members; i++) {
    const key = `m${i + 1}`;
    await s.member(key, `Member${names[i].toLowerCase()}`);
    s.people[key] = await s.person({ name: `M${names[i].toLowerCase()}` });
    await s.link(s.people[key].pid, key);
  }
  s.past = addRaid(s, '2026-12-01');
  s.next = addRaid(s, '2027-03-01');
  return s;
}

const list = (s, who, query = '') => s.ok(who, 'GET', `/users${query ? `?${query}` : ''}`);
const segmentOf = async (s, who, name) => {
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) {
    const res = await list(s, who, `segment=${segment}&limit=100`);
    if (res.rows.some((entry) => entry.name === name)) return segment;
  }
  return null;
};
const blockRow = (s, key) => rowsOf(s, 'SELECT blocked_by, reason, pending_review, tombstone_missing FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, s.uids[key])[0];
const auditOf = (s, action) => rowsOf(s, 'SELECT entity_id, actor_user_id, actor_role, actor_short_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY entity_id', s.gid, action);

// What a block does to the rest of the database, for a guild whose members m1.. have these: a pending request and a standing sign-up, an upcoming native sign-up and a Raid-Helper one,
// a past native one.
let seq = 0;
function giveWork(s, key) {
  const made = s.people[key];
  addSignup(s, s.next, { source: 'raidsmith', playerId: made.pid });
  addSignup(s, s.next, { source: 'raid_helper', playerId: made.pid });
  addSignup(s, s.past, { source: 'raidsmith', playerId: made.pid });
  exec(s, "INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 'signed', 1, 1)",
    `sg_Fix${String(++seq).padStart(18, '0')}`, s.gid, s.alpha, made.pid);
  exec(s, "INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at) VALUES (?, ?, ?, ?, ?, 1)",
    `tq_Fix${String(++seq).padStart(18, '0')}`, s.gid, s.bravo, made.cid, s.uids[key]);
}

// The database after a block, in the terms a comparison between two guilds built the same way can use (ids are the same in both: the id source is a counter that only the audit rows
// of the single routes advance, and the dump leaves them out; times are left out).
function dump(s, before = {}) {
  const raids = rowsOf(s, 'SELECT id, title, version, policy_fp FROM raids ORDER BY title').map((raid) => ({ title: raid.title, policy_fp: raid.policy_fp, bumped: before.raids ? raid.version > before.raids[raid.id] : null }));
  return {
    blocks: rowsOf(s, 'SELECT user_id, blocked_by, reason, pending_review, tombstone_missing FROM guild_blocks ORDER BY user_id'),
    personBlocks: rowsOf(s, 'SELECT player_id, blocked_by, reason, tombstone_missing FROM person_blocks ORDER BY player_id'),
    tombstones: rowsOf(s, 'SELECT block_ref, key_version, hmac FROM block_tombstones ORDER BY block_ref, hmac'),
    teams: rowsOf(s, 'SELECT id, team_id FROM characters ORDER BY id'),
    signups: rowsOf(s, 'SELECT r.title AS raid, g.source, g.player_id, g.guest, g.guest_user_id FROM raid_signups g JOIN raids r ON r.id = g.raid_id ORDER BY r.title, g.source, g.player_id, g.guest_user_id'),
    standing: rowsOf(s, 'SELECT player_id FROM standing_signups ORDER BY player_id'),
    requests: rowsOf(s, 'SELECT requested_by, character_id, status FROM team_requests ORDER BY requested_by'),
    raids,
    audit: rowsOf(s, "SELECT action, entity_type, entity_id, actor_user_id, actor_short_id, actor_role, before, after FROM audit_log WHERE action IN ('access.remove', 'access.restore', 'person.block', 'person.unblock') ORDER BY action, entity_id"),
  };
}
const sameDump = (actual, expected, label) => { for (const part of Object.keys(expected)) assert.deepEqual(actual[part], expected[part], `${label}: ${part}`); };
const versionsOf = (s) => ({ raids: Object.fromEntries(rowsOf(s, 'SELECT id, version FROM raids').map((raid) => [raid.id, raid.version])) });

// ---------------------------------------------------------------------------
// The gate and the request

check('gate: an Officer and the Guild Master manage users; a Team Lead, a plain member, a custom role that edits the roster and the signed out are refused; Add to a person also needs roster.edit for the guild', async () => {
  const s = await world({ members: 2 });
  const body = { keys: [s.uids.m1] };
  for (const who of ['off', 'gm']) {
    const res = await s.call(who, 'POST', BLOCK, { keys: [`u_${'Z'.repeat(22)}`] });
    assert.equal(res.status, 200, `${who}: ${res.text}`);
    assert.equal((await s.call(who, 'POST', UNBLOCK, { keys: [`u_${'Z'.repeat(22)}`] })).status, 200, who);
  }
  const role = await s.ok('gm', 'POST', '/roles', { name: 'Roster keeper', permissions: { 'roster.view': 'guild', 'roster.edit': 'guild' } });
  const roleId = role.roles.find((entry) => entry.name === 'Roster keeper').id;
  await s.ok('gm', 'PUT', `/people/${s.uids.m2}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId, teamId: null }] }, 200);
  for (const who of ['tl', 'm1', 'm2']) {
    for (const [tail, payload] of [[BLOCK, body], [UNBLOCK, body], [ADD, { person: s.uids.m1, names: [{ key: keyOfName('Nobody') }] }]]) {
      const res = await s.call(who, 'POST', tail, payload);
      assert.equal(res.status, 403, `${who} ${tail}`);
      assert.equal(res.json.error, 'forbidden');
    }
  }
  for (const tail of [BLOCK, UNBLOCK, ADD]) assert.equal((await s.w.call(newJar(), 'POST', `${s.base}${tail}`, body)).status, 401, tail);
  assert.equal((await s.call('out', 'POST', BLOCK, body)).status, 401, 'an unknown caller has no session at all');
  // roster.edit for the whole guild: an Officer whose role lost it cannot add a name to a person, but still blocks.
  exec(s, 'INSERT OR IGNORE INTO role_overrides (guild_id, role_id) VALUES (?, ?)', s.gid, 'officer');
  for (const entry of rowsOf(s, 'SELECT action, scope FROM role_permissions WHERE role_id = ?', 'officer')) {
    if (entry.action !== 'roster.edit') exec(s, 'INSERT INTO role_override_permissions (guild_id, role_id, action, scope) VALUES (?, ?, ?, ?)', s.gid, 'officer', entry.action, entry.scope);
  }
  const noEdit = await s.call('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Nobody') }] });
  assert.equal(noEdit.status, 403);
  assert.equal((await s.call('off', 'POST', BLOCK, { keys: [`u_${'Z'.repeat(22)}`] })).status, 200);
});

check('request: keys must be a list of 1 to 100 strings, the reason text of at most 200 characters; every bad body is a 400 naming the field, and nothing is written', async () => {
  const s = await world({ members: 1 });
  const before = JSON.stringify(dump(s));
  const bad = async (tail, body, field) => {
    const res = await s.call('off', 'POST', tail, body);
    assert.equal(res.status, 400, `${tail} ${JSON.stringify(body).slice(0, 60)}: ${res.text}`);
    assert.deepEqual([res.json.error, res.json.field], ['bad_request', field]);
  };
  for (const tail of [BLOCK, UNBLOCK]) {
    await bad(tail, {}, 'keys');
    await bad(tail, { keys: [] }, 'keys');
    await bad(tail, { keys: 'u_x' }, 'keys');
    await bad(tail, { keys: [1] }, 'keys');
    await bad(tail, { keys: [''] }, 'keys');
    await bad(tail, { keys: Array.from({ length: 101 }, (_, i) => `u_${String(i).padStart(22, 'A')}`) }, 'keys');
  }
  await bad(BLOCK, { keys: [s.uids.m1], reason: 'x'.repeat(201) }, 'reason');
  await bad(BLOCK, { keys: [s.uids.m1], reason: 5 }, 'reason');
  await bad(BLOCK, { keys: [s.uids.m1], reason: 'two\nlines' }, 'reason');
  await bad(ADD, { names: [{ key: keyOfName('A') }] }, 'person');
  await bad(ADD, { person: keyOfName('Somebody'), names: [{ key: keyOfName('A') }] }, 'person');
  await bad(ADD, { person: s.uids.m1 }, 'names');
  await bad(ADD, { person: s.uids.m1, names: [{ key: keyOfName('A'), class: 'WIZARD' }] }, 'class');
  await bad(ADD, { person: s.uids.m1, names: [{}] }, 'names');
  assert.equal(JSON.stringify(dump(s)), before);
  // A duplicate key counts once; a reason of 200 characters and a blank one are fine.
  const res = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.m1, s.uids.m1], reason: 'y'.repeat(200) }, 200);
  assert.deepEqual([res.done.length, res.skipped.length], [1, 0]);
  assert.equal(blockRow(s, 'm1').reason.length, 200);
});

check('rate limit: Manage users has its own per-user write limit (10 a minute), 429 rate_limited with Retry-After, checked after the gate and the body and not shared with the list', async () => {
  const s = await world({ members: 1 });
  const { USERS_WRITE_LIMIT, USERS_WRITE_WINDOW_MS, USERS_LIMIT } = await load('worker/ratelimit.js');
  assert.deepEqual([USERS_WRITE_LIMIT, USERS_WRITE_WINDOW_MS], [10, 60_000]);
  s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'usersw:%'");
  const send = async (who = 'off') => { s.w.advance(1000); return s.w.call(s.jars[who], 'POST', `${s.base}${UNBLOCK}`, { keys: [`u_${'Z'.repeat(22)}`] }); };
  for (let i = 0; i < USERS_WRITE_LIMIT; i++) assert.equal((await send()).status, 200, `request ${i + 1}`);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert(Number(limited.headers.get('Retry-After')) > 0);
  // A refused caller writes no counter; the officer next to them is not limited; the list has its own key.
  assert.equal((await s.w.call(s.jars.tl, 'POST', `${s.base}${UNBLOCK}`, { keys: ['u_x'] })).status, 403);
  assert.equal((await send('off2')).status, 200);
  assert.equal((await s.w.call(s.jars.off, 'GET', `${s.base}/users`)).status, 200);
  assert.equal((await s.w.call(s.jars.off, 'POST', `${s.base}${BLOCK}`, { keys: [] })).status, 400, 'a bad body is refused before the limit is read');
  s.w.advance(60_000);
  assert.equal((await send()).status, 200, 'the next window');
  assert(USERS_LIMIT >= 30);
  // Delete my data clears the key with the others.
  assert.equal(rowsOf(s, "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?", `usersw:${s.uids.off}`)[0].n, 1);
});

// ---------------------------------------------------------------------------
// Block

check('block: an Officer blocks members, a Former member, a non-member and an account-less person in one call - the blocks, the tombstones, off the teams, upcoming sign-ups, standing sign-ups, pending requests, the audit', async () => {
  const s = await world();
  // m1, m2: members with work. m3: Former (all characters left). Outsider: a non-member that touched the guild. Wanted: an account-less person.
  giveWork(s, 'm1');
  giveWork(s, 'm2');
  giveWork(s, 'm4');
  leave(s, s.people.m3.cid);
  await s.outsider('out1', 'Outsiderone');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
  const wanted = await s.person({ name: 'Wanted' });
  exec(s, "UPDATE players SET discord_user_id = '555000000000000009' WHERE id = ?", wanted.pid);
  addSignup(s, s.next, { source: 'raidsmith', playerId: wanted.pid });
  // m2 proved a character through Battle.net: its identity key is tombstoned too.
  exec(s, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, '777000222', 'Membertwo#1', 1, '{}', 1)", s.uids.m2);
  assert.equal(await segmentOf(s, 'off', 'Memberthree'), 'former');
  assert.equal(await segmentOf(s, 'off', 'Outsiderone'), 'nonmembers');
  const keys = [s.uids.m1, s.uids.m2, s.uids.m3, s.uids.out1, wanted.pid];
  const versions = versionsOf(s);
  const res = await s.ok('off', 'POST', BLOCK, { keys, reason: 'Rude in chat' }, 200);
  assert.deepEqual(Object.keys(res).sort(), ['action', 'cap', 'done', 'skipped']);
  assert.equal(res.action, 'block');
  assert.equal(res.cap, 25);
  assert.deepEqual(res.done, [
    { key: s.uids.m1, kind: 'account', name: 'Memberone' }, { key: s.uids.m2, kind: 'account', name: 'Membertwo' }, { key: s.uids.m3, kind: 'account', name: 'Memberthree' },
    { key: s.uids.out1, kind: 'account', name: 'Outsiderone' }, { key: wanted.pid, kind: 'person', name: 'Wanted' },
  ]);
  assert.deepEqual(res.skipped, []);
  // The blocks: the actor, the reason, no review flag, no tombstone flag.
  for (const key of ['m1', 'm2', 'm3', 'out1']) assert.deepEqual(blockRow(s, key), { blocked_by: s.uids.off, reason: 'Rude in chat', pending_review: 0, tombstone_missing: 0 }, key);
  assert.deepEqual(rowsOf(s, 'SELECT blocked_by, reason, tombstone_missing FROM person_blocks WHERE player_id = ?', wanted.pid), [{ blocked_by: s.uids.off, reason: 'Rude in chat', tombstone_missing: 0 }]);
  assert.equal(blockRow(s, 'm4'), undefined, 'a name that was not asked for is untouched');
  // The tombstones: the Discord id of each account (and the person), the Battle.net account id of m2, under the block's own ref.
  const { tombstoneHmac } = await load('worker/block-tombstones.js');
  const hmac = (value) => tombstoneHmac(KEY, s.gid, value);
  const discordIds = rowsOf(s, 'SELECT id, discord_id FROM users');
  const discordOf = (key) => discordIds.find((entry) => entry.id === s.uids[key]).discord_id;
  const refs = (ref) => rowsOf(s, 'SELECT hmac FROM block_tombstones WHERE guild_id = ? AND block_ref = ? ORDER BY hmac', s.gid, ref).map((entry) => entry.hmac);
  const sorted = (list) => [...list].sort();
  assert.deepEqual(refs(`u:${s.uids.m1}`), [await hmac(`discord:${discordOf('m1')}`)]);
  assert.deepEqual(refs(`u:${s.uids.m2}`), sorted([await hmac(`discord:${discordOf('m2')}`), await hmac('bnet:777000222')]));
  assert.deepEqual(refs(`u:${s.uids.m3}`), [await hmac(`discord:${discordOf('m3')}`)]);
  assert.deepEqual(refs(`u:${s.uids.out1}`), [await hmac(`discord:${discordOf('out1')}`)]);
  assert.deepEqual(refs(`p:${wanted.pid}`), [await hmac('discord:555000000000000009')]);
  // Off every team, upcoming native sign-ups gone (Raid-Helper rows and past raids stay), standing sign-ups and pending requests gone, only for the blocked.
  for (const key of ['m1', 'm2']) {
    assert.equal(await s.teamOf(s.people[key].cid), null, `${key} left the team`);
    assert.deepEqual(rowsOf(s, 'SELECT raid_id, source FROM raid_signups WHERE player_id = ? ORDER BY raid_id, source', s.people[key].pid), [{ raid_id: s.past, source: 'raidsmith' }, { raid_id: s.next, source: 'raid_helper' }], key);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM standing_signups WHERE player_id = ?', s.people[key].pid)[0].n, 0, key);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM team_requests WHERE requested_by = ?', s.uids[key])[0].n, 0, key);
  }
  assert.equal(await s.teamOf(s.people.m3.cid), null, 'a Former member is released from the team column too, like the single route does');
  assert.equal(await s.teamOf(wanted.cid), null);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', wanted.pid)[0].n, 0);
  assert.equal(await s.teamOf(s.people.m4.cid), s.alpha, 'm4 was not asked for');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', s.people.m4.pid)[0].n, 3);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM standing_signups WHERE player_id = ?', s.people.m4.pid)[0].n, 1);
  // The raid that read what went is re-versioned; the one nobody changed is not.
  const next = rowsOf(s, 'SELECT version, policy_fp FROM raids WHERE id = ?', s.next)[0];
  assert(next.version > versions.raids[s.next] && next.policy_fp === '', 'the upcoming raid is out of date');
  // The audit: one row per name, the actor's role snapshot, the reason text nowhere.
  const removed = auditOf(s, 'access.remove');
  assert.deepEqual(removed.map((row) => row.entity_id).sort(), [s.uids.m1, s.uids.m2, s.uids.m3, s.uids.out1].sort());
  for (const row of removed) {
    assert.deepEqual([row.actor_user_id, row.actor_role, row.actor_short_id, row.before, row.after], [s.uids.off, 'officer', s.uids.off.slice(2, 10), '{"blocked":false}', '{"blocked":true,"reasonSet":true}']);
  }
  assert.deepEqual(auditOf(s, 'person.block').map((row) => [row.entity_id, row.actor_role, row.after]), [[wanted.pid, 'officer', '{"blocked":true,"reasonSet":true}']]);
  assert(!JSON.stringify(rowsOf(s, 'SELECT * FROM audit_log')).includes('Rude in chat'), 'the reason text stays out of the audit log');
  // The Users list sees them as blocked, the people list does too, and the audit page words each row.
  const blocked = await list(s, 'off', 'segment=blocked&limit=100');
  assert.deepEqual(blocked.rows.map((entry) => entry.name).sort(), ['Memberone', 'Memberthree', 'Membertwo', 'Outsiderone', 'Wanted']);
  assert.equal(blocked.counts.blocked, 5);
  const audit = await s.ok('gm', 'GET', '/audit');
  assert(audit.rows.some((row) => row.action === 'access.remove' && /Memberone/.test(row.text)));
});

check('block: the same database as one single call per name - the People route for an account, the roster route for an account-less person (blocks, tombstones, teams, sign-ups, requests, audit)', async () => {
  const build = async () => {
    const s = await world();
    giveWork(s, 'm1');
    giveWork(s, 'm2');
    giveWork(s, 'm5');
    s.wanted = await s.person({ name: 'Wanted' });
    exec(s, "UPDATE players SET discord_user_id = '555000000000000009' WHERE id = ?", s.wanted.pid);
    addSignup(s, s.next, { source: 'raidsmith', playerId: s.wanted.pid });
    addSignup(s, s.next, { source: 'raidsmith', guest: 1, guestUserId: s.uids.m5, nickname: 'Guestm5' });
    exec(s, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, '777000555', 'Memberfive#1', 1, '{}', 1)", s.uids.m5);
    exec(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = '777000555', namespace = 'classic-us', blizzard_realm_id = 4701, blizzard_char_id = 8801 WHERE id = ?", s.uids.m5, s.people.m5.cid);
    return s;
  };
  const single = await build();
  const bulk = await build();
  const baselines = { single: versionsOf(single), bulk: versionsOf(bulk) };
  sameDump(dump(single), dump(bulk), 'the same fixture');
  for (const key of ['m1', 'm2', 'm5']) await single.ok('off', 'POST', `/people/${single.uids[key]}/block`, { reason: 'Rude' }, 200);
  await single.ok('off', 'POST', `/roster/${single.wanted.pid}/block`, { reason: 'Rude' }, 200);
  const res = await bulk.ok('off', 'POST', BLOCK, { keys: [bulk.uids.m1, bulk.uids.m2, bulk.uids.m5, bulk.wanted.pid], reason: 'Rude' }, 200);
  assert.equal(res.done.length, 4);
  sameDump(dump(bulk, baselines.bulk), dump(single, baselines.single), 'after');
  assert(dump(bulk, baselines.bulk).raids.some((raid) => raid.bumped), 'the comparison saw a raid that was re-versioned');
  // The proven character's identity key is among the tombstones of m5 in both.
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE block_ref = ?', `u:${bulk.uids.m5}`)[0].n, 3);
  assert.equal(rowsOf(bulk, "SELECT COUNT(*) AS n FROM raid_signups WHERE guest = 1").n, undefined);
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM raid_signups WHERE guest = 1')[0].n, 0, 'the account\'s open-raid guest sign-up goes too');
});

check('block: each name gets the single route\'s guards - yourself, the Guild Master (the Owner), an equal rank, already blocked, unknown, a name, a person with an account - and the others are blocked', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
  const wanted = await s.person({ name: 'Wanted' });
  await s.ok('off', 'POST', `/people/${s.uids.m2}/block`, { reason: 'First' }, 200);
  const foreign = `u_${'Q'.repeat(22)}`;
  const keys = [s.uids.off, s.uids.gm, s.uids.off2, s.uids.tl, s.uids.m1, s.uids.m2, foreign, keyOfName('Somebody'), 'garbage', s.people.m3.pid, wanted.pid, s.uids.out1];
  const res = await s.ok('off', 'POST', BLOCK, { keys }, 200);
  assert.deepEqual(reasons(res), {
    [s.uids.off]: 'self', [s.uids.gm]: 'owner', [s.uids.off2]: 'outranks', [s.uids.m2]: 'already_blocked', [foreign]: 'not_found',
    [keyOfName('Somebody')]: 'name_only', garbage: 'not_found', [s.people.m3.pid]: 'has_account',
  });
  assert.deepEqual(doneKeys(res), [s.uids.tl, s.uids.m1, wanted.pid, s.uids.out1], 'a Team Lead is below an Officer; the order is the request\'s');
  for (const entry of res.skipped) assert.equal(typeof entry.message, 'string');
  assert.equal(res.skipped.find((entry) => entry.key === s.uids.off2).name, 'Officertwo', 'a skipped name carries the name when it is known');
  assert.equal(blockRow(s, 'm2').reason, 'First', 'the earlier block is untouched');
  for (const key of ['off', 'gm', 'off2']) assert.equal(blockRow(s, key), undefined, key);
  assert.equal(auditOf(s, 'access.remove').length, 4, 'one for the earlier single block, three for this call');
  assert.equal(auditOf(s, 'person.block').length, 1);
  // The Guild Master (here: the Owner) blocks an Officer; nobody blocks the Guild Master.
  const gm = await s.ok('gm', 'POST', BLOCK, { keys: [s.uids.off2, s.uids.gm, s.uids.off] }, 200);
  assert.deepEqual(doneKeys(gm), [s.uids.off2, s.uids.off]);
  assert.deepEqual(reasons(gm), { [s.uids.gm]: 'owner' });
  // A blocked Officer lost the access: the next call of theirs is refused like any call of a blocked account.
  assert.equal((await s.call('off', 'POST', BLOCK, { keys: [s.uids.m5] })).status, 403);
});

check('block: in an in-game guild - the live Owner is the Owner, a derived Guild Master is the Guild Master, a person whose in-game rank maps to Officer is out of an Officer\'s reach but not the Owner\'s, a suspended Owner is blockable', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  for (const [key, name] of [['own', 'Seatholder'], ['dgm', 'Derivedgm'], ['plain', 'Plainmember']]) await s.member(key, name);
  const people = {};
  for (const [key, name] of [['off', 'Offchar'], ['own', 'Ownchar'], ['dgm', 'Dgmchar'], ['plain', 'Plainchar']]) { people[key] = await s.person({ name }); await s.link(people[key].pid, key); }
  makeProven(s, 'off', people.off, { rank: 1 });
  makeProven(s, 'own', people.own, { rank: 4 });
  makeProven(s, 'dgm', people.dgm, { rank: 0 });
  makeProven(s, 'plain', people.plain, { rank: 3 });
  // Two account-less persons: one on in-game rank 1 (the rank map gives it Officer) and one on rank 3 (no role).
  const high = await s.person({ name: 'Highrank' });
  const low = await s.person({ name: 'Lowrank' });
  makeProven(s, 'off', high, { rank: 1, proof: 'officer', link: false, id: 9201 });
  makeProven(s, 'off', low, { rank: 3, proof: 'officer', link: false, id: 9202 });
  flip(s, { owner: 'own' });
  const asOfficer = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.own, s.uids.dgm, high.pid, low.pid, s.uids.plain] }, 200);
  assert.deepEqual(reasons(asOfficer), { [s.uids.own]: 'owner', [s.uids.dgm]: 'guild_master', [high.pid]: 'outranks' });
  assert.deepEqual(doneKeys(asOfficer), [low.pid, s.uids.plain]);
  // The Owner passes the person test and blocks the high-rank person; their own key is the Owner; a derived Guild Master is still the Guild Master, whoever asks.
  const asOwner = await s.ok('own', 'POST', BLOCK, { keys: [high.pid, s.uids.dgm, s.uids.own] }, 200);
  assert.deepEqual(doneKeys(asOwner), [high.pid]);
  assert.deepEqual(reasons(asOwner), { [s.uids.dgm]: 'guild_master', [s.uids.own]: 'owner' });
  // The seat holder whose proof is no Battle.net proof any more is suspended: blockable like anyone, by an Officer too (U R4-Q3).
  exec(s, "UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = ?", people.own.cid);
  const suspended = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.own] }, 200);
  assert.deepEqual(doneKeys(suspended), [s.uids.own]);
  assert.equal(blockRow(s, 'own').blocked_by, s.uids.off);
});

// ---------------------------------------------------------------------------
// Races: a guard that fails between the read and the write skips that name and writes nothing for it

// Runs `fn` once, right before the first batch that holds a statement matching `pattern` (after the route has read what it decided on).
function beforeBatch(s, pattern, fn) {
  const original = s.w.db.batch.bind(s.w.db);
  let pending = fn;
  s.w.db.batch = async (statements) => {
    if (pending && statements.some((statement) => pattern.test(statement.sql))) { const run = pending; pending = null; run(); }
    return original(statements);
  };
  return () => { s.w.db.batch = original; };
}

check('block: a name that became equal in rank, a name somebody else blocked first and a lost right are conflicts - skipped, with no effect and no audit row for them', async () => {
  const s = await world();
  for (const key of ['m1', 'm2', 'm3']) giveWork(s, key);
  const sqlite = s.w.db.sqlite;
  const untouched = async (key) => {
    assert.equal(blockRow(s, key) === undefined || blockRow(s, key).blocked_by !== s.uids.off, true, `${key}: no block by the actor`);
    assert.equal(await s.teamOf(s.people[key].cid), s.alpha, `${key}: still on the team`);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', s.people[key].pid)[0].n, 3, `${key}: still signed up`);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM standing_signups WHERE player_id = ?', s.people[key].pid)[0].n, 1, `${key}: standing sign-up`);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM team_requests WHERE requested_by = ?', s.uids[key])[0].n, 1, `${key}: request`);
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = ?', s.uids[key], 'access.remove')[0].n, 0, `${key}: no audit row`);
    assert.equal(rowsOf(s, "SELECT COUNT(*) AS n FROM block_tombstones WHERE block_ref = ? AND guild_id = ?", `u:${s.uids[key]}`, s.gid)[0].n, 0, `${key}: no tombstone`);
  };
  // 1. m1 is made an Officer (by hand) between the read and the write: the actor no longer outranks them. m2 is blocked by the other Officer first. m3 goes through.
  const stop = beforeBatch(s, /INSERT INTO guild_blocks/, () => {
    sqlite.prepare("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES ('ra_Fix000000000000000001', ?, ?, 'officer', NULL, ?, 1)").run(s.gid, s.uids.m1, s.uids.gm);
    sqlite.prepare("INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, ?, 'First', 5)").run(s.gid, s.uids.m2, s.uids.off2);
  });
  const res = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.m1, s.uids.m2, s.uids.m3] }, 200);
  stop();
  assert.deepEqual(doneKeys(res), [s.uids.m3]);
  assert.deepEqual(reasons(res), { [s.uids.m1]: 'conflict', [s.uids.m2]: 'conflict' });
  await untouched('m1');
  await untouched('m2');
  assert.equal(blockRow(s, 'm2').blocked_by, s.uids.off2, 'the first block stands');
  assert.equal(await s.teamOf(s.people.m3.cid), null, 'the name that went through is blocked with all its effects');
  assert.equal(auditOf(s, 'access.remove').length, 1);

  // 2. The Officer loses the role between the read and the write: nothing is written for anybody, and the answer says so for each name.
  for (const key of ['m4', 'm5']) giveWork(s, key);
  const stop2 = beforeBatch(s, /INSERT INTO guild_blocks/, () => sqlite.prepare("DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'officer'").run(s.gid, s.uids.off));
  const lost = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.m4, s.uids.m5] }, 200);
  stop2();
  assert.deepEqual(lost.done, []);
  assert.deepEqual(reasons(lost), { [s.uids.m4]: 'conflict', [s.uids.m5]: 'conflict' });
  await untouched('m4');
  await untouched('m5');
  assert.equal(auditOf(s, 'access.remove').length, 1, 'still only the first call\'s row');
});

check('block: an account-less person that gained an account, or whose rank changed, between the read and the write is a conflict too', async () => {
  const s = await world({ members: 2 });
  const sqlite = s.w.db.sqlite;
  const one = await s.person({ name: 'Personone' });
  const two = await s.person({ name: 'Persontwo' });
  const stop = beforeBatch(s, /INSERT INTO person_blocks/, () => sqlite.prepare('UPDATE players SET user_id = ? WHERE id = ?').run(s.uids.off2, one.pid));
  const res = await s.ok('off', 'POST', BLOCK, { keys: [one.pid, two.pid] }, 200);
  stop();
  // (players.user_id set by hand in this fixture only: the person has an account by the time the write runs.)
  assert.deepEqual(doneKeys(res), [two.pid]);
  assert.deepEqual(reasons(res), { [one.pid]: 'conflict' });
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM person_blocks WHERE player_id = ?', one.pid)[0].n, 0);
  assert.equal(auditOf(s, 'person.block').length, 1);
});

check('block: without a TOMBSTONE_KEY the blocks still apply, flagged tombstone_missing for the daily repair, with one operator line however many names', async () => {
  const s = await world({ env: {} });
  giveWork(s, 'm1');
  const wanted = await s.person({ name: 'Wanted' });
  exec(s, "UPDATE players SET discord_user_id = '555000000000000009' WHERE id = ?", wanted.pid);
  const { MISSING_KEY_LINE } = await load('worker/block-tombstones.js');
  const logged = s.w.logs.length;
  const res = await s.ok('off', 'POST', BLOCK, { keys: [s.uids.m1, s.uids.m2, wanted.pid] }, 200);
  assert.equal(res.done.length, 3);
  assert.equal(s.w.logs.slice(logged).filter((line) => line === MISSING_KEY_LINE).length, 1);
  for (const key of ['m1', 'm2']) assert.equal(blockRow(s, key).tombstone_missing, 1, key);
  assert.equal(rowsOf(s, 'SELECT tombstone_missing FROM person_blocks WHERE player_id = ?', wanted.pid)[0].tombstone_missing, 1);
  assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ?', s.gid), []);
  assert.equal(await s.teamOf(s.people.m1.cid), null, 'the effects do not wait for the key');
});

// ---------------------------------------------------------------------------
// The cap and the budget

// names for as many members as a test wants: Member + two letters beyond the first eight
const letters = (i) => String.fromCharCode(97 + Math.floor(i / 26) % 26) + String.fromCharCode(97 + (i % 26));

check('block: more than 25 names - the first 25 are blocked, the rest come back as over_cap and nothing is done for them; the statements of a request do not grow with the names', async () => {
  const s = await world({ members: 8 });
  // Twenty-four more members, each with a person, and eight account-less persons; the members have work to release.
  const extra = [];
  for (let i = 0; i < 24; i++) {
    const key = `x${i}`;
    await s.member(key, `Memberx${letters(i)}`);
    s.people[key] = await s.person({ name: `Mx${letters(i)}` });
    await s.link(s.people[key].pid, key);
    extra.push(key);
  }
  for (const key of ['m1', 'm2', ...extra]) giveWork(s, key);
  const loose = [];
  for (let i = 0; i < 8; i++) loose.push((await s.person({ name: `Loose${letters(i)}` })).pid);
  const uid = (key) => s.uids[key];
  const db = s.w.db;
  const run = async (keys) => {
    const from = db.statementLog.length;
    const res = await s.ok('off', 'POST', BLOCK, { keys, reason: 'Spam' }, 200);
    return { res, statements: statementsSince(db, from), from };
  };
  // A small request: two accounts and a person.
  const small = await run([s.uids.m1, s.uids.m2, loose[0]]);
  assert.equal(small.res.done.length, 3);
  // A big one: 20 accounts and 5 persons fit, then 4 more accounts and a person are over the cap.
  const keys = [...extra.slice(0, 20).map(uid), ...loose.slice(1, 6), ...extra.slice(20).map(uid), loose[6]];
  assert.equal(keys.length, 30);
  const many = await run(keys);
  assert.equal(many.res.done.length, 25);
  assert.deepEqual(many.res.skipped.map((entry) => entry.reason), Array(5).fill('over_cap'));
  assert.deepEqual(many.res.skipped.map((entry) => entry.key), [...extra.slice(20).map(uid), loose[6]]);
  assert.equal(many.res.cap, 25);
  for (const key of extra.slice(20)) {
    assert.equal(blockRow(s, key), undefined, `${key} was over the cap: not blocked`);
    assert.equal(await s.teamOf(s.people[key].cid), s.alpha, `${key} keeps the team`);
  }
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM person_blocks WHERE player_id = ?', loose[6])[0].n, 0);
  for (const key of extra.slice(0, 20)) assert.equal(await s.teamOf(s.people[key].cid), null, key);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM person_blocks')[0].n, 6);
  assert.equal(auditOf(s, 'access.remove').length, 22);
  console.log(`      measured: a block of 3 names costs ${small.statements} statements, of 25 names ${many.statements} (session, limits and guild context included)`);
  assert(small.statements <= 45 && many.statements <= 45, 'inside the free plan\'s 45 per request');
  assert(Math.abs(many.statements - small.statements) <= 1, 'the statements do not grow with the names');
  // The next window sends the over-cap names; they go through.
  s.w.advance(61_000);
  const rest = await run(many.res.skipped.map((entry) => entry.key));
  assert.equal(rest.res.done.length, 5);
  // No statement of the big call walks a table.
  const scans = scansSince(db, many.from, { tables: ['players', 'characters', 'guild_roster', 'role_assignments', 'raid_signups', 'raids', 'standing_signups', 'team_requests', 'applications', 'raid_presence', 'loot_awards', 'user_servers', 'guild_blocks', 'person_blocks', 'block_tombstones'] });
  assert.deepEqual(scans.map((entry) => `${entry.table}: ${entry.detail}`), [], 'no scan of the evidence, roster or block tables');
});

// ---------------------------------------------------------------------------
// Unblock

check('unblock: an Officer restores members, a Former member, a non-member and an account-less person in one call - the same database as one single DELETE per name', async () => {
  const build = async () => {
    const s = await world();
    giveWork(s, 'm1');
    giveWork(s, 'm2');
    leave(s, s.people.m3.cid);
    await s.outsider('out1', 'Outsiderone');
    addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
    s.wanted = await s.person({ name: 'Wanted' });
    exec(s, "UPDATE players SET discord_user_id = '555000000000000009' WHERE id = ?", s.wanted.pid);
    for (const key of ['m1', 'm2', 'm3']) await s.ok('off', 'POST', `/people/${s.uids[key]}/block`, { reason: 'Rude' }, 200);
    await s.ok('off', 'POST', `/roster/${s.wanted.pid}/block`, { reason: 'Rude' }, 200);
    // (The People route answers 404 for a non-member: this block is the bulk route's, in both guilds.)
    assert.equal((await s.call('off', 'POST', `/people/${s.uids.out1}/block`, { reason: 'Rude' })).status, 404);
    await s.ok('off', 'POST', BLOCK, { keys: [s.uids.out1], reason: 'Rude' }, 200);
    return s;
  };
  const single = await build();
  const bulk = await build();
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM block_tombstones')[0].n, 5);
  sameDump(dump(single), dump(bulk), 'the same fixture');
  for (const key of ['m1', 'm2', 'm3', 'out1']) await single.ok('off', 'DELETE', `/people/${single.uids[key]}/block`, undefined, 200);
  await single.ok('off', 'DELETE', `/roster/${single.wanted.pid}/block`, undefined, 200);
  const res = await bulk.ok('off', 'POST', UNBLOCK, { keys: [bulk.uids.m1, bulk.uids.m2, bulk.uids.m3, bulk.uids.out1, bulk.wanted.pid] }, 200);
  assert.deepEqual(Object.keys(res).sort(), ['action', 'cap', 'done', 'skipped']);
  assert.equal(res.action, 'unblock');
  assert.deepEqual(res.done.map((entry) => [entry.kind, entry.name]), [['account', 'Memberone'], ['account', 'Membertwo'], ['account', 'Memberthree'], ['account', 'Outsiderone'], ['person', 'Wanted']]);
  assert.deepEqual(res.skipped, []);
  sameDump(dump(bulk), dump(single), 'after');
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM guild_blocks')[0].n, 0);
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM person_blocks')[0].n, 0);
  assert.equal(rowsOf(bulk, 'SELECT COUNT(*) AS n FROM block_tombstones')[0].n, 0, 'their own tombstones are gone');
  assert.deepEqual(auditOf(bulk, 'access.restore').map((row) => [row.actor_role, row.before, row.after]), Array(4).fill(['officer', '{"blocked":true}', '{"blocked":false}']));
  assert.deepEqual(auditOf(bulk, 'person.unblock').map((row) => row.entity_id), [bulk.wanted.pid]);
  assert.equal((await list(bulk, 'off', 'segment=blocked')).counts.blocked, 0);
  assert.equal(await segmentOf(bulk, 'off', 'Memberthree'), 'former');
  assert.equal(await segmentOf(bulk, 'off', 'Memberone'), 'members');
  // What the block took (the team, the sign-ups) does not come back by itself.
  assert.equal(await bulk.teamOf(bulk.people.m1.cid), null);
});

check('unblock: each name gets the single route\'s guards - not blocked, unknown, a name, an equal or senior rank, the Guild Master, a person whose in-game rank maps to Officer - and the others are restored', async () => {
  const s = await world();
  await s.ok('gm', 'POST', `/people/${s.uids.off2}/block`, { reason: 'Gone' }, 200);          // an Officer, blocked by the Guild Master
  await s.ok('off', 'POST', `/people/${s.uids.m2}/block`, { reason: 'Gone' }, 200);
  await s.ok('off', 'POST', `/people/${s.uids.m3}/block`, { reason: 'Gone' }, 200);
  const foreign = `u_${'Q'.repeat(22)}`;
  const res = await s.ok('off', 'POST', UNBLOCK, { keys: [s.uids.off2, s.uids.m1, s.uids.m2, foreign, keyOfName('Somebody'), 'garbage', s.uids.gm, s.uids.m3] }, 200);
  assert.deepEqual(reasons(res), {
    [s.uids.off2]: 'outranks', [s.uids.m1]: 'not_blocked', [foreign]: 'not_found', [keyOfName('Somebody')]: 'name_only', garbage: 'not_found', [s.uids.gm]: 'not_blocked',
  });
  assert.deepEqual(doneKeys(res), [s.uids.m2, s.uids.m3]);
  assert(blockRow(s, 'off2'), 'the senior\'s block stands');
  assert.equal(blockRow(s, 'm2'), undefined);
  // The Guild Master restores the Officer.
  const gm = await s.ok('gm', 'POST', UNBLOCK, { keys: [s.uids.off2] }, 200);
  assert.deepEqual(doneKeys(gm), [s.uids.off2]);
  assert.equal(auditOf(s, 'access.restore').length, 3);
  assert.equal(rowsOf(s, "SELECT actor_role FROM audit_log WHERE action = 'access.restore' AND entity_id = ?", s.uids.off2)[0].actor_role, 'owner');
});

check('unblock: in an in-game guild a person whose in-game rank maps to Officer is the Owner\'s to restore, and a block row on the live Owner (ignored) is restored by any Officer', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  await s.member('own', 'Seatholder');
  const people = {};
  for (const [key, name] of [['off', 'Offchar'], ['own', 'Ownchar']]) { people[key] = await s.person({ name }); await s.link(people[key].pid, key); }
  makeProven(s, 'off', people.off, { rank: 1 });
  makeProven(s, 'own', people.own, { rank: 4 });
  const high = await s.person({ name: 'Highrank' });
  const low = await s.person({ name: 'Lowrank' });
  makeProven(s, 'off', high, { rank: 1, proof: 'officer', link: false, id: 9201 });
  makeProven(s, 'off', low, { rank: 3, proof: 'officer', link: false, id: 9202 });
  flip(s, { owner: 'own' });
  await s.ok('own', 'POST', BLOCK, { keys: [high.pid, low.pid] }, 200);
  exec(s, "INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, NULL, 'Stale', 1)", s.gid, s.uids.own);
  assert.equal((await list(s, 'off', 'segment=blocked&limit=100')).rows.find((entry) => entry.name === 'Seatholder').flags.ignoredWhileOwner, true);
  const asOfficer = await s.ok('off', 'POST', UNBLOCK, { keys: [high.pid, low.pid, s.uids.own] }, 200);
  assert.deepEqual(reasons(asOfficer), { [high.pid]: 'outranks' });
  assert.deepEqual(doneKeys(asOfficer), [low.pid, s.uids.own]);
  assert.equal(blockRow(s, 'own'), undefined, 'the ignored row is gone');
  const asOwner = await s.ok('own', 'POST', UNBLOCK, { keys: [high.pid] }, 200);
  assert.deepEqual(doneKeys(asOwner), [high.pid]);
});

// The F9 scenario of the single routes with the bulk route: a blocked account deletes its data and comes back as a NEW account with the same Discord ID, which the tombstones
// block for review; unblocking the new account lifts the earlier block's tombstones only as far as the actor's rank allows.
async function comeBack(s, key, name, as) {
  s.jars[as] = (await signIn(s.w, discord(key, name), [memberOf(s.serverId)])).jar;
  s.uids[as] = (await s.w.call(s.jars[as], 'GET', '/auth/me')).json.user.id;
  return s.uids[as];
}
async function matchedWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  // o1 holds the Owner seat when it blocks m1 (the audit row snapshots 'owner') and is only an Officer afterwards; o2 (an Officer) blocked m2.
  s.setOwner('o1');
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  s.setOwner('gm');
  await s.ok('o2', 'POST', `/people/${s.uids.m2}/block`, {}, 200);
  for (const key of ['m1', 'm2']) assert.equal((await s.w.call(s.jars[key], 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  s.m1b = await comeBack(s, 'm1', 'Memberone', 'm1b');
  s.m2b = await comeBack(s, 'm2', 'Membertwo', 'm2b');
  for (const id of [s.m1b, s.m2b]) assert.equal(rowsOf(s, 'SELECT pending_review FROM guild_blocks WHERE user_id = ?', id)[0].pending_review, 1, 'the new account is blocked for review');
  return s;
}

check('unblock: the tombstones of an earlier block the new account matched go only as far as the actor\'s rank allows - an Officer\'s block yes, a senior snapshot no (tombstonesKept), the blocker\'s own always - like the single route', async () => {
  const s = await matchedWorld();
  // The old accounts' ids are still s.uids.m1 and s.uids.m2: their tombstones sit under u:<old id>.
  const [oldM1Ref, oldM2Ref] = [s.uids.m1, s.uids.m2].map((id) => `u:${id}`);
  const refCount = (ref) => rowsOf(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, ref)[0].n;
  assert(refCount(oldM1Ref) > 0 && refCount(oldM2Ref) > 0, 'the two deleted accounts left their tombstones under their old refs');
  // o2 (an Officer) unblocks both new accounts: m2's earlier block was an Officer's (equal: lifted), m1's was the Owner's (senior: kept).
  const res = await s.ok('o2', 'POST', UNBLOCK, { keys: [s.m1b, s.m2b] }, 200);
  assert.deepEqual(doneKeys(res), [s.m1b, s.m2b]);
  assert.equal(res.tombstonesKept, 1);
  assert.equal(refCount(oldM2Ref), 0, 'an Officer lifts an Officer\'s memory');
  assert(refCount(oldM1Ref) > 0, 'a senior snapshot keeps its memory');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks')[0].n, 0);
  // m1 comes back once more: blocked again by the kept tombstones; o1, who MADE the earlier block, lifts everything.
  await s.w.call(s.jars.m1b, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  const m1c = await comeBack(s, 'm1', 'Memberone', 'm1c');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks WHERE user_id = ?', m1c)[0].n, 1, 'matched again');
  const byBlocker = await s.ok('o1', 'POST', UNBLOCK, { keys: [m1c] }, 200);
  assert.deepEqual(doneKeys(byBlocker), [m1c]);
  assert.equal(byBlocker.tombstonesKept, undefined);
  assert.equal(refCount(oldM1Ref), 0, 'the Officer who made the block lifts its tombstones');
});

check('unblock: the same database as the single DELETE route for the matched-block scenario', async () => {
  const single = await matchedWorld();
  const bulk = await matchedWorld();
  sameDump(dump(single), dump(bulk), 'the same fixture');
  for (const id of [single.m1b, single.m2b]) await single.ok('o2', 'DELETE', `/people/${id}/block`, undefined, 200);
  await bulk.ok('o2', 'POST', UNBLOCK, { keys: [bulk.m1b, bulk.m2b] }, 200);
  sameDump(dump(bulk), dump(single), 'after');
});

check('unblock: a guard that fails between the read and the write - the right lost, the block restored by somebody else first - skips or accepts that name and writes nothing for it', async () => {
  const s = await world();
  for (const key of ['m1', 'm2', 'm3', 'm4']) await s.ok('off', 'POST', `/people/${s.uids[key]}/block`, {}, 200);
  const sqlite = s.w.db.sqlite;
  const audits = () => auditOf(s, 'access.restore').length;
  // 1. m1 is restored by somebody else between the read and the write: fine, no second audit row.
  const stop = beforeBatch(s, /access\.restore|DELETE FROM guild_blocks/, () => sqlite.prepare('DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ?').run(s.gid, s.uids.m1));
  const first = await s.ok('off', 'POST', UNBLOCK, { keys: [s.uids.m1, s.uids.m2] }, 200);
  stop();
  assert.deepEqual(doneKeys(first), [s.uids.m1, s.uids.m2]);
  assert.equal(audits(), 1, 'only the name this call restored is audited');
  // 2. The Officer loses the role between the read and the write: nothing is deleted, nothing is audited, each name says conflict.
  const stop2 = beforeBatch(s, /access\.restore|DELETE FROM guild_blocks/, () => sqlite.prepare("DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'officer'").run(s.gid, s.uids.off));
  const lost = await s.ok('off', 'POST', UNBLOCK, { keys: [s.uids.m3, s.uids.m4] }, 200);
  stop2();
  assert.deepEqual(lost.done, []);
  assert.deepEqual(reasons(lost), { [s.uids.m3]: 'conflict', [s.uids.m4]: 'conflict' });
  assert(blockRow(s, 'm3') && blockRow(s, 'm4'));
  assert.equal(audits(), 1);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE block_ref IN (?, ?)', `u:${s.uids.m3}`, `u:${s.uids.m4}`)[0].n, 2, 'their tombstones stay with the blocks');
});

check('unblock: 23 names cost the statements of 3, inside the free plan\'s 45, with no scan of the block, roster or evidence tables', async () => {
  const s = await world({ members: 8 });
  const extra = [];
  for (let i = 0; i < 20; i++) {
    const key = `x${i}`;
    await s.member(key, `Memberx${letters(i)}`);
    s.people[key] = await s.person({ name: `Mx${letters(i)}` });
    await s.link(s.people[key].pid, key);
    extra.push(key);
  }
  const loose = [];
  for (let i = 0; i < 5; i++) loose.push((await s.person({ name: `Loose${letters(i)}` })).pid);
  const uid = (key) => s.uids[key];
  const everyone = [s.uids.m1, ...extra.map(uid), ...loose];
  await s.ok('off', 'POST', BLOCK, { keys: everyone.slice(0, 25) }, 200);
  await s.ok('off', 'POST', BLOCK, { keys: everyone.slice(25) }, 200);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks')[0].n, 21);
  const db = s.w.db;
  const run = async (keys) => {
    const from = db.statementLog.length;
    const res = await s.ok('off', 'POST', UNBLOCK, { keys }, 200);
    return { res, statements: statementsSince(db, from), from };
  };
  const small = await run([s.uids.m1, uid(extra[0]), loose[0]]);
  assert.equal(small.res.done.length, 3);
  const many = await run([...extra.slice(1).map(uid), ...loose.slice(1)]);
  assert.equal(many.res.done.length, 23);
  console.log(`      measured: an unblock of 3 names costs ${small.statements} statements, of 23 names ${many.statements}`);
  assert(small.statements <= 45 && many.statements <= 45);
  assert(Math.abs(many.statements - small.statements) <= 1, 'the statements do not grow with the names');
  const scans = scansSince(db, many.from, { tables: ['players', 'characters', 'guild_roster', 'role_assignments', 'raid_signups', 'raids', 'applications', 'user_servers', 'guild_blocks', 'person_blocks', 'block_tombstones'] });
  assert.deepEqual(scans.map((entry) => `${entry.table}: ${entry.detail}`), []);
});

// ---------------------------------------------------------------------------
// Add to a person

// Names seen and on no roster: a loot winner (class WARRIOR), a log name (ROGUE), a pasted name (no class), a Raid-Helper sign-up (no class), an application (MAGE).
function seenNames(s) {
  addLoot(s, s.past, 'Lootguy');
  addPresence(s, s.past, 'Logguy');
  addManual(s, s.next, 'Pasted');
  addSignup(s, s.past, { source: 'raid_helper', nickname: 'Helperguy', discordId: '555000000000000001' });
  addApplication(s, { name: 'Hopeful' });
}
const nameRows = async (s, who = 'off') => (await list(s, who, 'segment=nonmembers&limit=100')).rows.filter((entry) => entry.kind === 'name').map((entry) => entry.name).sort();
const charactersOf = (s, pid) => rowsOf(s, 'SELECT id, name, name_key, realm, realm_key, class, is_main, team_id, core_rank, left_on, namespace, blizzard_char_id, owner_proof, proof_user_id FROM characters WHERE player_id = ? ORDER BY name', pid);
// The writers of players.user_id are other lanes' business (Battle.net proof, the holder's own application, an approved claim): a trigger makes any write to it fail.
function guardPlayersUserId(s) {
  exec(s, "CREATE TRIGGER players_user_id_update BEFORE UPDATE OF user_id ON players BEGIN SELECT RAISE(ABORT, 'players.user_id was written'); END");
  exec(s, "CREATE TRIGGER players_user_id_insert BEFORE INSERT ON players WHEN NEW.user_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'players.user_id was written'); END");
}
const writesToPlayers = (db, from) => db.statementLog.slice(from).filter(({ sql }) => /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+players\b/i.test(sql));
// Gives the Officer and the Member role of the guild a permission list without the named actions (an edited role: the system rows copied, minus these).
function dropFromOfficer(s, actions) {
  for (const role of ['officer', 'member']) {
    exec(s, 'INSERT OR IGNORE INTO role_overrides (guild_id, role_id) VALUES (?, ?)', s.gid, role);
    exec(s, 'DELETE FROM role_override_permissions WHERE guild_id = ? AND role_id = ?', s.gid, role);
    for (const entry of rowsOf(s, 'SELECT action, scope FROM role_permissions WHERE role_id = ?', role)) {
      if (!actions.includes(entry.action)) exec(s, 'INSERT INTO role_override_permissions (guild_id, role_id, action, scope) VALUES (?, ?, ?, ?)', s.gid, role, entry.action, entry.scope);
    }
  }
}

check('add to a person: names seen in loot, a log, a pasted list, a sign-up and an application become alts of the account\'s person - no team, the Main\'s rank, audited, the raids that log them out of date, and players is not written', async () => {
  const s = await world({ members: 3 });
  seenNames(s);
  const other = addRaid(s, '2026-12-15');
  exec(s, "UPDATE raids SET policy_fp = 'fp'");
  await s.alt(s.people.m1.pid, 'Normalalt');
  assert.deepEqual(await nameRows(s), ['Helperguy', 'Hopeful', 'Logguy', 'Lootguy', 'Pasted']);
  const playersBefore = rowsOf(s, 'SELECT * FROM players ORDER BY id');
  guardPlayersUserId(s);
  const db = s.w.db;
  const from = db.statementLog.length;
  const names = ['Lootguy', 'Logguy', 'Pasted', 'Helperguy', 'Hopeful'];
  const res = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: names.map((name) => ({ key: keyOfName(name), ...(name === 'Pasted' || name === 'Helperguy' ? { class: 'PRIEST' } : {}) })) }, 200);
  assert.equal(writesToPlayers(db, from).length, 0, 'no statement writes players');
  assert.deepEqual(Object.keys(res).sort(), ['cap', 'done', 'person', 'skipped']);
  assert.deepEqual(res.person, { key: s.uids.m1, name: 'Mone' });
  assert.equal(res.cap, 10);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.done.map((entry) => [entry.key, entry.name]), names.map((name) => [keyOfName(name), name]));
  // The characters: alts of m1's person, teamless, the Main's rank, class from the sighting (the officer's for a name with none), the guild's realm.
  const alts = charactersOf(s, s.people.m1.pid).filter((entry) => !entry.is_main);
  const byName = Object.fromEntries(alts.map((entry) => [entry.name, entry]));
  assert.deepEqual(Object.keys(byName).sort(), ['Helperguy', 'Hopeful', 'Logguy', 'Lootguy', 'Normalalt', 'Pasted']);
  assert.deepEqual(Object.fromEntries(names.map((name) => [name, byName[name].class])), { Lootguy: 'WARRIOR', Logguy: 'ROGUE', Pasted: 'PRIEST', Helperguy: 'PRIEST', Hopeful: 'MAGE' });
  for (const name of names) {
    const row = byName[name];
    assert.deepEqual([row.is_main, row.team_id, row.core_rank, row.left_on, row.realm, row.realm_key, row.name_key], [0, null, 'raider', null, 'Nightslayer', 'nightslayer', name.toLowerCase()], name);
    // The same columns as an alt made through the roster route: no Blizzard id, no proof.
    for (const column of ['namespace', 'blizzard_char_id', 'owner_proof', 'proof_user_id']) assert.equal(row[column], byName.Normalalt[column], `${name}.${column}`);
  }
  assert.equal(res.done.every((entry) => /^c_/.test(entry.characterId) && byName[entry.name].id === entry.characterId), true);
  // They lined up: the names are gone from the list, the person's lastSeen counts the loot, and the audit says who and how.
  assert.deepEqual(await nameRows(s), []);
  const created = rowsOf(s, "SELECT entity_id, actor_user_id, actor_role, after FROM audit_log WHERE action = 'character.create' AND after LIKE '%\"via\":\"users\"%' ORDER BY entity_id");
  assert.equal(created.length, 5);
  for (const row of created) {
    const after = JSON.parse(row.after);
    assert.deepEqual([row.actor_user_id, row.actor_role, after.personId, after.teamId, after.makeMain, after.via], [s.uids.off, 'officer', s.people.m1.pid, null, false, 'users']);
  }
  const audit = await s.ok('gm', 'GET', '/audit');
  assert(audit.rows.some((row) => row.action === 'character.create' && /Lootguy/.test(row.text) && /Mone/.test(row.text)), 'the audit page words it');
  // The raid whose log named Logguy is out of date; a raid with nothing to do with them is not.
  const raids = Object.fromEntries(rowsOf(s, 'SELECT id, policy_fp FROM raids').map((raid) => [raid.id, raid.policy_fp]));
  assert.equal(raids[s.past], '');
  assert.equal(raids[other], 'fp');
  // Players is untouched, field by field (user_id included), and so is the account link.
  assert.deepEqual(rowsOf(s, 'SELECT * FROM players ORDER BY id'), playersBefore);
  assert.equal(rowsOf(s, 'SELECT user_id FROM players WHERE id = ?', s.people.m1.pid)[0].user_id, s.uids.m1);
});

check('add to a person: the target is an account (its person) or an account-less person; no person, an unknown one and a name are refused; a name key given as the person is a 400', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  const ghost = await s.person({ name: 'Ghost' });
  await s.outsider('out1', 'Outsiderone');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
  const one = await s.ok('off', 'POST', ADD, { person: ghost.pid, names: [{ key: keyOfName('Lootguy') }] }, 200);
  assert.deepEqual([one.person, one.done.length], [{ key: ghost.pid, name: 'Ghost' }, 1]);
  assert.equal(charactersOf(s, ghost.pid).some((entry) => entry.name === 'Lootguy'), true);
  // A person that has an account may be given by either key; the person is the same.
  const two = await s.ok('off', 'POST', ADD, { person: s.people.m1.pid, names: [{ key: keyOfName('Logguy') }] }, 200);
  assert.equal(two.done.length, 1);
  assert.equal(charactersOf(s, s.people.m1.pid).some((entry) => entry.name === 'Logguy'), true);
  for (const [person, status, why] of [
    [s.uids.out1, 404, 'an account that has no person on the roster'], [`u_${'Q'.repeat(22)}`, 404, 'an unknown account'], [`p_${'Q'.repeat(22)}`, 404, 'an unknown person'],
  ]) {
    const res = await s.call('off', 'POST', ADD, { person, names: [{ key: keyOfName('Pasted') }] });
    assert.equal(res.status, status, why);
    assert.equal(res.json.error, 'not_found', why);
  }
  assert.equal((await s.call('off', 'POST', ADD, { person: keyOfName('Pasted'), names: [{ key: keyOfName('Pasted') }] })).status, 400);
  assert.equal(charactersOf(s, s.people.m2.pid).length, 1, 'nothing was added to anybody else');
});

check('add to a person: refused in an in-game guild (characters reach an account only through Battle.net), bookkeeping in a manual guild - and it never writes players.user_id', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  const offPerson = await s.person({ name: 'Offchar' });
  await s.link(offPerson.pid, 'off');
  const gmPerson = await s.person({ name: 'Gmchar' });
  await s.link(gmPerson.pid, 'gm');
  ingameize(s, { owner: 'gm', people: { gm: gmPerson, off: offPerson, m1: s.people.m1, m2: s.people.m2 } });
  guardPlayersUserId(s);
  const db = s.w.db;
  const before = rowsOf(s, 'SELECT COUNT(*) AS n FROM characters')[0].n;
  const audits = rowsOf(s, 'SELECT COUNT(*) AS n FROM audit_log')[0].n;
  const from = db.statementLog.length;
  for (const who of ['off', 'gm']) {
    const res = await s.call(who, 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Lootguy') }] });
    assert.equal(res.status, 409, `${who}: ${res.text}`);
    assert.equal(res.json.error, 'battlenet_only');
    assert(/Battle\.net/.test(res.json.message));
  }
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM characters')[0].n, before, 'nothing was added');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM audit_log')[0].n, audits, 'and nothing audited');
  assert.equal(writesToPlayers(db, from).length, 0);
  assert.deepEqual(await nameRows(s), ['Helperguy', 'Hopeful', 'Logguy', 'Lootguy', 'Pasted'], 'the names are still on the list of names seen');
  // The same guild on the manual rank source: a link makes a member, and a name may be added by hand.
  exec(s, "UPDATE guilds SET rank_source = 'manual' WHERE id = ?", s.gid);
  const manual = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Lootguy') }] }, 200);
  assert.deepEqual(manual.done.map((entry) => entry.name), ['Lootguy']);
  assert.equal(writesToPlayers(db, from).length, 0, 'still no write to players');
  assert.equal(rowsOf(s, 'SELECT user_id FROM players WHERE id = ?', s.people.m1.pid)[0].user_id, s.uids.m1);
});

check('add to a person: the Seniority guard of the person - an Officer cannot give names to an Officer\'s person, the Guild Master can, and the guard runs inside the write', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  const offTwo = await s.person({ name: 'Offtwochar' });
  await s.link(offTwo.pid, 'off2');
  const own = await s.person({ name: 'Ownchar' });
  await s.link(own.pid, 'off');
  const refused = await s.call('off', 'POST', ADD, { person: s.uids.off2, names: [{ key: keyOfName('Lootguy') }] });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'seniority');
  assert.equal(charactersOf(s, offTwo.pid).length, 1);
  assert.equal((await s.ok('gm', 'POST', ADD, { person: s.uids.off2, names: [{ key: keyOfName('Lootguy') }] }, 200)).done.length, 1);
  assert.equal((await s.ok('off', 'POST', ADD, { person: s.uids.off, names: [{ key: keyOfName('Logguy') }] }, 200)).done.length, 1, 'their own person');
  // Between the read and the write the person's account becomes an Officer: the write's own guard says no.
  const stop = beforeBatch(s, /INSERT INTO characters/, () => s.w.db.sqlite.prepare("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES ('ra_Fix000000000000000002', ?, ?, 'officer', NULL, ?, 1)").run(s.gid, s.uids.m1, s.uids.gm));
  const raced = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Hopeful') }] }, 200);
  stop();
  assert.deepEqual(raced.done, []);
  assert.deepEqual(reasons(raced), { [keyOfName('Hopeful')]: 'conflict' });
  assert.equal(charactersOf(s, s.people.m1.pid).length, 1);
});

check('add to a person: each name says why it is skipped - not on the list, not a name, no class, a realm the guild does not take, a name that cannot be a character, the character limit', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  addLoot(s, s.past, 'Otherrealm');
  exec(s, "UPDATE loot_awards SET winner_realm = 'Dreamscythe', winner_realm_key = 'dreamscythe' WHERE winner_name_key = 'otherrealm'");
  addLoot(s, s.past, 'Nowhere');
  exec(s, "UPDATE loot_awards SET winner_realm = 'Atlantis', winner_realm_key = 'atlantis' WHERE winner_name_key = 'nowhere'");
  addSignup(s, s.past, { source: 'raid_helper', nickname: 'Bad nick 9', discordId: '555000000000000002' });
  const keys = {
    ok: keyOfName('Lootguy'), unknown: keyOfName('Neverseen'), roster: keyOfName('Mone'), account: s.uids.m1, person: s.people.m1.pid, garbage: 'nonsense', needsClass: keyOfName('Pasted'),
    other: keyOfName('Otherrealm'), nowhere: keyOfName('Nowhere'), badName: keyOfName('Bad nick 9'),
  };
  const res = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: Object.values(keys).map((key) => ({ key })) }, 200);
  assert.deepEqual(reasons(res), {
    [keys.unknown]: 'not_found', [keys.roster]: 'not_found', [keys.account]: 'not_a_name', [keys.person]: 'not_a_name', nonsense: 'not_found', [keys.needsClass]: 'class_needed',
    [keys.nowhere]: 'bad_realm', [keys.badName]: 'bad_name',
  });
  assert.deepEqual(res.done.map((entry) => entry.name), ['Lootguy', 'Otherrealm']);
  for (const entry of res.skipped) assert.equal(typeof entry.message, 'string');
  const other = charactersOf(s, s.people.m1.pid).find((entry) => entry.name === 'Otherrealm');
  assert.deepEqual([other.realm, other.realm_key, other.class], ['Dreamscythe', 'dreamscythe', 'WARRIOR'], 'the realm the name was seen on, when the guild\'s game version has it');
  // The officer's class for a name with none; a class the loot or the log knows wins over the officer's.
  const second = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keys.needsClass, class: 'DRUID' }, { key: keyOfName('Logguy'), class: 'DRUID' }] }, 200);
  assert.deepEqual(second.done.map((entry) => entry.name), ['Pasted', 'Logguy']);
  const classes = Object.fromEntries(charactersOf(s, s.people.m1.pid).map((entry) => [entry.name, entry.class]));
  assert.deepEqual([classes.Pasted, classes.Logguy], ['DRUID', 'ROGUE']);
  // The character limit of a person (20): a person with 19 characters takes one more.
  for (let i = 0; i < 14; i++) await s.alt(s.people.m1.pid, `Filler${letters(i)}`);
  const count = () => charactersOf(s, s.people.m1.pid).length;
  assert.equal(count(), 19);
  addLoot(s, s.past, 'Lasta');
  addLoot(s, s.past, 'Lastb');
  const limited = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Lasta') }, { key: keyOfName('Lastb') }] }, 200);
  assert.deepEqual(limited.done.map((entry) => entry.name), ['Lasta']);
  assert.deepEqual(reasons(limited), { [keyOfName('Lastb')]: 'character_limit' });
  assert.equal(count(), 20);
});

check('add to a person: 12 names - the first 10 go in, the rest are over_cap; a duplicate key counts once; the statements fit the free plan; a viewer who may not see loot cannot add a loot-only name', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  const wanted = [];
  for (let i = 0; i < 14; i++) { wanted.push(`Seen${letters(i)}`); addLoot(s, s.past, wanted[i]); }
  const db = s.w.db;
  const run = async (person, names) => {
    const from = db.statementLog.length;
    const res = await s.ok('off', 'POST', ADD, { person, names: names.map((name) => ({ key: keyOfName(name) })) }, 200);
    return { res, statements: statementsSince(db, from), from };
  };
  const roomy = await s.person({ name: 'Roomy' });
  const small = await run(roomy.pid, ['Lootguy', 'Logguy']);
  assert.equal(small.res.done.length, 2);
  const fresh = await s.person({ name: 'Fresh' });
  const many = await run(fresh.pid, [...wanted.slice(0, 11), wanted[0], wanted[11]]);
  assert.equal(many.res.done.length, 10, 'a duplicate key counts once');
  assert.deepEqual(many.res.skipped.map((entry) => [entry.key, entry.reason]), [[keyOfName(wanted[10]), 'over_cap'], [keyOfName(wanted[11]), 'over_cap']]);
  assert.equal(many.res.cap, 10);
  assert.equal(charactersOf(s, fresh.pid).length, 11);
  assert.equal(charactersOf(s, fresh.pid).some((entry) => entry.name === wanted[10]), false, 'an over-cap name is not added');
  console.log(`      measured: Add to a person costs ${small.statements} statements for 2 names, ${many.statements} for 10 (one audit row each)`);
  assert(small.statements <= 45 && many.statements <= 45, 'inside the free plan\'s 45 per request');
  const scans = scansSince(db, many.from, { tables: ['players', 'characters', 'guild_roster', 'role_assignments', 'raids', 'applications', 'user_servers'] });
  // (The one scan is the Seniority guard's own, worker/seniority.js: it reads the effective-roles view for the person's account and the actor, here as in every roster write.)
  assert.deepEqual(scans.filter((entry) => !/AS gid|^INSERT INTO characters/.test(entry.sql)).map((entry) => `${entry.table}: ${entry.detail}`), [], 'no scan of the roster tables');
  // A viewer who may not see loot: the loot-only name is not a name for them.
  dropFromOfficer(s, ['loot.view']);
  const hidden = await s.ok('off', 'POST', ADD, { person: s.uids.m2, names: [{ key: keyOfName(wanted[12]) }, { key: keyOfName('Hopeful') }] }, 200);
  assert.deepEqual(reasons(hidden), { [keyOfName(wanted[12])]: 'not_found' });
  assert.deepEqual(hidden.done.map((entry) => entry.name), ['Hopeful']);
});

check('add to a person: a right lost, a name that became a character and a person that left between the read and the write change nothing', async () => {
  const s = await world({ members: 2 });
  seenNames(s);
  const sqlite = s.w.db.sqlite;
  const characters = () => rowsOf(s, 'SELECT COUNT(*) AS n FROM characters')[0].n;
  const audits = () => rowsOf(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'character.create'")[0].n;
  const base = [characters(), audits()];
  // 1. The Officer loses roster.edit between the read and the write: the guard says no for every name.
  const stop = beforeBatch(s, /INSERT INTO characters/, () => dropFromOfficer(s, ['roster.edit']));
  const lost = await s.ok('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Lootguy') }, { key: keyOfName('Logguy') }] }, 200);
  stop();
  assert.deepEqual(lost.done, []);
  assert.deepEqual(reasons(lost), { [keyOfName('Lootguy')]: 'conflict', [keyOfName('Logguy')]: 'conflict' });
  assert.deepEqual([characters(), audits()], base);
  sqlite.exec('DELETE FROM role_override_permissions; DELETE FROM role_overrides');
  // 2. One of the names becomes a character of somebody else: the unique name rejects the whole write (409), nothing is added for the other.
  const stop2 = beforeBatch(s, /INSERT INTO characters/, () => sqlite.prepare("INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at) VALUES ('c_Fix000000000000000003', ?, ?, NULL, 'Lootguy', 'lootguy', 'Nightslayer', 'nightslayer', 'MAGE', 0, 1, 1)").run(s.gid, s.people.m2.pid));
  const taken = await s.call('off', 'POST', ADD, { person: s.uids.m1, names: [{ key: keyOfName('Lootguy') }, { key: keyOfName('Logguy') }] });
  stop2();
  assert.equal(taken.status, 409, taken.text);
  assert.equal(taken.json.error, 'conflict');
  assert.equal(characters(), base[0] + 1, 'only the character the race itself made');
  assert.equal(audits(), base[1]);
  // 3. The person is deleted between the read and the write.
  const doomed = await s.person({ name: 'Doomed' });
  const stop3 = beforeBatch(s, /INSERT INTO characters/, () => { sqlite.prepare('DELETE FROM characters WHERE player_id = ?').run(doomed.pid); sqlite.prepare('DELETE FROM players WHERE id = ?').run(doomed.pid); });
  const gone = await s.ok('off', 'POST', ADD, { person: doomed.pid, names: [{ key: keyOfName('Hopeful') }] }, 200);
  stop3();
  assert.deepEqual(reasons(gone), { [keyOfName('Hopeful')]: 'conflict' });
  assert.equal(audits(), base[1]);
});

// ---------------------------------------------------------------------------
// The big guild and the sentinels

const rowsReadSince = (db, from) => db.statementLog.slice(from).reduce((sum, entry) => sum + entry.rowsRead, 0);

check('budget: on the 5,000-name in-game guild a block and an unblock of 25 names cost a few dozen statements, return a few hundred rows and scan no table', async () => {
  const s = unlimited(await baseBigWorld({ scale: 1 }));
  const db = s.w.db;
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guilds')[0].n, 2001);
  const accounts = [];
  const persons = [];
  for (let offset = 0; accounts.length < 20 && offset < 1900; offset += 100) {
    const page = (await list(s, 'dof', `segment=members&limit=100&offset=${offset}`)).rows;
    for (const entry of page) {
      if (entry.kind === 'account' && !entry.flags.owner && entry.permission === null && accounts.length < 20) accounts.push(entry.key);
      else if (entry.kind === 'person' && persons.length < 5) persons.push(entry.key);
    }
  }
  assert.deepEqual([accounts.length, persons.length], [20, 5]);
  const keys = [...accounts, ...persons];
  const tables = ['users', 'players', 'characters', 'guild_roster', 'role_assignments', 'guilds', 'raid_signups', 'loot_awards', 'attendance', 'raid_presence', 'raid_pulls', 'applications', 'raids',
    'user_servers', 'guild_blocks', 'person_blocks', 'raid_manual_names', 'attendance_guests', 'character_name_aliases', 'bnet_links', 'source_rank_maps', 'teams', 'standing_signups',
    'team_requests', 'block_tombstones', 'audit_log'];
  const measured = {};
  for (const [label, tail, body] of [['block', BLOCK, { keys, reason: 'Spam' }], ['unblock', UNBLOCK, { keys }]]) {
    const from = db.statementLog.length;
    const res = await s.ok('dof', 'POST', tail, body, 200);
    assert.equal(res.done.length, 25, label);
    const statements = statementsSince(db, from);
    const rows = rowsReadSince(db, from);
    measured[label] = [statements, rows];
    assert(statements <= 45, `${label}: ${statements} statements`);
    assert(rows <= 600, `${label}: ${rows} rows returned`);
    assert.deepEqual(scansSince(db, from, { tables }).map((entry) => `${entry.table}: ${entry.detail} :: ${entry.sql}`), [], `${label}: no scan`);
  }
  console.log(`      measured on 5,000 names: [statements, rows returned] ${JSON.stringify(measured)}`);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks WHERE blocked_by = ?', s.uids.dof)[0].n, 0, 'unblocked again');
});

check('redaction: no Discord id, Battle.net id, BattleTag, Blizzard id, token hash, tombstone or webhook is in any reply of Manage users, for the principals that may call it and for those that may not', async () => {
  const s = await sentinelWorld({ wrap: unlimited });
  const secrets = sentinelsOf(s);
  assert(secrets.length > 40, `${secrets.length} sentinels planted`);
  const principals = { own: 200, dgm: 200, dof: 200, sof: 200, dtl: 403, stl: 403, cust: 403, mem: 403 };
  const keys = [];
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) {
    for (let offset = 0; ; offset += 100) {
      const page = await list(s, 'own', `segment=${segment}&limit=100&offset=${offset}`);
      keys.push(...page.rows.map((entry) => entry.key));
      if (!page.more) break;
    }
  }
  assert(keys.length >= 15 && keys.some((key) => key.startsWith('n_')) && keys.some((key) => key.startsWith('p_')) && keys.some((key) => key.startsWith('u_')), `${keys.length} keys of every kind`);
  let scanned = 0;
  const clean = (res, label) => {
    scanned++;
    for (const secret of secrets) assert(!res.text.includes(secret.value), `${label} carries the sentinel ${secret.value}`);
  };
  const names = keys.filter((key) => key.startsWith('n_')).slice(0, 8).map((key) => ({ key }));
  for (const [who, status] of Object.entries(principals)) {
    for (let at = 0; at < keys.length; at += 25) {
      const chunk = keys.slice(at, at + 25);
      const blocked = await s.call(who, 'POST', BLOCK, { keys: chunk, reason: 'Sentinel check' });
      assert.equal(blocked.status, status, `${who} block: ${blocked.text.slice(0, 200)}`);
      clean(blocked, `${who} block`);
      const restored = await s.call(who, 'POST', UNBLOCK, { keys: chunk });
      assert.equal(restored.status, status, `${who} unblock: ${restored.text.slice(0, 200)}`);
      clean(restored, `${who} unblock`);
    }
    const accountKey = keys.find((key) => key.startsWith('u_') && key !== s.uids[who]);
    clean(await s.call(who, 'POST', ADD, { person: accountKey, names }), `${who} add to a person`);
    clean(await s.call(who, 'POST', ADD, { person: `p_${'Z'.repeat(22)}`, names }), `${who} add to an unknown person`);
    clean(await s.call(who, 'POST', BLOCK, { keys: [`u_${'Z'.repeat(22)}`, `p_${'Z'.repeat(22)}`, 'n_00', 'junk'] }), `${who} block of nothing`);
    clean(await s.call(who, 'POST', UNBLOCK, { keys: 'not a list' }), `${who} bad body`);
  }
  assert(scanned >= Object.keys(principals).length * 5, `${scanned} replies read`);
  // The signed out and a stranger are refused with nothing.
  for (const tail of [BLOCK, UNBLOCK, ADD]) clean(await s.w.call(newJar(), 'POST', `${s.base}${tail}`, { keys: keys.slice(0, 3) }), `signed out ${tail}`);
  clean(await s.call('out1', 'POST', BLOCK, { keys: keys.slice(0, 3) }), 'a signed-in outsider');
});

runChecks(checks);
