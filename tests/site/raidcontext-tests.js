/**
 * Raidsmith - Guild raid context in the planner ("Plan in Planner") tests
 * Run: node tests/site/raidcontext-tests.js
 *
 * Runs RaidContext (js/app.js, next to the live-link client) in a vm sandbox with the real logic half (including the plan
 * saver and poll of js/plansync.js), the real Raid-Helper re-sync (RaidHelperSync, js/modals.js) and the real guild router and plan
 * reader (js/guild/), against a fake guild API with a fake plan-doc server (revisions, 409), a fake /api/share, fake timers and a
 * fake document. Covers: the raid's sign-ups building a roster the way a Raid-Helper import does, the raid's plan opening from the
 * database (and each migration source when it holds none), autosave, the 409 on opening, the poll merge with the editor's name and
 * Undo as a new revision, permanent failures (Keep as my own copy), leaving flushing a waiting save, Back to raid, and Refresh
 * reading the guild instead of the event.
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../load-app');

const CONTEXT_SOURCE = app.slice('const SHARE_API', "document.getElementById('btn-share')");
const SYNC_SOURCE = app.slice('const RaidHelperSync = {', "document.getElementById('btn-refresh').addEventListener");
const INIT_SOURCE = app.slice('function initGroups()', '// Role markers use in-game spell icons');

// UI-half collaborators the code calls, as recorders (mirrors livesync-tests.js).
const STUBS = `
var dragData = null;
function showToast(message) { __env.toasts.push(message); }
function commit() {
  __env.renders++;
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
function showView(view) { State.view = view; __env.views.push(view); }
function fetchRosterJson() { __env.rosterFetches++; return Promise.resolve(null); }
var ResultLine = { show() {}, hide() {} };
var Modal = { confirm: async () => true };
`;

const NAMES = ['Import', 'State', 'LiveLinks', 'LiveSync', 'PlanStore', 'RaidContext', 'RaidLink', 'RaidHelperSync', 'currentShareCode',
  'PlanSession', 'ChangeLog', 'currentLiveLink', 'initGroups', 'RosterEdit', 'LocalPicks', 'Fairness', 'PlanDb', 'PlanPoll', 'PlanDbLinks',
  'RemoteUpdate', 'saveStatusLine', 'applySaveLine'];

function memoryStorage() {
  const data = {};
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
}
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
const DOC_PATH = '/api/guild/g1/raids/r1/plan-doc';

// The guild's own router and plan reader, loaded the way the page loads them.
function loadGuildParts() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['router.js', 'ui.js', 'plan-source.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'guild', file), 'utf8'), sandbox, { filename: file });
  return sandbox.Guild;
}
const guildParts = loadGuildParts();
const plain = v => JSON.parse(JSON.stringify(v));

// The Worker's plan-doc routes in miniature: one document per raid with a revision, GET ?since, PUT baseRev with 409 plan_conflict.
// Several browsers (envs) can share one server.
function makeServer() {
  const s = { rev: 0, plan: null, updatedAt: null, updatedBy: null, legacy: null, live: null, puts: [], clock: 1000 };
  s.get = since => {
    if (s.rev > 0) {
      if (since === s.rev) return { rev: s.rev, changed: false };
      return { rev: s.rev, changed: true, plan: plain(s.plan), schemaVersion: 1, updatedAt: s.updatedAt, updatedBy: s.updatedBy ? { name: s.updatedBy } : null };
    }
    return since === 0 ? { rev: 0, changed: false } : { rev: 0, changed: true, plan: null, legacy: s.legacy, live: s.live };
  };
  // A PUT as the Worker answers it: {status, body}.
  s.put = (body, who) => {
    if (!body || !Number.isInteger(body.baseRev) || !body.plan) return { status: 400, body: { error: 'plan_invalid' } };
    if (body.plan.planId !== 'raid:r1') return { status: 400, body: { error: 'plan_invalid', message: 'wrong plan' } };
    if (s.rev > 0 && JSON.stringify(body.plan) === JSON.stringify(s.plan)) return { status: 200, body: { rev: s.rev, unchanged: true, updatedAt: s.updatedAt } };
    if (body.baseRev !== s.rev) return { status: 409, body: { error: 'plan_conflict', ...s.get(null), rev: s.rev } };
    s.puts.push({ baseRev: body.baseRev, source: body.source || null, who, schemaVersion: body.schemaVersion });
    s.rev++; s.plan = plain(body.plan); s.updatedBy = who; s.updatedAt = ++s.clock;
    return { status: 200, body: { rev: s.rev, unchanged: false, updatedAt: s.updatedAt } };
  };
  // Another browser saved this plan.
  s.save = (plan, who) => s.put({ baseRev: s.rev, plan, schemaVersion: 1 }, who);
  return s;
}

function fakeElement() {
  const classes = new Set();
  return { hidden: false, textContent: '', disabled: false, dataset: {}, classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), contains: n => classes.has(n) }, addEventListener() {} };
}

// Elements the page only has while something is open: the document says there is none.
const ABSENT = new Set(['active-player-editor', 'active-buff-picker', 'raid-notes-textarea']);

function makeEnv(server = makeServer(), userName = 'Me') {
  const env = { toasts: [], views: [], renders: 0, rosterFetches: 0, calls: [], guildCalls: [], timers: [], storage: memoryStorage(), now: 1_000_000, nextTimer: 1, els: {}, server, userName, offline: false, docFail: null, putStatus: 0 };
  env.share = () => response(200, { updatedAt: 1 }); // /api/share
  env.guild = () => new Error('no guild route');      // (method, path, body) -> reply object | Error
  // The plan-doc routes by fetch (PlanDb saves, PlanPoll polls): the server above, an offline switch, a forced answer for a PUT.
  env.guildFetch = call => {
    if (env.offline) throw new TypeError('offline');
    const u = new URL(call.url, 'https://pp.test');
    if (u.pathname !== DOC_PATH) return response(404, {});
    if (call.method === 'GET') return response(200, env.server.get(u.searchParams.has('since') ? Number(u.searchParams.get('since')) : null));
    if (env.putStatus) return response(env.putStatus, { error: 'x', message: 'refused' });
    const reply = env.server.put(call.body, env.userName);
    return response(reply.status, reply.body);
  };
  const location = { pathname: '/', origin: 'https://pp.test', search: '', hash: '' };
  env.location = location;
  const guildApi = {
    get: path => respond('GET', path), put: (p, body) => respond('PUT', p, body),
    classify: err => ({ view: 'inline', title: '', text: err.message }),
  };
  function respond(method, p, body) {
    env.guildCalls.push({ method, path: p, body: body === undefined ? null : plain(body) });
    const reply = env.guild(method, p, body);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(plain(reply));
  }
  const FakeDate = new Proxy(Date, { get: (target, prop) => (prop === 'now' ? () => env.now : target[prop]) });
  env.document = { hidden: false, activeElement: null, getElementById: id => (ABSENT.has(id) ? null : (env.els[id] = env.els[id] || fakeElement())), querySelector: () => null, addEventListener() {} };
  for (const id of ['remote-update-banner', 'raid-lost-banner', 'btn-remote-undo', 'btn-raid-remove']) env.els[id] = Object.assign(fakeElement(), { hidden: true });
  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController, Date: FakeDate,
    __env: env, localStorage: env.storage, document: env.document,
    window: { location, localStorage: env.storage, addEventListener() {}, Guild: { api: guildApi, router: guildParts.router, planSource: guildParts.planSource, ui: guildParts.ui } },
    history: { replaceState(s, t, url) { const i = String(url).indexOf('#'); location.hash = i < 0 ? '' : String(url).slice(i); } }, navigator: {},
    fetch: async (url, init = {}) => {
      const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
      env.calls.push(call);
      return String(url).startsWith('/api/guild/') ? env.guildFetch(call) : env.share(call);
    },
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    setInterval: () => 0,
  };
  env.ctx = app.sandbox(NAMES, { globals, extraSource: STUBS + CONTEXT_SOURCE + '\n' + INIT_SOURCE + '\n' + SYNC_SOURCE });
  env.api = env.ctx.api;
  env.window = globals.window;
  env.api.PlanSession.ready = true;
  env.advance = async ms => {
    const target = env.now + ms;
    for (;;) {
      const due = env.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      env.timers = env.timers.filter(t => t !== due);
      env.now = Math.max(env.now, due.at);
      due.fn();
      await settle();
    }
    env.now = target;
    await settle();
  };
  return env;
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 5).join('\n      ')}`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────
const EVENT_ID = '1483258698854826006';
const signup = (key, name, className, specName, kind = 'signed') => ({ key, name, discordName: name, personId: 'p' + key, className, specName, kind, position: key });
const SIGNUPS = () => [
  signup(1, 'Aldric', 'Warrior', 'Protection'),
  signup(2, 'Brindle', 'Mage', 'Fire'),
  signup(3, 'Cassia', 'Priest', 'Holy'),
  signup(4, 'Dunmar', 'Absence', null, 'absence'),
  signup(5, 'Eliora', 'Bench', 'Holy', 'bench'),
  signup(6, 'Fenwick', 'Rogue', 'Combat'),
  signup(7, 'Galdor', 'Druid', 'Restoration'),
];
const SEED = (over = {}) => Object.assign({
  raid: { id: 'r1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), title: 'Sat BT', zone: 'Black Temple', eventId: EVENT_ID, teamId: 't1', gameVersion: 'tbc', timeZone: 'America/Chicago' },
  livePlan: null,
  signups: SIGNUPS(),
}, over);
const HASH = '#/planner?raid=g1.r1';
const PLANNER_PATH = '/api/guild/g1/raids/r1/planner';
const PLAN_PATH = '/api/guild/g1/raids/r1/plan';

// The guild answers the planner seed (a function, so a test can change it), the raid's database plan (the env's server) and a legacy plan paste.
function guildRoute(env, seedFn) {
  env.guild = (method, p) => {
    if (method === 'GET' && p === PLANNER_PATH) return seedFn();
    if (method === 'GET' && p === DOC_PATH) return env.docFail || env.server.get(null);
    if (method === 'PUT' && p === PLAN_PATH) return { raid: {}, sources: {} };
    return new Error('unexpected ' + method + ' ' + p);
  };
}
// Opens the raid. Leaving a raid flushes its waiting save on the fake clock, so the clock runs while the open is pending.
async function openRaid(env, hash = HASH) {
  const opening = env.api.RaidContext.route(hash);
  let done = false;
  Promise.resolve(opening).finally(() => { done = true; });
  for (let i = 0; i < 400 && !done; i++) await env.advance(100);
  return opening;
}
// A browser (env) opened on the raid with its own sign-ups.
async function openedEnv(server, userName, seedFn = () => SEED()) {
  const env = makeEnv(server, userName);
  guildRoute(env, seedFn);
  await openRaid(env);
  return env;
}

const allPlayers = State => [...State.groups.flat(), ...State.bench, ...State.unplaced];
const byName = (State, name) => allPlayers(State).find(p => p.name === name);
const spaces = s => String(s).replace(/[  ]/g, ' ');
// The seat of a player moved by hand: out of its group onto the bench.
function benchByHand(env, name) {
  const { State } = env.api;
  State.groups.forEach(g => { const i = g.findIndex(p => p.name === name); if (i >= 0) { const [p] = g.splice(i, 1); p.groupNumber = 0; State.bench.push(p); } });
  State.roster = State.groups.flat();
  env.ctx.commit();
}

(async () => {
  await check('RaidLink: plan id, Raid-Helper shape of the seed, banner text and plan label', () => {
    const { RaidLink } = makeEnv().api;
    assert.equal(RaidLink.planId('r_Ab-9'), 'raid:r_Ab-9');
    assert.equal(RaidLink.planId('a b'), null);
    assert.equal(RaidLink.planId(''), null);
    assert(RaidLink.isRaidPlan('raid:r1') && !RaidLink.isRaidPlan('event:123') && !RaidLink.isRaidPlan('raid:r1:B') && !RaidLink.isRaidPlan(null) && !RaidLink.isRaidPlan('raid:'));
    const json = JSON.parse(RaidLink.seedToRaidHelper(SEED({ signups: [...SIGNUPS(), { key: 8, name: '', className: 'Mage' }, null] })));
    assert.equal(json.signUps.length, 7, 'a sign-up without a name is left out');
    assert.deepEqual(plain(json.signUps[3]), { id: 4, name: 'Dunmar', className: 'Absence', specName: '', position: 4 });
    assert.equal(json.startTime, Date.UTC(2026, 9, 25, 0, 0));
    assert.equal(spaces(RaidLink.bannerText(SEED().raid)), 'Planning Sat, Oct 24, 7:00 PM - Sat BT');
    assert.equal(spaces(RaidLink.bannerText({ raidOn: '2026-10-24', zone: 'Karazhan', startsAt: Date.UTC(2026, 9, 24, 21, 0), timeZone: 'UTC' })), 'Planning Sat, Oct 24, 9:00 PM - Karazhan');
    assert.equal(RaidLink.bannerText({ raidOn: '2026-10-24' }), 'Planning 2026-10-24');
    assert.equal(RaidLink.planLabel(SEED().raid), 'Sat BT 2026-10-24');
    assert.equal(RaidLink.planLabel({ raidOn: '2026-10-24' }), 'Raid 2026-10-24');
    assert.equal(RaidLink.planLabel({ title: 'x'.repeat(100), raidOn: '2026-10-24' }).length, 80);
  });

  await check('open: the raid\'s sign-ups build the roster the way a Raid-Helper import does (kind -> sign-up status, class and spec from the sign-up); the plan is raid:<id>, linked to the event, with the banner', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { State, RaidContext } = env.api;
    await openRaid(env);
    assert.deepEqual(env.guildCalls.map(c => c.path).sort(), [DOC_PATH, PLANNER_PATH].sort(), 'the sign-ups and the raid plan are asked together');
    assert.deepEqual([State.planId, State.sourceEventId, State.gameVersion, State.rosterName], ['raid:r1', EVENT_ID, 'tbc', 'Sat BT 2026-10-24']);
    assert.equal(State.eventStartTime, Date.UTC(2026, 9, 25, 0, 0));
    assert.deepEqual(plain(State.groups.flat().map(p => p.name).sort()), ['Aldric', 'Brindle', 'Cassia', 'Fenwick', 'Galdor']);
    assert.deepEqual(plain(State.bench.map(p => [p.name, p.signupStatus])), [['Eliora', 'bench']]);
    assert.deepEqual(plain(State.unplaced.map(p => [p.name, p.signupStatus])), [['Dunmar', 'absent']]);
    const aldric = byName(State, 'Aldric');
    assert.deepEqual([aldric.class, aldric.spec, aldric.role, aldric.signupStatus], ['WARRIOR', 'Protection', 'tank', 'confirmed']);
    assert.deepEqual(env.views, ['app']);
    assert.equal(env.els['raid-context-banner'].hidden, false);
    assert.equal(spaces(env.els['raid-context-text'].textContent), 'Planning Sat, Oct 24, 7:00 PM - Sat BT');
    assert.match(env.els['raid-context-status'].textContent, /^Started from the raid's 7 sign-ups\./);
    // The same address again is the same open raid.
    const again = RaidContext.route(HASH);
    await again;
    assert.equal(env.guildCalls.length, 2);
    assert(env.api.PlanDb.active(), 'the saver runs for the open raid plan');
    assert.equal(env.server.rev, 0, 'opening writes nothing');
  });

  await check('open: a plan already on screen is saved on this device first and stays in Your plans; the raid\'s plan does not replace it silently', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { State, Import, PlanStore, RaidContext } = env.api;
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name: 'My Kara run', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] }));
    env.ctx.commit();
    const mine = State.planId;
    assert(mine && mine !== 'raid:r1');
    await openRaid(env);
    assert.equal(State.planId, 'raid:r1');
    assert(!allPlayers(State).some(p => p.name === 'Zorro'), 'the raid plan starts clean');
    const kept = PlanStore.read(env.storage).find(p => p.data.planId === mine);
    assert(kept && kept.data.rosterName === 'My Kara run' && kept.data.groups.flat().some(p => p.name === 'Zorro'), 'the earlier plan is saved');
  });

  await check('reopen: the raid\'s plan on this device opens again and the current sign-ups are folded in by the re-sync: new sign-ups benched, withdrawn ones dropped, status changes applied, manual work kept', async () => {
    const env = makeEnv();
    let seed = SEED();
    guildRoute(env, () => seed);
    const { State, RaidContext } = env.api;
    await openRaid(env);
    State.notes = 'MT swaps: Aldric then Fenwick';
    byName(State, 'Fenwick').name = 'Fenwick'; // untouched seat
    const seatOf = name => byName(State, name).groupNumber;
    const fenwickSeat = seatOf('Fenwick');
    env.ctx.commit();
    RaidContext.leave();
    assert.equal(RaidContext.current, null);
    assert.equal(env.els['raid-context-banner'].hidden, true);
    seed = SEED({ signups: [
      ...SIGNUPS().filter(s => s.name !== 'Galdor').map(s => (s.name === 'Brindle' ? { ...s, className: 'Tentative', kind: 'tentative' } : s)),
      signup(8, 'Harlan', 'Hunter', 'Marksmanship'),
    ] });
    await openRaid(env);
    assert.equal(State.planId, 'raid:r1');
    assert(!byName(State, 'Galdor'), 'a withdrawn sign-up leaves the plan');
    assert.deepEqual([byName(State, 'Harlan').groupNumber, byName(State, 'Harlan').class], [0, 'HUNTER'], 'a new sign-up waits on the bench');
    assert.equal(byName(State, 'Brindle').signupStatus, 'tentative');
    assert.equal(byName(State, 'Brindle').groupNumber, 0, 'a seated player now tentative is unseated');
    assert.equal(seatOf('Fenwick'), fenwickSeat, 'untouched seats stay put');
    assert.equal(State.notes, 'MT swaps: Aldric then Fenwick');
    assert.match(env.els['raid-context-status'].textContent, /^Opened the raid's plan/);
    assert(env.toasts.some(t => /Synced with the raid: .*1 new sign-up.*1 withdrew/.test(t)), env.toasts.join(' | '));
  });

  const addPug = (api, name) => {
    const res = api.RosterEdit.AddPlayer(api.State.groups.length - 1, { name, class: 'ROGUE', spec: 'Combat' });
    assert(res.success, res.error);
    return res.player;
  };

  await check('hand-added players (pugs, fill-ins) are kept when the raid is reopened or refreshed; a sign-up that withdrew or turned Absence leaves; the flag survives local save, share code and saved roster', async () => {
    const env = makeEnv();
    let seed = SEED();
    guildRoute(env, () => seed);
    const { State, Import, PlanStore, RaidContext, RaidHelperSync } = env.api;
    await openRaid(env);
    assert(!allPlayers(State).some(p => p.handAdded), 'sign-up players carry no hand-added flag');
    const pug = addPug(env.api, 'Pugsley');
    assert.equal(pug.handAdded, true);
    env.ctx.commit();
    // Local save/load round trip (what reopening on this device reads).
    const saved = PlanStore.read(env.storage).find(p => p.data.planId === 'raid:r1');
    assert(saved && saved.data.groups.flat().find(p => p.name === 'Pugsley').handAdded === true, 'local save keeps the flag');
    // Share code (live link) round trip.
    const code = env.api.currentShareCode();
    const str = Import.decodeSharePayload(code);
    assert(Import.importAddonString(str).success);
    assert.equal(byName(State, 'Pugsley').handAdded, true, 'share code keeps the flag');
    assert(!byName(State, 'Aldric').handAdded);
    // Saved roster round trip.
    const roster = JSON.parse(JSON.stringify(Import.exportRoster()));
    assert(Import.loadRoster(roster));
    assert.equal(byName(State, 'Pugsley').handAdded, true, 'saved roster keeps the flag');
    assert(!byName(State, 'Aldric').handAdded);
    env.ctx.commit();
    // Reopen: Galdor withdrew, Fenwick turned Absence; the pug stays.
    RaidContext.leave();
    seed = SEED({ signups: SIGNUPS().filter(s => s.name !== 'Galdor').map(s => (s.name === 'Fenwick' ? { ...s, className: 'Absence', specName: null, kind: 'absence' } : s)) });
    await openRaid(env);
    assert(byName(State, 'Pugsley'), 'a hand-added player survives reopening');
    assert(!byName(State, 'Galdor'), 'a withdrawn sign-up is removed');
    assert.equal(State.groups.flat().includes(byName(State, 'Fenwick')), false, 'an Absence is no longer seated');
    assert.equal(byName(State, 'Fenwick').signupStatus, 'absent');
    // Refresh: same rule.
    seed = SEED({ signups: SIGNUPS().filter(s => !['Galdor', 'Cassia'].includes(s.name)) });
    await RaidHelperSync.refresh();
    assert(byName(State, 'Pugsley'), 'a hand-added player survives Refresh');
    assert(!byName(State, 'Cassia'), 'a sign-up withdrawn since is removed on Refresh');
    // A pug who then signs up becomes a sign-up player: withdrawing removes them.
    seed = SEED({ signups: [...SIGNUPS().filter(s => !['Galdor', 'Cassia'].includes(s.name)), signup(9, 'Pugsley', 'Rogue', 'Combat')] });
    await RaidHelperSync.refresh();
    assert(byName(State, 'Pugsley') && !byName(State, 'Pugsley').handAdded);
    seed = SEED({ signups: SIGNUPS().filter(s => !['Galdor', 'Cassia'].includes(s.name)) });
    await RaidHelperSync.refresh();
    assert(!byName(State, 'Pugsley'), 'once signed up, withdrawing removes them');
  });

  // ── the raid's plan lives in the database ──────────────────────────
  const putsOf = env => env.calls.filter(c => c.method === 'PUT' && String(c.url).endsWith('/plan-doc'));
  const bindingOf = env => env.api.PlanDbLinks.get(env.storage, 'tbc|raid:r1');

  await check('open: the plan comes from the database (the other officer\'s plan wins), binds its revision, names who saved it, and the new sign-ups fold in as a real change that saves', async () => {
    const server = makeServer();
    const kim = await openedEnv(server, 'Kim');
    kim.api.State.notes = 'Saved by Kim';
    benchByHand(kim, 'Fenwick');
    await kim.advance(5000);
    assert.equal(server.rev, 1);
    const env = makeEnv(server, 'Me');
    guildRoute(env, () => SEED({ signups: [...SIGNUPS(), signup(8, 'Harlan', 'Hunter', 'Marksmanship')] }));
    await openRaid(env);
    const { State, PlanDb, PlanPoll } = env.api;
    assert.equal(State.notes, 'Saved by Kim');
    assert(State.bench.some(p => p.name === 'Fenwick'), 'Kim\'s bench choice is what opened');
    assert.deepEqual([byName(State, 'Harlan').groupNumber, State.sourceEventId], [0, EVENT_ID]);
    assert.equal(env.els['raid-context-status'].textContent, 'Opened the raid\'s plan, last saved by Kim.');
    assert(PlanDb.active() && PlanPoll.active());
    assert.equal(env.guildCalls.filter(c => c.path === DOC_PATH).length, 1, 'the plan is asked for once, next to the sign-ups');
    await env.advance(5000);
    assert.equal(server.rev, 2, 'the sign-up fold-in changed the plan: one new revision');
    assert.deepEqual([server.puts[1].baseRev, server.puts[1].who, server.puts[1].source], [1, 'Me', null]);
    assert(server.plan.bench.some(p => p.name === 'Harlan'));
    assert.deepEqual([bindingOf(env).rev, bindingOf(env).dirty], [2, false]);
    assert.match(env.els['raid-context-status'].textContent, /^Saved to the raid at /);
    assert.equal(env.els['autosave-status'].textContent, 'Saved to the raid');
  });

  await check('open: folding in sign-ups that change nothing writes nothing (no PUT, no revision), however long the page stays open', async () => {
    const server = makeServer();
    const kim = await openedEnv(server, 'Kim');
    benchByHand(kim, 'Fenwick');
    await kim.advance(5000);
    const env = makeEnv(server, 'Me');
    guildRoute(env, () => SEED());
    await openRaid(env);
    await env.advance(60000);
    assert.equal(putsOf(env).length, 0);
    assert.equal(server.rev, 1);
    assert(!env.api.PlanDb.busy());
  });

  await check('open: a raid with only sign-ups writes nothing until the first real edit, which creates the plan (source signups)', async () => {
    const server = makeServer();
    const env = await openedEnv(server, 'Me');
    await env.advance(60000);
    assert.equal(server.rev, 0, 'opening alone never marks the raid planned');
    assert.equal(putsOf(env).length, 0);
    benchByHand(env, 'Fenwick');
    await env.advance(5000);
    assert.deepEqual(server.puts.map(p => [p.baseRev, p.source, p.who, p.schemaVersion]), [[0, 'signups', 'Me', 1]]);
    const second = env.api.State;
    second.notes = 'again';
    env.ctx.commit();
    await env.advance(5000);
    assert.deepEqual([server.puts[1].baseRev, server.puts[1].source], [1, null], 'the source rides only on the first write');
  });

  await check('migrate: this browser\'s plan of the raid goes to the raid at once (source local); while the database is out of reach the plan stays on this device and says so', async () => {
    const server = makeServer();
    const env = makeEnv(server, 'Me');
    guildRoute(env, () => SEED());
    env.docFail = Object.assign(new Error('down'), { status: 500 });
    await openRaid(env);
    const { State, PlanDb, RaidContext } = env.api;
    assert.match(env.els['raid-context-status'].textContent, /could not be reached.*not saved to the raid/);
    assert(!PlanDb.active(), 'no saver without the database');
    State.notes = 'Planned while the database was down';
    env.ctx.commit();
    await env.advance(20000);
    assert.deepEqual([server.rev, putsOf(env).length], [0, 0]);
    RaidContext.leave();
    env.docFail = null;
    await openRaid(env);
    assert(PlanDb.active());
    await env.advance(5000);
    assert.deepEqual(server.puts.map(p => [p.baseRev, p.source]), [[0, 'local']]);
    assert.equal(server.plan.notes, 'Planned while the database was down');
    assert.equal(server.plan.planId, 'raid:r1');
  });

  await check('migrate: this browser\'s plan of the raid\'s Raid-Helper event is re-keyed to the raid (source local); the event\'s own copy stays', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { Import, State, PlanStore } = env.api;
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'bt', name: 'My event plan', players: [
      { name: 'Aldric', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 2 },
      { name: 'Brindle', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 2 }] }));
    State.planId = 'event:' + EVENT_ID;
    State.sourceEventId = EVENT_ID;
    env.ctx.commit();
    await openRaid(env);
    assert.deepEqual([State.planId, State.rosterName], ['raid:r1', 'My event plan']);
    assert.equal(byName(State, 'Aldric').groupNumber, 2, 'the seat the event plan gave stays');
    assert.match(env.els['raid-context-status'].textContent, /^Opened your plan for this raid's Raid-Helper event/);
    assert(PlanStore.read(env.storage).some(p => p.data.planId === 'event:' + EVENT_ID), 'the event plan is still on this device');
    await env.advance(5000);
    assert.deepEqual(env.server.puts.map(p => [p.baseRev, p.source]), [[0, 'local']]);
    assert.equal(env.server.plan.planId, 'raid:r1');
  });

  await check('migrate: the plan on the raid\'s live link becomes the raid\'s plan (source live); the raid plan is not bound to the link', async () => {
    const first = makeEnv();
    guildRoute(first, () => SEED());
    first.docFail = Object.assign(new Error('down'), { status: 500 });
    await openRaid(first);
    first.api.State.notes = 'Saved on the live link';
    const code = first.api.currentShareCode();
    const env = makeEnv();
    guildRoute(env, () => SEED({ signups: [...SIGNUPS(), signup(8, 'Harlan', 'Hunter', 'Marksmanship')] }));
    env.server.live = 'aB3dE5g';
    env.share = call => (call.method === 'GET' && call.url.includes('id=aB3dE5g') ? response(200, { code, updatedAt: 500 }) : response(500, {}));
    await openRaid(env);
    const { State, LiveLinks } = env.api;
    assert.equal(State.notes, 'Saved on the live link');
    assert.equal(State.planId, 'raid:r1');
    assert.deepEqual([byName(State, 'Harlan').groupNumber, State.sourceEventId], [0, EVENT_ID], 'the current sign-ups are merged into it');
    assert.equal(LiveLinks.get(env.storage, LiveLinks.planKey(State)), null);
    assert.match(env.els['raid-context-status'].textContent, /^Opened the plan saved on the raid\./);
    await env.advance(5000);
    assert.deepEqual(env.server.puts.map(p => [p.baseRev, p.source]), [[0, 'live']]);
    assert.equal(env.calls.filter(c => c.method !== 'GET' && !String(c.url).startsWith('/api/guild/')).length, 0, 'nothing is written to the live link');
    // The link cannot be reached: nothing may be written over what it holds.
    const down = makeEnv();
    guildRoute(down, () => SEED());
    down.server.live = 'aB3dE5g';
    down.share = () => { throw new TypeError('offline'); };
    await openRaid(down);
    assert(!down.api.PlanDb.active());
    assert.match(down.els['raid-context-status'].textContent, /could not be reached/);
    await down.advance(30000);
    assert.equal(down.server.rev, 0);
    // A link that expired is no source: the next one is tried.
    const gone = makeEnv();
    guildRoute(gone, () => SEED());
    gone.server.live = 'aB3dE5g';
    gone.share = () => response(404, {});
    await openRaid(gone);
    assert.match(gone.els['raid-context-status'].textContent, /^Started from the raid's 7 sign-ups/);
  });

  await check('migrate: the names the raid page holds go back into their groups (source legacy); a name that is not a sign-up is added without a class and waits on the bench', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    env.server.legacy = { label: 'Sat BT 2026-10-24', players: [{ name: 'Aldric', group: 2 }, { name: 'Brindle', group: 1 }, { name: 'Galdor', group: 0 }, { name: 'Nobody', group: 3 }] };
    await openRaid(env);
    const { State } = env.api;
    assert.equal(byName(State, 'Aldric').groupNumber, 2);
    assert(State.groups[1].some(p => p.name === 'Aldric'));
    assert.equal(byName(State, 'Brindle').groupNumber, 1);
    assert(State.bench.some(p => p.name === 'Galdor'));
    const nobody = State.unplaced.find(p => p.name === 'Nobody');
    assert(nobody && !nobody.class && nobody.signupStatus === 'confirmed', 'a saved name nobody signed up with is added as a player with no class (the unplaced path), not dropped');
    assert.match(env.els['raid-context-status'].textContent, /^Opened the plan saved on the raid: 3 names back in their groups\. 1 name is not among the sign-ups and waits on the bench: pick its class, then seat them\./);
    await env.advance(5000);
    assert.deepEqual(env.server.puts.map(p => [p.baseRev, p.source]), [[0, 'legacy']]);
    assert(env.server.plan.groups[1].some(p => p.name === 'Aldric'));
    assert((env.server.plan.unplaced || []).some(p => p.name === 'Nobody'), 'and it is in the plan the raid keeps');
  });

  await check('banner time: "Saved to the raid at 2:14 PM CT" is the guild\'s zone with its label (guild data, else the zone the raid came with); with neither it is the browser clock and no label', async () => {
    const withUi = await openedEnv(makeServer(), 'Me');
    const { RaidContext } = withUi.api;
    const labelled = RaidContext.timeText(RaidContext.current);
    assert.match(labelled, /^\d{1,2}:\d{2} [AP]M CT$/, 'the seed\'s zone (America/Chicago) with the label the raid page uses');
    assert.equal(labelled, guildParts.ui.timeInZone(withUi.now, 'America/Chicago'), 'the same text the raid page shows');
    // The guild's own zone wins over the seed's.
    withUi.window.Guild.app = { state: { guilds: { g1: { guild: { timeZone: 'America/New_York' } } } } };
    assert.match(RaidContext.timeText(RaidContext.current), /^\d{1,2}:\d{2} [AP]M ET$/);
    // No zone anywhere: the browser's clock, no label.
    const bare = makeEnv(makeServer(), 'Me');
    guildRoute(bare, () => SEED({ raid: Object.assign(SEED().raid, { timeZone: null }) }));
    await openRaid(bare);
    assert.match(bare.api.RaidContext.timeText(bare.api.RaidContext.current), /^\d{1,2}:\d{2} [AP]M$/);
  });

  await check('migrate: the raid page replaced the plan since this browser saved it (the document is gone): the page\'s names win and this device\'s copy is kept under another name', async () => {
    const server = makeServer();
    const env = await openedEnv(server, 'Me');
    env.api.State.notes = 'My old plan';
    benchByHand(env, 'Fenwick');
    await env.advance(5000);
    assert.equal(bindingOf(env).rev, 1);
    env.api.RaidContext.leave();
    Object.assign(server, { rev: 0, plan: null, legacy: { label: 'x', players: [{ name: 'Aldric', group: 3 }] } });
    await openRaid(env);
    const { State, PlanStore } = env.api;
    assert.equal(State.notes, '', 'the earlier plan is not what opened');
    assert.equal(byName(State, 'Aldric').groupNumber, 3);
    assert(PlanStore.read(env.storage).some(p => /\(earlier copy\)$/.test(p.data.rosterName) && p.data.notes === 'My old plan'), 'this device\'s copy is in Your plans');
    assert(env.toasts.some(t => /earlier copy/.test(t)));
    await env.advance(5000);
    assert.deepEqual(server.puts.slice(-1).map(p => [p.baseRev, p.source]), [[0, 'legacy']]);
  });

  await check('open together: two officers open an empty raid at once; the 409 loser adopts the winner\'s plan silently (no notice, no Undo) and keeps polling from its revision', async () => {
    const server = makeServer();
    server.legacy = { label: 'x', players: [{ name: 'Aldric', group: 2 }] };
    const ann = makeEnv(server, 'Ann');
    const bob = makeEnv(server, 'Bob');
    guildRoute(ann, () => SEED());
    guildRoute(bob, () => SEED({ signups: [...SIGNUPS(), signup(8, 'Harlan', 'Hunter', 'Marksmanship')] }));
    await Promise.all([ann.api.RaidContext.route(HASH), bob.api.RaidContext.route(HASH)]);
    assert.equal(server.rev, 0, 'both opened at revision 0');
    await ann.advance(10);
    assert.equal(server.rev, 1);
    await bob.advance(10);
    assert.deepEqual(server.puts.map(p => p.who), ['Ann'], 'Bob\'s write was refused');
    assert.equal(bob.els['remote-update-banner'].hidden, true, 'no "Updated by" notice while opening');
    assert.equal(bob.els['btn-remote-undo'].hidden, true);
    assert.equal(bob.api.PlanDb.rev(), 1);
    assert.equal(bob.api.PlanPoll.rev(), 1);
    assert.deepEqual([bindingOf(bob).rev, bindingOf(bob).dirty], [1, false]);
    assert(!byName(bob.api.State, 'Harlan'), 'the winner\'s plan is what Bob shows');
    await bob.advance(20000);
    assert.equal(server.rev, 1, 'nothing more is written');
  });

  await check('open: what this browser does with its copy follows PlanDbLinks.decide: clean and older = the database; unsent and equal = pushed; unsent and older = the database with Undo; unbound and different = kept as an earlier copy', async () => {
    const server = makeServer();
    const me = await openedEnv(server, 'Me');
    benchByHand(me, 'Fenwick');
    await me.advance(5000);
    me.api.RaidContext.leave();
    // 1. clean binding, the raid moved on: the database wins, no notice.
    const kim = await openedEnv(server, 'Kim');
    benchByHand(kim, 'Galdor');
    await kim.advance(5000);
    assert.equal(server.rev, 2);
    await openRaid(me);
    assert(me.api.State.bench.some(p => p.name === 'Galdor'));
    assert.equal(me.els['remote-update-banner'].hidden, true);
    // 2. unsent edits while offline, the raid unchanged: they are pushed at once.
    me.offline = true;
    me.api.State.notes = 'unsent';
    me.ctx.commit();
    await me.advance(1000);
    me.api.RaidContext.leave();
    await me.advance(15000);
    assert.equal(bindingOf(me).dirty, true, 'the edit is still marked unsent');
    me.offline = false;
    await openRaid(me);
    await me.advance(5000);
    assert.equal(server.plan.notes, 'unsent');
    assert.deepEqual([server.puts.slice(-1)[0].who, server.puts.slice(-1)[0].baseRev], ['Me', 2]);
    assert.equal(me.els['remote-update-banner'].hidden, true);
    // 3. unsent edits and the raid moved on: the database wins and the local edits are one Undo away.
    me.offline = true;
    me.api.State.notes = 'unsent again';
    me.ctx.commit();
    await me.advance(1000);
    me.api.RaidContext.leave();
    await me.advance(15000);
    me.offline = false;
    await kim.advance(5000); // Kim's board takes over the pushed revision before she edits
    kim.api.State.notes = 'Kim wrote this';
    kim.ctx.commit();
    await kim.advance(30000);
    await openRaid(me);
    assert.equal(me.api.State.notes, 'Kim wrote this');
    assert.equal(me.els['remote-update-banner'].hidden, false);
    assert.match(me.els['remote-update-text'].textContent, /by Kim.$/);
    me.api.RemoteUpdate.undo();
    assert.equal(me.api.State.notes, 'unsent again');
    await me.advance(5000);
    assert.equal(server.plan.notes, 'unsent again', 'Undo is saved as a new revision');
    // 4. no binding, a different copy of the raid plan on this device: kept as an earlier copy, the database wins.
    const fresh = makeEnv(server, 'Me2');
    guildRoute(fresh, () => SEED());
    fresh.docFail = Object.assign(new Error('down'), { status: 500 });
    await openRaid(fresh);
    fresh.api.State.notes = 'mine alone';
    fresh.ctx.commit();
    fresh.api.RaidContext.leave();
    fresh.docFail = null;
    await openRaid(fresh);
    assert.equal(fresh.api.State.notes, 'unsent again');
    assert(fresh.api.PlanStore.read(fresh.storage).some(p => /\(earlier copy\)$/.test(p.data.rosterName) && p.data.notes === 'mine alone'));
  });

  await check('an edit made to the raid plan after leaving the raid (the plain Planner) marks its binding unsent, so the next open does not replace it silently', async () => {
    const server = makeServer();
    const me = await openedEnv(server, 'Me');
    benchByHand(me, 'Fenwick');
    await me.advance(5000);
    me.api.RaidContext.leave();
    await me.advance(5000);
    assert.equal(bindingOf(me).dirty, false);
    me.api.RaidContext.noteLocalEdit();
    assert.equal(bindingOf(me).dirty, true);
    me.api.State.planId = 'plan:elsewhere';
    assert.doesNotThrow(() => me.api.RaidContext.noteLocalEdit());
  });

  await check('fallback: no right to edit (403) or a plan this page cannot read keeps the plan on this device; edits made there mark the raid binding unsent', async () => {
    const server = makeServer();
    const me = await openedEnv(server, 'Me');
    benchByHand(me, 'Fenwick');
    await me.advance(5000);
    me.api.RaidContext.leave();
    me.docFail = Object.assign(new Error('You do not have permission to do that.'), { status: 403 });
    await openRaid(me);
    assert.match(me.els['raid-context-status'].textContent, /You cannot edit this raid, so changes stay on this device\./);
    assert(!me.api.PlanDb.active());
    assert.equal(bindingOf(me).dirty, false);
    me.api.State.notes = 'edited while cut off';
    me.ctx.commit();
    assert.equal(bindingOf(me).dirty, true, 'the next open pushes it instead of replacing it');
    me.api.RaidContext.leave();
    server.plan = Object.assign(plain(server.plan), { groups: 'not a plan' });
    me.docFail = null;
    await openRaid(me);
    assert.match(me.els['raid-context-status'].textContent, /newer Planner/);
    assert(!me.api.PlanDb.active());
    assert.equal(me.api.State.notes, 'edited while cut off');
  });

  await check('save: a failing save says so in the save line and the banner (the next-step bar flags it), retries, and reports "Saved to the raid" again', async () => {
    const server = makeServer();
    const env = await openedEnv(server, 'Me');
    benchByHand(env, 'Fenwick');
    await env.advance(5000);
    const status = env.els['autosave-status'];
    assert.equal(status.textContent, 'Saved to the raid');
    assert.equal(status.dataset.failed, undefined);
    env.offline = true;
    benchByHand(env, 'Galdor');
    await env.advance(6000);
    assert.equal(status.textContent, 'Not saved to the raid yet, retrying. Your changes are safe on this device.');
    assert.equal(status.dataset.failed, 'true');
    assert.equal(status.dataset.raid, 'true');
    assert.equal(env.els['raid-context-status'].classList.contains('error'), true);
    env.offline = false;
    await env.advance(40000);
    assert.equal(server.rev, 2);
    assert.equal(status.textContent, 'Saved to the raid');
    assert.equal(status.dataset.failed, undefined);
    assert.match(env.els['raid-context-status'].textContent, /^Saved to the raid at /);
    assert.equal(env.els['raid-context-status'].classList.contains('error'), false);
  });

  await check('permanent failure: losing the right to edit offers "Keep as my own copy" (a plan of its own, no longer bound to the raid); the raid being gone also offers Remove, which drops the device copy', async () => {
    const server = makeServer();
    const env = await openedEnv(server, 'Me');
    benchByHand(env, 'Fenwick');
    await env.advance(5000);
    const { State, PlanStore, PlanDb, PlanPoll, RaidContext } = env.api;
    env.putStatus = 403;
    State.notes = 'last words';
    env.ctx.commit();
    await env.advance(5000);
    assert.equal(env.els['raid-lost-banner'].hidden, false);
    assert.match(env.els['raid-lost-text'].textContent, /can no longer edit this raid/);
    assert.equal(env.els['btn-raid-remove'].hidden, true);
    assert.equal(env.els['autosave-status'].dataset.failed, 'true');
    assert.match(env.els['autosave-status'].textContent, /you can no longer edit it/);
    env.location.hash = '#/planner?raid=g1.r1';
    assert(PlanStore.read(env.storage).some(p => p.data.planId === 'raid:r1'), 'raid entry saved before Keep');
    RaidContext.keepCopy();
    assert(!/raid=/.test(env.location.hash), 'address bar no longer names the raid');
    assert.equal(env.location.hash, '#/planner');
    assert(!PlanStore.read(env.storage).some(p => p.data.planId === 'raid:r1'), 'stale raid entry gone from Your plans');
    assert.match(State.planId, /^plan:/);
    assert(State.rosterName.endsWith('(my copy)'));
    assert.equal(State.notes, 'last words');
    assert.equal(RaidContext.current, null);
    assert(!PlanDb.active() && !PlanPoll.active());
    assert.equal(bindingOf(env), null);
    assert.equal(env.els['raid-lost-banner'].hidden, true);
    assert(PlanStore.read(env.storage).some(p => p.data.planId === State.planId && p.data.notes === 'last words'));
    // The raid is gone (404): Remove drops the device copy.
    const other = await openedEnv(makeServer(), 'Me');
    benchByHand(other, 'Fenwick');
    other.putStatus = 404;
    other.api.State.notes = 'orphan';
    other.ctx.commit();
    await other.advance(5000);
    assert.equal(other.els['raid-lost-banner'].hidden, false);
    assert.match(other.els['raid-lost-text'].textContent, /^This raid no longer exists/);
    assert.equal(other.els['btn-raid-remove'].hidden, false);
    other.api.RaidContext.removeCopy();
    assert.equal(other.api.State.planId, null);
    assert(!other.api.PlanStore.read(other.storage).some(p => p.data.planId === 'raid:r1'));
    assert.equal(other.location.hash, '#/planner');
    assert(other.views.includes('landing'));
    assert.equal(bindingOf(other), null);
  });

  await check('poll: another officer\'s plan appears within one poll with "Updated by <name>" and a Changes entry; no save of ours follows; Undo puts our version back as a new revision', async () => {
    const server = makeServer();
    const me = await openedEnv(server, 'Me');
    benchByHand(me, 'Fenwick');
    await me.advance(5000);
    const kim = await openedEnv(server, 'Kim');
    benchByHand(kim, 'Galdor');
    await kim.advance(5000);
    assert.equal(server.rev, 2);
    const mineBefore = JSON.stringify(me.api.PlanStore.capture());
    await me.advance(5000);
    const { State, ChangeLog, RemoteUpdate } = me.api;
    assert(State.bench.some(p => p.name === 'Galdor'), 'Kim\'s move reached this board');
    assert.equal(me.els['remote-update-banner'].hidden, false);
    assert.match(me.els['remote-update-text'].textContent, /^Updated by Kim: .*benched/);
    assert.equal(ChangeLog.entries[0].kind, 'remote');
    assert.deepEqual([me.api.PlanDb.rev(), me.api.PlanPoll.rev(), bindingOf(me).rev], [2, 2, 2]);
    assert.equal(server.puts.length, 2, 'taking over a plan is no save');
    await me.advance(20000);
    assert.equal(server.puts.length, 2);
    // Undo: our version, saved on top of Kim's revision.
    assert(RemoteUpdate.undo());
    assert.deepEqual(plain(me.api.PlanStore.capture()), JSON.parse(mineBefore));
    assert(me.toasts.includes('Restored your version of the roster'), me.toasts.join(' | '));
    await me.advance(5000);
    assert.deepEqual([server.rev, server.puts[2].baseRev, server.puts[2].who], [3, 2, 'Me']);
    assert(!server.plan.bench.some(p => p.name === 'Galdor'));
    await kim.advance(5000);
    assert(!kim.api.State.bench.some(p => p.name === 'Galdor'), 'Kim\'s board follows');
    assert.match(kim.els['remote-update-text'].textContent, /^Updated by Me/);
  });

  await check('merge: a save that finds a newer revision (409) while the user edited puts the newest plan on screen with "Updated by" and Undo; Undo saves the user\'s version again', async () => {
    const server = makeServer();
    const me = await openedEnv(server, 'Me');
    benchByHand(me, 'Fenwick');
    await me.advance(5000);
    const kim = await openedEnv(server, 'Kim');
    benchByHand(kim, 'Galdor');
    await kim.advance(5000);
    benchByHand(me, 'Brindle'); // not saved yet when Kim's revision exists
    await me.advance(1700);
    assert.equal(me.els['remote-update-banner'].hidden, false, 'the 409 loser is told');
    assert.match(me.els['remote-update-text'].textContent, /^Updated by Kim/);
    assert(!me.api.State.bench.some(p => p.name === 'Brindle'), 'Kim\'s plan replaced the unsaved edit');
    assert(me.api.State.bench.some(p => p.name === 'Galdor'));
    assert.equal(server.puts.length, 2);
    me.api.RemoteUpdate.undo();
    await me.advance(5000);
    assert.equal(server.rev, 3);
    assert(server.plan.bench.some(p => p.name === 'Brindle') && !server.plan.bench.some(p => p.name === 'Galdor'), 'the user\'s version is the new revision');
  });

  await check('leave: Back to raid, any other address and a version switch flush a waiting save, then stop saving and polling', async () => {
    const server = makeServer();
    const env = await openedEnv(server, 'Me');
    const { PlanDb, PlanPoll, RaidContext } = env.api;
    benchByHand(env, 'Fenwick');
    assert.equal(server.rev, 0, 'the save is still waiting');
    RaidContext.back();
    assert(!PlanPoll.active(), 'the poll stops at once');
    await env.advance(5000);
    assert.equal(server.rev, 1, 'the waiting save went out');
    assert(!PlanDb.active() && RaidContext.dbOwner === null);
    // A version switch from inside the raid plan: detach resolves once the raid holds what was on screen.
    await openRaid(env);
    assert(RaidContext.inDatabase());
    benchByHand(env, 'Galdor');
    const detaching = RaidContext.detach();
    for (let i = 0; i < 100; i++) await env.advance(100);
    await detaching;
    assert.equal(server.rev, 2);
    assert(!RaidContext.inDatabase() && !PlanDb.active());
    // Another address.
    await openRaid(env);
    benchByHand(env, 'Cassia');
    RaidContext.route('#/g/g1/roster');
    await env.advance(5000);
    assert.equal(server.rev, 3);
    assert(!PlanDb.active());
  });

  await check('standalone: with no raid open nothing talks to the guild (no /api/guild request, no saver, no poll), and the Save to raid button and methods are gone', async () => {
    const env = makeEnv();
    const { Import, State, PlanDb, PlanPoll, RaidContext } = env.api;
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name: 'Mine', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] }));
    env.ctx.commit();
    State.notes = 'standalone';
    env.ctx.commit();
    await env.advance(120000);
    assert.equal(env.calls.filter(c => String(c.url).startsWith('/api/guild')).length, 0);
    assert.equal(env.guildCalls.length, 0);
    assert(!PlanDb.active() && !PlanPoll.active());
    assert.equal(env.api.saveStatusLine().text, 'Saved on this device');
    assert.equal(typeof RaidContext.save, 'undefined');
    assert.equal(typeof RaidContext.liveId, 'undefined');
    assert(!app.html.includes('btn-raid-save') && !app.html.includes('Save to raid'));
  });

  await check('Back to raid goes to the raid page and drops the banner; the plan stays open; a commit on another plan also ends the context', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { State, RaidContext } = env.api;
    await openRaid(env);
    RaidContext.back();
    assert.equal(env.location.hash, '#/g/g1/raids/r/r1');
    assert.equal(RaidContext.current, null);
    assert.equal(env.els['raid-context-banner'].hidden, true);
    assert.equal(State.planId, 'raid:r1', 'the plan stays open as a plan of this browser');
    // Any other address leaves the raid too.
    await openRaid(env);
    assert(RaidContext.current);
    RaidContext.route('#/g/g1/roster');
    assert.equal(RaidContext.current, null);
    RaidContext.route('');
    // Another plan taking over the screen ends it.
    await openRaid(env);
    State.planId = 'plan:elsewhere';
    env.ctx.commit();
    assert.equal(RaidContext.current, null);
  });

  await check('open: a failed read of the raid keeps the plan on screen as it was, toasts why, and leaves no banner', async () => {
    const env = makeEnv();
    const { State, Import, RaidContext } = env.api;
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] }));
    env.ctx.commit();
    const before = State.planId;
    env.guild = () => Object.assign(new Error('You do not have permission to do that.'), { status: 403 });
    await openRaid(env);
    assert.deepEqual(env.toasts, ['You do not have permission to do that.']);
    assert.equal(RaidContext.current, null);
    assert.equal(State.planId, before);
    assert.deepEqual(env.views, []);
    env.guild = () => Object.assign(new Error('x'), { status: 401 });
    await RaidContext.route(HASH.replace('r1', 'r2'));
    assert.match(env.toasts[1], /^Sign in to Raidsmith/);
  });

  await check('Refresh on a raid plan reads the raid\'s sign-ups from the guild, never Raid-Helper; outside the raid it explains where to go', async () => {
    const env = makeEnv();
    let seed = SEED();
    guildRoute(env, () => seed);
    const { State, RaidContext, RaidHelperSync } = env.api;
    await openRaid(env);
    seed = SEED({ signups: [...SIGNUPS(), signup(8, 'Harlan', 'Hunter', 'Marksmanship')] });
    env.toasts.length = 0;
    await RaidHelperSync.refresh();
    assert.equal(env.rosterFetches, 0, 'Raid-Helper is not asked');
    assert.equal(env.guildCalls.filter(c => c.path === PLANNER_PATH).length, 2);
    assert(byName(State, 'Harlan'));
    assert(env.toasts.includes('Checking the raid sign-ups...') && env.toasts.some(t => /^Refreshed: 1 new sign-up/.test(t)), env.toasts.join(' | '));
    // After leaving the raid the plan still follows no event of its own.
    RaidContext.leave();
    env.toasts.length = 0;
    await RaidHelperSync.refresh();
    assert.equal(env.rosterFetches, 0);
    assert(env.toasts.some(t => /belongs to a guild raid/.test(t)), env.toasts.join(' | '));
    // An ordinary event plan still asks Raid-Helper.
    State.planId = 'event:555555';
    State.sourceEventId = '555555';
    await RaidHelperSync.refresh();
    assert.equal(env.rosterFetches, 1);
  });

  await check('a raid without an event or sign-ups opens an empty plan with the banner; a different game version starts the plan in that version', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED({ raid: Object.assign(SEED().raid, { eventId: null, gameVersion: 'classic', zone: 'Molten Core', title: null }), signups: [] }));
    const { State, RaidContext } = env.api;
    await openRaid(env);
    assert.deepEqual([State.planId, State.sourceEventId, State.gameVersion, State.roster.length], ['raid:r1', null, 'classic', 0]);
    assert.equal(State.selectedRaid, 'mc');
    assert.match(env.els['raid-context-status'].textContent, /^The raid has no sign-ups yet/);
    assert.equal(env.els['raid-context-banner'].hidden, false);
    assert.equal(spaces(env.els['raid-context-text'].textContent), 'Planning Sat, Oct 24, 7:00 PM - Molten Core');
    assert.deepEqual(env.views, ['app']);
  });

  // ── PM wave 2: size, markers and date-only raids in the seed ──────
  // A crowd of n sign-ups over a mix of classes every version knows (tanks and healers first, so the role floors are met).
  const MIX = [['Warrior', 'Protection'], ['Paladin', 'Holy1'], ['Priest', 'Holy'], ['Shaman', 'Restoration1'], ['Druid', 'Restoration'],
    ['Mage', 'Fire'], ['Rogue', 'Combat'], ['Warlock', 'Destruction'], ['Hunter', 'Marksmanship'], ['Warrior', 'Fury'], ['Priest', 'Shadow'], ['Mage', 'Frost']];
  const crowd = n => Array.from({ length: n }, (_, i) => signup(i + 1, 'Raider' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)), ...MIX[i % MIX.length]));
  const sizedSeed = (raid, signups) => SEED({ raid: Object.assign(SEED().raid, { title: null }, raid), signups });
  const openSeed = async seed => {
    const env = makeEnv();
    guildRoute(env, () => seed);
    await openRaid(env);
    return env;
  };

  await check('size: a Forever raid at Hyjal Summit (size 20) opens on f_hyjal with its 4 groups and 20 seated; the sign-up count does not shrink it', async () => {
    const env = await openSeed(sizedSeed({ gameVersion: 'forever', zone: 'Hyjal Summit', size: 20 }, crowd(22)));
    const { State } = env.api;
    assert.deepEqual([State.gameVersion, State.selectedRaid, State.groups.length], ['forever', 'f_hyjal', 4]);
    assert.deepEqual([State.groups.flat().length, State.bench.length], [20, 2]);
  });

  await check('size: a Forever raid with no zone and size 40 opens on the 40-player template with 8 groups', async () => {
    const env = await openSeed(sizedSeed({ gameVersion: 'forever', zone: null, size: 40 }, crowd(12)));
    const { State } = env.api;
    assert.deepEqual([State.selectedRaid, State.groups.length, State.groups.flat().length], ['forever40', 8, 12]);
  });

  await check('size: a TBC 25 raid with 8 sign-ups stays 25-man; with no size and no zone the sign-up count still picks Karazhan, as before', async () => {
    const sized = await openSeed(sizedSeed({ zone: null, size: 25 }, crowd(8)));
    assert.deepEqual([sized.api.State.selectedRaid, sized.api.State.groups.length], ['bt', 5]);
    const old = await openSeed(sizedSeed({ zone: null, size: null }, crowd(8)));
    assert.deepEqual([old.api.State.selectedRaid, old.api.State.groups.length], ['kara', 2]);
    const unknownSize = await openSeed(sizedSeed({ zone: null, size: 40 }, crowd(8)));
    assert.equal(unknownSize.api.State.selectedRaid, 'kara', 'a size the version has no raid for leaves the old behaviour');
  });

  await check('size: the zone names the raid (within the seed\'s game version) unless the raid\'s size says otherwise; Classic uses its own templates', async () => {
    const gruul = await openSeed(sizedSeed({ zone: 'Gruul\'s Lair', size: null }, crowd(8)));
    assert.deepEqual([gruul.api.State.selectedRaid, gruul.api.State.groups.length], ['gruul', 5], 'a zone alone keeps its raid, even with 8 sign-ups');
    const hyjalTbc = await openSeed(sizedSeed({ zone: 'Hyjal Summit', size: 25 }, crowd(8)));
    assert.equal(hyjalTbc.api.State.selectedRaid, 'hyjal', 'the TBC Hyjal, not Forever\'s f_hyjal');
    const overridden = await openSeed(sizedSeed({ zone: 'Black Temple', size: 10 }, crowd(8)));
    assert.equal(overridden.api.State.selectedRaid, 'kara', 'a raid size set to 10 beats the zone\'s 25');
    const wrongZoneSize = await openSeed(sizedSeed({ zone: 'Karazhan', size: 25 }, crowd(8)));
    assert.equal(wrongZoneSize.api.State.selectedRaid, 'bt', 'Karazhan is not a 25-man: the version\'s default 25-man opens');
    const classic = await openSeed(sizedSeed({ gameVersion: 'classic', zone: null, size: 20 }, crowd(30)));
    assert.deepEqual([classic.api.State.selectedRaid, classic.api.State.groups.length], ['classic20', 4]);
    const classicOld = await openSeed(sizedSeed({ gameVersion: 'classic', zone: null, size: null }, crowd(15)));
    assert.equal(classicOld.api.State.selectedRaid, 'zg', 'no size, no zone: the 20-man heuristic as before');
  });

  await check('size: a plan already on this device keeps the raid template the user left it on; only a plan started from the sign-ups takes the raid\'s size', async () => {
    const env = makeEnv();
    let seed = sizedSeed({ zone: null, size: 25 }, crowd(8));
    guildRoute(env, () => seed);
    const { State, RaidContext } = env.api;
    await openRaid(env);
    assert.equal(State.selectedRaid, 'bt');
    State.selectedRaid = 'ssc';
    env.ctx.commit();
    RaidContext.leave();
    seed = sizedSeed({ zone: 'Black Temple', size: 10 }, crowd(8));
    await openRaid(env);
    assert.equal(State.selectedRaid, 'ssc', 'on screen: kept');
    // Saved on this device, another plan on screen: still the saved plan's template.
    RaidContext.leave();
    env.api.Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name: 'Other', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] });
    env.ctx.commit();
    await openRaid(env);
    assert.equal(State.selectedRaid, 'ssc', 'saved: kept');
  });

  await check('markers: a marker reaches the player (seated, bench, Absent tray), the \'also\' sign-up waits on the bench as Signed up, and none of it is in the share code, the local save or the saved roster', async () => {
    const env = makeEnv();
    const withMarker = (s, kind, text) => ({ ...s, marker: { kind, text } });
    const rows = () => [
      withMarker(signup(1, 'Aldric', 'Warrior', 'Protection'), 'late', 'Late: 21:00'),
      signup(2, 'Brindle', 'Mage', 'Fire'),
      withMarker(signup(3, 'Cassia', 'Priest', 'Holy'), 'standby', 'Standby'),
      withMarker(signup(4, 'Dunmar', 'Absence', null, 'absence'), 'away', 'Away: notice'),
      withMarker(signup(5, 'Eliora', 'Mage', 'Arcane'), 'also', 'Also in: Team B raid'),
      withMarker(signup(6, 'Fenwick', 'Rogue', 'Combat'), 'leaving', 'Leaves: 22:00'),
    ];
    let seed = SEED({ signups: rows() });
    guildRoute(env, () => seed);
    const { State, RaidContext, RaidHelperSync, Import, PlanSession, PlanStore } = env.api;
    await openRaid(env);
    const marker = name => { const p = byName(State, name); return p && p.marker ? plain(p.marker) : null; };
    assert.deepEqual(marker('Aldric'), { kind: 'late', text: 'Late: 21:00' });
    assert.deepEqual(marker('Cassia'), { kind: 'standby', text: 'Standby' });
    assert.deepEqual(marker('Fenwick'), { kind: 'leaving', text: 'Leaves: 22:00' });
    assert.equal(marker('Brindle'), null);
    assert(State.unplaced.includes(byName(State, 'Dunmar')) && marker('Dunmar').kind === 'away', 'Away arrives as Absent with its tag');
    const eliora = byName(State, 'Eliora');
    assert(State.bench.includes(eliora), 'the also-in-another-raid sign-up waits on the bench');
    assert.deepEqual([eliora.signupStatus, eliora.groupNumber, marker('Eliora').kind], ['confirmed', 0, 'also']);
    assert(State.groups.flat().includes(byName(State, 'Aldric')), 'a late marker changes no placement');

    // Not in the share code, the local save or the saved roster.
    env.ctx.commit();
    const str = Import.decodeSharePayload(env.api.currentShareCode());
    assert(!/marker|Standby|Late:|Away:|Also in/.test(str + JSON.stringify(Import.exportRoster())), 'no marker text in the share string or the saved roster');
    State.notes = 'a real change, saved';
    env.ctx.commit();
    const saved = PlanStore.read(env.storage).find(p => p.data.planId === 'raid:r1');
    assert(saved && saved.data.notes === 'a real change, saved' && !JSON.stringify(saved.data).includes('"marker"'), 'the local save carries no markers');
    assert(Import.importAddonString(str).success);
    assert(allPlayers(State).every(p => !p.marker), 'a plan read from a share code has no markers');
    // Reopening the raid brings them back from the seed.
    RaidContext.leave();
    await openRaid(env);
    assert.equal(marker('Cassia').kind, 'standby', 'the next open applies them again');
    assert.equal(marker('Eliora').kind, 'also');

    // Refresh: a changed marker is replaced, a dropped one cleared, with no report and no plan change.
    seed = SEED({ signups: rows().map(s => (s.name === 'Aldric' ? { ...s, marker: undefined } : s.name === 'Cassia' ? { ...s, marker: { kind: 'late', text: 'Late: 20:30' } } : s)) });
    const undoDepth = PlanSession.undo.length;
    const codeBefore = env.api.currentShareCode();
    env.toasts.length = 0;
    await RaidHelperSync.refresh();
    assert.equal(marker('Aldric'), null, 'a marker the seed dropped is cleared');
    assert.deepEqual(marker('Cassia'), { kind: 'late', text: 'Late: 20:30' });
    assert.equal(PlanSession.undo.length, undoDepth, 'a marker alone is no plan change');
    assert.equal(env.api.currentShareCode(), codeBefore);
    assert(env.toasts.some(t => /^Refreshed\. Roster is up to date/.test(t)), env.toasts.join(' | '));
    assert(!env.toasts.some(t => /new sign-up|withdrew|changed spec/.test(t)));
  });

  await check('markers: Undo keeps the markers of the plan on screen, and a live-link update does not wipe them', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED({ signups: [{ ...signup(1, 'Aldric', 'Warrior', 'Protection'), marker: { kind: 'standby', text: 'Standby' } }, signup(2, 'Brindle', 'Mage', 'Fire'), signup(3, 'Cassia', 'Priest', 'Holy')] }));
    const { State, RaidContext, PlanSession, PlanStore, LocalPicks, Import } = env.api;
    await openRaid(env);
    env.ctx.commit();
    const group = byName(State, 'Brindle').groupNumber;
    State.notes = 'a step to undo';
    env.ctx.commit();
    assert(PlanSession.undoLast(), 'one step to undo');
    assert.equal(State.notes, '');
    assert.equal(byName(State, 'Aldric').marker.kind, 'standby', 'Undo rebuilt the players and put the marker back');
    assert.equal(byName(State, 'Brindle').groupNumber, group);
    // A rebuilt copy from a live link keeps them through LocalPicks.
    const picks = LocalPicks.capture();
    assert(Import.importAddonString(Import.exportShareString()).success);
    assert(allPlayers(State).every(p => !p.marker));
    LocalPicks.restore(picks);
    assert.equal(byName(State, 'Aldric').marker.kind, 'standby');
    // Another plan's players get none of them.
    const other = PlanStore.capture();
    other.planId = 'plan:other';
    assert(PlanStore.restore(other));
    assert(allPlayers(State).every(p => !p.marker), 'markers belong to the plan they came with');
  });

  await check('date-only raid (timeKnown false): the banner shows the date without a made-up time, the plan claims no start time, and the seed JSON sends none', async () => {
    const noon = Date.UTC(2026, 9, 24, 12, 0);
    const raid = { startsAt: noon, timeKnown: false, timeZone: 'Pacific/Auckland' };
    const { RaidLink } = makeEnv().api;
    assert.equal(spaces(RaidLink.whenText(Object.assign({}, SEED().raid, raid))), 'Sat, Oct 24', 'read in UTC, so no zone moves the day');
    assert.equal(spaces(RaidLink.bannerText(Object.assign({}, SEED().raid, raid))), 'Planning Sat, Oct 24 - Sat BT');
    assert(!('startTime' in JSON.parse(RaidLink.seedToRaidHelper(SEED({ raid: Object.assign(SEED().raid, raid) })))));
    // timeKnown true (or absent, as older seeds) is the same as before.
    for (const known of [true, undefined]) assert.equal(spaces(RaidLink.whenText(Object.assign({}, SEED().raid, { timeKnown: known }))), 'Sat, Oct 24, 7:00 PM');
    const env = await openSeed(SEED({ raid: Object.assign(SEED().raid, raid) }));
    assert.equal(env.api.State.eventStartTime, null);
    assert.equal(spaces(env.els['raid-context-text'].textContent), 'Planning Sat, Oct 24 - Sat BT');
    // The re-sync of a reopened date-only raid does not set one either.
    env.api.RaidContext.leave();
    await openRaid(env);
    assert.equal(env.api.State.eventStartTime, null);
    const known = await openSeed(SEED());
    assert.equal(known.api.State.eventStartTime, Date.UTC(2026, 9, 25, 0, 0));
  });

  // ── PM wave 6: the fair bench's sit-out history rides in the seed ──
  await check('fair bench: the seed\'s recentRaids and benchedRecently load before the plan is built, Refresh replaces them, and leaving the raid forgets them', async () => {
    const withHistory = (counts, window = 4) => SEED({
      raid: Object.assign(SEED().raid, { recentRaids: window }),
      signups: SIGNUPS().map(s => (counts[s.name] === undefined ? s : Object.assign({}, s, { benchedRecently: counts[s.name] }))),
    });
    const env = makeEnv();
    let seed = withHistory({ Aldric: 2, Brindle: 0, Cassia: 4 });
    guildRoute(env, () => seed);
    const { State, RaidContext, Fairness, PlanStore } = env.api;
    assert(!Fairness.active());
    await openRaid(env);
    assert(Fairness.active() && Fairness.window === 4);
    assert.deepEqual(plain(['Aldric', 'Brindle', 'Cassia', 'Fenwick'].map(name => Fairness.benches({ name }))), [2, 0, 4, 0]);
    // Refresh in the planner reads the guild again: the history it carries replaces the old one.
    seed = withHistory({ Aldric: 1, Fenwick: 3 }, 3);
    const refreshed = await RaidContext.fetchDiff(() => {});
    assert(refreshed && refreshed.success);
    assert.deepEqual(plain([Fairness.window, ...['Aldric', 'Brindle', 'Cassia', 'Fenwick'].map(name => Fairness.benches({ name }))]), [3, 1, 0, 0, 3]);
    // A seed without the fields (a team's first raid, an older Worker) has none.
    seed = SEED();
    await RaidContext.fetchDiff(() => {});
    assert(!Fairness.active(), 'no recentRaids: no history');
    seed = withHistory({ Aldric: 2 });
    await RaidContext.fetchDiff(() => {});
    assert(Fairness.active());
    RaidContext.leave();
    assert(!Fairness.active() && Fairness.byName.size === 0, 'the history ends with the raid context');
    // Another plan opened over the raid ends the context and the history with it.
    await openRaid(env);
    assert(Fairness.active());
    const other = PlanStore.capture();
    other.planId = 'plan:other';
    assert(PlanStore.restore(other));
    RaidContext.onCommit();
    assert(!Fairness.active());
  });

  console.log(`\nRaid context tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
})();
