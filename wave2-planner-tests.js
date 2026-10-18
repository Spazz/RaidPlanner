/**
 * Raidsmith - PM wave 2, Planner side: sign-up markers, 'also' filing, Standby benching (tests)
 * Run: node wave2-planner-tests.js
 *
 * The guild tracker's planner seed may put a marker ({ kind, text }) on a sign-up. These tests drive the pure half in a vm
 * sandbox (the same loader as the other suites); the seed-to-screen half (size, date-only raids, Refresh) is in
 * raidcontext-tests.js. Covers:
 *   - SignupMarker.clean: the five kinds, printable ASCII only, at most 60 characters, a default text, anything else dropped.
 *   - The importer: a marker lands on the new player (seated, bench, Absent tray); an 'also' sign-up is filed on the bench as
 *     Signed up and Optimize never pulls it in; a seated player is not demoted by gaining one; an 'also' player the leader
 *     seated by hand stays seated across a re-sync.
 *   - The re-sync: diff.marked carries a marker change, a marker alone is no report line (hasRaidHelperChanges false,
 *     describeRaidHelperChanges empty) but applyMarkers sets, changes and clears it.
 *   - The marker is transient: not in the share code, the saved roster or the local save, and setting it is no plan change.
 *   - Standby: with more candidates than seats the Standby players are held out of the first pass as far as the overflow
 *     needs (Optimizer.holdStandby), never below the role floors; the bench refinement can still pull one back in.
 *   - The tag: getMarkerTag, the spoken slot label and the tray slots show it.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const Scenarios = require('./scenarios.js');

const slotSource = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel') + '\n' + app.slice('const SignupTray = {', 'const UnplacedDialog');
const ctx = app.sandbox(['State', 'Config', 'Import', 'Optimizer', 'SignupMarker', 'SignupStatus', 'PlanStore', 'PlanSession', 'LocalPicks', 'nextUid',
  'getMarkerTag', 'playerSlotLabel', 'seatedSlotHTML', 'SignupTray'], { extraSource: slotSource });
const { State, Config, Import, Optimizer, SignupMarker, PlanStore, PlanSession, nextUid, getMarkerTag, playerSlotLabel, seatedSlotHTML, SignupTray } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
}

function reset(raid = 'bt') {
  State.gameVersion = 'tbc';
  State.selectedRaid = raid;
  State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
  State.rosterName = 'Wave 2'; State.planId = null; State.notes = '';
}
const MARKS = {
  late: { kind: 'late', text: 'Late: 21:00' }, leaving: { kind: 'leaving', text: 'Leaves: 22:00' }, standby: { kind: 'standby', text: 'Standby' },
  also: { kind: 'also', text: 'Also in: Team B raid' }, away: { kind: 'away', text: 'Away: notice' },
};
let n = 0;
const su = (name, className, specName, marker) => ({ id: ++n, name, className, specName, position: n, ...(marker ? { marker } : {}) });
const importSignUps = (signUps, opts) => Import.importRaidHelper(JSON.stringify({ title: 'Wave 2', signUps }), opts);
const everyone = () => [...State.groups.flat(), ...State.bench, ...State.unplaced];
const named = name => everyone().find(p => p.name === name);
const seatedNames = () => State.groups.flat().map(p => p.name);
const benchedNames = () => State.bench.map(p => p.name).sort();
const same = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);

// A small TBC raid whose sign-ups carry one marker each.
const smallRaid = () => [
  su('Aldric', 'Warrior', 'Protection', MARKS.late),
  su('Brindle', 'Mage', 'Fire'),
  su('Cassia', 'Priest', 'Holy', MARKS.standby),
  su('Dunmar', 'Absence', null, MARKS.away),
  su('Eliora', 'Mage', 'Arcane', MARKS.also),
  su('Fenwick', 'Rogue', 'Combat', MARKS.leaving),
];

// ── SignupMarker ─────────────────────────────────────────────────
check('SignupMarker.clean: the five kinds are kept as { kind, text }; unknown kinds and non-objects are dropped', () => {
  for (const marker of Object.values(MARKS)) assert.deepEqual(plain(SignupMarker.clean(marker)), marker);
  for (const bad of [null, undefined, 'standby', 42, [], {}, { kind: 'bench', text: 'x' }, { kind: 'constructor' }, { text: 'Standby' }]) assert.equal(SignupMarker.clean(bad), undefined, JSON.stringify(bad));
});

check('SignupMarker.clean: text is printable ASCII, trimmed, at most 60 characters, and a kind default when empty', () => {
  assert.equal(SignupMarker.clean({ kind: 'away', text: '  Away\u2014 notice\u00e9\n ' }).text, 'Away notice');
  assert.equal(SignupMarker.clean({ kind: 'also', text: 'x'.repeat(100) }).text.length, 60);
  assert.equal(SignupMarker.clean({ kind: 'standby' }).text, 'Standby');
  assert.equal(SignupMarker.clean({ kind: 'late', text: '\u2605\u2605' }).text, 'Late');
  assert.equal(SignupMarker.clean({ kind: 'late', text: 123 }).text, 'Late');
});

check('SignupMarker: label by kind, same() compares kind and text, isStandby', () => {
  assert.deepEqual(Object.values(MARKS).map(m => SignupMarker.label(m)), ['Late', 'Leaves', 'Standby', 'Also in', 'Away']);
  assert.equal(SignupMarker.label(undefined), '');
  assert(SignupMarker.same(undefined, null) && SignupMarker.same(MARKS.late, { ...MARKS.late }));
  assert(!SignupMarker.same(MARKS.late, undefined) && !SignupMarker.same(undefined, MARKS.late) && !SignupMarker.same(MARKS.late, { kind: 'late', text: 'Late: 20:00' }) && !SignupMarker.same(MARKS.late, MARKS.leaving));
  assert(SignupMarker.isStandby({ marker: MARKS.standby }) && !SignupMarker.isStandby({ marker: MARKS.also }) && !SignupMarker.isStandby({}) && !SignupMarker.isStandby(null));
});

// ── Import ───────────────────────────────────────────────────────
check('import: a marker lands on seated, benched and Absent players; \'also\' waits on the bench as Signed up; a sign-up without a valid marker has none', () => {
  reset();
  assert(importSignUps([...smallRaid(), su('Galdor', 'Druid', 'Restoration', { kind: 'bogus', text: 'x' })]).success);
  const marker = name => (named(name).marker ? plain(named(name).marker) : null);
  assert.deepEqual(marker('Aldric'), MARKS.late);
  assert.deepEqual(marker('Cassia'), MARKS.standby);
  assert.deepEqual(marker('Fenwick'), MARKS.leaving);
  assert.equal(marker('Brindle'), null);
  assert.equal(marker('Galdor'), null, 'an unknown kind is dropped');
  assert(State.unplaced.includes(named('Dunmar')) && marker('Dunmar').kind === 'away', 'an Away row arrives as Absent with its marker');
  assert.equal(named('Dunmar').signupStatus, 'absent');
  const eliora = named('Eliora');
  assert(State.bench.includes(eliora) && !seatedNames().includes('Eliora'));
  assert.deepEqual([eliora.signupStatus, eliora.groupNumber, eliora.imported], ['confirmed', 0, true]);
  assert(seatedNames().includes('Aldric') && seatedNames().includes('Fenwick'), 'late and leaving markers change no placement');
});

check('\'also\': Optimize never pulls the benched sign-up in, even with seats free; the leader\'s drag seats it, and Optimize then keeps it seated', () => {
  reset();
  assert(importSignUps(smallRaid()).success);
  Optimizer.optimize();
  assert(State.bench.includes(named('Eliora')) && State.groups.flat().length < 25, 'seats are free and Eliora still waits');
  // The leader seats her (what the bench drag does: into a group, out of the bench).
  const eliora = named('Eliora');
  State.bench.splice(State.bench.indexOf(eliora), 1);
  eliora.groupNumber = 1;
  State.groups[0].push(eliora);
  State.roster = State.groups.flat();
  Optimizer.optimize();
  assert(seatedNames().includes('Eliora'), 'a seated also-in-another-raid player stays seated');
  assert.equal(eliora.marker.kind, 'also');
});

check('\'also\': a player already seated is not demoted by gaining the marker; one the leader seated by hand stays across re-syncs', () => {
  reset();
  assert(importSignUps(smallRaid().map(s => (s.name === 'Eliora' ? su('Eliora', 'Mage', 'Arcane') : s))).success);
  const eliora = named('Eliora');
  assert(seatedNames().includes('Eliora'), 'signed up with no marker: seated by the import');
  const withAlso = smallRaid();
  let diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: withAlso }));
  assert.deepEqual([diff.demoted.length, diff.restatus.length, diff.promoted.length], [0, 0, 0]);
  assert.equal(diff.marked.find(m => m.player === eliora).marker.kind, 'also');
  Import.applyRaidHelperSync(diff);
  assert(seatedNames().includes('Eliora') && eliora.marker.kind === 'also', 'seated, now tagged');
  // A later re-sync with the same marker changes nothing.
  diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: withAlso }));
  same(diff.marked, []);
  assert(!Import.hasRaidHelperChanges(diff));
  assert(seatedNames().includes('Eliora'));
});

check('\'also\' on a sign-up new to a plan is benched by the re-sync (not seated into an Open slot); a benched one that loses the marker is only reported as confirmed', () => {
  reset();
  assert(importSignUps(smallRaid().filter(s => s.name !== 'Eliora')).success);
  const rows = smallRaid();
  let diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: rows }));
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].category, 'bench');
  Import.applyRaidHelperSync(diff);
  assert(State.bench.includes(named('Eliora')) && named('Eliora').marker.kind === 'also');
  diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: rows.map(s => (s.name === 'Eliora' ? su('Eliora', 'Mage', 'Arcane') : s)) }));
  assert.equal(diff.marked[0].marker, null);
  assert.equal(diff.promoted.length, 1, 'once free of the other raid she is a confirmed sign-up on the bench');
  assert(State.bench.includes(named('Eliora')), 'the diff alone moves nobody');
});

// ── Re-sync ──────────────────────────────────────────────────────
check('re-sync: a marker change is in diff.marked and applied; a marker alone raises no report, but another change still does; a dropped marker is cleared', () => {
  reset();
  assert(importSignUps(smallRaid()).success);
  const aldric = named('Aldric');
  // The seed moves Aldric to a new text, clears Fenwick, tags Brindle.
  const next = smallRaid().map(s => (s.name === 'Aldric' ? { ...s, marker: { kind: 'late', text: 'Late: 21:30' } } : s.name === 'Fenwick' ? { ...s, marker: undefined } : s.name === 'Brindle' ? { ...s, marker: MARKS.leaving } : s));
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: next }));
  same(diff.marked.map(m => m.player.name).sort(), ['Aldric', 'Brindle', 'Fenwick']);
  assert.equal(Import.hasRaidHelperChanges(diff), false, 'a marker alone is not worth a banner');
  assert.equal(Import.describeRaidHelperChanges(diff), '');
  assert.equal(aldric.marker.text, 'Late: 21:00', 'the diff touches nothing');
  Import.applyMarkers(diff);
  assert.equal(aldric.marker.text, 'Late: 21:30');
  assert.equal(named('Brindle').marker.kind, 'leaving');
  assert.equal('marker' in named('Fenwick'), false, 'cleared, not left as undefined');
  // With a real change in the same diff the report lists only that change.
  const withNew = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: [...next, su('Harlan', 'Hunter', 'Marksmanship', MARKS.standby)] }));
  assert.equal(Import.hasRaidHelperChanges(withNew), true);
  assert.equal(Import.describeRaidHelperChanges(withNew), '1 new sign-up');
  Import.applyRaidHelperSync(withNew);
  assert.equal(named('Harlan').marker.kind, 'standby', 'a new sign-up arrives with its marker');
});

check('re-sync: a hand-added player (no sign-up) and a player the seed no longer lists are not touched by markers', () => {
  reset();
  assert(importSignUps(smallRaid()).success);
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps: smallRaid().filter(s => s.name !== 'Aldric') }));
  assert(diff.removed.some(p => p.name === 'Aldric'));
  assert(!diff.marked.some(m => m.player.name === 'Aldric'));
});

// ── The marker is not part of the plan ───────────────────────────
check('transient: no marker in the share code, the saved roster or the local save; a read-back has none; setting one is no plan change', () => {
  reset();
  State.planId = 'plan:wave2';
  assert(importSignUps(smallRaid()).success);
  PlanSession.ready = true;
  PlanSession.observe();
  const codeBefore = Import.exportShareString();
  const rosterBefore = JSON.stringify(Import.exportRoster('Wave 2'));
  for (const text of [codeBefore, rosterBefore, JSON.stringify(PlanStore.capture())]) {
    assert(!/marker|Standby|Late:|Away:|Also in|Leaves:/.test(text), text.slice(0, 120));
  }
  // Setting and clearing markers by hand: no change step, no different code.
  const undoDepth = PlanSession.undo.length;
  named('Brindle').marker = { ...MARKS.standby };
  delete named('Aldric').marker;
  assert.equal(PlanSession.observe().changed, false);
  assert.equal(PlanSession.undo.length, undoDepth);
  assert.equal(Import.exportShareString(), codeBefore);
  // Reading the code back: no markers.
  assert(Import.importAddonString(codeBefore).success);
  assert(everyone().every(p => !p.marker));
  assert.equal(PlanStore.capture().groups.flat().some(p => 'marker' in p), false);
});

check('transient: Undo and a rebuilt copy keep the markers of the same plan, another plan gets none', () => {
  reset();
  State.planId = 'plan:wave2';
  assert(importSignUps(smallRaid()).success);
  const before = PlanStore.capture();
  assert(PlanStore.restore(before), 'restore of the same plan');
  assert.equal(named('Cassia').marker.kind, 'standby');
  assert.equal(named('Dunmar').marker.kind, 'away', 'the Absent tray too');
  assert.equal(named('Eliora').marker.kind, 'also', 'and the bench');
  const other = { ...before, planId: 'plan:other' };
  assert(PlanStore.restore(other));
  assert(everyone().every(p => !p.marker));
});

// ── Standby ──────────────────────────────────────────────────────
// A Standby player (the guild's "happy to sit out if needed") is held out of the first pass of Optimizer.selectSeated as far
// as the overflow (candidates - seats) needs (Optimizer.holdStandby), never below the tank/healer floors, and joins the
// overflow list of the bench refinement (refineBench). That trade pulls a held player back in only when seating them raises
// the raid total by more than its tolerance (0.5) AND brings a party buff, raid debuff or utility the raid would otherwise lack
// (wave 6, Optimizer.raidCoverage): buff providers come back, a player who adds only value (a sixth healer) stays out.
// T50's 25 primary sign-ups (2 tanks, 6 healers, 17 DPS) plus two more Destruction Warlocks named to sort first: 27 candidates.
const T50 = Scenarios.scenarios.find(s => s.id === 'T50').entries.filter(e => !e[2]);
const E27 = [...T50, ['destro', 'Aaa'], ['destro', 'Aab']];
function runEntries(entries, standbyNames) {
  reset();
  const signUps = entries.map(([key, name, status], i) => {
    const sign = Scenarios.signUp(key, name, status, i + 1);
    return standbyNames.includes(name) ? { ...sign, marker: MARKS.standby } : sign;
  });
  assert(importSignUps(signUps).success);
  assert.equal(State.groups.flat().length, 25);
  return benchedNames();
}
const standbySeated = () => State.groups.flat().filter(p => SignupMarker.isStandby(p)).length;

check('Standby: holdStandby holds at most the overflow, only Standby players, and never below a role floor or a locked player', () => {
  const floors = { tank: 2, healer: 5 };
  const mk = (name, role, extra) => ({ name, class: 'X', spec: 'Y', role, ...extra });
  const standby = { marker: MARKS.standby };
  const dps = n => Array.from({ length: n }, (_, i) => mk('d' + i, 'melee_dps'));
  const heldNames = (pool, seats) => Optimizer.holdStandby(pool, seats, floors).map(p => p.name).sort();
  // 3 Standby DPS among 26 candidates for 25 seats: one is held (the other two sit); 27 -> two; 28 or more -> all three.
  const three = [mk('s1', 'melee_dps', standby), mk('s2', 'melee_dps', standby), mk('s3', 'melee_dps', standby)];
  assert.equal(heldNames([...three, ...dps(23)], 25).length, 1);
  assert.equal(heldNames([...three, ...dps(24)], 25).length, 2);
  assert.equal(heldNames([...three, ...dps(25)], 25).length, 3);
  assert.equal(heldNames([...three, ...dps(40)], 25).length, 3, 'never more than the Standby players there are');
  same(heldNames([...three, ...dps(22)], 25), [], 'a raid that is not over-full holds nobody');
  same(heldNames([...dps(30)], 25), [], 'no marker, no hold');
  // Tanks and healers are held only beyond the floors, counted on the pool that remains.
  const tanks = [mk('t1', 'tank', standby), mk('t2', 'tank', standby), mk('t3', 'tank')];
  const healers = Array.from({ length: 6 }, (_, i) => mk('h' + i, 'healer', standby));
  assert.equal(heldNames([...tanks, ...dps(22)], 24).length, 1, 'three tanks, floor two, two of them Standby: one may be held');
  assert.equal(heldNames([tanks[0], tanks[1], ...dps(23)], 24).length, 0, 'the only two tanks are both Standby: neither is held');
  assert.equal(heldNames([...healers, ...dps(21)], 25).length, 1, 'six Standby healers, floor five: one may be held');
  assert.equal(heldNames([...healers.slice(0, 5), ...dps(22)], 25).length, 0, 'five Standby healers are the floor');
  // A comp-template lock keeps the seat.
  same(heldNames([mk('s1', 'melee_dps', { ...standby, locked: true }), ...dps(25)], 25), []);
});

check('Standby: a unique-spec Standby player is benched when the raid is over-full (unmarked he is seated); a second Optimize keeps the board', () => {
  same(runEntries(E27, []), ['Rainoffire', 'Voidcaller']);
  assert(seatedNames().includes('Plaguebringer'), 'the only Affliction Warlock sits when nobody volunteers');
  const benched = runEntries(E27, ['Plaguebringer']);
  assert(benched.includes('Plaguebringer') && benched.length === 2, benched.join(','));
  assert.equal(standbySeated(), 0);
  assert.equal(named('Plaguebringer').marker.kind, 'standby', 'the benched player keeps the tag');
  const before = seatedNames().sort().join();
  Optimizer.optimize();
  assert.equal(seatedNames().sort().join(), before, 'Optimize again changes nothing');
});

check('Standby: twins of the other seated players are benched whoever sorts first; only as many are held as the overflow needs', () => {
  same(runEntries(E27, ['Aaa', 'Aab']), ['Aaa', 'Aab']);
  same(runEntries(E27, ['Immolator', 'Rainoffire']), ['Immolator', 'Rainoffire']);
  same(runEntries(E27, ['Aaa']), ['Aaa', 'Voidcaller'], 'one Standby: it is benched, the other bench place falls as it always did');
  // 26 candidates, three Standby Warlocks: one bench place, so two of them sit.
  const benched = runEntries([...T50, ['destro', 'Aaa']], ['Aaa', 'Immolator', 'Rainoffire']);
  same(benched, ['Aaa']);
  assert.equal(standbySeated(), 2);
});

check('Standby: the role floors win - Standby tank and healers at the floor stay seated, and the bench is DPS', () => {
  const t49 = Scenarios.scenarios.find(s => s.id === 'T49').entries.filter(e => e[1] !== 'Waterwalker' && e[1] !== 'Cindermaw'); // 2 tanks, 5 healers, 20 DPS
  const support = ['Ramparts', 'Ironbulwark', 'Soulmend', 'Everbloom', 'Thornwhisper', 'Painless', 'Chantress'];
  const plainBench = runEntries(t49, []);
  const benched = runEntries(t49, support);
  assert.equal(State.groups.flat().filter(p => support.includes(p.name)).length, 7, 'benching one of them would drop below the floors');
  same(benched, plain(plainBench));
  // Standby DPS beside them: the floors fill first, then the Standby twin of a benched DPS is the one left out.
  same(plainBench, ['Mutilator', 'Swashbuck']);
  same(runEntries(t49, [...support, 'Shivster']), ['Mutilator', 'Shivster'], 'Shivster is the Combat Rogue twin of Swashbuck');
  assert.equal(State.groups.flat().filter(p => support.includes(p.name)).length, 7);
  // Six healers (floor five): a Standby one beyond the floor can be held, the floor ones stay.
  const healers = ['Soulmend', 'Everbloom', 'Thornwhisper', 'Painless', 'Chantress', 'Waterwalker'];
  runEntries(Scenarios.scenarios.find(s => s.id === 'T49').entries.filter(e => e[1] !== 'Cindermaw' && e[1] !== 'Mutilator'), healers);
  assert(State.groups.flat().filter(p => p.role === 'healer').length >= 5, 'at least the floor of healers sits');
});

check('Standby: the bench refinement pulls a held Standby player back in only when seating them brings a buff the raid would lack; one who adds only value stays out', () => {
  // Elemental Shaman, Enhancement Shaman (Windfury), Restoration Shaman and Shadow Priest: each is held first, then traded back in (the raid total
  // rises by 3 to 60 points against the 0.5 tolerance, and each brings a buff, debuff or utility nobody else seated has), and two non-Standby players sit out.
  for (const name of ['Stormcaller', 'Thunderfist', 'Spiritlink', 'Dreamless']) {
    const benched = runEntries(E27, [name]);
    assert(seatedNames().includes(name), name + ' is seated again');
    assert.equal(benched.length, 2);
    assert.equal(State.bench.filter(p => SignupMarker.isStandby(p)).length, 0, name);
  }
  // The Holy Priest beyond the healer floor is worth more to the raid total than the 0.5 tolerance (the old rule seated him again), but he brings nothing
  // the raid lacks: the volunteer stays out and a player who did not volunteer sits.
  const benched = runEntries(E27, ['Seraphine']);
  assert(benched.includes('Seraphine') && benched.length === 2, benched.join(','));
  assert.equal(standbySeated(), 0);
  // The only Affliction Warlock adds nothing the refinement can use: he stays out (test above).
});

check('Standby: nobody over capacity means nobody is held, and a Standby player is seated like anyone else', () => {
  reset();
  assert(importSignUps([su('Aldric', 'Warrior', 'Protection'), su('Brindle', 'Mage', 'Fire', MARKS.standby), su('Cassia', 'Priest', 'Holy')]).success);
  assert(seatedNames().includes('Brindle') && State.bench.length === 0);
});

// ── The tag ──────────────────────────────────────────────────────
check('tag: getMarkerTag shows a short label with the text as its tooltip (Late and Leaving show the text itself), escaped; nothing without a marker', () => {
  assert.equal(getMarkerTag({}), '');
  assert.equal(getMarkerTag({ marker: { kind: 'nope', text: 'x' } }), '');
  const html = getMarkerTag({ marker: MARKS.also });
  assert.match(html, /^<span class="marker-tag marker-also" title="Also in: Team B raid">Also in<\/span>$/);
  assert.match(getMarkerTag({ marker: MARKS.late }), /^<span class="marker-tag marker-late" title="Late: 21:00">Late: 21:00<\/span>$/);
  assert.match(getMarkerTag({ marker: MARKS.leaving }), /^<span class="marker-tag marker-leaving" title="Leaves: 22:00">Leaves: 22:00<\/span>$/);
  for (const kind of ['away', 'also', 'standby']) assert.equal(SignupMarker.tagText(MARKS[kind]), SignupMarker.label(MARKS[kind]), kind + ' keeps its short label');
  assert.equal(SignupMarker.tagText(undefined), '');
  assert(!/<script/.test(getMarkerTag({ marker: { kind: 'away', text: '"><script>' } })), 'the text is escaped');
  assert(!/<script/.test(getMarkerTag({ marker: { kind: 'late', text: '"><script>' } })), 'also on Late, which shows the text');
  assert(/\.marker-tag\b/.test(app.css) && Object.keys(MARKS).every(kind => new RegExp(`\\.marker-${kind}\\b`).test(app.css)), 'app.css styles every kind');
});

check('tag: the spoken slot label includes the text; seated, bench and Absent slots show the tag', () => {
  State.gameVersion = 'tbc';
  const player = (over) => Object.assign({ uid: nextUid(), name: 'Tarlox-Realm', class: 'WARRIOR', spec: 'Fury', role: 'melee_dps' }, over);
  assert.equal(playerSlotLabel(player({ marker: MARKS.late }), 'group 2'), 'Tarlox, Fury Warrior, group 2, Late: 21:00');
  assert.equal(playerSlotLabel(player(), 'group 2'), 'Tarlox, Fury Warrior, group 2');
  assert(seatedSlotHTML(player({ marker: MARKS.standby }), 0, 0).includes('class="marker-tag marker-standby" title="Standby"'));
  assert(!seatedSlotHTML(player(), 0, 0).includes('marker-tag'));
  const benched = SignupTray.slotHTML({ p: player({ signupStatus: 'confirmed', marker: MARKS.also }), bi: 0, unplaced: false }, 'bench');
  assert(benched.includes('marker-also') && /aria-label="Tarlox, Fury Warrior, on the bench, Also in: Team B raid"/.test(benched), benched.slice(0, 300));
  const absent = SignupTray.slotHTML({ p: player({ signupStatus: 'absent', marker: MARKS.away }), unplaced: true }, 'absent');
  assert(absent.includes('marker-away') && /aria-label="[^"]*Absent, Away: notice"/.test(absent), absent.slice(0, 300));
});

console.log(`\nWave 2 Planner tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
