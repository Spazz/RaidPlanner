/**
 * Raidsmith guild tracker - loot Worker tests (Phase 4, lane W)
 * Run: node guild-loot-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs all migrations), with Discord faked by an
 * injected fetch. No network, no Wrangler, no credentials. The pure rules (policy, import, balance) are pinned directly; the routes,
 * the visibility modes, the matching on read and the SQL are driven over HTTP. Spec: tasks/guild-phase4-spec.md.
 */
const assert = require('node:assert/strict');
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

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  frank: { id: '110000000000000006', username: 'frank', globalName: 'Frank F' },
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

async function makeWorld({ allowlist = [], migrationsDir } = {}) {
  const { createApp } = await load('worker/index.js');
  const db = migrationsDir ? createD1Fake({ migrationsDir }) : createD1Fake();
  const discord = makeDiscord();
  const clock = { now: 1_800_100_800_000 }; // 2027-01-16T12:00Z, a Saturday: 2027-01-05 and 2027-01-12 (Tuesdays) are past raids
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: allowlist.join(','),
  };
  const app = createApp({ db, env, fetch: (url, init) => discord.fetch(url, init), now: () => clock.now, randomBytes, log: () => {} });
  const world = {
    db, discord, clock, env,
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

// Alice (Guild Master) creates the guild; Bob (Officer), Carol (Team Lead of the first team), Dave (Team Lead of the second team, when
// there is one) and Erin (Member) sign in. Frank runs a second guild on SERVER_B.
async function scenario({ teams = 1, guildBody = {}, migrationsDir } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id], migrationsDir });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const body = { ...GUILD_BODY, ...guildBody };
  if (teams > 1) { body.multipleTeams = true; body.teamNames = ['Alpha', 'Bravo', 'Charlie'].slice(0, teams); }
  const created = await w.call(alice, 'POST', '/api/guild', body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, alice, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  s.teamId = s.teams[0];
  for (const name of ['bob', 'carol', 'dave', 'erin']) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.teams[0]] })).status, 200);
  if (teams > 1) assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.teams[1]] })).status, 200);
  return s;
}

