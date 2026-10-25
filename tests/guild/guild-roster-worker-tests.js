/**
 * Raidsmith guild tracker - roster Worker tests (Phase 2)
 * Run: node tests/guild/guild-roster-worker-tests.js
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs both migrations), with
 * Discord, Raid-Helper and Warcraft Logs faked by an injected fetch. No network, no Wrangler, no credentials.
 * Every write-path test ends with the shared "exactly one Main per person" assertion.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');

const ROOT = require('path').join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';
const OTHER_SERVER = '900000000000000077';

// Discord IDs are 18 digits here: the roster stores them and its CHECK wants 17 to 20 digits.
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  frank: { id: '110000000000000006', username: 'frank', globalName: 'Frank F' },
  gina: { id: '110000000000000007', username: 'gina', globalName: 'Gina G' },
};

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

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

const WCL_ID = 'wcl-id';
const WCL_SECRET = 'wcl-secret';

// Raid-Helper and Warcraft Logs, in process.
function makeSources() {
  const s = {
    events: new Map(),
    reports: new Map(),
    calls: [],
    rh: { status: null, throws: false, raw: undefined },
    wcl: { tokens: new Set(), tokenPosts: [], expiresIn: 3600, failToken: false, httpStatus: null, errors: null },
  };
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    s.calls.push({ url: String(url), method: init.method || 'GET', init });
    if (u.hostname === 'raid-helper.dev') {
      if (s.rh.throws) throw new Error('network down');
      if (s.rh.status) return new Response('{}', { status: s.rh.status });
      if (s.rh.raw !== undefined) return new Response(s.rh.raw, { status: 200 });
      const match = /^\/api\/v4\/events\/(\d+)$/.exec(u.pathname);
      const event = match && s.events.get(match[1]);
      if (!event) return new Response('{}', { status: 404 });
      return Response.json(event);
    }
    const wcl = /^(www|classic|fresh)\.warcraftlogs\.com$/.exec(u.hostname);
    if (wcl) {
      if (u.pathname === '/oauth/token') {
        s.wcl.tokenPosts.push({ flavour: wcl[1], auth: init.headers.Authorization, body: init.body });
        if (s.wcl.failToken) return new Response('{}', { status: 500 });
        if (init.headers.Authorization !== `Basic ${btoa(`${WCL_ID}:${WCL_SECRET}`)}` || init.body !== 'grant_type=client_credentials') {
          return new Response('{}', { status: 401 });
        }
        const token = `wcltok-${wcl[1]}-${s.wcl.tokenPosts.length}`;
        s.wcl.tokens.add(token);
        return Response.json({ access_token: token, expires_in: s.wcl.expiresIn });
      }
      if (u.pathname === '/api/v2/client') {
        const bearer = /^Bearer (.+)$/.exec(init.headers.Authorization || '');
        if (!bearer || !s.wcl.tokens.has(bearer[1])) return new Response('{}', { status: 401 });
        if (s.wcl.httpStatus) return new Response('{}', { status: s.wcl.httpStatus });
        if (s.wcl.errors) return Response.json({ errors: s.wcl.errors });
        const code = JSON.parse(init.body).variables.code;
        const report = s.reports.has(code) ? s.reports.get(code) : null;
        return Response.json({ data: { reportData: { report } } });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return s;
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
  const { resetWclTokenCache } = await load('worker/sources.js');
  resetWclTokenCache();
  const db = createD1Fake();
  const discord = makeDiscord();
  const sources = makeSources();
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
    WCL_CLIENT_ID: WCL_ID,
    WCL_CLIENT_SECRET: WCL_SECRET,
    ...env,
  };
  const fetchRouter = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === 'raid-helper.dev' || host.endsWith('.warcraftlogs.com')) return sources.fetch(url, init);
    if (host === '127.0.0.1' || host === 'localhost') return fetch(url, init);
    return discord.fetch(url, init);
  };
  const app = createApp({ db, env: fullEnv, fetch: fetchRouter, now: () => clock.now, randomBytes, log: () => {} });
  const world = {
    db, discord, sources, clock, env: fullEnv,
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
  };
  return world;
}

async function signIn(world, person, servers = [], jar = newJar()) {
  world.discord.next = {
    user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null },
    servers,
  };
  const login = await world.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

// Alice (Guild Master) creates the guild; Bob (Officer), Carol (Team Lead of the first team), Dave (Team Lead of
// the second team, when there is one) and Erin (Member) sign in. Frank runs a second guild on SERVER_B.
async function scenario({ teams = 1, guildBody = {} } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const body = { ...GUILD_BODY, ...guildBody };
  if (teams > 1) { body.multipleTeams = true; body.teamNames = ['Alpha', 'Bravo', 'Charlie'].slice(0, teams); }
  const created = await w.call(alice, 'POST', '/api/guild', body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = {
    w, alice, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {},
  };
  s.teamId = s.teams[0];
  for (const name of ['bob', 'carol', 'dave', 'erin']) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.rosterPath = `${s.guildPath}/roster`;
  s.personPath = (pid) => `${s.rosterPath}/${pid}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.teams[0]] })).status, 200);
  if (teams > 1) assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.teams[1]] })).status, 200);
  return s;
}

// A second guild for cross-guild checks.
async function secondGuild(s, body = {}) {
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const created = await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', ...body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { frank, guildId: created.json.guild.id, teamId: created.json.teams[0].id, path: `/api/guild/${created.json.guild.id}` };
}

// Shared assertion: every person has exactly one Main.
async function assertOneMain(w) {
  const bad = await w.rows(
    `SELECT p.id, COALESCE(SUM(c.is_main), 0) AS mains FROM players p LEFT JOIN characters c ON c.player_id = p.id
      GROUP BY p.id HAVING mains != 1`,
  );
  assert.deepEqual(bad, [], 'every person has exactly one Main');
}

const NAMES = ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Galdor', 'Hestia', 'Ivarr', 'Jorund', 'Kestrel', 'Lysandra'];
const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const addAlt = (s, who, pid, teamId, name, extra = {}) => s.call(who, 'POST', `/roster/${pid}/characters`, { name, class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId, makeMain: false, ...extra });

// A letters-only name for number n (Aa, Ab, ... Aaa ...).
function nameFor(n) {
  let text = '';
  let rest = n;
  do { text = String.fromCharCode(97 + (rest % 26)) + text; rest = Math.floor(rest / 26); } while (rest > 0);
  return `Zq${text}`;
}

const signUp = (id, userId, name, className, specName, position = id) => ({ id, userId, name, className, specName, status: 'primary', position });
const RH_START = 1_800_100_000;
const rhEvent = (id, serverId, signUps, extra = {}) => ({ id, serverId, title: 'Test Raid', startTime: RH_START, signUps, ...extra });
const DID = (n) => `2000000000000000${String(n).padStart(2, '0')}`;
const EVENT_ID = '111111111111111111';

function throwsD1(fn) {
  return Promise.resolve().then(fn).then(
    () => assert.fail('expected a D1_ERROR'),
    (error) => assert.match(error.message, /^D1_ERROR: /),
  );
}
const exec = (w, sql) => w.db.sqlite.exec(sql);

// ---------------------------------------------------------------------------
// Schema (migrations/0002_roster.sql) and D1 fake parity

function seedGuild(w, guildId, serverId) {
  exec(w, `INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
           VALUES ('${guildId}', 'G', 'R', 'realm', 'US', '${serverId}', 'UTC', 'tbc', 1)`);
  exec(w, `INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('${guildId}_t1', '${guildId}', 'T1', 25, 0, 1), ('${guildId}_t2', '${guildId}', 'T2', 25, 0, 1)`);
}
const playerSql = (id, guildId, extra = '') => `INSERT INTO players (id, guild_id, status, created_at, updated_at${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ('${id}', '${guildId}', 'raider', 1, 1${extra ? ', ' + extra.split('|')[1] : ''})`;
const charSql = (id, guildId, playerId, teamId, name, { main = 0, realmKey = '', cls = 'MAGE' } = {}) =>
  `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm_key, class, is_main, created_at, updated_at)
   VALUES ('${id}', '${guildId}', '${playerId}', '${teamId}', '${name}', '${name.toLowerCase()}', '${realmKey}', '${cls}', ${main}, 1, 1)`;
const fails = (w, sql, pattern) => assert.throws(() => exec(w, sql), pattern);

check('schema: one Main per person, a name is unique per guild + realm key, and CHECKs refuse bad dates, Discord IDs and nicknames', async () => {
  const w = await makeWorld();
  seedGuild(w, 'g1', 'd1');
  exec(w, playerSql('p1', 'g1'));
  exec(w, charSql('c1', 'g1', 'p1', 'g1_t1', 'Aldric', { main: 1 }));
  fails(w, charSql('c2', 'g1', 'p1', 'g1_t1', 'Brindle', { main: 1 }), /UNIQUE constraint failed/);
  exec(w, charSql('c2', 'g1', 'p1', 'g1_t1', 'Brindle'));
  fails(w, charSql('c3', 'g1', 'p1', 'g1_t1', 'Aldric'), /UNIQUE constraint failed/);
  exec(w, charSql('c3', 'g1', 'p1', 'g1_t1', 'Aldric', { realmKey: 'otherrealm' }));
  for (const [column, value] of [['joined_on', '2026-19-39'], ['trial_start', '2026-02-30'], ['trial_end', 'tomorrow'],
    ['left_on', '2026-02-30'], ['left_reason', 'quit'], ['discord_user_id', '1234567890123456a'], ['discord_user_id', '1234567890123456'], ['discord_user_id', '123456789012345678901'], ['discord_nickname', 'x'.repeat(65)]]) {
    fails(w, playerSql('px', 'g1', `${column}|'${value}'`), /CHECK constraint failed/);
  }
  fails(w, playerSql('px', 'g1', "trial_start, trial_end|'2026-05-02', '2026-05-01'"), /CHECK constraint failed/);
  exec(w, playerSql('py', 'g1', "discord_user_id|'12345678901234567'"));
  exec(w, playerSql('pz', 'g1', "joined_on, discord_user_id|'2026-02-28', '12345678901234568'"));
  fails(w, playerSql('pw', 'g1', "discord_user_id|'12345678901234567'"), /UNIQUE constraint failed/);
  fails(w, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c9','g1','p1','g1_t1','Zed','zed','PALADINN',1,1)", /CHECK constraint failed/);
});

check('schema: composite foreign keys keep a character and its person in one guild; a guild delete cascades; a team with characters cannot be deleted', async () => {
  const w = await makeWorld();
  seedGuild(w, 'g1', 'd1');
  seedGuild(w, 'g2', 'd2');
  exec(w, playerSql('p1', 'g1'));
  fails(w, charSql('c1', 'g1', 'p1', 'g2_t1', 'Aldric', { main: 1 }), /FOREIGN KEY constraint failed/);
  fails(w, charSql('c1', 'g2', 'p1', 'g2_t1', 'Aldric', { main: 1 }), /FOREIGN KEY constraint failed/);
  exec(w, charSql('c1', 'g1', 'p1', 'g1_t1', 'Aldric', { main: 1 }));
  exec(w, charSql('c2', 'g1', 'p1', 'g1_t2', 'Brindle'));
  fails(w, "DELETE FROM teams WHERE id = 'g1_t2'", /FOREIGN KEY constraint failed/);
  exec(w, playerSql('p2', 'g2'));
  exec(w, charSql('c3', 'g2', 'p2', 'g2_t1', 'Cassia', { main: 1 }));
  exec(w, "DELETE FROM guilds WHERE id = 'g1'");
  assert.equal(await w.count('players'), 1);
  assert.equal(await w.count('characters'), 1);
  assert.equal(await w.count('teams'), 2);
  exec(w, "DELETE FROM players WHERE id = 'p2'");
  assert.equal(await w.count('characters'), 0, 'deleting a person deletes their characters');
});

check('schema: the cap triggers abort the statement, and a batch that would pass a cap rolls back whole (the fake runs triggers like D1)', async () => {
  const w = await makeWorld();
  seedGuild(w, 'g1', 'd1');
  exec(w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
           INSERT INTO players (id, guild_id, status, created_at, updated_at) SELECT 'fill' || i, 'g1', 'raider', 1, 1 FROM n`);
  assert.equal(await w.count('players'), 999);
  const insertPlayer = (id) => w.db.prepare("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES (?, 'g1', 'raider', 1, 1)").bind(id);
  await assert.rejects(w.db.batch([insertPlayer('late1'), insertPlayer('late2')]), /person_limit/);
  assert.equal(await w.count('players'), 999, 'the batch rolled back whole: late1 is gone too');
  await w.db.batch([insertPlayer('late1')]);
  assert.equal(await w.count('players'), 1000);
  await assert.rejects(w.db.prepare("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('late3', 'g1', 'raider', 1, 1)").run(), /person_limit/);
  // Another guild has its own count.
  seedGuild(w, 'g2', 'd2');
  exec(w, playerSql('q1', 'g2'));

  exec(w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19)
           INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
           SELECT 'x' || i, 'g2', 'q1', 'g2_t1', 'Name' || i, 'name' || i, 'MAGE', CASE WHEN i = 1 THEN 1 ELSE 0 END, 1, 1 FROM n`);
  const insertChar = (id, name) => w.db.prepare(
    `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES (?, 'g2', 'q1', 'g2_t1', ?, ?, 'MAGE', 1, 1)`,
  ).bind(id, name, name.toLowerCase());
  await assert.rejects(w.db.batch([insertChar('y1', 'Extraone'), insertChar('y2', 'Extratwo')]), /character_limit/);
  assert.equal(await w.count('characters', "player_id = 'q1'"), 19, 'rolled back whole');
  await w.db.batch([insertChar('y1', 'Extraone')]);
  assert.equal(await w.count('characters', "player_id = 'q1'"), 20);
});

check('d1 fake parity: json_each, INSERT ... SELECT from json_each and multi-statement batches behave like D1', async () => {
  const w = await makeWorld();
  seedGuild(w, 'g1', 'd1');
  const json = JSON.stringify([{ id: 'a1', n: 'Aa' }, { id: 'a2', n: null }]);
  const result = await w.db.prepare(
    `INSERT INTO players (id, guild_id, status, discord_nickname, created_at, updated_at)
     SELECT json_extract(value, '$.id'), 'g1', 'raider', json_extract(value, '$.n'), 1, 1 FROM json_each(?)`,
  ).bind(json).run();
  assert.equal(result.meta.changes, 2);
  assert.deepEqual((await w.rows('SELECT id, discord_nickname FROM players ORDER BY id')), [{ id: 'a1', discord_nickname: 'Aa' }, { id: 'a2', discord_nickname: null }]);
  const inList = await w.rows('SELECT id FROM players WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', JSON.stringify(['a2', 'zz']));
  assert.deepEqual(inList, [{ id: 'a2' }]);
  await throwsD1(() => w.db.batch([
    w.db.prepare("DELETE FROM players WHERE id = 'a1'"),
    w.db.prepare("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('a2', 'g1', 'raider', 1, 1)"),
  ]));
  assert.equal(await w.count('players'), 2, 'the failed batch rolled back its first statement');
});

// ---------------------------------------------------------------------------
// Rules (worker/roster-data.js)

check('rules: cleanCharacterName, nameKey and realmKey', async () => {
  const d = await load('worker/roster-data.js');
  assert.equal(d.cleanCharacterName('  aLDRIC '), 'Aldric');
  assert.equal(d.cleanCharacterName('sølvhand'), 'Sølvhand');
  assert.equal(d.cleanCharacterName('Sølvhand'.normalize('NFD')), 'Sølvhand'.normalize('NFC'));
  for (const bad of ['A', 'Abcdefghijklm', 'Ab1', 'Ab cd', "O'Neil", 'Ab-cd', '', '  ', null, 12, undefined]) assert.equal(d.cleanCharacterName(bad), null, String(bad));
  assert.equal(d.cleanCharacterName('Abcdefghijkl'), 'Abcdefghijkl');
  assert.equal(d.cleanCharacterName('Ab'), 'Ab');
  assert.equal(d.nameKey('Sølvhand'), 'sølvhand');
  assert.equal(d.realmKey('Maladath (AU)'), 'maladath');
  assert.equal(d.realmKey('Maladath'), 'maladath');
  assert.equal(d.realmKey("Quel'Thalas"), 'quelthalas');
  assert.equal(d.realmKey('Defias Brotherhood'), 'defiasbrotherhood');
  assert.equal(d.realmKey('Azjol-Nerub'), 'azjolnerub');
  assert.equal(d.realmKey(null), '');
});

check('rules: nicknameTokens splits on separators, drops stop-list words, keeps valid names, de-duplicates', async () => {
  const { nicknameTokens } = await load('worker/roster-data.js');
  assert.deepEqual(nicknameTokens('Aldric/Brindle'), ['Aldric', 'Brindle']);
  assert.deepEqual(nicknameTokens('Aldric(Brindle)'), ['Aldric', 'Brindle']);
  assert.deepEqual(nicknameTokens('Aldric/Brindle/Cassia'), ['Aldric', 'Brindle', 'Cassia']);
  assert.deepEqual(nicknameTokens('Gnøpe/X'), ['Gnøpe'], 'X is too short for a name');
  assert.deepEqual(nicknameTokens('Aldric Prot / Resto Brindle'), ['Aldric', 'Brindle']);
  for (const word of ['Warrior', 'prot', 'RESTO', 'Ret', 'Enh', 'Ele', 'Disc', 'Destro', 'Affli', 'Demo', 'BM', 'MM', 'Surv', 'Sub', 'Boomkin', 'Bear', 'Cat',
    'Tank', 'Heal', 'Heals', 'Healer', 'DPS', 'Melee', 'Ranged', 'Caster', 'Main', 'Alt', 'Alts', 'Officer', 'GM', 'Raider', 'Trial', 'Druid', 'Shadow']) {
    assert.deepEqual(nicknameTokens(`Aldric ${word}`), ['Aldric'], word);
  }
  assert.deepEqual(nicknameTokens('Aldric - Aldric | ALDRIC'), ['Aldric'], 'first wins');
  assert.deepEqual(nicknameTokens('A+Bo&Cy;Dee:Eve,Fay{Gus}Hal[Ivy]'), ['Bo', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy']);
  assert.deepEqual(nicknameTokens(''), []);
  assert.deepEqual(nicknameTokens(null), []);
  const { cleanNickname } = await load('worker/roster-data.js');
  assert.equal(cleanNickname('  Al\u0000dric‮  '), 'Aldric');
  assert.equal(Array.from(cleanNickname('x'.repeat(100))).length, 64);
  assert.equal(cleanNickname(' \u0007 '), null);
});

check('rules: trialFlag across the 7-day edge, with status and missing dates', async () => {
  const { trialFlag } = await load('worker/roster-data.js');
  const flag = (end, status = 'trial') => trialFlag(status, end, '2027-01-15');
  assert.equal(flag('2027-01-23'), null, '8 days out');
  assert.deepEqual(flag('2027-01-22'), { kind: 'ends', days: 7 });
  assert.deepEqual(flag('2027-01-16'), { kind: 'ends', days: 1 });
  assert.deepEqual(flag('2027-01-15'), { kind: 'ends', days: 0 });
  assert.deepEqual(flag('2027-01-14'), { kind: 'ended', days: -1 });
  assert.deepEqual(flag('2026-12-31'), { kind: 'ended', days: -15 });
  assert.equal(flag('2027-01-16', 'raider'), null);
  assert.equal(flag('2027-01-16', 'inactive'), null);
  assert.equal(flag(null), null);
  assert.deepEqual(trialFlag('trial', '2027-03-01', '2027-02-26'), { kind: 'ends', days: 3 }, 'across a month end');
  assert.deepEqual(trialFlag('trial', '2028-03-01', '2028-02-28'), { kind: 'ends', days: 2 }, 'leap year');
});

check('rules: todayIn around midnight in the guild zone, isRealDate', async () => {
  const { todayIn, isRealDate } = await load('worker/roster-data.js');
  const at = (iso) => Date.parse(iso);
  assert.equal(todayIn('America/New_York', at('2026-10-15T03:59:59Z')), '2026-10-14');
  assert.equal(todayIn('America/New_York', at('2026-10-15T04:00:00Z')), '2026-10-15');
  assert.equal(todayIn('America/New_York', at('2027-01-15T04:59:59Z')), '2027-01-14', 'winter offset');
  assert.equal(todayIn('Pacific/Auckland', at('2026-10-14T10:59:59Z')), '2026-10-14');
  assert.equal(todayIn('Pacific/Auckland', at('2026-10-14T11:00:00Z')), '2026-10-15');
  assert.equal(todayIn('UTC', at('2026-12-31T23:59:59Z')), '2026-12-31');
  assert.equal(todayIn('UTC', at('2027-01-01T00:00:00Z')), '2027-01-01');
  for (const good of ['2026-10-15', '2028-02-29']) assert.equal(isRealDate(good), true, good);
  for (const bad of ['2026-19-39', '2027-02-29', '2026-10-5', '10/15/2026', '', null, 20261015, '2026-10-15T00:00:00Z']) assert.equal(isRealDate(bad), false, String(bad));
});

check('rules: spec roles, the Druid Feral split and the option payload', async () => {
  const d = await load('worker/roster-data.js');
  assert.deepEqual(d.SPECS.DRUID, ['Balance', 'Feral (DPS)', 'Feral (Tank)', 'Restoration']);
  assert.equal(d.roleOf('DRUID', 'Feral (Tank)'), 'tank');
  assert.equal(d.roleOf('DRUID', 'Feral (DPS)'), 'dps');
  assert.equal(d.roleOf('PALADIN', 'Holy'), 'healer');
  assert.equal(d.roleOf('PRIEST', 'Shadow'), 'dps');
  assert.equal(d.roleOf('MAGE', 'Nope'), null);
  assert.equal(d.RAID_HELPER_SPEC.Guardian.spec, 'Feral (Tank)');
  assert.equal(d.RAID_HELPER_SPEC.Feral.spec, 'Feral (DPS)');
  assert.equal(d.RAID_HELPER_SPEC.Smite.spec, 'Discipline');
  assert.equal(d.RAID_HELPER_SPEC.Dreamstate.spec, 'Balance');
  assert.deepEqual(d.RAID_HELPER_SPEC.Holy1, { class: 'PALADIN', spec: 'Holy' });
  assert.deepEqual(d.RAID_HELPER_SPEC.Restoration1, { class: 'SHAMAN', spec: 'Restoration' });
  const options = d.rosterOptions();
  assert.deepEqual(options.classes[0], { id: 'WARRIOR', name: 'Warrior' });
  assert.equal(options.classes.length, 9);
  assert.deepEqual(options.specs.WARRIOR, ['Arms', 'Fury', 'Protection']);
  assert.equal(options.roles.WARRIOR.Protection, 'tank');
});

// ---------------------------------------------------------------------------
// People and characters

check('create person: the record shape, defaults, the Main in the same batch, trial rules and validation', async () => {
  const s = await scenario();
  const created = await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'aldric', { mainSpec: 'Arms', offSpec: 'Fury' }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const record = created.json;
  assert.equal(record.today, '2027-01-15');
  assert.deepEqual(record.can, { edit: true, notesView: true, notesEdit: true, delete: true, addCharacter: true });
  const { id: pid, ...person } = record.person;
  assert.match(pid, /^p_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(person, {
    status: 'raider', joinedOn: '2027-01-15', trialStart: null, trialEnd: null, leftOn: null, leftReason: null, trialFlag: null, isMe: false, version: 1,
    discord: { signIn: 'no_discord', user: null, nickname: null }, account: { user: null, via: null, linked: false },
    homeTeam: { id: s.teamId, name: 'Main team' },
  });
  assert.equal(record.characters.length, 1);
  const { id: cid, ...main } = record.characters[0];
  assert.match(cid, /^c_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(main, {
    name: 'Aldric', realm: 'Nightslayer', class: 'WARRIOR', mainSpec: 'Arms', offSpec: 'Fury', role: 'dps', isMain: true,
    team: { id: s.teamId, name: 'Main team', archived: false },
  });
  assert.deepEqual(record.notes, { text: '', version: 0, updatedBy: null, updatedAt: null });
  assert.deepEqual(record.rosterFlags, { [s.teamId]: 0 });
  assert.equal(await s.w.count('audit_log', "action = 'person.create'"), 1);

  // A trial: starts at the joined date; a trial end is kept, and trial dates on another status are ignored.
  const trial = await addPerson(s, 'bob', s.teamId, 'Brindle', { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-20' });
  assert.deepEqual([trial.person.status, trial.person.joinedOn, trial.person.trialStart, trial.person.trialEnd], ['trial', '2027-01-10', '2027-01-10', '2027-01-20']);
  assert.deepEqual(trial.person.trialFlag, { kind: 'ends', days: 5 });
  assert.deepEqual(trial.rosterFlags, { [s.teamId]: 1 });
  const ignored = await addPerson(s, 'bob', s.teamId, 'Cassia', { status: 'reserve', trialEnd: '2027-01-20' });
  assert.deepEqual([ignored.person.status, ignored.person.trialStart, ignored.person.trialEnd], ['reserve', null, null]);
  const noEnd = await addPerson(s, 'bob', s.teamId, 'Dunmar', { status: 'trial' });
  assert.deepEqual([noEnd.person.trialStart, noEnd.person.trialEnd, noEnd.person.trialFlag], ['2027-01-15', null, null]);

  const rejects = async (body, field, code = 400) => {
    const r = await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'Zzyzx', body));
    assert.equal(r.status, code, JSON.stringify([body, r.json]));
    if (field) assert.equal(r.json.field, field, JSON.stringify(r.json));
  };
  await rejects({ name: 'A' }, 'name');
  await rejects({ name: 'Ab1' }, 'name');
  await rejects({ class: 'PALADINN' }, 'class');
  await rejects({ class: 'MAGE', mainSpec: 'Arms' }, 'mainSpec');
  await rejects({ mainSpec: 'Arms', offSpec: 'Arms' }, 'offSpec');
  await rejects({ offSpec: 'Nope' }, 'offSpec');
  await rejects({ status: 'inactive' }, 'status');
  await rejects({ status: 'nonsense' }, 'status');
  await rejects({ joinedOn: '2027-19-39' }, 'joinedOn');
  await rejects({ status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-09' }, 'trialEnd');
  await rejects({ teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, 'teamId');
  await rejects({ teamId: 'nope' }, 'teamId');
  await rejects({ linkUserId: 'u_AAAAAAAAAAAAAAAAAAAAAA' }, 'linkUserId');
  await rejects({ linkUserId: 5 }, 'linkUserId');
  const taken = await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'ALDRIC'));
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'name_taken');
  assert.equal(taken.json.field, 'name');
  assert.deepEqual(taken.json.owner, { personId: pid, name: 'Aldric' });
  assert.equal(await s.w.count('players'), 4, 'refused creates wrote nothing');
  assert.equal(await s.w.count('characters'), 4);
  await assertOneMain(s.w);
});

check('create person: a Forever (ruleset) guild stores no realm; a realm guild stores its realm; Spec is optional', async () => {
  const s = await scenario();
  const ruleset = await secondGuild(s, { gameVersion: 'forever', realm: 'Normal' });
  const made = await s.w.call(ruleset.frank, 'POST', `${ruleset.path}/roster`, mainBody(ruleset.teamId, 'Aldric', { mainSpec: null }));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.characters[0].realm, null);
  assert.equal(made.json.characters[0].role, null);
  assert.deepEqual(await s.w.rows('SELECT realm, realm_key, main_spec FROM characters WHERE guild_id = ?', ruleset.guildId), [{ realm: null, realm_key: '', main_spec: null }]);
  const realm = await addPerson(s, 'bob', s.teamId, 'Aldric', { mainSpec: undefined });
  assert.equal(realm.characters[0].realm, 'Nightslayer');
  assert.equal((await s.w.rows('SELECT realm_key FROM characters WHERE guild_id = ?', s.guildId))[0].realm_key, 'nightslayer');
  await assertOneMain(s.w);
});

check('person record GET: Main first then by name, roles from the main spec, 404 for an unknown or malformed id', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.teams;
  const person = await addPerson(s, 'bob', alpha, 'Cassia', { class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Shadow' });
  const pid = person.person.id;
  assert.equal((await addAlt(s, 'bob', pid, bravo, 'Brindle')).status, 201);
  assert.equal((await addAlt(s, 'bob', pid, alpha, 'Aldric', { class: 'DRUID', mainSpec: 'Feral (Tank)', offSpec: 'Feral (DPS)' })).status, 201);
  assert.equal((await addAlt(s, 'bob', pid, alpha, 'Dunmar', { mainSpec: null })).status, 201);
  const got = await s.call('erin', 'GET', `/roster/${pid}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.characters.map((c) => [c.name, c.isMain, c.role, c.team.name]), [
    ['Cassia', true, 'healer', 'Alpha'], ['Aldric', false, 'tank', 'Alpha'], ['Brindle', false, 'dps', 'Bravo'], ['Dunmar', false, null, 'Alpha'],
  ]);
  assert.deepEqual(got.json.can, { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false });
  assert.equal(got.json.notes, null);
  assert.equal(got.json.person.homeTeam.name, 'Alpha');
  assert.equal((await s.call('erin', 'GET', '/roster/p_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await s.call('erin', 'GET', '/roster/not-an-id')).status, 404);
  assert.equal((await s.call('erin', 'GET', `/roster/${pid}x`)).status, 404);
  await assertOneMain(s.w);
});

check('update person: status, dates and trial history; no-op writes change nothing; validation', async () => {
  const s = await scenario();
  const trial = await addPerson(s, 'bob', s.teamId, 'Aldric', { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-18' });
  const pid = trial.person.id;
  const patch = (body) => s.call('bob', 'PATCH', `/roster/${pid}`, body);
  const leave = await patch({ expectedVersion: 1, status: 'raider' });
  assert.equal(leave.status, 200, JSON.stringify(leave.json));
  assert.deepEqual([leave.json.person.status, leave.json.person.trialStart, leave.json.person.trialEnd, leave.json.person.trialFlag, leave.json.person.version],
    ['raider', '2027-01-10', '2027-01-18', null, 2], 'leaving trial keeps the dates as history; the flag only applies to trial');
  assert.deepEqual(leave.json.rosterFlags, { [s.teamId]: 0 });
  const back = await patch({ expectedVersion: 2, status: 'trial', trialEnd: '2027-01-14' });
  assert.deepEqual([back.json.person.trialFlag, back.json.rosterFlags[s.teamId]], [{ kind: 'ended', days: -1 }, 1]);
  const extend = await patch({ expectedVersion: 3, trialEnd: '2027-02-20' });
  assert.deepEqual([extend.json.person.trialFlag, extend.json.rosterFlags[s.teamId], extend.json.person.version], [null, 0, 4], 'moving the end date clears the flag');
  const cleared = await patch({ expectedVersion: 4, joinedOn: null, trialStart: null, trialEnd: null });
  assert.deepEqual([cleared.json.person.joinedOn, cleared.json.person.trialStart, cleared.json.person.trialEnd], [null, null, null]);
  const noop = await patch({ expectedVersion: 5, status: 'trial' });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.person.version, 5, 'nothing changed: no version bump');
  assert.equal(await s.w.count('audit_log', "action = 'person.update'"), 4);

  const rejects = async (body, field) => {
    const r = await patch({ expectedVersion: 5, ...body });
    assert.equal(r.status, 400, JSON.stringify([body, r.json]));
    assert.equal(r.json.field, field, JSON.stringify(r.json));
  };
  await rejects({ status: 'gone' }, 'status');
  await rejects({ joinedOn: '2027-02-30' }, 'joinedOn');
  await rejects({ trialStart: '2027-02-10', trialEnd: '2027-02-09' }, 'trialEnd');
  await rejects({ linkUserId: 'nope' }, 'linkUserId');
  await rejects({}, 'status');
  const noVersion = await s.call('bob', 'PATCH', `/roster/${pid}`, { status: 'raider' });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.json.field, 'expectedVersion');
  assert.equal((await s.call('bob', 'PATCH', `/roster/${pid}`, { expectedVersion: '5', status: 'raider' })).status, 400);
  assert.equal((await s.call('bob', 'PATCH', '/roster/p_AAAAAAAAAAAAAAAAAAAAAA', { expectedVersion: 1, status: 'raider' })).status, 404);
  await assertOneMain(s.w);
});

check('notes: saved with their own version, text cleaned and capped, "Last edited by" recorded, cleared with empty text', async () => {
  const s = await scenario();
  const pid = (await addPerson(s, 'bob', s.teamId, 'Aldric')).person.id;
  const put = (who, body) => s.call(who, 'PUT', `/roster/${pid}/notes`, body);
  const saved = await put('carol', { text: 'Line one\r\nLine\u0000 two  \n', expectedNotesVersion: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(Object.keys(saved.json).sort(), ['notes', 'rosterFlags']);
  assert.equal(saved.json.notes.text, 'Line one\nLine two');
  assert.equal(saved.json.notes.version, 1);
  assert.equal(saved.json.notes.updatedBy.username, 'carol');
  assert.equal(saved.json.notes.updatedAt, s.w.clock.now);
  const got = await s.call('bob', 'GET', `/roster/${pid}`);
  assert.equal(got.json.notes.text, 'Line one\nLine two');
  assert.equal(got.json.person.version, 1, 'a notes save does not bump the person version');
  const cleared = await put('bob', { text: '', expectedNotesVersion: 1 });
  assert.deepEqual([cleared.json.notes.text, cleared.json.notes.version, cleared.json.notes.updatedBy.username], ['', 2, 'bob']);
  assert.equal((await s.w.rows('SELECT notes FROM players'))[0].notes, null);
  const long = await put('bob', { text: 'x'.repeat(4001), expectedNotesVersion: 2 });
  assert.equal(long.status, 400);
  assert.equal(long.json.field, 'text');
  assert.equal((await put('bob', { text: 'x'.repeat(4000), expectedNotesVersion: 2 })).status, 200);
  assert.equal((await put('bob', { text: 5, expectedNotesVersion: 3 })).json.field, 'text');
  assert.equal((await put('bob', { text: 'ok' })).json.field, 'expectedNotesVersion');
  assert.equal((await put('bob', { text: 'ok', expectedNotesVersion: -1 })).status, 400);
  assert.equal(await s.w.count('audit_log', "action = 'person.notes'"), 3);
  await assertOneMain(s.w);
});

check('characters: add, edit (class change needs valid specs), Make Main, remove; the Main is never removable', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.teams;
  const pid = (await addPerson(s, 'bob', alpha, 'Aldric')).person.id;
  const base = `/roster/${pid}/characters`;
  const added = await addAlt(s, 'bob', pid, bravo, 'Brindle', { offSpec: 'Frost' });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const alt = added.json.characters.find((c) => c.name === 'Brindle');
  assert.deepEqual([alt.isMain, alt.team.name, alt.offSpec, added.json.person.version], [false, 'Bravo', 'Frost', 1], 'character writes do not bump the person version');
  assert.deepEqual(added.json.person.homeTeam.name, 'Alpha');
  await assertOneMain(s.w);

  // Edit
  const edit = (cid, body) => s.call('bob', 'PATCH', `${base}/${cid}`, body);
  assert.equal((await edit(alt.id, {})).status, 400);
  const renamed = await edit(alt.id, { name: 'brindlez', offSpec: null });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.deepEqual(renamed.json.characters.find((c) => c.id === alt.id).name, 'Brindlez');
  assert.equal((await edit(alt.id, { name: 'Brindlez' })).status, 200, 'same name: a no-op');
  const staleSpec = await edit(alt.id, { class: 'PRIEST' });
  assert.equal(staleSpec.status, 400, 'a class change must send specs valid for the new class');
  assert.equal(staleSpec.json.field, 'mainSpec');
  const changed = await edit(alt.id, { class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Shadow' });
  assert.deepEqual(changed.json.characters.find((c) => c.id === alt.id).role, 'healer');
  const clash = await edit(alt.id, { name: 'ALDRIC' });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, 'name_taken');
  assert.equal(clash.json.owner.personId, pid);
  assert.equal((await edit(alt.id, { teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' })).json.field, 'teamId');
  assert.equal((await edit(alt.id, { class: 'NOPE' })).json.field, 'class');
  assert.equal((await edit('c_AAAAAAAAAAAAAAAAAAAAAA', { name: 'Zed' })).status, 404);
  const moved = await edit(alt.id, { teamId: alpha });
  assert.equal(moved.json.characters.find((c) => c.id === alt.id).team.name, 'Alpha');
  assert.equal(await s.w.count('audit_log', "action = 'character.update'"), 3);

  // Make Main
  const main = added.json.characters.find((c) => c.isMain);
  const makeMain = (cid) => s.call('bob', 'POST', `${base}/${cid}/main`, {});
  const swapped = await makeMain(alt.id);
  assert.equal(swapped.status, 200, JSON.stringify(swapped.json));
  assert.deepEqual(swapped.json.characters.map((c) => [c.name, c.isMain]), [['Brindlez', true], ['Aldric', false]]);
  await assertOneMain(s.w);
  const again = await makeMain(alt.id);
  assert.equal(again.status, 200, 'already the Main: a no-op reply');
  assert.equal(await s.w.count('audit_log', "action = 'character.main'"), 1);
  assert.equal((await makeMain('c_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  const other = await addPerson(s, 'bob', alpha, 'Cassia');
  assert.equal((await makeMain(other.characters[0].id)).status, 404, 'another person\'s character');
  assert.equal(await s.w.count('characters', 'is_main = 1 AND player_id = ?', pid), 1);

  // Remove
  const removeMain = await s.call('bob', 'DELETE', `${base}/${alt.id}`, {});
  assert.equal(removeMain.status, 409);
  assert.equal(removeMain.json.error, 'main_character');
  assert.equal((await s.call('bob', 'DELETE', `${base}/${other.characters[0].id}`, {})).status, 404, 'another person\'s character');
  const removed = await s.call('bob', 'DELETE', `${base}/${main.id}`, {});
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.deepEqual(removed.json.characters.map((c) => c.name), ['Brindlez']);
  assert.equal((await s.call('bob', 'DELETE', `${base}/${main.id}`, {})).status, 404, 'already gone');
  assert.equal(await s.w.count('audit_log', "action = 'character.delete'"), 1);

  // Add with makeMain, in one batch
  const promoted = await addAlt(s, 'bob', pid, alpha, 'Eliora', { makeMain: true });
  assert.equal(promoted.status, 201);
  assert.deepEqual(promoted.json.characters.map((c) => [c.name, c.isMain]), [['Eliora', true], ['Brindlez', false]]);
  assert.equal((await addAlt(s, 'bob', pid, alpha, 'Fenwick', { makeMain: 'yes' })).json.field, 'makeMain');
  assert.equal((await addAlt(s, 'bob', pid, alpha, 'Aldric')).status, 201, 'a removed name is free again');
  await assertOneMain(s.w);
});

check('delete person: removes the person and every character; the nav counts come back', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.teams;
  const trial = await addPerson(s, 'bob', alpha, 'Aldric', { status: 'trial', trialEnd: '2027-01-16' });
  assert.equal((await addAlt(s, 'bob', trial.person.id, bravo, 'Brindle')).status, 201);
  const keep = await addPerson(s, 'bob', alpha, 'Cassia');
  const removed = await s.call('bob', 'DELETE', `/roster/${trial.person.id}`, {});
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { deleted: true, rosterFlags: { [alpha]: 0, [bravo]: 0 } });
  assert.equal(await s.w.count('characters'), 1);
  assert.equal(await s.w.count('players'), 1);
  assert.equal((await s.call('bob', 'GET', `/roster/${trial.person.id}`)).status, 404);
  assert.equal((await s.call('bob', 'DELETE', `/roster/${trial.person.id}`, {})).status, 404);
  assert.equal((await s.call('bob', 'GET', `/roster/${keep.person.id}`)).status, 200);
  const [row] = await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'person.delete'");
  assert.deepEqual(JSON.parse(row.before).teamIds.sort(), [alpha, bravo].sort());
  assert.equal(row.after, null);
  await assertOneMain(s.w);
});

check('update person: Inactive records an optional reason and a left-on date; reactivating clears both; audit keeps them', async () => {
  const s = await scenario();
  const first = await addPerson(s, 'bob', s.teamId, 'Aldric');
  const pid = first.person.id;
  const patch = (body) => s.call('bob', 'PATCH', `/roster/${pid}`, body);
  const today = (await s.call('bob', 'GET', `/roster/${pid}`)).json.today;
  assert.equal(today, '2027-01-15');
  assert.deepEqual([first.person.leftOn, first.person.leftReason], [null, null]);

  // Inactive with nothing else: left on defaults to today in the guild's time zone, no reason.
  const gone = await patch({ expectedVersion: 1, status: 'inactive' });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.deepEqual([gone.json.person.status, gone.json.person.leftOn, gone.json.person.leftReason, gone.json.person.version], ['inactive', today, null, 2]);
  const listed = (await s.call('bob', 'GET', `/roster?team=${s.teamId}`)).json.people.find((p) => p.id === pid);
  assert.deepEqual([listed.leftOn, listed.leftReason], [today, null], 'the roster list carries both fields');

  // Changing them while inactive: reason alone keeps the date; an explicit null clears the date.
  const kicked = await patch({ expectedVersion: 2, leftReason: 'kicked' });
  assert.deepEqual([kicked.json.person.leftOn, kicked.json.person.leftReason], [today, 'kicked']);
  const dated = await patch({ expectedVersion: 3, leftOn: '2027-01-02' });
  assert.deepEqual([dated.json.person.leftOn, dated.json.person.leftReason, dated.json.person.version], ['2027-01-02', 'kicked', 4]);
  const undated = await patch({ expectedVersion: 4, leftOn: null, leftReason: null });
  assert.deepEqual([undated.json.person.leftOn, undated.json.person.leftReason], [null, null]);

  const rejects = async (body, field) => {
    const r = await patch({ expectedVersion: 5, ...body });
    assert.equal(r.status, 400, JSON.stringify([body, r.json]));
    assert.equal(r.json.field, field, JSON.stringify(r.json));
  };
  await rejects({ leftReason: 'quit' }, 'leftReason');
  await rejects({ leftOn: '2027-02-30' }, 'leftOn');
  await rejects({ leftOn: 'yesterday' }, 'leftOn');
  await rejects({ status: 'raider', leftOn: '2027-01-02' }, 'leftOn');
  await rejects({ status: 'trial', leftReason: 'break' }, 'leftReason');

  // Reactivation clears both; the fields are refused on a person who is not inactive.
  const back = await patch({ expectedVersion: 5, status: 'raider' });
  assert.deepEqual([back.json.person.status, back.json.person.leftOn, back.json.person.leftReason], ['raider', null, null]);
  const stale = await patch({ expectedVersion: 6, leftOn: '2027-01-02' });
  assert.equal(stale.status, 400);
  assert.equal(stale.json.field, 'leftOn', 'a raider has no left-on date');

  // Straight into Inactive with both values; then straight out again, with the values still in the audit trail.
  const both = await patch({ expectedVersion: 6, status: 'inactive', leftOn: '2027-01-05', leftReason: 'break' });
  assert.deepEqual([both.json.person.leftOn, both.json.person.leftReason], ['2027-01-05', 'break']);
  assert.equal((await patch({ expectedVersion: 7, status: 'reserve' })).status, 200);
  const trail = (await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'person.update' ORDER BY rowid")).map((row) => [JSON.parse(row.before), JSON.parse(row.after)]);
  assert.deepEqual([trail[0][0].leftOn, trail[0][1].leftOn, trail[0][1].leftReason], [null, today, null]);
  assert.deepEqual([trail[1][1].leftReason, trail[1][1].changed], ['kicked', ['leftReason']]);
  const outOf = trail[trail.length - 1];
  assert.deepEqual([outOf[0].leftOn, outOf[0].leftReason, outOf[1].leftOn, outOf[1].leftReason], ['2027-01-05', 'break', null, null]);
  await assertOneMain(s.w);
});

check('concurrency: a stale expectedVersion or expectedNotesVersion is a 409 with the current record; notes and details saves do not 409 each other', async () => {
  const s = await scenario();
  const pid = (await addPerson(s, 'bob', s.teamId, 'Aldric')).person.id;
  const patch = (who, body) => s.call(who, 'PATCH', `/roster/${pid}`, body);
  assert.equal((await patch('bob', { expectedVersion: 1, status: 'reserve' })).status, 200);
  const stale = await patch('carol', { expectedVersion: 1, status: 'inactive' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
  assert.equal(stale.json.current.person.status, 'reserve');
  assert.equal(stale.json.current.person.version, 2);
  assert.equal(stale.json.current.characters.length, 1);
  assert.equal(stale.json.current.notes.version, 0, 'an editor sees notes in current');
  assert.equal((await s.w.rows('SELECT status FROM players'))[0].status, 'reserve');

  const put = (who, body) => s.call(who, 'PUT', `/roster/${pid}/notes`, body);
  assert.equal((await put('bob', { text: 'first', expectedNotesVersion: 0 })).status, 200);
  const staleNotes = await put('carol', { text: 'second', expectedNotesVersion: 0 });
  assert.equal(staleNotes.status, 409);
  assert.deepEqual(Object.keys(staleNotes.json.current), ['notes']);
  assert.equal(staleNotes.json.current.notes.text, 'first');
  // Details (version 2) and notes (version 1) move independently.
  assert.equal((await patch('bob', { expectedVersion: 2, status: 'raider' })).status, 200);
  assert.equal((await put('carol', { text: 'third', expectedNotesVersion: 1 })).status, 200);
  assert.equal((await patch('carol', { expectedVersion: 3, status: 'trial' })).status, 200);
  assert.equal((await put('bob', { text: 'fourth', expectedNotesVersion: 2 })).status, 200);

  // The version check also guards the write itself: a change that lands between the read and the write wins.
  const real = s.w.db.batch.bind(s.w.db);
  let armed = true;
  s.w.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /UPDATE players SET status/.test(statement.sql))) {
      armed = false;
      exec(s.w, "UPDATE players SET version = version + 1");
    }
    return real(statements);
  };
  const raced = await patch('bob', { expectedVersion: 4, status: 'reserve' });
  s.w.db.batch = real;
  assert.equal(raced.status, 409);
  assert.equal(raced.json.current.person.status, 'trial');
  assert.equal(await s.w.count('audit_log', "action = 'person.update'"), 3, 'the lost write left no audit row');
  await assertOneMain(s.w);
});

check('caps: person_limit and character_limit are 409s and nothing lands', async () => {
  const s = await scenario();
  const pid = (await addPerson(s, 'bob', s.teamId, 'Aldric')).person.id;
  exec(s.w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
             INSERT INTO players (id, guild_id, status, created_at, updated_at) SELECT 'fill' || i, '${s.guildId}', 'raider', 1, 1 FROM n`);
  // 1 + 999 = 1000 people: the cap. (The fill rows have no Main; they are removed again before the invariant check.)
  const full = await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'Brindle'));
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'person_limit');
  assert.equal(await s.w.count('characters'), 1);
  exec(s.w, "DELETE FROM players WHERE id LIKE 'fill%'");
  exec(s.w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19)
             INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at)
             SELECT 'x' || i, '${s.guildId}', '${pid}', '${s.teamId}', 'Fill' || i, 'fill' || i, 'MAGE', 1, 1 FROM n`);
  const tooMany = await addAlt(s, 'bob', pid, s.teamId, 'Zedd');
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.json.error, 'character_limit');
  assert.equal(await s.w.count('audit_log', "action = 'character.create'"), 0, 'the audit row rolled back with the insert');
  await assertOneMain(s.w);
});

// ---------------------------------------------------------------------------
// The roster list

check('GET /roster: one row per person with a character on the team, the shown character, counts, sign-in and "me"', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.teams;
  const p1 = await addPerson(s, 'bob', alpha, 'Aldric', { status: 'trial', trialEnd: '2027-01-17', linkUserId: s.ids.erin });
  await addAlt(s, 'bob', p1.person.id, bravo, 'Brindle');
  const p2 = await addPerson(s, 'bob', bravo, 'Cassia', { class: 'PRIEST', mainSpec: 'Holy' });
  await addAlt(s, 'bob', p2.person.id, alpha, 'Dunmar', { class: 'ROGUE', mainSpec: 'Combat' });
  await addAlt(s, 'bob', p2.person.id, alpha, 'Charis', { class: 'ROGUE', mainSpec: null });
  await addAlt(s, 'bob', p2.person.id, bravo, 'Eliora');
  const p3 = await addPerson(s, 'bob', bravo, 'Fenwick');
  await s.call('bob', 'PATCH', `/roster/${p3.person.id}`, { expectedVersion: 1, status: 'inactive' });
  exec(s.w, `UPDATE players SET discord_user_id = '300000000000000001' WHERE id = '${p2.person.id}'`);

  const alphaList = await s.call('erin', 'GET', `/roster?team=${alpha}`);
  assert.equal(alphaList.status, 200, JSON.stringify(alphaList.json));
  assert.deepEqual(alphaList.json.team, { id: alpha, name: 'Alpha', archived: false, trialDays: 14 });
  assert.equal(alphaList.json.today, '2027-01-15');
  assert.deepEqual(alphaList.json.can, { edit: false });
  const [first, second] = alphaList.json.people;
  assert.deepEqual(alphaList.json.people.map((p) => p.shown.name), ['Aldric', 'Charis'], 'Aldric is a Main on Alpha; P2 shows its first Alt on Alpha by name');
  assert.deepEqual(first.shown, { id: p1.characters[0].id, name: 'Aldric', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, role: 'dps', isMain: true });
  assert.deepEqual([first.status, first.trialFlag, first.altCount, first.signIn, first.isMe, first.main.team], ['trial', { kind: 'ends', days: 2 }, 1, 'signed_in', true, { id: alpha, name: 'Alpha' }]);
  assert.deepEqual([first.version, second.version], [1, 1], 'list rows carry the person version (the same one the person record has)');
  assert.deepEqual(second.shown, { id: second.shown.id, name: 'Charis', class: 'ROGUE', mainSpec: null, offSpec: null, role: null, isMain: false });
  assert.deepEqual([second.main.name, second.main.class, second.main.team, second.altCount, second.signIn, second.isMe], ['Cassia', 'PRIEST', { id: bravo, name: 'Bravo' }, 3, 'not_yet', false]);
  assert.equal(JSON.stringify(alphaList.json).includes('nickname'), false);

  const bravoList = await s.call('bob', 'GET', `/roster?team=${bravo}`);
  assert.deepEqual(bravoList.json.can, { edit: true });
  assert.deepEqual(bravoList.json.people.map((p) => [p.shown.name, p.status, p.altCount]), [['Brindle', 'trial', 1], ['Cassia', 'raider', 3], ['Fenwick', 'inactive', 0]],
    'inactive people are listed too; the browser filters');
  assert.equal((await s.call('carol', 'GET', `/roster?team=${bravo}`)).json.can.edit, false);
  for (const bad of ['', '?team=', '?team=nope', `?team=t_AAAAAAAAAAAAAAAAAAAAAA`]) {
    const r = await s.call('erin', 'GET', `/roster${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.json.field, 'team');
  }
  const foreign = await secondGuild(s);
  assert.equal((await s.call('erin', 'GET', `/roster?team=${foreign.teamId}`)).json.field, 'team');
  await assertOneMain(s.w);
});

// ---------------------------------------------------------------------------
// Permissions

const ACTORS = ['alice', 'bob', 'carol', 'dave', 'erin'];

check('permissions: every role x request in the spec table (Guild Master, Officer, Team Lead of one team each, Member)', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  let counter = 0;
  const fresh = () => nameFor(counter++);
  // A person homed on `home` (their Main), with an optional Alt on `altTeam`.
  const person = async (home, altTeam = null) => {
    const record = await addPerson(s, 'bob', home, fresh());
    if (altTeam) {
      const withAlt = await addAlt(s, 'bob', record.person.id, altTeam, fresh());
      assert.equal(withAlt.status, 201);
      return { pid: record.person.id, main: record.characters[0], alt: withAlt.json.characters.find((c) => !c.isMain), version: record.person.version };
    }
    return { pid: record.person.id, main: record.characters[0], version: record.person.version };
  };
  const matrix = async (label, run, allowed, ok = 200) => {
    s.w.advance(61 * 1000); // a fresh rate-limit window for every row of the table
    for (const who of ACTORS) {
      const r = await run(who);
      assert.equal(r.status, allowed.includes(who) ? ok : 403, `${label} as ${who}: ${JSON.stringify(r.json)}`);
    }
  };
  const everyone = ACTORS;

  await matrix('roster list', (who) => s.call(who, 'GET', `/roster?team=${A}`), everyone);
  await matrix('person record', async (who) => s.call(who, 'GET', `/roster/${(await person(A)).pid}`), everyone);
  await matrix('create a person on A', (who) => s.call(who, 'POST', '/roster', mainBody(A, fresh())), ['alice', 'bob', 'carol'], 201);
  await matrix('create a person on B', (who) => s.call(who, 'POST', '/roster', mainBody(B, fresh())), ['alice', 'bob', 'dave'], 201);
  await matrix('update a person homed on A', async (who) => {
    const p = await person(A);
    return s.call(who, 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.version, status: 'reserve' });
  }, ['alice', 'bob', 'carol']);
  await matrix('update a person homed on B who has an Alt on A (the home team decides)', async (who) => {
    const p = await person(B, A);
    return s.call(who, 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.version, status: 'reserve' });
  }, ['alice', 'bob', 'dave']);
  await matrix('save notes (home A)', async (who) => s.call(who, 'PUT', `/roster/${(await person(A)).pid}/notes`, { text: 'x', expectedNotesVersion: 0 }), ['alice', 'bob', 'carol']);
  await matrix('delete a person on A only', async (who) => s.call(who, 'DELETE', `/roster/${(await person(A)).pid}`, {}), ['alice', 'bob', 'carol']);
  await matrix('delete a person with characters on A and B (every team needed)', async (who) => s.call(who, 'DELETE', `/roster/${(await person(A, B)).pid}`, {}), ['alice', 'bob']);
  await matrix('add an Alt on A to a person homed on A', async (who) => addAlt(s, who, (await person(A)).pid, A, fresh()), ['alice', 'bob', 'carol'], 201);
  await matrix('add an Alt on B to a person homed on A (needs both teams)', async (who) => addAlt(s, who, (await person(A)).pid, B, fresh()), ['alice', 'bob'], 201);
  await matrix('add an Alt on A to a person homed on B (a Team Lead cannot attach to a foreign person)', async (who) => addAlt(s, who, (await person(B)).pid, A, fresh()), ['alice', 'bob'], 201);
  await matrix('add an Alt on B to a person homed on B', async (who) => addAlt(s, who, (await person(B)).pid, B, fresh()), ['alice', 'bob', 'dave'], 201);
  await matrix('edit a character on A', async (who) => {
    const p = await person(A);
    return s.call(who, 'PATCH', `/roster/${p.pid}/characters/${p.main.id}`, { name: fresh() });
  }, ['alice', 'bob', 'carol']);
  await matrix('move a character from A to B (needs both teams)', async (who) => {
    const p = await person(A);
    return s.call(who, 'PATCH', `/roster/${p.pid}/characters/${p.main.id}`, { teamId: B });
  }, ['alice', 'bob']);
  await matrix('edit an Alt on B of a person homed on A (the character\'s team decides)', async (who) => {
    const p = await person(A, B);
    return s.call(who, 'PATCH', `/roster/${p.pid}/characters/${p.alt.id}`, { name: fresh() });
  }, ['alice', 'bob', 'dave']);
  await matrix('Make Main across teams (current Main team and new Main team)', async (who) => {
    const p = await person(A, B);
    return s.call(who, 'POST', `/roster/${p.pid}/characters/${p.alt.id}/main`, {});
  }, ['alice', 'bob']);
  await matrix('Make Main within one team', async (who) => {
    const p = await person(A, A);
    return s.call(who, 'POST', `/roster/${p.pid}/characters/${p.alt.id}/main`, {});
  }, ['alice', 'bob', 'carol']);
  await matrix('remove an Alt on B of a person homed on A (the character\'s team decides)', async (who) => {
    const p = await person(A, B);
    return s.call(who, 'DELETE', `/roster/${p.pid}/characters/${p.alt.id}`, {});
  }, ['alice', 'bob', 'dave']);
  await matrix('linkable members', (who) => s.call(who, 'GET', '/roster/linkable'), ['alice', 'bob', 'carol', 'dave']);
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [signUp(1, DID(1), 'Aldric', 'Mage', 'Fire')]));
  await matrix('Raid-Helper preview for A', (who) => s.call(who, 'POST', '/roster/import/raid-helper/preview', { teamId: A, source: EVENT_ID }), ['alice', 'bob', 'carol']);
  await matrix('Raid-Helper preview for B', (who) => s.call(who, 'POST', '/roster/import/raid-helper/preview', { teamId: B, source: EVENT_ID }), ['alice', 'bob', 'dave']);
  s.w.sources.reports.set('Fake000000000001', { title: 'Log', startTime: 1, zone: null, masterData: { actors: [] } });
  await matrix('Warcraft Logs preview for A', (who) => s.call(who, 'POST', '/roster/import/wcl/preview', { teamId: A, source: 'Fake000000000001' }), ['alice', 'bob', 'carol']);
  await matrix('Warcraft Logs commit for B', (who) => s.call(who, 'POST', '/roster/import/wcl/commit', { teamId: B, report: { code: 'Fake000000000001', flavour: 'fresh' }, decisions: [] }), ['alice', 'bob', 'dave'], 200);
  await assertOneMain(s.w);
});

check('permissions: a Team Lead cannot gain rights over a person by attaching a character; moves into a team they do not lead are refused', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const foreign = await addPerson(s, 'bob', B, 'Aldric');
  const attach = await addAlt(s, 'carol', foreign.person.id, A, 'Brindle');
  assert.equal(attach.status, 403, 'carol leads A, the person is homed on B');
  assert.equal(await s.w.count('characters'), 1);
  const mine = await addPerson(s, 'carol', A, 'Cassia');
  const move = await s.call('carol', 'PATCH', `/roster/${mine.person.id}/characters/${mine.characters[0].id}`, { teamId: B });
  assert.equal(move.status, 403);
  assert.equal((await s.call('carol', 'GET', `/roster/${mine.person.id}`)).json.person.homeTeam.id, A);
  assert.equal((await s.call('carol', 'PATCH', `/roster/${foreign.person.id}`, { expectedVersion: 1, status: 'inactive' })).status, 403);
  assert.equal((await s.call('dave', 'GET', `/roster/${foreign.person.id}`)).json.can.edit, true);
  await assertOneMain(s.w);
});

check('permissions: members never get notes, nicknames or rosterFlags; a 409 `current` is built through the same redaction', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const trial = await addPerson(s, 'bob', A, 'Aldric', { status: 'trial', trialEnd: '2027-01-16' });
  const pid = trial.person.id;
  await s.call('bob', 'PUT', `/roster/${pid}/notes`, { text: 'Officer eyes only', expectedNotesVersion: 0 });
  exec(s.w, `UPDATE players SET discord_user_id = '300000000000000009', discord_nickname = 'SecretNick' WHERE id = '${pid}'`);
  const view = async (who) => (await s.call(who, 'GET', `/roster/${pid}`)).json;
  for (const who of ['alice', 'bob', 'carol']) {
    const v = await view(who);
    assert.equal(v.person.discord.nickname, 'SecretNick', who);
    assert.equal(v.notes.text, 'Officer eyes only', who);
  }
  for (const who of ['dave', 'erin']) {
    const v = await view(who);
    assert.equal(v.person.discord.nickname, null, who);
    assert.equal(v.notes, null, who);
    assert.equal(JSON.stringify(v).includes('SecretNick') || JSON.stringify(v).includes('Officer eyes only'), false, who);
    assert.equal(JSON.stringify((await s.call(who, 'GET', `/roster?team=${A}`)).json).includes('SecretNick'), false);
  }
  const flags = async (who) => (await s.call(who, 'GET', '')).json.rosterFlags;
  assert.deepEqual(await flags('erin'), {});
  assert.deepEqual(await flags('carol'), { [A]: 1 }, 'a Team Lead sees only their team');
  assert.deepEqual(await flags('dave'), { [B]: 0 });
  assert.deepEqual(await flags('bob'), { [A]: 1, [B]: 0 });
  assert.deepEqual(await flags('alice'), { [A]: 1, [B]: 0 });

  // The redaction is one builder: a viewer without the notes right gets `notes: null` in a conflict too.
  exec(s.w, "DELETE FROM role_permissions WHERE role_id = 'team_lead' AND action = 'roster.notes.view'");
  const stale = await s.call('carol', 'PATCH', `/roster/${pid}`, { expectedVersion: 99, status: 'raider' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current.notes, null);
  assert.equal(stale.json.current.can.notesView, false);
  assert.equal(stale.json.current.person.discord.nickname, 'SecretNick', 'she can edit, so the nickname stays');
  const view2 = await load('worker/roster-view.js');
  const data = { player: { id: pid, status: 'raider', notes: 'N', notes_version: 1, discord_user_id: '3', discord_nickname: 'Nick', version: 1 }, characters: [{ row: { is_main: 1 }, view: { team: { id: A, name: 'A' } } }], linkedUser: null, notesUser: null };
  const member = view2.buildPersonRecord({ can: { 'roster.view': 'guild' } }, data, '2027-01-15', { discordId: '9' });
  assert.deepEqual([member.notes, member.person.discord.nickname, member.can.edit], [null, null, false]);
  await assertOneMain(s.w);
});

check('permissions: person and character ids from another guild are 404; a foreign team id is a 400', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  const theirs = await s.w.call(other.frank, 'POST', `${other.path}/roster`, mainBody(other.teamId, 'Zandor'));
  const mine = await addPerson(s, 'bob', s.teamId, 'Aldric');
  const [pid, cid] = [theirs.json.person.id, theirs.json.characters[0].id];
  for (const [method, route, body] of [
    ['GET', `/roster/${pid}`], ['PATCH', `/roster/${pid}`, { expectedVersion: 1, status: 'reserve' }],
    ['PUT', `/roster/${pid}/notes`, { text: 'x', expectedNotesVersion: 0 }], ['DELETE', `/roster/${pid}`, {}],
    ['POST', `/roster/${pid}/characters`, { name: 'Brindle', class: 'MAGE', teamId: s.teamId }],
    ['PATCH', `/roster/${pid}/characters/${cid}`, { name: 'Brindle' }], ['POST', `/roster/${pid}/characters/${cid}/main`, {}],
    ['DELETE', `/roster/${pid}/characters/${cid}`, {}],
    ['PATCH', `/roster/${mine.person.id}/characters/${cid}`, { name: 'Brindle' }], ['DELETE', `/roster/${mine.person.id}/characters/${cid}`, {}],
  ]) {
    const r = await s.call('alice', method, route, body);
    assert.equal(r.status, 404, `${method} ${route}: ${JSON.stringify(r.json)}`);
  }
  assert.equal((await s.call('alice', 'POST', '/roster', mainBody(other.teamId, 'Brindle'))).json.field, 'teamId');
  assert.equal((await s.call('alice', 'POST', `/roster/${mine.person.id}/characters`, { name: 'Brindle', class: 'MAGE', teamId: other.teamId })).json.field, 'teamId');
  assert.equal((await s.call('alice', 'POST', '/roster/import/raid-helper/preview', { teamId: other.teamId, source: EVENT_ID })).json.field, 'teamId');
  assert.equal(await s.w.count('characters', 'guild_id = ?', other.guildId), 1, 'the other guild is untouched');
  // Alice is not in that guild's Discord server at all.
  assert.equal((await s.w.call(s.alice, 'GET', `${other.path}/roster/${pid}`)).status, 403);
  await assertOneMain(s.w);
});

// ---------------------------------------------------------------------------
// Linking

check('linking: officers link by u_ id; linkable excludes blocked, linked and non-server users; already_linked; unlinking clears the nickname', async () => {
  const s = await scenario();
  await secondGuild(s);
  const gina = await signIn(s.w, PEOPLE.gina, [plain(SERVER_B)]);
  const ginaId = (await s.w.call(gina, 'GET', '/auth/me')).json.user.id;
  assert.equal((await s.call('alice', 'POST', `/people/${s.ids.dave}/block`, { reason: 'x' })).status, 200);

  const linked = await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'Aldric', { linkUserId: s.ids.erin }));
  assert.equal(linked.status, 201, JSON.stringify(linked.json));
  assert.deepEqual([linked.json.person.discord.signIn, linked.json.person.discord.user.username, linked.json.person.discord.nickname], ['signed_in', 'erin', null]);
  assert.equal(linked.json.person.isMe, false);
  const own = await s.call('erin', 'GET', `/roster/${linked.json.person.id}`);
  assert.equal(own.json.person.isMe, true);
  assert.deepEqual(own.json.can, { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false });

  const names = async () => (await s.call('bob', 'GET', '/roster/linkable')).json.users.map((u) => u.username).sort();
  assert.deepEqual(await names(), ['alice', 'bob', 'carol'], 'erin is linked, dave is blocked, gina is not in this Discord server');
  assert.equal(JSON.stringify((await s.call('bob', 'GET', '/roster/linkable')).json).includes('1100000000'), false, 'no raw Discord ids');

  const second = await addPerson(s, 'bob', s.teamId, 'Brindle');
  const patch = (body) => s.call('bob', 'PATCH', `/roster/${second.person.id}`, { expectedVersion: 1, ...body });
  const taken = await patch({ linkUserId: s.ids.erin });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'already_linked');
  assert.equal((await s.call('bob', 'POST', '/roster', mainBody(s.teamId, 'Cassia', { linkUserId: s.ids.erin }))).json.error, 'already_linked');
  assert.equal((await patch({ linkUserId: ginaId })).json.field, 'linkUserId');
  assert.equal((await patch({ linkUserId: s.ids.dave })).json.field, 'linkUserId', 'blocked');
  assert.equal((await patch({ linkUserId: 'u_AAAAAAAAAAAAAAAAAAAAAA' })).json.field, 'linkUserId');
  const same = await s.call('bob', 'PATCH', `/roster/${linked.json.person.id}`, { expectedVersion: 1, linkUserId: s.ids.erin });
  assert.equal(same.status, 200);
  assert.equal(same.json.person.version, 1, 'linking the same member again is a no-op');

  exec(s.w, `UPDATE players SET discord_nickname = 'SomeNick' WHERE id = '${linked.json.person.id}'`);
  const unlinked = await s.call('bob', 'PATCH', `/roster/${linked.json.person.id}`, { expectedVersion: 1, linkUserId: null });
  assert.equal(unlinked.status, 200);
  assert.deepEqual([unlinked.json.person.discord.signIn, unlinked.json.person.discord.user, unlinked.json.person.discord.nickname], ['no_discord', null, null]);
  assert.deepEqual(await s.w.rows('SELECT discord_user_id, discord_nickname FROM players WHERE id = ?', linked.json.person.id), [{ discord_user_id: null, discord_nickname: null }]);
  assert.deepEqual(await names(), ['alice', 'bob', 'carol', 'erin']);
  assert.equal((await patch({ linkUserId: s.ids.erin })).status, 200, 'free again');
  // Linking a different member drops the old member's nickname.
  exec(s.w, `UPDATE players SET discord_nickname = 'OtherNick' WHERE id = '${second.person.id}'`);
  assert.equal((await s.call('bob', 'PATCH', `/roster/${second.person.id}`, { expectedVersion: 2, linkUserId: s.ids.carol })).status, 200);
  assert.deepEqual(await s.w.rows('SELECT discord_nickname FROM players WHERE id = ?', second.person.id), [{ discord_nickname: null }]);
  await assertOneMain(s.w);
});

check('linking: a person is linked when a user holds their Discord ID, read on the fly (not_yet becomes signed_in with no write)', async () => {
  const s = await scenario();
  const pid = (await addPerson(s, 'bob', s.teamId, 'Aldric')).person.id;
  exec(s.w, `UPDATE players SET discord_user_id = '${DID(1)}' WHERE id = '${pid}'`);
  const before = await s.call('bob', 'GET', `/roster/${pid}`);
  assert.deepEqual([before.json.person.discord.signIn, before.json.person.discord.user, before.json.person.isMe], ['not_yet', null, false]);
  const newbie = await signIn(s.w, { id: DID(1), username: 'newbie', globalName: null }, [plain(SERVER_A)]);
  const writes = await s.w.count('audit_log');
  const after = await s.w.call(newbie, 'GET', `/api/guild/${s.guildId}/roster/${pid}`);
  assert.deepEqual([after.json.person.discord.signIn, after.json.person.discord.user.username, after.json.person.isMe], ['signed_in', 'newbie', true]);
  assert.equal(await s.w.count('audit_log'), writes);
  const list = await s.w.call(newbie, 'GET', `/api/guild/${s.guildId}/roster?team=${s.teamId}`);
  assert.deepEqual([list.json.people[0].signIn, list.json.people[0].isMe], ['signed_in', true]);
  await assertOneMain(s.w);
});

check('own_teams: a Member\'s own characters give them their teams; the set merges with Team Lead scope; resolvePermissions takes ownTeamIds', async () => {
  const { resolvePermissions } = await load('worker/permissions.js');
  const seeded = [
    { role_id: 'member', action: 'attendance.view', scope: 'own_teams' }, { role_id: 'member', action: 'roster.view', scope: 'guild' },
    { role_id: 'team_lead', action: 'attendance.view', scope: 'team' },
  ];
  assert.deepEqual(resolvePermissions([], seeded).can['attendance.view'], [], 'default: no own teams');
  assert.deepEqual(resolvePermissions([], seeded, ['t_b', 't_a']).can['attendance.view'], ['t_a', 't_b']);
  assert.deepEqual(resolvePermissions([{ role_id: 'team_lead', team_id: 't_a' }], seeded, ['t_b', 't_a']).can['attendance.view'], ['t_a', 't_b'], 'merged, no duplicates');
  assert.deepEqual(resolvePermissions([{ role_id: 'team_lead', team_id: 't_c' }], seeded, ['t_b']).can['attendance.view'], ['t_b', 't_c']);

  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const erinPerson = await addPerson(s, 'bob', A, 'Aldric', { linkUserId: s.ids.erin });
  assert.deepEqual((await s.call('erin', 'GET', '')).json.me.can['attendance.view'], [A]);
  assert.equal((await addAlt(s, 'bob', erinPerson.person.id, B, 'Brindle')).status, 201);
  assert.deepEqual((await s.call('erin', 'GET', '')).json.me.can['attendance.view'], [A, B].sort());
  await addPerson(s, 'bob', B, 'Cassia', { linkUserId: s.ids.carol });
  assert.deepEqual((await s.call('carol', 'GET', '')).json.me.can['attendance.view'], [A, B].sort(), 'Team Lead of A + own team B');
  assert.equal((await s.call('carol', 'GET', '')).json.me.can['roster.edit'].length, 1, 'own teams grant no roster rights');
  assert.deepEqual((await s.call('bob', 'GET', '')).json.me.can['attendance.view'], 'guild');
  await assertOneMain(s.w);
});

check('delete my data: links go (every guild), rows stay, the nickname is cleared, and the imp:<id> window is removed with w:<id>', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  const erin = await signIn(s.w, PEOPLE.erin, [plain(SERVER_A), plain(SERVER_B)]);
  const erinId = (await s.w.call(erin, 'GET', '/auth/me')).json.user.id;
  const mine = await addPerson(s, 'bob', s.teamId, 'Aldric', { linkUserId: erinId });
  const theirs = await s.w.call(other.frank, 'POST', `${other.path}/roster`, mainBody(other.teamId, 'Zandor', { linkUserId: erinId }));
  assert.equal(theirs.status, 201, JSON.stringify(theirs.json));
  const bystander = await addPerson(s, 'bob', s.teamId, 'Brindle');
  exec(s.w, "UPDATE players SET discord_nickname = 'ErinNick' WHERE discord_user_id IS NOT NULL");
  exec(s.w, `INSERT INTO rate_limits (key, window_start, count) VALUES ('imp:${erinId}', 1, 3), ('imp:someoneelse', 1, 3)`);
  await s.w.call(erin, 'PATCH', '/auth/prefs', { sidebarCollapsed: true });
  assert.equal(await s.w.count('rate_limits', 'key = ?', `w:${erinId}`), 1);
  const before = await s.w.rows('SELECT id, version FROM players ORDER BY id');
  const deleted = await s.w.call(erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  const rows = await s.w.rows('SELECT id, discord_user_id, discord_nickname, version FROM players ORDER BY id');
  assert.equal(rows.length, 3, 'no person is deleted');
  for (const row of rows) {
    if (row.id === bystander.person.id) { assert.equal(row.version, 1); continue; }
    assert.deepEqual([row.discord_user_id, row.discord_nickname, row.version], [null, null, 2], row.id);
  }
  assert.equal(before.length, 3);
  assert.equal(await s.w.count('characters'), 3);
  assert.equal(await s.w.count('rate_limits', 'key IN (?, ?)', `w:${erinId}`, `imp:${erinId}`), 0);
  assert.equal(await s.w.count('rate_limits', "key = 'imp:someoneelse'"), 1);
  const seen = await s.call('bob', 'GET', `/roster/${mine.person.id}`);
  assert.equal(seen.json.person.discord.signIn, 'no_discord');
  await assertOneMain(s.w);
});

// ---------------------------------------------------------------------------
// Guild payload, People and roles, Teams, archived teams, routing

check('guild payload: rosterOptions and rosterFlags (per HOME team, only for teams the viewer can edit); mutation replies refresh the counts', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const { rosterOptions } = await load('worker/roster-data.js');
  const payload = (await s.call('erin', 'GET', '')).json;
  assert.deepEqual(payload.rosterOptions, rosterOptions());
  assert.deepEqual(payload.rosterFlags, {});
  await addPerson(s, 'bob', A, 'Aldric', { status: 'trial', trialEnd: '2027-01-18' });
  const ended = await addPerson(s, 'bob', B, 'Brindle', { status: 'trial', joinedOn: '2027-01-01', trialEnd: '2027-01-10' });
  await addPerson(s, 'bob', A, 'Cassia', { status: 'trial', trialEnd: '2027-03-01' });
  await addPerson(s, 'bob', A, 'Dunmar', { status: 'raider' });
  const homeA = await addPerson(s, 'bob', A, 'Eliora', { status: 'trial', trialEnd: '2027-01-15' });
  assert.equal((await addAlt(s, 'bob', homeA.person.id, B, 'Fenwick')).status, 201, 'an Alt on B does not move the flag to B');
  assert.deepEqual((await s.call('bob', 'GET', '')).json.rosterFlags, { [A]: 2, [B]: 1 });
  assert.deepEqual((await s.call('carol', 'GET', '')).json.rosterFlags, { [A]: 2 });
  assert.deepEqual((await s.call('dave', 'GET', '')).json.rosterFlags, { [B]: 1 });
  assert.deepEqual((await s.call('erin', 'GET', '')).json.rosterFlags, {});
  const cleared = await s.call('bob', 'PATCH', `/roster/${ended.person.id}`, { expectedVersion: 1, trialEnd: '2027-02-28' });
  assert.deepEqual(cleared.json.rosterFlags, { [A]: 2, [B]: 0 });
  const decided = await s.call('bob', 'PATCH', `/roster/${homeA.person.id}`, { expectedVersion: 1, status: 'raider' });
  assert.deepEqual(decided.json.rosterFlags, { [A]: 1, [B]: 0 });
  // Time zones: the flag follows the guild's calendar date. Ends in 8 days in New York, in 7 in Auckland.
  const edge = await addPerson(s, 'bob', A, 'Gilda', { status: 'trial', trialEnd: '2027-01-23' });
  assert.deepEqual(edge.rosterFlags, { [A]: 1, [B]: 0 });
  exec(s.w, `UPDATE guilds SET time_zone = 'Pacific/Auckland' WHERE id = '${s.guildId}'`);
  s.w.advance(5 * 60 * 60 * 1000);
  assert.equal((await s.call('bob', 'GET', `/roster?team=${A}`)).json.today, '2027-01-16');
  assert.deepEqual((await s.call('bob', 'GET', '')).json.rosterFlags, { [A]: 2, [B]: 0 });
  assert.deepEqual((await s.call('bob', 'GET', `/roster?team=${A}`)).json.people.find((p) => p.shown.name === 'Gilda').trialFlag, { kind: 'ends', days: 7 });
  await assertOneMain(s.w);
});

check('People and roles: `roster` is null or { personId, name, class } (the Main); Teams: `players` counts people who are not inactive', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const linked = await addPerson(s, 'bob', A, 'Aldric', { linkUserId: s.ids.erin, class: 'PRIEST', mainSpec: 'Holy' });
  await addAlt(s, 'bob', linked.person.id, B, 'Brindle');
  const people = (await s.call('alice', 'GET', '/people')).json.people;
  assert.deepEqual(people.find((p) => p.person.username === 'erin').roster, { personId: linked.person.id, name: 'Aldric', class: 'PRIEST' });
  assert.equal(people.find((p) => p.person.username === 'bob').roster, null);
  const inactive = await addPerson(s, 'bob', B, 'Cassia');
  await s.call('bob', 'PATCH', `/roster/${inactive.person.id}`, { expectedVersion: 1, status: 'inactive' });
  await addPerson(s, 'bob', B, 'Dunmar');
  const teams = (await s.call('alice', 'GET', '')).json.teams;
  assert.deepEqual(teams.map((t) => [t.name, t.players]), [['Alpha', 1], ['Bravo', 2]], 'Bravo: Aldric (via the Alt) and Dunmar; Cassia is inactive');
  assert.equal((await s.call('alice', 'PATCH', `/teams/${B}`, { archived: true })).json.team.players, 2, 'archived teams are counted too');
  await assertOneMain(s.w);
});

check('archived teams: the roster opens read/edit, but nothing new can target them; characters on them can be moved out', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const person = await addPerson(s, 'bob', B, 'Aldric');
  const alt = (await addAlt(s, 'bob', person.person.id, A, 'Brindle')).json.characters.find((c) => !c.isMain);
  assert.equal((await s.call('alice', 'PATCH', `/teams/${B}`, { archived: true })).status, 200);
  const list = await s.call('erin', 'GET', `/roster?team=${B}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.team, { id: B, name: 'Bravo', archived: true, trialDays: 14 });
  assert.equal(list.json.people.length, 1);
  assert.equal((await s.call('bob', 'GET', `/roster/${person.person.id}`)).json.characters[0].team.archived, true);
  assert.equal((await s.call('bob', 'POST', '/roster', mainBody(B, 'Cassia'))).json.field, 'teamId');
  assert.equal((await addAlt(s, 'bob', person.person.id, B, 'Dunmar')).json.field, 'teamId');
  assert.equal((await s.call('bob', 'PATCH', `/roster/${person.person.id}/characters/${alt.id}`, { teamId: B })).json.field, 'teamId');
  assert.equal((await s.call('bob', 'POST', '/roster/import/raid-helper/preview', { teamId: B, source: EVENT_ID })).json.field, 'teamId');
  assert.equal((await s.call('bob', 'POST', '/roster/import/wcl/commit', { teamId: B, report: { code: 'Fake000000000001', flavour: 'fresh' }, decisions: [] })).json.field, 'teamId');
  // An existing character on the archived team can still be edited and moved out.
  const main = person.characters[0];
  assert.equal((await s.call('bob', 'PATCH', `/roster/${person.person.id}/characters/${main.id}`, { name: 'Aldrick' })).status, 200);
  const out = await s.call('bob', 'PATCH', `/roster/${person.person.id}/characters/${main.id}`, { teamId: A });
  assert.equal(out.status, 200);
  assert.equal(out.json.person.homeTeam.id, A, 'moving the Main moves the home team');
  assert.equal((await s.call('alice', 'GET', '')).json.teams.find((t) => t.id === B).players, 0);
  await assertOneMain(s.w);
});

check('routing: GET /roster/linkable reaches its handler, not :pid; other literal paths and malformed ids', async () => {
  const s = await scenario();
  const linkable = await s.call('bob', 'GET', '/roster/linkable');
  assert.equal(linkable.status, 200);
  assert(Array.isArray(linkable.json.users));
  assert.equal((await s.call('erin', 'GET', '/roster/linkable')).json.error, 'forbidden', 'the linkable handler, not the person lookup');
  assert.equal((await s.call('bob', 'PATCH', '/roster/linkable', { expectedVersion: 1, status: 'raider' })).status, 404);
  assert.equal((await s.call('bob', 'GET', '/roster/import')).status, 404);
  const wrongMethod = await s.call('bob', 'GET', '/roster/import/wcl/preview');
  assert.equal(wrongMethod.status, 405);
  assert.equal((await s.call('bob', 'GET', '/roster/p_AAAAAAAAAAAAAAAAAAAAAA/characters')).status, 405);
  assert.equal((await s.call('bob', 'GET', '/roster/p_AAAAAAAAAAAAAAAAAAAAAA/characters/c_AAAAAAAAAAAAAAAAAAAAAA')).status, 405);
  assert.equal((await s.call('bob', 'POST', '/roster/p_bad/characters', {})).status, 404);
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}/roster/linkable`)).status, 401);
});

// ---------------------------------------------------------------------------
// Raid-Helper import

const WINDOW = 10 * 60 * 1000 + 1000;
const rhCalls = (s) => s.w.sources.calls.filter((c) => new URL(c.url).hostname === 'raid-helper.dev');
const wclCalls = (s) => s.w.sources.calls.filter((c) => new URL(c.url).hostname.endsWith('.warcraftlogs.com'));
const preview = (s, who, body) => s.call(who, 'POST', '/roster/import/raid-helper/preview', body);
const commit = (s, who, body) => s.call(who, 'POST', '/roster/import/raid-helper/commit', body);
const counts = async (w) => [await w.count('players'), await w.count('characters'), await w.count('audit_log')];

function sampleEvent(serverId = SERVER_A) {
  return rhEvent(EVENT_ID, serverId, [
    signUp(1, DID(1), 'Thornwick/Mendra', 'Warrior', 'Arms'),
    signUp(2, DID(2), 'Pyrelo (Quinn)', 'Mage', 'Fire'),
    signUp(3, DID(3), 'Sølvhand', 'Paladin', 'Holy1'),
    signUp(4, DID(4), 'Brewmaw/Brewmaw', 'Tank', 'Guardian'),
    signUp(5, DID(5), 'Ashgrove', 'Tentative', 'Shadow'),
    signUp(6, DID(6), 'Nobody Home', 'Absence', undefined),
    signUp(7, DID(7), 'Kestrel/Vexa', 'Bench', undefined),
    signUp(8, DID(8), 'Lumenfall', 'Late', undefined),
    signUp(9, DID(8), 'Lumenfall/Dawnreach', 'Priest', 'Discipline'),
    { ...signUp(10, undefined, 'Guest Raider', 'Rogue', 'Combat'), userId: undefined },
    signUp(12, DID(12), 'Plainmage', 'Mage', ''),
    signUp(13, DID(13), 'Whoknows', 'Tank', ''),
  ]);
}

check('Raid-Helper preview: rows by Discord user, the class-bearing sign-up wins, notes, tokens, ticks, other server', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const before = await counts(s.w);
  const r = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.event, { id: EVENT_ID, title: 'Test Raid', startTime: RH_START * 1000, otherServer: false });
  assert.deepEqual(r.json.rows.map((row) => row.signupId), [1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13], 'one row per Discord user; #9 beats #8');
  const row = (id) => r.json.rows.find((entry) => entry.signupId === id);
  assert.deepEqual(row(1), {
    signupId: 1, nickname: 'Thornwick/Mendra', kind: 'new', person: null, canAddAlts: false, signedIn: false, ticked: true,
    main: { name: 'Thornwick', class: 'WARRIOR', spec: 'Arms', note: null, taken: null }, alts: [{ name: 'Mendra', taken: null }],
  });
  assert.deepEqual(row(2).main, { name: 'Pyrelo', class: 'MAGE', spec: 'Fire', note: null, taken: null });
  assert.deepEqual(row(2).alts, [{ name: 'Quinn', taken: null }]);
  assert.deepEqual(row(3).main, { name: 'Sølvhand', class: 'PALADIN', spec: 'Holy', note: null, taken: null });
  assert.deepEqual(row(4).main, { name: 'Brewmaw', class: 'DRUID', spec: 'Feral (Tank)', note: null, taken: null }, 'Tank + Guardian: the spec carries the class and role');
  assert.deepEqual(row(4).alts, [], 'a repeated token is one name');
  assert.deepEqual(row(5).main, { name: 'Ashgrove', class: 'PRIEST', spec: 'Shadow', note: 'tentative', taken: null });
  assert.deepEqual([row(6).main.class, row(6).main.spec, row(6).main.note, row(6).main.name, row(6).ticked], [null, null, 'absence', 'Nobody', true], 'an Absence row is ticked but has no class');
  assert.deepEqual(row(6).alts, [{ name: 'Home', taken: null }]);
  assert.deepEqual([row(7).main.note, row(7).main.class, row(7).ticked], ['bench', null, true]);
  assert.deepEqual(row(9).main, { name: 'Lumenfall', class: 'PRIEST', spec: 'Discipline', note: null, taken: null });
  assert.deepEqual(row(9).alts, [{ name: 'Dawnreach', taken: null }], 'the other sign-up\'s name joins the Alt suggestions without repeating');
  assert.equal(row(9).nickname, 'Lumenfall/Dawnreach');
  assert.deepEqual([row(10).kind, row(10).ticked, row(10).main.name, row(10).main.class, row(10).person], ['no_discord', false, 'Guest', 'ROGUE', null]);
  assert.deepEqual([row(12).main.class, row(12).main.spec, row(12).main.note], ['MAGE', null, null], 'a class-only sign-up');
  assert.deepEqual([row(13).main.class, row(13).main.note], [null, 'no_class']);
  assert.deepEqual(await counts(s.w), before, 'a preview stores nothing');

  const call = rhCalls(s)[0];
  assert.equal(call.url, `https://raid-helper.dev/api/v4/events/${EVENT_ID}`);
  assert.equal(call.init.redirect, 'manual');
  assert(call.init.signal instanceof AbortSignal);
  s.w.sources.events.set(EVENT_ID, sampleEvent(OTHER_SERVER));
  s.w.advance(WINDOW);
  assert.equal((await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID })).json.event.otherServer, true);
  s.w.sources.events.set(EVENT_ID, { ...sampleEvent(), serverId: undefined });
  s.w.advance(WINDOW);
  assert.equal((await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID })).json.event.otherServer, true, 'an event with no server id cannot be confirmed');
  await assertOneMain(s.w);
});

check('Raid-Helper preview: on_roster rows (guild-wide Discord match), taken names, signedIn, canAddAlts by the home-team rule', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const quinzel = await addPerson(s, 'bob', A, 'Quinzel', { class: 'PRIEST', mainSpec: 'Holy' });
  await addAlt(s, 'bob', quinzel.person.id, A, 'Pyrelo');
  exec(s.w, `UPDATE players SET discord_user_id = '${DID(2)}' WHERE id = '${quinzel.person.id}'`);
  const onB = await addPerson(s, 'bob', B, 'Mendra');
  const homedB = await addPerson(s, 'bob', B, 'Sunder');
  exec(s.w, `UPDATE players SET discord_user_id = '${DID(1)}' WHERE id = '${homedB.person.id}'`);
  await signIn(s.w, { id: DID(3), username: 'sol', globalName: null }, [plain(SERVER_A)]);

  const asBob = (await preview(s, 'bob', { teamId: A, source: EVENT_ID })).json.rows;
  const row = (rows, id) => rows.find((entry) => entry.signupId === id);
  assert.deepEqual(row(asBob, 2), {
    signupId: 2, nickname: 'Pyrelo (Quinn)', kind: 'on_roster', person: { id: quinzel.person.id, name: 'Quinzel' }, canAddAlts: true, signedIn: false, ticked: false,
    main: { name: 'Quinzel', class: 'PRIEST', spec: 'Holy', note: null, taken: null }, alts: [{ name: 'Quinn', taken: null }],
  }, 'Pyrelo is already their character, so only Quinn is offered');
  assert.deepEqual(row(asBob, 1).alts, [{ name: 'Thornwick', taken: null }, { name: 'Mendra', taken: { personId: onB.person.id, name: 'Mendra' } }], 'Mendra is another person\'s character: taken');
  assert.equal(row(asBob, 1).kind, 'on_roster');
  assert.equal(row(asBob, 3).signedIn, true);
  assert.equal(row(asBob, 3).kind, 'new');
  assert.equal(row(asBob, 12).signedIn, false);
  // Carol leads A only: Sunder is homed on B, so she cannot add to them.
  s.w.advance(WINDOW);
  const asCarol = (await preview(s, 'carol', { teamId: A, source: EVENT_ID })).json.rows;
  assert.equal(row(asCarol, 1).canAddAlts, false);
  assert.equal(row(asCarol, 2).canAddAlts, true);
  // The taken mark on a new row's Main name.
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [signUp(1, DID(30), 'Mendra', 'Mage', 'Fire')]));
  s.w.advance(WINDOW);
  const taken = (await preview(s, 'bob', { teamId: A, source: EVENT_ID })).json.rows[0];
  assert.deepEqual(taken.main.taken, { personId: onB.person.id, name: 'Mendra' });
  assert.equal(taken.kind, 'new');
  await assertOneMain(s.w);
});

check('Raid-Helper preview: link parsing (good and bad hosts, ID length) and the fixed events URL', async () => {
  const s = await scenario();
  const good = [
    '123456789', '  123456789  ', 'https://raid-helper.dev/event/123456789', 'https://www.raid-helper.dev/event/123456789?x=1#y',
    'https://raid-helper.xyz/raidplan/123456789', 'https://raid-helper.dev/api/v4/events/123456789', 'https://raid-helper.dev/api/v4/events/123456789 and a note',
    'https://raid-helper.dev/api/v4/events/123456789?x=1', 'HTTPS://RAID-HELPER.DEV/EVENT/123456789',
  ];
  for (const source of good) {
    s.w.advance(WINDOW);
    const r = await preview(s, 'bob', { teamId: s.teamId, source });
    assert.equal(r.status, 404, `${source}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, 'not_found', 'parsed fine; the (fake) event does not exist');
    assert.equal(rhCalls(s).at(-1).url, 'https://raid-helper.dev/api/v4/events/123456789', source);
  }
  const calls = rhCalls(s).length;
  const bad = [
    'http://raid-helper.dev/event/123456', 'https://evil.test/event/123456', 'https://raid-helper.dev.evil.test/event/123456', 'https://evilraid-helper.dev/event/123456',
    'https://raid-helper.dev:8443/event/123456', 'https://user@raid-helper.dev/event/123456', 'https://user:pw@raid-helper.dev/event/123456',
    'https://www.raid-helper.dev/api/v4/events/123456', 'https://raid-helper.dev/event/12345', 'https://raid-helper.dev/event/', 'https://raid-helper.dev/foo/123456',
    'https://raid-helper.dev/api/v4/events/abc', '12345', '1'.repeat(26), `https://raid-helper.dev/event/${'1'.repeat(26)}`, '{"signUps":[]}', 'PP:abc', '', '   ', 'raid-helper.dev/event/123456', 'ftp://raid-helper.dev/event/123456',
  ];
  for (const source of bad) {
    const r = await preview(s, 'bob', { teamId: s.teamId, source });
    assert.equal(r.status, 400, `${source}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.field, 'source', source);
  }
  assert.equal((await preview(s, 'bob', { teamId: s.teamId, source: 123456789 })).json.field, 'source');
  assert.equal((await preview(s, 'bob', { teamId: s.teamId })).json.field, 'source');
  assert.equal(rhCalls(s).length, calls, 'a refused link is never fetched');
  assert.equal(await s.w.count('rate_limits', 'key LIKE ?', 'imp:%'), 1);
  assert.equal((await s.w.rows('SELECT count FROM rate_limits WHERE key LIKE ?', 'imp:%'))[0].count, 1, 'refused links do not use the import window (one use per window, the last good link)');
});

check('Raid-Helper preview: fetch failures map to their codes', async () => {
  const s = await scenario();
  const run = async (setup, status, code) => {
    s.w.advance(WINDOW);
    s.w.sources.rh = { status: null, throws: false, raw: undefined };
    setup(s.w.sources.rh);
    const r = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
    assert.equal([r.status, r.json.error || ''].join(' '), `${status} ${code}`, JSON.stringify(r.json));
  };
  await run((rh) => { rh.status = 401; }, 403, 'event_private');
  await run((rh) => { rh.status = 403; }, 403, 'event_private');
  await run((rh) => { rh.status = 404; }, 404, 'not_found');
  await run((rh) => { rh.status = 500; }, 502, 'raid_helper_unavailable');
  await run((rh) => { rh.status = 429; }, 502, 'raid_helper_unavailable');
  await run((rh) => { rh.throws = true; }, 502, 'raid_helper_unavailable');
  await run((rh) => { rh.raw = '{"hello":"world"}'; }, 502, 'not_an_event');
  await run((rh) => { rh.raw = '{"signUps":"nope"}'; }, 502, 'not_an_event');
  await run((rh) => { rh.raw = 'not json'; }, 502, 'not_an_event');
  await run((rh) => { rh.raw = `{"signUps":[],"pad":"${'x'.repeat(1024 * 1024 + 10)}"}`; }, 502, 'raid_helper_unavailable');
  await run((rh) => { rh.raw = '{"signUps":[]}'; }, 200, '');
  assert.equal(await s.w.count('players'), 0);
});

check('Raid-Helper commit: re-fetches the event; Discord IDs and nicknames come from it; People, Alts, status, one audit row', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const fetchesBefore = rhCalls(s).length;
  const body = {
    teamId: s.teamId, eventId: EVENT_ID, acceptOtherServer: false, defaultStatus: 'trial',
    rows: [
      { signupId: 1, discordId: DID(99), userId: DID(98), nickname: 'Forged', main: { name: 'thornwick', class: 'WARRIOR', spec: 'Arms' }, alts: [{ name: 'Mendra', class: 'SHAMAN' }] },
      { signupId: 3, main: { name: 'Solhand', class: 'PALADIN', spec: 'Holy' } },
      { signupId: 10, main: { name: 'Guest', class: 'ROGUE', spec: null }, alts: [] },
    ],
  };
  const r = await commit(s, 'bob', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.people, r.json.characters], [3, 4]);
  assert.deepEqual(r.json.rosterFlags, { [s.teamId]: 0 });
  assert.equal(rhCalls(s).length, fetchesBefore + 1, 'the commit fetched the event again');
  const people = await s.w.rows('SELECT status, joined_on, trial_start, trial_end, discord_user_id, discord_nickname, version, created_by FROM players ORDER BY discord_user_id');
  assert.deepEqual(people.map((p) => p.discord_user_id), [null, DID(1), DID(3)]);
  assert.deepEqual(people.map((p) => p.discord_nickname), ['Guest Raider', 'Thornwick/Mendra', 'Sølvhand'], 'from the event, not from the request');
  for (const p of people) assert.deepEqual([p.status, p.joined_on, p.trial_start, p.trial_end, p.version, p.created_by], ['trial', '2027-01-15', '2027-01-15', null, 1, s.ids.bob]);
  const chars = await s.w.rows('SELECT name, class, main_spec, off_spec, is_main, realm, realm_key, team_id FROM characters ORDER BY name');
  assert.deepEqual(chars.map((c) => [c.name, c.is_main, c.class, c.main_spec]), [
    ['Guest', 1, 'ROGUE', null], ['Mendra', 0, 'SHAMAN', null], ['Solhand', 1, 'PALADIN', 'Holy'], ['Thornwick', 1, 'WARRIOR', 'Arms'],
  ]);
  assert(chars.every((c) => c.realm === 'Nightslayer' && c.realm_key === 'nightslayer' && c.team_id === s.teamId));
  const audit = await s.w.rows("SELECT action, entity_type, entity_id, after FROM audit_log WHERE action = 'roster.import'");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].entity_type, audit[0].entity_id, JSON.parse(audit[0].after)], ['team', s.teamId, { source: 'raid_helper', ref: EVENT_ID, people: 3, characters: 4 }]);
  assert.equal(await s.w.count('audit_log', "action = 'person.create' OR action = 'character.create'"), 0, 'an import writes one audit row, not one per row');
  await assertOneMain(s.w);

  // on_roster rows: only Alts, and the nickname is refreshed. A main for a known member is already_on_roster.
  const event = sampleEvent();
  event.signUps[0].name = 'Thornwick/Mendra/Newalt';
  s.w.sources.events.set(EVENT_ID, event);
  s.w.advance(WINDOW);
  const stale = await commit(s, 'bob', { ...body, rows: [body.rows[0]] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'already_on_roster');
  assert.equal(stale.json.index, 0);
  const alts = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'trial', rows: [{ signupId: 1, alts: [{ name: 'Newalt', class: 'MAGE' }] }, { signupId: 3 }] });
  assert.equal(alts.status, 201, JSON.stringify(alts.json));
  assert.deepEqual([alts.json.people, alts.json.characters], [0, 1]);
  assert.equal((await s.w.rows('SELECT discord_nickname, version, status FROM players WHERE discord_user_id = ?', DID(1)))[0].discord_nickname, 'Thornwick/Mendra/Newalt');
  assert.deepEqual((await s.w.rows('SELECT version, status FROM players WHERE discord_user_id = ?', DID(1)))[0], { version: 1, status: 'trial' }, 'a status never changes and a nickname refresh does not bump the version');
  assert.equal((await s.w.rows('SELECT version FROM players WHERE discord_user_id = ?', DID(3)))[0].version, 1, 'an unchanged nickname is not a write');
  await assertOneMain(s.w);
});

check('Raid-Helper commit: event_changed, other_server and its accept path, in-request duplicates, taken names, validation, status', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent(OTHER_SERVER));
  const main = (name) => ({ name, class: 'MAGE', spec: 'Fire' });
  const base = { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider' };
  const send = async (extra, rows) => { s.w.advance(WINDOW); return commit(s, 'bob', { ...base, ...extra, rows }); };
  const before = await counts(s.w);

  const other = await send({}, [{ signupId: 1, main: main('Aldric') }]);
  assert.deepEqual([other.status, other.json.error], [409, 'other_server']);
  assert.equal((await send({ acceptOtherServer: false }, [{ signupId: 1, main: main('Aldric') }])).json.error, 'other_server');
  assert.equal((await send({ acceptOtherServer: 'yes' }, [{ signupId: 1, main: main('Aldric') }])).json.field, 'acceptOtherServer');
  assert.deepEqual(await counts(s.w), before);
  const accept = { acceptOtherServer: true };

  const gone = await send(accept, [{ signupId: 1, main: main('Aldric') }, { signupId: 999, main: main('Brindle') }]);
  assert.deepEqual([gone.status, gone.json.error, gone.json.index], [409, 'event_changed', 1]);
  const dup = await send(accept, [{ signupId: 1, main: main('Aldric') }, { signupId: 2, main: main('aldric') }]);
  assert.deepEqual([dup.status, dup.json.error, dup.json.index, dup.json.field], [400, 'name_taken', 1, 'name']);
  const dupInRow = await send(accept, [{ signupId: 1, main: main('Aldric'), alts: [{ name: 'ALDRIC', class: 'ROGUE' }] }]);
  assert.deepEqual([dupInRow.status, dupInRow.json.error], [400, 'name_taken']);
  const sameUser = await send(accept, [{ signupId: 8, main: main('Aldric') }, { signupId: 9, main: main('Brindle') }]);
  assert.equal(sameUser.status, 400, 'two rows for one Discord member');
  const sameRow = await send(accept, [{ signupId: 1, main: main('Aldric') }, { signupId: 1, main: main('Brindle') }]);
  assert.equal(sameRow.json.field, 'signupId');
  assert.equal(sameRow.json.index, 1);

  const existing = await addPerson(s, 'bob', s.teamId, 'Cassia');
  const taken = await send(accept, [{ signupId: 1, main: main('Aldric') }, { signupId: 2, main: main('Brindle'), alts: [{ name: 'Cassia', class: 'ROGUE' }] }]);
  assert.deepEqual([taken.status, taken.json.error, taken.json.index, taken.json.field], [409, 'name_taken', 1, 'name']);
  assert.deepEqual(taken.json.owner, { personId: existing.person.id, name: 'Cassia' });

  const invalid = async (row, field, index = 0) => {
    const r = await send(accept, [row]);
    assert.equal(r.status, 400, JSON.stringify([row, r.json]));
    assert.equal(r.json.field, field, JSON.stringify(r.json));
    assert.equal(r.json.index, index);
  };
  await invalid({ signupId: 1 }, 'main');
  await invalid({ signupId: 1, main: null }, 'main');
  await invalid({ signupId: 1, main: { name: 'A', class: 'MAGE' } }, 'main.name');
  await invalid({ signupId: 1, main: { name: 'Aldric', class: 'NOPE' } }, 'main.class');
  await invalid({ signupId: 1, main: { name: 'Aldric', class: 'MAGE', spec: 'Arms' } }, 'main.spec');
  await invalid({ signupId: 1, main: main('Aldric'), alts: [{ name: 'B', class: 'MAGE' }] }, 'alts.name');
  await invalid({ signupId: 1, main: main('Aldric'), alts: [{ name: 'Brindle', class: 'X' }] }, 'alts.class');
  await invalid({ signupId: 1, main: main('Aldric'), alts: 'Brindle' }, 'alts');
  await invalid({ signupId: 'one', main: main('Aldric') }, 'signupId');
  await invalid(5, 'rows');
  assert.equal((await send({ ...accept, eventId: 'abc' }, [])).json.field, 'eventId');
  assert.equal((await send({ ...accept, defaultStatus: 'inactive' }, [{ signupId: 1, main: main('Aldric') }])).json.field, 'defaultStatus');
  assert.equal((await send({ ...accept, rows: undefined }, undefined)).json.field, 'rows');
  const tooMany = await send(accept, Array.from({ length: 101 }, (_, i) => ({ signupId: i + 1, main: main(nameFor(i)) })));
  assert.deepEqual([tooMany.status, tooMany.json.field], [400, 'rows']);
  assert.deepEqual(await counts(s.w), [1, 1, before[2] + 1], 'nothing was written by any refused commit (only Cassia and her audit row)');

  const ok = await send(accept, [{ signupId: 1, main: main('Aldric') }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await s.w.rows('SELECT status FROM players WHERE discord_user_id = ?', DID(1)))[0].status, 'raider');
  const reserve = await send(accept, [{ signupId: 2, main: main('Brindle') }]);
  assert.equal(reserve.status, 201);
  const defaulted = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, acceptOtherServer: true, rows: [{ signupId: 3, main: main('Cormac') }] });
  assert.equal(defaulted.status, 201);
  assert.equal((await s.w.rows('SELECT status FROM players WHERE discord_user_id = ?', DID(3)))[0].status, 'raider');
  await assertOneMain(s.w);
});

check('Raid-Helper commit: a 100-row commit under 64 KB (above the 16 KB cap of other routes), one batch', async () => {
  const s = await scenario();
  const signUps = Array.from({ length: 100 }, (_, i) => signUp(i + 1, `3${String(i).padStart(17, '0')}`, `${nameFor(i * 5)}/${nameFor(i * 5 + 1)}`, 'Mage', 'Fire'));
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, signUps));
  const rows = signUps.map((entry, i) => ({
    signupId: entry.id, main: { name: nameFor(i * 5), class: 'MAGE', spec: 'Fire' },
    alts: [1, 2, 3, 4].map((k) => ({ name: nameFor(i * 5 + k), class: 'ROGUE' })),
  }));
  const body = JSON.stringify({ teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows });
  assert(body.length > 16 * 1024 && body.length < 64 * 1024, `body is ${body.length} bytes`);
  const batches = [];
  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => { batches.push(statements.map((st) => st.sql)); return realBatch(statements); };
  const r = await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster/import/raid-helper/commit`, undefined, { rawBody: body });
  s.w.db.batch = realBatch;
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.people, r.json.characters], [100, 500]);
  const writes = batches.filter((statements) => statements.some((sql) => /INSERT INTO players/.test(sql)));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 5, 'players, characters, the character-column sync (dual write), the stale mark, one audit row: a handful of statements whatever the size');
  assert.equal(await s.w.count('characters', 'is_main = 1'), 100);
  // The other routes keep the 16 KB cap, and the commit cap is 64 KB.
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster/import/raid-helper/preview`, undefined, { rawBody: body })).status, 413);
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster`, undefined, { rawBody: body })).status, 413);
  const huge = JSON.stringify({ teamId: s.teamId, eventId: EVENT_ID, rows: [], pad: 'x'.repeat(65 * 1024) });
  const tooLarge = await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster/import/raid-helper/commit`, undefined, { rawBody: huge });
  assert.deepEqual([tooLarge.status, tooLarge.json.error], [413, 'too_large']);
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster/import/wcl/commit`, undefined, { rawBody: huge })).status, 413);
  const declared = await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/roster/import/wcl/commit`, undefined, { rawBody: '{}', headers: { 'Content-Length': String(70 * 1024) } });
  assert.equal(declared.status, 413);
  await assertOneMain(s.w);
});

check('Raid-Helper commit: a cap trigger ABORT rolls back the whole import (people, characters, nickname refresh, audit)', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  exec(s.w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
             INSERT INTO players (id, guild_id, status, created_at, updated_at) SELECT 'fill' || i, '${s.guildId}', 'raider', 1, 1 FROM n`);
  const main = (name) => ({ name, class: 'MAGE', spec: 'Fire' });
  const rows = [{ signupId: 1, main: main('Aldric') }, { signupId: 2, main: main('Brindle') }];
  const tooBig = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows });
  assert.deepEqual([tooBig.status, tooBig.json.error], [409, 'person_limit']);
  assert.equal(await s.w.count('players'), 999, 'not even the first person landed');
  assert.equal(await s.w.count('characters'), 0);
  assert.equal(await s.w.count('audit_log', "action = 'roster.import'"), 0);
  exec(s.w, "DELETE FROM players WHERE id LIKE 'fill%'");

  const hero = await addPerson(s, 'bob', s.teamId, 'Hestia');
  exec(s.w, `UPDATE players SET discord_user_id = '${DID(1)}', discord_nickname = 'Old' WHERE id = '${hero.person.id}'`);
  exec(s.w, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 18)
             INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at)
             SELECT 'x' || i, '${s.guildId}', '${hero.person.id}', '${s.teamId}', 'Fill' || i, 'fill' || i, 'MAGE', 1, 1 FROM n`);
  s.w.advance(WINDOW);
  const crowded = await commit(s, 'bob', {
    teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider',
    rows: [{ signupId: 3, main: main('Ivarr') }, { signupId: 1, alts: [{ name: 'Altone', class: 'MAGE' }, { name: 'Alttwo', class: 'MAGE' }] }],
  });
  assert.deepEqual([crowded.status, crowded.json.error], [409, 'character_limit']);
  assert.equal(await s.w.count('characters', 'player_id = ?', hero.person.id), 19);
  assert.equal(await s.w.count('players'), 1, 'Ivarr rolled back too');
  assert.equal((await s.w.rows('SELECT discord_nickname FROM players WHERE id = ?', hero.person.id))[0].discord_nickname, 'Old');
  assert.equal(await s.w.count('audit_log', "action = 'roster.import'"), 0);
  await assertOneMain(s.w);
});

check('Raid-Helper commit: races inside the write map by constraint (a name taken, a member who just joined the roster)', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const main = (name) => ({ name, class: 'MAGE', spec: 'Fire' });
  const real = s.w.db.batch.bind(s.w.db);
  const race = (sql) => {
    s.w.db.batch = async (statements) => {
      if (statements.some((st) => /INSERT INTO players/.test(st.sql))) {
        s.w.db.batch = real;
        exec(s.w, sql);
      }
      return real(statements);
    };
  };
  race(`INSERT INTO players (id, guild_id, status, discord_user_id, created_at, updated_at) VALUES ('p_race', '${s.guildId}', 'raider', '${DID(1)}', 1, 1)`);
  const joined = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows: [{ signupId: 1, main: main('Aldric') }, { signupId: 2, main: main('Brindle') }] });
  assert.deepEqual([joined.status, joined.json.error], [409, 'already_on_roster']);
  assert.equal(await s.w.count('characters'), 0);
  assert.equal(await s.w.count('players'), 1, 'only the racing row exists');
  exec(s.w, "DELETE FROM players WHERE id = 'p_race'");
  s.w.advance(WINDOW);
  race(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_race', '${s.guildId}', 'raider', 1, 1);
        INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at)
        VALUES ('c_race', '${s.guildId}', 'p_race', '${s.teamId}', 'Brindle', 'brindle', 'Nightslayer', 'nightslayer', 'MAGE', 1, 1, 1)`);
  const clash = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows: [{ signupId: 1, main: main('Aldric') }, { signupId: 2, main: main('Brindle') }] });
  assert.deepEqual([clash.status, clash.json.error, clash.json.index, clash.json.field], [409, 'name_taken', undefined, 'name']);
  assert.equal(await s.w.count('players'), 1);
  assert.equal(await s.w.count('characters'), 1);
  await assertOneMain(s.w);
});

check('Raid-Helper commit: permissions (Team Lead scope per row), and the import windows (10 per 10 minutes, shared by previews and commits)', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const sunder = await addPerson(s, 'bob', B, 'Sunder');
  exec(s.w, `UPDATE players SET discord_user_id = '${DID(1)}' WHERE id = '${sunder.person.id}'`);
  const rows = [{ signupId: 3, main: { name: 'Cormac', class: 'MAGE' } }, { signupId: 1, alts: [{ name: 'Altone', class: 'MAGE' }] }];
  const denied = await commit(s, 'carol', { teamId: A, eventId: EVENT_ID, defaultStatus: 'raider', rows });
  assert.deepEqual([denied.status, denied.json.error, denied.json.index], [403, 'forbidden', 1], 'carol cannot add to a person homed on B');
  assert.equal(await s.w.count('players'), 1, 'her new person did not land either');
  assert.equal((await commit(s, 'carol', { teamId: B, eventId: EVENT_ID, defaultStatus: 'raider', rows: [rows[0]] })).status, 403);
  assert.equal((await commit(s, 'erin', { teamId: A, eventId: EVENT_ID, defaultStatus: 'raider', rows: [rows[0]] })).status, 403);
  assert.equal((await commit(s, 'dave', { teamId: B, eventId: EVENT_ID, defaultStatus: 'raider', rows })).status, 201, 'a Team Lead of B adds Alts to a person homed on B');

  // 10 per window, then 429 with the import wording. Previews and commits share the window.
  const t = await scenario();
  t.w.sources.events.set(EVENT_ID, sampleEvent());
  for (let i = 0; i < 5; i++) assert.equal((await preview(t, 'bob', { teamId: t.teamId, source: EVENT_ID })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await commit(t, 'bob', { teamId: t.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows: [] })).status, 200);
  const limited = await preview(t, 'bob', { teamId: t.teamId, source: EVENT_ID });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert.match(limited.json.message, /Too many imports/);
  assert(limited.json.retryAfter >= 1 && limited.json.retryAfter <= 600);
  assert.equal(Number(limited.headers.get('Retry-After')), limited.json.retryAfter);
  assert.equal(rhCalls(t).length, 10, 'the refused preview never fetched');
  assert.equal((await t.call('carol', 'POST', '/roster/import/raid-helper/preview', { teamId: t.teamId, source: EVENT_ID })).status, 200, 'per user');
  assert.equal((await t.w.call(t.jars.bob, 'PATCH', '/auth/prefs', { sidebarCollapsed: true })).status, 200, 'the central limit keeps its own window and message');
  t.w.advance(WINDOW);
  assert.equal((await preview(t, 'bob', { teamId: t.teamId, source: EVENT_ID })).status, 200, 'a new window');
  assert.deepEqual((await t.w.rows('SELECT key FROM rate_limits WHERE key LIKE ? ORDER BY key', 'imp:%')).map((row) => row.key), [`imp:${t.ids.bob}`, `imp:${t.ids.carol}`]);
  // The central limit's message is unchanged.
  const hammer = await scenario();
  for (let i = 0; i < 60; i++) await hammer.w.call(hammer.jars.erin, 'PATCH', '/auth/prefs', { sidebarCollapsed: true });
  const central = await hammer.w.call(hammer.jars.erin, 'PATCH', '/auth/prefs', { sidebarCollapsed: true });
  assert.deepEqual([central.status, central.json.message], [429, 'Too many changes in a minute. Wait a moment and try again.']);
});

// ---------------------------------------------------------------------------
// Warcraft Logs import

const REPORT = 'Fake000000000001';
const wclPreview = (s, who, source, extra = {}) => s.call(who, 'POST', '/roster/import/wcl/preview', { teamId: s.teamId, source, ...extra });
const wclCommit = (s, who, body) => s.call(who, 'POST', '/roster/import/wcl/commit', { teamId: s.teamId, report: { code: REPORT, flavour: 'fresh' }, ...body });
const actor = (name, subType, server = 'Nightslayer') => ({ name, type: subType === 'Pet' ? 'Pet' : 'Player', subType, server });
function sampleReport(extra = []) {
  return {
    title: 'Gruul clear', startTime: 1_800_000_000_000, zone: { name: 'Gruul / Magtheridon' },
    masterData: {
      actors: [
        actor('Aldric', 'Warrior'), actor('Pyrelo', 'Mage'), actor('Mendra', 'Shaman'), actor('Wanderfell', 'Druid', 'Dreamscythe'),
        actor('Embertail', 'Pet', null), actor('Pyrelo', 'Mage'), actor('Boss', 'Boss'), actor('Xx1', 'Mage'), actor('Sølvhand', 'Paladin'), ...extra,
      ],
    },
  };
}

check('Warcraft Logs preview: matched vs to-decide, pets and bad names dropped, other realm, suggestions by nickname token (one candidate only, in scope)', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  s.w.sources.reports.set(REPORT, sampleReport());
  const aldric = await addPerson(s, 'bob', A, 'Aldric');
  const pyr = await addPerson(s, 'bob', A, 'Quinzel');
  const two1 = await addPerson(s, 'bob', A, 'Tamsin');
  const two2 = await addPerson(s, 'bob', A, 'Ulrik');
  const far = await addPerson(s, 'bob', B, 'Varga');
  const nick = (id, text) => exec(s.w, `UPDATE players SET discord_nickname = '${text}' WHERE id = '${id}'`);
  nick(pyr.person.id, 'Quinzel/Pyrelo'); nick(two1.person.id, 'Tamsin (Mendra)'); nick(two2.person.id, 'Ulrik / Mendra'); nick(far.person.id, 'Varga/Wanderfell');
  const before = await counts(s.w);
  const r = await wclPreview(s, 'bob', REPORT);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.report, { code: REPORT, flavour: 'fresh', title: 'Gruul clear', zone: 'Gruul / Magtheridon', startTime: 1_800_000_000_000 });
  assert.deepEqual(r.json.matched, [{ name: 'Aldric', class: 'WARRIOR', person: { id: aldric.person.id, name: 'Aldric' } }]);
  assert.deepEqual(r.json.toDecide.map((row) => [row.key, row.name, row.realm, row.class, row.otherRealm, row.suggestion && row.suggestion.name]), [
    ['mendra|nightslayer', 'Mendra', 'Nightslayer', 'SHAMAN', false, null],
    ['pyrelo|nightslayer', 'Pyrelo', 'Nightslayer', 'MAGE', false, 'Quinzel'],
    ['sølvhand|nightslayer', 'Sølvhand', 'Nightslayer', 'PALADIN', false, null],
    ['wanderfell|dreamscythe', 'Wanderfell', 'Dreamscythe', 'DRUID', true, 'Varga'],
  ]);
  assert.deepEqual(r.json.toDecide[1].suggestion, { personId: pyr.person.id, name: 'Quinzel' });
  assert.deepEqual(await counts(s.w), before, 'nothing from the report is stored on a preview');
  // Carol leads A: Varga is homed on B, out of her scope.
  s.w.advance(WINDOW);
  const carol = await wclPreview(s, 'carol', REPORT);
  assert.equal(carol.json.toDecide.find((row) => row.name === 'Wanderfell').suggestion, null);
  assert.equal(carol.json.toDecide.find((row) => row.name === 'Pyrelo').suggestion.name, 'Quinzel');
  const call = wclCalls(s).find((c) => c.url.endsWith('/api/v2/client'));
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://fresh.warcraftlogs.com/api/v2/client');
  assert.equal(call.init.redirect, 'manual');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent.variables, { code: REPORT });
  assert.match(sent.query, /query\(\$code: String!\) \{ reportData \{ report\(code: \$code\)/);
  assert.match(sent.query, /actors\(type: "Player"\) \{ name type subType server \}/);
  await assertOneMain(s.w);
});

check('Warcraft Logs preview: a realm guild matches name + realm key ("Maladath (AU)" = "Maladath"); a ruleset guild matches on the name only', async () => {
  const s = await scenario({ guildBody: { realm: 'Maladath (AU)' } });
  const made = await addPerson(s, 'bob', s.teamId, 'Aldric');
  assert.equal(made.characters[0].realm, 'Maladath (AU)');
  s.w.sources.reports.set(REPORT, { title: 'T', startTime: 1, zone: null, masterData: { actors: [actor('Aldric', 'Warrior', 'Maladath'), actor('Brindle', 'Mage', 'Maladath (AU)'), actor('Cassia', 'Priest', 'Dreamscythe'), actor('Dunmar', 'Rogue', null)] } });
  const r = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual(r.json.matched.map((m) => m.name), ['Aldric']);
  assert.deepEqual(r.json.toDecide.map((row) => [row.name, row.realm, row.otherRealm, row.key]), [
    ['Brindle', 'Maladath (AU)', false, 'brindle|maladath'], ['Cassia', 'Dreamscythe', true, 'cassia|dreamscythe'], ['Dunmar', 'Maladath (AU)', false, 'dunmar|maladath'],
  ]);
  assert.equal(r.json.report.zone, null);
  // A character with the same name on another realm is a different character.
  const t = await scenario();
  exec(t.w, `UPDATE guilds SET realm = 'Dreamscythe' WHERE id = '${t.guildId}'`);
  await addPerson(t, 'bob', t.teamId, 'Aldric');
  exec(t.w, "UPDATE characters SET realm = 'Dreamscythe', realm_key = 'dreamscythe'");
  t.w.sources.reports.set(REPORT, { title: 'T', startTime: 1, zone: null, masterData: { actors: [actor('Aldric', 'Warrior', 'Nightslayer')] } });
  const other = await wclPreview(t, 'bob', REPORT);
  assert.deepEqual([other.json.matched.length, other.json.toDecide[0].otherRealm], [0, true]);

  const ruleset = await secondGuild(s, { gameVersion: 'forever', realm: 'Hardcore' });
  const call = (method, route, body) => s.w.call(ruleset.frank, method, `${ruleset.path}${route}`, body);
  const native = await call('POST', '/roster', mainBody(ruleset.teamId, 'Aldric'));
  assert.equal(native.status, 201);
  s.w.sources.reports.set(REPORT, { title: 'T', startTime: 1, zone: null, masterData: { actors: [actor('Aldric', 'Warrior', 'Anywhere'), actor('Brindle', 'Mage', null)] } });
  const bare = await call('POST', '/roster/import/wcl/preview', { teamId: ruleset.teamId, source: REPORT });
  assert.deepEqual([bare.status, bare.json.field], [400, 'source'], 'a Forever guild must paste a full link');
  const full = await call('POST', '/roster/import/wcl/preview', { teamId: ruleset.teamId, source: `https://www.warcraftlogs.com/reports/${REPORT}` });
  assert.equal(full.status, 200, JSON.stringify(full.json));
  assert.deepEqual(full.json.matched.map((m) => m.name), ['Aldric'], 'by name only');
  assert.deepEqual(full.json.toDecide.map((row) => [row.name, row.realm, row.otherRealm, row.key]), [['Brindle', null, false, 'brindle|']]);
  assert.equal(full.json.report.flavour, 'www');
  assert.equal(wclCalls(s).at(-1).url, 'https://www.warcraftlogs.com/api/v2/client');
  await assertOneMain(s.w);
});

check('Warcraft Logs preview: link parsing, the flavour allowlist and the default flavour per game version', async () => {
  const s = await scenario();
  s.w.sources.reports.set(REPORT, sampleReport());
  const flavourOf = async (source) => {
    s.w.advance(WINDOW);
    const r = await wclPreview(s, 'bob', source);
    assert.equal(r.status, 200, `${source}: ${JSON.stringify(r.json)}`);
    return r.json.report.flavour;
  };
  assert.equal(await flavourOf(REPORT), 'fresh', 'TBC guild: bare code is fresh');
  assert.equal(await flavourOf(`  ${REPORT} `), 'fresh');
  assert.equal(await flavourOf(`https://fresh.warcraftlogs.com/reports/${REPORT}`), 'fresh');
  assert.equal(await flavourOf(`https://classic.warcraftlogs.com/reports/${REPORT}#fight=3&type=damage-done`), 'classic');
  assert.equal(await flavourOf(`https://www.warcraftlogs.com/reports/${REPORT}?boss=649`), 'www');
  assert.equal(await flavourOf(`https://FRESH.warcraftlogs.com/reports/${REPORT}/`), 'fresh');
  const calls = wclCalls(s).length;
  for (const source of [
    `http://fresh.warcraftlogs.com/reports/${REPORT}`, `https://tbc.warcraftlogs.com/reports/${REPORT}`, `https://fresh.warcraftlogs.com.evil.test/reports/${REPORT}`,
    `https://evil.test/reports/${REPORT}`, `https://fresh.warcraftlogs.com:8443/reports/${REPORT}`, `https://u@fresh.warcraftlogs.com/reports/${REPORT}`,
    'https://fresh.warcraftlogs.com/reports/a:AAAAAAAAAAAAAAAA', 'a:AAAAAAAAAAAAAAAA', 'https://fresh.warcraftlogs.com/reports/short', 'abc', REPORT.slice(1), `${REPORT}x`,
    'https://fresh.warcraftlogs.com/guild/id/1', `https://warcraftlogs.com/reports/${REPORT}`, '', 7,
  ]) {
    const r = await wclPreview(s, 'bob', source);
    assert.equal(r.status, 400, `${source}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.field, 'source', String(source));
  }
  assert.equal(wclCalls(s).length, calls, 'a refused link makes no request');
  // Classic Era guild: bare code is classic.
  const classic = await secondGuild(s, { gameVersion: 'classic', realm: 'Nightslayer' });
  const r = await s.w.call(classic.frank, 'POST', `${classic.path}/roster/import/wcl/preview`, { teamId: classic.teamId, source: REPORT });
  assert.equal(r.json.report.flavour, 'classic', JSON.stringify(r.json));
});

check('Warcraft Logs preview: token Basic auth, cached per flavour until expires_in - 60 s, refreshed once on a 401', async () => {
  const s = await scenario();
  s.w.sources.reports.set(REPORT, sampleReport());
  const posts = () => s.w.sources.wcl.tokenPosts;
  await wclPreview(s, 'bob', REPORT);
  s.w.advance(WINDOW);
  await wclPreview(s, 'bob', REPORT);
  assert.equal(posts().length, 1, 'one token for two previews');
  assert.deepEqual([posts()[0].flavour, posts()[0].auth, posts()[0].body], ['fresh', `Basic ${btoa(`${WCL_ID}:${WCL_SECRET}`)}`, 'grant_type=client_credentials']);
  const www = await wclPreview(s, 'bob', `https://www.warcraftlogs.com/reports/${REPORT}`);
  assert.equal(www.status, 200);
  assert.deepEqual(posts().map((p) => p.flavour), ['fresh', 'www'], 'a token per flavour');
  s.w.advance(3_539_000 - 601_000); // c0 + 3539 s: inside expires_in - 60 s
  await wclPreview(s, 'bob', REPORT);
  assert.equal(posts().length, 2, 'still cached just inside expires_in - 60 s');
  s.w.advance(2000);
  await wclPreview(s, 'bob', REPORT);
  assert.equal(posts().length, 3, 'expired');
  // The server forgets the token: one 401, one new token, one retry.
  s.w.sources.wcl.tokens.clear();
  s.w.advance(WINDOW);
  const recovered = await wclPreview(s, 'bob', REPORT);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal(posts().length, 4);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'wcl:%'"), 1);
});

check('Warcraft Logs preview: failures map to their codes; missing credentials are a 503', async () => {
  const s = await scenario();
  const { resetWclTokenCache } = await load('worker/sources.js');
  const run = async (setup, status, code) => {
    s.w.advance(WINDOW);
    resetWclTokenCache();
    s.w.sources.wcl.failToken = false; s.w.sources.wcl.httpStatus = null; s.w.sources.wcl.errors = null;
    setup(s.w.sources);
    const r = await wclPreview(s, 'bob', REPORT);
    assert.equal(`${r.status} ${r.json.error}`, `${status} ${code}`, JSON.stringify(r.json));
  };
  await run(() => {}, 404, 'not_found');
  await run((src) => { src.wcl.errors = [{ message: 'You do not have permission to view this report.' }]; }, 403, 'report_private');
  await run((src) => { src.wcl.errors = [{ message: 'Syntax Error: bad' }]; }, 502, 'wcl_unavailable');
  await run((src) => { src.wcl.httpStatus = 500; src.reports.set(REPORT, sampleReport()); }, 502, 'wcl_unavailable');
  await run((src) => { src.wcl.failToken = true; src.reports.set(REPORT, sampleReport()); }, 502, 'wcl_unavailable');
  await run((src) => { src.reports.set(REPORT, sampleReport()); }, 200, 'undefined');
  for (const name of ['WCL_CLIENT_ID', 'WCL_CLIENT_SECRET']) {
    const saved = s.w.env[name];
    s.w.env[name] = '';
    s.w.advance(WINDOW);
    const r = await wclPreview(s, 'bob', REPORT);
    assert.deepEqual([r.status, r.json.error], [503, 'wcl_not_configured'], name);
    s.w.env[name] = saved;
  }
});

check('Warcraft Logs windows: the per-user import window and the shared wcl:global window (60 per 10 minutes); the WCL path fails closed', async () => {
  const s = await scenario();
  s.w.sources.reports.set(REPORT, sampleReport());
  exec(s.w, `INSERT INTO rate_limits (key, window_start, count) VALUES ('wcl:global', ${s.w.clock.now}, 59)`);
  assert.equal((await wclPreview(s, 'bob', REPORT)).status, 200, 'the 60th preview');
  const limited = await wclPreview(s, 'carol', REPORT);
  assert.equal(limited.status, 429);
  assert.match(limited.json.message, /^Warcraft Logs imports are busy for everyone right now\. Try again in \d+ minutes?\.$/);
  assert(limited.json.retryAfter >= 1 && limited.json.retryAfter <= 600);
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  assert.equal((await preview(s, 'carol', { teamId: s.teamId, source: EVENT_ID })).status, 200, 'Raid-Helper is not counted against the shared WCL quota');
  s.w.advance(WINDOW);
  assert.equal((await wclPreview(s, 'bob', REPORT)).status, 200, 'a new window');
  // Per user: ten, then 429.
  const t = await scenario();
  t.w.sources.reports.set(REPORT, sampleReport());
  for (let i = 0; i < 10; i++) assert.equal((await wclPreview(t, 'bob', REPORT)).status, 200, `preview ${i + 1}`);
  assert.equal((await wclPreview(t, 'bob', REPORT)).status, 429);
  // Fail closed: if the limiter itself errors, the WCL path refuses (503, Retry-After); Raid-Helper fails open.
  const u = await scenario();
  u.w.sources.reports.set(REPORT, sampleReport());
  u.w.sources.events.set(EVENT_ID, sampleEvent());
  const realPrepare = u.w.db.prepare.bind(u.w.db);
  u.w.db.prepare = (sql) => {
    if (sql.includes('rate_limits')) throw new Error('D1 is down');
    return realPrepare(sql);
  };
  const closed = await wclPreview(u, 'bob', REPORT);
  assert.deepEqual([closed.status, closed.json.error], [503, 'rate_limited']);
  assert(Number(closed.headers.get('Retry-After')) >= 1);
  assert.equal(wclCalls(u).length, 0, 'no request left the Worker');
  assert.equal((await preview(u, 'bob', { teamId: u.teamId, source: EVENT_ID })).status, 200, 'fail open for Raid-Helper');
  u.w.db.prepare = realPrepare;
});

check('Warcraft Logs commit: alt / new / skip in one batch; fields validated like a manual add; no re-fetch; one audit row', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const quinzel = await addPerson(s, 'bob', A, 'Quinzel');
  const homedB = await addPerson(s, 'bob', B, 'Varga');
  const calls = s.w.sources.calls.length;
  const decisions = [
    { key: 'pyrelo|nightslayer', name: 'pyrelo', realm: 'Nightslayer', class: 'MAGE', action: 'alt', personId: quinzel.person.id },
    { key: 'mendra|nightslayer', name: 'Mendra', realm: 'Nightslayer', class: 'SHAMAN', action: 'new' },
    { key: 'wanderfell|dreamscythe', name: 'Wanderfell', realm: 'Dreamscythe', class: 'DRUID', action: 'new', status: 'reserve' },
    { key: 'x', name: 'Not Valid!', class: 'NOPE', action: 'skip' },
  ];
  const r = await wclCommit(s, 'bob', { teamId: A, decisions });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.people, r.json.characters], [2, 3]);
  assert.equal(s.w.sources.calls.length, calls, 'no re-fetch');
  const mendra = (await s.w.rows("SELECT p.status, p.joined_on, p.trial_start, p.trial_end, p.discord_user_id, c.is_main, c.realm, c.team_id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Mendra'"))[0];
  assert.deepEqual(mendra, { status: 'trial', joined_on: '2027-01-15', trial_start: '2027-01-15', trial_end: null, discord_user_id: null, is_main: 1, realm: 'Nightslayer', team_id: A });
  const wander = (await s.w.rows("SELECT p.status, c.realm, c.realm_key FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Wanderfell'"))[0];
  assert.deepEqual(wander, { status: 'reserve', realm: 'Dreamscythe', realm_key: 'dreamscythe' });
  const pyrelo = (await s.w.rows("SELECT is_main, player_id, team_id, realm_key FROM characters WHERE name = 'Pyrelo'"))[0];
  assert.deepEqual(pyrelo, { is_main: 0, player_id: quinzel.person.id, team_id: A, realm_key: 'nightslayer' });
  const audit = await s.w.rows("SELECT entity_type, entity_id, after FROM audit_log WHERE action = 'roster.import'");
  assert.deepEqual([audit.length, audit[0].entity_type, audit[0].entity_id, JSON.parse(audit[0].after)], [1, 'team', A, { source: 'wcl', ref: `fresh:${REPORT}`, people: 2, characters: 3 }]);
  assert.equal((await s.w.rows("SELECT COUNT(*) AS n FROM audit_log WHERE after LIKE '%Mendra%' OR after LIKE '%Wanderfell%'"))[0].n, 0);
  await assertOneMain(s.w);

  const fail = async (extra, field, status = 400, index = 0) => {
    s.w.advance(WINDOW);
    const res = await wclCommit(s, 'bob', { teamId: A, ...extra });
    assert.equal(res.status, status, JSON.stringify([extra, res.json]));
    if (field) assert.equal(res.json.field, field, JSON.stringify(res.json));
    if (index !== null) assert.equal(res.json.index, index);
    return res;
  };
  const good = { name: 'Zandra', class: 'MAGE', action: 'new' };
  await fail({ report: { code: 'short', flavour: 'fresh' }, decisions: [] }, 'report', 400, null);
  await fail({ report: { code: REPORT, flavour: 'tbc' }, decisions: [] }, 'report', 400, null);
  await fail({ report: null, decisions: [] }, 'report', 400, null);
  await fail({ decisions: 'x' }, 'decisions', 400, null);
  await fail({ decisions: Array.from({ length: 101 }, () => ({ action: 'skip' })) }, 'decisions', 400, null);
  await fail({ decisions: [{ ...good, action: 'maybe' }] }, 'action');
  await fail({ decisions: [good, { ...good, name: 'A' }] }, 'name', 400, 1);
  await fail({ decisions: [{ ...good, class: 'NOPE' }] }, 'class');
  await fail({ decisions: [{ ...good, realm: 'x'.repeat(41) }] }, 'realm');
  await fail({ decisions: [{ ...good, status: 'inactive' }] }, 'status');
  await fail({ decisions: [{ ...good, action: 'alt' }] }, 'personId');
  await fail({ decisions: [{ ...good, action: 'alt', personId: 'p_AAAAAAAAAAAAAAAAAAAAAA' }] }, null, 404);
  await fail({ decisions: [good, { ...good, name: 'ZANDRA', action: 'alt', personId: quinzel.person.id }] }, 'name', 400, 1);
  const taken = await fail({ decisions: [{ ...good, name: 'Aldric' }, { ...good, name: 'MENDRA' }] }, 'name', 409, 1);
  assert.equal(taken.json.error, 'name_taken');
  assert.equal(taken.json.owner.name, 'Mendra');
  // Carol leads A only: Varga is homed on B.
  s.w.advance(WINDOW);
  const escalate = await s.call('carol', 'POST', '/roster/import/wcl/commit', { teamId: A, report: { code: REPORT, flavour: 'fresh' }, decisions: [{ ...good, action: 'alt', personId: homedB.person.id }] });
  assert.deepEqual([escalate.status, escalate.json.error, escalate.json.index], [403, 'forbidden', 0]);
  assert.equal(await s.w.count('players'), 4);
  assert.equal(await s.w.count('characters'), 5);
  const empty = await wclCommit(s, 'bob', { teamId: A, decisions: [] });
  assert.deepEqual([empty.status, empty.json.people, empty.json.characters], [200, 0, 0]);
  await assertOneMain(s.w);
});

// ---------------------------------------------------------------------------
// Audit, base URLs for the local fakes

check('audit: all nine roster actions are written once each; no notes text, nicknames, Discord IDs or names in before/after', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const imported = await commit(s, 'bob', { teamId: A, eventId: EVENT_ID, defaultStatus: 'raider', rows: [{ signupId: 1, main: { name: 'Thornwick', class: 'WARRIOR', spec: 'Arms' }, alts: [{ name: 'Mendra', class: 'SHAMAN' }] }] });
  assert.equal(imported.status, 201);
  const person = await addPerson(s, 'bob', A, 'Brindle', { linkUserId: s.ids.erin });
  const pid = person.person.id;
  assert.equal((await s.call('bob', 'PUT', `/roster/${pid}/notes`, { text: 'SECRETNOTE about someone', expectedNotesVersion: 0 })).status, 200);
  assert.equal((await s.call('bob', 'PATCH', `/roster/${pid}`, { expectedVersion: 1, status: 'trial', trialEnd: '2027-03-01' })).status, 200);
  const alt = (await addAlt(s, 'bob', pid, B, 'Cassia')).json.characters.find((c) => !c.isMain);
  assert.equal((await s.call('bob', 'PATCH', `/roster/${pid}/characters/${alt.id}`, { name: 'Cassiaa' })).status, 200);
  assert.equal((await s.call('bob', 'POST', `/roster/${pid}/characters/${alt.id}/main`, {})).status, 200);
  const old = person.characters[0];
  assert.equal((await s.call('bob', 'DELETE', `/roster/${pid}/characters/${old.id}`, {})).status, 200);
  assert.equal((await s.call('bob', 'DELETE', `/roster/${pid}`, {})).status, 200);
  const written = (await s.w.rows("SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN (SELECT value FROM json_each(?)) GROUP BY action ORDER BY action", JSON.stringify(AUDIT_ACTIONS.filter((a) => /^(person|character|roster)\./.test(a))))).map((row) => [row.action, row.n]);
  assert.deepEqual(written, [['character.create', 1], ['character.delete', 1], ['character.main', 1], ['character.update', 1], ['person.create', 1], ['person.delete', 1], ['person.notes', 1], ['person.update', 1], ['roster.import', 1]]);
  const rows = await s.w.rows('SELECT action, entity_type, before, after FROM audit_log');
  const dump = rows.map((row) => `${row.before} ${row.after}`).join('\n');
  for (const secret of ['SECRETNOTE', 'Thornwick/Mendra', 'Thornwick', 'Mendra', 'Brindle', 'Cassia', DID(1), s.ids.erin.slice(2), 'erin']) {
    assert.equal(dump.includes(secret), false, `audit rows must not contain ${secret}`);
  }
  assert.deepEqual(rows.filter((row) => /^(person|character)\./.test(row.action)).map((row) => row.entity_type).sort().filter((v, i, a) => a.indexOf(v) === i), ['character', 'person']);
  await assertOneMain(s.w);
});

check('base URLs: RAID_HELPER_API_BASE and WCL_API_BASE are honoured only for localhost:<port> / 127.0.0.1:<port>; tools/fake-sources.js answers both', async () => {
  const { createFakeSources } = require('../../tools/fake-sources.js');
  const fake = createFakeSources({ serverId: SERVER_A });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  try {
    const s = await scenario();
    s.w.env.RAID_HELPER_API_BASE = base;
    s.w.env.WCL_API_BASE = base;
    const event = await preview(s, 'bob', { teamId: s.teamId, source: 'https://raid-helper.dev/event/111111111111111111' });
    assert.equal(event.status, 200, JSON.stringify(event.json));
    assert.equal(event.json.event.otherServer, false);
    assert.equal(event.json.event.title, 'Fake Gruul and Magtheridon');
    const rows = event.json.rows;
    assert.equal(rows.length, 9, 'ten sign-ups, one member with two');
    assert.deepEqual(rows.find((row) => row.main.note === 'absence').main.class, null);
    assert.equal(rows.find((row) => row.kind === 'no_discord').main.name, 'Guest');
    s.w.advance(WINDOW);
    const elsewhere = await preview(s, 'bob', { teamId: s.teamId, source: '222222222222222222' });
    assert.equal(elsewhere.json.event.otherServer, true);
    for (const [id, code] of [['333333333333333333', 'event_private'], ['444444444444444444', 'not_an_event'], ['555555555555555555', 'not_found']]) {
      s.w.advance(WINDOW);
      assert.equal((await preview(s, 'bob', { teamId: s.teamId, source: id })).json.error, code, id);
    }
    const report = await wclPreview(s, 'bob', 'Fake000000000001');
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.deepEqual(report.json.toDecide.map((row) => [row.name, row.otherRealm]).sort(), [['Lastcall', false], ['Mendra', true], ['Pyrelo', true], ['Quillfeather', true], ['Thornwick', true], ['Wanderfell', false]].sort());
    s.w.advance(WINDOW);
    assert.equal((await wclPreview(s, 'bob', 'Priv000000000001')).json.error, 'report_private');
    s.w.advance(WINDOW);
    assert.equal((await wclPreview(s, 'bob', 'Nope000000000001')).json.error, 'not_found');
    assert(fake.state.requests.some((r) => r.path === '/oauth/token'));

    // Not local: ignored, the real hosts are used.
    for (const bad of ['https://evil.test', 'http://127.0.0.1', 'http://127.0.0.1.evil.test:8080', 'http://evil.test:8080', 'ftp://127.0.0.1:21', 'http://user@127.0.0.1:8080', `${base}/path`]) {
      s.w.env.RAID_HELPER_API_BASE = bad;
      s.w.env.WCL_API_BASE = bad;
      s.w.advance(WINDOW);
      s.w.sources.calls.length = 0;
      await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
      await wclPreview(s, 'bob', 'Fake000000000001');
      assert.deepEqual(s.w.sources.calls.map((c) => new URL(c.url).hostname).filter((h, i, a) => a.indexOf(h) === i), ['raid-helper.dev', 'fresh.warcraftlogs.com'], bad);
    }
    s.w.env.RAID_HELPER_API_BASE = 'http://localhost:1';
    s.w.advance(WINDOW);
    const refused = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
    assert.equal(refused.json.error, 'raid_helper_unavailable', 'localhost with a port is honoured (and nothing listens there)');
  } finally {
    const closed = new Promise((resolve) => fake.server.close(resolve));
    fake.server.closeAllConnections();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

// ---------------------------------------------------------------------------
// Security review fix round (guild/slice-2-fixw)

const AVATAR = 'abcdef0123456789abcdef0123456789';
const avatarOf = (discordId) => `https://cdn.discordapp.com/avatars/${discordId}/${AVATAR}.png?size=64`;

// Runs `before` (raw SQL) once, right before the first db.batch whose statements match `pattern`: a concurrent writer.
// Returns a restore function that answers whether the race fired.
function raceBefore(w, pattern, before) {
  const original = w.db.batch.bind(w.db);
  let fired = false;
  w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => pattern.test(statement.sql))) { fired = true; before(); }
    return original(statements);
  };
  return () => { w.db.batch = original; return fired; };
}

check('fix 1: avatar URLs (they carry a Discord ID) reach only guild.access / guild.roles holders; initials for everyone else', async () => {
  const s = await scenario({ teams: 1 });
  exec(s.w, `UPDATE users SET avatar = '${AVATAR}' WHERE id IN ('${s.ids.erin}', '${s.ids.bob}')`);
  const made = await addPerson(s, 'bob', s.teamId, 'Aldric', { linkUserId: s.ids.erin });
  const pid = made.person.id;
  assert.equal((await s.call('bob', 'PUT', `/roster/${pid}/notes`, { text: 'hello', expectedNotesVersion: 0 })).status, 200);
  const view = async (who) => (await s.call(who, 'GET', `/roster/${pid}`)).json;
  for (const who of ['alice', 'bob']) {
    const record = await view(who);
    assert.equal(record.person.discord.user.avatarUrl, avatarOf(PEOPLE.erin.id), who);
    assert.equal(record.notes.updatedBy.avatarUrl, avatarOf(PEOPLE.bob.id), who);
  }
  const lead = await view('carol');
  assert.equal(lead.person.discord.user.avatarUrl, null, 'Team Lead');
  assert.equal(lead.person.discord.user.initials, 'EE');
  assert.equal(lead.notes.updatedBy.avatarUrl, null);
  assert.equal(JSON.stringify(lead).includes(PEOPLE.erin.id), false, 'no Discord ID anywhere in a Team Lead response');
  const member = await view('dave');
  assert.equal(member.person.discord.user.avatarUrl, null, 'Member');
  assert.equal(JSON.stringify(member).includes(PEOPLE.erin.id), false);
  // The reply of a write goes through the same builder.
  const patched = await s.call('carol', 'PATCH', `/roster/${pid}`, { expectedVersion: 1, status: 'trial' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.person.discord.user.avatarUrl, null);
  // The linkable list.
  const free = await s.call('bob', 'GET', '/roster/linkable');
  const freeLead = await s.call('carol', 'GET', '/roster/linkable');
  assert.equal(free.status, 200);
  assert.equal(freeLead.status, 200);
  assert(freeLead.json.users.length >= 1);
  assert.deepEqual(freeLead.json.users.filter((user) => user.avatarUrl), []);
  assert(free.json.users.some((user) => user.avatarUrl));
});

check('fix 2: the Warcraft Logs commit stores only a realm the guild accepts, in its canonical spelling (the three-Aldric scenario)', async () => {
  const s = await scenario();
  await addPerson(s, 'bob', s.teamId, 'Aldric');
  const one = async (extra) => { s.w.advance(WINDOW); return wclCommit(s, 'bob', { decisions: [{ action: 'new', name: 'Aldric', class: 'MAGE', ...extra }] }); };
  for (const realm of ['(x)', "'-", 'Other‮Realm', 'Nowhere', 'x'.repeat(41), 5]) {
    const r = await one({ realm });
    assert.deepEqual([r.status, r.json.error, r.json.field, r.json.index], [400, 'bad_request', 'realm', 0], String(realm));
  }
  const taken = await one({ realm: '​nightslayer ' });
  assert.deepEqual([taken.status, taken.json.error], [409, 'name_taken'], 'invisible characters are stripped first: same realm, same name');
  assert.equal(await s.w.count('characters'), 1, 'nothing stored by the refused commits');
  const listed = await one({ realm: 'dreamscythe' });
  assert.equal(listed.status, 201, JSON.stringify(listed.json));
  assert.deepEqual((await s.w.rows("SELECT realm, realm_key FROM characters WHERE realm_key = 'dreamscythe'"))[0], { realm: 'Dreamscythe', realm_key: 'dreamscythe' });
  const kept = await one({ realm: null, name: 'Brindle' });
  assert.equal(kept.status, 201);
  assert.equal((await s.w.rows("SELECT realm FROM characters WHERE name = 'Brindle'"))[0].realm, 'Nightslayer');
  // A guild realm with a suffix: the typed spelling "maladath" maps to the guild's own.
  const au = await scenario({ guildBody: { realm: 'Maladath (AU)' } });
  const r = await wclCommit(au, 'bob', { decisions: [{ action: 'new', name: 'Cassia', class: 'MAGE', realm: 'maladath' }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await au.w.rows("SELECT realm FROM characters WHERE name = 'Cassia'"))[0].realm, 'Maladath (AU)');
  // A ruleset guild ignores the realm.
  const ruleset = await secondGuild(s, { gameVersion: 'forever', realm: 'Hardcore' });
  const ignored = await s.w.call(ruleset.frank, 'POST', `${ruleset.path}/roster/import/wcl/commit`, {
    teamId: ruleset.teamId, report: { code: REPORT, flavour: 'www' }, decisions: [{ action: 'new', name: 'Dunmar', class: 'MAGE', realm: 'Whatever (x)' }],
  });
  assert.equal(ignored.status, 201, JSON.stringify(ignored.json));
  assert.deepEqual((await s.w.rows("SELECT realm, realm_key FROM characters WHERE name = 'Dunmar'"))[0], { realm: null, realm_key: '' });
  // The preview uses the same helper: canonical spelling, unknown realms are another realm, an empty key is dropped.
  s.w.sources.reports.set(REPORT, { title: 'T', startTime: 1, zone: null, masterData: { actors: [
    actor('Eliora', 'Mage', 'dreamscythe'), actor('Fenwick', 'Mage', 'Nowhere'), actor('Galdor', 'Mage', '(x)'), actor('Hestia', 'Mage', 'NIGHTSLAYER'),
  ] } });
  s.w.advance(WINDOW);
  const view = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual(view.json.toDecide.map((row) => [row.name, row.realm, row.otherRealm]), [
    ['Eliora', 'Dreamscythe', true], ['Fenwick', 'Nowhere', true], ['Hestia', 'Nightslayer', false],
  ]);
});

check('fix 3 + 4: writes repeat the permission predicate; a person or character that moved is a 409 with `current`, a gone one a 404', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const mk = async (name) => {
    const made = await addPerson(s, 'bob', A, name);
    const alt = (await addAlt(s, 'bob', made.person.id, A, `${name}ing`)).json.characters.find((c) => !c.isMain);
    return { pid: made.person.id, main: made.characters[0], alt };
  };
  const auditCount = (action) => s.w.count('audit_log', 'action = ?', action);
  const moveTo = (id) => () => exec(s.w, `UPDATE characters SET team_id = '${B}' WHERE id = '${id}'`);

  // Character PATCH by Carol (leads A); an officer moves the Alt to B first.
  let p = await mk('Aldric');
  let done = raceBefore(s.w, /UPDATE characters SET name/, moveTo(p.alt.id));
  let r = await s.call('carol', 'PATCH', `/roster/${p.pid}/characters/${p.alt.id}`, { name: 'Renamed' });
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  assert.equal(r.json.current.characters.find((c) => c.id === p.alt.id).team.id, B);
  assert.notEqual((await s.w.rows('SELECT name FROM characters WHERE id = ?', p.alt.id))[0].name, 'Renamed');
  assert.equal(await auditCount('character.update'), 0, 'no audit row for a write that changed nothing');
  // ... and when the character is gone: 404.
  p = await mk('Aldricb');
  done = raceBefore(s.w, /UPDATE characters SET name/, () => exec(s.w, `DELETE FROM characters WHERE id = '${p.alt.id}'`));
  r = await s.call('carol', 'PATCH', `/roster/${p.pid}/characters/${p.alt.id}`, { name: 'Renamed' });
  assert.deepEqual([r.status, r.json.error], [404, 'not_found']);
  done();

  // Character DELETE.
  p = await mk('Brindle');
  done = raceBefore(s.w, /DELETE FROM characters/, moveTo(p.alt.id));
  r = await s.call('carol', 'DELETE', `/roster/${p.pid}/characters/${p.alt.id}`, {});
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  assert.equal(await s.w.count('characters', 'id = ?', p.alt.id), 1, 'the Alt is still there');
  assert.equal(await auditCount('character.delete'), 0);

  // Make Main.
  p = await mk('Cassia');
  done = raceBefore(s.w, /UPDATE characters SET is_main = 0/, moveTo(p.alt.id));
  r = await s.call('carol', 'POST', `/roster/${p.pid}/characters/${p.alt.id}/main`, {});
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  await assertOneMain(s.w);

  // Person PATCH, notes and DELETE by Carol after the Main moved to B.
  p = await mk('Dunmar');
  done = raceBefore(s.w, /UPDATE players SET status/, moveTo(p.main.id));
  r = await s.call('carol', 'PATCH', `/roster/${p.pid}`, { expectedVersion: 1, status: 'reserve' });
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  assert.equal(r.json.current.person.homeTeam.id, B);
  assert.equal((await s.w.rows('SELECT status FROM players WHERE id = ?', p.pid))[0].status, 'raider');

  p = await mk('Eliora');
  done = raceBefore(s.w, /UPDATE players SET notes/, moveTo(p.main.id));
  r = await s.call('carol', 'PUT', `/roster/${p.pid}/notes`, { text: 'secret', expectedNotesVersion: 0 });
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  assert.equal((await s.w.rows('SELECT notes FROM players WHERE id = ?', p.pid))[0].notes, null);

  p = await mk('Fenwick');
  done = raceBefore(s.w, /DELETE FROM players/, moveTo(p.main.id));
  r = await s.call('carol', 'DELETE', `/roster/${p.pid}`, {});
  assert.equal(done(), true);
  assert.deepEqual([r.status, r.json.error], [409, 'conflict']);
  assert.equal(await s.w.count('players', 'id = ?', p.pid), 1);
  assert.equal(await auditCount('person.delete'), 0);

  // Gone: 404.
  p = await mk('Galdor');
  done = raceBefore(s.w, /DELETE FROM players/, () => exec(s.w, `DELETE FROM players WHERE id = '${p.pid}'`));
  r = await s.call('carol', 'DELETE', `/roster/${p.pid}`, {});
  assert.deepEqual([r.status, r.json.error], [404, 'not_found']);
  done();

  // Fix 4: the delete is judged by the returned rows, not meta.changes (D1 may count cascaded rows).
  p = await mk('Hestia');
  const original = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    const results = await original(statements);
    if (statements.some((statement) => /DELETE FROM players/.test(statement.sql))) for (const result of results) result.meta.changes = 3;
    return results;
  };
  r = await s.call('carol', 'DELETE', `/roster/${p.pid}`, {});
  s.w.db.batch = original;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await s.w.count('players', 'id = ?', p.pid), 0);
  await assertOneMain(s.w);
});

check('fix 6: an import that creates nothing and refreshes nothing writes no audit row and answers 200', async () => {
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, sampleEvent());
  const before = await counts(s.w);
  const rh = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows: [] });
  const wcl = await wclCommit(s, 'bob', { decisions: [{ action: 'skip' }] });
  assert.deepEqual([rh.status, rh.json.people, rh.json.characters, Object.keys(rh.json.rosterFlags).length], [200, 0, 0, 1]);
  assert.deepEqual([wcl.status, wcl.json.people, wcl.json.characters], [200, 0, 0]);
  assert.deepEqual(await counts(s.w), before);
});

check('fix 7: character names are letters with at most two marks each, measured after the case mapping', async () => {
  const d = await load('worker/roster-data.js');
  assert.equal(d.cleanCharacterName('ßa'), 'SSa');
  assert.equal(d.cleanCharacterName('ß'.repeat(12)), null);
  assert.equal(d.cleanCharacterName('ß'.repeat(11)), 'SS' + 'ß'.repeat(10), 'exactly 12 after the mapping');
  for (const bad of ['́́', '́ab', 'Á́́́', 'A' + '́'.repeat(11), 'Ab1', 'A', 'a'.repeat(13), "A'b", '']) {
    assert.equal(d.cleanCharacterName(bad), null, JSON.stringify(bad));
  }
  assert.equal(d.cleanCharacterName('  aldric '), 'Aldric');
  assert.equal(d.cleanCharacterName('sølvhand'), 'Sølvhand');
  assert.equal(d.cleanCharacterName('élan'), 'Élan');
});

check('fix 8: maps indexed by external text use own properties only', async () => {
  const d = await load('worker/roster-data.js');
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(d.ownValue(d.RAID_HELPER_SPEC, key), undefined, key);
    assert.equal(d.ownValue(d.WCL_CLASS, key), undefined, key);
    assert.equal(d.roleOf('WARRIOR', key), null, key);
    assert.equal(d.roleOf(key, 'Arms'), null, key);
    assert.equal(d.isSpecOf(key, 'Arms'), false, key);
  }
  assert.equal(d.roleOf('WARRIOR', 'Arms'), 'dps');
  const s = await scenario();
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [
    signUp(1, DID(1), 'Aldric', 'constructor', '__proto__'), signUp(2, DID(2), 'Brindle', 'Warrior', 'constructor'), signUp(3, DID(3), 'Cassia', '__proto__', 'toString'),
  ]));
  const r = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.rows.map((row) => [row.main.name, row.main.class, row.main.spec, row.main.note]), [
    ['Aldric', null, null, 'no_class'], ['Brindle', 'WARRIOR', null, null], ['Cassia', null, null, 'no_class'],
  ]);
  s.w.sources.reports.set(REPORT, { title: 'T', startTime: 1, zone: null, masterData: { actors: [
    actor('Aldric', 'constructor'), actor('Brindle', '__proto__'), actor('Cassia', 'toString'), actor('Dunmar', 'Mage'),
  ] } });
  s.w.advance(WINDOW);
  const wcl = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual(wcl.json.toDecide.map((row) => row.name), ['Dunmar']);
});

check('fix 9: a GraphQL error that says the report does not exist is a 404', async () => {
  const s = await scenario();
  s.w.sources.wcl.errors = [{ message: 'The report you requested does not exist.' }];
  const r = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual([r.status, r.json.error], [404, 'not_found']);
  s.w.advance(WINDOW);
  s.w.sources.wcl.errors = [{ message: 'Report not found' }];
  assert.equal((await wclPreview(s, 'bob', REPORT)).status, 404);
});

check('fix 10: "signed in" counts only users in this guild\'s Discord server and not blocked here', async () => {
  const s = await scenario();
  const made = await addPerson(s, 'bob', s.teamId, 'Aldric', { linkUserId: s.ids.erin });
  const pid = made.person.id;
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [signUp(1, PEOPLE.erin.id, 'Brindle', 'Warrior', 'Arms')]));
  const state = async () => {
    s.w.advance(WINDOW);
    const list = await s.call('bob', 'GET', `/roster?team=${s.teamId}`);
    const record = await s.call('bob', 'GET', `/roster/${pid}`);
    const rh = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
    return [list.json.people[0].signIn, record.json.person.discord.signIn, record.json.person.discord.user && 'user', rh.json.rows[0].signedIn];
  };
  assert.deepEqual(await state(), ['signed_in', 'signed_in', 'user', true]);
  exec(s.w, `INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('${s.guildId}', '${s.ids.erin}', 1)`);
  assert.deepEqual(await state(), ['not_yet', 'not_yet', null, false], 'blocked here');
  exec(s.w, `DELETE FROM guild_blocks WHERE user_id = '${s.ids.erin}'`);
  exec(s.w, `DELETE FROM user_servers WHERE user_id = '${s.ids.erin}'`);
  assert.deepEqual(await state(), ['not_yet', 'not_yet', null, false], 'left the Discord server');
  exec(s.w, `INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('${s.ids.erin}', '${OTHER_SERVER}', 1)`);
  assert.deepEqual(await state(), ['not_yet', 'not_yet', null, false], 'in another server only');
});

check('fix 11: zero-width, line-separator and word-joiner characters are stripped from nicknames and notes (newlines stay)', async () => {
  const s = await scenario();
  const made = await addPerson(s, 'bob', s.teamId, 'Aldric');
  const text = 'a​b‌c‍d‎e‏f g h؜i﻿j⁠k‮l\nm';
  const saved = await s.call('bob', 'PUT', `/roster/${made.person.id}/notes`, { text, expectedNotesVersion: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.notes.text, 'abcdefghijkl\nm');
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [signUp(1, DID(1), 'Bri​ndle⁠  (Kes﻿trel)', 'Warrior', 'Arms')]));
  const r = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows: [{ signupId: 1, main: { name: 'Brindle', class: 'WARRIOR' } }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await s.w.rows('SELECT discord_nickname FROM players WHERE discord_user_id = ?', DID(1)))[0].discord_nickname, 'Brindle (Kestrel)');
});

check('fix 12: rosterFlags skip archived teams', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  await addPerson(s, 'bob', A, 'Aldric', { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-20' });
  await addPerson(s, 'bob', B, 'Brindle', { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-20' });
  assert.equal((await s.call('alice', 'PATCH', `/teams/${B}`, { archived: true })).status, 200);
  const other = await addPerson(s, 'bob', A, 'Cassia');
  assert.deepEqual(other.rosterFlags, { [A]: 1 });
  const guild = await s.call('bob', 'GET', '');
  assert.deepEqual(guild.json.rosterFlags, { [A]: 1 });
});

check('fix 13: shape checks come before any database read; a missing WCL credential is a 503 that consumes no window', async () => {
  const s = await scenario();
  const seen = [];
  const prepare = s.w.db.prepare.bind(s.w.db);
  s.w.db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  const rows = Array.from({ length: 101 }, (_, i) => ({ signupId: i + 1 }));
  seen.length = 0;
  const rh = await commit(s, 'bob', { teamId: s.teamId, eventId: EVENT_ID, defaultStatus: 'raider', rows });
  assert.deepEqual([rh.status, rh.json.field], [400, 'rows']);
  assert.equal(seen.some((sql) => /FROM guilds/.test(sql)), false, 'no guild read before the cap check');
  seen.length = 0;
  const wcl = await wclCommit(s, 'bob', { decisions: Array.from({ length: 101 }, () => ({ action: 'skip' })) });
  assert.deepEqual([wcl.status, wcl.json.field], [400, 'decisions']);
  assert.equal(seen.some((sql) => /FROM guilds/.test(sql)), false);
  s.w.env.WCL_CLIENT_SECRET = '';
  const off = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual([off.status, off.json.error], [503, 'wcl_not_configured']);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'imp:%' OR key LIKE 'wcl:%'"), 0, 'no import window was consumed');
  s.w.db.prepare = prepare;
});

// ---------------------------------------------------------------------------
// Round W2: workerd runtime differences, roster search names

check('workerd: no file under worker/ passes redirect: "error" to fetch (workerd allows only follow / manual)', async () => {
  const fs = require('node:fs');
  const walkDir = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walkDir(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
  const offenders = walkDir('worker').filter((file) => file.endsWith('.js'))
    .filter((file) => /redirect\s*:\s*['"]error['"]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

check('redirects: a 3xx from Raid-Helper, the WCL token endpoint or the WCL API is the source being unavailable, and fetch is asked for redirect manual', async () => {
  const s = await scenario();
  s.w.sources.rh.status = 302;
  const rh = await preview(s, 'bob', { teamId: s.teamId, source: EVENT_ID });
  assert.deepEqual([rh.status, rh.json.error], [502, 'raid_helper_unavailable']);
  assert(rhCalls(s).every((call) => call.init.redirect === 'manual'));
  s.w.sources.rh.status = null;
  s.w.sources.reports.set(REPORT, sampleReport());
  s.w.sources.wcl.httpStatus = 302;
  s.w.advance(WINDOW);
  const wcl = await wclPreview(s, 'bob', REPORT);
  assert.deepEqual([wcl.status, wcl.json.error], [502, 'wcl_unavailable']);
  assert(wclCalls(s).every((call) => call.init.redirect === 'manual'));
  // The token endpoint redirecting.
  const { resetWclTokenCache } = await load('worker/sources.js');
  resetWclTokenCache();
  s.w.sources.wcl.httpStatus = null;
  const original = s.w.sources.fetch;
  const t = await scenario();
  t.w.sources.reports.set(REPORT, sampleReport());
  const wrapped = t.w.sources.fetch;
  t.w.sources.fetch = async (url, init) => (new URL(String(url)).pathname === '/oauth/token' ? new Response('', { status: 301, headers: { Location: 'https://evil.test/' } }) : wrapped(url, init));
  void original;
  const tok = await wclPreview(t, 'bob', REPORT);
  assert.deepEqual([tok.status, tok.json.error], [502, 'wcl_unavailable']);
});

check('roster rows carry `names`: every character name of the person on the selected team, sorted', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  const made = await addPerson(s, 'bob', A, 'Zandar');
  await addAlt(s, 'bob', made.person.id, A, 'Brindle');
  await addAlt(s, 'bob', made.person.id, B, 'Cassia');
  const solo = await addPerson(s, 'bob', B, 'Aldric');
  const listA = await s.call('bob', 'GET', `/roster?team=${A}`);
  assert.deepEqual(listA.json.people.map((row) => [row.id, row.names]), [[made.person.id, ['Brindle', 'Zandar']]]);
  const listB = await s.call('bob', 'GET', `/roster?team=${B}`);
  const byId = Object.fromEntries(listB.json.people.map((row) => [row.id, row.names]));
  assert.deepEqual(byId, { [made.person.id]: ['Cassia'], [solo.person.id]: ['Aldric'] });
});

// ---------------------------------------------------------------------------

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
      console.log(String(error && error.stack || error).split('\n').slice(0, 10).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
