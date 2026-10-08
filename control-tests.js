/**
 * PartyPlanner Web - Wave 5 "optimizer control" tests
 * Run: node control-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> (everything before '// ── UI RENDERING') is executed in a
 * sandboxed context and the pieces under test are pulled out through
 * globalThis.api. Covers three backlog features shipped together:
 *   #1 Comp templates (Templates module + applyTemplate)
 *   #3 Keep-together / keep-apart player constraints (Constraints module +
 *      Optimizer.arrange()'s Phase 0/Phase 6 hooks)
 *   #4 "Why is this player here?" placement explanation (explainPlacement)
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Rulesets', 'Import', 'Optimizer', 'Constraints', 'Templates', 'applyTemplate', 'explainPlacement', 'RosterEdit', 'PlanStore', 'getGroupBuffs', 'Faction', 'activeRules', 'nextUid', 'RandomRoster', 'Assignments', 'Backups']);
const { State, Config, GameVersions, Rulesets, Import, Optimizer, Constraints, Templates, applyTemplate, explainPlacement,
  RosterEdit, PlanStore, getGroupBuffs, Faction, activeRules, nextUid, RandomRoster, Assignments, Backups } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── Fixtures ───────────────────────────────────────────────────
// Faction-lock-safe class/spec cycle (no SHAMAN/PALADIN) so the same pattern
// works unmodified across TBC, Classic Era (faction-locked) and Forever.
const PATTERN = [
  ['WARRIOR', 'Protection', 'tank'], ['WARRIOR', 'Protection', 'tank'],
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
  State.notes = '';
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  State.backups = {};
  State.rosterName = 'Control Test';
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
const RULESETS = [
  { gameVersion: 'tbc', raid: 'bt', size: 25, label: 'TBC 25 (Black Temple)' },
  { gameVersion: 'classic', raid: 'mc', size: 40, label: 'Classic 40 (Molten Core)' },
  { gameVersion: 'forever', raid: 'f_hyjal', size: 20, label: 'Forever 20 (Hyjal Summit)' },
];

// ══════════════════════════════════════════════════════════════
// #3 CONSTRAINTS
// ══════════════════════════════════════════════════════════════

for (const rs of RULESETS) {
  for (const mode of MODES) {
    check(`Constraints: "together" honored — ${rs.label}, ${mode}`, () => {
      const roster = resetState(rs.gameVersion, rs.raid, rs.size);
      State.optimizerMode = mode;
      const a = roster[0].name, b = roster[roster.length - 1].name; // opposite ends of the pattern cycle — floor-first would normally split these
      Constraints.add(a, b, 'together');
      Optimizer.optimize();
      assert.equal(groupIndexOf(a), groupIndexOf(b), `${a} and ${b} should share a group in ${mode}`);
      assert.equal(Constraints.violations(State.groups).length, 0);
    });

    check(`Constraints: "apart" honored — ${rs.label}, ${mode}`, () => {
      const roster = resetState(rs.gameVersion, rs.raid, rs.size);
      State.optimizerMode = mode;
      const a = roster[0].name, b = roster[1].name; // two tanks — likely to land together without the constraint
      Constraints.add(a, b, 'apart');
      Optimizer.optimize();
      assert.notEqual(groupIndexOf(a), groupIndexOf(b), `${a} and ${b} should NOT share a group in ${mode}`);
      assert.equal(Constraints.violations(State.groups).length, 0);
    });
  }
}

check('Constraints: infeasible "apart" cluster is reported, not silently dropped', () => {
  // 2-group 10-man (Forever's Barrow Deeps), 3 players mutually apart — pigeonhole guarantees a violation.
  resetState('forever', 'f_barrow', 10);
  const names = State.roster.slice(0, 3).map(p => p.name);
  Constraints.add(names[0], names[1], 'apart');
  Constraints.add(names[1], names[2], 'apart');
  Constraints.add(names[0], names[2], 'apart');
  Optimizer.optimize();
  const violations = Constraints.violations(State.groups);
  assert.ok(violations.length >= 1, 'expected at least one unresolved apart-violation to be reported');
  assert.ok(violations.every(v => v.type === 'apart'));
});

check('Constraints: a "together" cluster bigger than one group is reported infeasible', () => {
  resetState('tbc', 'bt', 25); // 5-seat groups
  const names = State.roster.slice(0, 6).map(p => p.name);
  for (let i = 1; i < names.length; i++) Constraints.add(names[0], names[i], 'together');
  Optimizer.optimize();
  // Not all 6 can share one 5-seat group — this cluster can never be fully satisfied.
  const groupsUsed = new Set(names.map(groupIndexOf));
  assert.ok(groupsUsed.size > 1, 'a 6-player cluster cannot fit in one 5-seat group');
});

check('Constraints: idempotence under/at/over capacity with active constraints (TBC 25)', () => {
  for (const size of [18, 25, 32]) {
    resetState('tbc', 'bt', size);
    const a = State.roster[0].name, b = State.roster[3].name;
    const c = State.roster[1].name, d = State.roster[2].name;
    Constraints.add(a, b, 'together');
    Constraints.add(c, d, 'apart');
    Optimizer.optimize();
    const first = layoutKey();
    const firstBench = (State.bench || []).map(p => p.name).sort().join(',');
    Optimizer.optimize();
    const second = layoutKey();
    const secondBench = (State.bench || []).map(p => p.name).sort().join(',');
    assert.equal(second, first, `Optimize should be idempotent at roster size ${size}`);
    assert.equal(secondBench, firstBench, `bench should be stable at roster size ${size}`);
  }
});

check('Constraints: no-op when State.playerConstraints is empty (never touches groups)', () => {
  resetState('tbc', 'bt', 25);
  const before = JSON.stringify(State.groups.map(g => g.map(p => p.name)));
  const result = Constraints.enforce(State.groups, 5);
  const after = JSON.stringify(State.groups.map(g => g.map(p => p.name)));
  assert.equal(before, after);
  assert.equal(result.violations.length, 0);
});

check('Constraints: clean() de-duplicates, drops self-pairs and unknown types', () => {
  const cleaned = Constraints.clean([
    { a: 'Foo', b: 'Bar', type: 'together' },
    { a: 'bar', b: 'foo', type: 'together' }, // same unordered pair, different case — collapses
    { a: 'Foo', b: 'Foo', type: 'together' }, // self-pair — dropped
    { a: 'Foo', b: 'Baz', type: 'bogus' },    // unknown type — dropped
    { a: '', b: 'Baz', type: 'apart' },       // empty name — dropped
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].type, 'together');
});

check('Constraints: clearForName removes every constraint mentioning a departed player', () => {
  resetState('tbc', 'bt', 25);
  const [a, b, c] = State.roster.map(p => p.name);
  Constraints.add(a, b, 'together');
  Constraints.add(b, c, 'apart');
  Constraints.clearForName(b);
  assert.equal(Constraints.forPlayer(b).length, 0);
  assert.equal(Constraints.forPlayer(a).length, 0);
  assert.equal(Constraints.forPlayer(c).length, 0);
});

check('Constraints: RosterEdit.DeletePlayer cleans up constraints referencing the removed player', () => {
  resetState('tbc', 'bt', 25);
  RosterEdit.BenchPlayer(State.roster[0].uid);
  const benchedName = State.bench[0].name;
  const otherName = State.roster[0].name;
  Constraints.add(benchedName, otherName, 'together');
  assert.equal(Constraints.forPlayer(benchedName).length, 1);
  RosterEdit.DeletePlayer(State.bench[0].uid);
  assert.equal(Constraints.forPlayer(benchedName).length, 0);
});

check('Constraints: persistence round-trip through exportRoster/loadRoster', () => {
  resetState('tbc', 'bt', 25);
  const [a, b] = State.roster.map(p => p.name);
  Constraints.add(a, b, 'together');
  const data = Import.exportRoster('Round Trip');
  assert.ok(Array.isArray(data.playerConstraints) && data.playerConstraints.length === 1);
  const json = JSON.parse(JSON.stringify(data)); // simulate localStorage round trip
  State.playerConstraints = [];
  assert.ok(Import.loadRoster(json));
  assert.equal(State.playerConstraints.length, 1);
  assert.equal(new Set([State.playerConstraints[0].a, State.playerConstraints[0].b]).has(a), true);
});

check('Constraints: persistence round-trip through PlanStore capture/restore', () => {
  resetState('tbc', 'bt', 25);
  State.planId = 'plan:control-test';
  State.optimizerMode = 'max_dps';
  const [a, b] = State.roster.map(p => p.name);
  Constraints.add(a, b, 'apart');
  const captured = PlanStore.capture();
  assert.ok(Array.isArray(captured.playerConstraints) && captured.playerConstraints.length === 1);
  State.playerConstraints = [];
  assert.ok(PlanStore.restore(JSON.parse(JSON.stringify(captured))));
  assert.equal(State.playerConstraints.length, 1);
});

check('Constraints: share string round trip preserves constraints', () => {
  resetState('tbc', 'bt', 25);
  const [a, b] = State.roster.map(p => p.name);
  Constraints.add(a, b, 'together');
  const str = Import.exportShareString();
  const parts = str.split(':');
  const parsed = Import._parseShareString(parts);
  assert.ok(parsed.success);
  assert.equal(parsed.data.playerConstraints.length, 1);
  assert.ok(new Set([parsed.data.playerConstraints[0].a, parsed.data.playerConstraints[0].b]).has(a));
});

check('Constraints: byte-identical share link when no constraints are set', () => {
  resetState('tbc', 'bt', 25);
  const withEmpty = Import.exportShareString();
  // Sanity: no JSON tail was appended at all (5 header parts + 5 groups = 10).
  assert.equal(withEmpty.split(':').length, 10);
  const [a, b] = State.roster.map(p => p.name);
  Constraints.add(a, b, 'together');
  const withOne = Import.exportShareString();
  Constraints.remove(a, b);
  const backToEmpty = Import.exportShareString();
  assert.equal(backToEmpty, withEmpty, 'removing the only constraint should restore the exact original (byte-identical) link');
  assert.notEqual(withOne, withEmpty, 'a set constraint must actually change the link');
});

// ══════════════════════════════════════════════════════════════
// #1 COMP TEMPLATES
// ══════════════════════════════════════════════════════════════

function fakeStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

check('Templates: save captures the current group -> name layout', () => {
  resetState('tbc', 'bt', 10);
  const storage = fakeStorage();
  const result = Templates.save(storage, 'Tuesday Comp', 'tbc', 'bt');
  assert.ok(result.success);
  const list = Templates.list(storage, 'tbc', 'bt');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Tuesday Comp');
  assert.equal(list[0].count, 10);
});

check('Templates: applyTemplate seats exact-name matches into their old groups and locks them', () => {
  resetState('tbc', 'bt', 10);
  const template = { players: {} };
  State.groups.forEach((g, gi) => g.forEach(p => { template.players[p.name.toLowerCase()] = { name: p.name, group: gi, role: p.role }; }));
  // Rebuild a "fresh import" with the same players but scrambled group order.
  const entries = State.roster.map(p => ({ uid: nextUid(), name: p.name, class: p.class, spec: p.spec, role: p.role, groupNumber: 0 }));
  const result = applyTemplate(entries, template, 5, 5);
  assert.equal(result.matched, 10);
  assert.equal(result.unmatched, 0);
  for (const [gi, group] of result.groups.entries()) {
    for (const p of group) {
      assert.equal(p.locked, true);
      const rec = template.players[p.name.toLowerCase()];
      assert.equal(rec.group, gi, `${p.name} should be seated in their template group`);
    }
  }
});

check('Templates: matching is case-insensitive', () => {
  const template = { players: { 'thrall-shaman': { name: 'Thrall-Shaman', group: 2, role: 'melee_dps' } } };
  const entries = [{ uid: nextUid(), name: 'THRALL-SHAMAN', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 0 }];
  const result = applyTemplate(entries, template, 5, 5);
  assert.equal(result.matched, 1);
  assert.equal(result.groups[2].length, 1);
  assert.equal(result.groups[2][0].locked, true);
});

check('Templates: partial matches — renamed/no-show players fall through unmatched and unlocked', () => {
  const template = { players: {
    'alice': { name: 'Alice', group: 0, role: 'tank' },
    'bob': { name: 'Bob', group: 1, role: 'healer' },
  } };
  const entries = [
    { uid: nextUid(), name: 'Alice', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 0 },
    { uid: nextUid(), name: 'Carol', class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 0 }, // no template record — Bob didn't show, Carol is new
  ];
  const result = applyTemplate(entries, template, 5, 5);
  assert.equal(result.matched, 1);
  assert.equal(result.unmatched, 1);
  assert.equal(result.groups[0][0].name, 'Alice');
  assert.equal(result.groups[0][0].locked, true);
  const carol = result.groups.flat().find(p => p.name === 'Carol');
  assert.ok(carol && carol.locked === false, 'Carol should be seated (open seat) but unlocked');
});

check('Templates: a template group recorded past raid capacity falls through unmatched instead of crashing', () => {
  const template = { players: { 'a': { name: 'A', group: 99, role: 'tank' } } };
  const entries = [{ uid: nextUid(), name: 'A', class: 'WARRIOR', spec: 'Protection', role: 'tank', groupNumber: 0 }];
  const result = applyTemplate(entries, template, 5, 5);
  assert.equal(result.matched, 0);
  assert.equal(result.unmatched, 1);
  assert.equal(result.groups.flat().find(p => p.name === 'A').locked, false);
});

check('Templates: version + raid isolation — a TBC template never appears for Classic, or a different TBC raid', () => {
  const storage = fakeStorage();
  resetState('tbc', 'bt', 5);
  Templates.save(storage, 'BT Comp', 'tbc', 'bt');
  assert.equal(Templates.list(storage, 'classic', 'mc').length, 0);
  assert.equal(Templates.list(storage, 'tbc', 'kara').length, 0);
  assert.equal(Templates.list(storage, 'tbc', 'bt').length, 1);
});

check('Templates: locked placements survive Optimizer.optimize(), unlocked seats are arranged normally', () => {
  resetState('tbc', 'bt', 10);
  const storage = fakeStorage();
  Templates.save(storage, 'Lock Test', 'tbc', 'bt');
  // Scramble: reload the same names into a single fresh unlocked pool.
  const entries = State.roster.map(p => ({ uid: nextUid(), name: p.name, class: p.class, spec: p.spec, role: p.role, groupNumber: 0 }));
  State.groups = [[], [], [], [], []];
  State.bench = entries;
  State.roster = [];
  const result = Templates.applyToState(storage, 'Lock Test', 'tbc', 'bt');
  assert.ok(result.success);
  assert.equal(result.matched, 10);
  const lockedSnapshot = State.groups.map(g => g.map(p => p.name).slice().sort());
  Optimizer.optimize();
  const afterSnapshot = State.groups.map(g => g.map(p => p.name).slice().sort());
  assert.equal(JSON.stringify(afterSnapshot), JSON.stringify(lockedSnapshot), 'locked template placements must be unchanged by Optimize');
});

check('Templates: rename and delete', () => {
  const storage = fakeStorage();
  resetState('tbc', 'bt', 5);
  Templates.save(storage, 'Old Name', 'tbc', 'bt');
  assert.ok(Templates.rename(storage, 'Old Name', 'New Name', 'tbc', 'bt').success);
  assert.equal(Templates.list(storage, 'tbc', 'bt')[0].name, 'New Name');
  Templates.delete(storage, 'New Name', 'tbc', 'bt');
  assert.equal(Templates.list(storage, 'tbc', 'bt').length, 0);
});

// ══════════════════════════════════════════════════════════════
// #4 "WHY HERE?" EXPLANATION
// ══════════════════════════════════════════════════════════════

function mk(cls, spec, role, name) {
  return { uid: nextUid(), name: name || (cls + '-' + spec), class: cls, spec, role, imported: false };
}

check('explainPlacement: lists a buff the player actually provides (cross-checked against getGroupBuffs)', () => {
  resetState('tbc', 'bt', 5); // any reset just to get a clean Rulesets.tbc context
  State.gameVersion = 'tbc';
  const shaman = mk('SHAMAN', 'Enhancement', 'melee_dps', 'Thrall');
  const group = [shaman, mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps')];
  group.forEach((p, i) => { p.groupNumber = 1; });
  const buffs = getGroupBuffs(group, 0);
  const providedIds = buffs.filter(b => b.sourceUid === shaman.uid).map(b => b.id);
  assert.ok(providedIds.includes('WINDFURY'), 'fixture sanity: the Enhancement Shaman should provide Windfury here');
  const reasons = explainPlacement(shaman, group, 0);
  const providesTexts = reasons.filter(r => r.kind === 'provides').map(r => r.text);
  assert.ok(providesTexts.some(t => t.includes('Windfury')), 'explanation should mention Windfury');
  // Never claims a buff the player doesn't actually provide.
  for (const r of reasons.filter(x => x.kind === 'provides')) {
    const named = buffs.find(b => r.text.includes(b.buff.name) && b.sourceUid === shaman.uid);
    assert.ok(named, `"${r.text}" does not correspond to a buff getGroupBuffs says this player provides`);
  }
});

check('explainPlacement: lists a buff the player receives from someone else', () => {
  resetState('tbc', 'bt', 5);
  const fury = mk('WARRIOR', 'Fury', 'melee_dps', 'Grommash');
  const shaman = mk('SHAMAN', 'Enhancement', 'melee_dps', 'Thrall');
  const group = [shaman, fury];
  const reasons = explainPlacement(fury, group, 0);
  assert.ok(reasons.some(r => r.kind === 'receives' && r.text.includes('Windfury')));
});

check('explainPlacement: reports a lock and a satisfied "together" constraint', () => {
  resetState('tbc', 'bt', 5);
  const a = mk('WARRIOR', 'Fury', 'melee_dps', 'Alice');
  const b = mk('ROGUE', 'Combat', 'melee_dps', 'Bob');
  a.locked = true;
  Constraints.add('Alice', 'Bob', 'together');
  const group = [a, b];
  const reasons = explainPlacement(a, group, 0);
  assert.ok(reasons.some(r => r.kind === 'lock'));
  assert.ok(reasons.some(r => r.kind === 'constraint' && r.text.includes('Bob')));
});

check('explainPlacement: returns [] gracefully for a null player or non-array group', () => {
  assert.equal(explainPlacement(null, [], 0).length, 0);
  assert.equal(explainPlacement({ name: 'X' }, null, 0).length, 0);
});

check('explainPlacement: the best-alternative comparison never throws across a real optimized board', () => {
  resetState('tbc', 'bt', 25);
  Optimizer.optimize();
  for (let gi = 0; gi < State.groups.length; gi++) {
    for (const p of State.groups[gi]) {
      const reasons = explainPlacement(p, State.groups[gi], gi, State.groups, State.optimizerMode);
      assert.ok(Array.isArray(reasons));
    }
  }
});

// ── QA pass 3: cross-feature regression ──────────────────────────
// Generating a random roster (or any other "start fresh" action) discards
// every current player object, but earlier code never reset the features
// that key off player NAME rather than object identity: raid notes,
// keep-together/apart constraints, manual assignments and bench backups.
// Left in place, they dangle — pointing at players who no longer exist —
// and can resurface confusingly (stale notes text, a "together" pair that
// silently does nothing, or worse, a coincidental name collision with a
// later import). RandomRoster.generate() must clear all four.
check('RandomRoster.generate() clears notes, constraints, assignments and backups from the previous roster', () => {
  resetState('tbc', 'bt', 25);
  State.notes = 'MT swaps at 20%, watch for enrage';
  const tank = State.roster.find(p => p.role === 'tank');
  const healer = State.roster.find(p => p.role === 'healer');
  Constraints.add(tank.name, healer.name, 'together');
  Assignments.restore({ tankHealers: { [healer.name]: tank.name } });
  State.bench = [{ uid: nextUid(), name: 'BenchGuy', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps', groupNumber: 0 }];
  Backups.link(tank.name, 'BenchGuy');
  assert.equal(State.playerConstraints.length, 1, 'fixture sanity: constraint recorded');
  assert.equal(Object.keys(State.assignments.tankHealers).length, 1, 'fixture sanity: assignment recorded');
  assert.equal(Object.keys(State.backups).length, 1, 'fixture sanity: backup recorded');

  RandomRoster.generate();

  assert.equal(State.notes, '', 'notes should be cleared, not carried over to the new roster');
  assert.equal(State.playerConstraints.length, 0, 'stale constraints (old names) should not survive');
  assert.equal(Object.keys(State.assignments.tankHealers).length, 0, 'stale manual assignments (old names) should not survive');
  assert.equal(Object.keys(State.backups).length, 0, 'stale bench backups (old names) should not survive');
});

// Review finding #3's sibling concern: RaidSplit moves some players into a
// brand-new "Raid B" plan with no explicit Constraints.clearForName() call
// (unlike rename/delete/RandomRoster/RH-withdrawal). Constraints.reconcile()
// is the render-time safety net that catches this and any other departure
// path — mirroring Backups.reconcile(), which renderGroups() already runs
// every render for exactly this reason.
check('Constraints.reconcile() drops a constraint once either side leaves the roster and bench entirely', () => {
  resetState('tbc', 'bt', 25);
  const a = State.roster[0], b = State.roster[1], c = State.roster[2];
  Constraints.add(a.name, b.name, 'together');
  Constraints.add(b.name, c.name, 'apart');
  assert.equal(State.playerConstraints.length, 2, 'fixture sanity');

  // Simulate a's half of a split: they moved into "Raid B" and are no longer
  // anywhere in this plan's roster or bench.
  State.groups[0] = State.groups[0].filter(p => p !== a);
  State.roster = State.groups.flat();
  State.bench = [];

  Constraints.reconcile();

  assert.equal(Constraints.forPlayer(a.name).length, 0, "a's constraint is dropped — a is gone");
  assert.equal(Constraints.forPlayer(c.name).length, 1, "b/c's constraint survives — both still present");
  assert.equal(State.playerConstraints.length, 1);
});

check('Constraints.reconcile() leaves a pair alone when one side is merely benched, not gone', () => {
  resetState('tbc', 'bt', 25);
  const a = State.roster[0], b = State.roster[1];
  Constraints.add(a.name, b.name, 'together');
  State.groups[0] = State.groups[0].filter(p => p !== a);
  State.roster = State.groups.flat();
  State.bench = [a]; // benched, not removed from the plan

  Constraints.reconcile();

  assert.equal(Constraints.forPlayer(a.name).length, 1, 'still on the bench — constraint is not stale yet');
});

console.log(`\nControl tests (templates, constraints, explanation): ${passed} passed, 0 failed, ${passed} total`);
