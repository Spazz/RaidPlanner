/**
 * Raidsmith guild tracker - PM wave 2 Worker tests.
 * Run: node guild-wave2-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord, Raid-Helper and
 * Warcraft Logs faked by an injected fetch and the clock injected. No network, no Wrangler, no credentials, no real time.
 *
 * The first check is the GOLDEN attendance regression, recorded on the UNCHANGED base (70907c8) before any wave-2 work: with no away
 * notices, no standby sign-ups and no other new feature used, every attendance result must stay byte-identical. Later lanes of the wave
 * append their own checks above the runner at the bottom; they do not edit the golden (a deliberate change to attendance is a decision,
 * and re-recording is `WAVE2_PRINT_GOLDEN=1 node guild-wave2-worker-tests.js`).
 */
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';

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
// Harness (copied from guild-signups-worker-tests.js so this file stands alone; keep it at the top)

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

// Same as the snapshot in guild-signups-worker-tests.js: everything the consolidation wrote for a raid, in a stable order. Names, not ids.
async function attendanceSnapshot(s, raidId) {
  const rows = await s.w.rows(
    `SELECT c.name, a.outcome, a.credit, a.signup_kind, a.attended, a.presence_source, a.flags, a.needs_review, a.pulls_present, a.pulls_total,
            a.missed_first, a.missed_last, a.via_raid_id IS NOT NULL AS via, a.credit_team_id IS NOT NULL AS hosted
       FROM attendance a JOIN characters c ON c.player_id = a.player_id AND c.is_main = 1 WHERE a.raid_id = ? ORDER BY c.name`, raidId,
  );
  const raid = (await s.w.rows('SELECT open_flags FROM raids WHERE id = ?', raidId))[0];
  return { openFlags: raid.open_flags, rows: rows.map((r) => [r.name, r.outcome, r.credit, r.signup_kind, r.attended, r.presence_source, r.flags, r.needs_review, r.pulls_present, r.pulls_total, r.missed_first, r.missed_last, r.via, r.hosted]) };
}

// ---------------------------------------------------------------------------
// Fixture: a two-team guild (Alpha = A, Bravo = B), fourteen people linked to Discord IDs, two of them with an alt on the other team
// (Eliora -> Eliobee on Bravo, Jorund -> Thessaly on Alpha), two inactive. Seven raids over ten days of the injected clock: every sign-up
// kind from Raid-Helper and from Raidsmith, logs, a plan, a hand-entered raid, upcoming raids whose start passes, officer decisions, and
// two teams raiding on the same date. Raids: R1 event + report; R2 event + native sign-ups, report after its start; R3 event + native +
// hand-entered; R4 native only, report after its start; R5 / R6 same date (A / B); R7 event + report + plan + decisions.

const DAY_S = 86400;
const at = (iso) => Date.parse(iso);

// key, name, team, class, main spec, Discord ID. Eliora is Erin's person and Gorrim is Gina's (both are Members who sign themselves up).
const ROSTER = [
  ['aldric', 'Aldric', 'A', 'WARRIOR', 'Arms', DID(1)],
  ['brindle', 'Brindle', 'A', 'MAGE', 'Fire', DID(2)],
  ['cassia', 'Cassia', 'A', 'MAGE', 'Frost', DID(3)],
  ['dunmar', 'Dunmar', 'A', 'WARRIOR', 'Fury', DID(4)],
  ['eliora', 'Eliora', 'A', 'PRIEST', 'Holy', PEOPLE.erin.id],
  ['fenwick', 'Fenwick', 'A', 'ROGUE', 'Combat', DID(6)],
  ['gorrim', 'Gorrim', 'A', 'PALADIN', 'Protection', PEOPLE.gina.id],
  ['hestia', 'Hestia', 'A', 'PRIEST', 'Shadow', DID(8)],
  ['ivor', 'Ivor', 'A', 'HUNTER', 'Marksmanship', DID(9)],         // inactive, left on 2027-01-20
  ['wander', 'Wanderfell', 'B', 'DRUID', 'Restoration', DID(7)],
  ['jorund', 'Jorund', 'B', 'WARRIOR', 'Arms', DID(10)],
  ['kestrel', 'Kestrel', 'B', 'HUNTER', 'Marksmanship', DID(11)],
  ['lysandra', 'Lysandra', 'B', 'PRIEST', 'Holy', DID(12)],        // inactive, no left-on date
  ['mordain', 'Mordain', 'B', 'ROGUE', 'Assassination', DID(13)],
];
const RH_CLASS = { WARRIOR: 'Warrior', MAGE: 'Mage', PRIEST: 'Priest', ROGUE: 'Rogue', PALADIN: 'Paladin', HUNTER: 'Hunter', DRUID: 'Druid' };
const RH_META = { late: 'Late', bench: 'Bench', tentative: 'Tentative', absence: 'Absence' };
// The class a name has in a Warcraft Logs report (mains and the three alts).
const LOG_CLASS = {
  Aldric: 'Warrior', Brindle: 'Mage', Cassia: 'Mage', Dunmar: 'Warrior', Eliora: 'Priest', Fenwick: 'Rogue', Gorrim: 'Paladin', Hestia: 'Priest', Ivor: 'Hunter',
  Wanderfell: 'Druid', Jorund: 'Warrior', Kestrel: 'Hunter', Lysandra: 'Priest', Mordain: 'Rogue',
  Mirabel: 'Hunter', Eliobee: 'Druid', Thessaly: 'Mage', Zorgax: 'Rogue',
};

async function wave2World() {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.teams;
  s.A = A; s.B = B;
  s.p = {};
  s.roster = {};
  for (const [key, name, which, classId, spec, discord] of ROSTER) {
    const made = await addPerson(s, 'bob', which === 'A' ? A : B, name, { class: classId, mainSpec: spec, offSpec: null });
    s.p[key] = made.person.id;
    exec(s.w, `UPDATE players SET discord_user_id = '${discord}' WHERE id = '${made.person.id}'`);
    s.roster[key] = { name, discord, rhClass: RH_CLASS[classId], spec };
  }
  // Alts on the other team: Eliora (Alpha) has Eliobee on Bravo and Mirabel on Alpha; Jorund (Bravo) has Thessaly on Alpha.
  const alt = async (pid, teamId, name, extra) => assert.equal((await addAlt(s, 'bob', pid, teamId, name, extra)).status, 201, name);
  await alt(s.p.eliora, A, 'Mirabel', { class: 'HUNTER', mainSpec: 'Marksmanship' });
  await alt(s.p.eliora, B, 'Eliobee', { class: 'DRUID', mainSpec: 'Restoration' });
  await alt(s.p.jorund, A, 'Thessaly', { class: 'MAGE', mainSpec: 'Fire' });
  // Two people who left: Ivor on 2027-01-20 (still expected up to and including that day), Lysandra with no date (never expected again).
  const leave = async (key, leftOn) => {
    const r = await s.call('bob', 'PATCH', `/roster/${s.p[key]}`, { expectedVersion: 1, status: 'inactive', leftOn });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  await leave('ivor', '2027-01-20');
  await leave('lysandra', null);
  s.raid = (id, route = '') => `/raids/${id}${route}`;
  return s;
}

// Raid-Helper sign-ups from [[personKey, kind], ...]; Raid-Helper words: the class for signed, the meta class otherwise. Optionally the
// stranger (a Discord ID on no roster).
function rhRows(s, list, { stranger = false } = {}) {
  const rows = list.map(([key, kind], index) => {
    const p = s.roster[key];
    return signUp(index + 1, p.discord, p.name, kind === 'signed' ? p.rhClass : RH_META[kind], kind === 'signed' ? p.spec : undefined);
  });
  if (stranger) rows.push(signUp(99, '299999999999999999', 'Stranger', 'Rogue', 'Combat'));
  return rows;
}

// A Warcraft Logs report from rosters: one boss pull per roster (the last one a kill), a trash fight before them, a pet and an NPC.
function logReport(startTime, rosters) {
  const names = [...new Set(rosters.flat())];
  const actors = names.map((name, i) => {
    assert(LOG_CLASS[name], `no class for ${name}`);
    return [i + 1, name, LOG_CLASS[name]];
  });
  const idOf = new Map(actors.map(([id, name]) => [name, id]));
  actors.push([90, 'Rexxar', 'Pet'], [91, 'Weird', 'NPC']);
  const bosses = ['Maulgar', 'Gruul', 'Magtheridon'];
  const fights = [[1, 'Trash', 0, false, 0, 90, [idOf.get(rosters[0][0])]]];
  rosters.forEach((roster, i) => {
    fights.push([i + 2, bosses[i % 3], 649 + (i % 3), i === rosters.length - 1, 60_000 + i * 600_000, 200, [...roster.map((name) => idOf.get(name)), 90]]);
  });
  return wclReport({ startTime, actors, fights });
}

// ---- the run: returns every snapshot, keyed

const POLICY_VARIANTS = [
  // label, policy override (guild level), raids snapshotted, teams whose page is read
  ['absenceExcused', { absence: 'excused' }, ['r1', 'r2'], ['A']],
  ['tentativeAsSignedUp', { tentative: 'asSignedUp' }, ['r1', 'r2'], ['A']],
  ['benchExcluded', { bench: 'excluded' }, ['r1', 'r2'], ['A']],
  ['lateSignupFullCreditNoFlag', { lateSignup: 'fullCreditNoFlag' }, ['r1', 'r2'], ['A']], // the default spelled out
  ['lateSignupFlagLikeOthers', { lateSignup: 'flagLikeOthers' }, ['r1', 'r2'], ['A']],
  ['expectedByStatus', { expected: { mode: 'statuses' } }, ['r1', 'r2'], ['A']],
  ['fillInHomeIfNoRaid', { fillIn: 'homeIfNoRaid' }, ['r1', 'r4', 'r5', 'r6'], ['A', 'B']],
  ['fillInRecordOnly', { fillIn: 'recordOnly' }, ['r1', 'r4', 'r5', 'r6'], ['A', 'B']],
];

const cellText = (date, outcome, credit, via, preStart, pending) => `${date.slice(5)} ${outcome} ${credit}${via ? ` via ${via.name}` : ''}${preStart ? ' pre' : ''}${pending ? ' pending' : ''}`;
const metricsRow = (name, status, m, cells) => [name, status, m.pct, m.pctAll, m.signupRate, m.streak, m.streakFlag, m.lastAttended, m.counted, m.pending, m.start, cells.join('; ')];

async function wave2Run() {
  const s = await wave2World();
  const clock = s.w.clock;
  const snaps = { raids: {}, pages: {}, variants: {} };
  const ids = {};
  const T1 = at('2027-01-17T12:00:00Z');        // after R2 started
  const T2 = at('2027-01-20T12:00:00Z');        // after R4 started
  const T3 = at('2027-01-25T12:00:00Z');        // after everything below

  // The central write limit is 60 a minute per user: step the injected clock a little every 25 calls.
  let calls = 0;
  const api = async (who, method, route, body) => {
    if (++calls % 25 === 0) s.w.advance(61_000);
    return s.call(who, method, route, body);
  };
  const ok = async (who, method, route, body, status = 200) => {
    const r = await api(who, method, route, body);
    assert.equal(r.status, status, `${method} ${route} -> ${JSON.stringify(r.json)}`);
    return r;
  };
  const create = async (body) => (await ok('bob', 'POST', '/raids', body, 201)).json.raid.id;
  const officer = (raidId, key, kind) => ok('bob', 'PUT', s.raid(raidId, `/signups/${s.p[key]}`), { kind });
  const member = (who, raidId, kind) => ok(who, 'PUT', s.raid(raidId, '/signup'), { kind });
  const snap = async (label, raidId) => { snaps.raids[label] = await attendanceSnapshot(s, raidId); };
  const rhEventId = (n) => String(n).repeat(18);
  const code = (n) => `Wave2Rpt0000000${n}`;
  const setEvent = (n, list, extra, opts) => s.w.sources.events.set(rhEventId(n), rhEvent(rhEventId(n), SERVER_A, rhRows(s, list, opts), extra));
  const setReport = (n, startTime, rosters) => s.w.sources.reports.set(code(n), logReport(startTime, rosters));
  const dayStart = (days, plusSeconds = 0) => (RH_START + days * DAY_S + plusSeconds) * 1000; // a report's start for the event that many days after RH_START

  s.w.advance(61_000); // the world's set-up used up this minute's writes; the clock is 2027-01-16 12:01Z

  // ---- 1. Raid-Helper event + report, every kind of sign-up, a person with none, a person only in the log (R1, team A, 01-16)
  setEvent(1, [
    ['aldric', 'signed'], ['brindle', 'signed'], ['cassia', 'late'], ['dunmar', 'absence'], ['eliora', 'tentative'], ['gorrim', 'absence'], ['hestia', 'bench'],
    ['kestrel', 'signed'],
  ], { startTime: RH_START }, { stranger: true });
  setReport(1, dayStart(0), [
    ['Aldric', 'Eliora', 'Gorrim', 'Thessaly'],
    ['Aldric', 'Cassia', 'Eliora', 'Gorrim', 'Thessaly', 'Wanderfell', 'Zorgax'],
    ['Aldric', 'Cassia', 'Eliora', 'Thessaly'],
  ]);
  ids.r1 = await create({ teamId: s.A, eventSource: rhEventId(1) });
  await ok('bob', 'PUT', s.raid(ids.r1, '/reports'), { source: code(1) });
  await snap('r1', ids.r1);

  // ---- 2a. The same kinds, natively, on an upcoming raid of team A with an event (R2, 01-17): members for themselves, an officer for others.
  setEvent(2, [
    ['aldric', 'signed'], ['brindle', 'signed'], ['cassia', 'tentative'], ['dunmar', 'absence'], ['eliora', 'signed'], ['gorrim', 'absence'],
  ], { startTime: RH_START + DAY_S }, { stranger: true });
  setReport(2, dayStart(1), [
    ['Aldric', 'Eliora', 'Fenwick'],
    ['Aldric', 'Cassia', 'Eliora', 'Fenwick', 'Zorgax'],
    ['Aldric', 'Cassia', 'Eliora', 'Fenwick'],
    ['Aldric', 'Cassia', 'Fenwick'],
  ]);
  ids.r2 = await create({ teamId: s.A, eventSource: rhEventId(2) });
  await member('erin', ids.r2, 'tentative');   // Eliora: replaces her Raid-Helper "signed"
  await member('gina', ids.r2, 'signed');      // Gorrim: replaces her Raid-Helper Absence
  await officer(ids.r2, 'brindle', 'absence'); // replaces signed
  await officer(ids.r2, 'cassia', 'late');     // replaces tentative
  await officer(ids.r2, 'dunmar', 'bench');    // replaces Absence
  await officer(ids.r2, 'hestia', 'tentative');
  await officer(ids.r2, 'fenwick', 'signed');
  await officer(ids.r2, 'ivor', 'signed');     // inactive, but he signed up
  await snap('r2Upcoming', ids.r2);

  // ---- 2b. A hand-made upcoming raid of team B with native sign-ups only (R4, 01-19 20:00)
  ids.r4 = await create({ teamId: s.B, raidOn: '2027-01-19', startTime: '20:00' });
  await member('erin', ids.r4, 'signed');      // Eliora, on her Bravo alt Eliobee
  await officer(ids.r4, 'jorund', 'signed');
  await officer(ids.r4, 'kestrel', 'late');
  await officer(ids.r4, 'wander', 'tentative');
  await officer(ids.r4, 'lysandra', 'bench');  // inactive with no left-on date, but on the bench
  await officer(ids.r4, 'mordain', 'absence');
  await snap('r4Upcoming', ids.r4);

  // ---- the first start passes: nothing is guessed from sign-ups alone; a report then gives the results
  clock.now = T1;
  await snap('r2Started', ids.r2);
  await ok('bob', 'PUT', s.raid(ids.r2, '/reports'), { source: code(2) });
  await snap('r2', ids.r2);

  clock.now = T2;
  setReport(4, at('2027-01-20T01:30:00Z'), [
    ['Jorund', 'Eliobee', 'Wanderfell', 'Aldric'],
    ['Jorund', 'Kestrel', 'Eliobee', 'Wanderfell', 'Aldric'],
    ['Jorund', 'Kestrel', 'Eliobee', 'Aldric'],
  ]);
  await snap('r4Started', ids.r4);
  await ok('bob', 'PUT', s.raid(ids.r4, '/reports'), { source: code(4) });
  await snap('r4', ids.r4);

  // ---- 2c. A hand-entered raid (R3, team A, 01-18): event sign-ups, officer sign-ups over them, ticks by hand (a fill-in among them)
  setEvent(3, [
    ['aldric', 'signed'], ['brindle', 'signed'], ['cassia', 'late'], ['dunmar', 'absence'], ['eliora', 'tentative'], ['hestia', 'bench'],
  ], { startTime: RH_START + 2 * DAY_S });
  ids.r3 = await create({ teamId: s.A, eventSource: rhEventId(3) });
  await officer(ids.r3, 'brindle', 'absence');
  await officer(ids.r3, 'gorrim', 'late');
  await officer(ids.r3, 'fenwick', 'bench');
  await ok('bob', 'PUT', s.raid(ids.r3, '/manual'), { reason: 'No log kept', presentPlayerIds: [s.p.aldric, s.p.cassia, s.p.fenwick, s.p.wander] });
  await snap('r3', ids.r3);

  // ---- 4. Two teams, one date (R5 team A, R6 team B, 01-21): the fill-in pass runs in both directions
  setEvent(5, [
    ['aldric', 'signed'], ['brindle', 'signed'], ['cassia', 'signed'], ['eliora', 'signed'], ['fenwick', 'signed'], ['gorrim', 'signed'], ['hestia', 'signed'],
  ], { startTime: RH_START + 5 * DAY_S });
  setReport(5, dayStart(5), [
    ['Aldric', 'Brindle', 'Eliora', 'Hestia', 'Thessaly', 'Wanderfell'],
    ['Aldric', 'Brindle', 'Eliora', 'Hestia', 'Thessaly', 'Wanderfell'],
    ['Aldric', 'Brindle', 'Eliora', 'Hestia', 'Thessaly', 'Wanderfell'],
  ]);
  setEvent(6, [['jorund', 'signed'], ['kestrel', 'signed'], ['wander', 'signed'], ['mordain', 'tentative']], { startTime: RH_START + 5 * DAY_S + 3600 });
  setReport(6, dayStart(5, 3600), [
    ['Jorund', 'Kestrel', 'Aldric', 'Cassia', 'Fenwick', 'Eliobee'],
    ['Jorund', 'Kestrel', 'Aldric', 'Cassia', 'Fenwick', 'Eliobee'],
    ['Jorund', 'Kestrel', 'Aldric', 'Cassia', 'Fenwick'],
  ]);
  clock.now = T3;
  const five = await ok('bob', 'POST', '/raids', { teamId: s.A, eventSource: rhEventId(5), reportSource: code(5) }, 201);
  ids.r5 = five.json.raid.id;
  await snap('r5Alone', ids.r5);                // no Bravo raid yet: Wanderfell's Other-team cell counts on this one
  // Cassia was not at Alpha's raid; an officer confirms it, so Bravo's log cannot turn her missed cell into an Other-team one.
  const cassia = five.json.people.find((p) => p.name === 'Cassia');
  assert(cassia && cassia.flags.includes('no_show'), 'Cassia is flagged no_show on R5');
  await ok('bob', 'POST', s.raid(ids.r5, '/decisions'), { playerId: s.p.cassia, outcome: 'missed', reason: 'Confirmed no-show', expectedFlags: cassia.flags });
  const six = await ok('bob', 'POST', '/raids', { teamId: s.B, eventSource: rhEventId(6), reportSource: code(6) }, 201);
  ids.r6 = six.json.raid.id;
  await snap('r5', ids.r5);
  await snap('r6', ids.r6);

  // ---- 3. A plan that benches a signed-up player and places one who did not sign up, and officer decisions (R7, team A, 01-23)
  setEvent(7, [
    ['aldric', 'signed'], ['brindle', 'signed'], ['cassia', 'late'], ['dunmar', 'absence'], ['eliora', 'tentative'], ['gorrim', 'signed'], ['hestia', 'bench'],
  ], { startTime: RH_START + 7 * DAY_S });
  setReport(7, dayStart(7), [
    ['Aldric', 'Eliora', 'Fenwick', 'Hestia'],
    ['Aldric', 'Cassia', 'Eliora', 'Fenwick', 'Hestia'],
    ['Aldric', 'Cassia', 'Fenwick', 'Hestia'],
  ]);
  ids.r7 = (await ok('bob', 'POST', '/raids', { teamId: s.A, eventSource: rhEventId(7), reportSource: code(7) }, 201)).json.raid.id;
  const plan = await ok('bob', 'PUT', s.raid(ids.r7, '/plan'), {
    label: 'Plan',
    players: [
      { name: 'Aldric', group: 1 }, { name: 'Brindle', group: 0 }, { name: 'Cassia', group: 2 }, { name: 'Dunmar', group: 0 }, { name: 'Fenwick', group: 3 },
      { name: 'Hestia', group: 0 }, { name: 'Ivor', group: 0 }, { name: 'Wanderfell', group: 5 }, { name: 'Nobody', group: 4 },
    ],
  });
  await snap('r7Plan', ids.r7);
  const decide = async (name, body) => {
    const row = plan.json.people.find((p) => p.name === name);
    assert(row && row.needsReview, `${name} is flagged on R7`);
    await ok('bob', 'POST', s.raid(ids.r7, '/decisions'), { playerId: row.playerId, reason: 'Decided in test', expectedFlags: row.flags, ...body });
  };
  await decide('Cassia', { outcome: 'present' });
  await decide('Eliora', { outcome: 'left_early', creditId: 'half' });
  await snap('r7', ids.r7);

  // ---- what the attendance pages derive: the headline numbers and the per-raid cell outcomes
  const recomputeAll = async () => { for (const id of Object.values(ids)) await ok('bob', 'POST', s.raid(id, '/recompute'), {}); };
  const teamPage = async (team) => {
    const r = await ok('bob', 'GET', `/attendance/team?team=${team === 'A' ? s.A : s.B}`);
    return {
      head: [r.json.window, r.json.awaitingReview, r.json.staleRaids],
      people: r.json.people.map((p) => metricsRow(p.name, p.status, p, p.cells.map((c) => cellText(c.date, c.outcome, c.credit, c.via, c.preStart, c.pending)))),
    };
  };
  const personPage = async (key) => {
    const r = await ok('bob', 'GET', `/attendance/person/${s.p[key]}`);
    return { name: r.json.person.name, teams: r.json.teams.map((t) => metricsRow(t.team.name, t.window, t.metrics, t.cells.map((c) => cellText(c.raid.raidOn, c.outcome, c.credit, c.via, c.preStart, c.pending)))) };
  };
  const raidList = async (team) => {
    const r = await ok('bob', 'GET', `/raids?team=${team === 'A' ? s.A : s.B}`);
    return r.json.raids.map((x) => [x.raidOn, x.counts.present, x.counts.bench, x.counts.missed, x.openFlags, x.state]);
  };
  snaps.pages.teamA = await teamPage('A');
  snaps.pages.teamB = await teamPage('B');
  snaps.pages.raidListA = await raidList('A');
  snaps.pages.raidListB = await raidList('B');
  snaps.pages.persons = {};
  for (const key of ['eliora', 'wander', 'aldric', 'ivor', 'jorund']) snaps.pages.persons[key] = await personPage(key);

  // ---- 5. Policy variants through PUT /attendance/policy: each starts from the defaults, is recomputed everywhere and re-snapshotted
  let policyVersion = 0;
  const setPolicy = async (policy) => {
    const r = await ok('bob', 'PUT', '/attendance/policy', { teamId: null, policy, expectedVersion: policyVersion });
    policyVersion = r.json.versions.guild;
  };
  for (const [label, policy, raidKeys, teams] of POLICY_VARIANTS) {
    await setPolicy(policy);
    const variant = { staleAfterPut: (await teamPage('A')).head[2], raids: {}, pages: {} };
    await recomputeAll();
    for (const key of raidKeys) variant.raids[key] = await attendanceSnapshot(s, ids[key]);
    for (const team of teams) variant.pages[team] = await teamPage(team);
    variant.persons = { eliora: await personPage('eliora') };
    snaps.variants[label] = variant;
    await setPolicy({});
    await recomputeAll();
  }
  // Back on the defaults everything is what it was before the variants.
  snaps.reset = { raids: { r1: await attendanceSnapshot(s, ids.r1), r2: await attendanceSnapshot(s, ids.r2) }, teamA: await teamPage('A') };
  return snaps;
}

// ---- REGRESSION GOLDEN (recorded on 70907c8) ----

// Where two snapshots differ, one line per differing row / list: `raids.r1.rows[3]: expected [...], actual [...]`.
function goldenDiffs(actual, expected, where = '', out = []) {
  if (isDeepStrictEqual(actual, expected)) return out;
  const isLeaf = (v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'));
  if (isLeaf(actual) || isLeaf(expected)) {
    out.push(`${where}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    goldenDiffs(actual[key], expected[key], Array.isArray(actual) ? `${where}[${key}]` : `${where}${where ? '.' : ''}${key}`, out);
  }
  return out;
}

check('REGRESSION: attendance of the wave-2 fixture raids is exactly what it was on 70907c8', async () => {
  const snaps = await wave2Run();
  if (process.env.WAVE2_PRINT_GOLDEN) console.log(JSON.stringify(snaps));
  const diffs = goldenDiffs(snaps, GOLDEN);
  assert.deepEqual(snaps, GOLDEN, diffs.length ? `attendance differs from the golden in ${diffs.length} place(s):\n${diffs.slice(0, 10).join('\n')}` : undefined);
});

// Recorded by the scenario above on the unchanged base (70907c8, 2026-10-17): no away notices, no standby sign-ups, no deadline.
// Rows: [character, outcome, credit, signup_kind, attended, presence_source, flags, needs_review, pulls_present, pulls_total, missed_first, missed_last, via, hosted].
// Page rows: [name, status|window, pct, pctAll, signupRate, streak, streakFlag, lastAttended, counted, pending, start, cells].
const GOLDEN = {
  raids: {
    r1: {
      openFlags: 4,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
        ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
        ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
      ],
    },
    r2Upcoming: {
      openFlags: 0,
      rows: [],
    },
    r4Upcoming: {
      openFlags: 0,
      rows: [],
    },
    r2Started: {
      openFlags: 0,
      rows: [],
    },
    r2: {
      openFlags: 4,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
        ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
        ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
        ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
        ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
        ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
        ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
        ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
        ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
        ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
      ],
    },
    r4Started: {
      openFlags: 0,
      rows: [],
    },
    r4: {
      openFlags: 1,
      rows: [
        ['Aldric', 'fill_in', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
        ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Kestrel', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
        ['Lysandra', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Mordain', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Wanderfell', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
      ],
    },
    r3: {
      openFlags: 1,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Brindle', 'missed_notice', 0, 'absence', 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Cassia', 'present', 1, 'late', 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Dunmar', 'missed_notice', 0, 'absence', 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Eliora', 'tentative', null, 'tentative', 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Fenwick', 'present', 1, 'bench', 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Gorrim', 'missed', 0, 'late', 0, 'officer', '["no_show"]', 1, 0, 0, 0, 0, 0, 0],
        ['Hestia', 'bench', 1, 'bench', 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Ivor', 'no_signup', null, null, 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Jorund', 'no_signup', null, null, 0, 'officer', '[]', 0, 0, 0, 0, 0, 0, 0],
        ['Wanderfell', 'fill_in', 1, null, 1, 'officer', '[]', 0, 0, 0, 0, 0, 0, 1],
      ],
    },
    r5Alone: {
      openFlags: 3,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Brindle', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Cassia', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Dunmar', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Fenwick', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Hestia', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
      ],
    },
    r5: {
      openFlags: 1,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Brindle', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Cassia', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 0, 0, 3, 0, 0, 0, 0],
        ['Dunmar', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Fenwick', 'fill_in', 1, 'signed', 0, 'log', '[]', 0, 0, 3, 0, 0, 1, 0],
        ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Hestia', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Wanderfell', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
      ],
    },
    r6: {
      openFlags: 1,
      rows: [
        ['Aldric', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
        ['Cassia', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
        ['Eliora', 'left_early', null, null, 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
        ['Fenwick', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
        ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Kestrel', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Mordain', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Wanderfell', 'fill_in', 1, 'signed', 0, 'log', '[]', 0, 0, 3, 0, 0, 1, 0],
      ],
    },
    r7Plan: {
      openFlags: 5,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Cassia', 'late', null, 'signed', 1, 'log', '["late"]', 1, 2, 3, 1, 0, 0, 0],
        ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
        ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Hestia', 'present', 1, 'bench', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Ivor', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Wanderfell', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
      ],
    },
    r7: {
      openFlags: 3,
      rows: [
        ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Cassia', 'present', 1, 'signed', 1, 'log', '["late"]', 0, 2, 3, 1, 0, 0, 0],
        ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Eliora', 'left_early', 0.5, 'tentative', 1, 'log', '["left_early"]', 0, 2, 3, 0, 1, 0, 0],
        ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
        ['Hestia', 'present', 1, 'bench', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
        ['Ivor', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
        ['Wanderfell', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
      ],
    },
  },
  pages: {
    teamA: {
      head: [8, 5, 0],
      people: [
        ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
        ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
        ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
        ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
        ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
        ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
        ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
        ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
        ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
        ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
        ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
        ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
      ],
    },
    teamB: {
      head: [8, 2, 0],
      people: [
        ['Aldric', 'raider', 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-19 fill_in 1; 01-21 fill_in null'],
        ['Cassia', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
        ['Eliobee', 'raider', 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-19 present 1; 01-21 left_early null pending'],
        ['Fenwick', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
        ['Jorund', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
        ['Kestrel', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
        ['Lysandra', 'inactive', 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-19 bench 1'],
        ['Mordain', 'raider', 0, 0, 0, 1, false, null, 1, 0, '2027-01-16', '01-19 missed_notice 0; 01-21 tentative null'],
        ['Wanderfell', 'raider', 100, 100, 100, 0, false, '2027-01-21', 3, 1, '2027-01-16', '01-16 fill_in 1 via Alpha; 01-18 fill_in 1 via Alpha; 01-19 left_early null pending; 01-21 fill_in 1 via Alpha'],
      ],
    },
    raidListA: [
      ['2027-01-23', 5, 2, 3, 3, 'to_review'],
      ['2027-01-21', 7, 0, 2, 1, 'to_review'],
      ['2027-01-18', 4, 1, 3, 1, 'to_review'],
      ['2027-01-17', 4, 1, 3, 4, 'to_review'],
      ['2027-01-16', 6, 1, 3, 4, 'to_review'],
    ],
    raidListB: [
      ['2027-01-21', 7, 0, 0, 1, 'to_review'],
      ['2027-01-19', 5, 1, 1, 1, 'to_review'],
    ],
    persons: {
      eliora: {
        name: 'Eliora',
        teams: [
          ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
          ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
        ],
      },
      wander: {
        name: 'Wanderfell',
        teams: [
          ['Alpha', 8, 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-23 missed 0; 01-21 fill_in null; 01-18 fill_in 1; 01-16 fill_in 1'],
          ['Bravo', 8, 100, 100, 100, 0, false, '2027-01-21', 3, 1, '2027-01-16', '01-21 fill_in 1 via Alpha; 01-19 left_early null pending; 01-18 fill_in 1 via Alpha; 01-16 fill_in 1 via Alpha'],
        ],
      },
      aldric: {
        name: 'Aldric',
        teams: [
          ['Alpha', 8, 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-23 present 1; 01-21 present 1; 01-19 fill_in 1 via Bravo; 01-18 present 1; 01-17 present 1; 01-16 present 1'],
          ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-21 fill_in null; 01-19 fill_in 1'],
        ],
      },
      ivor: {
        name: 'Ivor',
        teams: [
          ['Alpha', 8, 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-23 bench 1; 01-18 no_signup null pre; 01-17 missed 0 pre; 01-16 no_signup null pre'],
        ],
      },
      jorund: {
        name: 'Jorund',
        teams: [
          ['Alpha', 8, 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-23 no_signup null; 01-21 present 1; 01-18 no_signup null; 01-17 no_signup null; 01-16 present 1'],
          ['Bravo', 8, 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-21 present 1; 01-19 present 1'],
        ],
      },
    },
  },
  variants: {
    absenceExcused: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', null, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', null, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice null pre; 01-18 missed_notice null pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 100, 100, 50, 0, false, '2027-01-23', 2, 0, '2027-01-17', '01-16 missed_notice null pre; 01-17 bench 1; 01-18 missed_notice null; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    tentativeAsSignedUp: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 5,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'missed', 0, 'tentative', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 62.5, 62.5, 20, 0, false, '2027-01-23', 4, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 missed 0; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 80, 80, 80, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 bench 1; 01-17 missed 0; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 62.5, 62.5, 20, 0, false, '2027-01-23', 4, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 missed 0; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    benchExcluded: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', null, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', null, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 0, 0, 50, 1, false, null, 1, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench null; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench null'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 2, 0, '2027-01-16', '01-16 bench null; 01-17 tentative null; 01-18 bench null; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', null, null, null, 0, false, null, 0, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench null'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    lateSignupFullCreditNoFlag: {
      staleAfterPut: 0,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    lateSignupFlagLikeOthers: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 5,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'late', null, 'late', 1, 'log', '["late"]', 1, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 5,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'late', null, 'late', 1, 'log', '["late"]', 1, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 66.7, 66.7, 100, 0, false, '2027-01-23', 3, 2, '2027-01-16', '01-16 late null pending; 01-17 late null pending; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    expectedByStatus: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 5,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'missed', 0, null, 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r2: {
          openFlags: 6,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
            ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
            ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
            ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Hestia', 'missed', 0, 'tentative', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
            ['Jorund', 'missed', 0, null, 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 50, 50, 50, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 missed 0; 01-23 bench 1'],
            ['Eliora', 'raider', 62.5, 62.5, 20, 0, false, '2027-01-23', 4, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 missed 0; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 missed 0 pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 80, 80, 80, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 bench 1; 01-17 missed 0; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 40, 40, 0, 1, false, '2027-01-21', 5, 0, '2027-01-16', '01-16 present 1; 01-17 missed 0; 01-18 missed 0; 01-21 present 1; 01-23 missed 0'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 62.5, 62.5, 20, 0, false, '2027-01-23', 4, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 missed 0; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    fillInHomeIfNoRaid: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r4: {
          openFlags: 1,
          rows: [
            ['Aldric', 'fill_in', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Lysandra', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Mordain', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
          ],
        },
        r5: {
          openFlags: 2,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Cassia', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 0, 0, 3, 0, 0, 0, 0],
            ['Dunmar', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Hestia', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
          ],
        },
        r6: {
          openFlags: 2,
          rows: [
            ['Aldric', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Cassia', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Eliora', 'left_early', null, null, 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Fenwick', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Mordain', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 75, 75, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
        B: {
          head: [8, 2, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-19 fill_in 1; 01-21 fill_in null'],
            ['Cassia', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
            ['Eliobee', 'raider', 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-19 present 1; 01-21 left_early null pending'],
            ['Fenwick', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
            ['Jorund', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
            ['Kestrel', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
            ['Lysandra', 'inactive', 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-19 bench 1'],
            ['Mordain', 'raider', 0, 0, 0, 1, false, null, 1, 0, '2027-01-16', '01-19 missed_notice 0; 01-21 tentative null'],
            ['Wanderfell', 'raider', 66.7, 66.7, 100, 1, false, '2027-01-18', 3, 1, '2027-01-16', '01-16 fill_in 1 via Alpha; 01-18 fill_in 1 via Alpha; 01-19 left_early null pending; 01-21 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
    fillInRecordOnly: {
      staleAfterPut: 5,
      raids: {
        r1: {
          openFlags: 4,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', null, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
          ],
        },
        r4: {
          openFlags: 1,
          rows: [
            ['Aldric', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
            ['Lysandra', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Mordain', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
          ],
        },
        r5: {
          openFlags: 2,
          rows: [
            ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Brindle', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Cassia', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 0, 0, 3, 0, 0, 0, 0],
            ['Dunmar', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Eliora', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Fenwick', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
            ['Hestia', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Wanderfell', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
          ],
        },
        r6: {
          openFlags: 2,
          rows: [
            ['Aldric', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Cassia', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Eliora', 'left_early', null, null, 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
            ['Fenwick', 'fill_in', null, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 1],
            ['Jorund', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Kestrel', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
            ['Mordain', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
            ['Wanderfell', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
          ],
        },
      },
      pages: {
        A: {
          head: [8, 5, 0],
          people: [
            ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 present 1; 01-23 present 1'],
            ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
            ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
            ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
            ['Fenwick', 'raider', 75, 75, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
            ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
            ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
            ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
            ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
            ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
            ['Wanderfell', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 fill_in null; 01-18 fill_in null; 01-21 fill_in null; 01-23 missed 0'],
          ],
        },
        B: {
          head: [8, 2, 0],
          people: [
            ['Aldric', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-19', '01-19 fill_in null; 01-21 fill_in null'],
            ['Cassia', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
            ['Eliobee', 'raider', 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-19 present 1; 01-21 left_early null pending'],
            ['Fenwick', 'raider', null, null, 0, 0, false, null, 0, 0, '2027-01-21', '01-21 fill_in null'],
            ['Jorund', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
            ['Kestrel', 'raider', 100, 100, 100, 0, false, '2027-01-21', 2, 0, '2027-01-19', '01-19 present 1; 01-21 present 1'],
            ['Lysandra', 'inactive', 100, 100, 0, 0, false, '2027-01-19', 1, 0, '2027-01-19', '01-19 bench 1'],
            ['Mordain', 'raider', 0, 0, 0, 1, false, null, 1, 0, '2027-01-16', '01-19 missed_notice 0; 01-21 tentative null'],
            ['Wanderfell', 'raider', 0, 0, 100, 1, false, null, 1, 1, '2027-01-19', '01-19 left_early null pending; 01-21 missed 0'],
          ],
        },
      },
      persons: {
        eliora: {
          name: 'Eliora',
          teams: [
            ['Alpha', 8, 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-23 left_early 0.5; 01-21 present 1; 01-18 tentative null; 01-17 left_early null pending; 01-16 present 1'],
            ['Bravo', 8, 100, 100, 0, 0, false, '2027-01-19', 1, 1, '2027-01-19', '01-21 left_early null pending; 01-19 present 1'],
          ],
        },
      },
    },
  },
  reset: {
    raids: {
      r1: {
        openFlags: 4,
        rows: [
          ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
          ['Brindle', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
          ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 2, 3, 1, 0, 0, 0],
          ['Dunmar', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
          ['Eliora', 'present', 1, 'tentative', 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
          ['Fenwick', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
          ['Gorrim', 'left_early', null, 'absence', 1, 'log', '["left_early"]', 1, 2, 3, 0, 1, 0, 0],
          ['Hestia', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
          ['Ivor', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 3, 0, 0, 0, 0],
          ['Jorund', 'present', 1, null, 1, 'log', '[]', 0, 3, 3, 0, 0, 0, 0],
          ['Kestrel', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 3, 0, 0, 0, 0],
          ['Wanderfell', 'fill_in', 1, null, 1, 'log', '[]', 0, 1, 3, 1, 1, 0, 1],
        ],
      },
      r2: {
        openFlags: 4,
        rows: [
          ['Aldric', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
          ['Brindle', 'missed_notice', 0, 'absence', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ['Cassia', 'present', 1, 'late', 1, 'log', '[]', 0, 3, 4, 1, 0, 0, 0],
          ['Dunmar', 'bench', 1, 'bench', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ['Eliora', 'left_early', null, 'tentative', 1, 'log', '["left_early"]', 1, 3, 4, 0, 1, 0, 0],
          ['Fenwick', 'present', 1, 'signed', 1, 'log', '[]', 0, 4, 4, 0, 0, 0, 0],
          ['Gorrim', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
          ['Hestia', 'tentative', null, 'tentative', 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
          ['Ivor', 'missed', 0, 'signed', 0, 'log', '["no_show"]', 1, 0, 4, 0, 0, 0, 0],
          ['Jorund', 'no_signup', null, null, 0, 'log', '[]', 0, 0, 4, 0, 0, 0, 0],
        ],
      },
    },
    teamA: {
      head: [8, 5, 0],
      people: [
        ['Aldric', 'raider', 100, 100, 100, 0, false, '2027-01-23', 6, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-19 fill_in 1 via Bravo; 01-21 present 1; 01-23 present 1'],
        ['Brindle', 'raider', 50, 50, 100, 1, false, '2027-01-21', 2, 0, '2027-01-21', '01-16 missed 0 pre; 01-17 missed_notice 0 pre; 01-18 missed_notice 0 pre; 01-21 present 1; 01-23 missed 0'],
        ['Cassia', 'raider', 80, 80, 100, 0, false, '2027-01-23', 5, 0, '2027-01-16', '01-16 present 1; 01-17 present 1; 01-18 present 1; 01-21 missed 0; 01-23 present 1'],
        ['Dunmar', 'raider', 66.7, 66.7, 50, 0, false, '2027-01-23', 3, 0, '2027-01-17', '01-16 missed_notice 0 pre; 01-17 bench 1; 01-18 missed_notice 0; 01-21 no_signup null; 01-23 bench 1'],
        ['Eliora', 'raider', 83.3, 83.3, 20, 0, false, '2027-01-23', 3, 1, '2027-01-16', '01-16 present 1; 01-17 left_early null pending; 01-18 tentative null; 01-21 present 1; 01-23 left_early 0.5'],
        ['Fenwick', 'raider', 100, 100, 100, 0, false, '2027-01-23', 4, 0, '2027-01-17', '01-16 no_signup null pre; 01-17 present 1; 01-18 present 1; 01-21 fill_in 1 via Bravo; 01-23 present 1'],
        ['Gorrim', 'raider', 0, 0, 80, 4, true, null, 4, 1, '2027-01-16', '01-16 left_early null pending; 01-17 missed 0; 01-18 missed 0; 01-21 missed 0; 01-23 missed 0'],
        ['Hestia', 'raider', 100, 100, 80, 0, false, '2027-01-23', 4, 0, '2027-01-16', '01-16 bench 1; 01-17 tentative null; 01-18 bench 1; 01-21 present 1; 01-23 present 1'],
        ['Ivor', 'inactive', 100, 100, null, 0, false, '2027-01-23', 1, 0, '2027-01-23', '01-16 no_signup null pre; 01-17 missed 0 pre; 01-18 no_signup null pre; 01-23 bench 1'],
        ['Kestrel', 'raider', 0, 0, 20, 1, false, null, 1, 0, '2027-01-16', '01-16 missed 0'],
        ['Thessaly', 'raider', 100, 100, 0, 0, false, '2027-01-21', 2, 0, '2027-01-16', '01-16 present 1; 01-17 no_signup null; 01-18 no_signup null; 01-21 present 1; 01-23 no_signup null'],
        ['Wanderfell', 'raider', 66.7, 66.7, 20, 1, false, '2027-01-18', 3, 0, '2027-01-16', '01-16 fill_in 1; 01-18 fill_in 1; 01-21 fill_in null; 01-23 missed 0'],
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// WAVE 2 / LANE A: migration 0015 (the schema of the whole wave), then raid sizes, the sign-up deadline and date-only raids.

const fs = require('node:fs');
const os = require('node:os');

const MIGRATIONS = path.join(ROOT, 'migrations');
const NEW_COLUMNS = {
  raids: ['size', 'signup_close_hours', 'time_known', 'roster_published_at', 'roster_published_by'],
  teams: ['signup_close_hours'],
  raid_signups: ['standby', 'standing'],
};
const NEW_TABLES = ['away_notices', 'standing_signups', 'raid_roster'];

// A database that stopped at 0013 (everything before the wave: 0014 is another branch's), filled with rows of every old kind.
function populatedBefore0015() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0015-'));
  for (const name of fs.readdirSync(MIGRATIONS)) if (name.endsWith('.sql') && name < '0014') fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  db.sqlite.exec(`
    INSERT INTO users (id, account_key, discord_id, username, global_name, avatar, prefs, created_at, last_seen_at)
      VALUES ('u_a', '110000000000000001', '110000000000000001', 'alice', 'Alice A', NULL, '{}', 10, 20), ('u_b', '110000000000000002', '110000000000000002', 'bob', NULL, NULL, '{}', 11, 21);
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_by, created_at)
      VALUES ('g_1', 'Ember', 'Dreamscythe', 'realm', 'US', 'srv1', 'UTC', 'tbc', 'u_a', 5), ('g_2', 'Other', 'Dreamscythe', 'realm', 'US', 'srv2', 'UTC', 'tbc', 'u_b', 5);
    INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t_1', 'g_1', 'Main', 25, 0, 5), ('t_2', 'g_1', 'Spare', 10, 0, 5), ('t_x', 'g_2', 'Elsewhere', 25, 0, 5);
    INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_1', 'g_1', 'raider', 1, 1), ('p_2', 'g_1', 'raider', 1, 1), ('p_x', 'g_2', 'raider', 1, 1);
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at)
      VALUES ('c_1', 'g_1', 'p_1', 't_1', 'Aldric', 'aldric', 'Dreamscythe', 'dreamscythe', 'WARRIOR', 1, 1, 1),
             ('c_2', 'g_1', 'p_2', 't_1', 'Brindle', 'brindle', 'Dreamscythe', 'dreamscythe', 'MAGE', 1, 1, 1);
    INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, event_id, event_title, event_synced, log_mode, manual_reason, manual_by, manual_at, plan_label, plan_synced, created_by, created_at, updated_at)
      VALUES ('r_event', 'g_1', 't_1', '2027-01-05', 1000, 'Karazhan', '123456789012345678', 'Event raid', 1, 'log', NULL, NULL, NULL, NULL, NULL, 'u_a', 1, 1),
             ('r_report', 'g_1', 't_1', '2027-01-06', 2000, 'Gruul''s Lair', NULL, NULL, NULL, 'log', NULL, NULL, NULL, NULL, NULL, 'u_a', 1, 1),
             ('r_plain', 'g_1', 't_1', '2027-01-07', 3000, NULL, NULL, NULL, NULL, 'log', NULL, NULL, NULL, 'My plan', 3, 'u_a', 1, 1),
             ('r_manual', 'g_1', 't_1', '2027-01-08', 4000, NULL, NULL, NULL, NULL, 'manual', 'no logs today', 'u_b', 4, NULL, NULL, 'u_a', 1, 1),
             ('r_other', 'g_1', 't_2', '2027-01-08', 5000, NULL, NULL, NULL, NULL, 'log', NULL, NULL, NULL, NULL, NULL, 'u_a', 1, 1);
    INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES ('r_report', 'g_1', 'Abcdefghij012345', 'www', 2000, 3000, 'Upl', 2);
    INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES ('r_report', 'Abcdefghij012345', 1, 649, 'Maulgar', 1, 2100, 2200);
    INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id, player_id)
      VALUES ('r_event', 'raid_helper', 1, '110000000000000002', 'Bob', 'signed', 'Warrior', 'Arms1', 1, 'g_1', 'p_1'), ('r_event', 'raid_helper', 2, '299999999999999999', 'Stranger', 'late', 'Late', NULL, 2, 'g_1', NULL);
    INSERT INTO raid_signups (raid_id, source, signup_id, kind, class_name, spec_name, position, guild_id, player_id, character_id, note, updated_by, created_at, updated_at)
      VALUES ('r_plain', 'raidsmith', 1, 'tentative', 'Mage', 'Fire1', 1, 'g_1', 'p_2', 'c_2', 'maybe', 'u_b', 60, 61);
    INSERT INTO raid_plan (raid_id, name, name_key, group_number) VALUES ('r_plain', 'Aldric', 'aldric', 1), ('r_plain', 'Brindle', 'brindle', 0);
    INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES ('r_manual', 'g_1', 'p_1');
    INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, signup_kind, attended) VALUES ('r_report', 'g_1', 't_1', 'p_1', 'present', 1, 'signed', 1), ('r_manual', 'g_1', 't_1', 'p_1', 'present', 1, NULL, 1);
    INSERT INTO team_schedules (id, guild_id, team_id, weekday, start_time, zone, title, created_at) VALUES ('ts_1', 'g_1', 't_1', 2, '20:00', 'Karazhan', 'Tuesday', 62);
  `);
  return db;
}

const tableDump = (db, table) => {
  const columns = db.sqlite.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map((c) => c.name);
  return { columns, rows: db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${columns.map((c) => `"${c}"`).join(', ')}`).all().map((r) => ({ ...r })) };
};
const allTables = (db) => db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
const without = (row, drop) => Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key)));
const tryExec = (db, sql) => { try { db.sqlite.exec(sql); return null; } catch (error) { return String(error.message); } };