async function secondGuild(s, body = {}) {
  const frank = await signIn(s.w, PEOPLE.frank, [manageable(SERVER_B)]);
  const created = await s.w.call(frank, 'POST', '/api/guild', { ...GUILD_BODY, serverId: SERVER_B, name: 'Other', ...body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { frank, guildId: created.json.guild.id, teamId: created.json.teams[0].id, path: `/api/guild/${created.json.guild.id}` };
}

const exec = (w, sql) => w.db.sqlite.exec(sql);
const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// ---------------------------------------------------------------------------
// Fixtures

// New York is UTC-5 on every date used here (the clocks go back on 2026-11-01), so a local wall time is a fixed offset.
const at = (date, time) => Date.parse(`${date}T${time}:00-05:00`);
const ALL_TAGS = ['MS', 'OS', 'DE', 'BANK'];

// A Gargul award as the browser normalizes it (lane U).
const award = (n, over = {}) => ({
  checksum: `GARG${String(n).padStart(12, '0')}`,
  itemId: 30000 + n,
  itemName: `Item ${n}`,
  quality: 4,
  awardedAt: at('2027-01-05', '20:30'),
  winnerName: 'Aldric',
  winnerRealm: 'Nightslayer',
  winnerClass: 'WARRIOR',
  rollType: 'MS',
  flags: [],
  awardedBy: 'Bobby-Nightslayer',
  ...over,
});

// Two teams (A = Alpha, B = Bravo), five people, six raids, and every award the balance tests count. Erin is linked to Brindle.
//   A 2027-01-05 r1 (Aldric, Brindle, Cassia, and Wanderfell as a fill-in), B 2027-01-05 rb (nobody ticked), A 2027-01-12 r2
//   (Aldric, Brindle), A 2026-11-03 r0 (Aldric), A 2027-02-02 up (not started).
async function lootWorld({ imported = true, migrationsDir } = {}) {
  const s = await scenario({ teams: 2, migrationsDir });
  const [A, B] = s.teams;
  s.A = A; s.B = B;
  s.p = {};
  for (const [key, name, team] of [['aldric', 'Aldric', A], ['brindle', 'Brindle', A], ['cassia', 'Cassia', A], ['dunmar', 'Dunmar', A], ['wander', 'Wanderfell', B]]) {
    s.p[key] = (await addPerson(s, 'bob', team, name)).person.id;
  }
  exec(s.w, `UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${s.p.brindle}'`);
  const raid = async (teamId, raidOn, present, extra = {}) => {
    const made = await s.call('bob', 'POST', '/raids', { teamId, raidOn, ...extra });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.raid.id;
    if (present) {
      const manual = await s.call('bob', 'PUT', `/raids/${id}/manual`, { reason: 'No log kept', presentPlayerIds: present });
      assert.equal(manual.status, 200, JSON.stringify(manual.json));
    }
    return id;
  };
  s.r0 = await raid(A, '2026-11-03', [s.p.aldric]);
  s.r1 = await raid(A, '2027-01-05', [s.p.aldric, s.p.brindle, s.p.cassia, s.p.wander], { title: 'Gruul night' });
  s.rb = await raid(B, '2027-01-05', []);
  s.r2 = await raid(A, '2027-01-12', [s.p.aldric, s.p.brindle]);
  s.up = await raid(A, '2027-02-02');
  s.loot = (id, route = '') => `/raids/${id}/loot${route}`;
  s.import = (who, id, awards, extra = {}) => s.call(who, 'POST', s.loot(id), { awards, ...extra });
  if (imported) {
    const on = (date, time) => at(date, time);
    s.awards = {
      r1: [
        award(1, { itemId: 28770, itemName: 'Tier Token', awardedAt: on('2027-01-05', '20:10') }),
        award(2, { awardedAt: on('2027-01-05', '20:20'), rollType: 'OS', flags: ['OS'] }),
        award(3, { winnerName: 'Brindle', awardedAt: on('2027-01-05', '20:30') }),
        award(4, { winnerName: 'Cassia', winnerClass: 'MAGE', awardedAt: on('2027-01-05', '20:40') }),
        award(5, { winnerName: 'Zorgax', winnerClass: 'ROGUE', awardedAt: on('2027-01-05', '20:50') }),
        award(6, { winnerName: 'Visitor', winnerClass: 'MAGE', awardedAt: on('2027-01-05', '21:00') }),
      ],
      r2: [
        award(7, { itemId: 28770, itemName: 'Tier Token', awardedAt: on('2027-01-12', '20:15') }),
        award(8, { winnerName: 'Brindle', awardedAt: on('2027-01-12', '20:25') }),
      ],
      r0: [award(9, { itemId: 28770, itemName: 'Tier Token', awardedAt: on('2026-11-03', '20:00') })],
      rb: [award(10, { winnerName: 'Wanderfell', awardedAt: on('2027-01-05', '20:30') })],
    };
    for (const [key, id] of [['r1', s.r1], ['r2', s.r2], ['r0', s.r0], ['rb', s.rb]]) {
      const r = await s.import('bob', id, s.awards[key]);
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    s.awardId = {};
    for (const row of await s.w.rows('SELECT id, checksum FROM loot_awards')) s.awardId[Number(row.checksum.slice(4))] = row.id;
    // Cassia's award is re-tagged a disenchant; Visitor is marked a guest from the loot alone (no log names him).
    const retag = await s.call('bob', 'PATCH', `/loot/${s.awardId[4]}`, { tag: 'DE' });
    assert.equal(retag.status, 200, JSON.stringify(retag.json));
    const guest = await s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: 'visitor|nightslayer', action: 'guest' });
    assert.equal(guest.status, 200, JSON.stringify(guest.json));
  }
  return s;
}

// Counts the D1 calls (statement first/all/run and batch) made inside fn.
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

const tagsOf = (list) => Object.fromEntries(list.map((a) => [a.checksum || a.id, a.tag]));
const byChecksum = async (w) => Object.fromEntries((await w.rows('SELECT * FROM loot_awards')).map((row) => [row.checksum, row]));
const row = (balance, personId) => balance.people.find((p) => p.personId === personId);

// ---------------------------------------------------------------------------
// Schema and seeds

check('migration 0008: loot.* seeds are exactly the plan, the tables are there, ACTIONS names them', async () => {
  const w = await makeWorld();
  const rows = await w.rows("SELECT role_id, action, scope FROM role_permissions WHERE action LIKE 'loot.%' ORDER BY action, role_id");
  assert.deepEqual(rows.map((r) => `${r.action}:${r.role_id}:${r.scope}`), [
    'loot.edit:guild_master:guild', 'loot.edit:officer:guild', 'loot.edit:team_lead:team',
    'loot.policy:guild_master:guild', 'loot.policy:officer:guild',
    'loot.view:guild_master:guild', 'loot.view:member:own_teams', 'loot.view:officer:guild', 'loot.view:team_lead:team',
  ]);
  const tables = (await w.rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  assert(tables.includes('loot_awards') && tables.includes('loot_policies'));
  const indexes = (await w.rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'loot_awards'")).map((r) => r.name);
  for (const name of ['loot_awards_team_time', 'loot_awards_raid', 'loot_awards_winner', 'loot_awards_item']) assert(indexes.includes(name), name);
  const { ACTIONS } = await load('worker/permissions.js');
  assert(['loot.view', 'loot.edit', 'loot.policy'].every((action) => ACTIONS.includes(action)));
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', '0008_loot.sql'), 'utf8');
  assert(/^[\x00-\x7f]*$/.test(sql), 'ASCII only');
});

check('schema: checksum, tag, item and quality CHECKs, one checksum per guild, the tag-set pair, cascades on raid and guild delete, SET NULL on the user', async () => {
  const s = await lootWorld({ imported: false });
  const base = (over = {}) => ({
    id: 'lo_x', guild_id: s.guildId, raid_id: s.r1, team_id: s.A, checksum: 'abcdefgh', item_id: 1, awarded_at: 1, winner_name: 'Aldric', winner_name_key: 'aldric',
    tag: 'MS', created_at: 1, updated_at: 1, ...over,
  });
  const insert = (over) => {
    const v = base(over);
    const cols = Object.keys(v);
    s.w.db.sqlite.prepare(`INSERT INTO loot_awards (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(v));
  };
  insert({});
  const fails = (over, pattern) => assert.throws(() => insert({ id: 'lo_y', checksum: 'zzzzzzzz1', ...over }), pattern);
  fails({ checksum: 'abcdefgh' }, /UNIQUE/);
  assert.throws(() => insert({ id: 'lo_z', checksum: 'short' }), /CHECK/);
  fails({ checksum: 'has space here' }, /CHECK/);
  fails({ checksum: 'x'.repeat(41) }, /CHECK/);
  fails({ tag: 'ms' }, /CHECK/);
  fails({ tag: 'GREED' }, /CHECK/);
  fails({ item_id: 0 }, /CHECK/);
  fails({ item_quality: 8 }, /CHECK/);
  fails({ winner_class: 'DEMON' }, /CHECK/);
  fails({ roll_type: 'x'.repeat(25) }, /CHECK/);
  fails({ note: 'x'.repeat(201) }, /CHECK/);
  fails({ flags: 'not json' }, /CHECK|malformed/);
  fails({ tag_set_by: s.ids.bob }, /CHECK/);                      // set-by without set-at
  fails({ raid_id: s.rb }, /FOREIGN KEY/);                        // the team is the raid's team
  fails({ raid_id: 'r_nope' }, /FOREIGN KEY/);
  fails({ source: 'tmb' }, /CHECK/);
  insert({ id: 'lo_ok', checksum: 'okokokok', tag_set_by: s.ids.bob, tag_set_at: 5 });
  exec(s.w, `DELETE FROM users WHERE id = '${s.ids.bob}'`);
  const kept = (await s.w.rows("SELECT tag_set_by, tag_set_at FROM loot_awards WHERE id = 'lo_ok'"))[0];
  assert.deepEqual([kept.tag_set_by, kept.tag_set_at], [null, 5], 'the officer\'s account is gone, the award still counts as tagged by hand');
  exec(s.w, `DELETE FROM raids WHERE id = '${s.r1}'`);
  assert.equal(await s.w.count('loot_awards'), 0, 'a raid delete takes its awards');
  insert({ raid_id: s.r2, checksum: 'afterraid' });
  s.w.db.sqlite.prepare('INSERT INTO loot_policies (id, guild_id, team_id, policy, updated_at) VALUES (?, ?, ?, ?, ?)').run('lp_1', s.guildId, null, '{}', 1);
  assert.throws(() => s.w.db.sqlite.prepare('INSERT INTO loot_policies (id, guild_id, team_id, policy, updated_at) VALUES (?, ?, ?, ?, ?)').run('lp_2', s.guildId, null, '{}', 1), /UNIQUE/);
  assert.throws(() => s.w.db.sqlite.prepare('INSERT INTO loot_policies (id, guild_id, team_id, policy, updated_at) VALUES (?, ?, ?, ?, ?)').run('lp_3', s.guildId, null, 'nope', 1), /CHECK|malformed/);
  exec(s.w, `DELETE FROM guilds WHERE id = '${s.guildId}'`);
  assert.equal(await s.w.count('loot_awards') + await s.w.count('loot_policies'), 0, 'a guild delete takes awards and policies');
});

check('the loot routes are exactly the contract list, literal paths before :aid', () => {
  const source = fs.readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  const found = [...source.matchAll(/method: '(\w+)', path: '(\/api\/guild\/:gid\/(?:raids\/:rid\/)?loot[^']*)'/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(found, [
    'GET /api/guild/:gid/raids/:rid/loot',
    'POST /api/guild/:gid/raids/:rid/loot/preview',
    'POST /api/guild/:gid/raids/:rid/loot',
    'GET /api/guild/:gid/loot/balance',
    'GET /api/guild/:gid/loot/raids',
    'GET /api/guild/:gid/loot/items',
    'GET /api/guild/:gid/loot/person/:pid',
    'GET /api/guild/:gid/loot/policy',
    'PUT /api/guild/:gid/loot/policy',
    'PATCH /api/guild/:gid/loot/:aid',
    'DELETE /api/guild/:gid/loot/:aid',
  ]);
  assert(/maxBody: LOOT_MAX_BODY/.test(source));
});

// ---------------------------------------------------------------------------
// Pure rules

check('policy: defaults, validation (unknown keys, other values, empty or foreign countTags), per-key merge', async () => {
  const { DEFAULT_LOOT_POLICY, validateLootOverride, resolveLootPolicy } = await load('worker/loot-policy.js');
  assert.deepEqual(DEFAULT_LOOT_POLICY, { visibility: { members: 'ownTeams' }, balance: { mode: 'perRaid', countTags: ['MS'] } });
  assert(Object.isFrozen(DEFAULT_LOOT_POLICY) && Object.isFrozen(DEFAULT_LOOT_POLICY.balance.countTags));
  const ok = (value, scope) => assert.deepEqual(validateLootOverride(value, scope), { ok: true, errors: [] }, JSON.stringify(value));
  ok({}); ok({}, 'team');
  ok({ visibility: { members: 'own' } }); ok({ visibility: { members: 'guild' } }); ok({ visibility: { members: 'ownTeams' } }, 'team');
  ok({ balance: { mode: 'count' } }); ok({ balance: { countTags: ['OS'] } }); ok({ balance: { countTags: ['MS', 'OS'] } });
  ok({ visibility: {}, balance: {} });
  const bad = (value, path, scope) => {
    const result = validateLootOverride(value, scope);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.errors[0].path, path, JSON.stringify(value));
    assert(result.errors[0].message.length > 0);
  };
  bad({ extra: 1 }, 'extra');
  bad({ visibility: { members: 'everyone' } }, 'visibility.members');
  bad({ visibility: { members: 3 } }, 'visibility.members');
  bad({ visibility: { other: 'own' } }, 'visibility.other');
  bad({ visibility: 'own' }, 'visibility');
  bad({ balance: { mode: 'weighted' } }, 'balance.mode');
  bad({ balance: { countTags: [] } }, 'balance.countTags');
  bad({ balance: { countTags: ['DE'] } }, 'balance.countTags');
  bad({ balance: { countTags: ['BANK', 'MS'] } }, 'balance.countTags');
  bad({ balance: { countTags: ['MS', 'MS'] } }, 'balance.countTags');
  bad({ balance: { countTags: 'MS' } }, 'balance.countTags');
  bad({ balance: { countTags: ['ms'] } }, 'balance.countTags');
  bad({ balance: { countTags: ['MS', 'OS', 'MS'] } }, 'balance.countTags');
  bad({ balance: { mode: 'count', unknown: true } }, 'balance.unknown');
  bad([], '');
  bad(null, '');
  bad('x', '');
  bad({}, '', 'nope');
  assert.deepEqual(resolveLootPolicy(null, null), DEFAULT_LOOT_POLICY);
  const merged = resolveLootPolicy({ balance: { countTags: ['MS', 'OS'] } }, { visibility: { members: 'own' }, balance: { mode: 'count' } });
  assert.deepEqual(merged, { visibility: { members: 'own' }, balance: { mode: 'count', countTags: ['MS', 'OS'] } });
  merged.balance.countTags.push('x');
  assert.deepEqual(DEFAULT_LOOT_POLICY.balance.countTags, ['MS'], 'the resolved policy is a fresh copy');
});

check('import rules: readAwards cleans and refuses, the automatic tag, the raid-day test, the classification', async () => {
  const { readAwards, autoTag, onRaidDay, classifyAward, normalizedOf, MAX_AWARDS } = await load('worker/loot-import.js');
  const guild = { realm: 'Nightslayer', realm_kind: 'realm' };
  const ruleset = { realm: 'Normal', realm_kind: 'ruleset' };

  const [one] = readAwards([award(1, { winnerName: 'aldRIC', winnerRealm: ' Nightslayer ', flags: ['TMB', 'OS', 'WHAT'], itemName: ' Sword\u0007 ', rollType: null })], guild);
  assert.equal(one.winnerName, 'Aldric');
  assert.deepEqual([one.nameKey, one.storedRealm, one.realmKey, one.winnerRealm], ['aldric', 'Nightslayer', 'nightslayer', 'Nightslayer']);
  assert.deepEqual(one.flags, ['OS', 'TMB'], 'known flags only, in the stored order');
  assert.equal(one.itemName, 'Sword', 'control characters are stripped');
  assert.equal(one.tag, 'OS');
  assert.deepEqual(Object.keys(normalizedOf(one)), ['checksum', 'itemId', 'itemName', 'quality', 'awardedAt', 'winnerName', 'winnerRealm', 'winnerClass', 'disenchanted', 'rollType', 'flags', 'awardedBy']);
  assert.equal(one.disenchanted, false, 'an award with a winner is not a disenchant');
  const [bare] = readAwards([{ checksum: 'abcdefgh', itemId: 5, awardedAt: at('2027-01-05', '20:00'), winnerName: 'Aldric' }], guild);
  assert.deepEqual([bare.itemName, bare.quality, bare.winnerRealm, bare.winnerClass, bare.rollType, bare.awardedBy, bare.flags], [null, null, null, null, null, null, []]);
  assert.deepEqual([bare.storedRealm, bare.realmKey], ['Nightslayer', 'nightslayer'], 'a missing realm is the guild\'s own');
  const [forever] = readAwards([award(1, { winnerRealm: 'Whatever' })], ruleset);
  assert.deepEqual([forever.storedRealm, forever.realmKey], [null, ''], 'a ruleset guild has no realm');
  assert.equal(readAwards([award(1, { itemName: 'x'.repeat(150), awardedBy: 'y'.repeat(90), rollType: 'z'.repeat(40) })], guild)[0].itemName.length, 100);
  assert.equal(readAwards([award(1), award(1, { itemName: 'later' }), award(2)], guild).length, 2, 'the same checksum twice counts once');
  assert.equal(readAwards([award(1), award(1, { itemName: 'later' })], guild)[0].itemName, 'Item 1', 'the first one wins');

  const refuse = (list, index, field, g = guild) => {
    try { readAwards(list, g); } catch (error) {
      assert.equal(error.status, 400);
      assert.equal(error.extra.field, 'awards');
      assert.equal(error.extra.index, index, JSON.stringify(list));
      assert.equal(error.extra.awardField, field, JSON.stringify(list));
      return;
    }
    assert.fail(`expected a 400 for ${JSON.stringify(list)}`);
  };
  refuse([award(1), award(2, { checksum: 'short' })], 1, 'checksum');
  refuse([award(1, { checksum: 'has space 123' })], 0, 'checksum');
  refuse([award(1, { checksum: 12345678 })], 0, 'checksum');
  refuse([award(1, { itemId: 0 })], 0, 'itemId');
  refuse([award(1, { itemId: 1.5 })], 0, 'itemId');
  refuse([award(1, { itemId: '5' })], 0, 'itemId');
  refuse([award(1, { awardedAt: '2027' })], 0, 'awardedAt');
  refuse([award(1, { awardedAt: 5 })], 0, 'awardedAt');
  refuse([award(1, { quality: 9 })], 0, 'quality');
  refuse([award(1, { quality: 'epic' })], 0, 'quality');
  refuse([award(1, { winnerName: 'Al' + '1' })], 0, 'winnerName');
  refuse([award(1, { winnerName: 'X' })], 0, 'winnerName');
  refuse([award(1, { winnerName: null })], 0, 'winnerName');
  refuse([award(1, { winnerClass: 'DEMON' })], 0, 'winnerClass');
  refuse([award(1, { flags: 'OS' })], 0, 'flags');
  refuse([award(1, { itemName: 5 })], 0, 'itemName');
  refuse([award(1, { winnerRealm: 5 })], 0, 'winnerRealm');
  refuse([award(1, { winnerRealm: '--' })], 0, 'winnerRealm');
  refuse([award(1), 5], 1, 'award');
  refuse([null], 0, 'award');
  refuse([[]], 0, 'award');
  const refuseList = (list) => assert.throws(() => readAwards(list, guild), (error) => error.status === 400 && error.extra.field === 'awards');
  refuseList(undefined); refuseList('x'); refuseList({}); refuseList([]);
  refuseList(Array.from({ length: MAX_AWARDS + 1 }, (_, i) => award(i)));
  assert.equal(readAwards(Array.from({ length: MAX_AWARDS }, (_, i) => award(i)), guild).length, MAX_AWARDS);

  assert.equal(autoTag([], 'MS'), 'MS');
  assert.equal(autoTag([], null), 'MS');
  assert.equal(autoTag(['OS'], 'MS'), 'OS');
  assert.equal(autoTag(['SR', 'WL'], 'SR'), 'MS');
  for (const text of ['OS', 'os', 'Off-Spec', 'off spec', 'offspec', 'Off_Spec roll']) assert.equal(autoTag([], text), 'OS', text);
  for (const text of ['Mostly', 'bonus', 'MS', 'osiris']) assert.equal(autoTag([], text), 'MS', text);

  const NY = 'America/New_York';
  assert.equal(onRaidDay(at('2027-01-05', '20:30'), '2027-01-05', NY), true);
  assert.equal(onRaidDay(at('2027-01-05', '00:00'), '2027-01-05', NY), true);
  assert.equal(onRaidDay(at('2027-01-05', '23:59'), '2027-01-05', NY), true);
  assert.equal(onRaidDay(at('2027-01-06', '02:30'), '2027-01-05', NY), true, 'a raid across midnight: until 06:00 the next local day');
  assert.equal(onRaidDay(at('2027-01-06', '05:59'), '2027-01-05', NY), true);
  assert.equal(onRaidDay(at('2027-01-06', '06:00'), '2027-01-05', NY), false);
  assert.equal(onRaidDay(at('2027-01-06', '19:00'), '2027-01-05', NY), false);
  assert.equal(onRaidDay(at('2027-01-04', '23:59'), '2027-01-05', NY), false, 'the day before is another day');
  assert.equal(onRaidDay(at('2027-01-07', '01:00'), '2027-01-05', NY), false, 'two days later is another day');
  assert.equal(onRaidDay(Date.parse('2027-01-06T04:00:00Z'), '2027-01-05', 'UTC'), true, 'the guild time zone decides, not the machine');
  assert.equal(onRaidDay(Date.parse('2027-01-06T07:00:00Z'), '2027-01-05', 'UTC'), false);

  const raid = { id: 'r_1', raid_on: '2027-01-05' };
  const [a] = readAwards([award(1)], guild);
  const stored = (over = {}) => ({
    raid_id: 'r_1', checksum: a.checksum, item_id: a.itemId, item_name: a.itemName, item_quality: a.quality, awarded_at: a.awardedAt, winner_name: 'Aldric',
    winner_name_key: 'aldric', winner_realm: 'Nightslayer', winner_realm_key: 'nightslayer', winner_class: 'WARRIOR', roll_type: 'MS', awarded_by: a.awardedBy,
    flags: '[]', tag: 'MS', tag_set_at: null, ...over,
  });
  assert.deepEqual(classifyAward(a, null, raid, NY), { status: 'new', tag: 'MS' });
  assert.deepEqual(classifyAward({ ...a, awardedAt: at('2027-01-03', '20:00') }, null, raid, NY), { status: 'otherDay', tag: 'MS' });
  assert.deepEqual(classifyAward(a, stored(), raid, NY), { status: 'same', tag: 'MS' });
  assert.deepEqual(classifyAward(a, stored({ raid_id: 'r_2', tag: 'DE', tag_set_at: 9 }), raid, NY), { status: 'otherRaid', tag: 'DE' });
  assert.deepEqual(classifyAward({ ...a, itemName: 'Renamed' }, stored(), raid, NY), { status: 'update', tag: 'MS' });
  assert.deepEqual(classifyAward({ ...a, nameKey: 'brindle', winnerName: 'Brindle' }, stored(), raid, NY), { status: 'update', tag: 'MS' });
  assert.deepEqual(classifyAward({ ...a, flags: ['OS'], tag: 'OS' }, stored(), raid, NY), { status: 'update', tag: 'OS' }, 'an automatic tag follows the award');
  assert.deepEqual(classifyAward({ ...a, flags: ['OS'], tag: 'OS' }, stored({ tag: 'DE', tag_set_at: 9 }), raid, NY), { status: 'update', tag: 'DE' }, 'a flag change still updates, the officer tag stays');
  assert.deepEqual(classifyAward({ ...a, tag: 'OS' }, stored({ tag: 'DE', tag_set_at: 9 }), raid, NY), { status: 'same', tag: 'DE' }, 'an officer tag is never a difference');
  assert.deepEqual(classifyAward({ ...a, awardedAt: at('2027-01-03', '20:00') }, stored({ awarded_at: at('2027-01-03', '20:00') }), raid, NY), { status: 'same', tag: 'MS' },
    'an award already on this raid stays on it, whatever its day');
});

check('balance maths: raids attended (fill-in cells and misses do not count, bench does), tags, perRaid, average, vsTeam, windows, inactive', async () => {
  const { lootBalance, attendedForLoot } = await load('worker/loot-metrics.js');
  const raids = [
    { id: 'old', raidOn: '2026-10-01' }, { id: 'a', raidOn: '2027-01-05' }, { id: 'b', raidOn: '2027-01-12' }, { id: 'c', raidOn: '2027-01-14' },
  ];
  const people = [
    { id: 'p1', name: 'Zed', class: 'MAGE', status: 'raider' },
    { id: 'p2', name: 'Amy', class: 'MAGE', status: 'raider' },
    { id: 'p3', name: 'Bob', class: 'MAGE', status: 'trial' },
    { id: 'p4', name: 'Cat', class: 'MAGE', status: 'raider' },
    { id: 'p5', name: 'Old', class: 'MAGE', status: 'inactive' },
    { id: 'p6', name: 'Gone', class: 'MAGE', status: 'inactive' },
  ];
  const att = (raidId, playerId, outcome, attended, credit) => ({ raidId, playerId, outcome, attended, credit });
  const rows = [
    att('old', 'p1', 'present', 1, 1), att('a', 'p1', 'present', 1, 1), att('b', 'p1', 'present', 1, 1), att('c', 'p1', 'late', 1, null),
    att('a', 'p2', 'present', 1, 1), att('b', 'p2', 'missed', 0, 0), att('c', 'p2', 'bench', 0, 1),
    att('a', 'p3', 'fill_in', 0, 1), att('b', 'p3', 'fill_in', 1, 1), att('c', 'p3', 'present', 1, 1),
    att('a', 'p5', 'present', 1, 1),
  ];
  const awards = [
    { raidId: 'old', personId: 'p1', tag: 'MS' }, { raidId: 'a', personId: 'p1', tag: 'MS' }, { raidId: 'b', personId: 'p1', tag: 'MS' },
    { raidId: 'b', personId: 'p1', tag: 'OS' }, { raidId: 'b', personId: 'p1', tag: 'DE' }, { raidId: 'c', personId: 'p1', tag: 'BANK' },
    { raidId: 'a', personId: 'p2', tag: 'MS' },
    { raidId: 'a', personId: 'p5', tag: 'MS' }, { raidId: 'old', personId: 'p6', tag: 'MS' }, { raidId: 'gone', personId: 'p4', tag: 'MS' },
  ];
  const run = (over = {}) => lootBalance({ people, raids, rows, awards, countTags: ['MS'], windowStart: '2027-01-01', today: '2027-01-16', ...over });
  const result = run();
  assert.deepEqual(result.people.map((p) => p.name), ['Amy', 'Bob', 'Cat', 'Old', 'Zed'], 'sorted by name; Inactive only with awards in the window');
  const get = (name) => result.people.find((p) => p.name === name);

  const zed = get('Zed');
  assert.deepEqual(zed.raids, { window: 3, all: 4 }, 'a late cell with no credit yet still attended');
  assert.deepEqual(zed.items, {
    MS: { window: 2, all: 3 }, OS: { window: 1, all: 1 }, DE: { window: 1, all: 1 }, BANK: { window: 1, all: 1 },
  });
  assert.deepEqual(zed.counted, { window: 2, all: 3 });
  assert.deepEqual(zed.perRaid, { window: 0.667, all: 0.75 });
  const amy = get('Amy');
  assert.deepEqual(amy.raids, { window: 2, all: 2 }, 'a miss does not count; a bench cell with credit does');
  assert.deepEqual(amy.perRaid, { window: 0.5, all: 0.5 });
  const bob = get('Bob');
  assert.deepEqual(bob.raids, { window: 1, all: 1 }, 'Other-team cells do not count, replaced home cell or host cell; only the present one does');
  assert.deepEqual(bob.perRaid, { window: 0, all: 0 });
  assert.deepEqual(get('Cat').raids, { window: 0, all: 0 });
  assert.deepEqual(get('Cat').perRaid, { window: null, all: null });
  assert.equal(get('Cat').vsTeam, null, 'no raids, no comparison');
  assert.deepEqual(get('Old').items.MS, { window: 1, all: 1 });
  assert.deepEqual(get('Old').perRaid, { window: 1, all: 1 });
  assert.deepEqual(result.teamAverage, { window: 0.542, all: 0.563 }, 'mean of the people with at least one raid (Zed, Amy, Bob, Old)');
  assert.deepEqual([zed.vsTeam, amy.vsTeam, bob.vsTeam, get('Old').vsTeam], [0.125, -0.042, -0.542, 0.458]);
  const { people: unrounded } = run({ countTags: ['MS', 'OS'] });
  const zed2 = unrounded.find((p) => p.name === 'Zed');
  assert.deepEqual([zed2.counted, zed2.perRaid], [{ window: 3, all: 4 }, { window: 1, all: 1 }]);
  assert.deepEqual(run({ windowStart: null }).people.find((p) => p.name === 'Zed').raids, { window: 4, all: 4 });
  assert.deepEqual(run({ today: '2027-01-12' }).people.find((p) => p.name === 'Zed').raids, { window: 2, all: 4 }, 'the window ends today');
  const none = lootBalance({ people: [], raids: [], rows: [], awards: [], countTags: ['MS'], windowStart: null, today: '2027-01-16' });
  assert.deepEqual(none, { people: [], teamAverage: { window: null, all: null } });
  const input = JSON.stringify({ people, raids, rows, awards });
  run();
  assert.equal(JSON.stringify({ people, raids, rows, awards }), input, 'the input is never mutated');
  assert.equal(attendedForLoot(att('a', 'x', 'present', 0, 0.5)), true);
  assert.equal(attendedForLoot(att('a', 'x', 'no_signup', 0, null)), false);
  assert.equal(attendedForLoot(att('a', 'x', 'tentative', 0, null)), false);
  assert.equal(attendedForLoot(att('a', 'x', 'fill_in', 1, 1)), false);
});

// ---------------------------------------------------------------------------
// Import

check('preview: classifies new / update / same / otherRaid / otherDay, matches winners, writes nothing', async () => {
  const s = await lootWorld({ imported: false });
  const paste = [
    award(1), award(2, { winnerName: 'Brindle', flags: ['OS'], rollType: 'OS' }), award(3, { winnerName: 'Nobodyhere', winnerClass: 'ROGUE' }),
    award(4, { awardedAt: at('2027-01-03', '20:00') }),
  ];
  const preview = await s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: paste });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(Object.keys(preview.json), ['rows', 'counts']);
  assert.deepEqual(preview.json.counts, { new: 3, update: 0, same: 0, otherRaid: 0, otherDay: 1 });
  assert.deepEqual(preview.json.rows.map((r) => [r.checksum, r.status, r.tag]), [
    [paste[0].checksum, 'new', 'MS'], [paste[1].checksum, 'new', 'OS'], [paste[2].checksum, 'new', 'MS'], [paste[3].checksum, 'otherDay', 'MS'],
  ]);
  const first = preview.json.rows[0];
  assert.deepEqual(Object.keys(first), ['checksum', 'itemId', 'itemName', 'quality', 'awardedAt', 'winnerName', 'winnerRealm', 'winnerClass', 'disenchanted', 'rollType', 'flags', 'awardedBy', 'status', 'match', 'tag']);
  assert.deepEqual(first.match, { kind: 'character', personId: s.p.aldric, personName: 'Aldric', characterId: first.match.characterId, characterName: 'Aldric', isMain: true });
  assert.equal(preview.json.rows[2].match.kind, 'unmatched');
  assert.deepEqual(preview.json.rows[2].match, { kind: 'unmatched' });
  assert.equal(await s.w.count('loot_awards'), 0, 'a preview writes nothing');
  assert.equal(await s.w.count('audit_log', "action LIKE 'loot.%'"), 0);

  assert.equal((await s.import('bob', s.r1, paste.slice(0, 3))).status, 200);
  // Second look: two are on this raid already (one changed), one is new, one is on another raid.
  const again = await s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: [paste[0], { ...paste[1], itemName: 'Renamed' }, award(5)] });
  assert.deepEqual(again.json.counts, { new: 1, update: 1, same: 1, otherRaid: 0, otherDay: 0 });
  assert.deepEqual(again.json.rows.map((r) => r.status), ['same', 'update', 'new']);
  const elsewhere = await s.call('bob', 'POST', s.loot(s.r2, '/preview'), { awards: [{ ...paste[0], awardedAt: at('2027-01-12', '20:00') }] });
  assert.deepEqual(elsewhere.json.counts, { new: 0, update: 0, same: 0, otherRaid: 1, otherDay: 0 });
  assert.equal(elsewhere.json.rows[0].tag, 'MS', 'an award on another raid shows the tag it has there');
});

check('commit: inserts with the automatic tag, answers the contract shape, one audit entry with counts; a repeat changes nothing', async () => {
  const s = await lootWorld({ imported: false });
  const paste = [award(2, { winnerName: 'Brindle', awardedAt: at('2027-01-05', '20:40'), flags: ['OS', 'SR'], rollType: 'SR' }), award(1, { awardedAt: at('2027-01-05', '20:10') })];
  const done = await s.import('bob', s.r1, paste);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(Object.keys(done.json), ['inserted', 'updated', 'unchanged', 'skippedOtherRaid', 'skippedOtherDay', 'awards']);
  assert.deepEqual([done.json.inserted, done.json.updated, done.json.unchanged, done.json.skippedOtherRaid, done.json.skippedOtherDay], [2, 0, 0, 0, 0]);
  const a = done.json.awards;
  assert.deepEqual(a.map((x) => x.winner.name), ['Aldric', 'Brindle'], 'ordered by awardedAt');
  assert.deepEqual(Object.keys(a[0]), ['id', 'raidId', 'raidOn', 'teamId', 'itemId', 'itemName', 'quality', 'awardedAt', 'winner', 'match', 'tag', 'tagSetBy', 'flags', 'rollType', 'note', 'awardedBy']);
  assert.deepEqual(a[0], {
    id: a[0].id, raidId: s.r1, raidOn: '2027-01-05', teamId: s.A, itemId: 30001, itemName: 'Item 1', quality: 4, awardedAt: at('2027-01-05', '20:10'),
    winner: { name: 'Aldric', realm: 'Nightslayer', class: 'WARRIOR' },
    match: { kind: 'character', personId: s.p.aldric, personName: 'Aldric', characterId: a[0].match.characterId, characterName: 'Aldric', isMain: true },
    tag: 'MS', tagSetBy: null, flags: [], rollType: 'MS', note: null, awardedBy: 'Bobby-Nightslayer',
  });
  assert.match(a[0].id, /^lo_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([a[1].tag, a[1].tagSetBy, a[1].flags, a[1].rollType], ['OS', null, ['OS', 'SR'], 'SR'], 'Gargul\'s off-spec flag tags the award OS');
  const stored = (await s.w.rows('SELECT * FROM loot_awards ORDER BY awarded_at'))[0];
  assert.deepEqual([stored.guild_id, stored.team_id, stored.raid_id, stored.source, stored.created_by, stored.created_at, stored.updated_at, stored.tag_set_by, stored.tag_set_at],
    [s.guildId, s.A, s.r1, 'gargul', s.ids.bob, s.w.clock.now, s.w.clock.now, null, null]);
  assert.equal(stored.winner_name_key + '|' + stored.winner_realm_key, 'aldric|nightslayer');
  const audit = await s.w.rows("SELECT * FROM audit_log WHERE action = 'loot.import'");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].entity_type, audit[0].entity_id, audit[0].actor_user_id, audit[0].guild_id], ['raid', s.r1, s.ids.bob, s.guildId]);
  assert.deepEqual(JSON.parse(audit[0].after), { inserted: 2, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0, includeOtherDay: false });

  const again = await s.import('bob', s.r1, paste);
  assert.deepEqual([again.json.inserted, again.json.updated, again.json.unchanged], [0, 0, 2]);
  assert.deepEqual(again.json.awards.map((x) => x.id), a.map((x) => x.id), 'the same rows');
  assert.equal(await s.w.count('loot_awards'), 2);
  const get = await s.call('bob', 'GET', s.loot(s.r1));
  assert.deepEqual(Object.keys(get.json), ['awards', 'canEdit']);
  assert.deepEqual(get.json, { awards: a, canEdit: true });
});

check('commit: an update rewrites the item and winner, keeps the officer tag and note, and the automatic tag follows the flags', async () => {
  const s = await lootWorld({ imported: false });
  const [first, second] = [award(1), award(2, { winnerName: 'Brindle' })];
  await s.import('bob', s.r1, [first, second]);
  const ids = Object.fromEntries((await s.w.rows('SELECT id, checksum FROM loot_awards')).map((r) => [r.checksum, r.id]));
  assert.equal((await s.call('bob', 'PATCH', `/loot/${ids[first.checksum]}`, { tag: 'DE', note: 'Disenchant, agreed in chat' })).status, 200);
  const edited = [
    { ...first, itemName: 'Corrected name', winnerName: 'Cassia', winnerClass: 'MAGE', flags: ['OS'], rollType: 'OS' },   // winner edited in Gargul, same checksum
    { ...second, flags: ['OS'], rollType: 'OS' },                                                                           // an automatic tag moves to OS
  ];
  const done = await s.import('bob', s.r1, edited);
  assert.deepEqual([done.json.inserted, done.json.updated, done.json.unchanged], [0, 2, 0]);
  const stored = await byChecksum(s.w);
  const one = stored[first.checksum];
  assert.deepEqual([one.item_name, one.winner_name, one.winner_name_key, one.winner_class, one.roll_type, one.flags], ['Corrected name', 'Cassia', 'cassia', 'MAGE', 'OS', '["OS"]']);
  assert.deepEqual([one.tag, one.note, one.tag_set_by, one.id], ['DE', 'Disenchant, agreed in chat', s.ids.bob, ids[first.checksum]], 'the officer tag, note and id are kept');
  assert.equal(stored[second.checksum].tag, 'OS', 'an automatic tag follows the award');
  assert.equal(stored[second.checksum].tag_set_at, null);
  const view = done.json.awards.find((x) => x.id === ids[first.checksum]);
  assert.deepEqual([view.tag, view.tagSetBy, view.note, view.match.personName], ['DE', 'officer', 'Disenchant, agreed in chat', 'Cassia']);
  assert.equal(await s.w.count('loot_awards'), 2);
  // The officer's account goes away: the tag still counts as set by hand.
  exec(s.w, `DELETE FROM users WHERE id = '${s.ids.bob}'`);
  const once = await s.call('alice', 'POST', s.loot(s.r1), { awards: [{ ...edited[0], flags: [], rollType: 'MS' }] });
  assert.equal(once.status, 200);
  assert.equal((await byChecksum(s.w))[first.checksum].tag, 'DE');
  assert.equal(once.json.awards.find((x) => x.id === ids[first.checksum]).tagSetBy, 'officer');
});

check('commit: the same checksum on another raid is skipped; awards from another day wait for includeOtherDay; midnight crossing counts', async () => {
  const s = await lootWorld({ imported: false });
  await s.import('bob', s.r1, [award(1)]);
  const other = [
    award(1, { awardedAt: at('2027-01-12', '20:00') }),                         // on r1 already
    award(2, { awardedAt: at('2027-01-12', '20:10') }),
    award(3, { awardedAt: at('2027-01-11', '20:10') }),                         // the day before
    award(4, { awardedAt: at('2027-01-13', '02:30') }),                         // 02:30 after the raid night
    award(5, { awardedAt: at('2027-01-13', '07:00') }),                         // the next morning
  ];
  const skipped = await s.import('bob', s.r2, other);
  assert.deepEqual([skipped.json.inserted, skipped.json.updated, skipped.json.unchanged, skipped.json.skippedOtherRaid, skipped.json.skippedOtherDay], [2, 0, 0, 1, 2]);
  assert.deepEqual(skipped.json.awards.map((x) => x.itemId), [30002, 30004]);
  assert.equal(await s.w.count('loot_awards', 'raid_id = ?', s.r1), 1, 'the award on r1 stayed there');
  const all = await s.import('bob', s.r2, other, { includeOtherDay: true });
  assert.deepEqual([all.json.inserted, all.json.updated, all.json.unchanged, all.json.skippedOtherRaid, all.json.skippedOtherDay], [2, 0, 2, 1, 0]);
  assert.deepEqual(all.json.awards.map((x) => x.itemId), [30003, 30002, 30004, 30005]);
  const audit = await s.w.rows("SELECT after FROM audit_log WHERE action = 'loot.import' ORDER BY created_at, rowid");
  assert.deepEqual(JSON.parse(audit[audit.length - 1].after), { inserted: 2, updated: 0, unchanged: 2, skippedOtherRaid: 1, skippedOtherDay: 0, includeOtherDay: true });
  // An award that was let in from another day stays on its raid on the next look.
  const preview = await s.call('bob', 'POST', s.loot(s.r2, '/preview'), { awards: other });
  assert.deepEqual(preview.json.counts, { new: 0, update: 0, same: 4, otherRaid: 1, otherDay: 0 });
  assert.equal((await s.import('bob', s.r2, other, { includeOtherDay: 'yes' })).status, 400);
});

check('import: a raid that has not started is a 409; only editors of the raid\'s team may preview or import; bad requests are 400', async () => {
  const s = await lootWorld({ imported: false });
  const paste = [award(1)];
  for (const route of [s.loot(s.up), s.loot(s.up, '/preview')]) {
    const r = await s.call('bob', 'POST', route, { awards: [award(1, { awardedAt: at('2027-02-02', '20:00') })] });
    assert.equal(r.status, 409, route);
    assert.equal(r.json.error, 'raid_not_started');
  }
  assert.equal(await s.w.count('loot_awards'), 0);
  for (const route of [s.loot(s.r1), s.loot(s.r1, '/preview')]) {
    assert.equal((await s.call('erin', 'POST', route, { awards: paste })).status, 403, `member ${route}`);
    assert.equal((await s.call('dave', 'POST', route, { awards: paste })).status, 403, `Team Lead of the other team ${route}`);
    assert.equal((await s.call('carol', 'POST', route, { awards: paste })).status, 200, `Team Lead of the team ${route}`);
    assert.equal((await s.call('alice', 'POST', route, { awards: paste })).status, 200, `Guild Master ${route}`);
  }
  assert.equal((await s.call('dave', 'POST', s.loot(s.rb), { awards: [award(7, { winnerName: 'Wanderfell' })] })).status, 200, 'the other team\'s lead imports to their own raid');
  assert.equal((await s.call('carol', 'POST', s.loot(s.rb), { awards: paste })).status, 403);
  const signedOut = await s.w.call(newJar(), 'POST', `${s.guildPath}${s.loot(s.r1)}`, { awards: paste });
  assert.equal(signedOut.status, 401);

  const post = (body, extra) => s.call('bob', 'POST', s.loot(s.r1), body, extra);
  const field = async (body) => { const r = await post(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, 'bad_request'); return r.json; };
  assert.equal((await field({})).field, 'awards');
  assert.equal((await field({ awards: [] })).field, 'awards');
  assert.equal((await field({ awards: 'x' })).field, 'awards');
  const index = await field({ awards: [award(11), { ...award(12), checksum: 'no spaces allowed' }] });
  assert.deepEqual([index.field, index.index, index.awardField], ['awards', 1, 'checksum']);
  assert.equal((await field({ awards: Array.from({ length: 501 }, (_, i) => award(100 + i)) })).field, 'awards');
  assert.equal((await post(undefined, { rawBody: '[]' })).status, 400);
  assert.equal((await post({ awards: paste }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await s.call('bob', 'POST', s.loot('r_AAAAAAAAAAAAAAAAAAAAAA'), { awards: paste })).status, 404, 'an unknown raid');
  assert.equal((await s.call('bob', 'POST', s.loot('not-a-raid'), { awards: paste })).status, 404, 'a malformed id');
  const other = await secondGuild(s);
  assert.equal((await s.w.call(other.frank, 'POST', `${other.path}${s.loot(s.r1)}`, { awards: paste })).status, 404, 'another guild\'s raid id');
  assert.equal((await s.w.call(other.frank, 'GET', `${other.path}${s.loot(s.r1)}`)).status, 404);
  assert.equal((await s.w.call(other.frank, 'POST', `${s.guildPath}${s.loot(s.r1)}`, { awards: paste })).status, 403, 'not a member here');
});

check('import: 500 awards in one request fit D1\'s limits (chunked writes), the body cap is sized for them, an over-size body is a 413', async () => {
  const s = await lootWorld({ imported: false });
  const names = ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Zorgax', 'Quillon'];
  const big = Array.from({ length: 500 }, (_, i) => award(1000 + i, {
    winnerName: names[i % names.length], awardedAt: at('2027-01-05', '20:00') + i * 1000, itemName: 'Tier Token of the Longest Possible Name '.repeat(2).slice(0, 100),
    flags: i % 2 ? ['OS', 'SR', 'WL', 'PL', 'TMB'] : [], awardedBy: 'A'.repeat(64),
  }));
  const preview = await s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: big });
  assert.equal(preview.status, 200, JSON.stringify(preview.json).slice(0, 300));
  assert.equal(preview.json.rows.length, 500);
  const done = await s.import('bob', s.r1, big);
  assert.equal(done.status, 200, JSON.stringify(done.json).slice(0, 300));
  assert.deepEqual([done.json.inserted, done.json.awards.length], [500, 500]);
  assert.equal(await s.w.count('loot_awards'), 500);
  const edited = big.map((a, i) => (i % 3 === 0 ? { ...a, itemName: 'Changed' } : a));
  const second = await s.import('bob', s.r1, edited);
  assert.deepEqual([second.json.inserted, second.json.updated, second.json.unchanged], [0, 167, 333]);
  const size = JSON.stringify({ awards: big.map((a) => ({ ...a, itemName: 'é'.repeat(100), awardedBy: 'é'.repeat(64) })) }).length;
  assert(size < 512 * 1024, `500 awards of the largest kind are ${size} bytes`);
  const huge = await s.call('bob', 'POST', s.loot(s.r1), undefined, { rawBody: JSON.stringify({ awards: [], pad: 'x'.repeat(513 * 1024) }) });
  assert.equal(huge.status, 413);
});

check('ruleset guild (WoW Forever): no realm anywhere, winners match by name', async () => {
  const s = await scenario({ guildBody: { gameVersion: 'forever', realm: 'Normal' } });
  const made = await addPerson(s, 'bob', s.teamId, 'Aldric');
  const raid = await s.call('bob', 'POST', '/raids', { teamId: s.teamId, raidOn: '2027-01-05' });
  const id = raid.json.raid.id;
  const done = await s.call('bob', 'POST', `/raids/${id}/loot`, { awards: [award(1, { winnerRealm: 'Nightslayer' }), award(2, { winnerRealm: null, winnerName: 'Nomatch' })] });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(done.json.awards.map((a) => [a.winner.realm, a.match.kind]), [[null, 'character'], [null, 'unmatched']]);
  assert.equal(done.json.awards[0].match.personId, made.person.id);
  assert.equal((await s.w.rows('SELECT winner_realm_key FROM loot_awards'))[0].winner_realm_key, '');
});

check('commit: a checksum another officer imported a moment ago is a 409 and nothing of this request is written', async () => {
  const s = await lootWorld({ imported: false });
  const original = s.w.db.batch.bind(s.w.db);
  let raced = false;
  s.w.db.batch = async (statements) => {
    if (!raced && statements.some((statement) => /INSERT INTO loot_awards/.test(statement.sql))) {
      raced = true;
      exec(s.w, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, winner_name, winner_name_key, created_at, updated_at)
                 VALUES ('lo_race', '${s.guildId}', '${s.r1}', '${s.A}', '${award(2).checksum}', 5, 1, 'Aldric', 'aldric', 1, 1)`);
    }
    return original(statements);
  };
  const r = await s.import('bob', s.r1, [award(1), award(2), award(3)]);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error, 'conflict');
  assert.equal(await s.w.count('loot_awards'), 1, 'the whole batch rolled back; only the racing row exists');
  assert.equal(await s.w.count('audit_log', "action = 'loot.import'"), 0);
  const again = await s.import('bob', s.r1, [award(1), award(2), award(3)]);
  assert.deepEqual([again.status, again.json.inserted, again.json.unchanged + again.json.updated], [200, 2, 1], 'a retry sees the new row');
});

check('request budgets: D1 calls per route stay small (session and rate limit included): a regression guard', async () => {
  const s = await lootWorld();
  const budgets = [];
  const measure = async (label, fn, max) => {
    const n = await counted(s.w, fn);
    budgets.push(`${label}: ${n} d1`);
    assert(n <= max, `${label} made ${n} D1 calls (budget ${max})`);
  };
  const ok = async (promise) => { const r = await promise; assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200)); };
  await measure('GET raid loot', () => ok(s.call('bob', 'GET', s.loot(s.r1))), 5);
  await measure('POST preview', () => ok(s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: s.awards.r1 })), 5);
  await measure('POST commit (no change)', () => ok(s.import('bob', s.r1, s.awards.r1)), 8);
  await measure('POST commit (6 new)', () => ok(s.import('bob', s.r2, s.awards.r1.map((a, i) => ({ ...a, checksum: `NEW${String(i).padStart(10, '0')}`, awardedAt: at('2027-01-12', '21:00') + i })))), 8);
  await measure('GET balance', () => ok(s.call('bob', 'GET', `/loot/balance?team=${s.A}`)), 3);
  await measure('GET by raid', () => ok(s.call('bob', 'GET', `/loot/raids?team=${s.A}`)), 3);
  await measure('GET by item', () => ok(s.call('bob', 'GET', `/loot/items?team=${s.A}`)), 3);
  await measure('GET person', () => ok(s.call('bob', 'GET', `/loot/person/${s.p.aldric}`)), 3);
  await measure('PATCH award', () => ok(s.call('bob', 'PATCH', `/loot/${s.awardId[1]}`, { note: 'x' })), 7);
  await measure('DELETE award', () => ok(s.call('bob', 'DELETE', `/loot/${s.awardId[9]}`, {})), 5);
  await measure('GET policy', () => ok(s.call('bob', 'GET', '/loot/policy')), 3);
  await measure('PUT policy', () => ok(s.call('bob', 'PUT', '/loot/policy', { teamId: null, override: {}, version: 0 })), 6);
  await measure('GET review', () => ok(s.call('bob', 'GET', `/attendance/review?team=${s.A}`)), 4);
  console.log(`      ${budgets.join('\n      ')}`);
});

