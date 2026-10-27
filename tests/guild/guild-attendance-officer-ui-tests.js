/**
 * Raidsmith guild UI - the Attendance section for officers (redesign lane U1, boards R4): the People view, the Week grid view, the bar
 * (view switch, window segments, Include inactive, Legend), the load / skeleton / error states and the Decide hand-off.
 * Run: node tests/guild/guild-attendance-officer-ui-tests.js
 *
 * Same approach as guild-attendance-ui-tests.js: the guild scripts run in a vm with no DOM and the render functions return HTML strings.
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

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('../guild-scripts');
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
const A = G.pages.attendance;
const plain = v => JSON.parse(JSON.stringify(v));
const text = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const count = (s, re) => (s.match(re) || []).length;

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild',
  'attendance.policy': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild',
};
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }, { id: 't2', name: 'Weekend team', size: 25, archived: false, players: 3, leads: [] }],
    me: { roles: [{ role: 'officer' }], can },
    attendanceFlags: {},
  }, over || {});
}

// Two reset weeks (Tue Sep 29 and Tue Oct 6), four raids Fri/Sat each week.
const RAIDS = [
  { weekStart: '2026-09-29', raids: [{ id: 'r1', raidOn: '2026-10-02', zone: 'BT' }, { id: 'r2', raidOn: '2026-10-03', zone: 'BT' }] },
  { weekStart: '2026-10-06', raids: [{ id: 'r3', raidOn: '2026-10-09', zone: 'BT' }, { id: 'r4', raidOn: '2026-10-10', zone: 'BT' }] },
];
const WEEK_OF = { r1: '2026-09-29', r2: '2026-09-29', r3: '2026-10-06', r4: '2026-10-06' };
const DATE_OF = { r1: '2026-10-02', r2: '2026-10-03', r3: '2026-10-09', r4: '2026-10-10' };
function cell(raidId, outcome, extra) {
  return Object.assign({ raidId, date: DATE_OF[raidId], weekStart: WEEK_OF[raidId], outcome, letter: A.LETTERS[outcome], credit: outcome === 'missed' ? 0 : 1, via: null, pending: false, preStart: false }, extra || {});
}
function cellsOf(outcomes) { return ['r1', 'r2', 'r3', 'r4'].map((r, i) => outcomes[i] ? cell(r, outcomes[i]) : null).filter(Boolean); }
function person(id, name, cls, pct, outcomes, extra) {
  return Object.assign({ id, name, class: cls, status: 'raider', isMe: false, pct, previousPct: null, pctAll: pct, signupRate: 100, streak: 0, streakFlag: false, lastAttended: '2026-10-10', counted: 4, pending: 0, cells: cellsOf(outcomes) }, extra || {});
}
function watchEntry(id, name, cls, over) {
  return Object.assign({ playerId: id, name, class: cls, status: 'raider', pct: 68, previousPct: 79, drop: 11, counted: 12, missed: 3, missedNotice: 0, reasons: ['below'], itemId: 'watch:t1:' + id, reviewed: null }, over || {});
}
function teamData(over) {
  return Object.assign({
    team: { id: 't1', name: 'Team KJ' }, today: '2026-10-12', window: 8, policy: { switchWeeks: [4, 8], defaultWeeks: 8, streakFlagAt: 4, creditValues: [] },
    weeks: RAIDS, awaitingReview: 0, staleRaids: 0,
    watch: { below: 0.75, dropBy: 0.15, window: 8, entries: [
      watchEntry('p_hol', 'Hollis', 'WARLOCK', { reasons: ['below'], pct: 68, previousPct: 79 }),
      watchEntry('p_nyx', 'Nyx', 'ROGUE', { reasons: ['drop'], pct: 70, previousPct: 88, drop: 18 }),
    ] },
    people: [
      person('p_hol', 'Hollis', 'WARLOCK', 68, ['present', 'missed', 'present', 'missed']),
      person('p_nyx', 'Nyx', 'ROGUE', 70, ['present', 'present', 'missed', 'present']),
      person('p_zed', 'Zed', 'MAGE', 95, ['present', 'present', 'present', 'present']),
      person('p_abe', 'Abe', 'HUNTER', 100, ['present', 'bench', 'present', 'present']),
      person('p_mid', 'Midge', 'DRUID', 75, ['present', 'missed', 'present', 'present'], { previousPct: 80 }),
      person('p_bob', 'Bob', 'PALADIN', 82, ['present', 'late', 'present', 'present'], { isMe: true, previousPct: 70 }),
      person('p_new', 'Newbie', 'PRIEST', null, [], { counted: 0, pctAll: null }),
      person('p_str', 'Streaky', 'WARRIOR', 40, ['missed', 'missed', 'missed', 'missed'], { streak: 4, streakFlag: true }),
      person('p_old', 'Oldtimer', 'SHAMAN', 50, ['present'], { status: 'inactive' }),
    ],
  }, over || {});
}
function reviewItem(id, name, cls, outcome, extra) {
  return Object.assign({ kind: 'person', playerId: id, name, class: cls, outcome, credit: null, flags: ['late'], signup: 'signed', pulls: { present: 8, total: 17, missedFirst: true, missedLast: false } }, extra || {});
}
function reviewData(over) {
  return Object.assign({ raids: [
    { raid: { id: 'r4', raidOn: '2026-10-10', zone: 'BT', openFlags: 2, stale: false }, items: [
      reviewItem('p_mid', 'Midge', 'DRUID', 'late'),
      reviewItem('p_bob', 'Bob', 'PALADIN', 'missed', { flags: ['no_show'], pulls: { present: 0, total: 17, missedFirst: true, missedLast: true } }),
      { kind: 'unmatched', key: 'taharah|x', name: 'Taharah', class: 'MAGE' },
    ] },
    { raid: { id: 'r3', raidOn: '2026-10-09', zone: 'BT', openFlags: 1, stale: false }, items: [reviewItem('p_zed', 'Zed', 'MAGE', 'left_early', { flags: ['left_early'] })] },
  ] }, over || {});
}
const pageHtml = (over) => A.attendanceHtml(Object.assign({ guildData: gd(OFFICER_CAN, { attendanceFlags: { t1: 3 } }), teamId: 't1', data: teamData(), review: reviewData(), view: { mode: 'people', sort: A.DEFAULT_SORT, includeInactive: false } }, over || {}));
const gridPage = (over) => pageHtml(Object.assign({ view: { mode: 'grid', sort: A.DEFAULT_SORT, includeInactive: false } }, over || {}));
const rowsOf = (out, cls) => out.split('<li class="' + cls).slice(1);
const namesIn = (html) => [...html.matchAll(/gs-char-link[^"]*" href="[^"]*">([^<]*)</g)].map(m => m[1]);
const sliceFrom = (out, startMarker, endMarker) => { const i = out.indexOf(startMarker); const j = endMarker ? out.indexOf(endMarker, i + 1) : -1; return out.slice(i, j < 0 ? undefined : j); };

(async () => {
  // ── People view ─────────────────────────────────────────────
  await check('People: Forge page (T1) with the h1, the context line, ONE molten Review N flags, More with Review queue / Backfill / How this is counted; no amber chip', () => {
    const out = pageHtml();
    assert(out.includes('<div class="gs-page gs-list-page gs-forge gs-at-page">'));
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Attendance</h1>') && text(out).includes('Team KJ - Last 8 weeks - 8 people'), text(out).slice(0, 200));
    assert.equal(count(out, /gs-btn-molten/g), 1, 'one molten button');
    assert(/<a class="gs-btn gs-btn-molten" href="#\/g\/g1\/attendance\/review"[^>]*><span>Review 3 flags<\/span><\/a>/.test(out));
    assert(out.includes('id="att-more"') && out.includes('>Review queue (3)<') && out.includes('>Backfill from Warcraft Logs<') && out.includes('data-action="att-how"') && out.includes('>How this is counted<'));
    assert(!out.includes('gs-chip-flag') && !out.includes('gs-watch-') && !out.includes('<table'), 'no amber chips, no table in People');
    assert.equal(count(pageHtml({ guildData: gd(OFFICER_CAN) }), /gs-btn-molten/g), 0, 'no flags, no molten');
    const member = pageHtml({ guildData: gd({ 'attendance.view': ['t1'], 'raids.view': 'guild' }) });
    assert(!member.includes('Review queue') && !member.includes('Backfill') && !member.includes('gs-btn-molten'));
  });

  await check('Needs a look: sentence reasons (Below / Down N points, % now, was), class-coloured name link to the history, Reviewed / Undo as before, the last 8 cells', () => {
    const out = pageHtml();
    const panel = sliceFrom(out, '<section class="gs-hd-panel gs-at-pan gs-at-watch"', '<section class="gs-hd-panel gs-at-pan gs-at-await"');
    assert(panel.includes('aria-label="Needs a look"') && panel.includes('<span class="gs-fg-cnt">2</span>'));
    assert(text(panel).includes('Below 75% - 68%, was 79%') && text(panel).includes('Down 18 points - 70%, was 88%'), text(panel));
    assert(panel.includes('class="gs-char-link gs-class-warlock" href="#/g/g1/attendance/p/p_hol"') && panel.includes('class="gs-char-link gs-class-rogue" href="#/g/g1/attendance/p/p_nyx"'));
    assert(panel.includes('aria-label="Mark Reviewed for Hollis" data-action="att-watch-review" data-item="watch:t1:p_hol"') && panel.includes('>Reviewed<'));
    assert(panel.includes('aria-label="Hollis, last 4 raids, oldest first"') && count(sliceFrom(panel, 'aria-label="Hollis, last 4 raids', 'aria-label="Mark Reviewed for Hollis"'), /class="gs-cell /g) === 4, 'the person\'s cells (4 raids in the fixture)');
    assert(!panel.includes('gs-chip-flag') && !panel.includes('gs-pills'));
    // a reviewed entry stays listed with its sentence and an Undo
    const reviewed = teamData();
    reviewed.watch.entries[0].reviewed = { by: { name: 'Kezzik' }, at: Date.UTC(2026, 9, 16, 16, 0) };
    const r = pageHtml({ data: reviewed });
    assert(r.includes('gs-at-w is-reviewed') && text(r).includes('Reviewed by Kezzik, Oct 16. Comes back if attendance drops 5 more points or a raid is missed.'));
    assert(r.includes('aria-label="Undo Reviewed for Hollis" data-action="att-watch-undo" data-item="watch:t1:p_hol"') && r.includes('>Undo<'));
    assert(!r.includes('data-action="att-watch-review" data-item="watch:t1:p_hol"'));
    // both reasons in one sentence, and no previous window: no "was"
    const both = teamData();
    both.watch.entries[0] = watchEntry('p_hol', 'Hollis', 'WARLOCK', { reasons: ['below', 'drop'], pct: 60, previousPct: null, drop: 0 });
    assert(text(G.pages.attendancePeople.watchHtml('g1', both.watch)).includes('Below 75% and down 15 points - 60%'));
    assert(!text(G.pages.attendancePeople.watchHtml('g1', both.watch)).includes('Hollis Below 75% and down 15 points - 60%, was'));
    // an empty list keeps the panel; no watch at all (thresholds off / not a reviewer) draws none and the other panel is alone
    const none = teamData();
    none.watch = { below: 0.75, dropBy: null, window: 8, entries: [] };
    assert(text(pageHtml({ data: none })).includes('Needs a look 0 No one is below the line.'));
    const off = teamData();
    off.watch = null;
    const offOut = pageHtml({ data: off });
    assert(!offOut.includes('gs-at-watch') && offOut.includes('gs-at-top is-solo') && offOut.includes('gs-at-await'));
    assert.equal(G.pages.attendancePeople.watchHtml('g1', 'junk'), '');
  });

  await check('Awaiting your call: open flags by raid under a gold head with its count, name link, the pending cell, the Review queue\'s evidence words, Decide (aria-label) for the existing dialog', () => {
    const out = pageHtml();
    const panel = sliceFrom(out, '<section class="gs-hd-panel gs-at-pan gs-at-await"', '<section class="gs-hd-panel gs-at-band"');
    assert(panel.includes('aria-label="Awaiting your call"') && panel.includes('<span class="gs-fg-cnt">3</span>'), 'unmatched names are not decidable here');
    assert(panel.includes('<h3 class="gs-fg-gh"><span class="gs-fg-ght">Sat Oct 10</span><span class="gs-fg-ghn">2</span></h3>') && panel.includes('<span class="gs-fg-ght">Fri Oct 9</span>'), 'raid heads, newest first');
    assert(!panel.includes('Taharah'));
    assert(panel.includes('aria-label="Decide for Midge"') && panel.includes('aria-label="Decide for Bob"') && panel.includes('aria-label="Decide for Zed"'));
    assert(panel.includes('data-action="decide-open" data-rid="r4" data-pid="p_mid" data-where="attendance" data-key="decide-r4p_mid"'));
    assert(panel.includes('is-pending') && panel.includes('>L?<') && panel.includes('aria-label="Sat Oct 10: Late, awaiting review"'));
    assert(text(panel).includes('In 8 of 17 pulls; missed the first pull') && text(panel).includes('Expected, not in the log') || text(panel).includes('Signed up, not in the log'), text(panel));
    assert(panel.includes('class="gs-char-link gs-class-druid" href="#/g/g1/attendance/p/p_mid"'));
    // more than ten: ten rows, then the Review queue
    const many = reviewData();
    many.raids[0].items = Array.from({ length: 12 }, (_, i) => reviewItem('p_' + i, 'N' + i, 'MAGE', 'late'));
    const big = pageHtml({ review: many });
    assert.equal(count(sliceFrom(big, 'gs-at-await'), /data-action="decide-open"/g), 10);
    assert(text(big).includes('3 more flags. Open the Review queue') && big.includes('<span class="gs-fg-cnt">13</span>'));
    assert(big.includes('<a class="gs-fg-u" href="#/g/g1/attendance/review">Open the Review queue</a>'));
    // no review read / nothing waiting: the panel says so
    assert(text(pageHtml({ review: null })).includes('Awaiting your call 0 No flags are waiting.'));
  });

  await check('bands: Reliable at 90% and over (name + % only), In between under 90 (name, %, was and change, 8 cells, streak chip), no % goes In between with a dash, Needs a look people are not repeated, A-Z, You in place', () => {
    const out = pageHtml();
    const band = sliceFrom(out, '<section class="gs-hd-panel gs-at-band"');
    assert.equal(A.RELIABLE_AT, 0.9);
    const between = sliceFrom(band, '<span class="gs-fg-ght">In between</span>', '<span class="gs-fg-ght">Reliable</span>');
    const reliable = sliceFrom(band, '<span class="gs-fg-ght">Reliable</span>');
    assert.deepEqual(namesIn(between), ['Bob', 'Midge', 'Newbie', 'Streaky']);
    assert.deepEqual(namesIn(reliable), ['Abe', 'Zed']);
    assert(!namesIn(band).includes('Hollis') && !namesIn(band).includes('Nyx') && !namesIn(band).includes('Oldtimer'), 'watch people not repeated, inactive hidden');
    assert(between.includes('<span class="gs-fg-ghn">4</span>') && reliable.includes('<span class="gs-fg-ghn">2</span>'));
    assert(text(between).includes('Last 4 raids, Oct 2 to Oct 10') && text(reliable).includes('90% or more over 8 weeks'));
    assert(!reliable.includes('class="gs-cell') && reliable.includes('gs-at-rel') && text(reliable).includes('100%') && text(reliable).includes('95%'), 'compact rows: no cells');
    assert(text(between).includes('was 80%, -5') && text(between).includes('was 70%, +12'), text(between));
    const newbie = rowsOf(between, 'gs-at-row gs-at-b').find(r => r.includes('Newbie'));
    assert(/<span class="gs-at-pct">-<\/span>/.test(newbie), 'no counted raids: a dash');
    assert(rowsOf(between, 'gs-at-row gs-at-b').find(r => r.includes('Bob')).startsWith(' is-you">') && between.includes('<span class="gs-you">You</span>'));
    assert(between.includes('<span class="gs-hd-chip is-rose">4 missed<span class="gs-sr"> raids in a row, flagged</span></span>'));
    assert(!reliable.includes('is-rose'));
    assert(rowsOf(between, 'gs-at-row gs-at-b').every(r => r.includes('role="group" aria-label="') && r.includes('last 4 raids, oldest first')));
    // the window words follow the window; the boundary is the constant
    const all = teamData({ window: 'all' });
    assert(text(pageHtml({ data: all })).includes('90% or more over all time'));
    const edge = teamData();
    edge.people.push(person('p_90', 'Edge', 'MAGE', 90, ['present']), person('p_89', 'Almost', 'MAGE', 89.6, ['present']));
    const eb = sliceFrom(pageHtml({ data: edge }), '<section class="gs-hd-panel gs-at-band"');
    assert(namesIn(sliceFrom(eb, '<span class="gs-fg-ght">Reliable</span>')).includes('Edge') && namesIn(sliceFrom(eb, 'In between', '<span class="gs-fg-ght">Reliable</span>')).includes('Almost'));
    // nobody left: no empty groups
    const lone = teamData();
    lone.people = lone.people.filter(p => ['p_hol', 'p_nyx'].includes(p.id));
    const l = pageHtml({ data: lone });
    assert(!l.includes('In between') && !l.includes('Reliable') && l.includes('No one else matches.'));
  });

  await check('the bar: People / Week grid switch (aria-pressed), window segments 4 weeks / 8 weeks / All time, Include inactive, Legend button; the default policy offers 4 and 8', () => {
    const out = pageHtml();
    assert(/aria-label="View"><button type="button" class="gs-fg-seg" data-action="att-view" data-view="people" data-key="aview-people" aria-pressed="true">People<\/button><button[^>]*data-view="grid"[^>]*aria-pressed="false">Week grid<\/button>/.test(out));
    assert(out.includes('aria-label="Time window"') && out.includes('>4 weeks<') && out.includes('>8 weeks<') && out.includes('>All time<') && !out.includes('>12 weeks<'));
    assert(/data-window="8"[^>]*aria-pressed="true"/.test(out) && /data-window="4"[^>]*aria-pressed="false"/.test(out) && /data-window="all"[^>]*aria-pressed="false"/.test(out));
    assert(/id="att-inactive" data-change="att-inactive">Include inactive/.test(out) && /data-action="att-legend"[^>]*aria-haspopup="dialog">Legend</.test(out));
    const inc = pageHtml({ view: { mode: 'people', sort: A.DEFAULT_SORT, includeInactive: true } });
    assert(/id="att-inactive"[^>]*checked/.test(inc) && inc.includes('Oldtimer') && text(inc).includes('9 people'));
    const custom = teamData({ policy: { switchWeeks: [6, 12], defaultWeeks: 12 }, window: 12 });
    assert(pageHtml({ data: custom }).includes('>6 weeks<') && pageHtml({ data: custom }).includes('>12 weeks<'), 'a guild with its own windows keeps them');
    assert(!out.includes('gs-segs') && !out.includes('<details'), 'no old segments, no folded legend');
    assert(gridPage().includes('data-view="grid" data-key="aview-grid" aria-pressed="true"'));
  });

  // ── Week grid view ──────────────────────────────────────────
  await check('Week grid: no panels above, the bar then one panel with the table; names link to the history with spec icon; window % and Streak columns; weeks grouped "Week of Sep 29", days "Fri" over "Oct 2" linking to the raid', () => {
    const out = gridPage();
    assert(out.includes('gs-forge gs-at-page') && !out.includes('Needs a look') && !out.includes('Awaiting your call') && !out.includes('gs-at-top'));
    assert.equal(count(out, /<section class="gs-hd-panel/g), 1);
    assert(out.indexOf('class="gs-at-bar"') > out.indexOf('<section class="gs-hd-panel gs-at-mx"') && out.indexOf('<table') > out.indexOf('class="gs-at-bar"'));
    assert(out.includes('<table class="gs-at-grid" aria-label="Attendance by raid">') && out.includes('class="gs-at-scroll"'));
    assert(out.includes('>Week of Sep 29<') && out.includes('>Week of Oct 6<') && out.indexOf('Week of Sep 29') < out.indexOf('Week of Oct 6'), 'older week left, newest right');
    assert(/<span class="gs-at-wd">Fri<\/span><span>Oct 2<\/span>/.test(out) && out.includes('href="#/g/g1/raids/r/r4" aria-label="Sat Oct 10, open raid"'));
    assert(out.includes('class="gs-at-d is-wk"') && out.includes('class="gs-at-dh is-wk"'), 'the first day of a week carries the week gap');
    assert(namesIn(out).slice(0, 3).join() === 'Abe,Bob,Hollis', 'A-Z by default (inactive hidden)');
    assert(out.includes('<span class="gs-at-name"><img class="gs-spec-icon"') && out.includes('class="gs-char-link gs-class-mage" href="#/g/g1/attendance/p/p_zed"'));
    assert(out.includes('<span class="gs-you">You</span>') && out.includes('<tr class="is-you">'));
    assert(text(out).includes('95%') && text(out).includes('100%'));
    assert.equal(count(out, /gs-chip-flag/g), 0);
    assert.equal(count(out, /gs-btn-molten/g), 1);
  });

  await check('Week grid: sort heads are buttons with aria-sort on Name, the window % and Streak; the Streak is the rose chip only when flagged; an Other-team cell is an extra day; pending is marked', () => {
    const out = gridPage();
    assert(/<th scope="col" rowspan="2" class="gs-at-c-name" aria-sort="ascending"><button type="button" class="gs-sort" data-action="att-sort" data-col="player" data-key="asort-player" data-dir="asc">Name/.test(out));
    assert(out.includes('data-col="pct"') && out.includes('>8 weeks<span class="gs-sort-ind"') && out.includes('data-col="streak"') && !out.includes('data-col="signup"') && !out.includes('data-col="last"'));
    assert.equal(count(out, /aria-sort=/g), 1);
    const sorted = gridPage({ view: { mode: 'grid', sort: { column: 'pct', dir: 'desc' }, includeInactive: false } });
    assert(/aria-sort="descending"[^>]*><button[^>]*data-col="pct"/.test(sorted) || /class="gs-at-c-pct" aria-sort="descending"/.test(sorted));
    assert.deepEqual(namesIn(sorted).slice(0, 3), ['Abe', 'Zed', 'Bob']);
    assert.equal(count(out, /<span class="gs-hd-chip is-rose">4/g), 1, 'one flagged streak');
    assert(out.includes('<span class="gs-at-streak">0</span>'));
    const d = teamData();
    d.people[0].cells.push(cell('r3', 'present', { pending: true, letter: 'A?' }));
    d.people[0].cells = d.people[0].cells.filter((c, i, arr) => arr.findIndex(x => x.raidId === c.raidId) === i || c.pending);
    d.people[1].cells.push({ raidId: 'x9', date: '2026-10-07', weekStart: '2026-10-06', outcome: 'fill_in', letter: 'F', credit: 1, via: 'Weekend team', pending: false, preStart: false });
    d.people[2].pending = 2;
    const g = gridPage({ data: d });
    assert(g.includes('Other-team attendance') && g.includes('>F<'));
    assert(g.includes('raids awaiting review') && g.includes('2 raids awaiting review'));
    assert(text(gridPage({ data: teamData({ window: 'all' }) })).includes('All time'));
    const empty = gridPage({ view: { mode: 'grid', sort: A.DEFAULT_SORT, includeInactive: false }, data: teamData({ people: [] }) });
    assert(empty.includes('No one matches these filters.') && !empty.includes('<table'));
  });

  await check('empty team: No attendance yet with New raid (officer) and no panels; a stale banner offers Recalculate', () => {
    const e = pageHtml({ data: teamData({ weeks: [], people: [], watch: null }) });
    assert(e.includes('No attendance yet') && e.includes('New raid') && !e.includes('gs-at-band'));
    assert.equal(count(pageHtml({ data: teamData({ weeks: [], people: [], watch: null }), guildData: gd(OFFICER_CAN) }), /gs-btn-molten/g), 1, 'the empty state\'s New raid is the one molten');
    const stale = pageHtml({ data: teamData({ staleRaids: 3 }) });
    assert(stale.includes('Rules or roster changed under 3 raids') && stale.includes('data-action="att-recalc"') && stale.includes('Recalculate 3 raids'));
    assert(pageHtml({ progress: { running: true, done: 1, total: 3 } }).includes('Recalculating 1 of 3'));
  });

  await check('loading is a skeleton with a status line, an error is the error region with Try again, a denied viewer gets the access card', () => {
    const sk = A.skeletonHtml();
    assert(sk.includes('gs-forge') && sk.includes('aria-busy="true"') && sk.includes('<p class="gs-sr" role="status">Loading attendance</p>') && sk.includes('gs-hd-sk') && sk.includes('Attendance</h1>'));
    const err = A.errorHtml('Timed out.');
    assert(err.includes('gs-errregion') && text(err).includes('load attendance') && err.includes('data-action="retry"') && err.includes('Try again') && err.includes('gs-forge'));
    const denied = A.attendanceHtml({ guildData: gd({ 'attendance.view': ['t2'] }), teamId: 't2', denied: true });
    assert(denied.includes('visible to the people who have a character') && !denied.includes('<table') && denied.includes('gs-forge'));
    const S = G.app.state;
    const saved = S.att;
    S.att = {};
    S.currentGid = 'g1';
    G.app.teamFor = () => 't1';
    const g = gd(OFFICER_CAN);
    assert(A.main({}, g).includes('Loading attendance'), 'nothing loaded yet = skeleton');
    S.att = { team: { gid: 'g1', teamId: 't1', data: null, error: 'The server didn\'t answer.' } };
    assert(A.main({}, g).includes('data-action="retry"'));
    S.att = saved;
  });

  // ── behaviour ───────────────────────────────────────────────
  await check('the view switch is remembered per guild in localStorage (try/catch: no storage falls back to People) and switching redraws without a request', async () => {
    const S = G.app.state;
    const store = {};
    ctx.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    S.att = {};
    S.currentGid = 'g1';
    let renders = 0, routed = 0;
    const saveRender = G.app.render, saveRoute = G.app.routeAll;
    G.app.render = () => { renders++; };
    G.app.routeAll = () => { routed++; return Promise.resolve(); };
    G.app.teamFor = () => 't1';
    S.att.team = { gid: 'g1', teamId: 't1', data: teamData(), review: reviewData(), denied: false };
    assert(A.main({}, gd(OFFICER_CAN)).includes('data-view="people" data-key="aview-people" aria-pressed="true"'), 'People by default');
    G.handlers.click['att-view']({ getAttribute: k => ({ 'data-view': 'grid' })[k] });
    assert.equal(store['raidsmith.attendance.view.g1'], 'grid');
    assert.equal(renders, 1);
    assert.equal(routed, 0, 'the same payloads: no new request');
    assert(A.main({}, gd(OFFICER_CAN)).includes('<table class="gs-at-grid"'));
    // a new session in the same browser: the stored view opens
    S.att = { team: { gid: 'g1', teamId: 't1', data: teamData(), review: null, denied: false } };
    assert(A.main({}, gd(OFFICER_CAN)).includes('<table class="gs-at-grid"'), 'remembered');
    // another guild has its own memory
    store['raidsmith.attendance.view.g2'] = 'people';
    S.att = { team: { gid: 'g2', teamId: 't1', data: teamData(), review: null, denied: false } };
    const g2 = gd(OFFICER_CAN); g2.guild.id = 'g2';
    assert(!A.main({}, g2).includes('<table class="gs-at-grid"'));
    // storage that throws, or is absent: People, and the click still works
    ctx.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    S.att = { team: { gid: 'g1', teamId: 't1', data: teamData(), review: null, denied: false } };
    assert(!A.main({}, gd(OFFICER_CAN)).includes('<table class="gs-at-grid"'));
    G.handlers.click['att-view']({ getAttribute: () => 'grid' });
    delete ctx.localStorage;
    S.att = { team: { gid: 'g1', teamId: 't1', data: teamData(), review: null, denied: false } };
    assert(!A.main({}, gd(OFFICER_CAN)).includes('<table class="gs-at-grid"'), 'no localStorage at all');
    G.app.render = saveRender; G.app.routeAll = saveRoute;
    S.att = {};
  });

  await check('load: a reviewer reads the team and the open flags (a missing flags read does not take the page down); a failed read is the error state; a sign-in problem is the app\'s', async () => {
    const S = G.app.state;
    S.att = { policy: { g1: {} } };
    G.app.teamFor = () => 't1';
    const urls = [];
    let reviewFails = false, teamFails = null;
    G.api.get = (url) => {
      urls.push(url);
      if (/attendance\/review/.test(url)) return reviewFails ? Promise.reject(new G.api.ApiError(500, { error: 'x', message: 'nope' })) : Promise.resolve(reviewData());
      if (teamFails) return Promise.reject(teamFails);
      return Promise.resolve(teamData());
    };
    await A.load({}, gd(OFFICER_CAN));
    assert(urls.some(u => /attendance\/team\?team=t1/.test(u)) && urls.some(u => /attendance\/review\?team=t1/.test(u)));
    assert.equal(S.att.team.review.raids.length, 2);
    reviewFails = true;
    await A.load({}, gd(OFFICER_CAN));
    assert.equal(S.att.team.review, null);
    assert(A.main({}, gd(OFFICER_CAN)).includes('Awaiting your call'), 'the page still draws');
    teamFails = new G.api.ApiError(500, { error: 'x', message: 'The server broke.' });
    await A.load({}, gd(OFFICER_CAN));
    assert.equal(S.att.team.error, 'The server broke.');
    assert(text(A.main({}, gd(OFFICER_CAN))).includes('load attendance'));
    teamFails = new G.api.ApiError(401, { error: 'unauthorized', message: 'Sign in.' });
    await assert.rejects(A.load({}, gd(OFFICER_CAN)), e => e.status === 401);
    S.att = {};
  });

  await check('auto-recalc (user decision 2026-10-26): opening the page runs the banner\'s loop over the raids the Worker marks autoRecalc, only for the team\'s raids.edit, with the page\'s own data as the hint, at most one run a minute, nothing new drawn', async () => {
    const S = G.app.state;
    const saveGet = G.api.get, savePost = G.api.post, saveRender = G.app.render, saveRoute = G.app.routeAll;
    const calls = [];
    const shown = [];
    let routed = 0;
    const raids = [
      { id: 'r_new', raidOn: '2026-10-20', stale: true, autoRecalc: true },
      { id: 'r_held', raidOn: '2026-09-01', stale: true, autoRecalc: false },
      { id: 'r_old_named', raidOn: '2026-08-04', stale: true, autoRecalc: true },
      { id: 'r_fine', raidOn: '2026-10-13', stale: false },
    ];
    const reads = (team) => (url) => {
      calls.push('GET ' + url);
      if (/\/raids\?/.test(url)) return Promise.resolve({ raids, hasMore: false });
      if (/attendance\/review/.test(url)) return Promise.resolve(reviewData());
      return Promise.resolve(team);
    };
    G.api.post = (url) => { calls.push('POST ' + url); return Promise.resolve({}); };
    G.app.render = () => { if (S.att.recalc && S.att.recalc.running) shown.push(S.att.recalc.done + '/' + S.att.recalc.total); };
    G.app.routeAll = () => { routed++; return Promise.resolve(); };
    const posts = () => calls.filter(c => c.startsWith('POST'));
    const fresh = () => { S.att = { policy: { g1: {} } }; S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1'; G.app.teamFor = () => 't1'; calls.length = 0; shown.length = 0; routed = 0; };
    try {
      // The officer opens the page: the held raid and the fine one are left, the other two are recalculated through the existing loop and notice.
      fresh();
      G.api.get = reads(teamData({ staleRaids: 3, staleAuto: 2 }));
      await A.load({}, gd(OFFICER_CAN));
      await S.att.autoRun;
      assert.deepEqual(posts(), ['POST /api/guild/g1/raids/r_new/recompute', 'POST /api/guild/g1/raids/r_old_named/recompute']);
      assert(shown.includes('0/2'), 'the existing "Recalculating n of 2" notice');
      assert.equal(routed, 1, 'the route is read again, like after the button');
      assert.equal(S.att.recalc, null);
      // The same page again, as the load after that run: inside the minute nothing starts.
      calls.length = 0;
      await A.load({}, gd(OFFICER_CAN));
      await S.att.autoRun;
      assert.deepEqual(posts(), [], 'one run a minute per tab');
      // A minute later the next open runs again.
      await A.autoRecalc(gd(OFFICER_CAN), 't1', true, Date.now() + 61000);
      assert.equal(posts().length, 2);
      // No hint (the team data shows no raid for it): not even the list is read.
      fresh();
      G.api.get = reads(teamData({ staleRaids: 2, staleAuto: 0 }));
      await A.load({}, gd(OFFICER_CAN));
      await S.att.autoRun;
      assert(!calls.some(c => /\/raids\?/.test(c)) && posts().length === 0);
      // No raids.edit on the team: no run, no list read.
      fresh();
      G.api.get = reads(teamData({ staleRaids: 3, staleAuto: 2 }));
      const reviewerOnly = Object.assign({}, OFFICER_CAN);
      delete reviewerOnly['raids.edit'];
      await A.load({}, gd(reviewerOnly));
      assert.equal(S.att.autoRun, undefined);
      await A.load({}, gd(Object.assign({}, reviewerOnly, { 'raids.edit': ['t2'] })));
      assert.equal(S.att.autoRun, undefined, 'raids.edit on another team is not raids.edit here');
      assert(!calls.some(c => /\/raids\?/.test(c)) && posts().length === 0);
      // A loop of this tab (the button's) is running: an open does not start a second.
      fresh();
      S.att.recalc = { running: true, done: 0, total: 1, failed: 0 };
      await A.autoRecalc(gd(OFFICER_CAN), 't1', true, Date.now());
      assert.deepEqual(calls, [], 'no request at all');
      // Nothing new is drawn: the banner is the existing one.
      const banner = A.staleBannerHtml(3, true, null);
      assert(banner.includes('data-action="att-recalc"') && !/auto/i.test(banner));
    } finally {
      G.api.get = saveGet; G.api.post = savePost; G.app.render = saveRender; G.app.routeAll = saveRoute;
      S.att = {};
    }
  });

  await check('Decide: the button opens the existing dialog from the Attendance page\'s own flags (where=attendance); a saved decision reads the page again', async () => {
    const S = G.app.state;
    S.att = { policy: { g1: { resolved: {}, defaults: {} } }, team: { gid: 'g1', teamId: 't1', data: teamData(), review: reviewData(), denied: false } };
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    G.app.teamFor = () => 't1';
    const opened = [];
    G.ui.openDialog = (html) => { opened.push(html); return null; };
    ctx.document.getElementById = () => null;
    const attrs = { 'data-rid': 'r4', 'data-pid': 'p_mid', 'data-where': 'attendance' };
    G.handlers.click['decide-open']({ getAttribute: k => attrs[k] });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(opened.length, 1);
    assert(opened[0].includes('Decide: Midge') && opened[0].includes('data-where="attendance"') && opened[0].includes('data-rid="r4"') && opened[0].includes('data-pid="p_mid"'));
    // after a decision the page reloads both payloads and the Attendance badge
    const routed = [];
    const saveRoute = G.app.routeAll, saveApply = G.app.applyFlags;
    G.app.routeAll = (o) => { routed.push(o); return Promise.resolve(); };
    let applied = 0;
    G.app.applyFlags = () => { applied++; };
    ctx.__done = null;
    G.ui.runDialog = (form, promise, onOk) => promise.then(onOk);
    const els = { outcome: { value: 'late' }, reason: { value: 'Was on the voice channel' }, creditId: { value: 'full' } };
    const formAttrs = { 'data-rid': 'r4', 'data-pid': 'p_mid', 'data-where': 'attendance', 'data-flags': '["late"]' };
    G.api.post = () => Promise.resolve({ ok: true });
    G.ui.setText = () => {};
    G.handlers.submit['decide-form']({ elements: els, getAttribute: k => formAttrs[k] });
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(plain(routed), [{ force: true }]);
    assert.equal(applied, 1);
    G.app.routeAll = saveRoute; G.app.applyFlags = saveApply;
    S.att = {};
  });

  await check('Legend and How this is counted open as dialogs (the legend names every outcome; the policy lists as bullets)', () => {
    const S = G.app.state;
    S.att = { policy: { g1: { resolved: { t1: { absence: 'excused' } }, defaults: {} } } };
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    G.app.teamFor = () => 't1';
    const opened = [];
    G.ui.openDialog = (html) => { opened.push(html); return null; };
    G.handlers.click['att-legend']();
    for (const o of A.OUTCOMES) assert(opened[0].includes('>' + A.OUTCOME_LABELS[o] + '<'), o);
    assert(opened[0].includes('Before joining') && opened[0].includes('id="dlg-title">Legend<') && opened[0].includes('>Close<'));
    G.handlers.click['att-how']();
    assert(opened[1].includes('How this is counted') && opened[1].includes('<ul class="gs-bullets">') && opened[1].includes('left out of the percentage'));
    S.att = {};
  });

  await check('hostile names and team names are escaped in both views', () => {
    const d = teamData();
    d.people[2].name = HOSTILE + QUOTES;
    d.watch.entries[0].name = HOSTILE + QUOTES;
    const rv = reviewData();
    rv.raids[0].items[0].name = HOSTILE + QUOTES;
    for (const out of [pageHtml({ data: d, review: rv }), gridPage({ data: d, review: rv }), pageHtml({ guildData: gd(OFFICER_CAN, { teams: [{ id: 't1', name: HOSTILE + QUOTES, size: 25, archived: false }, { id: 't2', name: 'B', size: 25, archived: false }] }) })]) {
      assert(!out.includes('<img src=x') && !out.includes(' onfocus="alert(1)"') && !/<script/i.test(out));
      for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
        const names = tag.replace(/="[^"]*"/g, '=""');
        assert(!/\sstyle=/i.test(names) && !/\son[a-z]+=/i.test(names), 'inline style or handler: ' + tag.slice(0, 80));
      }
    }
  });

  // ── stylesheet ──────────────────────────────────────────────
  await check('guild.css: the old matrix and card rules are gone, the new .gs-at-* rules and the sticky columns exist, the phone keeps 44 px targets, nothing is below 12 px', () => {
    for (const old of ['.gs-att-week', '.gs-att-col', '.gs-att-cell', '.gs-att-name', '.gs-att-stats', '.gs-att-card', '.gs-att-page', '.gs-table-att', '.gs-legend-box', '.gs-streak', '.gs-watch-']) assert(!css.includes(old), old + ' is still in guild.css');
    assert(css.includes('.gs-att-strip') && css.includes('.gs-att-teamblock'), 'the pages that still use them keep them');
    for (const cls of ['gs-at-page', 'gs-at-top', 'gs-at-pan', 'gs-at-row', 'gs-at-w', 'gs-at-a', 'gs-at-b', 'gs-at-rel', 'gs-at-rl', 'gs-at-strip', 'gs-at-pair', 'gs-at-bar', 'gs-at-scroll', 'gs-at-grid', 'gs-at-c-name', 'gs-at-c-pct', 'gs-fg-ghx']) assert(css.includes('.' + cls), cls);
    assert(/\.gs-at-grid \.gs-at-c-name \{[^}]*position: sticky; left: 0;/.test(css) && /\.gs-at-grid \.gs-at-c-pct \{[^}]*position: sticky; left: 176px;/.test(css));
    assert(/\.gs-at-scroll \{ overflow-x: auto;/.test(css));
    const mine = css.slice(css.indexOf('/* Attendance (Forge)'), css.indexOf('/* ── Loot on Forge'));
    assert(mine.length > 1000);
    for (const m of mine.matchAll(/font(?:-size)?:\s*(?:[0-9]{3}\s+)?([0-9.]+)px/g)) assert(Number(m[1]) >= 12, 'font below 12px: ' + m[0]);
    const phone = mine.slice(mine.indexOf('@media (width <= 600px)'));
    assert(/\.gs-at-bar \.gs-fg-seg \{[^}]*height: 44px/.test(phone) && /\.gs-at-await \{ order: -1; \}/.test(phone) && /\.gs-at-grid \.gs-cell[^{]*\{ width: 28px; \}/.test(phone));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
