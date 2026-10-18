/**
 * Raidsmith guild tracker - PM wave 1 (officer tools) Worker tests: the Activity log, the attendance watch list, Needs attention, the
 * trial review card and the calendar feed.
 * Run: node guild-wave1-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord faked by an injected
 * fetch. No network, no Wrangler, no credentials. Spec: tasks/guild-pm-wave1-spec.md. The pure halves (worker/audit-view.js,
 * worker/calendar-feed.js, worker/attendance-metrics.js watchList, worker/attention.js) are tested directly first, then through the routes.
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
const DAY = 86400000;

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  gina: { id: '110000000000000007', username: 'gina', globalName: '=Gina,"G"' },
};

// ---------------------------------------------------------------------------
// Harness (the same shape as the sign-ups Worker suite)

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

function absorbCookies(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}

const NOW = Date.parse('2027-01-16T12:00:00Z'); // Saturday 07:00 in America/New_York
const TODAY = '2027-01-16';

async function makeWorld() {
  const { createApp } = await load('worker/index.js');
  const db = createD1Fake();
  const discord = makeDiscord();
  const clock = { now: NOW };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id,
  };
  const app = createApp({ db, env, fetch: discord.fetch, now: () => clock.now, randomBytes, log: () => {} });
  const world = {
    db, discord, clock, env,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
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
      return { status: response.status, json, headers: response.headers, response };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) { return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n; },
    exec(sql) { db.sqlite.exec(sql); },
  };
  return world;
}

async function signIn(world, person, servers = []) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember Guard', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

// Alice (Guild Master) makes the guild with two teams; Bob (Officer), Carol (Team Lead of Alpha), Dave (Team Lead of Bravo), Erin and Gina (Members).
async function scenario({ who = ['bob', 'carol', 'dave', 'erin', 'gina'] } = {}) {
  const w = await makeWorld();
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, guildId: created.json.guild.id, A: created.json.teams[0].id, B: created.json.teams[1].id, jars: { alice }, ids: {}, p: {} };
  for (const name of who) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.base = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body) => w.call(s.jars[name], method, `${s.base}${route}`, body);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.base}/people/${s.ids[name]}/roles`, body);
  assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.A] })).status, 200);
  assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.B] })).status, 200);
  return s;
}

async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', { teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  s.p[name] = r.json.person.id;
  return r.json;
}

// A raid with only a date (starts at noon UTC) or a date and a start time; returns its id.
async function addRaid(s, teamId, raidOn, extra = {}) {
  const r = await s.call('bob', 'POST', '/raids', { teamId, raidOn, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.raid.id;
}

// An attendance row straight into the table (the consolidation is covered by the attendance suites).
function attend(s, raidId, teamId, playerId, outcome, credit) {
  s.w.exec(`INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES ('${raidId}', '${s.guildId}', '${teamId}', '${playerId}', '${outcome}', ${credit === null ? 'NULL' : credit}, ${credit > 0 ? 1 : 0})`);
}

// An audit row straight into the table, for the paging and filter cases.
let auditCounter = 0;
function auditRow(s, { at, actor = null, action = 'person.update', entityType = 'person', entityId = null, before = null, after = null, guildId = undefined }) {
  auditCounter++;
  const id = `al_${String(auditCounter).padStart(22, 'x')}`;
  const gid = guildId === undefined ? s.guildId : guildId;
  s.w.db.prepare('INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, gid, actor, action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), at).run();
  return id;
}

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
  return count.d1;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const texts = (rows) => rows.map((row) => row.text);

// ===========================================================================
// PURE: worker/audit-view.js

check('audit-view: every audited action has a group, the groups are the seven of the spec, and a missing mapping falls to Settings', async () => {
  const view = await load('worker/audit-view.js');
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  assert.deepEqual(view.AUDIT_GROUPS.map((g) => g.id), ['roster', 'raids', 'attendance', 'loot', 'signups', 'bnet', 'settings']);
  assert.deepEqual(view.AUDIT_GROUPS.map((g) => g.label), ['Roster', 'Raids', 'Attendance', 'Loot', 'Sign-ups', 'Battle.net', 'Settings']);
  // A new action in audit.js must be given a home here (and a sentence in describeRow): this is the reminder.
  assert.deepEqual(view.unmappedActions(), [], `map these in worker/audit-view.js ACTION_GROUP: ${view.unmappedActions().join(', ')}`);
  for (const key of Object.keys(view.ACTION_GROUP)) assert(AUDIT_ACTIONS.includes(key), `${key} is mapped but not an audited action`);
  assert.equal(view.groupOf('person.update'), 'roster');
  assert.equal(view.groupOf('policy.update'), 'attendance');
  assert.equal(view.groupOf('claim.approve'), 'bnet');
  assert.equal(view.groupOf('something.new'), 'settings');
  // The Settings filter is "everything the other groups do not list": a new unlisted action is found there.
  const settings = view.groupFilter('settings');
  assert.equal(settings.not, true);
  assert(!settings.actions.includes('roles.set') && settings.actions.includes('person.update'));
  assert.equal(view.groupFilter('loot').not, false);
  assert.deepEqual(view.groupFilter('loot').actions.sort(), ['loot.delete', 'loot.import', 'loot.policy', 'loot.update']);
});

check('audit-view: a sentence for every action, from the names looked up (exact text)', async () => {
  const { describeRow } = await load('worker/audit-view.js');
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  const names = {
    person: (id) => ({ p_thoren: 'Thoren', p_kael: 'Kaelith' })[id] || null,
    character: (id) => ({ c_th: 'Thoren', c_alt: 'Thorenmage' })[id] || null,
    team: (id) => ({ t_a: 'Alpha', t_b: 'Bravo' })[id] || null,
    raid: (id) => ({ r_1: 'Tue Oct 21 (Alpha)' })[id] || null,
    user: (id) => ({ u_erin: 'Erin E', u_bob: 'bob' })[id] || null,
    award: (id) => ({ lo_1: 'Girdle of Mighty Resolve' })[id] || null,
    claim: (id) => ({ cl_1: 'Mirabel' })[id] || null,
  };
  const row = (action, entityType, entityId, before, after) => ({ action, entityType, entityId, before, after });
  const cases = [
    [row('guild.create', 'guild', 'g_1', null, null), 'Created the guild'],
    [row('guild.claim', 'guild', 'g_1'), 'Claimed the guild as Guild Master'],
    [row('team.create', 'team', 't_a'), 'Created the team Alpha'],
    [row('team.rename', 'team', 't_b'), 'Renamed a team to Bravo'],
    [row('team.archive', 'team', 't_b'), 'Archived the team Bravo'],
    [row('team.restore', 'team', 't_b'), 'Restored the team Bravo'],
    [row('roles.set', 'user', 'u_erin', { officer: false, teamLeadTeamIds: [] }, { officer: true, teamLeadTeamIds: [] }), 'Made Erin E an Officer'],
    [row('roles.set', 'user', 'u_erin', { officer: true, teamLeadTeamIds: [] }, { officer: false, teamLeadTeamIds: [] }), 'Removed Erin E as Officer'],
    [row('roles.set', 'user', 'u_erin', { officer: false, teamLeadTeamIds: [] }, { officer: false, teamLeadTeamIds: ['t_a', 't_b'] }), 'Made Erin E Team Lead of Alpha and Bravo'],
    [row('roles.set', 'user', 'u_erin', { officer: false, teamLeadTeamIds: ['t_a'] }, { officer: true, teamLeadTeamIds: [] }), 'Made Erin E an Officer and removed them as Team Lead of Alpha'],
    [row('guild_master.transfer', 'user', 'u_bob'), 'Handed Guild Master to bob'],
    [row('guild_master.auto_promote', 'guild', 'g_1', { guildMasterUserId: 'u_x' }, { guildMasterUserId: 'u_bob' }), 'Guild Master passed to bob'],
    [row('access.remove', 'user', 'u_erin'), 'Removed the access of Erin E'],
    [row('access.restore', 'user', 'u_erin'), 'Restored the access of Erin E'],
    [row('person.create', 'person', 'p_thoren', null, { status: 'trial' }), 'Added Thoren to the roster as Trial'],
    [row('person.update', 'person', 'p_thoren', { status: 'raider' }, { status: 'reserve', changed: ['status'] }), 'Moved Thoren to Reserve'],
    [row('person.update', 'person', 'p_thoren', { status: 'raider' }, { status: 'inactive', leftReason: 'kicked', changed: ['status', 'leftOn', 'leftReason'] }), 'Moved Thoren to Inactive (kicked)'],
    [row('person.update', 'person', 'p_thoren', {}, { status: 'trial', changed: ['status', 'trialEnd'] }), 'Moved Thoren to Trial and updated trial end'],
    [row('person.update', 'person', 'p_thoren', {}, { status: 'trial', changed: ['joinedOn', 'trialEnd'] }), 'Updated Thoren: join date and trial end'],
    [row('person.delete', 'person', 'p_gone', { status: 'raider' }), 'Removed a person from the roster'],
    [row('person.notes', 'person', 'p_thoren', { notesVersion: 1 }, { notesVersion: 2 }), 'Edited the officer notes of Thoren'],
    [row('character.create', 'character', 'c_alt', null, { personId: 'p_thoren' }), 'Added the character Thorenmage to Thoren'],
    [row('character.update', 'character', 'c_th', {}, { changed: ['teamId', 'mainSpec'] }), 'Updated the character Thoren: team and main spec'],
    [row('character.delete', 'character', 'c_old', { personId: 'p_kael' }), 'Removed a character from Kaelith'],
    [row('character.main', 'character', 'c_alt', { mainCharacterId: 'c_th' }, { mainCharacterId: 'c_alt' }), 'Made Thorenmage the Main character'],
    [row('roster.import', 'team', 't_a', null, { source: 'wcl', people: 1, characters: 12 }), 'Imported 1 person and 12 characters from Warcraft Logs into Alpha'],
    [row('raid.create', 'raid', 'r_1'), 'Created the raid on Tue Oct 21 (Alpha)'],
    [row('raid.delete', 'raid', 'r_gone', { teamId: 't_a', raidOn: '2026-10-21' }), 'Deleted the raid on Wed Oct 21 (Alpha)'],
    [row('raid.event', 'raid', 'r_1', { event: false }, { eventId: '1' }), 'Linked the Raid-Helper event of the raid on Tue Oct 21 (Alpha)'],
    [row('raid.event', 'raid', 'r_1', { event: true }, { eventId: '1', raidOn: '2026-10-22' }), 'Refreshed the Raid-Helper event of the raid on Tue Oct 21 (Alpha) and moved the raid to Thu Oct 22'],
    [row('raid.event', 'raid', 'r_1', { event: true }, { event: false }), 'Removed the Raid-Helper event from the raid on Tue Oct 21 (Alpha)'],
    [row('raid.report', 'raid', 'r_1', { refreshed: false }, { code: 'x' }), 'Added a Warcraft Logs report to the raid on Tue Oct 21 (Alpha)'],
    [row('raid.report', 'raid', 'r_1', { refreshed: true }, { code: 'x' }), 'Refreshed a Warcraft Logs report on the raid on Tue Oct 21 (Alpha)'],
    [row('raid.report', 'raid', 'r_1', { code: 'x' }, { removed: true }), 'Removed a Warcraft Logs report from the raid on Tue Oct 21 (Alpha)'],
    [row('raid.plan', 'raid', 'r_1', { plan: false }, { players: 25, live: true }), 'Attached a plan of 25 players to the raid on Tue Oct 21 (Alpha)'],
    [row('raid.plan', 'raid', 'r_1', { plan: true }, { plan: false }), 'Removed the plan from the raid on Tue Oct 21 (Alpha)'],
    [row('raid.manual', 'raid', 'r_1', { manual: false }, { manual: true, present: 20, reason: 'x' }), 'Entered attendance by hand for the raid on Tue Oct 21 (Alpha) (20 present)'],
    [row('raid.manual', 'raid', 'r_1', { manual: true }, { manual: false, reason: 'x' }), 'Went back from hand-entered attendance on the raid on Tue Oct 21 (Alpha)'],
    [row('schedule.update', 'team', 't_a'), 'Changed the weekly raid schedule of Alpha'],
    [row('schedule.fill', 'team', 't_a', null, { weeks: 2, dates: ['2026-10-21', '2026-10-28'] }), 'Created 2 upcoming raids for Alpha from its schedule'],
    [row('attendance.decide', 'raid', 'r_1', { playerId: 'p_kael' }, { playerId: 'p_kael', outcome: 'missed_notice' }), 'Decided the attendance of Kaelith on Tue Oct 21 (Alpha): Missed with notice'],
    [row('attendance.undo', 'raid', 'r_1', { playerId: 'p_kael' }, { playerId: 'p_kael' }), 'Undid the decision for Kaelith on Tue Oct 21 (Alpha)'],
    [row('attendance.guest', 'raid', 'r_1', null, { guest: true }), 'Marked a log name as a guest on Tue Oct 21 (Alpha)'],
    [row('attendance.link', 'raid', 'r_1', null, { personId: 'p_thoren' }), 'Linked a log name on Tue Oct 21 (Alpha) to Thoren'],
    [row('policy.update', 'policy', 'ap_1', {}, { scope: 'guild', changed: ['watch', 'window'] }), 'Changed the attendance policy of the whole guild: watch and window'],
    [row('policy.update', 'policy', 'ap_1', {}, { scope: 't_b', changed: [] }), 'Changed the attendance policy of Bravo'],
    [row('wcl.settings', 'guild', 'g_1'), 'Changed the Warcraft Logs settings'],
    [row('loot.import', 'raid', 'r_1', null, { inserted: 10, updated: 2, unchanged: 0 }), 'Imported 12 loot awards to Tue Oct 21 (Alpha)'],
    [row('loot.import', 'raid', 'r_1', null, { inserted: 1, updated: 0 }), 'Imported 1 loot award to Tue Oct 21 (Alpha)'],
    [row('loot.import', 'raid', 'r_1', null, { inserted: 0, updated: 0, unchanged: 8 }), 'Imported loot to Tue Oct 21 (Alpha): nothing new'],
    [row('loot.update', 'loot', 'lo_1', { tag: 'MS' }, { tag: 'OS' }), 'Tagged Girdle of Mighty Resolve as OS'],
    [row('loot.update', 'loot', 'lo_1', { tag: 'MS' }, { tag: 'MS', noteChanged: true }), 'Edited Girdle of Mighty Resolve'],
    [row('loot.delete', 'loot', 'lo_gone', { itemId: 32235, tag: 'MS' }), 'Deleted a loot award (item 32235)'],
    [row('loot.policy', 'policy', 'lp_1', {}, { scope: 'guild', changed: ['balance'] }), 'Changed the loot policy of the whole guild: balance'],
    [row('signup.set', 'raid', 'r_1', null, { personId: 'p_kael', kind: 'late' }), 'Signed Kaelith up as Late on Tue Oct 21 (Alpha)'],
    [row('signup.remove', 'raid', 'r_1', { personId: 'p_kael' }), 'Removed the sign-up of Kaelith from Tue Oct 21 (Alpha)'],
    [row('signup.lock', 'raid', 'r_1', { locked: false }, { locked: true }), 'Closed sign-ups for the raid on Tue Oct 21 (Alpha)'],
    [row('signup.lock', 'raid', 'r_1', { locked: true }, { locked: false }), 'Reopened sign-ups for the raid on Tue Oct 21 (Alpha)'],
    [row('bnet.settings', 'guild', 'g_1'), 'Changed the Battle.net settings'],
    [row('claim.create', 'claim', 'cl_1'), 'Claimed Mirabel'],
    [row('claim.withdraw', 'claim', 'cl_gone'), 'Withdrew a character claim'],
    [row('claim.approve', 'claim', 'cl_1'), 'Approved the claim for Mirabel'],
    [row('claim.reject', 'claim', 'cl_gone'), 'Rejected the claim for a character'],
  ];
  const seen = new Set();
  for (const [input, expected] of cases) {
    assert.equal(describeRow(input, names), expected, input.action);
    seen.add(input.action);
  }
  // Every audited action has at least one case, except the ones written with no guild (they never reach a guild's log).
  const noGuild = ['account.delete', 'guild.delete', 'bnet.link', 'bnet.unlink'];
  for (const action of AUDIT_ACTIONS) if (!noGuild.includes(action)) assert(seen.has(action), `no sentence test for ${action}`);
  // Nothing known: still a sentence, never a thrown error or "undefined".
  assert.equal(describeRow(row('person.update', 'person', 'p_x', null, null), {}), 'Updated a person');
  assert.equal(describeRow(row('mystery.action', 'x', 'y'), {}), 'mystery.action');
  assert.equal(describeRow(row('raid.create', 'raid', 'r_x'), {}), 'Created the raid on a raid');
});

check('audit-view: collectRefs finds every id a sentence needs, ignores malformed ones', async () => {
  const { collectRefs } = await load('worker/audit-view.js');
  const P = 'p_aaaaaaaaaaaaaaaaaaaaaa';
  const T = 't_bbbbbbbbbbbbbbbbbbbbbb';
  const R = 'r_cccccccccccccccccccccc';
  const U = 'u_dddddddddddddddddddddd';
  const C = 'c_eeeeeeeeeeeeeeeeeeeeee';
  const refs = collectRefs([
    { actor: U, entityType: 'person', entityId: P, before: null, after: { teamId: T, personId: P, raidId: R, mainCharacterId: C, scope: T, guildMasterUserId: U } },
    { actor: null, entityType: 'user', entityId: 'not-an-id', before: { teamLeadTeamIds: [T, 'junk'] }, after: { scope: 'guild', playerId: 'p_short' } },
  ]);
  assert.deepEqual([...refs.persons], [P]);
  assert.deepEqual([...refs.teams], [T]);
  assert.deepEqual([...refs.raids], [R]);
  assert.deepEqual([...refs.characters], [C]);
  assert.deepEqual([...refs.users], [U]);
});

check('audit-view: CSV fields are quoted, doubled-quote escaped, formula-neutralised; the file leads with a BOM and ends each row in CRLF', async () => {
  const { csvField, auditCsv, whenLabel } = await load('worker/audit-view.js');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(12), '12');
  for (const danger of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx']) assert(csvField(danger).replace(/^"/, '').startsWith("'"), `neutralised ${JSON.stringify(danger)}`);
  assert.equal(csvField("'=ok"), "'=ok", 'an apostrophe start is not a formula');
  assert.equal(whenLabel(Date.parse('2027-01-16T12:00:00Z'), 'America/New_York'), '2027-01-16 07:00');
  assert.equal(whenLabel(Date.parse('2027-01-16T04:59:00Z'), 'America/New_York'), '2027-01-15 23:59');
  const csv = auditCsv([
    { at: Date.parse('2027-01-16T12:00:00Z'), actor: { displayName: '=evil,"name"' }, text: 'Moved Thoren, to Reserve', group: 'roster', action: 'person.update', before: { status: 'raider' }, after: { status: 'reserve' } },
    { at: Date.parse('2027-01-16T12:01:00Z'), actor: null, text: 'Removed a person', group: 'roster', action: 'person.delete', before: null, after: null },
  ], 'America/New_York');
  assert(csv.startsWith('\ufeffWhen,Who,What,Type,Action,Before,After\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4, 'header, two rows, and the empty piece after the last CRLF');
  assert.equal(lines[3], '');
  assert(lines[1].startsWith('2027-01-16 07:00,"\'=evil,""name""","Moved Thoren, to Reserve",Roster,person.update,"{""status"":""raider""}"'));
  assert(lines[2].includes('Former member') && lines[2].endsWith(',person.delete,,'));
});

// ===========================================================================
// PURE: worker/calendar-feed.js

check('calendar-feed: TEXT escaping (backslash, semicolon, comma, newline) and control characters', async () => {
  const { escapeText } = await load('worker/calendar-feed.js');
  assert.equal(escapeText('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(escapeText('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  assert.equal(escapeText('bell\u0007and\u0000nul'), 'bellandnul');
  assert.equal(escapeText(null), '');
  assert.equal(escapeText('Zul\'jin - 100% "quoted"'), 'Zul\'jin - 100% "quoted"');
});

check('calendar-feed: folding keeps every line within 75 octets, never splits a character, and unfolds to the original', async () => {
  const { foldLine } = await load('worker/calendar-feed.js');
  const octets = (text) => Buffer.byteLength(text, 'utf8');
  assert.equal(foldLine('SHORT:line'), 'SHORT:line');
  const exactly75 = `X:${'a'.repeat(73)}`;
  assert.equal(octets(exactly75), 75);
  assert.equal(foldLine(exactly75), exactly75, 'exactly 75 octets is not folded');
  const samples = [
    `DESCRIPTION:${'word '.repeat(80)}`,
    `SUMMARY:${'\u00e9'.repeat(100)}`,           // 2-byte characters
    `SUMMARY:${'\u4e2d'.repeat(60)}`,            // 3-byte characters
    `SUMMARY:x${'\u{1F600}'.repeat(40)}`,        // 4-byte characters, offset by one
    `URL:https://raidsmith.test/#/g/g_${'A'.repeat(22)}/raids/r/r_${'B'.repeat(22)}/${'c'.repeat(90)}`,
  ];
  for (const line of samples) {
    const folded = foldLine(line);
    const physical = folded.split('\r\n');
    assert(physical.length > 1, 'folded');
    for (let i = 0; i < physical.length; i++) {
      assert(octets(physical[i]) <= 75, `physical line ${i} is ${octets(physical[i])} octets`);
      if (i > 0) assert(physical[i].startsWith(' '), 'a continuation starts with one space');
      assert(!physical[i].includes('\ufffd'), 'no broken character');
    }
    assert.equal(folded.replace(/\r\n /g, ''), line, 'unfolding gives the original');
  }
});

check('calendar-feed: UTC stamps, end of a raid (known end only when plausible), counts line', async () => {
  const { formatUtc, raidEnd, countsLine, signupKindLabel, DEFAULT_RAID_MS } = await load('worker/calendar-feed.js');
  assert.equal(formatUtc(Date.parse('2027-01-16T12:05:09.250Z')), '20270116T120509Z');
  const start = Date.parse('2027-01-16T01:00:00Z');
  assert.equal(raidEnd(start, null), start + DEFAULT_RAID_MS);
  assert.equal(raidEnd(start, undefined), start + 3 * 3600000);
  assert.equal(raidEnd(start, start + 4 * 3600000), start + 4 * 3600000, 'a known end inside twelve hours is used');
  assert.equal(raidEnd(start, start - 1000), start + DEFAULT_RAID_MS, 'an end before the start is not believed');
  assert.equal(raidEnd(start, start + 30 * 3600000), start + DEFAULT_RAID_MS, 'a report left open for 30 hours is not believed');
  assert.equal(countsLine({ signed: 21, late: 2, bench: 1, tentative: 0, absence: 3 }), 'Signed 21, Late 2, Bench 1, Can\'t come 3');
  assert.equal(countsLine({ signed: 0, late: 0, bench: 0, tentative: 0, absence: 0 }), 'No sign-ups yet');
  assert.equal(countsLine(null), null);
  assert.equal(signupKindLabel('absence'), 'Can\'t come');
});

check('calendar-feed: buildIcs is a well-formed VCALENDAR (CRLF, balanced, required properties, escaping, folding)', async () => {
  const { buildIcs } = await load('worker/calendar-feed.js');
  const text = buildIcs({
    name: 'Ember Guard, "Alpha"; raids',
    stamp: Date.parse('2027-01-16T12:00:00Z'),
    events: [{
      uid: 'r_aaaaaaaaaaaaaaaaaaaaaa@raidsmith', start: Date.parse('2027-01-17T01:00:00Z'), end: Date.parse('2027-01-17T04:00:00Z'),
      summary: 'Black Temple, night 2; bring flasks', description: `Signed 21, Late 2\nYour sign-up: Late\nhttps://raidsmith.test/#/g/g_x/raids/r/r_y ${'z'.repeat(120)}`,
      url: 'https://raidsmith.test/#/g/g_x/raids/r/r_y',
    }],
  });
  assert(text.endsWith('\r\n'));
  assert(!/(^|[^\r])\n/.test(text), 'every line break is CRLF');
  const unfolded = text.replace(/\r\n /g, '').split('\r\n');
  assert.equal(unfolded.pop(), '', 'the last piece after the final CRLF is empty');
  assert.equal(unfolded[0], 'BEGIN:VCALENDAR');
  assert.equal(unfolded[unfolded.length - 1], 'END:VCALENDAR');
  for (const required of ['VERSION:2.0', 'PRODID:-//Raidsmith//Raid calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']) assert(unfolded.includes(required), required);
  assert(unfolded.includes('X-WR-CALNAME:Ember Guard\\, "Alpha"\\; raids'));
  const begin = unfolded.filter((l) => l === 'BEGIN:VEVENT').length;
  assert.equal(begin, 1);
  assert.equal(unfolded.filter((l) => l === 'END:VEVENT').length, begin);
  for (const wanted of [
    'UID:r_aaaaaaaaaaaaaaaaaaaaaa@raidsmith', 'DTSTAMP:20270116T120000Z', 'DTSTART:20270117T010000Z', 'DTEND:20270117T040000Z',
    'SUMMARY:Black Temple\\, night 2\\; bring flasks', 'URL:https://raidsmith.test/#/g/g_x/raids/r/r_y', 'STATUS:CONFIRMED',
  ]) assert(unfolded.includes(wanted), wanted);
  const description = unfolded.find((l) => l.startsWith('DESCRIPTION:'));
  assert(description.startsWith('DESCRIPTION:Signed 21\\, Late 2\\nYour sign-up: Late\\nhttps://'));
  for (const physical of text.split('\r\n')) assert(Buffer.byteLength(physical, 'utf8') <= 75, `a line over 75 octets: ${physical.length}`);
  // No events is still a valid calendar.
  const empty = buildIcs({ name: 'x', stamp: NOW, events: [] });
  assert(empty.startsWith('BEGIN:VCALENDAR\r\n') && empty.endsWith('END:VCALENDAR\r\n') && !empty.includes('VEVENT'));
});

// ===========================================================================
// PURE: worker/attendance-metrics.js watchList, summarizeCells; policy.watch

// Eight Tuesday raids; today is the last one. A 4-week window (US reset day, Tuesday) is 12-29..01-19, the previous one 12-01..12-22.
const W_DATES = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-05', '2027-01-12', '2027-01-19'];
const W_TODAY = '2027-01-19';
async function watchFixture(spec, { watch, windowWeeks = 4, statuses, joined = '2026-11-01' } = {}) {
  const policyModule = await load('worker/attendance-policy.js');
  const policy = policyModule.resolvePolicy(watch ? { watch } : null, null, 'US');
  const raids = W_DATES.map((date, i) => ({ id: `raid${i}`, raidOn: date, hasSignups: true }));
  const people = [];
  const rows = [];
  for (const [id, entry] of Object.entries(spec)) {
    people.push({ id, status: entry.status || 'raider', joinedOn: entry.joined || joined, leftOn: null });
    entry.cells.forEach((cell, i) => {
      if (cell === null) return;
      const [outcome, credit] = typeof cell === 'number' ? [cell > 0 ? 'present' : 'missed', cell] : cell;
      rows.push({ raidId: `raid${i}`, playerId: id, outcome, credit, signupKind: null, attended: credit > 0 ? 1 : 0, viaRaidId: null });
    });
  }
  return { policy, input: { people, raids, rows, borrowed: [], policy, today: W_TODAY, resetDay: 2, windowWeeks, ...(statuses ? { statuses } : {}) } };
}
const P = 1, M = 0;
const MN = ['missed_notice', 0];
const LATE4 = ['late', 0.4];
const LATE404 = ['late', 0.404];

check('watchList: below and a fall against the previous window, reasons, counts, order (lowest first), boundaries in tenths', async () => {
  const { watchList } = await load('worker/attendance-metrics.js');
  const { input } = await watchFixture({
    A: { cells: [P, P, P, P, P, P, M, MN] },            // 100 then 50: below and a fall of 50; one missed, one missed with notice
    B: { cells: [P, P, P, P, P, P, P, M] },             // 100 then 75: 75.0 is not below 75, a fall of 25
    C: { cells: [P, P, P, M, P, P, P, M] },             // 75 then 75: nothing
    D: { cells: [P, P, P, P, P, P, P, LATE4] },         // 100 then 85.0: a fall of exactly 15 counts
    E: { cells: [P, P, P, P, P, P, P, LATE404] },       // 100 then 85.1: a fall of 14.9 does not
    F: { status: 'reserve', cells: [M, M, M, M, M, M, M, M] },
    G: { joined: '2026-12-22', cells: [null, null, null, P, M, M, M, M] }, // joined in the last previous week: only one previous raid counted
    H: { cells: [null, null, null, null, null, null, null, null] },
    I: { status: 'inactive', cells: [P, P, P, P, M, M, M, M] },
  });
  const frozen = JSON.stringify(input);
  const list = watchList(input);
  assert.equal(JSON.stringify(input), frozen, 'the input is not mutated');
  assert.deepEqual([list.below, list.dropBy, list.windowWeeks, list.previousFrom], [0.75, 0.15, 4, '2026-12-01']);
  assert.deepEqual(list.entries.map((e) => [e.playerId, e.pct, e.previousPct, e.drop, e.reasons]), [
    ['G', 0, null, null, ['below']],
    ['A', 50, 100, 50, ['below', 'drop']],
    ['B', 75, 100, 25, ['drop']],
    ['D', 85, 100, 15, ['drop']],
  ]);
  const a = list.entries.find((e) => e.playerId === 'A');
  assert.deepEqual([a.counted, a.missed, a.missedNotice], [4, 1, 1], 'missed and missed-with-notice are told apart');
  const g = list.entries.find((e) => e.playerId === 'G');
  assert.deepEqual([g.counted, g.missed, g.missedNotice], [4, 4, 0]);
});

check('watchList: each threshold alone, both off, no previous window for "all", the status filter, and the 74.9 / 75.0 line', async () => {
  const { watchList } = await load('worker/attendance-metrics.js');
  const spec = {
    A: { cells: [P, P, P, P, P, P, M, MN] },
    B: { cells: [P, P, P, P, P, P, P, M] },
  };
  const ids = (list) => list.entries.map((e) => e.playerId);
  assert.deepEqual(ids(watchList((await watchFixture(spec, { watch: { below: 0.75, dropBy: null } })).input)), ['A']);
  assert.deepEqual(ids(watchList((await watchFixture(spec, { watch: { below: null, dropBy: 0.15 } })).input)), ['A', 'B']);
  assert.deepEqual(ids(watchList((await watchFixture(spec, { watch: { below: null, dropBy: 0.3 } })).input)), ['A'], 'a fall of 25 is under a 30 point line');
  assert.deepEqual(ids(watchList((await watchFixture(spec, { watch: { below: 0.8, dropBy: null } })).input)), ['A', 'B'], 'B at 75 is under 80');
  const off = watchList((await watchFixture(spec, { watch: { below: null, dropBy: null } })).input);
  assert.deepEqual([off.entries, off.below, off.dropBy, off.previousFrom], [[], null, null, null]);
  // Over all raids there is no previous window: only "below" can flag, and over all eight raids A and B are above 75.
  const all = watchList((await watchFixture(spec, { windowWeeks: 'all' })).input);
  assert.equal(all.previousFrom, null);
  assert.deepEqual(all.entries, []);
  const allBelow = watchList((await watchFixture({ Z: { cells: [P, M, M, M, M, M, P, P] } }, { windowWeeks: 'all' })).input);
  assert.deepEqual(allBelow.entries.map((e) => [e.playerId, e.pct, e.previousPct, e.drop, e.reasons]), [['Z', 37.5, null, null, ['below']]]);
  const reserveOnly = await watchFixture({ R: { status: 'reserve', cells: [M, M, M, M, M, M, M, M] } });
  assert.deepEqual(watchList(reserveOnly.input).entries, []);
  assert.deepEqual(ids(watchList({ ...reserveOnly.input, statuses: ['reserve'] })), ['R'], 'statuses can be widened');
  // 74.9 is under 75 and 75.0 is not (percentages carry one decimal; compared in tenths).
  const single = async (credit) => {
    const { policy } = await watchFixture({});
    return watchList({
      people: [{ id: 'X', status: 'raider', joinedOn: '2026-11-01', leftOn: null }], raids: [{ id: 'r', raidOn: W_TODAY, hasSignups: true }],
      rows: [{ raidId: 'r', playerId: 'X', outcome: 'late', credit, signupKind: null, attended: 1, viaRaidId: null }],
      borrowed: [], policy: { ...policy, watch: { below: 0.75, dropBy: null } }, today: W_TODAY, resetDay: 2, windowWeeks: 4,
    });
  };
  assert.deepEqual((await single(0.749)).entries.map((e) => e.pct), [74.9]);
  assert.deepEqual((await single(0.75)).entries, []);
});

check('summarizeCells: counts by the rolling-% rules over a date range (pre-start and out-of-range cells left out; excused notices still counted)', async () => {
  const { summarizeCells } = await load('worker/attendance-metrics.js');
  const { resolvePolicy } = await load('worker/attendance-policy.js');
  const policy = resolvePolicy(null, null, 'US');
  const cell = (date, outcome, credit, extra = {}) => ({ date, outcome, credit, pending: false, preStart: false, ...extra });
  const cells = [
    cell('2026-12-01', 'missed', 0),                           // before the range
    cell('2027-01-05', 'present', 1),
    cell('2027-01-06', 'late', 0.5),
    cell('2027-01-07', 'left_early', null, { pending: true }), // pending: not counted, shown
    cell('2027-01-08', 'missed', 0),
    cell('2027-01-09', 'missed_notice', 0),
    cell('2027-01-10', 'fill_in', 1),
    cell('2027-01-11', 'late_left', 0.5),
    cell('2027-01-12', 'no_signup', null),
    cell('2027-01-13', 'present', 1, { preStart: true }),
    cell('2027-01-30', 'missed', 0),                           // after the range
  ];
  const sum = summarizeCells(cells, { policy, from: '2027-01-01', to: '2027-01-19' });
  assert.deepEqual(sum, { raids: 6, pct: 50, present: 4, missed: 1, missedNotice: 1, late: 2, leftEarly: 2, fillIns: 1, pending: 1 });
  const excused = summarizeCells(cells, { policy: { ...policy, absence: 'excused' }, from: '2027-01-01', to: '2027-01-19' });
  assert.deepEqual([excused.raids, excused.missedNotice], [5, 1]);
  assert.deepEqual(summarizeCells([], { policy, from: null, to: '2027-01-19' }), { raids: 0, pct: null, present: 0, missed: 0, missedNotice: 0, late: 0, leftEarly: 0, fillIns: 0, pending: 0 });
  assert.equal(summarizeCells(cells, { policy, from: null, to: '2027-01-19' }).raids, 7, 'no start: from the first cell');
});

check('policy.watch: defaults, validation (null or a fraction with at most three decimals), team override allowed, merge keeps the other half', async () => {
  const policy = await load('worker/attendance-policy.js');
  assert.deepEqual(policy.DEFAULT_POLICY.watch, { below: 0.75, dropBy: 0.15 });
  const ok = (override, scope = 'guild') => policy.validateOverride(override, scope).ok;
  assert(ok({ watch: { below: 0.5, dropBy: null } }));
  assert(ok({ watch: { below: null, dropBy: null } }));
  assert(ok({ watch: { below: 0, dropBy: 1 } }));
  assert(ok({ watch: { below: 0.755 } }));
  assert(ok({ watch: { dropBy: 0.1 } }, 'team'));
  const bad = (override) => policy.validateOverride(override, 'guild').errors.map((e) => e.path);
  assert.deepEqual(bad({ watch: { below: 1.5 } }), ['watch.below']);
  assert.deepEqual(bad({ watch: { below: -0.1 } }), ['watch.below']);
  assert.deepEqual(bad({ watch: { below: 0.7555 } }), ['watch.below']);
  assert.deepEqual(bad({ watch: { dropBy: '15' } }), ['watch.dropBy']);
  assert.deepEqual(bad({ watch: { dropBy: Number.NaN } }), ['watch.dropBy']);
  assert.deepEqual(bad({ watch: { dropBy: 2 } }), ['watch.dropBy']);
  assert.deepEqual(bad({ watch: { other: 1 } }), ['watch.other']);
  assert.deepEqual(bad({ watch: 0.5 }), ['watch']);
  const resolved = policy.resolvePolicy({ watch: { below: 0.6 } }, { watch: { dropBy: null } }, 'US');
  assert.deepEqual(resolved.watch, { below: 0.6, dropBy: null });
  assert.deepEqual(policy.resolvePolicy({ watch: { below: null } }, null, 'US').watch, { below: null, dropBy: 0.15 });
  // Never part of what makes a stored raid stale.
  assert.equal(policy.consolidationFingerprint(policy.resolvePolicy(null, null, 'US')), policy.consolidationFingerprint(policy.resolvePolicy({ watch: { below: 0.1, dropBy: null } }, null, 'US')));
});

// ===========================================================================
// PURE: worker/attention.js

check('buildAttention: scoping by team right, archived teams, kind order, trial window, thresholds, caps (hidden still counted), info outside the count', async () => {
  const { buildAttention, KIND_CAP } = await load('worker/attention.js');
  const teams = [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }, { id: 't_b', name: 'Bravo', size: 10, archived: 0 }, { id: 't_old', name: 'Old', size: 25, archived: 1 }];
  const raid = (id, team, on, extra = {}) => ({ id, team_id: team, raid_on: on, zone: 'Gruul\'s Lair', title: null, event_title: null, ...extra });
  const base = {
    today: TODAY, now: NOW, teams,
    allowsTeam: () => true, granted: () => true,
    flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], upcoming: [], watch: [],
  };
  const only = (team) => (action, teamId) => teamId === team;
  const flagged = [raid('r1', 't_a', '2027-01-12', { open_flags: 3 }), raid('r2', 't_b', '2027-01-13', { open_flags: 1 }), raid('r3', 't_old', '2027-01-11', { open_flags: 2 })];
  let built = buildAttention({ ...base, flaggedRaids: flagged, allowsTeam: only('t_a') });
  assert.deepEqual(built.items.map((i) => [i.kind, i.raidId, i.count, i.teamName]), [['review', 'r1', 3, 'Alpha']]);
  built = buildAttention({ ...base, flaggedRaids: flagged });
  assert.deepEqual(built.items.map((i) => i.raidId), ['r2', 'r1'], 'newest first; the archived team is left out');
  assert.deepEqual(built.items[0].link, { name: 'raid', rid: 'r2' });
  assert.equal(built.total, 2);

  const everything = buildAttention({
    ...base,
    flaggedRaids: [raid('r1', 't_a', '2027-01-12', { open_flags: 2, title: 'Night 2' })],
    lootUnmatched: [{ raid_id: 'r1', team_id: 't_a', raid_on: '2027-01-12', zone: null, title: null, event_title: 'Event', names: 2 }],
    signupUnmatched: [{ raid_id: 'r9', team_id: 't_a', raid_on: '2027-01-17', zone: null, title: null, event_title: null, n: 4 }],
    claims: 3,
    trials: [
      { id: 'p_t1', trial_end: '2027-01-19', name: 'Thoren', class: 'PALADIN', team_id: 't_a' },
      { id: 'p_t2', trial_end: '2027-01-14', name: 'Veyla', class: 'MAGE', team_id: 't_a' },
      { id: 'p_t3', trial_end: '2027-01-24', name: 'Later', class: 'MAGE', team_id: 't_a' },
      { id: 'p_t4', trial_end: '2027-01-23', name: 'Edge', class: 'MAGE', team_id: 't_a' },
    ],
    watch: [{ teamId: 't_a', entries: [{ playerId: 'p_w', name: 'Kaelith', class: 'ROGUE', pct: 62, previousPct: 90, drop: 28, reasons: ['below', 'drop'] }] }],
    noLoot: [raid('r5', 't_a', '2027-01-10')],
    upcoming: [
      { id: 'u1', team_id: 't_a', raid_on: '2027-01-19', starts_at: NOW + 3 * DAY, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 18 },
      { id: 'u2', team_id: 't_b', raid_on: TODAY, starts_at: NOW + 40 * 60000, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 12 },
      { id: 'u3', team_id: 't_b', raid_on: TODAY, starts_at: NOW + 90 * 60000, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 12 },
      { id: 'u4', team_id: 't_b', raid_on: '2027-01-17', starts_at: NOW + 30 * 60000, zone: null, title: null, event_title: null, signups_locked: 1, n_in: 1 },
      { id: 'u5', team_id: 't_b', raid_on: '2027-01-18', starts_at: NOW + 2 * DAY, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 10 },
    ],
  });
  assert.deepEqual(everything.items.map((i) => i.id), [
    'review:r1', 'loot_unmatched:r1', 'signup_unmatched:r9', 'claims', 'trial:p_t2', 'trial:p_t1', 'trial:p_t4', 'watch:t_a:p_w', 'no_loot:r5',
    'low_signups:u4', 'low_signups:u1', 'unlocked:u2',
  ]);
  const byId = Object.fromEntries(everything.items.map((i) => [i.id, i]));
  assert.deepEqual([byId['trial:p_t2'].days, byId['trial:p_t2'].ended, byId['trial:p_t1'].days, byId['trial:p_t1'].ended, byId['trial:p_t4'].days], [-2, true, 3, false, 7], 'a trial ending in 7 days is in, in 8 is out');
  assert.deepEqual([byId['low_signups:u1'].expected, byId['low_signups:u1'].size, byId['low_signups:u4'].size], [18, 25, 10], 'size is the team\'s raid size; a full team is not listed');
  assert.deepEqual([byId['unlocked:u2'].minutes, byId['unlocked:u2'].severity], [40, 'info'], 'a locked raid or one starting in 90 minutes is not listed');
  assert.deepEqual(byId['review:r1'], {
    kind: 'review', severity: 'action', teamId: 't_a', teamName: 'Alpha', raidId: 'r1', date: '2027-01-12', zone: 'Gruul\'s Lair', title: 'Night 2', count: 2,
    id: 'review:r1', link: { name: 'raid', rid: 'r1' },
  });
  assert.deepEqual(byId.claims.link, { name: 'review' });
  assert.deepEqual(byId['trial:p_t1'].link, { name: 'person', pid: 'p_t1' });
  assert.deepEqual(byId['watch:t_a:p_w'].link, { name: 'personatt', pid: 'p_w' });
  assert.equal(byId['loot_unmatched:r1'].title, 'Event', 'a Raid-Helper title stands in when the raid has none');
  assert.equal(everything.total, 11, 'eleven open items; the information item is not counted');

  // Rights are per kind: a viewer without roster.edit gets no claims, trials or unmatched sign-ups, but the rest.
  const noRoster = buildAttention({
    ...base, claims: 2, trials: [{ id: 'p_t1', trial_end: TODAY, name: 'T', class: 'MAGE', team_id: 't_a' }],
    signupUnmatched: [{ raid_id: 'r9', team_id: 't_a', raid_on: TODAY, zone: null, title: null, event_title: null, n: 1 }],
    flaggedRaids: [raid('r1', 't_a', '2027-01-12', { open_flags: 1 })],
    allowsTeam: (action) => action !== 'roster.edit', granted: (action) => action !== 'roster.edit',
  });
  assert.deepEqual(noRoster.items.map((i) => i.kind), ['review']);
  // Loot items need loot.edit; the unmatched-winner item also needs the review right (its link is the review queue).
  const lootOnly = buildAttention({
    ...base, lootUnmatched: [{ raid_id: 'r1', team_id: 't_a', raid_on: TODAY, zone: null, title: null, event_title: null, names: 1 }], noLoot: [raid('r5', 't_a', '2027-01-10')],
    allowsTeam: (action) => action === 'loot.edit',
  });
  assert.deepEqual(lootOnly.items.map((i) => i.kind), ['no_loot']);

  // The per-kind cap: ten shown, the rest counted in `more` and in the total.
  const many = Array.from({ length: 13 }, (_, i) => raid(`r${i}`, 't_a', `2027-01-${String(i + 1).padStart(2, '0')}`, { open_flags: 1 }));
  const capped = buildAttention({ ...base, flaggedRaids: many });
  assert.equal(capped.items.length, KIND_CAP);
  assert.deepEqual(capped.more, { review: 3 });
  assert.equal(capped.total, 13);
  assert.equal(capped.items[0].raidId, 'r12', 'newest first, so the oldest are the ones left out');
  const manyInfo = buildAttention({
    ...base,
    upcoming: Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, team_id: 't_a', raid_on: TODAY, starts_at: NOW + (i + 1) * 60000, zone: null, title: null, event_title: null, signups_locked: 0, n_in: 25 })),
  });
  assert.deepEqual([manyInfo.items.length, manyInfo.more, manyInfo.total], [10, { unlocked: 2 }, 0], 'information items never count');
});

// ===========================================================================
// ROUTE: GET /audit (the Activity log)

const iso = (text) => Date.parse(text);

// A small RFC 4180 reader for the tests: records of fields, quotes doubled, CRLF between records, no trailing empty record.
function csvParse(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; } else if (c === '\r' && text[i + 1] === '\n') { record.push(field); records.push(record); record = []; field = ''; i++; } else field += c;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

check('audit route: only the Guild Master holds audit.view; officers, leads, members and the signed out are refused', async () => {
  const s = await scenario();
  assert.equal((await s.call('alice', 'GET', '/audit')).status, 200);
  for (const who of ['bob', 'carol', 'dave', 'erin', 'gina']) {
    const r = await s.call(who, 'GET', '/audit');
    assert.equal(r.status, 403, who);
    assert.equal(r.json.error, 'forbidden');
  }
  const out = await s.w.call({}, 'GET', `${s.base}/audit`);
  assert.equal(out.status, 401);
  assert.equal((await s.call('alice', 'GET', '/audit?format=csv')).status, 200);
  assert.equal((await s.call('bob', 'GET', '/audit?format=csv')).status, 403, 'the CSV needs the same right');
  assert.equal((await s.w.call(s.jars.alice, 'GET', '/api/guild/g_aaaaaaaaaaaaaaaaaaaaaa/audit')).status, 404, 'another guild');
});

check('audit route: newest first, a plain sentence from live names, the actor, details, and no note text anywhere; types and actors are listed', async () => {
  const s = await scenario();
  s.w.advance(60000);
  const made = await addPerson(s, 'bob', s.A, 'Thoren');
  s.w.advance(1000);
  const patch = await s.call('bob', 'PATCH', `/roster/${s.p.Thoren}`, { expectedVersion: made.person.version, status: 'reserve' });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  s.w.advance(1000);
  const notes = await s.call('bob', 'PUT', `/roster/${s.p.Thoren}/notes`, { text: 'SECRET NOTE about the trial', expectedNotesVersion: 0 });
  assert.equal(notes.status, 200, JSON.stringify(notes.json));
  s.w.advance(1000);
  const raidId = await addRaid(s, s.A, '2027-01-12');
  s.w.advance(1000);
  const manual = await s.call('bob', 'PUT', `/raids/${raidId}/manual`, { reason: 'No log kept', presentPlayerIds: [s.p.Thoren] });
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  s.w.advance(1000);
  const policy = await s.call('alice', 'GET', '/attendance/policy');
  const saved = await s.call('alice', 'PUT', '/attendance/policy', { policy: { watch: { below: 0.6, dropBy: null } }, expectedVersion: policy.json.versions.guild });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  const r = await s.call('alice', 'GET', '/audit');
  assert.equal(r.status, 200);
  assert.equal(r.json.timeZone, 'America/New_York');
  assert.deepEqual(r.json.types.map((t) => t.id), ['roster', 'raids', 'attendance', 'loot', 'signups', 'bnet', 'settings']);
  const latest = r.json.rows.slice(0, 6);
  assert.deepEqual(texts(latest), [
    'Changed the attendance policy of the whole guild: watch',
    'Entered attendance by hand for the raid on Tue Jan 12 (Alpha) (1 present)',
    'Created the raid on Tue Jan 12 (Alpha)',
    'Edited the officer notes of Thoren',
    'Moved Thoren to Reserve',
    'Added Thoren to the roster as Raider',
  ]);
  assert.deepEqual(latest.map((row) => [row.actor.displayName, row.group]), [['Alice A', 'attendance'], ['bob', 'raids'], ['bob', 'raids'], ['bob', 'roster'], ['bob', 'roster'], ['bob', 'roster']]);
  for (let i = 1; i < r.json.rows.length; i++) assert(r.json.rows[i - 1].at >= r.json.rows[i].at, 'newest first');
  const moved = latest[4];
  assert.equal(moved.action, 'person.update');
  assert.equal(moved.entityType, 'person');
  assert.equal(moved.entityId, s.p.Thoren);
  assert.equal(moved.before.status, 'raider');
  assert.equal(moved.after.status, 'reserve', 'the details toggle has the before and after');
  assert.deepEqual(Object.keys(moved).sort(), ['action', 'actor', 'after', 'at', 'before', 'entityId', 'entityType', 'group', 'id', 'text']);
  assert(!JSON.stringify(r.json).includes('SECRET NOTE'), 'note text is never in the log');
  // The setup actions are in the log too, in the roles group: Settings.
  const setup = r.json.rows.filter((row) => row.action === 'roles.set').map((row) => row.text).sort();
  assert.deepEqual(setup, ['Made Carol C Team Lead of Alpha', 'Made Dave D Team Lead of Bravo', 'Made bob an Officer']);
  assert(r.json.rows.some((row) => row.action === 'guild.create' && row.text === 'Created the guild' && row.group === 'settings'));
  assert.deepEqual(r.json.actors.map((a) => a.displayName), ['Alice A', 'bob'], 'everyone with a row, by name');
  assert.deepEqual(r.json.actors.map((a) => a.id).sort(), [s.ids.alice, s.ids.bob].sort());
  assert.equal(r.json.next, null);
});

check('audit route: a deleted person, raid or account reads as a generic sentence; a deleted actor is a null actor', async () => {
  const s = await scenario();
  s.w.advance(1000);
  const made = await addPerson(s, 'bob', s.A, 'Fleeting');
  const raidId = await addRaid(s, s.A, '2027-01-05');
  s.w.advance(1000);
  assert.equal((await s.call('bob', 'DELETE', `/roster/${s.p.Fleeting}`, { expectedVersion: made.person.version })).status, 200);
  s.w.advance(1000);
  assert.equal((await s.call('bob', 'DELETE', `/raids/${raidId}`, {})).status, 200);
  auditRow(s, { at: NOW + 5000, actor: null, action: 'person.update', entityType: 'person', entityId: 'p_zzzzzzzzzzzzzzzzzzzzzz', after: { status: 'trial', changed: ['status'] } });
  const r = await s.call('alice', 'GET', '/audit');
  const byAction = (action) => r.json.rows.filter((row) => row.action === action).map((row) => row.text);
  assert.deepEqual(byAction('person.delete'), ['Removed a person from the roster']);
  assert.deepEqual(byAction('raid.delete'), ['Deleted the raid on Tue Jan 5 (Alpha)']);
  assert.deepEqual(byAction('raid.create'), ['Created the raid on a raid'], 'the raid is gone, the sentence says so plainly');
  assert.equal(r.json.rows[0].text, 'Moved a person to Trial');
  assert.equal(r.json.rows[0].actor, null);
});

check('audit route: filters - type group, person, guild-local dates (inclusive, in the guild zone), combined; the Settings group is the catch-all', async () => {
  const s = await scenario();
  const mark = (at, actor, action, entityType = 'person') => auditRow(s, { at, actor, action, entityType });
  // 2027-01-10 in America/New_York is 05:00Z to 04:59:59.999Z the next day.
  mark(iso('2027-01-10T04:59:59Z'), s.ids.bob, 'person.update');   // local Jan 9, 23:59:59
  mark(iso('2027-01-10T05:00:00Z'), s.ids.bob, 'person.update');   // local Jan 10, 00:00:00
  mark(iso('2027-01-10T20:00:00Z'), s.ids.carol, 'loot.import', 'raid');
  mark(iso('2027-01-11T04:59:59Z'), s.ids.carol, 'signup.set', 'raid');
  mark(iso('2027-01-11T05:00:00Z'), s.ids.bob, 'mystery.thing', 'x'); // local Jan 11, 00:00
  const ats = (r) => r.json.rows.map((row) => row.at);
  const day = await s.call('alice', 'GET', '/audit?from=2027-01-10&to=2027-01-10');
  assert.deepEqual(ats(day), [iso('2027-01-11T04:59:59Z'), iso('2027-01-10T20:00:00Z'), iso('2027-01-10T05:00:00Z')], 'both ends inclusive, by local midnight');
  const from = await s.call('alice', 'GET', '/audit?from=2027-01-11&to=2027-01-11');
  assert.deepEqual(ats(from), [iso('2027-01-11T05:00:00Z')]);
  const to = await s.call('alice', 'GET', '/audit?to=2027-01-09');
  assert.deepEqual(ats(to), [iso('2027-01-10T04:59:59Z')]);
  const roster = await s.call('alice', 'GET', '/audit?type=roster&from=2027-01-09&to=2027-01-11');
  assert.deepEqual(roster.json.rows.map((row) => row.group), ['roster', 'roster']);
  const loot = await s.call('alice', 'GET', '/audit?type=loot');
  assert.deepEqual(loot.json.rows.map((row) => row.action), ['loot.import']);
  const signups = await s.call('alice', 'GET', '/audit?type=signups');
  assert.deepEqual(signups.json.rows.map((row) => row.action), ['signup.set']);
  const settings = await s.call('alice', 'GET', '/audit?type=settings');
  assert(settings.json.rows.some((row) => row.action === 'mystery.thing'), 'an action nobody mapped lands in Settings');
  assert(settings.json.rows.some((row) => row.action === 'guild.create'));
  assert(!settings.json.rows.some((row) => ['person.update', 'loot.import', 'signup.set'].includes(row.action)));
  assert.equal(settings.json.rows.find((row) => row.action === 'mystery.thing').text, 'mystery.thing');
  const carol = await s.call('alice', 'GET', `/audit?actor=${s.ids.carol}`);
  assert.deepEqual(carol.json.rows.map((row) => row.action), ['signup.set', 'loot.import']);
  const both = await s.call('alice', 'GET', `/audit?actor=${s.ids.bob}&type=roster&from=2027-01-10&to=2027-01-10`);
  assert.deepEqual(ats(both), [iso('2027-01-10T05:00:00Z')]);
  const none = await s.call('alice', 'GET', '/audit?type=bnet');
  assert.deepEqual([none.status, none.json.rows, none.json.next], [200, [], null]);
  const empty = await s.call('alice', 'GET', '/audit?type=&actor=&from=&to=&before=');
  assert.equal(empty.status, 200, 'blank filters are no filters');
});

check('audit route: a bad filter is a 400 that names the field', async () => {
  const s = await scenario();
  const bad = async (query, field) => {
    const r = await s.call('alice', 'GET', `/audit?${query}`);
    assert.equal(r.status, 400, query);
    assert.equal(r.json.error, 'bad_request');
    assert.equal(r.json.field, field, query);
  };
  await bad('type=everything', 'type');
  await bad('type=Roster', 'type');
  await bad('actor=nobody', 'actor');
  await bad('actor=p_aaaaaaaaaaaaaaaaaaaaaa', 'actor');
  await bad('from=2027-13-01', 'from');
  await bad('from=yesterday', 'from');
  await bad('to=2027-02-30', 'to');
  await bad('from=2027-01-11&to=2027-01-10', 'to');
  await bad('before=12345', 'before');
  await bad('before=1800000000000:al_short', 'before');
  await bad('format=xml', 'format');
  const sneaky = await s.call('alice', 'GET', `/audit?actor=${encodeURIComponent("u_aaaaaaaaaaaaaaaaaaaaaa' OR '1'='1")}`);
  assert.equal(sneaky.status, 400);
});

check('audit route: 50 rows a page by keyset (ties on the same millisecond included), "next" is the Older cursor, every row is seen once', async () => {
  const s = await scenario();
  const ids = [];
  for (let i = 0; i < 130; i++) ids.push(auditRow(s, { at: i < 120 ? iso('2027-01-10T12:00:00Z') : iso('2027-01-10T12:00:00Z') + 1 + i, action: 'person.notes', entityType: 'person' }));
  const seen = [];
  let url = '/audit?type=roster';
  const sizes = [];
  for (let page = 0; page < 6; page++) {
    const r = await s.call('alice', 'GET', url);
    assert.equal(r.status, 200);
    sizes.push(r.json.rows.length);
    seen.push(...r.json.rows.map((row) => row.id));
    if (!r.json.next) break;
    assert(/^\d{13}:al_[A-Za-z0-9_-]{22}$/.test(r.json.next), r.json.next);
    url = `/audit?type=roster&before=${encodeURIComponent(r.json.next)}`;
  }
  assert.deepEqual(sizes, [50, 50, 30], 'pages of 50; the last holds the rest');
  assert.equal(new Set(seen).size, 130);
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'nothing missed, nothing twice');
  // Newest first across pages: the ten newest (different milliseconds) come first, then the 120 ties in descending id order.
  assert.deepEqual(seen.slice(10, 60), [...seen.slice(10, 60)].sort().reverse());
  const exactly50 = await s.call('alice', 'GET', '/audit?type=roster&to=2027-01-10&from=2027-01-10&actor=');
  assert.equal(exactly50.json.rows.length, 50);
  // A page that ends exactly on the last row has no "next" (the 51st row is what tells).
  s.w.exec(`DELETE FROM audit_log WHERE action = 'person.notes' AND id NOT IN (SELECT id FROM audit_log WHERE action = 'person.notes' ORDER BY created_at DESC, id DESC LIMIT 50)`);
  const last = await s.call('alice', 'GET', '/audit?type=roster');
  assert.deepEqual([last.json.rows.length, last.json.next], [50, null]);
});

check('audit route: CSV - attachment headers, BOM + CRLF, escaping and formula neutralising, filters apply, "before" is ignored, 5,000 rows at most', async () => {
  const s = await scenario();
  s.w.exec(`UPDATE users SET global_name = '=cmd|calc' WHERE id = '${s.ids.carol}'`);
  auditRow(s, { at: iso('2027-01-10T15:00:00Z'), actor: s.ids.carol, action: 'person.update', entityType: 'person', entityId: 'p_zzzzzzzzzzzzzzzzzzzzzz', before: { status: 'raider' }, after: { status: 'reserve', changed: ['status'], note: 'a "quoted", comma' } });
  auditRow(s, { at: iso('2027-01-10T15:01:00Z'), actor: null, action: 'loot.delete', entityType: 'loot', before: { itemId: 32235 } });
  const r = await s.w.req('GET', `${s.base}/audit?format=csv&type=roster`, { jar: s.jars.alice });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(r.headers.get('Content-Disposition'), 'attachment; filename="raidsmith-activity-ember-guard-2027-01-16.csv"');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  const bytes = new Uint8Array(await r.clone().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'a UTF-8 BOM leads, for Excel');
  const body = await r.text(); // text() drops the BOM
  assert(body.startsWith('When,Who,What,Type,Action,Before,After\r\n'));
  const records = csvParse(body);
  assert.deepEqual(records[0], ['When', 'Who', 'What', 'Type', 'Action', 'Before', 'After']);
  const row = records.find((record) => record[4] === 'person.update');
  assert.deepEqual(row.slice(0, 5), ['2027-01-10 10:00', "'=cmd|calc", 'Moved a person to Reserve', 'Roster', 'person.update']);
  assert.deepEqual(JSON.parse(row[5]), { status: 'raider' });
  assert.equal(JSON.parse(row[6]).note, 'a "quoted", comma', 'quotes and commas inside the JSON survive the CSV quoting');
  assert(!records.some((record) => record[4] === 'loot.delete'), 'the type filter applies to the CSV');
  // Bulk rows: the cap is 5,000 data rows, and a cursor is ignored.
  s.w.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5200)
            INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at)
            SELECT 'al_' || printf('%022d', i), '${s.guildId}', NULL, 'person.notes', 'person', NULL, NULL, NULL, ${iso('2027-01-09T12:00:00Z')} + i FROM n`);
  const big = await s.w.req('GET', `${s.base}/audit?format=csv&before=${encodeURIComponent(`${iso('2027-01-09T12:00:00Z') + 10}:al_0000000000000000000010`)}`, { jar: s.jars.alice });
  const bigLines = csvParse(await big.text());
  assert.equal(bigLines.length, 5001, 'the header and 5,000 rows');
  assert(bigLines[1][0] >= bigLines[5000][0], 'newest first');
  const actorOnly = await s.w.req('GET', `${s.base}/audit?format=csv&actor=${s.ids.carol}`, { jar: s.jars.alice });
  assert.equal(csvParse(await actorOnly.text()).length, 2);
});

check('audit route: the read is four D1 calls (session, guild context, rows + actors + teams, names) however many rows', async () => {
  const s = await scenario();
  for (let i = 0; i < 60; i++) auditRow(s, { at: NOW - i * 1000, actor: s.ids.bob, action: 'person.update', entityType: 'person', entityId: null, after: { status: 'raider', changed: ['status'] } });
  assert.equal(await counted(s.w, () => s.call('alice', 'GET', '/audit')), 4);
  assert.equal(await counted(s.w, () => s.call('alice', 'GET', '/audit?format=csv')), 4);
});

// ---- runner (keep last)
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
      console.log(`FAIL  ${name}\n      ${(error && error.stack || error).toString().split('\n').slice(0, 7).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
