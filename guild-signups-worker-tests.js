/**
 * Raidsmith guild tracker - native sign-ups + raid schedule Worker tests (Phase 6)
 * Run: node guild-signups-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord,
 * Raid-Helper and Warcraft Logs faked by an injected fetch. No network, no Wrangler, no credentials. Spec and the API as built:
 * tasks/guild-phase6-signups-spec.md.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  frank: { id: '110000000000000006', username: 'frank', globalName: 'Frank F' },
  gina: { id: '110000000000000007', username: 'gina', globalName: 'Gina G' },
  hank: { id: '110000000000000008', username: 'hank', globalName: 'Hank H' },
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
  const s = { events: new Map(), reports: new Map(), calls: [], wcl: { tokens: new Set(), tokenPosts: [] } };
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    s.calls.push({ url: String(url), method: init.method || 'GET', init });
    if (u.hostname === 'raid-helper.dev') {
      const match = /^\/api\/v4\/events\/(\d+)$/.exec(u.pathname);
      const event = match && s.events.get(match[1]);
      if (!event) return new Response('{}', { status: 404 });
      return Response.json(event);
    }
    const wcl = /^(www|classic|fresh)\.warcraftlogs\.com$/.exec(u.hostname);
    if (wcl) {
      if (u.pathname === '/oauth/token') {
        const token = `wcltok-${wcl[1]}-${s.wcl.tokenPosts.length + 1}`;
        s.wcl.tokenPosts.push(wcl[1]);
        s.wcl.tokens.add(token);
        return Response.json({ access_token: token, expires_in: 3600 });
      }
      if (u.pathname === '/api/v2/client') {
        const bearer = /^Bearer (.+)$/.exec(init.headers.Authorization || '');
        if (!bearer || !s.wcl.tokens.has(bearer[1])) return new Response('{}', { status: 401 });
        const payload = JSON.parse(init.body);
        const report = s.reports.has(payload.variables.code) ? s.reports.get(payload.variables.code) : null;
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
  const clock = { now: 1_800_100_800_000 }; // 2027-01-16T12:00Z, Saturday 07:00 in America/New_York (RH_START + 800 s)
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

// Alice (Guild Master) creates the guild; Bob (Officer), Carol (Team Lead of the first team), Dave (Team Lead of the second team) and
// Erin, Gina, Hank (Members) sign in.
async function scenario({ teams = 1, guildBody = {}, who = ['bob', 'carol', 'dave', 'erin', 'gina', 'hank'] } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const body = { ...GUILD_BODY, ...guildBody };
  if (teams > 1) { body.multipleTeams = true; body.teamNames = ['Alpha', 'Bravo', 'Charlie'].slice(0, teams); }
  const created = await w.call(alice, 'POST', '/api/guild', body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, alice, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  s.teamId = s.teams[0];
  for (const name of who) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  if (who.includes('bob')) assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  if (who.includes('carol')) assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.teams[0]] })).status, 200);
  if (who.includes('dave') && teams > 1) assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.teams[1]] })).status, 200);
  return s;
}

const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const addAlt = (s, who, pid, teamId, name, extra = {}) => s.call(who, 'POST', `/roster/${pid}/characters`, { name, class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId, makeMain: false, ...extra });

const exec = (w, sql) => w.db.sqlite.exec(sql);
const signUp = (id, userId, name, className, specName, position = id) => ({ id, userId, name, className, specName, status: 'primary', position });
const RH_START = 1_800_100_000; // seconds: 2027-01-16T11:46:40Z, Saturday 06:46 in America/New_York
const rhEvent = (id, serverId, signUps, extra = {}) => ({ id, serverId, title: 'Test Raid', startTime: RH_START, signUps, ...extra });
const DID = (n) => `2000000000000000${String(n).padStart(2, '0')}`;
const EVENT_ID = '111111111111111111';

// ---------------------------------------------------------------------------
// Fixtures for the attendance regression (the same shapes the attendance suite uses)

const R1 = 'Aaaa000000000001';
const R2 = 'Aaaa000000000002';

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

// ---------------------------------------------------------------------------
// Regression: the attendance a fixture raid ends up with does not depend on the native sign-up work

// Everything the consolidation wrote for a raid, in a stable order. Names, not ids, so the golden reads.
async function attendanceSnapshot(s, raidId) {
  const rows = await s.w.rows(
    `SELECT c.name, a.outcome, a.credit, a.signup_kind, a.attended, a.presence_source, a.flags, a.needs_review, a.pulls_present, a.pulls_total,
            a.missed_first, a.missed_last, a.via_raid_id IS NOT NULL AS via, a.credit_team_id IS NOT NULL AS hosted
       FROM attendance a JOIN characters c ON c.player_id = a.player_id AND c.is_main = 1 WHERE a.raid_id = ? ORDER BY c.name`, raidId,
  );
  const raid = (await s.w.rows('SELECT open_flags FROM raids WHERE id = ?', raidId))[0];
  return { openFlags: raid.open_flags, rows: rows.map((r) => [r.name, r.outcome, r.credit, r.signup_kind, r.attended, r.presence_source, r.flags, r.needs_review, r.pulls_present, r.pulls_total, r.missed_first, r.missed_last, r.via, r.hosted]) };
}

// Three raids that between them use every older source: an event + a report; an event + a report + a plan + a decision; a hand-entered
// raid with a plan. Returns the snapshots by label.
async function regressionRun() {
  const s = await raidWorld();
  const E2 = '222222222222222222';
  const E3 = '333333333333333333';
  const week = 7 * 86400;
  s.w.sources.events.set(E2, rhEvent(E2, SERVER_A, [
    signUp(1, DID(1), 'Aldric', 'Warrior', 'Arms'), signUp(2, DID(2), 'Brindle', 'Mage', 'Fire'), signUp(3, DID(3), 'Cassia', 'Late', 'Frost'),
    signUp(4, DID(4), 'Dunmar', 'Tentative', undefined), signUp(5, DID(5), 'Eliora', 'Priest', 'Holy'), signUp(7, DID(7), 'Wanderfell', 'Druid', 'Restoration'),
  ], { startTime: RH_START + week }));
  s.w.sources.reports.set(R2, report1({ startTime: (RH_START + week) * 1000 }));
  s.w.sources.events.set(E3, rhEvent(E3, SERVER_A, [
    signUp(1, DID(1), 'Aldric', 'Warrior', 'Arms'), signUp(2, DID(2), 'Brindle', 'Mage', 'Fire'), signUp(4, DID(4), 'Dunmar', 'Absence', undefined),
  ], { startTime: RH_START + 2 * week }));

  const snaps = {};
  // 1. event + report
  const one = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  assert.equal(one.status, 201, JSON.stringify(one.json));
  assert.equal((await s.call('bob', 'PUT', s.raid(one.json.raid.id, '/reports'), { source: R1 })).status, 200);
  snaps.eventAndReport = await attendanceSnapshot(s, one.json.raid.id);

  // 2. event + report + plan, and an officer decision on a flagged row
  const two = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: E2, reportSource: R2 });
  assert.equal(two.status, 201, JSON.stringify(two.json));
  const plan = await s.call('bob', 'PUT', s.raid(two.json.raid.id, '/plan'), {
    label: 'Plan', players: [{ name: 'Aldric', group: 1 }, { name: 'Brindle', group: 0 }, { name: 'Fenwick', group: 2 }, { name: 'Nobody', group: 3 }],
  });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  const flagged = plan.json.people.find((p) => p.needsReview);
  assert(flagged, 'a flagged row to decide');
  const decided = await s.call('bob', 'POST', s.raid(two.json.raid.id, '/decisions'), {
    playerId: flagged.playerId, outcome: 'present', reason: 'Was there, log missed it', expectedFlags: flagged.flags,
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.json));
  snaps.eventPlanDecision = await attendanceSnapshot(s, two.json.raid.id);

  // 3. an old raid with attendance entered by hand
  s.w.advance(3 * week * 1000);
  const three = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: E3 });
  assert.equal(three.status, 201, JSON.stringify(three.json));
  const manual = await s.call('bob', 'PUT', s.raid(three.json.raid.id, '/manual'), { reason: 'No log kept', presentPlayerIds: [s.p.aldric, s.p.fenwick] });
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  snaps.manual = await attendanceSnapshot(s, three.json.raid.id);
  return snaps;
}

check('REGRESSION: the attendance of fixture raids (event + report, + plan + decision, hand-entered) is exactly what it was before native sign-ups', async () => {
  const snaps = await regressionRun();
  if (process.env.SIGNUPS_PRINT_GOLDEN) console.log(JSON.stringify(snaps));
  assert.deepEqual(snaps, GOLDEN);
});

// The golden: recorded by this scenario on the commit before the sign-ups work (d3ebe18, 2026-10-17).
const GOLDEN = {
  eventAndReport: {
    openFlags: 4,
    rows: [
      ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
      ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
      ['Cassia', 'late', null, 'signed', 1, 'log', '["late"]', 1, 2, 3, 1, 0, 0, 0],
      ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
      ['Eliora', 'left_early', null, 'bench', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
      ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
      ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
    ],
  },
  eventPlanDecision: {
    openFlags: 3,
    rows: [
      ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
      ['Brindle', 'present', 1, 'signed', 0, 'log', '["no_show"]', 0, 0, 3, 0, 0, 0, 0],
      ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
      ['Dunmar', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
      ['Eliora', 'left_early', null, 'signed', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
      ['Fenwick', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
      ['Wanderfell', 'fill_in', 1, 'signed', 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
    ],
  },
  manual: {
    openFlags: 1,
    rows: [
      ['Aldric', 'present', 1, 'signed', 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
      ['Brindle', 'missed', 0, 'signed', 0, 'officer', '["no_show"]', 1, 0, 0, 0, 0, 0, 0],
      ['Cassia', 'no_signup', null, null, 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
      ['Dunmar', 'missed_notice', 0, 'absence', 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
      ['Eliora', 'no_signup', null, null, 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
      ['Fenwick', 'present', 1, null, 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
    ],
  },
};

// ---------------------------------------------------------------------------
// The sign-up world: two teams, members linked to their characters, one upcoming raid of team A
//   Erin   -> person Eliora (Priest, Holy/Discipline; Main on A), Mirabel (Hunter, alt on A), Wanderfell (Druid, alt on B)
//   Gina   -> person Gorrim (Paladin, Protection/Holy; Main on A)
//   Dave   -> Team Lead of B, no character (so no sign-up right on A)
//   Nodisc -> person with no Discord (Rogue, Main on A): only an officer can sign them up
const UPCOMING = '2027-02-02'; // a Tuesday, 17 days after the test clock (Saturday 2027-01-16)

async function signupWorld() {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  s.A = A; s.B = B;
  s.p = {};
  s.c = {};
  const person = async (key, teamId, name, extra, discord) => {
    const made = await addPerson(s, 'bob', teamId, name, extra);
    s.p[key] = made.person.id;
    if (discord) exec(s.w, `UPDATE players SET discord_user_id = '${discord}' WHERE id = '${made.person.id}'`);
    s.c[key] = (await s.w.rows('SELECT id FROM characters WHERE player_id = ? AND is_main = 1', made.person.id))[0].id;
  };
  const alt = async (key, pid, teamId, name, extra) => {
    const r = await addAlt(s, 'bob', pid, teamId, name, extra);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    s.c[key] = (await s.w.rows('SELECT id FROM characters WHERE name = ?', name))[0].id;
  };
  await person('eliora', A, 'Eliora', { class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Discipline' }, PEOPLE.erin.id);
  await alt('mirabel', s.p.eliora, A, 'Mirabel', { class: 'HUNTER', mainSpec: 'Marksmanship', offSpec: null });
  await alt('wanderfell', s.p.eliora, B, 'Wanderfell', { class: 'DRUID', mainSpec: 'Restoration', offSpec: null });
  await person('gorrim', A, 'Gorrim', { class: 'PALADIN', mainSpec: 'Protection', offSpec: 'Holy' }, PEOPLE.gina.id);
  await person('nodisc', A, 'Nodisc', { class: 'ROGUE', mainSpec: 'Combat', offSpec: null }, null);
  const raid = await s.call('bob', 'POST', '/raids', { teamId: A, raidOn: UPCOMING, startTime: '20:00' });
  assert.equal(raid.status, 201, JSON.stringify(raid.json));
  s.raidId = raid.json.raid.id;
  s.startsAt = raid.json.raid.startsAt;
  s.path = (route = '') => `/raids/${s.raidId}${route}`;
  s.mine = (body, who = 'erin') => s.call(who, 'PUT', s.path('/signup'), body);
  return s;
}

check('migration 0010: signups.self is a Member own_teams grant only; one Raidsmith sign-up per person per raid; a deleted person takes theirs; schedule rows are checked', async () => {
  const w = await makeWorld();
  const rows = await w.rows("SELECT role_id, scope FROM role_permissions WHERE action = 'signups.self'");
  assert.deepEqual(rows, [{ role_id: 'member', scope: 'own_teams' }]);
  const { ACTIONS } = await load('worker/permissions.js');
  assert(ACTIONS.includes('signups.self'));
  const s = await signupWorld();
  const columns = (await s.w.rows("SELECT name FROM pragma_table_info('raid_signups')")).map((r) => r.name);
  for (const c of ['character_id', 'note', 'updated_by', 'created_at', 'updated_at']) assert(columns.includes(c), c);
  assert.equal((await s.w.rows('SELECT signups_locked FROM raids WHERE id = ?', s.raidId))[0].signups_locked, 0);
  assert.deepEqual(await s.w.rows('SELECT schedule_weeks, schedule_auto FROM teams WHERE id = ?', s.A), [{ schedule_weeks: 2, schedule_auto: 0 }]);
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
  const dup = (id, pid) => `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${s.raidId}', 'raidsmith', ${id}, 'signed', 99, '${s.guildId}', '${pid}')`;
  assert.throws(() => exec(s.w, dup(99, s.p.eliora)), /UNIQUE/, 'one per person');
  assert.throws(() => exec(s.w, dup(1, s.p.gorrim)), /UNIQUE/, 'signup_id is part of the primary key');
  assert.throws(() => exec(s.w, `UPDATE raid_signups SET note = '${'x'.repeat(121)}' WHERE source = 'raidsmith'`), /CHECK/);
  assert.throws(() => exec(s.w, 'UPDATE raids SET signups_locked = 2'), /CHECK/);
  assert.throws(() => exec(s.w, 'UPDATE teams SET schedule_weeks = 9'), /CHECK/);
  assert.throws(() => exec(s.w, 'UPDATE teams SET schedule_weeks = 0'), /CHECK/);
  const slot = (id, values) => `INSERT INTO team_schedules (id, guild_id, team_id, weekday, start_time, created_at) VALUES ('${id}', '${s.guildId}', '${s.A}', ${values}, 1)`;
  assert.throws(() => exec(s.w, slot('ts_x', "7, '20:00'")), /CHECK/);
  assert.throws(() => exec(s.w, slot('ts_x', "2, '24:00'")), /CHECK/);
  assert.throws(() => exec(s.w, slot('ts_x', "2, '8:00'")), /CHECK/);
  exec(s.w, slot('ts_x', "2, '20:00'"));
  assert.throws(() => exec(s.w, slot('ts_y', "2, '21:00'")), /UNIQUE/, 'one slot per weekday');
  // The person goes, the Raidsmith sign-up goes with them; a Raid-Helper row only loses its link.
  exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, nickname) VALUES ('${s.raidId}', 'raid_helper', 5, 'signed', 5, '${s.guildId}', '${s.p.eliora}', 'E')`);
  assert.equal((await s.call('bob', 'DELETE', `/roster/${s.p.eliora}`, {})).status, 200);
  assert.deepEqual(await s.w.rows('SELECT source, player_id FROM raid_signups'), [{ source: 'raid_helper', player_id: null }]);
});

check('self: a member signs themselves up; defaults are the Main on the team and its main spec; the row holds no Discord ID or nickname', async () => {
  const s = await signupWorld();
  const put = await s.mine({ kind: 'signed' });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const row = (await s.w.rows("SELECT * FROM raid_signups WHERE source = 'raidsmith'"))[0];
  assert.deepEqual([row.kind, row.class_name, row.spec_name, row.character_id, row.player_id, row.note], ['signed', 'Priest', 'Holy', s.c.eliora, s.p.eliora, null]);
  assert.deepEqual([row.discord_user_id, row.nickname, row.updated_by === s.ids.erin, row.created_at > 0, row.updated_at === row.created_at], [null, null, true, true, true]);
  const v = put.json;
  assert.deepEqual(Object.keys(v).sort(), ['can', 'counts', 'entries', 'me', 'notices', 'raid', 'roster']);
  assert.deepEqual(v.raid, { id: s.raidId, teamId: s.A, startsAt: s.startsAt, timeKnown: true, upcoming: true, locked: false, closed: null, closesAt: s.startsAt, closeHours: 0, closeHoursOverride: null, size: 25, sizeOverride: null });
  assert.deepEqual(v.can, { edit: false, self: true, seeList: true, seeNicknames: false });
  assert.equal(v.roster, null, 'the officers\' picker is for officers');
  assert.deepEqual(v.me.characters.map((c) => [c.name, c.isMain]), [['Eliora', true], ['Mirabel', false]], 'only the characters on the raid\'s team, the Main first');
  assert.deepEqual(v.me.characters[0].specs, ['Holy', 'Discipline', 'Shadow'], 'main, off spec, then the rest of the class');
  assert.deepEqual([v.me.defaultCharacterId, v.me.canChange, v.me.closed, v.me.personId], [s.c.eliora, true, null, s.p.eliora]);
  assert.deepEqual(v.me.signup, v.entries[0]);
  assert.deepEqual(v.entries[0], {
    key: `p:${s.p.eliora}`, personId: s.p.eliora, source: 'raidsmith', kind: 'signed', name: 'Eliora', classId: 'PRIEST', className: 'Priest', spec: 'Holy', role: 'healer',
    characterId: s.c.eliora, note: null, updatedAt: row.updated_at, matched: true, isMe: true, nickname: null,
  });
  assert.deepEqual([v.counts.signed, v.counts.expected, v.counts.byRole.healer, v.counts.byClass], [1, 1, 1, { PRIEST: 1 }]);
});

check('self: change status, character, spec and note; a left-out field keeps what was chosen; delete takes the sign-up away', async () => {
  const s = await signupWorld();
  assert.equal((await s.mine({ kind: 'signed', characterId: s.c.mirabel, spec: 'Beast Mastery', note: '  back from AFK  ' })).status, 200);
  let rows = await s.w.rows("SELECT kind, class_name, spec_name, character_id, note, signup_id FROM raid_signups WHERE source = 'raidsmith'");
  assert.deepEqual(rows, [{ kind: 'signed', class_name: 'Hunter', spec_name: 'Beastmastery', character_id: s.c.mirabel, note: 'back from AFK', signup_id: 1 }]);
  // Status only: the character, spec and note stay.
  const late = await s.mine({ kind: 'late' });
  assert.equal(late.status, 200, JSON.stringify(late.json));
  rows = await s.w.rows("SELECT kind, spec_name, character_id, note, signup_id FROM raid_signups WHERE source = 'raidsmith'");
  assert.deepEqual(rows.map((r) => [r.kind, r.spec_name, r.character_id, r.note, r.signup_id]), [['late', 'Beastmastery', s.c.mirabel, 'back from AFK', 1]]);
  assert.equal(late.json.entries.length, 1, 'still one sign-up per person');
  assert.deepEqual([late.json.entries[0].name, late.json.entries[0].spec, late.json.entries[0].role, late.json.entries[0].note], ['Mirabel', 'Beast Mastery', 'ranged', 'back from AFK']);
  // null clears the note and the spec.
  assert.equal((await s.mine({ kind: 'tentative', spec: null, note: null })).status, 200);
  rows = await s.w.rows("SELECT kind, spec_name, note FROM raid_signups WHERE source = 'raidsmith'");
  assert.deepEqual(rows, [{ kind: 'tentative', spec_name: null, note: null }]);
  // Another character without a spec: that character's main spec.
  assert.equal((await s.mine({ kind: 'signed', characterId: s.c.eliora })).status, 200);
  assert.equal((await s.w.rows("SELECT spec_name FROM raid_signups WHERE source = 'raidsmith'"))[0].spec_name, 'Holy');
  const del = await s.call('erin', 'DELETE', s.path('/signup'), {});
  assert.equal(del.status, 200);
  assert.deepEqual([del.json.entries, del.json.me.signup, del.json.counts.signed], [[], null, 0]);
  assert.equal(await s.w.count('raid_signups'), 0);
  const again = await s.call('erin', 'DELETE', s.path('/signup'), {});
  assert.deepEqual([again.status, again.json.error], [404, 'not_found']);
});

check('self: the input is checked - kind, character, spec, note', async () => {
  const s = await signupWorld();
  const refused = async (body, field) => {
    const r = await s.mine(body);
    assert.deepEqual([r.status, r.json.field], [400, field], JSON.stringify([body, r.json]));
  };
  await refused({}, 'kind');
  await refused({ kind: 'bench' }, 'kind');           // Bench is an officer's call
  await refused({ kind: 'maybe' }, 'kind');
  await refused({ kind: 5 }, 'kind');
  await refused({ kind: 'signed', characterId: 'nope' }, 'characterId');
  await refused({ kind: 'signed', characterId: s.c.wanderfell }, 'characterId'); // her alt on the other team
  await refused({ kind: 'signed', characterId: s.c.gorrim }, 'characterId');     // someone else's
  await refused({ kind: 'signed', spec: 'Fury' }, 'spec');                       // not a Priest spec
  await refused({ kind: 'signed', spec: 7 }, 'spec');
  await refused({ kind: 'signed', note: 'x'.repeat(121) }, 'note');
  await refused({ kind: 'signed', note: 5 }, 'note');
  assert.equal(await s.w.count('raid_signups'), 0, 'nothing was written');
  const ok = await s.mine({ kind: 'signed', note: 'x'.repeat(120) });
  assert.equal(ok.status, 200);
  const clean = await s.mine({ kind: 'signed', note: 'a‮b\u0007c​d ' });
  assert.equal(clean.json.entries[0].note, 'abcd', 'control and direction characters are stripped');
  const repeat = await s.mine({ kind: 'signed', characterId: s.c.eliora, spec: 'Discipline' });
  assert.equal(repeat.json.entries[0].spec, 'Discipline');
});

// ---------------------------------------------------------------------------
// The window, the lock, who may do what

check('window: members cannot change a sign-up once the raid has started, or while it is locked; officers can; the statement re-checks the window', async () => {
  const s = await signupWorld();
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
  // Locked by an officer.
  const lock = await s.call('bob', 'POST', s.path('/signups/lock'), {});
  assert.equal(lock.status, 200, JSON.stringify(lock.json));
  assert.deepEqual([lock.json.raid.locked, lock.json.raid.closed], [true, 'locked']);
  const refused = await s.mine({ kind: 'late' });
  assert.deepEqual([refused.status, refused.json.error, refused.json.reason], [409, 'signups_closed', 'locked']);
  const del = await s.call('erin', 'DELETE', s.path('/signup'), {});
  assert.deepEqual([del.status, del.json.reason], [409, 'locked']);
  const seen = await s.call('erin', 'GET', s.path('/signups'));
  assert.deepEqual([seen.json.me.canChange, seen.json.me.closed, seen.json.raid.locked], [false, 'locked', true]);
  assert.equal((await s.w.rows("SELECT kind FROM raid_signups WHERE source = 'raidsmith'"))[0].kind, 'signed', 'nothing changed');
  // An officer still can, and unlocking opens it again.
  assert.equal((await s.call('bob', 'PUT', s.path(`/signups/${s.p.eliora}`), { kind: 'tentative' })).status, 200);
  const unlock = await s.call('carol', 'POST', s.path('/signups/unlock'), {});
  assert.deepEqual([unlock.status, unlock.json.raid.locked, unlock.json.raid.closed], [200, false, null]);
  assert.equal((await s.mine({ kind: 'late' })).status, 200);
  // The start time closes it.
  s.w.clock.now = s.startsAt - 1;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200, 'the last millisecond is still open');
  s.w.clock.now = s.startsAt;
  const started = await s.mine({ kind: 'absence' });
  assert.deepEqual([started.status, started.json.error, started.json.reason], [409, 'signups_closed', 'started']);
  assert.deepEqual((await s.call('erin', 'DELETE', s.path('/signup'), {})).json.reason, 'started');
  const view = await s.call('erin', 'GET', s.path('/signups'));
  assert.deepEqual([view.json.raid.upcoming, view.json.me.canChange, view.json.me.closed], [false, false, 'started']);
  const officer = await s.call('bob', 'PUT', s.path(`/signups/${s.p.nodisc}`), { kind: 'signed' });
  assert.equal(officer.status, 200, 'officers are not bound by the start');
  assert.equal((await s.call('bob', 'DELETE', s.path(`/signups/${s.p.nodisc}`), {})).status, 200);
  // The window is checked in the write statement itself: a lock that lands between the read and the write wins.
  s.w.clock.now = 1_800_100_800_000;
  const real = s.w.db.batch;
  s.w.db.batch = function patched(statements) {
    if (statements.some((statement) => /INSERT INTO raid_signups/.test(statement.sql))) exec(s.w, 'UPDATE raids SET signups_locked = 1');
    return real.call(this, statements);
  };
  const raced = await s.mine({ kind: 'signed', note: 'raced' });
  s.w.db.batch = real;
  assert.deepEqual([raced.status, raced.json.reason], [409, 'locked']);
  assert.equal(await s.w.count('raid_signups', "note = 'raced'"), 0);
});

check('permissions: every sign-up route x role; signed out is 401, another guild\'s raid is 404', async () => {
  const s = await signupWorld();
  const status = async (who, method, route, body) => (await s.call(who, method, s.path(route), body)).status;
  const person = s.p.nodisc;
  const matrix = [
    // route, body, then who gets what: alice (Guild Master), bob (Officer), carol (Team Lead A), dave (Team Lead B), erin / gina (Members with a character on A), hank (Member, none)
    ['GET', '/signups', undefined, { alice: 200, bob: 200, carol: 200, dave: 200, erin: 200, gina: 200, hank: 200 }],
    ['GET', '/signup', undefined, { alice: 403, bob: 403, carol: 403, dave: 403, erin: 200, gina: 200, hank: 403 }],
    ['PUT', '/signup', { kind: 'signed' }, { alice: 403, bob: 403, carol: 403, dave: 403, erin: 200, gina: 200, hank: 403 }],
    ['PUT', `/signups/${person}`, { kind: 'bench' }, { alice: 200, bob: 200, carol: 200, dave: 403, erin: 403, gina: 403, hank: 403 }],
    ['DELETE', `/signups/${person}`, {}, { alice: 200, bob: 200, carol: 200, dave: 403, erin: 403, gina: 403, hank: 403 }],
    ['POST', '/signups/lock', {}, { alice: 200, bob: 200, carol: 200, dave: 403, erin: 403, gina: 403, hank: 403 }],
    ['POST', '/signups/unlock', {}, { alice: 200, bob: 200, carol: 200, dave: 403, erin: 403, gina: 403, hank: 403 }],
    ['DELETE', '/signup', {}, { alice: 403, bob: 403, carol: 403, dave: 403, erin: 200, gina: 200, hank: 403 }],
  ];
  for (const [method, route, body, expected] of matrix) {
    for (const [who, want] of Object.entries(expected)) {
      // The officer rows need a Raidsmith sign-up to remove.
      if (method === 'DELETE' && route.startsWith('/signups/')) await s.call('bob', 'PUT', s.path(route), { kind: 'signed' });
      assert.equal(await status(who, method, route, body), want, `${who} ${method} ${route}`);
    }
  }
  // Signed out.
  for (const [method, route, body] of matrix) {
    const r = await s.w.call(newJar(), method, `${s.guildPath}${s.path(route)}`, body);
    assert.equal(r.status, 401, `signed out ${method} ${route}`);
  }
  // A Member sees the list only of a team they have a character on (the same rule as attendance).
  const dave = await s.call('dave', 'GET', s.path('/signups'));
  assert.deepEqual([dave.json.can.seeList, dave.json.entries, dave.json.counts, dave.json.me], [false, null, null, null]);
  assert.deepEqual([(await s.call('hank', 'GET', s.path('/signups'))).json.entries], [null]);
  assert.equal((await s.call('gina', 'GET', s.path('/signups'))).json.can.seeList, true);
  // Another guild's raid is a 404, not data.
  const other = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const created = await s.w.call(other, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other' });
  const otherPath = `/api/guild/${created.json.guild.id}`;
  for (const [method, route, body] of matrix) {
    const r = await s.w.call(other, method, `${otherPath}${s.path(route)}`, body);
    assert([403, 404].includes(r.status), `${method} ${route} on another guild's raid: ${r.status}`);
    if (r.status === 404) assert.equal(r.json.error, 'not_found');
  }
  assert.equal((await s.w.call(other, 'PUT', `${otherPath}${s.path('/signup')}`, { kind: 'signed' })).status, 404);
  assert.equal((await s.w.call(s.jars.erin, 'GET', `/api/guild/${created.json.guild.id}/raids/${s.raidId}/signups`)).status, 403, 'a member of another server');
  // A malformed id is a plain 404.
  assert.equal((await s.call('erin', 'GET', '/raids/not-an-id/signups')).status, 404);
  assert.equal((await s.call('bob', 'PUT', s.path('/signups/not-a-person'), { kind: 'signed' })).status, 404);
});

check('officer: adds, changes and removes anyone\'s sign-up, any character of the person, Bench allowed; audited without free text; a person of another guild or no person is a 404', async () => {
  const s = await signupWorld();
  const put = (who, pid, body) => s.call(who, 'PUT', s.path(`/signups/${pid}`), body);
  // A person with no Discord, signed up by the team lead.
  const nodisc = await put('carol', s.p.nodisc, { kind: 'bench', note: 'standby' });
  assert.equal(nodisc.status, 200, JSON.stringify(nodisc.json));
  const entry = nodisc.json.entries.find((e) => e.personId === s.p.nodisc);
  assert.deepEqual([entry.name, entry.kind, entry.spec, entry.role, entry.note, entry.isMe], ['Nodisc', 'bench', 'Combat', 'melee', 'standby', false]);
  const row = (await s.w.rows("SELECT kind, updated_by FROM raid_signups WHERE player_id = ?", s.p.nodisc))[0];
  assert.deepEqual([row.kind, row.updated_by], ['bench', s.ids.carol]);
  // Any character of the person, even on another team.
  const wander = await put('bob', s.p.eliora, { kind: 'signed', characterId: s.c.wanderfell });
  assert.equal(wander.status, 200, JSON.stringify(wander.json));
  assert.deepEqual(wander.json.entries.find((e) => e.personId === s.p.eliora).name, 'Wanderfell');
  assert.equal((await put('bob', s.p.eliora, { kind: 'signed', characterId: s.c.gorrim })).json.field, 'characterId', 'not the person\'s character');
  assert.equal((await put('bob', s.p.eliora, { kind: 'cheering' })).json.field, 'kind');
  // The officer's picker lists the team's people with every character.
  const view = wander.json;
  assert.deepEqual(view.roster.map((p) => p.name), ['Eliora', 'Gorrim', 'Nodisc']);
  assert.deepEqual(view.roster[0].characters.map((c) => [c.name, c.teamId === s.B]), [['Eliora', false], ['Mirabel', false], ['Wanderfell', true]]);
  assert.deepEqual(view.can, { edit: true, self: false, seeList: true, seeNicknames: true });
  // Not a person of this guild.
  const ghost = 'p_AAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual([(await put('bob', ghost, { kind: 'signed' })).status, (await put('bob', ghost, { kind: 'signed' })).json.error], [404, 'not_found']);
  const other = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const created = await s.w.call(other, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other' });
  const foreign = await s.w.call(other, 'POST', `/api/guild/${created.json.guild.id}/roster`, mainBody(created.json.teams[0].id, 'Stranger'));
  assert.equal((await put('bob', foreign.json.person.id, { kind: 'signed' })).status, 404, 'a person of another guild');
  // Remove: only a Raidsmith sign-up can be removed.
  const gone = await s.call('bob', 'DELETE', s.path(`/signups/${s.p.nodisc}`), {});
  assert.deepEqual([gone.status, gone.json.entries.some((e) => e.personId === s.p.nodisc)], [200, false]);
  const again = await s.call('bob', 'DELETE', s.path(`/signups/${s.p.nodisc}`), {});
  assert.deepEqual([again.status, again.json.error], [404, 'not_found']);
  // Audit: who did what to which person, never the note or a name.
  const audit = await s.w.rows("SELECT action, entity_type, entity_id, actor_user_id, before, after FROM audit_log WHERE action LIKE 'signup.%' ORDER BY created_at, rowid");
  assert.deepEqual(audit.map((a) => a.action), ['signup.set', 'signup.set', 'signup.remove']);
  assert(audit.every((a) => a.entity_type === 'raid' && a.entity_id === s.raidId));
  assert.deepEqual(JSON.parse(audit[0].after), { personId: s.p.nodisc, kind: 'bench' });
  assert(!audit.some((a) => /standby|Nodisc|Eliora/.test(`${a.before}${a.after}`)), 'no note, no name');
  // A member's own change is not in the log (it is theirs to make).
  await s.mine({ kind: 'signed' });
  assert.equal(await s.w.count('audit_log', "action LIKE 'signup.%'"), 3);
  const lock = await s.call('bob', 'POST', s.path('/signups/lock'), {});
  assert.equal(lock.status, 200);
  const lockRow = (await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'signup.lock'"))[0];
  assert.deepEqual([JSON.parse(lockRow.before), JSON.parse(lockRow.after)], [{ locked: false }, { locked: true }]);
});

// ---------------------------------------------------------------------------
// Raid-Helper too: the merge by person, the attendance, the Planner seed, the Raids list

// A Raid-Helper event 20 days ahead on the same team: Erin (Priest Holy), Gina (Absence), a stranger on no roster (Rogue Combat).
const UP_EVENT = '444444444444444444';
async function withEvent(s) {
  s.w.sources.events.set(UP_EVENT, rhEvent(UP_EVENT, SERVER_A, [
    signUp(11, PEOPLE.erin.id, 'Erin-nick', 'Priest', 'Holy', 1),
    signUp(12, PEOPLE.gina.id, 'Gina-nick', 'Absence', undefined, 2),
    signUp(13, '299999999999999999', 'Stranger', 'Rogue', 'Combat', 3),
  ], { startTime: RH_START + 20 * 86400 }));
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: UP_EVENT });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  s.raidId = made.json.raid.id;
  return made.json;
}

check('merge: a person\'s Raidsmith sign-up replaces their Raid-Helper row in the list, the counts and the names; unmatched Raid-Helper rows stay', async () => {
  const s = await signupWorld();
  await withEvent(s);
  // Before any native sign-up the list is the event's, named by the roster (the Planner's rule), nicknames for officers only.
  const officer = await s.call('bob', 'GET', s.path('/signups'));
  const names = (v) => v.entries.map((e) => [String(e.name), e.kind, e.source].join('|')).sort();
  assert.deepEqual(names(officer.json), ['Eliora|signed|raid_helper', 'Gorrim|absence|raid_helper', 'Stranger|signed|raid_helper']);
  const member = await s.call('erin', 'GET', s.path('/signups'));
  assert.deepEqual(names(member.json), ['Eliora|signed|raid_helper', 'Gorrim|absence|raid_helper', 'null|signed|raid_helper'], 'a member never sees the nickname of an unmatched sign-up');
  assert(!JSON.stringify(member.json).includes('Stranger') && !JSON.stringify(member.json).includes('Erin-nick'));
  assert.deepEqual(officer.json.entries.map((e) => e.nickname).sort(), ['Erin-nick', 'Gina-nick', 'Stranger'], 'officers (roster.edit) see the nicknames');
  assert.deepEqual(member.json.me.signup, member.json.entries.find((e) => e.isMe), 'the Raid-Helper row of the viewer is theirs');
  // Erin says Late on a different character, here.
  const late = await s.mine({ kind: 'late', characterId: s.c.mirabel });
  assert.equal(late.status, 200, JSON.stringify(late.json));
  assert.equal(late.json.entries.length, 3, 'still three people');
  assert.deepEqual(names(late.json), ['Gorrim|absence|raid_helper', 'Mirabel|late|raidsmith', 'null|signed|raid_helper']);
  assert.deepEqual([late.json.counts.signed, late.json.counts.late, late.json.counts.absence, late.json.counts.expected], [1, 1, 1, 2]);
  assert.deepEqual(late.json.counts.byRole, { tank: 0, healer: 0, melee: 1, ranged: 1, none: 0 });
  assert.deepEqual(late.json.counts.byClass, { HUNTER: 1, ROGUE: 1 });
  assert.equal(await s.w.count('raid_signups'), 4, 'both are stored: the Raid-Helper row is only outranked');
  // Taking the Raidsmith sign-up back shows the Raid-Helper row again.
  const back = await s.call('erin', 'DELETE', s.path('/signup'), {});
  assert.deepEqual(back.json.entries.find((e) => e.personId === s.p.eliora).source, 'raid_helper');
  // An officer overrides someone's Raid-Helper row; unmatched rows have no person and nobody can override them.
  const override = await s.call('bob', 'PUT', s.path(`/signups/${s.p.gorrim}`), { kind: 'signed', spec: 'Holy' });
  assert.deepEqual(override.json.entries.find((e) => e.personId === s.p.gorrim).kind, 'signed');
  assert.equal(override.json.entries.filter((e) => e.personId === s.p.gorrim).length, 1);
  assert.equal(override.json.entries.find((e) => e.personId === null).name, 'Stranger');
  // A Raid-Helper refresh leaves the Raidsmith rows alone.
  await s.mine({ kind: 'tentative' });
  assert.equal((await s.call('bob', 'PUT', s.path('/event'), { source: UP_EVENT })).status, 200);
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith'"), 2);
  const after = await s.call('bob', 'GET', s.path('/signups'));
  assert.deepEqual([after.json.entries.find((e) => e.personId === s.p.eliora).kind, after.json.entries.find((e) => e.personId === s.p.eliora).source], ['tentative', 'raidsmith']);
  // The raid detail (the attendance pages\' view) lists both sources and says whether it is locked.
  const detail = await s.call('bob', 'GET', s.path());
  assert.deepEqual([...new Set(detail.json.signups.map((x) => x.source))].sort(), ['raid_helper', 'raidsmith']);
  assert.equal(detail.json.raid.signupsLocked, false);
  assert.equal(detail.json.signups.find((x) => x.source === 'raidsmith').nickname, null);
});

check('attendance: a Raidsmith sign-up counts like any other and replaces the person\'s Raid-Helper row; removing them all gives back exactly the recorded results', async () => {
  const s = await raidWorld();
  const created = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID });
  const id = created.json.raid.id;
  assert.equal((await s.call('bob', 'PUT', s.raid(id, '/reports'), { source: R1 })).status, 200);
  assert.deepEqual(await attendanceSnapshot(s, id), GOLDEN.eventAndReport);
  const put = (key, body) => s.call('bob', 'PUT', s.raid(id, `/signups/${s.p[key]}`), body);
  // Brindle signed up on Raid-Helper and did not come (Missed, flagged); now she told us here she cannot make it.
  const absent = await put('brindle', { kind: 'absence' });
  assert.equal(absent.status, 200, JSON.stringify(absent.json));
  let rows = Object.fromEntries((await attendanceSnapshot(s, id)).rows.map((r) => [r[0], r]));
  assert.deepEqual([rows.Brindle[1], rows.Brindle[2], rows.Brindle[3], rows.Brindle[6]], ['missed_notice', 0, 'absence', '[]']);
  assert.equal((await attendanceSnapshot(s, id)).openFlags, 3, 'her no-show flag is gone');
  // Fenwick had no sign-up (No sign-up); a Raidsmith one makes him expected, so staying away is a no-show.
  await put('fenwick', { kind: 'signed' });
  rows = Object.fromEntries((await attendanceSnapshot(s, id)).rows.map((r) => [r[0], r]));
  assert.deepEqual([rows.Fenwick[1], rows.Fenwick[3], rows.Fenwick[6]], ['missed', 'signed', '["no_show"]']);
  // Dunmar's Raid-Helper Absence is replaced by Bench: full credit.
  await put('dunmar', { kind: 'bench' });
  rows = Object.fromEntries((await attendanceSnapshot(s, id)).rows.map((r) => [r[0], r]));
  assert.deepEqual([rows.Dunmar[1], rows.Dunmar[2], rows.Dunmar[3]], ['bench', 1, 'bench']);
  // Cassia signed up on time but arrived late: the sign-up "Late" makes that fine (the policy's lateSignup rule), and it replaced "signed".
  await put('cassia', { kind: 'late' });
  rows = Object.fromEntries((await attendanceSnapshot(s, id)).rows.map((r) => [r[0], r]));
  assert.deepEqual([rows.Cassia[1], rows.Cassia[2], rows.Cassia[3], rows.Cassia[6]], ['present', 1, 'late', '[]']);
  // The detail (and the review) agree.
  const detail = await s.call('bob', 'GET', s.raid(id));
  assert.equal(detail.json.people.find((p) => p.name === 'Dunmar').signup, 'bench');
  assert.equal(detail.json.raid.state, 'to_review');
  // All four removed: the results are the ones recorded before the work.
  for (const key of ['brindle', 'fenwick', 'dunmar', 'cassia']) assert.equal((await s.call('bob', 'DELETE', s.raid(id, `/signups/${s.p[key]}`), {})).status, 200);
  assert.deepEqual(await attendanceSnapshot(s, id), GOLDEN.eventAndReport);
  // A member cannot touch a raid that has started: Erin is Aldric here, and the raid is past.
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.aldric}'`);
  const closed = await s.call('erin', 'PUT', s.raid(id, '/signup'), { kind: 'absence' });
  assert.deepEqual([closed.status, closed.json.reason], [409, 'started']);
  assert.deepEqual(await attendanceSnapshot(s, id), GOLDEN.eventAndReport);
});

check('attendance: the plan is a third source - a Raidsmith Absence does not beat a plan placement (the strongest kind still wins across sources), only the Raid-Helper row is replaced', async () => {
  const s = await raidWorld();
  const created = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT_ID, reportSource: R1 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.raid.id;
  await s.call('bob', 'PUT', s.raid(id, '/plan'), { label: 'P', players: [{ name: 'Brindle', group: 1 }] });
  const absent = await s.call('bob', 'PUT', s.raid(id, `/signups/${s.p.brindle}`), { kind: 'absence' });
  assert.equal(absent.status, 200);
  const row = (await attendanceSnapshot(s, id)).rows.find((r) => r[0] === 'Brindle');
  assert.deepEqual([row[1], row[3]], ['missed', 'signed'], 'the plan placement (signed) outranks Absence, as it did against a Raid-Helper Absence');
});

check('planner seed: Raidsmith sign-ups in Raid-Helper words, named by the chosen character; the Raid-Helper rows of those people are left out', async () => {
  const s = await signupWorld();
  await withEvent(s);
  await s.mine({ kind: 'late', characterId: s.c.mirabel, spec: 'Beast Mastery' });
  await s.mine({ kind: 'signed', characterId: s.c.gorrim }, 'gina').then((r) => assert.equal(r.status, 200));
  await s.call('bob', 'PUT', s.path(`/signups/${s.p.nodisc}`), { kind: 'bench' });
  const seed = await s.call('bob', 'GET', s.path('/planner'));
  assert.equal(seed.status, 200, JSON.stringify(seed.json));
  const rows = seed.json.signups.map((x) => [x.name, x.personId === null ? null : x.personId.slice(0, 2), x.kind, x.className, x.specName, String(x.key).startsWith('rs')]);
  assert.deepEqual(rows, [
    ['Mirabel', 'p_', 'late', 'Late', 'Beastmastery', true],
    ['Gorrim', 'p_', 'signed', 'Paladin', 'Protection1', true],
    ['Stranger', null, 'signed', 'Rogue', 'Combat', false],
    ['Nodisc', 'p_', 'bench', 'Bench', 'Combat', true],
  ]);
  // Gina's Raid-Helper Absence row was replaced by her Raidsmith sign-up, Erin's by hers; only Stranger's remains as Raid-Helper's.
  assert.equal(seed.json.signups.filter((x) => !String(x.key).startsWith('rs')).length, 1);
  assert.deepEqual(seed.json.signups.find((x) => x.name === 'Stranger'), { key: 13, name: 'Stranger', discordName: 'Stranger', personId: null, className: 'Rogue', specName: 'Combat', kind: 'signed', position: 3 });
  assert.equal(seed.json.signups.find((x) => x.name === 'Mirabel').discordName, null, 'a Raidsmith row has no Discord name');
  // The same words the Planner reads from an event: Absence stays a meta class.
  await s.call('bob', 'PUT', s.path(`/signups/${s.p.gorrim}`), { kind: 'absence' });
  const absent = (await s.call('bob', 'GET', s.path('/planner'))).json.signups.find((x) => x.name === 'Gorrim');
  assert.deepEqual([absent.className, absent.specName, absent.kind], ['Absence', 'Protection1', 'absence']);
  assert.equal((await s.call('erin', 'GET', s.path('/planner'))).status, 403, 'still for those who may edit the raid');
});

check('list: upcoming rows count the merged sign-ups, say what the viewer signed up as, whether they may, and carry the schedule for editors', async () => {
  const s = await signupWorld();
  await withEvent(s);
  const list = (who) => s.call(who, 'GET', `/raids?team=${s.A}`);
  const row = (json) => json.upcoming.find((r) => r.id === s.raidId); // the event's raid sorts after the world's hand-made one
  const before = (await list('erin')).json;
  assert.deepEqual(row(before).signups, { signed: 2, late: 0, standby: 0, tentative: 0, bench: 0, absence: 1 });
  assert.deepEqual(row(before).mine, { kind: 'signed', source: 'raid_helper', characterName: null }, 'her Raid-Helper row');
  assert.deepEqual([row(before).signupsOpen, row(before).locked, before.can], [true, false, { edit: false, signup: true }]);
  assert.deepEqual(before.upcoming.map((r) => r.id).length, 2);
  assert.equal(before.upcoming.find((r) => r.id !== s.raidId).mine, null);
  assert.equal(before.schedule, null, 'the schedule is for those who edit');
  await s.mine({ kind: 'late', characterId: s.c.mirabel });
  await s.call('bob', 'PUT', s.path(`/signups/${s.p.nodisc}`), { kind: 'bench' });
  const after = row((await list('erin')).json);
  assert.deepEqual(after.signups, { signed: 1, late: 1, standby: 0, tentative: 0, bench: 1, absence: 1 }, 'Erin is counted once, as Late');
  assert.deepEqual(after.mine, { kind: 'late', source: 'raidsmith', characterName: 'Mirabel' });
  // Someone with no character on the team: no counts, nothing to click.
  const hank = (await list('hank')).json;
  assert.deepEqual([row(hank).signups, row(hank).mine, hank.can.signup], [null, null, false]);
  // Gina has not signed up (her Raid-Helper row is an Absence): her chip says so.
  assert.deepEqual(row((await list('gina')).json).mine, { kind: 'absence', source: 'raid_helper', characterName: null });
  // The editors get the schedule summary; closing sign-ups shows.
  await s.call('carol', 'POST', s.path('/signups/lock'), {});
  const carol = (await list('carol')).json;
  assert.deepEqual([carol.schedule, row(carol).locked, row(carol).signupsOpen], [{ slots: 0, weeks: 2, auto: false }, true, false]);
  const dave = (await list('dave')).json;
  assert.deepEqual([dave.schedule, dave.can], [null, { edit: false, signup: false }]);
  // Past raids are unchanged: no sign-up fields.
  assert.equal((await list('bob')).json.raids.length, 0);
});

// ---------------------------------------------------------------------------
// The weekly schedule and "Create upcoming raids"

const slotBody = (weekday, startTime, extra = {}) => ({ weekday, startTime, ...extra });
const TUE = 2;
const THU = 4;
const SAT = 6;
const SUN = 0;

async function scheduleWorld(opts) {
  const s = await scenario({ teams: 2, ...(opts || {}) });
  [s.A, s.B] = s.teams;
  s.sched = (team = s.A, route = '') => `/teams/${team}/schedule${route}`;
  s.putSchedule = (body, who = 'bob', team = s.A) => s.call(who, 'PUT', s.sched(team), body);
  s.fill = (body = {}, who = 'bob', team = s.A) => s.call(who, 'POST', s.sched(team, '/raids'), body);
  return s;
}

check('schedule: save and read the weekly slots; replace-all; weeks and auto are kept when left out; audited by counts only', async () => {
  const s = await scheduleWorld();
  const empty = await s.call('erin', 'GET', s.sched());
  assert.equal(empty.status, 200, 'any member reads it');
  assert.deepEqual([empty.json.slots, empty.json.weeks, empty.json.auto, empty.json.can, empty.json.timeZone], [[], 2, false, { edit: false }, 'America/New_York']);
  assert(empty.json.zones.includes('Karazhan') && !empty.json.zones.includes('Molten Core'), 'the zones of the guild\'s game version');
  assert.deepEqual(empty.json.team, { id: s.A, name: 'Alpha', archived: false });
  const saved = await s.putSchedule({
    slots: [slotBody(THU, '20:30'), slotBody(TUE, '20:00', { zone: 'Karazhan', title: '  Progression night  ' })], weeks: 3, auto: true,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.slots.map((x) => [x.weekday, x.startTime, x.zone, x.title]), [[TUE, '20:00', 'Karazhan', 'Progression night'], [THU, '20:30', null, null]], 'soonest weekday first');
  assert(saved.json.slots.every((x) => /^ts_[A-Za-z0-9_-]{22}$/.test(x.id)));
  assert.deepEqual([saved.json.weeks, saved.json.auto, saved.json.can], [3, true, { edit: true }]);
  assert.deepEqual((await s.call('erin', 'GET', s.sched())).json.slots, saved.json.slots);
  // Replace-all, and weeks / auto stay when the body leaves them out.
  const again = await s.putSchedule({ slots: [slotBody(SAT, '19:00')] });
  assert.deepEqual([again.json.slots.map((x) => x.weekday), again.json.weeks, again.json.auto], [[SAT], 3, true]);
  assert.equal(await s.w.count('team_schedules'), 1);
  const cleared = await s.putSchedule({ slots: [], auto: false });
  assert.deepEqual([cleared.status, cleared.json.slots, cleared.json.auto, cleared.json.weeks], [200, [], false, 3]);
  // The other team has its own.
  assert.deepEqual((await s.call('bob', 'GET', s.sched(s.B))).json.slots, []);
  // Audit: counts, never titles.
  await s.putSchedule({ slots: [slotBody(TUE, '20:00', { title: 'Secret title' })] });
  const audit = await s.w.rows("SELECT action, entity_type, entity_id, before, after FROM audit_log WHERE action = 'schedule.update' ORDER BY rowid");
  assert.equal(audit.length, 4);
  assert(audit.every((a) => a.entity_type === 'team' && a.entity_id === s.A));
  assert.deepEqual([JSON.parse(audit[0].before), JSON.parse(audit[0].after)], [{ slots: 0, weeks: 2, auto: false, signupCloseHours: 0 }, { slots: 2, weeks: 3, auto: true, signupCloseHours: 0 }]);
  assert(!audit.some((a) => /Secret|Progression/.test(`${a.before}${a.after}`)));
});

check('schedule: who may save it, and the input is checked slot by slot', async () => {
  const s = await scheduleWorld();
  const ok = { slots: [slotBody(TUE, '20:00')] };
  const status = async (who, team) => (await s.putSchedule(ok, who, team)).status;
  assert.deepEqual([await status('alice'), await status('bob'), await status('carol'), await status('carol', s.B), await status('dave', s.B), await status('dave', s.A), await status('erin'), await status('hank')],
    [200, 200, 200, 403, 200, 403, 403, 403]);
  assert.equal((await s.w.call(newJar(), 'PUT', `${s.guildPath}${s.sched()}`, ok)).status, 401);
  assert.equal((await s.call('bob', 'PUT', '/teams/t_AAAAAAAAAAAAAAAAAAAAAA/schedule', ok)).status, 404);
  const other = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const created = await s.w.call(other, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other' });
  assert.equal((await s.w.call(other, 'PUT', `/api/guild/${created.json.guild.id}${s.sched()}`, ok)).status, 404, 'another guild\'s team id');
  assert.equal((await s.w.call(other, 'GET', `/api/guild/${created.json.guild.id}${s.sched()}`)).status, 404);
  const refused = async (body, field, slotField) => {
    const r = await s.putSchedule(body);
    assert.equal(r.status, 400, JSON.stringify([body, r.json]));
    assert.equal(r.json.field, field, JSON.stringify(r.json));
    if (slotField) assert.equal(r.json.slotField, slotField, JSON.stringify(r.json));
    return r.json;
  };
  await refused({}, 'slots');
  await refused({ slots: 'Tuesday' }, 'slots');
  await refused({ slots: Array.from({ length: 8 }, (_, i) => slotBody(i % 7, '20:00')) }, 'slots');
  await refused({ slots: [null] }, 'slots');
  assert.equal((await refused({ slots: [slotBody(TUE, '20:00'), slotBody(THU, '20:00'), { weekday: 7, startTime: '20:00' }] }, 'slots', 'weekday')).index, 2);
  await refused({ slots: [slotBody(-1, '20:00')] }, 'slots', 'weekday');
  await refused({ slots: [slotBody(1.5, '20:00')] }, 'slots', 'weekday');
  await refused({ slots: [slotBody('2', '20:00')] }, 'slots', 'weekday');
  await refused({ slots: [slotBody(TUE, '20:00'), slotBody(TUE, '21:00')] }, 'slots', 'weekday'); // one raid per day
  for (const time of ['24:00', '8:00', '20:60', '20', '', 2000, null]) await refused({ slots: [slotBody(TUE, time)] }, 'slots', 'startTime');
  await refused({ slots: [slotBody(TUE, '20:00', { zone: 'Molten Core' })] }, 'slots', 'zone');
  await refused({ slots: [slotBody(TUE, '20:00', { zone: 5 })] }, 'slots', 'zone');
  await refused({ slots: [slotBody(TUE, '20:00', { title: 'x'.repeat(101) })] }, 'slots', 'title');
  await refused({ slots: [slotBody(TUE, '20:00', { title: 7 })] }, 'slots', 'title');
  await refused({ slots: [], weeks: 0 }, 'weeks');
  await refused({ slots: [], weeks: 9 }, 'weeks');
  await refused({ slots: [], weeks: '2' }, 'weeks');
  await refused({ slots: [], weeks: 1.5 }, 'weeks');
  await refused({ slots: [], auto: 'yes' }, 'auto');
  const clean = await s.putSchedule({ slots: [slotBody(TUE, '20:00', { zone: '', title: 'a‮b\u0007c' })], weeks: 8 });
  assert.deepEqual([clean.json.slots[0].zone, clean.json.slots[0].title, clean.json.weeks], [null, 'abc', 8]);
  const full = await s.putSchedule({ slots: Array.from({ length: 7 }, (_, i) => slotBody(i, '18:00')) });
  assert.equal(full.json.slots.length, 7, 'a slot every day is allowed');
  // An archived team cannot be changed or filled.
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true })).status, 200);
  const archived = await s.putSchedule(ok, 'bob', s.B);
  assert.deepEqual([archived.status, archived.json.error], [409, 'team_archived']);
});

check('fill: the next N weeks of slots become upcoming raids; a date the team already has is kept; running again creates nothing', async () => {
  const s = await scheduleWorld();
  // The test clock is Saturday 2027-01-16 07:00 in New York. A hand-made raid already sits on Thursday the 21st.
  const hand = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-21', startTime: '19:00', title: 'Hand made' });
  assert.equal(hand.status, 201, JSON.stringify(hand.json));
  // Team B has a raid on Tuesday the 19th (another team's raid is not this team's).
  const bravo = await s.call('bob', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-19', startTime: '19:00' });
  assert.equal(bravo.status, 201);
  const none = await s.fill();
  assert.deepEqual([none.status, none.json.error], [409, 'no_schedule']);
  await s.putSchedule({ slots: [slotBody(TUE, '20:00', { zone: 'Karazhan', title: 'Prog' }), slotBody(THU, '20:00'), slotBody(SAT, '06:00')] });
  const first = await s.fill();
  assert.equal(first.status, 200, JSON.stringify(first.json));
  // Window: Jan 16 .. Jan 29. Tue 19, Thu 21 (exists), Sat 23, Tue 26, Thu 28; Sat 16 06:00 has started already.
  assert.deepEqual(first.json.created.map((x) => x.raidOn), ['2027-01-19', '2027-01-23', '2027-01-26', '2027-01-28']);
  assert.deepEqual(first.json.skipped.map((x) => [x.raidOn, x.reason]), [['2027-01-16', 'past'], ['2027-01-21', 'exists']]);
  assert.equal(first.json.skipped[1].raidId, hand.json.raid.id);
  assert.deepEqual([first.json.weeks, first.json.today], [2, '2027-01-16']);
  // Tuesday 20:00 in New York is 01:00Z the next day (EST).
  assert.deepEqual(first.json.created[0], { raidId: first.json.created[0].raidId, raidOn: '2027-01-19', startsAt: Date.parse('2027-01-20T01:00:00Z'), zone: 'Karazhan', title: 'Prog' });
  assert.equal(first.json.created[1].startsAt, Date.parse('2027-01-23T11:00:00Z'), 'Saturday 06:00');
  const list = (await s.call('bob', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual(list.upcoming.map((x) => [x.raidOn, x.title, x.zone]), [
    ['2027-01-19', 'Prog', 'Karazhan'], ['2027-01-21', 'Hand made', null], ['2027-01-23', null, null], ['2027-01-26', 'Prog', 'Karazhan'], ['2027-01-28', null, null],
  ]);
  assert.deepEqual(list.schedule, { slots: 3, weeks: 2, auto: false });
  const row = (await s.w.rows('SELECT log_mode, open_flags, policy_fp, version, created_by, team_id, event_id FROM raids WHERE id = ?', first.json.created[0].raidId))[0];
  assert.deepEqual(row, { log_mode: 'log', open_flags: 0, policy_fp: '', version: 1, created_by: s.ids.bob, team_id: s.A, event_id: null });
  // Team B's raid on the 19th sees a neighbour appear: it is marked for recalculation.
  const bravoRow = (await s.w.rows('SELECT policy_fp, version FROM raids WHERE id = ?', bravo.json.raid.id))[0];
  assert.equal(bravoRow.version, 2);
  // Idempotent: nothing is created twice.
  const second = await s.fill();
  assert.deepEqual(second.json.created, []);
  assert.deepEqual(second.json.skipped.map((x) => [x.raidOn, x.reason]), [['2027-01-16', 'past'], ['2027-01-19', 'exists'], ['2027-01-21', 'exists'], ['2027-01-23', 'exists'], ['2027-01-26', 'exists'], ['2027-01-28', 'exists']]);
  assert.equal(await s.w.count('raids', 'team_id = ?', s.A), 5);
  // More weeks on request (and the team's own number is the default).
  const more = await s.fill({ weeks: 3 });
  assert.deepEqual(more.json.created.map((x) => x.raidOn), ['2027-01-30', '2027-02-02', '2027-02-04']);
  assert.equal(more.json.weeks, 3);
  await s.putSchedule({ slots: [slotBody(TUE, '20:00')], weeks: 8 });
  const eight = await s.fill();
  assert.equal(eight.json.weeks, 8);
  assert.deepEqual(eight.json.created.map((x) => x.raidOn).slice(-2), ['2027-03-02', '2027-03-09']);
  // One audit row per fill that created something, with dates only.
  const audit = await s.w.rows("SELECT entity_id, after FROM audit_log WHERE action = 'schedule.fill' ORDER BY rowid");
  assert.equal(audit.length, 3);
  assert.deepEqual(JSON.parse(audit[0].after), { weeks: 2, dates: ['2027-01-19', '2027-01-23', '2027-01-26', '2027-01-28'] });
  assert(audit.every((a) => a.entity_id === s.A));
  assert.equal((await s.w.rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'raid.create'"))[0].n, 2, 'only the two hand-made raids; a filled raid is not a hand-made one');
});

check('fill: permissions, weeks, archived teams and two officers pressing the button at once', async () => {
  const s = await scheduleWorld();
  await s.putSchedule({ slots: [slotBody(TUE, '20:00'), slotBody(THU, '20:00')] });
  for (const [who, team, want] of [['erin', s.A, 403], ['hank', s.A, 403], ['dave', s.A, 403], ['carol', s.B, 403]]) {
    assert.equal((await s.fill({}, who, team)).status, want, `${who} on ${team}`);
  }
  assert.equal((await s.w.call(newJar(), 'POST', `${s.guildPath}${s.sched(s.A, '/raids')}`, {})).status, 401);
  for (const weeks of [0, 9, '2', 1.5, null]) assert.deepEqual([(await s.fill({ weeks })).status, (await s.fill({ weeks })).json.field], [400, 'weeks'], String(weeks));
  assert.equal(await s.w.count('raids'), 0, 'nothing was created');
  const [one, two] = await Promise.all([s.fill({}, 'bob'), s.fill({}, 'carol')]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  const dates = await s.w.rows('SELECT raid_on FROM raids WHERE team_id = ? ORDER BY raid_on', s.A);
  assert.deepEqual(dates.map((r) => r.raid_on), ['2027-01-19', '2027-01-21', '2027-01-26', '2027-01-28'], 'each date once');
  assert.equal(one.json.created.length + two.json.created.length, 4, 'every raid is reported by exactly one of the two');
  // Carol leads team A: she fills A and nothing else; dave leads B.
  await s.putSchedule({ slots: [slotBody(SUN, '18:00')] }, 'dave', s.B);
  const dave = await s.fill({}, 'dave', s.B);
  assert.deepEqual(dave.json.created.map((x) => x.raidOn), ['2027-01-17', '2027-01-24']);
  // An archived team is not filled.
  await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true });
  const archived = await s.fill({}, 'bob', s.B);
  assert.deepEqual([archived.status, archived.json.error], [409, 'team_archived']);
});

check('fill: dates and times are the guild\'s own (daylight saving, a zone ahead of UTC), checked on the pure planner and through the route', async () => {
  const { planScheduledRaids } = await load('worker/schedule-plan.js');
  const plan = (slots, today, nowIso, timeZone, weeks = 2) => planScheduledRaids({ slots, today, weeks, now: Date.parse(nowIso), timeZone })
    .map((x) => [x.raidOn, x.startsAt === null ? null : new Date(x.startsAt).toISOString().slice(0, 16), x.skip]);
  const NY = 'America/New_York';
  // Spring forward: Sunday 2027-03-14, 02:00 -> 03:00. 20:00 the week before is EST, that evening EDT.
  assert.deepEqual(plan([{ weekday: SUN, startTime: '20:00' }], '2027-03-08', '2027-03-08T12:00:00Z', NY), [['2027-03-14', '2027-03-15T00:00', null], ['2027-03-21', '2027-03-22T00:00', null]]);
  assert.deepEqual(plan([{ weekday: SUN, startTime: '20:00' }], '2027-03-01', '2027-03-01T12:00:00Z', NY, 2), [['2027-03-07', '2027-03-08T01:00', null], ['2027-03-14', '2027-03-15T00:00', null]]);
  // The wall time that does not exist is skipped, the next week's is fine.
  assert.deepEqual(plan([{ weekday: SUN, startTime: '02:30' }], '2027-03-08', '2027-03-08T12:00:00Z', NY), [['2027-03-14', null, 'no_such_time'], ['2027-03-21', '2027-03-21T06:30', null]]);
  // Fall back: Sunday 2027-11-07, 01:30 happens twice; the first one (EDT) is taken.
  assert.deepEqual(plan([{ weekday: SUN, startTime: '01:30' }], '2027-11-01', '2027-11-01T12:00:00Z', NY), [['2027-11-07', '2027-11-07T05:30', null], ['2027-11-14', '2027-11-14T06:30', null]]);
  // Ahead of UTC: Berlin Saturday 23:30 is 22:30Z that day; Auckland Monday 00:30 is the Sunday before in UTC; the guild's date is the local one.
  assert.deepEqual(plan([{ weekday: SAT, startTime: '23:30' }], '2027-01-18', '2027-01-18T12:00:00Z', 'Europe/Berlin'), [['2027-01-23', '2027-01-23T22:30', null], ['2027-01-30', '2027-01-30T22:30', null]]);
  assert.deepEqual(plan([{ weekday: 1, startTime: '00:30' }], '2027-01-18', '2027-01-17T10:00:00Z', 'Pacific/Auckland'), [['2027-01-18', '2027-01-17T11:30', null], ['2027-01-25', '2027-01-24T11:30', null]]);
  // Today's slot counts only while it has not started; the edge is the start itself.
  assert.deepEqual(plan([{ weekday: TUE, startTime: '20:00' }], '2027-01-19', '2027-01-20T01:00:00Z', NY, 1), [['2027-01-19', '2027-01-20T01:00', 'past']]);
  assert.deepEqual(plan([{ weekday: TUE, startTime: '20:00' }], '2027-01-19', '2027-01-20T00:59:59Z', NY, 1), [['2027-01-19', '2027-01-20T01:00', null]]);
  // Two slots, soonest date first; eight weeks hold 56 days.
  assert.deepEqual(plan([{ weekday: THU, startTime: '20:00' }, { weekday: TUE, startTime: '21:00' }], '2027-01-16', '2027-01-16T12:00:00Z', NY, 1).map((x) => x[0]), ['2027-01-19', '2027-01-21']);
  assert.equal(plan([{ weekday: TUE, startTime: '20:00' }], '2027-01-16', '2027-01-16T12:00:00Z', NY, 8).length, 8);
  // Through the route, in a guild whose date is ahead of UTC: 12:00Z on the 16th is already Sunday the 17th in Auckland.
  const s = await scheduleWorld({ guildBody: { timeZone: 'Pacific/Auckland' } });
  await s.putSchedule({ slots: [slotBody(SUN, '20:00')] });
  const filled = await s.fill({ weeks: 1 });
  assert.equal(filled.status, 200, JSON.stringify(filled.json));
  assert.deepEqual([filled.json.today, filled.json.created.map((x) => x.raidOn), new Date(filled.json.created[0].startsAt).toISOString()], ['2027-01-17', ['2027-01-17'], '2027-01-17T07:00:00.000Z']);
  assert.equal((await s.w.rows('SELECT raid_on FROM raids'))[0].raid_on, '2027-01-17');
});

check('Delete my data: the notes an account wrote on sign-ups go, the sign-up stays with the guild and holds no Discord ID', async () => {
  const s = await signupWorld();
  await s.mine({ kind: 'signed', note: 'running late maybe' });
  await s.call('bob', 'PUT', s.path(`/signups/${s.p.nodisc}`), { kind: 'bench', note: 'officer note' });
  const del = await s.w.call(s.jars.erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const rows = await s.w.rows("SELECT player_id, note, updated_by, discord_user_id, nickname, kind FROM raid_signups WHERE source = 'raidsmith' ORDER BY signup_id");
  assert.deepEqual(rows, [
    { player_id: s.p.eliora, note: null, updated_by: null, discord_user_id: null, nickname: null, kind: 'signed' },
    { player_id: s.p.nodisc, note: 'officer note', updated_by: s.ids.bob, discord_user_id: null, nickname: null, kind: 'bench' },
  ]);
  assert.equal((await s.w.rows('SELECT discord_user_id FROM players WHERE id = ?', s.p.eliora))[0].discord_user_id, null, 'the person is unlinked from the account');
});

// ---------------------------------------------------------------------------
// Races and budgets

// Counts D1 calls (statement first/all/run and batch) made inside fn.
async function counted(w, fn) {
  const proto = Object.getPrototypeOf(w.db.prepare('SELECT 1'));
  const saved = { first: proto.first, all: proto.all, run: proto.run, batch: w.db.batch };
  const count = { d1: 0 };
  const wrap = (original) => function wrapped(...args) { count.d1++; return original.apply(this, args); };
  proto.first = wrap(saved.first); proto.all = wrap(saved.all); proto.run = wrap(saved.run);
  w.db.batch = function batch(...args) { count.d1++; return saved.batch.apply(this, args); };
  try { await fn(); } finally {
    Object.assign(proto, { first: saved.first, all: saved.all, run: saved.run });
    w.db.batch = saved.batch;
  }
  return count;
}

check('races: two people signing up at once get their own sign-up id; one person pressing twice keeps one row', async () => {
  const s = await signupWorld();
  const [a, b] = await Promise.all([s.mine({ kind: 'signed' }), s.mine({ kind: 'signed' }, 'gina')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual((await s.w.rows("SELECT signup_id, player_id FROM raid_signups WHERE source = 'raidsmith' ORDER BY signup_id")).map((r) => r.signup_id), [1, 2]);
  const twice = await Promise.all([s.mine({ kind: 'late' }), s.mine({ kind: 'tentative' }), s.mine({ kind: 'absence' })]);
  assert.deepEqual(twice.map((r) => r.status), [200, 200, 200]);
  assert.equal(await s.w.count('raid_signups', "player_id = ?", s.p.eliora), 1);
});

check('budgets: D1 calls per sign-up route stay at the measured numbers', async () => {
  const s = await signupWorld();
  const calls = async (fn) => (await counted(s.w, fn)).d1;
  // The session, the central write limit and the guild context are in every number; the view is one batch.
  const view = await calls(() => s.call('erin', 'GET', s.path('/signups')));
  const put = await calls(() => s.mine({ kind: 'signed' }));
  const del = await calls(() => s.call('erin', 'DELETE', s.path('/signup'), {}));
  const officer = await calls(() => s.call('bob', 'PUT', s.path(`/signups/${s.p.nodisc}`), { kind: 'bench' }));
  const list = await calls(() => s.call('erin', 'GET', `/raids?team=${s.A}`));
  const lock = await calls(() => s.call('bob', 'POST', s.path('/signups/lock'), {}));
  const sched = await calls(() => s.call('erin', 'GET', `/teams/${s.A}/schedule`));
  assert.deepEqual({ view, put, del, officer, list, lock, sched }, BUDGET);
});

// Measured 2026-10-17. Session + context + raid are in every number; a write adds the central write limit, two reads and the write batch; the view is one batch.
const BUDGET = { view: 4, put: 8, del: 7, officer: 7, list: 3, lock: 6, sched: 4 };

// ---------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2] || '';
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack || error).toString().split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
}
main();