check('migration 0015 on a populated 0013 database: every old row survives, time_known is backfilled, the foreign keys hold', async () => {
  const db = populatedBefore0015();
  try {
    const tablesBefore = allTables(db);
    const before = Object.fromEntries(tablesBefore.map((table) => [table, tableDump(db, table)]));
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), [], 'the seed itself is sound');
    for (const table of ['raids', 'raid_signups', 'raid_reports', 'raid_plan', 'raid_manual', 'attendance', 'team_schedules', 'players', 'characters']) assert(before[table].rows.length > 0, `${table} is seeded`);

    db.sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, '0015_wave2.sql'), 'utf8'));

    // The row count of every old table is unchanged, and so is every old column of every row.
    const after = Object.fromEntries(tablesBefore.map((table) => [table, tableDump(db, table)]));
    for (const table of tablesBefore) {
      const added = NEW_COLUMNS[table] || [];
      assert.deepEqual(after[table].columns, [...before[table].columns, ...added], `${table}: only the new columns were added, at the end`);
      assert.equal(after[table].rows.length, before[table].rows.length, `${table}: row count`);
      assert.deepEqual(after[table].rows.map((row) => without(row, added)), before[table].rows, `${table}: old values untouched`);
    }
    assert.deepEqual(allTables(db), [...tablesBefore, ...NEW_TABLES].sort(), 'exactly the three new tables were added');
    for (const table of NEW_TABLES) assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} starts empty`);

    // time_known: 1 for the raids an event or a report anchors, NULL for the others (unknown reads as a real time).
    const known = Object.fromEntries(after.raids.rows.map((row) => [row.id, row.time_known]));
    assert.deepEqual(known, { r_event: 1, r_report: 1, r_plain: null, r_manual: null, r_other: null });
    // The other new columns default to "nothing set": automatic size, the team's deadline, no published roster, team deadline 0, no standby, not standing.
    for (const row of after.raids.rows) assert.deepEqual([row.size, row.signup_close_hours, row.roster_published_at, row.roster_published_by], [null, null, null, null], row.id);
    assert.deepEqual(after.teams.rows.map((row) => row.signup_close_hours), [0, 0, 0]);
    assert.deepEqual(after.raid_signups.rows.map((row) => [row.standby, row.standing]), [[0, 0], [0, 0], [0, 0]]);

    // Nothing dangles, foreign keys are still on, and the new constraints point where the design says.
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const fks = (table) => db.sqlite.prepare(`SELECT "table" AS t, "from" AS f, "to" AS x, on_delete AS d FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`).all().map((r) => `${r.f}->${r.t}.${r.x} ${r.d}`);
    const has = (table, expected) => { for (const text of expected) assert(fks(table).includes(text), `${table}: ${text} in ${JSON.stringify(fks(table))}`); };
    has('away_notices', ['guild_id->guilds.id CASCADE', 'guild_id->players.guild_id CASCADE', 'player_id->players.id CASCADE', 'created_by->users.id SET NULL']);
    has('standing_signups', ['guild_id->guilds.id CASCADE', 'guild_id->teams.guild_id CASCADE', 'team_id->teams.id CASCADE', 'guild_id->players.guild_id CASCADE', 'player_id->players.id CASCADE', 'character_id->characters.id SET NULL']);
    has('raid_roster', ['guild_id->raids.guild_id CASCADE', 'raid_id->raids.id CASCADE', 'player_id->players.id SET NULL']);
    has('raids', ['roster_published_by->users.id SET NULL']);
  } finally {
    db.close();
  }
});

check('migration 0015: the new columns and tables reject what the design forbids', async () => {
  const db = populatedBefore0015();
  try {
    db.sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, '0015_wave2.sql'), 'utf8'));
    const rejects = (sql, pattern = /CHECK/, label = sql) => { const message = tryExec(db, sql); assert(message && pattern.test(message), `${label} -> ${message}`); };
    const accepts = (sql) => { const message = tryExec(db, sql); assert.equal(message, null, `${sql} -> ${message}`); };

    // raids
    for (const size of [15, 0, 5, 26, -1]) rejects(`UPDATE raids SET size = ${size} WHERE id = 'r_plain'`);
    for (const size of [10, 20, 25, 40, 'NULL']) accepts(`UPDATE raids SET size = ${size} WHERE id = 'r_plain'`);
    for (const hours of [73, -1, 100]) rejects(`UPDATE raids SET signup_close_hours = ${hours} WHERE id = 'r_plain'`);
    for (const hours of [0, 1, 24, 72, 'NULL']) accepts(`UPDATE raids SET signup_close_hours = ${hours} WHERE id = 'r_plain'`);
    for (const value of [2, -1]) rejects(`UPDATE raids SET time_known = ${value} WHERE id = 'r_plain'`);
    for (const value of [0, 1, 'NULL']) accepts(`UPDATE raids SET time_known = ${value} WHERE id = 'r_plain'`);
    rejects("UPDATE raids SET roster_published_by = 'u_nobody' WHERE id = 'r_plain'", /FOREIGN KEY/);
    accepts("UPDATE raids SET roster_published_at = 5, roster_published_by = 'u_b' WHERE id = 'r_plain'");
    // teams
    for (const hours of [73, -1]) rejects(`UPDATE teams SET signup_close_hours = ${hours} WHERE id = 't_1'`);
    rejects("UPDATE teams SET signup_close_hours = NULL WHERE id = 't_1'", /NOT NULL/);
    for (const hours of [0, 24, 72]) accepts(`UPDATE teams SET signup_close_hours = ${hours} WHERE id = 't_1'`);
    // raid_signups: standby is a 'signed' Raidsmith row; standing is a Raidsmith row
    for (const value of [2, -1]) rejects(`UPDATE raid_signups SET standby = ${value} WHERE raid_id = 'r_plain'`);
    rejects("UPDATE raid_signups SET standby = 1 WHERE raid_id = 'r_plain'", /CHECK/, 'standby on a tentative row');
    rejects("UPDATE raid_signups SET standby = 1 WHERE raid_id = 'r_event' AND signup_id = 1", /CHECK/, 'standby on a Raid-Helper row');
    accepts("UPDATE raid_signups SET kind = 'signed', standby = 1 WHERE raid_id = 'r_plain'");
    rejects("UPDATE raid_signups SET kind = 'late' WHERE raid_id = 'r_plain'", /CHECK/, 'changing the kind without clearing standby');
    accepts("UPDATE raid_signups SET kind = 'late', standby = 0 WHERE raid_id = 'r_plain'");
    rejects("UPDATE raid_signups SET standing = 2 WHERE raid_id = 'r_plain'");
    rejects("UPDATE raid_signups SET standing = 1 WHERE raid_id = 'r_event' AND signup_id = 1", /CHECK/, 'standing on a Raid-Helper row');
    accepts("UPDATE raid_signups SET standing = 1 WHERE raid_id = 'r_plain'");
    accepts("UPDATE raid_signups SET standing = 0 WHERE raid_id = 'r_plain'");

    // away_notices
    const away = (extra = {}) => {
      const row = { id: 'an_1', guild_id: 'g_1', player_id: 'p_1', kind: 'away', at_time: null, starts_on: '2027-02-01', ends_on: '2027-02-03', weekday: null, reason: null, created_by: null, ...extra };
      const quote = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      return `INSERT INTO away_notices (id, guild_id, player_id, kind, at_time, starts_on, ends_on, weekday, reason, created_by, created_at, updated_at) VALUES (${[row.id, row.guild_id, row.player_id, row.kind, row.at_time, row.starts_on, row.ends_on, row.weekday, row.reason, row.created_by].map(quote).join(', ')}, 1, 1)`;
    };
    rejects(away({ weekday: null, ends_on: null }), /CHECK/, 'a range with no end');
    rejects(away({ ends_on: '2027-01-31' }), /CHECK/, 'ends before it starts');
    rejects(away({ weekday: 2, ends_on: '2027-01-31' }), /CHECK/, 'a recurring notice that ends before it starts');
    for (const time of ['25:00', '9:00', '12:60', '24:00', 'noon', '12-30']) rejects(away({ kind: 'late', at_time: time }), /CHECK/, `at_time ${time}`);
    rejects(away({ kind: 'late' }), /CHECK/, 'Late with no time');
    rejects(away({ kind: 'leaving' }), /CHECK/, 'Leaving with no time');
    rejects(away({ kind: 'sick' }), /CHECK/);
    rejects(away({ weekday: 7 }), /CHECK/);
    rejects(away({ weekday: -1 }), /CHECK/);
    rejects(away({ starts_on: '2027-02-30' }), /CHECK/);
    rejects(away({ starts_on: 'tomorrow' }), /CHECK/);
    rejects(away({ ends_on: 'soon' }), /CHECK/);
    rejects(away({ reason: 'x'.repeat(121) }), /CHECK/);
    rejects(away({ player_id: 'p_nobody' }), /FOREIGN KEY/, 'an unknown person');
    rejects(away({ player_id: 'p_x' }), /FOREIGN KEY/, 'a person of another guild');
    rejects(away({ guild_id: 'g_nobody' }), /FOREIGN KEY/);
    rejects(away({ created_by: 'u_nobody' }), /FOREIGN KEY/);
    accepts(away({ id: 'an_range' }));
    accepts(away({ id: 'an_range1', starts_on: '2027-02-01', ends_on: '2027-02-01', reason: 'x'.repeat(120) }));
    accepts(away({ id: 'an_recur', weekday: 4, ends_on: null }));
    accepts(away({ id: 'an_recur2', weekday: 0, ends_on: '2027-06-01' }));
    accepts(away({ id: 'an_late', kind: 'late', at_time: '21:00', created_by: 'u_a' }));
    accepts(away({ id: 'an_left', kind: 'leaving', at_time: '23:59', weekday: 5, ends_on: null }));
    rejects(away({ id: 'an_range' }), /UNIQUE/, 'a duplicate id');

    // standing_signups
    const standing = (extra = {}) => {
      const row = { id: 'sg_1', guild_id: 'g_1', team_id: 't_1', player_id: 'p_1', weekday: 2, kind: 'signed', character_id: 'c_1', ...extra };
      const quote = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`);
      return `INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES (${[row.id, row.guild_id, row.team_id, row.player_id, row.weekday, row.kind, row.character_id].map(quote).join(', ')}, 1, 1)`;
    };
    rejects(standing({ weekday: 7 }), /CHECK/);
    rejects(standing({ weekday: -1 }), /CHECK/);
    for (const kind of ['tentative', 'bench', 'absence', 'standby']) rejects(standing({ kind }), /CHECK/, `kind ${kind}`);
    rejects(standing({ team_id: 't_x' }), /FOREIGN KEY/, 'a team of another guild');
    rejects(standing({ player_id: 'p_x' }), /FOREIGN KEY/, 'a person of another guild');
    rejects(standing({ character_id: 'c_nobody' }), /FOREIGN KEY/);
    accepts(standing());
    rejects(standing({ id: 'sg_dup' }), /UNIQUE/, 'the same person, team and weekday twice');
    accepts(standing({ id: 'sg_2', weekday: 4, kind: 'late', character_id: null }));
    accepts(standing({ id: 'sg_3', player_id: 'p_2', character_id: 'c_2' }));

    // raid_roster
    const roster = (extra = {}) => {
      const row = { raid_id: 'r_plain', guild_id: 'g_1', name_key: 'aldric', name: 'Aldric', player_id: 'p_1', group_number: 1, class: 'WARRIOR', spec: 'Arms', status: 'pending', prev_kind: null, ...extra };
      const quote = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`);
      return `INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, class, spec, status, prev_kind) VALUES (${[row.raid_id, row.guild_id, row.name_key, row.name, row.player_id, row.group_number, row.class, row.spec, row.status, row.prev_kind].map(quote).join(', ')})`;
    };
    rejects(roster({ group_number: 9 }), /CHECK/);
    rejects(roster({ group_number: -1 }), /CHECK/);
    rejects(roster({ status: 'maybe' }), /CHECK/);
    rejects(roster({ class: 'ROBOT' }), /CHECK/);
    rejects(roster({ prev_kind: 'yes' }), /CHECK/);
    rejects(roster({ name: '' }), /CHECK/);
    rejects(roster({ raid_id: 'r_nobody' }), /FOREIGN KEY/);
    rejects(roster({ guild_id: 'g_2', player_id: null }), /FOREIGN KEY/, 'a raid of another guild');
    rejects(roster({ player_id: 'p_x' }), /roster_person_guild/, 'a person of another guild');
    rejects(roster({ player_id: 'p_nobody' }), /roster_person_guild|FOREIGN KEY/, 'an unknown person');
    accepts(roster());
    rejects(roster({ player_id: 'p_2' }), /UNIQUE/, 'a character name seated twice');
    rejects("UPDATE raid_roster SET player_id = 'p_x' WHERE name_key = 'aldric'", /roster_person_guild/);
    accepts(roster({ name_key: 'brindle', name: 'Brindle', player_id: 'p_2', group_number: 0, class: 'MAGE', spec: null, status: 'declined', prev_kind: 'standby' }));
    accepts(roster({ name_key: 'stranger', name: 'Stranger', player_id: null, class: null, spec: null }));
    assert.equal(db.sqlite.prepare("SELECT seq FROM raid_roster WHERE name_key = 'aldric'").get().seq, 0, 'seq defaults to 0');
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

check('migration 0015: deleting a person, a team, a raid, a character, an account or the guild cascades into the new tables', async () => {
  const seed = (db) => {
    db.sqlite.exec(`
      INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_by, created_at, updated_at) VALUES
        ('an_1', 'g_1', 'p_1', 'away', '2027-02-01', '2027-02-03', 'u_b', 1, 1), ('an_2', 'g_1', 'p_2', 'away', '2027-02-01', '2027-02-03', NULL, 1, 1);
      INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES
        ('sg_1', 'g_1', 't_1', 'p_1', 2, 'signed', 'c_1', 1, 1), ('sg_2', 'g_1', 't_1', 'p_2', 2, 'late', 'c_2', 1, 1), ('sg_3', 'g_1', 't_2', 'p_2', 4, 'signed', NULL, 1, 1);
      INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, class, status) VALUES
        ('r_plain', 'g_1', 'aldric', 'Aldric', 'p_1', 1, 'WARRIOR', 'confirmed'), ('r_plain', 'g_1', 'brindle', 'Brindle', 'p_2', 0, 'MAGE', 'pending'),
        ('r_event', 'g_1', 'aldric', 'Aldric', 'p_1', 2, 'WARRIOR', 'pending');
      UPDATE raids SET roster_published_at = 9, roster_published_by = 'u_b' WHERE id = 'r_plain';
    `);
  };
  const n = (db, sql) => db.sqlite.prepare(sql).get().n;
  const fresh = () => {
    const db = populatedBefore0015();
    db.sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, '0015_wave2.sql'), 'utf8'));
    seed(db);
    assert.deepEqual([n(db, 'SELECT COUNT(*) AS n FROM away_notices'), n(db, 'SELECT COUNT(*) AS n FROM standing_signups'), n(db, 'SELECT COUNT(*) AS n FROM raid_roster')], [2, 3, 3]);
    return db;
  };

  let db = fresh();
  try {
    // A person: their notices and standing sign-ups go; their seats stay on the roster, unmatched (the snapshot keeps its names).
    db.sqlite.exec("DELETE FROM attendance WHERE player_id = 'p_1'; DELETE FROM raid_manual WHERE player_id = 'p_1'; DELETE FROM raid_signups WHERE player_id = 'p_1'");
    db.sqlite.exec("DELETE FROM players WHERE id = 'p_1'");
    assert.deepEqual(db.sqlite.prepare('SELECT id FROM away_notices ORDER BY id').all().map((r) => r.id), ['an_2']);
    assert.deepEqual(db.sqlite.prepare('SELECT id FROM standing_signups ORDER BY id').all().map((r) => r.id), ['sg_2', 'sg_3']);
    assert.deepEqual(db.sqlite.prepare('SELECT raid_id, name_key, player_id FROM raid_roster ORDER BY raid_id, name_key').all().map((r) => [r.raid_id, r.name_key, r.player_id]),
      [['r_event', 'aldric', null], ['r_plain', 'aldric', null], ['r_plain', 'brindle', 'p_2']]);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }

  db = fresh();
  try {
    // A character: the standing sign-up stays and forgets the choice.
    db.sqlite.exec("DELETE FROM raid_signups WHERE character_id = 'c_2'; DELETE FROM characters WHERE id = 'c_2'");
    assert.deepEqual(db.sqlite.prepare("SELECT id, character_id FROM standing_signups WHERE player_id = 'p_2' ORDER BY id").all().map((r) => [r.id, r.character_id]), [['sg_2', null], ['sg_3', null]]);
  } finally { db.close(); }

  db = fresh();
  try {
    // A team that nothing else holds: its standing sign-ups go with it (a raid or a character blocks the delete, as before).
    db.sqlite.exec("DELETE FROM raids WHERE team_id = 't_2'; DELETE FROM teams WHERE id = 't_2'");
    assert.deepEqual(db.sqlite.prepare('SELECT id FROM standing_signups ORDER BY id').all().map((r) => r.id), ['sg_1', 'sg_2']);
    assert(/FOREIGN KEY/.test(tryExec(db, "DELETE FROM teams WHERE id = 't_1'")), 'a team with raids and characters still cannot be deleted');
  } finally { db.close(); }

  db = fresh();
  try {
    // A raid: its published roster goes, the other raid's stays.
    db.sqlite.exec("DELETE FROM raids WHERE id = 'r_plain'");
    assert.deepEqual(db.sqlite.prepare('SELECT raid_id, name_key FROM raid_roster').all().map((r) => `${r.raid_id}/${r.name_key}`), ['r_event/aldric']);
  } finally { db.close(); }

  db = fresh();
  try {
    // The account that published a roster or wrote a notice: the rows stay, the author is forgotten.
    db.sqlite.exec("DELETE FROM users WHERE id = 'u_b'");
    assert.equal(db.sqlite.prepare("SELECT roster_published_by AS v FROM raids WHERE id = 'r_plain'").get().v, null);
    assert.equal(db.sqlite.prepare("SELECT roster_published_at AS v FROM raids WHERE id = 'r_plain'").get().v, 9);
    assert.equal(db.sqlite.prepare("SELECT created_by AS v FROM away_notices WHERE id = 'an_1'").get().v, null);
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM away_notices'), 2);
  } finally { db.close(); }

  db = fresh();
  try {
    // The guild: everything of the wave goes with it.
    db.sqlite.exec("DELETE FROM characters WHERE guild_id = 'g_1'; DELETE FROM guilds WHERE id = 'g_1'");
    for (const table of NEW_TABLES) assert.equal(n(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, table);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

check('migration 0015: the id prefixes an (away notice) and sg (standing sign-up) exist', async () => {
  const { newId, isId } = await load('worker/ids.js');
  const bytes = (length) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255);
  for (const prefix of ['an', 'sg']) {
    const id = newId(prefix, bytes);
    assert(id.startsWith(`${prefix}_`) && id.length === 25, id);
    assert(isId(prefix, id));
    assert(!isId(prefix === 'an' ? 'sg' : 'an', id));
    assert(!isId(prefix, `${prefix}_short`));
  }
});

// ---------------------------------------------------------------------------
// Raid sizes (B1): the zone sizes, the effective size, the team's size setting, a raid's own size, "short on sign-ups"

// Alpha (= A) and Bravo (= B); Bob is the Officer, Carol leads Alpha, Dave leads Bravo, Erin / Gina / Hank are Members. The clock is
// 2027-01-16 12:00Z (Saturday). Raids are made by Bob on dates after it.
async function laneWorld(opts = {}) {
  const s = await scenario({ teams: 2, ...opts });
  s.A = s.teams[0];
  s.B = s.teams[1];
  s.raid = (id, route = '') => `/raids/${id}${route}`;
  s.makeRaid = async (body, who = 'bob') => {
    const r = await s.call(who, 'POST', '/raids', body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.raid;
  };
  s.audits = async (action) => (await s.w.rows('SELECT entity_id, before, after FROM audit_log WHERE action = ? ORDER BY rowid', action))
    .map((row) => ({ entity: row.entity_id, before: row.before === null ? null : JSON.parse(row.before), after: row.after === null ? null : JSON.parse(row.after) }));
  // Raid-Helper-style sign-up rows with no person: n of one kind, with sign-up ids from `first` (the merged list counts them like any other).
  s.fill = (raidId, n, kind = 'signed', first = 100) => {
    const values = Array.from({ length: n }, (_, i) => `('${raidId}', 'raid_helper', ${first + i}, 'x${i}', '${kind}', ${first + i}, '${s.guildId}')`).join(', ');
    exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id) VALUES ${values}`);
  };
  s.lows = async () => {
    const r = await s.call('bob', 'GET', '/attention');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return Object.fromEntries(r.json.items.filter((item) => item.kind === 'low_signups').map((item) => [item.raidId, [item.expected, item.size]]));
  };
  return s;
}

