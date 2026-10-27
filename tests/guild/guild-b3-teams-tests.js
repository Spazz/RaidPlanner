/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: the team routes (place, release, move) and what leaving a team ends
 * Run: node tests/guild/guild-b3-teams-tests.js
 *
 *   - PUT .../characters/:cid/team places a character on no team (roster.edit on the target team) and moves a placed one (roster.edit on BOTH: the
 *     current lead releases first, U R3-Q8); DELETE .../team releases it (the team's Team Leads, officers, the Guild Master: D4);
 *   - one character per person per team (409 team_taken), archived or foreign teams are refused, a stale page gets 409 with the current record;
 *   - the writes are guarded statements: a team of another guild, a character that moved, a person who already holds the team change nothing;
 *   - the Seniority guard applies to a release and a move, not to a placement;
 *   - rights are checked before anything about the person is answered: a place or a release without roster.view / roster.edit is a bare 403;
 *   - removeSignups (asked each time, default off): the person's upcoming native sign-ups and standing sign-ups for the team go, nothing else does;
 *   - audited (character.place / release / move), raids that depend on the roster show "Recalculate", the team roster follows.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  Object.assign(s, { alpha, bravo, charlie });
  await s.officer('o1', 'Officerone');
  await s.lead('tla', [alpha], 'Leadalpha');
  await s.lead('tlb', [bravo], 'Leadbravo');
  await s.lead('tlab', [alpha, bravo], 'Leadboth');
  await s.member('m1', 'Memberone');
  s.m1 = await s.person({ name: 'Mainone' });
  await s.link(s.m1.pid, 'm1');
  s.alt1 = await s.alt(s.m1.pid, 'Altone');
  s.alt2 = await s.alt(s.m1.pid, 'Alttwo');
  return s;
}

const auditRows = (s, action) => s.rows('SELECT entity_id, before, after FROM audit_log WHERE action = ? ORDER BY created_at, id', action);

check('place: a character on no team goes on the team of whoever may edit THAT team; the roster of the team lists the person; one audit row', async () => {
  const s = await world();
  assert.equal(await s.teamOf(s.alt1), null);
  // The lead of Alpha cannot place on Bravo; the lead of Bravo can (the character is not on any team, so there is nobody to release it first).
  await s.fail('tla', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 403, 'forbidden');
  assert.equal(await s.teamOf(s.alt1), null);
  const placed = await s.ok('tlb', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  assert.deepEqual(placed.characters.map((c) => [c.name, c.team.id]).sort(), [['Altone', s.bravo], ['Alttwo', null], ['Mainone', s.alpha]].sort());
  assert(placed.rosterFlags !== undefined, 'the reply is the person record with the nav-badge counts');
  const bravoRoster = await s.ok('tlb', 'GET', `/roster?team=${s.bravo}`);
  assert.deepEqual(bravoRoster.people.map((p) => p.names).flat(), ['Altone']);
  const rows = await auditRows(s, 'character.place');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].entity_id, JSON.parse(rows[0].before).teamId, JSON.parse(rows[0].after).teamId], [s.alt1, null, s.bravo]);
  // Placing it where it already is changes nothing and is not audited again.
  await s.ok('tlb', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  assert.equal((await auditRows(s, 'character.place')).length, 1);
  // A plain member may not place anything, not even their own character.
  await s.fail('m1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, { teamId: s.bravo }, 403, 'forbidden');
});

