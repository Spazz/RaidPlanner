/**
 * Raidsmith guild app - lane B8a-base of the user-hierarchy build: the groundwork the four B8a page lanes (setup, users, links, owner) start from.
 * Run: node tests/guild/guild-b8a-base-tests.js [name filter]
 *
 *   - router: the Users list (and its segments), one user, Guild setup, the Settings tabs links and claimreview and #/fresh round-trip through parse <-> format; the old settings
 *     addresses (people, accounts, guests, dataaccess) still parse;
 *   - shell: Users sits under Guild admin above Guild settings and shows with guild.access only; Links and keys and Owner review follow their list rules; the breadcrumbs and the
 *     page stubs draw a real head;
 *   - Worker: GET /api/guild/:gid carries `owner` ({ name, you }, `suspended` for the seat holder and guild.access, `reviewOpen` for the Owner) from one statement with no table scan;
 *   - Guild.fresh (js/guild/fresh.js): the step, start, the pending act, registered acts repeated by #/fresh?done=<purpose> (not when older than 15 minutes), every error reason;
 *   - the call sites: Disconnect / connect Discord and Battle.net, the #/linked?error=fresh_required landing, guild delete and the legacy claim's claim_closed.
 * The UI half loads the shared guild script list into a vm with fake documents (as the other UI suites); the Worker half drives worker/index.js over the D1 stand-in.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, runChecks } = require('../guild-b3-world');
const { claimWorld, claim } = require('../guild-claim');
const { freshScenario } = require('../guild-fresh');
const { scansSince } = require('../guild-plans');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__claimWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__claimWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 150)); }
    },
  });
}

// ---------------------------------------------------------------------------
// The browser half: the guild scripts in a vm with no DOM, a fake document, storage and location

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, URL };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const sandbox = loadGuild();
const G = sandbox.Guild;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let fields = {};
sandbox.document = { getElementById: (id) => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const field = (id) => (fields[id] = { id, textContent: '', hidden: true });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), has: (k) => map.has(k) };
}
let storage;
let navigations;
let goes;
function resetBrowser(hash = '') {
  fields = {};
  storage = memoryStorage();
  navigations = [];
  goes = [];
  sandbox.window = { sessionStorage: storage, location: { hash, assign: (url) => navigations.push(url) } };
  G.fresh.navigate = (url) => navigations.push(url);
  G.fresh.now = () => Date.now();
  G.app.go = (hash2, replace) => goes.push([hash2, !!replace]);
  G.app.state.me = null;
  G.app.state.guilds = {};
  G.app.state.lastGid = null;
  G.pages.fresh.reset();
}

// Scripted API: api({ 'POST /api/fresh/start': () => ..., ... }) replaces get / post / del and records every call as 'METHOD path'.
function scriptApi(script) {
  const calls = [];
  const respond = (method) => (apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : plain(body) });
    const fn = script[`${method} ${apiPath}`];
    if (!fn) return Promise.reject(new G.api.ApiError(404, { error: 'not_found' }));
    try { return Promise.resolve(fn(body)); } catch (error) { return Promise.reject(error); }
  };
  G.api.get = respond('GET');
  G.api.post = respond('POST');
  G.api.del = respond('DELETE');
  return calls;
}
const apiError = (status, body) => new G.api.ApiError(status, body);
const freshRequired = (purpose, params) => apiError(403, { error: 'fresh_required', message: 'Confirm it is you first.', purpose, ...(params ? { params } : {}) });
const AUTHORIZE = 'https://oauth.example.test/authorize?state=abc';

function fakeDialog(html = '<form>step 1</form>') {
  const dlg = { innerHTML: html, open: true, isConnected: true, querySelector: () => null, contains: () => false };
  const form = {
    closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [], elements: {},
  };
  return { dlg, form };
}
function stepForm(dlg, provider) {
  return { closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: (sel) => (provider && /input\[name="provider"\]/.test(sel) ? { value: provider } : null), querySelectorAll: () => [] };
}

const TEAMS = [{ id: 't1', name: 'Alpha', archived: false }];
const guildData = (can = {}, extra = {}) => ({ guild: { id: 'g1', name: 'Writers', realm: 'Nightslayer', gameVersion: 'tbc', timeZone: 'America/New_York' }, teams: TEAMS, me: { can, roles: [], personId: null }, ...extra });
const BOTH = { identities: { discord: { username: 'brandon' }, bnet: { battletag: 'Brandon#1482' } } };

// ---------------------------------------------------------------------------
// 1. Router

check('router: the Users list and its segments, one user, Guild setup, the settings tabs and #/fresh round-trip', () => {
  const routes = [
    { name: 'users', gid: 'g1', segment: null }, { name: 'users', gid: 'g1', segment: 'members' }, { name: 'users', gid: 'g1', segment: 'former' },
    { name: 'users', gid: 'g1', segment: 'nonmembers' }, { name: 'users', gid: 'g1', segment: 'blocked' },
    { name: 'user', gid: 'g1', key: 'u_abcdefghijklmnopqrstuv' }, { name: 'user', gid: 'g1', key: 'p_abcdefghijklmnopqrstuv' }, { name: 'user', gid: 'g1', key: `n_${'c3a4'.repeat(40)}` },
    { name: 'setup', gid: 'g1' },
    { name: 'settings', gid: 'g1', tab: 'links' }, { name: 'settings', gid: 'g1', tab: 'claimreview' },
    { name: 'fresh', done: 'handover', error: null, purpose: null }, { name: 'fresh', done: 'gm_claim', error: null, purpose: null },
    { name: 'fresh', done: null, error: 'mismatch', purpose: 'handover' }, { name: 'fresh', done: null, error: 'state', purpose: null }, { name: 'fresh', done: null, error: 'a_reason_nobody_knows', purpose: null },
    { name: 'fresh', done: null, error: null, purpose: null },
  ];
  for (const route of routes) assert.deepEqual(plain(G.router.parse(G.router.format(route))), route, G.router.format(route));
  assert.equal(G.router.format({ name: 'users', gid: 'g1', segment: 'nonmembers' }), '#/g/g1/users/non-members', 'the address says non-members');
  assert.deepEqual(plain(G.router.parse('#/g/g1/users/nonmembers')), { name: 'users', gid: 'g1', segment: 'nonmembers' }, 'the Worker word reads too');
  assert.equal(G.router.format({ name: 'users', gid: 'g1', segment: 'nobody' }), '#/g/g1/users');
});

check('router: the keys are encoded safely, strangers are not found, and a done wins over an error', () => {
  assert.equal(G.router.parse('#/g/g1/users/zzz').name, 'notfound');
  assert.equal(G.router.parse('#/g/g1/users/u/a%2Fb').name, 'notfound', 'an encoded slash is not a key');
  assert.equal(G.router.parse('#/g/g1/users/u/' + 'a'.repeat(521)).name, 'notfound');
  assert.equal(G.router.parse('#/g/g1/users/u/x/y').name, 'notfound');
  assert.equal(G.router.format({ name: 'user', gid: 'g1', key: '../x' }), '#/g/g1/users', 'a key that is no key formats as the list');
  assert.equal(G.router.format({ name: 'user', gid: 'g/1', key: 'u_abc' }), '#/g/g%2F1/users/u/u_abc');
  assert.deepEqual(plain(G.router.parse('#/fresh?done=pin&error=state&purpose=pin')), { name: 'fresh', done: 'pin', error: null, purpose: null });
  assert.deepEqual(plain(G.router.parse('#/fresh?done=nonsense')), { name: 'fresh', done: null, error: null, purpose: null });
  assert.deepEqual(plain(G.router.parse('#/fresh?error=state&purpose=nonsense')), { name: 'fresh', done: null, error: 'state', purpose: null });
  assert.deepEqual(plain(G.router.parse('#/fresh?error=%3Cimg%3E')), { name: 'fresh', done: null, error: null, purpose: null }, 'a reason is a word, never markup');
  assert(G.router.LINKED_ERRORS.includes('fresh_required'), '#/linked?error=fresh_required is a known landing');
  assert.equal(G.router.parse('#/linked?error=fresh_required').error, 'fresh_required');
});

check('router: nothing retired - people, accounts, guests and dataaccess still open, TABS and TAB_ALIASES stay one entry per line', () => {
  for (const tab of ['people']) assert.deepEqual(plain(G.router.parse(`#/g/g1/settings/${tab}`)), { name: 'settings', gid: 'g1', tab });
  for (const tab of ['guests', 'dataaccess']) assert.deepEqual(plain(G.router.parse(`#/g/g1/settings/${tab}`)), { name: 'settings', gid: 'g1', tab: 'links' }, `${tab} reads as Links and keys`);
  assert.deepEqual(plain(G.router.parse('#/g/g1/settings/accounts')), { name: 'settings', gid: 'g1', tab: 'people' });
  const source = read('js/guild/router.js');
  const block = (name) => source.slice(source.indexOf(`const ${name} = `), source.indexOf('];\n', source.indexOf(`const ${name} = `)) + 2);
  const tabs = block('TABS');
  assert(/const TABS = \[\n(    '[a-z]+',\n)+  \];/.test(tabs), 'TABS: one entry per line');
  assert(/const TAB_ALIASES = \{\n(    [a-z]+: '[a-z]+',\n)+  \};/.test(source.slice(source.indexOf('const TAB_ALIASES'), source.indexOf('};', source.indexOf('const TAB_ALIASES')) + 3)), 'TAB_ALIASES: one entry per line');
});

check('router and Worker agree on the acts: the fresh purposes, their providers, scope and who may ask', async () => {
  const { FRESH_PURPOSES } = await load('worker/fresh.js');
  assert.deepEqual([...G.router.FRESH_PURPOSES].sort(), Object.keys(FRESH_PURPOSES).sort());
  assert.deepEqual(Object.keys(G.fresh.PURPOSES).sort(), Object.keys(FRESH_PURPOSES).sort());
  for (const [purpose, spec] of Object.entries(FRESH_PURPOSES)) {
    assert.deepEqual(plain(G.fresh.PURPOSES[purpose].providers), [...spec.providers], `${purpose}: providers`);
    assert.equal(G.fresh.PURPOSES[purpose].scope, spec.scope, `${purpose}: scope`);
    assert.equal(G.fresh.PURPOSES[purpose].owner, spec.owner, `${purpose}: owner`);
  }
});

// ---------------------------------------------------------------------------
// 2. Shell: nav, settings list, crumbs, stubs

check('shell: Users sits under Guild admin above Guild settings and shows to the holders of guild.access only', () => {
  const keys = (can) => plain(G.shell.navItems('g1', can, 0).map((item) => item.key));
  assert.deepEqual(keys({ 'guild.access': 'guild' }).slice(-3), ['head-guild-admin', 'users', 'settings']);
  assert(!keys({ 'guild.teams': 'guild' }).includes('users'), 'guild.teams alone does not');
  assert(!keys({ 'guild.roles': 'guild' }).includes('users'), 'guild.roles alone does not');
  assert(!keys({ 'raids.edit': 'guild' }).includes('users'));
  assert(!keys({}).includes('users'), 'a member has none');
  assert(!keys({}).includes('head-guild-admin'));
  const users = G.shell.navItems('g1', { 'guild.access': 'guild' }, 0).find((item) => item.key === 'users');
  assert.equal(users.label, 'Users');
  assert.equal(users.href, '#/g/g1/users');
  assert(G.shell.canSeeUsers({ 'guild.access': ['t1'] }) && !G.shell.canSeeUsers({ 'guild.roles': 'guild' }));
  // The sidebar marks it current on the list and on a user's page, and never as a phone tab.
  const ctxOf = (route, can) => ({ section: 'guild', page: 'app', me: { user: { id: 'u1', displayName: 'A' } }, route, guildData: guildData(can) });
  const sidebar = (route) => G.shell.sidebarHtml(ctxOf(route, { 'guild.access': 'guild' }));
  for (const route of [{ name: 'users', gid: 'g1', segment: null }, { name: 'user', gid: 'g1', key: 'u_x' }]) {
    const active = G.shell.sidebarItems(ctxOf(route, { 'guild.access': 'guild' })).filter((item) => item.key === 'users');
    assert.equal(active.length, 1);
    assert(sidebar(route).includes('class="gs-nav-link is-active" href="#/g/g1/users"'), route.name);
  }
  assert(!sidebar({ name: 'section', gid: 'g1', section: 'home' }).includes('class="gs-nav-link is-active" href="#/g/g1/users"'));
  assert(sidebar({ name: 'setup', gid: 'g1' }).includes('class="gs-nav-link is-active" href="#/g/g1/settings"'), 'Guild setup hangs under Guild settings');
  const tabs = G.shell.tabItems({ ...ctxOf({ name: 'section', gid: 'g1', section: 'home' }, { 'guild.access': 'guild', 'roster.edit': 'guild' }) });
  assert(!plain(tabs).some((item) => item.key === 'users'), 'the phone tabs do not list Users: the drawer does');
});

check('shell: Links and keys (Sharing, guild.access, New) and Owner review (the Owner, only while a claim review is open)', () => {
  const links = G.shell.SETTINGS_TABS.find((tab) => tab.tab === 'links');
  assert.deepEqual([links.label, links.group, plain(links.needs), links.isNew], ['Links and keys', 'Sharing', ['guild.access'], true]);
  const names = (can, roles, owner) => plain(G.shell.settingsTabs(can, roles, owner).map((tab) => tab.tab));
  assert(names({ 'guild.access': 'guild' }).includes('links'));
  assert(!names({ 'guild.roles': 'guild', 'guild.teams': 'guild' }).includes('links'));
  const review = G.shell.SETTINGS_TABS.find((tab) => tab.tab === 'claimreview');
  assert.deepEqual([review.label, review.group, review.ownerReviewOnly], ['Owner review', 'Guild', true]);
  const everything = { 'guild.access': 'guild', 'guild.teams': 'guild', 'guild.roles': 'guild' };
  const owner = [{ role: 'guild_master' }];
  assert(!names(everything, owner).includes('claimreview'), 'no owner block: not listed');
  assert(!names(everything, owner, { name: 'A', you: true, reviewOpen: false }).includes('claimreview'), 'a dismissed review');
  assert(!names(everything, owner, { name: 'A', you: false }).includes('claimreview'), 'no reviewOpen for a non-Owner');
  assert(!names(everything, [], { reviewOpen: false }).includes('claimreview'));
  assert(names(everything, owner, { name: 'A', you: true, reviewOpen: true }).includes('claimreview'));
  assert.equal(names(everything, owner, { reviewOpen: true })[1], 'claimreview', 'it follows General in the Guild group');
  assert.deepEqual(plain(G.shell.settingsGroups(everything, owner, { reviewOpen: true })[0].items.map((item) => item.label)).slice(0, 2), ['General', 'Owner review']);
  // Accounts stays in the list for now; Guest links and Data access are gone (Links and keys replaced them).
  for (const tab of ['people']) assert(names(everything, owner).includes(tab), tab);
  for (const tab of ['guests', 'dataaccess']) assert(!names(everything, owner).includes(tab), tab);
  // The frame lists it for the Owner and carries the page's own heading.
  const gd = guildData(everything, { owner: { name: 'A', you: true, reviewOpen: true } });
  gd.me.roles = owner;
  const frame = G.shell.settingsFrameHtml({ guildData: gd }, 'claimreview', '<p>body</p>');
  assert(frame.includes('Owner review') && frame.includes('What the previous Owner set up and left live.') && frame.includes('href="#/g/g1/settings/claimreview"'));
  const linksFrame = G.shell.settingsFrameHtml({ guildData: gd }, 'links', '<p>body</p>');
  assert(linksFrame.includes('Links and keys') && linksFrame.includes('gs-nbadge'), 'Links and keys carries the New mark');
});

check('shell: the crumbs of Users, a user, Guild setup and #/fresh; the stubs draw a real head and an empty state', () => {
  const ctx = (route, extra) => ({ section: 'guild', page: 'app', signedOut: false, me: { user: { id: 'u1' } }, route, guildData: guildData({ 'guild.access': 'guild', 'guild.teams': 'guild' }), ...extra });
  const labels = (route, extra) => plain(G.shell.breadcrumbItems(ctx(route, extra)).map((crumb) => crumb.label));
  assert.deepEqual(labels({ name: 'users', gid: 'g1', segment: null }), ['Writers', 'Users']);
  assert.deepEqual(labels({ name: 'user', gid: 'g1', key: 'u_x' }, { leafName: 'Ashgrove' }), ['Writers', 'Users', 'Ashgrove']);
  assert.deepEqual(labels({ name: 'setup', gid: 'g1' }), ['Writers', 'Guild settings', 'Guild setup']);
  assert.equal(G.shell.breadcrumbItems(ctx({ name: 'setup', gid: 'g1' }))[1].href, '#/g/g1/settings/general', 'Guild settings links to its first page');
  assert.deepEqual(labels({ name: 'fresh', done: 'handover', error: null, purpose: null }), ['Writers', 'Confirm it is you']);
  assert.deepEqual(labels({ name: 'fresh', done: 'gm_claim', error: null, purpose: null }), ['Writers', 'Owner seat']);
  const gd = guildData({ 'guild.access': 'guild', 'guild.teams': 'guild' });
  const page = (html, title) => {
    assert(new RegExp(`<h1[^>]*>${title}</h1>`).test(html), `${title}: the real head`);
    assert(/gs-empty2/.test(html), `${title}: an empty state`);
    assert(!/\sstyle=|\son[a-z]+=/i.test(html));
  };
  page(G.pages.users.main({ name: 'users', gid: 'g1', segment: null }, gd), 'Users');
  const user = G.pages.user.main({ name: 'user', gid: 'g1', key: 'u_x' }, gd);
  page(user, 'User');
  assert(user.includes('href="#/g/g1/users"') && user.includes('gs-back-link'), 'the user page has its back link to Users');
  const setup = G.pages.setup.main({ name: 'setup', gid: 'g1' }, gd);
  assert(/<h1[^>]*>Guild setup<\/h1>/.test(setup) && !/\sstyle=|\son[a-z]+=/i.test(setup), 'Guild setup: the real head (lane B8a-setup fills the body: tests/guild/guild-b8a-setup-tests.js)');
  for (const step of ['In-game guild', 'Ranks', 'Preview', 'Switch over']) assert(setup.includes(step), step);
  assert(setup.includes('href="#/g/g1/settings/battlenet"'));
  const gdOwner = guildData({ 'guild.access': 'guild', 'guild.teams': 'guild' }, { owner: { you: true, reviewOpen: true } });
  gdOwner.me.roles = [{ role: 'guild_master' }];
  const reviewPage = G.pages.settingsClaimReview.main({ name: 'settings', gid: 'g1', tab: 'claimreview' }, gdOwner, { guildData: gdOwner });
  assert(/<h2[^>]*>Owner review<\/h2>/.test(reviewPage), 'the Owner review draws its head (its body is tested in guild-b8a-owner-tests.js)');
  for (const fn of [G.pages.users.load, G.pages.user.load, G.pages.setup.load, G.pages.settingsLinks.load, G.pages.settingsClaimReview.load]) assert.equal(typeof fn, 'function');
});

check('app: the routes are wired (titles, page keys) and the manifest lists the new scripts before app.js', () => {
  const app = read('js/guild/app.js');
  for (const key of ["users: 'users'", "user: 'user'", "setup: 'setup'"]) assert(app.includes(key), key);
  for (const needle of ["P.settingsLinks.main", "P.settingsClaimReview.main", "loadAttendance('settingsLinks'", "loadAttendance('settingsClaimReview'", 'P.fresh.main', 'G.pages.fresh.load(r)', "r.name === 'fresh'"]) assert(app.includes(needle), needle);
  const manifest = G.manifest || require('../../js/guild/manifest.js');
  const at = (file) => manifest.indexOf(`/js/guild/${file}`);
  for (const file of ['fresh.js', 'pages-users.js', 'pages-setup.js', 'pages-settings-links.js', 'pages-settings-claimreview.js', 'pages-fresh.js']) {
    assert(at(file) > 0 && at(file) < at('app.js'), file);
    assert.equal(manifest.filter((entry) => entry.endsWith(`/${file}`)).length, 1, `${file} once`);
  }
  assert(at('fresh.js') > at('api.js') && at('fresh.js') > at('ui.js') && at('fresh.js') < at('pages-signin.js'), 'fresh.js: after api.js and ui.js, before the pages');
  const css = read('guild.css');
  const order = ['Guild setup', 'Users', 'Links and keys', 'Owner'].map((name) => css.indexOf(`/* == B8a ${name} (lane `));
  assert(order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), 'the four marker blocks, in order');
  assert(css.indexOf('.gs-fresh-page') > 0 && css.indexOf('.gs-fresh-page') < order[0], 'the fresh styles sit above the four blocks');
  assert(css.trimEnd().endsWith('/* == end B8a Owner == */'));
  for (const [name, lane] of [['Users', 'users']]) {
    assert(css.includes(`/* == B8a ${name} (lane ${lane}) == */\n/* == end B8a ${name} == */\n`), `${name}: an empty marker block`);
  }
  assert(css.includes('/* == B8a Guild setup (lane setup) == */\n') && css.includes('/* == end B8a Guild setup == */\n'), 'Guild setup: its marker block (lane B8a-setup filled it)');
});