check('sizes: the zone sizes of the Worker match the raid sizes of the three rules files, and the pure functions follow the precedence', async () => {
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  for (const file of ['catalog', 'tbc', 'classic', 'forever']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'rules', `${file}.js`), 'utf8'), sandbox);
  const { RAID_ZONE_SIZES, RAID_ZONES, RAID_SIZES, zoneSize, zonesFor, isRaidSize, effectiveRaidSize, raidSizeFields } = await load('worker/raid-zones.js');
  for (const version of ['tbc', 'classic', 'forever']) {
    const raids = Object.values(sandbox.RulesData[version].raids).filter((raid) => raid.tier !== 'Planning templates');
    assert.deepEqual(Object.entries(RAID_ZONE_SIZES[version]), raids.map((raid) => [raid.name, raid.size]), `${version}: every zone with the size the rules give it, in order`);
    assert.deepEqual(RAID_ZONES[version], raids.map((raid) => raid.name), `${version}: the zone list is the keys of the size table`);
    for (const raid of raids) assert.equal(zoneSize(version, raid.name), raid.size, `${version} ${raid.name}`);
    for (const size of Object.values(RAID_ZONE_SIZES[version])) assert(RAID_SIZES.includes(size), `${version}: ${size} is a size a raid can have`);
  }
  assert.deepEqual(RAID_SIZES, [10, 20, 25, 40]);
  // The three examples of the design.
  assert.deepEqual([zoneSize('tbc', 'Karazhan'), zoneSize('tbc', 'Zul\'Aman'), zoneSize('tbc', 'Sunwell Plateau')], [10, 10, 25]);
  assert.deepEqual([zoneSize('classic', 'Zul\'Gurub'), zoneSize('classic', 'Ruins of Ahn\'Qiraj'), zoneSize('classic', 'Molten Core')], [20, 20, 40]);
  assert.deepEqual([zoneSize('forever', 'Barrow Deeps'), zoneSize('forever', 'Hyjal Summit'), zoneSize('forever', 'Onyxia\'s Lair')], [10, 20, 40]);
  assert.equal(zoneSize('tbc', 'Hyjal Summit'), 25, 'the same zone name has the size of the guild\'s version');
  // Not a zone of the version, no zone, no version, and names that are properties of every object.
  for (const [version, zone] of [['tbc', 'Molten Core'], ['tbc', null], ['tbc', undefined], ['tbc', ''], ['tbc', '__proto__'], ['tbc', 'constructor'], ['nope', 'Karazhan'], [undefined, 'Karazhan'], ['__proto__', 'Karazhan']]) {
    assert.equal(zoneSize(version, zone), null, `${version} / ${zone}`);
  }
  assert.deepEqual(zonesFor('tbc'), RAID_ZONES.tbc);
  assert.deepEqual(zonesFor('nope'), []);
  for (const size of RAID_SIZES) assert.equal(isRaidSize(size), true);
  for (const bad of [15, 0, 5, 26, 41, -10, 10.5, '10', null, undefined, NaN, [10], {}]) assert.equal(isRaidSize(bad), false, String(bad));
  // The precedence: the raid's own size, else the zone's, else the team's.
  assert.equal(effectiveRaidSize({ size: 20, zone: 'Karazhan' }, 25, 'tbc'), 20, 'an override beats the zone');
  assert.equal(effectiveRaidSize({ size: null, zone: 'Karazhan' }, 25, 'tbc'), 10, 'the zone beats the team');
  assert.equal(effectiveRaidSize({ size: null, zone: 'Gruul\'s Lair' }, 10, 'tbc'), 25, 'a 25-player zone in a 10-player team');
  assert.equal(effectiveRaidSize({ size: null, zone: null }, 40, 'classic'), 40, 'no zone: the team\'s');
  assert.equal(effectiveRaidSize({ size: null, zone: 'Some report zone' }, 20, 'forever'), 20, 'a zone the version does not know: the team\'s');
  assert.equal(effectiveRaidSize({ size: undefined, zone: 'Hyjal Summit' }, 25, 'forever'), 20);
  assert.equal(effectiveRaidSize({ size: 15, zone: 'Karazhan' }, 25, 'tbc'), 10, 'a stored size that is no size (the CHECK forbids it) is ignored');
  assert.deepEqual(raidSizeFields({ size: null, zone: 'Karazhan' }, 25, 'tbc'), { size: 10, sizeOverride: null });
  assert.deepEqual(raidSizeFields({ size: 20, zone: 'Karazhan' }, 25, 'tbc'), { size: 20, sizeOverride: 20 });
  assert.deepEqual(raidSizeFields({ size: undefined, zone: undefined }, 25, 'tbc'), { size: 25, sizeOverride: null });
});

check('sizes: a team\'s size is editable (10 / 20 / 25 / 40), alone or with the rest, audited as team.size, for those who manage teams', async () => {
  const s = await laneWorld();
  const patch = (who, body, team = s.A) => s.call(who, 'PATCH', `/teams/${team}`, body);
  // The default, and the create body.
  const created = await s.call('alice', 'POST', '/teams', { name: 'Forty', size: 40 });
  assert.deepEqual([created.status, created.json.team.size], [201, 40]);
  assert.equal((await s.call('alice', 'POST', '/teams', { name: 'Plain' })).json.team.size, 25, 'left out: 25 as before');
  for (const [i, size] of [15, 0, '20', null, 25.5, [20], 'big'].entries()) {
    const r = await s.call('alice', 'POST', '/teams', { name: `Bad ${i}`, size });
    assert.deepEqual([r.status, r.json.error, r.json.field], [400, 'bad_request', 'size'], `create size ${JSON.stringify(size)}`);
  }
  assert.equal(await s.w.count('teams', "name LIKE 'Bad %'"), 0, 'a refused create writes nothing');

  // size alone is a valid body; the team answers with it; one audit row with the sizes before and after.
  const r = await patch('alice', { size: 20 });
  assert.deepEqual([r.status, r.json.team.size, r.json.team.name], [200, 20, 'Alpha']);
  assert.deepEqual(await s.audits('team.size'), [{ entity: s.A, before: { size: 25 }, after: { size: 20 } }]);
  assert.equal((await s.w.rows('SELECT size FROM teams WHERE id = ?', s.A))[0].size, 20);
  assert.equal((await s.call('alice', 'GET', '')).json.teams.find((team) => team.id === s.A).size, 20, 'the guild read shows it');
  // The same size again changes nothing and writes nothing.
  assert.equal((await patch('alice', { size: 20 })).status, 200);
  assert.equal((await s.audits('team.size')).length, 1);
  // With other fields: every change has its own row.
  const both = await patch('bob', { name: 'Alpha Prime', size: 10 });
  assert.deepEqual([both.status, both.json.team.name, both.json.team.size], [200, 'Alpha Prime', 10]);
  assert.deepEqual((await s.audits('team.size')).map((a) => [a.before.size, a.after.size]), [[25, 20], [20, 10]]);
  assert.equal((await s.audits('team.rename')).length, 1);
  for (const size of [10, 20, 25, 40]) assert.equal((await patch('alice', { size })).json.team.size, size);
  assert.equal((await patch('alice', { size: 25 })).json.team.size, 25);

  // Validation: 400 with field 'size', nothing written.
  const before = (await s.audits('team.size')).length;
  for (const size of [15, 0, -10, 41, '20', null, 25.5, [20], {}, true]) {
    const bad = await patch('alice', { size });
    assert.deepEqual([bad.status, bad.json.error, bad.json.field], [400, 'bad_request', 'size'], JSON.stringify(size));
  }
  assert.equal((await s.audits('team.size')).length, before);
  assert.equal((await s.w.rows('SELECT size FROM teams WHERE id = ?', s.A))[0].size, 25);
  const empty = await patch('alice', {});
  assert.deepEqual([empty.status, empty.json.message], [400, 'Send a name, archived, size, or any of them.']);
  // A bad size next to a good name writes neither.
  assert.equal((await patch('alice', { name: 'Should not stick', size: 15 })).status, 400);
  assert.equal((await s.w.rows('SELECT name FROM teams WHERE id = ?', s.A))[0].name, 'Alpha Prime');

  // Who: the right to manage teams (Guild Master, Officer). A Team Lead of the team and a Member cannot; signed out is 401.
  for (const who of ['carol', 'erin']) assert.deepEqual([who, (await patch(who, { size: 40 })).status], [who, 403]);
  assert.equal((await s.w.call(newJar(), 'PATCH', `${s.guildPath}/teams/${s.A}`, { size: 40 })).status, 401);
  assert.equal((await s.w.rows('SELECT size FROM teams WHERE id = ?', s.A))[0].size, 25);
});

check('sizes: a raid is made with an optional size of its own; null or nothing means automatic', async () => {
  const s = await laneWorld();
  const own = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10', startTime: '20:00', size: 10 });
  assert.deepEqual([own.size, own.sizeOverride], [10, 10]);
  const auto = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-11', startTime: '20:00' });
  assert.deepEqual([auto.size, auto.sizeOverride], [25, null]);
  const nul = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-12', startTime: '20:00', size: null });
  assert.deepEqual([nul.size, nul.sizeOverride], [25, null]);
  assert.deepEqual((await s.w.rows('SELECT raid_on, size FROM raids ORDER BY raid_on')).map((r) => [r.raid_on, r.size]), [['2027-02-10', 10], ['2027-02-11', null], ['2027-02-12', null]], 'stored only when sent');
  for (const [i, size] of [15, 0, '20', 25.5, [10], 'x', false].entries()) {
    const r = await s.call('bob', 'POST', '/raids', { teamId: s.A, raidOn: `2027-03-0${i + 1}`, size });
    assert.deepEqual([r.status, r.json.error, r.json.field], [400, 'bad_request', 'size'], JSON.stringify(size));
  }
  assert.equal(await s.w.count('raids'), 3, 'a refused create writes nothing');
  // A zone with a size and an explicit one: the explicit one wins.
  const kara = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-13', startTime: '20:00', zone: 'Karazhan', size: 20 });
  assert.deepEqual([kara.zone, kara.size, kara.sizeOverride], ['Karazhan', 20, 20]);
  // A Team Lead of ANOTHER team still cannot create it.
  assert.equal((await s.call('dave', 'POST', '/raids', { teamId: s.A, raidOn: '2027-02-20', size: 10 })).status, 403);
});

check('sizes: the effective size is the raid\'s own, else its zone\'s in the guild\'s version, else the team\'s - on the detail, both lists, the sign-ups view, the planner seed and the Raids read', async () => {
  const s = await laneWorld();
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.A}`, { size: 40 })).status, 200);
  const kara = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10', startTime: '20:00', zone: 'Karazhan' });          // the zone: 10
  const gruul = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-11', startTime: '20:00', zone: 'Gruul\'s Lair' });    // the zone: 25 (not the team's 40)
  const none = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-12', startTime: '20:00' });                            // the team: 40
  const own = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-13', startTime: '20:00', zone: 'Karazhan', size: 20 }); // its own: 20
  const past = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-05', startTime: '20:00', zone: 'Zul\'Aman' });         // a past raid: 10
  assert.deepEqual([kara.size, gruul.size, none.size, own.size, past.size], [10, 25, 40, 20, 10], 'the create reply is the detail');
  assert.deepEqual([kara.sizeOverride, gruul.sizeOverride, none.sizeOverride, own.sizeOverride, past.sizeOverride], [null, null, null, 20, null]);

  for (const [raid, size, override] of [[kara, 10, null], [gruul, 25, null], [none, 40, null], [own, 20, 20], [past, 10, null]]) {
    const detail = (await s.call('bob', 'GET', s.raid(raid.id))).json.raid;
    assert.deepEqual([detail.size, detail.sizeOverride], [size, override], `detail ${raid.zone}`);
    for (const who of ['erin', 'carol']) {
      const view = await s.call(who, 'GET', s.raid(raid.id, '/signups'));
      assert.deepEqual([view.json.raid.size, view.json.raid.sizeOverride], [size, override], `sign-ups view of ${who}`);
    }
    const seed = (await s.call('bob', 'GET', s.raid(raid.id, '/planner'))).json.raid;
    assert.deepEqual([seed.size, seed.sizeOverride], [size, override], `planner seed ${raid.zone}`);
  }
  // The Raids read: the team's size, and the size of every row, upcoming and past.
  const list = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual([list.team.size, list.team.name], [40, 'Alpha']);
  assert.deepEqual(list.upcoming.map((row) => [row.zone, row.size, row.sizeOverride]), [['Karazhan', 10, null], ['Gruul\'s Lair', 25, null], [null, 40, null], ['Karazhan', 20, 20]]);
  assert.deepEqual(list.raids.map((row) => [row.zone, row.size, row.sizeOverride]), [['Zul\'Aman', 10, null]]);
  // Another team keeps its own size.
  const bravo = await s.makeRaid({ teamId: s.B, raidOn: '2027-02-10', startTime: '20:00' });
  assert.equal(bravo.size, 25);
  assert.equal((await s.call('erin', 'GET', `/raids?team=${s.B}`)).json.team.size, 25);
  // A zone from a log that the version does not know falls back to the team's size.
  exec(s.w, `UPDATE raids SET zone = 'Some Other Zone' WHERE id = '${none.id}'`);
  assert.equal((await s.call('bob', 'GET', s.raid(none.id))).json.raid.size, 40);
});

check('sizes: the same zone has the size of the guild\'s version (Classic and Forever)', async () => {
  const forever = await laneWorld({ guildBody: { gameVersion: 'forever', realm: 'Normal' } });
  const f = async (zone, day) => (await forever.makeRaid({ teamId: forever.A, raidOn: `2027-02-${day}`, startTime: '20:00', zone })).size;
  assert.deepEqual([await f('Barrow Deeps', 10), await f('Hyjal Summit', 11), await f('Onyxia\'s Lair', 12)], [10, 20, 40]);
  const classic = await laneWorld({ guildBody: { gameVersion: 'classic', realm: 'Mankrik' } });
  const c = async (zone, day) => (await classic.makeRaid({ teamId: classic.A, raidOn: `2027-02-${day}`, startTime: '20:00', zone })).size;
  assert.deepEqual([await c('Zul\'Gurub', 10), await c('Ruins of Ahn\'Qiraj', 11), await c('Molten Core', 12)], [20, 20, 40]);
  const tbc = await laneWorld();
  assert.equal((await tbc.makeRaid({ teamId: tbc.A, raidOn: '2027-02-10', startTime: '20:00', zone: 'Hyjal Summit' })).size, 25, 'Hyjal Summit is 25 in TBC and 20 in Forever');
});

check('sizes: PATCH /raids/:rid sets or clears a raid\'s size and sign-up deadline - raids.edit on the raid\'s team, audited as raid.settings, nothing recalculated', async () => {
  const s = await laneWorld();
  const raid = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10', startTime: '20:00', zone: 'Karazhan' });
  const patch = (who, body, id = raid.id) => s.call(who, 'PATCH', s.raid(id), body);
  const row = async () => (await s.w.rows('SELECT size, signup_close_hours, version, policy_fp, updated_at FROM raids WHERE id = ?', raid.id))[0];
  const start = await row();

  // size alone: the reply is the raid detail with the new size.
  s.w.advance(5000);
  const r = await patch('bob', { size: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.raid.id, r.json.raid.size, r.json.raid.sizeOverride, r.json.raid.zone], [raid.id, 20, 20, 'Karazhan']);
  assert.deepEqual(Object.keys(r.json).sort(), Object.keys((await s.call('bob', 'GET', s.raid(raid.id))).json).sort(), 'the same shape as the detail read');
  let now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [20, null]);
  assert.deepEqual([now.version, now.policy_fp], [start.version, start.policy_fp], 'no recompute is needed: the version and the fingerprint are untouched');
  assert(now.updated_at > start.updated_at);
  assert.deepEqual(await s.audits('raid.settings'), [{ entity: raid.id, before: { size: null, signupCloseHours: null }, after: { size: 20, signupCloseHours: null } }]);

  // signupCloseHours alone keeps the size; both together; null clears one and keeps the other.
  assert.equal((await patch('bob', { signupCloseHours: 12 })).status, 200);
  now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [20, 12]);
  assert.equal((await patch('bob', { size: 40, signupCloseHours: 0 })).status, 200);
  now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [40, 0], '0 is a real value: closes at the start');
  const cleared = await patch('bob', { size: null });
  assert.deepEqual([cleared.status, cleared.json.raid.size, cleared.json.raid.sizeOverride], [200, 10, null], 'back to the zone\'s size');
  now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [null, 0]);
  assert.equal((await patch('bob', { signupCloseHours: null })).status, 200);
  now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [null, null]);
  const audits = await s.audits('raid.settings');
  assert.equal(audits.length, 5);
  assert.deepEqual(audits[4], { entity: raid.id, before: { size: null, signupCloseHours: 0 }, after: { size: null, signupCloseHours: null } });
  // A change that changes nothing writes nothing and still answers the detail.
  assert.equal((await patch('bob', { size: null, signupCloseHours: null })).status, 200);
  assert.equal((await s.audits('raid.settings')).length, 5);

  // Validation: 400 with the field, nothing written (not even the valid half of the body).
  for (const [body, field] of [
    [{ size: 15 }, 'size'], [{ size: 0 }, 'size'], [{ size: '20' }, 'size'], [{ size: 25.5 }, 'size'], [{ size: true }, 'size'],
    [{ signupCloseHours: 73 }, 'signupCloseHours'], [{ signupCloseHours: -1 }, 'signupCloseHours'], [{ signupCloseHours: 1.5 }, 'signupCloseHours'],
    [{ signupCloseHours: '24' }, 'signupCloseHours'], [{ signupCloseHours: true }, 'signupCloseHours'], [{ size: 20, signupCloseHours: 100 }, 'signupCloseHours'], [{ size: 15, signupCloseHours: 3 }, 'size'],
  ]) {
    const bad = await patch('bob', body);
    assert.deepEqual([bad.status, bad.json.error, bad.json.field], [400, 'bad_request', field], JSON.stringify(body));
  }
  for (const body of [{}, { other: 1 }]) {
    const none = await patch('bob', body);
    assert.deepEqual([none.status, none.json.error, none.json.message], [400, 'bad_request', 'Send size, signupCloseHours, or both.'], JSON.stringify(body));
  }
  now = await row();
  assert.deepEqual([now.size, now.signup_close_hours], [null, null]);
  assert.equal((await s.audits('raid.settings')).length, 5);

  // Who: raids.edit on the raid's team. The Officer, the Guild Master and the Team Lead of Alpha; not a Member, not Bravo's Team Lead.
  for (const [who, status] of [['alice', 200], ['bob', 200], ['carol', 200], ['erin', 403], ['dave', 403], ['hank', 403]]) {
    assert.deepEqual([who, (await patch(who, { size: 20 })).status], [who, status]);
  }
  assert.equal((await s.w.call(newJar(), 'PATCH', `${s.guildPath}/raids/${raid.id}`, { size: 10 })).status, 401);
  assert.equal((await patch('bob', { size: 10 }, 'r_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  // Another guild's raid is a 404 for this guild's officers.
  exec(s.w, "INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g_AAAAAAAAAAAAAAAAAAAAAA', 'Other', 'Mankrik', 'realm', 'US', 'srv-other', 'UTC', 'tbc', 1); INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t_AAAAAAAAAAAAAAAAAAAAAA', 'g_AAAAAAAAAAAAAAAAAAAAAA', 'Elsewhere', 25, 0, 1); INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r_BBBBBBBBBBBBBBBBBBBBBB', 'g_AAAAAAAAAAAAAAAAAAAAAA', 't_AAAAAAAAAAAAAAAAAAAAAA', '2027-02-10', 1, 1, 1)");
  assert.equal((await patch('bob', { size: 10 }, 'r_BBBBBBBBBBBBBBBBBBBBBB')).status, 404);
  // A past raid can be changed too (a correction), and Bravo's Team Lead edits Bravo's raid.
  const old = await s.makeRaid({ teamId: s.B, raidOn: '2027-01-05' });
  assert.equal((await patch('bob', { size: 40 }, old.id)).json.raid.size, 40);
  assert.equal((await patch('dave', { size: 10 }, old.id)).json.raid.size, 10);
});

check('sizes: Needs attention compares sign-ups with the raid\'s own size - a Karazhan raid of a 25 team needs 10, a Forever Hyjal Summit raid 20', async () => {
  const { buildAttention } = await load('worker/attention.js');
  // The pure half: row.size (the effective size) wins, the team's size is the fallback.
  const NOW = Date.parse('2027-01-16T12:00:00Z');
  const teams = [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }];
  const base = { today: '2027-01-16', now: NOW, teams, allowsTeam: () => true, granted: () => true, flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], watch: [] };
  const upcoming = (id, extra) => ({ id, team_id: 't_a', raid_on: '2027-01-18', starts_at: NOW + 2 * 86400000, zone: null, title: null, event_title: null, signups_locked: 1, n_in: 9, ...extra });
  const built = buildAttention({ ...base, upcoming: [upcoming('u_team'), upcoming('u_ten', { size: 10 }), upcoming('u_full', { size: 9 }), upcoming('u_nullsize', { size: null })] });
  assert.deepEqual(built.items.map((item) => [item.raidId, item.expected, item.size]).sort(), [['u_nullsize', 9, 25], ['u_ten', 9, 10], ['u_team', 9, 25]].sort(), 'size null / left out = the team\'s; 9 of 9 is not short');

  // The route: sign-ups are counted in the merged list, the size comes from the raid.
  const s = await laneWorld();
  const kara = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-18', startTime: '20:00', zone: 'Karazhan' });
  const gruul = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00', zone: 'Gruul\'s Lair' });
  const own = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-20', startTime: '20:00', zone: 'Karazhan', size: 20 });
  const bare = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-21', startTime: '20:00' });
  for (const raid of [kara, gruul, own, bare]) s.fill(raid.id, 9);
  assert.deepEqual(await s.lows(), { [kara.id]: [9, 10], [gruul.id]: [9, 25], [own.id]: [9, 20], [bare.id]: [9, 25] }, '9 signed: short against 10 / 25 / 20 / 25');
  // One late sign-up fills Karazhan (9 + 1 of 10); 16 more fill Gruul's Lair (25 of 25).
  s.fill(kara.id, 1, 'late', 200);
  s.fill(gruul.id, 16, 'signed', 300);
  assert.deepEqual(await s.lows(), { [own.id]: [9, 20], [bare.id]: [9, 25] }, 'a full raid is not listed');
  // Resizing the raid with PATCH changes the verdict at once; so does the team's size (only for the raid that has no size of its own).
  assert.equal((await s.call('bob', 'PATCH', s.raid(kara.id), { size: 20 })).status, 200);
  assert.deepEqual((await s.lows())[kara.id], [10, 20]);
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.A}`, { size: 10 })).status, 200);
  const resized = await s.lows();
  assert.deepEqual([resized[bare.id], resized[own.id], resized[kara.id]], [[9, 10], [9, 20], [10, 20]], 'the team raids 10 now: 9 of 10 is short; the raids with a size of their own keep it');
});

check('sizes: Needs attention in a Forever guild - Hyjal Summit needs 20, Barrow Deeps 10, Onyxia\'s Lair 40', async () => {
  const s = await laneWorld({ guildBody: { gameVersion: 'forever', realm: 'Normal' } });
  const hyjal = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-18', startTime: '20:00', zone: 'Hyjal Summit' });
  const barrow = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00', zone: 'Barrow Deeps' });
  const ony = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-20', startTime: '20:00', zone: 'Onyxia\'s Lair' });
  s.fill(hyjal.id, 19);
  s.fill(barrow.id, 9);
  s.fill(ony.id, 30);
  assert.deepEqual(await s.lows(), { [hyjal.id]: [19, 20], [barrow.id]: [9, 10], [ony.id]: [30, 40] });
  exec(s.w, `DELETE FROM raid_signups WHERE raid_id = '${hyjal.id}'`);
  s.fill(hyjal.id, 20);
  assert.equal((await s.lows())[hyjal.id], undefined, '20 of 20 is not short');
});

// ---------------------------------------------------------------------------
// The sign-up deadline (B2): a member's window closes N hours before the start; the team's number, a raid's own number, officers never bound

const HOUR = 3600000;

// Alpha's raid on 2027-02-10 20:00 (New York) with Eliora (Erin's person) and Gorrim (Gina's) on Alpha. s.mine writes Erin's own sign-up.
async function deadlineWorld() {
  const s = await laneWorld();
  s.p = {};
  const person = async (key, name, classId, spec, discord) => {
    const made = await addPerson(s, 'bob', s.A, name, { class: classId, mainSpec: spec, offSpec: null });
    s.p[key] = made.person.id;
    exec(s.w, `UPDATE players SET discord_user_id = '${discord}' WHERE id = '${made.person.id}'`);
  };
  await person('eliora', 'Eliora', 'PRIEST', 'Holy', PEOPLE.erin.id);
  await person('gorrim', 'Gorrim', 'PALADIN', 'Protection', PEOPLE.gina.id);
  const raid = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10', startTime: '20:00' });
  s.rid = raid.id;
  s.startsAt = raid.startsAt;
  s.path = (route = '') => s.raid(s.rid, route);
  s.mine = (body, who = 'erin') => s.call(who, 'PUT', s.path('/signup'), body);
  s.dropMine = (who = 'erin') => s.call(who, 'DELETE', s.path('/signup'), {});
  s.view = async (who = 'erin') => (await s.call(who, 'GET', s.path('/signups'))).json;
  s.teamHours = async (hours, team = s.A) => {
    const r = await s.call('bob', 'PUT', `/teams/${team}/schedule`, { slots: [], signupCloseHours: hours });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  s.raidHours = async (hours) => {
    const r = await s.call('bob', 'PATCH', s.path(), { signupCloseHours: hours });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  s.signedKind = async () => ((await s.w.rows("SELECT kind FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith'", s.rid))[0] || {}).kind || null;
  // Runs `fn` with a change to the raid landing between the request's read and its write statement (the batch that holds `pattern`).
  s.withRace = async (pattern, sql, fn) => {
    const real = s.w.db.batch;
    s.w.db.batch = function patched(statements) {
      if (statements.some((statement) => pattern.test(statement.sql))) exec(s.w, sql);
      return real.call(this, statements);
    };
    try { return await fn(); } finally { s.w.db.batch = real; }
  };
  return s;
}

check('deadline: closedReason and its helpers - the start, then the lock, then the deadline; the raid\'s number beats the team\'s', async () => {
  const { closedReason, closeHoursOf, closesAtOf, isCloseHours, MAX_CLOSE_HOURS } = await load('worker/signups-data.js');
  const START = Date.parse('2027-02-11T01:00:00Z');
  assert.equal(MAX_CLOSE_HOURS, 72);
  for (const ok of [0, 1, 24, 72]) assert.equal(isCloseHours(ok), true);
  for (const bad of [-1, 73, 1.5, '24', null, undefined, NaN, true]) assert.equal(isCloseHours(bad), false, String(bad));
  // The effective hours: the raid's own (0 counts), else the team's, else 0.
  assert.equal(closeHoursOf({ signup_close_hours: null, team_close_hours: 24 }), 24);
  assert.equal(closeHoursOf({ signup_close_hours: 0, team_close_hours: 24 }), 0, 'a raid\'s 0 beats the team\'s 24');
  assert.equal(closeHoursOf({ signup_close_hours: 48, team_close_hours: 24 }), 48, 'longer than the team\'s');
  assert.equal(closeHoursOf({ signup_close_hours: undefined, team_close_hours: undefined }), 0);
  assert.equal(closeHoursOf({}), 0);
  assert.equal(closesAtOf({ starts_at: START, signup_close_hours: null, team_close_hours: 24 }), START - 24 * HOUR);
  assert.equal(closesAtOf({ starts_at: START }, 2), START - 2 * HOUR, 'hours can be given');
  const raid = { starts_at: START, signups_locked: 0, signup_close_hours: null, team_close_hours: 24 };
  const at = START - 24 * HOUR;
  assert.equal(closedReason(raid, at - 1), null, 'one millisecond before the deadline it is open');
  assert.equal(closedReason(raid, at), 'deadline', 'at the deadline it is closed');
  assert.equal(closedReason(raid, START - 1), 'deadline');
  assert.equal(closedReason(raid, START), 'started');
  assert.equal(closedReason(raid, START + HOUR), 'started', 'the start wins over the deadline');
  assert.equal(closedReason({ ...raid, signups_locked: 1 }, at - 1), 'locked', 'an officer\'s lock closes it before the deadline');
  assert.equal(closedReason({ ...raid, signups_locked: 1 }, at + 1), 'locked', 'locked and past the deadline: the lock is what an officer undoes');
  assert.equal(closedReason({ ...raid, signups_locked: 1 }, START), 'started');
  assert.equal(closedReason({ ...raid, team_close_hours: 0 }, START - 1), null, 'the default is the start');
  assert.equal(closedReason({ ...raid, signup_close_hours: 0 }, START - 1), null, 'the raid\'s 0 reopens it');
  assert.equal(closedReason({ ...raid, signup_close_hours: 48 }, START - 30 * HOUR), 'deadline');
  assert.equal(closedReason({ starts_at: START, signups_locked: 0 }, START - 1), null, 'a bare row (no team column) has no deadline');
  assert.equal(closedReason({ starts_at: START, signups_locked: 0 }, START - 2 * HOUR, 1), null);
  assert.equal(closedReason({ starts_at: START, signups_locked: 0 }, START - HOUR, 1), 'deadline', 'the hours argument');
});

check('deadline: the team\'s setting lives with the Raid schedule - read, saved (0 to 72), kept when left out, audited', async () => {
  const s = await laneWorld();
  const sched = (team = s.A) => `/teams/${team}/schedule`;
  const put = (body, who = 'bob', team = s.A) => s.call(who, 'PUT', sched(team), body);
  const empty = await s.call('erin', 'GET', sched());
  assert.deepEqual([empty.status, empty.json.signupCloseHours], [200, 0], 'any member reads it; the default closes at the start');
  assert.equal((await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.team.signupCloseHours, 0);
  const set = await put({ slots: [], signupCloseHours: 24 });
  assert.deepEqual([set.status, set.json.signupCloseHours], [200, 24]);
  assert.equal((await s.call('erin', 'GET', sched())).json.signupCloseHours, 24);
  assert.equal((await s.w.rows('SELECT signup_close_hours AS h FROM teams WHERE id = ?', s.A))[0].h, 24);
  assert.equal((await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.team.signupCloseHours, 24);
  // Left out, it is kept: a save of the slots alone does not reset it.
  const kept = await put({ slots: [{ weekday: 2, startTime: '20:00' }], weeks: 3 });
  assert.deepEqual([kept.json.signupCloseHours, kept.json.weeks], [24, 3]);
  for (const hours of [0, 72, 1]) assert.equal((await put({ slots: [], signupCloseHours: hours })).json.signupCloseHours, hours);
  // The other team has its own.
  assert.equal((await s.call('bob', 'GET', sched(s.B))).json.signupCloseHours, 0);
  // Validation: 400 with the field, nothing written.
  for (const bad of [73, -1, 1.5, '24', null, true, [24], 100]) {
    const r = await put({ slots: [], signupCloseHours: bad });
    assert.deepEqual([r.status, r.json.error, r.json.field], [400, 'bad_request', 'signupCloseHours'], JSON.stringify(bad));
  }
  assert.equal((await s.w.rows('SELECT signup_close_hours AS h FROM teams WHERE id = ?', s.A))[0].h, 1);
  // Audit: the counts, now with the deadline before and after.
  const audit = (await s.audits('schedule.update')).map((a) => [a.before.signupCloseHours, a.after.signupCloseHours]);
  assert.deepEqual(audit, [[0, 24], [24, 24], [24, 0], [0, 72], [72, 1]]);
  // Who: raids.edit on the team (the Team Lead of Alpha, not Bravo's; not a Member).
  assert.deepEqual([(await put({ slots: [], signupCloseHours: 5 }, 'carol')).status, (await put({ slots: [], signupCloseHours: 5 }, 'dave')).status, (await put({ slots: [], signupCloseHours: 5 }, 'erin')).status], [200, 403, 403]);
  // An archived team is refused as before.
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true })).status, 200);
  assert.equal((await put({ slots: [], signupCloseHours: 5 }, 'bob', s.B)).status, 409);
});

check('deadline: with the team at 24 hours a member\'s window closes exactly 24 hours before the start - write, change and delete', async () => {
  const s = await deadlineWorld();
  await s.teamHours(24);
  const closesAt = s.startsAt - 24 * HOUR;
  s.w.clock.now = closesAt - 1000;
  const early = await s.view();
  assert.deepEqual([early.raid.closed, early.raid.closesAt, early.raid.closeHours, early.raid.closeHoursOverride, early.me.canChange, early.me.closed], [null, closesAt, 24, null, true, null]);
  assert.equal((await s.mine({ kind: 'signed' })).status, 200, 'a second before the deadline');
  assert.equal((await s.mine({ kind: 'late', note: 'traffic' })).status, 200, 'a change a second before the deadline');
  // The deadline itself: closed.
  s.w.clock.now = closesAt;
  const refused = await s.mine({ kind: 'absence' });
  assert.deepEqual([refused.status, refused.json.error, refused.json.reason, refused.json.closesAt], [409, 'signups_closed', 'deadline', closesAt]);
  assert.match(refused.json.message, /closed 24 hours before the start/);
  assert.deepEqual(Object.keys(refused.json).sort(), ['closesAt', 'error', 'message', 'reason'], 'the 409 shape');
  const del = await s.dropMine();
  assert.deepEqual([del.status, del.json.error, del.json.reason, del.json.closesAt], [409, 'signups_closed', 'deadline', closesAt]);
  assert.equal(await s.signedKind(), 'late', 'nothing changed');
  assert.equal(await s.w.count('raid_signups', "note = 'traffic'"), 1);
  // The view says so.
  const closed = await s.view();
  assert.deepEqual([closed.raid.closed, closed.raid.upcoming, closed.raid.locked, closed.me.canChange, closed.me.closed, closed.raid.closesAt], ['deadline', true, false, false, 'deadline', closesAt]);
  assert.equal(closed.me.signup.kind, 'late', 'the sign-up is still listed');
  // A person with no sign-up cannot start one either; a Member of another character's sign-up is unaffected by it.
  const gina = await s.mine({ kind: 'signed' }, 'gina');
  assert.deepEqual([gina.status, gina.json.reason], [409, 'deadline']);
  // The start still reads 'started'.
  s.w.clock.now = s.startsAt;
  assert.equal((await s.mine({ kind: 'signed' })).json.reason, 'started');
  assert.equal((await s.view()).raid.closed, 'started');
});

check('deadline: the default is the start (0), and a raid\'s own number beats the team\'s - shorter, longer, cleared', async () => {
  const s = await deadlineWorld();
  // Team 0: open up to the start.
  s.w.clock.now = s.startsAt - 1000;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
  const view0 = await s.view();
  assert.deepEqual([view0.raid.closesAt, view0.raid.closeHours, view0.raid.closed], [s.startsAt, 0, null]);
  // Team 24, raid override 0: the raid stays open to the start.
  await s.teamHours(24);
  assert.equal((await s.mine({ kind: 'late' })).json.reason, 'deadline', 'the team deadline applies');
  const detail0 = await s.raidHours(0);
  assert.deepEqual([detail0.raid.closeHours, detail0.raid.closeHoursOverride, detail0.raid.closesAt], [0, 0, s.startsAt]);
  assert.equal((await s.mine({ kind: 'late' })).status, 200, 'the raid\'s 0 beats the team\'s 24');
  const view1 = await s.view();
  assert.deepEqual([view1.raid.closeHours, view1.raid.closeHoursOverride, view1.raid.closed], [0, 0, null]);
  // Longer than the team: 48 hours before the start; now is 1 second before the start.
  const detail48 = await s.raidHours(48);
  assert.deepEqual([detail48.raid.closeHours, detail48.raid.closeHoursOverride, detail48.raid.closesAt], [48, 48, s.startsAt - 48 * HOUR]);
  s.w.clock.now = s.startsAt - 30 * HOUR;
  const refused = await s.mine({ kind: 'signed' });
  assert.deepEqual([refused.status, refused.json.reason, refused.json.closesAt], [409, 'deadline', s.startsAt - 48 * HOUR]);
  assert.match(refused.json.message, /closed 48 hours before/);
  s.w.clock.now = s.startsAt - 48 * HOUR - 1;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200, 'a millisecond before the raid\'s deadline');
  // Cleared: the team's 24 again.
  const cleared = await s.raidHours(null);
  assert.deepEqual([cleared.raid.closeHours, cleared.raid.closeHoursOverride], [24, null]);
  s.w.clock.now = s.startsAt - 24 * HOUR;
  assert.equal((await s.mine({ kind: 'signed' })).json.reason, 'deadline');
  // The team's number moves the raid that has none; one hour is "1 hour".
  await s.teamHours(1);
  s.w.clock.now = s.startsAt - 30 * 60000;
  const hour = await s.mine({ kind: 'signed' });
  assert.deepEqual([hour.status, hour.json.reason], [409, 'deadline']);
  assert.match(hour.json.message, /closed 1 hour before the start/);
  s.w.clock.now = s.startsAt - 2 * HOUR;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
});