// ---------------------------------------------------------------------------
// Tags, notes, delete

check('PATCH: a tag set by hand, a note, both; validation; permissions; audit without names; DELETE frees the checksum', async () => {
  const s = await lootWorld();
  const id = s.awardId[3];
  const patch = (who, body, target = id) => s.call(who, 'PATCH', `/loot/${target}`, body);
  const tagged = await patch('bob', { tag: 'OS' });
  assert.equal(tagged.status, 200, JSON.stringify(tagged.json));
  assert.deepEqual(Object.keys(tagged.json), ['award']);
  assert.deepEqual([tagged.json.award.tag, tagged.json.award.tagSetBy, tagged.json.award.note, tagged.json.award.id], ['OS', 'officer', null, id]);
  const row1 = (await s.w.rows('SELECT * FROM loot_awards WHERE id = ?', id))[0];
  assert.deepEqual([row1.tag_set_by, row1.tag_set_at, row1.updated_at], [s.ids.bob, s.w.clock.now, s.w.clock.now]);

  s.w.advance = (ms) => { s.w.clock.now += ms; };
  s.w.advance(60_000);
  const noted = await patch('carol', { note: '  Traded to the tank  ' });
  assert.equal(noted.status, 200);
  assert.deepEqual([noted.json.award.note, noted.json.award.tag, noted.json.award.tagSetBy], ['Traded to the tank', 'OS', 'officer']);
  const row2 = (await s.w.rows('SELECT * FROM loot_awards WHERE id = ?', id))[0];
  assert.deepEqual([row2.tag_set_by, row2.tag_set_at], [s.ids.bob, row1.tag_set_at], 'a note leaves the tag fields alone');
  const both = await patch('bob', { tag: 'BANK', note: null });
  assert.deepEqual([both.json.award.tag, both.json.award.note], ['BANK', null]);
  assert.equal((await patch('bob', { note: '' })).json.award.note, null);
  for (const tag of ALL_TAGS) assert.equal((await patch('bob', { tag })).json.award.tag, tag);

  for (const body of [{}, { tag: 'ms' }, { tag: 'GREED' }, { tag: null }, { tag: 5 }, { note: 'x'.repeat(201) }, { note: 5 }, { note: 'line\nbreak' }]) {
    const r = await patch('bob', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'bad_request');
  }
  assert.equal((await patch('erin', { tag: 'MS' })).status, 403);
  assert.equal((await patch('dave', { tag: 'MS' })).status, 403, 'a Team Lead of the other team');
  assert.equal((await patch('carol', { tag: 'MS' })).status, 200);
  assert.equal((await patch('dave', { tag: 'MS' }, s.awardId[10])).status, 200, 'the other team\'s lead tags their own');
  assert.equal((await patch('bob', { tag: 'MS' }, 'lo_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await patch('bob', { tag: 'MS' }, 'balance')).status, 404);
  const other = await secondGuild(s);
  assert.equal((await s.w.call(other.frank, 'PATCH', `${other.path}/loot/${id}`, { tag: 'MS' })).status, 404, 'another guild\'s award');
  assert.equal((await s.w.call(other.frank, 'DELETE', `${other.path}/loot/${id}`, {})).status, 404);

  assert.equal((await s.call('erin', 'DELETE', `/loot/${id}`, {})).status, 403);
  assert.equal((await s.call('dave', 'DELETE', `/loot/${id}`, {})).status, 403);
  assert.equal(await s.w.count('loot_awards', 'id = ?', id), 1);
  const removed = await s.call('carol', 'DELETE', `/loot/${id}`, {});
  assert.deepEqual([removed.status, removed.json], [200, { ok: true }]);
  assert.equal(await s.w.count('loot_awards', 'id = ?', id), 0);
  assert.equal((await s.call('carol', 'DELETE', `/loot/${id}`, {})).status, 404);
  // The checksum is free again: the same award can be imported a second time.
  const back = await s.import('bob', s.r1, [s.awards.r1[2]]);
  assert.deepEqual([back.json.inserted, back.json.awards.find((a) => a.itemId === 30003).tagSetBy], [1, null]);

  const audits = await s.w.rows("SELECT action, entity_type, entity_id, before, after FROM audit_log WHERE action IN ('loot.update', 'loot.delete') ORDER BY created_at, rowid");
  assert(audits.some((a) => a.action === 'loot.update') && audits.some((a) => a.action === 'loot.delete'));
  assert(audits.every((a) => a.entity_type === 'loot'));
  const dump = (await s.w.rows("SELECT before, after FROM audit_log WHERE action LIKE 'loot.%'")).map((r) => `${r.before} ${r.after}`).join('\n');
  for (const secret of ['Traded to the tank', 'Aldric', 'Brindle', 'Zorgax', 'Wanderfell', 'GARG', 'Item ', 'Tier Token']) assert.equal(dump.includes(secret), false, `audit rows must not contain ${secret}`);
});

// ---------------------------------------------------------------------------
// Matching on read, the review queue

check('matching on read: a character, a guest or nobody; linking a name fixes past awards; the review queue and POST unmatched take loot-only names', async () => {
  const s = await lootWorld();
  const list = async () => (await s.call('bob', 'GET', s.loot(s.r1))).json.awards;
  let awards = await list();
  const kinds = Object.fromEntries(awards.map((a) => [a.winner.name, a.match.kind]));
  assert.deepEqual(kinds, { Aldric: 'character', Brindle: 'character', Cassia: 'character', Zorgax: 'unmatched', Visitor: 'guest' });
  const alt = awards.filter((a) => a.winner.name === 'Aldric').map((a) => a.match.isMain);
  assert.deepEqual(alt, [true, true]);
  assert.deepEqual(awards.find((a) => a.winner.name === 'Zorgax').match, { kind: 'unmatched' });
  assert.deepEqual(awards.find((a) => a.winner.name === 'Visitor').match, { kind: 'guest' });

  // The review queue lists the one winner nobody matches; the guest is not there.
  const review = await s.call('bob', 'GET', `/attendance/review?team=${s.A}`);
  assert.equal(review.status, 200, JSON.stringify(review.json));
  assert.deepEqual(review.json.raids, [], 'no attendance flags');
  assert.deepEqual(review.json.lootUnmatched, [{
    raid: { id: s.r1, raidOn: '2027-01-05', zone: null },
    items: [{ kind: 'unmatched', key: 'zorgax|nightslayer', name: 'Zorgax', realm: 'Nightslayer', class: 'ROGUE', awards: 1 }],
  }]);
  assert.deepEqual((await s.call('carol', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched.length, 1);
  assert.equal((await s.call('dave', 'GET', `/attendance/review?team=${s.A}`)).status, 403);
  // Team B has none.
  assert.deepEqual((await s.call('bob', 'GET', `/attendance/review?team=${s.B}`)).json.lootUnmatched, []);

  // The route refuses a name in neither the log nor the loot.
  const none = await s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: 'nobody|nightslayer', action: 'guest' });
  assert.equal(none.status, 404);
  assert.match(none.json.message, /log or loot/);
  assert.equal((await s.call('bob', 'POST', `/raids/${s.r2}/unmatched`, { key: 'zorgax|nightslayer', action: 'guest' })).status, 404, 'Zorgax won on r1, not on r2');
  assert.equal((await s.call('dave', 'POST', `/raids/${s.r1}/unmatched`, { key: 'zorgax|nightslayer', action: 'guest' })).status, 403);

  // Link Zorgax as an Alt of Dunmar: his award is now Dunmar's, and the balance counts it.
  const before = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json;
  assert.deepEqual(row(before, s.p.dunmar).items.MS, { window: 0, all: 0 });
  const linked = await s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: 'zorgax|nightslayer', action: 'alt', personId: s.p.dunmar });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  awards = await list();
  const zorgax = awards.find((a) => a.winner.name === 'Zorgax');
  assert.deepEqual([zorgax.match.kind, zorgax.match.personId, zorgax.match.personName, zorgax.match.characterName, zorgax.match.isMain], ['character', s.p.dunmar, 'Dunmar', 'Zorgax', false]);
  assert.deepEqual((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched, []);
  const after = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json;
  assert.deepEqual(row(after, s.p.dunmar).items.MS, { window: 1, all: 1 });
  // Marking a guest works from loot alone too, and a guest never reaches the balance.
  assert.equal((await s.import('bob', s.r2, [award(20, { winnerName: 'Passerby', winnerClass: 'PRIEST', awardedAt: at('2027-01-12', '21:00') })])).status, 200);
  assert.equal((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched[0].items[0].name, 'Passerby');
  assert.equal((await s.call('bob', 'POST', `/raids/${s.r2}/unmatched`, { key: 'passerby|nightslayer', action: 'guest' })).status, 200);
  assert.deepEqual((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched, []);
  assert.equal((await s.call('bob', 'GET', s.loot(s.r2))).json.awards.find((a) => a.winner.name === 'Passerby').match.kind, 'guest');
  assert.equal(JSON.stringify((await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json).includes('Passerby'), false);
});

check('review: a loot winner added as a new person becomes a Main; a winner with no class cannot be added; a name in both log and loot works', async () => {
  const s = await lootWorld({ imported: false });
  await s.import('bob', s.r1, [
    award(1, { winnerName: 'Newbie', winnerClass: 'PRIEST' }), award(2, { winnerName: 'Classless', winnerClass: null }), award(3, { winnerName: 'Newbie', winnerClass: 'PRIEST' }),
  ]);
  const queue = (await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched;
  assert.deepEqual(queue[0].items.map((i) => [i.name, i.class, i.awards]), [['Classless', null, 1], ['Newbie', 'PRIEST', 2]]);
  const classless = await s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: 'classless|nightslayer', action: 'person' });
  assert.equal(classless.status, 400, 'a character needs a class');
  const added = await s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: 'newbie|nightslayer', action: 'person', status: 'trial' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const person = (await s.w.rows("SELECT p.id, p.status, c.name, c.class, c.is_main, c.team_id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Newbie'"))[0];
  assert.deepEqual([person.status, person.class, person.is_main, person.team_id], ['trial', 'PRIEST', 1, s.A]);
  const awards = (await s.call('bob', 'GET', s.loot(s.r1))).json.awards.filter((a) => a.winner.name === 'Newbie');
  assert.deepEqual(awards.map((a) => [a.match.kind, a.match.personId, a.match.isMain]), [['character', person.id, true], ['character', person.id, true]]);
  assert.equal((await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched[0].items.length, 1);
});

// ---------------------------------------------------------------------------
// Views

check('every loot route needs a session (401 before anything else, even for a malformed id) and a guild member (403)', async () => {
  const s = await lootWorld({ imported: false });
  const id = 'lo_AAAAAAAAAAAAAAAAAAAAAA';
  const routes = [
    ['GET', s.loot(s.r1)], ['POST', s.loot(s.r1, '/preview')], ['POST', s.loot(s.r1)], ['GET', `/loot/balance?team=${s.A}`], ['GET', `/loot/raids?team=${s.A}`],
    ['GET', `/loot/items?team=${s.A}`], ['GET', `/loot/person/${s.p.aldric}`], ['GET', '/loot/policy'], ['PUT', '/loot/policy'], ['PATCH', `/loot/${id}`],
    ['PATCH', '/loot/nope'], ['DELETE', `/loot/${id}`],
  ];
  const outsider = await signIn(s.w, PEOPLE.frank, [plain(SERVER_B)]);
  for (const [method, route] of routes) {
    const body = method === 'GET' ? undefined : { awards: [award(1)], teamId: null, override: {}, version: 0, tag: 'MS' };
    assert.equal((await s.w.call(newJar(), method, `${s.guildPath}${route}`, body)).status, 401, `${method} ${route} signed out`);
    const response = await s.w.call(outsider, method, `${s.guildPath}${route}`, body);
    if (route === '/loot/nope') { assert.equal(response.status, 404, 'a malformed id is a plain 404 once signed in'); continue; }
    assert.equal(response.status, 403, `${method} ${route} outside the Discord server`);
    assert.equal(response.json.error, 'not_member');
  }
  // A method the path does not have.
  assert.equal((await s.call('bob', 'DELETE', '/loot/balance', {})).status, 404);
  assert.equal((await s.call('bob', 'POST', '/loot/balance', {})).status, 405);
  assert.equal((await s.call('bob', 'PUT', s.loot(s.r1), {})).status, 405);
});

check('GET raid loot: awards by awardedAt, canEdit per viewer, all-roles access under the default ("their teams")', async () => {
  const s = await lootWorld();
  const full = await s.call('bob', 'GET', s.loot(s.r1));
  assert.equal(full.status, 200);
  assert.deepEqual(full.json.awards.map((a) => a.itemId), [28770, 30002, 30003, 30004, 30005, 30006]);
  assert.equal(full.json.canEdit, true);
  const awardsOf = full.json.awards;
  assert.deepEqual(awardsOf.map((a) => a.tag), ['MS', 'OS', 'MS', 'DE', 'MS', 'MS']);
  assert.deepEqual(awardsOf.map((a) => a.tagSetBy), [null, null, null, 'officer', null, null]);
  for (const [who, edit] of [['alice', true], ['carol', true], ['erin', false]]) {
    const r = await s.call(who, 'GET', s.loot(s.r1));
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.json, { awards: awardsOf, canEdit: edit }, who);
  }
  // Dave leads team B only and has no character on team A.
  assert.equal((await s.call('dave', 'GET', s.loot(s.r1))).status, 403);
  assert.equal((await s.call('dave', 'GET', s.loot(s.rb))).status, 200);
  assert.equal((await s.call('erin', 'GET', s.loot(s.rb))).status, 403, 'Erin has no character on team B');
  assert.deepEqual((await s.call('bob', 'GET', s.loot(s.up))).json, { awards: [], canEdit: true }, 'an upcoming raid simply has none');
  assert.equal((await s.call('bob', 'GET', s.loot('r_AAAAAAAAAAAAAAAAAAAAAA'))).status, 404);
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}${s.loot(s.r1)}`)).status, 401);
  const me = (await s.w.call(s.jars.erin, 'GET', s.guildPath)).json.me;
  assert.deepEqual(me.can['loot.view'], [s.A]);
  assert.equal(me.can['loot.edit'], undefined);
  assert.equal((await s.w.call(s.jars.bob, 'GET', s.guildPath)).json.me.can['loot.policy'], 'guild');
});

check('balance: the contract shape and the maths over the window and all time; Cassia\'s DE and the guest never count; Wanderfell\'s fill-in is not a raid', async () => {
  const s = await lootWorld();
  // Sanity: Wanderfell\'s home cell on his own team\'s raid became an Other-team cell, which is not a raid for loot.
  const cell = (await s.w.rows('SELECT outcome, credit, attended FROM attendance WHERE raid_id = ? AND player_id = ?', s.rb, s.p.wander))[0];
  assert.deepEqual([cell.outcome, cell.credit], ['fill_in', 1]);

  const r = await s.call('bob', 'GET', `/loot/balance?team=${s.A}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = r.json;
  assert.deepEqual(Object.keys(b), ['team', 'window', 'mode', 'countTags', 'scope', 'people', 'teamAverage']);
  assert.deepEqual(b.team, { id: s.A, name: 'Alpha' });
  assert.deepEqual(b.window, { weeks: 8, switchWeeks: [8, 12], from: '2026-11-24' });
  assert.deepEqual([b.mode, b.countTags, b.scope], ['perRaid', ['MS'], 'team']);
  assert.deepEqual(b.people.map((p) => p.name), ['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  assert.deepEqual(Object.keys(b.people[0]), ['personId', 'name', 'class', 'status', 'raids', 'items', 'counted', 'perRaid', 'vsTeam']);
  assert.deepEqual(Object.keys(b.people[0].items), ALL_TAGS);
  const aldric = row(b, s.p.aldric);
  assert.deepEqual(aldric, {
    personId: s.p.aldric, name: 'Aldric', class: 'WARRIOR', status: 'raider',
    raids: { window: 2, all: 3 },
    items: { MS: { window: 2, all: 3 }, OS: { window: 1, all: 1 }, DE: { window: 0, all: 0 }, BANK: { window: 0, all: 0 } },
    counted: { window: 2, all: 3 }, perRaid: { window: 1, all: 1 }, vsTeam: 0.333,
  });
  assert.deepEqual(row(b, s.p.brindle).raids, { window: 2, all: 2 }, 'r0 was Aldric alone');
  assert.deepEqual([row(b, s.p.brindle).counted, row(b, s.p.brindle).vsTeam], [{ window: 2, all: 2 }, 0.333]);
  const cassia = row(b, s.p.cassia);
  assert.deepEqual([cassia.raids, cassia.items.MS, cassia.items.DE, cassia.counted, cassia.perRaid, cassia.vsTeam], [{ window: 1, all: 1 }, { window: 0, all: 0 }, { window: 1, all: 1 }, { window: 0, all: 0 }, { window: 0, all: 0 }, -0.667]);
  const dunmar = row(b, s.p.dunmar);
  assert.deepEqual([dunmar.raids, dunmar.perRaid, dunmar.vsTeam], [{ window: 0, all: 0 }, { window: null, all: null }, null], 'zero raids: no per-raid rate and no comparison');
  assert.deepEqual(b.teamAverage, { window: 0.667, all: 0.667 });

  const twelve = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}&weeks=12`)).json;
  assert.deepEqual(twelve.window, { weeks: 12, switchWeeks: [8, 12], from: '2026-10-27' });
  assert.deepEqual([row(twelve, s.p.aldric).raids, row(twelve, s.p.aldric).items.MS], [{ window: 3, all: 3 }, { window: 3, all: 3 }], '12 weeks reaches back to 2026-11-03');
  for (const bad of ['5', 'all', '0', '-8', '8.5', 'abc']) assert.equal((await s.call('bob', 'GET', `/loot/balance?team=${s.A}&weeks=${bad}`)).status, 400, `weeks=${bad}`);
  for (const bad of ['', '&team=x', `&team=t_AAAAAAAAAAAAAAAAAAAAAA`]) assert.equal((await s.call('bob', 'GET', `/loot/balance?x=1${bad}`)).status, 400, `team${bad}`);

  // Team B: Wanderfell's award counts there, and his Other-team cell is no raid.
  const teamB = (await s.call('bob', 'GET', `/loot/balance?team=${s.B}`)).json;
  const wander = row(teamB, s.p.wander);
  assert.deepEqual([teamB.people.map((p) => p.name), wander.raids, wander.items.MS, wander.perRaid], [['Wanderfell'], { window: 0, all: 0 }, { window: 1, all: 1 }, { window: null, all: null }]);
  assert.deepEqual(teamB.teamAverage, { window: null, all: null });
  assert.equal(JSON.stringify(b).includes(s.p.wander), false, 'team A\'s balance does not mention a team B person');
});

check('balance: mode count and countTags change the policy echo and the counted numbers; Inactive people only with awards in the window', async () => {
  const s = await lootWorld();
  const put = (override, version = 0, teamId = null) => s.call('bob', 'PUT', '/loot/policy', { teamId, override, version });
  assert.equal((await put({ balance: { mode: 'count', countTags: ['MS', 'OS'] } })).status, 200);
  const b = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json;
  assert.deepEqual([b.mode, b.countTags], ['count', ['MS', 'OS']]);
  const aldric = row(b, s.p.aldric);
  assert.deepEqual([aldric.counted, aldric.perRaid], [{ window: 3, all: 4 }, { window: 1.5, all: 1.333 }]);
  assert.deepEqual(b.teamAverage, { window: 0.833, all: 0.778 });
  // A team override wins for that team only.
  assert.equal((await put({ balance: { mode: 'perRaid', countTags: ['OS'] } }, 0, s.A)).status, 200);
  const a = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json;
  assert.deepEqual([a.mode, a.countTags, row(a, s.p.aldric).counted], ['perRaid', ['OS'], { window: 1, all: 1 }]);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/balance?team=${s.B}`)).json.countTags, ['MS', 'OS']);
  // Dunmar goes Inactive: he has no award, so he leaves the table; Aldric stays whatever his status.
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.dunmar}`, { expectedVersion: 1, status: 'inactive' })).status, 200);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json.people.map((p) => p.name), ['Aldric', 'Brindle', 'Cassia']);
  assert.equal((await s.call('bob', 'PATCH', `/roster/${s.p.cassia}`, { expectedVersion: 1, status: 'inactive' })).status, 200);
  const cassia = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json.people.find((p) => p.name === 'Cassia');
  assert.deepEqual([cassia.status, cassia.items.DE.window], ['inactive', 1], 'Inactive but she received something in the window');
});

check('by raid: newest first, counted = matched awards with a counted tag, unmatched = nobody matches; raids without awards and other teams are absent', async () => {
  const s = await lootWorld();
  const r = await s.call('bob', 'GET', `/loot/raids?team=${s.A}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['raids']);
  assert.deepEqual(Object.keys(r.json.raids[0]), ['raidId', 'raidOn', 'title', 'zone', 'awards', 'counted', 'unmatched', 'disenchanted']);
  assert.deepEqual(r.json.raids.map((x) => [x.raidId, x.raidOn, x.title, x.awards, x.counted, x.unmatched, x.disenchanted]), [
    [s.r2, '2027-01-12', null, 2, 2, 0, 0],
    [s.r1, '2027-01-05', 'Gruul night', 6, 2, 1, 0],   // Aldric MS, Brindle MS (OS, DE, an unmatched winner and a guest do not count)
    [s.r0, '2026-11-03', null, 1, 1, 0, 0],
  ]);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/raids?team=${s.B}`)).json.raids.map((x) => [x.raidId, x.awards]), [[s.rb, 1]]);
  assert.deepEqual((await s.call('erin', 'GET', `/loot/raids?team=${s.A}`)).json, r.json, 'a member of the team sees the same');
  assert.equal((await s.call('erin', 'GET', `/loot/raids?team=${s.B}`)).status, 403);
  assert.equal((await s.call('bob', 'GET', '/loot/raids')).status, 400);
  assert.equal((await s.call('bob', 'GET', `/loot/raids?team=${'t_AAAAAAAAAAAAAAAAAAAAAA'}`)).status, 400);
});

check('by item: grouped by item, most recent first, the awards of an item newest first with their match', async () => {
  const s = await lootWorld();
  const r = await s.call('bob', 'GET', `/loot/items?team=${s.A}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['items']);
  assert.deepEqual(r.json.items.map((i) => i.itemId), [30008, 28770, 30006, 30005, 30004, 30003, 30002]);
  const token = r.json.items.find((i) => i.itemId === 28770);
  assert.deepEqual(Object.keys(token), ['itemId', 'itemName', 'quality', 'count', 'lastAwardedAt', 'awards']);
  assert.deepEqual([token.itemName, token.quality, token.count, token.lastAwardedAt], ['Tier Token', 4, 3, at('2027-01-12', '20:15')]);
  // The spec lists id, raidId, raidOn, awardedAt, tag and match; the winner and tagSetBy are added so a guest or an unknown name can be shown by name.
  assert.deepEqual(Object.keys(token.awards[0]), ['id', 'raidId', 'raidOn', 'awardedAt', 'tag', 'tagSetBy', 'winner', 'match']);
  assert.deepEqual(token.awards[0].winner, { name: 'Aldric', realm: 'Nightslayer', class: 'WARRIOR' });
  assert.deepEqual(token.awards.map((a) => [a.raidId, a.raidOn, a.tag, a.match.kind, a.match.personName]), [
    [s.r2, '2027-01-12', 'MS', 'character', 'Aldric'], [s.r1, '2027-01-05', 'MS', 'character', 'Aldric'], [s.r0, '2026-11-03', 'MS', 'character', 'Aldric'],
  ]);
  assert.deepEqual(r.json.items.find((i) => i.itemId === 30006).awards[0].match, { kind: 'guest' });
  assert.equal(r.json.items.find((i) => i.itemId === 30006).awards[0].winner.name, 'Visitor', 'a guest is named');
  assert.deepEqual(r.json.items.find((i) => i.itemId === 30005).awards[0].match, { kind: 'unmatched' });
  assert.equal(r.json.items.find((i) => i.itemId === 30005).awards[0].winner.name, 'Zorgax', 'a name the roster does not know is named');
  assert.equal(JSON.stringify(r.json).includes('Wanderfell'), false, 'only this team\'s raids');
  assert.deepEqual((await s.call('erin', 'GET', `/loot/items?team=${s.A}`)).json, r.json);
  assert.equal((await s.call('dave', 'GET', `/loot/items?team=${s.A}`)).status, 403);
});