// ---------------------------------------------------------------------------
// 3. Guild.fresh: the step, start, the pending act

check('fresh: isRequired is 403 fresh_required and the ApiError keeps the purpose and the params', () => {
  const err = freshRequired('handover', { targetUserId: 'u_t' });
  assert(G.fresh.isRequired(err));
  assert.equal(err.purpose, 'handover');
  assert.deepEqual(plain(err.params), { targetUserId: 'u_t' });
  assert(!G.fresh.isRequired(apiError(403, { error: 'forbidden' })));
  assert(!G.fresh.isRequired(apiError(409, { error: 'fresh_required' })));
  assert(!G.fresh.isRequired(null) && !G.fresh.isRequired(new Error('x')));
  const plainErr = apiError(500, null);
  assert.equal(plainErr.purpose, null);
  assert.equal(plainErr.params, null);
});

check('fresh: the step offers Battle.net or Discord only where the act allows both and the account holds both', () => {
  const linked = { bnet: 'Brandon#1482', discord: 'brandon' };
  const both = G.fresh.stepHtml({ purpose: 'handover', linked, stepLabel: 'Hand over the Owner seat - step 2 of 2', primaryLabel: 'Sign in and hand over' });
  assert(both.includes('Confirm it is you') && both.includes('Hand over the Owner seat - step 2 of 2') && both.includes('Sign in and hand over'));
  assert(both.includes('gs-dialog-confirm') && both.includes('data-submit="fresh-step-form"') && both.includes('data-action="fresh-step-back"') && both.includes('data-action="dialog-cancel"'), 'a confirm dialog with Back and Cancel');
  assert(both.includes('value="bnet" checked') && both.includes('value="discord"') && both.includes('Battle.net (Brandon#1482)') && both.includes('Discord (brandon)'));
  assert((both.match(/type="radio"/g) || []).length === 2);
  assert.equal(both.indexOf('gs-btn-molten') >= 0, true, 'one primary');
  // Battle.net only, whatever is linked.
  for (const purpose of ['gm_claim', 'pin', 'source_switch']) {
    const html = G.fresh.stepHtml({ purpose, linked });
    assert(!html.includes('type="radio"'), `${purpose}: no radios`);
    assert(html.includes('Sign in with Battle.net') && html.includes('Brandon#1482') && !html.includes('brandon)'), purpose);
  }
  // Both allowed but only one linked: that one, no choice.
  const onlyDiscord = G.fresh.stepHtml({ purpose: 'guild_delete', linked: { bnet: null, discord: 'brandon' } });
  assert(!onlyDiscord.includes('type="radio"') && onlyDiscord.includes('Sign in with Discord') && onlyDiscord.includes('Discord account'));
  const onlyBnet = G.fresh.stepHtml({ purpose: 'identity_change', linked: { bnet: 'B#1', discord: null } });
  assert(!onlyBnet.includes('type="radio"') && onlyBnet.includes('Sign in with Battle.net'));
  // Nothing usable linked: said, and the primary is off.
  const none = G.fresh.stepHtml({ purpose: 'pin', linked: { bnet: null, discord: 'brandon' } });
  assert(none.includes('Connect Battle.net to your account first') && /<button[^>]*gs-btn-molten[^>]*disabled/.test(none));
  // A lane's own sentence replaces the lead.
  assert(G.fresh.stepHtml({ purpose: 'gm_claim', linked, text: 'Sign in with Battle.net. Raidsmith checks the rank.' }).includes('Raidsmith checks the rank.'));
  assert(G.fresh.stepHtml({ purpose: 'handover', linked: { bnet: '<b>x</b>', discord: 'd' } }).includes('&lt;b&gt;x&lt;/b&gt;'), 'names are escaped');
  assert(!/\sstyle=|\son[a-z]+=/i.test(both));
  assert.deepEqual(plain(G.fresh.linkedOf({ identities: { discord: { username: 'd' }, bnet: { battletag: 'B#1' } } })), { bnet: 'B#1', discord: 'd' });
  assert.equal(G.fresh.linkedOf(null), null, 'no identities in the answer: no filter, the Worker decides');
  assert.equal(G.fresh.linkedOf({ user: {} }), null);
  assert.deepEqual(plain(G.fresh.linkedOf({ identities: { discord: null, bnet: null } })), { bnet: null, discord: null });
});

