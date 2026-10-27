/**
 * Raidsmith guild tracker - readers that tolerate a character without a team (user-hierarchy build, lane B1a-1)
 * Run: node tests/guild/guild-null-team-tests.js
 *
 * Migration 0030 made characters.team_id nullable; lane B2 makes new alts teamless. These checks make a character teamless by hand (UPDATE characters SET
 * team_id = NULL; a composite foreign key is not enforced when one column is NULL) and read the Worker's answers:
 *   - ownTeamIds drops NULL: a teamless character grants no team scope (own_teams), a placed one still does;
 *   - the person record, the roster rows, the person attendance and loot pages, the guild payload's flags, the export and the Home attention list
 *     answer 200 with the teamless character in the right place (or left out where a team roster is meant), never as a team called null.
 * The writers that must work for a character on no team (patch character, delete person, make main, ...) are exercised in guild-b2-writers-tests.js.
 */
const assert = require('node:assert/strict');
const { ownPerson } = require('../guild-owner-fixture');
const { load, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000051';
const person = (n, name) => ({ id: `1100000000000000${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(71, 'Gmnull'), member: person(72, 'Membernull'), lead: person(73, 'Leadnull') };
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario() {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Null Team', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
    multipleTeams: true, teamNames: ['Alpha', 'Bravo'],
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
    async member(key) {
      jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      return uids[key];
    },
    async newPerson(body) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null, ...body });
      if (body && body.linkUserId) ownPerson(w.db.sqlite, res.person.id, body.linkUserId); // the account owns it (players.user_id): linkUserId only records the Discord ID since the identity split
      return { pid: res.person.id, cid: res.characters[0].id, version: res.person.version, today: res.today };
    },
    // A new alt starts on no team (lane B2); the team routes that place it come with B3, so a test that wants it placed (teamId given, or the first team) does it
    // with the column itself, as long as the person has no character on that team yet (one per person per team).
    async addCharacter(pid, body) {
      const res = await s.ok('gm', 'POST', `/roster/${pid}/characters`, { teamId: tids[0], class: 'ROGUE', mainSpec: 'Combat', offSpec: null, ...body });
      const id = res.characters.find((c) => c.name === body.name).id;
      const teamId = body.teamId === undefined ? tids[0] : body.teamId;
      w.db.sqlite.exec(`UPDATE characters SET team_id = '${teamId}' WHERE id = '${id}'
                        AND NOT EXISTS (SELECT 1 FROM characters o WHERE o.player_id = '${pid}' AND o.team_id = '${teamId}')`);
      return id;
    },
    teamless: (characterId) => w.db.sqlite.exec(`UPDATE characters SET team_id = NULL WHERE id = '${characterId}'`),
    exec: (sql) => w.db.sqlite.exec(sql),
    async me(who) { return (await s.ok(who, 'GET', '')).me; },
  };
  return s;
}

check('ownTeamIds: a teamless character grants no team scope; a placed one does; the pure resolver drops NULL too', async () => {
  const { resolvePermissions, allows, isGranted } = await load('worker/permissions.js');
  const rows = [{ role_id: 'member', action: 'attendance.view', scope: 'own_teams' }];
  const can = resolvePermissions([], rows, [null, 't_a', null]).can;
  assert.deepEqual(can, { 'attendance.view': ['t_a'] });
  assert.equal(allows(can, 'attendance.view', null), false, 'null is never one of the teams');
  const none = resolvePermissions([], rows, [null]).can;
  assert.equal(isGranted(none['attendance.view']), false);
  assert.equal(allows(none, 'attendance.view', null), false);

  const s = await scenario();
  const memberId = await s.member('member');
  const p = await s.newPerson({ name: 'Ownmain', linkUserId: memberId });
  const before = await s.me('member');
  assert.deepEqual([before.can['attendance.view'], before.can['loot.view'], before.can['signups.self']], [[s.tids[0]], [s.tids[0]], [s.tids[0]]]);
  assert.deepEqual(before.teamIds, [s.tids[0]]);

  s.teamless(p.cid);
  const teamless = await s.me('member');
  for (const action of ['attendance.view', 'loot.view', 'signups.self']) assert.equal(isGranted(teamless.can[action]), false, `${action}: a teamless character grants nothing`);
  assert.deepEqual(teamless.teamIds, []);

  await s.addCharacter(p.pid, { name: 'Ownplaced', teamId: s.tids[1] });
  const placed = await s.me('member');
  for (const action of ['attendance.view', 'loot.view', 'signups.self']) assert.deepEqual(placed.can[action], [s.tids[1]], `${action}: the placed character still does`);
  assert.deepEqual(placed.teamIds, [s.tids[1]]);
  assert.equal(allows(placed.can, 'attendance.view', null), false);
});

check('the person record and the roster rows keep a teamless alt (LEFT JOIN teams), with team { id: null }', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Mainwith' });
  const altId = await s.addCharacter(p.pid, { name: 'Altwithout' });
  s.teamless(altId);
  const record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  assert.deepEqual(record.characters.map((c) => c.name), ['Mainwith', 'Altwithout']);
  const alt = record.characters.find((c) => c.name === 'Altwithout');
  assert.deepEqual(alt.team, { id: null, name: null, archived: false });
  assert.deepEqual([record.person.homeTeam.id, record.can.edit, record.can.delete], [s.tids[0], true, true]);

  const roster = await s.ok('gm', 'GET', `/roster?team=${s.tids[0]}`);
  const row = roster.people.find((x) => x.id === p.pid);
  assert.deepEqual([row.altCount, row.names, row.main.team.id], [1, ['Mainwith'], s.tids[0]], 'the teamless alt counts as an alt but is not on the team');

  // A team lead of Alpha may edit the person (the main is on Alpha) and delete them: the character on no team is covered by the person's home team.
  const leadId = await s.member('lead');
  await s.ok('gm', 'PUT', `/people/${leadId}/roles`, { officer: false, teamLeadTeamIds: [s.tids[0]] }, 200);
  const asLead = await s.ok('lead', 'GET', `/roster/${p.pid}`);
  assert.deepEqual([asLead.can.edit, asLead.can.delete], [true, true]);
});

check('a main without a team: the person has no home team, the whole-guild editor still reaches them, a team lead does not', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Homeless', status: 'trial', trialEnd: '2027-02-10' });
  await s.addCharacter(p.pid, { name: 'Placedalt', teamId: s.tids[1] });
  s.teamless(p.cid);
  const record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  assert.equal(record.person.homeTeam, null);
  assert.deepEqual([record.can.edit, record.can.notesView, record.can.delete], [true, true, true], 'guild-wide scope covers a person without a team');
  const leadId = await s.member('lead');
  await s.ok('gm', 'PUT', `/people/${leadId}/roles`, { officer: false, teamLeadTeamIds: [s.tids[1]] }, 200);
  const asLead = await s.ok('lead', 'GET', `/roster/${p.pid}`);
  assert.deepEqual([asLead.can.edit, asLead.can.notesView, asLead.can.delete], [false, false, false], 'the alt on Bravo does not make a Bravo lead the person\'s editor');
  // The roster of Bravo lists the person (an alt is there); the nav flags and the guild payload do not throw on a trial whose main has no team.
  const roster = await s.ok('gm', 'GET', `/roster?team=${s.tids[1]}`);
  assert.equal(roster.people.length, 1);
  const payload = await s.ok('gm', 'GET', '');
  assert.deepEqual(Object.keys(payload.rosterFlags).sort(), [...s.tids].sort());
  assert(!('null' in payload.rosterFlags));
  assert.deepEqual(payload.teams.map((t) => t.players), [0, 1], 'the main is on no team, the alt is on Bravo');
  assert.equal((await s.call('gm', 'GET', '/attention')).status, 200, 'Home attention');
});

check('person attendance and person loot: a teamless alt adds no team page and no access', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Pagesmain' });
  const altId = await s.addCharacter(p.pid, { name: 'Pagesalt' });
  s.teamless(altId);
  const attendance = await s.ok('gm', 'GET', `/attendance/person/${p.pid}`);
  assert.deepEqual(attendance.teams.map((t) => t.team.id), [s.tids[0]]);
  const loot = await s.call('gm', 'GET', `/loot/person/${p.pid}`);
  assert.equal(loot.status, 200);
  // A person with only teamless characters has no team to show anywhere: no team page, so the whole-guild viewer is refused rather than shown a "null" team.
  const lonely = await s.newPerson({ name: 'Lonelymain' });
  s.teamless(lonely.cid);
  const none = await s.call('gm', 'GET', `/attendance/person/${lonely.pid}`);
  assert.equal(none.status, 403);
  const noneLoot = await s.call('gm', 'GET', `/loot/person/${lonely.pid}`);
  assert.equal(noneLoot.status, 403);
});

check('the guild export reads the notes of a person whose main has no team for whoever may read them guild-wide, and the legacy fields still export', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Exportnull', status: 'trial', trialEnd: '2027-02-10' });
  await s.ok('gm', 'PUT', `/roster/${p.pid}/notes`, { text: 'Good player', expectedNotesVersion: 0 }, 200);
  s.teamless(p.cid);
  // (Leaving a team ends a Trial's dates, migration 0040: a teamless Trial carries the dates an officer types.)
  s.exec(`UPDATE characters SET trial_start = '2027-01-12', trial_end = '2027-02-10' WHERE id = '${p.cid}'`);
  const file = await s.ok('gm', 'GET', '/export');
  const entry = file.people.find((x) => x.id === p.pid);
  assert.equal(entry.notes, 'Good player');
  assert.deepEqual([entry.status, entry.trialStart !== null, entry.trialEnd], ['trial', true, '2027-02-10']);
  assert.equal(entry.characters[0].teamId, null);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 7).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
