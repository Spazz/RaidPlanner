/**
 * PartyPlanner Web - Live link client (LiveSync) tests
 * Run: node livesync-tests.js
 *
 * Runs the live-link client code from index.html (everything from SHARE_API to
 * applyShareCode: fetchLiveLink, LiveSync, getShareLink, loadFromShortLink) in
 * a vm sandbox next to the logic half, with a fake fetch, fake timers, a fake
 * clock and a fake document/window/localStorage. Covers the reliability pack:
 * replacing an expired link with a new one, flushing on page hide, permanent vs transient
 * failures, 429 back-off and the portable timeout signal.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const LIVE_SOURCE = app.slice('const SHARE_API', "document.getElementById('btn-share')");

// UI-half collaborators the live-link code calls, as recorders.
const STUBS = `
var dragData = null;
function showToast(message) { __env.toasts.push(message); }
function commit() { __env.renders++; LiveSync.onRender(); }
function hasLoadedWork() { return State.roster.length > 0; }
function rememberImport() { return ''; }
var confirm = () => true;
`;

const NAMES = ['Import', 'State', 'LiveLinks', 'LiveSync', 'PlanStore', 'timeoutSignal', 'fetchLiveLink',
  'getShareLink', 'loadFromShortLink', 'currentShareCode'];

function memoryStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

function response(status, body = {}, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, json: async () => body };
}

// A fresh sandbox per test: its own clock, timers, storage and fetch log.
function makeEnv({ path = '/', hidden = false } = {}) {
  const env = { toasts: [], renders: 0, calls: [], timers: [], listeners: {}, storage: memoryStorage(), now: 1_000_000, nextTimer: 1 };
  env.route = () => response(200, { updatedAt: 1 });

  const FakeDate = new Proxy(Date, { get: (target, prop) => (prop === 'now' ? () => env.now : target[prop]) });
  const addListener = scope => (type, fn) => { (env.listeners[scope + ':' + type] ||= []).push(fn); };
  const location = { pathname: path, origin: 'https://pp.test', search: '', hash: '' };
  env.location = location;
  env.document = { hidden, getElementById: () => null, querySelector: () => null, addEventListener: addListener('document') };

  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController, Date: FakeDate,
    __env: env,
    localStorage: env.storage,
    document: env.document,
    window: { location, localStorage: env.storage, addEventListener: addListener('window') },
    history: { replaceState: (_state, _title, url) => { location.pathname = String(url).split('?')[0]; } },
    navigator: {},
    fetch: async (url, init = {}) => {
      const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, keepalive: !!init.keepalive, signal: init.signal };
      env.calls.push(call);
      return env.route(call);
    },
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    setInterval: () => 0,
  };
  env.ctx = app.sandbox(NAMES, { globals, extraSource: STUBS + LIVE_SOURCE });
  env.api = env.ctx.api;

  // Moves the clock forward, firing due timers in order.
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
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

// A tbc Karazhan plan bound to link aB3dE5g with its current code already synced.
function seedLinkedPlan(env) {
  const { State, LiveLinks, currentShareCode } = env.api;
  seedPlan(env);
  const planKey = LiveLinks.planKey(State);
  LiveLinks.bind(env.storage, planKey, 'aB3dE5g', currentShareCode(), 100);
  return planKey;
}

function seedPlan(env) {
  const { Import, State } = env.api;
  const players = Array.from({ length: 10 }, (_, i) => ({ name: 'P' + i, class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 + Math.floor(i / 5) }));
  assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', players }));
  State.planId = 'event:999';
}

// A user edit: change the plan, then render (which is what schedules the save).
function edit(env, notes) {
  env.api.State.notes = notes;
  env.ctx.commit();
}

const puts = env => env.calls.filter(c => c.method === 'PUT');
const gets = env => env.calls.filter(c => c.method === 'GET');
const entryOf = (env, planKey) => env.api.LiveLinks.get(env.storage, planKey);

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

(async () => {
  // ── S3: an expired link is replaced by a new one (a PUT never creates an ID) ──
  const NEW_ID = 'nEw1234';
  const expiredRoute = (env, { putStatus = 404, postStatus = 201 } = {}) => {
    env.route = call => {
      if (call.method === 'GET') return response(404, { error: 'Link not found or expired' });
      if (call.method === 'PUT') return response(putStatus, { error: 'Link not found or expired' });
      return postStatus === 201 ? response(201, { id: NEW_ID, updatedAt: 777 }) : response(postStatus, { error: 'boom' });
    };
  };
  const posts = env => env.calls.filter(c => c.method === 'POST');
  const expiryToasts = env => env.toasts.filter(t => /live link expired/.test(t));

  await check('Poll 404 POSTs the current plan as a new link and rebinds, with no PUT', async () => {
    const env = makeEnv({ path: '/tbc/aB3dE5g' });
    const planKey = seedLinkedPlan(env);
    env.api.LiveSync.opening = false; // the page-load fetch of this link is over
    expiredRoute(env);
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(puts(env).length, 0, 'a PUT would only 404 again');
    assert.equal(posts(env).length, 1);
    assert.deepEqual(posts(env)[0].body, { code: env.api.currentShareCode() });
    const entry = entryOf(env, planKey);
    assert.equal(entry.id, NEW_ID, 'the plan is bound to the new link');
    assert.equal(entry.updatedAt, 777);
    assert.equal(entry.lastCode, env.api.currentShareCode());
    assert.equal(env.api.LiveLinks.findById(env.storage, 'aB3dE5g'), null, 'the old id is no longer bound');
    assert.equal(env.location.pathname, '/tbc/' + NEW_ID, 'address bar follows the new link');
    assert.equal(expiryToasts(env).length, 1, 'the user is told');
    assert.equal(env.api.LiveSync.expiredId, null);
    assert.equal(env.api.LiveSync.statusText('x'), 'Synced to live link');
  });

  await check('A save that gets 404 from the PUT POSTs a fresh link, rebinds, updates the address bar and toasts', async () => {
    const env = makeEnv({ path: '/tbc/aB3dE5g' });
    const planKey = seedLinkedPlan(env);
    expiredRoute(env);
    edit(env, 'edited after the link expired');
    await env.advance(2000);
    assert.equal(puts(env).length, 1);
    assert.equal(puts(env)[0].body.id, 'aB3dE5g');
    assert.equal(posts(env).length, 1);
    assert.equal(posts(env)[0].body.code, env.api.currentShareCode(), 'the edit travels with the new link');
    assert.equal(entryOf(env, planKey).id, NEW_ID);
    assert.equal(entryOf(env, planKey).lastCode, env.api.currentShareCode());
    assert.equal(env.location.pathname, '/tbc/' + NEW_ID);
    assert.equal(expiryToasts(env).length, 1);
    assert.match(expiryToasts(env)[0], /new live link is active/);
    assert.equal(env.api.LiveSync.failed, false);
    assert.equal(env.api.LiveSync.pending, false);
    // Later edits PUT to the new link.
    env.route = () => response(200, { updatedAt: 900 });
    edit(env, 'and again');
    await env.advance(2000);
    assert.equal(puts(env).length, 2);
    assert.equal(puts(env)[1].body.id, NEW_ID);
    assert.equal(expiryToasts(env).length, 1, 'no second toast');
  });

  await check('A page-exit save (keepalive) that finds the link expired creates the new link with keepalive too', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    expiredRoute(env);
    edit(env, 'closing the tab');
    env.api.LiveSync.flushOnExit();
    await settle();
    assert.equal(posts(env).length, 1);
    assert.equal(posts(env)[0].keepalive, true);
    assert.equal(entryOf(env, planKey).id, NEW_ID);
  });

  await check('Poll 200 of an unchanged plan does not PUT or POST', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(200, { code: env.api.currentShareCode(), updatedAt: 100 });
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(puts(env).length, 0);
    assert.equal(posts(env).length, 0);
  });

  await check('A failed replacement keeps the old binding and is retried on the next tick until it lands', async () => {
    const env = makeEnv({ path: '/tbc/aB3dE5g' });
    const planKey = seedLinkedPlan(env);
    env.api.LiveSync.opening = false; // the page-load fetch of this link is over
    expiredRoute(env, { postStatus: 503 });
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(posts(env).length, 1);
    assert.equal(env.api.LiveSync.failed, true);
    assert.equal(env.api.LiveSync.statusText('x'), 'Live link not synced, retrying');
    assert.equal(entryOf(env, planKey).id, 'aB3dE5g', 'still bound to the old link');
    assert.equal(env.location.pathname, '/tbc/aB3dE5g');
    assert.equal(expiryToasts(env).length, 0, 'no toast for a replacement that did not happen');
    expiredRoute(env); // the server is back
    await env.api.LiveSync.pull(); // failed -> retried without a GET
    await settle();
    assert.equal(posts(env).length, 2, 'retried although the plan itself never changed');
    assert.equal(puts(env).length, 0, 'the link is already known to be gone');
    assert.equal(env.api.LiveSync.failed, false);
    assert.equal(entryOf(env, planKey).id, NEW_ID);
    assert.equal(expiryToasts(env).length, 1);
    const callsBefore = env.calls.length;
    env.route = call => (call.method === 'GET' ? response(200, { code: env.api.currentShareCode(), updatedAt: 777 }) : response(500));
    await env.api.LiveSync.pull();
    await settle();
    assert.deepEqual(env.calls.slice(callsBefore).map(c => c.method), ['GET'], 'the expired flag is spent: only the poll goes out');
  });

  await check('A POST that answers with a malformed ID is a failed replacement, not a rebind', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    env.route = call => (call.method === 'POST' ? response(201, { id: '../etc', updatedAt: 1 }) : response(404));
    edit(env, 'edit');
    await env.advance(2000);
    assert.equal(env.api.LiveSync.failed, true);
    assert.equal(entryOf(env, planKey).id, 'aB3dE5g');
    assert.equal(expiryToasts(env).length, 0);
  });

  await check('A 4xx refusal of the replacement (e.g. 403) is a permanent rejection, like any save', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    expiredRoute(env, { postStatus: 403 });
    edit(env, 'edit');
    await env.advance(2000);
    assert.equal(env.api.LiveSync.failed, false);
    assert.equal(env.api.LiveSync.statusText('x'), 'Live link not synced: boom');
    assert.equal(entryOf(env, planKey).id, 'aB3dE5g');
  });

  await check('A 429 on the replacement backs off; the retry afterwards creates the link', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    env.route = call => (call.method === 'POST' ? response(429, {}, { 'Retry-After': '7' }) : response(404));
    edit(env, 'edit');
    await env.advance(2000);
    assert.equal(posts(env).length, 1);
    assert.equal(env.api.LiveSync.failed, true);
    expiredRoute(env);
    await env.advance(3000);
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(posts(env).length, 1, 'still backing off');
    await env.advance(5000);
    assert.equal(posts(env).length, 2);
    assert.equal(entryOf(env, planKey).id, NEW_ID);
  });

  await check('A transient failure with nothing left to push clears itself instead of sticking on "retrying"', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(503);
    edit(env, 'one edit');
    await env.advance(2000);
    assert.equal(env.api.LiveSync.failed, true);
    edit(env, ''); // back to exactly what the server holds
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(env.api.LiveSync.failed, false);
    assert.equal(env.api.LiveSync.pending, false);
  });

  await check('Opening an expired /<version>/<id> link reopens the local copy and gives it a new link', async () => {
    const env = makeEnv({ path: '/tbc/aB3dE5g' });
    const planKey = seedLinkedPlan(env);
    env.api.PlanStore.save(env.storage, env.api.PlanStore.capture());
    env.api.State.planId = 'plan:something-else'; // a different plan is open when the link is visited
    env.api.State.rosterName = 'Other';
    expiredRoute(env);
    const opened = await env.api.loadFromShortLink();
    await settle();
    assert.equal(opened, true);
    assert.equal(env.api.LiveLinks.planKey(env.api.State), planKey, 'the bound plan is open again');
    assert.equal(puts(env).length, 0);
    assert.equal(posts(env).length, 1);
    assert.equal(entryOf(env, planKey).id, NEW_ID);
    assert.equal(entryOf(env, planKey).updatedAt, 777);
    assert.equal(env.location.pathname, '/tbc/' + NEW_ID);
    assert(!env.toasts.some(t => /expired or does not exist/.test(t)));
    assert.equal(expiryToasts(env).length, 1);
  });

  await check('Opening an expired link with no local copy still reports it as expired', async () => {
    const env = makeEnv({ path: '/tbc/zZ9yY8x' });
    env.route = () => response(404);
    assert.equal(await env.api.loadFromShortLink(), false);
    assert(env.toasts.some(t => /expired or does not exist/.test(t)));
    assert.equal(puts(env).length, 0);
    assert.equal(posts(env).length, 0, 'a link someone else shared is never re-created from nothing');
  });

  await check('Opening a live link whose server copy exists is unchanged (no PUT or POST, local copy reopened)', async () => {
    const env = makeEnv({ path: '/tbc/aB3dE5g' });
    seedLinkedPlan(env);
    env.api.PlanStore.save(env.storage, env.api.PlanStore.capture());
    env.route = () => response(200, { code: env.api.currentShareCode(), updatedAt: 100 });
    assert.equal(await env.api.loadFromShortLink(), true);
    await settle();
    assert.equal(puts(env).length, 0);
  });

  // ── B21: flush on page hide ─────────────────────────────────────
  await check('flushOnExit sends the waiting save immediately with keepalive and cancels the debounce', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    env.route = () => response(200, { updatedAt: 999 });
    edit(env, 'last drag before closing');
    assert.equal(env.api.LiveSync.pending, true);
    assert.equal(puts(env).length, 0, 'still inside the 2s debounce');
    env.api.LiveSync.flushOnExit();
    await settle();
    assert.equal(puts(env).length, 1);
    assert.equal(puts(env)[0].keepalive, true);
    assert.equal(puts(env)[0].body.code, env.api.currentShareCode());
    assert.equal(entryOf(env, planKey).updatedAt, 999, 'a page that survives the hide still records the sync');
    await env.advance(5000);
    assert.equal(puts(env).length, 1, 'the cancelled debounce does not send a second copy');
  });

  await check('flushOnExit does nothing when nothing is waiting, a save is in flight, or the plan has no link', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.api.LiveSync.flushOnExit();
    assert.equal(env.calls.length, 0, 'synced plan');
    edit(env, 'edit');
    env.api.LiveSync.saving = true;
    env.api.LiveSync.flushOnExit();
    assert.equal(env.calls.length, 0, 'a request is already in flight');
    env.api.LiveSync.saving = false;
    env.storage.setItem('pp_live_links', '{}');
    env.api.LiveSync.pending = true;
    env.api.LiveSync.flushOnExit();
    await settle();
    assert.equal(env.calls.length, 0, 'unlinked plan');
  });

  await check('start() hooks pagehide and visibilitychange(hidden) to the flush, and a visible tab to a pull', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(200, { updatedAt: 5 });
    env.api.LiveSync.start();
    assert(env.listeners['window:pagehide'], 'pagehide listener registered');
    assert(env.listeners['document:visibilitychange'], 'visibilitychange listener registered');

    edit(env, 'hide via visibilitychange');
    env.document.hidden = true;
    env.listeners['document:visibilitychange'].forEach(fn => fn());
    await settle();
    assert.equal(puts(env).length, 1);
    assert.equal(puts(env)[0].keepalive, true);

    edit(env, 'close via pagehide');
    env.listeners['window:pagehide'].forEach(fn => fn());
    await settle();
    assert.equal(puts(env).length, 2);

    env.document.hidden = false;
    env.route = () => response(200, { code: env.api.currentShareCode(), updatedAt: 5 });
    env.listeners['document:visibilitychange'].forEach(fn => fn());
    await settle();
    assert(gets(env).length >= 1, 'coming back to the tab pulls');
    assert.equal(puts(env).length, 2);
  });

  // ── B20: permanent 4xx ──────────────────────────────────────────
  await check('A 4xx rejection stops retrying, shows the reason, and resumes only when the plan changes', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(400, { error: 'Invalid share code' });
    edit(env, 'first');
    await env.advance(2000);
    assert.equal(puts(env).length, 1);
    assert.equal(env.api.LiveSync.failed, false, 'not "retrying"');
    assert.equal(env.api.LiveSync.statusText('x'), 'Live link not synced: Invalid share code');
    await env.advance(60000);
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(env.calls.length, 1, 'no retries and no polling while rejected');
    edit(env, 'second'); // the user changed the plan: try again
    await env.advance(2000);
    assert.equal(puts(env).length, 2);
  });

  await check('Rejection is dropped once the plan is back to what the server holds', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(403, { error: 'nope' });
    edit(env, 'bad');
    await env.advance(2000);
    assert.equal(env.api.LiveSync.statusText('x'), 'Live link not synced: nope');
    edit(env, '');
    assert.equal(env.api.LiveSync.rejected, null);
    assert.equal(env.api.LiveSync.statusText('x'), 'Synced to live link');
  });

  await check('5xx, 404 and 408 are transient: retried on the next poll, not treated as rejections', async () => {
    for (const status of [500, 502, 404, 408]) {
      const env = makeEnv();
      seedLinkedPlan(env);
      env.route = () => response(status, {});
      edit(env, 'edit');
      await env.advance(2000);
      assert.equal(env.api.LiveSync.failed, true, `status ${status}`);
      assert.equal(env.api.LiveSync.rejected, null, `status ${status}`);
      env.route = () => response(200, { updatedAt: 3 });
      await env.api.LiveSync.pull();
      await settle();
      assert.equal(puts(env).length, 2, `status ${status} retried`);
      assert.equal(env.api.LiveSync.failed, false);
    }
  });

  await check('A plan over the 32 KB server limit is never sent; the reason is shown and nothing loops', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.ctx.currentShareCode = () => 'A'.repeat(env.api.LiveLinks.maxCodeLength + 1);
    env.route = () => response(200, { updatedAt: 1 });
    edit(env, 'huge');
    assert.equal(env.api.LiveSync.pending, false);
    assert.equal(env.api.LiveSync.statusText('x'), 'Live link not synced: plan is too large for a live link (33 KB, limit 32 KB)');
    await env.advance(60000);
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(env.calls.length, 0, 'no PUT and no poll');
    env.api.LiveSync.flushOnExit();
    assert.equal(env.calls.length, 0, 'not even on exit');
    env.ctx.currentShareCode = () => 'A'.repeat(100); // back under the limit
    edit(env, 'smaller');
    assert.equal(env.api.LiveSync.rejected, null);
    await env.advance(2000);
    assert.equal(puts(env).length, 1);
  });

  await check('getShareLink skips the POST for an oversized plan and falls back to the long link', async () => {
    const env = makeEnv();
    seedPlan(env);
    env.ctx.currentShareCode = () => 'A'.repeat(env.api.LiveLinks.maxCodeLength + 1);
    const link = await env.ctx.getShareLink();
    assert.equal(link.live, false);
    assert(link.url.startsWith('https://pp.test/#r=AAAA'));
    assert.equal(env.calls.length, 0);
  });

  await check('getShareLink: a 429 on create falls back; a 201 binds the new link', async () => {
    const env = makeEnv();
    seedPlan(env);
    const { State, LiveLinks } = env.api;
    env.route = () => response(429, { error: 'Too many requests' }, { 'Retry-After': '30' });
    assert.equal((await env.api.getShareLink()).live, false);
    env.route = () => response(201, { id: 'newLink', updatedAt: 42 });
    const link = await env.api.getShareLink();
    assert.equal(link.live, true);
    assert.equal(link.url, 'https://pp.test/tbc/newLink');
    assert.equal(LiveLinks.get(env.storage, LiveLinks.planKey(State)).id, 'newLink');
  });

  // ── S1: 429 back-off ────────────────────────────────────────────
  await check('A 429 on save backs off for Retry-After, then retries; it is not a rejection', async () => {
    const env = makeEnv();
    const planKey = seedLinkedPlan(env);
    let status = 429;
    env.route = () => (status === 429 ? response(429, { error: 'Too many requests' }, { 'Retry-After': '7' }) : response(200, { updatedAt: 321 }));
    edit(env, 'edit');
    await env.advance(2000); // the save goes out and is told to wait until +9s
    assert.equal(puts(env).length, 1);
    assert.equal(env.api.LiveSync.failed, true);
    assert.equal(env.api.LiveSync.rejected, null);
    status = 200;
    await env.advance(3000);
    await env.api.LiveSync.pull(); // 5s in: still backing off
    await settle();
    assert.equal(puts(env).length, 1, 'still backing off');
    await env.advance(5000); // past the back-off
    assert.equal(puts(env).length, 2);
    assert.equal(entryOf(env, planKey).updatedAt, 321);
    assert.equal(env.api.LiveSync.failed, false);
  });

  await check('A 429 without a Retry-After header backs off for 30s', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    let status = 429;
    env.route = () => (status === 429 ? response(429) : response(200, { updatedAt: 1 }));
    edit(env, 'edit');
    await env.advance(2000); // told to wait until +32s
    status = 200;
    await env.advance(25000);
    await env.api.LiveSync.pull();
    await settle();
    assert.equal(puts(env).length, 1, 'inside the back-off');
    await env.advance(6000);
    assert.equal(puts(env).length, 2);
  });

  await check('A 429 on the poll pauses polling for Retry-After', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = () => response(429, {}, { 'Retry-After': '10' });
    await env.api.LiveSync.pull();
    assert.equal(gets(env).length, 1);
    env.now += 5000;
    await env.api.LiveSync.pull();
    assert.equal(gets(env).length, 1, 'inside the back-off');
    env.now += 6000;
    env.route = () => response(200, { code: env.api.currentShareCode(), updatedAt: 100 });
    await env.api.LiveSync.pull();
    assert.equal(gets(env).length, 2, 'back-off over');
  });

  await check('The exit flush ignores back-off (the page is going away) and a success clears it', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.api.LiveSync.backoffUntil = env.now + 60000;
    env.route = () => response(200, { updatedAt: 9 });
    edit(env, 'edit');
    env.api.LiveSync.flushOnExit();
    await settle();
    assert.equal(puts(env).length, 1);
    assert.equal(env.api.LiveSync.backoffUntil, 0);
  });

  // ── timeoutSignal ───────────────────────────────────────────────
  await check('Requests carry a timeout signal', async () => {
    const env = makeEnv();
    seedLinkedPlan(env);
    env.route = call => response(200, call.method === 'GET' ? { code: 'abc', updatedAt: 1 } : { updatedAt: 1 });
    edit(env, 'edit');
    await env.advance(2000);
    await env.api.fetchLiveLink('aB3dE5g');
    assert(puts(env)[0].signal instanceof AbortSignal);
    assert(gets(env)[0].signal instanceof AbortSignal);
  });

  await check('timeoutSignal falls back to an AbortController timer when AbortSignal.timeout is missing', async () => {
    const timers = [];
    const fallback = app.sandbox(['timeoutSignal'], {
      globals: { AbortSignal: {}, AbortController, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; } },
    }).api.timeoutSignal;
    const signal = fallback(8000);
    assert.equal(signal.aborted, false);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 8000);
    timers[0].fn();
    assert.equal(signal.aborted, true, 'the timer aborts the request');

    const native = app.sandbox(['timeoutSignal'], { globals: { AbortSignal, AbortController, setTimeout } }).api.timeoutSignal(50);
    assert(native instanceof AbortSignal);

    const none = app.sandbox(['timeoutSignal'], { globals: { AbortSignal: undefined, AbortController: undefined, setTimeout } }).api.timeoutSignal(50);
    assert.equal(none, undefined, 'no timeout support at all: no signal rather than a crash');
  });

  await check('LiveLinks helpers: size limit mirrors the server, permanent statuses and Retry-After parsing', async () => {
    const { LiveLinks } = makeEnv().api;
    assert.equal(LiveLinks.maxCodeLength, require('./api/share.js').MAX_CODE_LENGTH);
    assert.equal(LiveLinks.rejection('A'.repeat(LiveLinks.maxCodeLength)), null);
    assert.match(LiveLinks.rejection('A'.repeat(LiveLinks.maxCodeLength + 1)), /too large/);
    assert.equal(LiveLinks.rejection(undefined), null);
    for (const status of [400, 401, 403, 405, 413, 422]) assert.equal(LiveLinks.isPermanentFailure(status), true, String(status));
    for (const status of [200, 404, 408, 429, 500, 503]) assert.equal(LiveLinks.isPermanentFailure(status), false, String(status));
    assert.equal(LiveLinks.retryAfterMs('7'), 7000);
    assert.equal(LiveLinks.retryAfterMs(null), 30000);
    assert.equal(LiveLinks.retryAfterMs('soon'), 30000);
    assert.equal(LiveLinks.retryAfterMs('0'), 30000);
    assert.equal(LiveLinks.retryAfterMs('99999'), 300000, 'capped');
  });

  console.log(`\nLiveSync tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