check('fresh: start saves the pending act, posts to the guild or the account start route and goes to the provider', async () => {
  resetBrowser('#/g/g1/settings/data');
  const calls = scriptApi({
    'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE, provider: 'bnet', purpose: 'handover', validForSeconds: 600 }),
    'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE, provider: 'discord', purpose: 'identity_change', validForSeconds: 600 }),
  });
  G.fresh.now = () => 1000000;
  await G.fresh.start({ gid: 'g1', purpose: 'handover', params: { targetUserId: 'u_t' }, provider: 'bnet', act: { kind: 'handover', data: { name: 'Ashgrove' } } });
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'handover', params: { targetUserId: 'u_t' }, provider: 'bnet' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  assert.deepEqual(plain(G.fresh.pending()), {
    kind: 'handover', gid: 'g1', purpose: 'handover', params: { targetUserId: 'u_t' }, data: { name: 'Ashgrove' }, provider: 'bnet', returnTo: '#/g/g1/settings/data', at: 1000000,
  });
  // An account act goes under /api, never under a guild, and the kind defaults to the purpose.
  await G.fresh.start({ gid: 'g1', purpose: 'identity_change', params: { change: 'link_discord' }, returnTo: '#/linked' });
  assert.deepEqual(calls[1], { method: 'POST', path: '/api/fresh/start', body: { purpose: 'identity_change', params: { change: 'link_discord' } } }, 'no provider asked: none sent');
  assert.equal(G.fresh.pending().gid, null);
  assert.equal(G.fresh.pending().kind, 'identity_change');
  assert.equal(G.fresh.pending().returnTo, '#/linked');
  assert.equal(navigations.length, 2);
  assert.deepEqual(plain(G.fresh.takePending()).purpose, 'identity_change');
  assert.equal(G.fresh.pending(), null, 'taking clears');
});

check('fresh: start refuses what cannot work, clears the pending act when the start fails, and survives blocked storage', async () => {
  resetBrowser('#/x');
  const calls = scriptApi({
    'POST /api/guild/g1/fresh/start': () => { throw apiError(429, { error: 'rate_limited', message: 'Too many sign-in checks.', retryAfter: 120 }); },
    'POST /api/guild/g2/fresh/start': () => ({ authorizeUrl: 'javascript:alert(1)' }),
  });
  await assert.rejects(() => G.fresh.start({ gid: 'g1', purpose: 'nonsense' }), (e) => e.status === 400 && e.field === 'purpose');
  await assert.rejects(() => G.fresh.start({ purpose: 'handover', params: {} }), (e) => e.status === 400, 'a guild act with no guild');
  assert.equal(calls.length, 0, 'nothing was asked');
  await assert.rejects(() => G.fresh.start({ gid: 'g1', purpose: 'handover', params: { targetUserId: 'u_t' } }), (e) => e.code === 'rate_limited');
  assert.equal(G.fresh.pending(), null, 'a refused start leaves no pending act');
  await assert.rejects(() => G.fresh.start({ gid: 'g2', purpose: 'pin', params: {} }), (e) => e.status === 502);
  assert.deepEqual(navigations, [], 'only an http(s) address is followed');
  assert.equal(G.fresh.pending(), null);
  // sessionStorage that throws: the act still starts (the page then says "signed in" and the person repeats it).
  sandbox.window = { sessionStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }, location: { hash: '#/x', assign() {} } };
  scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  await G.fresh.start({ gid: 'g1', purpose: 'pin', params: {} });
  assert.deepEqual(navigations, [AUTHORIZE]);
  assert.equal(G.fresh.pending(), null);
  G.fresh.clearPending();
  // A saved record that is not an act is not one.
  resetBrowser('#/x');
  storage.setItem(G.fresh.PENDING_KEY, '{"kind":"x"}');
  assert.equal(G.fresh.pending(), null);
  storage.setItem(G.fresh.PENDING_KEY, 'not json');
  assert.equal(G.fresh.pending(), null);
});

