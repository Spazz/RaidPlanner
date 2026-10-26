/**
 * Raidsmith guild tracker - accounts with linked sign-ins (Phase 7a), Worker tests
 * Run: node tests/guild/guild-accounts-worker-tests.js
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs every migration, 0012_accounts.sql included), with
 * Discord faked by an injected fetch and Battle.net by tools/fake-battlenet.js on a local port. Covers: the membership rule (pure, and the SQL
 * against it), migration 0012 on a populated database, signing up and in with Battle.net, linking and unlinking Discord, the state of every
 * flow, the last-identity and cross-account rules, membership through a roster link, the officers' account link and look-up, claims, Delete my
 * data and the display name. No network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { createFakeBattlenet } = require('../../tools/fake-battlenet');

const ROOT = require('path').join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';
const DAY = 24 * 60 * 60 * 1000;

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  gina: { id: '110000000000000006', username: 'gina', globalName: 'Gina G' },
  gale: { id: '110000000000000009', username: 'gale', globalName: 'Gale G' },
};
// Battle.net accounts. holly and ivan sign up with Battle.net only; erin, gina and gale link one to a Discord account.
const BNET = {
  holly: { id: '700000001', battletag: 'Holly#1111' },
  ivan: { id: '700000002', battletag: 'Ivan#2222' },
  erin: { id: '500000005', battletag: 'Erin#0005' },
  gina: { id: '500000006', battletag: 'Gina#0006' },
  gale: { id: '700000009', battletag: 'Gale#0009' },
};

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const openWorlds = [];

function makeDiscord() {
  const state = { next: null, calls: [], tokens: new Map() };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    state.calls.push({ url: String(url) });
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${state.calls.length}`;
      state.tokens.set(token, state.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec(init.headers && init.headers.Authorization || '');
    const session = bearer && state.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  return state;
}

function absorbCookies(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}

async function makeWorld({ allowlist = [], env = {}, migrationsDir } = {}) {
  const { createApp } = await load('worker/index.js');
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  const db = createD1Fake(migrationsDir ? { migrationsDir } : undefined);
  const discord = makeDiscord();
  const bnet = createFakeBattlenet();
  await new Promise((resolve) => bnet.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bnet.server.address().port}`;
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const fullEnv = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: allowlist.join(','),
    BNET_CLIENT_ID: 'bnet-id',
    BNET_CLIENT_SECRET: 'bnet-secret',
    BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`,
    BNET_API_BASE: base,
    ...env,
  };
  const fetchRouter = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return fetch(url, init);
    return discord.fetch(url, init);
  };
  const logs = [];
  const app = createApp({ db, env: fullEnv, fetch: fetchRouter, now: () => clock.now, randomBytes, log: (message) => logs.push(message) });
  const world = {
    db, discord, bnet, clock, env: fullEnv, logs, app,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body, headers = {}, rawBody } = {}) {
      const init = { method, headers: { ...headers } };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
        init.body = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${ORIGIN}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      return response;
    },
    async call(jar, method, urlPath, body, extra = {}) {
      const response = await world.req(method, urlPath, { jar, body, ...extra });
      let json = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json, headers: response.headers };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) {
      return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
    },
    asked(kind, pathPrefix) { return bnet.state.requests.filter((r) => (!kind || r.token === kind) && (!pathPrefix || r.path.startsWith(pathPrefix))); },
  };
  openWorlds.push(world);
  return world;
}

const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');
const locationOf = (response) => response.headers.get('Location');

// Discord sign-in (the real routes).
async function signIn(world, person, servers = [], jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: person.avatar || null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return jar;
}

// Battle.net link by a signed-in member.
async function bnetLink(world, jar, account) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login', { jar });
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { login, callback };
}

// Battle.net sign-in or sign-up: nobody needs to be signed in.
async function bnetSignIn(world, account, jar = {}) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { jar, login, callback };
}

// Discord link by a signed-in account.
async function discordLink(world, jar, person, servers = []) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login?mode=link', { jar });
  const callback = await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { login, callback };
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

// Alice (Guild Master) creates a TBC US Dreamscythe guild with two teams; Bob is Officer, Carol Team Lead of Alpha, Dave Team Lead of Bravo;
// Erin and Gina are Members (in the Discord server).
async function scenario() {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  [s.A, s.B] = s.teams;
  for (const name of ['bob', 'carol', 'dave', 'erin', 'gina']) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.A] })).status, 200);
  assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.B] })).status, 200);
  return s;
}

// A Battle.net-only member of the scenario: signs up, and the id of the new account.
async function signUpHolly(s, name = 'holly') {
  const { jar } = await bnetSignIn(s.w, BNET[name]);
  s.jars[name] = jar;
  s.ids[name] = (await s.w.call(jar, 'GET', '/auth/me')).json.user.id;
  return jar;
}

const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const linkAccount = (s, who, personId, userId) => s.call(who, 'PUT', `/roster/${personId}/account`, { userId });
const claimBody = (...names) => ({ characters: names.map((name) => ({ name, realmSlug: name === 'Cassia' || name === 'Fenwick' ? 'nightslayer' : 'dreamscythe' })) });
const approveBody = (kind, extra = {}) => ({ expectedKind: kind, ...extra });

// A claim waiting for an officer, made the way the Worker made one before claims applied at once (characters/teams decision D2): the rows alone. The
// officers' side is tested on these; the claims a member makes now are in guild-bnet-worker-tests.js and guild-b3-claims-tests.js.
let pendSeq = 0;
async function pendClaim(s, who, name) {
  const view = (await s.w.call(s.jars[who], 'GET', '/auth/bnet')).json.guilds[0];
  const found = view.characters.find((c) => c.name === name);
  assert(found, `${name} is on the list of ${who}`);
  const id = `cl_${String(++pendSeq).padStart(22, 'p')}`;
  s.w.db.sqlite.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
    VALUES ('${id}', '${s.guildId}', '${s.ids[who]}', '${found.name}', '${found.name.toLowerCase()}', '${found.realm}', '${found.realmSlug.replace(/-/g, '')}', '${found.class}', ${found.level}, 'pending', ${s.w.clock.now})`);
  return { status: 201, json: { claims: [{ id, name: found.name, status: 'pending' }] } };
}

// ---------------------------------------------------------------------------
// The membership rule

check('membership rule (pure): blocked wins; otherwise in the Discord server OR linked to a roster person', async () => {
  const { membershipOf, isOwnPlayer } = await load('worker/membership.js');
  const results = [];
  for (const blocked of [false, true]) for (const inServer of [false, true]) for (const linked of [false, true]) results.push([blocked, inServer, linked, membershipOf({ blocked, inServer, linked })]);
  assert.deepEqual(results, [
    [false, false, false, 'none'], [false, false, true, 'member'], [false, true, false, 'member'], [false, true, true, 'member'],
    [true, false, false, 'blocked'], [true, false, true, 'blocked'], [true, true, false, 'blocked'], [true, true, true, 'blocked'],
  ]);
  // My person: linked to my account, or carrying my Discord ID. A Battle.net-only account has no Discord ID to match.
  const viewer = { userId: 'u_me', discordId: '123' };
  assert.equal(isOwnPlayer({ user_id: 'u_me', discord_user_id: null }, viewer), true);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: '123' }, viewer), true);
  assert.equal(isOwnPlayer({ user_id: 'u_other', discord_user_id: '999' }, viewer), false);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: null }, viewer), false);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: '123' }, { userId: 'u_me', discordId: null }), false, 'no Discord, no Discord match');
  assert.equal(isOwnPlayer({ user_id: 'u_me', discord_user_id: null }, { userId: 'u_me', discordId: null }), true);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: null }, { userId: 'u_me', discordId: null }), false, 'null never equals null');
  assert.equal(isOwnPlayer(null, viewer), false);
});

check('membership rule (SQL): the fragments agree with the pure rule for every combination, and the candidate set holds only those who can be members', async () => {
  const { membershipOf, memberSql, reachesGuildSql, memberCandidatesSql, boundMember, boundReaches, blockedSql } = await load('worker/membership.js');
  const w = await makeWorld();
  const exec = (sql) => w.db.sqlite.exec(sql);
  exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
        VALUES ('g1', 'G', 'R', 'realm', 'US', 'srv1', 'UTC', 'tbc', 1), ('g2', 'H', 'R', 'realm', 'US', 'srv2', 'UTC', 'tbc', 1)`);
  exec(`INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T', 25, 0, 1), ('t2', 'g2', 'T', 25, 0, 1)`);
  let n = 0;
  const cases = [];
  for (const blocked of [false, true]) for (const inServer of [false, true]) for (const linked of [false, true]) {
    const id = `u_case${n++}`;
    exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('${id}', '${id}', ${inServer ? `'${1000 + n}'` : 'NULL'}, '${id}', 1, 1)`);
    if (inServer) exec(`INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('${id}', 'srv1', 1)`);
    if (linked) exec(`INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p_${id}', 'g1', 'raider', '${id}', 1, 1)`);
    if (blocked) exec(`INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('g1', '${id}', 1)`);
    cases.push({ id, blocked, inServer, linked });
  }
  // Linked or in the server of the OTHER guild only: not a member of g1.
  exec(`INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES ('u_elsewhere', 'u_elsewhere', 'e', 1, 1)`);
  exec(`INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('u_elsewhere', 'srv2', 1)`);
  exec(`INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p_else', 'g2', 'raider', 'u_elsewhere', 1, 1)`);
  const rule = (await w.rows(
    `SELECT u.id, ${memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member, ${reachesGuildSql('u.id', 'g.id', 'g.discord_server_id')} AS reaches,
            ${blockedSql('u.id', 'g.id')} AS blocked FROM users u, guilds g WHERE g.id = 'g1' ORDER BY u.id`,
  ));
  for (const c of cases) {
    const row = rule.find((r) => r.id === c.id);
    const expected = membershipOf(c);
    assert.equal(row.member === 1, expected === 'member', `${JSON.stringify(c)} member`);
    assert.equal(row.reaches === 1, c.inServer || c.linked, `${JSON.stringify(c)} reaches`);
    assert.equal(row.blocked === 1, c.blocked, `${JSON.stringify(c)} blocked`);
    const bound = boundMember(c.id, 'g1', 'srv1');
    assert.equal((await w.db.prepare(`SELECT ${bound.sql} AS ok`).bind(...bound.params).first()).ok === 1, expected === 'member', `${JSON.stringify(c)} bound member`);
    const reach = boundReaches(c.id, 'g1', 'srv1');
    assert.equal((await w.db.prepare(`SELECT ${reach.sql} AS ok`).bind(...reach.params).first()).ok === 1, c.inServer || c.linked, `${JSON.stringify(c)} bound reaches`);
  }
  assert.equal(rule.find((r) => r.id === 'u_elsewhere').member, 0, 'the other guild\'s members are not members of this one');
  const candidates = (await w.rows(`SELECT user_id FROM (${memberCandidatesSql("'g1'", "'srv1'")}) ORDER BY user_id`)).map((r) => r.user_id);
  assert.deepEqual(candidates, cases.filter((c) => c.inServer || c.linked).map((c) => c.id).sort());
});

// ---------------------------------------------------------------------------
// Migration 0012

// Every table that holds a foreign key to users, with the seed row that fills it. A future migration that adds another one fails the
// "every foreign key to users is seeded" check below: extend the seed, so the populated-database test keeps covering it.
function seedPopulated(db) {
  db.sqlite.exec(`
    INSERT INTO users (id, discord_id, username, global_name, avatar, prefs, created_at, last_seen_at)
      VALUES ('u_a', '110000000000000001', 'alice', 'Alice A', NULL, '{}', 10, 20), ('u_b', '110000000000000002', 'bob', NULL, 'abc', '{"lastGuildId":"g_1"}', 11, 21), ('u_c', '110000000000000003', 'carol', 'Carol', NULL, '{}', 12, 22);
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h_a', 'u_a', 1, 9999999999999), ('h_b', 'u_b', 1, 9999999999999);
    INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('u_a', 'srv1', 1), ('u_b', 'srv1', 1), ('u_c', 'srv1', 1);
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_by, created_at)
      VALUES ('g_1', 'Ember', 'Dreamscythe', 'realm', 'US', 'srv1', 'UTC', 'tbc', 'u_a', 5);
    INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t_1', 'g_1', 'Main', 25, 0, 5);
    INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
      VALUES ('ra_1', 'g_1', 'u_a', 'guild_master', NULL, 'u_a', 6), ('ra_2', 'g_1', 'u_b', 'officer', NULL, 'u_a', 7);
    INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('g_1', 'u_c', 'u_b', 'because', 8);
    INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, created_at) VALUES ('al_1', 'g_1', 'u_a', 'guild.create', 'guild', 'g_1', 9);
    INSERT INTO players (id, guild_id, status, discord_user_id, notes, notes_updated_by, notes_updated_at, created_by, created_at, updated_at)
      VALUES ('p_1', 'g_1', 'raider', '110000000000000002', 'note', 'u_b', 30, 'u_a', 31, 32);
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at)
      VALUES ('c_1', 'g_1', 'p_1', 't_1', 'Aldric', 'aldric', 'Dreamscythe', 'dreamscythe', 'WARRIOR', 1, 33, 33);
    INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_by, updated_at) VALUES ('ap_1', 'g_1', NULL, '{}', 1, 'u_b', 40);
    INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, manual_by, manual_at, created_by, created_at, updated_at)
      VALUES ('r_1', 'g_1', 't_1', '2027-01-05', 41, 'manual', 'no logs today', 'u_b', 42, 'u_a', 43, 43);
    INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_by, created_at) VALUES ('g_1', 'guest', 'dreamscythe', 'Guest', 'u_b', 44);
    INSERT INTO raid_signups (raid_id, source, signup_id, kind, class_name, spec_name, position, guild_id, player_id, character_id, note, updated_by, created_at, updated_at)
      VALUES ('r_1', 'raidsmith', 1, 'signed', 'Warrior', 'Arms', 1, 'g_1', 'p_1', 'c_1', 'on my way', 'u_b', 60, 61);
    INSERT INTO team_schedules (id, guild_id, team_id, weekday, start_time, zone, title, created_at) VALUES ('ts_1', 'g_1', 't_1', 2, '20:00', 'Karazhan', 'Tuesday', 62);
    INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, reason, flags, decided_by, decided_at)
      VALUES ('r_1', 'p_1', 'g_1', 'present', 'was there', '[]', 'u_a', 45);
    INSERT INTO roadmap_ideas (id, title, area, submitted_by, created_at, updated_at) VALUES ('ri_1', 'An idea', 'other', 'u_c', 46, 46);
    INSERT INTO loot_policies (id, guild_id, team_id, policy, version, updated_by, updated_at) VALUES ('lp_1', 'g_1', NULL, '{}', 1, 'u_a', 47);
    INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, winner_name, winner_name_key, tag, tag_set_by, tag_set_at, created_by, created_at, updated_at)
      VALUES ('lo_1', 'g_1', 'r_1', 't_1', 'abcdefgh12', 1234, 48, 'Aldric', 'aldric', 'MS', 'u_a', 49, 'u_b', 50, 50);
    INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('u_b', '555', 'Bob#5555', 51, '{}', 52);
    INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, decided_by, decided_at, created_at)
      VALUES ('cl_1', 'g_1', 'u_b', 'Brindle', 'brindle', 'Dreamscythe', 'dreamscythe', 'MAGE', 70, 'approved', 'u_a', 54, 53),
             ('cl_2', 'g_1', 'u_c', 'Cassia', 'cassia', 'Dreamscythe', 'dreamscythe', 'PRIEST', 68, 'pending', NULL, NULL, 55);
  `);
}

const COLUMNS_SEEDED = [
  'audit_log.actor_user_id', 'attendance_decisions.decided_by', 'attendance_guests.created_by', 'attendance_policies.updated_by', 'bnet_links.user_id',
  'character_claims.decided_by', 'character_claims.user_id', 'guild_blocks.blocked_by', 'guild_blocks.user_id', 'guilds.created_by',
  'loot_awards.created_by', 'loot_awards.tag_set_by', 'loot_policies.updated_by', 'players.created_by', 'players.notes_updated_by',
  'raid_signups.updated_by', 'raids.created_by', 'raids.manual_by', 'role_assignments.assigned_by', 'role_assignments.user_id', 'roadmap_ideas.submitted_by', 'sessions.user_id',
  'user_servers.user_id',
];

const foreignKeysToUsers = (db) => db.sqlite.prepare(
  `SELECT m.name AS tbl, f."from" AS col, f.on_delete AS on_delete FROM sqlite_master m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND f."table" = 'users' ORDER BY m.name, f."from"`,
).all().map((row) => ({ ...row }));

const dumpAll = (db) => {
  const out = {};
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    const columns = db.sqlite.prepare(`SELECT name FROM pragma_table_info('${name}') ORDER BY cid`).all().map((c) => c.name);
    out[name] = { columns, rows: db.sqlite.prepare(`SELECT * FROM ${name} ORDER BY ${columns.map((c) => `"${c}"`).join(', ')}`).all().map((r) => ({ ...r })) };
  }
  return out;
};

check('migration 0012 on a populated 0011 database: every row of every table survives, every foreign key still points at users, discord_id is nullable and unique', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0012-'));
  try {
    const migrations = path.join(ROOT, 'migrations');
    const accounts = '0012_accounts.sql';
    assert(fs.existsSync(path.join(migrations, accounts)));
    for (const name of fs.readdirSync(migrations)) if (name.endsWith('.sql') && name < accounts) fs.copyFileSync(path.join(migrations, name), path.join(dir, name));
    const db = createD1Fake({ migrationsDir: dir });
    seedPopulated(db);

    // Every foreign key that points at users is one the seed fills (so a future migration's new one cannot slip past this test).
    const fks = foreignKeysToUsers(db);
    assert.deepEqual(fks.map((fk) => `${fk.tbl}.${fk.col}`).sort(), COLUMNS_SEEDED.slice().sort(), 'extend seedPopulated and COLUMNS_SEEDED for a new foreign key to users');
    for (const fk of fks) {
      const filled = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${fk.tbl} WHERE ${fk.col} IS NOT NULL`).get().n;
      assert(filled >= 1, `${fk.tbl}.${fk.col} has a seeded row`);
    }
    const before = dumpAll(db);
    const counts = Object.fromEntries(Object.entries(before).map(([table, dump]) => [table, dump.rows.length]));

    db.sqlite.exec(fs.readFileSync(path.join(migrations, accounts), 'utf8'));
    const after = dumpAll(db);

    // Every table but users and players is byte for byte what it was; players gained user_id (NULL everywhere); users is checked below.
    for (const table of Object.keys(before)) {
      if (table === 'users' || table === 'players') continue;
      assert.deepEqual(after[table], before[table], `${table} is untouched`);
    }
    assert.deepEqual(after.players.columns, [...before.players.columns, 'user_id']);
    assert.deepEqual(after.players.rows.map(({ user_id, ...row }) => row), before.players.rows);
    assert(after.players.rows.every((row) => row.user_id === null));
    assert.deepEqual(Object.keys(after), Object.keys(before), 'no table was added or dropped');
    for (const [table, n] of Object.entries(counts)) assert.equal(after[table].rows.length, n, `${table}: row count`);

    // users: the old columns are what they were (discord_id's old values now live in account_key AND the new nullable discord_id).
    assert.deepEqual(after.users.columns, ['id', 'account_key', 'username', 'global_name', 'avatar', 'prefs', 'created_at', 'last_seen_at', 'discord_id', 'display_name']);
    assert.deepEqual(after.users.rows.map((r) => [r.id, r.account_key, r.discord_id, r.display_name]).sort(), [
      ['u_a', '110000000000000001', '110000000000000001', null], ['u_b', '110000000000000002', '110000000000000002', null], ['u_c', '110000000000000003', '110000000000000003', null],
    ]);
    for (const [index, old] of before.users.rows.entries()) {
      const row = after.users.rows[index];
      assert.deepEqual({ id: row.id, username: row.username, global_name: row.global_name, avatar: row.avatar, prefs: row.prefs, created_at: row.created_at, last_seen_at: row.last_seen_at },
        { id: old.id, username: old.username, global_name: old.global_name, avatar: old.avatar, prefs: old.prefs, created_at: old.created_at, last_seen_at: old.last_seen_at });
    }

    // Foreign keys: the same set, the same actions, still referencing users, and nothing dangling.
    const expectedFks = [...fks, { tbl: 'players', col: 'user_id', on_delete: 'SET NULL' }].sort((a, b) => (a.tbl + a.col < b.tbl + b.col ? -1 : 1));
    assert.deepEqual(foreignKeysToUsers(db), expectedFks, 'every foreign key to users, with its ON DELETE action, plus the new players.user_id');
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const playersFk = db.sqlite.prepare("SELECT \"from\", \"table\", on_delete FROM pragma_foreign_key_list('players') WHERE \"from\" = 'user_id'").all();
    assert.deepEqual(playersFk.map((r) => ({ ...r })), [{ from: 'user_id', table: 'users', on_delete: 'SET NULL' }]);

    // The new rules: discord_id can be NULL (any number of times) and stays unique when present; account_key stays unique.
    const insert = (id, discord) => db.sqlite.exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('${id}', '${id}', ${discord}, '${id}', 1, 1)`);
    insert('u_n1', 'NULL');
    insert('u_n2', 'NULL');
    assert.throws(() => insert('u_dup', "'110000000000000001'"), /UNIQUE/);
    assert.throws(() => db.sqlite.exec("INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u_k', 'u_n1', NULL, 'k', 1, 1)"), /UNIQUE/);
    assert.throws(() => db.sqlite.exec("UPDATE users SET display_name = '' WHERE id = 'u_a'"), /CHECK/);
    assert.throws(() => db.sqlite.exec(`UPDATE users SET display_name = '${'x'.repeat(33)}' WHERE id = 'u_a'`), /CHECK/);
    db.sqlite.exec("UPDATE users SET display_name = 'Ally' WHERE id = 'u_a'");
    // players.user_id: one person per account in a guild, and the account's deletion clears it.
    db.sqlite.exec("INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p_2', 'g_1', 'raider', 'u_n1', 1, 1)");
    assert.throws(() => db.sqlite.exec("INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p_3', 'g_1', 'raider', 'u_n1', 1, 1)"), /UNIQUE/);
    db.sqlite.exec("DELETE FROM users WHERE id = 'u_n1'");
    assert.equal(db.sqlite.prepare("SELECT user_id FROM players WHERE id = 'p_2'").get().user_id, null);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'p_2'").get().n, 1, 'the person stays');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('migration 0012 does not rebuild users: the usual DROP TABLE rebuild empties every table that cascades from it (why it was not used)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0012-naive-'));
  try {
    const migrations = path.join(ROOT, 'migrations');
    for (const name of fs.readdirSync(migrations)) if (name.endsWith('.sql') && name < '0012_accounts.sql') fs.copyFileSync(path.join(migrations, name), path.join(dir, name));
    const db = createD1Fake({ migrationsDir: dir });
    seedPopulated(db);
    const n = (table) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.deepEqual([n('sessions'), n('role_assignments'), n('bnet_links'), n('character_claims')], [2, 2, 1, 2]);
    // The textbook rebuild, with D1's only tool (defer_foreign_keys): the implicit DELETE of DROP TABLE still fires the foreign key actions.
    db.sqlite.exec(`PRAGMA defer_foreign_keys = true;
      CREATE TABLE users_new (id TEXT PRIMARY KEY, discord_id TEXT UNIQUE, username TEXT NOT NULL, global_name TEXT, avatar TEXT, prefs TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    assert.deepEqual([n('sessions'), n('role_assignments'), n('bnet_links'), n('character_claims')], [0, 0, 0, 0], 'the cascades emptied them');
    assert.equal(db.sqlite.prepare('SELECT created_by FROM guilds').get().created_by, null, 'and SET NULL cleared the creator');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Providers and the states

check('GET /auth/providers: which sign-in buttons exist on this server, for a signed-out visitor, with nothing else in the answer', async () => {
  const w = await makeWorld();
  const both = await w.call({}, 'GET', '/auth/providers');
  assert.equal(both.status, 200);
  assert.deepEqual(both.json, { discord: true, bnet: true });
  assert.equal(both.headers.get('Cache-Control'), 'no-store');
  w.env.BNET_CLIENT_SECRET = '';
  assert.deepEqual((await w.call({}, 'GET', '/auth/providers')).json, { discord: true, bnet: false });
  w.env.DISCORD_CLIENT_ID = '';
  assert.deepEqual((await w.call({}, 'GET', '/auth/providers')).json, { discord: false, bnet: false });
});

check('state per mode: Discord sign-in, Discord link, Battle.net link and Battle.net sign-in each have their own shape and key, bound to the member where they should be', async () => {
  const s = await scenario();
  const { w } = s;
  const dSign = stateOf(await w.req('GET', '/auth/login'));
  const dLink = stateOf(await w.req('GET', '/auth/login?mode=link', { jar: s.jars.erin }));
  const bLink = stateOf(await w.req('GET', '/auth/bnet/login', { jar: s.jars.erin }));
  const bSign = stateOf(await w.req('GET', '/auth/bnet/login?mode=signin'));
  // <nonce>.<issued ms>.<mac>, behind a mode prefix for two of them.
  assert.match(dSign, /^[A-Za-z0-9_-]{22}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.match(dLink, /^link\.[A-Za-z0-9_-]{22}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.match(bLink, /^[A-Za-z0-9_-]{22}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.match(bSign, /^signin\.[A-Za-z0-9_-]{22}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  const session = await load('worker/session.js');
  const env = w.env;
  const now = w.clock.now;
  assert.equal(session.discordStateMode(dSign), 'signin');
  assert.equal(session.discordStateMode(dLink), 'link');
  assert.equal(session.bnetStateMode(bLink), 'link');
  assert.equal(session.bnetStateMode(bSign), 'signin');
  // Each verifies only in its own mode, for its own member.
  assert.equal(await session.verifyState(env, dSign, now), true);
  assert.equal(await session.verifyState(env, dLink, now), false);
  assert.equal(await session.verifyDiscordLinkState(env, s.ids.erin, dLink, now), true);
  assert.equal(await session.verifyDiscordLinkState(env, s.ids.gina, dLink, now), false, 'bound to the member who started it');
  assert.equal(await session.verifyDiscordLinkState(env, s.ids.erin, dSign, now), false);
  assert.equal(await session.verifyBnetState(env, s.ids.erin, bLink, now), true);
  assert.equal(await session.verifyBnetState(env, s.ids.erin, bSign, now), false);
  assert.equal(await session.verifyBnetSigninState(env, bSign, now), true);
  assert.equal(await session.verifyBnetSigninState(env, bLink, now), false);
  assert.equal(await session.verifyBnetSigninState(env, dLink, now), false);
  assert.equal(await session.verifyBnetSigninState({ ...env, BNET_CLIENT_SECRET: 'other' }, bSign, now), false);
  assert.equal(await session.verifyDiscordLinkState({ ...env, DISCORD_CLIENT_SECRET: 'other' }, s.ids.erin, dLink, now), false);
  // The login redirects carry the state and its cookie; a link needs a session, a sign-in does not.
  assert.equal(locationOf(await w.req('GET', '/auth/login?mode=link')), '/#/signin');
  assert.equal(locationOf(await w.req('GET', '/auth/bnet/login')), '/#/signin');
  const origin = await w.req('GET', '/auth/login?mode=link', { jar: s.jars.erin });
  assert(origin.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_state=link.')));
  const bnetCookie = (await w.req('GET', '/auth/bnet/login?mode=signin')).headers.getSetCookie().find((c) => c.startsWith('__Host-rs_bnet_state='));
  assert(/HttpOnly/.test(bnetCookie) && /Secure/.test(bnetCookie) && /SameSite=Lax/.test(bnetCookie) && /Max-Age=600/.test(bnetCookie) && /signin\./.test(bnetCookie));
});

check('login: the wrong origin is sent to the canonical one (with the mode), an unconfigured provider is a reason on the right page', async () => {
  const w = await makeWorld();
  const wrong = (path) => new Request(`http://localhost:8787${path}`);
  assert.equal(locationOf(await w.app.handle(wrong('/auth/login'))), `${ORIGIN}/auth/login`);
  assert.equal(locationOf(await w.app.handle(wrong('/auth/login?mode=link'))), `${ORIGIN}/auth/login?mode=link`);
  assert.equal(locationOf(await w.app.handle(wrong('/auth/bnet/login?mode=signin'))), `${ORIGIN}/auth/bnet/login?mode=signin`);
  w.env.BNET_CLIENT_SECRET = '';
  assert.equal(locationOf(await w.req('GET', '/auth/bnet/login?mode=signin')), '/#/signin?error=not_configured');
  w.env.DISCORD_CLIENT_ID = '';
  assert.equal(locationOf(await w.req('GET', '/auth/login')), '/#/signin?error=discord');
  const s = await scenario();
  s.w.env.DISCORD_CLIENT_ID = '';
  assert.equal(locationOf(await s.w.req('GET', '/auth/login?mode=link', { jar: s.jars.erin })), '/#/linked?error=not_configured');
});

// ---------------------------------------------------------------------------
// Sign up and sign in with Battle.net

check('Battle.net sign-up: an unknown Battle.net account becomes a NEW account (no Discord) with a session, named after its BattleTag', async () => {
  const w = await makeWorld();
  const { jar, login, callback } = await bnetSignIn(w, BNET.holly);
  const target = new URL(login.headers.get('Location'));
  assert.equal(`${target.origin}${target.pathname}`.endsWith('/authorize'), true);
  assert.equal(target.searchParams.get('scope'), 'openid wow.profile');
  assert.equal(locationOf(callback), '/#/');
  const cookie = callback.headers.getSetCookie().find((c) => c.startsWith('__Host-rs_session='));
  assert(/HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie) && /Max-Age=2592000/.test(cookie));
  assert(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_bnet_state=;') && /Max-Age=0/.test(c)), 'the state cookie is spent');

  const me = await w.call(jar, 'GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json).sort(), ['account', 'create', 'deleteImpact', 'guilds', 'identities', 'removedFrom', 'user']);
  assert.equal(me.json.user.displayName, 'Holly');
  assert.equal(me.json.user.username, 'Holly');
  assert.equal(me.json.user.avatarUrl, null);
  assert.deepEqual(me.json.identities, { discord: null, bnet: { battletag: 'Holly#1111', linkedAt: w.clock.now, refreshedAt: w.clock.now } });
  assert.deepEqual(me.json.account, { customName: null, available: { discord: true, bnet: true }, reminderOptOut: false });
  assert.deepEqual(me.json.guilds, []);
  assert.deepEqual(me.json.create, { allowed: false, reason: 'needs_discord' }, 'a guild belongs to a Discord server: Battle.net alone cannot create one');
  assert.deepEqual(me.json.deleteImpact, { handOverFirst: [], guildsDeleted: [], autoPromote: [] });
  assert(!JSON.stringify(me.json).includes(BNET.holly.id), 'the Battle.net account number never reaches the browser');

  const user = (await w.rows('SELECT * FROM users'))[0];
  assert.equal(user.discord_id, null);
  assert.equal(user.account_key, user.id);
  assert.equal(user.username, 'Holly');
  assert.equal(await w.count('bnet_links', 'user_id = ? AND bnet_account_id = ? AND battletag = ?', user.id, BNET.holly.id, 'Holly#1111'), 1);
  assert.equal(await w.count('user_servers'), 0);
  assert.equal(await w.count('sessions'), 1);
  const audit = await w.rows("SELECT guild_id, actor_user_id, action, entity_id FROM audit_log");
  assert.deepEqual(audit, [{ guild_id: null, actor_user_id: user.id, action: 'bnet.link', entity_id: user.id }]);
  // No token, code, secret or state is stored anywhere.
  const dump = JSON.stringify(Object.values(dumpAll(w.db)));
  for (const secret of ['fake-member-token', 'bnet-secret', 'abc', jar['__Host-rs_session']]) assert(!dump.includes(secret), secret);
});

check('Battle.net sign-in: the same Battle.net account signs into the same account; a new BattleTag renames it; every sign-in is a NEW session and the old one dies', async () => {
  const w = await makeWorld();
  const first = await bnetSignIn(w, BNET.holly);
  const oldToken = first.jar['__Host-rs_session'];
  const id = (await w.call(first.jar, 'GET', '/auth/me')).json.user.id;
  w.advance(5 * DAY);
  w.bnet.state.account = { id: BNET.holly.id, battletag: 'Hollis#1111' };
  const again = await bnetSignIn(w, { id: BNET.holly.id, battletag: 'Hollis#1111' }, first.jar);
  assert.equal(locationOf(again.callback), '/#/');
  assert.notEqual(again.jar['__Host-rs_session'], oldToken, 'a new token');
  assert.equal(await w.count('users'), 1, 'no second account');
  assert.equal(await w.count('sessions'), 1, 'the presented session was deleted');
  assert.equal((await w.call({ '__Host-rs_session': oldToken }, 'GET', '/auth/me')).status, 401, 'the old token is dead');
  const me = await w.call(again.jar, 'GET', '/auth/me');
  assert.equal(me.json.user.id, id);
  assert.equal(me.json.user.displayName, 'Hollis', 'renamed with the BattleTag');
  assert.deepEqual(me.json.identities.bnet, { battletag: 'Hollis#1111', linkedAt: 1_800_000_000_000, refreshedAt: w.clock.now });
  assert.equal(await w.count('audit_log'), 1, 'only the sign-up is audited, not each sign-in');
  // A custom name survives a rename of the BattleTag.
  assert.equal((await w.call(again.jar, 'PATCH', '/api/me', { displayName: 'Holly the Brave' })).status, 200);
  const third = await bnetSignIn(w, { id: BNET.holly.id, battletag: 'Holler#1111' }, again.jar);
  assert.equal(locationOf(third.callback), '/#/');
  assert.equal((await w.call(third.jar, 'GET', '/auth/me')).json.user.displayName, 'Holly the Brave');
});

check('session fixation: signing in with Battle.net or Discord replaces the session a browser already holds, whoever it belonged to', async () => {
  const s = await scenario();
  const { w } = s;
  const aliceToken = s.jars.alice['__Host-rs_session'];
  const jar = { '__Host-rs_session': aliceToken };
  const { callback } = await bnetSignIn(w, BNET.holly, jar);
  assert.equal(locationOf(callback), '/#/');
  assert.notEqual(jar['__Host-rs_session'], aliceToken);
  assert.equal((await w.call({ '__Host-rs_session': aliceToken }, 'GET', '/auth/me')).status, 401, 'Alice\'s session died with the sign-in');
  assert.equal((await w.call(jar, 'GET', '/auth/me')).json.user.displayName, 'Holly');
  // And the other way: a Discord sign-in over a Battle.net session.
  const bnetToken = jar['__Host-rs_session'];
  await signIn(w, PEOPLE.erin, [plain(SERVER_A)], jar);
  assert.notEqual(jar['__Host-rs_session'], bnetToken);
  assert.equal((await w.call({ '__Host-rs_session': bnetToken }, 'GET', '/auth/me')).status, 401);
  assert.equal((await w.call(jar, 'GET', '/auth/me')).json.user.id, s.ids.erin);
});

check('Battle.net sign-in callback: a missing, mismatched, forged or other-mode state, a denial, a bad code and Blizzard failing all end on the sign-in page and create nothing', async () => {
  const s = await scenario();
  const { w } = s;
  const users = await w.count('users');
  const start = async (jar = {}) => stateOf(await w.req('GET', '/auth/bnet/login?mode=signin', { jar }));
  const go = (query, jar) => w.req('GET', `/auth/bnet/callback?${query}`, { jar });
  w.bnet.state.requests.length = 0;
  const good = await start();
  const forged = `signin.${'A'.repeat(22)}.${w.clock.now}.${'B'.repeat(43)}`;
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(good)}`, {})), '/#/signin?error=state', 'no cookie');
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(forged)}`, { '__Host-rs_bnet_state': forged })), '/#/signin?error=state', 'forged');
  // A link-mode state (a member's own) used in a signed-out sign-in is a LINK callback: it needs the session, so it goes to sign in.
  const link = stateOf(await w.req('GET', '/auth/bnet/login', { jar: s.jars.erin }));
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(link)}`, { '__Host-rs_bnet_state': link })), '/#/signin');
  // A link-mode state replayed by a signed-in OTHER member is refused (bound to Erin), not treated as a sign-in.
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(link)}`, { ...s.jars.gina, '__Host-rs_bnet_state': link })), '/#/linked?error=state');
  // A sign-in state whose mode prefix was cut off cannot pass as a link state for Erin either.
  const stripped = good.replace(/^signin\./, '');
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(stripped)}`, { ...s.jars.erin, '__Host-rs_bnet_state': stripped })), '/#/linked?error=state');
  assert.deepEqual(w.asked(), [], 'no outbound call for any of them');
  // Each attempt starts a real login (a fresh state and its cookie) and then comes back with the query the test names.
  const attempt = async (query) => {
    const jar = {};
    const state = encodeURIComponent(stateOf(await w.req('GET', '/auth/bnet/login?mode=signin', { jar })));
    return locationOf(await go(query(state), jar));
  };
  assert.equal(await attempt((state) => `error=access_denied&state=${state}`), '/#/signin?error=denied');
  assert.equal(await attempt((state) => `state=${state}`), '/#/signin?error=state', 'no code');
  assert.equal(await attempt((state) => `code=${'x'.repeat(513)}&state=${state}`), '/#/signin?error=state', 'a code over 512 characters');
  w.bnet.state.fail.token = 400;
  assert.equal(await attempt((state) => `code=abc&state=${state}`), '/#/signin?error=bnet');
  w.bnet.state.fail.token = 0;
  w.bnet.state.fail.userinfo = 500;
  assert.equal(await attempt((state) => `code=abc&state=${state}`), '/#/signin?error=bnet');
  w.bnet.state.fail.userinfo = 0;
  w.bnet.state.account = { id: 'not-a-number', battletag: 'X#1' };
  assert.equal(await attempt((state) => `code=abc&state=${state}`), '/#/signin?error=bnet');
  assert.equal(await w.count('users'), users, 'no account was made');
  assert.equal(await w.count('bnet_links'), 0);
  // The state is single use: the cookie it came with was cleared by the callback.
  const replayJar = {};
  const once = stateOf(await w.req('GET', '/auth/bnet/login?mode=signin', { jar: replayJar }));
  w.bnet.state.account = BNET.ivan;
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(once)}`, replayJar)), '/#/');
  assert.equal(locationOf(await go(`code=abc&state=${encodeURIComponent(once)}`, replayJar)), '/#/signin?error=state');
});

check('Battle.net sign-in for a member of a guild refreshes the character snapshot (the 30-day clock restarts)', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.erin, BNET.erin);
  const first = (await w.rows('SELECT snapshot_at FROM bnet_links WHERE user_id = ?', s.ids.erin))[0].snapshot_at;
  w.advance(12 * DAY);
  const { callback } = await bnetSignIn(w, BNET.erin);
  assert.equal(locationOf(callback), '/#/');
  const row = (await w.rows('SELECT snapshot_at, snapshot, linked_at FROM bnet_links WHERE user_id = ?', s.ids.erin))[0];
  assert.equal(row.snapshot_at, first + 12 * DAY);
  assert.equal(row.linked_at, first, 'linked_at stays: it is when the link was made');
  assert(Object.keys(JSON.parse(row.snapshot)).includes('profile-classicann-us'), 'the guild\'s namespace was loaded');
  assert.equal(await w.count('users'), 6, 'erin signed in to her own account: no new one');
});

// ---------------------------------------------------------------------------
// Linking Discord to an account

check('link Discord: a Battle.net-only account connects Discord (profile, servers, the guild it was never in) and keeps its session', async () => {
  const s = await scenario();
  const { w } = s;
  const jar = await signUpHolly(s);
  const sessionBefore = jar['__Host-rs_session'];
  assert.equal((await w.call(jar, 'GET', '/auth/me')).json.guilds.length, 0);
  const { login, callback } = await discordLink(w, jar, PEOPLE.gale, [plain(SERVER_A), plain(SERVER_B)]);
  assert(login.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_state=link.')));
  assert.equal(locationOf(callback), '/#/linked');
  assert.equal(jar['__Host-rs_session'], sessionBefore, 'the same session');
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.equal(me.user.id, s.ids.holly);
  assert.equal(me.user.displayName, 'Gale G', 'Discord\'s global name wins over the BattleTag name');
  assert.equal(me.user.username, 'gale');
  assert.deepEqual(me.identities.discord, { username: 'gale', globalName: 'Gale G' });
  assert.equal(me.identities.bnet.battletag, 'Holly#1111');
  assert.deepEqual(me.guilds.map((g) => g.name), ['Ember'], 'the guild on her Discord server');
  const row = (await w.rows('SELECT discord_id, account_key, username FROM users WHERE id = ?', s.ids.holly))[0];
  assert.deepEqual(row, { discord_id: PEOPLE.gale.id, account_key: s.ids.holly, username: 'gale' });
  assert.deepEqual((await w.rows('SELECT server_id FROM user_servers WHERE user_id = ?', s.ids.holly)).map((r) => r.server_id), [SERVER_A], 'only servers that have a guild');
  assert.deepEqual(await w.rows("SELECT guild_id, actor_user_id, entity_id FROM audit_log WHERE action = 'discord.link'"), [{ guild_id: null, actor_user_id: s.ids.holly, entity_id: s.ids.holly }]);
  assert.equal((await w.call(jar, 'GET', s.guildPath)).status, 200);
  // Linking the same Discord again only refreshes the profile and the servers: no second audit row, no new session.
  const again = await discordLink(w, jar, { ...PEOPLE.gale, username: 'gale2', globalName: 'Gale Two' }, []);
  assert.equal(locationOf(again.callback), '/#/linked');
  assert.equal((await w.rows('SELECT username, global_name FROM users WHERE id = ?', s.ids.holly))[0].username, 'gale2');
  assert.equal(await w.count('user_servers', 'user_id = ?', s.ids.holly), 0, 'the server list is replaced');
  assert.equal(await w.count('audit_log', "action = 'discord.link'"), 1);
  assert.equal(jar['__Host-rs_session'], sessionBefore);
});

check('link Discord: a Discord account that belongs to ANOTHER account is refused (no merge), so is a second Discord and a signed-out or foreign state', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  // Every callback that gets past the MAC and age checks claims its state's nonce; nothing else may change.
  const dumpWithoutNonces = () => { const all = dumpAll(w.db); delete all.oauth_state_nonces; return JSON.stringify(all); };
  const before = dumpWithoutNonces();
  // Erin's Discord ID already has an account.
  const taken = await discordLink(w, holly, PEOPLE.erin, [plain(SERVER_A)]);
  assert.equal(locationOf(taken.callback), '/#/linked?error=discord_taken');
  assert.equal(dumpWithoutNonces(), before, 'not one row of the database changed');
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.holly))[0].discord_id, null);
  assert.equal(await w.count('user_servers', 'user_id = ?', s.ids.holly), 0);
  assert.equal(await w.count('audit_log', "action = 'discord.link'"), 0);
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.erin))[0].discord_id, PEOPLE.erin.id, 'Erin\'s account is untouched');
  // An account with a Discord already cannot take a different one.
  await discordLink(w, holly, PEOPLE.gale, []);
  const second = await discordLink(w, holly, { id: '110000000000000011', username: 'zed', globalName: null }, [plain(SERVER_A)]);
  assert.equal(locationOf(second.callback), '/#/linked?error=has_discord');
  assert.equal(locationOf((await discordLink(w, holly, PEOPLE.gina, [plain(SERVER_A)])).callback), '/#/linked?error=discord_taken', 'and another account\'s Discord is refused first');
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.holly))[0].discord_id, PEOPLE.gale.id);
  // The link state is bound to the member and to the link mode.
  const dLink = stateOf(await w.req('GET', '/auth/login?mode=link', { jar: s.jars.gina }));
  w.discord.next = { user: { id: '110000000000000010', username: 'x', global_name: null, avatar: null }, servers: [] };
  w.discord.calls.length = 0;
  const stolen = { ...s.jars.carol, '__Host-rs_state': dLink };
  assert.equal(locationOf(await w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(dLink)}`, { jar: stolen })), '/#/linked?error=state');
  const signedOut = { '__Host-rs_state': dLink };
  assert.equal(locationOf(await w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(dLink)}`, { jar: signedOut })), '/#/signin?error=state');
  const forged = `link.${'A'.repeat(22)}.${w.clock.now}.${'B'.repeat(43)}`;
  assert.equal(locationOf(await w.req('GET', `/auth/callback?code=abc&state=${forged}`, { jar: { ...s.jars.gina, '__Host-rs_state': forged } })), '/#/linked?error=state');
  assert.deepEqual(w.discord.calls, [], 'no outbound Discord call for any of them');
  assert.equal(locationOf((await discordLink(w, s.jars.gina, PEOPLE.gina, [plain(SERVER_A)])).callback), '/#/linked', 'the genuine state still works (Gina re-links her own Discord)');
});

check('link Discord: a Discord ID that would put two people of one guild on the account is refused', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const mine = await addPerson(s, 'bob', s.A, 'Aldric');
  const gales = await addPerson(s, 'bob', s.A, 'Brindle');
  assert.equal((await linkAccount(s, 'bob', mine.person.id, s.ids.holly)).status, 200);
  w.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE.gale.id}' WHERE id = '${gales.person.id}'`);
  const clash = await discordLink(w, holly, PEOPLE.gale, [plain(SERVER_A)]);
  assert.equal(locationOf(clash.callback), '/#/linked?error=roster_conflict');
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.holly))[0].discord_id, null);
  assert.equal(await w.count('user_servers', 'user_id = ?', s.ids.holly), 0);
});

check('link Discord: an allowlisted account that adds Discord gets its creator list on the session, and can then create a guild', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await bnetSignIn(w, BNET.holly);
  const noDiscord = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_A });
  assert.equal(noDiscord.status, 403);
  assert.equal(noDiscord.json.error, 'not_allowed_to_create');
  assert.match(noDiscord.json.message, /Discord/);
  await discordLink(w, jar, PEOPLE.alice, [manageable(SERVER_A)]);
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.equal(me.create.allowed, true);
  assert.deepEqual(me.create.servers.map((server) => server.id), [SERVER_A]);
  const created = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_A });
  assert.equal(created.status, 201, JSON.stringify(created.json));
});

// ---------------------------------------------------------------------------
// Battle.net link rules, the last identity, unlinking

check('link Battle.net: a Battle.net account that belongs to ANOTHER account is refused, from either kind of account, and nothing changes', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const ivan = await signUpHolly(s, 'ivan');
  const before = await w.rows('SELECT user_id, bnet_account_id, battletag FROM bnet_links ORDER BY user_id');
  // Ivan has a Battle.net of his own, so Holly's is refused as a DIFFERENT one (never a silent swap).
  const taken = await bnetLink(w, ivan, BNET.holly);
  assert.equal(locationOf(taken.callback), '/#/linked?error=has_bnet');
  assert.deepEqual(await w.rows('SELECT user_id, bnet_account_id, battletag FROM bnet_links ORDER BY user_id'), before);
  // A Discord member cannot take Holly's Battle.net account either.
  const erin = await bnetLink(w, s.jars.erin, BNET.holly);
  assert.equal(locationOf(erin.callback), '/#/linked?error=taken');
  assert.deepEqual(await w.rows('SELECT user_id, bnet_account_id, battletag FROM bnet_links ORDER BY user_id'), before);
  assert.equal((await w.call(holly, 'GET', '/auth/me')).json.identities.bnet.battletag, 'Holly#1111');
  // The same Battle.net account again only refreshes (renames with its BattleTag); a different one needs the first disconnected.
  const again = await bnetLink(w, holly, { id: BNET.holly.id, battletag: 'Hollis#1111' });
  assert.equal(locationOf(again.callback), '/#/characters');
  assert.equal((await w.call(holly, 'GET', '/auth/me')).json.user.displayName, 'Hollis');
  const swap = await bnetLink(w, holly, { id: '700000077', battletag: 'Other#7777' });
  assert.equal(locationOf(swap.callback), '/#/linked?error=has_bnet');
  assert.deepEqual((await w.rows('SELECT bnet_account_id, battletag FROM bnet_links WHERE user_id = ?', s.ids.holly)), [{ bnet_account_id: BNET.holly.id, battletag: 'Hollis#1111' }]);
  assert.equal((await w.rows('SELECT username FROM users WHERE id = ?', s.ids.holly))[0].username, 'Hollis', 'a refused swap renames nothing');
  assert.equal(await w.count('audit_log', "action = 'bnet.link' AND actor_user_id = ?", s.ids.holly), 2, 'the sign-up and the refresh, not the refused swap');
});

check('Battle.net sign-in is tied to the link at the moment of writing: a link deleted in between gives no session', async () => {
  const w = await makeWorld();
  await bnetSignIn(w, BNET.holly);
  const real = w.db.batch.bind(w.db);
  let done = false;
  w.db.batch = async (statements) => {
    if (!done && statements.some((statement) => /INSERT INTO sessions/.test(statement.sql))) {
      done = true;
      w.db.sqlite.exec('DELETE FROM bnet_links');
    }
    return real(statements);
  };
  const jar = {};
  const { callback } = await bnetSignIn(w, BNET.holly, jar);
  assert.equal(locationOf(callback), '/#/signin?error=bnet');
  assert.equal(jar['__Host-rs_session'], undefined);
  assert.equal(await w.count('sessions'), 1, 'only the first sign-in\'s session');
});

check('last identity: the only sign-in of an account cannot be disconnected, whichever it is; with another one it can', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  // Battle.net-only: Battle.net stays.
  const bnetOnly = await w.call(holly, 'DELETE', '/auth/bnet', {});
  assert.equal(bnetOnly.status, 409);
  assert.equal(bnetOnly.json.error, 'last_identity');
  assert.equal(await w.count('bnet_links', 'user_id = ?', s.ids.holly), 1);
  assert.equal(await w.count('audit_log', "action = 'bnet.unlink'"), 0);
  // Discord-only: Discord stays (and nothing was changed on the account).
  const discordOnly = await w.call(s.jars.erin, 'DELETE', '/auth/discord', {});
  assert.equal(discordOnly.status, 409);
  assert.equal(discordOnly.json.error, 'last_identity');
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.erin))[0].discord_id, PEOPLE.erin.id);
  assert.equal(await w.count('user_servers', 'user_id = ?', s.ids.erin), 1);
  // A Discord-only account has no Battle.net to disconnect: not an error, nothing removed.
  const none = await w.call(s.jars.gina, 'DELETE', '/auth/bnet', {});
  assert.deepEqual([none.status, none.json], [200, { ok: true, removed: false }]);
  // With both linked, either can go.
  await discordLink(w, holly, PEOPLE.gale, [plain(SERVER_A)]);
  const dropped = await w.call(holly, 'DELETE', '/auth/bnet', {});
  assert.deepEqual([dropped.status, dropped.json], [200, { ok: true, removed: true }]);
  assert.equal(await w.count('audit_log', "action = 'bnet.unlink'"), 1);
  assert.equal((await w.call(holly, 'DELETE', '/auth/discord', {})).json.error, 'last_identity', 'and now Discord is the last one');
  assert.equal((await w.call(holly, 'GET', '/auth/me')).json.identities.bnet, null);
  // Signed out: 401.
  assert.equal((await w.call({}, 'DELETE', '/auth/discord', {})).status, 401);
});

check('unlink Discord: the account becomes a Battle.net account (named after its BattleTag, no servers); its Discord ID and nickname are deleted from roster people and sign-ups; only an officer\'s link keeps a guild', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.erin, BNET.erin);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric', { linkUserId: s.ids.erin });
  const personId = aldric.person.id;
  w.db.sqlite.exec(`UPDATE players SET discord_nickname = 'Erinn' WHERE id = '${personId}'`);
  w.db.sqlite.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r_1', '${s.guildId}', '${s.A}', '2027-01-05', 1, 1, 1)`);
  w.db.sqlite.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id, player_id) VALUES ('r_1', 'raid_helper', 1, '${PEOPLE.erin.id}', 'Erinn', 'signed', 1, '${s.guildId}', '${personId}')`);
  const version = (await w.rows('SELECT version FROM players WHERE id = ?', personId))[0].version;
  // Erin is a member through the Discord server AND the person's Discord ID. Disconnecting Discord ends both, like leaving the server would.
  const done = await w.call(s.jars.erin, 'DELETE', '/auth/discord', {});
  assert.deepEqual([done.status, done.json], [200, { ok: true, removed: true }]);
  const row = (await w.rows('SELECT discord_id, username, global_name, avatar, account_key FROM users WHERE id = ?', s.ids.erin))[0];
  assert.deepEqual(row, { discord_id: null, username: 'Erin', global_name: null, avatar: null, account_key: s.ids.erin });
  assert.equal(await w.count('user_servers', 'user_id = ?', s.ids.erin), 0);
  const person = (await w.rows('SELECT user_id, discord_user_id, discord_nickname, version FROM players WHERE id = ?', personId))[0];
  assert.deepEqual([person.user_id, person.discord_user_id, person.discord_nickname, person.version], [null, null, null, version + 1], 'no link is made out of the Discord ID; the Discord data is gone from the person');
  assert.deepEqual((await w.rows('SELECT discord_user_id, nickname, player_id FROM raid_signups'))[0], { discord_user_id: null, nickname: null, player_id: personId }, 'and from the sign-up, which keeps its person');
  const me = (await w.call(s.jars.erin, 'GET', '/auth/me')).json;
  assert.equal(me.user.displayName, 'Erin');
  assert.deepEqual(me.identities, { discord: null, bnet: { battletag: 'Erin#0005', linkedAt: me.identities.bnet.linkedAt, refreshedAt: me.identities.bnet.refreshedAt } });
  assert.deepEqual(me.guilds, [], 'the guild only knew her through the Discord server');
  assert.equal((await s.call('erin', 'GET', '')).json.error, 'not_member');
  const record = (await s.call('bob', 'GET', `/roster/${personId}`)).json;
  assert.deepEqual([record.person.account.user, record.person.discord.signIn], [null, 'no_discord']);
  // An officer's link is what keeps her in: linking her BATTLE.NET account to the person makes her a member again, Discord or not.
  assert.equal((await linkAccount(s, 'bob', personId, s.ids.erin)).status, 200);
  assert.deepEqual((await w.call(s.jars.erin, 'GET', '/auth/me')).json.guilds.map((g) => g.name), ['Ember']);
  assert.deepEqual(await w.rows("SELECT guild_id, actor_user_id FROM audit_log WHERE action = 'discord.unlink'"), [{ guild_id: null, actor_user_id: s.ids.erin }]);
  // Gina has Battle.net but no person: without Discord she is no longer in the guild.
  await bnetLink(w, s.jars.gina, BNET.gina);
  assert.equal((await w.call(s.jars.gina, 'DELETE', '/auth/discord', {})).status, 200);
  assert.deepEqual((await w.call(s.jars.gina, 'GET', '/auth/me')).json.guilds, []);
  assert.equal((await s.call('gina', 'GET', '')).json.error, 'not_member');
  // Signing in with Discord again makes a NEW account (the Discord ID is free again), not Gina's old one.
  const back = await signIn(w, PEOPLE.gina, [plain(SERVER_A)]);
  const fresh = (await w.call(back, 'GET', '/auth/me')).json;
  assert.notEqual(fresh.user.id, s.ids.gina);
  assert.equal(fresh.guilds.length, 1);
});

check('unlink Discord: a Guild Master who would lose the guild is told to hand over or link first', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.alice, { id: '700000050', battletag: 'Alice#0050' });
  const refused = await w.call(s.jars.alice, 'DELETE', '/auth/discord', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'leads_guild');
  assert.deepEqual(refused.json.guilds, [{ id: s.guildId, name: 'Ember' }]);
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.alice))[0].discord_id, PEOPLE.alice.id);
  // A roster person that only carries her Discord ID does not keep the guild once the Discord goes; one linked to her ACCOUNT does.
  const mine = await addPerson(s, 'alice', s.A, 'Alicia', { linkUserId: s.ids.alice });
  assert.equal((await w.call(s.jars.alice, 'DELETE', '/auth/discord', {})).json.error, 'leads_guild');
  assert.equal((await linkAccount(s, 'alice', mine.person.id, s.ids.alice)).status, 200);
  const ok = await w.call(s.jars.alice, 'DELETE', '/auth/discord', {});
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await w.call(s.jars.alice, 'GET', s.guildPath)).status, 200);
  assert.equal((await w.rows('SELECT user_id FROM players WHERE id = ?', mine.person.id))[0].user_id, s.ids.alice);
});

check('unlink Discord: an account an officer removed from a guild cannot shed its Discord (it would come back as a fresh account no block names)', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.erin, BNET.erin);
  assert.equal((await w.call(s.jars.alice, 'POST', `${s.guildPath}/people/${s.ids.erin}/block`, { reason: 'x' })).status, 200);
  const refused = await w.call(s.jars.erin, 'DELETE', '/auth/discord', {});
  assert.deepEqual([refused.status, refused.json.error], [409, 'blocked_somewhere']);
  assert.equal((await w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.erin))[0].discord_id, PEOPLE.erin.id);
  assert.equal((await w.call(s.jars.alice, 'DELETE', `${s.guildPath}/people/${s.ids.erin}/block`, {})).status, 200);
  assert.equal((await w.call(s.jars.erin, 'DELETE', '/auth/discord', {})).status, 200, 'restored: free to go');
});

check('Discord link on a person: refused while the person belongs to ANOTHER account (an officer\'s account link), so one person never has two owners', async () => {
  const s = await scenario();
  await signUpHolly(s);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  assert.equal((await linkAccount(s, 'bob', aldric.person.id, s.ids.holly)).status, 200);
  const version = (await s.call('bob', 'GET', `/roster/${aldric.person.id}`)).json.person.version;
  const clash = await s.call('bob', 'PATCH', `/roster/${aldric.person.id}`, { expectedVersion: version, linkUserId: s.ids.erin });
  assert.deepEqual([clash.status, clash.json.error, clash.json.field], [409, 'already_linked', 'linkUserId']);
  assert.deepEqual(await s.w.rows('SELECT user_id, discord_user_id FROM players'), [{ user_id: s.ids.holly, discord_user_id: null }]);
});

// ---------------------------------------------------------------------------
// Membership through a roster link

check('membership: an officer links a Battle.net-only account to a roster person and it sees the guild, with the rights of its own characters; blocked still wins', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  assert.equal((await w.call(holly, 'GET', s.guildPath)).json.error, 'not_member', 'before the link: not in the guild');
  assert.equal((await w.call(holly, 'GET', `${s.guildPath}/roster?team=${s.A}`)).status, 403);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  const linked = await linkAccount(s, 'bob', aldric.person.id, s.ids.holly);
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.deepEqual(linked.json.person.account.via, 'link');
  assert.equal(linked.json.person.account.user.displayName, 'Holly');
  assert.equal(linked.json.person.version, aldric.person.version + 1);
  assert.deepEqual(linked.json.person.discord, { signIn: 'no_discord', user: null, nickname: null });
  // Now a member.
  const me = (await w.call(holly, 'GET', '/auth/me')).json;
  assert.deepEqual(me.guilds.map((g) => g.name), ['Ember']);
  const guild = await w.call(holly, 'GET', s.guildPath);
  assert.equal(guild.status, 200);
  assert.equal(guild.json.me.can['roster.view'], 'guild');
  assert.deepEqual(guild.json.me.can['attendance.view'], [s.A], 'own_teams: the team of her own character');
  const roster = (await w.call(holly, 'GET', `${s.guildPath}/roster?team=${s.A}`)).json;
  const row = roster.people.find((p) => p.id === aldric.person.id);
  assert.deepEqual([row.isMe, row.signIn], [true, 'signed_in']);
  const record = (await w.call(holly, 'GET', `${s.guildPath}/roster/${aldric.person.id}`)).json;
  assert.equal(record.person.isMe, true);
  // The officers' view: signed in, and People and roles lists her with her roster entry.
  const officerRoster = (await s.call('bob', 'GET', `/roster?team=${s.A}`)).json.people.find((p) => p.id === aldric.person.id);
  assert.equal(officerRoster.signIn, 'signed_in');
  const people = (await s.call('alice', 'GET', '/people')).json;
  const entry = people.people.find((p) => p.person.id === s.ids.holly);
  assert(entry, 'listed in People and roles');
  assert.deepEqual(entry.roster, { personId: aldric.person.id, name: 'Aldric', class: 'WARRIOR' });
  assert.equal(entry.actions.editRoles, true);
  // Roles work for her like for anyone: Carol is Team Lead of Alpha; make Holly Team Lead too.
  const roles = await w.call(s.jars.alice, 'PUT', `${s.guildPath}/people/${s.ids.holly}/roles`, { officer: false, teamLeadTeamIds: [s.A] });
  assert.equal(roles.status, 200, JSON.stringify(roles.json));
  assert.equal((await w.call(holly, 'GET', s.guildPath)).json.me.can['roster.edit'][0], s.A);
  // Blocked wins over the link.
  const block = await w.call(s.jars.alice, 'POST', `${s.guildPath}/people/${s.ids.holly}/block`, { reason: 'x' });
  assert.equal(block.status, 200, JSON.stringify(block.json));
  assert.equal((await w.call(holly, 'GET', s.guildPath)).json.error, 'access_removed');
  const blockedMe = (await w.call(holly, 'GET', '/auth/me')).json;
  assert.deepEqual([blockedMe.guilds, blockedMe.removedFrom.map((g) => g.name)], [[], ['Ember']]);
  assert.equal((await s.call('bob', 'GET', `/roster/${aldric.person.id}`)).json.person.account.user, null, 'a blocked account does not count as signed in');
  assert.equal((await w.call(s.jars.alice, 'DELETE', `${s.guildPath}/people/${s.ids.holly}/block`, {})).status, 200);
  assert.equal((await w.call(holly, 'GET', s.guildPath)).status, 200);
  // Unlinking ends the membership.
  const unlinked = await linkAccount(s, 'bob', aldric.person.id, null);
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.json.person.account.user, null);
  assert.equal((await w.call(holly, 'GET', s.guildPath)).json.error, 'not_member');
});

check('membership: a Discord ID on a roster person without a Discord server membership still does not make a member (leaving the server still ends access)', async () => {
  const s = await scenario();
  const { w } = s;
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric', { linkUserId: s.ids.erin });
  w.db.sqlite.exec(`DELETE FROM user_servers WHERE user_id = '${s.ids.erin}'`);
  assert.equal((await s.call('erin', 'GET', '')).json.error, 'not_member');
  assert.equal((await s.call('bob', 'GET', `/roster/${aldric.person.id}`)).json.person.account.user, null);
  assert.deepEqual((await w.call(s.jars.erin, 'GET', '/auth/me')).json.guilds, []);
});

// ---------------------------------------------------------------------------
// The officers' side: link an account to a person, look an account up

check('PUT /roster/:pid/account: link and unlink with the rights of the person\'s home team, audited with internal ids, bumping the version', async () => {
  const s = await scenario();
  const { w } = s;
  await signUpHolly(s);
  await signUpHolly(s, 'ivan');
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  const dunmar = await addPerson(s, 'bob', s.B, 'Dunmar');
  const pid = aldric.person.id;
  // Who may: Guild Master, Officer, the Team Lead of the home team. Not another team's lead, not a member.
  for (const [who, status] of [['erin', 403], ['dave', 403], ['gina', 403]]) {
    assert.equal((await linkAccount(s, who, pid, s.ids.holly)).status, status, who);
  }
  assert.equal(await w.count('audit_log', "action = 'person.account_link'"), 0);
  // A Team Lead may not let a stranger into the whole guild: Holly is no member and sent no claim.
  const stranger = await linkAccount(s, 'carol', pid, s.ids.holly);
  assert.deepEqual([stranger.status, stranger.json.error], [403, 'forbidden']);
  assert.equal(await w.count('players', 'user_id IS NOT NULL'), 0);
  // An account that is already a member, or has a claim waiting here, they may link (to a person of their own team).
  const cassia = await addPerson(s, 'bob', s.A, 'Cassia');
  const lead = await linkAccount(s, 'carol', cassia.person.id, s.ids.gina);
  assert.equal(lead.status, 200, JSON.stringify(lead.json));
  assert.deepEqual(lead.json.rosterFlags, { [s.A]: 0 }, 'the reply carries the nav counts like every person write (a Team Lead\'s own team)');
  assert.equal((await linkAccount(s, 'carol', cassia.person.id, null)).status, 200, 'and unlink it');
  assert.deepEqual(await w.rows("SELECT actor_user_id, action FROM audit_log WHERE action LIKE 'person.account_%' ORDER BY created_at, rowid"), [
    { actor_user_id: s.ids.carol, action: 'person.account_link' }, { actor_user_id: s.ids.carol, action: 'person.account_unlink' },
  ]);
  // The log is append-only (migration 0034): the cassia rows above stay and the checks below look at the rows of this person only.
  const byLead = await linkAccount(s, 'bob', pid, s.ids.holly);
  assert.equal(byLead.status, 200, JSON.stringify(byLead.json));
  assert.equal(byLead.json.person.account.user.id, s.ids.holly);
  const stored = (await w.rows('SELECT user_id, version FROM players WHERE id = ?', pid))[0];
  assert.deepEqual([stored.user_id, stored.version], [s.ids.holly, aldric.person.version + 1]);
  assert.deepEqual(await w.rows("SELECT guild_id, actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE action = 'person.account_link' AND entity_id = ?", pid), [{
    guild_id: s.guildId, actor_user_id: s.ids.bob, entity_type: 'person', entity_id: pid, before: JSON.stringify({ userId: null }), after: JSON.stringify({ userId: s.ids.holly }),
  }]);
  // The same link again changes nothing; a different account needs the first unlinked.
  assert.equal((await linkAccount(s, 'bob', pid, s.ids.holly)).status, 200);
  assert.equal(await w.count('audit_log', "action = 'person.account_link' AND entity_id = ?", pid), 1);
  const other = await linkAccount(s, 'bob', pid, s.ids.ivan);
  assert.deepEqual([other.status, other.json.error], [409, 'already_linked']);
  // One person per account in a guild.
  const twice = await linkAccount(s, 'bob', dunmar.person.id, s.ids.holly);
  assert.deepEqual([twice.status, twice.json.error], [409, 'already_linked']);
  // Unlink: the lead of another team may not; the officer may; unlinking an unlinked person is a no-op.
  assert.equal((await linkAccount(s, 'dave', pid, null)).status, 403);
  const off = await linkAccount(s, 'bob', pid, null);
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.person.account.user, null);
  assert.deepEqual(await w.rows("SELECT before, after FROM audit_log WHERE action = 'person.account_unlink' AND entity_id = ?", pid), [{ before: JSON.stringify({ userId: s.ids.holly }), after: JSON.stringify({ userId: null }) }]);
  assert.equal((await linkAccount(s, 'bob', pid, null)).status, 200);
  assert.equal(await w.count('audit_log', "action = 'person.account_unlink' AND entity_id = ?", pid), 1);
  // Validation and lookups of what does not exist.
  for (const body of [{}, { userId: 5 }, { userId: 'nope' }, { userId: 'g_AAAAAAAAAAAAAAAAAAAAAA' }]) {
    const r = await s.call('bob', 'PUT', `/roster/${pid}/account`, body);
    assert.deepEqual([r.status, r.json.error, r.json.field], [400, 'bad_request', 'userId'], JSON.stringify(body));
  }
  assert.equal((await linkAccount(s, 'bob', pid, `u_${'A'.repeat(22)}`)).status, 404);
  assert.equal((await s.call('bob', 'PUT', `/roster/p_${'A'.repeat(22)}/account`, { userId: s.ids.holly })).status, 404);
  // Signed out: 401. The audit rows hold ids only.
  assert.equal((await w.call({}, 'PUT', `${s.guildPath}/roster/${pid}/account`, { userId: null })).status, 401);
  for (const row of await w.rows("SELECT before, after FROM audit_log WHERE action LIKE 'person.account_%'")) assert(!/Holly|Ivan|battletag|#/.test(`${row.before}${row.after}`));
});

check('PUT /roster/:pid/account: a person carrying another Discord ID, an account that is blocked, and one that is another person\'s are refused; the person\'s own Discord account may be linked too', async () => {
  const s = await scenario();
  const { w } = s;
  await signUpHolly(s);
  const withDiscord = await addPerson(s, 'bob', s.A, 'Aldric', { linkUserId: s.ids.erin });
  const plainPerson = await addPerson(s, 'bob', s.A, 'Brindle');
  // Aldric carries Erin's Discord ID: a Battle.net-only account cannot be put on him, Erin's own account can (it adds nothing but is allowed).
  const refused = await linkAccount(s, 'bob', withDiscord.person.id, s.ids.holly);
  assert.deepEqual([refused.status, refused.json.error], [409, 'discord_linked']);
  assert.equal((await linkAccount(s, 'bob', withDiscord.person.id, s.ids.erin)).status, 200);
  // Gina is Brindle's by Discord ID elsewhere: cannot also be Aldric's... (Gina already belongs to Brindle via the Discord field)
  w.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE.gina.id}' WHERE id = '${plainPerson.person.id}'`);
  const taken = await linkAccount(s, 'bob', (await addPerson(s, 'bob', s.A, 'Cassia')).person.id, s.ids.gina);
  assert.deepEqual([taken.status, taken.json.error], [409, 'already_linked']);
  // Blocked accounts cannot be linked.
  w.db.sqlite.exec(`INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('${s.guildId}', '${s.ids.holly}', 1)`);
  const blocked = await linkAccount(s, 'bob', (await addPerson(s, 'bob', s.B, 'Fenwick')).person.id, s.ids.holly);
  assert.deepEqual([blocked.status, blocked.json.error], [409, 'account_blocked']);
  assert.equal(await w.count('players', 'user_id = ?', s.ids.holly), 0);
  // The existing Discord link keeps refusing a member who already belongs to a person by account link.
  w.db.sqlite.exec(`DELETE FROM guild_blocks WHERE user_id = '${s.ids.holly}'`);
  const dunmar = await addPerson(s, 'bob', s.B, 'Dunmar');
  await linkAccount(s, 'bob', dunmar.person.id, s.ids.erin).then((r) => assert.equal(r.status, 409, 'Erin is Aldric\'s already'));
  const dup = await s.call('bob', 'PATCH', `/roster/${dunmar.person.id}`, { expectedVersion: dunmar.person.version, linkUserId: s.ids.erin });
  assert.deepEqual([dup.status, dup.json.error], [409, 'already_linked']);
  // And the linkable list of the Discord field leaves out members who already belong to a person by account link.
  const gale = await signIn(w, PEOPLE.gale, [plain(SERVER_A)]);
  const galeId = (await w.call(gale, 'GET', '/auth/me')).json.user.id;
  const mia = await addPerson(s, 'bob', s.A, 'Mirelle');
  assert.equal((await linkAccount(s, 'bob', mia.person.id, galeId)).status, 200);
  const linkable = (await s.call('bob', 'GET', '/roster/linkable')).json.users.map((u) => u.id);
  assert(!linkable.includes(galeId), 'Gale belongs to Mirelle through the account link');
  assert(!linkable.includes(s.ids.holly), 'a Battle.net-only account has no Discord to link');
});

check('GET /accounts?q=: only the accounts that claimed here (no q) or whose BattleTag or display name is exactly q; never a directory', async () => {
  const s = await scenario();
  const { w } = s;
  await signUpHolly(s);
  await signUpHolly(s, 'ivan');
  await bnetLink(w, s.jars.erin, BNET.erin);
  const lookup = (who, q) => s.call(who, 'GET', `/accounts${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`);
  // No claim yet: nothing at all, though there are nine accounts.
  assert.deepEqual((await lookup('bob')).json, { accounts: [] });
  // Erin claims a character: she is the one account listed.
  assert.equal((await pendClaim(s, 'erin', 'Eliora')).status, 201);
  const claimants = (await lookup('bob')).json.accounts;
  assert.deepEqual(claimants.map((a) => [a.id, a.displayName, a.battletag, a.matchedBy]), [[s.ids.erin, 'Erin E', null, 'claim']]);
  assert.deepEqual(Object.keys(claimants[0]).sort(), ['ambiguous', 'avatarUrl', 'battletag', 'displayName', 'id', 'initials', 'matchedBy', 'username']);
  assert.deepEqual([claimants[0].username, claimants[0].ambiguous], ['', false], 'never the Discord handle');
  // Exact BattleTag, any case; the answer carries the BattleTag the officer typed.
  for (const q of ['Holly#1111', 'holly#1111', 'HOLLY#1111']) {
    const r = (await lookup('bob', q)).json.accounts;
    assert.deepEqual(r.map((a) => [a.id, a.displayName, a.battletag, a.matchedBy]), [[s.ids.holly, 'Holly', 'Holly#1111', 'battletag']], q);
  }
  // Partial text finds nothing; so does a number alone; the BattleTag of a Discord member who linked is found too.
  for (const q of ['Holly', 'Holly#', 'olly#1111', 'Holly#1112', '#1111']) assert.deepEqual((await lookup('bob', q)).json.accounts.filter((a) => a.matchedBy === 'battletag'), [], q);
  assert.equal((await lookup('bob', 'Erin#0005')).json.accounts[0].id, s.ids.erin);
  // Exact display name (the name the account shows), any case, without leaking a BattleTag.
  await w.call(s.jars.holly, 'PATCH', '/api/me', { displayName: 'Hollyhock' });
  const byName = (await lookup('bob', 'hollyhock')).json.accounts;
  assert.deepEqual(byName.map((a) => [a.id, a.battletag, a.matchedBy]), [[s.ids.holly, null, 'name']]);
  assert.deepEqual((await lookup('bob', 'Holly')).json.accounts, [], 'Holly\'s BattleTag name is not her display name any more');
  assert.deepEqual((await lookup('bob', 'Gina G')).json.accounts.map((a) => a.id), [s.ids.gina], 'a Discord member is found by the name she shows');
  // No avatar URL ever: it carries the account's Discord ID, which a name typed into a search box must not reveal.
  const hash = 'b'.repeat(32);
  await signIn(w, { ...PEOPLE.gale, avatar: hash }, [plain(SERVER_B)]);
  const found = (await lookup('bob', 'Gale G')).json.accounts;
  assert.equal(found.length, 1);
  assert.equal(found[0].avatarUrl, null);
  assert(!JSON.stringify(found).includes(PEOPLE.gale.id), 'no Discord ID in the answer');
  // Display names are free text: two accounts showing one name are both returned and flagged, so the page offers no Link for either.
  await w.call(s.jars.ivan, 'PATCH', '/api/me', { displayName: 'Hollyhock' });
  const twin = (await lookup('bob', 'Hollyhock')).json.accounts;
  assert.deepEqual(twin.map((a) => [a.id, a.matchedBy, a.ambiguous, a.username]).sort(), [[s.ids.holly, 'name', true, ''], [s.ids.ivan, 'name', true, '']].sort());
  // Length: 3 to 64 characters, otherwise a 400.
  for (const q of ['ab', 'x'.repeat(65)]) {
    const r = await lookup('bob', q);
    assert.deepEqual([r.status, r.json.field], [400, 'q'], q);
  }
  // Accounts that already belong to a person here, or are blocked here, are not offered.
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  await linkAccount(s, 'bob', aldric.person.id, s.ids.holly);
  assert.deepEqual((await lookup('bob', 'Holly#1111')).json.accounts, []);
  await w.call(s.jars.alice, 'POST', `${s.guildPath}/people/${s.ids.ivan}/block`, {}).then((r) => assert.equal(r.status, 404, 'Ivan is no member to block'));
  await addPerson(s, 'bob', s.A, 'Eliora', { linkUserId: s.ids.erin });
  assert.deepEqual((await lookup('bob')).json.accounts, [], 'Erin is a person now: no longer offered');
  // Who may ask: roster.edit anywhere. A member, signed out, and another guild's officer cannot.
  assert.equal((await lookup('erin', 'Ivan#2222')).status, 403);
  assert.equal((await w.call({}, 'GET', `${s.guildPath}/accounts?q=Ivan%232222`)).status, 401);
  const lead = await lookup('carol', 'Ivan#2222');
  assert.deepEqual([lead.status, lead.json.error], [403, 'forbidden'], 'a Team Lead may not look accounts up by BattleTag or name...');
  assert.equal((await lookup('carol')).status, 200, '...but sees the claimants');
  const other = await w.call(await signIn(w, PEOPLE.gale, [plain(SERVER_B)]), 'GET', `${s.guildPath}/accounts?q=Ivan%232222`);
  assert.equal(other.status, 403);
});

check('GET /accounts?q=: a look-up is rate limited (40 per 10 minutes per officer) and says so', async () => {
  const s = await scenario();
  const { w } = s;
  for (let i = 0; i < 40; i++) assert.equal((await s.call('bob', 'GET', `/accounts?q=Nobody${i}`)).status, 200, `look-up ${i}`);
  const limited = await s.call('bob', 'GET', '/accounts?q=Nobody41');
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert.match(limited.json.message, /look-ups/);
  assert(Number(limited.headers.get('Retry-After')) >= 1);
  assert.equal((await s.call('bob', 'GET', '/accounts')).status, 200, 'the claimants list is not a look-up');
  assert.equal((await s.call('alice', 'GET', '/accounts?q=Nobody1')).status, 200, 'another officer has their own window');
  w.advance(10 * 60 * 1000 + 1);
  assert.equal((await s.call('bob', 'GET', '/accounts?q=Nobody1')).status, 200, 'and the window passes');
});

// ---------------------------------------------------------------------------
// Claims

check('claims: an approved claim links the claimant\'s ACCOUNT to the person (players.user_id), alongside the Discord ID a Discord claimant carries', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.erin, BNET.erin);
  await bnetLink(w, s.jars.gina, BNET.gina);
  const brindle = await addPerson(s, 'bob', s.A, 'Brindle');
  // Erin claims a new character: approving makes a new person that belongs to her account and Discord.
  const e = (await pendClaim(s, 'erin', 'Eliora')).json.claims[0];
  const approved = await s.call('bob', 'POST', `/claims/${e.id}/approve`, approveBody('new_person', { teamId: s.A, status: 'raider' }));
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const created = (await w.rows('SELECT id, user_id, discord_user_id FROM players WHERE id = ?', approved.json.personId))[0];
  assert.deepEqual([created.user_id, created.discord_user_id], [s.ids.erin, PEOPLE.erin.id]);
  // Gina claims the unlinked person's character: approving links her account AND her Discord ID to Brindle's person.
  const g = (await pendClaim(s, 'gina', 'Brindle')).json.claims[0];
  const linked = await s.call('bob', 'POST', `/claims/${g.id}/approve`, approveBody('link_person'));
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  const person = (await w.rows('SELECT user_id, discord_user_id FROM players WHERE id = ?', brindle.person.id))[0];
  assert.deepEqual([person.user_id, person.discord_user_id], [s.ids.gina, PEOPLE.gina.id]);
  // The claim list names the claimant by what she shows; a claim by someone with a person already is an Alt on THEIR person.
  const second = (await pendClaim(s, 'erin', 'Galdor')).json.claims[0];
  const list = (await s.call('bob', 'GET', '/claims')).json.claims;
  assert.deepEqual(list.map((c) => [c.character.name, c.plan.kind]), [['Galdor', 'add_alt']]);
  assert.equal((await s.call('bob', 'POST', `/claims/${second.id}/approve`, approveBody('add_alt', { teamId: s.A }))).status, 200);
});

check('claims: a Battle.net-only member (linked to a person by an officer) loads her characters at her next Battle.net sign-in and adds an Alt to her own person at once', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  assert.equal((await linkAccount(s, 'bob', aldric.person.id, s.ids.holly)).status, 200);
  // Her snapshot predates the guild: she is asked to refresh.
  let view = (await w.call(holly, 'GET', '/auth/bnet')).json;
  assert.equal(view.guilds[0].status, 'needs_refresh');
  assert.equal((await s.call('holly', 'POST', '/claims', claimBody('Galdor'))).json.error, 'bnet_refresh');
  // Signing in with Battle.net again refreshes it.
  await bnetSignIn(w, BNET.holly, holly);
  view = (await w.call(holly, 'GET', '/auth/bnet')).json;
  assert.equal(view.guilds[0].status, 'ok');
  const aldricRow = view.guilds[0].characters.find((c) => c.name === 'Aldric');
  assert.equal(aldricRow.state, 'yours', 'the character on her own person is hers');
  assert.equal(view.guilds[0].characters.find((c) => c.name === 'Galdor').state, 'new');
  const claim = await s.call('holly', 'POST', '/claims', claimBody('Galdor'));
  assert.equal(claim.status, 201, JSON.stringify(claim.json));
  assert.deepEqual([claim.json.claims[0].status, claim.json.claims[0].outcome, claim.json.claims[0].personId], ['applied', 'add_alt', aldric.person.id], 'applied at once, on her own person');
  assert.equal((await s.call('holly', 'POST', '/claims', claimBody('Aldric'))).json.error, 'already_yours');
  assert.deepEqual((await s.call('bob', 'GET', '/claims')).json.claims, [], 'nothing waits for an officer');
  assert.deepEqual((await w.rows('SELECT name, team_id FROM characters WHERE player_id = ? ORDER BY name', aldric.person.id)).map((r) => [r.name, r.team_id]), [['Aldric', s.A], ['Galdor', null]], 'the new alt is on no team');
  // An account that is not a member cannot claim at all.
  const ivan = await signUpHolly(s, 'ivan');
  assert.equal((await w.call(ivan, 'POST', `${s.guildPath}/claims`, claimBody('Brindle'))).status, 403);
});

check('the 30-day purge clears a Battle.net snapshot but never the sign-in: the account still signs in, and its page says the characters expired', async () => {
  const s = await scenario();
  const { w } = s;
  await bnetLink(w, s.jars.erin, BNET.erin);
  const { purgeExpiredBnetData } = await load('worker/bnet-purge.js');
  w.advance(31 * DAY);
  await signIn(w, PEOPLE.erin, [plain(SERVER_A)], s.jars.erin); // her 30-day session is over, the snapshot is older still
  // Before the purge runs, the stale list is already hidden and no claim can use it.
  const stale = (await w.call(s.jars.erin, 'GET', '/auth/bnet')).json;
  assert.equal(stale.link.expired, true);
  assert.equal(stale.guilds[0].status, 'expired');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.error, 'bnet_refresh');
  assert.deepEqual(await purgeExpiredBnetData(w.db, w.clock.now), { snapshots: 1, pendingClaims: 0, decidedClaims: 0 });
  assert.equal(await w.count('bnet_links'), 1);
  assert.equal((await w.rows("SELECT snapshot FROM bnet_links"))[0].snapshot, '{}');
  const after = (await w.call(s.jars.erin, 'GET', '/auth/bnet')).json;
  assert.equal(after.link.battletag, 'Erin#0005', 'the identity is kept');
  assert.equal(after.guilds[0].status, 'expired');
  // Signing in with Battle.net still works, and brings the characters back.
  const { callback } = await bnetSignIn(w, BNET.erin);
  assert.equal(locationOf(callback), '/#/');
  assert.equal((await w.call(s.jars.erin, 'GET', '/auth/bnet')).json.guilds[0].status, 'ok');
  // A Battle.net-only account's purge keeps it able to sign in as well.
  await bnetSignIn(w, BNET.holly);
  w.advance(31 * DAY);
  await purgeExpiredBnetData(w.db, w.clock.now);
  assert.equal(locationOf((await bnetSignIn(w, BNET.holly)).callback), '/#/');
  assert.equal(await w.count('users', "discord_id IS NULL"), 1);
});

// ---------------------------------------------------------------------------
// Delete my data, the display name

check('Delete my data for a Battle.net-only account: the account, its link and sessions go; the roster person stays, unlinked, with its version moved', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  await linkAccount(s, 'bob', aldric.person.id, s.ids.holly);
  const version = (await w.rows('SELECT version FROM players WHERE id = ?', aldric.person.id))[0].version;
  await s.w.call(s.jars.bob, 'GET', `${s.guildPath}/accounts?q=Nobody`); // an acct: window
  const del = await w.call(holly, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(await w.count('users', 'id = ?', s.ids.holly), 0);
  assert.equal(await w.count('bnet_links'), 0);
  assert.equal(await w.count('sessions', 'user_id = ?', s.ids.holly), 0);
  const person = (await w.rows('SELECT user_id, discord_user_id, version FROM players WHERE id = ?', aldric.person.id))[0];
  assert.deepEqual([person.user_id, person.discord_user_id, person.version], [null, null, version + 1]);
  assert.equal(await w.count('characters', 'player_id = ?', aldric.person.id), 1);
  assert(del.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_session=;')));
  assert.equal((await w.call(holly, 'GET', '/auth/me')).status, 401);
  assert.equal(await w.count('audit_log', "action = 'account.delete'"), 1);
  assert.equal(await w.count('audit_log', "action = 'person.account_link' AND actor_user_id IS NOT NULL"), 1, 'the officer\'s audit row stays');
  // The Battle.net account is free again: signing up with it makes a brand-new account.
  const again = await bnetSignIn(w, BNET.holly);
  assert.equal(locationOf(again.callback), '/#/');
  assert.notEqual((await w.call(again.jar, 'GET', '/auth/me')).json.user.id, s.ids.holly);
});

// ---------------------------------------------------------------------------
// Native sign-ups (Phase 6) read "which person am I" through the same rule as everything else (worker/membership.js)

const UPCOMING = '2027-02-02'; // a Tuesday, well after the test clock (2027-01-15)
const upcomingRaid = async (s, teamId = s.A) => {
  const made = await s.call('bob', 'POST', '/raids', { teamId, raidOn: UPCOMING, startTime: '20:00' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.raid.id;
};

check('sign-ups: a Battle.net-only account an officer linked to a person signs up for a raid of its team; an unlinked one cannot, and neither can a linked one for another team', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric', { class: 'PRIEST', mainSpec: 'Holy' });
  const raidA = await upcomingRaid(s, s.A);
  const raidB = await upcomingRaid(s, s.B);
  const mine = (raid, body, jar = holly) => w.call(jar, 'PUT', `${s.guildPath}/raids/${raid}/signup`, body);
  // Unlinked: not in the guild at all, so nothing about it opens.
  for (const [method, route, body] of [['GET', `/raids/${raidA}/signups`], ['GET', `/raids/${raidA}/signup`], ['PUT', `/raids/${raidA}/signup`, { kind: 'signed' }], ['GET', `/raids?team=${s.A}`]]) {
    const r = await w.call(holly, method, `${s.guildPath}${route}`, body);
    assert.deepEqual([r.status, r.json.error], [403, 'not_member'], `${method} ${route}`);
  }
  assert.equal(await w.count('raid_signups', "source = 'raidsmith'"), 0);

  // Linked by an officer: she is a member with the rights of her own team, and the sign-up panel knows her person.
  assert.equal((await linkAccount(s, 'bob', aldric.person.id, s.ids.holly)).status, 200);
  const panel = await w.call(holly, 'GET', `${s.guildPath}/raids/${raidA}/signups`);
  assert.equal(panel.status, 200, JSON.stringify(panel.json));
  assert.deepEqual([panel.json.can.self, panel.json.me.personId, panel.json.me.canChange], [true, aldric.person.id, true]);
  assert.deepEqual(panel.json.me.characters.map((c) => c.name), ['Aldric']);
  const put = await mine(raidA, { kind: 'signed', note: 'bnet only' });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual([put.json.me.signup.kind, put.json.me.signup.isMe, put.json.me.signup.note, put.json.entries.length], ['signed', true, 'bnet only', 1]);
  const row = (await w.rows("SELECT player_id, updated_by, discord_user_id, nickname FROM raid_signups WHERE source = 'raidsmith'"))[0];
  assert.deepEqual(row, { player_id: aldric.person.id, updated_by: s.ids.holly, discord_user_id: null, nickname: null });
  // The Raids list says what she signed up as, and that she may.
  const list = (await w.call(holly, 'GET', `${s.guildPath}/raids?team=${s.A}`)).json;
  assert.equal(list.can.signup, true);
  assert.deepEqual(list.upcoming.find((r) => r.id === raidA).mine, { kind: 'signed', source: 'raidsmith', characterName: 'Aldric' });
  // The officer's planner seed carries her sign-up under her character's name.
  const seed = (await s.call('bob', 'GET', `/raids/${raidA}/planner`)).json;
  assert.deepEqual(seed.signups.map((e) => [e.name, e.personId, e.kind]), [['Aldric', aldric.person.id, 'signed']]);
  // Changing and withdrawing work for her too.
  assert.equal((await mine(raidA, { kind: 'late' })).json.me.signup.kind, 'late');
  assert.equal((await w.call(holly, 'DELETE', `${s.guildPath}/raids/${raidA}/signup`, {})).status, 200);
  assert.equal(await w.count('raid_signups', "source = 'raidsmith'"), 0);

  // Her person has no character on Bravo: she sees the raid but may not sign up for it.
  const other = await mine(raidB, { kind: 'signed' });
  assert.deepEqual([other.status, other.json.error], [403, 'forbidden']);
  assert.equal((await w.call(holly, 'GET', `${s.guildPath}/raids?team=${s.B}`)).json.can.signup, false);

  // Unlinked again: she is out of the guild, and the sign-up she made stays with the person.
  assert.equal((await mine(raidA, { kind: 'signed' })).status, 200);
  assert.equal((await linkAccount(s, 'bob', aldric.person.id, null)).status, 200);
  const gone = await mine(raidA, { kind: 'tentative' });
  assert.deepEqual([gone.status, gone.json.error], [403, 'not_member']);
  assert.deepEqual(await w.rows("SELECT kind FROM raid_signups WHERE source = 'raidsmith'"), [{ kind: 'signed' }]);
});

check('sign-ups: the same person is found by link or by Discord ID, whichever the account has - Discord added to a Battle.net account later, and a Discord account with no link', async () => {
  const s = await scenario();
  const { w } = s;
  const raid = await upcomingRaid(s, s.A);
  const sign = (jar, body = { kind: 'signed' }) => w.call(jar, 'PUT', `${s.guildPath}/raids/${raid}/signup`, body);
  // Erin: in the Discord server, her person carries her Discord ID (no account link).
  const eliora = await addPerson(s, 'bob', s.A, 'Eliora', { class: 'PRIEST', mainSpec: 'Holy' });
  await w.db.prepare('UPDATE players SET discord_user_id = ? WHERE id = ?').bind(PEOPLE.erin.id, eliora.person.id).run();
  const erin = await sign(s.jars.erin);
  assert.equal(erin.status, 200, JSON.stringify(erin.json));
  assert.equal(erin.json.me.personId, eliora.person.id);
  // Gina: in the Discord server, nothing links her to a person: no sign-up.
  const none = await sign(s.jars.gina);
  assert.deepEqual([none.status, none.json.error], [403, 'forbidden']);
  // Holly: Battle.net only, linked by an officer to a person with no Discord ID; she connects Discord afterwards (not in the server).
  const holly = await signUpHolly(s);
  const brindle = await addPerson(s, 'bob', s.A, 'Brindle', { class: 'MAGE', mainSpec: 'Fire' });
  assert.equal((await linkAccount(s, 'bob', brindle.person.id, s.ids.holly)).status, 200);
  const linked = await discordLink(w, holly, PEOPLE.gale, []);
  assert.equal(locationOf(linked.callback), '/#/linked', 'Discord connected');
  const hollySign = await sign(holly);
  assert.equal(hollySign.status, 200, JSON.stringify(hollySign.json));
  assert.equal(hollySign.json.me.personId, brindle.person.id);
  // Two people on the raid, each counted once, and only the viewer's own is marked as theirs.
  const list = (await s.call('bob', 'GET', `/raids/${raid}/signups`)).json;
  assert.deepEqual(list.entries.map((e) => e.personId).sort(), [brindle.person.id, eliora.person.id].sort());
  assert.deepEqual(hollySign.json.entries.filter((e) => e.isMe).map((e) => e.personId), [brindle.person.id]);
});

check('Delete my data for a Battle.net-only account that signed up: its notes go, the sign-up stays with the person (updated_by cleared), the officer\'s note stays', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  const brindle = await addPerson(s, 'bob', s.A, 'Brindle', { class: 'MAGE', mainSpec: 'Fire' });
  await linkAccount(s, 'bob', aldric.person.id, s.ids.holly);
  const raid = await upcomingRaid(s, s.A);
  assert.equal((await w.call(holly, 'PUT', `${s.guildPath}/raids/${raid}/signup`, { kind: 'signed', note: 'my own words' })).status, 200);
  assert.equal((await s.call('bob', 'PUT', `/raids/${raid}/signups/${brindle.person.id}`, { kind: 'bench', note: 'officer note' })).status, 200);
  const del = await w.call(holly, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(await w.count('users', 'id = ?', s.ids.holly), 0);
  const rows = await w.rows("SELECT player_id, kind, note, updated_by, discord_user_id, nickname FROM raid_signups WHERE source = 'raidsmith' ORDER BY signup_id");
  assert.deepEqual(rows, [
    { player_id: aldric.person.id, kind: 'signed', note: null, updated_by: null, discord_user_id: null, nickname: null },
    { player_id: brindle.person.id, kind: 'bench', note: 'officer note', updated_by: s.ids.bob, discord_user_id: null, nickname: null },
  ]);
  assert.equal((await w.rows('SELECT user_id FROM players WHERE id = ?', aldric.person.id))[0].user_id, null, 'the person is unlinked from the deleted account');
});

check('Delete my data for a Guild Master: someone linked to a roster person counts as another member, so the guild is handed over, not deleted', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', { ...GUILD_BODY, multipleTeams: false });
  const gid = created.json.guild.id;
  const before = (await w.call(alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual(before.guildsDeleted, [{ id: gid, name: 'Ember' }]);
  // A Battle.net-only member, linked to a person by Alice, is the only other member (nobody else is in the Discord server).
  const holly = (await bnetSignIn(w, BNET.holly)).jar;
  const hollyId = (await w.call(holly, 'GET', '/auth/me')).json.user.id;
  const made = await w.call(alice, 'POST', `/api/guild/${gid}/roster`, { teamId: created.json.teams[0].id, name: 'Aldric', class: 'WARRIOR', mainSpec: 'Arms', status: 'raider' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await w.call(alice, 'PUT', `/api/guild/${gid}/roster/${made.json.person.id}/account`, { userId: hollyId })).status, 200);
  const after = (await w.call(alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual([after.handOverFirst, after.guildsDeleted], [[{ id: gid, name: 'Ember' }], []]);
  const blocked = await w.call(alice, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'hand_over_guild_master');
  // Holly leaves (deletes her data): the guild is Alice's alone again.
  assert.equal((await w.call(holly, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.deepEqual((await w.call(alice, 'GET', '/auth/me')).json.deleteImpact.guildsDeleted, [{ id: gid, name: 'Ember' }]);
});

check('PATCH /api/me: sets, clears and validates the display name; it shows everywhere the account does, and an officer sees the Discord username too', async () => {
  const s = await scenario();
  const { w } = s;
  const patch = (who, body) => w.call(s.jars[who], 'PATCH', '/api/me', body);
  const set = await patch('erin', { displayName: '  Ember Erin  ' });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.deepEqual([set.json.customName, set.json.user.displayName, set.json.user.username], ['Ember Erin', 'Ember Erin', 'erin']);
  const me = (await w.call(s.jars.erin, 'GET', '/auth/me')).json;
  assert.deepEqual([me.user.displayName, me.account.customName], ['Ember Erin', 'Ember Erin']);
  const entry = (await s.call('bob', 'GET', '/people')).json.people.find((p) => p.person.id === s.ids.erin);
  assert.deepEqual([entry.person.displayName, entry.person.username], ['Ember Erin', 'erin'], 'People and roles still shows the Discord username');
  // Invisible and direction characters are dropped; control characters and bad lengths are refused.
  const hidden = await patch('erin', { displayName: 'Er\u202ein\u200b' });
  assert.equal(hidden.json.customName, 'Erin');
  assert.equal((await patch('erin', { displayName: 'tab\there\nnow' })).json.customName, 'tabherenow', 'control characters are dropped');
  for (const bad of ['x'.repeat(33), '\u200b\u202e', '   ', 5, true, ['a'], {}]) {
    const r = await patch('erin', { displayName: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.field, 'displayName');
  }
  assert.equal((await patch('erin', {})).status, 400, 'the key is required');
  assert.equal((await patch('erin', { displayName: 'x'.repeat(32) })).status, 200, '32 characters fit');
  // Clearing goes back to the Discord name, with null or an empty string.
  for (const clear of [null, '']) {
    await patch('erin', { displayName: 'Temp' });
    const r = await patch('erin', { displayName: clear });
    assert.deepEqual([r.status, r.json.customName, r.json.user.displayName], [200, null, 'Erin E']);
  }
  assert.equal((await w.rows('SELECT display_name FROM users WHERE id = ?', s.ids.erin))[0].display_name, null);
  assert.equal((await w.call({}, 'PATCH', '/api/me', { displayName: 'x' })).status, 401);
  assert.equal((await w.req('PATCH', '/api/me', { jar: s.jars.erin, body: { displayName: 'x' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await w.req('PATCH', '/api/me', { jar: s.jars.erin, rawBody: '{"displayName":"x"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

check('every route of the account flows sends no-store and security headers, and no answer carries a token, a secret or another account\'s Discord ID', async () => {
  const s = await scenario();
  const { w } = s;
  const holly = await signUpHolly(s);
  await discordLink(w, holly, PEOPLE.gale, [plain(SERVER_A)]);
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric');
  const answers = [
    await w.call(holly, 'GET', '/auth/me'), await w.call(holly, 'GET', '/auth/bnet'), await w.call({}, 'GET', '/auth/providers'),
    await w.call(holly, 'PATCH', '/api/me', { displayName: 'Hollyhock' }), await s.call('bob', 'GET', '/accounts?q=Holly%231111'),
    await linkAccount(s, 'bob', aldric.person.id, s.ids.holly),
  ];
  for (const answer of answers) {
    assert.equal(answer.headers.get('Cache-Control'), 'no-store');
    assert.equal(answer.headers.get('X-Content-Type-Options'), 'nosniff');
    const text = JSON.stringify(answer.json);
    for (const secret of ['bnet-secret', 'client-secret', 'fake-member-token', BNET.holly.id, '__Host-rs']) assert(!text.includes(secret), secret);
  }
  // Another account's Discord ID shows only inside avatar URLs, and not to an ordinary member at all.
  const memberView = JSON.stringify([(await s.call('erin', 'GET', `/roster/${aldric.person.id}`)).json, (await s.call('erin', 'GET', `/roster?team=${s.A}`)).json]);
  assert(!memberView.includes(PEOPLE.gale.id), 'no Discord ID in a member\'s roster answers');
});

// ---------------------------------------------------------------------------

async function closeWorlds() {
  while (openWorlds.length) {
    const world = openWorlds.pop();
    const closed = new Promise((resolve) => world.bnet.server.close(resolve));
    world.bnet.server.closeAllConnections();
    await closed;
  }
}

async function main() {
  let passed = 0;
  let failed = 0;
  const only = process.argv[2];
  for (const { name, fn } of checks) {
    if (only && !name.includes(only)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    } finally {
      await closeWorlds();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