check('person: awards newest first with totals by tag; the viewer\'s access decides which teams\' awards show', async () => {
  const s = await lootWorld();
  const r = await s.call('bob', 'GET', `/loot/person/${s.p.aldric}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['person', 'awards', 'totals']);
  assert.deepEqual(r.json.person, { id: s.p.aldric, name: 'Aldric', status: 'raider' });
  assert.deepEqual(r.json.awards.map((a) => a.itemId), [28770, 30002, 28770, 28770]);
  assert.deepEqual(r.json.awards.map((a) => a.raidOn), ['2027-01-12', '2027-01-05', '2027-01-05', '2026-11-03']);
  assert.deepEqual(r.json.totals, { MS: 3, OS: 1, DE: 0, BANK: 0 });
  assert.deepEqual(Object.keys(r.json.totals), ALL_TAGS);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/person/${s.p.wander}`)).json.awards.map((a) => a.raidId), [s.rb]);
  // Erin sees team A\'s people; Wanderfell raids on team B only, so he is out of her reach.
  assert.deepEqual((await s.call('erin', 'GET', `/loot/person/${s.p.aldric}`)).json, r.json);
  assert.equal((await s.call('erin', 'GET', `/loot/person/${s.p.wander}`)).status, 403);
  assert.equal((await s.call('dave', 'GET', `/loot/person/${s.p.aldric}`)).status, 403);
  assert.equal((await s.call('dave', 'GET', `/loot/person/${s.p.wander}`)).status, 200);
  assert.equal((await s.call('bob', 'GET', `/loot/person/p_AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await s.call('bob', 'GET', `/loot/person/nope`)).status, 404);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/person/${s.p.dunmar}`)).json.totals, { MS: 0, OS: 0, DE: 0, BANK: 0 });
  const other = await secondGuild(s);
  assert.equal((await s.w.call(other.frank, 'GET', `${other.path}/loot/person/${s.p.aldric}`)).status, 404, 'another guild\'s person');
});