check('fresh: in a dialog a 403 fresh_required becomes the second step (never a second dialog), Back returns, and the step starts the sign-in', async () => {
  resetBrowser('#/g/g1/settings/data');
  G.app.state.me = { user: { id: 'u1' }, ...BOTH };
  const { dlg, form } = fakeDialog('<form data-submit="x">STEP ONE</form>');
  scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  let done = 0;
  const run = G.fresh.runDialog(form, Promise.reject(freshRequired('guild_delete', null)), { gid: 'g1', act: { kind: 'guild_delete', data: { confirmName: 'Writers' } }, stepLabel: 'Delete guild - step 2 of 2', primaryLabel: 'Sign in and delete' }, () => { done++; });
  void run;
  await settle();
  assert(dlg.innerHTML.includes('Delete guild - step 2 of 2') && dlg.innerHTML.includes('Confirm it is you') && dlg.innerHTML.includes('type="radio"'), 'the dialog body is the step');
  assert.equal(done, 0, 'the act did not finish');
  // Back restores the first step.
  G.handlers.click['fresh-step-back']({ closest: () => dlg });
  assert.equal(dlg.innerHTML, '<form data-submit="x">STEP ONE</form>');
  // Open the step again and sign in with the picked provider.
  G.fresh.runDialog(form, Promise.reject(freshRequired('guild_delete', null)), { gid: 'g1', act: { kind: 'guild_delete', data: { confirmName: 'Writers' } }, stepLabel: 'Delete guild - step 2 of 2' }, () => {});
  await settle();
  const calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'discord'));
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'guild_delete', params: {}, provider: 'discord' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  const saved = plain(G.fresh.pending());
  assert.deepEqual([saved.kind, saved.gid, saved.purpose, saved.params, saved.data, saved.provider, saved.returnTo], ['guild_delete', 'g1', 'guild_delete', {}, { confirmName: 'Writers' }, 'discord', '#/g/g1/settings/data'], 'the address it came from is kept');
  // Another error is the dialog's own (ui.runDialog shows it in the form).
  const other = fakeDialog('<form>ONE</form>');
  field('dlg-error');
  const shown = [];
  other.form.querySelector = (sel) => (/dlg-err|dlg-error/.test(sel) ? null : null);
  G.fresh.runDialog(other.form, Promise.reject(apiError(409, { error: 'not_configured', message: 'No.' })), { gid: 'g1' }, () => {});
  await settle();
  assert.equal(other.dlg.innerHTML, '<form>ONE</form>', 'no step for another error');
  assert.equal(fields['dlg-error'].textContent, 'No.');
  void shown;
});

check('fresh: the step shows its refusals inline - rate_limited, identity_too_new, forbidden, bad_request - and keeps the person in the step', async () => {
  resetBrowser('#/x');
  G.app.state.me = { user: { id: 'u1' }, ...BOTH };
  const { dlg, form } = fakeDialog();
  G.fresh.toStep({ form, error: freshRequired('handover', { targetUserId: 'u_t' }), gid: 'g1', act: { kind: 'handover' }, stepLabel: 'Hand over - step 2 of 2' });
  const error = field('dlg-error');
  const submit = async (err, provider) => {
    scriptApi({ 'POST /api/guild/g1/fresh/start': () => { throw err; } });
    G.handlers.submit['fresh-step-form'](stepForm(dlg, provider));
    await settle();
    return error;
  };
  let shown = await submit(apiError(429, { error: 'rate_limited', message: 'Too many sign-in checks. Wait a few minutes and try again.', retryAfter: 120 }), 'bnet');
  assert(!shown.hidden && shown.textContent.includes('Too many sign-in checks') && shown.textContent.includes('2 minutes'), shown.textContent);
  shown = await submit(apiError(503, { error: 'rate_limited', message: 'Sign-in checks are paused for a moment. Try again shortly.' }), 'bnet');
  assert(shown.textContent.includes('paused for a moment'), shown.textContent);
  shown = await submit(apiError(403, { error: 'identity_too_new', message: 'x', provider: 'discord', eligibleAt: Date.UTC(2026, 10, 5, 12) }), 'discord');
  assert(shown.textContent.includes('Discord was linked to your account recently') && shown.textContent.includes('Nov 5, 2026') && shown.textContent.includes('Pick the other sign-in'), shown.textContent);
  shown = await submit(apiError(403, { error: 'forbidden', message: 'You do not have permission to do that.' }), 'bnet');
  assert.equal(shown.textContent, 'Only the Owner of the guild can confirm this.');
  shown = await submit(apiError(400, { error: 'bad_request', message: 'params must be exactly the act\'s.', field: 'params' }), 'bnet');
  assert.equal(shown.textContent, 'params must be exactly the act\'s.');
  shown = await submit(apiError(409, { error: 'identity_not_linked', message: 'x', provider: 'bnet' }), 'bnet');
  assert.equal(shown.textContent, 'Connect Battle.net to your account first, then repeat this.');
  assert(dlg.innerHTML.includes('Confirm it is you'), 'still in the step');
  assert.equal(G.fresh.pending(), null, 'a refused start leaves no pending act');
  // A sign-out is the app's.
  let signedOut = 0;
  G.app.requireSignin = () => { signedOut++; };
  await submit(apiError(401, { error: 'signed_out' }), 'bnet');
  assert.equal(signedOut, 1);
});

// ---------------------------------------------------------------------------
// 4. #/fresh

const WRITERS = { guild: { id: 'g1', name: 'Writers' }, teams: [], me: { can: {}, roles: [] }, owner: { name: 'Kaelen', you: true, reviewOpen: true } };
function fakeGuildApp(gd = WRITERS) {
  G.app.fetchGuild = (gid) => { G.app.state.guilds[gid] = gd; return Promise.resolve(gd); };
  G.app.state.me = { user: { id: 'u1' }, guilds: [{ id: 'g1', name: 'Writers' }], ...BOTH };
}
function savePending(overrides = {}) {
  storage.setItem(G.fresh.PENDING_KEY, JSON.stringify({ kind: 'handover', gid: 'g1', purpose: 'handover', params: { targetUserId: 'u_t' }, data: { target: 'u_t' }, provider: 'bnet', returnTo: '#/g/g1/users/u/u_t', at: Date.now(), ...overrides }));
}
const landing = async (hash) => {
  const route = G.router.parse(hash);
  sandbox.window.location.hash = hash;
  await G.pages.fresh.load(route);
  const view = G.pages.fresh.view();
  if (view && view.running) await view.running;
  await settle();
  return { route, view, html: G.pages.fresh.main(route, null, {}) };
};

check('#/fresh?done=<purpose>: a pending act of that purpose younger than 15 minutes is repeated at once and the page goes on to the address the act answers', async () => {
  resetBrowser();
  fakeGuildApp();
  const seen = [];
  G.fresh.registerAct('handover', (act) => { seen.push(plain(act)); return Promise.resolve('#/g/g1/users'); });
  savePending();
  const { html, view } = await landing('#/fresh?done=handover');
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].kind, seen[0].gid, seen[0].purpose, seen[0].data, seen[0].params], ['handover', 'g1', 'handover', { target: 'u_t' }, { targetUserId: 'u_t' }]);
  assert.deepEqual(goes, [['#/g/g1/users', true]], 'on to the answer, replacing this entry so Back never repeats the act');
  assert.equal(G.fresh.pending(), null, 'the pending act is cleared after use');
  assert(html.includes('You are signed in again.') && html.includes('Finishing what you started...') && /<h1[^>]*>Confirm it is you<\/h1>/.test(html), 'the page shows for the moment the act takes');
  assert.equal(G.app.state.lastGid, 'g1', 'the nav is the act\'s guild');
  assert.equal(view.rec.kind, 'handover');
});

check('#/fresh?done=<purpose>: an answer of null goes back to where the act started, a hash address is a route, anything else a page load', async () => {
  resetBrowser();
  fakeGuildApp();
  G.fresh.registerAct('pin', () => Promise.resolve(null));
  savePending({ kind: 'pin', purpose: 'pin', returnTo: '#/g/g1/setup' });
  await landing('#/fresh?done=pin');
  assert.deepEqual(goes, [['#/g/g1/setup', true]]);
  resetBrowser();
  fakeGuildApp();
  G.fresh.registerAct('bnet_link', () => Promise.resolve('/auth/bnet/login'));
  savePending({ kind: 'bnet_link', purpose: 'identity_change', gid: null, returnTo: '#/linked' });
  await landing('#/fresh?done=identity_change');
  assert.deepEqual(goes, []);
  assert.deepEqual(navigations, ['/auth/bnet/login']);
});

check('#/fresh?done=<purpose>: an act older than 15 minutes, one of another purpose, none, or one nobody registered is not repeated - a plain done card with the way back', async () => {
  const cases = {
    'old (16 minutes)': () => { G.fresh.now = () => 100 * 60000; savePending({ at: 84 * 60000 }); },
    'exactly 15 minutes': () => { G.fresh.now = () => 100 * 60000; savePending({ at: 85 * 60000 }); },
    'another purpose': () => savePending({ purpose: 'guild_delete', kind: 'handover' }),
    'none': () => {},
    'unregistered kind': () => savePending({ kind: 'nobody_registered_this' }),
  };
  for (const [label, setup] of Object.entries(cases)) {
    resetBrowser();
    fakeGuildApp();
    let ran = 0;
    G.fresh.registerAct('handover', () => { ran++; return Promise.resolve('#/x'); });
    setup();
    const { html } = await landing('#/fresh?done=handover');
    assert.equal(ran, 0, `${label}: not repeated`);
    assert.deepEqual(goes, [], label);
    assert(html.includes('You are signed in again.') && html.includes('Go back and') || html.includes('started too long ago'), `${label}: ${text(html)}`);
    assert(/<h1[^>]*>Confirm it is you<\/h1>/.test(html), label);
    if (label === 'none') assert(html.includes('Open Writers') || html.includes('Open Home'), 'the way back');
    if (label === 'old (16 minutes)' || label === 'exactly 15 minutes') assert(html.includes('too long ago') && html.includes('href="#/g/g1/users/u/u_t"'), `${label}: says it was too long ago and links back where it started`);
    if (label === 'unregistered kind') assert(html.includes('href="#/g/g1/users/u/u_t"') && html.includes('Back to Users'), 'the way back names the page');
  }
});