check('place refuses: no team, an unknown, archived or foreign team, a person who already holds the team (409 team_taken), a stale page (409 with the record)', async () => {
  const s = await world();
  const url = `/roster/${s.m1.pid}/characters/${s.alt1}/team`;
  assert.equal((await s.fail('o1', 'PUT', url, {}, 400)).field, 'teamId');
  assert.equal((await s.fail('o1', 'PUT', url, { teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, 400)).field, 'teamId');
  await s.ok('gm', 'PATCH', `/teams/${s.charlie}`, { archived: true }, 200);
  assert.equal((await s.fail('o1', 'PUT', url, { teamId: s.charlie }, 400)).field, 'teamId');
  // The Main sits on Alpha: the alt cannot join it (one character per person per team), and nothing is written.
  const taken = await s.fail('o1', 'PUT', url, { teamId: s.alpha }, 409, 'team_taken');
  assert.equal(taken.field, 'teamId');
  assert.equal(await s.teamOf(s.alt1), null);
  const stale = await s.fail('o1', 'PUT', url, { teamId: s.bravo, fromTeamId: s.charlie }, 409, 'conflict');
  assert(stale.current && stale.current.person, 'the 409 carries the current person record');
  assert.equal(await s.teamOf(s.alt1), null);
  assert.equal((await s.fail('o1', 'PUT', url, { teamId: s.bravo, removeSignups: 'yes' }, 400)).field, 'removeSignups');
  // A person or character that does not exist, or is another person's.
  await s.fail('o1', 'PUT', `/roster/p_AAAAAAAAAAAAAAAAAAAAAA/characters/${s.alt1}/team`, { teamId: s.bravo }, 404);
  const other = await s.person({ name: 'Otherone' });
  await s.fail('o1', 'PUT', `/roster/${other.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 404);
  assert.equal((await auditRows(s, 'character.place')).length, 0);
});

check('the writes are guarded statements: a team of another guild, a moved character, a person who holds the team already, an archived team match no row', async () => {
  const { placeStatement, releaseStatement } = await load('worker/team-place.js');
  const s = await world();
  // A second guild in the same database.
  const gm2 = await s.w.call((await require('../guild-world').signIn(s.w, { id: '110000000000000099', username: 'gmtwo', globalName: 'Gmtwo' }, [require('../guild-world').adminOf('900000000000000092')])).jar, 'POST', '/api/guild', {
    serverId: '900000000000000092', name: 'Other guild', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false,
  });
  assert.equal(gm2.status, 201, gm2.text);
  const foreignTeam = gm2.json.teams[0].id;
  const now = 1;
  // The own rows of the statement (SQL changes()): meta.changes also counts the rows the characters_team_since_move trigger writes (worker/d1-changes.js).
  const { directRows, directRowsStatement } = await import('../../worker/d1-changes.js');
  const run = async (statement) => directRows((await s.w.db.batch([statement, directRowsStatement(s.w.db)]))[1]);
  const base = { guildId: s.gid, personId: s.m1.pid, characterId: s.alt1, now };
  assert.equal(await run(placeStatement(s.w.db, { ...base, teamId: foreignTeam })), 0, 'a team of another guild');
  assert.equal(await run(placeStatement(s.w.db, { ...base, teamId: s.alpha })), 0, 'the person holds Alpha with the Main');
  assert.equal(await run(placeStatement(s.w.db, { ...base, teamId: s.bravo, from: s.charlie })), 0, 'the page saw another team');
  assert.equal(await run(placeStatement(s.w.db, { ...base, characterId: s.m1.cid, teamId: s.bravo, from: s.charlie })), 0);
  assert.equal(await run(placeStatement(s.w.db, { ...base, guildId: 'g_AAAAAAAAAAAAAAAAAAAAAA', teamId: s.bravo })), 0, 'the character is not in that guild');
  assert.equal(await run(placeStatement(s.w.db, { ...base, personId: 'p_AAAAAAAAAAAAAAAAAAAAAA', teamId: s.bravo })), 0, 'the character is not that person\'s');
  await s.ok('gm', 'PATCH', `/teams/${s.charlie}`, { archived: true }, 200);
  assert.equal(await run(placeStatement(s.w.db, { ...base, teamId: s.charlie })), 0, 'an archived team takes nobody');
  assert.equal(await run(releaseStatement(s.w.db, { ...base, from: s.alpha })), 0, 'it is on no team');
  assert.equal(await s.teamOf(s.alt1), null);
  assert.equal(await run(placeStatement(s.w.db, { ...base, teamId: s.bravo })), 1);
  assert.equal(await run(releaseStatement(s.w.db, { ...base, from: s.charlie })), 0, 'it is on Bravo, not Charlie');
  assert.equal(await run(releaseStatement(s.w.db, { ...base, guildId: 'g_AAAAAAAAAAAAAAAAAAAAAA', from: s.bravo })), 0);
  assert.equal(await run(releaseStatement(s.w.db, { ...base, from: s.bravo })), 1);
  // The unique index is the backstop for a writer that skips the guard.
  s.exec(`UPDATE characters SET team_id = '${s.bravo}' WHERE id = '${s.alt1}'`);
  assert.throws(() => s.exec(`UPDATE characters SET team_id = '${s.bravo}' WHERE id = '${s.alt2}' AND player_id = '${s.m1.pid}'`), /UNIQUE constraint/);
});

check('release: the team\'s Team Lead and officers take a character off the team, nobody else; a character on no team is a no-op; the Main may be released too', async () => {
  const s = await world();
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  await s.fail('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 403, 'forbidden');
  await s.fail('m1', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 403, 'forbidden');
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  const released = await s.ok('tlb', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 200);
  assert.equal(await s.teamOf(s.alt1), null);
  assert.equal(released.characters.find((c) => c.name === 'Altone').team.id, null);
  const rows = await auditRows(s, 'character.release');
  assert.equal(rows.length, 1);
  assert.deepEqual([JSON.parse(rows[0].before).teamId, JSON.parse(rows[0].after).teamId], [s.bravo, null]);
  // Releasing a character on no team: nothing happens, nothing is audited. It is the person's lead (home team Alpha) who may ask, not a lead of another team.
  await s.fail('tlb', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 403, 'forbidden');
  await s.ok('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, {}, 200);
  assert.equal((await auditRows(s, 'character.release')).length, 1);
  // An officer releases the Main; the person is on no team then and the alt placed on Bravo stays there.
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, { teamId: s.bravo }, 200);
  await s.ok('o1', 'DELETE', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, {}, 200);
  assert.equal(await s.teamOf(s.m1.cid), null);
  assert.equal((await s.ok('o1', 'GET', `/roster?team=${s.alpha}`)).people.length, 0);
  // A stale page: the page thought it was on Charlie.
  await s.fail('o1', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, { fromTeamId: s.charlie }, 409, 'conflict');
  assert.equal(await s.teamOf(s.alt2), s.bravo);
});

check('move: roster.edit on BOTH teams (the current lead releases first): the lead of the target alone is told to ask, one audit row, the unique rule holds', async () => {
  const s = await world();
  const url = `/roster/${s.m1.pid}/characters/${s.alt1}/team`;
  await s.ok('o1', 'PUT', url, { teamId: s.bravo }, 200);
  // Bravo -> Alpha. The lead of Alpha does not lead Bravo: release_first. The lead of Bravo does not lead Alpha: forbidden.
  const ask = await s.fail('tla', 'PUT', url, { teamId: s.alpha }, 403, 'release_first');
  assert(/Bravo/.test(ask.message));
  await s.fail('tlb', 'PUT', url, { teamId: s.charlie }, 403, 'forbidden');
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  // The Main holds Alpha: the alt cannot move there for anyone.
  await s.fail('o1', 'PUT', url, { teamId: s.alpha }, 409, 'team_taken');
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  // Bravo -> Charlie by an officer, and Charlie -> Bravo by the lead of both Alpha and Bravo is refused (no right on Charlie).
  await s.ok('o1', 'PUT', url, { teamId: s.charlie }, 200);
  assert.equal(await s.teamOf(s.alt1), s.charlie);
  await s.fail('tlab', 'PUT', url, { teamId: s.bravo }, 403, 'release_first');
  const moves = await auditRows(s, 'character.move');
  assert.equal(moves.length, 1);
  assert.deepEqual([JSON.parse(moves[0].before).teamId, JSON.parse(moves[0].after).teamId], [s.bravo, s.charlie]);
  // The person leaves Bravo: it is gone from Bravo's roster and on Charlie's.
  assert.equal((await s.ok('o1', 'GET', `/roster?team=${s.bravo}`)).people.length, 0);
  assert.deepEqual((await s.ok('o1', 'GET', `/roster?team=${s.charlie}`)).people.map((p) => p.names).flat(), ['Altone']);
});

check('the Seniority guard stops a release or a move of a senior character, and leaves a placement alone', async () => {
  const s = await world();
  await s.lead('tlbc', [s.bravo, s.charlie], 'Leadbc');
  const officerPerson = await s.person({ name: 'Officerown' });
  await s.link(officerPerson.pid, 'o1');
  const alt = await s.alt(officerPerson.pid, 'Officeralt');
  const url = `/roster/${officerPerson.pid}/characters/${alt}/team`;
  // A placement is not guarded: the lead of Bravo puts the Officer's alt on Bravo.
  await s.ok('tlb', 'PUT', url, { teamId: s.bravo }, 200);
  // Releasing it is refused for the lead (the Officer outranks them), and so is a move by a lead who may edit both teams.
  await s.fail('tlb', 'DELETE', url, {}, 403, 'seniority');
  await s.fail('tlbc', 'PUT', url, { teamId: s.charlie }, 403, 'seniority');
  assert.equal(await s.teamOf(alt), s.bravo);
  assert.equal((await auditRows(s, 'character.move')).length + (await auditRows(s, 'character.release')).length, 0, 'a refused act leaves no audit row');
  // An equal Officer is refused too; the Guild Master (senior) moves and releases it.
  await s.officer('o2', 'Officertwo');
  await s.fail('o2', 'DELETE', url, {}, 403, 'seniority');
  await s.ok('gm', 'PUT', url, { teamId: s.charlie }, 200);
  await s.ok('gm', 'DELETE', url, {}, 200);
  // A Member's alt the leads may place, move and release.
  const mine = `/roster/${s.m1.pid}/characters/${s.alt1}/team`;
  await s.ok('tlb', 'PUT', mine, { teamId: s.bravo }, 200);
  await s.ok('tlbc', 'PUT', mine, { teamId: s.charlie }, 200);
  await s.ok('tlbc', 'DELETE', mine, {}, 200);
});

check('unassigned: the characters on no team (what Add to team offers) for whoever may edit a roster, filterable by the start of the name; placed ones are not listed; a pending request is shown', async () => {
  const s = await world();
  await s.member('m2', 'Membertwo');
  const other = await s.person({ name: 'Otherguy' });
  await s.link(other.pid, 'm2');
  const loose = await s.alt(other.pid, 'Looseone');
  const all = await s.ok('tla', 'GET', '/roster/unassigned');
  assert.deepEqual(all.characters.map((c) => c.name), ['Altone', 'Alttwo', 'Looseone']);
  assert.equal(all.more, false);
  const entry = all.characters.find((c) => c.name === 'Looseone');
  assert.deepEqual([entry.id, entry.class, entry.isMain, entry.person, entry.requestedTeamId, entry.status, entry.left], [loose, 'ROGUE', false, { id: other.pid, name: 'Otherguy' }, null, 'raider', false]);
  assert.deepEqual((await s.ok('tla', 'GET', '/roster/unassigned?q=alt')).characters.map((c) => c.name), ['Altone', 'Alttwo']);
  assert.deepEqual((await s.ok('tla', 'GET', '/roster/unassigned?q=ALTO')).characters.map((c) => c.name), ['Altone']);
  assert.deepEqual((await s.ok('tla', 'GET', '/roster/unassigned?q=%25')).characters, [], 'a percent sign is a letter, not a wildcard');
  assert.deepEqual((await s.ok('tla', 'GET', '/roster/unassigned?q=_')).characters, []);
  // A placed character leaves the list; a member's request shows on it.
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.bravo }, 200);
  s.exec(`INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at) VALUES ('tq_AAAAAAAAAAAAAAAAAAAAAA', '${s.gid}', '${s.charlie}', '${loose}', '${s.uids.m2}', 1)`);
  const after = await s.ok('tla', 'GET', '/roster/unassigned');
  assert.deepEqual(after.characters.map((c) => [c.name, c.requestedTeamId]), [['Alttwo', null], ['Looseone', s.charlie]]);
  await s.fail('m1', 'GET', '/roster/unassigned', undefined, 403, 'forbidden');
  assert.equal((await s.w.call({}, 'GET', `${s.base}/roster/unassigned`)).status, 401);
});

// Sign-ups: an upcoming raid on Alpha and one on Bravo, a finished raid on Alpha; the person's native sign-ups on them, a standing entry, a Raid-Helper row, a guest.
async function signupWorld() {
  const s = await world();
  const make = async (teamId, raidOn) => (await s.ok('gm', 'POST', '/raids', { teamId, raidOn, startTime: '20:00', zone: 'Karazhan' })).raid.id;
  s.upcomingAlpha = await make(s.alpha, '2099-02-01');
  s.upcomingAlpha2 = await make(s.alpha, '2099-02-08');
  s.upcomingBravo = await make(s.bravo, '2099-02-01');
  s.pastAlpha = await make(s.alpha, '2026-10-01');
  const native = (raid, id, who = s.m1.pid) => s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, position, guild_id, player_id, character_id, created_at, updated_at)
    VALUES ('${raid}', 'raidsmith', ${id}, NULL, 'signed', 0, ${id}, '${s.gid}', '${who}', '${s.m1.cid}', 1, 1)`);
  native(s.upcomingAlpha, 1);
  native(s.upcomingAlpha2, 1);
  native(s.upcomingBravo, 1);
  native(s.pastAlpha, 1);
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, position, guild_id, player_id, created_at, updated_at)
    VALUES ('${s.upcomingAlpha}', 'raid_helper', 77, 'Mainone', 'signed', 0, 77, '${s.gid}', '${s.m1.pid}', 1, 1)`);
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, guest, created_at, updated_at)
    VALUES ('${s.upcomingAlpha}', 'raidsmith', 90, 'Pugguest', 'signed', 0, 'Mage', 'Fire1', 90, '${s.gid}', 1, 1, 1)`);
  s.exec(`INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES
    ('sg_AAAAAAAAAAAAAAAAAAAAAA', '${s.gid}', '${s.alpha}', '${s.m1.pid}', 2, 'signed', NULL, 1, 1),
    ('sg_BBBBBBBBBBBBBBBBBBBBBB', '${s.gid}', '${s.bravo}', '${s.m1.pid}', 3, 'signed', NULL, 1, 1)`);
  return s;
}
const signupCounts = async (s) => ({
  native: (await s.rows("SELECT raid_id FROM raid_signups WHERE source = 'raidsmith' AND guest = 0 AND player_id = ? ORDER BY raid_id", s.m1.pid)).map((r) => r.raid_id).sort(),
  helper: (await s.rows("SELECT raid_id FROM raid_signups WHERE source = 'raid_helper'")).length,
  guests: (await s.rows('SELECT raid_id FROM raid_signups WHERE guest = 1')).length,
  standing: (await s.rows('SELECT team_id FROM standing_signups WHERE player_id = ? ORDER BY team_id', s.m1.pid)).map((r) => r.team_id).sort(),
});

