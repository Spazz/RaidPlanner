/**
 * PartyPlanner Web - Raid size control tests (nav slim-down, 2026-10-09)
 * Run: node tests/planner/raidsize-tests.js
 *
 * The raid dropdown became a "Raid size" segmented control. The specific raid
 * still lives in State.selectedRaid (old plans and share links name one), so:
 *   - raidSizesFor() derives each version's sizes from its raid catalog
 *     (TBC 10|25, Classic 20|40, Forever 10|20|40; planning templates left out)
 *   - picking a size keeps a current raid of that size, else moves to the
 *     version's default raid when it has that size, else its first real raid
 *     of that size (raidForSize / selectRaidSize)
 *   - an old saved plan on a specific raid (SSC) loads with 25 selected
 *   - comp templates match by game version + raid SIZE, not raid key (a template
 *     saved on SSC shows on a Black Temple plan; old stored templates still work)
 *   - Optimize only runs Max DPS: an old plan's other strategy is forced to max_dps
 *   - the Assignments view is unreachable while ASSIGNMENTS_TAB_ENABLED is false
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// A fake #raid-size-control: innerHTML is parsed back into button records so
// aria-pressed and focus can be read the way the page would. `doc` tracks activeElement.
function fakeGroup(doc) {
  const group = {
    dataset: {}, buttons: [],
    set innerHTML(html) {
      this.buttons = [...html.matchAll(/data-raid-size="(\d+)"/g)].map(m => ({
        dataset: { raidSize: m[1] }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        focus() { if (doc) doc.activeElement = this; },
      }));
    },
    contains(el) { return this.buttons.includes(el); },
    querySelector(sel) { const m = /"(\d+)"/.exec(sel); return this.buttons.find(b => m && b.dataset.raidSize === m[1]) || null; },
    querySelectorAll() { return this.buttons; },
    addEventListener() {},
  };
  return group;
}

const document = { activeElement: null, getElementById: id => (id === 'raid-size-control' ? group : null) };
const group = fakeGroup(document);
const log = { commits: 0, inits: 0, ideal: 0, toasts: [] };
const STUBS = `
function initGroups() { __log.inits++; return 0; }
function commit() { __log.commits++; }
function showToast(m) { __log.toasts.push(m); }
function renderIdealComp() { __log.ideal++; }
`;
const ctx = app.sandbox(
  ['State', 'Config', 'GameVersions', 'PlanStore', 'raidSizesFor', 'raidForSize', 'raidSizeLabel', 'renderRaidSizeControl', 'selectRaidSize'],
  { globals: { document, __log: log }, extraSource: STUBS + app.slice('function renderRaidSizeControl', '(function initRaidSizeControl') },
);
const { State, Config, GameVersions, PlanStore, raidSizesFor, raidForSize, raidSizeLabel, renderRaidSizeControl, selectRaidSize } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));
const pressed = () => group.buttons.filter(b => b.attrs['aria-pressed'] === 'true').map(b => Number(b.dataset.raidSize));
const offered = () => group.buttons.map(b => Number(b.dataset.raidSize));

// ── (a) options per version ─────────────────────────────────────────
check('size options come from each version\'s raid catalog, templates left out', () => {
  assert.deepEqual(plain(raidSizesFor('tbc', 'bt')), [10, 25]);
  assert.deepEqual(plain(raidSizesFor('classic', 'mc')), [20, 40]);
  assert.deepEqual(plain(raidSizesFor('forever', 'f_ony')), [10, 20, 40]);
  assert.deepEqual(plain(raidSizesFor('nope', 'bt')), []);
});

check('a plan on a planning template whose size no real raid has still shows its size', () => {
  assert.deepEqual(plain(raidSizesFor('classic', 'classic10')), [10, 20, 40]);
  assert.deepEqual(plain(raidSizesFor('classic', 'classic20')), [20, 40]);
});

check('the control renders the active version\'s sizes with the current raid\'s size pressed', () => {
  State.gameVersion = 'classic'; State.selectedRaid = 'zg';
  renderRaidSizeControl();
  assert.deepEqual(offered(), [20, 40]);
  assert.deepEqual(pressed(), [20]);
  State.gameVersion = 'tbc'; State.selectedRaid = 'bt';
  renderRaidSizeControl();
  assert.deepEqual(offered(), [10, 25]);
  assert.deepEqual(pressed(), [25]);
});

check('a rebuild of the control keeps focus on the button for the current size', () => {
  State.gameVersion = 'classic'; State.selectedRaid = 'classic10'; State.activeTab = 'plan';
  renderRaidSizeControl();
  assert.deepEqual(offered(), [10, 20, 40]);
  document.activeElement = group.buttons[1]; // the user clicked 20
  selectRaidSize(20); // the template size disappears, so the buttons are rebuilt
  assert.deepEqual(offered(), [20, 40]);
  assert.equal(document.activeElement && document.activeElement.dataset.raidSize, '20');
  document.activeElement = null;
  State.gameVersion = 'tbc'; State.selectedRaid = 'bt';
  renderRaidSizeControl();
  assert.equal(document.activeElement, null, 'a rebuild without focus in the control does not steal focus');
});

// ── (b) picking a size ──────────────────────────────────────────────
check('picking a size prefers the version\'s default raid, else its first real raid of that size', () => {
  assert.equal(raidForSize('tbc', 10, 'bt'), 'kara', 'BT is 25-man, so 10 takes the first real 10-man raid');
  assert.equal(raidForSize('tbc', 25, 'kara'), 'bt', 'the TBC default (Black Temple) is 25-man');
  assert.equal(raidForSize('classic', 20, 'mc'), 'zg');
  assert.equal(raidForSize('classic', 40, 'zg'), 'mc');
  assert.equal(raidForSize('forever', 20, 'f_ony'), 'f_hyjal');
  assert.equal(raidForSize('forever', 10, 'f_ony'), 'f_barrow');
  assert.equal(raidForSize('tbc', 40, 'bt'), null, 'TBC has no 40-man raid');
  assert.equal(raidForSize('classic', 10, 'mc'), null, 'Classic has no real 10-man raid; the classic10 template is never picked');
});

check('BT -> 10 -> 25 lands back on Black Temple', () => {
  const ten = raidForSize('tbc', 10, 'bt');
  assert.equal(ten, 'kara');
  assert.equal(raidForSize('tbc', 25, ten), 'bt');
});

check('picking the current raid\'s size keeps that raid', () => {
  assert.equal(raidForSize('tbc', 25, 'ssc'), 'ssc');
  assert.equal(raidForSize('tbc', 10, 'za'), 'za');
  assert.equal(raidForSize('classic', 40, 'naxx'), 'naxx');
});

check('selectRaidSize refits the board and re-syncs the control; same size is a no-op', () => {
  State.gameVersion = 'tbc'; State.selectedRaid = 'bt'; State.activeTab = 'plan';
  log.commits = 0; log.inits = 0;
  selectRaidSize(25);
  assert.equal(State.selectedRaid, 'bt');
  assert.equal(log.commits, 0, 'nothing changes when the size already matches');
  selectRaidSize(10);
  assert.equal(State.selectedRaid, 'kara');
  assert.equal(log.inits, 1); assert.equal(log.commits, 1);
  assert.deepEqual(pressed(), [10]);
  selectRaidSize(25);
  assert.equal(State.selectedRaid, 'bt', 'back to 25 lands on the TBC default raid');
  assert.deepEqual(pressed(), [25]);
});

check('on the ideal comp view a size pick re-renders the ideal comp instead of the board', () => {
  State.gameVersion = 'tbc'; State.selectedRaid = 'bt'; State.activeTab = 'ideal';
  log.commits = 0; log.ideal = 0;
  selectRaidSize(10);
  assert.equal(State.selectedRaid, 'kara');
  assert.equal(log.ideal, 1); assert.equal(log.commits, 0);
  State.activeTab = 'plan';
});

// ── Size round trip: a shrink's bench comes back on the next grow ────
// commit() here does what the real one does for this feature: prune the list
// (reconcilePlan) and let PlanSession record the change (persistWorkingPlan).
function roundTripEnv() {
  const g = fakeGroup();
  const env = { commits: 0, toasts: [] };
  const rtCtx = app.sandbox(['State', 'SizeBench', 'PlanStore', 'PlanSession', 'selectRaidSize', 'initGroups', 'commit', 'nextUid'], {
    globals: { document: { getElementById: id => (id === 'raid-size-control' ? g : null) }, __env: env },
    extraSource: 'function commit() { __env.commits++; State.roster = State.groups.flat(); SizeBench.prune(); PlanSession.observe(); }\n' +
      'function showToast(m) { __env.toasts.push(m); }\nfunction renderIdealComp() {}\n' +
      app.slice('function renderRaidSizeControl', '(function initRaidSizeControl') +
      app.slice('function initGroups()', '// Role markers'),
  });
  const api = rtCtx.api;
  const mk = (i, group) => ({ uid: api.nextUid(), name: 'R' + i, class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: group });
  Object.assign(api.State, { gameVersion: 'tbc', selectedRaid: 'bt', activeTab: 'plan', planId: 'plan:rt', rosterName: 'Round trip', sizeBenched: [] });
  api.State.groups = [0, 1, 2, 3, 4].map(gi => [0, 1, 2, 3, 4].map(si => mk(gi * 5 + si, gi + 1)));
  api.State.roster = api.State.groups.flat();
  api.State.bench = [mk(99, 0)]; // benched by the leader before any size change
  api.PlanSession.previous = null; api.PlanSession.undo = []; api.PlanSession.redo = []; api.PlanSession.ready = true;
  api.PlanSession.observe();
  return { api, env };
}
const seatedCount = api => api.State.groups.flat().length;
const benchNames = api => plain(api.State.bench.map(p => p.name).sort());

check('25 -> 10 -> 25 seats everyone the shrink benched again; a deliberately benched player stays benched', () => {
  const { api, env } = roundTripEnv();
  api.selectRaidSize(10);
  assert.equal(seatedCount(api), 10);
  assert.equal(api.State.bench.length, 16, '15 benched by the shrink + the leader\'s own bench');
  assert.equal(api.State.sizeBenched.length, 15);
  api.selectRaidSize(25);
  assert.equal(api.State.selectedRaid, 'bt');
  assert.equal(seatedCount(api), 25, 'back to 25 seated');
  assert.deepEqual(benchNames(api), ['R99'], 'the leader-benched player stays on the bench');
  assert(api.State.groups.every(grp => grp.length <= 5));
  assert.equal(api.State.sizeBenched.length, 0);
  assert.match(env.toasts.at(-1), /15 players back in the raid/);
});

check('the list survives undo and redo: 25 -> 10, undo, undo, redo, then 25 re-seats', () => {
  const { api } = roundTripEnv();
  api.selectRaidSize(10);
  const undoStep = () => { assert(api.PlanSession.undoLast()); api.initGroups(); api.commit(); };
  const redoStep = () => { assert(api.PlanSession.redoLast()); api.initGroups(); api.commit(); };
  undoStep();
  assert.equal(api.State.selectedRaid, 'bt'); assert.equal(seatedCount(api), 25);
  assert.equal(api.PlanSession.undoLast(), false, 'nothing older to undo');
  redoStep();
  assert.equal(api.State.selectedRaid, 'kara'); assert.equal(seatedCount(api), 10);
  assert.equal(api.State.sizeBenched.length, 15, 'redo brings the list back with the board');
  api.selectRaidSize(25);
  assert.equal(seatedCount(api), 25);
  assert.deepEqual(benchNames(api), ['R99']);
});

check('the list survives a reload: the saved plan carries it and a fresh page re-seats', () => {
  const { api } = roundTripEnv();
  api.selectRaidSize(10);
  const saved = JSON.parse(JSON.stringify(api.PlanStore.capture()));
  assert.equal(saved.sizeBenched.length, 15, 'capture() writes the list into the saved plan');
  const fresh = roundTripEnv().api; // another page load
  fresh.State.sizeBenched = [];
  assert(fresh.PlanStore.restore(saved));
  assert.equal(fresh.State.sizeBenched.length, 15);
  fresh.selectRaidSize(25);
  assert.equal(seatedCount(fresh), 25);
  assert.deepEqual(benchNames(fresh), ['R99']);
});

check('a size-benched player who was swapped in and then benched by hand stays benched on the next grow (Vorren)', () => {
  const { api } = roundTripEnv();
  api.selectRaidSize(10);
  const vorren = api.State.bench.find(p => p.name === 'R12');
  vorren.name = 'Vorren';
  assert(api.State.sizeBenched.includes(vorren.uid));
  // Swap Vorren in for a seated player.
  const out = api.State.groups[0].pop();
  api.State.bench.splice(api.State.bench.indexOf(vorren), 1, out);
  out.groupNumber = 0; vorren.groupNumber = 1;
  api.State.groups[0].push(vorren);
  api.commit();
  assert(!api.State.sizeBenched.includes(vorren.uid), 'seated: off the list for good');
  // The leader benches Vorren again by hand.
  api.State.groups[0].splice(api.State.groups[0].indexOf(vorren), 1);
  vorren.groupNumber = 0; api.State.bench.push(vorren);
  api.commit();
  api.selectRaidSize(25);
  assert(api.State.bench.includes(vorren), 'Vorren stays benched');
  assert(api.State.bench.some(p => p.name === 'R99'));
  assert(api.State.bench.includes(out), 'the player swapped out by hand stays benched too');
  assert.equal(api.State.bench.length, 3);
  assert.equal(seatedCount(api), 23, 'every size-benched player is seated again');
});

check('the list is per plan: plans without it load empty, and a new plan starts empty', () => {
  const { api } = roundTripEnv();
  api.selectRaidSize(10);
  const old = JSON.parse(JSON.stringify(api.PlanStore.capture()));
  delete old.sizeBenched; old.planId = 'plan:old';
  assert(api.PlanStore.valid(old), 'a plan saved before the field existed is still valid');
  assert(api.PlanStore.restore(old));
  assert.deepEqual([...api.State.sizeBenched], [], 'no list: nothing to re-seat');
  api.selectRaidSize(25);
  assert.equal(seatedCount(api), 10);
  api.State.sizeBenched = ['p1'];
  api.PlanStore.startFresh();
  assert.deepEqual([...api.State.sizeBenched], []);
  assert.equal(api.PlanStore.valid({ ...old, sizeBenched: 'x' }), false, 'a malformed list is rejected');
});

// ── (c) old saved plans ─────────────────────────────────────────────
function oldPlan(extra) {
  return { planId: 'plan:old', groups: [[], [], [], [], []], bench: [], gameVersion: 'tbc', selectedRaid: 'ssc',
    rosterName: 'Old SSC night', optimizerMode: 'tank_mit', buffOverrides: {}, ...extra };
}

check('an old saved plan on Serpentshrine Cavern loads with 25 selected and keeps its raid', () => {
  assert(PlanStore.restore(oldPlan()), 'the old plan restores');
  assert.equal(State.selectedRaid, 'ssc');
  renderRaidSizeControl();
  assert.deepEqual(offered(), [10, 25]);
  assert.deepEqual(pressed(), [25]);
});

check('an old 10-man plan without gameVersion (Zul\'Aman) loads with 10 selected', () => {
  assert(PlanStore.restore(oldPlan({ gameVersion: undefined, selectedRaid: 'za', groups: [[], []] })));
  assert.equal(State.gameVersion, 'tbc');
  renderRaidSizeControl();
  assert.deepEqual(pressed(), [10]);
});

// ── (d) Max DPS only ────────────────────────────────────────────────
check('an old plan that stored another strategy is forced to max_dps', () => {
  for (const mode of ['tank_mit', 'balanced', 'relaxed']) {
    State.optimizerMode = 'max_dps';
    assert(PlanStore.restore(oldPlan({ optimizerMode: mode })));
    assert.equal(State.optimizerMode, 'max_dps', mode);
  }
});

check('the Optimize button runs Max DPS whatever the state says', () => {
  const handler = app.slice("document.getElementById('btn-optimize').addEventListener('click'", "document.getElementById('btn-clear')");
  assert.match(handler, /State\.optimizerMode = 'max_dps';\s*const overridesReset/);
  assert.doesNotMatch(app.script, /getElementById\('optimize-mode'\)/, 'the hidden strategy select is gone');
});

// ── Size wording replaces the hidden raid name ──────────────────────
check('raidSizeLabel and auto plan names use the size, not the raid name', () => {
  assert.equal(raidSizeLabel('bt'), '25-man');
  assert.equal(raidSizeLabel('mc'), '40-man');
  assert.equal(raidSizeLabel('nope'), 'Raid');
  State.gameVersion = 'tbc'; State.selectedRaid = 'ssc';
  const name = PlanStore.nameFor({}, '123');
  assert.match(name, /^25-man · Event 123 · /);
  assert.doesNotMatch(name, /Serpentshrine/);
});

// ── Comp templates match by raid size, not raid key ──────────────────
const tplCtx = app.sandbox(['State', 'Templates', 'nextUid']);
const T = tplCtx.api;
function memStorage(seed) {
  const data = { ...seed };
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, data };
}
function seatTen(raid) {
  T.State.gameVersion = 'tbc'; T.State.selectedRaid = raid;
  const classes = [['WARRIOR', 'Protection', 'tank'], ['PRIEST', 'Holy', 'healer'], ['MAGE', 'Fire', 'caster_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps']];
  const players = Array.from({ length: 10 }, (_, i) => {
    const [cls, spec, role] = classes[i % 5];
    return { uid: T.nextUid(), name: 'P' + i, class: cls, spec, role, groupNumber: (i % 5) + 1 };
  });
  T.State.groups = [[], [], [], [], []];
  players.forEach((p, i) => T.State.groups[i % 5].push(p));
  T.State.roster = T.State.groups.flat();
  T.State.bench = [];
}

check('a template saved on SSC lists and applies on a Black Temple plan (same size)', () => {
  const storage = memStorage();
  seatTen('ssc');
  assert(T.Templates.save(storage, 'SSC night', 'tbc', 'ssc').success);
  assert.deepEqual(plain(T.Templates.list(storage, 'tbc', 'bt').map(t => t.name)), ['SSC night']);
  assert(T.Templates.get(storage, 'SSC night', 'tbc', 'bt'), 'get finds it from a BT plan');
  seatTen('bt');
  const result = T.Templates.applyToState(storage, 'SSC night', 'tbc', 'bt');
  assert(result.success, result.error);
  assert.equal(result.matched, 10);
});

check('templates stay scoped by size and version: a 25-man template is not offered to 10-man or Classic plans', () => {
  const storage = memStorage();
  seatTen('bt');
  T.Templates.save(storage, 'BT comp', 'tbc', 'bt');
  assert.equal(T.Templates.list(storage, 'tbc', 'kara').length, 0);
  assert.equal(T.Templates.list(storage, 'classic', 'mc').length, 0);
  assert.equal(T.Templates.get(storage, 'BT comp', 'tbc', 'za'), null);
});

check('old stored templates (keyed by raid) keep working across raids of the same size', () => {
  const players = { p0: { name: 'P0', group: 0, role: 'tank' } };
  const storage = memStorage({ [T.Templates.key]: JSON.stringify({ tbc: { hyjal: { Old: { savedAt: 5, players } }, kara: { Small: { savedAt: 6, players } } } }) });
  assert.deepEqual(plain(T.Templates.list(storage, 'tbc', 'bt').map(t => t.name)), ['Old']);
  assert.deepEqual(plain(T.Templates.list(storage, 'tbc', 'za').map(t => t.name)), ['Small']);
  assert(T.Templates.delete(storage, 'Old', 'tbc', 'swp').success);
  assert.equal(T.Templates.list(storage, 'tbc', 'hyjal').length, 0, 'deleting from a same-size plan removes the stored copy');
});

// Two same-named templates on raids of the same size ("Main" on SSC and on TK).
const MAIN_SSC = { savedAt: 1, players: { a: { name: 'A', group: 0, role: 'tank' } } };
const MAIN_TK = { savedAt: 9, players: { a: { name: 'A', group: 0, role: 'tank' }, b: { name: 'B', group: 1, role: 'healer' } } };
const twoMains = () => memStorage({ [T.Templates.key]: JSON.stringify({ tbc: { ssc: { Main: MAIN_SSC }, tk: { Main: MAIN_TK } } }) });
const stored = storage => JSON.parse(storage.data[T.Templates.key]).tbc;

check('colliding names: the list shows every copy, extras labelled with their raid', () => {
  const list = plain(T.Templates.list(twoMains(), 'tbc', 'bt'));
  assert.deepEqual(list.map(t => [t.name, t.raid, t.label]), [
    ['Main', 'tk', 'Main'],
    ['Main', 'ssc', 'Main (Serpentshrine Cavern)'],
  ]);
  const onSsc = plain(T.Templates.list(twoMains(), 'tbc', 'ssc'));
  assert.deepEqual(onSsc.map(t => t.label).sort(), ['Main', 'Main (Tempest Keep)'], "the plan's own raid keeps the plain name");
});

check('colliding names: get and apply act on the copy they are pointed at', () => {
  const storage = twoMains();
  assert.equal(T.Templates.get(storage, 'Main', 'tbc', 'bt', 'ssc').savedAt, 1);
  assert.equal(T.Templates.get(storage, 'Main', 'tbc', 'bt', 'tk').savedAt, 9);
  assert.equal(T.Templates.get(storage, 'Main', 'tbc', 'bt'), null, 'ambiguous without a raid key: nothing is guessed');
  assert.equal(T.Templates.get(storage, 'Main', 'tbc', 'bt', 'kara'), null, 'a 10-man key is never reachable from a 25-man plan');
});

check('colliding names: delete removes exactly one copy', () => {
  const storage = twoMains();
  assert(T.Templates.delete(storage, 'Main', 'tbc', 'bt', 'ssc').success);
  assert.deepEqual(plain(stored(storage).ssc), {});
  assert.equal(stored(storage).tk.Main.savedAt, 9, 'the TK copy is untouched');
  const ambiguous = twoMains();
  T.Templates.delete(ambiguous, 'Main', 'tbc', 'bt');
  assert.equal(ambiguous.data[T.Templates.key], twoMains().data[T.Templates.key], 'an ambiguous delete writes nothing');
});

check('colliding names: rename renames exactly one copy and never merges', () => {
  const storage = twoMains();
  assert(T.Templates.rename(storage, 'Main', 'Main SSC', 'tbc', 'bt', 'ssc').success);
  assert.equal(stored(storage).ssc['Main SSC'].savedAt, 1);
  assert(!stored(storage).ssc.Main);
  assert.equal(stored(storage).tk.Main.savedAt, 9, 'the TK copy keeps its name and data');
  assert.equal(T.Templates.rename(storage, 'Main SSC', 'Main', 'tbc', 'bt', 'ssc').success, false, 'renaming onto a same-size name is refused');
  assert.equal(stored(storage).ssc['Main SSC'].savedAt, 1, 'a refused rename changes nothing');
});

check('saving a name: one same-size match is overwritten, none writes under the plan key', () => {
  const storage = memStorage({ [T.Templates.key]: JSON.stringify({ tbc: { ssc: { Main: MAIN_SSC } } }) });
  seatTen('bt');
  T.Templates.save(storage, 'Main', 'tbc', 'bt');
  assert.equal(stored(storage).ssc.Main.savedAt > 1, true, 'the only match (SSC) is overwritten');
  assert(!stored(storage).bt, 'no second copy appears under BT');
  T.Templates.save(storage, 'Fresh', 'tbc', 'bt');
  assert(stored(storage).bt.Fresh, 'a new name goes under the plan key');
});

check('saving a name with several matches: overwrite the plan-key copy, else add one under the plan key', () => {
  seatTen('ssc');
  const onSsc = twoMains();
  T.Templates.save(onSsc, 'Main', 'tbc', 'ssc');
  assert.equal(Object.keys(stored(onSsc).ssc.Main.players).length, 10, 'the SSC copy (plan key) is overwritten');
  assert.equal(stored(onSsc).tk.Main.savedAt, 9, 'the TK copy is untouched');
  seatTen('bt');
  const onBt = twoMains();
  T.Templates.save(onBt, 'Main', 'tbc', 'bt');
  assert.equal(stored(onBt).ssc.Main.savedAt, 1, 'SSC untouched');
  assert.equal(stored(onBt).tk.Main.savedAt, 9, 'TK untouched');
  assert(stored(onBt).bt.Main, 'a new copy is written under BT');
  assert.equal(T.Templates.list(onBt, 'tbc', 'bt').length, 3);
});

check('apply with a raid key seats from that copy', () => {
  const storage = twoMains();
  seatTen('bt');
  const result = T.Templates.applyToState(storage, 'Main', 'tbc', 'bt', 'tk');
  assert(result.success, result.error);
  assert.equal(T.Templates.applyToState(storage, 'Main', 'tbc', 'bt').success, false, 'ambiguous apply is refused, not guessed');
});

// ── (e) Assignments is unreachable ──────────────────────────────────
check('the Assignments view cannot be opened: no tab, switchTab lands on the plan, no 2 shortcut', () => {
  const stub = () => ({ hidden: false, style: {}, focus() {} });
  const elements = {};
  const doc = {
    getElementById: id => elements[id] || (elements[id] = stub()),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const env = { inits: 0, commits: 0 };
  const tabCtx = app.sandbox(['State', 'ASSIGNMENTS_TAB_ENABLED', 'switchTab', 'SHORTCUTS_HELP'], {
    globals: { document: doc, __env: env },
    extraSource: 'function initGroups() { __env.inits++; }\nfunction commit() { __env.commits++; }\nfunction renderIdealComp() {}\nfunction esc(s) { return s; }\n' +
      app.slice('function switchTab(tab)', 'function renderIdealComp()') +
      app.slice('const SHORTCUT_BUTTONS', 'function showShortcutsHelp()'),
  });
  const api = tabCtx.api;
  assert.equal(api.ASSIGNMENTS_TAB_ENABLED, false);
  api.State.activeTab = 'ideal';
  api.switchTab('assignments');
  assert.equal(api.State.activeTab, 'plan', 'asking for Assignments lands on the plan');
  assert.equal(elements['reference-banner'].hidden, true);
  assert.equal(env.commits, 1, 'the plan board renders');
  assert(!api.SHORTCUTS_HELP.some(([keys]) => keys === '2'), 'the help list has no 2 shortcut');
  assert.match(app.script, /if \(k === '2' && ASSIGNMENTS_TAB_ENABLED\)/, 'the 2 key is gated by the flag');
  assert.doesNotMatch(app.html, /data-tab="assignments"|class="mode-tabs"/, 'no Plan | Assignments tab bar');
  assert.match(app.script, /function renderAssignments\(\)/, 'the Assignments rendering code is kept for later');
});

// ── (e) Optimize after a shrink plans the board plus the players the shrink benched ─────────────────────────────
// The user's flow, deterministic: a 40-man whose first four groups hold 2 tanks and 7 healers, Raid size 20, Optimize.
// The shrink benches groups 5-8 by position; Optimize must still decide who sits from all 40 (floors, healer cap,
// value), the way an import does, and never touch anyone the leader benched by hand.
const sizeCtx = app.sandbox(
  ['State', 'Config', 'RosterEdit', 'SizeBench', 'ChangeLog', 'Optimizer', 'nextUid', 'initGroups', 'selectRaidSize'],
  {
    globals: { document, __log: log },
    extraSource: 'function commit() { State.roster = State.groups.flat(); SizeBench.prune(); }\n'
      + 'function showToast(m) { __log.toasts.push(m); }\nfunction renderIdealComp() {}\n'
      + app.slice('function renderRaidSizeControl', '(function initRaidSizeControl') + app.slice('function initGroups()', '// Role markers'),
  },
);
const sz = sizeCtx.api;

// Players from [count, CLASS, Spec] lists; the role comes from the ruleset, like an import.
function makePlayers(list) {
  return list.flatMap(([count, cls, spec]) => Array.from({ length: count }, () => ({
    uid: sz.nextUid(), name: `${cls}-${spec}-${sz.nextUid()}`, class: cls, spec, role: sz.RosterEdit.RoleForSpec(cls, spec),
  })));
}
// The first four groups (the ones a 20-man keeps) get `kept`, the other four `rest`; each is 5-wide in list order.
function stageBoard(version, raid, kept, rest) {
  Object.assign(sz.State, {
    gameVersion: version, selectedRaid: raid, activeTab: 'plan', planId: 'plan:sizebench', rosterName: 'Sizebench', sizeBenched: [],
    bench: [], unplaced: [], preferredSlots: [], playerConstraints: [], drummers: [], buffOverrides: {},
  });
  const all = kept.concat(rest);
  assert.equal(all.length, 40);
  sz.State.groups = [0, 1, 2, 3, 4, 5, 6, 7].map(gi => all.slice(gi * 5, gi * 5 + 5));
  sz.State.groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  sz.State.roster = sz.State.groups.flat();
}
const roleCount = (players, role) => players.filter(p => p.role === role).length;
const seatedPlayers = () => sz.State.groups.flat();
const uids = list => list.map(p => p.uid);

// Strong healers (six Restoration Shamans) and plain DPS (Arms, Subtlety, Arcane), so that without the Forever healer
// cap the plan seats 6 or more healers; the cap holds it to the floor of 4.
function foreverRoster() {
  const tanks = makePlayers([[5, 'WARRIOR', 'Protection']]);
  const healers = makePlayers([[6, 'SHAMAN', 'Restoration'], [2, 'PALADIN', 'Holy'], [2, 'PRIEST', 'Holy'], [1, 'DRUID', 'Restoration']]);
  const dps = makePlayers([
    [4, 'WARRIOR', 'Arms'], [3, 'ROGUE', 'Subtlety'], [2, 'PALADIN', 'Retribution'], [1, 'SHAMAN', 'Enhancement'], [1, 'DRUID', 'Feral'],
    [2, 'HUNTER', 'Marksmanship'], [1, 'HUNTER', 'Survival'], [3, 'MAGE', 'Arcane'], [2, 'MAGE', 'Fire'],
    [2, 'WARLOCK', 'Destruction'], [1, 'WARLOCK', 'Affliction'], [1, 'SHAMAN', 'Elemental'], [1, 'PRIEST', 'Shadow'],
  ]);
  assert.deepEqual([tanks.length, healers.length, dps.length], [5, 11, 24]);
  // Groups 1-4 keep 2 tanks, 7 healers and 11 DPS (the user's case); groups 5-8 hold the rest.
  return {
    kept: tanks.slice(0, 2).concat(healers.slice(0, 7), dps.slice(0, 11)),
    rest: tanks.slice(2).concat(healers.slice(7), dps.slice(11)),
  };
}

// Shrink exactly as selectRaidSize does, then Optimize and commit.
function shrinkAndOptimize(version, from, to, handBench) {
  const roster = version === 'forever' ? foreverRoster() : classicRoster();
  stageBoard(version, from, roster.kept, roster.rest);
  sz.selectRaidSize(20);
  assert.equal(sz.State.selectedRaid, to);
  let hand = null;
  if (handBench) {
    hand = sz.State.groups[3].find(p => p.role === 'melee_dps');
    sz.State.groups[3].splice(sz.State.groups[3].indexOf(hand), 1);
    sz.State.bench.push(hand);
    hand.groupNumber = 0;
    sz.State.roster = sz.State.groups.flat();
  }
  const afterShrink = { board: seatedPlayers().slice(), benched: sz.State.bench.slice(), remembered: sz.State.sizeBenched.slice() };
  sz.Optimizer.optimize();
  sz.State.roster = sz.State.groups.flat();
  sz.SizeBench.prune();
  return { afterShrink, hand };
}
function assertBenchInvariants(afterShrink, hand) {
  const seated = seatedPlayers(), bench = sz.State.bench;
  const everyone = afterShrink.board.concat(afterShrink.benched);
  assert.equal(seated.length, 20);
  assert.equal(bench.length, 20);
  assert.equal(new Set(uids(seated).concat(uids(bench))).size, 40, 'no player appears twice across board and bench');
  assert.deepEqual(plain([...uids(seated), ...uids(bench)].sort()), plain(uids(everyone)).sort(), 'nobody was lost or added');
  assert.deepEqual(plain(uids(sz.State.roster)), plain(uids(seated)), 'the roster is the board');
  // Everyone on the bench is remembered (so a later grow seats them), except the player benched by hand.
  const remembered = new Set(sz.State.sizeBenched);
  for (const p of bench) assert.equal(remembered.has(p.uid), p !== hand, `${p.name}: remembered unless benched by hand`);
}

check('Forever 40 -> 20 then Optimize decides who sits from all 40: 2 tanks, 4 healers (the cap at the floor), 14 DPS', () => {
  const { afterShrink, hand } = shrinkAndOptimize('forever', 'f_ony', 'f_hyjal', false);
  assert.equal(afterShrink.board.length, 20);
  assert.equal(roleCount(afterShrink.board, 'healer'), 7, 'the shrink leaves the first four groups, with their 7 healers');
  assert.equal(afterShrink.remembered.length, 20, 'the 20 benched players are all remembered');
  assert.equal(hand, null);
  const seated = seatedPlayers();
  assert.deepEqual(
    [roleCount(seated, 'tank'), roleCount(seated, 'healer'), seated.length - roleCount(seated, 'tank') - roleCount(seated, 'healer')],
    [2, 4, 14],
  );
  assertBenchInvariants(afterShrink, hand);
});

check('a player benched by hand stays benched through Optimize; growing back seats only the size-benched', () => {
  const { afterShrink, hand } = shrinkAndOptimize('forever', 'f_ony', 'f_hyjal', true);
  assert(hand && !sz.State.sizeBenched.includes(hand.uid), 'the hand-benched player was never remembered');
  const seated = seatedPlayers();
  assert.deepEqual(
    [roleCount(seated, 'tank'), roleCount(seated, 'healer'), seated.length - roleCount(seated, 'tank') - roleCount(seated, 'healer')],
    [2, 4, 14],
  );
  assert(sz.State.bench.includes(hand), 'still on the bench');
  assert(!seated.includes(hand));
  assert(!sz.State.sizeBenched.includes(hand.uid), 'and still not remembered');
  assertBenchInvariants(afterShrink, hand);
  sz.selectRaidSize(40);
  assert.equal(sz.State.selectedRaid, 'f_ony');
  assert.deepEqual(plain(uids(sz.State.bench)), [hand.uid], 'only the hand-benched player is left on the bench');
  assert.deepEqual(plain(sz.State.sizeBenched), [], 'everyone remembered is seated again');
  assert.equal(seatedPlayers().length, 39);
});

function classicRoster() {
  const tanks = makePlayers([[4, 'WARRIOR', 'Protection'], [1, 'DRUID', 'Guardian']]);
  const healers = makePlayers([[4, 'SHAMAN', 'Restoration'], [4, 'PRIEST', 'Holy'], [3, 'DRUID', 'Restoration']]);
  const dps = makePlayers([
    [4, 'WARRIOR', 'Fury'], [3, 'ROGUE', 'Combat'], [2, 'ROGUE', 'Assassination'], [2, 'SHAMAN', 'Enhancement'], [1, 'DRUID', 'Feral'],
    [2, 'HUNTER', 'Marksmanship'], [1, 'HUNTER', 'Beastmastery'], [1, 'HUNTER', 'Survival'], [2, 'MAGE', 'Fire'], [2, 'MAGE', 'Frost'],
    [2, 'WARLOCK', 'Destruction'], [1, 'WARLOCK', 'Affliction'], [1, 'SHAMAN', 'Elemental'],
  ]);
  assert.deepEqual([tanks.length, healers.length, dps.length], [5, 11, 24]);
  return {
    kept: tanks.slice(0, 2).concat(healers.slice(0, 7), dps.slice(0, 11)),
    rest: tanks.slice(2).concat(healers.slice(7), dps.slice(11)),
  };
}

check('Classic 40 -> 20 then Optimize re-seats players the shrink benched (no healer cap in Classic: floors only) and keeps the bench invariants', () => {
  const { afterShrink, hand } = shrinkAndOptimize('classic', 'mc', 'zg', false);
  assert.equal(roleCount(afterShrink.board, 'healer'), 7);
  const seated = seatedPlayers();
  assert(roleCount(seated, 'tank') >= 2, `tanks ${roleCount(seated, 'tank')}`);
  assert(roleCount(seated, 'healer') >= 4, `healers ${roleCount(seated, 'healer')}`);
  const reseated = seated.filter(p => afterShrink.benched.some(b => b.uid === p.uid));
  assert(reseated.length > 0, 'at least one player the shrink benched is seated again');
  assert.notDeepEqual(plain(uids(seated).slice().sort()), plain(uids(afterShrink.board).slice().sort()), 'the seated players differ from the board the shrink left');
  assert(roleCount(seated, 'healer') < 7, `healers ${roleCount(seated, 'healer')} (the positional board had 7)`);
  assertBenchInvariants(afterShrink, hand);
});

check('with 18 on the board and 2 size-benched DPS, Optimize seats them and suggests no Open slot', () => {
  const board = makePlayers([[2, 'WARRIOR', 'Protection'], [2, 'SHAMAN', 'Restoration'], [2, 'PALADIN', 'Holy'], [4, 'WARRIOR', 'Fury'],
    [2, 'ROGUE', 'Combat'], [2, 'MAGE', 'Frost'], [2, 'WARLOCK', 'Destruction'], [1, 'HUNTER', 'Marksmanship'], [1, 'SHAMAN', 'Elemental']]);
  const benchedByShrink = makePlayers([[1, 'MAGE', 'Fire'], [1, 'WARLOCK', 'Affliction']]);
  assert.equal(board.length, 18);
  Object.assign(sz.State, {
    gameVersion: 'forever', selectedRaid: 'f_hyjal', activeTab: 'plan', planId: 'plan:sizebench-open', sizeBenched: uids(benchedByShrink),
    bench: benchedByShrink, unplaced: [], preferredSlots: [], playerConstraints: [], drummers: [], buffOverrides: {},
  });
  sz.State.groups = [0, 1, 2, 3].map(gi => board.slice(gi * 5, gi * 5 + 5));
  sz.State.groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  sz.State.roster = sz.State.groups.flat();
  sz.Optimizer.optimize();
  sz.State.roster = sz.State.groups.flat();
  sz.SizeBench.prune();
  assert.equal(seatedPlayers().length, 20, 'both size-benched players take the empty seats');
  assert.equal(sz.State.bench.length, 0);
  assert.deepEqual(plain(sz.State.preferredSlots), [], 'no Open slot is suggested while a size-benched player can take the seat');
  assert.deepEqual(plain(sz.State.sizeBenched), []);
});

// ── Reference comp view (4.3.0, L3-3) ────────────────────────────────
function referenceHarness({ phone = false } = {}) {
  const elements = {};
  const log = { focused: [], toasts: [] };
  let active = null;
  const doc = {
    getElementById: id => elements[id] || (elements[id] = {
      id, hidden: false, style: {}, innerHTML: '', textContent: '', className: '', classList: { add() {} },
      focus() { if (!this.unfocusable) { active = this; log.focused.push(id); } },
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    get activeElement() { return active; },
  };
  const c = app.sandbox(['State', 'Config', 'GameVersions', 'IdealComp', 'switchTab', 'renderIdealComp'], {
    globals: { document: doc, __log: log, window: { matchMedia: () => ({ matches: phone }) } },
    extraSource: 'function esc(s) { return String(s); }\nfunction showToast(m) { __log.toasts.push(m); }\n' +
      'function initGroups() {}\nfunction commit() {}\nfunction getDominantRoleLabel() { return ""; }\nfunction classColorClass() { return ""; }\n' +
      'function getSpecIcon() { return ""; }\nfunction renderBuffCatalog() {}\nfunction renderUtilityCatalog() {}\nfunction renderRaidCheckTiles() {}\n' +
      app.slice('// ── GROUP PANELS', '// ── end GROUP PANELS') +
      app.slice('const IdealComp = {', '// Reference comp is a quiet link'),
  });
  return { api: c.api, elements, log, doc };
}

check('the reference comp view shows the banner with the selected raid size, and no "Compare to ideal comp" is left', () => {
  const { api, elements } = referenceHarness();
  api.State.gameVersion = 'tbc';
  for (const [raid, size] of [['ssc', 25], ['kara', 10]]) {
    api.State.selectedRaid = raid;
    api.switchTab('ideal');
    assert.equal(elements['reference-banner'].hidden, false);
    assert.equal(elements['reference-banner-text'].innerHTML,
      `<strong>Reference comp, not your raid:</strong> a standard ${size}-man layout to compare against.`);
  }
  const html = app.html.replace(/\r\n/g, '\n');
  assert.match(html, /<button type="button" class="btn btn-primary" id="btn-back-to-raid">Back to my raid<\/button>/);
  assert.doesNotMatch(html, /btn-back-to-plan/, 'the plain back link is gone');
  assert.equal((html.match(/>\s*Reference comp\s*</g) || []).length, 2, 'desktop and phone links are renamed');
  assert.match(html, /id="btn-ideal-comp-link" title="Reference comp"/);
  const userFacing = html + '\n' + app.script.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(userFacing.replace(/'One action row: [^\n]*Compare to ideal comp[^\n]*'/, ''), /Compare to ideal comp/i);
});

check('opening the reference comp on a phone moves focus to Back to my raid; on desktop it moves none', () => {
  const phone = referenceHarness({ phone: true });
  phone.api.State.gameVersion = 'tbc'; phone.api.State.selectedRaid = 'ssc';
  phone.api.switchTab('ideal');
  assert.deepEqual(phone.log.focused, ['btn-back-to-raid']);
  const desktop = referenceHarness();
  desktop.api.State.gameVersion = 'tbc'; desktop.api.State.selectedRaid = 'ssc';
  desktop.api.switchTab('ideal');
  assert.deepEqual(desktop.log.focused, []);
});

check('Back to my raid returns to the plan, hides the banner and focuses the Reference comp link', () => {
  const { api, elements, log } = referenceHarness();
  api.State.gameVersion = 'tbc';
  api.State.selectedRaid = 'ssc';
  api.switchTab('ideal');
  assert.equal(log.focused.length, 0, 'opening the view moves no focus');
  api.switchTab('plan');
  assert.equal(api.State.activeTab, 'plan');
  assert.equal(elements['reference-banner'].hidden, true);
  assert.deepEqual(log.focused, ['btn-ideal-comp-link']);
  // on a phone the desktop link is not rendered: focus falls to the phone link
  const phone = referenceHarness();
  phone.api.State.gameVersion = 'tbc'; phone.api.State.selectedRaid = 'ssc';
  phone.api.switchTab('ideal');
  phone.doc.getElementById('btn-ideal-comp-link').unfocusable = true;
  phone.api.switchTab('plan');
  assert.deepEqual(phone.log.focused, ['btn-ideal-comp-link-phone']);
  // a plain plan-to-plan switch moves no focus
  api.switchTab('plan');
  assert.equal(log.focused.length, 1);
  assert.doesNotMatch(app.script, /btn-ideal-comp-link'\)\.hidden/, 'the Reference comp link stays visible while the view is open');
  assert.match(app.script, /getElementById\('btn-back-to-raid'\)\.addEventListener\('click', \(\) => switchTab\('plan'\)\)/);
});

console.log(`\nRaid size tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
