/**
 * Raidsmith guild UI, Phase 3 (attendance) - tests for the Raids, Raid, Review, Attendance, Person attendance,
 * Settings > Attendance and Backfill pages, the plan reader and the Raids rename.
 * Run: node tests/guild/guild-attendance-ui-tests.js
 *
 * Same approach as guild-roster-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render
 * functions return HTML strings. Mock API data follows the Phase 3 spec's API contract (tasks/reference/guild-phase3-spec.md).
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
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, '');

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
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild',
  'attendance.policy': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild',
};
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'] };
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [T1, T2].map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [{ role: 'officer' }], can },
    attendanceFlags: {},
  }, over || {});
}
const ME = { user: { id: 'u1', username: 'me', displayName: 'Me' }, guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false } };

function cell(raidId, date, weekStart, outcome, extra) {
  return Object.assign({ raidId, date, weekStart, outcome, letter: G.pages.attendance.LETTERS[outcome], credit: outcome === 'missed' ? 0 : 1, via: null, pending: false, preStart: false }, extra || {});
}
function teamData(over) {
  const raids = [
    { weekStart: '2026-10-06', raids: [{ id: 'r3', raidOn: '2026-10-09', zone: 'BT' }, { id: 'r4', raidOn: '2026-10-10', zone: 'BT' }] },
    { weekStart: '2026-09-29', raids: [{ id: 'r1', raidOn: '2026-10-02', zone: 'BT' }, { id: 'r2', raidOn: '2026-10-03', zone: 'BT' }] },
  ];
  const person = (id, name, cls, status, m, cells, extra) => Object.assign({ id, name, class: cls, status, isMe: false, pct: m, pctAll: m, signupRate: 100, streak: 0, streakFlag: false, lastAttended: '2026-10-10', counted: 4, pending: 0, cells }, extra || {});
  return Object.assign({
    team: 't1', today: '2026-10-12', window: 8, policy: { switchWeeks: [8, 12], streakFlagAt: 4, creditValues: [] },
    weeks: raids, awaitingReview: 2, staleRaids: 0,
    people: [
      person('p_zz', 'Zzaps', 'DRUID', 'raider', 88.9, [cell('r1', '2026-10-02', '2026-09-29', 'present'), cell('r2', '2026-10-03', '2026-09-29', 'present'), cell('r3', '2026-10-09', '2026-10-06', 'late', { pending: true, credit: null, letter: 'L?' }), cell('r4', '2026-10-10', '2026-10-06', 'missed')], { streak: 4, streakFlag: true }),
      person('p_aa', 'Aimersmay', 'HUNTER', 'raider', 100, [cell('r1', '2026-10-02', '2026-09-29', 'present'), cell('r2', '2026-10-03', '2026-09-29', 'bench'), cell('x9', '2026-10-07', '2026-10-06', 'fill_in', { via: 'Weekend team' })], { lastAttended: null, signupRate: null }),
      person('p_old', 'Oldtimer', 'WARRIOR', 'inactive', 50, [cell('r1', '2026-10-02', '2026-09-29', 'present', { preStart: true, letter: '' })]),
    ],
  }, over || {});
}

// ── router and nav (the Raids rename) ────────────────────────────
(async () => {
  await check('router: every attendance route parses and formats back; bad ids and extra parts are notfound', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/raids'), { name: 'section', gid: 'g1', section: 'raids' });
    assert.deepEqual(p('#/g/g1/raids/new'), { name: 'raidnew', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/raids/r/r_1'), { name: 'raid', gid: 'g1', rid: 'r_1' });
    assert.deepEqual(p('#/g/g1/attendance'), { name: 'section', gid: 'g1', section: 'attendance' });
    assert.deepEqual(p('#/g/g1/attendance/review'), { name: 'review', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/attendance/backfill'), { name: 'backfill', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/attendance/p/p_1'), { name: 'personatt', gid: 'g1', pid: 'p_1' });
    assert.deepEqual(p('#/g/g1/settings/attendance'), { name: 'settings', gid: 'g1', tab: 'attendance' });
    for (const bad of ['#/g/g1/nights', '#/g/g1/raids/r', '#/g/g1/raids/r/a/b', '#/g/g1/raids/r/<x>', '#/g/g1/raids/new/extra', '#/g/g1/attendance/review/x', '#/g/g1/attendance/p', '#/g/g1/attendance/p/a/b', '#/g/g1/attendance/other']) {
      assert.equal(p(bad).name, 'notfound', bad);
    }
    for (const r of [{ name: 'raidnew', gid: 'g1' }, { name: 'raid', gid: 'g1', rid: 'r_1' }, { name: 'review', gid: 'g1' }, { name: 'backfill', gid: 'g1' }, { name: 'personatt', gid: 'g1', pid: 'p_1' }, { name: 'settings', gid: 'g1', tab: 'attendance' }]) {
      assert.deepEqual(p(G.router.format(r)), r);
    }
  });

  await check('rename: nav says Raids (short Raids), no "Raid nights" anywhere in the guild scripts and pages', () => {
    const items = G.shell.navItems('g1', {}, 0, '');
    const raids = items.find(i => i.key === 'raids');
    assert.equal(raids.label, 'Raids');
    assert.equal(raids.short, 'Raids');
    assert.equal(raids.href, '#/g/g1/raids');
    assert(!items.some(i => i.key === 'nights'));
    // The Loot pages (hub, raid night page, rules) are the one place a raid night is named: that is the Loot redesign's own wording.
    const lootWording = /loot/;
    for (const f of GUILD_SCRIPTS.filter(s => s.startsWith('/js/guild/') && !lootWording.test(s))) assert(!/raid nights?/i.test(read(f.slice(1))), f);
  });

  await check('nav: Attendance carries the open-flag count with an aria-label, on the sidebar and the phone tab; members never see it', () => {
    const officer = gd(OFFICER_CAN, { attendanceFlags: { t1: 3, t2: 0 } });
    const c = { section: 'guild', page: 'app', me: ME, route: { name: 'section', gid: 'g1', section: 'raids' }, guildData: officer, teamId: 't1' };
    const s = G.shell.slots(c);
    // The unit is open FLAGS (the number the Review queue's header and the Attendance page's Review queue link show), not raids.
    assert(s.sidebar.includes('aria-label="Attendance, 3 flags to review"') && s.sidebar.includes('<span class="gs-nav-badge" aria-hidden="true">3</span>'));
    assert(s.tabs.includes('aria-label="Attendance, 3 flags to review"'));
    const one = G.shell.slots(Object.assign({}, c, { guildData: gd(OFFICER_CAN, { attendanceFlags: { t1: 1 } }) }));
    assert(one.sidebar.includes('Attendance, 1 flag to review'));
    assert(!G.shell.slots(Object.assign({}, c, { teamId: 't2' })).sidebar.includes('to review'), 'selected team only');
    const member = G.shell.slots(Object.assign({}, c, { guildData: gd(MEMBER_CAN, { attendanceFlags: { t1: 5 } }) }));
    assert(!member.sidebar.includes('gs-nav-badge') && !member.tabs.includes('gs-nav-badge'));
  });

  await check('nav: the raid and attendance sub-pages keep their section active; breadcrumbs name the leaf', () => {
    const c = r => ({ section: 'guild', page: 'app', me: ME, route: r, guildData: gd(OFFICER_CAN), teamId: 't1' });
    const current = r => [...G.shell.slots(c(r)).sidebar.matchAll(/aria-label="([^"]*)" aria-current="page"/g)].map(m => m[1]);
    assert.deepEqual(current({ name: 'raid', gid: 'g1', rid: 'r1' }), ['Raids']);
    assert.deepEqual(current({ name: 'raidnew', gid: 'g1' }), ['Raids']);
    assert.deepEqual(current({ name: 'review', gid: 'g1' }), ['Attendance']);
    assert.deepEqual(current({ name: 'backfill', gid: 'g1' }), ['Attendance']);
    assert.deepEqual(current({ name: 'personatt', gid: 'g1', pid: 'p_1' }), ['Attendance']);
    const crumbs = (route, extra) => plain(G.shell.breadcrumbItems(Object.assign(c(route), extra || {})).map(x => x.label));
    assert.deepEqual(crumbs({ name: 'raid', gid: 'g1', rid: 'r1' }, { leafName: 'Sat Oct 10' }), ['Ravens', 'Team KJ', 'Raids', 'Sat Oct 10']);
    assert.deepEqual(crumbs({ name: 'raidnew', gid: 'g1' }), ['Ravens', 'Team KJ', 'Raids', 'New raid']);
    assert.deepEqual(crumbs({ name: 'review', gid: 'g1' }), ['Ravens', 'Team KJ', 'Attendance', 'Review queue']);
    assert.deepEqual(crumbs({ name: 'section', gid: 'g1', section: 'raids' }), ['Ravens', 'Team KJ', 'Raids']);
    assert.deepEqual(crumbs({ name: 'settings', gid: 'g1', tab: 'attendance' }), ['Ravens', 'Guild settings', 'Attendance']);
  });

  await check('settings tabs: Attendance appears only with attendance.policy', () => {
    assert(G.shell.settingsTabs(OFFICER_CAN).some(t => t.tab === 'attendance'));
    assert(!G.shell.settingsTabs({ 'guild.teams': 'guild' }).some(t => t.tab === 'attendance'));
    assert(G.shell.canSeeSettings({ 'attendance.policy': 'guild' }));
    assert.equal(G.shell.allowsTeam({ 'attendance.view': ['t1'] }, 'attendance.view', 't1'), true);
    assert.equal(G.shell.allowsTeam({ 'attendance.view': ['t1'] }, 'attendance.view', 't2'), false);
    assert.equal(G.shell.allowsTeam({ 'attendance.view': 'guild' }, 'attendance.view', 't2'), true);
  });

  // ── plan reader ────────────────────────────────────────────────
  const fakeDeps = (over) => Object.assign({
    decode: code => (code === 'GOODCODE1' ? 'PP:2:x' : null),
    readPlayers: s => (s === 'PP:2:x' ? { success: true, name: 'BT run', players: [{ name: 'Tank', groupNumber: 1 }, { name: 'Benchy', groupNumber: 0 }] } : { success: false, error: 'Share link is damaged' }),
  }, over || {});

  await check('plan source: long link, bare code and PP:2 string give names + groups only', async () => {
    const want = { ok: true, label: 'BT run', players: [{ name: 'Tank', group: 1 }, { name: 'Benchy', group: 0 }], skipped: 0, skippedText: '' };
    assert.deepEqual(plain(await G.planSource.read('https://raidsmith.example/#r=GOODCODE1', fakeDeps())), want);
    assert.deepEqual(plain(await G.planSource.read('  GOODCODE1  ', fakeDeps())), want);
    assert.deepEqual(plain(await G.planSource.read('PP:2:x', fakeDeps())), want);
    for (const text of ['https://raidsmith.example/#r=GOODCODE1', 'GOODCODE1', 'PP:2:x']) assert.equal((await G.planSource.read(text, fakeDeps())).live, undefined, 'only a live link carries a live id');
  });

  await check('plan source: a short live link is fetched, and needs the live site when it cannot be', async () => {
    const asked = [];
    const deps = fakeDeps({ fetchShare: id => { asked.push(id); return Promise.resolve({ code: 'GOODCODE1' }); } });
    const ok = await G.planSource.read('https://raidsmith.example/tbc/AbC1234', deps);
    assert.equal(ok.ok, true);
    assert.equal(ok.live, 'AbC1234', 'the raid keeps the live link id');
    assert.deepEqual(asked, ['AbC1234']);
    const gone = await G.planSource.read('/tbc/AbC1234', fakeDeps({ fetchShare: () => Promise.resolve(null) }));
    assert(!gone.ok && /expired/.test(gone.error));
    const down = await G.planSource.read('/tbc/AbC1234', fakeDeps({ fetchShare: () => Promise.reject(new Error('x')) }));
    assert(!down.ok && /live site/.test(down.error) && /#r=/.test(down.error));
    const none = await G.planSource.read('/tbc/AbC1234', Object.assign(fakeDeps(), { fetchShare: null }));
    assert(!none.ok && /live site/.test(none.error));
  });

  await check('plan source: damaged, empty, unknown and oversized plans come back as readable errors', async () => {
    for (const text of ['', '   ', 'hello world', 'PP:2:bad', '#r=NOTACODE']) {
      const r = await G.planSource.read(text, fakeDeps());
      assert.equal(r.ok, false, text);
      assert(typeof r.error === 'string' && r.error.length > 5, text);
    }
    const big = fakeDeps({ readPlayers: () => ({ success: true, name: 'Big', players: Array.from({ length: 81 }, (_, i) => ({ name: 'Pp' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), groupNumber: 1 })) }) });
    assert(/at most 80/.test((await G.planSource.read('PP:2:x', big)).error));
    const none = fakeDeps({ readPlayers: () => ({ success: true, name: 'Empty', players: [] }) });
    assert(/no players/.test((await G.planSource.read('PP:2:x', none)).error));
    const noImport = await G.planSource.read('PP:2:x', { decode: null, readPlayers: null });
    assert.equal(noImport.ok, false);
  });

  // ── outcome vocabulary, letters and colours ────────────────────
  await check('letters: ten outcomes, one letter each; the legend names them all; cells carry letter + aria-label', () => {
    const P = G.pages.attendance;
    assert.deepEqual(plain(P.LETTERS), { present: 'A', bench: 'B', missed: 'M', missed_notice: 'N', late: 'L', left_early: 'E', late_left: 'LE', fill_in: 'F', tentative: 'T', no_signup: '-' });
    assert.deepEqual(plain(P.OUTCOMES), Object.keys(P.LETTERS));
    assert.equal(P.OUTCOME_LABELS.fill_in, 'Other team');
    const legend = P.legendHtml();
    for (const o of P.OUTCOMES) assert(legend.includes('>' + P.OUTCOME_LABELS[o] + '<'), o);
    assert(legend.includes('Before joining'));
    const c = P.cellHtml(cell('r1', '2026-10-10', '2026-10-06', 'missed_notice'), '2026-10-10');
    assert(c.includes('>N<') && c.includes('aria-label="Sat Oct 10: Missed with notice"') && c.includes('role="img"') && c.includes('gs-out-missed_notice'));
    const pend = P.cellHtml(cell('r1', '2026-10-10', '2026-10-06', 'late', { pending: true, letter: 'L?' }), '2026-10-10');
    assert(pend.includes('>L?<') && !pend.includes('L??') && pend.includes('awaiting review'));
    const pre = P.cellHtml(cell('r1', '2026-10-10', '2026-10-06', 'present', { preStart: true, letter: '' }), '2026-10-10');
    assert(pre.includes('gs-cell-blank') && pre.includes('before joining') && !pre.includes('>P<'));
    assert(P.cellHtml(null, '2026-10-10').includes('no record'));
    assert(P.cellHtml(cell('x', '2026-10-07', '2026-10-06', 'fill_in', { via: 'Weekend team' })).includes('(Weekend team)'));
  });

  // The worker's table is the source of truth; it is not on this lane's branch, so the parity check runs after the merge.
  await check('letters: parity with worker/attendance-policy.js LETTERS (skips when that module is not merged yet)', () => {
    const file = path.join(ROOT, 'worker', 'attendance-policy.js');
    if (!fs.existsSync(file)) { console.log('      (skipped: worker/attendance-policy.js is not on this branch yet; the check runs after the merge)'); return; }
    const policy = require(file);
    assert.deepEqual(plain(G.pages.attendance.LETTERS), plain(policy.LETTERS));
    assert.deepEqual([...G.pages.attendance.OUTCOMES].sort(), [...policy.OUTCOME_IDS].sort());
    for (const id of policy.OUTCOME_IDS) assert.equal(G.pages.attendance.OUTCOME_LABELS[id], policy.OUTCOMES[id].label, id + ' label');
  });

  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(hex) { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

  // D7 (user exception to the design spec, 2026-10-21): tint + edge + letter colour per outcome, the values of the R2-colours board.
  const D7 = {
    present: ['rgba(180, 231, 174, 0.12)', 'rgba(180, 231, 174, 0.4)', '#b4e7ae'], bench: ['rgba(110, 170, 255, 0.15)', 'rgba(110, 170, 255, 0.45)', '#a9cdff'],
    missed: ['rgba(255, 95, 110, 0.22)', 'rgba(255, 95, 110, 0.6)', '#ffb3b9'], missed_notice: ['transparent', 'rgba(235, 70, 85, 0.85)', '#ff7c88'],
    late: ['rgba(240, 208, 70, 0.15)', 'rgba(240, 208, 70, 0.45)', '#f5dd72'], left_early: ['rgba(238, 140, 60, 0.16)', 'rgba(238, 140, 60, 0.5)', '#ef8a3a'],
    late_left: ['rgba(245, 130, 200, 0.16)', 'rgba(245, 130, 200, 0.5)', '#fbbfe3'], fill_in: ['rgba(165, 125, 250, 0.18)', 'rgba(165, 125, 250, 0.5)', '#cbb4ff'],
    tentative: ['rgba(130, 160, 195, 0.14)', 'rgba(130, 160, 195, 0.45)', '#a9bdd2'], no_signup: ['rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0.2)', '#aeb3b0'],
  };

  await check('outcome colours: every outcome has the tint, edge and letter colour of the board; the letter passes 4.5:1 on the panel; pending and blank cells are dashed', () => {
    const token = name => { const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(css); assert(m, 'missing --' + name); return m[1].trim(); };
    assert.deepEqual(Object.keys(D7), plain(G.pages.attendance.OUTCOMES));
    for (const [o, [bg, edge, ink]] of Object.entries(D7)) {
      assert.equal(token('gs-out-' + o), bg, o + ' tint');
      assert.equal(token('gs-out-' + o + '-edge'), edge, o + ' edge');
      assert.equal(token('gs-out-' + o + '-ink'), ink, o + ' letter');
      assert(contrast(ink, '#191b1d') >= 4.5, `${o} contrast ${contrast(ink, '#191b1d').toFixed(2)}`);
      assert(css.includes('.gs-out-' + o + ' { background: var(--gs-out-' + o + '); border-color: var(--gs-out-' + o + '-edge); color: var(--gs-out-' + o + '-ink); }'), o + ' class');
    }
    assert(/\.gs-cell\.is-pending \{ background: transparent; border: 1px dashed var\(--border-field\); color: var\(--hd-white\); \}/.test(css), 'pending: transparent, dashed, white');
    assert(/\.gs-cell-blank \{ background: transparent; border: 1px dashed rgba\(255, 255, 255, 0\.18\); \}/.test(css), 'before joining: dashed');
    assert(!/--gs-out-[a-z_]+-ink:\s*#101213/.test(css), 'the old solid fills are gone');
  });

  // The officer's People and Week grid views are tested in guild-attendance-officer-ui-tests.js.

  // ── raids list ─────────────────────────────────────────────────
  const RAIDS = [
    { id: 'r4', raidOn: '2026-10-10', zone: 'BT / Hyjal', bosses: { kills: 1, pulls: 17 }, sources: { event: true, reports: 2, plan: false }, counts: { present: 24, bench: 1, missed: 3 }, openFlags: 5, state: 'to_review', stale: false },
    { id: 'r3', raidOn: '2026-10-09', zone: null, bosses: { kills: 0, pulls: 0 }, sources: { event: true, reports: 0, plan: true }, counts: null, openFlags: 0, state: 'awaiting_log', stale: false },
    { id: 'r2', raidOn: '2026-10-03', zone: 'BT', bosses: { kills: 2, pulls: 4 }, sources: { event: false, reports: 1, plan: false }, counts: { present: 20, bench: 0, missed: 0 }, openFlags: 0, state: 'stale', stale: true },
    { id: 'r1', raidOn: '2026-10-02', zone: 'BT', bosses: { kills: 0, pulls: 0 }, sources: { event: false, reports: 0, plan: false }, counts: { present: 5, bench: 0, missed: 1 }, openFlags: 1, state: 'manual', stale: false },
  ];
  const raidsHtml = (over) => G.pages.raids.raidsHtml(Object.assign({ guildData: gd(OFFICER_CAN), teamId: 't1', data: { team: 't1', today: '2026-10-12', raids: RAIDS } }, over || {}));

  await check('raids list: columns, kills/wipes, source chips, counts, one status pill per state, stale pill', () => {
    const out = raidsHtml();
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Raids</h1>'));
    for (const col of ['Date', 'Raid', 'Bosses', 'Attended / bench / missed', 'Status']) assert(out.includes('>' + col + '<'), col);
    assert(!out.includes('>Sources<') && !out.includes('Log x2') && !out.includes('>Zone<'), 'the Sources column is dropped');
    assert(out.includes('1 kill, 16 wipes') && out.includes('<strong class="gs-rp-zone">BT / Hyjal</strong>'));
    assert(out.includes('24 / 1 / 3') && out.includes('href="#/g/g1/raids/r/r4"') && out.includes('Sat Oct 10'));
    assert(out.includes('<span class="gs-hd-chip is-rose">5 to review</span>') && out.includes('<span class="gs-hd-chip is-grey">Awaiting log</span>') && out.includes('<span class="gs-hd-chip is-rose">Needs recalculation</span>') && !out.includes('>Reviewed<') && !out.includes('>Recalculate<</span>'));
    assert(out.includes('<span class="gs-hd-chip is-rose">1 to review</span>') && !out.includes('No log - by hand'), 'ONE chip per row: a manual raid with open flags says what is to do');
    assert(G.pages.raids.statusChipHtml({ state: 'manual', openFlags: 0 }, false).includes('No log - by hand') && G.pages.raids.statusChipHtml({ state: 'reviewed' }, false).includes('is-grey">Reviewed'));
    assert(out.includes('Rules or roster changed under 1 raid'));
    assert(G.pages.raids.statePillsHtml({ state: 'reviewed', openFlags: 0, stale: false }).includes('>Reviewed<'));
    assert(out.includes('2 raids have open flags: Oct 10 and Oct 2.'), 'flag banner for reviewers');
    assert(out.includes('New raid') && out.includes('Backfill from Warcraft Logs'));
    assertNoRawAttrs(out);
  });

  await check('raids list: a member has no actions or counts column data; empty states for officers and members', () => {
    const member = raidsHtml({ guildData: gd(MEMBER_CAN), data: { team: 't1', raids: RAIDS.map(r => Object.assign({}, r, { counts: null })) } });
    assert(!member.includes('New raid') && !member.includes('open flags') && !member.includes('att-recalc'));
    assert(member.includes('data-label="Attended / bench / missed"><span class="gs-muted">-</span>'));
    // Officer-only parts are not drawn for a member: the Sources column, the review and recalculation chips.
    const memberFull = raidsHtml({ guildData: gd(MEMBER_CAN) });
    assert(!memberFull.includes('>Sources<') && !memberFull.includes('Log x2') && !memberFull.includes('to review') && !memberFull.includes('Needs recalculation') && !memberFull.includes('No log - by hand'));
    assert(memberFull.includes('Awaiting log'), 'a member still sees that a log is awaited');
    assert(raidsHtml({ data: { team: 't1', raids: [] } }).includes('No raids yet') && raidsHtml({ data: { team: 't1', raids: [] } }).includes('New raid'));
    assert(raidsHtml({ guildData: gd(MEMBER_CAN), data: { team: 't1', raids: [] } }).includes('Your officers haven\'t added a raid yet.'));
    assert(raidsHtml({ more: true }).includes('data-action="raids-older"'));
    const bad = RAIDS.map(r => Object.assign({}, r, { zone: HOSTILE + QUOTES }));
    assertEscaped(raidsHtml({ data: { team: 't1', raids: bad } }), 'zone');
  });

  // ── new raid ───────────────────────────────────────────────────
  await check('new raid: form fields, team select with several teams, manual mode hides the report rows; run lines list statuses and actions', () => {
    const state = { gid: 'g1', form: { teamId: 't1', event: '', reports: ['', ''], plan: '', mode: 'log', date: '' }, run: null, error: '' };
    const out = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN), state });
    assert(out.includes('New raid') && out.includes('id="nr-team"') && out.includes('id="nr-event"') && out.includes('id="nr-plan"') && out.includes('nr-report-1') && out.includes('Remove report 2'));
    assert(out.includes('No log - enter attendance by hand') && out.includes('type="date"'));
    const manual = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN), state: Object.assign({}, state, { form: Object.assign({}, state.form, { mode: 'manual' }) }) });
    assert(!manual.includes('nr-report-0') && manual.includes('tick who was present'));
    const one = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN, { teams: [{ id: 't1', name: 'A', size: 25, archived: false }] }), state: Object.assign({}, state, { form: Object.assign({}, state.form, { reports: ['x'] }) }) });
    assert(!one.includes('id="nr-team"') && !one.includes('Remove report'));
    const run = { gid: 'g1', form: state.form, raidId: 'r9', running: false, lines: [
      { id: 'raid', label: 'Create the raid', status: 'ok' },
      { id: 'event', label: 'Raid-Helper event', status: 'error', message: 'Different Discord server.', accept: 'Import anyway' },
      { id: 'report-0', label: 'Warcraft Logs report: ' + HOSTILE, status: 'error', message: 'A raid already exists.', openRaidId: 'r2' },
      { id: 'report-1', label: 'Warcraft Logs report: b', status: 'error', message: 'No boss pulls.' },
      { id: 'plan', label: 'Raidsmith plan', status: 'skipped' }] };
    const lines = G.pages.raidNew.runLinesHtml('g1', run);
    assert(lines.includes('aria-live="polite"') && lines.includes('Done') && lines.includes('Failed') && lines.includes('Waiting for the raid'));
    assert(lines.includes('Import anyway') && lines.includes('Open that raid') && lines.includes('href="#/g/g1/raids/r/r2"') && lines.includes('data-line="report-1"') && lines.includes('>Retry<'));
    assertEscaped(lines, 'run lines');
    const done = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN), state: Object.assign({}, state, { run }) });
    assert(done.includes('Open raid') && done.includes('href="#/g/g1/raids/r/r9"') && !done.includes('id="nr-event"'));
  });

  // ── future raids ───────────────────────────────────────────────
  const UP = [
    { id: 'u1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, zone: 'Black Temple', title: null, eventSourced: true, eventId: '1483258698854826006', otherServer: false, signups: { signed: 21, late: 2, bench: 2, tentative: 0, absence: 1 }, planned: true },
    { id: 'u2', raidOn: '2026-10-31', startsAt: Date.UTC(2026, 10, 1, 0, 30), upcoming: true, zone: 'Karazhan', title: 'Prog night', eventSourced: false, eventId: null, otherServer: false, signups: { signed: 0, late: 0, bench: 0, tentative: 0, absence: 0 }, planned: false },
  ];
  // The Raids list no longer has a Plan in Planner button (the raid page's Open in Planner calls this); the helper runs the same planInPlanner call for a list row.
  const planOf = (rid) => { const row = UP.find((r) => r.id === rid); return G.pages.raids.planInPlanner('g1', rid, row.eventSourced && row.eventId ? { id: row.eventId, otherServer: !!row.otherServer } : null).catch((err) => G.app.handleError(err)); };
  const withUp = (over) => raidsHtml(Object.assign({ data: { team: 't1', today: '2026-10-17', raids: RAIDS, upcoming: UP } }, over || {}));

  await check('raids tabs: Upcoming (n) and Past (n) buttons, opens on Upcoming when there is one, else Past; the chosen tab wins', () => {
    const out = withUp();
    // The segment bar of the T1 list: Upcoming / Past with counts (the same pressed-button group as the other lists).
    assert(out.includes('Upcoming <span class="gs-tab-count">2</span>') && out.includes('Past <span class="gs-tab-count">4</span>') && out.includes('class="gs-forge') === false && out.includes('gs-forge'));
    assert(/aria-pressed="true" data-action="raids-tab" data-value="upcoming"/.test(out) && /aria-pressed="false" data-action="raids-tab" data-value="past"/.test(out));
    assert(out.includes('Upcoming raids') && !out.includes('Attended / bench / missed') && out.includes('2 upcoming, 4 past'));
    const past = withUp({ tab: 'past' });
    assert(/aria-pressed="true" data-action="raids-tab" data-value="past"/.test(past) && past.includes('Attended / bench / missed') && !past.includes('Refresh sign-ups'));
    const none = raidsHtml();
    assert(none.includes('Upcoming <span class="gs-tab-count">0</span>') && /aria-pressed="true" data-action="raids-tab" data-value="past"/.test(none));
    assert(raidsHtml({ tab: 'upcoming' }).includes('No upcoming raids'));
    assert(withUp({ more: true, tab: 'past' }).includes('Past <span class="gs-tab-count">4+</span>'));
    assert(raidsHtml({ data: { team: 't1', raids: [], upcoming: UP } }).includes('Past <span class="gs-tab-count">0</span>'));
    assert(raidsHtml({ data: { team: 't1', raids: [], upcoming: UP }, tab: 'past' }).includes('No past raids yet'));
    assert(raidsHtml({ data: { team: 't1', raids: [], upcoming: [] } }).includes('No raids yet'));
  });

  await check('raids upcoming: one card per raid (gold date, time, title in ONE link), figure and bar, officer Plan chip, no row actions', () => {
    const out = withUp();
    assert(out.indexOf('/u1"') < out.indexOf('/u2"'), 'soonest first');
    assert.equal(out.split('class="gs-up"').length - 1, 2, 'one card per raid');
    assert(out.includes('class="gs-up-grid"') && out.includes('<span class="gs-hd-daydate gs-up-date">Sat Oct 24</span>') && out.includes('<span class="gs-up-title">Black Temple</span>') && out.includes('<span class="gs-up-title">Prog night</span>'));
    const card = out.split('<li class="gs-up">')[1].split('</li>')[0];
    assert.equal(card.split('<a ').length - 1, 1, 'ONE link per card');
    assert(card.includes('href="#/g/g1/raids/r/u1"') && /<a class="gs-up-link"[^>]*>.*gs-hd-daydate.*gs-up-time.*gs-up-title.*<\/a>/.test(card.replace(/\n/g, '')));
    assert(!/<a [^>]*>[^<]*<\/a>.*<a /.test(card) && !card.split('</a>')[1].includes('<a '), 'the status sits outside the link');
    assert(card.includes('gs-up-fig'), 'figure');
    assert(/<span class="gs-up-time">\d{1,2}:\d{2} [AP]M [A-Z]{2,4}<\/span>/.test(out), 'time is written with the guild zone');
    assert(out.includes('<span class="gs-hd-chip is-grey">Plan</span>'), 'an unplanned raid carries the Plan chip');
    assert.equal(out.split('>Plan<').length - 1, 1, 'the planned raid carries none');
    assert(!out.includes('raids-refresh') && !out.includes('raids-plan') && !out.includes('Plan in Planner') && !out.includes('upcoming raids.') && !out.includes('Edit weekly schedule') && !out.includes('Sign-ups refreshed'));
    const member = withUp({ guildData: gd(MEMBER_CAN) });
    assert(!member.includes('>Plan<') && !member.includes('Not planned') && !member.includes('Planned'), 'the Plan chip is the officers');
    assert.equal(G.pages.raids.signupsText(null), '-');
    assertEscaped(withUp({ data: { team: 't1', raids: RAIDS, upcoming: UP.map(u => Object.assign({}, u, { title: HOSTILE + QUOTES, zone: HOSTILE + QUOTES })) } }), 'upcoming');
    assertNoRawAttrs(out);
  });

  await check('new raid: Start time, Zone and Title show only for a date from today on; a later date drops the attendance source; the body carries them', () => {
    const base = { teamId: 't1', event: '', reports: [''], plan: '', mode: 'log', date: '', time: '20:00', zone: '', title: '' };
    const html = (f, extra) => G.pages.raidNew.raidNewHtml(Object.assign({ guildData: gd(OFFICER_CAN), state: { gid: 'g1', form: Object.assign({}, base, f), run: null, error: '' }, today: '2026-10-17' }, extra || {}));
    const shown = (out, id) => !new RegExp('id="' + id + '"[^>]*hidden').test(out);
    const past = html({ date: '2026-10-10' });
    assert(!shown(past, 'nr-time-field') && !shown(past, 'nr-zone-field') && !shown(past, 'nr-title-field'));
    assert(!shown(html({}), 'nr-time-field'));
    const today = html({ date: '2026-10-17' });
    assert(shown(today, 'nr-time-field') && shown(today, 'nr-zone-field') && shown(today, 'nr-title-field') && today.includes('type="time"') && today.includes('value="20:00"'));
    assert(!/id="nr-source"[^>]*hidden/.test(today) && !/id="nr-reports"[^>]*hidden/.test(today));
    const later = html({ date: '2026-10-24', zone: 'Karazhan' });
    assert(shown(later, 'nr-time-field') && /id="nr-source"[^>]*hidden/.test(later) && /id="nr-reports"[^>]*hidden/.test(later));
    assert(!shown(html({ date: '2026-10-24', event: '123456' }), 'nr-time-field') && shown(html({ date: '2026-10-24', event: '123456' }), 'nr-zone-field'));
    assert(!shown(html({ date: '2026-10-24', mode: 'manual' }), 'nr-time-field') === false, 'a later date ignores manual mode');
    assert(!shown(html({ date: '2026-10-17', mode: 'manual' }), 'nr-time-field'), 'manual today hides the when-fields');
    const body = (f, today) => plain(G.pages.raidNew.createBody(Object.assign({}, base, f), false, today));
    assert.deepEqual(body({ date: '2026-10-24', zone: 'Karazhan', title: ' Prog night ' }, '2026-10-17'), { teamId: 't1', raidOn: '2026-10-24', startTime: '20:00', zone: 'Karazhan', title: 'Prog night' });
    assert.deepEqual(body({ date: '2026-10-10', zone: 'Karazhan' }, '2026-10-17'), { teamId: 't1', raidOn: '2026-10-10' });
    assert.deepEqual(body({ date: '2026-10-24', event: '123456' }, '2026-10-17'), { teamId: 't1', raidOn: '2026-10-24', eventSource: '123456' });
    assert.deepEqual(body({ date: '2026-10-24' }), { teamId: 't1', raidOn: '2026-10-24' });
  });

  await check('new raid: one create step carries the event and every report; only the plan is a second step', () => {
    const L = f => plain(G.pages.raidNew.buildLines(Object.assign({ teamId: 't1', event: '', reports: [''], plan: '', mode: 'log', date: '' }, f)).map(l => l.id));
    assert.deepEqual(L({ event: '123456', date: '' }), ['raid']);
    assert.deepEqual(L({ event: '123456', date: '2026-10-10' }), ['raid']);
    assert.deepEqual(L({ date: '2026-10-10', reports: ['a', ' ', 'b'], plan: 'PP:2:x' }), ['raid', 'plan']);
    assert.deepEqual(L({ reports: ['a'] }), ['raid']);
    assert.deepEqual(L({ date: '2026-10-10', reports: ['a'], mode: 'manual' }), ['raid']);
  });

  // ── raid detail ────────────────────────────────────────────────
  function prow(id, name, extra) {
    return Object.assign({ playerId: id, name, class: 'DRUID', signup: 'signed', plan: null, pulls: { present: 17, total: 17, missedFirst: false, missedLast: false }, outcome: 'present', credit: 1, pending: false, needsReview: false, flags: [], decision: null }, extra || {});
  }
  function detail(over) {
    return Object.assign({
      raid: { id: 'r4', team: 't1', raidOn: '2026-10-10', startsAt: 1, zone: 'BT / Hyjal', state: 'to_review', openFlags: 3, stale: false, version: 1 },
      can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
      sources: { event: { id: '1483258698854826006', title: 'Sat BT', syncedAt: 1760000000000, signups: 28, otherServer: false }, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1760000000000, pulls: 9 }, { code: 'h8VAwCFa79Jk1cvf', flavour: 'fresh', startedAt: 1760003000000, pulls: 8 }], plan: { label: 'BT run', players: 25 } },
      pulls: [{ encounter: 'Illidan', kill: true, startedAt: 1 }, { encounter: 'Illidan', kill: false, startedAt: 2 }],
      people: [
        prow('p_b', 'Bravo'),
        prow('p_k', 'Kanyan', { pulls: { present: 8, total: 17, missedFirst: true, missedLast: false }, outcome: 'late', credit: null, pending: true, needsReview: true, flags: ['late'], signup: 'tentative' }),
        prow('p_a', 'Alpha', { outcome: 'missed', credit: 0, flags: ['no_show'], pulls: { present: 0, total: 17, missedFirst: false, missedLast: false }, plan: 'G3', decision: { reason: 'Told the raid lead', by: 'Officer', at: 1, applied: true } }),
        prow('p_t', 'Terani', { signup: 'bench', plan: 'bench', outcome: 'bench', credit: 1 }),
      ],
      unmatched: [{ key: 'taharah|dreamscythe', name: 'Taharah', realm: 'Dreamscythe', class: 'DRUID', pullsPresent: 17 }],
      signups: [{ playerId: 'p_k', nickname: 'Kany', kind: 'tentative', source: 'raid_helper' }],
    }, over || {});
  }
  const raidPage = (data, over) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(OFFICER_CAN), data }, over || {}));

  await check('raid detail: header with one summary line, state pill, three source chips with their actions, flagged rows first under "Needs review"', () => {
    const out = raidPage(detail());
    assert(out.includes('Sat Oct 10 - BT / Hyjal') && out.includes('1 kill, 1 wipe') && out.includes('3 to review'));
    assert(out.includes('<dt>Sign-ups</dt><dd><span class="gs-rpg-v">28 signed</span>') && out.includes('data-op="event-refresh"') && out.includes('data-op="event-replace"') && out.includes('data-op="event-remove"'));
    assert(out.includes('Warcraft Logs - 2 reports, 17 pulls') && out.includes('WaghkY9zwDyvLX7m') && out.includes('data-op="report-refresh"') && out.includes('data-code="h8VAwCFa79Jk1cvf"') && out.includes('data-op="report-add"'));
    assert(out.includes('BT run, 25 players') && out.includes('data-op="plan-replace"') && out.includes('data-op="plan-remove"'));
    assert(/aria-pressed="true">Needs review/.test(out), 'defaults to Needs review when flags exist');
    const body = out.slice(out.indexOf('id="raid-people"'), out.indexOf('id="unm-h"'));
    const names = [...body.matchAll(/gs-char-name[^>]*>([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(names, ['Kanyan'], 'only rows with needsReview (a decided row keeps its flags but is closed)');
    assert(body.includes('>Decide</button>') && body.includes('missed the first pull') && body.includes('In 8 of 17 pulls'));
    assert(out.includes('Unmatched characters') && out.includes('data-action="unm-link"') && out.includes('data-action="unm-guest"'));
    const all = raidPage(detail(), { filter: 'all' });
    const allNames = [...all.slice(all.indexOf('id="raid-people"'), all.indexOf('id="unm-h"')).matchAll(/gs-char-name[^>]*>([^<]*)</g)].map(m => m[1]);
    assert(['Kanyan', 'Alpha', 'Bravo', 'Terani'].every(n => allNames.includes(n)), 'Everyone lists them all: ' + allNames);
    assert(all.includes('aria-label="Decide for Kanyan"') && all.includes('aria-label="Change outcome for Alpha"'));
    assert.equal((body.match(/>Decide<\/button>/g) || []).length, 1);
    assert(/Needs review <span class="gs-seg-count">1</.test(out), 'the Worker sends needsReview; decided rows are not counted');
    assertNoRawAttrs(out);
  });

  await check('raid detail: a member sees header and sources only; no people table; no edit buttons', () => {
    const member = detail({ people: null, unmatched: [], can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } });
    const out = raidPage(member, { guildData: gd(MEMBER_CAN) });
    assert(out.includes('Attendance for this raid is visible to the team\'s members.') && !out.includes('<table'));
    assert(!out.includes('data-op=') && !out.includes('Delete raid'));
    const noDecide = raidPage(detail({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), { guildData: gd(MEMBER_CAN) });
    assert(!noDecide.includes('>Decide<') && !noDecide.includes('>Decide</button>') && !noDecide.includes('data-op='));
  });

  await check('raid detail: awaiting log, manual state line with Edit / Remove, stale banner, No log action, escaping', () => {
    const awaiting = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log', openFlags: 0 }), people: [], sources: { event: null, reports: [], plan: null }, unmatched: [] }));
    assert(awaiting.includes('Awaiting log') && awaiting.includes('data-op="manual-open"') && awaiting.includes('Mark as No log') && awaiting.includes('Link an event') && awaiting.includes('Add report') && awaiting.includes('Link a plan'));
    const manual = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', openFlags: 0, manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1760000000000 } }), sources: { event: null, reports: [], plan: null } }));
    assert(manual.includes('Entered by hand by Officer on ') && manual.includes('Reason: Nobody uploaded') && manual.includes('Edit attendance by hand') && manual.includes('Remove hand-entered attendance') && manual.includes('data-op="manual-edit"') && manual.includes('data-op="manual-remove"') && !manual.includes('data-op="report-add"') && !manual.includes('Mark as No log'));
    assert(raidPage(detail({ raid: Object.assign(detail().raid, { stale: true }) })).includes('data-op="recompute"'));
    const bad = detail({ people: [prow('p_x', HOSTILE + QUOTES, { flags: ['no_show'], decision: { reason: HOSTILE, by: QUOTES, applied: true } })], unmatched: [{ key: 'k', name: HOSTILE, realm: QUOTES, class: 'MAGE', pullsPresent: 1 }] });
    bad.raid.zone = HOSTILE;
    assertEscaped(raidPage(bad), 'raid detail');
  });

  await check('decide: options per flag, credit only for late kinds, dialog fields, undo only when a decision exists', () => {
    const R = G.pages.review;
    assert.deepEqual(plain(R.decideOptions({ flags: ['no_show'] })), ['missed', 'missed_notice', 'bench', 'present']);
    assert.deepEqual(plain(R.decideOptions({ flags: ['late'] })), ['late', 'present']);
    assert.deepEqual(plain(R.decideOptions({ flags: ['left_early'] })), ['left_early', 'present']);
    assert.deepEqual(plain(R.decideOptions({ flags: ['late', 'left_early'] })), ['late_left', 'present']);
    assert.deepEqual(plain(R.decideOptions({ flags: [] })), ['present', 'bench', 'missed', 'missed_notice']);
    assert.deepEqual(plain(R.decideOptions({ flags: ['late', 'no_show'] })), ['missed', 'missed_notice', 'bench', 'present']);
    assert(R.needsCredit('late') && R.needsCredit('left_early') && R.needsCredit('late_left') && !R.needsCredit('present') && !R.needsCredit('missed'));
    const raid = detail().raid;
    const late = R.decideDialogHtml({ raid, row: detail().people[1], credits: G.pages.attendance.DEFAULT_CREDITS, where: 'raid' });
    assert(late.includes('Decide: Kanyan') && late.includes('In 8 of 17 pulls; missed the first pull') && late.includes('name="outcome"') && late.includes('name="creditId"') && late.includes('Half 50%'));
    assert(!/id="dlg-credit-field" hidden/.test(late), 'credit shown when the first option is Late');
    assert(late.includes('Reason (required)') && late.includes('data-flags="[&quot;late&quot;]"') && !late.includes('Undo the earlier decision'));
    const noShow = R.decideDialogHtml({ raid, row: detail().people[2], credits: G.pages.attendance.DEFAULT_CREDITS, where: 'review' });
    assert(/id="dlg-credit-field" hidden/.test(noShow) && noShow.includes('Signed up, not in the log'));
    assert(noShow.includes('Undo the earlier decision') && noShow.includes('Told the raid lead') && noShow.includes('data-where="review"'));
    assert.equal(R.creditValuesOf({ resolved: { t1: { credit: { values: [{ id: 'a', label: 'A', value: 1 }, { id: 'b', label: 'B', value: 0 }] } } } }, 't1')[1].id, 'b');
    assert.equal(R.creditValuesOf(null, 't1').length, 3);
  });

  await check('manual dialog: candidates from sign-ups, plan, roster and other teams; ticks; reason; extras hidden until searched', () => {
    const d = detail();
    const rosters = [
      { teamId: 't1', people: [{ id: 'p_r1', status: 'raider', main: { name: 'Rosterguy', class: 'MAGE' }, shown: {} }, { id: 'p_b', status: 'raider', main: { name: 'Bravo', class: 'DRUID' }, shown: {} }, { id: 'p_in', status: 'inactive', main: { name: 'Gone', class: 'MAGE' }, shown: {} }] },
      { teamId: 't2', people: [{ id: 'p_o', status: 'raider', main: { name: 'Otherteam', class: 'ROGUE' }, shown: {} }] },
    ];
    const c = G.pages.raid.manualCandidates(d, rosters, { p_b: true });
    const byId = Object.fromEntries(c.map(x => [x.id, x]));
    assert(byId.p_k.tags.includes('Tentative') && byId.p_a.tags.includes('Plan: G3') && byId.p_t.tags.includes('Plan: bench'));
    assert(byId.p_r1 && !byId.p_in, 'inactive home-team people are not listed');
    assert.equal(byId.p_o.extra, true);
    assert.equal(byId.p_b.ticked, true);
    assert.equal(c[c.length - 1].id, 'p_o', 'other-team people last');
    const out = G.pages.raid.manualDialogHtml({ data: d, candidates: c, reason: 'No uploader', edit: false });
    assert(out.includes('Enter attendance by hand') && out.includes('value="No uploader"') && /value="p_b" checked/.test(out) && /class="gs-pick-item is-extra" data-name="otherteam" hidden/.test(out));
    assert(out.includes('data-input="manual-search"') && out.includes('Reason there is no log (required)'));
    assert.deepEqual(plain(G.pages.raid.manualTicked(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { presentPlayerIds: ['p_b'] } }) }))), { p_b: true });
    assertEscaped(G.pages.raid.manualDialogHtml({ data: d, candidates: [{ id: 'p_x', name: HOSTILE + QUOTES, class: 'MAGE', tags: [HOSTILE], extra: false, ticked: false }], reason: QUOTES }), 'manual dialog');
  });

  await check('source dialogs and confirms: labelled inputs, hidden confirm flag, escaped', () => {
    const s = G.pages.raid.sourceDialogHtml({ submit: 'event-form', title: 'Link a Raid-Helper event', label: 'Event link or ID', button: 'Link event' });
    assert(s.includes('data-submit="event-form"') && s.includes('for="dlg-source"') && s.includes('name="confirm"') && s.includes('id="dlg-submit"'));
    const c = G.pages.raid.confirmDialogHtml({ op: 'report-remove', code: HOSTILE, title: 'T', text: 'x', button: 'Remove', danger: true });
    assertEscaped(c, 'confirm');
    assert(c.includes('gs-btn-danger'));
  });

  // ── review queue ───────────────────────────────────────────────
  const REVIEW = {
    team: 't1',
    raids: [
      { raid: { id: 'r4', raidOn: '2026-10-10', zone: 'BT' }, items: [prow('p_k', 'Kanyan', { flags: ['late'], pending: true, outcome: 'late' }), prow('p_a', 'Alpha', { flags: ['no_show'], outcome: 'missed' }), { key: 'taharah|dreamscythe', name: 'Taharah', realm: 'Dreamscythe', class: 'DRUID', pullsPresent: 17 }] },
      { raid: { id: 'r3', raidOn: '2026-10-09', zone: 'BT' }, items: [{ key: 'swift|x', name: 'Swiftwolves', realm: 'X', class: 'SHAMAN', pullsPresent: 13 }] },
    ],
    stale: ['r2'],
  };
  const reviewHtml = (over) => G.pages.review.reviewHtml(Object.assign({ guildData: gd(OFFICER_CAN), teamId: 't1', data: REVIEW }, over || {}));

  await check('review queue: grouped by raid, Decide for person flags, Link / Guest for unmatched, filter, stale banner', () => {
    const out = reviewHtml();
    assert(out.includes('Review queue') && out.includes('4 open flags on 2 raids') && out.includes('Sat Oct 10 - BT') && out.includes('Fri Oct 9 - BT'));
    assert((out.match(/data-action="decide-open"/g) || []).length === 2 && (out.match(/data-action="unm-link"/g) || []).length === 2 && (out.match(/data-action="unm-guest"/g) || []).length === 2);
    assert(out.includes('In 8 of 17 pulls') === false && out.includes('Signed up, not in the log'));
    assert(out.includes('Druid on Dreamscythe, in 17 pulls, no linked person'));
    assert(out.includes('href="#/g/g1/raids/r/r4"') && out.includes('Rules or roster changed under 1 raid'));
    for (const f of ['All flags', 'No shows', 'Late or left early', 'Unmatched characters']) assert(out.includes('>' + f + '<'), f);
    const noShows = reviewHtml({ filter: 'no_show' });
    assert(noShows.includes('Alpha') && !noShows.includes('Kanyan') && !noShows.includes('Taharah') && !noShows.includes('Fri Oct 9'));
    assert(reviewHtml({ filter: 'unmatched' }).includes('Swiftwolves'));
    assertNoRawAttrs(out);
  });

  await check('review queue: empty state, note, and hostile names escaped', () => {
    const empty = reviewHtml({ data: { team: 't1', raids: [], stale: [] }, note: 'Decision saved.' });
    assert(empty.includes('Nothing to review') && empty.includes('Decision saved.') && !empty.includes('review-filter'));
    const bad = JSON.parse(JSON.stringify(REVIEW));
    bad.raids[0].items[0].name = HOSTILE + QUOTES;
    bad.raids[0].items[2].name = HOSTILE; bad.raids[0].items[2].realm = QUOTES;
    assertEscaped(reviewHtml({ data: bad }), 'review');
    const link = G.pages.review.linkDialogHtml({ unm: bad.raids[0].items[2], raidId: 'r4', where: 'review', people: [{ id: 'p_1', status: 'raider', main: { name: HOSTILE, class: 'MAGE' }, shown: {} }] });
    assertEscaped(link, 'link dialog');
    assert(link.includes('data-submit="unm-link-form"') && link.includes('name="personId"') && link.includes('data-input="unm-search"'));
    assertEscaped(G.pages.review.guestDialogHtml({ unm: bad.raids[0].items[2], raidId: 'r4', where: 'raid' }), 'guest dialog');
  });

  await check('unmatched actions: Link to person, Add as new person, Mark as guest; person dialog defaults to Raider and the raid date; link dialog offers Make Main', () => {
    const out = reviewHtml();
    assert(out.includes('>Link to person...<') && !out.includes('Link as Alt'));
    assert((out.match(/data-action="unm-person"/g) || []).length === 2 && out.includes('>Add as new person...<') && out.includes('data-key="unm-person-r4taharah|dreamscythe"'));
    assert(out.indexOf('data-action="unm-link"') < out.indexOf('data-action="unm-person"') && out.indexOf('data-action="unm-person"') < out.indexOf('data-action="unm-guest"'));
    const unm = REVIEW.raids[0].items[2];
    const dlg = G.pages.review.personDialogHtml({ unm: unm, raidId: 'r4', raidOn: '2026-10-10', where: 'review' });
    assert(dlg.includes('data-submit="unm-person-form"') && dlg.includes('Add Taharah as a new person') && dlg.includes('with this character as their Main'));
    assert(/<option value="raider" selected>Raider</.test(dlg) && dlg.includes('value="trial"') && dlg.includes('value="reserve"'));
    assert(dlg.includes('type="date"') && dlg.includes('name="joinedOn" value="2026-10-10"') && dlg.includes('>Add person<') && dlg.includes('gs-btn-molten'));
    assertEscaped(G.pages.review.personDialogHtml({ unm: Object.assign({}, unm, { name: HOSTILE + QUOTES }), raidId: 'r4', raidOn: QUOTES, where: 'review' }), 'person dialog');
    const link = G.pages.review.linkDialogHtml({ unm: unm, raidId: 'r4', where: 'review', people: [{ id: 'p_1', status: 'raider', main: { name: 'Mainy', class: 'MAGE' }, shown: {} }] });
    assert(link.includes('Link Taharah to a person') && link.includes('as an Alt, or as their Main'));
    assert(link.includes('id="unm-make-main"') && link.includes('name="makeMain"') && link.includes('data-change="unm-make-main"') && link.includes('Make this their Main (their current Main becomes an Alt)'));
    assert(link.includes('id="unm-link-submit"') && link.includes('>Add as Alt<') && link.includes('data-person-name="Mainy"'));
  });

  // ── handlers: decisions and the flow state (stubbed API) ───────
  function stub(handler) {
    const calls = [];
    const real = ctx.Guild.api;
    ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
    return { calls, restore() { ctx.Guild.api = real; } };
  }
  const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});

  await check('handlers: Decide validates the reason, posts the flags the officer saw and the credit id only for late kinds', async () => {
    const S = ctx.Guild.app.state;
    S.currentGid = 'g1'; S.guilds.g1 = gd(OFFICER_CAN);
    const sent = [];
    const s = stub((m, url, body) => { sent.push([m, url, plain(body)]); return Promise.resolve({ raid: { id: 'r4' }, sources: {}, attendanceFlags: { t1: 0 } }); });
    let closed = 0;
    const origRun = G.ui.runDialog;
    G.ui.runDialog = (form, promise, ok) => promise.then(res => { closed++; ok(res); });
    const errs = {};
    const origSet = G.ui.setText;
    G.ui.setText = (id, text) => { errs[id] = text; };
    const form = (outcome, reason) => ({
      getAttribute: k => ({ 'data-where': 'raid', 'data-rid': 'r4', 'data-pid': 'p_k', 'data-flags': '["late"]' })[k],
      elements: { outcome: { value: outcome }, reason: { value: reason, focus() {} }, creditId: { value: 'half' } },
    });
    G.handlers.submit['decide-form'](form('late', 'ab'));
    assert(/3 to 200/.test(errs['dlg-err-reason']) && !sent.length, 'short reason rejected');
    G.handlers.submit['decide-form'](form('late', 'Told the raid lead'));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(sent[0], ['post', '/api/guild/g1/raids/r4/decisions', { playerId: 'p_k', outcome: 'late', reason: 'Told the raid lead', expectedFlags: ['late'], creditId: 'half' }]);
    G.handlers.submit['decide-form'](form('present', 'Was here'));
    await new Promise(r => setImmediate(r));
    assert(!('creditId' in sent[1][2]), 'no credit id for Present');
    assert.equal(closed, 2);
    assert.deepEqual(plain(S.guilds.g1.attendanceFlags), { t1: 0 }, 'the reply refreshes the badge');
    G.ui.runDialog = origRun; G.ui.setText = origSet; s.restore();
  });

  // ── settings ───────────────────────────────────────────────────
  const DEFAULTS = {
    expected: { mode: 'signedUp', statuses: ['raider', 'trial'] }, noSignup: 'shown', tentative: 'asNoSignup', absence: 'missedWithNotice', bench: 'full', lateSignup: 'fullCreditNoFlag',
    detection: { mode: 'pulls' }, credit: { values: [{ id: 'full', label: 'Full', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }, { id: 'none', label: 'None', value: 0 }] },
    fillIn: 'always', window: { defaultWeeks: 8, switchWeeks: [8, 12] }, effectiveStart: 'laterOfJoinAndFirst', streakFlagAt: 4, resetDay: null,
  };
  const POLICY_VIEW = { defaults: DEFAULTS, guild: { tentative: 'asSignedUp' }, teams: { t1: { window: { defaultWeeks: 12 } } }, resolved: {}, versions: { guild: 2, teams: { t1: 5 } }, resetDayDerived: 2, wcl: { guildId: 123, uploaders: { t1: ['Aimers', 'Bob'] } } };

  await check('settings paths: get/set/del prune empty parents; guild scope saves only differences; consolidation keys decide staleness', () => {
    const S = G.pages.settingsAtt;
    const o = {};
    S.setPath(o, 'window.defaultWeeks', 12);
    S.setPath(o, 'tentative', 'asSignedUp');
    assert.deepEqual(plain(o), { window: { defaultWeeks: 12 }, tentative: 'asSignedUp' });
    assert.equal(S.getPath(o, 'window.defaultWeeks'), 12);
    assert.equal(S.getPath(o, 'window.switchWeeks'), undefined);
    S.delPath(o, 'window.defaultWeeks');
    assert.deepEqual(plain(o), { tentative: 'asSignedUp' }, 'empty parent removed');
    assert.deepEqual(plain(S.pruneToDifferences({ tentative: 'asNoSignup', bench: 'excluded', credit: { values: DEFAULTS.credit.values }, window: { defaultWeeks: 8, switchWeeks: [8, 12, 16] } }, DEFAULTS)), { bench: 'excluded', window: { switchWeeks: [8, 12, 16] } });
    assert.equal(S.changesConsolidation({}, { tentative: 'asSignedUp' }), true);
    assert.equal(S.changesConsolidation({}, { window: { defaultWeeks: 12 } }), false, 'windows are read live');
    assert.equal(S.changesConsolidation({ streakFlagAt: 4 }, { streakFlagAt: 0, effectiveStart: 'joinDate' }), false);
    assert.equal(S.changesConsolidation({ credit: { values: [1] } }, { credit: { values: [2] } }), true);
    assert.equal(S.changesConsolidation({ fillIn: 'always' }, {}), true, 'removing an override can change results');
    assert.equal(S.creditIdFor('Quarter!', ['full']), 'quarter');
    assert.equal(S.creditIdFor('Full', ['full']), 'fulla');
    assert.equal(S.creditIdFor('1', []), 'value');
    assert.equal(S.versionFor(POLICY_VIEW, 'guild'), 2);
    assert.equal(S.versionFor(POLICY_VIEW, 't2'), 0);
  });

  await check('settings form: guild scope shows effective values; team scope says Guild default / Changed for this team (plain text, no chips) with Reset; resetDay is guild-only', () => {
    const S = G.pages.settingsAtt;
    const guild = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: { view: POLICY_VIEW, scope: 'guild', draft: S.overrideFor(POLICY_VIEW, 'guild'), stale: 0 } });
    for (const t of ['Who is expected', 'Sign-up handling', 'Late and left early', 'Credit values', 'Fill-ins', 'Windows', 'Reset day', 'Warcraft Logs']) assert(guild.includes('>' + t + '<'), t);
    assert(guild.indexOf('Who is expected') < guild.indexOf('Sign-up handling') && guild.indexOf('Fill-ins') < guild.indexOf('Windows') && guild.indexOf('Windows') < guild.indexOf('Reset day'));
    assert(/value="asSignedUp" checked/.test(guild) && /value="signedUp" checked/.test(guild));
    assert(!guild.includes('Inherited') && !guild.includes('Overridden') && !guild.includes('Changed for this team') && !guild.includes('gs-pol-src'), 'no markers in the guild scope');
    assert(!guild.includes('id="pf-expected-statuses"'), 'statuses only in statuses mode');
    assert(guild.includes('From the guild&#39;s region (Tuesday)') && guild.includes('Reset to defaults') && guild.includes('Look it up by name') === false);
    assert(guild.includes('<option value="1">Monday</option>') && guild.includes('value="8, 12"'));
    assert(guild.includes('id="pol-scope"') && guild.includes('>Guild default<') && guild.includes('>Team KJ override<'));
    const team = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: { view: POLICY_VIEW, scope: 't1', draft: S.overrideFor(POLICY_VIEW, 't1'), stale: 0 } });
    assert(/value="asSignedUp" checked/.test(team), 'inherits the guild override');
    assert(team.includes('Changed for this team') && team.includes('data-path="window.defaultWeeks"') && team.includes('Guild default</span>') && !team.includes('Inherited') && !team.includes('Overridden') && !team.includes('gs-chip'));
    assert((team.match(/data-action="pol-reset"/g) || []).length === 1, 'one overridden key, one Reset');
    assert(team.includes('Set for the whole guild') && team.includes('Remove the team override'));
    const weeks = team.match(/id="p-window-defaultWeeks"[^>]*value="(\d+)"/);
    assert(weeks && weeks[1] === '12');
    const statuses = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: { view: POLICY_VIEW, scope: 'guild', draft: { expected: { mode: 'statuses' } }, stale: 0 } });
    assert(statuses.includes('id="pf-expected-statuses"') && /value="raider" checked/.test(statuses) && /value="reserve"(?! checked)/.test(statuses));
    assertNoRawAttrs(guild);
  });

  await check('settings form: credit list limits (2..5), stale banner with count, WCL card, errors slots per path', () => {
    const S = G.pages.settingsAtt;
    const mk = (values, over) => S.settingsHtml({ guildData: gd(OFFICER_CAN), s: Object.assign({ view: POLICY_VIEW, scope: 'guild', draft: { credit: { values } }, stale: 0 }, over || {}) });
    const two = mk(DEFAULTS.credit.values.slice(0, 2));
    assert((two.match(/data-action="pol-credit-remove"[^>]*disabled/g) || []).length === 2, 'cannot go under 2');
    const five = mk(Array.from({ length: 5 }, (_, i) => ({ id: 'v' + 'a'.repeat(i + 1), label: 'V' + i, value: 0.1 * i })));
    assert(/data-action="pol-credit-add"[^>]*disabled/.test(five), 'cannot go over 5');
    assert(five.includes('value="40"'), 'value shown as a percent');
    assert(mk(DEFAULTS.credit.values, { stale: 4 }).includes('The rules changed under 4 raids') && mk(DEFAULTS.credit.values, { stale: 4 }).includes('data-action="pol-recalc"'));
    assert(mk(DEFAULTS.credit.values).includes('id="perr-credit-values"') && mk(DEFAULTS.credit.values).includes('id="perr-expected-mode"'));
    const wcl = S.wclCardHtml(gd(OFFICER_CAN), POLICY_VIEW, null);
    assert(wcl.includes('id="wcl-guild"') && wcl.includes('value="123"') && wcl.includes('Aimers\nBob') && wcl.includes('Uploaders for Weekend team') && wcl.includes('data-submit="wcl-form"'));
    assertEscaped(S.wclCardHtml(gd(OFFICER_CAN, { teams: [{ id: 't1', name: HOSTILE + QUOTES, size: 25, archived: false }] }), { wcl: { guildId: null, uploaders: { t1: [HOSTILE] } } }, null), 'wcl card');
  });

  await check('settings handlers: changes edit the draft override; Reset and Reset all clear it; credit edits keep ids', () => {
    const S = ctx.Guild.app.state;
    S.currentGid = 'g1'; S.guilds.g1 = gd(OFFICER_CAN);
    const st = ctx.Guild.pages.attendance.attState();
    st.settingsAtt = { gid: 'g1', view: POLICY_VIEW, scope: 't1', draft: {}, stale: 0 };
    const H = G.handlers;
    H.change['pol-change'](el({ 'data-path': 'fillIn', 'data-type': 'radio' }, { value: 'recordOnly' }));
    H.change['pol-change'](el({ 'data-path': 'window.defaultWeeks', 'data-type': 'number' }, { value: '10' }));
    H.change['pol-change'](el({ 'data-path': 'window.switchWeeks', 'data-type': 'list' }, { value: '10, 12' }));
    H.change['pol-change'](el({ 'data-path': 'resetDay', 'data-type': 'resetday' }, { value: '' }));
    const boxes = [{ checked: true, value: 'raider' }, { checked: false, value: 'trial' }, { checked: true, value: 'reserve' }];
    H.change['pol-change'](el({ 'data-path': 'expected.statuses', 'data-type': 'checks' }, { closest: () => ({ querySelectorAll: () => boxes }) }));
    assert.deepEqual(plain(st.settingsAtt.draft), { fillIn: 'recordOnly', window: { defaultWeeks: 10, switchWeeks: [10, 12] }, resetDay: null, expected: { statuses: ['raider', 'reserve'] } });
    H.change['pol-credit'](el({ 'data-idx': '1', 'data-field': 'value' }, { value: '25' }));
    H.change['pol-credit'](el({ 'data-idx': '1', 'data-field': 'label' }, { value: ' Quarter ' }));
    assert.deepEqual(plain(st.settingsAtt.draft.credit.values[1]), { id: 'half', label: 'Quarter', value: 0.25 });
    H.click['pol-credit-add']();
    assert.equal(st.settingsAtt.draft.credit.values.length, 4);
    assert.equal(new Set(st.settingsAtt.draft.credit.values.map(v => v.id)).size, 4);
    H.click['pol-credit-remove'](el({ 'data-idx': '3' }));
    H.click['pol-credit-move'](el({ 'data-idx': '0', 'data-dir': '1', 'data-key': 'pc-dn-0' }));
    assert.deepEqual(st.settingsAtt.draft.credit.values.map(v => v.id), ['half', 'full', 'none']);
    H.click['pol-reset'](el({ 'data-path': 'fillIn' }));
    assert(!('fillIn' in st.settingsAtt.draft));
    H.click['pol-reset-all']();
    assert.deepEqual(plain(st.settingsAtt.draft), {});
    H.change['pol-scope']({ value: 'guild' });
    assert.deepEqual(plain(st.settingsAtt.draft), { tentative: 'asSignedUp' }, 'switching scope loads that level\'s override');
  });

  await check('settings save: sends the override + expectedVersion, guild scope prunes defaults, policy_invalid marks the field', async () => {
    const st = ctx.Guild.pages.attendance.attState();
    st.policy = {};
    st.settingsAtt = { gid: 'g1', view: POLICY_VIEW, scope: 'guild', draft: { tentative: 'asNoSignup', bench: 'excluded' }, stale: 0 };
    const s = stub((m, url) => (/raids/.test(url) ? Promise.resolve({ raids: [] }) : Promise.resolve(Object.assign({}, POLICY_VIEW, { guild: { bench: 'excluded' }, versions: { guild: 3, teams: {} } }))));
    const form = { querySelectorAll: () => [], querySelector: () => null };
    const origBusy = G.ui.setBusy; G.ui.setBusy = () => {};
    G.handlers.submit['pol-form'](form);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(s.calls[0], { m: 'put', url: '/api/guild/g1/attendance/policy', body: { teamId: null, policy: { bench: 'excluded' }, expectedVersion: 2 } });
    assert.equal(st.settingsAtt.view.versions.guild, 3);
    assert.equal(st.polNotice, '', 'the page head says Saved at; there is no banner');
    assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'attendance');
    assert(s.calls.some(c => /\/raids\?team=t1/.test(c.url)), 'a consolidation change looks for stale raids');
    s.restore(); G.ui.setBusy = origBusy;
  });

  // ── backfill ───────────────────────────────────────────────────
  const REPORTS = [
    { code: 'AAAAAAAAAAAAAAAA', flavour: 'fresh', title: 'Sat BT part 1', zone: 'BT', owner: 'Aimers', startTime: 100, raidOn: '2026-10-10', alreadyAdded: null, matchesUploader: true },
    { code: 'BBBBBBBBBBBBBBBB', flavour: 'fresh', title: 'Sat BT part 2', zone: 'BT', owner: 'Aimers', startTime: 200, raidOn: '2026-10-10', alreadyAdded: null, matchesUploader: true },
    { code: 'CCCCCCCCCCCCCCCC', flavour: 'fresh', title: 'Fri BT', zone: 'BT', owner: 'Other', startTime: 50, raidOn: '2026-10-09', alreadyAdded: null, matchesUploader: false },
    { code: 'DDDDDDDDDDDDDDDD', flavour: 'fresh', title: 'Old', zone: 'BT', owner: 'Aimers', startTime: 10, raidOn: '2026-10-02', alreadyAdded: 'r2', matchesUploader: true },
  ];

  await check('backfill: ticked reports group by date (oldest first, added ones ignored) and the preview counts them', () => {
    const B = G.pages.backfill;
    const groups = B.groupByDate(REPORTS, { AAAAAAAAAAAAAAAA: true, BBBBBBBBBBBBBBBB: true, CCCCCCCCCCCCCCCC: true, DDDDDDDDDDDDDDDD: true });
    assert.deepEqual(plain(groups.map(g => [g.raidOn, g.reports.map(r => r.title)])), [['2026-10-09', ['Fri BT']], ['2026-10-10', ['Sat BT part 1', 'Sat BT part 2']]]);
    assert.equal(B.previewText(groups), '2 raids from 3 reports');
    assert.equal(B.previewText(B.groupByDate(REPORTS, { AAAAAAAAAAAAAAAA: true })), '1 raid from 1 report');
    const lines = B.buildLines(groups, { '2026-10-10': ' 123456 ' });
    assert.deepEqual(plain(lines.map(l => l.id)), ['raid:2026-10-09', 'raid:2026-10-10', 'event:2026-10-10']);
    assert.deepEqual(plain(lines[1].codes), ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB']);
    assert.equal(lines.at(-1).src, '123456');
  });

  await check('backfill page: rows, already-added disabled with link, uploader filter, preview with event inputs, create button', () => {
    const bf = { gid: 'g1', teamId: 't1', reports: REPORTS, hasMore: true, page: 1, ticked: { AAAAAAAAAAAAAAAA: true, BBBBBBBBBBBBBBBB: true }, events: {}, filterUploaders: true, loaded: true, run: null, join: null };
    const out = G.pages.backfill.backfillHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', bf, uploaders: ['Aimers'] });
    assert(out.includes('Backfill from Warcraft Logs') && out.includes('Only reports uploaded by Aimers.') && /id="bf-filter"[^>]*checked/.test(out));
    assert(!out.includes('Fri BT'), 'filtered by uploader');
    assert(/id="bf-DDDDDDDDDDDDDDDD"[^>]*disabled/.test(out) && out.includes('href="#/g/g1/raids/r/r2"') && out.includes('Already added'));
    assert(/id="bf-AAAAAAAAAAAAAAAA"[^>]*checked/.test(out));
    assert(out.includes('1 raid from 2 reports') && out.includes('class="gs-input bf-event"') && out.includes('Create 1 raid') && out.includes('data-action="bf-more"'));
    const unfiltered = G.pages.backfill.backfillHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', bf: Object.assign({}, bf, { filterUploaders: false }), uploaders: ['Aimers'] });
    assert(unfiltered.includes('Fri BT'));
    const none = G.pages.backfill.backfillHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', bf: Object.assign({}, bf, { filterUploaders: false }), uploaders: [] });
    assert(!none.includes('id="bf-filter"'));
    const bad = REPORTS.map(r => Object.assign({}, r, { title: HOSTILE + QUOTES, owner: QUOTES, zone: HOSTILE }));
    assertEscaped(G.pages.backfill.backfillHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', bf: Object.assign({}, bf, { reports: bad, filterUploaders: false }), uploaders: [] }), 'backfill');
    assert(G.pages.backfill.backfillHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', bf: Object.assign({}, bf, { reports: [], loaded: true }), uploaders: [] }).includes('No reports found'));
  });

  await check('backfill join step: people joined after their first attended raid, unticked by default, Select all, move button, review link', () => {
    const B = G.pages.backfill;
    const att = { people: [
      { id: 'p_1', name: 'Early', class: 'MAGE', cells: [cell('r1', '2026-10-02', '2026-09-29', 'present'), cell('r2', '2026-10-03', '2026-09-29', 'present')] },
      { id: 'p_2', name: 'Ontime', class: 'MAGE', cells: [cell('r2', '2026-10-03', '2026-09-29', 'present')] },
      { id: 'p_3', name: 'Absent', class: 'MAGE', cells: [cell('r1', '2026-10-02', '2026-09-29', 'missed')] },
      { id: 'p_4', name: 'Benchy', class: 'MAGE', cells: [cell('r1', '2026-10-02', '2026-09-29', 'bench')] },
    ] };
    const roster = { people: [{ id: 'p_1', joinedOn: '2026-10-08', version: 4 }, { id: 'p_2', joinedOn: '2026-10-03', version: 1 }, { id: 'p_3', joinedOn: '2026-10-08', version: 1 }, { id: 'p_4', joinedOn: '2026-10-05', version: 2 }] };
    const c = B.joinCandidates(att, roster);
    assert.deepEqual(plain(c).map(x => [x.id, x.first, x.joinedOn, x.version]), [['p_4', '2026-10-02', '2026-10-05', 2], ['p_1', '2026-10-02', '2026-10-08', 4]]);
    const html = B.joinStepHtml('g1', { loading: false, people: c, ticked: {}, message: '' });
    assert(!/type="checkbox"[^>]*checked/.test(html), 'unticked by default');
    assert(html.includes('Select all') && /data-action="bf-join-move"[^>]*disabled/.test(html) && html.includes('Move join date back') && html.includes('href="#/g/g1/attendance/review"'));
    const ticked = B.joinStepHtml('g1', { loading: false, people: c, ticked: { p_1: true }, message: 'Moved 1 join date back.' });
    assert(/id="bj-p_1"[^>]*checked/.test(ticked) && !/data-action="bf-join-move"[^>]*disabled/.test(ticked) && ticked.includes('Moved 1 join date back.'));
    assert(B.joinStepHtml('g1', { loading: false, people: [], ticked: {} }).includes('No one has a join date later'));
  });

  // ── person attendance ──────────────────────────────────────────
  const PERSON = {
    person: { id: 'p_aa', name: 'Aimersmay', status: 'raider', isMe: true },
    teams: [{ team: { id: 't1', name: 'Team KJ' }, window: 8, metrics: { pct: 100, pctAll: 96.4, signupRate: 90 },
      cells: [
        { raid: { id: 'r1', raidOn: '2026-10-10', zone: 'BT' }, outcome: 'present', credit: 1, via: null, reason: null },
        { raid: { id: 'r0', raidOn: '2026-10-03', zone: 'BT' }, outcome: 'late', credit: null, via: null, reason: 'Told the raid lead' },
        { raid: { id: 'r9', raidOn: '2026-10-07', zone: 'Hyjal' }, outcome: 'fill_in', credit: 1, via: { id: 't2', name: 'Weekend team' }, reason: null },
      ] }],
  };

  const PERSON_BIG = (() => {
    const big = plain(PERSON);
    big.teams[0].cells = Array.from({ length: 10 }, (_, i) => ({ raid: { id: 'r' + i, raidOn: '2026-10-' + String(i + 1).padStart(2, '0'), zone: 'BT' }, outcome: 'present', letter: 'A', credit: 1, pending: false, preStart: false, via: null, reason: null }));
    return big;
  })();

  await check('person attendance: card shows window and all-time %, the last 8 cells and a Full history link; placeholders and denied states', () => {
    const P = G.pages.personAtt;
    const out = P.cardHtml({ gid: 'g1', pid: 'p_aa', record: { person: { isMe: true } }, state: { data: PERSON_BIG } });
    assert(out.includes('>8 weeks<') && out.includes('100%') && out.includes('>All time<') && out.includes('96%') && out.includes('>Sign-ups<'));
    assert((out.match(/class="gs-pr-row gs-pr-raid"/g) || []).length === 8 && (out.match(/<span class="gs-cell gs-out-present" aria-hidden="true">A<\/span><span>Attended<\/span>/g) || []).length === 8, 'last 8 raids as rows with the grid cell and the word');
    assert(!out.includes('gs-hd-chip is-green') && !out.includes('is-rose') && !out.includes('no notice'), 'no tinted chips on the card');
    assert(out.includes('href="#/g/g1/attendance/p/p_aa"') && out.includes('Full history'));
    assert(P.cardHtml({ gid: 'g1', pid: 'p', record: { person: { isMe: true } }, state: null }).includes('Your attendance shows here after the first raid.'));
    assert(P.cardHtml({ gid: 'g1', pid: 'p', record: { person: {} }, state: null }).includes('Attendance shows here after the first raid.'));
    assert(P.cardHtml({ gid: 'g1', pid: 'p', record: { person: {} }, state: { denied: true } }).includes('visible to the members of their team'));
    assert(P.cardHtml({ gid: 'g1', pid: 'p', record: { person: { isMe: true } }, state: { data: { teams: [] } } }).includes('after the first raid'));
  });

  await check('person attendance: the person page renders the real card in place of the placeholder', () => {
    const rec = { person: { id: 'p_aa', status: 'raider', isMe: true, joinedOn: null, discord: { signIn: 'not_yet' }, version: 1 }, characters: [{ id: 'c1', name: 'Aimersmay', class: 'HUNTER', isMain: true, role: 'dps', team: { id: 't1', name: 'Team KJ' } }], can: {}, notes: null };
    const out = G.pages.person.personHtml({ guildData: gd(MEMBER_CAN), record: rec, linkable: null, attendance: { data: PERSON_BIG } });
    assert(out.includes('>8 weeks<') && out.includes('Full history'));
    assert(G.pages.person.personHtml({ guildData: gd(MEMBER_CAN), record: rec, linkable: null }).includes('Your attendance shows here after the first raid.'));
  });

  await check('person history page: per-team block, newest first, via, officer reason column for reviewers only, escaped', () => {
    const P = G.pages.personAtt;
    const out = P.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p_aa', data: PERSON });
    assert(out.includes('Aimersmay') && out.includes('gs-forge') && !out.includes('Attendance history') && !out.includes('>Raider<') && !out.includes('Team KJ'), 'one team: no team heading');
    const rows = [...out.matchAll(/<th scope="row" class="gs-dtable-primary"><a[^>]*>([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(rows, ['Oct 10', 'Oct 7', 'Oct 3']);
    assert(out.includes('Other team (Weekend team)') && out.includes('Officer reason') && out.includes('Told the raid lead') && out.includes('Pending'));
    assert(out.includes('href="#/g/g1/raids/r/r1"'));
    const member = P.personAttHtml({ guildData: gd(MEMBER_CAN), pid: 'p_aa', data: PERSON });
    assert(!member.includes('Officer reason') && !member.includes('Told the raid lead'));
    assert(P.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p', data: { person: { name: 'X' }, teams: [] } }).includes('No attendance yet'));
    const bad = JSON.parse(JSON.stringify(PERSON));
    bad.person.name = HOSTILE + QUOTES;
    bad.teams[0].team.name = HOSTILE;
    bad.teams[0].cells[1].reason = HOSTILE + QUOTES;
    bad.teams[0].cells[2].via = { id: 't2', name: HOSTILE };
    assertEscaped(P.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p_aa', data: bad }), 'person history');
    assertNoRawAttrs(out);
  });

  await check('person page (U2): own record is "Attendance" with figures, a week strip of cells and a capped list; pre-start raids say Before joining and are never counted; no other names', () => {
    const P = G.pages.personAtt;
    const data = plain(PERSON_BIG);
    data.person = { id: 'p_aa', name: 'Aimersmay', class: 'PALADIN', status: 'raider', isMe: true };
    data.teams[0].metrics = { pct: 88, pctAll: 91, signupRate: 94, streak: 2 };
    data.teams[0].cells.forEach((c, i) => { c.weekStart = i < 7 ? '2026-09-29' : '2026-10-06'; });
    data.teams[0].cells.push({ raid: { id: 'rp', raidOn: '2026-09-01', zone: 'BT' }, outcome: 'present', letter: 'A', credit: 1, pending: false, preStart: true, weekStart: '2026-08-31', via: null, reason: null });
    data.teams[0].cells[4].outcome = 'missed'; data.teams[0].cells[4].letter = 'M'; data.teams[0].cells[4].credit = 0;
    const out = P.personAttHtml({ guildData: gd(MEMBER_CAN), pid: 'p_aa', data, pcts: { 4: { t1: 70 }, 8: {} }, own: true });
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Attendance</h1>') && out.includes('Paladin') && !out.includes('>Raider<') && !out.includes('gs-hd-chip'), 'h1 Attendance, no Raider chip, no chip at all');
    const figs = [...out.matchAll(/<span class="gs-pr-cap">([^<]*)<\/span><span class="gs-pr-num">([^<]*)</g)].map(m => m[1] + '=' + m[2]);
    assert.deepEqual(figs, ['4 weeks=70%', '8 weeks=88%', 'All time=91%', 'Sign-ups=94%', 'Streak=2'], 'the 8-week figure is the window the reply carried');
    assert(out.includes('class="gs-at-grid gs-at-solo"') && out.includes('Week of Sep 29') && out.includes('Week of Oct 6') && out.includes('Week of Aug 31'));
    assert((out.match(/<td class="gs-at-d[^"]*"><span class="gs-cell gs-out-present/g) || []).length === 9 && out.includes('gs-out-missed') && out.includes('gs-cell-blank'), 'the strip draws the same cells; the pre-start raid is the empty box');
    assert((out.match(/<tr class="gs-dtable-row"/g) || []).length === 10 && out.includes('Showing 10 of 11 raids') && out.includes('data-action="pa-showall"'));
    assert(!out.includes('Before joining'), 'the pre-start raid is the oldest row: past the cap');
    const S = ctx.Guild.app.state;
    S.att = S.att || {};
    S.att.personUi = { win: null, showAll: true };
    const full = P.personAttHtml({ guildData: gd(MEMBER_CAN), pid: 'p_aa', data, pcts: {}, own: true });
    S.att.personUi = null;
    assert((full.match(/<tr class="gs-dtable-row"/g) || []).length === 11 && full.includes('Before joining'));
    assert(/<span class="gs-pa-grey"><span class="gs-outchip"><span class="gs-cell gs-cell-blank" aria-hidden="true"><\/span><span>Before joining/.test(full), 'greyed, words Before joining');
    assert(/<span class="gs-pa-grey">-<\/span>/.test(full), 'no credit on a pre-start raid');
    assert(['4', '8', 'all'].every(w => out.includes('data-action="pa-window" data-window="' + w + '"')));
    assert(/data-window="8"[^>]*aria-pressed="true"/.test(out));
    assert(!out.includes('Officer reason') && !out.includes('Team KJ'));
  });

  await check('person page (U2): someone else\'s record has the name in class colour, a back link, the status chip only for Trial / Reserve / Inactive, and the reason column for reviewers', () => {
    const P = G.pages.personAtt;
    const data = plain(PERSON);
    data.person = { id: 'p_bb', name: 'Brindle', class: 'MAGE', status: 'raider', isMe: false };
    const out = P.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p_bb', data, pcts: {} });
    assert(/<h1 class="gs-h1 [^"]*" id="page-title" tabindex="-1">Brindle<\/h1>/.test(out) && out.includes(G.ui.classClass('MAGE')) && out.includes('gs-back-link'));
    assert(!out.includes('>Raider<') && !out.includes('gs-hd-chip') && out.includes('Officer reason') && out.includes('Told the raid lead'));
    data.person.status = 'trial';
    assert(P.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p_bb', data, pcts: {} }).includes('gs-hd-chip is-blue">Trial<'));
    assert(!P.personAttHtml({ guildData: gd(MEMBER_CAN), pid: 'p_bb', data, pcts: {} }).includes('Officer reason'));
  });

  // ── guild payload, copy, safety ────────────────────────────────
  await check('privacy page: the new Raid-Helper / Warcraft Logs sentences, and "raids" in place of "raid nights"', () => {
    const out = G.pages.privacy.privacyHtml({ me: null });
    assert(out.includes('Raid-Helper sign-ups on a raid store each Discord ID and nickname until the person signs in and deletes their data. Warcraft Logs reports are read once; only who was present in each boss pull is kept, never the report.'));
    assert(out.includes('roster and raids, and the attendance') && !/raid night/i.test(out));
  });

  await check('applyFlags: attendanceFlags in a reply refresh the badge source without touching rosterFlags', () => {
    const S = ctx.Guild.app.state;
    S.guilds.g1 = gd(OFFICER_CAN, { rosterFlags: { t1: 1 }, attendanceFlags: { t1: 5 } });
    ctx.Guild.app.applyFlags('g1', { attendanceFlags: { t1: 2 } });
    assert.deepEqual(plain(S.guilds.g1.attendanceFlags), { t1: 2 });
    assert.deepEqual(plain(S.guilds.g1.rosterFlags), { t1: 1 });
  });

  await check('safety: the new scripts have no inline styles or handlers, no non-ASCII characters, and the new script tags are on all three pages', () => {
    const files = ['plan-source', 'pages-attendance', 'pages-person-attendance', 'pages-raids', 'pages-raid', 'pages-review', 'pages-settings-attendance', 'pages-backfill'].map(n => 'js/guild/' + n + '.js');
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => {
        assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(line), `${f}:${i + 1} inline style`);
        assert(!/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(line), `${f}:${i + 1} inline handler`);
        assert(!/setAttribute\(\s*['"`](?:style|on[a-z]+)['"`]/i.test(line), `${f}:${i + 1} setAttribute`);
        if (!/^\s*\/\//.test(line)) assert(!/[^\x00-\x7f]/.test(line), `${f}:${i + 1} non-ASCII`);
      });
    }
    const guildCss = css.slice(css.lastIndexOf('/*', css.indexOf('Attendance (Phase 3)'))).replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/[^\x00-\x7f]/.test(guildCss));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) {
      const html = read(page);
      for (const f of files) assert(guildScriptsOf(html).includes('/' + f), `${page} ${f}`);
    }
  });

  await check('import: Import.readSharePlayers exists as the one public wrapper over _parseShareString', () => {
    const src = read('js/import.js');
    assert(/readSharePlayers\(str\)/.test(src) && /_parseShareString\(parts\)/.test(src));
  });


  // ── fix round 1: the UI reads the Worker's real shapes ────────
  await check('fix: person attendance reads cells at teams[].cells and the window per team (number or all)', () => {
    const P = G.pages.personAtt;
    const two = plain(PERSON_BIG);
    two.teams.push({ team: { id: 't2', name: 'Weekend team' }, window: 'all', metrics: { pct: 50, pctAll: 50, signupRate: 50 }, cells: [] });
    two.teams[0].window = 4;
    const out = P.cardHtml({ gid: 'g1', pid: 'p_aa', record: { person: {} }, state: { data: two } });
    assert(out.includes('>4 weeks<') && !out.includes('>8 weeks<') && out.includes('>Recent<'));
    assert((out.match(/class="gs-pr-row gs-pr-raid"/g) || []).length === 8);
    assert(!P.cardHtml({ gid: 'g1', pid: 'p_aa', record: { person: {} }, state: { data: Object.assign(plain(PERSON_BIG), { window: 12 }) } }).includes('12-week'), 'no top-level window');
  });

  await check('fix: team cells carry via {id, name}; the cell names the other team, a missing name still reads', () => {
    const c = cell('x', '2026-10-07', '2026-10-06', 'fill_in', { via: { id: 't2', name: 'Weekend team' } });
    assert(G.pages.attendance.cellHtml(c).includes('(Weekend team)'));
    assert(G.pages.attendance.cellHtml(cell('x', '2026-10-07', '2026-10-06', 'fill_in', { via: { id: 't2', name: null } })).includes('(another team)'));
  });

  await check('fix: raid page - a decided row (flags kept, needsReview false) says Change; an open row says Decide', () => {
    const open = prow('p_o', 'Opened', { outcome: 'late', credit: null, pending: true, needsReview: true, flags: ['late'] });
    const closed = prow('p_c', 'Closed', { outcome: 'late', credit: 0.5, pending: false, needsReview: false, flags: ['late'], decision: { reason: 'ok', by: 'Officer', at: 1, applied: true } });
    const noCredit = prow('p_n', 'Unpaid', { outcome: 'missed', credit: 0, pending: false, needsReview: true, flags: ['no_show'] });
    const out = raidPage(detail({ people: [open, closed, noCredit] }), { filter: 'all' });
    assert(out.includes('aria-label="Decide for Opened"') && out.includes('aria-label="Decide for Unpaid"') && out.includes('aria-label="Change outcome for Closed"') && !out.includes('aria-label="Decide for Closed"'));
    assert(!out.includes('Change outcome for Opened') && /Needs review <span class="gs-seg-count">2</.test(out));
  });

  await check('fix: paging uses hasMore from the reply, not the length of the page', async () => {
    const calls = [];
    const raids = Array.from({ length: 50 }, (_, i) => ({ id: 'r' + i, raidOn: '2026-10-' + String(i % 28 + 1).padStart(2, '0') }));
    const src = read('js/guild/pages-raids.js') + read('js/guild/pages-attendance.js');
    assert(!/PAGE_HINT/.test(src) && !/list\.length < 20/.test(src), 'no length guesses');
    G.api.get = (url) => { calls.push(url); return Promise.resolve({ raids: [{ id: 'old', raidOn: '2026-01-01' }], hasMore: false }); };
    const x = { gid: 'g1', teamId: 't1', data: { raids, hasMore: true }, more: true };
    G.pages.attendance.attState().raids = x;
    G.app.state.guilds.g1 = gd(OFFICER_CAN); G.app.state.currentGid = 'g1';
    G.handlers.click['raids-older']({ disabled: false });
    await new Promise(r => setTimeout(r, 0));
    assert(/before=/.test(calls[0]));
    assert.equal(x.more, false, 'hasMore false ends the paging');
    assert.equal(x.data.raids.length, 51);
  });

  await check('fix: the attendance team page resets the window on a team change and falls back on a 400 window error', async () => {
    const calls = [];
    const A = G.pages.attendance;
    A.attState().attUi = { sort: { column: 'player', dir: 'asc' }, includeInactive: false, window: 12, windowTeam: 't0' };
    G.app.teamFor = () => 't1';
    G.api.get = (url) => {
      calls.push(url);
      if (/window=/.test(url)) return Promise.reject(new G.api.ApiError(400, { error: 'invalid', message: 'Pick one of the offered windows.', field: 'window' }));
      return Promise.resolve({ team: { id: 't1', name: 'Team KJ' }, window: 8, people: [], weeks: [], policy: {} });
    };
    A.attState().policy = { g1: {} };
    const teamCalls = () => calls.filter(u => /attendance\/team/.test(u));
    await A.load({}, gd(OFFICER_CAN));
    assert(!/window=/.test(teamCalls()[0]), 'team change: first request has no window');
    A.attState().attUi.window = 99;
    await A.load({}, gd(OFFICER_CAN));
    assert(/window=99/.test(teamCalls()[1]) && !/window=/.test(teamCalls()[2]), 'a rejected window retries with the team default');
    assert.equal(A.attState().attUi.window, null);
  });

  await check('fix: Link to a person lists the people of the raid\'s team, not the selected team', async () => {
    const calls = [];
    G.api.get = (url) => { calls.push(url); return Promise.resolve({ people: [] }); };
    G.app.teamFor = () => 't_selected';
    G.app.state.guilds.g1 = gd(OFFICER_CAN); G.app.state.currentGid = 'g1';
    const att = G.pages.attendance.attState();
    att.raid = { gid: 'g1', rid: 'r4', data: detail({ raid: Object.assign(detail().raid, { team: { id: 't_raid', name: 'Other' }, teamId: 't_raid' }) }) };
    ctx.document.getElementById = () => null;
    G.ui.openDialog = () => {};
    const attrs = { 'data-where': 'raid', 'data-rid': 'r4', 'data-ukey': 'taharah|dreamscythe' };
    G.handlers.click['unm-link']({ getAttribute: k => attrs[k], disabled: false });
    await new Promise(r => setTimeout(r, 0));
    assert(calls[0].endsWith('/roster?team=t_raid'), calls[0]);
    att.review = { gid: 'g1', teamId: 't_rev', data: { raids: [] } };
    assert.equal(G.pages.review.raidTeamOf('review', 'rX'), 't_rev');
  });

  await check('fix: plan source drops invalid and repeated names, counts them, and explains a plan_invalid index', async () => {
    const players = [{ name: 'Tank', groupNumber: 1 }, { name: 'tank', groupNumber: 2 }, { name: 'X', groupNumber: 1 }, { name: 'Abcdefghijklm', groupNumber: 1 }, { name: 'Bad1', groupNumber: 1 }, { name: 'Zoe', groupNumber: 0 }, { name: 'Renée', groupNumber: 3 }];
    const read1 = await G.planSource.read('PP:2:x', fakeDeps({ readPlayers: () => ({ success: true, name: 'N', players }) }));
    assert.deepEqual(plain(read1.players).map(p => p.name), ['Tank', 'Zoe', 'Renée']);
    assert.equal(read1.skipped, 4);
    assert(/4 names were left out/.test(read1.skippedText));
    const none = await G.planSource.read('PP:2:x', fakeDeps({ readPlayers: () => ({ success: true, name: 'N', players: [{ name: 'X1', groupNumber: 1 }] }) }));
    assert.equal(none.ok, false);
    const err = new G.api.ApiError(400, { error: 'plan_invalid', message: 'A character name is 2 to 12 letters.', field: 'players', index: 1 });
    assert.equal(G.planSource.describeError(err, read1.players), 'Zoe: A character name is 2 to 12 letters.');
    assert.equal(G.planSource.describeError(new G.api.ApiError(500, null), read1.players), null);
  });

  await check('fix: the manual dialog pre-ticks raid.manual.presentPlayerIds, falling back to outcomes only when absent', () => {
    const R = G.pages.raid;
    const d = detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'r', by: 'O', at: 1, presentPlayerIds: ['p_t'] } }) });
    assert.deepEqual(plain(R.manualTicked(d)), { p_t: true });
    delete d.raid.manual.presentPlayerIds;
    assert(R.manualTicked(d).p_b === true);
  });

  await check('R2: backfill creates each raid with ONE POST /raids that carries its reports; a failed add writes nothing and is reported as failed', async () => {
    const posts = [];
    const puts = [];
    let failNext = true;
    G.api.post = (url, body) => {
      posts.push({ url, body });
      if (failNext) return Promise.reject(new G.api.ApiError(404, { error: 'not_found', message: 'Warcraft Logs does not have that report.' }));
      return Promise.resolve({ raid: { id: 'r_new' + posts.length } });
    };
    G.api.put = (url, body) => { puts.push({ url, body }); return Promise.resolve({}); };
    G.api.get = () => Promise.resolve({ people: [], roster: [] });
    const saveRender = G.app.render;
    G.app.render = () => {};
    G.app.state.guilds.g1 = gd(OFFICER_CAN); G.app.state.currentGid = 'g1';
    const bf = { gid: 'g1', teamId: 't1', reports: REPORTS, hasMore: false, page: 1, ticked: { AAAAAAAAAAAAAAAA: true, BBBBBBBBBBBBBBBB: true }, events: {}, filterUploaders: true, loaded: true, run: null, join: null };
    G.pages.attendance.attState().backfill = bf;
    G.handlers.click['bf-create']();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(puts.length, 0, 'no second call to add a report');
    assert.equal(posts.length, 1);
    assert.deepEqual(plain(posts[0].body), { teamId: 't1', raidOn: '2026-10-10', reportSources: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'] });
    assert.deepEqual(plain(bf.run.lines.map(l => [l.id, l.status])), [['raid:2026-10-10', 'error']]);
    assert.equal(bf.run.created, 0);
    failNext = false;
    G.handlers.click['bf-retry']({ getAttribute: (name) => (name === 'data-line' ? 'raid:2026-10-10' : null) });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(posts.length, 2);
    assert.deepEqual(plain(bf.run.lines.map(l => l.status)), ['ok']);
    assert.equal(bf.run.created, 1);
    assert.equal(puts.length, 0);
    G.app.render = saveRender;
  });

  await check('R2: a stale-state raid shows "Needs recalculation", never "Reviewed"', () => {
    const html = G.pages.raids.statePillsHtml({ state: 'stale', openFlags: 0, stale: true });
    assert(html.includes('Needs recalculation') && !html.includes('Reviewed') && !html.includes('>Recalculate<'));
    // Whatever the stored state says, a stale raid shows that one pill (a policy change used to add a second one).
    for (const state of ['reviewed', 'to_review', 'manual']) {
      const both = G.pages.raids.statePillsHtml({ state, openFlags: 2, stale: true });
      assert(both.includes('>Needs recalculation<') && !/Reviewed|Recalculate<|to review|by hand/.test(both), state);
    }
    assert(raidPage(detail({ raid: Object.assign(detail().raid, { state: 'stale', openFlags: 0, stale: true }) })).includes('>Needs recalculation<'));
  });

  await check('R3-3: the New raid page creates a report-only raid (no event, no date) with ONE POST /raids; the date stays required without a report or an event', async () => {
    const posts = [];
    const puts = [];
    G.api.post = (url, body) => { posts.push({ url, body }); return Promise.resolve({ raid: { id: 'r_new' } }); };
    G.api.put = (url, body) => { puts.push({ url, body }); return Promise.resolve({}); };
    const saveRender = G.app.render;
    G.app.render = () => {};
    G.app.state.guilds.g1 = gd(OFFICER_CAN); G.app.state.currentGid = 'g1';
    const A = G.pages.attendance.attState();
    const form = (over) => Object.assign({ teamId: 't1', event: '', reports: ['AAAAAAAAAAAAAAAA', ' ', 'BBBBBBBBBBBBBBBB'], plan: '', mode: 'log', date: '' }, over || {});
    A.nr = { gid: 'g1', form: form(), run: null, error: '' };
    G.handlers.submit['nr-create-form']();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(A.nr.error, '');
    assert.equal(puts.length, 0, 'no second call for the reports');
    assert.equal(posts.length, 1);
    assert.deepEqual(plain(posts[0].body), { teamId: 't1', reportSources: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'] });
    // The event rides in the same call, with the date when one was typed.
    posts.length = 0;
    A.nr = { gid: 'g1', form: form({ event: ' 123456 ', date: '2026-10-10' }), run: null, error: '' };
    G.handlers.submit['nr-create-form']();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(plain(posts.map(p => p.body)), [{ teamId: 't1', raidOn: '2026-10-10', eventSource: '123456', reportSources: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'] }]);
    assert.equal(puts.length, 0);
    // Nothing that gives a date: refused, nothing sent. Manual mode drops the reports, so it needs the date too.
    posts.length = 0;
    A.nr = { gid: 'g1', form: form({ reports: ['', ''] }), run: null, error: '' };
    G.handlers.submit['nr-create-form']();
    assert.match(A.nr.error, /raid date/);
    A.nr = { gid: 'g1', form: form({ mode: 'manual' }), run: null, error: '' };
    G.handlers.submit['nr-create-form']();
    assert.match(A.nr.error, /raid date/);
    assert.equal(posts.length, 0);
    assert.deepEqual(plain(G.pages.raidNew.createBody(form({ mode: 'manual', date: '2026-10-10' }), true)), { teamId: 't1', raidOn: '2026-10-10', acceptOtherServer: true });
    const html = G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN), state: { gid: 'g1', form: form(), run: null, error: '' } });
    assert(html.includes('Raid date (optional)'));
    A.nr = null;
    G.app.render = saveRender;
  });

  await check('raid detail (upcoming): start time, sign-ups, plan status, Refresh sign-ups; no attendance parts', () => {
    const up = detail({
      raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: 'Prog night', zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 },
      people: [], unmatched: [], pulls: [],
      sources: { event: { id: '1483258698854826006', title: 'Sat BT', syncedAt: 1760000000000, signups: 2, otherServer: false }, reports: [], plan: null },
      signups: [{ source: 'raid_helper', kind: 'signed', className: 'Warrior', specName: 'Arms', position: 1, playerId: 'p_b', matched: true, nickname: 'Bravo' },
        { source: 'raid_helper', kind: 'bench', className: 'Bench', specName: null, position: 2, playerId: null, matched: false, nickname: null }],
    });
    // The sign-ups come from the panel (pages-raid-signups.js), with its own data: the merged list of GET /raids/:rid/signups.
    const view = {
      raid: { id: 'u1', teamId: 't1', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, locked: false, closed: null },
      can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null, roster: [],
      counts: { signed: 1, late: 0, tentative: 0, bench: 1, absence: 0, expected: 1, byRole: { tank: 0, healer: 0, melee: 1, ranged: 0, none: 0 }, byClass: { WARRIOR: 1 } },
      entries: [
        { key: 'p:p_b', personId: 'p_b', source: 'raid_helper', kind: 'signed', name: 'Bravo', classId: 'WARRIOR', className: 'Warrior', spec: 'Arms', role: 'melee', characterId: null, note: null, updatedAt: null, matched: true, isMe: false, nickname: 'Bravo' },
        { key: 'x:raid_helper:2', personId: null, source: 'raid_helper', kind: 'bench', name: null, classId: null, className: null, spec: null, role: null, characterId: null, note: null, updatedAt: null, matched: false, isMe: false, nickname: null },
      ],
    };
    const panel = v => ({ signups: { gid: 'g1', rid: 'u1', status: 'ok', data: v, ui: G.pages.raidSignups.freshUi(v) } });
    const out = raidPage(up, panel(view));
    assert(out.includes('Sat Oct 24 - Prog night') && out.includes('>Sign-ups open</span>') && out.includes('Not planned') && out.includes('Raid-Helper, Sat BT (2, synced'));
    assert(!out.includes('Opens when the raid starts') && out.includes('Sign-ups') && out.includes('Bravo') && out.includes('Arms'), 'attendance waits for the start: no log, no people');
    assert(out.includes('Refresh sign-ups') && out.includes('data-op="event-refresh"'));
    assert(!out.includes('Mark as No log') && !out.includes('Recalculate') && !out.includes('Warcraft Logs reports') && !out.includes('Needs review') && !out.includes('>People<'));
    const hidden = Object.assign({}, view, { can: { edit: false, self: false, seeList: false, seeNicknames: false }, counts: null, entries: null });
    assert(raidPage(up, Object.assign({ guildData: gd(MEMBER_CAN), data: Object.assign({}, up, { can: { edit: false, review: false, seeAttendance: false, seeNicknames: false }, signups: [] }) }, panel(hidden))).includes('visible to the team'));
    const hostile = Object.assign({}, view, { entries: [Object.assign({}, view.entries[0], { name: HOSTILE + QUOTES, spec: HOSTILE, nickname: HOSTILE + QUOTES, note: HOSTILE })] });
    assertEscaped(raidPage(up, panel(hostile)), 'upcoming signups');
  });

  await check('Plan in Planner: no button on the Raids list cards (the raid page has it), and Open in Planner in the Actions menu of the raid page (never for a member); Refresh sign-ups lives in the Sign-ups from Change menu', () => {
    const out = withUp();
    assert(!out.includes('raids-plan') && !out.includes('Plan in Planner') && !out.includes('raids-refresh'));
    assertNoRawAttrs(out);
    const up = detail({
      raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 },
      people: [], unmatched: [], pulls: [], signups: [],
    });
    const page = raidPage(up);
    assert(page.includes('data-op="plan-in-planner"') && page.includes('>Open in Planner<'));
    assert(page.indexOf('id="raid-actions"') < page.indexOf('data-op="plan-in-planner"') && page.includes('id="fact-plan"') && page.includes('id="fact-event"'), 'Open in Planner is first in More (and in Plan settings); the event has its own Change menu');
    const noEvent = raidPage(Object.assign({}, up, { sources: { event: null, reports: [], plan: null } }));
    assert(noEvent.includes('data-op="plan-in-planner"') && !noEvent.includes('Refresh sign-ups'));
    assert(!raidPage(Object.assign({}, up, { can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }), { guildData: gd(MEMBER_CAN) }).includes('plan-in-planner'));
    assert(raidPage(detail()).includes('data-op="plan-in-planner"'), 'a past raid can be opened in the Planner too');
  });

  await check('Plan in Planner: an event raid takes its sign-ups from Raid-Helper first, then the address becomes #/planner?raid=; a failed refresh stays here; a raid without an event goes straight there', async () => {
    const saved = { put: G.api.put, handleError: G.app.handleError, applyFlags: G.app.applyFlags };
    const calls = [];
    const errors = [];
    ctx.window = { location: { hash: '' } };
    G.app.applyFlags = () => {};
    G.app.handleError = (err) => errors.push(err);
    G.pages.attendance.attState().raids = { gid: 'g1', teamId: 't1', data: { upcoming: UP, raids: [] } };
    const click = (rid) => planOf(rid);
    const tick = () => new Promise(r => setTimeout(r, 0));
    try {
      G.api.put = (url, body) => { calls.push([url, plain(body)]); return Promise.resolve({}); };
      click('u1');
      await tick();
      assert.deepEqual(calls, [[G.pages.attendance.apiBase('g1') + '/raids/u1/event', { source: '1483258698854826006', acceptOtherServer: false }]]);
      assert.equal(ctx.window.location.hash, '#/planner?raid=g1.u1');
      ctx.window.location.hash = '';
      calls.length = 0;
      click('u2');
      await tick();
      assert.deepEqual([calls.length, ctx.window.location.hash], [0, '#/planner?raid=g1.u2'], 'no event: no refresh');
      ctx.window.location.hash = '';
      G.api.put = () => Promise.reject(new G.api.ApiError(500, null));
      click('u1');
      await tick();
      assert.deepEqual([ctx.window.location.hash, errors.length], ['', 1], 'a failed refresh does not open the Planner');
    } finally {
      Object.assign(G.api, { put: saved.put });
      Object.assign(G.app, { handleError: saved.handleError, applyFlags: saved.applyFlags });
      delete ctx.window;
    }
  });

  // ── An event on another day than the raid: ask, then send the call again with moveRaid ──
  const OTHER_DAY = (extra) => new G.api.ApiError(409, Object.assign({
    error: 'event_other_day', message: 'That event is on 2026-10-29 and the raid is on 2026-10-27.', eventStartsAt: Date.UTC(2026, 9, 30, 0, 0), eventDate: '2026-10-29', raidDate: '2026-10-27',
  }, extra || {}));
  const EVENT_ID = '1483258698854826006';
  const URL_U1 = () => G.pages.attendance.apiBase('g1') + '/raids/u1/event';
  // The dialog shell needs a DOM: a fake dialog keeps the HTML and the close listener so a test can answer Cancel; the form's own submit is Move raid.
  function fakeDialogs() {
    const saved = { openDialog: G.ui.openDialog, closeDialogOf: G.ui.closeDialogOf, put: G.api.put, get: G.api.get, render: G.app.render, handleError: G.app.handleError, applyFlags: G.app.applyFlags };
    const s = { opened: [], closers: [], closed: 0, puts: [], gets: [], renders: 0, errors: [], hash: '' };
    G.ui.openDialog = (html) => { s.opened.push(html); const dlg = { addEventListener: (type, fn) => { if (type === 'close') s.closers.push(fn); } }; return dlg; };
    G.ui.closeDialogOf = () => { s.closed++; s.closers.forEach((fn) => fn()); s.closers.length = 0; };
    G.app.render = () => { s.renders++; };
    G.app.applyFlags = () => {};
    G.app.handleError = (err) => s.errors.push(err);
    s.answerCancel = () => { s.closers.forEach((fn) => fn()); s.closers.length = 0; };
    s.answerYes = () => G.handlers.submit['raid-move-form']({ closest: () => null });
    s.restore = () => { Object.assign(G.ui, { openDialog: saved.openDialog, closeDialogOf: saved.closeDialogOf }); Object.assign(G.api, { put: saved.put, get: saved.get }); Object.assign(G.app, { render: saved.render, handleError: saved.handleError, applyFlags: saved.applyFlags }); delete ctx.window; };
    ctx.window = { location: { get hash() { return s.hash; }, set hash(v) { s.hash = v; } } };
    return s;
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  await check('move question: the dialog names both days and asks to move the raid; Cancel and Move raid are the two buttons; every date is escaped', () => {
    const html = G.pages.raids.moveDialogHtml(OTHER_DAY());
    assert(html.includes('data-submit="raid-move-form"') && html.includes('id="dlg-title">Move this raid?<'));
    assert(html.includes('This event is on Thu Oct 29, the raid is on Tue Oct 27. Move the raid to Thu Oct 29?'), html);
    assert(html.includes('data-action="dialog-cancel">Cancel<') && /id="dlg-submit">Move raid<\/button>/.test(html));
    const hostile = G.pages.raids.moveDialogHtml(OTHER_DAY({ eventDate: HOSTILE, raidDate: HOSTILE + QUOTES }));
    assertEscaped(hostile, 'move dialog');
    assertNoRawAttrs(html);
  });

  await check('putEvent: the first call is the plain one; event_other_day opens the question and Move raid sends it again with moveRaid: true; the answer is the second call\'s', async () => {
    const s = fakeDialogs();
    try {
      let n = 0;
      G.api.put = (url, body) => { s.puts.push([url, plain(body)]); return ++n === 1 ? Promise.reject(OTHER_DAY()) : Promise.resolve({ raid: { raidOn: '2026-10-29' }, sources: {} }); };
      const done = G.pages.raids.putEvent('g1', 'u1', EVENT_ID, false);
      await settle();
      assert.equal(s.opened.length, 1, 'asked once');
      assert.deepEqual(s.puts, [[URL_U1(), { source: EVENT_ID, acceptOtherServer: false }]], 'nothing is resent before the answer');
      s.answerYes();
      const res = await done;
      assert.deepEqual(s.puts[1], [URL_U1(), { source: EVENT_ID, acceptOtherServer: false, moveRaid: true }]);
      assert.equal(res.raid.raidOn, '2026-10-29');
      assert.equal(s.puts.length, 2);
    } finally { s.restore(); }
  });

  await check('putEvent: Cancel (or Escape, or leaving the page) answers MOVE_CANCELLED and sends nothing; a dialog that cannot open counts as no', async () => {
    const s = fakeDialogs();
    try {
      G.api.put = (url, body) => { s.puts.push([url, plain(body)]); return Promise.reject(OTHER_DAY()); };
      const done = G.pages.raids.putEvent('g1', 'u1', EVENT_ID, true);
      await settle();
      s.answerCancel();
      assert.equal(await done, G.pages.raids.MOVE_CANCELLED);
      assert.deepEqual(s.puts, [[URL_U1(), { source: EVENT_ID, acceptOtherServer: true }]], 'acceptOtherServer rides along; no second call');
      // No host element for the dialog (openDialog answers null): nobody said yes.
      G.ui.openDialog = () => null;
      assert.equal(await G.pages.raids.putEvent('g1', 'u1', EVENT_ID, false), G.pages.raids.MOVE_CANCELLED);
    } finally { s.restore(); }
  });

  await check('putEvent: other errors pass through untouched (no question); a team that already has a raid that day is told by weekday; a second question replaces the first', async () => {
    const s = fakeDialogs();
    try {
      G.api.put = () => Promise.reject(new G.api.ApiError(500, null));
      await assert.rejects(G.pages.raids.putEvent('g1', 'u1', EVENT_ID, false), (e) => e.status === 500);
      assert.equal(s.opened.length, 0);
      let n = 0;
      G.api.put = () => (++n === 1 ? Promise.reject(OTHER_DAY()) : Promise.reject(new G.api.ApiError(409, { error: 'raid_date_taken', message: 'That team already has a raid on 2026-10-29, so this raid cannot move there.', raidId: 'r_x', eventDate: '2026-10-29' })));
      const done = G.pages.raids.putEvent('g1', 'u1', EVENT_ID, false);
      await settle();
      s.answerYes();
      await assert.rejects(done, (e) => e.code === 'raid_date_taken' && e.message === 'This team already has a raid on Thu Oct 29, so this raid cannot move there.');
      // Two questions at once (a double click): the first is answered no, the second stands.
      G.api.put = () => Promise.reject(OTHER_DAY());
      const first = G.pages.raids.putEvent('g1', 'u1', EVENT_ID, false);
      await settle();
      const second = G.pages.raids.putEvent('g1', 'u2', EVENT_ID, false);
      await settle();
      assert.equal(await first, G.pages.raids.MOVE_CANCELLED);
      assert.equal(s.opened.length >= 3, true);
      s.answerCancel();
      assert.equal(await second, G.pages.raids.MOVE_CANCELLED);
    } finally { s.restore(); }
  });

  await check('Plan in Planner on another day: the question first; Cancel keeps the officer here with the button back and no error; Move raid sends moveRaid and then opens the Planner', async () => {
    const s = fakeDialogs();
    try {
      G.pages.attendance.attState().raids = { gid: 'g1', teamId: 't1', data: { upcoming: UP, raids: [] } };
      const click = (rid) => planOf(rid);
      G.api.put = (url, body) => { s.puts.push(plain(body)); return body.moveRaid ? Promise.resolve({}) : Promise.reject(OTHER_DAY()); };
      click('u1');
      await settle();
      s.answerCancel();
      await settle();
      assert.deepEqual([s.hash, s.errors.length, s.puts.length], ['', 0, 1]);
      click('u1');
      await settle();
      s.answerYes();
      await settle();
      assert.deepEqual([s.hash, s.errors.length, s.puts[s.puts.length - 1].moveRaid], ['#/planner?raid=g1.u1', 0, true]);
    } finally { s.restore(); }
  });

  await check('raid page: Refresh sign-ups and the Link / Replace event dialog ask first; Cancel leaves the page and the dialog as they are, Move raid applies the answer', async () => {
    const s = fakeDialogs();
    const savedLoad = G.pages.raidSignups.loadFor;
    G.pages.raidSignups.loadFor = () => Promise.resolve(null);
    try {
      const up = detail({
        raid: { id: 'u1', team: 't1', raidOn: '2026-10-27', startsAt: Date.UTC(2026, 9, 28, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 },
        people: [], unmatched: [], pulls: [], signups: [], sources: { event: { id: EVENT_ID, title: 'Sat BT', syncedAt: 1760000000000, signups: 2, otherServer: false }, reports: [], plan: null },
      });
      G.app.state.guilds.g1 = gd(OFFICER_CAN); G.app.state.currentGid = 'g1';
      const att = G.pages.attendance.attState();
      att.raid = { gid: 'g1', rid: 'u1', data: up };
      const moved = Object.assign({}, up, { raid: Object.assign({}, up.raid, { raidOn: '2026-10-29' }) });
      G.api.put = (url, body) => { s.puts.push(plain(body)); return body.moveRaid ? Promise.resolve(moved) : Promise.reject(OTHER_DAY()); };
      // Refresh sign-ups.
      const btn = { disabled: false, getAttribute: (k) => (k === 'data-op' ? 'event-refresh' : null) };
      G.handlers.click['raid-op'](btn);
      await settle();
      s.answerCancel();
      await settle();
      assert.deepEqual([btn.disabled, att.raid.data.raid.raidOn, s.renders], [false, '2026-10-27', 0], 'cancelled: the button is back and the page is as it was');
      G.handlers.click['raid-op'](btn);
      await settle();
      s.answerYes();
      await settle();
      assert.deepEqual([att.raid.data.raid.raidOn, s.puts[s.puts.length - 1].moveRaid, s.errors.length], ['2026-10-29', true, 0]);
      // The Link event dialog: the Move question replaces it (dialogs never stack), so Cancel leaves the page saying "Not linked"; Move raid applies the answer.
      att.raid.data = up;
      const form = { elements: { source: { value: EVENT_ID, focus() {} }, confirm: { value: '0' } }, closest: () => null, querySelectorAll: () => [] };
      s.closed = 0;
      G.handlers.submit['event-form'](form);
      await settle();
      s.answerCancel();
      await settle();
      assert.deepEqual([s.closed, att.raid.data.raid.raidOn], [1, '2026-10-27'], 'the link dialog is closed, the raid stays where it was');
      assert(/^Not linked\./.test(att.note), 'the page says Not linked: ' + att.note);
      G.handlers.submit['event-form'](form);
      await settle();
      s.answerYes();
      await settle();
      await settle();
      assert.deepEqual([att.raid.data.raid.raidOn, s.puts[s.puts.length - 1], s.errors.length], ['2026-10-29', { source: EVENT_ID, acceptOtherServer: false, moveRaid: true }, 0]);
      assert(s.closed >= 2, 'both dialogs are closed after the move');
    } finally { G.pages.raidSignups.loadFor = savedLoad; s.restore(); }
  });

  await check('R3-1: the Log fact shows only "Entered by hand" without the officer\'s name, date and reason', () => {
    const base = detail().raid;
    const hidden = raidPage(detail({ raid: Object.assign({}, base, { state: 'manual', openFlags: 0, manual: { reason: null, by: null, at: 1760000000000, presentPlayerIds: [] } }), sources: { event: null, reports: [], plan: null } }), { guildData: gd(MEMBER_CAN) });
    assert(hidden.includes('<span class="gs-rpg-v">Entered by hand</span>') && !/Reason|by Officer/.test(hidden));
    const shown = raidPage(detail({ raid: Object.assign({}, base, { state: 'manual', openFlags: 0, manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1760000000000 } }), sources: { event: null, reports: [], plan: null } }));
    assert(shown.includes('Entered by hand by Officer on ') && shown.includes('Reason: Nobody uploaded'));
  });

  await check('R3-4: the board shows no Decided note (the Decide dialog keeps the decision and its Undo)', () => {
    const rows = (decision) => [prow('p_a', 'Alpha', { outcome: 'missed', credit: 0, flags: ['no_show'], decision })];
    const applied = raidPage(detail({ people: rows({ reason: 'Told the raid lead', by: 'Officer', at: 1, applied: true }) }), { filter: 'all' });
    assert(!applied.includes('Told the raid lead') && applied.includes('aria-label="Change outcome for Alpha"'));
    const dlg = G.pages.review.decideDialogHtml({ raid: detail().raid, row: rows({ reason: 'Told the raid lead', by: 'Officer', at: 1, applied: true })[0], where: 'raid' });
    assert(dlg.includes('Decided: Told the raid lead (Officer)') && dlg.includes('gs-dialog-form gs-forge'));
    const noReview = { edit: false, review: false, seeAttendance: true, seeNicknames: false };
    const member = raidPage(detail({ people: rows({ at: 1, applied: true }), can: noReview }), { guildData: gd(MEMBER_CAN), filter: 'all' });
    assert(!member.includes('Decided') && !member.includes('Officer') && !member.includes('decide-open'));
  });

  await check('fix: backfill sends expectedVersion from the roster list row version', () => {
    const src = read('js/guild/pages-backfill.js');
    assert(/expectedVersion: p\.version/.test(src) && /version: rp\.version/.test(src));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
