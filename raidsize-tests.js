/**
 * PartyPlanner Web - Raid size control tests (nav slim-down, 2026-10-09)
 * Run: node raidsize-tests.js
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
const app = require('./tests/load-app');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// A fake #raid-size-control: innerHTML is parsed back into button records so
// aria-pressed can be read the way the page would.
function fakeGroup() {
  const group = {
    dataset: {}, buttons: [],
    set innerHTML(html) {
      this.buttons = [...html.matchAll(/data-raid-size="(\d+)"/g)].map(m => ({
        dataset: { raidSize: m[1] }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
      }));
    },
    querySelectorAll() { return this.buttons; },
    addEventListener() {},
  };
  return group;
}

const group = fakeGroup();
const log = { commits: 0, inits: 0, ideal: 0, toasts: [] };
const document = { getElementById: id => (id === 'raid-size-control' ? group : null) };
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

check('one name per size: duplicates in old data list once (newest), saving or deleting covers every copy', () => {
  const older = { savedAt: 1, players: { a: { name: 'A', group: 0, role: 'tank' } } };
  const newer = { savedAt: 9, players: { a: { name: 'A', group: 0, role: 'tank' }, b: { name: 'B', group: 1, role: 'healer' } } };
  const storage = memStorage({ [T.Templates.key]: JSON.stringify({ tbc: { ssc: { Friday: older }, tk: { Friday: newer } } }) });
  const list = T.Templates.list(storage, 'tbc', 'bt');
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2, 'the newest copy wins');
  assert.equal(T.Templates.get(storage, 'Friday', 'tbc', 'bt').savedAt, 9);
  assert.equal(T.Templates.rename(storage, 'Friday', 'Thursday', 'tbc', 'bt').success, true);
  assert.deepEqual(plain(T.Templates.list(storage, 'tbc', 'bt').map(t => t.name)), ['Thursday'], 'rename leaves no older copy behind');
  seatTen('bt');
  T.Templates.save(storage, 'Thursday', 'tbc', 'bt');
  const stored = JSON.parse(storage.data[T.Templates.key]).tbc;
  assert.deepEqual(Object.keys(stored.bt), ['Thursday']);
  assert(!stored.tk.Thursday, 'saving replaces the same-named copy on another raid of that size');
  T.Templates.delete(storage, 'Thursday', 'tbc', 'bt');
  assert.equal(T.Templates.list(storage, 'tbc', 'ssc').length, 0);
});

// ── (e) Assignments is unreachable ──────────────────────────────────
check('the Assignments view cannot be opened: no tab, switchTab lands on the plan, no 2 shortcut', () => {
  const stub = () => ({ hidden: false, style: {} });
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
  assert.equal(elements['btn-back-to-plan'].hidden, true);
  assert.equal(env.commits, 1, 'the plan board renders');
  assert(!api.SHORTCUTS_HELP.some(([keys]) => keys === '2'), 'the help list has no 2 shortcut');
  assert.match(app.script, /if \(k === '2' && ASSIGNMENTS_TAB_ENABLED\)/, 'the 2 key is gated by the flag');
  assert.doesNotMatch(app.html, /data-tab="assignments"|class="mode-tabs"/, 'no Plan | Assignments tab bar');
  assert.match(app.script, /function renderAssignments\(\)/, 'the Assignments rendering code is kept for later');
});

console.log(`\nRaid size tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
