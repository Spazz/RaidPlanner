/**
 * PartyPlanner Web - golden boards snapshot
 * Run: node boards-tests.js [--update] [--only F12,T07] [--shard i/n] [--verbose]
 *
 * Builds the optimized board of every fixture - each scenario in scenarios.js plus the six Classic/Forever rosters in
 * tests/classic-forever-fixtures.js - through the real Raid-Helper importer (which runs the optimizer once), in max_dps,
 * the only supported strategy, and compares it with the golden snapshot tests/boards-snapshot.json. It is the acceptance
 * gate for rules and weight work: a refactor that must not change behaviour leaves every board untouched, and a deliberate
 * weight edit shows exactly who moved.
 *
 * Record per fixture. Members are "CLASS:Spec name" and sorted inside a group; groups keep the optimizer's order (G1
 * first), because the order carries meaning; suggestions are the Open slots the import produced, sorted:
 *   { raid, groups: [[member, ...], ...], bench: [member, ...], unplaced: <count>, suggestions: ["G<n> CLASS:Spec", ...] }
 *   { importFails: true }            the importer rejected the sign-ups (P10, P11)
 *
 * Default run   compares every fixture with the snapshot and prints, per changed fixture, who moved (`name CLASS:Spec
 *               G2 -> G4`, members in and out of the bench, suggestion changes), then `Boards: <n> fixtures, <k> changed`.
 *               Exits 1 if a board changed, a fixture is missing from the snapshot, or the snapshot holds a fixture that
 *               no longer exists.
 * --update      rewrites the snapshot - the deliberate way to accept a changed layout - and prints what changed. Read the
 *               git diff of tests/boards-snapshot.json before committing it. Always the whole snapshot (no --only/--shard).
 * --only a,b    just those fixtures. --shard i/n: every n-th fixture from the i-th one (tests/shards.js lists the shard
 *               count and tests/run-all.js runs the shards side by side; shard 1 also checks for stale snapshot entries).
 * --verbose     lists every fixture with its build time.
 *
 * Every board is built twice in a row and the two results must be identical before the snapshot is consulted. The
 * optimizer is deterministic, so a difference means State leaked from one build into the next; State is reset completely
 * before each build (preferredSlots, buffOverrides, unplaced, gameVersion, selectedRaid, ...).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = require('./tests/load-app');
const Scenarios = require('./scenarios.js');
const { FIXTURES } = require('./tests/classic-forever-fixtures');
const { parseShard, partition } = require('./tests/shards');

// The real module (not a vm sandbox): the optimizer runs about three times faster outside a vm context.
const { State, Config, Import } = app.requireLogic(['State', 'Config', 'Import'], '_pp_boards_logic.tmp.js');

const SNAPSHOT_NAME = 'tests/boards-snapshot.json';
const SNAPSHOT_FILE = path.join(app.ROOT, SNAPSHOT_NAME);

// ── CLI ──
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const update = args.includes('--update');
const verbose = args.includes('--verbose');
const only = argVal('--only', '').split(',').filter(Boolean);
const shard = parseShard(argVal('--shard', ''));

function usageError(message) {
  console.error(`boards-tests: ${message}`);
  console.error('Usage: node boards-tests.js [--update] [--only F12,T07] [--shard i/n] [--verbose]');
  process.exit(2);
}
const unknownFlag = args.find(a => a.startsWith('--') && !['--update', '--verbose', '--only', '--shard'].includes(a));
if (unknownFlag) usageError(`unknown option ${unknownFlag}`);
if (args.includes('--only') && !only.length) usageError('--only needs a comma-separated list of fixture ids');
if (args.includes('--shard') && !shard) usageError('--shard needs i/n');
if (update && (only.length || shard)) usageError('--update rewrites the whole snapshot; it cannot be combined with --only or --shard');

// ── Fixtures ──
function rosterJson(roster) {
  const signUps = [];
  let i = 0;
  for (const [count, className, specName] of roster) {
    for (let k = 0; k < count; k++) signUps.push({ name: 'FP' + (i++), className, specName });
  }
  return JSON.stringify({ signUps });
}

/** Every scenario, then the six Classic/Forever rosters: { id, label, version, raid, json }. */
function fixtureList() {
  const list = Scenarios.scenarios.map(s => ({
    id: s.id, label: s.label, version: 'tbc', raid: s.raid || 'bt', json: JSON.stringify(Scenarios.toRaidHelperJson(s)),
  }));
  for (const [key, f] of Object.entries(FIXTURES)) {
    list.push({ id: key, label: f.label, version: f.version, raid: f.raid, json: rosterJson(f.roster) });
  }
  const seen = new Set();
  for (const f of list) {
    if (seen.has(f.id)) throw new Error(`boards-tests: fixture id "${f.id}" is used twice`);
    seen.add(f.id);
    if (!Config.Raids[f.raid]) throw new Error(`boards-tests: fixture ${f.id} names an unknown raid "${f.raid}"`);
  }
  return list;
}

