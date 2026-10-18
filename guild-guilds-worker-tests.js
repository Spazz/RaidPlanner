/**
 * Raidsmith guild tracker, Phase 8 (opening Raidsmith to other guilds) - Worker tests
 * Run: node guild-guilds-worker-tests.js
 *
 * Who may create a guild (open to Discord server administrators; the allowlist stays an override), what the sign-in keeps of the Discord guilds
 * list, the per-account and per-guild limits, the setup checklist, the Guild Master's export and deletion. The cross-guild walker is
 * guild-isolation-tests.js. Same harness as the other Worker suites: the Worker over the node:sqlite D1 stand-in (tests/d1-fake.js), Discord faked.
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, server, makeWorld, signIn, newJar, person } = require('./tests/guild-world');

const SERVERS = ['900000000000000001', '900000000000000002', '900000000000000003', '900000000000000004', '900000000000000005', '900000000000000006', '900000000000000007'];
const [S1, S2, S3, S4, S5, S6, S7] = SERVERS;
const ALICE = person(1, 'Alice');
const BOB = person(2, 'Bob');
const CAROL = person(3, 'Carol');
const DAVE = person(4, 'Dave');
const ERIN = person(5, 'Erin');
const OFFICER = { officer: true, teamLeadTeamIds: [] };
const BODY = { serverId: S1, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const meOf = async (w, jar) => (await w.call(jar, 'GET', '/auth/me')).json;
const createGuild = (w, jar, over = {}) => w.call(jar, 'POST', '/api/guild', { ...BODY, ...over });

// Alice (an administrator of S1) creates "Ember"; Bob and Carol are plain members of S1.
async function scenario(options = {}) {
  const w = await makeWorld(options);
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const made = await createGuild(w, alice);
  assert.equal(made.status, 201, made.text);
  const s = { w, alice, guildId: made.json.guild.id, teamId: made.json.teams[0].id, jars: { alice }, ids: {} };
  for (const [name, who] of [['bob', BOB], ['carol', CAROL]]) s.jars[name] = (await signIn(w, who, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await meOf(w, s.jars[name])).user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body) => w.call(s.jars[who], method, `${s.path}${tail}`, body);
  s.setRoles = (who, body) => s.call('alice', 'PUT', `/people/${s.ids[who]}/roles`, body);
  return s;
}

// ---------------------------------------------------------------------------
// Who may create

check('creation without an allowlist: owners, administrators and Manage Server holders create for their own server; nobody else does', async () => {
  const w = await makeWorld();
  assert.equal(w.env.GUILD_CREATOR_ALLOWLIST, undefined, 'the variable is absent');
  const owner = (await signIn(w, ALICE, [server(S1, { owner: true, permissions: '0' })])).jar;
  const admin = (await signIn(w, BOB, [adminOf(S2)])).jar;
  const manager = (await signIn(w, CAROL, [server(S3, { permissions: '32' })])).jar;
  const plain = (await signIn(w, DAVE, [memberOf(S4), server(S5, { permissions: '1024' })])).jar;

  const mine = (await meOf(w, owner)).create;
  assert.equal(mine.allowed, true);
  assert.deepEqual(mine.servers.map((entry) => [entry.id, entry.access]), [[S1, 'owner']]);
  assert.deepEqual(mine.limit, { created: 0, max: 5 });
  assert.equal(created(await createGuild(w, owner, { serverId: S1, name: 'Owners' })), true);
  assert.equal(created(await createGuild(w, admin, { serverId: S2, name: 'Admins' })), true);
  assert.equal(created(await createGuild(w, manager, { serverId: S3, name: 'Managers' })), true);
  assert.deepEqual((await w.rows('SELECT name FROM guilds ORDER BY name')).map((row) => row.name), ['Admins', 'Managers', 'Owners']);

  // A plain member: nothing to offer, and a server outside the signed-in list is refused whatever the body says.
  assert.deepEqual((await meOf(w, plain)).create, { allowed: false, reason: 'no_server' });
  for (const serverId of [S4, S5, S6]) {
    const refused = await createGuild(w, plain, { serverId, name: 'Nope' });
    assert.deepEqual([refused.status, refused.json.error], [403, 'not_allowed_to_create'], serverId);
  }
  assert.equal(await w.count('guilds'), 3);
  function created(res) { assert.equal(res.status, 201, res.text); return true; }
});

check('creation without an allowlist: a server that already has a guild is taken (409) and is not offered again', async () => {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const bob = (await signIn(w, BOB, [adminOf(S1)])).jar;
  assert.equal((await createGuild(w, alice)).status, 201);
  const second = await createGuild(w, bob, { name: 'Copycat' });
  assert.deepEqual([second.status, second.json.error, second.json.field], [409, 'server_taken', 'serverId']);
  const me = await meOf(w, bob);
  assert.deepEqual(me.create, { allowed: false, reason: 'no_server' }, 'the only server Bob administers has a guild with a Guild Master');
  assert.equal(await w.count('guilds'), 1);
});

check('creation with an allowlist: only listed Discord IDs, and still only for a server they administer', async () => {
  const w = await makeWorld({ allowlist: [ALICE.id] });
  const alice = (await signIn(w, ALICE, [adminOf(S1), memberOf(S2)])).jar;
  const bob = (await signIn(w, BOB, [adminOf(S3)])).jar;
  const refused = await createGuild(w, bob, { serverId: S3, name: 'Bobs' });
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_allowed_to_create'], 'an administrator who is not listed');
  assert.deepEqual((await meOf(w, bob)).create, { allowed: false, reason: 'not_approved' });
  const [kept] = await w.rows('SELECT manageable_servers, manageable_until FROM sessions WHERE user_id = (SELECT id FROM users WHERE discord_id = ?)', BOB.id);
  assert.equal(kept.manageable_servers, null, 'the server list is not kept for an account that may not create');

  const plainServer = await createGuild(w, alice, { serverId: S2, name: 'Not admin there' });
  assert.deepEqual([plainServer.status, plainServer.json.error], [403, 'not_allowed_to_create'], 'listed, but not an administrator of that server');
  assert.equal((await createGuild(w, alice)).status, 201);
  assert.equal(await w.count('guilds'), 1);
});

check('the allowlist is an override only while it names somebody: blank, spaces and stray commas leave creation open', async () => {
  for (const value of ['', '   ', ' , ,']) {
    const w = await makeWorld({ allowlist: undefined, env: { GUILD_CREATOR_ALLOWLIST: value } });
    const jar = (await signIn(w, ALICE, [adminOf(S1)])).jar;
    assert.equal((await createGuild(w, jar)).status, 201, JSON.stringify(value));
  }
  const { mayCreateGuilds, creationIsOpen, creatorAllowlist, accessOf } = await load('worker/discord.js');
  assert.deepEqual(creatorAllowlist({ GUILD_CREATOR_ALLOWLIST: ' 11 , 22,, ' }), ['11', '22']);
  assert.equal(creationIsOpen({}), true);
  assert.equal(creationIsOpen({ GUILD_CREATOR_ALLOWLIST: '11' }), false);
  assert.equal(mayCreateGuilds({}, '11'), true);
  assert.equal(mayCreateGuilds({}, null), false, 'a guild needs a Discord account');
  assert.equal(mayCreateGuilds({ GUILD_CREATOR_ALLOWLIST: '11' }, '22'), false);
  assert.equal(mayCreateGuilds({ GUILD_CREATOR_ALLOWLIST: '11' }, '11'), true);
  // The permission bits that count: Administrator (0x8) or Manage Server (0x20), or being the owner.
  assert.deepEqual(['8', '32', '40', '2147483647', '0', '1024', 'x', undefined].map((permissions) => accessOf({ owner: false, permissions })),
    ['administrator', 'manage_server', 'administrator', 'administrator', null, null, null, null]);
  assert.equal(accessOf({ owner: true, permissions: '0' }), 'owner');
});

check('the sign-in keeps only the servers the account may create for, and only name, icon and access of each (never the permission bits)', async () => {
  const w = await makeWorld();
  const jar = (await signIn(w, ALICE, [adminOf(S1, { name: 'Admin Hall' }), memberOf(S2), server(S3, { permissions: '32', name: 'Manage Hall' }), server(S4, { permissions: '1024' })])).jar;
  const [row] = await w.rows('SELECT manageable_servers, manageable_until, created_at FROM sessions');
  assert.deepEqual(JSON.parse(row.manageable_servers), [
    { id: S1, name: 'Admin Hall', icon: null, access: 'administrator' },
    { id: S3, name: 'Manage Hall', icon: null, access: 'manage_server' },
  ]);
  assert.equal(row.manageable_until - row.created_at, 30 * 60 * 1000, 'kept for half an hour');
  assert(!/permissions/i.test(row.manageable_servers), 'the bit field is not stored');
  assert.equal(await w.count('user_servers'), 0, 'no membership rows for servers that have no guild');
  assert.deepEqual((await meOf(w, jar)).create.servers.map((entry) => entry.id), [S1, S3]);
  // Half an hour later the list is gone and the page asks for a fresh sign-in; it is never refreshed behind the user's back.
  w.advance(30 * 60 * 1000 + 1);
  assert.deepEqual((await meOf(w, jar)).create, { allowed: false, reason: 'reauth' });
  const stale = await createGuild(w, jar);
  assert.deepEqual([stale.status, stale.json.error], [403, 'reauth_required']);
  const [after] = await w.rows('SELECT manageable_servers FROM sessions');
  assert.equal(after.manageable_servers, null);
});

check('an account without Discord (Battle.net only) cannot create: me says needs_discord and POST /api/guild says to connect Discord', async () => {
  const w = await makeWorld();
  const jar = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  w.db.sqlite.exec('UPDATE users SET discord_id = NULL');
  const me = await meOf(w, jar);
  assert.equal(me.identities.discord, null);
  assert.deepEqual(me.create, { allowed: false, reason: 'needs_discord' });
  const refused = await createGuild(w, jar);
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_allowed_to_create']);
  assert.match(refused.json.message, /needs a Discord account/);
  assert.equal(await w.count('guilds'), 0);
});

check('claim: without an allowlist a server administrator takes a guild that has no Guild Master; a plain member cannot', async () => {
  const s = await scenario();
  s.w.db.sqlite.exec("DELETE FROM role_assignments WHERE role_id = 'guild_master'");
  const bob = s.jars.bob;
  const refused = await s.w.call(bob, 'POST', `${s.path}/claim`, {});
  assert.equal(refused.status, 404, 'Bob does not manage S1, so the guild is not his to claim');
  const erin = (await signIn(s.w, ERIN, [adminOf(S1)])).jar;
  assert.equal((await meOf(s.w, erin)).create.claimable.length, 1);
  const claimed = await s.w.call(erin, 'POST', `${s.path}/claim`, {});
  assert.equal(claimed.status, 200, claimed.text);
  assert.deepEqual(claimed.json.me.roles, [{ role: 'guild_master' }]);
});

// ---------------------------------------------------------------------------
// Limits

check('limits: one account creates at most 5 guilds; the sixth says so, and deleting one frees a place', async () => {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, SERVERS.map((id) => adminOf(id)))).jar;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const made = await createGuild(w, alice, { serverId: SERVERS[i], name: `Guild ${i}` });
    assert.equal(made.status, 201, `${i}: ${made.text}`);
    ids.push(made.json.guild.id);
  }
  assert.deepEqual((await meOf(w, alice)).create.limit, { created: 5, max: 5 });
  const sixth = await createGuild(w, alice, { serverId: S6, name: 'One too many' });
  assert.deepEqual([sixth.status, sixth.json.error], [409, 'guild_limit']);
  assert.match(sixth.json.message, /at most 5 guilds/);
  assert.equal(await w.count('guilds'), 5);
  const gone = await w.call(alice, 'DELETE', `/api/guild/${ids[0]}`, { confirmName: 'Guild 0' });
  assert.equal(gone.status, 200, gone.text);
  assert.equal((await createGuild(w, alice, { serverId: S6, name: 'Room again' })).status, 201);
  // Another account has its own five.
  const bob = (await signIn(w, BOB, [adminOf(S7)])).jar;
  assert.equal((await createGuild(w, bob, { serverId: S7, name: 'Bobs' })).status, 201);
});

check('limits: at most 10 active teams at creation and afterwards; the message names the number', async () => {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const tooMany = await createGuild(w, alice, { multipleTeams: true, teamNames: Array.from({ length: 11 }, (_, i) => `Team ${i}`) });
  assert.deepEqual([tooMany.status, tooMany.json.field], [400, 'teamNames']);
  const ten = await createGuild(w, alice, { multipleTeams: true, teamNames: Array.from({ length: 10 }, (_, i) => `Team ${i}`) });
  assert.equal(ten.status, 201);
  const over = await w.call(alice, 'POST', `/api/guild/${ten.json.guild.id}/teams`, { name: 'Eleventh' });
  assert.deepEqual([over.status, over.json.error], [409, 'team_limit']);
  assert.match(over.json.message, /at most 10 active teams/);
});

check('limits: a guild holds at most 5000 characters (a trigger, so every way of adding one is covered) and the error says so', async () => {
  const s = await scenario();
  const { w } = s;
  // 249 people with 20 characters = 4980, then single-character people up to 4999.
  w.db.sqlite.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 269)
    INSERT INTO players (id, guild_id, status, version, notes_version, created_at, updated_at)
    SELECT 'p_cap' || printf('%019d', i), '${s.guildId}', 'raider', 1, 0, 1, 1 FROM n;
    WITH RECURSIVE a(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM a WHERE i < 249), b(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM b WHERE j < 20)
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, is_main, created_at, updated_at)
    SELECT 'c_cap' || printf('%08d', i * 100 + j), '${s.guildId}', 'p_cap' || printf('%019d', i), '${s.teamId}', 'Cap' || i || 'x' || j, 'cap' || i || 'x' || j,
           'Nightslayer', 'nightslayer', 'WARRIOR', 'Arms', (j = 1), 1, 1 FROM a, b;
    WITH RECURSIVE m(i) AS (SELECT 250 UNION ALL SELECT i + 1 FROM m WHERE i < 269)
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, is_main, created_at, updated_at)
    SELECT 'c_cap' || printf('%08d', i * 100 + 1), '${s.guildId}', 'p_cap' || printf('%019d', i), '${s.teamId}', 'Cap' || i || 'x1', 'cap' || i || 'x1',
           'Nightslayer', 'nightslayer', 'WARRIOR', 'Arms', 1, 1, 1 FROM m;`);
  assert.equal(await w.count('characters', 'guild_id = ?', s.guildId), 4980 + 20);
  // 5000 now: the next one of any kind is refused.
  const person = { teamId: s.teamId, name: 'Lastone', class: 'MAGE', mainSpec: 'Fire', offSpec: null, status: 'raider' };
  const refused = await s.call('alice', 'POST', '/roster', person);
  assert.deepEqual([refused.status, refused.json.error], [409, 'guild_character_limit']);
  assert.match(refused.json.message, /at most 5000 characters/);
  assert.equal(await w.count('characters', 'guild_id = ?', s.guildId), 5000);
  assert.equal(await w.count('players', 'guild_id = ?', s.guildId), 269, 'the person was not created either');
  // An Alt for an existing person is the same cap.
  const alt = await s.call('alice', 'POST', '/roster/p_cap0000000000000000250/characters', { name: 'Altone', class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId: s.teamId, makeMain: false });
  assert.deepEqual([alt.status, alt.json.error], [409, 'guild_character_limit']);
  // Room again: it goes through.
  w.db.sqlite.exec(`DELETE FROM characters WHERE id = 'c_cap${String(269 * 100 + 1).padStart(8, '0')}'`);
  assert.equal((await s.call('alice', 'POST', '/roster', person)).status, 201);
});

check('limits: the 1000-people cap and the 20-characters-per-person cap keep their messages', async () => {
  const { limitError, constraintOf } = await load('worker/routes/roster.js');
  assert.equal(limitError('person_limit').message, 'A guild can have at most 1000 people.');
  assert.equal(limitError('character_limit').message, 'A person can have at most 20 characters.');
  assert.equal(limitError('guild_characters_cap').message, 'A guild can have at most 5000 characters.');
  assert.equal(constraintOf(new Error('D1_ERROR: guild_characters_cap')), 'guild_characters_cap');
  assert.equal(constraintOf(new Error('D1_ERROR: character_limit')), 'character_limit', 'the guild cap text must not read as the per-person cap');
  assert.equal(constraintOf(new Error('D1_ERROR: person_limit')), 'person_limit');
});

// ---------------------------------------------------------------------------
// Setup checklist

const stepsOf = (json) => (json.onboarding ? Object.fromEntries(json.onboarding.steps.map((step) => [step.id, step.done])) : null);

check('onboarding: six steps that tick themselves from the guild\'s data, for the people who set the guild up', async () => {
  const s = await scenario();
  const { w } = s;
  const first = (await s.call('alice', 'GET', '/attention')).json;
  assert.deepEqual(first.onboarding.steps.map((step) => step.id), ['teams', 'roster', 'attendance', 'raid', 'officers', 'loot']);
  assert.deepEqual([first.onboarding.done, first.onboarding.total], [0, 6]);
  assert.deepEqual(stepsOf(first), { teams: false, roster: false, attendance: false, raid: false, officers: false, loot: false }, 'a new single-team guild has done nothing yet');
  assert.equal(first.total, 0, 'the checklist never counts toward the Home badge');

  // teams: a second team (or a renamed one, or a weekly schedule).
  assert.equal((await s.call('alice', 'POST', '/teams', { name: 'Weekend' })).status, 201);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).teams, true);
  assert.equal((await s.call('alice', 'PATCH', `/teams/${(await s.call('alice', 'GET', '')).json.teams[1].id}`, { archived: true })).status, 200);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).teams, false, 'an archived team does not count');
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.teamId}`, { name: 'Raiders' })).status, 200);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).teams, true, 'a renamed Main team does');
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.teamId}`, { name: 'Main team' })).status, 200);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).teams, false);
  assert.equal((await s.call('alice', 'PUT', `/teams/${s.teamId}/schedule`, { slots: [{ weekday: 2, startTime: '20:00' }] })).status, 200);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).teams, true, 'a weekly schedule does');

  // roster: any person.
  const added = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name: 'Thornwick', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(added.status, 201, added.text);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).roster, true);

  // attendance rules: saved once.
  const put = await s.call('alice', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 });
  assert.equal(put.status, 200, put.text);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).attendance, true);

  // a raid.
  const raid = await s.call('alice', 'POST', '/raids', { teamId: s.teamId, raidOn: '2026-10-01', startTime: '20:00', zone: 'Karazhan' });
  assert.equal(raid.status, 201, raid.text);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).raid, true);

  // officers: somebody besides the Guild Master holds a role (by hand), or a Discord role is mapped.
  assert.equal((await s.setRoles('bob', OFFICER)).status, 200);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).officers, true);
  w.db.sqlite.exec("DELETE FROM role_assignments WHERE role_id = 'officer'");
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).officers, false);
  w.db.sqlite.exec(`INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES ('${s.guildId}', '123456789', 'officer', NULL)`);
  assert.equal(stepsOf((await s.call('alice', 'GET', '/attention')).json).officers, true, 'a mapped Discord role counts');

  // loot: every step done hides the card.
  const before = (await s.call('alice', 'GET', '/attention')).json.onboarding;
  assert.deepEqual([before.done, before.total], [5, 6]);
  const raidId = raid.json.raid.id;
  w.db.sqlite.exec(`INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, created_at, updated_at)
    VALUES ('lo_aaaaaaaaaaaaaaaaaaaaaa', '${s.guildId}', '${raidId}', '${s.teamId}', 'checksum01', 1, 'Thing', 1, 'Thornwick', 'thornwick', 'nightslayer', 'WARRIOR', 'MS', 1, 1)`);
  assert.equal((await s.call('alice', 'GET', '/attention')).json.onboarding, null, 'all six done: the card is gone');
});

check('onboarding: only people who set the guild up see it; Dismiss hides it for everyone and sticks', async () => {
  const s = await scenario();
  const { w } = s;
  assert.equal((await s.setRoles('bob', OFFICER)).status, 200);
  assert.equal((await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] })).status, 200);
  assert.notEqual((await s.call('bob', 'GET', '/attention')).json.onboarding, null, 'an Officer holds guild.teams');
  const lead = await s.call('carol', 'GET', '/attention');
  assert.equal(lead.status, 200);
  assert.equal(lead.json.onboarding, null, 'a Team Lead can open Home but does not set the guild up');
  assert.equal((await s.call('carol', 'POST', '/onboarding/dismiss', {})).status, 403);
  assert.equal(await w.count('guilds', 'onboarding_dismissed_at IS NOT NULL'), 0);

  const dismissed = await s.call('bob', 'POST', '/onboarding/dismiss', {});
  assert.deepEqual([dismissed.status, dismissed.json], [200, { ok: true }]);
  assert.equal((await s.call('alice', 'GET', '/attention')).json.onboarding, null, 'hidden for the Guild Master too');
  const [stamp] = await w.rows('SELECT onboarding_dismissed_at AS at FROM guilds WHERE id = ?', s.guildId);
  assert.equal(stamp.at, w.clock.now);
  w.advance(5000);
  assert.equal((await s.call('alice', 'POST', '/onboarding/dismiss', {})).status, 200, 'dismissing twice is fine');
  assert.equal((await w.rows('SELECT onboarding_dismissed_at AS at FROM guilds WHERE id = ?', s.guildId))[0].at, stamp.at, 'the first time stands');
  assert.equal(await w.count('audit_log', "action LIKE 'guild.%' AND action != 'guild.create'"), 0, 'nothing audited for hiding a card');
});

// ---------------------------------------------------------------------------
// Export

async function richGuild() {
  const s = await scenario();
  const { w } = s;
  assert.equal((await s.setRoles('bob', OFFICER)).status, 200);
  const people = {};
  for (const [key, name, cls, spec, discord, nick] of [['thorn', 'Thornwick', 'WARRIOR', 'Arms', '111111111111111111', 'ThornNick'], ['mend', 'Mendra', 'SHAMAN', 'Enhancement', '222222222222222222', 'MendNick']]) {
    const made = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider' });
    assert.equal(made.status, 201, made.text);
    people[key] = made.json.person.id;
    w.db.sqlite.exec(`UPDATE players SET discord_user_id = '${discord}', discord_nickname = '${nick}', notes = 'Secret note about ${name}' WHERE id = '${people[key]}'`);
  }
  const raid = await s.call('alice', 'POST', '/raids', { teamId: s.teamId, raidOn: '2026-10-01', startTime: '20:00', zone: 'Karazhan' });
  assert.equal(raid.status, 201, raid.text);
  const raidId = raid.json.raid.id;
  const manual = await s.call('alice', 'PUT', `/raids/${raidId}/manual`, { reason: 'Seed night', presentPlayerIds: [people.thorn] });
  assert.equal(manual.status, 200, manual.text);
  w.db.sqlite.exec(`
    INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES ('${raidId}', '${s.guildId}', 'AbCdEfGhIjKlMnOp', 'classic', 1, 2, 'Uploader', 3);
    INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id, player_id)
      VALUES ('${raidId}', 'raid_helper', 1, '333333333333333333', 'SignupNick', 'signed', 'Warrior', 'Arms', 1, '${s.guildId}', '${people.thorn}');
    INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, note, created_at, updated_at)
      VALUES ('lo_aaaaaaaaaaaaaaaaaaaaaa', '${s.guildId}', '${raidId}', '${s.teamId}', 'checksum01', 28830, 'Dragonspine Trophy', 5, 'Thornwick', 'thornwick', 'nightslayer', 'WARRIOR', 'MS', 'Loot officer note', 1, 1);
    INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${s.ids.carol}', '987654321', 'Carol#4242', 1, '{}', 1);`);
  const link = await s.call('alice', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d' });
  assert.equal(link.status, 201, link.text);
  const cal = await s.call('bob', 'POST', '/calendar', { teamId: s.teamId });
  assert.equal(cal.status, 201, cal.text);
  s.people = people;
  s.raidId = raidId;
  s.guestToken = link.json.created.token;
  s.calUrl = cal.json.url;
  return s;
}

check('export: the Guild Master gets the roster, raids, attendance and loot as one JSON file, named for the guild and the day', async () => {
  const s = await richGuild();
  const res = await s.w.call(s.jars.alice, 'GET', `${s.path}/export`);
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('Content-Type'), /^application\/json/);
  assert.match(res.headers.get('Content-Disposition'), /^attachment; filename="raidsmith-guild-ember-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const file = res.json;
  assert.deepEqual([file.format, file.version], ['raidsmith-guild-export', 1]);
  assert.match(file.exportedAt, /^2027-/);
  assert.deepEqual(file.guild, { name: 'Ember', realm: 'Nightslayer', realmKind: 'realm', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', createdAt: file.guild.createdAt });
  assert.deepEqual(file.teams.map((team) => [team.id, team.name, team.archived]), [[s.teamId, 'Main team', false]]);
  assert.deepEqual(file.people.map((p) => p.characters.map((c) => c.name)), [['Thornwick'], ['Mendra']]);
  assert.deepEqual(file.people[0].characters[0], { id: file.people[0].characters[0].id, name: 'Thornwick', realm: 'Nightslayer', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, isMain: true, teamId: s.teamId });
  assert.equal(file.people[0].notes, 'Secret note about Thornwick', 'the Guild Master may read every note');
  assert.equal(file.raids.length, 1);
  assert.deepEqual(file.raids[0].reports.map((r) => r.code), ['AbCdEfGhIjKlMnOp']);
  assert.equal(file.raids[0].attendanceBy, 'hand');
  assert(file.attendance.some((row) => row.personId === s.people.thorn && row.attended === true));
  assert.deepEqual(file.signups.map((row) => [row.kind, row.className, row.specName, row.personId]), [['signed', 'Warrior', 'Arms', s.people.thorn]]);
  assert.deepEqual(file.loot.map((row) => [row.itemName, row.winner, row.tag, row.note]), [['Dragonspine Trophy', 'Thornwick', 'MS', 'Loot officer note']]);
  assert(Array.isArray(file.excludes) && file.excludes.length >= 4);
  assert.equal(await s.w.count('audit_log', "action = 'guild.export'"), 1);
  const [row] = await s.w.rows("SELECT guild_id, actor_user_id, entity_id FROM audit_log WHERE action = 'guild.export'");
  assert.deepEqual([row.guild_id, row.actor_user_id, row.entity_id], [s.guildId, s.ids.alice, s.guildId]);
});

check('export: nothing of anybody\'s Discord, accounts, Battle.net, guest links or calendar links reaches the file', async () => {
  const s = await richGuild();
  const { w } = s;
  const res = await w.call(s.jars.alice, 'GET', `${s.path}/export`);
  assert.equal(res.status, 200);
  const text = res.text;
  const discordIds = (await w.rows('SELECT discord_id FROM users')).map((row) => row.discord_id);
  const forbidden = [
    ...discordIds,                                                       // every account's Discord ID, the exporter's own too
    '111111111111111111', '222222222222222222', '333333333333333333',   // Discord IDs on roster people and a sign-up
    'ThornNick', 'MendNick', 'SignupNick',                               // their nicknames
    ...(await w.rows('SELECT username FROM users')).map((row) => row.username),
    ...(await w.rows('SELECT account_key FROM users')).map((row) => row.account_key),
    ...(await w.rows('SELECT id FROM users')).map((row) => row.id),     // no user ids at all
    'Carol#4242', '987654321',                                           // Battle.net
    s.guestToken, ...(await w.rows('SELECT token_hash FROM guest_links')).map((row) => row.token_hash),
    ...(await w.rows('SELECT token_hash FROM calendar_tokens')).map((row) => row.token_hash), new URL(s.calUrl).pathname.replace('/cal/', ''),
    'discord_user_id', 'discordUserId', 'account_key', 'token_hash', 'bnet', 'battletag',
  ];
  for (const value of forbidden) assert(!text.includes(value), `the export leaks ${value}`);
});

check('export: notes, decision reasons and loot notes only for what the exporter may read', async () => {
  const s = await richGuild();
  const { w } = s;
  w.db.sqlite.exec(`INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, reason, flags, decided_by, decided_at)
    VALUES ('${s.raidId}', '${s.people.mend}', '${s.guildId}', 'missed_notice', 1, 'Told us on Discord', '[]', NULL, 9)`);
  const { buildGuildExport } = await load('worker/guild-export.js');
  const guildRow = (await w.rows('SELECT * FROM guilds WHERE id = ?', s.guildId))[0];
  const exportFor = (can) => buildGuildExport(w.db, { guild: guildRow, can }, w.clock.now);

  const everything = await exportFor({ 'roster.notes.view': 'guild', 'attendance.review': 'guild', 'loot.edit': 'guild' });
  assert.deepEqual(everything.people.map((p) => p.notes), ['Secret note about Thornwick', 'Secret note about Mendra']);
  assert.deepEqual(everything.attendanceDecisions.map((d) => d.reason), ['Told us on Discord']);
  assert.deepEqual(everything.loot.map((l) => l.note), ['Loot officer note']);

  const nothing = await exportFor({ 'roster.view': 'guild' });
  assert(nothing.people.every((p) => !('notes' in p)), 'no notes without roster.notes.view');
  assert.deepEqual(nothing.attendanceDecisions, [], 'no reasons without attendance.review');
  assert(nothing.loot.every((l) => !('note' in l)), 'no loot notes without loot.edit');
  assert(!JSON.stringify(nothing).includes('Secret note') && !JSON.stringify(nothing).includes('Told us') && !JSON.stringify(nothing).includes('Loot officer note'));

  // Team scope: another team's notes stay closed. Move Mendra's main character to a second team the exporter cannot read.
  const other = await s.call('alice', 'POST', '/teams', { name: 'Weekend' });
  w.db.sqlite.exec(`UPDATE characters SET team_id = '${other.json.team.id}' WHERE player_id = '${s.people.mend}'`);
  const scoped = await exportFor({ 'roster.notes.view': [s.teamId], 'attendance.review': [s.teamId] });
  assert.deepEqual(scoped.people.map((p) => ('notes' in p)), [true, false], 'Thornwick\'s home team is readable, Mendra\'s is not');
});

check('export: only the Guild Master (403 for an Officer or a member); a whole-guild read is rate limited; a stranger gets nothing', async () => {
  const s = await richGuild();
  for (const who of ['bob', 'carol']) {
    const refused = await s.call(who, 'GET', '/export');
    assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], who);
  }
  assert.equal((await s.w.call(newJar(), 'GET', `${s.path}/export`)).status, 401);
  assert.equal(await s.w.count('audit_log', "action = 'guild.export'"), 0, 'a refused export is not audited');
  for (let i = 0; i < 5; i++) assert.equal((await s.call('alice', 'GET', '/export')).status, 200, `export ${i + 1}`);
  const sixth = await s.call('alice', 'GET', '/export');
  assert.deepEqual([sixth.status, sixth.json.error], [429, 'rate_limited']);
  assert.match(sixth.json.message, /Too many guild data exports/);
  assert(sixth.headers.get('Retry-After'));
  s.w.advance(15 * 60 * 1000 + 1000);
  assert.equal((await s.call('alice', 'GET', '/export')).status, 200, 'the window passes');
});

// ---------------------------------------------------------------------------
// Delete

check('delete: the Guild Master types the name; everything of the guild goes, nothing of another guild does', async () => {
  const s = await richGuild();
  const { w } = s;
  // A second guild that must survive untouched, owned by Erin (administrator of S2).
  const erin = (await signIn(w, ERIN, [adminOf(S2)])).jar;
  const other = await createGuild(w, erin, { serverId: S2, name: 'Other Guild' });
  assert.equal(other.status, 201, other.text);
  const otherId = other.json.guild.id;
  assert.equal((await w.call(erin, 'POST', `/api/guild/${otherId}/roster`, { teamId: other.json.teams[0].id, name: 'Zedrik', class: 'ROGUE', mainSpec: 'Combat', offSpec: null, status: 'raider' })).status, 201);
  const tablesOf = (id) => Object.fromEntries(w.tablesWithColumn('guild_id').map((table) => [table, w.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(id).n]));
  const otherBefore = tablesOf(otherId);
  const mineBefore = tablesOf(s.guildId);
  const raidIds = (await w.rows('SELECT id FROM raids WHERE guild_id = ?', s.guildId)).map((row) => row.id);
  assert(raidIds.length > 0);
  assert(mineBefore.players > 0 && mineBefore.raids > 0 && mineBefore.loot_awards > 0 && mineBefore.guest_links > 0 && mineBefore.calendar_tokens > 0);

  for (const who of ['bob', 'carol']) {
    const refused = await s.call(who, 'DELETE', '', { confirmName: 'Ember' });
    assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], who);
  }
  for (const body of [{}, { confirmName: '' }, { confirmName: 'ember' }, { confirmName: 'Ember!' }, { confirmName: 5 }, { confirmName: null }]) {
    const wrong = await s.call('alice', 'DELETE', '', body);
    assert.deepEqual([wrong.status, wrong.json.error, wrong.json.field], [400, 'confirm_mismatch', 'confirmName'], JSON.stringify(body));
  }
  assert.equal(await w.count('guilds', 'id = ?', s.guildId), 1, 'nothing was deleted by the refusals');
  assert.equal((await w.call(newJar(), 'DELETE', s.path, { confirmName: 'Ember' })).status, 401);

  const gone = await s.call('alice', 'DELETE', '', { confirmName: ' Ember ' });
  assert.deepEqual([gone.status, gone.json], [200, { ok: true }], 'surrounding spaces are forgiven');
  for (const table of w.tablesWithColumn('guild_id')) {
    if (table === 'audit_log') continue;
    assert.equal(w.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(s.guildId).n, 0, `${table} still has rows of the deleted guild`);
  }
  for (const table of w.tablesWithColumn('raid_id')) {
    assert.equal(w.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE raid_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(raidIds)).n, 0, `${table} still has rows of the deleted guild's raids`);
  }
  assert.deepEqual(tablesOf(otherId), otherBefore, 'the other guild is untouched');
  assert.equal(await w.count('user_servers', 'server_id = ?', S1), 0, 'the Discord server keeps no membership rows');
  const [audit] = await w.rows("SELECT guild_id, actor_user_id, entity_id FROM audit_log WHERE action = 'guild.delete'");
  assert.deepEqual([audit.guild_id, audit.actor_user_id, audit.entity_id], [null, s.ids.alice, s.guildId], 'the record outlives the guild with no guild on it');
  assert.equal((await s.call('alice', 'GET', '')).status, 404);
  assert.equal((await s.w.call(s.jars.bob, 'GET', `${s.path}/roster`)).status, 404);
  assert.equal((await s.call('alice', 'DELETE', '', { confirmName: 'Ember' })).status, 404, 'a second delete finds nothing');
  assert.equal((await meOf(w, s.jars.alice)).guilds.length, 0);
  // The server is free again: the same Discord administrator can make a fresh guild for it.
  assert.equal((await meOf(w, s.jars.alice)).create.servers.map((entry) => entry.id).join(), S1);
  const again = await createGuild(w, s.jars.alice, { name: 'Ember reborn' });
  assert.equal(again.status, 201, again.text);
  assert.equal(await w.count('players', 'guild_id = ?', again.json.guild.id), 0, 'a clean start');
});

check('delete: custom roles, mapped Discord roles and role assignments go with the guild', async () => {
  const s = await scenario();
  const made = await s.call('alice', 'POST', '/roles', { name: 'Council', permissions: { 'loot.view': 'guild' } });
  assert.equal(made.status, 201, made.text);
  const role = made.json.roles.find((entry) => entry.name === 'Council').id;
  assert.equal((await s.call('alice', 'PUT', '/discord/maps', { maps: [{ discordRoleId: '777', roleId: role, teamId: null }] })).status, 200);
  assert.equal((await s.setRoles('bob', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: role, teamId: null }] })).status, 200);
  assert.equal((await s.call('alice', 'DELETE', '', { confirmName: 'Ember' })).status, 200);
  assert.equal(await s.w.count('roles', 'id = ?', role), 0);
  assert.equal(await s.w.count('discord_role_maps'), 0);
  assert.equal(await s.w.count('role_assignments'), 0);
});

// ---------------------------------------------------------------------------

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
