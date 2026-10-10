/**
 * PartyPlanner Web - Scenario test runner
 * Run: node scenario-tests.js [--mode max_dps|all] [--only F12,P03] [--verbose] [--shard i/n] [--rotation-depth k]
 * (--shard runs every n-th scenario starting at the i-th; tests/run-all.js runs the shards listed in tests/shards.js side by side.)
 * --mode defaults to max_dps, the only supported strategy (4.2.0). 'all' (or tank_mit|balanced|relaxed) is a
 * one-off probe of the deprecated modes and is not a gate: a failure there is never a reason to tune the optimizer.
 *
 * Feeds every roster in scenarios.js through the real Raid-Helper importer (which runs
 * the optimizer) and checks invariants that must hold for ANY roster, plus the
 * per-scenario expectations declared in scenarios.js. Logic comes straight from
 * index.html, the same way tests.js loads it.
 *
 * Composition expectations (keys of a scenario's expect, checked only in exp.compModes, default ['max_dps']),
 * evaluated on the board = State.groups + one OpenSlots.standIn per State.preferredSlots entry, in its group.
 * Selectors: a SPEC_KEYS key ('enh'), 'class:HUNTER', 'role:healer|tank|melee_dps|ranged_dps|caster_dps'.
 *   compModes: [modes]            modes that check the keys below (every other check runs in all modes)
 *   together: [[a, b], ...]       each a-member shares a group with another b-member
 *   apart: [[sel, max], ...]      no group holds more than max sel-members
 *   mixedDpsGroups: n             at most n non-tank groups hold physical DPS (melee+ranged) AND caster_dps
 *   huntersInCasterGroups: n      at most n hunters in a group where caster_dps outnumber melee+ranged DPS
 *   tankGroup: { maxDps, minHealers }   the tank-identity group (group 0 if none)
 *   suggested: [specKey, ...]     each listed spec appears (multiset) among the auto Open slots
 *   suggestedCount: n             exactly n auto Open slots
 *   benchHas: [[sel, min], ...]   at least min benched players match sel
 *   localOptimum: true            no swap / rotation / single move that keeps every touched group's isolated-member
 *                                 count (Optimizer.isolatedCount, the de-isolation rule) gains > 0.5 groupScore (pinned members never move);
 *                                 --rotation-depth k (default 3) sets the longest cycle (2 = swaps only; 4+ is slow)
 */
const app = require('./tests/load-app');

const PP = app.requireLogic(['Config', 'Import', 'Optimizer', 'State', 'getMissingBuffInsights', 'getGroupBuffs', 'OpenSlots'], '_pp_scenario_logic.tmp.js');
const { Config, Import, Optimizer, State, getMissingBuffInsights, getGroupBuffs, OpenSlots } = PP;
const Scenarios = require('./scenarios.js');
const { parseShard, partition } = require('./tests/shards');

// ── CLI ──
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const modeArg = argVal('--mode', 'max_dps');
const MODES = modeArg === 'all' ? ['max_dps', 'tank_mit', 'balanced', 'relaxed'] : [modeArg];
const only = argVal('--only', '').split(',').filter(Boolean);
const verbose = args.includes('--verbose');
const shard = parseShard(argVal('--shard', ''));
const rotationDepth = Math.max(2, parseInt(argVal('--rotation-depth', '3'), 10) || 3);

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

// ── Composition expectations (together, apart, localOptimum, ...) ──
// Selector strings: a SPEC_KEYS key ('enh'), 'class:HUNTER', or 'role:healer'.
const ROLE_NAMES = ['tank', 'healer', 'melee_dps', 'ranged_dps', 'caster_dps'];
const titleCase = s => s.charAt(0) + s.slice(1).toLowerCase();

