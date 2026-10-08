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
  ['State', 'Config', 'GameVersions', 'Rulesets', 'IdealComp', 'Faction', 'versionForRaid', 'nextUid'],
  { extraSource: app.slice('const IdealComp = {', '// ── TAB SWITCHING') }
);
const { State, Config, GameVersions, Rulesets, IdealComp, Faction, versionForRaid } = ctx.api;

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

console.log(`\nIdeal Comp tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
