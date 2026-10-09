/**
 * PartyPlanner Web - Ideal Comp tests
 * Run: node idealcomp-tests.js
 *
 * Same vm loader pattern as classic-tests.js/version-tests.js: the logic
 * portion of index.html's <script> (before the '// ── UI RENDERING' split)
 * is executed in a sandboxed context. IdealComp itself lives AFTER that
 * split (it's defined alongside the render layer) but never touches the
 * DOM, so its source (from 'const IdealComp = {' through the Rulesets
 * wiring, right before '// ── TAB SWITCHING') is appended verbatim on top
 * of the logic portion instead of being skipped like the rest of the
 * render layer is.
 *
 * Regression coverage: every raid size offered in every version's raid
 * dropdown must produce a non-empty Ideal Comp (backlog bug — Classic's
 * "10-player template" raid silently rendered a blank Ideal Comp tab
 * because Rulesets.classic.idealComp had no build10Man).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(
  ['State', 'Config', 'GameVersions', 'Rulesets', 'IdealComp', 'Faction', 'versionForRaid', 'nextUid', 'getGroupBuffs', 'getRaidBuffCoverage', 'Optimizer'],
  { extraSource: app.slice('const IdealComp = {', '// ── TAB SWITCHING') }
);
const { State, Config, GameVersions, Rulesets, IdealComp, Faction, versionForRaid, getGroupBuffs, getRaidBuffCoverage, Optimizer } = ctx.api;

let passed = 0, failed = 0;
function assertTrue(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL: ' + msg); }
}

// Every raid in Config.RaidOrder must produce a non-empty Ideal Comp seated
// to exactly the raid's size, for every faction where relevant.
for (const raidKey of Config.RaidOrder) {
  const raid = Config.Raids[raidKey];
  const version = versionForRaid(raidKey);
  if (!version || !GameVersions[version] || !GameVersions[version].modeled) continue;

  const factions = (Rulesets[version].rules && Rulesets[version].rules.factionLock) ? ['horde', 'alliance'] : [null];
  for (const faction of factions) {
    State.gameVersion = version;
    State.selectedRaid = raidKey;
    State.bench = [];
    if (faction) State.groups = [[{ uid: 'p1', name: 'X', class: faction === 'horde' ? 'SHAMAN' : 'PALADIN', spec: faction === 'horde' ? 'Elemental' : 'Holy', role: 'healer', imported: true }]];
    else State.groups = [[]];
    const groups = IdealComp.generate(raidKey);
    const total = groups.reduce((a, g) => a + g.length, 0);
    const label = version + '/' + raidKey + (faction ? '/' + faction : '');
    assertTrue(groups.length > 0, `${label}: Ideal Comp has at least one group`);
    assertTrue(total === raid.size, `${label}: Ideal Comp seats exactly ${raid.size} players (got ${total})`);
  }
}

// Specific regression check for the reported bug: Classic's 10-player
// template must no longer be blank, for both factions.
(function () {
  State.gameVersion = 'classic';
  State.selectedRaid = 'classic10';
  State.bench = [];
  State.groups = [[{ uid: 'p1', name: 'Thrall', class: 'SHAMAN', spec: 'Elemental', role: 'healer', imported: true }]];
  const horde = IdealComp.generate('classic10');
  assertTrue(horde.length === 2, 'Classic 10-man Ideal Comp (Horde): 2 groups');
  assertTrue(horde.flat().length === 10, 'Classic 10-man Ideal Comp (Horde): 10 players seated');
  assertTrue(horde.flat().some(p => p.class === 'SHAMAN'), 'Classic 10-man Ideal Comp (Horde): includes a Shaman');
  assertTrue(!horde.flat().some(p => p.class === 'PALADIN'), 'Classic 10-man Ideal Comp (Horde): no Paladin (faction lock)');

  State.groups = [[{ uid: 'p1', name: 'Uther', class: 'PALADIN', spec: 'Holy', role: 'healer', imported: true }]];
  const alliance = IdealComp.generate('classic10');
  assertTrue(alliance.length === 2, 'Classic 10-man Ideal Comp (Alliance): 2 groups');
  assertTrue(alliance.flat().length === 10, 'Classic 10-man Ideal Comp (Alliance): 10 players seated');
  assertTrue(alliance.flat().some(p => p.class === 'PALADIN'), 'Classic 10-man Ideal Comp (Alliance): includes a Paladin');
  assertTrue(!alliance.flat().some(p => p.class === 'SHAMAN'), 'Classic 10-man Ideal Comp (Alliance): no Shaman (faction lock)');
})();

// The badges and coverage of a generated board depend only on that board, never
// on whatever plan State.groups currently holds.
(function () {
  const badges = (groups) => groups.map((g, gi) => getGroupBuffs(g, gi, groups).map(b => b.id + ':' + b.sourceUid).join(',')).join('|');
  const coverage = (groups) => [...getRaidBuffCoverage(groups)].sort().join(',');
  for (const [version, raidKey] of [['classic', 'naxx'], ['tbc', 'gruul']]) {
    State.gameVersion = version;
    State.selectedRaid = raidKey;
    State.bench = [];
    const identities = ['tank', 'melee_dps', 'caster_dps', 'healer'];
    for (const mode of ['max_dps', 'balanced']) {
      State.optimizerMode = mode;
      State.groups = [[]];
      const ideal = IdealComp.generate(raidKey);
      const baseline = badges(ideal);
      const baselineCoverage = coverage(ideal);
      assertTrue(baseline.length > 0, `${version}/${raidKey}/${mode}: Ideal Comp shows some buffs`);
      // Other plans on the board: same players in other seats, other role identities.
      for (let shift = 0; shift < identities.length; shift++) {
        State.groups = ideal.map(g => g.slice().reverse()).reverse();
        State.groups._roleIdentities = State.groups.map((_, i) => identities[(i + shift) % identities.length]);
        assertTrue(badges(ideal) === baseline, `${version}/${raidKey}/${mode}/${shift}: Ideal Comp badges ignore State.groups`);
        assertTrue(coverage(ideal) === baselineCoverage, `${version}/${raidKey}/${mode}/${shift}: Ideal Comp coverage ignores State.groups`);
      }
    }
  }
})();

// Round trip: the reference TBC 25-man comp, shuffled and handed to Optimize, must come back
// as the reference PATTERN (user's wowhead comp wins over the scorer, tasks/lessons.md
// 2026-09-02). Group order is arbitrary, so groups are compared as multisets of "Spec CLASS".
(function () {
  const specKey = (p) => p.spec + ' ' + p.class;
  const groupKey = (g) => g.map(specKey).sort().join(', ');
  const shuffle = (arr, seedStart) => {
    let seed = seedStart;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  State.bench = [];
  State.groups = [[]];
  const reference = IdealComp.generate('bt');
  assertTrue(reference.length === 5 && reference.flat().length === 25, 'TBC 25-man reference: 5 groups, 25 players');
  const expectedMelee = reference.slice(0, 2).flat().map(specKey).sort().join(', ');
  const expectedCasterSupport = groupKey(reference[2]);
  const expectedCasterDps = groupKey(reference[3]);
  const expectedHealerTank = groupKey(reference[4]);

  // balanced/relaxed weigh role cohesion (a DPS stays with its role's group) by design, so the overflow
  // Warlock stays with the casters there; the reference pattern is asserted for the modes that follow it.
  for (const mode of ['max_dps', 'tank_mit']) {
    for (const seed of [1, 2, 3]) {
      State.optimizerMode = mode;
      State.selectedRaid = 'bt';
      State.roster = shuffle(reference.flat(), seed).map(p => ({ ...p, groupNumber: 1 }));
      State.groups = [State.roster.slice(), [], [], [], []];
      State.bench = [];
      Optimizer.optimize();
      const label = `TBC 25-man reference round trip (${mode}, shuffle ${seed})`;
      const board = State.groups;
      assertTrue(board.flat().length === 25 && State.bench.length === 0, `${label}: all 25 seated`);

      const keys = board.map(groupKey);
      const melee = board.filter(g => g.some(p => p.spec === 'Feral'));
      assertTrue(melee.length === 2, `${label}: the two Ferals sit in two different melee groups`);
      for (const g of melee) {
        assertTrue(g.filter(p => p.spec === 'Feral').length === 1, `${label}: melee group has exactly one Feral`);
        assertTrue(g.filter(p => p.spec === 'Enhancement').length === 1, `${label}: melee group has exactly one Enhancement Shaman`);
        assertTrue(g.filter(p => p.class === 'HUNTER').length === 1, `${label}: melee group has exactly one Hunter`);
        assertTrue(g.every(p => p.role !== 'healer' && p.role !== 'tank' && p.role !== 'caster_dps' || p.spec === 'Feral'), `${label}: melee group has no healers or casters`);
      }
      assertTrue(melee.flat().map(specKey).sort().join(', ') === expectedMelee, `${label}: melee groups hold the reference melee/hunter roster (got ${melee.map(groupKey).join(' | ')})`);
      assertTrue(keys.includes(expectedCasterSupport), `${label}: caster-support group is ${expectedCasterSupport} (got ${keys.join(' | ')})`);
      assertTrue(keys.includes(expectedCasterDps), `${label}: caster-DPS group is ${expectedCasterDps} (got ${keys.join(' | ')})`);
      assertTrue(keys.includes(expectedHealerTank), `${label}: healer/tank group is ${expectedHealerTank} with the one overflow DPS (got ${keys.join(' | ')})`);
    }
  }
})();

// Edge paths of the overflow-seat exemption: it covers ONE Affliction Warlock, and only once the
// tank group has its three-healer core; any other DPS guest still pays the guest penalty.
(function () {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  const mk = (cls, spec, role) => IdealComp.makePlayer(cls, spec, role);
  const tankGroup = (guests, healers) => {
    const group = [mk('PALADIN', 'Protection', 'tank')];
    for (let i = 0; i < healers; i++) group.push(mk('PRIEST', 'Holy', 'healer'));
    return group.concat(guests);
  };
  const score = (group) => {
    const groups = [group, [], [], [], []];
    groups._roleIdentities = ['tank', 'melee_dps', 'melee_dps', 'caster_dps', 'caster_dps'];
    return Optimizer.groupScore(group, 0, groups, 'max_dps');
  };
  const aff = () => mk('WARLOCK', 'Affliction', 'caster_dps');
  const rogue = () => mk('ROGUE', 'Combat', 'melee_dps');
  const base3 = score(tankGroup([], 3));
  const withAff = score(tankGroup([aff()], 3)) - base3;
  const withRogue = score(tankGroup([rogue()], 3)) - base3;
  assertTrue(withAff > withRogue, 'tank group: an Affliction Warlock overflow seat costs less than a Rogue guest');
  const twoAff = score(tankGroup([aff(), aff()], 3)) - base3;
  assertTrue(twoAff < withAff, 'tank group: a second Affliction Warlock pays the guest penalty again');
  const base2 = score(tankGroup([], 2));
  assertTrue(score(tankGroup([aff()], 2)) - base2 < withAff, 'tank group: no overflow exemption before the three-healer core is there');
})();

console.log(`\nIdeal Comp tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
