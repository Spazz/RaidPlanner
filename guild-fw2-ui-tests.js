/**
 * Raidsmith guild UI - design framework Wave 2 (list pages on T1, imports on T5)
 *   5. Attendance and Loot: the viewer's own row pinned first ("You"), the legend folded behind a Legend toggle, an empty watch list as one phrase in the
 *      context line, the matrix at the page's full width with a sticky name column.
 *   6. Raids and Roster on the data table: the Plan column, the Sources column and the review chips are the officers'; the Roster says "Not signed in" in
 *      grey with the count in the head; the tab labels; the phone bottom bar (Home, Raids, Roster or Loot, Attendance, More).
 *   7. Every import walks Source, Preview, Import with one layout: the four roster pages (ui.importFlowHtml), the Gargul, TMB and softres panels
 *      (ui.importPanelHtml) and the pasted raid roster dialog.
 *   8. New raid asks for the Raid-Helper event first, no dialog ever stacks, and the open-flag count is one number (the Attendance tab, the Attendance
 *      page's Review queue link, the Review queue's header).
 * Plus the member Home's team (the team of their Main) and "Can't come" in the Raids list.
 * Run: node guild-fw2-ui-tests.js
 *
 * Same approach as guild-fw1b-ui-tests.js: the guild scripts load in a vm with no DOM and the pages return HTML strings. guild-fw2-worker-tests.js pins the
 * Worker side (me.mainTeamId / me.teamIds, isMe on the loot balance, the flag sum).
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
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const css = read('guild.css');
function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
ctx.window = { location: { origin: 'https://raidsmith.test', hash: '' } };
const G = ctx.Guild;
const S = G.app.state;
const plain = v => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => {
    o[m] = (url, body) => {
      calls.push({ m, url, body: body && plain(body) });
      try { return Promise.resolve(handler(m, url, body)); } catch (error) { return Promise.reject(error); }
    };
    return o;
  }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild' };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'], 'signups.self': ['t1'] };
const TEAM = (id, name) => ({ id, name, size: 25, archived: false, players: 3, leads: [] });
function gd(can, over) {
  const o = over || {};
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 },
    teams: o.teams || [TEAM('t1', 'Main team')],
    me: Object.assign({ roles: [{ role: can === MEMBER_CAN ? 'member' : 'officer' }], can, personId: null }, o.me || {}),
    attendanceFlags: o.attendanceFlags || {}, rosterFlags: {},
    rosterOptions: { classes: [] },
  };
}
const shellCtx = (can, over) => Object.assign({ section: 'guild', page: 'app', me: { user: { id: 'u1', username: 'u1' }, guilds: [{ id: 'g1', name: 'Ravens' }] }, route: { name: 'section', gid: 'g1', section: 'home' }, guildData: gd(can), teamId: 't1', attentionCount: 0 }, over || {});
const keys = items => plain(items.map(i => i.key));

(async () => {
  // ═══ phone tab bar ═══
  await check('phone tabs: an officer gets Home, Raids, Roster, Attendance, More; a member gets Home, Raids, Attendance, Loot, More; Settings lives under More', () => {
    assert.deepEqual(keys(G.shell.tabItems(shellCtx(OFFICER_CAN))), ['home', 'raids', 'roster', 'attendance', 'more']);
    assert.deepEqual(keys(G.shell.tabItems(shellCtx(MEMBER_CAN))), ['home', 'raids', 'attendance', 'loot', 'more']);
    const out = G.shell.slots(shellCtx(OFFICER_CAN)).tabs;
    assert(!out.includes('Settings') && !out.includes('Guild settings') && !out.includes('Planner'), 'neither is a tab');
    const more = out.slice(out.indexOf('<button'), out.indexOf('</button>'));
    assert(more.includes('data-action="open-drawer"') && more.includes('aria-haspopup="dialog"') && more.includes('aria-controls="gs-drawer"') && more.includes('>More<'), 'More opens the drawer, which holds Settings');
    assert(G.shell.slots(shellCtx(OFFICER_CAN)).drawer.includes('Guild settings'), 'the drawer carries Guild settings');
    assert(/button\.gs-tab\.is-active/.test(css), 'a pressed More tab is drawn like the others');
  });

  await check('phone tabs: Home is highlighted on Home; More is highlighted on a page that is not one of the four (Guild settings, Loot for an officer)', () => {
    const tabsFor = (route, can) => G.shell.slots(shellCtx(can || OFFICER_CAN, { route })).tabs;
    const active = html => [...html.matchAll(/class="gs-tab is-active"[^>]*?(?:aria-label="([^"]*)"|data-action="open-drawer")/g)].map(m => m[1] || 'More');
    assert.deepEqual(active(tabsFor({ name: 'section', gid: 'g1', section: 'home' })), ['Home']);
    assert.deepEqual(active(tabsFor({ name: 'section', gid: 'g1', section: 'raids' })), ['Raids']);
    assert.deepEqual(active(tabsFor({ name: 'person', gid: 'g1', pid: 'p1' })), ['Roster'], 'the roster tabs and person pages stay under Roster');
    assert.deepEqual(active(tabsFor({ name: 'settings', gid: 'g1', tab: null })), ['More']);
    assert.deepEqual(active(tabsFor({ name: 'section', gid: 'g1', section: 'loot' })), ['More'], 'Loot is under More for an officer');
    assert.deepEqual(active(tabsFor({ name: 'section', gid: 'g1', section: 'loot' }, MEMBER_CAN)), ['Loot'], 'and a tab for a member');
    assert(tabsFor({ name: 'section', gid: 'g1', section: 'home' }).includes('aria-current="page"'), 'aria-current marks the page tab');
  });

  // ═══ 5. Attendance ═══
  const cell = (raidId, date, weekStart, outcome) => ({ raidId, date, weekStart, outcome, letter: outcome === 'present' ? 'A' : 'M', pending: false });
  const person = (id, name, isMe, pct) => ({ id, name, class: 'DRUID', status: 'raider', isMe, pct, pctAll: pct, signupRate: 100, streak: 0, streakFlag: false, lastAttended: '2026-10-09', pending: 0,
    cells: [cell('r1', '2026-10-02', '2026-09-29', 'present'), cell('r2', '2026-10-09', '2026-10-06', 'present')] });
  const ATT = over => Object.assign({
    team: 't1', today: '2026-10-12', window: 8, policy: { switchWeeks: [8, 12], streakFlagAt: 4, creditValues: [] }, awaitingReview: 0, staleRaids: 0,
    weeks: [{ weekStart: '2026-09-29', raids: [{ id: 'r1', raidOn: '2026-10-02', zone: 'BT' }] }, { weekStart: '2026-10-06', raids: [{ id: 'r2', raidOn: '2026-10-09', zone: 'BT' }] }],
    people: [person('p_a', 'Aimer', false, 100), person('p_m', 'Me', true, 60), person('p_z', 'Zed', false, 90)],
    watch: { below: 0.75, dropBy: null, window: 8, previousFrom: null, entries: [] },
  }, over || {});
  const attHtml = (data, can, view) => G.pages.attendance.attendanceHtml({ guildData: gd(can || OFFICER_CAN, { attendanceFlags: { t1: 2 } }), teamId: 't1', data, view: Object.assign({ sort: G.pages.attendance.DEFAULT_SORT, includeInactive: false }, view || {}) });

  await check('attendance: the viewer\'s own row keeps its sorted place in the matrix and in the phone cards (never pinned), with the You tag and the tint', () => {
    const out = attHtml(ATT());
    const rows = [...out.matchAll(/<tr( class="is-you")?><th scope="row" class="gs-cell-strong">.*?gs-char-name[^>]*>([^<]*)</g)].map(m => [m[2], !!m[1]]);
    assert.deepEqual(rows, [['Aimer', false], ['Me', true], ['Zed', false]], 'A-Z, You in place');
    assert(out.includes('<span class="gs-you">You</span>'));
    const cards = [...out.matchAll(/<li class="gs-att-card( is-you)?">.*?gs-char-name[^>]*>([^<]*)</g)].map(m => m[2]);
    assert.deepEqual(cards, ['Aimer', 'Me', 'Zed']);
    const desc = attHtml(ATT(), OFFICER_CAN, { sort: { column: 'pct', dir: 'desc' } });
    assert.deepEqual([...desc.matchAll(/<tr( class="is-you")?><th scope="row" class="gs-cell-strong">.*?gs-char-name[^>]*>([^<]*)</g)].map(m => m[2]), ['Aimer', 'Zed', 'Me'], 'Me has the lowest %, so Me is last');
    assert.equal(G.pages.attendance.pinMine, undefined, 'the pin helper is gone');
    assert(!attHtml(ATT({ people: [person('p_a', 'Aimer', false, 100)] })).includes('class="is-you"'), 'a viewer with no row tints nothing');
  });

  await check('attendance: the legend is folded behind a Legend toggle; the page is one list page with the viewer\'s facts in a context line', () => {
    const out = attHtml(ATT());
    assert(out.includes('<details class="gs-how gs-legend-box"><summary>Legend</summary>') && !/<details[^>]*open/.test(out), 'closed');
    assert(count(out, /class="gs-legend-item"/g) >= 10, 'the legend is still all there for a click');
    assert(out.includes('<div class="gs-page gs-list-page gs-att-page">') && out.includes('<header class="gs-pagehead">') && out.includes('class="gs-listbar"'));
    assert(out.includes('Last 8 weeks - 3 people - 0 on the watch list - 2 flags to review'), out.slice(out.indexOf('gs-pagehead-context'), out.indexOf('gs-pagehead-context') + 200));
    assert(!out.includes('Nobody is on the watch list'));
  });

  await check('attendance: with people on the watch list the card stays above the matrix and the phrase counts them; no watch (cannot review) = no phrase', () => {
    const entry = { playerId: 'p_z', name: 'Zed', class: 'DRUID', status: 'raider', pct: 50, previousPct: 80, drop: 30, missed: 3, missedNotice: 0, counted: 6, reasons: ['below'] };
    const out = attHtml(ATT({ watch: { below: 0.75, dropBy: null, window: 8, previousFrom: null, entries: [entry] } }));
    assert(out.includes('1 on the watch list') && out.indexOf('id="att-watch-h"') > 0 && out.indexOf('id="att-watch-h"') < out.indexOf('class="gs-listbar"'));
    assert(!attHtml(ATT({ watch: null })).includes('on the watch list'));
  });

  await check('attendance: the matrix page is not capped at 1200 px; the name column and its head stay while the weeks scroll; the viewer\'s row has the gold edge', () => {
    assert(/\.gs-att-page \{ max-width: none; \}/.test(css), 'full width');
    assert(/\.gs-att-page \.gs-table-att \{ width: 100%/.test(css));
    assert(/\.gs-table-att th\[scope="row"\] \{[^}]*position: sticky; left: 0/.test(css), 'sticky name column');
    assert(/\.gs-table-att thead th:first-child \{ position: sticky; left: 0/.test(css), 'its head too');
    assert(/\.gs-table-att tr\.is-you th\[scope="row"\] \{[^}]*text-primary/.test(css) && /\.gs-att-card\.is-you \{[^}]*text-primary/.test(css));
  });

  // ═══ 5. Loot ═══
  const lootPerson = (personId, name, isMe, perRaid) => ({ personId, name, class: 'DRUID', status: 'raider', isMe, raids: { window: 4, all: 6 }, items: { MS: { window: 1, all: 2 }, OS: { window: 0, all: 0 } },
    counted: { window: 1, all: 2 }, perRaid: { window: perRaid, all: perRaid }, vsTeam: 0 });
  const LOOT = people => ({ team: { id: 't1', name: 'Main team' }, window: { weeks: 8, switchWeeks: [8, 12], from: '2026-08-18' }, mode: 'perRaid', countTags: ['MS'], scope: 'team', people, teamAverage: { window: 0.4, all: 0.4 } });
  const standHtml = (data, can) => G.pages.lootStandings.standingsHtml({ guildData: gd(can || OFFICER_CAN), state: { status: 'ok', teamId: 't1', data } });

  await check('loot: the viewer row is first in the standings table and the cards with You; the order and window switches are the T1 segment bar', () => {
    const out = standHtml(LOOT([lootPerson('p_a', 'Aimer', false, 0.9), lootPerson('p_m', 'Me', true, 0.1), lootPerson('p_z', 'Zed', false, 0.5)]));
    assert.deepEqual([...out.matchAll(/<tr class="gs-dtable-row( is-you)?[^"]*"[^>]*><td[^>]*>[^<]*<\/td><th scope="row" class="gs-dtable-primary"><a[^>]*>([A-Za-z]+)/g)].map(m => [m[2], !!m[1]]), [['Me', true], ['Zed', false], ['Aimer', false]], 'You first although Me has the lowest per raid; the rest most due first');
    assert(out.includes('<span class="gs-you">You</span>'));
    assert(out.indexOf('class="gs-listbar"') < out.indexOf('data-action="loot-window"') && out.indexOf('data-action="loot-window"') < out.indexOf('<table class="gs-dtable"'));
    assert(!standHtml(LOOT([lootPerson('p_a', 'Aimer', false, 0.9)])).includes('is-you'));
    assert(standHtml(LOOT([])).includes('No loot yet'), 'the empty view has no switches over nothing');
  });

  // ═══ one flag count ═══
  await check('flags: the Attendance tab, the Attendance page\'s Review queue link and the Review queue\'s header are one number; loading the queue sets the badge from the list', async () => {
    const g = gd(OFFICER_CAN, { attendanceFlags: { t1: 5 } });
    const sidebar = G.shell.slots(shellCtx(OFFICER_CAN, { guildData: g, route: { name: 'section', gid: 'g1', section: 'raids' } }));
    assert(sidebar.sidebar.includes('aria-label="Attendance, 5 flags to review"') && sidebar.tabs.includes('aria-label="Attendance, 5 flags to review"'));
    const att = G.pages.attendance.attendanceHtml({ guildData: g, teamId: 't1', data: ATT(), view: { sort: G.pages.attendance.DEFAULT_SORT, includeInactive: false } });
    assert(att.includes('Review queue (5)') && att.includes('5 flags to review'));
    // The queue lists 3 flags on 2 raids: opening it makes the badge say 3.
    const item = n => ({ playerId: 'p' + n, name: 'N' + n, class: 'DRUID', status: 'raider', flags: ['no_show'], row: { outcome: 'missed' } });
    const review = { team: { id: 't1', name: 'Main team' }, raids: [{ raid: { id: 'r1', raidOn: '2026-10-02', zone: 'BT', openFlags: 2 }, items: [item(1), item(2)] }, { raid: { id: 'r2', raidOn: '2026-10-09', zone: 'BT', openFlags: 1 }, items: [item(3)] }], stale: [], lootUnmatched: [] };
    S.guilds = { g1: g }; S.currentGid = 'g1'; S.teamByGuild = { g1: 't1' };
    const api = stub((m, url) => (/\/claims/.test(url) ? { claims: [] } : review));
    try {
      await G.pages.review.load({ name: 'review', gid: 'g1' }, g);
    } finally { api.restore(); }
    assert.equal(g.attendanceFlags.t1, 3, 'the badge takes the list\'s number');
    assert.equal(G.shell.attendanceBadge(g, 't1'), 3);
    const page = G.pages.review.reviewHtml({ guildData: g, teamId: 't1', data: review, filter: 'all', claims: [], lootGroups: [] });
    assert(page.includes('3 open flags on 2 raids'), 'the header says what the tab says');
    assert(page.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Review queue</h1>') && page.includes('gs-list-page'), 'a T1 list page');
    assert(G.shell.slots(shellCtx(OFFICER_CAN, { guildData: g })).tabs.includes('Attendance, 3 flags to review'));
  });

  // ═══ 6. Raids ═══
  const UP = (id, over) => Object.assign({ id, raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), timeKnown: true, upcoming: true, zone: 'Black Temple', size: 25, title: null, eventSourced: true, eventId: 'e1', otherServer: false,
    eventSyncedAt: Date.now() - 12 * 60000, signups: { signed: 21, late: 2, bench: 2, tentative: 0, absence: 1 }, planned: true, signupsOpen: true }, over || {});
  const PAST = (id, over) => Object.assign({ id, raidOn: '2026-10-10', zone: 'Gruul', size: 25, bosses: { kills: 2, pulls: 3 }, sources: { event: true, reports: 2, plan: true }, counts: { present: 20, bench: 2, missed: 3 }, openFlags: 2, state: 'to_review', stale: false }, over || {});
  const raidsHtml = (can, over) => G.pages.raids.raidsHtml(Object.assign({ guildData: gd(can), teamId: 't1', data: { team: 't1', today: '2026-10-17', raids: [PAST('r1'), PAST('r2', { raidOn: '2026-10-03', state: 'reviewed', openFlags: 0 })], upcoming: [UP('u1'), UP('u2', { raidOn: '2026-10-31', eventSourced: false, eventId: null, planned: false })], can: { signup: can === MEMBER_CAN, edit: can === OFFICER_CAN } } }, over || {}));

  await check('raids list: a member sees no Plan column, no row actions and no Sources or review chips; an officer sees all of them (F5)', () => {
    const member = raidsHtml(MEMBER_CAN);
    const officer = raidsHtml(OFFICER_CAN);
    for (const text of ['>Plan<', 'Planned', 'Not planned', 'raids-plan', 'raids-refresh', 'Plan in Planner']) assert(!member.includes(text), 'member: ' + text);
    for (const text of ['>Plan<', 'Not planned', 'raids-plan', 'raids-refresh']) assert(officer.includes(text), 'officer: ' + text);
    assert(member.includes('Your sign-up') && !officer.includes('Your sign-up'), 'the member\'s column is theirs');
    const pastMember = raidsHtml(MEMBER_CAN, { tab: 'past' });
    const pastOfficer = raidsHtml(OFFICER_CAN, { tab: 'past' });
    for (const text of ['>Sources<', 'Log x2', '2 to review']) { assert(!pastMember.includes(text), 'member past: ' + text); assert(pastOfficer.includes(text), 'officer past: ' + text); }
    assert(pastMember.includes('>Reviewed<') && pastMember.includes('Oct 3'), 'a member still sees Reviewed');
    assert(raidsHtml(MEMBER_CAN).includes('Sign-ups refreshed'), 'the freshness of the sign-ups is for everyone');
  });

  await check('raids list: the row is one tap target on a phone (the date link covers the card), one secondary action plus a More icon named for the row; the page head has New raid as the one primary', () => {
    const out = raidsHtml(OFFICER_CAN);
    assert(out.includes('<table class="gs-dtable" aria-label="Upcoming raids">') && out.includes('<a class="gs-raid-link" href="#/g/g1/raids/r/u1">'));
    assert(out.includes('aria-label="More actions for Sat Oct 24 raid"') && count(out, /Plan in Planner/g) === 2);
    assert(count(out, /gs-btn-molten/g) === 1 && out.includes('<span>New raid</span>'), 'one primary');
    assert(/\.gs-dtable th\[scope="row"\] a::after \{ content: ""; position: absolute; inset: 0; \}/.test(css), 'the stretched link of the data table');
    assert(/\.gs-dtable td button, \.gs-dtable td a, \.gs-dtable td \.gs-menu-wrap \{ position: relative; z-index: 1; \}/.test(css), 'row buttons stay above it');
    assert(/\.gs-loot-card a\.gs-char-link::after \{ content: ""; position: absolute; inset: 0; \}/.test(css), 'and the Loot card');
    assert(/Upcoming <span class="gs-seg-count">2<\/span>/.test(out) && out.includes('Main team'.slice(0, 0)) && out.includes('2 upcoming, 2 past'));
  });

  await check('"Can\'t come": the Raids list, the sign-up chips and the policy sentences say it; "Absence" is gone from the screens', () => {
    assert.equal(G.pages.attendance.KIND_LABELS.absence, 'Can\'t come');
    const out = raidsHtml(MEMBER_CAN, { data: { team: 't1', raids: [], upcoming: [UP('u1', { mine: { kind: 'absence', source: 'raidsmith', characterName: 'Eliora' } })], can: { signup: true } } });
    assert(out.includes('Can&#39;t come - Eliora') && !out.includes('Absence'), stripTags(out).slice(0, 300));
    assert(G.pages.raids.signupsText({ signed: 3, late: 0, bench: 0, tentative: 0, absence: 2 }) === '3 signed, 2 can\'t come');
    const lines = G.pages.attendance.describePolicy ? G.pages.attendance.describePolicy({ absence: 'excused' }) : null;
    if (lines) assert(lines.some(l => l.includes('A Can\'t come sign-up is left out of the percentage.')) && !lines.some(l => l.includes('Absence')));
  });

  // ═══ 6. Roster ═══
  const rp = (id, name, signIn, isMe, over) => Object.assign({ id, status: 'raider', joinedOn: '2026-06-14', trialStart: null, trialEnd: null, trialFlag: null, version: 1, altCount: 0, signIn, isMe: !!isMe,
    shown: { id: 'c' + id, name, class: 'DRUID', mainSpec: 'Feral', offSpec: null, role: 'dps', isMain: true }, main: { id: 'c' + id, name, class: 'DRUID', team: { id: 't1', name: 'Main team' } }, names: [name] }, over || {});
  const ROSTER = people => ({ team: { id: 't1', name: 'Main team', archived: false }, today: '2026-10-18', can: { edit: true, addCharacter: true }, people });
  const rosterHtml = (people, can, over) => G.pages.roster.rosterHtml(Object.assign({ guildData: gd(can || OFFICER_CAN), data: ROSTER(people), view: { sort: G.rosterSort.DEFAULT_SORT, role: 'all', status: 'active', query: '' } }, over || {}));

  await check('roster: no Sign-in column and no "Not signed in" anywhere (Roster redesign, lane U1); the viewer is first in their role column with the grey You chip', () => {
    const melee = { raidRole: 'melee' };
    const people = [rp('p1', 'Aimer', 'signed_in', false, melee), rp('p2', 'Brew', 'no_discord', false, melee), rp('p3', 'Cass', 'not_yet', false, melee), rp('p4', 'Dun', 'no_discord', false, melee), rp('p5', 'Eve', 'not_yet', true, melee)];
    const out = rosterHtml(people);
    assert(!/Sign-in|Not signed in|No Discord|Not yet/.test(stripTags(out)), 'the sign-in words are gone');
    const desk = out.slice(0, out.indexOf('class="gs-rs-phone"'));
    const names = [...desk.matchAll(/<span class="gs-rs-name [^"]*">([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(names, ['Eve', 'Aimer', 'Brew', 'Cass', 'Dun'], 'the viewer row is first');
    assert(desk.includes('class="gs-rs-row is-you"') && desk.includes('data-you="true"') && desk.includes('<span class="gs-hd-chip is-grey">You</span>'));
    assert.equal(G.ui.signInLabel('no_discord'), 'Not signed in');
    assert.equal(G.ui.signInLabel('not_yet'), 'Not signed in');
  });

  await check('roster: the page head carries Add person as the one primary and the imports in the one More menu; the tab strip follows the glossary on every Roster page', () => {
    const out = rosterHtml([rp('p1', 'Aimer', 'signed_in')]);
    assert(out.includes('<header class="gs-pagehead">') && out.includes('<span>Add person</span>') && count(out, /gs-btn-molten/g) === 1 && out.includes('id="roster-more"'));
    for (const label of ['Import from a Raid-Helper event', 'Import from a Warcraft Logs report', 'Import from the Battle.net guild roster', 'Import from a CSV file']) assert(out.includes(label), label);
    const tabs = plain(G.pages.rosterTabs.tabsFor(gd(OFFICER_CAN)).map(t => t.label));
    assert.deepEqual(tabs, ['Roster', 'Spec poll', 'Recruiting']);
    const head = G.pages.rosterTabs.headHtml(gd(OFFICER_CAN), 'intent', 'Main team');
    assert(head.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1>') && head.includes('Main team - Spec poll') && head.includes('aria-current="page">Spec poll'));
    assert(!/\bIntent\b/.test(stripTags(head)) && !stripTags(rosterHtml([])).includes('Recruiting<'));
    assert(!rosterHtml([rp('p1', 'Aimer', 'signed_in')], MEMBER_CAN, { data: Object.assign(ROSTER([rp('p1', 'Aimer', 'signed_in')]), { can: { edit: false } }) }).includes('roster-more'), 'a member has no menu and no primary');
  });

  // ═══ member Home: the member's own team ═══
  await check('member Home: the team of the member\'s Main, else their first team, else the shell\'s selected team', async () => {
    const T = [TEAM('t1', 'Main team'), TEAM('t2', 'Weekend team'), TEAM('t3', 'Alt team')];
    const own = me => G.pages.homeMember.ownTeamOf(gd(MEMBER_CAN, { teams: T, me }));
    S.teamByGuild = { g1: 't1' }; S.guilds = {}; S.currentGid = 'g1';
    assert.equal(own({ personId: 'p', mainTeamId: 't2', teamIds: ['t2', 't3'] }), 't2', 'the Main\'s team, not the shell\'s t1');
    assert.equal(own({ personId: 'p', mainTeamId: null, teamIds: ['t3', 't2'] }), 't2', 'else the first of their teams in the guild\'s order');
    assert.equal(own({ personId: 'p', mainTeamId: 't9', teamIds: ['t3'] }), 't3', 'a Main on a team that is not active is skipped');
    assert.equal(own({ personId: null }), 't1', 'on no team: the shell\'s selected team keeps the page from being empty');
    const g = gd(MEMBER_CAN, { teams: T, me: { personId: 'p', mainTeamId: 't2', teamIds: ['t2'] } });
    S.guilds = { g1: g };
    const api = stub((m, url) => (/\/raids\?team=/.test(url) ? { upcoming: [], raids: [] } : {}));
    try {
      await G.pages.homeMember.load({ name: 'section', gid: 'g1', section: 'home' }, g);
      await settle();
    } finally { api.restore(); }
    assert(api.calls.some(c => c.url.endsWith('/raids?team=t2')) && !api.calls.some(c => c.url.endsWith('/raids?team=t1')), api.calls.map(c => c.url).join(' '));
    assert.equal(G.pages.attendance.attState().homeMember.teamId, 't2');
  });

  // ═══ 7. Imports on T5 ═══
  const stepsOf = html => [...html.matchAll(/<li class="gs-step is-(done|current|later)"[^>]*>.*?<span class="gs-step-name">([^<]*)<\/span>/g)].map(m => m[1] + ':' + m[2]);
  const rhPreview = () => ({ event: { id: 'e1', title: 'Gruul', startTime: Date.UTC(2026, 9, 21, 0), otherServer: false }, rows: [
    { signupId: 101, kind: 'new', ticked: true, main: { name: 'Thornvald', class: 'WARRIOR', spec: 'Arms', taken: false }, alts: [], nickname: 'Thornvald' },
    { signupId: 102, kind: 'new', ticked: true, main: { name: 'Kaelith', class: 'ROGUE', spec: 'Combat', taken: false }, alts: [], nickname: 'Kaelith' }] });
  const wclPreview = () => ({ report: { code: 'aBcD1234eFgH5678', flavour: 'fresh', title: 'Hyjal', zone: 'Hyjal', startTime: Date.UTC(2026, 9, 14, 19) }, matched: [{ name: 'Brightmane', class: 'PALADIN', person: { id: 'p_2', name: 'Brightmane' } }],
    toDecide: [{ key: 'thornpaw|', name: 'Thornpaw', realm: null, class: 'HUNTER', otherRealm: false, suggestion: null }] });
  const csvPreview = () => ({ totals: { rows: 1, people: 1, alts: 0, taken: 0, problems: 0 }, rows: [{ line: 2, name: 'Newwarr', class: 'WARRIOR', spec: 'Arms', realm: null, teamId: 't1', teamName: 'Main team', status: 'trial', problems: [], taken: null, action: 'new', needsDecision: false, notes: [] }] });
  const bnetPreview = () => ({ guild: { name: 'Ravens', realm: 'Firemaw' }, team: { id: 't1', name: 'Main' }, fetchedAt: 1, rankLabels: [], ranks: [{ rank: 0, label: 'GM', count: 1 }], rows: [{ key: 'thornwick|firemaw', name: 'Thornwick', realmSlug: 'firemaw', realm: 'Firemaw', class: 'DRUID', level: 70, rank: 0, status: 'new' }] });

  const pages = [
    ['Raid-Helper', 'rh-footer', 'raid-helper', 'Import from Raid-Helper', 'rh-back', 'rh-commit', 'rh-result-banner', (step) => {
      const st = G.pages.import.ensureState('rh', 'g1', 't1');
      Object.assign(st, { link: '', result: null, preview: null, status: 'idle', error: '' });
      if (step !== 'source') { st.preview = rhPreview(); st.rows = G.pages.import.rhInitRows(st.preview); }
      if (step === 'result') { st.preview = null; st.result = { title: 'Added 2 people.', text: '' }; }
      return G.pages.import.raidHelperHtml({ guildData: gd(OFFICER_CAN), rh: st });
    }],
    ['Warcraft Logs', 'wcl-footer', 'wcl', 'Import from Warcraft Logs', 'wcl-back', 'wcl-commit', 'wcl-result-banner', (step) => {
      const st = G.pages.import.ensureState('wcl', 'g1', 't1');
      Object.assign(st, { link: '', result: null, preview: null, status: 'idle', error: '' });
      if (step !== 'source') { st.preview = wclPreview(); st.choices = G.pages.import.wclInitChoices(st.preview); st.choices['thornpaw|'] = { action: 'new', personId: '', status: 'trial' }; }
      if (step === 'result') { st.preview = null; st.result = { title: 'Saved 1 change.', text: '' }; }
      return G.pages.import.wclHtml({ guildData: gd(OFFICER_CAN), wcl: st, people: [] });
    }],
    ['CSV', 'csv-footer', 'csv', 'Import from a CSV file', 'csv-back', 'csv-commit', 'csv-result-banner', (step) => {
      const st = G.pages.importCsv.ensureState('g1', 't1');
      Object.assign(st, { text: '', result: null, preview: null, status: 'idle', error: '' });
      if (step !== 'source') { st.preview = csvPreview(); st.choices = G.pages.importCsv.csvInitChoices(st.preview); }
      if (step === 'result') { st.preview = null; st.result = { title: 'Added 1 person.', text: '' }; }
      return G.pages.importCsv.csvHtml({ guildData: gd(OFFICER_CAN), csv: st, people: [] });
    }],
    ['Battle.net', 'bnet-footer', 'bnet', 'Import from Battle.net', 'bnet-back', 'bnet-commit', 'bnet-result-banner', (step) => {
      const st = G.pages.importBnet.ensureState('g1', 't1');
      Object.assign(st, { info: { configured: true, supported: true, realmNeeded: false, effectiveGuildName: 'Ravens', realmKind: 'realm', realmSlug: 'firemaw', canEdit: true }, result: null, preview: null, status: 'idle', error: '' });
      if (step !== 'source') { st.preview = bnetPreview(); st.view = G.pages.importBnet.newView(st.preview); st.ticked = { 'thornwick|firemaw': true }; }
      if (step === 'result') { st.preview = null; st.result = { title: 'Added 1 person.', text: '' }; }
      return G.pages.importBnet.bnetHtml({ guildData: gd(OFFICER_CAN), bnet: st });
    }],
  ];

  for (const [name, footerId, source, title, backAction, commitAction, bannerId, render] of pages) {
    await check(`T5: the ${name} import is the shared flow - Source (switch between the four sources), Preview (commit bar: Back, Cancel, the Primary, nothing saved yet), Import (inline banner, next step)`, () => {
      const src = render('source');
      assert(src.includes('<div class="gs-page gs-flow-page gs-import-page') && src.includes(`>${title}</h1>`) && src.includes('<a class="gs-back-link" href="#/g/g1/roster">'), 'flow page with a Back to the roster');
      assert.deepEqual(stepsOf(src), ['current:Source', 'later:Preview', 'later:Import']);
      assert(src.includes('class="gs-import-sources"') && src.includes(`href="#/g/g1/roster/import/${source}" aria-current="page"`) && count(src, /<a class="gs-seg gs-seg-link"/g) === 4, 'where is your roster: four links, this one current');
      assert(!src.includes(footerId) && !src.includes('gs-commitbar'), 'no commit bar on the Source step');
      assert(src.includes('Nothing is saved until you press the button on the next step.') || name === 'Battle.net', 'the source step says nothing is saved yet');
      const prev = render('preview');
      assert.deepEqual(stepsOf(prev), ['done:Source', 'current:Preview', 'later:Import']);
      assert(prev.includes(`id="${footerId}"`) && prev.includes('class="gs-commitbar"') && prev.includes('Nothing is saved yet.'), 'the commit bar');
      assert(prev.includes(`data-action="${backAction}"`) && prev.includes(`data-action="${commitAction}"`) && prev.includes('>Cancel<') && prev.includes('href="#/g/g1/roster"'), 'Back keeps the input, Cancel leaves, the Primary commits');
      assert(!prev.includes('class="gs-import-sources"'), 'the source switch is for the Source step only');
      assert(count(prev, /gs-btn-molten/g) === 1, 'one primary on the Preview step');
      const done = render('result');
      assert.deepEqual(stepsOf(done), ['done:Source', 'done:Preview', 'done:Import']);
      assert(done.includes(`id="${bannerId}"`) && done.includes('gs-banner-success') && done.includes('Open roster') && done.includes('Import another'), 'inline success banner with the next step');
      assert(!done.includes('gs-commitbar') && !done.includes('toast'), 'no commit bar, no toast');
    });
  }

  await check('T5: the Gargul, TMB and softres panels and the pasted-roster dialog use the same stepper, the same Preview word and the same commit bar sentence', () => {
    for (const file of ['js/guild/pages-raid-loot.js', 'js/guild/pages-raid-board.js']) {
      const src = read(file);
      assert(src.includes('G.ui.importPanelHtml(') && src.includes('G.ui.importResultHtml(') && !src.includes('class="gs-loot-import"'), file + ' builds its panel with the shared helper');
    }
    const panel = G.ui.importPanelHtml({ id: 'x-title', title: 'Import', step: 'preview', previewHtml: '<p>read</p>', commit: { text: '3 rows will be saved.', commit: { label: 'Save 3 rows' } } });
    assert(panel.includes('role="group" aria-labelledby="x-title"') && panel.includes('<h3 class="gs-h3" id="x-title">Import</h3>') && panel.includes('class="gs-commitbar is-inline"') && panel.includes('3 rows will be saved.') && panel.includes('Nothing is saved yet.'));
    assert.deepEqual(stepsOf(panel), ['done:Source', 'current:Preview', 'later:Import']);
    assert(!G.ui.importPanelHtml({ title: 'x', step: 'source' }).includes('gs-commitbar'), 'no commit bar before the preview');
    assert(G.ui.importPanelHtml({ title: 'x', step: 'result', resultHtml: '<b>done</b>' }).includes('<b>done</b>'));
    const dialog = G.pages.raidExtras.pasteDialogHtml({ raid: { state: 'awaiting_log' }, sources: { reports: [] } });
    assert.deepEqual(stepsOf(dialog), ['current:Source', 'later:Preview', 'later:Import']);
    assert(dialog.includes('Check names') && /id="pr-steps"/.test(dialog));
    assert(/gs-commit-line/.test(read('js/guild/pages-raid-extras.js')) && /\.gs-commit-line \{/.test(css), 'the preview opens with "N will be marked attended. Nothing is saved yet."');
    assert(G.pages.raidExtras.previewHtml({ matched: [{ name: 'A' }, { name: 'B' }], unmatched: [], guests: [], ignoredCount: 0 }).includes('2 people will be marked attended.'));
  });

  await check('T5: the commit bar and the result are the shared helpers; the result is an inline banner, never a toast, and Back keeps what was typed', () => {
    const bar = G.ui.commitBarHtml({ id: 'b', text: '23 of 24 will be imported.', back: { attrs: { 'data-action': 'x-back' } }, cancel: { href: '#/g/g1/roster' }, commit: { label: 'Import 23 people', attrs: { 'data-action': 'x-go' } } });
    assert(bar.includes('id="b"') && bar.includes('<strong>23 of 24 will be imported.</strong>') && bar.includes('Nothing is saved yet.') && bar.includes('>Back<') && bar.includes('>Cancel<') && bar.includes('>Import 23 people<'));
    const banner = G.ui.importResultHtml({ title: 'Imported 23 people. 1 skipped.', text: '20 new, 3 updated.', next: [{ label: 'Open roster', href: '#' }, { label: 'Import another' }] });
    assert(banner.includes('gs-banner-success') && banner.includes('role="status"') && banner.includes('Imported 23 people. 1 skipped.') && !banner.includes('banner-dismiss'));
    for (const file of ['js/guild/pages-import.js', 'js/guild/pages-import-csv.js', 'js/guild/pages-import-bnet.js']) {
      const src = read(file);
      assert(!src.includes('rosterNotice') && !/G\.app\.go\(rosterHref/.test(src), file + ' no longer sends the officer to the roster with a notice');
      assert(!src.includes('gs-import-bar'), file + ' draws no bar of its own');
    }
  });

  await check('T5: Back returns to the Source step with the input kept (Raid-Helper link, CSV text, Battle.net settings); Import another starts clean', () => {
    S.currentGid = 'g1'; S.guilds = { g1: gd(OFFICER_CAN) };
    const rh = G.pages.import.ensureState('rh', 'g1', 't1');
    Object.assign(rh, { link: 'https://raid-helper.dev/event/9', preview: rhPreview(), result: null });
    G.handlers.click['rh-back']();
    assert.equal(rh.preview, null);
    assert.equal(rh.link, 'https://raid-helper.dev/event/9');
    const csv = G.pages.importCsv.ensureState('g1', 't1');
    Object.assign(csv, { text: 'name,class\nA,Mage', preview: csvPreview(), choices: {} });
    G.handlers.click['csv-back']();
    assert.equal(csv.preview, null);
    assert.equal(csv.text, 'name,class\nA,Mage');
    const bnet = G.pages.importBnet.ensureState('g1', 't1');
    Object.assign(bnet, { info: { configured: true }, result: { title: 'done', text: '' }, preview: null });
    G.handlers.click['bnet-again']();
    assert.equal(G.app.state.imports.bnet.result, null);
    assert.deepEqual(plain(G.app.state.imports.bnet.info), { configured: true }, 'the guild\'s Battle.net settings are not read again');
  });

  // ═══ 8. New raid, Link event, dialogs ═══
  await check('New raid: the Raid-Helper event is the first thing asked, before the date and the attendance source; the head has a Back to Raids', () => {
    const state = { gid: 'g1', form: { teamId: 't1', event: '', reports: [''], plan: '', mode: 'log', date: '' }, run: null, error: '' };
    const out = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN, { teams: [TEAM('t1', 'Main team'), TEAM('t2', 'Weekend team')] }), state });
    const at = id => out.indexOf('id="' + id + '"');
    assert(at('nr-team') < at('nr-event') && at('nr-event') < at('nr-date') && at('nr-event') < at('nr-source') && at('nr-source') < at('nr-reports') && at('nr-reports') < at('nr-plan'), 'team, Raid-Helper event, date, attendance source, reports, plan');
    assert(out.includes('<a class="gs-back-link" href="#/g/g1/raids">') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">New raid</h1>'));
    assert(count(out, /gs-btn-molten/g) === 1, 'one primary: Create raid');
  });

  await check('dialogs never stack anywhere: only ui.openDialog makes a dialog, every opener goes through it, and the Link-event / Move flow replaces', () => {
    const files = fs.readdirSync(path.join(ROOT, 'js/guild')).filter(f => f.endsWith('.js'));
    const modal = files.filter(f => /showModal\(/.test(read('js/guild/' + f)));
    assert.deepEqual(modal.sort(), ['app.js', 'ui.js'], 'showModal: the dialog helper and the phone drawer, nothing else (' + modal.join(', ') + ')');
    const makers = files.filter(f => /createElement\('dialog'\)/.test(read('js/guild/' + f)));
    assert.deepEqual(makers, ['ui.js'], 'one place builds a dialog');
    const openers = files.filter(f => f !== 'ui.js' && /\.openDialog\(/.test(read('js/guild/' + f)));
    assert(openers.length >= 20, 'the page code opens its dialogs through it: ' + openers.length);
    const ui = read('js/guild/ui.js');
    assert(/Dialogs never stack: opening one while another is open REPLACES it/.test(ui) && /prior\.replaced = true;/.test(ui));
    // The flows that open a dialog from inside a dialog: Link event -> Move, role dialog -> delete role, join dialog -> created link, manual attendance -> remove.
    assert(/function confirmMove[\s\S]*?G\.ui\.openDialog\(moveDialogHtml\(err\)/.test(read('js/guild/pages-raids.js')));
    assert(/G\.ui\.openDialog\(deleteDialogHtml\(role\), \{[^}]*returnKey: inDialog/.test(read('js/guild/pages-settings-roles.js')), 'the delete-role confirm keeps the focus return of the role dialog');
    assert(/Not linked\. The event is on another day than the raid, and the raid was not moved\./.test(read('js/guild/pages-raid.js')), 'Cancel on the Move question says Not linked');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
