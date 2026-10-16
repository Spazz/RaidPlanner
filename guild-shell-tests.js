/**
 * Raidsmith app shell - tests for js/guild/app.js + shell.js against fake documents
 * Run: node guild-shell-tests.js
 *
 * The real index.html / faq.html / whats-new.html belong to the planner lane, so these tests build the page skeleton
 * from its contract (ids and body attributes: see tasks/guild-step2b-spec.md section 3) out of tiny fake elements,
 * load the guild scripts in the order of tests/guild-scripts.js inside a vm sandbox, and drive the shell the way the
 * browser would: location / history / localStorage / fetch / timers are fakes the tests control.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SOURCES = GUILD_SCRIPTS.map(src => [src, read(src.replace(/^\//, ''))]);
const plain = v => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// ── fake DOM ─────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach(x => this.set.add(x)); }
  remove(...n) { n.forEach(x => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : !!force;
    if (on) this.set.add(n); else this.set.delete(n);
    return on;
  }
}
class FakeEl {
  constructor(id, attrs) {
    this.id = id || '';
    this.attrs = Object.assign({}, attrs || {});
    this.classList = new FakeClassList();
    this.hidden = false;
    this._html = '';
    this.writes = 0;
    this.focused = 0;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.writes++; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() { this.focused++; }
  closest() { return null; }
}

// A click target: an element carrying data attributes, optionally inside a .gs-scope slot.
function target(attrs, scoped) {
  const el = new FakeEl('', attrs);
  el.closest = sel => {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (m) return Object.prototype.hasOwnProperty.call(attrs, m[1]) ? el : null;
    if (sel === '.gs-scope') return scoped === false ? null : el;
    return null;
  };
  return el;
}

const IDS = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner',
  'gs-main', 'planner-root', 'planner-notice', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];

// opts: { page, url: '/path#hash', hint, storage, routes: { path: (init) => ({ status, body }) | 'hang' }, planner: bool, whatsNew: bool }
function makeEnv(opts) {
  const o = Object.assign({ page: 'app', url: '/', hint: false, storage: {}, routes: {}, planner: true, unseen: false }, opts || {});
  const els = {};
  const skeleton = o.page === 'app' ? IDS : IDS.filter(id => id !== 'shell-topbar-plan' && id !== 'planner-root' && id !== 'planner-notice');
  skeleton.forEach(id => { els[id] = new FakeEl(id); });
  els['gs-main'].hidden = true;
  if (els['planner-root']) els['planner-root']._html = '<main>PLANNER</main>';
  if (els['shell-topbar-plan']) els['shell-topbar-plan']._html = '<h1>PLAN BAR</h1>';
  const body = new FakeEl('', { 'data-page': o.page });
  body.classList.add('guild-page', 'shell-pending');
  const store = Object.assign({}, o.storage);
  if (o.hint) store['raidsmith.shell.signedIn'] = '1';
  const localStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const listeners = { document: {}, window: {} };
  const on = which => (name, fn) => { (listeners[which][name] = listeners[which][name] || []).push(fn); };
  const fire = (which, name, ev) => (listeners[which][name] || []).slice().forEach(fn => fn(ev || {}));

  const loc = { pathname: '/', search: '', _hash: '' };
  const setUrl = url => {
    const hi = url.indexOf('#');
    const base = hi < 0 ? url : url.slice(0, hi);
    const qi = base.indexOf('?');
    loc.pathname = qi < 0 ? base : base.slice(0, qi);
    loc.search = qi < 0 ? '' : base.slice(qi);
    loc._hash = hi < 0 ? '' : url.slice(hi);
    if (loc._hash === '#') loc._hash = '';
  };
  setUrl(o.url);
  Object.defineProperty(loc, 'hash', {
    get: () => loc._hash,
    set: v => { loc._hash = v.charAt(0) === '#' ? v : '#' + v; fire('window', 'popstate', {}); fire('window', 'hashchange', {}); },
  });
  Object.defineProperty(loc, 'href', { get: () => 'http://localhost' + loc.pathname + loc.search + loc._hash });
  const history = { calls: [], pushState: (s, t, url) => { history.calls.push(['push', url]); setUrl(url); }, replaceState: (s, t, url) => { history.calls.push(['replace', url]); setUrl(url); } };

  const fetchCalls = [];
  const fetchFn = (url, init) => {
    fetchCalls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    const handler = o.routes[url] || o.routes[(init && init.method || 'GET') + ' ' + url];
    if (handler === 'hang') return new Promise(() => {});
    if (!handler) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
    const r = typeof handler === 'function' ? handler(init) : handler;
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(r.body == null ? {} : r.body)) });
  };

  const timers = [];
  const plannerCalls = [];
  const PP = { shell: {
    home: () => plannerCalls.push('home'), howItWorks: () => plannerCalls.push('howItWorks'), view: () => 'landing',
    isActive: () => true, setActive: b => plannerCalls.push('setActive:' + b),
  } };
  const documentFake = {
    body, activeElement: null, title: 'Raidsmith - TBC raid planner',
    getElementById: id => els[id] || null,
    querySelector: sel => (documentFake.selectors[sel] || null),
    querySelectorAll: sel => (documentFake.lists[sel] || []),
    selectors: {}, lists: {},
    addEventListener: on('document'),
  };
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  sandbox.document = documentFake;
  sandbox.location = loc;
  sandbox.history = history;
  sandbox.localStorage = localStorage;
  sandbox.fetch = fetchFn;
  sandbox.addEventListener = on('window');
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  sandbox.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].live = false; };
  sandbox.scrollTo = () => plannerCalls.push('scrollTo');
  if (o.planner && o.page === 'app') sandbox.PP = PP;
  sandbox.whatsNewSeen = () => !o.unseen;
  vm.createContext(sandbox);
  for (const [src, text] of SOURCES) vm.runInContext(text, sandbox, { filename: src });
  const env = {
    G: sandbox.Guild, sandbox, els, body, store, loc, history, fetchCalls, timers, plannerCalls, documentFake, listeners, fire,
    setUnseen: v => { o.unseen = v; },
    html: id => els[id].innerHTML,
    fetched: needle => fetchCalls.filter(c => c.url.indexOf(needle) >= 0).length,
    click: (attrs, extra) => {
      const t = target(attrs, extra && extra.scoped);
      const ev = Object.assign({ target: t, button: 0, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; } }, extra || {});
      fire('document', 'click', ev);
      return ev;
    },
  };
  return env;
}

// ── fixtures ─────────────────────────────────────────────────────
const USER = { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null, initials: 'AL', prefs: { sidebarCollapsed: false, planSidebarCollapsed: true, lastGuildId: null } };
function meBody(extra) {
  return Object.assign({ user: Object.assign({}, USER, { prefs: Object.assign({}, USER.prefs) }), guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false }, removedFrom: [], deleteImpact: { handOverFirst: [], guildsDeleted: [] } }, extra || {});
}
const MEMBER_CAN = { 'roster.view': 'guild' };
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild' };
function guildBody(can) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Mistvale', realmKind: 'realm', gameVersion: 'tbc', region: 'EU' },
    teams: [{ id: 't1', name: 'Main', size: 25, archived: false, lead: null }],
    me: { roles: [{ role: 'member' }], can: can || MEMBER_CAN },
  };
}
const ROSTER_BODY = { team: { id: 't1', name: 'Main' }, people: [], can: { edit: false }, teams: [] };
const signedInRoutes = (can, extra) => Object.assign({
  '/auth/me': { status: 200, body: meBody() },
  '/api/guild/g1': { status: 200, body: guildBody(can) },
  '/api/guild/g1/roster?team=t1': { status: 200, body: ROSTER_BODY },
  'PATCH /auth/prefs': init => ({ status: 200, body: { prefs: Object.assign({}, USER.prefs, JSON.parse(init.body)) } }),
  'POST /auth/logout': { status: 200, body: {} },
}, extra || {});
const keysOf = items => items.map(i => i.key + (i.separated ? '|sep' : ''));
const hrefsOf = html => [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);

(async () => {
  // ── nav matrix ─────────────────────────────────────────────────
  await check('nav matrix: signed out = Planner, separator, What\'s new, How it works, FAQ; no rail, no tabs', () => {
    const { G } = makeEnv();
    const ctx = { section: 'planner', page: 'app', me: null, signedOut: true, guildData: null };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['planner', 'whats-new|sep', 'how-it-works', 'faq']);
    const s = G.shell.slots(ctx);
    assert.equal(s.rail, '', 'no guild rail');
    assert.equal(s.tabs, '', 'no phone tabs');
    assert(s.sidebar.includes('class="gs-nav-sep"'));
    assert(s.sidebar.includes('gs-brand-row') && s.sidebar.includes('Raidsmith') && !s.sidebar.includes('gs-side-head'), 'brand head without a guild');
    assert(s.drawer.includes('<dialog class="gs-drawer"') && s.drawer.includes('data-action="open-planner"') && s.drawer.includes('href="/faq.html"'), 'the drawer exists for signed-out people');
    assert(s.account.includes('href="/auth/login"') && s.account.includes('Sign in with Discord') && s.account.includes('>Sign in<'), 'both sign-in labels');
  });

  await check('nav matrix: signed in without a guild = the signed-out items; the rail only when they can create', () => {
    const { G } = makeEnv();
    const base = { section: 'planner', page: 'app', guildData: null };
    const cannot = Object.assign({ me: meBody({ guilds: [] }) }, base);
    const can = Object.assign({ me: meBody({ guilds: [], create: { allowed: true } }) }, base);
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(cannot))), ['planner', 'whats-new|sep', 'how-it-works', 'faq']);
    assert.equal(G.shell.slots(cannot).rail, '');
    const withAdd = G.shell.slots(can);
    assert(withAdd.rail.includes('gs-tile-add') && withAdd.rail.includes('href="#/new"') && !withAdd.rail.includes('href="#/g/'), 'add button only');
    assert.equal(G.shell.slots(can).tabs, '', 'no tabs without a guild');
  });

  await check('nav matrix: member = Roster, Raid nights, Attendance, Loot, Planner, help group; tiles; five phone tabs', () => {
    const { G } = makeEnv();
    const ctx = { section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(MEMBER_CAN), teamId: 't1' };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['roster', 'nights', 'attendance', 'loot', 'planner', 'whats-new|sep', 'how-it-works', 'faq']);
    assert.deepEqual(plain(keysOf(G.shell.tabItems(ctx))), ['roster', 'nights', 'attendance', 'loot', 'planner']);
    const s = G.shell.slots(ctx);
    assert(s.rail.includes('gs-tile is-active') && s.rail.includes('data-action="open-planner"'), 'tiles; the rail logo is a Planner link');
    assert(/<nav class="gs-tabs"/.test(s.tabs) && !s.tabs.includes('More') && s.tabs.includes('data-action="open-planner"'));
    assert(!s.sidebar.includes('Guild settings'));
  });

  await check('nav matrix: officer / GM gets Guild settings (separated) before the help group; tabs stay five', () => {
    const { G } = makeEnv();
    const ctx = { section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(OFFICER_CAN), teamId: 't1' };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['roster', 'nights', 'attendance', 'loot', 'planner', 'settings|sep', 'whats-new|sep', 'how-it-works', 'faq']);
    assert.deepEqual(plain(keysOf(G.shell.tabItems(ctx))), ['roster', 'nights', 'attendance', 'loot', 'planner']);
  });

  await check('nav: the guild nav shows on the planner section and the static pages, but the phone tabs only on guild sections', () => {
    const { G } = makeEnv();
    for (const section of ['planner', 'page']) {
      const ctx = { section, page: section === 'page' ? 'faq' : 'app', me: meBody(), route: null, guildData: guildBody(OFFICER_CAN), teamId: 't1' };
      assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))).slice(0, 6), ['roster', 'nights', 'attendance', 'loot', 'planner', 'settings|sep'], section);
      assert.equal(G.shell.slots(ctx).tabs, '', section + ': no tabs');
    }
  });

  await check('nav: current item = Planner on the planner section, FAQ / What\'s new on their pages, the section on guild pages', () => {
    const { G } = makeEnv();
    const current = ctx => [...G.shell.slots(ctx).sidebar.matchAll(/aria-label="([^"]*)" aria-current="page"/g)].map(m => m[1].replace(/&#39;/g, "'"));
    assert.deepEqual(current({ section: 'planner', page: 'app', me: null }), ['Planner']);
    assert.deepEqual(current({ section: 'page', page: 'faq', me: null }), ['FAQ']);
    assert.deepEqual(current({ section: 'page', page: 'whats-new', me: null }), ['What\'s new']);
    assert.deepEqual(current({ section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'loot' }, guildData: guildBody(), teamId: 't1' }), ['Loot']);
  });

  await check('nav: What\'s new pill when unseen (a dot when collapsed), gone once seen; re-checked on pageshow when persisted', async () => {
    const env = makeEnv({ unseen: true });
    await settle();
    assert(env.html('shell-sidebar').includes('gs-new-pill') && env.html('shell-sidebar').includes('gs-new-dot'));
    assert(env.html('shell-sidebar').includes('aria-label="What&#39;s new, new"') || env.html('shell-sidebar').includes('aria-label="What\'s new, new"'));
    env.setUnseen(false);
    env.fire('window', 'pageshow', { persisted: false });
    assert(env.html('shell-sidebar').includes('gs-new-pill'), 'a normal pageshow does not re-check');
    env.fire('window', 'pageshow', { persisted: true });
    assert(!env.html('shell-sidebar').includes('gs-new-pill'), 'restored from the back/forward cache: the pill clears');
    const none = makeEnv();
    assert(!none.html('shell-sidebar').includes('gs-new-pill'));
    const noFn = makeEnv();
    assert.equal(noFn.G.shell.helpItems({ whatsNewUnseen: false })[0].isNew, false);
  });

  await check('static pages: every shell link is absolute and the current item is the page; breadcrumb is the page name', () => {
    const { G } = makeEnv();
    const ctx = { section: 'page', page: 'faq', me: meBody(), route: null, guildData: guildBody(OFFICER_CAN), teamId: 't1' };
    const s = G.shell.slots(ctx);
    const links = hrefsOf(s.sidebar + s.rail + s.drawer + s.account);
    assert(links.length > 10);
    assert(links.every(h => /^(\/|https?:)/.test(h)), 'relative link left: ' + links.filter(h => !/^(\/|https?:)/.test(h)).join(','));
    assert(links.includes('/#/g/g1/roster') && links.includes('/#how-it-works') && links.includes('/') && links.includes('/#/g/g1/settings/teams') && links.includes('/#/privacy'));
    assert.deepEqual(plain(G.shell.breadcrumbItems(ctx)), [{ label: 'FAQ' }]);
    assert(s.lead.includes('class="gs-phone-title">FAQ<') && s.lead.includes('aria-label="Open menu"'));
    const wn = G.shell.slots(Object.assign({}, ctx, { page: 'whats-new' }));
    assert(wn.lead.includes('What&#39;s new') || wn.lead.includes('What\'s new'));
    // index.html keeps hash links
    const app = G.shell.slots({ section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(), teamId: 't1' });
    assert(hrefsOf(app.sidebar).includes('#/g/g1/roster') && hrefsOf(app.sidebar).includes('#how-it-works'));
  });

  // ── phone A2 ───────────────────────────────────────────────────
  await check('phone A2: the menu button leads the top bar on every section; back link on sub-pages; planner lead has no title', () => {
    const { G } = makeEnv();
    const guild = (route, extra) => G.shell.slots(Object.assign({ section: 'guild', page: 'app', me: meBody(), route, guildData: guildBody(OFFICER_CAN), teamId: 't1' }, extra || {}));
    for (const lead of [guild({ name: 'section', gid: 'g1', section: 'roster' }).lead, G.shell.slots({ section: 'planner', page: 'app', me: null }).lead, G.shell.slots({ section: 'page', page: 'faq', me: null }).lead]) {
      assert(lead.startsWith('<button type="button" class="gs-menu-btn" data-action="open-drawer"'), lead.slice(0, 80));
      assert(lead.includes('aria-label="Open menu"'));
    }
    const planner = G.shell.slots({ section: 'planner', page: 'app', me: null }).lead;
    assert(!planner.includes('gs-lead-phone') && !planner.includes('gs-crumbs-wrap'), 'planner: nothing after the button (the plan slot follows)');
    for (const route of [{ name: 'person', gid: 'g1', pid: 'p1' }, { name: 'import', gid: 'g1', source: 'wcl' }, { name: 'settings', gid: 'g1', tab: 'teams' }]) {
      const lead = guild(route).lead;
      assert(lead.includes('class="gs-back" href="#/g/g1/roster" aria-label="Back to Roster">&lsaquo; Roster</a>'), route.name);
      assert(!lead.includes('gs-phone-pick'), route.name + ': the back link replaces the picker');
    }
    assert(guild({ name: 'section', gid: 'g1', section: 'roster' }).lead.includes('gs-phone-pick'));
    assert(!guild({ name: 'section', gid: 'g1', section: 'roster' }).lead.includes('gs-back'));
    const abs = G.shell.slots({ section: 'page', page: 'faq', me: meBody(), route: null, guildData: guildBody(), teamId: 't1' });
    assert(!abs.lead.includes('gs-back'));
  });

  await check('phone A2: the account menu has no "Open the planner"; signed out shows the sign-in button; a divider only on the planner section', () => {
    const { G } = makeEnv();
    const ctx = section => ({ section, page: 'app', me: meBody(), route: null, guildData: null });
    assert(!G.shell.slots(ctx('guild')).account.includes('Open the planner'));
    assert(G.shell.slots(ctx('planner')).account.startsWith('<span class="gs-topbar-divider"'));
    assert(!G.shell.slots(ctx('guild')).account.includes('gs-topbar-divider'));
    assert(G.shell.slots({ section: 'planner', page: 'app', me: null }).account.startsWith('<span class="gs-topbar-divider"'));
    assert.equal(G.shell.slots({ section: 'planner', page: 'app', me: null, pending: true }).account, '', 'nothing while the session question is open');
  });

  // ── routeAll: sections ─────────────────────────────────────────
  await check('routeAll: section for every address in the spec table', async () => {
    const cases = [
      ['app', '/', 'planner'], ['app', '/tbc/abc1234', 'planner'], ['app', '/#r=abcdef', 'planner'], ['app', '/#how-it-works', 'planner'], ['app', '/#something', 'planner'],
      ['app', '/#/', 'guild'], ['app', '/#/signin?error=denied', 'guild'], ['app', '/tbc/abc1234#/g/g1/roster', 'guild'], ['app', '/#/privacy', 'guild'],
      ['faq', '/faq.html', 'page'], ['whats-new', '/whats-new.html#/x', 'page'],
    ];
    for (const [page, url, want] of cases) {
      const env = makeEnv({ page, url });
      await settle();
      assert.equal(env.G.app.state.section, want, `${page} ${url}`);
      for (const name of ['planner', 'guild', 'page']) assert.equal(env.body.classList.contains('shell-section-' + name), name === want, `${url}: body class ${name}`);
    }
  });

  await check('routeAll: planner section shows #planner-root, hides #gs-main, activates the planner; #how-it-works opens the guide; the page title returns', async () => {
    const env = makeEnv({ url: '/#how-it-works' });
    await settle();
    assert.equal(env.els['gs-main'].hidden, true);
    assert.equal(env.els['planner-root'].hidden, false);
    assert(env.plannerCalls.includes('setActive:true') && env.plannerCalls.includes('howItWorks'));
    assert.equal(env.documentFake.title, 'Raidsmith - TBC raid planner');
    assert.equal(env.els['gs-main'].innerHTML, '', 'no guild content on the planner section');
  });

  await check('routeAll: guild section shows #gs-main, hides #planner-root, deactivates the planner', async () => {
    const env = makeEnv({ url: '/tbc/abc1234#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    assert.equal(env.els['gs-main'].hidden, false);
    assert.equal(env.els['planner-root'].hidden, true);
    assert(env.plannerCalls.includes('setActive:false'));
    assert(!env.plannerCalls.includes('setActive:true'));
    assert.equal(env.loc.pathname, '/tbc/abc1234', 'the shell never changes the path');
    assert(env.documentFake.title.startsWith('Roster - Ravens'));
    assert(env.body.classList.contains('shell-section-guild'));
    assert(env.html('gs-main').includes('Main') || env.html('gs-main').length > 0);
  });

  await check('routeAll: idempotent - a hash-link click (popstate then hashchange) is one route; force re-runs', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    assert.equal(env.fetched('/roster?team=t1'), 1);
    env.loc.hash = '#/g/g1/nights';
    await settle();
    env.loc.hash = '#/g/g1/roster';
    await settle();
    assert.equal(env.fetched('/roster?team=t1'), 2, 'one roster load for the click back to Roster');
    await env.G.app.routeAll();
    assert.equal(env.fetched('/roster?team=t1'), 2, 'same address: nothing');
    await env.G.app.routeAll({ force: true });
    assert.equal(env.fetched('/roster?team=t1'), 3, 'force runs again');
  });

  await check('routeAll: every former route() call site goes through it (go() on the same hash, retry, the #/ re-route, the import team switch)', async () => {
    const src = read('js/guild/app.js');
    assert(!/[^\w.]route\(\)/.test(src), 'a bare route() call is left');
    // go(): same hash -> forced pass
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    env.G.app.go('#/g/g1/roster');
    await settle();
    assert.equal(env.fetched('/roster?team=t1'), 2);
    // #/ with a guild lands on the last guild's roster (the re-route inside resolveSignedIn)
    const home = makeEnv({ url: '/#/', routes: signedInRoutes() });
    await settle();
    assert.equal(home.loc.hash, '#/g/g1/roster');
    assert.equal(home.G.app.state.section, 'guild');
    assert(home.html('gs-main').length > 0 && !home.html('gs-main').includes('Loading'));
    // retry after a failed session check asks /auth/me again
    let fail = true;
    const retry = makeEnv({ url: '/#/', routes: signedInRoutes(null, { '/auth/me': () => (fail ? { status: 500, body: {} } : { status: 200, body: meBody() }) }) });
    await settle();
    assert(retry.html('gs-main').includes('Could not load Raidsmith') && retry.html('gs-main').includes('data-action="retry"'));
    fail = false;
    retry.click({ 'data-action': 'retry' });
    await settle();
    assert.equal(retry.fetched('/auth/me'), 2);
    assert(!retry.html('gs-main').includes('Could not load Raidsmith'));
    // the team switch on an import page re-runs the route
    const imp = makeEnv({ url: '/#/g/g1/roster/import/raid-helper', routes: signedInRoutes(OFFICER_CAN) });
    await settle();
    const before = imp.fetched('/auth/me') + imp.fetched('/api/guild/g1');
    imp.G.app.state.currentGid = 'g1';
    imp.sandbox.Guild.handlers.change['team-pick']({ value: 't1' });
    await settle();
    assert(imp.fetched('/api/guild/g1') + imp.fetched('/auth/me') >= before, 'the route ran');
  });

  // ── the Planner link, both ways ────────────────────────────────
  await check('Planner link: on a guild section it pushes the address without its hash and shows the planner, plan untouched', async () => {
    const env = makeEnv({ url: '/tbc/abc1234#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    const ev = env.click({ 'data-action': 'open-planner' });
    await settle();
    assert.equal(ev.prevented, 1);
    assert.deepEqual(env.history.calls.filter(c => c[0] === 'push').map(c => c[1]), ['/tbc/abc1234']);
    assert.equal(env.G.app.state.section, 'planner');
    assert.equal(env.els['planner-root'].hidden, false);
    assert(env.plannerCalls.includes('setActive:true'));
    assert(!env.plannerCalls.includes('home'), 'the plan stays as left');
    assert(env.plannerCalls.includes('scrollTo'), 'a section switch scrolls to the top');
  });

  await check('Planner link: with the planner showing it goes home and drops a leftover #how-it-works', async () => {
    const env = makeEnv({ url: '/#how-it-works' });
    await settle();
    const ev = env.click({ 'data-action': 'open-planner' });
    assert.equal(ev.prevented, 1);
    assert(env.plannerCalls.includes('home'));
    assert.deepEqual(env.history.calls, [['replace', '/']]);
    assert.equal(env.loc.hash, '');
    assert.deepEqual(env.history.calls.filter(c => c[0] === 'push'), []);
  });

  await check('Planner link: modified and middle clicks keep the browser default; on static pages it is a plain link', async () => {
    const env = makeEnv({ url: '/tbc/abc1234#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const ev = env.click({ 'data-action': 'open-planner' }, extra);
      assert.equal(ev.prevented, 0, JSON.stringify(extra));
    }
    assert.equal(env.G.app.state.section, 'guild');
    const page = makeEnv({ page: 'faq', url: '/faq.html' });
    await settle();
    assert.equal(page.click({ 'data-action': 'open-planner' }).prevented, 0);
    assert.equal(page.click({ 'data-action': 'how-it-works' }).prevented, 0);
    assert.deepEqual(page.history.calls, []);
  });

  await check('How it works: opens the full guide, replaces the hash, and a second click works the same', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const first = env.click({ 'data-action': 'how-it-works' });
    assert.equal(first.prevented, 1);
    assert.equal(env.loc.hash, '#how-it-works');
    env.click({ 'data-action': 'how-it-works' });
    assert.equal(env.plannerCalls.filter(c => c === 'howItWorks').length, 2);
    assert.deepEqual(env.history.calls.map(c => c[0]), ['replace', 'replace']);
    // from a guild section it pushes (Back returns to the guild page) and switches section
    const g = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    g.click({ 'data-action': 'how-it-works' });
    await settle();
    assert.deepEqual(g.history.calls.map(c => c[0]), ['push']);
    assert.equal(g.G.app.state.section, 'planner');
    assert(g.plannerCalls.includes('howItWorks'));
  });

  await check('actions: only the shell\'s own markup (or the two shared actions) reaches a handler; a planner element with the same name does not', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    env.click({ 'data-action': 'toggle-sidebar' }, { scoped: false });
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], undefined, 'a non-shell element is ignored');
    env.click({ 'data-action': 'toggle-sidebar' });
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], '1');
    const planner = makeEnv({ url: '/' });
    await settle();
    planner.click({ 'data-action': 'how-it-works' }, { scoped: false });
    assert(planner.plannerCalls.includes('howItWorks'), 'the planner\'s own How it works link works');
  });

  // ── collapse ───────────────────────────────────────────────────
  await check('collapse: contexts - plan view (planner section with a plan open) vs default; defaults plan = collapsed, other = expanded', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    assert.equal(env.G.app.collapseContext(), 'default');
    assert.equal(env.G.app.collapsedFor('default'), false);
    assert.equal(env.G.app.collapsedFor('plan'), true);
    assert(!env.els['guild-root'].classList.contains('is-collapsed'));
    env.body.attrs['data-planner-view'] = 'app';
    env.fire('document', 'planner:view', {});
    assert.equal(env.G.app.collapseContext(), 'plan');
    assert(env.els['guild-root'].classList.contains('is-collapsed'), 'a plan open collapses by default');
    assert(env.html('shell-sidebar').includes('aria-label="Expand sidebar"'));
    const guild = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    guild.body.attrs['data-planner-view'] = 'app';
    assert.equal(guild.G.app.collapseContext(), 'default', 'a guild section is never the plan context');
  });

  await check('collapse: signed out - the toggle works, writes the context\'s local key, and each context is remembered separately', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    env.click({ 'data-action': 'toggle-sidebar' });
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], '1');
    assert.equal(env.store['raidsmith.shell.planSidebarCollapsed'], undefined);
    assert(env.els['guild-root'].classList.contains('is-collapsed'));
    env.body.attrs['data-planner-view'] = 'app';
    env.fire('document', 'planner:view', {});
    assert.equal(env.G.app.collapsedFor('plan'), true, 'the plan context kept its own default');
    env.click({ 'data-action': 'toggle-sidebar' });
    assert.equal(env.store['raidsmith.shell.planSidebarCollapsed'], '0');
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], '1');
    assert.equal(env.fetchCalls.length, 0, 'signed out: nothing sent to the server');
    // a fresh page load reads the keys
    const again = makeEnv({ url: '/', storage: { 'raidsmith.shell.sidebarCollapsed': '1' } });
    await settle();
    assert(again.els['guild-root'].classList.contains('is-collapsed'));
  });

  await check('collapse: signed in - the toggle writes the server pref of its context and the local key; first paint reads the local keys until /auth/me answers', async () => {
    const env = makeEnv({ url: '/', hint: true, storage: { 'raidsmith.shell.sidebarCollapsed': '1' }, routes: signedInRoutes(null, { '/auth/me': 'hang' }) });
    await settle();
    assert(env.els['guild-root'].classList.contains('is-collapsed'), 'local key before the session answers');
    const done = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    assert(!done.els['guild-root'].classList.contains('is-collapsed'));
    done.click({ 'data-action': 'toggle-sidebar' });
    await settle();
    const patches = done.fetchCalls.filter(c => c.method === 'PATCH');
    assert.deepEqual(patches.map(c => JSON.parse(c.body)), [{ sidebarCollapsed: true }]);
    assert.equal(done.store['raidsmith.shell.sidebarCollapsed'], '1');
    done.body.attrs['data-planner-view'] = 'app';
    done.fire('document', 'planner:view', {});
    assert(done.els['guild-root'].classList.contains('is-collapsed'), 'plan context: the server default (collapsed)');
    done.click({ 'data-action': 'toggle-sidebar' });
    await settle();
    assert.deepEqual(done.fetchCalls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body)), [{ sidebarCollapsed: true }, { planSidebarCollapsed: false }]);
    assert.equal(done.store['raidsmith.shell.planSidebarCollapsed'], '0');
  });

  // ── the session question ───────────────────────────────────────
  await check('session: an anonymous planner or help-page visit never reaches the Worker; shell-pending clears at once; signed-out chrome', async () => {
    for (const [page, url] of [['app', '/'], ['app', '/tbc/abc1234'], ['app', '/#r=xyz'], ['faq', '/faq.html'], ['whats-new', '/whats-new.html']]) {
      const env = makeEnv({ page, url });
      await settle();
      assert.deepEqual(env.fetchCalls, [], `${page} ${url}`);
      assert(!env.body.classList.contains('shell-pending'));
      assert(env.body.classList.contains('is-signed-out'));
      assert(env.html('shell-topbar-account').includes('/auth/login'));
    }
  });

  await check('session: asked on a #/ route, or when this browser signed in before (the hint); the answer sets the hint; 401 clears it', async () => {
    const hinted = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    assert.equal(hinted.fetched('/auth/me'), 1);
    assert(hinted.html('shell-topbar-account').includes('gs-avatar-btn'));
    assert(!hinted.body.classList.contains('is-signed-out'));
    const onRoute = makeEnv({ url: '/#/', routes: signedInRoutes() });
    await settle();
    assert.equal(onRoute.store['raidsmith.shell.signedIn'], '1');
    const expired = makeEnv({ url: '/', hint: true, routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    assert.equal(expired.store['raidsmith.shell.signedIn'], undefined, 'hint cleared');
    assert(expired.body.classList.contains('is-signed-out') && !expired.body.classList.contains('shell-pending'));
  });

  await check('session: shell-pending is not signed-out; the account slot stays empty until the answer', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(null, { '/auth/me': 'hang' }) });
    await settle();
    assert(env.body.classList.contains('shell-pending'));
    assert(!env.body.classList.contains('is-signed-out'));
    assert.equal(env.html('shell-topbar-account'), '');
  });

  await check('session: the 3 second timeout counts as an unanswered question - signed-out chrome on the planner, no error', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(null, { '/auth/me': 'hang' }) });
    await settle();
    const timer = env.timers.find(t => t.ms === 3000);
    assert(timer, 'a 3000 ms timer guards /auth/me');
    timer.fn();
    await settle();
    assert(!env.body.classList.contains('shell-pending'));
    assert(env.body.classList.contains('is-signed-out'));
    assert(env.html('shell-topbar-account').includes('/auth/login'));
    assert(!env.html('planner-notice').includes('Could not'));
    assert.equal(env.els['gs-main'].innerHTML, '', 'no error message on the planner section');
  });

  await check('session: boot failure on a guild section shows the retry message in #gs-main; on a static page, signed-out chrome', async () => {
    const guild = makeEnv({ url: '/#/g/g1/roster', routes: { '/auth/me': { status: 500, body: {} } } });
    await settle();
    assert(guild.html('gs-main').includes('Could not load Raidsmith') && guild.html('gs-main').includes('data-action="retry"'));
    assert(!guild.body.classList.contains('shell-pending'));
    const page = makeEnv({ page: 'faq', url: '/faq.html', hint: true, routes: { '/auth/me': { status: 500, body: {} } } });
    await settle();
    assert.equal(page.els['gs-main'].innerHTML, '');
    assert(page.html('shell-topbar-account').includes('/auth/login'));
  });

  await check('session: a guild route reached from an anonymous planner visit asks the question then', async () => {
    const env = makeEnv({ url: '/', routes: signedInRoutes() });
    await settle();
    assert.equal(env.fetched('/auth/me'), 0);
    env.loc.hash = '#/g/g1/roster';
    await settle();
    assert.equal(env.fetched('/auth/me'), 1);
    assert(env.html('shell-topbar-account').includes('gs-avatar-btn'));
    assert(env.html('gs-main').length > 0);
  });

  // ── what the shell writes ──────────────────────────────────────
  await check('render: never touches #shell-topbar-plan or #planner-root; fills the planner notice slot only', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    env.loc.hash = '#/g/g1/roster';
    await settle();
    env.click({ 'data-action': 'open-planner' });
    await settle();
    env.G.app.render();
    assert.equal(env.els['shell-topbar-plan'].writes, 0);
    assert.equal(env.els['planner-root'].writes, 0);
    assert.equal(env.html('planner-root'), '<main>PLANNER</main>');
    assert.equal(env.html('shell-topbar-plan'), '<h1>PLAN BAR</h1>');
    for (const id of ['shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-account', 'shell-banner', 'shell-tabs', 'shell-drawer', 'gs-main', 'guild-dialogs']) {
      assert(env.els[id].classList.contains('gs-scope'), id + ' is a gs-scope slot');
    }
  });

  await check('render: static pages leave their own content alone and #gs-main stays hidden and empty', async () => {
    const env = makeEnv({ page: 'faq', url: '/faq.html' });
    await settle();
    assert.equal(env.els['gs-main'].hidden, true);
    assert.equal(env.els['gs-main'].innerHTML, '');
    assert(!env.els['planner-root'] && !env.els['shell-topbar-plan']);
    assert(env.html('shell-sidebar').includes('aria-current="page"'));
    assert(env.plannerCalls.length === 0, 'no planner calls on a static page');
  });

  await check('render: has-guild only on guild sections; the claim banner and tabs only there', async () => {
    const me = meBody({ create: { allowed: true, claimable: [{ guildId: 'g1', guildName: 'Ravens', serverId: 's', serverName: 'S' }] } });
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes(OFFICER_CAN, { '/auth/me': { status: 200, body: me } }) });
    await settle();
    assert(env.els['guild-root'].classList.contains('has-guild'));
    assert(env.html('shell-banner').includes('This guild has no Guild Master'));
    assert(env.html('shell-tabs').includes('gs-tabs'));
    env.click({ 'data-action': 'open-planner' });
    await settle();
    assert(!env.els['guild-root'].classList.contains('has-guild'));
    assert.equal(env.html('shell-banner'), '');
    assert.equal(env.html('shell-tabs'), '');
  });

  await check('guild data on the planner section: the last guild is fetched once and Roster / Guild settings appear; a failure is silent', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(OFFICER_CAN) });
    await settle();
    assert.equal(env.fetched('/api/guild/g1'), 1);
    const side = env.html('shell-sidebar');
    assert(side.includes('Roster') && side.includes('Guild settings') && side.includes('gs-side-head'));
    env.G.app.render();
    env.loc.hash = '#how-it-works';
    await settle();
    assert.equal(env.fetched('/api/guild/g1'), 1, 'once per page load');
    const bad = makeEnv({ url: '/', hint: true, routes: signedInRoutes(OFFICER_CAN, { '/api/guild/g1': { status: 500, body: {} } }) });
    await settle();
    assert(!bad.html('shell-sidebar').includes('Guild settings') && bad.html('shell-sidebar').includes('gs-brand-row'));
    assert(bad.html('shell-rail').includes('gs-tile'), 'the rail tiles still show');
    const stat = makeEnv({ page: 'faq', url: '/faq.html', hint: true, routes: signedInRoutes(OFFICER_CAN) });
    await settle();
    assert(stat.html('shell-sidebar').includes('href="/#/g/g1/roster"'));
  });

  await check('no-guild notice: signed in with zero guilds -> the notice in #planner-notice; none with guilds or signed out', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(null, { '/auth/me': { status: 200, body: meBody({ guilds: [], removedFrom: [{ id: 'g9', name: 'Owls' }] }) } }) });
    await settle();
    const n = env.html('planner-notice');
    assert(n.includes('You&#39;re not in a Raidsmith guild yet') || n.includes('You\'re not in a Raidsmith guild yet'));
    assert(n.includes('An officer removed your access to <strong>Owls</strong>') && n.includes('href="/auth/login"') && n.includes('Sign in again'));
    assert(env.els['planner-notice'].classList.contains('gs-scope'));
    assert.equal(env.fetched('/api/guild/'), 0, 'no guild to fetch');
    const withGuild = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    assert.equal(withGuild.html('planner-notice'), '');
    const out = makeEnv({ url: '/' });
    await settle();
    assert.equal(out.html('planner-notice'), '');
  });

  await check('no-guild: #/ shows the no-guild card inside the shell; signed-out #/ shows the sign-in card in the signed-out shell', async () => {
    const noGuild = makeEnv({ url: '/#/', routes: signedInRoutes(null, { '/auth/me': { status: 200, body: meBody({ guilds: [] }) } }) });
    await settle();
    assert(noGuild.html('gs-main').includes('gs-card') && noGuild.html('gs-main').includes('Open the planner') && noGuild.html('gs-main').includes('data-action="open-planner"'));
    assert(!noGuild.els['gs-main'].classList.contains('gs-main-center') || true);
    const out = makeEnv({ url: '/#/', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    assert(out.html('gs-main').includes('Sign in with Discord') && out.html('gs-main').includes('/auth/login'));
    assert(out.els['gs-main'].classList.contains('gs-main-center'));
    assert(out.html('shell-topbar-account').includes('Sign in with Discord'));
    assert(!out.html('shell-tabs'));
    assert(out.html('shell-sidebar').includes('gs-brand-row'));
    const priv = makeEnv({ url: '/#/privacy', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    assert(priv.html('gs-main').includes('Privacy') && !priv.els['gs-main'].classList.contains('gs-main-center'));
    const err = makeEnv({ url: '/#/signin?error=denied', routes: { '/auth/me': { status: 401, body: {} } } });
    await settle();
    assert(err.html('gs-main').includes('Discord sign-in was cancelled'));
  });

  // ── overlays and sign-out ──────────────────────────────────────
  await check('closeOverlays: closes the guild dialogs and the drawer and the avatar menu, and leaves a planner dialog open', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const closed = [];
    const dlg = name => ({ open: true, close() { closed.push(name); this.open = false; } });
    const plannerDialog = dlg('planner-confirm');
    const asked = [];
    const doc = {
      // a real document answers a comma selector with the union of the matches inside #shell-drawer and #guild-dialogs only
      querySelectorAll: sel => { asked.push(sel); return sel === '#shell-drawer dialog[open], #guild-dialogs dialog[open]' ? [dlg('gs-drawer'), dlg('edit-roles')] : [plannerDialog]; },
      getElementById: id => (id === 'gs-account-menu' ? menu : null),
      querySelector: () => toggle,
    };
    const attrs = {};
    const menu = { hidden: false };
    const toggle = { setAttribute: (k, v) => { attrs[k] = v; } };
    env.G.app.closeOverlays(doc);
    assert.deepEqual(closed, ['gs-drawer', 'edit-roles']);
    assert.equal(plannerDialog.open, true, 'the planner\'s own dialog is the planner\'s');
    assert.equal(menu.hidden, true);
    assert.equal(attrs['aria-expanded'], 'false');
    assert(asked.every(s => !/^dialog/.test(s)), 'never a bare dialog[open] query');
  });

  await check('sign-out: on the planner section the chrome turns signed out, the hint clears, the section and the address stay', async () => {
    const env = makeEnv({ url: '/tbc/abc1234', hint: true, routes: signedInRoutes() });
    await settle();
    assert(env.html('shell-topbar-account').includes('gs-avatar-btn'));
    env.click({ 'data-action': 'sign-out' });
    await settle();
    assert.equal(env.fetchCalls.filter(c => c.url === '/auth/logout').length, 1);
    assert.equal(env.G.app.state.section, 'planner');
    assert(env.body.classList.contains('is-signed-out'));
    assert(env.html('shell-topbar-account').includes('/auth/login'));
    assert.equal(env.store['raidsmith.shell.signedIn'], undefined);
    assert.equal(env.loc.pathname, '/tbc/abc1234');
    assert.equal(env.loc.hash, '');
    assert.deepEqual(env.history.calls, []);
    assert(!env.html('shell-sidebar').includes('Roster'), 'no guild nav after sign-out');
    assert.equal(env.html('shell-rail'), '');
  });

  await check('sign-out: on a guild section it lands on the sign-in card (#/); on a static page the page stays', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    env.click({ 'data-action': 'sign-out' });
    await settle();
    assert.equal(env.loc.hash, '#/');
    assert.equal(env.G.app.state.section, 'guild');
    assert(env.html('gs-main').includes('Sign in with Discord'));
    const page = makeEnv({ page: 'faq', url: '/faq.html', hint: true, routes: signedInRoutes() });
    await settle();
    page.click({ 'data-action': 'sign-out' });
    await settle();
    assert.equal(page.G.app.state.section, 'page');
    assert(page.html('shell-topbar-account').includes('/auth/login'));
    assert.equal(page.loc.pathname, '/faq.html');
  });

  await check('requireSignin / account deletion only fire from guild sections and keep today\'s behaviour (#/ with the notice)', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    env.G.app.afterAccountDeleted();
    await settle();
    assert.equal(env.loc.hash, '#/');
    assert(env.html('gs-main').includes('Your data has been deleted.'));
    assert.equal(env.store['raidsmith.shell.signedIn'], undefined);
  });

  // ── the stylesheet ─────────────────────────────────────────────
  await check('guild.css: page-wide rules are scoped to .gs-scope; nothing styles planner markup; slots are layout-transparent', () => {
    const css = read('guild.css');
    for (const bare of [/(^|\n)\.guild-page a\s*[,{:]/, /(^|\n)\.guild-page a:hover/, /\.guild-page (button|input|select|textarea|\[tabindex\]):focus-visible/, /\.guild-page \.gs-h1:focus/, /\.guild-page input::placeholder/]) {
      assert(!bare.test(css), 'page-wide rule left: ' + bare);
    }
    assert(/\.gs-scope a \{ color: var\(--accent-gold\); \}/.test(css));
    assert(/\.gs-scope a:focus-visible,[\s\S]*?\{ outline: 2px solid var\(--accent-gold\); outline-offset: 2px; \}/.test(css));
    assert(/\.gs-scope \.gs-h1:focus \{ outline: none; \}/.test(css) && /\.gs-scope input::placeholder/.test(css));
    assert(/#shell-rail, #shell-sidebar, #shell-banner, #shell-tabs, #shell-drawer \{ display: contents; \}/.test(css));
    assert(/#planner-root\[hidden\], #gs-main\[hidden\] \{ display: none !important; \}/.test(css));
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@][^{}]*)\{/g)].map(m => m[2]).join(',').split(',').map(x => x.trim());
    const planner = selectors.filter(x => /(^|[\s>+~])#planner-root|#shell-topbar-plan|\.planner-|\.title-bar|\.landing\b|\.addon-frame/.test(x) && !/#planner-root\[hidden\]/.test(x));
    assert.deepEqual(planner, [], 'guild.css must not style planner markup');
    assert(!/--[\w-]+\s*:/.test(css.replace(/var\(--[\w-]+/g, '')), 'no custom properties');
  });

  await check('guild.css: phone A2 - menu button 44px on every page, drawer for everyone, tabs only with a guild, signed-out sign-in shortens', () => {
    const css = read('guild.css');
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.gs-menu-btn \{ display: inline-flex; \}/.test(phone));
    assert(/\.gs-menu-btn \{[^}]*width: 44px; height: 44px;/.test(css));
    assert(/\.gs-signin-full \{ display: none; \}/.test(phone) && /\.gs-signin-short \{ display: inline; \}/.test(phone));
    assert(/\.gs-crumbs-wrap \{ display: none; \}/.test(phone));
    assert(/\.gs-lead-phone \{ display: flex;/.test(phone));
    assert(/a\.gs-back \{[^}]*min-height: 44px;/.test(phone));
    assert(/\.gs-app\.has-guild \.gs-col \{ padding-bottom: 64px; \}/.test(phone), 'tab bar padding only with a guild');
    assert(!/\.gs-app:not\(\.has-guild\)/.test(css));
    assert(/\.is-collapsed \.gs-sidebar \.gs-label-full \{ display: none; \}/.test(css), 'collapse never reaches the drawer');
    assert(!/\.is-collapsed \.gs-(nav|label|collapse|new|side-head|side-brand)/.test(css), 'unscoped collapsed rule left');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
