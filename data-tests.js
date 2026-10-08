/**
 * PartyPlanner Web - Data backup / storage safety / feature spotlight tests
 * Run: node data-tests.js
 *
 * Same vm loader pattern as control-tests.js/classic-tests.js: the logic
 * half of index.html's <script> (everything before '// ── UI RENDERING') is
 * executed in a sandboxed context and the pieces under test are pulled out
 * through globalThis.api. Covers feature-backlog-3.md #3 (storage guards +
 * DataBackup export/import) and #4 (Spotlight's pure seen-state tracking —
 * the DOM/positioning half lives past the UI-RENDERING split and has no
 * meaningful node-testable surface, per that item's own Test section).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['DataBackup', 'Spotlight', 'safeSetItem', 'ImportHistory', 'PlanStore', 'Templates', 'nextUid']);
const { DataBackup, Spotlight, safeSetItem, ImportHistory, PlanStore, Templates, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── Fixtures ───────────────────────────────────────────────────
function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    _dump() { return Object.fromEntries(data); },
  };
}
function roster(name, timestamp, playerName) {
  return {
    name, timestamp, gameVersion: 'tbc', raid: 'bt',
    players: [{ name: playerName, class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 1 }],
    bench: [],
  };
}
function validBackup(data) {
  return { schema: 'party-planner-backup', version: 1, exportedAt: Date.now(), data };
}

// ══════════════════════════════════════════════════════════════
// safeSetItem
// ══════════════════════════════════════════════════════════════

check('safeSetItem: writes through and returns true on success', () => {
  const storage = fakeStorage();
  assert.equal(safeSetItem(storage, 'k', 'v'), true);
  assert.equal(storage.getItem('k'), 'v');
});

check('safeSetItem: catches a throwing storage.setItem and returns false instead of throwing', () => {
  const blocked = { setItem() { throw new Error('QuotaExceededError'); } };
  let threw = false;
  let ok;
  try { ok = safeSetItem(blocked, 'k', 'v'); } catch { threw = true; }
  assert.equal(threw, false, 'safeSetItem must never let the storage error escape');
  assert.equal(ok, false);
});

// ══════════════════════════════════════════════════════════════
// DataBackup.build / validate round trip
// ══════════════════════════════════════════════════════════════

check('DataBackup.build: bundles only pp_* keys actually present, with a schema/version/timestamp header', () => {
  const src = fakeStorage({
    pp_rosters: JSON.stringify({ 'My Raid': roster('My Raid', 100, 'A-Warrior') }),
    pp_sidebar_expanded: '1',
    unrelated_key: 'should not appear',
  });
  const backup = DataBackup.build(src);
  assert.equal(backup.schema, 'party-planner-backup');
  assert.equal(backup.version, DataBackup.version);
  assert.equal(typeof backup.exportedAt, 'number');
  assert.ok(Object.prototype.hasOwnProperty.call(backup.data, 'pp_rosters'));
  assert.ok(Object.prototype.hasOwnProperty.call(backup.data, 'pp_sidebar_expanded'));
  assert.ok(!Object.prototype.hasOwnProperty.call(backup.data, 'pp_working_plans'), 'absent keys are omitted, not written as null');
  assert.ok(!Object.prototype.hasOwnProperty.call(backup.data, 'unrelated_key'), 'only known pp_* keys are bundled');
});

check('DataBackup: build -> validate -> apply round trip reproduces the source data exactly', () => {
  const src = fakeStorage({
    pp_rosters: JSON.stringify({ 'My Raid': roster('My Raid', 100, 'A-Warrior') }),
    pp_sidebar_expanded: '1',
    pp_whats_new_dismissed_v1: 'true',
    pp_spotlight_seen_v1: JSON.stringify(['assignments-tab']),
  });
  const backup = DataBackup.build(src);
  const check1 = DataBackup.validate(backup);
  assert.equal(check1.valid, true, check1.errors.join('; '));
  assert.equal(check1.summary.pp_rosters.count, 1);

  const dest = fakeStorage();
  const result = DataBackup.apply(dest, backup, 'merge');
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(dest.getItem('pp_rosters')), JSON.parse(src.getItem('pp_rosters')));
  assert.equal(dest.getItem('pp_sidebar_expanded'), '1');
  assert.equal(dest.getItem('pp_whats_new_dismissed_v1'), 'true');
  assert.deepEqual(JSON.parse(dest.getItem('pp_spotlight_seen_v1')), ['assignments-tab']);
});

// ══════════════════════════════════════════════════════════════
// Malformed input rejected, nothing written
// ══════════════════════════════════════════════════════════════

check('DataBackup.validate: rejects a non-object, wrong schema, missing version, and empty data', () => {
  assert.equal(DataBackup.validate(null).valid, false);
  assert.equal(DataBackup.validate('nope').valid, false);
  assert.equal(DataBackup.validate([]).valid, false);
  assert.equal(DataBackup.validate({ schema: 'something-else', version: 1, data: {} }).valid, false);
  assert.equal(DataBackup.validate({ schema: 'party-planner-backup', data: {} }).valid, false, 'missing version rejected');
  assert.equal(DataBackup.validate({ schema: 'party-planner-backup', version: 1, data: {} }).valid, false, 'no recognizable keys rejected');
});

check('DataBackup.validate: rejects malformed per-key payloads (bad JSON, wrong shape, bad roster fields)', () => {
  assert.equal(DataBackup.validate(validBackup({ pp_rosters: '{not json' })).valid, false);
  assert.equal(DataBackup.validate(validBackup({ pp_rosters: JSON.stringify([1, 2]) })).valid, false, 'array instead of object rejected');
  assert.equal(DataBackup.validate(validBackup({ pp_rosters: JSON.stringify({ Broken: { timestamp: 1 } }) })).valid, false, 'roster missing players[] rejected');
  assert.equal(DataBackup.validate(validBackup({ pp_working_plans: JSON.stringify([{ updatedAt: 1, data: { planId: 'x' } }]) })).valid, false, 'working plan missing required PlanStore fields rejected');
  assert.equal(DataBackup.validate(validBackup({ pp_sidebar_expanded: 'maybe' })).valid, false, 'sidebar flag must be 0 or 1');
  assert.equal(DataBackup.validate(validBackup({ pp_spotlight_seen_v1: JSON.stringify([1, 2]) })).valid, false, 'spotlight ids must be strings');
});

check('DataBackup.apply: an invalid backup writes nothing at all (no partial write)', () => {
  const dest = fakeStorage({
    pp_rosters: JSON.stringify({ Keep: roster('Keep', 1, 'X-Warrior') }),
  });
  const before = dest._dump();
  const bad = validBackup({
    pp_rosters: JSON.stringify({ Keep2: roster('Keep2', 2, 'Y-Warrior') }), // valid on its own
    pp_working_plans: JSON.stringify([{ updatedAt: 1 }]), // invalid — missing .data entirely
  });
  const result = DataBackup.apply(dest, bad, 'replace');
  assert.equal(result.success, false);
  assert.deepEqual(dest._dump(), before, 'nothing written — not even the valid pp_rosters key from the same file');
});

// ══════════════════════════════════════════════════════════════
// Merge vs Replace semantics
// ══════════════════════════════════════════════════════════════

check('DataBackup merge: adds missing entries, keeps the newer copy by timestamp, leaves local-only entries alone', () => {
  const dest = fakeStorage({
    pp_rosters: JSON.stringify({
      Shared: roster('Shared', 100, 'Old-Warrior'),
      LocalOnly: roster('LocalOnly', 50, 'L-Warrior'),
    }),
  });
  const backup = validBackup({
    pp_rosters: JSON.stringify({
      Shared: roster('Shared', 200, 'New-Warrior'),   // newer -> should win
      BackupOnly: roster('BackupOnly', 10, 'B-Warrior'), // missing locally -> should be added
    }),
  });
  const planned = DataBackup.plan(dest, backup, 'merge');
  assert.equal(planned.valid, true);
  assert.equal(planned.changes.pp_rosters.added, 1);
  assert.equal(planned.changes.pp_rosters.updated, 1);

  const result = DataBackup.apply(dest, backup, 'merge');
  assert.equal(result.success, true);
  const merged = JSON.parse(dest.getItem('pp_rosters'));
  assert.equal(merged.Shared.players[0].name, 'New-Warrior', 'newer timestamp wins on conflict');
  assert.equal(merged.LocalOnly.players[0].name, 'L-Warrior', 'local-only entry untouched');
  assert.equal(merged.BackupOnly.players[0].name, 'B-Warrior', 'missing entry added');
});

check('DataBackup merge: an older backup entry never overwrites a newer local one', () => {
  const dest = fakeStorage({ pp_rosters: JSON.stringify({ Shared: roster('Shared', 500, 'Local-Warrior') }) });
  const backup = validBackup({ pp_rosters: JSON.stringify({ Shared: roster('Shared', 10, 'Stale-Warrior') }) });
  DataBackup.apply(dest, backup, 'merge');
  const merged = JSON.parse(dest.getItem('pp_rosters'));
  assert.equal(merged.Shared.players[0].name, 'Local-Warrior', 'older backup copy discarded');
});

check('DataBackup merge: flags with no timestamp only fill in when absent locally, never clobber a live preference', () => {
  const dest = fakeStorage({ pp_sidebar_expanded: '0' });
  const backup = validBackup({ pp_sidebar_expanded: '1' });
  DataBackup.apply(dest, backup, 'merge');
  assert.equal(dest.getItem('pp_sidebar_expanded'), '0', 'current browser preference kept');

  const dest2 = fakeStorage();
  DataBackup.apply(dest2, backup, 'merge');
  assert.equal(dest2.getItem('pp_sidebar_expanded'), '1', 'adopted when this browser never had one');
});

check('DataBackup merge: spotlight-seen ids union rather than overwrite', () => {
  const dest = fakeStorage({ pp_spotlight_seen_v1: JSON.stringify(['assignments-tab']) });
  const backup = validBackup({ pp_spotlight_seen_v1: JSON.stringify(['options-panel', 'assignments-tab']) });
  DataBackup.apply(dest, backup, 'merge');
  const ids = JSON.parse(dest.getItem('pp_spotlight_seen_v1')).sort();
  assert.deepEqual(ids, ['assignments-tab', 'options-panel']);
});

check('DataBackup replace: overwrites matching keys wholesale', () => {
  const dest = fakeStorage({ pp_rosters: JSON.stringify({ Keep: roster('Keep', 1, 'K-Warrior') }) });
  const backup = validBackup({ pp_rosters: JSON.stringify({ New: roster('New', 999, 'N-Warrior') }) });
  const result = DataBackup.apply(dest, backup, 'replace');
  assert.equal(result.success, true);
  const after = JSON.parse(dest.getItem('pp_rosters'));
  assert.deepEqual(Object.keys(after), ['New'], 'Replace drops what only the old copy had');
});

check('DataBackup replace: a key absent from the backup file is left untouched, not deleted', () => {
  const dest = fakeStorage({
    pp_rosters: JSON.stringify({ Keep: roster('Keep', 1, 'K-Warrior') }),
    pp_roster_templates: JSON.stringify({ tbc: { bt: { 'My Template': { savedAt: 1, players: {} } } } }),
  });
  const backup = validBackup({ pp_rosters: JSON.stringify({ New: roster('New', 2, 'N-Warrior') }) });
  DataBackup.apply(dest, backup, 'replace');
  assert.ok(dest.getItem('pp_roster_templates'), 'template key untouched since the backup file never mentioned it');
});

// ══════════════════════════════════════════════════════════════
// Quota error handling mid-write
// ══════════════════════════════════════════════════════════════

check('DataBackup.apply: a quota error partway through rolls back every key this call touched', () => {
  const dest = fakeStorage({ pp_rosters: JSON.stringify({ Keep: roster('Keep', 1, 'K-Warrior') }) });
  const originalRosters = dest.getItem('pp_rosters');
  let setCalls = 0;
  const throwing = {
    getItem: (k) => dest.getItem(k),
    removeItem: (k) => dest.removeItem(k),
    setItem: (k, v) => {
      setCalls++;
      if (setCalls === 2) throw new Error('QuotaExceededError');
      dest.setItem(k, v);
    },
  };
  const backup = validBackup({
    pp_rosters: JSON.stringify({ New: roster('New', 2, 'N-Warrior') }),
    pp_sidebar_expanded: '1',
  });
  const result = DataBackup.apply(throwing, backup, 'replace');
  assert.equal(result.success, false);
  assert.ok(result.errors[0].toLowerCase().includes('storage'));
  assert.equal(dest.getItem('pp_rosters'), originalRosters, 'first key rolled back after the second key failed');
  assert.equal(dest.getItem('pp_sidebar_expanded'), null, 'never-written key stays absent, not left half-applied');
});

check('DataBackup.apply: validation still runs before any write reaches a real (non-fake) storage error', () => {
  const dest = fakeStorage();
  const bad = { schema: 'party-planner-backup', version: 1, data: { pp_rosters: 'not even json' } };
  let setItemCalled = false;
  const spy = { getItem: (k) => dest.getItem(k), setItem: (k, v) => { setItemCalled = true; dest.setItem(k, v); } };
  const result = DataBackup.apply(spy, bad, 'merge');
  assert.equal(result.success, false);
  assert.equal(setItemCalled, false, 'setItem never called for an invalid file');
});

// ══════════════════════════════════════════════════════════════
// Spotlight: pure seen-state logic
// ══════════════════════════════════════════════════════════════

check('Spotlight.shouldShow/dismiss: round trip persists and is scoped per id', () => {
  const storage = fakeStorage();
  assert.equal(Spotlight.shouldShow(storage, 'assignments-tab'), true);
  Spotlight.dismiss(storage, 'assignments-tab');
  assert.equal(Spotlight.shouldShow(storage, 'assignments-tab'), false);
  assert.equal(Spotlight.shouldShow(storage, 'options-panel'), true, 'dismissing one id does not affect another');
});

check('Spotlight.dismiss: idempotent — dismissing an already-seen id is a no-op', () => {
  const storage = fakeStorage();
  Spotlight.dismiss(storage, 'a');
  const after1 = storage.getItem(Spotlight.key);
  Spotlight.dismiss(storage, 'a');
  assert.equal(storage.getItem(Spotlight.key), after1);
});

check('Spotlight.resetAll: clears every previously-dismissed id ("Show tips again")', () => {
  const storage = fakeStorage();
  Spotlight.dismiss(storage, 'a');
  Spotlight.dismiss(storage, 'b');
  Spotlight.resetAll(storage);
  assert.equal(Spotlight.shouldShow(storage, 'a'), true);
  assert.equal(Spotlight.shouldShow(storage, 'b'), true);
});

check('Spotlight.shouldShow: corrupt stored value is treated as nothing seen, not an error', () => {
  const storage = fakeStorage({ [Spotlight.key]: '{not json' });
  let threw = false;
  let shows;
  try { shows = Spotlight.shouldShow(storage, 'assignments-tab'); } catch { threw = true; }
  assert.equal(threw, false);
  assert.equal(shows, true);
});

console.log(`\nData backup / storage safety / spotlight tests: ${passed} passed, 0 failed, ${passed} total`);