// ---------------------------------------------------------------------------
// Visibility modes

check('visibility "own": a member sees only their own person\'s awards everywhere, the balance returns their row and the team average, others\' pages are 403', async () => {
  const s = await lootWorld();
  assert.equal((await s.call('bob', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { members: 'own' } }, version: 0 })).status, 200);
  // Erin is Brindle.
  const raid = await s.call('erin', 'GET', s.loot(s.r1));
  assert.equal(raid.status, 200);
  assert.deepEqual(raid.json.awards.map((a) => [a.winner.name, a.itemId]), [['Brindle', 30003]]);
  assert.equal(raid.json.canEdit, false);
  assert.deepEqual((await s.call('erin', 'GET', s.loot(s.r2))).json.awards.map((a) => a.winner.name), ['Brindle']);
  assert.deepEqual((await s.call('erin', 'GET', s.loot(s.r0))).json.awards, [], 'nothing of hers on r0');
  assert.equal((await s.call('erin', 'GET', s.loot(s.rb))).status, 200, '"own" is not tied to a team');
  assert.deepEqual((await s.call('erin', 'GET', s.loot(s.rb))).json.awards, []);

  const balance = (await s.call('erin', 'GET', `/loot/balance?team=${s.A}`)).json;
  assert.equal(balance.scope, 'own');
  assert.deepEqual(balance.people.map((p) => p.name), ['Brindle']);
  assert.deepEqual(balance.teamAverage, { window: 0.667, all: 0.667 }, 'the average is the whole team\'s');
  assert.equal(row(balance, s.p.brindle).vsTeam, 0.333);
  assert.equal((await s.call('erin', 'GET', `/loot/balance?team=${s.B}`)).status, 403, 'not on that team');
  assert.deepEqual((await s.call('erin', 'GET', `/loot/raids?team=${s.A}`)).json.raids.map((x) => [x.raidId, x.awards, x.counted, x.unmatched]), [[s.r2, 1, 1, 0], [s.r1, 1, 1, 0]]);
  const items = (await s.call('erin', 'GET', `/loot/items?team=${s.A}`)).json.items;
  assert.deepEqual(items.map((i) => [i.itemId, i.count]), [[30008, 1], [30003, 1]]);
  assert.equal(JSON.stringify(items).includes('Aldric'), false);
  assert.equal((await s.call('erin', 'GET', `/loot/person/${s.p.brindle}`)).status, 200);
  assert.deepEqual((await s.call('erin', 'GET', `/loot/person/${s.p.brindle}`)).json.awards.length, 2);
  assert.equal((await s.call('erin', 'GET', `/loot/person/${s.p.aldric}`)).status, 403, 'someone else\'s page under "own"');
  // Dave leads team B only: nothing of team A, and he has no person.
  assert.deepEqual((await s.call('dave', 'GET', s.loot(s.r1))).json, { awards: [], canEdit: false });
  assert.equal((await s.call('dave', 'GET', `/loot/balance?team=${s.A}`)).status, 403);
  // Editors still see everything.
  assert.equal((await s.call('carol', 'GET', s.loot(s.r1))).json.awards.length, 6);
  assert.equal((await s.call('carol', 'GET', `/loot/balance?team=${s.A}`)).json.scope, 'team');
  assert.equal((await s.call('carol', 'GET', `/loot/person/${s.p.aldric}`)).status, 200);
});