// ── Build ──
// The app's own defaults, taken before the first import; every build starts from a copy of them.
const PRISTINE_STATE = JSON.stringify(State);
if (Object.keys(JSON.parse(PRISTINE_STATE)).length !== Object.keys(State).length) {
  throw new Error('boards-tests: State holds values JSON cannot copy, so resetState() would lose them');
}

function resetState(version, raid) {
  for (const key of Object.keys(State)) delete State[key];
  Object.assign(State, JSON.parse(PRISTINE_STATE));
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.optimizerMode = 'max_dps';
}

const memberOf = p => `${p.class}:${p.spec} ${p.name}`;
const slotOf = s => `G${s.group + 1} ${s.class}:${s.spec}`;

function readBoard() {
  return {
    raid: State.selectedRaid,
    groups: State.groups.map(group => group.map(memberOf).sort()),
    bench: State.bench.map(memberOf).sort(),
    unplaced: State.unplaced.length,
    suggestions: State.preferredSlots.map(slotOf).sort(),
  };
}

function build(fixture) {
  resetState(fixture.version, fixture.raid);
  const result = Import.importRaidHelper(fixture.json);
  return result.success ? readBoard() : { importFails: true };
}

// ── Compare ──
const canonical = r => (r.importFails ? { importFails: true }
  : { raid: r.raid, groups: r.groups, bench: r.bench, unplaced: r.unplaced, suggestions: r.suggestions });
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function isRecord(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.importFails === true) return true;
  const strings = list => Array.isArray(list) && list.every(x => typeof x === 'string');
  return typeof r.raid === 'string' && Array.isArray(r.groups) && r.groups.every(strings) && strings(r.bench)
    && Number.isInteger(r.unplaced) && strings(r.suggestions);
}

const BENCH = 'bench';

/** member -> where each copy of it sits: 'G<n>' or 'bench'. */
function placements(board) {
  const where = new Map();
  const put = (member, place) => { if (!where.has(member)) where.set(member, []); where.get(member).push(place); };
  board.groups.forEach((group, gi) => group.forEach(member => put(member, 'G' + (gi + 1))));
  board.bench.forEach(member => put(member, BENCH));
  return where;
}

const placeRank = place => (place === null ? 1e6 : place === BENCH ? 1e5 : Number(place.slice(1)));

