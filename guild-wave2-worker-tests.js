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