check('release lists the upcoming sign-ups first (GET team-signups); removeSignups false keeps them, true drops the person\'s upcoming and standing sign-ups for THAT team only', async () => {
  const s = await signupWorld();
  const listed = await s.ok('tla', 'GET', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team-signups`);
  assert.equal(listed.team.id, s.alpha);
  assert.deepEqual(listed.signups.map((x) => x.raidId).sort(), [s.upcomingAlpha, s.upcomingAlpha2].sort(), 'upcoming only, the Raid-Helper row and the guest are not the person\'s Raidsmith sign-up');
  assert.deepEqual(listed.standing, [{ weekday: 2, kind: 'signed' }]);
  await s.fail('tlb', 'GET', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team-signups`, undefined, 403, 'forbidden');
  const before = await signupCounts(s);
  // "Ask each time": the default keeps everything.
  await s.ok('o1', 'DELETE', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, {}, 200);
  assert.deepEqual(await signupCounts(s), before);
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.alpha }, 200);
  const dropped = await s.ok('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { removeSignups: true }, 200);
  assert.deepEqual(dropped.removed, { signups: 2, standing: 1 });
  const after = await signupCounts(s);
  assert.deepEqual(after.native.sort(), [s.pastAlpha, s.upcomingBravo].sort(), 'the finished raid and the other team stay');
  assert.deepEqual([after.helper, after.guests], [1, 1], 'a Raid-Helper row and a guest are not touched');
  assert.deepEqual(after.standing, [s.bravo]);
  const audited = await auditRows(s, 'character.release');
  assert.equal(JSON.parse(audited[audited.length - 1].after).removeSignups, true);
  // The listing for a character on no team is empty.
  assert.deepEqual(await s.ok('o1', 'GET', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team-signups`), { team: null, signups: [], standing: [] });
});

check('move can drop the old team\'s upcoming sign-ups too; without the flag they stay', async () => {
  const s = await signupWorld();
  // The Main moves Alpha -> Charlie by an officer, keeping the sign-ups; then back and again with the flag.
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.charlie }, 200);
  assert.equal((await signupCounts(s)).native.length, 4);
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.alpha }, 200);
  const moved = await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.charlie, removeSignups: true }, 200);
  assert.deepEqual(moved.removed, { signups: 2, standing: 1 });
  assert.deepEqual((await signupCounts(s)).native.sort(), [s.pastAlpha, s.upcomingBravo].sort());
});

check('a team change makes the raids that depend on the roster show Recalculate; the new audit actions have a group and a sentence in the Activity log', async () => {
  const s = await signupWorld();
  const before = await s.one('SELECT version FROM raids WHERE id = ?', s.upcomingAlpha);
  await s.ok('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, {}, 200);
  const after = await s.one('SELECT version FROM raids WHERE id = ?', s.upcomingAlpha);
  assert(after.version > before.version, 'the team\'s raids were marked stale');
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.bravo }, 200);
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.m1.cid}/team`, { teamId: s.charlie }, 200);
  const log = await s.ok('gm', 'GET', '/audit?type=roster');
  const text = log.rows ? log.rows.map((r) => r.text).join('\n') : JSON.stringify(log);
  assert(/Took the character Mainone off Alpha/.test(text), text.slice(0, 400));
  assert(/Put the character Mainone on Bravo/.test(text));
  assert(/Moved the character Mainone from Bravo to Charlie/.test(text));
});

