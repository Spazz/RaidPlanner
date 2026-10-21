/**
 * Raidsmith - guild raid plans in the database, client engine (js/plansync.js) tests
 * Run: node tests/planner/plansync-tests.js
 *
 * PlanDbLinks (the opening decision table), PlanDb (the saver of the open plan) and PlanPoll (the co-editing pull) run in a vm sandbox
 * with an injected fake fetch, fake clock and timers, a fake document/window and a memory storage, the way livesync-tests.js drives
 * LiveSync. Nothing here touches the real Worker: a tiny fake server answers plan-doc GET/PUT with revisions.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

const api = app.sandbox(['LiveLinks', 'PlanDbLinks', 'PlanDb', 'PlanPoll', 'createPlanDb', 'createPlanPoll', 'UserEditing'], { globals: { setTimeout, clearTimeout } }).api;
const { PlanDbLinks, createPlanDb, createPlanPoll, UserEditing } = api;

const PLAN_KEY = 'tbc|raid:r1';
const GID = 'g1';
const RID = 'r1';
const DOC_URL = `/api/guild/${GID}/raids/${RID}/plan-doc`;

function memoryStorage() {
  const data = {};
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
}

function response(status, body = {}, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, json: async () => body };
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

// A fresh world per test: clock, timers, storage, document and window listeners, and a fake server holding one raid's plan document.
function makeWorld({ hidden = false } = {}) {
  const w = {
    now: 1_000_000, timers: [], nextTimer: 1, calls: [], storage: memoryStorage(), elements: {}, dragging: false,
    server: { rev: 5, plan: { n: 0 } }, scripted: [], held: [], state: { n: 0, pad: '' },
    docListeners: {}, winListeners: {},
  };
  const listen = bucket => ({
    add: (type, fn) => { (bucket[type] ||= []).push(fn); },
    remove: (type, fn) => { bucket[type] = (bucket[type] || []).filter(f => f !== fn); },
  });
  const doc = listen(w.docListeners), win = listen(w.winListeners);
  w.doc = {
    hidden, activeElement: null,
    addEventListener: doc.add, removeEventListener: doc.remove,
    getElementById: id => w.elements[id] || null,
    querySelector: () => (w.dragging ? {} : null),
  };
  w.win = { addEventListener: win.add, removeEventListener: win.remove };
  w.emit = (scope, type) => (scope === 'doc' ? w.docListeners : w.winListeners)[type]?.slice().forEach(fn => fn());
  w.listenerCount = () => Object.values(w.docListeners).concat(Object.values(w.winListeners)).reduce((n, list) => n + list.length, 0);
  w.setTimeout = (fn, ms) => { const id = w.nextTimer++; w.timers.push({ id, at: w.now + ms, fn }); return id; };
  w.clearTimeout = id => { w.timers = w.timers.filter(t => t.id !== id); };
  w.advance = async ms => {
    const target = w.now + ms;
    for (;;) {
      const due = w.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      w.timers = w.timers.filter(t => t !== due);
      w.now = Math.max(w.now, due.at);
      due.fn();
      await settle();
    }
    w.now = target;
    await settle();
  };
  // The fake server: scripted responses first (each used once), else the real behaviour of plan-doc.
  w.route = call => {
    if (w.scripted.length) return w.scripted.shift();
    const url = new URL(call.url, 'https://pp.test');
    if (call.method === 'PUT') {
      if (call.body.baseRev !== w.server.rev) return response(409, { error: 'plan_conflict', rev: w.server.rev, plan: w.server.plan, schemaVersion: 1, updatedAt: 9, updatedBy: { name: 'Kim' } });
      w.server.rev++;
      w.server.plan = call.body.plan;
      return response(200, { rev: w.server.rev, unchanged: false, updatedAt: w.now });
    }
    const since = Number(url.searchParams.get('since'));
    if (since === w.server.rev) return response(200, { rev: w.server.rev, changed: false });
    return response(200, { rev: w.server.rev, changed: true, plan: w.server.plan, schemaVersion: 1, updatedAt: 9, updatedBy: { name: 'Kim' } });
  };
  w.fetch = (url, init = {}) => {
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, rawBody: init.body || null, keepalive: !!init.keepalive, credentials: init.credentials, at: w.now };
    w.calls.push(call);
    if (w.holding) return new Promise(resolve => w.held.push({ call, resolve: r => resolve(r || w.route(call)) }));
    const result = w.route(call);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  };
  w.capture = () => ({ planId: 'raid:r1', n: w.state.n, pad: w.state.pad });
  w.puts = () => w.calls.filter(c => c.method === 'PUT');
  w.gets = () => w.calls.filter(c => c.method === 'GET');
  return w;
}

function makeDb(w, callbacks = {}, extra = {}) {
  const events = { conflicts: [], permanents: [], saved: [], statuses: 0 };
  const db = createPlanDb({
    fetch: w.fetch, now: () => w.now, setTimeout: w.setTimeout, clearTimeout: w.clearTimeout, capture: w.capture, storage: w.storage,
    doc: w.doc, win: w.win, signal: () => undefined, schemaVersion: 1,
  });
  db.events = events;
  db.begin = (overrides = {}) => db.start({
    gid: GID, rid: RID, rev: 5, planKey: PLAN_KEY,
    onConflict: callbacks.onConflict || (remote => { events.conflicts.push(remote); return true; }),
    onPermanent: info => events.permanents.push(info),
    onSaved: info => events.saved.push(info),
    onStatus: () => { events.statuses++; },
    ...extra, ...overrides,
  });
  return db;
}

const edit = (w, db, n, pad) => { w.state.n = n; if (pad !== undefined) w.state.pad = pad; db.onRender(); };

function makePoll(w, overrides = {}) {
  const received = [];
  const failures = [];
  const poll = createPlanPoll({
    fetch: w.fetch, now: () => w.now, setTimeout: w.setTimeout, clearTimeout: w.clearTimeout, doc: w.doc, signal: () => undefined,
    saving: () => false, ...overrides,
  });
  poll.received = received;
  poll.failures = failures;
  poll.begin = (extra = {}) => poll.start({ gid: GID, rid: RID, rev: 5, onPlan: update => { received.push(update); return true; }, onFailure: f => failures.push(f), ...extra });
  return poll;
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

(async () => {
  // ── PlanDbLinks ───────────────────────────────────────────────
  await check('the opening decision table: every row of plan section 4', () => {
    const clean = { gid: GID, rid: RID, rev: 5, dirty: false };
    const dirty = { ...clean, dirty: true };
    const d = args => PlanDbLinks.decide(args);
    assert.equal(d({ binding: clean, remoteRev: 5 }), 'use-db', 'equal rev, clean');
    assert.equal(d({ binding: dirty, remoteRev: 5 }), 'push-local', 'equal rev, dirty');
    assert.equal(d({ binding: clean, remoteRev: 7 }), 'use-db', 'DB newer, clean');
    assert.equal(d({ binding: dirty, remoteRev: 7 }), 'use-db-with-undo', 'DB newer, dirty');
    assert.equal(d({ binding: null, remoteRev: 7, localDiffers: true }), 'use-db-save-copy', 'unbound different copy');
    assert.equal(d({ binding: null, remoteRev: 7, localDiffers: false }), 'use-db', 'unbound identical copy');
    assert.equal(d({ binding: null, remoteRev: 7 }), 'use-db-save-copy', 'unbound, nothing said: keep the copy');
    assert.equal(d({ binding: clean, remoteRev: 0 }), 'migrate', 'the server holds no plan yet');
    assert.equal(d({ binding: null, remoteRev: 0 }), 'migrate');
    assert.equal(d({ binding: { gid: GID, rid: RID, rev: 'x', dirty: true }, remoteRev: 7, localDiffers: false }), 'use-db', 'a malformed binding is no binding');
    assert.equal(d({ binding: dirty, remoteRev: 3 }), 'use-db-with-undo', 'the server was reset below this browser: its plan still wins');
  });

  await check('PlanDbLinks bind / markSaved / markDirty / forget / dirtyKeys', () => {
    const s = memoryStorage();
    assert.equal(PlanDbLinks.get(s, PLAN_KEY), null);
    PlanDbLinks.bind(s, PLAN_KEY, { gid: GID, rid: RID, rev: 5 });
    assert.deepEqual({ ...PlanDbLinks.get(s, PLAN_KEY) }, { gid: GID, rid: RID, rev: 5, dirty: false, touchedAt: PlanDbLinks.get(s, PLAN_KEY).touchedAt });
    assert.deepEqual([...PlanDbLinks.dirtyKeys(s)], []);
    PlanDbLinks.markDirty(s, PLAN_KEY);
    assert.deepEqual([...PlanDbLinks.dirtyKeys(s)], [PLAN_KEY]);
    PlanDbLinks.markSaved(s, PLAN_KEY, 6);
    assert.equal(PlanDbLinks.get(s, PLAN_KEY).rev, 6);
    assert.equal(PlanDbLinks.get(s, PLAN_KEY).dirty, false);
    PlanDbLinks.markSaved(s, PLAN_KEY, 7, { dirty: true });
    assert.equal(PlanDbLinks.get(s, PLAN_KEY).dirty, true);
    assert.equal(PlanDbLinks.markDirty(s, 'tbc|plan:unbound'), null, 'an unbound plan is never marked');
    assert.equal(PlanDbLinks.forget(s, PLAN_KEY), true);
    assert.equal(PlanDbLinks.forget(s, PLAN_KEY), false);
    assert.equal(PlanDbLinks.get(s, PLAN_KEY), null);
  });

  await check('PlanDbLinks ignores malformed entries and unreadable storage', () => {
    const s = memoryStorage();
    s.setItem('pp_plan_db', JSON.stringify({ a: { gid: 'g', rid: 'r', rev: 1, dirty: true }, b: { gid: 'g', rid: 'r', rev: -1, dirty: true }, c: 'x', d: { gid: '', rid: 'r', rev: 1, dirty: true } }));
    assert.deepEqual([...PlanDbLinks.dirtyKeys(s)], ['a']);
    s.setItem('pp_plan_db', '{broken');
    assert.deepEqual({ ...PlanDbLinks.read(s) }, {});
    assert.equal(PlanDbLinks.get(s, 'a'), null);
    s.setItem('pp_plan_db', '[1]');
    assert.deepEqual({ ...PlanDbLinks.read(s) }, {});
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    assert.doesNotThrow(() => PlanDbLinks.bind(full, PLAN_KEY, { gid: GID, rid: RID, rev: 1 }));
  });

  await check('PlanDbLinks.bind keeps the cap by dropping the least recently touched clean bindings, never a dirty one', () => {
    const s = memoryStorage();
    const map = {};
    for (let i = 0; i < 100; i++) map['tbc|raid:' + i] = { gid: GID, rid: 'r' + i, rev: 1, dirty: i === 0, touchedAt: 1000 + i };
    s.setItem('pp_plan_db', JSON.stringify(map));
    PlanDbLinks.bind(s, 'tbc|raid:new', { gid: GID, rid: 'rnew', rev: 1 });
    const after = PlanDbLinks.read(s);
    assert.equal(Object.keys(after).length, 100);
    assert(after['tbc|raid:new'] && after['tbc|raid:0'], 'the new and the dirty binding stay');
    assert(!after['tbc|raid:1'], 'the oldest clean one went');
  });

  // ── PlanDb: saving ────────────────────────────────────────────
  await check('start binds the plan, an unchanged plan sends nothing, an edit goes out after the 1.5 s debounce', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).rev, 5);
    db.onRender();
    await w.advance(10000);
    assert.equal(w.puts().length, 0, 'nothing changed');
    edit(w, db, 1);
    await w.advance(1499);
    assert.equal(w.puts().length, 0);
    await w.advance(1);
    assert.equal(w.puts().length, 1);
    const put = w.puts()[0];
    assert.equal(put.url, DOC_URL);
    assert.equal(put.credentials, 'include');
    assert.equal(put.body.baseRev, 5);
    assert.equal(put.body.schemaVersion, 1);
    assert.deepEqual(put.body.plan, { planId: 'raid:r1', n: 1, pad: '' });
    assert.equal(put.keepalive, false);
  });

  await check('every edit restarts the debounce', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1); await w.advance(1000);
    edit(w, db, 2); await w.advance(1000);
    edit(w, db, 3); await w.advance(1499);
    assert.equal(w.puts().length, 0);
    await w.advance(1);
    assert.equal(w.puts().length, 1);
    assert.equal(w.puts()[0].body.plan.n, 3, 'the latest state is what goes out');
  });

  await check('a save advances the revision, marks the binding clean and reports it', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true, 'dirty from the first edit on (protected from eviction)');
    await w.advance(1500);
    assert.equal(db.rev(), 6);
    const link = PlanDbLinks.get(w.storage, PLAN_KEY);
    assert.equal(link.rev, 6);
    assert.equal(link.dirty, false);
    assert.equal(db.events.saved.length, 1);
    assert.equal(db.events.saved[0].rev, 6);
    assert.equal(db.busy(), false);
    assert.equal(db.savedAt(), w.now);
  });

  await check('an edit that goes back to the saved state sends nothing and clears the dirty flag', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1); assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true);
    edit(w, db, 0);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, false);
    await w.advance(5000);
    assert.equal(w.puts().length, 0);
  });

  await check('PUTs start at least 3 s apart even when edits keep arriving', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1); await w.advance(1500);
    const first = w.puts()[0].at;
    edit(w, db, 2); await w.advance(1500);
    assert.equal(w.puts().length, 1, 'the debounce alone would have fired; the gap holds it');
    await w.advance(1500);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].at - first, 3000);
    assert.equal(w.puts()[1].body.baseRev, 6);
  });

  await check('one request in flight: an edit during the flight waits for the response and then gets its own PUT', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.holding = true;
    edit(w, db, 1); await w.advance(1500);
    assert.equal(w.puts().length, 1);
    edit(w, db, 2); await w.advance(20000);
    assert.equal(w.puts().length, 1, 'still one: the first has not returned');
    assert.equal(db.busy(), true);
    w.holding = false;
    w.held.shift().resolve();
    await settle();
    assert.equal(db.rev(), 6);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true, 'the later edit is still unsent');
    await w.advance(1500);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].body.baseRev, 6);
    assert.equal(w.puts()[1].body.plan.n, 2);
    assert.equal(db.busy(), false);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, false);
  });

  await check('a response with unchanged:true counts as saved', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(response(200, { rev: 5, unchanged: true, updatedAt: 1 }));
    edit(w, db, 1); await w.advance(1500);
    assert.equal(db.rev(), 5);
    assert.equal(db.busy(), false);
    assert.equal(db.events.saved[0].unchanged, true);
  });

  await check('start with dirty:true sends the unsent edits at once and keeps the binding dirty until acknowledged', async () => {
    const w = makeWorld(); const db = makeDb(w);
    w.state.n = 4;
    db.begin({ dirty: true });
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true);
    await w.advance(0);
    assert.equal(w.puts().length, 1);
    assert.equal(w.puts()[0].body.plan.n, 4);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, false);
  });

  await check('adopt(rev) makes what is on screen the new baseline', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    w.state.n = 9; // the remote plan was applied to the screen
    db.adopt(8);
    assert.equal(db.rev(), 8);
    assert.equal(db.busy(), false);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).rev, 8);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, false);
    await w.advance(10000);
    assert.equal(w.puts().length, 0);
  });

  // ── PlanDb: 409 ───────────────────────────────────────────────
  await check('409: the server doc goes to the merge callback; once applied there is no further PUT', async () => {
    const w = makeWorld();
    const db = makeDb(w, { onConflict: remote => { db.events.conflicts.push(remote); w.state.n = remote.plan.n; return true; } });
    db.begin();
    w.server.rev = 7; w.server.plan = { planId: 'raid:r1', n: 70, pad: '' };
    edit(w, db, 1); await w.advance(1500);
    assert.equal(w.puts().length, 1);
    assert.equal(db.events.conflicts.length, 1);
    const remote = db.events.conflicts[0];
    assert.equal(remote.rev, 7);
    assert.deepEqual(remote.plan, { planId: 'raid:r1', n: 70, pad: '' });
    assert.deepEqual({ ...remote.updatedBy }, { name: 'Kim' });
    await w.advance(60000);
    assert.equal(w.puts().length, 1, 'newest plan wins: the local edit is not pushed over it');
    assert.equal(db.rev(), 7);
    assert.equal(db.busy(), false);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).rev, 7);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, false);
  });

  await check('409 with Undo: the local state restored after the merge goes out as a new revision', async () => {
    const w = makeWorld();
    const local = { n: 0 };
    const db = makeDb(w, { onConflict: remote => { local.n = w.state.n; w.state.n = remote.plan.n; return true; } });
    db.begin();
    w.server.rev = 7; w.server.plan = { planId: 'raid:r1', n: 70, pad: '' };
    edit(w, db, 1); await w.advance(1500);
    w.state.n = local.n; db.onRender(); // Undo
    await w.advance(3000);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].body.baseRev, 7);
    assert.equal(w.puts()[1].body.plan.n, 1);
  });

  await check('409 the merge callback declined: the local plan goes out again on top of the server revision', async () => {
    const w = makeWorld(); const db = makeDb(w, { onConflict: () => false }); db.begin();
    w.server.rev = 7; w.server.plan = { planId: 'raid:r1', n: 70, pad: '' };
    edit(w, db, 1); await w.advance(1500);
    await w.advance(3000);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].body.baseRev, 7);
    assert.equal(w.server.plan.n, 1);
    assert.equal(db.rev(), 8);
  });

  await check('409 for a document that is gone (rev 0, no plan): this plan recreates it', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.server.rev = 0; w.server.plan = null;
    w.scripted.push(response(409, { error: 'plan_conflict', rev: 0, plan: null }));
    edit(w, db, 1); await w.advance(1500);
    await w.advance(3000);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].body.baseRev, 0);
    assert.equal(db.rev(), 1);
    assert.equal(db.events.conflicts.length, 0, 'nothing to merge');
  });

  // ── PlanDb: failures ──────────────────────────────────────────
  await check('transient failures retry after 2, 4, 8, 16, 30, 30 s (never inside the 3 s gap) and a success starts over', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    for (let i = 0; i < 6; i++) w.scripted.push(response(500, {}));
    edit(w, db, 1); await w.advance(1500);
    const starts = () => w.puts().map(c => c.at - w.puts()[0].at);
    assert.deepEqual(starts(), [0]);
    for (const [gap, count] of [[3000, 2], [4000, 3], [8000, 4], [16000, 5], [30000, 6], [30000, 7]]) {
      await w.advance(gap - 1);
      assert.equal(w.puts().length, count - 1, `no retry ${count} before ${gap} ms`);
      await w.advance(1);
      assert.equal(w.puts().length, count);
    }
    assert.deepEqual(starts(), [0, 3000, 7000, 15000, 31000, 61000, 91000]);
    assert.equal(db.rev(), 6, 'the seventh attempt got through');
    assert.equal(db.statusText('x'), 'Saved to the raid');
    edit(w, db, 2); w.scripted.push(response(503, {}));
    await w.advance(3000);
    assert.equal(w.puts().length, 8, 'the edit went out once the 3 s gap allowed it');
    await w.advance(3000);
    assert.equal(w.puts().length, 9, 'and its retry came at the 3 s gap (the 2 s backoff began again)');
  });

  await check('a network error is transient too', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(new Error('offline'));
    edit(w, db, 1); await w.advance(1500);
    assert.equal(db.statusKey(), 'retrying');
    assert.equal(db.events.permanents.length, 0);
    await w.advance(3000);
    assert.equal(w.puts().length, 2);
    assert.equal(db.statusKey(), 'saved');
  });

  await check('429 waits for Retry-After before the next PUT', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(response(429, { error: 'rate_limited' }, { 'Retry-After': '20' }));
    edit(w, db, 1); await w.advance(1500);
    assert.equal(w.puts().length, 1);
    await w.advance(19999);
    assert.equal(w.puts().length, 1);
    await w.advance(1);
    assert.equal(w.puts().length, 2);
    assert.equal(w.puts()[1].at - w.puts()[0].at, 20000);
    assert.equal(db.rev(), 6);
  });

  await check('429 without a usable Retry-After backs off 30 s', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(response(429, {}));
    edit(w, db, 1); await w.advance(1500);
    await w.advance(29999);
    assert.equal(w.puts().length, 1);
    await w.advance(1);
    assert.equal(w.puts().length, 2);
  });

  await check('going back online or returning to the tab retries a failed save now (still 3 s after the last start)', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(response(500, {}), response(500, {}));
    edit(w, db, 1); await w.advance(1500);
    assert.equal(w.puts().length, 1);
    await w.advance(1000);
    w.emit('win', 'online'); await w.advance(0);
    assert.equal(w.puts().length, 1, 'inside the minimum gap');
    await w.advance(1999);
    assert.equal(w.puts().length, 1);
    await w.advance(1);
    assert.equal(w.puts().length, 2, 'online retried at the 3 s mark, not the 2 s of the backoff');
    // second failure: backoff is now 4 s; visibilitychange (visible) brings it forward to the gap
    await w.advance(3000);
    w.emit('doc', 'visibilitychange');
    await w.advance(0);
    assert.equal(w.puts().length, 3, 'the gap has passed, so visible retries immediately');
    assert.equal(db.rev(), 6);
  });

  await check('online does nothing for a plan that has no failed save', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    w.emit('win', 'online'); await w.advance(1499);
    assert.equal(w.puts().length, 0, 'the debounce still decides');
    await w.advance(1);
    assert.equal(w.puts().length, 1);
  });

  for (const [status, kind] of [[400, 'invalid'], [401, 'signed-out'], [403, 'forbidden'], [404, 'gone'], [413, 'too-large']]) {
    await check(`permanent failure ${status}: stops, reports "${kind}", never retries and leaves the edits marked dirty`, async () => {
      const w = makeWorld(); const db = makeDb(w); db.begin();
      w.scripted.push(response(status, { error: 'x', message: 'Because.' }));
      edit(w, db, 1); await w.advance(1500);
      assert.equal(db.events.permanents.length, 1);
      assert.equal(db.events.permanents[0].kind, kind);
      assert.equal(db.events.permanents[0].status, status);
      assert.equal(db.events.permanents[0].message, 'Because.');
      assert.equal(db.statusKey(), kind);
      assert.equal(db.failure().kind, kind);
      edit(w, db, 2);
      w.emit('win', 'online');
      await w.advance(120000);
      assert.equal(w.puts().length, 1, 'no retry, no new PUT');
      assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true);
      assert.equal(db.busy(), false, 'a stopped saver does not hold the poll');
      assert.equal(db.events.permanents.length, 1);
    });
  }

  await check('other 4xx (not 408/429) are permanent "refused"; 408 is transient', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.scripted.push(response(408, {}));
    edit(w, db, 1); await w.advance(1500);
    assert.equal(db.events.permanents.length, 0);
    w.scripted.push(response(422, {}));
    await w.advance(3000);
    assert.equal(db.events.permanents[0].kind, 'refused');
  });

  await check('status strings are the ones of plan section 4', async () => {
    const w = makeWorld(); const db = makeDb(w);
    assert.equal(db.statusText('Saved on this device'), 'Saved on this device', 'not started: the fallback');
    db.begin();
    assert.equal(db.statusText('x'), 'Saved to the raid');
    edit(w, db, 1);
    assert.equal(db.statusText('x'), 'Saving to the raid...');
    w.scripted.push(response(500, {}));
    await w.advance(1500);
    assert.equal(db.statusText('x'), 'Not saved to the raid yet, retrying. Your changes are safe on this device.');
    await w.advance(3000);
    assert.equal(db.statusText('x'), 'Saved to the raid');
    w.scripted.push(response(403, {}));
    edit(w, db, 2); await w.advance(3000);
    assert.match(db.statusText('x'), /^Not saved to the raid: you can no longer edit it\. Your changes are safe on this device\.$/);
    db.stop();
    assert.equal(db.statusText('Saved on this device'), 'Saved on this device', 'stopped: the fallback again');
  });

  await check('onStatus fires when the state changes', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    const base = db.events.statuses;
    edit(w, db, 1);
    assert(db.events.statuses > base, 'saving');
    const mid = db.events.statuses;
    await w.advance(1500);
    assert(db.events.statuses > mid, 'saved');
  });

  // ── PlanDb: leaving the page ──────────────────────────────────
  await check('pagehide sends a small waiting save at once with keepalive', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    w.emit('win', 'pagehide'); await settle();
    assert.equal(w.puts().length, 1);
    assert.equal(w.puts()[0].keepalive, true);
    assert.equal(w.puts()[0].body.plan.n, 1);
    assert.equal(w.puts()[0].at, w.now, 'no debounce');
  });

  await check('the tab being hidden flushes the same way; nothing waiting sends nothing', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.doc.hidden = true;
    w.emit('doc', 'visibilitychange'); await settle();
    assert.equal(w.puts().length, 0);
    edit(w, db, 1);
    w.emit('doc', 'visibilitychange'); await settle();
    assert.equal(w.puts().length, 1);
    assert.equal(w.puts()[0].keepalive, true);
  });

  await check('pagehide with a body of 60 KB or more sends nothing and leaves the plan dirty', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1, 'x'.repeat(61 * 1024));
    w.emit('win', 'pagehide'); await settle();
    assert.equal(w.puts().length, 0);
    assert.equal(PlanDbLinks.get(w.storage, PLAN_KEY).dirty, true);
    // just under the limit still goes
    const w2 = makeWorld(); const db2 = makeDb(w2); db2.begin();
    edit(w2, db2, 1, 'x'.repeat(59 * 1024));
    w2.emit('win', 'pagehide'); await settle();
    assert.equal(w2.puts().length, 1);
  });

  await check('the 60 KB rule counts bytes, not characters', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1, 'é'.repeat(31 * 1024)); // 31 K characters, 62 K bytes
    w.emit('win', 'pagehide'); await settle();
    assert.equal(w.puts().length, 0);
  });

  await check('pagehide while a request is in flight or a 429 backoff runs sends nothing extra', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    w.holding = true;
    edit(w, db, 1); await w.advance(1500);
    edit(w, db, 2);
    w.emit('win', 'pagehide'); await settle();
    assert.equal(w.puts().length, 1);
    const w2 = makeWorld(); const db2 = makeDb(w2); db2.begin();
    w2.scripted.push(response(429, {}, { 'Retry-After': '30' }));
    edit(w2, db2, 1); await w2.advance(1500);
    edit(w2, db2, 2);
    w2.emit('win', 'pagehide'); await settle();
    assert.equal(w2.puts().length, 1);
  });

  await check('stop() ends the timers, removes the listeners and ignores a response that arrives later', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    assert(w.listenerCount() > 0);
    w.holding = true;
    edit(w, db, 1); await w.advance(1500);
    db.stop();
    assert.equal(w.listenerCount(), 0);
    assert.equal(db.active(), false);
    w.holding = false;
    w.held.shift().resolve();
    await settle();
    assert.equal(db.events.saved.length, 0);
    edit(w, db, 2);
    await w.advance(60000);
    assert.equal(w.puts().length, 1);
    assert.equal(w.timers.length, 0);
    assert.equal(db.rev(), null);
  });

  await check('start again replaces the previous plan (its listeners and timers are gone)', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    const listeners = w.listenerCount();
    db.begin({ rid: 'r2', planKey: 'tbc|raid:r2', rev: 2 });
    assert.equal(w.listenerCount(), listeners);
    assert.equal(w.timers.length, 0, 'the old debounce is cancelled');
    assert.equal(db.rev(), 2);
  });

  await check('settle() resolves true once the server holds the screen, false for a stopped saver', async () => {
    const w = makeWorld(); const db = makeDb(w); db.begin();
    edit(w, db, 1);
    let result = null;
    const pending = db.settle().then(r => { result = r; });
    await w.advance(500);
    await pending;
    assert.equal(result, true);
    assert.equal(w.puts().length, 1, 'settle skipped the debounce');
    const w2 = makeWorld(); const db2 = makeDb(w2); db2.begin();
    w2.scripted.push(response(403, {}));
    edit(w2, db2, 1);
    const p2 = db2.settle();
    await w2.advance(500);
    assert.equal(await p2, false);
  });

  await check('the app instance and the factory defaults exist but do nothing before start', () => {
    assert.equal(api.PlanDb.active(), false);
    assert.equal(api.PlanDb.busy(), false);
    assert.equal(api.PlanDb.statusText('Saved on this device'), 'Saved on this device');
    assert.doesNotThrow(() => api.PlanDb.onRender());
    assert.doesNotThrow(() => api.PlanDb.stop());
    assert.equal(api.PlanPoll.active(), false);
    assert.throws(() => createPlanDb({ capture: () => ({}) }).start({}), /needs gid/);
  });

  // ── PlanPoll ──────────────────────────────────────────────────
  await check('poll cadence: 4 s while active, 10 s after 5 quiet polls, 30 s after 20', async () => {
    const w = makeWorld(); const poll = makePoll(w);
    assert.deepEqual([0, 4, 5, 19, 20, 99].map(q => poll.intervalMs(q)), [4000, 4000, 10000, 10000, 30000, 30000]);
    w.server.rev = 5;
    poll.begin();
    await w.advance(3999);
    assert.equal(w.gets().length, 0);
    await w.advance(1);
    assert.equal(w.gets().length, 1);
    await w.advance(4000 * 4 + 10000 * 2);
    assert.deepEqual(w.gets().map(c => c.at - 1_000_000), [4000, 8000, 12000, 16000, 20000, 30000, 40000]);
    await w.advance(10000 * 13);
    const gaps = w.gets().map(c => c.at).map((at, i, list) => (i ? at - list[i - 1] : 0));
    assert.equal(gaps[gaps.length - 1], 10000);
    await w.advance(10000);
    await w.advance(30000);
    const later = w.gets().map(c => c.at);
    assert.equal(later[later.length - 1] - later[later.length - 2], 30000, 'idle tabs poll every 30 s');
  });

  await check('a poll asks since=<rev>; the same revision is a quiet poll and calls nothing', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    await w.advance(4000);
    assert.equal(w.gets()[0].url, `${DOC_URL}?since=5`);
    assert.equal(w.gets()[0].credentials, 'include');
    assert.equal(poll.received.length, 0);
    assert.equal(poll.quiet(), 1);
  });

  await check('a newer revision is delivered as {rev, plan, updatedBy}, advances the poll and returns the cadence to 4 s', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    await w.advance(4000 * 5);
    assert.equal(poll.quiet(), 5);
    w.server.rev = 8; w.server.plan = { planId: 'raid:r1', n: 80 };
    await w.advance(10000);
    assert.equal(poll.received.length, 1);
    assert.equal(poll.received[0].rev, 8);
    assert.deepEqual(poll.received[0].plan, { planId: 'raid:r1', n: 80 });
    assert.deepEqual({ ...poll.received[0].updatedBy }, { name: 'Kim' });
    assert.equal(poll.rev(), 8);
    assert.equal(poll.quiet(), 0);
    const last = w.gets().length;
    await w.advance(4000);
    assert.equal(w.gets().length, last + 1);
    assert.match(w.gets()[w.gets().length - 1].url, /since=8$/);
    assert.equal(poll.received.length, 1, 'not delivered twice');
  });

  await check('setRev (our own save) keeps the poll from delivering our own revision back', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    w.server.rev = 6; w.server.plan = { n: 1 };
    poll.setRev(6);
    await w.advance(4000);
    assert.equal(poll.received.length, 0);
    poll.setRev(3);
    assert.equal(poll.rev(), 6, 'never goes backwards');
    // an answer for a revision at or below ours (a poll that left before our save) is ignored too
    w.scripted.push(response(200, { rev: 6, changed: true, plan: { n: 1 }, updatedBy: null }));
    await w.advance(4000);
    assert.equal(poll.received.length, 0);
  });

  await check('onPlan returning false leaves the revision alone, so the plan is offered again', async () => {
    const w = makeWorld(); const poll = makePoll(w);
    let answers = [false, true];
    poll.begin({ onPlan: update => { poll.received.push(update); return answers.shift(); } });
    w.server.rev = 8; w.server.plan = { n: 80 };
    await w.advance(4000);
    assert.equal(poll.rev(), 5);
    await w.advance(4000);
    assert.equal(poll.received.length, 2);
    assert.equal(poll.rev(), 8);
  });

  await check('hidden: no polling; coming back pulls at once and restarts the fast cadence', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    await w.advance(4000 * 6);
    const before = w.gets().length;
    w.doc.hidden = true;
    w.emit('doc', 'visibilitychange');
    await w.advance(120000);
    assert.equal(w.gets().length, before, 'paused');
    w.server.rev = 9; w.server.plan = { n: 90 };
    w.doc.hidden = false;
    w.emit('doc', 'visibilitychange');
    await w.advance(0);
    assert.equal(w.gets().length, before + 1, 'immediate pull');
    assert.equal(poll.received.length, 1);
    assert.equal(poll.quiet(), 0);
  });

  await check('a poll that is due while the tab is hidden does not reschedule itself', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    w.doc.hidden = true; // no visibilitychange emitted: the timer is still armed
    await w.advance(4000);
    assert.equal(w.gets().length, 0);
    await w.advance(60000);
    assert.equal(w.gets().length, 0);
  });

  await check('skipped while a save is pending or in flight, during a drag, and while the user is in the editor, picker or notes', async () => {
    const w = makeWorld();
    let saving = false;
    const poll = makePoll(w, { saving: () => saving }); poll.begin();
    w.server.rev = 8; w.server.plan = { n: 80 };
    saving = true; await w.advance(4000 * 3);
    assert.equal(w.gets().length, 0, 'saving');
    saving = false; w.dragging = true; await w.advance(4000 * 3);
    assert.equal(w.gets().length, 0, 'dragging');
    w.dragging = false; w.elements['active-player-editor'] = {}; await w.advance(4000 * 3);
    assert.equal(w.gets().length, 0, 'player editor open');
    delete w.elements['active-player-editor']; w.elements['active-buff-picker'] = {}; await w.advance(4000);
    assert.equal(w.gets().length, 0, 'buff picker open');
    delete w.elements['active-buff-picker'];
    w.elements['raid-notes-textarea'] = {}; w.doc.activeElement = w.elements['raid-notes-textarea']; await w.advance(4000);
    assert.equal(w.gets().length, 0, 'notes focused');
    w.doc.activeElement = null; await w.advance(4000);
    assert.equal(w.gets().length, 1);
    assert.equal(poll.received.length, 1);
    assert.equal(poll.quiet(), 0, 'skips never widened the cadence');
  });

  await check('the busy checks run again after the answer arrives: a plan is not applied under a user who just started editing', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    w.server.rev = 8; w.server.plan = { n: 80 };
    w.holding = true;
    await w.advance(4000);
    assert.equal(w.gets().length, 1);
    w.elements['active-player-editor'] = {};
    w.holding = false;
    w.held.shift().resolve();
    await settle();
    assert.equal(poll.received.length, 0);
    assert.equal(poll.rev(), 5);
    delete w.elements['active-player-editor'];
    await w.advance(4000);
    assert.equal(poll.received.length, 1, 'delivered on the next poll');
  });

  await check('poll 429 waits for Retry-After; a 5xx or network error keeps polling', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    w.scripted.push(response(429, {}, { 'Retry-After': '25' }));
    await w.advance(4000);
    assert.equal(w.gets().length, 1);
    await w.advance(4000 * 5);
    assert.equal(w.gets().length, 1, 'inside the Retry-After window');
    await w.advance(8000);
    assert.equal(w.gets().length, 2);
    w.scripted.push(response(500, {}), new Error('offline'));
    await w.advance(4000 * 2);
    assert.equal(w.gets().length, 4);
    assert.equal(poll.active(), true);
    assert.equal(poll.failures.length, 0);
  });

  for (const [status, kind] of [[401, 'signed-out'], [403, 'forbidden'], [404, 'gone']]) {
    await check(`poll ${status}: stops polling and reports "${kind}"`, async () => {
      const w = makeWorld(); const poll = makePoll(w); poll.begin();
      w.scripted.push(response(status, {}));
      await w.advance(4000);
      assert.deepEqual(poll.failures.map(f => ({ ...f })), [{ kind, status }]);
      assert.equal(poll.active(), false);
      await w.advance(120000);
      assert.equal(w.gets().length, 1);
      assert.equal(w.listenerCount(), 0);
    });
  }

  await check('PlanPoll.wake brings a slow poll forward but never postpones one', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    await w.advance(4000 * 5 + 10000 * 3);
    assert.equal(poll.quiet(), 8);
    const before = w.gets().length;
    poll.wake();
    assert.equal(poll.quiet(), 0);
    await w.advance(4000);
    assert.equal(w.gets().length, before + 1);
    poll.wake(); await w.advance(3000); poll.wake(); await w.advance(3000);
    assert.equal(w.gets().length, before + 2, 'a fast timer is left alone by repeated wakes');
  });

  await check('PlanPoll.stop clears the timer and the listener; start validates its input', async () => {
    const w = makeWorld(); const poll = makePoll(w); poll.begin();
    assert.equal(w.listenerCount(), 1);
    poll.stop();
    assert.equal(w.listenerCount(), 0);
    assert.equal(w.timers.length, 0);
    await w.advance(60000);
    assert.equal(w.gets().length, 0);
    assert.throws(() => poll.start({ gid: GID }), /needs gid/);
  });

  // ── the shared editing() check ────────────────────────────────
  await check('UserEditing.active is true for the player editor, the buff picker and a focused notes field only', () => {
    const w = makeWorld();
    assert.equal(UserEditing.active(w.doc), false);
    w.elements['active-player-editor'] = {};
    assert.equal(UserEditing.active(w.doc), true);
    delete w.elements['active-player-editor'];
    w.elements['active-buff-picker'] = {};
    assert.equal(UserEditing.active(w.doc), true);
    delete w.elements['active-buff-picker'];
    w.elements['raid-notes-textarea'] = {};
    assert.equal(UserEditing.active(w.doc), false, 'notes present but not focused');
    w.doc.activeElement = w.elements['raid-notes-textarea'];
    assert.equal(UserEditing.active(w.doc), true);
  });

  // ── page wiring pins ──────────────────────────────────────────
  await check('index.html loads js/plansync.js right after js/livesync.js, before app.js', () => {
    const order = [...app.html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    const at = order.indexOf('/js/plansync.js');
    assert(at > 0, 'plansync.js is loaded');
    assert.equal(order[at - 1], '/js/livesync.js');
    assert(at < order.indexOf('/js/app.js'));
    assert.equal(order.filter(src => src === '/js/plansync.js').length, 1);
  });

  await check('plansync.js is whitelisted by .gitignore', () => {
    const ignore = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '.gitignore'), 'utf8');
    assert(/^!js\/plansync\.js\r?$/m.test(ignore));
  });

  await check('LiveSync.editing and PlanPoll share UserEditing; nothing in app.js reads the editor ids any more', () => {
    assert(/editing\(\) \{\s*return UserEditing\.active\(document\);\s*\}/.test(app.script));
    const body = app.script.slice(app.script.indexOf('const UserEditing'), app.script.indexOf('const UserEditing') + 400);
    assert(body.includes('active-player-editor') && body.includes('active-buff-picker') && body.includes('raid-notes-textarea'));
  });

  console.log(`\nPlan sync tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
