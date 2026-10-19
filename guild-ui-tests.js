/**
 * Raidsmith guild UI - tests for guild.css and js/guild/*.js
 * Run: node guild-ui-tests.js
 *
 * The guild scripts are classic scripts sharing one `Guild` namespace. Their render functions return HTML
 * strings, so they run here in a vm sandbox with no DOM: the pages' shared guild script list (tests/guild-scripts.js)
 * is loaded in order, exactly as the browser does. guild-shell-tests.js drives the shell against fake documents.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

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
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const GuildCss = require('./tests/guild-css');
const css = read('guild.css');
const appCss = read('app.css');

// The guild scripts in load order (the pages load them after their own scripts).
const scriptSrcs = GUILD_SCRIPTS;

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  vm.createContext(sandbox);
  for (const src of scriptSrcs) {
    vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  }
  return sandbox;
}
const ctx = loadGuild();
const G = ctx.Guild;
// Values built inside the sandbox have the sandbox's Object/Array prototypes; compare them as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));

// ── fixtures ─────────────────────────────────────────────────────
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const DAY = 86400000;
function person(id, displayName, extra) {
  return Object.assign({ id, username: displayName.toLowerCase(), displayName, avatarUrl: null, initials: displayName.slice(0, 2).toUpperCase() }, extra || {});
}
function entry(p, roles, lastSeenAt, extra) {
  return Object.assign({ person: p, roles, roster: null, lastSeenAt, isMe: false, actions: { editRoles: true, makeGuildMaster: false, removeAccess: true } }, extra || {});
}
const TEAMS = [
  { id: 't1', name: 'Team A', size: 25, archived: false, players: 0, leads: [person('u3', 'Mistvale')] },
  { id: 't2', name: 'Team B', size: 25, archived: false, players: 0, leads: [] },
  { id: 't3', name: 'Old Team', size: 25, archived: true, players: 0, leads: [] },
];
const PEOPLE = [
  entry(person('u1', 'Thornvald'), [{ role: 'guild_master' }], NOW, { isMe: true, actions: { editRoles: false, makeGuildMaster: false, removeAccess: false } }),
  entry(person('u2', 'Brightmane'), [{ role: 'officer' }], NOW - DAY),
  entry(person('u3', 'Mistvale'), [{ role: 'team_lead', teamId: 't1' }], NOW - 5 * DAY),
  entry(person('u4', 'Stormjaw'), [], NOW - 30 * DAY),
  entry(person('u5', 'Aelith'), [], null),
  entry(person('u6', 'Kaelith'), [{ role: 'officer' }, { role: 'team_lead', teamId: 't2' }], NOW - 2 * DAY),
];
const names = list => list.map(e => e.person.displayName);

function guildData(can, overrides) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'EU', timeZone: 'Europe/Berlin', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: NOW },
    teams: JSON.parse(JSON.stringify(TEAMS)),
    me: { roles: [{ role: 'officer' }], can },
  }, overrides || {});
}
const ALL_CAN = { 'guild.teams': 'guild', 'guild.access': 'guild', 'guild.roles': 'guild' };
function meData(extra) {
  return Object.assign({
    user: Object.assign(person('u1', 'Thornvald'), { prefs: { sidebarCollapsed: false, lastGuildId: 'g1' } }),
    guilds: [{ id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'EU', roles: [{ role: 'officer' }] }],
    create: { allowed: false },
    deleteImpact: { handOverFirst: [], guildsDeleted: [] },
  }, extra || {});
}
function shellHtml(can, route, collapsed) {
  const gd = guildData(can);
  return G.shell.render({ me: meData(), route: route || { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd, teamId: 't1', collapsed: !!collapsed }, '<p>main</p>');
}

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}

// ── router ───────────────────────────────────────────────────────
(async () => {
  await check('router: parse recognises every documented route', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p(''), { name: 'home' });
    assert.deepEqual(p('#'), { name: 'home' });
    assert.deepEqual(p('#/'), { name: 'home' });
    assert.deepEqual(p('#/signin'), { name: 'signin', error: null });
    assert.deepEqual(p('#/signin?error=denied'), { name: 'signin', error: 'denied' });
    assert.deepEqual(p('#/new'), { name: 'new' });
    assert.deepEqual(p('#/privacy'), { name: 'privacy' });
    assert.deepEqual(p('#/g/g_abc-1/roster'), { name: 'section', gid: 'g_abc-1', section: 'roster' });
    assert.deepEqual(p('#/g/g1/raids'), { name: 'section', gid: 'g1', section: 'raids' });
    assert.deepEqual(p('#/g/g1/attendance'), { name: 'section', gid: 'g1', section: 'attendance' });
    assert.deepEqual(p('#/g/g1/loot'), { name: 'section', gid: 'g1', section: 'loot' });
    assert.deepEqual(p('#/g/g1'), { name: 'section', gid: 'g1', section: 'home' });
    assert.deepEqual(p('#/g/g1/home'), { name: 'section', gid: 'g1', section: 'home' });
    assert.deepEqual(p('#/g/g1/settings'), { name: 'settings', gid: 'g1', tab: null });
    assert.deepEqual(p('#/g/g1/settings/teams'), { name: 'settings', gid: 'g1', tab: 'teams' });
    assert.deepEqual(p('#/g/g1/settings/people'), { name: 'settings', gid: 'g1', tab: 'people' });
  });

  await check('router: format and parse round-trip for every route shape', () => {
    const routes = [
      { name: 'home' }, { name: 'signin', error: null }, { name: 'signin', error: 'state' }, { name: 'signin', error: 'discord' },
      { name: 'new' }, { name: 'privacy' }, { name: 'planner' }, { name: 'planner', gid: 'g_Ab-9', rid: 'r_1-x' },
      ...['home', 'roster', 'raids', 'attendance', 'loot'].map(section => ({ name: 'section', gid: 'g_Ab-9', section })),
      { name: 'settings', gid: 'g1', tab: null }, { name: 'settings', gid: 'g1', tab: 'teams' }, { name: 'settings', gid: 'g1', tab: 'people' },
    ];
    for (const r of routes) assert.deepEqual(plain(G.router.parse(G.router.format(r))), r, JSON.stringify(r));
  });

  await check('router: unknown paths, bad ids and unknown error codes do not become routes', () => {
    for (const h of ['#/nope', '#/g', '#/g/g1/roster/extra', '#/g/g1/settings/billing', '#/g/g1/bank', '#/g/a%2Fb/roster', '#/g/%E0%A4%A/roster', '#/g/<x>/roster', '#/privacy/x']) {
      assert.equal(G.router.parse(h).name, 'notfound', h);
    }
    assert.equal(G.router.parse('#/signin?error=<script>').error, null);
    // a planner address with a bad raid is the plain planner; the format drops half a raid
    for (const h of ['#/planner?raid=g1', '#/planner?raid=g1.r1.x', '#/planner?raid=g%2F1.r1', '#/planner?raid=.r1', '#/planner?raid=<x>.r1']) assert.deepEqual(plain(G.router.parse(h)), { name: 'planner' }, h);
    assert.equal(G.router.parse('#/planner/x').name, 'notfound');
    assert.equal(G.router.format({ name: 'planner', gid: 'g1' }), '#/planner');
    assert.equal(G.router.format({ name: 'planner', gid: 'g1', rid: 'r1' }), '#/planner?raid=g1.r1');
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'bogus' }), '#/g/g1/roster');
    assert.equal(G.router.format({ name: 'whatever' }), '#/');
  });

  // ── api ────────────────────────────────────────────────────────
  function fakeFetch(status, body, headers) {
    const calls = [];
    const fn = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: k => (headers || {})[k] || null }, text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)) });
    };
    fn.calls = calls;
    return fn;
  }

  await check('api: non-GET requests send credentials, a JSON content type and a JSON body ({} when empty)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const f = fakeFetch(200, { ok: true });
      await G.api.request(method, '/x', undefined, f);
      const c = f.calls[0];
      assert.equal(c.init.method, method);
      assert.equal(c.init.credentials, 'same-origin');
      assert.equal(c.init.headers['Content-Type'], 'application/json');
      assert.equal(c.init.body, '{}');
    }
    const f = fakeFetch(200, { a: 1 });
    const out = await G.api.request('POST', '/x', { name: 'n' }, f);
    assert.equal(f.calls[0].init.body, '{"name":"n"}');
    assert.deepEqual(plain(out), { a: 1 });
  });

  await check('api: GET sends no body and no content type', async () => {
    const f = fakeFetch(200, { ok: 1 });
    await G.api.request('GET', '/auth/me', undefined, f);
    assert.equal(f.calls[0].init.body, undefined);
    assert.equal(f.calls[0].init.headers['Content-Type'], undefined);
    assert.equal(f.calls[0].init.credentials, 'same-origin');
  });

  await check('api: error responses become ApiError with code, message, field and retryAfter', async () => {
    const f = fakeFetch(409, { error: 'team_name_taken', message: 'That team name is taken.', field: 'name' });
    await assert.rejects(() => G.api.request('POST', '/x', {}, f), e => e.status === 409 && e.code === 'team_name_taken' && e.message === 'That team name is taken.' && e.field === 'name');
    const f2 = fakeFetch(429, { error: 'rate_limited', message: 'Slow down', retryAfter: 12 });
    await assert.rejects(() => G.api.request('POST', '/x', {}, f2), e => e.retryAfter === 12);
    const f3 = fakeFetch(429, { error: 'rate_limited' }, { 'Retry-After': '7' });
    await assert.rejects(() => G.api.request('POST', '/x', {}, f3), e => e.retryAfter === 7);
    const f4 = () => Promise.reject(new Error('offline'));
    await assert.rejects(() => G.api.request('GET', '/x', undefined, f4), e => e.status === 0 && e.code === 'network' && /connection/i.test(e.message));
    const f5 = fakeFetch(500, null);
    await assert.rejects(() => G.api.request('GET', '/x', undefined, f5), e => e.status === 500 && e.message.length > 0);
  });

  await check('api: classify maps 401 to sign-in, 403 access errors to a message page, 429 to the retry text', () => {
    const E = (status, code, extra) => new G.api.ApiError(status, Object.assign({ error: code, message: 'Server says so.' }, extra || {}));
    assert.equal(G.api.classify(E(401, 'signed_out')).view, 'signin');
    for (const code of ['access_removed', 'not_member', 'forbidden']) {
      const c = G.api.classify(E(403, code));
      assert.equal(c.view, 'message', code);
      assert.equal(c.text, 'Server says so.');
      assert(c.title.length > 0);
    }
    assert.equal(G.api.classify(E(403, 'cross_site')).view, 'inline');
    assert.equal(G.api.classify(E(403, 'reauth_required')).view, 'inline');
    // The server's own 429 message wins; the retry hint follows it (seconds below a minute, minutes from 60 s).
    assert.equal(G.api.classify(E(429, 'rate_limited', { retryAfter: 12 })).text, 'Server says so. Try again in 12 seconds.');
    assert.equal(G.api.classify(E(429, 'rate_limited', { retryAfter: 11.2 })).text, 'Server says so. Try again in 12 seconds.');
    assert.equal(G.api.classify(E(429, 'rate_limited', { retryAfter: 360 })).text, 'Server says so. Try again in 6 minutes.');
    assert.equal(G.api.classify(E(503, 'rate_limited', { retryAfter: 60 })).text, 'Server says so. Try again in 1 minute.');
    const bare = extra => new G.api.ApiError(429, Object.assign({ error: 'rate_limited' }, extra || {}));
    assert.equal(G.api.classify(bare({ retryAfter: 12 })).text, 'Too many changes, try again in 12 s');
    assert.match(G.api.classify(bare()).text, /^Too many changes, try again in/);
    const c409 = G.api.classify(E(409, 'server_taken'));
    assert.equal(c409.view, 'inline');
    assert.equal(c409.text, 'Server says so.');
  });

  // ── people-sort ────────────────────────────────────────────────
  await check('people-sort: default is Roles asc - Guild Master, Officer, Team Lead, Member, then name', () => {
    const out = names(G.peopleSort.sortPeople(PEOPLE, G.peopleSort.DEFAULT_SORT));
    assert.deepEqual(out, ['Thornvald', 'Brightmane', 'Kaelith', 'Mistvale', 'Aelith', 'Stormjaw']);
    assert.deepEqual(plain(G.peopleSort.DEFAULT_SORT), { column: 'roles', dir: 'asc' });
    assert.deepEqual(names(G.peopleSort.sortPeople(PEOPLE, undefined)), out);
  });

  await check('people-sort: Roles desc reverses the rank order', () => {
    const out = names(G.peopleSort.sortPeople(PEOPLE, { column: 'roles', dir: 'desc' }));
    assert.deepEqual(out, ['Aelith', 'Stormjaw', 'Mistvale', 'Brightmane', 'Kaelith', 'Thornvald']);
  });

  await check('people-sort: Person sorts by display name in both directions, case-insensitively', () => {
    const mixed = [entry(person('a', 'zed'), []), entry(person('b', 'Alpha'), []), entry(person('c', 'bravo'), [])];
    assert.deepEqual(names(G.peopleSort.sortPeople(mixed, { column: 'person', dir: 'asc' })), ['Alpha', 'bravo', 'zed']);
    assert.deepEqual(names(G.peopleSort.sortPeople(mixed, { column: 'person', dir: 'desc' })), ['zed', 'bravo', 'Alpha']);
  });

  await check('people-sort: Last seen puts the newest first (asc) and the oldest first (desc); never-seen sorts last either way', () => {
    const asc = names(G.peopleSort.sortPeople(PEOPLE, { column: 'lastSeen', dir: 'asc' }));
    assert.deepEqual(asc, ['Thornvald', 'Brightmane', 'Kaelith', 'Mistvale', 'Stormjaw', 'Aelith']);
    const desc = names(G.peopleSort.sortPeople(PEOPLE, { column: 'lastSeen', dir: 'desc' }));
    assert.deepEqual(desc, ['Stormjaw', 'Mistvale', 'Kaelith', 'Brightmane', 'Thornvald', 'Aelith']);
  });

  await check('people-sort: Roster sorts linked names and always puts Not linked last; all-null falls back to name', () => {
    const linked = [
      entry(person('a', 'Anna'), [], NOW, { roster: 'Zeta' }),
      entry(person('b', 'Ben'), [], NOW, { roster: null }),
      entry(person('c', 'Cleo'), [], NOW, { roster: { name: 'Alpha' } }),
    ];
    assert.deepEqual(names(G.peopleSort.sortPeople(linked, { column: 'roster', dir: 'asc' })), ['Cleo', 'Anna', 'Ben']);
    assert.deepEqual(names(G.peopleSort.sortPeople(linked, { column: 'roster', dir: 'desc' })), ['Anna', 'Cleo', 'Ben']);
    assert.deepEqual(names(G.peopleSort.sortPeople(PEOPLE, { column: 'roster', dir: 'desc' })), ['Aelith', 'Brightmane', 'Kaelith', 'Mistvale', 'Stormjaw', 'Thornvald']);
  });

  await check('people-sort: sorting never mutates its input and an unknown column falls back to the default', () => {
    const copy = names(PEOPLE);
    G.peopleSort.sortPeople(PEOPLE, { column: 'person', dir: 'desc' });
    assert.deepEqual(names(PEOPLE), copy);
    assert.deepEqual(names(G.peopleSort.sortPeople(PEOPLE, { column: 'bogus', dir: 'asc' })), names(G.peopleSort.sortPeople(PEOPLE, G.peopleSort.DEFAULT_SORT)));
  });

  await check('people-sort: nextSort starts a new column ascending and flips the active column; ariaSort follows', () => {
    assert.deepEqual(plain(G.peopleSort.nextSort({ column: 'roles', dir: 'asc' }, 'person')), { column: 'person', dir: 'asc' });
    assert.deepEqual(plain(G.peopleSort.nextSort({ column: 'person', dir: 'asc' }, 'person')), { column: 'person', dir: 'desc' });
    assert.deepEqual(plain(G.peopleSort.nextSort({ column: 'person', dir: 'desc' }, 'person')), { column: 'person', dir: 'asc' });
    assert.deepEqual(plain(G.peopleSort.nextSort({ column: 'person', dir: 'desc' }, 'nope')), { column: 'person', dir: 'desc' });
    assert.equal(G.peopleSort.ariaSort({ column: 'roles', dir: 'asc' }, 'roles'), 'ascending');
    assert.equal(G.peopleSort.ariaSort({ column: 'roles', dir: 'desc' }, 'roles'), 'descending');
    assert.equal(G.peopleSort.ariaSort({ column: 'roles', dir: 'asc' }, 'person'), null);
  });

  await check('people-sort: roleLabels shows Member for no roles and names the team on Team Lead (archived teams too)', () => {
    assert.deepEqual(plain(G.peopleSort.roleLabels([], TEAMS)).map(r => r.label), ['Member']);
    assert.deepEqual(plain(G.peopleSort.roleLabels([{ role: 'team_lead', teamId: 't3' }, { role: 'officer' }], TEAMS)).map(r => r.label), ['Officer', 'Team Lead: Old Team']);
    assert.deepEqual(plain(G.peopleSort.roleLabels([{ role: 'team_lead', teamId: 'gone' }], TEAMS)).map(r => r.label), ['Team Lead']);
  });

  await check('people-sort: filterPeople matches display name or username, case-insensitively', () => {
    assert.deepEqual(names(G.peopleSort.filterPeople(PEOPLE, 'ELITH')), ['Aelith', 'Kaelith']);
    assert.equal(G.peopleSort.filterPeople(PEOPLE, '').length, PEOPLE.length);
    assert.equal(G.peopleSort.filterPeople(PEOPLE, 'zzz').length, 0);
  });

  await check('people table: Not linked shows for a null roster, a role-less person shows Member, headers carry aria-sort', () => {
    const out = G.pages.people.tableHtml({ people: PEOPLE, teams: TEAMS, sort: { column: 'person', dir: 'desc' }, query: '', now: NOW });
    assert(out.includes('Not linked'));
    assert(out.includes('>Member<'));
    assert(out.includes('aria-sort="descending"'));
    assert.equal((out.match(/aria-sort=/g) || []).length, 1);
    for (const col of ['person', 'roster', 'roles', 'lastSeen']) assert(out.includes(`data-action="sort" data-col="${col}"`), col);
    assert(/<button type="button" class="gs-sort"/.test(out));
    const order = ['Thornvald', 'Stormjaw', 'Mistvale', 'Kaelith', 'Brightmane', 'Aelith'];
    let at = out.indexOf('<tbody>');
    for (const n of order) { const i = out.indexOf('<span class="gs-person-name">' + n, at); assert(i > at, n); at = i; }
  });

  await check('people table: Last seen is relative text with the date in a title', () => {
    const out = G.pages.people.tableHtml({ people: PEOPLE, teams: TEAMS, sort: G.peopleSort.DEFAULT_SORT, query: '', now: NOW });
    assert(out.includes('>Today<'));
    assert(out.includes('>Yesterday<'));
    assert(out.includes('>5 days ago<'));
    assert(out.includes('>Not yet<'));
    assert(/<span title="[^"]+">Today<\/span>/.test(out));
    assert.equal(G.ui.relativeTime(NOW - 20 * DAY, NOW), G.ui.formatDate(NOW - 20 * DAY));
  });

  // ── can-driven visibility ──────────────────────────────────────
  await check('visibility: hasAction accepts "guild" and a non-empty team list, and nothing else', () => {
    assert.equal(G.shell.hasAction({ a: 'guild' }, 'a'), true);
    assert.equal(G.shell.hasAction({ a: ['t1'] }, 'a'), true);
    assert.equal(G.shell.hasAction({ a: [] }, 'a'), false);
    assert.equal(G.shell.hasAction({}, 'a'), false);
    assert.equal(G.shell.hasAction(undefined, 'a'), false);
    assert.equal(G.shell.hasAction({ a: 'nope' }, 'a'), false);
    assert.equal(G.shell.hasAction({ toString: 'guild' }, 'hasOwnProperty'), false);
  });

  await check('visibility: the Guild settings nav item needs guild.teams, guild.access or guild.roles', () => {
    for (const can of [{ 'guild.teams': 'guild' }, { 'guild.access': 'guild' }, { 'guild.roles': 'guild' }]) {
      assert.equal(G.shell.canSeeSettings(can), true, JSON.stringify(can));
      assert(shellHtml(can).includes('Guild settings'), JSON.stringify(can));
    }
    for (const can of [{}, { 'roster.view': 'guild' }, { 'attendance.view': ['t1'] }, { 'guild.teams': [] }]) {
      assert.equal(G.shell.canSeeSettings(can), false, JSON.stringify(can));
      assert(!shellHtml(can).includes('Guild settings'), JSON.stringify(can));
    }
  });

  await check('visibility: Guild settings tabs follow the actions (Teams and Battle.net: guild.teams; People: guild.access or guild.roles)', () => {
    const tabs = can => plain(G.shell.settingsTabs(can).map(t => t.tab));
    assert.deepEqual(tabs({ 'guild.teams': 'guild' }), ['general', 'teams', 'notifications', 'applications', 'battlenet']);
    assert.deepEqual(tabs({ 'guild.access': 'guild' }), ['people', 'guests', 'dataaccess']);
    assert.deepEqual(tabs({ 'guild.roles': 'guild' }), ['people', 'roles', 'discord', 'public']);
    assert.deepEqual(tabs(ALL_CAN), ['general', 'teams', 'people', 'roles', 'discord', 'guests', 'public', 'dataaccess', 'notifications', 'applications', 'battlenet']);
    assert.deepEqual(tabs({}), []);
    const frame = G.shell.settingsFrameHtml({ guildData: guildData({ 'guild.access': 'guild' }) }, 'people', '<p>x</p>');
    assert(frame.includes('Accounts'));
    assert(!/>Teams</.test(frame));
    const nav = G.shell.navItems('g1', { 'guild.access': 'guild' }).find(i => i.key === 'settings');
    assert.equal(nav.href, '#/g/g1/settings', 'the bare address: the app opens the first page on a wide screen and the list on a phone');
  });

  await check('visibility: the phone tabs never list settings; the drawer follows the same rule as the sidebar', () => {
    const out = shellHtml(ALL_CAN);
    const tabs = out.slice(out.indexOf('<nav class="gs-tabs"'), out.indexOf('</nav>', out.indexOf('<nav class="gs-tabs"')));
    // The framework's bar: Home, Raids, Attendance, Loot, More for someone with no raid or roster actions (an officer's has Roster, no Loot); Settings and Planner live under More, which opens the drawer.
    for (const label of ['Home', 'Raids', 'Attendance', 'Loot']) assert(tabs.includes(`aria-label="${label}"`) || tabs.includes(`aria-label="${label},`), label);
    assert(!tabs.includes('aria-label="Roster"') && !tabs.includes('aria-label="Planner"') && tabs.includes('data-action="open-drawer"') && tabs.includes('>More<'), 'More holds the rest');
    assert(!tabs.includes('Guild settings'));
    const drawer = out.slice(out.indexOf('<dialog class="gs-drawer"'));
    assert(drawer.includes('Guild settings'));
    assert(!shellHtml({}).slice(shellHtml({}).indexOf('<dialog class="gs-drawer"')).includes('Guild settings'));
  });

  await check('visibility: team buttons show only with guild.teams', () => {
    const withTeams = G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.teams': 'guild' }) });
    assert(withTeams.includes('data-action="team-add"'));
    assert(withTeams.includes('data-action="team-rename"'));
    assert(withTeams.includes('data-action="team-archive"'));
    assert(withTeams.includes('data-action="team-restore"'));
    const without = G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.access': 'guild' }) });
    for (const a of ['team-add', 'team-rename', 'team-archive', 'team-restore']) assert(!without.includes(`data-action="${a}"`), a);
    assert(without.includes('Team A'));
  });

  await check('teams page: archived teams are listed apart, with the locked-to-one-team note', () => {
    const out = G.pages.teams.teamsHtml({ guildData: guildData(ALL_CAN) });
    assert(out.includes('Each character is locked to one team. Archived teams keep their history.'));
    const activePart = out.slice(0, out.indexOf('Archived teams ('));
    assert(activePart.includes('Team A') && activePart.includes('Team B') && !activePart.includes('Old Team'));
    assert(out.slice(out.indexOf('Archived teams (')).includes('Old Team'));
    assert(out.includes('aria-label="Archive Team A"') && out.includes('aria-label="Rename Team B"') && out.includes('aria-label="Restore Old Team"'));
  });

  await check('visibility: person row actions come only from the server actions flags', () => {
    const rows = [
      entry(person('a', 'Both'), [], NOW, { actions: { editRoles: true, makeGuildMaster: false, removeAccess: true } }),
      entry(person('b', 'EditOnly'), [], NOW, { actions: { editRoles: true, makeGuildMaster: false, removeAccess: false } }),
      entry(person('c', 'RemoveOnly'), [], NOW, { actions: { editRoles: false, makeGuildMaster: false, removeAccess: true } }),
      entry(person('d', 'GmOnly'), [], NOW, { actions: { editRoles: false, makeGuildMaster: true, removeAccess: false } }),
      entry(person('e', 'None'), [], NOW, { actions: { editRoles: false, makeGuildMaster: false, removeAccess: false } }),
      entry(person('f', 'NoFlags'), [{ role: 'guild_master' }], NOW, { actions: undefined }),
    ];
    const out = G.pages.people.tableHtml({ people: rows, teams: TEAMS, sort: { column: 'person', dir: 'asc' }, query: '', now: NOW });
    const has = (what, name) => out.includes(`aria-label="${what} ${name}"`);
    assert(has('Edit roles for', 'Both') && has('Remove access for', 'Both'));
    assert(has('Edit roles for', 'EditOnly') && !has('Remove access for', 'EditOnly'));
    assert(!has('Edit roles for', 'RemoveOnly') && has('Remove access for', 'RemoveOnly'));
    assert(has('Edit roles for', 'GmOnly') && !has('Remove access for', 'GmOnly'));
    assert(!has('Edit roles for', 'None') && !has('Remove access for', 'None'));
    assert(!has('Edit roles for', 'NoFlags') && !has('Remove access for', 'NoFlags'));
  });

  await check('visibility: Restore access shows only when the removed row allows it', () => {
    const removed = [
      { person: person('r1', 'Allowed'), roles: [], removedBy: person('u1', 'Thornvald'), removedAt: NOW, reason: 'Left the guild', actions: { restoreAccess: true } },
      { person: person('r2', 'Denied'), roles: [], removedBy: null, removedAt: NOW, reason: '', actions: { restoreAccess: false } },
    ];
    const out = G.pages.people.removedHtml({ removed });
    assert(out.includes('aria-label="Restore access for Allowed"'));
    assert(!out.includes('Restore access for Denied'));
    assert(out.includes('Access removed (2)'));
    assert(/Removed by Thornvald on [A-Z][a-z]{2} \d{1,2}, \d{4} - Left the guild/.test(out));
    assert(/Removed on [A-Z][a-z]{2} \d{1,2}, \d{4}</.test(out));
    assert.equal(G.pages.people.removedHtml({ removed: [] }), '');
  });

  await check('visibility: Make Guild Master is in Edit roles only when the server allows it; Save only when roles are editable', () => {
    const base = entry(person('u2', 'Brightmane'), [{ role: 'officer' }], NOW);
    const withGm = G.pages.people.rolesDialogHtml(Object.assign({}, base, { actions: { editRoles: true, makeGuildMaster: true, removeAccess: true } }), TEAMS, 'Ravens');
    assert(withGm.includes('Make Guild Master') && withGm.includes('data-action="gm-confirm"'));
    assert(withGm.includes('You become an Officer'));
    const without = G.pages.people.rolesDialogHtml(base, TEAMS, 'Ravens');
    assert(!without.includes('Make Guild Master') && !without.includes('gm-confirm'));
    assert(without.includes('type="submit"'));
    const gmOnly = G.pages.people.rolesDialogHtml(Object.assign({}, base, { actions: { editRoles: false, makeGuildMaster: true, removeAccess: false } }), TEAMS, 'Ravens');
    assert(!gmOnly.includes('type="submit"') && gmOnly.includes('<fieldset class="gs-fieldset" disabled>'));
  });

  await check('roles dialog: Officer plus Team Lead per active team, pre-checked from the current roles', () => {
    const e = entry(person('u6', 'Kaelith'), [{ role: 'officer' }, { role: 'team_lead', teamId: 't2' }], NOW);
    const out = G.pages.people.rolesDialogHtml(e, TEAMS, 'Ravens');
    assert(/name="officer" checked/.test(out));
    assert(/name="teamLead" value="t2" checked/.test(out));
    assert(/name="teamLead" value="t1"(?! checked)/.test(out));
    assert(!out.includes('value="t3"'), 'archived team must not be offered');
    assert(out.includes('Officer: whole guild') && out.includes('Team Lead: Team A') && out.includes('Team Lead: Team B'));
    assert(out.includes('id="dlg-title"') && out.includes('Edit roles for Kaelith'));
  });

  await check('remove dialog: optional reason capped at 200 characters, names the person and the guild', () => {
    const out = G.pages.people.removeDialogHtml(entry(person('u4', 'Stormjaw'), [], NOW), 'Ravens');
    assert(out.includes("Remove Stormjaw's access?"));
    assert(out.includes("Stormjaw can't open Ravens's pages"));
    assert(/name="reason" maxlength="200"/.test(out));
    assert(out.includes('Reason (optional)'));
  });

  await check('visibility: the Add a guild tile needs create.allowed; guild tiles come from /auth/me', () => {
    const base = { me: meData(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildData(ALL_CAN), teamId: 't1', collapsed: false };
    assert(!G.shell.render(base, '').includes('Add a guild'));
    const allowed = G.shell.render(Object.assign({}, base, { me: meData({ create: { allowed: true, stale: false, servers: [] } }) }), '');
    assert(allowed.includes('aria-label="Add a guild"') && allowed.includes('href="#/new"'));
    assert(allowed.includes('aria-label="Ravens"') && allowed.includes('aria-current="true"'));
  });

  await check('shell: collapsed state, toggle label and aria-expanded follow the prefs flag; sidebar team picker lists active teams only', () => {
    const open = shellHtml(ALL_CAN, null, false);
    assert(open.includes('aria-expanded="true" aria-label="Collapse sidebar"'));
    const shut = shellHtml(ALL_CAN, null, true);
    assert(shut.includes('aria-expanded="false" aria-label="Expand sidebar"'));
    assert(/<option value="t1" selected>Team A<\/option><option value="t2">Team B<\/option><\/select>/.test(open));
    assert(!open.includes('Old Team'));
  });

  await check('shell: breadcrumb names guild, team and page; settings breadcrumb names the tab', () => {
    const gd = guildData(ALL_CAN);
    const crumbs = (route, teamId) => plain(G.shell.breadcrumbItems({ route, guildData: gd, teamId }).map(c => c.label));
    assert.deepEqual(crumbs({ name: 'section', gid: 'g1', section: 'raids' }, 't1'), ['Ravens', 'Team A', 'Raids']);
    assert.deepEqual(crumbs({ name: 'settings', gid: 'g1', tab: 'people' }, 't1'), ['Ravens', 'Guild settings', 'Accounts']);
    assert.deepEqual(crumbs({ name: 'new' }, null), ['Create a guild']);
    assert.deepEqual(crumbs({ name: 'privacy' }, null), ['Privacy & my data']);
  });

  await check('avatar menu: My characters, Linked accounts, Privacy & my data and Sign out (no Open the planner: the sidebar has it)', () => {
    const menu = G.shell.accountMenuHtml({ me: meData(), guildData: guildData(ALL_CAN) });
    assert(menu.includes('href="#/characters"') && menu.includes('href="#/linked"') && menu.includes('href="#/privacy"') && menu.includes('data-action="sign-out"'));
    assert(menu.indexOf('#/characters') < menu.indexOf('#/linked') && menu.indexOf('#/linked') < menu.indexOf('#/privacy'), 'in that order');
    for (const gone of ['My profile', 'Switch guild', 'Open the planner']) assert(!menu.includes(gone), gone);
    assert(!menu.includes('href="/"'));
    assert.equal((menu.match(/role="menuitem"/g) || []).length, 5, 'with a guild current: Away notices joins them');
    assert(menu.includes('href="#/g/g1/away"') && menu.indexOf('#/characters') < menu.indexOf('#/g/g1/away') && menu.indexOf('#/g/g1/away') < menu.indexOf('#/linked'));
    assert.equal((G.shell.accountMenuHtml({ me: meData() }).match(/role="menuitem"/g) || []).length, 4, 'no guild current: the four of before');
    assert(G.icons.names.includes('link'));
    assert(menu.includes('aria-haspopup="menu"') && menu.includes('aria-expanded="false"'));
  });

  // ── hostile names ──────────────────────────────────────────────
  await check('hostile names: people table, removed list and dialogs come out escaped', () => {
    const bad = person('x1', HOSTILE + QUOTES, { avatarUrl: 'https://cdn.discordapp.com/a.png" onerror="x' });
    const e = entry(bad, [{ role: 'team_lead', teamId: 't9' }], NOW);
    const teams = [{ id: 't9', name: HOSTILE + QUOTES, size: 25, archived: false }];
    const table = G.pages.people.tableHtml({ people: [e], teams, sort: G.peopleSort.DEFAULT_SORT, query: '', now: NOW });
    assertEscaped(table, 'table');
    assert(table.includes('&lt;img src=x onerror=1&gt;'));
    assert(table.includes('&quot;'));
    assertEscaped(G.pages.people.rolesDialogHtml(e, teams, HOSTILE + QUOTES), 'roles dialog');
    assertEscaped(G.pages.people.removeDialogHtml(e, HOSTILE + QUOTES), 'remove dialog');
    assertEscaped(G.pages.people.removedHtml({ removed: [{ person: bad, roles: [], removedBy: bad, removedAt: NOW, reason: HOSTILE + QUOTES, actions: { restoreAccess: true } }] }), 'removed');
    assertEscaped(G.pages.people.peopleHtml({ guildData: guildData(ALL_CAN), data: { signedInCount: 1, people: [e], removed: [] }, sort: G.peopleSort.DEFAULT_SORT, query: HOSTILE + QUOTES, notice: HOSTILE, alert: HOSTILE, now: NOW }), 'people page');
  });

  await check('hostile names: shell, teams page, team dialog, create page, privacy and messages come out escaped', () => {
    const gd = guildData(ALL_CAN, {
      guild: { id: 'g1', name: HOSTILE + QUOTES, realm: HOSTILE + QUOTES, region: 'EU', timeZone: 'UTC', gameVersion: HOSTILE, createdAt: NOW },
      teams: [{ id: 't1', name: HOSTILE + QUOTES, size: 25, archived: false, players: 1, leads: [person('u3', HOSTILE + QUOTES)] }, { id: 't2', name: HOSTILE, size: 25, archived: true, players: 0, leads: [] }],
    });
    const me = meData({ user: Object.assign(person('u1', HOSTILE + QUOTES), { username: HOSTILE, prefs: {} }), guilds: [{ id: 'g1', name: HOSTILE + QUOTES, realm: 'x', region: 'EU', roles: [] }] });
    const shell = G.shell.render({ me, route: { name: 'settings', gid: 'g1', tab: 'teams' }, guildData: gd, teamId: 't1', collapsed: false }, G.pages.teams.teamsHtml({ guildData: gd, alert: HOSTILE }));
    assertEscaped(shell, 'shell + teams');
    assertEscaped(G.pages.teams.teamDialogHtml('rename', gd.teams[0], HOSTILE + QUOTES), 'team dialog');
    const create = G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: false, servers: [{ id: '1" onfocus="alert(1)" x="', name: HOSTILE + QUOTES, iconUrl: null, access: HOSTILE }] } }), timeZones: [HOSTILE + QUOTES, 'UTC'], defaultTimeZone: HOSTILE + QUOTES });
    assertEscaped(create, 'create');
    assertEscaped(G.pages.signin.noGuildHtml(me), 'no guild');
    assertEscaped(G.pages.signin.messageHtml(HOSTILE + QUOTES, HOSTILE + QUOTES, {}), 'message');
    assertEscaped(G.pages.signin.signinHtml({ error: HOSTILE, notice: HOSTILE + QUOTES }), 'signin');
    assertEscaped(G.pages.privacy.privacyHtml({ me: meData({ deleteImpact: { handOverFirst: [{ id: 'g" onfocus="alert(1)" x="', name: HOSTILE + QUOTES }], guildsDeleted: [{ id: 'g2', name: HOSTILE + QUOTES }] } }), message: HOSTILE + QUOTES }), 'privacy');
  });

  // ── Delete my data ─────────────────────────────────────────────
  await check('delete: handOverFirst blocks the button and names the guilds', () => {
    const out = G.pages.privacy.deleteBoxHtml({ handOverFirst: [{ id: 'g1', name: 'Ravens' }, { id: 'g2', name: 'Owls' }], guildsDeleted: [] }, '');
    assert(/disabled[^>]*id="delete-open"/.test(out), 'open button disabled');
    assert(out.includes('delete-blocked') && out.includes('<strong>Ravens</strong>') && out.includes('<strong>Owls</strong>') && out.includes('Make Guild Master'));
    assert(!out.includes('id="delete-confirm"') && !out.includes('id="delete-go"'), 'no confirm path while blocked');
    assert(out.includes('href="#/g/g1/settings/people"'));
  });

  await check('delete: with nothing in the way the confirm needs "I understand" before the button enables', () => {
    const out = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [] }, '');
    assert(!/disabled[^>]*id="delete-open"/.test(out));
    assert(/id="delete-confirm"[^>]* hidden/.test(out));
    assert(/ disabled[^>]*id="delete-go"/.test(out));
    assert(out.includes('I understand') && out.includes('id="delete-understand"'));
    assert(!out.includes('delete-guilds'));
  });

  await check('delete: guildsDeleted are listed in the warning and in the confirm', () => {
    const out = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [{ id: 'g1', name: 'Ravens' }, { id: 'g2', name: 'Owls' }] }, '');
    assert(out.includes('id="delete-guilds"') && out.includes('<strong>Ravens</strong> and <strong>Owls</strong>'));
    const confirm = out.slice(out.indexOf('id="delete-confirm"'));
    assert(confirm.includes('It also deletes <strong>Ravens</strong> and <strong>Owls</strong>'));
    assert(out.includes('those guilds'));
  });

  await check('delete: the request echoes deleteGuildIds from deleteImpact.guildsDeleted', async () => {
    const calls = [];
    const realDel = G.api.del;
    G.api.del = (p, b) => { calls.push([p, plain(b)]); return new Promise(() => {}); };
    G.app.state.me = meData({ deleteImpact: { handOverFirst: [], guildsDeleted: [{ id: 'g1', name: 'Ravens' }, { id: 'g2', name: 'Owls' }] } });
    const btn = { disabled: false };
    G.handlers.click['delete-go'](btn);
    assert.deepEqual(calls, [['/auth/me', { deleteGuildIds: ['g1', 'g2'] }]]);
    assert.equal(btn.disabled, true);
    G.app.state.me = meData();
    G.handlers.click['delete-go']({ disabled: false });
    assert.deepEqual(calls[1], ['/auth/me', { deleteGuildIds: [] }]);
    G.api.del = realDel;
    G.app.state.me = null;
  });

  await check('delete: a server message shows in the delete box; signed-out visitors get the policy without the delete box', () => {
    const msg = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [] }, 'Hand over Ravens first.');
    assert(/id="delete-error"[^>]*>Hand over Ravens first\.<\/p>/.test(msg));
    assert(!/id="delete-error"[^>]* hidden/.test(msg));
    const out = G.pages.privacy.privacyHtml({ me: null });
    assert(!out.includes('Delete my data') && out.includes('Questions about your data: [Contact]'));
  });

  await check('privacy copy carries the spec fixes', () => {
    const out = G.pages.privacy.privacyHtml({ me: meData() }).replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const s of [
      "Members see the guild's roster and raids, and the attendance of the teams they have a character on.",
      'kept for 30 minutes after sign-in',
      'Two cookies: one keeps you signed in for 30 days, and a second lasts 10 minutes while you sign in.',
      'lifts any access block',
      'Roster records stay with the guild, unlinked, once the guild keeps them',
      'hand over first',
      'Privacy & my data',
    ]) assert(out.toLowerCase().includes(s.toLowerCase()), s);
    assert(out.includes('If nobody else has joined, the guild is deleted too.'));
  });

  // ── other pages ────────────────────────────────────────────────
  await check('sign in: plain links to /auth/login (and the Battle.net sign-in where the server has it), no button handler needed', () => {
    const out = G.pages.signin.signinHtml({});
    assert(/<a class="gs-btn gs-btn-molten[^"]*" href="\/auth\/login">/.test(out));
    assert(out.includes('Continue with Discord') && out.includes('href="#/privacy"') && out.includes('Open the planner'));
    assert(!out.includes('Battle.net') && !out.includes('/auth/bnet/login'), 'until the server says Battle.net is set up only Discord is offered');
    const both = G.pages.signin.signinHtml({ providers: { discord: true, bnet: true } });
    assert(/<a class="gs-btn gs-btn-molten[^"]*" href="\/auth\/login">/.test(both) && /<a class="gs-btn gs-btn-lg gs-btn-wide" href="\/auth\/bnet\/login\?mode=signin">/.test(both));
    assert(both.includes('Continue with Battle.net') && both.indexOf('Continue with Discord') < both.indexOf('Continue with Battle.net'));
    assert(both.includes('New here? Either one makes your account'));
    const bnetOnly = G.pages.signin.signinHtml({ providers: { discord: false, bnet: true } });
    assert(!bnetOnly.includes('Continue with Discord') && /<a class="gs-btn gs-btn-molten gs-btn-lg gs-btn-wide" href="\/auth\/bnet\/login\?mode=signin">/.test(bnetOnly));
    assert(!G.pages.signin.signinHtml({ providers: { discord: true, bnet: false } }).includes('Battle.net'));
    for (const key of G.router.parse('#/signin').error === null ? ['denied', 'state', 'discord', 'bnet', 'not_configured'] : []) {
      assert(G.pages.signin.signinHtml({ error: key }).includes('role="alert"'), key);
      assert.equal(G.router.parse('#/signin?error=' + key).error, key);
    }
    assert(G.pages.signin.signinHtml({ error: 'denied' }).includes('cancelled'));
    assert(!G.pages.signin.signinHtml({ error: 'nope' }).includes('role="alert"'));
  });

  await check('no guild: Create a guild shows only for allowlisted accounts', () => {
    assert(!G.pages.signin.noGuildHtml(meData()).includes('Create a guild'));
    assert(G.pages.signin.noGuildHtml(meData({ create: { allowed: true, stale: false, servers: [] } })).includes('href="#/new"'));
    assert(G.pages.signin.noGuildHtml(meData()).includes('Sign in again'));
  });

  await check('create guild: radios from servers with access badges; stale list shows the sign-in link and disables Create', () => {
    const servers = [{ id: 's1', name: 'Ravens HQ', iconUrl: null, access: 'owner' }, { id: 's2', name: 'Other', iconUrl: null, access: 'manage_server' }];
    const ok = G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: false, servers } }), timeZones: ['Europe/Berlin', 'UTC'], defaultTimeZone: 'Europe/Berlin' });
    assert(/name="serverId" value="s1" checked/.test(ok) && /name="serverId" value="s2">/.test(ok));
    assert(ok.includes('>Owner<') && ok.includes('>Manage Server<'));
    assert(/<option value="Europe\/Berlin" selected>/.test(ok));
    for (const r of ['US', 'EU', 'KR', 'TW']) assert(ok.includes(`<option value="${r}"`), r);
    assert(!/disabled data-key="create-guild"/.test(ok));
    assert(ok.includes('name="multipleTeams"') && !ok.includes('name="teamName"'));
    const stale = G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: true, servers } }), timeZones: ['UTC'], defaultTimeZone: '' });
    assert(stale.includes('Sign in again to refresh your server list') && stale.includes('href="/auth/login"'));
    assert(/disabled data-key="create-guild"/.test(stale));
    assert(G.pages.create.createHtml({ me: meData(), timeZones: [] }).includes('You cannot create a guild'));
    assert(G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: false, servers: [] } }), timeZones: [] }).includes('No servers to list'));
  });

  await check('create guild: a browser time zone missing from the list is still offered and selected', () => {
    const out = G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: false, servers: [{ id: 's1', name: 'X', access: 'owner' }] } }), timeZones: ['UTC'], defaultTimeZone: 'Mars/Base' });
    assert(/<option value="Mars\/Base" selected>/.test(out));
  });

  await check('coming-next page: gone. Roster, Raids, Attendance and Loot are all real pages (Phase 4), nothing is a stub any more', () => {
    assert.equal(G.pages.empty, undefined, 'pages-empty.js was removed');
    for (const key of ['roster', 'raids', 'attendance', 'loot']) assert(G.pages[key] || G.pages.signin, key);
    assert.equal(typeof G.pages.loot.main, 'function');
    assert(!read('js/guild/app.js').includes('coming next'));
  });

  // ── Create guild v2 ────────────────────────────────────────────
  const realmsModule = await import('./worker/realms.js');
  const CREATE_OPTIONS = plain({
    versions: realmsModule.GAME_VERSIONS, regions: realmsModule.REGIONS, realms: realmsModule.REALMS, rulesets: realmsModule.FOREVER_RULESETS,
  });
  const CREATE_SERVERS = [{ id: 's1', name: 'Ravens HQ', iconUrl: null, access: 'owner' }];
  const createPage = () => G.pages.create.createHtml({
    me: meData({ create: { allowed: true, stale: false, servers: CREATE_SERVERS, options: CREATE_OPTIONS } }), timeZones: ['UTC'], defaultTimeZone: 'UTC',
  });
  const optionValues = out => [...out.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  const idxOf = (out, needle) => { const i = out.indexOf(needle); assert(i >= 0, needle); return i; };

  await check('create guild v2: field order is server, game version, region, realm, guild name, time zone, then raid teams', () => {
    const out = createPage();
    const order = ['Discord server</legend>', 'for="cg-version"', 'for="cg-region"', 'for="cg-realm"', 'for="cg-name"', 'for="cg-timezone"', 'Raid teams</legend>'];
    const at = order.map(n => idxOf(out, n));
    assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'fields are in the approved order');
    assert.deepEqual(optionValues(out.slice(idxOf(out, 'id="cg-version"'), idxOf(out, 'id="cg-region"'))), ['tbc', 'classic', 'forever']);
    for (const label of ['TBC Anniversary', 'Classic Era', 'WoW Forever']) assert(out.includes('>' + label + '</option>'), label);
    assert(!out.includes('value="Team A"') && !out.includes('name="teamName"'), 'no team name field until several teams');
  });

  await check('create guild v2: realm options follow version + region, read "Name - Type", and end with Other (type it)', () => {
    const { realmFieldsHtml } = G.pages.create;
    const tbcUs = realmFieldsHtml('tbc', 'US', {});
    assert.deepEqual(optionValues(tbcUs), ['Dreamscythe', 'Nightslayer', 'Maladath (AU)', '__other__']);
    assert(tbcUs.includes('>Dreamscythe - PvE</option>') && tbcUs.includes('>Maladath (AU) - PvP</option>') && tbcUs.includes('>Other (type it)</option>'));
    assert(!tbcUs.includes('Doomhowl') && !tbcUs.includes('id="cg-realm-other"'), 'Hardcore is Classic Era; no text field while a listed realm is picked');
    assert.deepEqual(optionValues(realmFieldsHtml('tbc', 'EU', {})), ['Thunderstrike', 'Spineshatter', '__other__']);
    assert(realmFieldsHtml('classic', 'US', {}).includes('>Doomhowl - Hardcore</option>'));
    assert(realmFieldsHtml('classic', 'EU', {}).includes('>Soulseeker - Hardcore</option>'));
    const eraKr = optionValues(realmFieldsHtml('classic', 'KR', {}));
    assert.equal(eraKr.length, realmsModule.REALMS.classic.KR.length + 1);
    assert(realmFieldsHtml('classic', 'US', {}).includes('<label class="gs-label" for="cg-realm">Realm</label>'));
  });

  await check('create guild v2: Other (type it) reveals a Realm name text field and keeps what was typed; KR/TW TBC shows the hint', () => {
    const { realmFieldsHtml } = G.pages.create;
    const other = realmFieldsHtml('tbc', 'US', { choice: '__other__', other: 'My "Realm" <b>' });
    assert(/<option value="__other__" selected>Other \(type it\)<\/option>/.test(other));
    assert(other.includes('for="cg-realm-other">Realm name</label>') && other.includes('id="cg-realm-other"'));
    assert(other.includes('value="My &quot;Realm&quot; &lt;b&gt;"') && !other.includes('<b>'), 'typed text is escaped and kept');
    for (const region of ['KR', 'TW']) {
      const out = realmFieldsHtml('tbc', region, {});
      assert.deepEqual(optionValues(out), ['__other__'], region);
      assert(out.includes('No TBC Anniversary realms in this region.') && out.includes('id="cg-realm-other"'), region);
    }
    assert(!realmFieldsHtml('classic', 'US', {}).includes('No TBC Anniversary realms'));
    assert(!realmFieldsHtml('tbc', 'US', {}).includes('No TBC Anniversary realms'));
    assert(!/value="Dreamscythe" selected/.test(realmFieldsHtml('tbc', 'EU', { choice: 'Dreamscythe' })), 'a choice that left the list falls back to the first realm');
  });

  await check('create guild v2: WoW Forever swaps Realm for a Ruleset select (Normal, PvP, RP, Hardcore) and never offers Other', () => {
    const out = G.pages.create.realmFieldsHtml('forever', 'EU', {});
    assert(out.includes('for="cg-realm">Ruleset</label>') && !out.includes('>Realm</label>'));
    assert.deepEqual(optionValues(out), ['Normal', 'PvP', 'RP', 'Hardcore']);
    assert(!out.includes('Other (type it)') && !out.includes('cg-realm-other'));
    assert(/<option value="RP" selected>/.test(G.pages.create.realmFieldsHtml('forever', 'US', { choice: 'RP' })));
    assert(!/value="Dreamscythe"/.test(G.pages.create.realmFieldsHtml('forever', 'US', { choice: 'Dreamscythe' })));
  });

  await check('create guild v2: the teams radio starts on one team (helper text only); several teams shows two name fields, Add another team, and Remove from the third', () => {
    const page = createPage();
    assert(/name="multipleTeams" value="one" checked/.test(page) && /name="multipleTeams" value="many" data-change/.test(page));
    assert(page.includes('Does your guild run more than one raid team?') && page.includes('>No, one team<') && page.includes('>Yes, several teams<'));
    assert(page.includes('ll set up one team for you. You can add more later in Guild settings.'));
    const { teamsFieldsHtml } = G.pages.create;
    const two = teamsFieldsHtml(true, []);
    assert(two.includes('>Team 1 name</label>') && two.includes('>Team 2 name</label>') && !two.includes('Team 3'));
    assert(two.includes('Add another team') && two.includes('All teams are 25-man.') && !two.includes('cg-team-remove'));
    const three = teamsFieldsHtml(true, ['Mon', 'Thu', 'Sun']);
    assert(three.includes('>Team 3 name</label>') && three.includes('data-action="cg-team-remove" data-index="2"') && three.includes('aria-label="Remove team 3"'));
    assert(!three.includes('data-index="0"') && !three.includes('data-index="1"'), 'only the third and later teams can be removed');
    assert(three.includes('value="Mon"') && three.includes('value="Sun"'), 'typed names are kept');
    const ten = teamsFieldsHtml(true, Array.from({ length: 10 }, (_, i) => 'T' + i));
    assert(!ten.includes('Add another team') && ten.includes('>Team 10 name</label>'), 'the add button goes away at 10 teams');
    assert(!teamsFieldsHtml(false, ['kept']).includes('Team 1 name'));
  });

  await check('create guild v2: client validation (realm, ruleset, team names: empty, long, duplicate)', () => {
    const { validate } = G.pages.create;
    const ok = { serverId: 's1', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ravens', multipleTeams: false };
    assert.deepEqual(plain(validate(ok)), {});
    assert.equal(validate(Object.assign({}, ok, { realm: '' })).realm, 'Enter your realm.');
    assert.equal(validate(Object.assign({}, ok, { gameVersion: 'forever', realm: '' })).realm, 'Pick a ruleset.');
    assert.equal(validate(Object.assign({}, ok, { realm: 'x'.repeat(65) })).realm, 'The realm name can be at most 64 characters.');
    const several = validate(Object.assign({}, ok, { multipleTeams: true, teamNames: ['Mon', 'mon', '', 'y'.repeat(41)] }));
    assert.deepEqual(Object.keys(several).sort(), ['teamNames:1', 'teamNames:2', 'teamNames:3']);
    assert.equal(several['teamNames:1'], 'Each team needs a different name.');
    assert.deepEqual(plain(validate(Object.assign({}, ok, { multipleTeams: true, teamNames: ['Mon', 'Thu'] }))), {});
  });

  await check('create guild v2: server-sent options and typed values are escaped', () => {
    const hostile = '<img src=x onerror=1>"\'&';
    const opts = { versions: [{ key: 'tbc', label: hostile }], regions: ['US'], realms: { tbc: { US: [{ name: hostile, slug: 's', type: hostile }] } }, rulesets: [hostile] };
    const out = G.pages.create.createHtml({ me: meData({ create: { allowed: true, stale: false, servers: CREATE_SERVERS, options: opts } }), timeZones: ['UTC'], defaultTimeZone: 'UTC' });
    assert(!out.includes('<img'), 'no raw tag from option data');
    G.pages.create.setOptions({ options: opts });
    assert(!G.pages.create.realmFieldsHtml('forever', 'US', {}).includes('<img'));
    assert(!G.pages.create.teamsFieldsHtml(true, [hostile, hostile + '2']).includes('<img'));
    G.pages.create.setOptions({ options: CREATE_OPTIONS });
  });

  await check('gameVersionLabel and realmLine: tbc / classic / forever labels; Forever shows "<Ruleset> ruleset"', () => {
    assert.equal(G.ui.gameVersionLabel('tbc'), 'TBC Anniversary');
    assert.equal(G.ui.gameVersionLabel('classic'), 'Classic Era');
    assert.equal(G.ui.gameVersionLabel('forever'), 'WoW Forever');
    assert.equal(G.ui.realmLine({ realm: 'Nightslayer', realmKind: 'realm' }), 'Nightslayer');
    assert.equal(G.ui.realmLine({ realm: 'PvP', realmKind: 'ruleset' }), 'PvP ruleset');
    const forever = guildData({}, { guild: { id: 'g1', name: 'Ravens', realm: 'Hardcore', realmKind: 'ruleset', realmSlug: null, region: 'EU', timeZone: 'UTC', gameVersion: 'forever', createdAt: NOW } });
    const out = G.shell.render({ me: meData(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: forever, teamId: 't1', collapsed: false }, '<p>x</p>');
    assert(out.includes('Hardcore ruleset') && out.includes('WoW Forever'));
  });

  await check('one-team guild: no team picker in the sidebar, drawer or phone header, and no team in the breadcrumb; a second team brings it back', () => {
    const oneTeam = [{ id: 't1', name: 'Main team', size: 25, archived: false, players: 0, leads: [] }, { id: 't9', name: 'Old', size: 25, archived: true, players: 0, leads: [] }];
    const route = { name: 'section', gid: 'g1', section: 'roster' };
    const render = teams => {
      const gd = guildData({}, { teams });
      return { out: G.shell.render({ me: meData(), route, guildData: gd, teamId: 't1', collapsed: false }, '<p>x</p>'), gd };
    };
    const single = render(oneTeam);
    assert(!single.out.includes('data-change="team-pick"') && !single.out.includes('gs-team-select'), 'no picker anywhere');
    assert(single.out.includes('class="gs-phone-guild"'), 'the phone header names the guild instead');
    assert.deepEqual(plain(G.shell.breadcrumbItems({ route, guildData: single.gd, teamId: 't1' })).map(c => c.label), ['Ravens', 'Roster']);
    const two = render(oneTeam.concat([{ id: 't2', name: 'Alts', size: 25, archived: false, players: 0, leads: [] }]));
    assert(two.out.includes('id="gs-team-select"') && two.out.includes('id="gs-team-select-drawer"') && two.out.includes('id="gs-team-select-phone"'));
    assert.deepEqual(plain(G.shell.breadcrumbItems({ route, guildData: two.gd, teamId: 't1' })).map(c => c.label), ['Ravens', 'Main team', 'Roster']);
  });

  await check('one-team guild: Team Lead shows without a team name in the roles dialog and the Roles column; two teams keep the names', () => {
    const one = [{ id: 't1', name: 'Main <team>', size: 25, archived: false, players: 0, leads: [] }, { id: 't9', name: 'Old', size: 25, archived: true, players: 0, leads: [] }];
    const e = entry(person('u9', 'Lead'), [{ role: 'team_lead', teamId: 't1' }], NOW);
    const dialog = G.pages.people.rolesDialogHtml(e, one, 'Ravens');
    assert(/name="teamLead"[^>]*><label[^>]*>Team Lead<\/label>/.test(dialog), 'single checkbox says Team Lead');
    assert(!dialog.includes('Team Lead: ') && !dialog.includes('Main &lt;team&gt;'));
    assert.deepEqual(plain(G.peopleSort.roleLabels(e.roles, one)).map(r => r.label), ['Team Lead']);
    assert(G.ui.roleChipsHtml(e.roles, one).includes('>Team Lead<'));
    assert(G.pages.people.rolesDialogHtml(e, TEAMS, 'Ravens').includes('Team Lead: Team A'), 'two active teams keep the names');
    assert.deepEqual(plain(G.peopleSort.roleLabels(e.roles, TEAMS)).map(r => r.label), ['Team Lead: Team A']);
  });

  // ── guild.html, guild.css, source hygiene ──────────────────────
  const jsDir = path.join(ROOT, 'js', 'guild');
  const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();
  // load.js and manifest.js are not shell scripts: the loader and the one list it injects (the other js/guild files are that list, exactly).
  const LOADER_FILES = ['load.js', 'manifest.js'];

  await check('guild script list: /js/util.js first, then exactly the scripts in js/guild/ besides the loader pair (none missing, none extra), app.js last', () => {
    assert.equal(scriptSrcs[0], '/js/util.js');
    const guildScripts = scriptSrcs.slice(1);
    assert(guildScripts.every(s => /^\/js\/guild\/[\w-]+\.js$/.test(s)), 'unexpected script path');
    assert.deepEqual([...guildScripts].sort(), jsFiles.filter(f => !LOADER_FILES.includes(f)).map(f => '/js/guild/' + f));
    assert.equal(new Set(guildScripts).size, guildScripts.length, 'duplicate script');
    assert.equal(scriptSrcs[scriptSrcs.length - 1], '/js/guild/app.js', 'app.js starts the shell, so it loads last');
    for (const s of scriptSrcs) assert(fs.existsSync(path.join(ROOT, s.replace(/^\//, ''))), s);
  });

  // Structural: the settings tabs are ONE array in shell.js (its order is the tab bar's order, a product decision). Adding a tab means adding it there and
  // in the router; nothing in the suites lists the tabs.
  await check('settings tabs: shell SETTINGS_TABS and router TABS name the same tabs, each is opened by Worker actions, and every action shows every tab in array order', async () => {
    const defs = G.shell.SETTINGS_TABS;
    const tabs = defs.map(def => def.tab);
    assert.equal(new Set(tabs).size, tabs.length, 'a tab is listed twice');
    assert.deepEqual([...tabs].sort(), plain(G.router.TABS).sort(), 'every route tab has a SETTINGS_TABS entry and every entry has a route');
    const { ACTIONS } = await import(pathToFileURL(path.join(ROOT, 'worker', 'permissions.js')).href);
    for (const def of defs) {
      assert(def.label && /^[A-Z]/.test(def.label), def.tab + ' has a label');
      // The Guild Master's tab is shown by role (export and delete are not an action a role can be given), so it names no action.
      if (def.guildMasterOnly) assert.deepEqual(plain(def.needs), [], def.tab + ' is shown by role, not by action');
      else assert(def.needs.length > 0, def.tab + ' needs at least one action');
      for (const action of def.needs) assert(ACTIONS.includes(action), `${def.tab} needs ${action}, which is not a Worker action`);
    }
    const everything = Object.fromEntries(ACTIONS.map(action => [action, 'guild']));
    const master = [{ role: 'guild_master' }];
    const shown = defs => plain(defs.map(def => ({ tab: def.tab, label: def.label })));
    const seen = list => plain(list.map(t => ({ tab: t.tab, label: t.label })));
    assert.deepEqual(seen(G.shell.settingsTabs(everything)), shown(defs.filter(def => !def.guildMasterOnly)), 'the Guild Master tab needs the role, whatever the actions');
    assert.deepEqual(seen(G.shell.settingsTabs(everything, [{ role: 'officer' }])), shown(defs.filter(def => !def.guildMasterOnly)));
    assert.deepEqual(seen(G.shell.settingsTabs(everything, master)), shown(defs), 'the Guild Master sees every tab, in array order');
    for (const def of defs) assert(G.shell.SETTINGS_GROUPS.includes(def.group) && def.purpose && /\.$/.test(def.purpose), def.tab + ' is in one of the five groups and has a one-line purpose');
    assert.deepEqual(plain(G.shell.settingsTabs({})), []);
    assert.deepEqual(plain(G.shell.settingsTabs({}, master).map(t => t.tab)), plain(defs.filter(def => def.guildMasterOnly).map(def => def.tab)));
    for (const tab of G.router.TABS) {
      const route = { name: 'settings', gid: 'g1', tab };
      assert.deepEqual(plain(G.router.parse(G.router.format(route))), route, tab + ' round-trips through the address');
    }
  });

  await check('guild.html is gone (the shell lives in index.html, faq.html and whats-new.html)', () => {
    assert(!fs.existsSync(path.join(ROOT, 'guild.html')));
  });

  await check('guild scripts: no module syntax and every file uses the one Guild namespace', () => {
    for (const f of jsFiles) {
      const text = read('js/guild/' + f);
      assert(!/^\s*(import|export)\s/m.test(text), f + ' uses modules');
      if (!LOADER_FILES.includes(f)) assert(/window\.Guild = window\.Guild \|\| \{\}/.test(text), f + ' namespace');
    }
  });

  await check('guild files: no non-ASCII characters outside comments (no Unicode symbols in strings or markup)', () => {
    const files = ['guild.css', ...jsFiles.map(f => 'js/guild/' + f)];
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;
        assert(!/[^\x00-\x7f]/.test(line), `${f}:${i + 1} has a non-ASCII character`);
      });
    }
  });

  await check('guild scripts: no inline style or on* attribute built into a template string', () => {
    for (const f of jsFiles) {
      read('js/guild/' + f).split('\n').forEach((line, i) => {
        assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(line), `${f}:${i + 1} inline style`);
        assert(!/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(line), `${f}:${i + 1} inline handler`);
        assert(!/setAttribute\(\s*['"`](?:style|on[a-z]+)['"`]/i.test(line), `${f}:${i + 1} setAttribute`);
      });
    }
  });

  await check('guild.css: every var(--x) is defined in app.css, with no fallback tricks and no new custom properties', () => {
    const defined = new Set([...appCss.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    for (const m of css.matchAll(/(--gs-out-[a-z_]+(?:-ink)?)\s*:/g)) defined.add(m[1]); // the attendance outcome colours are guild.css's own
    for (const m of css.matchAll(/(--gs-tone-[a-z]+(?:-bg)?)\s*:/g)) defined.add(m[1]); // so are the Raids tones (sign-up tags, tally, bars)
    for (const name of GuildCss.ownTokenNames(css)) defined.add(name); // and the design framework tokens (the first :root block) and a table row's --mark
    const used = [...css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)];
    assert(used.length > 50, 'expected the stylesheet to use the tokens');
    assert.deepEqual([...new Set(used.filter(m => !defined.has(m[1])).map(m => m[1]))], [], 'undefined tokens');
    // The only tokens guild.css owns are the design framework tokens (its first :root block), the attendance outcome colours (--gs-out-<outcome> and its -ink text colour),
    // the Raids tones (--gs-tone-<tone>, -bg and -edge) and a table row's --mark.
    const own = GuildCss.ownTokenNames(css);
    assert.deepEqual([...css.matchAll(/(^|[;{\s])(--[\w-]+)\s*:/g)].map(m => m[2]).filter(n => !own.has(n)), [], 'guild.css must not define custom properties');
  });

  await check('guild.css: dark flat design, phone breakpoint at 600px, visible focus ring, 44px touch targets', () => {
    assert(/@media \(max-width: 600px\)/.test(css));
    assert(/outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\)/.test(css) && /--focus-ring: 2px solid var\(--text-primary\)/.test(css));
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.gs-btn, \.gs-btn-sm \{ min-height: 44px; \}/.test(phone));
    assert(/\.gs-input, \.gs-input-search \{ height: 44px; \}/.test(phone));
    // The officer Home (round 4, user-approved mockup) has its own recipe with small radii; every other rule stays flat.
    const flatCss = css.slice(0, css.indexOf('Officer Home, round 4')) + css.slice(css.indexOf('Watch list: Reviewed'));
    const radii = [...flatCss.matchAll(/border-radius:\s*([^;]+);/g)].map(m => m[1].trim());
    assert(radii.length > 0 && radii.every(r => r === '0' || r === '50%'), 'only avatars are round: ' + radii.join(','));
    assert(!/prefers-color-scheme\s*:\s*light/.test(css));
  });

  await check('guild.css has a rule for every gs- class the markup builders use', () => {
    const markup = ['shell.js', 'ui.js', 'icons.js', 'pages-signin.js', 'pages-create.js', 'pages-settings-teams.js', 'pages-settings-people.js', 'pages-privacy.js', 'pages-roadmap.js', 'pages-roster.js', 'pages-person.js', 'pages-import.js', 'pages-loot.js', 'pages-person-loot.js', 'pages-raid-loot.js', 'pages-settings-loot.js', 'pages-raid-signups.js', 'pages-settings-schedule.js']
      .map(f => read('js/guild/' + f)).join('\n');
    const used = new Set();
    for (const m of markup.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
    }
    for (const m of markup.matchAll(/'(gs-[a-z0-9_-]+)(?: [^']*)?'/g)) used.add(m[1]);
    ['gs-chip-guild_master', 'gs-chip-officer', 'gs-chip-team_lead', 'gs-chip-member'].forEach(c => used.add(c)); // built from the role kind
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    const notClasses = ['gs-team-select-drawer', 'gs-team-select-phone', 'gs-page-alert']; // element ids passed as plain strings
    const baseStyled = ['gs-chip-officer', 'gs-chip-team_lead']; // look like the base .gs-chip
    const missing = [...used].filter(c => !defined.has(c) && !notClasses.includes(c) && !baseStyled.includes(c));
    assert.deepEqual(missing, [], 'classes with no CSS');
  });

  // ── Fix round 1 ──────────────────────────────────────────────
  const CLAIMABLE = [{ guildId: 'g9', guildName: 'Night Owls', serverId: 's9', serverName: 'Owl Roost' }];
  const claimMe = extra => meData({ create: { allowed: true, stale: false, servers: [], claimable: CLAIMABLE }, ...(extra || {}) });
  const createFor = me => G.pages.create.createHtml({ me, timeZones: ['UTC'], defaultTimeZone: 'UTC' });

  await check('claim: Create guild lists each claimable guild with its server and a two-step Claim', () => {
    const out = createFor(claimMe());
    assert(out.includes('Guilds without a Guild Master'));
    assert(out.includes('Night Owls') && out.includes('Owl Roost'));
    assert(/data-action="claim-ask"[^>]*><span>Claim<\/span>/.test(out), 'Claim button');
    // step 2 is hidden until Claim is pressed, and says what happens
    assert(/id="claim-confirm-0"[^>]*hidden/.test(out), 'confirm starts hidden');
    assert(out.includes('You become Guild Master of Night Owls.'));
    assert(out.includes('data-action="claim-go"') && out.includes('data-gid="g9"') && out.includes('data-action="claim-cancel"'));
    assert(out.indexOf('Guilds without a Guild Master') < out.indexOf('data-submit="create-guild"'), 'claim section sits above the form');
  });

  await check('claim: nothing is listed when claimable is empty or absent', () => {
    for (const create of [{ allowed: true, stale: false, servers: [] }, { allowed: true, stale: false, servers: [], claimable: [] }]) {
      assert(!createFor(meData({ create })).includes('Guilds without a Guild Master'));
    }
  });

  await check('claim: guild and server names are escaped everywhere they appear', () => {
    const hostile = [{ guildId: 'g"><img src=x onerror=1>', guildName: HOSTILE + QUOTES, serverId: 's', serverName: HOSTILE + QUOTES }];
    const out = createFor(meData({ create: { allowed: true, stale: false, servers: [], claimable: hostile } }));
    assertEscaped(out, 'claim');
    assert(out.includes('Guilds without a Guild Master'));
  });

  await check('claim: the claim button is wired to POST /api/guild/:gid/claim with an empty JSON body, then opens People and roles', () => {
    const src = read('js/guild/pages-create.js');
    assert(/G\.handlers\.click\['claim-go'\]/.test(src) && /G\.handlers\.click\['claim-ask'\]/.test(src) && /G\.handlers\.click\['claim-cancel'\]/.test(src));
    assert(/G\.api\.post\('\/api\/guild\/' \+ encodeURIComponent\(gid\) \+ '\/claim', \{\}\)/.test(src));
    assert(/afterGuildClaimed/.test(src));
    const app = read('js/guild/app.js');
    assert(/app\.afterGuildClaimed = function \(res, guildName\)[\s\S]*?afterGuildCreated\(res,/.test(app));
    // afterGuildCreated lands on People and roles
    assert(/tab: 'people'/.test(app.slice(app.indexOf('app.afterGuildCreated'))));
  });

  await check('claim: the No guild page links to Create guild only when something is claimable', () => {
    const withClaim = G.pages.signin.noGuildHtml(claimMe());
    assert(withClaim.includes('A guild on one of your servers has no Guild Master. You can claim it.'));
    assert(/<a href="#\/new">A guild on one of your servers/.test(withClaim));
    const without = G.pages.signin.noGuildHtml(meData({ create: { allowed: true, stale: false, servers: [], claimable: [] } }));
    assert(!without.includes('no Guild Master'));
    assert(!G.pages.signin.noGuildHtml(meData()).includes('no Guild Master'));
  });

  await check('removedFrom: the No guild page says who removed access and drops the "no guild on your servers" claim', () => {
    const me = meData({ guilds: [], removedFrom: [{ id: 'g1', name: 'Ravens' }, { id: 'g2', name: 'Owls' }] });
    const out = G.pages.signin.noGuildHtml(me);
    assert(out.includes('An officer removed your access to <strong>Ravens</strong> and <strong>Owls</strong>.'));
    assert(!out.includes('None of your Discord servers has a guild on Raidsmith'));
    assert(out.indexOf('An officer removed') < out.indexOf('Ask an officer to restore your access'), 'removal note sits above the lead');
    // without removals the usual text stays
    const plainOut = G.pages.signin.noGuildHtml(meData({ guilds: [] }));
    assert(plainOut.includes('None of your Discord servers has a guild on Raidsmith'));
    assert(!plainOut.includes('An officer removed'));
    assertEscaped(G.pages.signin.noGuildHtml(meData({ guilds: [], removedFrom: [{ id: 'x', name: HOSTILE + QUOTES }] })), 'removedFrom');
  });

  await check('autoPromote: Delete my data names who becomes Guild Master, or says the guild will have none', () => {
    const impact = { handOverFirst: [], guildsDeleted: [], autoPromote: [
      { id: 'g1', name: 'Ravens', to: person('u2', 'Brightmane') },
      { id: 'g2', name: 'Owls', to: null },
    ] };
    const out = G.pages.privacy.deleteBoxHtml(impact, '');
    assert(out.includes('<strong>Brightmane</strong> becomes Guild Master of <strong>Ravens</strong>.'));
    assert(out.includes('<strong>Owls</strong> will have no Guild Master until an admin of its Discord server claims it.'));
    // both lines live inside the confirm group
    const confirm = out.slice(out.indexOf('id="delete-confirm"'));
    assert(confirm.includes('becomes Guild Master of') && confirm.includes('will have no Guild Master'));
    const none = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [] }, '');
    assert(!none.includes('becomes Guild Master') && !none.includes('will have no Guild Master'));
    assert(!G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [], autoPromote: [] }, '').includes('delete-autopromote'));
  });

  await check('autoPromote: names are escaped', () => {
    const impact = { handOverFirst: [], guildsDeleted: [], autoPromote: [{ id: 'g1', name: HOSTILE + QUOTES, to: person('u2', HOSTILE + QUOTES) }, { id: 'g2', name: HOSTILE, to: null }] };
    assertEscaped(G.pages.privacy.deleteBoxHtml(impact, ''), 'autoPromote');
  });

  // A tiny fake document: enough for closeOverlays.
  function fakeDoc(dialogs, menu, toggle) {
    return {
      querySelectorAll: sel => (sel === '#shell-drawer dialog[open], #guild-dialogs dialog[open]' ? dialogs : []),
      getElementById: id => (id === 'gs-account-menu' ? menu : null),
      querySelector: sel => (sel === '[data-action="toggle-menu"]' ? toggle : null),
    };
  }

  await check('route change: closeOverlays closes every open dialog (drawer included) and the avatar menu', () => {
    const closed = [];
    const dlg = name => ({ open: true, close() { closed.push(name); this.open = false; } });
    const attrs = {};
    const menu = { hidden: false };
    const toggle = { setAttribute: (k, v) => { attrs[k] = v; } };
    G.app.closeOverlays(fakeDoc([dlg('edit-roles'), dlg('gs-drawer')], menu, toggle));
    assert.deepEqual(closed, ['edit-roles', 'gs-drawer']);
    assert.equal(menu.hidden, true);
    assert.equal(attrs['aria-expanded'], 'false');
    // nothing open: nothing happens
    G.app.closeOverlays(fakeDoc([], { hidden: true }, toggle));
  });

  await check('route change: the guild route calls closeOverlays before it loads anything', () => {
    const app = read('js/guild/app.js');
    const body = app.slice(app.indexOf('  function routeGuild() {'));
    assert(body.indexOf('closeOverlays()') > 0 && body.indexOf('closeOverlays()') < body.indexOf('state.loaded ?'));
  });

  await check('conflict: handleError reloads the page data and shows the server message', () => {
    const app = read('js/guild/app.js');
    assert(/err\.code === 'conflict'\) \{ app\.reloadAfterConflict\(c\.text\)/.test(app));
    const reload = app.slice(app.indexOf('app.reloadAfterConflict'), app.indexOf('app.refreshGuild'));
    assert(/loadMe\(\)/.test(reload) && /fetchGuild\(r\.gid\)/.test(reload) && /\/people'/.test(reload));
    assert(/state\.pageAlert = text;[\s\S]*render\(\)/.test(reload));
    // dialogs close first so the message is visible on the reloaded page
    for (const f of ['pages-settings-people.js', 'pages-settings-teams.js']) {
      assert(/err\.code === 'conflict'\) \{ G\.ui\.closeDialogOf\(form\); G\.app\.handleError\(err\); return; \}/.test(read('js/guild/' + f)), f);
    }
    // the Create guild page shows the alert (claim conflicts land here)
    assert(G.pages.create.createHtml({ me: claimMe(), timeZones: ['UTC'], defaultTimeZone: 'UTC', alert: 'Someone claimed it first.' }).includes('Someone claimed it first.'));
  });

  await check('A2 phone header: menu button first, then the team picker; avatar menu; More is the last tab; the drawer opens from the menu button', () => {
    const out = shellHtml(ALL_CAN);
    const header = out.slice(out.indexOf('<header class="gs-topbar">'), out.indexOf('</header>'));
    assert(header.indexOf('data-action="open-drawer"') >= 0 && header.includes('aria-label="Open menu"') && header.includes('aria-controls="gs-drawer"'), 'menu button');
    assert(header.indexOf('data-action="open-drawer"') < header.indexOf('id="gs-team-select-phone"'), 'the button leads');
    assert(header.includes('id="gs-team-select-phone"') && header.includes('data-change="team-pick"'), 'team picker');
    assert(header.includes('data-action="toggle-menu"'), 'avatar menu');
    assert(!header.includes('gs-phone-brand'), 'the logo no longer sits in the phone header');
    assert(!read('guild.css').includes('gs-phone-brand') && !read('guild.css').includes('gs-public-head'));
    const tabs = out.slice(out.indexOf('<nav class="gs-tabs"'), out.indexOf('</nav>', out.indexOf('<nav class="gs-tabs"')));
    assert(tabs.includes('data-action="open-drawer"') && tabs.includes('aria-controls="gs-drawer"') && tabs.includes('>More<'), 'the last tab is More: it opens the same drawer as the menu button');
    // a guild without an active team shows its name instead of a picker
    const gd = guildData(ALL_CAN, { teams: [] });
    const bare = G.shell.render({ me: meData(), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd, teamId: null, collapsed: false }, '');
    assert(/<div class="gs-phone-pick"><span class="gs-phone-guild">Ravens<\/span>/.test(bare));
  });

  await check('Teams phone cards: one card per active team with the same actions, hidden table on phones', () => {
    const out = G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.teams': 'guild' }) });
    const cards = out.slice(out.indexOf('<ul class="gs-team-cards"'), out.indexOf('</ul>', out.indexOf('<ul class="gs-team-cards"')));
    assert.equal((cards.match(/<li class="gs-team-card">/g) || []).length, 2, 'two active teams');
    assert(cards.includes('Team A') && cards.includes('25-man - 0 players') && cards.includes('Mistvale') && cards.includes('No team lead'));
    assert(cards.includes('data-action="team-rename"') && cards.includes('data-action="team-archive"'));
    assert(!cards.includes('Old Team'), 'archived teams stay in their own list');
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.gs-people-table, \.gs-teams-table \{ display: none; \}/.test(phone));
    assert(/\.gs-team-cards \{ display: flex;/.test(phone));
    assert(/\.gs-team-cards \{ display: none; \}/.test(css.slice(0, css.indexOf('@media (max-width: 600px)'))), 'cards start hidden');
    const readOnly = G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.access': 'guild' }) });
    assert(!readOnly.slice(readOnly.indexOf('gs-team-cards')).includes('team-rename'));
    assertEscaped(G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.teams': 'guild' }, { teams: [{ id: 't"x', name: HOSTILE + QUOTES, size: 25, archived: false, players: 1, leads: [] }] }) }), 'team card');
  });

  await check('autoPromote items are plain wrapped sentences (non-flex list); archived teams use the same card layout on phones', () => {
    const out = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [], autoPromote: [{ id: 'g1', name: 'Ravens', to: null }] }, '');
    assert(out.includes('<ul class="gs-sentences" id="delete-autopromote">') && !out.includes('gs-bullets'));
    assert(/\.gs-sentences li \{ display: block;/.test(css));
    const t = G.pages.teams.teamsHtml({ guildData: guildData({ 'guild.teams': 'guild' }) });
    assert(t.includes('Old Team</span><span class="gs-muted">25-man - 0 players</span><a class="gs-btn gs-btn-sm" href="#/g/g1/roster?team=t3" aria-label="Open roster of Old Team">Open roster</a><button'));
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.gs-archived-item, \.gs-archived-item \+ \.gs-archived-item \{ box-sizing: border-box; flex-direction: column;/.test(phone));
    assert(/\.gs-archived-wrap \{ padding: 0;/.test(phone));
  });

  await check('O1: a viewer who can claim the guild they are viewing sees a claim notice on its pages and settings', () => {
    const me = meData({ create: { allowed: true, stale: false, servers: [], claimable: [{ guildId: 'g1', guildName: 'Ravens', serverId: 's', serverName: 'S' }] } });
    const gd = guildData(ALL_CAN);
    const roster = G.shell.render({ me, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd, teamId: 't1', collapsed: false }, '<p>main</p>');
    const settings = G.shell.render({ me, route: { name: 'settings', gid: 'g1', tab: 'teams' }, guildData: gd, teamId: 't1', collapsed: false }, '<p>main</p>');
    for (const out of [roster, settings]) {
      assert(out.indexOf('This guild has no Guild Master. You can claim it.') > out.indexOf('</header>') && out.indexOf('This guild has no Guild Master') < out.indexOf('<main'), 'notice sits in the banner slot, above the page');
      assert(out.includes('href="#/new"'));
    }
    assert(!shellHtml(ALL_CAN).includes('This guild has no Guild Master'), 'not claimable: no notice');
    const other = meData({ create: { allowed: true, stale: false, servers: [], claimable: [{ guildId: 'g9', guildName: 'X', serverId: 's', serverName: 'S' }] } });
    assert(!G.shell.render({ me: other, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd, teamId: 't1', collapsed: false }, '').includes('This guild has no Guild Master'), 'other guild: no notice');
    assertEscaped(G.shell.render({ me: meData({ create: { allowed: true, claimable: [{ guildId: HOSTILE }] } }), route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd, teamId: 't1', collapsed: false }, ''), 'claim notice');
  });

  await check('O2: Make Guild Master step 2 hides the roles-form Cancel/Save footer and Cancel restores it', () => {
    const entry0 = entry(person('u2', 'Brightmane'), [{ role: 'officer' }], NOW, { actions: { editRoles: true, makeGuildMaster: true, removeAccess: true } });
    const out = G.pages.people.rolesDialogHtml(entry0, TEAMS, 'Ravens');
    assert(out.includes('id="dlg-roles-footer"'));
    const src = read('js/guild/pages-settings-people.js');
    const ask = src.slice(src.indexOf("click['gm-ask']"), src.indexOf("click['gm-cancel']"));
    const cancel = src.slice(src.indexOf("click['gm-cancel']"), src.indexOf("click['gm-confirm']"));
    assert(/dlg-roles-footer[\s\S]*footer\.hidden = true/.test(ask));
    assert(/dlg-roles-footer[\s\S]*footer\.hidden = false/.test(cancel));
    assert(/\.gs-dialog-actions\[hidden\] \{ display: none; \}/.test(css));
  });

  await check('B4: Make Guild Master step 2 is one dialog-footer row', () => {
    const entry0 = entry(person('u2', 'Brightmane'), [{ role: 'officer' }], NOW, { actions: { editRoles: true, makeGuildMaster: true, removeAccess: true } });
    const out = G.pages.people.rolesDialogHtml(entry0, TEAMS, 'Ravens');
    const confirm = out.slice(out.indexOf('id="dlg-gm-confirm"'));
    assert(/<div class="gs-dialog-actions"><button[^>]*data-action="gm-cancel">Cancel<\/button><button[^>]*data-action="gm-confirm">Make Guild Master<\/button><\/div>/.test(confirm));
    assert(/\.gs-gm \.gs-dialog-actions \{ flex-wrap: nowrap; \}/.test(css));
  });

  await check('B5: People rows show the Discord username as muted text when it differs from the display name', () => {
    const different = entry(person('u7', 'Fancy Name', { username: 'plainuser' }), [], NOW);
    const same = entry(person('u8', 'Same', { username: 'Same' }), [], NOW);
    const out = G.pages.people.tableHtml({ people: [different, same], teams: TEAMS, sort: { column: 'person', dir: 'asc' }, query: '', now: NOW });
    assert(out.includes('<span class="gs-person-user">@plainuser</span>'));
    assert.equal((out.match(/gs-person-user">/g) || []).length, 2, 'table and card, not for the matching name');
    assertEscaped(G.pages.people.tableHtml({ people: [entry(person('u9', 'X', { username: HOSTILE + QUOTES }), [], NOW)], teams: TEAMS, sort: { column: 'person', dir: 'asc' }, query: '', now: NOW }), 'username');
  });

  await check('B7: the YOU badge sits inline beside the name', () => {
    const out = G.pages.people.tableHtml({ people: PEOPLE, teams: TEAMS, sort: { column: 'person', dir: 'asc' }, query: '', now: NOW });
    assert(out.includes('<span class="gs-person-line"><span class="gs-person-name">Thornvald</span><span class="gs-you">you</span></span>'));
    assert(/\.gs-person-line \{ display: flex; flex-wrap: wrap; align-items: center;/.test(css));
  });

  await check('B6: phone avatar menu items and the drawer close button are 44 px', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    assert(/\.gs-menu-item \{ height: 44px; \}/.test(phone));
    assert(/\.gs-drawer-top \.gs-icon-btn \{ width: 44px; height: 44px; \}/.test(css));
  });

  await check('csp-tests.js scans the three pages that carry the shell (guild.html is gone)', () => {
    assert(/\['index\.html', 'faq\.html', 'whats-new\.html'\]/.test(read('csp-tests.js')));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