/** One entry per member copy whose place differs; null = not on that board at all. */
function movesBetween(before, after) {
  const was = placements(before), now = placements(after);
  const moves = [];
  for (const member of new Set([...was.keys(), ...now.keys()])) {
    const from = (was.get(member) || []).slice(), to = (now.get(member) || []).slice();
    for (let i = from.length - 1; i >= 0; i--) { // copies that stayed where they were cancel out
      const j = to.indexOf(from[i]);
      if (j < 0) continue;
      from.splice(i, 1);
      to.splice(j, 1);
    }
    for (let i = 0; i < Math.max(from.length, to.length); i++) moves.push({ member, from: from[i] ?? null, to: to[i] ?? null });
  }
  return moves.sort((a, b) => placeRank(a.from) - placeRank(b.from) || placeRank(a.to) - placeRank(b.to)
    || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
}

/** "HUNTER:Beast Mastery Beastmode" -> { classSpec: 'HUNTER:Beast Mastery', name: 'Beastmode' } (some spec names hold a space). */
function splitMember(member) {
  const colon = member.indexOf(':');
  if (colon < 0) return { classSpec: '', name: member };
  const cls = member.slice(0, colon), rest = member.slice(colon + 1);
  const specs = Object.values(Config.Specs[cls] || {}).map(s => s.name).sort((a, b) => b.length - a.length);
  const spec = specs.find(s => rest.startsWith(s + ' '));
  if (spec) return { classSpec: `${cls}:${spec}`, name: rest.slice(spec.length + 1) };
  const space = rest.indexOf(' ');
  return space < 0 ? { classSpec: member, name: '' } : { classSpec: `${cls}:${rest.slice(0, space)}`, name: rest.slice(space + 1) };
}

function multisetDiff(before, after) {
  const left = after.slice(), removed = [];
  for (const item of before) {
    const i = left.indexOf(item);
    if (i < 0) removed.push(item);
    else left.splice(i, 1);
  }
  return { removed, added: left };
}

/** Readable lines for what differs between two records of one fixture (empty when they match). */
function diffBoards(before, after) {
  if (before.importFails || after.importFails) {
    if (before.importFails && after.importFails) return [];
    return [after.importFails ? 'import now fails (the snapshot holds a board)' : 'import now succeeds (the snapshot recorded a failed import)'];
  }
  const lines = [];
  if (before.raid !== after.raid) lines.push(`raid: ${before.raid} -> ${after.raid}`);
  for (const { member, from, to } of movesBetween(before, after)) {
    const { classSpec, name } = splitMember(member);
    lines.push(`${[name, classSpec].filter(Boolean).join(' ')} ${from ?? 'new'} -> ${to ?? 'gone'}`);
  }
  if (before.unplaced !== after.unplaced) lines.push(`unplaced: ${before.unplaced} -> ${after.unplaced}`);
  const { removed, added } = multisetDiff(before.suggestions, after.suggestions);
  for (const s of removed) lines.push(`suggestion dropped: ${s}`);
  for (const s of added) lines.push(`suggestion added: ${s}`);
  if (!lines.length && !same(before, after)) lines.push('the records differ although no member moved (hand-edited snapshot? run --update)');
  return lines;
}

// ── Snapshot file ──
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return { boards: null, text: null, problem: `${SNAPSHOT_NAME} does not exist` };
  const text = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  try {
    const boards = JSON.parse(text);
    if (!boards || typeof boards !== 'object' || Array.isArray(boards)) throw new Error('expected an object keyed by fixture id');
    return { boards, text, problem: null };
  } catch (e) {
    return { boards: null, text, problem: `${SNAPSHOT_NAME} cannot be read: ${e.message}` };
  }
}

const withLf = text => text.replace(/\r\n/g, '\n');

/** Stable key order (the fixtures' order), 2-space indent, the file's own line endings (the platform's for a new file). */
function serialize(boards, existingText) {
  const eol = existingText === null ? os.EOL : (existingText.includes('\r\n') ? '\r\n' : '\n');
  return (JSON.stringify(boards, null, 2) + '\n').replace(/\n/g, eol);
}

// ── Run ──
const everything = fixtureList();
const knownIds = new Set(everything.map(f => f.id));
const unknownOnly = only.filter(id => !knownIds.has(id));
if (unknownOnly.length) usageError(`unknown fixture ${unknownOnly.join(', ')}`);
const list = partition(everything.filter(f => !only.length || only.includes(f.id)), shard);

const heading = (tag, f) => console.log(`${tag}  ${f.id}  ${f.label}`);
const detail = lines => { for (const line of lines) console.log('    ' + line); };
const tally = { changed: 0, missing: 0, stale: 0, unstable: 0, errored: 0 };

/** The board twice in a row: `board` is the first build, `drift` lists how the second one differs (null when identical). */
function buildTwice(fixture) {
  const started = Date.now();
  try {
    const first = build(fixture);
    const second = build(fixture);
    return { fixture, board: first, ms: Date.now() - started, drift: same(first, second) ? null : diffBoards(first, second) };
  } catch (e) {
    return { fixture, error: e.stack || e.message, ms: Date.now() - started };
  }
}

