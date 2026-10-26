/**
 * Raidsmith guild tracker - lane B6a of the user-hierarchy build: OAuth state hardening and the Battle.net callback limits
 * (worker/session.js, worker/routes/auth.js, worker/routes/bnet.js, worker/ratelimit.js, worker/retention.js)
 * Run: node tests/guild/guild-b6a-oauth-tests.js
 *
 *   - every MAC'd state (Discord sign-in, Discord link, Battle.net link, Battle.net sign-in) carries its issue time inside the MAC: older than 10 minutes, or dated
 *     more than a minute ahead, is refused like a bad MAC, at every callback, before any outbound call;
 *   - single use: the callback claims the state's nonce (SHA-256 in oauth_state_nonces) after the MAC and age checks and before the code exchange; a replay is
 *     refused with no outbound call, two parallel callbacks with one state let exactly one through, the begin routes write nothing;
 *   - "fresh." is its own mode in both mode functions (lane B6b part 2a builds the flow on it: tests/guild/guild-b6b2-fresh-tests.js); a forged one is refused by both callbacks
 *     and it is never taken for a link or a sign-in;
 *   - a link state is still bound to the member who started it;
 *   - Battle.net callbacks: per Blizzard account id 10 per 10 minutes ('busy', after the exchange and before the snapshot fan-out), and a global budget of 300
 *     per 10 minutes that never refuses and logs one ALARM line per window;
 *   - the nonce retention TTL covers the validity window; Delete my data sweeps the account's bnetcb key.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { createFakeBattlenet } = require('../../tools/fake-battlenet');

const ROOT = path.join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const MINUTE = 60 * 1000;
const TTL = 10 * MINUTE;
const SKEW = MINUTE;
const T0 = 1_800_000_000_000;

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
};
const BNET = {
  erin: { id: '500000005', battletag: 'Erin#0005' },
  holly: { id: '700000001', battletag: 'Holly#1111' },
  ivan: { id: '700000002', battletag: 'Ivan#2222' },
};
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false, teamNames: ['Alpha'] };
const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });

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

async function makeWorld({ allowlist = [] } = {}) {
  const { createApp } = await load('worker/index.js');
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  const db = createD1Fake();
  const discord = makeDiscord();
  const bnet = createFakeBattlenet();
  await new Promise((resolve) => bnet.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bnet.server.address().port}`;
  const clock = { now: T0 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: allowlist.join(','),
    BNET_CLIENT_ID: 'bnet-id',
    BNET_CLIENT_SECRET: 'bnet-secret',
    BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`,
    BNET_API_BASE: base,
  };
  const fetchRouter = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return fetch(url, init);
    return discord.fetch(url, init);
  };
  const logs = [];
  const app = createApp({ db, env, fetch: fetchRouter, now: () => clock.now, randomBytes, log: (message) => logs.push(message) });
  const world = {
    db, discord, bnet, clock, env, logs, app,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body } = {}) {
      const init = { method, headers: {} };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${ORIGIN}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      return response;
    },
    async call(jar, method, urlPath, body) {
      const response = await world.req(method, urlPath, { jar, body });
      let json = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) { return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n; },
    asked(pathPrefix) { return bnet.state.requests.filter((r) => !pathPrefix || r.path.startsWith(pathPrefix)); },
    async bucket(key) { const [row] = await world.rows('SELECT count, window_start FROM rate_limits WHERE key = ?', key); return row || null; },
  };
  openWorlds.push(world);
  // Identity-change protection (lane B6b part 2a): this suite links and unlinks as a staff account without being about fresh-auth, so such requests get their grant first.
  return require('../guild-auto-fresh').autoFresh(world);
}

async function closeWorlds() {
  while (openWorlds.length) {
    const world = openWorlds.pop();
    const closed = new Promise((resolve) => world.bnet.server.close(resolve));
    world.bnet.server.closeAllConnections();
    await closed;
  }
}

const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');
const locationOf = (response) => response.headers.get('Location');
const sessionCookieOf = (response) => response.headers.getSetCookie().find((line) => line.startsWith('__Host-rs_session=') && !/Max-Age=0/.test(line));

async function discordSignIn(world, person, servers = [], jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  const callback = await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.equal(locationOf(callback), '/#/', 'the sign-in worked');
  return jar;
}

async function bnetSignIn(world, account, jar = {}) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { jar, login, callback };
}

async function bnetLink(world, jar, account) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login', { jar });
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { login, callback };
}

// The four flows with the same handles, so each rule is run against every one. A "link" flow needs a signed-in member's jar; a sign-in flow needs none.
// sign(nonce, issuedAt) mints a state the way the Worker does (for the member alice, where the flow is bound to one) with an issue time the test picks.
async function flowsOf(world) {
  const session = await load('worker/session.js');
  const alice = await discordSignIn(world, PEOPLE.alice);
  const bob = await discordSignIn(world, PEOPLE.bob);
  const aliceId = (await world.call(alice, 'GET', '/auth/me')).json.user.id;
  const bobId = (await world.call(bob, 'GET', '/auth/me')).json.user.id;
  const discordCalls = () => world.discord.calls.length;
  const bnetCalls = () => world.bnet.state.requests.length;
  const discordNext = (person) => { world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers: [] }; };
  const list = [
    {
      name: 'Discord sign-in', link: false, cookie: '__Host-rs_state', ok: '/#/', failTo: '/#/signin?error=state', calls: discordCalls,
      begin: (jar) => world.req('GET', '/auth/login', { jar }),
      callback: (state, jar) => { discordNext(PEOPLE.carol); return world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar }); },
      sign: (nonce, issuedAt) => session.signState(world.env, nonce, issuedAt),
    },
    {
      name: 'Discord link', link: true, cookie: '__Host-rs_state', ok: '/#/linked', failTo: '/#/linked?error=state', calls: discordCalls,
      begin: (jar) => world.req('GET', '/auth/login?mode=link', { jar }),
      callback: (state, jar) => { discordNext(PEOPLE.alice); return world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar }); },
      sign: (nonce, issuedAt) => session.signDiscordLinkState(world.env, aliceId, nonce, issuedAt),
    },
    {
      name: 'Battle.net link', link: true, cookie: '__Host-rs_bnet_state', ok: '/#/characters', failTo: '/#/linked?error=state', calls: bnetCalls,
      begin: (jar) => world.req('GET', '/auth/bnet/login', { jar }),
      callback: (state, jar) => { world.bnet.state.account = BNET.holly; return world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar }); },
      sign: (nonce, issuedAt) => session.signBnetState(world.env, aliceId, nonce, issuedAt),
    },
    {
      name: 'Battle.net sign-in', link: false, cookie: '__Host-rs_bnet_state', ok: '/#/', failTo: '/#/signin?error=state', calls: bnetCalls,
      begin: (jar) => world.req('GET', '/auth/bnet/login?mode=signin', { jar }),
      callback: (state, jar) => { world.bnet.state.account = BNET.ivan; return world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar }); },
      sign: (nonce, issuedAt) => session.signBnetSigninState(world.env, nonce, issuedAt),
    },
  ];
  // Battle.net link as alice would fail once (a second link of another account is refused); the flow only has to get PAST the state checks.
  const jarOf = (flow, who = alice) => (flow.link ? { ...who } : {});
  return { session, alice, bob, aliceId, bobId, list, jarOf };
}

let craftedCounter = 0;
const craftedNonce = () => `C${String(++craftedCounter).padStart(21, '0')}`;

// ---------------------------------------------------------------------------
// The state itself

check('state format: <nonce>.<issued ms>.<mac> behind a mode prefix, a distinct MAC key per mode, the user bound where it should be', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  const { session } = x;
  const env = w.env;
  const now = T0;
  const nonce = 'A'.repeat(22);
  const signed = {
    dSign: await session.signState(env, nonce, now),
    dLink: await session.signDiscordLinkState(env, x.aliceId, nonce, now),
    bLink: await session.signBnetState(env, x.aliceId, nonce, now),
    bSign: await session.signBnetSigninState(env, nonce, now),
  };
  assert.match(signed.dSign, new RegExp(`^${nonce}\\.${now}\\.[A-Za-z0-9_-]{43}$`));
  assert.match(signed.dLink, new RegExp(`^link\\.${nonce}\\.${now}\\.[A-Za-z0-9_-]{43}$`));
  assert.match(signed.bLink, new RegExp(`^${nonce}\\.${now}\\.[A-Za-z0-9_-]{43}$`));
  assert.match(signed.bSign, new RegExp(`^signin\\.${nonce}\\.${now}\\.[A-Za-z0-9_-]{43}$`));
  // Each state verifies in its own mode and in no other, even with the same nonce, time and member.
  const verifiers = {
    dSign: (state, at = now) => session.verifyState(env, state, at),
    dLink: (state, at = now) => session.verifyDiscordLinkState(env, x.aliceId, state, at),
    bLink: (state, at = now) => session.verifyBnetState(env, x.aliceId, state, at),
    bSign: (state, at = now) => session.verifyBnetSigninState(env, state, at),
  };
  for (const [made, state] of Object.entries(signed)) {
    for (const [by, verify] of Object.entries(verifiers)) assert.equal(await verify(state), made === by, `${made} verified by ${by}`);
  }
  // The user binding: another member's id does not verify a link state.
  assert.equal(await session.verifyDiscordLinkState(env, x.aliceId, signed.dLink, now), true);
  assert.equal(await session.verifyDiscordLinkState(env, 'u_someoneelse', signed.dLink, now), false);
  assert.equal(await session.verifyBnetState(env, 'u_someoneelse', signed.bLink, now), false);
  assert.equal(await session.verifyBnetState(env, undefined, signed.bLink, now), false);
  // Another secret does not verify either.
  assert.equal(await session.verifyState({ ...env, DISCORD_CLIENT_SECRET: 'other' }, signed.dSign, now), false);
  assert.equal(await session.verifyBnetSigninState({ ...env, BNET_CLIENT_SECRET: '' }, signed.bSign, now), false);
  // Signing refuses an issue time that is not a millisecond timestamp.
  await assert.rejects(async () => session.signState(env, nonce, undefined), TypeError);
  await assert.rejects(async () => session.signBnetSigninState(env, nonce, 'now'), TypeError);
  await assert.rejects(async () => session.signBnetSigninState(env, nonce, -1), TypeError);
  assert.throws(() => session.signBnetState(env, undefined, nonce, now), TypeError, 'a link state needs its user');
});

check('state age: good for 10 minutes after the issue time and not more than a minute before it; older, further ahead, tampered or no clock is refused', async () => {
  const w = await makeWorld();
  const { session, aliceId } = await flowsOf(w);
  const env = w.env;
  const nonce = 'B'.repeat(22);
  const issued = T0;
  const makers = {
    'Discord sign-in': [(at) => session.signState(env, nonce, at), (state, at) => session.verifyState(env, state, at)],
    'Discord link': [(at) => session.signDiscordLinkState(env, aliceId, nonce, at), (state, at) => session.verifyDiscordLinkState(env, aliceId, state, at)],
    'Battle.net link': [(at) => session.signBnetState(env, aliceId, nonce, at), (state, at) => session.verifyBnetState(env, aliceId, state, at)],
    'Battle.net sign-in': [(at) => session.signBnetSigninState(env, nonce, at), (state, at) => session.verifyBnetSigninState(env, state, at)],
  };
  for (const [name, [sign, verify]] of Object.entries(makers)) {
    const state = await sign(issued);
    assert.equal(await verify(state, issued), true, `${name}: at once`);
    assert.equal(await verify(state, issued + TTL), true, `${name}: exactly 10 minutes later`);
    assert.equal(await verify(state, issued + TTL + 1), false, `${name}: 1 ms past the window`);
    assert.equal(await verify(state, issued + 2 * TTL), false, `${name}: long expired`);
    assert.equal(await verify(state, issued - SKEW), true, `${name}: issued up to a minute ahead of this clock`);
    assert.equal(await verify(state, issued - SKEW - 1), false, `${name}: dated further ahead than the skew`);
    assert.equal(await verify(state), false, `${name}: no clock is no state`);
    assert.equal(await verify(state, Number.NaN), false, `${name}: a broken clock is no state`);
    // The issue time is inside the MAC: moving it in the text breaks the MAC, so an old state cannot be made young.
    const [head, tail] = [state.split('.').slice(0, -2), state.split('.').slice(-2)];
    const later = [...head, String(issued + 5 * MINUTE), tail[1]].join('.');
    assert.equal(await verify(later, issued + 12 * MINUTE), false, `${name}: a moved issue time`);
    assert.equal(await verify(later, issued + 6 * MINUTE), false, `${name}: a moved issue time, even while it would be current`);
    // Only a canonical millisecond number is an issue time.
    for (const odd of [`0${issued}`, '1e12', '-5', '12.5', '', ' 5']) {
      assert.equal(await verify([...head, odd, tail[1]].join('.'), issued), false, `${name}: issue time "${odd}"`);
    }
    assert.equal(await verify(state.split('.').slice(0, -2).join('.') + '.' + state.split('.').pop(), issued), false, `${name}: a state without its issue time`);
  }
});

check('claimStateNonce: the first claim wins, a replay and a malformed state lose, only the SHA-256 is stored, a D1 failure refuses', async () => {
  const w = await makeWorld();
  const { session } = await flowsOf(w);
  const nonce = 'D'.repeat(22);
  const state = await session.signState(w.env, nonce, T0);
  const baseline = await w.count('oauth_state_nonces');
  assert.equal(await session.claimStateNonce(w.db, state, T0), true);
  assert.equal(await session.claimStateNonce(w.db, state, T0), false, 'a replay');
  assert.equal(await session.claimStateNonce(w.db, state, T0 + 5 * MINUTE), false, 'a replay later');
  const rows = await w.rows('SELECT nonce_hash, created_at, used_at FROM oauth_state_nonces WHERE nonce_hash = ?', crypto.createHash('sha256').update(nonce).digest('hex'));
  assert.deepEqual(rows, [{ nonce_hash: crypto.createHash('sha256').update(nonce).digest('hex'), created_at: T0, used_at: T0 }]);
  assert(!JSON.stringify(rows).includes(nonce), 'the nonce itself is not stored');
  // The same nonce in another mode is the same nonce: single use is per nonce, whichever flow minted the state.
  assert.equal(await session.claimStateNonce(w.db, await session.signBnetSigninState(w.env, nonce, T0), T0), false);
  for (const bad of [undefined, null, 5, '', 'x', 'a.b', `${nonce}.12`, `${nonce}.${T0}`, `short.${T0}.mac`, 'a.b.c.d.e']) {
    assert.equal(await session.claimStateNonce(w.db, bad, T0), false, `malformed: ${JSON.stringify(bad)}`);
  }
  assert.equal(await session.claimStateNonce(w.db, state, undefined), false, 'no clock');
  assert.equal(await w.count('oauth_state_nonces'), baseline + 1, 'a malformed state wrote nothing');
  const down = { prepare() { throw new Error('D1 is down'); } };
  assert.equal(await session.claimStateNonce(down, await session.signState(w.env, 'E'.repeat(22), T0), T0), false, 'a state that cannot be shown unused is refused');
  // A state dated ahead is stored no earlier than its own issue time (see the retention check below).
  const ahead = await session.signState(w.env, 'F'.repeat(22), T0 + 30 * 1000);
  assert.equal(await session.claimStateNonce(w.db, ahead, T0), true);
  assert.deepEqual(await w.rows('SELECT created_at, used_at FROM oauth_state_nonces WHERE created_at > ?', T0), [{ created_at: T0 + 30 * 1000, used_at: T0 }]);
});

// ---------------------------------------------------------------------------
// The callbacks

check('expired and future-dated states are refused at all four callbacks before any outbound call and before a nonce is claimed; the edges are accepted', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  for (const f of x.list) {
    // begun, then left for 10 minutes and 1 ms
    let jar = x.jarOf(f);
    let state = stateOf(await f.begin(jar));
    let calls = f.calls();
    let rows = await w.count('oauth_state_nonces');
    w.advance(TTL + 1);
    assert.equal(locationOf(await f.callback(state, jar)), f.failTo, `${f.name}: expired`);
    assert.equal(f.calls(), calls, `${f.name}: expired state, no outbound call`);
    assert.equal(await w.count('oauth_state_nonces'), rows, `${f.name}: expired state claimed nothing`);
    // exactly 10 minutes is still good
    jar = x.jarOf(f);
    state = stateOf(await f.begin(jar));
    w.advance(TTL);
    assert.equal(locationOf(await f.callback(state, jar)), f.ok, `${f.name}: exactly 10 minutes`);
    // dated a minute and a millisecond ahead
    jar = x.jarOf(f);
    const ahead = await f.sign(craftedNonce(), w.clock.now + SKEW + 1);
    jar[f.cookie] = ahead;
    calls = f.calls();
    rows = await w.count('oauth_state_nonces');
    assert.equal(locationOf(await f.callback(ahead, jar)), f.failTo, `${f.name}: future-dated`);
    assert.equal(f.calls(), calls, `${f.name}: future-dated state, no outbound call`);
    assert.equal(await w.count('oauth_state_nonces'), rows, `${f.name}: future-dated state claimed nothing`);
    // a minute ahead (clock skew between two machines) is tolerated
    jar = x.jarOf(f);
    const skewed = await f.sign(craftedNonce(), w.clock.now + SKEW);
    jar[f.cookie] = skewed;
    assert.equal(locationOf(await f.callback(skewed, jar)), f.ok, `${f.name}: a minute ahead`);
  }
});

check('single use: a replayed state is refused with no outbound call at all four callbacks, and the begin routes write nothing', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  const before = await w.count('oauth_state_nonces');
  const begun = [];
  for (const f of x.list) {
    const jar = x.jarOf(f);
    begun.push({ f, jar, state: stateOf(await f.begin(jar)) });
  }
  assert.equal(await w.count('oauth_state_nonces'), before, 'beginning four logins claimed no nonce');
  for (const { f, jar, state } of begun) {
    assert.equal(locationOf(await f.callback(state, jar)), f.ok, `${f.name}: the first use`);
    const calls = f.calls();
    const rows = await w.count('oauth_state_nonces');
    assert(!jar[f.cookie], `${f.name}: the callback cleared the state cookie`);
    // Put the cookie back, as a browser (or an attacker holding both) would.
    jar[f.cookie] = state;
    assert.equal(locationOf(await f.callback(state, jar)), f.failTo, `${f.name}: the replay`);
    assert.equal(f.calls(), calls, `${f.name}: the replay made no outbound call`);
    assert.equal(await w.count('oauth_state_nonces'), rows, `${f.name}: the replay wrote nothing more`);
  }
  assert.equal(await w.count('oauth_state_nonces'), before + 4);
});

check('two parallel callbacks with one state: exactly one proceeds, the other is refused and makes no call of its own', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  for (const f of x.list) {
    // The calls one successful callback makes, measured on a run of its own.
    const single = x.jarOf(f);
    const singleState = stateOf(await f.begin(single));
    const start = f.calls();
    assert.equal(locationOf(await f.callback(singleState, single)), f.ok, `${f.name}: reference run`);
    const perCallback = f.calls() - start;
    assert(perCallback >= 2, `${f.name}: a callback makes outbound calls`);

    const jarA = x.jarOf(f);
    const state = stateOf(await f.begin(jarA));
    const jarB = { ...jarA };
    const rows = await w.count('oauth_state_nonces');
    const calls = f.calls();
    const results = (await Promise.all([f.callback(state, jarA), f.callback(state, jarB)])).map(locationOf);
    assert.deepEqual([...results].sort(), [f.ok, f.failTo].sort(), `${f.name}: one through, one refused (${results.join(' | ')})`);
    assert.equal(f.calls() - calls, perCallback, `${f.name}: only the winner called out`);
    assert.equal(await w.count('oauth_state_nonces'), rows + 1, `${f.name}: one nonce row`);
  }
});

check('a link state of member A is refused for member B at both link callbacks, before any outbound call, without using the state up', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  for (const f of x.list.filter((flow) => flow.link)) {
    const jarA = x.jarOf(f);
    const state = stateOf(await f.begin(jarA));
    const stolen = x.jarOf(f, x.bob);
    stolen[f.cookie] = state;
    const calls = f.calls();
    const rows = await w.count('oauth_state_nonces');
    assert.equal(locationOf(await f.callback(state, stolen)), f.failTo, `${f.name}: B presenting A's state`);
    assert.equal(f.calls(), calls, `${f.name}: no outbound call`);
    assert.equal(await w.count('oauth_state_nonces'), rows, `${f.name}: a state that failed its MAC claimed nothing`);
    assert.equal(locationOf(await f.callback(state, jarA)), f.ok, `${f.name}: A can still finish with it`);
  }
  // And at the unit level, in both directions.
  const state = await x.session.signDiscordLinkState(w.env, x.aliceId, 'G'.repeat(22), w.clock.now);
  assert.equal(await x.session.verifyDiscordLinkState(w.env, x.aliceId, state, w.clock.now), true);
  assert.equal(await x.session.verifyDiscordLinkState(w.env, x.bobId, state, w.clock.now), false);
});

// ---------------------------------------------------------------------------
// The fresh. prefix (lane B6b builds the flow on top of it)

check('the fresh. prefix is its own mode in both mode functions and can never be taken for a link or a sign-in', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  const { session } = x;
  const nonce = 'H'.repeat(22);
  const mac = 'M'.repeat(43);
  const freshShaped = [
    `fresh.${nonce}.${T0}.${mac}`, `fresh.${nonce}.${mac}`, 'fresh.', 'fresh.x', `fresh.link.${nonce}.${T0}.${mac}`, `fresh.signin.${nonce}.${T0}.${mac}`,
    `fresh.${nonce}.${T0}.${mac}.extra`,
  ];
  for (const state of freshShaped) {
    assert.equal(session.discordStateMode(state), 'fresh', state);
    assert.equal(session.bnetStateMode(state), 'fresh', state);
    assert.equal(session.FRESH_MODE, 'fresh');
    assert.equal(await session.verifyState(w.env, state, T0), false, `${state}: not a Discord sign-in`);
    assert.equal(await session.verifyDiscordLinkState(w.env, x.aliceId, state, T0), false, `${state}: not a Discord link`);
    assert.equal(await session.verifyBnetState(w.env, x.aliceId, state, T0), false, `${state}: not a Battle.net link`);
    assert.equal(await session.verifyBnetSigninState(w.env, state, T0), false, `${state}: not a Battle.net sign-in`);
  }
  // A genuine state with the prefix put on, or swapped in for its own, is fresh-shaped and nothing else.
  const genuine = [
    await session.signState(w.env, nonce, T0), await session.signDiscordLinkState(w.env, x.aliceId, nonce, T0),
    await session.signBnetState(w.env, x.aliceId, nonce, T0), await session.signBnetSigninState(w.env, nonce, T0),
  ];
  for (const state of genuine) {
    const swapped = state.replace(/^(link|signin)\./, 'fresh.');
    for (const forged of swapped === state ? [`fresh.${state}`] : [`fresh.${state}`, swapped]) {
      assert.equal(session.discordStateMode(forged), 'fresh', forged);
      assert.equal(session.bnetStateMode(forged), 'fresh', forged);
      assert.equal(await session.verifyState(w.env, forged, T0), false);
      assert.equal(await session.verifyDiscordLinkState(w.env, x.aliceId, forged, T0), false);
      assert.equal(await session.verifyBnetState(w.env, x.aliceId, forged, T0), false);
      assert.equal(await session.verifyBnetSigninState(w.env, forged, T0), false);
    }
  }
  // The other shapes keep their modes (nothing else slipped into the new branch).
  assert.equal(session.discordStateMode(genuine[0]), 'signin');
  assert.equal(session.discordStateMode(genuine[1]), 'link');
  assert.equal(session.bnetStateMode(genuine[2]), 'link');
  assert.equal(session.bnetStateMode(genuine[3]), 'signin');
  for (const odd of [undefined, null, 5, '', 'freshly.x.y.z', 'FRESH.x.y.z', ' fresh.x']) {
    assert.notEqual(session.discordStateMode(odd), 'fresh', String(odd));
    assert.notEqual(session.bnetStateMode(odd), 'fresh', String(odd));
  }
});

check('both callbacks refuse a forged fresh-shaped state: signed out they send the browser to sign in, signed in to the fresh route, with no outbound call, no nonce, no session', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  const states = [];
  for (const f of x.list) states.push(stateOf(await f.begin(x.jarOf(f))));
  states.push(await x.list[0].sign(craftedNonce(), w.clock.now));
  const rows = await w.count('oauth_state_nonces');
  const sessions = await w.count('sessions');
  const users = await w.count('users');
  const discordCalls = w.discord.calls.length;
  const bnetCalls = w.bnet.state.requests.length;
  for (const original of states) {
    const state = `fresh.${original}`;
    for (const jar of [{}, { ...x.alice }]) {
      const withCookies = { ...jar, '__Host-rs_state': state, '__Host-rs_bnet_state': state };
      const discord = await w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { ...withCookies } });
      const expected = Object.keys(jar).length ? '/#/fresh?error=state' : '/#/signin';
      assert.equal(locationOf(discord), expected, `Discord callback: ${state.slice(0, 12)}`);
      const bnet = await w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { ...withCookies } });
      assert.equal(locationOf(bnet), expected, `Battle.net callback: ${state.slice(0, 12)}`);
      assert(!sessionCookieOf(discord) && !sessionCookieOf(bnet), 'no session was made');
    }
  }
  assert.equal(w.discord.calls.length, discordCalls, 'no Discord call');
  assert.equal(w.bnet.state.requests.length, bnetCalls, 'no Battle.net call');
  assert.equal(await w.count('oauth_state_nonces'), rows, 'no nonce claimed');
  assert.equal(await w.count('sessions'), sessions);
  assert.equal(await w.count('users'), users);
});

// ---------------------------------------------------------------------------
// Battle.net callback limits

async function guildWorld() {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id] });
  const alice = await discordSignIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const erin = await discordSignIn(w, PEOPLE.erin, [plain(SERVER_A)]);
  const erinId = (await w.call(erin, 'GET', '/auth/me')).json.user.id;
  return { w, alice, erin, erinId };
}

check('per Blizzard account: 10 callbacks per 10 minutes, the 11th is answered busy after the token exchange and before any snapshot call, the window rolls', async () => {
  const { w, erin } = await guildWorld();
  const first = await bnetLink(w, erin, BNET.erin);
  assert.equal(locationOf(first.callback), '/#/characters');
  const profile = () => w.asked('/profile').length;
  assert(profile() > 0, 'a member of a guild gets a snapshot (so the fan-out is observable)');
  for (let i = 0; i < 9; i++) assert.equal(locationOf((await bnetSignIn(w, BNET.erin)).callback), '/#/', `sign-in ${i + 1}`);
  assert.equal((await w.bucket(`bnetcb:${BNET.erin.id}`)).count, 10);
  assert.equal((await w.bucket('bnetcb:global')).count, 10);

  const profileBefore = profile();
  const tokensBefore = w.asked('/token').length;
  const userinfoBefore = w.asked('/userinfo').length;
  const sessionsBefore = await w.count('sessions');
  const busy = await bnetSignIn(w, BNET.erin);
  assert.equal(locationOf(busy.callback), '/#/signin?error=busy');
  assert.equal(w.asked('/token').length, tokensBefore + 1, 'the code was exchanged (the account id comes from the exchange)');
  assert.equal(w.asked('/userinfo').length, userinfoBefore + 1);
  assert.equal(profile(), profileBefore, 'and no snapshot call followed');
  assert(!sessionCookieOf(busy.callback) && !busy.jar['__Host-rs_session'], 'no session');
  assert.equal(await w.count('sessions'), sessionsBefore);
  assert.equal((await w.bucket('bnetcb:global')).count, 10, 'a refused callback does not spend the global budget');
  // The same answer at the link callback, on the page that shows it.
  assert.equal(locationOf((await bnetLink(w, erin, BNET.erin)).callback), '/#/linked?error=busy');
  assert.equal(profile(), profileBefore);
  // Another Blizzard account is not held up by it.
  assert.equal(locationOf((await bnetSignIn(w, BNET.ivan)).callback), '/#/');
  // The window rolls: a fixed window from the first callback.
  w.advance(TTL + 1);
  assert.equal(locationOf((await bnetSignIn(w, BNET.erin)).callback), '/#/');
  assert(profile() > profileBefore, 'and its snapshot is fetched again');
  assert.equal((await w.bucket(`bnetcb:${BNET.erin.id}`)).count, 1);
});

check('global callback budget: counts every callback, never refuses, logs one ALARM line when spent and one more in the next window', async () => {
  const w = await makeWorld();
  const rl = await load('worker/ratelimit.js');
  assert.equal(rl.BNET_CALLBACK_BUDGET, 300);
  assert.equal(rl.BNET_CALLBACK_LIMIT, 10);
  assert.equal(rl.BNET_CALLBACK_WINDOW_MS, TTL);
  const alarms = () => w.logs.filter((line) => /^ALARM bnet_callback_budget\b/.test(line));
  const account = (n) => ({ id: String(800000000 + n), battletag: `Budget${n}#1000` });
  assert.equal(locationOf((await bnetSignIn(w, account(1))).callback), '/#/');
  assert.equal((await w.bucket('bnetcb:global')).count, 1);
  // Seed the window two short of the budget.
  w.db.sqlite.exec(`UPDATE rate_limits SET count = ${rl.BNET_CALLBACK_BUDGET - 2} WHERE key = 'bnetcb:global'`);
  assert.equal(locationOf((await bnetSignIn(w, account(2))).callback), '/#/', 'at 299');
  assert.equal(locationOf((await bnetSignIn(w, account(3))).callback), '/#/', 'at 300, the budget is used but not over');
  assert.equal(alarms().length, 0, 'no alarm up to the budget');
  assert.equal(locationOf((await bnetSignIn(w, account(4))).callback), '/#/', 'the first past it still proceeds');
  assert.equal(alarms().length, 1, 'one alarm line');
  assert.match(alarms()[0], /300/);
  for (let n = 5; n <= 7; n++) assert.equal(locationOf((await bnetSignIn(w, account(n))).callback), '/#/', `past the budget ${n}`);
  assert.equal(alarms().length, 1, 'still one line for the window');
  assert.equal((await w.bucket('bnetcb:global')).count, rl.BNET_CALLBACK_BUDGET + 4);
  assert.equal(await w.count('users'), 7, 'every callback made its account');
  // Next window: counted from one again, and a new alarm when that window runs out too.
  w.advance(TTL + 1);
  assert.equal(locationOf((await bnetSignIn(w, account(8))).callback), '/#/');
  assert.equal((await w.bucket('bnetcb:global')).count, 1);
  w.db.sqlite.exec(`UPDATE rate_limits SET count = ${rl.BNET_CALLBACK_BUDGET} WHERE key = 'bnetcb:global'`);
  assert.equal(locationOf((await bnetSignIn(w, account(9))).callback), '/#/');
  assert.equal(alarms().length, 2, 'one line per window');
  // The alarm line holds no account number, token or code.
  assert(alarms().every((line) => !/\d{9}|abc|token/i.test(line.replace(/\b300\b|10 minutes/g, ''))), alarms().join(' | '));
});

check('spendBudget: counts a fixed window, says spent past the limit and alarm exactly once per window, and a D1 failure never spends it', async () => {
  const w = await makeWorld();
  const { spendBudget } = await load('worker/ratelimit.js');
  const options = { key: 'budget:test', limit: 3, windowMs: 1000 };
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await spendBudget(w.db, T0, options));
  assert.deepEqual(results.map((r) => r.spent), [false, false, false, true, true, true]);
  assert.deepEqual(results.map((r) => r.alarm), [false, false, false, true, false, false]);
  assert.deepEqual(await spendBudget(w.db, T0 + 1000, options), { spent: false, alarm: false }, 'a new window starts at one');
  assert.equal((await w.bucket('budget:test')).count, 1);
  assert.deepEqual(await spendBudget({ prepare() { throw new Error('D1 is down'); } }, T0, options), { spent: false, alarm: false });
});

check('Delete my data removes the account\'s bnetcb key (by its Blizzard account id) and nothing else of the global budget', async () => {
  const { w, erin, erinId } = await guildWorld();
  await bnetLink(w, erin, BNET.erin);
  await bnetSignIn(w, BNET.ivan);
  assert(await w.bucket(`bnetcb:${BNET.erin.id}`));
  assert(await w.bucket(`bnetcb:${BNET.ivan.id}`));
  const del = await w.call(erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(await w.count('users', 'id = ?', erinId), 0);
  assert.equal(await w.bucket(`bnetcb:${BNET.erin.id}`), null, 'the departed account\'s key is gone');
  assert(await w.bucket(`bnetcb:${BNET.ivan.id}`), 'another account\'s key stays');
  assert(await w.bucket('bnetcb:global'), 'and so does the global budget');
});

// ---------------------------------------------------------------------------
// Retention

check('retention: the nonce TTL covers the state window, a claimed nonce outlives its state, and a pruned nonce can no longer be replayed because its state has expired', async () => {
  const w = await makeWorld();
  const x = await flowsOf(w);
  const { session } = x;
  const rt = await load('worker/retention.js');
  assert(rt.OAUTH_NONCE_TTL_MS >= session.STATE_TTL_MS, 'the prune TTL is at least the validity window');
  assert.equal(session.STATE_TTL_MS, TTL);
  const prune = async (at) => (await rt.runRetention({ db: w.db, now: () => at, log: () => {} })).oauthStateNonces;

  // A callback's nonce row (the two sign-ins that made the test's members left rows of their own).
  const f = x.list[3];
  const jar = x.jarOf(f);
  const state = stateOf(await f.begin(jar));
  const older = await w.count('oauth_state_nonces');
  assert.equal(locationOf(await f.callback(state, jar)), f.ok);
  const claimedAt = w.clock.now;
  const hash = crypto.createHash('sha256').update(state.split('.')[1]).digest('hex');
  assert.deepEqual(await w.rows('SELECT created_at, used_at FROM oauth_state_nonces WHERE nonce_hash = ?', hash), [{ created_at: claimedAt, used_at: claimedAt }]);
  assert.equal(await prune(claimedAt + TTL), 0, 'kept for the whole window');
  assert.equal(await session.verifyBnetSigninState(w.env, state, claimedAt + TTL), true, 'the state is still current at that moment, so the row has to be there');
  assert.equal(await session.claimStateNonce(w.db, state, claimedAt + TTL), false);
  assert.equal(await prune(claimedAt + TTL + 1), older + 1, 'pruned once the window is over');
  assert.equal(await session.verifyBnetSigninState(w.env, state, claimedAt + TTL + 1), false, 'and then the age check refuses the state, so the missing row is no way back in');

  // A state dated up to a minute ahead is accepted; its row must still be there for as long as that state can pass the age check.
  const issued = w.clock.now + 45 * 1000;
  const ahead = await session.signBnetSigninState(w.env, 'J'.repeat(22), issued);
  assert.equal(await session.verifyBnetSigninState(w.env, ahead, w.clock.now), true);
  assert.equal(await session.claimStateNonce(w.db, ahead, w.clock.now), true);
  const lastGoodMoment = issued + TTL;
  assert.equal(await prune(lastGoodMoment), 0);
  assert.equal(await session.verifyBnetSigninState(w.env, ahead, lastGoodMoment), true, 'the state is still current');
  assert.equal(await session.claimStateNonce(w.db, ahead, lastGoodMoment), false, 'and a replay is still refused');
  assert.equal(await prune(lastGoodMoment + 1), 1);
  assert.equal(await session.verifyBnetSigninState(w.env, ahead, lastGoodMoment + 1), false);
});

(async () => {
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
})().catch((error) => { console.error(error); process.exit(1); });
