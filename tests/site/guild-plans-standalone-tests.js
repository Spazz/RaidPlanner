/**
 * Raidsmith - standalone proof of "guild raid plans in the database" (tasks/open/guild-plans-db-plan.md section 7)
 * Run: node tests/site/guild-plans-standalone-tests.js
 *
 * The Planner on Vercel `main` is the same code as the guild's Planner, and a visitor with no guild must never reach the guild's API. Proves it:
 *   1  no guild scripts at all (no `Guild`): a roster load, a Raid-Helper import, edits, the save and a share make zero /api/guild requests
 *   2  signed out with the guild scripts present: zero plan-doc and raid-for-event calls (and a signed-in control that does look the raid up)
 *   3  a guild script that threw halfway (`Guild` without its API) and a loader whose scripts fail: the Planner still plans, a raid address
 *      only toasts; a page without plansync.js still opens a raid, on this device, with no plan-doc request
 *   4  static scan: every call site of PlanDb, PlanPoll, PlanDbLinks and PlanAttach outside their own files is guarded with `typeof X`
 *   5  the feature left the Vercel side alone: no commit of it touches api/, vercel.json or _headers (`git diff main` on those paths is not empty on
 *      a guild branch for an older reason: the Wowhead CSP and the Worker's _headers came with guild/slice-1)
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const realApp = require('../load-app');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n      ') : err}`); }
}

// ── the page, without plansync.js when asked ──────────────────────
const withoutPlansync = () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const stripped = html.replace(/<script src="\/js\/plansync\.js"><\/script>\s*/, '');
  assert.notEqual(stripped, html, 'index.html loads plansync.js');
  return realApp.fromHtml(stripped);
};