check('deadline: officers (raids.edit) are never bound - they add, change, remove and lock after the deadline, and after the start', async () => {
  const s = await deadlineWorld();
  await s.teamHours(24);
  s.w.clock.now = s.startsAt - 2 * HOUR;
  assert.equal((await s.mine({ kind: 'signed' })).json.reason, 'deadline');
  for (const who of ['alice', 'bob', 'carol']) {
    const put = await s.call(who, 'PUT', s.path(`/signups/${s.p.eliora}`), { kind: who === 'carol' ? 'late' : 'tentative' });
    assert.equal(put.status, 200, `${who}: ${JSON.stringify(put.json)}`);
    assert.equal(put.json.raid.closed, 'deadline', 'the view still says members are shut out');
  }
  assert.equal(await s.signedKind(), 'late');
  assert.equal((await s.call('bob', 'DELETE', s.path(`/signups/${s.p.eliora}`), {})).status, 200);
  assert.equal((await s.call('bob', 'PUT', s.path(`/signups/${s.p.gorrim}`), { kind: 'bench' })).status, 200);
  assert.equal((await s.call('bob', 'POST', s.path('/signups/lock'), {})).status, 200);
  assert.equal((await s.call('bob', 'POST', s.path('/signups/unlock'), {})).status, 200);
  // A Team Lead of ANOTHER team and a Member are still refused for someone else's sign-up.
  assert.equal((await s.call('dave', 'PUT', s.path(`/signups/${s.p.eliora}`), { kind: 'signed' })).status, 403);
  // After the start too.
  s.w.clock.now = s.startsAt + HOUR;
  assert.equal((await s.call('bob', 'PUT', s.path(`/signups/${s.p.eliora}`), { kind: 'signed' })).status, 200);
});

check('deadline: the reason is the start, then the lock, then the deadline', async () => {
  const s = await deadlineWorld();
  await s.teamHours(24);
  const closesAt = s.startsAt - 24 * HOUR;
  s.w.clock.now = closesAt - 1000;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
  // Locked, still before the deadline: locked.
  assert.equal((await s.call('bob', 'POST', s.path('/signups/lock'), {})).status, 200);
  const locked = await s.mine({ kind: 'late' });
  assert.deepEqual([locked.status, locked.json.reason, locked.json.closesAt], [409, 'locked', undefined], 'the lock 409 keeps its shape');
  assert.equal((await s.dropMine()).json.reason, 'locked');
  // Locked and past the deadline: still the lock; unlocking leaves the deadline.
  s.w.clock.now = closesAt + 1000;
  assert.equal((await s.mine({ kind: 'late' })).json.reason, 'locked');
  assert.deepEqual([(await s.view()).raid.closed, (await s.view()).me.closed], ['locked', 'locked']);
  const unlocked = await s.call('bob', 'POST', s.path('/signups/unlock'), {});
  assert.equal(unlocked.json.raid.closed, 'deadline');
  assert.equal((await s.mine({ kind: 'late' })).json.reason, 'deadline');
  // Past the start: started, whatever else.
  assert.equal((await s.call('bob', 'POST', s.path('/signups/lock'), {})).status, 200);
  s.w.clock.now = s.startsAt;
  assert.equal((await s.mine({ kind: 'late' })).json.reason, 'started');
  assert.equal((await s.view()).raid.closed, 'started');
});

check('deadline: the write statement re-checks it - a deadline that lands between the read and the write wins, for a change and for a delete', async () => {
  const s = await deadlineWorld();
  s.w.clock.now = s.startsAt - 10 * HOUR;
  assert.equal((await s.mine({ kind: 'signed' })).status, 200);
  // A change: the raid gets a 12-hour deadline after the request read it (now is 10 hours before the start, so it is already shut).
  const raced = await s.withRace(/INSERT INTO raid_signups/, 'UPDATE raids SET signup_close_hours = 12', () => s.mine({ kind: 'late', note: 'raced' }));
  assert.deepEqual([raced.status, raced.json.error, raced.json.reason, raced.json.closesAt], [409, 'signups_closed', 'deadline', s.startsAt - 12 * HOUR]);
  assert.match(raced.json.message, /closed 12 hours before/);
  assert.equal(await s.signedKind(), 'signed');
  assert.equal(await s.w.count('raid_signups', "note = 'raced'"), 0);
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith'"), 1);
  // A first sign-up the same way (Gina has none).
  exec(s.w, 'UPDATE raids SET signup_close_hours = NULL');
  const racedNew = await s.withRace(/INSERT INTO raid_signups/, 'UPDATE raids SET signup_close_hours = 12', () => s.mine({ kind: 'signed' }, 'gina'));
  assert.deepEqual([racedNew.status, racedNew.json.reason], [409, 'deadline']);
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith'"), 1);
  // A delete: refused with the deadline, not a 404, and the row stays.
  exec(s.w, 'UPDATE raids SET signup_close_hours = NULL');
  const racedDelete = await s.withRace(/DELETE FROM raid_signups/, 'UPDATE raids SET signup_close_hours = 12', () => s.dropMine());
  assert.deepEqual([racedDelete.status, racedDelete.json.error, racedDelete.json.reason], [409, 'signups_closed', 'deadline']);
  assert.equal(await s.signedKind(), 'signed');
  // The team's number is read in the statement too: it changes after the request read the raid.
  exec(s.w, 'UPDATE raids SET signup_close_hours = NULL');
  const teamRace = await s.withRace(/INSERT INTO raid_signups/, `UPDATE teams SET signup_close_hours = 24 WHERE id = '${s.A}'`, () => s.mine({ kind: 'tentative' }));
  assert.deepEqual([teamRace.status, teamRace.json.reason, teamRace.json.closesAt], [409, 'deadline', s.startsAt - 24 * HOUR]);
  assert.equal(await s.signedKind(), 'signed');
  // An officer's write goes through the same race untouched.
  const officer = await s.withRace(/INSERT INTO raid_signups/, 'UPDATE raids SET signup_close_hours = 72', () => s.call('bob', 'PUT', s.path(`/signups/${s.p.eliora}`), { kind: 'bench' }));
  assert.equal(officer.status, 200);
  assert.equal(await s.signedKind(), 'bench');
  // And a delete that finds no sign-up is still a 404 while the window is open.
  exec(s.w, 'UPDATE raids SET signup_close_hours = NULL');
  exec(s.w, `UPDATE teams SET signup_close_hours = 0 WHERE id = '${s.A}'`);
  assert.equal((await s.dropMine()).status, 200);
  const none = await s.dropMine();
  assert.deepEqual([none.status, none.json.error], [404, 'not_found']);
});

check('deadline: the Raids list rows say whether sign-ups are open, when they close and for how many hours', async () => {
  const s = await deadlineWorld();
  await s.teamHours(24);
  const own = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-11', startTime: '20:00' });
  assert.equal((await s.call('bob', 'PATCH', s.raid(own.id), { signupCloseHours: 0 })).status, 200);
  const locked = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-12', startTime: '20:00' });
  assert.equal((await s.call('bob', 'POST', s.raid(locked.id, '/signups/lock'), {})).status, 200);
  const rows = async () => Object.fromEntries((await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.upcoming.map((row) => [row.id, row]));
  s.w.clock.now = s.startsAt - 25 * HOUR;
  let list = await rows();
  assert.deepEqual([list[s.rid].signupsOpen, list[s.rid].closeHours, list[s.rid].closesAt], [true, 24, s.startsAt - 24 * HOUR]);
  assert.deepEqual([list[own.id].signupsOpen, list[own.id].closeHours, list[own.id].closesAt], [true, 0, own.startsAt]);
  assert.deepEqual([list[locked.id].signupsOpen, list[locked.id].locked, list[locked.id].closeHours], [false, true, 24]);
  s.w.clock.now = s.startsAt - 24 * HOUR;
  list = await rows();
  assert.equal(list[s.rid].signupsOpen, false, 'the deadline closes the row');
  assert.equal(list[own.id].signupsOpen, true, 'a raid with its own 0 stays open');
  // A raid's number shows on its own row only; the team's on the others.
  assert.equal((await s.call('bob', 'PATCH', s.raid(s.rid), { signupCloseHours: 2 })).status, 200);
  list = await rows();
  assert.deepEqual([list[s.rid].signupsOpen, list[s.rid].closeHours], [true, 2]);
  assert.equal(list[locked.id].closeHours, 24);
  // The detail carries the same three fields.
  const detail = (await s.call('erin', 'GET', s.raid(s.rid))).json.raid;
  assert.deepEqual([detail.closeHours, detail.closeHoursOverride, detail.closesAt], [2, 2, s.startsAt - 2 * HOUR]);
  const plain = (await s.call('erin', 'GET', s.raid(own.id))).json.raid;
  assert.deepEqual([plain.closeHours, plain.closeHoursOverride, plain.closesAt], [0, 0, own.startsAt]);
  const teamOnly = (await s.call('erin', 'GET', s.raid(locked.id))).json.raid;
  assert.deepEqual([teamOnly.closeHours, teamOnly.closeHoursOverride], [24, null]);
});

check('deadline: Needs attention does not call sign-ups "still open" once the deadline has shut them', async () => {
  const { buildAttention } = await load('worker/attention.js');
  const NOW = Date.parse('2027-01-16T12:00:00Z');
  const base = { today: '2027-01-16', now: NOW, teams: [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }], allowsTeam: () => true, granted: () => true, flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], watch: [] };
  const row = (id, extra) => ({ id, team_id: 't_a', raid_on: '2027-01-16', starts_at: NOW + 40 * 60000, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 25, ...extra });
  const unlocked = (rows) => buildAttention({ ...base, upcoming: rows }).items.filter((item) => item.kind === 'unlocked').map((item) => item.raidId).sort();
  // Within the last hour a deadline of one hour or more has always passed (the boundary, closing exactly now, counts as passed); 0 or none has not.
  assert.deepEqual(unlocked([row('plain'), row('zero', { close_hours: 0 }), row('hour', { close_hours: 1 }), row('exact', { close_hours: 1, starts_at: NOW + 60 * 60000 })]), ['plain', 'zero'], 'a deadline that has passed hides it');
});

check('deadline: Needs attention (route) - the "unlocked" hint follows the team\'s deadline', async () => {
  const s = await laneWorld();
  // A raid starting in 40 minutes on the clock 2027-01-16 12:00Z: raid on the 16th at 07:40 New York.
  const soon = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-16', startTime: '07:40' });
  const kinds = async () => (await s.call('bob', 'GET', '/attention')).json.items.filter((item) => item.raidId === soon.id).map((item) => item.kind).sort();
  assert.deepEqual(await kinds(), ['low_signups', 'unlocked']);
  await s.call('bob', 'PUT', `/teams/${s.A}/schedule`, { slots: [], signupCloseHours: 1 });
  assert.deepEqual(await kinds(), ['low_signups'], 'members are shut out an hour before: nothing is "still open"');
  assert.equal((await s.call('bob', 'PATCH', s.raid(soon.id), { signupCloseHours: 0 })).status, 200);
  assert.deepEqual(await kinds(), ['low_signups', 'unlocked'], 'the raid\'s own 0 reopens the hint');
});

// ---------------------------------------------------------------------------
// Date-only raids (B3): raids.time_known, and the calendar feed's all-day events

