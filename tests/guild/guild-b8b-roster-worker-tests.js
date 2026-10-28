/**
 * Raidsmith guild tracker - lane roster of B8b: the Worker side of the Roster page and the team changes
 * Run: node tests/guild/guild-b8b-roster-worker-tests.js
 *
 *   - GET /roster?team=: the shown character carries its OWN core rank, in-game rank and trial flag (H-Q18); the rank segments follow the guild's rank map (H-Q44);
 *     the Inactive filter is gone (U R6-Q2: Social and Former are on no team roster view); the nav trial flags count characters on the team they sit on;
 *   - GET /roster/unassigned?team=: no Social / Former character, no person that already has a character on the team, the in-game rank and the trial end;
 *   - PUT .../characters/:cid/team settles the character's waiting request for THIS team in the same batch (approved, the person's other requests for the team
 *     withdrawn, audited) and leaves every other request alone;
 *   - the person record: coreRank, inGameRank and mayRelease per character (roster.edit on the character's team AND the Seniority guard);
 *   - GET /recruiting?team= counts the Raider and Trial characters placed on the team (an alt counts as the Main would).
 */
const assert = require('node:assert/strict');
const { runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const NS = 'profile-classicann-us';

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  Object.assign(s, { alpha, bravo, charlie });
  await s.officer('o1', 'Officerone');
  await s.lead('tla', [alpha], 'Leadalpha');
  await s.lead('tlb', [bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  s.m1 = await s.person({ name: 'Mainone' });
  await s.link(s.m1.pid, 'm1');
  s.alt1 = await s.alt(s.m1.pid, 'Altone');
  s.alt2 = await s.alt(s.m1.pid, 'Alttwo');
  return s;
}

// A guild_roster row and the identity key on a character, so the in-game rank label of the guild's map reaches it.
let nextCharId = 9000;
function inGame(s, characterId, name, rank) {
  const id = ++nextCharId;
  s.exec(`UPDATE characters SET namespace = '${NS}', blizzard_realm_id = 4001, blizzard_char_id = ${id} WHERE id = '${characterId}'`);
  s.exec(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
          VALUES ('${s.gid}', '${NS}', 4001, ${id}, '${name}', '${name.toLowerCase()}', 'nightslayer', 'MAGE', 70, ${rank})`);
}
function mapRank(s, rank, label, coreRank) {
  s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('${s.gid}', 'ingame', '${rank}', '${label}', '${coreRank}', NULL)`);
}

check('GET /roster: the shown character carries its OWN core rank, in-game rank and trial flag (an alt that is Trial on Bravo while its Main is a Raider); the person fields stay the Main\'s', async () => {
  const s = await world();
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  const today = (await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).today;
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${today}', trial_end = '${addDays(today, 2)}' WHERE id = '${s.alt1}'`);
  mapRank(s, 2, 'Raider', 'trial');
  mapRank(s, 3, 'Core Raider', 'raider');
  inGame(s, s.m1.cid, 'Mainone', 3);
  inGame(s, s.alt1, 'Altone', 2);
  const bravo = (await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).people;
  assert.equal(bravo.length, 1);
  const row = bravo[0];
  assert.deepEqual(row.shown, {
    id: s.alt1, name: 'Altone', class: 'ROGUE', mainSpec: 'Combat', offSpec: null, role: 'dps', isMain: false,
    coreRank: 'trial', inGameRank: 'Raider', trialStart: today, trialEnd: addDays(today, 2), trialFlag: { kind: 'ends', days: 2 },
  });
  assert.deepEqual([row.status, row.trialFlag, row.main.name], ['raider', null, 'Mainone'], 'the person-level fields are still the Main\'s (the readers that look at the person)');
  const alpha = (await s.ok('o1', 'GET', `/roster?team=${s.alpha}`)).people[0];
  assert.deepEqual([alpha.shown.name, alpha.shown.coreRank, alpha.shown.inGameRank, alpha.shown.trialFlag, alpha.shown.trialEnd], ['Mainone', 'raider', 'Core Raider', null, null]);
  // A character with no row on the in-game roster, or whose rank has no map row, has no in-game rank.
  s.exec(`DELETE FROM source_rank_maps WHERE guild_id = '${s.gid}' AND source_key = '2'`);
  assert.equal((await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).people[0].shown.inGameRank, null);
  // The person record says the same per character.
  const record = await s.ok('o1', 'GET', `/roster/${s.m1.pid}`);
  assert.deepEqual(record.characters.map((c) => [c.name, c.coreRank, c.inGameRank]), [['Mainone', 'raider', 'Core Raider'], ['Altone', 'trial', null], ['Alttwo', 'raider', null]]);
});

check('GET /roster: rankSegments follow the guild\'s rank map in an in-game guild (a map without Reserve offers none) and the ranks held on the team in any other', async () => {
  const s = await world();
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  const today = (await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).today;
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${today}', trial_end = '${addDays(today, 20)}' WHERE id = '${s.alt1}'`);
  const segments = async (team) => (await s.ok('gm', 'GET', `/roster?team=${team}`)).rankSegments;
  assert.deepEqual([await segments(s.alpha), await segments(s.bravo), await segments(s.charlie)], [['raider'], ['trial'], []], 'not in-game: what a character on the team holds');
  // An in-game guild: the Owner (the creator, with a teamless character on the in-game roster) is the account that still reaches it.
  const owned = await s.person({ name: 'Gmowner', teamId: null });
  await s.link(owned.pid, 'gm');
  inGame(s, owned.cid, 'Gmowner', 5);
  s.setOwner('gm');
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  mapRank(s, 1, 'Core Raider', 'raider');
  mapRank(s, 2, 'Raider', 'trial');
  mapRank(s, 5, 'Member', 'social');
  assert.deepEqual([await segments(s.alpha), await segments(s.bravo), await segments(s.charlie)], [['raider', 'trial'], ['raider', 'trial'], ['raider', 'trial']], 'in-game: the mapped ranks, whoever holds them; Social is never a segment');
  mapRank(s, 6, 'Bench', 'reserve');
  assert.deepEqual(await segments(s.alpha), ['raider', 'trial', 'reserve']);
});

check('the nav trial flags count each Trial CHARACTER on the team it sits on (H-Q18), not the Main\'s team', async () => {
  const s = await world();
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  const today = (await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).today;
  assert.deepEqual((await s.ok('gm', 'GET', '')).rosterFlags, { [s.alpha]: 0, [s.bravo]: 0, [s.charlie]: 0 });
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${today}', trial_end = '${addDays(today, 3)}' WHERE id = '${s.alt1}'`);
  assert.deepEqual((await s.ok('gm', 'GET', '')).rosterFlags, { [s.alpha]: 0, [s.bravo]: 1, [s.charlie]: 0 }, 'the alt is flagged on Bravo although its Main is a Raider on Alpha');
  // A Trial character that is not on a roster (no team) counts nowhere.
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_start = '${today}', trial_end = '${addDays(today, 3)}' WHERE id = '${s.alt2}'`);
  assert.deepEqual((await s.ok('gm', 'GET', '')).rosterFlags, { [s.alpha]: 0, [s.bravo]: 1, [s.charlie]: 0 });
});

check('GET /roster/unassigned?team=: no Social or Former character, no person that already has a character on the team; the in-game rank and the trial end ride along', async () => {
  const s = await world();
  const floater = await s.person({ name: 'Floater', teamId: null });
  const trialer = await s.alt(floater.pid, 'Trialer');
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_end = NULL WHERE id = '${trialer}'`);
  const social = await s.alt(floater.pid, 'Socialite');
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE id = '${social}'`);
  const former = await s.alt(floater.pid, 'Formerone');
  s.exec(`UPDATE characters SET core_rank = 'social', left_on = '2027-01-02', left_reason = 'left' WHERE id = '${former}'`);
  mapRank(s, 2, 'Raider', 'trial');
  inGame(s, trialer, 'Trialer', 2);
  const names = async (who, tail) => (await s.ok(who, 'GET', `/roster/unassigned${tail}`)).characters.map((c) => c.name);
  assert.deepEqual(await names('o1', ''), ['Altone', 'Alttwo', 'Floater', 'Trialer'], 'without a team: every placeable character; Social and Former are never offered (U R6-Q2)');
  assert.deepEqual(await names('o1', `?team=${s.alpha}`), ['Floater', 'Trialer'], 'Mainone is on Alpha, so its alts cannot join it (one character per person per team); Floater has none there');
  assert.deepEqual(await names('o1', `?team=${s.bravo}`), ['Altone', 'Alttwo', 'Floater', 'Trialer']);
  assert.deepEqual(await names('o1', `?team=${s.bravo}&q=tri`), ['Trialer']);
  const trial = (await s.ok('o1', 'GET', `/roster/unassigned?team=${s.bravo}&q=tri`)).characters[0];
  assert.deepEqual([trial.status, trial.inGameRank, trial.trialEnd, trial.person, trial.requestedTeamId], ['trial', 'Raider', null, { id: floater.pid, name: 'Floater' }, null]);
  // Placing a person's character on the team takes the person's others off the list for it.
  await s.ok('o1', 'PUT', `/roster/${floater.pid}/characters/${trialer}/team`, { teamId: s.bravo }, 200);
  assert.deepEqual(await names('o1', `?team=${s.bravo}`), ['Altone', 'Alttwo']);
  // Rights: roster.edit on the team asked for; the team must exist in the guild.
  assert.deepEqual(await names('tla', `?team=${s.alpha}`), ['Floater']);
  await s.fail('tla', 'GET', `/roster/unassigned?team=${s.bravo}`, undefined, 403, 'forbidden');
  assert.equal((await s.fail('o1', 'GET', '/roster/unassigned?team=nope', undefined, 400)).field, 'team');
  assert.equal((await s.fail('o1', 'GET', '/roster/unassigned?team=t_AAAAAAAAAAAAAAAAAAAAAA', undefined, 400)).field, 'team');
  await s.fail('m1', 'GET', `/roster/unassigned?team=${s.alpha}`, undefined, 403, 'forbidden');
});

const askFor = (s, who, characterId, teamId) => s.ok(who, 'POST', '/team-requests', { characterId, teamId }, 201);
const requests = (s) => s.rows('SELECT id, character_id, team_id, status, decided_by FROM team_requests ORDER BY created_at, id');

check('placing a character settles ITS waiting request for this team in the same batch: approved, the person\'s other requests for the team withdrawn, audited; other teams\' requests stay', async () => {
  const s = await world();
  const r1 = (await askFor(s, 'm1', s.alt1, s.bravo)).request.id;
  const r2 = (await askFor(s, 'm1', s.alt2, s.bravo)).request.id;
  const alt3 = await s.alt(s.m1.pid, 'Altthree');
  const r3 = (await askFor(s, 'm1', alt3, s.charlie)).request.id;
  const placed = await s.ok('tlb', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  assert.equal(placed.approvedRequestId, r1);
  assert.deepEqual(placed.teamRequestFlags, { [s.bravo]: 0 }, 'the nav badge of the teams the placer leads counts what still waits');
  assert.deepEqual((await s.ok('o1', 'GET', '')).teamRequestFlags, { [s.alpha]: 0, [s.bravo]: 0, [s.charlie]: 1 });
  const byId = Object.fromEntries((await requests(s)).map((row) => [row.id, row]));
  assert.deepEqual([byId[r1].status, byId[r1].decided_by], ['approved', s.uids.tlb]);
  assert.equal(byId[r2].status, 'withdrawn', 'one character per person per team: the other request for Bravo can never be approved');
  assert.equal(byId[r3].status, 'pending', 'a request for another team stays');
  const approvals = await s.rows("SELECT entity_id, after FROM audit_log WHERE action = 'team_request.approve'");
  assert.deepEqual(approvals.map((row) => [row.entity_id, JSON.parse(row.after)]), [[r1, { teamId: s.bravo, characterId: s.alt1, personId: s.m1.pid, via: 'placement' }]]);
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action = 'character.place'")).length, 1);
  const pending = await s.ok('tlb', 'GET', '/team-requests');
  assert.deepEqual(pending.pending.map((row) => row.id), [], 'nothing waits for Bravo any more');
  // Approving it again, or placing again, finds nothing to settle.
  await s.fail('tlb', 'POST', `/team-requests/${r1}/approve`, {}, 409, 'request_decided');
  assert.equal((await s.ok('tlb', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200)).approvedRequestId, undefined);
});

check('placing a character with no request waiting writes no request or request audit; a refused placement settles nothing', async () => {
  const s = await world();
  const r = (await askFor(s, 'm1', s.alt1, s.charlie)).request.id;
  const placed = await s.ok('tlb', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, { teamId: s.bravo }, 200);
  assert.equal(placed.approvedRequestId, undefined);
  assert.equal(placed.teamRequestFlags, undefined);
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action = 'team_request.approve'")).length, 0);
  assert.equal((await requests(s))[0].status, 'pending');
  // The lead of Alpha may not place on Charlie: nothing changes, the request still waits.
  await s.fail('tla', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.charlie }, 403, 'forbidden');
  assert.equal((await requests(s))[0].id, r);
  assert.equal((await requests(s))[0].status, 'pending');
  // A character already on the team: no-op, the request (made before it was moved there some other way) is left to its own decision.
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.charlie }, 200);
  assert.equal((await requests(s))[0].status, 'approved');
});

check('the person record says, per character, whether the viewer may release it: roster.edit on ITS team and the Seniority guard (Remove from team shows only when it can work)', async () => {
  const s = await world();
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  const may = async (who, pid) => Object.fromEntries((await s.ok(who, 'GET', `/roster/${pid}`)).characters.map((c) => [c.name, c.mayRelease]));
  assert.deepEqual(await may('gm', s.m1.pid), { Mainone: true, Altone: true, Alttwo: false }, 'the teamless alt has no team to leave');
  assert.deepEqual(await may('o1', s.m1.pid), { Mainone: true, Altone: true, Alttwo: false });
  assert.deepEqual(await may('tla', s.m1.pid), { Mainone: true, Altone: false, Alttwo: false }, 'a Team Lead releases the characters on the team they lead');
  assert.deepEqual(await may('tlb', s.m1.pid), { Mainone: false, Altone: true, Alttwo: false });
  assert.deepEqual(await may('m1', s.m1.pid), { Mainone: false, Altone: false, Alttwo: false }, 'a member cannot leave on their own, not even their own characters');
  // The release route agrees with every answer above.
  await s.fail('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 403, 'forbidden');
  await s.fail('m1', 'DELETE', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, {}, 403, 'forbidden');
  // The Seniority guard: the Officer's own person is out of a Team Lead's reach, whatever team the character is on.
  const officerPerson = await s.person({ name: 'Officerown' });
  await s.link(officerPerson.pid, 'o1');
  assert.deepEqual(await may('tla', officerPerson.pid), { Officerown: false });
  assert.deepEqual(await may('o1', officerPerson.pid), { Officerown: true }, 'the actor\'s own person');
  assert.deepEqual(await may('gm', officerPerson.pid), { Officerown: true });
  await s.fail('tla', 'DELETE', `/roster/${officerPerson.pid}/characters/${officerPerson.cid}/team`, {}, 403, 'seniority');
});

check('GET /recruiting?team= counts the Raider and Trial CHARACTERS placed on the team: an alt counts as the Main would, a Social one never', async () => {
  const s = await world();
  const counted = async (team) => (await s.ok('o1', 'GET', `/recruiting?team=${team}`)).roster.people;
  assert.deepEqual([await counted(s.alpha), await counted(s.bravo)], [1, 0]);
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  assert.deepEqual([await counted(s.alpha), await counted(s.bravo)], [1, 1], 'Altone is on Bravo, its Main stays on Alpha: each team counts its own character');
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE id = '${s.alt1}'`);
  assert.deepEqual([await counted(s.alpha), await counted(s.bravo)], [1, 0]);
});

runChecks(checks);