// ── the sandbox: logic half + RaidContext/share + the import runner ─
const pageSlices = page => ({
  context: page.slice('const SHARE_API', "document.getElementById('btn-share')"),
  init: page.slice('function initGroups()', '// Role markers use in-game spell icons'),
  importer: page.slice('function normalizeImportSource', "document.getElementById('btn-plain-import-cancel')"),
});

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
function maybeSuggestVersionSwitch() {}
var ResultLine = { show() {}, hide() {} };
var Modal = { confirm: async () => true };
`;

// The plan saver is optional in this suite (one page has no plansync.js): read it without naming it.
const OPTIONAL = `
globalThis.opt = { PlanDb: typeof PlanDb !== 'undefined' ? PlanDb : undefined, PlanPoll: typeof PlanPoll !== 'undefined' ? PlanPoll : undefined };`;
const NAMES = ['Import', 'State', 'LiveLinks', 'LiveSync', 'PlanStore', 'RaidContext', 'RaidLink', 'RaidHelperSync', 'currentShareCode', 'PlanSession',
  'ChangeLog', 'currentLiveLink', 'initGroups', 'Fairness', 'runImport', 'getShareLink', 'PlanAttach', 'importFromText'];

const memoryStorage = () => {
  const data = {};
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
};
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const plain = v => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const EVENT = '1483258698854826006';
const EVENT_JSON = JSON.stringify({
  id: EVENT, title: 'Gruul night', startTime: Math.floor(Date.UTC(2026, 9, 21, 0, 0, 0) / 1000),
  signUps: [
    { name: 'Aldric', className: 'Warrior', specName: 'Protection' }, { name: 'Brindle', className: 'Mage', specName: 'Fire' },
    { name: 'Cassia', className: 'Priest', specName: 'Holy' }, { name: 'Fenwick', className: 'Rogue', specName: 'Combat' },
  ],
});

// The guild's own router and ui, loaded the way the page loads them.
function loadGuildParts() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['router.js', 'ui.js']) vm.runInContext(read('js/guild/' + file), sandbox, { filename: file });
  return sandbox.Guild;
}
const guildParts = loadGuildParts();

// guild: 'absent' (no Guild), 'partial' (a guild script threw: Guild exists, nothing on it), 'signed-out' (every guild script ran, nobody is signed in),
// 'signed-in' (an officer of one guild with raids.edit on one team: the control that proves the spies would see a call).
function makeEnv({ guild = 'absent', page = realApp } = {}) {
  const env = { toasts: [], calls: [], guildCalls: [], timers: [], storage: memoryStorage(), now: 1_000_000, nextTimer: 1, els: {}, raidLookups: [] };
  const slices = pageSlices(page);
  const element = id => (env.els[id] = env.els[id] || {
    id, hidden: true, textContent: '', disabled: false, innerHTML: '', value: '', dataset: {}, classList: { toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
  });
  env.element = element;
  const document = { hidden: false, activeElement: null, getElementById: id => (['active-player-editor', 'active-buff-picker', 'raid-notes-textarea'].includes(id) ? null : element(id)), querySelector: () => null, addEventListener() {} };
  const record = (method, p, body) => {
    env.guildCalls.push({ method, path: p, body: body === undefined ? null : plain(body) });
    if (/raid-for-event/.test(p)) return Promise.resolve({ raid: null });
    return Promise.reject(Object.assign(new Error(guild === 'signed-out' ? 'Sign in to continue.' : 'no route'), { status: guild === 'signed-out' ? 401 : 404 }));
  };
  const location = { pathname: '/', origin: 'https://pp.test', search: '', hash: '' };
  const window = { location, localStorage: env.storage, addEventListener() {} };
  if (guild !== 'absent') window.Guild = {};
  if (guild === 'signed-out' || guild === 'signed-in') {
    const signedIn = guild === 'signed-in';
    const gd = { guild: { name: 'Guild', timeZone: 'America/New_York' }, teams: [{ id: 't1', name: 'Main' }], me: { can: {} }, canEdit: ['t1'] };
    Object.assign(window.Guild, guildParts, {
      api: { get: (p) => record('GET', p), put: (p, b) => record('PUT', p, b), post: (p, b) => record('POST', p, b), classify: err => ({ view: 'inline', title: '', text: err.message }) },
      app: { state: { me: signedIn ? { guilds: [{ id: 'g1' }] } : null, guilds: { g1: gd } }, fetchGuild: () => Promise.reject(new Error('offline')) },
      pages: { raids: { planInPlanner: () => Promise.resolve(true) }, raidNew: { createBody: () => ({}) }, plannerLanding: { planTeams: g => g.teams } },
    });
  }
  const globals = {
    btoa, atob, escape, unescape, AbortSignal, AbortController,
    __env: env, localStorage: env.storage, sessionStorage: memoryStorage(), document, window, history: { replaceState() {} }, navigator: {},
    fetch: async (url, init = {}) => {
      env.calls.push({ url: String(url), method: init.method || 'GET' });
      if (String(url).startsWith('https://raid-helper.dev/api/v4/events/')) return response(200, EVENT_JSON);
      if (String(url) === '/api/share') return response(200, { id: 'Abc1234', updatedAt: 1 });
      return response(404, {});
    },
    setTimeout: (fn, ms) => { const id = env.nextTimer++; env.timers.push({ id, at: env.now + ms, fn }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    setInterval: () => 0,
  };
  env.ctx = page.sandbox(NAMES, { globals, extraSource: STUBS + slices.context + '\n' + slices.init + '\n' + slices.importer + OPTIONAL });
  env.api = env.ctx.api;
  env.opt = env.ctx.opt;
  env.window = window;
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
  env.guildFetches = () => env.calls.filter(c => c.url.startsWith('/api/guild'));
  return env;
}

// The whole standalone life of a plan: load a roster, import a Raid-Helper event, edit, save, share, then a couple of idle minutes.
async function standaloneLife(env) {
  const { Import, State, runImport, getShareLink, PlanStore } = env.api;
  assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', name: 'Mine', players: [{ name: 'Zorro', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 1 }] }));
  env.ctx.commit();
  env.element('inp').value = 'https://raid-helper.dev/event/' + EVENT;
  env.element('btn').textContent = 'Import';
  await runImport('inp', 'st', 'btn', () => {});
  await settle();
  assert.equal(State.planId, 'event:' + EVENT, 'the Raid-Helper import loaded the event');
  State.notes = 'standalone';
  env.ctx.commit();
  const seated = State.groups.flat()[0];
  assert(seated, 'the import seated someone');
  const from = State.groups.findIndex(g => g.includes(seated));
  State.groups[from].splice(State.groups[from].indexOf(seated), 1);
  const to = (from + 1) % State.groups.length;
  State.groups[to].push(seated);
  seated.groupNumber = to + 1;
  State.roster = State.groups.flat();
  env.ctx.commit();
  PlanStore.flush();
  const link = await getShareLink();
  assert(link && link.live, 'the share made a live link');
  await env.advance(120000);
}

(async () => {
  await check('no Guild at all: load, Raid-Helper import, edits, save and share make zero /api/guild requests (and the spies do see the other requests)', async () => {
    const env = makeEnv({ guild: 'absent' });
    await standaloneLife(env);
    assert.deepEqual(env.guildFetches(), []);
    assert(env.calls.some(c => c.url === `https://raid-helper.dev/api/v4/events/${EVENT}`), 'the import fetched the event');
    assert(env.calls.some(c => c.url === '/api/share' && c.method === 'POST'), 'the share created a live link');
    const { PlanDb, PlanPoll } = env.opt;
    assert(!PlanDb.active() && !PlanPoll.active() && env.api.RaidContext.current === null);
    assert.equal(env.ctx.api.State.planId, 'event:' + EVENT, 'the plan stayed an event plan');
  });

  await check('signed out with the guild scripts present: zero plan-doc and zero raid-for-event calls, nothing on /api/guild', async () => {
    const env = makeEnv({ guild: 'signed-out' });
    await standaloneLife(env);
    assert.deepEqual(env.guildCalls, []);
    assert.deepEqual(env.guildFetches(), []);
    assert(!env.opt.PlanDb.active() && !env.opt.PlanPoll.active());
  });

  await check('control: the same import signed in as an officer does ask for the event\'s raid (so the spies above would have seen it)', async () => {
    const env = makeEnv({ guild: 'signed-in' });
    await standaloneLife(env);
    assert.deepEqual(env.guildCalls.map(c => c.path), [`/api/guild/g1/raid-for-event?event=${EVENT}`]);
    assert(!env.guildCalls.some(c => /plan-doc/.test(c.path)), 'asking for the raid is not opening its plan');
  });

  await check('a guild script that threw halfway (Guild without its API): the Planner still plans, and a raid address only says it could not open', async () => {
    const env = makeEnv({ guild: 'partial' });
    await standaloneLife(env);
    assert.deepEqual(env.guildFetches(), []);
    const { RaidContext, State } = env.api;
    const planId = State.planId;
    const toasts = env.toasts.length;
    // The router never loaded: the address is nothing to the Planner.
    assert.equal(RaidContext.route('#/planner?raid=g1.r1'), null);
    assert.equal(RaidContext.current, null);
    // The router loaded and the API did not: the raid cannot open, the toast says so, the plan on screen is untouched.
    env.window.Guild.router = guildParts.router;
    await RaidContext.route('#/planner?raid=g1.r1');
    await settle();
    assert.equal(RaidContext.current, null);
    assert.equal(State.planId, planId, 'the plan on screen is untouched');
    assert.deepEqual(env.toasts.slice(toasts), ['Something went wrong. Try again in a moment.']);
    assert.deepEqual(env.guildFetches(), []);
  });

  await check('the guild loader: a manifest or a script that fails to load is reported and never throws; the guild tag is the last one on the page', async () => {
    const errors = [];
    const run = (failing) => {
      const scripts = [];
      const document = {
        head: { appendChild: el => { scripts.push(el); setImmediate(() => (failing(el.src) ? el.onerror() : el.onload())); } },
        createElement: () => ({}),
      };
      const sandbox = { document, window: {}, console: { error: m => errors.push(m) } };
      vm.createContext(sandbox);
      vm.runInContext(read('js/guild/load.js'), sandbox, { filename: 'load.js' });
      return { scripts, sandbox };
    };
    // The manifest itself fails: reported, nothing else added.
    const dead = run(() => true);
    await settle();
    assert.deepEqual(dead.scripts.map(s => s.src), ['/js/guild/manifest.js']);
    assert(errors.some(e => /failed to load: \/js\/guild\/manifest\.js/.test(e)));
    // The manifest loads (it defines window.Guild.manifest) and one listed script fails: the rest still load.
    errors.length = 0;
    const scripts = [];
    const document = {
      head: { appendChild: el => { scripts.push(el); setImmediate(() => { if (el.src === '/js/guild/manifest.js') { sandbox.window.Guild = { manifest: ['/js/guild/a.js', '/js/guild/b.js', '/js/guild/c.js'] }; el.onload(); } else if (el.src.endsWith('b.js')) el.onerror(); else el.onload(); }); } },
      createElement: () => ({}),
    };
    const sandbox = { document, window: {}, console: { error: m => errors.push(m) } };
    vm.createContext(sandbox);
    vm.runInContext(read('js/guild/load.js'), sandbox, { filename: 'load.js' });
    await settle();
    assert.deepEqual(scripts.map(s => s.src), ['/js/guild/manifest.js', '/js/guild/a.js', '/js/guild/b.js', '/js/guild/c.js']);
    assert.equal(errors.length, 1);
    // The page: the planner's own scripts come first and the guild tag is last, so a failing guild can never hold the Planner back.
    const tags = [...read('index.html').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]).filter(src => !/^https?:/.test(src));
    assert.equal(tags[tags.length - 1], '/js/guild/load.js');
    assert(tags.indexOf('/js/plansync.js') > -1 && tags.indexOf('/js/plansync.js') < tags.indexOf('/js/guild/load.js'));
    assert(!tags.some(src => /\/js\/guild\//.test(src) && src !== '/js/guild/load.js'), 'no guild script is a plain tag in the page');
  });

  await check('a page without plansync.js still opens a raid, from this device, and never asks for its plan-doc (guarded with typeof)', async () => {
    const env = makeEnv({ guild: 'absent', page: withoutPlansync() });
    const { State, RaidContext } = env.api;
    assert.equal(env.opt.PlanDb, undefined);
    const seed = {
      raid: { id: 'r1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), title: 'Sat BT', zone: 'Black Temple', eventId: EVENT, teamId: 't1', gameVersion: 'tbc', timeZone: 'America/Chicago' },
      livePlan: null,
      signups: [{ key: 1, name: 'Aldric', discordName: 'Aldric', personId: 'p1', className: 'Warrior', specName: 'Protection', kind: 'signed', position: 1 }],
    };
    const calls = [];
    env.window.Guild = { api: {
      get: p => { calls.push(p); return /\/planner$/.test(p) ? Promise.resolve(plain(seed)) : Promise.reject(Object.assign(new Error('unexpected ' + p), { status: 500 })); },
      put: () => Promise.reject(new Error('no PUT')), classify: err => ({ text: err.message }),
    }, router: guildParts.router, ui: guildParts.ui, planSource: guildParts.planSource };
    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await RaidContext.route('#/planner?raid=g1.r1');
      await settle();
    } finally { process.off('unhandledRejection', onUnhandled); }
    assert.deepEqual(unhandled.map(e => String(e && e.message || e)), []);
    assert(calls.every(p => !/plan-doc/.test(p)), 'no plan-doc request: ' + calls.join(', '));
    assert(RaidContext.current && RaidContext.current.loaded, 'the raid opened');
    assert.equal(State.planId, 'raid:r1');
    assert.equal(RaidContext.current.db, false);
    assert.equal(State.groups.flat().length + State.bench.length + State.unplaced.length, 1, 'built from the sign-ups on this device');
  });

  await check('static scan: every call site of PlanDb, PlanPoll, PlanDbLinks and PlanAttach outside their own files is guarded with typeof', () => {
    const files = [];
    const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(e => {
      if (e.isDirectory()) walk(dir + '/' + e.name); else if (e.name.endsWith('.js')) files.push(dir + '/' + e.name);
    });
    walk('js');
    assert(files.includes('js/app.js') && files.includes('js/plansync.js') && files.includes('js/modals.js'));
    const unguarded = [];
    let sites = 0;
    for (const name of ['PlanDb', 'PlanPoll', 'PlanDbLinks', 'PlanAttach']) {
      const use = new RegExp(`(?<![\\w$.'"/-])${name}(?=[.(])`); // a call or member access, not part of another word, a string or a comment
      for (const file of files) {
        if (file === 'js/plansync.js') continue; // its own file
        const lines = read(file).split('\n');
        let own = false;
        lines.forEach((raw, index) => {
          if (name === 'PlanAttach' && file === 'js/modals.js') { // its own block: from its banner to the next one
            if (raw.startsWith('// ── RAID-HELPER IMPORT ATTACH')) own = true;
            if (raw.startsWith('// ── SHARED IMPORT RUNNER')) own = false;
          }
          if (own) return;
          const code = raw.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''");
          if (!use.test(code) || /^\s*\*/.test(raw)) return;
          sites++;
          // Guarded: `typeof X` on the line, or earlier in the same function (the nearest line at indent <= 2 that opens a block).
          let start = index;
          while (start > 0 && !(/^ {0,2}\S.*\{\s*$/.test(lines[start]) && !/^ {0,2}(?:if|else|for|while|try|\}|\)|switch)\b/.test(lines[start]))) start--;
          const guard = new RegExp(`typeof ${name}\\b`);
          if (!lines.slice(start, index + 1).some(l => guard.test(l))) unguarded.push(`${file}:${index + 1} ${raw.trim()}`);
        });
      }
    }
    assert(sites >= 25, `the scan found the call sites (${sites})`);
    assert.deepEqual(unguarded, [], 'unguarded call sites:\n' + unguarded.join('\n'));
  });

  await check('the Vercel side is untouched: no commit of this feature changed api/, vercel.json or _headers (git diff main shows only what guild/slice-1 already changed)', () => {
    let out;
    try {
      out = execFileSync('git', ['log', '--format=%h %s', '--grep=^Raid plans in the database', '--', 'api', 'vercel.json', '_headers'], { cwd: ROOT, stdio: 'pipe', windowsHide: true }).toString();
    } catch { console.log('      (skipped: git is not available here)'); return; }
    assert.equal(out.trim(), '', ['the feature must not change api/, vercel.json or _headers:', out].join(String.fromCharCode(10)));
  });

  console.log(String.fromCharCode(10) + 'Standalone proof: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
  process.exit(failed ? 1 : 0);
})();
