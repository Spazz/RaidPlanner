/**
 * PartyPlanner Web - roster change report tests (ChangeLog + Changes panel)
 * Run: node changes-tests.js
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
const app = require('./tests/load-app');

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
  t.SignupTray.activeTab = 'absent'; t.SignupTray.chosen = true;
  t.SignupTray.render();
  const tabOf = id => section.innerHTML.match(new RegExp(`<button[^>]*data-tray-tab="${id}"[^>]*>[\\s\\S]*?</button>`))[0];
  assert.match(tabOf('tentative'), /tray-tab-dot/, 'the hidden Tentative tab holds a changed player');
  assert.match(tabOf('tentative'), /<span class="sr-only">, has changes<\/span>/);
  assert.doesNotMatch(tabOf('absent'), /tray-tab-dot/, 'the selected tab gets no dot');
  assert.doesNotMatch(tabOf('all'), /tray-tab-dot/, 'All never gets one');
  t.SignupTray.activeTab = 'tentative';
  t.SignupTray.render();
  assert.doesNotMatch(section.innerHTML, /tray-tab-dot/, 'nothing hidden, no dot');
  t.SignupTray.activeTab = 'all';
  t.SignupTray.render();
  assert.doesNotMatch(section.innerHTML, /tray-tab-dot/, 'All lists everyone, so no tab needs a dot');
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

check('the Changes button ends the action row as a hidden disclosure for the panel, with a badge', () => {
  const toolbar = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('<!-- Phone context row'));
  const button = toolbar.match(/<button[^>]*id="btn-changes"[^>]*>[\s\S]*?<\/button>/)[0];
  assert(toolbar.replace(/\r\n/g, '\n').trimEnd().endsWith(button + '\n  </div>'), 'last item of the toolbar'); // CRLF checkouts too
  assert.match(button, /aria-expanded="false"/);
  assert.match(button, /aria-controls="changes-log-panel"/);
  assert.match(button, / hidden>/);
  assert.match(button, /<span class="changes-count" id="changes-count" hidden><\/span>/);
  assert.match(html, /<button type="button" id="btn-phone-more"[^>]*>More <span class="changes-count" id="phone-more-changes-count" hidden><\/span><\/button>/);
});

check('the panel sits after the banners and before the summary bar, with its heading and Mark all seen', () => {
  const panelAt = html.indexOf('id="changes-log-panel"');
  assert(panelAt > html.indexOf('id="tab-conflict-banner"') && panelAt < html.indexOf('id="summary-bar"'));
  const panel = html.slice(panelAt, html.indexOf('</section>', panelAt));
  assert.match(panel, /aria-labelledby="changes-log-heading"/);
  assert.match(panel, /id="changes-log-heading" tabindex="-1">Recent changes</);
  assert.match(panel, /id="btn-changes-seen">Mark all seen</);
  assert.match(panel, /id="btn-changes-close">Close</, 'closable where it opens (phones open it from the More sheet)');
  assert.match(html, /<section class="changes-log-panel" id="changes-log-panel"[^>]*hidden>/);
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
  assert.match(app.script, /\.saved-roster-item'\)\.forEach[\s\S]{0,300}if \(Import\.loadRoster\(data\)\) \{\s*ChangeLog\.clear\(\);/);
  for (const id of ['btn-clear', 'btn-landing-empty', 'btn-random']) {
    const at = app.script.indexOf(`getElementById('${id}').addEventListener`);
    assert(app.script.slice(at, at + 700).includes('ChangeLog.clear()'), id);
  }
  // Optimize, undo/redo and the other-tab load never record.
  for (const [from, to] of [["getElementById('btn-optimize').addEventListener", "getElementById('btn-clear').addEventListener"], ['const TabWatch = {', "getElementById('btn-tab-load')"], ['const PlanSession = {', '\n};']]) {
    assert.doesNotMatch(app.slice(from, to), /ChangeLog\.(track|record)/, from);
  }
});

check('CSS: a changed slot is an inset ring (focus keeps the outline), coloured per kind', () => {
  const css = app.css;
  assert.match(css, /\.player-slot\.changed \{[^}]*box-shadow: inset[^}]*\}/);
  assert.doesNotMatch(css.match(/\.player-slot\.changed \{[^}]*\}/)[0], /outline/);
  for (const kind of ['benched', 'seated', 'status', 'moved', 'added']) assert.match(css, new RegExp(`\\.changed-${kind}\\s*\\{ --changed-color:`), kind);
  for (const kind of ChangeLog.KINDS) assert.match(css, new RegExp(`\\.changes-log-kind-${kind}\\s*\\{`), kind);
  assert.match(css, /\.player-slot\.changed\.dragging \{ opacity: 0\.3; \}/, 'a highlighted card still dims while dragged');
  const phone = css.slice(css.indexOf('#btn-phone-more .changes-count'));
  assert.match(phone.slice(0, 600), /#btn-changes-seen, #btn-changes-close, #changes-log-panel \.changes-log-more \{ min-height: 44px; \}/, 'phone tap targets');
  assert.match(css, /\.changes-log-more \{[^}]*min-height: 24px;/, 'the Show all toggle is a 24px target everywhere');
  // Focus must still read on a changed card, including a gold Status ring under the gold outline.
  const focus = css.match(/\.player-slot\.changed:focus-visible \{[^}]*\}/);
  assert(focus, 'changed cards restyle focus');
  assert.match(focus[0], /outline-color: var\(--text-primary\)/);
  assert.match(focus[0], /box-shadow: inset 0 0 0 4px var\(--changed-color/);
});

console.log(`\nChange report tests: ${passed} passed, 0 failed, ${passed} total`);
