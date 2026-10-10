/**
 * PartyPlanner Web - Plan state tests (Phase 2, group G3)
 * Run: node plan-state-tests.js
 *
 * #7  PlanStore: entries that fail validation are kept, schemaVersion + migrate(),
 *     cap by updatedAt that spares the current and live-bound plans, evict-and-retry
 *     on quota errors, debounced writes. F7: Templates.write goes through safeSetItem.
 * #8  Applying a live-link update keeps player identities and totem/aura picks, and
 *     waits while the player editor, buff picker or notes field is in use.
 * U7  A second tab saving the open plan raises a banner.
 * U8  A persistent "updated by someone else" banner with Undo; manual-copy dialog when
 *     the clipboard write fails.
 *
 * The logic half runs in a vm sandbox; the UI-half pieces (persistWorkingPlan, copyText,
 * TabWatch, RemoteUpdate, LiveSync) are sliced in next to it with a fake DOM, fake clock
 * and fake timers, the same way livesync-tests.js does.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./tests/load-app');

const LIVE_SOURCE = app.slice('const SHARE_API', "document.getElementById('btn-share')");
const SAVE_SOURCE = app.slice('// Toolbar mirror of the header autosave-status line', "// The phone's context row");
const CLIPBOARD_SOURCE = app.slice('// ── CLIPBOARD', '// ── VERSION AUTO-DETECT');
const TAB_SOURCE = app.slice('const TabWatch = {', "document.getElementById('btn-tab-load')");

const STUBS = `
var dragData = null;
function showToast(message) { __env.toasts.push(message); }
function commit() { __env.renders++; persistWorkingPlan(); }
function hasLoadedWork() { return State.roster.length > 0; }
function rememberImport() { return ''; }
function initGroups() { __env.inits++; }
function closePlayerEditor() { __env.closed.push('editor'); }
function closeBuffPicker() { __env.closed.push('picker'); }
function renderLastRun() {}
function renderPhoneSummary() {}
var confirm = () => true;
`;

const NAMES = ['Import', 'State', 'LiveLinks', 'LiveSync', 'PlanStore', 'PlanSession', 'LocalPicks', 'Templates', 'DataBackup',
  'RemoteUpdate', 'TabWatch', 'persistWorkingPlan', 'showSaveOutcome', 'copyText', 'showManualCopy', 'currentShareCode', 'safeSetItem', 'ChangeLog'];

function memoryStorage({ limit = Infinity, failWith = null } = {}) {
  const data = {};
  return {
    data, limit, failWith,
    getItem(k) { return k in data ? data[k] : null; },
    setItem(k, v) {
      if (this.failWith) throw this.failWith;
      if (String(v).length > this.limit) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      data[k] = String(v);
    },
    removeItem(k) { delete data[k]; },
  };
}

// An element the code under test can touch.
function fakeElement(id) {
  return {
    id, hidden: id.endsWith('-banner'), textContent: '', value: '', disabled: false, dataset: {}, shown: 0, selected: 0, onclick: null,
    addEventListener() {}, showModal() { this.shown++; }, close() { this.shown = 0; }, focus() {}, select() { this.selected++; },
  };
}

// Only these exist while the user is working in them.
const TRANSIENT = ['active-player-editor', 'active-buff-picker'];

function makeEnv() {
  const env = { toasts: [], renders: 0, inits: 0, closed: [], timers: [], storage: memoryStorage(), now: 1_000_000, nextTimer: 1,
    elements: {}, open: new Set(), activeElement: null, writes: [], clipboard: null };
  const FakeDate = new Proxy(Date, { get: (target, prop) => (prop === 'now' ? () => env.now : target[prop]) });
  const el = id => env.elements[id] || (env.elements[id] = fakeElement(id));
  env.el = el;
  env.document = {
    hidden: false,
    get activeElement() { return env.activeElement; },
    getElementById: id => (TRANSIENT.includes(id) && !env.open.has(id) ? null : el(id)),
    querySelector: () => null,
    addEventListener() {},
  };
  env.route = () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) });
  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController, Date: FakeDate,
    __env: env, localStorage: env.storage, document: env.document,
    window: { location: { pathname: '/', origin: 'https://pp.test', search: '', hash: '' }, localStorage: env.storage, addEventListener() {} },
    history: { replaceState() {} },
    navigator: { get clipboard() { return env.clipboardApi; } },
    fetch: async (url, init = {}) => env.route({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }),
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    setInterval: () => 0,
  };
  env.clipboardApi = { writeText: async text => { env.clipboard = text; } };
  env.ctx = app.sandbox(NAMES, { globals, extraSource: STUBS + SAVE_SOURCE + CLIPBOARD_SOURCE + LIVE_SOURCE + TAB_SOURCE });
  env.api = env.ctx.api;
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

function seedPlan(env, { planId = 'event:999', name = 'Plan', extra = [] } = {}) {
  const { Import, State } = env.api;
  const players = [
    { name: 'Tanky', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 1 },
    { name: 'Shammy', class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps', groupNumber: 1 },
    { name: 'Stabby', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 },
    { name: 'Frosty', class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 2 },
    { name: 'Healy', class: 'PRIEST', spec: 'Holy', role: 'healer', groupNumber: 2 },
    ...extra,
  ];
  assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name, players }));
  State.planId = planId;
}

// A snapshot of the open plan under another plan ID, ready to hand to PlanStore.
function planData(env, planId, name) {
  const { PlanStore, State } = env.api;
  State.planId = planId;
  State.rosterName = name || planId;
  return PlanStore.capture();
}

// Values come from the vm realm, so compare structurally through JSON.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const raw = (env, key = 'pp_working_plans') => JSON.parse(env.storage.getItem(key));
const names = list => list.map(e => e.data.rosterName);

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
  // ── #7: PlanStore keeps what it cannot read ─────────────────────
  await check('save keeps entries that fail validation, read() just does not list them', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    const bad = { updatedAt: 5, data: { planId: 'old', gameVersion: 'tbc', selectedRaid: 'removed-raid', rosterName: 'Old', groups: [], bench: [], optimizerMode: 'max_dps', buffOverrides: {} } };
    const junk = 'not an entry';
    const noData = { updatedAt: 6 };
    env.storage.setItem('pp_working_plans', JSON.stringify([bad, junk, noData]));
    assert.equal(PlanStore.read(env.storage).length, 0, 'none of them is readable');
    PlanStore.save(env.storage, planData(env, 'plan:new', 'New'));
    const stored = raw(env);
    assert.equal(stored.length, 4);
    assert.equal(stored[0].data.rosterName, 'New');
    same(stored.slice(1), [bad, junk, noData], 'unreadable entries survive untouched, in order');
    assert.equal(PlanStore.read(env.storage).length, 1);
  });

  await check('saving a plan replaces only its own earlier entry', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, planData(env, 'plan:a', 'A'));
    PlanStore.save(env.storage, planData(env, 'plan:b', 'B'));
    env.now += 10;
    PlanStore.save(env.storage, planData(env, 'plan:a', 'A edited'));
    same(names(raw(env)), ['A edited', 'B']);
  });

  await check('corrupt storage is set aside before the first save instead of being overwritten', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    env.storage.setItem('pp_working_plans', '{broken');
    same(PlanStore.read(env.storage), []);
    PlanStore.save(env.storage, planData(env, 'plan:a', 'A'));
    assert.equal(env.storage.getItem('pp_working_plans_corrupt'), '{broken');
    same(names(raw(env)), ['A']);
    env.storage.setItem('pp_working_plans', '{"not":"a list"}');
    PlanStore.save(env.storage, planData(env, 'plan:a', 'A'));
    assert.equal(env.storage.getItem('pp_working_plans_corrupt'), '{"not":"a list"}', 'a non-list value counts as corrupt too');
  });

  // ── #7: schemaVersion + migrate ─────────────────────────────────
  await check('entries are stamped with schemaVersion; legacy entries count as version 1', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    const legacy = { updatedAt: 1, data: planData(env, 'plan:legacy', 'Legacy') };
    env.storage.setItem('pp_working_plans', JSON.stringify([legacy]));
    const read = PlanStore.read(env.storage);
    assert.equal(read.length, 1);
    assert.equal(read[0].schemaVersion, 1);
    PlanStore.save(env.storage, planData(env, 'plan:new', 'New'));
    same(raw(env).map(e => e.schemaVersion), [1, undefined], 'new entries are stamped; a legacy one is not rewritten');
  });

  await check('migrate() upgrades older entries step by step and leaves newer or unmigratable ones alone', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    const data = planData(env, 'plan:v1', 'V1 plan');
    const future = { updatedAt: 9, schemaVersion: 7, data: { planId: 'plan:future', whatever: true } };
    env.storage.setItem('pp_working_plans', JSON.stringify([{ updatedAt: 1, data }, future]));

    PlanStore.schemaVersion = 3;
    assert.equal(PlanStore.read(env.storage).length, 0, 'no migration path: not readable, not an error');
    PlanStore.migrations[1] = d => ({ ...d, rosterName: d.rosterName + ' (v2)' });
    PlanStore.migrations[2] = d => ({ ...d, rosterName: d.rosterName + ' (v3)' });
    const read = PlanStore.read(env.storage);
    assert.equal(read.length, 1);
    assert.equal(read[0].data.rosterName, 'V1 plan (v2) (v3)');
    assert.equal(read[0].schemaVersion, 3);
    assert.equal(raw(env)[0].data.rosterName, 'V1 plan', 'migration happens on read, storage is untouched');

    PlanStore.save(env.storage, planData(env, 'plan:other', 'Other'));
    same(raw(env).map(e => e.data.planId), ['plan:other', 'plan:v1', 'plan:future'], 'the future entry is kept');
    assert.equal(raw(env).find(e => e.data.planId === 'plan:future').schemaVersion, 7);

    PlanStore.migrations[2] = () => { throw new Error('bad migration'); };
    same(PlanStore.read(env.storage).map(e => e.data.planId), ['plan:other'], 'a throwing migration hides that entry only');
  });

  await check('migrate() rejects non-entries and non-integer versions fall back to 1', async () => {
    const { PlanStore } = makeEnv().api;
    assert.equal(PlanStore.migrate(null), null);
    assert.equal(PlanStore.migrate('x'), null);
    assert.equal(PlanStore.migrate({ schemaVersion: 'two', data: {} }).schemaVersion, 1);
    assert.equal(PlanStore.migrate({ schemaVersion: 0, data: {} }).schemaVersion, 1);
  });

  // ── #7: cap ─────────────────────────────────────────────────────
  await check('the cap drops the oldest by updatedAt, never the plan being saved', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.max = 3;
    for (const id of ['a', 'b', 'c']) { PlanStore.save(env.storage, planData(env, 'plan:' + id, id)); env.now += 10; }
    const res = PlanStore.save(env.storage, planData(env, 'plan:d', 'd'));
    same(res.evicted, ['a']);
    same(names(raw(env)), ['d', 'c', 'b']);
    // The plan being saved is the oldest-looking one but always stays.
    env.now -= 1000;
    const res2 = PlanStore.save(env.storage, planData(env, 'plan:e', 'e'));
    assert(names(raw(env)).includes('e'), 'current plan kept');
    same(res2.evicted.length, 1);
  });

  await check('the cap never evicts a plan bound to a live link; the rest go oldest first', async () => {
    const env = makeEnv();
    const { PlanStore, LiveLinks } = env.api;
    seedPlan(env);
    PlanStore.max = 3;
    PlanStore.save(env.storage, planData(env, 'plan:live', 'live')); env.now += 10;
    PlanStore.save(env.storage, planData(env, 'plan:b', 'b')); env.now += 10;
    PlanStore.save(env.storage, planData(env, 'plan:c', 'c')); env.now += 10;
    LiveLinks.bind(env.storage, 'tbc|plan:live', 'aB3dE5g', 'code', 1);
    const res = PlanStore.save(env.storage, planData(env, 'plan:d', 'd'));
    same(res.evicted, ['b'], 'the oldest unprotected plan went, not the older live one');
    same(names(raw(env)).sort(), ['c', 'd', 'live']);
  });

  await check('when every other plan is protected the cap lets the list run over instead of deleting', async () => {
    const env = makeEnv();
    const { PlanStore, LiveLinks } = env.api;
    seedPlan(env);
    PlanStore.max = 2;
    for (const id of ['a', 'b', 'c']) {
      PlanStore.save(env.storage, planData(env, 'plan:' + id, id)); env.now += 10;
      LiveLinks.bind(env.storage, 'tbc|plan:' + id, 'aB3dE5' + id.toUpperCase(), 'code', 1);
    }
    PlanStore.save(env.storage, planData(env, 'plan:d', 'd'));
    same(names(raw(env)).sort(), ['a', 'b', 'c', 'd']);
  });

  await check('unreadable entries count toward the cap and are evicted by age like any other', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.max = 2;
    env.storage.setItem('pp_working_plans', JSON.stringify([{ updatedAt: 1, weird: true }, { updatedAt: 500, data: planData(env, 'plan:keep', 'keep') }]));
    const res = PlanStore.save(env.storage, planData(env, 'plan:new', 'new'));
    same(res.evicted, ['an unreadable plan']);
    same(names(raw(env)), ['new', 'keep']);
  });

  // ── #7: quota ───────────────────────────────────────────────────
  await check('a quota error evicts the oldest unprotected plan and retries until the write fits', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    for (const id of ['a', 'b', 'c']) { PlanStore.save(env.storage, planData(env, 'plan:' + id, id)); env.now += 10; }
    const oneEntry = JSON.stringify([{ updatedAt: 1, schemaVersion: 1, data: planData(env, 'plan:d', 'd') }]).length;
    env.storage.limit = oneEntry * 2 + 50; // room for two entries only
    const res = PlanStore.save(env.storage, planData(env, 'plan:d', 'd'));
    same(res.evicted, ['a', 'b']);
    same(names(raw(env)), ['d', 'c']);
  });

  await check('a quota error with nothing left to evict throws and leaves storage as it was', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, planData(env, 'plan:a', 'a'));
    const before = env.storage.getItem('pp_working_plans');
    env.storage.limit = 10;
    assert.throws(() => PlanStore.save(env.storage, planData(env, 'plan:a', 'a edited')), e => e.name === 'QuotaExceededError');
    assert.equal(env.storage.getItem('pp_working_plans'), before);
  });

  await check('other storage errors are rethrown without evicting anything', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, planData(env, 'plan:a', 'a'));
    PlanStore.save(env.storage, planData(env, 'plan:b', 'b'));
    const before = env.storage.getItem('pp_working_plans');
    const denied = new Error('denied'); denied.name = 'SecurityError';
    env.storage.failWith = denied;
    assert.throws(() => PlanStore.save(env.storage, planData(env, 'plan:c', 'c')), e => e === denied);
    env.storage.failWith = null;
    assert.equal(env.storage.getItem('pp_working_plans'), before);
    assert.equal(PlanStore.isQuotaError({ code: 22 }), true);
    assert.equal(PlanStore.isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
    assert.equal(PlanStore.isQuotaError(null), false);
  });

  // ── #7: debounced writes ────────────────────────────────────────
  await check('saveSoon writes once after the pause, with the latest data, and reports the outcome', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    const outcomes = [];
    PlanStore.saveSoon(env.storage, planData(env, 'plan:a', 'first'), o => outcomes.push(o));
    await env.advance(100);
    PlanStore.saveSoon(env.storage, planData(env, 'plan:a', 'second'), o => outcomes.push(o));
    await env.advance(PlanStore.saveDelayMs - 1);
    assert.equal(env.storage.getItem('pp_working_plans'), null, 'still inside the pause: nothing written');
    await env.advance(1);
    same(names(raw(env)), ['second']);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, true);
    same(Array.from(outcomes[0].evicted), []);
    assert.equal(PlanStore.pending, null);
  });

  await check('saveSoon reports a failed write, and flush() with nothing waiting is a no-op', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    assert.equal(PlanStore.flush(), null);
    env.storage.limit = 10;
    const outcomes = [];
    PlanStore.saveSoon(env.storage, planData(env, 'plan:a', 'a'), o => outcomes.push(o));
    await env.advance(PlanStore.saveDelayMs);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(outcomes[0].error.name, 'QuotaExceededError');
  });

  await check('flush() writes the waiting save now; read() flushes first so it never lists stale data', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.saveSoon(env.storage, planData(env, 'plan:a', 'a'));
    assert.equal(env.storage.getItem('pp_working_plans'), null);
    assert.equal(PlanStore.flush().ok, true);
    same(names(raw(env)), ['a']);
    assert.equal(env.timers.length, 0, 'the timer is cancelled');
    PlanStore.saveSoon(env.storage, planData(env, 'plan:b', 'b'));
    same(PlanStore.read(env.storage).map(p => p.data.rosterName), ['b', 'a'], 'read sees the waiting save');
  });

  await check('a waiting save of another plan is written before it is replaced', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    PlanStore.saveSoon(env.storage, planData(env, 'plan:a', 'a'));
    PlanStore.saveSoon(env.storage, planData(env, 'plan:b', 'b'));
    same(names(raw(env)), ['a'], 'plan a was not lost when the user switched to plan b');
    await env.advance(PlanStore.saveDelayMs);
    same(names(raw(env)), ['b', 'a']);
  });

  // ── persistWorkingPlan: status line, debounce, eviction notice ──
  await check('persistWorkingPlan saves a changed plan after the pause and paints the status line', async () => {
    const env = makeEnv();
    const { PlanSession, State, PlanStore } = env.api;
    seedPlan(env);
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    assert.equal(env.storage.getItem('pp_working_plans'), null, 'not written yet');
    assert.equal(env.el('autosave-status').textContent, 'Saved on this device');
    await env.advance(PlanStore.saveDelayMs);
    assert.equal(raw(env)[0].data.planId, State.planId);
    assert.equal(env.el('roster-status-line').textContent, 'Saved on this device');
    assert.equal(env.el('btn-undo').disabled, true);
  });

  await check('a failed save shows the failure on both status lines, then retries on the next persist', async () => {
    const env = makeEnv();
    const { PlanSession, PlanStore, State } = env.api;
    seedPlan(env);
    PlanSession.ready = true;
    env.storage.limit = 10;
    env.ctx.persistWorkingPlan();
    await env.advance(PlanStore.saveDelayMs);
    assert.equal(env.el('autosave-status').textContent, 'Could not save — export a copy');
    assert.equal(env.el('autosave-status').dataset.failed, 'true');
    assert.equal(env.el('roster-status-line').dataset.failed, 'true');
    env.storage.limit = Infinity;
    env.ctx.persistWorkingPlan(); // nothing changed, but the failure forces a retry
    await env.advance(PlanStore.saveDelayMs);
    assert.equal(env.el('autosave-status').dataset.failed, undefined);
    assert.equal(env.el('roster-status-line').dataset.failed, undefined);
    assert.equal(raw(env)[0].data.planId, State.planId);
  });

  await check('an unchanged plan is not rewritten', async () => {
    const env = makeEnv();
    const { PlanSession, PlanStore } = env.api;
    seedPlan(env);
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    await env.advance(PlanStore.saveDelayMs);
    const written = env.storage.getItem('pp_working_plans');
    env.now += 5000;
    env.ctx.persistWorkingPlan();
    await env.advance(PlanStore.saveDelayMs);
    assert.equal(env.storage.getItem('pp_working_plans'), written);
  });

  await check('evicting old plans to make room is announced', async () => {
    const env = makeEnv();
    const { PlanSession, PlanStore } = env.api;
    seedPlan(env);
    PlanStore.max = 1;
    PlanStore.save(env.storage, planData(env, 'plan:old', 'Old raid'));
    env.now += 10;
    seedPlan(env);
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    await env.advance(PlanStore.saveDelayMs);
    assert(env.toasts.some(t => /removed the oldest saved plan \(Old raid\)/.test(t)), env.toasts.join('|'));
  });

  await check('a change to the plan retires the remote-update Undo; an unchanged persist does not', async () => {
    const env = makeEnv();
    const { PlanSession, RemoteUpdate, State } = env.api;
    seedPlan(env);
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    RemoteUpdate.show({ some: 'snapshot' });
    assert.equal(env.el('remote-update-banner').hidden, false);
    env.ctx.persistWorkingPlan();
    assert.equal(env.el('remote-update-banner').hidden, false, 'nothing changed');
    State.notes = 'my own edit';
    env.ctx.persistWorkingPlan();
    assert.equal(env.el('remote-update-banner').hidden, true);
    assert.equal(RemoteUpdate.before, null);
  });

  // ── F7: Templates.write ─────────────────────────────────────────
  await check('Templates save/rename/delete report a refused write instead of claiming success', async () => {
    const env = makeEnv();
    const { Templates } = env.api;
    seedPlan(env);
    assert.equal(Templates.save(env.storage, 'Main', 'tbc', 'kara').success, true);
    const stored = env.storage.getItem('pp_roster_templates');
    env.storage.limit = 10;
    const saved = Templates.save(env.storage, 'Other', 'tbc', 'kara');
    assert.equal(saved.success, false);
    assert.match(saved.error, /storage is full/);
    assert(env.toasts.some(t => /storage is full/.test(t)), 'safeSetItem told the user');
    assert.equal(Templates.rename(env.storage, 'Main', 'Renamed', 'tbc', 'kara').success, false);
    assert.equal(Templates.delete(env.storage, 'Main', 'tbc', 'kara').success, false);
    assert.equal(env.storage.getItem('pp_roster_templates'), stored, 'nothing changed');
    env.storage.limit = Infinity;
    assert.equal(Templates.rename(env.storage, 'Main', 'Renamed', 'tbc', 'kara').success, true);
    assert.equal(Templates.delete(env.storage, 'Renamed', 'tbc', 'kara').success, true);
    same(Templates.list(env.storage, 'tbc', 'kara'), []);
  });

  await check('Templates.write is routed through safeSetItem in the source', async () => {
    assert(/write\(storage, all\)\s*\{\s*return safeSetItem\(/.test(app.slice('const Templates = {', '// {lowerName')));
  });

  await check('a data backup merge copes with plan entries PlanStore keeps but cannot read', async () => {
    const env = makeEnv();
    const { DataBackup, PlanStore } = env.api;
    seedPlan(env);
    const weird = { updatedAt: 3, schemaVersion: 9, data: { planId: 'from-the-future' } };
    env.storage.setItem('pp_working_plans', JSON.stringify([weird, 'junk']));
    const incoming = [{ updatedAt: 8, data: planData(env, 'plan:backup', 'Backup plan') }];
    const merged = DataBackup._merge('pp_working_plans', env.storage.getItem('pp_working_plans'), JSON.stringify(incoming));
    const list = JSON.parse(merged.value);
    assert.equal(list.length, 3);
    assert(list.some(e => e === 'junk') && list.some(e => e && e.schemaVersion === 9), 'unreadable entries survive the merge');
    assert.equal(merged.added, 1);
    assert.equal(PlanStore.read({ getItem: () => merged.value }).length, 1);
  });

  // ── #8: live updates keep local state ───────────────────────────
  function shamanOverride(env) {
    const { State } = env.api;
    const gi = State.groups.findIndex(g => g.some(p => p.name === 'Shammy'));
    const shaman = State.groups[gi].find(p => p.name === 'Shammy');
    State.buffOverrides[`${gi}:${shaman.uid}:air`] = { buffId: 'GRACE_OF_AIR', originalBuffId: 'WINDFURY' };
    return { gi, shaman };
  }
  // Someone else's copy of the plan, as a share code, built in a sandbox of its own so this browser's state stays put.
  function remoteCode(mutate, seed) {
    const other = makeEnv();
    seedPlan(other, seed);
    const roster = other.api.Import.exportRoster('Plan');
    mutate(roster);
    assert(other.api.Import.loadRoster(roster));
    return other.api.currentShareCode();
  }

  await check('LocalPicks: uids survive an update by name and a totem pick follows its shaman to the new group', async () => {
    const env = makeEnv();
    const { State, Import, LocalPicks } = env.api;
    seedPlan(env);
    const { shaman } = shamanOverride(env);
    const uidsBefore = Object.fromEntries(State.groups.flat().map(p => [p.name, p.uid]));
    const snap = LocalPicks.capture();
    const code = remoteCode(d => { d.players.find(p => p.name === 'Shammy').groupNumber = 2; });
    assert(Import.importAddonString(Import.decodeSharePayload(code)).success);
    same(Object.keys(State.buffOverrides), [], 'the import itself wipes the picks');
    LocalPicks.restore(snap);
    for (const p of State.groups.flat()) assert.equal(p.uid, uidsBefore[p.name], p.name + ' keeps its uid');
    same(Object.keys(State.buffOverrides), [`1:${shaman.uid}:air`]);
    assert.equal(State.buffOverrides[`1:${shaman.uid}:air`].buffId, 'GRACE_OF_AIR');
  });

  await check('LocalPicks: a pick is dropped when its player left, was benched, or can no longer provide the buff', async () => {
    const env = makeEnv();
    const { State, Import, LocalPicks } = env.api;
    seedPlan(env);
    shamanOverride(env);
    const snap = LocalPicks.capture();
    const gone = remoteCode(d => { d.players = d.players.filter(p => p.name !== 'Shammy'); });
    const respec = remoteCode(d => { const s = d.players.find(p => p.name === 'Shammy'); s.class = 'MAGE'; s.spec = 'Frost'; s.role = 'caster_dps'; });
    const benched = remoteCode(d => { const s = d.players.find(p => p.name === 'Shammy'); d.players = d.players.filter(p => p !== s); d.bench.push({ ...s, groupNumber: 0 }); });

    Import.importAddonString(Import.decodeSharePayload(gone));
    LocalPicks.restore(snap);
    same(State.buffOverrides, {}, 'player removed');

    Import.importAddonString(Import.decodeSharePayload(respec));
    LocalPicks.restore(snap);
    same(State.buffOverrides, {}, 'a mage cannot run Grace of Air');

    Import.importAddonString(Import.decodeSharePayload(benched));
    LocalPicks.restore(snap);
    same(State.buffOverrides, {}, 'benched players have no group to pick for');
  });

  await check('LocalPicks: same-name players keep distinct uids and a new player gets a fresh one', async () => {
    const env = makeEnv();
    const { State, Import, LocalPicks } = env.api;
    const seed = { extra: [{ name: 'Twin', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 2 }, { name: 'Twin', class: 'MAGE', spec: 'Arcane', role: 'caster_dps', groupNumber: 2 }] };
    seedPlan(env, seed);
    const snap = LocalPicks.capture();
    const twinUids = State.groups.flat().filter(p => p.name === 'Twin').map(p => p.uid);
    const code = remoteCode(d => { d.players.unshift({ name: 'Newbie', class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 }); }, seed);
    Import.importAddonString(Import.decodeSharePayload(code));
    LocalPicks.restore(snap);
    const all = [...State.groups.flat(), ...State.bench];
    same(all.filter(p => p.name === 'Twin').map(p => p.uid), twinUids);
    assert.equal(new Set(all.map(p => p.uid)).size, all.length, 'every uid is unique');
    assert(!snap.players.some(p => p.name === 'Newbie'));
  });

  // The live-link flow end to end: pull -> apply -> banner -> Undo.
  function linkedEnv() {
    const env = makeEnv();
    const { State, LiveLinks, PlanStore, PlanSession } = env.api;
    seedPlan(env);
    PlanSession.ready = true;
    shamanOverride(env);
    PlanStore.save(env.storage, PlanStore.capture());
    LiveLinks.bind(env.storage, LiveLinks.planKey(State), 'aB3dE5g', env.api.currentShareCode(), 100);
    const code = remoteCode(d => { d.players.find(p => p.name === 'Shammy').groupNumber = 2; d.notes = 'their note'; });
    env.route = call => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (call.method === 'GET' ? { code, updatedAt: 200 } : { updatedAt: 300 }) });
    return env;
  }

  await check('pull applies a remote update, keeps the totem pick and uids, and raises the persistent banner', async () => {
    const env = linkedEnv();
    const { State, LiveSync, RemoteUpdate } = env.api;
    const shamanUid = State.groups.flat().find(p => p.name === 'Shammy').uid;
    await LiveSync.pull();
    await settle();
    assert.equal(State.notes, 'their note', 'the update landed');
    assert.equal(State.groups[1].some(p => p.uid === shamanUid), true, 'Shammy moved to group 2 with the same uid');
    assert.equal(State.buffOverrides[`1:${shamanUid}:air`].buffId, 'GRACE_OF_AIR', 'the pick followed the shaman');
    assert.equal(env.el('remote-update-banner').hidden, false);
    assert(RemoteUpdate.before, 'the pre-update plan is held for Undo');
    assert(!env.toasts.some(t => /updated by someone else/.test(t)), 'a banner, not a transient toast');
  });

  await check('Undo restores the pre-update plan (picks included), hides the banner and lets the link follow', async () => {
    const env = linkedEnv();
    const { State, LiveSync, RemoteUpdate } = env.api;
    const shamanUid = State.groups.flat().find(p => p.name === 'Shammy').uid;
    const notesBefore = State.notes;
    await LiveSync.pull();
    await settle();
    env.closed.length = 0;
    assert.equal(RemoteUpdate.undo(), true);
    assert.equal(State.notes, notesBefore);
    assert.equal(State.groups[0].some(p => p.uid === shamanUid), true, 'Shammy is back in group 1');
    assert.equal(State.buffOverrides[`0:${shamanUid}:air`].buffId, 'GRACE_OF_AIR');
    assert.equal(env.el('remote-update-banner').hidden, true);
    assert.equal(RemoteUpdate.before, null);
    assert(env.closed.includes('editor') && env.closed.includes('picker'), 'open editors are closed');
    assert.equal(env.api.LiveSync.pending, true, 'the restored copy is queued for the live link');
    assert(env.toasts.some(t => /Restored your version/.test(t)));
  });

  await check('a live update is logged under Changes with its group moves (players matched by name)', async () => {
    const env = linkedEnv();
    const { State, LiveSync, ChangeLog, RemoteUpdate } = env.api;
    ChangeLog.clear();
    await LiveSync.pull();
    await settle();
    assert.equal(ChangeLog.entries.length, 1);
    const [entry] = ChangeLog.entries;
    assert.equal(entry.kind, 'live');
    assert.equal(entry.label, 'Live link update');
    assert.deepEqual(Array.from(entry.items, i => `${i.kind} ${i.name}: ${i.detail}`), ['moved Shammy: Group 1 to Group 2']);
    assert.equal(RemoteUpdate.entryId, entry.id, 'the banner remembers which entry Undo drops');
    assert.equal(ChangeLog.highlightFor(State.groups[1].find(p => p.name === 'Shammy')).kind, 'moved');
  });

  await check('Undo of a live update drops its Changes entry; Dismiss keeps it', async () => {
    const env = linkedEnv();
    const { LiveSync, ChangeLog, RemoteUpdate } = env.api;
    ChangeLog.clear();
    const earlier = ChangeLog.record('sync', [{ kind: 'added', name: 'Someone' }]);
    await LiveSync.pull();
    await settle();
    assert.equal(ChangeLog.entries.length, 2);
    assert.equal(RemoteUpdate.undo(), true);
    assert.deepEqual(Array.from(ChangeLog.entries, e => e.id), [earlier.id], 'only the undone update goes');
    const env2 = linkedEnv();
    env2.api.ChangeLog.clear();
    await env2.api.LiveSync.pull();
    await settle();
    env2.api.RemoteUpdate.hide();
    assert.equal(env2.api.ChangeLog.entries.length, 1);
  });

  await check('Undo with nothing to undo, a second Undo, and Dismiss are harmless', async () => {
    const env = linkedEnv();
    const { State, LiveSync, RemoteUpdate } = env.api;
    assert.equal(RemoteUpdate.undo(), false, 'no update yet');
    await LiveSync.pull();
    await settle();
    RemoteUpdate.hide();
    assert.equal(env.el('remote-update-banner').hidden, true);
    assert.equal(RemoteUpdate.undo(), false, 'dismissed: nothing left to restore');
    assert.equal(State.notes, 'their note', 'dismissing keeps their version');
  });

  await check('a second update replaces the banner and Undo steps back to the plan before that update', async () => {
    const env = linkedEnv();
    const { State, LiveSync, RemoteUpdate } = env.api;
    await LiveSync.pull();
    await settle();
    const afterFirst = JSON.stringify(RemoteUpdate.before);
    const second = remoteCode(d => { d.notes = 'third note'; });
    env.route = call => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (call.method === 'GET' ? { code: second, updatedAt: 400 } : { updatedAt: 500 }) });
    await LiveSync.pull();
    await settle();
    assert.equal(State.notes, 'third note');
    assert.notEqual(JSON.stringify(RemoteUpdate.before), afterFirst);
    RemoteUpdate.undo();
    assert.equal(State.notes, 'their note');
  });

  // Deferral while the user is mid-edit.
  for (const [label, open] of [
    ['the player editor', env => env.open.add('active-player-editor')],
    ['the buff picker', env => env.open.add('active-buff-picker')],
    ['the notes field', env => { env.activeElement = env.el('raid-notes-textarea'); }],
  ]) {
    await check(`pull does not apply an update while ${label} is in use, and applies it once the user lets go`, async () => {
      const env = linkedEnv();
      const { State, LiveSync } = env.api;
      open(env);
      await LiveSync.pull();
      await settle();
      assert.equal(State.notes, '', 'plan untouched while editing');
      assert.equal(env.renders, 0);
      assert.equal(env.el('remote-update-banner').hidden, true);
      await env.advance(2000);
      assert.equal(State.notes, '', 'still editing: still waiting');
      assert.equal(env.timers.length, 1, 'exactly one wait timer, not one per check');
      env.open.clear();
      env.activeElement = null;
      await env.advance(600);
      assert.equal(State.notes, 'their note', 'applied when focus left');
      assert.equal(env.el('remote-update-banner').hidden, false);
      assert.equal(LiveSync.deferTimer, null, 'no wait timer left behind');
    });
  }

  await check('a deferred update is dropped if the user saved their own change meanwhile (their save wins, as before)', async () => {
    const env = linkedEnv();
    const { State, LiveSync } = env.api;
    env.open.add('active-player-editor');
    await LiveSync.pull();
    await settle();
    State.notes = 'my edit';
    env.ctx.commit();
    env.open.clear();
    await env.advance(600);
    assert.equal(State.notes, 'my edit', 'a pending local save is never overwritten');
  });

  // ── U7: second tab ──────────────────────────────────────────────
  function tabEnv() {
    const env = makeEnv();
    const { State, PlanStore, LiveLinks } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, PlanStore.capture());
    const key = LiveLinks.planKey(State);
    // What the other tab writes: the same plan, saved later, with different content.
    const theirData = PlanStore.capture();
    theirData.notes = 'edited in the other tab';
    const theirs = JSON.stringify([{ updatedAt: env.now + 5000, schemaVersion: 1, data: theirData }]);
    return { env, key, theirs, theirData };
  }

  await check('TabWatch warns when another tab saves the open plan', async () => {
    const { env, theirs } = tabEnv();
    env.api.TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(env.el('tab-conflict-banner').hidden, false);
    assert.equal(env.api.TabWatch.entry.data.notes, 'edited in the other tab');
  });

  await check('TabWatch ignores a save with identical content, then warns on a real edit', async () => {
    const { env, key, theirs } = tabEnv();
    const { TabWatch, PlanStore } = env.api;
    const same = JSON.stringify([{ updatedAt: env.now + 3000, schemaVersion: 1, data: PlanStore.capture() }]);
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: same });
    assert.equal(env.el('tab-conflict-banner').hidden, true, 'a second tab opening the same plan is no conflict');
    assert.equal(PlanStore.known[key], env.now + 3000);
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(env.el('tab-conflict-banner').hidden, false);
  });

  await check('TabWatch ignores other keys, key-less events, other plans and this tab\'s own write', async () => {
    const { env, theirs } = tabEnv();
    const { TabWatch, PlanStore, State } = env.api;
    TabWatch.onStorage({ key: 'pp_live_links', newValue: theirs });
    TabWatch.onStorage({ key: null, newValue: null });
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: null });
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: '{broken' });
    const other = JSON.parse(theirs); other[0].data.planId = 'plan:someone-else';
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: JSON.stringify(other) });
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: env.storage.getItem('pp_working_plans') });
    assert.equal(env.el('tab-conflict-banner').hidden, true);
    assert.equal(TabWatch.entry, null);
    assert.equal(PlanStore.foreignEdit(theirs, null), null);
    assert.equal(State.notes, '');
  });

  await check('TabWatch: Load their version restores the other tab\'s copy, hides the banner and can be undone', async () => {
    const { env, theirs } = tabEnv();
    const { TabWatch, State, PlanSession } = env.api;
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(TabWatch.loadTheirs(), true);
    assert.equal(State.notes, 'edited in the other tab');
    assert.equal(env.el('tab-conflict-banner').hidden, true);
    assert.equal(TabWatch.entry, null);
    assert.equal(TabWatch.loadTheirs(), false, 'nothing left to load');
    assert(PlanSession.undoLast(), 'the swap went through the usual change pipeline, so Undo works');
    assert.equal(State.notes, '');
  });

  await check('TabWatch: Keep mine hides the banner and stays quiet until the other tab saves again', async () => {
    const { env, theirs } = tabEnv();
    const { TabWatch, State } = env.api;
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    TabWatch.keepMine();
    assert.equal(env.el('tab-conflict-banner').hidden, true);
    assert.equal(State.notes, '', 'this tab keeps its copy');
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(env.el('tab-conflict-banner').hidden, true, 'the same save does not warn twice');
    const again = JSON.parse(theirs); again[0].updatedAt += 1000;
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: JSON.stringify(again) });
    assert.equal(env.el('tab-conflict-banner').hidden, false, 'a newer save does');
    TabWatch.keepMine();
    TabWatch.keepMine(); // idempotent with no entry
    assert.equal(env.el('tab-conflict-banner').hidden, true);
  });

  await check('foreignEdit never warns about a plan this tab has not seen differ, and read() counts as having seen it', async () => {
    const { env, key, theirs } = tabEnv();
    const { PlanStore } = env.api;
    const mine = env.storage.getItem('pp_working_plans');
    assert.equal(PlanStore.foreignEdit(mine, key), null, 'own save');
    PlanStore.known = {};
    assert(PlanStore.foreignEdit(mine, key), 'a fresh tab that has seen nothing sees it as foreign');
    PlanStore.read(env.storage);
    assert.equal(PlanStore.foreignEdit(mine, key), null, 'read() records what was seen');
    assert(PlanStore.foreignEdit(theirs, key));
  });

  // ── U8: manual copy ─────────────────────────────────────────────
  await check('copyText toasts on success and does not open the dialog', async () => {
    const env = makeEnv();
    await env.api.copyText('hello', 'Copied!');
    assert.equal(env.clipboard, 'hello');
    same(env.toasts, ['Copied!']);
    assert.equal(env.el('manual-copy-dialog').shown, 0);
  });

  await check('copyText opens the manual-copy dialog with the text selected when the write is refused', async () => {
    const env = makeEnv();
    env.clipboardApi = { writeText: async () => { throw new Error('NotAllowedError'); } };
    await env.api.copyText('PP:2:kara:...', 'Copied!');
    assert.equal(env.el('manual-copy-dialog').shown, 1);
    assert.equal(env.el('manual-copy-text').value, 'PP:2:kara:...');
    assert.equal(env.el('manual-copy-text').selected, 1);
    same(env.toasts, [], 'no success toast for a failed copy');
    env.el('close-manual-copy').onclick();
    assert.equal(env.el('manual-copy-dialog').shown, 0, 'Close works');
  });

  await check('copyText falls back to the dialog when there is no clipboard API, or it throws synchronously', async () => {
    const env = makeEnv();
    env.clipboardApi = undefined;
    await env.api.copyText('one', 'Copied!');
    assert.equal(env.el('manual-copy-text').value, 'one');
    env.clipboardApi = { writeText() { throw new Error('boom'); } };
    await env.api.copyText('two', 'Copied!');
    assert.equal(env.el('manual-copy-text').value, 'two');
    assert.equal(env.el('manual-copy-dialog').shown, 2);
  });

  await check('every clipboard write in the app goes through copyText, and the new wiring is present', async () => {
    const root = path.join(__dirname, 'js');
    for (const file of fs.readdirSync(root)) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      const direct = src.split('\n').filter(l => /clipboard\.writeText|clipboard\.write\(/.test(l) && !/^\s*\/\//.test(l));
      const allowed = file === 'modals.js' ? 1 : (file === 'app.js' ? 2 : 0); // copyText itself, and copyShareLink's own Safari path
      assert.equal(direct.length, allowed, `${file}: ${direct.join(' | ')}`);
    }
    const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert(/addEventListener\('storage'/.test(appSrc), 'storage event hooked');
    assert(/addEventListener\('pagehide', \(\) => PlanStore\.flush\(\)\)/.test(appSrc), 'debounced save flushed on pagehide');
    assert(/visibilitychange', \(\) => \{ if \(document\.hidden\) PlanStore\.flush\(\)/.test(appSrc), 'and when the tab is hidden');
    assert(/showManualCopy\(url\)/.test(appSrc), 'share link has the manual fallback');
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    for (const id of ['remote-update-banner', 'btn-remote-undo', 'btn-remote-dismiss', 'tab-conflict-banner', 'btn-tab-load', 'btn-tab-keep', 'manual-copy-dialog', 'manual-copy-text', 'close-manual-copy']) {
      assert(html.includes(`id="${id}"`), id + ' is in index.html');
    }
  });
  // ── review fixes ────────────────────────────────────────────────
  await check('a backup built from a store holding unreadable entries validates and applies again', async () => {
    const env = makeEnv();
    const { DataBackup, PlanStore } = env.api;
    seedPlan(env);
    const future = { updatedAt: 1, schemaVersion: 2, data: { planId: 'future' } };
    const noData = { updatedAt: 2 };
    env.storage.setItem('pp_working_plans', JSON.stringify([future, noData]));
    PlanStore.save(env.storage, planData(env, 'plan:mine', 'Mine'));
    const backup = DataBackup.build(env.storage);
    const verdict = DataBackup.validate(backup);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));
    const target = makeEnv();
    assert.equal(target.api.DataBackup.validate(backup).valid, true);
    assert.equal(target.api.DataBackup.apply(target.storage, backup, 'replace').success, true);
    const restored = JSON.parse(target.storage.getItem('pp_working_plans'));
    assert.equal(restored.length, 2, 'the newer-build entry survives the round trip; the one with no data is not exported');
    assert(restored.some(e => e.schemaVersion === 2));
  });

  await check('validating a backup does not teach PlanStore.known about the file\'s plans', async () => {
    const env = makeEnv();
    const { DataBackup, PlanStore } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, planData(env, 'plan:mine', 'Mine'));
    const backup = DataBackup.build(env.storage);
    PlanStore.known = {};
    DataBackup.validate(backup);
    same(PlanStore.known, {});
  });

  await check('a backup leaves out stored plan entries that fail validation and still validates; hand-made ones are rejected', async () => {
    const env = makeEnv();
    const { DataBackup, PlanStore } = env.api;
    seedPlan(env);
    PlanStore.save(env.storage, planData(env, 'plan:mine', 'Mine'));
    const stored = JSON.parse(env.storage.getItem('pp_working_plans'));
    env.storage.setItem('pp_working_plans', JSON.stringify([...stored, { updatedAt: 1, data: {} }, { updatedAt: 2 }, 'junk']));
    const backup = DataBackup.build(env.storage);
    assert.equal(JSON.parse(backup.data.pp_working_plans).length, 1, 'only the valid plan is exported');
    assert.equal(DataBackup.validate(backup).valid, true);
    backup.data.pp_working_plans = JSON.stringify([...stored, 'junk']);
    assert.equal(DataBackup.validate(backup).valid, false, 'a hand-edited file with a junk entry is rejected');
    backup.data.pp_working_plans = JSON.stringify([{ updatedAt: 1, data: { planId: 'x' } }]);
    assert.equal(DataBackup.validate(backup).valid, false);
  });

  await check('save reports why it evicted: the plan cap or a full browser', async () => {
    const env = makeEnv();
    const { PlanStore } = env.api;
    seedPlan(env);
    assert.equal(PlanStore.save(env.storage, planData(env, 'plan:a', 'a')).reason, null);
    PlanStore.max = 1; env.now += 10;
    const cap = PlanStore.save(env.storage, planData(env, 'plan:b', 'b'));
    assert.equal(cap.reason, 'cap');
    PlanStore.max = 50; env.now += 10;
    PlanStore.save(env.storage, planData(env, 'plan:c', 'c')); env.now += 10;
    env.storage.limit = JSON.stringify([{ updatedAt: 1, schemaVersion: 1, data: planData(env, 'plan:d', 'd') }]).length + 50;
    const quota = PlanStore.save(env.storage, planData(env, 'plan:d', 'd'));
    assert.equal(quota.reason, 'quota');
  });

  await check('the eviction toast names the cause', async () => {
    const env = makeEnv();
    env.ctx.showSaveOutcome({ ok: true, evicted: ['Old'], reason: 'quota' });
    env.ctx.showSaveOutcome({ ok: true, evicted: ['Older'], reason: 'cap' });
    assert(/Browser storage was full: removed the oldest saved plan \(Old\)/.test(env.toasts[0]), env.toasts[0]);
    assert(/Plan limit reached \(50 kept\): removed the oldest saved plan \(Older\)/.test(env.toasts[1]), env.toasts[1]);
  });

  await check('TabWatch banner clears once this tab saves a change, and when another plan is open', async () => {
    const { env, theirs } = tabEnv();
    const { TabWatch, PlanSession, State } = env.api;
    PlanSession.ready = true;
    env.ctx.persistWorkingPlan();
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(env.el('tab-conflict-banner').hidden, false);
    env.ctx.persistWorkingPlan();
    assert.equal(env.el('tab-conflict-banner').hidden, false, 'an unchanged persist leaves the warning up');
    State.notes = 'my edit';
    env.ctx.persistWorkingPlan();
    assert.equal(env.el('tab-conflict-banner').hidden, true, 'saving over their version retires it');
    assert.equal(TabWatch.entry, null);
    TabWatch.onStorage({ key: 'pp_working_plans', newValue: theirs });
    assert.equal(env.el('tab-conflict-banner').hidden, false);
    State.planId = 'plan:different';
    TabWatch.dropIfElsewhere();
    assert.equal(env.el('tab-conflict-banner').hidden, true, 'a different open plan drops it');
  });


  console.log(`\nPlan state tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
