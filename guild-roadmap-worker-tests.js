/**
 * Raidsmith guild - idea box tests (migrations/0007_roadmap_ideas.sql, worker/routes/roadmap.js, tools/roadmap-ideas.js)
 * Run: node guild-roadmap-worker-tests.js
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/d1-fake.js, which runs every migration) with Discord faked by
 * an injected fetch, like guild-worker-tests.js. The triage tool runs here with Wrangler stubbed out, and the SQL it builds
 * runs on the same stand-in. No network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ORIGIN = 'https://raidsmith.test';
const ALICE = { id: '1001', username: 'alice', globalName: 'Alice A' };
const BOB = { id: '1002', username: 'bob', globalName: null };
const IDEA_ID = /^ri_[A-Za-z0-9_-]{22}$/;
const HOUR = 60 * 60 * 1000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Harness (the same shape as guild-worker-tests.js, without the guild scenario)

function makeDiscord() {
  const state = { next: null, tokens: new Map(), calls: 0 };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    state.calls++;
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${state.calls}`;
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

async function makeWorld() {
  const { createApp } = await load('worker/index.js');
  const db = createD1Fake();
  const discord = makeDiscord();
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: '' };
  const app = createApp({ db, env, fetch: discord.fetch, now: () => clock.now, randomBytes, log: () => {} });
  const world = {
    db, discord, clock,
    advance(ms) { clock.now += ms; },
    async call(jar, method, urlPath, body, { headers = {}, rawBody } = {}) {
      const init = { method, headers: { ...headers } };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
        init.body = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${ORIGIN}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      let json = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json, headers: response.headers };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) { return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n; },
  };
  return world;
}

async function signIn(world, person) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers: [] };
  const login = await world.call(jar, 'GET', '/auth/login');
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await world.call(jar, 'GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(callback.status, 302);
  return jar;
}

async function twoUsers() {
  const w = await makeWorld();
  const alice = await signIn(w, ALICE);
  const bob = await signIn(w, BOB);
  const ids = {};
  ids.alice = (await w.call(alice, 'GET', '/auth/me')).json.user.id;
  ids.bob = (await w.call(bob, 'GET', '/auth/me')).json.user.id;
  return { w, alice, bob, ids };
}

const PATH = '/api/roadmap/ideas';
const VALID = { title: 'Dark mode for the Planner', area: 'planner', details: 'Easier on the eyes during a late raid.' };

function throwsD1(fn) {
  return Promise.resolve().then(fn).then(() => assert.fail('expected a D1_ERROR'), (error) => assert.match(error.message, /^D1_ERROR: /));
}

// ---------------------------------------------------------------------------
// Access

check('ideas: signed-out visitors get 401 on both routes and nothing is stored', async () => {
  const w = await makeWorld();
  const list = await w.call({}, 'GET', PATH);
  assert.equal(list.status, 401);
  assert.equal(list.json.error, 'signed_out');
  const post = await w.call({}, 'POST', PATH, VALID);
  assert.equal(post.status, 401);
  assert.equal(await w.count('roadmap_ideas'), 0);
});

check('ideas: a POST from another site, or without a JSON content type, is refused like every other write', async () => {
  const { w, alice } = await twoUsers();
  assert.equal((await w.call(alice, 'POST', PATH, VALID, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await w.call(alice, 'POST', PATH, VALID, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const text = await w.call(alice, 'POST', PATH, null, { headers: { 'Content-Type': 'text/plain' }, rawBody: JSON.stringify(VALID) });
  assert.equal(text.status, 415);
  assert.equal((await w.call(alice, 'POST', PATH, null, { rawBody: '[1]' })).status, 400, 'a JSON object is required');
  assert.equal((await w.call(alice, 'POST', PATH, null, { rawBody: 'x'.repeat(20 * 1024) })).status, 413, 'the body is capped');
  assert.equal(await w.count('roadmap_ideas'), 0);
  assert.equal((await w.call(alice, 'POST', PATH, VALID, { headers: { Origin: ORIGIN } })).status, 201, 'the same site is fine');
});

check('ideas: there are no edit or delete routes (405 with Allow: GET, POST), and an id path is a 404', async () => {
  const { w, alice } = await twoUsers();
  const created = (await w.call(alice, 'POST', PATH, VALID)).json.idea;
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await w.call(alice, method, PATH, {});
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('Allow'), 'GET, POST');
  }
  assert.equal((await w.call(alice, 'DELETE', `${PATH}/${created.id}`, {})).status, 404);
  assert.equal(await w.count('roadmap_ideas'), 1);
});

// ---------------------------------------------------------------------------
// Create

check('create: 201 with the idea (status new, mine, no roadmap link), stored with the author and the clock', async () => {
  const { w, alice, ids } = await twoUsers();
  const res = await w.call(alice, 'POST', PATH, VALID);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(Object.keys(res.json), ['idea']);
  const idea = res.json.idea;
  assert.match(idea.id, IDEA_ID);
  assert.deepEqual(idea, {
    id: idea.id, title: VALID.title, details: VALID.details, area: 'planner', status: 'new', roadmapId: null, triageNote: null, createdAt: w.clock.now, mine: true,
  });
  const [row] = await w.rows('SELECT * FROM roadmap_ideas');
  assert.deepEqual(row, {
    id: idea.id, title: VALID.title, details: VALID.details, area: 'planner', status: 'new', roadmap_id: null, triage_note: null,
    submitted_by: ids.alice, created_at: w.clock.now, updated_at: w.clock.now,
  });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

check('create: the title is trimmed and single-line, the details keep their line breaks, empty details are null, extra fields are ignored', async () => {
  const { w, alice } = await twoUsers();
  const a = (await w.call(alice, 'POST', PATH, { title: '  Spaced \t  out \n title  ', area: 'other', details: '  one\r\ntwo\rthree\u0000\u200b  ', status: 'done', roadmapId: 'x', submittedBy: 'u_x' })).json.idea;
  assert.equal(a.title, 'Spaced out title');
  assert.equal(a.details, 'one\ntwo\nthree');
  assert.equal(a.status, 'new');
  assert.equal(a.roadmapId, null);
  for (const details of [undefined, null, '', '   \n  ']) {
    const b = (await w.call(alice, 'POST', PATH, { title: 'No details', area: 'loot', details })).json.idea;
    assert.equal(b.details, null, JSON.stringify(details));
  }
  const bidi = (await w.call(alice, 'POST', PATH, { title: 'Evil \u202e title', area: 'loot' })).json.idea;
  assert.equal(bidi.title, 'Evil title', 'direction overrides are removed');
});

check('create: the limits are 3-120 characters for the title and 2000 for the details, counted in characters; each refusal names its field', async () => {
  const { w, alice } = await twoUsers();
  const post = (body) => w.call(alice, 'POST', PATH, body);
  for (const [title, ok] of [['ab', false], ['abc', true], ['x'.repeat(120), true], ['x'.repeat(121), false], ['\u{1F600}'.repeat(120), true], ['\u{1F600}'.repeat(121), false], ['  a  ', false], ['\u0001\u0002\u0003\u0004', false]]) {
    const r = await post({ title, area: 'loot' });
    assert.equal(r.status, ok ? 201 : 400, JSON.stringify(title.slice(0, 8)));
    if (!ok) assert.deepEqual([r.json.error, r.json.field], ['bad_request', 'title']);
  }
  for (const title of [undefined, null, 5, ['abc'], { a: 1 }, true]) {
    const r = await post({ title, area: 'loot' });
    assert.deepEqual([r.status, r.json.field], [400, 'title'], JSON.stringify(title));
  }
  assert.equal((await post({ title: 'abc', area: 'loot', details: 'd'.repeat(2000) })).status, 201);
  const long = await post({ title: 'abc', area: 'loot', details: 'd'.repeat(2001) });
  assert.deepEqual([long.status, long.json.field], [400, 'details']);
  for (const details of [5, ['x'], { a: 1 }, true]) assert.deepEqual([(await post({ title: 'abc', area: 'loot', details })).json.field], ['details']);
  for (const area of [undefined, null, '', 'nope', 'LOOT', ' loot', 5, ['loot']]) {
    const r = await post({ title: 'abc', area });
    assert.deepEqual([r.status, r.json.field], [400, 'area'], JSON.stringify(area));
  }
  assert.equal(await w.count('roadmap_ideas'), 4, 'only the four accepted ideas are stored: the three titles at the limit and the 2000-character details');
});

check('create: every area of the list is accepted', async () => {
  const { w, alice } = await twoUsers();
  const { IDEA_AREAS } = await load('worker/routes/roadmap.js');
  assert.equal(IDEA_AREAS.length, 11);
  for (const area of IDEA_AREAS) assert.equal((await w.call(alice, 'POST', PATH, { title: `Idea for ${area}`, area })).status, 201, area);
});

// ---------------------------------------------------------------------------
// Rate limit

check('rate limit: 20 ideas an hour per person; the 21st is a 429 with Retry-After; an hour later it works; others are not affected', async () => {
  const { w, alice, bob, ids } = await twoUsers();
  for (let i = 0; i < 5; i++) assert.equal((await w.call(alice, 'POST', PATH, { title: 'x', area: 'loot' })).status, 400, 'invalid ideas do not use the hour');
  for (let i = 0; i < 20; i++) assert.equal((await w.call(alice, 'POST', PATH, { title: `Idea number ${i}`, area: 'loot' })).status, 201, `idea ${i}`);
  const over = await w.call(alice, 'POST', PATH, { title: 'One too many', area: 'loot' });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'rate_limited');
  assert.match(over.json.message, /suggested a lot of ideas this hour/);
  const retry = Number(over.headers.get('Retry-After'));
  assert(retry > 0 && retry <= 3600, `Retry-After ${retry}`);
  assert.equal(over.json.retryAfter, retry);
  assert.equal(await w.count('roadmap_ideas'), 20, 'the refused idea is not stored');
  assert.equal((await w.call(bob, 'POST', PATH, { title: 'Bob can still post', area: 'loot' })).status, 201);
  assert.equal((await w.call(alice, 'GET', PATH)).status, 200, 'reading is not limited');
  const [row] = await w.rows('SELECT count FROM rate_limits WHERE key = ?', `idea:${ids.alice}`);
  assert(row && row.count >= 20);
  w.advance(HOUR + 1000);
  assert.equal((await w.call(alice, 'POST', PATH, { title: 'A new hour', area: 'loot' })).status, 201);
});

// ---------------------------------------------------------------------------
// List

check('list: every idea from every person, newest first (insertion order breaks a tie), with a mine flag per viewer and nobody\'s identity', async () => {
  const { w, alice, bob, ids } = await twoUsers();
  const make = async (jar, title) => (await w.call(jar, 'POST', PATH, { title, area: 'raids' })).json.idea;
  const a = await make(alice, 'First by Alice');
  w.advance(1000);
  const b = await make(bob, 'Second by Bob');
  w.advance(1000);
  const c = await make(alice, 'Third by Alice');
  const d = await make(bob, 'Fourth by Bob, same millisecond');
  const asAlice = await w.call(alice, 'GET', PATH);
  assert.equal(asAlice.status, 200);
  assert.deepEqual(Object.keys(asAlice.json), ['ideas']);
  assert.deepEqual(asAlice.json.ideas.map((i) => i.id), [d.id, c.id, b.id, a.id]);
  assert.deepEqual(asAlice.json.ideas.map((i) => i.mine), [false, true, false, true]);
  const asBob = await w.call(bob, 'GET', PATH);
  assert.deepEqual(asBob.json.ideas.map((i) => i.mine), [true, false, true, false]);
  assert.deepEqual(Object.keys(asAlice.json.ideas[0]), ['id', 'title', 'details', 'area', 'status', 'roadmapId', 'triageNote', 'createdAt', 'mine']);
  const raw = JSON.stringify(asAlice.json) + JSON.stringify(asBob.json);
  for (const secret of [ids.alice, ids.bob, ALICE.id, ALICE.username, BOB.id, BOB.username, 'submitted']) assert(!raw.includes(secret), `leaked ${secret}`);
});

check('list: triage fields reach the page (status, roadmapId, triageNote), and an empty table is an empty list', async () => {
  const { w, alice } = await twoUsers();
  assert.deepEqual((await w.call(alice, 'GET', PATH)).json, { ideas: [] });
  const idea = (await w.call(alice, 'POST', PATH, VALID)).json.idea;
  w.db.sqlite.exec(`UPDATE roadmap_ideas SET status = 'added', roadmap_id = 'loot-history', triage_note = 'Merged.' WHERE id = '${idea.id}'`);
  const [shown] = (await w.call(alice, 'GET', PATH)).json.ideas;
  assert.deepEqual([shown.status, shown.roadmapId, shown.triageNote], ['added', 'loot-history', 'Merged.']);
});

check('list: at most 300 ideas, the newest ones', async () => {
  const { w, alice } = await twoUsers();
  const insert = w.db.sqlite.prepare("INSERT INTO roadmap_ideas (id, title, area, created_at, updated_at) VALUES (?, ?, 'other', ?, ?)");
  for (let i = 0; i < 305; i++) insert.run(`ri_${String(i).padStart(22, '0')}`, `Idea ${i}`, 1000 + i, 1000 + i);
  const { ideas } = (await w.call(alice, 'GET', PATH)).json;
  assert.equal(ideas.length, 300);
  assert.equal(ideas[0].title, 'Idea 304');
  assert.equal(ideas[299].title, 'Idea 5');
});

// ---------------------------------------------------------------------------
// Delete my data

check('delete my data: the person\'s ideas stay with no author, their idea rate-limit row goes, other people\'s ideas are untouched', async () => {
  const { w, alice, bob, ids } = await twoUsers();
  await w.call(alice, 'POST', PATH, { title: 'Alice idea one', area: 'loot', details: 'details' });
  await w.call(alice, 'POST', PATH, { title: 'Alice idea two', area: 'loot' });
  await w.call(bob, 'POST', PATH, { title: 'Bob idea', area: 'loot' });
  assert.equal(await w.count('rate_limits', 'key = ?', `idea:${ids.alice}`), 1);
  const gone = await w.call(alice, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(await w.count('users', 'id = ?', ids.alice), 0);
  assert.equal(await w.count('roadmap_ideas'), 3, 'the ideas stay');
  assert.equal(await w.count('roadmap_ideas', 'submitted_by IS NULL'), 2, 'unlinked from the deleted account');
  assert.equal(await w.count('roadmap_ideas', 'submitted_by = ?', ids.bob), 1);
  assert.equal(await w.count('rate_limits', 'key = ?', `idea:${ids.alice}`), 0);
  assert.equal(await w.count('rate_limits', 'key = ?', `idea:${ids.bob}`), 1);
  const { ideas } = (await w.call(bob, 'GET', PATH)).json;
  assert.equal(ideas.length, 3);
  assert.deepEqual(ideas.filter((i) => i.mine).map((i) => i.title), ['Bob idea'], 'nobody inherits the deleted person\'s ideas');
});

// ---------------------------------------------------------------------------
// Schema

check('schema: the table, its CHECKs, the default status and the SET NULL foreign key', async () => {
  const db = createD1Fake();
  const fks = db.sqlite.prepare('PRAGMA foreign_key_list(roadmap_ideas)').all().map((fk) => `${fk.from}->${fk.table}(${fk.to}):${fk.on_delete}`);
  assert.deepEqual(fks, ['submitted_by->users(id):SET NULL']);
  const columns = db.sqlite.prepare('PRAGMA table_info(roadmap_ideas)').all().map((c) => `${c.name}:${c.type}${c.notnull ? ':notnull' : ''}${c.pk ? ':pk' : ''}`);
  assert.deepEqual(columns, ['id:TEXT:pk', 'title:TEXT:notnull', 'details:TEXT', 'area:TEXT:notnull', "status:TEXT:notnull", 'roadmap_id:TEXT', 'triage_note:TEXT', 'submitted_by:TEXT', 'created_at:INTEGER:notnull', 'updated_at:INTEGER:notnull']);
  const insert = (set) => db.prepare(`INSERT INTO roadmap_ideas (id, title, area, created_at, updated_at${set ? `, ${Object.keys(set).join(', ')}` : ''}) VALUES ('ri_x${crypto.randomBytes(4).toString('hex')}', 'A title', 'loot', 1, 1${set ? `, ${Object.keys(set).map(() => '?').join(', ')}` : ''})`).bind(...(set ? Object.values(set) : [])).run();
  await insert();
  assert.equal((await db.prepare('SELECT status FROM roadmap_ideas').first()).status, 'new');
  await insert({ details: 'd'.repeat(2000), triage_note: 'n'.repeat(300), roadmap_id: 'r'.repeat(80), status: 'declined' });
  for (const bad of [
    { title: 'ab' }, { title: 'x'.repeat(121) }, { details: 'd'.repeat(2001) }, { area: 'nope' }, { status: 'nope' }, { status: 'NEW' },
    { roadmap_id: '' }, { roadmap_id: 'r'.repeat(81) }, { triage_note: 'n'.repeat(301) }, { submitted_by: 'u_missing' },
  ]) {
    const row = { id: 'ri_bad', title: 'A title', area: 'loot', created_at: 1, updated_at: 1, ...bad };
    await throwsD1(() => db.prepare(`INSERT INTO roadmap_ideas (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)).run());
  }
  await throwsD1(() => db.prepare("INSERT INTO roadmap_ideas (id, title, area, updated_at) VALUES ('ri_nt', 'A title', 'loot', 1)").run());
});

check('schema: the area list is the same in the migration, the Worker and the page; so are the statuses and the length limits', async () => {
  const sql = read('migrations/0007_roadmap_ideas.sql');
  assert(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(sql), 'ASCII only');
  assert(!/DROP TABLE|ALTER TABLE/.test(sql));
  const list = (column) => [...new RegExp(`${column}\\s+TEXT[^\\n]*CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const worker = await load('worker/routes/roadmap.js');
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  const page = sandbox.Guild.pages.roadmap;
  const cli = require('./tools/roadmap-ideas.js');
  assert.deepEqual(list('area'), worker.IDEA_AREAS);
  assert.deepEqual(list('area'), [...page.AREAS]);
  assert.deepEqual(list('status'), Object.keys(page.IDEA_STATUS));
  assert.deepEqual(list('status'), cli.STATUSES);
  assert.deepEqual(cli.MARK_STATUSES, cli.STATUSES.filter((s) => s !== 'new'));
  assert(sql.includes(`length(title) BETWEEN ${worker.MIN_TITLE} AND ${worker.MAX_TITLE}`) && sql.includes(`length(details) <= ${worker.MAX_DETAILS}`));
  assert.deepEqual([page.MIN_TITLE, page.MAX_TITLE, page.MAX_DETAILS], [worker.MIN_TITLE, worker.MAX_TITLE, worker.MAX_DETAILS]);
  assert(sql.includes('length(triage_note) <= 300') && sql.includes('length(roadmap_id) BETWEEN 1 AND 80'));
});

check('ids: ri_ ids are random TEXT like the others, and the routes reach the Worker in wrangler.jsonc', async () => {
  const ids = await load('worker/ids.js');
  const id = ids.newId('ri', () => crypto.randomBytes(16));
  assert.equal(id.length, 25);
  assert(ids.isId('ri', id) && !ids.isId('r', id) && !ids.isId('ri', id.replace('ri_', 'r_')));
  const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  assert(config.assets.run_worker_first.includes('/api/roadmap/*'), 'without this /api/roadmap/ideas is served as a static file (404)');
});

// ---------------------------------------------------------------------------
// The triage tool

const cli = require('./tools/roadmap-ideas.js');
const guildDev = require('./tools/guild-dev.js');
const ID_A = 'ri_AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'ri_BBBBBBBBBBBBBBBBBBBBBB';

function usage(argv, pattern) {
  assert.throws(() => cli.parseArgs(argv), (error) => error instanceof cli.UsageError && pattern.test(error.message), argv.join(' '));
}

check('triage tool: parseArgs for list and mark', () => {
  const p = (...argv) => JSON.parse(JSON.stringify(cli.parseArgs(argv)));
  assert.deepEqual(p('list'), { command: 'list', status: null, state: null });
  assert.deepEqual(p('list', '--status', 'new'), { command: 'list', status: 'new', state: null });
  assert.deepEqual(p('list', '--status=done', '--state=C:/tmp/x'), { command: 'list', status: 'done', state: 'C:/tmp/x' });
  assert.deepEqual(p('mark', ID_A, 'added'), { command: 'mark', id: ID_A, status: 'added', roadmapId: null, note: null, state: null });
  assert.deepEqual(p('mark', ID_A, 'done', '--roadmap', 'loot-history', '--note', ' Shipped. '), { command: 'mark', id: ID_A, status: 'done', roadmapId: 'loot-history', note: 'Shipped.', state: null });
  assert.deepEqual(p('mark', '--note=x', ID_B, 'declined'), { command: 'mark', id: ID_B, status: 'declined', roadmapId: null, note: 'x', state: null });
  assert.equal(p('mark', ID_A, 'declined', '--note', '').note, '', 'an empty note clears it');
  assert.equal(p('mark', ID_A, 'added', '--note', 'n'.repeat(300)).note.length, 300);
  assert.equal(p('mark', ID_A, 'added', '--state', 'S').state, 'S');
});

check('triage tool: parseArgs refuses what it cannot quote or what the table would refuse', () => {
  usage([], /list or mark/);
  usage(['nope'], /list or mark/);
  usage(['list', '--status', 'bogus'], /--status must be one of/);
  usage(['list', '--status', 'new', '--status', 'done'], /twice/);
  usage(['list', 'extra'], /takes no arguments/);
  usage(['list', '--roadmap', 'x'], /unknown option/);
  usage(['list', '--status'], /needs a value/);
  usage(['list', '--state', ' '], /needs a directory/);
  usage(['mark'], /idea id and a status/);
  usage(['mark', ID_A], /idea id and a status/);
  usage(['mark', ID_A, 'added', 'extra'], /idea id and a status/);
  usage(['mark', 'ri_short', 'added'], /not an idea id/);
  usage(['mark', `${ID_A}'; DROP TABLE users; --`, 'added'], /not an idea id/);
  usage(['mark', ID_A.replace('ri_', 'r_'), 'added'], /not an idea id/);
  usage(['mark', ID_A, 'new'], /status must be one of added, declined, done/);
  usage(['mark', ID_A, 'bogus'], /status must be one of/);
  usage(['mark', ID_A, 'declined', '--roadmap', 'loot-history'], /not declined/);
  for (const bad of ['Loot-History', 'loot history', "loot'history", 'loot_history', '-loot', 'loot-', 'loot--history', '', 'a'.repeat(81)]) usage(['mark', ID_A, 'added', '--roadmap', bad], /kebab-case/);
  usage(['mark', ID_A, 'added', '--note', 'two\nlines'], /one line/);
  usage(['mark', ID_A, 'added', '--note', 'tab\there'], /one line/);
  usage(['mark', ID_A, 'added', '--note', 'n'.repeat(301)], /at most 300/);
  usage(['mark', ID_A, 'added', '--note', 'a', '--note', 'b'], /twice/);
});

check('triage tool: the SQL it builds quotes every value, and runs on the D1 stand-in (list, filter, mark, clear, no such idea)', async () => {
  const db = createD1Fake();
  const exec = (sql) => db.sqlite.prepare(sql).all().map((row) => ({ ...row }));
  db.sqlite.exec(`INSERT INTO roadmap_ideas (id, title, details, area, status, created_at, updated_at) VALUES
    ('${ID_A}', 'Older', 'It''s a detail', 'planner', 'new', 100, 100), ('${ID_B}', 'Newer', NULL, 'loot', 'new', 200, 200)`);
  const listed = exec(cli.buildSql(cli.parseArgs(['list']), 0));
  assert.deepEqual(listed.map((r) => r.id), [ID_B, ID_A], 'newest first');
  assert.deepEqual(Object.keys(listed[0]), ['id', 'title', 'details', 'area', 'status', 'roadmapId', 'triageNote', 'createdAt', 'updatedAt']);
  assert.deepEqual(exec(cli.buildSql(cli.parseArgs(['list', '--status', 'done']), 0)), []);

  const note = "Josh's \"idea\"; DROP TABLE roadmap_ideas; -- 100% done";
  const marked = exec(cli.buildSql(cli.parseArgs(['mark', ID_A, 'added', '--roadmap', 'loot-history', '--note', note]), 1234.9));
  assert.equal(marked.length, 1);
  assert.deepEqual({ ...marked[0] }, { id: ID_A, title: 'Older', details: "It's a detail", area: 'planner', status: 'added', roadmapId: 'loot-history', triageNote: note, createdAt: 100, updatedAt: 1234 });
  assert.equal(exec('SELECT COUNT(*) AS n FROM roadmap_ideas')[0].n, 2, 'the note was data, not SQL');
  assert.equal(exec(cli.buildSql(cli.parseArgs(['list', '--status', 'added']), 0)).length, 1);

  const kept = exec(cli.buildSql(cli.parseArgs(['mark', ID_A, 'done']), 2000));
  assert.deepEqual([kept[0].status, kept[0].roadmapId, kept[0].triageNote, kept[0].updatedAt], ['done', 'loot-history', note, 2000], 'no --roadmap / --note leaves them as they are');
  const cleared = exec(cli.buildSql(cli.parseArgs(['mark', ID_A, 'done', '--note', '']), 3000));
  assert.equal(cleared[0].triageNote, null);
  assert.deepEqual(exec(cli.buildSql(cli.parseArgs(['mark', 'ri_CCCCCCCCCCCCCCCCCCCCCC', 'done']), 0)), []);
  assert.equal(exec(`SELECT status FROM roadmap_ideas WHERE id = '${ID_B}'`)[0].status, 'new', 'other rows are untouched');
});

function stub(result, calls = []) {
  return { calls, exec: (plan) => { calls.push(plan); return typeof result === 'function' ? result(plan) : result; } };
}
const collector = () => { const out = { logs: [], errors: [] }; out.log = (m) => out.logs.push(m); out.error = (m) => out.errors.push(m); return out; };
const ok = (rows) => ({ status: 0, stdout: `\u001b[1m banner line\n${JSON.stringify([{ results: rows, success: true, meta: { duration: 1 } }])}\n`, stderr: '' });

check('triage tool: it runs `wrangler d1 execute --local` on the dev server\'s state dir through guild-dev, never against a remote database', () => {
  const calls = [];
  const out = collector();
  const code = cli.run(['list', '--status', 'new'], { ...stub(ok([{ id: ID_A, title: 'T' }]), calls), now: () => 5 }, out);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.logs[0]), [{ id: ID_A, title: 'T' }]);
  const [plan] = calls;
  const args = plan.args;
  const at = args.indexOf('d1');
  assert.deepEqual(args.slice(at, at + 4), ['d1', 'execute', 'DB', '--local']);
  assert(args.includes(`wrangler@${guildDev.WRANGLER_VERSION}`));
  assert.equal(args.filter((a) => a === '--persist-to').length, 1);
  assert.equal(args[args.indexOf('--persist-to') + 1], guildDev.stateDir(), 'the same default state dir as npm run guild:dev');
  assert(args.includes('--json') && !args.some((a) => /--remote|--preview/.test(a)));
  assert(args[args.indexOf('--command') + 1].includes("WHERE status = 'new'"));
  const withState = [];
  cli.run(['list', '--state', 'C:/tmp/rs-check'], stub(ok([]), withState), collector());
  assert.equal(withState[0].args[withState[0].args.indexOf('--persist-to') + 1], path.resolve('C:/tmp/rs-check'));
  assert.equal(withState[0].args.filter((a) => a === '--persist-to').length, 1);
  const execute = guildDev.buildCommand('execute', ['--command', 'SELECT 1'], {}).args;
  assert.deepEqual(execute.slice(execute.indexOf('d1'), execute.indexOf('d1') + 4), ['d1', 'execute', 'DB', '--local']);
  assert.throws(() => guildDev.buildCommand('deploy'), /usage/);
  assert(!/--remote/.test(read('tools/roadmap-ideas.js').replace(/^\s*\/?\*.*$/gm, '')), 'the tool never talks to Cloudflare');
});

check('triage tool: mark prints the changed idea; an unknown idea, a missing table and a Wrangler failure are exit 1 with a clear line', () => {
  const marked = collector();
  assert.equal(cli.run(['mark', ID_A, 'declined', '--note', 'No'], { ...stub(ok([{ id: ID_A, status: 'declined' }])), now: () => 7 }, marked), 0);
  assert.deepEqual(JSON.parse(marked.logs[0]), { id: ID_A, status: 'declined' });
  const none = collector();
  assert.equal(cli.run(['mark', ID_A, 'done'], stub(ok([])), none), 1);
  assert.match(none.errors[0], new RegExp(`No idea has the id ${ID_A}`));
  const noTable = collector();
  assert.equal(cli.run(['list'], stub({ status: 1, stdout: '', stderr: 'Error: D1_ERROR: no such table: roadmap_ideas: SQLITE_ERROR' }), noTable), 1);
  assert.match(noTable.errors[0], /guild-dev\.js migrate/);
  const broken = collector();
  assert.equal(cli.run(['list'], stub({ status: 3, stdout: '', stderr: 'boom' }), broken), 1);
  assert.match(broken.errors[0], /Wrangler failed \(exit 3\)[\s\S]*boom/);
  const garbled = collector();
  assert.equal(cli.run(['list'], stub({ status: 0, stdout: 'no json here', stderr: '' }), garbled), 1);
  assert.match(garbled.errors[0], /no JSON/);
  const shape = collector();
  assert.equal(cli.run(['list'], stub({ status: 0, stdout: '{"a":1}', stderr: '' }), shape), 1, 'an object is not the array Wrangler prints');
  const empty = collector();
  assert.equal(cli.run(['list'], stub(ok([])), empty), 0);
  assert.equal(empty.logs[0], '[]');
});

check('triage tool: usage mistakes are exit 2 and never start Wrangler; --roadmap must name an item in roadmap-data.js', () => {
  const calls = [];
  const bad = collector();
  assert.equal(cli.run(['mark', 'nope', 'done'], stub(ok([]), calls), bad), 2);
  assert.match(bad.errors[0], /usage:/);
  const unknown = collector();
  assert.equal(cli.run(['mark', ID_A, 'added', '--roadmap', 'not-on-the-roadmap'], stub(ok([]), calls), unknown), 2);
  assert.match(unknown.errors[0], /not an item id in js\/guild\/roadmap-data\.js/);
  assert.equal(calls.length, 0, 'Wrangler never ran');
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  const ids = JSON.parse(JSON.stringify(sandbox.Guild.roadmap.items.map((i) => i.id)));
  assert.deepEqual(cli.roadmapItemIds(), ids);
  const good = collector();
  assert.equal(cli.run(['mark', ID_A, 'added', '--roadmap', ids[0]], stub(ok([{ id: ID_A }]), calls), good), 0);
  assert.equal(calls.length, 1);
  assert.equal(cli.run(['list'], stub(ok([]), calls), collector()), 0, 'list does not look at the roadmap file');
});

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
