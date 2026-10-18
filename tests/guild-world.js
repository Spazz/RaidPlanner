// A small world for the Phase 8 suites (guild-guilds-worker-tests.js, guild-isolation-tests.js): the Worker over the node:sqlite D1 stand-in, Discord
// faked by an injected fetch, cookie jars, and sign-in helpers. Nothing here touches the network or a real database.
//   makeWorld({ allowlist, env, routes })  allowlist: array of Discord ids (omit it for NO allowlist: creation is open to server administrators);
//                                          routes: replaces worker/index.js ROUTES (the isolation suite's leaky canary)
//   world.call(jar, method, path, body)    -> { status, json, text, headers }   world.rows(sql, ...values)   world.count(table, where, ...values)
//   signIn(world, person, servers, jar)    Discord sign-in through the fake; the jar then carries the session cookie
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./d1-fake');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';

// A Discord guilds-list entry. permissions is the bit field as a decimal string: 8 = Administrator, 32 = Manage Server, 0 = a plain member.
const server = (id, { name = `Server ${id.slice(-2)}`, owner = false, permissions = '0' } = {}) => ({ id, name, icon: null, owner, permissions });
const adminOf = (id, extra = {}) => server(id, { permissions: '8', ...extra });
const memberOf = (id, extra = {}) => server(id, extra);

function makeDiscord() {
  const state = { next: null, calls: [], tokens: new Map() };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    state.calls.push({ url: String(url), method: init.method || 'GET' });
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${state.calls.length}`;
      state.tokens.set(token, state.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '');
    const session = bearer && state.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  return state;
}

const newJar = () => ({});
function absorbCookies(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}

async function makeWorld({ allowlist, env = {}, routes } = {}) {
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
    ...(allowlist === undefined ? {} : { GUILD_CREATOR_ALLOWLIST: allowlist.join(',') }),
    ...env,
  };
  const app = createApp({ db, env: fullEnv, fetch: discord.fetch, now: () => clock.now, randomBytes, log: (message) => logs.push(message), routes });
  const world = {
    db, discord, clock, logs, env: fullEnv,
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
      const text = await response.clone().text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text, headers: response.headers, response };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) {
      return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
    },
    // Every table with a column of this name, for "nothing of this guild is left" checks.
    tablesWithColumn(column) {
      return db.sqlite.prepare("SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = ? ORDER BY m.name")
        .all(column).map((row) => row.name);
    },
  };
  return world;
}

// person: { id, username, globalName }; servers: the Discord guilds list the fake returns for this sign-in.
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

const person = (n, name) => ({ id: String(2000 + n), username: name.toLowerCase(), globalName: name });

module.exports = { ORIGIN, ROOT, load, server, adminOf, memberOf, makeWorld, signIn, newJar, absorbCookies, person };