check('rights come before any answer about the person: without roster.edit on the team (or without roster.view) a place or a release is a bare 403 - not a stale-page 409 and not the no-change reply, both of which carry the person record', async () => {
  const s = await world();
  const url = `/roster/${s.m1.pid}/characters/${s.alt1}/team`;
  await s.member('m2', 'Membertwo');
  await s.ok('o1', 'PUT', url, { teamId: s.bravo }, 200); // alt1 sits on Bravo; alt2 on no team
  const bare = (res) => {
    assert.deepEqual([res.status, res.json.error], [403, 'forbidden'], res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ['error', 'message'], 'no person data in the answer');
  };
  const attempts = async (who) => {
    // a stale page (the character is on Bravo, the caller saw Charlie), placing where it already is, a stale release, releasing a character on no team
    bare(await s.call(who, 'PUT', url, { teamId: s.charlie, fromTeamId: s.alpha }));
    bare(await s.call(who, 'PUT', url, { teamId: s.bravo }));
    bare(await s.call(who, 'DELETE', url, { fromTeamId: s.alpha }));
    bare(await s.call(who, 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, {}));
  };
  // A plain Member (roster.view, no roster.edit), the lead of another team (roster.edit on Bravo only is not enough for Charlie or for the person's home team),
  await attempts('m2');
  await attempts('m1');
  bare(await s.call('tlb', 'PUT', url, { teamId: s.charlie, fromTeamId: s.alpha }));
  bare(await s.call('tlb', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, {}));
  // Whoever may edit still gets the stale-page 409 with the record and the no-change replies.
  const stale = await s.fail('o1', 'PUT', url, { teamId: s.charlie, fromTeamId: s.alpha }, 409, 'conflict');
  assert(stale.current.person, 'the officer is shown the current record');
  assert.equal((await s.call('o1', 'PUT', url, { teamId: s.bravo })).status, 200);
  assert.equal((await s.call('tla', 'DELETE', `/roster/${s.m1.pid}/characters/${s.alt2}/team`, {})).status, 200);
  // and a Member whose role lost roster.view.
  await s.ok('gm', 'PUT', '/roles/member', { permissions: { 'raids.view': 'guild' } }, 200);
  await attempts('m2');
  await attempts('m1');
  assert.equal(await s.teamOf(s.alt1), s.bravo, 'nothing was written');
  // roster.view on its own: a Member who may edit every roster but cannot view it still gets nothing back.
  await s.ok('gm', 'PUT', '/roles/member', { permissions: { 'raids.view': 'guild', 'roster.edit': 'guild' } }, 200);
  await attempts('m2');
  await s.ok('gm', 'PUT', '/roles/member', { permissions: { 'raids.view': 'guild', 'roster.edit': 'guild', 'roster.view': 'guild' } }, 200);
  assert.equal((await s.call('m2', 'PUT', url, { teamId: s.charlie, fromTeamId: s.alpha })).status, 409, 'with both rights the stale page is answered again');
});

runChecks(checks);
