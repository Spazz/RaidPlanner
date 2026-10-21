/**
 * Raidsmith - new sign-ups land on the plan; the pool files Tentative and Late under their own heads
 * Run: node tests/planner/signup-seat-tests.js
 *
 * User decisions 2026-10-21:
 *  1. A Raid-Helper sync seats its NEW Signed up sign-ups while the raid has a free seat, by re-running Optimize
 *     (Import.seatNewRaiders, driven from RaidHelperSync.apply). A full raid leaves them on the bench; Tentative, Late,
 *     Bench, Absent, Also-in and Standby sign-ups keep today's filing. One Undo step, a Changes entry, nothing on a
 *     sync without new sign-ups.
 *  2. Optimize never seats anyone who is already on the bench, except players a raid-size shrink parked
 *     (State.sizeBenched, the user kept that on purpose).
 *  3. The left pool shows Bench / Tentative / Late / Can't come heads; Tentative and Late are not Bench.
 * Capacity claims are tested on both sides of the boundary (13, 24 and 25 seated).
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const NAMES = ['State', 'Config', 'Import', 'ChangeLog', 'Optimizer', 'PlanSession', 'PlanStore', 'SizeBench', 'GameVersions', 'RaidHelperSync', 'toasts', 'results', 'nextUid'];
const harness = `
const toasts = [], results = [];
function showToast(m) { toasts.push(m); }
const ResultLine = { show(t) { results.push(t); }, hide() {} };
function initGroups() { const n = Config.Raids[State.selectedRaid].groups; while (State.groups.length < n) State.groups.push([]); return 0; }
function commit() { PlanSession.observe(); }
` + app.slice('const RaidHelperSync = {', "document.getElementById('btn-refresh').addEventListener");

// The pieces of render.js the pool needs (see changes-tests.js).
const poolSource = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel') + '\n' + app.slice('const SignupTray = {', 'const UnplacedDialog');

// Base roster: 2 tanks, 4 healers, the rest DPS cycling through four specs.
const DPS = [['Mage', 'Fire'], ['Rogue', 'Combat'], ['Hunter', 'Beastmastery'], ['Warlock', 'Affliction']];
function baseSignUps(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    if (i < 2) list.push({ name: 'Tank' + i, className: 'Tank', specName: 'Protection', id: i + 1 });
    else if (i < 6) list.push({ name: 'Heal' + i, className: 'Priest', specName: 'Holy1', id: i + 1 });
    else { const [c, s] = DPS[i % DPS.length]; list.push({ name: 'Dps' + i, className: c, specName: s, id: i + 1 }); }
  }
  return list;
}
const NEW_ONES = [
  { name: 'NewRogue', className: 'Rogue', specName: 'Combat', id: 901 },
  { name: 'NewHunter', className: 'Hunter', specName: 'Beastmastery', id: 902 },
  { name: 'NewLock', className: 'Warlock', specName: 'Affliction', id: 903 },
];

// A 25-man TBC plan holding `seated` sign-ups, already arranged, with the undo history started.
function planWith(seated) {
  const ctx = app.sandbox(NAMES, { extraSource: harness, globals: { document: { getElementById: () => null } } });
  const a = ctx.api;
  a.State.gameVersion = 'tbc';
  a.State.selectedRaid = 'bt';
  a.State.optimizerMode = 'max_dps';
  a.State.planId = 'plan:signup-seat';
  const signUps = baseSignUps(seated);
  const res = a.Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(res.success, 'fixture import: ' + res.error);
  initBoard(a);
  a.Optimizer.optimize();
  a.PlanSession.previous = null; a.PlanSession.undo = []; a.PlanSession.redo = []; a.PlanSession.ready = true;
  a.PlanSession.observe();
  a.ChangeLog.clear();
  a.ChangeLog.planId = 'plan:signup-seat';
  return { a, signUps };
}
function initBoard(a) {
  const n = a.Config.Raids[a.State.selectedRaid].groups;
  while (a.State.groups.length < n) a.State.groups.push([]);
  a.State.roster = a.State.groups.flat();
}
const names = list => Array.from(list, p => p.name).sort();
const layout = a => JSON.stringify(a.State.groups.map(g => g.map(p => p.name)));
// Optimize counted: wraps the optimizer so a test can see whether a sync ran it.
function countOptimize(a) {
  const counter = { n: 0 };
  const real = a.Optimizer.optimize;
  a.Optimizer.optimize = function (...args) { counter.n++; return real.apply(this, args); };
  return counter;
}
function sync(a, signUps) {
  const diff = a.Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(diff.success, diff.error);
  a.RaidHelperSync.apply(diff, 'Refreshed');
  return diff;
}

check('13 seated + 3 new Signed up: Optimize seats all three, one Changes entry each for the sync and the moves', () => {
  const { a, signUps } = planWith(13);
  assert.equal(a.State.roster.length, 13);
  sync(a, [...signUps, ...NEW_ONES]);
  assert.equal(a.State.roster.length, 16);
  assert.equal(a.State.bench.length, 0);
  for (const n of NEW_ONES) assert(a.State.roster.some(p => p.name === n.name && p.groupNumber >= 1), n.name + ' is in a group');
  const sync1 = a.ChangeLog.entries.find(e => e.kind === 'sync');
  assert(sync1, 'the sync is logged');
  const added = sync1.items.filter(it => it.kind === 'added');
  assert.equal(added.length, 3);
  assert(added.every(it => /^added to Group [1-5]$/.test(it.detail)), added.map(it => it.detail).join('|'));
  assert(a.toasts.some(t => /3 new sign-ups, 3 seated by Optimize/.test(t)), a.toasts.join(' | '));
});

check('24 seated + 3 new: the raid ends at 25 seated, the other two wait on the bench (the free seat is the boundary)', () => {
  const { a, signUps } = planWith(24);
  assert.equal(a.State.roster.length, 24);
  sync(a, [...signUps, ...NEW_ONES]);
  assert.equal(a.State.roster.length, 25);
  assert.equal(a.State.bench.length, 2);
  assert(a.State.groups.every(g => g.length <= 5));
  assert.equal(a.State.sizeBenched.length, 0, 'the overflow is not remembered as size-benched');
  assert.equal(names([...a.State.roster, ...a.State.bench]).length, 27);
});

check('25 seated + 2 new: both go to the bench, no Optimize runs, the groups are untouched', () => {
  const { a, signUps } = planWith(25);
  const before = layout(a);
  const counter = countOptimize(a);
  sync(a, [...signUps, NEW_ONES[0], NEW_ONES[1]]);
  assert.equal(counter.n, 0, 'Optimize did not run');
  assert.equal(layout(a), before);
  assert.deepEqual(names(a.State.bench), ['NewHunter', 'NewRogue']);
  assert.equal(a.ChangeLog.entries.length, 1, 'only the sync is logged');
  assert.equal(a.ChangeLog.entries[0].items.filter(it => it.kind === 'added').every(it => it.detail === 'added to the bench'), true);
});

check('a second sync with no new sign-ups changes nothing and does not run Optimize', () => {
  const { a, signUps } = planWith(13);
  sync(a, [...signUps, ...NEW_ONES]);
  const board = layout(a);
  const entries = a.ChangeLog.entries.length;
  const undoDepth = a.PlanSession.undo.length;
  const counter = countOptimize(a);
  const diff = sync(a, [...signUps, ...NEW_ONES]);
  assert.equal(diff.added.length, 0);
  assert.equal(counter.n, 0);
  assert.equal(layout(a), board);
  assert.equal(a.ChangeLog.entries.length, entries);
  assert.equal(a.PlanSession.undo.length, undoDepth, 'no new Undo step');
});

check('the automatic run is one Undo step and Undo restores the board from before the sync', () => {
  const { a, signUps } = planWith(13);
  const before = layout(a);
  const depth = a.PlanSession.undo.length;
  sync(a, [...signUps, ...NEW_ONES]);
  assert.equal(a.PlanSession.undo.length, depth + 1);
  assert(a.PlanSession.undoLast());
  assert.equal(layout(a), before);
  assert.equal(a.State.bench.length, 0);
  assert.equal(a.State.roster.length, 13);
});

check('new Tentative, Late, Bench, Absent, Also-in and Standby sign-ups are never seated', () => {
  const { a, signUps } = planWith(13);
  const counter = countOptimize(a);
  const others = [
    { name: 'MaybeMage', className: 'Tentative', specName: 'Fire', id: 910 },
    { name: 'LateRogue', className: 'Late', specName: 'Combat', id: 911 },
    { name: 'BenchLock', className: 'Bench', specName: 'Affliction', id: 912 },
    { name: 'AwayHunter', className: 'Absence', specName: 'Beastmastery', id: 913 },
    { name: 'AlsoMage', className: 'Mage', specName: 'Fire', id: 914, marker: { kind: 'also', text: 'Also in' } },
    { name: 'StandbyRogue', className: 'Rogue', specName: 'Combat', id: 915, marker: { kind: 'standby', text: 'Standby' } },
  ];
  sync(a, [...signUps, ...others]);
  assert.equal(counter.n, 0, 'nobody to seat, no Optimize');
  assert.equal(a.State.roster.length, 13);
  assert.deepEqual(names(a.State.bench), ['AlsoMage', 'BenchLock', 'LateRogue', 'MaybeMage', 'StandbyRogue']);
  assert.deepEqual(names(a.State.unplaced || []), ['AwayHunter']);
});

check('a mixed sync seats only the Signed up newcomer', () => {
  const { a, signUps } = planWith(13);
  sync(a, [...signUps, NEW_ONES[0], { name: 'MaybeMage', className: 'Tentative', specName: 'Fire', id: 910 }]);
  assert.equal(a.State.roster.length, 14);
  assert(a.State.roster.some(p => p.name === 'NewRogue'));
  assert.deepEqual(names(a.State.bench), ['MaybeMage']);
});

check('the automatic run is deterministic: two clients applying the same sync reach the same groups', () => {
  const one = planWith(13);
  const two = planWith(13);
  two.a.nextUid(); two.a.nextUid(); two.a.nextUid(); // another client hands out other uids
  sync(one.a, [...one.signUps, ...NEW_ONES]);
  sync(two.a, [...two.signUps, ...NEW_ONES]);
  assert.equal(layout(one.a), layout(two.a));
});

check('an unmodeled version falls back to the bench', () => {
  const { a } = planWith(13);
  a.GameVersions.fake = { name: 'Fake', modeled: false, raids: [] };
  a.State.gameVersion = 'fake';
  const newcomer = { uid: a.nextUid(), name: 'Late', class: 'ROGUE', spec: 'Combat', role: 'melee_dps', groupNumber: 0, signupStatus: 'confirmed' };
  a.State.bench.push(newcomer);
  const result = a.Import.seatNewRaiders([newcomer]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ran: false, seated: 0, benched: 1 });
  assert(a.State.bench.includes(newcomer));
});

check('Optimize never seats a player who is already on the bench (the button path)', () => {
  const { a } = planWith(13);
  const mage = { uid: a.nextUid(), name: 'HandBenched', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0, signupStatus: 'confirmed', imported: true };
  a.State.bench.push(mage);
  a.Optimizer.optimize();
  assert(a.State.bench.includes(mage), 'still on the bench with 12 free seats');
  assert.equal(a.State.roster.length, 13);
});

check('a sync seats its newcomers but leaves a confirmed player benched earlier on the bench (the automatic path)', () => {
  const { a, signUps } = planWith(13);
  const sitter = { uid: a.nextUid(), name: 'EarlierBench', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0, signupStatus: 'confirmed', imported: true };
  a.State.bench.push(sitter);
  sync(a, [...signUps, { name: 'EarlierBench', className: 'Mage', specName: 'Fire', id: 920 }, NEW_ONES[0]]);
  assert(a.State.bench.includes(sitter));
  assert(a.State.roster.some(p => p.name === 'NewRogue'));
});

check('a size-parked player is still an Optimize candidate while a hand-benched one in the same plan is not', () => {
  const { a } = planWith(13);
  const parked = { uid: a.nextUid(), name: 'Parked', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0, signupStatus: 'confirmed', imported: true };
  const hand = { uid: a.nextUid(), name: 'ByHand', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0, signupStatus: 'confirmed', imported: true };
  a.State.bench.push(parked, hand);
  a.SizeBench.remember([parked.uid]);
  a.Optimizer.optimize();
  assert(a.State.roster.includes(parked), 'the size-parked player is seated again');
  assert(a.State.bench.includes(hand), 'the hand-benched player is not');
});

check('the sync run does not pull a size-parked player either: only the new sign-ups join the pool', () => {
  const { a, signUps } = planWith(13);
  const parked = { uid: a.nextUid(), name: 'Parked', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0, signupStatus: 'confirmed', imported: true };
  a.State.bench.push(parked);
  a.SizeBench.remember([parked.uid]);
  sync(a, [...signUps, { name: 'Parked', className: 'Mage', specName: 'Fire', id: 930 }, NEW_ONES[0]]);
  assert(a.State.bench.includes(parked));
  assert(a.State.roster.some(p => p.name === 'NewRogue'));
});

// ── the pool ────────────────────────────────────────────────────────
function poolEnv() {
  const section = { style: {}, innerHTML: '' };
  const ctx = app.sandbox(['State', 'ChangeLog', 'SignupTray', 'nextUid'], {
    extraSource: poolSource,
    globals: { document: { getElementById: id => (id === 'bench-section' ? section : null), querySelector: () => null, activeElement: null }, sessionStorage: { getItem: () => null, setItem() {} } },
  });
  ctx.api.State.gameVersion = 'tbc';
  ctx.api.State.activeTab = 'plan';
  return { api: ctx.api, section };
}
const person = (api, name, status) => ({ uid: api.nextUid(), name, class: 'MAGE', spec: 'Fire', role: 'caster_dps', signupStatus: status, groupNumber: 0 });
const headsOf = html => [...html.matchAll(/<span class="gs-fg-ght">([^<]*)<\/span><span class="gs-fg-ghn">(\d+)<\/span>/g)].map(m => m[1] + ' ' + m[2]);
const pillCount = (html, id) => Number(html.match(new RegExp('data-pool-filter="' + id + '"[^>]*>[^<]*<span class="gs-fg-segn">(\\d+)'))[1]);

check('pool heads: Bench, Tentative, Late, Can\'t come in that order, each only with rows; the Bench count excludes Tentative and Late', () => {
  const { api, section } = poolEnv();
  api.State.groups = [[]];
  api.State.bench = [person(api, 'Benched1', 'bench'), person(api, 'Benched2', 'confirmed'), person(api, 'Maybe', 'tentative'), person(api, 'Tardy1', 'late'), person(api, 'Tardy2', 'late')];
  api.State.unplaced = [{ uid: api.nextUid(), name: 'Away', class: null, spec: null, role: null, signupStatus: 'absent' }];
  api.SignupTray.filter = 'all';
  api.SignupTray.render();
  assert.deepEqual(headsOf(section.innerHTML), ['Bench 2', 'Tentative 1', 'Late 2', "Can't come 1"]);
  assert.equal(pillCount(section.innerHTML, 'bench'), 2);
  assert.equal(pillCount(section.innerHTML, 'tentative'), 1);
  assert.equal(pillCount(section.innerHTML, 'late'), 2);
  assert.equal(pillCount(section.innerHTML, 'absent'), 1);
  assert.equal(pillCount(section.innerHTML, 'all'), 6);
  // The Tentative and Late rows carry no status chip (the head says it); a confirmed person on the Bench keeps "Signed up".
  const rowOf = name => section.innerHTML.split('<div class="player-slot').find(chunk => chunk.includes('>' + name + '<'));
  assert.doesNotMatch(rowOf('Maybe'), /Tentative<\/span>/);
  assert.doesNotMatch(rowOf('Tardy1'), /Late<\/span>/);
  assert.match(rowOf('Benched2'), /Signed up/);
  api.SignupTray.filter = 'bench';
  api.SignupTray.render();
  assert.deepEqual(headsOf(section.innerHTML), ['Bench 2']);
  api.SignupTray.filter = 'tentative';
  api.SignupTray.render();
  assert.deepEqual(headsOf(section.innerHTML), ['Tentative 1']);
});

check('pool heads: an empty head is not drawn', () => {
  const { api, section } = poolEnv();
  api.State.groups = [[]];
  api.State.bench = [person(api, 'Maybe', 'tentative')];
  api.State.unplaced = [];
  api.SignupTray.filter = 'all';
  api.SignupTray.render();
  assert.deepEqual(headsOf(section.innerHTML), ['Tentative 1']);
  assert.equal(pillCount(section.innerHTML, 'bench'), 0);
});

// ── the real board: seats left over are shown as suggested Open slots ────────────────
const autoSlots = a => Array.from(a.State.preferredSlots).filter(p => p.auto);
const NEW_ENH = { name: 'NewEnh', className: 'Shaman', specName: 'Enhancement', id: 940 };

check('13 seated + 12 suggested Open slots: a newcomer whose spec fits no suggestion is seated by Optimize (suggestions are not seated people)', () => {
  const { a, signUps } = planWith(13);
  assert.equal(autoSlots(a).length, 12, 'the board carries 12 suggestions');
  assert(!autoSlots(a).some(p => p.class === 'ROGUE' && p.spec === 'Combat'), 'no suggestion fits the newcomer');
  const counter = countOptimize(a);
  sync(a, [...signUps, NEW_ONES[0]]);
  assert.equal(counter.n, 1, 'Optimize ran');
  assert(a.State.roster.some(p => p.name === 'NewRogue' && p.groupNumber >= 1), 'seated, not benched');
  assert.equal(a.State.bench.length, 0);
  assert.equal(a.State.roster.length, 14);
});

check('24 seated + 1 suggested Open slot: still a free seat, so the newcomer is seated (the suggestion is not counted)', () => {
  const { a, signUps } = planWith(24);
  assert.equal(autoSlots(a).length, 1);
  sync(a, [...signUps, NEW_ONES[0]]);
  assert.equal(a.State.roster.length, 25);
  assert.equal(a.State.bench.length, 0);
});

check('13 seated + 12 suggestions: a newcomer that fits a suggestion takes that seat directly (no Optimize)', () => {
  const { a, signUps } = planWith(13);
  const slot = autoSlots(a).find(p => p.class === 'SHAMAN' && p.spec === 'Enhancement');
  assert(slot, 'the board suggests an Enhancement Shaman');
  const before = layout(a);
  const counter = countOptimize(a);
  sync(a, [...signUps, NEW_ENH]);
  assert.equal(counter.n, 0, 'Optimize did not run');
  const seat = a.State.roster.find(p => p.name === 'NewEnh');
  assert(seat && seat.groupNumber === slot.group + 1, "seated in the suggestion's group");
  assert.equal(autoSlots(a).length, 11, 'the suggestion was used up');
  assert.equal(a.State.bench.length, 0);
  assert.notEqual(layout(a), before);
  assert.equal(a.State.roster.length, 14);
});

check('25 real players seated: a newcomer that would fit a spec suggestion still goes to the bench', () => {
  const { a, signUps } = planWith(25);
  assert.equal(autoSlots(a).length, 0, 'a full raid suggests nothing');
  const before = layout(a);
  const counter = countOptimize(a);
  sync(a, [...signUps, NEW_ENH]);
  assert.equal(counter.n, 0);
  assert.equal(layout(a), before);
  assert.deepEqual(names(a.State.bench), ['NewEnh']);
});

console.log(`\nSign-up seat tests: ${passed} passed`);
