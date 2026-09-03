/**
 * PartyPlanner Web - Scenario test runner
 * Run: node scenario-tests.js [--mode max_dps|tank_mit|balanced|relaxed|all] [--only F12,P03] [--verbose]
 *
 * Feeds every roster in scenarios.js through the real Raid-Helper importer (which runs
 * the optimizer) and checks invariants that must hold for ANY roster, plus the
 * per-scenario expectations declared in scenarios.js. Logic comes straight from
 * index.html, the same way tests.js loads it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('Could not extract <script> from index.html'); process.exit(1); }
const logicCode = scriptMatch[1].split('// ── UI RENDERING')[0];
const tmpPath = path.join(os.tmpdir(), '_pp_scenario_logic.tmp.js');
fs.writeFileSync(tmpPath, logicCode + '\nmodule.exports = { Config, Import, Optimizer, State, getMissingBuffInsights, getGroupBuffs };');
const PP = require(tmpPath);
fs.unlinkSync(tmpPath);
const { Config, Import, Optimizer, State, getMissingBuffInsights, getGroupBuffs } = PP;
const Scenarios = require('./scenarios.js');

// ── CLI ──
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const modeArg = argVal('--mode', 'all');
const MODES = modeArg === 'all' ? ['max_dps', 'tank_mit', 'balanced', 'relaxed'] : [modeArg];
const only = argVal('--only', '').split(',').filter(Boolean);
const verbose = args.includes('--verbose');

// ── Helpers ──
function resetState(raid) {
  State.roster = []; State.groups = []; State.bench = []; State.buffOverrides = {};
  State.selectedRaid = raid || 'bt';
  State.rosterName = 'Scenario';
}

// Order-independent fingerprint of the board: each group as a sorted name list, groups sorted.
function layoutKey() {
  return State.groups.map(g => g.map(p => p.name).sort().join(',')).sort().join(' | ');
}

function shuffled(arr, seedStart) {
  let seed = seedStart;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function countRoles(players) {
  const c = { tank: 0, healer: 0, melee_dps: 0, ranged_dps: 0, caster_dps: 0 };
  for (const p of players) c[p.role] = (c[p.role] || 0) + 1;
  return c;
}

function groupsWithBuff(buffId) {
  return State.groups.filter((g, gi) => getGroupBuffs(g, gi).some(b => b.id === buffId)).length;
}

function groupsWithSpec(cls, spec) {
  return State.groups.filter(g => g.some(p => p.class === cls && p.spec === spec)).length;
}

// Which sign-ups the importer should treat as raiders, from the scenario itself.
function classify(scenario) {
  const out = { primary: 0, tentative: 0, bench: 0, absence: 0, unknown: 0, tanks: 0, healers: 0 };
  for (const [key, , status] of scenario.entries) {
    if (status === 'absence') { out.absence++; continue; }
    const [className, specName] = Scenarios.SPEC_KEYS[key];
    const known = !!Config.RaidHelperSpecMap[specName] || !!Config.RaidHelperClassMap[className];
    if (!known) { out.unknown++; continue; }
    if (status === 'tentative') { out.tentative++; continue; }
    if (status === 'bench') { out.bench++; continue; }
    out.primary++;
    const info = Config.RaidHelperSpecMap[specName];
    const role = className === 'Tank' ? 'tank' : (info ? info.role : 'melee_dps');
    if (role === 'tank') out.tanks++;
    if (role === 'healer') out.healers++;
  }
  return out;
}

// ── Runner ──
let scenarioCount = 0, checkCount = 0, failCount = 0;
const rows = [];

function runScenario(scenario, mode) {
  const failures = [];
  const check = (cond, msg) => { checkCount++; if (!cond) { failures.push(msg); failCount++; } };
  // Shared expectations, overridden per optimizer mode when the scenario nests a mode key.
  const exp = Object.assign({}, scenario.expect || {}, (scenario.expect || {})[mode] || {});
  const facts = classify(scenario);

  resetState(scenario.raid);
  State.optimizerMode = mode;
  const json = JSON.stringify(Scenarios.toRaidHelperJson(scenario));
  const t0 = Date.now();
  const result = Import.importRaidHelper(json);
  const ms = Date.now() - t0;

  if (exp.importFails) {
    check(!result.success, 'import was expected to fail but succeeded');
    return { failures, ms, seated: 0, benched: 0 };
  }
  check(result.success, 'import failed: ' + (result.error || 'unknown'));
  if (!result.success) return { failures, ms, seated: 0, benched: 0 };

  const raidInfo = Config.Raids[State.selectedRaid];
  const size = raidInfo.size, numGroups = raidInfo.groups;
  const seated = State.groups.flat();
  const bench = State.bench;
  const seatedRoles = countRoles(seated);
  const floors = Optimizer.floorsFor(size);

  // Universal invariants
  check(State.groups.length === numGroups, `expected ${numGroups} groups, got ${State.groups.length}`);
  check(State.groups.every(g => g.length <= 5), 'a group has more than 5 players');
  check(seated.length <= size, `seated ${seated.length} > raid size ${size}`);
  check(seated.length === State.roster.length, 'State.roster does not match the seated players');
  const expectedRaiders = facts.primary + facts.tentative + facts.bench;
  check(seated.length + bench.length === expectedRaiders,
    `lost players: seated ${seated.length} + bench ${bench.length} != ${expectedRaiders} raiders`);
  check((result.skippedCount || 0) === facts.absence + facts.unknown,
    `skipped ${result.skippedCount} but scenario has ${facts.absence} absences + ${facts.unknown} unknown specs`);
  check(seated.length === Math.min(facts.primary, size),
    `seated ${seated.length}, expected min(primary ${facts.primary}, size ${size})`);
  check(bench.every(p => p.groupNumber === 0), 'a benched player still carries a group number');
  const names = new Set();
  check(seated.every(p => { const k = p.uid; if (names.has(k)) return false; names.add(k); return true; }), 'a player is seated twice');
  check(seated.every(p => State.groups[p.groupNumber - 1] && State.groups[p.groupNumber - 1].includes(p)),
    'a seated player.groupNumber does not match the group holding them');

  // Tentative and Bench sign-ups never take a seat.
  const tentNames = new Set(scenario.entries.filter(e => e[2] === 'tentative' || e[2] === 'bench').map(e => e[1]));
  check(!seated.some(p => tentNames.has(p.name) && scenario.entries.filter(e => e[1] === p.name).every(e => e[2])),
    'a Tentative/Bench sign-up was seated');

  // Floors: tanks and healers are seated up to the floor whenever the roster has them.
  check(seatedRoles.tank >= Math.min(floors.tank, facts.tanks),
    `only ${seatedRoles.tank} tanks seated; floor ${floors.tank}, available ${facts.tanks}`);
  check(seatedRoles.healer >= Math.min(floors.healer, facts.healers),
    `only ${seatedRoles.healer} healers seated; floor ${floors.healer}, available ${facts.healers}`);

  // Idempotence: a second Optimize on the finished board moves nobody.
  const key1 = layoutKey();
  Optimizer.optimize();
  check(layoutKey() === key1, 'second optimize changed the layout');

  // Determinism: sign-up order must not change the result.
  const shuffledScenario = { ...scenario, entries: shuffled(scenario.entries, 1234) };
  resetState(scenario.raid);
  State.optimizerMode = mode;
  Import.importRaidHelper(JSON.stringify(Scenarios.toRaidHelperJson(shuffledScenario)));
  check(layoutKey() === key1, 'layout depends on sign-up order');
  // Restore the canonical run for the expectation checks below.
  resetState(scenario.raid);
  State.optimizerMode = mode;
  Import.importRaidHelper(json);

  // Coverage helper must not throw on any board.
  let insights = null;
  try { insights = getMissingBuffInsights(); } catch (e) { check(false, 'getMissingBuffInsights threw: ' + e.message); }

  // Scenario expectations
  if (exp.raidSize != null) check(size === exp.raidSize, `raid size ${size}, expected ${exp.raidSize}`);
  if (exp.seated != null) check(seated.length === exp.seated, `seated ${seated.length}, expected ${exp.seated}`);
  if (exp.benched != null) check(bench.length === exp.benched, `benched ${bench.length}, expected ${exp.benched}`);
  if (exp.skipped != null) check(result.skippedCount === exp.skipped, `skipped ${result.skippedCount}, expected ${exp.skipped}`);
  if (exp.minHealersSeated != null) check(seatedRoles.healer >= exp.minHealersSeated, `healers seated ${seatedRoles.healer} < ${exp.minHealersSeated}`);
  if (exp.tentativeBenched != null) check(bench.filter(p => tentNames.has(p.name)).length === exp.tentativeBenched, 'tentative bench count mismatch');
  if (exp.windfuryGroups != null) check(groupsWithBuff('WINDFURY') >= exp.windfuryGroups, `Windfury in ${groupsWithBuff('WINDFURY')} groups, expected ${exp.windfuryGroups}`);
  if (exp.feralGroups != null) check(groupsWithSpec('DRUID', 'Feral') >= exp.feralGroups, `Ferals spread over ${groupsWithSpec('DRUID', 'Feral')} groups, expected ${exp.feralGroups}`);
  if (exp.missingNone && insights) {
    for (const id of exp.missingNone) check(insights[id] && insights[id].kind === 'none', `${id} should be reported as unobtainable`);
  }

  return { failures, ms, seated: seated.length, benched: bench.length, tanks: seatedRoles.tank, healers: seatedRoles.healer, size };
}

const list = Scenarios.scenarios.filter(s => only.length === 0 || only.includes(s.id));
for (const scenario of list) {
  scenarioCount++;
  const perMode = {};
  let slowest = 0, fails = [];
  let last = null;
  for (const mode of MODES) {
    let r;
    try { r = runScenario(scenario, mode); }
    catch (e) { r = { failures: ['threw: ' + (e.stack || e.message)], ms: 0 }; failCount++; }
    perMode[mode] = r.failures.length === 0;
    slowest = Math.max(slowest, r.ms);
    for (const f of r.failures) fails.push(`[${mode}] ${f}`);
    last = r;
  }
  const status = fails.length === 0 ? 'PASS' : 'FAIL';
  rows.push({ id: scenario.id, status, label: scenario.label, players: scenario.entries.length,
    seated: last.seated, benched: last.benched, ms: slowest });
  const line = `${status}  ${scenario.id}  ${scenario.label}  (${scenario.entries.length} sign-ups, ${last.seated ?? '-'} seated, ${last.benched ?? '-'} benched, ${slowest}ms)`;
  if (status === 'FAIL' || verbose) {
    console.log(line);
    for (const f of fails) console.log('       ' + f);
  }
}

// ── Summary table ──
console.log('\nID   Result  Sign-ups  Seated  Bench  Slowest  Scenario');
for (const r of rows) {
  console.log(`${r.id.padEnd(4)} ${r.status.padEnd(7)} ${String(r.players).padStart(8)}  ${String(r.seated).padStart(6)}  ${String(r.benched).padStart(5)}  ${String(r.ms + 'ms').padStart(7)}  ${r.label}`);
}
const gaps = list.filter(s => s.expect && s.expect.knownGap);
if (gaps.length) {
  console.log('\nKnown gaps (the scenario passes against current behaviour, but that behaviour is questionable):');
  for (const g of gaps) console.log(`  ${g.id}  ${g.label}: ${g.expect.knownGap}`);
}
const failedScenarios = rows.filter(r => r.status === 'FAIL').length;
console.log(`\nScenarios: ${scenarioCount} (${scenarioCount - failedScenarios} passed, ${failedScenarios} failed)  Modes: ${MODES.join(', ')}  Checks: ${checkCount} (${failCount} failed)`);
process.exit(failedScenarios ? 1 : 0);
