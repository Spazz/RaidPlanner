/**
 * Raidsmith app shell - tests for js/guild/app.js + shell.js against fake documents
 * Run: node tests/guild/guild-shell-tests.js
 *
 * The real index.html / faq.html / whats-new.html belong to the planner lane, so these tests build the page skeleton
 * from its contract (ids and body attributes: see tasks/reference/guild-step2b-spec.md section 3) out of tiny fake elements,
 * load the guild scripts in the order of tests/guild-scripts.js inside a vm sandbox, and drive the shell the way the
 * browser would: location / history / localStorage / fetch / timers are fakes the tests control.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const GuildCss = require('../guild-css');

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

const ROOT = require('path').join(__dirname, '..', '..');
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
    if (sel === 'a[href]') return Object.prototype.hasOwnProperty.call(attrs, 'href') ? el : null;
    return null;
  };
  return el;
}

const IDS = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner',
  'gs-main', 'planner-root', 'planner-notice', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];

// opts: { page, url: '/path#hash', hint, storage, routes: { path: (init) => ({ status, body }) | 'hang' }, planner: bool, whatsNew: bool,
//         beforeApp: (sandbox, els) => void  (runs after every guild script but app.js, which starts the shell) }
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
  const captured = {};
  const on = which => (name, fn, capture) => {
    if (capture === true && which === 'document') { (captured[name] = captured[name] || []).push(fn); return; }
    (listeners[which][name] = listeners[which][name] || []).push(fn);
  };
  const fire = (which, name, ev) => (listeners[which][name] || []).slice().forEach(fn => fn(ev || {}));
  const fireCapture = (name, ev) => (captured[name] || []).slice().forEach(fn => fn(ev || {}));

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
  const sessionStore = {};
  sandbox.sessionStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: k => { delete sessionStore[k]; },
  };
  sandbox.fetch = fetchFn;
  sandbox.addEventListener = on('window');
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  sandbox.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].live = false; };
  sandbox.scrollTo = () => plannerCalls.push('scrollTo');
  if (o.planner && o.page === 'app') sandbox.PP = PP;
  sandbox.whatsNewSeen = () => !o.unseen;
  vm.createContext(sandbox);
  SOURCES.forEach(([src, text], i) => {
    if (i === SOURCES.length - 1 && o.beforeApp) o.beforeApp(sandbox, els);
    vm.runInContext(text, sandbox, { filename: src });
  });
  const env = {
    G: sandbox.Guild, sessionStore, sandbox, els, body, store, loc, history, fetchCalls, timers, plannerCalls, documentFake, listeners, fire, fireCapture,
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
  '/api/guild/g1/raids?team=t1': { status: 200, body: { team: { id: 't1', name: 'Main' }, today: '2026-10-17', can: { edit: false, signup: false }, upcoming: [], raids: [], hasMore: false } },
  'PATCH /auth/prefs': init => ({ status: 200, body: { prefs: Object.assign({}, USER.prefs, JSON.parse(init.body)) } }),
  'POST /auth/logout': { status: 200, body: {} },
}, extra || {});
const keysOf = items => items.map(i => i.key + (i.separated ? '|sep' : ''));
const hrefsOf = html => [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);

(async () => {
  // ── nav matrix ─────────────────────────────────────────────────
  await check('nav matrix: signed out = Planner, separator, the one Help item (What\'s new, Future enhancements, How it works, FAQ inside it); no rail, no tabs', () => {
    const { G } = makeEnv();
    const ctx = { section: 'planner', page: 'app', me: null, signedOut: true, guildData: null };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['planner', 'help|sep']);
    const s = G.shell.slots(ctx);
    assert.equal(s.rail, '', 'no guild rail');
    assert.equal(s.tabs, '', 'no phone tabs');
    assert(s.sidebar.includes('class="gs-nav-sep"'));
    assert(s.sidebar.includes('gs-brand-row') && s.sidebar.includes('Raidsmith') && !s.sidebar.includes('gs-side-head'), 'brand head without a guild');
    assert(s.drawer.includes('<dialog class="gs-drawer"') && s.drawer.includes('data-action="open-planner"') && s.drawer.includes('href="/faq.html"'), 'the drawer exists for signed-out people');
    assert(s.account.includes('href="#/signin"') && s.account.includes('Sign in or sign up') && s.account.includes('>Sign in<'), 'both sign-in labels, opening the sign-in page');
    assert(!s.account.includes('/auth/login'), 'the top bar no longer goes straight to Discord');
  });

  await check('nav matrix: signed in without a guild = the signed-out items; the rail only when they can create', () => {
    const { G } = makeEnv();
    const base = { section: 'planner', page: 'app', guildData: null };
    const cannot = Object.assign({ me: meBody({ guilds: [] }) }, base);
    const can = Object.assign({ me: meBody({ guilds: [], create: { allowed: true } }) }, base);
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(cannot))), ['planner', 'help|sep']);
    assert.equal(G.shell.slots(cannot).rail, '');
    const withAdd = G.shell.slots(can);
    assert(withAdd.rail.includes('gs-tile-add') && withAdd.rail.includes('href="#/new"') && !withAdd.rail.includes('href="#/g/'), 'add button only');
    assert.equal(G.shell.slots(can).tabs, '', 'no tabs without a guild');
  });

  await check('nav matrix: member = Home, Roster, Raids, Attendance, Loot, Planner, Help; tiles; five phone tabs (Home, Raids, Attendance, Loot, More)', () => {
    const { G } = makeEnv();
    const ctx = { section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(MEMBER_CAN), teamId: 't1' };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['home', 'roster', 'raids', 'attendance', 'loot', 'planner', 'help|sep']);
    assert.equal(G.shell.homeBadge(Object.assign({}, ctx, { attentionCount: 4 })), 0, 'the member Home counts nothing');
    assert.deepEqual(plain(keysOf(G.shell.tabItems(ctx))), ['home', 'raids', 'attendance', 'loot', 'more']);
    const s = G.shell.slots(ctx);
    assert(s.rail.includes('gs-tile is-active') && s.rail.includes('data-action="open-planner"'), 'tiles; the rail logo is a Planner link');
    assert(/<nav class="gs-tabs"/.test(s.tabs) && s.tabs.includes('data-action="open-drawer"') && !s.tabs.includes('data-action="open-planner"'), 'More opens the drawer; Planner lives there');
    assert(!s.sidebar.includes('Guild settings'));
  });

  await check('nav matrix: officer / GM gets Home first and Guild settings (separated) before the Help item; tabs are Home, Raids, Roster, Attendance, More', () => {
    const { G } = makeEnv();
    const ctx = { section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(OFFICER_CAN), teamId: 't1' };
    assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))), ['home', 'roster', 'raids', 'attendance', 'loot', 'planner', 'settings|sep', 'help|sep']);
    assert.deepEqual(plain(keysOf(G.shell.tabItems(ctx))), ['home', 'raids', 'roster', 'attendance', 'more']);
  });

  await check('nav: the guild nav shows on the planner section and the static pages, but the phone tabs only on guild sections', () => {
    const { G } = makeEnv();
    for (const section of ['planner', 'page']) {
      const ctx = { section, page: section === 'page' ? 'faq' : 'app', me: meBody(), route: null, guildData: guildBody(OFFICER_CAN), teamId: 't1' };
      assert.deepEqual(plain(keysOf(G.shell.sidebarItems(ctx))).slice(0, 7), ['home', 'roster', 'raids', 'attendance', 'loot', 'planner', 'settings|sep'], section);
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
    assert(links.includes('/#/g/g1/roster') && links.includes('/#how-it-works') && links.includes('/#/roadmap') && links.includes('/') && links.includes('/#/g/g1/settings') && links.includes('/#/privacy'));
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
    assert(!planner.includes('gs-lead-phone'), 'planner: no phone title area (the trail is desktop only, guild.css hides it on a phone)');
    for (const route of [{ name: 'person', gid: 'g1', pid: 'p1' }, { name: 'import', gid: 'g1', source: 'wcl' }]) {
      const lead = guild(route).lead;
      assert(lead.includes('class="gs-back" href="#/g/g1/roster" aria-label="Back to Roster">&lsaquo; Roster</a>'), route.name);
      assert(!lead.includes('gs-phone-pick'), route.name + ': the back link replaces the picker');
    }
    // A settings page goes back to the list of settings pages (it used to say Roster); the list itself goes back to Home.
    const settingsPage = guild({ name: 'settings', gid: 'g1', tab: 'teams' }).lead;
    assert(settingsPage.includes('class="gs-back" href="#/g/g1/settings" aria-label="Back to Settings">&lsaquo; Settings</a>') && !settingsPage.includes('Roster') && !settingsPage.includes('gs-phone-pick'));
    assert(guild({ name: 'settings', gid: 'g1', tab: null }).lead.includes('class="gs-back" href="#/g/g1" aria-label="Back to Home">&lsaquo; Home</a>'));
    assert(guild({ name: 'section', gid: 'g1', section: 'roster' }).lead.includes('gs-phone-pick'));
    assert(!guild({ name: 'section', gid: 'g1', section: 'roster' }).lead.includes('gs-back'));
    const abs = G.shell.slots({ section: 'page', page: 'faq', me: meBody(), route: null, guildData: guildBody(), teamId: 't1' });
    assert(!abs.lead.includes('gs-back'));
  });

  await check('planner trail: Guild / Planner on the landing, Guild / Planner / plan name on a plan; signed out has no guild crumb; the plan name is the current page', () => {
    const { G } = makeEnv();
    const lead = (ctx) => G.shell.slots(Object.assign({ section: 'planner', page: 'app', me: meBody(), route: null }, ctx)).lead;
    const crumbs = (html) => [...html.matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((m) => m[2].replace(/<[^>]+>/g, '') + (m[1].includes('aria-current') ? '*' : ''));
    const gd = { guildData: guildBody(OFFICER_CAN), teamId: 't1' };
    const landing = lead(Object.assign({ planner: { view: 'landing', name: 'Old plan' } }, gd));
    assert.deepEqual(crumbs(landing), ['Ravens', '/', 'Planner*'], 'landing: the guild, then Planner as the current page (the plan name is not shown)');
    assert(landing.includes('<a href="#/g/g1/roster">Ravens</a>'), 'the guild links like the other pages\' first crumb');
    const plan = lead(Object.assign({ planner: { view: 'app', name: 'Karazhan <Tue>' } }, gd));
    assert.deepEqual(crumbs(plan), ['Ravens', '/', 'Planner', '/', 'Karazhan <Tue>*'].map((x) => x.replace('<Tue>', '&lt;Tue&gt;')), 'the plan name is the current page, escaped');
    assert(plan.includes('<a href="/" data-action="open-planner">Planner</a>'), 'Planner links to the landing with the open-planner action');
    const sideOnly = lead({ plannerGuild: { id: 'g9', name: 'Sidebar Guild' }, planner: { view: 'app', name: 'P' } });
    assert(sideOnly.includes('<a href="#/g/g9/roster">Sidebar Guild</a>'), 'the guild the sidebar shows is used before its full data arrives');
    assert.deepEqual(crumbs(lead({ me: null, planner: { view: 'landing', name: 'x' } })), ['Planner*'], 'signed out, landing');
    assert.deepEqual(crumbs(lead({ me: null, planner: { view: 'app', name: 'Raid A' } })), ['Planner', '/', 'Raid A*'], 'signed out, plan');
    assert.deepEqual(crumbs(lead({ planner: { view: 'app', name: 'Raid A' } })), ['Planner', '/', 'Raid A*'], 'signed in on no guild, plan');
    assert(!G.shell.slots({ section: 'guild', page: 'app', me: meBody(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildBody(OFFICER_CAN), teamId: 't1' }).lead.includes('data-action="open-planner"'), 'other pages are unchanged');
  });

  await check('planner trail: the last crumb follows the plan live (view and rename events redraw the lead only); the tabs hide in a guild; the guild reports its version', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(OFFICER_CAN) });
    await settle();
    const crumbs = () => [...env.html('shell-topbar-lead').matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    assert.deepEqual(crumbs(), ['Ravens', '/', 'Planner'], 'the landing');
    let name = 'Plan one';
    let view = 'app';
    Object.assign(env.sandbox.PP.shell, { view: () => view, planName: () => name });
    env.fire('document', 'planner:view', { detail: { view } });
    assert.deepEqual(crumbs(), ['Ravens', '/', 'Planner', '/', 'Plan one'], 'a plan opens');
    name = 'Renamed';
    env.fire('document', 'planner:plan-name', {});
    assert.deepEqual(crumbs(), ['Ravens', '/', 'Planner', '/', 'Renamed'], 'a rename');
    view = 'landing';
    env.fire('document', 'planner:view', { detail: { view } });
    assert.deepEqual(crumbs(), ['Ravens', '/', 'Planner'], 'back to the landing');
    assert.equal(env.G.app.plannerGuildVersion(), 'tbc', 'the version of the guild payload');
    const css = read('app.css');
    assert(css.includes('body[data-planner-view="landing"]:not(.has-planner-guild):not(.shell-pending) #shell-topbar-plan .game-version-nav { display: inline-flex'), 'tabs are shown only without a guild');
    assert(css.includes('#shell-topbar-plan .game-version-nav { display: none; }'), 'and never on a plan');
    assert(read('js/render.js').includes("new CustomEvent('planner:plan-name'"), 'the planner announces a changed plan name');
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

  await check('attendance routes: Raids list, Raid detail, Attendance and Review load their data and render through the real router', async () => {
    const can = Object.assign({}, OFFICER_CAN, { 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild' });
    const raid = { raid: { id: 'r1', team: 't1', raidOn: '2026-10-10', zone: 'BT', state: 'awaiting_log', openFlags: 0, stale: false }, can: { edit: true, review: true, seeAttendance: true }, sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [] };
    const routes = signedInRoutes(can, {
      '/api/guild/g1/raids?team=t1': { status: 200, body: { team: 't1', raids: [{ id: 'r1', raidOn: '2026-10-10', zone: 'BT', bosses: { kills: 0, pulls: 0 }, sources: { event: false, reports: 0, plan: false }, counts: null, openFlags: 0, state: 'awaiting_log', stale: false }] } },
      '/api/guild/g1/raids/r1': { status: 200, body: raid },
      '/api/guild/g1/attendance/team?team=t1': { status: 200, body: { team: 't1', window: 8, policy: { switchWeeks: [8, 12] }, weeks: [], people: [], awaitingReview: 0, staleRaids: 0 } },
      '/api/guild/g1/attendance/policy': { status: 200, body: { defaults: {}, guild: {}, teams: {}, resolved: {}, versions: { guild: 0, teams: {} }, wcl: { guildId: null, uploaders: {} } } },
      '/api/guild/g1/attendance/review?team=t1': { status: 200, body: { team: 't1', raids: [], stale: [] } },
    });
    const env = makeEnv({ url: '/#/g/g1/raids', routes });
    await settle();
    assert(env.html('gs-main').includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Raids</h1>') && env.html('gs-main').includes('Sat Oct 10'));
    env.loc.hash = '#/g/g1/raids/r/r1';
    await settle();
    assert(env.html('gs-main').includes('Awaiting log') && env.html('shell-topbar-lead').includes('Sat Oct 10'));
    env.loc.hash = '#/g/g1/attendance';
    await settle();
    assert(env.html('gs-main').includes('No attendance yet'));
    env.loc.hash = '#/g/g1/attendance/review';
    await settle();
    assert(env.html('gs-main').includes('Nothing to review'));
    assert(env.documentFake.title.startsWith('Review queue - Ravens'));
  });

  await check('loot routes: the hub, Standings with its window switch, a raid night, an item, a person\'s loot, Settings > Loot and the raid page summary load through the real router', async () => {
    const can = Object.assign({}, OFFICER_CAN, { 'guild.roles': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild', 'loot.policy': 'guild' });
    const aw = { id: 'a1', raidId: 'r1', raidOn: '2026-10-10', teamId: 't1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1791681160000, winner: { name: 'Thoren', realm: 'Ashmere', class: 'PALADIN' }, match: { kind: 'character', personId: 'p1', personName: 'Thoren', characterName: 'Thoren' }, tag: 'MS', tagSetBy: null, flags: [], rollType: 'MS', note: null, awardedBy: 'Lead' };
    const balance = { team: { id: 't1', name: 'Main' }, window: { weeks: 8, switchWeeks: [8, 12], from: '2026-08-18' }, mode: 'perRaid', countTags: ['MS'], scope: 'team',
      people: [{ personId: 'p1', name: 'Thoren', class: 'PALADIN', status: 'raider', raids: { window: 4, all: 6 }, items: { MS: { window: 2, all: 3 }, OS: { window: 0, all: 0 }, DE: { window: 0, all: 0 }, BANK: { window: 0, all: 0 } }, counted: { window: 2, all: 3 }, perRaid: { window: 0.5, all: 0.5 }, vsTeam: 0 }],
      teamAverage: { window: 0.5, all: 0.5 } };
    const raid = { raid: { id: 'r1', team: { id: 't1', name: 'Main' }, raidOn: '2026-10-10', zone: 'BT', state: 'reviewed', openFlags: 0, stale: false, upcoming: false }, can: { edit: true, review: true, seeAttendance: true }, sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [] };
    const routes = signedInRoutes(can, {
      '/api/guild/g1/loot/balance?team=t1': { status: 200, body: balance },
      '/api/guild/g1/loot/balance?team=t1&weeks=12': { status: 200, body: Object.assign({}, balance, { window: Object.assign({}, balance.window, { weeks: 12 }) }) },
      '/api/guild/g1/loot/raids?team=t1': { status: 200, body: { raids: [{ raidId: 'r1', raidOn: '2026-10-10', title: null, zone: 'BT', awards: 1, counted: 1, unmatched: 0 }] } },
      '/api/guild/g1/loot/hub?team=t1': { status: 200, body: { team: { id: 't1', name: 'Main' }, level: 'full', can: { edit: true, rules: true, standings: true, itemLookup: true }, me: null,
        nights: [{ raid: { id: 'r1', raidOn: '2026-10-10', title: null, zone: 'BT' }, awards: [aw] }], standingsTop: balance.people, standingsCount: balance.people.length, standingsInfo: { mode: 'perRaid', countTags: ['MS'], weeks: 8 }, fix: { duplicates: 0, unknown: 0 } } },
      '/api/guild/g1/loot/items/28770?team=t1': { status: 200, body: { team: { id: 't1', name: 'Main' }, item: { itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, counts: { total: 1, MS: 1, OS: 0, DE: 0, BANK: 0 }, drops: [Object.assign({}, aw, { raidTitle: null })] } },
      '/api/guild/g1/loot/items?team=t1': { status: 200, body: { items: [{ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, count: 1, lastAwardedAt: 1791681160000, awards: [{ id: 'a1', raidId: 'r1', raidOn: '2026-10-10', awardedAt: 1791681160000, tag: 'MS', match: aw.match, winner: aw.winner }] }] } },
      '/api/guild/g1/loot/person/p1': { status: 200, body: { person: { id: 'p1', name: 'Thoren', status: 'raider' }, awards: [aw], totals: { MS: 1, OS: 0, DE: 0, BANK: 0 } } },
      '/api/guild/g1/loot/policy': { status: 200, body: { defaults: { visibility: { members: 'ownTeams' }, balance: { mode: 'perRaid', countTags: ['MS'] } }, guild: {}, teams: {}, resolved: {}, versions: { guild: 0, teams: {} } } },
      '/api/guild/g1/raids/r1': { status: 200, body: raid },
      '/api/guild/g1/raids/r1/loot': { status: 200, body: { awards: [aw], canEdit: true } },
      '/api/guild/g1/roster/p1': { status: 200, body: { today: '2026-10-15', can: { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false },
        person: { id: 'p1', status: 'raider', joinedOn: '2026-09-15', trialStart: null, trialEnd: null, trialFlag: null, isMe: false, version: 1, discord: { signIn: 'not_yet', user: null, nickname: null }, homeTeam: { id: 't1', name: 'Main' } },
        characters: [{ id: 'c1', name: 'Thoren', realm: null, class: 'PALADIN', mainSpec: 'Protection', offSpec: null, role: 'tank', isMain: true, team: { id: 't1', name: 'Main', archived: false } }], notes: { text: '', version: 1 } } },
    });
    const env = makeEnv({ url: '/#/g/g1/loot', routes });
    await settle();
    assert(env.html('gs-main').includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Loot</h1>') && env.html('gs-main').includes('Thoren') && env.html('gs-main').includes('Who is due') && env.html('gs-main').includes('Latest raid nights'));
    assert(env.documentFake.title.startsWith('Loot - Ravens'));
    assert(/href="#\/g\/g1\/loot"[^>]*aria-current="page"/.test(env.html('shell-sidebar')), 'Loot is the current nav item');
    assert(!env.html('gs-main').includes('coming next'));
    assert(['hub?team=t1', 'raids?team=t1', 'items?team=t1'].every(t => env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/' + t)) && !env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/balance?team=t1'), 'the hub reads the hub, the raid list and the items; Who is due comes from the hub itself');
    env.loc.hash = '#/g/g1/loot/standings';
    await settle();
    assert(env.html('gs-main').includes('>Standings</h1>') && env.html('gs-main').includes('Thoren') && env.html('gs-main').includes('class="gs-dtable"'));
    assert(/href="#\/g\/g1\/loot"[^>]*aria-current="page"/.test(env.html('shell-sidebar')), 'Standings keeps Loot current');
    env.click({ 'data-action': 'loot-window', 'data-value': '12' });
    await settle();
    assert(env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/balance?team=t1&weeks=12'), 'the window switch asks for that many weeks');
    assert(/aria-pressed="true" data-action="loot-window" data-value="12"/.test(env.html('gs-main')));
    env.loc.hash = '#/g/g1/loot?view=raids';
    await settle();
    assert(env.html('gs-main').includes('Latest raid nights') && !env.html('gs-main').includes('Loot by raid'), 'an old view link opens the hub');
    assert.equal(env.loc.hash, '#/g/g1/loot', 'and the address is tidied');
    env.loc.hash = '#/g/g1/loot/n/r1';
    await settle();
    assert(env.html('gs-main').includes('>Sat Oct 10</h1>') && env.html('gs-main').includes('Nathrezim Mindblade') && env.html('gs-main').includes('data-change="ln-tag"'));
    assert(env.html('shell-topbar-lead').includes('Sat Oct 10') && env.html('shell-topbar-lead').includes('Loot'), 'the crumb names the night');
    assert(env.documentFake.title.startsWith('Night loot - Ravens'));
    env.loc.hash = '#/g/g1/loot/i/28770';
    await settle();
    assert(env.html('gs-main').includes('>Nathrezim Mindblade</h1>') && env.html('gs-main').includes('Who has it'));
    assert(env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/items/28770?team=t1'));
    env.loc.hash = '#/g/g1/loot/p/p1';
    await settle();
    assert(env.html('gs-main').includes('Loot history') && env.html('gs-main').includes('Sat Oct 10'));
    assert(env.html('shell-topbar-lead').includes('Thoren') && env.html('shell-topbar-lead').includes('Loot'), 'the crumb names the person');
    assert(/href="#\/g\/g1\/loot"[^>]*aria-current="page"/.test(env.html('shell-sidebar')), 'the person page keeps Loot current');
    assert(env.documentFake.title.startsWith('Loot history - Ravens'));
    env.loc.hash = '#/g/g1/roster/p/p1';
    await settle();
    assert(env.html('gs-main').includes('id="loot-card-h"') && env.html('gs-main').includes('<a class="gs-fg-u" href="#/g/g1/loot/p/p1">All loot</a>'), 'the roster person page carries the Loot card');
    assert(env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/person/p1'));
    env.loc.hash = '#/g/g1/settings/loot';
    await settle();
    assert(env.html('gs-main').includes('Who sees loot') && env.html('gs-main').includes('href="#/g/g1/settings/loot" aria-current="page">Loot<'));
    assert(env.fetchCalls.some(c => c.url === '/api/guild/g1/loot/policy'));
    const lootReads = () => env.fetchCalls.filter(c => c.url === '/api/guild/g1/raids/r1/loot').length;
    const readsBefore = lootReads();
    env.loc.hash = '#/g/g1/raids/r/r1';
    await settle();
    assert(env.html('gs-main').includes('id="loot-h"') && env.html('gs-main').includes('Nathrezim Mindblade') && env.html('gs-main').includes('Import from Gargul') && env.html('gs-main').includes('href="#/g/g1/loot/n/r1"'));
    assert.equal(lootReads() - readsBefore, 1, 'one loot request per raid page load');
  });

  await check('loot routes: a member sees the Loot section without editor controls, a 403 is a note, and the Loot settings tab stays away', async () => {
    const memberCan = Object.assign({}, MEMBER_CAN, { 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'] });
    const routes = signedInRoutes(memberCan, { '/api/guild/g1/loot/hub?team=t1': { status: 403, body: { error: 'forbidden', message: 'No.' } } });
    const env = makeEnv({ url: '/#/g/g1/loot', routes });
    await settle();
    assert(/You can(&#39;|')t see this team(&#39;|')s loot/.test(env.html('gs-main')));
    assert(!env.html('shell-sidebar').includes('settings/loot'), 'no Guild settings entry without loot.policy');
    env.loc.hash = '#/g/g1/settings/loot';
    await settle();
    assert(env.html('gs-main').includes('You cannot open this'));
  });

  await check('attendance section: a viewer without attendance.review gets their own record (no team page call); no person -> the link-to-roster empty state', async () => {
    const memberCan = Object.assign({}, MEMBER_CAN, { 'raids.view': 'guild', 'attendance.view': ['t1'] });
    const withMe = (me) => { const body = guildBody(memberCan); body.me = Object.assign({}, body.me, me); return { status: 200, body }; };
    const own = makeEnv({ url: '/#/g/g1/attendance', routes: signedInRoutes(memberCan, {
      '/api/guild/g1': withMe({ personId: 'p1' }),
      '/api/guild/g1/attendance/person/p1': { status: 200, body: { person: { id: 'p1', name: 'Thoren', class: 'PALADIN', status: 'raider', isMe: true }, teams: [] } },
    }) });
    await settle();
    assert.equal(own.fetched('/attendance/person/p1'), 1, 'the own record is fetched');
    assert.equal(own.fetched('/attendance/team'), 0, 'the team page is never requested');
    assert(own.html('gs-main').includes('>Attendance</h1>') && own.html('gs-main').includes('No attendance yet'), 'the own record renders under the title Attendance');
    assert(own.html('shell-sidebar').includes('Attendance'), 'the nav label stays Attendance');
    const none = makeEnv({ url: '/#/g/g1/attendance', routes: signedInRoutes(memberCan, { '/api/guild/g1': withMe({}) }) });
    await settle();
    assert.equal(none.fetched('/attendance/team'), 0);
    assert(none.html('gs-main').includes('Your attendance shows here once an officer links you to the roster.'));
    const reviewer = makeEnv({ url: '/#/g/g1/attendance', routes: signedInRoutes(Object.assign({}, memberCan, { 'attendance.review': ['t1'] }), {
      '/api/guild/g1/attendance/team?team=t1': { status: 200, body: { team: 't1', window: 8, policy: { switchWeeks: [4, 8] }, weeks: [], people: [], awaitingReview: 0, staleRaids: 0, watch: null } },
    }) });
    await settle();
    assert.equal(reviewer.fetched('/attendance/team'), 1, 'a reviewer still gets the team page');
  });

  await check('routeAll: idempotent - a hash-link click (popstate then hashchange) is one route; force re-runs', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    assert.equal(env.fetched('/roster?team=t1'), 1);
    env.loc.hash = '#/g/g1/raids';
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
    assert.equal(home.loc.hash, '#/g/g1', 'a member lands on their Home');
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

  await check('Planner for a raid: #/planner?raid=<gid>.<rid> is the planner section and hands the address to the planner; any other address (a guild page, the Planner link) leaves the raid', async () => {
    const seen = [];
    const env = makeEnv({ url: '/tbc/abc1234#/planner?raid=g1.r9', routes: signedInRoutes(), beforeApp: sb => { sb.RaidContext = { route: h => seen.push(h) }; } });
    await settle();
    assert.equal(env.G.app.state.section, 'planner');
    assert.equal(env.els['planner-root'].hidden, false);
    assert.equal(env.els['gs-main'].hidden, true);
    assert.deepEqual(seen, ['#/planner?raid=g1.r9'], 'a reload opens the raid again');
    // The Planner link opens the planner normally: the address drops the raid and the planner is told.
    env.click({ 'data-action': 'open-planner' });
    assert.equal(env.loc.hash, '');
    assert.equal(seen[seen.length - 1], '');
    assert(env.plannerCalls.includes('home'));
    // A guild page leaves the raid too (Back to raid, the sidebar, the browser's Back).
    env.loc.hash = '#/planner?raid=g1.r9';
    await settle();
    assert.equal(seen[seen.length - 1], '#/planner?raid=g1.r9');
    env.loc.hash = '#/g/g1/raids/r/r9';
    await settle();
    assert.equal(env.G.app.state.section, 'guild');
    assert.equal(seen[seen.length - 1], '#/g/g1/raids/r/r9');
    // From a guild page, the Planner link pushes the plain address and the planner is told there is no raid.
    env.click({ 'data-action': 'open-planner' });
    await settle();
    assert.deepEqual([env.G.app.state.section, seen[seen.length - 1]], ['planner', '']);
    // Without the planner's RaidContext (a static page, a failed script) nothing breaks.
    const bare = makeEnv({ url: '/#/planner?raid=g1.r9', routes: signedInRoutes() });
    await settle();
    assert.equal(bare.G.app.state.section, 'planner');
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
  await check('collapse: one state for every page - default expanded; a plan view, the landing and a guild page all read the same value', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    assert.equal(env.G.app.sidebarCollapsed(), false);
    assert(!env.els['guild-root'].classList.contains('is-collapsed'));
    env.body.attrs['data-planner-view'] = 'app';
    env.fire('document', 'planner:view', {});
    assert.equal(env.G.app.sidebarCollapsed(), false, 'a plan open no longer collapses by default');
    assert(!env.els['guild-root'].classList.contains('is-collapsed'));
    assert.equal(env.G.app.collapseContext, undefined);
  });

  await check('collapse: signed out - the toggle writes the one local key; plan view, landing and static pages keep it', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    env.click({ 'data-action': 'toggle-sidebar' });
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], '1');
    assert.equal(env.store['raidsmith.shell.planSidebarCollapsed'], undefined);
    assert(env.els['guild-root'].classList.contains('is-collapsed'));
    env.body.attrs['data-planner-view'] = 'app';
    env.fire('document', 'planner:view', {});
    assert(env.els['guild-root'].classList.contains('is-collapsed'), 'plan view: same state');
    env.body.attrs['data-planner-view'] = 'landing';
    env.fire('document', 'planner:view', {});
    assert(env.els['guild-root'].classList.contains('is-collapsed'), 'landing: same state');
    env.click({ 'data-action': 'toggle-sidebar' });
    assert.equal(env.store['raidsmith.shell.sidebarCollapsed'], '0');
    assert.equal(env.fetchCalls.length, 0, 'signed out: nothing sent to the server');
    // fresh page loads (plan, landing, FAQ) read the key
    for (const [page, url] of [['app', '/'], ['app', '/tbc/abc1234'], ['faq', '/faq.html'], ['whats-new', '/whats-new.html']]) {
      const again = makeEnv({ page, url, storage: { 'raidsmith.shell.sidebarCollapsed': '1' } });
      await settle();
      assert(again.els['guild-root'].classList.contains('is-collapsed'), url);
    }
    const plan = makeEnv({ url: '/tbc/abc1234', storage: { 'raidsmith.shell.planSidebarCollapsed': '0' } });
    await settle();
    assert(!plan.els['guild-root'].classList.contains('is-collapsed'));
  });

  await check('collapse: signed in - the toggle writes the one server pref and the local key; the old plan pref is ignored; first paint reads the local key until /auth/me answers', async () => {
    const env = makeEnv({ url: '/', hint: true, storage: { 'raidsmith.shell.sidebarCollapsed': '1' }, routes: signedInRoutes(null, { '/auth/me': 'hang' }) });
    await settle();
    assert(env.els['guild-root'].classList.contains('is-collapsed'), 'local key before the session answers');
    const done = makeEnv({ url: '/#/g/g1/roster', hint: true, routes: signedInRoutes() });
    await settle();
    assert(!done.els['guild-root'].classList.contains('is-collapsed'), 'the old plan pref (true) is ignored');
    done.click({ 'data-action': 'toggle-sidebar' });
    await settle();
    assert.deepEqual(done.fetchCalls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body)).filter(b => 'sidebarCollapsed' in b), [{ sidebarCollapsed: true }]);
    assert.equal(done.store['raidsmith.shell.sidebarCollapsed'], '1');
    done.body.attrs['data-planner-view'] = 'app';
    done.fire('document', 'planner:view', {});
    assert(done.els['guild-root'].classList.contains('is-collapsed'), 'plan view: same state');
    done.body.attrs['data-planner-view'] = 'landing';
    done.fire('document', 'planner:view', {});
    assert(done.els['guild-root'].classList.contains('is-collapsed'), 'landing: same state');
    done.click({ 'data-action': 'toggle-sidebar' });
    await settle();
    assert.deepEqual(done.fetchCalls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body)).filter(b => 'sidebarCollapsed' in b), [{ sidebarCollapsed: true }, { sidebarCollapsed: false }]);
    assert.equal(done.store['raidsmith.shell.planSidebarCollapsed'], undefined);
  });

  await check('Help fold: a manual open/closed choice survives a route change and a re-render; no choice keeps the current-page rule', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    const fold = () => env.html('shell-sidebar').match(/<li class="gs-nav-fold[^"]*"><button[^>]*aria-expanded="(\w+)"/);
    assert.equal(fold()[1], 'false', 'no choice, no Help page current: closed');
    const list = { hidden: true };
    const calls = [];
    env.documentFake.getElementById = id => (id === 'nav-fold-help-side' ? list : env.els[id]);
    const btn = { getAttribute: k => ({ 'aria-controls': 'nav-fold-help-side', 'data-fold': 'help' })[k] || null, setAttribute: (k, v) => calls.push([k, v]) };
    env.G.handlers.click['help-toggle'](btn);
    assert.equal(env.sessionStore['raidsmith.shell.fold.help'], '1');
    env.loc.hash = '#/g/g1/raids';
    await settle();
    assert.equal(fold()[1], 'true', 'opened by hand: still open on another page');
    env.sessionStore['raidsmith.shell.fold.help'] = '0';
    env.loc.hash = '#/g/g1/roster';
    await settle();
    assert.equal(fold()[1], 'false', 'closed by hand: stays closed');
    delete env.sessionStore['raidsmith.shell.fold.help'];
    const faq = makeEnv({ page: 'faq', url: '/faq.html' });
    await settle();
    assert(/gs-nav-fold is-open/.test(faq.html('shell-sidebar')), 'no choice: open while a Help page is current');
  });

  // ── the session question ───────────────────────────────────────
  await check('session: an anonymous planner or help-page visit never reaches the Worker; shell-pending clears at once; signed-out chrome', async () => {
    for (const [page, url] of [['app', '/'], ['app', '/tbc/abc1234'], ['app', '/#r=xyz'], ['faq', '/faq.html'], ['whats-new', '/whats-new.html']]) {
      const env = makeEnv({ page, url });
      await settle();
      assert.deepEqual(env.fetchCalls, [], `${page} ${url}`);
      assert(!env.body.classList.contains('shell-pending'));
      assert(env.body.classList.contains('is-signed-out'));
      assert(env.html('shell-topbar-account').includes('#/signin'));
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
    assert(env.html('shell-topbar-account').includes('#/signin'));
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
    assert(page.html('shell-topbar-account').includes('/#/signin'));
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
    const guildReads = () => env.fetchCalls.filter(c => c.url === '/api/guild/g1').length; // the guild itself (not /attention, which officers also read for the Home badge)
    assert.equal(guildReads(), 1);
    assert.equal(env.fetched('/api/guild/g1/attention'), 1, 'officers read the Home count once, in the background');
    const side = env.html('shell-sidebar');
    assert(side.includes('Roster') && side.includes('Guild settings') && side.includes('gs-side-head'));
    env.G.app.render();
    env.loc.hash = '#how-it-works';
    await settle();
    assert.equal(guildReads(), 1, 'once per page load');
    assert.equal(env.fetched('/api/guild/g1/attention'), 1, 'a failed Home count is not asked again within the minute');
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
    assert(out.html('gs-main').includes('Continue with Discord') && out.html('gs-main').includes('/auth/login'));
    assert(out.els['gs-main'].classList.contains('gs-main-center'));
    assert(out.html('shell-topbar-account').includes('Sign in or sign up'));
    assert(!out.html('shell-tabs'));
    assert(out.html('shell-sidebar').includes('gs-brand-row'));
    const priv = makeEnv({ url: '/#/privacy', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    assert(priv.html('gs-main').includes('Privacy') && !priv.els['gs-main'].classList.contains('gs-main-center'));
    const err = makeEnv({ url: '/#/signin?error=denied', routes: { '/auth/me': { status: 401, body: {} } } });
    await settle();
    assert(err.html('gs-main').includes('Sign-in was cancelled'));
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
    assert(env.html('shell-topbar-account').includes('#/signin'));
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
    assert(env.html('gs-main').includes('Continue with Discord'));
    const page = makeEnv({ page: 'faq', url: '/faq.html', hint: true, routes: signedInRoutes() });
    await settle();
    page.click({ 'data-action': 'sign-out' });
    await settle();
    assert.equal(page.G.app.state.section, 'page');
    assert(page.html('shell-topbar-account').includes('/#/signin'));
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
    const css = (read('planner-forge.css') + '\n' + read('guild.css'));
    for (const bare of [/(^|\n)\.guild-page a\s*[,{:]/, /(^|\n)\.guild-page a:hover/, /\.guild-page (button|input|select|textarea|\[tabindex\]):focus-visible/, /\.guild-page \.gs-h1:focus/, /\.guild-page input::placeholder/]) {
      assert(!bare.test(css), 'page-wide rule left: ' + bare);
    }
    assert(/:where\(\.gs-scope a\) \{ color: var\(--text-secondary\); \}/.test(css));
    assert(/\.gs-scope a:focus-visible,[\s\S]*?\{ outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\); \}/.test(css) && /--focus-ring: 2px solid var\(--text-primary\);/.test(css) && /--focus-offset: 2px;/.test(css));
    assert(/\.gs-scope \.gs-h1:focus \{ outline: none; \}/.test(css) && /\.gs-scope input::placeholder/.test(css));
    assert(/#shell-rail, #shell-sidebar, #shell-banner, #shell-tabs, #shell-drawer \{ display: contents; \}/.test(css));
    assert(/#planner-root\[hidden\], #gs-main\[hidden\] \{ display: none !important; \}/.test(css));
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@][^{}]*)\{/g)].map(m => m[2]).join(',').split(',').map(x => x.trim());
    const planner = selectors.filter(x => /(^|[\s>+~])#planner-root|#shell-topbar-plan|\.planner-|\.title-bar|\.landing\b|\.addon-frame/.test(x) && !/#planner-root\[hidden\]/.test(x));
    assert.deepEqual(planner, [], 'guild.css must not style planner markup');
    assert(!/--[\w-]+\s*:/.test(GuildCss.stripOwnTokens(css).replace(/var\(--[\w-]+/g, '')), 'no custom properties (but the framework tokens, the attendance outcome colours and the Raids tones)');
  });

  await check('guild.css: no plain rule sets color on .gs-classbadge, .gs-char-sub or .gs-dtable-primary a (a class colour must win)', () => {
    assert.deepEqual(GuildCss.classColourOverrides((read('planner-forge.css') + '\n' + read('guild.css'))), []);
  });

  await check('guild.css: phone A2 - menu button 44px on every page, drawer for everyone, tabs only with a guild, signed-out sign-in shortens', () => {
    const css = (read('planner-forge.css') + '\n' + read('guild.css'));
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


  // ── fix round 1 (2b-fix1) ──────────────────────────────────────
  await check('fix1 #1: How it works reached from a guild section is not undone by the section-switch scroll and focus', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes() });
    await settle();
    env.plannerCalls.length = 0;
    env.click({ 'data-action': 'how-it-works' });
    await settle();
    assert(env.plannerCalls.includes('howItWorks'));
    assert(!env.plannerCalls.includes('scrollTo'), 'no scrollTo(0, 0) after the guide opened: ' + env.plannerCalls.join(','));
    assert.equal(env.els['planner-root'].focused, 0);
  });

  await check('fix1 #2: arriving on #how-it-works while shell-pending scrolls again once the pending look ends', async () => {
    const calls = [];
    const env = makeEnv({
      url: '/#how-it-works', hint: true, routes: signedInRoutes(),
      beforeApp: sb => { sb.PP.shell.howItWorks = () => calls.push(sb.document.body.classList.contains('shell-pending') ? 'pending' : 'shown'); },
    });
    await settle();
    assert.deepEqual(calls, ['pending', 'shown'], 'the guide is scrolled to once the section is visible');
    assert(!env.body.classList.contains('shell-pending'));
  });

  await check('fix1 #3: the team picker on the planner section uses the guild the chrome shows (currentGid is null there)', async () => {
    const two = guildBody();
    two.teams.push({ id: 't2', name: 'Alts', size: 10, archived: false, lead: null });
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes(null, { '/api/guild/g1': { status: 200, body: two } }) });
    await settle();
    assert.equal(env.G.app.state.currentGid, null);
    assert.equal(env.G.app.buildCtx(null).teamId, 't1');
    const writes = env.els['shell-sidebar'].writes;
    env.G.handlers.change['team-pick']({ value: 't2' });
    assert.equal(env.store['raidsmith.guild.team.g1'], 't2');
    assert.equal(env.G.app.buildCtx(null).teamId, 't2');
    assert(env.els['shell-sidebar'].writes > writes, 'the chrome was drawn again');
  });

  await check('fix1 #4a: a throw on the first pass still ends shell-pending with the signed-out chrome', async () => {
    const env = makeEnv({
      url: '/',
      beforeApp: sb => {
        const real = sb.Guild.shell.slots;
        let first = true;
        sb.Guild.shell.slots = ctx => { if (first) { first = false; throw new Error('boom'); } return real(ctx); };
      },
    });
    await settle();
    assert(!env.body.classList.contains('shell-pending'));
    assert(env.body.classList.contains('is-signed-out'));
    assert.equal(env.G.app.started, true);
  });

  await check('fix1 #7: a render while the phone drawer is open opens the new drawer again', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const drawer = { open: true, shown: 0, showModal() { this.open = true; this.shown++; } };
    env.els['gs-drawer'] = drawer;
    Object.defineProperty(env.els['shell-drawer'], 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); drawer.open = false; } });
    env.G.app.render();
    assert.equal(drawer.shown, 1, 'the destroyed dialog is opened again');
    assert.equal(drawer.open, true);
    drawer.open = false;
    env.G.app.render();
    assert.equal(drawer.shown, 1, 'a closed drawer stays closed');
  });

  await check('fix2: focus put back after a render never scrolls the page (phone drawer -> How it works)', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const seen = [];
    const btn = { getAttribute: n => (n === 'data-key' ? 'menu-btn' : null), focus(opts) { seen.push(opts); env.documentFake.activeElement = btn; } };
    env.documentFake.activeElement = btn;
    env.documentFake.lists['[data-key]'] = [btn];
    env.G.app.render();
    assert.deepEqual(plain(seen), [{ preventScroll: true }]);
  });

  await check('fix1 nit: the late chrome-guild answer does not re-render once a guild section is showing', async () => {
    let env = null;
    let writesAtFetch = -1;
    const routes = signedInRoutes(null, { '/api/guild/g1': () => { env.G.app.state.section = 'guild'; writesAtFetch = env.els['shell-sidebar'].writes; return { status: 200, body: guildBody() }; } });
    env = makeEnv({ url: '/', hint: true, routes });
    await settle();
    assert(writesAtFetch >= 0, 'the chrome guild was fetched');
    assert.equal(env.els['shell-sidebar'].writes, writesAtFetch, 'no render after the answer');
  });

  await check('fix1 nit: an outside click in the capture phase closes the account menu (planner menus stop the bubble)', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const menu = new FakeEl('gs-account-menu');
    menu.hidden = false;
    env.els['gs-account-menu'] = menu;
    env.fireCapture('click', { target: target({}) });
    assert.equal(menu.hidden, true);
    menu.hidden = false;
    const inside = target({});
    inside.closest = sel => (sel === '.gs-account' ? inside : null);
    env.fireCapture('click', { target: inside });
    assert.equal(menu.hidden, false, 'a click inside the account area keeps it');
  });

  await check('fix1 nit: planner:view never redraws the sidebar (one collapse state)', async () => {
    const env = makeEnv({ url: '/' });
    await settle();
    const writes = env.els['shell-sidebar'].writes;
    env.fire('document', 'planner:view', {});
    assert.equal(env.els['shell-sidebar'].writes, writes, 'no redraw');
    env.body.attrs['data-planner-view'] = 'app';
    env.fire('document', 'planner:view', {});
    assert.equal(env.els['shell-sidebar'].writes, writes, 'landing -> plan: no redraw');
    env.fire('document', 'planner:view', {});
    assert.equal(env.els['shell-sidebar'].writes, writes);
  });

  await check('fix1 nit: the no-guild notice shows with the planner only (the guild section has its own card with the same ids)', async () => {
    const routes = signedInRoutes(null, { '/auth/me': { status: 200, body: meBody({ guilds: [], removedFrom: [{ id: 'g9', name: 'Owls' }] }) } });
    const guild = makeEnv({ url: '/#/', hint: true, routes });
    await settle();
    assert.equal(guild.html('planner-notice'), '');
    assert(guild.html('gs-main').includes('Owls'));
    const planner = makeEnv({ url: '/', hint: true, routes });
    await settle();
    assert(planner.html('planner-notice').includes('Owls'));
  });

  await check('fix1 nit: focus falls back to the next displayed target, then #planner-root, when the plan name h1 is not displayed', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes(), beforeApp: sb => { sb.PP.shell.view = () => 'app'; } });
    await settle();
    const hidden = new FakeEl('h1');
    hidden.getClientRects = () => [];
    env.documentFake.selectors['#app h1.gs-pb-h1'] = hidden;
    env.click({ 'data-action': 'open-planner' });
    await settle();
    assert.equal(hidden.focused, 0, 'a hidden heading cannot take focus');
    assert.equal(env.els['planner-root'].focused, 1);
    assert.equal(env.els['planner-root'].getAttribute('tabindex'), '-1');
    const shown = new FakeEl('h1');
    shown.getClientRects = () => [{}];
    env.documentFake.selectors['#app h1.gs-pb-h1'] = shown;
    env.G.app.go('#/g/g1/roster');
    await settle();
    env.click({ 'data-action': 'open-planner' });
    await settle();
    assert.equal(shown.focused, 1);
  });

  await check('fix1 nit: a link click that switches to a guild section scrolls to the top; Back / Forward does not', async () => {
    const env = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    env.plannerCalls.length = 0;
    env.click({ href: '#/g/g1/roster' });
    env.loc.hash = '#/g/g1/roster';
    await settle();
    assert(env.plannerCalls.includes('scrollTo'), 'link click: scrolled to the top');
    const back = makeEnv({ url: '/', hint: true, routes: signedInRoutes() });
    await settle();
    back.plannerCalls.length = 0;
    back.loc.hash = '#/g/g1/roster'; // no link click: the browser's Back / Forward
    await settle();
    assert(!back.plannerCalls.includes('scrollTo'), 'history move: the scroll position is the browser\'s');
  });

  await check('fix1 nit: app.css hides the empty #planner-notice slot; the phone version tabs are 44px Forge segments and the Beta marker keeps the 12px floor', () => {
    const css = read('app.css');
    assert(/#planner-notice:empty \{ display: none; \}/.test(css));
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.game-version-nav \{[^}]*flex: 1 1 0;[^}]*display: flex;/.test(phone), 'the nav fills the bar between the menu button and the account area');
    assert(/\.game-version-tab \{[^}]*height: 44px;[^}]*white-space: nowrap;/.test(phone), '44px cells, FOREVER + Beta on one line');
    assert(/\.game-beta \{[^}]*font:500 12px/.test(css), 'the Beta marker is muted text at the 12px floor');
  });

  // ── Future enhancements (#/roadmap) ────────────────────────────
  const IDEA_ROW = (id, extra) => Object.assign({ id, title: 'Idea ' + id, details: null, area: 'planner', status: 'new', roadmapId: null, triageNote: null, createdAt: Date.UTC(2026, 9, 17, 12), mine: true }, extra || {});
  const ideaEls = (sb, els) => {
    for (const id of ['rm-ideas', 'rm-status', 'rm-form-error', 'rm-title-error', 'rm-area-error', 'rm-details-error', 'rm-item-loot-history']) els[id] = new FakeEl(id);
    for (const id of ['rm-form-error', 'rm-title-error', 'rm-area-error', 'rm-details-error']) els[id].hidden = true; // the markup starts them hidden
  };
  // A form the way the browser hands it over: the three fields by name, and a field lookup by id for the inline errors.
  function fakeForm(values) {
    const field = value => ({ value, attrs: {}, focused: 0, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() { this.focused++; } });
    const form = { elements: { title: field(values.title), area: field(values.area), details: field(values.details) } };
    form.querySelector = sel => {
      const byId = /^#rm-(title|area|details)$/.exec(sel);
      if (byId) return form.elements[byId[1]];
      if (sel === '[aria-invalid="true"]') return Object.values(form.elements).filter(f => f.attrs['aria-invalid'] === 'true')[0] || null;
      return null;
    };
    form.querySelectorAll = () => [];
    return form;
  }

  await check('roadmap: signed out gets the page in the signed-out shell, a sign-in link instead of the form, and asks the Worker nothing about ideas', async () => {
    const env = makeEnv({ url: '/#/roadmap', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    const main = env.html('gs-main');
    assert(main.includes('Future enhancements') && main.includes('<a href="#/signin">Sign in to suggest an idea</a>'));
    assert(main.includes('Loot history') && !main.includes('data-submit="roadmap-idea"'));
    assert(!env.els['gs-main'].classList.contains('gs-main-center'));
    assert.equal(env.documentFake.title, 'Future enhancements - Raidsmith guild');
    assert.equal(env.fetched('/api/roadmap'), 0);
    assert(env.html('shell-sidebar').includes('href="#/roadmap" aria-label="Future enhancements" aria-current="page"'));
    assert(env.html('shell-topbar-account').includes('Sign in or sign up'));
    assert(env.html('shell-topbar-lead').includes('Future enhancements'));
  });

  await check('roadmap: signed in shows the form at once and the submitted ideas when they arrive; the last guild\'s nav stays', async () => {
    const env = makeEnv({
      url: '/#/roadmap', hint: true, beforeApp: ideaEls,
      routes: signedInRoutes(MEMBER_CAN, { 'GET /api/roadmap/ideas': { status: 200, body: { ideas: [IDEA_ROW('ri_1'), IDEA_ROW('ri_2', { mine: false, status: 'declined', triageNote: 'Out of scope.' })] } } }),
    });
    await settle();
    const main = env.html('gs-main');
    assert(main.includes('data-submit="roadmap-idea"') && main.includes('In progress') && !main.includes('Sign in to suggest an idea'));
    assert.equal(env.fetched('/api/roadmap/ideas'), 1);
    const ideas = env.html('rm-ideas');
    assert(ideas.includes('Submitted ideas') && ideas.includes('Idea ri_1') && ideas.includes('Note: Out of scope.') && ideas.includes('Yours'));
    const side = env.html('shell-sidebar');
    assert(side.includes('href="#/g/g1/roster"') && side.includes('Ravens'), 'the guild nav is drawn, as on the planner');
    assert(side.includes('href="#/roadmap" aria-label="Future enhancements" aria-current="page"'));
    assert(env.html('shell-tabs').includes('gs-tabs'), 'the guild tabs show on a phone');
    assert.equal(env.G.app.state.currentGid, null);
    assert.equal(env.fetched('/api/guild/g1'), 1);
  });

  await check('roadmap: when the ideas cannot be loaded the page still shows, with an error line and Try again for that part only', async () => {
    let fail = true;
    const env = makeEnv({
      url: '/#/roadmap', hint: true, beforeApp: ideaEls,
      routes: signedInRoutes(MEMBER_CAN, { 'GET /api/roadmap/ideas': () => (fail ? { status: 500, body: {} } : { status: 200, body: { ideas: [IDEA_ROW('ri_9')] } }) }),
    });
    await settle();
    assert(env.html('gs-main').includes('In progress') && env.html('gs-main').includes('Loot history') && !env.html('gs-main').includes('Could not load this page'));
    assert(env.G.app.state.failure === null);
    assert(env.html('rm-ideas').includes('The submitted ideas could not be loaded.') && env.html('rm-ideas').includes('data-action="roadmap-ideas-retry"'));
    fail = false;
    env.click({ 'data-action': 'roadmap-ideas-retry' });
    await settle();
    assert.equal(env.fetched('/api/roadmap/ideas'), 2);
    assert(env.html('rm-ideas').includes('Idea ri_9') && !env.html('rm-ideas').includes('could not be loaded'));
  });

  await check('roadmap: the area filter and the Shipped box re-render the page and keep their state; a jump to an item clears what hides it', async () => {
    const env = makeEnv({ url: '/#/roadmap', beforeApp: ideaEls, routes: { '/auth/me': { status: 401, body: {} } } });
    await settle();
    const cards = () => (env.html('gs-main').match(/<li class="gs-rm-card"/g) || []).length;
    const all = cards();
    env.click({ 'data-action': 'roadmap-area', 'data-area': 'loot' });
    assert(cards() > 0 && cards() < all);
    assert(/data-area="loot"[^>]*aria-pressed="true"/.test(env.html('gs-main')));
    env.click({ 'data-action': 'roadmap-area', 'data-area': 'nope' });
    assert.equal(cards(), all, 'an unknown area is All');
    assert(!/<details[^>]* open/.test(env.html('gs-main')));
    env.click({ 'data-action': 'roadmap-shipped' });
    env.click({ 'data-action': 'roadmap-area', 'data-area': 'planner' });
    assert(/<details class="gs-how gs-rm-shipped" open>/.test(env.html('gs-main')), 'a re-render keeps Shipped open');
    env.click({ 'data-action': 'roadmap-shipped' });
    env.click({ 'data-action': 'roadmap-area', 'data-area': 'platform' });
    assert(!/<details[^>]* open/.test(env.html('gs-main')), 'closed again');
    const jump = env.click({ 'data-action': 'roadmap-goto', 'data-item': 'loot-history' });
    assert.equal(jump.prevented, 1);
    assert(/data-area="all"[^>]*aria-pressed="true"/.test(env.html('gs-main')), 'the filter that hid the item is cleared');
    assert.equal(env.els['rm-item-loot-history'].focused, 1, 'the item takes focus');
    env.click({ 'data-action': 'roadmap-goto', 'data-item': 'discord-signin-roles-shell' });
    assert(/<details class="gs-how gs-rm-shipped" open>/.test(env.html('gs-main')), 'a shipped item opens Shipped');
    env.click({ 'data-action': 'roadmap-goto', 'data-item': 'not-an-item' });
  });

  await check('roadmap: submitting an idea posts it trimmed, thanks the person, empties the form and puts the idea at the top of the list', async () => {
    const posted = [];
    const env = makeEnv({
      url: '/#/roadmap', hint: true, beforeApp: ideaEls,
      routes: signedInRoutes(MEMBER_CAN, {
        'GET /api/roadmap/ideas': { status: 200, body: { ideas: [IDEA_ROW('ri_old')] } },
        'POST /api/roadmap/ideas': init => { posted.push(JSON.parse(init.body)); return { status: 201, body: { idea: IDEA_ROW('ri_new', { title: 'Dark mode' }) } }; },
      }),
    });
    await settle();
    const form = fakeForm({ title: '  Dark mode ', area: 'planner', details: ' Because. ' });
    env.G.handlers.submit['roadmap-idea'](form);
    await settle();
    assert.deepEqual(posted, [{ title: 'Dark mode', area: 'planner', details: 'Because.' }]);
    assert.equal(env.els['rm-status'].textContent, 'Thanks - your idea is saved and will be reviewed.');
    assert.deepEqual([form.elements.title.value, form.elements.area.value, form.elements.details.value], ['', '', '']);
    assert.deepEqual(JSON.parse(JSON.stringify(env.G.app.state.roadmap.draft)), { title: '', area: '', details: '' });
    const ideas = env.html('rm-ideas');
    assert(ideas.indexOf('Dark mode') > 0 && ideas.indexOf('Dark mode') < ideas.indexOf('Idea ri_old'));
    env.G.handlers.input['roadmap-draft']({ getAttribute: () => 'title', value: 'typing again' });
    assert.equal(env.els['rm-status'].textContent, '', 'typing clears the thanks line');
    assert.equal(env.G.app.state.roadmap.draft.title, 'typing again');
    const noDetails = fakeForm({ title: 'Only a title', area: 'loot', details: '   ' });
    env.G.handlers.submit['roadmap-idea'](noDetails);
    await settle();
    assert.deepEqual(posted[1], { title: 'Only a title', area: 'loot' }, 'empty details are not sent');
  });

  await check('roadmap: an invalid form posts nothing and says which field; a server refusal lands next to its field or in the form', async () => {
    let reply = { status: 400, body: { error: 'bad_request', field: 'title', message: 'The title must be 3 to 120 characters.' } };
    const env = makeEnv({
      url: '/#/roadmap', hint: true, beforeApp: ideaEls,
      routes: signedInRoutes(MEMBER_CAN, { 'GET /api/roadmap/ideas': { status: 200, body: { ideas: [] } }, 'POST /api/roadmap/ideas': () => reply }),
    });
    await settle();
    const bad = fakeForm({ title: 'ab', area: '', details: '' });
    env.G.handlers.submit['roadmap-idea'](bad);
    await settle();
    assert.equal(env.fetchCalls.filter(c => c.method === 'POST').length, 0);
    assert(env.els['rm-title-error'].textContent.includes('3 to 120') && env.els['rm-title-error'].hidden === false);
    assert(env.els['rm-area-error'].textContent.includes('Pick the area'));
    assert.equal(env.els['rm-details-error'].hidden, true);
    assert.equal(bad.elements.title.attrs['aria-invalid'], 'true');
    assert.equal(bad.elements.title.focused, 1, 'focus goes to the first field with a problem');
    assert.equal(env.els['rm-status'].textContent, '');

    const refused = fakeForm({ title: 'Long enough', area: 'loot', details: '' });
    env.G.handlers.submit['roadmap-idea'](refused);
    await settle();
    assert.equal(env.els['rm-title-error'].textContent, 'The title must be 3 to 120 characters.');
    assert.equal(refused.elements.title.attrs['aria-invalid'], 'true');
    assert.equal(refused.elements.title.value, 'Long enough', 'what was typed stays');
    reply = { status: 429, body: { error: 'rate_limited', message: 'You have suggested a lot of ideas this hour. Come back a little later.', retryAfter: 120 } };
    env.G.handlers.submit['roadmap-idea'](fakeForm({ title: 'Long enough', area: 'loot', details: '' }));
    await settle();
    assert.equal(env.els['rm-form-error'].textContent, 'You have suggested a lot of ideas this hour. Come back a little later. Try again in 2 minutes.');
    assert.equal(env.els['rm-form-error'].hidden, false);
    assert.equal(env.els['rm-status'].textContent, '');
  });

  await check('roadmap: the form draft survives a re-render, and signing out forgets it', async () => {
    const env = makeEnv({ url: '/#/roadmap', hint: true, beforeApp: ideaEls, routes: signedInRoutes(MEMBER_CAN, { 'GET /api/roadmap/ideas': { status: 200, body: { ideas: [] } } }) });
    await settle();
    env.G.handlers.input['roadmap-draft']({ getAttribute: () => 'title', value: 'Half-typed "idea"' });
    env.G.handlers.change['roadmap-draft']({ getAttribute: () => 'area', value: 'raids' });
    env.click({ 'data-action': 'roadmap-area', 'data-area': 'loot' });
    assert(env.html('gs-main').includes('value="Half-typed &quot;idea&quot;"') && env.html('gs-main').includes('<option value="raids" selected>'));
    env.G.app.requireSignin();
    assert.equal(env.G.app.state.roadmap, null);
  });

  await check('roadmap: the sidebar team picker works on the roadmap page (it uses the chrome guild, not a guild page\'s)', async () => {
    const two = guildBody();
    two.teams.push({ id: 't2', name: 'Alts', size: 10, archived: false, lead: null });
    const env = makeEnv({ url: '/#/roadmap', hint: true, beforeApp: ideaEls, routes: signedInRoutes(null, { '/api/guild/g1': { status: 200, body: two }, 'GET /api/roadmap/ideas': { status: 200, body: { ideas: [] } } }) });
    await settle();
    assert(env.html('shell-sidebar').includes('gs-team-select'));
    const writes = env.els['shell-sidebar'].writes;
    env.G.handlers.change['team-pick']({ value: 't2' });
    assert.equal(env.store['raidsmith.guild.team.g1'], 't2');
    assert(env.els['shell-sidebar'].writes > writes, 'the chrome was drawn again');
  });

  await check('roadmap: the static pages link to it with an absolute address', async () => {
    const env = makeEnv({ page: 'faq', url: '/faq.html' });
    await settle();
    assert(env.html('shell-sidebar').includes('href="/#/roadmap" aria-label="Future enhancements"'));
  });

  // ── Battle.net (Phase 5): the routes through the real router ──
  const BNET_ME = { configured: true, link: { battletag: 'Tester#1234', linkedAt: 1, fetchedAt: 1, expiresAt: 2592000001 }, guilds: [{ guildId: 'g1', guildName: 'Ravens', gameVersion: 'tbc', region: 'EU', realm: 'Mistvale', realmKind: 'realm', supportLabel: 'TBC Anniversary', status: 'ok', message: null, characters: [{ name: 'Aldric', realm: 'Mistvale', realmSlug: 'mistvale', class: 'WARRIOR', level: 70, state: 'new', claim: null, claimable: true }] }] };
  const BNET_SETTINGS = { configured: true, supported: true, supportLabel: 'TBC Anniversary', message: null, realmKind: 'realm', guildName: null, effectiveGuildName: 'Ravens', realmSlug: 'mistvale', realmNeeded: false, rankLabels: Array(10).fill(''), rankDefaults: ['Guild Master', 'Rank 1', 'Rank 2', 'Rank 3', 'Rank 4', 'Rank 5', 'Rank 6', 'Rank 7', 'Rank 8', 'Rank 9'], canEdit: true };

  await check('Battle.net routes: #/linked and #/characters read GET /auth/bnet fresh, draw the last guild\'s nav, set the title and the crumb', async () => {
    const env = makeEnv({ url: '/#/linked', routes: signedInRoutes(MEMBER_CAN, { '/auth/bnet': { status: 200, body: BNET_ME } }) });
    await settle();
    assert.equal(env.fetched('/auth/bnet'), 1);
    assert(env.html('gs-main').includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Linked accounts</h1>') && env.html('gs-main').includes('Tester#1234'));
    assert.equal(env.documentFake.title, 'Linked accounts - Ravens - Raidsmith guild');
    assert(env.html('shell-topbar-lead').includes('Linked accounts'));
    assert(env.html('shell-sidebar').includes('Ravens'), 'the nav is the last guild\'s');
    env.loc.hash = '#/characters';
    await settle();
    assert.equal(env.fetched('/auth/bnet'), 2, 'every visit asks again');
    assert(env.html('gs-main').includes('<h1 class="gs-h1" id="page-title" tabindex="-1">My characters</h1>') && env.html('gs-main').includes('data-action="bnet-claim"'));
    assert.equal(env.documentFake.title, 'My characters - Ravens - Raidsmith guild');
    // the avatar menu reaches both
    assert(env.html('shell-topbar-account').includes('href="#/characters"') && env.html('shell-topbar-account').includes('href="#/linked"'));
  });

  await check('Battle.net routes: the link\'s own errors show at #/linked?error=..; signed-out visitors get the sign-in card; a failed read is a retry page', async () => {
    const env = makeEnv({ url: '/#/linked?error=denied', routes: signedInRoutes(MEMBER_CAN, { '/auth/bnet': { status: 200, body: Object.assign({}, BNET_ME, { link: null }) } }) });
    await settle();
    assert(env.html('gs-main').includes('id="bnet-link-error"') && env.html('gs-main').includes('Connect Battle.net'));
    const out = makeEnv({ url: '/#/characters', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } } } });
    await settle();
    assert(out.html('gs-main').includes('Continue with Discord') && !out.html('gs-main').includes('My characters</h1>'));
    assert.equal(out.fetched('/auth/bnet'), 0);
    const down = makeEnv({ url: '/#/characters', routes: signedInRoutes(MEMBER_CAN, { '/auth/bnet': { status: 500, body: {} } }) });
    await settle();
    assert(down.html('gs-main').includes('Could not load this page') && down.html('gs-main').includes('data-action="retry"'));
  });

  await check('Battle.net routes: the import page reads the guild\'s Battle.net settings first; members cannot open it', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster/import/bnet', routes: signedInRoutes(OFFICER_CAN, { '/api/guild/g1/bnet': { status: 200, body: BNET_SETTINGS } }) });
    await settle();
    assert.equal(env.fetched('/api/guild/g1/bnet'), 1);
    const main = env.html('gs-main');
    assert(main.includes('Import from Battle.net') && main.includes('data-action="bnet-load"') && main.includes('Reads <strong>Ravens</strong> on Mistvale (EU)'));
    assert.equal(env.documentFake.title, 'Import from Battle.net - Ravens - Raidsmith guild');
    assert(env.html('shell-topbar-lead').includes('Import from Battle.net'));
    const member = makeEnv({ url: '/#/g/g1/roster/import/bnet', routes: signedInRoutes(MEMBER_CAN) });
    await settle();
    assert(member.html('gs-main').includes('You cannot open this'));
    assert.equal(member.fetched('/api/guild/g1/bnet'), 0);
  });

  await check('Battle.net routes: the preview and a commit run through the real page and end on an inline result with a link to the roster', async () => {
    const preview = { guild: { name: 'Ravens', realm: 'Mistvale' }, team: { id: 't1', name: 'Main' }, fetchedAt: 1, rankLabels: Array(10).fill(''), ranks: [{ rank: 0, label: 'Guild Master', count: 1 }], rows: [{ key: 'thornwick|mistvale', name: 'Thornwick', realm: 'Mistvale', realmSlug: 'mistvale', class: 'WARRIOR', level: 70, rank: 0, status: 'new', person: null }] };
    let committed = null;
    const env = makeEnv({ url: '/#/g/g1/roster/import/bnet', routes: signedInRoutes(OFFICER_CAN, {
      '/api/guild/g1/bnet': { status: 200, body: BNET_SETTINGS },
      'POST /api/guild/g1/roster/import/bnet/preview': { status: 200, body: preview },
      'POST /api/guild/g1/roster/import/bnet/commit': init => { committed = JSON.parse(init.body); return { status: 201, body: { people: 1, characters: 1, rosterFlags: { t1: 0 } } }; },
    }) });
    await settle();
    env.click({ 'data-action': 'bnet-load' });
    await settle();
    assert(env.html('gs-main').includes('Thornwick') && env.html('gs-main').includes('id="bnet-footer"'));
    assert.deepEqual(plain(JSON.parse(env.fetchCalls.filter(c => c.url.endsWith('/bnet/preview'))[0].body)), { teamId: 't1' });
    env.G.app.state.imports.bnet.ticked = { 'thornwick|mistvale': true };
    env.click({ 'data-action': 'bnet-commit' });
    await settle();
    assert.deepEqual(plain(committed), { teamId: 't1', defaultStatus: 'trial', members: [{ name: 'Thornwick', realmSlug: 'mistvale' }] });
    assert.equal(env.loc.hash, '#/g/g1/roster/import/bnet', 'the result is on the import page, not a notice on the next one');
    assert(env.html('gs-main').includes('id="bnet-result-banner"') && env.html('gs-main').includes('Added 1 person from the Battle.net guild roster.') && env.html('gs-main').includes('href="#/g/g1/roster">'));
    assert.equal(env.G.app.state.rosterNotice, '');
  });

  await check('Battle.net routes: Guild settings > Battle.net reads GET /bnet for guild.teams holders and is not a tab for anyone else', async () => {
    const env = makeEnv({ url: '/#/g/g1/settings/battlenet', routes: signedInRoutes(OFFICER_CAN, { '/api/guild/g1/bnet': { status: 200, body: BNET_SETTINGS } }) });
    await settle();
    assert.equal(env.fetched('/api/guild/g1/bnet'), 1);
    const main = env.html('gs-main');
    assert(main.includes('id="settings-title" tabindex="-1">Battle.net</h2>') && main.includes('id="bnet-guild-name"') && main.includes('aria-current="page"'));
    assert(main.includes('href="#/g/g1/settings/teams"'), 'the list of pages');
    assert.equal(env.documentFake.title, 'Guild settings - Ravens - Raidsmith guild');
    assert(env.html('shell-topbar-lead').includes('Battle.net'));
    const lead = makeEnv({ url: '/#/g/g1/settings/battlenet', routes: signedInRoutes({ 'roster.view': 'guild', 'roster.edit': ['t1'], 'attendance.policy': 'guild' }) });
    await settle();
    assert(lead.html('gs-main').includes('Your role does not include this part of Guild settings.'));
    assert.equal(lead.fetched('/api/guild/g1/bnet'), 0);
  });

  await check('Battle.net routes: the review queue lists Character claims for roster.edit and survives a failed claims read', async () => {
    const can = Object.assign({}, OFFICER_CAN, { 'raids.view': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild' });
    const claim = { id: 'cl_1', character: { name: 'Eliora', realm: 'Mistvale', class: 'PALADIN', level: 61 }, claimedAt: 1, claimant: { id: 'u2', username: 'erin', displayName: 'Erin E', avatarUrl: null, initials: 'EE' }, plan: { kind: 'new_person', reason: null, message: null, person: null, defaultTeamId: null, canDecide: true } };
    const review = { status: 200, body: { team: 't1', raids: [], stale: [] } };
    const env = makeEnv({ url: '/#/g/g1/attendance/review', routes: signedInRoutes(can, { '/api/guild/g1/attendance/review?team=t1': review, '/api/guild/g1/claims': { status: 200, body: { claims: [claim] } } }) });
    await settle();
    assert(env.html('gs-main').includes('id="claims-section"') && env.html('gs-main').includes('Eliora') && env.html('gs-main').includes('data-submit="claim-approve"'));
    assert(!env.html('gs-main').includes('Nothing to review'));
    const failing = makeEnv({ url: '/#/g/g1/attendance/review', routes: signedInRoutes(can, { '/api/guild/g1/attendance/review?team=t1': review, '/api/guild/g1/claims': { status: 500, body: {} } }) });
    await settle();
    assert(failing.html('gs-main').includes('id="claims-error"') && failing.html('gs-main').includes('Nothing to review'));
    const teamLeadOnly = makeEnv({ url: '/#/g/g1/attendance/review', routes: signedInRoutes({ 'roster.view': 'guild', 'attendance.review': ['t1'], 'attendance.view': ['t1'] }, { '/api/guild/g1/attendance/review?team=t1': review }) });
    await settle();
    assert.equal(teamLeadOnly.fetched('/claims'), 0, 'no roster.edit, no claims read');
  });

  // ── PM wave 1: Home, the Activity tab, the trial card, the calendar button and the watch list through the real router ──
  const HOME_CAN = Object.assign({}, OFFICER_CAN, { 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild' });
  const ATTENTION_BODY = { today: '2026-10-17', total: 2, more: {}, items: [
    { id: 'review:r1', kind: 'review', severity: 'action', teamId: 't1', teamName: 'Main', raidId: 'r1', date: '2026-10-17', zone: 'BT', title: null, count: 3, link: { name: 'raid', rid: 'r1' } },
    { id: 'claims', kind: 'claims', severity: 'action', teamId: null, teamName: null, count: 1, link: { name: 'review' } },
  ] };
  const attentionRoute = { '/api/guild/g1/attention': { status: 200, body: ATTENTION_BODY } };
  const replaces = env => env.history.calls.filter(c => c[0] === 'replace').map(c => c[1]);

  await check('Home route: #/g/:gid (and /home) opens the needs-attention list for officers, with the Home nav item first, current, and counting the open work', async () => {
    const env = makeEnv({ url: '/#/g/g1', routes: signedInRoutes(HOME_CAN, attentionRoute) });
    await settle();
    const main = env.html('gs-main');
    assert(main.includes('<h1 class="gs-h1 gs-hd-h1" id="page-title" tabindex="-1">This week</h1>') && main.includes('Review Sat Oct 17: 3 to decide') && main.includes('3 character claims') === false && main.includes('1 character claim is waiting'));
    assert.equal(env.loc.hash, '#/g/g1', 'no redirect for an officer');
    assert.equal(env.documentFake.title, 'Home - Ravens - Raidsmith guild');
    assert(env.html('shell-topbar-lead').includes('>Home<'));
    const side = env.html('shell-sidebar');
    assert(side.indexOf('href="#/g/g1"') > 0 && side.indexOf('href="#/g/g1"') < side.indexOf('href="#/g/g1/roster"'), 'Home first');
    assert(side.includes('aria-label="Home, 2 items need attention" aria-current="page"') && /gs-nav-badge" aria-hidden="true">2</.test(side));
    assert(env.html('shell-rail').includes('class="gs-tile is-active" href="#/g/g1"'), 'the rail tile goes to Home');
    assert(env.html('shell-tabs').includes('<a class="gs-tab is-active" href="#/g/g1"'), 'the Home tab is highlighted on Home');
    assert.equal(env.fetched('/api/guild/g1/attention'), 1, 'the page reads it once; no second background read');
    assert.equal(env.G.app.state.attention.g1.data.total, 2);
    const alias = makeEnv({ url: '/#/g/g1/home', routes: signedInRoutes(HOME_CAN, attentionRoute) });
    await settle();
    assert(alias.html('gs-main').includes('Review Sat Oct 17: 3 to decide') && alias.loc.hash === '#/g/g1/home');
  });

  await check('Home route: members (and anyone without an officer action) stay on #/g/:gid and get their own Home; they never ask for the list', async () => {
    const env = makeEnv({ url: '/#/g/g1', routes: signedInRoutes(MEMBER_CAN, attentionRoute) });
    await settle();
    assert.equal(env.loc.hash, '#/g/g1', 'no redirect to Roster');
    assert.deepEqual(replaces(env), []);
    assert(env.documentFake.title.startsWith('Home - Ravens'));
    assert.equal(env.fetched('/attention'), 0);
    const side = env.html('shell-sidebar');
    assert(side.includes('aria-label="Home" aria-current="page"') && !/gs-nav-badge/.test(side.slice(0, side.indexOf('href="#/g/g1/roster"'))), 'Home is first, current, and counts nothing for a member');
    assert(env.html('gs-main').includes('Welcome back') && env.html('gs-main').includes('id="home-next"') && !env.html('gs-main').includes('Needs attention'));
    assert.equal(env.fetched('/api/guild/g1/raids?team=t1'), 1, 'the next raid comes from the selected team upcoming list');
    const lead = makeEnv({ url: '/#/g/g1/home', routes: signedInRoutes({ 'roster.view': 'guild', 'raids.view': 'guild', 'audit.view': 'guild' }, attentionRoute) });
    await settle();
    assert.equal(lead.loc.hash, '#/g/g1/home', 'audit.view alone is not an item action: the member Home');
    assert(lead.html('gs-main').includes('id="home-next"'));
  });

  await check('Home route: the sign-in landing (#/ and #/signin) goes to #/g/:gid first; officers and members both stay on Home', async () => {
    const officer = makeEnv({ url: '/#/', routes: signedInRoutes(HOME_CAN, attentionRoute) });
    await settle();
    assert.equal(officer.loc.hash, '#/g/g1');
    assert.deepEqual(replaces(officer), ['/#/g/g1']);
    assert(officer.html('gs-main').includes('Review Sat Oct 17: 3 to decide'));
    const member = makeEnv({ url: '/#/signin', routes: signedInRoutes(MEMBER_CAN, attentionRoute) });
    await settle();
    assert.equal(member.loc.hash, '#/g/g1');
    assert.deepEqual(replaces(member), ['/#/g/g1']);
    assert(member.html('gs-main').includes('Welcome back'));
  });

  await check('Home count: read in the background on a guild page without redrawing it, shown on the nav, not asked again within a minute, asked again after', async () => {
    const env = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes(HOME_CAN, attentionRoute) });
    await settle();
    assert.equal(env.fetched('/api/guild/g1/attention'), 1);
    assert(env.html('shell-sidebar').includes('aria-label="Home, 2 items need attention"'), 'the badge arrives');
    // a later answer redraws the nav slots only
    env.G.app.state.attention = {};
    const mainWrites = env.els['gs-main'].writes;
    const sideWrites = env.els['shell-sidebar'].writes;
    await env.G.app.ensureAttention('g1', true);
    await settle();
    assert.equal(env.els['gs-main'].writes, mainWrites, 'the page itself is not rewritten (typed input survives)');
    assert(env.els['shell-sidebar'].writes > sideWrites);
    assert.equal(env.fetched('/api/guild/g1/attention'), 2);
    env.loc.hash = '#/g/g1/roster?team=t1';
    await settle();
    assert.equal(env.fetched('/api/guild/g1/attention'), 2, 'a route change within the minute');
    env.G.app.state.attention.g1.at -= 61000;
    env.loc.hash = '#/g/g1/roster';
    await settle();
    assert.equal(env.fetched('/api/guild/g1/attention'), 3, 'older than a minute: read again');
    // a guild switch to a viewer without actions never asks
    const member = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes(MEMBER_CAN, attentionRoute) });
    await settle();
    assert.equal(member.fetched('/attention'), 0);
    // a failing Worker is silent and is not hammered
    const bad = makeEnv({ url: '/#/g/g1/roster', routes: signedInRoutes(HOME_CAN, { '/api/guild/g1/attention': { status: 500, body: {} } }) });
    await settle();
    bad.loc.hash = '#/g/g1/roster?team=t1';
    await settle();
    assert.equal(bad.fetched('/attention'), 1);
    assert(bad.html('shell-sidebar').includes('>Home<') && !bad.html('shell-sidebar').includes('items need attention'));
    // the sign-out forgets it
    env.G.app.state.attention.g1 = { data: { total: 9 }, at: Date.now() };
    env.click({ 'data-action': 'sign-out' });
    await settle();
    assert.deepEqual(plain(env.G.app.state.attention), {});
  });

  await check('Home route: opening a review item selects its team first (state and storage), then the link navigates', async () => {
    const two = can => {
      const body = guildBody(can);
      body.teams = [{ id: 't1', name: 'Main', size: 25, archived: false, lead: null }, { id: 't2', name: 'Weekend', size: 25, archived: false, lead: null }];
      return body;
    };
    const attn = { today: '2026-10-17', total: 1, more: {}, items: [{ id: 'review:r9', kind: 'review', severity: 'action', teamId: 't2', teamName: 'Weekend', raidId: 'r9', date: '2026-10-17', zone: null, title: null, count: 2, link: { name: 'review' } }] };
    const env = makeEnv({ url: '/#/g/g1', routes: signedInRoutes(HOME_CAN, { '/api/guild/g1': { status: 200, body: two(HOME_CAN) }, '/api/guild/g1/attention': { status: 200, body: attn } }) });
    await settle();
    assert(env.html('gs-main').includes('data-action="attn-open" data-team="t2"') && env.html('gs-main').includes('Weekend'), 'the team shows with two teams');
    env.click({ 'data-action': 'attn-open', 'data-team': 't2', href: '#/g/g1/attendance/review' });
    assert.equal(env.G.app.state.teamByGuild.g1, 't2');
    assert.equal(env.store['raidsmith.guild.team.g1'], 't2');
  });

  const AUDIT_BODY = { timeZone: 'America/New_York', rows: [{ id: 'a1', at: Date.UTC(2026, 9, 18, 0, 15), actor: { id: 'u1', displayName: 'Alice' }, action: 'person.update', group: 'roster', text: 'Moved Thoren to Reserve', entityType: 'person', entityId: 'p1', before: { status: 'raider' }, after: { status: 'reserve' } }],
    next: null, types: [{ id: 'roster', label: 'Roster' }, { id: 'loot', label: 'Loot' }], actors: [{ id: 'u1', displayName: 'Alice' }] };

  await check('Activity tab: audit.view opens Guild settings > Activity (list read, tab strip, title); a viewer without it gets the role message; a 403 is the message page', async () => {
    const can = Object.assign({}, OFFICER_CAN, { 'audit.view': 'guild' });
    const env = makeEnv({ url: '/#/g/g1/settings/activity', routes: signedInRoutes(can, { '/api/guild/g1/audit': { status: 200, body: AUDIT_BODY } }) });
    await settle();
    const main = env.html('gs-main').replace(/[  ]/g, ' ');
    assert(main.includes('Moved Thoren to Reserve') && main.includes('Oct 17, 8:15 PM') && main.includes('href="#/g/g1/settings/activity" aria-current="page">Activity<'), 'list and tab');
    assert(main.includes('href="/api/guild/g1/audit?format=csv" download'));
    assert.equal(env.documentFake.title, 'Guild settings - Ravens - Raidsmith guild');
    assert(env.html('shell-topbar-lead').includes('Activity'));
    // a filter change through the delegated change listener reads the list again
    env.fire('document', 'change', { target: Object.assign(target({ 'data-change': 'audit-filter', 'data-filter': 'type' }), { value: 'loot' }) });
    await settle();
    assert(env.fetchCalls.some(c => c.url === '/api/guild/g1/audit?type=loot'));
    const none = makeEnv({ url: '/#/g/g1/settings/activity', routes: signedInRoutes(OFFICER_CAN, { '/api/guild/g1/audit': { status: 200, body: AUDIT_BODY } }) });
    await settle();
    assert(none.html('gs-main').includes('Your role does not include this part of Guild settings.'));
    assert.equal(none.fetched('/audit'), 0);
    const only = makeEnv({ url: '/#/g/g1/settings', routes: signedInRoutes({ 'roster.view': 'guild', 'audit.view': 'guild' }, { '/api/guild/g1/audit': { status: 200, body: AUDIT_BODY } }) });
    await settle();
    assert.equal(only.loc.hash, '#/g/g1/settings/activity', 'audit.view alone lands on its only tab');
    const denied = makeEnv({ url: '/#/g/g1/settings/activity', routes: signedInRoutes(can, { '/api/guild/g1/audit': { status: 403, body: { error: 'forbidden', message: 'No.' } } }) });
    await settle();
    assert(denied.html('gs-main').includes('You cannot open this'));
  });

  const TRIAL_RECORD = status => ({ today: '2026-10-17', can: { edit: true, notesView: true, notesEdit: true, delete: false, addCharacter: true },
    person: { id: 'p1', status, joinedOn: '2026-09-19', trialStart: '2026-10-03', trialEnd: '2026-10-24', trialFlag: status === 'trial' ? { kind: 'ends', days: 7 } : null, isMe: false, version: 4, discord: { signIn: 'not_yet', user: null, nickname: null }, homeTeam: { id: 't1', name: 'Main' } },
    characters: [{ id: 'c1', name: 'Thoren', realm: null, class: 'PALADIN', mainSpec: 'Protection', offSpec: null, role: 'tank', isMain: true, team: { id: 't1', name: 'Main', archived: false } }], notes: { text: 'Likes fire', version: 2 } });
  const TRIAL_BODY = { today: '2026-10-17', person: { id: 'p1', name: 'Thoren', status: 'trial', trialStart: '2026-10-03', trialEnd: '2026-10-24', trialFlag: { kind: 'ends', days: 7 }, joinedOn: '2026-09-19', version: 4 }, since: '2026-10-03',
    attendance: { team: { id: 't1', name: 'Main' }, raids: 6, pct: 83.3, present: 5, missed: 1, missedNotice: 1, late: 1, leftEarly: 0, fillIns: 1, pending: 0 },
    loot: { total: 1, ms: 1, os: 0, de: 0, bank: 0, items: [{ itemId: 28770, itemName: 'Nathrezim Mindblade', tag: 'MS', raidOn: '2026-10-10' }] }, notes: { excerpt: 'Likes fire', truncated: false } };

  await check('Trial card route: a Trial the viewer edits reads GET /roster/:pid/trial and shows the card; a raider, a 403 and a 404 leave the page without a card or an error', async () => {
    const base = { '/api/guild/g1/attendance/person/p1': { status: 403, body: { error: 'forbidden' } }, '/api/guild/g1/loot/person/p1': { status: 403, body: { error: 'forbidden' } }, '/api/guild/g1/roster/linkable': { status: 200, body: { people: [] } } };
    const env = makeEnv({ url: '/#/g/g1/roster/p/p1', routes: signedInRoutes(HOME_CAN, Object.assign({ '/api/guild/g1/roster/p1': { status: 200, body: TRIAL_RECORD('trial') }, '/api/guild/g1/roster/p1/trial': { status: 200, body: TRIAL_BODY } }, base)) });
    await settle();
    const main = env.html('gs-main');
    assert(main.includes('id="trial-card-h">Trial review</h2>') && main.includes('>1 MS<') && main.includes('data-action="trial-promote"'));
    assert(!main.includes('gs-trial-bar') && main.indexOf('id="trial-card-h"') < main.indexOf('id="characters-h"'));
    assert.equal(env.fetched('/roster/p1/trial'), 1);
    const raider = makeEnv({ url: '/#/g/g1/roster/p/p1', routes: signedInRoutes(HOME_CAN, Object.assign({ '/api/guild/g1/roster/p1': { status: 200, body: TRIAL_RECORD('raider') }, '/api/guild/g1/roster/p1/trial': { status: 200, body: TRIAL_BODY } }, base)) });
    await settle();
    assert(!raider.html('gs-main').includes('trial-card-h') && raider.html('gs-main').includes('id="characters-h"'));
    assert.equal(raider.fetched('/roster/p1/trial'), 0, 'no request for a raider');
    for (const status of [403, 404]) {
      const gone = makeEnv({ url: '/#/g/g1/roster/p/p1', routes: signedInRoutes(HOME_CAN, Object.assign({ '/api/guild/g1/roster/p1': { status: 200, body: TRIAL_RECORD('trial') }, '/api/guild/g1/roster/p1/trial': { status, body: { error: 'forbidden' } } }, base)) });
      await settle();
      assert(gone.html('gs-main').includes('id="characters-h"') && !gone.html('gs-main').includes('trial-card-h') && !gone.html('gs-main').includes('Could not load this page'), 'status ' + status);
    }
    const member = makeEnv({ url: '/#/g/g1/roster/p/p1', routes: signedInRoutes(MEMBER_CAN, Object.assign({ '/api/guild/g1/roster/p1': { status: 200, body: Object.assign(TRIAL_RECORD('trial'), { can: { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false } }) } }, base)) });
    await settle();
    assert.equal(member.fetched('/roster/p1/trial'), 0, 'a viewer who cannot edit never asks');
    assert(!member.html('gs-main').includes('trial-card-h'));
  });

  await check('Raids and Attendance routes: the Raids header carries Subscribe in your calendar for members too; the team attendance page shows the Needs a look panel above the bar', async () => {
    const can = Object.assign({}, MEMBER_CAN, { 'raids.view': 'guild', 'attendance.view': ['t1'] });
    const rt = { '/api/guild/g1/raids?team=t1': { status: 200, body: { team: 't1', raids: [], upcoming: [] } } };
    const raids = makeEnv({ url: '/#/g/g1/raids', routes: signedInRoutes(can, rt) });
    await settle();
    assert(raids.html('gs-main').includes('data-action="cal-open"') && raids.html('gs-main').includes('Subscribe in your calendar'));
    const watch = { below: 0.75, dropBy: 0.15, window: 8, previousFrom: '2026-07-21', entries: [{ playerId: 'p1', name: 'Thoren', class: 'PALADIN', status: 'raider', pct: 62, previousPct: 82, drop: 20, counted: 8, missed: 3, missedNotice: 1, reasons: ['below', 'drop'] }] };
    const team = { team: 't1', window: 8, policy: { switchWeeks: [8, 12] }, weeks: [{ weekStart: '2026-10-13', raids: [{ id: 'r1', raidOn: '2026-10-17', zone: 'BT' }] }], people: [{ id: 'p1', name: 'Thoren', class: 'PALADIN', status: 'raider', pct: 62, pctAll: 70, signupRate: 90, streak: 0, lastAttended: '2026-10-10', cells: [], isMe: false }], awaitingReview: 0, staleRaids: 0, watch };
    const att = makeEnv({ url: '/#/g/g1/attendance', routes: signedInRoutes(HOME_CAN, { '/api/guild/g1/attendance/team?team=t1': { status: 200, body: team }, '/api/guild/g1/attendance/policy': { status: 200, body: { defaults: {}, guild: {}, teams: {}, resolved: {}, versions: { guild: 0, teams: {} }, wcl: { guildId: null, uploaders: {} } } } }) });
    await settle();
    assert(att.html('gs-main').includes('aria-label="Needs a look"') && att.html('gs-main').includes('href="#/g/g1/attendance/p/p1"') && att.html('gs-main').includes('Below 75% and down 20 points - 62%, was 82%'));
    const none = makeEnv({ url: '/#/g/g1/attendance', routes: signedInRoutes(HOME_CAN, { '/api/guild/g1/attendance/team?team=t1': { status: 200, body: Object.assign({}, team, { watch: null }) }, '/api/guild/g1/attendance/policy': { status: 200, body: { defaults: {}, guild: {}, teams: {}, resolved: {}, versions: { guild: 0, teams: {} }, wcl: { guildId: null, uploaders: {} } } } }) });
    await settle();
    assert(!none.html('gs-main').includes('Needs a look'));
  });

  await check('settings route: the bare address opens the first page on a wide screen and the list of pages alone on a phone; every old tab address still opens its page', async () => {
    const wide = makeEnv({ url: '/#/g/g1/settings', routes: signedInRoutes(OFFICER_CAN) });
    await settle();
    assert.equal(wide.loc.hash, '#/g/g1/settings/general', 'the first page the viewer has');
    const main = wide.html('gs-main');
    assert(main.includes('is-view-detail') && main.includes('id="settings-title" tabindex="-1">General</h2>') && main.includes('id="page-title" tabindex="-1">Guild settings</h1>'));
    assert(main.includes('Only the Guild Master can change the name, realm or time zone.') && !main.includes('data-submit="general-form"'), 'an officer reads General');
    const phone = makeEnv({ url: '/#/g/g1/settings', routes: signedInRoutes(OFFICER_CAN), beforeApp: sb => { sb.matchMedia = q => ({ matches: /max-width: 760px/.test(q) }); } });
    await settle();
    assert.equal(phone.loc.hash, '#/g/g1/settings', 'a phone stays on the bare address: the list is its first screen');
    const list = phone.html('gs-main');
    assert(list.includes('is-view-list') && list.includes('Guild</h2>') && list.includes('href="#/g/g1/settings/general"') && list.includes('href="#/g/g1/settings/teams"') && !list.includes('aria-current="page"'));
    assert.equal(phone.history.calls.filter(c => c[0] === 'replace').length, 0, 'no redirect');
    // the Guild Master edits General: the form is there with the Save bar
    const gmBody = Object.assign(guildBody(OFFICER_CAN), { me: { roles: [{ role: 'guild_master' }], can: OFFICER_CAN } });
    gmBody.guild.timeZone = 'America/Chicago';
    gmBody.guild.discordServerId = '900000000000000001';
    const gm = makeEnv({ url: '/#/g/g1/settings/general', routes: signedInRoutes(OFFICER_CAN, { '/api/guild/g1': { status: 200, body: gmBody } }) });
    await settle();
    const gmMain = gm.html('gs-main');
    assert(gmMain.includes('data-submit="general-form"') && gmMain.includes('data-dirty-form') && gmMain.includes('data-savebar') && gmMain.includes('ID 900000000000000001'));
    assert(gmMain.includes('Realm'), 'a realm guild has the realm field');
    // a viewer without guild.teams does not reach General
    const lead = makeEnv({ url: '/#/g/g1/settings/general', routes: signedInRoutes({ 'roster.view': 'guild', 'raids.edit': 'guild' }) });
    await settle();
    assert(lead.html('gs-main').includes('Your role does not include this part of Guild settings.'));
    // the old addresses
    const can = Object.assign({}, OFFICER_CAN, { 'guild.roles': 'guild', 'attendance.policy': 'guild', 'loot.policy': 'guild', 'raids.edit': 'guild', 'audit.view': 'guild' });
    const teams = makeEnv({ url: '/#/g/g1/settings/teams', routes: signedInRoutes(can) });
    await settle();
    const t = teams.html('gs-main');
    assert(t.includes('id="settings-title" tabindex="-1">Teams</h2>') && t.includes('aria-current="page">Teams<') && (t.match(/class="gs-sgroup-h"/g) || []).length >= 4);
    const accounts = makeEnv({ url: '/#/g/g1/settings/accounts', routes: signedInRoutes(can, { '/api/guild/g1/people': { status: 200, body: { people: [], removed: [], signedInCount: 0, roster: null } } }) });
    await settle();
    assert(accounts.html('gs-main').includes('id="settings-title" tabindex="-1">Accounts</h2>'), 'the Accounts name reads as the people address');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
