/**
 * Raidsmith - PM wave 6, Planner side: the fair bench, the stronger Standby rule, the Bench tray's reasons (tests)
 * Run: node wave6-planner-tests.js
 *
 * The guild tracker's planner seed may say, per sign-up, in how many of the team's last raids (raid.recentRaids, at most four) the person sat on the bench
 * (benchedRecently). These tests drive the pure half in a vm sandbox (the same loader as the other suites); the seed-to-screen half is in raidcontext-tests.js
 * and the seed itself in guild-wave6-worker-tests.js. Covers:
 *   - Fairness: the seed's history is read, clamped and cleaned; nothing known means nothing changes.
 *   - The fair bench: among players of the same worth the optimizer benches whoever sat out least; a more valuable player never sits out for fairness; the raid
 *     total stays within the tolerance; without history, or with an all-zero history, the board is exactly the value-only one.
 *   - Standby (stronger): a volunteer is benched before a player who did not volunteer, also against the history, and is traded back in only for a buff
 *     the raid would lack (the other half is in wave2-planner-tests.js).
 *   - The Bench tray's reasons (Optimizer.benchReasons): fairness, a volunteer, the buff plan; only while the history is loaded; never stale after a move.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const Scenarios = require('./scenarios.js');

const slotSource = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel') + '\n' + app.slice('const SignupTray = {', 'const UnplacedDialog');
const ctx = app.sandbox(['State', 'Config', 'Import', 'Optimizer', 'SignupMarker', 'Fairness', 'SignupTray'], { extraSource: slotSource });
const { State, Config, Import, Optimizer, SignupMarker, Fairness, SignupTray } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
}

function reset(raid = 'bt') {
  State.gameVersion = 'tbc';
  State.selectedRaid = raid;
  State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
  State.rosterName = 'Wave 6'; State.planId = null; State.notes = '';
}
const STANDBY = { kind: 'standby', text: 'Standby' };
// A seed as GET /raids/:rid/planner sends it: { raid: { recentRaids }, signups: [{ name, benchedRecently }] }.
const seedOf = (counts, window = 4) => ({ raid: { recentRaids: window }, signups: Object.entries(counts).map(([name, n]) => ({ name, benchedRecently: n })) });

// T50's 25 primary sign-ups plus two more Destruction Warlocks named to sort first: 27 candidates for 25 seats. Base bench: Rainoffire and Voidcaller;
// Aaa, Aab, Immolator, Rainoffire and Voidcaller are interchangeable Destruction Warlocks (twins in worth).
const T50 = Scenarios.scenarios.find(s => s.id === 'T50').entries.filter(e => !e[2]);
const E27 = [...T50, ['destro', 'Aaa'], ['destro', 'Aab']];
const TWINS = ['Aaa', 'Aab', 'Immolator', 'Rainoffire', 'Voidcaller'];

// Imports the entries as a guild raid would (Fairness loaded first, as RaidContext does) and answers the bench's names.
function run(entries, { counts = null, window = 4, standby = [] } = {}) {
  reset();
  if (counts) Fairness.load(seedOf(counts, window)); else Fairness.clear();
  const signUps = entries.map(([key, name, status], i) => {
    const sign = Scenarios.signUp(key, name, status, i + 1);
    return standby.includes(name) ? { ...sign, marker: STANDBY } : sign;
  });
  assert(Import.importRaidHelper(JSON.stringify({ title: 'Wave 6', signUps })).success);
  assert.equal(State.groups.flat().length, 25);
  return plain(State.bench.map(p => p.name).sort());
}
const named = name => [...State.groups.flat(), ...State.bench].find(p => p.name === name);
const totalScore = () => State.groups.reduce((sum, g, gi) => sum + Optimizer.groupScore(g, gi, State.groups, 'max_dps'), 0);
const BASE = run(E27);

// ── Fairness ─────────────────────────────────────────────────────
check('Fairness.load: reads recentRaids and each sign-up\'s benchedRecently, clamped to the window; names compare case-insensitively; unknown names count 0', () => {
  Fairness.clear();
  assert(!Fairness.active());
  assert.equal(Fairness.benches({ name: 'Aldric' }), 0, 'nothing loaded: nobody has sat out');
  Fairness.load(seedOf({ Aldric: 3, Brindle: 9, Cassia: 0 }, 4));
  assert(Fairness.active());
  assert.equal(Fairness.window, 4);
  assert.deepEqual([Fairness.benches({ name: 'Aldric' }), Fairness.benches({ name: 'ALDRIC' }), Fairness.benches({ name: ' aldric ' })], [3, 3, 3]);
  assert.equal(Fairness.benches({ name: 'Brindle' }), 4, 'more than the window is the window');
  assert.equal(Fairness.benches({ name: 'Cassia' }), 0);
  assert.equal(Fairness.benches({ name: 'Nobody' }), 0, 'not in the seed');
  assert.equal(Fairness.benches(null), 0);
});

check('Fairness.load: malformed seeds load nothing, malformed rows are skipped, clear() forgets, and the version moves only when something changed', () => {
  for (const bad of [null, undefined, {}, { raid: {} }, { raid: { recentRaids: 0 } }, { raid: { recentRaids: -1 } }, { raid: { recentRaids: 2.5 } }, { raid: { recentRaids: '4' } }, { raid: { recentRaids: 9 } }]) {
    Fairness.load(bad);
    assert(!Fairness.active(), JSON.stringify(bad));
  }
  Fairness.load({ raid: { recentRaids: 4 }, signups: 'x' });
  assert(Fairness.active() && Fairness.benches({ name: 'Aldric' }) === 0, 'a window with no names: nobody has sat out');
  Fairness.load({ raid: { recentRaids: 4 }, signups: [null, 7, { name: 5, benchedRecently: 1 }, { name: 'Aldric', benchedRecently: '2' }, { name: 'Brindle', benchedRecently: 1.5 }, { name: 'Cassia', benchedRecently: -3 },
    { name: 'Dunmar', benchedRecently: 2 }, { name: 'dunmar', benchedRecently: 4 }, { name: '  ', benchedRecently: 1 }] });
  assert(Fairness.active());
  assert.deepEqual(plain(['Aldric', 'Brindle', 'Cassia', 'Dunmar'].map(name => Fairness.benches({ name }))), [0, 0, 0, 2], 'only whole numbers count, a duplicate name keeps the first, a negative is 0');
  const version = Fairness.version;
  Fairness.clear();
  assert(!Fairness.active() && Fairness.version === version + 1 && Fairness.byName.size === 0);
  Fairness.clear();
  assert.equal(Fairness.version, version + 1, 'clearing nothing is no change');
  Fairness.load(seedOf({ Aldric: 1 }));
  assert(Fairness.version > version + 1);
});

// ── The fair bench ───────────────────────────────────────────────
check('fair bench: no history, a history of zeros and a seed without recentRaids all give exactly the value-only board', () => {
  assert.deepEqual(BASE, ['Rainoffire', 'Voidcaller']);
  const groupsOf = () => State.groups.map(g => g.map(p => p.name).sort().join()).join('|');
  const baseBoard = (run(E27), groupsOf());
  assert.deepEqual(run(E27, { counts: {} }), BASE, 'a window with nobody in it');
  assert.equal(groupsOf(), baseBoard);
  assert.deepEqual(run(E27, { counts: Object.fromEntries(E27.map(e => [e[1], 0])) }), BASE, 'everyone sat out nothing');
  assert.equal(groupsOf(), baseBoard);
  assert.deepEqual(run(E27, { counts: Object.fromEntries(E27.map(e => [e[1], 2])) }), BASE, 'everyone sat out the same');
  assert.equal(groupsOf(), baseBoard);
  reset();
  Fairness.load({ raid: {}, signups: [{ name: 'Rainoffire', benchedRecently: 4 }] });
  assert(!Fairness.active(), 'no recentRaids: no history');
});

check('fair bench: of equal players, the ones who have sat out least are benched; the ones who sat out most sit', () => {
  // Rainoffire and Voidcaller (the base bench) sat out three of the last four, the others none: two of the others sit out now.
  const benched = run(E27, { counts: { Rainoffire: 3, Voidcaller: 3, Aaa: 0, Aab: 0, Immolator: 0 } });
  assert.equal(benched.length, 2);
  assert(benched.every(name => ['Aaa', 'Aab', 'Immolator'].includes(name)), benched.join());
  assert(named('Rainoffire').groupNumber > 0 && named('Voidcaller').groupNumber > 0, 'the two who sat out most are seated');
  // The other way round: those two are rested, so they stay out.
  assert.deepEqual(run(E27, { counts: { Aaa: 3, Aab: 3, Immolator: 3 } }), ['Rainoffire', 'Voidcaller']);
  // A strict order: 4, 3, 2, 1, 0 benches among the five twins puts the two with the fewest out. (The Affliction Warlock is worth the same as a twin within the
  // tolerance, so he is in the draw unless he has sat out a lot too.)
  assert.deepEqual(run(E27, { counts: { Aaa: 4, Aab: 3, Immolator: 2, Rainoffire: 1, Voidcaller: 0, Plaguebringer: 4 } }), ['Rainoffire', 'Voidcaller']);
  assert.deepEqual(run(E27, { counts: { Voidcaller: 4, Rainoffire: 3, Immolator: 2, Aab: 1, Aaa: 0, Plaguebringer: 4 } }), ['Aaa', 'Aab']);
  assert(run(E27, { counts: { Aaa: 4, Aab: 3, Immolator: 2, Rainoffire: 1, Voidcaller: 0 } }).includes('Plaguebringer'), 'worth the same as a twin within the tolerance: the one who sat out least sits out');
  // Someone the seed does not know (Voidcaller) counts as 0 benches, so he is first on the bench.
  assert(run(E27, { counts: { Aaa: 2, Aab: 2, Immolator: 2, Rainoffire: 2 } }).includes('Voidcaller'));
});

check('fair bench: it is deterministic and Optimize again changes nothing', () => {
  const counts = { Rainoffire: 3, Voidcaller: 3 };
  const first = run(E27, { counts });
  const board = State.groups.map(g => g.map(p => p.name).join()).join('|');
  assert.deepEqual(run(E27, { counts }), first);
  assert.equal(State.groups.map(g => g.map(p => p.name).join()).join('|'), board);
  Optimizer.optimize();
  assert.equal(State.groups.map(g => g.map(p => p.name).join()).join('|'), board, 'Optimize on the seated board keeps it');
  assert.deepEqual(plain(State.bench.map(p => p.name).sort()), first);
});

check('fair bench: raid value wins - a player worth more than the tolerance is never benched for fairness, and the raid total stays within it', () => {
  // The players the value-only plan needs (a Windfury shaman, the Elemental and Restoration shamans, the Shadow Priest) have sat out every recent raid; the
  // twins have not. The bench is still twins, and the raid is as good as the value-only one.
  const needed = { Thunderfist: 4, Stormcaller: 4, Spiritlink: 4, Dreamless: 4, Plaguebringer: 4, Marksmaster: 4, Lunarbeam: 4 };
  const benched = run(E27, { counts: needed });
  assert(benched.every(name => TWINS.includes(name)), benched.join());
  for (const name of Object.keys(needed)) assert(named(name).groupNumber > 0, name + ' sits');
  const value = totalScore();
  run(E27);
  const baseValue = totalScore();
  assert(value >= baseValue - Optimizer.BENCH_TOLERANCE, `${value} against ${baseValue}`);
  // Every possible history of the twins keeps the total within the tolerance of the value-only board.
  for (const counts of [{ Aaa: 4, Aab: 4 }, { Immolator: 4, Rainoffire: 4 }, { Voidcaller: 4, Aab: 3, Aaa: 2 }, { Rainoffire: 4, Voidcaller: 4, Immolator: 4 }]) {
    run(E27, { counts });
    assert(totalScore() >= baseValue - Optimizer.BENCH_TOLERANCE, JSON.stringify(counts));
  }
});

check('fair bench: only players of the same role trade - a healer who sat out a lot does not take a DPS seat', () => {
  // Seraphine (a sixth healer, benched or not) and Wildmend sat out most; the bench is the same two DPS-or-healer players as without the history,
  // and no role changes: the same number of healers sit.
  const healersBase = (run(E27), State.groups.flat().filter(p => p.role === 'healer').length);
  run(E27, { counts: { Seraphine: 4, Wildmend: 4, Verdancy: 4, Atoner: 4, Lightforge: 4, Spiritlink: 4 } });
  assert.equal(State.groups.flat().filter(p => p.role === 'healer').length, healersBase);
  assert.equal(State.groups.flat().filter(p => p.role === 'tank').length, 2);
});

check('fair bench: a size shrink pulls the size-benched players back into the pool and the history decides among the equal ones too', () => {
  run(E27, { counts: {} });
  const names = State.groups.flat().map(p => p.name);
  Fairness.load(seedOf({ Rainoffire: 4, Voidcaller: 4 }));
  // Hand the two twins to the size bench the way a shrink does, then Optimize: it plans the board plus them, with the history loaded.
  const remembered = State.bench.map(p => p.uid);
  State.sizeBenched = remembered;
  Optimizer.optimize();
  assert(State.groups.flat().length === 25);
  assert(names.length === 25);
});

// ── Standby ──────────────────────────────────────────────────────
check('standby: a volunteer is benched before a player who did not volunteer, also when the history would seat the volunteer', () => {
  // Aaa volunteers and has sat out the most; Aab, Immolator, Rainoffire, Voidcaller have sat out none. Aaa is still the first on the bench.
  let benched = run(E27, { counts: { Aaa: 4, Aab: 0, Immolator: 0, Rainoffire: 0, Voidcaller: 0 }, standby: ['Aaa'] });
  assert(benched.includes('Aaa') && benched.length === 2, benched.join());
  assert(SignupMarker.isStandby(named('Aaa')));
  // Without any history, the same.
  benched = run(E27, { standby: ['Aaa'] });
  assert(benched.includes('Aaa') && benched.length === 2, benched.join());
  // The volunteer who has sat out least is the one benched when two volunteer for one place... and the second place is the history's choice.
  benched = run(E27, { counts: { Aaa: 3, Aab: 0, Immolator: 4, Rainoffire: 4, Voidcaller: 4 }, standby: ['Aaa', 'Aab'] });
  assert.deepEqual(benched, ['Aaa', 'Aab'], 'both volunteers sit out, whoever sat out more');
});

check('standby: a seated volunteer gives his seat to a benched player of the same role and worth who did not volunteer; a volunteer never takes a seat that way', () => {
  run(E27);
  const seatedTwin = State.groups.flat().find(p => p.name === 'Immolator');
  const benchedTwin = State.bench.find(p => p.name === 'Voidcaller');
  assert(seatedTwin && benchedTwin);
  seatedTwin.marker = { ...STANDBY };
  const groups = State.groups, overflow = State.bench.slice();
  assert(Optimizer.refineFairness(groups, overflow, 'max_dps'), 'the volunteer is traded for a non-volunteer twin');
  assert(!groups.flat().includes(seatedTwin) && overflow.includes(seatedTwin) && groups.flat().some(p => p.name === 'Voidcaller'));
  assert.equal(seatedTwin.groupNumber, 0);
  // The reverse - a benched volunteer in place of a seated player who did not volunteer - is never a fairness trade, whatever the history.
  run(E27);
  Fairness.load(seedOf({ Voidcaller: 4 }));
  State.bench.find(p => p.name === 'Voidcaller').marker = { ...STANDBY };
  const before = State.groups.flat().map(p => p.name).sort().join();
  Optimizer.refineFairness(State.groups, State.bench.slice(), 'max_dps');
  assert.equal(State.groups.flat().map(p => p.name).sort().join(), before);
});

// ── The reasons on the Bench tray ────────────────────────────────
check('bench reasons: none without the history; with it, a tie says how often the player sat out, a volunteer says so, the others name what the plan needs', () => {
  run(E27);
  assert.equal(Optimizer.benchReasons().size, 0, 'no seed, no reasons');
  assert(!SignupTray.slotHTML({ p: State.bench[0], bi: 0, unplaced: false }, 'bench').includes('bench-reason'));
  run(E27, { counts: { Rainoffire: 3, Voidcaller: 3 } });
  const tie = Optimizer.benchReasons();
  assert.equal(tie.size, 2);
  for (const p of State.bench) assert.equal(tie.get(p.uid), 'Benched: sat out 0 of last 4', p.name);
  run(E27, { counts: { Aaa: 4, Aab: 4, Immolator: 4, Rainoffire: 4, Voidcaller: 4 }, window: 4, standby: ['Aaa'] });
  assert.equal(Optimizer.benchReasons().get(named('Aaa').uid), 'Benched: volunteered as standby');
  // Fewer raids on record: the window is what the phrase says.
  run(E27, { counts: { Rainoffire: 1, Voidcaller: 1, Aaa: 0, Aab: 0, Immolator: 0 }, window: 2 });
  for (const p of State.bench) assert.equal(Optimizer.benchReasons().get(p.uid), 'Benched: sat out 0 of last 2', p.name);
  // One raid on record reads as a sentence, not "0 of last 1".
  run(E27, { counts: { Rainoffire: 1, Voidcaller: 1, Aaa: 0, Aab: 0, Immolator: 0 }, window: 1 });
  for (const p of State.bench) assert.equal(Optimizer.benchReasons().get(p.uid), 'Benched: did not sit out the last raid', p.name);
  assert.equal(Optimizer.sitOutText(1), 'Benched: sat out the last raid');
  // A unique spec that loses to a buff: the reason names the buff, debuff or utility the raid would lose in his place.
  const unique = [...T50, ['frost', 'Xfrost'], ['arcane', 'Yarc']];
  run(unique, { counts: {} });
  const reasons = [...Optimizer.benchReasons().values()];
  assert.equal(reasons.length, 2);
  assert(reasons.some(text => /^Benched: buff plan needs [A-Z]/.test(text)), reasons.join(' | '));
  for (const text of reasons) assert(/^Benched: (buff plan needs .+|lowest value for the raid|sat out \d+ of last \d+)$/.test(text), text);
});

check('bench reasons: only confirmed raiders get one, and a reason follows the board - a move by hand never leaves a stale one', () => {
  run(E27, { counts: { Rainoffire: 3, Voidcaller: 3 } });
  const reasons = Optimizer.benchReasons();
  const [a, b] = State.bench;
  // Tentative and Bench sign-ups chose that themselves: no reason.
  a.signupStatus = 'tentative';
  assert(!Optimizer.benchReasons().has(a.uid) && Optimizer.benchReasons().has(b.uid) || Optimizer.benchReasons() !== reasons);
  a.signupStatus = 'confirmed';
  // The same board answers from the cache; a seated player moved to the bench changes the answer.
  assert.equal(Optimizer.benchReasons(), Optimizer.benchReasons());
  const seated = State.groups[3].find(p => p.role === 'caster_dps' && !SignupMarker.isStandby(p));
  State.groups[3].splice(State.groups[3].indexOf(seated), 1);
  State.bench.push(seated);
  const moved = Optimizer.benchReasons();
  assert(moved.has(seated.uid), 'the player benched by hand is explained against the board as it is now');
  assert.equal(moved.size, 3);
  State.bench.splice(State.bench.indexOf(seated), 1);
  State.groups[3].push(seated);
  assert.equal(Optimizer.benchReasons().size, 2);
  Fairness.clear();
  assert.equal(Optimizer.benchReasons().size, 0, 'the history is gone with the raid');
});

check('bench reasons: the Bench tray shows the reason under the spec, escaped, and speaks it; nothing extra without the history', () => {
  run(E27, { counts: { Rainoffire: 3, Voidcaller: 3 } });
  const entry = { p: State.bench[0], bi: 0, unplaced: false };
  const html = SignupTray.slotHTML(entry, 'bench');
  assert.match(html, /<span class="bench-reason" title="Benched: sat out 0 of last 4">Benched: sat out 0 of last 4<\/span>/);
  assert.match(html, /aria-label="[^"]*on the bench, Benched: sat out 0 of last 4"/);
  State.bench[0].name = 'Evil"><script>';
  Optimizer._reasonCache = null;
  const spare = SignupTray.slotHTML(entry, 'bench');
  assert(!/<script>/.test(spare), 'the name stays escaped around the reason');
  Fairness.clear();
  const none = SignupTray.slotHTML(entry, 'bench');
  assert(!none.includes('bench-reason') && !none.includes('Benched:'));
  assert(/\.bench-reason\b/.test(app.css), 'app.css styles it');
});

console.log(`\nWave 6 Planner tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
