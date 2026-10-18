/**
 * Raidsmith guild tracker - Battle.net Worker tests (Phase 5)
 * Run: node guild-bnet-worker-tests.js
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs every migration, 0009_battlenet.sql included), with
 * Discord faked by an injected fetch and Battle.net by tools/fake-battlenet.js on a local port (the Worker reaches it through BNET_API_BASE,
 * which it honours only for localhost). The fake's `state` is changed in place to make Blizzard misbehave. No network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');
const { createFakeBattlenet } = require('./tools/fake-battlenet');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

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
  frank: { id: '110000000000000007', username: 'frank', globalName: 'Frank F' },
};
const ACCOUNT = { alice: '500000001', bob: '500000002', carol: '500000003', dave: '500000004', erin: '500000005', gina: '500000006', frank: '500000007' };
const TAG = (name) => `${name[0].toUpperCase()}${name.slice(1)}#${ACCOUNT[name].slice(-4)}`;

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

async function makeWorld({ allowlist = [], env = {} } = {}) {
  const { createApp } = await load('worker/index.js');
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  const db = createD1Fake();
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

async function signIn(world, person, servers = [], jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

// Alice (Guild Master) creates a TBC US Dreamscythe guild with two teams; Bob is Officer, Carol Team Lead of Alpha, Dave Team Lead of Bravo;
// Erin and Gina are Members. Frank runs a second guild on SERVER_B.
async function scenario({ guildBody = {} } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', { ...GUILD_BODY, ...guildBody });
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

// A member links Battle.net through the real routes: the login redirect, then the callback the browser would be sent back to.
async function link(s, name, { account } = {}) {
  s.w.bnet.state.account = account || { id: ACCOUNT[name], battletag: TAG(name) };
  const login = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars[name] });
  assert.equal(login.status, 302, 'login redirects');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[name] });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('Location'), '/#/characters', `linked: ${callback.headers.get('Location')}`);
  return state;
}

const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// The roster used by the claim tests: Aldric (Alpha, linked to Erin), Brindle (Alpha, nobody linked), Dunmar (Bravo, linked to Dave).
async function seedRoster(s) {
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric', { linkUserId: s.ids.erin });
  const brindle = await addPerson(s, 'bob', s.A, 'Brindle');
  const dunmar = await addPerson(s, 'bob', s.B, 'Dunmar', { class: 'HUNTER', mainSpec: 'Marksmanship', linkUserId: s.ids.dave });
  return { aldric: aldric.person.id, brindle: brindle.person.id, dunmar: dunmar.person.id };
}

async function assertOneMain(w) {
  const bad = await w.rows(
    `SELECT p.id, COALESCE(SUM(c.is_main), 0) AS mains FROM players p LEFT JOIN characters c ON c.player_id = p.id GROUP BY p.id HAVING mains != 1`,
  );
  assert.deepEqual(bad, [], 'every person has exactly one Main');
}

const claimBody = (...names) => ({ characters: names.map((name) => ({ name, realmSlug: name === 'Cassia' || name === 'Fenwick' ? 'nightslayer' : 'dreamscythe' })) });
const approveBody = (kind, extra = {}) => ({ expectedKind: kind, ...extra });
const plainJson = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// battlenet.js: the data tables and pure helpers

check('namespaces: one data table gives the profile namespace per version and region; WoW Forever is unsupported with the plain message', async () => {
  const { NAMESPACES, API_REGIONS, CLASS_BY_ID, bnetSupport } = await load('worker/battlenet.js');
  assert.deepEqual(plainJson(NAMESPACES), {
    tbc: { label: 'TBC Anniversary', profile: 'profile-classicann' },
    classic: { label: 'Classic Era', profile: 'profile-classic1x' },
    forever: { label: 'WoW Forever', profile: null },
  });
  assert.deepEqual(plainJson(API_REGIONS), { US: 'us', EU: 'eu', KR: 'kr', TW: 'tw' });
  assert.deepEqual(bnetSupport('tbc', 'EU'), { supported: true, label: 'TBC Anniversary', namespace: 'profile-classicann-eu', message: null });
  assert.equal(bnetSupport('classic', 'TW').namespace, 'profile-classic1x-tw');
  assert.equal(bnetSupport('tbc', 'US').namespace, 'profile-classicann-us');
  const forever = bnetSupport('forever', 'US');
  assert.equal(forever.supported, false);
  assert.equal(forever.namespace, null);
  assert.equal(forever.message, 'Battle.net doesn\'t offer character data for WoW Forever yet.');
  assert.equal(bnetSupport('tbc', 'CN').supported, false, 'an unknown region has no host');
  assert.equal(bnetSupport('toString', 'US').supported, false, 'a prototype key is not a version');
  assert.deepEqual(plainJson(CLASS_BY_ID), { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' });
});

check('slugs: realm slugs drop apostrophes and spaces, guild slugs keep non-ASCII letters, and nothing unsafe becomes a path', async () => {
  const { realmSlugOf, guildSlug, isRealmSlug } = await load('worker/battlenet.js');
  assert.equal(realmSlugOf("Sul'thraze"), 'sulthraze');
  assert.equal(realmSlugOf("Dragon's Call"), 'dragons-call');
  assert.equal(realmSlugOf('Old Blanchy'), 'old-blanchy');
  assert.equal(realmSlugOf('Arugal (AU)'), 'arugal-au');
  assert.equal(realmSlugOf('Хроми'), '', 'not ASCII: no guess');
  assert.equal(realmSlugOf(5), '');
  assert.equal(guildSlug('Dah Boo'), 'dah-boo');
  assert.equal(guildSlug("Ember's  Company!"), 'embers-company');
  assert.equal(guildSlug('Gilde Nörgler'), 'gilde-nörgler');
  assert.equal(guildSlug('../../x'), 'x');
  assert.equal(guildSlug(''), '');
  assert.equal(guildSlug('x'.repeat(61)), '');
  assert(isRealmSlug('shimmering-flats') && !isRealmSlug('Bad Slug') && !isRealmSlug('../x') && !isRealmSlug('a--b') && !isRealmSlug('x'.repeat(51)));
});

check('BNET_API_BASE is honoured only for localhost; the real hosts are oauth.battle.net and {region}.api.blizzard.com', async () => {
  const { authorizeUrl, canonicalOrigin, isConfigured, redirectUri } = await load('worker/battlenet.js');
  const env = { BNET_CLIENT_ID: 'id', BNET_CLIENT_SECRET: 's', BNET_REDIRECT_URI: 'https://raidsmith.example/auth/bnet/callback' };
  assert.equal(isConfigured(env), true);
  assert.equal(isConfigured({ ...env, BNET_CLIENT_SECRET: '' }), false);
  assert.equal(isConfigured({ ...env, BNET_REDIRECT_URI: 'not a url' }), false);
  assert.equal(canonicalOrigin(env), 'https://raidsmith.example');
  assert.equal(redirectUri(env), env.BNET_REDIRECT_URI);
  const url = new URL(authorizeUrl(env, 'abc.def'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://oauth.battle.net/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'id', redirect_uri: env.BNET_REDIRECT_URI, response_type: 'code', scope: 'openid wow.profile', state: 'abc.def',
  });
  assert.equal(new URL(authorizeUrl({ ...env, BNET_API_BASE: 'https://evil.example' }, 's')).origin, 'https://oauth.battle.net', 'an arbitrary base is ignored');
  assert.equal(new URL(authorizeUrl({ ...env, BNET_API_BASE: 'http://127.0.0.1:8792/' }, 's')).origin, 'http://127.0.0.1:8792');
  assert.equal(new URL(authorizeUrl({ ...env, BNET_API_BASE: 'http://localhost:9' }, 's')).origin, 'http://localhost:9');
});

// ---------------------------------------------------------------------------
// Schema

check('schema: 0009 adds the link and claim tables, one open claim per character, one link per Battle.net account, and the guild settings columns', async () => {
  const w = await makeWorld();
  const exec = (sql) => w.db.sqlite.exec(sql);
  exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u1', 'u1', '1', 'a', 1, 1), ('u2', 'u2', '2', 'b', 1, 1)`);
  exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'UTC', 'tbc', 1)`);
  exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('u1', '123', 'A#1', 1, '{}', 1)`);
  assert.throws(() => exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('u2', '123', 'B#2', 1, '{}', 1)`), /UNIQUE constraint failed/);
  assert.throws(() => exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('u2', 'abc', 'B#2', 1, '{}', 1)`), /CHECK constraint failed/);
  assert.throws(() => exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('u2', '124', 'B#2', 1, '[]', 1)`), /CHECK constraint failed/);
  const claim = (id, user, name, status = 'pending') => `INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, decided_at, created_at)
    VALUES ('${id}', 'g1', '${user}', '${name}', '${name.toLowerCase()}', 'R', 'r', 'MAGE', 70, '${status}', ${status === 'pending' ? 'NULL' : '5'}, 1)`;
  exec(claim('cl1', 'u1', 'Aldric'));
  assert.throws(() => exec(claim('cl2', 'u2', 'Aldric')), /UNIQUE constraint failed/);
  exec(claim('cl3', 'u2', 'Aldric', 'rejected'));
  exec(claim('cl4', 'u2', 'Aldric', 'approved'));
  assert.throws(() => exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm_key, class, status, created_at) VALUES ('cl5', 'g1', 'u1', 'X', 'x', '', 'DEATHKNIGHT', 'pending', 1)`), /CHECK constraint failed/);
  assert.throws(() => exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm_key, class, status, created_at) VALUES ('cl5', 'g1', 'u1', 'X', 'x', '', 'MAGE', 'approved', 1)`), /CHECK constraint failed/, 'a decided claim has a decision time');
  assert.throws(() => exec(`UPDATE guilds SET bnet_realm_slug = 'Bad Slug' WHERE id = 'g1'`), /CHECK constraint failed/);
  assert.throws(() => exec(`UPDATE guilds SET bnet_rank_labels = '{}' WHERE id = 'g1'`), /CHECK constraint failed/);
  exec(`UPDATE guilds SET bnet_guild_name = 'Ember', bnet_realm_slug = 'old-blanchy', bnet_rank_labels = '["GM"]' WHERE id = 'g1'`);
  exec(`DELETE FROM users WHERE id = 'u1'`);
  assert.equal(await w.count('bnet_links'), 0, 'deleting the user cascades the link');
  assert.equal(await w.count('character_claims', "user_id = 'u1'"), 0, 'and their claims');
  assert.equal(await w.count('character_claims', "user_id = 'u2'"), 2);
});

// ---------------------------------------------------------------------------
// Link: login

check('link: signed-out visitors are sent to sign in, an unconfigured server says so, and the wrong origin is sent to the right one', async () => {
  const s = await scenario();
  const anon = await s.w.req('GET', '/auth/bnet/login');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('Location'), '/#/signin');
  assert.deepEqual(s.w.asked(), [], 'nothing reached Battle.net');
  s.w.env.BNET_CLIENT_SECRET = '';
  const off = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin });
  assert.equal(off.headers.get('Location'), '/#/linked?error=not_configured');
  s.w.env.BNET_CLIENT_SECRET = 'bnet-secret';
  const other = await s.w.app.handle(new Request('https://elsewhere.test/auth/bnet/login', { headers: { Cookie: Object.entries(s.jars.erin).map(([k, v]) => `${k}=${v}`).join('; ') } }));
  assert.equal(other.status, 302);
  assert.equal(other.headers.get('Location'), `${ORIGIN}/auth/bnet/login`);
  assert.equal(other.headers.get('Set-Cookie'), null);
});

check('link: login redirects to Battle.net with the scopes, the registered redirect URI and a signed state in its own HttpOnly cookie', async () => {
  const s = await scenario();
  const res = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin });
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('Location'));
  assert.equal(`${target.origin}${target.pathname}`, `${s.w.env.BNET_API_BASE}/authorize`);
  assert.equal(target.searchParams.get('client_id'), 'bnet-id');
  assert.equal(target.searchParams.get('scope'), 'openid wow.profile');
  assert.equal(target.searchParams.get('response_type'), 'code');
  assert.equal(target.searchParams.get('redirect_uri'), `${ORIGIN}/auth/bnet/callback`);
  const state = target.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  const cookie = res.headers.getSetCookie().find((line) => line.startsWith('__Host-rs_bnet_state='));
  assert(cookie.includes(`=${state};`) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie) && /Max-Age=600/.test(cookie));
  assert(!res.headers.getSetCookie().some((line) => line.startsWith('__Host-rs_session')), 'the session cookie is not touched');
  assert(!JSON.stringify(res.headers.getSetCookie()).includes('bnet-secret'));
  const { verifyBnetState } = await load('worker/session.js');
  assert.equal(await verifyBnetState(s.w.env, s.ids.erin, state), true);
  assert.equal(await verifyBnetState(s.w.env, s.ids.gina, state), false, 'bound to the member who started it');
  assert.equal(await verifyBnetState({ ...s.w.env, BNET_CLIENT_SECRET: 'other' }, s.ids.erin, state), false);
  assert.equal(await verifyBnetState(s.w.env, s.ids.erin, `${state.split('.')[0]}.${'A'.repeat(43)}`), false);
  assert.equal(await verifyBnetState(s.w.env, s.ids.erin, 'x'), false);
});

check('link: starting the link is limited to 10 a window per member', async () => {
  const s = await scenario();
  for (let i = 0; i < 10; i++) assert.equal((await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin })).headers.get('Location').startsWith(s.w.env.BNET_API_BASE), true);
  assert.equal((await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin })).headers.get('Location'), '/#/linked?error=busy');
  assert.equal((await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.gina })).headers.get('Location').startsWith(s.w.env.BNET_API_BASE), true, 'another member is unaffected');
  s.w.advance(11 * 60 * 1000);
  assert.equal((await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin })).headers.get('Location').startsWith(s.w.env.BNET_API_BASE), true);
});

// ---------------------------------------------------------------------------
// Link: callback

check('callback: stores the account id, BattleTag and the character snapshot, uses the token only inside the request, and audits without names', async () => {
  const s = await scenario();
  const state = await link(s, 'erin');
  const [row] = await s.w.rows('SELECT * FROM bnet_links');
  assert.equal(row.user_id, s.ids.erin);
  assert.equal(row.bnet_account_id, ACCOUNT.erin);
  assert.equal(row.battletag, TAG('erin'));
  assert.equal(row.linked_at, s.w.clock.now);
  assert.equal(row.snapshot_at, s.w.clock.now);
  const snapshot = JSON.parse(row.snapshot);
  assert.deepEqual(Object.keys(snapshot), ['profile-classicann-us'], 'one entry per namespace among the member\'s guilds');
  const entry = snapshot['profile-classicann-us'];
  assert.equal(entry.fetchedAt, s.w.clock.now);
  assert.deepEqual(entry.characters.map((c) => c.name), ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Galdor', 'Quillfeather', 'Stranger'], 'the Death Knight is dropped');
  assert.deepEqual(entry.characters[0], { name: 'Aldric', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'WARRIOR', level: 70 });
  assert.deepEqual(entry.characters.find((c) => c.name === 'Cassia'), { name: 'Cassia', realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'PRIEST', level: 68 });
  assert.equal(entry.characters.find((c) => c.name === 'Stranger').realm, 'Faraway Isle', 'an unlisted realm is named from its slug');
  // The calls: the code for a token (Basic auth), user info, one profile call for the one namespace; nothing else.
  assert.deepEqual(s.w.asked().map((r) => `${r.method} ${r.path} ${r.namespace || ''} ${r.token}`), [
    'POST /token  basic', `GET /userinfo  member`, 'GET /profile/user/wow profile-classicann-us member',
  ]);
  // No token, code, secret or state is stored anywhere.
  const dump = JSON.stringify(await s.w.rows('SELECT * FROM bnet_links')) + JSON.stringify(await s.w.rows('SELECT * FROM audit_log')) + JSON.stringify(await s.w.rows('SELECT * FROM sessions'));
  for (const secret of ['fake-member-token', 'fake-client-token', 'bnet-secret', 'fakecode', state.split('.')[0], 'abc']) assert(!dump.includes(secret), secret);
  const audit = await s.w.rows("SELECT guild_id, actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE action = 'bnet.link'");
  assert.deepEqual(audit, [{ guild_id: null, actor_user_id: s.ids.erin, entity_type: 'user', entity_id: s.ids.erin, before: null, after: null }]);
});

check('callback: the snapshot covers each distinct game version + region among the member\'s guilds, and WoW Forever is skipped', async () => {
  const s = await scenario();
  // Frank's second guild: Classic Era on EU, and a third on WoW Forever; Erin joins both servers.
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B), manageable('900000000000000003')]);
  assert.equal((await s.w.call(frank, 'POST', '/api/guild', { serverId: SERVER_B, gameVersion: 'classic', region: 'EU', realm: 'Firemaw', name: 'Era', timeZone: 'UTC', multipleTeams: false })).status, 201);
  assert.equal((await s.w.call(frank, 'POST', '/api/guild', { serverId: '900000000000000003', gameVersion: 'forever', region: 'US', realm: 'Normal', name: 'Fresh', timeZone: 'UTC', multipleTeams: false })).status, 201);
  await signIn(s.w, PEOPLE.erin, [plain(SERVER_A), plain(SERVER_B), plain('900000000000000003')], s.jars.erin);
  await link(s, 'erin');
  const snapshot = JSON.parse((await s.w.rows('SELECT snapshot FROM bnet_links'))[0].snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ['profile-classic1x-eu', 'profile-classicann-us']);
  assert.deepEqual(snapshot['profile-classic1x-eu'].characters.map((c) => c.name), ['Aldric', 'Hestia', 'Ivarr', 'Stranger']);
  assert.deepEqual(s.w.asked(null, '/profile').map((r) => r.namespace).sort(), ['profile-classic1x-eu', 'profile-classicann-us']);
});

check('callback: a member with no guild still links; a namespace Blizzard fails on is recorded and the link stands', async () => {
  const s = await scenario();
  const loner = await signIn(s.w, PEOPLE.gina, []);
  s.jars.gina = loner;
  await link(s, 'gina');
  assert.deepEqual(JSON.parse((await s.w.rows('SELECT snapshot FROM bnet_links'))[0].snapshot), {});
  assert.deepEqual(s.w.asked(null, '/profile'), [], 'no guild, no profile call');
  s.w.bnet.state.fail.profile = 503;
  await link(s, 'erin');
  const snapshot = JSON.parse((await s.w.rows('SELECT snapshot FROM bnet_links WHERE user_id = ?', s.ids.erin))[0].snapshot);
  assert.deepEqual(snapshot['profile-classicann-us'], { fetchedAt: s.w.clock.now, error: 'unavailable' });
  s.w.bnet.state.fail.profile = 403;
  await link(s, 'dave');
  assert.equal(JSON.parse((await s.w.rows('SELECT snapshot FROM bnet_links WHERE user_id = ?', s.ids.dave))[0].snapshot)['profile-classicann-us'].error, 'denied');
  const me = await s.w.call(s.jars.erin, 'GET', '/auth/bnet');
  assert.equal(me.json.guilds[0].status, 'unavailable');
});

check('callback: linking again replaces the snapshot and the time; the 30 days start over', async () => {
  const s = await scenario();
  await link(s, 'erin');
  s.w.advance(20 * DAY);
  s.w.bnet.state.data.tbc = [['Aldric', 1, 70, 0]];
  await link(s, 'erin');
  const rows = await s.w.rows('SELECT linked_at, snapshot_at, snapshot FROM bnet_links');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snapshot_at, s.w.clock.now);
  assert.deepEqual(JSON.parse(rows[0].snapshot)['profile-classicann-us'].characters.map((c) => c.name), ['Aldric', 'Stranger']);
  assert.equal((await s.w.call(s.jars.erin, 'GET', '/auth/bnet')).json.link.expiresAt, s.w.clock.now + 30 * DAY);
});

check('callback: a missing, mismatched, forged or other member\'s state never reaches Battle.net', async () => {
  const s = await scenario();
  const start = async (name) => new URL((await s.w.req('GET', '/auth/bnet/login', { jar: s.jars[name] })).headers.get('Location')).searchParams.get('state');
  const stateE = await start('erin');
  const go = async (name, query, jar = s.jars[name]) => s.w.req('GET', `/auth/bnet/callback?${query}`, { jar });
  s.w.bnet.state.requests.length = 0;
  // no state cookie at all
  const noCookie = { ...s.jars.erin };
  delete noCookie['__Host-rs_bnet_state'];
  assert.equal((await go('erin', `code=abc&state=${encodeURIComponent(stateE)}`, noCookie)).headers.get('Location'), '/#/linked?error=state');
  // cookie and query differ
  assert.equal((await go('erin', `code=abc&state=${encodeURIComponent(`${stateE.split('.')[0]}.${'A'.repeat(43)}`)}`)).headers.get('Location'), '/#/linked?error=state');
  // a state Erin was given, replayed from Gina's browser: the MAC is bound to Erin
  const stolen = { ...s.jars.gina, '__Host-rs_bnet_state': stateE };
  assert.equal((await go('gina', `code=abc&state=${encodeURIComponent(stateE)}`, stolen)).headers.get('Location'), '/#/linked?error=state');
  // forged, both cookie and query agree
  const forged = `${'A'.repeat(22)}.${'B'.repeat(43)}`;
  assert.equal((await go('erin', `code=abc&state=${forged}`, { ...s.jars.erin, '__Host-rs_bnet_state': forged })).headers.get('Location'), '/#/linked?error=state');
  // signed out
  assert.equal((await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateE)}`)).headers.get('Location'), '/#/signin');
  assert.deepEqual(s.w.asked(), [], 'no outbound call was made for any of them');
  assert.equal(await s.w.count('bnet_links'), 0);
});

check('callback: access_denied, a bad or missing code, and Blizzard failing at each step send the member back with a reason and store nothing', async () => {
  const s = await scenario();
  const fresh = async () => {
    const res = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.erin });
    return encodeURIComponent(new URL(res.headers.get('Location')).searchParams.get('state'));
  };
  const cb = async (query) => (await s.w.req('GET', `/auth/bnet/callback?${query}`, { jar: s.jars.erin })).headers.get('Location');
  assert.equal(await cb(`error=access_denied&state=${await fresh()}`), '/#/linked?error=denied');
  assert.equal(await cb(`state=${await fresh()}`), '/#/linked?error=state', 'no code');
  assert.equal(await cb(`code=${'x'.repeat(513)}&state=${await fresh()}`), '/#/linked?error=state', 'a code over 512 characters');
  s.w.bnet.state.fail.token = 400;
  assert.equal(await cb(`code=abc&state=${await fresh()}`), '/#/linked?error=bnet');
  s.w.bnet.state.fail.token = 0;
  s.w.bnet.state.fail.userinfo = 500;
  assert.equal(await cb(`code=abc&state=${await fresh()}`), '/#/linked?error=bnet');
  s.w.bnet.state.fail.userinfo = 0;
  s.w.bnet.state.account = { id: 'not-a-number', battletag: 'X#1' };
  assert.equal(await cb(`code=abc&state=${await fresh()}`), '/#/linked?error=bnet', 'an unexpected user info');
  assert.equal(await count(s.w), 0);
  assert(s.w.logs.every((line) => !line.includes('abc') && !line.includes('fake-member-token') && !line.includes('bnet-secret')), 'logs hold no code, token or secret');
  const state = await fresh();
  s.w.env.BNET_CLIENT_ID = '';
  assert.equal(await cb(`code=abc&state=${state}`), '/#/linked?error=not_configured');
  async function count(w) { return w.count('bnet_links'); }
});

check('callback: one Battle.net account links to one Raidsmith member; the second is told it is taken, the first keeps the link', async () => {
  const s = await scenario();
  await link(s, 'erin');
  s.w.bnet.state.account = { id: ACCOUNT.erin, battletag: TAG('erin') };
  const res = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.gina });
  const state = new URL(res.headers.get('Location')).searchParams.get('state');
  const cb = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars.gina });
  assert.equal(cb.headers.get('Location'), '/#/linked?error=taken');
  assert.deepEqual((await s.w.rows('SELECT user_id FROM bnet_links')).map((r) => r.user_id), [s.ids.erin]);
});

// ---------------------------------------------------------------------------
// The member's view

check('GET /auth/bnet: signed out is 401; not linked says so; the characters carry their roster state and claim state', async () => {
  const s = await scenario();
  assert.equal((await s.w.call({}, 'GET', '/auth/bnet')).status, 401);
  const before = await s.w.call(s.jars.erin, 'GET', '/auth/bnet');
  assert.equal(before.status, 200);
  assert.equal(before.json.configured, true);
  assert.equal(before.json.link, null);
  assert.equal(before.json.guilds.length, 1);
  assert.equal(before.json.guilds[0].status, 'not_linked');
  assert.equal(before.headers.get('Cache-Control'), 'no-store');
  await seedRoster(s);
  await link(s, 'erin');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Galdor'))).status, 201);
  const res = await s.w.call(s.jars.erin, 'GET', '/auth/bnet');
  assert.equal(res.json.link.battletag, TAG('erin'));
  assert.equal(res.json.link.fetchedAt, s.w.clock.now);
  assert.equal(res.json.link.expiresAt, s.w.clock.now + 30 * DAY);
  const guild = res.json.guilds[0];
  assert.deepEqual({ id: guild.guildId, version: guild.gameVersion, region: guild.region, status: guild.status }, { id: s.guildId, version: 'tbc', region: 'US', status: 'ok' });
  const byName = Object.fromEntries(guild.characters.map((c) => [c.name, c]));
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([n, c]) => [n, c.state])), {
    Aldric: 'yours', Brindle: 'on_roster', Dunmar: 'taken', Eliora: 'new', Cassia: 'new', Fenwick: 'new', Galdor: 'new', Quillfeather: 'new', Stranger: 'other_realm',
  });
  assert.equal(byName.Aldric.claimable, false);
  assert.equal(byName.Dunmar.claimable, false);
  assert.equal(byName.Stranger.claimable, false);
  assert.equal(byName.Brindle.claimable, true, 'a person nobody linked can still be claimed');
  assert.equal(byName.Eliora.claimable, true);
  assert.equal(byName.Galdor.claimable, false, 'a claim is already waiting');
  assert.equal(byName.Galdor.claim.status, 'pending');
  assert.deepEqual(guild.characters.map((c) => c.level).slice(0, 3), [70, 70, 70], 'highest level first');
  assert(!JSON.stringify(res.json).includes('discord'), 'no Discord data about other people');
});

check('GET /auth/bnet: a version Battle.net has no data for says so, a guild joined after the link needs a refresh, a blocked guild is not listed', async () => {
  const s = await scenario();
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B), manageable('900000000000000003')]);
  const era = await s.w.call(frank, 'POST', '/api/guild', { serverId: SERVER_B, gameVersion: 'classic', region: 'EU', realm: 'Firemaw', name: 'Era', timeZone: 'UTC', multipleTeams: false });
  const forever = await s.w.call(frank, 'POST', '/api/guild', { serverId: '900000000000000003', gameVersion: 'forever', region: 'US', realm: 'Normal', name: 'Fresh', timeZone: 'UTC', multipleTeams: false });
  assert.deepEqual([era.status, forever.status], [201, 201]);
  await link(s, 'erin');
  await signIn(s.w, PEOPLE.erin, [plain(SERVER_A), plain(SERVER_B), plain('900000000000000003')], s.jars.erin);
  const res = await s.w.call(s.jars.erin, 'GET', '/auth/bnet');
  const status = Object.fromEntries(res.json.guilds.map((g) => [g.guildName, g.status]));
  assert.deepEqual(status, { Ember: 'ok', Era: 'needs_refresh', Fresh: 'unsupported' });
  const fresh = res.json.guilds.find((g) => g.guildName === 'Fresh');
  assert.equal(fresh.message, 'Battle.net doesn\'t offer character data for WoW Forever yet.');
  assert.deepEqual(fresh.characters, []);
  assert.equal((await s.call('bob', 'POST', `/people/${s.ids.erin}/block`, { reason: 'x' })).status, 200);
  assert.deepEqual((await s.w.call(s.jars.erin, 'GET', '/auth/bnet')).json.guilds.map((g) => g.guildName), ['Era', 'Fresh']);
});

check('disconnect: deletes the link and snapshot at once and audits it; it is safe to repeat; claims stay for the officers', async () => {
  const s = await scenario();
  await link(s, 'erin');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).status, 201);
  const first = await s.w.call(s.jars.erin, 'DELETE', '/auth/bnet');
  assert.deepEqual(first.json, { ok: true, removed: true });
  assert.equal(await s.w.count('bnet_links'), 0);
  assert.equal((await s.w.call(s.jars.erin, 'DELETE', '/auth/bnet')).json.removed, false);
  assert.equal(await s.w.count('audit_log', "action = 'bnet.unlink'"), 1, 'only the real removal is audited');
  assert.equal(await s.w.count('character_claims'), 1);
  assert.equal((await s.w.call(s.jars.erin, 'GET', '/auth/bnet')).json.link, null);
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Galdor'))).json.error, 'bnet_not_linked');
  assert.equal((await s.w.call({}, 'DELETE', '/auth/bnet')).status, 401);
  assert.equal((await s.w.call(s.jars.erin, 'DELETE', '/auth/bnet', null, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

// ---------------------------------------------------------------------------
// Claims: creating

check('claims: a member claims characters from their own list; the row keeps what the officers need and 201 returns them', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const res = await s.call('erin', 'POST', '/claims', claimBody('Eliora', 'Cassia'));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(res.json.claims.map((c) => [c.name, c.realm, c.class, c.level, c.status]), [
    ['Eliora', 'Dreamscythe', 'PALADIN', 61, 'pending'], ['Cassia', 'Nightslayer', 'PRIEST', 68, 'pending'],
  ]);
  const rows = await s.w.rows('SELECT guild_id, user_id, name, name_key, realm, realm_key, class, level, status, team_id, decided_by, decided_at, created_at FROM character_claims ORDER BY name');
  assert.deepEqual(rows, [
    { guild_id: s.guildId, user_id: s.ids.erin, name: 'Cassia', name_key: 'cassia', realm: 'Nightslayer', realm_key: 'nightslayer', class: 'PRIEST', level: 68, status: 'pending', team_id: null, decided_by: null, decided_at: null, created_at: s.w.clock.now },
    { guild_id: s.guildId, user_id: s.ids.erin, name: 'Eliora', name_key: 'eliora', realm: 'Dreamscythe', realm_key: 'dreamscythe', class: 'PALADIN', level: 61, status: 'pending', team_id: null, decided_by: null, decided_at: null, created_at: s.w.clock.now },
  ]);
  assert.equal(await s.w.count('audit_log', "action = 'claim.create'"), 2);
  assert.equal(await s.w.count('players'), 0, 'a claim writes nothing to the roster');
  assert.equal(await s.w.count('characters'), 0);
});

check('claims: only characters on the member\'s own list for this guild\'s namespace, and only ones this guild\'s realms take', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const post = (characters) => s.call('erin', 'POST', '/claims', { characters });
  assert.equal((await post([{ name: 'Nobody', realmSlug: 'dreamscythe' }])).status, 400, 'not on the list');
  assert.equal((await post([{ name: 'Eliora', realmSlug: 'nightslayer' }])).status, 400, 'right name, wrong realm');
  const far = await post([{ name: 'Stranger', realmSlug: 'faraway-isle' }]);
  assert.equal(far.status, 400);
  assert.equal(far.json.message, 'That character is on a different realm than this guild.');
  assert.equal((await post([])).status, 400);
  assert.equal((await post('Eliora')).status, 400);
  assert.equal((await post([{ name: 'Eliora' }])).status, 400);
  assert.equal((await post([{ name: 'Eliora', realmSlug: 'dreamscythe' }, { name: 'eliora', realmSlug: 'dreamscythe' }])).status, 400, 'twice in one request');
  assert.equal((await post(Array.from({ length: 11 }, () => ({ name: 'Eliora', realmSlug: 'dreamscythe' })))).status, 400, 'more than 10');
  assert.equal((await post([{ name: 'Gravewalk', realmSlug: 'dreamscythe' }])).status, 400, 'the Death Knight was never on the list');
  assert.equal(await s.w.count('character_claims'), 0);
  // The list of another guild's namespace is not this guild's: a Classic Era guild reads profile-classic1x only.
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const era = (await s.w.call(frank, 'POST', '/api/guild', { serverId: SERVER_B, gameVersion: 'classic', region: 'US', realm: 'Atiesh', name: 'Era', timeZone: 'UTC', multipleTeams: false })).json;
  await signIn(s.w, PEOPLE.erin, [plain(SERVER_A), plain(SERVER_B)], s.jars.erin);
  const stale = await s.w.call(s.jars.erin, 'POST', `/api/guild/${era.guild.id}/claims`, { characters: [{ name: 'Hestia', realmSlug: 'nightslayer' }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'bnet_refresh');
  await link(s, 'erin');
  const eraList = await s.w.call(s.jars.erin, 'POST', `/api/guild/${era.guild.id}/claims`, { characters: [{ name: 'Eliora', realmSlug: 'dreamscythe' }] });
  assert.equal(eraList.status, 400, 'Eliora is a TBC character, not on the Era list');
});

check('claims: not linked, an unsupported version, a failed namespace, a non-member and a blocked member are all refused with a reason', async () => {
  const s = await scenario();
  const post = (name, body = claimBody('Eliora')) => s.call(name, 'POST', '/claims', body);
  const notLinked = await post('erin');
  assert.equal(notLinked.status, 409);
  assert.equal(notLinked.json.error, 'bnet_not_linked');
  await link(s, 'erin');
  s.w.bnet.state.fail.profile = 500;
  await link(s, 'gina');
  const failed = await post('gina');
  assert.equal(failed.json.error, 'bnet_refresh');
  s.w.bnet.state.fail.profile = 0;
  const frank = await signIn(s.w, PEOPLE.frank, [manageable('900000000000000003')]);
  const forever = (await s.w.call(frank, 'POST', '/api/guild', { serverId: '900000000000000003', gameVersion: 'forever', region: 'US', realm: 'Normal', name: 'Fresh', timeZone: 'UTC', multipleTeams: false })).json;
  await signIn(s.w, PEOPLE.erin, [plain(SERVER_A), plain('900000000000000003')], s.jars.erin);
  const unsupported = await s.w.call(s.jars.erin, 'POST', `/api/guild/${forever.guild.id}/claims`, claimBody('Eliora'));
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.json.error, 'bnet_unsupported');
  assert.equal(unsupported.json.message, 'Battle.net doesn\'t offer character data for WoW Forever yet.');
  // Dave leaves the Discord server: not a member
  await signIn(s.w, PEOPLE.dave, [], s.jars.dave);
  await link(s, 'dave');
  assert.equal((await post('dave')).json.error, 'not_member');
  assert.equal((await s.call('bob', 'POST', `/people/${s.ids.erin}/block`, { reason: 'x' })).status, 200);
  assert.equal((await post('erin')).json.error, 'access_removed');
  assert.equal((await s.w.call({}, 'POST', `${s.guildPath}/claims`, claimBody('Eliora'))).status, 401);
  assert.equal(await s.w.count('character_claims'), 0);
});

check('claims: a character already on your own record, or on someone else\'s linked person, cannot be claimed; a second open claim on one character is refused', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  await link(s, 'gina');
  const yours = await s.call('erin', 'POST', '/claims', claimBody('Aldric'));
  assert.equal(yours.status, 409);
  assert.equal(yours.json.error, 'already_yours');
  assert.equal(yours.json.index, 0);
  const taken = await s.call('erin', 'POST', '/claims', claimBody('Dunmar'));
  assert.equal(taken.json.error, 'name_taken');
  assert.equal(taken.json.message, 'Dunmar is already on someone else\'s record in this guild.');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).status, 201);
  const second = await s.call('gina', 'POST', '/claims', claimBody('Eliora'));
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'claim_pending');
  const again = await s.call('erin', 'POST', '/claims', claimBody('Eliora'));
  assert.equal(again.json.error, 'claim_pending', 'not twice by the same member either');
  assert.equal((await s.call('gina', 'POST', '/claims', claimBody('Brindle'))).status, 201, 'a person nobody linked can be claimed');
  assert.equal(await s.w.count('character_claims'), 2);
});

check('claims: at most 20 waiting for officers per member per guild', async () => {
  const s = await scenario();
  await link(s, 'erin');
  s.w.db.sqlite.exec('DELETE FROM guild_blocks');
  for (let i = 0; i < 20; i++) {
    s.w.db.sqlite.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm_key, class, status, created_at) VALUES ('cl_${String(i).padStart(22, 'x')}', '${s.guildId}', '${s.ids.erin}', 'Fill${i}', 'fill${i}', '', 'MAGE', 'pending', 1)`);
  }
  const res = await s.call('erin', 'POST', '/claims', claimBody('Eliora'));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'claim_limit');
});

check('claims: a rejected claim can be made again; withdrawing is the claimant\'s own and only while pending', async () => {
  const s = await scenario();
  await link(s, 'erin');
  await link(s, 'gina');
  const first = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0].id;
  assert.equal((await s.call('gina', 'DELETE', `/claims/${first}`)).status, 404, 'someone else\'s claim');
  assert.equal((await s.call('bob', 'DELETE', `/claims/${first}`)).status, 404, 'officers reject, they do not withdraw');
  assert.equal((await s.call('erin', 'DELETE', '/claims/nope')).status, 404);
  assert.equal((await s.call('erin', 'DELETE', `/claims/${first}`)).status, 200);
  assert.equal(await s.w.count('character_claims'), 0);
  assert.equal((await s.call('erin', 'DELETE', `/claims/${first}`)).status, 404);
  const second = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0].id;
  assert.equal((await s.call('bob', 'POST', `/claims/${second}/reject`, {})).status, 200);
  assert.equal((await s.call('erin', 'DELETE', `/claims/${second}`)).status, 404, 'decided claims are not withdrawn');
  const view = (await s.w.call(s.jars.erin, 'GET', '/auth/bnet')).json.guilds[0].characters.find((c) => c.name === 'Eliora');
  assert.deepEqual([view.claim.status, view.claimable], ['rejected', true]);
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).status, 201, 'a rejected claim can be made again');
  assert.equal(await s.w.count('audit_log', "action = 'claim.withdraw'"), 1);
});

// ---------------------------------------------------------------------------
// Claims: the officers' list

check('claims list: officers and team leads see pending claims with what approving does; members and other guilds do not', async () => {
  const s = await scenario();
  const ids = await seedRoster(s);
  await link(s, 'erin');
  await link(s, 'gina');
  const erinClaims = (await s.call('erin', 'POST', '/claims', claimBody('Eliora', 'Brindle'))).json.claims;
  const ginaClaims = (await s.call('gina', 'POST', '/claims', claimBody('Galdor'))).json.claims;
  assert.equal((await s.call('erin', 'GET', '/claims')).status, 403);
  assert.equal((await s.w.call({}, 'GET', `${s.guildPath}/claims`)).status, 401);
  const list = await s.call('bob', 'GET', '/claims');
  assert.equal(list.status, 200);
  assert.equal(list.json.claims.length, 3);
  const by = Object.fromEntries(list.json.claims.map((c) => [c.character.name, c]));
  assert.deepEqual(by.Eliora.plan, { kind: 'add_alt', reason: null, message: null, person: { id: ids.aldric, name: 'Aldric' }, defaultTeamId: s.A, canDecide: true });
  assert.equal(by.Brindle.plan.kind, 'blocked');
  assert.equal(by.Brindle.plan.reason, 'other_person');
  assert.equal(by.Brindle.plan.canDecide, false);
  assert.match(by.Brindle.plan.message, /Merge them by hand/);
  assert.deepEqual(by.Galdor.plan, { kind: 'new_person', reason: null, message: null, person: null, defaultTeamId: null, canDecide: true });
  assert.deepEqual([by.Eliora.character.realm, by.Eliora.character.class, by.Eliora.character.level], ['Dreamscythe', 'PALADIN', 61]);
  assert.equal(by.Eliora.claimant.displayName, 'Erin E');
  assert.equal(by.Eliora.claimant.avatarUrl, null, 'no Discord ID leaks through an avatar URL to someone who cannot see them');
  assert.equal(by.Eliora.id, erinClaims[0].id);
  assert.equal(by.Galdor.id, ginaClaims[0].id);
  assert(!JSON.stringify(list.json).includes(PEOPLE.erin.id), 'no Discord IDs');
  // A team lead sees them all, and can decide only where their team reaches.
  const carol = (await s.call('carol', 'GET', '/claims')).json.claims;
  assert.equal(carol.length, 3);
  assert.equal(carol.find((c) => c.character.name === 'Eliora').plan.canDecide, true, 'Aldric\'s home team is Alpha');
  const dave = (await s.call('dave', 'GET', '/claims')).json.claims;
  assert.equal(dave.find((c) => c.character.name === 'Eliora').plan.canDecide, false, 'Bravo\'s lead cannot add to an Alpha person');
  assert.equal(dave.find((c) => c.character.name === 'Galdor').plan.canDecide, true, 'a new person can go to a team they lead');
  // Another guild's officer sees nothing of this guild.
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const other = (await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', multipleTeams: false })).json;
  assert.equal((await s.w.call(frank, 'GET', `/api/guild/${other.guild.id}/claims`)).json.claims.length, 0);
  assert.equal((await s.w.call(frank, 'GET', `${s.guildPath}/claims`)).status, 403, 'not a member of this guild');
});

check('claims list: the plan covers linking an unlinked person, a claim already done, a taken character and a member who left', async () => {
  const s = await scenario();
  const ids = await seedRoster(s);
  await link(s, 'gina');
  await link(s, 'erin');
  assert.equal((await s.call('gina', 'POST', '/claims', claimBody('Brindle'))).status, 201);
  const plans = async () => Object.fromEntries((await s.call('bob', 'GET', '/claims')).json.claims.map((c) => [c.character.name, c.plan]));
  assert.deepEqual((await plans()).Brindle, { kind: 'link_person', reason: null, message: null, person: { id: ids.brindle, name: 'Brindle' }, defaultTeamId: null, canDecide: true });
  // A claim made, then the roster changes under it: the character lands on the claimant's own person by hand ("already").
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).status, 201);
  assert.equal((await s.call('bob', 'POST', `/roster/${ids.aldric}/characters`, { name: 'Eliora', class: 'PALADIN', mainSpec: 'Holy', offSpec: null, teamId: s.A, makeMain: false })).status, 201);
  assert.equal((await plans()).Eliora.kind, 'already');
  // Or onto someone else's linked person ("taken").
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Galdor'))).status, 201);
  assert.equal((await s.call('bob', 'POST', `/roster/${ids.dunmar}/characters`, { name: 'Galdor', class: 'WARLOCK', mainSpec: 'Destruction', offSpec: null, teamId: s.B, makeMain: false })).status, 201);
  assert.equal((await plans()).Galdor.reason, 'taken');
  // Gina leaves the Discord server.
  await signIn(s.w, PEOPLE.gina, [], s.jars.gina);
  assert.equal((await plans()).Brindle.reason, 'not_member');
});

// ---------------------------------------------------------------------------
// Claims: approve and reject

check('approve: an Alt joins the claimant\'s person on the team the officer picks, in one write, and the claim is closed', async () => {
  const s = await scenario();
  const ids = await seedRoster(s);
  await link(s, 'erin');
  const claim = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0];
  const res = await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('add_alt', { teamId: s.B }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.claim, res.json.outcome, res.json.personId], [{ id: claim.id, status: 'approved' }, 'add_alt', ids.aldric]);
  assert.deepEqual(res.json.rosterFlags && typeof res.json.rosterFlags, 'object');
  const [character] = await s.w.rows("SELECT player_id, team_id, name, realm, realm_key, class, main_spec, is_main FROM characters WHERE name = 'Eliora'");
  assert.deepEqual(character, { player_id: ids.aldric, team_id: s.B, name: 'Eliora', realm: 'Dreamscythe', realm_key: 'dreamscythe', class: 'PALADIN', main_spec: null, is_main: 0 });
  const [row] = await s.w.rows('SELECT status, team_id, decided_by, decided_at FROM character_claims');
  assert.deepEqual(row, { status: 'approved', team_id: s.B, decided_by: s.ids.bob, decided_at: s.w.clock.now });
  assert.deepEqual((await s.call('bob', 'GET', '/claims')).json.claims, []);
  await assertOneMain(s.w);
  const audit = await s.w.rows("SELECT guild_id, actor_user_id, entity_type, entity_id, after FROM audit_log WHERE action = 'claim.approve'");
  assert.deepEqual(audit.map((a) => [a.guild_id, a.actor_user_id, a.entity_type, a.entity_id, JSON.parse(a.after)]), [[s.guildId, s.ids.bob, 'claim', claim.id, { outcome: 'add_alt', teamId: s.B, personId: ids.aldric }]]);
  const view = (await s.w.call(s.jars.erin, 'GET', '/auth/bnet')).json.guilds[0].characters.find((c) => c.name === 'Eliora');
  assert.deepEqual([view.state, view.claim.status, view.claimable], ['yours', 'approved', false]);
});

check('approve: a claimant with no person becomes a new person (status picked, trial by default) with the character as Main, linked by Discord', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'gina');
  const claims = (await s.call('gina', 'POST', '/claims', claimBody('Galdor', 'Quillfeather'))).json.claims;
  const first = await s.call('bob', 'POST', `/claims/${claims[0].id}/approve`, approveBody('new_person', { teamId: s.A }));
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const [person] = await s.w.rows('SELECT id, status, discord_user_id, joined_on, trial_start, trial_end, created_by, version FROM players WHERE discord_user_id = ?', PEOPLE.gina.id);
  assert.deepEqual([person.status, person.joined_on === person.trial_start, person.trial_end, person.created_by, person.version], ['trial', true, null, s.ids.bob, 1]);
  assert.equal(first.json.personId, person.id);
  const [main] = await s.w.rows('SELECT name, team_id, is_main, class FROM characters WHERE player_id = ?', person.id);
  assert.deepEqual(main, { name: 'Galdor', team_id: s.A, is_main: 1, class: 'WARLOCK' });
  // The claimant now has a person: the next claim is an Alt, and a status is not needed.
  const second = await s.call('bob', 'GET', '/claims');
  assert.equal(second.json.claims[0].plan.kind, 'add_alt');
  assert.equal(second.json.claims[0].plan.defaultTeamId, s.A);
  assert.equal((await s.call('bob', 'POST', `/claims/${claims[1].id}/approve`, approveBody('new_person', { teamId: s.A }))).json.error, 'claim_changed');
  assert.equal((await s.call('bob', 'POST', `/claims/${claims[1].id}/approve`, approveBody('add_alt', { teamId: s.B }))).status, 200);
  assert.equal(await s.w.count('characters', 'player_id = ?', person.id), 2);
  await assertOneMain(s.w);
  // Another claimant, another status.
  await link(s, 'erin');
  const erin = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0];
  const own = await s.call('bob', 'POST', `/claims/${erin.id}/approve`, approveBody('add_alt', { teamId: s.A }));
  assert.equal(own.status, 200);
});

check('approve: new_person takes the status the officer picked and refuses a bad one', async () => {
  const s = await scenario();
  await link(s, 'gina');
  const claim = (await s.call('gina', 'POST', '/claims', claimBody('Galdor'))).json.claims[0];
  for (const bad of ['inactive', 'boss', 5, null]) {
    const res = await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('new_person', { teamId: s.A, status: bad }));
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal((await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('new_person', { teamId: s.A, status: 'raider' }))).status, 200);
  const [person] = await s.w.rows('SELECT status, trial_start FROM players');
  assert.deepEqual(person, { status: 'raider', trial_start: null });
});

check('approve: an unlinked person on the roster is linked to the claimant, no character is added', async () => {
  const s = await scenario();
  const ids = await seedRoster(s);
  await link(s, 'gina');
  const claim = (await s.call('gina', 'POST', '/claims', claimBody('Brindle'))).json.claims[0];
  const before = await s.w.count('characters');
  const res = await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('link_person'));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.outcome, res.json.personId], ['link_person', ids.brindle]);
  const [person] = await s.w.rows('SELECT discord_user_id, version FROM players WHERE id = ?', ids.brindle);
  assert.deepEqual(person, { discord_user_id: PEOPLE.gina.id, version: 2 });
  assert.equal(await s.w.count('characters'), before);
  assert.equal((await s.w.call(s.jars.gina, 'GET', '/auth/bnet')).json.guilds[0].characters.find((c) => c.name === 'Brindle').state, 'yours');
  // Gina is now the Member of that person: she sees the attendance of Brindle's team, and the roster reports the link.
  const record = await s.call('bob', 'GET', `/roster/${ids.brindle}`);
  assert.equal(record.json.person.discord.signIn, 'signed_in');
});

check('approve: "already" only closes the claim, and a blocked claim cannot be approved (reject it)', async () => {
  const s = await scenario();
  const ids = await seedRoster(s);
  await link(s, 'erin');
  const done = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0];
  await s.call('bob', 'POST', `/roster/${ids.aldric}/characters`, { name: 'Eliora', class: 'PALADIN', mainSpec: 'Holy', offSpec: null, teamId: s.A, makeMain: false });
  const characters = await s.w.count('characters');
  const ok = await s.call('bob', 'POST', `/claims/${done.id}/approve`, approveBody('already'));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'already');
  assert.equal(await s.w.count('characters'), characters);
  const blocked = (await s.call('erin', 'POST', '/claims', claimBody('Brindle'))).json.claims[0];
  const res = await s.call('bob', 'POST', `/claims/${blocked.id}/approve`, approveBody('blocked'));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'claim_blocked');
  assert.match(res.json.message, /nobody has linked/);
  assert.equal((await s.call('bob', 'POST', `/claims/${blocked.id}/reject`, {})).status, 200);
  assert.equal((await s.call('bob', 'GET', '/claims')).json.claims.length, 0);
});

check('approve: permissions follow roster.edit by team, a lost race is a 409, and the page must say what it saw', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  await link(s, 'gina');
  const eliora = (await s.call('erin', 'POST', '/claims', claimBody('Eliora', 'Cassia'))).json.claims;
  const galdor = (await s.call('gina', 'POST', '/claims', claimBody('Galdor'))).json.claims[0];
  const approve = (who, id, body) => s.call(who, 'POST', `/claims/${id}/approve`, body);
  assert.equal((await approve('erin', eliora[0].id, approveBody('add_alt', { teamId: s.A }))).status, 403, 'a member cannot approve');
  assert.equal((await approve('dave', eliora[0].id, approveBody('add_alt', { teamId: s.B }))).status, 403, 'Aldric\'s home team is Alpha');
  assert.equal((await approve('carol', eliora[0].id, approveBody('add_alt', { teamId: s.B }))).status, 403, 'and Carol does not reach Bravo');
  assert.equal((await approve('carol', galdor.id, approveBody('new_person', { teamId: s.B }))).status, 403);
  assert.equal((await approve('bob', eliora[0].id, {})).status, 400, 'no expectedKind');
  assert.equal((await approve('bob', eliora[0].id, approveBody('add_alt'))).status, 400, 'no team');
  assert.equal((await approve('bob', eliora[0].id, approveBody('add_alt', { teamId: 'nope' }))).status, 400);
  assert.equal((await approve('bob', eliora[0].id, approveBody('link_person', { teamId: s.A }))).json.error, 'claim_changed');
  assert.equal((await approve('carol', eliora[0].id, approveBody('add_alt', { teamId: s.A }))).status, 200, 'Carol leads Alpha');
  assert.equal((await approve('carol', eliora[0].id, approveBody('add_alt', { teamId: s.A }))).json.error, 'claim_decided');
  assert.equal((await approve('dave', galdor.id, approveBody('new_person', { teamId: s.B }))).status, 200, 'Dave can place a new person on Bravo');
  // archived team
  assert.equal((await s.w.call(s.jars.alice, 'PATCH', `${s.guildPath}/teams/${s.B}`, { archived: true })).status, 200);
  assert.equal((await approve('bob', eliora[1].id, approveBody('add_alt', { teamId: s.B }))).status, 400, 'an archived team takes no one');
  assert.equal((await approve('bob', 'cl_nope', approveBody('add_alt', { teamId: s.A }))).status, 404);
  assert.equal((await approve('bob', `cl_${'x'.repeat(22)}`, approveBody('add_alt', { teamId: s.A }))).status, 404);
  assert.equal((await approve('bob', eliora[1].id, approveBody('add_alt', { teamId: s.A }))).status, 200);
  await assertOneMain(s.w);
});

check('approve: a name taken in the meantime, a claimant who left and another guild\'s claim are refused and change nothing', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  const claim = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0];
  // The same character is added by hand (to a person Erin does not own) between the list and the click.
  assert.equal((await s.call('bob', 'POST', '/roster', mainBody(s.A, 'Eliora', { class: 'PALADIN', mainSpec: 'Holy' }))).status, 201);
  const res = await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('add_alt', { teamId: s.A }));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'claim_changed', 'the plan now says the roster holds it on an unlinked person next to the claimant\'s own');
  assert.equal(await s.w.count('character_claims', "status = 'pending'"), 1);
  // Erin leaves the server
  await signIn(s.w, PEOPLE.erin, [], s.jars.erin);
  const left = await s.call('bob', 'POST', `/claims/${claim.id}/approve`, approveBody('blocked'));
  assert.equal(left.json.error, 'claim_blocked');
  assert.match(left.json.message, /no longer in the guild/);
  // Another guild cannot decide this guild's claims
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const other = (await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', multipleTeams: false })).json;
  assert.equal((await s.w.call(frank, 'POST', `/api/guild/${other.guild.id}/claims/${claim.id}/approve`, approveBody('add_alt', { teamId: other.teams[0].id }))).status, 404);
  assert.equal((await s.w.call(frank, 'POST', `/api/guild/${other.guild.id}/claims/${claim.id}/reject`, {})).status, 404);
  await assertOneMain(s.w);
});

check('reject: officers and team leads reject, members cannot, a decided claim stays decided, and nothing is written to the roster', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  const [a, b] = (await s.call('erin', 'POST', '/claims', claimBody('Eliora', 'Cassia'))).json.claims;
  const players = await s.w.count('players');
  const characters = await s.w.count('characters');
  assert.equal((await s.call('erin', 'POST', `/claims/${a.id}/reject`, {})).status, 403);
  assert.equal((await s.call('gina', 'POST', `/claims/${a.id}/reject`, {})).status, 403);
  const res = await s.call('dave', 'POST', `/claims/${a.id}/reject`, {});
  assert.deepEqual(res.json, { claim: { id: a.id, status: 'rejected' } });
  assert.equal((await s.call('bob', 'POST', `/claims/${a.id}/reject`, {})).json.error, 'claim_decided');
  assert.equal((await s.call('bob', 'POST', `/claims/${a.id}/approve`, approveBody('add_alt', { teamId: s.A }))).json.error, 'claim_decided');
  const [row] = await s.w.rows('SELECT status, team_id, decided_by, decided_at FROM character_claims WHERE id = ?', a.id);
  assert.deepEqual(row, { status: 'rejected', team_id: null, decided_by: s.ids.dave, decided_at: s.w.clock.now });
  assert.equal(await s.w.count('players'), players);
  assert.equal(await s.w.count('characters'), characters);
  assert.equal((await s.call('bob', 'POST', `/claims/${b.id}/reject`, null, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal(await s.w.count('audit_log', "action = 'claim.reject'"), 1);
});

check('audit: every Battle.net action is written once and no row holds a BattleTag, account id, character name or Discord ID', async () => {
  const s = await scenario();
  await seedRoster(s);
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  await link(s, 'erin');
  await link(s, 'gina');
  const claims = (await s.call('erin', 'POST', '/claims', claimBody('Eliora', 'Cassia', 'Galdor'))).json.claims;
  const ginaClaim = (await s.call('gina', 'POST', '/claims', claimBody('Brindle'))).json.claims[0];
  await s.call('erin', 'DELETE', `/claims/${claims[2].id}`);
  await s.call('bob', 'POST', `/claims/${claims[0].id}/approve`, approveBody('add_alt', { teamId: s.A }));
  await s.call('bob', 'POST', `/claims/${claims[1].id}/reject`, {});
  await s.call('bob', 'POST', `/claims/${ginaClaim.id}/approve`, approveBody('link_person'));
  assert.equal((await s.call('alice', 'PUT', '/bnet', { guildName: 'Ember Company', rankLabels: ['GM'] })).status, 200);
  await s.w.call(s.jars.gina, 'DELETE', '/auth/bnet');
  const written = (await s.w.rows("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'bnet.%' OR action LIKE 'claim.%'")).map((r) => r.action).sort();
  const expected = AUDIT_ACTIONS.filter((a) => /^(bnet|claim)\./.test(a)).sort();
  assert.deepEqual(expected, ['bnet.link', 'bnet.settings', 'bnet.unlink', 'claim.approve', 'claim.create', 'claim.reject', 'claim.withdraw']);
  assert.deepEqual(written, expected);
  const dump = (await s.w.rows('SELECT action, before, after FROM audit_log')).map((r) => `${r.before} ${r.after}`).join('\n');
  for (const secret of [TAG('erin'), TAG('gina'), ACCOUNT.erin, ACCOUNT.gina, 'Eliora', 'Cassia', 'Galdor', 'Brindle', 'Aldric', 'Ember Company', 'GM', PEOPLE.erin.id, PEOPLE.gina.id]) {
    assert.equal(dump.includes(secret), false, `audit rows must not contain ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// Guild settings

check('settings: officers read and write the Battle.net settings, team leads can read, members cannot; rank labels default to Guild Master and Rank N', async () => {
  const s = await scenario();
  const get = (who) => s.call(who, 'GET', '/bnet');
  assert.equal((await get('erin')).status, 403);
  assert.equal((await s.w.call({}, 'GET', `${s.guildPath}/bnet`)).status, 401);
  const initial = await get('bob');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json, {
    configured: true, supported: true, supportLabel: 'TBC Anniversary', message: null, realmKind: 'realm', guildName: null, effectiveGuildName: 'Ember',
    realmSlug: 'dreamscythe', realmNeeded: false, rankLabels: Array(10).fill(''),
    rankDefaults: ['Guild Master', 'Rank 1', 'Rank 2', 'Rank 3', 'Rank 4', 'Rank 5', 'Rank 6', 'Rank 7', 'Rank 8', 'Rank 9'], canEdit: true,
  });
  assert.equal((await get('carol')).json.canEdit, false);
  const labels = ['Guild Master', 'Officer', '', 'Raider', ' Trial ', '', '', '', '', ''];
  assert.equal((await s.call('carol', 'PUT', '/bnet', { rankLabels: labels })).status, 403);
  assert.equal((await s.call('erin', 'PUT', '/bnet', { rankLabels: labels })).status, 403);
  const put = await s.call('bob', 'PUT', '/bnet', { guildName: '  Ember   Company ', rankLabels: labels });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.guildName, 'Ember Company');
  assert.deepEqual(put.json.rankLabels, ['Guild Master', 'Officer', '', 'Raider', 'Trial', '', '', '', '', '']);
  assert.equal(put.json.effectiveGuildName, 'Ember Company');
  const [row] = await s.w.rows('SELECT bnet_guild_name, bnet_realm_slug, bnet_rank_labels FROM guilds');
  assert.deepEqual(row, { bnet_guild_name: 'Ember Company', bnet_realm_slug: null, bnet_rank_labels: JSON.stringify(['Guild Master', 'Officer', '', 'Raider', 'Trial', '', '', '', '', '']) });
  assert.deepEqual((await get('bob')).json.rankLabels, ['Guild Master', 'Officer', '', 'Raider', 'Trial', '', '', '', '', '']);
  const cleared = await s.call('bob', 'PUT', '/bnet', { guildName: '', rankLabels: [] });
  assert.equal(cleared.json.guildName, null);
  assert.deepEqual(cleared.json.rankLabels, Array(10).fill(''));
});

check('settings: bad values are 400 with the field; a realm guild reads its own realm, a ruleset guild keeps the realm an officer entered', async () => {
  const s = await scenario();
  const put = (body) => s.call('bob', 'PUT', '/bnet', body);
  for (const [body, field] of [
    [{ guildName: 5 }, 'guildName'], [{ guildName: 'x'.repeat(33) }, 'guildName'], [{ guildName: '!!!' }, 'guildName'],
    [{ realmSlug: 'old-blanchy' }, 'realmSlug'], [{ rankLabels: 'x' }, 'rankLabels'], [{ rankLabels: Array(11).fill('') }, 'rankLabels'],
    [{ rankLabels: [5] }, 'rankLabels'], [{ rankLabels: ['x'.repeat(25)] }, 'rankLabels'],
  ]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.field, field);
  }
  assert.equal((await put({ guildName: 'Ember\u0007' })).json.guildName, 'Ember', 'control characters are stripped');
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const forever = (await s.w.call(frank, 'POST', '/api/guild', { serverId: SERVER_B, gameVersion: 'forever', region: 'US', realm: 'Normal', name: 'Fresh', timeZone: 'UTC', multipleTeams: false })).json;
  const path = `/api/guild/${forever.guild.id}/bnet`;
  const first = await s.w.call(frank, 'GET', path);
  assert.deepEqual([first.json.supported, first.json.message, first.json.realmKind, first.json.realmNeeded, first.json.realmSlug], [false, 'Battle.net doesn\'t offer character data for WoW Forever yet.', 'ruleset', true, null]);
  for (const bad of ['!!!', 5, 'Хроми', {}]) assert.equal((await s.w.call(frank, 'PUT', path, { realmSlug: bad })).status, 400, String(bad));
  const saved = await s.w.call(frank, 'PUT', path, { realmSlug: "Old Blanchy" });
  assert.equal(saved.json.realmSlug, 'old-blanchy', 'a typed name becomes the slug');
  assert.equal(saved.json.realmNeeded, false);
  assert.equal((await s.w.call(frank, 'PUT', path, { realmSlug: 'shimmering-flats' })).json.realmSlug, 'shimmering-flats');
});

// ---------------------------------------------------------------------------
// Roster import

const RH = (s, who, route, body, extra) => s.call(who, 'POST', `/roster/import/bnet/${route}`, body, extra);

check('roster preview: rows with rank, level, class and roster status; ranks counted with their labels; the Death Knight and a non-slug realm are dropped', async () => {
  const s = await scenario();
  await seedRoster(s);
  await addPerson(s, 'bob', s.A, 'Thornwick');
  assert.equal((await s.call('bob', 'PUT', '/bnet', { rankLabels: ['Guild Master', 'Officer'] })).status, 200);
  const res = await RH(s, 'bob', 'preview', { teamId: s.A });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.guild, { name: 'Ember', realm: 'Dreamscythe' });
  assert.equal(res.json.fetchedAt, s.w.clock.now);
  assert.equal(res.json.rows.length, 15);
  assert.deepEqual(res.json.ranks, [
    { rank: 0, label: 'Guild Master', count: 1 }, { rank: 1, label: 'Officer', count: 2 }, { rank: 2, label: 'Rank 2', count: 3 },
    { rank: 3, label: 'Rank 3', count: 4 }, { rank: 4, label: 'Rank 4', count: 5 },
  ]);
  const by = Object.fromEntries(res.json.rows.map((row) => [row.name, row]));
  assert.deepEqual(by.Thornwick, {
    key: 'thornwick|dreamscythe', name: 'Thornwick', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'WARRIOR', level: 70, rank: 0, status: 'on_roster',
    person: { id: by.Thornwick.person.id, name: 'Thornwick' },
  });
  assert.equal(by.Pyrelo.status, 'new');
  assert.equal(by.Pyrelo.person, null);
  assert.equal(by.Wayfarer.status, 'other_realm');
  assert.equal(by.Wayfarer.realm, 'Faraway Isle');
  assert.equal(by.Gravewalk, undefined);
  assert.deepEqual(res.json.rows.slice(0, 3).map((row) => row.name), ['Thornwick', 'Mendra', 'Pyrelo'], 'rank, then level, then name');
  assert.equal(await s.w.count('players'), 4, 'a preview stores nothing');
  // The call: a client-credentials token, then the roster with the right path and the profile namespace.
  assert.deepEqual(s.w.asked(null, '/data').map((r) => `${r.path} ${r.namespace} ${r.token}`), ['/data/wow/guild/dreamscythe/ember/roster profile-classicann-us client']);
  assert.deepEqual(s.w.asked('basic').map((r) => r.path), ['/token']);
});

check('roster preview: the guild name and the ruleset realm come from the saved settings; the token is reused; a stale token is replaced once', async () => {
  const s = await scenario();
  assert.equal((await s.call('bob', 'PUT', '/bnet', { guildName: "Ember's Company!" })).status, 200);
  assert.equal((await RH(s, 'bob', 'preview', { teamId: s.A })).status, 200);
  assert.equal((await RH(s, 'bob', 'preview', { teamId: s.A })).status, 200);
  assert.deepEqual(s.w.asked(null, '/data').map((r) => r.path), Array(2).fill('/data/wow/guild/dreamscythe/embers-company/roster'));
  assert.equal(s.w.asked('basic').length, 1, 'one client-credentials token for both');
  s.w.bnet.state.tokens.clear();
  assert.equal((await RH(s, 'bob', 'preview', { teamId: s.A })).status, 200, 'a 401 fetches a new token and tries once more');
  assert.equal(s.w.asked('basic').length, 2);
  s.w.advance(25 * 60 * 60 * 1000);
  s.w.bnet.state.requests.length = 0;
  assert.equal((await RH(s, 'carol', 'preview', { teamId: s.A })).status, 200);
  assert.equal(s.w.asked('basic').length, 1, 'an expired token is replaced');
});

check('roster preview: not configured, unsupported version and a missing ruleset realm are clear 503 / 409 answers that never call Blizzard', async () => {
  const s = await scenario();
  s.w.env.BNET_CLIENT_ID = '';
  const off = await RH(s, 'bob', 'preview', { teamId: s.A });
  assert.deepEqual([off.status, off.json.error, off.json.message], [503, 'bnet_not_configured', 'Battle.net isn\'t set up on this server.']);
  s.w.env.BNET_CLIENT_ID = 'bnet-id';
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const forever = (await s.w.call(frank, 'POST', '/api/guild', { serverId: SERVER_B, gameVersion: 'forever', region: 'US', realm: 'Normal', name: 'Fresh', timeZone: 'UTC', multipleTeams: false })).json;
  const base = `/api/guild/${forever.guild.id}/roster/import/bnet`;
  const unsupported = await s.w.call(frank, 'POST', `${base}/preview`, { teamId: forever.teams[0].id });
  assert.deepEqual([unsupported.status, unsupported.json.error, unsupported.json.message], [409, 'bnet_unsupported', 'Battle.net doesn\'t offer character data for WoW Forever yet.']);
  assert.deepEqual(s.w.asked(), []);
  // Even with a namespace in the table, a ruleset guild needs its realm. Edit the table the way the next developer would.
  const battlenet = await load('worker/battlenet.js');
  battlenet.NAMESPACES.forever.profile = 'profile-classic1x';
  try {
    const missing = await s.w.call(frank, 'POST', `${base}/preview`, { teamId: forever.teams[0].id });
    assert.deepEqual([missing.status, missing.json.error], [409, 'bnet_realm_missing']);
    assert.equal((await s.w.call(frank, 'PUT', `/api/guild/${forever.guild.id}/bnet`, { realmSlug: 'old-blanchy' })).status, 200);
    const ok = await s.w.call(frank, 'POST', `${base}/preview`, { teamId: forever.teams[0].id });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(s.w.asked(null, '/data')[0].path, '/data/wow/guild/old-blanchy/fresh/roster');
    assert.equal(s.w.asked(null, '/data')[0].namespace, 'profile-classic1x-us');
  } finally {
    battlenet.NAMESPACES.forever.profile = null;
  }
});

check('roster preview: Blizzard answering 404, 403 (its Anniversary fault), an error or garbage is a plain message, not a 500', async () => {
  const s = await scenario();
  const run = async () => { s.w.advance(11 * 60 * 1000); return RH(s, 'bob', 'preview', { teamId: s.A }); };
  s.w.bnet.state.fail.roster = 404;
  const missing = await run();
  assert.deepEqual([missing.status, missing.json.error], [404, 'bnet_guild_not_found']);
  assert.match(missing.json.message, /Guild settings > Battle\.net/);
  s.w.bnet.state.fail.roster = 403;
  const refused = await run();
  assert.deepEqual([refused.status, refused.json.error], [502, 'bnet_guild_refused']);
  s.w.bnet.state.fail.roster = 500;
  assert.deepEqual([(await run()).status, (await run()).json.error], [502, 'bnet_unavailable']);
  s.w.bnet.state.fail.roster = 0;
  s.w.bnet.state.fail.token = 500;
  s.w.bnet.state.tokens.clear();
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  assert.equal((await run()).json.error, 'bnet_unavailable');
  s.w.bnet.state.fail.token = 0;
  assert.equal((await run()).status, 200, 'and it recovers');
  assert(s.w.logs.every((line) => !line.includes('bnet-secret') && !line.includes('fake-client-token')));
});

check('roster preview and commit: roster.edit by team; members, signed-out visitors and other teams are refused; a bad team or body is 400', async () => {
  const s = await scenario();
  assert.equal((await RH(s, 'erin', 'preview', { teamId: s.A })).status, 403);
  assert.equal((await s.w.call({}, 'POST', `${s.guildPath}/roster/import/bnet/preview`, { teamId: s.A })).status, 401);
  assert.equal((await RH(s, 'carol', 'preview', { teamId: s.B })).status, 403, 'Carol leads Alpha only');
  assert.equal((await RH(s, 'carol', 'preview', { teamId: s.A })).status, 200);
  assert.equal((await RH(s, 'dave', 'preview', { teamId: s.B })).status, 200);
  assert.equal((await RH(s, 'bob', 'preview', {})).status, 400);
  assert.equal((await RH(s, 'bob', 'preview', { teamId: 't_nope' })).status, 400);
  assert.equal((await RH(s, 'erin', 'commit', { teamId: s.A, members: [] })).status, 403);
  assert.equal((await RH(s, 'carol', 'commit', { teamId: s.B, members: [] })).status, 403);
  assert.equal((await RH(s, 'bob', 'preview', { teamId: s.A }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

check('roster commit: the selected members become people with their class as Main on the chosen team; class and rank come from Blizzard, never the browser', async () => {
  const s = await scenario();
  await addPerson(s, 'bob', s.A, 'Thornwick');
  const body = {
    teamId: s.B, defaultStatus: 'trial',
    // The browser also claims other things about Pyrelo; only the identity (name + realm) is read.
    members: [{ name: 'Pyrelo', realmSlug: 'dreamscythe', class: 'WARRIOR', rank: 0, level: 1 }, { name: 'mendra', realmSlug: 'dreamscythe' }, { name: 'Quillfeather', realmSlug: 'dreamscythe' }],
  };
  const res = await RH(s, 'bob', 'commit', body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual([res.json.people, res.json.characters], [3, 3]);
  const rows = await s.w.rows(`SELECT c.name, c.class, c.team_id, c.realm, c.realm_key, c.is_main, c.main_spec, p.status, p.discord_user_id, p.trial_start, p.created_by
    FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name != 'Thornwick' ORDER BY c.name`);
  assert.deepEqual(rows.map((r) => [r.name, r.class, r.team_id, r.realm, r.realm_key, r.is_main, r.main_spec, r.status, r.discord_user_id, r.created_by]), [
    ['Mendra', 'SHAMAN', s.B, 'Dreamscythe', 'dreamscythe', 1, null, 'trial', null, s.ids.bob],
    ['Pyrelo', 'MAGE', s.B, 'Dreamscythe', 'dreamscythe', 1, null, 'trial', null, s.ids.bob],
    ['Quillfeather', 'HUNTER', s.B, 'Dreamscythe', 'dreamscythe', 1, null, 'trial', null, s.ids.bob],
  ]);
  await assertOneMain(s.w);
  const audit = await s.w.rows("SELECT guild_id, action, entity_type, entity_id, after FROM audit_log WHERE action = 'roster.import'");
  assert.deepEqual(audit.map((a) => [a.entity_type, a.entity_id, JSON.parse(a.after)]), [['team', s.B, { source: 'bnet', ref: 'guild', people: 3, characters: 3 }]]);
  assert(!audit[0].after.includes('Pyrelo'));
  // A second commit of someone already added is a 409 naming the row; other statuses work too.
  const again = await RH(s, 'bob', 'commit', { teamId: s.A, defaultStatus: 'raider', members: [{ name: 'Lastcall', realmSlug: 'dreamscythe' }, { name: 'Pyrelo', realmSlug: 'dreamscythe' }] });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'name_taken');
  assert.equal(again.json.index, 1);
  assert.equal(await s.w.count('characters', "name = 'Lastcall'"), 0, 'nothing from a refused commit is written');
  const ok = await RH(s, 'bob', 'commit', { teamId: s.A, defaultStatus: 'raider', members: [{ name: 'Lastcall', realmSlug: 'dreamscythe' }] });
  assert.equal(ok.status, 201);
  assert.equal((await s.w.rows("SELECT p.status FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Lastcall'"))[0].status, 'raider');
  await assertOneMain(s.w);
});

check('roster commit: bad input, a member Blizzard no longer lists, another realm and a list over 250 are refused whole', async () => {
  const s = await scenario();
  const commit = (members, extra = {}) => RH(s, 'bob', 'commit', { teamId: s.A, defaultStatus: 'trial', members, ...extra });
  const m = (name, realmSlug = 'dreamscythe') => ({ name, realmSlug });
  assert.equal((await commit('x')).status, 400);
  assert.equal((await commit([5])).status, 400);
  assert.equal((await commit([{ name: 'Pyrelo' }])).status, 400);
  assert.equal((await commit([m('Pyrelo'), m('pyrelo')])).status, 400, 'twice');
  assert.equal((await commit(Array.from({ length: 251 }, (_, i) => m(`Zq${i}`)))).status, 400);
  assert.equal((await commit([m('Pyrelo')], { defaultStatus: 'inactive' })).status, 400);
  assert.equal((await commit([m('Pyrelo')], { teamId: undefined })).status, 400);
  const gone = await commit([m('Pyrelo'), m('Nobodyhere')]);
  assert.deepEqual([gone.status, gone.json.error, gone.json.index], [409, 'roster_changed', 1]);
  const other = await commit([m('Wayfarer', 'faraway-isle')]);
  assert.deepEqual([other.status, other.json.field], [400, 'members']);
  assert.equal(other.json.message, 'That character is on a different realm than this guild.');
  assert.equal((await commit([m('Gravewalk')])).json.error, 'roster_changed', 'a class Raidsmith does not know was never listed');
  assert.equal(await s.w.count('players'), 0);
  assert.equal((await commit([])).status, 200, 'an empty selection is a no-op');
  assert.equal(await s.w.count('audit_log', "action = 'roster.import'"), 0);
});

check('roster commit: the person and character limits turn into their usual 409s', async () => {
  const s = await scenario();
  for (let i = 0; i < 999; i++) {
    s.w.db.sqlite.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_${String(i).padStart(22, '0')}', '${s.guildId}', 'raider', 1, 1)`);
  }
  const res = await RH(s, 'bob', 'commit', { teamId: s.A, defaultStatus: 'trial', members: [{ name: 'Pyrelo', realmSlug: 'dreamscythe' }, { name: 'Mendra', realmSlug: 'dreamscythe' }] });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'person_limit');
  assert.equal(await s.w.count('characters'), 0);
});

check('roster import: previews and commits share the import rate limit of 10 per window', async () => {
  const s = await scenario();
  for (let i = 0; i < 10; i++) assert.equal((await RH(s, 'bob', 'preview', { teamId: s.A })).status, 200, `preview ${i}`);
  const limited = await RH(s, 'bob', 'preview', { teamId: s.A });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert.equal((await RH(s, 'bob', 'commit', { teamId: s.A, members: [] })).status, 429);
  assert.equal((await RH(s, 'carol', 'preview', { teamId: s.A })).status, 200, 'another officer is unaffected');
});

// ---------------------------------------------------------------------------
// The 30-day rule, Delete my data

// Phase 7a: the 30-day rule clears the character SNAPSHOT; the link (Battle.net account number and BattleTag) is the account's sign-in identity and stays.
check('30-day purge: snapshots older than 30 days are cleared, fresh ones stay, the links stay; undecided and decided claims age out; roster records an approved claim made stay', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  await link(s, 'gina');
  await link(s, 'dave');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).status, 201);
  const g = (await s.call('gina', 'POST', '/claims', claimBody('Galdor', 'Quillfeather'))).json.claims;
  await s.call('bob', 'POST', `/claims/${g[0].id}/approve`, approveBody('new_person', { teamId: s.A }));
  await s.call('bob', 'POST', `/claims/${g[1].id}/reject`, {});
  const { purgeExpiredBnetData, runScheduled } = await load('worker/bnet-purge.js');
  // Dave's link is refreshed later than the others.
  s.w.advance(10 * DAY);
  await link(s, 'dave');
  const at = s.w.clock.now;
  // 29 days 23 h after the first links: nothing is due yet.
  s.w.advance(20 * DAY - 60 * 60 * 1000);
  assert.deepEqual(await purgeExpiredBnetData(s.w.db, s.w.clock.now), { snapshots: 0, pendingClaims: 0, decidedClaims: 0 });
  // Exactly 30 days: erin's and gina's snapshots, and everything decided or waiting that long, are due; dave's is not.
  s.w.advance(60 * 60 * 1000);
  const logged = [];
  const result = await runScheduled({ db: s.w.db, now: () => s.w.clock.now, log: (m) => logged.push(m) });
  assert.deepEqual(result, { snapshots: 2, pendingClaims: 1, decidedClaims: 2 });
  assert.deepEqual(logged, ['bnet purge: 2 snapshots, 3 claims']);
  const kept = async () => (await s.w.rows("SELECT user_id, battletag, snapshot != '{}' AS has_snapshot FROM bnet_links ORDER BY user_id")).map((r) => [r.user_id, r.battletag, r.has_snapshot]);
  const expectedLinks = (daveHas) => [[s.ids.dave, TAG('dave'), daveHas], [s.ids.erin, TAG('erin'), 0], [s.ids.gina, TAG('gina'), 0]].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(await kept(), expectedLinks(1), 'all three links (the sign-in identities) stay; only erin\'s and gina\'s snapshots are cleared');
  assert.equal(await s.w.count('character_claims'), 0);
  // What the approved claim made is the guild's own record and stays.
  assert.equal(await s.w.count('characters', "name = 'Galdor'"), 1);
  assert.equal(await s.w.count('players', 'discord_user_id = ?', PEOPLE.gina.id), 1);
  assert.equal(await s.w.count('players'), 4);
  await assertOneMain(s.w);
  // Idempotent (a cleared snapshot is not counted again), and dave's goes 30 days after his refresh.
  assert.deepEqual(await purgeExpiredBnetData(s.w.db, s.w.clock.now), { snapshots: 0, pendingClaims: 0, decidedClaims: 0 });
  assert.deepEqual(await purgeExpiredBnetData(s.w.db, at + 30 * DAY), { snapshots: 1, pendingClaims: 0, decidedClaims: 0 });
  assert.deepEqual(await kept(), expectedLinks(0));
  assert.equal(await s.w.count('bnet_links'), 3, 'no link is ever deleted by the purge');
});

check('30-day purge: the Worker\'s scheduled handler runs it through waitUntil and a failure is logged, never thrown', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const { default: worker } = await load('worker/index.js');
  assert.equal(typeof worker.scheduled, 'function');
  s.w.advance(31 * DAY);
  const waited = [];
  const realNow = Date.now;
  Date.now = () => s.w.clock.now;
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    worker.scheduled({ cron: '17 4 * * *' }, { DB: s.w.db }, { waitUntil: (promise) => waited.push(promise) });
    await Promise.all(waited);
  } finally {
    Date.now = realNow;
    console.log = realLog;
  }
  assert.equal(waited.length, 1);
  assert.equal(await s.w.count('bnet_links'), 1, 'the link stays');
  assert.equal(await s.w.count('bnet_links', "snapshot = '{}'"), 1, 'its snapshot is cleared');
  assert.deepEqual(lines, ['bnet purge: 1 snapshots, 0 claims']);
  const { runScheduled } = await load('worker/bnet-purge.js');
  const broken = { batch: async () => { throw new Error('D1 is down'); }, prepare: () => ({ bind: () => ({}) }) };
  const logged = [];
  assert.equal(await runScheduled({ db: broken, now: () => 1, log: (m) => logged.push(m) }), null);
  assert.deepEqual(logged, ['bnet purge failed: D1 is down']);
});

check('wrangler.jsonc: a daily cron trigger runs the purge (and a 15-minute one the Discord posts, worker/scheduler.js)', () => {
  const raw = read('wrangler.jsonc');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers, { crons: ['17 4 * * *', '*/15 * * * *'] });
  assert.match(read('tools/guild-dev.js'), /dev: \['dev', '--test-scheduled'\]/);
});

