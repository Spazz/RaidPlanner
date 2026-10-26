/**
 * Raidsmith guild tracker - lane B2 of the user-hierarchy build: the writers and the sign-up rule that go with the character columns (release R2)
 * Run: node tests/guild/guild-b2-writers-tests.js
 *
 *   - a new alt starts on NO team (U R3-Q1/R4-Q1), in every path; a new Main takes the team asked for and the previous Main steps off a team they shared;
 *   - D1: an officer creates a person with no team; every writer (notes, delete, edit, make main, remove, account link, claim link) works for a person and
 *     characters on no team instead of silently matching nothing; an alt on no team is edited by whoever edits the person's home team;
 *   - the PATCH status contract: a status change writes core_rank on EVERY character (Inactive = Social); since R4 (lane B4b) the players row is never written
 *     (it keeps the inert placeholder) after any writer;
 *   - patchCharacter: a Battle.net-bound character keeps its name and class; a character on no team is never placed by it; one character per person per team;
 *   - U R4-Q1: a team member signs up ANY of their characters (also a standing sign-up) for their own team's raid, and the attendance goes to the person;
 *   - D7: the guild export carries teamId null for a character on no team, the API roster feed lists only characters on a team roster;
 *   - the trial review reads the person's Trial character on its own team; the Teams page counts people by the team-roster predicate; the CSV import reads
 *     "social" as Social; the Battle.net import writes the identity key with the character.
 * The guild is built through the API; a character is placed on a team (which only the team routes of lane B3 will do) with the column itself where a check needs one.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, adminOf, load, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000081';
const person = (n, name) => ({ id: `1100000000000008${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = {
  gm: person(1, 'Gmb2'), lead: person(2, 'Leadb2'), lead2: person(3, 'Leadtwob2'), member: person(4, 'Memberb2'), claimant: person(5, 'Claimantb2'), other: person(6, 'Otherb2'),
};
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario({ teams = ['Alpha', 'Bravo'] } = {}) {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Writers B2', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
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
    teamOf: async (characterId) => (await s.rows('SELECT team_id FROM characters WHERE id = ?', characterId))[0].team_id,
    // The players rows are never written (R4): the NOT NULL status holds the placeholder, the old date fields stay empty.
    async playersInert(label) {
      const row = await w.db.prepare(
        `SELECT COUNT(*) AS n FROM players WHERE status != 'raider' OR trial_start IS NOT NULL OR trial_end IS NOT NULL OR left_on IS NOT NULL OR left_reason IS NOT NULL`,
      ).first();
      assert.equal(row.n, 0, `players rows inert after ${label}`);
    },
  };
  return s;
}

// ---------------------------------------------------------------------------
// A new alt starts on no team

check('add character: a new alt starts on no team whatever team was asked for; a bad team is still a 400; the person stays on the roster of the Main\'s team', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Mainone' });
  const altId = await s.alt(p.pid, 'Altone', { teamId: s.tids[1] });
  assert.equal(await s.teamOf(altId), null, 'asked for Bravo, still on no team');
  const record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  assert.deepEqual(record.characters.map((c) => [c.name, c.team.id]), [['Mainone', s.tids[0]], ['Altone', null]]);
  assert.equal(record.person.homeTeam.id, s.tids[0]);
  const bad = await s.call('gm', 'POST', `/roster/${p.pid}/characters`, { teamId: 't_AAAAAAAAAAAAAAAAAAAAAA', name: 'Altbad', class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  assert.deepEqual([bad.status, bad.json.field], [400, 'teamId']);
  const noTeam = await s.alt(p.pid, 'Altnone', { teamId: undefined });
  assert.equal(await s.teamOf(noTeam), null, 'no team asked for: none');
  const alpha = await s.ok('gm', 'GET', `/roster?team=${s.tids[0]}`);
  const row = alpha.people.find((x) => x.id === p.pid);
  assert.deepEqual([row.names, row.altCount], [['Mainone'], 2], 'the alts count but are not on the team');
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.tids[1]}`)).people, [], 'and they are nowhere else either');
  await s.playersInert('add character');
});

check('add character as the Main: the new Main takes the team asked for (none = no team), the previous Main steps off a team they shared, another character on it refuses', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  const p = await s.newPerson({ name: 'Firstmain' });
  // Same team as the previous Main: the new Main gets it, the old one becomes an alt on no team (one character per person per team).
  const second = await s.alt(p.pid, 'Secondmain', { teamId: alpha, makeMain: true });
  assert.deepEqual([await s.teamOf(second), await s.teamOf(p.cid)], [alpha, null]);
  assert.deepEqual((await s.rows('SELECT name, is_main FROM characters WHERE player_id = ? ORDER BY name', p.pid)).map((r) => [r.name, r.is_main]), [['Firstmain', 0], ['Secondmain', 1]]);
  // Another team: the previous Main (now teamless) stays as it is, the new Main sits on Bravo.
  const third = await s.alt(p.pid, 'Thirdmain', { teamId: bravo, makeMain: true });
  assert.equal(await s.teamOf(third), bravo);
  // A character of the person already holds Charlie: asking for Charlie for another new Main is refused and nothing is written.
  await s.exec(`UPDATE characters SET team_id = '${charlie}' WHERE id = '${p.cid}'`);
  const before = await s.rows('SELECT id, team_id, is_main FROM characters WHERE player_id = ? ORDER BY id', p.pid);
  const refused = await s.call('gm', 'POST', `/roster/${p.pid}/characters`, { teamId: charlie, name: 'Fourthmain', class: 'ROGUE', mainSpec: 'Combat', offSpec: null, makeMain: true });
  assert.deepEqual([refused.status, refused.json.error, refused.json.field], [409, 'team_taken', 'teamId']);
  assert.deepEqual(await s.rows('SELECT id, team_id, is_main FROM characters WHERE player_id = ? ORDER BY id', p.pid), before);
  // No team asked for: a Main on no team.
  const homeless = await s.alt(p.pid, 'Fifthmain', { teamId: undefined, makeMain: true });
  assert.equal(await s.teamOf(homeless), null);
  assert.equal((await s.ok('gm', 'GET', `/roster/${p.pid}`)).person.homeTeam, null, 'the person has no home team now');
  await s.playersInert('add character as the Main');
});

check('the trial dates move with the Main: add as the Main and Make Main carry them to the new Main, alts keep none', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Trialmain', status: 'trial', trialEnd: '2027-02-10' });
  const alt = await s.alt(p.pid, 'Trialalt');
  await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${alt}/main`, {}, 200);
  let rows = await s.rows('SELECT name, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', p.pid);
  assert.deepEqual(rows.map((r) => [r.name, r.trial_start === null, r.trial_end]), [['Trialalt', false, '2027-02-10'], ['Trialmain', true, null]]);
  await s.alt(p.pid, 'Trialnew', { teamId: s.tids[1], makeMain: true });
  rows = await s.rows('SELECT name, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', p.pid);
  assert.deepEqual(rows.map((r) => [r.name, r.trial_start === null, r.trial_end]), [['Trialalt', true, null], ['Trialmain', true, null], ['Trialnew', false, '2027-02-10']]);
  await s.playersInert('trial dates follow the Main');
});

check('every other path that adds an alt: attendance "add as an alt", Battle.net claim, CSV and Raid-Helper-shaped imports all start it on no team', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Pathsmain' });
  // CSV: an alt row names Bravo; it still starts on no team. A new person's Main is on the team asked for.
  const rows = [
    { line: 2, action: 'new', name: 'Csvnew', class: 'WARRIOR', spec: 'Protection', teamId: s.tids[1] },
    { line: 3, action: 'alt', withLine: 2, name: 'Csvnewalt', class: 'MAGE', spec: 'Fire', teamId: s.tids[1] },
    { line: 4, action: 'alt', personId: p.pid, name: 'Csvexalt', class: 'ROGUE', teamId: s.tids[0] },
  ];
  await s.ok('gm', 'POST', '/roster/import/csv/commit', { teamId: s.tids[0], rows }, 201);
  const got = Object.fromEntries((await s.rows('SELECT name, team_id FROM characters')).map((r) => [r.name, r.team_id]));
  assert.deepEqual([got.Csvnew, got.Csvnewalt, got.Csvexalt], [s.tids[1], null, null]);
  // A claim: the claimant already has a person (Pathsmain), the claimed character becomes an alt of it.
  const claimant = await s.member('claimant');
  await s.ok('gm', 'PUT', `/roster/${p.pid}/account`, { userId: claimant }, 200);
  const clid = 'cl_' + 'p'.repeat(22);
  s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
          VALUES ('${clid}', '${s.gid}', '${claimant}', 'Claimedalt', 'claimedalt', 'Nightslayer', 'nightslayer', 'MAGE', 70, 'pending', 1)`);
  await s.ok('gm', 'POST', `/claims/${clid}/approve`, { expectedKind: 'add_alt', teamId: s.tids[1] }, 200);
  assert.equal(await s.teamOf((await s.rows("SELECT id FROM characters WHERE name = 'Claimedalt'"))[0].id), null);
  await s.playersInert('alts from imports and claims');
});

check('attendance "add as an alt": the alt starts on no team; as the Main it takes the raid\'s team and the previous Main steps off it; a character already there refuses', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, , charlie] = s.tids;
  const p = await s.newPerson({ name: 'Logmain' });
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: alpha, raidOn: '2027-01-02' })).raid.id;
  const manual = (name) => s.exec(`INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key)
                                    VALUES ('${raid}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'Nightslayer', 'nightslayer')`);
  for (const name of ['Logalt', 'Logtwo', 'Logthree']) manual(name);
  const link = (key, body) => s.call('gm', 'POST', `/raids/${raid}/unmatched`, { key: `${key}|nightslayer`, action: 'alt', personId: p.pid, class: 'ROGUE', ...body });
  assert.equal((await link('logalt', {})).status, 200);
  assert.equal(await s.teamOf((await s.rows("SELECT id FROM characters WHERE name = 'Logalt'"))[0].id), null, 'an alt linked from a log starts on no team');
  // The raid's team is Alpha and the Main sits on Alpha: the new Main takes Alpha and the old one steps off it.
  assert.equal((await link('logtwo', { makeMain: true })).status, 200);
  const rows = Object.fromEntries((await s.rows('SELECT name, team_id, is_main FROM characters WHERE player_id = ?', p.pid)).map((r) => [r.name, r]));
  assert.deepEqual([rows.Logtwo.team_id, rows.Logtwo.is_main, rows.Logmain.team_id, rows.Logmain.is_main], [alpha, 1, null, 0]);
  // Now an alt of the person sits on Alpha (their Main moved to Charlie) and the raid is Alpha's: a second new Main is refused, nothing changes.
  await s.exec(`UPDATE characters SET team_id = '${charlie}' WHERE name = 'Logtwo'`);
  await s.exec(`UPDATE characters SET team_id = '${alpha}' WHERE name = 'Logalt'`);
  const before = await s.rows('SELECT name, team_id, is_main FROM characters WHERE player_id = ? ORDER BY name', p.pid);
  const refused = await link('logthree', { makeMain: true });
  assert.deepEqual([refused.status, refused.json.error], [409, 'team_taken']);
  assert.deepEqual(await s.rows('SELECT name, team_id, is_main FROM characters WHERE player_id = ? ORDER BY name', p.pid), before);
  await s.playersInert('attendance alt as the Main');
});

// ---------------------------------------------------------------------------
// D1 and the writers for a person or a character on no team

check('D1: an officer creates a person with no team, a Team Lead cannot; notes, edit, account, make main, remove and delete all work for them (no silent no-op)', async () => {
  const s = await scenario();
  const leadId = await s.lead('lead', [s.tids[0]]);
  assert.ok(leadId);
  const refused = await s.call('lead', 'POST', '/roster', { class: 'MAGE', mainSpec: 'Fire', offSpec: null, name: 'Leadmade' });
  assert.equal(refused.status, 403, 'no team: whole-guild roster.edit only');
  const p = await s.newPerson({ name: 'Homeless', teamId: undefined, status: 'trial', trialEnd: '2027-02-10' });
  assert.equal(p.res.person.homeTeam, null);
  assert.equal(await s.teamOf(p.cid), null);
  await s.playersInert('create with no team');
  // The team lead of Alpha does not reach them.
  const asLead = await s.ok('lead', 'GET', `/roster/${p.pid}`);
  assert.deepEqual([asLead.can.edit, asLead.can.notesEdit, asLead.can.delete], [false, false, false]);
  // Every writer, as the officer.
  const patched = await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.version, status: 'reserve' }, 200);
  assert.equal(patched.person.status, 'reserve');
  assert.equal(patched.person.version, 2, 'the write landed (a NULL team must not make the guard match nothing)');
  const noted = await s.ok('gm', 'PUT', `/roster/${p.pid}/notes`, { text: 'Good player', expectedNotesVersion: 0 }, 200);
  assert.equal(noted.notes.text, 'Good player');
  const memberId = await s.member('member');
  const linked = await s.ok('gm', 'PUT', `/roster/${p.pid}/account`, { userId: memberId }, 200);
  assert.equal(linked.person.account.linked, true);
  assert.equal((await s.ok('gm', 'PUT', `/roster/${p.pid}/account`, { userId: null }, 200)).person.account.linked, false);
  const altId = await s.alt(p.pid, 'Homelessalt');
  const edited = await s.ok('gm', 'PATCH', `/roster/${p.pid}/characters/${altId}`, { mainSpec: 'Frost', class: 'MAGE' }, 200);
  assert.equal(edited.characters.find((c) => c.id === altId).mainSpec, 'Frost');
  const swapped = await s.ok('gm', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {}, 200);
  assert.deepEqual(swapped.characters.map((c) => [c.name, c.isMain]), [['Homelessalt', true], ['Homeless', false]]);
  const removed = await s.ok('gm', 'DELETE', `/roster/${p.pid}/characters/${p.cid}`, undefined, 200);
  assert.deepEqual(removed.characters.map((c) => c.name), ['Homelessalt']);
  await s.playersInert('writers on a person with no team');
  await s.ok('gm', 'DELETE', `/roster/${p.pid}`, undefined, 200);
  assert.equal(await s.w.count('players', 'id = ?', p.pid), 0, 'the person is really gone');
});

check('an alt on no team is edited and removed by whoever edits the person\'s home team (made Main only by a whole-guild editor); a person with one is deleted by the home team\'s lead too', async () => {
  const s = await scenario();
  await s.lead('lead', [s.tids[0]]);
  await s.lead('lead2', [s.tids[1]]);
  const p = await s.newPerson({ name: 'Homed' });
  const altId = await s.alt(p.pid, 'Homedalt', {}, 'lead');
  assert.equal(await s.teamOf(altId), null);
  // The lead of the home team reaches the teamless alt; the lead of another team does not.
  assert.equal((await s.call('lead2', 'PATCH', `/roster/${p.pid}/characters/${altId}`, { offSpec: 'Subtlety' })).status, 403);
  assert.equal((await s.call('lead', 'PATCH', `/roster/${p.pid}/characters/${altId}`, { offSpec: 'Subtlety' })).status, 200);
  // Making it the Main would leave the person without a home team (and the lead without the person), so that is for the whole-guild editor (R2 review).
  assert.equal((await s.call('lead', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {})).status, 403);
  assert.equal((await s.call('gm', 'POST', `/roster/${p.pid}/characters/${altId}/main`, {})).status, 200);
  // The alt is the Main now and sits on no team: the person has no home team, so only the whole-guild editor reaches them (the lead of Alpha no longer does).
  assert.equal((await s.call('lead', 'POST', `/roster/${p.pid}/characters/${p.cid}/main`, {})).status, 403);
  assert.equal((await s.call('gm', 'POST', `/roster/${p.pid}/characters/${p.cid}/main`, {})).status, 200, 'and back');
  assert.equal((await s.call('lead2', 'DELETE', `/roster/${p.pid}/characters/${altId}`)).status, 403);
  assert.equal((await s.call('lead', 'DELETE', `/roster/${p.pid}/characters/${altId}`)).status, 200);
  const again = await s.alt(p.pid, 'Homedalttwo', {}, 'lead');
  assert.ok(again);
  const record = await s.ok('lead', 'GET', `/roster/${p.pid}`);
  assert.equal(record.can.delete, true, 'the teamless alt does not stop the home team from deleting the person');
  assert.equal((await s.call('lead2', 'DELETE', `/roster/${p.pid}`)).status, 403);
  assert.equal((await s.call('lead', 'DELETE', `/roster/${p.pid}`)).status, 200);
  assert.equal(await s.w.count('characters', 'player_id = ?', p.pid), 0);
});

check('a Battle.net claim links to a person whose Main is on no team (the link guard matches NULL); only an officer can decide it', async () => {
  const s = await scenario();
  await s.lead('lead', [s.tids[0]]);
  const claimant = await s.member('claimant');
  const p = await s.newPerson({ name: 'Claimedmain', teamId: undefined });
  const clid = 'cl_' + 'k'.repeat(22);
  s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
          VALUES ('${clid}', '${s.gid}', '${claimant}', 'Claimedmain', 'claimedmain', 'Nightslayer', 'nightslayer', 'MAGE', 70, 'pending', 1)`);
  const listed = (await s.ok('gm', 'GET', '/claims')).claims.find((c) => c.id === clid);
  assert.deepEqual([listed.plan.kind, listed.plan.canDecide], ['link_person', true]);
  assert.equal((await s.ok('lead', 'GET', '/claims')).claims.find((c) => c.id === clid).plan.canDecide, false, 'a Team Lead does not reach a person with no team');
  assert.equal((await s.call('lead', 'POST', `/claims/${clid}/approve`, { expectedKind: 'link_person' })).status, 403);
  await s.ok('gm', 'POST', `/claims/${clid}/approve`, { expectedKind: 'link_person' }, 200);
  assert.equal((await s.rows('SELECT user_id FROM players WHERE id = ?', p.pid))[0].user_id, claimant, 'the link was written');
});

// ---------------------------------------------------------------------------
// The interim PATCH status contract and the mirror

check('PATCH status: every character of the person takes the rank (Inactive = Social), a teamless alt too; the players row is not written; Break and Other are refused', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Statusmain', status: 'trial', trialEnd: '2027-02-10' });
  const placed = await s.alt(p.pid, 'Statusplaced');
  await s.exec(`UPDATE characters SET team_id = '${s.tids[1]}' WHERE id = '${placed}'`);
  const teamless = await s.alt(p.pid, 'Statusless');
  const ranks = async () => Object.fromEntries((await s.rows('SELECT name, core_rank, left_on, left_reason, trial_start, trial_end FROM characters WHERE player_id = ?', p.pid)).map((r) => [r.name, r]));
  assert.deepEqual(Object.values(await ranks()).map((r) => r.core_rank), ['trial', 'trial', 'trial']);
  let version = p.version;
  const patch = async (body) => { const res = await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: version, ...body }, 200); version = res.person.version; return res; };
  await patch({ status: 'inactive', leftReason: 'left', leftOn: '2027-01-10' });
  let got = await ranks();
  assert.deepEqual(Object.values(got).map((r) => [r.core_rank, r.left_on, r.left_reason, r.trial_start, r.trial_end]), [['social', '2027-01-10', 'left', null, null], ['social', '2027-01-10', 'left', null, null], ['social', '2027-01-10', 'left', null, null]]);
  assert.deepEqual(await s.rows('SELECT status, left_on, left_reason FROM players WHERE id = ?', p.pid), [{ status: 'raider', left_on: null, left_reason: null }], 'the players row keeps its placeholder');
  await s.playersInert('inactive, left');
  // Break and Other are refused (U B2-Q1): nothing changes on either side.
  for (const reason of ['break', 'other']) {
    const refused = await s.call('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: version, leftReason: reason, leftOn: '2027-01-11' });
    assert.equal(refused.status, 400, reason);
    assert.equal(refused.json.field, 'leftReason', reason);
  }
  assert.deepEqual(await s.rows('SELECT DISTINCT left_on, left_reason FROM characters WHERE player_id = ?', p.pid), [{ left_on: '2027-01-10', left_reason: 'left' }]);
  await s.playersInert('Break and Other refused');
  // A Break stored before the decision (no character carries it any more) -> Kicked with no date: a leaving needs one, it starts today.
  await s.exec(`UPDATE characters SET left_on = NULL, left_reason = NULL WHERE player_id = '${p.pid}'`);
  await s.playersInert('inactive, an old break');
  const kicked = await patch({ leftReason: 'kicked' });
  assert.deepEqual([kicked.person.leftOn, kicked.person.leftReason], [kicked.today, 'kicked']);
  await s.playersInert('break to kicked');
  await patch({ status: 'trial', trialStart: '2027-01-02', trialEnd: '2027-01-30' });
  got = await ranks();
  assert.deepEqual([got.Statusmain, got.Statusplaced, got.Statusless].map((r) => [r.core_rank, r.trial_start, r.trial_end]), [['trial', '2027-01-02', '2027-01-30'], ['trial', null, null], ['trial', null, null]]);
  await patch({ status: 'raider' });
  assert.deepEqual(Object.values(await ranks()).map((r) => [r.core_rank, r.trial_start, r.trial_end]), [['raider', null, null], ['raider', null, null], ['raider', null, null]]);
  await s.playersInert('raider');
  // A stale version changes neither side.
  const stale = await s.call('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: 1, status: 'inactive' });
  assert.equal(stale.status, 409);
  assert.equal((await ranks()).Statusmain.core_rank, 'raider');
  await s.playersInert('stale patch');
  assert.ok(teamless);
});

check('a new alt of an Inactive person takes the Social rank and the left date of the Main in the same statement', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Leftmain' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.version, status: 'inactive', leftReason: 'kicked', leftOn: '2027-01-05' }, 200);
  await s.alt(p.pid, 'Leftalt');
  const alt = (await s.rows("SELECT core_rank, left_on, left_reason, trial_start FROM characters WHERE name = 'Leftalt'"))[0];
  assert.deepEqual(alt, { core_rank: 'social', left_on: '2027-01-05', left_reason: 'kicked', trial_start: null });
  await s.playersInert('alt of a Former person');
});

// ---------------------------------------------------------------------------
// patchCharacter

check('patchCharacter: a Battle.net-bound character keeps its name and class, everything else is editable; an unbound one is unchanged', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Boundmain' });
  const free = await s.alt(p.pid, 'Freealt');
  s.exec(`UPDATE characters SET namespace = 'profile-classicann-us', blizzard_realm_id = 4001, blizzard_char_id = 9001 WHERE id = '${p.cid}'`);
  const patch = (cid, body) => s.call('gm', 'PATCH', `/roster/${p.pid}/characters/${cid}`, body);
  const renamed = await patch(p.cid, { name: 'Renamedmain' });
  assert.deepEqual([renamed.status, renamed.json.field], [400, 'name']);
  const reclassed = await patch(p.cid, { class: 'PRIEST', mainSpec: 'Holy', offSpec: null });
  assert.deepEqual([reclassed.status, reclassed.json.field], [400, 'class']);
  assert.deepEqual((await s.rows("SELECT name, class FROM characters WHERE id = ?", p.cid))[0], { name: 'Boundmain', class: 'MAGE' }, 'nothing changed');
  const same = await patch(p.cid, { name: 'Boundmain', class: 'MAGE', mainSpec: 'Frost', offSpec: 'Arcane' });
  assert.equal(same.status, 200, 'the form sends name and class back unchanged: that is fine');
  assert.deepEqual((await s.rows('SELECT main_spec, off_spec FROM characters WHERE id = ?', p.cid))[0], { main_spec: 'Frost', off_spec: 'Arcane' });
  assert.equal((await patch(free, { name: 'Renamedfree', class: 'PRIEST', mainSpec: 'Holy', offSpec: null })).status, 200, 'an unbound character is unchanged');
});

check('patchCharacter: a character on no team is never placed by it; a placed one moves, but never onto a team the person already holds', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  const p = await s.newPerson({ name: 'Placemain' });
  const altId = await s.alt(p.pid, 'Placealt');
  const patch = (cid, body) => s.call('gm', 'PATCH', `/roster/${p.pid}/characters/${cid}`, body);
  const sent = await patch(altId, { teamId: bravo, mainSpec: 'Assassination' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(await s.teamOf(altId), null, 'still on no team');
  assert.equal(sent.json.characters.find((c) => c.id === altId).mainSpec, 'Assassination', 'the rest of the edit was applied');
  assert.equal((await patch(altId, { teamId: bravo })).status, 200, 'a teamId alone changes nothing for a character on no team');
  assert.equal(await s.teamOf(altId), null);
  // A placed character moves between teams the person does not hold.
  await s.exec(`UPDATE characters SET team_id = '${bravo}' WHERE id = '${altId}'`);
  const taken = await patch(altId, { teamId: alpha });
  assert.deepEqual([taken.status, taken.json.error, taken.json.field], [409, 'team_taken', 'teamId'], 'the Main is on Alpha');
  const moved = await patch(altId, { teamId: charlie });
  assert.equal(moved.status, 200);
  assert.equal(await s.teamOf(altId), charlie);
  await s.playersInert('character moves');
});

// ---------------------------------------------------------------------------
// U R4-Q1: a team member signs up any of their characters

// A member (erin-like) with a Main on Alpha, an alt on no team and an alt on Bravo; a raid of Alpha in the future.
async function signupWorld() {
  const s = await scenario();
  const memberId = await s.member('member');
  const p = await s.newPerson({ name: 'Signmain', linkUserId: memberId, class: 'PRIEST', mainSpec: 'Holy' });
  const teamless = await s.alt(p.pid, 'Signteamless');
  const onBravo = await s.alt(p.pid, 'Signbravo');
  await s.exec(`UPDATE characters SET team_id = '${s.tids[1]}' WHERE id = '${onBravo}'`);
  const raid = await s.ok('gm', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2027-01-30', startTime: '20:00' });
  return { s, p, memberId, teamless, onBravo, raidId: raid.raid.id, startsAt: raid.raid.startsAt };
}

check('sign-up: a team member signs up a character on no team and one on another team for their own team\'s raid; the sign-up lists them all', async () => {
  const { s, p, teamless, onBravo, raidId } = await signupWorld();
  const view = await s.ok('member', 'GET', `/raids/${raidId}/signups`);
  assert.deepEqual(view.me.characters.map((c) => c.name), ['Signmain', 'Signbravo', 'Signteamless'], 'every character, the Main first');
  for (const [characterId, name] of [[teamless, 'Signteamless'], [onBravo, 'Signbravo']]) {
    const put = await s.ok('member', 'PUT', `/raids/${raidId}/signup`, { kind: 'signed', characterId }, 200);
    assert.equal(put.entries.find((e) => e.isMe).name, name);
    assert.equal((await s.rows("SELECT character_id, player_id FROM raid_signups WHERE source = 'raidsmith'"))[0].character_id, characterId);
  }
  const bad = await s.call('member', 'PUT', `/raids/${raidId}/signup`, { kind: 'signed', characterId: 'c_AAAAAAAAAAAAAAAAAAAAAA' });
  assert.deepEqual([bad.status, bad.json.field], [400, 'characterId']);
  const other = await s.newPerson({ name: 'Strangermain' });
  const stranger = await s.call('member', 'PUT', `/raids/${raidId}/signup`, { kind: 'signed', characterId: other.cid });
  assert.deepEqual([stranger.status, stranger.json.field], [400, 'characterId'], 'someone else\'s character is still refused');
  assert.ok(p);
});

check('sign-up: the attendance of a raid goes to the person, whichever of their characters signed up and was logged', async () => {
  const { s, p, teamless, raidId } = await signupWorld();
  await s.ok('member', 'PUT', `/raids/${raidId}/signup`, { kind: 'signed', characterId: teamless }, 200);
  // The raid is over: a log with the teamless alt in it (the Main is not).
  const startsAt = Date.parse('2027-01-31T01:00:00Z');
  s.exec(`UPDATE raids SET starts_at = ${startsAt}, raid_on = '2027-01-30' WHERE id = '${raidId}'`);
  s.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${raidId}', '${s.gid}', 'code000000000001', 'www', ${startsAt}, 1)`);
  for (const [pullId, offset] of [[91, 0], [92, 600000]]) {
    s.exec(`INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at)
            VALUES (${pullId}, '${raidId}', 'code000000000001', ${pullId}, 1, 'Boss', 0, ${startsAt + offset}, ${startsAt + offset + 1000})`);
    s.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (${pullId}, '${raidId}', '${s.gid}', 'Signteamless', 'signteamless', 'Nightslayer', 'nightslayer', 'ROGUE')`);
  }
  s.w.clock.now = startsAt + 6 * 3600 * 1000;
  const { recomputeRaid } = await load('worker/attendance-store.js');
  const guild = (await s.rows('SELECT id, region, game_version, time_zone FROM guilds WHERE id = ?', s.gid))[0];
  await recomputeRaid({ db: s.w.db, now: () => s.w.clock.now }, guild, raidId);
  const rows = await s.rows('SELECT player_id, team_id, outcome, credit, attended FROM attendance WHERE raid_id = ?', raidId);
  assert.deepEqual(rows, [{ player_id: p.pid, team_id: s.tids[0], outcome: 'present', credit: 1, attended: 1 }], 'one row, for the person, on the raid\'s team, present');
});

check('standing sign-up: the characters offered are all of the person\'s; one on no team is accepted and the sign-ups it makes use it; a person off the roster gets nothing', async () => {
  const { s, p, teamless } = await signupWorld();
  const slot = { weekday: 6, startTime: '20:00' };
  await s.ok('gm', 'PUT', `/teams/${s.tids[0]}/schedule`, { slots: [slot], weeks: 2 }, 200);
  const listed = await s.ok('member', 'GET', '/standing');
  const alpha = listed.teams.find((t) => t.teamId === s.tids[0]);
  assert.deepEqual(alpha.characters.map((c) => c.name), ['Signmain', 'Signbravo', 'Signteamless']);
  assert.equal(listed.teams.some((t) => t.teamId === s.tids[1]), false, 'the other team has no roster character of hers (Signbravo is the alt there, not a roster... but Bravo has no schedule)');
  const put = await s.ok('member', 'PUT', `/teams/${s.tids[0]}/standing`, { slots: [{ weekday: 6, kind: 'signed', characterId: teamless }] }, 200);
  assert.deepEqual(put.mine, [{ weekday: 6, kind: 'signed', characterId: teamless }]);
  await s.ok('gm', 'POST', `/teams/${s.tids[0]}/schedule/raids`, { weeks: 2 }, 200);
  const made = await s.rows("SELECT character_id, standing FROM raid_signups WHERE source = 'raidsmith' AND standing = 1");
  assert.ok(made.length >= 1, 'the schedule fill made standing sign-ups');
  assert.ok(made.every((row) => row.character_id === teamless));
  // The pure rule: any of the person's characters; usable only while one of them is on the team's roster.
  const standing = await load('worker/standing.js');
  const rows = [
    { id: 'cMain', team_id: 'tA', name: 'M', is_main: 1, core_rank: 'raider', left_on: null },
    { id: 'cAlt', team_id: null, name: 'A', is_main: 0, core_rank: 'raider', left_on: null },
    { id: 'cOther', team_id: 'tB', name: 'B', is_main: 0, core_rank: 'raider', left_on: null },
  ];
  assert.equal(standing.standingCharacter({ characterId: 'cAlt' }, 'tA', rows).id, 'cAlt');
  assert.equal(standing.standingCharacter({ characterId: 'cOther' }, 'tA', rows).id, 'cOther');
  assert.equal(standing.standingCharacter({ characterId: null }, 'tA', rows).id, 'cMain');
  assert.equal(standing.standingCharacter({ characterId: 'nope' }, 'tA', rows).id, 'cMain', 'a chosen character that is gone falls back to the usual one');
  const plan = (characters) => standing.planStanding({
    entries: [{ teamId: 'tA', personId: 'p1', weekday: 6, kind: 'signed', characterId: 'cAlt' }],
    raids: [{ id: 'r1', teamId: 'tA', raidOn: '2027-01-30' }], signups: [], notices: [], characters: new Map([['p1', characters]]),
  });
  assert.deepEqual(plan(rows).creates.map((c) => [c.raidId, c.characterId]), [['r1', 'cAlt']]);
  assert.deepEqual(plan(rows.map((r) => (r.id === 'cMain' ? { ...r, core_rank: 'social' } : r))).creates, [], 'the Main on tA is Social: nobody of hers is on the roster of tA');
  assert.deepEqual(plan(rows.filter((r) => r.id !== 'cMain')).creates, [], 'no character on tA at all');
  assert.ok(p);
});

// ---------------------------------------------------------------------------
// D7, the Teams page, the trial review, CSV, the Battle.net import

check('D7: the guild export carries teamId null for a character on no team, and the API roster feed lists only characters on a team roster', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Feedmain' });
  await s.alt(p.pid, 'Feedalt');
  const file = await s.ok('gm', 'GET', '/export');
  const entry = file.people.find((x) => x.id === p.pid);
  assert.deepEqual(entry.characters.map((c) => [c.name, c.teamId]), [['Feedmain', s.tids[0]], ['Feedalt', null]]);
  assert.deepEqual([entry.status, entry.leftOn], ['raider', null]);
  const key = (await s.ok('gm', 'POST', '/api-keys', { name: 'Sheet', datasets: ['roster'], expiresIn: '30d' })).created.token;
  const feed = await s.w.call({}, 'GET', '/api/v1/roster.json', undefined, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(feed.status, 200, feed.text);
  assert.deepEqual(feed.json.rows.map((row) => row.character), ['Feedmain']);
});

check('the Teams page counts people with a character on the team\'s roster: a Social main, a Former main and a teamless alt do not count', async () => {
  const s = await scenario();
  const live = await s.newPerson({ name: 'Livemain' });
  await s.alt(live.pid, 'Livealt');
  const social = await s.newPerson({ name: 'Socialmain' });
  await s.ok('gm', 'PATCH', `/roster/${social.pid}`, { expectedVersion: social.version, status: 'inactive' }, 200);
  const former = await s.newPerson({ name: 'Formermain' });
  await s.ok('gm', 'PATCH', `/roster/${former.pid}`, { expectedVersion: former.version, status: 'inactive', leftReason: 'left', leftOn: '2027-01-02' }, 200);
  const lonely = await s.newPerson({ name: 'Lonelymain', teamId: undefined });
  assert.ok(lonely);
  const payload = await s.ok('gm', 'GET', '');
  assert.deepEqual(payload.teams.map((t) => [t.name, t.players]), [['Alpha', 1], ['Bravo', 0]]);
});

check('the trial review reads the person\'s Trial character on its own team: a Raider main on A with a Trial alt on B is reviewed on B', async () => {
  const s = await scenario();
  await s.lead('lead', [s.tids[0]]);
  await s.lead('lead2', [s.tids[1]]);
  const p = await s.newPerson({ name: 'Reviewmain', joinedOn: '2026-12-01' });
  const alt = await s.alt(p.pid, 'Reviewalt');
  s.exec(`UPDATE characters SET team_id = '${s.tids[1]}', core_rank = 'trial', trial_start = '2027-01-05', trial_end = '2027-01-19' WHERE id = '${alt}'`);
  const card = await s.ok('gm', 'GET', `/roster/${p.pid}/trial`);
  assert.deepEqual([card.person.status, card.person.trialStart, card.person.trialEnd, card.since], ['trial', '2027-01-05', '2027-01-19', '2027-01-05']);
  assert.equal(card.attendance.team.id, s.tids[1], 'the review is about Bravo');
  const bravoLead = await s.ok('lead2', 'GET', `/roster/${p.pid}/trial`);
  assert.equal(bravoLead.attendance.team.id, s.tids[1], 'a lead of Bravo reads the Bravo card');
  assert.deepEqual([bravoLead.person.status, bravoLead.person.trialEnd], ['trial', '2027-01-19']);
  // The lead of Alpha may edit the person (the Main is on Alpha) but not Bravo's trial: they get the Alpha card, the person is a Raider there.
  const alphaLead = await s.ok('lead', 'GET', `/roster/${p.pid}/trial`);
  assert.deepEqual([alphaLead.person.status, alphaLead.person.trialEnd, alphaLead.since], ['raider', null, '2026-12-01']);
});

check('CSV import: a row that says social becomes a Social person (status inactive, core_rank social), on no roster; the preview says so', async () => {
  const s = await scenario();
  const csv = 'name,class,spec,team,main/alt,status\nSocialone,Mage,Fire,Alpha,main,social\nRaiderone,Mage,Fire,Alpha,main,raider\nBogus,Mage,Fire,Alpha,main,gold';
  const preview = await s.ok('gm', 'POST', '/roster/import/csv/preview', { teamId: s.tids[0], text: csv }, 200);
  const byName = Object.fromEntries(preview.rows.map((row) => [row.name, row]));
  assert.equal(byName.Socialone.status, 'inactive');
  assert.deepEqual(byName.Socialone.problems, []);
  assert.match(byName.Bogus.problems[0], /Raider, Trial, Reserve or Social/);
  const rows = [
    { line: 2, action: 'new', name: 'Socialone', class: 'MAGE', spec: 'Fire', teamId: s.tids[0], status: 'inactive' },
    { line: 3, action: 'new', name: 'Raiderone', class: 'MAGE', spec: 'Fire', teamId: s.tids[0], status: 'raider' },
  ];
  await s.ok('gm', 'POST', '/roster/import/csv/commit', { teamId: s.tids[0], rows }, 201);
  const got = Object.fromEntries((await s.rows('SELECT name, core_rank FROM characters')).map((r) => [r.name, r]));
  assert.deepEqual([got.Socialone.core_rank, got.Raiderone.core_rank], ['social', 'raider']);
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.tids[0]}`)).people.map((x) => x.shown.name), ['Raiderone'], 'Social is on no team roster');
  const refused = await s.call('gm', 'POST', '/roster/import/csv/commit', { teamId: s.tids[0], rows: [{ line: 2, action: 'new', name: 'Badstatus', class: 'MAGE', teamId: s.tids[0], status: 'gone' }] });
  assert.deepEqual([refused.status, refused.json.field], [400, 'status']);
  await s.playersInert('csv social');
});

check('the shared helpers: personFields works from the characters whatever their order; rosterRankOnTeam and the person status read the main', async () => {
  const rank = await load('worker/person-rank.js');
  const chars = [
    { id: 'c2', teamId: null, isMain: false, coreRank: 'social', leftOn: '2027-01-02', leftReason: 'left', trialStart: null, trialEnd: null },
    { id: 'c1', teamId: 't1', isMain: true, coreRank: 'trial', leftOn: null, leftReason: null, trialStart: '2027-01-01', trialEnd: '2027-01-15' },
  ];
  for (const order of [chars, [...chars].reverse()]) {
    assert.deepEqual(rank.personFields({ characters: order }), { status: 'trial', trialStart: '2027-01-01', trialEnd: '2027-01-15', leftOn: null, leftReason: null });
  }
  const gone = chars.map((c) => ({ ...c, coreRank: 'social', leftOn: '2027-01-02', leftReason: 'kicked', trialStart: null, trialEnd: null }));
  assert.deepEqual(rank.personFields({ characters: gone }), { status: 'inactive', trialStart: null, trialEnd: null, leftOn: '2027-01-02', leftReason: 'kicked' });
  assert.deepEqual(rank.personFields({ characters: [] }), { status: 'inactive', trialStart: null, trialEnd: null, leftOn: null, leftReason: null });
  assert.equal(pathToFileURL(ROOT).href.length > 0, true);
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
