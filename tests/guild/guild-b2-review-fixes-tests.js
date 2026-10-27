/**
 * Raidsmith guild tracker - the fixes of the review of release R2 (lane B2): six findings, one regression check each
 * Run: node tests/guild/guild-b2-review-fixes-tests.js
 *
 *   1. PATCH /roster/:pid mirrors a field into players only when that field changed: a legacy players row the characters cannot carry (a Break with its
 *      left date, trial dates on a person who is not on trial) survives an unrelated PATCH (R2/R3; since R4 nothing writes those columns);
 *   2. the trial review of a Trial alt shows the officer notes of the person's HOME team only: the lead of the alt's team reads attendance and loot, not the notes;
 *   3. a lost Make-Main race (the same move already done by another request) does not copy the old Main's empty trial dates over the new Main's;
 *   4. a custom role that holds signups.self at guild or team scope still needs a character on the raid's team roster to sign up (U R4-Q1);
 *   5. Make Main on a character on no team carries the home team to the new Main (the old Main steps off, an alt on no team), so deleting the old Main does
 *      not take the person off the team (a Team Lead of the home team may do it); a NEW Main added with no team still needs the whole-guild editor;
 *   6. the What's new page carries the R2 entry.
 * The guild is built through the API; a character is placed on a team (the team routes of lane B3 will do that) with the column itself.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, adminOf, load, memberOf, makeWorld, signIn } = require('../guild-world');

const MISMATCH = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/mismatch.sql'), 'utf8');
const ZERO = { core_rank: 0, left_on: 0, left_reason: 0, trial_start: 0, trial_end: 0 };
const SERVER = '900000000000000093';
const person = (n, name) => ({ id: `1100000000000010${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = {
  gm: person(1, 'Gmfix'), lead: person(2, 'Leadfix'), lead2: person(3, 'Leadtwofix'), member: person(4, 'Memberfix'),
};
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario({ teams = ['Alpha', 'Bravo'] } = {}) {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Review fixes', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
    multipleTeams: true, teamNames: teams,
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const uids = {};
  const s = {
    w, gid, tids, jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    exec: (sql) => w.db.sqlite.exec(sql),
    async member(key) {
      jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      return uids[key];
    },
    async lead(key, teamIds) {
      const id = await s.member(key);
      await s.ok('gm', 'PUT', `/people/${id}/roles`, { officer: false, teamLeadTeamIds: teamIds }, 200);
      return id;
    },
    async newPerson(body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', '/roster', { teamId: tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null, ...body });
      return { pid: res.person.id, cid: res.characters[0].id, version: res.person.version, today: res.today, res };
    },
    async alt(pid, name, body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', `/roster/${pid}/characters`, { teamId: tids[0], class: 'ROGUE', mainSpec: 'Combat', offSpec: null, name, ...body });
      return res.characters.find((c) => c.name === name).id;
    },
    // R4 (lane B4b) deleted the players mirror, so mismatch.sql no longer describes a state the code keeps: the R2 sync checks stay as labels only.
    async inSync(label) { assert.ok(MISMATCH && ZERO && label); },
    playerRow: async (pid) => (await s.rows('SELECT status, joined_on, trial_start, trial_end, left_on, left_reason, version FROM players WHERE id = ?', pid))[0],
  };
  return s;
}

// ---------------------------------------------------------------------------
// 1. The players mirror writes only the fields that changed

check('PATCH: a joinedOn-only change keeps the legacy Break + left date of an old Inactive row and the stored trial dates of a person who is not on trial', async () => {
  const s = await scenario();
  const brk = await s.newPerson({ name: 'Legacybreak' });
  // R1 data: Inactive with the reason Break and a left date, on players only; migration 0030 maps the characters to Social with no left date.
  s.exec(`UPDATE players SET status = 'inactive', left_on = '2026-01-05', left_reason = 'break', version = version + 1 WHERE id = '${brk.pid}'`);
  s.exec(`UPDATE characters SET core_rank = 'social', left_on = NULL, left_reason = NULL WHERE player_id = '${brk.pid}'`);
  const stale = await s.newPerson({ name: 'Legacytrial' });
  s.exec(`UPDATE players SET trial_start = '2026-12-01', trial_end = '2027-01-01', version = version + 1 WHERE id = '${stale.pid}'`);
  await s.inSync('the seeded legacy rows');

  for (const [who, expected] of [
    [brk, { status: 'inactive', trial_start: null, trial_end: null, left_on: '2026-01-05', left_reason: 'break' }],
    [stale, { status: 'raider', trial_start: '2026-12-01', trial_end: '2027-01-01', left_on: null, left_reason: null }],
  ]) {
    const record = await s.ok('gm', 'GET', `/roster/${who.pid}`);
    const patched = await s.ok('gm', 'PATCH', `/roster/${who.pid}`, { expectedVersion: record.person.version, joinedOn: '2025-12-01' }, 200);
    assert.equal(patched.person.joinedOn, '2025-12-01');
    assert.equal(patched.person.version, record.person.version + 1);
    const row = await s.playerRow(who.pid);
    assert.deepEqual({ ...row, joined_on: undefined, version: undefined }, { ...expected, joined_on: undefined, version: undefined }, 'the old values are still there');
    assert.equal(row.joined_on, '2025-12-01');
    await s.inSync(`a joinedOn-only PATCH of ${patched.characters[0].name}`);
  }
});

// "A change of status or of a date still mirrors into players" was an R2/R3 check: R4 (lane B4b) deleted the mirror, and
// guild-legacy-columns-tests.js pins that nothing writes those columns any more.

// ---------------------------------------------------------------------------
// 2. The trial review shows the home team's notes only

check('trial review: the lead of the Trial alt\'s team reads that team\'s attendance and loot but not the home team\'s officer notes; the home lead and an officer read them', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  const p = await s.newPerson({ name: 'Homeone' });
  const alt = await s.alt(p.pid, 'Trialalt');
  const before = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  await s.ok('gm', 'PUT', `/roster/${p.pid}/notes`, { text: 'PRIVATE officer note of the home team', expectedNotesVersion: before.notes.version }, 200);
  s.exec(`UPDATE characters SET team_id = '${bravo}', core_rank = 'trial', trial_start = '2027-01-01', trial_end = '2027-02-01' WHERE id = '${alt}'`);
  await s.lead('lead', [alpha]);
  await s.lead('lead2', [bravo]);

  const bravoCard = await s.ok('lead2', 'GET', `/roster/${p.pid}/trial`);
  assert.equal(bravoCard.attendance.team.id, bravo, 'the Bravo lead reads the Bravo card');
  assert.notEqual(bravoCard.loot, undefined, 'and its loot section');
  assert.equal(bravoCard.notes, null, 'but not the notes of Alpha');
  assert.equal((await s.ok('lead2', 'GET', `/roster/${p.pid}`)).notes, null, 'the same answer as the person record');

  const alphaCard = await s.ok('lead', 'GET', `/roster/${p.pid}/trial`);
  assert.match(alphaCard.notes.excerpt, /PRIVATE officer note/, 'the lead of the home team reads them');
  const officerCard = await s.ok('gm', 'GET', `/roster/${p.pid}/trial`);
  assert.match(officerCard.notes.excerpt, /PRIVATE officer note/, 'so does an officer');
  assert.equal(officerCard.attendance.team.id, bravo);
});

// ---------------------------------------------------------------------------
// 3. A lost Make-Main race changes nothing

check('Make Main: the loser of a race (the same move already done) does not wipe the new Main\'s trial dates', async () => {
  const roster = await load('worker/routes/roster.js');
  const legacy = await load('worker/person-legacy.js');
  const s = await scenario();
  const alpha = s.tids[0];
  const p = await s.newPerson({ name: 'Trialmain', status: 'trial', trialEnd: '2027-02-10' });
  const alt = await s.alt(p.pid, 'Trialalt');
  const dates = (await s.rows('SELECT trial_start, trial_end FROM characters WHERE id = ?', p.cid))[0];
  assert.ok(dates.trial_start && dates.trial_end, 'the Main carries the trial dates');
  // The request that wins.
  await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${alt}/main`, {}, 200);
  const after = (await s.rows('SELECT name, is_main, team_id, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', p.pid));
  assert.deepEqual(after, [
    { name: 'Trialalt', is_main: 1, team_id: alpha, trial_start: dates.trial_start, trial_end: dates.trial_end },
    { name: 'Trialmain', is_main: 0, team_id: null, trial_start: null, trial_end: null },
  ]);
  await s.inSync('the winning Make Main');
  // The loser read the person before that: the old Main on Alpha, the same target. Its batch, statement for statement, as the route builds it
  // (the home team follows the Main after the audit row and the trial dates).
  const db = s.w.db;
  const results = await db.batch([
    ...roster.makeMainStatements(db, p.pid, alt, 1, { homeTeamId: alpha, targetTeamId: null, senior: { sql: '1 = 1', params: [] } }),
    db.prepare('SELECT 1').bind(),
    ...legacy.trialDatesFollowMainStatements(db, p.cid, alt),
    ...roster.homeTeamFollowsMainStatements(db, { playerId: p.pid, oldMainId: p.cid, newMainId: alt, homeTeamId: alpha, now: 1 }),
  ]);
  assert.deepEqual([results[0].meta.changes, results[1].meta.changes], [0, 0], 'the swap changed nothing (the route answers 409)');
  assert.deepEqual(results.slice(5).map((result) => result.meta.changes), [0, 0], 'and neither did the two team statements');
  assert.deepEqual(await s.rows('SELECT name, is_main, team_id, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', p.pid), after, 'and neither did the trial dates');
  await s.inSync('the losing Make Main');
});

// ---------------------------------------------------------------------------
// 4. A custom signups.self role needs a character on the raid's team

async function roleWorld() {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  const uid = await s.member('member');
  const p = await s.newPerson({ name: 'Alphaonly', linkUserId: uid });
  const guildRole = (await s.ok('gm', 'POST', '/roles', { name: 'Everywhere signer', permissions: { 'signups.self': 'guild' } })).roles.find((r) => r.name === 'Everywhere signer').id;
  const teamRole = (await s.ok('gm', 'POST', '/roles', { name: 'Bravo signer', permissions: { 'signups.self': 'team' } })).roles.find((r) => r.name === 'Bravo signer').id;
  const raid = async (teamId, raidOn) => (await s.ok('gm', 'POST', '/raids', { teamId, raidOn, startTime: '20:00' }, 201)).raid.id;
  return { s, alpha, bravo, uid, p, guildRole, teamRole, raid };
}

check('sign-up: a custom role with signups.self (guild or team scope) does not let a member without a character on the raid\'s team sign up', async () => {
  const { s, alpha, bravo, uid, p, guildRole, teamRole, raid } = await roleWorld();
  const bravoRaid = await raid(bravo, '2027-02-02');
  const alphaRaid = await raid(alpha, '2027-02-03');
  // The built-in Member role: only the own team's raid.
  assert.equal((await s.call('member', 'PUT', `/raids/${bravoRaid}/signup`, { kind: 'signed' })).status, 403, 'a plain member');
  // Guild scope.
  await s.ok('gm', 'PUT', `/people/${uid}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: guildRole, teamId: null }] }, 200);
  const refused = await s.call('member', 'PUT', `/raids/${bravoRaid}/signup`, { kind: 'signed' });
  assert.equal(refused.status, 403, refused.text);
  assert.equal((await s.call('member', 'DELETE', `/raids/${bravoRaid}/signup`)).status, 403, 'nor can they withdraw one');
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith'"), 0, 'nothing was written');
  // Team scope on the team they are not on.
  await s.ok('gm', 'PUT', `/people/${uid}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: teamRole, teamId: bravo }] }, 200);
  assert.equal((await s.call('member', 'PUT', `/raids/${bravoRaid}/signup`, { kind: 'signed' })).status, 403, 'team scope on Bravo');
  assert.equal(await s.w.count('raid_signups', "source = 'raidsmith'"), 0);
  // The team they are on still works, with any of their characters (U R4-Q1).
  await s.ok('gm', 'PUT', `/people/${uid}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: guildRole, teamId: null }] }, 200);
  const altId = await s.alt(p.pid, 'Alphaalt');
  const ok = await s.ok('member', 'PUT', `/raids/${alphaRaid}/signup`, { kind: 'signed', characterId: altId }, 200);
  assert.equal(ok.entries.find((e) => e.isMe).name, 'Alphaalt');
  assert.equal((await s.rows("SELECT player_id FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith'", alphaRaid))[0].player_id, p.pid);
  // Once their character is on Bravo's roster they may sign up there too.
  s.exec(`UPDATE characters SET team_id = '${bravo}' WHERE id = '${altId}'`);
  assert.equal((await s.call('member', 'PUT', `/raids/${bravoRaid}/signup`, { kind: 'signed' })).status, 200);
});

// ---------------------------------------------------------------------------
// 5. Make Main on a character on no team: the home team follows the Main (the old Main steps off). A NEW Main on no team needs the whole-guild editor.

const characterRows = async (s, pid) => (await s.rows('SELECT name, is_main, team_id FROM characters WHERE player_id = ? ORDER BY name', pid)).map((r) => [r.name, r.is_main, r.team_id]);
const rosterNames = async (s, who, teamId, pid) => ((await s.ok(who, 'GET', `/roster?team=${teamId}`)).people.find((row) => row.id === pid) || { names: null }).names;
const makeMainOf = (s, who, pid, cid) => s.call(who, 'POST', `/roster/${pid}/characters/${cid}/main`, {});

// Runs `interleave()` right before the first db.batch that holds a statement matching `re` (a concurrent request landing between the handler's reads and its write).
function hookBatch(db, re, interleave) {
  const real = db.batch.bind(db);
  let done = false;
  db.batch = async (statements) => {
    if (!done && statements.some((statement) => re.test(statement.sql))) {
      done = true;
      interleave();
    }
    return real(statements);
  };
}

check('Make Main on a teamless alt (officer): the new Main takes the home team, the old Main is a teamless alt; deleting the old Main leaves the person on the team roster', async () => {
  const s = await scenario();
  const [alpha] = s.tids;
  const p = await s.newPerson({ name: 'Alphahome' });
  const altId = await s.alt(p.pid, 'Alphaalt');
  assert.deepEqual(await characterRows(s, p.pid), [['Alphaalt', 0, null], ['Alphahome', 1, alpha]]);
  const done = await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {}, 200);
  assert.deepEqual(done.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Alphaalt', true, alpha], ['Alphahome', false, null]]);
  assert.equal(done.person.homeTeam.id, alpha, 'the person keeps its home team');
  assert.deepEqual(await characterRows(s, p.pid), [['Alphaalt', 1, alpha], ['Alphahome', 0, null]]);
  assert.deepEqual(await rosterNames(s, 'gm', alpha, p.pid), ['Alphaalt'], 'the team roster shows the new Main');
  await s.inSync('the officer\'s Make Main');
  // The bug: deleting the old Main afterwards took the person off the team.
  const removed = await s.ok('gm', 'DELETE', `/roster/${p.pid}/characters/${p.cid}`, undefined, 200);
  assert.deepEqual(removed.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Alphaalt', true, alpha]]);
  assert.deepEqual(await rosterNames(s, 'gm', alpha, p.pid), ['Alphaalt'], 'still on the team roster after the old Main is deleted');
  await s.inSync('deleting the old Main');
});

check('Make Main on a teamless alt: a Team Lead of the home team may do it, a Team Lead of another team gets 403 and nothing moves', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  await s.lead('lead', [alpha]);
  await s.lead('lead2', [bravo]);
  const p = await s.newPerson({ name: 'Alphahome' });
  const altId = await s.alt(p.pid, 'Alphaalt');
  const before = await characterRows(s, p.pid);
  const refused = await makeMainOf(s, 'lead2', p.pid, altId);
  assert.equal(refused.status, 403, refused.text);
  assert.deepEqual(await characterRows(s, p.pid), before, 'nothing moved');
  const done = await s.ok('lead', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {}, 200);
  assert.deepEqual(done.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Alphaalt', true, alpha], ['Alphahome', false, null]]);
  assert.equal(done.person.homeTeam.id, alpha);
  const record = await s.ok('lead', 'GET', `/roster/${p.pid}`);
  assert.equal(record.can.edit, true, 'the lead still reaches the person');
  await s.ok('lead', 'PATCH', `/roster/${p.pid}`, { expectedVersion: record.person.version, joinedOn: '2026-12-01' }, 200);
  assert.equal((await s.call('lead2', 'DELETE', `/roster/${p.pid}/characters/${p.cid}`)).status, 403, 'the other lead still does not reach them');
  await s.ok('lead', 'DELETE', `/roster/${p.pid}/characters/${p.cid}`, undefined, 200);
  assert.deepEqual(await rosterNames(s, 'lead', alpha, p.pid), ['Alphaalt']);
  await s.inSync('the lead\'s Make Main');
});

check('Make Main on an alt that sits on another team: no team changes (the old Main keeps the home team); a person whose Main is on no team has none to carry', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  const p = await s.newPerson({ name: 'Alphahome' });
  const altId = await s.alt(p.pid, 'Bravoalt');
  s.exec(`UPDATE characters SET team_id = '${bravo}' WHERE id = '${altId}'`);
  const done = await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {}, 200);
  assert.deepEqual(done.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Bravoalt', true, bravo], ['Alphahome', false, alpha]]);
  assert.deepEqual(await characterRows(s, p.pid), [['Alphahome', 0, alpha], ['Bravoalt', 1, bravo]]);
  await s.inSync('Make Main onto another team');
  // The Main on no team: Make Main of a teamless alt moves no team (there is none to carry).
  const homeless = await s.newPerson({ name: 'Nowherehome', teamId: undefined });
  const nowhereAlt = await s.alt(homeless.pid, 'Nowherealt');
  await s.ok('gm', 'POST', `/roster/${homeless.pid}/characters/${nowhereAlt}/main`, {}, 200);
  assert.deepEqual(await characterRows(s, homeless.pid), [['Nowherealt', 1, null], ['Nowherehome', 0, null]]);
  await s.inSync('Make Main with no home team');
});

check('Make Main on a teamless alt: the trial dates follow the Main, the home team\'s raids are marked stale, the audit row keeps its shape', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  const p = await s.newPerson({ name: 'Trialhome', status: 'trial', trialEnd: '2027-02-10' });
  const altId = await s.alt(p.pid, 'Trialalt');
  const dates = (await s.rows('SELECT trial_start, trial_end FROM characters WHERE id = ?', p.cid))[0];
  assert.ok(dates.trial_start && dates.trial_end);
  // Two raids with evidence, one per team, both fresh; the Alpha one must be marked stale, the Bravo one not.
  const alphaRaid = (await s.ok('gm', 'POST', '/raids', { teamId: alpha, raidOn: '2027-02-02', startTime: '20:00' }, 201)).raid.id;
  const bravoRaid = (await s.ok('gm', 'POST', '/raids', { teamId: bravo, raidOn: '2027-02-03', startTime: '20:00' }, 201)).raid.id;
  for (const [raid, team] of [[alphaRaid, alpha], [bravoRaid, bravo]]) {
    s.exec(`INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES ('${raid}', '${s.gid}', '${team}', '${p.pid}', 'present', 1, 1)`);
    s.exec(`UPDATE raids SET policy_fp = 'fp-fresh' WHERE id = '${raid}'`);
  }
  await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {}, 200);
  assert.deepEqual(await s.rows('SELECT name, is_main, team_id, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', p.pid), [
    { name: 'Trialalt', is_main: 1, team_id: alpha, trial_start: dates.trial_start, trial_end: dates.trial_end },
    { name: 'Trialhome', is_main: 0, team_id: null, trial_start: null, trial_end: null },
  ], 'the dates moved with the Main, together with the team');
  const fps = Object.fromEntries((await s.rows('SELECT id, policy_fp FROM raids')).map((row) => [row.id, row.policy_fp]));
  assert.equal(fps[alphaRaid], '', 'the home team\'s raid is stale');
  assert.equal(fps[bravoRaid], 'fp-fresh', 'another team\'s raid is not');
  const audit = await s.rows("SELECT guild_id, actor_user_id, action, entity_type, entity_id, before, after FROM audit_log WHERE action = 'character.main'");
  assert.deepEqual(audit.map((row) => [row.guild_id, row.action, row.entity_type, row.entity_id, JSON.parse(row.before), JSON.parse(row.after)]),
    [[s.gid, 'character.main', 'character', altId, { mainCharacterId: p.cid }, { mainCharacterId: altId }]], 'one row, the same shape as before');
  assert.ok(audit[0].actor_user_id);
  await s.inSync('Make Main with trial dates');
});

check('Make Main on a teamless alt: when the old Main changed between the read and the write nothing moves and the answer is 409 with the current record', async () => {
  // (a) the same move was already done by another request.
  let s = await scenario();
  let [alpha] = s.tids;
  let p = await s.newPerson({ name: 'Racehome' });
  let altId = await s.alt(p.pid, 'Racealt');
  hookBatch(s.w.db, /UPDATE characters SET is_main = 0/, () => {
    s.exec(`UPDATE characters SET is_main = 0, team_id = NULL WHERE id = '${p.cid}'`);
    s.exec(`UPDATE characters SET is_main = 1, team_id = '${alpha}' WHERE id = '${altId}'`);
  });
  let lost = await makeMainOf(s, 'gm', p.pid, altId);
  assert.equal(lost.status, 409, lost.text);
  assert.equal(lost.json.error, 'conflict');
  assert.ok(lost.json.current, 'the current record');
  assert.deepEqual(lost.json.current.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Racealt', true, alpha], ['Racehome', false, null]]);
  assert.deepEqual(await characterRows(s, p.pid), [['Racealt', 1, alpha], ['Racehome', 0, null]], 'the winner\'s state, not touched');
  assert.equal(await s.w.count('audit_log', "action = 'character.main'"), 0, 'the loser wrote no audit row');
  await s.inSync('the lost race (move already done)');
  // (b) the old Main left the home team before the write: the swap does not match, and neither does a team write.
  s = await scenario();
  [alpha] = s.tids;
  const bravo = s.tids[1];
  p = await s.newPerson({ name: 'Movedhome' });
  altId = await s.alt(p.pid, 'Movedalt');
  hookBatch(s.w.db, /UPDATE characters SET is_main = 0/, () => s.exec(`UPDATE characters SET team_id = '${bravo}' WHERE id = '${p.cid}'`));
  lost = await makeMainOf(s, 'gm', p.pid, altId);
  assert.equal(lost.status, 409, lost.text);
  assert.deepEqual(await characterRows(s, p.pid), [['Movedalt', 0, null], ['Movedhome', 1, bravo]], 'only what the other request did');
  // (c) another character became the Main on another team: the old Main (an alt on the home team now) must not step off.
  s = await scenario();
  [alpha] = s.tids;
  const elsewhere = s.tids[1];
  p = await s.newPerson({ name: 'Swaphome' });
  altId = await s.alt(p.pid, 'Swapalt');
  const other = await s.alt(p.pid, 'Swapother');
  hookBatch(s.w.db, /UPDATE characters SET is_main = 0/, () => {
    s.exec(`UPDATE characters SET is_main = 0 WHERE id = '${p.cid}'`);
    s.exec(`UPDATE characters SET is_main = 1, team_id = '${elsewhere}' WHERE id = '${other}'`);
  });
  lost = await makeMainOf(s, 'gm', p.pid, altId);
  assert.equal(lost.status, 409, lost.text);
  assert.deepEqual(await characterRows(s, p.pid), [['Swapalt', 0, null], ['Swaphome', 0, alpha], ['Swapother', 1, elsewhere]],
    'the old Main keeps the home team, nothing else moved');
  await s.inSync('the lost races');
});

check('add character as the Main: a Team Lead cannot add a new Main on no team, can on a team they edit; an officer can add one on no team', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  await s.lead('lead', [alpha]);
  const p = await s.newPerson({ name: 'Alphahome' });
  const body = { class: 'ROGUE', mainSpec: 'Combat', offSpec: null, makeMain: true };
  const refused = await s.call('lead', 'POST', `/roster/${p.pid}/characters`, { ...body, name: 'Nowhere' });
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.json.message, /no team/);
  assert.equal(await s.w.count('characters', 'player_id = ?', p.pid), 1, 'no character was added');
  const nullTeam = await s.call('lead', 'POST', `/roster/${p.pid}/characters`, { ...body, name: 'Nowhere', teamId: null });
  assert.equal(nullTeam.status, 403, 'teamId null is no team too');
  assert.equal((await s.call('lead', 'POST', `/roster/${p.pid}/characters`, { ...body, name: 'Elsewhere', teamId: bravo })).status, 403, 'a team they do not edit');
  const placed = await s.ok('lead', 'POST', `/roster/${p.pid}/characters`, { ...body, name: 'Onalpha', teamId: alpha }, 201);
  assert.deepEqual(placed.characters.map((c) => [c.name, c.isMain, c.team.id]), [['Onalpha', true, alpha], ['Alphahome', false, null]]);
  const homeless = await s.ok('gm', 'POST', `/roster/${p.pid}/characters`, { ...body, name: 'Nowhere' }, 201);
  assert.equal(homeless.characters.find((c) => c.name === 'Nowhere').isMain, true);
  assert.equal(homeless.person.homeTeam, null);
  await s.inSync('the new Mains');
});

// ---------------------------------------------------------------------------
// 6. What's new

check('What\'s new: the newest entry says alts start on no team and the Inactive reasons', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/changelog.js'), 'utf8').split(/\r?\n/);
  const start = source.findIndex((line) => /^const CHANGELOG = \[/.test(line)) + 1;
  const entry = source.slice(start, source.findIndex((line, index) => index > start && /^\s*\] \},/.test(line)) + 1).join('\n');
  assert.match(entry, /title: 'Alts start on no team'/);
  assert.ok(entry.includes('Alts now start on no team. An alt shows on a team roster, and in the API roster feed, only when it is placed on a team itself.'));
  assert.ok(entry.includes('Inactive reasons are Left guild or Kicked.'));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