check('visibility "guild": every member sees every team; a team override can narrow one team back', async () => {
  const s = await lootWorld();
  assert.equal((await s.call('erin', 'GET', s.loot(s.rb))).status, 403, 'default: their teams only');
  assert.equal((await s.call('bob', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { members: 'guild' } }, version: 0 })).status, 200);
  assert.equal((await s.call('erin', 'GET', s.loot(s.rb))).json.awards.length, 1);
  const b = (await s.call('erin', 'GET', `/loot/balance?team=${s.B}`)).json;
  assert.deepEqual([b.scope, b.people.map((p) => p.name)], ['team', ['Wanderfell']]);
  assert.equal((await s.call('erin', 'GET', `/loot/person/${s.p.wander}`)).status, 200);
  assert.equal((await s.call('dave', 'GET', s.loot(s.r1))).json.awards.length, 6);
  assert.equal((await s.call('erin', 'GET', `/loot/items?team=${s.B}`)).status, 200);
  assert.equal((await s.call('bob', 'PUT', '/loot/policy', { teamId: s.B, override: { visibility: { members: 'ownTeams' } }, version: 0 })).status, 200);
  assert.equal((await s.call('erin', 'GET', s.loot(s.rb))).status, 403, 'team B asks for their teams only');
  assert.equal((await s.call('erin', 'GET', s.loot(s.r1))).status, 200);
  // An editor never needs the setting, and canEdit stays false for members.
  assert.equal((await s.call('erin', 'GET', s.loot(s.r1))).json.canEdit, false);
  assert.equal((await s.call('erin', 'POST', s.loot(s.r1), { awards: [award(40)] })).status, 403);
});

// ---------------------------------------------------------------------------
// Policy