check('#/fresh?done=<purpose>: the repeated act failing shows the reason and the way back; a lost grant says the sign-in did not count', async () => {
  resetBrowser();
  fakeGuildApp();
  G.fresh.registerAct('handover', () => Promise.reject(apiError(409, { error: 'recipient_not_live', message: 'That person is not on the in-game roster yet.' })));
  savePending();
  const failed = await landing('#/fresh?done=handover');
  assert(failed.html.includes('That did not go through.') && failed.html.includes('That person is not on the in-game roster yet.') && failed.html.includes('Back to Users'), text(failed.html));
  assert.deepEqual(goes, []);
  resetBrowser();
  fakeGuildApp();
  G.fresh.registerAct('handover', () => Promise.reject(freshRequired('handover', { targetUserId: 'u_t' })));
  savePending();
  const lost = await landing('#/fresh?done=handover');
  assert(lost.html.includes('The sign-in did not count.'), text(lost.html));
  assert.equal(G.fresh.pending(), null);
});

check('#/fresh: a saved return address that is not an app route is never used as a link or followed', async () => {
  for (const returnTo of ['javascript:alert(1)', 'https://evil.example/', '#/fresh?done=pin', '']) {
    resetBrowser();
    fakeGuildApp();
    G.fresh.registerAct('pin', () => Promise.resolve(null));
    savePending({ kind: 'pin', purpose: 'pin', returnTo });
    const { html } = await landing('#/fresh?done=pin');
    assert(!html.includes('javascript:') && !html.includes('evil.example'), `${returnTo}: not linked`);
    assert.deepEqual(goes, [['#/', true]], `${returnTo}: the answer null goes Home, not there`);
    resetBrowser();
    fakeGuildApp();
    savePending({ kind: 'nobody', purpose: 'pin', returnTo });
    const plainCard = await landing('#/fresh?done=pin');
    assert(!plainCard.html.includes('javascript:') && !plainCard.html.includes('evil.example') && plainCard.html.includes('Open Writers'), `${returnTo}: the way back is the guild's Home`);
  }
});

check('#/fresh?done=gm_claim: the claim\'s own answer - Owner of the guild, review what the previous Owner set up while it is open, the way on is Home', async () => {
  resetBrowser();
  fakeGuildApp();
  const calls = scriptApi({ 'GET /api/guild/g1/claim-review': () => ({ claim: { previousOwner: { id: 'u_b', name: 'Brandon' } } }) });
  savePending({ kind: 'gm_claim', purpose: 'gm_claim', params: {}, data: null, returnTo: '#/g/g1' });
  const { html } = await landing('#/fresh?done=gm_claim');
  assert(/<h1[^>]*>Owner seat<\/h1>/.test(html) && html.includes('You are the Owner of Writers.') && html.includes('Brandon held the seat before you.') && html.includes('stays live'), text(html));
  assert(html.includes('Review what Brandon set up') && html.includes('href="#/g/g1/settings/claimreview"') && html.includes('Open Writers') && html.includes('href="#/g/g1"'));
  assert.equal(calls.length, 1);
  assert.equal(G.fresh.pending(), null);
  assert.deepEqual(goes, [], 'the claim card stays: there is nothing to repeat');
  // Review dismissed: no review link and no claim-review read.
  resetBrowser();
  fakeGuildApp({ ...WRITERS, owner: { name: 'Kaelen', you: true, reviewOpen: false } });
  const calls2 = scriptApi({});
  savePending({ kind: 'gm_claim', purpose: 'gm_claim', params: {}, data: null });
  const closed = await landing('#/fresh?done=gm_claim');
  assert(closed.html.includes('You are the Owner of Writers.') && !closed.html.includes('Review what') && closed.html.includes('Open Writers'));
  assert.equal(calls2.length, 0);
  // No pending act: still the claim's answer, the way on is Home.
  resetBrowser();
  fakeGuildApp();
  const bare = await landing('#/fresh?done=gm_claim');
  assert(bare.html.includes('You are the Owner.') && bare.html.includes('Open Home') && bare.html.includes('href="#/"'), text(bare.html));
  // A hostile guild name is escaped.
  resetBrowser();
  fakeGuildApp({ ...WRITERS, guild: { id: 'g1', name: '<img src=x onerror=1>' } });
  savePending({ kind: 'gm_claim', purpose: 'gm_claim', params: {}, data: null });
  const hostile = await landing('#/fresh?done=gm_claim');
  assert(!hostile.html.includes('<img') && hostile.html.includes('&lt;img'));
});

check('#/fresh?error=<reason>: every reason has its sentence and its way on, and an unknown one the default', async () => {
  const expect = {
    not_gm: { purpose: 'gm_claim', title: 'Owner seat', banner: 'This Battle.net account is not the Guild Master of Writers.', text: 'Only the character at rank 0 of the guild roster can take the Owner seat.', way: 'Open Writers' },
    conflict: { purpose: 'gm_claim', title: 'Owner seat', banner: 'The guild changed while you were signing in.', text: 'Nothing was changed. Open Writers and try again.', way: 'Open Writers' },
    mismatch: { purpose: 'pin', title: 'Confirm it is you', banner: 'That is not the Battle.net account linked here.', text: 'Sign in with the Battle.net account linked to your Raidsmith account.', way: 'Try again' },
    identity_new: { purpose: 'pin', title: 'Confirm it is you', banner: 'This Battle.net account was linked recently.', text: 'It can confirm hand-overs, deleting a guild and the switch once it has been linked for 7 days.', way: 'Back to Guild setup' },
    provider: { purpose: 'pin', title: 'Confirm it is you', banner: 'The sign-in did not finish.', text: 'Battle.net did not answer, or there were too many sign-ins at once. Try again in a minute.', way: 'Try again' },
    busy: { purpose: 'pin', title: 'Confirm it is you', banner: 'The sign-in did not finish.', text: 'Battle.net did not answer, or there were too many sign-ins at once. Try again in a minute.', way: 'Try again' },
    state: { purpose: 'pin', title: 'Confirm it is you', banner: 'The sign-in was cancelled.', text: 'The link expired, was used already, or you did not allow Raidsmith to read your Battle.net account. Start again.', way: 'Try again' },
    denied: { purpose: 'pin', title: 'Confirm it is you', banner: 'The sign-in was cancelled.', text: 'The link expired, was used already, or you did not allow Raidsmith to read your Battle.net account. Start again.', way: 'Try again' },
    not_configured: { purpose: 'pin', title: 'Confirm it is you', banner: 'Sign-in is not set up on this server.', text: 'Battle.net sign-in is not available here.', way: 'Back to Guild setup' },
    a_reason_nobody_knows: { purpose: 'pin', title: 'Confirm it is you', banner: 'The sign-in did not work.', text: 'Raidsmith could not confirm it is you. Go back and try again.', way: 'Back to Guild setup' },
  };
  for (const [reason, want] of Object.entries(expect)) {
    resetBrowser();
    fakeGuildApp();
    savePending({ kind: want.purpose, purpose: want.purpose, provider: 'bnet', returnTo: '#/g/g1/setup' });
    const { html } = await landing(`#/fresh?error=${reason}&purpose=${want.purpose}`);
    assert(new RegExp(`<h1[^>]*>${want.title}</h1>`).test(html), `${reason}: title`);
    assert(text(html).includes(want.banner), `${reason}: banner (${text(html)})`);
    assert(text(html).includes(want.text), `${reason}: text (${text(html)})`);
    assert(text(html).includes(want.way), `${reason}: way on (${text(html)})`);
    assert(html.includes('role="alert"') && !/\sstyle=|\son[a-z]+=/i.test(html), `${reason}: a warning banner, nothing inline`);
    assert.deepEqual(goes, [], `${reason}: nothing repeated`);
  }
  // Without a pending act there is nothing to try again: the way on is Home. A Discord act names Discord.
  resetBrowser();
  fakeGuildApp();
  const bare = await landing('#/fresh?error=mismatch&purpose=pin');
  assert(bare.html.includes('Open Home') && !bare.html.includes('fresh-retry'));
  resetBrowser();
  fakeGuildApp();
  savePending({ provider: 'discord' });
  const discord = await landing('#/fresh?error=mismatch&purpose=handover');
  assert(text(discord.html).includes('That is not the Discord account linked here.'));
  // The bare address says so and offers the way on; a done-less, error-less visit never repeats anything.
  resetBrowser();
  fakeGuildApp();
  const nothing = await landing('#/fresh');
  assert(nothing.html.includes('Nothing to confirm.') && goes.length === 0);
});

check('#/fresh?error=...: Try again starts the same sign-in from the pending act, and a refusal shows under the card', async () => {
  resetBrowser();
  fakeGuildApp();
  savePending({ kind: 'pin', purpose: 'pin', params: { slug: 'writers' }, data: { n: 1 }, provider: 'bnet', returnTo: '#/g/g1/setup' });
  await landing('#/fresh?error=state&purpose=pin');
  field('fresh-error');
  let calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  const button = { disabled: false };
  G.handlers.click['fresh-retry'](button);
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'pin', params: { slug: 'writers' }, provider: 'bnet' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  assert.equal(G.fresh.pending().data.n, 1);
  calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => { throw apiError(403, { error: 'identity_too_new', message: 'x', provider: 'bnet' }); } });
  const again = { disabled: false };
  G.handlers.click['fresh-retry'](again);
  await settle();
  assert.equal(again.disabled, false);
  assert(fields['fresh-error'].textContent.includes('Battle.net was linked to your account recently'), fields['fresh-error'].textContent);
});

