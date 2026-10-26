/**
 * Raidsmith guild tracker - person-level reads of a per-character rank (user-hierarchy build, lane B1a-2)
 * Run: node tests/guild/guild-person-rank-tests.js
 *
 * Rank lives on the characters (core_rank, left_on, trial dates); worker/person-rank.js turns a person's characters into the answers attendance needs, with no
 * `status` scalar on the person. Two layers:
 *   - the pure helper over every ORDER of the characters (nothing may depend on which row came first);
 *   - the real recompute (loadDay -> consolidateDay -> attendance rows) over a seeded database, once with the SQL rows as the database returns them and once
 *     with every result set REVERSED, which must give byte-identical attendance.
 * The five cases: Raider main on A + teamless Social alt -> expected on A only; Raider main on A + Trial alt on B -> expected on both, trial review lists B
 * only; main on A + teamless alt present at B's raid credits A; a person "left" only when EVERY character left (latest date wins); home team = the Main, never
 * the team of the most-present character. The attendance policy stays raider / trial / reserve: Social is never expected.
 */
const assert = require('node:assert/strict');
const { createD1Fake } = require('../d1-fake');
const { load } = require('../guild-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function* permutations(list) {
  if (list.length <= 1) { yield list; return; }
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const tail of permutations(rest)) yield [list[i], ...tail];
  }
}

const ch = (id, over = {}) => ({ id, key: `${id}|`, teamId: null, isMain: false, coreRank: 'raider', leftOn: null, trialStart: null, trialEnd: null, ...over });
const personOf = (characters) => ({ playerId: 'p1', characters });
const everyOrder = (characters) => [...permutations(characters)].map(personOf);

// ---------------------------------------------------------------------------
// The pure helper, over every order of the characters

check('Raider main on A + teamless Social alt: expected on A only (statuses raider / trial / reserve), the alt is on no roster', async () => {
  const rank = await load('worker/person-rank.js');
  const ranks = ['raider', 'trial'];
  for (const person of everyOrder([ch('main', { teamId: 'A', isMain: true }), ch('alt', { coreRank: 'social' })])) {
    assert.equal(rank.expectedOnTeam(person, 'A', ranks), true);
    assert.equal(rank.expectedOnTeam(person, 'B', ranks), false);
    assert.equal(rank.expectedOnTeam(person, null, ranks), false, 'no team is never a team');
    assert.equal(rank.isOnTeamRoster(person, 'A'), true);
    assert.equal(rank.homeTeamId(person), 'A');
    assert.equal(rank.mainRank(person), 'raider');
    assert.equal(rank.isGoneOn(person, '2026-10-10'), false, 'the Raider main keeps the person here');
    assert.equal(rank.leftOn(person), null);
  }
  // The same Social alt PLACED on B (placement is not removed automatically): still never expected, never on the roster of B.
  for (const person of everyOrder([ch('main', { teamId: 'A', isMain: true }), ch('alt', { teamId: 'B', coreRank: 'social' })])) {
    assert.equal(rank.expectedOnTeam(person, 'B', ['raider', 'trial', 'reserve']), false);
    assert.equal(rank.isOnTeamRoster(person, 'B'), false);
    assert.equal(rank.hasCharacterHereOn(person, 'B', '2026-10-10'), false, 'a Social alt without a date is not here');
  }
});

check('Raider main on A + Trial alt on B: expected on both, the trial review lists B only (the alt\'s own dates)', async () => {
  const rank = await load('worker/person-rank.js');
  for (const person of everyOrder([
    ch('main', { teamId: 'A', isMain: true }),
    ch('alt', { teamId: 'B', coreRank: 'trial', trialStart: '2026-10-01', trialEnd: '2026-10-15' }),
  ])) {
    assert.equal(rank.expectedOnTeam(person, 'A', ['raider', 'trial']), true);
    assert.equal(rank.expectedOnTeam(person, 'B', ['raider', 'trial']), true);
    assert.equal(rank.expectedOnTeam(person, 'B', ['raider']), false, 'the policy\'s set decides');
    assert.deepEqual(rank.trialReviews(person), [{ characterId: 'alt', teamId: 'B', trialStart: '2026-10-01', trialEnd: '2026-10-15' }]);
    assert.equal(rank.mainRank(person), 'raider', 'the ladder reads the main, not the trial alt');
  }
  // A Trial character that is teamless, left or Social-ranked has no trial review.
  const none = personOf([ch('a', { teamId: null, coreRank: 'trial' }), ch('b', { teamId: 'A', coreRank: 'trial', leftOn: '2026-09-01' }), ch('c', { teamId: 'A', coreRank: 'social' })]);
  assert.deepEqual(rank.trialReviews(none), []);
});