/** Prints every build that threw or came out differently the second time; returns the results that can be trusted. */
function trustworthy(results) {
  for (const { fixture, error, drift } of results) {
    if (error) { tally.errored++; heading('ERROR', fixture); detail(error.split('\n')); }
    else if (drift) {
      tally.unstable++;
      heading('UNSTABLE', fixture);
      detail(['two builds in a row differ (State leaked between builds, or the optimizer is no longer deterministic)', ...drift]);
    }
  }
  return results.filter(r => !r.error && !r.drift);
}

function compareWithSnapshot(results, snapshot) {
  for (const { fixture, board, ms } of results) {
    const expected = snapshot.boards ? snapshot.boards[fixture.id] : undefined;
    if (expected === undefined) { tally.changed++; tally.missing++; heading('MISSING', fixture); }
    else if (!isRecord(expected)) { tally.changed++; heading('CHANGED', fixture); detail(['the snapshot entry is malformed']); }
    else if (!same(expected, board)) { tally.changed++; heading('CHANGED', fixture); detail(diffBoards(expected, board)); }
    else if (verbose) console.log(`ok  ${fixture.id}  ${fixture.label}  (${ms}ms)`);
  }
  // Entries of fixtures that no longer exist are checked once: by the whole run, or by shard 1.
  if (snapshot.boards && !only.length && (!shard || shard.index === 0)) {
    for (const id of Object.keys(snapshot.boards).filter(id => !knownIds.has(id))) {
      tally.changed++;
      tally.stale++;
      console.log(`STALE  ${id}  is in the snapshot but is no longer a fixture`);
    }
  }
  if (snapshot.problem) console.log(`\n${snapshot.problem}.`);
  if (tally.changed) console.log('Run node boards-tests.js --update to accept the current boards as the snapshot (read its git diff first).');
}

/** Reports what differs from the old snapshot, then rewrites the file unless nothing changed. Returns the closing line. */
function updateSnapshot(results, snapshot) {
  if (snapshot.problem) console.log(`${snapshot.problem}; a new one is written.`);
  const old = snapshot.boards || {};
  const boards = {};
  for (const { fixture, board } of results) {
    boards[fixture.id] = board;
    const before = old[fixture.id];
    if (before === undefined) { tally.changed++; console.log(`ADDED  ${fixture.id}  ${fixture.label}`); }
    else if (!isRecord(before)) { tally.changed++; heading('CHANGED', fixture); detail(['the old snapshot entry is malformed']); }
    else if (!same(before, board)) { tally.changed++; heading('CHANGED', fixture); detail(diffBoards(before, board)); }
  }
  for (const id of Object.keys(old).filter(id => !knownIds.has(id))) { tally.changed++; console.log(`REMOVED  ${id}  (no longer a fixture)`); }
  const text = serialize(boards, snapshot.text);
  const unchanged = snapshot.text !== null && withLf(snapshot.text) === withLf(text);
  if (!unchanged) fs.writeFileSync(SNAPSHOT_FILE, text);
  return `${unchanged ? 'Snapshot unchanged' : 'Snapshot written'}: ${SNAPSHOT_NAME} (${results.length} fixtures, ${Buffer.byteLength(text)} bytes)`;
}

const snapshot = loadSnapshot();
const good = trustworthy(list.map(buildTwice));
const failedBuilds = tally.unstable + tally.errored;
let closing = '';
if (update && failedBuilds) closing = `Snapshot NOT written: ${failedBuilds} of ${list.length} fixtures did not build the same board twice.`;
else if (update) closing = updateSnapshot(good, snapshot);
else compareWithSnapshot(good, snapshot);

const notes = [
  tally.missing && `missing from the snapshot: ${tally.missing}`,
  tally.stale && `stale snapshot entries: ${tally.stale}`,
  tally.unstable && `unstable: ${tally.unstable}`,
  tally.errored && `failed to build: ${tally.errored}`,
].filter(Boolean);
console.log(`\nBoards: ${list.length} fixtures, ${tally.changed} changed${notes.length ? ` (${notes.join(', ')})` : ''}${shard ? `  Shard: ${shard.index + 1}/${shard.count}` : ''}`);
if (closing) console.log(closing);
if (failedBuilds || (tally.changed && !update)) process.exitCode = 1;
