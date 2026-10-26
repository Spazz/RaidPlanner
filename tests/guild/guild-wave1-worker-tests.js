/**
 * Raidsmith guild tracker - PM wave 1 (officer tools) Worker tests: the Activity log, the attendance watch list, Needs attention, the
 * trial review card and the calendar feed.
 * Run: node tests/guild/guild-wave1-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord faked by an injected
 * fetch. No network, no Wrangler, no credentials. Spec: tasks/reference/guild-pm-wave1-spec.md. The pure halves (worker/audit-view.js,
 * worker/calendar-feed.js, worker/attendance-metrics.js watchList, worker/attention.js) are tested directly first, then through the routes.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');

const ROOT = require('path').join(__dirname, '..', '..');
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

// bnet: true also starts tools/fake-battlenet.js on a local port, so an account can sign in with Battle.net only (close the world when done).
async function makeWorld({ bnet = false } = {}) {
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
  let fakeBnet = null;
  if (bnet) {
    (await load('worker/battlenet.js')).resetBnetTokenCache();
    fakeBnet = require('../../tools/fake-battlenet').createFakeBattlenet();
    await new Promise((resolve) => fakeBnet.server.listen(0, '127.0.0.1', resolve));
    Object.assign(env, {
      BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`,
      BNET_API_BASE: `http://127.0.0.1:${fakeBnet.server.address().port}`,
    });
  }
  const fetchRouter = (url, init) => (fakeBnet && new URL(String(url)).hostname === '127.0.0.1' ? fetch(url, init) : discord.fetch(url, init));
  const app = createApp({ db, env, fetch: fetchRouter, now: () => clock.now, randomBytes, log: () => {} });
  const world = {
    db, discord, clock, env, bnet: fakeBnet,
    advance(ms) { clock.now += ms; },
    async close() {
      if (!fakeBnet) return;
      const closed = new Promise((resolve) => fakeBnet.server.close(resolve));
      fakeBnet.server.closeAllConnections();
      await closed;
    },
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

// Battle.net sign-in or sign-up (nobody needs to be signed in): the new account's cookie jar.
async function bnetSignIn(world, account) {
  const jar = {};
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember Guard', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

// Alice (Guild Master) makes the guild with two teams; Bob (Officer), Carol (Team Lead of Alpha), Dave (Team Lead of Bravo), Erin and Gina (Members).
async function scenario({ who = ['bob', 'carol', 'dave', 'erin', 'gina'], bnet = false } = {}) {
  const w = await makeWorld({ bnet });
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
  assert.deepEqual(view.groupFilter('loot').actions.sort(), ['loot.add', 'loot.delete', 'loot.import', 'loot.list', 'loot.policy', 'loot.update']);
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
    [row('guild.update', 'guild', 'g_1', { name: 'Ember' }, { name: 'Ember Raiders' }), 'Changed the name from "Ember" to "Ember Raiders"'],
    [row('guild.claim', 'guild', 'g_1'), 'Claimed the guild as Guild Master'],
    [row('guild.export', 'guild', 'g_1'), 'Downloaded the guild data'],
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
    [row('role.create', 'role', 'cr_1', null, { name: 'Raid Lead', permissions: {} }), 'Created the role Raid Lead'],
    [row('role.update', 'role', 'cr_1', { name: 'Raid Lead', permissions: { 'roster.view': 'guild' } }, { name: 'Raid Lead', permissions: { 'roster.view': 'guild', 'raids.view': 'guild' } }), 'Changed the permissions of the role Raid Lead'],
    [row('role.update', 'role', 'cr_1', { name: 'Raid Lead', permissions: { 'roster.view': 'guild', 'raids.view': 'guild' } }, { name: 'Raid Boss', permissions: { 'raids.view': 'guild', 'roster.view': 'guild' } }), 'Renamed the role Raid Lead to Raid Boss'],
    [row('role.update', 'role', 'officer', { name: 'Officer', permissions: {} }, { name: 'Officer', permissions: { 'roster.edit': 'guild' } }), 'Changed the permissions of the role Officer'],
    [row('role.reset', 'role', 'officer', { permissions: {} }), 'Reset the role Officer to its defaults'],
    [row('role.reset', 'role', 'cr_gone', { permissions: {} }), 'Reset a role to its defaults'],
    [row('role.delete', 'role', 'cr_1', { name: 'Raid Lead', permissions: {} }, { holders: 2, mapped: 0, links: 0 }), 'Deleted the role Raid Lead'],
    [row('discord.maps', 'guild', 'g_1', { maps: [] }, { maps: [{ discordRoleId: '1' }, { discordRoleId: '2' }] }), 'Changed the Discord role mapping: 2 Discord roles mapped (was 0)'],
    [row('roles.discord_sync', 'user', 'u_erin', { roles: [{ roleId: 'member', teamId: null }] }, { roles: [{ roleId: 'officer', teamId: null }, { roleId: 'team_lead', teamId: 't_a' }] }), 'Synced the Discord roles of Erin E: 2 added, 1 removed'],
    [row('roles.discord_sync', 'user', 'u_erin', { roles: [] }, { roles: [] }), 'Synced the Discord roles of Erin E'],
    [row('guest.create', 'guest_link', 'gl_1', null, { roleId: 'guest', teamId: 't_a', expiresAt: 1790000000000, labelSet: true }), 'Created a guest link for Alpha'],
    [row('guest.create', 'guest_link', 'gl_2', null, { roleId: 'guest', teamId: null, expiresAt: null, labelSet: false }), 'Created a guest link for the whole guild that does not expire'],
    [row('guest.revoke', 'guest_link', 'gl_1'), 'Turned off a guest link'],
    [row('public.update', 'guild', 'g_1', { enabled: false, sections: [] }, { enabled: true, sections: ['roster', 'raids', 'loot'] }), 'Turned the public page on (roster, raids and loot)'],
    [row('public.update', 'guild', 'g_1', { enabled: true, sections: ['roster'] }, { enabled: true, sections: ['roster', 'raids'] }), 'Changed what the public page shows (roster and raids)'],
    [row('public.update', 'guild', 'g_1', { enabled: true, sections: ['roster'] }, { enabled: false, sections: ['roster'] }), 'Turned the public page off'],
    [row('person.create', 'person', 'p_thoren', null, { status: 'trial' }), 'Added Thoren to the roster as Trial'],
    [row('person.update', 'person', 'p_thoren', { status: 'raider' }, { status: 'reserve', changed: ['status'] }), 'Moved Thoren to Reserve'],
    [row('person.update', 'person', 'p_thoren', { status: 'raider' }, { status: 'inactive', leftReason: 'kicked', changed: ['status', 'leftOn', 'leftReason'] }), 'Moved Thoren to Inactive (kicked)'],
    [row('person.update', 'person', 'p_thoren', {}, { status: 'trial', changed: ['status', 'trialEnd'] }), 'Moved Thoren to Trial and updated trial end'],
    [row('person.update', 'person', 'p_thoren', {}, { status: 'trial', changed: ['joinedOn', 'trialEnd'] }), 'Updated Thoren: join date and trial end'],
    [row('person.delete', 'person', 'p_gone', { status: 'raider' }), 'Removed a person from the roster'],
    [row('person.notes', 'person', 'p_thoren', { notesVersion: 1 }, { notesVersion: 2 }), 'Edited the officer notes of Thoren'],
    [row('person.account_link', 'person', 'p_thoren', { userId: null }, { userId: 'u_erin' }), 'Linked Thoren to the account Erin E'],
    [row('person.account_link', 'person', 'p_thoren', { userId: null }, { userId: 'u_gone' }), 'Linked Thoren to an account'],
    [row('person.account_unlink', 'person', 'p_thoren', { userId: 'u_bob' }, { userId: null }), 'Unlinked the account bob from Thoren'],
    [row('person.account_unlink', 'person', 'p_gone', { userId: 'u_gone' }, { userId: null }), 'Unlinked an account from a person'],
    [row('character.create', 'character', 'c_alt', null, { personId: 'p_thoren' }), 'Added the character Thorenmage to Thoren'],
    [row('character.update', 'character', 'c_th', {}, { changed: ['teamId', 'mainSpec'] }), 'Updated the character Thoren: team and main spec'],
    [row('character.delete', 'character', 'c_old', { personId: 'p_kael' }), 'Removed a character from Kaelith'],
    [row('character.main', 'character', 'c_alt', { mainCharacterId: 'c_th' }, { mainCharacterId: 'c_alt' }), 'Made Thorenmage the Main character'],
    // User-hierarchy build, lane B3: the team routes.
    [row('character.place', 'character', 'c_alt', { teamId: null, personId: 'p_thoren' }, { teamId: 't_a', personId: 'p_thoren' }), 'Put the character Thorenmage on Alpha'],
    [row('character.release', 'character', 'c_alt', { teamId: 't_a', personId: 'p_thoren' }, { teamId: null, personId: 'p_thoren', removeSignups: false }), 'Took the character Thorenmage off Alpha'],
    [row('character.release', 'character', 'c_alt', { teamId: 't_a', personId: 'p_thoren' }, { teamId: null, personId: 'p_thoren', removeSignups: true }), 'Took the character Thorenmage off Alpha and removed it from the upcoming raids'],
    [row('character.move', 'character', 'c_alt', { teamId: 't_a', personId: 'p_thoren' }, { teamId: 't_b', personId: 'p_thoren', removeSignups: false }), 'Moved the character Thorenmage from Alpha to Bravo'],
    [row('character.claim', 'character', 'c_alt', null, { personId: 'p_thoren', outcome: 'add_alt', source: 'bnet' }), 'Added Thorenmage to their own record from Battle.net'],
    [row('character.claim', 'character', 'c_alt', null, { personId: 'p_thoren', outcome: 'new_person', source: 'hand' }), 'Added Thorenmage to their own record by hand'],
    [row('character.claim', 'character', 'c_th', null, { personId: 'p_thoren', outcome: 'link_person', source: 'bnet' }), 'Linked their account to Thoren through Thoren'],
    [row('signup.open', 'raid', 'r_1', null, { class: 'MAGE' }), 'Signed up as a guest for the raid on Tue Oct 21 (Alpha) (Mage)'],
    [row('signup.open_withdraw', 'raid', 'r_1'), 'Withdrew their guest sign-up from the raid on Tue Oct 21 (Alpha)'],
    [row('signup.guests_clear', 'raid', 'r_1'), 'Removed every guest sign-up from the raid on Tue Oct 21 (Alpha)'],
    [row('team_request.create', 'team_request', 'tq_1', null, { teamId: 't_b', characterId: 'c_alt', personId: 'p_thoren' }), 'Asked for Thorenmage to be put on Bravo'],
    [row('team_request.withdraw', 'team_request', 'tq_1', null, { teamId: 't_b', characterId: 'c_alt' }), 'Withdrew the request to put Thorenmage on Bravo'],
    [row('team_request.approve', 'team_request', 'tq_1', null, { teamId: 't_b', characterId: 'c_alt', personId: 'p_thoren' }), 'Approved the request to put Thorenmage on Bravo'],
    [row('team_request.reject', 'team_request', 'tq_1', null, { teamId: 't_b', characterId: 'c_alt', personId: 'p_thoren' }), 'Rejected the request to put Thorenmage on Bravo'],
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
    [row('raid.plan_edit', 'raid', 'r_1', null, { players: 25 }), 'Edited the plan of the raid on Tue Oct 21 (Alpha): 25 players seated'],
    [row('raid.plan_edit', 'raid', 'r_1', null, { players: 1 }), 'Edited the plan of the raid on Tue Oct 21 (Alpha): 1 player seated'],
    [row('raid.manual', 'raid', 'r_1', { manual: false }, { manual: true, present: 20, reason: 'x' }), 'Entered attendance by hand for the raid on Tue Oct 21 (Alpha): 20 attended'],
    [row('raid.manual', 'raid', 'r_1', { manual: true }, { manual: false, reason: 'x' }), 'Went back from hand-entered attendance on the raid on Tue Oct 21 (Alpha)'],
    [row('team.size', 'team', 't_a', { size: 25 }, { size: 20 }), 'Set the raid size of Alpha to 20'],
    [row('team.trial_days', 'team', 't_a', { trialDays: 14 }, { trialDays: 21 }), 'Set the trial length of Alpha to 21 days'],
    [row('raid.settings', 'raid', 'r_1', { size: null, signupCloseHours: null }, { size: 20, signupCloseHours: null }), 'Changed the settings of the raid on Tue Oct 21 (Alpha): raid size 20'],
    [row('raid.settings', 'raid', 'r_1', { size: 20, signupCloseHours: null }, { size: null, signupCloseHours: 24 }), 'Changed the settings of the raid on Tue Oct 21 (Alpha): raid size automatic and sign-ups close 24 hours before the start'],
    [row('raid.settings', 'raid', 'r_1', { size: null, signupCloseHours: 1 }, { size: null, signupCloseHours: null }), 'Changed the settings of the raid on Tue Oct 21 (Alpha): sign-up deadline back to the team default'],
    [row('roster.publish', 'raid', 'r_1', null, { players: 24, kept: 3 }), 'Published the line-up of the raid on Tue Oct 21 (Alpha) (24 players)'],
    [row('roster.unpublish', 'raid', 'r_1', { published: true }, { published: false }), 'Took back the published line-up of the raid on Tue Oct 21 (Alpha)'],
    [row('roster.decline', 'raid', 'r_1', null, { personId: 'p_kael' }), 'Kaelith can\'t come to the raid on Tue Oct 21 (Alpha)'],
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
    [row('loot.list', 'raid', 'r_1', null, { source: 'tmb', rows: 12, items: 4, people: 3 }), 'Pasted the TMB loot prios for the raid on Tue Oct 21 (Alpha) (12 rows for 4 items)'],
    [row('loot.list', 'raid', 'r_1', null, { source: 'softres', rows: 0, items: 0, people: 0 }), 'Cleared the soft-reserves of the raid on Tue Oct 21 (Alpha)'],
    [row('loot.add', 'loot', 'lo_1', null, { raidId: 'r_1', itemId: 32235, tag: 'MS', manual: true }), 'Added Girdle of Mighty Resolve by hand to the raid on Tue Oct 21 (Alpha)'],
    [row('loot.policy', 'policy', 'lp_1', {}, { scope: 'guild', changed: ['balance'] }), 'Changed the loot policy of the whole guild: balance'],
    [row('signup.set', 'raid', 'r_1', null, { personId: 'p_kael', kind: 'late' }), 'Signed Kaelith up as Late on Tue Oct 21 (Alpha)'],
    [row('signup.link', 'raid', 'r_1', null, { personId: 'p_kael', nickname: 'swift' }), 'Linked the Raid-Helper sign-up "swift" to Kaelith on Tue Oct 21 (Alpha)'],
    [row('signup.remove', 'raid', 'r_1', { personId: 'p_kael' }), 'Removed the sign-up of Kaelith from Tue Oct 21 (Alpha)'],
    [row('signup.lock', 'raid', 'r_1', { locked: false }, { locked: true }), 'Closed sign-ups for the raid on Tue Oct 21 (Alpha)'],
    [row('signup.lock', 'raid', 'r_1', { locked: true }, { locked: false }), 'Reopened sign-ups for the raid on Tue Oct 21 (Alpha)'],
    [row('away.set', 'person', 'p_kael', null, { kind: 'away', personId: 'p_kael' }), 'Added a notice for Kaelith (Away)'],
    [row('away.set', 'person', 'p_kael', { kind: 'away' }, { kind: 'late', personId: 'p_kael' }), 'Changed a notice for Kaelith (Late)'],
    [row('away.remove', 'person', 'p_kael', { kind: 'leaving', personId: 'p_kael' }), 'Removed a notice of Kaelith (Leaving early)'],
    [row('bnet.settings', 'guild', 'g_1'), 'Changed the Battle.net settings'],
    [row('claim.create', 'claim', 'cl_1'), 'Claimed Mirabel'],
    [row('claim.withdraw', 'claim', 'cl_gone'), 'Withdrew a character claim'],
    [row('claim.approve', 'claim', 'cl_1'), 'Approved the claim for Mirabel'],
    [row('claim.reject', 'claim', 'cl_gone'), 'Rejected the claim for a character'],
    // PM wave 3: the intent board, recruitment needs and the applications inbox.
    [row('intent.open', 'intent', 'ir_1', null, { teamId: 't_a' }), 'Opened a spec poll for Alpha'],
    [row('intent.close', 'intent', 'ir_1', null, { teamId: 't_a' }), 'Closed the spec poll of Alpha'],
    [row('intent.pick', 'intent', 'ir_1', null, { personId: 'p_kael', teamId: 't_a', kind: 'main', class: 'WARRIOR', spec: 'Protection', role: 'tank' }), 'Kaelith picked a main for the spec poll of Alpha: Warrior Protection'],
    [row('intent.pick', 'intent', 'ir_1', null, { personId: 'p_kael', teamId: 't_a', kind: 'alt', class: 'MAGE', spec: 'Fire' }), 'Kaelith picked an alt for the spec poll of Alpha: Mage Fire'],
    [row('intent.unpick', 'intent', 'ir_1', null, { personId: 'p_kael', teamId: 't_a', kind: 'main' }), 'Removed the main pick of Kaelith from the spec poll of Alpha'],
    [row('recruiting.targets', 'team', 't_a', { custom: false }, { custom: true, teamId: 't_a' }), 'Set the recruiting targets of Alpha'],
    [row('recruiting.targets', 'team', 't_a', { custom: true }, { custom: false, teamId: 't_a' }), 'Reset the recruiting targets of Alpha'],
    [row('apply.settings', 'guild', 'g_1', { enabled: false, questions: 0 }, { enabled: true, questions: 2 }), 'Turned applications on'],
    [row('apply.settings', 'guild', 'g_1', { enabled: true, questions: 2 }, { enabled: true, questions: 3 }), 'Changed the application questions'],
    [row('apply.settings', 'guild', 'g_1', { enabled: true, questions: 2 }, { enabled: false, questions: 2 }), 'Turned applications off'],
    [row('application.submit', 'application', 'am_1', null, { teamId: 't_b', signedIn: false }), 'Received an application for Bravo'],
    [row('application.update', 'application', 'am_1', null, { teamId: 't_b', status: 'declined', changed: ['status'] }), 'Marked an application for Bravo as Declined'],
    [row('application.update', 'application', 'am_1', null, { teamId: 't_b', status: 'new', changed: ['notes'] }), 'Edited the notes of an application for Bravo'],
    [row('application.accept', 'application', 'am_1', null, { personId: 'p_thoren', teamId: 't_a', linked: true }), 'Accepted an application: Thoren joined Alpha on trial'],
    [row('application.delete', 'application', 'am_1', { teamId: 't_b', status: 'declined' }), 'Deleted an application for Bravo'],
    // PM wave 4: the Discord notification settings, and the Worker switching a dead webhook off.
    [row('notify.update', 'team', 't_a', { teamId: 't_a' }, { teamId: 't_a', changed: ['webhook', 'reminders', 'noreplyHours'] }), 'Changed the Discord notifications of Alpha: webhook, raid reminders and no-reply lead time'],
    [row('notify.update', 'team', 't_a', null, { teamId: 't_a', changed: [] }), 'Changed the Discord notifications of Alpha'],
    [row('notify.disabled', 'team', 't_b', null, { teamId: 't_b', status: 404 }), 'Turned off the Discord webhook of Bravo: Discord answered 404'],
    [row('notify.test', 'team', 't_b', null, { teamId: 't_b', result: 'sent' }), 'Sent a test post to the Discord webhook of Bravo: it arrived'],
    [row('notify.test', 'team', 't_b', null, { teamId: 't_b', result: 'disabled' }), 'Sent a test post to the Discord webhook of Bravo: Discord refused it and the webhook was turned off'],
    [row('notify.test', 'team', 't_b', null, { teamId: 't_b', result: 'failed' }), 'Sent a test post to the Discord webhook of Bravo: it did not arrive'],
    // PM wave 8: raid duties, the guest sign-up link, the launch funnel, a pasted roster.
    [row('duties.set', 'raid', 'r_1', { duties: 0 }, { duties: ['logger', 'extra'] }), 'Set 2 duties for the raid on Tue Oct 21 (Alpha)'],
    [row('duties.set', 'raid', 'r_1', { duties: 2 }, { duties: [] }), 'Cleared the duties of the raid on Tue Oct 21 (Alpha)'],
    [row('join.create', 'raid', 'r_1', null, { maxUses: 5 }), 'Made a guest sign-up link for the raid on Tue Oct 21 (Alpha)'],
    [row('join.revoke', 'raid', 'r_1'), 'Turned off a guest sign-up link of the raid on Tue Oct 21 (Alpha)'],
    [row('signup.guest', 'raid', 'r_1', null, { class: 'MAGE' }), 'A guest signed up for the raid on Tue Oct 21 (Alpha) (Mage)'],
    [row('signup.guest_remove', 'raid', 'r_1', { guest: true }), 'Removed a guest sign-up from the raid on Tue Oct 21 (Alpha)'],
    [row('signup.guest_resolve', 'raid', 'r_1', null, { name: 'Visitor' }), 'Added Visitor as a Guest / Pug on the raid on Tue Oct 21 (Alpha)'],
    [row('launch.update', 'person', 'p_kael', null, { teamId: 't_a', levelBand: '40-59', ready: false }), 'Updated the launch status of Kaelith on Alpha'],
    [row('launch.team', 'team', 't_a', { launchTeam: false }, { launchTeam: true }), 'Turned on the Launch funnel for Alpha'],
    [row('raid.manual', 'raid', 'r_1', { manual: false }, { manual: true, present: 18, unmatched: 2, paste: true }), 'Entered attendance from a pasted roster for the raid on Tue Oct 21 (Alpha): 18 attended, 2 names to review'],
    // PM wave 7: data keys and the rank ladder.
    [row('apikey.create', 'api_key', 'ak_1', null, { teamId: 't_a', datasets: ['roster', 'loot'], expiresAt: 1790000000000 }), 'Made a data key for Alpha (roster and loot)'],
    [row('apikey.create', 'api_key', 'ak_2', null, { teamId: null, datasets: ['attendance'], expiresAt: null }), 'Made a data key for the whole guild (attendance) that does not expire'],
    [row('apikey.revoke', 'api_key', 'ak_1'), 'Turned off a data key'],
    [row('person.rank', 'person', 'p_thoren', { rank: 'raider', rankName: 'Raider' }, { rank: 'core', rankName: 'Core', via: 'accept', teamId: 't_a' }), 'Set the rank of Thoren to Core (accepted the suggestion)'],
    [row('person.rank', 'person', 'p_thoren', { rank: 'core', rankName: 'Core' }, { rank: 'raider', rankName: 'Raider', via: 'manual', teamId: 't_a' }), 'Set the rank of Thoren to Raider'],
    [row('person.rank', 'person', 'p_thoren', { rank: 'core', rankName: 'Core' }, { rank: null, rankName: null, via: 'manual', teamId: 't_a' }), 'Cleared the rank of Thoren'],
    [row('rank.dismiss', 'person', 'p_kael', null, { kind: 'promote', to: 'core', toName: 'Core', until: 1, teamId: 't_a' }), 'Dismissed the suggestion to promote Kaelith to Core for 30 days'],
    [row('rank.dismiss', 'person', 'p_kael', null, { kind: 'review', to: 'raider', toName: 'Raider', until: 1, teamId: 't_a' }), 'Dismissed the suggestion to review Kaelith for 30 days'],
    // Home redesign: a to-do hidden for every officer, and brought back.
    [row('attention.dismiss', 'attention', 'no_loot:r_1', null, { itemId: 'no_loot:r_1', kind: 'no_loot', mode: 'dismiss', until: null, teamId: 't_a', raidId: 'r_1' }), 'Dismissed the to-do "no loot imported" for the raid on Tue Oct 21 (Alpha)'],
    [row('attention.dismiss', 'attention', 'trial:p_kael', null, { itemId: 'trial:p_kael', kind: 'trial', mode: 'snooze', until: 1, days: 3, teamId: 't_a', personId: 'p_kael' }), 'Snoozed the to-do "trial ending" for Kaelith for 3 days'],
    [row('attention.dismiss', 'attention', 'webhook_off:t_b', null, { itemId: 'webhook_off:t_b', kind: 'webhook_off', mode: 'snooze', until: 1, days: 7, teamId: 't_b' }), 'Snoozed the to-do "Discord webhook switched off" for Bravo for 7 days'],
    [row('attention.dismiss', 'attention', 'watch:t_a:p_kael', null, { itemId: 'watch:t_a:p_kael', kind: 'watch', mode: 'reviewed', until: null, teamId: 't_a', personId: 'p_kael' }), 'Marked Kaelith as reviewed on the attendance watch list'],
    [row('attention.restore', 'attention', 'log_missing:r_1', { itemId: 'log_missing:r_1', kind: 'log_missing', mode: 'dismiss', until: null, teamId: 't_a', raidId: 'r_1' }, null), 'Restored the to-do "missing log" for the raid on Tue Oct 21 (Alpha)'],
    [row('attention.restore', 'attention', 'watch:t_a:p_kael', { itemId: 'watch:t_a:p_kael', kind: 'watch', mode: 'reviewed', until: null, teamId: 't_a', personId: 'p_kael' }, null), 'Took Kaelith off Reviewed on the attendance watch list'],
  ];
  const seen = new Set();
  for (const [input, expected] of cases) {
    assert.equal(describeRow(input, names), expected, input.action);
    seen.add(input.action);
  }
  // Every audited action has at least one case, except the ones written with no guild (they never reach a guild's log).
  const noGuild = ['account.delete', 'guild.delete', 'bnet.link', 'bnet.unlink', 'discord.link', 'discord.unlink'];
  for (const action of AUDIT_ACTIONS) if (!noGuild.includes(action)) assert(seen.has(action), `no sentence test for ${action}`);
  // Nothing known: still a sentence, never a thrown error or "undefined".
  assert.equal(describeRow(row('person.update', 'person', 'p_x', null, null), {}), 'Updated a person');
  assert.equal(describeRow(row('mystery.action', 'x', 'y'), {}), 'mystery.action');
  assert.equal(describeRow(row('discord.link', 'user', 'u_x'), {}), 'Linked a Discord account');
  assert.equal(describeRow(row('discord.unlink', 'user', 'u_x'), {}), 'Disconnected a Discord account');
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
  // An account link names the account in userId (before / after).
  const U2 = 'u_ffffffffffffffffffffff';
  const linkRefs = collectRefs([{ actor: U, entityType: 'person', entityId: P, before: { userId: null }, after: { userId: U2 } }]);
  assert.deepEqual([...linkRefs.users].sort(), [U, U2].sort());
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
  const { buildAttention, findAttentionItem, KIND_CAP } = await load('worker/attention.js');
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
    'review:r1', 'loot_unmatched:r1', 'signup_unmatched:r9', 'claims', 'trial:p_t2', 'trial:p_t1', 'trial:p_t4', 'no_loot:r5',
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
  assert.equal(byId['watch:t_a:p_w'], undefined, 'the watch list left Home: it lives on the Attendance page');
  assert.deepEqual(findAttentionItem({ ...base, watch: [{ teamId: 't_a', entries: [{ playerId: 'p_w', name: 'Kaelith', class: 'ROGUE', pct: 62, reasons: ['below'] }] }] }, 'watch:t_a:p_w').entry.item.link, { name: 'personatt', pid: 'p_w' });
  assert.equal(byId['loot_unmatched:r1'].title, 'Event', 'a Raid-Helper title stands in when the raid has none');
  assert.equal(everything.total, 8, 'eight open to-dos; the readiness facts (low sign-ups, unlocked) and the watch list are not counted');
  assert.equal(byId['low_signups:u1'].readiness, true);

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
    'Entered attendance by hand for the raid on Tue Jan 12 (Alpha): 1 attended',
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

check('audit route: the name an account chose (display name) is the name shown - actor, actors list, sentences, CSV - and an officer\'s account link reads as a sentence', async () => {
  const s = await scenario();
  await addPerson(s, 'bob', s.A, 'Thoren');
  s.w.exec(`UPDATE users SET display_name = 'Officer Bob' WHERE id = '${s.ids.bob}'`);
  s.w.advance(1000);
  const linked = await s.call('bob', 'PUT', `/roster/${s.p.Thoren}/account`, { userId: s.ids.erin });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  const r = await s.call('alice', 'GET', '/audit');
  assert.equal(r.status, 200);
  const link = r.json.rows[0];
  assert.deepEqual([link.action, link.group, link.text, link.actor.displayName], ['person.account_link', 'roster', 'Linked Thoren to the account Erin E', 'Officer Bob']);
  assert.deepEqual(link.after, { userId: s.ids.erin });
  assert.deepEqual(r.json.actors.map((a) => a.displayName), ['Alice A', 'Officer Bob']);
  assert(r.json.rows.some((row) => row.action === 'roles.set' && row.text === 'Made Officer Bob an Officer'), 'sentences use the chosen name too');
  // The chosen name wins over the Discord name for the linked account as well; no name chosen: the Discord name.
  s.w.exec(`UPDATE users SET display_name = 'Erin the Healer' WHERE id = '${s.ids.erin}'`);
  assert.equal((await s.call('alice', 'GET', '/audit')).json.rows[0].text, 'Linked Thoren to the account Erin the Healer');
  s.w.advance(1000);
  assert.equal((await s.call('bob', 'PUT', `/roster/${s.p.Thoren}/account`, { userId: null })).status, 200);
  const unlinked = (await s.call('alice', 'GET', '/audit')).json.rows[0];
  assert.deepEqual([unlinked.action, unlinked.text], ['person.account_unlink', 'Unlinked the account Erin the Healer from Thoren']);
  const csv = await s.w.req('GET', `${s.base}/audit?format=csv`, { jar: s.jars.alice });
  const csvText = await csv.text();
  assert(csvText.includes('Officer Bob') && csvText.includes('Unlinked the account Erin the Healer from Thoren'));
  // The two Discord sign-in actions have no guild, so they never reach a guild's log.
  assert(!r.json.rows.some((row) => row.action.startsWith('discord.')));
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

// ===========================================================================
// ROUTE: the watch list on GET /attendance/team, and policy.watch through GET / PUT /attendance/policy

// Alpha: sixteen Tuesdays (2026-09-29 .. 2027-01-12, indexes 0..15); today is Saturday 2027-01-16, so the 8-week window starts 2026-11-24
// (index 8) and the previous one is 2026-09-29 .. 2026-11-23 (indexes 0..7). Thoren was perfect before and missed six of the last eight;
// Kaelith is steady; Dorrin missed one with notice; Mirabel is a reserve who misses everything.
const TUESDAYS = Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 8, 29) + i * 7 * DAY).toISOString().slice(0, 10));
async function watchWorld() {
  const s = await scenario();
  for (const [name, status] of [['Thoren', 'raider'], ['Kaelith', 'raider'], ['Mirabel', 'reserve'], ['Dorrin', 'raider']]) await addPerson(s, 'bob', s.A, name, { status, joinedOn: '2026-09-01' });
  s.raids = [];
  for (const date of TUESDAYS) s.raids.push(await addRaid(s, s.A, date));
  s.raids.forEach((raidId, i) => {
    const thorenPresent = i < 10;
    attend(s, raidId, s.A, s.p.Thoren, thorenPresent ? 'present' : 'missed', thorenPresent ? 1 : 0);
    attend(s, raidId, s.A, s.p.Kaelith, 'present', 1);
    attend(s, raidId, s.A, s.p.Mirabel, 'missed', 0);
    attend(s, raidId, s.A, s.p.Dorrin, i === 12 ? 'missed_notice' : 'present', i === 12 ? 0 : 1);
  });
  s.team = (who = 'bob', query = '') => s.call(who, 'GET', `/attendance/team?team=${s.A}${query}`);
  s.putPolicy = async (policy, teamId = null) => {
    const view = (await s.call('alice', 'GET', '/attendance/policy')).json;
    const expectedVersion = teamId ? (view.versions.teams[teamId] || 0) : view.versions.guild;
    return s.call('alice', 'PUT', '/attendance/policy', { policy, expectedVersion, ...(teamId ? { teamId } : {}) });
  };
  return s;
}

check('watch list (team attendance): who is flagged and why, with the previous window and the missed / missed-with-notice counts', async () => {
  const s = await watchWorld();
  const r = await s.team('bob');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const watch = r.json.watch;
  assert.deepEqual([watch.below, watch.dropBy, watch.window, watch.previousFrom], [0.75, 0.15, 8, '2026-09-29']);
  assert.deepEqual(watch.entries.map((e) => [e.name, e.class, e.status]), [['Thoren', 'WARRIOR', 'raider']], 'only Thoren: Mirabel is a reserve, Dorrin (87.5, down 12.5) and Kaelith are fine');
  const thoren = watch.entries[0];
  assert.equal(thoren.playerId, s.p.Thoren);
  assert.deepEqual([thoren.pct, thoren.previousPct, thoren.drop, thoren.counted, thoren.missed, thoren.missedNotice], [25, 100, 75, 8, 6, 0]);
  assert.deepEqual(thoren.reasons, ['below', 'drop']);
  assert.deepEqual(Object.keys(thoren).sort(), ['class', 'counted', 'drop', 'itemId', 'latestMissedRaidId', 'missed', 'missedNotice', 'name', 'pct', 'playerId', 'previousPct', 'reasons', 'reviewed', 'status']);
  assert.deepEqual(r.json.people.map((p) => p.name).sort(), ['Dorrin', 'Kaelith', 'Mirabel', 'Thoren'], 'the page itself is unchanged');
  assert(Array.isArray(r.json.weeks) && r.json.policy.switchWeeks.length);
  assert.equal(await counted(s.w, () => s.team('bob')), 4, 'one batch more than the context; the watch list costs no extra call');
});

check('watch list (team attendance): only for those who may review the team; a member is refused the page', async () => {
  const s = await watchWorld();
  assert.notEqual((await s.team('carol')).json.watch, null, 'a Team Lead of the team');
  assert.notEqual((await s.team('alice')).json.watch, null);
  assert.equal((await s.team('dave')).status, 403, 'a Team Lead of another team cannot open the page at all');
  // Erin is the person behind Dorrin: she may view her team's attendance but not review it.
  s.w.exec(`UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.Dorrin}'`);
  assert.equal((await s.team('erin')).status, 403, 'a member with attendance.view only reads her own record');
  assert.equal((await s.team('gina')).status, 403);
});

check('team page permission matrix: guild master, officer and team lead read it; a member, a guest link and the public are refused (D1, 2026-10-21)', async () => {
  const s = await watchWorld();
  for (const who of ['alice', 'bob', 'carol']) assert.equal((await s.team(who)).status, 200, who);
  for (const who of ['erin', 'gina']) {
    const refused = await s.team(who);
    assert.equal(refused.status, 403, who);
    assert.equal(refused.json.message, 'The team attendance page is for the officers and team leads of this team.');
  }
  const { token } = (await s.call('alice', 'POST', '/guest-links', { expiresIn: '1d' })).json.created;
  const guest = {};
  await s.w.call(guest, 'POST', '/auth/guest', { token });
  const guestVisit = (await s.w.call(guest, 'GET', `${s.base}/attendance/team?team=${s.A}`)).status;
  assert(guestVisit === 401 || guestVisit === 403, `a guest link has no account session: ${guestVisit}`);
  const publicVisit = (await s.w.call({}, 'GET', `${s.base}/attendance/team?team=${s.A}`)).status;
  assert(publicVisit === 401 || publicVisit === 403, `the public has no session: ${publicVisit}`);
});

check('team page: every person carries previousPct (the previous window, null under 2 counted raids); none for "all"', async () => {
  const s = await watchWorld();
  const page = (await s.team('bob')).json;
  const by = Object.fromEntries(page.people.map((p) => [p.name, p]));
  const watched = page.watch.entries.find((entry) => entry.name === 'Thoren');
  assert(watched && by.Thoren.previousPct === watched.previousPct, 'same number the watch list computes');
  assert('previousPct' in by.Kaelith && 'previousPct' in by.Dorrin, 'people off the watch list carry it too');
  assert(Object.values(by).every((p) => p.previousPct === null || typeof p.previousPct === 'number'));
  assert((await s.team('bob', '&window=all')).json.people.every((p) => !('previousPct' in p)));
});

check('watch list (team attendance): follows the page window; "all" has no previous window; thresholds can be turned off, one or both; a team override wins', async () => {
  const s = await watchWorld();
  const four = await s.team('bob', '&window=4');
  assert.deepEqual([four.json.watch.window, four.json.watch.previousFrom], [4, '2026-11-24']);
  const all = await s.team('bob', '&window=all');
  assert.deepEqual([all.json.watch.window, all.json.watch.previousFrom], ['all', null]);
  const thoren = all.json.watch.entries.find((e) => e.name === 'Thoren');
  assert.deepEqual([thoren.pct, thoren.previousPct, thoren.drop, thoren.reasons], [62.5, null, null, ['below']]);

  const view = (await s.call('alice', 'GET', '/attendance/policy')).json;
  assert.deepEqual(view.defaults.watch, { below: 0.75, dropBy: 0.15 });
  assert.deepEqual(view.resolved[s.A].watch, { below: 0.75, dropBy: 0.15 });

  let saved = await s.putPolicy({ watch: { below: 0.5, dropBy: null } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.guild.watch, { below: 0.5, dropBy: null });
  assert.deepEqual(saved.json.resolved[s.A].watch, { below: 0.5, dropBy: null });
  let r = await s.team('bob');
  assert.deepEqual([r.json.watch.below, r.json.watch.dropBy, r.json.watch.previousFrom], [0.5, null, null]);
  assert.deepEqual(r.json.watch.entries.map((e) => [e.name, e.pct, e.previousPct, e.drop, e.reasons]), [['Thoren', 25, null, null, ['below']]]);

  saved = await s.putPolicy({ watch: { below: null, dropBy: 0.1 } });
  assert.equal(saved.status, 200);
  r = await s.team('bob');
  assert.deepEqual(r.json.watch.entries.map((e) => [e.name, e.reasons]), [['Thoren', ['drop']], ['Dorrin', ['drop']]], 'Dorrin fell 12.5 points, over the 10 point line');

  saved = await s.putPolicy({ watch: { below: null, dropBy: null } });
  assert.equal(saved.status, 200);
  r = await s.team('bob');
  assert.equal(r.json.watch, null, 'both off: no card');

  // A team override sits on the guild's: Alpha asks for 90%, the guild itself still has both off.
  saved = await s.putPolicy({ watch: { below: 0.9 } }, s.A);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.resolved[s.A].watch, { below: 0.9, dropBy: null });
  assert.deepEqual(saved.json.resolved[s.B].watch, { below: null, dropBy: null });
  r = await s.team('carol');
  assert.deepEqual(r.json.watch.entries.map((e) => [e.name, e.pct]), [['Thoren', 25], ['Dorrin', 87.5]]);
});

check('policy.watch through PUT /attendance/policy: bad values are a 400 naming watch.below / watch.dropBy', async () => {
  const s = await watchWorld();
  const bad = async (policy, field) => {
    const r = await s.putPolicy(policy);
    assert.equal(r.status, 400, JSON.stringify(policy));
    assert.equal(r.json.error, 'policy_invalid');
    assert.equal(r.json.field, field, JSON.stringify(policy));
  };
  await bad({ watch: { below: 1.5 } }, 'watch.below');
  await bad({ watch: { below: -0.2 } }, 'watch.below');
  await bad({ watch: { below: 0.7555 } }, 'watch.below');
  await bad({ watch: { dropBy: '15' } }, 'watch.dropBy');
  await bad({ watch: { dropBy: 15 } }, 'watch.dropBy');
  await bad({ watch: { stuff: 1 } }, 'watch.stuff');
  await bad({ watch: 0.5 }, 'watch');
  // Only an officer-level right saves it, as for every policy key.
  const view = (await s.call('alice', 'GET', '/attendance/policy')).json;
  assert.equal((await s.call('carol', 'PUT', '/attendance/policy', { policy: { watch: { below: 0.5 } }, expectedVersion: view.versions.guild })).status, 403);
  assert.equal((await s.call('bob', 'PUT', '/attendance/policy', { policy: { watch: { below: 0.5 } }, expectedVersion: view.versions.guild })).status, 200);
  assert.equal(await s.w.count('audit_log', "action = 'policy.update'"), 1);
});

// ===========================================================================
// ROUTE: GET /roster/:pid/trial (the trial review card)

// Veyla: a trial who joined Tuesday 2027-01-05 and whose trial ends 2027-01-19. Raids on Alpha: 12-29 (before the trial), 01-05, 01-12, 01-14, 01-15.
async function trialWorld() {
  const s = await scenario();
  await addPerson(s, 'bob', s.A, 'Veyla', { class: 'MAGE', mainSpec: 'Fire', status: 'trial', joinedOn: '2027-01-05', trialEnd: '2027-01-19' });
  await addPerson(s, 'bob', s.A, 'Stranger', { class: 'ROGUE', mainSpec: 'Combat' });
  s.raid = {};
  for (const date of ['2026-12-29', '2027-01-05', '2027-01-12', '2027-01-14', '2027-01-15']) s.raid[date] = await addRaid(s, s.A, date);
  attend(s, s.raid['2026-12-29'], s.A, s.p.Veyla, 'missed', 0);        // before the trial: left out
  attend(s, s.raid['2027-01-05'], s.A, s.p.Veyla, 'present', 1);
  attend(s, s.raid['2027-01-12'], s.A, s.p.Veyla, 'late', 0.5);
  attend(s, s.raid['2027-01-14'], s.A, s.p.Veyla, 'missed_notice', 0);
  attend(s, s.raid['2027-01-15'], s.A, s.p.Veyla, 'fill_in', 1);
  const realmKey = (await s.w.rows('SELECT realm_key FROM characters WHERE player_id = ?', s.p.Veyla))[0].realm_key;
  let n = 0;
  s.award = (raidDate, winner, tag, itemName, extra = {}) => {
    n++;
    const key = winner === null ? null : winner.toLowerCase();
    s.w.db.prepare(
      `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`lo_${String(n).padStart(22, 'x')}`, s.guildId, s.raid[raidDate], s.A, `check${String(n).padStart(6, '0')}`, 30000 + n, itemName, NOW, winner, key, realmKey, tag, NOW, NOW).run();
  };
  s.award('2026-12-29', 'Veyla', 'MS', 'Before The Trial');
  s.award('2027-01-12', 'Veyla', 'MS', 'Robe of the Elder Scribes');
  s.award('2027-01-15', 'Veyla', 'OS', 'Spellfire Belt');
  s.award('2027-01-15', 'Veyla', 'BANK', 'Banked Thing');
  s.award('2027-01-12', 'Stranger', 'MS', 'Someone Elses');
  s.award('2027-01-12', null, 'DE', 'Disenchanted Thing');
  s.trial = (who = 'bob', pid = s.p.Veyla) => s.call(who, 'GET', `/roster/${pid}/trial`);
  return s;
}

check('trial review: attendance since the trial began, loot received, fill-ins, the dates and the flag', async () => {
  const s = await trialWorld();
  const r = await s.trial();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.today, TODAY);
  assert.equal(r.json.since, '2027-01-05');
  assert.deepEqual(r.json.person, {
    id: s.p.Veyla, name: 'Veyla', status: 'trial', joinedOn: '2027-01-05', trialStart: '2027-01-05', trialEnd: '2027-01-19', trialFlag: { kind: 'ends', days: 3 }, version: 1,
  });
  assert.deepEqual(r.json.attendance, {
    team: { id: s.A, name: 'Alpha' }, raids: 4, pct: 62.5, present: 3, missed: 0, missedNotice: 1, late: 1, leftEarly: 0, fillIns: 1, pending: 0,
  });
  assert.deepEqual(r.json.loot.items.map((i) => [i.itemName, i.tag, i.raidOn]), [
    ['Spellfire Belt', 'OS', '2027-01-15'], ['Banked Thing', 'BANK', '2027-01-15'], ['Robe of the Elder Scribes', 'MS', '2027-01-12'],
  ], 'newest raid first; the award before the trial, someone else\'s and the disenchant are not hers');
  assert.deepEqual([r.json.loot.total, r.json.loot.ms, r.json.loot.os, r.json.loot.de, r.json.loot.bank], [3, 1, 1, 0, 1]);
  assert.deepEqual(r.json.loot.items[0], { itemId: r.json.loot.items[0].itemId, itemName: 'Spellfire Belt', tag: 'OS', raidOn: '2027-01-15' });
  assert.equal(r.json.notes.excerpt, '');
  assert.equal(r.json.notes.truncated, false);
});

check('trial review: who may open it (roster.edit on the home team), a missing person, and the since-date fallbacks', async () => {
  const s = await trialWorld();
  for (const who of ['alice', 'bob', 'carol']) assert.equal((await s.trial(who)).status, 200, who);
  for (const who of ['dave', 'erin', 'gina']) {
    const r = await s.trial(who);
    assert.equal(r.status, 403, who);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal((await s.w.call({}, 'GET', `${s.base}/roster/${s.p.Veyla}/trial`)).status, 401);
  assert.equal((await s.trial('bob', 'p_aaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  assert.equal((await s.trial('bob', 'nonsense')).status, 404);
  // A person who is no longer a trial still answers (the card is the page's choice).
  const made = (await s.call('bob', 'GET', `/roster/${s.p.Veyla}`)).json.person;
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.Veyla}`, { expectedVersion: made.version, status: 'raider' })).status, 200);
  const raider = await s.trial();
  assert.equal(raider.json.person.status, 'raider');
  assert.equal(raider.json.person.trialFlag, null);
  // No trial start: the join date. Neither: the whole history.
  s.w.exec(`UPDATE players SET trial_start = NULL WHERE id = '${s.p.Veyla}'`);
  assert.equal((await s.trial()).json.since, '2027-01-05');
  s.w.exec(`UPDATE players SET joined_on = NULL WHERE id = '${s.p.Veyla}'`);
  const all = await s.trial();
  assert.equal(all.json.since, null);
  assert.equal(all.json.attendance.raids, 5, 'every raid counts when there is no start');
  assert.equal(all.json.loot.total, 4);
});

check('trial review: the notes excerpt is the first 300 characters at a word end; the other blocks do not depend on it', async () => {
  const s = await trialWorld();
  const short = 'Great attitude, needs to bring flasks.';
  let saved = await s.call('bob', 'PUT', `/roster/${s.p.Veyla}/notes`, { text: short, expectedNotesVersion: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  let r = await s.trial('carol');
  assert.deepEqual(r.json.notes, { excerpt: short, truncated: false });
  const long = `${'word '.repeat(120)}end`;
  saved = await s.call('bob', 'PUT', `/roster/${s.p.Veyla}/notes`, { text: long, expectedNotesVersion: 1 });
  assert.equal(saved.status, 200);
  r = await s.trial();
  assert.equal(r.json.notes.truncated, true);
  assert(r.json.notes.excerpt.length <= 300 && r.json.notes.excerpt.length >= 260, String(r.json.notes.excerpt.length));
  assert(/word$/.test(r.json.notes.excerpt), 'cut at a word end');
  assert.equal(r.json.attendance.raids, 4);
  const { excerptOf } = await load('worker/routes/trial.js');
  assert.deepEqual(excerptOf(null), { excerpt: '', truncated: false });
  assert.deepEqual(excerptOf(`${'x'.repeat(400)}`), { excerpt: 'x'.repeat(300), truncated: true }, 'no space to cut at: cut at 300');
});

// ===========================================================================
// ROUTES: the calendar feed (GET/POST/DELETE /calendar, GET /cal/<token>.ics)

// Reads an ICS body the way a calendar app would: unfold, split, collect the VEVENTs' properties (text unescaped). Fails on anything malformed.
function parseIcs(text) {
  assert(text.endsWith('\r\n'), 'ends with CRLF');
  assert(!/(^|[^\r])\n/.test(text), 'every line break is CRLF');
  for (const physical of text.split('\r\n')) assert(Buffer.byteLength(physical, 'utf8') <= 75, `a physical line over 75 octets: ${physical.slice(0, 40)}`);
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
  const unescape = (value) => value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const calendar = {};
  const events = [];
  let current = null;
  for (const line of lines.slice(1, -1)) {
    if (line === 'BEGIN:VEVENT') { assert.equal(current, null, 'no nested VEVENT'); current = {}; continue; }
    if (line === 'END:VEVENT') { events.push(current); current = null; continue; }
    const colon = line.indexOf(':');
    assert(colon > 0, `a content line: ${line}`);
    const name = line.slice(0, colon).split(';')[0];
    (current || calendar)[name] = unescape(line.slice(colon + 1));
  }
  assert.equal(current, null, 'VEVENTs are closed');
  for (const event of events) {
    for (const required of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY']) assert(required in event, `${required} in ${JSON.stringify(event)}`);
    for (const key of ['DTSTAMP', 'DTSTART', 'DTEND']) assert(/^\d{8}T\d{6}Z$/.test(event[key]), `${key} is UTC: ${event[key]}`);
    assert(event.DTEND > event.DTSTART, 'the end is after the start');
  }
  assert.equal(new Set(events.map((e) => e.UID)).size, events.length, 'UIDs are unique');
  return { calendar, events };
}

const FEED_PATH = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/;
const utc = (text) => text.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

async function calWorld() {
  const s = await scenario();
  await addPerson(s, 'bob', s.A, 'Eliora', { class: 'PRIEST', mainSpec: 'Holy' });
  await addPerson(s, 'bob', s.A, 'Mirabel', { class: 'HUNTER', mainSpec: 'Marksmanship' });
  await addPerson(s, 'bob', s.A, 'Kaelith', { class: 'ROGUE', mainSpec: 'Combat' });
  s.w.exec(`UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.Eliora}'`);
  const raid = (teamId, raidOn, extra = {}) => addRaid(s, teamId, raidOn, { startTime: '20:00', ...extra });
  s.raid = {
    old: await raid(s.A, '2026-12-16'),                                  // 2026-12-17T01:00Z, a little over 30 days before NOW: left out
    past: await raid(s.A, '2026-12-18', { zone: 'Karazhan' }),           // 2026-12-19T01:00Z
    recent: await raid(s.A, '2027-01-15'),                               // 2027-01-16T01:00Z
    soon: await raid(s.A, '2027-01-18', { zone: 'Black Temple', title: 'Night 3, "bring flasks"; be on time' }), // 2027-01-19T01:00Z
    far: await raid(s.A, '2027-03-15'),                                  // 2027-03-16T00:00Z (daylight time): inside 60 days
    beyond: await raid(s.A, '2027-03-20'),                               // outside
    other: await raid(s.B, '2027-01-18'),                                // another team
  };
  const signup = (raidId, id, playerId, kind, source = 'raid_helper') => s.w.exec(
    `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${raidId}', '${source}', ${id}, '${kind}', ${id}, '${s.guildId}', ${playerId ? `'${playerId}'` : 'NULL'})`,
  );
  signup(s.raid.soon, 1, s.p.Mirabel, 'signed');
  signup(s.raid.soon, 2, s.p.Kaelith, 'signed');
  signup(s.raid.soon, 3, s.p.Eliora, 'signed');          // replaced by Eliora's own Late below
  signup(s.raid.soon, 4, null, 'bench');
  assert.equal((await s.call('erin', 'PUT', `/raids/${s.raid.soon}/signup`, { kind: 'late' })).status, 200);
  s.create = async (who = 'erin', teamId = s.A) => {
    const r = await s.call(who, 'POST', '/calendar', { teamId });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  s.feed = (url, opts = {}) => s.w.req('GET', new URL(url).pathname, opts);
  s.fetchIcs = async (url) => {
    const r = await s.feed(url);
    assert.equal(r.status, 200, `feed ${r.status}`);
    return parseIcs(await r.text());
  };
  return s;
}

check('calendar: make, replace and turn off a link - one per person per team, the URL only in the answer that made it, only a hash is stored', async () => {
  const s = await calWorld();
  let status = await s.call('erin', 'GET', `/calendar?team=${s.A}`);
  assert.deepEqual(status.json, { team: { id: s.A, name: 'Alpha' }, subscribed: false, createdAt: null, lastUsedAt: null });
  s.w.advance(5000);
  const made = await s.create();
  assert.deepEqual(made.team, { id: s.A, name: 'Alpha' });
  assert.deepEqual([made.subscribed, made.createdAt, made.lastUsedAt], [true, NOW + 5000, null]);
  const token = FEED_PATH.exec(new URL(made.url).pathname)[1];
  assert.equal(made.url, `${ORIGIN}/cal/${token}.ics`);
  assert.equal(made.webcalUrl, `webcal://raidsmith.test/cal/${token}.ics`);
  status = await s.call('erin', 'GET', `/calendar?team=${s.A}`);
  assert.deepEqual(status.json, { team: { id: s.A, name: 'Alpha' }, subscribed: true, createdAt: NOW + 5000, lastUsedAt: null });
  assert(!JSON.stringify(status.json).includes(token), 'the status never carries the link');
  // Stored hashed: the table holds the SHA-256 and the token is in no column of any table.
  const rows = await s.w.rows('SELECT * FROM calendar_tokens');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].token_hash, rows[0].guild_id, rows[0].team_id, rows[0].user_id, rows[0].last_used_at], [sha256(token), s.guildId, s.A, s.ids.erin, null]);
  assert(/^ct_[A-Za-z0-9_-]{22}$/.test(rows[0].id));
  for (const table of ['calendar_tokens', 'sessions', 'audit_log', 'users', 'rate_limits']) {
    assert(!JSON.stringify(await s.w.rows(`SELECT * FROM ${table}`)).includes(token), `${table} does not hold the token`);
  }
  assert.equal((await s.feed(made.url)).status, 200);

  // Replacing: the old link stops at once, the new one works, still one row for this person and team.
  s.w.advance(1000);
  const second = await s.create();
  assert.notEqual(second.url, made.url);
  assert.equal((await s.feed(made.url)).status, 404);
  assert.equal((await s.feed(second.url)).status, 200);
  assert.equal(await s.w.count('calendar_tokens', 'user_id = ? AND team_id = ?', s.ids.erin, s.A), 1);
  // A second team, a second person: independent links.
  const teamB = await s.create('erin', s.B);
  const gina = await s.create('gina', s.A);
  assert.equal(await s.w.count('calendar_tokens'), 3);
  assert.equal((await s.call('erin', 'DELETE', '/calendar', { teamId: s.A })).json.subscribed, false);
  assert.equal((await s.feed(second.url)).status, 404, 'turned off');
  assert.equal((await s.feed(teamB.url)).status, 200);
  assert.equal((await s.feed(gina.url)).status, 200);
  assert.deepEqual((await s.call('erin', 'GET', `/calendar?team=${s.A}`)).json.subscribed, false);
  const again = await s.call('erin', 'DELETE', '/calendar', { teamId: s.A });
  assert.deepEqual([again.status, again.json.subscribed], [200, false], 'turning off twice is fine');
  assert.equal(await s.w.count('calendar_tokens'), 2);
});

check('calendar: the management routes - sign-in, team and guild checks', async () => {
  const s = await calWorld();
  for (const [method, route, body] of [['GET', `/calendar?team=${s.A}`], ['POST', '/calendar', { teamId: s.A }], ['DELETE', '/calendar', { teamId: s.A }]]) {
    assert.equal((await s.w.call({}, method, `${s.base}${route}`, body)).status, 401, `${method} signed out`);
  }
  const bad = async (method, route, body, field) => {
    const r = await s.call('erin', method, route, body);
    assert.equal(r.status, 400, `${method} ${route} ${JSON.stringify(body)}`);
    assert.equal(r.json.field, field);
  };
  await bad('GET', '/calendar', undefined, 'team');
  await bad('GET', '/calendar?team=nope', undefined, 'team');
  await bad('GET', '/calendar?team=t_aaaaaaaaaaaaaaaaaaaaaa', undefined, 'team');
  await bad('POST', '/calendar', {}, 'team');
  await bad('POST', '/calendar', { teamId: 't_aaaaaaaaaaaaaaaaaaaaaa' }, 'team');
  await bad('DELETE', '/calendar', { teamId: 5 }, 'team');
  // Everyone in the guild sees the raids of every team (raids.view is a Member right), so anyone may subscribe to either team.
  for (const who of ['gina', 'dave', 'bob', 'alice', 'carol']) assert.equal((await s.call(who, 'POST', '/calendar', { teamId: s.B })).status, 201, who);
  assert.equal((await s.call('erin', 'GET', `/calendar?team=${s.A}`, undefined)).status, 200);
  // Another guild's team is not found here, even with a real id.
  const jar = await signIn(s.w, PEOPLE.alice, [manageable(SERVER_A), manageable('900000000000000002')]);
  const second = await s.w.call(jar, 'POST', '/api/guild', { ...GUILD_BODY, serverId: '900000000000000002', multipleTeams: false, name: 'Other Guild' });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  const foreign = second.json.teams[0].id;
  await bad('POST', '/calendar', { teamId: foreign }, 'team');
  await bad('GET', `/calendar?team=${foreign}`, undefined, 'team');
  assert.equal(await s.w.count('calendar_tokens', 'team_id = ?', foreign), 0);
});

check('calendar: the feed - the team\'s raids from 30 days back to 60 ahead, escaped and folded, counts and the viewer\'s own sign-up', async () => {
  const s = await calWorld();
  const made = await s.create();
  const r = await s.feed(made.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  assert.equal(r.headers.get('Cache-Control'), 'private, max-age=900');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
  assert(/noindex/.test(r.headers.get('X-Robots-Tag')));
  assert(/^inline/.test(r.headers.get('Content-Disposition')));
  assert.equal(r.headers.get('Set-Cookie'), null, 'a feed fetch sets nothing');
  const text = await r.text();
  const { calendar, events } = parseIcs(text);
  assert.equal(calendar.VERSION, '2.0');
  assert.equal(calendar.METHOD, 'PUBLISH');
  assert.equal(calendar['X-WR-CALNAME'], 'Ember Guard - Alpha');
  assert.deepEqual(events.map((e) => e.UID), [`${s.raid.past}@raidsmith`, `${s.raid.recent}@raidsmith`, `${s.raid.soon}@raidsmith`, `${s.raid.far}@raidsmith`], 'soonest first; the old one, the one beyond 60 days and the other team\'s are out');
  const byRaid = Object.fromEntries(Object.entries(s.raid).map(([key, id]) => [key, events.find((e) => e.UID === `${id}@raidsmith`)]));
  assert.deepEqual([byRaid.past.DTSTART, byRaid.past.DTEND], ['20261219T010000Z', '20261219T040000Z'], 'start in UTC, end three hours later when no log says otherwise');
  assert.equal(byRaid.far.DTSTART, '20270316T000000Z', 'a date in daylight time is UTC-4');
  assert.equal(byRaid.past.SUMMARY, 'Karazhan', 'no title: the zone');
  assert.equal(byRaid.recent.SUMMARY, 'Raid', 'neither: plain Raid');
  assert.equal(byRaid.soon.SUMMARY, 'Night 3, "bring flasks"; be on time', 'escaped on the wire, plain after reading');
  assert(text.includes('SUMMARY:Night 3\\, "bring flasks"\\; be on time'), 'comma and semicolon are escaped in the file');
  assert.equal(byRaid.soon.URL, `${ORIGIN}/#/g/${s.guildId}/raids/r/${s.raid.soon}`);
  // Erin: counts of the merged list (her Late replaces her Raid-Helper Signed) and her own sign-up, then the page address.
  assert.equal(byRaid.soon.DESCRIPTION, `Signed 2, Late 1, Bench 1\nYour sign-up: Late\n${byRaid.soon.URL}`);
  assert.equal(byRaid.far.DESCRIPTION.split('\n')[0], 'No sign-ups yet');
  assert.equal(byRaid.far.DESCRIPTION.split('\n')[1], 'Your sign-up: not yet', 'an open raid she has not answered');
  assert(!byRaid.past.DESCRIPTION.includes('Your sign-up'), 'nothing to ask about a raid that is over');
  // The same link for an officer-level viewer: counts, no personal lines.
  const bob = await s.create('bob');
  const bobEvents = (await s.fetchIcs(bob.url)).events;
  assert.equal(bobEvents.find((e) => e.UID === `${s.raid.soon}@raidsmith`).DESCRIPTION, `Signed 2, Late 1, Bench 1\n${byRaid.soon.URL}`);
  // A member with no character on the team sees the raids but not the sign-up counts (attendance.view is own-teams for members).
  const gina = await s.create('gina');
  const ginaSoon = (await s.fetchIcs(gina.url)).events.find((e) => e.UID === `${s.raid.soon}@raidsmith`);
  assert.equal(ginaSoon.DESCRIPTION, byRaid.soon.URL);
  assert.equal(ginaSoon.SUMMARY, byRaid.soon.SUMMARY);
});

check('calendar: a raid with a log ends when its last pull ended (if plausible); a long folded line stays valid', async () => {
  const s = await calWorld();
  const addLog = (raidId, code, endOffsetMs) => {
    const startedAt = Date.parse('2026-12-19T01:00:00Z');
    s.w.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${raidId}', '${s.guildId}', '${code}', 'fresh', ${startedAt}, ${NOW})`);
    s.w.exec(`INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES ('${raidId}', '${code}', 1, 649, 'High King Maulgar', 1, ${startedAt + 600000}, ${startedAt + endOffsetMs})`);
  };
  addLog(s.raid.past, 'Aaaa000000000001', 4.5 * 3600000);
  addLog(s.raid.recent, 'Aaaa000000000002', 40 * 3600000);
  const made = await s.create();
  const { events } = await s.fetchIcs(made.url);
  const of = (id) => events.find((e) => e.UID === `${id}@raidsmith`);
  assert.equal(of(s.raid.past).DTEND, '20261219T053000Z', 'the last boss pull ended 4.5 hours after the start');
  assert.equal(of(s.raid.recent).DTEND, '20270116T040000Z', 'a pull 40 hours out is not believed: start + 3 hours');
  // A title near the 100-character limit with multi-byte characters folds without breaking one.
  s.w.exec(`UPDATE raids SET title = '${'Caf\u00e9 night '.repeat(7)}' WHERE id = '${s.raid.soon}'`);
  const text = await (await s.feed(made.url)).text();
  assert(text.split('\r\n').some((line) => line.startsWith(' ')), 'the long summary was folded');
  const reread = parseIcs(text);
  assert.equal(reread.events.find((e) => e.UID === `${s.raid.soon}@raidsmith`).SUMMARY, 'Caf\u00e9 night '.repeat(7), 'unfolded and unescaped, every character whole');
});

check('calendar: every fetch re-checks the person - blocked, out of the Discord server, deleted account, turned off: all the same plain 404', async () => {
  const s = await calWorld();
  const made = await s.create();
  assert.equal((await s.feed(made.url)).status, 200);
  // Blocked by an officer, then restored.
  assert.equal((await s.call('alice', 'POST', `/people/${s.ids.erin}/block`, { reason: 'test' })).status, 200);
  const blocked = await s.feed(made.url);
  assert.equal(blocked.status, 404);
  assert.equal((await s.call('alice', 'DELETE', `/people/${s.ids.erin}/block`, {})).status, 200);
  assert.equal((await s.feed(made.url)).status, 200, 'restored: the same link works again');
  // No longer in the guild's Discord server.
  s.w.exec(`DELETE FROM user_servers WHERE user_id = '${s.ids.erin}'`);
  assert.equal((await s.feed(made.url)).status, 404);
  s.w.exec(`INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('${s.ids.erin}', '${SERVER_A}', ${NOW})`);
  assert.equal((await s.feed(made.url)).status, 200);
  // The same body for every kind of "no".
  const unknown = await s.feed(`${ORIGIN}/cal/${'A'.repeat(43)}.ics`);
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), await blocked.text());
  // An archived team still serves (its raids exist).
  s.w.exec(`UPDATE teams SET archived = 1 WHERE id = '${s.A}'`);
  assert.equal((await s.feed(made.url)).status, 200);
  s.w.exec(`UPDATE teams SET archived = 0 WHERE id = '${s.A}'`);
  // Delete my data: the account goes and its links with it.
  assert.equal(await s.w.count('calendar_tokens', 'user_id = ?', s.ids.erin), 1);
  const gone = await s.w.call(s.jars.erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(await s.w.count('calendar_tokens', 'user_id = ?', s.ids.erin), 0, 'Delete my data deletes the links');
  assert.equal((await s.feed(made.url)).status, 404);
});

check('calendar: a Battle.net-only account has a working feed once an officer links it to a person - the person is found through the account link, and unlinking ends the feed', async () => {
  const s = await scenario({ bnet: true });
  try {
    await addPerson(s, 'bob', s.A, 'Holly', { class: 'MAGE', mainSpec: 'Fire' });
    await addPerson(s, 'bob', s.A, 'Ivan', { class: 'ROGUE', mainSpec: 'Combat' });
    const raid = await addRaid(s, s.A, '2027-01-18', { startTime: '20:00', zone: 'Karazhan' });
    const signup = (id, playerId, kind) => s.w.exec(
      `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${raid}', 'raid_helper', ${id}, '${kind}', ${id}, '${s.guildId}', '${playerId}')`,
    );
    signup(1, s.p.Holly, 'late');
    signup(2, s.p.Ivan, 'signed');

    // Holly signs up with Battle.net only: no Discord ID, not in the Discord server.
    s.jars.holly = await bnetSignIn(s.w, { id: '700000001', battletag: 'Holly#1111' });
    s.ids.holly = (await s.w.call(s.jars.holly, 'GET', '/auth/me')).json.user.id;
    const account = (await s.w.rows('SELECT discord_id FROM users WHERE id = ?', s.ids.holly))[0];
    assert.equal(account.discord_id, null, 'a Battle.net-only account');
    assert.equal(await s.w.count('user_servers', 'user_id = ?', s.ids.holly), 0);

    // Unlinked: she is no member, so she cannot make a link, and a link row that exists for her (planted here) is the same plain 404 as any other.
    const refused = await s.call('holly', 'POST', '/calendar', { teamId: s.A });
    assert.deepEqual([refused.status, refused.json.error], [403, 'not_member']);
    const token = 'H'.repeat(43);
    s.w.exec(`INSERT INTO calendar_tokens (id, token_hash, guild_id, team_id, user_id, created_at) VALUES ('ct_hhhhhhhhhhhhhhhhhhhhhh', '${sha256(token)}', '${s.guildId}', '${s.A}', '${s.ids.holly}', 1)`);
    const planted = `${ORIGIN}/cal/${token}.ics`;
    const feed = (url) => s.w.req('GET', new URL(url).pathname);
    assert.equal((await feed(planted)).status, 404, 'not linked: no feed');

    // An officer links the account to Holly's person: now she is a member, and "me" is the linked person.
    const linked = await s.call('bob', 'PUT', `/roster/${s.p.Holly}/account`, { userId: s.ids.holly });
    assert.equal(linked.status, 200, JSON.stringify(linked.json));
    assert.equal((await feed(planted)).status, 200, 'linked: the same link works');
    const made = await s.call('holly', 'POST', '/calendar', { teamId: s.A });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const response = await feed(made.json.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
    const text = await response.text();
    const { events } = parseIcs(text);
    assert.deepEqual(events.map((e) => e.UID), [raid + '@raidsmith'], 'the team raid and nothing else');
    assert.equal(events[0].SUMMARY, 'Karazhan');
    assert(events[0].DESCRIPTION.startsWith('Signed 1, Late 1\nYour sign-up: Late\n'), 'her own sign-up is found through the account link, not a Discord ID: ' + events[0].DESCRIPTION);
    assert(!events[0].DESCRIPTION.includes('Your sign-up: Signed'), 'not the other person\'s');

    // Unlinked again: the account loses the guild, and the feed with it.
    assert.equal((await s.call('bob', 'PUT', `/roster/${s.p.Holly}/account`, { userId: null })).status, 200);
    assert.equal((await feed(made.json.url)).status, 404, 'unlinked: no feed');
    assert.equal((await feed(planted)).status, 404);
    assert.equal((await s.call('holly', 'GET', `/calendar?team=${s.A}`)).status, 403);
  } finally {
    await s.w.close();
  }
});

check('calendar: a malformed or unknown feed address is a 404 and reads nothing for the wrong shape', async () => {
  const s = await calWorld();
  const made = await s.create();
  const token = FEED_PATH.exec(new URL(made.url).pathname)[1];
  for (const path of [
    `/cal/${token.slice(1)}.ics`, `/cal/${token}x.ics`, `/cal/${token}.ICS`, `/cal/${token}`, `/cal/${token}.ics.txt`, `/cal/${token}.ics/`, '/cal/', '/cal', '/cal/.ics',
    `/cal/${token.slice(0, 42)}!.ics`, `/cal/${'A'.repeat(43)}.ics`, `/cal/..%2F${token}.ics`,
  ]) {
    const r = await s.w.req('GET', path);
    assert.equal(r.status, 404, path);
  }
  const shapeOnly = await counted(s.w, () => s.w.req('GET', `/cal/${token.slice(1)}.ics`));
  assert.equal(shapeOnly, 0, 'a wrong shape reads nothing');
  // Only GET reads the feed.
  assert.equal((await s.w.req('POST', `/cal/${token}.ics`, { body: {} })).status, 405);
  assert.equal((await s.w.req('DELETE', `/cal/${token}.ics`, { body: {} })).status, 405);
});

check('calendar: last use is stamped (at most every ten minutes) and a feed fetch is four or five D1 calls', async () => {
  const s = await calWorld();
  const made = await s.create();
  assert.equal(await counted(s.w, () => s.feed(made.url)), 5, 'link, guild context, who the viewer is, rows, last-used stamp');
  assert.equal((await s.call('erin', 'GET', `/calendar?team=${s.A}`)).json.lastUsedAt, NOW);
  s.w.advance(5 * 60000);
  assert.equal(await counted(s.w, () => s.feed(made.url)), 4, 'inside ten minutes there is no write');
  assert.equal((await s.call('erin', 'GET', `/calendar?team=${s.A}`)).json.lastUsedAt, NOW);
  s.w.advance(6 * 60000);
  await s.feed(made.url);
  assert.equal((await s.call('erin', 'GET', `/calendar?team=${s.A}`)).json.lastUsedAt, NOW + 11 * 60000);
});

// ===========================================================================
// ROUTE: GET /attention (Needs attention)

// One of everything. Today is Saturday 2027-01-16, 07:00 in New York.
//  Alpha: Kaelith has slipped (the Tuesday raids), raid 01-13 has 3 open flags, raid 01-14 has loot (one winner on no roster), raid 01-15 has a
//         log and no loot (Alpha has imported loot before), raid 12-30 would too but is over two weeks old, raid 01-11 has no log. Veyla's trial
//         ends in 3 days, Later's in 10. Upcoming: today 07:30 (30 minutes), and Tuesday 01-19 with four sign-ups, two of them nobody on the roster.
//  Bravo: raid 01-12 has 1 open flag, Tanis's trial ended 2 days ago, a raid tomorrow evening has no sign-ups; Bravo never imported loot.
//  Guild: one character claim is waiting.
async function attentionWorld() {
  const s = await scenario();
  for (const [name, status, extra] of [['Thoren', 'raider', {}], ['Kaelith', 'raider', {}], ['Veyla', 'trial', { joinedOn: '2026-12-20', trialEnd: '2027-01-19' }], ['Later', 'trial', { joinedOn: '2027-01-02', trialEnd: '2027-01-26' }]]) {
    await addPerson(s, 'bob', s.A, name, { status, joinedOn: '2026-09-01', ...extra });
  }
  for (const [name, status, extra] of [['Dorrin', 'raider', {}], ['Tanis', 'trial', { joinedOn: '2026-12-20', trialEnd: '2027-01-14' }]]) {
    await addPerson(s, 'bob', s.B, name, { status, joinedOn: '2026-09-01', ...extra });
  }
  // Watch list: sixteen Tuesdays; Thoren is perfect, Kaelith came to one of the last eight.
  for (let i = 0; i < TUESDAYS.length; i++) {
    const raidId = await addRaid(s, s.A, TUESDAYS[i]);
    attend(s, raidId, s.A, s.p.Thoren, 'present', 1);
    const came = i < 8 || i === 8;
    attend(s, raidId, s.A, s.p.Kaelith, came ? 'present' : 'missed', came ? 1 : 0);
  }
  const manual = async (raidId) => assert.equal((await s.call('bob', 'PUT', `/raids/${raidId}/manual`, { reason: 'No log kept', presentPlayerIds: [s.p.Thoren] })).status, 200);
  s.r = {
    flag: await addRaid(s, s.A, '2027-01-13'),
    loot: await addRaid(s, s.A, '2027-01-14'),
    noLoot: await addRaid(s, s.A, '2027-01-15'),
    old: await addRaid(s, s.A, '2026-12-30'),
    noLog: await addRaid(s, s.A, '2027-01-11'),
    bravoFlag: await addRaid(s, s.B, '2027-01-12'),
    bravoNoLoot: await addRaid(s, s.B, '2027-01-15'),
    unlocked: await addRaid(s, s.A, TODAY, { startTime: '07:30' }),
    soon: await addRaid(s, s.A, '2027-01-19', { startTime: '20:00' }),
    beyond: await addRaid(s, s.A, '2027-01-30', { startTime: '20:00' }),
    bravoSoon: await addRaid(s, s.B, '2027-01-17', { startTime: '18:00' }),
  };
  for (const key of ['loot', 'noLoot', 'old']) await manual(s.r[key]);
  await manual(s.r.bravoNoLoot);
  s.w.exec(`UPDATE raids SET open_flags = 3 WHERE id = '${s.r.flag}'`);
  s.w.exec(`UPDATE raids SET open_flags = 1 WHERE id = '${s.r.bravoFlag}'`);
  const realmKey = (await s.w.rows('SELECT realm_key FROM characters WHERE player_id = ?', s.p.Thoren))[0].realm_key;
  let n = 0;
  const award = (raidId, teamId, winner) => {
    n++;
    s.w.db.prepare(
      `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MS', ?, ?)`,
    ).bind(`lo_${String(n).padStart(22, 'y')}`, s.guildId, raidId, teamId, `attn${String(n).padStart(6, '0')}`, 40000 + n, `Item ${n}`, NOW, winner, winner.toLowerCase(), realmKey, NOW, NOW).run();
  };
  award(s.r.loot, s.A, 'Thoren');
  award(s.r.loot, s.A, 'Stranger');
  award(s.r.loot, s.A, 'Stranger');
  const signup = (raidId, id, playerId, kind) => s.w.exec(
    `INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${raidId}', 'raid_helper', ${id}, '${kind}', ${id}, '${s.guildId}', ${playerId ? `'${playerId}'` : 'NULL'})`,
  );
  signup(s.r.soon, 1, s.p.Thoren, 'signed');
  signup(s.r.soon, 2, s.p.Kaelith, 'late');
  signup(s.r.soon, 3, null, 'signed');
  signup(s.r.soon, 4, null, 'tentative');
  signup(s.r.soon, 5, null, 'absence');   // an absence from nobody on the roster is nothing to link
  s.w.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
            VALUES ('cl_${'z'.repeat(22)}', '${s.guildId}', '${s.ids.erin}', 'Mirabel', 'mirabel', 'Nightslayer', '${realmKey}', 'HUNTER', 70, 'pending', ${NOW})`);
  s.attention = (who = 'alice') => s.call(who, 'GET', '/attention');
  s.ids2 = (r) => r.json.items.map((item) => item.id);
  return s;
}

check('attention: every kind of open work for the Guild Master - fields, links, order, and the count that leaves out information', async () => {
  const s = await attentionWorld();
  const r = await s.attention();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.today, TODAY);
  const id = (kind, key) => (kind === 'claims' ? 'claims' : `${kind}:${key}`);
  assert.deepEqual(r.json.items.map((i) => i.id), [
    id('review', s.r.flag), id('review', s.r.bravoFlag),
    id('loot_unmatched', s.r.loot),
    id('signup_unmatched', s.r.soon),
    'claims',
    id('trial', s.p.Tanis), id('trial', s.p.Veyla),
    id('no_loot', s.r.noLoot),
    id('low_signups', s.r.unlocked), id('low_signups', s.r.bravoSoon), id('low_signups', s.r.soon),
    id('unlocked', s.r.unlocked),
  ]);
  assert.deepEqual(r.json.more, {});
  assert.equal(r.json.total, 8, 'eight open to-dos: the readiness facts (low sign-ups, unlocked) and the watch list are not counted');
  assert.deepEqual(r.json.counts[s.A], { watchOpen: 1, rankOpen: 0 }, 'the watch list is counted per team, not listed');
  assert.deepEqual(r.json.hidden, []);
  assert.ok(r.json.items.filter((i) => ['low_signups', 'unlocked'].includes(i.kind)).every((i) => i.readiness === true));
  const item = (key) => r.json.items.find((i) => i.id === key);
  assert.deepEqual(item(id('review', s.r.flag)), {
    kind: 'review', severity: 'action', teamId: s.A, teamName: 'Alpha', raidId: s.r.flag, date: '2027-01-13', zone: null, title: null, count: 3,
    id: id('review', s.r.flag), link: { name: 'raid', rid: s.r.flag },
  });
  assert.deepEqual(item(id('loot_unmatched', s.r.loot)).count, 1, 'one name, however many awards');
  assert.deepEqual(item(id('loot_unmatched', s.r.loot)).link, { name: 'review' });
  assert.deepEqual([item(id('signup_unmatched', s.r.soon)).count, item(id('signup_unmatched', s.r.soon)).link], [2, { name: 'raid', rid: s.r.soon, focus: 'signups-unmatched' }], 'two unmatched sign-ups; the absence and the roster people do not count');
  assert.deepEqual(item('claims'), { kind: 'claims', severity: 'action', teamId: null, teamName: null, count: 1, id: 'claims', link: { name: 'review' } });
  assert.deepEqual(
    [item(id('trial', s.p.Tanis)).days, item(id('trial', s.p.Tanis)).ended, item(id('trial', s.p.Tanis)).name, item(id('trial', s.p.Tanis)).teamName, item(id('trial', s.p.Tanis)).trialEnd],
    [-2, true, 'Tanis', 'Bravo', '2027-01-14'],
  );
  assert.deepEqual(item(id('trial', s.p.Veyla)).link, { name: 'person', pid: s.p.Veyla });
  assert(!r.json.items.some((i) => i.personId === s.p.Later), 'a trial ending in 10 days is not yet');
  assert.equal(item(`watch:${s.A}:${s.p.Kaelith}`), undefined, 'the watch list left Home');
  assert.deepEqual([item(id('no_loot', s.r.noLoot)).date, item(id('no_loot', s.r.noLoot)).teamName], ['2027-01-15', 'Alpha']);
  const ids = r.json.items.map((i) => i.id);
  for (const left of [s.r.old, s.r.noLog, s.r.loot]) assert(!ids.includes(id('no_loot', left)), 'no_loot leaves out an old raid, a raid with no log and one with loot');
  assert(!ids.includes(id('no_loot', s.r.bravoNoLoot)), 'Bravo never imported loot');
  assert(!ids.includes(id('low_signups', s.r.beyond)), 'beyond the next 7 days');
  const unlocked = item(id('unlocked', s.r.unlocked));
  assert.deepEqual([unlocked.severity, unlocked.minutes, unlocked.teamName], ['info', 30, 'Alpha']);
  const low = item(id('low_signups', s.r.soon));
  assert.deepEqual([low.expected, low.size, low.date, low.startsAt], [3, 25, '2027-01-19', Date.parse('2027-01-20T01:00:00Z')], 'signed + late, the unmatched sign-up included (the tentative one is not)');
  assert.deepEqual(item(id('low_signups', s.r.unlocked)).expected, 0);
  // Same for an Officer (guild-wide rights).
  assert.deepEqual(s.ids2(await s.attention('bob')), s.ids2(r));
});

check('attention: each viewer sees the teams they hold the matching right for; members are refused', async () => {
  const s = await attentionWorld();
  const id = (kind, key) => `${kind}:${key}`;
  const carol = await s.attention('carol');
  assert.deepEqual(carol.json.items.map((i) => i.id), [
    id('review', s.r.flag), id('loot_unmatched', s.r.loot), id('signup_unmatched', s.r.soon), 'claims', id('trial', s.p.Veyla),
    id('no_loot', s.r.noLoot), id('low_signups', s.r.unlocked), id('low_signups', s.r.soon), id('unlocked', s.r.unlocked),
  ], 'Alpha only');
  assert.equal(carol.json.total, 6);
  const dave = await s.attention('dave');
  assert.deepEqual(dave.json.items.map((i) => i.id), [id('review', s.r.bravoFlag), 'claims', id('trial', s.p.Tanis), id('low_signups', s.r.bravoSoon)], 'Bravo only (the claim is the guild\'s)');
  assert.equal(dave.json.total, 3);
  for (const who of ['erin', 'gina']) {
    const r = await s.attention(who);
    assert.equal(r.status, 403, who);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal((await s.w.call({}, 'GET', `${s.base}/attention`)).status, 401);
  assert.equal((await s.w.call(s.jars.alice, 'GET', '/api/guild/g_aaaaaaaaaaaaaaaaaaaaaa/attention')).status, 404);
});

check('attention: nothing open is an empty list; archived teams and information-only lists do not count', async () => {
  const s = await scenario();
  const empty = await s.call('alice', 'GET', '/attention');
  assert.deepEqual([empty.status, empty.json.items, empty.json.more, empty.json.total, empty.json.today], [200, [], {}, 0, TODAY]);
  // Only an information item: listed, total 0.
  await addPerson(s, 'bob', s.A, 'Thoren');
  const raidId = await addRaid(s, s.A, TODAY, { startTime: '07:30' });
  s.w.exec(`UPDATE teams SET size = 1 WHERE id = '${s.A}'`);
  s.w.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${raidId}', 'raid_helper', 1, 'signed', 1, '${s.guildId}', '${s.p.Thoren}')`);
  const info = await s.call('alice', 'GET', '/attention');
  assert.deepEqual(info.json.items.map((i) => [i.kind, i.severity]), [['unlocked', 'info']]);
  assert.equal(info.json.total, 0);
  // Locked: gone. Archived team: gone.
  s.w.exec(`UPDATE raids SET signups_locked = 1 WHERE id = '${raidId}'`);
  assert.deepEqual((await s.call('alice', 'GET', '/attention')).json.items, []);
  s.w.exec(`UPDATE raids SET signups_locked = 0 WHERE id = '${raidId}'`);
  s.w.exec(`UPDATE teams SET archived = 1 WHERE id = '${s.A}'`);
  assert.deepEqual((await s.call('alice', 'GET', '/attention')).json.items, []);
});

check('attention: boundaries - a trial ending in 7 days is listed and in 8 is not; a loot gap needs loot imported before; the 14-day edge', async () => {
  const s = await attentionWorld();
  await addPerson(s, 'bob', s.A, 'Edgeseven', { status: 'trial', joinedOn: '2027-01-01', trialEnd: '2027-01-23' });
  await addPerson(s, 'bob', s.A, 'Edgeeight', { status: 'trial', joinedOn: '2027-01-01', trialEnd: '2027-01-24' });
  let r = await s.attention();
  const trials = r.json.items.filter((i) => i.kind === 'trial').map((i) => [i.name, i.days]);
  assert.deepEqual(trials, [['Tanis', -2], ['Veyla', 3], ['Edgeseven', 7]]);
  // The raid on 2027-01-02 is exactly 14 days back: in. Move the old one (2026-12-30) there to see the edge, then one day further out.
  s.w.exec(`UPDATE raids SET raid_on = '2027-01-02' WHERE id = '${s.r.old}'`);
  assert(s.ids2(await s.attention()).includes(`no_loot:${s.r.old}`), 'exactly 14 days back is still listed');
  s.w.exec(`UPDATE raids SET raid_on = '2027-01-01' WHERE id = '${s.r.old}'`);
  assert(!s.ids2(await s.attention()).includes(`no_loot:${s.r.old}`), '15 days back is not');
  // Once a raid has loot it leaves the list; once the team has none at all, the whole kind is gone.
  s.w.exec(`DELETE FROM loot_awards`);
  r = await s.attention();
  assert(!r.json.items.some((i) => i.kind === 'no_loot' || i.kind === 'loot_unmatched'), 'a team that never imported loot is not asked to');
});

check('attention: at most ten of a kind, the rest counted in "more" and in the total; the list is read in one batch (four D1 calls)', async () => {
  const s = await scenario();
  for (let i = 0; i < 13; i++) {
    const raidId = await addRaid(s, s.A, `2027-01-${String(i + 1).padStart(2, '0')}`);
    s.w.exec(`UPDATE raids SET open_flags = ${i + 1} WHERE id = '${raidId}'`);
  }
  const r = await s.call('alice', 'GET', '/attention');
  assert.equal(r.json.items.length, 10);
  assert.deepEqual(r.json.more, { review: 3 });
  assert.equal(r.json.total, 13);
  assert.deepEqual(r.json.items.map((i) => i.date).slice(0, 2), ['2027-01-13', '2027-01-12'], 'newest first');
  const w = await attentionWorld();
  assert.equal(await counted(w.w, () => w.attention('alice')), 4, 'session, guild context, the teams, one batch for everything else');
  assert.equal(await counted(w.w, () => w.attention('carol')), 4);
});

// ===========================================================================
// SCHEMA: migration 0013

check('migration 0013: calendar_tokens - a hash of 64 characters, one per person per team, gone with the user, the team or the guild', async () => {
  const s = await calWorld();
  const columns = (await s.w.rows("SELECT name FROM pragma_table_info('calendar_tokens')")).map((r) => r.name);
  assert.deepEqual(columns, ['id', 'token_hash', 'guild_id', 'team_id', 'user_id', 'created_at', 'last_used_at']);
  const insert = (id, hash, team, user) => `INSERT INTO calendar_tokens (id, token_hash, guild_id, team_id, user_id, created_at) VALUES ('${id}', '${hash}', '${s.guildId}', '${team}', '${user}', 1)`;
  const hash = (c) => c.repeat(64);
  s.w.exec(insert('ct_a', hash('a'), s.A, s.ids.gina));
  assert.throws(() => s.w.exec(insert('ct_b', hash('b'), s.A, s.ids.gina)), /UNIQUE/, 'one per person per team');
  assert.throws(() => s.w.exec(insert('ct_c', hash('a'), s.B, s.ids.gina)), /UNIQUE/, 'a hash is unique');
  assert.throws(() => s.w.exec(insert('ct_d', 'short', s.B, s.ids.gina)), /CHECK/, 'a SHA-256 is 64 characters');
  assert.throws(() => s.w.exec(insert('ct_e', hash('e'), 't_aaaaaaaaaaaaaaaaaaaaaa', s.ids.gina)), /FOREIGN KEY/, 'the team is in the guild');
  s.w.exec(insert('ct_f', hash('f'), s.B, s.ids.gina));
  s.w.exec(`DELETE FROM users WHERE id = '${s.ids.gina}'`);
  assert.equal(await s.w.count('calendar_tokens', 'user_id = ?', s.ids.gina), 0, 'the account takes its links');
  s.w.exec(insert('ct_g', hash('g'), s.B, s.ids.erin));
  s.w.exec(`DELETE FROM guilds WHERE id = '${s.guildId}'`);
  assert.equal(await s.w.count('calendar_tokens'), 0, 'the guild takes its links');
  assert.equal(await s.w.count('calendar_tokens', 'id = ?', 'ct_g'), 0);
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
  process.exitCode = failed ? 1 : 0; // let the event loop drain: process.exit() while the fake Battle.net server closes trips a libuv assertion on Windows
}
main();
