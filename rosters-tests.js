/**
 * PartyPlanner Web — Planned Bench Backups + Split Sign-Ups tests
 * Run: node rosters-tests.js
 *
 * Same vm loader pattern as classic-tests.js/assignments-tests.js: the logic
 * half of index.html's <script> (everything above '// ── UI RENDERING') runs
 * in a sandboxed context and the pieces under test are pulled out through
 * globalThis.api. Covers feature-backlog.md #7 (Backups) and #8 (RaidSplit).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Rulesets', 'Import', 'Optimizer', 'RosterEdit', 'PlanStore', 'Backups', 'RaidSplit', 'Faction', 'enforceRaidCapacity', 'nextUid', 'dpsWeightFor']);
const { State, Config, GameVersions, Rulesets, Import, Optimizer, RosterEdit, PlanStore, Backups, RaidSplit, Faction, enforceRaidCapacity, nextUid, dpsWeightFor } = ctx.api;

function mk(cls, spec, role, groupNumber) {
  return { uid: nextUid(), name: cls + '-' + spec + '-' + nextUid(), class: cls, spec, role, groupNumber: groupNumber || 0, imported: false };
}
function resetState(version, raid) {
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.groups = [];
  State.bench = [];
  State.roster = [];
  State.planId = null;
  State.sourceEventId = null;
  State.rosterName = 'Test Roster';
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.notes = '';
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  State.backups = {};
}
// Seats `players` across `numGroups` groups, 5 per group in order, and
// mirrors State.roster. When there are more than numGroups*5 players (an
// overflowing import that hasn't been benched yet), the remainder is spread
// round-robin across the same groups rather than overflowing the array.
function seatInGroups(players, numGroups) {
  const groups = [];
  for (let i = 0; i < numGroups; i++) groups.push([]);
  players.forEach((p, i) => {
    const gi = i < numGroups * 5 ? Math.floor(i / 5) : i % numGroups;
    groups[gi].push(p);
    p.groupNumber = gi + 1;
  });
  State.groups = groups;
  State.roster = groups.flat();
  return groups;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ════════════════════════════════════════════════════════════════
// PLANNED BENCH BACKUPS (feature-backlog.md #7)
// ════════════════════════════════════════════════════════════════

check('link(): pins a benched player as backup for a seated one', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  const result = Backups.link(mt.name, bob.name);
  assert.equal(result.success, true);
  assert.equal(Backups.backupNameFor(mt.name), bob.name);
  assert.equal(Backups.primaryNameFor(bob.name), mt.name);
});

check('link(): rejects same name, a non-seated primary, and a non-benched backup', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  assert.equal(Backups.link(mt.name, mt.name).success, false);
  assert.equal(Backups.link('Nobody', bob.name).success, false);
  assert.equal(Backups.link(mt.name, 'Nobody').success, false);
});

check('link(): one-to-one invariant — relinking either side drops the old pairing', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const ot = mk('PALADIN', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  const cara = mk('DRUID', 'Feral', 'tank', 0);
  seatInGroups([mt, ot], 5);
  State.bench = [bob, cara];
  Backups.link(mt.name, bob.name);
  // Bob backs up OT instead — MT's link is dropped, not left dangling.
  Backups.link(ot.name, bob.name);
  assert.equal(Backups.backupNameFor(mt.name), null);
  assert.equal(Backups.backupNameFor(ot.name), bob.name);
  // MT gets Cara as a fresh backup; Cara can't also be backing up OT.
  Backups.link(mt.name, cara.name);
  assert.equal(Backups.backupNameFor(mt.name), cara.name);
  assert.equal(Backups.primaryNameFor(cara.name), mt.name);
});

check('swapIn(): a still-seated primary is a true swap — benched, and the backup takes their exact seat', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const filler = mk('PALADIN', 'Retribution', 'melee_dps', 2);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt, filler], 5);
  State.groups[1] = [filler];
  State.groups[0] = [mt];
  State.bench = [bob];
  Backups.link(mt.name, bob.name);
  const result = Backups.swapIn(mt.name, 0);
  assert.equal(result.success, true);
  assert.equal(result.player.name, bob.name);
  assert.equal(bob.groupNumber, 1);
  assert.ok(State.groups[0].includes(bob), 'the backup takes the exact seat the primary vacated');
  assert.ok(!State.groups[0].includes(mt), 'the primary is no longer in that seat');
  assert.ok(State.bench.includes(mt), 'the primary lands on the bench, not just dropped');
  assert.ok(!State.bench.includes(bob));
  assert.equal(Backups.backupNameFor(mt.name), null);
  assert.equal(State.groups.flat().length, 2, 'still exactly one seated per original seat — a swap, not an add');
});

check('swapIn(): when the primary already left (Raid-Helper sync), the vacated groupIdx is used and falls back to any open seat', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([], 5); // mt has already been fully removed from the roster/groups
  State.bench = [bob];
  State.backups = { [mt.name]: bob.name }; // link recorded before mt withdrew
  // mt is nowhere in State.groups, so this falls back to the given groupIdx.
  const result = Backups.swapIn(mt.name, 2);
  assert.equal(result.success, true);
  assert.equal(bob.groupNumber, 3);
  assert.ok(State.groups[2].includes(bob));

  // An invalid/out-of-range groupIdx (e.g. that group filled up meanwhile)
  // falls back further, to the first open seat.
  const cara = mk('DRUID', 'Feral', 'tank', 0);
  State.bench = [cara];
  State.backups = { OtherPrimary: cara.name };
  const fallback = Backups.swapIn('OtherPrimary', 99);
  assert.equal(fallback.success, true);
  assert.ok(State.groups.some(g => g.includes(cara)));

  const noBackup = Backups.swapIn('Nobody', 0);
  assert.equal(noBackup.success, false);
  // A link whose backup was never actually benched (link() would refuse this
  // in the UI) fails swapIn's own defensive check directly.
  State.backups.GhostPrimary = 'GhostName';
  const gone = Backups.swapIn('GhostPrimary', 0);
  assert.equal(gone.success, false);
});

check('RosterEdit hooks clean up backup links on both sides', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  Backups.link(mt.name, bob.name);

  // Deleting the backup (benched) drops the link.
  RosterEdit.DeletePlayer(bob.uid);
  assert.equal(Backups.backupNameFor(mt.name), null);

  // Re-link, then delete the primary (seated) — link drops too.
  const cara = mk('DRUID', 'Feral', 'tank', 0);
  State.bench = [cara];
  Backups.link(mt.name, cara.name);
  RosterEdit.DeletePlayer(mt.uid);
  assert.equal(Backups.primaryNameFor(cara.name), null);

  // Benching a seated primary (not deleting) also drops the "backup for them" link.
  const ot = mk('PALADIN', 'Protection', 'tank', 1);
  const dave = mk('WARRIOR', 'Arms', 'melee_dps', 0);
  State.groups[0] = [ot];
  State.roster = [ot];
  State.bench = [dave];
  Backups.link(ot.name, dave.name);
  RosterEdit.BenchPlayer(ot.uid);
  assert.equal(Backups.backupNameFor(ot.name), null);

  // Unbenching a designated backup (they take their own seat) frees them
  // from backup duty.
  const mt2 = mk('WARRIOR', 'Protection', 'tank', 1);
  const eve = mk('PRIEST', 'Holy', 'healer', 0);
  State.groups = [[mt2], [], [], [], []];
  State.roster = [mt2];
  State.bench = [eve];
  Backups.link(mt2.name, eve.name);
  RosterEdit.UnbenchPlayer(eve.uid, 1);
  assert.equal(Backups.backupNameFor(mt2.name), null);
});

check('reconcile(): drops a link when the primary is gone entirely or the backup left the bench', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  Backups.link(mt.name, bob.name);

  // Primary merely demoted to the bench (still present) — link survives.
  State.groups[0] = [];
  State.bench.push(mt);
  State.roster = [];
  Backups.reconcile();
  assert.equal(Backups.backupNameFor(mt.name), bob.name);

  // Primary removed from the roster entirely — link is dropped.
  State.bench = State.bench.filter(p => p !== mt);
  Backups.reconcile();
  assert.equal(Backups.backupNameFor(mt.name), null);

  // Fresh link, but the backup gets seated by something other than swapIn —
  // reconcile still catches the now-stale pairing.
  const ot = mk('PALADIN', 'Protection', 'tank', 1);
  const cara = mk('DRUID', 'Feral', 'tank', 0);
  State.groups = [[ot], [], [], [], []];
  State.roster = [ot];
  State.bench = [cara];
  Backups.link(ot.name, cara.name);
  State.groups[1] = [cara];
  State.bench = [];
  cara.groupNumber = 2;
  State.roster = [ot, cara];
  Backups.reconcile();
  assert.equal(Backups.backupNameFor(ot.name), null);
});

check('Optimizer.optimize() never touches the bench when seated count is within capacity, so a backup link is untouched and idempotent', () => {
  resetState('tbc', 'bt');
  const raid = Config.Raids['bt'];
  const seated = [];
  for (let i = 0; i < raid.size; i++) {
    const role = i < 2 ? 'tank' : i < 8 ? 'healer' : (i % 3 === 0 ? 'melee_dps' : i % 3 === 1 ? 'ranged_dps' : 'caster_dps');
    const cls = role === 'tank' ? 'WARRIOR' : role === 'healer' ? 'PRIEST' : role === 'melee_dps' ? 'ROGUE' : role === 'ranged_dps' ? 'HUNTER' : 'MAGE';
    const spec = role === 'tank' ? 'Protection' : role === 'healer' ? 'Holy' : role === 'melee_dps' ? 'Combat' : role === 'ranged_dps' ? 'Marksmanship' : 'Frost';
    seated.push(mk(cls, spec, role));
  }
  seatInGroups(seated, raid.groups);
  const backupPlayer = mk('WARRIOR', 'Protection', 'tank', 0);
  State.bench = [backupPlayer];
  Backups.link(seated[0].name, backupPlayer.name);

  Optimizer.optimize();
  const boardAfterFirst = JSON.stringify(State.groups);
  const backupsAfterFirst = JSON.stringify(State.backups);
  Optimizer.optimize();
  const boardAfterSecond = JSON.stringify(State.groups);
  const backupsAfterSecond = JSON.stringify(State.backups);

  assert.equal(boardAfterFirst, boardAfterSecond, 'optimize is idempotent at capacity with a backup link present');
  assert.equal(backupsAfterFirst, backupsAfterSecond, 'the backup link is untouched by optimize()');
  assert.ok(State.bench.includes(backupPlayer), 'the designated backup stays benched unless explicitly swapped in');
  assert.equal(Backups.backupNameFor(seated[0].name), backupPlayer.name);
});

check('Optimizer.optimize() over capacity keeps the board idempotent; a backup link surviving the reshuffle stays valid', () => {
  resetState('tbc', 'bt');
  const raid = Config.Raids['bt']; // size 25, 5 groups
  const over = [];
  for (let i = 0; i < raid.size + 8; i++) {
    const role = i < 3 ? 'tank' : i < 10 ? 'healer' : (i % 3 === 0 ? 'melee_dps' : i % 3 === 1 ? 'ranged_dps' : 'caster_dps');
    const cls = role === 'tank' ? 'WARRIOR' : role === 'healer' ? 'DRUID' : role === 'melee_dps' ? 'ROGUE' : role === 'ranged_dps' ? 'HUNTER' : 'WARLOCK';
    const spec = role === 'tank' ? 'Protection' : role === 'healer' ? 'Restoration' : role === 'melee_dps' ? 'Assassination' : role === 'ranged_dps' ? 'Survival' : 'Destruction';
    over.push(mk(cls, spec, role));
  }
  // Everybody starts seated (simulating an overflowing import that hasn't been
  // benched yet) — Optimizer.optimize() itself performs the seat selection.
  seatInGroups(over, raid.groups);
  Optimizer.optimize();
  assert.equal(State.groups.flat().length, raid.size);
  assert.equal(State.bench.length, 8);

  const boardAfterFirst = JSON.stringify(State.groups);
  const benchAfterFirst = JSON.stringify(State.bench.map(p => p.name).sort());
  Optimizer.optimize();
  assert.equal(JSON.stringify(State.groups), boardAfterFirst, 'optimize is idempotent over capacity');
  assert.equal(JSON.stringify(State.bench.map(p => p.name).sort()), benchAfterFirst, 'the bench set is stable across repeated optimize() calls');

  // Whoever ended up on the bench can still be pinned as a backup, and that
  // pairing is internally consistent (reconcile leaves it alone).
  const primary = State.groups[0][0];
  const backupPlayer = State.bench[0];
  const linkResult = Backups.link(primary.name, backupPlayer.name);
  assert.equal(linkResult.success, true);
  Backups.reconcile();
  assert.equal(Backups.backupNameFor(primary.name), backupPlayer.name, 'a link formed after optimize() survives reconcile()');
});

check('Persistence: PlanStore capture/restore round-trips backups', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  Backups.link(mt.name, bob.name);
  State.planId = 'plan:test1';
  State.optimizerMode = 'max_dps';

  const captured = PlanStore.capture();
  assert.equal(JSON.stringify(captured.backups), JSON.stringify({ [mt.name]: bob.name }));

  resetState('tbc', 'bt');
  assert.equal(PlanStore.restore(captured), true);
  assert.equal(JSON.stringify(State.backups), JSON.stringify({ [mt.name]: bob.name }));
});

check('Persistence: old plans without a backups field restore to an empty object, not a stale carryover', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  seatInGroups([mt], 5);
  State.backups = { Stale: 'Link' }; // simulate leftover state from a previous plan
  const legacyPlan = {
    planId: 'plan:legacy', groups: [[mt], [], [], [], []], bench: [],
    campfires: { professions: [], fires: [] }, gameVersion: 'tbc', selectedRaid: 'bt',
    rosterName: 'Legacy Plan', sourceEventId: null, optimizerMode: 'max_dps',
    buffOverrides: {}, preferredSlots: [], preserveGroupOrder: false,
    assignments: { tankHealers: {}, blessings: {}, debuffs: {} },
    // no `backups` key at all
  };
  assert.equal(PlanStore.restore(legacyPlan), true);
  assert.equal(JSON.stringify(State.backups), '{}');
});

check('Persistence: exportRoster/loadRoster round-trips backups by player name (uid is not preserved)', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  Backups.link(mt.name, bob.name);

  const exported = Import.exportRoster('Export Test');
  assert.equal(JSON.stringify(exported.backups), JSON.stringify({ [mt.name]: bob.name }));
  assert.ok(!('uid' in exported.players[0]), 'exported players carry no uid');

  resetState('tbc', 'bt');
  assert.equal(Import.loadRoster(exported), true);
  assert.equal(JSON.stringify(State.backups), JSON.stringify({ [mt.name]: bob.name }));
});

check('Persistence: share string carries backups only when set, and stays byte-identical when unused', () => {
  resetState('tbc', 'bt');
  const mt = mk('WARRIOR', 'Protection', 'tank', 1);
  const bob = mk('WARRIOR', 'Protection', 'tank', 0);
  seatInGroups([mt], 5);
  State.bench = [bob];
  State.rosterName = 'Share Test';

  const plainLink = Import.exportShareString();
  assert.ok(!plainLink.includes('%22backups%22') && !decodeURIComponent(plainLink).includes('"backups"'),
    'no backups tail when nothing is linked');

  Backups.link(mt.name, bob.name);
  const linkedShare = Import.exportShareString();
  assert.notEqual(linkedShare, plainLink, 'a backup link changes the share string');
  assert.ok(decodeURIComponent(linkedShare).includes('"backups"'), 'backups ride along in the JSON tail');

  resetState('tbc', 'bt');
  const parts = linkedShare.split(':');
  const result = Import.importAddonString(linkedShare);
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(State.backups), JSON.stringify({ [mt.name]: bob.name }));
});

// ════════════════════════════════════════════════════════════════
// SPLIT SIGN-UPS INTO TWO RAIDS (feature-backlog.md #8)
// ════════════════════════════════════════════════════════════════

function buildOverflowRoster(tankCount, healerCount, dpsCount, dpsClasses) {
  const players = [];
  for (let i = 0; i < tankCount; i++) players.push(mk(i % 2 === 0 ? 'WARRIOR' : 'PALADIN', 'Protection', 'tank'));
  for (let i = 0; i < healerCount; i++) players.push(mk(i % 2 === 0 ? 'PRIEST' : 'DRUID', i % 2 === 0 ? 'Holy' : 'Restoration', 'healer'));
  for (let i = 0; i < dpsCount; i++) {
    const cls = dpsClasses[i % dpsClasses.length];
    players.push(mk(cls.class, cls.spec, cls.role));
  }
  return players;
}

check('shouldOffer(): threshold matches feature-backlog.md #8 per raid size', () => {
  assert.equal(RaidSplit.shouldOffer(44, 'bt'), false); // 25-man: 45+
  assert.equal(RaidSplit.shouldOffer(45, 'bt'), true);
  assert.equal(RaidSplit.shouldOffer(29, 'zg'), false); // 20-man: 30+
  assert.equal(RaidSplit.shouldOffer(30, 'zg'), true);
  assert.equal(RaidSplit.shouldOffer(19, 'kara'), false); // 10-man: 20+
  assert.equal(RaidSplit.shouldOffer(20, 'kara'), true);
  assert.equal(RaidSplit.shouldOffer(45, 'mc'), true); // 40-man: 45+
  assert.equal(RaidSplit.shouldOffer(44, 'mc'), false);
});

check('split(): every sign-up lands in exactly one raid, none dropped or duplicated', () => {
  const players = buildOverflowRoster(6, 12, 37, [
    { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' }, { class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' },
    { class: 'HUNTER', spec: 'Marksmanship', role: 'ranged_dps' }, { class: 'MAGE', spec: 'Frost', role: 'caster_dps' },
    { class: 'WARLOCK', spec: 'Affliction', role: 'caster_dps' }, { class: 'SHAMAN', spec: 'Elemental', role: 'caster_dps' },
  ]);
  const result = RaidSplit.split(players, 'bt', 'tbc');
  const allOut = [...result.a.seated, ...result.a.bench, ...result.b.seated, ...result.b.bench];
  assert.equal(allOut.length, players.length, 'nobody was dropped or duplicated');
  const outNames = new Set(allOut.map(p => p.name));
  assert.equal(outNames.size, players.length, 'no player appears twice');
  for (const p of players) assert.ok(outNames.has(p.name), p.name + ' is accounted for');
});

check('split(): each raid meets the raid-size tank/healer floors when supply allows', () => {
  const raid = Config.Raids['bt']; // size 25
  const floors = Config.RaidFloors[raid.size]; // {tank:2, healer:5}
  const players = buildOverflowRoster(floors.tank * 2 + 2, floors.healer * 2 + 2, 40, [
    { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' }, { class: 'HUNTER', spec: 'Survival', role: 'ranged_dps' }, { class: 'MAGE', spec: 'Arcane', role: 'caster_dps' },
  ]);
  const result = RaidSplit.split(players, 'bt', 'tbc');
  for (const half of [result.a, result.b]) {
    const tanks = half.seated.filter(p => p.role === 'tank').length;
    const healers = half.seated.filter(p => p.role === 'healer').length;
    assert.ok(tanks >= floors.tank, `expected >= ${floors.tank} seated tanks, got ${tanks}`);
    assert.ok(healers >= floors.healer, `expected >= ${floors.healer} seated healers, got ${healers}`);
  }
});

check('split(): buff-provider classes (Shaman/Paladin/Druid/Hunter) spread across both raids', () => {
  const players = [];
  for (let i = 0; i < 8; i++) players.push(mk('SHAMAN', i % 2 === 0 ? 'Enhancement' : 'Elemental', i % 2 === 0 ? 'melee_dps' : 'caster_dps'));
  for (let i = 0; i < 8; i++) players.push(mk('HUNTER', 'Marksmanship', 'ranged_dps'));
  players.push(...buildOverflowRoster(4, 8, 0, []));
  const result = RaidSplit.split(players, 'bt', 'tbc');
  const shamanCount = (list) => list.seated.filter(p => p.class === 'SHAMAN').length;
  const hunterCount = (list) => list.seated.filter(p => p.class === 'HUNTER').length;
  assert.ok(Math.abs(shamanCount(result.a) - shamanCount(result.b)) <= 1, 'shamans split within 1 of each other');
  assert.ok(Math.abs(hunterCount(result.a) - hunterCount(result.b)) <= 1, 'hunters split within 1 of each other');
  assert.ok(shamanCount(result.a) > 0 && shamanCount(result.b) > 0, 'both raids get at least one shaman');
});

check('split(): DPS balance stays within tolerance of dpsWeightFor', () => {
  const players = buildOverflowRoster(6, 12, 40, [
    { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' }, { class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' },
    { class: 'HUNTER', spec: 'Beast Mastery', role: 'ranged_dps' }, { class: 'MAGE', spec: 'Fire', role: 'caster_dps' },
    { class: 'WARLOCK', spec: 'Destruction', role: 'caster_dps' },
  ]);
  const result = RaidSplit.split(players, 'bt', 'tbc');
  const weightSum = (list) => list.seated.reduce((sum, p) => sum + dpsWeightFor(p), 0);
  const wa = weightSum(result.a), wb = weightSum(result.b);
  const maxSingle = Math.max(...players.map(p => dpsWeightFor(p)));
  assert.ok(Math.abs(wa - wb) <= maxSingle + 0.5, `dpsWeight totals should be close: ${wa} vs ${wb}`);
});

check('split(): faction is preserved for a faction-locked Classic roster', () => {
  // Horde-only: Shamans present, no Paladins anywhere (buildOverflowRoster's
  // default tank mix alternates Warrior/Paladin, so tanks are built by hand
  // here). Neither output raid should ever gain a Paladin the input never had.
  const players = [];
  for (let i = 0; i < 6; i++) players.push(mk('WARRIOR', 'Protection', 'tank'));
  for (let i = 0; i < 12; i++) players.push(mk(i % 2 === 0 ? 'PRIEST' : 'DRUID', i % 2 === 0 ? 'Holy' : 'Restoration', 'healer'));
  for (let i = 0; i < 30; i++) {
    const pick = [
      { class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' }, { class: 'ROGUE', spec: 'Assassination', role: 'melee_dps' },
      { class: 'HUNTER', spec: 'Survival', role: 'ranged_dps' }, { class: 'WARLOCK', spec: 'Affliction', role: 'caster_dps' },
    ][i % 4];
    players.push(mk(pick.class, pick.spec, pick.role));
  }
  assert.equal(Faction.detect(players), 'horde');
  const result = RaidSplit.split(players, 'mc', 'classic');
  const allA = [...result.a.seated, ...result.a.bench];
  const allB = [...result.b.seated, ...result.b.bench];
  assert.notEqual(Faction.detect(allA), 'alliance');
  assert.notEqual(Faction.detect(allB), 'alliance');
  assert.ok(allA.some(p => p.class === 'SHAMAN'), 'raid A keeps at least one shaman');
  assert.ok(allB.some(p => p.class === 'SHAMAN'), 'raid B keeps at least one shaman');
});

check('split(): works for 10/20/25/40-man raids', () => {
  const sizesAndKeys = [['kara', 10], ['f_hyjal', 20], ['bt', 25], ['mc', 40]];
  for (const [raidKey, size] of sizesAndKeys) {
    assert.equal(Config.Raids[raidKey].size, size);
    const total = size * 2 + 5;
    const players = buildOverflowRoster(Math.ceil(size / 10) + 1, Math.ceil(size / 5) + 1, total - Math.ceil(size / 10) - Math.ceil(size / 5) - 2, [
      { class: 'ROGUE', spec: 'Combat', role: 'melee_dps' }, { class: 'HUNTER', spec: 'Marksmanship', role: 'ranged_dps' }, { class: 'MAGE', spec: 'Frost', role: 'caster_dps' },
    ]);
    const result = RaidSplit.split(players, raidKey, 'tbc');
    assert.ok(result.a.seated.length <= size, raidKey + ': raid A seated within capacity');
    assert.ok(result.b.seated.length <= size, raidKey + ': raid B seated within capacity');
    const total2 = result.a.seated.length + result.a.bench.length + result.b.seated.length + result.b.bench.length;
    assert.equal(total2, players.length, raidKey + ': every sign-up accounted for');
  }
});

check('split(): honors locked seats — a currently-seated sign-up is favored for raid A over a benched one', () => {
  const seated = [];
  const benched = [];
  for (let i = 0; i < 30; i++) {
    const p = mk('MAGE', 'Frost', 'caster_dps');
    if (i < 20) { p.groupNumber = (i % 5) + 1; seated.push(p); }
    else { p.groupNumber = 0; benched.push(p); }
  }
  const result = RaidSplit.split([...seated, ...benched], 'bt', 'tbc');
  const aNames = new Set(result.a.seated.map(p => p.name));
  const lockedInA = seated.filter(p => aNames.has(p.name)).length;
  // With identical weights throughout, ties favor the locked (currently
  // seated) group first — raid A should hold at least half of them.
  assert.ok(lockedInA >= seated.length / 2, `expected most locked seats in raid A, got ${lockedInA}/${seated.length}`);
});

check('Raid B gets a distinct planId sharing the source event id, and the re-sync lookup only matches raid A', () => {
  const storage = { data: new Map(), getItem(k) { return this.data.get(k) || null; }, setItem(k, v) { this.data.set(k, v); } };
  resetState('tbc', 'bt');
  const eventId = '999999999';
  State.sourceEventId = eventId;
  State.planId = 'event:' + eventId;
  const raid = Config.Raids['bt'];
  const playersA = [];
  for (let i = 0; i < raid.size; i++) playersA.push(mk('MAGE', 'Frost', 'caster_dps', (i % raid.groups) + 1));
  seatInGroups(playersA, raid.groups);
  PlanStore.save(storage, PlanStore.capture());

  const playersB = [];
  for (let i = 0; i < raid.size; i++) playersB.push(mk('WARLOCK', 'Destruction', 'caster_dps', (i % raid.groups) + 1));
  const groupsB = [];
  for (let i = 0; i < raid.groups; i++) groupsB.push([]);
  playersB.forEach((p, i) => groupsB[Math.floor(i / 5)].push(p));
  const dataB = {
    planId: State.planId + ':B',
    groups: groupsB, bench: [],
    campfires: { professions: [], fires: [] },
    gameVersion: 'tbc', selectedRaid: 'bt',
    rosterName: 'Test Roster - Raid B',
    sourceEventId: eventId,
    optimizerMode: 'max_dps',
    buffOverrides: {}, preferredSlots: [], preserveGroupOrder: false,
    notes: '', assignments: { tankHealers: {}, blessings: {}, debuffs: {} }, backups: {},
  };
  PlanStore.save(storage, dataB);

  const allPlans = PlanStore.read(storage);
  assert.equal(allPlans.length, 2, 'both raids are saved as independent plans');
  assert.notEqual(dataB.planId, State.planId, 'raid B has a distinct planId');
  assert.equal(allPlans.every(p => p.data.sourceEventId === eventId), true, 'both plans share the source event id');

  // Mirrors the exact lookup importFromText() uses to reopen a plan by event id.
  const found = allPlans.find(p => p.data.planId === 'event:' + eventId && (p.data.gameVersion || 'tbc') === 'tbc');
  assert.ok(found, 'the event-id lookup still finds raid A');
  assert.equal(found.data.rosterName, 'Test Roster', 're-sync lookup resolves to raid A, not raid B');
});

console.log(`\nRosters tests (backups + split): ${passed} passed, 0 failed, ${passed} total`);