const WAVE2_REPORT = 'Wave2Rpt00000001';
const oneBossReport = (startTime) => wclReport({ startTime, actors: [[1, 'Aldric', 'Warrior']], fights: [[1, 'Gruul', 650, true, 0, 100, [1]]] });
const rhStart = (iso) => Date.parse(iso) / 1000; // Raid-Helper start times are in seconds
const setEventStart = (s, id, iso, extra = {}) => s.w.sources.events.set(id, rhEvent(id, SERVER_A, [], { startTime: iso === null ? 0 : rhStart(iso), ...extra }));
// The reply of a create, whole (the detail), where s.makeRaid keeps only .raid.
const makeFull = async (s, body) => {
  const r = await s.call('bob', 'POST', '/raids', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const storedTime = async (s, id) => (await s.w.rows('SELECT time_known, starts_at FROM raids WHERE id = ?', id))[0];

check('time_known: a raid made with only a date is date-only (noon UTC); a typed time, an event with a start or a report make the time known', async () => {
  const s = await laneWorld();

  const dateOnly = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10' });
  assert.deepEqual([dateOnly.timeKnown, dateOnly.startsAt], [false, Date.parse('2027-02-10T12:00:00Z')]);
  assert.deepEqual(await storedTime(s, dateOnly.id), { time_known: 0, starts_at: Date.parse('2027-02-10T12:00:00Z') });

  const typed = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-11', startTime: '20:00' });
  assert.deepEqual([typed.timeKnown, typed.startsAt], [true, Date.parse('2027-02-12T01:00:00Z')]);
  assert.equal((await storedTime(s, typed.id)).time_known, 1);

  // An event with a start time anchors the raid on it.
  setEventStart(s, '777777777777777771', '2027-02-13T01:00:00Z');
  const linked = await makeFull(s, { teamId: s.A, eventSource: '777777777777777771' });
  assert.deepEqual([linked.raid.timeKnown, linked.raid.startsAt, linked.raid.raidOn], [true, Date.parse('2027-02-13T01:00:00Z'), '2027-02-12']);
  assert.equal((await storedTime(s, linked.raid.id)).time_known, 1);
  // An event without one gives the raid only the date typed with it.
  setEventStart(s, '777777777777777772', null);
  const noStart = await makeFull(s, { teamId: s.A, eventSource: '777777777777777772', raidOn: '2027-02-14' });
  assert.deepEqual([noStart.sources.event !== null, noStart.raid.timeKnown, noStart.raid.startsAt], [true, false, Date.parse('2027-02-14T12:00:00Z')]);
  assert.equal((await storedTime(s, noStart.raid.id)).time_known, 0);
  // ... and a typed time with it is a known time.
  setEventStart(s, '777777777777777773', null);
  const noStartTyped = await makeFull(s, { teamId: s.A, eventSource: '777777777777777773', raidOn: '2027-02-15', startTime: '19:30' });
  assert.deepEqual([noStartTyped.raid.timeKnown, noStartTyped.raid.startsAt], [true, Date.parse('2027-02-16T00:30:00Z')]);

  // A report anchors it on its first pull.
  s.w.sources.reports.set(WAVE2_REPORT, oneBossReport(Date.parse('2027-01-10T01:00:00Z')));
  const logged = await makeFull(s, { teamId: s.A, reportSource: WAVE2_REPORT });
  assert.deepEqual([logged.raid.timeKnown, logged.raid.startsAt, logged.raid.raidOn], [true, Date.parse('2027-01-10T01:00:00Z'), '2027-01-09']);
  assert.equal((await storedTime(s, logged.raid.id)).time_known, 1);
  // A date typed next to a report loses to the report, which says when.
  s.w.sources.reports.set('Wave2Rpt00000002', oneBossReport(Date.parse('2027-01-11T01:00:00Z')));
  const both = await makeFull(s, { teamId: s.B, reportSource: 'Wave2Rpt00000002', raidOn: '2027-03-01' });
  assert.equal(both.raid.timeKnown, true);
});

check('time_known: the detail, both lists, the sign-ups view and the planner seed say so; a NULL (a raid from before the column) is timed', async () => {
  const s = await laneWorld();
  const dateOnly = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10' });
  const typed = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-11', startTime: '20:00' });
  const past = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-05' }); // a past raid with only its date
  const known = async (id) => ({
    detail: (await s.call('erin', 'GET', s.raid(id))).json.raid.timeKnown,
    view: (await s.call('erin', 'GET', s.raid(id, '/signups'))).json.raid.timeKnown,
    seed: (await s.call('bob', 'GET', s.raid(id, '/planner'))).json.raid.timeKnown,
  });
  assert.deepEqual(await known(dateOnly.id), { detail: false, view: false, seed: false });
  assert.deepEqual(await known(typed.id), { detail: true, view: true, seed: true });
  const list = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual(list.upcoming.map((row) => [row.id, row.timeKnown]), [[dateOnly.id, false], [typed.id, true]]);
  assert.deepEqual(list.raids.map((row) => [row.id, row.timeKnown]), [[past.id, false]], 'a past row says it too');
  // The unknown (NULL) reads as a real time everywhere.
  exec(s.w, 'UPDATE raids SET time_known = NULL');
  assert.deepEqual(await known(dateOnly.id), { detail: true, view: true, seed: true });
  const nulls = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual([...nulls.upcoming, ...nulls.raids].map((row) => row.timeKnown), [true, true, true]);
  // The stored 1 is not touched by a size or deadline change (PATCH only writes its own keys).
  exec(s.w, `UPDATE raids SET time_known = 0 WHERE id = '${dateOnly.id}'`);
  assert.equal((await s.call('bob', 'PATCH', s.raid(dateOnly.id), { size: 10, signupCloseHours: 3 })).json.raid.timeKnown, false);
  assert.equal((await storedTime(s, dateOnly.id)).time_known, 0);
});

check('time_known: linking an event or a report to a date-only raid makes the time known; one without a time does not', async () => {
  const s = await laneWorld();
  // An event with a start time, on the raid's day: the raid takes its time.
  const raid = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-10' });
  assert.equal(raid.timeKnown, false);
  setEventStart(s, '777777777777777771', '2027-02-11T01:00:00Z'); // 20:00 on the 10th in New York
  const linked = await s.call('bob', 'PUT', s.raid(raid.id, '/event'), { source: '777777777777777771' });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.deepEqual([linked.json.raid.timeKnown, linked.json.raid.startsAt, linked.json.raid.raidOn], [true, Date.parse('2027-02-11T01:00:00Z'), '2027-02-10']);
  assert.deepEqual(await storedTime(s, raid.id), { time_known: 1, starts_at: Date.parse('2027-02-11T01:00:00Z') });
  // An event without a start time leaves a date-only raid date-only.
  const second = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-17' });
  setEventStart(s, '777777777777777772', null);
  const timeless = await s.call('bob', 'PUT', s.raid(second.id, '/event'), { source: '777777777777777772' });
  assert.equal(timeless.status, 200, JSON.stringify(timeless.json));
  assert.deepEqual([timeless.json.raid.timeKnown, timeless.json.raid.startsAt], [false, Date.parse('2027-02-17T12:00:00Z')]);
  assert.equal((await storedTime(s, second.id)).time_known, 0);
  // ... until an event that has one is linked (a re-link replaces the event).
  setEventStart(s, '777777777777777773', '2027-02-18T01:00:00Z');
  const relinked = await s.call('bob', 'PUT', s.raid(second.id, '/event'), { source: '777777777777777773' });
  assert.deepEqual([relinked.json.raid.timeKnown, relinked.json.raid.startsAt], [true, Date.parse('2027-02-18T01:00:00Z')]);
  // A move to the event's day (the event is on another day): known too.
  const third = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-24' });
  setEventStart(s, '777777777777777774', '2027-02-26T01:00:00Z');
  const moved = await s.call('bob', 'PUT', s.raid(third.id, '/event'), { source: '777777777777777774', moveRaid: true });
  assert.deepEqual([moved.status, moved.json.raid.timeKnown, moved.json.raid.raidOn], [200, true, '2027-02-25']);
  // Removing the event keeps the time the raid has.
  const unlinked = await s.call('bob', 'DELETE', s.raid(third.id, '/event'), {});
  assert.deepEqual([unlinked.json.raid.timeKnown, unlinked.json.raid.startsAt], [true, Date.parse('2027-02-26T01:00:00Z')]);

  // A report on a date-only raid takes the first pull as the start.
  const logged = await s.makeRaid({ teamId: s.B, raidOn: '2027-01-09' });
  assert.equal(logged.timeKnown, false);
  s.w.sources.reports.set(WAVE2_REPORT, oneBossReport(Date.parse('2027-01-10T01:00:00Z')));
  const report = await s.call('bob', 'PUT', s.raid(logged.id, '/reports'), { source: WAVE2_REPORT });
  assert.equal(report.status, 200, JSON.stringify(report.json));
  assert.deepEqual([report.json.raid.timeKnown, report.json.raid.startsAt], [true, Date.parse('2027-01-10T01:00:00Z')]);
  assert.equal((await storedTime(s, logged.id)).time_known, 1);
  // A raid that is timed already stays so when a report comes.
  const timed = await s.makeRaid({ teamId: s.B, raidOn: '2027-01-12', startTime: '20:00' });
  s.w.sources.reports.set('Wave2Rpt00000003', oneBossReport(Date.parse('2027-01-13T01:30:00Z')));
  const again = await s.call('bob', 'PUT', s.raid(timed.id, '/reports'), { source: 'Wave2Rpt00000003' });
  assert.deepEqual([again.status, again.json.raid.timeKnown], [200, true]);
});

check('time_known: raids filled from the weekly schedule have a real start time', async () => {
  const s = await laneWorld();
  // Saturday 2027-01-16 12:00Z is 07:00 in New York: slots on Tuesday and Thursday at 20:00.
  const put = await s.call('bob', 'PUT', `/teams/${s.A}/schedule`, { slots: [{ weekday: 2, startTime: '20:00' }, { weekday: 4, startTime: '20:30' }], weeks: 2 });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const fill = await s.call('bob', 'POST', `/teams/${s.A}/schedule/raids`, {});
  assert.equal(fill.status, 200, JSON.stringify(fill.json));
  assert.equal(fill.json.created.length, 4);
  assert.deepEqual((await s.w.rows('SELECT time_known FROM raids ORDER BY raid_on')).map((r) => r.time_known), [1, 1, 1, 1]);
  const list = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json;
  assert.deepEqual(list.upcoming.map((row) => row.timeKnown), [true, true, true, true]);
});

// ---- the calendar feed

// An ICS the way a calendar app reads it: unfold, split; every VEVENT as { 'DTSTART;VALUE=DATE': ..., UID: ... } keyed by the property WITH its parameters.
function readIcs(text) {
  assert(text.endsWith('\r\n'), 'ends with CRLF');
  assert(!/(^|[^\r])\n/.test(text), 'every line break is CRLF');
  for (const physical of text.split('\r\n')) assert(Buffer.byteLength(physical, 'utf8') <= 75, `a physical line over 75 octets: ${physical.slice(0, 40)}`);
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
  const events = [];
  let current = null;
  for (const line of lines.slice(1, -1)) {
    if (line === 'BEGIN:VEVENT') { assert.equal(current, null); current = {}; continue; }
    if (line === 'END:VEVENT') { events.push(current); current = null; continue; }
    const colon = line.indexOf(':');
    assert(colon > 0, `a content line: ${line}`);
    if (current) current[line.slice(0, colon)] = line.slice(colon + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  }
  assert.equal(current, null, 'VEVENTs are closed');
  assert.equal(new Set(events.map((e) => e.UID)).size, events.length, 'UIDs are unique');
  for (const event of events) {
    assert(event.UID && event.DTSTAMP && event.SUMMARY, 'UID, DTSTAMP and SUMMARY');
    const timed = 'DTSTART' in event;
    const allDay = 'DTSTART;VALUE=DATE' in event;
    assert.equal(timed !== allDay, true, 'exactly one kind of DTSTART');
    if (timed) assert(/^\d{8}T\d{6}Z$/.test(event.DTSTART) && /^\d{8}T\d{6}Z$/.test(event.DTEND) && event.DTEND > event.DTSTART && !('DTEND;VALUE=DATE' in event), `a timed event: ${JSON.stringify(event)}`);
    if (allDay) assert(/^\d{8}$/.test(event['DTSTART;VALUE=DATE']) && /^\d{8}$/.test(event['DTEND;VALUE=DATE']) && event['DTEND;VALUE=DATE'] > event['DTSTART;VALUE=DATE'] && !('DTEND' in event), `an all-day event: ${JSON.stringify(event)}`);
  }
  return events;
}

check('calendar-feed: an all-day event is DTSTART;VALUE=DATE and DTEND;VALUE=DATE (the next day) with no time; a timed one is unchanged', async () => {
  const { buildIcs, formatDate } = await load('worker/calendar-feed.js');
  const STAMP = Date.parse('2026-10-17T10:00:00Z');
  assert.equal(formatDate('2026-10-17'), '20261017');
  for (const bad of ['2026-1-17', '20261017', '', null, undefined, 20261017, '2026-10-17T00:00:00Z']) assert.throws(() => formatDate(bad), RangeError, String(bad));
  const text = buildIcs({
    name: 'Ember - Alpha',
    stamp: STAMP,
    events: [
      { uid: 'r_day@raidsmith', allDay: true, startDate: '2026-10-17', endDate: '2026-10-18', summary: 'Karazhan, "night"; bring flasks', description: 'Start time not set yet\nSigned 21', url: 'https://raidsmith.test/#/g/g_1/raids/r/r_day' },
      { uid: 'r_end@raidsmith', allDay: true, startDate: '2026-12-31', endDate: '2027-01-01', summary: 'New year' },
      { uid: 'r_timed@raidsmith', start: Date.parse('2026-10-17T23:30:00Z'), end: Date.parse('2026-10-18T02:30:00Z'), summary: 'Timed', description: 'x', url: 'https://raidsmith.test/y' },
    ],
  });
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  assert(lines.includes('DTSTART;VALUE=DATE:20261017') && lines.includes('DTEND;VALUE=DATE:20261018'));
  assert(lines.includes('DTSTART;VALUE=DATE:20261231') && lines.includes('DTEND;VALUE=DATE:20270101'), 'across the year');
  assert(lines.includes('DTSTART:20261017T233000Z') && lines.includes('DTEND:20261018T023000Z'), 'a timed event is as before');
  assert.equal(lines.filter((line) => /^DTSTART:/.test(line)).length, 1, 'an all-day event writes no UTC DTSTART');
  assert.equal(lines.filter((line) => /^DTEND:/.test(line)).length, 1);
  const events = readIcs(text);
  assert.equal(events.length, 3);
  const day = events[0];
  assert.deepEqual([day.UID, day.DTSTAMP, day.SUMMARY, day.DESCRIPTION, day.URL], ['r_day@raidsmith', '20261017T100000Z', 'Karazhan, "night"; bring flasks', 'Start time not set yet\nSigned 21', 'https://raidsmith.test/#/g/g_1/raids/r/r_day']);
  assert.equal('DESCRIPTION' in events[1] || 'URL' in events[1], false, 'optional properties stay optional');
  assert.equal(events[1].STATUS, 'CONFIRMED');
  // A malformed date is refused loudly, never written as junk.
  assert.throws(() => buildIcs({ name: 'x', stamp: STAMP, events: [{ uid: 'a', allDay: true, startDate: 'soon', endDate: '2026-10-18', summary: 's' }] }), RangeError);
  // The text rules still hold with all-day events in the document: a long summary folds, a comma and a semicolon are escaped.
  const long = buildIcs({ name: 'x', stamp: STAMP, events: [{ uid: 'a', allDay: true, startDate: '2026-10-17', endDate: '2026-10-18', summary: 'Café night, '.repeat(12) }] });
  assert.equal(readIcs(long)[0].SUMMARY, 'Café night, '.repeat(12));
});

check('calendar-feed: a date-only raid is an all-day event on its own date, a timed or unknown-time raid a timed one - through the route', async () => {
  const s = await laneWorld({ guildBody: { timeZone: 'Pacific/Auckland' } }); // UTC+13 in January: noon UTC is already the NEXT day there
  const dateOnly = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-20' });
  const timed = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-21', startTime: '20:00' });
  const legacy = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-22', startTime: '19:00' });
  exec(s.w, `UPDATE raids SET time_known = NULL WHERE id = '${legacy.id}'`); // a raid from before the column
  const monthEnd = await s.makeRaid({ teamId: s.A, raidOn: '2027-02-28' });  // the next day is in the next month (2027 is not a leap year)
  const past = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-10' });
  assert.deepEqual([dateOnly.timeKnown, timed.timeKnown, legacy.timeKnown, monthEnd.timeKnown, past.timeKnown], [false, true, true, false, false]);
  // Erin follows Alpha through a calendar link; the feed needs no cookie.
  const made = await s.call('erin', 'POST', '/calendar', { teamId: s.A });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const response = await s.w.req('GET', new URL(made.json.url).pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/calendar/);
  const events = readIcs(await response.text());
  const by = Object.fromEntries(events.map((event) => [event.UID, event]));
  const day = by[`${dateOnly.id}@raidsmith`];
  assert.deepEqual([day['DTSTART;VALUE=DATE'], day['DTEND;VALUE=DATE'], 'DTSTART' in day], ['20270120', '20270121', false], 'the raid\'s own date, not the UTC date of noon');
  assert.match(day.DESCRIPTION, /^Start time not set yet\n/);
  assert(day.URL.endsWith(`/raids/r/${dateOnly.id}`));
  assert.deepEqual([by[`${monthEnd.id}@raidsmith`]['DTSTART;VALUE=DATE'], by[`${monthEnd.id}@raidsmith`]['DTEND;VALUE=DATE']], ['20270228', '20270301']);
  assert.deepEqual([by[`${past.id}@raidsmith`]['DTSTART;VALUE=DATE'], by[`${past.id}@raidsmith`]['DTEND;VALUE=DATE']], ['20270110', '20270111'], 'a past raid inside the 30 days');
  // A typed time is a UTC time as before: 20:00 on the 21st in Auckland (UTC+13) is 07:00Z.
  const t = by[`${timed.id}@raidsmith`];
  assert.deepEqual([t.DTSTART, 'DTSTART;VALUE=DATE' in t, /^Start time not set/.test(t.DESCRIPTION)], ['20270121T070000Z', false, false]);
  // A raid from before the column (NULL) is timed too.
  const l = by[`${legacy.id}@raidsmith`];
  assert.deepEqual([l.DTSTART, 'DTSTART;VALUE=DATE' in l], ['20270122T060000Z', false]);
  // The feed follows the raid: a time set later turns the all-day event into a timed one on the next fetch.
  setEventStart(s, '777777777777777771', '2027-01-20T06:00:00Z'); // 19:00 on the 20th in Auckland
  assert.equal((await s.call('bob', 'PUT', s.raid(dateOnly.id, '/event'), { source: '777777777777777771' })).status, 200);
  const after = readIcs(await (await s.w.req('GET', new URL(made.json.url).pathname)).text()).find((event) => event.UID === `${dateOnly.id}@raidsmith`);
  assert.deepEqual([after.DTSTART, 'DTSTART;VALUE=DATE' in after], ['20270120T060000Z', false]);
});

// ---------------------------------------------------------------------------
// Volunteer standby (B4): a sign-up kind stored as 'signed' + standby = 1 and read as 'standby' everywhere

// deadlineWorld (Alpha's raid on 2027-02-10 20:00, Eliora = Erin's person, Gorrim = Gina's) plus Nodisc, a rogue with no Discord ID whom an officer signs up.
async function standbyWorld() {
  const s = await deadlineWorld();
  s.p.nodisc = (await addPerson(s, 'bob', s.A, 'Nodisc', { class: 'ROGUE', mainSpec: 'Combat', offSpec: null })).person.id;
  s.officerSet = (key, body, rid = s.rid) => s.call('bob', 'PUT', s.raid(rid, `/signups/${s.p[key]}`), body);
  s.stored = async (key) => (await s.w.rows("SELECT kind, standby, standing FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ?", s.rid, s.p[key]))[0];
  return s;
}

check('standby: a member and an officer can sign up as standby - stored as signed + standby = 1, every other kind clears the flag, a bad kind names it in the 400', async () => {
  const s = await standbyWorld();
  let r = await s.mine({ kind: 'standby' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await s.stored('eliora'), { kind: 'signed', standby: 1, standing: 0 });
  assert.equal(r.json.me.signup.kind, 'standby', 'the view\'s me.signup says standby');
  // Every other kind clears the flag (the CHECK on the table would refuse a late + standby pair), and back again.
  for (const kind of ['late', 'signed', 'tentative', 'absence']) {
    assert.equal((await s.mine({ kind })).status, 200, kind);
    assert.deepEqual(await s.stored('eliora'), { kind, standby: 0, standing: 0 }, kind);
    assert.equal((await s.mine({ kind: 'standby' })).status, 200);
    assert.deepEqual(await s.stored('eliora'), { kind: 'signed', standby: 1, standing: 0 }, `standby after ${kind}`);
  }
  // An officer sets it for someone else and changes it away again; that is audited as a sign-up of kind standby.
  assert.equal((await s.officerSet('nodisc', { kind: 'standby' })).status, 200);
  assert.deepEqual(await s.stored('nodisc'), { kind: 'signed', standby: 1, standing: 0 });
  assert.equal((await s.officerSet('eliora', { kind: 'bench' })).status, 200);
  assert.deepEqual(await s.stored('eliora'), { kind: 'bench', standby: 0, standing: 0 });
  assert.deepEqual((await s.audits('signup.set')).map((entry) => entry.after.kind), ['standby', 'bench']);
  // Any edit makes a sign-up a standing sign-up made the member's own.
  exec(s.w, `UPDATE raid_signups SET standing = 1 WHERE raid_id = '${s.rid}' AND player_id = '${s.p.nodisc}'`);
  assert.equal((await s.officerSet('nodisc', { kind: 'standby' })).status, 200);
  assert.equal((await s.stored('nodisc')).standing, 0, 'an edit through the sign-up routes clears standing, even to the same kind');
  // The 400 for a bad kind lists standby, for members and for officers; a member still cannot bench.
  for (const [response, field] of [[await s.mine({ kind: 'maybe' }), 'kind'], [await s.mine({ kind: 'bench' }), 'kind'], [await s.officerSet('nodisc', { kind: 'maybe' }), 'kind']]) {
    assert.equal(response.status, 400);
    assert.equal(response.json.field, field);
    assert.match(response.json.message, /standby/);
  }
});

check('standby: Raid-Helper rows can never be standby - the table refuses it, and an event import writes standby 0', async () => {
  const s = await standbyWorld();
  const event = '777777777777777701';
  s.w.sources.events.set(event, rhEvent(event, SERVER_A, [signUp(1, PEOPLE.erin.id, 'Erin', 'Priest', 'Holy1'), signUp(2, DID(40), 'Stranger', 'Rogue', 'Combat')], { startTime: rhStart('2027-02-10T20:00:00-05:00') }));
  assert.equal((await s.call('bob', 'PUT', s.path('/event'), { source: event })).status, 200);
  assert.equal(await s.w.count('raid_signups', "source = 'raid_helper'"), 2);
  assert.equal(await s.w.count('raid_signups', "source = 'raid_helper' AND standby = 1"), 0);
  assert.throws(() => exec(s.w, `UPDATE raid_signups SET standby = 1 WHERE raid_id = '${s.rid}' AND source = 'raid_helper'`), /CHECK constraint failed/);
  assert.throws(() => exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, position, guild_id) VALUES ('${s.rid}', 'raid_helper', 90, 'x', 'signed', 1, 90, '${s.guildId}')`), /CHECK constraint failed/);
  // A Raidsmith row of any kind but signed cannot carry the flag either.
  await s.mine({ kind: 'late' });
  assert.throws(() => exec(s.w, `UPDATE raid_signups SET standby = 1 WHERE raid_id = '${s.rid}' AND source = 'raidsmith'`), /CHECK constraint failed/);
});

check('standby: the sign-ups view lists it in its own kind and role group; signed leaves it out, expected and the role and class tallies count it', async () => {
  const s = await standbyWorld();
  assert.equal((await s.mine({ kind: 'standby' })).status, 200);              // Eliora, Priest Holy: a healer
  assert.equal((await s.mine({ kind: 'signed' }, 'gina')).status, 200);       // Gorrim, Paladin Protection: a tank
  assert.equal((await s.officerSet('nodisc', { kind: 'standby' })).status, 200); // Nodisc, Rogue Combat: melee
  const view = await s.view('bob');
  const by = Object.fromEntries(view.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual([by.Eliora.kind, by.Eliora.role, by.Eliora.source], ['standby', 'healer', 'raidsmith']);
  assert.deepEqual([by.Nodisc.kind, by.Nodisc.role, by.Gorrim.kind, by.Gorrim.role], ['standby', 'melee', 'signed', 'tank']);
  assert.deepEqual(view.counts, {
    signed: 1, late: 0, standby: 2, tentative: 0, bench: 0, absence: 0, expected: 3,
    byRole: { tank: 1, healer: 1, melee: 1, ranged: 0, none: 0 }, byClass: { PALADIN: 1, PRIEST: 1, ROGUE: 1 },
  });
  const erin = await s.view('erin');
  assert.equal(erin.me.signup.kind, 'standby');
  assert.deepEqual(erin.counts.standby, 2, 'a member who may see the list sees the same counts');
  // The pure counts: a Raid-Helper-shaped entry list.
  const { countSignups, effectiveKind, storedKind } = await load('worker/signups-data.js');
  assert.deepEqual([effectiveKind({ kind: 'signed', standby: 1 }), effectiveKind({ kind: 'signed', standby: 0 }), effectiveKind({ kind: 'late' }), effectiveKind({ kind: 'bench', standby: 0 })], ['standby', 'signed', 'late', 'bench']);
  assert.deepEqual([storedKind('standby'), storedKind('late')], [{ kind: 'signed', standby: 1 }, { kind: 'late', standby: 0 }]);
  const counts = countSignups([{ kind: 'standby', role: 'tank', classId: 'WARRIOR' }, { kind: 'signed', role: null, classId: null }, { kind: 'absence', role: 'tank', classId: 'WARRIOR' }]);
  assert.deepEqual([counts.signed, counts.standby, counts.absence, counts.expected, counts.byRole.tank, counts.byRole.none, counts.byClass], [1, 1, 1, 2, 1, 1, { WARRIOR: 1 }]);
});

check('standby: the Raids list counts it apart from signed and tells the viewer, the raid detail lists the effective kind', async () => {
  const s = await standbyWorld();
  await s.mine({ kind: 'standby' });
  await s.mine({ kind: 'signed' }, 'gina');
  await s.officerSet('nodisc', { kind: 'standby' });
  const list = await s.call('bob', 'GET', `/raids?team=${s.A}`);
  const row = list.json.upcoming.find((raid) => raid.id === s.rid);
  assert.deepEqual(row.signups, { signed: 1, late: 0, standby: 2, bench: 0, tentative: 0, absence: 0 });
  const mine = await s.call('erin', 'GET', `/raids?team=${s.A}`);
  assert.deepEqual(mine.json.upcoming.find((raid) => raid.id === s.rid).mine, { kind: 'standby', source: 'raidsmith', characterName: 'Eliora' });
  const gina = await s.call('gina', 'GET', `/raids?team=${s.A}`);
  assert.equal(gina.json.upcoming.find((raid) => raid.id === s.rid).mine.kind, 'signed', 'a plain sign-up is still signed');
  const detail = await s.call('bob', 'GET', s.path());
  assert.deepEqual(detail.json.signups.map((signup) => signup.kind).sort(), ['signed', 'standby', 'standby']);
});

check('standby: the calendar feed counts it ("Standby 2") and tells the member ("Your sign-up: Standby")', async () => {
  const s = await standbyWorld();
  await s.mine({ kind: 'standby' });
  await s.mine({ kind: 'signed' }, 'gina');
  await s.officerSet('nodisc', { kind: 'standby' });
  const made = await s.call('erin', 'POST', '/calendar', { teamId: s.A });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const events = readIcs(await (await s.w.req('GET', new URL(made.json.url).pathname)).text());
  const event = events.find((e) => e.UID === `${s.rid}@raidsmith`);
  assert.match(event.DESCRIPTION, /^Signed 1, Standby 2\nYour sign-up: Standby\n/);
  const { countsLine } = await load('worker/calendar-feed.js');
  assert.equal(countsLine({ signed: 3, late: 1, standby: 2, bench: 0, tentative: 0, absence: 1 }), 'Signed 3, Late 1, Standby 2, Can\'t come 1');
});

check('standby: Needs attention counts a standby sign-up as one of the people coming (n_in)', async () => {
  const s = await standbyWorld();
  const soon = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-18', startTime: '20:00' });
  s.rid = soon.id;
  await s.mine({ kind: 'standby' });
  await s.mine({ kind: 'signed' }, 'gina');
  assert.deepEqual((await s.lows())[soon.id], [2, 25], 'a standby and a signed: two are in');
  await s.mine({ kind: 'tentative' });
  assert.deepEqual((await s.lows())[soon.id], [1, 25], 'tentative is not coming');
  await s.mine({ kind: 'standby' });
  assert.deepEqual((await s.lows())[soon.id], [2, 25]);
});

// ---- standby in the attendance results

// Alpha with seven raiders, and a past raid (2027-01-15 20:00; the clock is 2027-01-16 12:00Z) with hand-entered attendance: only Aldric came.
const ATT_ROSTER = [['aldric', 'Aldric', 'WARRIOR', 'Arms'], ['brindle', 'Brindle', 'MAGE', 'Fire'], ['cassia', 'Cassia', 'MAGE', 'Frost'], ['dunmar', 'Dunmar', 'WARRIOR', 'Fury'],
  ['eliora', 'Eliora', 'PRIEST', 'Holy'], ['fenwick', 'Fenwick', 'ROGUE', 'Combat'], ['gorrim', 'Gorrim', 'PALADIN', 'Protection']];
async function attWorld() {
  const s = await laneWorld();
  s.p = {};
  s.names = {};
  for (const [key, name, classId, spec] of ATT_ROSTER) {
    s.p[key] = (await addPerson(s, 'bob', s.A, name, { class: classId, mainSpec: spec, offSpec: null })).person.id;
    s.names[s.p[key]] = name;
  }
  s.sign = async (key, kind, rid, who = 'bob') => {
    const r = await s.call(who, 'PUT', s.raid(rid, `/signups/${s.p[key]}`), { kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  s.manual = async (rid, keys) => {
    const r = await s.call('bob', 'PUT', s.raid(rid, '/manual'), { reason: 'Hand-entered for the test', presentPlayerIds: keys.map((key) => s.p[key]) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  s.plan = async (rid, players) => {
    const r = await s.call('bob', 'PUT', s.raid(rid, '/plan'), { label: 'Plan', players });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  s.recompute = async (rid) => assert.equal((await s.call('bob', 'POST', s.raid(rid, '/recompute'), {})).status, 200);
  // { name: [outcome, credit, signup_kind, flags] } of a raid's stored attendance.
  s.att = async (rid) => Object.fromEntries((await s.w.rows('SELECT player_id, outcome, credit, signup_kind, flags FROM attendance WHERE raid_id = ?', rid))
    .map((row) => [s.names[row.player_id], [row.outcome, row.credit, row.signup_kind, JSON.parse(row.flags)]]));
  return s;
}

check('standby: attendance - standby and attended is present, standby and absent is missed (no_show), a plan bench beats it, a plan seat makes it signed', async () => {
  const s = await attWorld();
  const rid = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-15', startTime: '20:00' })).id;
  for (const key of ['aldric', 'brindle', 'cassia', 'dunmar']) await s.sign(key, 'standby', rid);
  await s.sign('eliora', 'tentative', rid);
  await s.sign('fenwick', 'signed', rid);
  await s.manual(rid, ['aldric']);
  await s.plan(rid, [{ name: 'Cassia', group: 0 }, { name: 'Dunmar', group: 1 }]);
  assert.deepEqual(await s.att(rid), {
    Aldric: ['present', 1, 'standby', []],
    Brindle: ['missed', 0, 'standby', ['no_show']],
    Cassia: ['bench', 1, 'bench', []],         // the plan's bench (rank 4) beats the volunteer standby (rank 3)
    Dunmar: ['missed', 0, 'signed', ['no_show']], // a plan seat is a stronger kind than standby: she was signed in the plan
    Eliora: ['tentative', null, 'tentative', []],
    Fenwick: ['missed', 0, 'signed', ['no_show']],
    Gorrim: ['no_signup', null, null, []],
  });
  // The bench policy decides the credit of the benched volunteer (excluded: not counted).
  const policy = (await s.call('bob', 'GET', '/attendance/policy')).json;
  assert.equal((await s.call('bob', 'PUT', '/attendance/policy', { policy: { bench: 'excluded' }, expectedVersion: policy.versions.guild })).status, 200);
  await s.recompute(rid);
  assert.deepEqual((await s.att(rid)).Cassia, ['bench', null, 'bench', []], 'excluded bench: credit null');
  assert.deepEqual((await s.att(rid)).Brindle, ['missed', 0, 'standby', ['no_show']], 'a standby that did not come is still missed');
});

check('standby: the consolidation ranks it above tentative and absence, below late and signed and below a plan bench; the sign-up rate counts it', async () => {
  const { consolidateRaid } = await load('worker/attendance-consolidate.js');
  const { resolvePolicy } = await load('worker/attendance-policy.js');
  const policy = resolvePolicy({}, {}, 'US');
  const person = (playerId) => ({ playerId, status: 'raider', joinedOn: null, leftOn: null, homeTeamId: 't', characters: [{ key: `${playerId}|x`, teamId: 't' }] });
  const evidence = (signups, extra = {}) => ({
    raid: { id: 'r', teamId: 't', raidOn: '2027-01-15', hasLog: false, manual: true }, people: [person('p1')], signups, pulls: [], manualPresent: [], guests: [], decisions: {}, logPlayers: {}, ...extra,
  });
  const row = (signups) => consolidateRaid(evidence(signups), policy).rows[0];
  const kinds = (list) => list.map((kind) => ({ playerId: 'p1', kind, source: 'raidsmith' }));
  assert.deepEqual([row(kinds(['standby'])).outcome, row(kinds(['standby'])).signupKind, row(kinds(['standby'])).credit], ['missed', 'standby', 0]);
  assert.equal(row(kinds(['tentative', 'standby'])).signupKind, 'standby', 'standby beats tentative');
  assert.equal(row(kinds(['standby', 'absence'])).signupKind, 'standby', 'standby beats absence');
  assert.equal(row(kinds(['standby', 'signed'])).signupKind, 'signed', 'signed beats standby');
  assert.equal(row(kinds(['standby', 'late'])).signupKind, 'late', 'late beats standby');
  assert.equal(row([{ playerId: 'p1', kind: 'standby', source: 'raidsmith' }, { playerId: 'p1', kind: 'bench', source: 'plan' }]).outcome, 'bench', 'a plan bench beats standby');
  // The sign-up rate counts a standby as signed up.
  const { teamMetrics } = await load('worker/attendance-metrics.js');
  const raids = ['r1', 'r2', 'r3'].map((id, i) => ({ id, raidOn: `2027-01-0${i + 4}`, hasSignups: true }));
  const rows = [['r1', 'standby'], ['r2', 'signed'], ['r3', 'tentative']].map(([raidId, signupKind]) => ({ raidId, playerId: 'a', outcome: 'missed', credit: 0, signupKind, attended: 0, viaRaidId: null }));
  const metrics = teamMetrics({ people: [{ id: 'a', joinedOn: null }], raids, rows, borrowed: [], policy, today: '2027-01-16', resetDay: 2, windowWeeks: 'all' });
  assert.equal(metrics.people.a.signupRate, 66.7, 'standby and signed count, tentative does not');
});

// ---------------------------------------------------------------------------
// Away notices (B5): the pure rules, then the routes

check('away (pure): a range covers its first and last day; a recurring notice covers its weekday from its start to its end (or forever); the weekday maths ignores clock changes', async () => {
  const { noticeCovers, coveredDates, coveringNotices, noticeOfRow } = await load('worker/away.js');
  // A range across the US spring-forward Sunday (2027-03-14): both ends are in, the day before and after are out, the 14th is covered like any day.
  const range = { from: '2027-03-10', to: '2027-03-16', weekday: null };
  assert.deepEqual(['2027-03-09', '2027-03-10', '2027-03-14', '2027-03-16', '2027-03-17'].map((day) => noticeCovers(range, day)), [false, true, true, true, false]);
  // A recurring Thursday (4) with an end date that is itself a Thursday: it covers that last Thursday and no later one.
  const thursdays = { from: '2027-03-04', to: '2027-03-25', weekday: 4 };
  assert.deepEqual(['2027-02-25', '2027-03-04', '2027-03-05', '2027-03-11', '2027-03-18', '2027-03-25', '2027-04-01'].map((day) => noticeCovers(thursdays, day)), [false, true, false, true, true, true, false]);
  // Without an end date it never stops - across the leap day and the fall-back Sunday - but it starts at `from`.
  const forever = { from: '2027-03-04', to: null, weekday: 4 };
  assert.deepEqual(['2027-03-03', '2027-03-04', '2027-04-01', '2028-03-02', '2028-03-03'].map((day) => noticeCovers(forever, day)), [false, true, true, true, false]);
  const sundays = { from: '2027-10-31', to: null, weekday: 0 };
  assert.deepEqual(['2027-10-31', '2027-11-06', '2027-11-07', '2027-11-14'].map((day) => noticeCovers(sundays, day)), [true, false, true, true], 'the fall-back Sunday 2027-11-07 is a Sunday');
  // A range without an end cannot be stored; read defensively it covers only its first day.
  assert.deepEqual(['2027-03-10', '2027-03-11'].map((day) => noticeCovers({ from: '2027-03-10', to: null, weekday: null }, day)), [true, false]);
  // The dates of a window (inclusive), oldest first, capped.
  assert.deepEqual(coveredDates({ from: '2027-01-01', to: null, weekday: 4 }, '2027-01-16', '2027-02-12'), ['2027-01-21', '2027-01-28', '2027-02-04', '2027-02-11']);
  assert.deepEqual(coveredDates({ from: '2027-01-01', to: null, weekday: 4 }, '2027-01-16', '2027-02-12', 2), ['2027-01-21', '2027-01-28']);
  assert.deepEqual(coveredDates(range, '2027-03-01', '2027-03-11'), ['2027-03-10', '2027-03-11'], 'the window cuts the range');
  assert.deepEqual(coveredDates(thursdays, '2027-03-19', '2027-04-30'), ['2027-03-25'], 'the end date cuts the recurrence');
  assert.deepEqual(coveringNotices([range, thursdays, forever], '2027-03-11'), [range, thursdays, forever]);
  assert.deepEqual(coveringNotices([range, thursdays, forever], '2027-03-16'), [range]);
  assert.deepEqual(noticeOfRow({ id: 'an_x', player_id: 'p_x', kind: 'late', at_time: '21:00', starts_on: '2027-01-20', ends_on: null, weekday: 4, created_at: 5 }),
    { id: 'an_x', personId: 'p_x', kind: 'late', atTime: '21:00', from: '2027-01-20', to: null, weekday: 4, createdAt: 5 });
});

check('away (pure): the effects on one raid - who is Away, who is Late or Leaving, and the sign-ups an attendance recompute adds', async () => {
  const { raidNoticeEffects, attendanceAwaySignups } = await load('worker/away.js');
  const n = (id, personId, kind, extra = {}) => ({ id, personId, kind, atTime: kind === 'away' ? null : '21:00', from: '2027-01-20', to: '2027-01-27', weekday: null, createdAt: 100, ...extra });
  const notices = [
    n('an_2', 'p1', 'away'), n('an_1', 'p1', 'away'), n('an_3', 'p2', 'away'),
    n('an_4', 'p3', 'leaving', { atTime: '22:00' }), n('an_5', 'p3', 'late', { atTime: '21:30' }),
    n('an_6', 'p4', 'late', { atTime: '21:30' }), n('an_7', 'p4', 'late', { atTime: '21:00' }),
    n('an_8', 'p5', 'away', { from: '2027-02-01', to: '2027-02-02' }),
  ];
  const effects = raidNoticeEffects(notices, '2027-01-21', new Set(['p1', 'p3', 'p4', 'p5']));
  assert.deepEqual(effects.away, [{ personId: 'p1', noticeId: 'an_1' }], 'p2 is not eligible, p5\'s notice is another week');
  assert.deepEqual([...effects.notes.entries()], [['p3', { kind: 'late', atTime: '21:30', noticeId: 'an_5' }], ['p4', { kind: 'late', atTime: '21:00', noticeId: 'an_7' }]], 'Late before Leaving, then the earlier time');

  // Attendance: only Away notices, a character on the team, still in the guild that day, filed before the raid began.
  const raid = { raidOn: '2027-01-21', teamId: 't_a', startsAt: 1000 };
  const person = (playerId, status, teamId = 't_a', leftOn = null) => ({ playerId, status, leftOn, characters: [{ teamId }] });
  const people = [person('p1', 'raider'), person('p2', 'inactive'), person('p3', 'raider', 't_b'), person('p4', 'inactive', 't_a', '2027-01-21'), person('p5', 'inactive', 't_a', '2027-01-20'),
    person('p6', 'raider'), person('p7', 'trial'), person('p8', 'raider'), person('p9', 'reserve')];
  const away = (personId, extra = {}) => ({ personId, kind: 'away', from: '2027-01-20', to: '2027-01-27', weekday: null, createdAt: 500, ...extra });
  const list = [away('p1'), away('p1', { createdAt: 900 }), away('p2'), away('p3'), away('p4'), away('p5'), away('p6', { createdAt: 1000 }), away('p7', { createdAt: 1001 }),
    away('p8', { kind: 'late' }), away('p9', { weekday: 5, to: null }), away('p0')];
  assert.deepEqual(attendanceAwaySignups(list, raid, people), [
    { playerId: 'p1', kind: 'absence', source: 'away' },
    { playerId: 'p4', kind: 'absence', source: 'away' },
    { playerId: 'p6', kind: 'absence', source: 'away' },
  ], 'p1 once; p2 inactive, p3 on another team, p5 left before, p7 filed after the start, p8 only late, p9 other weekday (2027-01-21 is a Thursday), p0 unknown');
  assert.deepEqual(attendanceAwaySignups([away('p9', { weekday: 4, to: null })], raid, people), [{ playerId: 'p9', kind: 'absence', source: 'away' }], 'p9 on her weekday');
});

check('away (pure): a member cannot edit a notice to cover days that have passed; the input checks', async () => {
  const { addsPastCoverage, validateNotice, MAX_RANGE_DAYS } = await load('worker/away.js');
  const today = '2027-01-16'; // a Saturday
  const thursdays = { from: '2027-01-07', to: null, weekday: 4 };
  assert.equal(addsPastCoverage(thursdays, { ...thursdays, weekday: 5 }, today), true, 'Fridays 01-08 and 01-15 are new and past');
  assert.equal(addsPastCoverage(thursdays, { ...thursdays, to: '2027-02-04' }, today), false, 'an end date only removes days');
  assert.equal(addsPastCoverage(thursdays, { ...thursdays, kind: 'late' }, today), false);
  assert.equal(addsPastCoverage({ ...thursdays, to: '2027-01-08' }, { ...thursdays, to: '2027-02-04' }, today), true, 'stretching the end back over 01-14 is past');
  assert.equal(addsPastCoverage({ from: '2027-01-20', to: '2027-01-22', weekday: null }, { from: '2027-01-16', to: '2027-01-22', weekday: null }, today), false, 'today and later are not past');
  assert.equal(addsPastCoverage({ from: '2027-01-20', to: '2027-01-22', weekday: null }, { from: '2027-01-14', to: '2027-01-22', weekday: null }, today), true);

  const ok = (body, opts = {}) => validateNotice(body, { today, officer: false, ...opts });
  const bad = (body, field, opts = {}) => {
    const result = ok(body, opts);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.field, field, `${JSON.stringify(body)} -> ${result.message}`);
    assert.equal(typeof result.message, 'string');
  };
  assert.deepEqual(ok({ kind: 'away', from: '2027-01-16', to: '2027-01-16' }), { ok: true, value: { kind: 'away', from: '2027-01-16', to: '2027-01-16', weekday: null, atTime: null, reason: null } });
  assert.deepEqual(ok({ kind: 'late', from: '2027-01-20', weekday: 4, atTime: '21:00', reason: '  work \n shift  ' }).value, { kind: 'late', from: '2027-01-20', to: null, weekday: 4, atTime: '21:00', reason: 'work  shift' });
  assert.equal(ok({ kind: 'away', from: '2027-01-20', to: '2027-01-21', atTime: '99:99' }).value.atTime, null, 'Away ignores atTime');
  assert.equal(ok({ kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: '   ' }).value.reason, null, 'a blank reason is none');
  assert.equal(ok({ kind: 'leaving', from: '2027-01-20', weekday: 2, atTime: '00:00' }).ok, true);
  assert.equal(ok({ kind: 'leaving', from: '2027-01-20', weekday: 2, atTime: '23:59' }).ok, true);
  assert.equal(ok({ kind: 'away', from: '2027-01-20', to: '2028-01-21' }).ok, true, `${MAX_RANGE_DAYS} days after the start is the last day allowed`);
  bad(undefined, 'kind'); bad({}, 'kind'); bad({ kind: 'sick', from: '2027-01-20', to: '2027-01-21' }, 'kind'); bad({ kind: 5 }, 'kind');
  bad({ kind: 'away', to: '2027-01-21' }, 'from'); bad({ kind: 'away', from: '2027-02-30', to: '2027-03-01' }, 'from'); bad({ kind: 'away', from: '20-1-2027', to: '2027-03-01' }, 'from');
  bad({ kind: 'away', from: '2027-01-15', to: '2027-01-20' }, 'from'); // a member: not before today
  bad({ kind: 'away', from: '2004-11-22', to: '2004-11-23' }, 'from', { officer: true });
  bad({ kind: 'away', from: '2027-01-20' }, 'to');                                            // a range needs an end
  bad({ kind: 'away', from: '2027-01-20', to: '2027-01-19' }, 'to');
  bad({ kind: 'away', from: '2027-01-20', to: '2027-13-01' }, 'to');
  bad({ kind: 'away', from: '2027-01-20', to: '2028-01-22' }, 'to');                         // 367 days
  bad({ kind: 'away', from: '2027-01-20', weekday: 4, to: '2027-01-19' }, 'to');            // a recurring one with an end before the start
  bad({ kind: 'away', from: '2027-01-20', weekday: 7 }, 'weekday'); bad({ kind: 'away', from: '2027-01-20', weekday: -1 }, 'weekday'); bad({ kind: 'away', from: '2027-01-20', weekday: '4' }, 'weekday');
  bad({ kind: 'late', from: '2027-01-20', weekday: 4 }, 'atTime'); bad({ kind: 'late', from: '2027-01-20', weekday: 4, atTime: '24:00' }, 'atTime');
  bad({ kind: 'leaving', from: '2027-01-20', weekday: 4, atTime: '9:00' }, 'atTime'); bad({ kind: 'leaving', from: '2027-01-20', weekday: 4, atTime: '20:60' }, 'atTime'); bad({ kind: 'late', from: '2027-01-20', weekday: 4, atTime: 2100 }, 'atTime');
  bad({ kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 'x'.repeat(121) }, 'reason'); bad({ kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 7 }, 'reason');
  assert.equal(ok({ kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 'x'.repeat(120) }).ok, true);
  // Officers may date a notice in the past.
  assert.equal(ok({ kind: 'away', from: '2026-12-01', to: '2026-12-05' }, { officer: true }).ok, true);
  assert.equal(ok({ kind: 'away', from: '2026-12-01', to: '2026-12-05' }).ok, false);
  // A member editing: the start may stay in the past, but the notice may not grow over the past.
  const current = { from: '2027-01-07', to: null, weekday: 4 };
  assert.equal(ok({ kind: 'away', from: '2027-01-07', weekday: 4, to: '2027-03-04' }, { current }).ok, true, 'same start, a new end');
  assert.equal(ok({ kind: 'away', from: '2027-01-07', weekday: 5 }, { current }).field, 'from', 'another weekday would cover Fridays that are gone');
  assert.equal(ok({ kind: 'away', from: '2027-01-08', weekday: 4 }, { current }).field, 'from', 'a new start in the past is refused');
  assert.equal(ok({ kind: 'away', from: '2027-01-07', weekday: 5 }, { current, officer: true }).ok, true, 'an officer is not bound by it');
});

// Alpha (A) and Bravo (B); Bob (Officer), Carol (leads A), Dave (leads B), Erin / Gina / Hank (Members) whose persons are Eliora (A), Gorrim (A) and
// Wanderfell (B); Nodisc (A) has no Discord ID. The clock is 2027-01-16 12:00Z, a Saturday, 07:00 in New York.
async function awayWorld(opts = {}) {
  const s = await laneWorld(opts);
  s.p = {};
  const person = async (key, name, classId, spec, team, discord) => {
    const made = await addPerson(s, 'bob', team, name, { class: classId, mainSpec: spec, offSpec: null });
    s.p[key] = made.person.id;
    if (discord) exec(s.w, `UPDATE players SET discord_user_id = '${discord}' WHERE id = '${made.person.id}'`);
  };
  await person('eliora', 'Eliora', 'PRIEST', 'Holy', s.A, PEOPLE.erin.id);
  await person('gorrim', 'Gorrim', 'PALADIN', 'Protection', s.A, PEOPLE.gina.id);
  await person('wander', 'Wanderfell', 'DRUID', 'Restoration', s.B, PEOPLE.hank.id);
  await person('nodisc', 'Nodisc', 'ROGUE', 'Combat', s.A, null);
  s.post = (who, body) => s.call(who, 'POST', '/away', body);
  s.put = (who, id, body) => s.call(who, 'PUT', `/away/${id}`, body);
  s.del = (who, id) => s.call(who, 'DELETE', `/away/${id}`, {});
  s.mineList = async (who) => (await s.call(who, 'GET', '/away/mine')).json;
  s.stored = (where = '1 = 1', ...values) => s.w.rows(`SELECT * FROM away_notices WHERE ${where} ORDER BY starts_on, id`, ...values);
  // A notice somebody filed (the status must be 201), -> the notice.
  s.file = async (who, body) => {
    const r = await s.post(who, body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.notice;
  };
  return s;
}

check('away: a member files, lists, changes and removes their own notice; the replies have the contract\'s shapes', async () => {
  const s = await awayWorld();
  let r = await s.post('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-27', reason: '  Holiday\n in Spain ' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const notice = r.json.notice;
  assert.match(notice.id, /^an_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(notice, { id: notice.id, personId: s.p.eliora, kind: 'away', atTime: null, from: '2027-01-20', to: '2027-01-27', weekday: null, reason: 'Holiday in Spain', mine: true, createdAt: s.w.clock.now });
  assert.deepEqual(r.json.notices, [notice]);
  // A repeating weekday with a time, no end.
  const late = await s.file('erin', { kind: 'late', from: '2027-01-21', weekday: 4, atTime: '21:00' });
  assert.deepEqual([late.kind, late.atTime, late.from, late.to, late.weekday, late.reason], ['late', '21:00', '2027-01-21', null, 4, null]);
  assert.deepEqual(await s.mineList('erin'), { today: '2027-01-16', timeZone: 'America/New_York', personId: s.p.eliora, notices: [notice, late], max: 30 });
  // Change it: PUT replaces the fields.
  s.w.advance(1000);
  r = await s.put('erin', notice.id, { kind: 'leaving', from: '2027-01-20', to: '2027-01-24', atTime: '22:00', reason: null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.notice, { ...notice, kind: 'leaving', atTime: '22:00', to: '2027-01-24', reason: null });
  assert.deepEqual(r.json.notices.map((entry) => entry.id), [notice.id, late.id]);
  // Remove one.
  r = await s.del('erin', late.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.deleted, r.json.notices.map((entry) => entry.id)], [true, [notice.id]]);
  assert.equal((await s.stored()).length, 1);
  // A viewer with no roster person (the Guild Master) has none: an empty list, and nothing to write.
  assert.deepEqual(await s.mineList('alice'), { today: '2027-01-16', timeZone: 'America/New_York', personId: null, notices: [], max: 30 });
  const nobody = await s.post('alice', { kind: 'away', from: '2027-01-20', to: '2027-01-21' });
  assert.deepEqual([nobody.status, nobody.json.error], [403, 'forbidden']);
  // Away ignores a time.
  const noTime = await s.file('erin', { kind: 'away', from: '2027-02-01', to: '2027-02-02', atTime: '21:00' });
  assert.deepEqual([noTime.atTime, (await s.stored('id = ?', noTime.id))[0].at_time], [null, null]);
});

check('away: who may write for whom - a member for themselves, a team lead or officer for people on their teams, nobody for strangers', async () => {
  const s = await awayWorld();
  const body = { kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 'a private reason' };
  // A member cannot name another person.
  for (const who of ['erin', 'hank']) {
    const r = await s.post(who, { ...body, personId: s.p.gorrim });
    assert.deepEqual([r.status, r.json.error], [403, 'forbidden'], who);
  }
  assert.equal((await s.stored()).length, 0);
  // ... but naming their own person is the same as leaving it out.
  assert.equal((await s.post('erin', { ...body, personId: s.p.eliora })).status, 201);
  // Carol leads Alpha: Gorrim (Alpha) yes, Wanderfell (Bravo) no. Dave leads Bravo: the other way round. The Officer (guild-wide) both. A made-up person: 403.
  assert.equal((await s.post('carol', { ...body, personId: s.p.gorrim })).status, 201);
  assert.equal((await s.post('carol', { ...body, personId: s.p.wander })).status, 403);
  assert.equal((await s.post('dave', { ...body, personId: s.p.wander })).status, 201);
  assert.equal((await s.post('dave', { ...body, personId: s.p.gorrim })).status, 403);
  assert.equal((await s.post('bob', { ...body, personId: s.p.nodisc })).status, 201);
  assert.equal((await s.post('bob', { ...body, personId: s.p.wander })).status, 201);
  assert.equal((await s.post('bob', { ...body, personId: 'p_AAAAAAAAAAAAAAAAAAAAAA' })).status, 403);
  const malformed = await s.post('bob', { ...body, personId: 'nope' });
  assert.deepEqual([malformed.status, malformed.json.field], [400, 'personId']);
  // A person with no characters is on no team: no officer can act for them (the person themselves still can).
  exec(s.w, `DELETE FROM characters WHERE player_id = '${s.p.wander}'`);
  assert.equal((await s.post('bob', { ...body, personId: s.p.wander })).status, 403);
  assert.equal((await s.post('dave', { ...body, personId: s.p.wander })).status, 403);
  assert.equal((await s.post('hank', body)).status, 201, 'Hank is still Wanderfell\'s person');
  assert.equal((await s.call('bob', 'GET', `/away?person=${s.p.wander}`)).status, 403);

  // PUT and DELETE: a notice of someone else is a plain 404 for a member (ids are not probed) and for an officer of another team; fine for the right officer.
  const erins = (await s.stored('player_id = ?', s.p.eliora))[0];
  const ginas = (await s.stored('player_id = ?', s.p.gorrim))[0];
  const change = { kind: 'away', from: '2027-01-22', to: '2027-01-23' };
  const stranger = await s.put('gina', erins.id, change);
  assert.deepEqual([stranger.status, stranger.json.error], [404, 'not_found']);
  assert.equal((await s.del('gina', erins.id)).status, 404);
  assert.equal((await s.put('dave', ginas.id, change)).status, 404, 'a team lead of another team');
  assert.equal((await s.del('dave', ginas.id)).status, 404);
  assert.equal((await s.put('carol', ginas.id, change)).status, 200);
  assert.equal((await s.put('bob', erins.id, change)).status, 200);
  assert.equal((await s.del('carol', ginas.id)).status, 200);
  assert.equal((await s.del('erin', erins.id)).status, 200, 'the owner may remove what an officer changed');
  assert.equal((await s.del('erin', erins.id)).status, 404, 'gone');
  assert.equal((await s.put('erin', 'an_AAAAAAAAAAAAAAAAAAAAAA', change)).status, 404);
  assert.equal((await s.call('erin', 'DELETE', '/away/nope', {})).status, 404, 'a malformed id');
  assert.equal((await s.w.call({}, 'GET', `${s.guildPath}/away/mine`)).status, 401, 'signed out');
});

check('away: the input is checked field by field through the routes, and nothing is stored for a refused write', async () => {
  const s = await awayWorld();
  const refused = async (who, body, field) => {
    const r = await s.post(who, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'bad_request');
    assert.equal(r.json.field, field, JSON.stringify(r.json));
  };
  await refused('erin', { from: '2027-01-20', to: '2027-01-21' }, 'kind');
  await refused('erin', { kind: 'busy', from: '2027-01-20', to: '2027-01-21' }, 'kind');
  await refused('erin', { kind: 'away', to: '2027-01-21' }, 'from');
  await refused('erin', { kind: 'away', from: '2027-01-15', to: '2027-01-21' }, 'from');   // a member: not before the guild's today (2027-01-16)
  await refused('erin', { kind: 'away', from: '2027-01-20' }, 'to');
  await refused('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-19' }, 'to');
  await refused('erin', { kind: 'away', from: '2027-01-20', to: '2028-01-22' }, 'to');
  await refused('erin', { kind: 'away', from: '2027-01-20', weekday: 8 }, 'weekday');
  await refused('erin', { kind: 'late', from: '2027-01-20', weekday: 2 }, 'atTime');
  await refused('erin', { kind: 'leaving', from: '2027-01-20', weekday: 2, atTime: '7pm' }, 'atTime');
  await refused('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 'y'.repeat(121) }, 'reason');
  await refused('bob', { kind: 'away', from: '2004-11-22', to: '2004-11-24', personId: s.p.eliora }, 'from');
  await refused('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-21', personId: 5 }, 'personId');
  assert.equal((await s.stored()).length, 0);
  // Today's date is accepted for a member (the first day that is); a range of 366 days and a reason of 120 characters too.
  assert.equal((await s.post('erin', { kind: 'away', from: '2027-01-16', to: '2027-01-16' })).status, 201);
  assert.equal((await s.post('erin', { kind: 'away', from: '2027-02-01', to: '2028-02-02', reason: 'z'.repeat(120) })).status, 201);
  // An officer may enter a notice for the past.
  assert.equal((await s.post('bob', { kind: 'away', from: '2026-12-01', to: '2026-12-05', personId: s.p.eliora })).status, 201);
  // A reason is stripped to one line.
  const lines = await s.file('gina', { kind: 'away', from: '2027-01-20', to: '2027-01-21', reason: 'a\r\nb\tc\u0007d' });
  assert.equal(lines.reason, 'abcd');
});

check('away: at most 30 notices per person (409 too_many_notices), counted for the person - an officer\'s too - and freed by a delete', async () => {
  const s = await awayWorld();
  const day = (i) => `2027-03-${String(i + 1).padStart(2, '0')}`;
  const id = (i) => `an_${String(i).padStart(22, 'x')}`;
  const values = Array.from({ length: 30 }, (_, i) => `('${id(i)}', '${s.guildId}', '${s.p.eliora}', 'away', '${day(i)}', '${day(i)}', 1, 1)`).join(', ');
  exec(s.w, `INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES ${values}`);
  assert.equal((await s.stored('player_id = ?', s.p.eliora)).length, 30);
  const body = { kind: 'away', from: '2027-05-01', to: '2027-05-02' };
  let r = await s.post('erin', body);
  assert.deepEqual([r.status, r.json.error, r.json.max], [409, 'too_many_notices', 30]);
  r = await s.post('carol', { ...body, personId: s.p.eliora });
  assert.deepEqual([r.status, r.json.error], [409, 'too_many_notices'], 'an officer is held to it for the person');
  assert.equal((await s.stored('player_id = ?', s.p.eliora)).length, 30);
  assert.equal((await s.post('gina', body)).status, 201, 'the limit is per person');
  assert.equal((await s.del('erin', id(0))).status, 200);
  assert.equal((await s.post('erin', body)).status, 201, 'one removed: one more fits');
  assert.equal((await s.post('erin', body)).status, 409);
  assert.equal((await s.mineList('erin')).notices.length, 30);
});

check('away: officers\' lists - the team\'s next four weeks, and one person\'s notices; reasons are for the person and the officers over them', async () => {
  const s = await awayWorld();
  await s.file('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'secret holiday' });
  const refusedPast = await s.post('erin', { kind: 'late', from: '2027-01-05', weekday: 4, atTime: '21:00' });
  assert.equal(refusedPast.status, 400, 'a member\'s start is not in the past');
  const late = await s.file('erin', { kind: 'late', from: '2027-01-18', weekday: 4, atTime: '21:00' });
  await s.file('gina', { kind: 'leaving', from: '2027-02-10', to: '2027-02-12', atTime: '22:00', reason: 'another secret' });
  await s.file('gina', { kind: 'away', from: '2027-02-20', to: '2027-02-21' });                // beyond the four weeks (until 2027-02-13)
  await s.file('hank', { kind: 'away', from: '2027-01-20', to: '2027-01-21' });                // Bravo
  await s.file('bob', { kind: 'away', from: '2027-01-25', to: '2027-01-26', personId: s.p.nodisc, reason: 'by an officer' });
  // The team list: Alpha's, sorted by name, with the dates of the window each covers.
  const team = await s.call('carol', 'GET', `/away?team=${s.A}`);
  assert.equal(team.status, 200, JSON.stringify(team.json));
  assert.deepEqual([team.json.team, team.json.today, team.json.until], [{ id: s.A, name: 'Alpha' }, '2027-01-16', '2027-02-13']);
  assert.deepEqual(team.json.entries.map((e) => [e.name, e.kind, e.atTime, e.from, e.to, e.weekday, e.reason]), [
    ['Eliora', 'late', '21:00', '2027-01-18', null, 4, null],
    ['Eliora', 'away', null, '2027-01-20', '2027-01-22', null, 'secret holiday'],
    ['Gorrim', 'leaving', '22:00', '2027-02-10', '2027-02-12', null, 'another secret'],
    ['Nodisc', 'away', null, '2027-01-25', '2027-01-26', null, 'by an officer'],
  ]);
  const holiday = team.json.entries[1];
  assert.deepEqual([holiday.noticeId, holiday.personId, holiday.class, holiday.dates], [(await s.stored('reason = ?', 'secret holiday'))[0].id, s.p.eliora, 'PRIEST', ['2027-01-20', '2027-01-21', '2027-01-22']]);
  assert.deepEqual(team.json.entries[0].dates, ['2027-01-21', '2027-01-28', '2027-02-04', '2027-02-11'], 'the Thursdays from the 18th on within the window');
  assert.equal(team.json.entries[0].noticeId, late.id);
  assert.equal(team.json.entries.every((e) => e.dates.length <= 28), true);
  // Bravo's list is Hank's alone; an officer sees both; the lead of the other team and a member are refused.
  assert.deepEqual((await s.call('dave', 'GET', `/away?team=${s.B}`)).json.entries.map((e) => e.name), ['Wanderfell']);
  assert.deepEqual((await s.call('bob', 'GET', `/away?team=${s.B}`)).json.entries.map((e) => e.name), ['Wanderfell']);
  assert.equal((await s.call('dave', 'GET', `/away?team=${s.A}`)).status, 403);
  assert.equal((await s.call('erin', 'GET', `/away?team=${s.A}`)).status, 403);
  assert.equal((await s.call('bob', 'GET', '/away?team=t_AAAAAAAAAAAAAAAAAAAAAA')).status, 400);
  assert.equal((await s.call('bob', 'GET', '/away')).status, 400);
  assert.equal((await s.call('bob', 'GET', `/away?team=${s.A}&person=${s.p.eliora}`)).status, 400);

  // One person's notices: the person and the officers over them get them, reason included.
  for (const [who, status] of [['erin', 200], ['carol', 200], ['bob', 200], ['dave', 403], ['gina', 403], ['hank', 403]]) {
    const r = await s.call(who, 'GET', `/away?person=${s.p.eliora}`);
    assert.equal(r.status, status, who);
    if (status !== 200) continue;
    assert.deepEqual([r.json.personId, r.json.today], [s.p.eliora, '2027-01-16']);
    assert.deepEqual(r.json.notices.map((n) => [n.kind, n.reason, n.mine]), [['late', null, who === 'erin'], ['away', 'secret holiday', who === 'erin']]);
  }
  // Someone who is inactive is not listed.
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.gorrim}`, { expectedVersion: 1, status: 'inactive', leftOn: null })).status, 200);
  assert.deepEqual((await s.call('carol', 'GET', `/away?team=${s.A}`)).json.entries.map((e) => e.name), ['Eliora', 'Eliora', 'Nodisc']);
});

check('away: the reason is in nothing a member who is not the person can read - the sign-up view, the Raids list, the raid, the Planner seed', async () => {
  const s = await awayWorld();
  const raid = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-21', startTime: '20:00' });
  await s.file('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'secret holiday' });
  await s.file('erin', { kind: 'late', from: '2027-01-21', to: '2027-01-21', atTime: '21:15', reason: 'secret shift' });
  const everything = async (who) => JSON.stringify([
    (await s.call(who, 'GET', s.raid(raid.id, '/signups'))).json, (await s.call(who, 'GET', `/raids?team=${s.A}`)).json, (await s.call(who, 'GET', s.raid(raid.id))).json,
    (await s.call(who, 'GET', '/away/mine')).json, (await s.call(who, 'GET', '/attention')).json,
  ]);
  for (const who of ['gina', 'hank', 'dave', 'carol', 'bob']) assert(!(await everything(who)).includes('secret'), `${who} reads no reason there`);
  assert((await s.call('erin', 'GET', '/away/mine')).json.notices.some((n) => n.reason === 'secret holiday'), 'the person does');
  const seed = await s.call('bob', 'GET', s.raid(raid.id, '/planner'));
  assert(!JSON.stringify(seed.json).includes('secret'), 'the Planner seed has no reason');
});

check('away: officers\' writes for someone else are audited (kind and person only); a member\'s own are not', async () => {
  const s = await awayWorld();
  const mine = await s.file('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'secret holiday' });
  await s.put('erin', mine.id, { kind: 'away', from: '2027-01-20', to: '2027-01-23' });
  await s.del('erin', mine.id);
  assert.equal(await s.w.count('audit_log', "action LIKE 'away.%'"), 0, 'the member\'s own notices leave no trace in the log');
  const theirs = await s.file('carol', { kind: 'late', from: '2027-01-20', weekday: 4, atTime: '21:00', reason: 'secret by carol', personId: s.p.gorrim });
  s.w.advance(1000);
  assert.equal((await s.put('bob', theirs.id, { kind: 'leaving', from: '2027-01-20', weekday: 4, atTime: '22:30' })).status, 200);
  assert.equal((await s.del('carol', theirs.id)).status, 200);
  const rows = await s.w.rows("SELECT actor_user_id, action, entity_type, entity_id, before, after FROM audit_log WHERE action LIKE 'away.%' ORDER BY rowid");
  assert.deepEqual(rows.map((r) => [r.action, r.actor_user_id, r.entity_type, r.entity_id, r.before && JSON.parse(r.before), r.after && JSON.parse(r.after)]), [
    ['away.set', s.ids.carol, 'person', s.p.gorrim, null, { kind: 'late', personId: s.p.gorrim }],
    ['away.set', s.ids.bob, 'person', s.p.gorrim, { kind: 'late' }, { kind: 'leaving', personId: s.p.gorrim }],
    ['away.remove', s.ids.carol, 'person', s.p.gorrim, { kind: 'leaving', personId: s.p.gorrim }, null],
  ]);
  assert(!JSON.stringify(rows).includes('secret') && !JSON.stringify(rows).includes('Gorrim'), 'no reason, no name');
  // The Activity log phrases them with the person's name, looked up at read time.
  const log = await s.call('alice', 'GET', '/audit');
  assert.equal(log.status, 200, JSON.stringify(log.json));
  assert.deepEqual(log.json.rows.filter((row) => row.action.startsWith('away.')).map((row) => [row.action, row.group, row.text]).sort(), [
    ['away.remove', 'signups', 'Removed a notice of Gorrim (Leaving early)'],
    ['away.set', 'signups', 'Added a notice for Gorrim (Late)'],
    ['away.set', 'signups', 'Changed a notice for Gorrim (Leaving early)'],
  ]);
  // An officer writing for their own person is the person's own write: not audited.
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.bob.id}' WHERE id = '${s.p.nodisc}'`);
  await s.file('bob', { kind: 'away', from: '2027-01-20', to: '2027-01-21' });
  assert.equal(await s.w.count('audit_log', "action LIKE 'away.%'"), 3);
});

check('away: notices go with the person (delete cascades), stay when the account that wrote them is deleted, and Delete my data clears the reasons it wrote', async () => {
  const s = await awayWorld();
  const own = await s.file('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'erin\'s reason' });
  const byCarol = await s.file('carol', { kind: 'away', from: '2027-01-25', to: '2027-01-26', reason: 'carol\'s reason', personId: s.p.eliora });
  const gina = await s.file('gina', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'gina\'s reason' });
  // Erin deletes her account: her reason goes, her notice stays with Eliora (created_by is cleared with the account), Carol's keeps hers.
  assert.equal((await s.w.call(s.jars.erin, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.deepEqual((await s.stored('player_id = ?', s.p.eliora)).map((r) => [r.id, r.reason, r.created_by]), [[own.id, null, null], [byCarol.id, 'carol\'s reason', s.ids.carol]]);
  // Carol's account too: the reason of the notice she wrote for someone else goes as well.
  assert.equal((await s.w.call(s.jars.carol, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.deepEqual((await s.stored('player_id = ?', s.p.eliora)).map((r) => [r.reason, r.created_by]), [[null, null], [null, null]]);
  assert.equal((await s.stored('id = ?', gina.id))[0].reason, 'gina\'s reason', 'other accounts\' notices are untouched');
  // Removing the person removes their notices.
  exec(s.w, `DELETE FROM players WHERE id = '${s.p.eliora}'`);
  assert.deepEqual((await s.stored()).map((r) => r.id), [gina.id]);
});

// ---------------------------------------------------------------------------
// Away notices in the views (B5a / B5b): the virtual Absence, the Late / Leaving notes, the counts, `mine`, the calendar feed

// awayWorld plus an upcoming Alpha raid on Thursday 2027-01-21 20:00 and a past one on Thursday 2027-01-14.
async function awayRaidWorld(opts = {}) {
  const s = await awayWorld(opts);
  s.up = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-21', startTime: '20:00' })).id;
  s.past = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-14', startTime: '20:00' })).id;
  s.view = async (who, rid = s.up) => (await s.call(who, 'GET', s.raid(rid, '/signups'))).json;
  s.row = async (who, rid = s.up) => (await s.call(who, 'GET', `/raids?team=${s.A}`)).json.upcoming.find((raid) => raid.id === rid);
  s.sign = (who, body, rid = s.up) => s.call(who, 'PUT', s.raid(rid, '/signup'), body);
  return s;
}

check('away views: an Away notice is a virtual Absence on the sign-ups panel - never stored, counted, and a real sign-up always replaces it', async () => {
  const s = await awayRaidWorld();
  await s.file('erin', { kind: 'away', from: '2027-01-20', to: '2027-01-22', reason: 'secret holiday' });
  const view = await s.view('bob');
  const away = view.entries.find((entry) => entry.source === 'away');
  assert.deepEqual(away, {
    key: `a:${s.p.eliora}`, personId: s.p.eliora, source: 'away', kind: 'absence', name: 'Eliora', classId: 'PRIEST', className: 'Priest', spec: null, role: null,
    characterId: null, note: null, updatedAt: null, matched: true, isMe: false, nickname: null,
  });
  assert.deepEqual([view.entries.length, view.counts.absence, view.counts.expected, view.notices], [1, 1, 0, []]);
  assert.equal(await s.w.count('raid_signups'), 0, 'a virtual entry is never stored');
  // The person's own view: it is hers, and me.signup is it.
  const own = await s.view('erin');
  assert.deepEqual([own.me.signup.key, own.me.signup.isMe, own.me.signup.source, own.me.signup.kind, own.counts.absence], [`a:${s.p.eliora}`, true, 'away', 'absence', 1]);
  // A real sign-up of any kind replaces it at once (a Raidsmith one, then a Raid-Helper one in its place).
  assert.equal((await s.sign('erin', { kind: 'signed' })).status, 200);
  let after = await s.view('bob');
  assert.deepEqual(after.entries.map((entry) => [entry.name, entry.source, entry.kind]), [['Eliora', 'raidsmith', 'signed']]);
  assert.deepEqual([after.counts.absence, after.counts.signed], [0, 1]);
  assert.equal((await s.sign('erin', { kind: 'absence' })).status, 200);
  after = await s.view('bob');
  assert.deepEqual(after.entries.map((entry) => [entry.source, entry.kind]), [['raidsmith', 'absence']], 'a real Absence is one entry, not two');
  assert.equal((await s.call('erin', 'DELETE', s.raid(s.up, '/signup'), {})).status, 200);
  assert.deepEqual((await s.view('bob')).entries.map((entry) => [entry.source, entry.kind]), [['away', 'absence']], 'delete the sign-up and the notice shows again');
  const event = '777777777777777702';
  s.w.sources.events.set(event, rhEvent(event, SERVER_A, [signUp(1, PEOPLE.erin.id, 'Erin', 'Priest', 'Holy1')], { startTime: rhStart('2027-01-21T20:00:00-05:00') }));
  assert.equal((await s.call('bob', 'PUT', s.raid(s.up, '/event'), { source: event })).status, 200);
  assert.deepEqual((await s.view('bob')).entries.map((entry) => [entry.source, entry.kind]), [['raid_helper', 'signed']], 'a Raid-Helper sign-up outranks the notice too');
});

check('away views: who gets an entry - the date must be covered, the person must have a character on the team and not be inactive; past raids get none', async () => {
  const s = await awayRaidWorld();
  const names = async () => (await s.view('bob')).entries.map((entry) => entry.name).sort();
  await s.file('erin', { kind: 'away', from: '2027-01-22', to: '2027-01-23' });                      // the day after the raid
  await s.file('gina', { kind: 'away', from: '2027-01-20', weekday: 3 });                           // Wednesdays: not Thursday
  await s.file('hank', { kind: 'away', from: '2027-01-20', to: '2027-01-22' });                     // Bravo's person
  assert.deepEqual(await names(), []);
  await s.file('gina', { kind: 'away', from: '2027-01-17', weekday: 4, to: '2027-01-28' });         // Thursdays through the 28th: the 21st is in
  assert.deepEqual(await names(), ['Gorrim']);
  await s.file('bob', { kind: 'away', from: '2027-01-21', to: '2027-01-21', personId: s.p.nodisc });  // a one-day range on the day itself
  assert.deepEqual(await names(), ['Gorrim', 'Nodisc']);
  // The past raid (Thursday 2027-01-14) has no virtual entries though a notice covers it, and its counts do not change.
  await s.file('bob', { kind: 'away', from: '2027-01-14', to: '2027-01-14', personId: s.p.nodisc });
  const past = await s.view('bob', s.past);
  assert.deepEqual([past.entries.length, past.counts.absence, past.notices], [0, 0, []]);
  // Bravo's raid on the same night shows Hank, not Alpha's people.
  const bravo = (await s.makeRaid({ teamId: s.B, raidOn: '2027-01-21', startTime: '20:00' })).id;
  await s.file('hank', { kind: 'away', from: '2027-01-21', to: '2027-01-21' });
  assert.deepEqual((await s.view('bob', bravo)).entries.map((entry) => entry.name), ['Wanderfell']);
  assert.deepEqual(await names(), ['Gorrim', 'Nodisc'], 'Hank is not on Alpha');
  // Gorrim goes inactive: no entry. A character on a second team: she is shown on both.
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.gorrim}`, { expectedVersion: 1, status: 'inactive', leftOn: null })).status, 200);
  assert.deepEqual(await names(), ['Nodisc']);
  assert.equal((await addAlt(s, 'bob', s.p.nodisc, s.B, 'Nodiscalt')).status, 201);
  assert.deepEqual((await s.view('bob', bravo)).entries.map((entry) => entry.name), ['Nodiscalt', 'Wanderfell'], 'Nodisc has a character on Bravo too, and is shown by it there');
});

check('away views: Late and Leaving notices are a note on the person\'s entry, or on the panel\'s notices list when they have none - never a reason', async () => {
  const s = await awayRaidWorld();
  await s.file('gina', { kind: 'late', from: '2027-01-21', to: '2027-01-21', atTime: '21:00', reason: 'secret shift' });
  await s.file('erin', { kind: 'leaving', from: '2027-01-17', weekday: 4, atTime: '22:30' });
  await s.file('erin', { kind: 'late', from: '2027-01-17', weekday: 4, atTime: '20:45' });
  let view = await s.view('bob');
  assert.deepEqual(view.entries, [], 'no entry for a late or leaving notice');
  assert.deepEqual(view.notices, [
    { personId: s.p.eliora, name: 'Eliora', kind: 'late', atTime: '20:45' },   // a Late one beats a Leaving one
    { personId: s.p.gorrim, name: 'Gorrim', kind: 'late', atTime: '21:00' },
  ]);
  assert(!JSON.stringify(view).includes('secret'));
  assert.deepEqual((await s.view('gina')).me.notice, { kind: 'late', atTime: '21:00' }, 'a member who cannot see the list still sees their own');
  // Once they sign up the note moves onto their entry.
  assert.equal((await s.sign('gina', { kind: 'signed' })).status, 200);
  view = await s.view('bob');
  assert.deepEqual(view.entries.map((entry) => [entry.name, entry.kind, entry.notice]), [['Gorrim', 'signed', { kind: 'late', atTime: '21:00' }]]);
  assert.deepEqual(view.notices.map((notice) => notice.name), ['Eliora']);
  assert.deepEqual(view.counts.absence, 0, 'a note is not an absence');
  // A person who is away AND late: the virtual Absence stands and carries no note.
  await s.file('erin', { kind: 'away', from: '2027-01-21', to: '2027-01-21' });
  view = await s.view('bob');
  const erin = view.entries.find((entry) => entry.name === 'Eliora');
  assert.deepEqual([erin.source, 'notice' in erin], ['away', false]);
});

check('away views: the Raids list counts the virtual Absences and tells the viewer ("mine"); a real sign-up replaces them', async () => {
  const s = await awayRaidWorld();
  await s.file('erin', { kind: 'away', from: '2027-01-21', to: '2027-01-21' });
  await s.file('gina', { kind: 'away', from: '2027-01-20', weekday: 4 });
  await s.file('hank', { kind: 'away', from: '2027-01-21', to: '2027-01-21' });
  let row = await s.row('bob');
  assert.deepEqual(row.signups, { signed: 0, late: 0, standby: 0, bench: 0, tentative: 0, absence: 2 });
  assert.equal(row.mine, null, 'Bob has no notice');
  assert.deepEqual((await s.row('erin')).mine, { kind: 'absence', source: 'away', characterName: null });
  assert.deepEqual((await s.row('gina')).mine, { kind: 'absence', source: 'away', characterName: null });
  assert.equal((await s.row('hank')).mine, null, 'Hank is not on Alpha: his notice is not on its raids');
  // A real sign-up: counted once, as it is, and `mine` is the real one.
  assert.equal((await s.sign('erin', { kind: 'signed' })).status, 200);
  row = await s.row('bob');
  assert.deepEqual([row.signups.absence, row.signups.signed], [1, 1]);
  assert.deepEqual((await s.row('erin')).mine, { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' });
});

check('away views: the calendar feed counts them ("Can\'t come 1") and tells the member ("Your sign-up: Away (notice)"); a real sign-up replaces it', async () => {
  const s = await awayRaidWorld();
  await s.file('erin', { kind: 'away', from: '2027-01-21', to: '2027-01-21' });
  await s.file('bob', { kind: 'away', from: '2027-01-14', weekday: 4, personId: s.p.gorrim });  // an officer's: it covers the past raid too, but only the upcoming one counts it
  const made = await s.call('erin', 'POST', '/calendar', { teamId: s.A });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const feed = async () => {
    const events = readIcs(await (await s.w.req('GET', new URL(made.json.url).pathname)).text());
    return Object.fromEntries(events.map((event) => [event.UID, event.DESCRIPTION.split('\n')]));
  };
  let lines = await feed();
  assert.deepEqual(lines[`${s.up}@raidsmith`].slice(0, 2), ['Can\'t come 2', 'Your sign-up: Away (notice)']);
  assert.deepEqual(lines[`${s.past}@raidsmith`].slice(0, 1), ['No sign-ups yet'], 'a raid that has started has no virtual entries');
  assert.equal((await s.sign('erin', { kind: 'late' })).status, 200);
  lines = await feed();
  assert.deepEqual(lines[`${s.up}@raidsmith`].slice(0, 2), ['Late 1, Can\'t come 1', 'Your sign-up: Late']);
});

// ---------------------------------------------------------------------------
// The Planner seed (B6): markers for Away, "also in another raid", Late, Leaving and Standby; the Planner's own reader accepts every one

// The Planner's sandbox: its Raid-Helper importer reads what RaidLink.seedToRaidHelper writes from a seed.
const plannerReader = () => {
  const ctx = require('./tests/load-app').sandbox(['Import', 'RaidLink', 'Config', 'SignupMarker']);
  return { clean: (marker) => JSON.parse(JSON.stringify(ctx.api.SignupMarker.clean(marker))), entries: (seed) => ctx.api.Import.parseRaidHelperSignUps(JSON.parse(ctx.api.RaidLink.seedToRaidHelper(seed))).entries };
};

check('seed markers: Away, Also in, Late, Leaving and Standby - the strongest one per row, ASCII, and the Planner\'s own reader accepts every kind', async () => {
  const s = await awayRaidWorld({ teams: 3 });
  s.C = s.teams[2];
  const persons = {};
  for (const [key, name, classId, spec] of [['hestia', 'Hestia', 'PRIEST', 'Shadow'], ['cassia', 'Cassia', 'MAGE', 'Frost'], ['brindle', 'Brindle', 'MAGE', 'Fire'], ['fenwick', 'Fenwick', 'ROGUE', 'Combat'], ['dunmar', 'Dunmar', 'WARRIOR', 'Fury']]) {
    persons[key] = (await addPerson(s, 'bob', s.A, name, { class: classId, mainSpec: spec, offSpec: null })).person.id;
  }
  const pid = { ...s.p, ...persons };
  const officer = async (rid, key, kind) => assert.equal((await s.call('bob', 'PUT', s.raid(rid, `/signups/${pid[key]}`), { kind })).status, 200, `${key} ${kind}`);
  const notice = (key, body) => s.file('bob', { personId: pid[key], from: '2027-01-21', to: '2027-01-21', ...body });
  // The other raids of the night: Bravo at 22:00 (two hours after Alpha's 20:00), Charlie at 00:00 on the 22nd (exactly four hours), Bravo again at 00:01 (four hours and a minute).
  const bravo = (await s.makeRaid({ teamId: s.B, raidOn: '2027-01-21', startTime: '22:00' })).id;
  const charlie = (await s.makeRaid({ teamId: s.C, raidOn: '2027-01-22', startTime: '00:00' })).id;
  const bravoLate = (await s.makeRaid({ teamId: s.B, raidOn: '2027-01-22', startTime: '00:01' })).id;

  await notice('eliora', { kind: 'away' });                                         // Away, no sign-up: a virtual Absence row
  await officer(s.up, 'dunmar', 'tentative'); await notice('dunmar', { kind: 'away' }); await officer(bravo, 'dunmar', 'signed'); // a real sign-up outranks the notice; tentative is not "coming"
  await officer(s.up, 'gorrim', 'signed'); await notice('gorrim', { kind: 'late', atTime: '21:00' });
  await officer(s.up, 'hestia', 'signed'); await notice('hestia', { kind: 'leaving', atTime: '22:30' });
  await officer(s.up, 'cassia', 'standby');
  await officer(s.up, 'nodisc', 'standby'); await notice('nodisc', { kind: 'late', atTime: '21:00' }); await officer(bravo, 'nodisc', 'signed'); // also > late > standby
  await officer(s.up, 'brindle', 'signed'); await officer(charlie, 'brindle', 'late');         // exactly four hours: still "also"
  await officer(s.up, 'fenwick', 'signed'); await officer(bravoLate, 'fenwick', 'signed');      // four hours and a minute: not

  const seed = (await s.call('bob', 'GET', s.raid(s.up, '/planner'))).json;
  const by = Object.fromEntries(seed.signups.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(by).sort(), ['Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Gorrim', 'Hestia', 'Nodisc']);
  assert.deepEqual(by.Eliora, {
    key: `aw${pid.eliora}`, name: 'Eliora', discordName: null, personId: pid.eliora, source: 'away', className: 'Absence', specName: null, kind: 'absence', position: 1000,
    marker: { kind: 'away', text: 'Away: notice' },
  });
  assert.equal(seed.signups[seed.signups.length - 1].name, 'Eliora', 'the virtual rows come after the real ones');
  assert.deepEqual([by.Dunmar.kind, by.Dunmar.className, 'marker' in by.Dunmar], ['tentative', 'Tentative', false], 'a real sign-up: no virtual row, no away marker, and tentative is not "also"');
  assert.deepEqual([by.Gorrim.kind, by.Gorrim.className, by.Gorrim.marker], ['signed', 'Paladin', { kind: 'late', text: 'Late: 21:00' }]);
  assert.deepEqual([by.Hestia.kind, by.Hestia.marker], ['signed', { kind: 'leaving', text: 'Leaves: 22:30' }]);
  const { raidHelperSpecKey } = await load('worker/signups-data.js');
  assert.deepEqual([by.Cassia.kind, by.Cassia.className, by.Cassia.specName, by.Cassia.marker], ['standby', 'Mage', raidHelperSpecKey('MAGE', 'Frost'), { kind: 'standby', text: 'Standby' }]);
  assert.deepEqual([by.Nodisc.kind, by.Nodisc.className, by.Nodisc.marker], ['standby', 'Rogue', { kind: 'also', text: 'Also in: Bravo raid' }]);
  assert.deepEqual([by.Brindle.kind, by.Brindle.marker], ['signed', { kind: 'also', text: 'Also in: Charlie raid' }]);
  assert.equal('marker' in by.Fenwick, false);
  assert.equal(seed.signups.filter((row) => row.source === 'away').length, 1, 'Dunmar has a sign-up, so only Eliora is a virtual row');

  // The other direction: on Bravo's raid Nodisc is "also in" Alpha's.
  const bravoSeed = (await s.call('bob', 'GET', s.raid(bravo, '/planner'))).json;
  assert.deepEqual(bravoSeed.signups.map((row) => [row.name, row.marker && row.marker.text]).sort(), [['Dunmar', undefined], ['Nodisc', 'Also in: Alpha raid']]);

  // The Planner reads every kind of marker: its importer keeps the marker as sent (SignupMarker.clean) and files nothing for review.
  const reader = plannerReader();
  const entries = reader.entries(seed);
  const entry = Object.fromEntries(entries.map((e) => [e.name, e]));
  for (const row of seed.signups) {
    if (!row.marker) { assert.equal(entry[row.name].marker, undefined, `${row.name} has none`); continue; }
    assert.deepEqual(JSON.parse(JSON.stringify(entry[row.name].marker)), reader.clean(row.marker), `${row.name}: the Planner accepts the ${row.marker.kind} marker`);
    assert.deepEqual(reader.clean(row.marker), row.marker, `${row.name}: and keeps it exactly`);
  }
  assert.deepEqual(['away', 'also', 'late', 'leaving', 'standby'].filter((kind) => !seed.signups.some((row) => row.marker && row.marker.kind === kind)), [], 'every kind was exercised');
  assert(entries.every((e) => !e.needsReview), 'nothing was guessed');
  assert.equal(entry.Eliora.status, 'absent', 'the virtual Absence arrives as Absent');
  assert.equal(entry.Cassia.status, 'confirmed', 'a standby arrives as signed up');
});

check('seed markers: text is printable ASCII of at most 60 characters whatever the other team is called; a notice or a sign-up that does not apply gives none', async () => {
  const s = await awayRaidWorld({ teams: 3 });
  s.C = s.teams[2];
  const other = (await s.makeRaid({ teamId: s.C, raidOn: '2027-01-21', startTime: '21:00' })).id;
  for (const key of ['eliora', 'gorrim']) {
    for (const rid of [s.up, other]) assert.equal((await s.call('bob', 'PUT', s.raid(rid, `/signups/${s.p[key]}`), { kind: 'signed' })).status, 200);
  }
  const alsoText = async (who) => (await s.call('bob', 'GET', s.raid(s.up, '/planner'))).json.signups.find((row) => row.name === who).marker.text;
  exec(s.w, `UPDATE teams SET name = 'Équipe Ünï' WHERE id = '${s.C}'`);
  assert.equal(await alsoText('Eliora'), 'Also in: quipe n raid', 'characters outside printable ASCII are dropped');
  exec(s.w, `UPDATE teams SET name = '${'x'.repeat(80)}' WHERE id = '${s.C}'`);
  const long = await alsoText('Eliora');
  assert.deepEqual([long.length, /^[\x20-\x7e]+$/.test(long), long.startsWith('Also in: xxx')], [60, true, true]);
  exec(s.w, `UPDATE teams SET name = 'ÉÜ' WHERE id = '${s.C}'`);
  assert.equal(await alsoText('Eliora'), 'Also in: another team raid', 'a name with nothing printable left');
  // A raid that has started has nothing to plan: no virtual rows or notes.
  const started = (await s.call('bob', 'GET', s.raid(s.past, '/planner'))).json;
  assert.deepEqual(started.signups, []);
});

check('seed markers: no "also in another raid" when either start time is unknown (date-only raids)', async () => {
  const s = await awayRaidWorld({ teams: 3 });
  s.C = s.teams[2];
  const timed = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-22', startTime: '06:30' })).id;
  const dateOnly = (await s.makeRaid({ teamId: s.C, raidOn: '2027-01-22' })).id;            // noon UTC = 07:00 New York: half an hour away, but nobody knows the time
  const morning = (await s.makeRaid({ teamId: s.B, raidOn: '2027-01-22', startTime: '08:00' })).id;
  for (const rid of [timed, dateOnly, morning]) assert.equal((await s.call('bob', 'PUT', s.raid(rid, `/signups/${s.p.eliora}`), { kind: 'signed' })).status, 200);
  const marked = async (rid) => (await s.call('bob', 'GET', s.raid(rid, '/planner'))).json.signups.map((row) => row.marker && row.marker.text);
  assert.deepEqual(await marked(timed), ['Also in: Bravo raid'], 'the timed raid sees the other timed raid only');
  assert.deepEqual(await marked(dateOnly), [undefined], 'a date-only raid has no start to compare');
  assert.deepEqual(await marked(morning), ['Also in: Alpha raid']);
});

// ---------------------------------------------------------------------------
// Away notices in the attendance results (B5c): "missed with notice" for a raid the person missed under an Away notice filed before it began

// attWorld (Alpha with seven raiders) plus the notice helpers of awayWorld. Notices are filed by Bob (an officer: any date) unless the test says otherwise.
async function attAwayWorld() {
  const s = await attWorld();
  s.post = (who, body) => s.call(who, 'POST', '/away', body);
  s.put = (who, id, body) => s.call(who, 'PUT', `/away/${id}`, body);
  s.del = (who, id) => s.call(who, 'DELETE', `/away/${id}`, {});
  s.file = async (who, body) => {
    const r = await s.post(who, body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.notice;
  };
  s.notice = (key, body, who = 'bob') => s.file(who, { personId: s.p[key], ...body });
  s.raidRow = async (rid) => (await s.w.rows('SELECT version, policy_fp, open_flags FROM raids WHERE id = ?', rid))[0];
  s.setPolicy = async (policy) => {
    const current = (await s.call('bob', 'GET', '/attendance/policy')).json;
    const r = await s.call('bob', 'PUT', '/attendance/policy', { policy, expectedVersion: current.versions.guild });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  return s;
}
const DAY = 86400000;

check('away attendance: a missed raid under a covering Away notice is "missed with notice"; the policy decides the credit; attending, a real sign-up and the wrong date or weekday all beat or miss it', async () => {
  const s = await attAwayWorld();
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.eliora}'`);
  // The raid is Tuesday 2027-01-19 20:00; the clock (Saturday the 16th) is before it, so every notice below is filed in time.
  const brindle = await s.notice('brindle', { kind: 'away', from: '2027-01-18', to: '2027-01-19' });
  await s.notice('aldric', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });                         // came anyway
  await s.notice('cassia', { kind: 'away', from: '2027-01-17', weekday: 2 });                              // every Tuesday, no end
  await s.notice('dunmar', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });                         // but signed up
  await s.file('erin', { kind: 'away', from: '2027-01-17', weekday: 2, to: '2027-01-26' });                 // Eliora's own: Tuesdays until the 26th
  await s.notice('fenwick', { kind: 'away', from: '2027-01-17', weekday: 3 });                              // Wednesdays: not the 19th
  await s.notice('gorrim', { kind: 'away', from: '2027-01-17', weekday: 2, to: '2027-01-18' });             // Tuesdays, but the end is before the 19th
  const rid = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' })).id;
  const upcoming = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-26', startTime: '20:00' })).id;
  await s.sign('dunmar', 'signed', rid);
  s.w.advance(4 * DAY);                                                                                    // 2027-01-20 12:00Z: the raid has started
  await s.manual(rid, ['aldric']);
  const missedWithNotice = ['missed_notice', 0, 'absence', []];
  assert.deepEqual(await s.att(rid), {
    Aldric: ['present', 1, 'absence', []],                  // attended: present as always
    Brindle: missedWithNotice,
    Cassia: missedWithNotice,
    Dunmar: ['missed', 0, 'signed', ['no_show']],          // a real sign-up wins: signed and absent is missed
    Eliora: missedWithNotice,
    Fenwick: ['no_signup', null, null, []],                 // the wrong weekday
    Gorrim: ['no_signup', null, null, []],                  // the recurrence ended before the raid
  });
  const flagsAfter = await s.raidRow(rid);
  assert.equal(flagsAfter.open_flags, 1, 'only the no-show of Dunmar needs a look: a notice needs no review');
  // The policy decides the credit: excused is not counted.
  await s.setPolicy({ absence: 'excused' });
  await s.recompute(rid);
  assert.deepEqual([(await s.att(rid)).Brindle, (await s.att(rid)).Dunmar], [['missed_notice', null, 'absence', []], ['missed', 0, 'signed', ['no_show']]]);
  await s.setPolicy({ absence: 'missedWithNotice' });
  await s.recompute(rid);
  assert.deepEqual((await s.att(rid)).Brindle, missedWithNotice);

  // Changing the notice recomputes the raid at once: new dates that miss the raid give back the plain result ...
  const before = await s.raidRow(rid);
  assert.notEqual(before.policy_fp, '');
  s.w.advance(1000);
  let r = await s.put('bob', brindle.id, { kind: 'away', from: '2027-01-20', to: '2027-01-21' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await s.att(rid)).Brindle, ['no_signup', null, null, []]);
  const after = await s.raidRow(rid);
  assert.deepEqual([after.version > before.version, after.policy_fp === before.policy_fp, after.policy_fp !== ''], [true, true, true], 'bumped, recomputed in the request, not left stale');
  // ... dates that cover it bring it back, and so does a Late notice NOT (it changes no result).
  r = await s.put('bob', brindle.id, { kind: 'away', from: '2027-01-19', weekday: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual((await s.att(rid)).Brindle, missedWithNotice);
  const version = (await s.raidRow(rid)).version;
  assert.equal((await s.put('bob', brindle.id, { kind: 'late', from: '2027-01-19', weekday: 2, atTime: '21:00' })).status, 200);
  assert.deepEqual([(await s.att(rid)).Brindle, (await s.raidRow(rid)).version > version], [['no_signup', null, null, []], true], 'turning it into a Late notice removes the Away effect');
  // Deleting the notice gives back exactly the result without it: nobody expected, no sign-up.
  r = await s.put('bob', brindle.id, { kind: 'away', from: '2027-01-19', weekday: 2 });
  assert.deepEqual((await s.att(rid)).Brindle, missedWithNotice);
  assert.equal((await s.del('bob', brindle.id)).status, 200);
  assert.deepEqual((await s.att(rid)).Brindle, ['no_signup', null, null, []]);
  // ... and where the policy expects every raider, that is a plain miss.
  await s.setPolicy({ expected: { mode: 'statuses' } });
  await s.recompute(rid);
  assert.deepEqual((await s.att(rid)).Brindle, ['missed', 0, null, ['no_show']]);
  const again = await s.notice('brindle', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  assert.deepEqual((await s.att(rid)).Brindle, ['missed', 0, null, ['no_show']], 'filed after the raid began: it does not count, the result is the same');
  assert.equal(again.mine, false);
  // A raid with no results yet is not touched by a notice: no recompute, no version bump.
  const fresh = await s.raidRow(upcoming);
  await s.notice('cassia', { kind: 'away', from: '2027-01-26', to: '2027-01-26' });
  assert.deepEqual(await s.raidRow(upcoming), fresh);
});

check('away attendance: a notice filed after the raid began does not count - the boundary is created_at <= the raid\'s start', async () => {
  const s = await attAwayWorld();
  const rid = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-15', startTime: '20:00' })).id;  // started at 2027-01-16 01:00Z, before the clock
  await s.manual(rid, ['aldric']);
  const notice = await s.notice('brindle', { kind: 'away', from: '2027-01-15', to: '2027-01-15' });  // an officer files it afterwards
  assert.deepEqual((await s.att(rid)).Brindle, ['no_signup', null, null, []]);
  const startsAt = (await s.w.rows('SELECT starts_at FROM raids WHERE id = ?', rid))[0].starts_at;
  exec(s.w, `UPDATE away_notices SET created_at = ${startsAt} WHERE id = '${notice.id}'`);
  await s.recompute(rid);
  assert.deepEqual((await s.att(rid)).Brindle, ['missed_notice', 0, 'absence', []], 'filed at the very start: in time');
  exec(s.w, `UPDATE away_notices SET created_at = ${startsAt + 1} WHERE id = '${notice.id}'`);
  await s.recompute(rid);
  assert.deepEqual((await s.att(rid)).Brindle, ['no_signup', null, null, []], 'one millisecond later: too late');
  // Editing the dates of a notice does not file it again (created_at stays), so an officer can still fix a typo.
  exec(s.w, `UPDATE away_notices SET created_at = ${startsAt - 5} WHERE id = '${notice.id}'`);
  s.w.advance(1000);
  assert.equal((await s.put('bob', notice.id, { kind: 'away', from: '2027-01-14', to: '2027-01-16' })).status, 200);
  assert.deepEqual((await s.att(rid)).Brindle, ['missed_notice', 0, 'absence', []]);
  assert.equal((await s.w.rows('SELECT created_at FROM away_notices WHERE id = ?', notice.id))[0].created_at, startsAt - 5);
});

check('away attendance: only people on the raid\'s team who were still in the guild that day - inactive people and other teams\' people get no row', async () => {
  const s = await attAwayWorld();
  const add = async (key, name, team, classId = 'WARRIOR', spec = 'Arms') => {
    s.p[key] = (await addPerson(s, 'bob', team, name, { class: classId, mainSpec: spec, offSpec: null })).person.id;
    s.names[s.p[key]] = name;
  };
  await add('inactive', 'Inactiva', s.A); await add('leftlate', 'Leftlate', s.A); await add('leftearly', 'Leftearly', s.A); await add('bravo', 'Wanderfell', s.B, 'DRUID', 'Restoration');
  const retire = async (key, leftOn) => assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p[key]}`, { expectedVersion: 1, status: 'inactive', leftOn })).status, 200);
  await retire('inactive', null); await retire('leftlate', '2027-01-19'); await retire('leftearly', '2027-01-18');
  for (const key of ['inactive', 'leftlate', 'leftearly', 'bravo', 'brindle']) await s.notice(key, { kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  const rid = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' })).id;
  s.w.advance(4 * DAY);
  await s.manual(rid, ['aldric']);
  const rows = await s.att(rid);
  assert.deepEqual(rows.Brindle, ['missed_notice', 0, 'absence', []]);
  assert.deepEqual(rows.Leftlate, ['missed_notice', 0, 'absence', []], 'left on the 19th: still in the guild that day');
  for (const name of ['Inactiva', 'Leftearly', 'Wanderfell']) assert.equal(name in rows, false, `${name} has no row`);
});

check('away attendance: two teams\' raids on one date - the fill-in pass is as before, a notice only adds the weakest sign-up of its own team\'s raid', async () => {
  const s = await attAwayWorld();
  const wander = (await addPerson(s, 'bob', s.B, 'Wanderfell', { class: 'DRUID', mainSpec: 'Restoration', offSpec: null })).person.id;
  s.p.wander = wander; s.names[wander] = 'Wanderfell';
  await s.notice('brindle', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });    // Alpha, stays home
  await s.notice('dunmar', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });     // Alpha, but plays on Bravo's raid
  await s.notice('wander', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });     // Bravo, stays home
  const alpha = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' })).id;
  const bravo = (await s.makeRaid({ teamId: s.B, raidOn: '2027-01-19', startTime: '20:00' })).id;
  s.w.advance(4 * DAY);
  await s.manual(alpha, ['aldric']);
  await s.manual(bravo, ['cassia', 'dunmar']);                                          // two Alpha raiders fill in on Bravo
  const a = await s.att(alpha);
  const b = await s.att(bravo);
  assert.deepEqual([a.Aldric[0], a.Brindle, a.Wanderfell], ['present', ['missed_notice', 0, 'absence', []], undefined]);
  assert.deepEqual([a.Cassia[0], a.Cassia[1]], ['fill_in', 1], 'Cassia has no notice: her Alpha cell becomes the fill-in, as before');
  assert.deepEqual([a.Dunmar[0], a.Dunmar[1]], ['missed_notice', 0], 'a miss with notice is not replaced by a fill-in elsewhere - exactly what a real Absence sign-up does');
  assert.deepEqual([b.Wanderfell, b.Cassia[0], b.Dunmar[0], b.Brindle], [['missed_notice', 0, 'absence', []], 'fill_in', 'fill_in', undefined]);
});

check('away attendance: the same on a raid with a Warcraft Logs report - the log decides who came, the notice only excuses who did not', async () => {
  const s = await attAwayWorld();
  await s.notice('aldric', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  await s.notice('brindle', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  const rid = (await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' })).id;
  s.w.advance(4 * DAY);
  const code = 'LaneBAwayRpt0001';
  s.w.sources.reports.set(code, logReport(Date.parse('2027-01-20T01:05:00Z'), [['Aldric', 'Dunmar'], ['Aldric', 'Dunmar'], ['Aldric', 'Dunmar']]));
  const added = await s.call('bob', 'PUT', s.raid(rid, '/reports'), { source: code });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const rows = await s.att(rid);
  assert.deepEqual([rows.Aldric[0], rows.Aldric[1], rows.Dunmar[0]], ['present', 1, 'present']);
  assert.deepEqual(rows.Brindle, ['missed_notice', 0, 'absence', []]);
  assert.deepEqual(rows.Cassia, ['no_signup', null, null, []]);
  // Removing the notice of the one who stayed away recomputes the log raid too.
  const brindle = (await s.w.rows("SELECT id FROM away_notices WHERE player_id = ?", s.p.brindle))[0].id;
  assert.equal((await s.del('bob', brindle)).status, 200);
  assert.deepEqual((await s.att(rid)).Brindle, ['no_signup', null, null, []]);
});

check('away attendance: a notice change recomputes the 20 newest dates and leaves older raids marked for recalculation, which one Recalculate fixes', async () => {
  const s = await attAwayWorld();
  const notice = await s.notice('brindle', { kind: 'away', from: '2027-01-19', to: '2027-02-09' });  // 22 days
  const day = (i) => new Date(Date.parse('2027-01-19T00:00:00Z') + i * DAY).toISOString().slice(0, 10);
  let writes = 0;
  const tick = () => { if (++writes % 20 === 0) s.w.advance(61_000); };            // the central limit is 60 writes a minute
  const ids = [];
  for (let i = 0; i < 22; i++) { ids.push((await s.makeRaid({ teamId: s.A, raidOn: day(i), startTime: '20:00' })).id); tick(); }
  s.w.advance(25 * DAY);                                                            // every raid has started (the sessions last 30 days)
  for (const rid of ids) { await s.manual(rid, ['aldric']); tick(); }
  for (const rid of ids) assert.deepEqual((await s.att(rid)).Brindle, ['missed_notice', 0, 'absence', []]);
  s.w.advance(61_000);
  assert.equal((await s.del('bob', notice.id)).status, 200);
  const state = await s.w.rows('SELECT id, raid_on, policy_fp FROM raids ORDER BY raid_on');
  const stale = state.filter((row) => row.policy_fp === '').map((row) => row.raid_on);
  assert.deepEqual(stale, [day(0), day(1)], 'the two oldest dates wait for a recalculation');
  assert.deepEqual((await s.att(ids[0])).Brindle, ['missed_notice', 0, 'absence', []], 'still the old result, honestly marked stale');
  assert.deepEqual((await s.att(ids[2])).Brindle, ['no_signup', null, null, []]);
  assert.deepEqual((await s.att(ids[21])).Brindle, ['no_signup', null, null, []]);
  s.w.advance(1000);
  await s.recompute(ids[0]);
  assert.deepEqual((await s.att(ids[0])).Brindle, ['no_signup', null, null, []]);
});

// ---------------------------------------------------------------------------
// WAVE 2 / LANE C: standing sign-ups (B8) and the published roster (B9)

// Alpha (A) raids Tuesday and Thursday at 20:00, Bravo (B) on Tuesday. Eliora (Erin) is on Alpha with an alt Mirabel and on Bravo as Wanderfell; Gorrim (Gina) is
// on Alpha. The clock is Saturday 2027-01-16 12:00Z (07:00 in New York): two weeks of Alpha's slots are 01-19 (Tue), 01-21, 01-26 and 01-28.
async function standingWorld() {
  const s = await laneWorld();
  s.p = {};
  s.c = {};
  const idOf = async (name) => (await s.w.rows('SELECT id FROM characters WHERE name = ?', name))[0].id;
  const person = async (key, teamId, name, classId, spec, discord) => {
    const made = await addPerson(s, 'bob', teamId, name, { class: classId, mainSpec: spec, offSpec: null });
    s.p[key] = made.person.id;
    exec(s.w, `UPDATE players SET discord_user_id = '${discord}' WHERE id = '${made.person.id}'`);
    s.c[key] = await idOf(name);
  };
  const alt = async (key, pid, teamId, name, classId, spec) => {
    assert.equal((await addAlt(s, 'bob', pid, teamId, name, { class: classId, mainSpec: spec })).status, 201, name);
    s.c[key] = await idOf(name);
  };
  await person('eliora', s.A, 'Eliora', 'PRIEST', 'Holy', PEOPLE.erin.id);
  await alt('mirabel', s.p.eliora, s.A, 'Mirabel', 'HUNTER', 'Marksmanship');
  await alt('wanderfell', s.p.eliora, s.B, 'Wanderfell', 'DRUID', 'Restoration');
  await person('gorrim', s.A, 'Gorrim', 'PALADIN', 'Protection', PEOPLE.gina.id);
  const schedule = async (team, slots) => assert.equal((await s.call('bob', 'PUT', `/teams/${team}/schedule`, { slots, weeks: 2 })).status, 200);
  await schedule(s.A, [{ weekday: 2, startTime: '20:00' }, { weekday: 4, startTime: '20:00' }]);
  await schedule(s.B, [{ weekday: 2, startTime: '20:00' }]);
  s.fillSchedule = async (team, weeks) => {
    const r = await s.call('bob', 'POST', `/teams/${team}/schedule/raids`, weeks ? { weeks } : {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  s.stand = (who, team, slots) => s.call(who, 'PUT', `/teams/${team}/standing`, { slots });
  s.raidOn = async (date, team = s.A) => (await s.w.rows('SELECT id FROM raids WHERE team_id = ? AND raid_on = ?', team, date))[0].id;
  // Every Raidsmith sign-up with the date and team of its raid, oldest raid first.
  s.signups = async (where = '1 = 1') => s.w.rows(
    `SELECT r.raid_on AS date, r.team_id AS team, s.player_id AS person, s.kind, s.standby, s.standing, s.character_id AS character, s.class_name, s.spec_name, s.signup_id, s.updated_by, s.updated_at
       FROM raid_signups s JOIN raids r ON r.id = s.raid_id WHERE s.source = 'raidsmith' AND ${where} ORDER BY r.raid_on, r.team_id, s.player_id`,
  );
  s.reconcile = async (scope = {}) => (await load('worker/standing.js')).reconcileStanding({ db: s.w.db, now: () => s.w.clock.now, randomBytes: s.w.randomBytes }, { id: s.guildId }, scope);
  return s;
}

check('standing: GET lists the teams the viewer can sign up for that have a schedule, with their slots, characters and set; PUT checks the weekdays, kinds and characters and is the viewer\'s own', async () => {
  const s = await standingWorld();
  const mine = await s.call('erin', 'GET', '/standing');
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.deepEqual(Object.keys(mine.json).sort(), ['personId', 'teams']);
  assert.equal(mine.json.personId, s.p.eliora);
  assert.deepEqual(mine.json.teams.map((team) => [team.teamId, team.teamName]), [[s.A, 'Alpha'], [s.B, 'Bravo']]);
  const alpha = mine.json.teams[0];
  assert.deepEqual(Object.keys(alpha).sort(), ['characters', 'mine', 'slots', 'teamId', 'teamName']);
  assert.deepEqual(alpha.slots, [{ weekday: 2, startTime: '20:00', zone: null, title: null }, { weekday: 4, startTime: '20:00', zone: null, title: null }]);
  assert.deepEqual(alpha.characters.map((c) => [c.name, c.class, c.mainSpec, c.isMain]), [['Eliora', 'PRIEST', 'Holy', true], ['Mirabel', 'HUNTER', 'Marksmanship', false]], 'only the characters on that team, the Main first');
  assert.deepEqual(Object.keys(alpha.characters[0]).sort(), ['class', 'id', 'isMain', 'mainSpec', 'name', 'specs']);
  assert(alpha.characters[0].specs.includes('Holy') && alpha.characters[0].specs[0] === 'Holy');
  assert.deepEqual(alpha.mine, []);
  assert.deepEqual(mine.json.teams[1].characters.map((c) => c.name), ['Wanderfell']);
  // Gina is only on Alpha; Hank and Dave have no roster person; a team without a schedule is not listed.
  assert.deepEqual((await s.call('gina', 'GET', '/standing')).json.teams.map((team) => team.teamName), ['Alpha']);
  for (const who of ['hank', 'dave']) assert.deepEqual((await s.call(who, 'GET', '/standing')).json, { personId: null, teams: [] }, who);
  assert.equal((await s.call('bob', 'PUT', `/teams/${s.B}/schedule`, { slots: [] })).status, 200);
  assert.deepEqual((await s.call('erin', 'GET', '/standing')).json.teams.map((team) => team.teamName), ['Alpha']);
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}/standing`)).status, 401);

  // PUT: the team entry comes back with the set.
  const put = await s.stand('erin', s.A, [{ weekday: 4, kind: 'late', characterId: s.c.mirabel }, { weekday: 2, kind: 'signed' }]);
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(put.json.mine, [{ weekday: 2, kind: 'signed', characterId: null }, { weekday: 4, kind: 'late', characterId: s.c.mirabel }]);
  assert.deepEqual([put.json.teamId, put.json.teamName, put.json.slots.length, put.json.characters.length], [s.A, 'Alpha', 2, 2]);
  assert.deepEqual((await s.call('erin', 'GET', '/standing')).json.teams[0].mine, put.json.mine);

  // Validation: 400 with the field, the index and the slot field; nothing changes.
  const before = JSON.stringify((await s.w.rows('SELECT team_id, player_id, weekday, kind, character_id FROM standing_signups ORDER BY weekday')));
  const bads = [
    [{ weekday: 3, kind: 'signed' }, 'weekday'], [{ weekday: 'Tuesday', kind: 'signed' }, 'weekday'], [{ weekday: 7, kind: 'signed' }, 'weekday'], [{ kind: 'signed' }, 'weekday'],
    [{ weekday: 2, kind: 'tentative' }, 'kind'], [{ weekday: 2, kind: 'absence' }, 'kind'], [{ weekday: 2, kind: 'standby' }, 'kind'], [{ weekday: 2 }, 'kind'],
    [{ weekday: 2, kind: 'signed', characterId: s.c.gorrim }, 'characterId'],   // someone else's character
    [{ weekday: 2, kind: 'signed', characterId: s.c.wanderfell }, 'characterId'], // mine, but on the other team
    [{ weekday: 2, kind: 'signed', characterId: 'nope' }, 'characterId'],
  ];
  for (const [slot, field] of bads) {
    const r = await s.stand('erin', s.A, [slot]);
    assert.deepEqual([r.status, r.json.error, r.json.field, r.json.index, r.json.slotField], [400, 'bad_request', 'slots', 0, field], JSON.stringify(slot));
  }
  const twice = await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }, { weekday: 2, kind: 'late' }]);
  assert.deepEqual([twice.status, twice.json.index, twice.json.slotField], [400, 1, 'weekday'], 'one entry per weekday');
  const second = await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }, 'x']);
  assert.deepEqual([second.status, second.json.index], [400, 1]);
  for (const slots of [undefined, null, 'x', {}, Array.from({ length: 8 }, () => ({ weekday: 2, kind: 'signed' }))]) {
    const r = await s.call('erin', 'PUT', `/teams/${s.A}/standing`, slots === undefined ? {} : { slots });
    assert.deepEqual([r.status, r.json.field], [400, 'slots'], JSON.stringify(slots));
  }
  assert.equal(JSON.stringify((await s.w.rows('SELECT team_id, player_id, weekday, kind, character_id FROM standing_signups ORDER BY weekday'))), before, 'a refused body writes nothing');

  // Who: someone with a character on the team. Gina has none on Bravo, Hank no person, Dave leads Bravo but is no member of Alpha's roster.
  assert.equal((await s.stand('gina', s.B, [])).status, 403);
  assert.equal((await s.stand('hank', s.A, [])).status, 403);
  assert.equal((await s.stand('dave', s.A, [])).status, 403);
  assert.equal((await s.stand('erin', 't_AAAAAAAAAAAAAAAAAAAAAA', [])).status, 404);
  assert.equal((await s.w.call(newJar(), 'PUT', `${s.guildPath}/teams/${s.A}/standing`, { slots: [] })).status, 401);
  // The set is the viewer's own: an officer's PUT is their own set (they have none on Alpha), never Erin's.
  assert.equal((await s.stand('bob', s.A, [])).status, 403);
  assert.equal(await s.w.count('standing_signups'), 2);
  // An archived team is refused.
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true })).status, 200);
  assert.equal((await s.stand('erin', s.B, [])).status, 409);
  // Turning every weekday off empties the set.
  assert.deepEqual((await s.stand('erin', s.A, [])).json.mine, []);
  assert.equal(await s.w.count('standing_signups'), 0);
});