check('home team is the Main\'s: a teamless main has none, two mains (bad data) pick the lowest identity, and no character count decides it', async () => {
  const rank = await load('worker/person-rank.js');
  for (const person of everyOrder([ch('m', { teamId: 'A', isMain: true }), ch('x', { teamId: 'B' }), ch('y', { teamId: 'B' })])) assert.equal(rank.homeTeamId(person), 'A');
  for (const person of everyOrder([ch('m', { teamId: null, isMain: true }), ch('x', { teamId: 'B' })])) assert.equal(rank.homeTeamId(person), null);
  for (const person of everyOrder([ch('m2', { teamId: 'B', isMain: true }), ch('m1', { teamId: 'A', isMain: true })])) assert.equal(rank.homeTeamId(person), 'A', 'lowest id');
  assert.equal(rank.homeTeamId(personOf([ch('x', { teamId: 'B' })])), null, 'no main, no home');
  assert.equal(rank.homeTeamId({ playerId: 'p', characters: [] }), null);
});

check('a person "left" only when EVERY character has a left-on date: the latest date wins; gone is read per day', async () => {
  const rank = await load('worker/person-rank.js');
  for (const person of everyOrder([ch('a', { teamId: 'A', isMain: true, leftOn: '2026-09-01' }), ch('b', { teamId: 'B', leftOn: '2026-09-20' })])) {
    assert.equal(rank.leftOn(person), '2026-09-20');
    assert.equal(rank.isGoneOn(person, '2026-09-20'), false, 'still here up to and including the latest day');
    assert.equal(rank.isGoneOn(person, '2026-09-21'), true);
    assert.equal(rank.hasCharacterHereOn(person, 'A', '2026-09-10'), false, 'the A character left on 09-01');
    assert.equal(rank.hasCharacterHereOn(person, 'B', '2026-09-10'), true);
  }
  for (const person of everyOrder([ch('a', { teamId: 'A', isMain: true, leftOn: '2026-09-01' }), ch('b', { teamId: 'B' })])) {
    assert.equal(rank.leftOn(person), null, 'one character that did not leave: the person did not');
    assert.equal(rank.isGoneOn(person, '2027-01-01'), false);
  }
  // Social without a date (the old "inactive" with a break) is gone on every day; a Social with a date is here until then, as before.
  const social = personOf([ch('a', { teamId: 'A', isMain: true, coreRank: 'social' })]);
  assert.equal(rank.isGoneOn(social, '2026-10-10'), true);
  const socialDated = personOf([ch('a', { teamId: 'A', isMain: true, coreRank: 'social', leftOn: '2026-10-10' })]);
  assert.equal(rank.isGoneOn(socialDated, '2026-10-10'), false);
  assert.equal(rank.isGoneOn(socialDated, '2026-10-11'), true);
});

check('characterOfRow shapes a characters row (the predicate itself is pinned in guild-team-roster-tests.js)', async () => {
  const rank = await load('worker/person-rank.js');
  assert.deepEqual(rank.characterOfRow({ id: 'c1', team_id: 't', is_main: 1, core_rank: 'trial', left_on: null, trial_start: '2026-10-01', trial_end: null }),
    { id: 'c1', teamId: 't', isMain: true, coreRank: 'trial', leftOn: null, leftReason: null, trialStart: '2026-10-01', trialEnd: null });
  assert.deepEqual(rank.characterOfRow({ core_rank: 'social', is_main: 0 }),
    { id: null, teamId: null, isMain: false, coreRank: 'social', leftOn: null, leftReason: null, trialStart: null, trialEnd: null }, 'missing columns read as null');
});

