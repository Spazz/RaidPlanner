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
  const clock = { now: 1_800_100_800_000 }; // 2027-01-15T12:40Z (RH_START + 800 s)
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
// Erin, Gina (Members) sign in.
async function scenario({ teams = 1, guildBody = {}, who = ['bob', 'carol', 'dave', 'erin', 'gina'] } = {}) {
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
const RH_START = 1_800_100_000; // seconds: 2027-01-15T12:26:40Z, 07:26 in America/New_York
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
