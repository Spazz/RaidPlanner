/**
 * Raidsmith guild tracker - the Trial clock starts when the character ENTERED ITS TEAM (user decision 2026-10-26, replaces H-Q24 and R3-Q6)
 * Run: node tests/guild/guild-trial-clock-tests.js
 *
 * Migration 0040 adds characters.team_since (the instant the character was placed on its current team; NULL while it has none) and characters.trial_since (the instant its
 * rank became Trial), both kept by triggers so no writer sets them. worker/trial-clock.js starts a Trial's dates from them:
 *   trial_start = the guild-local date of the later of the two, trial_end = trial_start + teams.trial_days; a hand-set date is never overwritten;
 *   entering Trial while already on the team starts today; a team move while Trial restarts the clock on the new team; leaving a team ends the dates.
 * The first-raid rule and the updated_at floor are gone (their tests in guild-b4b-trial-tests.js were rewritten). Covered here:
 *   placement / rename / spec edit / move / release against team_since, the insert trigger, trial_since, the backfill order of the migration, the clock from team entry,
 *   hand-set dates, ranked to Trial on the team, the restart on a move, Make Main keeping the dates, idempotence and the scoped statements.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const TZ = 'America/New_York';
// Instants in the guild's zone (the b3 world's guild: America/New_York, UTC-5 in January).
const at = (date, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00-05:00`);
const localDate = (ms) => new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
const DAY = 86400000;

async function world({ teams = ['Alpha', 'Bravo'] } = {}) {
  const s = await scenario({ teams });
  const { trialClockStatement } = await load('worker/trial-clock.js');
  const { addDays } = await load('worker/attendance-calendar.js');
  s.addDays = addDays;
  s.today = () => localDate(s.w.clock.now);
  // Runs the clock (the whole guild, or the person / character given) -> the number of characters it wrote.
  s.clock = async (scope = {}) => (await s.w.db.batch([trialClockStatement(s.w.db, s.gid, { offsetMinutes: -300, ...scope })]))[0].meta.changes;
  s.row = (name) => s.one('SELECT id, core_rank, team_id, team_since, trial_since, trial_start, trial_end, created_at, updated_at FROM characters WHERE name = ?', name);
  s.dates = async (name) => {
    const row = await s.row(name);
    return [row.trial_start, row.trial_end];
  };
  s.raid = (key, team, on, names = [], hour = 20) => {
    const id = `r_${key.replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'Z')}`;
    s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at)
            VALUES ('${id}', '${s.gid}', '${s.tids[team]}', '${on}', ${at(on, hour)}, 'log', NULL, 'fp', 5, 1, 1)`);
    s.pulls = (s.pulls || 0) + 1;
    const code = `Code${s.pulls}Xx`.padEnd(16, 'X');
    s.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${id}', '${s.gid}', '${code}', 'fresh', 1, 1)`);
    s.exec(`INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (${s.pulls}, '${id}', '${code}', 1, 100, 'Boss', 1, 1, 2)`);
    for (const name of names) {
      s.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key) VALUES (${s.pulls}, '${id}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'nightslayer')`);
    }
  };
  // A Trial character on team `team` that entered the team (and became Trial) at `entered`, its clock not started.
  s.trial = async (name, { team = 0, entered = '2027-01-05', hour = 12 } = {}) => {
    const made = await s.person({ name, teamId: s.tids[team] });
    s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = NULL, trial_end = NULL, team_since = ${at(entered, hour)}, updated_at = ${at(entered, hour)} WHERE id = '${made.cid}'`);
    return made;
  };
  return s;
}

check('team_since: stamped when a character is made on a team or placed on one by the team route, NULL while it has none; trial_since: stamped when it is made a Trial', async () => {
  const s = await world();
  const onTeam = await s.person({ name: 'Onteam' });
  let row = await s.row('Onteam');
  assert.deepEqual([row.team_since, row.trial_since], [row.created_at, null], 'made on a team: the creation instant; a Raider has no trial_since');
  const noTeam = await s.person({ name: 'Noteam', teamId: null });
  row = await s.row('Noteam');
  assert.deepEqual([row.team_id, row.team_since, row.trial_since], [null, null, null]);
  await s.ok('gm', 'PUT', `/roster/${noTeam.pid}/characters/${noTeam.cid}/team`, { teamId: s.tids[1] }, 200);
  row = await s.row('Noteam');
  assert.deepEqual([row.team_id, row.team_since], [s.tids[1], s.w.clock.now], 'placed by the team route: the placement instant');
  assert.equal(row.team_since, row.updated_at);
  const trial = await s.person({ name: 'Newtrial', status: 'trial' });
  row = await s.row('Newtrial');
  assert.deepEqual([row.core_rank, row.team_since, row.trial_since], ['trial', row.created_at, row.created_at], 'made a Trial on a team: both instants are the creation');
  assert.ok(onTeam && trial);
});

check('a rename, a spec edit and an edit that names the same team leave team_since (and a started clock); only updated_at moves', async () => {
  const s = await world();
  const made = await s.trial('Steady', { entered: '2027-01-05' });
  assert.equal(await s.clock(), 1);
  assert.deepEqual(await s.dates('Steady'), ['2027-01-05', '2027-01-19']);
  const before = await s.row('Steady');
  await s.ok('gm', 'PATCH', `/roster/${made.pid}/characters/${made.cid}`, { mainSpec: 'Arcane' }, 200);
  await s.ok('gm', 'PATCH', `/roster/${made.pid}/characters/${made.cid}`, { name: 'Steadier' }, 200);
  await s.ok('gm', 'PATCH', `/roster/${made.pid}/characters/${made.cid}`, { teamId: s.tids[0], class: 'MAGE' }, 200);
  const after = await s.row('Steadier');
  assert.deepEqual([after.team_since, after.trial_since, after.trial_start, after.trial_end], [before.team_since, before.trial_since, '2027-01-05', '2027-01-19']);
  assert.ok(after.updated_at > before.updated_at, 'the edits did write the row');
  // A raw UPDATE that names team_id with the value it has changes nothing either.
  s.exec(`UPDATE characters SET team_id = '${s.tids[0]}', updated_at = ${s.w.clock.now + 5000} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Steadier')).team_since, before.team_since);
});

check('a team move resets team_since and restarts a Trial\'s clock on the new team: the dates start at the move, with the new team\'s trial days', async () => {
  const s = await world();
  s.exec(`UPDATE teams SET trial_days = 21 WHERE id = '${s.tids[1]}'`);
  const made = await s.trial('Mover', { entered: '2027-01-05' });
  await s.clock();
  assert.deepEqual(await s.dates('Mover'), ['2027-01-05', '2027-01-19']);
  s.w.advance(9 * DAY);
  await s.ok('gm', 'PATCH', `/roster/${made.pid}/characters/${made.cid}`, { teamId: s.tids[1] }, 200);
  const moved = await s.row('Mover');
  assert.equal(moved.team_id, s.tids[1]);
  assert.equal(moved.team_since, s.w.clock.now, 'the move instant');
  assert.deepEqual([moved.trial_start, moved.trial_end], [s.today(), s.addDays(s.today(), 21)], 'restarted at once on the new team');
  // The same through the team route (move = place on another team), and a Raider keeps no dates.
  s.w.advance(2 * DAY);
  await s.ok('gm', 'PUT', `/roster/${made.pid}/characters/${made.cid}/team`, { teamId: s.tids[0] }, 200);
  assert.deepEqual(await s.dates('Mover'), [s.today(), s.addDays(s.today(), 14)]);
  const raider = await s.person({ name: 'Moveraider' });
  await s.ok('gm', 'PUT', `/roster/${raider.pid}/characters/${raider.cid}/team`, { teamId: s.tids[1] }, 200);
  const r = await s.row('Moveraider');
  assert.deepEqual([r.team_since, r.trial_start, r.trial_end], [s.w.clock.now, null, null]);
  // The trigger alone (a raw move): the dates end and wait for the next clock run; dates written by the same UPDATE are a hand-set choice and stay.
  const raw = await s.trial('Rawmove', { entered: '2027-01-05' });
  await s.clock();
  assert.deepEqual(await s.dates('Rawmove'), ['2027-01-05', '2027-01-19']);
  s.exec(`UPDATE characters SET team_id = '${s.tids[1]}', updated_at = ${s.w.clock.now + 7000} WHERE id = '${raw.cid}'`);
  assert.deepEqual(await s.dates('Rawmove'), [null, null]);
  assert.equal((await s.row('Rawmove')).team_since, s.w.clock.now + 7000);
  const typed = await s.trial('Typedmove', { entered: '2027-01-05' });
  await s.clock();
  s.exec(`UPDATE characters SET team_id = '${s.tids[1]}', trial_start = '2027-03-01', trial_end = '2027-03-10', updated_at = ${s.w.clock.now + 8000} WHERE id = '${typed.cid}'`);
  assert.deepEqual(await s.dates('Typedmove'), ['2027-03-01', '2027-03-10']);
});

check('leaving a team clears team_since and ends a Trial\'s dates; placing it again restarts the clock at the placement', async () => {
  const s = await world();
  const made = await s.trial('Leaver', { entered: '2027-01-05' });
  await s.clock();
  assert.deepEqual(await s.dates('Leaver'), ['2027-01-05', '2027-01-19']);
  s.w.advance(4 * DAY);
  await s.ok('gm', 'DELETE', `/roster/${made.pid}/characters/${made.cid}/team`, {}, 200);
  let row = await s.row('Leaver');
  assert.deepEqual([row.team_id, row.team_since, row.trial_start, row.trial_end], [null, null, null, null]);
  assert.equal(await s.clock(), 0, 'a teamless Trial has no clock');
  s.w.advance(3 * DAY);
  await s.ok('gm', 'PUT', `/roster/${made.pid}/characters/${made.cid}/team`, { teamId: s.tids[1] }, 200);
  row = await s.row('Leaver');
  assert.deepEqual([row.team_since, row.trial_start, row.trial_end], [s.w.clock.now, s.today(), s.addDays(s.today(), 14)], 'placed again: a new entry, a new clock');
  // A raw release clears it the same way.
  s.exec(`UPDATE characters SET team_id = NULL WHERE id = '${made.cid}'`);
  row = await s.row('Leaver');
  assert.deepEqual([row.team_since, row.trial_start], [null, null]);
});

check('Make Main hands the Main\'s trial dates to the alt that takes the home team and the dates stay (entering a team from none does not restart them)', async () => {
  const s = await world();
  const main = await s.trial('Oldmain', { entered: '2027-01-05' });
  await s.clock();
  const alt = await s.alt(main.pid, 'Newmain');
  assert.equal((await s.row('Newmain')).core_rank, 'trial', 'an alt of a Trial person is a Trial');
  s.w.advance(5 * DAY);
  await s.ok('gm', 'POST', `/roster/${main.pid}/characters/${alt}/main`, {}, 200);
  const newMain = await s.row('Newmain');
  const oldMain = await s.row('Oldmain');
  assert.equal(newMain.team_id, s.tids[0], 'the home team follows the Main');
  assert.deepEqual([newMain.trial_start, newMain.trial_end], ['2027-01-05', '2027-01-19'], 'the dates sit on the Main and moved with it');
  assert.deepEqual([oldMain.team_id, oldMain.team_since, oldMain.trial_start, oldMain.trial_end], [null, null, null, null]);
  assert.equal(newMain.team_since, s.w.clock.now, 'a team entry of the character itself');
});

check('the insert trigger and the rank trigger: a character made with a team or a Trial rank is stamped, a rank change stamps / clears trial_since, an unchanged rank does not', async () => {
  const s = await world();
  const made = await s.person({ name: 'Ranker' });
  assert.equal((await s.row('Ranker')).trial_since, null);
  s.exec(`UPDATE characters SET core_rank = 'trial', updated_at = ${at('2027-01-06')} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Ranker')).trial_since, at('2027-01-06'), 'became Trial: that instant');
  s.exec(`UPDATE characters SET core_rank = 'trial', updated_at = ${at('2027-01-09')} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Ranker')).trial_since, at('2027-01-06'), 'the same rank again: not restamped');
  s.exec(`UPDATE characters SET core_rank = 'raider', updated_at = ${at('2027-01-10')} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Ranker')).trial_since, null, 'left Trial: cleared');
  s.exec(`UPDATE characters SET core_rank = 'trial', updated_at = ${at('2027-01-12')} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Ranker')).trial_since, at('2027-01-12'), 'a new Trial period: a new instant');
  // A rename or a spec edit writes updated_at but not core_rank: trial_since stays.
  s.exec(`UPDATE characters SET main_spec = 'Frost', updated_at = ${at('2027-01-13')} WHERE id = '${made.cid}'`);
  assert.equal((await s.row('Ranker')).trial_since, at('2027-01-12'));
});

check('the clock starts at the guild-local date of the team entry; a hand-set date is never overwritten (a set end skips the row, a set start stays and only the end is filled)', async () => {
  const s = await world();
  await s.trial('Fresh', { entered: '2027-01-05', hour: 21 }); // 21:00 in New York = 02:00 UTC on the 6th: the guild-local date is the 5th
  const endOnly = await s.trial('Endonly', { entered: '2027-01-05' });
  s.exec(`UPDATE characters SET trial_end = '2027-02-01' WHERE id = '${endOnly.cid}'`);
  const startOnly = await s.trial('Startonly', { entered: '2027-01-05' });
  s.exec(`UPDATE characters SET trial_start = '2027-01-02' WHERE id = '${startOnly.cid}'`);
  const both = await s.trial('Both', { entered: '2027-01-05' });
  s.exec(`UPDATE characters SET trial_start = '2026-12-20', trial_end = '2027-01-30' WHERE id = '${both.cid}'`);
  assert.equal(await s.clock(), 2, 'Fresh and Startonly are written; Endonly (a set end) and Both are skipped');
  assert.deepEqual(await s.dates('Fresh'), ['2027-01-05', '2027-01-19']);
  assert.deepEqual(await s.dates('Endonly'), [null, '2027-02-01']);
  assert.deepEqual(await s.dates('Startonly'), ['2027-01-02', '2027-01-16'], 'the typed start stays; the end is its 14 days');
  assert.deepEqual(await s.dates('Both'), ['2026-12-20', '2027-01-30']);
});

check('ranked to Trial while on the team starts the clock today (the later of team entry and the rank change); Trial first and placed later starts at the placement; leaving Trial and coming back restarts', async () => {
  const s = await world();
  // The officer rank edit of a manual guild: on the team since it was made, ranked to Trial ten days later.
  const made = await s.person({ name: 'Ontheteam' });
  const entry = (await s.row('Ontheteam')).team_since;
  s.w.advance(10 * DAY);
  const version = made.res.person.version;
  await s.ok('gm', 'PATCH', `/roster/${made.pid}`, { expectedVersion: version, status: 'trial' }, 200);
  let row = await s.row('Ontheteam');
  assert.ok(row.trial_since > entry && row.team_since === entry);
  assert.deepEqual([row.trial_start, row.trial_end], [s.today(), s.addDays(s.today(), 14)], 'today, not the team entry ten days ago');
  // Back to Raider ends the dates; Trial again a week later is a new clock from that day.
  await s.ok('gm', 'PATCH', `/roster/${made.pid}`, { expectedVersion: version + 1, status: 'raider' }, 200);
  assert.deepEqual(await s.dates('Ontheteam'), [null, null]);
  s.w.advance(7 * DAY);
  await s.ok('gm', 'PATCH', `/roster/${made.pid}`, { expectedVersion: version + 2, status: 'trial' }, 200);
  assert.deepEqual(await s.dates('Ontheteam'), [s.today(), s.addDays(s.today(), 14)]);
  // Trial first, placed on a team three days later: the later instant is the placement.
  const loose = await s.person({ name: 'Trialfirst', teamId: null });
  s.exec(`UPDATE characters SET core_rank = 'trial', updated_at = ${s.w.clock.now} WHERE id = '${loose.cid}'`);
  const trialAt = (await s.row('Trialfirst')).trial_since;
  assert.equal(await s.clock(), 0, 'no team, no clock');
  s.w.advance(3 * DAY);
  await s.ok('gm', 'PUT', `/roster/${loose.pid}/characters/${loose.cid}/team`, { teamId: s.tids[0] }, 200);
  row = await s.row('Trialfirst');
  assert.ok(row.team_since > trialAt);
  assert.deepEqual([row.trial_start, row.trial_end], [s.today(), s.addDays(s.today(), 14)]);
});

check('the clock is idempotent and its scope works: a second run writes nothing, a person or character scope writes only that one, a raid recompute runs it too', async () => {
  const s = await world();
  const one = await s.trial('Scopeone', { entered: '2027-01-05' });
  const two = await s.trial('Scopetwo', { entered: '2027-01-06' });
  await s.trial('Scopethree', { entered: '2027-01-07' });
  assert.equal(await s.clock({ personId: one.pid }), 1);
  assert.deepEqual([await s.dates('Scopeone'), await s.dates('Scopetwo')], [['2027-01-05', '2027-01-19'], [null, null]]);
  assert.equal(await s.clock({ characterId: two.cid }), 1);
  assert.deepEqual(await s.dates('Scopetwo'), ['2027-01-06', '2027-01-20']);
  assert.equal(await s.clock({ personId: one.pid }), 0, 'a started clock is not written again');
  s.raid('r_any', 0, '2027-01-09');
  await s.ok('gm', 'POST', `/raids/r_${'rany'.padEnd(22, 'Z')}/recompute`, {}, 200);
  assert.deepEqual(await s.dates('Scopethree'), ['2027-01-07', '2027-01-21'], 'the recompute ran the guild clock');
  assert.equal(await s.clock(), 0);
  assert.equal(await s.clock(), 0);
});

check('migration 0040 backfill: team_since from a Trial\'s typed start, else the first logged raid of its current team (also under an old name), else created_at; trial_since = updated_at of a Trial; teamless and stamped rows untouched; a rerun changes nothing', async () => {
  const s = await world();
  const make = async (name, opts = {}) => {
    const made = await s.person({ name, teamId: opts.teamId === undefined ? s.tids[0] : opts.teamId });
    return made;
  };
  const typed = await make('Typed');
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '2027-01-03', trial_end = '2027-01-17', updated_at = ${at('2027-01-09')} WHERE id = '${typed.cid}'`);
  const raided = await make('Raided');
  const aliased = await make('Newname');
  s.exec(`INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('na_1', '${s.gid}', '${aliased.cid}', 'oldname', 'nightslayer', ${at('2027-01-10')})`);
  const bare = await make('Bare');
  const loose = await make('Loose', { teamId: null });
  const stamped = await make('Stamped');
  const trialRaided = await make('Trialraided');
  s.exec(`UPDATE characters SET core_rank = 'trial', updated_at = ${at('2027-01-11')} WHERE id = '${trialRaided.cid}'`);
  s.raid('r_typed', 0, '2027-01-07', ['Typed']); // evidence the typed start beats
  s.raid('r_other_team', 1, '2027-01-02', ['Raided']); // another team's raid: not evidence for its current team
  s.raid('r_first', 0, '2027-01-08', ['Raided', 'Trialraided']);
  s.raid('r_second', 0, '2027-01-12', ['Raided']);
  s.raid('r_old_name', 0, '2027-01-06', ['Oldname']);
  // The state before the migration: every column empty (the rows the triggers stamped are the "written during the deploy window" case: Stamped keeps its value).
  s.exec(`UPDATE characters SET team_since = NULL, trial_since = NULL`);
  s.exec(`UPDATE characters SET team_since = 42 WHERE id = '${stamped.cid}'`);
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0040_team_since.sql'), 'utf8');
  const marker = sql.indexOf('-- BACKFILL (');
  assert.ok(marker > 0, 'the migration marks its backfill');
  const backfill = sql.slice(sql.indexOf('\n', marker) + 1);
  s.exec(backfill);
  const read = async () => Object.fromEntries((await s.rows('SELECT name, team_since, trial_since, created_at FROM characters ORDER BY name')).map((r) => [r.name, r]));
  const got = await read();
  assert.equal(got.Typed.team_since, Date.parse('2027-01-03T12:00:00Z'), '1. a Trial\'s typed start (noon UTC), not the raid');
  assert.equal(got.Raided.team_since, at('2027-01-08', 20), '2. the first logged raid of the current team (not the other team\'s earlier raid)');
  assert.equal(got.Newname.team_since, at('2027-01-06', 20), '2. evidence under an old name counts through the alias');
  assert.equal(got.Bare.team_since, got.Bare.created_at, '3. created_at when there is no evidence');
  assert.equal(got.Loose.team_since, null, 'a character on no team gets none');
  assert.equal(got.Stamped.team_since, 42, 'a stamped row is left alone');
  assert.equal(got.Trialraided.team_since, at('2027-01-08', 20), 'a Trial without a typed start falls to the raid');
  assert.equal(got.Typed.trial_since, at('2027-01-09'), 'a Trial: updated_at, the old floor');
  assert.equal(got.Trialraided.trial_since, at('2027-01-11'));
  assert.equal(got.Raided.trial_since, null, 'a Raider has none');
  assert.ok(bare && loose);
  s.exec(backfill);
  assert.deepEqual(await read(), got, 'a rerun changes nothing');
  // The clock reads them: Trialraided entered the team on the 8th and became Trial on the 11th, so its clock starts on the 11th.
  assert.equal(await s.clock(), 1, 'Typed has its dates; Trialraided is the only Trial without');
  assert.deepEqual(await s.dates('Trialraided'), ['2027-01-11', '2027-01-25']);
});

runChecks(checks);
