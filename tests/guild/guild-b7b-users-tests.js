/**
 * Raidsmith guild tracker - lane B7b part 1 of the user-hierarchy build: the Users list (GET /api/guild/:gid/users), the page of one user (GET .../users/:ukey) and Keep for a
 * block that waits for review (POST .../people/:uid/block/keep)
 * Run: node tests/guild/guild-b7b-users-tests.js
 *
 *   gate ............ guild.access or guild.roles (the People list's gate); a Team Lead, a plain Member, a custom role and a signed-out caller are refused; 400 on a bad query
 *   segments ........ members / former / nonmembers / blocked per rank source (legacy, manual, in-game), the Owner and a SUSPENDED Owner, a derived Guild Master, account-less
 *                     persons, Former against Social, a person with an account listed once, the guild-scoped rule (an account that never touched the guild is not listed)
 *   tags, filters ... every where-from tag of a non-member, q (prefix over the name and the Main), rank, from
 *   sort, paging .... every column both ways, ties, a page boundary between the core (accounts, persons) and the names (no duplicate, no gap), counts
 *   last seen ....... attendance, sign-up (held raids only), loot, application (guild time zone), the sign-in term OFF, and the switch that turns it on
 *   page of a user .. an account, a person, a name; 404 for an unknown key, another guild's key, a person who has an account; blockedBy only for guild.access
 *   keep ............ happy path (blocked_by, own tombstones, off the teams, sign-ups withdrawn, audit, the review item drops), not senior, nothing pending, a lost race
 *   redaction ....... a Discord id, a Battle.net account id, a BattleTag, a Blizzard id, a token hash or a tombstone hash planted in the fixture is in no reply, for any principal
 *   budget .......... a 5,000-name fixture on a flipped in-game guild: statements per request, rows returned, EXPLAIN QUERY PLAN shows no scan of the evidence tables
 *   migration ....... 0038 adds two indexes and nothing else, and is safe to run twice
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');
const { load, runChecks, scenario: baseScenario } = require('../guild-b3-world');
const { newJar } = require('../guild-world');
const { flip, makeProven } = require('../guild-ingame');
const { scansSince, statementsSince, GUARDED_TABLES } = require('../guild-plans');
const { bigWorld: baseBigWorld } = require('../guild-users-fixture');

// The routes allow 30 requests a minute per user (review G3) and the fixtures below ask far more than that within a few simulated seconds, so a request of the helpers (s.call, s.ok)
// to the users routes starts with an empty window. The rate-limit check itself goes through s.w.call, which this leaves alone.
function unlimited(s) {
  const call = s.call.bind(s);
  s.call = (who, method, tail, body) => {
    if (/\/users(\/|\?|$)/.test(tail)) s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'users:%'");
    return call(who, method, tail, body);
  };
  return s;
}
const scenario = async (options) => unlimited(await baseScenario(options));
const bigWorld = async (options) => unlimited(await baseBigWorld(options));

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const KEY = 'test-tombstone-key-0123456789abcdef';
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Fixtures: rows written straight into the tables (the writers are other lanes' business)

const sql = (s) => s.w.db.sqlite;
const exec = (s, text, ...values) => sql(s).prepare(text).run(...values);
const rowsOf = (s, text, ...values) => sql(s).prepare(text).all(...values).map((row) => ({ ...row }));
let seq = 0;
const pad = (n, width = 18) => String(n).padStart(width, '0');

function addRaid(s, on, team = s.alpha) {
  const id = `r_Fix${pad(++seq)}`;
  exec(s, 'INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)', id, s.gid, team, on, Date.parse(`${on}T20:00:00Z`), `Raid ${on}`);
  return id;
}
function addLoot(s, raidId, name, team = s.alpha) {
  const n = ++seq;
  exec(s, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, winner_class, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 30001, 'Fixture Blade', 5, ?, ?, 'Nightslayer', 'nightslayer', 'WARRIOR', 'MS', 1, 1)`, `lo_Fix${pad(n)}`, s.gid, raidId, team, `fix${pad(n, 8)}`, name, name.toLowerCase());
}
function addPresence(s, raidId, name) {
  const n = ++seq;
  const code = `Rpt${pad(n, 13)}`;
  exec(s, "INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES (?, ?, ?, 'classic', 1, 2, 'Uploader', 3)", raidId, s.gid, code);
  exec(s, "INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 100, 'Boss', 1, 1, 2)", 5000 + n, raidId, code);
  exec(s, "INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'ROGUE')", 5000 + n, raidId, s.gid, name, name.toLowerCase());
}
function addSignup(s, raidId, { source = 'raidsmith', nickname = null, playerId = null, guest = 0, guestUserId = null, discordId = null, kind = 'signed' }) {
  exec(s, `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id, player_id, guest, guest_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1)`, raidId, source, ++seq, discordId, nickname, kind, s.gid, playerId, guest, guestUserId);
}
function addApplication(s, { name, userId = null, at = 1_790_000_000_000, team = s.alpha }) {
  exec(s, `INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, user_id, created_at, updated_at)
    VALUES (?, ?, ?, 'new', ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, ?, 1)`, `am_Fix${pad(++seq)}`, s.gid, team, name, name.toLowerCase(), userId, at);
}
const addManual = (s, raidId, name) => exec(s, "INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES (?, ?, ?, ?, 'Nightslayer', 'nightslayer')", raidId, s.gid, name, name.toLowerCase());
const markGuest = (s, name) => exec(s, "INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_at) VALUES (?, ?, 'nightslayer', ?, 1)", s.gid, name.toLowerCase(), name);
const attend = (s, raidId, team, playerId) => exec(s, "INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, attended) VALUES (?, ?, ?, ?, 'present', 1)", raidId, s.gid, team, playerId);
const leave = (s, characterId, on = '2026-12-01') => exec(s, "UPDATE characters SET left_on = ?, left_reason = 'left', core_rank = 'social' WHERE id = ?", on, characterId);
const pendingBlock = (s, key, at = 1_790_000_000_000) => exec(s, "INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES (?, ?, NULL, 'Matched an earlier block of the same person', ?, 1)", s.gid, s.uids[key], at);

// The guild of the segment checks (rank source NULL = legacy): the Guild Master is the Owner; an Officer and a Team Lead; members in the Discord server with and without a person;
// account-less persons (a member and a Former one); blocked accounts and a blocked person; outsiders that touched the guild; names that resolve to no character.
async function legacy() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  await s.lead('tl', [s.alpha], 'Teamlead');
  for (const [key, name] of [['m1', 'Memberone'], ['m2', 'Membertwo'], ['m3', 'Memberthree'], ['m4', 'Memberfour'], ['m5', 'Memberfive']]) await s.member(key, name);
  s.mone = await s.person({ name: 'Mone' });
  await s.link(s.mone.pid, 'm1');
  s.gonefast = await s.person({ name: 'Gonefast' });
  await s.link(s.gonefast.pid, 'm3');
  leave(s, s.gonefast.cid);
  s.ghost = await s.person({ name: 'Ghost' });
  s.leaver = await s.person({ name: 'Leaver' });
  leave(s, s.leaver.cid);
  await s.ok('off', 'POST', `/people/${s.uids.m4}/block`, { reason: 'Rude' }, 200);
  pendingBlock(s, 'm5');
  s.wanted = await s.person({ name: 'Wanted' });
  await s.ok('gm', 'POST', `/roster/${s.wanted.pid}/block`, { reason: 'Banned' }, 200);
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  await s.outsider('out3', 'Outsiderthree');
  s.r1 = addRaid(s, '2026-12-01');
  s.r2 = addRaid(s, '2026-12-08');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1, at: Date.parse('2026-12-05T12:00:00Z') });
  addSignup(s, s.r1, { guest: 1, nickname: 'Guestchar', guestUserId: s.uids.out2 });
  addLoot(s, s.r1, 'Lootguy');
  addPresence(s, s.r1, 'Logguy');
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Helperguy', discordId: '555000000000000001' });
  addSignup(s, s.r2, { guest: 1, nickname: 'Linkguest' });
  addApplication(s, { name: 'Hopeful', at: Date.parse('2026-12-03T12:00:00Z') });
  addManual(s, s.r2, 'Pasted');
  markGuest(s, 'Marked');
  return s;
}

const list = async (s, who, query = '', status = 200) => s.ok(who, 'GET', `/users${query ? `?${query}` : ''}`, undefined, status);
const names = (res) => res.rows.map((row) => row.name);
const byKind = (res, kind) => res.rows.filter((row) => row.kind === kind).map((row) => row.name);
const row = (res, name) => res.rows.find((entry) => entry.name === name);
// Every row of a segment (a page of 100 at a time).
async function all(s, who, query, { limit = 100 } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += limit) {
    const res = await list(s, who, `${query}&limit=${limit}&offset=${offset}`);
    rows.push(...res.rows);
    if (!res.more) return rows;
  }
}
const segmentOf = async (s, who, name) => {
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) if ((await all(s, who, `segment=${segment}`)).some((entry) => entry.name === name)) return segment;
  return null;
};

// ---------------------------------------------------------------------------
// The gate and the query string

check('gate: Officer and Guild Master read the list and a user page; a Team Lead, a plain Member, a custom role and a signed-out caller are refused', async () => {
  const s = await legacy();
  const key = (await list(s, 'gm')).rows[0].key;
  for (const who of ['gm', 'off']) {
    assert.equal((await s.call(who, 'GET', '/users')).status, 200, who);
    assert.equal((await s.call(who, 'GET', `/users/${key}`)).status, 200, who);
  }
  const role = await s.ok('gm', 'POST', '/roles', { name: 'Loot council', permissions: { 'loot.view': 'guild', 'roster.view': 'guild' } });
  const roleId = role.roles.find((entry) => entry.name === 'Loot council').id;
  await s.ok('gm', 'PUT', `/people/${s.uids.m2}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId, teamId: null }] }, 200);
  for (const who of ['tl', 'm1', 'm2']) {
    for (const tail of ['/users', `/users/${key}`]) {
      const res = await s.call(who, 'GET', tail);
      assert.equal(res.status, 403, `${who} ${tail}`);
      assert.equal(res.json.error, 'forbidden');
    }
  }
  const out = await s.w.call(newJar(), 'GET', `${s.base}/users`);
  assert.equal(out.status, 401);
  assert.equal((await s.w.call(newJar(), 'GET', `${s.base}/users/${key}`)).status, 401);
  // An account that is no member of the guild is refused by the guild check before the gate.
  assert.equal((await s.call('out3', 'GET', '/users')).status, 403);
});

check('gate: an Officer role edited to hold guild.roles WITHOUT guild.access still opens the list (the People gate), and then sees no blocker and no reason', async () => {
  const s = await legacy();
  const view = await s.ok('gm', 'GET', '/roles');
  const officer = view.roles.find((entry) => entry.id === 'officer');
  const permissions = { ...officer.permissions, 'guild.roles': 'guild' };
  delete permissions['guild.access'];
  await s.ok('gm', 'PUT', '/roles/officer', { permissions }, 200);
  const res = await s.call('off', 'GET', '/users?segment=blocked');
  assert.equal(res.status, 200, res.text);
  const blocked = res.json.rows.find((entry) => entry.name === 'Memberfour');
  assert(blocked, 'the blocked account is listed');
  const page = await s.ok('off', 'GET', `/users/${blocked.key}`);
  assert.equal(page.block.blocked, true);
  assert.equal(page.block.blockedBy, undefined, 'who blocked is an access decision');
  assert.equal(page.block.reason, undefined);
  const asGm = await s.ok('gm', 'GET', `/users/${blocked.key}`);
  assert.equal(asGm.block.blockedBy, 'Officer');
  assert.equal(asGm.block.reason, 'Rude');
});

check('query: segment, sort, dir, offset, limit, rank, from and q are checked, with the field named', async () => {
  const s = await legacy();
  const bad = async (query, field) => {
    const res = await s.call('gm', 'GET', `/users?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.json.error, 'bad_request');
    assert.equal(res.json.field, field, query);
  };
  await bad('segment=everyone', 'segment');
  await bad('sort=age', 'sort');
  await bad('dir=up', 'dir');
  await bad('offset=-1', 'offset');
  await bad('offset=5001', 'offset');
  await bad('offset=abc', 'offset');
  await bad('limit=0', 'limit');
  await bad('limit=101', 'limit');
  await bad('rank=king', 'rank');
  await bad('from=twitter', 'from');
  await bad(`q=${'x'.repeat(41)}`, 'q');
  const ok = await list(s, 'gm', 'segment=members&sort=lastSeen&dir=desc&offset=0&limit=100&rank=raider&q=ghost');
  assert.equal(ok.sort, 'lastSeen');
  assert.equal(ok.dir, 'desc');
  // The defaults: members, by user, ascending, 50 a page.
  const plain = await list(s, 'gm');
  assert.deepEqual([plain.segment, plain.sort, plain.dir], ['members', 'user', 'asc']);
  // A rank filter on non-members and a from filter on members are ignored, not refused.
  assert.equal((await list(s, 'gm', 'segment=nonmembers&rank=raider')).rows.length, (await list(s, 'gm', 'segment=nonmembers')).rows.length);
  assert.equal((await list(s, 'gm', 'segment=members&from=loot')).rows.length, (await list(s, 'gm', 'segment=members')).rows.length);
});

// ---------------------------------------------------------------------------
// Segments

check('segments of a legacy guild: members, former, blocked and non-members; accounts, account-less persons and names; the guild-scoped rule; a person with an account is one row', async () => {
  const s = await legacy();
  const members = await list(s, 'gm', 'segment=members');
  assert.deepEqual(names(members), ['Ghost', 'Gmb3', 'Memberone', 'Membertwo', 'Officer', 'Teamlead']);
  assert.deepEqual(members.rows.map((entry) => entry.kind), ['person', 'account', 'account', 'account', 'account', 'account']);
  // The Main of an account is its person's Main; an account with no person has none.
  assert.deepEqual(row(members, 'Memberone').main, { name: 'Mone', class: 'MAGE', realm: 'Nightslayer' });
  assert.equal(row(members, 'Membertwo').main, null);
  assert.deepEqual(row(members, 'Ghost').main, { name: 'Ghost', class: 'MAGE', realm: 'Nightslayer' });
  assert.equal(row(members, 'Ghost').permission, null);
  assert.equal(row(members, 'Gmb3').permission, 'Guild Master');
  assert.deepEqual(row(members, 'Gmb3').flags, { owner: true });
  assert.equal(row(members, 'Officer').permission, 'Officer');
  assert.equal(row(members, 'Teamlead').permission, 'Team Lead');
  assert.equal(row(members, 'Memberone').permission, null);
  // Mone is listed once, as the account.
  assert(!names(members).includes('Mone'));

  const former = await list(s, 'gm', 'segment=former');
  assert.deepEqual(names(former), ['Leaver', 'Memberthree']);
  assert.deepEqual(row(former, 'Memberthree').main, { name: 'Gonefast', class: 'MAGE', realm: 'Nightslayer' });
  assert.equal(row(former, 'Leaver').kind, 'person');

  const blocked = await list(s, 'gm', 'segment=blocked');
  assert.deepEqual(names(blocked), ['Memberfive', 'Memberfour', 'Wanted']);
  assert.deepEqual(row(blocked, 'Memberfive').flags, { pendingReview: true });
  assert.deepEqual(row(blocked, 'Memberfour').flags, {});
  assert.equal(row(blocked, 'Wanted').kind, 'person');

  const nonmembers = await list(s, 'gm', 'segment=nonmembers');
  // Outsiderone applied and Outsidertwo signed up as an open-raid guest: they are ACCOUNTS (the application and the guest sign-up belong to them), not names.
  assert.deepEqual(names(nonmembers), ['Helperguy', 'Hopeful', 'Linkguest', 'Logguy', 'Lootguy', 'Marked', 'Outsiderone', 'Outsidertwo', 'Pasted']);
  assert.deepEqual(nonmembers.rows.map((entry) => entry.kind), ['name', 'name', 'name', 'name', 'name', 'name', 'account', 'account', 'name']);
  assert(!JSON.stringify(nonmembers).includes('Outsiderthree'), 'an account that never touched the guild is not listed');
  assert.deepEqual(nonmembers.counts, { members: 6, former: 2, nonmembers: 9, blocked: 3 });
  assert.deepEqual(members.counts, nonmembers.counts);
  // A name row is a name: no Main, no permission, no flags.
  assert.deepEqual(row(nonmembers, 'Lootguy'), { key: row(nonmembers, 'Lootguy').key, kind: 'name', name: 'Lootguy', main: null, permission: null, lastSeen: '2026-12-01', tags: ['loot'], flags: {} });
  assert(row(nonmembers, 'Lootguy').key.startsWith('n_'));
});

check('segments: the rank source decides who a member is - legacy (Discord server or a link), manual (a link only, no Owner exemption), in-game (a person on the roster, or the live Owner)', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  // The viewer is an Officer with a person of their own, so they stay a member under every rule. linked = a person on the roster; server = in the Discord server only;
  // bare = a person whose character is NOT on the roster; owner = the seat holder with no person.
  await s.officer('viewer', 'Viewer');
  for (const [key, name] of [['linked', 'Linkedone'], ['server', 'Serveronly'], ['bare', 'Bareperson'], ['owner', 'Seatholder']]) await s.member(key, name);
  for (const [key, name, proof] of [['viewer', 'Viewerchar', true], ['linked', 'Linkedchar', true], ['bare', 'Barechar', false]]) {
    const made = await s.person({ name });
    await s.link(made.pid, key);
    if (key === 'viewer') s.viewerPerson = made;
    if (proof) makeProven(s, key, made, { rank: key === 'viewer' ? 1 : 5, proof: 'officer', link: false });
  }
  const names4 = ['Linkedone', 'Serveronly', 'Bareperson', 'Seatholder', 'Gmb3'];
  const segments = async () => Object.fromEntries(await Promise.all(names4.map(async (name) => [name, await segmentOf(s, 'viewer', name)])));
  assert.deepEqual(await segments(), { Linkedone: 'members', Serveronly: 'members', Bareperson: 'members', Seatholder: 'members', Gmb3: 'members' }, 'legacy: the Discord server, or a link');

  // Manual: the seat holder and the Guild Master hold roles and sit in the Discord server, but only a link lets anyone in.
  exec(s, "UPDATE guilds SET rank_source = 'manual', owner_user_id = ? WHERE id = ?", s.uids.owner, s.gid);
  assert.deepEqual(await segments(), { Linkedone: 'members', Serveronly: 'nonmembers', Bareperson: 'members', Seatholder: 'nonmembers', Gmb3: 'nonmembers' }, 'manual: a link only');
  const manual = await list(s, 'viewer', 'segment=nonmembers&limit=100');
  assert.deepEqual(row(manual, 'Serveronly').tags, ['discord_signin'], 'in the guild\'s Discord server and no member: a Discord sign-in');
  assert.deepEqual(row(manual, 'Seatholder').flags, { owner: true }, 'the Owner row of the view says so even where the Owner is no member');
  assert.equal(row(manual, 'Seatholder').permission, 'Guild Master');
  assert.equal(row(manual, 'Gmb3').permission, null, 'a stored Guild Master role grants nothing once the guild has a rank source');

  // In-game: the roster decides, and the viewer holds the seat with a Battle.net-proven character on it. The accounts are the same.
  makeProven(s, 'viewer', s.viewerPerson, { rank: 4 });
  flip(s, { owner: 'viewer' });
  assert.deepEqual(await segments(), { Linkedone: 'members', Serveronly: 'nonmembers', Bareperson: 'nonmembers', Seatholder: 'nonmembers', Gmb3: 'nonmembers' }, 'in-game: only a person on the roster');
  assert.deepEqual(row(await list(s, 'viewer', 'segment=members'), 'Viewer').flags, { owner: true });
  assert.equal(row(await list(s, 'viewer', 'segment=nonmembers&limit=100'), 'Seatholder').permission, null, 'the old seat holder lost it: no Owner row, no role');
});

check('segments: the live Owner of an in-game guild is a member and flagged, a SUSPENDED Owner is flagged and a member only through a roster character of their own', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.member('dgm', 'Derivedgm');
  await s.member('own', 'Seatholder');
  const dgm = await s.person({ name: 'Dgmchar' });
  await s.link(dgm.pid, 'dgm');
  makeProven(s, 'dgm', dgm, { rank: 0 });
  const own = await s.person({ name: 'Ownchar' });
  await s.link(own.pid, 'own');
  makeProven(s, 'own', own, { rank: 4 });
  flip(s, { owner: 'own' });
  const view = async (query) => list(s, 'dgm', query);
  let members = await view('segment=members');
  assert.deepEqual(row(members, 'Seatholder').flags, { owner: true });
  assert.equal(row(members, 'Seatholder').permission, 'Guild Master');
  assert.deepEqual(row(members, 'Derivedgm').flags, {}, 'a derived Guild Master is no Owner');
  assert.equal(row(members, 'Derivedgm').permission, 'Guild Master');
  // Suspended: the proof stops being a Battle.net proof. The character is still on the roster, so the account is still a member, as a suspended Owner is, with no role.
  exec(s, "UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = ?", own.cid);
  members = await view('segment=members');
  assert.deepEqual(row(members, 'Seatholder').flags, { suspended: true });
  assert.equal(row(members, 'Seatholder').permission, null);
  // The character leaves the roster: no member any more; the flag stays.
  exec(s, 'DELETE FROM guild_roster WHERE guild_id = ? AND blizzard_char_id = (SELECT blizzard_char_id FROM characters WHERE id = ?)', s.gid, own.cid);
  assert.equal(await segmentOf(s, 'dgm', 'Seatholder'), 'nonmembers');
  assert.deepEqual(row(await view('segment=nonmembers'), 'Seatholder').flags, { suspended: true });
  // A block on a live Owner is ignored (they are no blocked account); on a suspended one it counts.
  exec(s, "INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES (?, ?, NULL, 'x', 1, 0)", s.gid, s.uids.own);
  assert.equal(await segmentOf(s, 'dgm', 'Seatholder'), 'blocked');
  makeProven(s, 'own', own, { rank: 4, id: 9300 });
  exec(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = ?) WHERE id = ?", s.uids.own, s.uids.own, own.cid);
  assert.equal(await segmentOf(s, 'dgm', 'Seatholder'), 'members', 'live again: the block row is ignored');
});

check('segments: Former against Social - a Social character on the roster is a member; only a person whose characters have ALL left is Former; one character that left among others is not', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  const mk = async (key, name, rank, charName) => {
    await s.member(key, name);
    const made = await s.person({ name: charName });
    await s.link(made.pid, key);
    makeProven(s, key, made, { rank, proof: 'officer', link: false });
    return made;
  };
  const social = await mk('soc', 'Socialite', 5, 'Socialchar');
  exec(s, "UPDATE characters SET core_rank = 'social' WHERE id = ?", social.cid);
  const both = await mk('both', 'Bothchars', 4, 'Bothmain');
  const alt = await s.alt(both.pid, 'Bothalt');
  exec(s, 'UPDATE characters SET left_on = ? WHERE id = ?', '2026-12-01', alt);
  const left = await mk('left', 'Leftguild', 4, 'Leftmain');
  leave(s, left.cid);
  const everyone = await mk('every', 'Everyonegone', 4, 'Everymain');
  const alt2 = await s.alt(everyone.pid, 'Everyalt');
  leave(s, everyone.cid);
  leave(s, alt2, '2026-12-05');
  makeProven(s, 'gm', await (async () => { const g = await s.person({ name: 'Gmchar' }); await s.link(g.pid, 'gm'); return g; })(), { rank: 4 });
  flip(s, { owner: 'gm' });
  assert.equal(await segmentOf(s, 'gm', 'Socialite'), 'members');
  assert.equal(await segmentOf(s, 'gm', 'Bothchars'), 'members');
  assert.equal(await segmentOf(s, 'gm', 'Leftguild'), 'former');
  assert.equal(await segmentOf(s, 'gm', 'Everyonegone'), 'former');
  const former = await list(s, 'gm', 'segment=former');
  assert.deepEqual(row(former, 'Leftguild').main, { name: 'Leftmain', class: 'MAGE', realm: 'Nightslayer' });
  // The rank filter looks at the Main's core rank: the Social main is found under social and not under raider.
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&rank=social')), ['Socialite']);
  assert(!names(await list(s, 'gm', 'segment=members&rank=raider')).includes('Socialite'));
  assert.deepEqual(names(await list(s, 'gm', 'segment=former&rank=social')), ['Everyonegone', 'Leftguild']);
});

check('segments: a derived Guild Master is no Owner (permission yes, owner flag no); an account-less person off the in-game roster is a non-member, on it a member', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.member('dgm', 'Derivedgm');
  const dgm = await s.person({ name: 'Dgmchar' });
  await s.link(dgm.pid, 'dgm');
  makeProven(s, 'dgm', dgm, { rank: 0 });
  const owner = await s.person({ name: 'Ownchar' });
  await s.link(owner.pid, 'gm');
  makeProven(s, 'gm', owner, { rank: 4 });
  const onRoster = await s.person({ name: 'Onroster' });
  makeProven(s, 'gm', onRoster, { rank: 5, proof: 'officer', link: false, id: 7771 });
  await s.person({ name: 'Offroster' });
  flip(s, { owner: 'gm' });
  const members = await list(s, 'gm', 'segment=members');
  assert.deepEqual(row(members, 'Derivedgm').flags, {});
  assert.equal(row(members, 'Derivedgm').permission, 'Guild Master');
  assert.deepEqual(row(members, 'Gmb3').flags, { owner: true });
  assert.deepEqual(byKind(members, 'person'), ['Onroster'], 'the person on the roster is a member');
  assert.deepEqual(byKind(await list(s, 'gm', 'segment=nonmembers'), 'person'), ['Offroster'], 'the person off the roster is not');
});

// ---------------------------------------------------------------------------
// Tags and filters

check('tags: every where-from tag of a non-member - Discord sign-in, application, guest sign-up, Raid-Helper, raid log, loot - on accounts and on names', async () => {
  const s = await legacy();
  // Discord sign-in: in manual guilds the server grants nothing, so a server member that is not linked is a sign-in. Raid-Helper: a sign-up that names no person but carries
  // the Discord id of an account belongs to the account.
  const viewer = await s.person({ name: 'Viewerchar' });
  await s.link(viewer.pid, 'off');
  exec(s, "UPDATE guilds SET rank_source = 'manual' WHERE id = ?", s.gid);
  exec(s, "UPDATE users SET discord_id = '555000000000000009' WHERE id = ?", s.uids.out3);
  addSignup(s, s.r2, { source: 'raid_helper', nickname: 'Outsiderthree', discordId: '555000000000000009' });
  // One name seen in four places: loot, the raid log, a Raid-Helper sign-up, an application.
  addLoot(s, s.r1, 'Doublename');
  addPresence(s, s.r2, 'Doublename');
  addSignup(s, s.r2, { source: 'raid_helper', nickname: 'Doublename', discordId: '555000000000000002' });
  addApplication(s, { name: 'Doublename', at: Date.parse('2026-12-10T12:00:00Z') });
  const res = await list(s, 'off', 'segment=nonmembers&limit=100');
  const tags = Object.fromEntries(res.rows.map((entry) => [entry.name, entry.tags]));
  assert.deepEqual(tags.Outsiderone, ['application']);
  assert.deepEqual(tags.Outsidertwo, ['guest_signup']);
  assert.deepEqual(tags.Outsiderthree, ['raid_helper'], 'the Raid-Helper sign-up belongs to the account that holds the Discord id (no name row of its own)');
  assert.equal(res.rows.filter((entry) => entry.name === 'Outsiderthree').length, 1);
  assert.deepEqual(tags.Lootguy, ['loot']);
  assert.deepEqual(tags.Logguy, ['raid_log']);
  assert.deepEqual(tags.Helperguy, ['raid_helper']);
  assert.deepEqual(tags.Linkguest, ['guest_signup']);
  assert.deepEqual(tags.Hopeful, ['application']);
  assert.deepEqual(tags.Pasted, ['raid_log']);
  assert.deepEqual(tags.Marked, ['raid_log']);
  assert.deepEqual(tags.Doublename, ['application', 'raid_helper', 'raid_log', 'loot'], 'a name seen in several places is ONE row with every tag');
  assert.equal(res.rows.filter((entry) => entry.name === 'Doublename').length, 1);
  assert.equal(row(res, 'Doublename').lastSeen, '2026-12-10', 'the newest of its sightings');
  // The Discord sign-in: server members who are not linked (manual guild).
  assert.deepEqual(tags.Membertwo, ['discord_signin']);
  assert.equal(tags.Memberone, undefined, 'linked to a person: a member of a manual guild, not a sign-in');
  assert.equal(tags.Officer, undefined);
});

check('filters: from keeps the rows carrying that tag (and shows all their tags), q is a case-insensitive prefix over the user name and the Main, rank filters by the Main\'s core rank', async () => {
  const s = await legacy();
  addLoot(s, s.r1, 'Doublename');
  addPresence(s, s.r2, 'Doublename');
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&from=loot&limit=100')), ['Doublename', 'Lootguy']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&from=raid_log&limit=100')), ['Doublename', 'Logguy', 'Marked', 'Pasted']);
  assert.deepEqual(row(await list(s, 'gm', 'segment=nonmembers&from=loot'), 'Doublename').tags, ['raid_log', 'loot']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&from=application')), ['Hopeful', 'Outsiderone']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&from=guest_signup&limit=100')), ['Linkguest', 'Outsidertwo']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&from=raid_helper')), ['Helperguy']);
  // q: the user name, the Main's name, any case; % and _ are literal.
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=MEMBER')), ['Memberone', 'Membertwo']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=mon')), ['Memberone'], 'Mone is the Main of Memberone');
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=gho')), ['Ghost']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=host')), [], 'a prefix, not a substring');
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=%25')), [], 'a % is a character');
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&q=_')), []);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&q=loot')), ['Lootguy']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=nonmembers&q=LOOT&from=raid_log')), []);
  // rank: the Main's core rank (raider is the default of a new person).
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&rank=raider')), ['Ghost', 'Memberone']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&rank=trial')), []);
  exec(s, "UPDATE characters SET core_rank = 'trial' WHERE id = ?", s.mone.cid);
  assert.deepEqual(names(await list(s, 'gm', 'segment=members&rank=trial')), ['Memberone']);
  assert.deepEqual(names(await list(s, 'gm', 'segment=former&rank=social')), ['Leaver', 'Memberthree']);
});

// ---------------------------------------------------------------------------
// Sorting and paging

const PERMISSION_ORDER = { 'Guild Master': 0, Officer: 1, 'Team Lead': 2 };
// The documented order, from the rows themselves: the sort value (NULL last), the name, the kind (account, person, name), the key.
function expectedOrder(rows, sort, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  const kindOrder = { account: 0, person: 1, name: 2 };
  const value = (entry) => {
    if (sort === 'user') return entry.name.toLowerCase();
    if (sort === 'main') return entry.main ? entry.main.name.toLowerCase() : null;
    if (sort === 'lastSeen') return entry.lastSeen;
    return entry.permission === null ? 4 : PERMISSION_ORDER[entry.permission] ?? 3;
  };
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== y) return (x < y ? -1 : 1) * sign;
    if (sort === 'permission' && a.permission !== b.permission && a.permission && b.permission) return (a.permission.toLowerCase() < b.permission.toLowerCase() ? -1 : 1) * sign;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : (kindOrder[a.kind] - kindOrder[b.kind]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }).map((entry) => entry.key);
}

check('sort and paging: every column both ways, in the documented order; a page boundary anywhere (core and names alike) loses no row and repeats none; the counts add up', async () => {
  const s = await bigWorld({ scale: 0.06, other: 20 });
  const segments = { members: s.expected.members, former: s.expected.former, nonmembers: s.expected.nonmembers, blocked: s.expected.blocked };
  for (const [segment, total] of Object.entries(segments)) {
    for (const sort of ['user', 'main', 'permission', 'lastSeen']) {
      for (const dir of ['asc', 'desc']) {
        const base = `segment=${segment}&sort=${sort}&dir=${dir}`;
        const whole = await all(s, 'own', base);
        assert.equal(whole.length, total, `${base}: every row once`);
        assert.equal(new Set(whole.map((entry) => entry.key)).size, total, `${base}: no duplicate`);
        assert.deepEqual(whole.map((entry) => entry.key), expectedOrder(whole, sort, dir), `${base}: the documented order`);
        // A small page size that puts the boundaries in odd places (the names start somewhere inside a page of non-members).
        const pieces = await all(s, 'own', base, { limit: 7 });
        assert.deepEqual(pieces.map((entry) => entry.key), whole.map((entry) => entry.key), `${base}: pages of 7 equal the whole list`);
      }
    }
  }
  const counts = (await list(s, 'own')).counts;
  assert.deepEqual(counts, segments);
});

check('sort: ties are stable - members with no permission, no Main or the same date keep one order, and the order is the same on every page', async () => {
  const s = await bigWorld({ scale: 0.06, other: 20 });
  for (const sort of ['permission', 'main', 'lastSeen']) {
    const first = await all(s, 'own', `segment=members&sort=${sort}&dir=asc`);
    const second = await all(s, 'own', `segment=members&sort=${sort}&dir=asc`, { limit: 13 });
    assert.deepEqual(first.map((entry) => entry.key), second.map((entry) => entry.key));
  }
  // Descending is the sort value reversed with the tie-break still ascending, and a row with no value stays LAST both ways.
  const asc = await all(s, 'own', 'segment=members&sort=main&dir=asc');
  const desc = await all(s, 'own', 'segment=members&sort=main&dir=desc');
  const without = asc.filter((entry) => entry.main === null).length;
  assert(without > 0, 'the fixture has members with no Main');
  assert.equal(asc.slice(asc.length - without).every((entry) => entry.main === null), true);
  assert.equal(desc.slice(desc.length - without).every((entry) => entry.main === null), true);
  const permission = await all(s, 'own', 'segment=members&sort=permission&dir=asc');
  assert.equal(permission[0].permission, 'Guild Master');
  assert.equal(permission[permission.length - 1].permission, null);
  const reversed = await all(s, 'own', 'segment=members&sort=permission&dir=desc');
  assert.equal(reversed[0].permission, null, 'descending puts None first: the permission scale is reversed, None is a value');
});

// ---------------------------------------------------------------------------
// Last seen

check('last seen: attendance, a sign-up on a raid that has been held, loot and an application each date a row; a future sign-up and the sign-in do not; the date is the guild\'s', async () => {
  const s = await legacy();
  const { LAST_SEEN_INCLUDES_SIGN_IN } = await load('worker/users-list.js');
  assert.equal(LAST_SEEN_INCLUDES_SIGN_IN, false, 'plan v9: never the account-wide sign-in (the user\'s H-Q36 says including it: an open decision)');
  const get = async (name, query = 'segment=members') => row(await list(s, 'gm', `${query}&limit=100`), name);
  assert.equal((await get('Memberone')).lastSeen, null, 'nothing yet: a dash');
  // Attendance: only when the person attended.
  attend(s, s.r1, s.alpha, s.mone.pid);
  assert.equal((await get('Memberone')).lastSeen, '2026-12-01');
  // A sign-up on a held raid counts; the person's own sign-up on a raid in the future does not.
  addSignup(s, s.r2, { playerId: s.mone.pid, kind: 'late' });
  assert.equal((await get('Memberone')).lastSeen, '2026-12-08');
  const future = addRaid(s, '2027-02-01');
  addSignup(s, future, { playerId: s.mone.pid });
  assert.equal((await get('Memberone')).lastSeen, '2026-12-08', 'a raid that has not been held is not a sighting');
  // Loot on the person's character.
  const later = addRaid(s, '2027-01-10');
  addLoot(s, later, 'Mone');
  assert.equal((await get('Memberone')).lastSeen, '2027-01-10');
  // The sign-in is NOT a term: touching last_seen_at changes nothing.
  exec(s, 'UPDATE users SET last_seen_at = ? WHERE id = ?', Date.parse('2027-01-14T12:00:00Z'), s.uids.m1);
  assert.equal((await get('Memberone')).lastSeen, '2027-01-10');
  // An account-less person: attendance, sign-up and loot, never an account's facts.
  attend(s, s.r2, s.alpha, s.ghost.pid);
  assert.equal((await get('Ghost')).lastSeen, '2026-12-08');
  // An application is dated in the guild's zone (New York): 02:00 UTC is still the evening before.
  addApplication(s, { name: 'Lateapp', userId: s.uids.out3, at: Date.parse('2027-01-15T02:00:00Z') });
  assert.equal((await get('Outsiderthree', 'segment=nonmembers')).lastSeen, '2027-01-14');
  // A name: the loot, the log and a held sign-up date it, the newest wins; a guest sign-up on a future raid has no date.
  assert.equal((await get('Lootguy', 'segment=nonmembers')).lastSeen, '2026-12-01');
  addSignup(s, future, { guest: 1, nickname: 'Futureguest' });
  assert.equal((await get('Futureguest', 'segment=nonmembers')).lastSeen, null);
  // Sorting by last seen puts rows without a date last in both directions.
  for (const dir of ['asc', 'desc']) {
    const rows = (await list(s, 'gm', `segment=members&sort=lastSeen&dir=${dir}&limit=100`)).rows;
    assert.equal(rows[rows.length - 1].lastSeen, null, dir);
    assert.notEqual(rows[0].lastSeen, null, dir);
  }
  assert.deepEqual((await list(s, 'gm', 'segment=members&sort=lastSeen&dir=desc')).rows.slice(0, 2).map((entry) => entry.name), ['Memberone', 'Ghost']);
});

check('last seen: the sign-in is ONE isolated term, off by constant and switchable - with it on, the newest of the sign-in and the raid-level facts wins (date only, guild zone)', async () => {
  const s = await legacy();
  const { listUsers, parseUsersQuery } = await load('worker/users-list.js');
  const { loadGuildContext } = await load('worker/permissions.js');
  attend(s, s.r1, s.alpha, s.mone.pid);
  exec(s, 'UPDATE users SET last_seen_at = ? WHERE id = ?', Date.parse('2027-01-14T03:30:00Z'), s.uids.m1); // 22:30 on the 13th in New York
  const guildContext = await loadGuildContext(s.w.db, s.uids.gm, s.gid);
  const ctx = { db: s.w.db, now: () => s.w.clock.now };
  const query = parseUsersQuery(new URLSearchParams('segment=members&sort=lastSeen&limit=100'));
  const off = await listUsers(ctx, guildContext, query);
  const on = await listUsers(ctx, guildContext, query, { signIn: true });
  const dateOf = (res, name) => res.rows.find((entry) => entry.name === name).lastSeen;
  assert.equal(dateOf(off, 'Memberone'), '2026-12-01');
  assert.equal(dateOf(on, 'Memberone'), '2027-01-13', 'the sign-in, in the guild\'s zone');
  assert.equal(dateOf(on, 'Membertwo'), dateOf(off, 'Membertwo') === null ? dateOf(on, 'Membertwo') : null);
  // The page of a user follows the same switch.
  const { loadUserDetail } = await load('worker/users-detail.js');
  assert.equal((await loadUserDetail(ctx, guildContext, s.uids.m1)).lastSeen, '2026-12-01');
  assert.equal((await loadUserDetail(ctx, guildContext, s.uids.m1, { signIn: true })).lastSeen, '2027-01-13');
});

// ---------------------------------------------------------------------------
// The rate limit

check('rate limit: a per-user limit on the list and the user page (one key), 429 rate_limited with Retry-After; another user and the next window are not affected', async () => {
  const s = await legacy();
  const { USERS_LIMIT, USERS_WINDOW_MS } = await load('worker/ratelimit.js');
  assert(USERS_LIMIT >= 30 && USERS_LIMIT <= 60 && USERS_WINDOW_MS === 60_000, 'a person paging and sorting (a request every two seconds) never hits it; a script that walks the list does');
  const key = (await list(s, 'gm')).rows[0].key;
  let last;
  // The legacy() setup already used some of the window; count what is left by asking until it refuses (the clock stands still).
  let served = 0;
  for (; served < USERS_LIMIT + 5; served++) {
    last = await s.w.call(s.jars.gm, 'GET', `${s.base}/${served % 2 ? `users/${key}` : 'users'}`);
    if (last.status === 429) break;
    assert.equal(last.status, 200, last.text);
  }
  assert(served > USERS_LIMIT - 5 && served <= USERS_LIMIT, `refused after ${served} requests`);
  assert.equal(last.status, 429);
  assert.equal(last.json.error, 'rate_limited');
  assert(Number(last.headers.get('Retry-After')) >= 1);
  // The same key serves both routes (the loop alternated them), and another user has a window of their own.
  assert.equal((await s.w.call(s.jars.off, 'GET', `${s.base}/users`)).status, 200);
  s.w.advance(USERS_WINDOW_MS + 1000);
  assert.equal((await s.w.call(s.jars.gm, 'GET', `${s.base}/users`)).status, 200);
  // A refusal for lack of permission does not count; neither does a bad query.
  s.w.advance(USERS_WINDOW_MS + 1000);
  for (let i = 0; i < USERS_LIMIT + 5; i++) assert.equal((await s.w.call(s.jars.m1, 'GET', `${s.base}/users`)).status, 403);
  assert.equal((await s.w.call(s.jars.m1, 'GET', `${s.base}/users`)).status, 403);
});

// ---------------------------------------------------------------------------
// The page of one user

// A second guild on the same world (its own server), for the "another guild's key" checks: one account, one person, one loot-only name, one application.
async function otherGuild(s) {
  const { adminOf, memberOf, signIn, person } = require('../guild-world');
  const server = '900000000000000092';
  const gm = (await signIn(s.w, person(51, 'Otherowner'), [adminOf(server)])).jar;
  const made = await s.w.call(gm, 'POST', '/api/guild', { serverId: server, name: 'Other guild', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const team = made.json.teams[0].id;
  const member = (await signIn(s.w, person(52, 'Othermember'), [memberOf(server)])).jar;
  const uid = (await s.w.call(member, 'GET', '/auth/me')).json.user.id;
  const added = await s.w.call(gm, 'POST', `/api/guild/${gid}/roster`, { teamId: team, name: 'Otherperson', class: 'MAGE', mainSpec: 'Fire', offSpec: null });
  assert.equal(added.status, 201, added.text);
  const other = { w: s.w, gid, alpha: team, jars: { gm, member }, uid, pid: added.json.person.id };
  const raid = addRaid(other, '2026-12-02');
  addLoot(other, raid, 'Otherloot');
  addApplication(other, { name: 'Otherhopeful' });
  return other;
}
const nameKeyOf = (name) => `n_${Buffer.from(name.toLowerCase(), 'utf8').toString('hex')}`;

check('page of a user: an account (identity, characters, roles, last seen), an account-less person, and a name with its sightings', async () => {
  const s = await legacy();
  // m1: Discord and Battle.net, a person with a Main on Alpha and an alt, attendance on a raid.
  await s.alt(s.mone.pid, 'Monealt');
  exec(s, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, '777000111', 'Memberone#9999', 1, '{}', 1)", s.uids.m1);
  attend(s, s.r1, s.alpha, s.mone.pid);
  const key = row(await list(s, 'gm', 'segment=members'), 'Memberone').key;
  const page = await s.ok('gm', 'GET', `/users/${key}`);
  assert.deepEqual(Object.keys(page).sort(), ['block', 'characters', 'flags', 'identity', 'key', 'kind', 'lastSeen', 'main', 'name', 'permission', 'permissions', 'segment', 'sightings', 'tags']);
  assert.deepEqual([page.key, page.kind, page.segment, page.name], [key, 'account', 'members', 'Memberone']);
  assert.deepEqual(page.identity, { account: { displayName: 'Memberone' }, battlenet: true, signInMethods: ['discord', 'battlenet'] });
  assert.deepEqual(page.main, { name: 'Mone', class: 'MAGE', realm: 'Nightslayer' });
  assert.deepEqual(page.characters.map((entry) => [entry.name, entry.isMain, entry.coreRank, entry.former, entry.team && entry.team.name]), [['Mone', true, 'raider', false, 'Alpha'], ['Monealt', false, 'raider', false, null]]);
  assert.deepEqual(Object.keys(page.characters[0]).sort(), ['class', 'coreRank', 'former', 'ingameRank', 'isMain', 'leftOn', 'name', 'realm', 'team']);
  assert.equal(page.characters[0].ingameRank, null, 'not on an in-game roster');
  assert.equal(page.lastSeen, '2026-12-01');
  assert.deepEqual(page.permissions, []);
  assert.deepEqual(page.block, { blocked: false, pendingReview: false, blockedOn: null });
  assert.deepEqual([page.tags, page.sightings, page.flags], [[], [], {}]);

  const officer = await s.ok('gm', 'GET', `/users/${row(await list(s, 'gm', 'segment=members'), 'Officer').key}`);
  assert.deepEqual(officer.permissions, [{ role: 'officer', label: 'Officer', sources: ['manual'] }]);
  assert.equal(officer.permission, 'Officer');
  assert.deepEqual(officer.identity, { account: { displayName: 'Officer' }, battlenet: false, signInMethods: ['discord'] });
  const lead = await s.ok('gm', 'GET', `/users/${row(await list(s, 'gm', 'segment=members'), 'Teamlead').key}`);
  assert.deepEqual(lead.permissions, [{ role: 'team_lead', label: 'Team Lead', teamId: s.alpha, teamName: 'Alpha', sources: ['manual'] }]);
  const owner = await s.ok('gm', 'GET', `/users/${row(await list(s, 'gm', 'segment=members'), 'Gmb3').key}`);
  assert.deepEqual(owner.permissions, [{ role: 'guild_master', label: 'Guild Master', sources: ['manual', 'owner'] }]);
  assert.deepEqual(owner.flags, { owner: true });

  // An account-less person.
  const ghost = await s.ok('gm', 'GET', `/users/${s.ghost.pid}`);
  assert.deepEqual([ghost.kind, ghost.segment, ghost.name, ghost.permission, ghost.permissions], ['person', 'members', 'Ghost', null, []]);
  assert.deepEqual(ghost.identity, { account: null, battlenet: false, signInMethods: [] });
  assert.equal(ghost.characters.length, 1);
  const leaver = await s.ok('gm', 'GET', `/users/${s.leaver.pid}`);
  assert.deepEqual([leaver.segment, leaver.characters[0].former, leaver.characters[0].leftOn], ['former', true, '2026-12-01']);

  // A name seen in four places: every sighting, newest first, each with its source.
  addLoot(s, s.r1, 'Doublename');
  addPresence(s, s.r2, 'Doublename');
  addApplication(s, { name: 'Doublename', at: Date.parse('2026-12-10T12:00:00Z') });
  addSignup(s, s.r2, { source: 'raid_helper', nickname: 'Doublename', discordId: '555000000000000003' });
  const name = await s.ok('gm', 'GET', `/users/${nameKeyOf('Doublename')}`);
  assert.deepEqual([name.kind, name.segment, name.name, name.key], ['name', 'nonmembers', 'Doublename', nameKeyOf('Doublename')]);
  assert.deepEqual(name.tags, ['application', 'raid_helper', 'raid_log', 'loot']);
  assert.deepEqual(name.sightings.map((entry) => [entry.source, entry.date]), [['application', '2026-12-10'], ['raid_helper', '2026-12-08'], ['raid_log', '2026-12-08'], ['loot', '2026-12-01']]);
  assert.equal(name.sightings[3].detail, 'Fixture Blade');
  assert.equal(name.sightings[1].detail, 'Raid 2026-12-08');
  assert.equal(name.lastSeen, '2026-12-10');
  assert.deepEqual([name.main, name.permission, name.characters, name.identity.account], [null, null, [], null]);
  // The same list row answers the same key.
  assert.equal(row(await list(s, 'gm', 'segment=nonmembers&q=doublename'), 'Doublename').key, name.key);
  // Sightings are capped per source.
  for (let i = 0; i < 14; i++) addLoot(s, addRaid(s, `2026-11-${String(i + 1).padStart(2, '0')}`), 'Lootguy');
  const capped = await s.ok('gm', 'GET', `/users/${nameKeyOf('Lootguy')}`);
  assert.equal(capped.sightings.length, 10);
  assert.equal(capped.sightings[0].date, '2026-12-01');
});

check('page of a user: non-member accounts show their where-from tags and sightings; a blocked account its block (blocked on, pending review, the blocker); a blocked person too', async () => {
  const s = await legacy();
  const one = await s.ok('gm', 'GET', `/users/${s.uids.out1}`);
  assert.deepEqual([one.segment, one.tags, one.sightings], ['nonmembers', ['application'], [{ source: 'application', date: '2026-12-05', detail: null }]]);
  assert.equal(one.lastSeen, '2026-12-05');
  const two = await s.ok('gm', 'GET', `/users/${s.uids.out2}`);
  assert.deepEqual([two.tags, two.sightings], [['guest_signup'], [{ source: 'guest_signup', date: '2026-12-01', detail: 'Raid 2026-12-01' }]]);
  const blocked = await s.ok('gm', 'GET', `/users/${s.uids.m4}`);
  assert.equal(blocked.segment, 'blocked');
  assert.deepEqual(blocked.block, { blocked: true, pendingReview: false, blockedOn: blocked.block.blockedOn, reason: 'Rude', blockedBy: 'Officer' });
  assert.match(blocked.block.blockedOn, /^\d{4}-\d{2}-\d{2}$/);
  const pending = await s.ok('gm', 'GET', `/users/${s.uids.m5}`);
  assert.deepEqual(pending.block, { blocked: true, pendingReview: true, blockedOn: '2026-09-21', reason: 'Matched an earlier block of the same person' });
  assert.deepEqual(pending.flags, { pendingReview: true });
  assert.equal(pending.block.blockedBy, undefined, 'a tombstone match has no blocker');
  const wanted = await s.ok('gm', 'GET', `/users/${s.wanted.pid}`);
  assert.deepEqual([wanted.kind, wanted.segment, wanted.block.blocked, wanted.block.blockedBy, wanted.block.reason], ['person', 'blocked', true, 'Gmb3', 'Banned']);
  assert.deepEqual(wanted.tags, []);
});

check('page of a user: 404 for an unknown key, a malformed key, another guild\'s account, person or name, a person who has an account and a name that is on the roster', async () => {
  const s = await legacy();
  const other = await otherGuild(s);
  const fail = async (key, label) => {
    const res = await s.call('gm', 'GET', `/users/${key}`);
    assert.equal(res.status, 404, `${label}: ${res.text}`);
    assert.equal(res.json.error, 'not_found');
    for (const word of ['Othermember', 'Otherperson', 'Otherloot', 'Other guild']) assert(!res.text.includes(word), `${label}: ${word}`);
  };
  await fail(`u_${'A'.repeat(22)}`, 'an unknown account');
  await fail(`p_${'A'.repeat(22)}`, 'an unknown person');
  await fail(other.uid, 'an account of another guild');
  await fail(other.pid, 'a person of another guild');
  await fail(nameKeyOf('Otherloot'), 'a name seen in another guild only');
  await fail(nameKeyOf('Nobodyatall'), 'a name never seen');
  await fail(nameKeyOf('Mone'), 'a name that is a character of the roster');
  await fail(s.mone.pid, 'a person who has an account: the page is the account\'s');
  await fail(s.uids.out3, 'an account that never touched the guild');
  await fail('n_zz', 'not hex');
  await fail('n_', 'empty');
  await fail('n_c3', 'bytes that are no UTF-8');
  await fail(`n_${'61'.repeat(300)}`, 'too long');
  await fail('x_abc', 'no such kind');
  await fail('U_AAAAAAAAAAAAAAAAAAAAAA', 'wrong case of the prefix');
  // The other guild's own key works there, for its own owner, and not here.
  assert.equal((await s.w.call(other.jars.gm, 'GET', `/api/guild/${other.gid}/users/${other.uid}`)).status, 200);
  assert.equal((await s.w.call(other.jars.gm, 'GET', `/api/guild/${other.gid}/users/${nameKeyOf('Otherloot')}`)).status, 200);
  assert.equal((await s.w.call(other.jars.gm, 'GET', `/api/guild/${other.gid}/users/${s.uids.m1}`)).status, 404);
  // And the list of one guild never carries the other's people.
  const text = JSON.stringify([await list(s, 'gm', 'segment=members'), await list(s, 'gm', 'segment=nonmembers&limit=100')]);
  for (const word of ['Othermember', 'Otherperson', 'Otherloot', 'Otherhopeful']) assert(!text.includes(word), word);
});

check('keys: every key is an account id, a person id or "n_" and hex; none carries a Discord id, a Battle.net account id or a BattleTag, and a page carries none either', async () => {
  const s = await legacy();
  exec(s, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, '777000111', 'Sentineltag#9999', 1, '{}', 1)", s.uids.m1);
  const secrets = [...rowsOf(s, 'SELECT discord_id FROM users WHERE discord_id IS NOT NULL').map((entry) => entry.discord_id), '777000111', 'Sentineltag', '9999', '555000000000000001'];
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) {
    for (const entry of await all(s, 'gm', `segment=${segment}`)) {
      assert.match(entry.key, /^(?:[up]_[A-Za-z0-9_-]{22}|n_[0-9a-f]+)$/);
      for (const secret of secrets) assert(!entry.key.includes(secret), `${entry.key} carries ${secret}`);
      const page = await s.call('gm', 'GET', `/users/${entry.key}`);
      assert.equal(page.status, 200, `${entry.key}: ${page.text}`);
      for (const secret of secrets) assert(!page.text.includes(secret), `the page of ${entry.name} carries ${secret}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Keep

// A guild with two pending-review blocks on members who sit on a team and are signed up for a raid that has not started, two Officers and a Team Lead.
async function keepWorld(env) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: env === undefined ? { TOMBSTONE_KEY: KEY } : env });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  await s.officer('off2', 'Officertwo');
  await s.lead('tl', [s.alpha], 'Teamlead');
  for (const [key, name, char] of [['t1', 'Targetone', 'Targetchar'], ['t2', 'Targettwo', 'Twochar']]) {
    await s.member(key, name);
    s[key] = await s.person({ name: char });
    await s.link(s[key].pid, key);
  }
  s.future = addRaid(s, '2027-02-01');
  addSignup(s, s.future, { playerId: s.t1.pid });
  addSignup(s, s.future, { playerId: s.t2.pid });
  pendingBlock(s, 't1');
  pendingBlock(s, 't2');
  s.keptBy = (key) => rowsOf(s, 'SELECT blocked_by, pending_review, tombstone_missing FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, s.uids[key])[0];
  return s;
}
const reviewItem = async (s, who = 'off') => (await s.ok(who, 'GET', '/attention')).items.find((entry) => entry.kind === 'block_review');

check('keep: an Officer keeps a block a tombstone match wrote - they become the blocker, the person\'s own tombstones are written, they leave every team, upcoming sign-ups go, it is audited and the review item drops', async () => {
  const s = await keepWorld();
  assert.equal((await reviewItem(s)).pending, 2);
  const before = await s.ok('off', 'GET', '/people');
  const entry = before.removed.find((one) => one.person.displayName === 'Targetone');
  assert.deepEqual([entry.pendingReview, entry.actions], [true, { restoreAccess: true, keepBlock: true }]);
  assert.equal(await s.teamOf(s.t1.cid), s.alpha);
  assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ?', s.gid), []);

  const res = await s.ok('off', 'POST', `/people/${s.uids.t1}/block/keep`, undefined, 200);
  // The reply is the People payload, like blocking.
  assert.deepEqual(Object.keys(res).sort(), Object.keys(before).sort());
  const kept = res.removed.find((one) => one.person.displayName === 'Targetone');
  assert.equal(kept.removedBy.displayName, 'Officer');
  assert.equal(kept.pendingReview, undefined);
  assert.deepEqual(kept.actions, { restoreAccess: true });
  assert.equal(res.removed.find((one) => one.person.displayName === 'Targettwo').pendingReview, true, 'the other pending block is untouched');
  assert.deepEqual(s.keptBy('t1'), { blocked_by: s.uids.off, pending_review: 0, tombstone_missing: 0 });
  assert.deepEqual(s.keptBy('t2'), { blocked_by: null, pending_review: 1, tombstone_missing: 0 });
  assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ?', s.gid), [{ block_ref: `u:${s.uids.t1}` }]);
  assert.equal(await s.teamOf(s.t1.cid), null, 'off every team');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', s.t1.pid)[0].n, 0, 'the upcoming sign-up is withdrawn');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', s.t2.pid)[0].n, 1, 'the other one is not');
  const audit = (await s.ok('gm', 'GET', '/audit')).rows.find((one) => one.action === 'block.keep');
  assert.deepEqual([audit.group, audit.text, audit.entityId, audit.actor.displayName, audit.before, audit.after], ['settings', 'Kept the removal of Targetone, which matched an earlier block', s.uids.t1, 'Officer', { pendingReview: true }, { pendingReview: false }]);
  assert.equal(rowsOf(s, 'SELECT actor_role FROM audit_log WHERE action = ?', 'block.keep')[0].actor_role, 'officer');
  // The review item counts one block now, and drops with the last one.
  assert.equal((await reviewItem(s)).pending, 1);
  await s.ok('gm', 'POST', `/people/${s.uids.t2}/block/keep`, undefined, 200);
  assert.equal(await reviewItem(s), undefined, 'nothing waits for review: the item is gone');
  // Kept means blocked like any other: restoring access lifts it and its tombstones.
  await s.ok('off', 'DELETE', `/people/${s.uids.t1}/block`, undefined, 200);
  assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, `u:${s.uids.t1}`), []);
});

check('keep: 404 when nothing waits for review (no block, a block that is not pending, a block already kept, an unknown or another guild\'s account), 403 for the wrong rank or right, never the Owner', async () => {
  const s = await keepWorld();
  await s.ok('off', 'POST', `/people/${s.uids.t1}/block/keep`, undefined, 200);
  for (const [who, uid, why] of [
    ['off', s.uids.t1, 'already kept'], ['off', s.uids.off2, 'no block'], ['off', `u_${'B'.repeat(22)}`, 'an unknown account'], ['gm', s.uids.gm, 'the Owner'],
  ]) {
    const res = await s.call(who, 'POST', `/people/${uid}/block/keep`);
    assert.equal(res.status, 404, `${why}: ${res.text}`);
    assert.equal(res.json.error, 'not_found');
  }
  // A block an officer made by hand is not pending either.
  await s.ok('off', 'POST', `/people/${s.uids.tl}/block`, { reason: 'Hand' }, 200);
  assert.equal((await s.call('off', 'POST', `/people/${s.uids.tl}/block/keep`)).status, 404);
  // The gate and the seniority: a pending block on an Officer, one Officer cannot decide it; the Guild Master can. A Team Lead and a member cannot decide anything.
  pendingBlock(s, 'off2');
  const own = await s.call('off', 'POST', `/people/${s.uids.off2}/block/keep`);
  assert.equal(own.status, 403);
  assert.equal(own.json.error, 'forbidden');
  const people = await s.ok('off', 'GET', '/people');
  assert.deepEqual(people.removed.find((one) => one.person.displayName === 'Officertwo').actions, { restoreAccess: false }, 'no Keep for a block on an equal rank');
  assert.equal((await s.call('off2', 'POST', `/people/${s.uids.off2}/block/keep`)).status, 403, 'not even their own');
  for (const who of ['tl', 't2']) assert.equal((await s.call(who, 'POST', `/people/${s.uids.t2}/block/keep`)).status, 403, who);
  assert.equal(s.keptBy('off2').pending_review, 1);
  assert.equal(s.keptBy('t2').pending_review, 1);
  await s.ok('gm', 'POST', `/people/${s.uids.off2}/block/keep`, undefined, 200);
  assert.equal(s.keptBy('off2').blocked_by, s.uids.gm);
  // Another guild's uid is nobody here.
  const other = await otherGuild(s);
  assert.equal((await s.call('gm', 'POST', `/people/${other.uid}/block/keep`)).status, 404);
});

check('keep: the same guards run inside the write - a block decided or lifted in between, or an Officer demoted in between, is a 409 conflict that changes and audits nothing', async () => {
  const s = await keepWorld();
  const sqlite = sql(s);
  const original = s.w.db.batch.bind(s.w.db);
  let before = null;
  // Runs `before` once, right before the Keep batch (after the route has read its model): the state the route decided on is gone by then.
  s.w.db.batch = async (statements) => {
    if (before && statements.some((statement) => /SET pending_review = 0/.test(statement.sql))) { const run = before; before = null; run(); }
    return original(statements);
  };
  const nothingWritten = async (person) => {
    assert.equal(rowsOf(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'block.keep'")[0].n, 0, 'no audit row');
    assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ?', s.gid), [], 'no tombstone');
    assert.equal(await s.teamOf(person.cid), s.alpha, 'still on the team');
    assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM raid_signups WHERE player_id = ?', person.pid)[0].n, 1, 'still signed up');
  };
  // 1. Someone else decides it first.
  before = () => sqlite.prepare('UPDATE guild_blocks SET pending_review = 0, blocked_by = ? WHERE guild_id = ? AND user_id = ?').run(s.uids.off2, s.gid, s.uids.t1);
  const lost = await s.call('off', 'POST', `/people/${s.uids.t1}/block/keep`);
  assert.equal(lost.status, 409);
  assert.equal(lost.json.error, 'conflict');
  await nothingWritten(s.t1);
  assert.equal(s.keptBy('t1').blocked_by, s.uids.off2, 'the first decision stands');
  // 2. The block is lifted first.
  before = () => sqlite.prepare('DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ?').run(s.gid, s.uids.t2);
  assert.equal((await s.call('off', 'POST', `/people/${s.uids.t2}/block/keep`)).status, 409);
  await nothingWritten(s.t2);
  // 3. The Officer loses the role between the read and the write.
  pendingBlock(s, 'tl');
  before = () => sqlite.prepare("DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'officer'").run(s.gid, s.uids.off);
  assert.equal((await s.call('off', 'POST', `/people/${s.uids.tl}/block/keep`)).status, 409);
  assert.equal(s.keptBy('tl').pending_review, 1);
  assert.equal(rowsOf(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'block.keep'")[0].n, 0);
  s.w.db.batch = original;
});

check('keep: without a TOMBSTONE_KEY the block still applies and is flagged for the daily repair, like any block', async () => {
  const s = await keepWorld({});
  await s.ok('off', 'POST', `/people/${s.uids.t1}/block/keep`, undefined, 200);
  assert.deepEqual(s.keptBy('t1'), { blocked_by: s.uids.off, pending_review: 0, tombstone_missing: 1 });
  assert.deepEqual(rowsOf(s, 'SELECT block_ref FROM block_tombstones WHERE guild_id = ?', s.gid), []);
  assert(s.w.logs.some((line) => /TOMBSTONE_KEY/.test(line)), 'the operator line');
});

// ---------------------------------------------------------------------------
// Redaction

// An in-game guild with every kind of principal, and a sentinel planted wherever the Worker keeps something the Users replies must never carry: a Discord id (accounts, a person,
// a Raid-Helper sign-up), a Battle.net account id, a BattleTag, a Blizzard character / realm id and the namespace of an identity key, a session token hash, a tombstone hash and
// a webhook address.
async function sentinelWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } });
  [s.alpha, s.bravo] = s.tids;
  s.people = {};
  const spec = [
    ['own', 'Seatowner', 4], ['dgm', 'Derivedgm', 0], ['dof', 'Derivedoff', 1], ['dtl', 'Derivedlead', 2], ['sof', 'Storedoff', 5], ['stl', 'Storedlead', 5], ['cust', 'Customholder', 5],
    ['mem', 'Plainmember', 5], ['blk', 'Blockedone', 5], ['pnd', 'Pendingone', 5],
  ];
  for (const [key, name] of spec) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
  }
  await s.ok('gm', 'PUT', `/people/${s.uids.sof}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  await s.ok('gm', 'PUT', `/people/${s.uids.stl}/roles`, { officer: false, teamLeadTeamIds: [s.alpha] }, 200);
  const role = await s.ok('gm', 'POST', '/roles', { name: 'Loot council', permissions: { 'loot.view': 'guild' } });
  await s.ok('gm', 'PUT', `/people/${s.uids.cust}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: role.roles.find((entry) => entry.name === 'Loot council').id, teamId: null }] }, 200);
  let index = 0;
  for (const [key, , rank] of spec) {
    index++;
    const derivedRole = ['own', 'dgm', 'dof', 'dtl'].includes(key);
    makeProven(s, key, s.people[key], { rank, id: 91827300 + index, bnetId: `98700000${index}`, proof: derivedRole ? 'bnet' : 'officer', link: derivedRole });
    // Every account has a Battle.net link of its own, proven or not.
    exec(s, "INSERT OR IGNORE INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)", s.uids[key], `98700000${index}`, `Sentineltag${index}#7777`);
    exec(s, 'UPDATE bnet_links SET battletag = ? WHERE user_id = ?', `Sentineltag${index}#7777`, s.uids[key]);
  }
  flip(s, { owner: 'own' });
  exec(s, 'UPDATE characters SET blizzard_realm_id = 87654321 WHERE blizzard_realm_id IS NOT NULL');
  exec(s, 'UPDATE guild_roster SET blizzard_realm_id = 87654321');
  await s.ok('own', 'POST', `/people/${s.uids.blk}/block`, { reason: 'Rude' }, 200);
  pendingBlock(s, 'pnd');
  // A person with a Discord id of their own, and every kind of name.
  s.ghost = await s.person({ name: 'Ghost' }, 'own');
  exec(s, "UPDATE players SET discord_user_id = '888000000000000001' WHERE id = ?", s.ghost.pid);
  s.wanted = await s.person({ name: 'Wanted' }, 'own');
  exec(s, "UPDATE players SET discord_user_id = '888000000000000002' WHERE id = ?", s.wanted.pid);
  await s.ok('own', 'POST', `/roster/${s.wanted.pid}/block`, { reason: 'Banned' }, 200);
  s.r1 = addRaid(s, '2026-12-01');
  addLoot(s, s.r1, 'Lootguy');
  addPresence(s, s.r1, 'Logguy');
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Helperguy', discordId: '555000000000000001' });
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Selfhelper', discordId: rowsOf(s, 'SELECT discord_id FROM users WHERE id = ?', s.uids.dof)[0].discord_id });
  addApplication(s, { name: 'Hopeful' });
  await s.outsider('out1', 'Outsiderone');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
  exec(s, "INSERT INTO team_notifications (team_id, guild_id, webhook_url, updated_at) VALUES (?, ?, 'https://discord.com/api/webhooks/123456789012345678/SentinelWebhookSecret', 1)", s.alpha, s.gid);
  return s;
}

const sentinelsOf = (s) => {
  const values = new Set(['SentinelWebhookSecret', '123456789012345678', '87654321', 'profile-classicann', '555000000000000001', '888000000000000001', '888000000000000002']);
  const take = (text, ...bind) => rowsOf(s, text, ...bind).forEach((entry) => Object.values(entry).forEach((value) => { if (value !== null && String(value).length >= 6) values.add(String(value)); }));
  take('SELECT discord_id FROM users WHERE discord_id IS NOT NULL');
  take('SELECT account_key FROM users WHERE account_key <> id'); // an account made without Discord has its own id as the key: that is no secret
  take('SELECT discord_user_id FROM players WHERE discord_user_id IS NOT NULL');
  take('SELECT discord_user_id FROM raid_signups WHERE discord_user_id IS NOT NULL');
  take('SELECT bnet_account_id, battletag FROM bnet_links');
  take('SELECT proof_bnet_account_id FROM characters WHERE proof_bnet_account_id IS NOT NULL');
  take('SELECT blizzard_char_id FROM characters WHERE blizzard_char_id IS NOT NULL');
  take('SELECT token_hash FROM sessions');
  take('SELECT hmac FROM block_tombstones');
  return [...values];
};

check('redaction: no Discord id, Battle.net account id, BattleTag, Blizzard id, token hash, tombstone or webhook is in any Users reply, for the Owner, a derived Guild Master and Officer, a stored Officer, and every principal that is refused', async () => {
  const s = await sentinelWorld();
  const secrets = sentinelsOf(s);
  assert(secrets.length > 40, `${secrets.length} sentinels planted`);
  assert(rowsOf(s, 'SELECT COUNT(*) AS n FROM block_tombstones')[0].n > 0, 'a tombstone hash exists');
  const principals = { own: 200, dgm: 200, dof: 200, sof: 200, dtl: 403, stl: 403, cust: 403, mem: 403 };
  // Every key the Owner can see, in every segment.
  const keys = [];
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) keys.push(...(await all(s, 'own', `segment=${segment}`)).map((entry) => entry.key));
  assert(keys.length >= 15, `${keys.length} users`);
  const kinds = new Set(keys.map((key) => key.slice(0, 2)));
  assert.deepEqual([...kinds].sort(), ['n_', 'p_', 'u_']);
  let scanned = 0;
  const clean = (res, label) => {
    scanned++;
    for (const secret of secrets) assert(!res.text.includes(secret), `${label} carries the sentinel ${secret}`);
  };
  for (const [who, status] of Object.entries(principals)) {
    for (const segment of ['members', 'former', 'nonmembers', 'blocked']) {
      for (const sort of ['user', 'main', 'permission', 'lastSeen']) {
        const res = await s.call(who, 'GET', `/users?segment=${segment}&sort=${sort}&limit=100`);
        assert.equal(res.status, status, `${who} ${segment} ${sort}: ${res.text.slice(0, 200)}`);
        clean(res, `${who} list ${segment}/${sort}`);
      }
    }
    const filtered = await s.call(who, 'GET', '/users?segment=nonmembers&from=raid_helper&q=h&rank=raider');
    clean(filtered, `${who} filtered list`);
    for (const key of keys) {
      const res = await s.call(who, 'GET', `/users/${key}`);
      assert.equal(res.status, status, `${who} ${key}`);
      clean(res, `${who} page ${key}`);
    }
    clean(await s.call(who, 'GET', '/users?segment=nope'), `${who} bad query`);
    clean(await s.call(who, 'GET', `/users/u_${'Z'.repeat(22)}`), `${who} unknown key`);
  }
  // Keep: its answers carry nothing either.
  const kept = await s.call('own', 'POST', `/people/${s.uids.pnd}/block/keep`);
  assert.equal(kept.status, 200, kept.text);
  const people = JSON.stringify(kept.json);
  for (const secret of ['SentinelWebhookSecret', '987000001', 'Sentineltag']) assert(!people.includes(secret), secret);
  clean(await s.call('mem', 'POST', `/people/${s.uids.pnd}/block/keep`), 'a refused Keep');
  assert(scanned >= Object.keys(principals).length * (17 + keys.length + 2), `${scanned} replies read`);
  // The signed-out and the guest are refused with nothing.
  clean(await s.w.call(newJar(), 'GET', `${s.base}/users`), 'signed out');
});

check('page of a user: an in-game character shows its in-game rank label, core rank and team; roles say whether the rank, a hand or the seat gave them', async () => {
  const s = await sentinelWorld();
  const dof = await s.ok('own', 'GET', `/users/${s.uids.dof}`);
  assert.deepEqual(dof.permissions, [{ role: 'officer', label: 'Officer', sources: ['ingame'] }]);
  assert.equal(dof.permission, 'Officer');
  assert.deepEqual(dof.characters.map((entry) => [entry.name, entry.ingameRank, entry.coreRank, entry.team && entry.team.name]), [['Derivedoff', { rank: 1, label: 'Officer' }, 'raider', 'Alpha']]);
  const dtl = await s.ok('own', 'GET', `/users/${s.uids.dtl}`);
  assert.deepEqual(dtl.permissions, [{ role: 'team_lead', label: 'Team Lead', teamId: s.alpha, teamName: 'Alpha', sources: ['ingame'] }]);
  const sof = await s.ok('own', 'GET', `/users/${s.uids.sof}`);
  assert.deepEqual(sof.permissions, [{ role: 'officer', label: 'Officer', sources: ['manual'] }], 'a hand-given role is not marked as the rank\'s');
  assert.equal(sof.characters[0].ingameRank.label, 'Social');
  assert.equal(sof.characters[0].ingameRank.rank, 5);
  const own = await s.ok('own', 'GET', `/users/${s.uids.own}`);
  assert.deepEqual(own.permissions, [{ role: 'guild_master', label: 'Guild Master', sources: ['owner'] }]);
  assert.deepEqual(own.flags, { owner: true });
  const cust = await s.ok('own', 'GET', `/users/${s.uids.cust}`);
  assert.deepEqual(cust.permissions, [{ role: cust.permissions[0].role, label: 'Loot council', sources: ['manual'] }]);
  assert.equal(cust.permission, 'Loot council', 'a custom role is the permission when nothing built-in is held');
  const members = await list(s, 'own', 'segment=members&sort=permission&limit=100');
  assert.deepEqual(members.rows.slice(0, 7).map((entry) => [entry.name, entry.permission]), [
    ['Derivedgm', 'Guild Master'], ['Seatowner', 'Guild Master'], ['Derivedoff', 'Officer'], ['Storedoff', 'Officer'], ['Derivedlead', 'Team Lead'], ['Storedlead', 'Team Lead'],
    ['Customholder', 'Loot council'],
  ]);
});

// ---------------------------------------------------------------------------
// The budget

const EVIDENCE_TABLES = [
  ...GUARDED_TABLES, 'users', 'raid_signups', 'loot_awards', 'attendance', 'raid_presence', 'raid_pulls', 'applications', 'raids', 'user_servers', 'guild_blocks', 'person_blocks',
  'raid_manual_names', 'attendance_guests', 'character_name_aliases', 'bnet_links', 'source_rank_maps', 'teams',
];
const dumpScans = (label, found) => assert.deepEqual(found.map((entry) => `${entry.table}: ${entry.detail} :: ${entry.sql}`), [], label);
const rowsReadSince = (db, from) => db.statementLog.slice(from).reduce((sum, entry) => sum + entry.rowsRead, 0);
// Rows a request may RETURN: both lists give at most offset + limit + 1 rows, the page rows come back once more as display columns (two statements), plus the fixed reads of the
// request (the guild context with its permission rows, the rate limit, the four counts).
const FIXED_ROWS = 160;
const rowBound = (offset, limit) => FIXED_ROWS + 2 * (offset + limit + 1) + 2 * limit;

check('budget: 5,000 names on a flipped in-game guild - the counts are right, a list costs at most 11 statements, a user page at most 14, no scan of any evidence table, rows returned bounded by the page', async () => {
  const s = await bigWorld({ scale: 1 });
  const db = s.w.db;
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guilds')[0].n, 2001);
  const total = Object.values(s.expected).reduce((sum, n) => sum + n, 0);
  assert(total >= 5000, `${total} names`);
  const measured = {};
  let counts = null;
  for (const segment of ['members', 'former', 'nonmembers', 'blocked']) {
    for (const sort of ['user', 'main', 'permission', 'lastSeen']) {
      for (const [offset, limit] of [[0, 50], [40, 100]]) {
        const from = db.statementLog.length;
        const res = await s.ok('own', 'GET', `/users?segment=${segment}&sort=${sort}&dir=desc&offset=${offset}&limit=${limit}`);
        const label = `${segment}/${sort} offset ${offset} limit ${limit}`;
        const statements = statementsSince(db, from);
        const rows = rowsReadSince(db, from);
        assert(statements <= 11, `${label}: ${statements} statements`);
        assert(rows <= rowBound(offset, limit), `${label}: ${rows} rows returned (bound ${rowBound(offset, limit)})`);
        dumpScans(label, scansSince(db, from, { tables: EVIDENCE_TABLES }));
        assert.equal(res.rows.length, limit, label);
        measured[segment] = Math.max(measured[segment] || 0, statements);
        counts = res.counts;
      }
    }
  }
  assert.deepEqual(counts, s.expected, 'the four counts of the fixture');
  console.log(`      measured: a list costs ${JSON.stringify(measured)} statements at most (guild context, rate limit, counts, the core, the names, the display columns)`);
  // The rows a request returns do not grow with the guild: the same first page on a guild a tenth of the size.
  const small = await bigWorld({ scale: 0.1, other: 20 });
  const rowsAt = async (world) => { const from = world.w.db.statementLog.length; await world.ok('own', 'GET', '/users?segment=nonmembers&limit=50'); return rowsReadSince(world.w.db, from); };
  const big = await rowsAt(s);
  const little = await rowsAt(small);
  assert(Math.abs(big - little) <= 10, `${big} rows returned on 5,000 names, ${little} on 500`);
  console.log(`      measured: the first page of non-members returns ${big} rows on 5,000 names and ${little} on 500`);
});

check('budget: the page of one user of each kind costs at most 14 statements and scans no evidence table; Keep costs far less than the 45 a Worker may run', async () => {
  const s = await bigWorld({ scale: 1 });
  const db = s.w.db;
  const first = async (query) => (await s.ok('own', 'GET', `/users?${query}&limit=1&offset=3`)).rows[0];
  const pick = {
    'a member account': await first('segment=members&sort=lastSeen&dir=desc'),
    'a derived Officer': { key: s.uids.dof },
    'a member person': await first('segment=members&sort=user&q=loose'),
    'a Former person': await first('segment=former&sort=user&q=former'),
    'a blocked person': await first('segment=blocked&sort=user&q=bperson'),
    'a pending block': await first('segment=blocked&sort=user&q=blocked'),
    'an applicant account': await first('segment=nonmembers&sort=user&q=applicant'),
    'a loot-only name': await first('segment=nonmembers&sort=user&q=lootonly'),
    'a log-only name': await first('segment=nonmembers&sort=user&q=logonly'),
    'a Raid-Helper name': await first('segment=nonmembers&sort=user&q=helper'),
  };
  const used = {};
  for (const [label, entry] of Object.entries(pick)) {
    const from = db.statementLog.length;
    const res = await s.ok('own', 'GET', `/users/${entry.key}`);
    const statements = statementsSince(db, from);
    used[label] = statements;
    assert(statements <= 14, `${label}: ${statements} statements`);
    assert(rowsReadSince(db, from) <= 400, `${label}: ${rowsReadSince(db, from)} rows returned`);
    dumpScans(label, scansSince(db, from, { tables: EVIDENCE_TABLES }));
    assert.equal(res.key, entry.key);
  }
  console.log(`      measured: a user page costs ${JSON.stringify(used)} statements`);
  // Keep on a pending block of the big guild.
  const pending = (await s.ok('own', 'GET', '/users?segment=blocked&q=blocked&limit=100')).rows.find((entry) => entry.flags.pendingReview);
  assert(pending, 'the fixture has a pending block');
  const from = db.statementLog.length;
  await s.ok('own', 'POST', `/people/${pending.key}/block/keep`, undefined, 200);
  const statements = statementsSince(db, from);
  assert(statements <= 45, `Keep: ${statements} statements`);
  console.log(`      measured: Keep costs ${statements} statements (the People payload included)`);
});

check('budget: the plan checker sees the scans it is there for - an unbounded lookup of a loot, sign-up, log or application row is reported, a bounded one is not', async () => {
  const s = await bigWorld({ scale: 0.05, other: 10 });
  const db = s.w.db;
  const run = async (text, ...values) => { const from = db.statementLog.length; await db.prepare(text).bind(...values).all(); return scansSince(db, from, { tables: EVIDENCE_TABLES }); };
  assert((await run("SELECT COUNT(*) FROM loot_awards WHERE winner_name = 'x'")).length > 0, 'loot_awards by a column with no index');
  assert((await run("SELECT COUNT(*) FROM raid_signups WHERE nickname = 'x'")).length > 0, 'raid_signups by nickname alone');
  assert((await run("SELECT COUNT(*) FROM raid_presence WHERE name = 'x'")).length > 0, 'raid_presence by a column with no index');
  assert((await run("SELECT COUNT(*) FROM users WHERE username = 'x'")).length > 0, 'users by username');
  assert.deepEqual(await run("SELECT COUNT(*) FROM loot_awards WHERE guild_id = ? AND winner_name_key = 'x'", s.gid), []);
  assert.deepEqual(await run("SELECT COUNT(*) FROM raid_signups WHERE guest_user_id = 'x'"), [], 'the account\'s guest sign-ups use raid_signups_guest_account');
  assert.deepEqual(await run("SELECT COUNT(*) FROM raid_signups WHERE guild_id = ? AND player_id IS NULL AND guest_user_id IS NULL AND nickname IS NOT NULL", s.gid), [], 'the unresolved ones use raid_signups_unresolved');
});

// ---------------------------------------------------------------------------
// Migration 0038

check('migration 0038: two indexes and nothing else, built over a populated database, the lookups turn from a scan into a search, and it can run twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0038-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((entry) => entry.endsWith('.sql') && entry < '0038')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const sqlite = db.sqlite;
  const file = fs.readFileSync(path.join(MIGRATIONS, '0038_users_indexes.sql'), 'utf8').replace(/\r\n/g, '\n');
  assert(!/[^\x09\x0a\x0d\x20-\x7e]/.test(file), 'ASCII only');
  assert(/ROLLBACK:[\s\S]*DROP INDEX IF EXISTS raid_signups_guest_account;[\s\S]*DROP INDEX IF EXISTS raid_signups_unresolved;/.test(file), 'the rollback is written down');
  assert(/SAFE FOR THE PREVIOUS RELEASE/.test(file));
  sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g1', 'G1', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1);
    INSERT INTO teams (id, guild_id, name, created_at) VALUES ('t1', 'g1', 'T', 1);
    INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r1', 'g1', 't1', '2026-12-01', 1, 1, 1);
    INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES ('u1', 'k1', 'U', 1, 1);
    INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, guest, guest_user_id, created_at, updated_at) VALUES ('r1', 'raidsmith', 1, 'Guestname', 'signed', 1, 'g1', 1, 'u1', 1, 1);
    INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, created_at, updated_at) VALUES ('r1', 'raid_helper', 2, 'Nobody', 'signed', 1, 'g1', 1, 1);`);
  const schema = () => sqlite.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((entry) => `${entry.type}:${entry.name}`);
  const before = schema();
  const plan = (text) => sqlite.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map((entry) => entry.detail).join(' | ');
  const guestSql = "SELECT 1 FROM raid_signups WHERE guest_user_id = 'u1' AND guild_id = 'g1'";
  const unresolvedSql = "SELECT nickname, raid_id FROM raid_signups WHERE guild_id = 'g1' AND player_id IS NULL AND guest_user_id IS NULL AND nickname IS NOT NULL";
  assert.match(plan(guestSql), /SCAN raid_signups/, 'before: the account\'s guest sign-ups walk the table');
  assert.match(plan(unresolvedSql), /SCAN raid_signups|raid_signups_discord|sqlite_autoindex_raid_signups/);
  const rows = (text) => sqlite.prepare(text).all().map((entry) => ({ ...entry }));
  const dataBefore = JSON.stringify(rows('SELECT * FROM raid_signups ORDER BY raid_id, source, signup_id'));
  sqlite.exec(file);
  assert.deepEqual(schema().filter((entry) => !before.includes(entry)), ['index:raid_signups_guest_account', 'index:raid_signups_unresolved']);
  assert.deepEqual(before.filter((entry) => !schema().includes(entry)), [], 'nothing was dropped');
  assert.equal(JSON.stringify(rows('SELECT * FROM raid_signups ORDER BY raid_id, source, signup_id')), dataBefore, 'no row changed');
  assert.match(plan(guestSql), /SEARCH raid_signups USING INDEX raid_signups_guest_account/);
  assert.match(plan(unresolvedSql), /SEARCH raid_signups USING (?:COVERING )?INDEX raid_signups_unresolved \(guild_id=\?/);
  // The indexes hold exactly the rows they are for.
  assert.deepEqual(rows('SELECT nickname FROM raid_signups INDEXED BY raid_signups_unresolved WHERE guild_id = \'g1\' AND player_id IS NULL AND guest_user_id IS NULL AND nickname IS NOT NULL'), [{ nickname: 'Nobody' }]);
  assert.deepEqual(rows('SELECT signup_id FROM raid_signups INDEXED BY raid_signups_guest_account WHERE guest_user_id IS NOT NULL'), [{ signup_id: 1 }]);
  // The previous release's statements run on the new schema, and the file runs twice.
  sqlite.exec("INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, created_at, updated_at) VALUES ('r1', 'raid_helper', 3, 'Another', 'signed', 1, 'g1', 1, 1)");
  sqlite.exec(file);
  assert.deepEqual(schema().filter((entry) => !before.includes(entry)), ['index:raid_signups_guest_account', 'index:raid_signups_unresolved']);
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

check('migration 0038: the number is free (0037 is the parallel lane\'s) and the file is the last one', async () => {
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => entry.endsWith('.sql')).sort();
  assert(names.includes('0038_users_indexes.sql'));
  assert(!names.some((name) => name.startsWith('0038_') && name !== '0038_users_indexes.sql'), 'one 0038');
  assert.equal(names.filter((name) => name.startsWith('0037_')).length <= 1, true);
});

// ---------------------------------------------------------------------------
// Identity edges

check('identity: a person that carries an account\'s Discord id (no link) is that account\'s Main and is listed once; deleting an account leaves its person in the list as a person', async () => {
  const s = await legacy();
  // Membertwo has no person; Ghost carries Membertwo's Discord id without being linked.
  const discordId = rowsOf(s, 'SELECT discord_id FROM users WHERE id = ?', s.uids.m2)[0].discord_id;
  exec(s, 'UPDATE players SET discord_user_id = ? WHERE id = ?', discordId, s.ghost.pid);
  const members = await list(s, 'gm', 'segment=members&limit=100');
  assert.deepEqual(row(members, 'Membertwo').main, { name: 'Ghost', class: 'MAGE', realm: 'Nightslayer' });
  assert(!names(members).includes('Ghost'), 'the person is the account\'s, not a row of its own');
  assert.equal(members.counts.members, 5);
  // The account goes (Delete my data): the person stays, now without an account.
  exec(s, 'DELETE FROM users WHERE id = ?', s.uids.m2);
  const after = await list(s, 'gm', 'segment=members&limit=100');
  assert(names(after).includes('Ghost'), 'the person is listed again, on its own');
  assert(!names(after).includes('Membertwo'));
  assert.equal(after.counts.members, 5);
});

check('identity: a name that a character gets later drops out of the names (the sighting resolves to the roster), and a renamed character keeps its old name resolved through the alias', async () => {
  const s = await legacy();
  const before = await list(s, 'gm', 'segment=nonmembers&limit=100');
  assert(names(before).includes('Lootguy'));
  // A character with that name appears: the loot line now belongs to a person.
  const made = await s.person({ name: 'Lootguy' });
  const after = await list(s, 'gm', 'segment=nonmembers&limit=100');
  assert(!names(after).includes('Lootguy'));
  assert.equal(after.counts.nonmembers, before.counts.nonmembers - 1);
  assert.equal((await s.call('gm', 'GET', `/users/${nameKeyOf('Lootguy')}`)).status, 404);
  // A rename: the old name stays resolved through a dated alias.
  exec(s, "UPDATE characters SET name = 'Renamed', name_key = 'renamed' WHERE id = ?", made.cid);
  exec(s, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('al_fixture', ?, ?, 'lootguy', 'nightslayer', 1)", s.gid, made.cid);
  assert(!names(await list(s, 'gm', 'segment=nonmembers&limit=100')).includes('Lootguy'));
});

// ---------------------------------------------------------------------------
// Review fixes G2 (a guest sign-up in ANOTHER guild) and G4 (the viewer's view permissions); tasks/open/audit-b6b2b-b7b-security.md

check('G2: an account\'s guest sign-up on an open raid of ANOTHER guild moves nothing in this guild\'s Last seen: list, sort order and user page', async () => {
  const s = await legacy();
  attend(s, s.r1, s.alpha, s.mone.pid);
  const other = await otherGuild(s);
  const otherRaid = addRaid(other, '2026-12-20');
  addSignup(other, otherRaid, { guest: 1, nickname: 'Elsewhere', guestUserId: s.uids.m1 });
  addSignup(other, otherRaid, { guest: 1, nickname: 'Elsewhere', guestUserId: s.uids.out2 });
  const members = await list(s, 'gm', 'segment=members&sort=lastSeen&dir=desc&limit=100');
  assert.equal(row(members, 'Memberone').lastSeen, '2026-12-01', 'this guild\'s own newest fact, not the other guild\'s raid of 2026-12-20');
  assert(!members.rows.some((entry) => entry.lastSeen === '2026-12-20'), 'nobody leads the sort with the other guild\'s date');
  assert.equal((await s.ok('gm', 'GET', `/users/${s.uids.m1}`)).lastSeen, '2026-12-01');
  const nonmembers = await list(s, 'gm', 'segment=nonmembers&sort=lastSeen&dir=desc&limit=100');
  assert(!nonmembers.rows.some((entry) => entry.lastSeen === '2026-12-20'), 'for a non-member account as well');
  assert.equal((await s.ok('gm', 'GET', `/users/${s.uids.out2}`)).lastSeen, '2026-12-01', 'their own guest sign-up of this guild (raid 1) is what counts');
  // Control: the same sign-up in THIS guild, on a later raid, does count.
  const own = addRaid(s, '2026-12-15');
  addSignup(s, own, { guest: 1, nickname: 'Here', guestUserId: s.uids.m1 });
  assert.equal(row(await list(s, 'gm', 'segment=members&limit=100'), 'Memberone').lastSeen, '2026-12-15');
  assert.equal((await s.ok('gm', 'GET', `/users/${s.uids.m1}`)).lastSeen, '2026-12-15');
});

// Gives the Officer role and the Member role (everyone holds it: it grants raids.view) of the guild a permission list without the named actions (an edited role: the system rows
// copied, minus these).
function dropFromOfficer(s, actions) {
  for (const role of ['officer', 'member']) {
    exec(s, 'INSERT OR IGNORE INTO role_overrides (guild_id, role_id) VALUES (?, ?)', s.gid, role);
    exec(s, 'DELETE FROM role_override_permissions WHERE guild_id = ? AND role_id = ?', s.gid, role);
    for (const entry of rowsOf(s, 'SELECT action, scope FROM role_permissions WHERE role_id = ?', role)) {
      if (!actions.includes(entry.action)) exec(s, 'INSERT INTO role_override_permissions (guild_id, role_id, action, scope) VALUES (?, ?, ?, ?)', s.gid, role, entry.action, entry.scope);
    }
  }
}

check('G4: the Users list and the user page leave out what the viewer\'s role may not see: loot item names, raid titles, attendance and sign-up dates, and the names and tags only those facts give', async () => {
  const s = await legacy();
  attend(s, s.r1, s.alpha, s.mone.pid);
  addLoot(s, s.r2, 'Mone');
  const names = (res) => res.rows.map((entry) => entry.name).sort();
  const nonmembers = (who) => list(s, who, 'segment=nonmembers&limit=100');
  const lastSeenOf = async (who, name) => row(await list(s, who, 'segment=members&limit=100'), name).lastSeen;
  const mone = (who) => s.ok(who, 'GET', `/users/${s.uids.m1}`);
  const lootPage = (who) => s.call(who, 'GET', `/users/${nameKeyOf('Lootguy')}`);

  // Control: the Officer and the Guild Master see everything.
  const all = names(await nonmembers('off'));
  assert.deepEqual(all, names(await nonmembers('gm')));
  for (const name of ['Lootguy', 'Logguy', 'Helperguy', 'Linkguest', 'Pasted', 'Marked', 'Hopeful']) assert(all.includes(name), name);
  assert.deepEqual((await s.ok('off', 'GET', `/users/${nameKeyOf('Lootguy')}`)).sightings.map((entry) => [entry.source, entry.detail]), [['loot', 'Fixture Blade']]);
  assert.equal(await lastSeenOf('off', 'Memberone'), '2026-12-08', 'the loot award of 2026-12-08 is the newest fact');
  const outsiderTwo = row(await nonmembers('off'), 'Outsidertwo');
  assert.deepEqual(outsiderTwo.tags, ['guest_signup']);
  assert.deepEqual((await s.ok('off', 'GET', `/users/${outsiderTwo.key}`)).sightings.map((entry) => entry.source), ['guest_signup']);

  // No loot.view: no item name, no loot-only name, no loot date.
  dropFromOfficer(s, ['loot.view']);
  const noLoot = await nonmembers('off');
  assert(!names(noLoot).includes('Lootguy'), 'a name only the loot gives is not listed');
  assert.equal(noLoot.counts.nonmembers, (await nonmembers('gm')).counts.nonmembers - 1);
  assert.equal((await lootPage('off')).status, 404, 'and its page is gone: no item name for the viewer');
  assert.equal((await lootPage('gm')).status, 200, 'the Guild Master still sees it');
  assert.equal(await lastSeenOf('off', 'Memberone'), '2026-12-01', 'the attendance date, not the loot one');
  assert.equal(JSON.stringify(await mone('off')).includes('Fixture Blade'), false);
  assert.equal(JSON.stringify(noLoot).includes('Fixture Blade'), false);
  assert(names(noLoot).includes('Logguy') && names(noLoot).includes('Pasted'), 'the rest is unchanged');

  // No attendance.view: no attendance date, no officer-marked guest.
  dropFromOfficer(s, ['loot.view', 'attendance.view']);
  assert.equal(await lastSeenOf('off', 'Memberone'), null, 'no raid-level fact the viewer may see is left');
  assert.equal((await mone('off')).lastSeen, null);
  assert(!names(await nonmembers('off')).includes('Marked'));
  assert.equal(await lastSeenOf('gm', 'Memberone'), '2026-12-08');

  // No raids.view: no raid title, no sign-up or raid-log fact, no guest tag, no name only a raid gives.
  dropFromOfficer(s, ['loot.view', 'attendance.view', 'raids.view']);
  const noRaids = await nonmembers('off');
  for (const name of ['Logguy', 'Helperguy', 'Linkguest', 'Pasted']) assert(!names(noRaids).includes(name), `${name} is a raid fact`);
  assert(names(noRaids).includes('Hopeful'), 'an application is no raid fact');
  const out2 = row(noRaids, 'Outsidertwo');
  assert(!out2 || (out2.tags.length === 0 && out2.lastSeen === null), 'the account with only a guest sign-up carries neither tag nor date');
  if (out2) assert.deepEqual((await s.ok('off', 'GET', `/users/${out2.key}`)).sightings, []);
  assert(!JSON.stringify(noRaids).includes('Raid 2026-12'), 'no raid title anywhere');
  assert(row(await nonmembers('gm'), 'Outsidertwo').tags.includes('guest_signup'), 'the Guild Master still sees the tag');
});

runChecks(checks);
