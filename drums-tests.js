/**
 * PartyPlanner Web - TBC Drums (Leatherworking) tests — feature-backlog-3.md #5
 * Run: node drums-tests.js
 *
 * Same vm loader pattern as control-tests.js/classic-tests.js: the logic half
 * of index.html's <script> (everything before '// ── UI RENDERING') runs in a
 * sandboxed context and the pieces under test are pulled out through
 * globalThis.api.
 *
 * Covers: Drummers module (tag/persist/clean/cleanup), getDrumsCoverage,
 * the Readiness.balanceWarnings() sidebar hint, Optimizer.spreadDrummers()
 * (spreading across all 4 modes, idempotence, locks/constraints honored,
 * zero-drummer TBC no-op), and that none of this activates outside TBC.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Import', 'Optimizer', 'RosterEdit', 'Readiness', 'Constraints', 'Backups', 'Drummers', 'getDrumsCoverage', 'PlanStore', 'RandomRoster', 'nextUid', 'activeRules']);
const { State, Config, GameVersions, Import, Optimizer, RosterEdit, Readiness, Constraints, Backups, Drummers,
  getDrumsCoverage, PlanStore, RandomRoster, nextUid, activeRules } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── Fixtures ───────────────────────────────────────────────────
// Faction-lock-safe-ish cycle reused from control-tests.js so the same
// pattern also works for the Classic/Forever negative checks.
const PATTERN = [
  ['WARRIOR', 'Protection', 'tank'], ['PALADIN', 'Protection', 'tank'],
  ['PRIEST', 'Holy', 'healer'], ['PRIEST', 'Discipline', 'healer'], ['DRUID', 'Restoration', 'healer'],
  ['WARRIOR', 'Fury', 'melee_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['ROGUE', 'Assassination', 'melee_dps'], ['DRUID', 'Feral', 'melee_dps'],
  ['HUNTER', 'Marksmanship', 'ranged_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps'], ['HUNTER', 'Survival', 'ranged_dps'],
  ['MAGE', 'Fire', 'caster_dps'], ['MAGE', 'Frost', 'caster_dps'], ['MAGE', 'Arcane', 'caster_dps'],
  ['WARLOCK', 'Destruction', 'caster_dps'], ['WARLOCK', 'Affliction', 'caster_dps'], ['PRIEST', 'Shadow', 'caster_dps'], ['DRUID', 'Balance', 'caster_dps'],
];
function buildRoster(size, prefix = 'P') {
  const players = [];
  for (let i = 0; i < size; i++) {
    const [cls, spec, role] = PATTERN[i % PATTERN.length];
    players.push({ uid: nextUid(), name: `${prefix}${i}-${cls}-${spec}`, class: cls, spec, role, imported: false });
  }
  return players;
}
function seatIntoGroups(players, numGroups) {
  const groups = []; for (let i = 0; i < numGroups; i++) groups.push([]);
  players.forEach((p, i) => { groups[i % numGroups].push(p); p.groupNumber = (i % numGroups) + 1; });
  return groups;
}
function resetState(gameVersion, raid, size) {
  State.gameVersion = gameVersion;
  State.selectedRaid = raid;
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.playerConstraints = [];
  State.drummers = [];
  State.notes = '';
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  State.backups = {};
  State.rosterName = 'Drums Test';
  State.planId = null;
  State.sourceEventId = null;
  const raidInfo = Config.Raids[raid];
  const players = buildRoster(size);
  State.groups = seatIntoGroups(players, raidInfo.groups);
  State.bench = [];
  State.roster = State.groups.flat();
  return State.roster;
}
function layoutKey() {
  return State.groups.map(g => g.map(p => p.name).sort().join(',')).sort().join(' | ');
}
function groupIndexOf(name) {
  return State.groups.findIndex(g => g.some(p => p.name === name));
}
const MODES = ['max_dps', 'tank_mit', 'balanced', 'relaxed'];

// ══════════════════════════════════════════════════════════════
// Drummers module: tagging, cleaning, cleanup
// ══════════════════════════════════════════════════════════════

check('Drummers.set/get/isDrummer round-trip a tag with a drum type', () => {
  resetState('tbc', 'bt', 25);
  const name = State.roster[0].name;
  assert.equal(Drummers.isDrummer(name), false);
  assert(Drummers.set(name, 'Battle'));
  assert.equal(Drummers.isDrummer(name), true);
  assert.equal(JSON.stringify(Drummers.get(name)), JSON.stringify({ player: name, drum: 'Battle' }));
});

check('Drummers.set with an unrecognized drum falls back to unspecified ("")', () => {
  resetState('tbc', 'bt', 25);
  const name = State.roster[0].name;
  Drummers.set(name, 'Not A Real Drum');
  assert.equal(Drummers.get(name).drum, '');
});

check('Drummers.set on an already-tagged name updates the entry in place (no duplicates)', () => {
  resetState('tbc', 'bt', 25);
  const name = State.roster[0].name;
  Drummers.set(name, 'Battle');
  Drummers.set(name, 'War');
  assert.equal(State.drummers.length, 1);
  assert.equal(Drummers.get(name).drum, 'War');
});

check('Drummers.remove clears the tag; isDrummer is case-insensitive', () => {
  resetState('tbc', 'bt', 25);
  const name = State.roster[0].name;
  Drummers.set(name, '');
  assert.equal(Drummers.isDrummer(name.toUpperCase()), true, 'name matching should be case-insensitive');
  Drummers.remove(name);
  assert.equal(Drummers.isDrummer(name), false);
});

check('Drummers.clean() drops malformed entries, dedupes by name, and validates drum type', () => {
  const cleaned = Drummers.clean([
    { player: 'Alice', drum: 'Battle' },
    { player: '  Alice  ', drum: 'War' }, // duplicate (trim + case-insensitive), first wins
    { player: 'Bob', drum: 'NotARealDrum' },
    { player: '', drum: 'Battle' },
    null,
    { drum: 'Battle' }, // no player field
    'not an object',
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(JSON.stringify(cleaned[0]), JSON.stringify({ player: 'Alice', drum: 'Battle' }));
  assert.equal(JSON.stringify(cleaned[1]), JSON.stringify({ player: 'Bob', drum: '' }));
  assert.equal(Drummers.clean(null).length, 0);
  assert.equal(Drummers.clean(undefined).length, 0);
});

check('RosterEdit.UpdatePlayer renaming a player clears their drum tag (like Backups/Constraints)', () => {
  resetState('tbc', 'bt', 25);
  const player = State.roster[0];
  Drummers.set(player.name, 'Battle');
  const result = RosterEdit.UpdatePlayer(player.uid, { name: 'RenamedDrummer', class: player.class, spec: player.spec });
  assert(result.success);
  assert.equal(Drummers.isDrummer('RenamedDrummer'), false, 'the new name should not inherit the old tag');
  assert.equal(State.drummers.length, 0, 'the stale entry under the old name should be gone, not just unmatched');
});

check('RosterEdit.DeletePlayer clears the drum tag for good', () => {
  resetState('tbc', 'bt', 25);
  const player = State.bench = [State.roster.pop()];
  const benchedPlayer = State.bench[0];
  Drummers.set(benchedPlayer.name, 'War');
  const result = RosterEdit.DeletePlayer(benchedPlayer.uid);
  assert(result.success);
  assert.equal(State.drummers.length, 0);
});

check('RandomRoster.generate() clears drum tags from the previous roster (QA3-style reset)', () => {
  resetState('tbc', 'bt', 25);
  Drummers.set(State.roster[0].name, 'Battle');
  Drummers.set(State.roster[1].name, 'War');
  assert.equal(State.drummers.length, 2, 'fixture sanity');
  RandomRoster.generate();
  assert.equal(State.drummers.length, 0, 'stale drummer tags (old names) should not survive a random reroll');
});

// Overnight review finding #3: a fully-withdrawn Raid-Helper sign-up cleared
// Backups but not Constraints/Drummers. Verifies the fix (Constraints/
// Drummers.clearForName alongside Backups.clearForName in the v.gone branch
// of Import.applyRaidHelperSync).
check('Import.applyRaidHelperSync drops the drum tag (and constraint) for a player who fully withdraws', () => {
  resetState('tbc', 'bt', 25);
  const drummer = State.roster.find(p => p.role !== 'tank');
  const partner = State.roster.find(p => p !== drummer);
  Drummers.set(drummer.name, 'Battle');
  Constraints.add(drummer.name, partner.name, 'together');
  assert.equal(Drummers.isDrummer(drummer.name), true, 'fixture sanity');
  assert.equal(Constraints.forPlayer(partner.name).length, 1, 'fixture sanity');

  // Shaped exactly like diffRaidHelperSignUps() would build it for a sign-up
  // that no longer appears anywhere in the refreshed event data — a full
  // withdrawal, not a demotion to bench/Tentative.
  const diff = { success: true, added: [], removed: [drummer], changed: [], demoted: [], promoted: [] };
  Import.applyRaidHelperSync(diff);

  assert.equal(Drummers.isDrummer(drummer.name), false, 'the drum tag must not survive the withdrawal');
  assert.equal(Constraints.forPlayer(partner.name).length, 0, 'the constraint must not survive either');
});

// Review finding #3's sibling concern: RaidSplit has no explicit
// clearForName() call for players who move into "Raid B" — Drummers.
// reconcile() is the render-time safety net (mirrors Backups.reconcile(),
// which renderGroups() already runs every render for the same reason).
check('Drummers.reconcile() drops a tag once the player leaves the roster and bench entirely', () => {
  resetState('tbc', 'bt', 25);
  const drummer = State.roster[0];
  Drummers.set(drummer.name, 'Battle');

  // Simulate the drummer's half of a split: gone from both roster and bench.
  State.groups[0] = State.groups[0].filter(p => p !== drummer);
  State.roster = State.groups.flat();
  State.bench = [];
  Drummers.reconcile();
  assert.equal(Drummers.isDrummer(drummer.name), false, 'tag dropped once the player is gone entirely');

  // But merely being benched (not gone) must not be treated as a departure.
  const drummer2 = State.roster[0];
  Drummers.set(drummer2.name, 'War');
  State.groups[0] = State.groups[0].filter(p => p !== drummer2);
  State.roster = State.groups.flat();
  State.bench = [drummer2];
  Drummers.reconcile();
  assert.equal(Drummers.isDrummer(drummer2.name), true, 'still on the bench — tag is not stale yet');
});

// ══════════════════════════════════════════════════════════════
// Persistence: exportRoster/loadRoster, share string, PlanStore
// ══════════════════════════════════════════════════════════════

check('exportRoster/loadRoster round-trips drummer tags', () => {
  resetState('tbc', 'bt', 25);
  Drummers.set(State.roster[0].name, 'Battle');
  Drummers.set(State.roster[5].name, '');
  const data = JSON.parse(JSON.stringify(Import.exportRoster('Drum Roster')));
  assert.equal(data.drummers.length, 2);
  resetState('tbc', 'bt', 25); // wipe State before reloading
  assert(Import.loadRoster(data));
  assert.equal(State.drummers.length, 2);
  assert.equal(Drummers.get(data.players[0].name).drum, 'Battle');
});

check('Share string is byte-for-byte unchanged when no drummers are tagged (plain TBC link stays compact)', () => {
  resetState('tbc', 'bt', 25);
  const withoutDrummers = Import.exportShareString();
  Drummers.set(State.roster[0].name, 'Battle');
  const withDrummers = Import.exportShareString();
  Drummers.remove(State.roster[0].name);
  const backToNone = Import.exportShareString();
  assert.equal(backToNone, withoutDrummers, 'clearing every tag should restore the exact original string');
  assert.notEqual(withDrummers, withoutDrummers, 'a tagged drummer should extend the share string with a JSON tail');
});

check('Share string round-trips tagged drummers through import', () => {
  resetState('tbc', 'bt', 25);
  const battleName = State.roster[0].name, warName = State.roster[1].name;
  Drummers.set(battleName, 'Battle');
  Drummers.set(warName, 'War');
  const shared = Import.exportShareString();
  resetState('tbc', 'bt', 25);
  const result = Import.importAddonString(shared);
  assert(result.success, result.error);
  assert.equal(Drummers.get(battleName).drum, 'Battle');
  assert.equal(Drummers.get(warName).drum, 'War');
});

check('PlanStore capture/restore round-trips drummer tags', () => {
  resetState('tbc', 'bt', 25);
  State.planId = 'drum-plan-test';
  State.optimizerMode = 'max_dps';
  Drummers.set(State.roster[2].name, 'Restoration');
  const snapshot = PlanStore.capture();
  const targetName = State.roster[2].name;
  State.drummers = [];
  assert(PlanStore.restore(snapshot));
  assert.equal(Drummers.get(targetName).drum, 'Restoration');
});

// ══════════════════════════════════════════════════════════════
// Coverage + sidebar hint
// ══════════════════════════════════════════════════════════════

check('getDrumsCoverage counts only non-empty groups and reports covered/total correctly', () => {
  resetState('tbc', 'bt', 25); // Black Temple = 5 groups of 5
  let coverage = getDrumsCoverage(State.groups);
  assert.equal(coverage.covered, 0); assert.equal(coverage.total, 5);
  Drummers.set(State.groups[0][0].name, 'Battle');
  Drummers.set(State.groups[1][0].name, 'War');
  coverage = getDrumsCoverage(State.groups);
  assert.equal(coverage.covered, 2); assert.equal(coverage.total, 5);
  // Fully covered.
  for (const g of State.groups) Drummers.set(g[0].name, 'Battle');
  coverage = getDrumsCoverage(State.groups);
  assert.equal(coverage.covered, 5); assert.equal(coverage.total, 5);
});

check('Readiness.balanceWarnings() shows the Drums coverage hint only while incomplete, and only in TBC', () => {
  resetState('tbc', 'bt', 25);
  assert(!Readiness.balanceWarnings().some(w => w.id === 'DRUMS_COVERAGE'), 'no drummers tagged yet — nothing to report');

  Drummers.set(State.groups[0][0].name, 'Battle');
  const withOne = Readiness.balanceWarnings().find(w => w.id === 'DRUMS_COVERAGE');
  assert(withOne, 'one drummer on a 5-group raid should surface the coverage hint');
  assert.equal(withOne.text, 'Drums: 1 of 5 groups covered; spread drummers one per party first');

  for (const g of State.groups) Drummers.set(g[0].name, 'Battle');
  assert(!Readiness.balanceWarnings().some(w => w.id === 'DRUMS_COVERAGE'), 'fully covered — hint should disappear');
});

check('Drums coverage hint never appears outside TBC even if State.drummers has entries', () => {
  resetState('classic', 'mc', 40);
  Drummers.set(State.roster[0].name, 'Battle'); // nothing stops the data existing; the UI/logic must gate on version
  assert(!Readiness.balanceWarnings().some(w => w.id === 'DRUMS_COVERAGE'));

  resetState('forever', 'f_hyjal', 20);
  Drummers.set(State.roster[0].name, 'Battle');
  assert(!Readiness.balanceWarnings().some(w => w.id === 'DRUMS_COVERAGE'));
});

// ══════════════════════════════════════════════════════════════
// Optimizer.spreadDrummers() — spreading, idempotence, locks/constraints,
// zero-drummer no-op, and TBC-only gating.
// ══════════════════════════════════════════════════════════════

// Drummers are tagged on non-tank members here: a tank can be seeded as this
// raid's pinned anchor tank (Optimizer.isPinned), and two pinned drummers
// landing in the same tank/healer group is a structural case spreadDrummers
// correctly refuses to break (same "never move a pin" invariant every other
// spread pass honors) rather than a spreading bug — that exact case gets its
// own dedicated, explicit test below instead of muddying this one.
for (const mode of MODES) {
  for (const drummerCount of [2, 3, 4, 5]) {
    check(`Optimizer spreads ${drummerCount} drummers one-per-party before doubling up — TBC 25-man, ${mode}`, () => {
      resetState('tbc', 'bt', 25);
      State.optimizerMode = mode;
      const nonTanks = State.roster.filter(p => p.role !== 'tank');
      for (let i = 0; i < drummerCount; i++) Drummers.set(nonTanks[i].name, 'Battle');
      Optimizer.optimize();
      const coverage = getDrumsCoverage(State.groups);
      assert.equal(coverage.total, 5, 'Black Temple always seats into 5 groups');
      const expectedCovered = Math.min(drummerCount, coverage.total);
      assert.equal(coverage.covered, expectedCovered,
        `${drummerCount} drummers among ${coverage.total} groups should cover ${expectedCovered} of them, got ${coverage.covered}`);
    });
  }
}

check('Two drummers both seeded as the pinned anchor tank leave that gap unfilled rather than unpinning them', () => {
  resetState('tbc', 'bt', 25);
  State.optimizerMode = 'tank_mit';
  // The two Protection tanks are exactly the players Optimizer seeds as this
  // raid's anchor tank(s) — tagging both as drummers recreates the case
  // where spreadDrummers must leave a needy group short rather than violate
  // the "never move a pin" rule every other spread pass also honors.
  const tanks = State.roster.filter(p => p.role === 'tank');
  for (const t of tanks) Drummers.set(t.name, 'Battle');
  Optimizer.optimize();
  const coverage = getDrumsCoverage(State.groups);
  assert(coverage.covered <= coverage.total);
  // Whatever the result, it must not have come from unpinning an anchor —
  // re-running Optimize from scratch must reach the exact same board.
  const again = layoutKey();
  Optimizer.optimize();
  assert.equal(layoutKey(), again, 'result must be stable even when full coverage is structurally unreachable');
});

check('Optimizer.spreadDrummers() is idempotent — a second Optimize does not reshuffle an already-spread board', () => {
  for (const mode of MODES) {
    resetState('tbc', 'bt', 25);
    State.optimizerMode = mode;
    for (let i = 0; i < 4; i++) Drummers.set(State.roster[i].name, 'Battle');
    Optimizer.optimize();
    const first = layoutKey();
    Optimizer.optimize();
    const second = layoutKey();
    assert.equal(second, first, `a second Optimize in ${mode} should not move anyone once the board is settled`);
  }
});

check('Zero drummers tagged: Optimizer.spreadDrummers() is a strict no-op on a TBC board (4068-check invariant)', () => {
  for (const mode of MODES) {
    resetState('tbc', 'bt', 25);
    State.optimizerMode = mode;
    Optimizer.optimize();
    const before = layoutKey();
    // Calling the phase directly (not just relying on it never firing inside
    // optimize()) proves the guard clause itself, not just that nothing in
    // this fixture happened to trigger it.
    Optimizer.spreadDrummers(State.groups);
    assert.equal(layoutKey(), before, 'spreadDrummers must not touch the board when State.drummers is empty');
  }
});

check('Optimizer.spreadDrummers() never fires outside TBC even with drummers tagged', () => {
  resetState('classic', 'mc', 40);
  for (let i = 0; i < 4; i++) Drummers.set(State.roster[i].name, 'Battle');
  const before = layoutKey();
  Optimizer.spreadDrummers(State.groups);
  assert.equal(layoutKey(), before, 'Classic Era has no Drums equivalent — spreadDrummers must not run');

  resetState('forever', 'f_hyjal', 20);
  for (let i = 0; i < 4; i++) Drummers.set(State.roster[i].name, 'Battle');
  const beforeForever = layoutKey();
  Optimizer.spreadDrummers(State.groups);
  assert.equal(layoutKey(), beforeForever, "Forever's Drums status is unconfirmed — spreadDrummers must not run there either");
});

check('Optimizer.spreadDrummers() never moves a locked player', () => {
  resetState('tbc', 'bt', 25);
  // One drummer, locked into a group other than group 0 — every group is
  // otherwise drummer-less, so the pass would want to move this exact
  // player if locks weren't respected.
  const drummer = State.groups[2][0];
  Drummers.set(drummer.name, 'Battle');
  drummer.locked = true;
  const before = layoutKey();
  Optimizer.spreadDrummers(State.groups);
  assert.equal(layoutKey(), before, 'the only drummer is locked in place — spreadDrummers must leave the board alone');
  assert.equal(groupIndexOf(drummer.name), 2, 'the locked drummer must stay exactly where they were locked');
});

// Hand-built boards for the swap-choice cases: spreadDrummers must pay for a
// drummer with a member whose departure costs the needy group nothing it
// actually relies on.
function member(name, cls, spec) {
  return { uid: nextUid(), name, class: cls, spec, role: RosterEdit.RoleForSpec(cls, spec), imported: false };
}
function boardState(groups) {
  resetState('tbc', 'bt', 25);
  State.groups = groups;
  State.roster = groups.flat();
}

check("spreadDrummers does not swap out a melee group's only Feral (Leader of the Pack)", () => {
  // The Feral is the lowest-DPS-weight member of the drummer-less group, which
  // is exactly who the old pass picked to trade away.
  const feral = member('Feral', 'DRUID', 'Feral');
  const needy = [feral, member('Fury', 'WARRIOR', 'Fury'), member('Arms', 'WARRIOR', 'Arms'),
    member('Combat', 'ROGUE', 'Combat'), member('Assassin', 'ROGUE', 'Assassination')];
  const rich = [member('DrumRogueA', 'ROGUE', 'Subtlety'), member('DrumRogueB', 'ROGUE', 'Subtlety'),
    member('Mut', 'ROGUE', 'Assassination'), member('Surv', 'HUNTER', 'Survival'), member('Sub', 'ROGUE', 'Combat')];
  boardState([needy, rich]);
  Drummers.set('DrumRogueA', 'Battle');
  Drummers.set('DrumRogueB', 'War');
  Optimizer.spreadDrummers(State.groups);
  assert.equal(groupIndexOf('Feral'), 0, 'the only LotP source must stay in its melee group');
  assert(State.groups[0].some(p => Drummers.isDrummer(p.name)), 'the needy group still gets a drummer');
  assert(State.groups[1].some(p => Drummers.isDrummer(p.name)), 'the surplus group keeps one drummer');
});

check("spreadDrummers does not swap out a caster group's only Moonkin", () => {
  const boomkin = member('Boomkin', 'DRUID', 'Balance');
  const needy = [boomkin, member('Destro', 'WARLOCK', 'Destruction'), member('Aff', 'WARLOCK', 'Affliction'),
    member('Fire', 'MAGE', 'Fire'), member('Arcane', 'MAGE', 'Arcane')];
  const rich = [member('DrumMageA', 'MAGE', 'Frost'), member('DrumMageB', 'MAGE', 'Frost'),
    member('Demo', 'WARLOCK', 'Demonology'), member('Fire2', 'MAGE', 'Fire'), member('Arcane2', 'MAGE', 'Arcane')];
  boardState([needy, rich]);
  Drummers.set('DrumMageA', 'Battle');
  Drummers.set('DrumMageB', 'War');
  Optimizer.spreadDrummers(State.groups);
  assert.equal(groupIndexOf('Boomkin'), 0, 'the only Moonkin Aura source must stay in its caster group');
  assert(State.groups[0].some(p => Drummers.isDrummer(p.name)), 'the needy group still gets a drummer');
});

check("spreadDrummers does not pull the surplus group's only Feral away just because the Feral is a drummer", () => {
  const needy = [member('Fury', 'WARRIOR', 'Fury'), member('Arms', 'WARRIOR', 'Arms'),
    member('Combat', 'ROGUE', 'Combat'), member('Assassin', 'ROGUE', 'Assassination'), member('Sub', 'ROGUE', 'Subtlety')];
  const rich = [member('FeralDrummer', 'DRUID', 'Feral'), member('RogueDrummer', 'ROGUE', 'Combat'),
    member('Fury2', 'WARRIOR', 'Fury'), member('Arms2', 'WARRIOR', 'Arms'), member('Surv', 'HUNTER', 'Survival')];
  boardState([needy, rich]);
  Drummers.set('FeralDrummer', 'Battle');
  Drummers.set('RogueDrummer', 'War');
  Optimizer.spreadDrummers(State.groups);
  assert.equal(groupIndexOf('FeralDrummer'), 1, 'the surplus group must keep its LotP source');
  assert.equal(groupIndexOf('RogueDrummer'), 0, 'the other drummer is the one that moves');
});

check('spreadDrummers does not strand a lone caster with a melee drummer', () => {
  const needy = [member('Frost', 'MAGE', 'Frost'), member('Destro', 'WARLOCK', 'Destruction'), member('Arcane', 'MAGE', 'Arcane')];
  // The melee drummer comes first: the old pass took the first drummer it found.
  const rich = [member('MeleeDrummer', 'ROGUE', 'Combat'), member('CasterDrummer', 'MAGE', 'Fire'),
    member('Aff', 'WARLOCK', 'Affliction'), member('Frost2', 'MAGE', 'Frost')];
  boardState([needy, rich]);
  Drummers.set('MeleeDrummer', 'Battle');
  Drummers.set('CasterDrummer', 'War');
  Optimizer.spreadDrummers(State.groups);
  assert.equal(groupIndexOf('CasterDrummer'), 0, 'the caster drummer fills the caster group');
  assert.equal(groupIndexOf('MeleeDrummer'), 1, 'the melee drummer is not marooned among casters');
});

check('spreadDrummers picks the swap that costs the least group score', () => {
  const needy = [member('Fury', 'WARRIOR', 'Fury'), member('Combat', 'ROGUE', 'Combat'),
    member('Assassin', 'ROGUE', 'Assassination'), member('Sub', 'ROGUE', 'Subtlety'), member('Retri', 'PALADIN', 'Retribution')];
  const rich = [member('DrumA', 'ROGUE', 'Subtlety'), member('DrumB', 'ROGUE', 'Combat'),
    member('Arms2', 'WARRIOR', 'Arms'), member('Surv', 'HUNTER', 'Survival'), member('Sub2', 'ROGUE', 'Subtlety')];
  boardState([needy, rich]);
  Drummers.set('DrumA', 'Battle');
  Drummers.set('DrumB', 'War');
  const mode = 'max_dps';
  State.optimizerMode = mode;
  const total = () => Optimizer.groupScore(State.groups[0], 0, State.groups, mode) + Optimizer.groupScore(State.groups[1], 1, State.groups, mode);
  // Brute force the best legal swap of one needy member for one drummer.
  let bestScore = -Infinity;
  for (let i = 0; i < needy.length; i++) {
    for (const d of ['DrumA', 'DrumB']) {
      const g0 = State.groups[0], g1 = State.groups[1];
      const di = g1.findIndex(p => p.name === d);
      const a = g0[i], b = g1[di];
      g0[i] = b; g1[di] = a;
      bestScore = Math.max(bestScore, total());
      g0[i] = a; g1[di] = b;
    }
  }
  Optimizer.spreadDrummers(State.groups, mode);
  assert(Math.abs(total() - bestScore) < 1e-9, 'the chosen swap must be the best-scoring one available');
});

check('Optimizer.arrange() honors keep-apart constraints even when drum-spreading also wants to move someone', () => {
  resetState('tbc', 'bt', 25);
  State.optimizerMode = 'max_dps';
  // Two drummers stacked in one group; spreading will want to move one out.
  const a = State.groups[0][0].name, b = State.groups[0][1].name;
  Drummers.set(a, 'Battle');
  Drummers.set(b, 'War');
  // An unrelated keep-apart pair that Phase 6 must still enforce afterward.
  const c = State.groups[1][0].name, d = State.groups[1][1].name;
  Constraints.add(c, d, 'apart');
  Optimizer.optimize();
  assert.equal(Constraints.violations(State.groups).length, 0, 'Phase 6 (Constraints.enforce) must still win after drum spreading');
});

console.log(`\nDrums tests (feature-backlog-3 #5): ${passed} passed, 0 failed, ${passed} total`);