check('Delete my data: the link, the snapshot and the member\'s claims go with the account; the roster records stay with the guild', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'gina');
  const claims = (await s.call('gina', 'POST', '/claims', claimBody('Galdor', 'Quillfeather'))).json.claims;
  await s.call('bob', 'POST', `/claims/${claims[0].id}/approve`, approveBody('new_person', { teamId: s.A }));
  assert.equal(await s.w.count('bnet_links'), 1);
  assert.equal(await s.w.count('rate_limits', "key = ?", `bnet:${s.ids.gina}`), 1, 'starting the link left a rate-limit row');
  const del = await s.w.call(s.jars.gina, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(await s.w.count('bnet_links'), 0);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'bnet:%'"), 0, 'and the rate-limit row');
  assert.equal(await s.w.count('character_claims'), 0, 'pending and decided claims of the deleted member');
  assert.equal(await s.w.count('characters', "name = 'Galdor'"), 1, 'the character the claim created stays');
  assert.equal((await s.w.rows("SELECT discord_user_id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Galdor'"))[0].discord_user_id, null, 'unlinked');
  assert.deepEqual((await s.call('bob', 'GET', '/claims')).json.claims, []);
  // The officers' decisions on someone else's claim keep their audit row; the actor column goes NULL when an officer deletes their data.
  await link(s, 'erin');
  const claim = (await s.call('erin', 'POST', '/claims', claimBody('Eliora'))).json.claims[0];
  await s.call('bob', 'POST', `/claims/${claim.id}/reject`, {});
  assert.equal((await s.w.call(s.jars.bob, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.equal((await s.w.rows('SELECT decided_by FROM character_claims'))[0].decided_by, null);
});

// ---------------------------------------------------------------------------
// Routes and the fake itself

check('routes: Battle.net routes answer 405 with Allow for the wrong method, 401 signed out, 404 for a malformed claim id', async () => {
  const s = await scenario();
  const post = await s.w.call(s.jars.erin, 'POST', '/auth/bnet/login', {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET');
  const put = await s.w.call(s.jars.erin, 'PUT', '/auth/bnet', {});
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('Allow'), 'GET, DELETE');
  assert.equal((await s.w.call({}, 'GET', '/auth/bnet')).status, 401);
  assert.equal((await s.w.call({}, 'GET', `${s.guildPath}/bnet`)).status, 401);
  assert.equal((await s.call('bob', 'POST', '/claims/not-an-id/approve', {})).status, 404);
  assert.equal((await s.call('bob', 'GET', '/claims/cl_x')).status, 405);
  const wrapped = await s.call('bob', 'PUT', '/claims', {});
  assert.equal(wrapped.status, 405);
});

check('end to end through tools/fake-battlenet.js: the browser\'s hop to /authorize and back, then claim and approve', async () => {
  const s = await scenario();
  await seedRoster(s);
  const jar = s.jars.gina;
  s.w.bnet.state.account = { id: ACCOUNT.gina, battletag: TAG('gina') };
  const login = await s.w.req('GET', '/auth/bnet/login', { jar });
  const authorize = await fetch(login.headers.get('Location'), { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const back = new URL(authorize.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, `${ORIGIN}/auth/bnet/callback`);
  const callback = await s.w.req('GET', `${back.pathname}${back.search}`, { jar });
  assert.equal(callback.headers.get('Location'), '/#/characters');
  const mine = await s.w.call(jar, 'GET', '/auth/bnet');
  assert.equal(mine.json.link.battletag, TAG('gina'));
  assert.equal(mine.json.guilds[0].characters.length, 9);
  const claim = await s.w.call(jar, 'POST', `${s.guildPath}/claims`, claimBody('Galdor'));
  assert.equal(claim.status, 201);
  const approved = await s.call('bob', 'POST', `/claims/${claim.json.claims[0].id}/approve`, approveBody('new_person', { teamId: s.A, status: 'raider' }));
  assert.equal(approved.status, 200);
  // The user denies access on Battle.net's page.
  s.w.bnet.state.deny = true;
  const loginAgain = await s.w.req('GET', '/auth/bnet/login', { jar });
  const denied = await fetch(loginAgain.headers.get('Location'), { redirect: 'manual' });
  const deniedBack = new URL(denied.headers.get('location'));
  assert.equal(deniedBack.searchParams.get('error'), 'access_denied');
  const deniedCb = await s.w.req('GET', `${deniedBack.pathname}${deniedBack.search}`, { jar });
  assert.equal(deniedCb.headers.get('Location'), '/#/linked?error=denied');
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
      console.log(String(error && error.stack || error).split('\n').slice(0, 12).map((line) => `      ${line}`).join('\n'));
    } finally {
      await closeWorlds();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