check('policy: GET shape for any member, PUT needs loot.policy, validation names the field, versions guard stale saves, team overrides, aliases', async () => {
  const s = await lootWorld({ imported: false });
  const get = async (who = 'erin') => (await s.call(who, 'GET', '/loot/policy')).json;
  const first = await get();
  const DEF = { visibility: { members: 'ownTeams' }, balance: { mode: 'perRaid', countTags: ['MS'] } };
  assert.deepEqual(first, { defaults: DEF, guild: {}, teams: {}, resolved: { [s.A]: DEF, [s.B]: DEF }, versions: { guild: 0, teams: {} } });
  assert.equal((await s.w.call(newJar(), 'GET', `${s.guildPath}/loot/policy`)).status, 401);

  const put = (who, body) => s.call(who, 'PUT', '/loot/policy', body);
  for (const who of ['erin', 'carol', 'dave']) assert.equal((await put(who, { teamId: null, override: {}, version: 0 })).status, 403, who);
  assert.equal((await put('carol', { teamId: s.A, override: {}, version: 0 })).status, 403, 'a Team Lead may not set even their own team\'s policy');

  const saved = await put('bob', { teamId: null, override: { balance: { countTags: ['MS', 'OS'] } }, version: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.guild, { balance: { countTags: ['MS', 'OS'] } });
  assert.deepEqual([saved.json.versions, saved.json.resolved[s.A].balance], [{ guild: 1, teams: {} }, { mode: 'perRaid', countTags: ['MS', 'OS'] }]);
  assert.deepEqual(saved.json, await get('alice'));

  const stale = await put('alice', { teamId: null, override: { balance: { mode: 'count' } }, version: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'stale');
  assert.deepEqual(stale.json.current, saved.json, 'the 409 carries the current view');
  assert.deepEqual((await get()).guild, { balance: { countTags: ['MS', 'OS'] } }, 'a stale save writes nothing');
  assert.equal((await put('alice', { teamId: null, override: { balance: { mode: 'count' } }, version: 1 })).json.versions.guild, 2);

  const team = await put('bob', { teamId: s.A, override: { visibility: { members: 'own' }, balance: { countTags: ['OS'] } }, version: 0 });
  assert.equal(team.status, 200);
  assert.deepEqual(team.json.versions, { guild: 2, teams: { [s.A]: 1 } });
  assert.deepEqual(team.json.resolved[s.A], { visibility: { members: 'own' }, balance: { mode: 'count', countTags: ['OS'] } });
  assert.deepEqual(team.json.resolved[s.B], { visibility: { members: 'ownTeams' }, balance: { mode: 'count', countTags: ['MS'] } }, 'a save replaces the whole override of its level');
  assert.deepEqual(team.json.teams, { [s.A]: { visibility: { members: 'own' }, balance: { countTags: ['OS'] } } });
  // Clearing an override is saving an empty one.
  const cleared = await put('bob', { teamId: s.A, override: {}, version: 1 });
  assert.deepEqual([cleared.json.versions.teams[s.A], cleared.json.resolved[s.A].visibility.members], [2, 'ownTeams']);
  assert.equal((await put('bob', { teamId: s.A, override: {}, version: 1 })).status, 409);

  const invalid = async (body, field) => {
    const r = await put('bob', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'policy_invalid');
    assert.equal(r.json.field, field, JSON.stringify(body));
    assert.equal(r.json.errors[0].path, field);
    assert(Array.isArray(r.json.errors) && r.json.errors[0].message);
  };
  await invalid({ teamId: null, override: { visibility: { members: 'everyone' } }, version: 2 }, 'visibility.members');
  await invalid({ teamId: null, override: { balance: { countTags: [] } }, version: 2 }, 'balance.countTags');
  await invalid({ teamId: null, override: { balance: { countTags: ['DE'] } }, version: 2 }, 'balance.countTags');
  await invalid({ teamId: null, override: { whatever: 1 }, version: 2 }, 'whatever');
  await invalid({ teamId: s.B, override: { balance: { mode: 'weights' } }, version: 0 }, 'balance.mode');
  const noOverride = await put('bob', { teamId: null, version: 2 });
  assert.equal(noOverride.status, 400);
  assert.equal(noOverride.json.error, 'policy_invalid');
  assert.equal((await put('bob', { teamId: null, override: [], version: 2 })).status, 400);
  assert.equal((await put('bob', { teamId: null, override: {} })).status, 400, 'a version is required');
  assert.equal((await put('bob', { teamId: null, override: {}, version: -1 })).status, 400);
  assert.equal((await put('bob', { teamId: null, override: {}, version: '2' })).status, 400);
  assert.equal((await put('bob', { teamId: 'nope', override: {}, version: 0 })).status, 400);
  const other = await secondGuild(s);
  assert.equal((await put('bob', { teamId: other.teamId, override: {}, version: 0 })).status, 400, 'another guild\'s team');
  assert.equal((await s.w.call(other.frank, 'PUT', `${other.path}/loot/policy`, { teamId: s.A, override: {}, version: 0 })).status, 400);
  assert.equal((await s.w.call(other.frank, 'PUT', `${other.path}/loot/policy`, { teamId: null, override: { balance: { mode: 'count' } }, version: 0 })).status, 200);
  assert.equal((await get()).versions.guild, 2, 'the other guild\'s policy is its own');

  // The attendance spelling of the same body is read too.
  const alias = await put('bob', { teamId: null, policy: { balance: { mode: 'perRaid' } }, expectedVersion: 2 });
  assert.equal(alias.status, 200);
  assert.deepEqual([alias.json.versions.guild, alias.json.guild], [3, { balance: { mode: 'perRaid' } }]);
  const audits = await s.w.rows("SELECT entity_type, before, after FROM audit_log WHERE action = 'loot.policy' ORDER BY created_at, rowid");
  assert.equal(audits.length, 6, 'one entry per saved policy');
  assert.equal(audits[0].entity_type, 'policy');
  assert.deepEqual(JSON.parse(audits[0].after), { scope: 'guild', version: 1, changed: ['balance'], values: { balance: { countTags: ['MS', 'OS'] } } });
  assert.equal(await s.w.count('audit_log', "action = 'policy.update'"), 0, 'the attendance audit action is not reused');
});

// ---------------------------------------------------------------------------
// Disenchants (Gargul's "||de||"): an award nobody won
// A disenchant is a normalized award with winnerName / winnerRealm / winnerClass null and disenchanted true. It is stored with NULL
// winner_name / winner_name_key, the tag DE, and read as match.kind 'disenchanted' (never unmatched, never in the balance).

const disenchant = (n, over = {}) => award(n, { winnerName: null, winnerRealm: null, winnerClass: null, disenchanted: true, rollType: null, ...over });

check('disenchants: readAwards takes a no-winner award only when disenchanted is true (tag DE, no keys); the classification follows a change of winner', async () => {
  const { readAwards, normalizedOf, classifyAward } = await load('worker/loot-import.js');
  const guild = { realm: 'Nightslayer', realm_kind: 'realm' };
  const ruleset = { realm: 'Normal', realm_kind: 'ruleset' };
  const shape = (a) => [a.winnerName, a.winnerRealm, a.winnerClass, a.disenchanted, a.nameKey, a.storedRealm, a.realmKey, a.tag];
  const none = [null, null, null, true, null, null, '', 'DE'];
  assert.deepEqual(shape(readAwards([disenchant(1)], guild)[0]), none);
  assert.deepEqual(shape(readAwards([disenchant(1)], ruleset)[0]), none, 'a ruleset guild has no realm either way');
  const [bare] = readAwards([{ checksum: 'abcdefgh', itemId: 5, awardedAt: at('2027-01-05', '20:00'), disenchanted: true, flags: ['OS'], rollType: 'OS' }], guild);
  assert.deepEqual(shape(bare), none, 'absent winner fields are fine, and the flags do not change the tag');
  assert.deepEqual([normalizedOf(bare).winnerName, normalizedOf(bare).disenchanted], [null, true]);
  assert.equal(readAwards([award(1, { disenchanted: false })], guild)[0].disenchanted, false);
  assert.equal(readAwards([award(1, { disenchanted: null })], guild)[0].disenchanted, false);
  assert.equal(readAwards([disenchant(1), disenchant(1, { itemName: 'later' }), disenchant(2)], guild).length, 2, 'the same checksum twice counts once');

  const refuse = (over, field, make = disenchant) => assert.throws(() => readAwards([make(1, over)], guild),
    (error) => error.status === 400 && error.extra.field === 'awards' && error.extra.index === 0 && error.extra.awardField === field, `${field} ${JSON.stringify(over)}`);
  refuse({ winnerName: 'Aldric' }, 'winnerName');
  refuse({ winnerRealm: 'Nightslayer' }, 'winnerRealm');
  refuse({ winnerClass: 'WARRIOR' }, 'winnerClass');
  refuse({ disenchanted: 'yes' }, 'disenchanted');
  refuse({ disenchanted: 1 }, 'disenchanted');
  refuse({ disenchanted: false }, 'winnerName');                    // no winner and not a disenchant
  refuse({ disenchanted: undefined }, 'winnerName');
  refuse({ disenchanted: 'true', winnerName: 'Aldric' }, 'disenchanted', award);

  const raid = { id: 'r_1', raid_on: '2027-01-05' };
  const NY = 'America/New_York';
  const [d] = readAwards([disenchant(1)], guild);
  const [normal] = readAwards([award(1)], guild);
  const stored = (over = {}) => ({
    raid_id: 'r_1', checksum: d.checksum, item_id: d.itemId, item_name: d.itemName, item_quality: d.quality, awarded_at: d.awardedAt, winner_name: null, winner_name_key: null,
    winner_realm: null, winner_realm_key: '', winner_class: null, roll_type: null, awarded_by: d.awardedBy, flags: '[]', tag: 'DE', tag_set_at: null, ...over,
  });
  const withWinner = { winner_name: 'Aldric', winner_name_key: 'aldric', winner_realm: 'Nightslayer', winner_realm_key: 'nightslayer', winner_class: 'WARRIOR', roll_type: 'MS' };
  assert.deepEqual(classifyAward(d, null, raid, NY), { status: 'new', tag: 'DE' });
  assert.deepEqual(classifyAward(d, stored(), raid, NY), { status: 'same', tag: 'DE' });
  assert.deepEqual(classifyAward(d, stored({ tag_set_at: 9 }), raid, NY), { status: 'same', tag: 'DE' }, 'an officer-confirmed DE on a no-winner award is no difference');
  // Gargul edited the winner away: the officer's tag on the old award is dropped, because a no-winner award can only be DE.
  assert.deepEqual(classifyAward(d, stored({ ...withWinner, tag: 'OS', tag_set_at: 9 }), raid, NY), { status: 'update', tag: 'DE' });
  assert.deepEqual(classifyAward(d, stored({ ...withWinner, tag: 'MS' }), raid, NY), { status: 'update', tag: 'DE' });
  // ...and edited back: the automatic tag returns whatever an officer confirmed on the disenchant.
  assert.deepEqual(classifyAward(normal, stored({ tag_set_at: 9 }), raid, NY), { status: 'update', tag: 'MS' });
  assert.deepEqual(classifyAward(normal, stored(), raid, NY), { status: 'update', tag: 'MS' });
  // A normal award with an officer's tag keeps it, as before.
  assert.deepEqual(classifyAward(normal, stored({ ...withWinner, tag: 'BANK', tag_set_at: 9 }), raid, NY), { status: 'same', tag: 'BANK' });
});

check('disenchants: previewed and imported with no winner and the tag DE; listed as Disenchanted; ignored by the review queue, the balance and the person pages', async () => {
  const s = await lootWorld();
  const de = disenchant(30, { itemId: 28830, itemName: 'Dragonspine Trophy', awardedAt: at('2027-01-05', '21:10') });
  const balanceBefore = (await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json;
  const aldricBefore = (await s.call('bob', 'GET', `/loot/person/${s.p.aldric}`)).json;

  const preview = await s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: [de, award(31, { awardedAt: at('2027-01-05', '21:20') })] });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.counts, { new: 2, update: 0, same: 0, otherRaid: 0, otherDay: 0 });
  const row0 = preview.json.rows[0];
  assert.deepEqual([row0.status, row0.tag, row0.match, row0.disenchanted, row0.winnerName, row0.winnerRealm, row0.winnerClass], ['new', 'DE', { kind: 'disenchanted' }, true, null, null, null]);
  assert.equal(preview.json.rows[1].disenchanted, false);
  assert.equal(await s.w.count('loot_awards', 'checksum = ?', de.checksum), 0, 'a preview writes nothing');

  const done = await s.import('bob', s.r1, [de]);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual([done.json.inserted, done.json.updated, done.json.unchanged], [1, 0, 0]);
  const view = done.json.awards.find((a) => a.itemId === 28830);
  assert.deepEqual(view, {
    id: view.id, raidId: s.r1, raidOn: '2027-01-05', teamId: s.A, itemId: 28830, itemName: 'Dragonspine Trophy', quality: 4, awardedAt: at('2027-01-05', '21:10'),
    winner: { name: null, realm: null, class: null }, match: { kind: 'disenchanted' }, tag: 'DE', tagSetBy: null, flags: [], rollType: null, note: null, awardedBy: 'Bobby-Nightslayer',
  });
  const stored = (await s.w.rows('SELECT * FROM loot_awards WHERE checksum = ?', de.checksum))[0];
  assert.deepEqual([stored.winner_name, stored.winner_name_key, stored.winner_realm, stored.winner_realm_key, stored.winner_class, stored.tag, stored.tag_set_by, stored.tag_set_at],
    [null, null, null, '', null, 'DE', null, null]);
  const again = await s.import('bob', s.r1, [de]);
  assert.deepEqual([again.json.inserted, again.json.updated, again.json.unchanged], [0, 0, 1], 'a repeat changes nothing');

  // The raid list: editors and members see the row; the winner is nobody.
  const editor = (await s.call('bob', 'GET', s.loot(s.r1))).json;
  assert.equal(editor.awards.length, 7);
  assert.deepEqual(editor.awards.find((a) => a.itemId === 28830).match, { kind: 'disenchanted' });
  assert.equal((await s.call('erin', 'GET', s.loot(s.r1))).json.awards.find((a) => a.itemId === 28830).tag, 'DE');
  // The review queue still lists only the winner nobody matches.
  const queue = (await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched;
  assert.deepEqual(queue.map((g) => g.items.map((i) => i.name)), [['Zorgax']]);
  // By raid: the award counts as an award, never as unmatched or counted; the new column counts it.
  const raids = (await s.call('bob', 'GET', `/loot/raids?team=${s.A}`)).json.raids;
  assert.deepEqual(raids.find((x) => x.raidId === s.r1), { raidId: s.r1, raidOn: '2027-01-05', title: 'Gruul night', zone: null, awards: 7, counted: 2, unmatched: 1, disenchanted: 1 });
  assert.deepEqual(raids.filter((x) => x.raidId !== s.r1).map((x) => x.disenchanted), [0, 0]);
  // By item: named as a disenchant (no winner at all), tag DE.
  const items = (await s.call('bob', 'GET', `/loot/items?team=${s.A}`)).json.items;
  const item = items.find((i) => i.itemId === 28830);
  assert.deepEqual([item.count, item.awards.length], [1, 1]);
  assert.deepEqual([item.awards[0].winner, item.awards[0].match, item.awards[0].tag], [{ name: null, realm: null, class: null }, { kind: 'disenchanted' }, 'DE']);
  // The balance and the person pages are exactly what they were.
  assert.deepEqual((await s.call('bob', 'GET', `/loot/balance?team=${s.A}`)).json, balanceBefore);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/person/${s.p.aldric}`)).json, aldricBefore);
  // "Own loot only": a member sees nobody's disenchant (it is nobody's).
  assert.equal((await s.call('bob', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { members: 'own' } }, version: 0 })).status, 200);
  assert.equal((await s.call('erin', 'GET', s.loot(s.r1))).json.awards.some((a) => a.match.kind === 'disenchanted'), false);
  assert.equal((await s.call('erin', 'GET', `/loot/raids?team=${s.A}`)).json.raids.every((x) => x.disenchanted === 0), true);
  assert.equal(JSON.stringify((await s.call('erin', 'GET', `/loot/items?team=${s.A}`)).json).includes('28830'), false);
});

check('disenchants: only DE can be the tag of a no-winner award (PATCH refuses the rest); a note and delete work; the check in the table says the same', async () => {
  const s = await lootWorld();
  await s.import('bob', s.r1, [disenchant(30, { itemId: 28830, awardedAt: at('2027-01-05', '21:10') })]);
  const id = (await s.w.rows('SELECT id FROM loot_awards WHERE winner_name IS NULL'))[0].id;
  const patch = (body, who = 'bob') => s.call(who, 'PATCH', `/loot/${id}`, body);
  for (const tag of ['MS', 'OS', 'BANK']) {
    const r = await patch({ tag });
    assert.equal(r.status, 400, tag);
    assert.deepEqual([r.json.error, r.json.field], ['bad_request', 'tag']);
    assert.match(r.json.message, /can only be tagged DE/);
  }
  assert.equal((await patch({ tag: 'MS', note: 'must not stick' })).status, 400);
  const untouched = (await s.w.rows('SELECT tag, tag_set_by, tag_set_at, note FROM loot_awards WHERE id = ?', id))[0];
  assert.deepEqual(untouched, { tag: 'DE', tag_set_by: null, tag_set_at: null, note: null }, 'a refused request writes nothing');
  assert.equal((await patch({ tag: 'DE' }, 'erin')).status, 403);
  const same = await patch({ tag: 'DE' });
  assert.deepEqual([same.status, same.json.award.tag, same.json.award.tagSetBy, same.json.award.match], [200, 'DE', 'officer', { kind: 'disenchanted' }]);
  const noted = await patch({ note: 'Shattered for the enchanter' });
  assert.deepEqual([noted.status, noted.json.award.note], [200, 'Shattered for the enchanter']);
  // A winner-ful award can still be re-tagged DE, and back.
  const normal = s.awardId[3];
  assert.equal((await s.call('bob', 'PATCH', `/loot/${normal}`, { tag: 'DE' })).status, 200);
  assert.equal((await s.call('bob', 'PATCH', `/loot/${normal}`, { tag: 'MS' })).status, 200);
  // The table refuses what the route refuses: no winner, no tag but DE; a name without a key (or the reverse).
  const bare = (over) => s.w.db.sqlite.prepare(`INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, winner_name, winner_name_key, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 1, 1)`).run(over.id, s.guildId, s.r1, s.A, over.checksum, over.name, over.key, over.tag);
  assert.throws(() => bare({ id: 'lo_n1', checksum: 'nullnull1', name: null, key: null, tag: 'MS' }), /CHECK/);
  assert.throws(() => bare({ id: 'lo_n2', checksum: 'nullnull2', name: null, key: 'aldric', tag: 'DE' }), /CHECK/);
  assert.throws(() => bare({ id: 'lo_n3', checksum: 'nullnull3', name: 'Aldric', key: null, tag: 'MS' }), /CHECK/);
  assert.throws(() => bare({ id: 'lo_n4', checksum: 'nullnull4', name: '', key: '', tag: 'MS' }), /CHECK/);
  bare({ id: 'lo_n5', checksum: 'nullnull5', name: null, key: null, tag: 'DE' });
  const removed = await s.call('bob', 'DELETE', `/loot/${id}`, {});
  assert.deepEqual([removed.status, removed.json], [200, { ok: true }]);
});

check('disenchants: an award edited in Gargul to or from a disenchant keeps its checksum and its note, and takes the automatic tag again', async () => {
  const s = await lootWorld({ imported: false });
  const first = award(1, { awardedAt: at('2027-01-05', '20:10') });
  assert.equal((await s.import('bob', s.r1, [first])).status, 200);
  const id = (await s.w.rows('SELECT id FROM loot_awards'))[0].id;
  assert.equal((await s.call('bob', 'PATCH', `/loot/${id}`, { tag: 'OS', note: 'keep this note' })).status, 200);
  const state = async () => (await s.w.rows('SELECT id, winner_name, winner_name_key, winner_realm_key, tag, tag_set_by, tag_set_at, note FROM loot_awards'))[0];

  // The winner is removed in Gargul (same checksum): an update, tag DE, the officer's OS is gone, the note stays.
  const edited = { ...disenchant(1), awardedAt: first.awardedAt };
  const preview = await s.call('bob', 'POST', s.loot(s.r1, '/preview'), { awards: [edited] });
  assert.deepEqual([preview.json.counts.update, preview.json.rows[0].status, preview.json.rows[0].tag], [1, 'update', 'DE']);
  const toDe = await s.import('bob', s.r1, [edited]);
  assert.deepEqual([toDe.status, toDe.json.inserted, toDe.json.updated], [200, 0, 1], JSON.stringify(toDe.json));
  assert.deepEqual(await state(), { id, winner_name: null, winner_name_key: null, winner_realm_key: '', tag: 'DE', tag_set_by: null, tag_set_at: null, note: 'keep this note' });
  const view = toDe.json.awards.find((a) => a.id === id);
  assert.deepEqual([view.match, view.tagSetBy, view.winner], [{ kind: 'disenchanted' }, null, { name: null, realm: null, class: null }]);
  assert.deepEqual((await s.import('bob', s.r1, [edited])).json.unchanged, 1, 'the same paste again is no change');

  // An officer confirms DE, then Gargul gives the item to someone: back to the automatic tag.
  assert.equal((await s.call('bob', 'PATCH', `/loot/${id}`, { tag: 'DE' })).status, 200);
  assert.equal((await state()).tag_set_by, s.ids.bob);
  const back = await s.import('bob', s.r1, [{ ...first, winnerName: 'Brindle', flags: ['OS'], rollType: 'OS' }]);
  assert.deepEqual([back.json.inserted, back.json.updated], [0, 1]);
  assert.deepEqual(await state(), { id, winner_name: 'Brindle', winner_name_key: 'brindle', winner_realm_key: 'nightslayer', tag: 'OS', tag_set_by: null, tag_set_at: null, note: 'keep this note' });
  assert.equal(back.json.awards.find((a) => a.id === id).match.personName, 'Brindle');
  // From here an officer's tag is kept again.
  assert.equal((await s.call('bob', 'PATCH', `/loot/${id}`, { tag: 'BANK' })).status, 200);
  await s.import('bob', s.r1, [{ ...first, winnerName: 'Brindle', itemName: 'Renamed' }]);
  assert.deepEqual([(await state()).tag, (await state()).tag_set_by], ['BANK', s.ids.bob]);
});

check('disenchants: a ruleset guild (no realm) records them too, and a character named Null does not pick them up', async () => {
  const s = await scenario({ guildBody: { gameVersion: 'forever', realm: 'Normal' } });
  const nullPerson = await addPerson(s, 'bob', s.teamId, 'Null');
  const raid = (await s.call('bob', 'POST', '/raids', { teamId: s.teamId, raidOn: '2027-01-05' })).json.raid.id;
  const done = await s.call('bob', 'POST', `/raids/${raid}/loot`, { awards: [disenchant(1), award(2, { winnerName: 'Aldric', winnerRealm: null })] });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const byItem = [...done.json.awards].sort((a, b) => a.itemId - b.itemId);
  assert.deepEqual(byItem.map((a) => [a.match.kind, a.tag, a.winner.name]), [['disenchanted', 'DE', null], ['unmatched', 'MS', 'Aldric']]);
  const stored = (await s.w.rows('SELECT winner_name_key, winner_realm_key, winner_realm FROM loot_awards WHERE winner_name IS NULL'))[0];
  assert.deepEqual([stored.winner_name_key, stored.winner_realm_key, stored.winner_realm], [null, '', null]);
  // In a ruleset guild a real winner's key is "name|" too: the disenchant must not be taken for Null.
  const balance = (await s.call('bob', 'GET', `/loot/balance?team=${s.teamId}`)).json;
  const mine = balance.people.find((p) => p.personId === nullPerson.person.id);
  assert.deepEqual([mine.items.DE.all, mine.items.MS.all], [0, 0]);
  assert.deepEqual((await s.call('bob', 'GET', `/loot/person/${nullPerson.person.id}`)).json.awards, []);
  const queue = (await s.call('bob', 'GET', `/attendance/review?team=${s.teamId}`)).json.lootUnmatched;
  assert.deepEqual(queue.map((g) => g.items.map((i) => i.name)), [['Aldric']]);
});

check('migration 0011: an existing 0008 database is rebuilt in place -- rows, indexes, foreign keys and checks survive and the winner columns become nullable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-mig-'));
  try {
    const migrations = path.join(ROOT, 'migrations');
    const rebuild = '0011_loot_disenchant.sql';
    assert(fs.existsSync(path.join(migrations, rebuild)));
    // Every migration but the one under test: the Worker needs the later account columns (0012) to sign anyone in, and 0011 touches only loot_awards.
    for (const name of fs.readdirSync(migrations)) if (name.endsWith('.sql') && name !== rebuild) fs.copyFileSync(path.join(migrations, name), path.join(dir, name));
    const s = await lootWorld({ migrationsDir: dir });
    const columns = async () => s.w.rows('SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info(\'loot_awards\') ORDER BY cid');
    const indexes = async () => s.w.rows('SELECT name, sql FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'loot_awards\' AND sql IS NOT NULL ORDER BY name');
    const foreignKeys = async () => s.w.rows('SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(\'loot_awards\') ORDER BY id, seq');
    const uniques = async () => s.w.rows('SELECT "unique", origin FROM pragma_index_list(\'loot_awards\') WHERE "unique" = 1 ORDER BY seq');
    const before = { columns: await columns(), indexes: await indexes(), fks: await foreignKeys(), uniques: await uniques(), rows: await s.w.rows('SELECT * FROM loot_awards ORDER BY id') };
    const apiBefore = (await s.call('bob', 'GET', s.loot(s.r1))).json;
    const flag = (list, name) => list.find((c) => c.name === name).nn;
    assert.deepEqual([flag(before.columns, 'winner_name'), flag(before.columns, 'winner_name_key')], [1, 1], 'the 0008 table needs a winner');
    assert(before.rows.length >= 8);
    assert.throws(() => exec(s.w, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, tag, created_at, updated_at)
      VALUES ('lo_de', '${s.guildId}', '${s.r1}', '${s.A}', 'dedededede', 1, 1, 'DE', 1, 1)`), /NOT NULL/);

    exec(s.w, fs.readFileSync(path.join(migrations, rebuild), 'utf8'));

    const after = { columns: await columns(), indexes: await indexes(), fks: await foreignKeys(), uniques: await uniques(), rows: await s.w.rows('SELECT * FROM loot_awards ORDER BY id') };
    assert.deepEqual(after.rows, before.rows, 'every row, every column, as it was');
    assert.deepEqual(after.indexes, before.indexes, 'the four named indexes are back, with the same definitions');
    assert.deepEqual(after.fks, before.fks, 'guild, user and (guild, team, raid) foreign keys with their ON DELETE actions');
    assert.deepEqual(after.uniques, before.uniques, 'UNIQUE (guild_id, checksum) and the primary key');
    assert.deepEqual(after.columns.filter((c) => !['winner_name', 'winner_name_key'].includes(c.name)), before.columns.filter((c) => !['winner_name', 'winner_name_key'].includes(c.name)), 'no other column changed');
    assert.deepEqual([flag(after.columns, 'winner_name'), flag(after.columns, 'winner_name_key')], [0, 0], 'the winner columns are nullable now');
    // PRAGMA is refused in prepared SQL (like D1), so these go straight to SQLite.
    const pragma = (sql) => s.w.db.sqlite.prepare(sql).all();
    assert.deepEqual(pragma('PRAGMA foreign_key_check'), [], 'no dangling reference');
    assert.equal(pragma('PRAGMA foreign_keys')[0].foreign_keys, 1);
    assert.equal(pragma('PRAGMA defer_foreign_keys')[0].defer_foreign_keys, 0, 'the deferral is switched off again');
    assert.deepEqual((await s.call('bob', 'GET', s.loot(s.r1))).json, apiBefore, 'the pages read the same answer');

    // The old rules still hold on the new table, and the new one lets a disenchant in.
    exec(s.w, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, tag, created_at, updated_at)
      VALUES ('lo_de', '${s.guildId}', '${s.r1}', '${s.A}', 'dedededede', 1, 1, 'DE', 1, 1)`);
    assert.throws(() => exec(s.w, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, awarded_at, tag, created_at, updated_at)
      VALUES ('lo_ms', '${s.guildId}', '${s.r1}', '${s.A}', 'msmsmsmsms', 1, 1, 'MS', 1, 1)`), /CHECK/);
    assert.throws(() => exec(s.w, `UPDATE loot_awards SET checksum = 'short' WHERE id = 'lo_de'`), /CHECK/);
    assert.throws(() => exec(s.w, `UPDATE loot_awards SET checksum = (SELECT checksum FROM loot_awards WHERE id != 'lo_de' LIMIT 1) WHERE id = 'lo_de'`), /UNIQUE/);
    assert.throws(() => exec(s.w, `UPDATE loot_awards SET raid_id = '${s.rb}' WHERE id = 'lo_de'`), /FOREIGN KEY/);
    exec(s.w, `DELETE FROM raids WHERE id = '${s.r1}'`);
    assert.equal(await s.w.count('loot_awards', 'raid_id = ?', s.r1), 0, 'a raid delete still takes its awards');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Link / Add as new person for a name nobody knows the class of