check('standing: it creates the sign-ups - on a set, on a schedule fill and on a new raid - for the team\'s upcoming raids of that weekday only', async () => {
  const s = await standingWorld();
  const { raidHelperSpecKey } = await load('worker/signups-data.js');
  await s.fillSchedule(s.A);
  await s.fillSchedule(s.B);
  assert.equal(await s.w.count('raids'), 6);
  // A set creates them on the raids that exist: Tuesdays of Alpha only (not Thursdays, not Bravo's Tuesdays).
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  let rows = await s.signups();
  assert.deepEqual(rows.map((r) => [r.date, r.team, r.person, r.kind, r.standing, r.standby]), [['2027-01-19', s.A, s.p.eliora, 'signed', 1, 0], ['2027-01-26', s.A, s.p.eliora, 'signed', 1, 0]]);
  // The columns a member's own sign-up fills: the Main and its main spec in Raid-Helper words, no Discord data, nobody as the writer.
  assert.deepEqual([rows[0].character, rows[0].class_name, rows[0].spec_name, rows[0].signup_id, rows[0].updated_by], [s.c.eliora, 'Priest', raidHelperSpecKey('PRIEST', 'Holy'), 1, null]);
  assert.deepEqual((await s.w.rows("SELECT discord_user_id, nickname, note, position FROM raid_signups WHERE source = 'raidsmith' ORDER BY raid_id LIMIT 1"))[0].position, 1);
  // Another weekday with another kind and character.
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }, { weekday: 4, kind: 'late', characterId: s.c.mirabel }])).status, 200);
  rows = await s.signups();
  assert.deepEqual(rows.map((r) => [r.date, r.kind, r.class_name]), [['2027-01-19', 'signed', 'Priest'], ['2027-01-21', 'late', 'Hunter'], ['2027-01-26', 'signed', 'Priest'], ['2027-01-28', 'late', 'Hunter']]);
  // Gina in too, on the same raids: the sign-up ids go on counting.
  assert.equal((await s.stand('gina', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  const tuesday = await s.signups(`r.raid_on = '2027-01-19'`);
  assert.deepEqual(tuesday.map((r) => [r.person === s.p.gorrim ? 'gorrim' : 'eliora', r.signup_id]).sort(), [['eliora', 1], ['gorrim', 2]]);

  // The viewer sees it: the Raids list says "standing", the panel marks the entry, the counts include it.
  const tue = await s.raidOn('2027-01-19');
  const list = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.upcoming;
  assert.deepEqual(list.find((row) => row.id === tue).mine, { kind: 'signed', source: 'raidsmith', characterName: 'Eliora', standing: true });
  const view = (await s.call('erin', 'GET', `/raids/${tue}/signups`)).json;
  assert.deepEqual([view.entries.find((e) => e.isMe).standing, view.counts.signed, view.me.signup.standing], [true, 2, true]);
  assert.equal(list.find((row) => row.id === tue).signups.signed, 2);

  // A schedule fill creates the sign-ups of the new raids (4 weeks: two more weeks of Tuesdays and Thursdays).
  const filled = await s.fillSchedule(s.A, 4);
  assert.equal(filled.created.length, 4, JSON.stringify(filled));
  rows = await s.signups(`s.player_id = '${s.p.eliora}'`);
  assert.deepEqual(rows.map((r) => r.date), ['2027-01-19', '2027-01-21', '2027-01-26', '2027-01-28', '2027-02-02', '2027-02-04', '2027-02-09', '2027-02-11']);
  assert(rows.every((r) => r.standing === 1));

  // A hand-made upcoming raid on a Tuesday gets them; on a Wednesday, or in the past, it does not.
  const tuesdayRaid = await s.makeRaid({ teamId: s.A, raidOn: '2027-03-02', startTime: '20:00' });
  const wednesday = await s.makeRaid({ teamId: s.A, raidOn: '2027-03-03', startTime: '20:00' });
  const past = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-12', startTime: '20:00' }); // a Tuesday that has passed
  const dateOnly = await s.makeRaid({ teamId: s.A, raidOn: '2027-03-09' });                  // a Tuesday with only its date
  const onRaid = async (raid) => (await s.w.rows("SELECT player_id FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' ORDER BY player_id", raid.id)).map((r) => r.player_id).sort();
  assert.deepEqual(await onRaid(tuesdayRaid), [s.p.eliora, s.p.gorrim].sort());
  assert.deepEqual(await onRaid(wednesday), []);
  assert.deepEqual(await onRaid(past), []);
  assert.deepEqual(await onRaid(dateOnly), [s.p.eliora, s.p.gorrim].sort(), 'a raid whose time is not set yet is still upcoming');
  // Bravo's Tuesdays were never touched, and a started raid is never touched by a set.
  assert.equal(await s.w.count('raid_signups', "raid_id IN (SELECT id FROM raids WHERE team_id = ?)", s.B), 0);
  s.w.clock.now = Date.parse('2027-01-27T12:00:00Z');
  const started = await s.w.count('raid_signups', "source = 'raidsmith'");
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'late' }])).status, 200);
  const after = await s.signups(`s.player_id = '${s.p.eliora}'`);
  assert.deepEqual(after.filter((r) => r.date <= '2027-01-27').map((r) => [r.date, r.kind]), [['2027-01-19', 'signed'], ['2027-01-21', 'late'], ['2027-01-26', 'signed']], 'raids that started keep what they had (no update, no delete)');
  assert.deepEqual(after.filter((r) => r.date > '2027-01-27' && r.date.endsWith('-02-02')).map((r) => r.kind), ['late'], 'the upcoming ones follow the new kind');
  assert(started > 0);
});

