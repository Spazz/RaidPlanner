/**
 * Raidsmith guild UI, PM wave 1 (officer tools) - tests for the Activity log tab, the attendance watch list (policy fields and the team page card),
 * the Home (needs attention) page with its nav item and badge, the Trial review card of the person page, the calendar link dialog of the
 * Raids page, the router and the shell.
 * Run: node tests/guild/guild-wave1-ui-tests.js
 *
 * Same approach as guild-signups-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings
 * and the handlers run against a stubbed G.api and a fake state bag. The mock data follows the Worker contract of the wave (see
 * tasks/reference/guild-pm-wave1-spec.md); guild-wave1-contract-tests.js runs the same pages against the real Worker, and guild-shell-tests.js drives
 * the routes (Home redirect, Activity tab, trial card load) through the real router.
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
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS, guildScriptsOf } = require('../guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
// A fake document: elements are registered by id so the handlers' focus / live-region / error-slot writes can be read back.
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
function fakeEl(id, over) {
  const e = Object.assign({ id, textContent: '', hidden: false, focused: 0, selected: false, attrs: {}, focus() { e.focused++; }, select() { e.selected = true; }, setAttribute(k, v) { e.attrs[k] = v; } }, over || {});
  els[id] = e;
  return e;
}
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const ws = s => String(s).replace(/[  ]/g, ' '); // newer ICU writes a narrow no-break space before AM / PM

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

// ── fixtures ─────────────────────────────────────────────────────
const T1 = { id: 't1', name: 'Team KJ' };
const T2 = { id: 't2', name: 'Weekend team' };
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'loot.edit': 'guild', 'audit.view': 'guild', 'attendance.policy': 'guild' };
const LEAD_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': ['t1'], 'attendance.view': ['t1'], 'attendance.review': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': 'guild', 'signups.self': ['t1'] };
function gd(can, over, teams) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: (teams || [T1, T2]).map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [], can },
    attendanceFlags: {},
  }, over || {});
}
const ONE_TEAM = [T1];

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const ApiErr = (status, code, extra) => new ctx.Guild.api.ApiError(status, Object.assign({ error: code, message: 'Server says so.' }, extra || {}));
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});
// A form for runDialog / the submit handlers: named fields, no buttons.
const form = (fields) => ({ elements: Object.keys(fields).reduce((o, k) => { o[k] = Object.assign({ focus() { this.focused = (this.focused || 0) + 1; } }, fields[k]); return o; }, {}), querySelectorAll: () => [], querySelector: () => null, closest: () => null, getAttribute: () => null });

function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, person: S.person, teamByGuild: S.teamByGuild, attention: S.attention };
    const savedApp = { requireSignin: ctx.Guild.app.requireSignin, showFailure: ctx.Guild.app.showFailure, teamFor: ctx.Guild.app.teamFor };
    const savedOpen = ctx.Guild.ui.openDialog;
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.person = null; S.teamByGuild = {}; S.attention = {};
    Object.keys(els).forEach(k => delete els[k]);
    try { await fn(S); } finally { Object.assign(S, saved); Object.assign(ctx.Guild.app, savedApp); ctx.Guild.ui.openDialog = savedOpen; }
  };
}

(async () => {
  // ═══ router ═════════════════════════════════════════════════════
  await check('router: #/g/:gid and #/g/:gid/home are the Home section; Home formats without a suffix; the Activity tab round-trips', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1'), { name: 'section', gid: 'g1', section: 'home' });
    assert.deepEqual(p('#/g/g1/'), { name: 'section', gid: 'g1', section: 'home' });
    assert.deepEqual(p('#/g/g1/home'), { name: 'section', gid: 'g1', section: 'home' });
    assert.deepEqual(p('#/g/g1/roster'), { name: 'section', gid: 'g1', section: 'roster' });
    assert.deepEqual(p('#/g/g1/settings/activity'), { name: 'settings', gid: 'g1', tab: 'activity' });
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'home' }), '#/g/g1');
    assert.equal(G.router.format({ name: 'section', gid: 'g_A-1', section: 'home', team: 't1', view: 'items' }), '#/g/g_A-1', 'no query on Home');
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'activity' }), '#/g/g1/settings/activity');
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'bogus' }), '#/g/g1/roster', 'an unknown section still falls back to Roster');
    for (const section of G.router.SECTIONS) {
      const r = { name: 'section', gid: 'g_Ab-9', section };
      assert.deepEqual(plain(G.router.parse(G.router.format(r))), r, section);
    }
    for (const tab of G.router.TABS) {
      const r = { name: 'settings', gid: 'g1', tab };
      assert.deepEqual(plain(G.router.parse(G.router.format(r))), r, tab);
    }
    assert(G.router.SECTIONS.includes('home') && G.router.TABS.includes('activity'));
  });

  await check('router: Home and the Activity tab take no extra path or unknown tab', () => {
    for (const h of ['#/g/g1/home/x', '#/g/g1/home/roster', '#/g/g1/settings/audit', '#/g/g1/settings/activity/x', '#/g/<x>', '#/g/a%2Fb']) {
      assert.equal(G.router.parse(h).name, 'notfound', h);
    }
    assert.deepEqual(plain(G.router.parse('#/g/g1/home?team=t1')), { name: 'section', gid: 'g1', section: 'home' }, 'a query on Home is ignored');
  });

  // ═══ shell ══════════════════════════════════════════════════════
  const shellCtx = (can, over) => Object.assign({ section: 'guild', page: 'app', me: { user: { id: 'u1', username: 'alice', displayName: 'Alice' }, guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false } },
    route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: gd(can), teamId: 't1' }, over || {});
  const keys = items => plain(items.map(i => i.key)); // plain: the vm's arrays are not this realm's

  await check('shell: canSeeAttention is any one of attendance.review, roster.edit, raids.edit, loot.edit (guild or a non-empty team list)', () => {
    for (const action of ['attendance.review', 'roster.edit', 'raids.edit', 'loot.edit']) {
      assert.equal(G.shell.canSeeAttention({ [action]: 'guild' }), true, action + ' guild');
      assert.equal(G.shell.canSeeAttention({ [action]: ['t1'] }), true, action + ' team list');
      assert.equal(G.shell.canSeeAttention({ [action]: [] }), false, action + ' empty list');
    }
    for (const can of [MEMBER_CAN, {}, null, undefined, { 'roster.view': 'guild', 'raids.view': 'guild', 'loot.view': 'guild', 'attendance.view': 'guild', 'signups.self': ['t1'], 'audit.view': 'guild' }]) {
      assert.equal(G.shell.canSeeAttention(can), false, JSON.stringify(can));
    }
  });

  await check('shell: audit.view alone opens Guild settings with one tab, Activity, after Battle.net; nobody else sees it', () => {
    const tabs = can => plain(G.shell.settingsTabs(can).map(t => t.tab));
    assert.deepEqual(tabs({ 'audit.view': 'guild' }), ['activity']);
    assert.equal(G.shell.settingsTabs({ 'audit.view': 'guild' })[0].label, 'Activity');
    assert.equal(G.shell.canSeeSettings({ 'audit.view': 'guild' }), true);
    assert.deepEqual(tabs({ 'guild.teams': 'guild', 'audit.view': 'guild' }), ['general', 'teams', 'notifications', 'applications', 'battlenet', 'activity']);
    assert.deepEqual(tabs(OFFICER_CAN), ['general', 'teams', 'schedule', 'attendance', 'notifications', 'applications', 'battlenet', 'activity']);
    assert(!tabs({ 'guild.teams': 'guild', 'attendance.policy': 'guild' }).includes('activity'));
    assert.equal(G.shell.canSeeSettings({ 'audit.edit': 'guild' }), false);
    const nav = G.shell.navItems('g1', { 'audit.view': 'guild' }, 0, '').find(i => i.key === 'settings');
    assert(nav && nav.href === '#/g/g1/settings', 'the Guild settings item opens the bare address');
    assert.equal(G.shell.settingsTabs({ 'audit.view': 'guild' })[0].tab, 'activity', 'and the first page there is the first one the viewer has');
  });

  await check('shell: Home is the first sidebar and drawer item for every guild member (the member Home or the officer list), and the first phone tab', () => {
    const officer = shellCtx(OFFICER_CAN);
    assert.deepEqual(keys(G.shell.sidebarItems(officer)).slice(0, 3), ['home', 'roster', 'raids']);
    assert.deepEqual(keys(G.shell.tabItems(officer)), ['home', 'raids', 'roster', 'attendance', 'more'], 'the phone tabs stay five: Home, Raids, Roster, Attendance, More');
    const home = G.shell.sidebarItems(officer)[0];
    assert.equal(home.label, 'Home');
    assert.equal(home.href, '#/g/g1');
    assert.equal(home.icon, 'home');
    assert(G.icons.names.includes('home') && G.icons.names.includes('arrow'));
    assert.deepEqual(keys(G.shell.sidebarItems(shellCtx(MEMBER_CAN))).slice(0, 2), ['home', 'roster'], 'a member has a Home too');
    assert.deepEqual(keys(G.shell.sidebarItems(shellCtx(LEAD_CAN))).slice(0, 2), ['home', 'roster'], 'a team lead (team-list actions) does');
    const slots = G.shell.slots(officer);
    assert(slots.sidebar.indexOf('href="#/g/g1"') > 0 && slots.sidebar.indexOf('href="#/g/g1"') < slots.sidebar.indexOf('href="#/g/g1/roster"'));
    assert(slots.drawer.includes('href="#/g/g1"') && slots.drawer.includes('Home'), 'the drawer carries it');
    assert(slots.tabs.includes('href="#/g/g1"') && slots.tabs.includes('>Home<'), 'the first tab of the bar (Home, Raids, Roster, Attendance, More)');
    assert(G.shell.slots(shellCtx(MEMBER_CAN)).sidebar.includes('href="#/g/g1"'), 'the member sidebar links to Home');
    const stat = G.shell.slots(Object.assign(shellCtx(OFFICER_CAN), { section: 'page', page: 'faq', route: null }));
    assert(stat.sidebar.includes('href="/#/g/g1"'), 'static pages link to Home absolutely');
  });

  await check('shell: the Home badge is the open-work count; 0 for members, junk and when unknown; the link label says what it counts', () => {
    const badge = (can, n) => G.shell.homeBadge(shellCtx(can, { attentionCount: n }));
    assert.equal(badge(OFFICER_CAN, 5), 5);
    assert.equal(badge(OFFICER_CAN, 5.9), 5);
    assert.equal(badge(OFFICER_CAN, 0), 0);
    assert.equal(badge(OFFICER_CAN, undefined), 0);
    assert.equal(badge(OFFICER_CAN, 'many'), 0);
    assert.equal(badge(OFFICER_CAN, -3), 0);
    assert.equal(badge(MEMBER_CAN, 7), 0, 'a member never gets a count');
    assert.equal(G.shell.homeBadge({ attentionCount: 4 }), 0, 'no guild, no badge');
    const with5 = G.shell.slots(shellCtx(OFFICER_CAN, { attentionCount: 5 })).sidebar;
    assert(with5.includes('aria-label="Home, 5 items need attention"'));
    assert(/<span class="gs-nav-badge" aria-hidden="true">5<\/span>/.test(with5.slice(with5.indexOf('Home'))));
    assert(G.shell.slots(shellCtx(OFFICER_CAN, { attentionCount: 1 })).sidebar.includes('aria-label="Home, 1 item needs attention"'));
    const none = G.shell.slots(shellCtx(OFFICER_CAN, { attentionCount: 0 })).sidebar;
    assert(none.includes('aria-label="Home"') && !none.includes('items need attention'));
    assert.equal(G.shell.sidebarItems(shellCtx(OFFICER_CAN, { attentionCount: 2 }))[0].badge, 2);
    assert.equal(G.shell.sidebarItems(shellCtx(OFFICER_CAN))[0].badge, 0);
  });

  await check('shell: Home is the current item on the Home section only; tiles link to #/g/:gid; the breadcrumb is guild name then Home', () => {
    const current = c => [...G.shell.slots(c).sidebar.matchAll(/aria-label="([^"]*)" aria-current="page"/g)].map(m => m[1]);
    assert.deepEqual(current(shellCtx(OFFICER_CAN, { route: { name: 'section', gid: 'g1', section: 'home' } })), ['Home']);
    assert.deepEqual(current(shellCtx(OFFICER_CAN, { route: { name: 'section', gid: 'g1', section: 'roster' } })), ['Roster']);
    assert.deepEqual(current(shellCtx(OFFICER_CAN, { attentionCount: 3, route: { name: 'section', gid: 'g1', section: 'home' } })), ['Home, 3 items need attention']);
    const s = G.shell.slots(shellCtx(OFFICER_CAN));
    assert(s.rail.includes('class="gs-tile is-active" href="#/g/g1"'), 'the rail tile');
    assert(s.drawer.includes('class="gs-tile is-active" href="#/g/g1"'), 'the drawer tile');
    assert(!s.rail.includes('href="#/g/g1/roster"'));
    const crumbs = G.shell.breadcrumbItems(shellCtx(OFFICER_CAN, { route: { name: 'section', gid: 'g1', section: 'home' } }));
    assert.deepEqual(plain(crumbs.map(c => c.label)), ['Ravens', 'Home'], 'no team crumb: Home spans every team');
    assert.deepEqual(plain(G.shell.breadcrumbItems(shellCtx(OFFICER_CAN, { route: { name: 'section', gid: 'g1', section: 'roster' } })).map(c => c.label)), ['Ravens', 'Team KJ', 'Roster']);
    assert(G.shell.slots(shellCtx(OFFICER_CAN, { route: { name: 'section', gid: 'g1', section: 'home' } })).lead.includes('>Home<'));
    const tabs = G.shell.settingsFrameHtml(shellCtx(OFFICER_CAN), 'activity', '<p>x</p>');
    assert(tabs.includes('href="#/g/g1/settings/activity" aria-current="page">Activity<'), 'the tab strip marks Activity current');
  });

  // ═══ api helpers ════════════════════════════════════════════════
  await check('api: every wave-1 call goes through one helper with the contract path (ids encoded, filters in order, blank filters dropped)', async () => {
    const s = stub(() => Promise.resolve({}));
    const A = G.api;
    assert.equal(A.audit.csvUrl('g1', {}), '/api/guild/g1/audit?format=csv');
    assert.equal(A.audit.csvUrl('g 1', { type: 'roster', actor: 'u1', from: '2026-10-01', to: '2026-10-17' }), '/api/guild/g%201/audit?type=roster&actor=u1&from=2026-10-01&to=2026-10-17&format=csv');
    assert.equal(A.audit.csvUrl('g1', { type: '', actor: 'a&b' }), '/api/guild/g1/audit?actor=a%26b&format=csv');
    await G.api.audit.list('g1', {});
    await G.api.audit.list('g1', { type: 'loot', from: '2026-10-01' }, 'cur/1');
    await G.api.attention.get('g1');
    await G.api.trial.get('g1', 'p_t');
    await G.api.trial.update('g1', 'p_t', { expectedVersion: 4, status: 'raider' });
    await G.api.trial.saveNotes('g1', 'p_t', { text: 'x', expectedNotesVersion: 2 });
    await G.api.calendar.status('g1', 't_1');
    await G.api.calendar.create('g1', 't_1');
    await G.api.calendar.revoke('g1', 't_1');
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [
      ['get', '/api/guild/g1/audit', undefined],
      ['get', '/api/guild/g1/audit?type=loot&from=2026-10-01&before=cur%2F1', undefined],
      ['get', '/api/guild/g1/attention', undefined],
      ['get', '/api/guild/g1/roster/p_t/trial', undefined],
      ['patch', '/api/guild/g1/roster/p_t', { expectedVersion: 4, status: 'raider' }],
      ['put', '/api/guild/g1/roster/p_t/notes', { text: 'x', expectedNotesVersion: 2 }],
      ['get', '/api/guild/g1/calendar?team=t_1', undefined],
      ['post', '/api/guild/g1/calendar', { teamId: 't_1' }],
      ['del', '/api/guild/g1/calendar', { teamId: 't_1' }],
    ]);
  });

  // ═══ Activity log ═══════════════════════════════════════════════
  const AUDIT_TYPES = [{ id: 'roster', label: 'Roster' }, { id: 'raids', label: 'Raids' }, { id: 'attendance', label: 'Attendance' }, { id: 'loot', label: 'Loot' }, { id: 'signups', label: 'Sign-ups' }, { id: 'bnet', label: 'Battle.net' }, { id: 'settings', label: 'Settings' }];
  const AUDIT_ACTORS = [{ id: 'u1', displayName: 'Alice' }, { id: 'u2', displayName: 'Bob' }];
  const AT = Date.UTC(2026, 9, 18, 0, 15); // Sat Oct 17 2026, 8:15 PM in New York (EDT)
  const NOW = Date.UTC(2026, 9, 20, 12, 0);
  const auditRow = over => Object.assign({ id: 'a1', at: AT, actor: { id: 'u1', displayName: 'Alice' }, action: 'person.update', group: 'roster', text: 'Moved Thoren to Reserve', entityType: 'person', entityId: 'p_t', before: { status: 'raider' }, after: { status: 'reserve' } }, over || {});
  const auditRes = (rows, over) => Object.assign({ timeZone: 'America/New_York', rows, next: null, types: AUDIT_TYPES, actors: AUDIT_ACTORS }, over || {});
  const actState = over => Object.assign({ gid: 'g1', filters: { type: '', actor: '', from: '', to: '' }, rows: [auditRow()], next: null, types: AUDIT_TYPES, actors: AUDIT_ACTORS, timeZone: 'America/New_York',
    loading: false, olderLoading: false, error: '', olderError: '', seq: 0 }, over || {});
  const actHtml = (s, extra) => G.pages.settingsActivity.activityHtml(Object.assign({ guildData: gd(OFFICER_CAN), s, now: NOW }, extra || {}));

  await check('activity page: a row shows when (guild time zone), who, the sentence and a Details toggle with before / after JSON; table and phone cards', () => {
    const out = ws(actHtml(actState()));
    assert(out.includes('Sat Oct 17, 8:15 PM ET'), 'the time is in the guild zone, not UTC, and names it');
    assert(out.includes('>Alice<') && out.includes('Moved Thoren to Reserve'));
    assert((out.match(/<details class="gs-audit-details">/g) || []).length === 2, 'one toggle in the table, one in the card');
    assert(out.includes('<pre class="gs-audit-json">Before\n{\n  &quot;status&quot;: &quot;raider&quot;\n}\n\nAfter\n{\n  &quot;status&quot;: &quot;reserve&quot;\n}</pre>'), out.slice(out.indexOf('<pre'), out.indexOf('</pre>') + 6));
    assert(out.includes('Action: person.update'));
    assert(out.includes('<table class="gs-table gs-table-audit" aria-label="Activity log">') && out.includes('<ul class="gs-roster-cards gs-audit-cards" aria-label="Activity log">') && out.includes('<li class="gs-roster-card">'));
    assert(out.includes('<th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th>'));
    assert(out.includes('Showing 1 entry, newest first.'));
    assert(!out.includes('data-action="audit-older"'));
    assert(out.includes('(America/New_York)'));
    assertNoRawAttrs(out);
  });

  await check('activity page: the year joins the time when the row is from another year; an unknown zone falls back instead of throwing', () => {
    const P = G.pages.settingsActivity;
    assert.equal(ws(P.whenText(AT, 'America/New_York', NOW)), 'Sat Oct 17, 8:15 PM ET');
    assert.equal(ws(P.whenText(AT, 'America/New_York', Date.UTC(2027, 0, 5))), 'Sat Oct 17, 2026, 8:15 PM ET');
    assert(P.whenText(AT, 'Not/AZone', NOW).length > 0);
    assert(P.whenText(AT, '', NOW).length > 0);
    assert.equal(P.whenText(null, 'America/New_York', NOW), '');
    assert.equal(P.whenText('x', 'America/New_York', NOW), '');
  });

  await check('activity page: the filter row (Type, Person, From, To, Clear, Download CSV) reflects the filters; the CSV link carries them', () => {
    const blank = actHtml(actState());
    assert(blank.includes('<option value="" selected>All activity</option>') && blank.includes('<option value="" selected>Everyone</option>'));
    for (const t of AUDIT_TYPES) assert(blank.includes('>' + t.label + '</option>'), t.label);
    assert(blank.includes('>Alice</option>') && blank.includes('>Bob</option>'));
    assert(/<input class="gs-input" type="date" id="act-from"[^>]*value=""/.test(blank) && /<input class="gs-input" type="date" id="act-to"[^>]*value=""/.test(blank));
    assert(/<button type="button" class="gs-btn" data-action="audit-clear" data-key="audit-clear" disabled>Clear filters<\/button>/.test(blank), 'nothing to clear');
    assert(blank.includes('<a class="gs-btn" href="/api/guild/g1/audit?format=csv" download data-key="audit-csv">Download CSV</a>'));
    for (const id of ['act-type', 'act-actor', 'act-from', 'act-to']) assert(blank.includes('<label class="gs-label" for="' + id + '">'), id);
    const f = { type: 'loot', actor: 'u2', from: '2026-10-01', to: '2026-10-17' };
    const filtered = actHtml(actState({ filters: f }));
    assert(filtered.includes('<option value="loot" selected>Loot</option>') && filtered.includes('<option value="u2" selected>Bob</option>'));
    assert(filtered.includes('id="act-from" data-change="audit-filter" data-filter="from" data-key="act-from" value="2026-10-01"') && filtered.includes('value="2026-10-17"'));
    assert(filtered.includes('href="/api/guild/g1/audit?type=loot&amp;actor=u2&amp;from=2026-10-01&amp;to=2026-10-17&amp;format=csv" download'));
    assert(!/data-action="audit-clear"[^>]*disabled/.test(filtered), 'Clear filters is on');
  });

  await check('activity page: a deleted account shows as Former member; empty states differ with and without filters; loading and errors', () => {
    assert(actHtml(actState({ rows: [auditRow({ actor: null })] })).includes('>Former member<'));
    assert.equal(G.pages.settingsActivity.whoText(auditRow({ actor: { id: 'u9', displayName: '' } })), 'Former member');
    const unfiltered = actHtml(actState({ rows: [] }));
    assert(unfiltered.includes('<p class="gs-empty">Nothing has been logged yet.</p>') && !unfiltered.includes('<table'));
    const filtered = actHtml(actState({ rows: [], filters: { type: 'loot', actor: '', from: '', to: '' } }));
    assert(filtered.includes('<p class="gs-empty">No activity matches these filters.</p>'));
    const loading = actHtml(actState({ loading: true }));
    assert(loading.includes('>Loading...<') && !loading.includes('<table'));
    const err = actHtml(actState({ error: 'Something went wrong.' }));
    assert(/<p class="gs-alert" id="act-error" role="alert">Something went wrong\.<\/p>/.test(err));
    assert(/id="act-error" role="alert" hidden>/.test(actHtml(actState())), 'hidden while there is no error');
    assert(actHtml(actState({ olderError: 'Could not load older entries.' })).includes('Could not load older entries.'));
    assert(actHtml(actState()).includes('id="act-live" role="status"'), 'a live region the handlers write the result into');
  });

  await check('activity page: Older shows while there is a next cursor and is busy while it loads; a row without values says so', () => {
    const more = actHtml(actState({ next: 'c1' }));
    assert(/<button type="button" class="gs-btn" data-action="audit-older" data-key="audit-older">Older<\/button>/.test(more));
    assert(/data-action="audit-older" data-key="audit-older" disabled>Loading\.\.\.</.test(actHtml(actState({ next: 'c1', olderLoading: true }))));
    const bare = actHtml(actState({ rows: [auditRow({ before: null, after: null })] }));
    assert(bare.includes('No before or after values were recorded.'));
    assert.equal(G.pages.settingsActivity.detailText(auditRow({ before: null })), 'After\n{\n  "status": "reserve"\n}');
    assert.equal(G.pages.settingsActivity.detailText(auditRow({ before: { n: 0 }, after: [] })), 'Before\n{\n  "n": 0\n}\n\nAfter\n[]');
  });

  await check('activity page: hostile strings in every field are escaped', () => {
    const row = auditRow({ text: HOSTILE + QUOTES, action: HOSTILE, actor: { id: 'u1', displayName: HOSTILE + QUOTES }, before: { x: HOSTILE + QUOTES }, after: { y: HOSTILE } });
    const out = actHtml(actState({ rows: [row], timeZone: HOSTILE, types: [{ id: HOSTILE + QUOTES, label: HOSTILE + QUOTES }], actors: [{ id: HOSTILE + QUOTES, displayName: HOSTILE + QUOTES }],
      filters: { type: HOSTILE + QUOTES, actor: QUOTES, from: HOSTILE, to: QUOTES } }));
    assertEscaped(out, 'activity page');
    assertNoRawAttrs(out);
    assertEscaped(G.pages.settingsActivity.activityHtml({ guildData: gd(OFFICER_CAN, { guild: Object.assign({}, gd(OFFICER_CAN).guild, { name: HOSTILE + QUOTES }) }), s: actState() }), 'guild name');
  });

  await check('activity page: main() is the Activity tab of the settings frame; loading while the list is unread', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    S.guilds.g1 = g; S.currentGid = 'g1';
    assert(G.pages.settingsActivity.main({ name: 'settings', tab: 'activity' }, g, { guildData: g }).includes('Loading...'));
    S.att.settingsActivity = actState();
    const out = ws(G.pages.settingsActivity.main({ name: 'settings', tab: 'activity' }, g, { guildData: g }));
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Guild settings</h1>') && out.includes('aria-current="page">Activity<') && out.includes('Moved Thoren to Reserve'));
  }));

  await check('activity page: load() reads the list with the kept filters of the same guild; a 403 rejects (the route shows the message page)', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    let s = stub(() => Promise.resolve(auditRes([auditRow()], { next: 'c1' })));
    await G.pages.settingsActivity.load({}, g);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/audit']);
    const st = S.att.settingsActivity;
    assert.equal(st.rows.length, 1); assert.equal(st.next, 'c1'); assert.equal(st.timeZone, 'America/New_York');
    assert.deepEqual(plain(st.filters), { type: '', actor: '', from: '', to: '' });
    assert.deepEqual(plain(st.types.map(t => t.id)), AUDIT_TYPES.map(t => t.id));
    s.restore();
    st.filters.type = 'loot';
    s = stub(() => Promise.resolve(auditRes([])));
    await G.pages.settingsActivity.load({}, g);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/audit?type=loot'], 'coming back keeps the filters');
    assert.equal(S.att.settingsActivity.filters.type, 'loot');
    s.restore();
    S.att.settingsActivity.filters.type = 'loot';
    s = stub(() => Promise.resolve(auditRes([])));
    await G.pages.settingsActivity.load({}, gd(OFFICER_CAN, { guild: Object.assign({}, g.guild, { id: 'g2' }) }));
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g2/audit'], 'another guild starts clean');
    s.restore();
    s = stub(() => Promise.reject(ApiErr(403, 'forbidden')));
    await assert.rejects(() => G.pages.settingsActivity.load({}, g), e => e.status === 403);
    s.restore();
  }));

  await check('activity handlers: a filter change reads the list again from the start; Clear resets; From after To never leaves the browser', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsActivity = actState({ next: 'c1', rows: [auditRow({ id: 'old' })] });
    const s = stub(() => Promise.resolve(auditRes([auditRow({ id: 'a2', text: 'Imported 12 loot awards' })])));
    const H = G.handlers;
    await H.change['audit-filter'](el({ 'data-filter': 'type' }, { value: 'loot' }));
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/audit?type=loot']);
    let st = S.att.settingsActivity;
    assert.deepEqual(plain(st.rows.map(r => r.id)), ['a2'], 'the list is replaced, not appended');
    assert.equal(st.next, null);
    assert.equal(st.filters.type, 'loot');
    await H.change['audit-filter'](el({ 'data-filter': 'actor' }, { value: 'u2' }));
    await H.change['audit-filter'](el({ 'data-filter': 'from' }, { value: '2026-10-01' }));
    await H.change['audit-filter'](el({ 'data-filter': 'to' }, { value: '2026-10-17' }));
    assert.equal(s.calls[3].url, '/api/guild/g1/audit?type=loot&actor=u2&from=2026-10-01&to=2026-10-17');
    // From after To: no request
    const before = s.calls.length;
    await H.change['audit-filter'](el({ 'data-filter': 'from' }, { value: '2026-10-30' }));
    assert.equal(s.calls.length, before);
    assert.equal(S.att.settingsActivity.error, 'The From date is after the To date.');
    // an unknown filter name is ignored
    await H.change['audit-filter'](el({ 'data-filter': 'bogus' }, { value: 'x' }));
    assert.equal(s.calls.length, before);
    // Clear
    await H.click['audit-clear'](el({}));
    assert.equal(s.calls[s.calls.length - 1].url, '/api/guild/g1/audit');
    st = S.att.settingsActivity;
    assert.deepEqual(plain(st.filters), { type: '', actor: '', from: '', to: '' });
    assert.equal(st.error, '');
    const n = s.calls.length;
    await H.click['audit-clear'](el({}));
    assert.equal(s.calls.length, n, 'nothing to clear, nothing sent');
    s.restore();
  }));

  await check('activity handlers: Older appends the next page under the same filters, skips rows it has, and ends when there is no cursor', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsActivity = actState({ filters: { type: 'loot', actor: '', from: '', to: '' }, next: 'c1', rows: [auditRow({ id: 'a1' }), auditRow({ id: 'a2' })] });
    const s = stub(() => Promise.resolve(auditRes([auditRow({ id: 'a2' }), auditRow({ id: 'a3' })], { next: 'c2' })));
    await G.handlers.click['audit-older'](el({}));
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/audit?type=loot&before=c1']);
    let st = S.att.settingsActivity;
    assert.deepEqual(plain(st.rows.map(r => r.id)), ['a1', 'a2', 'a3']);
    assert.equal(st.next, 'c2'); assert.equal(st.olderLoading, false);
    s.restore();
    const last = stub(() => Promise.resolve(auditRes([auditRow({ id: 'a4' })], { next: null })));
    await G.handlers.click['audit-older'](el({}));
    assert.equal(S.att.settingsActivity.next, null);
    assert.equal(S.att.settingsActivity.rows.length, 4);
    const n = last.calls.length;
    await G.handlers.click['audit-older'](el({}));
    assert.equal(last.calls.length, n, 'no cursor, no request');
    last.restore();
  }));

  await check('activity handlers: a slow answer from before a newer read is dropped; a failed read keeps the list and says why; sign-in loss goes to sign-in', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsActivity = actState();
    const pending = [];
    let s = stub(() => new Promise(resolve => pending.push(resolve)));
    const first = G.handlers.change['audit-filter'](el({ 'data-filter': 'type' }, { value: 'loot' }));
    const second = G.handlers.change['audit-filter'](el({ 'data-filter': 'type' }, { value: 'raids' }));
    pending[1](auditRes([auditRow({ id: 'raids-row' })]));
    await second;
    pending[0](auditRes([auditRow({ id: 'loot-row' })]));
    await first;
    assert.deepEqual(plain(S.att.settingsActivity.rows.map(r => r.id)), ['raids-row'], 'the older answer did not win');
    assert.equal(S.att.settingsActivity.filters.type, 'raids');
    s.restore();
    s = stub(() => Promise.reject(ApiErr(500, 'error')));
    await G.handlers.change['audit-filter'](el({ 'data-filter': 'type' }, { value: 'loot' }));
    assert.equal(S.att.settingsActivity.error, 'Server says so.');
    assert.equal(S.att.settingsActivity.loading, false);
    S.att.settingsActivity.next = 'c1';
    await G.handlers.click['audit-older'](el({}));
    assert.equal(S.att.settingsActivity.olderError, 'Server says so.');
    assert.equal(S.att.settingsActivity.olderLoading, false);
    s.restore();
    let signins = 0;
    ctx.Guild.app.requireSignin = () => { signins++; };
    s = stub(() => Promise.reject(ApiErr(401, 'signed_out')));
    await G.handlers.change['audit-filter'](el({ 'data-filter': 'type' }, { value: 'roster' }));
    assert.equal(signins, 1);
    s.restore();
  }));

  // ═══ attendance watch list: policy fields ═══════════════════════
  const POLICY_DEFAULTS = { expected: { mode: 'signedUp', statuses: ['raider', 'trial'] }, streakFlagAt: 4, window: { defaultWeeks: 8, switchWeeks: [8, 12] }, watch: { below: 0.75, dropBy: 0.15 },
    credit: { values: [{ id: 'full', label: 'Full', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }] } };
  const polView = over => Object.assign({ defaults: POLICY_DEFAULTS, guild: {}, teams: {}, resolved: {}, versions: { guild: 0, teams: {} }, wcl: { guildId: null, uploaders: {} } }, over || {});
  const polState = (view, scope) => ({ gid: 'g1', view, scope: scope || 'guild', draft: G.pages.settingsAtt.overrideFor(view, scope || 'guild'), wclUi: null, stale: 0 });
  const polHtml = s => G.pages.settingsAtt.settingsHtml({ guildData: gd(OFFICER_CAN), s });
  const watchInput = (html, key) => (html.match(new RegExp('<input[^>]*id="p-watch-' + key + '"[^>]*>')) || [''])[0];

  await check('watch policy: the Watch list group edits two percent fields; stored fractions show as percent, null shows blank (off)', () => {
    const out = polHtml(polState(polView()));
    assert(out.includes('<h3 class="gs-h2" id="pg-watch">Watch list</h3>'));
    assert(out.indexOf('id="pg-windows"') < out.indexOf('id="pg-watch"') && out.indexOf('id="pg-watch"') < out.indexOf('id="pg-reset"'), 'between Windows and Reset day');
    const below = watchInput(out, 'below');
    assert(below.includes('type="number"') && below.includes('min="0"') && below.includes('max="100"') && below.includes('value="75"') && below.includes('data-type="percent"') && below.includes('data-path="watch.below"') && below.includes('placeholder="Off"'), below);
    assert(watchInput(out, 'dropBy').includes('value="15"') && watchInput(out, 'dropBy').includes('data-path="watch.dropBy"'));
    assert(out.includes('Flag people below (percent)') && out.includes('Flag a drop of (points)'));
    assert(out.includes('id="perr-watch-below"') && out.includes('id="perr-watch-dropBy"'), 'server errors have a slot per path');
    assert(out.includes('Leave it empty to turn this check off.'));
    const off = polHtml(polState(polView({ guild: { watch: { below: null, dropBy: 0.125 } } })));
    assert(watchInput(off, 'below').includes('value=""'), 'null is blank');
    assert(watchInput(off, 'dropBy').includes('value="12.5"'), 'one decimal is kept');
    assert(!out.includes('Overridden') && !out.includes('Inherited'), 'the guild default scope has no markers');
    assert.equal(G.pages.settingsAtt.percentOf(0.75), 75);
    assert.equal(G.pages.settingsAtt.percentOf(0.3), 30);
    assert.equal(G.pages.settingsAtt.percentOf(null), '');
    assert.equal(G.pages.settingsAtt.percentOf(undefined), '');
  });

  await check('watch policy: a team scope marks each field Inherited or Overridden, with Reset on the overridden one; the guild value shows through', () => {
    const view = polView({ guild: { watch: { below: 0.8 } }, teams: { t1: { watch: { dropBy: null } } }, resolved: { t1: {} } });
    const out = polHtml(polState(view, 't1'));
    const below = out.slice(out.indexOf('id="pf-watch-below"'), out.indexOf('id="pf-watch-dropBy"'));
    const drop = out.slice(out.indexOf('id="pf-watch-dropBy"'), out.indexOf('id="pf-resetDay"') > 0 ? out.indexOf('id="pf-resetDay"') : undefined);
    assert(below.includes('Inherited') && !below.includes('data-action="pol-reset"') && below.includes('value="80"'), 'inherits the guild 80');
    assert(drop.includes('Overridden') && drop.includes('data-action="pol-reset" data-path="watch.dropBy"') && drop.includes('value=""'), 'an explicit null is an override that turns the check off');
  });

  await check('watch policy: typing percent stores a fraction without float noise; blank stores null (off); Reset removes the key', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const s = S.att.settingsAtt = polState(polView());
    const type = (path, value) => G.handlers.change['pol-change'](el({ 'data-path': path, 'data-type': 'percent' }, { value }));
    type('watch.below', '75'); assert.equal(s.draft.watch.below, 0.75);
    type('watch.below', '29.9'); assert.equal(s.draft.watch.below, 0.299);
    type('watch.below', '12.5'); assert.equal(s.draft.watch.below, 0.125);
    type('watch.dropBy', '57'); assert.equal(s.draft.watch.dropBy, 0.57, 'not 0.5700000000000001');
    type('watch.dropBy', '0.1'); assert.equal(s.draft.watch.dropBy, 0.001);
    type('watch.dropBy', '100'); assert.equal(s.draft.watch.dropBy, 1);
    type('watch.dropBy', '0'); assert.equal(s.draft.watch.dropBy, 0);
    type('watch.below', ''); assert.strictEqual(s.draft.watch.below, null);
    type('watch.below', 'abc'); assert.strictEqual(s.draft.watch.below, null, 'junk is blank, never NaN');
    assert.equal(G.pages.settingsAtt.fractionOf('62.54'), 0.625);
    assert.strictEqual(G.pages.settingsAtt.fractionOf(null), null);
    // Reset (team scope) removes the key and the empty parent
    S.att.settingsAtt = polState(polView({ teams: { t1: { watch: { below: 0.6 } } }, resolved: { t1: {} } }), 't1');
    G.handlers.click['pol-reset'](el({ 'data-path': 'watch.below' }));
    assert.deepEqual(plain(S.att.settingsAtt.draft), {});
  }));

  await check('watch policy: Save sends only what differs from the defaults (null = off survives); a team override sends its own keys', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const run = async (state, mutate) => {
      S.att.settingsAtt = state;
      S.att.policy = {};
      mutate(state);
      const s = stub((m, url, body) => Promise.resolve(polView({ guild: body.policy })));
      await G.handlers.submit['pol-form'](form({}));
      await settle();
      s.restore();
      return s.calls.filter(c => c.m === 'put')[0];
    };
    let put = await run(polState(polView()), s => { s.draft.watch = { below: 0.6, dropBy: 0.15 }; });
    assert.deepEqual([put.url, put.body.teamId, put.body.expectedVersion], ['/api/guild/g1/attendance/policy', null, 0]);
    assert.deepEqual(put.body.policy, { watch: { below: 0.6 } }, 'dropBy equals the default and is not stored');
    put = await run(polState(polView()), s => { s.draft.watch = { below: null, dropBy: null }; });
    assert.deepEqual(put.body.policy, { watch: { below: null, dropBy: null } }, 'both off');
    put = await run(polState(polView()), () => {});
    assert.deepEqual(put.body.policy, {}, 'nothing changed');
    put = await run(polState(polView({ teams: { t1: { watch: { below: 0.6 } } }, resolved: { t1: {} } }), 't1'), s => { s.draft.watch.dropBy = 0.2; });
    assert.equal(put.body.teamId, 't1');
    assert.deepEqual(put.body.policy, { watch: { below: 0.6, dropBy: 0.2 } });
    assert.equal(S.att.settingsAtt.stale, 0, 'watch is not a key that changes stored outcomes: no recalculate banner');
    assert.equal(G.pages.settingsAtt.changesConsolidation({}, { watch: { below: 0.5 } }), false);
  }));

  await check('watch policy: a server error naming watch.below / watch.dropBy shows next to that field and marks it invalid', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsAtt = polState(polView());
    S.att.policy = {};
    for (const field of ['watch.below', 'watch.dropBy']) {
      const slot = fakeEl('perr-' + field.replace('.', '-'), { hidden: true });
      const input = { attrs: {}, focused: 0, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused++; } };
      const f = Object.assign(form({}), { querySelector: sel => (sel === '[data-path="' + field + '"]' ? input : null) });
      const s = stub(() => Promise.reject(ApiErr(400, 'bad_request', { field, message: 'Use 0 to 100 percent.' })));
      await G.handlers.submit['pol-form'](f);
      await settle();
      s.restore();
      assert.equal(slot.textContent, 'Use 0 to 100 percent.', field);
      assert.equal(slot.hidden, false);
      assert.equal(input.attrs['aria-invalid'], 'true');
      assert.equal(input.focused, 1);
    }
  }));

  // ═══ attendance watch list: the team page card ══════════════════
  const WATCH = { below: 0.75, dropBy: 0.15, window: 8, previousFrom: '2026-07-21', entries: [
    { playerId: 'p_t', name: 'Thoren', class: 'PALADIN', status: 'raider', pct: 62, previousPct: 82, drop: 20, counted: 8, missed: 3, missedNotice: 1, reasons: ['below', 'drop'] },
    { playerId: 'p_k', name: 'Kaelith', class: 'ROGUE', status: 'trial', pct: 70.4, previousPct: null, drop: null, counted: 5, missed: 1, missedNotice: 0, reasons: ['below'] },
  ] };
  const TEAM_DATA = watch => ({ team: 't1', window: 8, policy: { switchWeeks: [8, 12] }, weeks: [], people: [], awaitingReview: 0, staleRaids: 0, watch });
  const GRID_DATA = watch => Object.assign(TEAM_DATA(watch), {
    weeks: [{ weekStart: '2026-10-13', raids: [{ id: 'r1', raidOn: '2026-10-17', zone: 'BT' }] }],
    people: [{ name: 'Thoren', class: 'PALADIN', status: 'raider', pct: 62, pctAll: 70, signupRate: 90, streak: 0, lastAttended: '2026-10-10', cells: [], isMe: false }],
  });
  const attHtml = (data, can) => G.pages.attendance.attendanceHtml({ guildData: gd(can || OFFICER_CAN), teamId: 't1', data, view: { mode: 'people', sort: G.pages.attendance.DEFAULT_SORT, includeInactive: false }, policy: null });
  const P = () => G.pages.attendancePeople;

  await check('Needs a look panel: one row per person (class-coloured link to their history, a reason sentence with the % now and before, Reviewed button), no amber chips', () => {
    const out = attHtml(GRID_DATA(WATCH));
    assert(out.includes('aria-label="Needs a look"') && out.includes('<span class="gs-fg-cnt">2</span>'));
    assert(out.indexOf('aria-label="Needs a look"') < out.indexOf('class="gs-at-bar"'), 'above the bar');
    assert(out.includes('<a class="gs-char-link gs-class-paladin" href="#/g/g1/attendance/p/p_t">Thoren</a>') && out.includes('<a class="gs-char-link gs-class-rogue" href="#/g/g1/attendance/p/p_k">Kaelith</a>'));
    assert(out.includes('<span class="gs-at-why">Below 75% and down 20 points - 62%, was 82%</span>'));
    assert(out.includes('<span class="gs-at-why">Below 75% - 70%</span>'), 'no previous window, no "was"');
    assert(!out.includes('gs-chip-flag') && !out.includes('Missed 3, with notice 1'));
    assertNoRawAttrs(out);
  });

  await check('Needs a look panel: an empty list keeps the panel with one line; no watch (null / absent) draws none; junk draws nothing', () => {
    const empty = attHtml(GRID_DATA({ below: 0.75, dropBy: null, window: 8, previousFrom: null, entries: [] }));
    assert(empty.includes('aria-label="Needs a look"') && empty.includes('No one is below the line.'));
    assert(!attHtml(GRID_DATA(null)).includes('Needs a look'));
    const d = TEAM_DATA(null); delete d.watch;
    assert(!attHtml(d).includes('Needs a look'), 'an older Worker without the field');
    assert.equal(P().watchHtml('g1', null), '');
    assert.equal(P().watchHtml('g1', 'junk'), '');
  });

  await check('Needs a look panel: the reason names only the checks that are on', () => {
    const entry = (reasons, over) => Object.assign({}, WATCH.entries[0], { reasons }, over || {});
    assert.equal(P().watchReasonText({ below: 0.75, dropBy: 0.15 }, entry(['below'])), 'Below 75% - 62%, was 82%');
    assert.equal(P().watchReasonText({ below: null, dropBy: 0.1 }, entry(['drop'])), 'Down 20 points - 62%, was 82%');
    assert.equal(P().watchReasonText({ below: 0.125, dropBy: 0.15 }, entry(['below'], { previousPct: null })), 'Below 12.5% - 62%', '12.5 stays 12.5');
    assert.equal(P().watchReasonText({ below: 0.75, dropBy: 0.15 }, entry(['below', 'drop'])), 'Below 75% and down 20 points - 62%, was 82%');
    const only = attHtml(GRID_DATA({ below: null, dropBy: 0.15, window: 8, previousFrom: '2026-07-21', entries: [Object.assign({}, WATCH.entries[0], { reasons: ['drop'] })] }));
    assert(only.includes('Down 20 points - 62%, was 82%') && !only.includes('Below'));
  });

  await check('Needs a look panel: hostile names, statuses and counts are escaped; a person with no class or %, and an unknown reason, still render', () => {
    const e = Object.assign({}, WATCH.entries[0], { name: HOSTILE + QUOTES, playerId: HOSTILE, class: HOSTILE, status: HOSTILE, reasons: ['below', HOSTILE] });
    const out = attHtml(GRID_DATA(Object.assign({}, WATCH, { entries: [e, { playerId: 'p_z', name: 'Zed', class: null, status: 'raider', pct: null, previousPct: null, drop: null, reasons: [] }] })));
    assertEscaped(out, 'watch panel');
    assertNoRawAttrs(out);
    assert(out.includes('On the watch list - -'), 'no % is a dash, no known reason is still a sentence');
    const unlinked = attHtml(GRID_DATA(Object.assign({}, WATCH, { entries: [Object.assign({}, WATCH.entries[0], { playerId: null })] })));
    assert(unlinked.includes('<span class="gs-char-name gs-class-paladin">Thoren</span>') && !unlinked.includes('attendance/p/'), 'no id, no link');
  });

  // ═══ Home (needs attention) ═════════════════════════════════════
  const item = (kind, over) => Object.assign({ id: kind + ':1', kind, severity: kind === 'unlocked' ? 'info' : 'action', teamId: 't1', teamName: 'Team KJ', link: { name: 'raid', rid: 'r_1' } }, over || {});
  const FULL = [
    item('review', { raidId: 'r_1', date: '2026-10-17', zone: 'Black Temple', title: 'Prog night', count: 3, link: { name: 'raid', rid: 'r_1' } }),
    item('loot_unmatched', { raidId: 'r_1', date: '2026-10-17', zone: 'Black Temple', title: null, count: 3, link: { name: 'review' } }),
    item('signup_unmatched', { raidId: 'r_1', date: '2026-10-17', zone: null, title: null, count: 2, link: { name: 'raid', rid: 'r_1' } }),
    item('claims', { teamId: null, teamName: null, count: 3, link: { name: 'review' } }),
    item('trial', { personId: 'p_t', name: 'Thoren', class: 'PALADIN', trialEnd: '2026-10-20', days: 3, ended: false, link: { name: 'person', pid: 'p_t' } }),
    item('watch', { personId: 'p_k', name: 'Kaelith', class: 'ROGUE', pct: 62, previousPct: 82, drop: 20, reasons: ['below', 'drop'], link: { name: 'personatt', pid: 'p_k' } }),
    item('no_loot', { raidId: 'r_2', date: '2026-10-10', zone: 'Karazhan', title: null, link: { name: 'raid', rid: 'r_2' } }),
    item('low_signups', { raidId: 'r_3', date: '2026-10-21', startsAt: AT, zone: null, title: 'Prog night', expected: 18, size: 25, link: { name: 'raid', rid: 'r_3' } }),
    item('unlocked', { raidId: 'r_3', date: '2026-10-21', startsAt: AT, zone: null, title: 'Prog night', minutes: 45, link: { name: 'raid', rid: 'r_3' } }),
  ];
  const ATTN = (items, over) => Object.assign({ today: '2026-10-17', total: items.filter(i => i.severity === 'action').length, items, more: {} }, over || {});
  const attnHtml = (data, extra, g) => G.pages.attention.attentionHtml(Object.assign({ guildData: g || gd(OFFICER_CAN), data }, extra || {}));
  const textOf = (kind, over) => G.pages.attention.itemText(item(kind, over));

  await check('Home: each kind reads as the contract sentence (singular and plural, trials by days)', () => {
    assert.equal(textOf('review', { date: '2026-10-17', count: 3 }), 'Review Sat Oct 17: 3 to decide');
    assert.equal(textOf('loot_unmatched', { date: '2026-10-17', count: 3 }), '3 loot winners on Sat Oct 17 match nobody');
    assert.equal(textOf('loot_unmatched', { date: '2026-10-17', count: 1 }), '1 loot winner on Sat Oct 17 matches nobody');
    assert.equal(textOf('signup_unmatched', { date: '2026-10-17', count: 2 }), '2 sign-ups on Sat Oct 17 are not linked to a person');
    assert.equal(textOf('signup_unmatched', { date: '2026-10-17', count: 1 }), '1 sign-up on Sat Oct 17 is not linked to a person');
    assert.equal(textOf('claims', { count: 3 }), '3 character claims are waiting');
    assert.equal(textOf('claims', { count: 1 }), '1 character claim is waiting');
    assert.equal(textOf('trial', { name: 'Thoren', days: 3, ended: false }), 'Thoren\'s trial ends in 3 days');
    assert.equal(textOf('trial', { name: 'Thoren', days: 1, ended: false }), 'Thoren\'s trial ends tomorrow');
    assert.equal(textOf('trial', { name: 'Thoren', days: 0, ended: false }), 'Thoren\'s trial ends today');
    assert.equal(textOf('trial', { name: 'Thoren', days: 2, ended: true }), 'Thoren\'s trial ended 2 days ago');
    assert.equal(textOf('trial', { name: 'Thoren', days: -2, ended: true }), 'Thoren\'s trial ended 2 days ago', 'a negative day count reads the same');
    assert.equal(textOf('trial', { name: 'Thoren', days: 1, ended: true }), 'Thoren\'s trial ended yesterday');
    assert.equal(textOf('no_loot', { date: '2026-10-10' }), 'No loot imported for Sat Oct 10');
    assert.equal(textOf('low_signups', { date: '2026-10-21', expected: 18, size: 25 }), 'Wed Oct 21: 18 of 25 signed up');
    assert.equal(textOf('unlocked', { date: '2026-10-21', minutes: 45 }), 'Sign-ups for Wed Oct 21 are still open and the raid starts in 45 minutes');
    assert.equal(textOf('unlocked', { date: '2026-10-21', minutes: 1 }), 'Sign-ups for Wed Oct 21 are still open and the raid starts in 1 minute');
  });

  await check('Home: item links are the contract routes with the guild id added; an unknown link name falls back to Roster', () => {
    const href = it => G.pages.attention.itemHref('g1', it);
    assert.equal(href(item('review', { link: { name: 'raid', rid: 'r_1' } })), '#/g/g1/raids/r/r_1');
    assert.equal(href(item('claims', { link: { name: 'review' } })), '#/g/g1/attendance/review');
    assert.equal(href(item('trial', { link: { name: 'person', pid: 'p_t' } })), '#/g/g1/roster/p/p_t');
    assert.equal(href(item('watch', { link: { name: 'personatt', pid: 'p_k' } })), '#/g/g1/attendance/p/p_k');
    assert.equal(href(item('watch', { link: { name: 'planner' } })), '#/g/g1/roster');
    assert.equal(href(item('watch', { link: null })), '#/g/g1/roster');
    assert.equal(href(item('review', { link: { name: 'raid', rid: 'r_1', gid: 'g_evil' } })), '#/g/g1/raids/r/r_1', 'the item cannot name another guild');
  });

  await check('Home (round 4): the to-dos without a raid, the Guild box, Earlier raids and the buttons named for the kind; no Needs attention list, no watch or rank rows', () => {
    const items = FULL.filter(i => i.kind !== 'watch' && i.kind !== 'low_signups' && i.kind !== 'unlocked');
    const out = attnHtml(ATTN(items, { total: items.length }));
    assert(out.includes('<h1 class="gs-h1 gs-hd-h1" id="page-title" tabindex="-1">This week</h1>'));
    assert(!out.includes('Needs attention') && !out.includes('For your information') && !out.includes('attendance watch'), 'the old lists are gone');
    const guild = out.slice(out.indexOf('aria-label="Guild"'), out.indexOf('<nav class="gs-hd-more"'));
    assert(guild.includes('3 character claims are waiting') && guild.includes('Thoren&#39;s trial ends in 3 days'), 'to-dos without a raid');
    const earlier = guild.slice(guild.indexOf('Earlier raids'));
    assert(earlier.includes('Review Sat Oct 17: 3 to decide') && earlier.includes('No loot imported for Sat Oct 10'), 'raid to-dos older than yesterday');
    assert(!guild.slice(0, guild.indexOf('Earlier raids')).includes('Review Sat Oct 17'), 'not above the Earlier raids label');
    assert(out.includes('<a class="gs-btn gs-btn-sm" href="#/g/g1/raids/r/r_1" aria-label="Review (Review Sat Oct 17: 3 to decide)"><span>Review</span></a>'), 'a secondary button named for the kind and for the row');
    assert(out.includes('aria-label="Open roster (Thoren&#39;s trial ends in 3 days)"') && out.includes('href="#/g/g1/roster/p/p_t"'));
    assert.equal((out.match(/gs-btn-molten/g) || []).length, 2, 'no raid this week: the one primary ("Add raid") once per variant');
    assert(out.includes('id="attn-status" role="status"'), 'a live region for the results');
    assertNoRawAttrs(out);
  });

  await check('Home (round 4): the team shows as a muted line on a to-do only when the guild has several active teams', () => {
    const items = [item('no_loot', { raidId: 'r_9', date: '2026-10-10', zone: 'Karazhan', title: null })];
    assert(attnHtml(ATTN(items)).includes('<span class="gs-hd-todo-meta">Team KJ</span>'));
    assert(!attnHtml(ATTN(items), {}, gd(OFFICER_CAN, null, ONE_TEAM)).includes('Team KJ'), 'a one-team guild never names the team');
  });

  await check('Home: review items select their team first (data-action + data-team); other items are plain links', () => {
    const out = attnHtml(ATTN(FULL));
    assert(out.includes('href="#/g/g1/attendance/review" aria-label="Link winners (3 loot winners on Sat Oct 17 match nobody)" data-action="attn-open" data-team="t1"><span>Link winners</span></a>'));
    assert(!/href="#\/g\/g1\/raids\/r\/r_1"[^>]* data-action="attn-open"/.test(out));
    const claims = out.slice(out.indexOf('3 character claims are waiting'), out.indexOf('Thoren&#39;s trial ends'));
    assert(!claims.includes('data-action="attn-open"'), 'a claim has no team to pick');
  });

  await check('Home (round 4): nothing to do says so in the Guild box; "and N more" lines link to the page where the work is done; readiness facts are no to-dos', () => {
    const empty = attnHtml(ATTN([]));
    assert(empty.includes('Nothing to do.') && empty.includes('Hidden (0)') && empty.includes('No raid this week'));
    const counts = { review: 4, trial: 2, loot_unmatched: 1, claims: 5, signup_unmatched: 2, no_loot: 1 };
    const more = attnHtml(ATTN(FULL, { more: counts }));
    const want = { review: '#/g/g1/attendance/review', loot_unmatched: '#/g/g1/attendance/review', signup_unmatched: '#/g/g1/raids', claims: '#/g/g1/attendance/review', trial: '#/g/g1/roster', no_loot: '#/g/g1/raids' };
    for (const k of Object.keys(want)) {
      const kind = G.pages.attention.KINDS.filter(x => x.id === k)[0];
      const text = 'and ' + counts[k] + ' more: ' + kind.heading.charAt(0).toLowerCase() + kind.heading.slice(1);
      assert(more.includes('<span class="gs-hd-todo-title">' + text + '</span>'), k);
      assert(more.includes('href="' + want[k] + '" aria-label="See all (' + text + ')"><span>See all</span></a>'), k + ' link');
    }
    assert(!attnHtml(ATTN(FULL, { more: { review: 0 } })).includes('and 0 more'));
    assert(!attnHtml(ATTN([], { more: { low_signups: 3, unlocked: 2 } })).includes('and 3 more'), 'readiness facts are no to-dos');
  });

  await check('Home: a failed refresh shows the message with Try again and keeps what loaded; hostile strings in every field are escaped', () => {
    const failedOut = attnHtml(ATTN(FULL), { error: 'Could not reach Raidsmith.', refreshing: true });
    assert(failedOut.includes('Could not reach Raidsmith.') && failedOut.includes('role="alert"') && failedOut.includes('Review Sat Oct 17: 3 to decide'));
    assert(/aria-busy="true" disabled data-action="attn-refresh" data-key="attn-refresh"><span>Trying again\.\.\.<\/span>/.test(failedOut));
    const bad = ATTN([
      item('review', { date: HOSTILE, count: HOSTILE, zone: HOSTILE + QUOTES, title: QUOTES, teamName: HOSTILE + QUOTES, link: { name: 'raid', rid: HOSTILE + QUOTES } }),
      item('trial', { name: HOSTILE + QUOTES, days: HOSTILE, ended: false, link: { name: 'person', pid: QUOTES } }),
      item('claims', { count: HOSTILE, teamId: QUOTES, link: { name: 'review' } }),
    ], { more: { review: HOSTILE }, week: [{ raidId: HOSTILE, teamId: 't1', teamName: HOSTILE + QUOTES, date: '2026-10-17', startsAt: 1, zone: HOSTILE + QUOTES, title: QUOTES, size: HOSTILE, signed: HOSTILE, status: 'short' }],
      hidden: [{ item: item('no_loot', { id: QUOTES, date: HOSTILE }), mode: 'dismiss', until: null, by: { name: HOSTILE + QUOTES }, at: 1 }] });
    const out = attnHtml(bad, { hiddenOpen: true }, gd(OFFICER_CAN, { guild: Object.assign({}, gd(OFFICER_CAN).guild, { name: HOSTILE + QUOTES }) }));
    assertEscaped(out, 'Home');
    assertNoRawAttrs(out);
    assert(!attnHtml({ total: 1, items: [{ id: 'x', kind: HOSTILE, severity: 'action', link: { name: 'raid', rid: 'r' } }, null], more: {} }).includes('<img'), 'an unknown kind or a null item draws nothing');
  });

  await check('Home: load() reads fresh and keeps the nav count; main() is loading until then; Refresh re-reads, updates both copies, and reports a failure', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    S.guilds.g1 = g; S.currentGid = 'g1';
    assert(G.pages.attention.main({ name: 'section', section: 'home' }, g, {}).includes('Loading this week'));
    let s = stub(() => Promise.resolve(ATTN(FULL)));
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/attention']]);
    assert.equal(S.attention.g1.data.total, 8, 'the nav badge reads the same answer');
    assert.equal(G.app.attentionCountFor('g1'), 8);
    assert(G.pages.attention.main({}, g, {}).includes('Review Sat Oct 17: 3 to decide'));
    s.restore();
    s = stub(() => Promise.resolve(ATTN([FULL[0]])));
    await G.handlers.click['attn-refresh'](el({}));
    assert.equal(s.calls.length, 1);
    assert.equal(S.att.attention.data.items.length, 1);
    assert.equal(S.att.attention.refreshing, false);
    assert.equal(G.app.attentionCountFor('g1'), 1);
    s.restore();
    s = stub(() => Promise.reject(ApiErr(500, 'error')));
    await G.handlers.click['attn-refresh'](el({}));
    assert.equal(S.att.attention.error, 'Server says so.');
    assert.equal(S.att.attention.data.items.length, 1, 'the last list stays');
    assert.equal(G.app.attentionCountFor('g1'), 1);
    s.restore();
    let failures = 0;
    ctx.Guild.app.showFailure = () => { failures++; };
    s = stub(() => Promise.reject(ApiErr(403, 'forbidden')));
    await G.handlers.click['attn-refresh'](el({}));
    assert.equal(failures, 1, 'a 403 is the message page');
    s.restore();
    // while a refresh runs, a second click does nothing
    S.att.attention.refreshing = true;
    s = stub(() => Promise.resolve(ATTN([])));
    G.handlers.click['attn-refresh'](el({}));
    assert.equal(s.calls.length, 0);
    s.restore();
    await assert.rejects(() => { const x = stub(() => Promise.reject(ApiErr(403, 'forbidden'))); return G.pages.attention.load({}, g).finally(x.restore); }, e => e.status === 403);
  }));

  await check('Home: opening a review item selects its team (state and the stored pick); an unknown team changes nothing', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.teamByGuild.g1 = 't1';
    G.handlers.click['attn-open'](el({ 'data-team': 't2' }));
    assert.equal(S.teamByGuild.g1, 't2');
    G.handlers.click['attn-open'](el({ 'data-team': 'tX' }));
    assert.equal(S.teamByGuild.g1, 't2');
    G.handlers.click['attn-open'](el({}));
    assert.equal(S.teamByGuild.g1, 't2');
    assert.equal(G.app.selectTeam('g1', 't1'), true);
    assert.equal(S.teamByGuild.g1, 't1');
    assert.equal(G.app.selectTeam('g1', 'tX'), false);
    assert.equal(G.app.selectTeam('g9', 't1'), false, 'a guild that is not loaded');
    S.guilds.g1.teams[1].archived = true;
    assert.equal(G.app.selectTeam('g1', 't2'), false, 'an archived team is not a pick');
    assert.equal(S.teamByGuild.g1, 't1');
  }));

  await check('Home count: read for attention viewers only, once per minute, shared between callers, failures keep the last answer and are not retried at once', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN);
    let release;
    let s = stub(() => new Promise(resolve => { release = () => resolve({ total: 4, items: [], more: {} }); }));
    const a1 = G.app.ensureAttention('g1', false);
    const a2 = G.app.ensureAttention('g1', false);
    assert.equal(s.calls.length, 1, 'two callers share one request');
    release(); await Promise.all([a1, a2]);
    assert.equal(G.app.attentionCountFor('g1'), 4);
    assert(typeof S.attention.g1.at === 'number');
    await G.app.ensureAttention('g1', false);
    assert.equal(s.calls.length, 1, 'fresh enough: no request');
    S.attention.g1.at = Date.now() - 61000;
    s.restore();
    s = stub(() => Promise.resolve({ total: 6, items: [], more: {} }));
    await G.app.ensureAttention('g1', false);
    assert.equal(s.calls.length, 1, 'older than a minute: read again');
    assert.equal(G.app.attentionCountFor('g1'), 6);
    await G.app.ensureAttention('g1', true);
    assert.equal(s.calls.length, 2, 'force reads regardless');
    s.restore();
    S.attention.g1.at = Date.now() - 61000;
    s = stub(() => Promise.reject(ApiErr(500, 'error')));
    await G.app.ensureAttention('g1', false);
    assert.equal(G.app.attentionCountFor('g1'), 6, 'a failed read keeps the last count');
    await G.app.ensureAttention('g1', false);
    assert.equal(s.calls.length, 1, 'and is not asked again before the minute is up');
    s.restore();
    S.guilds.g1 = gd(MEMBER_CAN);
    S.attention = {};
    s = stub(() => Promise.resolve({ total: 9 }));
    await G.app.ensureAttention('g1', true);
    assert.equal(s.calls.length, 0, 'members never ask');
    assert.equal(G.app.attentionCountFor('g1'), 0);
    S.guilds = {};
    await G.app.ensureAttention('g1', true);
    assert.equal(s.calls.length, 0, 'a guild that is not loaded');
    s.restore();
    assert.equal(G.app.buildCtx(null).attentionCount, 0, 'the shell context carries the count');
  }));

  // ═══ Trial review card ══════════════════════════════════════════
  const TRIAL_CAN = { edit: true, notesView: true, notesEdit: true, delete: false, addCharacter: true };
  const record = (over, can) => Object.assign({
    today: '2026-10-17', can: Object.assign({}, TRIAL_CAN, can || {}),
    person: { id: 'p_t', status: 'trial', joinedOn: '2026-09-19', trialStart: '2026-10-03', trialEnd: '2026-10-24', trialFlag: { kind: 'ends', days: 7 }, isMe: false, version: 4, discord: { signIn: 'not_yet', user: null, nickname: null }, homeTeam: { id: 't1', name: 'Team KJ' } },
    characters: [{ id: 'c1', name: 'Thoren', class: 'PALADIN', mainSpec: 'Protection', offSpec: null, role: 'tank', isMain: true, team: { id: 't1', name: 'Team KJ', archived: false } }],
    notes: { text: 'Likes fire', version: 2, updatedBy: null, updatedAt: null },
  }, over || {});
  const LOOT_ITEMS = Array.from({ length: 12 }, (_, i) => ({ itemId: 100 + i, itemName: 'Item ' + (i + 1), tag: i === 1 ? 'OS' : 'MS', raidOn: '2026-10-10' }));
  const TRIAL = over => Object.assign({
    today: '2026-10-17', person: { id: 'p_t', name: 'Thoren', status: 'trial', trialStart: '2026-10-03', trialEnd: '2026-10-24', trialFlag: { kind: 'ends', days: 7 }, joinedOn: '2026-09-19', version: 4 }, since: '2026-10-03',
    attendance: { team: { id: 't1', name: 'Team KJ' }, raids: 6, pct: 83.3, present: 5, missed: 1, missedNotice: 1, late: 1, leftEarly: 0, fillIns: 1, pending: 0 },
    loot: { total: 3, ms: 2, os: 1, de: 0, bank: 0, items: LOOT_ITEMS.slice(0, 3) },
    notes: { excerpt: 'Likes fire. Late twice.', truncated: true },
  }, over || {});
  const stripTags = h => h.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
  const count = (h, re) => (h.match(re) || []).length;
  const card = (data, rec, extra) => G.pages.personTrial.cardHtml(Object.assign({ guildData: gd(OFFICER_CAN), gid: 'g1', pid: 'p_t', record: rec || record(), state: { gid: 'g1', pid: 'p_t', data, error: '' } }, extra || {}));

  await check('trial card: the decision panel (title, dates and words, five figures, the note as a quote, Promote / Extend / End trial) from the contract answer', () => {
    const out = card(TRIAL());
    assert(out.includes('<h2 class="gs-pr-h" id="trial-card-h">Trial review</h2>') && !out.includes('gs-hd-chip') && !out.includes('gs-chip-trial'), 'the one trial chip is in the page head, not here');
    assert(stripTags(out).includes('Oct 3, 2026 - Oct 24, 2026 - ends in 7 days'));
    const fig = (label, value, note) => assert(out.includes('<span class="gs-pr-cap">' + label + '</span><span class="gs-pr-numrow"><span class="gs-pr-num">' + value + '</span>' + (note ? '<span class="gs-pr-mut">' + note + '</span>' : '</span>')), label + ' ' + value);
    fig('Raids', 6); fig('Attendance', '83%', '5 of 6'); fig('Missed', 1, '1 with notice'); fig('Late or left early', 1); fig('Loot', '2 MS, 1 OS');
    assert(!out.includes('Item 1') && !out.includes('Loot received'), 'the items are the Loot panel\'s');
    assert(out.includes('<p class="gs-pr-quote">&quot;Likes fire. Late twice.&quot;'));
    for (const [action, label] of [['trial-promote', 'Promote to Raider'], ['trial-extend', 'Extend trial'], ['trial-end', 'End trial']]) {
      assert(new RegExp('<button type="button" class="gs-btn[^"]*" data-action="' + action + '" data-key="[^"]+"><span>' + label + '</span></button>').test(out), action);
    }
    assert(out.includes('class="gs-btn gs-btn-molten" data-action="trial-promote"') && out.includes('class="gs-btn gs-btn-ghost" data-action="trial-end"') && count(out, /gs-btn-molten/g) === 1, 'Promote is the one primary');
    assertNoRawAttrs(out);
    // The author and day of the note come from the record's notes.
    const attributed = card(TRIAL(), record({ notes: { text: 'Likes fire', version: 2, updatedBy: { displayName: 'Alice' }, updatedAt: Date.UTC(2026, 9, 15, 1, 14) } }));
    assert(stripTags(attributed).includes('Likes fire. Late twice.&quot; - Alice,') || stripTags(attributed).includes('- Alice,'));
  });

  await check('trial card: figures with no loot or note leave their part out; attendance null says so; open raids are noted; Extend uses the team trial length', () => {
    assert(card(TRIAL({ loot: { total: 4, ms: 1, os: 1, de: 1, bank: 1, items: [] } })).includes('1 MS, 1 OS, 1 DE, 1 Bank'));
    assert(card(TRIAL({ loot: { total: 0, ms: 0, os: 0, de: 0, bank: 0, items: [] } })).includes('<span class="gs-pr-num">0</span>'));
    const noLoot = card(TRIAL({ loot: null }));
    assert(!noLoot.includes('>Loot<'), 'no loot figure when the Worker sent none');
    const noNotes = card(TRIAL({ notes: null }));
    assert(!noNotes.includes('gs-pr-quote'));
    assert(!card(TRIAL({ notes: { excerpt: '', truncated: false } })).includes('gs-pr-quote'));
    const noAtt = card(TRIAL({ attendance: null }));
    assert(noAtt.includes('Attendance is not available for this person yet.') && !noAtt.includes('>Raids<') && noAtt.includes('data-action="trial-promote"'), 'the decision buttons stay');
    assert(card(TRIAL({ attendance: Object.assign({}, TRIAL().attendance, { pending: 2, pct: null }) })).includes('2 raids are awaiting review and not counted yet.'));
    assert(card(TRIAL({ attendance: Object.assign({}, TRIAL().attendance, { pending: 1, pct: null }) })).includes('<span class="gs-pr-cap">Attendance</span><span class="gs-pr-numrow"><span class="gs-pr-num">-</span>'));
    const P = G.pages.personTrial;
    // The Extend date starts the team's trial length after the later of the current end and today (14 when the team has none).
    const date = html => html.match(/name="trialEnd"[^>]*value="([^"]+)"/)[1];
    assert.equal(date(P.extendDialogHtml(record(), '2026-10-17')), '2026-11-07', 'default 14 days after Oct 24');
    assert.equal(date(P.extendDialogHtml(record(), '2026-10-17', 21)), '2026-11-14');
    assert.equal(date(P.extendDialogHtml(record({ person: Object.assign({}, record().person, { trialEnd: '2026-10-01' }) }), '2026-10-17', 7)), '2026-10-24', 'from today when the end has passed');
    assert.equal(P.teamTrialDays({ teams: [{ id: 't1', trialDays: 21 }] }, record()), 21);
    assert.equal(P.teamTrialDays({ teams: [{ id: 't1' }] }, record()), 14);
    assert.equal(P.teamTrialDays({ teams: [] }, record()), 14);
  });

  await check('trial card: the dates and words follow the record (a trial with no end date still gets the card)', () => {
    const noEnd = card(TRIAL(), record({ person: Object.assign({}, record().person, { trialEnd: null, trialFlag: null }) }));
    assert(stripTags(noEnd).includes('Started Oct 3, 2026. No end date is set.') && noEnd.includes('data-action="trial-extend"'));
    const ended = card(TRIAL(), record({ person: Object.assign({}, record().person, { trialEnd: '2026-10-10', trialFlag: { kind: 'ended', days: -7 } }) }));
    assert(stripTags(ended).includes('ended 7 days ago'));
    assert(card(TRIAL(), record({ person: Object.assign({}, record().person, { trialStart: null, trialEnd: null, trialFlag: null }) })).includes('No trial dates are set.'));
  });

  await check('trial card: only for a Trial the viewer edits; no card without state, for "none", for other statuses, or without can.edit; an error shows Try again', () => {
    const P = G.pages.personTrial;
    assert.equal(card(TRIAL(), record({ person: Object.assign({}, record().person, { status: 'raider' }) })), '');
    assert.equal(card(TRIAL(), record({}, { edit: false })), '');
    assert.equal(P.cardHtml({ guildData: gd(OFFICER_CAN), gid: 'g1', pid: 'p_t', record: record(), state: null }), '');
    assert.equal(P.cardHtml({ guildData: gd(OFFICER_CAN), gid: 'g1', pid: 'p_t', record: record(), state: { none: true } }), '');
    assert.equal(P.shows(record()), true);
    assert.equal(P.shows(null), false);
    const err = P.cardHtml({ guildData: gd(OFFICER_CAN), gid: 'g1', pid: 'p_t', record: record(), state: { gid: 'g1', pid: 'p_t', data: null, error: 'Something went wrong.' } });
    assert(err.includes('Something went wrong.') && err.includes('data-action="trial-retry"') && !err.includes('data-action="trial-promote"'));
  });

  await check('trial card: hostile strings are escaped everywhere', () => {
    const data = TRIAL({
      attendance: Object.assign({}, TRIAL().attendance, { team: { id: 't1', name: HOSTILE + QUOTES } }),
      loot: { total: 1, ms: 1, os: 0, de: 0, bank: 0, items: [{ itemId: 1, itemName: HOSTILE + QUOTES, tag: HOSTILE, raidOn: HOSTILE }] },
      notes: { excerpt: HOSTILE + QUOTES, truncated: true }, since: HOSTILE,
    });
    const rec = record({ characters: [{ id: 'c1', name: HOSTILE + QUOTES, class: 'PALADIN', isMain: true, team: { id: 't1', name: 'T', archived: false } }] });
    const out = card(data, rec);
    assertEscaped(out, 'trial card');
    assertNoRawAttrs(out);
    for (const html of [G.pages.personTrial.promoteDialogHtml(rec), G.pages.personTrial.extendDialogHtml(rec, '2026-10-17'), G.pages.personTrial.endDialogHtml(rec)]) { assertEscaped(html, 'dialog'); assertNoRawAttrs(html); }
  });

  await check('trial card: the person page puts it under the head and before Characters, only when its state is passed', () => {
    const g = gd(OFFICER_CAN);
    const state = { gid: 'g1', pid: 'p_t', data: TRIAL(), error: '' };
    const out = G.pages.person.personHtml({ guildData: g, record: record(), linkable: null, alert: '', attendance: null, trial: state });
    assert(!out.includes('gs-trial-bar') && out.indexOf('id="trial-card-h"') > out.indexOf('</header>') && out.indexOf('id="trial-card-h"') < out.indexOf('id="characters-h"'), 'no banner; the panel is under the head and above Characters');
    assert(out.slice(0, out.indexOf('</header>')).includes('is-rose">Ends in 7 days<'), 'the head carries the one trial chip');
    // ONE set of trial buttons: the panel's.
    const buttons = (out.match(/<button[^>]*><span>(Promote to Raider|Extend trial|End trial|Make Raider|Set Inactive)<\/span>/g) || []).map((b) => b.replace(/^[\s\S]*<span>([^<]+)<\/span>$/, '$1'));
    assert.deepEqual(buttons, ['Promote to Raider', 'Extend trial', 'End trial'], 'the card\'s three buttons and no others');
    assert(!/data-action="person-(status|extend)"/.test(out));
    assert(!G.pages.person.personHtml({ guildData: g, record: record(), linkable: null, alert: '', attendance: null }).includes('trial-card-h'));
    assert(!G.pages.person.personHtml({ guildData: g, record: record({ person: Object.assign({}, record().person, { status: 'raider' }) }), linkable: null, alert: '', attendance: null, trial: state }).includes('trial-card-h'));
  });

  await check('trial card: loadCard asks only for a Trial the viewer edits, treats 403 / 404 as no card and any other failure as a card with Try again', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    S.guilds.g1 = g; S.currentGid = 'g1';
    const P = G.pages.personTrial;
    let s = stub(() => Promise.resolve(TRIAL()));
    await P.loadCard('g1', 'p_t', g, record({ person: Object.assign({}, record().person, { status: 'raider' }) }));
    await P.loadCard('g1', 'p_t', g, record({}, { edit: false }));
    assert.equal(s.calls.length, 0, 'no request for a raider or a viewer who cannot edit');
    assert.equal(P.cardState('g1', 'p_t'), null);
    await P.loadCard('g1', 'p_t', g, record());
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/roster/p_t/trial']]);
    assert.equal(P.cardState('g1', 'p_t').data.attendance.raids, 6);
    assert.equal(P.cardState('g1', 'other'), null);
    assert.equal(P.cardState('g2', 'p_t'), null);
    S.person = { gid: 'g1', pid: 'p_t', record: record() };
    s.restore();
    s = stub(() => Promise.reject(ApiErr(403, 'forbidden')));
    await P.loadCard('g1', 'p_t', g);
    assert.equal(P.cardState('g1', 'p_t'), null, '403 is no card (the open record was used)');
    s.restore();
    s = stub(() => Promise.reject(ApiErr(404, 'not_found')));
    await P.loadCard('g1', 'p_t', g, record());
    assert.equal(P.cardState('g1', 'p_t'), null);
    s.restore();
    s = stub(() => Promise.reject(ApiErr(500, 'error')));
    await P.loadCard('g1', 'p_t', g, record());
    assert.equal(P.cardState('g1', 'p_t').error, 'Server says so.');
    s.restore();
    s = stub(() => Promise.resolve(TRIAL()));
    await G.handlers.click['trial-retry'](el({}));
    assert.equal(P.cardState('g1', 'p_t').error, '');
    assert.equal(s.calls.length, 1);
    s.restore();
  }));

  // dialogs: openDialog is stubbed to capture the html; runDialog is the real one
  function captureDialogs() {
    const opened = [];
    ctx.Guild.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return {}; };
    return opened;
  }
  function openTrialPerson(S, rec, data) {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.person = { gid: 'g1', pid: 'p_t', record: rec || record() };
    S.att.personTrialCard = { gid: 'g1', pid: 'p_t', data: data || TRIAL(), error: '' };
  }
  const afterPatch = (over, can) => record(Object.assign({ person: Object.assign({}, record().person, { status: 'inactive', version: 5, trialFlag: null }) }, over || {}), can);

  await check('trial card: Promote to Raider asks first, then PATCHes status raider with the record\'s version and shows the answer', withState(async (S) => {
    openTrialPerson(S);
    const opened = captureDialogs();
    G.handlers.click['trial-promote'](el({}));
    assert.equal(opened.length, 1);
    assert(opened[0].html.includes('Promote Thoren to Raider?') && opened[0].html.includes('data-submit="trial-promote-form"') && opened[0].html.includes('data-action="dialog-cancel"') && opened[0].html.includes('id="dlg-error" role="alert" hidden'));
    assert.deepEqual(plain(opened[0].opts), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    const promoted = record({ person: Object.assign({}, record().person, { status: 'raider', version: 5, trialFlag: null }) });
    const s = stub(() => Promise.resolve(promoted));
    await G.handlers.submit['trial-promote-form'](form({}));
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['patch', '/api/guild/g1/roster/p_t', { expectedVersion: 4, status: 'raider' }]]);
    assert.equal(S.person.record.person.status, 'raider', 'the person page now shows the saved record');
    assert.equal(G.pages.personTrial.cardHtml({ guildData: gd(OFFICER_CAN), gid: 'g1', pid: 'p_t', record: S.person.record, state: S.att.personTrialCard }), '', 'and the card is gone');
    // a person who is not an editable Trial opens nothing
    opened.length = 0;
    G.handlers.click['trial-promote'](el({}));
    assert.equal(opened.length, 0);
  }));

  await check('trial card: a lost race (409) shows the server\'s copy through the page-wide conflict handler; other errors stay in the dialog', withState(async (S) => {
    openTrialPerson(S);
    captureDialogs();
    const current = record({ person: Object.assign({}, record().person, { version: 9, trialEnd: '2026-11-01' }) });
    let s = stub(() => Promise.reject(ApiErr(409, 'conflict', { current })));
    await G.handlers.submit['trial-promote-form'](form({}));
    s.restore();
    assert.equal(S.person.record.person.version, 9);
    assert.equal(S.pageAlert, G.pages.person.CONFLICT_TEXT);
    let shown = [];
    ctx.Guild.ui.showFormError = (f, err) => shown.push(err.message);
    s = stub(() => Promise.reject(ApiErr(500, 'error')));
    await G.handlers.submit['trial-promote-form'](form({}));
    s.restore();
    assert.deepEqual(shown, ['Server says so.']);
  }));

  await check('trial card: Extend trial defaults to 14 days after the later of the end date and today, wants a date after today, and PATCHes trialEnd', withState(async (S) => {
    openTrialPerson(S);
    const opened = captureDialogs();
    G.handlers.click['trial-extend'](el({}));
    assert(opened[0].html.includes('Extend Thoren&#39;s trial') && opened[0].html.includes('type="date" id="dlg-tend" name="trialEnd"') && opened[0].html.includes('value="2026-11-07"') && opened[0].html.includes('min="2026-10-18"'), 'end 10-24 is after today: +14 from it');
    S.person.record = record({ person: Object.assign({}, record().person, { trialEnd: '2026-10-10', trialFlag: { kind: 'ended', days: -7 } }) });
    G.handlers.click['trial-extend'](el({}));
    assert(opened[1].html.includes('value="2026-10-31"'), 'an end in the past: +14 from today');
    S.person.record = record({ person: Object.assign({}, record().person, { trialEnd: null, trialFlag: null }) });
    G.handlers.click['trial-extend'](el({}));
    assert(opened[2].html.includes('value="2026-10-31"'), 'no end date: +14 from today');
    assert(opened[2].html.includes('id="dlg-err-trialEnd" role="alert" hidden'));
    // validation
    const slot = fakeEl('dlg-err-trialEnd', { hidden: true });
    let s = stub(() => Promise.resolve(record()));
    for (const [value, text] of [['', 'Choose the new end date.'], ['2026-10-17', 'Choose a date after today.'], ['2026-10-01', 'Choose a date after today.']]) {
      const f = form({ trialEnd: { value } });
      await G.handlers.submit['trial-extend-form'](f);
      assert.equal(slot.textContent, text, value || 'blank');
      assert.equal(f.elements.trialEnd.focused, 1);
    }
    assert.equal(s.calls.length, 0, 'nothing was sent');
    const extended = record({ person: Object.assign({}, record().person, { trialEnd: '2026-11-01', version: 5 }) });
    s.restore();
    s = stub(() => Promise.resolve(extended));
    await G.handlers.submit['trial-extend-form'](form({ trialEnd: { value: '2026-10-18' } }));
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['patch', '/api/guild/g1/roster/p_t', { expectedVersion: 4, trialEnd: '2026-10-18' }]]);
    assert.equal(S.person.record.person.trialEnd, '2026-11-01');
  }));

  await check('trial card: End trial sets Inactive with reason Other; a typed note is then appended to the officer notes when the viewer may edit them', withState(async (S) => {
    openTrialPerson(S);
    const opened = captureDialogs();
    G.handlers.click['trial-end'](el({}));
    assert(opened[0].html.includes('End Thoren&#39;s trial?') && opened[0].html.includes('<textarea class="gs-input gs-textarea" id="dlg-note" name="note" data-field="note" rows="3" maxlength="300"') && opened[0].html.includes('data-submit="trial-end-form"'));
    const noteless = G.pages.personTrial.endDialogHtml(record({}, { notesEdit: false }));
    assert(!noteless.includes('<textarea') && noteless.includes('End trial</span></button>'), 'no note field for someone who cannot edit the notes');
    // with a note
    let s = stub((m, url, body) => (m === 'patch' ? Promise.resolve(afterPatch({ notes: { text: 'Likes fire', version: 3 } })) : Promise.resolve({ notes: { text: body.text, version: 4 } })));
    await G.handlers.submit['trial-end-form'](form({ note: { value: '  Never showed up  ' } }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [
      ['patch', '/api/guild/g1/roster/p_t', { expectedVersion: 4, status: 'inactive', leftReason: 'other' }],
      ['put', '/api/guild/g1/roster/p_t/notes', { text: 'Likes fire\nTrial ended 2026-10-17: Never showed up', expectedNotesVersion: 3 }],
    ]);
    assert.equal(S.person.record.person.status, 'inactive');
    assert.equal(S.person.record.notes.version, 4, 'the page now holds the saved notes');
    assert.equal(S.pageAlert, '');
    // empty notes start the text
    openTrialPerson(S);
    s = stub((m, url, body) => (m === 'patch' ? Promise.resolve(afterPatch({ notes: { text: '', version: 1 } })) : Promise.resolve({ notes: { text: body.text, version: 2 } })));
    await G.handlers.submit['trial-end-form'](form({ note: { value: 'x'.repeat(400) } }));
    await settle();
    s.restore();
    assert.equal(s.calls[1].body.text, 'Trial ended 2026-10-17: ' + 'x'.repeat(300), 'at most 300 characters of the note');
    assert.equal(s.calls[1].body.expectedNotesVersion, 1);
  }));

  await check('trial card: End trial without a note, or without notesEdit, sends no notes call; a failed notes save is a message, not an error', withState(async (S) => {
    openTrialPerson(S);
    captureDialogs();
    let s = stub(() => Promise.resolve(afterPatch({ notes: { text: 'a', version: 3 } })));
    await G.handlers.submit['trial-end-form'](form({ note: { value: '   ' } }));
    openTrialPerson(S);
    await G.handlers.submit['trial-end-form'](form({}));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m), ['patch', 'patch'], 'only the PATCH');
    openTrialPerson(S);
    s = stub(() => Promise.resolve(afterPatch({ notes: { text: 'a', version: 3 } }, { notesEdit: false })));
    await G.handlers.submit['trial-end-form'](form({ note: { value: 'typed anyway' } }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m), ['patch'], 'the response says the notes are read-only');
    // the notes save fails
    openTrialPerson(S);
    s = stub(m => (m === 'patch' ? Promise.resolve(afterPatch({ notes: { text: 'a', version: 3 } })) : Promise.reject(ApiErr(409, 'conflict'))));
    await G.handlers.submit['trial-end-form'](form({ note: { value: 'Gone' } }));
    await settle();
    s.restore();
    assert.equal(S.person.record.person.status, 'inactive', 'the trial was ended');
    assert.equal(S.pageAlert, 'The trial was ended, but the note could not be saved.');
    assert.equal(G.pages.personTrial.NOTE_FAILED, 'The trial was ended, but the note could not be saved.');
    // no notes object in the answer at all
    openTrialPerson(S);
    S.pageAlert = '';
    s = stub(() => Promise.resolve(afterPatch({ notes: null })));
    await G.handlers.submit['trial-end-form'](form({ note: { value: 'Gone' } }));
    await settle();
    s.restore();
    assert.equal(s.calls.length, 1);
    assert.equal(S.pageAlert, 'The trial was ended, but the note could not be saved.');
  }));

  // ═══ calendar link ══════════════════════════════════════════════
  const URL1 = 'https://raidsmith.example/cal/tok_AAAA.ics';
  const WEBCAL1 = 'webcal://raidsmith.example/cal/tok_AAAA.ics';
  function fakeDialog() {
    const dlg = { main: { innerHTML: '' }, listeners: {}, closed: 0 };
    dlg.querySelector = sel => (sel === '#cal-main' ? dlg.main : null);
    dlg.addEventListener = (type, fn) => { (dlg.listeners[type] = dlg.listeners[type] || []).push(fn); };
    dlg.close = () => { dlg.closed++; (dlg.listeners.close || []).forEach(fn => fn()); };
    return dlg;
  }
  function openCalendar(S, handler, can) {
    S.guilds.g1 = gd(can || MEMBER_CAN); S.currentGid = 'g1';
    S.att.raids = { gid: 'g1', teamId: 't1', data: { raids: [], upcoming: [] } };
    const dlg = fakeDialog();
    const opened = [];
    ctx.Guild.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return dlg; };
    const s = stub(handler);
    return { dlg, opened, s, main: () => dlg.main.innerHTML };
  }
  const click = (name, attrs) => G.handlers.click[name](el(attrs || {}));

  await check('calendar: the Raids header offers the button to everyone who sees the list (before New raid for officers), and not without a team', () => {
    const list = (can, teamId) => G.pages.raids.raidsHtml({ guildData: gd(can), teamId, data: { raids: [], upcoming: [] } });
    const member = list(MEMBER_CAN, 't1');
    assert(/<button type="button" class="gs-menu-item" role="menuitem" tabindex="-1" data-action="cal-open" data-key="mi-cal-open">Subscribe in your calendar<\/button>/.test(member), 'a menu item of the More menu');
    assert(member.includes('<div class="gs-pagehead-actions"><div class="gs-menu-wrap" data-menu><button') && !member.includes('raids-fill') && !member.includes('New raid'));
    const officer = list(OFFICER_CAN, 't1');
    assert(officer.includes('Backfill from Warcraft Logs') && officer.includes('>Raid schedule<') && officer.indexOf('data-action="cal-open"') > officer.indexOf('Raid schedule') && officer.indexOf('data-action="cal-open"') < officer.indexOf('>New raid<'));
    assert(!list(MEMBER_CAN, null).includes('cal-open'));
    assertNoRawAttrs(officer);
  });

  await check('calendar: the dialog reads the status first; not subscribed explains the link and offers Create my link', withState(async (S) => {
    const t = openCalendar(S, () => Promise.resolve({ team: T1, subscribed: false, createdAt: null, lastUsedAt: null }));
    const done = click('cal-open');
    assert.equal(t.opened.length, 1);
    assert(t.opened[0].html.includes('<h2 class="gs-dialog-title" id="cal-title">Subscribe in your calendar</h2>') && t.opened[0].html.includes('Raids of Team KJ') && t.opened[0].html.includes('Loading...') && t.opened[0].html.includes('id="cal-live" role="status"'));
    assert.deepEqual(plain(t.opened[0].opts), { labelledBy: 'cal-title' });
    await done;
    t.s.restore();
    assert.deepEqual(t.s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/calendar?team=t1']]);
    assert(t.main().includes(ctx.esc(G.pages.calendar.INTRO)) && t.main().includes('30 days back, 60 days ahead') && t.main().includes('Anyone with the link can see the raid times and sign-up counts'));
    assert(/id="cal-create" data-action="cal-create">Create my link</.test(t.main()) && t.main().includes('data-action="dialog-cancel">Close<'));
    assert(!t.main().includes('type="text"'), 'no link yet');
    assert.equal(els['cal-create'], undefined, 'focus targets only exist when the page has them');
  }));

  await check('calendar: Create my link shows the address once in a read-only box with Copy, the calendar-app link, the one-time notice, Replace and Turn off', withState(async (S) => {
    fakeEl('cal-url'); fakeEl('cal-live');
    const t = openCalendar(S, (m, url) => Promise.resolve(m === 'get' ? { team: T1, subscribed: false, createdAt: null, lastUsedAt: null } : { team: T1, subscribed: true, createdAt: 1790000000000, lastUsedAt: null, url: URL1, webcalUrl: WEBCAL1 }));
    await click('cal-open');
    await click('cal-create');
    t.s.restore();
    assert.deepEqual(t.s.calls.map(c => [c.m, c.url, c.body]), [['get', '/api/guild/g1/calendar?team=t1', undefined], ['post', '/api/guild/g1/calendar', { teamId: 't1' }]]);
    const m = t.main();
    assert(m.includes('<input class="gs-input" type="text" id="cal-url" readonly value="' + URL1 + '" data-key="cal-url">'));
    assert(m.includes('data-action="cal-copy">Copy</button>'));
    assert(m.includes('Copy it now - for your safety Raidsmith cannot show it again.'));
    assert(m.includes('<a class="gs-btn" id="cal-open-app" href="' + WEBCAL1 + '">Open in my calendar app</a>'));
    assert(m.includes('id="cal-replace-ask" data-action="cal-replace-ask">Replace link<') && m.includes('id="cal-off-ask" data-action="cal-off-ask">Turn off<'));
    assert.equal(els['cal-url'].focused, 1, 'the box is focused');
    assert.equal(els['cal-url'].selected, true, 'and selected');
    assert.equal(els['cal-live'].textContent, 'Your calendar link is ready. Copy it now.');
    assert.equal(G.pages.calendar.viewState().link.url, URL1);
    assertNoRawAttrs(m);
  }));

  await check('calendar: a subscribed status shows when it was made and last used but never the address; Replace warns and then issues a new link; Back returns', withState(async (S) => {
    const used = Date.now() - 2 * 86400000;
    const t = openCalendar(S, (m, url) => Promise.resolve(m === 'get' ? { team: T1, subscribed: true, createdAt: Date.UTC(2026, 9, 3, 12), lastUsedAt: used } : { team: T1, subscribed: true, createdAt: 1790000000001, lastUsedAt: null, url: 'https://raidsmith.example/cal/tok_BBBB.ics', webcalUrl: 'webcal://raidsmith.example/cal/tok_BBBB.ics' }));
    await click('cal-open');
    assert(t.main().includes('Your link is on (created Oct 3, 2026, last used 2 days ago).'));
    assert(t.main().includes('The link itself cannot be shown again.') && !t.main().includes('readonly') && !t.main().includes('Create my link'));
    assert(t.main().includes('data-action="cal-replace-ask">Replace link<') && t.main().includes('data-action="cal-off-ask">Turn off<'));
    click('cal-replace-ask');
    assert(t.main().includes('The old link stops working at once') && t.main().includes('id="cal-replace" data-action="cal-replace">Replace link<') && t.main().includes('data-action="cal-back">Back<'));
    assert(!t.main().includes('Turn off'), 'only the question and its two answers');
    click('cal-back');
    assert(t.main().includes('Your link is on'));
    click('cal-replace-ask');
    await click('cal-replace');
    t.s.restore();
    assert.deepEqual(t.s.calls.filter(c => c.m === 'post').map(c => c.body), [{ teamId: 't1' }]);
    assert(t.main().includes('value="https://raidsmith.example/cal/tok_BBBB.ics"') && !t.main().includes('tok_AAAA'));
    // Back from the question after a create returns to the address still held in memory
    click('cal-off-ask');
    click('cal-back');
    assert(t.main().includes('value="https://raidsmith.example/cal/tok_BBBB.ics"'));
  }));

  await check('calendar: last used reads relative or as a date; never used says so', () => {
    const U = G.pages.calendar.usageText;
    assert.equal(U({ createdAt: Date.UTC(2026, 9, 3, 12), lastUsedAt: null }), 'created Oct 3, 2026, not used yet');
    assert.equal(U({ createdAt: Date.UTC(2026, 9, 3, 12), lastUsedAt: Date.now() }), 'created Oct 3, 2026, last used today');
    assert.equal(U({ createdAt: Date.UTC(2026, 9, 3, 12), lastUsedAt: Date.now() - 86400000 }), 'created Oct 3, 2026, last used yesterday');
    assert(/last used on [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(U({ createdAt: Date.UTC(2026, 9, 3, 12), lastUsedAt: Date.UTC(2020, 0, 5, 12) })));
    assert.equal(U({}), 'not used yet');
  });

  await check('calendar: Turn off confirms in the dialog, DELETEs with the team and then says it is off; the address is dropped', withState(async (S) => {
    const t = openCalendar(S, (m) => Promise.resolve(m === 'get' ? { team: T1, subscribed: true, createdAt: 1790000000000, lastUsedAt: null } : { team: T1, subscribed: false }));
    await click('cal-open');
    click('cal-off-ask');
    assert(t.main().includes('Any calendar that uses it stops updating') && t.main().includes('id="cal-off" data-action="cal-off">Turn off<') && t.main().includes('gs-btn-danger'));
    assert.equal(t.s.calls.filter(c => c.m === 'del').length, 0, 'nothing is sent before the confirmation');
    await click('cal-off');
    t.s.restore();
    assert.deepEqual(t.s.calls.filter(c => c.m === 'del').map(c => [c.url, c.body]), [['/api/guild/g1/calendar', { teamId: 't1' }]]);
    assert(t.main().includes('Calendar link turned off.') && t.main().includes('data-action="dialog-cancel">Close<'));
    assert.equal(G.pages.calendar.viewState().link, null);
  }));

  await check('calendar: closing the dialog (Escape or Close) forgets the address; a late answer after closing changes nothing', withState(async (S) => {
    const pending = [];
    const t = openCalendar(S, (m) => (m === 'get' ? Promise.resolve({ team: T1, subscribed: false }) : new Promise(resolve => pending.push(resolve))));
    await click('cal-open');
    const creating = click('cal-create');
    t.dlg.close();
    assert.equal(G.pages.calendar.viewState(), null);
    const before = t.main();
    pending[0]({ team: T1, subscribed: true, url: URL1, webcalUrl: WEBCAL1 });
    await creating;
    t.s.restore();
    assert.equal(t.main(), before, 'the closed dialog was not redrawn');
    assert.equal(G.pages.calendar.viewState(), null, 'and the address is not kept anywhere');
    assert.equal(click('cal-create'), null, 'actions without a dialog do nothing');
    assert(!JSON.stringify(S).includes('tok_AAAA'), 'the address is not in the app state');
  }));

  await check('calendar: errors stay in the dialog (status read: Try again; create: message and the same buttons); sign-in loss closes it and goes to sign-in', withState(async (S) => {
    let mode = 'fail';
    const t = openCalendar(S, (m) => (mode === 'fail' ? Promise.reject(ApiErr(500, 'error')) : Promise.resolve({ team: T1, subscribed: false })));
    await click('cal-open');
    assert(t.main().includes('role="alert">Server says so.<') && t.main().includes('data-action="cal-retry">Try again<'));
    mode = 'ok';
    await click('cal-retry');
    assert(t.main().includes('Create my link') && /id="cal-error" role="alert" hidden>/.test(t.main()));
    mode = 'fail';
    await click('cal-create');
    assert(t.main().includes('role="alert">Server says so.<') && t.main().includes('Create my link'), 'still on the create step');
    assert.equal(G.pages.calendar.viewState().busy, false);
    // an answer without an address
    t.s.restore();
    const odd = stub((m) => Promise.resolve(m === 'post' ? { team: T1, subscribed: true } : { team: T1, subscribed: false }));
    await click('cal-create');
    assert(t.main().includes('The link could not be created.'));
    odd.restore();
    let signins = 0;
    ctx.Guild.app.requireSignin = () => { signins++; };
    const out = stub(() => Promise.reject(ApiErr(401, 'signed_out')));
    await click('cal-create');
    out.restore();
    assert.equal(signins, 1);
    assert.equal(t.dlg.closed, 1);
  }));

  await check('calendar: the calendar-app link accepts only webcal:// and https:// addresses; the address itself is escaped', withState(async (S) => {
    const P = G.pages.calendar;
    assert.equal(P.safeHref(WEBCAL1), WEBCAL1);
    assert.equal(P.safeHref(URL1), URL1);
    for (const bad of ['javascript:alert(1)', 'http://raidsmith.example/x.ics', 'data:text/html,x', 'WEBCAL://x', ' webcal://x', 'webcal://x y', 'webcal://x"onclick=1', '//x', '', null, undefined, 5]) assert.equal(P.safeHref(bad), '', String(bad));
    fakeEl('cal-url'); fakeEl('cal-live');
    const t = openCalendar(S, (m) => Promise.resolve(m === 'get' ? { team: T1, subscribed: false } : { team: T1, subscribed: true, url: 'https://x/' + HOSTILE + QUOTES, webcalUrl: 'javascript:alert(1)' }));
    await click('cal-open');
    await click('cal-create');
    t.s.restore();
    assertEscaped(t.main(), 'calendar dialog');
    assertNoRawAttrs(t.main());
    assert(!t.main().includes('Open in my calendar app'), 'a bad webcal address leaves no link; the https one is not valid here either');
    assert(!t.main().includes('javascript:'));
    assertEscaped(P.dialogHtml({ gid: 'g1', teamId: 't1', teamName: HOSTILE + QUOTES, phase: 'off', error: HOSTILE, busy: false }), 'dialog shell');
  }));

  await check('calendar: Copy goes through the planner\'s copyText and says the result in the dialog; without copyText it selects the text', withState(async (S) => {
    const input = fakeEl('cal-url'); fakeEl('cal-live'); const said = fakeEl('cal-copied', { hidden: true });
    const t = openCalendar(S, (m) => Promise.resolve(m === 'get' ? { team: T1, subscribed: false } : { team: T1, subscribed: true, url: URL1, webcalUrl: WEBCAL1 }));
    await click('cal-open');
    await click('cal-create');
    t.s.restore();
    // a page without the planner's helper: the box is selected
    input.focused = 0; input.selected = false;
    click('cal-copy');
    assert.equal(input.selected, true);
    assert.equal(said.textContent, 'The link is selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.');
    assert.equal(said.hidden, false);
    assert.equal(els['cal-live'].textContent, 'The link is selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.');
    // the helper copied it
    const calls = [];
    ctx.copyText = (text, message) => { calls.push([text, message]); return Promise.resolve(true); };
    input.selected = false;
    await click('cal-copy');
    assert.deepEqual(calls, [[URL1, 'Calendar link copied']]);
    assert.equal(said.textContent, 'Copied.');
    assert.equal(els['cal-live'].textContent, 'Copied.');
    assert.equal(input.selected, false, 'nothing to select by hand');
    // the browser refused and the helper opened its dialog
    ctx.copyText = () => Promise.resolve(false);
    await click('cal-copy');
    assert.equal(said.textContent, 'Your browser would not copy it. The link is in a dialog, selected: press Ctrl+C.');
    delete ctx.copyText;
  }));

  await check('calendar: cal-open does nothing without a loaded guild, Raids list or team', withState(async (S) => {
    const opened = captureDialogs();
    assert.equal(G.handlers.click['cal-open'](el({})), null);
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    assert.equal(G.handlers.click['cal-open'](el({})), null);
    S.att.raids = { gid: 'g1', teamId: null, data: null };
    assert.equal(G.handlers.click['cal-open'](el({})), null);
    assert.equal(opened.length, 0);
  }));

  // ═══ the code itself ════════════════════════════════════════════
  const NEW_PAGES = ['pages-settings-activity.js', 'pages-attention.js', 'pages-person-trial.js', 'pages-calendar.js'];
  const noComments = src => src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');

  await check('safety: the new pages never build a raw path (every call goes through G.api.audit / attention / trial / calendar), are ASCII with no inline styles or handlers', () => {
    for (const f of NEW_PAGES) {
      const src = read('js/guild/' + f);
      assert(!/G\.api\.(get|post|put|patch|del)\(/.test(src), f + ' goes through the wave-1 helpers');
      assert(!/['"`]\/api\//.test(src), f + ' has no /api path of its own');
      assert(!/[^\x00-\x7f]/.test(noComments(src)), f + ' is ASCII');
      assert(!/\sstyle=|\son(click|change|input|submit|focus|load|error)=/i.test(src), f + ' has inline style or handlers');
      assert(/^\/\/ ── /.test(src), f + ' starts with a header block');
    }
    for (const f of ['shell.js', 'router.js', 'api.js', 'icons.js', 'ui.js', 'app.js', 'pages-person.js', 'pages-raids.js', 'pages-attendance.js', 'pages-settings-attendance.js']) {
      assert(!/[^\x00-\x7f]/.test(noComments(read('js/guild/' + f))), f + ' is ASCII');
    }
    const api = read('js/guild/api.js');
    const block = api.slice(api.indexOf('// PM wave 1'));
    for (const p of ["'/audit'", "'/attention'", "'/trial'", "'/notes'", "'/calendar?team='", "'/calendar'"]) assert(block.includes(p), p);
  });

  await check('scripts: the four new pages are in the guild script list, in index.html, faq.html and whats-new.html, after the pages they build on and before app.js', () => {
    const idx = n => GUILD_SCRIPTS.indexOf('/js/guild/' + n + '.js');
    for (const name of ['pages-settings-activity', 'pages-attention', 'pages-person-trial', 'pages-calendar']) {
      const src = '/js/guild/' + name + '.js';
      assert(GUILD_SCRIPTS.includes(src), name);
      assert(idx(name) < idx('app'), name + ' before app.js');
      for (const page of ['index.html', 'faq.html', 'whats-new.html']) {
        const html = read(page);
        assert(guildScriptsOf(html).includes(src), name + ' in ' + page);
        const scripts = guildScriptsOf(html);
        assert.deepEqual(scripts.filter(s => GUILD_SCRIPTS.includes(s)), GUILD_SCRIPTS.filter(s => scripts.includes(s)), page + ' loads them in the shared order');
      }
    }
    assert(idx('pages-person-trial') > idx('pages-person') && idx('pages-person-trial') > idx('pages-person-attendance'));
    assert(idx('pages-calendar') > idx('pages-raids'));
    assert(idx('pages-settings-activity') > idx('pages-settings-attendance') && idx('pages-attention') > idx('pages-attendance'));
  });

  await check('guild.css: every gs- class the new pages use has a rule; the phone hides the Activity table; no custom properties, round corners or inline-style tricks were added', () => {
    const css = read('guild.css');
    const markup = NEW_PAGES.map(f => read('js/guild/' + f)).join('\n');
    const used = new Set();
    for (const m of markup.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
    for (const m of markup.matchAll(/'(gs-[a-z0-9_-]+)(?: [^']*)?'/g)) used.add(m[1]);
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    const notClasses = ['gs-page-alert']; // an element id passed to alertHtml as a plain string
    const missing = [...used].filter(c => !defined.has(c) && !notClasses.includes(c));
    assert.deepEqual(missing, [], 'classes with no CSS');
    for (const c of ['gs-audit-table', 'gs-attn2-item', 'gs-trial-card', 'gs-cal-url', 'gs-onboard-line']) assert(defined.has(c), c);
    const phone = css.slice(css.indexOf('@media (max-width: 600px)', css.indexOf('PM wave 1')));
    assert(/\.gs-audit-table \{ display: none; \}/.test(phone), 'the Activity table gives way to the cards on a phone');
    const wave = css.slice(css.indexOf('PM wave 1'), css.indexOf('\u2550\u2550 Design framework (Wave 0)')); // the sections up to the design framework's own
    assert(!/(^|[;{\s])--[\w-]+\s*:/.test(wave), 'no custom properties');
    assert(!/border-radius:\s*[^0]/.test(wave), 'flat corners');
    assert(!/!important/.test(wave));
    assert(!/[^\x00-\x7f]/.test(wave), 'ASCII');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
