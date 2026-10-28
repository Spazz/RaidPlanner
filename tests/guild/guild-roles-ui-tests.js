/**
 * Raidsmith guild UI, Phase 7 (roles, Discord role mapping, guest links, public page) - tests for the pages, the shell, the router and app.js
 * Run: node tests/guild/guild-roles-ui-tests.js
 *
 * Same approach as guild-accounts-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm sandbox with no DOM, the
 * render functions return HTML strings, and handlers that talk to the API run against a stubbed G.api (the base get / post / put / del, so the
 * G.api.roles / discord / guests / publicPage wrappers are exercised too). The routes through the real app.js (guest and public pages that need no
 * sign-in, the new Guild settings tabs, the People tab) run against fake documents at the end. The Worker side is in guild-roles-worker-tests.js,
 * and guild-roles-contract-tests.js joins the two.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const { GUILD_SCRIPTS, guildScriptsOf } = require('../guild-scripts');
const css = (read('planner-forge.css') + '\n' + read('guild.css'));
const NEW_FILES = ['pages-settings-roles', 'pages-settings-discord', 'pages-settings-public', 'pages-view'];

function loadGuild(extra) {
  const sandbox = Object.assign({ console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout }, extra || {});
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const fields = {};
ctx.document = { getElementById: id => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

// ---------------------------------------------------------------------------
// fixtures (the Worker's response shapes)

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 17, 12);
const TOKEN = 'A'.repeat(20) + '-_' + 'b'.repeat(21);
const person = (id, displayName, extra) => Object.assign({ id, username: displayName.toLowerCase().split(' ')[0], displayName, avatarUrl: null, initials: displayName.slice(0, 2).toUpperCase() }, extra || {});
const TEAMS = [{ id: 't1', name: 'Alpha', size: 25, archived: false }, { id: 't2', name: 'Bravo', size: 25, archived: false }, { id: 't3', name: 'Old', size: 25, archived: true }];
function guildData(can, extra) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', realmSlug: 'dreamscythe', region: 'US', timeZone: 'UTC', gameVersion: 'tbc', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({ players: 0, leads: [] }, t)),
    me: { roles: [{ role: 'officer' }], can: can || { 'guild.roles': 'guild', 'guild.access': 'guild' } },
    rosterOptions: null,
  }, extra || {});
}

const act = (action, label, group, scopes, extra) => Object.assign({ action, label, group, scopes, view: false, staff: false }, extra || {});
const ACTIONS = [
  act('roster.view', 'See the roster', 'Roster', ['guild'], { view: true }),
  act('roster.edit', 'Edit the roster', 'Roster', ['guild', 'team']),
  act('raids.view', 'See raids', 'Raids', ['guild'], { view: true }),
  act('raids.edit', 'Create and edit raids', 'Raids', ['guild', 'team']),
  act('attendance.view', 'See attendance', 'Attendance', ['guild', 'team', 'own_teams'], { view: true }),
  act('loot.view', 'See loot', 'Loot', ['guild', 'team', 'own_teams'], { view: true }),
  act('guild.teams', 'Manage teams', 'Guild settings', ['guild']),
  act('guild.roles', 'Manage roles, Discord mapping and the public page', 'Guild settings', ['guild'], { staff: true }),
  act('guild.access', 'Remove access, sync Discord roles, guest links', 'Guild settings', ['guild'], { staff: true }),
];
// What the Worker computes per role (permissionProblem): the test restates the rules only to build data.
function allowedFor(roleId, custom) {
  const out = {};
  for (const a of ACTIONS) {
    out[a.action] = a.scopes.filter(s => {
      if (a.staff && (custom || ['team_lead', 'member', 'guest', 'public'].includes(roleId))) return false;
      if (['guest', 'public'].includes(roleId) && !a.view) return false;
      if (roleId === 'public' && s !== 'guild') return false;
      if (roleId === 'guest' && s === 'own_teams') return false;
      return true;
    });
  }
  return out;
}
function role(id, name, kind, extra) {
  const custom = kind === 'custom';
  return Object.assign({
    id, name, kind, fixed: false, customized: false, assignable: custom || id === 'officer' || id === 'team_lead', note: custom ? null : 'Built-in help for ' + name,
    needsTeam: false, permissions: {}, allowed: id === 'guild_master' ? {} : allowedFor(id, custom), holders: 0, mapped: 0, links: 0,
  }, extra || {});
}
function rolesData(extra) {
  return Object.assign({
    actions: ACTIONS,
    roles: [
      role('guild_master', 'Guild Master', 'builtin', { fixed: true, note: 'Always holds every action. This role cannot be changed.' }),
      role('officer', 'Officer', 'builtin', { permissions: { 'roster.view': 'guild', 'roster.edit': 'guild', 'guild.roles': 'guild', 'guild.access': 'guild' }, holders: 2, mapped: 1 }),
      role('team_lead', 'Team Lead', 'builtin', { needsTeam: true, permissions: { 'roster.edit': 'team' }, customized: true }),
      role('member', 'Member', 'builtin', { permissions: { 'roster.view': 'guild', 'attendance.view': 'own_teams' } }),
      role('guest', 'Guest', 'builtin', { permissions: { 'roster.view': 'guild', 'raids.view': 'guild' }, links: 2 }),
      role('public', 'Public', 'builtin', { permissions: { 'roster.view': 'guild' } }),
      role('cr_raid', 'Raid leader', 'custom', { needsTeam: true, permissions: { 'raids.edit': 'team', 'roster.view': 'guild' }, holders: 3, mapped: 2, links: 1 }),
      role('cr_loot', 'Loot council', 'custom', { permissions: { 'loot.view': 'guild' } }),
    ],
    limits: { customRoles: 20, nameLength: 32 },
    canEditBuiltin: true,
  }, extra || {});
}
function discordData(botExtra, extra) {
  return Object.assign({
    bot: Object.assign({ configured: true, inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1&scope=bot&permissions=0', inServer: true, problem: null }, botExtra || {}),
    roles: [
      { id: '700000000000000001', name: 'Officers', color: '#ff0000', position: 9, managed: false },
      { id: '700000000000000002', name: 'Raid leaders', color: null, position: 7, managed: false },
      { id: '700000000000000003', name: 'Loot team', color: null, position: 5, managed: false },
    ],
    maps: [{ discordRoleId: '700000000000000001', roleId: 'officer', teamId: null }, { discordRoleId: '700000000000000002', roleId: 'team_lead', teamId: 't1' }],
    targets: [{ roleId: 'officer', name: 'Officer', needsTeam: false, custom: false }, { roleId: 'team_lead', name: 'Team Lead', needsTeam: true, custom: false }, { roleId: 'cr_loot', name: 'Loot council', needsTeam: false, custom: true }],
  }, extra || {});
}
function publicData(extra) {
  return Object.assign({ enabled: true, sections: ['roster', 'raids'], allowed: { roster: true, raids: true, attendance: false, loot: true }, path: '/#/public/g1' }, extra || {});
}
function viewData(kind, extra) {
  return Object.assign({
    viewer: kind === 'guest' ? { kind: 'guest', role: { id: 'guest', name: 'Guest' }, team: { id: 't1', name: 'Alpha' }, expiresAt: T0 + 3 * DAY } : { kind: 'public' },
    guild: { name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc' },
    teams: [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }],
    sections: {
      roster: [{ team: { id: 't1', name: 'Alpha' }, people: [{ name: 'Thoren', class: 'PALADIN', role: 'tank' }, { name: 'Kaelith', class: 'ROGUE', role: 'dps' }, { name: 'Odd', class: 'MAGE', role: null }] },
        { team: { id: 't2', name: 'Bravo' }, people: [] }],
      raids: [{ team: { id: 't1', name: 'Alpha' }, upcoming: [{ raidOn: '2026-10-20', startsAt: T0 + 3 * DAY, zone: 'Karazhan', title: 'Gruul night' }], recent: [{ raidOn: '2026-10-10', startsAt: T0 - 7 * DAY, zone: "Gruul's Lair", title: null }] }],
      attendance: [{ team: { id: 't1', name: 'Alpha' }, window: 8, raids: 14, people: [{ name: 'Thoren', class: 'PALADIN', pct: 92.5, counted: 12 }, { name: 'Kaelith', class: 'ROGUE', pct: null, counted: 0 }] },
        { team: { id: 't2', name: 'Bravo' }, window: 'all', raids: 3, people: [] }],
      loot: [{ team: { id: 't1', name: 'Alpha' }, awards: [{ itemId: 30001, itemName: 'Sword of Doom', quality: 4, awardedAt: T0 - DAY, winner: 'Thoren', winnerClass: 'PALADIN', disenchanted: false },
        { itemId: 30002, itemName: 'Grey thing', quality: 9, awardedAt: T0 - 2 * DAY, winner: null, winnerClass: null, disenchanted: true }] }],
    },
  }, extra || {});
}

// Pass-through of the shapes the Worker sends for People: roles with names, Discord-only roles, the discord block, actions.
function entry(id, name, roles, actions, extra) {
  return Object.assign({ person: person(id, name), roles: roles || [], roster: null, lastSeenAt: T0 - DAY, isMe: false, actions: Object.assign({ editRoles: true, removeAccess: true }, actions || {}) }, extra || {});
}
function peopleData(extra) {
  return Object.assign({ people: [entry('u2', 'Bob B', [{ role: 'officer' }], { syncDiscord: true }), entry('u3', 'Dave D', [], {})], removed: [], signedInCount: 2, discord: { configured: true, mapped: 2 } }, extra || {});
}

// API stubs: replace the base methods (so the wrappers run), restore afterwards. G.app.go is captured; G.ui.openDialog records the dialogs.
function withApi(stubs, fn, extra) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go, savedRender = G.app.render, savedRefresh = G.app.refreshGuild, savedOpen = G.ui.openDialog;
  const hashes = [];
  const opened = [];
  let renders = 0;
  const refreshed = [];
  G.app.go = h => hashes.push(h);
  G.app.render = () => { renders++; };
  G.app.refreshGuild = gid => { refreshed.push(gid); return Promise.resolve(); };
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return { open: true }; };
  const probe = { hashes, opened, refreshed, renders: () => renders };
  return Promise.resolve(fn(probe)).finally(() => {
    for (const k of Object.keys(saved)) G.api[k] = saved[k];
    G.app.go = savedGo; G.app.render = savedRender; G.app.refreshGuild = savedRefresh; G.ui.openDialog = savedOpen;
  });
}
// A fake form: the attributes, the named elements, and the lists a handler reads with querySelectorAll.
function formEl(attrs, elements, lists, queries) {
  const closed = { n: 0 };
  return {
    closed,
    getAttribute: k => (attrs || {})[k],
    elements: elements || {},
    querySelectorAll: sel => ((lists || {})[sel] || []),
    querySelector: sel => ((queries || {})[sel] || null),
    closest: () => null,
    disabled: false,
  };
}
const el = attrs => ({ disabled: false, hidden: false, getAttribute: k => (attrs || {})[k], closest: () => null, focus() {}, select() {} });
const sel = (value, attrs) => Object.assign(el(attrs), { value });
const box = (checked, attrs) => Object.assign(el(attrs), { checked, value: (attrs || {}).value });
function field(id) { fields[id] = { textContent: '', hidden: true }; return fields[id]; }
function clearFields() { for (const k of Object.keys(fields)) delete fields[k]; }
const okRes = body => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));

(async () => {
  // =========================================================================
  // router
  await check('router: guest, view and public parse and format back; the token must be 43 URL-safe characters; settings knows the four new tabs', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/guest/' + TOKEN), { name: 'guest', token: TOKEN });
    assert.deepEqual(p('#/view'), { name: 'view' });
    assert.deepEqual(p('#/public/g_abc123'), { name: 'public', gid: 'g_abc123' });
    assert.equal(G.router.format({ name: 'view' }), '#/view');
    assert.equal(G.router.format({ name: 'guest', token: TOKEN }), '#/guest/' + TOKEN);
    assert.equal(G.router.format({ name: 'public', gid: 'g_abc123' }), '#/public/g_abc123');
    for (const r of [{ name: 'view' }, { name: 'guest', token: TOKEN }, { name: 'public', gid: 'g_abc123' }]) assert.deepEqual(p(G.router.format(r)), r);
    for (const bad of ['#/guest', '#/guest/', '#/guest/' + TOKEN.slice(1), '#/guest/' + TOKEN + 'x', '#/guest/' + 'A'.repeat(42) + '!', '#/guest/' + 'A'.repeat(42) + '%20', '#/guest/' + TOKEN + '/x',
      '#/view/x', '#/public', '#/public/', '#/public/g1/x', '#/public/a b', '#/public/' + 'x'.repeat(65)]) {
      assert.equal(p(bad).name, 'notfound', bad);
    }
    assert.deepEqual(p('#/guest/' + TOKEN + '?utm=1'), { name: 'guest', token: TOKEN }, 'a query is ignored');
    assert.equal(G.router.format({ name: 'guest', token: 'short' }), '#/', 'a token that is not valid never reaches the address');
    assert.equal(G.router.format({ name: 'public', gid: '' }), '#/');
    for (const tab of ['roles', 'discord', 'links', 'public']) {
      assert.deepEqual(p('#/g/g1/settings/' + tab), { name: 'settings', gid: 'g1', tab });
      assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab }), '#/g/g1/settings/' + tab);
    }
    assert.equal(p('#/g/g1/settings/role').name, 'notfound');
    assert.equal(G.router.isViewerRoute({ name: 'guest' }) && G.router.isViewerRoute({ name: 'view' }) && G.router.isViewerRoute({ name: 'public' }), true);
    assert.equal(G.router.isViewerRoute({ name: 'settings' }) || G.router.isViewerRoute(null) || G.router.isViewerRoute({ name: 'home' }), false);
  });

  // =========================================================================
  // shell
  await check('shell: the settings tabs follow guild.roles (Roles, Discord roles, Public page) and guild.access (Guest links), in this order', () => {
    const tabs = can => plain(G.shell.settingsTabs(can).map(t => t.tab));
    const labels = can => plain(G.shell.settingsTabs(can).map(t => t.label));
    assert.deepEqual(tabs({ 'guild.roles': 'guild' }), ['people', 'roles', 'discord', 'public']);
    assert.deepEqual(tabs({ 'guild.access': 'guild' }), ['people', 'links']);
    assert.deepEqual(tabs({ 'guild.roles': 'guild', 'guild.access': 'guild' }), ['people', 'roles', 'discord', 'links', 'public']);
    assert.deepEqual(tabs({ 'guild.roles': [] , 'guild.access': [] }), [], 'an empty team list is no permission');
    assert.deepEqual(tabs({}), []);
    assert.deepEqual(labels({ 'guild.roles': 'guild' }), ['Accounts', 'Roles', 'Discord roles', 'Public page']);
    assert.deepEqual(labels({ 'guild.access': 'guild' }), ['Accounts', 'Links and keys']);
    assert.equal(G.shell.canSeeSettings({ 'guild.roles': 'guild' }), true);
    const frame = G.shell.settingsFrameHtml({ guildData: guildData() }, 'links', '<p>x</p>');
    assert(/aria-current="page">Links and keys/.test(frame) && frame.includes('href="#/g/g1/settings/links"') && frame.includes('href="#/g/g1/settings/public"') && !frame.includes('settings/guests') && !frame.includes('settings/dataaccess'));
  });

  await check('shell: guest, view and public routes get their own breadcrumb (before the Sign in one), no guild nav and no rail; slots do not break signed out or in', () => {
    const crumbs = (route, extra) => plain(G.shell.breadcrumbItems(Object.assign({ section: 'guild', page: 'app', me: null, signedOut: true, route, guildData: null }, extra)).map(c => c.label));
    assert.deepEqual(crumbs({ name: 'guest', token: TOKEN }), ['Guest view']);
    assert.deepEqual(crumbs({ name: 'view' }), ['Guest view']);
    assert.deepEqual(crumbs({ name: 'public', gid: 'g1' }), ['Public page']);
    assert.deepEqual(crumbs({ name: 'home' }), ['Sign in'], 'every other signed-out route still says Sign in');
    for (const signedIn of [false, true]) {
      for (const route of [{ name: 'guest', token: TOKEN }, { name: 'view' }, { name: 'public', gid: 'g1' }]) {
        const me = signedIn ? { user: person('u1', 'Gale G'), guilds: [{ id: 'g1', name: 'Ember' }], create: { allowed: true } } : null;
        const s = G.shell.slots({ section: 'guild', page: 'app', me, signedOut: !signedIn, route, guildData: null, teamId: null });
        assert.equal(s.rail, '', 'no rail for a viewer page');
        assert.equal(s.tabs, '');
        assert(!s.sidebar.includes('>Roster<') && !s.sidebar.includes('Guild settings') && !s.sidebar.includes('gs-side-head'), 'no guild items in the sidebar');
        assert(!s.drawer.includes('gs-tile'), 'no guild tiles in the drawer');
        assert(s.lead.includes(route.name === 'public' ? 'Public page' : 'Guest view'));
        assert(signedIn ? s.account.includes('gs-avatar-btn') : s.account.includes('Sign in'));
        assertNoRawAttrs(s.lead + s.account + s.sidebar + s.drawer);
      }
    }
    const member = { user: person('u1', 'Gale G'), guilds: [{ id: 'g1', name: 'Ember' }], create: { allowed: false } };
    assert(G.shell.slots({ section: 'guild', page: 'app', me: member, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: guildData(), teamId: 't1' }).rail.includes('gs-tile'), 'a guild page keeps its rail');
  });

  // =========================================================================
  // people-sort
  await check('people-sort: custom roles show their name (with the team), Discord-only roles end in (Discord), custom ranks between Team Lead and Member; plain roles are unchanged', () => {
    const labels = (roles, teams) => plain(G.peopleSort.roleLabels(roles, teams || TEAMS).map(r => r.label));
    assert.deepEqual(labels([]), ['Member']);
    assert.deepEqual(labels([{ role: 'team_lead', teamId: 't3' }, { role: 'officer' }]), ['Officer', 'Team Lead: Old']);
    assert.deepEqual(labels([{ role: 'guild_master' }]), ['Guild Master']);
    assert.deepEqual(labels([{ role: 'cr_a', name: 'Loot council' }]), ['Loot council']);
    assert.deepEqual(labels([{ role: 'cr_a', name: 'Raid leader', teamId: 't1' }]), ['Raid leader - Alpha']);
    assert.deepEqual(labels([{ role: 'cr_a', name: 'Raid leader', teamId: 'gone' }]), ['Raid leader'], 'a team that is gone shows the bare name');
    assert.deepEqual(labels([{ role: 'officer', fromDiscord: true }]), ['Officer (Discord)']);
    assert.deepEqual(labels([{ role: 'team_lead', teamId: 't2', fromDiscord: true }]), ['Team Lead: Bravo (Discord)']);
    assert.deepEqual(labels([{ role: 'cr_a', name: 'Raid leader', teamId: 't1', fromDiscord: true }]), ['Raid leader - Alpha (Discord)']);
    assert.deepEqual(labels([{ role: 'cr_z', name: 'Zed' }, { role: 'cr_a', name: 'Able' }, { role: 'team_lead', teamId: 't1' }, { role: 'officer' }]), ['Officer', 'Team Lead: Alpha', 'Zed', 'Able'], 'custom roles come after Team Lead, in the order sent');
    assert.deepEqual(plain(G.peopleSort.roleLabels([{ role: 'officer', fromDiscord: true }], TEAMS)[0]), { kind: 'officer', label: 'Officer (Discord)', fromDiscord: true });
    assert.deepEqual(plain(G.peopleSort.roleLabels([{ role: 'officer' }], TEAMS)[0]), { kind: 'officer', label: 'Officer' }, 'no extra keys on a plain role');
    assert.deepEqual(plain(G.peopleSort.roleLabels([{ role: 'cr_a', name: 'X' }], TEAMS)[0]), { kind: 'custom', label: 'X' });
    assert.deepEqual(labels([{ role: 'cr_a' }]), ['Custom role'], 'a custom role without a name still shows something');
    assert.deepEqual(plain(G.peopleSort.normalizeRoles(['officer', { role: 'team_lead', teamId: 't1' }])), [{ role: 'officer', teamId: null }, { role: 'team_lead', teamId: 't1' }]);
    assert.equal(G.peopleSort.roleRank([]), 3);
    assert.equal(G.peopleSort.roleRank([{ role: 'team_lead', teamId: 't1' }]), 2);
    assert.equal(G.peopleSort.roleRank([{ role: 'cr_a', name: 'X' }]), 2.5);
    assert(G.peopleSort.roleRank([{ role: 'team_lead' }]) < G.peopleSort.roleRank([{ role: 'cr_a' }]) && G.peopleSort.roleRank([{ role: 'cr_a' }]) < G.peopleSort.roleRank([]));
    const sorted = G.peopleSort.sortPeople([entry('u1', 'Zed', []), entry('u2', 'Ann', [{ role: 'cr_a', name: 'Loot' }]), entry('u3', 'Bea', [{ role: 'team_lead', teamId: 't1' }]), entry('u4', 'Cy', [{ role: 'officer' }])], { column: 'roles', dir: 'asc' });
    assert.deepEqual(plain(sorted.map(e => e.person.displayName)), ['Cy', 'Bea', 'Ann', 'Zed']);
  });

  await check('role chips and the account menu use the new labels, escaped; a custom chip has its own class', () => {
    const chips = G.ui.roleChipsHtml([{ role: 'cr_a', name: HOSTILE + QUOTES, teamId: 't1' }, { role: 'officer', fromDiscord: true }], TEAMS);
    assert(chips.includes('gs-chip gs-chip-custom') && chips.includes('gs-chip gs-chip-officer') && chips.includes('Officer (Discord)'));
    assertEscaped(chips, 'chips');
    assertNoRawAttrs(chips);
    assert(css.includes('.gs-chip-custom'));
    const gd = guildData(null, { me: { roles: [{ role: 'cr_a', name: 'Raid leader', teamId: 't1' }], can: {} } });
    const menu = G.shell.accountMenuHtml({ section: 'guild', page: 'app', me: { user: person('u1', 'Gale G'), identities: { discord: { username: 'gale' } } }, guildData: gd, route: { name: 'section', gid: 'g1', section: 'roster' } });
    assert(text(menu).includes('Raid leader - Alpha - Ember'));
  });

  // =========================================================================
  // api wrappers
  await check('api: roles, discord, guests and publicPage call the Worker\'s routes with the contract\'s bodies (through G.api.get / post / put / del)', async () => {
    const calls = [];
    const rec = method => (url, body) => { calls.push([method, url, body === undefined ? undefined : plain(body)]); return okRes({}); };
    await withApi({ get: rec('GET'), post: rec('POST'), put: rec('PUT'), del: rec('DELETE') }, async () => {
      await G.api.roles.list('g1');
      await G.api.roles.create('g1', { name: 'X', permissions: { 'roster.view': 'guild' } });
      await G.api.roles.update('g1', 'cr_1', { permissions: {} });
      await G.api.roles.reset('g1', 'officer');
      await G.api.roles.remove('g1', 'cr_1');
      await G.api.discord.get('g1');
      await G.api.discord.saveMaps('g1', [{ discordRoleId: '1', roleId: 'officer', teamId: null }]);
      await G.api.discord.syncPerson('g1', 'u_1');
      await G.api.discord.syncAll('g1');
      await G.api.discord.syncAll('g1', 'u_9');
      await G.api.guests.list('g1');
      await G.api.guests.create('g1', { roleId: 'guest', expiresIn: '7d' });
      await G.api.guests.revoke('g1', 'gl_1');
      await G.api.guests.redeem(TOKEN);
      await G.api.guests.view();
      await G.api.guests.leave();
      await G.api.publicPage.get('g1');
      await G.api.publicPage.save('g1', { enabled: true, sections: ['roster'] });
      await G.api.publicPage.view('g1');
    });
    assert.deepEqual(calls, [
      ['GET', '/api/guild/g1/roles', undefined],
      ['POST', '/api/guild/g1/roles', { name: 'X', permissions: { 'roster.view': 'guild' } }],
      ['PUT', '/api/guild/g1/roles/cr_1', { permissions: {} }],
      ['POST', '/api/guild/g1/roles/officer/reset', {}],
      ['DELETE', '/api/guild/g1/roles/cr_1', {}],
      ['GET', '/api/guild/g1/discord', undefined],
      ['PUT', '/api/guild/g1/discord/maps', { maps: [{ discordRoleId: '1', roleId: 'officer', teamId: null }] }],
      ['POST', '/api/guild/g1/people/u_1/sync', {}],
      ['POST', '/api/guild/g1/discord/sync', {}],
      ['POST', '/api/guild/g1/discord/sync', { after: 'u_9' }],
      ['GET', '/api/guild/g1/guest-links', undefined],
      ['POST', '/api/guild/g1/guest-links', { roleId: 'guest', expiresIn: '7d' }],
      ['DELETE', '/api/guild/g1/guest-links/gl_1', {}],
      ['POST', '/auth/guest', { token: TOKEN }],
      ['GET', '/api/guest', undefined],
      ['DELETE', '/auth/guest', {}],
      ['GET', '/api/guild/g1/public', undefined],
      ['PUT', '/api/guild/g1/public', { enabled: true, sections: ['roster'] }],
      ['GET', '/api/public/g1', undefined],
    ]);
  });

  // =========================================================================
  // Settings > Roles
  await check('Settings > Roles: one card per role with its badge and who holds it; New role while under the limit; View for what the viewer cannot edit', () => {
    const out = G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data: rolesData() });
    const t = text(out);
    assert((out.match(/class="gs-role-card"/g) || []).length === 8);
    const names = [...out.matchAll(/<h3 class="gs-h3 gs-role-name">([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(names, ['Guild Master', 'Officer', 'Team Lead', 'Member', 'Guest', 'Public', 'Raid leader', 'Loot council']);
    const card = id => out.split('<li class="gs-role-card">').find(c => c.includes('data-role="' + id + '"'));
    assert(text(card('guild_master')).includes('Built-in') && text(card('guild_master')).includes('Fixed') && !text(card('guild_master')).includes('Edited'));
    assert(text(card('team_lead')).includes('Edited') && text(card('team_lead')).includes('Given for one team'));
    assert(text(card('officer')).includes('2 people') && text(card('officer')).includes('1 Discord mapping') && !text(card('officer')).includes('Edited') && !text(card('officer')).includes('Fixed'));
    assert(text(card('cr_raid')).includes('Custom') && text(card('cr_raid')).includes('3 people') && text(card('cr_raid')).includes('2 Discord mappings') && text(card('cr_raid')).includes('1 guest link'));
    assert(text(card('guest')).includes('2 guest links') && text(card('member')).includes('Held by everyone in the guild') && text(card('public')).includes('Used by the public page'));
    assert(card('guild_master').includes('>View<') && card('officer').includes('>Edit<') && card('cr_raid').includes('data-action="role-delete"') && !card('officer').includes('data-action="role-delete"'));
    assert(out.includes('data-action="role-new"') && t.includes('Built-in help for Officer'));
    assert(!t.includes('Only the Guild Master can change the built-in roles.'));
    const limit = G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data: rolesData({ limits: { customRoles: 2, nameLength: 32 } }) });
    assert(!limit.includes('data-action="role-new"') && text(limit).includes('The limit of 2 own roles is reached.'));
    const notGm = G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data: rolesData({ canEditBuiltin: false }) });
    assert(text(notGm).includes('Only the Guild Master can change the built-in roles.'));
    assert(notGm.split('<li class="gs-role-card">').find(c => c.includes('data-role="officer"')).includes('>View<'));
    assert(notGm.split('<li class="gs-role-card">').find(c => c.includes('data-role="cr_raid"')).includes('>Edit<'), 'own roles stay editable');
    assert(G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data: null }).includes('Loading'));
    assert(G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data: rolesData(), notice: 'Saved Officer.', alert: 'Nope' }).includes('Saved Officer.'));
    assertNoRawAttrs(out);
  });

  await check('Settings > Roles: hostile role names, notes and notices are escaped everywhere', () => {
    const data = rolesData();
    data.roles.push(role('cr_evil', HOSTILE + QUOTES, 'custom', { holders: 1 }));
    data.roles[1].note = HOSTILE + QUOTES;
    const page = G.pages.settingsRoles.settingsHtml({ guildData: guildData(), data, alert: HOSTILE + QUOTES, notice: HOSTILE + QUOTES });
    assertEscaped(page, 'page');
    assertEscaped(G.pages.settingsRoles.roleDialogHtml(data.roles[8], data), 'edit dialog');
    assertEscaped(G.pages.settingsRoles.roleDialogHtml(data.roles[1], data), 'builtin dialog');
    assertEscaped(G.pages.settingsRoles.deleteDialogHtml(data.roles[8]), 'delete dialog');
    for (const out of [page, G.pages.settingsRoles.roleDialogHtml(data.roles[8], data), G.pages.settingsRoles.deleteDialogHtml(data.roles[8])]) assertNoRawAttrs(out);
  });

  await check('role dialog: every action is a labelled select in its group\'s fieldset, with "No" and only the scopes the Worker allows; what the role holds is selected', () => {
    const data = rolesData();
    const out = G.pages.settingsRoles.roleDialogHtml(data.roles[1], data);
    assert.deepEqual([...out.matchAll(/<legend class="gs-legend">([^<]*)</g)].map(m => m[1]), ['Roster', 'Raids', 'Attendance', 'Loot', 'Guild settings']);
    const selectFor = action => out.match(new RegExp('<select[^>]*data-perm="' + action.replace('.', '\\.') + '"[^>]*>([\\s\\S]*?)</select>'));
    for (const a of ACTIONS) {
      const m = selectFor(a.action);
      assert(m, a.action);
      const options = [...m[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)</g)].map(o => [o[1], !!o[2], o[3]]);
      assert.deepEqual(options.map(o => o[0]), [''].concat(data.roles[1].allowed[a.action]), a.action);
      const held = data.roles[1].permissions[a.action] || '';
      assert.deepEqual(options.filter(o => o[1]).map(o => o[0]), [held], a.action + ' selected');
      assert(out.includes('>' + a.label + '</label>'), a.label);
    }
    const ids = [...out.matchAll(/<label class="gs-perm-label" for="([^"]+)"/g)].map(m => m[1]);
    assert.equal(ids.length, ACTIONS.length);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    for (const id of ids) assert(out.includes('<select class="gs-input gs-perm-select" id="' + id + '"'), id);
    assert(out.includes('<option value="team">One team (given per team)</option>') && out.includes('<option value="guild" selected>Whole guild</option>'));
    assert(!out.includes('name="name"') && !out.includes('data-action="role-delete"'), 'a built-in role keeps its name and cannot be deleted');
    assert(out.includes('data-mode="edit"') && out.includes('data-role="officer"') && out.includes('data-submit="role-form"'));
    assert(text(out).includes('Built-in help for Officer') && text(out).includes('This role has been edited for this guild.') === false, 'officer is not customized in this fixture');
    const withOwn = G.pages.settingsRoles.roleDialogHtml(data.roles[3], data);
    assert(withOwn.includes('<option value="own_teams" selected>Their own teams</option>'));
    assert.equal(G.pages.settingsRoles.SCOPE_LABELS.own_teams, 'Their own teams');
    assertNoRawAttrs(out);
  });

  await check('role dialog: an action with no allowed scope is disabled with its reason (Officer role only, Read-only role); nothing is hard-coded on the page', () => {
    const data = rolesData();
    const guest = G.pages.settingsRoles.roleDialogHtml(data.roles[4], data);
    const locked = id => guest.match(new RegExp('<select[^>]*data-perm="' + id.replace('.', '\\.') + '"[^>]*>'))[0];
    assert(/ disabled/.test(locked('roster.edit')) && /aria-describedby="role-perm-\d+-why"/.test(locked('roster.edit')));
    assert(!/ disabled/.test(locked('roster.view')));
    const why = id => { const m = guest.match(new RegExp('<select[^>]*data-perm="' + id.replace('.', '\\.') + '"[^>]*aria-describedby="([^"]+)"')); return m ? guest.match(new RegExp('id="' + m[1] + '">([^<]*)<'))[1] : null; };
    assert.equal(why('roster.edit'), 'Read-only role');
    assert.equal(why('guild.roles'), 'Officer role only', 'staff wins over read-only');
    const custom = G.pages.settingsRoles.roleDialogHtml(data.roles[6], data);
    assert(/data-perm="guild\.roles" disabled/.test(custom) && custom.includes('Officer role only'));
    // The page follows `allowed` even where it contradicts what a role usually gets.
    const odd = rolesData();
    odd.roles[6].allowed['guild.teams'] = [];
    odd.roles[6].allowed['roster.view'] = ['guild', 'team', 'own_teams'];
    const out = G.pages.settingsRoles.roleDialogHtml(odd.roles[6], odd);
    assert(/data-perm="guild\.teams" disabled/.test(out) && out.includes('Not available for this role'));
    assert(/data-perm="roster\.view"[^>]*><option value="">No<\/option><option value="guild" selected>Whole guild<\/option><option value="team">[^<]*<\/option><option value="own_teams">Their own teams<\/option>/.test(out));
    const odd2 = rolesData();
    odd2.roles[1].permissions['loot.view'] = 'own_teams';
    odd2.roles[1].allowed['loot.view'] = ['guild'];
    assert(G.pages.settingsRoles.roleDialogHtml(odd2.roles[1], odd2).includes('<option value="own_teams" selected>Their own teams</option>'), 'a scope the role holds stays visible');
  });

  await check('role dialog: a new role starts empty with the name field and takes its allowed scopes from an own role (else from the catalogue); a role given per team says so', () => {
    const data = rolesData();
    const out = G.pages.settingsRoles.roleDialogHtml(null, data);
    assert(out.includes('data-mode="new"') && !out.includes('data-role=') && out.includes('name="name"') && out.includes('maxlength="32"') && out.includes('>Create role<'));
    assert(!/ selected>(Whole guild|One team|Their own teams)/.test(out), 'nothing is granted');
    assert(/data-perm="guild\.access" disabled/.test(out) && out.includes('Officer role only'));
    assert(/data-perm="roster\.edit"[^>]*><option value="" selected>No<\/option><option value="guild">/.test(out));
    const bare = rolesData();
    bare.roles = bare.roles.filter(r => r.kind === 'builtin');
    bare.limits.nameLength = 20;
    const fromCatalogue = G.pages.settingsRoles.roleDialogHtml(null, bare);
    assert(/data-perm="guild\.roles" disabled/.test(fromCatalogue) && /data-perm="raids\.edit"[^>]*><option value="" selected>No<\/option><option value="guild">Whole guild<\/option><option value="team">/.test(fromCatalogue) && fromCatalogue.includes('maxlength="20"'));
    const edit = G.pages.settingsRoles.roleDialogHtml(data.roles[6], data);
    assert(edit.includes('value="Raid leader"') && edit.includes('data-action="role-delete"') && edit.includes('data-role="cr_raid"') && text(edit).includes('Given for one team') && edit.includes('>Save<'));
    assert(!edit.includes('data-action="role-reset-ask"'));
  });

  await check('role dialog: the Guild Master role is read-only text; built-in roles show their note, Reset to defaults only when edited, and are read-only for anyone but the Guild Master', () => {
    const data = rolesData();
    const gm = G.pages.settingsRoles.roleDialogHtml(data.roles[0], data);
    assert(text(gm).includes('always holds every action') && !gm.includes('<form') && !gm.includes('type="submit"') && !gm.includes('<select') && gm.includes('>Close<'));
    const tl = G.pages.settingsRoles.roleDialogHtml(data.roles[2], data);
    assert(text(tl).includes('Built-in help for Team Lead') && text(tl).includes('This role has been edited for this guild.') && text(tl).includes('Given for one team'));
    assert(tl.includes('data-action="role-reset-ask"') && tl.includes('data-action="role-reset-confirm"') && /id="dlg-reset-confirm" hidden/.test(tl) && text(tl).includes('Reset Team Lead to its defaults?'));
    assert(!G.pages.settingsRoles.roleDialogHtml(data.roles[1], data).includes('role-reset-ask'), 'an unedited role has nothing to reset');
    const ro = G.pages.settingsRoles.roleDialogHtml(data.roles[2], rolesData({ canEditBuiltin: false }));
    assert(!ro.includes('type="submit"') && !ro.includes('role-reset-ask') && !/<select(?![^>]*disabled)/.test(ro) && ro.includes('>Close<') && text(ro).includes('Only the Guild Master can change the built-in roles.'));
    const roCustom = G.pages.settingsRoles.roleDialogHtml(data.roles[6], rolesData({ canEditBuiltin: false }));
    assert(roCustom.includes('type="submit"'), 'own roles stay editable');
  });

  await check('delete dialog: names the people, the Discord mappings and the guest links that go with the role', () => {
    const out = G.pages.settingsRoles.deleteDialogHtml(rolesData().roles[6]);
    const t = text(out);
    assert(t.includes('Delete Raid leader?') && t.includes('takes it away from 3 people, removes 2 Discord mappings and turns off 1 guest link'));
    assert(out.includes('data-submit="role-delete-form"') && out.includes('data-role="cr_raid"') && out.includes('gs-btn-danger') && out.includes('data-action="dialog-cancel"'));
    const none = text(G.pages.settingsRoles.deleteDialogHtml(role('cr_x', 'Quiet', 'custom')));
    assert(none.includes('from 0 people, removes 0 Discord mappings and turns off 0 guest links'));
    assert(text(G.pages.settingsRoles.deleteDialogHtml(role('cr_x', 'One', 'custom', { holders: 1, mapped: 1, links: 1 }))).includes('from 1 person, removes 1 Discord mapping and turns off 1 guest link'));
  });

  await check('roles handlers: New role / Edit / Delete open their dialogs (Delete from the edit dialog closes it first)', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1';
    s.rolesSettings = { gid: 'g1', data: rolesData(), notice: '' };
    await withApi({}, async probe => {
      G.handlers.click['role-new'](el());
      G.handlers.click['role-edit'](el({ 'data-role': 'officer' }));
      G.handlers.click['role-edit'](el({ 'data-role': 'guild_master' }));
      G.handlers.click['role-edit'](el({ 'data-role': 'nope' }));
      G.handlers.click['role-delete'](el({ 'data-role': 'cr_raid' }));
      G.handlers.click['role-delete'](el({ 'data-role': 'officer' }));
      let closed = 0;
      const inDialog = Object.assign(el({ 'data-role': 'cr_loot' }), { closest: sel2 => (sel2 === 'dialog' ? { open: true, close() { closed++; } } : null) });
      G.handlers.click['role-delete'](inDialog);
      assert.equal(closed, 1);
      assert.equal(probe.opened.length, 5);
      assert(probe.opened[0].html.includes('data-mode="new"') && probe.opened[1].html.includes('data-role="officer"') && !probe.opened[2].html.includes('<form'));
      assert(probe.opened[3].html.includes('data-submit="role-delete-form"') && probe.opened[3].html.includes('data-role="cr_raid"'));
      assert.deepEqual(plain(probe.opened[3].opts), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
      assert.equal(probe.opened[4].opts.returnKey, 'role-edit-cr_loot');
    });
    s.rolesSettings = null;
  });

  function roleFormEls(name) {
    return { name: { value: name, focus() {} } };
  }
  const grid = list => ({ 'select[data-perm]': list.map(([perm, value, disabled]) => Object.assign(sel(value, { 'data-perm': perm }), { disabled: !!disabled })) });

  await check('role-form: creating a role POSTs the trimmed name and the non-"No" scopes, closes the dialog, shows Created, and keeps the list for the People page', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1'; s.rolesList = {};
    s.rolesSettings = { gid: 'g1', data: rolesData(), notice: '' };
    const created = rolesData(); created.roles.push(role('cr_new', 'Recruiter', 'custom', { permissions: { 'roster.view': 'guild' } }));
    const sent = [];
    const form = formEl({ 'data-mode': 'new' }, roleFormEls('  Recruiter '), grid([['roster.view', 'guild'], ['roster.edit', ''], ['raids.edit', 'team'], ['guild.roles', 'guild', true]]));
    await withApi({ post: (url, body) => { sent.push([url, plain(body)]); return okRes(created); } }, async probe => {
      G.handlers.submit['role-form'](form);
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/roles', { permissions: { 'roster.view': 'guild', 'raids.edit': 'team' }, name: 'Recruiter' }]]);
      assert.equal(s.rolesSettings.notice, 'Created Recruiter.');
      assert.equal(s.rolesSettings.data, created);
      assert.equal(s.rolesList.g1, created, 'the People page reads the new list');
      assert.equal(probe.renders(), 1);
      assert.deepEqual(probe.refreshed, ['g1'], 'the viewer\'s own permissions are read again');
    });
    s.rolesSettings = null;
  });

  await check('role-form: an empty name is refused on the page; editing a built-in role sends only its permissions, an own role its name too', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1';
    s.rolesSettings = { gid: 'g1', data: rolesData(), notice: '' };
    clearFields(); field('dlg-err-name'); field('dlg-err-permissions'); field('dlg-error');
    const sent = [];
    const saved = rolesData();
    await withApi({ post: (url, body) => { sent.push(['POST', url]); return okRes(saved); }, put: (url, body) => { sent.push(['PUT', url, plain(body)]); return okRes(saved); } }, async probe => {
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'new' }, roleFormEls('   '), grid([])));
      await settle();
      assert.deepEqual(sent, []);
      assert.equal(fields['dlg-err-name'].textContent, 'Enter a name for the role.');
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'edit', 'data-role': 'officer' }, roleFormEls('ignored'), grid([['roster.view', 'guild'], ['guild.roles', '']])));
      await settle();
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'edit', 'data-role': 'cr_raid' }, roleFormEls(' Raid captain '), grid([['raids.edit', 'team']])));
      await settle();
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'edit', 'data-role': 'guild_master' }, roleFormEls('x'), grid([])));
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'edit', 'data-role': 'nope' }, roleFormEls('x'), grid([])));
      await settle();
      assert.deepEqual(sent, [
        ['PUT', '/api/guild/g1/roles/officer', { permissions: { 'roster.view': 'guild' } }],
        ['PUT', '/api/guild/g1/roles/cr_raid', { permissions: { 'raids.edit': 'team' }, name: 'Raid captain' }],
      ]);
      assert.equal(s.rolesSettings.notice, 'Saved Raid captain.');
      // Only the Guild Master edits the built-in roles.
      s.rolesSettings.data = rolesData({ canEditBuiltin: false });
      G.handlers.submit['role-form'](formEl({ 'data-mode': 'edit', 'data-role': 'officer' }, roleFormEls('x'), grid([])));
      await settle();
      assert.equal(sent.length, 2);
    });
    s.rolesSettings = null; clearFields();
  });

  await check('role-form errors: the name clash and the bad permission sit at their fields, a 403 stays in the dialog (not a page), a lost race and a sign-out are handled', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1';
    s.rolesSettings = { gid: 'g1', data: rolesData(), notice: '' };
    const attempt = async (status, body) => {
      clearFields(); field('dlg-err-name'); field('dlg-err-permissions'); field('dlg-error');
      const form = formEl({ 'data-mode': 'edit', 'data-role': 'cr_raid' }, roleFormEls('Raid leader'), grid([['raids.edit', 'team']]),
        { '#dlg-err-name': {}, '#dlg-err-permissions': {}, '[data-field="name"]': { setAttribute() {}, focus() {} } });
      form.querySelectorAll = sel2 => (sel2 === 'select[data-perm]' ? [sel('team', { 'data-perm': 'raids.edit' })] : (sel2 === 'button' ? [] : []));
      await withApi({ put: () => rejectWith(status, body) }, async probe => {
        G.handlers.submit['role-form'](form);
        await settle();
        form.probe = probe;
      });
      return form;
    };
    await attempt(409, { error: 'role_name_taken', message: 'Another role in this guild already has that name.', field: 'name' });
    assert.equal(fields['dlg-err-name'].textContent, 'Another role in this guild already has that name.');
    await attempt(400, { error: 'bad_request', message: 'Officer role only.', field: 'permissions' });
    assert.equal(fields['dlg-err-permissions'].textContent, 'Officer role only.');
    await attempt(403, { error: 'forbidden', message: 'You cannot give a role more than you can do yourself.' });
    assert.equal(fields['dlg-error'].textContent, 'You cannot give a role more than you can do yourself.', 'a 403 is a message in the dialog');
    assert.equal(s.failure, null, 'not a failure page');
    await attempt(400, { error: 'fixed_role', message: 'The Guild Master role cannot be changed.' });
    assert.equal(fields['dlg-error'].textContent, 'The Guild Master role cannot be changed.');
    await attempt(400, { error: 'builtin_role', message: 'Built-in roles cannot be deleted.' });
    assert.equal(fields['dlg-error'].textContent, 'Built-in roles cannot be deleted.');
    await attempt(409, { error: 'role_in_use', message: 'That role is in use.' });
    assert.equal(fields['dlg-error'].textContent, 'That role is in use.');
    s.rolesSettings = null; clearFields();
  });

  await check('roles: Delete confirm sends DELETE and shows Deleted; Reset to defaults sends POST .../reset; neither works on the wrong kind of role', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1'; s.rolesList = {};
    s.rolesSettings = { gid: 'g1', data: rolesData(), notice: '' };
    const after = rolesData(); after.roles = after.roles.filter(r => r.id !== 'cr_raid');
    const sent = [];
    await withApi({
      del: url => { sent.push(['DELETE', url]); return okRes(after); },
      post: url => { sent.push(['POST', url]); return okRes(rolesData()); },
    }, async probe => {
      G.handlers.submit['role-delete-form'](formEl({ 'data-role': 'cr_raid' }));
      await settle();
      assert.equal(s.rolesSettings.notice, 'Deleted Raid leader.');
      assert.equal(s.rolesList.g1, after);
      G.handlers.submit['role-delete-form'](formEl({ 'data-role': 'officer' }));
      G.handlers.submit['role-delete-form'](formEl({ 'data-role': 'gone' }));
      const resetForm = formEl({ 'data-role': 'team_lead' });
      G.handlers.click['role-reset-confirm'](Object.assign(el(), { closest: () => resetForm }));
      await settle();
      assert.equal(s.rolesSettings.notice, 'Team Lead is back to its defaults.');
      G.handlers.click['role-reset-confirm'](Object.assign(el(), { closest: () => formEl({ 'data-role': 'cr_loot' }) }));
      G.handlers.click['role-reset-confirm'](Object.assign(el(), { closest: () => formEl({ 'data-role': 'guild_master' }) }));
      await settle();
      assert.deepEqual(sent, [['DELETE', '/api/guild/g1/roles/cr_raid'], ['POST', '/api/guild/g1/roles/team_lead/reset']]);
    });
    s.rolesSettings = null;
  });

  await check('roles: the reset step swaps the footer for its own confirm and back', () => {
    clearFields();
    const footer = field('dlg-role-footer'); footer.hidden = false;
    const confirmBox = Object.assign(field('dlg-reset-confirm'), { querySelector: () => ({ focus() {} }) });
    const ask = Object.assign(field('dlg-reset-ask'), { hidden: false, focus() {} });
    G.handlers.click['role-reset-ask'](ask);
    assert.equal(ask.hidden, true); assert.equal(footer.hidden, true); assert.equal(confirmBox.hidden, false);
    G.handlers.click['role-reset-cancel']();
    assert.equal(ask.hidden, false); assert.equal(footer.hidden, false); assert.equal(confirmBox.hidden, true);
    clearFields();
  });

  await check('roles: load() reads the list into state.rolesSettings and state.rolesList', async () => {
    const s = G.app.state;
    s.rolesList = {};
    const data = rolesData();
    await withApi({ get: url => { assert.equal(url, '/api/guild/g1/roles'); return okRes(data); } }, async () => {
      assert.equal(await G.pages.settingsRoles.load('g1'), data);
    });
    assert.deepEqual(plain(s.rolesSettings), { gid: 'g1', data: plain(data), notice: '' });
    assert.equal(s.rolesList.g1, data);
    s.rolesSettings = null;
  });

  // =========================================================================
  // Settings > Discord roles
  await check('Settings > Discord roles: the bot card says in plain words what is wrong, for each state', () => {
    const page = (bot, extra) => G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: discordData(bot, extra) });
    const none = page({ configured: false, inServer: null, inviteUrl: null }, { roles: [], maps: [] });
    assert(text(none).includes('The Raidsmith bot is not set up on this server') && none.includes('id="discord-status"') && !none.includes('<table'));
    assert(!/DISCORD|TOKEN|env|\.env/.test(text(none)), 'no environment names in the words');
    const out = page({ inServer: false, problem: 'bot_missing' }, { roles: [] });
    assert(text(out).includes('The Raidsmith bot is not in your Discord server yet') && text(out).includes('asks for no permissions') && text(out).includes('stays silent'));
    assert(/<a class="gs-btn" href="https:\/\/discord\.com\/oauth2\/authorize[^"]*" target="_blank" rel="noopener noreferrer">Add the Raidsmith bot<\/a>/.test(out));
    assert(!page({ inServer: false, inviteUrl: null }, { roles: [] }).includes('Add the Raidsmith bot'), 'no link to show');
    assert(!page({ inServer: false, inviteUrl: 'javascript:alert(1)' }, { roles: [] }).includes('Add the Raidsmith bot') && !page({ inviteUrl: 'javascript:alert(1)' }).includes('Invite link'), 'only an http(s) address becomes a link');
    for (const [problem, words] of [['bad_token', 'did not accept the bot'], ['unavailable', 'Discord did not answer'], ['rate_limited', 'Discord is busy']]) {
      const p = page({ inServer: null, problem }, { roles: [] });
      assert(text(p).includes(words), problem);
    }
    assert(text(page({ inServer: null, problem: 'something_new' }, { roles: [] })).includes('cannot be read right now'));
    const ok = page();
    assert(text(ok).includes('Connected: 3 Discord roles'));
    assert(/<a class="gs-discord-link" href="https:\/\/discord\.com[^"]*" target="_blank" rel="noopener noreferrer">Invite link for the Raidsmith bot<\/a>/.test(ok));
    assert(text(page({}, { roles: [discordData().roles[0]] })).includes('Connected: 1 Discord role') && !text(page({}, { roles: [discordData().roles[0]] })).includes('1 Discord roles'));
    assert(!page({ inviteUrl: null }).includes('Invite link'));
    assert(G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: null }).includes('Loading'));
    for (const out2 of [none, ok]) assertNoRawAttrs(out2);
  });

  await check('Settings > Discord roles: one row per Discord role with a "Gives" choice; the team choice is there for roles given per team and shows only while one is chosen', () => {
    const out = G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: discordData() });
    assert(out.includes('data-submit="discord-maps"') && out.includes('>Save mapping<'));
    assert.deepEqual([...out.matchAll(/<th scope="row" class="gs-cell-strong">([^<]*)</g)].map(m => m[1]), ['Officers', 'Raid leaders', 'Loot team']);
    const row = n => out.split('<tr>').filter(r => r.includes('<th scope="row"'))[n];
    const targets = html => [...html.match(/<select[^>]*data-discord-role[^>]*>([\s\S]*?)<\/select>/)[1].matchAll(/<option value="([^"]*)"[^>]*?( selected)?>([^<]*)</g)].map(m => [m[1], !!m[2], m[3]]);
    assert.deepEqual(targets(row(0)), [['', false, 'Not mapped'], ['officer', true, 'Officer'], ['team_lead', false, 'Team Lead'], ['cr_loot', false, 'Loot council']]);
    assert.deepEqual(targets(row(1)).filter(o => o[1]).map(o => o[0]), ['team_lead']);
    assert.deepEqual(targets(row(2)).filter(o => o[1]).map(o => o[0]), [], 'an unmapped role is on Not mapped');
    assert(/<option value="team_lead" data-needs-team="1"/.test(row(0)) && !/<option value="officer" data-needs-team/.test(row(0)));
    assert(/id="dmap-team-wrap-0" hidden/.test(row(0)) && /id="dmap-team-wrap-1">/.test(row(1)) && !/id="dmap-team-wrap-1" hidden/.test(row(1)), 'shown only for the role given per team');
    assert(/for="dmap-team-1">for team</.test(row(1)) && /<select class="gs-input" id="dmap-team-1" aria-label="Raid leaders: for team"/.test(row(1)), 'the visible words are in the accessible name');
    const teamOptions = row(1).match(/<select[^>]*id="dmap-team-1"[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...teamOptions.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)</g)].map(m => [m[1], !!m[2], m[3]]), [['t1', true, 'Alpha'], ['t2', false, 'Bravo']], 'active teams only, the mapped team chosen');
    assert(/<label class="gs-sr" for="dmap-0">Raidsmith role given by Officers<\/label>/.test(row(0)));
    assert(out.includes('class="gs-table gs-table-stack gs-table-dmap"') && out.includes('data-label="Gives"'));
    const noTeamRoles = discordData(null, { targets: [{ roleId: 'officer', name: 'Officer', needsTeam: false, custom: false }] });
    assert(!G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: noTeamRoles }).includes('dmap-team-'), 'no team choice when no target is per team');
    const t = text(out);
    assert(t.includes('applies at every sign-in and with Sync now') && t.includes('A role set by hand always wins and stays') && t.includes('The Guild Master cannot be given by a Discord role') && t.includes('Everyone in your Discord server is already a Member'));
  });

  await check('Settings > Discord roles: mappings whose Discord role is gone are listed apart so they can be removed; unreadable roles keep the mappings as "Saved mappings"', () => {
    const data = discordData(null, { maps: discordData().maps.concat([{ discordRoleId: '700000000000000099', roleId: 'cr_loot', teamId: null }]) });
    const out = G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data });
    assert(out.includes('Not in the server any more') && text(out).includes('Discord role 700000000000000099'));
    assert((out.match(/data-discord-role="/g) || []).length === 4);
    assert(/data-discord-role="700000000000000099"[^>]*>[\s\S]*?<option value="cr_loot" selected>/.test(out));
    const unreadable = G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: discordData({ inServer: null, problem: 'unavailable' }, { roles: [] }) });
    assert(unreadable.includes('Saved mappings') && !unreadable.includes('Not in the server any more') && (unreadable.match(/data-discord-role="/g) || []).length === 2 && unreadable.includes('>Save mapping<'));
    const empty = G.pages.settingsDiscord.settingsHtml({ guildData: guildData(), data: discordData(null, { roles: [], maps: [] }) });
    assert(empty.includes('id="discord-empty"') && !empty.includes('<table') && !empty.includes('Save mapping'));
  });

  await check('Settings > Discord roles: hostile Discord role names, ids, target names and notices are escaped', () => {
    const data = discordData(null, {
      roles: [{ id: '700000000000000001', name: HOSTILE + QUOTES, color: null, position: 1, managed: false }],
      maps: [{ discordRoleId: '700000000000000001', roleId: 'cr_x', teamId: null }, { discordRoleId: HOSTILE + QUOTES, roleId: 'cr_x', teamId: null }],
      targets: [{ roleId: 'cr_x', name: HOSTILE + QUOTES, needsTeam: true, custom: true }],
    });
    const gd = guildData(null, { teams: [{ id: 't1', name: HOSTILE + QUOTES, archived: false }] });
    const out = G.pages.settingsDiscord.settingsHtml({ guildData: gd, data, notice: HOSTILE + QUOTES, alert: HOSTILE + QUOTES });
    assertEscaped(out, 'discord page');
    assertNoRawAttrs(out);
    const bot = G.pages.settingsDiscord.settingsHtml({ guildData: gd, data: discordData({ inviteUrl: 'https://x/"><img src=x onerror=1>', inServer: false }) });
    assertEscaped(bot, 'invite link');
  });

  function mapForm(rows) {
    // rows: [{ idx, discordRoleId, name, value, team }]
    const selects = rows.map(r => sel(r.value, { 'data-discord-role': r.discordRoleId, 'data-idx': String(r.idx), 'data-role-name': r.name }));
    for (const r of rows) if (r.team !== undefined) fields['dmap-team-' + r.idx] = { value: r.team };
    return formEl({}, {}, { 'select[data-discord-role]': selects });
  }

  await check('discord handlers: choosing a role given per team shows the team choice; choosing anything else hides it', () => {
    const s = G.app.state;
    s.discordSettings = { gid: 'g1', data: discordData(), notice: '' };
    clearFields();
    const wrap = field('dmap-team-wrap-4'); wrap.hidden = true;
    G.handlers.change['discord-target'](sel('team_lead', { 'data-idx': '4' }));
    assert.equal(wrap.hidden, false);
    G.handlers.change['discord-target'](sel('officer', { 'data-idx': '4' }));
    assert.equal(wrap.hidden, true);
    G.handlers.change['discord-target'](sel('team_lead', { 'data-idx': '4' }));
    G.handlers.change['discord-target'](sel('', { 'data-idx': '4' }));
    assert.equal(wrap.hidden, true);
    G.handlers.change['discord-target'](sel('team_lead', { 'data-idx': '77' }));
    s.discordSettings = null; clearFields();
  });

  await check('discord handlers: Save sends the whole list with only the rows that have a target (the team only for a role given per team), and says how many assignments went', async () => {
    const s = G.app.state;
    s.discordSettings = { gid: 'g1', data: discordData(), notice: '' };
    clearFields();
    field('discord-form-error');
    const form = mapForm([
      { idx: 0, discordRoleId: '700000000000000001', name: 'Officers', value: 'officer', team: 't2' },
      { idx: 1, discordRoleId: '700000000000000002', name: 'Raid leaders', value: 'team_lead', team: 't2' },
      { idx: 2, discordRoleId: '700000000000000003', name: 'Loot team', value: '' },
      { idx: 3, discordRoleId: '700000000000000004', name: 'Loot 2', value: 'cr_loot', team: 't1' },
    ]);
    const sent = [];
    const maps = [{ discordRoleId: '700000000000000001', roleId: 'officer', teamId: null }];
    await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return okRes({ maps, cleared: 3 }); } }, async probe => {
      G.handlers.submit['discord-maps'](form);
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/discord/maps', { maps: [
        { discordRoleId: '700000000000000001', roleId: 'officer', teamId: null },
        { discordRoleId: '700000000000000002', roleId: 'team_lead', teamId: 't2' },
        { discordRoleId: '700000000000000004', roleId: 'cr_loot', teamId: null },
      ] }]]);
      assert.equal(s.discordSettings.notice, '3 role assignments from removed mappings were taken away.');
      assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'discord');
      assert.deepEqual(plain(s.discordSettings.data.maps), maps);
      assert.equal(probe.renders(), 1);
    });
    await withApi({ put: () => okRes({ maps: [], cleared: 1 }) }, async () => { G.handlers.submit['discord-maps'](form); await settle(); });
    assert.equal(s.discordSettings.notice, '1 role assignment from a removed mapping was taken away.');
    await withApi({ put: () => okRes({ maps: [], cleared: 0 }) }, async () => { G.handlers.submit['discord-maps'](form); await settle(); });
    assert.equal(s.discordSettings.notice, '', 'nothing was taken away, so there is nothing to say beyond Saved at in the page head');
    // a lost race (a role or team changed): the roles are read again and the message is the page's alert
    const fresh = discordData(null, { maps: [] });
    await withApi({ put: () => rejectWith(409, { error: 'conflict', message: 'A role or team changed while you were working on it. Reload and try again.' }), get: () => okRes(fresh) }, async probe => {
      G.handlers.submit['discord-maps'](form); await settle();
      assert.equal(s.discordSettings.data, fresh);
      assert.equal(s.pageAlert, 'A role or team changed while you were working on it. Reload and try again.');
      assert.equal(probe.renders(), 1);
    });
    s.pageAlert = '';
    s.discordSettings = null; clearFields();
  });

  await check('discord handlers: a role given per team without a team is refused before anything is sent; a server error shows in the form; nothing is sent from a page without data', async () => {
    const s = G.app.state;
    s.discordSettings = { gid: 'g1', data: discordData(), notice: '' };
    clearFields();
    const err = field('discord-form-error');
    let puts = 0;
    await withApi({ put: () => { puts++; return rejectWith(400, { error: 'bad_request', message: 'A Discord role can be mapped once.', field: 'maps' }); } }, async () => {
      G.handlers.submit['discord-maps'](mapForm([{ idx: 1, discordRoleId: '700000000000000002', name: 'Raid leaders', value: 'team_lead', team: '' }]));
      await settle();
      assert.equal(puts, 0);
      assert(err.textContent.includes('Pick a team for Raid leaders') && err.hidden === false);
      G.handlers.submit['discord-maps'](mapForm([{ idx: 0, discordRoleId: '700000000000000001', name: 'Officers', value: 'officer' }]));
      await settle();
      assert.equal(puts, 1);
      assert.equal(err.textContent, 'A Discord role can be mapped once.');
      s.discordSettings = null;
      G.handlers.submit['discord-maps'](mapForm([]));
      await settle();
      assert.equal(puts, 1);
    });
    clearFields();
  });

  await check('discord: load() keeps the answer in state.discordSettings', async () => {
    const data = discordData();
    await withApi({ get: url => { assert.equal(url, '/api/guild/g1/discord'); return okRes(data); } }, async () => { await G.pages.settingsDiscord.load('g1'); });
    assert.deepEqual(plain(G.app.state.discordSettings), { gid: 'g1', data: plain(data), notice: '' });
    G.app.state.discordSettings = null;
  });

  // =========================================================================
  // Settings > Public page
  await check('Settings > Public page: off by default in words, a switch, four sections, a closed one disabled with why, the address (with Copy) only while the page is on', () => {
    const out = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: publicData(), origin: 'https://raidsmith.test' });
    const t = text(out);
    assert(t.includes('off by default') && t.includes('never shows officer notes, Discord names or IDs, or accounts'));
    assert(/<input type="checkbox" id="public-enabled" name="enabled" checked>/.test(out) && out.includes('>Show a public page<'));
    const box = key => out.match(new RegExp('<input type="checkbox" id="public-sec-' + key + '"[^>]*>'))[0];
    assert(/ checked/.test(box('roster')) && / checked/.test(box('raids')) && !/ checked/.test(box('attendance')) && !/ checked/.test(box('loot')));
    assert(/ disabled aria-describedby="public-sec-attendance-why"/.test(box('attendance')) && !/ disabled/.test(box('loot')));
    assert(out.includes('>Roster names and classes<') && out.includes('>Upcoming and recent raids<') && out.includes('>Attendance percentages<') && out.includes('>Loot awards<'));
    assert(t.includes('Closed by the Public role (change it in Roles)') && (t.match(/Closed by the Public role/g) || []).length === 1);
    assert(out.includes('<fieldset') && out.includes('<legend class="gs-label">What it shows</legend>'));
    assert(out.includes('id="public-url" readonly') && out.includes('value="https://raidsmith.test/#/public/g1"') && out.includes('data-action="public-copy"'));
    assert(out.includes('data-submit="public-settings"') && out.includes('data-dirty-form') && out.includes('data-savebar') && out.includes('>Save changes<'));
    const off = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: publicData({ enabled: false }), origin: 'https://raidsmith.test' });
    assert(!off.includes('public-url') && !/<input type="checkbox" id="public-enabled" name="enabled" checked>/.test(off));
    const closedAndTicked = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: publicData({ sections: ['attendance'] }) });
    assert(!/ checked/.test(closedAndTicked.match(/<input type="checkbox" id="public-sec-attendance"[^>]*>/)[0]), 'a section the Public role closed is never shown ticked');
    assert(G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: publicData() }).includes('value="/#/public/g1"'), 'no origin in the tests: the path alone');
    assert(G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: null }).includes('Loading'));
    const bad = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: publicData({ path: '/#/public/"><img src=x onerror=1>' }), origin: 'https://x/"><img src=x onerror=1>', notice: HOSTILE + QUOTES, alert: HOSTILE + QUOTES });
    assertEscaped(bad, 'public page');
    assertNoRawAttrs(out); assertNoRawAttrs(bad);
  });

  await check('public handlers: Save sends the switch and the ticked, enabled sections; errors sit in the form; Copy copies the address', async () => {
    const s = G.app.state;
    s.publicSettings = { gid: 'g1', data: publicData(), notice: '' };
    clearFields();
    const err = field('public-form-error');
    const boxes = [box(true, { value: 'roster' }), box(false, { value: 'raids' }), box(true, { value: 'attendance' }), Object.assign(box(true, { value: 'loot' }), { disabled: true })];
    const form = formEl({}, { enabled: { checked: true } }, { 'input[name="section"]': boxes });
    const sent = [];
    const saved = publicData({ sections: ['roster', 'attendance'] });
    await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return okRes(saved); } }, async probe => {
      G.handlers.submit['public-settings'](form);
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/public', { enabled: true, sections: ['roster', 'attendance'] }]]);
      assert.equal(s.publicSettings.notice, ''); assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'public'); assert.equal(s.publicSettings.data, saved); assert.equal(probe.renders(), 1);
    });
    await withApi({ put: () => rejectWith(400, { error: 'bad_request', message: 'The Public role does not allow loot. Change it in Roles first.', field: 'sections' }) }, async () => {
      G.handlers.submit['public-settings'](form);
      await settle();
      assert.equal(err.textContent, 'The Public role does not allow loot. Change it in Roles first.');
    });
    fields['public-url'] = { value: 'https://raidsmith.test/#/public/g1', select() {}, focus() {} };
    field('public-copy-status');
    ctx.navigator = { clipboard: { writeText: () => Promise.resolve() } };
    G.handlers.click['public-copy'](el());
    await settle();
    assert.equal(fields['public-copy-status'].textContent, 'Copied.');
    delete ctx.navigator;
    s.publicSettings = null; clearFields();
  });

  await check('public: load() keeps the answer in state.publicSettings', async () => {
    const data = publicData();
    await withApi({ get: url => { assert.equal(url, '/api/guild/g1/public'); return okRes(data); } }, async () => { await G.pages.settingsPublic.load('g1'); });
    assert.deepEqual(plain(G.app.state.publicSettings), { gid: 'g1', data: plain(data), notice: '' });
    G.app.state.publicSettings = null;
  });

  // =========================================================================
  // the read-only view
  await check('view (guest): the guild, the badge, the role, team and expiry, Leave, and a table per team for each section the Worker sent', () => {
    const out = G.pages.view.viewHtml({ data: viewData('guest'), kind: 'guest' });
    const t = text(out);
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Ember</h1>') && t.includes('Dreamscythe (US) - TBC Anniversary'));
    assert(t.includes('Read-only') && t.includes('Guest link') && t.includes('Role: Guest') && t.includes('Alpha only') && t.includes('Link works until Oct 20, 2026'));
    assert(out.includes('data-action="view-leave"') && out.includes('>Leave this link<') && out.includes('aria-label="More"') && out.includes('id="view-alert"'), 'Leave is behind the one More menu');
    assert.deepEqual([...out.matchAll(/<h2 class="gs-h2" id="view-[a-z]+-h">([^<]*)</g)].map(m => m[1]), ['Roster', 'Raids', 'Attendance', 'Loot']);
    // roster
    assert(out.includes('<span class="gs-char-name gs-class-paladin">Thoren</span>') && out.includes('<span class="gs-char-name gs-class-rogue">Kaelith</span>'));
    assert(/<td class="" data-label="Class">Paladin<\/td>/.test(out) && !out.includes('gs-role-dot') && />Tank</.test(out) && />DPS</.test(out));
    assert(t.includes('No one on the roster yet.'));
    // raids
    assert(out.includes('>Upcoming</h4>') && out.includes('>Recent</h4>') && out.indexOf('>Upcoming</h4>') < out.indexOf('>Recent</h4>'));
    assert(t.includes('Tue Oct 20 Karazhan Gruul night') && t.includes("Sat Oct 10 Gruul's Lair -"));
    // attendance
    assert(t.includes('Counting the last 8 weeks (14 raids).') && t.includes('Counting all time (3 raids).'));
    assert(t.includes('Thoren 92.5% -') === false && t.includes('93% 12 raids counted') && t.includes('Kaelith - 0 raids counted') || /Kaelith[\s\S]*?- 0 raids counted/.test(t));
    assert(t.includes('No attendance to show yet.'));
    // loot
    assert(out.includes('<a class="gs-item gs-q-4" href="https://www.wowhead.com/tbc/item=30001" data-wowhead="item=30001&amp;domain=tbc" target="_blank" rel="noopener noreferrer">Sword of Doom</a>') && out.includes('class="gs-item" href="https://www.wowhead.com/tbc/item=30002"'), 'items are Wowhead links; an unknown quality has no colour class');
    assert(t.includes('Disenchanted') && out.includes('<span class="gs-char-name gs-class-paladin">Thoren</span>'));
    assert(t.includes('Oct 16, 2026'));
    assert((out.match(/<table class="gs-dtable"/g) || []).length === 5, 'roster, upcoming, recent, attendance, loot (a team with nobody has no table)');
    assert(out.includes('data-label="Winner"') && out.includes('data-label="Raids counted"'));
    assertNoRawAttrs(out);
  });

  await check('view: Roster, Raids, Attendance and Loot headings appear only for the sections that came; a team with a guest link for the whole guild and no expiry', () => {
    const data = viewData('guest', { sections: { loot: viewData('guest').sections.loot } });
    data.viewer.team = null; data.viewer.expiresAt = null;
    const out = G.pages.view.viewHtml({ data, kind: 'guest' });
    assert.deepEqual([...out.matchAll(/<h2 class="gs-h2" id="view-([a-z]+)-h">/g)].map(m => m[1]), ['loot']);
    assert(text(out).includes('Whole guild') && text(out).includes('This link does not expire') && !text(out).includes('Link works until'));
    const empty = G.pages.view.viewHtml({ data: viewData('public', { sections: {} }), kind: 'public' });
    assert(text(empty).includes('Nothing is shared here yet.') && !empty.includes('<h2'));
    const noTeams = G.pages.view.viewHtml({ data: viewData('public', { sections: { roster: [] } }), kind: 'public' });
    assert(noTeams.includes('id="view-roster-h"') && text(noTeams).includes('Nothing to show here yet.'));
  });

  await check('view (public): the Public page badge, no Leave, no role or link details', () => {
    const out = G.pages.view.viewHtml({ data: viewData('public'), kind: 'public' });
    const t = text(out);
    assert(t.includes('Public page') && t.includes('Read-only') && !t.includes('Guest link') && !out.includes('view-leave') && !t.includes('Link works') && !t.includes('Role:'));
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Ember</h1>') && out.includes('Thoren'));
    assert(G.pages.view.viewHtml({ data: viewData('public') }).includes('Public page'), 'the kind is read from the answer when it is not passed');
    const ruleset = viewData('public'); ruleset.guild = { name: 'Fresh', realm: 'Normal', realmKind: 'ruleset', region: 'US', gameVersion: 'forever' };
    assert(text(G.pages.view.viewHtml({ data: ruleset, kind: 'public' })).includes('Normal ruleset - WoW Forever'));
    assert(G.pages.view.viewHtml({ data: null, kind: 'public' }).includes('Loading'));
  });

  await check('view: every name the Worker sends is escaped (guild, team, character, zone, title, item, role, realm)', () => {
    const data = viewData('guest');
    data.guild = { name: HOSTILE + QUOTES, realm: HOSTILE + QUOTES, realmKind: 'realm', region: HOSTILE, gameVersion: 'tbc' };
    data.viewer.role = { id: 'guest', name: HOSTILE + QUOTES }; data.viewer.team = { id: 't1', name: HOSTILE + QUOTES };
    data.sections.roster[0].team.name = HOSTILE + QUOTES; data.sections.roster[0].people[0].name = HOSTILE + QUOTES; data.sections.roster[0].people[0].class = HOSTILE;
    data.sections.raids[0].upcoming[0].zone = HOSTILE + QUOTES; data.sections.raids[0].upcoming[0].title = HOSTILE + QUOTES;
    data.sections.attendance[0].people[0].name = HOSTILE + QUOTES;
    data.sections.loot[0].awards[0].itemName = HOSTILE + QUOTES; data.sections.loot[0].awards[0].winner = HOSTILE + QUOTES; data.sections.loot[0].awards[0].winnerClass = HOSTILE;
    data.sections.loot[0].awards[0].quality = '"><img src=x onerror=1>';
    const out = G.pages.view.viewHtml({ data, kind: 'guest' });
    assertEscaped(out, 'view'); assertNoRawAttrs(out);
    const err = G.pages.view.viewHtml({ error: { status: 410, code: 'link_expired', message: HOSTILE + QUOTES }, kind: 'guest' });
    assertEscaped(err, 'error card');
    assertEscaped(G.pages.view.viewHtml({ error: HOSTILE + QUOTES, kind: 'public' }), 'error text');
  });

  await check('view errors: the server\'s words in a message card; a guest link that no longer works also says to ask for a new one; a lost connection offers Try again', () => {
    const card = (error, kind) => G.pages.view.viewHtml({ error, kind });
    const expired = card({ status: 410, code: 'link_expired', message: 'This guest link has expired.' }, 'guest');
    assert(text(expired).includes('This guest link does not work') && text(expired).includes('This guest link has expired. Ask the officer who sent it for a new link.'));
    assert(!expired.includes('data-action="retry"') && expired.includes('href="#/"'));
    // The Worker's own messages already say it: not twice.
    const real = card({ status: 410, code: 'link_revoked', message: 'An officer turned this guest link off. Ask them for a new one.' }, 'guest');
    assert(text(real).includes('Ask them for a new one.') && !text(real).includes('Ask the officer who sent it for a new link.'));
    const invalid = card(new G.api.ApiError(404, { error: 'link_invalid', message: 'This guest link is not valid. Ask the officer who sent it for a new one.' }), 'guest');
    assert((text(invalid).match(/Ask the officer who sent it for a new/g) || []).length === 1);
    const missing = card({ status: 404, code: 'not_found', message: 'There is no public page here.' }, 'public');
    assert(text(missing).includes('No public page here') && text(missing).includes('There is no public page here.') && !text(missing).includes('Ask the officer'));
    const net = card(new G.api.ApiError(0, null), 'guest');
    assert(text(net).includes('Could not reach Raidsmith') && net.includes('data-action="retry"') && !text(net).includes('Ask the officer'));
    const down = card({ status: 500, message: 'Something went wrong. Try again in a moment.' }, 'public');
    assert(down.includes('data-action="retry"') && text(down).includes('Could not open this page'));
    assert(text(card('Plain words', 'guest')).includes('Plain words Ask the officer who sent it for a new link.'));
    assert(text(card({}, 'guest')).includes('Something went wrong'));
    assert.deepEqual(plain(G.pages.view.errorParts({ status: 404, message: 'x' }, 'public')), { title: 'No public page here', text: 'x', retry: false });
  });

  function viewWindow() {
    const calls = [];
    ctx.window = { history: { replaceState: (s, t, url) => calls.push(['replace', url]) }, location: { pathname: '/', search: '' } };
    return calls;
  }

  await check('view load: a guest link is redeemed first, then the address moves to #/view (replaceState, no new entry), then the view is read', async () => {
    const calls = viewWindow();
    const log = [];
    const data = viewData('guest');
    await withApi({
      post: (url, body) => { log.push(['POST', url, plain(body)]); calls.push(['post']); return okRes({ ok: true }); },
      get: url => { log.push(['GET', url]); calls.push(['get']); return okRes(data); },
    }, async () => {
      const view = await G.pages.view.load({ name: 'guest', token: TOKEN });
      assert.deepEqual(plain(view), { kind: 'guest', gid: null, data: plain(data), error: null });
      assert.equal(G.app.state.view, view);
    });
    assert.deepEqual(log, [['POST', '/auth/guest', { token: TOKEN }], ['GET', '/api/guest']]);
    assert.deepEqual(calls, [['post'], ['replace', '/#/view'], ['get']]);
    assert(!calls.some(c => String(c[1] || '').includes(TOKEN)), 'the token never reaches the address bar again');
    delete ctx.window; G.app.state.view = null;
  });

  await check('view load: #/view reads the guest view, #/public/:gid the public one; a redeem that fails keeps the address and says why', async () => {
    const calls = viewWindow();
    const log = [];
    await withApi({ get: url => { log.push(url); return okRes(url === '/api/guest' ? viewData('guest') : viewData('public')); } }, async () => {
      const guest = await G.pages.view.load({ name: 'view' });
      assert.equal(guest.kind, 'guest');
      const pub = await G.pages.view.load({ name: 'public', gid: 'g_1' });
      assert.deepEqual(plain({ kind: pub.kind, gid: pub.gid, error: pub.error }), { kind: 'public', gid: 'g_1', error: null });
    });
    assert.deepEqual(log, ['/api/guest', '/api/public/g_1']);
    assert.deepEqual(calls, []);
    await withApi({ post: () => rejectWith(410, { error: 'link_expired', message: 'This guest link has expired.' }) }, async () => {
      const bad = await G.pages.view.load({ name: 'guest', token: TOKEN });
      assert.deepEqual(plain(bad), { kind: 'guest', gid: null, data: null, error: { status: 410, code: 'link_expired', message: 'This guest link has expired.' } });
    });
    assert.deepEqual(calls, [], 'the address is left alone when the link does not work');
    await withApi({ get: () => rejectWith(404, { error: 'not_found', message: 'There is no public page here.' }) }, async () => {
      const gone = await G.pages.view.load({ name: 'public', gid: 'g_1' });
      assert.equal(gone.error.status, 404);
      assert(text(G.pages.view.viewHtml(gone)).includes('There is no public page here.'));
    });
    await withApi({ get: () => rejectWith(0, null) }, async () => {
      const lost = await G.pages.view.load({ name: 'view' });
      assert.equal(lost.error.status, 0);
    });
    delete ctx.window; G.app.state.view = null;
  });

  await check('view load: with no window (a script run outside a page) the redeem still works and the view loads', async () => {
    delete ctx.window;
    await withApi({ post: () => okRes({ ok: true }), get: () => okRes(viewData('guest')) }, async () => {
      assert.equal((await G.pages.view.load({ name: 'guest', token: TOKEN })).error, null);
    });
    G.app.state.view = null;
  });

  await check('view: Leave signs the guest cookie out and goes to the start; a failed Leave stays and says why', async () => {
    const s = G.app.state;
    s.view = { kind: 'guest', gid: null, data: viewData('guest'), error: null };
    clearFields(); const alertEl = field('view-alert');
    const button = el();
    await withApi({ del: url => { assert.equal(url, '/auth/guest'); return okRes({ ok: true }); } }, async probe => {
      G.handlers.click['view-leave'](button);
      assert.equal(button.disabled, true);
      await settle();
      assert.deepEqual(probe.hashes, ['#/']);
      assert.equal(s.view, null);
    });
    const again = el();
    await withApi({ del: () => rejectWith(0, null) }, async probe => {
      G.handlers.click['view-leave'](again);
      await settle();
      assert.deepEqual(probe.hashes, []);
      assert.equal(again.disabled, false);
      assert(alertEl.textContent.includes('Could not reach Raidsmith'));
    });
    clearFields();
  });

  // =========================================================================
  // People page
  const PEOPLE_GD = () => guildData({ 'guild.access': 'guild', 'guild.roles': 'guild' });
  const peopleHtml = (data, gd) => G.pages.people.peopleHtml({ guildData: gd || PEOPLE_GD(), data, sort: { column: 'roles', dir: 'asc' }, query: '', now: T0 });

  await check('People: Sync now only where the Worker says so, with a name for screen readers; Sync everyone only with a bot, a mapping and guild.access', () => {
    const out = peopleHtml(peopleData());
    assert.equal((out.match(/data-action="person-sync"/g) || []).length, 2, 'the table row and the phone card of the one person');
    assert(out.includes('data-uid="u2" data-key="sync-u2" aria-label="Sync Discord roles for Bob B">Sync now</button>'));
    assert(!/data-action="person-sync"[^>]*data-uid="u3"/.test(out));
    assert(out.includes('data-action="people-sync-all"') && out.includes('>Sync everyone who signed in<'));
    for (const discord of [{ configured: false, mapped: 2 }, { configured: true, mapped: 0 }, undefined]) {
      assert(!peopleHtml(peopleData({ discord })).includes('people-sync-all'), JSON.stringify(discord));
    }
    assert(!peopleHtml(peopleData(), guildData({ 'guild.roles': 'guild' })).includes('people-sync-all'), 'guild.access is needed');
    const old = peopleHtml({ people: [entry('u2', 'Bob B', [])], removed: [], signedInCount: 1 });
    assert(!old.includes('person-sync') && !old.includes('people-sync-all'), 'an answer without the new fields');
    assertNoRawAttrs(out);
  });

  await check('People: role chips show custom roles by name and Discord-only roles with (Discord); the sort puts custom roles between Team Lead and Member', () => {
    const data = peopleData({ people: [
      entry('u1', 'Zed Z', []),
      entry('u2', 'Ann A', [{ role: 'cr_a', name: 'Loot council' }]),
      entry('u3', 'Bea B', [{ role: 'team_lead', teamId: 't1', fromDiscord: true }, { role: 'cr_b', name: 'Raid leader', teamId: 't2' }]),
      entry('u4', 'Cy C', [{ role: 'officer' }]),
    ] });
    const out = peopleHtml(data);
    const names = [...out.matchAll(/<td><span class="gs-person"><span class="gs-avatar[^>]*>[^<]*<\/span><span class="gs-person-text"><span class="gs-person-line"><span class="gs-person-name">([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(names, ['Cy C', 'Bea B', 'Ann A', 'Zed Z']);
    assert(out.includes('<span class="gs-person-roles">Loot council</span>') && !out.includes('gs-chips') && out.includes('Team Lead: Alpha (Discord)') && out.includes('Raid leader - Bravo'));
  });

  await check('Edit roles dialog: the old three-argument call is unchanged; the boxes show what was set by hand and Discord-only roles are listed apart', () => {
    const e = entry('u2', 'Bob B', [{ role: 'officer' }, { role: 'team_lead', teamId: 't1' }]);
    const old = G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember');
    assert(/id="dlg-role-officer" name="officer" checked/.test(old) && /name="teamLead" value="t1" checked/.test(old) && !old.includes('Other roles') && !old.includes('From Discord') && !old.includes('data-custom'));
    const discordOnly = entry('u2', 'Bob B', [{ role: 'officer', fromDiscord: true }, { role: 'team_lead', teamId: 't2', fromDiscord: true }, { role: 'cr_raid', name: 'Raid leader', teamId: 't1', fromDiscord: true }]);
    const out = G.pages.people.rolesDialogHtml(discordOnly, TEAMS, 'Ember');
    assert(!/id="dlg-role-officer" name="officer" checked/.test(out) && !/name="teamLead"[^>]*checked/.test(out), 'Discord-given roles are not ticked');
    assert(text(out).includes('From Discord: Officer, Team Lead: Bravo, Raid leader - Alpha.') && out.includes('class="gs-fine gs-from-discord"') && text(out).includes('Tick its box to keep it.'));
    const both = entry('u2', 'Bob B', [{ role: 'officer' }]);
    assert(/id="dlg-role-officer" name="officer" checked/.test(G.pages.people.rolesDialogHtml(both, TEAMS, 'Ember')) && !G.pages.people.rolesDialogHtml(both, TEAMS, 'Ember').includes('From Discord'), 'held by hand and by Discord shows once, as theirs');
    assertEscaped(G.pages.people.rolesDialogHtml(entry('u2', HOSTILE, [{ role: 'cr_x', name: HOSTILE + QUOTES, teamId: 't1', fromDiscord: true }]), TEAMS, HOSTILE + QUOTES), 'discord line');
  });

  await check('Edit roles dialog: "Other roles" lists the guild\'s own roles, one box per active team for a role given per team; the form says it carries them only when it lists them', () => {
    const own = rolesData().roles.filter(r => r.kind === 'custom');
    const e = entry('u2', 'Bob B', [{ role: 'cr_raid', name: 'Raid leader', teamId: 't2' }, { role: 'cr_loot', name: 'Loot council' }]);
    const out = G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', own);
    assert(out.includes('<legend class="gs-legend">Other roles</legend>') && out.includes(' data-custom="1"'));
    const boxes = [...out.matchAll(/<input type="checkbox" id="(dlg-role-custom-[^"]+)" name="customRole" data-role="([^"]*)" data-team="([^"]*)"( checked)?><label for="[^"]+">([^<]*)</g)].map(m => [m[2], m[3], !!m[4], m[5]]);
    assert.deepEqual(boxes, [['cr_raid', 't1', false, 'Raid leader: Alpha'], ['cr_raid', 't2', true, 'Raid leader: Bravo'], ['cr_loot', '', true, 'Loot council']], 'active teams only; held boxes ticked');
    assert(!out.includes('Old'), 'archived teams get no box');
    assert((text(out).match(/Other roles/g) || []).length === 1);
    assert(!G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', []).includes('Other roles') && !G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', []).includes('data-custom'));
    assert(!G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', rolesData().roles.filter(r => r.kind === 'builtin')).includes('Other roles'), 'built-in roles are not listed here');
    assert(G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', [{ id: 'cr_x', name: 'No kind', needsTeam: false }]).includes('No kind'), 'a role list without kind is read by its id');
    const noTeams = G.pages.people.rolesDialogHtml(e, [{ id: 't3', name: 'Old', archived: true }], 'Ember', own);
    assert(text(noTeams).includes('Raid leader is given for one team, and there are no active teams.') && noTeams.includes('name="customRole" data-role="cr_loot"'));
    const readOnly = G.pages.people.rolesDialogHtml(Object.assign({}, e, { actions: { editRoles: false } }), TEAMS, 'Ember', own);
    assert(/<fieldset class="gs-fieldset gs-other-roles" disabled>/.test(readOnly) && !readOnly.includes('type="submit"'));
    assertEscaped(G.pages.people.rolesDialogHtml(e, TEAMS, 'Ember', [Object.assign({}, own[0], { name: HOSTILE + QUOTES })]), 'own role name');
    assertNoRawAttrs(out);
  });

  const rolesFormEls = (officer) => ({ officer: { checked: officer } });
  const peopleFormLists = (leads, customs) => ({ 'input[name="teamLead"]:checked': leads.map(v => ({ value: v })), 'input[name="customRole"]:checked': customs.map(([r, t]) => el({ 'data-role': r, 'data-team': t })) });

  await check('roles-form: officer and team leads are sent as before; `roles` goes along only when the dialog listed the guild\'s own roles', async () => {
    const s = G.app.state;
    s.guilds.g1 = PEOPLE_GD(); s.currentGid = 'g1'; s.people.g1 = peopleData();
    const sent = [];
    const reply = peopleData();
    await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return okRes(reply); } }, async () => {
      G.handlers.submit['roles-form'](Object.assign(formEl({ 'data-uid': 'u2' }, rolesFormEls(true), peopleFormLists(['t1'], [])), {}));
      await settle();
      G.handlers.submit['roles-form'](formEl({ 'data-uid': 'u2', 'data-custom': '1' }, rolesFormEls(false), peopleFormLists([], [['cr_raid', 't2'], ['cr_loot', '']])));
      await settle();
      G.handlers.submit['roles-form'](formEl({ 'data-uid': 'u3', 'data-custom': '1' }, rolesFormEls(false), peopleFormLists([], [])));
      await settle();
    });
    assert.deepEqual(sent, [
      ['/api/guild/g1/people/u2/roles', { officer: true, teamLeadTeamIds: ['t1'] }],
      ['/api/guild/g1/people/u2/roles', { officer: false, teamLeadTeamIds: [], roles: [{ roleId: 'cr_raid', teamId: 't2' }, { roleId: 'cr_loot', teamId: null }] }],
      ['/api/guild/g1/people/u3/roles', { officer: false, teamLeadTeamIds: [], roles: [] }],
    ]);
    assert.equal('roles' in sent[0][1], false);
    s.people.g1 = null;
  });

  await check('Edit roles click: the dialog gets the guild\'s own roles from state.rolesList (the whole answer or just the list), and none when it was not loaded', async () => {
    const s = G.app.state;
    s.guilds.g1 = PEOPLE_GD(); s.currentGid = 'g1'; s.people.g1 = peopleData();
    await withApi({}, async probe => {
      s.rolesList = {};
      G.handlers.click['person-edit-roles'](el({ 'data-uid': 'u2' }));
      s.rolesList = { g1: rolesData() };
      G.handlers.click['person-edit-roles'](el({ 'data-uid': 'u2' }));
      s.rolesList = { g1: rolesData().roles };
      G.handlers.click['person-edit-roles'](el({ 'data-uid': 'u2' }));
      assert(!probe.opened[0].html.includes('Other roles'));
      assert(probe.opened[1].html.includes('Other roles') && probe.opened[1].html.includes('Raid leader: Alpha') && probe.opened[1].html.includes('data-custom="1"'));
      assert(probe.opened[2].html.includes('Other roles'));
    });
    s.rolesList = {}; s.people.g1 = null;
  });

  await check('Sync now: a changed, unchanged or skipped answer is worded with the name; the people list is replaced; errors go to the page alert', async () => {
    const s = G.app.state;
    s.guilds.g1 = PEOPLE_GD(); s.currentGid = 'g1'; s.people.g1 = peopleData();
    const sent = [];
    const answer = status => Object.assign(peopleData({ people: [entry('u2', 'Bob B', [{ role: 'officer' }])] }), { sync: Object.assign({ status, reason: null, added: 2, removed: 1 }, status === 'skipped' ? { reason: 'manual' } : {}) });
    for (const [status, words] of [['changed', 'Synced Bob B: 2 roles added, 1 removed.'], ['unchanged', 'Bob B already matches Discord.'], ['skipped', 'Bob B was left as is.']]) {
      const button = el({ 'data-uid': 'u2' });
      await withApi({ post: url => { sent.push(url); return okRes(answer(status)); } }, async probe => {
        G.handlers.click['person-sync'](button);
        assert.equal(button.disabled, true);
        await settle();
        assert.equal(s.notice, words);
        assert.equal(probe.renders(), 1);
        assert.equal(s.people.g1.people.length, 1);
        assert.equal('sync' in s.people.g1, false, 'the sync part is not kept in the list');
      });
    }
    assert.deepEqual(sent, ['/api/guild/g1/people/u2/sync', '/api/guild/g1/people/u2/sync', '/api/guild/g1/people/u2/sync']);
    await withApi({ post: () => okRes(Object.assign(peopleData(), { sync: { status: 'changed', added: 1, removed: 0 } })) }, async () => {
      G.handlers.click['person-sync'](el({ 'data-uid': 'u2' })); await settle();
    });
    assert.equal(s.notice, 'Synced Bob B: 1 role added, 0 removed.');
    for (const [status, code, message] of [[409, 'bot_not_in_server', 'The bot is not in your Discord server.'], [409, 'no_mapping', 'Map a Discord role first.'], [409, 'no_discord', 'That person has no Discord.'], [502, 'discord_unavailable', 'Discord did not answer.'], [400, 'bot_not_configured', 'The bot is not set up.']]) {
      s.pageAlert = ''; s.notice = '';
      const button = el({ 'data-uid': 'u2' });
      await withApi({ post: () => rejectWith(status, { error: code, message }) }, async () => { G.handlers.click['person-sync'](button); await settle(); });
      assert.equal(s.pageAlert, message, code);
      assert.equal(button.disabled, false);
      assert.equal(s.notice, '');
    }
    s.people.g1 = null; s.notice = ''; s.pageAlert = '';
  });

  await check('Sync everyone: the call repeats with the next cursor until it is null, then the list is read again and the totals are worded', async () => {
    const s = G.app.state;
    s.guilds.g1 = PEOPLE_GD(); s.currentGid = 'g1'; s.people.g1 = peopleData(); s.notice = '';
    const posts = [];
    const pages = [
      { processed: 25, changed: 4, unchanged: 20, skipped: 1, failed: 0, problem: null, next: 'u_page2' },
      { processed: 25, changed: 2, unchanged: 22, skipped: 0, failed: 1, problem: null, next: 'u_page3' },
      { processed: 7, changed: 1, unchanged: 6, skipped: 0, failed: 1, problem: null, next: null },
    ];
    const fresh = peopleData({ signedInCount: 57 });
    const gets = [];
    const button = el();
    await withApi({
      post: (url, body) => { posts.push([url, plain(body)]); return okRes(pages[posts.length - 1]); },
      get: url => { gets.push(url); return okRes(fresh); },
    }, async probe => {
      G.handlers.click['people-sync-all'](button);
      assert.equal(button.disabled, true);
      await settle();
      assert.deepEqual(posts, [['/api/guild/g1/discord/sync', {}], ['/api/guild/g1/discord/sync', { after: 'u_page2' }], ['/api/guild/g1/discord/sync', { after: 'u_page3' }]]);
      assert.deepEqual(gets, ['/api/guild/g1/people']);
      assert.equal(s.people.g1, fresh);
      assert.equal(s.notice, 'Synced 57 people: 7 changed. 2 could not be read.');
      assert.equal(probe.renders(), 1);
    });
    // no failures: no "could not be read"; one call when next is null at once
    s.notice = '';
    await withApi({ post: () => okRes({ processed: 1, changed: 0, unchanged: 1, skipped: 0, failed: 0, problem: null, next: null }), get: () => okRes(fresh) }, async () => {
      G.handlers.click['people-sync-all'](el()); await settle();
    });
    assert.equal(s.notice, 'Synced 1 person: 0 changed.');
    // a problem that will repeat stops the run
    s.notice = '';
    const calls = [];
    await withApi({ post: () => { calls.push(1); return okRes({ processed: 3, changed: 1, unchanged: 0, skipped: 0, failed: 2, problem: 'rate_limited', next: 'u_more' }); }, get: () => okRes(fresh) }, async () => {
      G.handlers.click['people-sync-all'](el()); await settle();
    });
    assert.equal(calls.length, 1, 'a problem stops the loop even with a cursor');
    assert.equal(s.notice, 'Synced 3 people: 1 changed. 2 could not be read. It stopped early: Discord asked for a pause, so try again in a minute.');
    // a cursor that does not move cannot loop for ever
    const loop = [];
    await withApi({ post: () => { loop.push(1); return okRes({ processed: 1, changed: 0, unchanged: 1, skipped: 0, failed: 0, problem: null, next: 'u_same' }); }, get: () => okRes(fresh) }, async () => {
      G.handlers.click['people-sync-all'](el()); await settle();
    });
    assert.equal(loop.length, 2);
    s.people.g1 = null; s.notice = '';
  });

  await check('Sync everyone: an error shows its message in the page alert (after the people already synced are read again); the button is usable again', async () => {
    const s = G.app.state;
    s.guilds.g1 = PEOPLE_GD(); s.currentGid = 'g1'; s.people.g1 = peopleData(); s.notice = ''; s.pageAlert = '';
    for (const [status, code, message] of [[409, 'no_mapping', 'Map a Discord role to a Raidsmith role first.'], [429, 'rate_limited', 'Too many syncs.'], [502, 'discord_unavailable', 'Discord did not answer.']]) {
      s.pageAlert = '';
      const button = el();
      let reads = 0;
      await withApi({ post: () => rejectWith(status, { error: code, message }), get: () => { reads++; return okRes(peopleData()); } }, async () => { G.handlers.click['people-sync-all'](button); await settle(); });
      assert(s.pageAlert.startsWith(message), code + ': ' + s.pageAlert);
      assert.equal(button.disabled, false);
      assert.equal(reads, 0, 'nothing was synced, nothing to read again');
    }
    s.pageAlert = ''; s.notice = '';
    let step = 0;
    const button = el();
    await withApi({
      post: () => (++step === 1 ? okRes({ processed: 25, changed: 3, unchanged: 22, skipped: 0, failed: 0, problem: null, next: 'u_next' }) : rejectWith(502, { error: 'discord_unavailable', message: 'Discord did not answer.' })),
      get: () => okRes(peopleData({ signedInCount: 9 })),
    }, async () => { G.handlers.click['people-sync-all'](button); await settle(); });
    assert.equal(s.pageAlert, 'Discord did not answer.');
    assert.equal(s.notice, 'Synced 25 people: 3 changed.');
    assert.equal(s.people.g1.signedInCount, 9);
    s.people.g1 = null; s.notice = ''; s.pageAlert = '';
  });

  // =========================================================================
  // source hygiene
  await check('the new files: no inline style or handler, no non-ASCII text, one Guild namespace, no modules, every gs- class has CSS, the scripts load in order in all three pages', () => {
    const files = NEW_FILES.map(n => 'js/guild/' + n + '.js');
    for (const f of files.concat(['tests/guild/guild-roles-ui-tests.js'])) {
      read(f).split('\n').forEach((line, i) => {
        assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(line), `${f}:${i + 1} inline style`);
        assert(!/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(line) || f === 'tests/guild/guild-roles-ui-tests.js', `${f}:${i + 1} inline handler`);
        assert(!/setAttribute\(\s*['"`](?:style|on[a-z]+)['"`]/i.test(line), `${f}:${i + 1} setAttribute`);
        assert(!/[^\x00-\x7f]/.test(line), `${f}:${i + 1} non-ASCII`);
      });
    }
    for (const f of files) {
      const src = read(f);
      assert(/window\.Guild = window\.Guild \|\| \{\}/.test(src) && !/^\s*(import|export)\s/m.test(src) && src.includes("'use strict'"), f);
    }
    const used = new Set();
    for (const f of files.concat(['js/guild/pages-settings-people.js', 'js/guild/ui.js', 'js/guild/shell.js'])) {
      const src = read(f);
      for (const m of src.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
      for (const m of src.matchAll(/'(gs-[a-z0-9_-]+(?: gs-[a-z0-9_-]+)*)'/g)) for (const c of m[1].split(' ')) used.add(c);
      for (const m of src.matchAll(/class="((?:gs-[a-z0-9_-]+ ?)+)' \+/g)) for (const c of m[1].trim().split(' ')) used.add(c);
    }
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    const notClasses = ['gs-page-alert', 'gs-team-select-drawer', 'gs-team-select-phone'];
    const baseStyled = ['gs-chip-officer', 'gs-chip-team_lead'];
    assert.deepEqual([...used].filter(c => !/-$/.test(c) && !defined.has(c) && !notClasses.includes(c) && !baseStyled.includes(c)), [], 'classes with no CSS');
    const phone = css.slice(css.lastIndexOf('/* -- Roles, Discord roles, guest links'));
    for (const c of ['.gs-role-card', '.gs-perm-row', '.gs-perm-select', '.gs-table-dmap', '.gs-table-guests', '.gs-table-view', '.gs-copy-row', '.gs-view-head', '.gs-dmap-team[hidden]']) assert(phone.includes(c), c);
    assert(/@media \(max-width: 600px\) \{[\s\S]*\.gs-perm-select \{ height: 44px; \}/.test(phone), 'touch targets on a phone');
    assert(/\.gs-perm-row \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(phone));
    const at = n => GUILD_SCRIPTS.indexOf('/js/guild/' + n + '.js');
    for (const n of NEW_FILES) assert(at(n) > at('pages-settings-people') && at(n) < at('app'), n);
    assert(at('pages-settings-people') < at('pages-settings-roles') && at('pages-settings-roles') < at('pages-settings-discord') && at('pages-settings-discord') < at('pages-settings-links') && at('pages-settings-links') < at('pages-settings-public') && at('pages-settings-public') < at('pages-view'));
    const order = page => guildScriptsOf(read(page));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert.deepEqual(order(page), GUILD_SCRIPTS.filter(s => s.indexOf('/js/guild/') === 0), page);
  });

  // =========================================================================
  // app.js: the routes, with fake documents
  class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...n) { n.forEach(x => this.set.add(x)); }
    remove(...n) { n.forEach(x => this.set.delete(x)); }
    contains(n) { return this.set.has(n); }
    toggle(n, force) { const on = force === undefined ? !this.set.has(n) : !!force; if (on) this.set.add(n); else this.set.delete(n); return on; }
  }
  class FakeEl {
    constructor(id, attrs) { this.id = id || ''; this.attrs = Object.assign({}, attrs || {}); this.classList = new FakeClassList(); this.hidden = false; this._html = ''; this.writes = 0; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.writes++; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
    closest() { return null; }
  }
  const IDS = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner', 'gs-main', 'planner-root', 'planner-notice', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];
  function target(attrs) {
    const t = new FakeEl('', attrs);
    t.closest = q => { const m = /^\[([\w-]+)\]$/.exec(q); if (m) return Object.prototype.hasOwnProperty.call(attrs, m[1]) ? t : null; if (q === '.gs-scope') return t; return null; };
    return t;
  }

  // routes: { url or 'METHOD url': (init) => ({ status, body }) | { status, body } }
  function makeEnv(opts) {
    const o = Object.assign({ url: '/', routes: {} }, opts || {});
    const els = {};
    IDS.forEach(id => { els[id] = new FakeEl(id); });
    els['gs-main'].hidden = true;
    const body = new FakeEl('', { 'data-page': 'app' });
    body.classList.add('guild-page', 'shell-pending');
    const store = {};
    const localStorage = { getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    const listeners = { document: {}, window: {} };
    const on = which => (name, fn, capture) => { if (capture === true) return; (listeners[which][name] = listeners[which][name] || []).push(fn); };
    const fire = (which, name, ev) => (listeners[which][name] || []).slice().forEach(fn => fn(ev || {}));
    const loc = { pathname: '/', search: '', _hash: '' };
    const setUrl = url => { const hi = url.indexOf('#'); const base = hi < 0 ? url : url.slice(0, hi); const qi = base.indexOf('?'); loc.pathname = qi < 0 ? base : base.slice(0, qi); loc.search = qi < 0 ? '' : base.slice(qi); loc._hash = hi < 0 ? '' : url.slice(hi); };
    setUrl(o.url);
    Object.defineProperty(loc, 'hash', { get: () => loc._hash, set: v => { loc._hash = v.charAt(0) === '#' ? v : '#' + v; fire('window', 'popstate', {}); fire('window', 'hashchange', {}); } });
    Object.defineProperty(loc, 'href', { get: () => 'http://localhost' + loc.pathname + loc.search + loc._hash });
    const history = { calls: [], pushState: (s, t, url) => { history.calls.push(['push', url]); setUrl(url); }, replaceState: (s, t, url) => { history.calls.push(['replace', url]); setUrl(url); } };
    const fetchCalls = [];
    const fetchFn = (url, init) => {
      const method = (init && init.method) || 'GET';
      fetchCalls.push({ url, method, body: init && init.body });
      const handler = o.routes[method + ' ' + url] || o.routes[url];
      if (!handler) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
      const r = typeof handler === 'function' ? handler(init) : handler;
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(r.body == null ? {} : r.body)) });
    };
    const documentFake = { body, activeElement: null, title: 'Raidsmith', getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: on('document') };
    const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout, clearTimeout };
    Object.assign(sandbox, { window: sandbox, document: documentFake, location: loc, history, localStorage, fetch: fetchFn, addEventListener: on('window'), scrollTo: () => {}, whatsNewSeen: () => true });
    vm.createContext(sandbox);
    for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
    return {
      G: sandbox.Guild, sandbox, els, loc, history, fetchCalls, store, fire,
      html: id => els[id].innerHTML,
      main: () => els['gs-main'].innerHTML,
      fetched: needle => fetchCalls.filter(c => c.url.indexOf(needle) >= 0),
      click: attrs => { const ev = { target: target(attrs), button: 0, defaultPrevented: false, preventDefault() {} }; fire('document', 'click', ev); return ev; },
    };
  }
  const USER = { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null, initials: 'AL', prefs: { sidebarCollapsed: false, planSidebarCollapsed: true, lastGuildId: null } };
  const meBody = extra => Object.assign({ user: Object.assign({}, USER, { prefs: Object.assign({}, USER.prefs) }), guilds: [{ id: 'g1', name: 'Ember' }], create: { allowed: false }, removedFrom: [], deleteImpact: { handOverFirst: [], guildsDeleted: [] } }, extra || {});
  const guildBody = can => ({ guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', gameVersion: 'tbc', region: 'US' }, teams: [{ id: 't1', name: 'Alpha', size: 25, archived: false }, { id: 't2', name: 'Bravo', size: 25, archived: false }], me: { roles: [{ role: 'officer' }], can } });
  const OFFICER = { 'roster.view': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild', 'guild.roles': 'guild' };

  await check('app: #/public/:gid shows the page to a signed-out visitor with no sign-in card, no providers read and the address left alone', async () => {
    const env = makeEnv({ url: '/#/public/g1', routes: { '/auth/me': { status: 401, body: { error: 'signed_out' } }, '/api/public/g1': { status: 200, body: viewData('public') } } });
    await settle();
    const main = env.main();
    assert(main.includes('Ember') && main.includes('Public page') && main.includes('Thoren'));
    assert(!main.includes('Continue with Discord') && !main.includes('Your guild\'s roster and attendance'));
    assert.equal(env.loc.hash, '#/public/g1');
    assert.equal(env.fetched('/auth/providers').length, 0);
    assert.equal(env.fetched('/auth/me').length, 1, 'the session is asked once, quietly');
    assert.equal(env.fetched('/api/public/g1').length, 1);
    assert(env.html('shell-topbar-lead').includes('Public page') && env.html('shell-topbar-account').includes('Sign in'));
    assert.equal(env.html('shell-rail'), '');
    assert(!env.html('shell-sidebar').includes('Roster'));
    assert(env.G.app.state.view.data.guild.name === 'Ember');
    assert.equal(env.sandbox.document.title, 'Public page - Ember - Raidsmith guild');
  });

  await check('app: the public page shows even before (or without) the answer to the session question', async () => {
    const env = makeEnv({ url: '/#/public/g1', routes: { '/auth/me': () => new Promise(() => {}), '/api/public/g1': { status: 200, body: viewData('public') } } });
    await settle();
    assert(env.main().includes('Thoren'), 'the view does not wait for /auth/me');
    const down = makeEnv({ url: '/#/public/g1', routes: { '/auth/me': { status: 500, body: { error: 'x' } }, '/api/public/g1': { status: 200, body: viewData('public') } } });
    await settle();
    assert(down.main().includes('Thoren') && !down.main().includes('Could not load Raidsmith'), 'a failed session question does not hide the page');
  });

  await check('app: a missing public page is a message, not a sign-in card', async () => {
    const env = makeEnv({ url: '/#/public/g9', routes: { '/auth/me': { status: 401, body: {} }, '/api/public/g9': { status: 404, body: { error: 'not_found', message: 'There is no public page here.' } } } });
    await settle();
    assert(env.main().includes('No public page here') && env.main().includes('There is no public page here.') && !env.main().includes('Continue with Discord'));
    assert.equal(env.loc.hash, '#/public/g9');
  });

  await check('app: #/guest/<token> redeems the link, moves the address to #/view without adding a history entry, and shows the guest view', async () => {
    const env = makeEnv({
      url: '/#/guest/' + TOKEN,
      routes: {
        '/auth/me': { status: 401, body: {} },
        'POST /auth/guest': { status: 200, body: { ok: true } },
        '/api/guest': { status: 200, body: viewData('guest') },
      },
    });
    await settle();
    assert.equal(env.loc.hash, '#/view');
    assert.deepEqual(env.history.calls, [['replace', '/#/view']]);
    const order = env.fetchCalls.filter(c => c.url !== '/auth/me').map(c => c.method + ' ' + c.url);
    assert.deepEqual(order, ['POST /auth/guest', 'GET /api/guest']);
    assert.deepEqual(JSON.parse(env.fetchCalls.find(c => c.url === '/auth/guest').body), { token: TOKEN });
    const main = env.main();
    assert(main.includes('Read-only') && main.includes('Guest link') && main.includes('Thoren') && main.includes('data-action="view-leave"'));
    assert(!main.includes(TOKEN) && !env.html('shell-topbar-lead').includes(TOKEN) && !env.sandbox.document.title.includes(TOKEN));
    assert(!main.includes('Continue with Discord'));
    assert(env.html('shell-topbar-lead').includes('Guest view'));
    assert.equal(env.sandbox.document.title, 'Guest view - Ember - Raidsmith guild');
  });

  await check('app: a guest link that does not work shows why, with the address untouched and no sign-in card; Try again on a lost connection', async () => {
    for (const [status, code, message, expectedTitle] of [[410, 'link_expired', 'This guest link has expired.', 'This guest link does not work'], [410, 'link_revoked', 'An officer turned this guest link off. Ask them for a new one.', 'This guest link does not work'], [404, 'link_invalid', 'This guest link is not valid.', 'This guest link does not work']]) {
      const env = makeEnv({ url: '/#/guest/' + TOKEN, routes: { '/auth/me': { status: 401, body: {} }, 'POST /auth/guest': { status, body: { error: code, message } } } });
      await settle();
      const t = text(env.main());
      assert(t.includes(expectedTitle) && t.includes(message), code);
      assert(!t.includes('Continue with Discord'));
      assert.equal(env.fetched('/api/guest').length, 0, 'a link that does not work reads nothing');
      assert.equal(env.loc.hash, '#/guest/' + TOKEN, 'the address is left as it was');
      assert.deepEqual(env.history.calls, []);
    }
    let up = false;
    const env = makeEnv({ url: '/#/guest/' + TOKEN, routes: {
      '/auth/me': { status: 401, body: {} },
      'POST /auth/guest': () => (up ? { status: 200, body: { ok: true } } : { status: 503, body: {} }),
      '/api/guest': { status: 200, body: viewData('guest') },
    } });
    await settle();
    assert(env.main().includes('data-action="retry"'));
    up = true;
    env.click({ 'data-action': 'retry' });
    await settle();
    assert(env.main().includes('Read-only') && env.main().includes('Guest link'));
    assert.equal(env.loc.hash, '#/view');
  });

  await check('app: #/view reads the guest cookie\'s view; without one the Worker\'s message shows; Leave goes back to the sign-in start page', async () => {
    const noCookie = makeEnv({ url: '/#/view', routes: { '/auth/me': { status: 401, body: {} }, '/api/guest': { status: 404, body: { error: 'link_invalid', message: 'This guest link is not valid. Ask the officer who sent it for a new one.' } } } });
    await settle();
    assert(text(noCookie.main()).includes('This guest link is not valid.'));
    const env = makeEnv({ url: '/#/view', routes: { '/auth/me': { status: 401, body: {} }, '/api/guest': { status: 200, body: viewData('guest') }, 'DELETE /auth/guest': { status: 200, body: { ok: true } } } });
    await settle();
    assert(env.main().includes('Leave'));
    env.click({ 'data-action': 'view-leave' });
    await settle();
    assert.equal(env.loc.hash, '#/');
    assert(env.fetchCalls.some(c => c.method === 'DELETE' && c.url === '/auth/guest'));
    assert(env.main().includes('Continue with Discord'), 'after leaving, today\'s sign-in start page');
    assert.equal(env.G.app.state.view, null);
  });

  await check('app: a signed-in member opening a public page keeps their avatar, gets no guild nav and is not redirected; their guild is not fetched', async () => {
    const env = makeEnv({ url: '/#/public/g1', routes: { '/auth/me': { status: 200, body: meBody() }, '/api/public/g1': { status: 200, body: viewData('public') }, '/api/guild/g1': { status: 200, body: guildBody(OFFICER) } } });
    await settle();
    assert(env.html('shell-topbar-account').includes('gs-avatar-btn'));
    assert.equal(env.html('shell-rail'), '');
    assert(!env.html('shell-sidebar').includes('Guild settings') && !env.html('shell-sidebar').includes('>Roster<'));
    assert(env.main().includes('Thoren'));
    assert.equal(env.loc.hash, '#/public/g1');
    assert.equal(env.fetched('/api/guild/g1').length, 0);
    assert.equal(env.html('shell-tabs'), '');
  });

  await check('app: the four new Guild settings tabs load their data and draw inside the settings frame; a role without the permission gets the message, not the tab', async () => {
    const routes = signedIn => Object.assign({
      '/auth/me': { status: 200, body: meBody() },
      '/api/guild/g1': { status: 200, body: guildBody(signedIn) },
      '/api/guild/g1/roles': { status: 200, body: rolesData() },
      '/api/guild/g1/discord': { status: 200, body: discordData() },
      '/api/guild/g1/public': { status: 200, body: publicData() },
      'PATCH /auth/prefs': { status: 200, body: { prefs: USER.prefs } },
    });
    for (const [tab, url, needle, stateKey] of [['roles', '/api/guild/g1/roles', 'Raid leader', 'rolesSettings'], ['discord', '/api/guild/g1/discord', 'Connected: 3 Discord roles', 'discordSettings'], ['public', '/api/guild/g1/public', 'Show a public page', 'publicSettings']]) {
      const env = makeEnv({ url: '/#/g/g1/settings/' + tab, routes: routes(OFFICER) });
      await settle();
      assert.equal(env.fetched(url).length, 1, tab);
      const main = env.main();
      assert(main.includes(needle) && main.includes('Guild settings') && main.includes('aria-current="page"'), tab);
      assert(new RegExp('aria-current="page">' + { roles: 'Roles', discord: 'Discord roles', public: 'Public page' }[tab] + '<').test(main), tab + ' tab is current');
      assert.equal(env.G.app.state[stateKey].gid, 'g1');
      assert.equal(env.G.app.state[stateKey].notice, '');
      assert.equal(env.sandbox.document.title, 'Guild settings - Ember - Raidsmith guild');
    }
    for (const [tab, can] of [['roles', { 'roster.view': 'guild', 'guild.access': 'guild' }], ['discord', { 'roster.view': 'guild', 'guild.access': 'guild' }], ['public', { 'roster.view': 'guild', 'guild.access': 'guild' }], ['links', { 'roster.view': 'guild', 'guild.roles': 'guild' }]]) {
      const env = makeEnv({ url: '/#/g/g1/settings/' + tab, routes: routes(can) });
      await settle();
      assert(text(env.main()).includes('Your role does not include this part of Guild settings.'), tab);
      assert.equal(env.fetchCalls.filter(c => /\/(roles|discord|guest-links|api-keys|join-links|public)$/.test(c.url)).length, 0, tab + ': nothing is read');
    }
    const first = makeEnv({ url: '/#/g/g1/settings', routes: routes({ 'guild.roles': 'guild' }) });
    await settle();
    assert.equal(first.loc.hash, '#/g/g1/settings/people', 'Accounts is still the first tab');
  });

  await check('app: the People tab also reads the guild\'s roles for someone who can manage roles (a failed read leaves the page working); guild.access alone does not read them', async () => {
    const people = peopleData();
    const base = can => ({ '/auth/me': { status: 200, body: meBody() }, '/api/guild/g1': { status: 200, body: guildBody(can) }, '/api/guild/g1/people': { status: 200, body: people }, 'PATCH /auth/prefs': { status: 200, body: { prefs: USER.prefs } } });
    const withRoles = makeEnv({ url: '/#/g/g1/settings/people', routes: Object.assign(base(OFFICER), { '/api/guild/g1/roles': { status: 200, body: rolesData() } }) });
    await settle();
    assert.equal(withRoles.fetched('/api/guild/g1/roles').length, 1);
    assert.equal(withRoles.G.app.state.rolesList.g1.roles.length, 8);
    assert(withRoles.main().includes('Sync everyone who signed in') && withRoles.main().includes('Bob B'));
    const failing = makeEnv({ url: '/#/g/g1/settings/people', routes: base(OFFICER) });
    await settle();
    assert(failing.main().includes('Bob B') && !failing.main().includes('Could not load'), 'the roles read failed (404) and the page still works');
    assert.equal(failing.G.app.state.rolesList.g1, undefined);
    const accessOnly = makeEnv({ url: '/#/g/g1/settings/people', routes: Object.assign(base({ 'roster.view': 'guild', 'guild.access': 'guild' }), { '/api/guild/g1/roles': { status: 200, body: rolesData() } }) });
    await settle();
    assert.equal(accessOnly.fetched('/api/guild/g1/roles').length, 0);
    assert(accessOnly.main().includes('Bob B'));
  });

  await check('app: signing out clears what the new tabs and pages kept', async () => {
    const env = makeEnv({ url: '/#/g/g1/settings/roles', routes: {
      '/auth/me': { status: 200, body: meBody() }, '/api/guild/g1': { status: 200, body: guildBody(OFFICER) }, '/api/guild/g1/roles': { status: 200, body: rolesData() },
      'PATCH /auth/prefs': { status: 200, body: { prefs: USER.prefs } }, 'POST /auth/logout': { status: 200, body: {} },
    } });
    await settle();
    const s = env.G.app.state;
    s.linksSettings = { gid: 'g1', keys: {}, guests: {}, joins: {}, notice: '' }; s.discordSettings = { gid: 'g1', data: {}, notice: '' }; s.publicSettings = { gid: 'g1', data: {}, notice: '' }; s.view = { kind: 'guest' };
    assert(s.rolesSettings && s.rolesList.g1);
    env.click({ 'data-action': 'sign-out' });
    await settle();
    assert.equal(s.rolesSettings, null); assert.deepEqual(plain(s.rolesList), {});
    assert.equal(s.linksSettings, null); assert.equal(s.discordSettings, null); assert.equal(s.publicSettings, null); assert.equal(s.view, null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