// ---------------------------------------------------------------------------
// The recompute over a seeded database

const NOW = 1_800_000_000_000;
const DAY = '2026-10-10';
const STARTS = Date.parse('2026-10-10T23:00:00Z');
const GUILD = { id: 'g1', region: 'US', game_version: 'tbc', time_zone: 'America/Chicago' };

function seedGuild(db, { policy } = {}) {
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  for (const team of ['tA', 'tB', 'tC']) db.sqlite.exec(`INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('${team}', 'g1', '${team}', 25, 0, 1)`);
  if (policy) db.sqlite.exec(`INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_at) VALUES ('ap1', 'g1', NULL, '${JSON.stringify(policy)}', 1, 1)`);
}
const q = (value) => (value === null || value === undefined ? 'NULL' : `'${value}'`);
function addPerson(db, id) {
  db.sqlite.exec(`INSERT INTO players (id, guild_id, status, joined_on, created_at, updated_at) VALUES ('${id}', 'g1', 'raider', '2026-08-01', 1, 1)`);
}
function addChar(db, id, player, { team = null, main = 0, rank = 'raider', leftOn = null } = {}) {
  db.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm_key, class, is_main, created_at, updated_at, core_rank, left_on)
                  VALUES ('${id}', 'g1', '${player}', ${q(team)}, '${id}', '${id}', '', 'MAGE', ${main}, 1, 1, '${rank}', ${q(leftOn)})`);
}
let codeCounter = 0;
// A raid with a log of two boss pulls; `present` are character ids in both pulls.
function addRaid(db, id, team, present, { raidOn = DAY } = {}) {
  const code = `code${String(++codeCounter).padStart(12, '0')}`;
  db.sqlite.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, created_at, updated_at, time_known) VALUES ('${id}', 'g1', '${team}', '${raidOn}', ${STARTS}, 'log', 1, 1, 1)`);
  db.sqlite.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${id}', 'g1', '${code}', 'www', ${STARTS}, 1)`);
  for (const [pullId, offset] of [[`${codeCounter}1`, 0], [`${codeCounter}2`, 600000]]) {
    db.sqlite.exec(`INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at)
                    VALUES (${pullId}, '${id}', '${code}', ${pullId}, 1, 'Boss', 0, ${STARTS + offset}, ${STARTS + offset + 1000})`);
    for (const name of present) {
      db.sqlite.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (${pullId}, '${id}', 'g1', '${name}', '${name}', NULL, '', 'MAGE')`);
    }
  }
}

// The same database with every result set reversed: the SQL row order the code must not depend on.
function reversing(db) {
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => (await db.batch(statements)).map((result) => ({ ...result, results: [...(result.results || [])].reverse() })),
  };
}

const attendanceOf = (db) => db.sqlite.prepare(
  'SELECT raid_id, player_id, outcome, credit, signup_kind, attended, via_raid_id, credit_team_id, needs_review, flags FROM attendance ORDER BY raid_id, player_id',
).all().map((row) => ({ ...row }));

// Seeds, recomputes every raid in `raids` (id list), returns the attendance rows. reversed: every SQL result set reversed.
async function run(seed, raidIds, { reversed = false, policy } = {}) {
  const { recomputeRaid } = await load('worker/attendance-store.js');
  const db = createD1Fake();
  seedGuild(db, { policy });
  seed(db);
  const handle = reversed ? reversing(db) : db;
  const ctx = { db: handle, now: () => NOW };
  for (const id of raidIds) await recomputeRaid(ctx, GUILD, id);
  return attendanceOf(db);
}
// Both orders must agree exactly; returns the rows.
async function both(seed, raidIds, options) {
  const forward = await run(seed, raidIds, { ...options, reversed: false });
  const backward = await run(seed, raidIds, { ...options, reversed: true });
  assert.deepEqual(backward, forward, 'the attendance does not depend on the order of the SQL rows');
  return forward;
}
const cell = (rows, raid, player) => rows.find((row) => row.raid_id === raid && row.player_id === player);
const STATUS_POLICY = { expected: { mode: 'statuses' } }; // raider and trial are expected without a sign-up

check('the harness: a reversed database really answers its rows in the opposite order', async () => {
  const db = createD1Fake();
  seedGuild(db);
  addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
  const sql = db.prepare('SELECT id FROM players ORDER BY id');
  const forward = (await db.batch([sql]))[0].results.map((row) => row.id);
  const backward = (await reversing(db).batch([sql]))[0].results.map((row) => row.id);
  assert.deepEqual(forward, ['p1', 'p2', 'p3']);
  assert.deepEqual(backward, ['p3', 'p2', 'p1']);
});

check('recompute: Raider main on A + teamless Social alt -> the person is expected on A only (and never gets a row on B)', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'a1', 'p1', { rank: 'social' });                       // teamless Social alt
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addChar(db, 'm3', 'p3', { team: 'tB', main: 1 });
    addRaid(db, 'rA', 'tA', ['m2']);
    addRaid(db, 'rB', 'tB', ['m3']);
  }, ['rA', 'rB'], { policy: STATUS_POLICY });
  assert.deepEqual([cell(rows, 'rA', 'p1').outcome, cell(rows, 'rA', 'p1').credit], ['missed', 0], 'expected on A: no sign-up, not in the log -> a no-show');
  assert.equal(cell(rows, 'rB', 'p1'), undefined, 'not on B at all');
  assert.equal(cell(rows, 'rA', 'p2').outcome, 'present');
});

check('recompute: a Social main is never expected (the policy list stays raider / trial / reserve), even with reserve in the list', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1, rank: 'social' });   // placed, but Social
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addRaid(db, 'rA', 'tA', ['m2']);
  }, ['rA'], { policy: { expected: { mode: 'statuses', statuses: ['raider', 'trial', 'reserve'] } } });
  assert.equal(cell(rows, 'rA', 'p1'), undefined, 'a Social person without a sign-up and not in the log has no row (gone, never expected)');
});

check('recompute: Raider main on A + Trial alt on B -> expected on both A and B', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'a1', 'p1', { team: 'tB', rank: 'trial' });
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addChar(db, 'm3', 'p3', { team: 'tB', main: 1 });
    addRaid(db, 'rA', 'tA', ['m2']);
    addRaid(db, 'rB', 'tB', ['m3']);
  }, ['rA', 'rB'], { policy: STATUS_POLICY });
  assert.deepEqual([cell(rows, 'rA', 'p1').outcome, cell(rows, 'rA', 'p1').credit], ['missed', 0]);
  assert.deepEqual([cell(rows, 'rB', 'p1').outcome, cell(rows, 'rB', 'p1').credit], ['missed', 0], 'expected on B through the Trial alt');
});

check('recompute: expected is read off the character placed on the team: a Reserve alt on B is not in the default set, whatever the Raider main on A is', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });                   // raider main on A
    addChar(db, 'a1', 'p1', { team: 'tB', rank: 'reserve' });           // reserve alt on B
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addChar(db, 'm3', 'p3', { team: 'tB', main: 1 });
    addRaid(db, 'rA', 'tA', ['m2']);
    addRaid(db, 'rB', 'tB', ['m3']);
  }, ['rA', 'rB'], { policy: STATUS_POLICY });
  assert.equal(cell(rows, 'rA', 'p1').outcome, 'missed', 'raider on A: expected');
  assert.equal(cell(rows, 'rB', 'p1').outcome, 'no_signup', 'reserve on B: not in the default set, shown as No sign-up');
});

check('recompute: main on A + teamless alt present at B\'s raid -> an Other-team cell credited to A (home team), whichever order the rows come in', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'a1', 'p1');                                            // teamless Raider alt
    addChar(db, 'm3', 'p3', { team: 'tB', main: 1 });
    addRaid(db, 'rB', 'tB', ['m3', 'a1']);
  }, ['rB'], { policy: STATUS_POLICY });
  const fill = cell(rows, 'rB', 'p1');
  assert.deepEqual([fill.outcome, fill.credit_team_id, fill.credit, fill.attended], ['fill_in', 'tA', 1, 1], 'no raid for A that day: an extra counted cell, credited to A');
});

check('recompute: the Other-team credit also replaces the home team\'s own missed cell (A has a raid the same day)', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'a1', 'p1');                                            // teamless alt, plays at B
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addChar(db, 'm3', 'p3', { team: 'tB', main: 1 });
    addRaid(db, 'rA', 'tA', ['m2']);
    addRaid(db, 'rB', 'tB', ['m3', 'a1']);
  }, ['rA', 'rB'], { policy: STATUS_POLICY });
  assert.deepEqual([cell(rows, 'rB', 'p1').outcome, cell(rows, 'rB', 'p1').credit_team_id], ['fill_in', 'tA']);
  const home = cell(rows, 'rA', 'p1');
  assert.deepEqual([home.outcome, home.credit, home.via_raid_id], ['fill_in', 1, 'rB'], 'A\'s missed cell is replaced by the cell at B, which counts once');
});

check('recompute: fill-in credit is the home team, never the team of the most-present character (and no row order changes it)', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'a1', 'p1', { team: 'tB' });                            // the alt on B is the one in the raid of C
    addChar(db, 'a2', 'p1');                                            // (one character per person per team: this one is on no team)
    addChar(db, 'm3', 'p3', { team: 'tC', main: 1 });
    addRaid(db, 'rC', 'tC', ['m3', 'a1', 'a2']);                        // two of the person's three characters, both on B
  }, ['rC']);
  const fill = cell(rows, 'rC', 'p1');
  assert.deepEqual([fill.outcome, fill.credit_team_id], ['fill_in', 'tA'], 'home = the main\'s team A, not B where the present characters are');
});

check('recompute: a person whose main has no team is credited to no one (no home), and still gets the host row without a flag', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { main: 1 });                               // the main is teamless
    addChar(db, 'a1', 'p1', { team: 'tB' });
    addChar(db, 'm3', 'p3', { team: 'tC', main: 1 });
    addRaid(db, 'rC', 'tC', ['m3', 'a1']);
  }, ['rC']);
  const fill = cell(rows, 'rC', 'p1');
  assert.deepEqual([fill.outcome, fill.credit_team_id, fill.credit, fill.needs_review], ['fill_in', null, null, 0]);
});

check('recompute: a person who left (every character dated) is expected up to and including that day, a Social alt without a date changes nothing', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1, rank: 'social', leftOn: DAY });          // left on the raid day: a row as before
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1, rank: 'social', leftOn: '2026-10-09' }); // left the day before: no row
    addChar(db, 'm3', 'p3', { team: 'tA', main: 1 });
    addChar(db, 'a3', 'p3', { rank: 'social' });
    addRaid(db, 'rA', 'tA', ['m3']);
  }, ['rA']);
  assert.equal(cell(rows, 'rA', 'p1').outcome, 'no_signup', 'left on the raid day: still shown');
  assert.equal(cell(rows, 'rA', 'p2'), undefined, 'left before: no row');
  assert.equal(cell(rows, 'rA', 'p3').outcome, 'present');
});

check('recompute: a plan seat and a pasted name pick among same-named characters in a fixed order', async () => {
  const rows = await both((db) => {
    addPerson(db, 'p1'); addPerson(db, 'p2'); addPerson(db, 'p3');
    addChar(db, 'm1', 'p1', { team: 'tA', main: 1 });
    addChar(db, 'm2', 'p2', { team: 'tA', main: 1 });
    addChar(db, 'm3', 'p3', { team: 'tA', main: 1 });
    addRaid(db, 'rA', 'tA', ['m3']);
    db.sqlite.exec("INSERT INTO raid_plan (raid_id, name, name_key, group_number) VALUES ('rA', 'm1', 'm1', 1)");
  }, ['rA']);
  assert.equal(cell(rows, 'rA', 'p1').signup_kind, 'signed', 'the plan seat counts as a sign-up');
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
