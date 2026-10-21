/**
 * PartyPlanner Web - roster change report tests (ChangeLog + Changes panel)
 * Run: node tests/planner/changes-tests.js
 *
 * js/changes.js diffs where everyone sits before and after a Raid-Helper sync, a raid
 * size change or a co-editor's live update, and keeps the result as a session-only log
 * the "Changes" button, the "Recent changes" panel and the card highlights read from.
 * These checks pin: the diff kinds (benched, seated, status, added, dropped, moved only
 * when asked), matching by uid then name, a missing status counting as Signed up, the
 * log's bookkeeping (empty diffs record nothing, newest first, unseen count, highlights,
 * markAllSeen, remove, clear, one log per plan), the raid size hook (undo/redo and the
 * ideal tab record nothing), the card/label/tray markup and the page wiring.
 * The live-update hook (poll + Undo) is covered in plan-state-tests.js next to its harness;
 * the sync hooks in tests.js next to the importFromText harness.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const ctx = app.sandbox(['State', 'ChangeLog', 'nextUid']);
const { State, ChangeLog, nextUid } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));
const mk = (name, over = {}) => Object.assign({ uid: nextUid(), name, class: 'MAGE', spec: 'Fire', role: 'caster_dps' }, over);

function seat(groups, bench = [], unplaced = []) {
  State.groups = groups;
  State.roster = groups.flat();
  State.bench = bench;
  State.unplaced = unplaced;
}
function reset(planId = 'plan:test') {
  ChangeLog.clear();
  ChangeLog.planId = planId;
  State.planId = planId;
  ChangeLog.onRecord = null;
}
const kinds = items => Array.from(items, i => `${i.kind} ${i.name}: ${i.detail}`);

// ── diff ────────────────────────────────────────────────────────────
check('snapshot lists seated players by group, then the bench, then unplaced; a missing status is Signed up', () => {
  const a = mk('A'), b = mk('B', { signupStatus: 'tentative' }), c = mk('C', { signupStatus: 'absent' });
  seat([[a], []], [b], [c]);
  const rows = ChangeLog.snapshot();
  assert.deepEqual(plain(rows.map(r => [r.name, r.loc, r.status, r.hasStatus])),
    [['A', 'g1', 'confirmed', false], ['B', 'bench', 'tentative', true], ['C', 'unplaced', 'absent', true]]);
});

check('diff reports benched (with the new status), seated, status, added and dropped', () => {
  const benched = mk('Benchy', { signupStatus: 'confirmed' }), seated = mk('Seaty', { signupStatus: 'bench' });
  const late = mk('Latey', { signupStatus: 'confirmed' }), gone = mk('Gone'), stay = mk('Stay');
  seat([[benched, late, gone], [stay]], [seated]);
  const before = ChangeLog.snapshot();
  benched.signupStatus = 'tentative';
  seated.signupStatus = 'confirmed';
  late.signupStatus = 'late';
  seat([[late, seated], [stay]], [benched, mk('Newbie', { signupStatus: 'tentative' })]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot())), [
    'benched Benchy: now Tentative, was in Group 1',
    'seated Seaty: now Signed up, in Group 1',
    'status Latey: Signed up to Late',
    'added Newbie: added to the bench, Tentative',
    'dropped Gone: was in Group 1',
  ]);
});

check('seated, added and dropped details name the place when the status did not change', () => {
  const p = mk('Waiter'), q = mk('Absentee', { signupStatus: 'absent' });
  seat([[]], [p], [q]);
  const before = ChangeLog.snapshot();
  seat([[p, mk('Fresh')]], [], [mk('Ghost', { signupStatus: 'absent' })]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot())), [
    'seated Waiter: now in Group 1',
    'added Fresh: added to Group 1',
    'added Ghost: added, Absent',
    'dropped Absentee: was not seated',
  ]);
});

check('group-to-group moves are reported only with {moves:true}', () => {
  const a = mk('Mover'), b = mk('Other');
  seat([[a], [b]]);
  const before = ChangeLog.snapshot();
  seat([[b], [a]]);
  const after = ChangeLog.snapshot();
  assert.deepEqual(plain(ChangeLog.diff(before, after)), []);
  assert.deepEqual(kinds(ChangeLog.diff(before, after, { moves: true })), ['moved Mover: Group 1 to Group 2', 'moved Other: Group 2 to Group 1']);
});

check('players are matched by uid first, then by name (a live update re-creates them)', () => {
  const a = mk('Same');
  seat([[a]]);
  const before = ChangeLog.snapshot();
  // Same name, new uid, new group: one moved player, not a drop plus an add.
  seat([[], [mk('Same')]]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot(), { moves: true })), ['moved Same: Group 1 to Group 2']);
  // A uid match wins over a name match: the renamed player is the same person.
  const b = mk('Before');
  seat([[b]]);
  const before2 = ChangeLog.snapshot();
  b.name = 'After';
  seat([[b]]);
  assert.deepEqual(plain(ChangeLog.diff(before2, ChangeLog.snapshot())), []);
});

check('two uid-less namesakes pair by place first, so their details do not cross', () => {
  seat([[], [mk('Twin', { signupStatus: 'confirmed' })]], [mk('Twin', { signupStatus: 'late' })]);
  const before = ChangeLog.snapshot();
  // Both re-created (fresh uids): Group 2 stays, the late one moves up into Group 1.
  // Pairing by name alone would match Group 2 with Group 1 and invent two changes.
  seat([[mk('Twin', { signupStatus: 'late' })], [mk('Twin', { signupStatus: 'confirmed' })]]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot(), { moves: true })), ['seated Twin: now in Group 1']);
});

check('a missing status equals Signed up; a status set where there was none is a backfill unless asked', () => {
  const a = mk('Unset'), b = mk('Unset2');
  seat([[a]], [b]);
  const before = ChangeLog.snapshot();
  a.signupStatus = 'confirmed';
  b.signupStatus = 'tentative';
  const after = ChangeLog.snapshot();
  assert.deepEqual(plain(ChangeLog.diff(before, after)), [], 'undefined -> confirmed is no change, undefined -> tentative is a backfill');
  assert.deepEqual(kinds(ChangeLog.diff(before, after, { ignoreBackfill: false })), ['status Unset2: Signed up to Tentative']);
  // And the other way: a share code that drops all-confirmed statuses changes nothing.
  const c = mk('Was', { signupStatus: 'confirmed' });
  seat([[c]]);
  const before2 = ChangeLog.snapshot();
  delete c.signupStatus;
  assert.deepEqual(plain(ChangeLog.diff(before2, ChangeLog.snapshot(), { ignoreBackfill: false })), []);
});

check('moving between the bench and unplaced is a status change, not a seat change', () => {
  const p = mk('Flaky', { signupStatus: 'tentative' });
  seat([[]], [p]);
  const before = ChangeLog.snapshot();
  p.signupStatus = 'absent';
  seat([[]], [], [p]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot())), ['status Flaky: Tentative to Absent']);
});

check('a benched player whose status was only backfilled still says why', () => {
  const p = mk('Legacy');
  seat([[p]]);
  const before = ChangeLog.snapshot();
  p.signupStatus = 'tentative';
  seat([[]], [p]);
  assert.deepEqual(kinds(ChangeLog.diff(before, ChangeLog.snapshot())), ['benched Legacy: now Tentative, was in Group 1']);
});

check('an unplaced player with no status counts as Absent, so a live re-import that sets it changes nothing', () => {
  const p = mk('Drifter');
  seat([[]], [], [p]);
  const before = ChangeLog.snapshot();
  p.signupStatus = 'absent';
  assert.deepEqual(plain(ChangeLog.diff(before, ChangeLog.snapshot(), { ignoreBackfill: false })), []);
});

check('a name two players share never highlights by name', () => {
  reset();
  const bobA = mk('Bob'), bobB = mk('Bob');
  seat([[bobA, bobB]]);
  const before = ChangeLog.snapshot();
  seat([[bobB]], [bobA]);
  const entry = ChangeLog.record('size', ChangeLog.diff(before, ChangeLog.snapshot()));
  assert.equal(entry.items.length, 1);
  assert.equal(ChangeLog.highlightFor(bobA).kind, 'benched');
  assert.equal(ChangeLog.highlightFor(bobB), null, 'the other Bob is untouched');
});

// ── the log ─────────────────────────────────────────────────────────
check('record keeps entries newest first, labels them by kind and records nothing for an empty diff', () => {
  reset();
  assert.equal(ChangeLog.record('sync', []), null);
  assert.equal(ChangeLog.entries.length, 0);
  const first = ChangeLog.record('sync', [{ kind: 'added', uid: 'p1', name: 'A', detail: '' }]);
  const second = ChangeLog.record('size', [{ kind: 'benched', uid: 'p2', name: 'B', detail: '' }], 'Raid size 25 to 10');
  assert.deepEqual(Array.from(ChangeLog.entries, e => e.id), [second.id, first.id]);
  assert.equal(first.label, 'Sign-up sync');
  assert.equal(second.label, 'Raid size 25 to 10');
  assert.equal(ChangeLog.record('live', [{ kind: 'moved', name: 'C' }]).label, 'Live link update');
  assert(typeof first.time === 'number' && first.seen === false);
});

check('the log holds at most MAX_ENTRIES entries', () => {
  reset();
  for (let i = 0; i < ChangeLog.MAX_ENTRIES + 5; i++) ChangeLog.record('sync', [{ kind: 'added', name: 'N' + i }]);
  assert.equal(ChangeLog.entries.length, ChangeLog.MAX_ENTRIES);
  assert.equal(ChangeLog.entries[0].items[0].name, 'N' + (ChangeLog.MAX_ENTRIES + 4), 'the oldest ones go');
});

check('unseen count, highlights (uid first, then name, latest wins, dropped never) and markAllSeen', () => {
  reset();
  ChangeLog.record('sync', [{ kind: 'benched', uid: 'p1', name: 'Alpha' }, { kind: 'dropped', uid: 'p9', name: 'Gone' }]);
  ChangeLog.record('live', [{ kind: 'moved', uid: 'p1', name: 'Alpha' }, { kind: 'added', uid: 'p5', name: 'Beta' }]);
  assert.equal(ChangeLog.unseenCount(), 4);
  assert.deepEqual(plain(ChangeLog.highlightFor({ uid: 'p1', name: 'Alpha' })), { kind: 'moved', word: 'Moved' }, 'the latest change wins');
  assert.deepEqual(plain(ChangeLog.highlightFor({ uid: 'p77', name: 'Beta' })), { kind: 'added', word: 'New' }, 'name fallback');
  assert.equal(ChangeLog.highlightFor({ uid: 'p9', name: 'Gone' }), null, 'a dropped player is not highlighted');
  assert.equal(ChangeLog.highlightFor({ uid: 'p3', name: 'Nobody' }), null);
  ChangeLog.markAllSeen();
  assert.equal(ChangeLog.unseenCount(), 0);
  assert.equal(ChangeLog.highlightFor({ uid: 'p1', name: 'Alpha' }), null);
  assert.equal(ChangeLog.entries.length, 2, 'seen entries stay listed');
  ChangeLog.record('sync', [{ kind: 'status', uid: 'p1', name: 'Alpha' }]);
  assert.equal(ChangeLog.unseenCount(), 1, 'a later change counts again');
  assert.equal(ChangeLog.highlightFor({ uid: 'p1' }).kind, 'status');
});

check('remove drops one entry and its highlights; clear empties the log', () => {
  reset();
  const keep = ChangeLog.record('sync', [{ kind: 'benched', uid: 'p1', name: 'A' }]);
  const undone = ChangeLog.record('live', [{ kind: 'moved', uid: 'p2', name: 'B' }]);
  assert(ChangeLog.highlightFor({ uid: 'p2' }));
  ChangeLog.remove(undone.id);
  assert.deepEqual(Array.from(ChangeLog.entries, e => e.id), [keep.id]);
  assert.equal(ChangeLog.highlightFor({ uid: 'p2', name: 'B' }), null);
  assert.equal(ChangeLog.unseenCount(), 1);
  ChangeLog.clear();
  assert.equal(ChangeLog.entries.length, 0);
  assert.equal(ChangeLog.highlightFor({ uid: 'p1', name: 'A' }), null);
});

check('the log belongs to one plan: recording on another planId starts it over', () => {
  reset('plan:one');
  ChangeLog.record('sync', [{ kind: 'added', name: 'A' }]);
  State.planId = 'plan:two';
  ChangeLog.record('sync', [{ kind: 'added', name: 'B' }]);
  assert.deepEqual(Array.from(ChangeLog.entries, e => e.items[0].name), ['B']);
  ChangeLog.forPlan('plan:two');
  assert.equal(ChangeLog.entries.length, 1, 'the same plan keeps its log');
  ChangeLog.forPlan('plan:three');
  assert.equal(ChangeLog.entries.length, 0);
});

check('track snapshots around the action, records the difference and hands back both', () => {
  reset();
  const p = mk('Tracked');
  seat([[p]]);
  const recorded = [];
  ChangeLog.onRecord = entry => recorded.push(entry.id);
  const out = ChangeLog.track('size', 'Raid size 25 to 10', () => { seat([[]], [p]); return 'done'; });
  assert.equal(out.result, 'done');
  assert.deepEqual(kinds(out.entry.items), ['benched Tracked: was in Group 1']);
  assert.deepEqual(recorded, [out.entry.id], 'onRecord hears each entry once');
  const none = ChangeLog.track('sync', 'Sign-up sync', () => 7);
  assert.deepEqual(plain(none), { result: 7, entry: null });
  assert.equal(recorded.length, 1, 'nothing changed, nothing recorded');
});

check('summary, kindCounts and ago describe an entry', () => {
  reset();
  const one = ChangeLog.record('sync', [{ kind: 'seated', name: 'A' }]);
  assert.equal(ChangeLog.summary(one), 'Sign-up sync: 1 change');
  const many = ChangeLog.record('size', [{ kind: 'benched', name: 'A' }, { kind: 'seated', name: 'B' }, { kind: 'benched', name: 'C' }], 'Raid size 25 to 10');
  assert.equal(ChangeLog.summary(many), 'Raid size 25 to 10: 3 changes');
  assert.deepEqual(plain(ChangeLog.kindCounts(many)), [{ kind: 'benched', word: 'Benched', count: 2 }, { kind: 'seated', word: 'Seated', count: 1 }]);
  const t = 1_000_000_000_000;
  assert.equal(ChangeLog.ago(t, t + 20_000), 'just now');
  assert.equal(ChangeLog.ago(t, t + 4 * 60_000), '4 min ago');
  assert.equal(ChangeLog.ago(t, t + 2 * 3_600_000), '2 h ago');
  assert.equal(ChangeLog.ago(t, t + 3 * 86_400_000), new Date(t).toLocaleDateString());
});

check('nothing about the log is saved or shared', () => {
  const source = app.slice('const ChangeLog = {', '// ── UI RENDERING');
  assert(!/localStorage|sessionStorage|safeSetItem/.test(source));
  assert(!/ChangeLog/.test(app.slice('const PlanStore = {', 'const Templates = {')), 'not part of saved plans');
  assert(!/ChangeLog/.test(app.slice('const Import = {', '// ── ')), 'not part of share codes');
});

// ── raid size hook ──────────────────────────────────────────────────
// The same sandbox as raidsize-tests.js's round trip: the real selectRaidSize/initGroups
// with a commit() that keeps the roster, the size list and PlanSession current.
function sizeEnv() {
  const g = { dataset: {}, buttons: [], contains: () => false, set innerHTML(v) { this.buttons = []; }, querySelector: () => null, querySelectorAll() { return []; } };
  const env = { commits: 0, toasts: [] };
  const sctx = app.sandbox(['State', 'SizeBench', 'PlanSession', 'ChangeLog', 'selectRaidSize', 'initGroups', 'commit', 'nextUid'], {
    globals: { document: { getElementById: id => (id === 'raid-size-control' ? g : null) }, __env: env },
    extraSource: 'function commit() { __env.commits++; State.roster = State.groups.flat(); SizeBench.prune(); PlanSession.observe(); }\n' +
      'function showToast(m) { __env.toasts.push(m); }\nfunction renderIdealComp() { __env.ideal = true; }\n' +
      app.slice('function renderRaidSizeControl', '(function initRaidSizeControl') +
      app.slice('function initGroups()', '// Role markers'),
  });
  const api = sctx.api;
  const p = (i, group) => ({ uid: api.nextUid(), name: 'R' + i, class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: group });
  Object.assign(api.State, { gameVersion: 'tbc', selectedRaid: 'bt', activeTab: 'plan', planId: 'plan:size', rosterName: 'Size', sizeBenched: [] });
  api.State.groups = [0, 1, 2, 3, 4].map(gi => [0, 1, 2, 3, 4].map(si => p(gi * 5 + si, gi + 1)));
  api.State.roster = api.State.groups.flat();
  api.State.bench = [];
  api.State.unplaced = [];
  api.PlanSession.previous = null; api.PlanSession.undo = []; api.PlanSession.redo = []; api.PlanSession.ready = true;
  api.PlanSession.observe();
  return { api, env };
}

check('a shrink logs everyone it benched; growing back logs them seated again', () => {
  const { api } = sizeEnv();
  api.selectRaidSize(10);
  const [shrink] = api.ChangeLog.entries;
  assert.equal(shrink.kind, 'size');
  assert.equal(shrink.label, 'Raid size 25 to 10');
  assert.equal(shrink.items.length, 15);
  assert(shrink.items.every(i => i.kind === 'benched' && /^was in Group [1-5]$/.test(i.detail)));
  api.selectRaidSize(25);
  assert.equal(api.ChangeLog.entries.length, 2);
  assert.equal(api.ChangeLog.entries[0].label, 'Raid size 10 to 25');
  assert.equal(api.ChangeLog.entries[0].items.length, 15);
  assert(api.ChangeLog.entries[0].items.every(i => i.kind === 'seated'));
});

check('undo and redo of a size change, the same size and the ideal tab log nothing', () => {
  const { api, env } = sizeEnv();
  api.selectRaidSize(10);
  assert.equal(api.ChangeLog.entries.length, 1);
  assert(api.PlanSession.undoLast()); api.initGroups(); api.commit();
  assert(api.PlanSession.redoLast()); api.initGroups(); api.commit();
  assert.equal(api.ChangeLog.entries.length, 1, 'undo/redo are not logged');
  api.selectRaidSize(10);
  assert.equal(api.ChangeLog.entries.length, 1, 'same size is a no-op');
  api.State.activeTab = 'ideal';
  api.selectRaidSize(25);
  assert(env.ideal, 'the ideal tab only redraws the ideal comp');
  assert.equal(api.ChangeLog.entries.length, 1, 'the ideal tab never touches the roster');
});

// ── cards, labels and the tray ───────────────────────────────────────
const slotSource = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel')
  + '\n' + app.slice('const SignupTray = {', 'const UnplacedDialog');
const uctx = app.sandbox(['State', 'Config', 'ChangeLog', 'nextUid', 'seatedSlotHTML', 'playerSlotLabel', 'SignupTray'], { extraSource: slotSource });
const ui = uctx.api;
ui.State.gameVersion = 'tbc';
const openTag = html => html.match(/^\s*<div[^>]*>/)[0];
const attr = (html, name) => { const m = html.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };

check('a changed seated player gets the changed class, a tag and a label suffix; others are untouched', () => {
  ui.ChangeLog.clear(); ui.State.planId = ui.ChangeLog.planId = 'plan:ui';
  const p = { uid: ui.nextUid(), name: 'Tarlox-Realm', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' };
  const plainHtml = ui.seatedSlotHTML(p, 0, 0);
  assert(!/\bchanged\b/.test(openTag(plainHtml)) && !/changed-tag/.test(plainHtml));
  assert.equal(attr(openTag(plainHtml), 'aria-label'), 'Tarlox, Fury Warrior, group 1', 'default label unchanged');
  ui.ChangeLog.record('live', [{ kind: 'moved', uid: p.uid, name: p.name }]);
  const html = ui.seatedSlotHTML(p, 0, 0);
  assert.match(attr(openTag(html), 'class'), /\bplayer-slot\b.*\bchanged changed-moved\b/);
  assert.match(html, /<span class="changed-tag" title="Changed: Moved">Moved<\/span>/);
  assert.equal(attr(openTag(html), 'aria-label'), 'Tarlox, Fury Warrior, group 1, changed: moved');
  ui.ChangeLog.markAllSeen();
  assert(!/\bchanged\b/.test(openTag(ui.seatedSlotHTML(p, 0, 0))), 'Mark all seen clears it');
});

check('bench and unplaced cards are highlighted too, and the tray dots a hidden tab holding a change', () => {
  ui.ChangeLog.clear();
  const benched = { uid: ui.nextUid(), name: 'Benchy', class: 'MAGE', spec: 'Fire', role: 'caster_dps', signupStatus: 'tentative' };
  const away = { uid: ui.nextUid(), name: 'Away', class: null, spec: null, role: null, signupStatus: 'absent' };
  ui.State.groups = [[]]; ui.State.bench = [benched]; ui.State.unplaced = [away]; ui.State.activeTab = 'plan';
  ui.ChangeLog.record('sync', [{ kind: 'benched', uid: benched.uid, name: 'Benchy' }, { kind: 'added', uid: away.uid, name: 'Away' }]);
  const benchHtml = ui.SignupTray.slotHTML({ p: benched, bi: 0, unplaced: false }, 'tentative');
  assert.match(openTag(benchHtml), /changed changed-benched/);
  assert.match(attr(openTag(benchHtml), 'aria-label'), /, changed: benched$/);
  const awayHtml = ui.SignupTray.slotHTML({ p: away, unplaced: true }, 'absent');
  assert.match(openTag(awayHtml), /changed changed-added/);
  assert.match(awayHtml, />New<\/span>/);

  const section = { style: {}, innerHTML: '' };
  const sctx = app.sandbox(['State', 'ChangeLog', 'SignupTray'], { extraSource: slotSource, globals: { document: { getElementById: id => (id === 'bench-section' ? section : null), querySelector: () => null } } });
  const t = sctx.api;
  t.State.gameVersion = 'tbc'; t.State.activeTab = 'plan'; t.State.planId = t.ChangeLog.planId = 'plan:ui';
  t.State.groups = [[]]; t.State.bench = [benched]; t.State.unplaced = [away];
  t.ChangeLog.record('sync', [{ kind: 'benched', uid: benched.uid, name: 'Benchy' }]);
  t.SignupTray.filter = 'absent';
  t.SignupTray.render();
  const pillOf = id => section.innerHTML.match(new RegExp('<button[^>]*data-pool-filter="' + id + '"[^>]*>[\\s\\S]*?</button>'))[0];
  assert.match(pillOf('tentative'), /gs-pb-dot/, 'the hidden Tentative pill holds a changed player');
  assert.match(pillOf('tentative'), /<span class="sr-only">, has changes<\/span>/);
  assert.match(pillOf('bench'), /gs-pb-dot/, 'Tentative is a subset of Bench, so Bench holds the change too');
  assert.doesNotMatch(pillOf('absent'), /gs-pb-dot/, 'the selected pill gets no dot');
  assert.doesNotMatch(pillOf('all'), /gs-pb-dot/, 'All never gets one');
  t.SignupTray.filter = 'tentative';
  t.SignupTray.render();
  assert.doesNotMatch(pillOf('tentative'), /gs-pb-dot/, 'the selected pill gets no dot');
  t.SignupTray.filter = 'all';
  t.SignupTray.render();
  assert.doesNotMatch(section.innerHTML, /gs-pb-dot/, 'All lists everyone, so no pill needs a dot');
});

// ── the panel ───────────────────────────────────────────────────────
const panelSource = app.slice('const ChangesPanel = {', '// A recorded change redraws');
function panelEnv() {
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, hidden: true, textContent: '', innerHTML: '', dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    scrollIntoView() {}, querySelector: () => null,
  });
  for (const id of ['btn-changes', 'changes-count', 'phone-more-changes-count', 'btn-phone-more', 'changes-log-panel', 'changes-log-list']) el(id);
  const pctx = app.sandbox(['State', 'ChangeLog', 'ChangesPanel'], { extraSource: panelSource + '\nfunction commit() {}', globals: { document: { getElementById: id => els[id] || null } } });
  return { els, api: pctx.api };
}

check('the button shows only while the log has entries; badges and labels count unseen changes', () => {
  const { els, api } = panelEnv();
  api.State.planId = api.ChangeLog.planId = 'plan:p';
  api.ChangesPanel.render();
  assert.equal(els['btn-changes'].hidden, true, 'empty log, no button');
  assert.equal(els['btn-phone-more'].attrs['aria-label'], undefined);
  api.ChangeLog.record('sync', [{ kind: 'added', name: 'A' }, { kind: 'benched', name: 'B' }]);
  api.ChangesPanel.render();
  assert.equal(els['btn-changes'].hidden, false);
  assert.equal(els['changes-count'].hidden, false);
  assert.equal(els['changes-count'].textContent, '2');
  assert.equal(els['phone-more-changes-count'].textContent, '2');
  assert.equal(els['btn-changes'].attrs['aria-label'], 'Changes, 2 unseen');
  assert.equal(els['btn-phone-more'].attrs['aria-label'], 'More, 2 unseen changes');
  api.ChangeLog.markAllSeen();
  api.ChangesPanel.render();
  assert.equal(els['btn-changes'].hidden, false, 'seen entries keep the button');
  assert.equal(els['changes-count'].hidden, true);
  assert.equal(els['btn-changes'].attrs['aria-label'], 'Changes');
  assert.equal(els['btn-phone-more'].attrs['aria-label'], undefined);
});

check('opening the panel flips aria-expanded and lists entries newest first, escaped, without inline styles', () => {
  const { els, api } = panelEnv();
  api.State.planId = api.ChangeLog.planId = 'plan:p';
  api.ChangeLog.record('sync', [{ kind: 'benched', name: '<img src=x>-Realm', detail: 'now Tentative, was in Group 1' }]);
  api.ChangeLog.record('live', [{ kind: 'moved', name: 'Mover', detail: 'Group 2 to Group 1' }]);
  api.ChangesPanel.setOpen(true);
  assert.equal(els['changes-log-panel'].hidden, false);
  assert.equal(els['btn-changes'].attrs['aria-expanded'], 'true');
  const html = els['changes-log-list'].innerHTML;
  assert(html.indexOf('Live link update') < html.indexOf('Sign-up sync'), 'newest first');
  assert.match(html, /<span class="sr-only">, not seen yet<\/span>/, 'unseen entries say so to a screen reader');
  assert.match(html, /<span class="changes-log-kind changes-log-kind-benched">Benched<\/span> <strong>&lt;img src=x&gt;<\/strong> <span class="changes-log-detail">- now Tentative, was in Group 1<\/span>/);
  assert.match(html, /changes-log-time">- just now</);
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i);
  api.ChangesPanel.setOpen(false);
  assert.equal(els['btn-changes'].attrs['aria-expanded'], 'false');
  api.ChangeLog.clear();
  api.ChangesPanel.setOpen(true);
  api.ChangesPanel.render();
  assert.equal(els['changes-log-panel'].hidden, true, 'an emptied log closes the panel');
});

check('a long entry lists counts per kind until "Show all" opens the full list', () => {
  const { els, api } = panelEnv();
  api.State.planId = api.ChangeLog.planId = 'plan:p';
  const items = Array.from({ length: 15 }, (_, i) => ({ kind: 'benched', name: 'P' + i, detail: 'was in Group 3' }));
  const entry = api.ChangeLog.record('size', items, 'Raid size 25 to 10');
  api.ChangesPanel.setOpen(true);
  let html = els['changes-log-list'].innerHTML;
  assert.match(html, /Benched<\/span> 15 players/);
  assert.doesNotMatch(html, /<strong>P0<\/strong>/);
  assert.match(html, new RegExp(`data-changes-expand="${entry.id}" aria-expanded="false">Show all 15<`));
  api.ChangesPanel.expanded.add(entry.id);
  api.ChangesPanel.render();
  html = els['changes-log-list'].innerHTML;
  assert.equal((html.match(/<strong>P\d+<\/strong>/g) || []).length, 15);
  assert.match(html, /aria-expanded="true">Hide the list</);
});

// ── page wiring ─────────────────────────────────────────────────────
const html = app.html;
check('changes.js is logic: after analysis.js, before render.js, without the UI marker', () => {
  const at = app.scripts.indexOf('/js/changes.js');
  assert(at > app.scripts.indexOf('/js/analysis.js') && at < app.scripts.indexOf('/js/render.js'));
  assert(!require('fs').readFileSync(require('path').join(app.ROOT, 'js/changes.js'), 'utf8').includes('// ── UI RENDERING'));
  assert(app.logic.includes('const ChangeLog = {'));
});

check('Changes is the first item of the More menu, a hidden disclosure for the panel with a badge; More carries the unseen count too', () => {
  const menu = html.slice(html.indexOf('id="settings-menu"'), html.indexOf('<button type="button" class="menu-item" role="menuitem" id="btn-raid-settings"'));
  const button = menu.match(/<button[^>]*id="btn-changes"[^>]*>[\s\S]*?<\/button>/)[0];
  assert(menu.replace(/\r\n/g, '\n').trimEnd().endsWith(button), 'first item of the More menu'); // CRLF checkouts too
  assert.match(button, /aria-expanded="false"/);
  assert.match(button, /aria-controls="changes-log-panel"/);
  assert.match(button, / hidden>/);
  assert.match(button, /<span class="changes-count" id="changes-count" hidden><\/span>/);
  assert.match(html, /<button type="button" class="gs-btn gs-pb-phonemore" id="btn-phone-more"[^>]*>More <span class="changes-count" id="phone-more-changes-count" hidden><\/span><\/button>/);
  assert.match(html, /More <span class="changes-count" id="more-changes-count" hidden><\/span>/);
});

check('the panel sits under the Raid check strip and before the board, with its heading and Mark all seen', () => {
  const panelAt = html.indexOf('id="changes-log-panel"');
  assert(panelAt > html.indexOf('id="raid-check"') && panelAt < html.indexOf('id="groups-container"'));
  const panel = html.slice(panelAt, html.indexOf('</section>', panelAt));
  assert.match(panel, /aria-labelledby="changes-log-heading"/);
  assert.match(panel, /id="changes-log-heading" tabindex="-1">Recent changes</);
  assert.match(panel, /id="btn-changes-seen">Mark all seen</);
  assert.match(panel, /id="btn-changes-close">Close</, 'closable where it opens (phones open it from the More sheet)');
  assert.match(html, /<section class="gs-hd-panel gs-pb-changes changes-log-panel" id="changes-log-panel"[^>]*hidden>/);
  assert.doesNotMatch(panel, /aria-live/, 'no new live region: announce() speaks for it');
});

check('phones move the button into the More sheet; the panel is plan-tab only', () => {
  assert(app.script.includes("'btn-changes:phone-sheet-quick-slot'"));
  assert.match(app.slice('function switchTab', '// Assignments is a dedicated'), /'changes-log-panel'/);
});

check('recording redraws through commit() and announces one line; Mark all seen redraws too', () => {
  const wiring = app.slice('ChangeLog.onRecord = entry => {', '(function initChangesPanel');
  assert.match(wiring, /commit\(\);/);
  assert.match(wiring, /const summary = ChangeLog\.summary\(entry\);/);
  // One write, so a seat or size change keeps the composition it replaced.
  assert.match(wiring, /announce\(reshaped && lastRaidSummary \? `\$\{summary\}\. \$\{lastRaidSummary\}` : summary\)/);
  assert.match(app.slice('const ChangesPanel = {', 'ChangeLog.onRecord'), /markAllSeen\(\) \{\s*ChangeLog\.markAllSeen\(\);\s*commit\(\);/);
  assert.match(app.slice('function renderGroups() {', 'function renderBuffCatalog'), /ChangesPanel\.render\(\);/);
  // Close hands focus back to whichever control opened the panel; a phone open moves focus in.
  const init = app.slice('(function initChangesPanel', '// Keeps "N min ago"');
  assert.match(init, /ChangesPanel\.el\('btn-changes-close'\)/);
  assert.match(init, /inSheet\(\) \? ChangesPanel\.el\('btn-phone-more'\) : button/);
  assert.match(init, /setTimeout\(\(\) => heading\.focus\(\), 0\)/);
});

check('hooks: sync, size and live are tracked; fresh imports and new plans clear the log', () => {
  assert.match(app.slice('  apply(diff, lead) {', '  showBanner(diff)'), /ChangeLog\.track\('sync', 'Sign-up sync'/);
  assert.match(app.slice('function selectRaidSize', '(function initRaidSizeControl'), /ChangeLog\.track\('size'/);
  assert.match(app.slice('function trackLiveUpdate', '// Swaps in'), /ChangeLog\.track\('live', 'Live link update', apply, \{ moves: true, ignoreBackfill: false \}\)/);
  assert.match(app.slice('  async pull() {', '  schedulePoll()'), /trackLiveUpdate\(/);
  assert.match(app.slice('async function loadFromShortLink', 'async function applyShareCode'), /trackLiveUpdate\(/);
  assert.match(app.slice('async function applyShareCode', "document.getElementById('btn-share')"), /ChangeLog\.clear\(\)/);
  // Reopening an import from history and loading a saved roster are fresh loads too.
  assert.match(app.script, /\[data-history-open\][\s\S]{0,300}Import\.loadRoster\(item\.roster\)\) \{[^}]*\}\s*ChangeLog\.clear\(\);/);
  assert.match(app.script, /\.saved-open'\)\.forEach[\s\S]{0,900}Import\.loadRoster\(data\)\) \{[^}]*\}\s*ChangeLog\.clear\(\);/);
  for (const id of ['btn-clear', 'btn-landing-empty', 'btn-random']) {
    const at = app.script.indexOf(`getElementById('${id}').addEventListener`);
    assert(app.script.slice(at, at + 700).includes('ChangeLog.clear()'), id);
  }
  // Optimize records through track(); undo/redo and the other-tab load never record.
  assert.match(app.slice("getElementById('btn-optimize').addEventListener", "getElementById('btn-clear').addEventListener"),
    /ChangeLog\.track\('optimize', 'Optimize', [\s\S]*\{ moves: true \}\)/);
  for (const [from, to] of [['const TabWatch = {', "getElementById('btn-tab-load')"], ['const PlanSession = {', '\n};']]) {
    assert.doesNotMatch(app.slice(from, to), /ChangeLog\.(track|record)/, from);
  }
});

// ── Optimize: buff reach, the Changes entry, Undo ────────────────────
// The real Optimize click handler, undoPlanChange and renderLastRun, with commit() reduced to
// "re-read the roster and let PlanSession observe", the way persistWorkingPlan does.
function optimizeHarness() {
  const els = {}, toasts = [], results = [], commits = { n: 0 };
  let handler = null, clearHandler = null;
  const document = { getElementById: id => els[id] || (els[id] = { id, innerHTML: '', addEventListener(ev, fn) { if (id === 'btn-optimize') handler = fn; if (id === 'btn-clear') clearHandler = fn; } }) };
  const extra = `
function showToast(m, o) { toasts.push({ m, o }); }
function commit() { State.roster = State.groups.flat(); commits.n++; PlanSession.observe(); }
${app.slice('function undoPlanChange', 'function redoPlanChange')}
${app.slice('function renderLastRun', "document.getElementById('btn-landing-empty')")}
`;
  const c = app.sandbox(['State', 'ChangeLog', 'PlanSession', 'Import', 'snapshotBuffReach', 'diffBuffReach', 'receivesBuff', 'undoPlanChange', 'PlanStore'], {
    globals: { toasts, commits, document, ResultLine: { show: t => results.push({ t, commits: commits.n }), hide() {} }, closePlayerEditor() {}, closeBuffPicker() {}, initGroups() {}, RaidHelperSync: { hideBanner() {} }, Modal: { confirm: async () => true } },
    extraSource: extra,
  });
  const api = c.api;
  const P = (name, cls, spec, role, g) => ({ name, class: cls, spec, role, groupNumber: g });
  assert(api.Import.loadRoster({ gameVersion: 'tbc', raid: 'bt', name: 'T', players: [
    P('Tanky', 'WARRIOR', 'Protection', 'tank', 1), P('Healy', 'PRIEST', 'Holy', 'healer', 1),
    P('Shammy', 'SHAMAN', 'Enhancement', 'melee_dps', 2), P('Mage1', 'MAGE', 'Fire', 'caster_dps', 2), P('Mage2', 'MAGE', 'Fire', 'caster_dps', 2),
    P('Fury1', 'WARRIOR', 'Fury', 'melee_dps', 3), P('Fury2', 'WARRIOR', 'Fury', 'melee_dps', 3), P('Rogue', 'ROGUE', 'Combat', 'melee_dps', 3), P('Ret', 'PALADIN', 'Retribution', 'melee_dps', 3),
  ] }));
  api.State.planId = 'plan:optimize';
  api.ChangeLog.clear();
  api.ChangeLog.planId = 'plan:optimize';
  api.ChangeLog.onRecord = null;
  const ps = api.PlanSession;
  ps.previous = null; ps.undo = []; ps.redo = []; ps.ready = true; ps.replaying = false; ps.observe();
  return { api, els, toasts, results, commits, click: () => handler(), clear: () => clearHandler(), undoPlanChange: () => api.undoPlanChange() };
}
const boardOf = api => JSON.stringify(api.State.groups.map(g => g.map(p => p.name)));

check('receivesBuff: Windfury reaches melee but never a Feral druid; a tank is credited through mitValueFor', () => {
  const { api } = optimizeHarness();
  const who = (cls, spec, role) => ({ uid: nextUid(), name: spec, class: cls, spec, role });
  assert.equal(api.receivesBuff('WINDFURY', who('WARRIOR', 'Fury', 'melee_dps')), true);
  assert.equal(api.receivesBuff('WINDFURY', who('DRUID', 'Feral', 'melee_dps')), false);
  assert.equal(api.receivesBuff('WINDFURY', who('MAGE', 'Fire', 'caster_dps')), false);
  assert.equal(api.receivesBuff('WINDFURY', null), false);
  // Devotion Aura has no DPS value, only a mitigation value: it counts for the tank and for nobody else.
  assert.equal(api.receivesBuff('DEVOTION_AURA', who('WARRIOR', 'Protection', 'tank')), true);
  assert.equal(api.receivesBuff('DEVOTION_AURA', who('WARRIOR', 'Protection', 'melee_dps')), false);
});

check('snapshotBuffReach counts recipients per buff by role, the source included when it receives', () => {
  const { api } = optimizeHarness();
  const reach = plain(api.snapshotBuffReach());
  assert.equal(reach.WINDFURY.name, 'Windfury Totem');
  assert.deepEqual(reach.WINDFURY.roles, { melee_dps: 1 }, 'the Enhancement shaman alone: the mages get nothing from Windfury');
  assert.deepEqual(reach.MANA_SPRING.roles, { caster_dps: 2 });
  assert.equal(reach.MANA_SPRING.uids.length, 2);
});

check('diffBuffReach: gains and losses with a role word, largest first, unchanged buffs left out', () => {
  const { api } = optimizeHarness();
  const side = (name, roles) => ({ name, roles, uids: Object.entries(roles).flatMap(([r, n]) => Array.from({ length: n }, (_, i) => r + i)) });
  const before = { WINDFURY: side('Windfury Totem', { melee_dps: 1 }), SHOUT: side('Battle Shout', { melee_dps: 4 }), SAME: side('Same', { healer: 2 }), MIX: side('Mix', { tank: 1 }) };
  const after = { WINDFURY: side('Windfury Totem', { melee_dps: 5 }), SHOUT: side('Battle Shout', { melee_dps: 2 }), SAME: side('Same', { healer: 2 }), MIX: side('Mix', { tank: 2, healer: 1 }), WOA: side('Wrath of Air Totem', { caster_dps: 3 }) };
  assert.deepEqual(plain(api.diffBuffReach(before, after)), [
    { id: 'WINDFURY', name: 'Windfury Totem', delta: 4, word: 'melee' },
    { id: 'WOA', name: 'Wrath of Air Totem', delta: 3, word: 'casters' },
    { id: 'SHOUT', name: 'Battle Shout', delta: -2, word: 'melee' },
    { id: 'MIX', name: 'Mix', delta: 2, word: 'players' },
  ].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)));
  assert.deepEqual(plain(api.diffBuffReach(before, before)), []);
  const words = { melee_dps: 'melee', caster_dps: 'casters', ranged_dps: 'ranged', healer: 'healers', tank: 'tanks' };
  for (const [role, word] of Object.entries(words)) {
    assert.equal(api.diffBuffReach({}, { B: side('B', { [role]: 2 }) })[0].word, word, role);
  }
});

check('an Optimize click records one optimize entry and one undo step, and offers Undo', () => {
  const h = optimizeHarness();
  const { ChangeLog, PlanSession } = h.api;
  const undoBefore = PlanSession.undo.length;
  h.click();
  assert.equal(ChangeLog.entries.length, 1);
  const entry = ChangeLog.entries[0];
  assert.equal(entry.kind, 'optimize');
  assert.equal(entry.label, 'Optimize');
  assert(entry.items.length > 0 && entry.items.every(it => it.kind === 'moved'));
  assert.equal(PlanSession.undo.length, undoBefore + 1);
  assert.equal(entry.undoRef, PlanSession.undo[PlanSession.undo.length - 1]);
  const toast = h.toasts.at(-1);
  assert.match(toast.m, /^Optimized: \d+ moved\./);
  assert.match(toast.m, /Windfury Totem \+\d+ melee/);
  assert.equal(toast.o.action.label, 'Undo');
  assert.match(h.els['last-run'].textContent, /^Last Optimize: \d+ moved, Windfury Totem \+\d+ melee/);
  // The result line repeats the toast sentence, set after the Optimize commit (that commit clears the line).
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].t, toast.m);
  assert.equal(h.results[0].commits, h.commits.n, 'no commit follows the result line');
});

check('the re-commit that onRecord runs after an Optimize adds no second undo step', () => {
  const h = optimizeHarness();
  const { PlanSession, ChangeLog, State } = h.api;
  let recommits = 0;
  ChangeLog.onRecord = () => { recommits++; State.roster = State.groups.flat(); PlanSession.observe(); };
  h.click();
  assert.equal(recommits, 1, 'onRecord ran its commit');
  assert.equal(PlanSession.undo.length, 1);
  assert(app.slice('ChangeLog.onRecord = entry => {', '(function initChangesPanel').includes('commit();'));
});

check('the toast Undo undoes the Optimize while its step is on top, and drops the entry', () => {
  const h = optimizeHarness();
  const before = boardOf(h.api);
  h.click();
  assert.notEqual(boardOf(h.api), before);
  h.toasts.at(-1).o.action.onClick();
  assert.equal(boardOf(h.api), before, 'the board is back');
  assert.equal(h.toasts.at(-1).m, 'Change undone');
  assert.equal(h.api.ChangeLog.entries.length, 0, 'the Optimize entry went with its step');
});

check('the toast Undo refuses once another change sits on top of the Optimize step', () => {
  const h = optimizeHarness();
  const { State, ChangeLog, PlanSession } = h.api;
  h.click();
  const entry = ChangeLog.entries[0];
  const undoToast = h.toasts.at(-1);
  State.groups[0][0].name = 'Renamed'; // a later edit
  State.roster = State.groups.flat();
  PlanSession.observe();
  const steps = PlanSession.undo.length, board = boardOf(h.api);
  undoToast.o.action.onClick();
  assert.equal(h.toasts.at(-1).m, 'Nothing to undo: the plan changed after Optimize');
  assert.equal(PlanSession.undo.length, steps);
  assert.equal(boardOf(h.api), board);
  assert.equal(ChangeLog.entries[0], entry, 'the entry stays');
});

check('undoPlanChange removes the entry whose step it pops, and only that one', () => {
  const h = optimizeHarness();
  const { ChangeLog, PlanSession, State } = h.api;
  h.click();
  assert.equal(ChangeLog.entries.length, 1);
  State.groups[0][0].name = 'Edited';
  State.roster = State.groups.flat();
  PlanSession.observe();
  h.undoPlanChange(); // pops the edit
  assert.equal(ChangeLog.entries.length, 1, 'the Optimize entry stays while its step is not the one popped');
  h.undoPlanChange(); // pops the Optimize step
  assert.equal(ChangeLog.entries.length, 0);
});

check('an Optimize that moves nothing says so, records nothing and offers no Undo', () => {
  const h = optimizeHarness();
  h.click();
  h.toasts.length = 0;
  h.click(); // the board is already optimal
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].m, 'Already optimal — nothing moved');
  assert.equal(h.toasts[0].o, undefined);
  assert.equal(h.api.ChangeLog.entries.length, 1, 'still only the first run');
});

check('an optimize entry records benched, seated and moved players; only benched and seated are loud', () => {
  reset();
  const a = mk('Mover'), b = mk('Sitter'), c = mk('Bencher'), d = mk('Seatee');
  seat([[a, c], [b]], [d]);
  const { entry } = ChangeLog.track('optimize', 'Optimize', () => {
    seat([[b], [a, d]], [c]);
  }, { moves: true });
  assert.deepEqual(plain(entry.items.map(i => i.kind + ' ' + i.name)).sort(), ['benched Bencher', 'moved Mover', 'moved Sitter', 'seated Seatee']);
  assert.equal(entry.label, 'Optimize');
  assert.equal(ChangeLog.unseenCount(), 2, 'moves are not counted');
  assert.equal(ChangeLog.highlightFor(a), null);
  assert.equal(ChangeLog.highlightFor(b), null);
  assert.equal(ChangeLog.highlightFor(c).kind, 'benched');
  assert.equal(ChangeLog.highlightFor(d).kind, 'seated');
  assert.equal(ChangeLog.summary(entry), 'Optimize: 2 changes');
  // The same moves under a live update stay loud.
  reset();
  seat([[a], []]);
  ChangeLog.track('live', 'Live link update', () => seat([[], [a]]), { moves: true });
  assert.equal(ChangeLog.unseenCount(), 1);
  assert.equal(ChangeLog.highlightFor(a).kind, 'moved');
});

check('an Optimize that only moves players announces nothing; with a bench change it announces that change', () => {
  const calls = { commit: 0, announce: [] };
  const wiring = app.slice('ChangeLog.onRecord = entry => {', '(function initChangesPanel');
  const c = app.sandbox(['ChangeLog'], { globals: { commit() { calls.commit++; }, announce: m => calls.announce.push(m), lastRaidSummary: '' }, extraSource: wiring });
  const log = c.api.ChangeLog;
  log.onRecord({ kind: 'optimize', label: 'Optimize', items: [{ kind: 'moved' }, { kind: 'moved' }] });
  assert.equal(calls.commit, 1);
  assert.deepEqual(calls.announce, []);
  log.onRecord({ kind: 'optimize', label: 'Optimize', items: [{ kind: 'moved' }, { kind: 'benched' }] });
  assert.deepEqual(calls.announce, ['Optimize: 1 change']);
});

check('Clear board asks first and a decline keeps the board', () => {
  const at = app.script.indexOf("getElementById('btn-clear').addEventListener('click', async () => {");
  assert(at >= 0, 'the handler is async');
  const body = app.script.slice(at, at + 700);
  assert.match(body, /Modal\.confirm\(\{\s*title: 'Clear the board\?',\s*message: 'Removes every player, your notes and your picks from this plan\. Undo brings it back\.',\s*confirmLabel: 'Clear board',\s*\}\)/);
  const declines = body.indexOf('if (!confirmed) return;');
  assert(declines > body.indexOf('Modal.confirm') && declines < body.indexOf('PlanStore.startFresh()') && declines < body.indexOf('ChangeLog.clear()'));
});

check('an Optimize that only resets buff overrides offers Undo, and Undo brings the overrides back', () => {
  const h = optimizeHarness();
  const { State, PlanSession } = h.api;
  h.click(); // now optimal
  State.buffOverrides = { WINDFURY: 'someone' };
  PlanSession.observe();
  h.toasts.length = 0;
  const board = boardOf(h.api), steps = PlanSession.undo.length;
  h.click();
  const toast = h.toasts.at(-1);
  assert.equal(toast.m, 'No moves needed. 1 buff override reset');
  assert.equal(toast.o.action.label, 'Undo');
  assert.equal(PlanSession.undo.length, steps + 1);
  assert.deepEqual(plain(State.buffOverrides), {});
  assert.equal(boardOf(h.api), board);
  toast.o.action.onClick();
  assert.deepEqual(plain(State.buffOverrides), { WINDFURY: 'someone' }, 'the overrides are back');
});

check('Optimize with nothing moved and no overrides still offers no Undo', () => {
  const h = optimizeHarness();
  h.click();
  h.toasts.length = 0;
  h.click();
  assert.equal(h.toasts.at(-1).m, 'Already optimal — nothing moved');
  assert.equal(h.toasts.at(-1).o, undefined);
});

(async () => {
  const h = optimizeHarness();
  const { State, PlanSession } = h.api;
  State.notes = 'Pull Gruul at 8';
  PlanSession.observe();
  const names = JSON.stringify(State.groups.flat().map(p => p.name).sort());
  await h.clear();
  assert.equal(State.groups.flat().length, 0, 'Clear emptied the groups');
  assert.equal(State.notes, '');
  h.undoPlanChange();
  assert.equal(JSON.stringify(State.groups.flat().map(p => p.name).sort()), names, 'Undo brings the players back');
  assert.equal(State.notes, 'Pull Gruul at 8', 'and the notes');
  passed++;
  console.log('PASS  Clear board then Undo restores the players and the notes');
})().catch(e => { console.error(e); process.exit(1); });

check('countsText: loud items per kind in KINDS order, status and new worded, Optimize moves left out', () => {
  const it = kind => ({ kind });
  const entry = items => ({ kind: 'sync', items: items.map(it) });
  assert.equal(ChangeLog.countsText(entry(['moved', 'seated', 'seated', 'benched', 'moved', 'moved'])), '1 benched, 2 seated, 3 moved');
  assert.equal(ChangeLog.countsText(entry(['status'])), '1 status change');
  assert.equal(ChangeLog.countsText(entry(['status', 'status', 'added', 'dropped'])), '2 status changes, 1 new, 1 dropped');
  assert.equal(ChangeLog.countsText({ kind: 'optimize', items: [it('moved'), it('moved'), it('benched')] }), '1 benched', 'quiet Optimize moves are not counted');
  assert.equal(ChangeLog.countsText({ kind: 'optimize', items: [it('moved')] }), '');
});

check('the sync result line and the co-editor banner both use countsText', () => {
  assert(app.script.includes('Sign-up sync: ${ChangeLog.countsText(entry)}'));
  assert(app.script.includes('Updated by someone else: ${counts}.'));
});

check('recording an Optimize entry replaces older ones, so sync and live entries keep their place', () => {
  reset();
  const a = mk('A'), b = mk('B');
  seat([[a], []], [b]);
  ChangeLog.track('sync', 'Sign-up sync', () => seat([[a, b], []]));
  for (let i = 0; i < 25; i++) {
    ChangeLog.track('optimize', 'Optimize', () => seat(i % 2 ? [[a, b], []] : [[a], [b]]), { moves: true });
  }
  assert.equal(ChangeLog.entries.filter(e => e.kind === 'optimize').length, 1);
  assert.equal(ChangeLog.entries.filter(e => e.kind === 'sync').length, 1, 'the sync entry is still listed');
});

check('diffBuffReach uses the singular role word for a change of one player', () => {
  const { api } = optimizeHarness();
  const side = (roles) => ({ name: 'B', roles, uids: Object.entries(roles).flatMap(([r, n]) => Array.from({ length: n }, (_, i) => r + i)) });
  const word = (before, after) => api.diffBuffReach({ B: side(before) }, { B: side(after) })[0].word;
  assert.equal(word({ tank: 2 }, { tank: 1 }), 'tank');
  assert.equal(word({ tank: 3 }, { tank: 1 }), 'tanks');
  assert.equal(word({}, { healer: 1 }), 'healer');
  assert.equal(word({}, { caster_dps: 1 }), 'caster');
  assert.equal(word({}, { melee_dps: 1 }), 'melee');
  assert.equal(word({}, { ranged_dps: 1 }), 'ranged');
  assert.equal(word({ tank: 1 }, { tank: 1, healer: 1 }), 'healer');
  assert.equal(word({}, { tank: 1, healer: 1 }), 'players');
  assert.equal(word({ tank: 1 }, { healer: 2 }), 'player', 'a mix of one player');
});

check('CSS: a changed slot is a neutral white inset ring (focus keeps the outline), never gold or orange', () => {
  const css = app.css;
  const ring = css.match(/\.player-slot\.changed \{[^}]*\}/)[0];
  assert.match(ring, /box-shadow: inset 0 0 0 2px var\(--hd-white\)/);
  assert.doesNotMatch(ring, /outline|accent-gold|warning|molten/);
  assert.doesNotMatch(css, /--changed-color/, 'no per-kind ring colours');
  assert.match(css, /\.player-slot\.changed\.dragging \{ opacity: 0\.3; \}/, 'a highlighted card still dims while dragged');
  const tag = css.match(/\.changed-tag \{[^}]*\}/g).pop();
  assert.match(tag, /color: var\(--hd-white\)/);
  assert.match(css, /\.gs-pb-changes \.gs-btn \{ min-height: 44px; \}/, 'phone tap targets');
  assert.match(css, /\.gs-pb-changes \.changes-log-more \{ min-height: 44px; \}/, 'the Show all toggle is a 44px target on phones');
  assert.doesNotMatch(css, /\.changes-log-kind-(benched|seated|status|moved|added)\s*\{/, 'the kind words are neutral ink');
  const focus = css.match(/\.player-slot\.changed:focus-visible \{[^}]*\}/);
  assert(focus, 'changed cards restyle focus');
  assert.match(focus[0], /box-shadow: inset 0 0 0 4px var\(--hd-white\)/);
});

setTimeout(() => console.log(`\nChange report tests: ${passed} passed, 0 failed, ${passed} total`), 50);
