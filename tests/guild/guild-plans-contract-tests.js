/**
 * Raidsmith guild tracker - raid plans in the database CONTRACT tests (Planner client <-> Worker)
 * Run: node tests/guild/guild-plans-contract-tests.js [name-filter]
 *
 * tests/site/raidcontext-tests.js drives the Planner's RaidContext against a hand-made plan-doc server, and guild-plandoc-worker-tests.js drives
 * the Worker's plan-doc routes with hand-made requests. This suite joins them, the way guild-wave2-contract-tests.js does for the pages: the
 * Planner's real logic half and RaidContext / PlanDb / PlanPoll (js/*.js, in a vm with fake timers and a fake document) talk to the real
 * Worker (worker/index.js over the node:sqlite D1 stand-in), one browser per signed-in person (Alice the Guild Master, Erin made an officer).
 * What it proves: the first open migrates this browser's plan to the raid (source in the audit log), a change autosaves as a PUT the Worker
 * accepts and projects onto the old raid page rows, two officers saving from the same revision get a real 409 that the loser adopts with
 * "Updated by <name>", and the poll brings the other officer's plan within seconds. Discord is faked by an injected fetch, the Worker's
 * clock is injected: no network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const { ownByDiscord } = require('../guild-owner-fixture');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const planner = require('../load-app');

const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
// The Planners' requests still in flight. The Worker signs sessions with crypto.subtle (thread pool, real time), so a fixed number of turns
// is not enough on a slow machine (the Cloudflare build): settle until no request is pending.
const inflight = new Set();
const turns = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
const settle = async () => { await turns(); while (inflight.size) { await Promise.allSettled([...inflight]); await turns(); } };

// ---------------------------------------------------------------------------
// The Worker side (as guild-wave2-contract-tests.js): one app over one D1, a cookie jar per signed-in person

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const discordFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${discord.calls}`;
      discord.tokens.set(token, discord.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '');
    const session = bearer && discord.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
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
  const app = createApp({ db, env, fetch: discordFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const fetchFor = (world, jar) => async (urlPath, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await world.app.handle(new Request(`${ORIGIN}${urlPath}`, { method: init.method, headers, body: init.body }));
  absorb(jar, response);
  return response;
};

async function signIn(world, person, servers) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await fetchFor(world, jar)('/auth/login', { method: 'GET' });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await fetchFor(world, jar)(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { method: 'GET' });
  return jar;
}

// The guild pages' own api client, router and plan reader (the scripts the Planner loads next to itself), routed to the Worker.
function loadGuild(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  return G;
}

// ---------------------------------------------------------------------------
// The Planner side: its real scripts in a vm with fake timers, a fake document and the Worker behind fetch. One per signed-in person.

const CONTEXT_SOURCE = planner.slice('const SHARE_API', "document.getElementById('btn-share')");
const SYNC_SOURCE = planner.slice('const RaidHelperSync = {', "document.getElementById('btn-refresh').addEventListener");
const INIT_SOURCE = planner.slice('function initGroups()', '// Role markers use in-game spell icons');
const STUBS = `
var dragData = null;
function showToast(message) { __env.toasts.push(message); }
function commit() {
  var result = PlanSession.observe();
  if (result && result.changed) PlanStore.save(localStorage, result.current);
  LiveSync.onRender();
  if (typeof PlanDb !== 'undefined') PlanDb.onRender();
}
function closePlayerEditor() {}
function closeBuffPicker() {}
function renderLastRun() {}
function hasLoadedWork() { return State.roster.length > 0; }
function rememberImport() { return ''; }
function showView(view) { State.view = view; }
function fetchRosterJson() { return Promise.resolve(null); }
var ResultLine = { show() {}, hide() {} };
var Modal = { confirm: async () => true };
`;
const NAMES = ['State', 'PlanStore', 'RaidContext', 'PlanDb', 'PlanPoll', 'PlanDbLinks', 'RemoteUpdate', 'PlanSession', 'ChangeLog'];
const ABSENT = new Set(['active-player-editor', 'active-buff-picker', 'raid-notes-textarea']);

function memoryStorage() {
  const data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}
function fakeElement() {
  return { hidden: false, textContent: '', disabled: false, dataset: {}, classList: { toggle() {}, contains: () => false }, addEventListener() {} };
}

function plannerFor(world, jar) {
  const G = loadGuild(world, jar);
  const f = fetchFor(world, jar);
  const env = { toasts: [], timers: [], now: NOW, nextTimer: 1, els: {}, storage: memoryStorage(), calls: [], docBlocked: false };
  // The guild api the Planner uses for the sign-ups and the plan read; `docBlocked` makes the plan read fail like an unreachable database.
  const guildApi = {
    get: (p) => (env.docBlocked && /\/plan-doc$/.test(p) ? Promise.reject(Object.assign(new Error('down'), { status: 500 })) : G.api.get(p)),
    put: (p, body) => G.api.put(p, body),
    classify: (err) => ({ view: 'inline', title: '', text: err.message }),
  };
  const location = { pathname: '/', origin: ORIGIN, search: '', hash: '' };
  const document = { hidden: false, activeElement: null, getElementById: (id) => (ABSENT.has(id) ? null : (env.els[id] = env.els[id] || fakeElement())), querySelector: () => null, addEventListener() {} };
  for (const id of ['remote-update-banner', 'raid-lost-banner', 'btn-remote-undo', 'btn-raid-remove']) env.els[id] = Object.assign(fakeElement(), { hidden: true });
  const FakeDate = new Proxy(Date, { get: (target, prop) => (prop === 'now' ? () => env.now : target[prop]) });
  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController, Date: FakeDate,
    __env: env, localStorage: env.storage, document,
    window: { location, localStorage: env.storage, addEventListener() {}, Guild: { api: guildApi, router: G.router, planSource: G.planSource } },
    history: { replaceState() {} }, navigator: {},
    fetch: (url, init = {}) => {
      env.calls.push({ url: String(url), method: init.method || 'GET' });
      const request = f(url, init);
      inflight.add(request);
      request.then(() => inflight.delete(request), () => inflight.delete(request));
      return request;
    },
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: (id) => { env.timers = env.timers.filter((t) => t.id !== id); },
    setInterval: () => 0,
  };
  env.ctx = planner.sandbox(NAMES, { globals, extraSource: STUBS + CONTEXT_SOURCE + '\n' + INIT_SOURCE + '\n' + SYNC_SOURCE });
  env.api = env.ctx.api;
  env.api.PlanSession.ready = true;
  env.advance = async (ms) => {
    const target = env.now + ms;
    for (;;) {
      const due = env.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      env.timers = env.timers.filter((t) => t !== due);
      env.now = Math.max(env.now, due.at);
      due.fn();
      await settle();
    }
    env.now = target;
    await settle();
  };
  return env;
}

// ---------------------------------------------------------------------------
// Scenario: Alice (Guild Master) and Erin (made an officer) plan one upcoming raid of the team; Thoren (Erin's) signed up, so did two characters
// without Discord links.

const ROSTER = [
  ['Thoren', 'PALADIN', 'Protection', 'Holy', 'erin'],
  ['Gorrim', 'PRIEST', 'Holy', 'Discipline', null],
  ['Kaelith', 'ROGUE', 'Combat', null, null],
  ['Mirabel', 'HUNTER', 'Marksmanship', null, null],
  ['Brindle', 'MAGE', 'Fire', null, null],
];

async function scenario() {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadGuild(world, aliceJar);
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false });
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, cls, main, off, who] of ROSTER) {
    const made = await A.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: main, offSpec: off, status: 'raider' });
    people[name] = made.person.id;
    if (who) world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE[who].id}' WHERE id = '${made.person.id}'`);
  }
  const member = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
  const erinJar = await signIn(world, PEOPLE.erin, member);
  ownByDiscord(world.db.sqlite); // a person that records a signed-in account's Discord ID is that account's only when players.user_id says so (identity split)
  const E = loadGuild(world, erinJar);
  const erinUid = (await E.api.get('/auth/me')).user.id;
  await A.api.put(`${base}/people/${erinUid}/roles`, { officer: true, teamLeadTeamIds: [] });
  const raid = (await A.api.post(`${base}/raids`, { teamId, raidOn: '2026-10-24', startTime: '20:00', zone: 'Black Temple' })).raid.id;
  for (const name of ['Gorrim', 'Kaelith', 'Mirabel', 'Brindle']) await A.api.signups.savePerson(gid, raid, people[name], { kind: 'signed' });
  await E.api.signups.save(gid, raid, { kind: 'signed' });
  const s = { world, gid, raid, base, A, erinUid, hash: `#/planner?raid=${gid}.${raid}`, alice: plannerFor(world, aliceJar), erin: plannerFor(world, erinJar) };
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  return s;
}

// Opens the raid in a browser; the fake clock runs while the open is pending (a raid just left sends its last save first).
async function openRaid(s, env) {
  const opening = env.api.RaidContext.route(s.hash);
  let done = false;
  Promise.resolve(opening).finally(() => { done = true; });
  for (let i = 0; i < 300 && !done; i++) await env.advance(100);
  return opening;
}
// A player moved by hand from the seats to the bench.
function benchByHand(env, name) {
  const { State } = env.api;
  State.groups.forEach((g) => { const i = g.findIndex((p) => p.name === name); if (i >= 0) { const [p] = g.splice(i, 1); p.groupNumber = 0; State.bench.push(p); } });
  State.roster = State.groups.flat();
  env.ctx.commit();
}
const benched = (State) => plain(State.bench.map((p) => p.name).sort()); // plain: the Planner's arrays live in another realm
const docOf = (s) => s.rows('SELECT rev, data, updated_by, schema_ver FROM raid_plan_doc WHERE raid_id = ?', s.raid).then((rows) => rows[0] || null);
const planOf = async (s) => JSON.parse((await docOf(s)).data);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('open + migrate: the first open of a raid with no plan builds it from the sign-ups and writes nothing; this browser\'s own plan goes to the raid at once (audit source local) and fills the old raid page rows', async () => {
  const s = await scenario();
  const { alice } = s;
  await openRaid(s, alice);
  const { State, PlanDb, PlanPoll } = alice.api;
  assert.equal(State.planId, 'raid:' + s.raid);
  assert.deepEqual(plain(State.groups.flat().concat(State.bench).map((p) => p.name).sort()), ['Brindle', 'Gorrim', 'Kaelith', 'Mirabel', 'Thoren']);
  assert(PlanDb.active() && PlanPoll.active());
  await alice.advance(30000);
  assert.equal(await docOf(s), null, 'opening alone writes nothing');
  assert.equal((await s.rows('SELECT plan_synced FROM raids WHERE id = ?', s.raid))[0].plan_synced, null, 'the raid is not "planned"');
  // The same browser opens again while the database cannot be read: it keeps a local copy with a real edit.
  alice.api.RaidContext.leave();
  alice.docBlocked = true;
  await openRaid(s, alice);
  assert(!PlanDb.active());
  State.notes = 'Pull order: Gorrim first';
  alice.ctx.commit();
  alice.api.RaidContext.leave();
  alice.docBlocked = false;
  await openRaid(s, alice);
  await alice.advance(5000);
  const doc = await docOf(s);
  assert.deepEqual([doc.rev, doc.schema_ver], [1, 1]);
  assert.equal((await planOf(s)).notes, 'Pull order: Gorrim first');
  assert.equal((await planOf(s)).planId, 'raid:' + s.raid);
  const audit = await s.rows("SELECT after FROM audit_log WHERE action = 'raid.plan' AND entity_id = ?", s.raid);
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].after).source, 'local');
  const projected = await s.rows('SELECT name, group_number FROM raid_plan WHERE raid_id = ? ORDER BY name', s.raid);
  assert.deepEqual(projected.map((r) => r.name), ['Brindle', 'Gorrim', 'Kaelith', 'Mirabel', 'Thoren'], 'the raid page rows follow the plan');
  const binding = alice.api.PlanDbLinks.get(alice.storage, 'tbc|raid:' + s.raid);
  assert.deepEqual([binding.rev, binding.dirty], [1, false], 'the browser remembers the revision it saved');
});

check('autosave: a change goes out as one PUT after the pause, the Worker keeps it as the next revision and the projection follows; the status line says "Saved to the raid"', async () => {
  const s = await scenario();
  const { alice } = s;
  await openRaid(s, alice);
  benchByHand(alice, 'Kaelith');
  assert.equal(await docOf(s), null, 'not yet: the save waits for the pause');
  await alice.advance(3000);
  let doc = await docOf(s);
  assert.equal(doc.rev, 1);
  assert(benched(alice.api.State).includes('Kaelith'));
  assert.deepEqual((await planOf(s)).bench.map((p) => p.name).sort(), benched(alice.api.State));
  const seated = await s.rows('SELECT name, group_number FROM raid_plan WHERE raid_id = ? ORDER BY name', s.raid);
  assert.equal(seated.find((r) => r.name === 'Kaelith').group_number, 0, 'the bench is group 0 on the raid page');
  assert.equal(alice.api.PlanDb.statusText(''), 'Saved to the raid');
  const calls = alice.calls.filter((c) => c.method === 'PUT').length;
  alice.api.State.notes = 'one more';
  alice.ctx.commit();
  await alice.advance(5000);
  doc = await docOf(s);
  assert.equal(doc.rev, 2);
  assert.equal(alice.calls.filter((c) => c.method === 'PUT').length, calls + 1, 'one request per pause');
  await alice.advance(60000);
  assert.equal((await docOf(s)).rev, 2, 'idle: nothing is sent');
});

check('409 and merge: two officers save from the same revision; the Worker refuses the second with the current plan, which the loser adopts ("Updated by <name>"); Undo saves the loser\'s version as a new revision', async () => {
  const s = await scenario();
  const { alice, erin } = s;
  await openRaid(s, alice);
  benchByHand(alice, 'Brindle');
  await alice.advance(3000);
  assert.equal((await docOf(s)).rev, 1);
  await openRaid(s, erin);
  assert.equal(erin.api.PlanDb.rev(), 1);
  assert(benched(erin.api.State).includes('Brindle'), 'Erin opened the plan Alice saved');
  // Both edit from revision 1: Alice's save lands first.
  benchByHand(alice, 'Mirabel');
  benchByHand(erin, 'Gorrim');
  await alice.advance(3000);
  assert.equal((await docOf(s)).rev, 2);
  await erin.advance(2000); // Erin's PUT carries baseRev 1: 409
  assert.equal(erin.els['remote-update-banner'].hidden, false);
  assert.match(erin.els['remote-update-text'].textContent, /^Updated by Alice A/);
  assert(benched(erin.api.State).includes('Mirabel') && !benched(erin.api.State).includes('Gorrim'), 'Alice\'s plan replaced Erin\'s unsaved edit');
  assert.equal((await docOf(s)).rev, 2, 'the refused write changed nothing');
  assert.equal(erin.api.PlanDb.rev(), 2);
  // Undo: Erin's version goes on top of Alice's revision.
  assert(erin.api.RemoteUpdate.undo());
  await erin.advance(5000);
  const doc = await docOf(s);
  assert.equal(doc.rev, 3);
  const bench = (await planOf(s)).bench.map((p) => p.name);
  assert(bench.includes('Gorrim') && !bench.includes('Mirabel'), bench.join(','));
  assert.equal(doc.updated_by !== null, true);
});

check('poll: the other officer\'s save reaches this board within a few seconds, with the editor\'s name and a Changes entry, and costs no save of ours', async () => {
  const s = await scenario();
  const { alice, erin } = s;
  await openRaid(s, alice);
  benchByHand(alice, 'Brindle');
  await alice.advance(3000);
  await openRaid(s, erin);
  const puts = erin.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/plan-doc')).length;
  benchByHand(alice, 'Kaelith');
  await alice.advance(3000);
  assert.equal((await docOf(s)).rev, 2);
  await erin.advance(5000);
  assert(benched(erin.api.State).includes('Kaelith'), 'the move reached Erin\'s board');
  assert.equal(erin.els['remote-update-banner'].hidden, false);
  assert.match(erin.els['remote-update-text'].textContent, /^Updated by Alice A: .*benched/);
  assert.equal(erin.api.ChangeLog.entries[0].kind, 'remote');
  assert.equal(erin.api.PlanDb.rev(), 2);
  assert.equal(erin.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/plan-doc')).length, puts, 'taking over a plan is no save');
  await erin.advance(40000);
  assert.equal((await docOf(s)).rev, 2);
  assert.equal(erin.calls.filter((c) => c.url.includes('plan-doc?since=2')).length > 0, true, 'the poll asks since the revision it holds');
});

check('lost rights: when the Worker answers 403 to a save the plan stays on this device and the lost-raid notice offers Keep as my own copy', async () => {
  const s = await scenario();
  const { erin } = s;
  await openRaid(s, erin);
  benchByHand(erin, 'Brindle');
  await erin.advance(3000);
  assert.equal((await docOf(s)).rev, 1);
  // Erin stops being an officer.
  await s.A.api.put(`${s.base}/people/${s.erinUid}/roles`, { officer: false, teamLeadTeamIds: [] });
  benchByHand(erin, 'Kaelith');
  await erin.advance(5000);
  assert.equal(erin.els['raid-lost-banner'].hidden, false);
  assert.equal(erin.els['btn-raid-remove'].hidden, true);
  assert.equal((await docOf(s)).rev, 1, 'nothing more was written');
  erin.api.RaidContext.keepCopy();
  assert.match(erin.api.State.planId, /^plan:/);
  assert(!erin.api.PlanDb.active());
});

// ---------------------------------------------------------------------------

(async () => {
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
      console.log(String((error && error.stack) || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
