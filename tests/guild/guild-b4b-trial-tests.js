/**
 * Raidsmith guild tracker - lane B4b of the user-hierarchy build: the Trial clock and its reminder (worker/trial-clock.js)
 * Run: node tests/guild/guild-b4b-trial-tests.js
 *
 * User decision 2026-10-26 (replaces R3-Q6): a Trial's dates start when the character ENTERED ITS TEAM (characters.team_since, kept by triggers, migration 0040), no
 * raid needed: trial_start = the guild-local date of the later of team_since and trial_since, trial_end = trial_start + teams.trial_days; written by ONE set-based
 * UPDATE ... WHERE trial_end IS NULL at the end of every raid recompute, in every rank-map apply and in the writers that start a clock; entering Trial by a rank change
 * clears both and the clock starts again at once. The new suite tests/guild/guild-trial-clock-tests.js covers the columns, the triggers and the backfill. The reminder is
 * the Home to-do "trial" for every Trial CHARACTER on its team, not only a Main.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const NS = 'profile-classicann-us';
const TZ = 'America/New_York';
// Instants in the guild's zone (the b3 world's guild: America/New_York, UTC-5 in January).
const at = (date, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00-05:00`);

async function world({ teams = ['Alpha', 'Bravo'], ingame = false } = {}) {
  const s = await scenario({ teams });
  if (ingame) {
    // An in-game guild: the creator holds the seat and is LIVE (a Battle.net-proven, teamless character on rank 5, a Trial like the rank map below makes it, so a map apply moves
    // nobody it did not before); the stored Guild Master row goes, as in the flip.
    const owned = await s.person({ name: 'Gmowner', teamId: null });
    await s.link(owned.pid, 'gm');
    makeProven(s, 'gm', owned, { rank: 5, id: 9990 });
    s.exec(`UPDATE characters SET core_rank = 'trial' WHERE id = '${owned.cid}'`);
    s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
    s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  }
  s.pulls = 0;
  // A raid is named by a short key in the tests; its id has the shape the routes accept (r_ and 22 letters).
  s.rid = (key) => `r_${key.replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'Z')}`;
  // A raid of a team on a date with a log that names these characters (each in its own pull).
  s.raid = (key, team, on, names = []) => {
    const id = s.rid(key);
    s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at)
            VALUES ('${id}', '${s.gid}', '${s.tids[team]}', '${on}', ${at(on, 20)}, 'log', NULL, 'fp', 5, 1, 1)`);
    if (!names.length) return;
    const code = `Code${s.pulls}Xx`.padEnd(16, 'X'); // 16 letters and digits, one per raid
    s.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${id}', '${s.gid}', '${code}', 'fresh', 1, 1)`);
    s.pulls += 1;
    s.exec(`INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (${s.pulls}, '${id}', '${code}', 1, 100, 'Boss', 1, 1, 2)`);
    for (const name of names) {
      s.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key) VALUES (${s.pulls}, '${id}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'nightslayer')`);
    }
  };
  // A person whose Main is a Trial character on team `team`, entered on `entered` (team_since, and the rank change the trigger stamps from updated_at), with the clock not started.
  s.trial = async (name, { team = 0, entered = '2027-01-05', hour = 12, days = null } = {}) => {
    const made = await s.person({ name, teamId: s.tids[team] });
    s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = NULL, trial_end = NULL, team_since = ${at(entered, hour)}, updated_at = ${at(entered, hour)} WHERE id = '${made.cid}'`);
    if (days !== null) s.exec(`UPDATE teams SET trial_days = ${days} WHERE id = '${s.tids[team]}'`);
    return made;
  };
  s.dates = async (name) => {
    const row = await s.one('SELECT core_rank, trial_start, trial_end FROM characters WHERE name = ?', name);
    return [row.trial_start, row.trial_end];
  };
  s.recompute = (key) => s.ok('gm', 'POST', `/raids/${s.rid(key)}/recompute`, {}, 200);
  return s;
}

check('the clock starts at the day the character entered its team, with no raid needed: start = that date, end = start + the team\'s trial days; any recompute runs it', async () => {
  const s = await world();
  await s.trial('Alphaone', { entered: '2027-01-05' });
  s.raid('r_before', 0, '2027-01-03', ['Alphaone']); // raids no longer matter: before the entry, after it, another team's, one naming somebody else
  s.raid('r_later', 0, '2027-01-12', ['Alphaone']);
  s.raid('r_bravo', 1, '2027-01-06', ['Alphaone']);
  s.raid('r_nobody', 0, '2027-01-08', ['Somebodyelse']);
  assert.deepEqual(await s.dates('Alphaone'), [null, null], 'no recompute has run yet');
  // Any recompute runs the guild's clock (one set-based statement): the team entry, 2027-01-05, not the first raid.
  await s.recompute('r_nobody');
  assert.deepEqual(await s.dates('Alphaone'), ['2027-01-05', '2027-01-19']);
  await s.recompute('r_later');
  assert.deepEqual(await s.dates('Alphaone'), ['2027-01-05', '2027-01-19'], 'a started clock does not move');
});

check('whatever order raids are recomputed in the dates are the same; a started clock never moves and a hand-edited end stays', async () => {
  const build = async () => {
    const s = await world();
    await s.trial('Alphaone', { entered: '2027-01-05' });
    s.raid('r_a', 0, '2027-01-05', ['Alphaone']);
    s.raid('r_b', 0, '2027-01-09', ['Alphaone']);
    s.raid('r_c', 0, '2027-01-14', ['Alphaone']);
    return s;
  };
  const forward = await build();
  for (const id of ['r_a', 'r_b', 'r_c']) await forward.recompute(id);
  const backward = await build();
  for (const id of ['r_c', 'r_b', 'r_a']) await backward.recompute(id);
  assert.deepEqual(await forward.dates('Alphaone'), ['2027-01-05', '2027-01-19']);
  assert.deepEqual(await backward.dates('Alphaone'), ['2027-01-05', '2027-01-19'], 'recompute order never matters');
  // Started is final: a hand-edited end stays through a later recompute.
  forward.exec("UPDATE characters SET trial_end = '2027-02-01' WHERE name = 'Alphaone'");
  forward.raid('r_even_earlier', 0, '2027-01-06', ['Alphaone']);
  await forward.recompute('r_even_earlier');
  assert.deepEqual(await forward.dates('Alphaone'), ['2027-01-05', '2027-02-01']);
});

check('the guild\'s own zone decides the day it entered the team (the evening of the 5th in New York is the 5th, not the 6th in UTC); the team\'s trial days decide the end', async () => {
  const s = await world();
  await s.trial('Evening', { entered: '2027-01-05', hour: 21, days: 10 }); // 21:00 in New York = 02:00 UTC on the 6th
  s.raid('r_eve', 0, '2027-01-05', ['Evening']);
  await s.recompute('r_eve');
  assert.deepEqual(await s.dates('Evening'), ['2027-01-05', '2027-01-15'], 'the evening it entered is the 5th; ten days later it ends');
  const { zoneOffsetMinutes } = await load('worker/trial-clock.js');
  assert.deepEqual([zoneOffsetMinutes(TZ, at('2027-01-05')), zoneOffsetMinutes(TZ, at('2027-07-05')), zoneOffsetMinutes('UTC', 0), zoneOffsetMinutes('Not/AZone', 0)], [-300, -240, 0, 0]);
});

check('only a Trial character on a team that is still here gets a clock: a Raider, a Social, a Former and a teamless Trial get none', async () => {
  const s = await world();
  const people = {};
  for (const name of ['Praider', 'Psocial', 'Pformer', 'Pteamless', 'Ptrial']) {
    people[name] = await s.person({ name });
    s.exec(`UPDATE characters SET team_since = ${at('2027-01-05')}, updated_at = ${at('2027-01-05')} WHERE id = '${people[name].cid}'`);
  }
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE name = 'Psocial'`);
  s.exec(`UPDATE characters SET core_rank = 'trial', left_on = '2027-01-08' WHERE name = 'Pformer'`);
  s.exec(`UPDATE characters SET core_rank = 'trial', team_id = NULL WHERE name = 'Pteamless'`);
  s.exec(`UPDATE characters SET core_rank = 'trial' WHERE name = 'Ptrial'`);
  s.raid('r_all', 0, '2027-01-10', Object.keys(people));
  await s.recompute('r_all');
  for (const name of ['Praider', 'Psocial', 'Pformer', 'Pteamless']) assert.deepEqual(await s.dates(name), [null, null], name);
  assert.deepEqual(await s.dates('Ptrial'), ['2027-01-05', '2027-01-19']);
});

check('ranked back to Trial: leaving Trial ends the dates, the rank map ranking the character Trial again starts a new clock at once, today, not at the old team entry', async () => {
  const s = await world({ ingame: true });
  const made = await s.trial('Reentry', { entered: '2027-01-02' });
  s.exec(`UPDATE characters SET namespace = '${NS}', blizzard_realm_id = 4001, blizzard_char_id = 9001 WHERE id = '${made.cid}'`);
  s.exec(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES ('${s.gid}', '${NS}', 4001, 9001, 'Reentry', 'reentry', 'nightslayer', 'MAGE', 70, 5)`);
  s.raid('r_1', 0, '2027-01-04', ['Reentry']);
  await s.recompute('r_1');
  assert.deepEqual(await s.dates('Reentry'), ['2027-01-02', '2027-01-16'], 'the clock started with the team entry');
  const asTrial = [{ rank: 5, label: 'Initiate', coreRank: 'trial' }];
  const asRaider = [{ rank: 5, label: 'Initiate', coreRank: 'raider' }];
  // Promoted by the in-game rank: the dates end.
  s.w.advance(3 * 86400000);
  await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: asRaider }, 200).then((dry) => s.call('gm', 'PUT', '/rank-map', { ranks: asRaider, token: dry.token }));
  assert.deepEqual(await s.one('SELECT core_rank, trial_start, trial_end FROM characters WHERE name = ?', 'Reentry'), { core_rank: 'raider', trial_start: null, trial_end: null });
  // Ranked back to Trial a week later, while still on the team since 2027-01-02: the apply clears both dates and its clock starts them today (a trial cannot start before the
  // character was a Trial).
  s.w.advance(7 * 86400000);
  const today = new Date(s.w.clock.now - 5 * 3600000).toISOString().slice(0, 10);
  const back = await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: asTrial }, 200);
  await s.call('gm', 'PUT', '/rank-map', { ranks: asTrial, token: back.token });
  const { addDays } = await load('worker/attendance-calendar.js');
  assert.deepEqual(await s.one('SELECT core_rank, trial_start, trial_end FROM characters WHERE name = ?', 'Reentry'), { core_rank: 'trial', trial_start: today, trial_end: addDays(today, 14) });
  // Old raids never move it.
  s.raid('r_old_again', 0, '2027-01-10', ['Reentry']);
  await s.recompute('r_old_again');
  assert.deepEqual(await s.dates('Reentry'), [today, addDays(today, 14)]);
});

check('the clock also runs in a rank-map apply that changes no rank (a Trial with no dates gets them); the statement is idempotent; the officer path starts the clock today', async () => {
  const s = await world({ ingame: true });
  const made = await s.trial('Waiting', { entered: '2027-01-05' });
  s.exec(`UPDATE characters SET namespace = '${NS}', blizzard_realm_id = 4001, blizzard_char_id = 9001 WHERE id = '${made.cid}'`);
  s.exec(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES ('${s.gid}', '${NS}', 4001, 9001, 'Waiting', 'waiting', 'nightslayer', 'MAGE', 70, 5)`);
  assert.deepEqual(await s.dates('Waiting'), [null, null]);
  // The map keeps rank 5 a Trial: no character changes, and the apply's clock starts the dates from the team entry.
  const map = [{ rank: 5, label: 'Initiate', coreRank: 'trial' }];
  const dry = await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: map }, 200);
  assert.equal(dry.changes.characters.changed, 0);
  const applied = await s.ok('gm', 'PUT', '/rank-map', { ranks: map, token: dry.token }, 200);
  assert.equal(applied.applied.characters, 0);
  assert.deepEqual(await s.dates('Waiting'), ['2027-01-05', '2027-01-19']);
  // Idempotent: a second run of the clock changes nothing.
  const { trialClockStatement } = await load('worker/trial-clock.js');
  assert.equal((await s.w.db.batch([trialClockStatement(s.w.db, s.gid, { offsetMinutes: -300 })]))[0].meta.changes, 0);
  // Under a legacy source the apply's statements guard everything off, the clock included.
  s.exec("UPDATE characters SET trial_start = NULL, trial_end = NULL WHERE name = 'Waiting'");
  s.exec(`UPDATE guilds SET rank_source = NULL WHERE id = '${s.gid}'`);
  const { rankMapApplyStatements, ingameGuard } = await load('worker/rank-map.js');
  await s.w.db.batch(rankMapApplyStatements(s.w.db, { guildId: s.gid, now: s.w.clock.now, timeZone: TZ }, [ingameGuard(s.gid)]));
  assert.deepEqual(await s.dates('Waiting'), [null, null]);

  // The officer rank edit: Raider -> Trial stamps updated_at / trial_since and starts the clock today (the person has been on the team since it was made).
  const p = await s.person({ name: 'Officeredit' });
  s.w.advance(86400000);
  s.exec(`UPDATE guilds SET rank_source = NULL WHERE id = '${s.gid}'`);
  const patched = await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, status: 'trial' }, 200);
  const row = await s.one('SELECT core_rank, trial_start, trial_end, updated_at, trial_since FROM characters WHERE id = ?', p.cid);
  const today = new Date(s.w.clock.now - 5 * 3600000).toISOString().slice(0, 10);
  const { addDays } = await load('worker/attendance-calendar.js');
  assert.deepEqual([patched.person.status, row.core_rank, row.trial_start, row.trial_end, row.updated_at, row.trial_since],
    ['trial', 'trial', today, addDays(today, 14), s.w.clock.now, s.w.clock.now]);
});

// ---------------------------------------------------------------------------
// The reminder

check('the Trial reminder (Home to-do "trial") is per Trial character on its team: an alt on another team is listed for that team\'s officers, a Main keeps its old id; later ends are not listed', async () => {
  const s = await world({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  await s.lead('la', [s.tids[0]], 'Leadalpha');
  await s.lead('lb', [s.tids[1]], 'Leadbravo');
  const today = (await s.ok('gm', 'GET', '/attention', undefined, 200)).today || null;
  const guildToday = (await s.ok('gm', 'GET', '/roster?team=' + s.tids[0], undefined, 200)).today;
  const { addDays } = await load('worker/attendance-calendar.js');
  assert.ok(today === null || typeof today === 'string');
  // Raider main on Alpha with a Trial alt on Bravo (ends in 2 days); a Trial Main on Alpha (ended yesterday); a Trial alt on Charlie that ends in 20 days.
  const m1 = await s.person({ name: 'Mainraider' });
  const alt = await s.alt(m1.pid, 'Trialalt');
  s.setTeam(alt, s.tids[1]);
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${addDays(guildToday, -12)}', trial_end = '${addDays(guildToday, 2)}' WHERE id = '${alt}'`);
  const m2 = await s.person({ name: 'Trialmain' });
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${addDays(guildToday, -15)}', trial_end = '${addDays(guildToday, -1)}' WHERE id = '${m2.cid}'`);
  const m3 = await s.person({ name: 'Farmain' });
  const far = await s.alt(m3.pid, 'Faralt');
  s.setTeam(far, s.tids[2]);
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${guildToday}', trial_end = '${addDays(guildToday, 20)}' WHERE id = '${far}'`);

  const trials = async (who) => (await s.ok(who, 'GET', '/attention', undefined, 200)).items.filter((i) => i.kind === 'trial')
    .map((i) => [i.id, i.teamId, i.name, i.days, i.ended, i.link.pid]).sort();
  const gm = await trials('gm');
  assert.deepEqual(gm, [
    [`trial:${m1.pid}:${s.tids[1]}`, s.tids[1], 'Trialalt', 2, false, m1.pid],
    [`trial:${m2.pid}`, s.tids[0], 'Trialmain', -1, true, m2.pid],
  ].sort(), 'the alt on Bravo (id with the team) and the Main on Alpha (the old id); the one ending in 20 days is not due');
  assert.deepEqual(await trials('la'), [[`trial:${m2.pid}`, s.tids[0], 'Trialmain', -1, true, m2.pid]], 'the lead of Alpha sees Alpha only');
  assert.deepEqual((await trials('lb')).map((t) => t[2]), ['Trialalt'], 'the lead of Bravo sees the Trial alt of a Raider main');
  // The alt's to-do snoozes like any Trial to-do, for the team's officers, and comes back as the Trial end moves.
  const altItem = `trial:${m1.pid}:${s.tids[1]}`;
  await s.ok('lb', 'POST', '/attention/dismissals', { itemId: altItem }, 200);
  assert.deepEqual(await trials('lb'), []);
  assert.deepEqual((await trials('gm')).map((t) => t[2]), ['Trialmain'], 'a snooze is shared by every officer of the guild');
  assert.deepEqual((await s.ok('gm', 'GET', '/attention', undefined, 200)).hidden.map((h) => h.item.id), [altItem], 'and is listed under Hidden');
  // A Trial that is Social or Former, or on no team, is no reminder.
  s.exec(`UPDATE characters SET left_on = '${guildToday}' WHERE id = '${alt}'`);
  s.exec(`UPDATE characters SET team_id = NULL WHERE id = '${m2.cid}'`);
  assert.deepEqual(await trials('gm'), []);
});

runChecks(checks);
