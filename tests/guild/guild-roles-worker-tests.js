/**
 * Raidsmith guild tracker - Phase 7: Discord role mapping, the role editor, guest links and the public page, Worker tests
 * Run: node tests/guild/guild-roles-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs every migration, 0014_roles.sql included), with Discord faked by an
 * injected fetch that also answers the BOT calls (the server's roles, one member's roles). Covers: permission resolution with custom, Discord-given and
 * manual roles (pure), migration 0014 (also on a populated database), the role editor and its guards (built-in roles, the Guild Master, escalation),
 * the Discord mapping (sign-in, Sync now, Sync everyone, manual wins, fail-safe), guest links (hashed tokens, expiry, revoking, scope, a guest is
 * never an account and only reads), the public page (off by default, sections, the Public role as the ceiling, never a leak) and cross-guild
 * isolation of every new route. No network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');

const ROOT = require('path').join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';
const BOT_TOKEN = 'test-bot-token-0123456789';
const DAY = 24 * 60 * 60 * 1000;

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  gina: { id: '110000000000000006', username: 'gina', globalName: 'Gina G' },
  frank: { id: '110000000000000007', username: 'frank', globalName: 'Frank F' },
};
// The Discord roles of server A.
const D_OFFICERS = '700000000000000001';
const D_RAIDLEADS = '700000000000000002';
const D_LOOT = '700000000000000003';
const D_EXTRA = '700000000000000004';

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Discord: the OAuth calls of a sign-in, and the bot calls. servers: { [serverId]: { roles: [{ id, name, position, color, managed }], members: { [userId]: [roleIds] }, botIn } }
function makeDiscord() {
  const state = { next: null, tokens: new Map(), botCalls: [], servers: {}, outage: false, botToken: BOT_TOKEN, counter: 0 };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const auth = (init.headers && init.headers.Authorization) || '';
    if (/^Bot /.test(auth)) {
      state.botCalls.push({ path: u.pathname, auth, host: u.host });
      if (state.outage) return new Response('oops', { status: 500 });
      if (auth !== `Bot ${state.botToken}`) return Response.json({ message: '401: Unauthorized' }, { status: 401 });
      const route = /^\/api\/v10\/guilds\/(\d+)\/(roles|members\/(\d+))$/.exec(u.pathname);
      if (!route) return new Response('{}', { status: 404 });
      const server = state.servers[route[1]];
      if (!server || server.botIn === false) return Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 });
      if (route[2] === 'roles') return Response.json([{ id: route[1], name: '@everyone', position: 0, color: 0, managed: false }, ...server.roles]);
      const roleIds = server.members[route[3]];
      if (!roleIds) return Response.json({ message: 'Unknown Member', code: 10007 }, { status: 404 });
      return Response.json({ user: { id: route[3], username: 'x' }, roles: roleIds });
    }
    state.counter++;
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${state.counter}`;
      state.tokens.set(token, state.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec(auth);
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

async function makeWorld({ allowlist = [PEOPLE.alice.id, PEOPLE.frank.id], env = {}, migrationsDir } = {}) {
  const { createApp } = await load('worker/index.js');
  const db = createD1Fake(migrationsDir ? { migrationsDir } : undefined);
  const discord = makeDiscord();
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11 + counter) & 255;
    return bytes;
  };
  const fullEnv = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    GUILD_CREATOR_ALLOWLIST: allowlist.join(','),
    ...env,
  };
  const logs = [];
  const app = createApp({ db, env: fullEnv, fetch: discord.fetch, now: () => clock.now, randomBytes, log: (message) => logs.push(message) });
  const world = {
    db, discord, clock, env: fullEnv, logs, app,
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
      return { status: response.status, json, text, headers: response.headers };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) {
      return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
    },
  };
  return world;
}

const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');

// Discord sign-in (the real routes). Returns the cookie jar.
async function signIn(world, person, servers = [], jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  const callback = await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.equal(callback.status, 302, 'sign-in redirects');
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

const SERVER_ROLES = [
  { id: D_OFFICERS, name: 'Officers', position: 9, color: 0xff0000, managed: false },
  { id: D_RAIDLEADS, name: 'Raid leaders', position: 7, color: 0x00ff00, managed: false },
  { id: D_LOOT, name: 'Loot council', position: 5, color: 0, managed: false },
  { id: D_EXTRA, name: 'Booster', position: 1, color: 0, managed: true },
];

// Alice (Guild Master) creates a TBC US guild with teams Alpha and Bravo. Bob is a manual Officer, Carol Team Lead of Alpha. Dave, Erin and Gina are plain
// Members (in the Discord server). The Discord server has the four roles above and the bot is in it; nobody holds a Discord role yet.
async function scenario(options) {
  const w = await makeWorld(options);
  w.discord.servers[SERVER_A] = { roles: SERVER_ROLES.map((role) => ({ ...role })), members: {}, botIn: true };
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', GUILD_BODY);
  assert.equal(created.status, 201, created.text);
  const s = { w, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  [s.A, s.B] = s.teams;
  for (const name of ['bob', 'carol', 'dave', 'erin', 'gina']) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  s.setRoles = (name, body, who = 'alice') => w.call(s.jars[who], 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  assert.equal((await s.setRoles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await s.setRoles('carol', { officer: false, teamLeadTeamIds: [s.A] })).status, 200);
  // A member's Discord roles, on the fake server.
  s.discordRoles = (name, roleIds, server = SERVER_A) => { s.w.discord.servers[server].members[PEOPLE[name].id] = roleIds; };
  s.me = async (name) => (await s.call(name, 'GET', '')).json.me;
  s.people = async (who = 'alice') => (await s.call(who, 'GET', '/people')).json;
  s.person = async (name, who = 'alice') => (await s.people(who)).people.find((entry) => entry.person.id === s.ids[name]);
  s.signInAgain = (name) => signIn(w, PEOPLE[name], [plain(SERVER_A)], s.jars[name]);
  // Makes a custom role as the Guild Master; returns its id.
  s.makeRole = async (name, permissions, who = 'alice') => {
    const made = await s.call(who, 'POST', '/roles', { name, permissions });
    assert.equal(made.status, 201, made.text);
    return made.json.roles.find((role) => role.name === name).id;
  };
  s.setMaps = (maps, who = 'alice') => s.call(who, 'PUT', '/discord/maps', { maps });
  return s;
}

// A second guild on another Discord server, run by Frank (Guild Master there), with its own team and custom role.
async function secondGuild(s) {
  s.w.discord.servers[SERVER_B] = { roles: [{ id: '700000000000000099', name: 'Their officers', position: 3, color: 0, managed: false }], members: {}, botIn: true };
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B), plain(SERVER_A)]);
  const created = await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', multipleTeams: false });
  assert.equal(created.status, 201, created.text);
  const t = { jar: frank, guildId: created.json.guild.id, team: created.json.teams[0].id };
  t.path = `/api/guild/${t.guildId}`;
  t.call = (method, route, body, extra) => s.w.call(frank, method, `${t.path}${route}`, body, extra);
  const made = await t.call('POST', '/roles', { name: 'Their council', permissions: { 'loot.edit': 'guild' } });
  assert.equal(made.status, 201, made.text);
  t.roleId = made.json.roles.find((role) => role.name === 'Their council').id;
  return t;
}

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const COUNCIL = { 'loot.view': 'guild', 'loot.edit': 'guild' };

// ---------------------------------------------------------------------------
// Permission resolution (pure)

check('permissions (pure): ACTION_INFO names every action; the rules say which scope, which role may hold what', async () => {
  const p = await load('worker/permissions.js');
  assert.deepEqual(Object.keys(p.ACTION_INFO).sort(), p.ACTIONS.slice().sort());
  for (const action of p.ACTIONS) {
    const spec = p.ACTION_INFO[action];
    assert(spec.label && spec.group && spec.scopes.length && spec.scopes.every((scope) => ['guild', 'team', 'own_teams'].includes(scope)), action);
  }
  // The view actions are the four sections, and the staff actions are the three that run the guild.
  assert.deepEqual(p.ACTIONS.filter((a) => p.ACTION_INFO[a].view).sort(), Object.values(p.SECTION_ACTIONS).sort());
  assert.deepEqual(p.ACTIONS.filter((a) => p.ACTION_INFO[a].staff).sort(), ['audit.view', 'guild.access', 'guild.roles']);
  // permissionProblem
  assert.equal(p.permissionProblem('cr_x', true, 'loot.edit', 'guild'), null);
  assert.equal(p.permissionProblem('cr_x', true, 'loot.edit', 'team'), null);
  assert.match(p.permissionProblem('cr_x', true, 'loot.policy', 'team'), /cannot be given at the "team" scope/);
  assert.match(p.permissionProblem('cr_x', true, 'roster.view', 'team'), /scope/, 'roster.view is guild-only: the routes do not take it per team');
  assert.match(p.permissionProblem('cr_x', true, 'guild.roles', 'guild'), /Officer role only/);
  assert.match(p.permissionProblem('team_lead', false, 'guild.access', 'guild'), /Officer role only/);
  assert.match(p.permissionProblem('member', false, 'audit.view', 'guild'), /Officer role only/);
  assert.equal(p.permissionProblem('officer', false, 'guild.access', 'guild'), null);
  assert.match(p.permissionProblem('guest', false, 'roster.edit', 'guild'), /can only read/);
  assert.match(p.permissionProblem('public', false, 'loot.edit', 'guild'), /can only read/);
  assert.match(p.permissionProblem('public', false, 'attendance.view', 'team'), /whole-guild/);
  assert.match(p.permissionProblem('guest', false, 'attendance.view', 'own_teams'), /no characters/);
  assert.equal(p.permissionProblem('guest', false, 'attendance.view', 'team'), null);
  assert.match(p.permissionProblem('cr_x', true, 'nope', 'guild'), /not an action/);
  // Every seeded row of the built-in roles passes its own rules.
  const w = await makeWorld();
  for (const row of await w.rows('SELECT role_id, action, scope FROM role_permissions')) {
    if (row.role_id === 'guild_master') continue;
    assert.equal(p.permissionProblem(row.role_id, false, row.action, row.scope), null, `${row.role_id} ${row.action} ${row.scope}`);
  }
});

check('permissions (pure): custom, Discord-given and manual roles resolve together; manual wins; a custom role never raises the rank', async () => {
  const p = await load('worker/permissions.js');
  const rows = [
    { role_id: 'member', action: 'roster.view', scope: 'guild' },
    { role_id: 'officer', action: 'roster.edit', scope: 'guild' }, { role_id: 'officer', action: 'guild.access', scope: 'guild' },
    { role_id: 'team_lead', action: 'roster.edit', scope: 'team' },
    { role_id: 'cr_council', action: 'loot.edit', scope: 'guild' }, { role_id: 'cr_council', action: 'loot.view', scope: 'guild' },
    { role_id: 'cr_leader', action: 'raids.edit', scope: 'team' },
  ];
  const cr = (suffix) => `cr_${suffix.padEnd(22, 'x')}`;
  const council = cr('council');
  const leader = cr('leader');
  const rowsWith = rows.map((row) => ({ ...row, role_id: row.role_id === 'cr_council' ? council : row.role_id === 'cr_leader' ? leader : row.role_id }));
  const manual = (role_id, team_id = null, extra = {}) => ({ role_id, team_id, source: 'manual', ...extra });
  const discord = (role_id, team_id = null, extra = {}) => ({ role_id, team_id, source: 'discord', ...extra });

  const nothing = p.resolvePermissions([], rowsWith);
  assert.deepEqual(nothing, { roles: [], can: { 'roster.view': 'guild' }, rank: 3 });
  // A custom role grants its permissions and shows by name; the rank stays Member.
  const viaCustom = p.resolvePermissions([manual(council, null, { role_name: 'Loot council' })], rowsWith);
  assert.deepEqual(viaCustom.can, { 'roster.view': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild' });
  assert.deepEqual(viaCustom.roles, [{ role: council, name: 'Loot council' }]);
  assert.equal(viaCustom.rank, 3, 'a custom role does not raise the hierarchy rank');
  // A team-scoped custom role needs its team.
  const lead = p.resolvePermissions([manual(leader, 't_a', { role_name: 'Raid leader' }), manual(leader, null, { role_name: 'Raid leader' })], rowsWith);
  assert.deepEqual(lead.can['raids.edit'], ['t_a']);
  assert.deepEqual(lead.roles, [{ role: leader, name: 'Raid leader' }, { role: leader, name: 'Raid leader', teamId: 't_a' }]);
  // Discord-given: the same permissions, marked fromDiscord; held both ways it shows once, as theirs.
  const fromDiscord = p.resolvePermissions([discord('officer')], rowsWith);
  assert.deepEqual(fromDiscord.roles, [{ role: 'officer', fromDiscord: true }]);
  assert.equal(fromDiscord.can['guild.access'], 'guild');
  assert.equal(fromDiscord.rank, 1);
  const both = p.resolvePermissions([discord('officer'), manual('officer')], rowsWith);
  assert.deepEqual(both.roles, [{ role: 'officer' }], 'manual wins: one entry, not marked as Discord');
  assert.deepEqual(p.resolvePermissions([manual('officer'), discord('officer')], rowsWith).roles, [{ role: 'officer' }]);
  // Order: built-ins by rank, then the guild's own roles by name; team leads by team id.
  const mixed = p.resolvePermissions([manual(council, null, { role_name: 'Zeta' }), manual('team_lead', 't_b'), manual('officer'), discord(leader, 't_a', { role_name: 'Alpha' }), manual('team_lead', 't_a')], rowsWith);
  assert.deepEqual(mixed.roles.map((r) => `${r.role.startsWith('cr_') ? r.name : r.role}${r.teamId ? `:${r.teamId}` : ''}`), ['officer', 'team_lead:t_a', 'team_lead:t_b', 'Alpha:t_a', 'Zeta']);
  assert.equal(mixed.rank, 1);
  // Defence in depth: a row whose scope the action does not take grants nothing; Guest and Public rows on a person grant nothing.
  const odd = p.resolvePermissions([manual('officer')], [{ role_id: 'officer', action: 'roster.view', scope: 'team' }, { role_id: 'officer', action: 'made.up', scope: 'guild' }]);
  assert.deepEqual(odd.can, {});
  const viewerRows = [{ role_id: 'guest', action: 'loot.view', scope: 'guild' }, { role_id: 'public', action: 'loot.view', scope: 'guild' }];
  assert.deepEqual(p.resolvePermissions([manual('guest'), manual('public')], viewerRows).can, {});
  assert.deepEqual(p.shapeRoles([manual('guest'), manual('public'), manual('member')]).map((r) => r.role), ['member'], 'only Member of the three is ever listed');
  // own_teams still resolves to the viewer's own teams.
  assert.deepEqual(p.resolvePermissions([], [{ role_id: 'member', action: 'attendance.view', scope: 'own_teams' }], ['t_z', 't_y']).can, { 'attendance.view': ['t_y', 't_z'] });
});

check('permissions (pure): a guest link or the public page resolves ONE role, read actions only, narrowed by the link\'s team', async () => {
  const p = await load('worker/permissions.js');
  const rows = [
    { role_id: 'guest', action: 'roster.view', scope: 'guild' }, { role_id: 'guest', action: 'raids.view', scope: 'guild' },
    { role_id: 'guest', action: 'attendance.view', scope: 'team' }, { role_id: 'guest', action: 'roster.edit', scope: 'guild' },
    { role_id: 'guest', action: 'loot.edit', scope: 'guild' }, { role_id: 'guest', action: 'roster.notes.view', scope: 'guild' },
    { role_id: 'officer', action: 'loot.view', scope: 'guild' },
  ];
  const teams = ['t_b', 't_a'];
  // A guild link: guild grants stay guild; a team grant reaches every active team. The write and notes rows are dropped.
  assert.deepEqual(p.resolveViewerPermissions(rows, 'guest', { activeTeamIds: teams }), { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t_a', 't_b'] });
  // A link for one team narrows EVERY grant, the guild ones too.
  assert.deepEqual(p.resolveViewerPermissions(rows, 'guest', { teamId: 't_a', activeTeamIds: teams }), { 'roster.view': ['t_a'], 'raids.view': ['t_a'], 'attendance.view': ['t_a'] });
  // A team that is not active (archived) reaches nothing.
  assert.deepEqual(p.resolveViewerPermissions(rows, 'guest', { teamId: 't_gone', activeTeamIds: teams }), {});
  // Only the link's role counts: another role's rows are not the guest's.
  assert.equal(p.resolveViewerPermissions(rows, 'guest', { activeTeamIds: teams })['loot.view'], undefined);
  assert.deepEqual(p.resolveViewerPermissions(rows, 'nobody', { activeTeamIds: teams }), {});
  // canGrant: never more than you hold.
  assert.equal(p.canGrant({ 'loot.edit': 'guild' }, 'loot.edit', 'guild'), true);
  assert.equal(p.canGrant({ 'loot.edit': ['t_a'] }, 'loot.edit', 'guild'), false);
  assert.equal(p.canGrant({ 'loot.edit': ['t_a'] }, 'loot.edit', 'team', 't_a'), true);
  assert.equal(p.canGrant({ 'loot.edit': ['t_a'] }, 'loot.edit', 'team', 't_b'), false);
  assert.equal(p.canGrant({ 'loot.edit': ['t_a'] }, 'loot.edit', 'team'), false, 'a team scope needs a team');
  assert.equal(p.canGrant({ 'loot.view': [] }, 'loot.view', 'own_teams'), false);
  assert.equal(p.canGrant({}, 'loot.view', 'guild'), false);
});

// ---------------------------------------------------------------------------
// Migration 0014

check('migration 0014: Guest and Public are seeded read-only, the effective view applies a guild\'s edits, and a Discord row can never be the Guild Master', async () => {
  const s = await scenario();
  const { w } = s;
  const seeded = await w.rows("SELECT role_id, action, scope FROM role_permissions WHERE role_id IN ('guest', 'public') ORDER BY role_id, action");
  assert.deepEqual(seeded.map((r) => `${r.role_id}:${r.action}:${r.scope}`), [
    'guest:attendance.view:team', 'guest:raids.view:guild', 'guest:roster.view:guild',
    'public:attendance.view:guild', 'public:loot.view:guild', 'public:raids.view:guild', 'public:roster.view:guild',
  ]);
  const officerRows = (guildId) => w.rows("SELECT action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = 'officer' ORDER BY action", guildId);
  const systemOfficer = await w.rows("SELECT action, scope FROM role_permissions WHERE role_id = 'officer' ORDER BY action");
  assert.deepEqual(await officerRows(s.guildId), systemOfficer, 'an unedited role is the system rows');
  // An override replaces the system rows for that guild only (even with no rows at all).
  w.db.sqlite.exec(`INSERT INTO role_overrides (guild_id, role_id) VALUES ('${s.guildId}', 'officer')`);
  assert.deepEqual(await officerRows(s.guildId), []);
  w.db.sqlite.exec(`INSERT INTO role_override_permissions (guild_id, role_id, action, scope) VALUES ('${s.guildId}', 'officer', 'roster.view', 'guild')`);
  assert.deepEqual(await officerRows(s.guildId), [{ action: 'roster.view', scope: 'guild' }]);
  const other = await secondGuild(s);
  assert.deepEqual(await officerRows(other.guildId), systemOfficer, 'another guild keeps the defaults');
  // The CHECK: Discord can give Officer, never the Guild Master (or a role that is not assignable).
  const insert = (role, source) => `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_t${role}${source}', '${s.guildId}', '${s.ids.dave}', '${role}', NULL, '${source}', 1)`;
  w.db.sqlite.exec(insert('officer', 'discord'));
  for (const role of ['guild_master', 'member', 'guest', 'public']) assert.throws(() => w.db.sqlite.exec(insert(role, 'discord')), /CHECK/, role);
  assert.throws(() => w.db.sqlite.exec(insert('officer', 'robot')), /CHECK/);
  // The same role from an officer and from Discord are two rows; the same source twice is not allowed.
  w.db.sqlite.exec(insert('officer', 'manual'));
  assert.throws(() => w.db.sqlite.exec(insert('officer', 'manual').replace("'ra_tofficermanual'", "'ra_other'")), /UNIQUE/);
  // The mapping table refuses the Guild Master too.
  assert.throws(() => w.db.sqlite.exec(`INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES ('${s.guildId}', '5', 'guild_master', NULL)`), /CHECK/);
  assert.throws(() => w.db.sqlite.exec(`INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES ('${s.guildId}', 'abc', 'officer', NULL)`), /CHECK/);
});

check('migration 0014: custom roles go with their guild; a role takes its permissions, mappings and links with it; names are unique per guild', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  const mine = await s.makeRole('Council', COUNCIL);
  assert.equal((await other.call('POST', '/roles', { name: 'council', permissions: { 'loot.view': 'guild' } })).status, 201, 'the same name in another guild is fine');
  assert.equal((await s.call('alice', 'POST', '/roles', { name: 'COUNCIL', permissions: {} })).status, 409, 'unique per guild, ignoring case');
  assert.equal(await s.w.count('role_permissions', 'role_id = ?', mine), 2);
  assert.equal((await s.setMaps([{ discordRoleId: D_LOOT, roleId: mine, teamId: null }])).status, 200);
  assert.equal((await s.call('alice', 'POST', '/guest-links', { roleId: mine, expiresIn: '7d' })).status, 201);
  assert.equal(await s.w.count('discord_role_maps', 'role_id = ?', mine), 1);
  assert.equal(await s.w.count('guest_links', 'role_id = ?', mine), 1);
  // Deleting the guild takes the custom roles with it (roles.guild_id has no foreign key: a trigger does it), assignments first (RESTRICT).
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: mine, teamId: null }] })).status, 200);
  const beforeRoles = await s.w.count('roles', 'guild_id IS NOT NULL');
  assert.equal(beforeRoles, 3);
  s.w.db.sqlite.exec(`DELETE FROM guilds WHERE id = '${s.guildId}'`);
  assert.equal(await s.w.count('roles', 'guild_id = ?', s.guildId), 0);
  assert.equal(await s.w.count('role_permissions', 'role_id = ?', mine), 0);
  assert.equal(await s.w.count('discord_role_maps'), 0);
  assert.equal(await s.w.count('guest_links'), 0);
  assert.equal(await s.w.count('roles', 'guild_id = ?', other.guildId), 2, 'the other guild keeps its roles');
  assert.equal(await s.w.count('roles', 'guild_id IS NULL'), 6, 'the six built-in roles stay');
});

check('migration 0014 on a populated 0012 database: every assignment becomes manual, nothing is lost, the new tables are empty, the public page is off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-mig-'));
  try {
    const migrations = path.join(ROOT, 'migrations');
    for (const name of fs.readdirSync(migrations)) if (name.endsWith('.sql') && name < '0014_roles.sql') fs.copyFileSync(path.join(migrations, name), path.join(dir, name));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
    db.exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u1', 'u1', '1', 'a', 1, 1), ('u2', 'u2', '2', 'b', 1, 1);
      INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_by, created_at) VALUES ('g1', 'G', 'R', 'realm', 'US', '9', 'UTC', 'tbc', 'u1', 1);
      INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T', 25, 0, 1);
      INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES
        ('ra1', 'g1', 'u1', 'guild_master', NULL, 'u1', 1), ('ra2', 'g1', 'u2', 'officer', NULL, 'u1', 2), ('ra3', 'g1', 'u2', 'team_lead', 't1', 'u1', 3);`);
    const count = (sql) => db.prepare(sql).get().n;
    assert.equal(count('SELECT COUNT(*) AS n FROM role_assignments'), 3);
    const permissionsBefore = count('SELECT COUNT(*) AS n FROM role_permissions');
    const sql = fs.readFileSync(path.join(migrations, '0014_roles.sql'), 'utf8');
    db.exec(sql);
    assert.equal(count('SELECT COUNT(*) AS n FROM role_assignments'), 3);
    assert.equal(count("SELECT COUNT(*) AS n FROM role_assignments WHERE source = 'manual'"), 3);
    assert.equal(count('SELECT COUNT(*) AS n FROM role_permissions'), permissionsBefore + 7, 'only the Guest and Public rows were added');
    for (const table of ['discord_role_maps', 'guest_links', 'role_overrides', 'role_override_permissions']) assert.equal(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
    assert.deepEqual({ ...db.prepare('SELECT public_enabled, public_sections FROM guilds').get() }, { public_enabled: 0, public_sections: '[]' });
    assert.equal(count("SELECT COUNT(*) AS n FROM effective_role_permissions WHERE guild_id = 'g1' AND role_id = 'officer'"), count("SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = 'officer'"));
    // The foreign keys still hold after the index change.
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// The role editor

check('roles: the Guild Master reads the catalogue and every role; officers, team leads, members and the signed-out cannot', async () => {
  const s = await scenario();
  const read = await s.call('alice', 'GET', '/roles');
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json.actions.map((a) => a.action), (await load('worker/permissions.js')).ACTIONS);
  assert(read.json.actions.every((a) => a.label && a.group && Array.isArray(a.scopes) && typeof a.view === 'boolean' && typeof a.staff === 'boolean'));
  assert.deepEqual(read.json.roles.map((r) => r.id), ['guild_master', 'officer', 'team_lead', 'member', 'guest', 'public']);
  const byId = Object.fromEntries(read.json.roles.map((r) => [r.id, r]));
  assert.equal(byId.guild_master.fixed, true);
  assert.equal(byId.officer.fixed, false);
  assert.equal(byId.officer.customized, false);
  assert.deepEqual(byId.officer.permissions['loot.edit'], 'guild');
  assert.equal(byId.guild_master.permissions['guild.roles'], 'guild');
  assert.equal(byId.team_lead.needsTeam, true);
  assert.equal(byId.officer.needsTeam, false);
  assert.equal(byId.officer.holders, 1, 'Bob');
  assert.equal(byId.guild_master.holders, 1);
  assert.equal(byId.team_lead.holders, 1, 'Carol');
  assert.equal(byId.guest.kind, 'builtin');
  // What the grid may offer per role, from the same rules the server enforces.
  assert.deepEqual(byId.guest.allowed['roster.view'], ['guild']);
  assert.deepEqual(byId.guest.allowed['roster.edit'], [], 'a guest never writes');
  assert.deepEqual(byId.guest.allowed['attendance.view'], ['guild', 'team']);
  assert.deepEqual(byId.public.allowed['attendance.view'], ['guild']);
  assert.deepEqual(byId.officer.allowed['guild.access'], ['guild']);
  assert.deepEqual(byId.member.allowed['guild.roles'], []);
  assert.deepEqual(byId.team_lead.allowed['guild.access'], []);
  assert.deepEqual(byId.guild_master.allowed, {});
  assert.deepEqual(read.json.limits, { customRoles: 20, nameLength: 32 });
  assert.equal(read.json.canEditBuiltin, true);
  for (const name of ['bob', 'carol', 'dave']) assert.equal((await s.call(name, 'GET', '/roles')).status, 403, name);
  assert.equal((await s.w.call({}, 'GET', `${s.guildPath}/roles`)).status, 401);
});

check('roles: a custom role is made with the grid\'s pairs, listed, edited, given to a person and deleted; the person\'s rights follow at once', async () => {
  const s = await scenario();
  const made = await s.call('alice', 'POST', '/roles', { name: 'Loot council', permissions: { 'loot.edit': 'guild', 'loot.view': 'guild' } });
  assert.equal(made.status, 201, made.text);
  const role = made.json.roles.find((r) => r.name === 'Loot council');
  assert.match(role.id, /^cr_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([role.kind, role.fixed, role.customized, role.needsTeam, role.holders, role.mapped, role.links], ['custom', false, false, false, 0, 0, 0]);
  assert.deepEqual(role.permissions, { 'loot.edit': 'guild', 'loot.view': 'guild' });
  assert.equal((await s.me('dave')).can['loot.edit'], undefined);

  // Dave gets it by hand: loot.edit and nothing else.
  const given = await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: role.id, teamId: null }] });
  assert.equal(given.status, 200, given.text);
  const dave = await s.me('dave');
  assert.equal(dave.can['loot.edit'], 'guild');
  assert.equal(dave.can['loot.view'], 'guild');
  assert.equal(dave.can['roster.edit'], undefined, 'nothing else changed');
  assert.equal(dave.can['guild.access'], undefined);
  assert.deepEqual(dave.roles, [{ role: role.id, name: 'Loot council' }]);
  const row = await s.person('dave');
  assert.deepEqual(row.roles, [{ role: role.id, name: 'Loot council' }]);
  assert.equal((await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === role.id).holders, 1);
  // The /auth/me list shows it too.
  assert.deepEqual((await s.w.call(s.jars.dave, 'GET', '/auth/me')).json.guilds[0].roles, [{ role: role.id, name: 'Loot council' }]);

  // Edit: rename and take loot.edit away; Dave's rights follow on the next request.
  const edited = await s.call('alice', 'PUT', `/roles/${role.id}`, { name: 'Loot masters', permissions: { 'loot.view': 'guild' } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.roles.find((r) => r.id === role.id).name, 'Loot masters');
  const after = await s.me('dave');
  assert.equal(after.can['loot.edit'], undefined);
  assert.equal(after.can['loot.view'], 'guild');
  assert.deepEqual(after.roles, [{ role: role.id, name: 'Loot masters' }]);

  // Delete: gone from Dave, from the list, and the rows are cleaned up.
  const deleted = await s.call('alice', 'DELETE', `/roles/${role.id}`, {});
  assert.equal(deleted.status, 200, deleted.text);
  assert(!deleted.json.roles.some((r) => r.id === role.id));
  assert.deepEqual((await s.me('dave')).roles, []);
  assert.equal(await s.w.count('role_assignments', 'role_id = ?', role.id), 0);
  assert.equal(await s.w.count('role_permissions', 'role_id = ?', role.id), 0);
  assert.equal((await s.call('alice', 'DELETE', `/roles/${role.id}`, {})).status, 404, 'a second delete');
  assert.deepEqual((await s.w.rows("SELECT action, entity_type FROM audit_log WHERE action LIKE 'role.%' ORDER BY created_at, rowid")).map((r) => r.action), ['role.create', 'role.update', 'role.delete']);
});

check('roles: a role given for one team (a team-scoped permission) is held per team, like Team Lead', async () => {
  const s = await scenario();
  const leader = await s.makeRole('Raid leader', { 'raids.edit': 'team', 'raids.view': 'guild' });
  const roles = (await s.call('alice', 'GET', '/roles')).json.roles;
  assert.equal(roles.find((r) => r.id === leader).needsTeam, true);
  const bad = (body) => s.setRoles('dave', { officer: false, teamLeadTeamIds: [], ...body });
  assert.equal((await bad({ roles: [{ roleId: leader, teamId: null }] })).status, 400, 'a team is needed');
  assert.equal((await bad({ roles: [{ roleId: leader, teamId: s.B }, { roleId: leader, teamId: 't_Zzzzzzzzzzzzzzzzzzzzzz' }] })).status, 400, 'a team of no guild');
  const ok = await bad({ roles: [{ roleId: leader, teamId: s.A }] });
  assert.equal(ok.status, 200, ok.text);
  const dave = await s.me('dave');
  assert.deepEqual(dave.can['raids.edit'], [s.A]);
  assert.deepEqual(dave.roles, [{ role: leader, name: 'Raid leader', teamId: s.A }]);
  // Two teams, then none.
  assert.equal((await bad({ roles: [{ roleId: leader, teamId: s.A }, { roleId: leader, teamId: s.B }] })).status, 200);
  assert.deepEqual((await s.me('dave')).can['raids.edit'], [s.A, s.B].sort());
  assert.equal((await bad({ roles: [] })).status, 200);
  assert.equal((await s.me('dave')).can['raids.edit'], undefined);
  // A guild-wide role refuses a team.
  const plainRole = await s.makeRole('Scribe', { 'roster.notes.view': 'guild' });
  assert.equal((await bad({ roles: [{ roleId: plainRole, teamId: s.A }] })).status, 400);
  // Switching a role between "one team" and "whole guild" is refused while people hold it.
  assert.equal((await bad({ roles: [{ roleId: leader, teamId: s.A }] })).status, 200);
  const flip = await s.call('alice', 'PUT', `/roles/${leader}`, { permissions: { 'raids.edit': 'guild' } });
  assert.equal(flip.status, 409);
  assert.equal(flip.json.error, 'role_in_use');
  assert.equal((await s.call('alice', 'PUT', `/roles/${leader}`, { permissions: { 'raids.edit': 'team', 'attendance.view': 'team' } })).status, 200, 'still a team role: fine');
});

check('roles: validation - names, the cap, scopes the routes do not take, staff-only actions, read-only Guest and Public', async () => {
  const s = await scenario();
  const create = (name, permissions) => s.call('alice', 'POST', '/roles', { name, permissions });
  for (const name of ['Officer', 'guest', 'GUILD MASTER', 'Team lead', 'public', 'member']) {
    const r = await create(name, {});
    assert.equal(r.status, 409, name);
    assert.equal(r.json.error, 'role_name_taken');
  }
  for (const name of ['', '   ', 'x'.repeat(33), 'tab\there', 5, null]) assert.equal((await create(name, {})).status, 400, String(name));
  const bad = async (permissions, fragment) => {
    const r = await create('Probe', permissions);
    assert.equal(r.status, 400, JSON.stringify(permissions));
    assert.equal(r.json.field, 'permissions');
    if (fragment) assert.match(r.json.message, fragment);
  };
  await bad({ 'made.up': 'guild' }, /not an action/);
  await bad({ 'loot.edit': 'galaxy' }, /scope/);
  await bad({ 'loot.edit': 5 }, /scope/);
  await bad({ 'loot.policy': 'team' }, /scope/);
  await bad({ 'roster.view': 'team' }, /scope/);
  await bad({ 'guild.roles': 'guild' }, /Officer role only/);
  await bad({ 'guild.access': 'guild' }, /Officer role only/);
  await bad({ 'audit.view': 'guild' }, /Officer role only/);
  await bad('loot.edit', /object/);
  await bad(['loot.edit'], /object/);
  await bad(undefined, /object/);
  // Guest and Public are read-only whatever the request says.
  for (const role of ['guest', 'public']) {
    for (const permissions of [{ 'roster.edit': 'guild' }, { 'loot.edit': 'guild' }, { 'roster.notes.view': 'guild' }, { 'guild.teams': 'guild' }, { 'signups.self': 'guild' }]) {
      const r = await s.call('alice', 'PUT', `/roles/${role}`, { permissions });
      assert.equal(r.status, 400, `${role} ${JSON.stringify(permissions)}`);
      assert.match(r.json.message, /can only read/);
    }
  }
  assert.equal((await s.call('alice', 'PUT', '/roles/public', { permissions: { 'attendance.view': 'team' } })).status, 400);
  assert.equal((await s.call('alice', 'PUT', '/roles/guest', { permissions: { 'attendance.view': 'own_teams' } })).status, 400);
  // Member, Team Lead and Guest cannot hold the staff actions either.
  for (const role of ['member', 'team_lead', 'guest', 'public']) {
    for (const action of ['guild.roles', 'guild.access', 'audit.view']) assert.equal((await s.call('alice', 'PUT', `/roles/${role}`, { permissions: { [action]: 'guild' } })).status, 400, `${role} ${action}`);
  }
  // The cap: 20 roles of the guild's own.
  for (let i = 0; i < 20; i++) {
    if (i % 10 === 9) s.w.advance(61_000); // 60 writes a minute per person
    assert.equal((await create(`Role ${i}`, { 'roster.view': 'guild' })).status, 201, `role ${i}`);
  }
  const over = await create('One too many', {});
  assert.equal(over.status, 400);
  assert.match(over.json.message, /at most 20/);
  assert.equal(await s.w.count('roles', 'guild_id = ?', s.guildId), 20);
  // An empty permission set is allowed (a label), and an unknown role is a 404.
  assert.equal((await s.call('alice', 'DELETE', `/roles/cr_${'Q'.repeat(22)}`, {})).status, 404);
  assert.equal((await s.call('alice', 'PUT', `/roles/cr_${'Q'.repeat(22)}`, { permissions: {} })).status, 404);
  assert.equal((await s.call('alice', 'PUT', '/roles/nonsense', { permissions: {} })).status, 404, 'a malformed role id');
});

check('roles: built-in roles are edited per guild (Officer loses loot.policy), reset to the defaults, and another guild is not touched', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  const bobBefore = await s.me('bob');
  assert.equal(bobBefore.can['loot.policy'], 'guild');
  const officer = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'officer');
  const without = { ...officer.permissions };
  delete without['loot.policy'];
  const edited = await s.call('alice', 'PUT', '/roles/officer', { permissions: without });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.roles.find((r) => r.id === 'officer').customized, true);
  assert.equal((await s.me('bob')).can['loot.policy'], undefined, 'Bob lost it at once');
  assert.equal((await s.me('bob')).can['roster.edit'], 'guild', 'the rest stays');
  // The other guild\'s officers are untouched; the system rows too.
  assert.equal((await other.call('GET', '/roles')).json.roles.find((r) => r.id === 'officer').customized, false);
  assert.equal(await s.w.count('role_permissions', "role_id = 'officer' AND action = 'loot.policy'"), 1);
  // Reset.
  const reset = await s.call('alice', 'POST', '/roles/officer/reset', {});
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.roles.find((r) => r.id === 'officer').customized, false);
  assert.equal((await s.me('bob')).can['loot.policy'], 'guild');
  assert.equal(await s.w.count('role_override_permissions'), 0);
  // Team Lead and Member can be edited too; Member's change reaches everyone.
  assert.equal((await s.call('alice', 'PUT', '/roles/member', { permissions: { 'roster.view': 'guild', 'raids.view': 'guild', 'loot.view': 'guild' } })).status, 200);
  assert.equal((await s.me('dave')).can['loot.view'], 'guild', 'Members now see loot guild-wide');
  assert.equal((await s.me('dave')).can['attendance.view'], undefined, 'and lost attendance, which the edit left out');
  // A built-in role keeps its name and cannot be deleted; only a built-in can be reset.
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { name: 'Chief', permissions: officer.permissions })).status, 400);
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { name: 'Officer', permissions: officer.permissions })).status, 200, 'a save that changes nothing is fine and writes no audit row');
  assert.equal((await s.call('alice', 'DELETE', '/roles/officer', {})).json.error, 'builtin_role');
  const council = await s.makeRole('Council', COUNCIL);
  assert.equal((await s.call('alice', 'POST', `/roles/${council}/reset`, {})).status, 400);
  assert.deepEqual((await s.w.rows("SELECT action FROM audit_log WHERE guild_id = ? AND action LIKE 'role.%' ORDER BY rowid", s.guildId)).map((r) => r.action), ['role.update', 'role.reset', 'role.update', 'role.create']);
});

check('roles: the Guild Master role is fixed, there is always a Guild Master to manage roles, and a custom role cannot confer the Guild Master', async () => {
  const s = await scenario();
  for (const [method, route, body] of [['PUT', '/roles/guild_master', { permissions: {} }], ['DELETE', '/roles/guild_master', {}], ['POST', '/roles/guild_master/reset', {}]]) {
    const r = await s.call('alice', method, route, body);
    assert.equal(r.status, 400, `${method} ${route}`);
    assert.equal(r.json.error, 'fixed_role');
  }
  assert.equal((await s.me('alice')).can['guild.roles'], 'guild');
  // Even when the Officer role is emptied and a custom role is deleted, the Guild Master keeps every action.
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: {} })).status, 200);
  const alice = await s.me('alice');
  const { ACTIONS } = await load('worker/permissions.js');
  assert.deepEqual(Object.keys(alice.can).filter((a) => alice.can[a] === 'guild').sort(), ACTIONS.filter((a) => a !== 'signups.self').sort());
  // No way to assign the Guild Master through the role routes: custom roles are the guild's own, built-ins are not assignable.
  for (const roleId of ['guild_master', 'officer', 'member', 'guest', 'public']) {
    assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId, teamId: null }] })).status, 400, roleId);
  }
  assert.equal(await s.w.count('role_assignments', "role_id = 'guild_master'"), 1);
  // The Guild Master is never a target of role changes (existing rule), custom ones included, even for an Officer who may edit roles.
  const council = await s.makeRole('Council', COUNCIL);
  assert.equal((await s.call('alice', 'POST', '/roles/officer/reset', {})).status, 200);
  const officer = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'officer');
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: { ...officer.permissions, 'guild.roles': 'guild' } })).status, 200);
  const onGm = await s.call('bob', 'PUT', `/people/${s.ids.alice}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council, teamId: null }] });
  assert.equal(onGm.status, 403);
  assert.match(onGm.json.message, /cannot change that person/);
});

check('roles: someone the Guild Master gave guild.roles manages custom roles only, and never hands out more than they hold', async () => {
  const s = await scenario();
  // Give the Officer role guild.roles (a staff action the Officer role may hold): Bob can now edit roles.
  const officer = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'officer');
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: { ...officer.permissions, 'guild.roles': 'guild' } })).status, 200);
  assert.equal((await s.me('bob')).can['guild.roles'], 'guild');
  assert.equal((await s.call('bob', 'GET', '/roles')).status, 200);
  assert.equal((await s.call('bob', 'GET', '/roles')).json.canEditBuiltin, false);
  // Built-in roles: the Guild Master's alone.
  assert.equal((await s.call('bob', 'PUT', '/roles/officer', { permissions: officer.permissions })).status, 403);
  assert.equal((await s.call('bob', 'PUT', '/roles/member', { permissions: {} })).status, 403);
  assert.equal((await s.call('bob', 'POST', '/roles/officer/reset', {})).status, 403);
  // Custom roles within his own rights: fine. Beyond them: 403. Take Bob's loot.edit away to see it.
  const withoutLoot = { ...officer.permissions, 'guild.roles': 'guild' };
  delete withoutLoot['loot.edit'];
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: withoutLoot })).status, 200);
  assert.equal((await s.call('bob', 'POST', '/roles', { name: 'Within', permissions: { 'roster.edit': 'guild' } })).status, 201);
  const beyond = await s.call('bob', 'POST', '/roles', { name: 'Beyond', permissions: { 'loot.edit': 'guild' } });
  assert.equal(beyond.status, 403);
  assert.match(beyond.json.message, /more than you can do/);
  assert.equal(await s.w.count('roles', "name = 'Beyond'"), 0);
  // A role the Guild Master made that holds loot.edit: Bob cannot give it, map it, edit or delete it.
  const council = await s.makeRole('Council', COUNCIL);
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council, teamId: null }] }, 'bob')).status, 403);
  assert.equal((await s.setMaps([{ discordRoleId: D_LOOT, roleId: council, teamId: null }], 'bob')).status, 403);
  assert.equal((await s.call('bob', 'PUT', `/roles/${council}`, { permissions: { 'loot.view': 'guild' } })).status, 403);
  assert.equal((await s.call('bob', 'DELETE', `/roles/${council}`, {})).status, 403);
  // Without guild.roles at all, the people routes refuse him too (the default for Officers).
  assert.equal((await s.call('alice', 'POST', '/roles/officer/reset', {})).status, 200);
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [] }, 'bob')).status, 403);
  // Giving Officer: only if the giver holds everything Officer holds. Bob (an Officer) with guild.roles can; a limited editor cannot.
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: { ...officer.permissions, 'guild.roles': 'guild' } })).status, 200);
  assert.equal((await s.setRoles('dave', { officer: true, teamLeadTeamIds: [] }, 'bob')).status, 200, 'an Officer who holds everything Officer holds may make an Officer');
  const trimmed = { ...officer.permissions, 'guild.roles': 'guild' };
  delete trimmed['roster.edit'];
  // Dave (now Officer) lost nothing; trim the role for everyone, then Bob lacks roster.edit and cannot give a role that has it (team lead has roster.edit at team scope).
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: trimmed })).status, 200);
  assert.equal((await s.setRoles('erin', { officer: false, teamLeadTeamIds: [s.A] }, 'bob')).status, 403);
});

check('roles: assigning, mapping and listing refuse another guild\'s role; every new role route is its own guild\'s (cross-guild isolation)', async () => {
  const s = await secondGuildScenario();
  const { other } = s;
  // Their role id in my guild: not mine.
  for (const [method, route, body] of [
    ['PUT', `/roles/${other.roleId}`, { permissions: {} }], ['DELETE', `/roles/${other.roleId}`, {}],
  ]) assert.equal((await s.call('alice', method, route, body)).status, 404, `${method} ${route}`);
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: other.roleId, teamId: null }] })).status, 400);
  assert.equal((await s.setMaps([{ discordRoleId: D_LOOT, roleId: other.roleId, teamId: null }])).status, 400);
  assert.equal((await s.call('alice', 'POST', '/guest-links', { roleId: other.roleId, expiresIn: '1d' })).status, 400);
  // My Guild Master has nothing in their guild.
  for (const [method, route, body] of [['GET', '/roles'], ['POST', '/roles', { name: 'X', permissions: {} }], ['GET', '/discord'], ['PUT', '/discord/maps', { maps: [] }],
    ['GET', '/guest-links'], ['POST', '/guest-links', { expiresIn: '1d' }], ['GET', '/public'], ['PUT', '/public', { enabled: true, sections: [] }]]) {
    const r = await s.w.call(s.jars.alice, method, `${other.path}${route}`, body);
    assert.equal(r.status, 403, `${method} ${route}`);
    assert.equal(r.json.error, 'not_member');
  }
  // Their team in my mapping or my role assignment.
  assert.equal((await s.setMaps([{ discordRoleId: D_LOOT, roleId: 'team_lead', teamId: other.team }])).status, 400);
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [other.team] })).status, 400);
  // Their data is untouched by all of it.
  assert.equal(await s.w.count('role_assignments', 'guild_id = ?', other.guildId), 1, 'only their Guild Master');
  assert.equal(await s.w.count('discord_role_maps', 'guild_id = ?', other.guildId), 0);
  assert.equal(await s.w.count('guest_links', 'guild_id = ?', other.guildId), 0);
  assert.equal((await other.call('GET', '/roles')).json.roles.find((r) => r.id === other.roleId).name, 'Their council');
});

async function secondGuildScenario() {
  const s = await scenario();
  s.other = await secondGuild(s);
  return s;
}


// ---------------------------------------------------------------------------
// Discord role mapping

check('discord settings: the invite link (scope bot, permissions 0), the server\'s roles, the mapping targets; the bot token goes to Discord only', async () => {
  const s = await scenario();
  const read = await s.call('alice', 'GET', '/discord');
  assert.equal(read.status, 200, read.text);
  const invite = new URL(read.json.bot.inviteUrl);
  assert.equal(invite.origin + invite.pathname, 'https://discord.com/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(invite.searchParams), { client_id: 'client-id', scope: 'bot', permissions: '0', guild_id: SERVER_A, disable_guild_select: 'true' });
  assert.deepEqual([read.json.bot.configured, read.json.bot.inServer, read.json.bot.problem], [true, true, null]);
  assert.deepEqual(read.json.roles.map((r) => r.name), ['Officers', 'Raid leaders', 'Loot council', 'Booster'], 'highest first, without @everyone');
  assert.deepEqual(read.json.roles[0], { id: D_OFFICERS, name: 'Officers', color: '#ff0000', position: 9, managed: false });
  assert.equal(read.json.roles[2].color, null);
  assert.equal(read.json.roles[3].managed, true);
  assert.deepEqual(read.json.maps, []);
  assert.deepEqual(read.json.targets, [
    { roleId: 'officer', name: 'Officer', needsTeam: false, custom: false },
    { roleId: 'team_lead', name: 'Team Lead', needsTeam: true, custom: false },
  ]);
  const council = await s.makeRole('Loot council', COUNCIL);
  assert.deepEqual((await s.call('alice', 'GET', '/discord')).json.targets[2], { roleId: council, name: 'Loot council', needsTeam: false, custom: true });
  // Only the Guild Master (guild.roles) sees the mapping.
  for (const name of ['bob', 'carol', 'dave']) assert.equal((await s.call(name, 'GET', '/discord')).status, 403, name);
  // The token is sent to Discord's bot endpoints only, as a Bot credential, and never comes back to a browser.
  assert(s.w.discord.botCalls.length > 0 && s.w.discord.botCalls.every((c) => c.auth === `Bot ${BOT_TOKEN}` && /^\/api\/v10\/guilds\/\d+\/(roles|members\/\d+)$/.test(c.path) && c.host === 'discord.com'));
  assert(!read.text.includes(BOT_TOKEN));
  // The bot not in the server: the page says so (inServer false) and still gives the invite link; nothing else fails.
  s.w.discord.servers[SERVER_A].botIn = false;
  const missing = await s.call('alice', 'GET', '/discord');
  assert.equal(missing.status, 200);
  assert.deepEqual([missing.json.bot.inServer, missing.json.bot.problem, missing.json.roles], [false, 'bot_missing', []]);
  assert(missing.json.bot.inviteUrl);
  s.w.discord.servers[SERVER_A].botIn = true;
  // Discord down: unknown (null), not "missing". A refused token: its own problem.
  s.w.discord.outage = true;
  assert.deepEqual((await s.call('alice', 'GET', '/discord')).json.bot, { configured: true, inviteUrl: read.json.bot.inviteUrl, inServer: null, problem: 'unavailable' });
  s.w.discord.outage = false;
  s.w.discord.botToken = 'something-else';
  assert.equal((await s.call('alice', 'GET', '/discord')).json.bot.problem, 'bad_token');
});

check('discord settings: without DISCORD_BOT_TOKEN the mapping is off (no call to Discord, the invite link still shows); a hostile DISCORD_API_BASE is ignored', async () => {
  const s = await scenario({ env: { DISCORD_BOT_TOKEN: '' } });
  const read = await s.call('alice', 'GET', '/discord');
  assert.equal(read.status, 200);
  assert.deepEqual([read.json.bot.configured, read.json.bot.inServer, read.json.roles], [false, null, []]);
  assert(read.json.bot.inviteUrl.includes('scope=bot'));
  assert.equal(s.w.discord.botCalls.length, 0, 'no bot call without a token');
  assert.equal((await s.call('alice', 'GET', '/people')).json.discord.configured, false);
  // Without DISCORD_CLIENT_ID there is no invite link (and a server id that is not a snowflake never builds one).
  const { inviteUrl, botConfigured } = await load('worker/discord-bot.js');
  assert.equal(inviteUrl({}, SERVER_A), null);
  assert.equal(inviteUrl({ DISCORD_CLIENT_ID: 'x' }, 'not-a-server'), null);
  assert.equal(botConfigured({}), false);
  assert.equal(botConfigured({ DISCORD_BOT_TOKEN: '   ' }), false);
  assert.equal(botConfigured({ DISCORD_BOT_TOKEN: 'abc' }), true);
  // A base that is not discord.com or a local fake falls back to discord.com (the bot token never goes elsewhere).
  const evil = await scenario({ env: { DISCORD_API_BASE: 'https://evil.test' } });
  assert.equal((await evil.call('alice', 'GET', '/discord')).status, 200);
  assert(evil.w.discord.botCalls.length > 0 && evil.w.discord.botCalls.every((c) => c.host === 'discord.com'), 'the bot token only goes to discord.com');
  const local = await scenario({ env: { DISCORD_API_BASE: 'http://127.0.0.1:8790' } });
  assert.equal((await local.call('alice', 'GET', '/discord')).json.bot.inviteUrl.startsWith('http://127.0.0.1:8790/oauth2/authorize?'), true);
});

check('discord mapping: saving validates every entry (Guild Master and @everyone refused, teams, foreign roles), replaces the whole mapping and audits it', async () => {
  const s = await scenario();
  const council = await s.makeRole('Loot council', COUNCIL);
  const put = (maps, who) => s.setMaps(maps, who);
  const refuse = async (maps, fragment) => {
    const r = await put(maps);
    assert.equal(r.status, 400, JSON.stringify(maps));
    assert.equal(r.json.field, 'maps');
    if (fragment) assert.match(r.json.message, fragment);
  };
  await refuse([{ discordRoleId: D_OFFICERS, roleId: 'guild_master', teamId: null }], /Guild Master/);
  for (const roleId of ['member', 'guest', 'public', 'nonsense', 'cr_' + 'Z'.repeat(22)]) await refuse([{ discordRoleId: D_OFFICERS, roleId, teamId: null }], /cannot be mapped/);
  await refuse([{ discordRoleId: SERVER_A, roleId: 'officer', teamId: null }], /@everyone/);
  await refuse([{ discordRoleId: 'abc', roleId: 'officer', teamId: null }], /Discord role id/);
  await refuse([{ discordRoleId: D_OFFICERS, roleId: 'team_lead', teamId: null }], /one team/);
  await refuse([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: s.A }], /whole guild/);
  await refuse([{ discordRoleId: D_OFFICERS, roleId: 'team_lead', teamId: 't_Zzzzzzzzzzzzzzzzzzzzzz' }], /team/);
  await refuse([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }, { discordRoleId: D_OFFICERS, roleId: 'team_lead', teamId: s.A }], /once/);
  await refuse('officers');
  await refuse(Array.from({ length: 251 }, (_, i) => ({ discordRoleId: String(1000 + i), roleId: 'officer', teamId: null })));
  assert.equal(await s.w.count('discord_role_maps'), 0, 'nothing was written');
  const ok = await put([
    { discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null },
    { discordRoleId: D_RAIDLEADS, roleId: 'team_lead', teamId: s.A },
    { discordRoleId: D_LOOT, roleId: council, teamId: null },
  ]);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.maps.map((m) => [m.discordRoleId, m.roleId, m.teamId]), [[D_OFFICERS, 'officer', null], [D_RAIDLEADS, 'team_lead', s.A], [D_LOOT, council, null]]);
  assert.equal((await s.call('alice', 'GET', '/discord')).json.maps.length, 3);
  // Replace-all: a second save with one entry leaves one.
  assert.equal((await put([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).json.maps.length, 1);
  assert.equal(await s.w.count('discord_role_maps'), 1);
  assert.equal((await put([])).json.maps.length, 0);
  // Officers and members cannot save a mapping (guild.roles is the Guild Master's).
  for (const name of ['bob', 'carol', 'dave']) assert.equal((await put([], name)).status, 403, name);
  const audit = await s.w.rows("SELECT before, after, actor_user_id FROM audit_log WHERE guild_id = ? AND action = 'discord.maps' ORDER BY rowid", s.guildId);
  assert.equal(audit.length, 3, 'three saves; a refused one writes nothing');
  assert.deepEqual(JSON.parse(audit[0].after).maps.length, 3);
  assert.deepEqual(JSON.parse(audit[1].before).maps.length, 3);
  assert.equal(audit[0].actor_user_id, s.ids.alice);
});

check('discord mapping: sign-in gives the mapped roles (Officer, Team Lead of a team, a custom role) and takes them back when the Discord role goes', async () => {
  const s = await scenario();
  const council = await s.makeRole('Loot council', COUNCIL);
  assert.equal((await s.setMaps([
    { discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null },
    { discordRoleId: D_RAIDLEADS, roleId: 'team_lead', teamId: s.A },
    { discordRoleId: D_LOOT, roleId: council, teamId: null },
  ])).status, 200);
  s.discordRoles('dave', [D_OFFICERS, D_LOOT, D_EXTRA]);
  s.discordRoles('erin', [D_RAIDLEADS]);
  await s.signInAgain('dave');
  await s.signInAgain('erin');
  const dave = await s.me('dave');
  assert.deepEqual(dave.roles, [{ role: 'officer', fromDiscord: true }, { role: council, name: 'Loot council', fromDiscord: true }]);
  assert.equal(dave.can['guild.access'], 'guild');
  assert.equal(dave.can['loot.edit'], 'guild');
  const erin = await s.me('erin');
  assert.deepEqual(erin.roles, [{ role: 'team_lead', teamId: s.A, fromDiscord: true }]);
  assert.deepEqual(erin.can['roster.edit'], [s.A]);
  const rows = await s.w.rows("SELECT user_id, role_id, team_id, source, assigned_by FROM role_assignments WHERE source = 'discord' ORDER BY role_id, user_id");
  assert.equal(rows.length, 3);
  assert(rows.every((r) => r.assigned_by === null), 'nobody assigned them: Discord did');
  // The roles show on the People page marked as Discord's, in /auth/me, and Erin is a Team Lead of Alpha on the guild payload.
  const people = await s.people();
  assert.deepEqual((await s.person('dave')).roles, dave.roles);
  assert.equal(people.people.find((p) => p.person.id === s.ids.erin).roles[0].fromDiscord, true);
  assert.deepEqual((await s.w.call(s.jars.dave, 'GET', '/auth/me')).json.guilds[0].roles, dave.roles);
  const leads = (await s.call('alice', 'GET', '')).json.teams.find((t) => t.id === s.A).leads.map((p) => p.id);
  assert(leads.includes(s.ids.erin) && leads.includes(s.ids.carol));
  assert.equal(new Set(leads).size, leads.length);
  // A Discord role nobody mapped (Booster) changes nothing. Taking a Discord role away takes the Raidsmith role away at the next sign-in.
  s.discordRoles('dave', [D_LOOT]);
  await s.signInAgain('dave');
  assert.deepEqual((await s.me('dave')).roles, [{ role: council, name: 'Loot council', fromDiscord: true }]);
  assert.equal((await s.me('dave')).can['guild.access'], undefined);
  // An unchanged sign-in writes no audit row; a changed one writes one.
  const syncs = async () => s.w.count('audit_log', "action = 'roles.discord_sync' AND entity_id = ?", s.ids.dave);
  assert.equal(await syncs(), 2);
  await s.signInAgain('dave');
  assert.equal(await syncs(), 2);
  const entry = (await s.w.rows("SELECT before, after, actor_user_id FROM audit_log WHERE action = 'roles.discord_sync' AND entity_id = ? ORDER BY rowid", s.ids.dave))[0];
  assert.deepEqual(JSON.parse(entry.after).roles.map((r) => r.roleId).sort(), [council, 'officer'].sort());
  assert.equal(entry.actor_user_id, s.ids.dave);
  assert(!entry.after.includes(PEOPLE.dave.id), 'no Discord user id in the audit log');
});

check('discord mapping: manual wins - a role set by hand stays when Discord stops giving it, shows once, and Discord never removes it', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }, { discordRoleId: D_RAIDLEADS, roleId: 'team_lead', teamId: s.A }])).status, 200);
  // Bob is a manual Officer; Discord says Officer too: two rows, one entry, and it is Bob's own (not marked as Discord).
  s.discordRoles('bob', [D_OFFICERS]);
  await s.signInAgain('bob');
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer'", s.ids.bob), 2);
  assert.deepEqual((await s.me('bob')).roles, [{ role: 'officer' }]);
  assert.deepEqual((await s.person('bob')).roles, [{ role: 'officer' }]);
  // Discord stops: only its row goes. Bob is still an Officer.
  s.discordRoles('bob', []);
  await s.signInAgain('bob');
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer' AND source = 'manual'", s.ids.bob), 1);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.ids.bob), 0);
  assert.equal((await s.me('bob')).can['guild.access'], 'guild');
  // Carol is a manual Team Lead; Discord gives her Officer. The Edit roles dialog works on her manual roles only.
  s.discordRoles('carol', [D_OFFICERS]);
  await s.signInAgain('carol');
  assert.deepEqual((await s.me('carol')).roles, [{ role: 'officer', fromDiscord: true }, { role: 'team_lead', teamId: s.A }]);
  assert.equal((await s.setRoles('carol', { officer: false, teamLeadTeamIds: [] })).status, 200, 'take the manual Team Lead away');
  assert.deepEqual((await s.person('carol')).roles, [{ role: 'officer', fromDiscord: true }], 'the Discord Officer stays: it is Discord\'s to take away');
  // An officer ticking Officer for Carol makes it hers: both rows, shown as hers.
  assert.equal((await s.setRoles('carol', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.deepEqual((await s.person('carol')).roles, [{ role: 'officer' }]);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND role_id = 'officer'", s.ids.carol), 2);
  // Un-ticking removes the manual one only; Discord's stays while she holds the Discord role.
  assert.equal((await s.setRoles('carol', { officer: false, teamLeadTeamIds: [] })).status, 200);
  assert.deepEqual((await s.person('carol')).roles, [{ role: 'officer', fromDiscord: true }]);
  // Saving the dialog for someone who holds a role only through Discord changes nothing (no audit row for it).
  s.discordRoles('dave', [D_OFFICERS]);
  await s.signInAgain('dave');
  const before = await s.w.count('audit_log', "action = 'roles.set'");
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [] })).status, 200);
  assert.equal(await s.w.count('audit_log', "action = 'roles.set'"), before);
  assert.equal((await s.me('dave')).can['guild.access'], 'guild');
  // Both rows for one team lead do not list the person twice on the team.
  s.discordRoles('erin', [D_RAIDLEADS]);
  await s.signInAgain('erin');
  assert.equal((await s.setRoles('erin', { officer: false, teamLeadTeamIds: [s.A] })).status, 200);
  const leads = (await s.call('alice', 'GET', '')).json.teams.find((t) => t.id === s.A).leads.map((p) => p.id);
  assert.equal(leads.filter((id) => id === s.ids.erin).length, 1);
});

check('discord mapping: a mapping that goes takes what it gave at once; a mapping to an archived team gives nothing; deleting the role drops its mapping', async () => {
  const s = await scenario();
  const council = await s.makeRole('Loot council', COUNCIL);
  assert.equal((await s.setMaps([
    { discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null },
    { discordRoleId: D_RAIDLEADS, roleId: 'team_lead', teamId: s.B },
    { discordRoleId: D_LOOT, roleId: council, teamId: null },
  ])).status, 200);
  s.discordRoles('dave', [D_OFFICERS, D_LOOT]);
  s.discordRoles('erin', [D_RAIDLEADS]);
  await s.signInAgain('dave');
  assert.equal(await s.w.count('role_assignments', "source = 'discord'"), 2);
  // Dropping the Officer mapping removes Dave's Discord Officer at once; the loot one stays; manual rows are not touched.
  const saved = await s.setMaps([{ discordRoleId: D_LOOT, roleId: council, teamId: null }, { discordRoleId: D_RAIDLEADS, roleId: 'team_lead', teamId: s.B }]);
  assert.equal(saved.json.cleared, 1);
  assert.deepEqual((await s.me('dave')).roles, [{ role: council, name: 'Loot council', fromDiscord: true }]);
  assert.equal(await s.w.count('role_assignments', "role_id = 'officer' AND source = 'manual'"), 1, 'Bob\'s own Officer');
  // Archive Bravo: Erin's Team Lead mapping points at an archived team and gives nothing.
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true })).status, 200);
  await s.signInAgain('erin');
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.erin), 0);
  // Deleting the custom role drops its mapping and what it gave.
  assert.equal((await s.call('alice', 'DELETE', `/roles/${council}`, {})).status, 200);
  assert.equal(await s.w.count('discord_role_maps', 'role_id = ?', council), 0);
  assert.deepEqual((await s.me('dave')).roles, []);
  assert.equal((await s.call('alice', 'GET', '/discord')).json.maps.length, 1);
});

check('discord sync: Sync now applies the mapping to one person on demand (officers with guild.access), and reports what changed', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  const sync = (name, who = 'bob') => s.w.call(s.jars[who], 'POST', `${s.guildPath}/people/${s.ids[name]}/sync`, {});
  // The People list offers it only for people who have Discord, to those who may use it, and only while a mapping and the bot exist.
  const alicesView = await s.people('alice');
  assert.equal(alicesView.discord.configured && alicesView.discord.mapped, true);
  assert.equal(alicesView.people.find((p) => p.person.id === s.ids.erin).actions.syncDiscord, true);
  assert.equal(alicesView.people.find((p) => p.person.id === s.ids.alice).actions.syncDiscord, undefined, 'not for the Guild Master');
  s.discordRoles('erin', [D_OFFICERS]);
  const first = await sync('erin');
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.sync, { status: 'changed', reason: null, added: 1, removed: 0 });
  assert.deepEqual(first.json.people.find((p) => p.person.id === s.ids.erin).roles, [{ role: 'officer', fromDiscord: true }]);
  assert.equal((await s.me('erin')).can['guild.access'], 'guild');
  assert.deepEqual((await sync('erin')).json.sync, { status: 'unchanged', reason: null, added: 0, removed: 0 });
  s.discordRoles('erin', []);
  assert.deepEqual((await sync('erin')).json.sync, { status: 'changed', reason: null, added: 0, removed: 1 });
  assert.equal((await s.me('erin')).can['guild.access'], undefined);
  // Left the Discord server (Unknown Member): what Discord gave goes.
  s.discordRoles('erin', [D_OFFICERS]);
  await sync('erin');
  delete s.w.discord.servers[SERVER_A].members[PEOPLE.erin.id];
  assert.deepEqual((await sync('erin')).json.sync, { status: 'changed', reason: null, added: 0, removed: 1 });
  // The Guild Master has nothing to sync; self sync works; others' rights.
  assert.deepEqual((await sync('alice')).json.sync, { status: 'skipped', reason: 'guild_master', added: 0, removed: 0 });
  assert.equal((await sync('bob')).status, 200);
  for (const who of ['carol', 'dave']) assert.equal((await sync('erin', who)).status, 403, who);
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${s.guildPath}/people/u_${'Q'.repeat(22)}/sync`, {})).status, 404);
  assert.equal((await s.w.call({}, 'POST', `${s.guildPath}/people/${s.ids.erin}/sync`, {})).status, 401);
  // A person who has not connected Discord has no Discord roles to read.
  s.w.db.sqlite.exec(`UPDATE users SET discord_id = NULL WHERE id = '${s.ids.gina}'`);
  const noDiscord = await sync('gina');
  assert.equal(noDiscord.status, 409);
  assert.equal(noDiscord.json.error, 'no_discord');
});

check('discord sync: nothing to read or nothing to apply is an honest error and changes nothing - no token, no mapping, bot not in the server, Discord down, bad token', async () => {
  const s = await scenario();
  const sync = (name = 'erin', who = 'bob') => s.w.call(s.jars[who], 'POST', `${s.guildPath}/people/${s.ids[name]}/sync`, {});
  // No mapping yet: no call to Discord.
  let calls = s.w.discord.botCalls.length;
  const none = await sync();
  assert.equal(none.status, 409);
  assert.equal(none.json.error, 'no_mapping');
  assert.equal(s.w.discord.botCalls.length, calls);
  assert.equal((await s.people()).people.find((p) => p.person.id === s.ids.erin).actions.syncDiscord, undefined);
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  // Dave holds a Discord-given Officer; every failed read below leaves it alone.
  s.discordRoles('dave', [D_OFFICERS]);
  assert.equal((await sync('dave')).json.sync.status, 'changed');
  const daveRoles = async () => (await s.me('dave')).roles;
  s.discordRoles('dave', []);
  const intact = async (label) => assert.deepEqual(await daveRoles(), [{ role: 'officer', fromDiscord: true }], label);
  s.w.discord.servers[SERVER_A].botIn = false;
  const missing = await sync('dave');
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error, 'bot_not_in_server');
  await intact('bot not in the server');
  s.w.discord.servers[SERVER_A].botIn = true;
  s.w.discord.outage = true;
  const down = await sync('dave');
  assert.equal(down.status, 502);
  assert.equal(down.json.error, 'discord_unavailable');
  await intact('Discord down');
  s.w.discord.outage = false;
  s.w.discord.botToken = 'rotated';
  const refused = await sync('dave');
  assert.equal(refused.status, 502);
  assert.match(refused.json.message, /DISCORD_BOT_TOKEN/);
  assert(!JSON.stringify([missing.json, down.json, refused.json]).includes(BOT_TOKEN));
  await intact('bad token');
  s.w.discord.botToken = BOT_TOKEN;
  assert.deepEqual((await sync('dave')).json.sync, { status: 'changed', reason: null, added: 0, removed: 1 }, 'and once Discord answers, the change lands');
  // No token configured at all.
  const bare = await scenario({ env: { DISCORD_BOT_TOKEN: '' } });
  assert.equal((await bare.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  const noBot = await bare.w.call(bare.jars.bob, 'POST', `${bare.guildPath}/people/${bare.ids.erin}/sync`, {});
  assert.equal(noBot.status, 400);
  assert.equal(noBot.json.error, 'bot_not_configured');
  assert.equal(bare.w.discord.botCalls.length, 0);
  assert.equal((await bare.people()).people.find((p) => p.person.id === bare.ids.erin).actions.syncDiscord, undefined);
  assert.equal((await bare.w.call(bare.jars.bob, 'POST', `${bare.guildPath}/discord/sync`, {})).json.error, 'bot_not_configured');
  // And sign-in still works with no token (the mapping simply does not run).
  await bare.signInAgain('erin');
  assert.equal(await bare.w.count('role_assignments', "source = 'discord'"), 0);
});

check('discord sync: Sync everyone runs 25 people a call with a cursor, counts what happened, and stops at a problem that would repeat', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  // 30 more people in the server, all holding the Officers role on Discord.
  const extra = [];
  for (let i = 0; i < 30; i++) {
    const id = `u_${String(i).padStart(2, '0')}${'k'.repeat(20)}`;
    const discordId = String(120000000000000000n + BigInt(i));
    s.w.db.sqlite.exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('${id}', '${id}', '${discordId}', 'extra${i}', 1, 1);
                        INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('${id}', '${SERVER_A}', 1)`);
    s.w.discord.servers[SERVER_A].members[discordId] = [D_OFFICERS];
    extra.push(id);
  }
  const run = (body, who = 'bob') => s.w.call(s.jars[who], 'POST', `${s.guildPath}/discord/sync`, body);
  const first = await run({});
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.json.processed, first.json.failed, first.json.problem], [25, 0, null]);
  assert.match(first.json.next, /^u_/);
  const second = await run({ after: first.json.next });
  // 6 original accounts + 30 = 36 with Discord in the server; the first 25 by id are done, the rest follow.
  assert.equal(first.json.processed + second.json.processed, 36);
  assert.equal(second.json.next, null);
  assert.equal(first.json.changed + second.json.changed, 30, 'the 30 who hold the Discord role');
  assert.equal(await s.w.count('role_assignments', "source = 'discord'"), 30);
  // A second run changes nothing (and the audit log gains nothing).
  const audited = await s.w.count('audit_log', "action = 'roles.discord_sync'");
  const again = await run({});
  assert.deepEqual([again.json.changed, again.json.unchanged + again.json.skipped], [0, again.json.processed]);
  assert.equal(await s.w.count('audit_log', "action = 'roles.discord_sync'"), audited);
  assert.equal((await s.w.rows("SELECT actor_user_id FROM audit_log WHERE action = 'roles.discord_sync' LIMIT 1"))[0].actor_user_id, s.ids.bob);
  // Guards: the cursor must be a person id; officers only; a problem that would repeat stops the run and says so.
  assert.equal((await run({ after: 'nonsense' })).status, 400);
  assert.equal((await run({}, 'dave')).status, 403);
  s.w.discord.servers[SERVER_A].botIn = false;
  const missing = await run({});
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error, 'bot_not_in_server');
  s.w.discord.servers[SERVER_A].botIn = true;
  assert.equal(await s.w.count('role_assignments', "source = 'discord'"), 30, 'nothing changed');
  // No mapping at all: an error, not a silent no-op.
  assert.equal((await s.setMaps([])).status, 200);
  assert.equal(await s.w.count('role_assignments', "source = 'discord'"), 0, 'emptying the mapping clears what it gave');
  assert.equal((await run({})).json.error, 'no_mapping');
});

check('discord sync: sign-in never fails because of Discord, skips blocked people and the Guild Master, and a person who left the server loses what Discord gave', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  s.discordRoles('dave', [D_OFFICERS]);
  await s.signInAgain('dave');
  assert.equal((await s.me('dave')).can['guild.access'], 'guild');
  // Discord down, a bad token or a bot that is not in the server: sign-in still succeeds, roles are untouched, the log says why without the token.
  s.discordRoles('dave', []);
  for (const [label, arm, undo] of [
    ['outage', () => { s.w.discord.outage = true; }, () => { s.w.discord.outage = false; }],
    ['bad token', () => { s.w.discord.botToken = 'rotated'; }, () => { s.w.discord.botToken = BOT_TOKEN; }],
    ['bot missing', () => { s.w.discord.servers[SERVER_A].botIn = false; }, () => { s.w.discord.servers[SERVER_A].botIn = true; }],
  ]) {
    arm();
    await s.signInAgain('dave');
    assert.equal((await s.w.call(s.jars.dave, 'GET', '/auth/me')).status, 200, `${label}: still signed in`);
    assert.deepEqual((await s.me('dave')).roles, [{ role: 'officer', fromDiscord: true }], label);
    undo();
  }
  assert(s.w.logs.some((line) => /discord role sync at sign-in: (unavailable|bad_token|bot_missing)/.test(line)));
  assert(!s.w.logs.join('\n').includes(BOT_TOKEN), 'the token is never logged');
  await s.signInAgain('dave');
  assert.deepEqual((await s.me('dave')).roles, [], 'and the next sign-in that Discord answers applies it');
  // The Guild Master holds no Discord rows even with the Discord role.
  s.discordRoles('alice', [D_OFFICERS]);
  await signIn(s.w, PEOPLE.alice, [manageable(SERVER_A)], s.jars.alice);
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.alice), 1, 'only the Guild Master row');
  // A blocked person gets nothing at sign-in, and Sync now refuses them.
  s.discordRoles('erin', [D_OFFICERS]);
  assert.equal((await s.call('alice', 'POST', `/people/${s.ids.erin}/block`, { reason: '' })).status, 200);
  await s.signInAgain('erin');
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.ids.erin), 0);
  assert.equal((await s.call('bob', 'POST', `/people/${s.ids.erin}/sync`, {})).status, 404);
  // Left the server: the sign-in that no longer lists it drops what Discord gave, with no call to Discord.
  s.discordRoles('gina', [D_OFFICERS]);
  await s.signInAgain('gina');
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.ids.gina), 1);
  const calls = s.w.discord.botCalls.length;
  await signIn(s.w, PEOPLE.gina, [], s.jars.gina);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.ids.gina), 0);
  assert.equal(s.w.discord.botCalls.length, calls, 'not in the server: nothing to ask Discord');
  // The bot token is never in an audit row.
  const audits = JSON.stringify(await s.w.rows('SELECT * FROM audit_log'));
  assert(!audits.includes(BOT_TOKEN));
});

check('discord sync: linking Discord to an account applies the mapping too', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  // Dave's account loses its Discord link (as a Battle.net-style account has none), stays in the guild through the server row, and links Discord again.
  s.discordRoles('dave', [D_OFFICERS]);
  s.w.db.sqlite.exec(`UPDATE users SET discord_id = NULL WHERE id = '${s.ids.dave}'`);
  assert.equal((await s.me('dave')).roles.length, 0);
  const jar = s.jars.dave;
  s.w.discord.next = { user: { id: PEOPLE.dave.id, username: 'dave', global_name: 'Dave D', avatar: null }, servers: [plain(SERVER_A)] };
  const login = await s.w.req('GET', '/auth/login?mode=link', { jar });
  const callback = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.match(callback.headers.get('Location'), /linked/);
  assert.deepEqual((await s.me('dave')).roles, [{ role: 'officer', fromDiscord: true }]);
});


// ---------------------------------------------------------------------------
// A guild with something to see: people on two teams (one with an officer note and Discord data), a past raid with attendance, an upcoming raid, loot.

const SECRETS = ['SECRET officer note', 'SecretNick', 'SECRET-REASON', 'SECRET LOOT NOTE', 'SecretMasterName', PEOPLE.dave.id, 'dave', 'discord', 'nickname'];

async function seedData(s) {
  const mk = async (teamId, name, cls, spec, extra = {}) => {
    const r = await s.call('alice', 'POST', '/roster', { teamId, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider', ...extra });
    assert.equal(r.status, 201, r.text);
    return r.json.person.id;
  };
  const people = {
    thoren: await mk(s.A, 'Thoren', 'PALADIN', 'Protection'),
    kaelith: await mk(s.A, 'Kaelith', 'ROGUE', 'Combat'),
    mirabel: await mk(s.B, 'Mirabel', 'HUNTER', 'Marksmanship'),
    oldtimer: await mk(s.A, 'Oldtimer', 'MAGE', 'Fire'),
  };
  // Officer-only and Discord-only data that must never reach a guest or the public.
  const notes = await s.call('alice', 'PUT', `/roster/${people.thoren}/notes`, { text: 'SECRET officer note: late twice', expectedNotesVersion: 0 });
  assert.equal(notes.status, 200, notes.text);
  s.w.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE.dave.id}', discord_nickname = 'SecretNick' WHERE id = '${people.thoren}'`);
  s.w.db.sqlite.exec(`UPDATE players SET status = 'inactive', left_on = '2027-01-02', left_reason = 'left' WHERE id = '${people.oldtimer}'`);
  s.w.db.sqlite.exec(`UPDATE players SET joined_on = '2026-12-01' WHERE guild_id = '${s.guildId}'`); // joined before the raid, so it counts
  const raid = await s.call('alice', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-10', zone: 'Karazhan' });
  assert.equal(raid.status, 201, raid.text);
  const manual = await s.call('alice', 'PUT', `/raids/${raid.json.raid.id}/manual`, { reason: 'No log SECRET-REASON', presentPlayerIds: [people.thoren] });
  assert.equal(manual.status, 200, manual.text);
  const upcoming = await s.call('alice', 'POST', '/raids', { teamId: s.A, raidOn: '2027-01-20', zone: 'Gruul\'s Lair', title: 'Gruul night' });
  assert.equal(upcoming.status, 201, upcoming.text);
  const other = await s.call('alice', 'POST', '/raids', { teamId: s.B, raidOn: '2027-01-21', zone: 'Magtheridon\'s Lair' });
  assert.equal(other.status, 201, other.text);
  const award = (n, name, cls, extra) => `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, winner_class, roll_type, tag, note, awarded_by, created_at, updated_at)
    VALUES ('lo_${String(n).padStart(22, '0')}', '${s.guildId}', '${raid.json.raid.id}', '${s.A}', 'checksum${n}xx', ${30000 + n}, 'Item ${n}', 4, ${1_799_000_000_000 + n}, ${name ? `'${name}'` : 'NULL'}, ${name ? `'${name.toLowerCase()}'` : 'NULL'}, ${name ? "'Dreamscythe'" : 'NULL'}, ${name ? "'dreamscythe'" : "''"}, ${cls ? `'${cls}'` : 'NULL'}, 'MS', ${extra}, 'SECRET LOOT NOTE', 'SecretMasterName', 1, 1)`;
  s.w.db.sqlite.exec(award(1, 'Thoren', 'PALADIN', "'MS'"));
  s.w.db.sqlite.exec(award(2, null, null, "'DE'"));
  return { people, raid: raid.json.raid.id, upcoming: upcoming.json.raid.id };
}

const teamIdsIn = (list) => list.map((entry) => entry.team.id).sort();
const names = (section) => section.flatMap((entry) => entry.people.map((p) => p.name)).sort();

// ---------------------------------------------------------------------------
// Guest links

check('guest links: an officer makes a link; the token is shown once and only its SHA-256 is kept; the list and the audit log never hold it', async () => {
  const s = await scenario();
  const made = await s.call('bob', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d', label: 'Recruits' });
  assert.equal(made.status, 201, made.text);
  const { token, id, path: link } = made.json.created;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(link, `/#/guest/${token}`);
  assert.match(id, /^gl_[A-Za-z0-9_-]{22}$/);
  const row = (await s.w.rows('SELECT * FROM guest_links WHERE id = ?', id))[0];
  assert.equal(row.token_hash, sha256hex(token));
  assert.equal(JSON.stringify(row).includes(token), false, 'the token is not in the database');
  assert.deepEqual([row.role_id, row.team_id, row.label, row.uses, row.last_used_at, row.revoked_at, row.created_by], ['guest', null, 'Recruits', 0, null, null, s.ids.bob]);
  assert.equal(row.expires_at, s.w.clock.now + 7 * DAY);
  // The answer lists the link without the token, the hash, or anything to build the URL from.
  const link0 = made.json.links.find((l) => l.id === id);
  assert.deepEqual(Object.keys(link0).sort(), ['createdAt', 'createdBy', 'expiresAt', 'id', 'label', 'lastUsedAt', 'revokedAt', 'role', 'sections', 'status', 'team', 'uses']);
  assert.deepEqual([link0.status, link0.role, link0.team, link0.uses, link0.sections], ['active', { id: 'guest', name: 'Guest' }, null, 0, ['roster', 'raids', 'attendance']]);
  assert.equal(link0.createdBy.id, s.ids.bob);
  const list = await s.call('alice', 'GET', '/guest-links');
  assert.equal(list.status, 200);
  assert.equal(list.json.created, undefined, 'the token comes back once');
  for (const text of [list.text, JSON.stringify(made.json.links)]) assert(!text.includes(token) && !text.includes(row.token_hash));
  assert.deepEqual(list.json.roles, [{ id: 'guest', name: 'Guest', sections: ['roster', 'raids', 'attendance'] }]);
  assert.deepEqual(list.json.expiries, ['1d', '7d', '30d', 'never']);
  // Audit: who made it and what it grants, never the token or its hash.
  const audit = (await s.w.rows("SELECT * FROM audit_log WHERE action = 'guest.create'"))[0];
  assert.deepEqual([audit.entity_type, audit.entity_id, audit.actor_user_id, audit.guild_id], ['guest_link', id, s.ids.bob, s.guildId]);
  assert.deepEqual(JSON.parse(audit.after), { roleId: 'guest', teamId: null, expiresAt: row.expires_at, labelSet: true });
  const everything = JSON.stringify(await s.w.rows('SELECT * FROM audit_log')) + s.w.logs.join('\n');
  assert(!everything.includes(token) && !everything.includes(row.token_hash));
  // Each expiry, the default role, no label.
  const expiries = {};
  for (const [name, ms] of [['1d', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY], ['never', null]]) {
    const r = await s.call('alice', 'POST', '/guest-links', { expiresIn: name });
    assert.equal(r.status, 201, name);
    expiries[name] = (await s.w.rows('SELECT expires_at, role_id, label FROM guest_links WHERE id = ?', r.json.created.id))[0];
    assert.equal(expiries[name].expires_at, ms === null ? null : s.w.clock.now + ms);
    assert.deepEqual([expiries[name].role_id, expiries[name].label], ['guest', null]);
  }
  // Tokens are random: no two links share one.
  assert.equal(new Set((await s.w.rows('SELECT token_hash FROM guest_links')).map((r) => r.token_hash)).size, 5);
});

check('guest links: who may make them, and what they are checked against - the role, the team, the expiry, the label, the cap', async () => {
  const s = await scenario();
  const create = (body, who = 'bob') => s.call(who, 'POST', '/guest-links', body);
  // guild.access only: Officers and the Guild Master.
  assert.equal((await create({ expiresIn: '1d' }, 'alice')).status, 201);
  for (const who of ['carol', 'dave']) assert.equal((await create({ expiresIn: '1d' }, who)).status, 403, who);
  assert.equal((await s.call('carol', 'GET', '/guest-links')).status, 403);
  assert.equal((await s.call('carol', 'DELETE', `/guest-links/gl_${'Q'.repeat(22)}`, {})).status, 403);
  assert.equal((await s.w.call({}, 'POST', `${s.guildPath}/guest-links`, { expiresIn: '1d' })).status, 401);
  // The expiry is required and one of the four.
  for (const expiresIn of [undefined, null, '', '2d', 7, 'forever']) assert.equal((await create({ expiresIn })).status, 400, String(expiresIn));
  // The role: Guest (default) or one of the guild's own that can see something a guest link shows. Never a staff, Member or Public role.
  for (const roleId of ['officer', 'team_lead', 'member', 'public', 'guild_master', 5, {}]) {
    const r = await create({ roleId, expiresIn: '1d' });
    assert.equal(r.status, 400, JSON.stringify(roleId));
    assert.equal(r.json.field, 'roleId');
  }
  const blank = await s.makeRole('Scribe', { 'roster.notes.view': 'guild' });
  const noView = await create({ roleId: blank, expiresIn: '1d' });
  assert.equal(noView.status, 400);
  assert.match(noView.json.message, /can see nothing a guest link shows/);
  const viewer = await s.makeRole('Observer', { 'loot.view': 'guild', 'roster.edit': 'guild' });
  const ok = await create({ roleId: viewer, expiresIn: '1d' });
  assert.equal(ok.status, 201, 'a role with some view action works; only its view actions ever reach a guest');
  assert.deepEqual(ok.json.links.find((l) => l.id === ok.json.created.id).sections, ['loot']);
  // Teams: an active team of this guild or none.
  assert.equal((await create({ teamId: s.A, expiresIn: '1d' })).status, 201);
  assert.equal((await create({ teamId: 't_Zzzzzzzzzzzzzzzzzzzzzz', expiresIn: '1d' })).status, 400);
  assert.equal((await create({ teamId: 5, expiresIn: '1d' })).status, 400);
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.B}`, { archived: true })).status, 200);
  assert.equal((await create({ teamId: s.B, expiresIn: '1d' })).status, 400, 'an archived team');
  // The label: at most 40 characters of plain text.
  assert.equal((await create({ expiresIn: '1d', label: 'x'.repeat(41) })).status, 400);
  assert.equal((await create({ expiresIn: '1d', label: 'tab\there' })).status, 400);
  assert.equal((await create({ expiresIn: '1d', label: '   ' })).status, 201);
  assert.equal((await create({ expiresIn: '1d', label: 5 })).status, 400);
  // The cap: 50 links that still work. Revoked and expired ones do not count.
  s.w.advance(61_000);
  const live = await s.w.count('guest_links', 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', s.w.clock.now);
  for (let i = live; i < 50; i++) {
    s.w.db.sqlite.exec(`INSERT INTO guest_links (id, guild_id, token_hash, role_id, created_by, created_at) VALUES ('gl_cap${String(i).padStart(19, '0')}', '${s.guildId}', 'hash${i}', 'guest', '${s.ids.bob}', 1)`);
  }
  const over = await create({ expiresIn: '1d' });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /at most 50/);
  s.w.db.sqlite.exec(`UPDATE guest_links SET revoked_at = 5 WHERE id = 'gl_cap${String(49).padStart(19, '0')}'`);
  assert.equal((await create({ expiresIn: '1d' })).status, 201, 'a revoked link frees a place');
});

check('guest links: redeeming starts a guest session (a cookie), counts the use, and the link is checked again on every request - revoke and expiry bite at once', async () => {
  const s = await scenario();
  const made = await s.call('bob', 'POST', '/guest-links', { expiresIn: '7d' });
  const { token, id } = made.json.created;
  const guest = {};
  const redeem = await s.w.call(guest, 'POST', '/auth/guest', { token });
  assert.equal(redeem.status, 200, redeem.text);
  assert.deepEqual(redeem.json, { ok: true });
  const cookie = redeem.headers.getSetCookie().find((line) => line.startsWith('__Host-rs_guest='));
  assert(cookie, 'a __Host- cookie');
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert(cookie.includes(attribute), attribute);
  assert(!cookie.includes('Domain'), '__Host- cookies have no Domain');
  assert.equal(guest['__Host-rs_guest'], token);
  assert.equal(Number(/Max-Age=(\d+)/.exec(cookie)[1]), 7 * 24 * 3600, 'lives as long as the link');
  let row = (await s.w.rows('SELECT uses, last_used_at FROM guest_links WHERE id = ?', id))[0];
  assert.deepEqual(row, { uses: 1, last_used_at: s.w.clock.now });
  assert.equal((await s.w.call(guest, 'GET', '/api/guest')).status, 200);
  assert.equal((await s.w.rows('SELECT uses FROM guest_links WHERE id = ?', id))[0].uses, 1, 'only opening the link counts, not each request');
  s.w.advance(3600_000);
  await s.w.call({}, 'POST', '/auth/guest', { token });
  row = (await s.w.rows('SELECT uses, last_used_at FROM guest_links WHERE id = ?', id))[0];
  assert.deepEqual(row, { uses: 2, last_used_at: s.w.clock.now });
  assert.deepEqual([(await s.call('alice', 'GET', '/guest-links')).json.links.find((l) => l.id === id)].map((l) => [l.uses, l.lastUsedAt]), [[2, s.w.clock.now]]);

  // A token nobody made, a malformed one, none: the same 404, and nothing is counted.
  for (const bad of [`${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`, 'short', 'x'.repeat(43), '', undefined, 5, null]) {
    const r = await s.w.call({}, 'POST', '/auth/guest', { token: bad });
    assert.equal(r.status, 404, String(bad));
    assert.equal(r.json.error, 'link_invalid');
  }
  assert.equal((await s.w.call({}, 'GET', '/api/guest')).status, 404, 'no cookie');
  assert.equal((await s.w.call({ '__Host-rs_guest': 'x'.repeat(43) }, 'GET', '/api/guest')).json.error, 'link_invalid');
  assert.equal((await s.w.call({ '__Host-rs_guest': 'garbage' }, 'GET', '/api/guest')).json.error, 'link_invalid');
  assert.equal((await s.w.rows('SELECT uses FROM guest_links WHERE id = ?', id))[0].uses, 2);

  // Revoke: the very next request of an open guest session fails, and the link cannot be opened again.
  assert.equal((await s.call('bob', 'DELETE', `/guest-links/${id}`, {})).status, 200);
  const gone = await s.w.call(guest, 'GET', '/api/guest');
  assert.deepEqual([gone.status, gone.json.error], [410, 'link_revoked']);
  const again = await s.w.call({}, 'POST', '/auth/guest', { token });
  assert.deepEqual([again.status, again.json.error], [410, 'link_revoked']);
  assert.equal((await s.w.rows('SELECT uses FROM guest_links WHERE id = ?', id))[0].uses, 2, 'a turned-off link counts nothing');
  const listed = (await s.call('alice', 'GET', '/guest-links')).json.links.find((l) => l.id === id);
  assert.deepEqual([listed.status, listed.revokedAt], ['revoked', s.w.clock.now]);
  assert.equal((await s.call('bob', 'DELETE', `/guest-links/${id}`, {})).status, 200, 'revoking twice is fine');
  assert.equal(await s.w.count('audit_log', "action = 'guest.revoke'"), 1, 'and audited once');

  // Expiry: a link stops working the second it runs out, open sessions included.
  const second = (await s.call('bob', 'POST', '/guest-links', { expiresIn: '1d' })).json.created;
  const jar2 = {};
  await s.w.call(jar2, 'POST', '/auth/guest', { token: second.token });
  assert.equal(Number(/Max-Age=(\d+)/.exec((await s.w.req('POST', '/auth/guest', { body: { token: second.token } })).headers.getSetCookie()[0])[1]), 24 * 3600);
  assert.equal((await s.w.call(jar2, 'GET', '/api/guest')).status, 200);
  s.w.advance(DAY - 1);
  assert.equal((await s.w.call(jar2, 'GET', '/api/guest')).status, 200, 'one second left');
  s.w.advance(1);
  const expired = await s.w.call(jar2, 'GET', '/api/guest');
  assert.deepEqual([expired.status, expired.json.error], [410, 'link_expired']);
  assert.deepEqual([(await s.w.call({}, 'POST', '/auth/guest', { token: second.token })).json.error], ['link_expired']);
  assert.equal((await s.call('alice', 'GET', '/guest-links')).json.links.find((l) => l.id === second.id).status, 'expired');
  // Never expires: the cookie lasts 30 days.
  const never = (await s.call('bob', 'POST', '/guest-links', { expiresIn: 'never' })).json.created;
  assert.equal(Number(/Max-Age=(\d+)/.exec((await s.w.req('POST', '/auth/guest', { body: { token: never.token } })).headers.getSetCookie()[0])[1]), 30 * 24 * 3600);
  s.w.advance(400 * DAY);
  assert.equal((await s.w.call({ '__Host-rs_guest': never.token }, 'GET', '/api/guest')).status, 200);
  // Leaving clears the cookie.
  const leave = await s.w.req('DELETE', '/auth/guest', { body: {} });
  assert(leave.headers.getSetCookie().some((line) => /^__Host-rs_guest=; Max-Age=0/.test(line)));
});

check('guest links: a guest is never an account and can only read - no session, no write route answers, the guest cookie is no sign-in', async () => {
  const s = await scenario();
  const data = await seedData(s);
  const { token } = (await s.call('bob', 'POST', '/guest-links', { expiresIn: '7d' })).json.created;
  const accounts = await s.w.count('users');
  const sessions = await s.w.count('sessions');
  const guest = {};
  assert.equal((await s.w.call(guest, 'POST', '/auth/guest', { token })).status, 200);
  assert.equal((await s.w.call(guest, 'GET', '/api/guest')).status, 200);
  assert.equal(await s.w.count('users'), accounts, 'no account');
  assert.equal(await s.w.count('sessions'), sessions, 'no session');
  const g = s.guildPath;
  const attempts = [
    ['GET', '/auth/me'], ['GET', g], ['GET', `${g}/roster?team=${s.A}`], ['GET', `${g}/raids?team=${s.A}`], ['GET', `${g}/attendance/team?team=${s.A}`],
    ['GET', `${g}/loot/items?team=${s.A}`], ['GET', `${g}/people`], ['GET', `${g}/roles`], ['GET', `${g}/discord`], ['GET', `${g}/guest-links`], ['GET', `${g}/public`],
    ['POST', `${g}/roster`, { teamId: s.A, name: 'Intruder', class: 'MAGE', mainSpec: null, offSpec: null, status: 'raider' }],
    ['PATCH', `${g}/roster/${data.people.thoren}`, { status: 'inactive' }], ['PUT', `${g}/roster/${data.people.thoren}/notes`, { text: 'x', expectedNotesVersion: 1 }],
    ['DELETE', `${g}/roster/${data.people.thoren}`, {}], ['POST', `${g}/raids`, { teamId: s.A, raidOn: '2027-02-01' }], ['DELETE', `${g}/raids/${data.raid}`, {}],
    ['PUT', `${g}/raids/${data.upcoming}/signup`, { kind: 'signed' }], ['POST', `${g}/teams`, { name: 'Guests team' }], ['PUT', `${g}/people/${s.ids.dave}/roles`, { officer: true, teamLeadTeamIds: [] }],
    ['POST', `${g}/people/${s.ids.dave}/block`, { reason: '' }], ['POST', `${g}/roles`, { name: 'Rogue', permissions: {} }], ['PUT', `${g}/discord/maps`, { maps: [] }],
    ['POST', `${g}/guest-links`, { expiresIn: '1d' }], ['PUT', `${g}/public`, { enabled: true, sections: ['roster'] }], ['POST', '/auth/logout', {}], ['DELETE', '/auth/me', { deleteGuildIds: [] }],
    ['PATCH', '/auth/prefs', { sidebarCollapsed: true }], ['PATCH', '/api/me', { displayName: 'Guest' }], ['POST', '/api/guild', { serverId: SERVER_A }],
  ];
  for (const [method, route, body] of attempts) {
    const r = await s.w.call(guest, method, route, body);
    assert.equal(r.status, 401, `${method} ${route} -> ${r.status} ${r.text}`);
  }
  // The guest token is not a session either, as any cookie.
  assert.equal((await s.w.call({ '__Host-rs_session': token }, 'GET', '/auth/me')).status, 401);
  // The guest routes themselves: reading is GET only.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await s.w.call(guest, method, '/api/guest', {})).status, 405, method);
  assert.equal((await s.w.call(guest, 'GET', '/auth/guest')).status, 405);
  assert.equal((await s.w.call(guest, 'PUT', '/auth/guest', {})).status, 405);
  assert.equal((await s.w.call(guest, 'POST', `/api/public/${s.guildId}`, {})).status, 405);
  // A cross-site page cannot open a link for a visitor.
  assert.equal((await s.w.call({}, 'POST', '/auth/guest', { token }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).json.error, 'cross_site');
  assert.equal((await s.w.call({}, 'POST', '/auth/guest', undefined, { headers: { 'Content-Type': 'text/plain' }, rawBody: JSON.stringify({ token }) })).status, 415);
  // Nothing the guest did changed the guild.
  assert.equal(await s.w.count('players', 'guild_id = ?', s.guildId), 4);
  assert.equal(await s.w.count('teams', 'guild_id = ?', s.guildId), 2);
  assert.equal(await s.w.count('users'), accounts);
});

check('guest links: a guest sees what the role allows - teams, sections, live edits of the role, an archived team, a deleted role', async () => {
  const s = await scenario();
  const data = await seedData(s);
  const open = async (body, who = 'bob') => {
    const made = await s.call(who, 'POST', '/guest-links', { expiresIn: '7d', ...body });
    assert.equal(made.status, 201, made.text);
    const jar = {};
    assert.equal((await s.w.call(jar, 'POST', '/auth/guest', { token: made.json.created.token })).status, 200);
    return { jar, id: made.json.created.id, view: async () => { const r = await s.w.call(jar, 'GET', '/api/guest'); assert.equal(r.status, 200, r.text); return r.json; } };
  };
  // The default Guest role on a link for the whole guild: roster, raids, attendance (its team scope reaches every team); no loot.
  const wide = await open({});
  const all = await wide.view();
  assert.deepEqual(all.viewer, { kind: 'guest', role: { id: 'guest', name: 'Guest' }, team: null, expiresAt: s.w.clock.now + 7 * DAY });
  assert.deepEqual(Object.keys(all.sections).sort(), ['attendance', 'raids', 'roster']);
  assert.deepEqual(teamIdsIn(all.sections.roster), [s.A, s.B].sort());
  assert.deepEqual(names(all.sections.roster), ['Kaelith', 'Mirabel', 'Thoren']);
  assert.deepEqual(all.teams.map((t) => t.id).sort(), [s.A, s.B].sort());
  // A link for one team narrows every section to it (the role's guild-wide grants too).
  const alpha = await open({ teamId: s.A });
  const one = await alpha.view();
  assert.deepEqual(one.viewer.team, { id: s.A, name: 'Alpha' });
  assert.deepEqual(teamIdsIn(one.sections.roster), [s.A]);
  assert.deepEqual(names(one.sections.roster), ['Kaelith', 'Thoren']);
  assert.deepEqual(teamIdsIn(one.sections.raids), [s.A]);
  assert.deepEqual(teamIdsIn(one.sections.attendance), [s.A]);
  assert.deepEqual(one.teams, [{ id: s.A, name: 'Alpha' }]);
  assert.deepEqual(one.sections.raids[0].upcoming.map((r) => [r.raidOn, r.zone, r.title]), [['2027-01-20', 'Gruul\'s Lair', 'Gruul night']]);
  assert.deepEqual(one.sections.raids[0].recent.map((r) => [r.raidOn, r.zone]), [['2027-01-10', 'Karazhan']]);
  const bravo = await open({ teamId: s.B });
  assert.deepEqual(names((await bravo.view()).sections.roster), ['Mirabel']);
  // A role of the guild's own: only its view actions count, narrowed the same way.
  const council = await s.makeRole('Loot council', { 'loot.view': 'guild', 'loot.edit': 'guild', 'roster.edit': 'guild', 'roster.notes.view': 'guild' });
  const loot = await open({ roleId: council, teamId: s.A });
  const lootView = await loot.view();
  assert.deepEqual(Object.keys(lootView.sections), ['loot'], 'edit and notes actions never reach a guest');
  assert.deepEqual(lootView.sections.loot[0].awards.map((a) => [a.itemName, a.winner, a.disenchanted]).sort(), [['Item 1', 'Thoren', false], ['Item 2', null, true]]);
  // The role is live: edit it and the open guest sees the change on the next request.
  assert.equal((await s.call('alice', 'PUT', `/roles/${council}`, { name: 'Loot council', permissions: { 'loot.edit': 'guild', 'roster.view': 'guild' } })).status, 200);
  assert.deepEqual(Object.keys((await loot.view()).sections), ['roster'], 'loot.view went, roster.view came');
  // The built-in Guest role is editable per guild too: take roster.view away and every Guest link loses the roster.
  const guestRole = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'guest');
  const trimmed = { ...guestRole.permissions };
  delete trimmed['roster.view'];
  assert.equal((await s.call('alice', 'PUT', '/roles/guest', { permissions: trimmed })).status, 200);
  assert.deepEqual(Object.keys((await wide.view()).sections).sort(), ['attendance', 'raids']);
  assert.deepEqual(Object.keys((await alpha.view()).sections).sort(), ['attendance', 'raids']);
  // Archive the team: a link for it shows nothing but still opens (the guild has not turned it off).
  assert.equal((await s.call('alice', 'PATCH', `/teams/${s.A}`, { archived: true })).status, 200);
  const archived = await alpha.view();
  assert.deepEqual([archived.sections, archived.teams], [{}, []]);
  // Delete the role: its links go with it.
  assert.equal((await s.call('alice', 'DELETE', `/roles/${council}`, {})).status, 200);
  const dead = await s.w.call(loot.jar, 'GET', '/api/guest');
  assert.deepEqual([dead.status, dead.json.error], [404, 'link_invalid']);
  assert.equal(await s.w.count('guest_links', 'id = ?', loot.id), 0);
});

check('the read-only view never carries officer notes, Discord data or account data - guest and public alike, with the exact fields pinned', async () => {
  const s = await scenario();
  const data = await seedData(s);
  const viewer = await s.makeRole('Everything', { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': 'guild', 'loot.view': 'guild', 'roster.notes.view': 'guild', 'roster.edit': 'guild' });
  const guestToken = (await s.call('bob', 'POST', '/guest-links', { roleId: viewer, expiresIn: '1d' })).json.created.token;
  const guestJar = {};
  await s.w.call(guestJar, 'POST', '/auth/guest', { token: guestToken });
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids', 'attendance', 'loot'] })).status, 200);
  const guest = await s.w.call(guestJar, 'GET', '/api/guest');
  const pub = await s.w.call({}, 'GET', `/api/public/${s.guildId}`);
  assert.equal(guest.status, 200);
  assert.equal(pub.status, 200);
  for (const [label, response] of [['guest', guest], ['public', pub]]) {
    for (const secret of SECRETS) assert(!response.text.toLowerCase().includes(secret.toLowerCase()), `${label} view leaks ${secret}`);
    const view = response.json;
    assert.deepEqual(Object.keys(view).sort(), ['guild', 'sections', 'teams', 'viewer'], label);
    assert.deepEqual(Object.keys(view.guild).sort(), ['gameVersion', 'name', 'realm', 'realmKind', 'region', 'timeZone'], label);
    assert.deepEqual(Object.keys(view.sections).sort(), ['attendance', 'loot', 'raids', 'roster'], label);
    for (const entry of view.sections.roster) {
      assert.deepEqual(Object.keys(entry).sort(), ['people', 'team']);
      for (const person of entry.people) assert.deepEqual(Object.keys(person).sort(), ['class', 'name', 'role'], label);
    }
    for (const entry of view.sections.raids) {
      assert.deepEqual(Object.keys(entry).sort(), ['recent', 'team', 'upcoming']);
      for (const raid of [...entry.upcoming, ...entry.recent]) assert.deepEqual(Object.keys(raid).sort(), ['raidOn', 'startsAt', 'title', 'zone'], label);
    }
    for (const entry of view.sections.attendance) {
      assert.deepEqual(Object.keys(entry).sort(), ['people', 'raids', 'team', 'window']);
      for (const person of entry.people) assert.deepEqual(Object.keys(person).sort(), ['class', 'counted', 'name', 'pct'], label);
    }
    for (const entry of view.sections.loot) {
      assert.deepEqual(Object.keys(entry).sort(), ['awards', 'team']);
      for (const award of entry.awards) assert.deepEqual(Object.keys(award).sort(), ['awardedAt', 'disenchanted', 'itemId', 'itemName', 'quality', 'winner', 'winnerClass'], label);
    }
    // The inactive person is not on the roster or the attendance list.
    assert(!names(view.sections.roster).includes('Oldtimer') && !view.sections.attendance.flatMap((e) => e.people.map((p) => p.name)).includes('Oldtimer'), label);
    // Thoren came to the one raid: 100% of 1.
    const thoren = view.sections.attendance.find((e) => e.team.id === s.A).people.find((p) => p.name === 'Thoren');
    assert.deepEqual([thoren.pct, thoren.counted, thoren.class], [100, 1, 'PALADIN'], label);
    assert.equal(view.sections.roster.find((e) => e.team.id === s.A).people.find((p) => p.name === 'Thoren').role, 'tank');
  }
  // The same officer who sees notes in the app gets none through a guest link.
  const app = await s.call('alice', 'GET', `/roster/${data.people.thoren}`);
  assert(app.text.includes('SECRET officer note'), 'the app does show the note to an officer (so the check above means something)');
});

check('guest links: cross-guild isolation - a link opens only its own guild, and another guild\'s officers cannot list, make or turn off links here', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  await seedData(s);
  const mine = (await s.call('bob', 'POST', '/guest-links', { expiresIn: '7d' })).json.created;
  const theirs = (await other.call('POST', '/guest-links', { expiresIn: '7d' })).json.created;
  const jarMine = {};
  const jarTheirs = {};
  await s.w.call(jarMine, 'POST', '/auth/guest', { token: mine.token });
  await s.w.call(jarTheirs, 'POST', '/auth/guest', { token: theirs.token });
  const a = (await s.w.call(jarMine, 'GET', '/api/guest')).json;
  const b = (await s.w.call(jarTheirs, 'GET', '/api/guest')).json;
  assert.equal(a.guild.name, 'Ember');
  assert.equal(b.guild.name, 'Other');
  assert(!JSON.stringify(b).includes('Thoren') && !JSON.stringify(b).includes('Kaelith'), 'their guest sees none of my people');
  assert(!JSON.stringify(a).includes('Their council'));
  // Turn off a link of the other guild through my guild's path, and the reverse: 404, nothing changes.
  assert.equal((await s.call('alice', 'DELETE', `/guest-links/${theirs.id}`, {})).status, 404);
  assert.equal((await other.call('DELETE', `/guest-links/${mine.id}`, {})).status, 404);
  assert.equal(await s.w.count('guest_links', 'revoked_at IS NOT NULL'), 0);
  // Lists show only their own guild's links; a Guild Master of one has no standing in the other.
  assert.deepEqual((await s.call('alice', 'GET', '/guest-links')).json.links.map((l) => l.id), [mine.id]);
  assert.deepEqual((await other.call('GET', '/guest-links')).json.links.map((l) => l.id), [theirs.id]);
  assert.equal((await s.w.call(s.jars.alice, 'GET', `${other.path}/guest-links`)).status, 403);
  assert.equal((await s.w.call(s.jars.alice, 'DELETE', `${other.path}/guest-links/${theirs.id}`, {})).status, 403);
  // My officer making a link on their path: not a member there.
  assert.equal((await s.w.call(s.jars.bob, 'POST', `${other.path}/guest-links`, { expiresIn: '1d' })).status, 403);
  // Turning off my link kills mine and leaves theirs.
  await s.call('alice', 'DELETE', `/guest-links/${mine.id}`, {});
  assert.equal((await s.w.call(jarMine, 'GET', '/api/guest')).status, 410);
  assert.equal((await s.w.call(jarTheirs, 'GET', '/api/guest')).status, 200);
});

// ---------------------------------------------------------------------------
// The public page

check('public page: off by default (a 404 like a guild that does not exist), Guild Master only, sections chosen, the Public role as the ceiling', async () => {
  const s = await scenario();
  await seedData(s);
  const url = `/api/public/${s.guildId}`;
  const visit = (jar = {}) => s.w.call(jar, 'GET', url);
  const off = await visit();
  assert.deepEqual([off.status, off.json.error], [404, 'not_found']);
  const unknown = await s.w.call({}, 'GET', `/api/public/g_${'Q'.repeat(22)}`);
  assert.deepEqual([unknown.status, unknown.json], [404, off.json], 'a guild that does not exist answers the same');
  assert.equal((await s.w.call({}, 'GET', '/api/public/nonsense')).status, 404);
  // The settings: off, nothing chosen, everything the Public role holds allowed.
  const settings = await s.call('alice', 'GET', '/public');
  assert.deepEqual(settings.json, { enabled: false, sections: [], allowed: { roster: true, raids: true, progress: true, attendance: true, loot: true }, path: `/#/public/${s.guildId}` });
  // Only the Guild Master (guild.roles).
  for (const who of ['bob', 'carol', 'dave']) {
    assert.equal((await s.call(who, 'GET', '/public')).status, 403, who);
    assert.equal((await s.call(who, 'PUT', '/public', { enabled: true, sections: ['roster'] })).status, 403, who);
  }
  assert.equal((await s.w.call({}, 'PUT', `${s.guildPath}/public`, { enabled: true, sections: [] })).status, 401);
  // On, with only the roster and raids chosen.
  const on = await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['raids', 'roster'] });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual([on.json.enabled, on.json.sections], [true, ['roster', 'raids']], 'in the page\'s own order');
  const view = await visit();
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.json.viewer, { kind: 'public' });
  assert.deepEqual(Object.keys(view.json.sections).sort(), ['raids', 'roster']);
  assert.deepEqual(names(view.json.sections.roster), ['Kaelith', 'Mirabel', 'Thoren']);
  assert.equal(view.json.guild.name, 'Ember');
  // No cookie is needed; a guest cookie or another guild's member makes no difference.
  const other = await secondGuild(s);
  assert.equal((await visit(other.jar)).text, view.text);
  assert.equal((await visit(s.jars.dave)).text, view.text);
  // Everything ticked. The Public role is the ceiling: take loot.view away from it and loot closes, even though it stays ticked.
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids', 'attendance', 'loot'] })).status, 200);
  assert.deepEqual(Object.keys((await visit()).json.sections).sort(), ['attendance', 'loot', 'raids', 'roster']);
  const publicRole = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'public');
  const noLoot = { ...publicRole.permissions };
  delete noLoot['loot.view'];
  assert.equal((await s.call('alice', 'PUT', '/roles/public', { permissions: noLoot })).status, 200);
  assert.deepEqual(Object.keys((await visit()).json.sections).sort(), ['attendance', 'raids', 'roster'], 'loot is closed by the ceiling');
  const closed = await s.call('alice', 'GET', '/public');
  assert.deepEqual(closed.json.allowed, { roster: true, raids: true, progress: true, attendance: true, loot: false });
  assert.deepEqual(closed.json.sections, ['roster', 'raids', 'attendance', 'loot'], 'the choice is kept');
  const refused = await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['loot'] });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Public role does not allow loot/);
  assert.equal((await s.call('alice', 'PUT', '/roles/public', { permissions: publicRole.permissions })).status, 200);
  assert.deepEqual(Object.keys((await visit()).json.sections).sort(), ['attendance', 'loot', 'raids', 'roster']);
  // Validation.
  for (const body of [{ enabled: 'yes', sections: [] }, { enabled: true }, { enabled: true, sections: 'roster' }, { enabled: true, sections: ['notes'] }, { enabled: true, sections: [5] }, {}]) {
    assert.equal((await s.call('alice', 'PUT', '/public', body)).status, 400, JSON.stringify(body));
  }
  // Off again: a 404 as at the start. On with no sections: the page exists and shows nothing.
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: [] })).status, 200);
  const empty = await visit();
  assert.deepEqual([empty.status, empty.json.sections, empty.json.teams], [200, {}, []]);
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: false, sections: ['roster'] })).status, 200);
  assert.equal((await visit()).status, 404);
  // Audited: every change of the page.
  const audit = await s.w.rows("SELECT before, after FROM audit_log WHERE action = 'public.update' ORDER BY rowid");
  assert.equal(audit.length, 4, 'a refused change and a change that changes nothing write no row');
  assert.deepEqual(JSON.parse(audit[0].before), { enabled: false, sections: [] });
  assert.deepEqual(JSON.parse(audit[0].after), { enabled: true, sections: ['roster', 'raids'] });
  assert.deepEqual(JSON.parse(audit[3].after), { enabled: false, sections: ['roster'] });
});

check('public page: one guild\'s page says nothing of another\'s; a page that is off stays a 404 while the other is on', async () => {
  const s = await scenario();
  const other = await secondGuild(s);
  await seedData(s);
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids', 'attendance', 'loot'] })).status, 200);
  assert.equal((await s.w.call({}, 'GET', `/api/public/${other.guildId}`)).status, 404, 'their page is off');
  const mine = (await s.w.call({}, 'GET', `/api/public/${s.guildId}`)).text;
  assert(!mine.includes('Their council') && !mine.includes('Other'));
  assert.equal((await other.call('PUT', '/public', { enabled: true, sections: ['roster'] })).status, 200);
  const theirs = await s.w.call({}, 'GET', `/api/public/${other.guildId}`);
  assert.deepEqual(Object.keys(theirs.json.sections), ['roster']);
  assert.deepEqual(theirs.json.sections.roster.map((e) => e.people.length), [0]);
  assert(!theirs.text.includes('Thoren'));
  // The settings route of one guild is closed to the other guild's Guild Master.
  assert.equal((await s.w.call(s.jars.alice, 'PUT', `${other.path}/public`, { enabled: false, sections: [] })).status, 403);
  assert.equal((await s.w.call({}, 'GET', `/api/public/${other.guildId}`)).status, 200);
});

check('guest and public views go through the same permission resolution: one role, read actions, the same ceiling', async () => {
  const s = await scenario();
  await seedData(s);
  // Both read their rows from the effective view, so the same edit to a role that both use moves both.
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'attendance'] })).status, 200);
  const { token } = (await s.call('bob', 'POST', '/guest-links', { expiresIn: '1d', teamId: s.A })).json.created;
  const jar = {};
  await s.w.call(jar, 'POST', '/auth/guest', { token });
  const pub = async () => (await s.w.call({}, 'GET', `/api/public/${s.guildId}`)).json;
  const gst = async () => (await s.w.call(jar, 'GET', '/api/guest')).json;
  assert.deepEqual(Object.keys((await pub()).sections).sort(), ['attendance', 'roster']);
  assert.deepEqual(teamIdsIn((await pub()).sections.roster), [s.A, s.B].sort(), 'public: every team');
  assert.deepEqual(teamIdsIn((await gst()).sections.roster), [s.A], 'the guest link: its team only');
  // The built-in Guest role cannot carry a write action; neither can Public. The server refuses it, so no view can ever hold one.
  for (const role of ['guest', 'public']) assert.equal((await s.call('alice', 'PUT', `/roles/${role}`, { permissions: { 'roster.edit': 'guild' } })).status, 400);
  // Even a rogue row in the table (a hand-edited database) grants a guest nothing beyond a read: the resolver drops it.
  s.w.db.sqlite.exec(`INSERT INTO role_overrides (guild_id, role_id) VALUES ('${s.guildId}', 'guest');
    INSERT INTO role_override_permissions (guild_id, role_id, action, scope) VALUES ('${s.guildId}', 'guest', 'roster.view', 'guild'), ('${s.guildId}', 'guest', 'roster.edit', 'guild'), ('${s.guildId}', 'guest', 'roster.notes.view', 'guild')`);
  const stored = await s.w.rows("SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = 'guest'", s.guildId);
  assert.equal(stored.length, 3, 'the rogue rows are in the table');
  const p = await load('worker/permissions.js');
  assert.deepEqual(p.resolveViewerPermissions(stored, 'guest', { activeTeamIds: [s.A] }), { 'roster.view': 'guild' });
  const afterRogue = await gst();
  assert.deepEqual(Object.keys(afterRogue.sections), ['roster'], 'the guest still gets only what it may read');
  assert(!JSON.stringify(afterRogue).toLowerCase().includes('secret'));
});


// ---------------------------------------------------------------------------
// Custom roles on the real routes, and the guild-ownership edge

check('a custom role works on the real routes: Loot council (loot.edit only) edits loot, nothing else, until the role changes; a guild.teams role adds teams but cannot run roles', async () => {
  const s = await scenario();
  await seedData(s);
  const award = `lo_${'1'.padStart(22, '0')}`;
  const patch = (who) => s.call(who, 'PATCH', `/loot/${award}`, { note: 'Went to the bank' });
  assert.equal((await patch('dave')).status, 403, 'a Member cannot');
  const council = await s.makeRole('Loot council', { 'loot.edit': 'guild' });
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council, teamId: null }] })).status, 200);
  const done = await patch('dave');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.award.note, 'Went to the bank');
  assert.equal((await patch('erin')).status, 403, 'only the holder');
  // Dave still cannot do anything else an Officer can.
  assert.equal((await s.call('dave', 'POST', '/teams', { name: 'Nope' })).status, 403);
  assert.equal((await s.call('dave', 'GET', '/people')).status, 403);
  assert.equal((await s.call('dave', 'POST', `/people/${s.ids.erin}/block`, { reason: '' })).status, 403);
  assert.equal((await s.call('dave', 'POST', '/roster', { teamId: s.A, name: 'Nobody', class: 'MAGE', mainSpec: null, offSpec: null, status: 'raider' })).status, 403);
  // Take loot.edit away and he is a Member again at once.
  assert.equal((await s.call('alice', 'PUT', `/roles/${council}`, { name: 'Loot council', permissions: { 'guild.teams': 'guild' } })).status, 200);
  assert.equal((await patch('dave')).status, 403);
  assert.equal((await s.call('dave', 'POST', '/teams', { name: 'Charlie' })).status, 201, 'guild.teams works through a custom role');
  // guild.roles is the Officer role\'s alone: a custom role cannot run roles, and rank stays Member so it cannot block or edit anyone.
  assert.equal((await s.call('dave', 'PUT', `/people/${s.ids.erin}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 403);
  assert.equal((await s.call('dave', 'GET', '/roles')).status, 403);
  // A team Raid-leader role: raids.edit for one team only.
  const leader = await s.makeRole('Raid leader', { 'raids.edit': 'team', 'raids.view': 'guild' });
  assert.equal((await s.setRoles('gina', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: leader, teamId: s.A }] })).status, 200);
  assert.equal((await s.call('gina', 'POST', '/raids', { teamId: s.A, raidOn: '2027-03-01' })).status, 201);
  assert.equal((await s.call('gina', 'POST', '/raids', { teamId: s.B, raidOn: '2027-03-02' })).status, 403, 'not their team');
});

check('guild ownership: only an Officer made by hand can inherit the guild when the Guild Master leaves; one Discord gives never does', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  assert.equal((await s.setRoles('bob', { officer: false, teamLeadTeamIds: [] })).status, 200, 'Bob is no longer a manual Officer');
  s.discordRoles('dave', [D_OFFICERS]);
  await s.signInAgain('dave');
  assert.equal((await s.me('dave')).can['guild.access'], 'guild');
  // The Guild Master has left the Discord server (the guild keeps other members): who would take over?
  s.w.db.sqlite.exec(`DELETE FROM user_servers WHERE user_id = '${s.ids.alice}'`);
  const impact = async () => (await s.w.call(s.jars.alice, 'GET', '/auth/me')).json.deleteImpact;
  assert.deepEqual((await impact()).autoPromote.map((g) => [g.name, g.to]), [['Ember', null]], 'a Discord Officer does not count');
  // An Officer set by hand does.
  s.w.db.sqlite.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_hand', '${s.guildId}', '${s.ids.bob}', 'officer', NULL, 'manual', 5)`);
  assert.equal((await impact()).autoPromote[0].to.id, s.ids.bob);
  // And the delete does what the impact said.
  assert.equal((await s.w.call(s.jars.alice, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.deepEqual((await s.w.rows("SELECT user_id FROM role_assignments WHERE role_id = 'guild_master'")).map((r) => r.user_id), [s.ids.bob]);
});


// ---------------------------------------------------------------------------
// Findings of the independent security review, each pinned

check('review: disconnecting Discord takes the roles Discord gave with it (and leaves the ones set by hand)', async () => {
  const s = await scenario();
  const council = await s.makeRole('Loot council', COUNCIL);
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council, teamId: null }] })).status, 200);
  s.discordRoles('dave', [D_OFFICERS]);
  await s.signInAgain('dave');
  assert.deepEqual((await s.me('dave')).roles.map((r) => r.role), ['officer', council]);
  // Dave has Battle.net too, so Discord can be disconnected, and an officer linked his account to a roster person (so he stays a member without Discord).
  const person = await s.call('alice', 'POST', '/roster', { teamId: s.A, name: 'Davepal', class: 'MAGE', mainSpec: null, offSpec: null, status: 'raider' });
  assert.equal((await s.call('alice', 'PUT', `/roster/${person.json.person.id}/account`, { userId: s.ids.dave })).status, 200);
  s.w.db.sqlite.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${s.ids.dave}', '777001', 'Dave#1234', 1, '{}', 1)`);
  const gone = await s.w.call(s.jars.dave, 'DELETE', '/auth/discord', {});
  assert.equal(gone.status, 200, gone.text);
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.ids.dave), 0, 'nothing could ever take the Discord-given Officer away later');
  assert.deepEqual((await s.me('dave')).roles, [{ role: council, name: 'Loot council' }], 'the role set by hand stays');
  assert.equal((await s.me('dave')).can['guild.access'], undefined);
});

check('review: re-pointing a mapping to another Discord role (or dropping one of two) clears what the old one gave; the next sign-in gives it back to those who still hold a mapped role', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  s.discordRoles('dave', [D_OFFICERS]);
  s.discordRoles('erin', [D_EXTRA]);
  await s.signInAgain('dave');
  assert.equal((await s.me('dave')).can['guild.access'], 'guild');
  // Officer now comes from "Booster" instead of "Officers": Dave loses it at once; Erin gets it when she next signs in.
  const moved = await s.setMaps([{ discordRoleId: D_EXTRA, roleId: 'officer', teamId: null }]);
  assert.equal(moved.json.cleared, 1);
  assert.equal((await s.me('dave')).can['guild.access'], undefined);
  await s.signInAgain('erin');
  assert.equal((await s.me('erin')).can['guild.access'], 'guild');
  // Two Discord roles give Officer; one is dropped: Officer is cleared for everybody and returns for the holder of the remaining role.
  assert.equal((await s.setMaps([{ discordRoleId: D_EXTRA, roleId: 'officer', teamId: null }, { discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).json.cleared, 1);
  await s.signInAgain('dave');
  await s.signInAgain('erin');
  assert.equal((await s.me('dave')).can['guild.access'], 'guild');
  const dropped = await s.setMaps([{ discordRoleId: D_EXTRA, roleId: 'officer', teamId: null }]);
  assert.equal(dropped.json.cleared, 2, 'both Officers from Discord are cleared');
  assert.equal((await s.me('dave')).can['guild.access'], undefined);
  assert.equal((await s.call('bob', 'POST', `/people/${s.ids.erin}/sync`, {})).json.sync.status, 'changed');
  assert.equal((await s.me('erin')).can['guild.access'], 'guild');
  // A save that changes nothing clears nothing.
  assert.equal((await s.setMaps([{ discordRoleId: D_EXTRA, roleId: 'officer', teamId: null }])).json.cleared, 0);
  assert.equal((await s.me('erin')).can['guild.access'], 'guild');
});

check('review: a custom role that edits the whole roster does not also open the guild to any account (look-up by name and linking need guild.access too)', async () => {
  const s = await scenario();
  const data = await seedData(s);
  const recruiter = await s.makeRole('Roster editor', { 'roster.edit': 'guild', 'roster.view': 'guild' });
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: recruiter, teamId: null }] })).status, 200);
  const outsider = await signIn(s.w, PEOPLE.frank, [plain('900000000000000077')]);
  const outsiderId = (await s.w.call(outsider, 'GET', '/auth/me')).json.user.id;
  assert.equal((await s.w.call(outsider, 'GET', `${s.guildPath}`)).status, 403, 'not a member');
  const lookup = await s.call('dave', 'GET', `/accounts?q=${encodeURIComponent('Frank F')}`);
  assert.equal(lookup.status, 403);
  const link = await s.call('dave', 'PUT', `/roster/${data.people.mirabel}/account`, { userId: outsiderId });
  assert.equal(link.status, 403);
  assert.equal((await s.w.call(outsider, 'GET', `${s.guildPath}`)).status, 403, 'still not a member');
  // The Officer (roster.edit and guild.access) can.
  assert.equal((await s.call('bob', 'GET', `/accounts?q=${encodeURIComponent('Frank F')}`)).status, 200);
  assert.equal((await s.call('bob', 'PUT', `/roster/${data.people.mirabel}/account`, { userId: outsiderId })).status, 200);
  assert.equal((await s.w.call(outsider, 'GET', `${s.guildPath}`)).status, 200);
});

check('review: the read-only view respects a team\'s private loot ("own" visibility), and the hand-out rule applies to guest links and the public page', async () => {
  const s = await scenario();
  await seedData(s);
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'loot'] })).status, 200);
  const visit = async () => (await s.w.call({}, 'GET', `/api/public/${s.guildId}`)).json;
  assert.equal((await visit()).sections.loot.find((e) => e.team.id === s.A).awards.length, 2);
  s.w.db.sqlite.exec(`INSERT INTO loot_policies (id, guild_id, team_id, policy, version, updated_by, updated_at) VALUES ('lp_${'a'.repeat(22)}', '${s.guildId}', '${s.A}', '{"visibility":{"members":"own"}}', 1, NULL, 1)`);
  const hidden = await visit();
  assert(!(hidden.sections.loot || []).some((e) => e.team.id === s.A), 'private loot is not published');
  assert(!JSON.stringify(hidden).includes('Item 1'));
  // Guest link with a role that sees loot: the same.
  const council = await s.makeRole('Observer', { 'loot.view': 'guild' });
  const { token } = (await s.call('alice', 'POST', '/guest-links', { roleId: council, expiresIn: '1d' })).json.created;
  const jar = {};
  await s.w.call(jar, 'POST', '/auth/guest', { token });
  assert(!((await s.w.call(jar, 'GET', '/api/guest')).json.sections.loot || []).some((e) => e.team.id === s.A));
  // The hand-out rule: an Officer who may run roles but cannot see attendance or loot cannot publish them.
  const officer = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'officer');
  const trimmed = { ...officer.permissions, 'guild.roles': 'guild' };
  delete trimmed['attendance.view'];
  delete trimmed['attendance.review'];
  delete trimmed['loot.view'];
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: trimmed })).status, 200);
  assert.equal((await s.call('bob', 'GET', `/attendance/team?team=${s.A}`)).status, 403, 'Bob cannot see attendance');
  const wide = await s.call('bob', 'POST', '/guest-links', { expiresIn: '1d' });
  assert.equal(wide.status, 403, 'the default Guest role shows attendance');
  assert.match(wide.json.message, /more than you can see/);
  assert.equal((await s.call('bob', 'POST', '/guest-links', { expiresIn: '1d', teamId: s.A })).status, 403);
  assert.equal((await s.call('bob', 'PUT', '/public', { enabled: true, sections: ['attendance'] })).status, 403);
  assert.equal((await s.call('bob', 'PUT', '/public', { enabled: true, sections: ['loot'] })).status, 403);
  assert.equal((await s.call('bob', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids'] })).status, 200, 'what he can see he can publish');
  // The Public role loses a ticked section: switching the page off still works.
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids', 'loot'] })).status, 200);
  const publicRole = (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'public');
  const noLoot = { ...publicRole.permissions };
  delete noLoot['loot.view'];
  assert.equal((await s.call('alice', 'PUT', '/roles/public', { permissions: noLoot })).status, 200);
  const settings = (await s.call('alice', 'GET', '/public')).json;
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: false, sections: settings.sections })).status, 200, 'off is always allowed');
  assert.equal((await s.w.call({}, 'GET', `/api/public/${s.guildId}`)).status, 404);
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: settings.sections })).status, 400, 'on again needs an allowed set');
});

check('review: role names cannot imitate a built-in (zero-width, bidi, full-width), team scope is refused where the role is held without a team, own_teams reaches no guest', async () => {
  const s = await scenario();
  const create = (name) => s.call('alice', 'POST', '/roles', { name, permissions: { 'loot.view': 'guild' } });
  for (const name of ['Offi​cer', 'Guild⁠ Master', 'Officer‮']) assert.equal((await create(name)).status, 400, JSON.stringify(name));
  assert.equal((await create('﻿Public')).status, 409, 'a byte-order mark is trimmed away: it is just Public');
  const wide = await create('Ｏｆｆｉｃｅｒ');
  assert.equal(wide.status, 409, 'a full-width Officer is Officer');
  assert.equal(wide.json.error, 'role_name_taken');
  assert.equal((await create('Raid élite')).status, 201, 'ordinary accented letters are fine');
  assert.equal((await s.call('alice', 'POST', '/guest-links', { expiresIn: '1d', label: 'zero​width' })).status, 400);
  // Officer and Member are held without a team.
  for (const role of ['officer', 'member']) {
    const r = await s.call('alice', 'PUT', `/roles/${role}`, { permissions: { 'loot.edit': 'team' } });
    assert.equal(r.status, 400, role);
    assert.match(r.json.message, /without a team/);
  }
  assert.equal((await s.call('alice', 'PUT', '/roles/team_lead', { permissions: { 'loot.edit': 'team' } })).status, 200, 'Team Lead is the team role');
  // A custom role with "own teams" scope reaches nothing for a guest (a guest has no characters).
  const own = await s.makeRole('Own teams viewer', { 'attendance.view': 'own_teams', 'roster.view': 'guild' });
  const { token } = (await s.call('alice', 'POST', '/guest-links', { roleId: own, expiresIn: '1d' })).json.created;
  const jar = {};
  await s.w.call(jar, 'POST', '/auth/guest', { token });
  assert.deepEqual(Object.keys((await s.w.call(jar, 'GET', '/api/guest')).json.sections), ['roster']);
  const p = await load('worker/permissions.js');
  assert.deepEqual(p.resolveViewerPermissions([{ role_id: 'x', action: 'attendance.view', scope: 'own_teams' }, { role_id: 'x', action: 'loot.view', scope: 'team' }], 'x', { activeTeamIds: ['t_a'] }), { 'loot.view': ['t_a'] });
});

check('review: a bot call that stalls cannot hold a sign-in for long, and the sign-in still succeeds', async () => {
  const s = await scenario();
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  const original = s.w.discord.fetch;
  // The bot endpoint never answers unless the caller gives up (the signal).
  const hanging = (url, init = {}) => {
    if (/^Bot /.test((init.headers && init.headers.Authorization) || '')) {
      return new Promise((resolve, reject) => {
        if (!init.signal) return;
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return original(url, init);
  };
  const login = async () => {
    s.w.discord.next = { user: { id: PEOPLE.dave.id, username: 'dave', global_name: 'Dave D', avatar: null }, servers: [plain(SERVER_A)] };
    return s.w.req('GET', '/auth/login', { jar: s.jars.dave });
  };
  s.w.discord.fetch = hanging;
  // The app was built with the original fetch; rebuild it with the hanging one over the same database.
  const { createApp } = await load('worker/index.js');
  const app = createApp({ db: s.w.db, env: s.w.env, fetch: hanging, now: () => s.w.clock.now, randomBytes: (n) => crypto.randomBytes(n), log: (m) => s.w.logs.push(m) });
  s.discordRoles('dave', [D_OFFICERS]);
  const started = Date.now();
  const first = await login();
  // AbortSignal.timeout's timer does not keep Node alive; this one does, so the test waits for the Worker to give up.
  const keepAlive = setInterval(() => {}, 100);
  let callback;
  try {
    callback = await app.handle(new Request(`${ORIGIN}/auth/callback?code=abc&state=${encodeURIComponent(stateOf(first))}`, { headers: { Cookie: Object.entries(s.jars.dave).map(([k, v]) => `${k}=${v}`).join('; ') } }));
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(callback.status, 302);
  assert(Date.now() - started < 8000, 'gave up on the bot after a few seconds');
  assert(s.w.logs.some((line) => /discord role sync at sign-in: unavailable/.test(line)));
  assert.equal(await s.w.count('role_assignments', "user_id = ? AND source = 'discord'", s.ids.dave), 0, 'and changed nothing');
});


// @@CHECKS@@

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PM wave 1 x roles: the officer tools read permissions through the same resolution (custom, Discord-given and manual roles), and a guest or public
// visitor reaches none of them.

// The watch list left Home's items (round 2): Needs attention only counts the open entries per team.
const watchOpen = (payload, teamId) => (payload.counts[teamId] || {}).watchOpen || 0;

check('wave 1 x roles: a custom role with attendance.review on a team gets that team\'s watch list and Needs attention items - by hand or from Discord - and nothing else', async () => {
  const s = await scenario();
  const data = await seedData(s);
  // Kaelith missed the one raid (an attendance row straight into the table, as the wave 1 suite does): below the 75% line.
  s.w.db.sqlite.exec(`INSERT OR REPLACE INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES ('${data.raid}', '${s.guildId}', '${s.A}', '${data.people.kaelith}', 'missed', 0, 0)`);
  const base = `/attendance/team?team=${s.A}`;
  // The Guild Master's baseline: Kaelith (no attendance on the one raid) is on Alpha's watch list and in Needs attention.
  const gm = await s.call('alice', 'GET', base);
  assert.equal(gm.status, 200, gm.text);
  assert(gm.json.watch && gm.json.watch.entries.some((entry) => entry.name === 'Kaelith'), 'Kaelith is on the watch list');
  const gmAttention = await s.call('alice', 'GET', '/attention');
  assert.equal(gmAttention.status, 200, gmAttention.text);
  assert(watchOpen(gmAttention.json, s.A) >= 1);
  assert(!gmAttention.json.items.some((item) => item.kind === 'watch'));

  const clerk = await s.makeRole('Attendance clerk', { 'attendance.view': 'team', 'attendance.review': 'team' });
  const reader = await s.makeRole('Attendance reader', { 'attendance.view': 'team' });
  const hold = (name, roleId, teamId) => s.setRoles(name, { officer: false, teamLeadTeamIds: [], roles: [{ roleId, teamId }] });
  assert.equal((await hold('dave', clerk, s.A)).status, 200);
  assert.equal((await hold('erin', reader, s.A)).status, 200);

  // Dave (clerk of Alpha, set by hand): the watch list on Alpha's page, Alpha's items in Needs attention, nothing of Bravo.
  const dave = await s.call('dave', 'GET', base);
  assert.equal(dave.status, 200, dave.text);
  assert(dave.json.watch && dave.json.watch.entries.some((entry) => entry.name === 'Kaelith'));
  const daveAttention = await s.call('dave', 'GET', '/attention');
  assert.equal(daveAttention.status, 200, daveAttention.text);
  assert(watchOpen(daveAttention.json, s.A) >= 1);
  assert.deepEqual(Object.keys(daveAttention.json.counts), [s.A], 'only the team the role covers');
  assert(daveAttention.json.items.every((item) => item.teamId === s.A), 'every item is Alpha\'s: no Bravo, no guild-wide claims');
  assert.equal((await s.call('dave', 'GET', `/attendance/team?team=${s.B}`)).status, 403, 'Bravo\'s page needs attendance.view there');

  // Erin (reader of Alpha: attendance.view only): refused the team page, no Needs attention.
  const erin = await s.call('erin', 'GET', base);
  assert.equal(erin.status, 403, 'no attendance.review, no team page');
  assert.equal((await s.call('erin', 'GET', '/attention')).status, 403);

  // Gina: a plain Member until Discord gives her the clerk role for Alpha.
  assert.equal((await s.call('gina', 'GET', '/attention')).status, 403);
  assert.equal((await s.setMaps([{ discordRoleId: D_RAIDLEADS, roleId: clerk, teamId: s.A }])).status, 200);
  s.discordRoles('gina', [D_RAIDLEADS]);
  await s.signInAgain('gina');
  const gina = await s.call('gina', 'GET', '/attention');
  assert.equal(gina.status, 200, gina.text);
  assert(watchOpen(gina.json, s.A) >= 1);
  assert((await s.call('gina', 'GET', base)).json.watch.entries.length > 0);
  // Discord takes the role back: the next sign-in takes the pages with it.
  s.discordRoles('gina', []);
  await s.signInAgain('gina');
  assert.equal((await s.call('gina', 'GET', '/attention')).status, 403);
  assert.equal((await s.call('gina', 'GET', base)).status, 403, 'a Member with no character on Alpha does not read its page');

  // Taking the right from the role takes it from everyone who holds it, at once.
  assert.equal((await s.call('alice', 'PUT', `/roles/${clerk}`, { permissions: { 'attendance.view': 'team' } })).status, 200);
  assert.equal((await s.call('dave', 'GET', '/attention')).status, 403);
  assert.equal((await s.call('dave', 'GET', base)).status, 403, 'without attendance.review the team page is closed');
});

check('wave 1 x roles: the calendar feed and the trial card follow the effective permissions (a guild that edited Member, a custom role)', async () => {
  const s = await scenario();
  const data = await seedData(s);
  const feedOf = async (name) => {
    const made = await s.call(name, 'POST', '/calendar', { teamId: s.A });
    return made.status === 201 ? { made, path: new URL(made.json.url).pathname } : { made };
  };
  // By default every Member may see raids, so Dave can subscribe and the feed answers.
  const first = await feedOf('dave');
  assert.equal(first.made.status, 201, first.made.text);
  const open = await s.w.call({}, 'GET', first.path);
  assert.equal(open.status, 200, open.text);
  assert.match(open.headers.get('Content-Type'), /^text\/calendar/);
  // The guild edits Member to leave raids out: Dave's existing link stops at once (404), and he cannot make a new one.
  const member = (await s.call('alice', 'GET', '/roles')).json.roles.find((role) => role.id === 'member');
  const without = { ...member.permissions };
  delete without['raids.view'];
  assert.equal((await s.call('alice', 'PUT', '/roles/member', { permissions: without })).status, 200);
  assert.equal((await s.w.call({}, 'GET', first.path)).status, 404, 'the effective permission is re-read at every fetch');
  assert.equal((await s.call('dave', 'POST', '/calendar', { teamId: s.A })).status, 403);
  assert.equal((await s.call('dave', 'GET', `/calendar?team=${s.A}`)).status, 403);
  // A custom role that gives raids.view for Alpha brings the link back (same token, no new one needed) - and only for Alpha.
  const watcher = await s.makeRole('Raid watcher', { 'raids.view': 'guild' });
  assert.equal((await s.setRoles('dave', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: watcher, teamId: null }] })).status, 200);
  assert.equal((await s.w.call({}, 'GET', first.path)).status, 200, 'the custom role is enough');
  const back = await s.call('dave', 'POST', '/calendar', { teamId: s.B });
  assert.equal(back.status, 201, back.text);
  // The trial card needs roster.edit on the person's team: a custom role with roster.edit for Bravo does not open Alpha's people.
  const editor = await s.makeRole('Bravo editor', { 'roster.edit': 'team' });
  assert.equal((await s.setRoles('erin', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: editor, teamId: s.B }] })).status, 200);
  assert.equal((await s.call('erin', 'GET', `/roster/${data.people.thoren}/trial`)).status, 403, 'Thoren is on Alpha');
  const mirabel = await s.call('erin', 'GET', `/roster/${data.people.mirabel}/trial`);
  assert.notEqual(mirabel.status, 403, 'Mirabel is on Bravo: the right exists there (a non-trial answers 4xx for another reason)');
});

check('wave 1 x roles: a guest link or the public page reaches none of the officer tools - not even for a role that holds the rights - and shows no wave 1 data', async () => {
  const s = await scenario();
  const data = await seedData(s);
  // A custom role that WOULD open every wave 1 page for an account; a guest link with it only ever keeps the read actions.
  const clerk = await s.makeRole('Attendance clerk', { 'attendance.view': 'guild', 'attendance.review': 'guild', 'roster.view': 'guild', 'raids.view': 'guild', 'roster.edit': 'guild' });
  const made = await s.call('bob', 'POST', '/guest-links', { roleId: clerk, expiresIn: '7d' });
  assert.equal(made.status, 201, made.text);
  const plainLink = (await s.call('bob', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d' })).json.created;
  const guests = [];
  for (const created of [made.json.created, plainLink]) {
    const jar = {};
    assert.equal((await s.w.call(jar, 'POST', '/auth/guest', { token: created.token })).status, 200);
    guests.push(jar);
  }
  // The calendar feed is a person's: a real account only. A guest cannot make, read or turn off a link.
  const g = s.guildPath;
  const dave = await s.call('dave', 'POST', '/calendar', { teamId: s.A });
  assert.equal(dave.status, 201, dave.text);
  const feedPath = new URL(dave.json.url).pathname;
  for (const jar of guests) {
    for (const [method, route, body] of [
      ['GET', `${g}/attention`], ['GET', `${g}/audit`], ['GET', `${g}/audit?format=csv`], ['GET', `${g}/calendar?team=${s.A}`], ['POST', `${g}/calendar`, { teamId: s.A }],
      ['DELETE', `${g}/calendar`, { teamId: s.A }], ['GET', `${g}/roster/${data.people.thoren}/trial`], ['GET', `${g}/attendance/team?team=${s.A}`],
    ]) {
      const r = await s.w.call(jar, method, route, body);
      assert.equal(r.status, 401, `${method} ${route} -> ${r.status} ${r.text}`);
    }
    // A guest cookie is no credential for the feed and opens no one's link: a guess is the same plain 404 as for anybody.
    assert.equal((await s.w.call(jar, 'GET', `/cal/${'A'.repeat(43)}.ics`)).status, 404);
  }
  // The public page: not an account either.
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'raids', 'attendance', 'loot'] })).status, 200);
  for (const route of ['/attention', '/audit', `/calendar?team=${s.A}`]) assert.equal((await s.w.call({}, 'GET', `${g}${route}`)).status, 401, route);
  // What they see: no watch list, trial card, activity or Needs attention - by key and by text.
  s.w.db.sqlite.exec(`UPDATE players SET status = 'trial', trial_end = '2027-01-17' WHERE id = '${data.people.kaelith}'`);
  const views = [(await s.w.call(guests[0], 'GET', '/api/guest')).json, (await s.w.call(guests[1], 'GET', '/api/guest')).json, (await s.w.call({}, 'GET', `/api/public/${s.guildId}`)).json];
  for (const view of views) {
    assert(view && view.sections, 'a view');
    const text = JSON.stringify(view);
    for (const word of ['watch', 'trial', 'audit', 'attention', 'calendar', 'previousPct', 'reasons', 'notes']) assert(!text.toLowerCase().includes(word.toLowerCase()), `the view says nothing of ${word}`);
    for (const section of view.sections.attendance || []) {
      assert.deepEqual(Object.keys(section).sort(), ['people', 'raids', 'team', 'window']);
      for (const person of section.people) assert.deepEqual(Object.keys(person).sort(), ['class', 'counted', 'name', 'pct']);
    }
  }
  assert(views[0].sections.attendance && views[0].sections.attendance.length > 0, 'the attendance percentages are there (the control)');
});

check('wave 1 x roles: every role, mapping, guest-link and public-page change reads as a plain sentence in the Activity log (Settings), for the Guild Master only', async () => {
  const s = await scenario();
  const role = await s.makeRole('Raid Lead', { 'raids.view': 'guild' });
  assert.equal((await s.call('alice', 'PUT', `/roles/${role}`, { name: 'Raid Boss', permissions: { 'raids.view': 'guild', 'roster.view': 'guild' } })).status, 200);
  assert.equal((await s.call('alice', 'PUT', '/roles/officer', { permissions: (await s.call('alice', 'GET', '/roles')).json.roles.find((r) => r.id === 'officer').permissions })).status, 200);
  assert.equal((await s.setMaps([{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }])).status, 200);
  s.discordRoles('dave', [D_OFFICERS]);
  assert.equal((await s.call('alice', 'POST', `/people/${s.ids.dave}/sync`, {})).status, 200);
  const link = await s.call('bob', 'POST', '/guest-links', { roleId: 'guest', teamId: s.A, expiresIn: '1d' });
  assert.equal(link.status, 201, link.text);
  assert.equal((await s.call('bob', 'DELETE', `/guest-links/${link.json.created.id}`, {})).status, 200);
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster'] })).status, 200);
  assert.equal((await s.call('alice', 'POST', '/roles/officer/reset', {})).status, 200);
  assert.equal((await s.call('alice', 'DELETE', `/roles/${role}`, {})).status, 200);
  const log = await s.call('alice', 'GET', '/audit?type=settings');
  assert.equal(log.status, 200, log.text);
  const sentence = (action) => log.json.rows.filter((row) => row.action === action).map((row) => row.text);
  assert.deepEqual(sentence('role.create'), ['Created the role Raid Lead']);
  assert.deepEqual(sentence('role.update'), ['Renamed the role Raid Lead to Raid Boss and changed its permissions']);
  assert.deepEqual(sentence('role.delete'), ['Deleted the role Raid Boss']);
  assert.deepEqual(sentence('role.reset'), ['Reset the role Officer to its defaults']);
  assert.deepEqual(sentence('discord.maps'), ['Changed the Discord role mapping: 1 Discord role mapped (was 0)']);
  assert.deepEqual(sentence('roles.discord_sync'), ['Synced the Discord roles of Dave D: 1 added']);
  assert.deepEqual(sentence('guest.create'), ['Created a guest link for Alpha']);
  assert.deepEqual(sentence('guest.revoke'), ['Turned off a guest link']);
  assert.deepEqual(sentence('public.update'), ['Turned the public page on (roster)']);
  assert(log.json.rows.every((row) => row.group === 'settings'));
  // The role editor's unchanged built-in save wrote no row, and the other groups' filters do not list these.
  assert.equal((await s.call('alice', 'GET', '/audit?type=roster')).json.rows.filter((row) => /^(role|discord\.maps|guest|public)/.test(row.action)).length, 0);
  // A plain Member does not read the log.
  assert.equal((await s.call('erin', 'GET', '/audit')).status, 403);
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
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