/** One helper for every key: a selector string -> { label, test(member) }. */
function resolveSelector(sel) {
  if (typeof sel !== 'string') throw new Error('bad selector: ' + JSON.stringify(sel));
  if (sel.startsWith('class:')) {
    const cls = sel.slice(6).toUpperCase();
    return { label: titleCase(cls), test: m => m.class === cls };
  }
  if (sel.startsWith('role:')) {
    const role = sel.slice(5);
    if (!ROLE_NAMES.includes(role)) throw new Error('bad selector role: ' + sel);
    return { label: role, test: m => m.role === role };
  }
  const def = Scenarios.SPEC_KEYS[sel];
  if (!def) throw new Error('unknown selector: ' + sel);
  const [className, specName] = def;
  const info = Config.RaidHelperSpecMap[specName];
  if (info) return { label: `${info.spec} ${titleCase(info.class)}`, test: m => m.class === info.class && m.spec === info.spec && m.role === info.role };
  const cls = Config.RaidHelperClassMap[className];
  if (!cls) throw new Error('selector resolves to no class: ' + sel);
  return { label: titleCase(cls), test: m => m.class === cls };
}

/** One helper for every key: State.groups plus a stand-in per Open slot, carrying the optimizer's identities and anchors. */
function buildBoard() {
  const board = State.groups.map(g => g.slice());
  board._roleIdentities = State.groups._roleIdentities;
  board._anchors = State.groups._anchors;
  for (const slot of State.preferredSlots || []) {
    if (!(slot.group >= 0 && slot.group < board.length)) throw new Error(`Open ${slot.spec} ${titleCase(slot.class)} has no group (${slot.group})`);
    board[slot.group].push(OpenSlots.standIn(slot));
  }
  return board;
}

const memberName = m => m.openSlot ? `Open ${m.spec} ${titleCase(m.class)}` : m.name;
const tag = (m, gi) => `${memberName(m)}(G${gi + 1})`;
const slotName = s => `Open ${s.spec} ${titleCase(s.class)} G${s.group + 1}`;
const where = (board, test, skip) => {
  const out = [];
  board.forEach((g, gi) => g.forEach(m => { if (m !== skip && test(m)) out.push(`${memberName(m)} G${gi + 1}`); }));
  return out.length ? out.join(', ') : 'none';
};

const lo = { ms: 0, runs: 0 };

/**
 * Best improving move the optimizer itself would accept (gain > 0.5), or null.
 * Pinned members never move. A candidate that raises Optimizer.isolatedCount of any touched group is rejected
 * (the optimizer's de-isolation rule, the same predicate its Phase 4b guard uses). Group scores are cached per (group index, member set),
 * so a candidate only pays for the groups it touches, and only the first time.
 */
function findImprovingMove(board, mode, depth) {
  const nG = board.length;
  const ids = new Map(); let nextId = 0;
  board.forEach(g => g.forEach(m => ids.set(m, nextId++)));
  const memo = new Map();
  const scoreOf = (group, gi) => {
    const key = gi + ':' + group.map(m => ids.get(m)).sort((a, b) => a - b).join(',');
    let s = memo.get(key);
    if (s === undefined) { s = Optimizer.groupScore(group, gi, board, mode); memo.set(key, s); }
    return s;
  };
  const base = board.map((g, gi) => scoreOf(g, gi));
  const baseIso = board.map(g => Optimizer.isolatedCount(g));
  const isoMemo = new Map();
  const isoOf = (group, gi) => {
    const key = gi + ':' + group.map(m => ids.get(m)).sort((a, b) => a - b).join(',');
    let n = isoMemo.get(key);
    if (n === undefined) { n = Optimizer.isolatedCount(group); isoMemo.set(key, n); }
    return n;
  };
  const movable = board.map((g, gi) => g.filter(m => !Optimizer.isPinned(m, gi, board)));
  const MIN_GAIN = 0.5;
  let best = null;
  const consider = (gain, text) => { if (gain > MIN_GAIN && (!best || gain > best.gain)) best = { gain, text }; };

  // (3) single moves into a group with a free seat
  for (let to = 0; to < nG; to++) {
    if (board[to].length >= 5) continue;
    for (let from = 0; from < nG; from++) {
      if (from === to) continue;
      for (const m of movable[from]) {
        const toGroup = board[to].concat(m), fromGroup = board[from].filter(x => x !== m);
        if (isoOf(toGroup, to) > baseIso[to] || isoOf(fromGroup, from) > baseIso[from]) continue;
        const gain = scoreOf(toGroup, to) + scoreOf(fromGroup, from) - base[to] - base[from];
        consider(gain, `move ${memberName(m)} G${from + 1}->G${to + 1}`);
      }
    }
  }

  // (1)+(2) cycles over L distinct groups, L = 2 (swap) .. depth. gs[0] is the lowest group of
  // the cycle, so each cycle is visited once per direction. Member i of gs[i] moves to gs[i+1].
  const gs = [], picks = [];
  const evalCycle = () => {
    const L = gs.length;
    let gain = 0;
    for (let i = 0; i < L; i++) {
      const incoming = picks[(i + L - 1) % L];
      const after = board[gs[i]].filter(x => x !== picks[i]).concat(incoming);
      if (isoOf(after, gs[i]) > baseIso[gs[i]]) return;
      gain += scoreOf(after, gs[i]) - base[gs[i]];
    }
    if (gain <= MIN_GAIN) return;
    if (L === 2) consider(gain, `swap ${tag(picks[0], gs[0])}<->${tag(picks[1], gs[1])}`);
    else consider(gain, 'rotate ' + picks.map((m, i) => `${memberName(m)} G${gs[i] + 1}->G${gs[(i + 1) % L] + 1}`).join(', '));
  };
  const pickMembers = (L, i) => {
    if (i === L) { evalCycle(); return; }
    for (const m of movable[gs[i]]) { picks[i] = m; pickMembers(L, i + 1); }
  };
  const chooseGroups = (L) => {
    if (gs.length === L) { pickMembers(L, 0); return; }
    for (let g = gs[0] + 1; g < nG; g++) {
      if (gs.includes(g)) continue;
      gs.push(g); chooseGroups(L); gs.pop();
    }
  };
  for (let L = 2; L <= Math.min(depth, nG); L++) {
    for (let g0 = 0; g0 < nG; g0++) { gs.length = 0; gs.push(g0); chooseGroups(L); }
  }
  return best;
}