check('review: a loot-only winner with no class is added or linked with an explicit class; a class the loot knows wins; bad classes are refused', async () => {
  const s = await lootWorld({ imported: false });
  await s.import('bob', s.r1, [
    award(1, { winnerName: 'Classless', winnerClass: null }), award(2, { winnerName: 'Linkless', winnerClass: null }), award(3, { winnerName: 'Knownone', winnerClass: 'PRIEST' }),
    award(4, { winnerName: 'Badclass', winnerClass: null }), award(5, { winnerName: 'Guestling', winnerClass: null }),
  ]);
  const post = (name, body) => s.call('bob', 'POST', `/raids/${s.r1}/unmatched`, { key: `${name.toLowerCase()}|nightslayer`, ...body });
  const characterOf = async (name) => (await s.w.rows('SELECT class, is_main, player_id, team_id FROM characters WHERE name = ?', name))[0];

  // No class anywhere: 400 naming the class field, for both actions, and nothing is written.
  for (const body of [{ action: 'person' }, { action: 'alt', personId: s.p.dunmar }]) {
    const r = await post('Classless', body);
    assert.equal(r.status, 400, body.action);
    assert.deepEqual([r.json.error, r.json.field], ['bad_request', 'class']);
    assert.match(r.json.message, /class/i);
  }
  assert.equal(await characterOf('Classless'), undefined);
  // A class that is not one of the nine.
  for (const bad of ['DEMON', 'warrior', '', 5, true, {}, ['MAGE']]) {
    const r = await post('Badclass', { action: 'person', class: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.field, 'class');
  }
  assert.equal((await post('Badclass', { action: 'alt', personId: s.p.dunmar, class: 'DEATHKNIGHT' })).status, 400);
  assert.equal(await characterOf('Badclass'), undefined);

  // Add as new person with a class.
  const added = await post('Classless', { action: 'person', status: 'raider', class: 'MAGE' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const classless = await characterOf('Classless');
  assert.deepEqual([classless.class, classless.is_main, classless.team_id], ['MAGE', 1, s.A]);
  const created = (await s.w.rows("SELECT after FROM audit_log WHERE action = 'person.create' ORDER BY created_at DESC, rowid DESC LIMIT 1"))[0];
  assert.equal(JSON.parse(created.after).class, 'MAGE');
  // Link to a person (as an Alt) with a class.
  const linked = await post('Linkless', { action: 'alt', personId: s.p.dunmar, class: 'DRUID' });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  const linkless = await characterOf('Linkless');
  assert.deepEqual([linkless.class, linkless.is_main, linkless.player_id], ['DRUID', 0, s.p.dunmar]);
  // A class the loot already carries wins over the one sent; a null class is the same as none.
  assert.equal((await post('Knownone', { action: 'person', class: 'MAGE' })).status, 200);
  assert.equal((await characterOf('Knownone')).class, 'PRIEST');
  // A guest needs no class, and a valid one that comes along is ignored.
  assert.equal((await post('Guestling', { action: 'guest', class: 'MAGE' })).status, 200);
  assert.equal(await characterOf('Guestling'), undefined);
  assert.equal((await post('Guestling', { action: 'guest', class: 'DEMON' })).status, 400, 'a bad class is refused whatever the action');

  // The loot follows: the classless winners are people now, and the award shows the class they were given.
  const awards = (await s.call('bob', 'GET', s.loot(s.r1))).json.awards;
  const by = (name) => awards.find((a) => a.winner.name === name);
  assert.deepEqual([by('Classless').match.kind, by('Classless').winner.class], ['character', 'MAGE']);
  assert.deepEqual([by('Linkless').match.personName, by('Linkless').winner.class], ['Dunmar', 'DRUID']);
  const queue = (await s.call('bob', 'GET', `/attendance/review?team=${s.A}`)).json.lootUnmatched;
  assert.deepEqual(queue[0].items.map((i) => i.name), ['Badclass']);
  // Dave leads another team: still no.
  assert.equal((await s.call('dave', 'POST', `/raids/${s.r1}/unmatched`, { key: 'badclass|nightslayer', action: 'person', class: 'MAGE' })).status, 403);
});

// ---------------------------------------------------------------------------
// Audit, privacy

check('audit: every loot action is written and holds counts and ids only', async () => {
  const s = await lootWorld();
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  await s.call('bob', 'PUT', '/loot/policy', { teamId: null, override: { balance: { mode: 'count' } }, version: 0 });
  await s.call('bob', 'DELETE', `/loot/${s.awardId[9]}`, {});
  const written = (await s.w.rows("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'loot.%'")).map((r) => r.action).sort();
  const expected = AUDIT_ACTIONS.filter((a) => a.startsWith('loot.')).sort();
  assert.deepEqual(expected, ['loot.delete', 'loot.import', 'loot.policy', 'loot.update']);
  assert.deepEqual(written, expected);
  const rows = await s.w.rows("SELECT before, after FROM audit_log WHERE action LIKE 'loot.%'");
  const dump = rows.map((r) => `${r.before} ${r.after}`).join('\n');
  for (const secret of ['Aldric', 'Brindle', 'Zorgax', 'Visitor', 'Wanderfell', 'GARG', 'Tier Token', 'Bobby', PEOPLE.erin.id]) assert.equal(dump.includes(secret), false, `audit rows must not contain ${secret}`);
  const imports = (await s.w.rows("SELECT after FROM audit_log WHERE action = 'loot.import'")).map((r) => JSON.parse(r.after));
  assert(imports.every((a) => ['inserted', 'updated', 'unchanged', 'skippedOtherRaid', 'skippedOtherDay', 'includeOtherDay'].every((key) => key in a)));
  assert.equal(imports.length, 4, 'one entry per import');
});

check('privacy: awards hold no Discord data, and Delete my data leaves them (the officer\'s account only loses its link)', async () => {
  const s = await lootWorld();
  const columns = (await s.w.rows("SELECT name FROM pragma_table_info('loot_awards')")).map((r) => r.name);
  assert(!columns.some((name) => /discord|nick|user_id/.test(name)), columns.join(','));
  const before = await s.w.count('loot_awards');
  const gone = await s.w.call(s.jars.erin, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(await s.w.count('loot_awards'), before);
  assert.equal(await s.w.count('loot_awards', 'created_by IS NULL'), 0);
  exec(s.w, `DELETE FROM users WHERE id = '${s.ids.bob}'`);
  assert.equal(await s.w.count('loot_awards'), before);
  assert.equal(await s.w.count('loot_awards', 'created_by IS NULL'), before, 'created_by is SET NULL, the awards stay');
  assert.equal((await s.call('alice', 'GET', s.loot(s.r1))).json.awards[3].tagSetBy, 'officer', 'a tag set by hand stays set by hand');
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
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