check('standing: reconciling again changes nothing; it never replaces a sign-up of either source, and a Raid-Helper row wins', async () => {
  const s = await standingWorld();
  await s.fillSchedule(s.A);
  // Gorrim has signed up herself on the first Tuesday (an Absence); Eliora has a Raid-Helper row on the second.
  const first = await s.raidOn('2027-01-19');
  const second = await s.raidOn('2027-01-26');
  assert.equal((await s.call('gina', 'PUT', `/raids/${first}/signup`, { kind: 'absence' })).status, 200);
  exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, class_name, spec_name, position, guild_id, player_id, discord_user_id, nickname)
             VALUES ('${second}', 'raid_helper', 1, 'tentative', 'Tentative', NULL, 1, '${s.guildId}', '${s.p.eliora}', '${PEOPLE.erin.id}', 'Eliora')`);
  assert.equal((await s.stand('gina', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  const rows = await s.signups();
  assert.deepEqual(rows.map((r) => [r.date, r.person === s.p.gorrim ? 'gorrim' : 'eliora', r.kind, r.standing]), [
    ['2027-01-19', 'eliora', 'signed', 1], ['2027-01-19', 'gorrim', 'absence', 0], ['2027-01-26', 'gorrim', 'signed', 1],
  ], 'Gorrim\'s own Absence stays, Eliora\'s Raid-Helper row keeps her out of the second raid');
  // Idempotent: run it again, and again from every angle - the rows are the very same rows.
  const snapshot = JSON.stringify(await s.w.rows('SELECT * FROM raid_signups ORDER BY raid_id, source, signup_id'));
  for (const scope of [{}, { personId: s.p.eliora }, { teamIds: [s.A] }, { raidIds: [first, second] }]) {
    assert.deepEqual(await s.reconcile(scope), { created: 0, updated: 0, deleted: 0 }, JSON.stringify(scope));
  }
  assert.equal(JSON.stringify(await s.w.rows('SELECT * FROM raid_signups ORDER BY raid_id, source, signup_id')), snapshot);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  assert.equal(JSON.stringify(await s.w.rows('SELECT * FROM raid_signups ORDER BY raid_id, source, signup_id')), snapshot, 'saving the same set again changes no row');
  // Deleting the rows and reconciling puts back exactly them, once.
  exec(s.w, "DELETE FROM raid_signups WHERE source = 'raidsmith' AND standing = 1");
  assert.deepEqual(await s.reconcile({}), { created: 2, updated: 0, deleted: 0 });
  assert.deepEqual(await s.reconcile({}), { created: 0, updated: 0, deleted: 0 });
  // Two reconciles racing for the same raid cannot make a second row (the partial unique index and the conditional insert).
  exec(s.w, "DELETE FROM raid_signups WHERE source = 'raidsmith' AND standing = 1");
  await Promise.all([s.reconcile({}), s.reconcile({})]);
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith' AND standing = 1"), 2);
});

check('standing: an Away notice wins both ways - a notice added later takes the row away, a notice removed later brings it back, one filed first stops it', async () => {
  const s = await standingWorld();
  await s.fillSchedule(s.A);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }, { weekday: 4, kind: 'signed' }])).status, 200);
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19', '2027-01-21', '2027-01-26', '2027-01-28']);
  // A notice for one date takes that Tuesday's row away and nothing else.
  const made = await s.call('erin', 'POST', '/away', { kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-21', '2027-01-26', '2027-01-28']);
  // Removing it brings the row back.
  assert.equal((await s.call('erin', 'DELETE', `/away/${made.json.notice.id}`, {})).status, 200);
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19', '2027-01-21', '2027-01-26', '2027-01-28']);
  // A repeating notice on Thursdays keeps every Thursday clear; a change of the notice moves the gap.
  const thursdays = await s.call('erin', 'POST', '/away', { kind: 'away', from: '2027-01-20', weekday: 4 });
  assert.equal(thursdays.status, 201, JSON.stringify(thursdays.json));
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19', '2027-01-26']);
  const moved = await s.call('erin', 'PUT', `/away/${thursdays.json.notice.id}`, { kind: 'away', from: '2027-01-27', weekday: 4 });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19', '2027-01-21', '2027-01-26'], 'the first Thursday is free again, the second is not');
  // Late and Leaving notices do not stop a sign-up.
  assert.equal((await s.call('erin', 'POST', '/away', { kind: 'late', from: '2027-01-19', to: '2027-01-26', atTime: '21:00' })).status, 201);
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19', '2027-01-21', '2027-01-26']);
  // A notice filed BEFORE the standing entry exists stops the row from being made.
  assert.equal((await s.stand('erin', s.A, [])).status, 200);
  assert.deepEqual(await s.signups(), []);
  assert.equal((await s.call('erin', 'POST', '/away', { kind: 'away', from: '2027-01-26', to: '2027-01-26' })).status, 201);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  assert.deepEqual((await s.signups()).map((r) => r.date), ['2027-01-19']);
  // An officer's notice for the person counts the same.
  const officer = await s.call('bob', 'POST', '/away', { personId: s.p.eliora, kind: 'away', from: '2027-01-19', to: '2027-01-19' });
  assert.equal(officer.status, 201, JSON.stringify(officer.json));
  assert.deepEqual(await s.signups(), []);
  // A sign-up the member edited is theirs: an Away notice replaces nothing of it.
  assert.equal((await s.call('bob', 'DELETE', `/away/${officer.json.notice.id}`, {})).status, 200);
  const tue = await s.raidOn('2027-01-19');
  assert.equal((await s.call('erin', 'PUT', `/raids/${tue}/signup`, { kind: 'late' })).status, 200);
  assert.equal((await s.call('erin', 'POST', '/away', { kind: 'away', from: '2027-01-19', to: '2027-01-19' })).status, 201);
  assert.deepEqual((await s.signups()).map((r) => [r.date, r.kind, r.standing]), [['2027-01-19', 'late', 0]]);
});

check('standing: editing a row freezes it; turning a weekday off removes only the unedited future rows; other teams, other people and past raids stay', async () => {
  const s = await standingWorld();
  await s.fillSchedule(s.A);
  await s.fillSchedule(s.B);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }, { weekday: 4, kind: 'signed' }])).status, 200);
  assert.equal((await s.stand('erin', s.B, [{ weekday: 2, kind: 'late' }])).status, 200);
  assert.equal((await s.stand('gina', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith' AND standing = 1"), 4 + 2 + 2);
  // A Thursday row in the past (a raid that started) with the flag: the system never touches a started raid.
  const pastRaid = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-14', startTime: '20:00' });
  exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, class_name, position, guild_id, player_id, standing, created_at, updated_at)
             VALUES ('${pastRaid.id}', 'raidsmith', 1, 'signed', 'Priest', 1, '${s.guildId}', '${s.p.eliora}', 1, 1, 1)`);
  // Erin edits the second Tuesday: it is hers now (the flag is gone in the table and in the views).
  const tue2 = await s.raidOn('2027-01-26');
  assert.equal((await s.call('erin', 'PUT', `/raids/${tue2}/signup`, { kind: 'tentative', note: 'maybe' })).status, 200);
  const edited = (await s.signups(`s.raid_id = '${tue2}' AND s.player_id = '${s.p.eliora}'`))[0];
  assert.deepEqual([edited.kind, edited.standing], ['tentative', 0]);
  const view = (await s.call('erin', 'GET', `/raids/${tue2}/signups`)).json;
  assert.equal('standing' in view.entries.find((e) => e.isMe), false, 'the key is only there for a standing sign-up');
  const listed = (await s.call('erin', 'GET', `/raids?team=${s.A}`)).json.upcoming.find((row) => row.id === tue2);
  assert.deepEqual(listed.mine, { kind: 'tentative', source: 'raidsmith', characterName: 'Eliora' });
  // An officer's edit freezes it the same way.
  const thu = await s.raidOn('2027-01-21');
  assert.equal((await s.call('bob', 'PUT', `/raids/${thu}/signups/${s.p.eliora}`, { kind: 'late' })).status, 200);
  assert.equal((await s.signups(`s.raid_id = '${thu}' AND s.player_id = '${s.p.eliora}'`))[0].standing, 0);

  // Turning Tuesday off (keeping Thursday) removes the unedited Tuesday of Alpha only.
  assert.equal((await s.stand('erin', s.A, [{ weekday: 4, kind: 'signed' }])).status, 200);
  const eliora = (rows) => rows.filter((r) => r.person === s.p.eliora).map((r) => [r.date, r.team === s.A ? 'A' : 'B', r.kind, r.standing]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
  assert.deepEqual(eliora(await s.signups()), [
    ['2027-01-14', 'A', 'signed', 1],   // the started raid
    ['2027-01-19', 'B', 'late', 1],     // Bravo's Tuesday: another team
    ['2027-01-21', 'A', 'late', 0],     // the officer's edit
    ['2027-01-26', 'A', 'tentative', 0], // her edit
    ['2027-01-26', 'B', 'late', 1],
    ['2027-01-28', 'A', 'signed', 1],
  ]);
  assert.equal((await s.signups()).filter((r) => r.person === s.p.gorrim).length, 2, 'another person\'s rows stay');
  // Turning everything off leaves only the edited rows (and the started raid).
  assert.equal((await s.stand('erin', s.A, [])).status, 200);
  assert.deepEqual(eliora(await s.signups(`r.team_id = '${s.A}'`)).map((r) => r.slice(0, 1).concat(r.slice(2))), [['2027-01-14', 'signed', 1], ['2027-01-21', 'late', 0], ['2027-01-26', 'tentative', 0]]);
  assert.equal(await s.w.count('standing_signups', "player_id = ?", s.p.eliora), 1, 'Bravo\'s entry is still there');
});