// ---------------------------------------------------------------------------
// 5. The call sites

check('identity: Disconnect Discord starts the step on fresh_required (identity_change, unlink_discord), and the repeat disconnects and lands on Linked accounts with its notice', async () => {
  resetBrowser('#/linked');
  G.app.state.me = { user: { id: 'u1' }, ...BOTH };
  const { dlg, form } = fakeDialog('<form>ONE</form>');
  scriptApi({ 'DELETE /auth/discord': () => { throw freshRequired('identity_change', { change: 'unlink_discord' }); } });
  G.handlers.submit['discord-disconnect-form'](form);
  await settle();
  assert(dlg.innerHTML.includes('Disconnect Discord - step 2 of 2') && dlg.innerHTML.includes('Sign in and disconnect') && dlg.innerHTML.includes('type="radio"'));
  const calls = scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'bnet'));
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/fresh/start', body: { purpose: 'identity_change', params: { change: 'unlink_discord' }, provider: 'bnet' } });
  assert.equal(G.fresh.pending().kind, 'discord_unlink');
  assert.equal(G.fresh.pending().returnTo, '#/linked');
  // Back from the provider: the act repeats.
  fakeGuildApp();
  const repeatCalls = scriptApi({ 'DELETE /auth/discord': () => ({}), 'GET /auth/bnet': () => ({ configured: true, link: null, guilds: [] }) });
  const { html } = await landing('#/fresh?done=identity_change');
  assert.deepEqual(repeatCalls[0], { method: 'DELETE', path: '/auth/discord', body: {} });
  assert.deepEqual(goes, [['#/linked', true]]);
  assert(html.includes('You are signed in again.'));
  await G.pages.bnet.load();
  assert.equal(G.app.state.bnet.notice, 'Discord disconnected. You sign in with Battle.net now.');
  await G.pages.bnet.load();
  assert.equal(G.app.state.bnet.notice, '', 'the notice shows once');
});

check('identity: Disconnect Battle.net starts the step on fresh_required (identity_change, unlink_bnet) and repeats the disconnect', async () => {
  resetBrowser('#/linked');
  G.app.state.me = { user: { id: 'u1' }, ...BOTH };
  const { dlg, form } = fakeDialog('<form>ONE</form>');
  scriptApi({ 'DELETE /auth/bnet': () => { throw freshRequired('identity_change', { change: 'unlink_bnet' }); } });
  G.handlers.submit['bnet-disconnect-form'](form);
  await settle();
  assert(dlg.innerHTML.includes('Disconnect Battle.net - step 2 of 2'));
  const calls = scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'discord'));
  await settle();
  assert.deepEqual(calls[0].body, { purpose: 'identity_change', params: { change: 'unlink_bnet' }, provider: 'discord' });
  assert.equal(G.fresh.pending().kind, 'bnet_unlink');
  fakeGuildApp();
  const repeat = scriptApi({ 'DELETE /auth/bnet': () => ({}), 'GET /auth/bnet': () => ({ configured: true, link: null, guilds: [] }) });
  await landing('#/fresh?done=identity_change');
  assert.equal(repeat[0].path, '/auth/bnet');
  assert.deepEqual(goes, [['#/linked', true]]);
  await G.pages.bnet.load();
  assert(G.app.state.bnet.notice.startsWith('Battle.net disconnected.'));
});

check('identity: #/linked?error=fresh_required offers the sign-in the account has, starts identity_change for the link it lacks and the repeat is the connect', async () => {
  resetBrowser('#/linked?error=fresh_required');
  const onlyDiscord = { user: { id: 'u1', displayName: 'A' }, identities: { discord: { username: 'brandon' }, bnet: null } };
  const html = G.pages.bnet.linkedHtml({ error: 'fresh_required', me: onlyDiscord, data: { configured: true, link: null, guilds: [] } });
  assert(html.includes('Confirm it is you first.') && html.includes('Sign in with Discord') && !html.includes('Sign in with Battle.net'), text(html));
  assert(html.includes('data-action="identity-fresh-start"') && html.includes('data-change="link_bnet"') && html.includes('data-provider="discord"'));
  const onlyBnet = G.pages.bnet.linkedHtml({ error: 'fresh_required', me: { user: { id: 'u1' }, identities: { discord: null, bnet: { battletag: 'B#1' } } }, data: null });
  assert(onlyBnet.includes('Sign in with Battle.net') && onlyBnet.includes('data-change="link_discord"') && onlyBnet.includes('data-provider="bnet"'));
  const neither = G.pages.bnet.linkedHtml({ error: 'fresh_required', me: { user: { id: 'u1' }, ...BOTH }, data: null });
  assert(neither.includes('Confirm it is you first: sign in again, then connect.') && !neither.includes('identity-fresh-start'));
  const calls = scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  const attrs = { 'data-change': 'link_bnet', 'data-provider': 'discord' };
  G.handlers.click['identity-fresh-start']({ disabled: false, getAttribute: (name) => attrs[name] });
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/fresh/start', body: { purpose: 'identity_change', params: { change: 'link_bnet' }, provider: 'discord' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  assert.equal(G.fresh.pending().kind, 'bnet_link');
  assert.equal(G.fresh.pending().returnTo, '#/linked');
  // The repeat is the connect itself (a page load of the provider's login), for Battle.net and for Discord.
  fakeGuildApp();
  await landing('#/fresh?done=identity_change');
  assert.deepEqual(navigations.slice(-1), ['/auth/bnet/login']);
  resetBrowser();
  fakeGuildApp();
  storage.setItem(G.fresh.PENDING_KEY, JSON.stringify({ kind: 'discord_link', gid: null, purpose: 'identity_change', params: { change: 'link_discord' }, data: null, provider: 'bnet', returnTo: '#/linked', at: Date.now() }));
  await landing('#/fresh?done=identity_change');
  assert.deepEqual(navigations, ['/auth/login?mode=link']);
  // A refused sign-in start is said next to the banner.
  resetBrowser();
  field('fresh-start-error');
  scriptApi({ 'POST /api/fresh/start': () => { throw apiError(403, { error: 'identity_too_new', message: 'x', provider: 'bnet', eligibleAt: Date.UTC(2026, 10, 5, 12) }); } });
  const el = { disabled: false, getAttribute: (name) => ({ 'data-change': 'link_discord', 'data-provider': 'bnet' })[name] };
  G.handlers.click['identity-fresh-start'](el);
  await settle();
  assert(fields['fresh-start-error'].textContent.includes('Battle.net was linked to your account recently'));
  assert.equal(el.disabled, false);
});

check('guild delete: Settings > Guild data starts the step on fresh_required (guild_delete, the typed name kept) and the repeat deletes, forgets the guild and goes to the start page', async () => {
  resetBrowser('#/g/g1/settings/data');
  G.app.state.me = { user: { id: 'u1' }, guilds: [{ id: 'g1', name: 'Writers' }], ...BOTH };
  G.app.state.currentGid = 'g1';
  G.app.state.guilds = { g1: WRITERS };
  const { dlg, form } = fakeDialog('<form>ONE</form>');
  form.elements = { confirmName: { value: 'Writers' } };
  field('dlg-error');
  field('dlg-err-confirmName');
  scriptApi({ 'DELETE /api/guild/g1': () => { throw freshRequired('guild_delete', null); } });
  G.handlers.submit['guild-delete-form'](form);
  await settle();
  assert(dlg.innerHTML.includes('Delete guild - step 2 of 2') && dlg.innerHTML.includes('Sign in and delete') && dlg.innerHTML.includes('type="radio"'));
  const calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'bnet'));
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'guild_delete', params: {}, provider: 'bnet' } });
  const saved = G.fresh.pending();
  assert.deepEqual([saved.kind, saved.gid, saved.data, saved.returnTo], ['guild_delete', 'g1', { confirmName: 'Writers' }, '#/g/g1/settings/data']);
  // Back from the provider.
  fakeGuildApp();
  G.app.loadMe = () => Promise.resolve(null);
  const repeat = scriptApi({ 'DELETE /api/guild/g1': () => ({}) });
  await landing('#/fresh?done=guild_delete');
  assert.deepEqual(repeat[0], { method: 'DELETE', path: '/api/guild/g1', body: { confirmName: 'Writers' } });
  assert.equal(G.app.state.guilds.g1, undefined, 'the guild is forgotten');
  assert.deepEqual(goes, [['#/', true]]);
});

