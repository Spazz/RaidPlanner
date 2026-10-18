/**
 * Raidsmith guild tracker - Phase 7: Discord role mapping, the role editor, guest links and the public page, Worker tests
 * Run: node guild-roles-worker-tests.js [name-filter]
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
const { createD1Fake } = require('./tests/d1-fake');

const ROOT = __dirname;
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
      state.botCalls.push({ path: u.pathname, auth });
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


// @@CHECKS@@

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
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