check('standing: a character change - the unedited rows follow the entry (kind, character, class, spec); an inactive person or a lost character is signed out', async () => {
  const s = await standingWorld();
  await s.fillSchedule(s.A);
  const { raidHelperSpecKey } = await load('worker/signups-data.js');
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  const before = await s.signups();
  assert.equal(before.length, 2);
  // Edit the second one, then change the entry to Mirabel / late.
  const tue2 = await s.raidOn('2027-01-26');
  assert.equal((await s.call('erin', 'PUT', `/raids/${tue2}/signup`, { kind: 'signed', note: 'mine' })).status, 200);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'late', characterId: s.c.mirabel }])).status, 200);
  const rows = await s.signups();
  assert.deepEqual([rows[0].kind, rows[0].character, rows[0].class_name, rows[0].spec_name, rows[0].standing, rows[0].signup_id], ['late', s.c.mirabel, 'Hunter', raidHelperSpecKey('HUNTER', 'Marksmanship'), 1, before[0].signup_id], 'the same row, changed');
  assert.deepEqual([rows[1].kind, rows[1].character, rows[1].standing], ['signed', s.c.eliora, 0], 'the edited one is left alone');
  assert.equal(await s.w.count('standing_signups'), 1);
  // Back to the usual character.
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed', characterId: null }])).status, 200);
  assert.deepEqual([(await s.signups())[0].character, (await s.signups())[0].kind], [s.c.eliora, 'signed']);
  // The usual character follows the roster: the Main changes, the NULL entry follows it at the next reconcile.
  exec(s.w, `UPDATE characters SET is_main = 0 WHERE id = '${s.c.eliora}'`);
  exec(s.w, `UPDATE characters SET is_main = 1 WHERE id = '${s.c.mirabel}'`);
  assert.deepEqual(await s.reconcile({ personId: s.p.eliora }), { created: 0, updated: 1, deleted: 0 });
  assert.equal((await s.signups())[0].character, s.c.mirabel);
  // An inactive person is signed out of the rows the system made; a person with no character left on the team too.
  exec(s.w, `UPDATE players SET status = 'inactive' WHERE id = '${s.p.eliora}'`);
  assert.deepEqual(await s.reconcile({ personId: s.p.eliora }), { created: 0, updated: 0, deleted: 1 });
  assert.deepEqual((await s.signups()).map((r) => r.standing), [0], 'only the edited row is left');
  exec(s.w, `UPDATE players SET status = 'raider' WHERE id = '${s.p.eliora}'`);
  assert.deepEqual(await s.reconcile({ personId: s.p.eliora }), { created: 1, updated: 0, deleted: 0 });
  exec(s.w, `UPDATE characters SET team_id = '${s.B}' WHERE id IN ('${s.c.eliora}', '${s.c.mirabel}')`);
  assert.deepEqual(await s.reconcile({ personId: s.p.eliora }), { created: 0, updated: 0, deleted: 1 });
});

check('standing: a Raid-Helper sign-up wins - linking an event removes the standing row of the people in it, taking the event off brings it back', async () => {
  const s = await standingWorld();
  await s.fillSchedule(s.A);
  assert.equal((await s.stand('erin', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  assert.equal((await s.stand('gina', s.A, [{ weekday: 2, kind: 'signed' }])).status, 200);
  const tue = await s.raidOn('2027-01-19');
  const startsAt = (await s.w.rows('SELECT starts_at FROM raids WHERE id = ?', tue))[0].starts_at;
  assert.equal((await s.signups(`s.raid_id = '${tue}'`)).length, 2);
  const EVENT = '666666666666666661';
  s.w.sources.events.set(EVENT, rhEvent(EVENT, SERVER_A, [signUp(1, PEOPLE.erin.id, 'Eliora', 'Priest', 'Holy1'), signUp(2, '299999999999999999', 'Stranger', 'Rogue', 'Combat')], { startTime: startsAt / 1000 }));
  const link = await s.call('bob', 'PUT', `/raids/${tue}/event`, { source: EVENT });
  assert.equal(link.status, 200, JSON.stringify(link.json));
  const left = await s.signups(`s.raid_id = '${tue}'`);
  assert.deepEqual(left.map((r) => r.person), [s.p.gorrim], 'Eliora is in the event now: her standing row went, Gorrim\'s stays');
  assert.equal(await s.w.count('raid_signups', `raid_id = '${tue}' AND source = 'raid_helper' AND player_id = '${s.p.eliora}'`), 1);
  // The same event, refreshed, changes nothing.
  assert.equal((await s.call('bob', 'PUT', `/raids/${tue}/event`, { source: EVENT })).status, 200);
  assert.equal((await s.signups(`s.raid_id = '${tue}'`)).length, 1);
  // Taking the event off puts the standing row back.
  assert.equal((await s.call('bob', 'DELETE', `/raids/${tue}/event`, {})).status, 200);
  assert.deepEqual((await s.signups(`s.raid_id = '${tue}'`)).map((r) => [r.person === s.p.eliora ? 'eliora' : 'gorrim', r.standing]).sort(), [['eliora', 1], ['gorrim', 1]]);
  // A new raid made from an event: the people in it keep their Raid-Helper row, the others get the standing one.
  const EVENT2 = '666666666666666662';
  const second = Date.parse('2027-03-03T01:00:00Z'); // Tuesday 2027-03-02 20:00 in New York
  s.w.sources.events.set(EVENT2, rhEvent(EVENT2, SERVER_A, [signUp(1, PEOPLE.gina.id, 'Gorrim', 'Paladin', 'Protection1')], { startTime: second / 1000 }));
  const made = await s.call('bob', 'POST', '/raids', { teamId: s.A, eventSource: EVENT2 });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const rows = await s.signups(`s.raid_id = '${made.json.raid.id}'`);
  assert.deepEqual(rows.map((r) => r.person), [s.p.eliora], 'Gorrim is in the event; Eliora gets her standing sign-up');
});

// ---- the published roster

// The standing world plus Kestrel (Alpha, no Discord) and a raid on Tuesday 2027-01-19 20:00 (New York) of Alpha.
async function rosterWorld() {
  const s = await standingWorld();
  const kestrel = await addPerson(s, 'bob', s.A, 'Kestrel', { class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  s.p.kestrel = kestrel.person.id;
  const raid = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-19', startTime: '20:00' });
  s.rid = raid.id;
  s.startsAt = raid.startsAt;
  s.path = (route = '') => `/raids/${s.rid}${route}`;
  s.plan = async (players, rid = s.rid) => {
    const r = await s.call('bob', 'PUT', `/raids/${rid}/plan`, { label: 'Night plan', players });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r;
  };
  // Eliora in group 1, Gorrim in group 2, Kestrel on the bench, and a name no roster character carries.
  s.basicPlan = () => s.plan([{ name: 'Eliora', group: 1 }, { name: 'Gorrim', group: 2 }, { name: 'Kestrel', group: 0 }, { name: 'Stranger', group: 3 }]);
  s.publish = (who = 'bob', rid = s.rid) => s.call(who, 'POST', `/raids/${rid}/roster`, {});
  s.roster = (who = 'bob', rid = s.rid) => s.call(who, 'GET', `/raids/${rid}/roster`);
  s.answer = (who, what, rid = s.rid) => s.call(who, 'POST', `/raids/${rid}/roster/${what}`, {});
  s.seat = async (name) => (await s.w.rows('SELECT * FROM raid_roster WHERE raid_id = ? AND name = ?', s.rid, name))[0];
  s.signupOf = async (person) => (await s.w.rows("SELECT source, kind, standby, standing FROM raid_signups WHERE raid_id = ? AND player_id = ? ORDER BY source", s.rid, person));
  return s;
}

check('roster: the pure rules - a plan name is matched to a person by character name (the raid\'s team first), class and spec come from the sign-up or the character', async () => {
  const { buildSeats, keptSeats, planChanged, rosterCounts } = await load('worker/roster-publish.js');
  const character = (extra) => ({ id: 'c_1', player_id: 'p_1', name_key: 'aldric', class: 'WARRIOR', main_spec: 'Arms', is_main: 1, team_id: 't_a', ...extra });
  const plan = (...entries) => entries.map(([name, group]) => ({ name, name_key: name.toLowerCase(), group_number: group }));
  // The spec the person signed up with wins when it is a spec of the class; a Raid-Helper spec key is read; a Raidsmith row replaces a Raid-Helper one.
  const base = { plan: plan(['Aldric', 1]), characters: [character({})], teamId: 't_a' };
  assert.deepEqual(buildSeats({ ...base, signups: [] }), [{ name: 'Aldric', nameKey: 'aldric', personId: 'p_1', className: 'WARRIOR', spec: 'Arms', group: 1, seq: 0 }]);
  assert.equal(buildSeats({ ...base, signups: [{ player_id: 'p_1', source: 'raid_helper', spec_name: 'Fury' }] })[0].spec, 'Fury');
  assert.equal(buildSeats({ ...base, signups: [{ player_id: 'p_1', source: 'raid_helper', spec_name: 'Fury' }, { player_id: 'p_1', source: 'raidsmith', spec_name: 'Protection' }] })[0].spec, 'Protection');
  assert.equal(buildSeats({ ...base, signups: [{ player_id: 'p_1', source: 'raidsmith', spec_name: 'Holy1' }] })[0].spec, 'Arms', 'a spec of another class (a sign-up on an alt) is not used');
  assert.equal(buildSeats({ ...base, signups: [{ player_id: 'p_2', source: 'raidsmith', spec_name: 'Fury' }] })[0].spec, 'Arms', 'someone else\'s sign-up is not used');
  assert.equal(buildSeats({ ...base, characters: [character({ main_spec: null })], signups: [] })[0].spec, null, 'no sign-up and no main spec: no spec');
  // Several characters with the name: the raid's team first, then a Main, then the lowest id.
  const same = [
    character({ id: 'c_9', player_id: 'p_far', team_id: 't_b', is_main: 1 }),
    character({ id: 'c_5', player_id: 'p_alt', team_id: 't_a', is_main: 0 }),
    character({ id: 'c_3', player_id: 'p_main', team_id: 't_a', is_main: 1 }),
  ];
  assert.equal(buildSeats({ ...base, characters: same, signups: [] })[0].personId, 'p_main');
  assert.equal(buildSeats({ ...base, characters: same.slice(0, 2), signups: [] })[0].personId, 'p_alt', 'a character on the team beats a Main elsewhere');
  assert.equal(buildSeats({ ...base, characters: same.slice(0, 1), signups: [] })[0].personId, 'p_far', 'a character elsewhere is still a match');
  // A name with no character is a seat without a person; the plan order is kept.
  const seats = buildSeats({ plan: plan(['Zed', 2], ['Aldric', 0], ['Mia', 1]), characters: [character({})], signups: [], teamId: 't_a' });
  assert.deepEqual(seats.map((seat) => [seat.name, seat.personId, seat.className, seat.spec, seat.group, seat.seq]), [['Zed', null, null, null, 2, 0], ['Aldric', 'p_1', 'WARRIOR', 'Arms', 0, 1], ['Mia', null, null, null, 1, 2]]);
  // Kept seats, plan changes, counts.
  assert.equal(keptSeats(seats, [{ name_key: 'zed', group_number: 2 }, { name_key: 'aldric', group_number: 1 }, { name_key: 'gone', group_number: 0 }]), 1);
  assert.equal(keptSeats(seats, []), 0);
  const roster = [{ name_key: 'zed', group_number: 2 }, { name_key: 'aldric', group_number: 0 }];
  assert.equal(planChanged(roster, plan(['Zed', 2], ['Aldric', 0])), false);
  assert.equal(planChanged(roster, plan(['Aldric', 0], ['Zed', 2])), false, 'the order does not matter');
  assert.equal(planChanged(roster, plan(['Zed', 2], ['Aldric', 1])), true, 'moved');
  assert.equal(planChanged(roster, plan(['Zed', 2])), true, 'removed');
  assert.equal(planChanged(roster, plan(['Zed', 2], ['Aldric', 0], ['Mia', 1])), true, 'added');
  assert.deepEqual(rosterCounts([{ status: 'pending' }, { status: 'confirmed' }, { status: 'declined' }, { status: 'declined' }]), { pending: 1, confirmed: 1, declined: 2, total: 4 });
});

check('roster: publishing needs raids.edit, a plan and a raid that has not started; it snapshots the plan with the people it matches', async () => {
  const s = await rosterWorld();
  // No plan yet.
  const none = await s.publish();
  assert.deepEqual([none.status, none.json.error], [409, 'no_plan']);
  await s.basicPlan();
  // Who: an officer or the Team Lead of the raid's team.
  for (const [who, status] of [['erin', 403], ['hank', 403], ['dave', 403]]) assert.deepEqual([who, (await s.publish(who)).status], [who, status]);
  assert.equal((await s.w.call(newJar(), 'POST', `${s.guildPath}/raids/${s.rid}/roster`, {})).status, 401);
  assert.equal(await s.w.count('raid_roster'), 0);
  // Erin signed up as Discipline: the roster says so. Gorrim has no sign-up: her main spec.
  assert.equal((await s.call('erin', 'PUT', s.path('/signup'), { kind: 'signed', spec: 'Discipline' })).status, 200);
  s.w.advance(5000);
  const published = await s.publish('bob');
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const view = published.json;
  assert.deepEqual(Object.keys(view).sort(), ['counts', 'entries', 'planChanged', 'published', 'publishedAt', 'publishedBy']);
  assert.deepEqual([view.published, view.publishedAt, view.publishedBy, view.planChanged], [true, s.w.clock.now, 'bob', false]);
  assert.deepEqual(view.entries.map((e) => [e.name, e.personId, e.class, e.spec, e.group, e.status, e.respondedAt]), [
    ['Eliora', s.p.eliora, 'PRIEST', 'Discipline', 1, 'pending', null],
    ['Gorrim', s.p.gorrim, 'PALADIN', 'Protection', 2, 'pending', null],
    ['Kestrel', s.p.kestrel, 'ROGUE', 'Combat', 0, 'pending', null],
    ['Stranger', null, null, null, 3, 'pending', null],
  ]);
  assert.deepEqual(view.counts, { pending: 4, confirmed: 0, declined: 0, total: 4 });
  assert.deepEqual(Object.keys(view.entries[0]).sort(), ['class', 'group', 'name', 'personId', 'respondedAt', 'spec', 'status']);
  const raid = (await s.w.rows('SELECT roster_published_at, roster_published_by FROM raids WHERE id = ?', s.rid))[0];
  assert.deepEqual([raid.roster_published_at, raid.roster_published_by], [s.w.clock.now, s.ids.bob]);
  assert.deepEqual(await s.audits('roster.publish'), [{ entity: s.rid, before: null, after: { players: 4, kept: 0 } }]);
  // The officer read is the same; the plan is not touched by publishing.
  assert.deepEqual((await s.roster('carol')).json, view, 'the Team Lead of the team reads the same');
  assert.equal(await s.w.count('raid_plan', 'raid_id = ?', s.rid), 4);
  // A raid that has started cannot be published (the plan is still there to read).
  const past = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-12', startTime: '20:00' });
  await s.plan([{ name: 'Eliora', group: 1 }], past.id);
  const late = await s.publish('bob', past.id);
  assert.deepEqual([late.status, late.json.error], [409, 'raid_started']);
  assert.equal(await s.w.count('raid_roster', 'raid_id = ?', past.id), 0);
  // Not a raid of this guild.
  assert.equal((await s.publish('bob', 'r_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

check('roster: publishing again keeps the answers of the seats that did not change, resets the moved ones, drops the removed ones and says when the plan moved on', async () => {
  const s = await rosterWorld();
  await s.basicPlan();
  assert.equal((await s.publish()).status, 200);
  assert.equal((await s.answer('erin', 'confirm')).status, 200);   // Eliora
  assert.equal((await s.answer('gina', 'decline')).status, 200);   // Gorrim
  assert.deepEqual((await s.roster()).json.counts, { pending: 2, confirmed: 1, declined: 1, total: 4 });
  // The plan changes: Gorrim moves to group 4, Kestrel goes, Mirabel comes; Eliora stays. Until published again the roster is the old one.
  await s.plan([{ name: 'Eliora', group: 1 }, { name: 'Gorrim', group: 4 }, { name: 'Stranger', group: 3 }, { name: 'Mirabel', group: 2 }]);
  const stale = (await s.roster()).json;
  assert.equal(stale.planChanged, true);
  assert.deepEqual(stale.entries.map((e) => [e.name, e.group]), [['Eliora', 1], ['Gorrim', 2], ['Kestrel', 0], ['Stranger', 3]]);
  assert.deepEqual((await s.roster('erin')).json.mine.group, 1, 'members see the published seat, not the plan');
  const again = await s.publish();
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.planChanged, false);
  assert.deepEqual(again.json.entries.map((e) => [e.name, e.group, e.status]), [
    ['Eliora', 1, 'confirmed'],   // unchanged: the answer stays
    ['Gorrim', 4, 'pending'],     // moved: asks again
    ['Stranger', 3, 'pending'],
    ['Mirabel', 2, 'pending'],    // new
  ]);
  assert.equal(again.json.entries[0].respondedAt !== null, true, 'the answer time stays with the answer');
  assert.equal(again.json.entries[1].respondedAt, null);
  assert.deepEqual(again.json.counts, { pending: 3, confirmed: 1, declined: 0, total: 4 });
  assert.equal((await s.seat('Kestrel')), undefined, 'a name no longer planned is gone');
  assert.deepEqual((await s.audits('roster.publish')).map((a) => a.after), [{ players: 4, kept: 0 }, { players: 4, kept: 2 }], 'Eliora and Stranger kept their seats');
  // Gorrim had said she cannot come and her sign-up is an Absence: the moved seat asks again, and confirming it gives the sign-up back.
  assert.equal((await s.signupOf(s.p.gorrim)).find((r) => r.source === 'raidsmith').kind, 'absence');
  assert.equal((await s.answer('gina', 'confirm')).status, 200);
  assert.equal((await s.signupOf(s.p.gorrim)).find((r) => r.source === 'raidsmith').kind, 'signed');
  // The plan is exactly as before: publishing a third time keeps all four.
  assert.equal((await s.publish()).status, 200);
  assert.deepEqual((await s.audits('roster.publish')).map((a) => a.after.kept), [0, 2, 4]);
  assert.deepEqual((await s.roster()).json.counts, { pending: 2, confirmed: 2, declined: 0, total: 4 });
});

check('roster: a member sees only their own seat - group, name, class, spec, status - or the bench, or nothing', async () => {
  const s = await rosterWorld();
  const before = await s.roster('erin');
  assert.deepEqual([before.status, before.json], [200, { published: false, publishedAt: null, mine: null }]);
  await s.basicPlan();
  await s.publish();
  const eliora = (await s.roster('erin')).json;
  assert.deepEqual(Object.keys(eliora).sort(), ['mine', 'published', 'publishedAt'], 'no entries, no counts, nothing about anybody else');
  assert.deepEqual(eliora.mine, { group: 1, name: 'Eliora', class: 'PRIEST', spec: 'Holy', status: 'pending' });
  assert.equal(eliora.published, true);
  assert.deepEqual((await s.roster('gina')).json.mine, { group: 2, name: 'Gorrim', class: 'PALADIN', spec: 'Protection', status: 'pending' });
  // Someone with no person, a person who is not on the roster, and a member of another team's raid see no seat.
  assert.equal((await s.roster('hank')).json.mine, null);
  assert.equal((await s.roster('dave')).json.mine, null);
  // The bench is group 0: a member on it reads that.
  await s.plan([{ name: 'Eliora', group: 0 }, { name: 'Gorrim', group: 1 }]);
  await s.publish();
  assert.deepEqual((await s.roster('erin')).json.mine.group, 0);
  assert.equal((await s.roster('gina')).json.mine.group, 1);
  assert.equal(await s.w.count('raid_roster', 'raid_id = ?', s.rid), 2);
  // Signed out and another guild's raid.
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}/raids/${s.rid}/roster`)).status, 401);
  assert.equal((await s.roster('erin', 'r_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

check('roster: "can\'t make it" turns the sign-up into an Absence (Raid-Helper row replaced, what it was remembered), confirming gives it back; the lock and the deadline do not apply', async () => {
  const s = await rosterWorld();
  await s.basicPlan();
  // Eliora has a Raid-Helper sign-up only; Gorrim a Raidsmith Late; Kestrel (no Discord) none.
  exec(s.w, `INSERT INTO raid_signups (raid_id, source, signup_id, kind, class_name, spec_name, position, guild_id, player_id, discord_user_id, nickname)
             VALUES ('${s.rid}', 'raid_helper', 1, 'signed', 'Priest', 'Holy1', 1, '${s.guildId}', '${s.p.eliora}', '${PEOPLE.erin.id}', 'Eliora')`);
  assert.equal((await s.call('gina', 'PUT', s.path('/signup'), { kind: 'late', note: 'traffic' })).status, 200);
  assert.equal((await s.publish()).status, 200);
  const raidKind = async (person) => ((await s.signupOf(person)).filter((r) => r.source === 'raidsmith')[0] || {}).kind || null;

  // Decline: Erin's Raid-Helper row is replaced by an Absence; her seat says declined.
  s.w.advance(3000);
  const declined = await s.answer('erin', 'decline');
  assert.equal(declined.status, 200, JSON.stringify(declined.json));
  assert.deepEqual(declined.json.mine, { group: 1, name: 'Eliora', class: 'PRIEST', spec: 'Holy', status: 'declined' });
  assert.deepEqual([await raidKind(s.p.eliora), (await s.signupOf(s.p.eliora)).find((r) => r.source === 'raidsmith').standing], ['absence', 0]);
  assert.equal(await s.w.count('raid_signups', `raid_id = '${s.rid}' AND source = 'raid_helper'`), 1, 'the Raid-Helper row stays in the table; the Raidsmith one replaces it in every view');
  const seat = await s.seat('Eliora');
  assert.deepEqual([seat.status, seat.prev_kind, seat.responded_at], ['declined', 'signed', s.w.clock.now]);
  const panel = (await s.call('bob', 'GET', s.path('/signups'))).json;
  assert.deepEqual(panel.entries.filter((e) => e.personId === s.p.eliora).map((e) => [e.source, e.kind]), [['raidsmith', 'absence']]);
  const officer = (await s.roster()).json;
  assert.deepEqual([officer.entries[0].status, officer.entries[0].respondedAt, officer.counts.declined], ['declined', s.w.clock.now, 1]);
  assert.deepEqual(await s.audits('roster.decline'), [{ entity: s.rid, before: null, after: { personId: s.p.eliora } }]);
  // Saying it twice keeps what was remembered.
  assert.equal((await s.answer('erin', 'decline')).status, 200);
  assert.equal((await s.seat('Eliora')).prev_kind, 'signed');
  // Confirm: the sign-up is back as it was (a Raidsmith 'signed' now), the answer is confirmed, nothing remembered any more. Not audited.
  s.w.advance(3000);
  const confirmed = await s.answer('erin', 'confirm');
  assert.deepEqual([confirmed.status, confirmed.json.mine.status], [200, 'confirmed']);
  assert.equal(await raidKind(s.p.eliora), 'signed');
  const back = await s.seat('Eliora');
  assert.deepEqual([back.status, back.prev_kind, back.responded_at], ['confirmed', null, s.w.clock.now]);
  assert.equal((await s.audits('roster.decline')).length, 2, 'only declines are audited');
  assert.equal(await s.w.count('audit_log', "action LIKE 'roster.%' AND action != 'roster.decline' AND action != 'roster.publish'"), 0);

  // Gorrim: Late is remembered and comes back; the note stays.
  assert.equal((await s.answer('gina', 'decline')).status, 200);
  assert.equal(await raidKind(s.p.gorrim), 'absence');
  assert.equal((await s.call('bob', 'GET', s.path('/signups'))).json.entries.find((e) => e.personId === s.p.gorrim).note, 'traffic');
  assert.equal((await s.answer('gina', 'confirm')).status, 200);
  assert.equal(await raidKind(s.p.gorrim), 'late');
  // A confirm that was never preceded by a decline leaves the sign-up alone (Gorrim is Late, not Absent).
  assert.equal((await s.answer('gina', 'confirm')).status, 200);
  assert.equal(await raidKind(s.p.gorrim), 'late');
  // Kestrel has no Discord, so nobody answers for him; and a person with no sign-up who declines gets an Absence, and confirming then makes it 'signed'.
  assert.equal((await s.answer('hank', 'decline')).status, 403);
  // The lock and the deadline do not apply: lock the raid, give the team a 48 hour deadline (long past), answer all the same.
  assert.equal((await s.call('bob', 'POST', s.path('/signups/lock'), {})).status, 200);
  assert.equal((await s.call('bob', 'PUT', `/teams/${s.A}/schedule`, { slots: [{ weekday: 2, startTime: '20:00' }], signupCloseHours: 48 })).status, 200);
  assert.equal((await s.call('erin', 'PUT', s.path('/signup'), { kind: 'late' })).json.reason, 'locked', 'an ordinary sign-up change is shut');
  const lockedDecline = await s.answer('erin', 'decline');
  assert.equal(lockedDecline.status, 200, JSON.stringify(lockedDecline.json));
  assert.equal(await raidKind(s.p.eliora), 'absence');
  assert.equal((await s.answer('erin', 'confirm')).status, 200);
  assert.equal(await raidKind(s.p.eliora), 'signed');
  // The start ends it: 409 for both, nothing changes; the officer's read still works.
  s.w.clock.now = s.startsAt;
  for (const what of ['decline', 'confirm']) {
    const r = await s.answer('erin', what);
    assert.deepEqual([what, r.status, r.json.error], [what, 409, 'raid_started']);
  }
  assert.equal(await raidKind(s.p.eliora), 'signed');
  assert.equal((await s.roster()).status, 200);
  assert.equal((await s.publish()).json.error, 'raid_started');
});

check('roster: who may answer - a seated member of the raid\'s team, on a published roster, before the start', async () => {
  const s = await rosterWorld();
  await s.basicPlan();
  // Not published yet.
  const early = await s.answer('erin', 'confirm');
  assert.deepEqual([early.status, early.json.error], [409, 'roster_not_published']);
  await s.plan([{ name: 'Gorrim', group: 1 }, { name: 'Kestrel', group: 0 }]);
  assert.equal((await s.publish()).status, 200);
  // Erin has a person on Alpha but is not seated.
  const notSeated = await s.answer('erin', 'decline');
  assert.deepEqual([notSeated.status, notSeated.json.error], [409, 'not_on_roster']);
  // No person, a Team Lead of another team and a signed-out request.
  for (const who of ['hank', 'dave']) assert.deepEqual([who, (await s.answer(who, 'confirm')).status], [who, 403]);
  assert.equal((await s.w.call(newJar(), 'POST', `${s.guildPath}/raids/${s.rid}/roster/confirm`, {})).status, 401);
  // An officer who is also seated answers for themselves like anybody (Bob has no person here, so he cannot).
  assert.equal((await s.answer('bob', 'confirm')).status, 403);
  // Gorrim can.
  assert.equal((await s.answer('gina', 'confirm')).status, 200);
  assert.equal((await s.seat('Gorrim')).status, 'confirmed');
  // Nothing was written for the refused ones.
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith' AND player_id = ?", s.p.eliora), 0);
  assert.equal(await s.w.count('audit_log', "action = 'roster.decline'"), 0);
});

check('roster: unpublishing takes the roster and its answers back (audited once); deleting the raid removes the roster', async () => {
  const s = await rosterWorld();
  await s.basicPlan();
  await s.publish();
  assert.equal((await s.answer('erin', 'decline')).status, 200);
  assert.equal((await s.call('erin', 'DELETE', s.path('/roster'), {})).status, 403, 'a member cannot');
  assert.equal((await s.call('dave', 'DELETE', s.path('/roster'), {})).status, 403);
  const gone = await s.call('carol', 'DELETE', s.path('/roster'), {});
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.deepEqual([gone.json.published, gone.json.publishedAt, gone.json.publishedBy, gone.json.entries, gone.json.counts, gone.json.planChanged],
    [false, null, null, [], { pending: 0, confirmed: 0, declined: 0, total: 0 }, false]);
  assert.equal(await s.w.count('raid_roster'), 0);
  assert.deepEqual((await s.w.rows('SELECT roster_published_at AS a, roster_published_by AS b FROM raids WHERE id = ?', s.rid))[0], { a: null, b: null });
  assert.deepEqual((await s.roster('erin')).json, { published: false, publishedAt: null, mine: null });
  assert.equal((await s.signupOf(s.p.eliora)).find((r) => r.source === 'raidsmith').kind, 'absence', 'the Absence the decline made stays');
  assert.equal((await s.audits('roster.unpublish')).length, 1);
  // Again: nothing to take back, nothing audited.
  assert.equal((await s.call('bob', 'DELETE', s.path('/roster'), {})).status, 200);
  assert.equal((await s.audits('roster.unpublish')).length, 1);
  // Publish, then delete the raid: the roster goes with it.
  await s.publish();
  assert.equal(await s.w.count('raid_roster'), 4);
  assert.equal((await s.call('bob', 'DELETE', s.path(), {})).status, 200);
  assert.equal(await s.w.count('raid_roster'), 0);
});

check('roster: the Raids list tells the viewer their seat on a published roster; Needs attention counts the seats that said they cannot come', async () => {
  const s = await rosterWorld();
  const other = await s.makeRaid({ teamId: s.A, raidOn: '2027-01-21', startTime: '20:00' });
  await s.basicPlan();
  assert.equal((await s.call('erin', 'PUT', s.path('/signup'), { kind: 'signed' })).status, 200);
  const mineOf = async (who, id = s.rid) => (await s.call(who, 'GET', `/raids?team=${s.A}`)).json.upcoming.find((row) => row.id === id).mine;
  assert.equal('roster' in (await mineOf('erin')), false, 'unpublished: no seat');
  assert.equal(await mineOf('gina'), null);
  await s.publish();
  assert.deepEqual(await mineOf('erin'), { kind: 'signed', source: 'raidsmith', characterName: 'Eliora', roster: { group: 1, status: 'pending' } });
  // Gorrim is seated but has no sign-up: mine says so with a null kind.
  assert.deepEqual(await mineOf('gina'), { kind: null, source: null, characterName: null, roster: { group: 2, status: 'pending' } });
  assert.equal(await mineOf('hank'), null);
  assert.equal(await mineOf('erin', other.id), null, 'another raid has no seat');
  assert.equal((await s.answer('erin', 'confirm')).status, 200);
  assert.deepEqual((await mineOf('erin')).roster, { group: 1, status: 'confirmed' });
  assert.equal((await s.answer('gina', 'decline')).status, 200);
  assert.deepEqual(await mineOf('gina'), { kind: 'absence', source: 'raidsmith', characterName: 'Gorrim', roster: { group: 2, status: 'declined' } });

  // Needs attention: one item for the raid with the number of declined seats.
  const items = async (who = 'bob') => (await s.call(who, 'GET', '/attention')).json;
  const item = async (who) => (await items(who)).items.find((entry) => entry.kind === 'roster_declined');
  const found = await item('bob');
  assert.deepEqual([found.kind, found.severity, found.teamId, found.teamName, found.raidId, found.date, found.count, found.id, found.link, found.startsAt],
    ['roster_declined', 'action', s.A, 'Alpha', s.rid, '2027-01-19', 1, `roster_declined:${s.rid}`, { name: 'raid', rid: s.rid }, s.startsAt]);
  assert.deepEqual(Object.keys(found).sort(), ['count', 'date', 'id', 'kind', 'link', 'raidId', 'severity', 'startsAt', 'teamId', 'teamName', 'title', 'zone']);
  assert.equal((await item('carol')).count, 1, 'the Team Lead of the team sees it');
  assert.equal(await item('dave'), undefined, 'the Team Lead of another team does not');
  assert.equal((await s.call('erin', 'GET', '/attention')).status, 403);
  // It counts in the open-work total, and a second decline adds to the same item.
  const total = (await items()).total;
  assert.equal((await s.answer('erin', 'decline')).status, 200);
  assert.deepEqual([(await item('bob')).count, (await items()).total], [2, total]);
  // It goes when they confirm, when the roster is taken back, and when the raid has started.
  assert.equal((await s.answer('erin', 'confirm')).status, 200);
  assert.equal((await item('bob')).count, 1);
  assert.equal((await s.answer('gina', 'confirm')).status, 200);
  assert.equal(await item('bob'), undefined);
  assert.equal((await s.answer('gina', 'decline')).status, 200);
  assert.equal((await item('bob')).count, 1);
  assert.equal((await s.call('bob', 'DELETE', s.path('/roster'), {})).status, 200);
  assert.equal(await item('bob'), undefined);
  await s.publish();
  assert.equal(await item('bob'), undefined, 'a fresh publish asks everybody again');
  assert.equal((await s.answer('erin', 'decline')).status, 200);
  assert.equal((await item('bob')).count, 1);
  s.w.clock.now = s.startsAt;
  assert.equal(await item('bob'), undefined, 'a raid that has started is no longer open work');
});

check('roster: the pure Needs attention builder lists roster_declined items for those who edit raids on the team, soonest first, and ignores an archived team', async () => {
  const { buildAttention, ATTENTION_KINDS } = await load('worker/attention.js');
  assert(ATTENTION_KINDS.includes('roster_declined') && ATTENTION_KINDS.indexOf('roster_declined') < ATTENTION_KINDS.indexOf('unlocked'));
  const NOW = Date.parse('2027-01-16T12:00:00Z');
  const teams = [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }, { id: 't_b', name: 'Bravo', size: 25, archived: 0 }, { id: 't_c', name: 'Old', size: 25, archived: 1 }];
  const base = { today: '2027-01-16', now: NOW, teams, allowsTeam: (action, teamId) => teamId !== 't_b' && action === 'raids.edit', granted: () => true, flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], watch: [], upcoming: [] };
  const row = (id, team, day, n) => ({ id, team_id: team, raid_on: `2027-01-${day}`, starts_at: NOW + day * 86400000, zone: 'Karazhan', title: null, event_title: 'Night', n });
  const built = buildAttention({ ...base, rosterDeclined: [row('r_late', 't_a', 25, 1), row('r_soon', 't_a', 19, 3), row('r_bravo', 't_b', 20, 2), row('r_old', 't_c', 18, 1)] });
  assert.deepEqual(built.items.map((item) => [item.id, item.count]), [['roster_declined:r_soon', 3], ['roster_declined:r_late', 1]]);
  assert.deepEqual([built.items[0].title, built.items[0].zone, built.items[0].date, built.total], ['Night', 'Karazhan', '2027-01-19', 2]);
  assert.deepEqual(buildAttention({ ...base }).items, [], 'the input is optional');
});

// ---- runner (keep last): add new checks ABOVE this line ----
async function main() {
  const filter = process.argv[2] || '';
  let failed = 0;
  let passed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack || error).toString().split('\n').slice(0, 14).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main();