function checkComposition(exp, board, mode, check) {
  const casters = g => g.filter(m => m.role === 'caster_dps').length;
  const phys = g => g.filter(m => m.role === 'melee_dps' || m.role === 'ranged_dps').length;

  for (const [a, b] of exp.together || []) {
    const A = resolveSelector(a), B = resolveSelector(b);
    board.forEach((g, gi) => g.forEach(m => {
      if (!A.test(m)) return;
      check(g.some(o => o !== m && B.test(o)),
        `${A.label} ${memberName(m)} sits in G${gi + 1} without a ${B.label} (${B.label}: ${where(board, B.test, m)})`);
    }));
  }
  for (const [sel, max] of exp.apart || []) {
    const S = resolveSelector(sel);
    board.forEach((g, gi) => {
      const hit = g.filter(S.test);
      check(hit.length <= max, `G${gi + 1} holds ${hit.length} ${S.label} (max ${max}): ${hit.map(memberName).join(', ')}`);
    });
  }
  if (exp.mixedDpsGroups != null) {
    const mixed = [];
    board.forEach((g, gi) => { if (!Optimizer.isTankGroup(gi, board) && phys(g) > 0 && casters(g) > 0) mixed.push(`G${gi + 1} (${phys(g)} physical, ${casters(g)} caster)`); });
    check(mixed.length <= exp.mixedDpsGroups, `${mixed.length} groups mix physical and caster DPS, max ${exp.mixedDpsGroups}: ${mixed.join(', ')}`);
  }
  if (exp.huntersInCasterGroups != null) {
    const found = [];
    board.forEach((g, gi) => { if (casters(g) > phys(g)) g.filter(m => m.class === 'HUNTER').forEach(m => found.push(`${memberName(m)} G${gi + 1} (${casters(g)} casters)`)); });
    check(found.length <= exp.huntersInCasterGroups, `${found.length} hunters in caster groups, max ${exp.huntersInCasterGroups}: ${found.join(', ')}`);
  }
  if (exp.tankGroup) {
    const ids = board._roleIdentities;
    const ti = ids ? ids.indexOf('tank') : -1;
    const gi = ti >= 0 ? ti : 0, g = board[gi] || [];
    const dps = g.filter(m => m.role === 'melee_dps' || m.role === 'ranged_dps' || m.role === 'caster_dps');
    const healers = g.filter(m => m.role === 'healer');
    if (exp.tankGroup.maxDps != null) check(dps.length <= exp.tankGroup.maxDps, `tank group G${gi + 1} holds ${dps.length} DPS, max ${exp.tankGroup.maxDps}: ${dps.map(memberName).join(', ')}`);
    if (exp.tankGroup.minHealers != null) check(healers.length >= exp.tankGroup.minHealers, `tank group G${gi + 1} holds ${healers.length} healers, min ${exp.tankGroup.minHealers}: ${healers.map(memberName).join(', ') || 'none'}`);
  }
  const auto = (State.preferredSlots || []).filter(s => s.auto);
  const autoText = auto.map(slotName).join(', ') || 'none';
  if (exp.suggested) {
    const pool = auto.map(s => OpenSlots.standIn(s));
    for (const sel of exp.suggested) {
      const S = resolveSelector(sel);
      const i = pool.findIndex(S.test);
      check(i >= 0, `no suggested Open slot left for ${S.label} (suggested: ${autoText})`);
      if (i >= 0) pool.splice(i, 1);
    }
  }
  if (exp.suggestedCount != null) check(auto.length === exp.suggestedCount, `${auto.length} suggested Open slots, expected ${exp.suggestedCount}: ${autoText}`);
  for (const [sel, min] of exp.benchHas || []) {
    const S = resolveSelector(sel);
    const hit = State.bench.filter(S.test);
    check(hit.length >= min, `bench holds ${hit.length} ${S.label}, expected at least ${min} (bench: ${State.bench.map(memberName).join(', ') || 'empty'})`);
  }
  if (exp.localOptimum) {
    const t = process.hrtime.bigint();
    const move = findImprovingMove(board, mode, rotationDepth);
    lo.ms += Number(process.hrtime.bigint() - t) / 1e6; lo.runs++;
    check(!move, move ? `board is not a local optimum: ${move.text} +${move.gain.toFixed(2)}` : '');
  }
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
  // Absences and unknown classes are kept off the raid as unplaced sign-ups.
  check(State.unplaced.length === facts.absence + facts.unknown,
    `unplaced ${State.unplaced.length} but scenario has ${facts.absence} absences + ${facts.unknown} unknown specs`);
  check(State.unplaced.every(p => !State.roster.includes(p) && !bench.includes(p)), 'an unplaced sign-up is also seated or benched');
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
  if (exp.unplaced != null) check(State.unplaced.length === exp.unplaced, `unplaced ${State.unplaced.length}, expected ${exp.unplaced}`);
  if (exp.minHealersSeated != null) check(seatedRoles.healer >= exp.minHealersSeated, `healers seated ${seatedRoles.healer} < ${exp.minHealersSeated}`);
  if (exp.tentativeBenched != null) check(bench.filter(p => tentNames.has(p.name)).length === exp.tentativeBenched, 'tentative bench count mismatch');
  if (exp.windfuryGroups != null) check(groupsWithBuff('WINDFURY') >= exp.windfuryGroups, `Windfury in ${groupsWithBuff('WINDFURY')} groups, expected ${exp.windfuryGroups}`);
  if (exp.feralGroups != null) check(groupsWithSpec('DRUID', 'Feral') >= exp.feralGroups, `Ferals spread over ${groupsWithSpec('DRUID', 'Feral')} groups, expected ${exp.feralGroups}`);
  if (exp.missingNone && insights) {
    for (const id of exp.missingNone) check(insights[id] && insights[id].kind === 'none', `${id} should be reported as unobtainable`);
  }
  if ((exp.compModes || ['max_dps']).includes(mode)) checkComposition(exp, buildBoard(), mode, check);

  return { failures, ms, seated: seated.length, benched: bench.length, tanks: seatedRoles.tank, healers: seatedRoles.healer, size };
}

const list = partition(Scenarios.scenarios.filter(s => only.length === 0 || only.includes(s.id)), shard);
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
if (lo.runs) console.log(`localOptimum: ${lo.runs} runs, ${lo.ms.toFixed(0)}ms total, ${(lo.ms / lo.runs).toFixed(0)}ms avg (rotation depth ${rotationDepth})`);
const failedScenarios = rows.filter(r => r.status === 'FAIL').length;
console.log(`\nScenarios: ${scenarioCount} (${scenarioCount - failedScenarios} passed, ${failedScenarios} failed)  Modes: ${MODES.join(', ')}  Checks: ${checkCount} (${failCount} failed)${shard ? `  Shard: ${shard.index + 1}/${shard.count}` : ''}`);
process.exit(failedScenarios ? 1 : 0);
