/**
 * Raidsmith guild tracker - Worker tests
 * Run: node guild-worker-tests.js
 *
 * Drives worker/index.js (ES modules, loaded with import()) over the node:sqlite D1 stand-in
 * (tests/d1-fake.js, which runs the real migration), with Discord faked by an injected fetch.
 * No network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';
const CSP = "default-src 'none'; frame-ancestors 'none'";
const ID = { user: /^u_[A-Za-z0-9_-]{22}$/, guild: /^g_[A-Za-z0-9_-]{22}$/, team: /^t_[A-Za-z0-9_-]{22}$/ };

const PEOPLE = {
  alice: { id: '1001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '1002', username: 'bob', globalName: null },
  carol: { id: '1003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '1004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '1005', username: 'erin', globalName: 'Erin E' },
  frank: { id: '1006', username: 'frank', globalName: 'Frank F' },
};

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function makeDiscord() {
  const state = { next: null, calls: [], revoked: [], failRevoke: false, failToken: false, tokens: new Map() };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    state.calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (u.pathname === '/api/oauth2/token') {
      if (state.failToken) return new Response('{}', { status: 400 });
      const token = `tok${state.calls.length}`;
      state.tokens.set(token, state.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') {
      if (state.failRevoke) throw new Error('network down');
      state.revoked.push(new URLSearchParams(init.body).get('token'));
      return Response.json({});
    }
    const bearer = /^Bearer (.+)$/.exec(init.headers && init.headers.Authorization || '');
    const session = bearer && state.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  return state;
}

function newJar() { return {}; }
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
  const db = createD1Fake();
  const discord = makeDiscord();
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const logs = [];
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
    ...env,
  };
  const app = createApp({ db, env: fullEnv, fetch: discord.fetch, now: () => clock.now, randomBytes, log: (m) => logs.push(m) });
  const world = {
    db, discord, clock, logs, env: fullEnv,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body, headers = {}, rawBody, origin = ORIGIN } = {}) {
      const init = { method, headers: { ...headers } };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
        init.body = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${origin}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      return response;
    },
    async call(jar, method, urlPath, body, extra = {}) {
      const response = await world.req(method, urlPath, { jar, body, ...extra });
      let json = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json, headers: response.headers, response };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) {
      return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
    },
  };
  return world;
}

async function signIn(world, person, servers = [], jar = newJar()) {
  world.discord.next = {
    user: { id: person.id, username: person.username, global_name: person.globalName, avatar: person.avatar || null },
    servers,
  };
  const login = await world.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return { jar, login, callback };
}

const manageable = (id, extra = {}) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8', ...extra });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

// Alice (allowlisted) creates the guild; Bob, Carol, Dave, Erin sign in as members.
async function scenario({ extraMembers = [] } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id] });
  const alice = (await signIn(w, PEOPLE.alice, [manageable(SERVER_A)])).jar;
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, alice, guildId: created.json.guild.id, teamId: created.json.teams[0].id, jars: { alice }, ids: {} };
  for (const name of ['bob', 'carol', 'dave', 'erin', ...extraMembers]) {
    s.jars[name] = (await signIn(w, PEOPLE[name], [plain(SERVER_A)])).jar;
  }
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.peoplePath = (name) => `${s.guildPath}/people/${s.ids[name]}`;
  s.setRoles = (name, body) => w.call(alice, 'PUT', `${s.peoplePath(name)}/roles`, body);
  return s;
}

function throwsD1(fn) {
  return Promise.resolve().then(fn).then(
    () => assert.fail('expected a D1_ERROR'),
    (error) => assert.match(error.message, /^D1_ERROR: /),
  );
}

// ---------------------------------------------------------------------------
// D1 fake parity (the SQL tests mean nothing if the stand-in is looser than D1)

check('d1 fake: rejects undefined, booleans, objects, BigInt and named parameters', async () => {
  const db = createD1Fake();
  for (const bad of [undefined, true, {}, 10n]) assert.throws(() => db.prepare('SELECT ?').bind(bad), /^Error: D1_ERROR/);
  assert.throws(() => db.prepare('SELECT :name'), /D1_ERROR/);
  assert.throws(() => db.prepare('SELECT @name'), /D1_ERROR/);
});

check('d1 fake: wrong number of bindings and more than 100 parameters are rejected', async () => {
  const db = createD1Fake();
  await throwsD1(() => db.prepare('SELECT ?, ?').bind(1).all());
  await throwsD1(() => db.prepare('SELECT 1').bind(1).all());
  const many = Array.from({ length: 101 }, (_, i) => i);
  assert.throws(() => db.prepare(`SELECT ${many.map(() => '?').join(',')}`).bind(...many), /D1_ERROR/);
  const ok = Array.from({ length: 100 }, (_, i) => i);
  assert.equal((await db.prepare(`SELECT ${ok.map(() => '?').join(',')}`).bind(...ok).all()).results.length, 1);
});

check('d1 fake: BEGIN, SAVEPOINT, ATTACH and PRAGMA are not allowed in prepared SQL', async () => {
  const db = createD1Fake();
  for (const sql of ['BEGIN', 'SAVEPOINT x', "ATTACH 'x' AS y", 'PRAGMA foreign_keys = OFF']) assert.throws(() => db.prepare(sql), /D1_ERROR/);
});

check('d1 fake: first() is null without a row, first(col) throws on an unknown column, results are plain objects', async () => {
  const db = createD1Fake();
  assert.equal(await db.prepare("SELECT * FROM users WHERE id = 'nope'").first(), null);
  const row = await db.prepare("SELECT id, name FROM roles WHERE id = 'officer'").first();
  assert.deepEqual(row, { id: 'officer', name: 'Officer' });
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(await db.prepare("SELECT id, name FROM roles WHERE id = 'officer'").first('name'), 'Officer');
  await throwsD1(() => db.prepare("SELECT id FROM roles WHERE id = 'officer'").first('nope'));
});

check('d1 fake: results carry success and meta.changes, RETURNING works, errors start with D1_ERROR', async () => {
  const db = createD1Fake();
  const insert = await db.prepare('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1) RETURNING id').bind('u_x', 'u_x', '1', 'x').run();
  assert.equal(insert.success, true);
  assert.equal(insert.meta.changes, 1);
  assert.deepEqual(insert.results, [{ id: 'u_x' }]);
  await throwsD1(() => db.prepare('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)').bind('u_y', 'u_y', '1', 'y').run());
});

check('d1 fake: batch rolls back everything on the first error; foreign keys are on', async () => {
  const db = createD1Fake();
  const user = (id, discord) => db.prepare('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)').bind(id, id, discord, id);
  await throwsD1(() => db.batch([user('u_a', '1'), user('u_b', '2'), user('u_c', '1')]));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 0);
  await throwsD1(() => db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', 'u_missing', 1, 2)").run());
  const results = await db.batch([user('u_a', '1'), user('u_b', '2')]);
  assert.equal(results.length, 2);
});

// ---------------------------------------------------------------------------
// Schema

check('schema: foreign key actions are exactly the designed ones', async () => {
  const db = createD1Fake();
  const fks = (table) => db.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map((fk) => `${fk.from}->${fk.table}(${fk.to}):${fk.on_delete}`).sort();
  assert.deepEqual(fks('sessions'), ['user_id->users(id):CASCADE']);
  assert.deepEqual(fks('user_servers'), ['user_id->users(id):CASCADE']);
  assert.deepEqual(fks('guilds'), ['created_by->users(id):SET NULL']);
  assert.deepEqual(fks('teams'), ['guild_id->guilds(id):CASCADE']);
  assert.deepEqual(fks('role_permissions'), ['role_id->roles(id):CASCADE']);
  assert.deepEqual(fks('role_assignments'), [
    'assigned_by->users(id):SET NULL', 'guild_id->guilds(id):CASCADE', 'guild_id->teams(guild_id):CASCADE',
    'role_id->roles(id):RESTRICT', 'team_id->teams(id):CASCADE', 'user_id->users(id):CASCADE',
  ].sort());
  assert.deepEqual(fks('guild_blocks'), ['blocked_by->users(id):SET NULL', 'guild_id->guilds(id):CASCADE', 'user_id->users(id):CASCADE']);
  assert.deepEqual(fks('audit_log'), ['actor_user_id->users(id):SET NULL', 'guild_id->guilds(id):CASCADE']);
});

check('schema: a team id from another guild cannot be assigned (composite FK) and Member is never stored', async () => {
  const s = await scenario();
  const second = await s.w.call(s.jars.alice, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B });
  assert.equal(second.status, 403, 'Alice never listed server B');
  const { db } = s.w;
  await throwsD1(() => db.prepare(
    "INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES ('ra_x', ?, ?, 'team_lead', 't_other', 1)",
  ).bind(s.guildId, s.ids.bob).run());
  await throwsD1(() => db.prepare(
    "INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES ('ra_y', ?, ?, 'nope', NULL, 1)",
  ).bind(s.guildId, s.ids.bob).run());
});

check('schema: one Guild Master per guild is enforced by the index', async () => {
  const s = await scenario();
  await throwsD1(() => s.w.db.prepare(
    "INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES ('ra_second', ?, ?, 'guild_master', NULL, 1)",
  ).bind(s.guildId, s.ids.bob).run());
  assert.equal(await s.w.count('role_assignments', "guild_id = ? AND role_id = 'guild_master'", s.guildId), 1);
});

check('ids: every id is random TEXT with a prefix, and Discord snowflakes stay strings', async () => {
  const ids = await load('worker/ids.js');
  const bytes = () => crypto.randomBytes(16);
  for (const [prefix, length] of [['u', 24], ['g', 24], ['t', 24], ['ra', 25], ['al', 25]]) {
    const id = ids.newId(prefix, bytes);
    assert.equal(id.length, length);
    assert(ids.isId(prefix, id));
  }
  assert(!ids.isId('u', 'g_AAAAAAAAAAAAAAAAAAAAAA'));
  assert(!ids.isId('u', 5));
  const s = await scenario();
  const row = await s.w.db.prepare('SELECT typeof(discord_id) AS t FROM users LIMIT 1').first();
  assert.equal(row.t, 'text');
  assert.equal((await s.w.db.prepare('SELECT typeof(id) AS t FROM guilds LIMIT 1').first()).t, 'text');
});

// ---------------------------------------------------------------------------
// Sign-in: state, redirects, sessions

check('login: redirects to the canonical origin first, then to Discord with prompt=none and a single-use state cookie', async () => {
  const w = await makeWorld();
  const wrongOrigin = await w.req('GET', '/auth/login', { origin: 'http://localhost:8787' });
  assert.equal(wrongOrigin.status, 302);
  assert.equal(wrongOrigin.headers.get('Location'), `${ORIGIN}/auth/login`);
  assert.equal(wrongOrigin.headers.getSetCookie().length, 0);

  const login = await w.req('GET', '/auth/login');
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(location.searchParams.get('scope'), 'identify guilds');
  assert.equal(location.searchParams.get('prompt'), 'none');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
  const cookie = login.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-rs_state=[A-Za-z0-9_-]{22}.[A-Za-z0-9_-]{43};/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert(cookie.includes(part), part);
  assert(!cookie.includes('Domain'), '__Host- cookies carry no Domain');
  assert.equal(cookie.split(';')[0].split('=')[1], location.searchParams.get('state'));
});

check('GET /guild redirects to the app shell at /#/ (fixed target, no query echoed, no cookies)', async () => {
  const w = await makeWorld();
  for (const target of ['/guild', '/guild/', '/guild?next=https://evil.example/']) {
    const response = await w.req('GET', target);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/#/');
    assert.equal(response.headers.getSetCookie().length, 0);
  }
  assert.equal((await w.req('POST', '/guild')).status, 405, 'GET only');
  assert.equal((await w.req('POST', '/guild/')).status, 405, 'GET only (trailing slash too)');
});

check('callback: a missing or mismatched state is rejected and the state cookie is cleared', async () => {
  const w = await makeWorld();
  w.discord.next = { user: { id: '1', username: 'x' }, servers: [] };
  for (const [jar, query] of [
    [newJar(), '?code=abc&state=abc'],
    [{ '__Host-rs_state': 'right' }, '?code=abc&state=wrong'],
    [{ '__Host-rs_state': 'right' }, '?code=abc'],
    [{}, '?code=abc'],
  ]) {
    const response = await w.req('GET', `/auth/callback${query}`, { jar });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/#/signin?error=state');
    assert(response.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_state=;') && c.includes('Max-Age=0') && c.includes('Path=/;')));
    assert(!response.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_session')));
  }
  assert.equal(w.discord.calls.length, 0, 'Discord is never called without a valid state');
  assert.equal(await w.count('sessions'), 0);
});

check('callback: the state cookie is single use; denied and Discord failures redirect with the right error', async () => {
  const w = await makeWorld();
  const jar = newJar();
  const login = await w.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const denied = await w.req('GET', `/auth/callback?error=access_denied&state=${state}`, { jar });
  assert.equal(denied.headers.get('Location'), '/#/signin?error=denied');
  assert(!jar['__Host-rs_state'], 'cookie cleared');
  const replay = await w.req('GET', `/auth/callback?code=abc&state=${state}`, { jar });
  assert.equal(replay.headers.get('Location'), '/#/signin?error=state');

  w.discord.failToken = true;
  const j2 = newJar();
  const l2 = await w.req('GET', '/auth/login', { jar: j2 });
  const s2 = new URL(l2.headers.get('Location')).searchParams.get('state');
  const failed = await w.req('GET', `/auth/callback?code=abc&state=${s2}`, { jar: j2 });
  assert.equal(failed.headers.get('Location'), '/#/signin?error=discord');
  assert.equal(await w.count('users'), 0);
});

check('callback: sets a hand-built 302 to /#/ with the __Host- session cookie; the database holds only a hash', async () => {
  const w = await makeWorld();
  const { callback, jar } = await signIn(w, PEOPLE.bob, []);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('Location'), '/#/');
  const cookie = callback.headers.getSetCookie().find((c) => c.startsWith('__Host-rs_session='));
  assert(cookie);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * 24 * 60 * 60}`]) assert(cookie.includes(part), part);
  assert(!/Domain=/i.test(cookie), '__Host- cookies carry no Domain');
  const token = jar['__Host-rs_session'];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const [row] = await w.rows('SELECT token_hash, expires_at, created_at FROM sessions');
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(row.token_hash, token);
  assert.equal(row.expires_at - row.created_at, 30 * 24 * 60 * 60 * 1000);
});

check('sessions: a 30-day fixed expiry, logout deletes the row, and signing in again replaces the earlier session', async () => {
  const w = await makeWorld();
  const { jar } = await signIn(w, PEOPLE.bob, []);
  const firstToken = jar['__Host-rs_session'];
  assert.equal((await w.call(jar, 'GET', '/auth/me')).status, 200);
  w.advance(30 * 24 * 60 * 60 * 1000 - 1000);
  assert.equal((await w.call(jar, 'GET', '/auth/me')).status, 200, 'expiry is fixed, not sliding');
  w.advance(2000);
  const expired = await w.call(jar, 'GET', '/auth/me');
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error, 'signed_out');

  const again = await signIn(w, PEOPLE.bob, [], { '__Host-rs_session': firstToken });
  assert.notEqual(again.jar['__Host-rs_session'], firstToken);
  assert.equal(await w.count('sessions', 'user_id = (SELECT id FROM users)'), 1, 'the earlier session row is gone');
  const out = await w.call(again.jar, 'POST', '/auth/logout', {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true });
  assert.equal(await w.count('sessions'), 0);
  assert.equal((await w.call(again.jar, 'GET', '/auth/me')).status, 401);
});

check('sign-in revokes the Discord token (a failed revoke is ignored) and never stores it', async () => {
  const w = await makeWorld();
  await signIn(w, PEOPLE.bob, []);
  assert.equal(w.discord.revoked.length, 1);
  w.discord.failRevoke = true;
  const { callback } = await signIn(w, PEOPLE.carol, []);
  assert.equal(callback.headers.get('Location'), '/#/');
  const dump = JSON.stringify(await w.rows('SELECT * FROM sessions'));
  assert(!/tokd/.test(dump));
});

check('sign-in with 250 servers stays under 100 bound parameters and keeps only servers with a guild', async () => {
  const s = await scenario();
  const crowd = Array.from({ length: 250 }, (_, i) => plain(String(700000000000000000n + BigInt(i))));
  crowd.push(plain(SERVER_A));
  s.w.db.statementLog.length = 0;
  const { jar } = await signIn(s.w, PEOPLE.frank, crowd);
  const widest = Math.max(...s.w.db.statementLog.map((entry) => entry.values.length));
  assert(widest <= 100, `widest statement binds ${widest}`);
  assert(s.w.db.statementLog.some((entry) => /json_each\(\?\)/.test(entry.sql)));
  assert(!s.w.db.statementLog.some((entry) => /\bIN \(\?/.test(entry.sql)), 'no IN list');
  const servers = await s.w.rows('SELECT server_id FROM user_servers WHERE user_id = (SELECT id FROM users WHERE discord_id = ?)', PEOPLE.frank.id);
  assert.deepEqual(servers.map((row) => row.server_id), [SERVER_A]);
  assert((await s.w.call(jar, 'GET', '/auth/me')).json.guilds.length === 1);
  assert(s.w.discord.calls.some((call) => call.url.endsWith('/api/v10/users/@me/guilds?limit=200')));
});

check('sign-in replaces the server set: leaving the Discord server drops membership at the next sign-in', async () => {
  const s = await scenario();
  assert.equal((await s.w.call(s.jars.dave, 'GET', s.guildPath)).status, 200);
  await signIn(s.w, PEOPLE.dave, [plain(SERVER_B)], s.jars.dave);
  const gone = await s.w.call(s.jars.dave, 'GET', s.guildPath);
  assert.equal(gone.status, 403);
  assert.equal(gone.json.error, 'not_member');
});

check('discord base: DISCORD_API_BASE is honoured only for https://discord.com or a local port', async () => {
  const discord = await load('worker/discord.js');
  const base = (value) => discord.apiBase({ DISCORD_API_BASE: value });
  assert.equal(base(undefined), 'https://discord.com');
  assert.equal(base('https://discord.com'), 'https://discord.com');
  assert.equal(base('http://localhost:8790'), 'http://localhost:8790');
  assert.equal(base('http://127.0.0.1:8790/'), 'http://127.0.0.1:8790');
  for (const bad of ['https://evil.test', 'http://evil.test:8790', 'http://localhost', 'http://localhost.evil.test:80', 'https://discord.com.evil.test', 'http://127.0.0.1:80/x', 'ftp://localhost:1']) {
    assert.equal(base(bad), 'https://discord.com', bad);
  }
  const w = await makeWorld({ env: { DISCORD_API_BASE: 'http://127.0.0.1:8790' } });
  await signIn(w, PEOPLE.bob, []);
  assert(w.discord.calls.every((call) => call.url.startsWith('http://127.0.0.1:8790/')));
  const login = await w.req('GET', '/auth/login');
  assert(login.headers.get('Location').startsWith('http://127.0.0.1:8790/oauth2/authorize?'));
  const hostile = await makeWorld({ env: { DISCORD_API_BASE: 'https://evil.test' } });
  await signIn(hostile, PEOPLE.bob, []);
  assert(hostile.discord.calls.every((call) => call.url.startsWith('https://discord.com/')));
});

check('constant-time compare, cookie parsing and serialization', async () => {
  const http = await load('worker/http.js');
  assert(http.safeEqual('abc', 'abc'));
  assert(!http.safeEqual('abc', 'abd'));
  assert(!http.safeEqual('abc', 'abcd'));
  assert(!http.safeEqual('', 'a'));
  assert(!http.safeEqual(undefined, 'a'));
  assert.deepEqual(http.parseCookies('a=1; b=2; a=3'), { a: '1', b: '2' });
  assert.equal(http.serializeCookie('n', 'v', { maxAge: 5, path: '/x' }), 'n=v; Max-Age=5; Path=/x; HttpOnly; Secure; SameSite=Lax');
});

// ---------------------------------------------------------------------------
// Account: me, prefs, privacy of ids

check('GET /auth/me: shape, the Discord id appears only inside avatar urls, avatar url built after a regex check', async () => {
  const w = await makeWorld();
  const hash = 'a'.repeat(32);
  const { jar } = await signIn(w, { ...PEOPLE.bob, avatar: hash }, []);
  const me = await w.call(jar, 'GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json).sort(), ['account', 'create', 'deleteImpact', 'guilds', 'identities', 'removedFrom', 'user']);
  assert.deepEqual(Object.keys(me.json.user).sort(), ['avatarUrl', 'displayName', 'id', 'initials', 'prefs', 'username']);
  assert.equal(me.json.user.displayName, 'bob', 'falls back to the username');
  assert.equal(me.json.user.avatarUrl, `https://cdn.discordapp.com/avatars/${PEOPLE.bob.id}/${hash}.png?size=64`);
  assert.deepEqual(me.json.user.prefs, { sidebarCollapsed: false, planSidebarCollapsed: true, lastGuildId: null });
  assert.deepEqual(me.json.create, { allowed: false });
  assert.deepEqual(me.json.deleteImpact, { handOverFirst: [], guildsDeleted: [], autoPromote: [] });
  assert.deepEqual(me.json.removedFrom, []);
  assert(ID.user.test(me.json.user.id));

  const hostile = await signIn(w, { ...PEOPLE.carol, avatar: '../../evil' }, []);
  const carol = await w.call(hostile.jar, 'GET', '/auth/me');
  assert.equal(carol.json.user.avatarUrl, null);
  const plainJar = (await signIn(w, PEOPLE.dave, [])).jar;
  const text = JSON.stringify((await w.call(plainJar, 'GET', '/auth/me')).json);
  assert(!text.includes(PEOPLE.dave.id), 'no Discord id in the body');
  assert.equal((await w.call(newJar(), 'GET', '/auth/me')).status, 401);
});

check('PATCH /auth/prefs: validates types, lastGuildId must be a guild you belong to', async () => {
  const s = await scenario();
  const dave = s.jars.dave;
  const ok = await s.w.call(dave, 'PATCH', '/auth/prefs', { sidebarCollapsed: true, lastGuildId: s.guildId });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { prefs: { sidebarCollapsed: true, planSidebarCollapsed: true, lastGuildId: s.guildId } });
  assert.deepEqual((await s.w.call(dave, 'GET', '/auth/me')).json.user.prefs, ok.json.prefs);
  assert.equal((await s.w.call(dave, 'PATCH', '/auth/prefs', { sidebarCollapsed: 'yes' })).status, 400);
  const plan = await s.w.call(dave, 'PATCH', '/auth/prefs', { planSidebarCollapsed: false });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.prefs, { sidebarCollapsed: true, planSidebarCollapsed: false, lastGuildId: s.guildId }, 'the plan-view collapse is its own key');
  assert.deepEqual((await s.w.call(dave, 'GET', '/auth/me')).json.user.prefs, plan.json.prefs);
  const badPlan = await s.w.call(dave, 'PATCH', '/auth/prefs', { planSidebarCollapsed: 'no' });
  assert.equal(badPlan.status, 400);
  assert.equal(badPlan.json.field, 'planSidebarCollapsed');
  const empty = await s.w.call(dave, 'PATCH', '/auth/prefs', {});
  assert(['sidebarCollapsed', 'planSidebarCollapsed', 'lastGuildId'].every((k) => empty.json.message.includes(k)), 'the message names all three keys');
  assert.equal((await s.w.call(dave, 'PATCH', '/auth/prefs', {})).status, 400);
  const outsider = (await signIn(s.w, PEOPLE.frank, [plain(SERVER_B)])).jar;
  const denied = await s.w.call(outsider, 'PATCH', '/auth/prefs', { lastGuildId: s.guildId });
  assert.equal(denied.status, 400);
  assert.equal(denied.json.field, 'lastGuildId');
  assert.equal((await s.w.call(dave, 'PATCH', '/auth/prefs', { lastGuildId: null })).json.prefs.lastGuildId, null);
});

// ---------------------------------------------------------------------------
// Create guild

check('create guild: only allowlisted users; the manageable list lives 30 minutes on the session', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const servers = [
    manageable(SERVER_A, { owner: true, permissions: '0' }),
    manageable(SERVER_B, { owner: false, permissions: '8' }),
    manageable('900000000000000003', { owner: false, permissions: '32' }),
    manageable('900000000000000004', { owner: false, permissions: String((1n << 60n) | 4n) }),
    manageable('900000000000000005', { owner: false, permissions: String(1n << 60n) }),
  ];
  const { jar } = await signIn(w, PEOPLE.alice, servers);
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.equal(me.create.allowed, true);
  assert.equal(me.create.stale, false);
  assert.deepEqual(me.create.servers.map((server) => [server.id, server.access]), [
    [SERVER_A, 'owner'], [SERVER_B, 'administrator'], ['900000000000000003', 'manage_server'],
  ]);
  const [session] = await w.rows('SELECT manageable_until, created_at FROM sessions');
  assert.equal(session.manageable_until - session.created_at, 30 * 60 * 1000);

  const stranger = (await signIn(w, PEOPLE.bob, servers)).jar;
  assert.deepEqual((await w.call(stranger, 'GET', '/auth/me')).json.create, { allowed: false });
  const [bobSession] = await w.rows('SELECT manageable_servers, manageable_until FROM sessions WHERE user_id = (SELECT id FROM users WHERE discord_id = ?)', PEOPLE.bob.id);
  assert.equal(bobSession.manageable_servers, null, 'not kept for people who cannot create');
  assert.equal(bobSession.manageable_until, null);
  const denied = await w.call(stranger, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, 'not_allowed_to_create');
});

check('create guild: 201 returns the guild payload; the servers list drops the taken server', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A), manageable(SERVER_B)]);
  const created = await w.call(jar, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json).sort(), ['attendanceFlags', 'guild', 'me', 'rosterFlags', 'rosterOptions', 'teams']);
  assert.deepEqual(Object.keys(created.json.guild).sort(), ['createdAt', 'gameVersion', 'id', 'name', 'realm', 'realmKind', 'realmSlug', 'region', 'timeZone']);
  assert.equal(created.json.guild.gameVersion, 'tbc');
  assert(ID.guild.test(created.json.guild.id));
  assert.deepEqual(created.json.teams.map(({ id, ...rest }) => rest), [{ name: 'Main team', size: 25, archived: false, players: 0, leads: [] }]);
  assert.deepEqual(created.json.me.roles, [{ role: 'guild_master' }]);
  assert.equal(created.json.me.can['guild.roles'], 'guild');
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.deepEqual(me.create.servers.map((server) => server.id), [SERVER_B]);
  assert.deepEqual(me.guilds.map((guild) => [guild.name, guild.roles]), [['Ember', [{ role: 'guild_master' }]]]);
});

check('create guild v2: game version, region and realm are validated; a listed realm stores its canonical name and slug, an unlisted one stores no slug', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A), manageable(SERVER_B)]);
  for (const [patch, field] of [
    [{ gameVersion: undefined }, 'gameVersion'], [{ gameVersion: 'tbc-anniversary' }, 'gameVersion'], [{ gameVersion: 'wotlk' }, 'gameVersion'],
    [{ gameVersion: 5 }, 'gameVersion'], [{ region: 'XX' }, 'region'], [{ realm: '' }, 'realm'], [{ realm: '   ' }, 'realm'], [{ realm: 7 }, 'realm'],
    [{ realm: 'x'.repeat(65) }, 'realm'], [{ realm: 'a\u0007b' }, 'realm'], [{ multipleTeams: undefined }, 'multipleTeams'], [{ multipleTeams: 'yes' }, 'multipleTeams'],
  ]) {
    const response = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, ...patch });
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal(response.json.error, 'bad_request');
    assert.equal(response.json.field, field, JSON.stringify(patch));
    assert.equal(typeof response.json.message, 'string');
  }
  assert.equal(await w.count('guilds'), 0, 'nothing was written');

  const listed = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, realm: '  nightSLAYER ' });
  assert.equal(listed.status, 201, JSON.stringify(listed.json));
  assert.deepEqual([listed.json.guild.realm, listed.json.guild.realmKind, listed.json.guild.realmSlug, listed.json.guild.gameVersion],
    ['Nightslayer', 'realm', 'nightslayer', 'tbc']);
  const unlisted = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, gameVersion: 'classic', region: 'EU', realm: ' Some New Realm ' });
  assert.equal(unlisted.status, 201, JSON.stringify(unlisted.json));
  assert.deepEqual([unlisted.json.guild.realm, unlisted.json.guild.realmKind, unlisted.json.guild.realmSlug, unlisted.json.guild.gameVersion],
    ['Some New Realm', 'realm', null, 'classic']);
  const rows = await w.rows('SELECT realm, realm_kind, realm_slug, game_version FROM guilds ORDER BY created_at, id');
  assert.equal(rows.length, 2);
  const got = await w.call(jar, 'GET', `/api/guild/${listed.json.guild.id}`);
  assert.equal(got.json.guild.realmKind, 'realm');
  assert.equal(got.json.guild.realmSlug, 'nightslayer');
  assert.equal(got.json.guild.realm, 'Nightslayer');
});

check('create guild v2: the same realm name resolves per version and region (Doomhowl is a Classic Era US realm, not TBC)', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A), manageable(SERVER_B)]);
  const era = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, gameVersion: 'classic', realm: 'doomhowl' });
  assert.deepEqual([era.json.guild.realm, era.json.guild.realmSlug], ['Doomhowl', 'doomhowl']);
  const tbc = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, realm: 'doomhowl' });
  assert.deepEqual([tbc.json.guild.realm, tbc.json.guild.realmSlug], ['doomhowl', null], 'typed as given, no slug');
});

check('create guild v2: WoW Forever stores a ruleset (no slug); anything else is refused', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  for (const realm of ['Nightslayer', 'pvp', 'Normal ', '', undefined, 5]) {
    const response = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, gameVersion: 'forever', realm });
    assert.equal(response.status, 400, String(realm));
    assert.equal(response.json.field, 'realm');
  }
  const ok = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, gameVersion: 'forever', region: 'EU', realm: 'Hardcore' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.guild.realm, ok.json.guild.realmKind, ok.json.guild.realmSlug, ok.json.guild.gameVersion], ['Hardcore', 'ruleset', null, 'forever']);
});

check('create guild v2: one team is "Main team" and teamNames is ignored', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, multipleTeams: false, teamNames: ['Ignored', 'Also ignored'], teamName: 'Old field' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.teams.map(({ id, ...rest }) => rest), [{ name: 'Main team', size: 25, archived: false, players: 0, leads: [] }]);
  assert.equal(await w.count('teams'), 1);
});

check('create guild v2: several teams are written in the same batch as the guild, in order, 25-man each', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, multipleTeams: true, teamNames: ['  Mythic Monday ', 'Casual Thursday', 'Sunday Alts'] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.teams.map((team) => team.name).sort(), ['Casual Thursday', 'Mythic Monday', 'Sunday Alts']);
  assert(created.json.teams.every((team) => team.size === 25 && team.archived === false));
  const rows = await w.rows('SELECT name, size, archived, guild_id FROM teams ORDER BY created_at, rowid');
  assert.deepEqual(rows.map((row) => row.name), ['Mythic Monday', 'Casual Thursday', 'Sunday Alts'], 'trimmed, in the order sent');
  assert(rows.every((row) => row.guild_id === created.json.guild.id));
  const audit = await w.rows("SELECT after FROM audit_log WHERE action = 'guild.create'");
  assert.equal(JSON.parse(audit[0].after).teamIds.length, 3);
});

check('create guild v2: bad team names return teamNames with the index of the bad entry, and write nothing', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const body = (teamNames) => ({ ...GUILD_BODY, multipleTeams: true, teamNames });
  const eleven = Array.from({ length: 11 }, (_, i) => `Team ${i + 1}`);
  const cases = [
    [['Only one'], undefined], [[], undefined], [eleven, undefined], ['Mon,Thu', undefined], [undefined, undefined],
    [['Mon', ''], 1], [['Mon', '   '], 1], [['Mon', 5], 1], [['', 'Thu'], 0], [['Mon', 'Thu', 'y'.repeat(41)], 2],
    [['Mon', 'Thu', 'a\nb'], 2], [['Mon', 'Thu', 'mon'], 2], [['Mon', 'Thu', ' THU '], 2],
  ];
  for (const [teamNames, index] of cases) {
    const response = await w.call(jar, 'POST', '/api/guild', body(teamNames));
    assert.equal(response.status, 400, JSON.stringify(teamNames));
    assert.equal(response.json.error, 'bad_request');
    assert.equal(response.json.field, 'teamNames', JSON.stringify(teamNames));
    assert.equal(response.json.index, index, JSON.stringify(teamNames));
    assert.equal(typeof response.json.message, 'string');
  }
  assert.equal(await w.count('guilds'), 0);
  assert.equal(await w.count('teams'), 0);
  const ten = await w.call(jar, 'POST', '/api/guild', body(eleven.slice(0, 10)));
  assert.equal(ten.status, 201, 'ten is the cap');
  assert.equal(ten.json.teams.length, 10);
});

check('create guild v2: the 50-active-team cap still holds after a multi-team create', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, multipleTeams: true, teamNames: Array.from({ length: 10 }, (_, i) => `Start ${i}`) });
  const path = `/api/guild/${created.json.guild.id}/teams`;
  for (let i = 0; i < 40; i++) assert.equal((await w.call(jar, 'POST', path, { name: `Extra ${i}` })).status, 201, `team ${i}`);
  const over = await w.call(jar, 'POST', path, { name: 'One too many' });
  assert.equal(over.status, 400);
  assert.equal(over.json.field, 'name');
  assert.equal(await w.count('teams'), 50);
});

check('/auth/me create.options: sent to allowlisted creators only, from worker/realms.js', async () => {
  const realms = await import('./worker/realms.js');
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = (await signIn(w, PEOPLE.alice, [manageable(SERVER_A)])).jar;
  const bob = (await signIn(w, PEOPLE.bob, [manageable(SERVER_B)])).jar;
  const mine = (await w.call(alice, 'GET', '/auth/me')).json.create;
  assert.deepEqual(Object.keys(mine).sort(), ['allowed', 'claimable', 'options', 'servers', 'stale']);
  assert.deepEqual(Object.keys(mine.options).sort(), ['realms', 'regions', 'rulesets', 'versions']);
  assert.deepEqual(mine.options.versions, [
    { key: 'tbc', label: 'TBC Anniversary' }, { key: 'classic', label: 'Classic Era' }, { key: 'forever', label: 'WoW Forever' },
  ]);
  assert.deepEqual(mine.options.regions, ['US', 'EU', 'KR', 'TW']);
  assert.deepEqual(mine.options.rulesets, ['Normal', 'PvP', 'RP', 'Hardcore']);
  assert.deepEqual(mine.options.realms, JSON.parse(JSON.stringify(realms.REALMS)));
  assert.deepEqual(mine.options.realms.tbc.US.map((realm) => realm.name), ['Dreamscythe', 'Nightslayer', 'Maladath (AU)']);
  const theirs = (await w.call(bob, 'GET', '/auth/me')).json.create;
  assert.deepEqual(theirs, { allowed: false }, 'no options for people who cannot create');
  assert(!JSON.stringify(theirs).includes('Dreamscythe'));
});

check('create guild: a stale manageable list gets reauth_required; a server outside the list is refused', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const outside = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B });
  assert.equal(outside.status, 403);
  assert.equal(outside.json.error, 'not_allowed_to_create');
  w.advance(30 * 60 * 1000 + 1);
  const stale = await w.call(jar, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, 'reauth_required');
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.deepEqual({ ...me.create, options: undefined }, { allowed: true, stale: true, servers: [], claimable: [], options: undefined });
  assert.deepEqual(Object.keys(me.create.options).sort(), ['realms', 'regions', 'rulesets', 'versions']);
  const [row] = await w.rows('SELECT manageable_servers FROM sessions');
  assert.equal(row.manageable_servers, null, 'a stale list is dropped');
  await signIn(w, PEOPLE.alice, [manageable(SERVER_A)], jar);
  assert.equal((await w.call(jar, 'POST', '/api/guild', GUILD_BODY)).status, 201, 'signing in again re-arms it');
});

check('create guild: 409 for a taken server, 400 for bad fields, 409 for a duplicate team name (case-insensitive)', async () => {
  const s = await scenario();
  const frank = (await signIn(s.w, PEOPLE.frank, [manageable(SERVER_A), manageable(SERVER_B)])).jar;
  const taken = await s.w.call(frank, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'server_taken');
  assert.equal(taken.json.field, 'serverId');
  assert.equal(await s.w.count('guilds'), 1);
  for (const [patch, field] of [
    [{ name: '' }, 'name'], [{ name: 5 }, 'name'], [{ realm: 'x'.repeat(65) }, 'realm'], [{ region: 'XX' }, 'region'],
    [{ timeZone: 'Mars/Phobos' }, 'timeZone'], [{ gameVersion: 'nope' }, 'gameVersion'], [{ serverId: '12ab' }, 'serverId'],
    [{ name: 'a\nb' }, 'name'],
  ]) {
    const response = await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, ...patch });
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal(response.json.field, field, JSON.stringify(patch));
  }
  const first = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Alt Run' });
  assert.equal(first.status, 201);
  const dupe = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'alt run' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error, 'team_name_taken');
  assert.equal(dupe.json.field, 'name');
  assert.equal((await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'main TEAM' })).status, 409);
});

// ---------------------------------------------------------------------------
// Permissions

check('permissions: every role x action x scope matches the plan table', async () => {
  const s = await scenario();
  const permissions = await load('worker/permissions.js');
  const seeded = await s.w.rows('SELECT role_id, action, scope FROM role_permissions');
  const resolve = (assignments) => permissions.resolvePermissions(assignments, seeded);
  const ALL = permissions.ACTIONS;
  // signups.self is own_teams only: nobody holds it guild-wide, so it is an empty list until they have a character on a team.
  const memberCan = { 'roster.view': 'guild', 'raids.view': 'guild', 'signups.self': [], 'attendance.view': [], 'loot.view': [] };

  assert.deepEqual(resolve([]).can, memberCan);
  assert.deepEqual(resolve([{ role_id: 'officer', team_id: null }]).can,
    { ...Object.fromEntries(ALL.filter((action) => !['guild.roles', 'audit.view', 'signups.self'].includes(action)).map((action) => [action, 'guild'])), 'signups.self': [] });
  assert.deepEqual(resolve([{ role_id: 'guild_master', team_id: null }]).can, { ...Object.fromEntries(ALL.filter((action) => action !== 'signups.self').map((action) => [action, 'guild'])), 'signups.self': [] });
  const lead = resolve([{ role_id: 'team_lead', team_id: 't_b' }, { role_id: 'team_lead', team_id: 't_a' }]).can;
  assert.deepEqual(lead, {
    'roster.view': 'guild', 'raids.view': 'guild', 'signups.self': [],
    'roster.edit': ['t_a', 't_b'], 'roster.notes.view': ['t_a', 't_b'], 'roster.notes.edit': ['t_a', 't_b'],
    'raids.edit': ['t_a', 't_b'], 'attendance.view': ['t_a', 't_b'], 'attendance.review': ['t_a', 't_b'],
    'loot.view': ['t_a', 't_b'], 'loot.edit': ['t_a', 't_b'],
  });
  assert(permissions.allows(lead, 'roster.edit', 't_a'));
  assert(!permissions.allows(lead, 'roster.edit', 't_other'));
  assert(!permissions.allows(lead, 'roster.edit'), 'a team scope needs a team');
  assert(!permissions.allows(lead, 'guild.teams'));
  assert(permissions.allows(memberCan, 'roster.view'));
  // Seed shape: scopes are only the four allowed ones and Public (no role) holds nothing.
  assert(seeded.every((row) => ['guild', 'team', 'own_teams', 'own'].includes(row.scope)));
  assert.deepEqual(seeded.filter((row) => !['guild_master', 'officer', 'team_lead', 'member'].includes(row.role_id)), []);
});

check('permissions over HTTP: Member, Team Lead, Officer and Guild Master are each held to their actions', async () => {
  const s = await scenario();
  assert.equal((await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] })).status, 200);
  const status = async (name, method, route, body) => (await s.w.call(s.jars[name], method, `${s.guildPath}${route}`, body)).status;

  assert.equal(await status('dave', 'GET', ''), 200);
  assert.equal(await status('dave', 'GET', '/people'), 403);
  assert.equal(await status('dave', 'POST', '/teams', { name: 'X' }), 403);
  assert.equal(await status('carol', 'GET', '/people'), 403);
  assert.equal(await status('carol', 'POST', '/teams', { name: 'X' }), 403);
  assert.equal(await status('bob', 'GET', '/people'), 200);
  assert.equal(await status('bob', 'POST', '/teams', { name: 'Officer Team' }), 201);
  assert.equal(await status('bob', 'PUT', `/people/${s.ids.dave}/roles`, { officer: true, teamLeadTeamIds: [] }), 403);
  assert.equal(await status('bob', 'POST', `/people/${s.ids.dave}/guild-master`, {}), 403);
  assert.equal(await status('alice', 'GET', '/people'), 200);

  const lead = (await s.w.call(s.jars.carol, 'GET', s.guildPath)).json.me;
  assert.deepEqual(lead.roles, [{ role: 'team_lead', teamId: s.teamId }]);
  assert.deepEqual(lead.can['roster.edit'], [s.teamId]);
  assert.equal(lead.can['guild.teams'], undefined, 'not allowed -> absent');
  const member = (await s.w.call(s.jars.dave, 'GET', s.guildPath)).json.me;
  assert.deepEqual(member, { roles: [], can: { 'roster.view': 'guild', 'raids.view': 'guild', 'signups.self': [], 'attendance.view': [], 'loot.view': [] } });
});

check('cross-guild denial: another guild is a 403, another guild\'s team id is a 400/404, and ids come from the URL', async () => {
  const s = await scenario();
  const frank = (await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B), plain(SERVER_A)])).jar;
  const other = await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', multipleTeams: true, teamNames: ['Their Team', 'Their Alts'] });
  assert.equal(other.status, 201);
  const otherGuild = other.json.guild.id;
  const otherTeam = other.json.teams[0].id;

  for (const [method, route, body] of [
    ['GET', '', undefined], ['GET', '/people', undefined], ['POST', '/teams', { name: 'Sneaky' }],
  ]) {
    const response = await s.w.call(s.alice, method, `/api/guild/${otherGuild}${route}`, body);
    assert.equal(response.status, 403, `${method} ${route}`);
    assert.equal(response.json.error, 'not_member');
  }
  const patchOther = await s.w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${otherTeam}`, { name: 'Hijack' });
  assert.equal(patchOther.status, 404);
  const crossTeam = await s.setRoles('bob', { officer: false, teamLeadTeamIds: [otherTeam] });
  assert.equal(crossTeam.status, 400);
  assert.equal(crossTeam.json.field, 'teamLeadTeamIds');
  assert.equal(await s.w.count('role_assignments', "role_id = 'team_lead'"), 0);
  assert.equal((await s.w.call(s.alice, 'GET', `/api/guild/${s.guildId}x`)).status, 404, 'malformed id');
  assert.equal((await s.w.call(s.alice, 'GET', '/api/guild/g_AAAAAAAAAAAAAAAAAAAAAA')).status, 404, 'unknown id');
  assert.equal((await s.w.call(s.alice, 'GET', '/api/guild/%2e%2e')).status, 404);
  assert.equal((await s.w.call(frank, 'GET', `/api/guild/${s.guildId}/people`)).status, 403, 'a plain member of A cannot list people');
});

// ---------------------------------------------------------------------------
// Members, blocks and the hierarchy

check('membership: a non-member gets 403 not_member, an unknown guild 404, signed out 401', async () => {
  const s = await scenario();
  const outsider = (await signIn(s.w, PEOPLE.frank, [plain(SERVER_B)])).jar;
  const response = await s.w.call(outsider, 'GET', s.guildPath);
  assert.equal(response.status, 403);
  assert.equal(response.json.error, 'not_member');
  assert.equal((await s.w.call(newJar(), 'GET', s.guildPath)).status, 401);
  const guildless = await s.w.call(s.jars.dave, 'GET', '/api/guild/g_AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(guildless.status, 404);
});

check('blocks: Remove access takes effect on the very next request; Restore access brings it back', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] });
  assert.equal((await s.w.call(s.jars.dave, 'GET', s.guildPath)).status, 200);

  const removed = await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'left the guild' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.removed.map((entry) => [entry.person.username, entry.reason, entry.removedBy.username]), [['dave', 'left the guild', 'bob']]);
  assert.deepEqual(removed.json.removed[0].actions, { restoreAccess: true });
  assert(!removed.json.people.some((entry) => entry.person.username === 'dave'));

  const blocked = await s.w.call(s.jars.dave, 'GET', s.guildPath);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'access_removed');
  assert.equal((await s.w.call(s.jars.dave, 'GET', '/auth/me')).json.guilds.length, 0);
  assert.equal((await s.w.call(s.jars.dave, 'PATCH', '/auth/prefs', { lastGuildId: s.guildId })).status, 400);

  const repeat = await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('dave')}/block`, {});
  assert.equal(repeat.status, 200, 'removing twice is a no-op');
  assert.equal(await s.w.count('guild_blocks'), 1);

  const restored = await s.w.call(s.jars.bob, 'DELETE', `${s.peoplePath('dave')}/block`, {});
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.json.removed, []);
  assert.equal((await s.w.call(s.jars.dave, 'GET', s.guildPath)).status, 200);
  assert.equal((await s.w.call(s.jars.bob, 'DELETE', `${s.peoplePath('dave')}/block`, {})).status, 200, 'restoring twice is a no-op');
});

check('blocks: the reason is length-limited and stays out of the audit log', async () => {
  const s = await scenario();
  const tooLong = await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'x'.repeat(201) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.field, 'reason');
  assert.equal((await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, { reason: 5 })).status, 400);
  assert.equal((await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'secret words' })).status, 200);
  const audit = await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'access.remove'");
  assert.equal(audit.length, 1);
  assert(!JSON.stringify(audit).includes('secret'));
  assert.deepEqual(JSON.parse(audit[0].after), { blocked: true, reasonSet: true });
});

check('hierarchy: nobody removes themselves or the Guild Master; an Officer acts only below Officer; the Guild Master acts on Officers', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.setRoles('erin', { officer: true, teamLeadTeamIds: [] });
  await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] });
  const block = (actor, target) => s.w.call(s.jars[actor], 'POST', `${s.peoplePath(target)}/block`, {});

  assert.equal((await block('bob', 'bob')).status, 403, 'not yourself');
  assert.equal((await block('bob', 'alice')).status, 403, 'not the Guild Master');
  assert.equal((await block('alice', 'alice')).status, 403);
  assert.equal((await block('bob', 'erin')).status, 403, 'an Officer cannot act on an Officer');
  assert.equal((await block('bob', 'carol')).status, 200, 'an Officer can act on a Team Lead');
  assert.equal((await s.w.call(s.jars.bob, 'DELETE', `${s.peoplePath('carol')}/block`, {})).status, 200);
  assert.equal((await block('bob', 'dave')).status, 200);
  assert.equal((await block('alice', 'erin')).status, 200, 'the Guild Master can act on an Officer');
  assert.equal((await s.w.call(s.jars.bob, 'DELETE', `${s.peoplePath('erin')}/block`, {})).status, 403, 'restoring follows the same hierarchy');
  assert.equal((await s.w.call(s.alice, 'DELETE', `${s.peoplePath('erin')}/block`, {})).status, 200);
  assert.equal((await block('carol', 'dave')).status, 403, 'a Team Lead has no guild.access');

  const people = await s.w.call(s.alice, 'GET', `${s.guildPath}/people`);
  const byName = Object.fromEntries(people.json.people.map((entry) => [entry.person.username, entry]));
  assert.deepEqual(byName.alice.actions, { editRoles: false, makeGuildMaster: false, removeAccess: false });
  assert.deepEqual(byName.bob.actions, { editRoles: true, makeGuildMaster: true, removeAccess: true });
  const asBob = await s.w.call(s.jars.bob, 'GET', `${s.guildPath}/people`);
  const bobView = Object.fromEntries(asBob.json.people.map((entry) => [entry.person.username, entry]));
  assert.deepEqual(bobView.erin.actions, { editRoles: false, makeGuildMaster: false, removeAccess: false });
  assert.deepEqual(bobView.carol.actions, { editRoles: false, makeGuildMaster: false, removeAccess: true });
  assert.equal(bobView.bob.isMe, true);
  assert.equal(bobView.alice.isMe, false);
});

check('hierarchy: a person who is not in the server and has no role is the same 404 as a missing user', async () => {
  const s = await scenario();
  const lurker = (await signIn(s.w, PEOPLE.frank, [plain(SERVER_B)])).jar;
  const lurkerId = (await s.w.call(lurker, 'GET', '/auth/me')).json.user.id;
  const missing = 'u_AAAAAAAAAAAAAAAAAAAAAA';
  for (const id of [lurkerId, missing]) {
    for (const [method, route, body] of [
      ['POST', 'block', {}], ['DELETE', 'block', {}], ['PUT', 'roles', { officer: true, teamLeadTeamIds: [] }], ['POST', 'guild-master', {}],
    ]) {
      const response = await s.w.call(s.alice, method, `${s.guildPath}/people/${id}/${route}`, body);
      assert.equal(response.status, 404, `${method} ${route} ${id}`);
      assert.equal(response.json.error, 'not_found');
    }
  }
  assert.equal((await s.w.call(s.alice, 'POST', `${s.guildPath}/people/not-an-id/block`, {})).status, 404);
});

check('set roles: validation (officer strictly boolean, teams active and in this guild, deduplicated, capped at 20)', async () => {
  const s = await scenario();
  const bad = async (body) => (await s.setRoles('dave', body));
  assert.equal((await bad({ officer: 'true', teamLeadTeamIds: [] })).status, 400);
  assert.equal((await bad({ officer: 1, teamLeadTeamIds: [] })).status, 400);
  assert.equal((await bad({ teamLeadTeamIds: [] })).status, 400);
  assert.equal((await bad({ officer: false })).status, 400);
  assert.equal((await bad({ officer: false, teamLeadTeamIds: 'x' })).status, 400);
  assert.equal((await bad({ officer: false, teamLeadTeamIds: ['nope'] })).status, 400);
  assert.equal((await bad({ officer: false, teamLeadTeamIds: ['t_AAAAAAAAAAAAAAAAAAAAAA'] })).status, 400);
  const many = Array.from({ length: 21 }, (_, i) => `t_${String(i).padStart(22, 'A')}`);
  const capped = await bad({ officer: false, teamLeadTeamIds: many });
  assert.equal(capped.status, 400);
  assert.equal(capped.json.field, 'teamLeadTeamIds');

  const archivedTeam = (await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Old' })).json.team.id;
  await s.w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${archivedTeam}`, { archived: true });
  assert.equal((await bad({ officer: false, teamLeadTeamIds: [archivedTeam] })).status, 400, 'archived team');

  const ok = await bad({ officer: true, teamLeadTeamIds: [s.teamId, s.teamId] });
  assert.equal(ok.status, 200);
  const dave = ok.json.people.find((entry) => entry.person.username === 'dave');
  assert.deepEqual(dave.roles, [{ role: 'officer' }, { role: 'team_lead', teamId: s.teamId }]);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'team_lead'", s.ids.dave), 1, 'deduplicated');
  const lead = (await s.w.call(s.alice, 'GET', s.guildPath)).json.teams.find((team) => team.id === s.teamId);
  assert.deepEqual(lead.leads.map((person) => person.username), ['dave']);

  const cleared = await bad({ officer: false, teamLeadTeamIds: [] });
  assert.deepEqual(cleared.json.people.find((entry) => entry.person.username === 'dave').roles, []);
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.dave), 0);
  assert.equal((await s.setRoles('alice', { officer: true, teamLeadTeamIds: [] })).status, 403, 'not the Guild Master');
});

check('set roles: a blocked person or a non-member cannot be given roles', async () => {
  const s = await scenario();
  await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, {});
  assert.equal((await s.setRoles('dave', { officer: true, teamLeadTeamIds: [] })).status, 404);
  await signIn(s.w, PEOPLE.erin, [plain(SERVER_B)], s.jars.erin);
  assert.equal((await s.setRoles('erin', { officer: true, teamLeadTeamIds: [] })).status, 404);
  assert.equal(await s.w.count('role_assignments', "role_id = 'officer'"), 0);
});

// ---------------------------------------------------------------------------
// Guild Master hand-over

check('guild master: Make Guild Master swaps in one step, the old Guild Master becomes an Officer', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] });
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('carol')}/guild-master`, {})).status, 403, 'only the Guild Master');
  assert.equal((await s.w.call(s.alice, 'POST', `${s.peoplePath('alice')}/guild-master`, {})).status, 403, 'not yourself');

  const swap = await s.w.call(s.alice, 'POST', `${s.peoplePath('bob')}/guild-master`, {});
  assert.equal(swap.status, 200, JSON.stringify(swap.json));
  const roles = Object.fromEntries(swap.json.people.map((entry) => [entry.person.username, entry.roles]));
  assert.deepEqual(roles.bob, [{ role: 'guild_master' }]);
  assert.deepEqual(roles.alice, [{ role: 'officer' }]);
  assert.equal(await s.w.count('role_assignments', "guild_id = ? AND role_id = 'guild_master'", s.guildId), 1);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer'", s.ids.bob), 0, 'the new Guild Master\'s other rows are dropped');
  assert.equal((await s.w.call(s.alice, 'PUT', `${s.peoplePath('dave')}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 403);
  const back = await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('alice')}/guild-master`, {});
  assert.equal(back.status, 200);
  assert.equal((await s.w.rows("SELECT user_id FROM role_assignments WHERE role_id = 'guild_master'"))[0].user_id, s.ids.alice);
});

check('guild master: the target must be a current, unblocked member; a lost race answers 409 and changes nothing', async () => {
  const s = await scenario();
  await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, {});
  assert.equal((await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/guild-master`, {})).status, 404);

  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements[0].sql.includes('UPDATE role_assignments SET user_id')) {
      s.w.db.sqlite.exec(`DELETE FROM user_servers WHERE user_id = '${s.ids.bob}'`);
    }
    return realBatch(statements);
  };
  const raced = await s.w.call(s.alice, 'POST', `${s.peoplePath('bob')}/guild-master`, {});
  s.w.db.batch = realBatch;
  assert.equal(raced.status, 409);
  const masters = await s.w.rows("SELECT user_id FROM role_assignments WHERE role_id = 'guild_master'");
  assert.deepEqual(masters.map((row) => row.user_id), [s.ids.alice]);
  assert.equal(await s.w.count('role_assignments', "role_id = 'officer'"), 0);
  assert.equal(await s.w.count('audit_log', "action = 'guild_master.transfer'"), 0);
});

// ---------------------------------------------------------------------------
// Teams

check('teams: create, rename, archive and restore; payload shape; case-insensitive uniqueness among active teams', async () => {
  const s = await scenario();
  const created = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Gruul Run' });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json), ['team']);
  assert.deepEqual(Object.keys(created.json.team).sort(), ['archived', 'id', 'leads', 'name', 'players', 'size']);
  assert(ID.team.test(created.json.team.id));
  const teamPath = `${s.guildPath}/teams/${created.json.team.id}`;
  assert.equal((await s.w.call(s.alice, 'PATCH', teamPath, {})).status, 400);
  const badArchived = await s.w.call(s.alice, 'PATCH', teamPath, { archived: 'yes' });
  assert.equal(badArchived.status, 400);
  assert.equal(badArchived.json.field, undefined, 'field values on team routes are limited to name');
  assert.equal((await s.w.call(s.alice, 'PATCH', teamPath, { name: 'Main team' })).status, 409);
  const renamed = await s.w.call(s.alice, 'PATCH', teamPath, { name: 'Gruul Prog' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.team.name, 'Gruul Prog');
  const archived = await s.w.call(s.alice, 'PATCH', teamPath, { archived: true });
  assert.equal(archived.json.team.archived, true);
  assert.equal((await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'gruul prog' })).status, 201, 'archived names are free');
  assert.equal((await s.w.call(s.alice, 'PATCH', teamPath, { archived: false })).status, 409, 'restoring into a taken name');
  assert.equal((await s.w.call(s.alice, 'PATCH', `${s.guildPath}/teams/t_AAAAAAAAAAAAAAAAAAAAAA`, { name: 'x' })).status, 404);
  const guild = await s.w.call(s.alice, 'GET', s.guildPath);
  assert.equal(guild.json.teams.length, 3, 'archived teams are listed with archived: true');
});

// ---------------------------------------------------------------------------
// Delete my data

check('delete my data: blocked for a Guild Master while anyone else has joined', async () => {
  const s = await scenario();
  const me = (await s.w.call(s.alice, 'GET', '/auth/me')).json;
  assert.deepEqual(me.deleteImpact.handOverFirst, [{ id: s.guildId, name: 'Ember' }]);
  assert.deepEqual(me.deleteImpact.guildsDeleted, []);
  const blocked = await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'hand_over_guild_master');
  assert.deepEqual(blocked.json.guilds, [{ id: s.guildId, name: 'Ember' }]);
  assert.equal(await s.w.count('users', 'id = ?', s.ids.alice), 1);
  await s.w.call(s.alice, 'POST', `${s.peoplePath('bob')}/guild-master`, {});
  assert.equal((await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200, 'after handing over');
  assert.equal(await s.w.count('guilds'), 1);
});

check('delete my data: a solo Guild Master deletes the guild too, after the confirm echo matches', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(jar, 'POST', '/api/guild', GUILD_BODY);
  const guildId = created.json.guild.id;
  await w.call(jar, 'POST', `/api/guild/${guildId}/teams`, { name: 'Second' });
  const me = (await w.call(jar, 'GET', '/auth/me')).json;
  assert.deepEqual(me.deleteImpact, { handOverFirst: [], guildsDeleted: [{ id: guildId, name: 'Ember' }], autoPromote: [] });

  for (const echo of [[], ['g_AAAAAAAAAAAAAAAAAAAAAA'], [guildId, 'g_AAAAAAAAAAAAAAAAAAAAAA']]) {
    const mismatch = await w.call(jar, 'DELETE', '/auth/me', { deleteGuildIds: echo });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.error, 'confirm_mismatch');
    assert.deepEqual(mismatch.json.guilds, [{ id: guildId, name: 'Ember' }]);
  }
  assert.equal((await w.call(jar, 'DELETE', '/auth/me', {})).status, 400, 'deleteGuildIds is required');
  assert.equal(await w.count('guilds'), 1, 'nothing deleted yet');

  const done = await w.call(jar, 'DELETE', '/auth/me', { deleteGuildIds: [guildId] });
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { ok: true });
  assert(done.response.headers.getSetCookie().some((c) => c.startsWith('__Host-rs_session=;') && c.includes('Max-Age=0')));
  for (const table of ['users', 'sessions', 'user_servers', 'guilds', 'teams', 'role_assignments', 'guild_blocks', 'rate_limits']) {
    assert.equal(await w.count(table), 0, table);
  }
  const audit = await w.rows('SELECT action, guild_id, actor_user_id, entity_id FROM audit_log ORDER BY action');
  assert.deepEqual(audit.map((row) => [row.action, row.guild_id, row.actor_user_id]), [['account.delete', null, null], ['guild.delete', null, null]]);
  assert.equal(audit.find((row) => row.action === 'guild.delete').entity_id, guildId);
  assert.equal((await w.call(jar, 'GET', '/auth/me')).status, 401);
});

check('delete my data: works for a user who assigned roles and blocked people (FK SET NULL), and removes the w:<id> rate-limit row', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'x' });
  await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/teams`, { name: 'Bob Team' });
  assert.equal(await s.w.count('rate_limits', 'key = ?', `w:${s.ids.bob}`), 1);
  assert.equal((await s.w.call(s.alice, 'PUT', `${s.peoplePath('carol')}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 200);
  await s.w.call(s.alice, 'POST', `${s.peoplePath('bob')}/guild-master`, {});
  await s.w.call(s.jars.bob, 'PUT', `${s.peoplePath('erin')}/roles`, { officer: true, teamLeadTeamIds: [] });
  await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('alice')}/guild-master`, {});

  const gone = await s.w.call(s.jars.bob, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(await s.w.count('users', 'id = ?', s.ids.bob), 0);
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.bob), 0);
  assert.equal(await s.w.count('rate_limits', 'key = ?', `w:${s.ids.bob}`), 0);
  assert(await s.w.count('role_assignments', 'assigned_by IS NULL') >= 1, 'rows Bob assigned keep existing with a NULL assigner');
  assert.equal(await s.w.count('role_assignments', 'assigned_by = ?', s.ids.bob), 0);
  const block = (await s.w.rows('SELECT blocked_by FROM guild_blocks'))[0];
  assert.equal(block.blocked_by, null, 'the block stays, its author is NULL');
  assert.equal(await s.w.count('audit_log', 'actor_user_id = ?', s.ids.bob), 0);
  assert(await s.w.count('audit_log', 'actor_user_id IS NULL') > 0);
});

check('delete my data: removes every Discord-derived row of the user, including an access block on them', async () => {
  const s = await scenario();
  await s.setRoles('dave', { officer: false, teamLeadTeamIds: [s.teamId] });
  await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'gone' });
  const removed = await s.w.call(s.jars.dave, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(removed.status, 200, 'a blocked person can still delete their data');
  const id = s.ids.dave;
  assert.equal(await s.w.count('users', 'id = ?', id), 0);
  assert.equal(await s.w.count('users', 'discord_id = ?', PEOPLE.dave.id), 0);
  for (const [table, column] of [['sessions', 'user_id'], ['user_servers', 'user_id'], ['role_assignments', 'user_id'], ['guild_blocks', 'user_id'], ['audit_log', 'actor_user_id']]) {
    assert.equal(await s.w.count(table, `${column} = ?`, id), 0, table);
  }
  const people = await s.w.call(s.alice, 'GET', `${s.guildPath}/people`);
  assert.deepEqual(people.json.removed, []);
  assert(!people.json.people.some((entry) => entry.person.username === 'dave'));
  assert.equal(await s.w.count('audit_log', "action = 'account.delete'"), 1);
});

// ---------------------------------------------------------------------------
// Audit

check('audit: exactly the audited actions are written, once each, in the writes\' own batch', async () => {
  const s = await scenario();
  const { w } = s;
  const baseline = async () => (await w.rows('SELECT action FROM audit_log')).map((row) => row.action).sort();
  assert.deepEqual(await baseline(), ['guild.create']);

  // Reads, prefs, no-op writes and failed writes add nothing.
  await w.call(s.alice, 'GET', s.guildPath);
  await w.call(s.alice, 'GET', `${s.guildPath}/people`);
  await w.call(s.alice, 'PATCH', '/auth/prefs', { sidebarCollapsed: true });
  await w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Main team' });
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${s.teamId}`, { name: 'Main team', archived: false });
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${s.teamId}`, { size: 25 }); // the size it already has
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${s.teamId}`, { size: 15 }); // not a raid size
  await w.call(s.alice, 'PUT', `${s.peoplePath('bob')}/roles`, { officer: false, teamLeadTeamIds: [] });
  assert.deepEqual(await baseline(), ['guild.create']);

  const team = (await w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Second' })).json.team.id;
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${team}`, { name: 'Renamed' });
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${team}`, { archived: true });
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${team}`, { archived: false });
  await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${team}`, { size: 10 });
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await w.call(s.jars.bob, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'because' });
  await w.call(s.jars.bob, 'DELETE', `${s.peoplePath('dave')}/block`, {});
  await w.call(s.alice, 'POST', `${s.peoplePath('bob')}/guild-master`, {});
  const frank = (await signIn(w, PEOPLE.frank, [manageable(SERVER_B)])).jar;
  const solo = await w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Solo' });
  assert.equal(solo.status, 201);
  assert.equal((await w.call(frank, 'DELETE', '/auth/me', { deleteGuildIds: [solo.json.guild.id] })).status, 200);
  // A claim (a guild left without a Guild Master) and an automatic promotion (the departed Guild Master deletes their data).
  const frankAgain = (await signIn(w, PEOPLE.frank, [manageable(SERVER_B)])).jar;
  const orphan = await w.call(frankAgain, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Orphan' });
  assert.equal(orphan.status, 201);
  w.db.sqlite.exec(`DELETE FROM role_assignments WHERE role_id = 'guild_master' AND guild_id = '${orphan.json.guild.id}'`);
  assert.equal((await w.call(frankAgain, 'POST', `/api/guild/${orphan.json.guild.id}/claim`, {})).status, 200);
  await signIn(w, PEOPLE.bob, [], s.jars.bob);
  assert.equal((await w.call(s.jars.bob, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);

  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  const written = await baseline();
  // The roster actions (Phase 2) are driven and pinned in guild-roster-worker-tests.js.
  const ROSTER_ACTIONS = ['character.create', 'character.delete', 'character.main', 'character.update', 'person.create', 'person.delete',
    'person.notes', 'person.update', 'roster.import'];
  // The attendance actions (Phase 3) are driven and pinned in guild-attendance-worker-tests.js.
  const ATTENDANCE_ACTIONS = ['raid.create', 'raid.delete', 'raid.event', 'raid.report', 'raid.plan', 'raid.manual', 'attendance.decide',
    'attendance.undo', 'attendance.link', 'attendance.guest', 'policy.update', 'wcl.settings', 'raid.settings'];
  // The loot actions (Phase 4) are driven and pinned in guild-loot-worker-tests.js; the Battle.net actions (Phase 5) in guild-bnet-worker-tests.js.
  const LOOT_ACTIONS = ['loot.import', 'loot.update', 'loot.delete', 'loot.policy'];
  const BNET_ACTIONS = ['bnet.link', 'bnet.unlink', 'bnet.settings', 'claim.create', 'claim.withdraw', 'claim.approve', 'claim.reject'];
  // The sign-up and schedule actions (Phase 6) are driven and pinned in guild-signups-worker-tests.js.
  const SIGNUP_ACTIONS = ['signup.set', 'signup.remove', 'signup.lock', 'schedule.update', 'schedule.fill'];
  // The account actions (Phase 7a) are driven and pinned in guild-accounts-worker-tests.js.
  const ACCOUNT_ACTIONS = ['discord.link', 'discord.unlink', 'person.account_link', 'person.account_unlink'];
  assert.deepEqual([...new Set(written)].sort(), AUDIT_ACTIONS.filter((action) => !ROSTER_ACTIONS.includes(action) && !ATTENDANCE_ACTIONS.includes(action) && !LOOT_ACTIONS.includes(action) && !BNET_ACTIONS.includes(action) && !SIGNUP_ACTIONS.includes(action) && !ACCOUNT_ACTIONS.includes(action)).sort());
  assert.deepEqual(AUDIT_ACTIONS.slice().sort(), [
    'access.remove', 'access.restore', 'account.delete', 'guild.claim', 'guild.create', 'guild.delete',
    'guild_master.auto_promote', 'guild_master.transfer', 'roles.set', 'team.archive', 'team.create', 'team.rename', 'team.restore', 'team.size',
    ...ROSTER_ACTIONS, ...ATTENDANCE_ACTIONS, ...LOOT_ACTIONS, ...BNET_ACTIONS, ...SIGNUP_ACTIONS, ...ACCOUNT_ACTIONS,
  ].sort());
  const rows = await w.rows("SELECT guild_id, actor_user_id, entity_type, entity_id, created_at FROM audit_log WHERE action IN ('account.delete', 'guild.delete')");
  assert(rows.every((row) => row.guild_id === null));
  const sample = await w.rows("SELECT before, after FROM audit_log WHERE action IN ('roles.set', 'guild_master.transfer', 'access.remove', 'guild.claim', 'guild_master.auto_promote')");
  for (const row of sample) assert(!/because|alice|bob|@/.test(`${row.before}${row.after}`), 'internal ids and flags only');
});

// ---------------------------------------------------------------------------
// Request checks

check('request checks: cross-site, content type, size and JSON shape', async () => {
  const s = await scenario();
  const post = (extra) => s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'T' }, extra);

  const cross = await post({ headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error, 'cross_site');
  assert.equal((await post({ headers: { Origin: 'https://evil.test' } })).json.error, 'cross_site');
  assert.equal((await post({ headers: { Origin: 'not a url' } })).json.error, 'cross_site');
  assert.equal((await post({ headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } })).status, 201);

  const text = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { headers: { 'Content-Type': 'text/plain' }, rawBody: '{"name":"U"}' });
  assert.equal(text.status, 415);
  assert.equal(text.json.error, 'json_required');
  const missing = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { headers: { 'Content-Type': '' }, rawBody: '{"name":"U"}' });
  assert.equal(missing.status, 415);
  assert.equal((await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, rawBody: '{"name":"V"}' })).status, 201);

  const huge = JSON.stringify({ name: 'x'.repeat(17 * 1024) });
  const tooLarge = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { rawBody: huge });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error, 'too_large');
  const declared = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { rawBody: '{}', headers: { 'Content-Length': '99999' } });
  assert.equal(declared.status, 413);

  for (const rawBody of ['', 'not json', '[1]', '"x"', 'null']) {
    const response = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, undefined, { rawBody });
    assert.equal(response.status, 400, rawBody);
    assert.equal(response.json.error, 'bad_request');
  }
  // Checks run before the session: a cross-site request from a signed-out browser is still cross_site.
  assert.equal((await s.w.call(newJar(), 'POST', '/auth/logout', {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).json.error, 'cross_site');
  assert.equal((await s.w.call(newJar(), 'POST', '/auth/logout', {})).status, 401);
});

check('rate limit: 60 writes a minute per user, then 429 + Retry-After; resets next window; GETs are not counted; fails open', async () => {
  const s = await scenario();
  const patch = (jar) => s.w.call(jar, 'PATCH', '/auth/prefs', { sidebarCollapsed: true });
  for (let i = 0; i < 60; i++) assert.equal((await patch(s.jars.erin)).status, 200, `request ${i + 1}`);
  const limited = await patch(s.jars.erin);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert(Number(limited.headers.get('Retry-After')) >= 1 && Number(limited.headers.get('Retry-After')) <= 60);
  assert.equal(limited.json.retryAfter, Number(limited.headers.get('Retry-After')));
  assert.equal((await s.w.call(s.jars.erin, 'GET', '/auth/me')).status, 200, 'reads are not limited');
  assert.equal((await patch(s.jars.bob)).status, 200, 'per user');
  s.w.advance(60 * 1000);
  assert.equal((await patch(s.jars.erin)).status, 200, 'a new window');
  const [row] = await s.w.rows('SELECT key FROM rate_limits WHERE key = ?', `w:${s.ids.erin}`);
  assert.equal(row.key, `w:${s.ids.erin}`);
  assert(!(await s.w.rows('SELECT key FROM rate_limits')).some((entry) => /\d+\.\d+\.\d+\.\d+/.test(entry.key)), 'no IP addresses');

  const realPrepare = s.w.db.prepare.bind(s.w.db);
  s.w.db.prepare = (sql) => {
    if (sql.includes('rate_limits')) throw new Error('D1 is down');
    return realPrepare(sql);
  };
  for (let i = 0; i < 70; i++) assert.equal((await patch(s.jars.erin)).status, 200, 'fails open');
  s.w.db.prepare = realPrepare;
});

check('responses: a catch-all 500 never echoes the error; every response has the security headers; 404/405 are JSON', async () => {
  const s = await scenario();
  const responses = [];
  const collect = async (promise) => { const r = await promise; responses.push(r.response || r); return r; };

  await collect(s.w.call(s.alice, 'GET', s.guildPath));
  await collect(s.w.call(newJar(), 'GET', '/auth/me'));
  await collect(s.w.call(s.alice, 'GET', '/api/guild/not-found-here/x'));
  const missing = await collect(s.w.call(s.alice, 'GET', '/auth/nothing'));
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'not_found');
  const wrongMethod = await collect(s.w.call(s.alice, 'DELETE', `${s.guildPath}`, {}));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error, 'method_not_allowed');
  assert.equal(wrongMethod.headers.get('Allow'), 'GET');
  responses.push(await s.w.req('GET', '/auth/login'));
  responses.push(await s.w.req('GET', '/auth/callback?state=x'));

  const realPrepare = s.w.db.prepare.bind(s.w.db);
  s.w.db.prepare = (sql) => {
    if (sql.includes('FROM guilds WHERE id = ?')) throw new Error('SECRET-DB-INFO table guilds');
    return realPrepare(sql);
  };
  const boom = await collect(s.w.call(s.alice, 'GET', s.guildPath));
  s.w.db.prepare = realPrepare;
  assert.equal(boom.status, 500);
  assert.deepEqual(Object.keys(boom.json).sort(), ['error', 'message']);
  assert.equal(boom.json.error, 'server_error');
  assert(!JSON.stringify(boom.json).includes('SECRET'));
  assert(s.w.logs.some((line) => line.includes('SECRET-DB-INFO')), 'logged server side only');

  const limited = [];
  for (let i = 0; i < 61; i++) limited.push(await s.w.req('PATCH', '/auth/prefs', { jar: s.jars.carol, body: { sidebarCollapsed: true } }));
  responses.push(limited[60]);
  assert.equal(limited[60].status, 429);

  for (const response of responses) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Content-Security-Policy'), CSP);
  }
  assert(responses.length >= 9);
});

check('people: response contract (signedInCount, people, roster null, removed) and default ordering', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.teamId] });
  await s.w.call(s.alice, 'POST', `${s.peoplePath('erin')}/block`, { reason: 'no show' });
  const response = await s.w.call(s.alice, 'GET', `${s.guildPath}/people`);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['people', 'removed', 'signedInCount']);
  assert.equal(response.json.signedInCount, 4);
  assert.deepEqual(response.json.people.map((entry) => entry.person.username), ['alice', 'bob', 'carol', 'dave']);
  const first = response.json.people[0];
  assert.deepEqual(Object.keys(first).sort(), ['actions', 'isMe', 'lastSeenAt', 'person', 'roles', 'roster']);
  assert.equal(first.roster, null);
  assert.equal(typeof first.lastSeenAt, 'number');
  assert.deepEqual(Object.keys(first.person).sort(), ['avatarUrl', 'displayName', 'id', 'initials', 'username']);
  assert.equal(first.person.displayName, 'Alice A');
  assert.equal(first.person.initials, 'AA');
  assert.equal(response.json.people[1].person.initials, 'BO');
  const [removed] = response.json.removed;
  assert.deepEqual(Object.keys(removed).sort(), ['actions', 'person', 'reason', 'removedAt', 'removedBy', 'roles']);
  assert.equal(removed.removedBy.username, 'alice');
  assert.equal(removed.reason, 'no show');
  assert(!JSON.stringify(response.json).match(/"1001"|"1002"/), 'no Discord ids');
});

// ---------------------------------------------------------------------------
// Fix round 1: security review decisions

// Runs `interleave()` right before the first db.batch that holds a statement matching `re`
// (a concurrent request landing between a handler's reads and its write batch).
function hookBatch(db, re, interleave) {
  const real = db.batch.bind(db);
  let done = false;
  db.batch = async (statements) => {
    if (!done && statements.some((statement) => re.test(statement.sql))) {
      done = true;
      interleave();
    }
    return real(statements);
  };
}

check('d1 fake: meta.changes counts the statement\'s own rows, not foreign-key cascades, and is 0 after a read', async () => {
  const s = await scenario();
  const { db } = s.w;
  assert(await s.w.count('teams') >= 1 && await s.w.count('role_assignments') >= 1, 'the guild has children');
  const removal = await db.prepare('DELETE FROM guilds WHERE id = ?').bind(s.guildId).run();
  assert.equal(removal.meta.changes, 1, 'the cascade through teams, roles and audit rows is not counted');
  assert.equal(await s.w.count('teams'), 0);
  const read = await db.prepare('SELECT 1 AS one').all();
  assert.equal(read.meta.changes, 0, 'changes() is stale after a SELECT; the fake reports 0');
});

check('callback: a state the Worker did not sign is rejected before any Discord call (matching cookie or not)', async () => {
  const w = await makeWorld();
  const other = await makeWorld({ env: { DISCORD_CLIENT_SECRET: 'another-secret' } });
  const foreign = new URL((await other.req('GET', '/auth/login')).headers.get('Location')).searchParams.get('state');
  const mine = new URL((await w.req('GET', '/auth/login')).headers.get('Location')).searchParams.get('state');
  const [nonce] = mine.split('.');
  const forged = ['aaaa', `${nonce}.${'x'.repeat(43)}`, `${nonce}.`, `${nonce}.${mine.split('.')[1]}.extra`, foreign];
  for (const state of forged) {
    const jar = { '__Host-rs_state': state };
    const response = await w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
    assert.equal(response.headers.get('Location'), '/#/signin?error=state', state);
  }
  assert.equal(w.discord.calls.length, 0, 'not one outbound Discord request for any forged state');
  w.discord.next = { user: { id: '1', username: 'x' }, servers: [] };
  const ok = await w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(mine)}`, { jar: { '__Host-rs_state': mine } });
  assert.equal(ok.headers.get('Location'), '/#/', 'the genuine state still works');
});

check('the creator\'s server list never outlives 30 minutes: dropped on the next request and purged at any sign-in', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = (await signIn(w, PEOPLE.alice, [manageable(SERVER_A)])).jar;
  w.advance(30 * 60 * 1000 + 1);
  await signIn(w, PEOPLE.bob, []);
  assert.equal(await w.count('sessions', 'manageable_servers IS NOT NULL'), 0, 'the callback batch purged it');

  await signIn(w, PEOPLE.alice, [manageable(SERVER_A)], alice);
  assert.equal(await w.count('sessions', 'manageable_servers IS NOT NULL'), 1);
  w.advance(31 * 60 * 1000);
  const me = await w.call(alice, 'GET', '/auth/me');
  assert.equal(me.json.create.stale, true);
  assert.equal(await w.count('sessions', 'manageable_servers IS NOT NULL'), 0, 'loadSession dropped it');
});

check('permissions: requireAction passes only for "guild" or a non-empty list of team ids', async () => {
  const { requireAction, requireAnyAction } = await load('worker/permissions.js');
  const context = (can) => ({ can });
  assert.throws(() => requireAction(context({ 'attendance.view': [] }), 'attendance.view'), (error) => error.status === 403 && error.code === 'forbidden');
  assert.throws(() => requireAction(context({}), 'attendance.view'), (error) => error.status === 403);
  requireAction(context({ 'attendance.view': 'guild' }), 'attendance.view');
  requireAction(context({ 'attendance.view': ['t_AAAAAAAAAAAAAAAAAAAAAA'] }), 'attendance.view');
  assert.throws(() => requireAnyAction(context({ a: [], b: undefined }), ['a', 'b']), (error) => error.status === 403);
  requireAnyAction(context({ a: [], b: 'guild' }), ['a', 'b']);
});

check('isUniqueViolation reads error.message and error.cause.message', async () => {
  const { isUniqueViolation } = await load('worker/http.js');
  assert(isUniqueViolation(new Error('D1_ERROR: UNIQUE constraint failed: teams.id')));
  assert(isUniqueViolation(new Error('D1_ERROR: Failed query', { cause: new Error('UNIQUE constraint failed: teams.id: SQLITE_CONSTRAINT') })));
  assert(!isUniqueViolation(new Error('D1_ERROR: other', { cause: new Error('FOREIGN KEY constraint failed') })));
  assert(!isUniqueViolation(null) && !isUniqueViolation(undefined) && !isUniqueViolation({}));
});

check('callback: Discord failures are logged by message, never with the code, token or secret', async () => {
  const w = await makeWorld();
  w.discord.failToken = true;
  const jar = newJar();
  const state = new URL((await w.req('GET', '/auth/login', { jar })).headers.get('Location')).searchParams.get('state');
  const failed = await w.req('GET', `/auth/callback?code=SECRETCODE&state=${encodeURIComponent(state)}`, { jar });
  assert.equal(failed.headers.get('Location'), '/#/signin?error=discord');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /token exchange failed/);
  assert(!/SECRETCODE|client-secret|tok\d/.test(w.logs[0]), w.logs[0]);
});

check('create guild: the time zone is an IANA name, stored in canonical form', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const { jar } = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  for (const bad of ['+05:00', 'America/../x', 'Not/AZone', '', 'a'.repeat(65), 'America/New York', '../etc', 5, null]) {
    const response = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, timeZone: bad });
    assert.equal(response.status, 400, String(bad));
    assert.equal(response.json.field, 'timeZone');
  }
  const created = await w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, timeZone: 'america/new_york' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.guild.timeZone, 'America/New_York');
  assert.equal((await w.rows('SELECT time_zone FROM guilds'))[0].time_zone, 'America/New_York');
});

check('teams: at most 50 active teams per guild (create and restore); archived teams do not count', async () => {
  const s = await scenario();
  const now = Date.now();
  for (let i = 0; i < 49; i++) {
    s.w.db.sqlite.exec(`INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t_cap${String(i).padStart(18, '0')}', '${s.guildId}', 'Filler ${i}', 25, 0, ${now})`);
  }
  assert.equal(await s.w.count('teams', 'guild_id = ? AND archived = 0', s.guildId), 50);
  const over = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'One too many' });
  assert.equal(over.status, 400);
  assert.equal(over.json.error, 'bad_request');
  assert.equal(over.json.field, 'name');
  assert.equal(await s.w.count('teams', 'guild_id = ?', s.guildId), 50);
  assert.equal(await s.w.count('audit_log', "action = 'team.create'"), 0, 'no audit row for a refused team');

  assert.equal((await s.w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${s.teamId}`, { archived: true })).status, 200);
  const created = await s.w.call(s.alice, 'POST', `${s.guildPath}/teams`, { name: 'Fits now' });
  assert.equal(created.status, 201);
  const restore = await s.w.call(s.alice, 'PATCH', `${s.guildPath}/teams/${s.teamId}`, { archived: false });
  assert.equal(restore.status, 400, 'restoring would make 51');
  assert.equal(restore.json.field, 'name');
});

check('B9: the session is checked before route parameters, so a malformed id signed out is 401', async () => {
  const s = await scenario();
  const { w } = s;
  for (const [method, route] of [
    ['GET', '/api/guild/not-an-id'], ['GET', '/api/guild/not-an-id/people'], ['POST', '/api/guild/x/teams'],
    ['PATCH', '/api/guild/x/teams/y'], ['PUT', '/api/guild/x/people/y/roles'], ['POST', '/api/guild/x/claim'],
  ]) {
    const response = await w.call(newJar(), method, route, method === 'GET' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${route}`);
    assert.equal(response.json.error, 'signed_out');
  }
  const signedIn = await w.call(s.alice, 'GET', '/api/guild/not-an-id');
  assert.equal(signedIn.status, 404, 'signed in, the malformed id is a plain 404');
  assert.equal((await w.call(s.alice, 'PATCH', `${s.guildPath}/teams/zzz`, { name: 'x' })).status, 404);
  assert.equal((await w.call(newJar(), 'GET', '/api/nothing/here')).status, 404, 'an unknown route is still 404');
});

check('set roles: roles can be removed from anyone who holds one (left the server, blocked); grants still need a current member', async () => {
  const s = await scenario();
  await s.setRoles('carol', { officer: true, teamLeadTeamIds: [s.teamId] });
  await signIn(s.w, PEOPLE.carol, [], s.jars.carol); // carol left the Discord server
  const grant = await s.setRoles('carol', { officer: true, teamLeadTeamIds: [] });
  assert.equal(grant.status, 200, 'dropping the team lead role is a demotion');
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'team_lead'", s.ids.carol), 0);
  const regrant = await s.setRoles('carol', { officer: true, teamLeadTeamIds: [s.teamId] });
  assert.equal(regrant.status, 404, 'a grant to someone who left is refused');
  const demote = await s.setRoles('carol', { officer: false, teamLeadTeamIds: [] });
  assert.equal(demote.status, 200, JSON.stringify(demote.json));
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.carol), 0);
  assert.equal(await s.w.count('audit_log', "action = 'roles.set'"), 3);

  await s.setRoles('dave', { officer: true, teamLeadTeamIds: [s.teamId] });
  await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, {});
  assert.equal((await s.setRoles('dave', { officer: true, teamLeadTeamIds: [s.teamId, s.teamId] })).status, 200, 'no change is a no-op');
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [s.teamId] })).status, 200, 'officer removed while blocked');
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [] })).status, 200);
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.dave), 0);
  assert.equal((await s.setRoles('erin', { officer: false, teamLeadTeamIds: [] })).status, 200, 'nothing to change for a current member');
  await signIn(s.w, PEOPLE.erin, [], s.jars.erin);
  assert.equal((await s.setRoles('erin', { officer: false, teamLeadTeamIds: [] })).status, 404, 'no role, not a member: not found');
});

check('races: a concurrent duplicate grant answers with the fresh people list, not a 500', async () => {
  const s = await scenario();
  hookBatch(s.w.db, /INSERT INTO audit_log/, () => {
    s.w.db.sqlite.exec(`INSERT INTO role_assignments VALUES ('ra_race','${s.guildId}','${s.ids.carol}','officer',NULL,NULL,1)`);
  });
  const response = await s.setRoles('carol', { officer: true, teamLeadTeamIds: [] });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json.people.find((entry) => entry.person.username === 'carol').roles, [{ role: 'officer' }]);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer'", s.ids.carol), 1);
});

check('races: set roles by someone who stopped being Guild Master mid-request writes nothing (409 conflict)', async () => {
  const s = await scenario();
  hookBatch(s.w.db, /INSERT INTO audit_log/, () => {
    s.w.db.sqlite.exec(`UPDATE role_assignments SET user_id = '${s.ids.bob}' WHERE role_id = 'guild_master' AND guild_id = '${s.guildId}';
                        INSERT INTO role_assignments VALUES ('ra_z','${s.guildId}','${s.ids.alice}','officer',NULL,NULL,1)`);
  });
  const response = await s.setRoles('carol', { officer: true, teamLeadTeamIds: [] });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'conflict');
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.carol), 0);
  assert.equal(await s.w.count('audit_log', "action = 'roles.set'"), 0);
});

check('races: an Officer cannot remove access from someone who became an Officer mid-request, or after losing their own role', async () => {
  const s = await scenario();
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  hookBatch(s.w.db, /INSERT INTO guild_blocks/, () => {
    s.w.db.sqlite.exec(`INSERT INTO role_assignments VALUES ('ra_y','${s.guildId}','${s.ids.carol}','officer',NULL,NULL,1)`);
  });
  const raced = await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('carol')}/block`, { reason: '' });
  assert.equal(raced.status, 409);
  assert.equal(raced.json.error, 'conflict');
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal(await s.w.count('audit_log', "action = 'access.remove'"), 0);

  hookBatch(s.w.db, /INSERT INTO guild_blocks/, () => {
    s.w.db.sqlite.exec(`DELETE FROM role_assignments WHERE user_id = '${s.ids.bob}'`);
  });
  const demoted = await s.w.call(s.jars.bob, 'POST', `${s.peoplePath('dave')}/block`, {});
  assert.equal(demoted.status, 409, 'bob lost the Officer role between the check and the write');
  assert.equal(await s.w.count('guild_blocks'), 0);

  // Restore access carries the same guards.
  await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] });
  await s.w.call(s.alice, 'POST', `${s.peoplePath('erin')}/block`, {});
  hookBatch(s.w.db, /INSERT INTO audit_log/, () => {
    s.w.db.sqlite.exec(`DELETE FROM role_assignments WHERE user_id = '${s.ids.bob}'`);
  });
  const restore = await s.w.call(s.jars.bob, 'DELETE', `${s.peoplePath('erin')}/block`, {});
  assert.equal(restore.status, 409);
  assert.equal(await s.w.count('guild_blocks'), 1, 'the block is still there');
  assert.equal(await s.w.count('audit_log', "action = 'access.restore'"), 0);
});

check('races: Delete my data does not delete a guild that someone joined after the impact check', async () => {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = (await signIn(w, PEOPLE.alice, [manageable(SERVER_A)])).jar;
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  const ids = (await w.call(alice, 'GET', '/auth/me')).json.deleteImpact.guildsDeleted.map((entry) => entry.id);
  assert.deepEqual(ids, [created.json.guild.id]);
  hookBatch(w.db, /DELETE FROM guilds/, () => {
    w.db.sqlite.exec(`INSERT INTO users (id, account_key, discord_id, username, prefs, created_at, last_seen_at) VALUES ('u_joiner','u_joiner','1002','bob','{}',1,1);
                      INSERT INTO user_servers VALUES ('u_joiner','${SERVER_A}',1)`);
  });
  const del = await w.call(alice, 'DELETE', '/auth/me', { deleteGuildIds: ids });
  assert.equal(del.status, 200);
  assert.equal(await w.count('guilds'), 1, 'the guild survives: a member joined');
  assert.equal(await w.count('audit_log', "action = 'guild.delete'"), 0, 'and no guild.delete row was written');
  assert.equal(await w.count('user_servers', 'user_id = ?', 'u_joiner'), 1, 'the joiner keeps their membership');
  assert.equal(await w.count('audit_log', "action = 'account.delete'"), 1);
});

check('delete my data: a deleted guild takes the server memberships (blocked people too) with it', async () => {
  const s = await scenario();
  for (const name of ['bob', 'carol', 'dave', 'erin']) await s.w.call(s.alice, 'POST', `${s.peoplePath(name)}/block`, { reason: 'x' });
  const impact = (await s.w.call(s.alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual(impact.guildsDeleted, [{ id: s.guildId, name: 'Ember' }]);
  const del = await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [s.guildId] });
  assert.equal(del.status, 200);
  assert.equal(await s.w.count('guilds'), 0);
  assert.equal(await s.w.count('user_servers'), 0, 'no stale membership rows for a server without a guild');
  const frank = (await signIn(s.w, PEOPLE.frank, [manageable(SERVER_A)])).jar;
  const again = await s.w.call(frank, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(again.status, 201);
  const bob = await s.w.call(s.jars.bob, 'GET', `/api/guild/${again.json.guild.id}`);
  assert.equal(bob.status, 403, 'bob is not a member of the new guild until he signs in again');
  assert.equal(bob.json.error, 'not_member');
});

// A guild whose Guild Master left the Discord server, with Officers in a known order:
// erin (earliest, left the server), dave (blocked), carol (the expected successor), bob.
async function departedMasterScenario() {
  const s = await scenario();
  const grant = async (name) => { s.w.advance(1000); assert.equal((await s.setRoles(name, { officer: true, teamLeadTeamIds: [] })).status, 200); };
  await grant('erin');
  await grant('dave');
  await grant('carol');
  await grant('bob');
  assert.equal((await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, {})).status, 200);
  await signIn(s.w, PEOPLE.erin, [], s.jars.erin);
  await signIn(s.w, PEOPLE.alice, [], s.alice); // the Guild Master left the Discord server
  return s;
}

check('delete my data: a departed Guild Master is not blocked; the earliest current, unblocked Officer is promoted, as predicted', async () => {
  const s = await departedMasterScenario();
  const impact = (await s.w.call(s.alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual(impact.handOverFirst, [], 'a departed Guild Master need not hand over');
  assert.deepEqual(impact.guildsDeleted, []);
  assert.equal(impact.autoPromote.length, 1);
  assert.deepEqual(Object.keys(impact.autoPromote[0]).sort(), ['id', 'name', 'to']);
  assert.equal(impact.autoPromote[0].id, s.guildId);
  assert.equal(impact.autoPromote[0].to.id, s.ids.carol, 'erin left, dave is blocked: carol is next');
  assert.deepEqual(Object.keys(impact.autoPromote[0].to).sort(), ['avatarUrl', 'displayName', 'id', 'initials', 'username']);

  const del = await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const masters = await s.w.rows("SELECT user_id, assigned_by FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.guildId);
  assert.deepEqual(masters.map((row) => row.user_id), [impact.autoPromote[0].to.id], 'the batch did what the impact predicted');
  assert.equal(masters[0].assigned_by, null);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer'", s.ids.carol), 0, 'the new Guild Master drops the Officer row');
  assert.equal(await s.w.count('role_assignments', "role_id = 'officer'"), 3, 'the others keep theirs');
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.alice), 0);
  const [audit] = await s.w.rows("SELECT guild_id, actor_user_id, entity_id, before, after FROM audit_log WHERE action = 'guild_master.auto_promote'");
  assert.equal(audit.guild_id, s.guildId);
  assert.equal(audit.entity_id, s.guildId);
  assert.deepEqual(JSON.parse(audit.after), { guildMasterUserId: s.ids.carol });
  assert(!/alice|carol|bob/.test(`${audit.before}${audit.after}`.replace(/u_[A-Za-z0-9_-]{22}/g, '')), 'ids only');
  const carol = await s.w.call(s.jars.carol, 'GET', `${s.guildPath}/people`);
  assert.equal(carol.status, 200);
  assert.deepEqual(carol.json.people.find((entry) => entry.isMe).roles, [{ role: 'guild_master' }]);
});

check('delete my data: with no eligible Officer the guild is left without a Guild Master and can be claimed', async () => {
  const s = await scenario();
  await signIn(s.w, PEOPLE.alice, [], s.alice);
  const impact = (await s.w.call(s.alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual(impact.autoPromote, [{ id: s.guildId, name: 'Ember', to: null }]);
  assert.equal((await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.equal(await s.w.count('role_assignments', "role_id = 'guild_master'"), 0);
  const [audit] = await s.w.rows("SELECT after FROM audit_log WHERE action = 'guild_master.auto_promote'");
  assert.deepEqual(JSON.parse(audit.after), { guildMasterUserId: null });

  const frank = (await signIn(s.w, PEOPLE.frank, [manageable(SERVER_A)])).jar;
  const me = (await s.w.call(frank, 'GET', '/auth/me')).json;
  assert.deepEqual(me.create.claimable, [{ guildId: s.guildId, guildName: 'Ember', serverId: SERVER_A, serverName: 'Server 01' }]);
  assert.deepEqual(me.create.servers, [], 'the server still has a guild, so it is not offered for creation');
});

check('deleteImpact.autoPromote predicts exactly what the batch does (same SQL criteria), across several guild shapes', async () => {
  for (const shape of ['earliest-current', 'only-departed', 'blocked-first', 'tie-on-time']) {
    const s = await scenario();
    const officer = async (name, advance = 1000) => {
      s.w.advance(advance);
      assert.equal((await s.setRoles(name, { officer: true, teamLeadTeamIds: [] })).status, 200);
    };
    if (shape === 'earliest-current') { await officer('bob'); await officer('carol'); }
    if (shape === 'only-departed') { await officer('bob'); await signIn(s.w, PEOPLE.bob, [], s.jars.bob); }
    if (shape === 'blocked-first') {
      await officer('bob'); await officer('carol');
      await s.w.call(s.alice, 'POST', `${s.peoplePath('bob')}/block`, {});
    }
    if (shape === 'tie-on-time') { await officer('bob', 0); await officer('carol', 0); await officer('dave', 0); }
    await signIn(s.w, PEOPLE.alice, [], s.alice);
    const impact = (await s.w.call(s.alice, 'GET', '/auth/me')).json.deleteImpact;
    assert.equal(impact.autoPromote.length, 1, shape);
    const predicted = impact.autoPromote[0].to ? impact.autoPromote[0].to.id : null;
    assert.equal((await s.w.call(s.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200, shape);
    const actual = (await s.w.rows("SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.guildId)).map((row) => row.user_id);
    assert.deepEqual(actual, predicted ? [predicted] : [], shape);
    if (shape === 'earliest-current') assert.equal(predicted, s.ids.bob);
    if (shape === 'blocked-first') assert.equal(predicted, s.ids.carol);
    if (shape === 'only-departed') assert.equal(predicted, null);
  }
});

check('GET /auth/me: removedFrom lists the guilds that blocked the caller, and they are not in guilds', async () => {
  const s = await scenario();
  await s.w.call(s.alice, 'POST', `${s.peoplePath('dave')}/block`, { reason: 'x' });
  const me = (await s.w.call(s.jars.dave, 'GET', '/auth/me')).json;
  assert.deepEqual(me.removedFrom, [{ id: s.guildId, name: 'Ember' }]);
  assert.deepEqual(me.guilds, []);
  assert.deepEqual((await s.w.call(s.jars.bob, 'GET', '/auth/me')).json.removedFrom, []);
});

check('claim: an allowlisted manager takes a guild that has no Guild Master (no membership row needed); every other case is refused', async () => {
  const s = await scenario();
  const { w } = s;
  const claim = (jar, guildId = s.guildId) => w.call(jar, 'POST', `/api/guild/${guildId}/claim`, {});
  const frank = (await signIn(w, PEOPLE.frank, [manageable(SERVER_A)])).jar;
  assert.deepEqual((await w.call(s.alice, 'GET', '/auth/me')).json.create.claimable, [], 'a guild with a Guild Master is not claimable');
  const taken = await claim(frank);
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'conflict');

  w.db.sqlite.exec(`DELETE FROM role_assignments WHERE role_id = 'guild_master'`);
  assert.equal((await claim(s.jars.bob)).json.error, 'not_allowed_to_create');
  const unrelated = (await signIn(w, PEOPLE.frank, [manageable(SERVER_B)], newJar())).jar;
  const outside = await claim(unrelated);
  assert.equal(outside.status, 404, 'the guild\'s server is not in the caller\'s manageable list');
  assert.equal(outside.json.error, 'not_found');
  assert.equal((await claim(frank, 'g_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal(await w.count('role_assignments', "role_id = 'guild_master'"), 0);

  // A blocked person cannot claim.
  w.db.sqlite.exec(`INSERT INTO guild_blocks VALUES ('${s.guildId}', '${(await w.rows('SELECT id FROM users WHERE discord_id = ?', PEOPLE.frank.id))[0].id}', NULL, NULL, 1)`);
  const blocked = await claim(frank);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'access_removed');
  w.db.sqlite.exec('DELETE FROM guild_blocks');

  // A stale list needs a fresh sign-in.
  w.advance(31 * 60 * 1000);
  const stale = await claim(frank);
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error, 'reauth_required');
  const fresh = (await signIn(w, PEOPLE.frank, [manageable(SERVER_A)], frank)).jar;

  // No existing user_servers row: the claim writes it.
  w.db.sqlite.exec('DELETE FROM user_servers WHERE user_id = (SELECT id FROM users WHERE discord_id = \'1006\')');
  assert.equal(await w.count('user_servers', 'user_id = (SELECT id FROM users WHERE discord_id = ?)', PEOPLE.frank.id), 0);
  assert.equal((await w.call(fresh, 'GET', '/auth/me')).json.create.claimable.length, 1);
  const done = await claim(fresh);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(Object.keys(done.json).sort(), ['attendanceFlags', 'guild', 'me', 'rosterFlags', 'rosterOptions', 'teams']);
  assert.deepEqual(done.json.me.roles, [{ role: 'guild_master' }]);
  assert.equal(done.json.me.can['guild.roles'], 'guild');
  assert.equal(await w.count('user_servers', 'user_id = (SELECT id FROM users WHERE discord_id = ?) AND server_id = ?', PEOPLE.frank.id, SERVER_A), 1);
  const [audit] = await w.rows("SELECT guild_id, entity_id, after FROM audit_log WHERE action = 'guild.claim'");
  assert.equal(audit.guild_id, s.guildId);
  const frankId = (await w.rows('SELECT id FROM users WHERE discord_id = ?', PEOPLE.frank.id))[0].id;
  assert.deepEqual(JSON.parse(audit.after), { guildMasterUserId: frankId });
  assert.deepEqual((await w.rows("SELECT user_id FROM role_assignments WHERE role_id = 'guild_master'")).map((row) => row.user_id), [frankId]);
  assert.equal(await w.count('role_assignments', "guild_id = ? AND role_id = 'guild_master'", s.guildId), 1);

  const second = await claim(fresh);
  assert.equal(second.status, 409, 'a second claim finds a Guild Master');
  assert.equal(await w.count('audit_log', "action = 'guild.claim'"), 1);
});

check('claim: a Guild Master who appears between the check and the write wins (guarded INSERT, 409, no side effects)', async () => {
  const s = await scenario();
  s.w.db.sqlite.exec(`DELETE FROM role_assignments WHERE role_id = 'guild_master'`);
  const frank = (await signIn(s.w, PEOPLE.frank, [manageable(SERVER_A)])).jar;
  s.w.db.sqlite.exec(`DELETE FROM user_servers WHERE user_id = (SELECT id FROM users WHERE discord_id = '1006')`);
  hookBatch(s.w.db, /INSERT INTO role_assignments/, () => {
    s.w.db.sqlite.exec(`INSERT INTO role_assignments VALUES ('ra_late','${s.guildId}','${s.ids.bob}','guild_master',NULL,NULL,1)`);
  });
  const lost = await s.w.call(frank, 'POST', `${s.guildPath}/claim`, {});
  assert.equal(lost.status, 409);
  assert.equal(lost.json.error, 'conflict');
  assert.deepEqual((await s.w.rows("SELECT user_id FROM role_assignments WHERE role_id = 'guild_master'")).map((row) => row.user_id), [s.ids.bob]);
  assert.equal(await s.w.count('user_servers', 'user_id = (SELECT id FROM users WHERE discord_id = ?)', PEOPLE.frank.id), 0, 'no membership row for the loser');
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim'"), 0);
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
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
