/**
 * Raidsmith guild tracker - attendance Worker tests (Phase 3, lane W)
 * Run: node guild-attendance-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord,
 * Raid-Helper and Warcraft Logs faked by an injected fetch. No network, no Wrangler, no credentials. The pure rules are
 * pinned in guild-attendance-rules-tests.js; here the routes, the store and the SQL are.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
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
    queries: [],
    listing: () => ({ data: [], has_more_pages: false }),
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
        const payload = JSON.parse(init.body);
        s.queries.push(payload);
        if (/reports\s*\(/.test(payload.query)) return Response.json({ data: { reportData: { reports: s.listing(payload.variables) } } });
        const code = payload.variables.code;
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
  const clock = { now: 1_800_100_800_000 }; // just after RH_START: a Raid-Helper event that has not started is refused
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
// Fixtures for the raids

const R1 = 'Aaaa000000000001';
const R2 = 'Aaaa000000000002';
const R3 = 'Aaaa000000000003';
const NY = 'America/New_York';

// A Warcraft Logs report as the GraphQL answers it. actors: [id, name, subType, server?]; fights: [id, name, encounterID, kill, startOffset, seconds, [actor ids]].
function wclReport({ startTime = RH_START * 1000, owner = 'Upl', zone = 'Gruul', actors, fights }) {
  return {
    startTime,
    endTime: startTime + 4 * 3600 * 1000,
    zone: { name: zone },
    owner: { name: owner },
    fights: fights.map(([id, name, encounterID, kill, start, seconds, friendlyPlayers]) => ({
      id, name, encounterID, kill, startTime: start, endTime: start + seconds * 1000, friendlyPlayers,
    })),
    masterData: { actors: actors.map(([id, name, subType, server = 'Nightslayer']) => ({ id, name, subType, server })) },
  };
}

// Aldric is in every pull; Cassia misses the first; Eliora misses the last; Wanderfell (team B) is in the middle one;
// Zorgax is on no roster; the pet and the NPC are dropped; Brindle and Dunmar are not in the log; "Trash" is no boss pull
// and the last Magtheridon fight has no kill flag yet (still uploading).
const ACTORS_1 = [[1, 'Aldric', 'Warrior'], [3, 'Cassia', 'Mage'], [5, 'Eliora', 'Priest'], [6, 'Wanderfell', 'Druid'], [7, 'Zorgax', 'Rogue'], [8, 'Rexxar', 'Pet'], [9, 'Weird', 'NPC']];
const report1 = (extra = {}) => wclReport({
  actors: ACTORS_1,
  fights: [
    [1, 'Trash', 0, false, 0, 90, [1, 3, 5]],
    [2, 'Maulgar', 649, false, 60_000, 200, [1, 5, 7, 8]],
    [3, 'Maulgar', 649, true, 600_000, 240, [1, 3, 5, 6, 7]],
    [4, 'Gruul', 650, false, 1_200_000, 150, [1, 3, 7, 8]],
    [5, 'Magtheridon', 651, null, 1_800_000, 80, [1, 3, 5]],
  ],
  ...extra,
});

const LINES = [
  ['aldric', 'Aldric', 0, 1], ['brindle', 'Brindle', 0, 2], ['cassia', 'Cassia', 0, 3], ['dunmar', 'Dunmar', 0, 4],
  ['eliora', 'Eliora', 0, 5], ['fenwick', 'Fenwick', 0, 6], ['wander', 'Wanderfell', 1, 7],
];
const eventSignUps = () => [
  signUp(1, DID(1), 'Aldric', 'Warrior', 'Arms'),
  signUp(2, DID(2), 'Brindle', 'Mage', 'Fire'),
  signUp(3, DID(3), 'Cassia', 'Mage', 'Frost'),
  signUp(4, DID(4), 'Dunmar', 'Absence', undefined),
  signUp(5, DID(5), 'Eliora', 'Bench', undefined),
  signUp(6, '299999999999999999', 'Stranger', 'Rogue', 'Combat'),
];

// Two teams (A = teams[0], B = teams[1]) with the people above on the roster, each linked to its Discord ID.
async function raidWorld({ teams = 2 } = {}) {
  const s = await scenario({ teams });
  const [A, B] = s.teams;
  s.A = A; s.B = B;
  s.p = {};
  for (const [key, name, which, n] of LINES) {
    if (which === 1 && !B) continue;
    const made = await addPerson(s, 'bob', which === 1 ? B : A, name);
    s.p[key] = made.person.id;
    exec(s.w, `UPDATE players SET discord_user_id = '${DID(n)}' WHERE id = '${made.person.id}'`);
  }
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, eventSignUps()));
  s.w.sources.reports.set(R1, report1());
  s.raid = (id, route = '') => `/raids/${id}${route}`;
  return s;
}

// The full raid: created from the event, then the report added.
async function fullRaid(s, who = 'bob') {
  const created = await s.call(who, 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.raid.id;
  const added = await s.call(who, 'PUT', s.raid(id, '/reports'), { source: R1 });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  return { id, detail: added.json };
}

const byName = (detail) => Object.fromEntries(detail.people.map((row) => [row.name, row]));
const outcomes = (detail) => Object.fromEntries(detail.people.map((row) => [row.name, row.outcome]));

// Counts D1 calls (statement first/all/run and batch) and fetches made inside fn.
async function counted(w, fn) {
  const proto = Object.getPrototypeOf(w.db.prepare('SELECT 1'));
  const saved = { first: proto.first, all: proto.all, run: proto.run, batch: w.db.batch };
  const count = { d1: 0, fetch: 0 };
  const wrap = (original) => function wrapped(...args) { count.d1++; return original.apply(this, args); };
  proto.first = wrap(saved.first); proto.all = wrap(saved.all); proto.run = wrap(saved.run);
  w.db.batch = function batch(...args) { count.d1++; return saved.batch.apply(this, args); };
  const before = w.sources.calls.length;
  try { await fn(); } finally {
    Object.assign(proto, { first: saved.first, all: saved.all, run: saved.run });
    w.db.batch = saved.batch;
  }
  count.fetch = w.sources.calls.length - before;
  return count;
}

const sqlFails = (fn, pattern) => assert.throws(fn, pattern);

// ---------------------------------------------------------------------------
// Schema and seeds

check('migration 0003: nights.* became raids.*, attendance.policy is seeded for Guild Master and Officer only, and the tables are there', async () => {
  const w = await makeWorld();
  const rows = await w.rows('SELECT role_id, action, scope FROM role_permissions WHERE action LIKE ? OR action LIKE ? OR action = ? ORDER BY role_id, action', 'raids.%', 'nights.%', 'attendance.policy');
  assert.deepEqual(rows.map((r) => `${r.role_id}:${r.action}:${r.scope}`), [
    'guild_master:attendance.policy:guild', 'guild_master:raids.edit:guild', 'guild_master:raids.view:guild',
    'member:raids.view:guild', 'officer:attendance.policy:guild', 'officer:raids.edit:guild', 'officer:raids.view:guild',
    'team_lead:raids.edit:team',
  ]);
  const tables = (await w.rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  for (const t of ['attendance_policies', 'raids', 'raid_reports', 'raid_pulls', 'raid_presence', 'raid_signups', 'raid_manual', 'raid_plan', 'attendance', 'attendance_guests']) assert(tables.includes(t), t);
  const { ACTIONS } = await load('worker/permissions.js');
  assert(ACTIONS.includes('raids.view') && ACTIONS.includes('attendance.policy') && !ACTIONS.some((a) => a.startsWith('nights.')));
});

check('schema: one raid per team and date, an event and a report back one raid; a raid delete cascades; a person delete takes their attendance and unlinks their sign-up', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const raid = (await s.w.rows('SELECT * FROM raids WHERE id = ?', id))[0];
  const ins = (extra, values) => `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, ${extra}created_at, updated_at) VALUES ('r_x', '${s.guildId}', ${values}1, 1)`;
  sqlFails(() => exec(s.w, ins('', `'${s.A}', '${raid.raid_on}', 1, `)), /UNIQUE/);
  sqlFails(() => exec(s.w, ins('event_id, ', `'${s.B}', '2020-01-01', 1, '${EVENT_ID}', `)), /UNIQUE/);
  sqlFails(() => exec(s.w, ins("log_mode, ", `'${s.B}', '2020-01-01', 1, 'manual', `)), /CHECK/);
  sqlFails(() => exec(s.w, ins('', `'${s.B}', '2020-13-45', 1, `)), /CHECK/);
  assert((await s.w.count('raid_presence')) > 0);
  assert((await s.w.count('attendance')) > 0);
  const before = await s.w.count('raid_signups');
  assert.equal((await s.w.rows('SELECT player_id FROM raid_signups WHERE discord_user_id = ?', DID(1)))[0].player_id, s.p.aldric);
  assert.equal((await s.call('bob', 'DELETE', `/roster/${s.p.aldric}`, {})).status, 200);
  assert.equal(await s.w.count('raid_signups'), before);
  assert.equal((await s.w.rows('SELECT player_id FROM raid_signups WHERE discord_user_id = ?', DID(1)))[0].player_id, null);
  assert.equal(await s.w.count('attendance', 'player_id = ?', s.p.aldric), 0);
  assert.equal((await s.call('bob', 'DELETE', s.raid(id), {})).status, 200);
  for (const t of ['raid_reports', 'raid_pulls', 'raid_presence', 'raid_signups', 'attendance']) assert.equal(await s.w.count(t), 0, t);
});

// ---------------------------------------------------------------------------
// Creating raids, the golden outcomes, Warcraft Logs

check('create: from an event (date, sign-ups linked by Discord ID, kinds), 201 detail shape, audit', async () => {
  const s = await raidWorld();
  const { localDate } = await load('worker/attendance-calendar.js');
  const r = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = r.json;
  assert.equal(d.raid.raidOn, localDate(RH_START * 1000, NY));
  assert.equal(d.raid.startsAt, RH_START * 1000);
  assert.deepEqual([d.raid.team.id, d.raid.state], [s.A, 'awaiting_log']);
  assert.equal(d.sources.event.id, EVENT_ID);
  assert.equal(d.sources.event.signups, 6);
  assert.equal(d.sources.event.otherServer, false);
  assert.deepEqual(d.sources.reports, []);
  assert.deepEqual(Object.keys(d.can).sort(), ['edit', 'review', 'seeAttendance', 'seeNicknames']);
  assert.deepEqual(d.people, [], 'no log: nothing is guessed from sign-ups alone');
  const kinds = Object.fromEntries(d.signups.map((x) => [x.className, x.kind]));
  assert.deepEqual([kinds.Absence, kinds.Bench, kinds.Warrior], ['absence', 'bench', 'signed']);
  const rows = await s.w.rows('SELECT discord_user_id, player_id, source FROM raid_signups ORDER BY signup_id');
  assert.equal(rows[0].player_id, s.p.aldric);
  assert.equal(rows[5].player_id, null, 'a Discord ID that is on no roster has no person');
  assert(rows.every((row) => row.source === 'raid_helper'));
  assert.equal(await s.w.count('audit_log', "action = 'raid.create'"), 1);
});

check('create: the date comes from the event, else the first pull, else raidOn (a real date; a future one is an upcoming raid)', async () => {
  const s = await raidWorld();
  const noDate = await s.call('bob', 'POST', '/raids', { teamId: s.A });
  assert.deepEqual([noDate.status, noDate.json.field], [400, 'raidOn']);
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-02-30' })).status, 400);
  const farFuture = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2099-01-01' });
  assert.deepEqual([farFuture.status, farFuture.json.raid.upcoming], [201, true]);
  const manualDate = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-05' });
  assert.deepEqual([manualDate.status, manualDate.json.raid.raidOn], [201, '2027-01-05']);
  // A report alone: the first pull decides.
  const fromReport = await s.call('bob', 'POST', '/raids', { teamId: s.B, reportSource: R1 });
  assert.equal(fromReport.status, 201, JSON.stringify(fromReport.json));
  assert.equal(fromReport.json.raid.startsAt, RH_START * 1000 + 60_000);
  assert.equal(fromReport.json.sources.reports.length, 1);
  // The same event again, a second raid for the same team and date.
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID })).status, 201);
  const again = await s.call('bob', 'POST', '/raids', { teamId: s.B, eventSource: EVENT_ID });
  assert.deepEqual([again.status, again.json.error], [409, 'event_exists']);
  assert(isRaidId(again.json.raidId));
  const same = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-05' });
  assert.deepEqual([same.status, same.json.error], [409, 'raid_exists']);
  assert.equal(same.json.raidId, manualDate.json.raid.id);
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: 't_nope' })).json.field, 'teamId');
});

function isRaidId(value) { return /^r_[A-Za-z0-9_-]{22}$/.test(String(value)); }

check('create: the time zone decides the date (a pull at 02:21Z is still the previous evening in America/New_York)', async () => {
  const s = await raidWorld();
  const start = Date.parse('2027-02-10T02:21:00Z');
  s.w.sources.reports.set(R2, wclReport({ startTime: start, actors: ACTORS_1, fights: [[1, 'Gruul', 650, true, 0, 200, [1, 3]]] }));
  const r = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSource: R2 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.raid.raidOn, '2027-02-09');
});

check('create: other_server needs acceptOtherServer; a past or private event and a bad link are refused', async () => {
  const s = await raidWorld();
  s.w.sources.events.set('222222222222222222', rhEvent('222222222222222222', OTHER_SERVER, eventSignUps()));
  const refused = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: '222222222222222222' });
  assert.deepEqual([refused.status, refused.json.error], [409, 'other_server']);
  assert.equal(await s.w.count('raids'), 0);
  const ok = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: '222222222222222222', acceptOtherServer: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.sources.event.otherServer, true);
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.B, eventSource: 'https://evil.test/event/111111' })).status, 400);
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.B, eventSource: '999999999999999999' })).status, 404);
});

check('golden: event + report -> present, bench-who-left-early, late, missed (no_show), missed with notice, no sign-up, Other-team, unmatched; 4 open flags', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  const o = outcomes(detail);
  assert.deepEqual(o, {
    Aldric: 'present', Brindle: 'missed', Cassia: 'late', Dunmar: 'missed_notice', Eliora: 'left_early', Fenwick: 'no_signup', Wanderfell: 'fill_in',
  });
  const rows = byName(detail);
  assert.deepEqual(rows.Brindle.flags, ['no_show']);
  assert.deepEqual([rows.Cassia.credit, rows.Eliora.credit, rows.Brindle.credit, rows.Aldric.credit], [null, null, 0, 1]);
  assert.deepEqual(rows.Cassia.pulls, { present: 2, total: 3, missedFirst: true, missedLast: false });
  assert.equal(rows.Eliora.pulls.missedLast, true);
  assert.equal(rows.Wanderfell.credit, 1, 'team B has no raid that date: an extra counted cell');
  assert.deepEqual(detail.unmatched.map((u) => [u.name, u.pullsPresent]), [['Zorgax', 3]]);
  assert.deepEqual([detail.raid.state, detail.raid.openFlags, detail.raid.stale], ['to_review', 4, false]);
  assert.equal(detail.pulls.length, 3, 'the Trash fight and the unfinished Magtheridon fight are not pulls');
  assert.deepEqual(detail.sources.reports.map((x) => [x.code, x.pulls]), [[R1, 3]]);
  assert.equal(detail.raid.zone, 'Gruul');
  assert.equal((await s.w.rows('SELECT open_flags FROM raids WHERE id = ?', id))[0].open_flags, 4);
  // The flagged rows come first.
  assert.deepEqual(detail.people.slice(0, 3).map((x) => x.needsReview), [true, true, true]);
  // The list says the same.
  const list = await s.call('bob', 'GET', `/raids?team=${s.A}`);
  assert.deepEqual(list.json.raids.map((x) => [x.state, x.bosses, x.sources, x.openFlags, x.stale]), [['to_review', { kills: 1, pulls: 3 }, { event: true, reports: 1, plan: false }, 4, false]]);
  assert.deepEqual(list.json.raids[0].counts, { present: 4, bench: 0, missed: 2 });
});

check('WCL: only derived data is written (no title, no fight events), pets and NPCs are dropped, startedAt is absolute, the code is a query variable', async () => {
  const s = await raidWorld();
  await fullRaid(s);
  const query = s.w.sources.queries.find((q) => /fights/.test(q.query));
  assert.deepEqual(query.variables, { code: R1 });
  assert(!/title|damage|healing|events|gear/i.test(query.query));
  assert.deepEqual((await s.w.rows('SELECT fight_id, encounter_id, kill, started_at, ended_at FROM raid_pulls ORDER BY fight_id')).map((r) => [r.fight_id, r.encounter_id, r.kill, r.started_at - RH_START * 1000, r.ended_at - r.started_at]),
    [[2, 649, 0, 60_000, 200_000], [3, 649, 1, 600_000, 240_000], [4, 650, 0, 1_200_000, 150_000]]);
  assert.deepEqual((await s.w.rows('SELECT DISTINCT name FROM raid_presence ORDER BY name')).map((r) => r.name), ['Aldric', 'Cassia', 'Eliora', 'Wanderfell', 'Zorgax']);
  const report = (await s.w.rows('SELECT * FROM raid_reports'))[0];
  assert.deepEqual(Object.keys(report).sort(), ['code', 'ended_at', 'flavour', 'guild_id', 'owner', 'raid_id', 'started_at', 'synced_at']);
  assert.equal(report.flavour, 'fresh');
  assert.equal(report.owner, 'Upl');
  // No column of any raid table holds text that only the report knew (a title, the zone name stays on the raid).
  const dump = JSON.stringify([await s.w.rows('SELECT * FROM raid_reports'), await s.w.rows('SELECT * FROM raid_pulls'), await s.w.rows('SELECT * FROM raid_presence')]);
  assert(!/Trash|Magtheridon/.test(dump));
  assert.deepEqual((await s.w.rows("SELECT name FROM pragma_table_info('raid_presence') ORDER BY cid")).map((r) => r.name), ['pull_id', 'raid_id', 'guild_id', 'name', 'name_key', 'realm', 'realm_key', 'class']);
});

check('WCL: the token is cached per flavour, a 401 fetches a new one, errors map to report_private / not_found / wcl_unavailable / no_pulls, the body is capped at 2 MB', async () => {
  const s = await raidWorld();
  const raid = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-14' })).json.raid.id;
  s.w.sources.reports.set(R1, report1({ startTime: Date.parse('2027-01-14T20:00:00Z') }));
  assert.equal((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R1 })).status, 200);
  assert.equal((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R1 })).status, 200);
  assert.equal(s.w.sources.wcl.tokenPosts.length, 1, 'one token for both calls');
  s.w.sources.wcl.tokens.clear();
  assert.equal((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R1 })).status, 200);
  assert.equal(s.w.sources.wcl.tokenPosts.length, 2, 'a 401 refetches the token once');
  s.w.sources.wcl.errors = [{ message: 'You do not have permission to view this report.' }];
  const priv = await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R2 });
  assert.deepEqual([priv.status, priv.json.error], [403, 'report_private']);
  s.w.sources.wcl.errors = null;
  assert.deepEqual((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R2 })).json.error, 'not_found');
  s.w.sources.wcl.httpStatus = 500;
  assert.equal((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R2 })).json.error, 'wcl_unavailable');
  s.w.sources.wcl.httpStatus = null;
  s.w.sources.reports.set(R2, wclReport({ startTime: Date.parse('2027-01-14T20:00:00Z'), actors: ACTORS_1, fights: [[1, 'Trash', 0, true, 0, 50, [1]]] }));
  const none = await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R2 });
  assert.deepEqual([none.status, none.json.error], [400, 'no_pulls']);
  const huge = wclReport({ startTime: Date.parse('2027-01-14T20:00:00Z'), actors: ACTORS_1, fights: [[1, 'Gruul', 650, true, 0, 50, [1]]] });
  huge.padding = 'x'.repeat(2 * 1024 * 1024 + 10);
  s.w.sources.reports.set(R3, huge);
  assert.equal((await s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R3 })).json.error, 'wcl_unavailable');
});

check('reports: a second report of the same night merges (absolute order), a refresh replaces its pulls, report_exists / report_not_same_night / confirmFar, delete recomputes', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  // R2 starts two hours later with Cassia and Eliora in its only pull, and is the LAST pull of the night.
  s.w.sources.reports.set(R2, wclReport({ startTime: RH_START * 1000 + 2 * 3600_000, actors: ACTORS_1, fights: [[1, 'Illidan', 700, false, 0, 100, [1, 3, 5, 7]]] }));
  const added = await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R2 });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.pulls.length, 4);
  const o = byName(added.json);
  assert.deepEqual([o.Eliora.outcome, o.Cassia.outcome, o.Aldric.outcome], ['present', 'late', 'present']);
  assert.deepEqual(o.Eliora.pulls, { present: 3, total: 4, missedFirst: false, missedLast: false });
  // Eliora is in the last pull now (R2) and missed none: present... unless the first pull was missed.
  const refreshed = await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R2 });
  assert.equal(refreshed.status, 200);
  assert.equal(await s.w.count('raid_pulls', 'report_code = ?', R2), 1, 'a refresh replaces, never doubles');
  // Another raid cannot take the same report.
  const other = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-13' })).json.raid.id;
  const dup = await s.call('bob', 'PUT', s.raid(other, '/reports'), { source: R2 });
  assert.deepEqual([dup.status, dup.json.error, dup.json.raidId], [409, 'report_exists', id]);
  // A report from a week later is not the same night.
  s.w.sources.reports.set(R3, wclReport({ startTime: RH_START * 1000 + 7 * 86_400_000, actors: ACTORS_1, fights: [[1, 'Gruul', 650, true, 0, 100, [1]]] }));
  const far = await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R3 });
  assert.deepEqual([far.status, far.json.error], [409, 'report_not_same_night']);
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R3, confirmFar: true })).status, 200);
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/reports/${R3}`), {})).status, 200);
  const gone = await s.call('bob', 'DELETE', s.raid(id, `/reports/${R2}`), {});
  assert.equal(gone.json.pulls.length, 3);
  assert.equal(byName(gone.json).Eliora.outcome, 'left_early');
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/reports/${R2}`), {})).status, 404);
  // Remove the last report: back to "Awaiting log", rows gone.
  const empty = await s.call('bob', 'DELETE', s.raid(id, `/reports/${R1}`), {});
  assert.deepEqual([empty.json.raid.state, empty.json.people], ['awaiting_log', []]);
  assert.equal(await s.w.count('raid_presence'), 0);
});

check('fill-in pass: the other team raids the same date, so the person\'s missed cell becomes one Other-team cell and the host credit is NULL; delete undoes it', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  s.w.advance(2 * 86_400_000);
  // Team B raids the same date; Wanderfell (team B) signs up for it and is not in its log.
  const b = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: (await s.call('bob', 'GET', s.raid(id))).json.raid.raidOn });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  s.w.sources.events.set('333333333333333333', rhEvent('333333333333333333', SERVER_A, [signUp(1, DID(7), 'Wanderfell', 'Druid', 'Feral')]));
  s.w.sources.reports.set(R2, wclReport({ startTime: RH_START * 1000 + 3600_000, actors: [[1, 'Fenwick', 'Warrior']], fights: [[1, 'Gruul', 650, true, 0, 100, [1]]] }));
  assert.equal((await s.call('bob', 'PUT', s.raid(b.json.raid.id, '/event'), { source: '333333333333333333' })).status, 200);
  const done = await s.call('bob', 'PUT', s.raid(b.json.raid.id, '/reports'), { source: R2 });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const home = byName(done.json).Wanderfell;
  assert.deepEqual([home.outcome, home.credit, home.flags, home.via], ['fill_in', 1, [], id]);
  const host = byName((await s.call('bob', 'GET', s.raid(id))).json).Wanderfell;
  assert.deepEqual([host.outcome, host.credit], ['fill_in', null]);
  const counted = await s.w.rows("SELECT raid_id, credit FROM attendance WHERE player_id = ? AND credit = 1", s.p.wander);
  assert.deepEqual(counted.map((r) => r.raid_id), [b.json.raid.id], 'exactly one counted cell');
  // Deleting the home raid recalculates the remaining raids of that date (finding 3): the host raid is fresh and counts again.
  assert.equal((await s.call('bob', 'DELETE', s.raid(b.json.raid.id), {})).status, 200);
  const list = await s.call('bob', 'GET', `/raids?team=${s.A}`);
  assert.equal(list.json.raids[0].stale, false);
  assert.equal(byName((await s.call('bob', 'GET', s.raid(id))).json).Wanderfell.credit, 1);
});

// ---------------------------------------------------------------------------
// Decisions, the review queue, unmatched characters, stale raids

const decide = (s, who, raidId, body) => s.call(who, 'POST', s.raid(raidId, '/decisions'), body);

check('decisions: allowed outcomes per flag, credit ids come from the policy, a reason of 3 to 200 characters, flags_changed, undo; each is audited', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  const rows = byName(detail);
  const brindle = rows.Brindle.playerId;
  const cassia = rows.Cassia.playerId;
  const base = { playerId: brindle, outcome: 'bench', reason: 'Told us on Discord', expectedFlags: ['no_show'] };
  assert.equal((await decide(s, 'bob', id, { ...base, reason: 'no' })).status, 400);
  assert.equal((await decide(s, 'bob', id, { ...base, reason: 'x'.repeat(201) })).status, 400);
  assert.equal((await decide(s, 'bob', id, { ...base, outcome: 'late' })).json.error, 'decision_invalid');
  assert.equal((await decide(s, 'bob', id, { ...base, creditId: 'half' })).json.error, 'decision_invalid', 'bench has a fixed credit');
  const stale = await decide(s, 'bob', id, { ...base, expectedFlags: [] });
  assert.deepEqual([stale.status, stale.json.error, stale.json.flags], [409, 'flags_changed', ['no_show']]);
  const ok = await decide(s, 'bob', id, base);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = byName(ok.json).Brindle;
  assert.deepEqual([row.outcome, row.credit, row.needsReview, row.decision.reason, row.decision.applied], ['bench', 1, false, 'Told us on Discord', true]);
  assert.equal(ok.json.raid.openFlags, 3);
  // A late row: the same outcome with a credit id from the policy, or present; nothing else.
  const late = { playerId: cassia, reason: 'Stuck in a queue', expectedFlags: ['late'] };
  assert.equal((await decide(s, 'bob', id, { ...late, outcome: 'late' })).json.error, 'decision_invalid', 'a credit id is required');
  assert.equal((await decide(s, 'bob', id, { ...late, outcome: 'late', creditId: 'nope' })).json.error, 'decision_invalid');
  assert.equal((await decide(s, 'bob', id, { ...late, outcome: 'missed' })).json.error, 'decision_invalid');
  const half = await decide(s, 'bob', id, { ...late, outcome: 'late', creditId: 'half' });
  assert.deepEqual([byName(half.json).Cassia.outcome, byName(half.json).Cassia.credit], ['late', 0.5]);
  // Decisions survive a recompute; undo reopens the row.
  assert.equal(byName((await s.call('bob', 'POST', s.raid(id, '/recompute'), {})).json).Brindle.outcome, 'bench');
  const undo = await s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Mistake' });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.deepEqual([byName(undo.json).Brindle.outcome, byName(undo.json).Brindle.needsReview, byName(undo.json).Brindle.decision], ['missed', true, null]);
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Again' })).status, 404);
  const audit = await s.w.rows("SELECT action FROM audit_log WHERE action LIKE 'attendance.%' ORDER BY created_at, rowid");
  assert.deepEqual(audit.map((a) => a.action), ['attendance.decide', 'attendance.decide', 'attendance.undo']);
});

check('recompute: an event refresh keeps decisions; a change in the flags reopens the row (the old decision stays visible); open_flags and policy_fp are kept', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  const { playerId: cassia } = byName(detail).Cassia;
  const { playerId: brindle } = byName(detail).Brindle;
  assert.equal((await decide(s, 'bob', id, { playerId: cassia, outcome: 'present', reason: 'Was there', expectedFlags: ['late'] })).status, 200);
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] })).status, 200);
  // The same event again: nothing changes.
  const again = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: EVENT_ID });
  assert.equal(again.status, 200);
  assert.deepEqual([byName(again.json).Cassia.outcome, byName(again.json).Brindle.outcome], ['present', 'bench']);
  // Brindle's sign-up goes: she is a "No sign-up" cell and the flag the decision answered is gone.
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, eventSignUps().filter((x) => x.id !== 2)));
  const changed = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: EVENT_ID });
  const b = byName(changed.json).Brindle;
  assert.deepEqual([b.outcome, b.decision.applied, b.decision.reason], ['no_signup', false, 'Told us']);
  assert.equal(byName(changed.json).Cassia.outcome, 'present');
  const raid = (await s.w.rows('SELECT open_flags, policy_fp, computed_at FROM raids WHERE id = ?', id))[0];
  assert.equal(raid.open_flags, 2, 'Eliora left early and Zorgax is unmatched');
  assert.match(raid.policy_fp, /^[0-9a-f]{8}$/);
  assert(raid.computed_at > 0);
  // Deleting the event takes the sign-ups away.
  const noEvent = await s.call('bob', 'DELETE', s.raid(id, '/event'), {});
  assert.equal(noEvent.json.sources.event, null);
  assert.equal(await s.w.count('raid_signups'), 0);
});

check('unmatched: link as an Alt (new character on the raid\'s team, other raids with that name marked stale), or mark a guest; both audited', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  // A second raid (team B, another night) whose log also holds Zorgax.
  s.w.sources.reports.set(R2, wclReport({ startTime: Date.parse('2027-01-09T01:00:00Z'), actors: ACTORS_1, fights: [[1, 'Gruul', 650, true, 0, 100, [6, 7]]] }));
  const other = await s.call('bob', 'POST', '/raids', { teamId: s.B, reportSource: R2 });
  assert.equal(other.status, 201);
  assert.deepEqual(other.json.unmatched.map((u) => u.name), ['Zorgax']);
  const key = 'zorgax|nightslayer';
  const alt = (who, body) => s.call(who, 'POST', s.raid(id, '/unmatched'), body);
  assert.equal((await alt('carol', { key: 'nobody|nightslayer', action: 'guest' })).status, 404);
  assert.equal((await alt('erin', { key, action: 'guest' })).status, 403);
  assert.equal((await alt('dave', { key, action: 'guest' })).status, 403, 'a Team Lead of another team');
  assert.equal((await alt('carol', { key, action: 'alt', personId: s.p.wander })).status, 403, 'the person\'s home team needs roster.edit too');
  assert.equal((await alt('carol', { key, action: 'alt', personId: 'p_nope' })).status, 400);
  const linked = await alt('carol', { key, action: 'alt', personId: s.p.fenwick });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.equal(linked.json.staleRaids, 1);
  assert.deepEqual(linked.json.unmatched ?? linked.json.raid.unmatched, []);
  assert.equal(byName(linked.json.raid).Fenwick.outcome, 'present', 'Fenwick now has a character in the log');
  assert.equal(linked.json.raid.raid.openFlags, 3);
  assert.equal(linked.json.attendanceFlags[s.A], 1);
  const character = (await s.w.rows("SELECT team_id, class, is_main, player_id FROM characters WHERE name = 'Zorgax'"))[0];
  assert.deepEqual([character.team_id, character.class, character.is_main, character.player_id], [s.A, 'ROGUE', 0, s.p.fenwick]);
  assert.equal((await s.call('bob', 'GET', `/raids?team=${s.B}`)).json.raids[0].stale, true);
  assert.equal((await s.call('bob', 'POST', s.raid(other.json.raid.id, '/recompute'), {})).json.raid.stale, false);
  // A guest: ignored entirely.
  const third = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-02' });
  s.w.sources.reports.set(R3, wclReport({ startTime: Date.parse('2027-01-02T20:00:00Z'), actors: [[1, 'Aldric', 'Warrior'], [2, 'Visitor', 'Mage']], fights: [[1, 'Gruul', 650, true, 0, 100, [1, 2]]] }));
  const withLog = await s.call('bob', 'PUT', s.raid(third.json.raid.id, '/reports'), { source: R3 });
  assert.deepEqual(withLog.json.unmatched.map((u) => u.name), ['Visitor']);
  const guest = await s.call('bob', 'POST', s.raid(third.json.raid.id, '/unmatched'), { key: 'visitor|nightslayer', action: 'guest' });
  assert.equal(guest.status, 200, JSON.stringify(guest.json));
  assert.deepEqual(guest.json.raid.unmatched, []);
  assert.equal(await s.w.count('attendance_guests'), 1);
  assert.equal(await s.w.count('audit_log', "action IN ('attendance.link', 'attendance.guest', 'character.create') AND entity_type IN ('raid', 'character')"), 3);
});

check('unmatched: add as a new person (Main on the raid\'s team, status and joined date, name conflict) and link as the Main', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const key = 'zorgax|nightslayer';
  const call = (who, body) => s.call(who, 'POST', s.raid(id, '/unmatched'), body);
  assert.equal((await call('carol', { key, action: 'bogus' })).json.message, 'Pick alt, person or guest.');
  assert.equal((await call('carol', { key, action: 'person', status: 'inactive' })).status, 400, 'inactive is not a starting status');
  assert.equal((await call('carol', { key, action: 'person', joinedOn: '2027-13-40' })).status, 400);
  assert.equal((await call('erin', { key, action: 'person' })).status, 403);
  // alt + makeMain: a non-boolean is refused, true swaps the Main.
  const refused = await call('carol', { key, action: 'alt', personId: s.p.fenwick, makeMain: 'yes' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.field, 'makeMain');
  const swapped = await call('carol', { key, action: 'alt', personId: s.p.fenwick, makeMain: true });
  assert.equal(swapped.status, 200, JSON.stringify(swapped.json));
  const mains = await s.w.rows(`SELECT name, is_main FROM characters WHERE player_id = '${s.p.fenwick}' ORDER BY name`);
  assert.deepEqual(mains.map((m) => [m.name, m.is_main]), [['Fenwick', 0], ['Zorgax', 1]]);
  assert.equal(await s.w.count('audit_log', "action = 'character.main'"), 1);
  // A new person: defaults are Raider and the raid's date.
  const third = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-02' });
  s.w.sources.reports.set(R3, wclReport({
    startTime: Date.parse('2027-01-02T20:00:00Z'),
    actors: [[1, 'Aldric', 'Warrior'], [2, 'Visitor', 'Mage'], [3, 'Nomad', 'Hunter'], [4, 'Drifter', 'Rogue']],
    fights: [[1, 'Gruul', 650, true, 0, 100, [1, 2, 3, 4]]],
  }));
  const withLog = await s.call('bob', 'PUT', s.raid(third.json.raid.id, '/reports'), { source: R3 });
  assert.deepEqual(withLog.json.unmatched.map((u) => u.name).sort(), ['Drifter', 'Nomad', 'Visitor']);
  const tid = third.json.raid.id;
  const post = (who, body) => s.call(who, 'POST', s.raid(tid, '/unmatched'), body);
  const plain = await post('bob', { key: 'visitor|nightslayer', action: 'person' });
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  assert.equal(plain.json.raid.unmatched.map((u) => u.name).includes('Visitor'), false);
  const visitor = (await s.w.rows("SELECT p.status, p.joined_on, p.trial_start, p.trial_end, c.team_id, c.class, c.is_main, c.main_spec, c.off_spec FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name = 'Visitor'"))[0];
  assert.deepEqual([visitor.status, visitor.joined_on, visitor.trial_start, visitor.trial_end, visitor.team_id, visitor.class, visitor.is_main, visitor.main_spec, visitor.off_spec],
    ['raider', '2027-01-02', null, null, s.A, 'MAGE', 1, null, null]);
  const trial = await post('bob', { key: 'nomad|nightslayer', action: 'person', status: 'trial', joinedOn: '2026-12-20' });
  assert.equal(trial.status, 200, JSON.stringify(trial.json));
  const nomad = (await s.w.rows("SELECT p.status, p.joined_on, p.trial_start, p.trial_end FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name = 'Nomad'"))[0];
  assert.deepEqual([nomad.status, nomad.joined_on, nomad.trial_start, nomad.trial_end], ['trial', '2026-12-20', '2026-12-20', null]);
  assert.equal(await s.w.count('audit_log', "action = 'person.create' AND entity_type = 'person' AND after LIKE '%attendance%'"), 2);
  // The name was taken after the log was read: 409 name_taken, nothing written.
  await addPerson(s, 'bob', s.B, 'Drifter');
  const people = await s.w.count('players');
  const taken = await post('bob', { key: 'drifter|nightslayer', action: 'person' });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'name_taken');
  assert.equal(await s.w.count('players'), people);
});

check('review queue: flagged rows and unmatched names per raid, stale raids listed; only reviewers of that team may read it', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const q = await s.call('carol', 'GET', `/attendance/review?team=${s.A}`);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.equal(q.json.raids.length, 1);
  assert.equal(q.json.raids[0].raid.id, id);
  const kinds = q.json.raids[0].items.map((i) => (i.kind === 'person' ? `${i.name}:${i.flags.join('+')}` : `${i.kind}:${i.name}`));
  assert.deepEqual(kinds, ['Brindle:no_show', 'Cassia:late', 'Eliora:left_early', 'unmatched:Zorgax']);
  assert.deepEqual(q.json.stale, []);
  assert.equal((await s.call('dave', 'GET', `/attendance/review?team=${s.A}`)).status, 403);
  assert.equal((await s.call('erin', 'GET', `/attendance/review?team=${s.A}`)).status, 403);
  assert.equal((await s.call('bob', 'GET', '/attendance/review?team=t_nope')).status, 400);
  await s.call('bob', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 });
  assert.deepEqual((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.stale, [id], 'a policy that changes the rules makes the raid stale');
});

check('stale marking: a character created or renamed under a logged name marks the raid (character create, rename, person delete)', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const stale = async () => (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.raids[0].stale;
  assert.equal(await stale(), false);
  await addPerson(s, 'bob', s.A, 'Zorgax');
  assert.equal(await stale(), true);
  const done = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.equal(done.json.raid.stale, false);
  assert.equal(byName(done.json).Zorgax.outcome, 'present', 'the new person is in the log now');
  assert.equal(done.json.unmatched.length, 0);
  const aldric = (await s.call('bob', 'GET', `/roster/${s.p.aldric}`)).json.characters[0];
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.aldric}/characters/${aldric.id}`, { name: 'Aldrix' })).status, 200);
  assert.equal(await stale(), true, 'a rename marks the raids that logged the old name');
});

// ---------------------------------------------------------------------------
// Permissions, cross-guild denial, policy and Warcraft Logs settings

check('permissions matrix: every route x role (Guild Master, Officer, Team Lead own / other team, Member, signed out)', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const { id } = await fullRaid(s, 'alice');
  const brindle = (await s.call('alice', 'GET', s.raid(id))).json.people.find((p) => p.name === 'Brindle').playerId;
  const anon = {};
  const as = (name) => (name === 'anon' ? anon : s.jars[name]);
  const status = async (name, method, route, body) => (await s.w.call(as(name), method, `${s.guildPath}${route}`, body)).status;
  // [label, method, route, body, who is allowed]
  const ALL = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const table = [
    ['list raids', 'GET', `/raids?team=${s.A}`, undefined, ALL],
    ['raid detail', 'GET', s.raid(id), undefined, ALL],
    ['policy (read)', 'GET', '/attendance/policy', undefined, ALL],
    ['create a raid on team A', 'POST', '/raids', () => ({ teamId: s.A, raidOn: `2027-01-0${++seq}` }), ['alice', 'bob', 'carol']],
    ['put a plan', 'PUT', s.raid(id, '/plan'), { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] }, ['alice', 'bob', 'carol']],
    ['recompute', 'POST', s.raid(id, '/recompute'), {}, ['alice', 'bob', 'carol']],
    ['decide', 'POST', s.raid(id, '/decisions'), { playerId: brindle, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] }, ['alice', 'bob', 'carol']],
    ['put policy', 'PUT', '/attendance/policy', { teamId: null, policy: {}, expectedVersion: 0 }, ['alice', 'bob']],
    ['put wcl settings', 'PUT', '/attendance/wcl', { wclGuildId: 99 }, ['alice', 'bob']],
    ['review queue', 'GET', `/attendance/review?team=${s.A}`, undefined, ['alice', 'bob', 'carol']],
    ['team attendance', 'GET', `/attendance/team?team=${s.A}`, undefined, ['alice', 'bob', 'carol']],
    ['backfill list', 'GET', `/attendance/backfill/reports?team=${s.A}`, undefined, ['alice', 'bob', 'carol']],
    ['delete the raid', 'DELETE', s.raid(id), {}, ['alice', 'bob', 'carol']],
  ];
  let seq = 0;
  s.w.sources.listing = () => ({ data: [], has_more_pages: false });
  for (const [label, method, route, body, allowed] of table) {
    if (label === 'delete the raid') continue; // last: it removes the raid
    for (const who of [...ALL, 'anon']) {
      const payload = typeof body === 'function' ? body() : body;
      const got = await status(who, method, route, payload);
      if (who === 'anon') assert.equal(got, 401, `${label}: signed out`);
      else if (allowed.includes(who)) assert(got >= 200 && got < 300 || got === 409, `${label}: ${who} should pass, got ${got}`);
      else assert.equal(got, 403, `${label}: ${who} should be refused, got ${got}`);
    }
  }
  assert.equal(await status('dave', 'DELETE', s.raid(id), {}), 403);
  assert.equal(await status('erin', 'DELETE', s.raid(id), {}), 403);
  assert.equal(await status('carol', 'DELETE', s.raid(id), {}), 200);
});

check('redaction: the raid detail hides people, sign-ups and nicknames from those who may not see them; reasons only for reviewers', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const { id, detail } = await fullRaid(s);
  const brindle = byName(detail).Brindle.playerId;
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Private reason', expectedFlags: ['no_show'] })).status, 200);
  const view = async (who) => (await s.call(who, 'GET', s.raid(id))).json;
  const dave = await view('dave');
  assert.deepEqual([dave.people, dave.unmatched, dave.signups], [null, [], []]);
  assert.deepEqual(dave.can, { edit: false, review: false, seeAttendance: false, seeNicknames: false });
  assert.equal(dave.sources.event.signups, 6, 'the header and the sources are visible to any member');
  const bob = await view('bob');
  assert(bob.signups.some((x) => x.nickname === 'Aldric'));
  assert.equal(byName(bob).Brindle.decision.reason, 'Private reason');
  assert(!JSON.stringify(bob).includes('discord_user_id') && !JSON.stringify(bob).includes(DID(1)), 'a Discord ID is never sent');
  // A Member with a character on team A may read the attendance, but sees no nicknames and no reasons.
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.fenwick}'`);
  const erin = await view('erin');
  assert.equal(erin.can.seeAttendance, true);
  assert.equal(erin.signups.length, 6);
  assert(erin.signups.every((x) => x.nickname === null));
  assert.deepEqual(byName(erin).Brindle.decision, { at: byName(erin).Brindle.decision.at, applied: true });
  assert.equal(erin.can.review, false);
  // Her own team only: team B's attendance is closed to her.
  assert.equal((await s.call('erin', 'GET', `/attendance/team?team=${s.A}`)).status, 200);
  assert.equal((await s.call('erin', 'GET', `/attendance/team?team=${s.B}`)).status, 403);
  const wanderer = await s.call('erin', 'GET', `/attendance/person/${s.p.wander}`);
  assert.deepEqual(wanderer.json.teams.map((t) => t.team.id), [s.A], 'team B is omitted; the Other-team cell on team A is hers to see');
  const own = await s.call('erin', 'GET', `/attendance/person/${s.p.brindle}`);
  assert.equal(own.status, 200);
  assert.equal(own.json.teams[0].cells.every((c) => c.reason === null), true);
  assert.equal((await s.call('bob', 'GET', `/attendance/person/${s.p.brindle}`)).json.teams[0].cells.some((c) => c.reason === 'Private reason'), true);
});

check('cross-guild denial: another guild\'s raid, team and policy are 404 / 400 / 403, never data', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const other = await secondGuild(s);
  // Frank (Guild Master of guild B) on guild A's path: not a member of its Discord server.
  const onA = await s.w.call(other.frank, 'GET', `${s.guildPath}/raids/${id}`);
  assert.deepEqual([onA.status, onA.json.error], [403, 'not_member']);
  assert.equal((await s.w.call(other.frank, 'GET', `${s.guildPath}/raids?team=${s.A}`)).status, 403);
  // A raid of guild A on guild B's path is not there.
  const miss = await s.w.call(other.frank, 'GET', `${other.path}/raids/${id}`);
  assert.deepEqual([miss.status, miss.json.error], [404, 'not_found']);
  for (const [method, route, body] of [
    ['PUT', `/raids/${id}/plan`, { label: 'x', players: [{ name: 'Aldric', group: 1 }] }], ['POST', `/raids/${id}/recompute`, {}], ['DELETE', `/raids/${id}`, {}],
    ['PUT', `/raids/${id}/reports`, { source: R1 }], ['DELETE', `/raids/${id}/event`, {}], ['POST', `/raids/${id}/unmatched`, { key: 'a|b', action: 'guest' }],
    ['DELETE', `/raids/${id}/decisions/${s.p.brindle}`, { reason: 'abc' }],
  ]) {
    const r = await s.w.call(other.frank, method, `${other.path}${route}`, body);
    assert.equal(r.status, 404, `${method} ${route}`);
  }
  assert.equal((await s.w.call(other.frank, 'GET', `${other.path}/attendance/person/${s.p.aldric}`)).status, 404);
  // Guild A's team on guild B's raid list is a 400; guild B's team in guild A's create is a 400 too.
  assert.equal((await s.w.call(other.frank, 'GET', `${other.path}/raids?team=${s.A}`)).status, 400);
  assert.equal((await s.call('alice', 'POST', '/raids', { teamId: other.teamId, raidOn: '2027-01-02' })).json.field, 'teamId');
  assert.equal((await s.w.call(other.frank, 'PUT', `${other.path}/attendance/policy`, { teamId: s.A, policy: {}, expectedVersion: 0 })).status, 400);
  assert.equal((await s.w.call(other.frank, 'PUT', `${other.path}/attendance/wcl`, { uploaders: { [s.A]: ['abc'] } })).status, 400);
  assert.equal(await s.w.count('raids'), 1);
});

check('policy: Members read it, only Guild Master and Officer write it; validation by path, version conflicts carry `current`, a team override resolves, resetDay is guild-only', async () => {
  const s = await raidWorld();
  const view = await s.call('erin', 'GET', '/attendance/policy');
  assert.equal(view.status, 200);
  assert.deepEqual(Object.keys(view.json).sort(), ['defaults', 'guild', 'resetDayDerived', 'resolved', 'teams', 'versions', 'wcl']);
  assert.equal(view.json.resetDayDerived, 2, 'US: Tuesday');
  assert.deepEqual(Object.keys(view.json.resolved).sort(), [...s.teams].sort());
  assert.deepEqual(view.json.versions, { guild: 0, teams: {} });
  const put = (who, body) => s.call(who, 'PUT', '/attendance/policy', body);
  assert.equal((await put('carol', { teamId: null, policy: {}, expectedVersion: 0 })).status, 403);
  const bad1 = await put('bob', { teamId: null, policy: { wat: 1 }, expectedVersion: 0 });
  assert.deepEqual([bad1.status, bad1.json.error, bad1.json.field], [400, 'policy_invalid', 'wat']);
  assert.equal((await put('bob', { teamId: null, policy: { detection: { mode: 'kills' } }, expectedVersion: 0 })).json.field, 'detection.mode');
  assert.equal((await put('bob', { teamId: s.A, policy: { resetDay: 3 }, expectedVersion: 0 })).json.field, 'resetDay');
  assert.equal((await put('bob', { teamId: null, policy: { window: { defaultWeeks: 10 } }, expectedVersion: 0 })).json.field, 'window.defaultWeeks');
  assert.equal((await put('bob', { teamId: null, policy: 'no', expectedVersion: 0 })).json.error, 'policy_invalid');
  assert.equal((await put('bob', { teamId: 't_nope', policy: {}, expectedVersion: 0 })).status, 400);
  assert.equal((await put('bob', { teamId: null, policy: {} })).json.field, 'expectedVersion');
  const saved = await put('bob', { teamId: null, policy: { tentative: 'asSignedUp', resetDay: 3 }, expectedVersion: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual([saved.json.versions.guild, saved.json.guild.tentative, saved.json.resolved[s.A].tentative, saved.json.resolved[s.A].resetDay], [1, 'asSignedUp', 'asSignedUp', 3]);
  const conflict = await put('bob', { teamId: null, policy: { tentative: 'asNoSignup' }, expectedVersion: 0 });
  assert.deepEqual([conflict.status, conflict.json.error, conflict.json.current.versions.guild], [409, 'conflict', 1]);
  const team = await put('alice', { teamId: s.B, policy: { fillIn: 'recordOnly' }, expectedVersion: 0 });
  assert.equal(team.status, 200);
  assert.deepEqual([team.json.resolved[s.B].fillIn, team.json.resolved[s.A].fillIn, team.json.resolved[s.B].tentative, team.json.versions.teams[s.B]], ['recordOnly', 'always', 'asSignedUp', 1]);
  const again = await put('alice', { teamId: s.B, policy: { fillIn: 'always' }, expectedVersion: 1 });
  assert.equal(again.json.versions.teams[s.B], 2);
  const audits = await s.w.rows("SELECT before, after, actor_user_id FROM audit_log WHERE action = 'policy.update' ORDER BY created_at, rowid");
  assert.equal(audits.length, 3);
  assert.equal(JSON.parse(audits[0].after).values.tentative, 'asSignedUp');
});

check('wcl settings: guild id and per-team uploaders (2 to 24 characters, at most 10, own teams only), Guild Master and Officer only, audited', async () => {
  const s = await raidWorld();
  const put = (who, body) => s.call(who, 'PUT', '/attendance/wcl', body);
  assert.equal((await put('carol', { wclGuildId: 5 })).status, 403);
  assert.equal((await put('bob', { wclGuildId: 0 })).status, 400);
  assert.equal((await put('bob', { wclGuildId: 1.5 })).status, 400);
  assert.equal((await put('bob', {})).status, 400);
  assert.equal((await put('bob', { uploaders: { [s.A]: ['x'] } })).status, 400);
  assert.equal((await put('bob', { uploaders: { [s.A]: Array.from({ length: 11 }, (_, i) => `Uploader${i}`) } })).status, 400);
  assert.equal((await put('bob', { uploaders: { t_nope: ['abc'] } })).status, 400);
  const ok = await put('bob', { wclGuildId: 424242, uploaders: { [s.A]: ['Upl', 'upl', 'Second'], [s.B]: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.wcl.guildId, ok.json.wcl.uploaders[s.A], ok.json.wcl.uploaders[s.B]], [424242, ['Upl', 'Second'], []]);
  assert.equal((await s.call('erin', 'GET', '/attendance/policy')).json.wcl.guildId, 424242);
  assert.equal((await put('bob', { wclGuildId: null })).json.wcl.guildId, null);
  assert.equal(await s.w.count('audit_log', "action = 'wcl.settings'"), 2);
});

// ---------------------------------------------------------------------------
// Team and person pages

check('team page: windows (default, a switch value, all, a bad value), weeks, metrics per person, borrowed Other-team cells, awaiting review, stale count', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const { id } = await fullRaid(s);
  const team = await s.call('carol', 'GET', `/attendance/team?team=${s.A}`);
  assert.equal(team.status, 200, JSON.stringify(team.json));
  const t = team.json;
  assert.deepEqual([t.window, t.policy.switchWeeks, t.policy.defaultWeeks, t.policy.streakFlagAt], [8, [8, 12], 8, 4]);
  assert.deepEqual(t.policy.creditValues.map((c) => c.id), ['full', 'half', 'none']);
  assert.equal(t.weeks.length, 1);
  assert.deepEqual(t.weeks[0].raids.map((r) => r.id), [id]);
  assert.deepEqual([t.awaitingReview, t.staleRaids], [1, 0]);
  const people = Object.fromEntries(t.people.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(people).sort(), ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Wanderfell']);
  assert.equal(people.Aldric.pct, 100);
  assert.equal(people.Brindle.pct, 0);
  assert.equal(people.Cassia.pct, null, 'a pending Late cell is not counted');
  assert.equal(people.Cassia.pending, 1);
  assert.equal(people.Aldric.cells.length, 1);
  assert.deepEqual([people.Aldric.cells[0].letter, people.Brindle.cells[0].letter, people.Cassia.cells[0].letter], ['P', 'M', 'L?']);
  assert.equal(people.Aldric.isMe, false);
  assert.equal((await s.call('carol', 'GET', `/attendance/team?team=${s.A}&window=12`)).json.window, 12);
  assert.equal((await s.call('carol', 'GET', `/attendance/team?team=${s.A}&window=all`)).json.window, 'all');
  assert.equal((await s.call('carol', 'GET', `/attendance/team?team=${s.A}&window=5`)).json.field, 'window');
  assert.equal((await s.call('carol', 'GET', `/attendance/team?team=${s.A}&window=abc`)).status, 400);
  // An old raid (Aldric planned, not there) is outside the 8 and 12 week windows and inside "all".
  exec(s.w, `UPDATE players SET joined_on = '2026-08-01' WHERE id = '${s.p.aldric}'`);
  assert.equal((await s.call('bob', 'PUT', '/attendance/policy', { teamId: null, policy: { effectiveStart: 'joinDate' }, expectedVersion: 0 })).status, 200);
  const old = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2026-09-01' })).json.raid.id;
  await s.call('bob', 'PUT', s.raid(old, '/plan'), { label: 'Old', players: [{ name: 'Aldric', group: 1 }] });
  assert.equal((await s.call('bob', 'PUT', s.raid(old, '/manual'), { reason: 'Logger was off', presentPlayerIds: [] })).status, 200);
  const pctOf = async (query) => (await s.call('carol', 'GET', `/attendance/team?team=${s.A}${query}`)).json;
  for (const query of ['', '&window=12']) {
    const w = await pctOf(query);
    assert.deepEqual([w.weeks.length, w.people.find((p) => p.name === 'Aldric').pct], [1, 100], query);
  }
  const all = await pctOf('&window=all');
  assert.deepEqual([all.weeks.length, all.people.find((p) => p.name === 'Aldric').pct, all.people.find((p) => p.name === 'Aldric').pctAll], [2, 50, 50]);
  // Team B: Wanderfell's Other-team cell on team A's raid is a counted cell for his home team.
  const b = await s.call('bob', 'GET', `/attendance/team?team=${s.B}&window=all`);
  const wander = b.json.people.find((p) => p.name === 'Wanderfell');
  assert.deepEqual([wander.pct, wander.cells.map((c) => [c.outcome, c.credit])], [100, [['fill_in', 1]]]);
});

check('person history: per visible team a block of metrics and cells newest first; an unknown or other-guild person is a 404', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const { id, detail } = await fullRaid(s);
  const cassia = byName(detail).Cassia.playerId;
  assert.equal((await decide(s, 'bob', id, { playerId: cassia, outcome: 'late', creditId: 'half', reason: 'Ten minutes late', expectedFlags: ['late'] })).status, 200);
  const r = await s.call('bob', 'GET', `/attendance/person/${cassia}?window=all`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.person.name, r.json.person.class, r.json.teams.length, r.json.teams[0].team.id], ['Cassia', 'WARRIOR', 1, s.A]);
  assert.equal(r.json.teams[0].metrics.pct, 50);
  assert.deepEqual(r.json.teams[0].cells.map((c) => [c.outcome, c.credit, c.reason, c.via]), [['late', 0.5, 'Ten minutes late', null]]);
  const wander = await s.call('bob', 'GET', `/attendance/person/${s.p.wander}?window=all`);
  assert.deepEqual(wander.json.teams.map((t) => t.team.id).sort(), [s.A, s.B].sort(), 'his home team B and team A, where the Other-team cell sits');
  assert.equal((await s.call('bob', 'GET', '/attendance/person/p_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await s.call('bob', 'GET', '/attendance/person/nope')).status, 404);
});

// ---------------------------------------------------------------------------
// Backfill

check('backfill list: pages of WCL reports with the raid date, alreadyAdded, the uploader filter; falls back to the guild name; wcl_guild_unknown without either', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const pages = [
    { data: [{ code: R1, title: 'Gruul', startTime: RH_START * 1000, endTime: RH_START * 1000 + 1000, zone: { name: 'Gruul' }, owner: { name: 'Upl' } },
      { code: R2, title: 'Kara', startTime: Date.parse('2027-02-10T02:21:00Z'), endTime: null, zone: null, owner: { name: 'Else' } }], has_more_pages: true },
    { data: [{ code: R3, title: 'ZA', startTime: Date.parse('2027-01-01T20:00:00Z'), endTime: null, zone: { name: 'ZA' }, owner: null }], has_more_pages: false },
  ];
  s.w.sources.listing = (variables) => pages[variables.page - 1];
  const get = (who, query) => s.call(who, 'GET', `/attendance/backfill/reports?team=${s.A}${query}`);
  let r = await get('bob', '&page=1');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.reports.map((x) => [x.code, x.alreadyAdded, x.matchesUploader, x.raidOn, x.flavour]), [[R1, id, true, '2027-01-16', 'fresh'], [R2, null, true, '2027-02-09', 'fresh']]);
  assert.equal(r.json.hasMore, true);
  const q = s.w.sources.queries.filter((x) => /reports\s*\(/.test(x.query)).pop();
  assert.deepEqual(q.variables, { guildName: 'Ember', guildServerSlug: 'nightslayer', guildServerRegion: 'US', page: 1 });
  assert.equal((await get('bob', '&page=2')).json.hasMore, false);
  assert.equal((await get('bob', '&page=0')).status, 400);
  // The guild id is used when it is known; the team's uploaders filter the list.
  assert.equal((await s.call('bob', 'PUT', '/attendance/wcl', { wclGuildId: 777, uploaders: { [s.A]: ['upl'] } })).status, 200);
  r = await get('bob', '');
  assert.deepEqual(r.json.reports.map((x) => x.matchesUploader), [true, false]);
  assert.deepEqual(s.w.sources.queries.filter((x) => /reports\s*\(/.test(x.query)).pop().variables, { guildID: 777, page: 1 });
  assert.equal((await get('carol', '')).status, 200);
  assert.equal((await get('dave', '')).status, 403);
  assert.equal((await get('erin', '')).status, 403);
  // Neither an id nor a known realm slug.
  assert.equal((await s.call('bob', 'PUT', '/attendance/wcl', { wclGuildId: null })).status, 200);
  exec(s.w, 'UPDATE guilds SET realm_slug = NULL');
  const unknown = await get('bob', '');
  assert.deepEqual([unknown.status, unknown.json.error], [409, 'wcl_guild_unknown']);
});

// ---------------------------------------------------------------------------
// Manual attendance ("No log") and the plan

check('manual raid: ticks become Present (officer), the rest follow the sign-ups; an Other-team tick; reasons, permissions, raid_has_log / raid_is_manual, remove, audit', async () => {
  const s = await raidWorld();
  const created = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  const id = created.json.raid.id;
  const put = (who, body) => s.call(who, 'PUT', s.raid(id, '/manual'), body);
  const ticks = [s.p.aldric, s.p.cassia, s.p.wander];
  assert.equal((await put('bob', { reason: 'no', presentPlayerIds: ticks })).status, 400);
  assert.equal((await put('bob', { reason: 'Logger was off', presentPlayerIds: ['nope'] })).status, 400);
  assert.equal((await put('bob', { reason: 'Logger was off', presentPlayerIds: [s.p.aldric, s.p.aldric] })).status, 400);
  assert.equal((await put('bob', { reason: 'Logger was off', presentPlayerIds: ['p_AAAAAAAAAAAAAAAAAAAAAA'] })).status, 400);
  assert.equal((await put('dave', { reason: 'Logger was off', presentPlayerIds: ticks })).status, 403);
  assert.equal((await put('erin', { reason: 'Logger was off', presentPlayerIds: ticks })).status, 403);
  const ok = await put('carol', { reason: 'Logger was off', presentPlayerIds: ticks });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(outcomes(ok.json), {
    Aldric: 'present', Brindle: 'missed', Cassia: 'present', Dunmar: 'missed_notice', Eliora: 'bench', Fenwick: 'no_signup', Wanderfell: 'fill_in',
  });
  assert.deepEqual([ok.json.raid.state, ok.json.raid.openFlags, ok.json.raid.manual.reason], ['to_review', 1, 'Logger was off']);
  assert.equal(byName(ok.json).Wanderfell.credit, 1);
  assert.deepEqual((await s.w.rows('SELECT DISTINCT presence_source FROM attendance')).map((r) => r.presence_source), ['officer']);
  assert.equal(byName(ok.json).Aldric.pulls.total, 0);
  // Brindle signed up and was not ticked: decide, and the raid counts as done.
  const decided = await decide(s, 'bob', id, { playerId: s.p.brindle, outcome: 'missed', reason: 'Really absent', expectedFlags: ['no_show'] });
  assert.deepEqual([decided.json.raid.state, decided.json.raid.openFlags], ['manual', 0]);
  // A report cannot be added to a manual raid; a manual list cannot be added to a raid with a report.
  const blocked = await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R1 });
  assert.deepEqual([blocked.status, blocked.json.error], [409, 'raid_is_manual']);
  const removed = await s.call('bob', 'DELETE', s.raid(id, '/manual'), { reason: 'Found the log' });
  assert.deepEqual([removed.status, removed.json.raid.state, removed.json.people], [200, 'awaiting_log', []]);
  assert.equal(await s.w.count('raid_manual'), 0);
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, '/manual'), { reason: 'Again' })).status, 409);
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R1 })).status, 200);
  const has = await put('bob', { reason: 'Logger was off', presentPlayerIds: [] });
  assert.deepEqual([has.status, has.json.error], [409, 'raid_has_log']);
  assert.equal(await s.w.count('audit_log', "action = 'raid.manual'"), 2);
});

check('plan: group 1-8 is a sign-up, group 0 a bench, an unmatched name is listed but not flagged, rows are re-derived, source never changes the outcome', async () => {
  const s = await raidWorld();
  // Same attendance twice: sign-ups from the plan on one raid, from Raid-Helper on the other (manual ticks, the same people).
  const plan = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-03' });
  const event = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-16' }); // the event's own guild-local day (RH_START): another day would ask to move the raid
  s.w.sources.events.set('444444444444444444', rhEvent('444444444444444444', SERVER_A, [
    signUp(1, DID(1), 'Aldric', 'Warrior', 'Arms'), signUp(2, DID(2), 'Brindle', 'Mage', 'Fire'), signUp(3, DID(5), 'Eliora', 'Bench', undefined),
  ]));
  assert.equal((await s.call('bob', 'PUT', s.raid(event.json.raid.id, '/event'), { source: '444444444444444444' })).status, 200);
  const planBody = { label: 'Tuesday', players: [{ name: 'Aldric', group: 1 }, { name: 'Brindle', group: 2 }, { name: 'Eliora', group: 0 }, { name: 'Nobodyhere', group: 3 }] };
  const put = await s.call('bob', 'PUT', s.raid(plan.json.raid.id, '/plan'), planBody);
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual([put.json.sources.plan.label, put.json.sources.plan.players, put.json.sources.plan.unmatched], ['Tuesday', 4, ['Nobodyhere']]);
  const planRows = await s.w.rows("SELECT signup_id, kind, player_id FROM raid_signups WHERE raid_id = ? AND source = 'plan' ORDER BY signup_id", plan.json.raid.id);
  assert.deepEqual(planRows.map((r) => [r.signup_id, r.kind, r.player_id]), [[1, 'signed', s.p.aldric], [2, 'signed', s.p.brindle], [3, 'bench', s.p.eliora]]);
  const manual = (raid) => s.call('bob', 'PUT', s.raid(raid, '/manual'), { reason: 'Logger was off', presentPlayerIds: [s.p.aldric] });
  const a = await manual(plan.json.raid.id);
  const b = await manual(event.json.raid.id);
  const pick = (d) => Object.fromEntries(d.people.filter((p) => ['Aldric', 'Brindle', 'Eliora'].includes(p.name)).map((p) => [p.name, [p.outcome, p.credit, p.flags]]));
  assert.deepEqual(pick(a.json), pick(b.json), 'the same people in the same kinds give the same outcomes whatever the source');
  assert.deepEqual(pick(a.json).Brindle, ['missed', 0, ['no_show']], 'a plan placement is an expected sign-up');
  assert.equal(a.json.unmatched.length, 0, 'an unmatched plan name is not a flag');
  // Re-derived on recompute: a person who joins the roster under a plan name gets a row.
  await addPerson(s, 'bob', s.A, 'Nobodyhere');
  const recomputed = await s.call('bob', 'POST', s.raid(plan.json.raid.id, '/recompute'), {});
  assert.equal(await s.w.count('raid_signups', "raid_id = ? AND source = 'plan'", plan.json.raid.id), 4);
  assert.equal(byName(recomputed.json).Nobodyhere.outcome, 'missed');
  // Validation.
  const bad = (players, label = 'Plan') => s.call('bob', 'PUT', s.raid(plan.json.raid.id, '/plan'), { label, players });
  assert.deepEqual([(await bad([{ name: 'x1', group: 1 }])).json.error, (await bad([{ name: 'x1', group: 1 }])).json.index], ['plan_invalid', 0]);
  assert.equal((await bad([{ name: 'Aldric', group: 9 }])).json.error, 'plan_invalid');
  assert.equal((await bad([{ name: 'Aldric', group: 1 }, { name: 'ALDRIC', group: 2 }])).json.error, 'plan_invalid');
  assert.equal((await bad(Array.from({ length: 81 }, (_, i) => ({ name: nameFor(i), group: 1 })))).json.error, 'plan_invalid');
  assert.equal((await bad([])).json.error, 'plan_invalid');
  assert.equal((await bad([{ name: 'Aldric', group: 1 }], '')).status, 400);
  const removed = await s.call('bob', 'DELETE', s.raid(plan.json.raid.id, '/plan'), {});
  assert.deepEqual([removed.json.sources.plan, await s.w.count('raid_plan', 'raid_id = ?', plan.json.raid.id), await s.w.count('raid_signups', "raid_id = ? AND source = 'plan'", plan.json.raid.id)], [null, 0, 0]);
});

check('plan beats a Raid-Helper Absence (the strongest kind wins across sources)', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const before = byName((await s.call('bob', 'GET', s.raid(id))).json).Dunmar;
  assert.equal(before.outcome, 'missed_notice');
  const planned = await s.call('bob', 'PUT', s.raid(id, '/plan'), { label: 'Plan', players: [{ name: 'Dunmar', group: 2 }] });
  const after = byName(planned.json).Dunmar;
  assert.deepEqual([after.outcome, after.flags, after.signup], ['missed', ['no_show'], 'signed']);
});

// ---------------------------------------------------------------------------
// Privacy, Delete my data, audit

check('Delete my data: the sign-up loses the Discord ID and nickname, keeps the person link, and the outcomes recompute the same', async () => {
  const s = await raidWorld();
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, [...eventSignUps(), signUp(7, PEOPLE.erin.id, 'Erinnick', 'Warrior', 'Arms')]));
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.fenwick}'`);
  const { id, detail } = await fullRaid(s);
  const before = outcomes(detail);
  assert.equal(before.Fenwick, 'missed', 'signed up and not in the log');
  const row = (await s.w.rows('SELECT nickname, discord_user_id, player_id FROM raid_signups WHERE signup_id = 7'))[0];
  assert.deepEqual(row, { nickname: 'Erinnick', discord_user_id: PEOPLE.erin.id, player_id: s.p.fenwick });
  const gone = await s.w.call(s.jars.erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  const after = (await s.w.rows('SELECT nickname, discord_user_id, player_id FROM raid_signups WHERE signup_id = 7'))[0];
  assert.deepEqual(after, { nickname: null, discord_user_id: null, player_id: s.p.fenwick });
  // The player link was unlinked by Delete my data's own rule (the person loses the Discord ID) but the sign-up row is kept
  // and the other people's rows are untouched.
  assert.equal(await s.w.count('raid_signups', 'discord_user_id IS NOT NULL'), 6);
  const recomputed = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  const now = outcomes(recomputed.json);
  for (const name of ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Wanderfell']) assert.equal(now[name], before[name], name);
});

check('audit: every attendance action is written, none holds a nickname, a Discord ID or a name; `reason` is the officer text', async () => {
  const s = await raidWorld();
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  const { id, detail } = await fullRaid(s);
  const brindle = byName(detail).Brindle.playerId;
  await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Told us in Discord', expectedFlags: ['no_show'] });
  await s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Mistake' });
  await s.call('bob', 'PUT', s.raid(id, '/plan'), { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] });
  await s.call('bob', 'POST', s.raid(id, '/unmatched'), { key: 'zorgax|nightslayer', action: 'alt', personId: s.p.fenwick });
  const second = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-02' })).json.raid.id;
  s.w.sources.reports.set(R3, wclReport({ startTime: Date.parse('2027-01-02T20:00:00Z'), actors: [[1, 'Aldric', 'Warrior'], [2, 'Visitor', 'Mage']], fights: [[1, 'Gruul', 650, true, 0, 100, [1, 2]]] }));
  await s.call('bob', 'PUT', s.raid(second, '/reports'), { source: R3 });
  await s.call('bob', 'POST', s.raid(second, '/unmatched'), { key: 'visitor|nightslayer', action: 'guest' });
  await s.call('bob', 'DELETE', s.raid(second, `/reports/${R3}`), {});
  await s.call('bob', 'PUT', s.raid(second, '/manual'), { reason: 'Logger was off', presentPlayerIds: [s.p.wander] });
  await s.call('bob', 'DELETE', s.raid(second, '/manual'), { reason: 'Found it' });
  s.w.sources.events.set('555555555555555555', rhEvent('555555555555555555', SERVER_A, eventSignUps()));
  await s.call('bob', 'PUT', s.raid(second, '/event'), { source: '555555555555555555', moveRaid: true }); // the event is on another day than the raid: moving it is the officer's yes
  await s.call('bob', 'DELETE', s.raid(second, '/plan'), {});
  await s.call('bob', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 });
  await s.call('bob', 'PUT', '/attendance/wcl', { wclGuildId: 5, uploaders: { [s.A]: ['Uploader'] } });
  await s.call('bob', 'PATCH', s.raid(second), { size: 20 });
  await s.call('bob', 'DELETE', s.raid(second), {});
  const written = (await s.w.rows("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'raid.%' OR action LIKE 'attendance.%' OR action IN ('policy.update', 'wcl.settings')")).map((r) => r.action).sort();
  const expected = AUDIT_ACTIONS.filter((a) => /^(raid|attendance)\./.test(a) || ['policy.update', 'wcl.settings'].includes(a)).sort();
  assert.equal(expected.length, 13);
  assert.deepEqual(written, expected);
  const dump = (await s.w.rows('SELECT action, before, after FROM audit_log')).map((r) => `${r.before} ${r.after}`).join('\n');
  for (const secret of ['Stranger', DID(1), DID(5), '299999999999999999', PEOPLE.erin.id, 'Aldric', 'Zorgax', 'Visitor', 'Uploader', 'nightslayer']) {
    assert.equal(dump.includes(secret), false, `audit rows must not contain ${secret}`);
  }
  assert(dump.includes('Told us in Discord'), 'the officer reason is kept');
});

// ---------------------------------------------------------------------------
// Fix round 1 (review findings 1-10): decisions are input, versions guard recompute, every input write leaves the raid stale

// Runs `sql` just before every recompute write batch (the one whose first statement is the version guard) while `on` is true,
// at most `times` times: a stand-in for a second request writing between this recompute's read and its write.
function racing(w, { times = Infinity, sql = "UPDATE raids SET version = version + 1, policy_fp = ''" } = {}) {
  const original = w.db.batch;
  const state = { on: true, fired: 0, guarded: 0 };
  w.db.batch = function batch(statements) {
    if (state.on && statements[0] && /INSERT INTO attendance_write_guard/.test(statements[0].sql)) {
      state.guarded++;
      if (state.fired < times) { state.fired++; w.db.sqlite.exec(sql); }
    }
    return original.call(this, statements);
  };
  state.stop = () => { w.db.batch = original; };
  return state;
}
const fpOf = async (s, raidId) => (await s.w.rows('SELECT policy_fp FROM raids WHERE id = ?', raidId))[0].policy_fp;

check('A: decisions are their own rows; a recompute never writes or deletes them; one survives its row disappearing and reapplies when the row returns', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  const brindle = byName(detail).Brindle.playerId;
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] })).status, 200);
  const stored = await s.w.rows('SELECT * FROM attendance_decisions WHERE raid_id = ?', id);
  assert.deepEqual([stored.length, stored[0].flags, stored[0].outcome, stored[0].credit, stored[0].reason], [1, '["no_show"]', 'bench', 1, 'Told us']);
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'present', reason: 'Actually there', expectedFlags: ['no_show'] })).status, 200);
  assert.equal(await s.w.count('attendance_decisions'), 1, 'deciding again replaces the one row');
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] })).status, 200);
  const before = await s.w.rows('SELECT * FROM attendance_decisions WHERE raid_id = ?', id);
  // Brindle loses her sign-up and goes inactive: she has no attendance row at all, and the decision stays.
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, eventSignUps().filter((x) => x.id !== 2)));
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/event'), { source: EVENT_ID })).status, 200);
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.brindle}`, { expectedVersion: 1, status: 'inactive', leftOn: null })).status, 200); // no left-on date: never expected again
  const gone = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.equal(byName(gone.json).Brindle, undefined, 'no row');
  assert.equal(await s.w.count('attendance', 'player_id = ?', s.p.brindle), 0);
  assert.deepEqual(await s.w.rows('SELECT * FROM attendance_decisions WHERE raid_id = ?', id), before, 'the decision row is untouched');
  // She comes back with the same flags: the decision applies again.
  s.w.sources.events.set(EVENT_ID, rhEvent(EVENT_ID, SERVER_A, eventSignUps()));
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.brindle}`, { expectedVersion: 2, status: 'raider' })).status, 200);
  const back = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: EVENT_ID });
  const row = byName(back.json).Brindle;
  assert.deepEqual([row.outcome, row.credit, row.needsReview, row.decision.applied, row.decision.reason], ['bench', 1, false, true, 'Told us']);
  assert.deepEqual(await s.w.rows('SELECT * FROM attendance_decisions WHERE raid_id = ?', id), before);
  // A raid delete takes its decisions; undo removes the row and bumps the version.
  const version = (await s.w.rows('SELECT version FROM raids WHERE id = ?', id))[0].version;
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Mistake' })).status, 200);
  assert.equal(await s.w.count('attendance_decisions'), 0);
  assert((await s.w.rows('SELECT version FROM raids WHERE id = ?', id))[0].version > version);
});

check('A: recompute is conditional on the versions it read: a bump (or a new raid on the date) between read and write aborts the write; one retry from a fresh read; losing twice leaves the raid stale', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const snapshot = async () => ({
    rows: await s.w.rows('SELECT * FROM attendance ORDER BY raid_id, player_id'),
    raid: (await s.w.rows('SELECT open_flags, computed_at FROM raids WHERE id = ?', id))[0],
    signups: await s.w.count('raid_signups'),
  });
  const base = await snapshot();
  s.w.advance(60_000);
  // Lost once: the retry (a second read) wins and the raid is fresh.
  let race = racing(s.w, { times: 1 });
  let r = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  race.stop();
  assert.deepEqual([r.status, r.json.raid.stale, race.guarded, race.fired], [200, false, 2, 1]);
  assert.match(await fpOf(s, id), /^[0-9a-f]{8}$/);
  // Lost twice: nothing written (computed_at, rows and plan sign-ups are as before), the raid shows as stale.
  const mid = await snapshot();
  s.w.advance(60_000);
  race = racing(s.w);
  r = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  race.stop();
  assert.deepEqual([r.status, r.json.raid.stale, race.guarded], [200, true, 2]);
  assert.equal(await fpOf(s, id), '');
  assert.deepEqual(await snapshot(), { ...mid, raid: mid.raid });
  assert.equal(base.signups, mid.signups);
  // A raid appearing on the date between read and write also aborts it (the fill-in pass spans the date).
  race = racing(s.w, {
    times: 1,
    sql: `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at)
          SELECT 'r_race', guild_id, '${s.B}', raid_on, starts_at, 1, 1 FROM raids WHERE id = '${id}'`,
  });
  r = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  race.stop();
  assert.deepEqual([race.guarded, r.json.raid.stale], [2, false]);
  assert.match((await s.w.rows("SELECT policy_fp FROM raids WHERE id = 'r_race'"))[0].policy_fp, /^[0-9a-f]{8}$/, 'the retry saw and computed the new raid');
});

check('B: every input write leaves its raid stale in its own batch, so a recompute that never lands shows as stale', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  const manualId = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-10' })).json.raid.id;
  const brindle = byName(detail).Brindle.playerId;
  // Every recompute loses its race: the version moves under it, and policy_fp stays as the input write left it.
  const original = s.w.db.batch;
  const race = { on: true };
  s.w.db.batch = function batch(statements) {
    if (race.on && statements[0] && /INSERT INTO attendance_write_guard/.test(statements[0].sql)) s.w.db.sqlite.exec('UPDATE raids SET version = version + 1');
    return original.call(this, statements);
  };
  const fresh = async (raidId) => {
    race.on = false;
    assert.equal((await s.call('bob', 'POST', s.raid(raidId, '/recompute'), {})).status, 200);
    race.on = true;
    assert.match(await fpOf(s, raidId), /^[0-9a-f]{8}$/, 'fresh before the write');
  };
  const cases = [
    ['PUT event', id, () => s.call('bob', 'PUT', s.raid(id, '/event'), { source: EVENT_ID })],
    ['PUT plan', id, () => s.call('bob', 'PUT', s.raid(id, '/plan'), { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] })],
    ['DELETE plan', id, () => s.call('bob', 'DELETE', s.raid(id, '/plan'), {})],
    ['POST decision', id, () => decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] })],
    ['DELETE decision', id, () => s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Mistake' })],
    ['POST unmatched (guest)', id, () => s.call('bob', 'POST', s.raid(id, '/unmatched'), { key: 'zorgax|nightslayer', action: 'guest' })],
    ['PUT report', id, () => s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R1 })],
    ['DELETE event', id, () => s.call('bob', 'DELETE', s.raid(id, '/event'), {})],
    ['DELETE report', id, () => s.call('bob', 'DELETE', s.raid(id, `/reports/${R1}`), {})],
    ['PUT manual', manualId, () => s.call('bob', 'PUT', s.raid(manualId, '/manual'), { reason: 'Logger was off', presentPlayerIds: [s.p.aldric] })],
    ['DELETE manual', manualId, () => s.call('bob', 'DELETE', s.raid(manualId, '/manual'), { reason: 'Found the log' })],
  ];
  for (const [label, raidId, run] of cases) {
    await fresh(raidId);
    const response = await run();
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.json)}`);
    assert.equal(await fpOf(s, raidId), '', `${label} left the raid stale`);
  }
  // A new raid on the date makes its neighbour stale; so does the unmatched link to an Alt.
  await fresh(id);
  const sibling = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: (await s.call('bob', 'GET', s.raid(id))).json.raid.raidOn });
  assert.equal(sibling.status, 201, JSON.stringify(sibling.json));
  assert.equal(await fpOf(s, id), '', 'a new raid on the date');
  s.w.db.batch = original;
});

check('D: the sign-up rate leaves out a raid that is still awaiting its log', async () => {
  const s = await raidWorld();
  await fullRaid(s);
  exec(s.w, "UPDATE players SET joined_on = '2026-12-01'");
  assert.equal((await s.call('bob', 'PUT', '/attendance/policy', { teamId: null, policy: { effectiveStart: 'joinDate' }, expectedVersion: 0 })).status, 200);
  const other = '222222222222222222';
  s.w.sources.events.set(other, rhEvent(other, SERVER_A, eventSignUps(), { startTime: RH_START - 7 * 86400 }));
  const second = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: other });
  assert.deepEqual([second.status, second.json.raid.state], [201, 'awaiting_log']);
  const team = (await s.call('carol', 'GET', `/attendance/team?team=${s.A}`)).json;
  assert.equal(team.people.find((p) => p.name === 'Aldric').signupRate, 100, 'one raid with results, signed up to it');
  assert.equal(team.people.find((p) => p.name === 'Fenwick').signupRate, 0);
  const person = (await s.call('bob', 'GET', `/attendance/person/${s.p.aldric}?window=all`)).json;
  assert.equal(person.teams[0].metrics.signupRate, 100);
});

check('E: recompute links sign-ups whose Discord ID had no person at ingest; person status changes and roster additions mark every raid of the team stale', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  assert.equal(byName(detail).Fenwick.outcome, 'no_signup');
  assert.equal((await s.w.rows("SELECT player_id FROM raid_signups WHERE raid_id = ? AND discord_user_id = '299999999999999999'", id))[0].player_id, null);
  exec(s.w, `UPDATE players SET discord_user_id = '299999999999999999' WHERE id = '${s.p.fenwick}'`);
  const linked = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.equal((await s.w.rows("SELECT player_id FROM raid_signups WHERE raid_id = ? AND discord_user_id = '299999999999999999'", id))[0].player_id, s.p.fenwick);
  assert.equal(byName(linked.json).Fenwick.outcome, 'missed', 'signed up, not in the log');
  // A status change marks the person\'s team raids stale (no log name involved).
  assert.match(await fpOf(s, id), /^[0-9a-f]{8}$/);
  const patch = await s.call('bob', 'PATCH', `/roster/${s.p.dunmar}`, { expectedVersion: 1, status: 'reserve' });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.equal(await fpOf(s, id), '');
  // A raid with sign-ups only (no log, no presence) is reached too, and a person added to the team marks it.
  const other = '222222222222222222';
  s.w.sources.events.set(other, rhEvent(other, SERVER_A, eventSignUps(), { startTime: RH_START - 7 * 86400 }));
  const awaiting = (await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: other })).json.raid.id;
  const manual = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-02' })).json.raid.id;
  assert.equal((await s.call('bob', 'PUT', s.raid(manual, '/manual'), { reason: 'Logger was off', presentPlayerIds: [s.p.aldric] })).status, 200);
  const bRaid = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-02' })).json.raid.id;
  assert.equal((await s.call('bob', 'PUT', s.raid(bRaid, '/manual'), { reason: 'Logger was off', presentPlayerIds: [] })).status, 200);
  await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  for (const raidId of [id, awaiting, manual, bRaid]) assert.match(await fpOf(s, raidId), /^[0-9a-f]{8}$/, raidId);
  await addPerson(s, 'bob', s.A, 'Galdor');
  assert.equal(await fpOf(s, id), '');
  assert.equal(await fpOf(s, awaiting), '');
  assert.equal(await fpOf(s, manual), '');
  assert.match(await fpOf(s, bRaid), /^[0-9a-f]{8}$/, 'team B has no new person: its raid stays fresh');
  const bPerson = await addPerson(s, 'bob', s.B, 'Hestia');
  assert.equal(await fpOf(s, bRaid), '');
  void bPerson;
});

check('F: a Raid-Helper event that has not started imports as an upcoming raid, and a raid date cannot precede World of Warcraft', async () => {
  const s = await raidWorld();
  const future = '444444444444444444';
  s.w.sources.events.set(future, rhEvent(future, SERVER_A, eventSignUps(), { startTime: Math.floor(s.w.clock.now / 1000) + 3600 }));
  const imported = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: future });
  assert.deepEqual([imported.status, imported.json.raid.upcoming, imported.json.raid.state], [201, true, 'awaiting_log']);
  assert.equal(imported.json.raid.startsAt, (Math.floor(s.w.clock.now / 1000) + 3600) * 1000);
  assert.equal(await s.w.count('raids'), 1);
  assert.equal(await s.w.count('raid_signups'), 6);
  assert.equal(await s.w.count('attendance'), 0, 'a raid that has not started has no attendance rows');
  for (const bad of ['2004-11-22', '1999-01-01', '0001-01-01']) {
    const r = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: bad });
    assert.deepEqual([r.status, r.json.field], [400, 'raidOn'], bad);
  }
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2004-11-23' })).status, 201);
  // A report whose pulls date before the game existed is refused the same way.
  s.w.sources.reports.set(R2, report1({ startTime: Date.parse('2003-05-05T20:00:00Z') }));
  const old = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSource: R2 });
  assert.deepEqual([old.status, old.json.field], [400, 'raidOn']);
});

check('G: a guild policy save re-validates every team override on top of it; the person route falls back to a team\'s default window instead of a 400', async () => {
  const s = await raidWorld();
  const put = (who, body) => s.call(who, 'PUT', '/attendance/policy', body);
  assert.equal((await put('bob', { teamId: s.B, policy: { window: { defaultWeeks: 12 } }, expectedVersion: 0 })).status, 200);
  const refused = await put('bob', { teamId: null, policy: { window: { defaultWeeks: 8, switchWeeks: [8] } }, expectedVersion: 0 });
  assert.deepEqual([refused.status, refused.json.error, refused.json.teamId, refused.json.field], [400, 'policy_invalid', s.B, 'window.defaultWeeks']);
  assert.match(refused.json.message, /Bravo/);
  assert.equal((await s.call('bob', 'GET', '/attendance/policy')).json.versions.guild, 0, 'nothing was saved');
  assert.equal((await put('bob', { teamId: null, policy: { window: { defaultWeeks: 12, switchWeeks: [8, 12] } }, expectedVersion: 0 })).status, 200);
  // A state the save no longer allows (written by hand): team B defaults to 12, the guild offers only 8.
  exec(s.w, `UPDATE attendance_policies SET policy = '{"window":{"defaultWeeks":8,"switchWeeks":[8]}}' WHERE team_id IS NULL`);
  assert.equal((await addAlt(s, 'bob', s.p.wander, s.A, 'Wanderalt')).status, 201);
  const person = async (query) => (await s.call('bob', 'GET', `/attendance/person/${s.p.wander}${query}`)).json;
  const lenient = await person('?window=12');
  assert.deepEqual(Object.fromEntries(lenient.teams.map((t) => [t.team.id, t.window])), { [s.A]: 8, [s.B]: 12 }, 'each team falls back to its own default');
  assert.deepEqual(Object.fromEntries((await person('?window=8')).teams.map((t) => [t.team.id, t.window])), { [s.A]: 8, [s.B]: 8 });
  assert.deepEqual(Object.fromEntries((await person('')).teams.map((t) => [t.team.id, t.window])), { [s.A]: 8, [s.B]: 12 });
  assert.equal((await s.call('bob', 'GET', `/attendance/person/${s.p.wander}?window=abc`)).status, 400, 'a malformed window is still refused');
  assert.equal((await s.call('bob', 'GET', `/attendance/team?team=${s.A}&window=12`)).status, 400, 'the team page stays strict');
});

check('I: other UNIQUE failures are a plain 409, a report write on a raid that went manual is refused, the guest audit keeps the name key, credit labels follow cleanText, a refused create touches no neighbour', async () => {
  const s = await raidWorld();
  // 'other' UNIQUE: a unique index on zone makes a second raid with the same zone collide on something that is not the team, event or report.
  const first = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-14' });
  assert.equal((await s.call('bob', 'PUT', s.raid(first.json.raid.id, '/reports'), { source: R1, confirmFar: true })).status, 200);
  exec(s.w, 'CREATE UNIQUE INDEX test_zone ON raids(guild_id, zone)');
  const second = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-13' });
  s.w.sources.reports.set(R2, report1({ startTime: Date.parse('2027-01-13T20:00:00Z') }));
  const clash = await s.call('bob', 'PUT', s.raid(second.json.raid.id, '/reports'), { source: R2 });
  assert.deepEqual([clash.status, clash.json.error], [409, 'conflict']);
  exec(s.w, 'DROP INDEX test_zone');
  // The report guard: the raid went manual between the read and the write.
  const third = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-12' });
  const thirdId = third.json.raid.id;
  s.w.sources.reports.set(R3, report1({ startTime: Date.parse('2027-01-12T20:00:00Z') }));
  const original = s.w.db.batch;
  s.w.db.batch = function batch(statements) {
    if (statements.some((statement) => /INSERT INTO raid_reports/.test(statement.sql))) {
      s.w.db.sqlite.exec(`UPDATE raids SET log_mode = 'manual', manual_reason = 'Logger broke', manual_at = 1 WHERE id = '${thirdId}'`);
    }
    return original.call(this, statements);
  };
  const raced = await s.call('bob', 'PUT', s.raid(thirdId, '/reports'), { source: R3 });
  s.w.db.batch = original;
  assert.deepEqual([raced.status, raced.json.error], [409, 'raid_is_manual']);
  assert.equal(await s.w.count('raid_reports', 'raid_id = ?', thirdId) + await s.w.count('raid_pulls', 'raid_id = ?', thirdId), 0);
  // The guest audit names the key.
  assert.equal((await s.call('bob', 'POST', s.raid(first.json.raid.id, '/unmatched'), { key: 'zorgax|nightslayer', action: 'guest' })).status, 200);
  const audit = (await s.w.rows("SELECT after FROM audit_log WHERE action = 'attendance.guest'"))[0];
  assert.deepEqual(JSON.parse(audit.after), { guest: true, nameKey: 'zorgax' });
  // Credit labels: trimmed like cleanText, control characters refused.
  const put = (labels) => s.call('bob', 'PUT', '/attendance/policy', {
    teamId: null, expectedVersion: 0,
    policy: { credit: { values: labels.map((label, index) => ({ id: ['aaa', 'bbb', 'ccc'][index], label, value: index / 2 })) } },
  });
  assert.equal((await put(['Full', 'Half', 'Bad\u0007'])).json.error, 'policy_invalid');
  assert.equal((await put(['Full', 'Half', '   '])).json.error, 'policy_invalid');
  assert.equal((await put(['Full', 'Half', 'abcdefghijklm'])).json.error, 'policy_invalid');
  const ok = await put(['  Full  ', 'Half', '  abcdefghijkl  ']);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.guild.credit.values.map((v) => v.label), ['Full', 'Half', 'abcdefghijkl']);
  // A create that is refused (archived team) leaves the neighbouring raid alone.
  const neighbour = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-11' });
  await s.call('bob', 'PUT', s.raid(neighbour.json.raid.id, '/plan'), { label: 'Plan', players: [{ name: 'Wanderfell', group: 1 }] });
  const mark = (await s.w.rows('SELECT policy_fp, version FROM raids WHERE id = ?', neighbour.json.raid.id))[0];
  exec(s.w, `UPDATE teams SET archived = 1 WHERE id = '${s.A}'`);
  const refused = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-11' });
  assert.deepEqual([refused.status, refused.json.field], [400, 'teamId']);
  assert.deepEqual((await s.w.rows('SELECT policy_fp, version FROM raids WHERE id = ?', neighbour.json.raid.id))[0], mark);
});

check('J: the raid detail lists who was ticked on a manual raid, team-page Other-team cells name their team, the person view says isMe', async () => {
  const s = await raidWorld();
  const created = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  const id = created.json.raid.id;
  const ticks = [s.p.aldric, s.p.cassia, s.p.wander];
  assert.equal((await s.call('carol', 'PUT', s.raid(id, '/manual'), { reason: 'Logger was off', presentPlayerIds: ticks })).status, 200);
  const detail = (await s.call('bob', 'GET', s.raid(id))).json;
  assert.deepEqual([...detail.raid.manual.presentPlayerIds].sort(), [...ticks].sort());
  assert.deepEqual((await s.call('erin', 'GET', s.raid(id))).json.raid.manual.presentPlayerIds, [], 'a viewer who cannot see attendance gets no list');
  assert.equal((await s.call('bob', 'GET', s.raid(id))).json.raid.manual.reason, 'Logger was off');
  // Wanderfell (team B) ticked on team A's raid: an Other-team cell on team B's page with the host team as an object.
  s.w.advance(86_400_000);
  const b = (await s.call('bob', 'GET', `/attendance/team?team=${s.B}&window=all`)).json;
  const cell = b.people.find((p) => p.name === 'Wanderfell').cells[0];
  assert.deepEqual([cell.outcome, cell.via], ['fill_in', { id: s.A, name: 'Alpha' }]);
  // His home row replaced by the host raid carries the same shape (via_raid_id resolves to the host team).
  const home = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: detail.raid.raidOn })).json.raid.id;
  s.w.sources.events.set('333333333333333333', rhEvent('333333333333333333', SERVER_A, [signUp(1, DID(7), 'Wanderfell', 'Druid', 'Feral')]));
  assert.equal((await s.call('bob', 'PUT', s.raid(home, '/event'), { source: '333333333333333333' })).status, 200);
  assert.equal((await s.call('bob', 'PUT', s.raid(home, '/manual'), { reason: 'Logger was off', presentPlayerIds: [] })).status, 200);
  const replaced = (await s.call('bob', 'GET', `/attendance/team?team=${s.B}&window=all`)).json.people.find((p) => p.name === 'Wanderfell').cells;
  assert.deepEqual(replaced.map((c) => [c.outcome, c.via]), [['fill_in', { id: s.A, name: 'Alpha' }]]);
  // person.isMe
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.carol.id}' WHERE id = '${s.p.aldric}'`);
  assert.equal((await s.call('carol', 'GET', `/attendance/person/${s.p.aldric}`)).json.person.isMe, true);
  assert.equal((await s.call('bob', 'GET', `/attendance/person/${s.p.aldric}`)).json.person.isMe, false);
});

// ---------------------------------------------------------------------------
// Rate limits, budgets, config

check('rate limits: report fetches use wclraid:<user> and wcl:global (both fail closed); the list route shares them', async () => {
  const s = await raidWorld();
  const raid = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-14' })).json.raid.id;
  s.w.sources.reports.set(R1, report1({ startTime: Date.parse('2027-01-14T20:00:00Z') }));
  const put = () => s.call('bob', 'PUT', s.raid(raid, '/reports'), { source: R1 });
  exec(s.w, `INSERT INTO rate_limits (key, window_start, count) VALUES ('wclraid:${s.ids.bob}', ${s.w.clock.now}, 39)`);
  assert.equal((await put()).status, 200, 'the 40th use is allowed');
  const limited = await put();
  assert.deepEqual([limited.status, limited.json.error], [429, 'rate_limited']);
  assert(limited.json.retryAfter > 0);
  s.w.advance(11 * 60_000);
  assert.equal((await put()).status, 200, 'the window resets');
  exec(s.w, `INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES ('wcl:global', ${s.w.clock.now}, 61)`);
  const global = await put();
  assert.deepEqual([global.status, global.json.error], [429, 'rate_limited']);
  assert.match(global.json.message, /everyone/);
  exec(s.w, "DELETE FROM rate_limits WHERE key = 'wcl:global'");
  s.w.sources.listing = () => ({ data: [], has_more_pages: false });
  exec(s.w, `INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES ('wclraid:${s.ids.bob}', ${s.w.clock.now}, 41)`);
  assert.equal((await s.call('bob', 'GET', `/attendance/backfill/reports?team=${s.A}`)).status, 429);
  // Fail closed: a broken limiter pauses the route (503) instead of letting the fetch through.
  const t = await raidWorld();
  const id2 = (await t.call('bob', 'POST', '/raids', { teamId: t.A, raidOn: '2027-01-14' })).json.raid.id;
  t.w.sources.reports.set(R1, report1({ startTime: Date.parse('2027-01-14T20:00:00Z') }));
  const callsBefore = t.w.sources.calls.length;
  exec(t.w, 'DROP TABLE rate_limits');
  const down = await t.call('bob', 'PUT', t.raid(id2, '/reports'), { source: R1 });
  assert.deepEqual([down.status, down.json.error], [503, 'rate_limited']);
  assert.equal(t.w.sources.calls.length, callsBefore, 'nothing was fetched');
});

check('request budgets: D1 calls (session, central write limiter, fail-closed windows and the detail read included) and fetches per route stay at the measured numbers', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const budgets = [];
  const measure = async (label, run, maxD1, maxFetch) => {
    const c = await counted(s.w, run);
    budgets.push(`${label}: ${c.d1} d1, ${c.fetch} fetch`);
    if (process.env.SHOW_BUDGETS) return;
    assert(c.d1 <= maxD1 && c.fetch <= maxFetch, `${label}: ${c.d1} D1 calls (max ${maxD1}), ${c.fetch} fetches (max ${maxFetch})`);
  };
  let id;
  await measure('POST /raids (no event)', async () => { id = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-02' })).json.raid.id; }, 6, 0);
  let aId;
  await measure('POST /raids with an event', async () => { aId = (await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID })).json.raid.id; }, 8, 1);
  await measure('PUT .../event', async () => { assert.equal((await s.call('bob', 'PUT', s.raid(aId, '/event'), { source: EVENT_ID })).status, 200); }, 9, 1);
  await measure('PUT .../reports', async () => { assert.equal((await s.call('bob', 'PUT', s.raid(aId, '/reports'), { source: R1 })).status, 200); }, 11, 2);
  await measure('PUT .../plan', async () => { assert.equal((await s.call('bob', 'PUT', s.raid(aId, '/plan'), { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] })).status, 200); }, 8, 0);
  const brindle = byName((await s.call('bob', 'GET', s.raid(aId))).json).Brindle.playerId;
  await measure('POST .../decisions', async () => { assert.equal((await decide(s, 'bob', aId, { playerId: brindle, outcome: 'present', reason: 'Was there', expectedFlags: ['no_show'] })).status, 200); }, 9, 0);
  await measure('POST .../unmatched', async () => { assert.equal((await s.call('bob', 'POST', s.raid(aId, '/unmatched'), { key: 'zorgax|nightslayer', action: 'guest' })).status, 200); }, 9, 0);
  await measure('POST .../recompute', async () => { assert.equal((await s.call('bob', 'POST', s.raid(aId, '/recompute'), {})).status, 200); }, 7, 0);
  await measure('GET /attendance/team', async () => { assert.equal((await s.call('bob', 'GET', `/attendance/team?team=${s.A}`)).status, 200); }, 4, 0);
  s.w.sources.listing = () => ({ data: [], has_more_pages: false });
  await measure('GET /attendance/backfill/reports', async () => { assert.equal((await s.call('bob', 'GET', `/attendance/backfill/reports?team=${s.A}`)).status, 200); }, 6, 2);
  await measure('GET /raids/:rid', async () => { assert.equal((await s.call('bob', 'GET', s.raid(aId))).status, 200); }, 3, 0);
  void id;
  console.log(`      ${budgets.join('\n      ')}`);
});

check('config: no *_API_BASE in wrangler.jsonc, the new files are whitelisted, README documents the attendance fakes', async () => {
  const fs = require('node:fs');
  assert(!/_API_BASE/.test(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8')));
  const { spawnSync } = require('node:child_process');
  const files = ['guild-attendance-worker-tests.js', 'migrations/0003_attendance.sql', 'worker/attendance-store.js', 'worker/attendance-view.js',
    'worker/routes/raids.js', 'worker/routes/attendance.js', 'worker/attendance-policy.js'];
  if (spawnSync('git', ['--version'], { cwd: ROOT }).status === 0) {
    for (const file of files) assert.notEqual(spawnSync('git', ['check-ignore', '-q', '--no-index', '--', file], { cwd: ROOT }).status, 0, `${file} is whitelisted`);
  }
  assert(/Fake000000000002/.test(fs.readFileSync(path.join(ROOT, 'tools/fake-sources.js'), 'utf8')));
});

check('tools/fake-sources.js: the raid log (fights, friendlyPlayers, owner), a second report of the same night, and the report list', async () => {
  const { createFakeSources } = require('./tools/fake-sources.js');
  const fake = createFakeSources();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  try {
    const s = await raidWorld();
    // A real round trip through the Worker's own client against the fake.
    const { fetchWclPulls, listWclReports, resetWclTokenCache } = await load('worker/sources.js');
    resetWclTokenCache();
    const ctx = { env: { WCL_CLIENT_ID: 'a', WCL_CLIENT_SECRET: 'b', WCL_API_BASE: base }, fetch: (...a) => fetch(...a), now: () => Date.now() };
    const one = await fetchWclPulls(ctx, 'fresh', 'Fake000000000001');
    assert.equal(one.owner, 'Fakeuploader');
    assert.deepEqual(one.pulls.map((p) => [p.fightId, p.kill]), [[2, false], [3, true], [4, false], [5, true], [7, false]], 'trash and the unfinished fight are skipped');
    const first = one.pulls[0].players.map((p) => p.name);
    assert(!first.includes('Quillfeather') && !first.includes('Embertail'), 'Quillfeather is late, the pet is dropped');
    const two = await fetchWclPulls(ctx, 'fresh', 'Fake000000000002');
    assert(two.startTime > one.startTime && two.pulls[0].players.some((p) => p.name === 'Wanderfell'));
    const list = await listWclReports(ctx, 'fresh', { id: 1 }, 1);
    assert.deepEqual([list.reports.map((r) => r.code), list.hasMore], [['Fake000000000001', 'Fake000000000002'], true]);
    assert.equal((await listWclReports(ctx, 'fresh', { id: 1 }, 2)).hasMore, false);
    void s;
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

check('nav badge: the guild payload carries attendanceFlags per reviewable team (open raids), {} for those who cannot review; a delete answers with them', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const flags = async (who) => (await s.w.call(s.jars[who], 'GET', s.guildPath)).json.attendanceFlags;
  assert.deepEqual(await flags('bob'), { [s.A]: 1, [s.B]: 0 });
  assert.deepEqual(await flags('carol'), { [s.A]: 1 });
  assert.deepEqual(await flags('dave'), { [s.B]: 0 });
  assert.deepEqual(await flags('erin'), {});
  const gone = await s.call('bob', 'DELETE', s.raid(id), {});
  assert.deepEqual(gone.json, { deleted: true, attendanceFlags: { [s.A]: 0, [s.B]: 0 } });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fix round 2

check('R2-1: the D1 fake enforces the 5-term compound SELECT limit per nesting level, and no SQL string in worker/ breaks it', async () => {
  const { createD1Fake, maxCompoundTerms, scrub, MAX_COMPOUND_TERMS } = require('./tests/d1-fake');
  const terms = (sql) => maxCompoundTerms(scrub(sql));
  assert.equal(MAX_COMPOUND_TERMS, 5);
  const chain = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i + 1}`).join(' UNION ');
  assert.equal(terms(chain(5)), 5);
  assert.equal(terms(chain(7)), 7);
  assert.equal(terms(`SELECT 1 FROM (${chain(5)}) UNION SELECT 2 UNION SELECT 3`), 5, 'a parenthesised chain counts on its own level');
  assert.equal(terms(`WITH a AS (${chain(4)}), b AS (${chain(4)}) SELECT 1 WHERE 1 IN (SELECT * FROM a) OR 1 IN (SELECT * FROM b)`), 4);
  assert.equal(terms("SELECT 'a UNION b' UNION SELECT 1"), 2, 'string literals are ignored');
  const db = createD1Fake();
  db.prepare(chain(5));
  assert.throws(() => db.prepare(chain(6)), /D1_ERROR: too many terms in compound SELECT/);
  assert.throws(() => db.prepare(chain(7)), /too many terms in compound SELECT/);
  assert.throws(() => db.prepare(`SELECT 1 WHERE 1 IN (${chain(6)})`), /too many terms/);
  assert.throws(() => db.prepare(`SELECT '${'x'.repeat(100_001)}'`), /statement too long/);
  // The shape that broke on real D1 (the 7-term who CTE of loadDay) is refused.
  assert.throws(() => db.prepare('WITH who AS (SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7) SELECT * FROM who'), /too many terms/);
  db.close();

  // Every SQL-looking string literal in worker/ (static; interpolations stay as ${...}).
  const fs = require('node:fs');
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'worker'));
  let scanned = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
      const sql = match[1] !== undefined ? match[1] : match[2];
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) || !/\b(FROM|INTO|SET|WHERE)\b/.test(sql)) continue;
      scanned++;
      assert(terms(sql) <= MAX_COMPOUND_TERMS, `${path.relative(ROOT, file)}: ${terms(sql)} compound terms in: ${sql.slice(0, 80).replace(/\s+/g, ' ')}`);
      assert(Buffer.byteLength(sql) < 100_000, `${path.relative(ROOT, file)}: statement over 100 KB`);
    }
  }
  assert(scanned > 100, `scanned ${scanned} SQL strings`);
});

check('R2-1: loadDay (the recompute read) runs on the strict fake with people found by team, log, plan, sign-up, tick, row and decision', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const sizes = s.w.db.statementLog.map((entry) => entry.values.length);
  assert(Math.max(...sizes) <= 100);
  const r = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.deepEqual([r.status, r.json.raid.state, r.json.raid.stale], [200, 'to_review', false]);
  assert.equal(r.json.people.length, 7);
});

check('R2-2: a create whose report or event cannot be fetched writes nothing and a retry succeeds', async () => {
  const s = await raidWorld();
  const counts = async () => [await s.w.count('raids'), await s.w.count('raid_signups'), await s.w.count('raid_reports'), await s.w.count('audit_log', "action = 'raid.create'")];
  // Event is fine, the report is unknown to Warcraft Logs.
  const noReport = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID, reportSource: R2 });
  assert.deepEqual([noReport.status, noReport.json.error], [404, 'not_found']);
  assert.deepEqual(await counts(), [0, 0, 0, 0]);
  // The second of two reports fails: the first is not left behind either.
  const half = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSources: [R1, R2] });
  assert.equal(half.status, 404);
  assert.deepEqual(await counts(), [0, 0, 0, 0]);
  // The event fails (404), the report is fine.
  const noEvent = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: '999999999', reportSource: R1 });
  assert.notEqual(noEvent.status, 201);
  assert.deepEqual(await counts(), [0, 0, 0, 0]);
  // Retry once the source is there: no raid_exists / event_exists / report_exists.
  s.w.sources.reports.set(R2, report1({ startTime: RH_START * 1000 + 3_600_000 }));
  const ok = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID, reportSources: [R2, R1] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.sources.reports.map((x) => x.code), [R1, R2], 'two reports on one raid, earliest first');
  assert.equal(ok.json.raid.startsAt, RH_START * 1000, 'the event anchors the raid');
  assert.deepEqual(await counts(), [1, 6, 2, 1]);
  assert.equal(ok.json.recomputeFailed, undefined);
  // Bad lists are refused before any fetch.
  const calls = s.w.sources.calls.length;
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.B, reportSources: 'x' })).json.field, 'reportSources');
  assert.equal((await s.call('bob', 'POST', '/raids', { teamId: s.B, reportSources: Array(11).fill(R1) })).json.field, 'reportSources');
  assert.equal(s.w.sources.calls.length, calls);
});

check('R2-2/3: a recompute that fails after a create leaves the raid saved and stale, never reviewed; retrying the create is a plain raid_exists', async () => {
  const s = await raidWorld();
  const original = s.w.db.batch;
  let broken = true;
  s.w.db.batch = function batch(statements) {
    if (broken && statements[0] && /INSERT INTO attendance_write_guard/.test(statements[0].sql)) return Promise.reject(new Error('D1_ERROR: boom'));
    return original.call(this, statements);
  };
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID, reportSource: R1 });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.recomputeFailed, true);
  const id = made.json.raid.id;
  assert.deepEqual([made.json.raid.state, made.json.raid.stale, made.json.sources.reports.length], ['stale', true, 1]);
  assert.equal(await fpOf(s, id), '');
  assert.equal(await s.w.count('attendance'), 0);
  // List, detail and review queue all say so.
  const list = (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.raids[0];
  assert.deepEqual([list.state, list.stale, list.bosses.kills], ['stale', true, 1]);
  assert.deepEqual([(await s.call('bob', 'GET', s.raid(id))).json.raid.state], ['stale']);
  const q = (await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json;
  assert.deepEqual(q.stale, [id]);
  const again = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID, reportSource: R1 });
  assert.equal(again.status, 409);
  broken = false;
  const fixed = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.deepEqual([fixed.status, fixed.json.raid.state, fixed.json.raid.stale], [200, 'to_review', false]);
  s.w.db.batch = original;
});

check('R2-3: a raid with a log never reads "reviewed" while its fingerprint is empty (list, detail, review queue); an empty roster with a current fingerprint is not stale (live check 2026-10-16)', async () => {
  const { raidState, isStale } = await load('worker/attendance-view.js');
  const log = { log_mode: 'log', open_flags: 0, policy_fp: 'abcd1234' };
  assert.equal(raidState(log, 1), 'reviewed');
  assert.equal(raidState({ ...log, policy_fp: '' }, 1), 'stale');
  assert.equal(raidState({ ...log, open_flags: 25 }, 1), 'to_review', 'all unmatched on an empty roster: to review, not stale');
  assert.equal(raidState({ ...log, open_flags: 2, policy_fp: '' }, 1), 'stale');
  assert.equal(raidState({ ...log, policy_fp: '' }, 0), 'awaiting_log');
  assert.equal(raidState({ log_mode: 'manual', open_flags: 0, policy_fp: '' }, 0), 'manual');
  assert.deepEqual([isStale('stale'), isStale('reviewed'), isStale('awaiting_log')], [true, false, false]);
  // With the team's live fingerprint, a mismatch is stale whatever the stored result says (a policy change).
  const live = (fp) => ({ fingerprint: () => fp });
  assert.equal(raidState(log, 1, live('abcd1234')), 'reviewed');
  assert.equal(raidState(log, 1, live('other000')), 'stale');
  assert.equal(raidState({ ...log, open_flags: 3 }, 1, live('other000')), 'stale');
  assert.equal(raidState({ log_mode: 'manual', open_flags: 0, policy_fp: 'abcd1234' }, 0, live('other000')), 'stale');
  assert.equal(raidState({ ...log, policy_fp: 'zzz' }, 0, live('other000')), 'awaiting_log');

  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const states = async () => ({
    list: (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.raids[0],
    detail: (await s.call('bob', 'GET', s.raid(id))).json.raid,
    review: (await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json,
  });
  const first = await states();
  assert.deepEqual([first.list.state, first.detail.state], ['to_review', 'to_review']);
  // A failed recompute after an input write leaves the fingerprint empty: never reviewed.
  exec(s.w, `UPDATE raids SET open_flags = 0, policy_fp = '' WHERE id = '${id}'`);
  let now = await states();
  assert.deepEqual([now.list.state, now.list.stale, now.detail.state, now.detail.stale], ['stale', true, 'stale', true]);
  assert.deepEqual(now.review.stale, [id]);
  // Flags still open on a stale raid: the review queue marks it.
  exec(s.w, `UPDATE raids SET open_flags = 2, policy_fp = '' WHERE id = '${id}'`);
  now = await states();
  assert.deepEqual([now.list.state, now.review.raids[0].raid.stale], ['stale', true]);
  const fixed = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.deepEqual([fixed.json.raid.state, fixed.json.raid.stale], ['to_review', false]);
});

check('R2-4/5: the fake event starts in the past (the create route refuses a future event), and the README names DISCORD_REDIRECT_URI for a second local Worker', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'fake-sources.js'), 'utf8');
  const start = Number(/const EVENT_START = ([\d_]+);/.exec(source)[1].replace(/_/g, ''));
  assert(start * 1000 < Date.UTC(2026, 9, 1), 'EVENT_START is a fixed date before today');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert(/second local Worker[\s\S]{0,200}--var DISCORD_REDIRECT_URI:http:\/\/localhost:<port>\/auth\/callback/.test(readme));
});

// ---------------------------------------------------------------------------
// Fix round 3

check('R3-1: officer reasons and names (manual, decisions) reach only reviewers of the raid\'s team, in the raid detail and in every other view', async () => {
  const s = await raidWorld();
  s.w.advance(2 * 86_400_000);
  const made = await s.call('carol', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-03' });
  const manualId = made.json.raid.id;
  assert.equal((await s.call('carol', 'PUT', s.raid(manualId, '/manual'), { reason: 'Logger was off', presentPlayerIds: [s.p.aldric] })).status, 200);
  const { id, detail } = await fullRaid(s);
  const brindle = byName(detail).Brindle.playerId;
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Private reason', expectedFlags: ['no_show'] })).status, 200);
  assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/decisions/${brindle}`), { reason: 'Undo reason text' })).status, 200);
  assert.equal((await decide(s, 'bob', id, { playerId: brindle, outcome: 'bench', reason: 'Second private reason', expectedFlags: ['no_show'] })).status, 200);
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.fenwick}'`);
  const SECRETS = ['Logger was off', 'rivate reason', 'Undo reason text', 'Carol C', 'Dave D', '"bob"'];
  // dave (Team Lead of Bravo) and erin (a Member of Alpha) are not reviewers of Alpha.
  for (const who of ['dave', 'erin']) {
    const views = [
      (await s.call(who, 'GET', s.raid(manualId))).json,
      (await s.call(who, 'GET', s.raid(id))).json,
      (await s.call(who, 'GET', `/raids?team=${s.A}`)).json,
      (await s.call(who, 'GET', `/attendance/team?team=${s.A}&window=all`)).json,
      (await s.call(who, 'GET', `/attendance/person/${brindle}`)).json,
    ];
    const text = JSON.stringify(views);
    for (const secret of SECRETS) assert(!text.includes(secret), `${who} sees "${secret}"`);
    assert.deepEqual([views[0].raid.manual.reason, views[0].raid.manual.by], [null, null], who);
  }
  assert.equal((await s.call('dave', 'GET', s.raid(manualId))).json.raid.state, 'manual');
  // Reviewers of Alpha (an officer and Alpha's Team Lead) still get both.
  for (const who of ['bob', 'carol']) {
    const manual = (await s.call(who, 'GET', s.raid(manualId))).json.raid.manual;
    assert.deepEqual([manual.reason, manual.by], ['Logger was off', 'Carol C'], who);
    assert.equal(byName((await s.call(who, 'GET', s.raid(id))).json).Brindle.decision.reason, 'Second private reason');
  }
  // A Team Lead of Bravo reviews Bravo only: a Bravo raid's reason is hers to see, Alpha's is not.
  const bravo = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-05' });
  assert.equal((await s.call('bob', 'PUT', s.raid(bravo.json.raid.id, '/manual'), { reason: 'Bravo reason', presentPlayerIds: [s.p.wander] })).status, 200);
  assert.equal((await s.call('dave', 'GET', s.raid(bravo.json.raid.id))).json.raid.manual.reason, 'Bravo reason');
});

check('R3-2: every stale cause (policy change, stored fingerprint, failed recompute) is state "stale" in the detail and the list, for every viewer; a recalculation clears it', async () => {
  const s = await raidWorld();
  const { id, detail } = await fullRaid(s);
  assert.equal((await decide(s, 'bob', id, { playerId: byName(detail).Brindle.playerId, outcome: 'bench', reason: 'Told us', expectedFlags: ['no_show'] })).status, 200);
  const listRow = async (who = 'bob') => (await s.call(who, 'GET', `/raids?team=${s.A}`)).json.raids[0];
  const detailRaid = async (who = 'bob') => (await s.call(who, 'GET', s.raid(id))).json.raid;
  assert.deepEqual([(await listRow()).stale, (await listRow()).state], [false, 'to_review']);
  // A policy change: the stored state is "reviewed"-like, the live fingerprint differs.
  await s.call('bob', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 });
  for (const who of ['bob', 'erin']) {
    const row = await listRow(who);
    assert.deepEqual([row.state, row.stale], ['stale', true], `list, ${who}`);
    const one = await detailRaid(who);
    assert.deepEqual([one.state, one.stale], ['stale', true], `detail, ${who}`);
  }
  assert.deepEqual((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.stale, [id]);
  const fixed = await s.call('bob', 'POST', s.raid(id, '/recompute'), {});
  assert.deepEqual([fixed.json.raid.state, fixed.json.raid.stale], ['to_review', false]);
  // A recompute that never landed (empty fingerprint) and a fingerprint from another policy are stale too.
  exec(s.w, `UPDATE raids SET policy_fp = '' WHERE id = '${id}'`);
  assert.deepEqual([(await listRow()).state, (await detailRaid()).state], ['stale', 'stale']);
  exec(s.w, `UPDATE raids SET policy_fp = 'deadbeef' WHERE id = '${id}'`);
  assert.deepEqual([(await listRow()).state, (await listRow()).stale, (await detailRaid()).state], ['stale', true, 'stale']);
  // A raid with no log has no results to go stale.
  const empty = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-04' });
  assert.deepEqual([empty.json.raid.state, empty.json.raid.stale], ['awaiting_log', false]);
});

check('R3-3: POST /raids with reportSources only (no event, no date) takes the date from the first pull, and a failing source writes nothing', async () => {
  const s = await raidWorld();
  const first = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSources: [R1] });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.match(first.json.raid.raidOn, /^\d{4}-\d\d-\d\d$/);
  assert(first.json.pulls.length > 0 && first.json.sources.reports.length === 1);
  const before = await s.w.count('raids');
  const bad = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSources: [R3, 'Nope000000000009'] });
  assert(bad.status >= 400, JSON.stringify(bad.json));
  assert.equal(await s.w.count('raids'), before, 'no empty raid is left behind');
  assert.equal(await s.w.count('raid_reports'), 1);
});

check('R3-5: the fake sources have a character present from the first pull who misses only the last pull: Left early with its flag', async () => {
  const { createFakeSources } = require('./tools/fake-sources.js');
  const fake = createFakeSources({ serverId: SERVER_A });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  try {
    const s = await raidWorld();
    s.w.env.WCL_API_BASE = base;
    s.w.env.RAID_HELPER_API_BASE = base;
    const lastcall = await addPerson(s, 'bob', s.A, 'Lastcall');
    const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, reportSources: ['Fake000000000001', 'Fake000000000002'] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const row = byName(made.json).Lastcall;
    assert.equal(row.playerId, lastcall.person.id);
    assert.deepEqual([row.outcome, row.flags, row.pulls.missedFirst, row.pulls.missedLast], ['left_early', ['left_early'], false, true]);
    assert.equal(row.pulls.present, row.pulls.total - 1);
    assert.equal(row.needsReview, true);
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Future raids

const futureEvent = (s, id, offsetSeconds, signUps = eventSignUps(), extra = {}) => {
  const startTime = Math.floor(s.w.clock.now / 1000) + offsetSeconds;
  s.w.sources.events.set(id, rhEvent(id, SERVER_A, signUps, { startTime, ...extra }));
  return startTime;
};

check('future: a raid made by hand takes a guild-local start time, a zone from the version\'s list and a title, and is upcoming until it starts', async () => {
  const s = await raidWorld();
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-02-10', startTime: '20:00', zone: 'Karazhan', title: '  Prog night  ' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const raid = made.json.raid;
  assert.deepEqual(
    [raid.raidOn, raid.startsAt, raid.upcoming, raid.zone, raid.title, raid.state],
    ['2027-02-10', Date.parse('2027-02-11T01:00:00Z'), true, 'Karazhan', 'Prog night', 'awaiting_log'],
  );
  assert.equal((await s.call('bob', 'GET', s.raid(raid.id))).json.raid.upcoming, true);
  assert.equal(await s.w.count('attendance'), 0);
  const bad = [[{ startTime: '25:00' }, 'startTime'], [{ startTime: '8pm' }, 'startTime'], [{ zone: 'Nowhere' }, 'zone'], [{ title: 5 }, 'title'],
    [{ raidOn: '2027-03-14', startTime: '02:30' }, 'startTime']];
  for (const [extra, field] of bad) {
    const r = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-02-11', ...extra });
    assert.deepEqual([r.status, r.json.field], [400, field], JSON.stringify(extra));
  }
  assert.equal(await s.w.count('raids'), 1, 'a refused create writes nothing');
  // A past date with a time is not upcoming; without a time the raid sits at noon UTC; a blank title is no title.
  const past = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-05', startTime: '20:00', zone: 'Gruul\'s Lair', title: '   ' });
  assert.deepEqual([past.status, past.json.raid.upcoming, past.json.raid.title, past.json.raid.startsAt], [201, false, null, Date.parse('2027-01-06T01:00:00Z')]);
  const noTime = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-02-12' });
  assert.deepEqual([noTime.json.raid.startsAt, noTime.json.raid.zone], [Date.parse('2027-02-12T12:00:00Z'), null]);
  // The zone list follows the guild's game version.
  const classic = await scenario({ guildBody: { gameVersion: 'classic', realm: 'Mankrik' } });
  const wrongZone = await classic.call('alice', 'POST', '/raids', { teamId: classic.teamId, raidOn: '2027-02-10', zone: 'Karazhan' });
  assert.deepEqual([wrongZone.status, wrongZone.json.field], [400, 'zone']);
  const rightZone = await classic.call('alice', 'POST', '/raids', { teamId: classic.teamId, raidOn: '2027-02-10', zone: 'Molten Core' });
  assert.deepEqual([rightZone.status, rightZone.json.raid.zone], [201, 'Molten Core']);
});

check('future: the Worker\'s zone lists match the raid names of the three rules files', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  for (const file of ['catalog', 'tbc', 'classic', 'forever']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'rules', `${file}.js`), 'utf8'), sandbox);
  const { RAID_ZONES } = await load('worker/raid-zones.js');
  for (const version of ['tbc', 'classic', 'forever']) {
    const names = Object.values(sandbox.RulesData[version].raids).filter((raid) => raid.tier !== 'Planning templates').map((raid) => raid.name);
    assert.deepEqual(RAID_ZONES[version], names, version);
  }
});

check('future: the raid list answers upcoming raids (all of them, soonest first) apart from the paged past ones, with sign-up counts and plan status', async () => {
  const s = await raidWorld();
  const eventId = '555555555555555555';
  futureEvent(s, eventId, 2 * 86400);
  const later = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-03-01', startTime: '19:30', zone: 'Gruul\'s Lair' });
  const soon = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: eventId });
  assert.equal(soon.status, 201, JSON.stringify(soon.json));
  const otherTeam = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-02-20', startTime: '20:00' });
  const past = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-05' });
  const list = await s.call('bob', 'GET', `/raids?team=${s.A}`);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.deepEqual(list.json.upcoming.map((row) => row.id), [soon.json.raid.id, later.json.raid.id]);
  assert.deepEqual(list.json.raids.map((row) => [row.id, row.upcoming]), [[past.json.raid.id, false]]);
  assert(!list.json.upcoming.some((row) => row.id === otherTeam.json.raid.id), 'another team\'s raid is not on this list');
  const [first, second] = list.json.upcoming;
  assert.deepEqual(first.signups, { signed: 4, late: 0, bench: 1, tentative: 0, absence: 1 });
  assert.deepEqual([first.eventSourced, first.eventId, first.title, first.planned, first.upcoming], [true, eventId, 'Test Raid', false, true]);
  assert.deepEqual(second.signups, { signed: 0, late: 0, bench: 0, tentative: 0, absence: 0 });
  assert.deepEqual([second.eventSourced, second.eventId, second.title, second.zone, second.startsAt], [false, null, null, 'Gruul\'s Lair', Date.parse('2027-03-02T00:30:00Z')]);
  // A plan makes it Planned (and does not add to the sign-up counts).
  const planned = await s.call('bob', 'PUT', s.raid(soon.json.raid.id, '/plan'), { label: 'Prog', players: [{ name: 'Aldric', group: 1 }] });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const again = (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.upcoming[0];
  assert.deepEqual([again.planned, again.signups.signed], [true, 4]);
  // Paging the past leaves the upcoming list whole.
  const older = await s.call('bob', 'GET', `/raids?team=${s.A}&before=2027-01-05`);
  assert.deepEqual([older.json.raids.length, older.json.upcoming.length], [0, 2]);
  // Sign-up counts are for the people who may see the team's attendance.
  const dave = await s.call('dave', 'GET', `/raids?team=${s.A}`);
  if (dave.status === 200) assert.equal(dave.json.upcoming[0].signups, null);
});

check('future: re-importing the event refreshes the sign-ups and follows a reschedule on the same day; when the start passes the raid is past', async () => {
  const s = await raidWorld();
  const eventId = '555555555555555555';
  const start = futureEvent(s, eventId, 3600);
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: eventId });
  const id = made.json.raid.id;
  assert.deepEqual([made.json.raid.startsAt, made.json.sources.event.signups], [start * 1000, 6]);
  // A new sign-up and a start an hour later, still the same guild-local day.
  futureEvent(s, eventId, 7200, [...eventSignUps(), signUp(7, DID(7), 'Newcomer', 'Priest', 'Holy')]);
  const refreshed = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.deepEqual([refreshed.json.sources.event.signups, refreshed.json.raid.startsAt, refreshed.json.raid.upcoming], [7, (Math.floor(s.w.clock.now / 1000) + 7200) * 1000, true]);
  assert.equal((await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.upcoming[0].signups.signed, 5);
  // Moved to another day: the raid is asked first and keeps its date and time until the officer says yes (see the move checks below).
  futureEvent(s, eventId, 3 * 86400);
  const moved = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId });
  assert.deepEqual([moved.status, moved.json.error], [409, 'event_other_day']);
  const kept = (await s.call('bob', 'GET', s.raid(id))).json.raid;
  assert.deepEqual([kept.raidOn, kept.startsAt], ['2027-01-16', (Math.floor(s.w.clock.now / 1000) + 7200) * 1000]);
  // Time passes: the raid leaves Upcoming for Past and awaits its log.
  s.w.advance(3 * 3600 * 1000);
  const list = (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual([list.upcoming.length, list.raids.map((row) => [row.id, row.upcoming, row.state])], [0, [[id, false, 'awaiting_log']]]);
  assert.equal((await s.call('bob', 'GET', s.raid(id))).json.raid.upcoming, false);
});

// ---------------------------------------------------------------------------
// An event on another day than the raid: ask first, then move BOTH starts_at and raid_on

const raidRow = async (s, id) => (await s.w.rows('SELECT raid_on, starts_at, event_id, event_synced, version FROM raids WHERE id = ?', id))[0];

check('event on another day: a raid without a log is asked (409 event_other_day with the dates) and nothing changes; moveRaid: true moves starts_at AND raid_on', async () => {
  const s = await raidWorld();
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-20', startTime: '20:00' });
  const id = made.json.raid.id;
  const before = await raidRow(s, id);
  const eventId = '666666666666666666';
  const start = futureEvent(s, eventId, 3 * 86400); // 2027-01-19 07:00 New York: a day before the raid
  const asked = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId });
  assert.equal(asked.status, 409, JSON.stringify(asked.json));
  assert.deepEqual([asked.json.error, asked.json.eventStartsAt, asked.json.eventDate, asked.json.raidDate], ['event_other_day', start * 1000, '2027-01-19', '2027-01-20']);
  assert.match(asked.json.message, /2027-01-19/);
  assert.deepEqual(await raidRow(s, id), before, 'the raid row is untouched');
  assert.deepEqual([await s.w.count('raid_signups', 'raid_id = ?', id), await s.w.count('audit_log', "action = 'raid.event'")], [0, 0], 'no sign-ups imported, nothing audited');
  // An explicit no is the same as no flag.
  const no = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: false });
  assert.deepEqual([no.status, no.json.error], [409, 'event_other_day']);
  // Yes: the date and the time both follow the event, the sign-ups come in, the day is audited.
  const yes = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.deepEqual([yes.json.raid.raidOn, yes.json.raid.startsAt, yes.json.raid.upcoming, yes.json.sources.event.signups], ['2027-01-19', start * 1000, true, 6]);
  const after = await raidRow(s, id);
  assert.deepEqual([after.raid_on, after.starts_at, after.event_id, after.version > before.version], ['2027-01-19', start * 1000, eventId, true]);
  const audit = (await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'raid.event'")).map((r) => [JSON.parse(r.before), JSON.parse(r.after)]);
  assert.deepEqual(audit, [[{ event: false, raidOn: '2027-01-20' }, { eventId, signups: 6, raidOn: '2027-01-19' }]]);
  const list = (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual(list.upcoming.map((row) => [row.id, row.raidOn]), [[id, '2027-01-19']]);
  // The event the raid already follows moves again (a reschedule): the same question, the same yes.
  const later = futureEvent(s, eventId, 5 * 86400); // 2027-01-21
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId })).status, 409);
  const again = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: true });
  assert.deepEqual([again.status, again.json.raid.raidOn, again.json.raid.startsAt], [200, '2027-01-21', later * 1000]);
});

check('event on another day: the same guild-local day never asks (the start time follows as before), moveRaid or not; the guild time zone decides the day', async () => {
  const s = await raidWorld();
  // 2027-01-20 20:00 New York is 2027-01-21 01:00 UTC: the event is on the raid's date in the guild's zone, on the next one in UTC.
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-20', startTime: '19:00' });
  const id = made.json.raid.id;
  const eventId = '666666666666666666';
  const eveningStart = Date.parse('2027-01-21T01:00:00Z') / 1000;
  s.w.sources.events.set(eventId, rhEvent(eventId, SERVER_A, eventSignUps(), { startTime: eveningStart }));
  const same = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.deepEqual([same.json.raid.raidOn, same.json.raid.startsAt], ['2027-01-20', eveningStart * 1000]);
  // moveRaid on a same-day event changes nothing about the date either.
  const flagged = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: true });
  assert.deepEqual([flagged.status, flagged.json.raid.raidOn], [200, '2027-01-20']);
  assert.equal(await s.w.count('audit_log', "action = 'raid.event' AND after LIKE '%raidOn%'"), 0, 'no move, no raidOn in the audit');
});

check('event on another day: the team keeps one raid per day - a date it already has a raid on is 409 raid_date_taken; another team\'s raid there does not matter', async () => {
  const s = await raidWorld();
  const mine = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-20', startTime: '20:00' })).json.raid.id;
  const taken = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' })).json.raid.id;
  const otherTeam = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-19', startTime: '20:00' })).json.raid.id;
  const eventId = '666666666666666666';
  futureEvent(s, eventId, 3 * 86400); // 2027-01-19
  const before = await raidRow(s, mine);
  const refused = await s.call('bob', 'PUT', s.raid(mine, '/event'), { source: eventId, moveRaid: true });
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.deepEqual([refused.json.error, refused.json.raidId, refused.json.eventDate], ['raid_date_taken', taken, '2027-01-19']);
  assert.deepEqual(await raidRow(s, mine), before, 'nothing moved, nothing linked');
  assert.equal(await s.w.count('raid_signups', 'raid_id = ?', mine), 0);
  // Without the flag the answer is still the question, not the refusal (the refusal only follows a yes).
  assert.equal((await s.call('bob', 'PUT', s.raid(mine, '/event'), { source: eventId })).json.error, 'event_other_day');
  // The date is free once the other raid goes; the other team's raid on that date never blocked anything.
  assert.equal((await s.call('bob', 'DELETE', s.raid(taken))).status, 200);
  const moved = await s.call('bob', 'PUT', s.raid(mine, '/event'), { source: eventId, moveRaid: true });
  assert.deepEqual([moved.status, moved.json.raid.raidOn], [200, '2027-01-19']);
  assert.equal((await raidRow(s, otherTeam)).raid_on, '2027-01-19');
});

check('event on another day: a raid WITH a log keeps its date and time (no question, no move); the flag is validated', async () => {
  const s = await raidWorld();
  const { id } = await fullRaid(s);
  const before = await raidRow(s, id);
  const eventId = '666666666666666666';
  futureEvent(s, eventId, 3 * 86400);
  const linked = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  const after = await raidRow(s, id);
  assert.deepEqual([after.raid_on, after.starts_at, after.event_id], [before.raid_on, before.starts_at, eventId]);
  const flagged = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: true });
  assert.deepEqual([flagged.status, (await raidRow(s, id)).raid_on], [200, before.raid_on], 'moveRaid does not move a raid that has a log');
  const text = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: 'yes' });
  const number = await s.call('bob', 'PUT', s.raid(id, '/event'), { source: eventId, moveRaid: 1 });
  assert.deepEqual([text.status, text.json.field, number.status], [400, 'moveRaid', 400]);
});

check('event on another day: a move re-versions the raids of both dates and recalculates the old one (fill-ins follow the new neighbours)', async () => {
  const s = await raidWorld();
  const moving = (await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-20', startTime: '20:00' })).json.raid.id;
  const oldNeighbour = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-20', startTime: '20:00' })).json.raid.id;
  const newNeighbour = (await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-19', startTime: '20:00' })).json.raid.id;
  const eventId = '666666666666666666';
  futureEvent(s, eventId, 3 * 86400);
  const versions = async () => ({ old: (await raidRow(s, oldNeighbour)).version, next: (await raidRow(s, newNeighbour)).version });
  const before = await versions();
  assert.equal((await s.call('bob', 'PUT', s.raid(moving, '/event'), { source: eventId, moveRaid: true })).status, 200);
  const after = await versions();
  assert(after.old > before.old && after.next > before.next, `both neighbours are re-versioned: ${JSON.stringify([before, after])}`);
  assert.equal(await s.w.count('raids', "id = ? AND policy_fp = ''", oldNeighbour), 0, 'the old date was recalculated, not left stale');
  assert.equal(await s.w.count('raids', "id = ? AND policy_fp = ''", newNeighbour), 0, 'the new date was recalculated too');
});

check('future: manual attendance is refused until the raid has started (409 raid_not_started)', async () => {
  const s = await raidWorld();
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-16', startTime: '20:00' });
  const id = made.json.raid.id;
  const refused = await s.call('bob', 'PUT', s.raid(id, '/manual'), { reason: 'Voice chat only', presentPlayerIds: [] });
  assert.deepEqual([refused.status, refused.json.error], [409, 'raid_not_started']);
  assert.equal(await s.w.count('raids', "log_mode = 'manual'"), 0);
  s.w.advance(14 * 3600 * 1000);
  const allowed = await s.call('bob', 'PUT', s.raid(id, '/manual'), { reason: 'Voice chat only', presentPlayerIds: [] });
  assert.deepEqual([allowed.status, allowed.json.raid.upcoming, allowed.json.raid.state], [200, false, 'manual']);
});

// ---------------------------------------------------------------------------
// Planner seed and the plan's live link

check('planner seed: an Alt of the signed-up class, else the Main, else the Discord nickname; Absence/Bench keep their kind; only Raid-Helper rows', async () => {
  const s = await raidWorld();
  // Brindle (Warrior Main) has one Mage Alt; Cassia has two (none named like her nickname); Fenwick has two and one is named like his sign-up.
  assert.equal((await addAlt(s, 'bob', s.p.brindle, s.A, 'Brindlex')).status, 201);
  assert.equal((await addAlt(s, 'bob', s.p.cassia, s.A, 'Zedmage')).status, 201);
  assert.equal((await addAlt(s, 'bob', s.p.cassia, s.A, 'Aamage')).status, 201);
  assert.equal((await addAlt(s, 'bob', s.p.fenwick, s.A, 'Qmage')).status, 201);
  assert.equal((await addAlt(s, 'bob', s.p.fenwick, s.A, 'Zedfen')).status, 201);
  assert.equal((await addAlt(s, 'bob', s.p.dunmar, s.A, 'Dunmage')).status, 201);
  const eventId = '555555555555555555';
  s.w.sources.events.set(eventId, rhEvent(eventId, SERVER_A, [
    signUp(1, DID(1), 'Aldric', 'Warrior', 'Arms'),            // Main is a Warrior: the Main
    signUp(2, DID(2), 'Brindle', 'Mage', 'Fire'),              // one Mage Alt
    signUp(3, DID(3), 'Cassia', 'Mage', 'Frost'),              // two Mage Alts, none named like the nickname: first by name
    signUp(4, DID(4), 'Dunmar', 'Absence', undefined),         // no class: the Main, kind kept
    signUp(5, DID(5), 'Eliora', 'Bench', undefined),           // no class: the Main
    signUp(6, '299999999999999999', 'Stranger', 'Rogue', 'Combat'), // not on the roster: the Discord nickname
    signUp(7, DID(6), 'ZEDFEN', 'Mage', 'Arcane'),             // two Mage Alts, one named like the nickname (case-insensitive)
    signUp(8, DID(2), 'Brindle', 'Tank', 'Protection'),        // a Tank sign-up resolves its class from the spec: Warrior = the Main's class, so the Main
    signUp(9, DID(1), 'Aldric', 'Druid', 'Balance'),           // no Druid Alt: the Main
  ]));
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: eventId });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.raid.id;
  // A plan row is derived data and never part of the seed.
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/plan'), { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] })).status, 200);
  const res = await s.call('bob', 'GET', s.raid(id, '/planner'));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.signups.map((x) => [x.key, x.name, x.discordName, x.kind, x.className, x.specName, x.position]), [
    [1, 'Aldric', 'Aldric', 'signed', 'Warrior', 'Arms', 1],
    [2, 'Brindlex', 'Brindle', 'signed', 'Mage', 'Fire', 2],
    [3, 'Aamage', 'Cassia', 'signed', 'Mage', 'Frost', 3],
    [4, 'Dunmar', 'Dunmar', 'absence', 'Absence', null, 4],
    [5, 'Eliora', 'Eliora', 'bench', 'Bench', null, 5],
    [6, 'Stranger', 'Stranger', 'signed', 'Rogue', 'Combat', 6],
    [7, 'Zedfen', 'ZEDFEN', 'signed', 'Mage', 'Arcane', 7],
    [8, 'Brindle', 'Brindle', 'signed', 'Tank', 'Protection', 8],
    [9, 'Aldric', 'Aldric', 'signed', 'Druid', 'Balance', 9],
  ]);
  assert.deepEqual(res.json.signups.map((x) => x.personId === null), [false, false, false, false, false, true, false, false, false]);
  assert.equal(res.json.signups[0].personId, s.p.aldric);
  assert.deepEqual(res.json.raid, {
    id, raidOn: made.json.raid.raidOn, startsAt: made.json.raid.startsAt, title: 'Test Raid', zone: null, eventId, teamId: s.A, timeKnown: true, size: 25, sizeOverride: null, gameVersion: 'tbc', timeZone: NY,
  });
  assert.equal(res.json.livePlan, null);
  // A raid made by hand has no sign-ups and no event.
  const hand = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-03-01', startTime: '19:30', zone: 'Karazhan', title: 'Prog' });
  const empty = await s.call('bob', 'GET', s.raid(hand.json.raid.id, '/planner'));
  assert.deepEqual([empty.status, empty.json.signups, empty.json.raid.eventId, empty.json.raid.title, empty.json.raid.zone], [200, [], null, 'Prog', 'Karazhan']);
});

check('planner seed: needs raids.edit on the raid\'s team (403), the raid must be in this guild (404), signed out is 401', async () => {
  const s = await raidWorld();
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-03-01' });
  const id = made.json.raid.id;
  for (const [who, status] of [['bob', 200], ['alice', 200], ['carol', 200], ['dave', 403], ['erin', 403]]) {
    assert.equal((await s.call(who, 'GET', s.raid(id, '/planner'))).status, status, who);
  }
  assert.equal((await s.call('bob', 'GET', s.raid('r_missing', '/planner'))).status, 404);
  const other = await secondGuild(s);
  assert.equal((await s.w.call(other.frank, 'GET', `${other.path}/raids/${id}/planner`)).status, 404, 'another guild\'s raid id');
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}/raids/${id}/planner`)).status, 401);
});

check('plan live link: PUT stores the live id, PUT without it clears it, DELETE clears it; it is shown to editors only and must be a 7-character id', async () => {
  const s = await raidWorld();
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-03-01', startTime: '19:30' });
  const id = made.json.raid.id;
  const plan = { label: 'Prog plan', players: [{ name: 'Aldric', group: 1 }, { name: 'Brindle', group: 0 }] };
  const put = (body) => s.call('bob', 'PUT', s.raid(id, '/plan'), body);
  for (const live of ['short', 'toolonglive', 'ab-defg', 42, '']) {
    const refused = await put({ ...plan, live });
    // '' is not a link id either
    assert.deepEqual([refused.status, refused.json.field], [400, 'live'], JSON.stringify(live));
  }
  assert.equal(await s.w.count('raids', 'plan_live IS NOT NULL'), 0, 'a refused plan stores nothing');
  const stored = await put({ ...plan, live: 'Ab3dEfG' });
  assert.equal(stored.status, 200, JSON.stringify(stored.json));
  assert.equal(stored.json.raid.planLive, 'Ab3dEfG');
  assert.deepEqual((await s.w.rows('SELECT plan_live FROM raids WHERE id = ?', id)).map((r) => r.plan_live), ['Ab3dEfG']);
  assert.equal((await s.call('bob', 'GET', s.raid(id))).json.raid.planLive, 'Ab3dEfG');
  assert.equal((await s.call('bob', 'GET', s.raid(id, '/planner'))).json.livePlan, 'Ab3dEfG');
  assert.equal((await s.call('bob', 'GET', `/raids?team=${s.A}`)).json.upcoming.find((r) => r.id === id).planLive, 'Ab3dEfG');
  assert.equal((await s.call('erin', 'GET', s.raid(id))).json.raid.planLive, null, 'a member sees no live link');
  assert.equal((await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.upcoming.find((r) => r.id === id).planLive, null);
  const audit = await s.w.rows("SELECT after FROM audit_log WHERE action = 'raid.plan' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit[0].after), { players: 2, live: true });
  assert.equal(JSON.stringify(audit).includes('Ab3dEfG'), false, 'the link id is not written to the audit log');
  // A plan pasted as a long link or code carries no live id: it replaces the link.
  const replaced = await put(plan);
  assert.deepEqual([replaced.status, replaced.json.raid.planLive], [200, null]);
  assert.equal(await s.w.count('raids', 'plan_live IS NOT NULL'), 0);
  assert.equal((await put({ ...plan, live: 'Zz9Yy8X' })).json.raid.planLive, 'Zz9Yy8X');
  const removed = await s.call('bob', 'DELETE', s.raid(id, '/plan'), {});
  assert.deepEqual([removed.status, removed.json.raid.planLive, removed.json.sources.plan], [200, null, null]);
  assert.equal(await s.w.count('raids', 'plan_live IS NOT NULL OR plan_label IS NOT NULL'), 0);
  assert.equal((await s.call('erin', 'PUT', s.raid(id, '/plan'), { ...plan, live: 'Ab3dEfG' })).status, 403);
});

check('plannerName: a Main and an Alt that share the signed-up class -> the Main name; a different class -> the Alt; no Main -> the Discord nickname', async () => {
  const { plannerName } = await load('worker/routes/raids.js');
  const main = { name: 'Mainmage', class: 'MAGE', is_main: 1 };
  const alt = { name: 'Altmage', class: 'MAGE', is_main: 0 };
  const rogue = { name: 'Altrogue', class: 'ROGUE', is_main: 0 };
  const row = (className, specName) => ({ nickname: 'Nick', class_name: className, spec_name: specName });
  assert.equal(plannerName(row('Mage', 'Fire'), [alt, main, rogue]), 'Mainmage', 'Main and Alt share the signed-up class');
  assert.equal(plannerName(row('Mage', 'Fire'), [main, alt]), 'Mainmage');
  assert.equal(plannerName(row('Rogue', 'Combat'), [main, alt, rogue]), 'Altrogue');
  assert.equal(plannerName(row('Warlock', 'Destruction'), [main, alt, rogue]), 'Mainmage', 'no Alt of that class: the Main');
  assert.equal(plannerName(row('Mage', 'Fire'), [alt]), 'Nick', 'no Main: the Discord nickname');
  assert.equal(plannerName(row('Mage', 'Fire'), null), 'Nick', 'not on the roster: the Discord nickname');
});

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
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
