/**
 * Raidsmith - Guild raid context in the planner ("Plan in Planner") tests
 * Run: node raidcontext-tests.js
 *
 * Runs RaidContext (js/app.js, next to the live-link client) in a vm sandbox with the real logic half, the real
 * Raid-Helper re-sync (RaidHelperSync, js/modals.js) and the real guild router and plan reader (js/guild/), against a
 * fake guild API, a fake /api/share, fake timers and a fake document. Covers: the raid's sign-ups building a roster the
 * way a Raid-Helper import does, reopening a raid and folding new sign-ups into the saved plan, opening the plan saved on
 * the raid (a live link) and merging into it, Save to raid, Back to raid, and Refresh reading the guild instead of the event.
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./tests/load-app');

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
}
function hasLoadedWork() { return State.roster.length > 0; }
function rememberImport() { return ''; }
function showView(view) { State.view = view; __env.views.push(view); }
function fetchRosterJson() { __env.rosterFetches++; return Promise.resolve(null); }
var ResultLine = { show() {}, hide() {} };
var Modal = { confirm: async () => true };
`;

const NAMES = ['Import', 'State', 'LiveLinks', 'LiveSync', 'PlanStore', 'RaidContext', 'RaidLink', 'RaidHelperSync', 'currentShareCode',
  'PlanSession', 'ChangeLog', 'currentLiveLink', 'initGroups', 'RosterEdit'];

function memoryStorage() {
  const data = {};
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
}
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

// The guild's own router and plan reader, loaded the way the page loads them.
function loadGuildParts() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['router.js', 'plan-source.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'guild', file), 'utf8'), sandbox, { filename: file });
  return sandbox.Guild;
}
const guildParts = loadGuildParts();
const plain = v => JSON.parse(JSON.stringify(v));

function fakeElement() {
  const classes = new Set();
  return { hidden: false, textContent: '', disabled: false, dataset: {}, classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), contains: n => classes.has(n) }, addEventListener() {} };
}

function makeEnv() {
  const env = { toasts: [], views: [], renders: 0, rosterFetches: 0, calls: [], guildCalls: [], timers: [], storage: memoryStorage(), now: 1_000_000, nextTimer: 1, els: {} };
  env.share = () => response(200, { updatedAt: 1 }); // /api/share
  env.guild = () => new Error('no guild route');      // (method, path, body) -> reply object | Error
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
  env.document = { hidden: false, getElementById: id => (env.els[id] = env.els[id] || fakeElement()), querySelector: () => null, addEventListener() {} };
  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController, Date: FakeDate,
    __env: env, localStorage: env.storage, document: env.document,
    window: { location, localStorage: env.storage, addEventListener() {}, Guild: { api: guildApi, router: guildParts.router, planSource: guildParts.planSource } },
    history: { replaceState() {} }, navigator: {},
    fetch: async (url, init = {}) => {
      const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
      env.calls.push(call);
      return env.share(call);
    },
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    setInterval: () => 0,
  };
  env.ctx = app.sandbox(NAMES, { globals, extraSource: STUBS + CONTEXT_SOURCE + '\n' + INIT_SOURCE + '\n' + SYNC_SOURCE });
  env.api = env.ctx.api;
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

// The guild answers the planner seed (a function, so a test can change it) and accepts a plan.
function guildRoute(env, seedFn) {
  env.guild = (method, p) => {
    if (method === 'GET' && p === PLANNER_PATH) return seedFn();
    if (method === 'PUT' && p === PLAN_PATH) return { raid: {}, sources: {} };
    return new Error('unexpected ' + method + ' ' + p);
  };
}

const allPlayers = State => [...State.groups.flat(), ...State.bench, ...State.unplaced];
const byName = (State, name) => allPlayers(State).find(p => p.name === name);
const spaces = s => String(s).replace(/[\u202f\u00a0]/g, ' ');

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
    await RaidContext.route(HASH);
    assert.deepEqual(env.guildCalls.map(c => c.path), [PLANNER_PATH]);
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
    assert.equal(env.guildCalls.length, 1);
  });

  await check('open: a plan already on screen is saved on this device first and stays in Your plans; the raid\'s plan does not replace it silently', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { State, Import, PlanStore, RaidContext } = env.api;
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name: 'My Kara run', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] }));
    env.ctx.commit();
    const mine = State.planId;
    assert(mine && mine !== 'raid:r1');
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
    assert.equal(State.planId, 'raid:r1');
    assert(!byName(State, 'Galdor'), 'a withdrawn sign-up leaves the plan');
    assert.deepEqual([byName(State, 'Harlan').groupNumber, byName(State, 'Harlan').class], [0, 'HUNTER'], 'a new sign-up waits on the bench');
    assert.equal(byName(State, 'Brindle').signupStatus, 'tentative');
    assert.equal(byName(State, 'Brindle').groupNumber, 0, 'a seated player now tentative is unseated');
    assert.equal(seatOf('Fenwick'), fenwickSeat, 'untouched seats stay put');
    assert.equal(State.notes, 'MT swaps: Aldric then Fenwick');
    assert.match(env.els['raid-context-status'].textContent, /^Opened your plan for this raid/);
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
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
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

  await check('open with a plan saved on the raid (live link): it is fetched, loaded, bound to the raid\'s link, and the current sign-ups are merged into it', async () => {
    // Another browser planned the raid and saved it: its code is on the live link.
    const first = makeEnv();
    guildRoute(first, () => SEED());
    await first.api.RaidContext.route(HASH);
    first.api.State.notes = 'Saved on the raid'; // work that only the saved plan has
    const savedCode = first.api.currentShareCode();
    const env = makeEnv();
    const seed = SEED({ livePlan: 'aB3dE5g', signups: [...SIGNUPS(), signup(8, 'Harlan', 'Hunter', 'Marksmanship')] });
    guildRoute(env, () => seed);
    env.share = call => (call.method === 'GET' && call.url.includes('id=aB3dE5g') ? response(200, { code: savedCode, updatedAt: 500 }) : response(500, {}));
    const { State, LiveLinks, RaidContext } = env.api;
    await RaidContext.route(HASH);
    await settle();
    assert.equal(State.planId, 'raid:r1');
    assert.equal(State.notes, 'Saved on the raid', 'the saved plan is what opened');
    assert.deepEqual([byName(State, 'Harlan').groupNumber, State.sourceEventId], [0, EVENT_ID]);
    const entry = LiveLinks.get(env.storage, LiveLinks.planKey(State));
    assert.deepEqual([entry.id, entry.updatedAt], ['aB3dE5g', 500], 'the plan is bound to the raid\'s link');
    assert.equal(env.calls.filter(c => c.method !== 'GET').length, 0, 'opening writes nothing to the link before the merge is saved');
    assert.match(env.els['raid-context-status'].textContent, /^Opened the plan saved on the raid\./);
    // The merge reaches the live link like any edit.
    env.share = call => response(200, { updatedAt: 600 });
    await env.advance(2500);
    const put = env.calls.filter(c => c.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(put[0].body.id, 'aB3dE5g');
  });

  await check('open: a saved raid plan that is gone (expired link) falls back to this device\'s copy, or to the sign-ups, and says so', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED({ livePlan: 'aB3dE5g' }));
    env.share = () => response(404, {});
    await env.api.RaidContext.route(HASH);
    assert.equal(env.api.State.planId, 'raid:r1');
    assert.equal(env.api.State.groups.flat().length, 5);
    assert.match(env.els['raid-context-status'].textContent, /has expired/);
    // The server unreachable is told differently.
    const down = makeEnv();
    guildRoute(down, () => SEED({ livePlan: 'aB3dE5g' }));
    down.share = () => { throw new TypeError('offline'); };
    await down.api.RaidContext.route(HASH);
    assert.equal(down.api.State.groups.flat().length, 5);
    assert.match(down.els['raid-context-status'].textContent, /could not be reached/);
  });

  await check('Save to raid: makes the live link when the plan has none, then sends names and groups (bench 0, absences left out), the label and the link id; a second save reuses the link', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    env.share = call => (call.method === 'POST' ? response(201, { id: 'nEw1234', updatedAt: 9 }) : response(200, { updatedAt: 10 }));
    const { State, RaidContext, LiveLinks } = env.api;
    await RaidContext.route(HASH);
    await RaidContext.save();
    const posts = env.calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.code, env.api.currentShareCode());
    const put = env.guildCalls.find(c => c.method === 'PUT');
    assert(put, env.els['raid-context-status'].textContent);
    assert.equal(put.path, PLAN_PATH);
    assert.equal(put.body.label, 'Sat BT 2026-10-24');
    assert.equal(put.body.live, 'nEw1234');
    const sent = Object.fromEntries(put.body.players.map(p => [p.name, p.group]));
    assert.deepEqual(Object.keys(sent).sort(), ['Aldric', 'Brindle', 'Cassia', 'Eliora', 'Fenwick', 'Galdor']);
    assert.equal(sent.Eliora, 0, 'the bench is group 0');
    for (const name of ['Aldric', 'Brindle', 'Cassia', 'Fenwick', 'Galdor']) assert.equal(sent[name], byName(State, name).groupNumber, name);
    assert(!('Dunmar' in sent), 'an absence is not placed');
    assert.equal(LiveLinks.get(env.storage, LiveLinks.planKey(State)).id, 'nEw1234');
    assert.match(env.els['raid-context-status'].textContent, /^Saved to the raid at /);
    assert.equal(env.els['raid-context-status'].classList.contains('error'), false);
    assert.equal(env.els['btn-raid-save'].disabled, false);
    // An edit, then a second save: the same link, updated before the raid is told.
    byName(State, 'Fenwick').groupNumber = 0;
    State.groups.forEach(g => { const i = g.findIndex(p => p.name === 'Fenwick'); if (i >= 0) { State.bench.push(...g.splice(i, 1)); } });
    State.roster = State.groups.flat();
    env.ctx.commit();
    await RaidContext.save();
    assert.equal(env.calls.filter(c => c.method === 'POST').length, 1, 'no second link');
    const puts = env.calls.filter(c => c.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].body.id, 'nEw1234');
    assert.equal(puts[0].body.code, env.api.currentShareCode());
    const second = env.guildCalls.filter(c => c.method === 'PUT')[1];
    assert.equal(second.body.live, 'nEw1234');
    assert.equal(second.body.players.find(p => p.name === 'Fenwick').group, 0);
  });

  await check('Save to raid: failures show in the banner (no alert): live links down, the guild refusing, a name the guild cannot take, nothing to save', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    env.share = call => (call.method === 'POST' ? response(500, {}) : response(200, { updatedAt: 1 }));
    const { State, RaidContext } = env.api;
    await RaidContext.route(HASH);
    await RaidContext.save();
    assert.match(env.els['raid-context-status'].textContent, /Live links are down/);
    assert.equal(env.els['raid-context-status'].classList.contains('error'), true);
    assert(!env.guildCalls.some(c => c.method === 'PUT'), 'nothing is sent to the raid');
    assert.equal(env.els['btn-raid-save'].disabled, false, 'the button is back');
    // The live link works; the guild says no.
    env.share = call => (call.method === 'POST' ? response(201, { id: 'nEw1234', updatedAt: 9 }) : response(200, { updatedAt: 10 }));
    const forbidden = Object.assign(new Error('You do not have permission to do that.'), { status: 403, code: 'forbidden' });
    env.guild = (method, p) => (method === 'GET' ? SEED() : forbidden);
    await RaidContext.save();
    assert.equal(env.els['raid-context-status'].textContent, 'You do not have permission to do that.');
    assert.equal(env.els['raid-context-status'].classList.contains('error'), true);
    // A name that is not a character name is left out and counted; one the guild still refuses is named.
    byName(State, 'Aldric').name = 'Aldr1c';
    env.ctx.commit();
    env.guild = (method, p) => (method === 'GET' ? SEED() : { raid: {} });
    await RaidContext.save();
    assert.match(env.els['raid-context-status'].textContent, /^Saved to the raid at .* 1 name was left out/);
    const sentNames = env.guildCalls.filter(c => c.method === 'PUT').pop().body.players.map(p => p.name);
    assert(!sentNames.includes('Aldr1c'));
    const refused = Object.assign(new Error('A character name is 2 to 12 letters.'), { status: 400, code: 'plan_invalid', index: 0 });
    env.guild = (method) => (method === 'GET' ? SEED() : refused);
    await RaidContext.save();
    assert.match(env.els['raid-context-status'].textContent, /^[A-Za-z]+: A character name is 2 to 12 letters\.$/);
    // Another plan on screen: nothing to save to this raid.
    State.planId = 'plan:other';
    await RaidContext.save();
    assert.match(env.els['raid-context-status'].textContent, /no longer the raid plan/);
  });

  await check('Back to raid goes to the raid page and drops the banner; the plan stays open; a commit on another plan also ends the context', async () => {
    const env = makeEnv();
    guildRoute(env, () => SEED());
    const { State, RaidContext } = env.api;
    await RaidContext.route(HASH);
    RaidContext.back();
    assert.equal(env.location.hash, '#/g/g1/raids/r/r1');
    assert.equal(RaidContext.current, null);
    assert.equal(env.els['raid-context-banner'].hidden, true);
    assert.equal(State.planId, 'raid:r1', 'the plan stays open as a plan of this browser');
    // Any other address leaves the raid too.
    await RaidContext.route(HASH);
    assert(RaidContext.current);
    RaidContext.route('#/g/g1/roster');
    assert.equal(RaidContext.current, null);
    RaidContext.route('');
    // Another plan taking over the screen ends it.
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
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
    await RaidContext.route(HASH);
    assert.deepEqual([State.planId, State.sourceEventId, State.gameVersion, State.roster.length], ['raid:r1', null, 'classic', 0]);
    assert.equal(State.selectedRaid, 'mc');
    assert.match(env.els['raid-context-status'].textContent, /^The raid has no sign-ups yet/);
    assert.equal(env.els['raid-context-banner'].hidden, false);
    assert.equal(spaces(env.els['raid-context-text'].textContent), 'Planning Sat, Oct 24, 7:00 PM - Molten Core');
    assert.deepEqual(env.views, ['app']);
  });

  console.log(`\nRaid context tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
})();