check('claim_closed: the legacy claim shows the Worker\'s sentence in its box with the claim an in-game Guild Master makes with Battle.net, which starts gm_claim', async () => {
  resetBrowser('#/new');
  const sentence = 'This guild takes its Guild Master from the in-game guild roster, so a Discord server administrator cannot claim it. The in-game Guild Master claims it with Battle.net.';
  const buttons = [{ disabled: false }];
  const box = { innerHTML: '', querySelectorAll: () => buttons, querySelector: () => null };
  const attrs = { 'data-gid': 'g1', 'data-name': 'Writers' };
  const el = { disabled: false, getAttribute: (name) => attrs[name], closest: () => box };
  scriptApi({ 'POST /api/guild/g1/claim': () => { throw apiError(403, { error: 'claim_closed', message: sentence }); } });
  G.handlers.click['claim-go'](el);
  await settle();
  assert(box.innerHTML.includes(sentence) && box.innerHTML.includes('Claim with Battle.net') && box.innerHTML.includes('data-action="claim-gm-start"') && box.innerHTML.includes('data-gid="g1"'));
  assert(box.innerHTML.includes('data-action="claim-cancel"'));
  assert.equal(buttons[0].disabled, false);
  // The message is escaped.
  G.pages.create.showClaimClosed(box, 'g1', '<img src=x>');
  assert(!box.innerHTML.includes('<img') && box.innerHTML.includes('&lt;img'));
  // The button starts the claim: guild route, purpose gm_claim, Battle.net only (no provider picked).
  const calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.click['claim-gm-start']({ disabled: false, getAttribute: (name) => attrs[name] });
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'gm_claim', params: {} } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  assert.deepEqual([G.fresh.pending().kind, G.fresh.pending().returnTo], ['gm_claim', '#/new']);
  // Any other refusal keeps the old path (the page alert).
  const alerts = [];
  G.app.handleError = (err, opts) => alerts.push([err.code, opts]);
  scriptApi({ 'POST /api/guild/g1/claim': () => { throw apiError(409, { error: 'conflict', message: 'x' }); } });
  G.handlers.click['claim-go'](el);
  await settle();
  assert.deepEqual(plain(alerts), [['conflict', { pageAlert: true }]]);
});

// ---------------------------------------------------------------------------
// 5b. The routes through app.js: the guild scripts against a fake page skeleton, location, history and fetch (the way tests/guild/guild-shell-tests.js drives the shell)

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) { const on = force === undefined ? !this.set.has(n) : !!force; if (on) this.set.add(n); else this.set.delete(n); return on; }
}
class FakeEl {
  constructor(id, attrs) { this.id = id || ''; this.attrs = Object.assign({}, attrs || {}); this.classList = new FakeClassList(); this.hidden = false; this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  closest() { return null; }
}
const SKELETON = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner', 'gs-main', 'planner-root', 'planner-banner', 'planner-notice', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];

function makeEnv({ url, routes = {}, session = {} }) {
  const els = {};
  SKELETON.forEach((id) => { els[id] = new FakeEl(id); });
  els['gs-main'].hidden = true;
  els['planner-root']._html = '<main>PLANNER</main>';
  const body = new FakeEl('', { 'data-page': 'app' });
  const loc = { pathname: '/', search: '', _hash: '' };
  const setUrl = (u) => { const hi = u.indexOf('#'); loc._hash = hi < 0 ? '' : u.slice(hi); };
  setUrl(url);
  const listeners = { window: {}, document: {} };
  const on = (which) => (name, fn) => { (listeners[which][name] = listeners[which][name] || []).push(fn); };
  Object.defineProperty(loc, 'hash', { get: () => loc._hash, set: (v) => { loc._hash = v.charAt(0) === '#' ? v : `#${v}`; (listeners.window.hashchange || []).forEach((fn) => fn({})); } });
  Object.defineProperty(loc, 'href', { get: () => `http://localhost${loc.pathname}${loc.search}${loc._hash}` });
  const history = { calls: [], pushState: (st, t, u) => { history.calls.push(['push', u]); setUrl(u); }, replaceState: (st, t, u) => { history.calls.push(['replace', u]); setUrl(u); } };
  const fetchCalls = [];
  const fetchFn = (u, init) => {
    const method = (init && init.method) || 'GET';
    fetchCalls.push({ url: u, method, body: init && init.body });
    const handler = routes[`${method} ${u}`] || routes[u];
    if (!handler) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
    const r = typeof handler === 'function' ? handler(init) : handler;
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(r.body == null ? {} : r.body)) });
  };
  const documentFake = { body, activeElement: null, title: 'Raidsmith', getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: on('document') };
  const box = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, URL };
  box.window = box;
  box.document = documentFake;
  box.location = loc;
  box.history = history;
  const mem = (initial) => { const m = { ...initial }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };
  box.localStorage = mem({ 'raidsmith.shell.signedIn': '1' });
  box.sessionStorage = mem(session);
  box.fetch = fetchFn;
  box.addEventListener = on('window');
  box.setTimeout = () => 1;
  box.clearTimeout = () => {};
  box.scrollTo = () => {};
  box.whatsNewSeen = () => true;
  vm.createContext(box);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), box, { filename: src });
  return { G: box.Guild, els, loc, history, fetchCalls, session: box.sessionStorage, html: (id) => els[id].innerHTML };
}

const ME = { user: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null, initials: 'AL', prefs: { sidebarCollapsed: false, lastGuildId: null } }, guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false }, removedFrom: [], deleteImpact: { handOverFirst: [] }, ...BOTH };
const MEMBER = { 'roster.view': 'guild' };
const OFFICER = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.edit': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild' };
const guildBody = (can, owner) => ({ guild: { id: 'g1', name: 'Ravens', realm: 'Mistvale', realmKind: 'realm', gameVersion: 'tbc', region: 'EU' }, teams: [{ id: 't1', name: 'Main', size: 25, archived: false, lead: null }], me: { roles: [{ role: owner ? 'guild_master' : 'member' }], can }, ...(owner ? { owner } : {}) });
const appRoutes = (can, owner, extra) => ({
  '/auth/me': { status: 200, body: ME }, '/api/guild/g1': { status: 200, body: guildBody(can, owner) }, '/auth/bnet': { status: 200, body: { configured: true, link: null, guilds: [] } }, ...(extra || {}),
});
const mainOf = async (env) => { await settle(); return env.html('gs-main'); };

check('app: Users opens for guild.access (head and empty state, no data call yet), the user page has its back link, Guild setup is its own page; members are told they cannot open them', async () => {
  const env = makeEnv({ url: '/#/g/g1/users', routes: appRoutes(OFFICER, undefined, { '/api/guild/g1/bnet': { status: 200, body: { configured: true, supported: true, realmKind: 'realm', realmSlug: 'dreamscythe', effectiveGuildName: 'Writers', rankDefaults: [], pin: { pinned: false, complete: false, rankSource: null }, pinOpen: false, roster: { members: 0, fetchedAt: null } } } }) });
  const users = await mainOf(env);
  assert(/<h1[^>]*>Users<\/h1>/.test(users) && users.includes('gs-empty2'), text(users));
  assert(env.html('shell-sidebar').includes('class="gs-nav-link is-active" href="#/g/g1/users"'), 'Users is the current nav item');
  assert(env.html('shell-topbar-lead').includes('>Users<'), 'the crumb');
  assert(!env.fetchCalls.some((call) => /\/users/.test(call.url)), 'the stub reads nothing');
  env.loc.hash = '#/g/g1/users/u/u_abcdefghijklmnopqrstuv';
  const user = await mainOf(env);
  assert(/<h1[^>]*>User<\/h1>/.test(user) && user.includes('href="#/g/g1/users"'));
  env.loc.hash = '#/g/g1/setup';
  const setup = await mainOf(env);
  assert(/<h1[^>]*>Guild setup<\/h1>/.test(setup) && setup.includes('In-game guild') && setup.includes('Switch over'));
  assert(env.html('shell-topbar-lead').includes('Guild settings') && env.html('shell-topbar-lead').includes('Guild setup'));
  assert(env.html('shell-sidebar').includes('class="gs-nav-link is-active" href="#/g/g1/settings"'), 'Guild setup keeps Guild settings current');
  const member = makeEnv({ url: '/#/g/g1/users', routes: appRoutes(MEMBER) });
  const refused = await mainOf(member);
  assert(refused.includes('You cannot open this') && !refused.includes('gs-empty2'), text(refused));
  assert(!member.html('shell-sidebar').includes('>Users<'), 'no Users item for a member');
  member.loc.hash = '#/g/g1/setup';
  assert((await mainOf(member)).includes('You cannot open this'));
});

check('app: the settings tabs links and claimreview open through app.js; Owner review only for the Owner while owner.reviewOpen, and the list shows it', async () => {
  const env = makeEnv({ url: '/#/g/g1/settings/links', routes: appRoutes(OFFICER, null, {
    '/api/guild/g1/api-keys': { status: 200, body: { keys: [], datasets: [], expiries: [], limits: {} } }, '/api/guild/g1/guest-links': { status: 200, body: { links: [], roles: [], expiries: [] } },
    '/api/guild/g1/join-links': { status: 200, body: { links: [], limits: {} } },
  }) });
  const links = await mainOf(env);
  assert(/<h2[^>]*>Links and keys<\/h2>/.test(links) && links.includes('gs-sitem is-active'), text(links));
  env.loc.hash = '#/g/g1/settings/claimreview';
  assert((await mainOf(env)).includes('You cannot open this'), 'an officer has no Owner review');
  const owner = makeEnv({ url: '/#/g/g1/settings/claimreview', routes: appRoutes(OFFICER, { name: 'Alice', you: true, suspended: false, reviewOpen: true }) });
  const review = await mainOf(owner);
  assert(/<h2[^>]*>Owner review<\/h2>/.test(review) && review.includes('gs-sitem is-active') && review.includes('Links and keys'), text(review));
  assert(owner.html('shell-topbar-lead').includes('Owner review'));
  const dismissed = makeEnv({ url: '/#/g/g1/settings/claimreview', routes: appRoutes(OFFICER, { name: 'Alice', you: true, suspended: false, reviewOpen: false }) });
  assert((await mainOf(dismissed)).includes('You cannot open this'), 'the page closes with the review');
  assert(!/Owner review/.test(dismissed.html('gs-main')));
});

check('app: #/fresh?done=<purpose> repeats the saved act through the app and replaces its own address; an error landing shows its card with the crumbs', async () => {
  const pending = { kind: 'handover', gid: 'g1', purpose: 'handover', params: { targetUserId: 'u_t' }, data: { target: 'u_t' }, provider: 'bnet', returnTo: '#/g/g1/users', at: Date.now() };
  const env = makeEnv({ url: '/#/fresh?done=handover', routes: appRoutes(OFFICER), session: { 'raidsmith.fresh.pending': JSON.stringify(pending) } });
  const seen = [];
  env.G.fresh.registerAct('handover', (act) => { seen.push(act.data); return Promise.resolve('#/g/g1/users'); });
  // The app routed before the act was registered (the real pages register at load): route again with the saved act in place.
  env.session.setItem('raidsmith.fresh.pending', JSON.stringify(pending));
  await env.G.app.routeAll({ force: true });
  await settle();
  assert.deepEqual(plain(seen), [{ target: 'u_t' }]);
  assert(env.history.calls.some(([kind, url]) => kind === 'replace' && url.endsWith('#/g/g1/users')), JSON.stringify(env.history.calls));
  assert(/<h1[^>]*>Users<\/h1>/.test(env.html('gs-main')), 'on the page the act answered');
  assert.equal(env.session.getItem('raidsmith.fresh.pending'), null);
  const error = makeEnv({ url: '/#/fresh?error=mismatch&purpose=pin', routes: appRoutes(OFFICER), session: { 'raidsmith.fresh.pending': JSON.stringify({ ...pending, kind: 'pin', purpose: 'pin', returnTo: '#/g/g1/setup' }) } });
  const card = await mainOf(error);
  assert(/<h1[^>]*>Confirm it is you<\/h1>/.test(card) && text(card).includes('That is not the Battle.net account linked here.') && card.includes('data-action="fresh-retry"'), text(card));
  assert(error.html('shell-topbar-lead').includes('Ravens') && error.html('shell-topbar-lead').includes('Confirm it is you'), 'the crumbs name the act\'s guild');
  assert(error.html('shell-sidebar').includes('Ravens'), 'the nav is the act\'s guild');
  const bare = makeEnv({ url: '/#/fresh?error=state', routes: appRoutes(OFFICER) });
  assert(text(await mainOf(bare)).includes('The sign-in was cancelled.'));
});

check('app: #/linked?error=fresh_required shows the sign-in banner for the account\'s own identity', async () => {
  const onlyDiscord = { ...ME, identities: { discord: { username: 'alice' }, bnet: null } };
  const env = makeEnv({ url: '/#/linked?error=fresh_required', routes: appRoutes(OFFICER, null, { '/auth/me': { status: 200, body: onlyDiscord } }) });
  const page = await mainOf(env);
  assert(page.includes('Confirm it is you first.') && page.includes('Sign in with Discord') && page.includes('data-change="link_bnet"'), text(page));
  assert(!page.includes('Battle.net could not finish connecting'));
});

check('the page lanes\' hand-over is untouched: pages-settings-people.js does not call the fresh helper yet', () => {
  assert(!read('js/guild/pages-settings-people.js').includes('G.fresh'), 'the Users lane moves the hand-over');
});

// ---------------------------------------------------------------------------
// 6. Worker: GET /api/guild/:gid owner

const display = async (s, key) => (await s.w.call(s.jars[key], 'GET', '/auth/me')).json.user.displayName;

check('worker: owner for each viewer on a live in-game guild - the Owner, a plain member, an officer with guild.access', async () => {
  const s = await claimWorld();
  const ownerName = await display(s, 'gm');
  const owner = (await s.ok('gm', 'GET', '')).owner;
  assert.deepEqual(plain(owner), { name: ownerName, you: true, suspended: false, reviewOpen: false });
  // A plain member: the name and who they are, nothing about suspension or a review.
  const member = (await s.ok('mem', 'GET', '')).owner;
  assert.deepEqual(plain(member), { name: ownerName, you: false });
  assert(!('suspended' in member) && !('reviewOpen' in member));
  // The same member as an officer: guild.access shows suspension (not the review).
  await s.ok('gm', 'PUT', `/people/${s.uids.mem}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  const officer = (await s.ok('mem', 'GET', '')).owner;
  assert.deepEqual(plain(officer), { name: ownerName, you: false, suspended: false });
  assert(!('reviewOpen' in officer));
  // The old payload is as it was.
  const payload = await s.ok('gm', 'GET', '');
  assert(payload.guild && payload.me && payload.teams && payload.rosterOptions, 'the rest of the payload is untouched');
});

check('worker: a suspended Owner is told so (and an officer with guild.access), a plain member is not; the seat still names the holder', async () => {
  const s = await claimWorld();
  const ownerName = await display(s, 'gm');
  await s.ok('gm', 'PUT', `/people/${s.uids.mem}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  s.suspendOwner();
  const seatHolder = (await s.ok('gm', 'GET', '')).owner;
  assert.deepEqual(plain(seatHolder), { name: ownerName, you: true, suspended: true }, 'suspended: still the holder, and no review (not the live Owner)');
  const officer = (await s.ok('mem', 'GET', '')).owner;
  assert.deepEqual(plain(officer), { name: ownerName, you: false, suspended: true }, 'an officer holds guild.access: told');
  // Without guild.access the same payload leaves it out.
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND user_id = '${s.uids.mem}' AND role_id = 'officer'`);
  const member = (await s.ok('mem', 'GET', '')).owner;
  assert.deepEqual(plain(member), { name: ownerName, you: false }, 'a plain member is not told');
});

check('worker: after a claim the new Owner sees reviewOpen until the Home item is dismissed and again when it is restored; nobody else sees it', async () => {
  const s = await claimWorld();
  const outcome = await claim(s, 'igm');
  assert(outcome.location && outcome.location.includes('done=gm_claim'), outcome.location);
  const name = await display(s, 'igm');
  const owner = (await s.ok('igm', 'GET', '')).owner;
  assert.deepEqual(plain(owner), { name, you: true, suspended: false, reviewOpen: true });
  const previous = (await s.ok('gm', 'GET', '')).owner;
  assert.equal(previous.name, name);
  assert.equal(previous.you, false);
  assert(!('reviewOpen' in previous), 'the previous Owner has no review');
  const member = (await s.ok('mem', 'GET', '')).owner;
  assert(!('reviewOpen' in member) && !('suspended' in member));
  // The same flag the attention list uses: dismissing the claim_review item closes it, restoring opens it again.
  const attention = await s.ok('igm', 'GET', '/attention');
  assert(attention.items.some((item) => item.kind === 'claim_review'), 'the Home item is there');
  await s.ok('igm', 'POST', '/attention/dismissals', { itemId: 'claim_review' }, 200);
  assert.equal((await s.ok('igm', 'GET', '')).owner.reviewOpen, false, 'dismissed');
  assert(!(await s.ok('igm', 'GET', '/attention')).items.some((item) => item.kind === 'claim_review'), 'and gone from Home');
  await s.ok('igm', 'DELETE', '/attention/dismissals/claim_review', {}, 200);
  assert.equal((await s.ok('igm', 'GET', '')).owner.reviewOpen, true, 'restored');
  assert(attention.items.length > 0);
});

check('worker: a guild before the flip names its stored Guild Master, a seat set on an account names its holder; neither shows a review to anyone else', async () => {
  const s = await freshScenario();
  globalThis.__claimWorlds.push(s);
  await s.member('mem', 'Plainmember');
  await s.officer('off', 'Offone');
  const gmName = await display(s, 'gm');
  assert.deepEqual(plain((await s.ok('gm', 'GET', '')).owner), { name: gmName, you: true, suspended: false, reviewOpen: false }, 'the stored Guild Master holds the seat');
  assert.deepEqual(plain((await s.ok('off', 'GET', '')).owner), { name: gmName, you: false, suspended: false });
  assert.deepEqual(plain((await s.ok('mem', 'GET', '')).owner), { name: gmName, you: false });
  // The seat set on the account: its holder, whoever the stored row says.
  s.setOwner('off');
  assert.deepEqual(plain((await s.ok('off', 'GET', '')).owner), { name: await display(s, 'off'), you: true, suspended: false, reviewOpen: false });
});

check('worker: a vacant seat names nobody and nobody is "you"', async () => {
  const s = await claimWorld();
  s.exec(`UPDATE guilds SET owner_user_id = NULL WHERE id = '${s.gid}'`);
  const member = (await s.ok('mem', 'GET', '')).owner;
  assert.deepEqual(plain(member), { name: null, you: false });
  const former = (await s.ok('gm', 'GET', '')).owner;
  assert.equal(former.name, null);
  assert.equal(former.you, false);
  assert(!('reviewOpen' in former), 'nobody is the Owner');
});

check('worker: the owner block is one statement, reads the claim from the one shared SQL and walks no table', async () => {
  const s = await claimWorld();
  await claim(s, 'igm');
  const db = s.w.db;
  const mark = db.statementLog.length;
  const payload = await s.ok('igm', 'GET', '');
  assert.equal(payload.owner.reviewOpen, true);
  const mine = db.statementLog.slice(mark).filter((entry) => entry.sql.includes("item_id = 'claim_review'"));
  assert.equal(mine.length, 1, 'one statement for the whole owner block');
  assert(mine[0].sql.includes("c.action = 'guild.claim'"), 'the claim read is the shared SQL (owner.js claimReviewSql), with the literal action the partial index serves');
  const scans = scansSince({ sqlite: db.sqlite, statementLog: mine }, 0);
  assert.deepEqual(scans.map((scan) => `${scan.table}: ${scan.detail}`), []);
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${mine[0].sql}`).all(...mine[0].values).map((row) => row.detail).join('\n');
  assert(plan.includes('audit_log_guild_claim'), plan);
  // The attention route reads the claim with the same SQL.
  const { claimReviewSql } = await load('worker/owner.js');
  const attention = read('worker/routes/attention.js');
  assert(attention.includes("claimReviewSql('id', '?1', '?4')") && attention.includes("claimReviewSql('created_at', '?1', '?4')"));
  assert(!attention.includes("c.action = 'guild.claim'"), 'no second copy of the claim SQL');
  assert(claimReviewSql('id', '?1', '?2').includes("'$.via') = 'gm_claim'"));
});

runChecks(checks);
