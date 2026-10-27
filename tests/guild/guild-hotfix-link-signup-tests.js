/**
 * Raidsmith guild tracker - hotfix: linking a Raid-Helper sign-up that gives a person a Discord ID (security review B3, finding M3)
 * Run: node tests/guild/guild-hotfix-link-signup-tests.js
 *
 * POST /api/guild/:gid/raids/:rid/signups/link authorized on the RAID's team only and had no Seniority check, so a Team Lead could give any person of the
 * guild (the Guild Master, an Officer, someone on another team) the Discord ID of a sign-up; the holder of that Discord account then owns the person's record.
 * Now, when the link gives the person a Discord ID:
 *   - roster.edit on the PERSON's home team (the Main's team) is needed, not only the raid's team;
 *   - the Seniority guard (worker/seniority.js) holds, in the pre-check and again INSIDE the batch (the players UPDATE, the sign-up rows, the audit row);
 *   - a relink the batch stopped answers 409 and changes nothing about the person.
 * A link that gives no Discord ID (the person has it already, or the sign-up carries none) keeps the old rule: the raid's team alone decides.
 * The guild is built through the API, like the other Worker suites (tests/guild-world.js).
 */
const assert = require('node:assert/strict');
const { ownPerson } = require('../guild-owner-fixture');
const { adminOf, load, makeWorld, memberOf, signIn } = require('../guild-world');

const SERVER = '900000000000000071';
const STEP = 2000;
const KEYS = ['gm'];
const discord = (key, name) => {
  if (!KEYS.includes(key)) KEYS.push(key);
  return { id: `11000000000007${String(KEYS.indexOf(key) + 1).padStart(4, '0')}`, username: name.toLowerCase(), globalName: name };
};

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Alpha and Bravo; the Guild Master, two Officers, a Team Lead of Alpha and a Member each own a roster person (Alpha, except the second Officer on Bravo),
// and Bravo has one more person with no account; the raid is Alpha's.
async function world() {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, discord('gm', 'Gmhotfix'), [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Hotfix link', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'],
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const [alpha, bravo] = made.json.teams.map((team) => team.id);
  const uids = { gm: (await w.call(jars.gm, 'GET', '/auth/me')).json.user.id };
  const s = {
    w, gid, alpha, bravo, uids, people: {},
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, `/api/guild/${gid}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    async fail(who, method, tail, body, status, error) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status, `${who} ${method} ${tail} answered ${res.status}: ${res.text}`);
      assert.equal(res.json && res.json.error, error, `${who} ${method} ${tail}: ${res.text}`);
    },
    one: async (sql, ...values) => (await w.rows(sql, ...values))[0],
    exec: (sql) => w.db.sqlite.exec(sql),
    async account(key, name, roles) {
      jars[key] = (await signIn(w, discord(key, name), [memberOf(SERVER)])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      if (roles) await s.ok('gm', 'PUT', `/people/${uids[key]}/roles`, roles, 200);
    },
    // A roster person with a Main on `teamId`; with `key`, the person is the account's own (players.user_id).
    async person(name, teamId, key) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId, class: 'MAGE', mainSpec: 'Fire', offSpec: null, name });
      const pid = res.person.id;
      if (key) ownPerson(w.db.sqlite, pid, uids[key]); // players.user_id (the Link account route only records a Discord ID since the identity split)
      return pid;
    },
  };
  await s.account('o1', 'Officerone', { officer: true, teamLeadTeamIds: [] });
  await s.account('o2', 'Officertwo', { officer: true, teamLeadTeamIds: [] });
  await s.account('tl', 'Leadone', { officer: false, teamLeadTeamIds: [alpha] });
  await s.account('m1', 'Memberone');
  s.people.gm = await s.person('Gmperson', alpha, 'gm');
  s.people.o1 = await s.person('Officerpers', alpha, 'o1');
  s.people.o2 = await s.person('Officertwop', bravo, 'o2');
  s.people.tl = await s.person('Leadperson', alpha, 'tl');
  s.people.m1 = await s.person('Memberpers', alpha, 'm1');
  s.people.bravo = await s.person('Bravopers', bravo);
  s.raid = (await s.ok('tl', 'POST', '/raids', { teamId: alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  s.signup = (id, discordId) => s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id)
    VALUES ('${s.raid}', 'raid_helper', ${id}, ${discordId ? `'${discordId}'` : 'NULL'}, 'Attacker${id}', 'signed', 'Mage', 'Fire', ${id}, '${gid}')`);
  s.link = (who, signupId, personId) => s.call(who, 'POST', `/raids/${s.raid}/signups/link`, { signupId, personId });
  s.discordOf = async (pid) => (await s.one('SELECT discord_user_id FROM players WHERE id = ?', pid)).discord_user_id;
  s.linkedTo = async (signupId) => (await s.one('SELECT player_id FROM raid_signups WHERE raid_id = ? AND signup_id = ?', s.raid, signupId)).player_id;
  s.linkAudits = async () => (await w.rows("SELECT id FROM audit_log WHERE action = 'signup.link'")).length;
  return s;
}

const DISCORD = (n) => `55500055500055${String(n).padStart(4, '0')}`;

check('a Team Lead of the raid\'s team cannot give the Guild Master\'s or an Officer\'s person a Discord ID: 403 seniority, nothing changes', async () => {
  const s = await world();
  s.signup(1, DISCORD(1));
  s.signup(2, DISCORD(2));
  const before = await s.one('SELECT version, updated_at FROM players WHERE id = ?', s.people.gm);
  await s.fail('tl', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 1, personId: s.people.gm }, 403, 'seniority');
  await s.fail('tl', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 2, personId: s.people.o1 }, 403, 'seniority');
  assert.deepEqual(await s.one('SELECT version, updated_at FROM players WHERE id = ?', s.people.gm), before);
  assert.equal(await s.discordOf(s.people.gm), null);
  assert.equal(await s.discordOf(s.people.o1), null);
  assert.equal(await s.linkedTo(1), null);
  assert.equal(await s.linkedTo(2), null);
  assert.equal(await s.linkAudits(), 0, 'a refused link leaves no audit row');
});

check('a Team Lead cannot give a person on another team a Discord ID, even for the lead\'s own raid: 403 forbidden, nothing changes', async () => {
  const s = await world();
  s.signup(1, DISCORD(1));
  await s.fail('tl', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 1, personId: s.people.bravo }, 403, 'forbidden');
  assert.equal(await s.discordOf(s.people.bravo), null);
  assert.equal(await s.linkedTo(1), null);
  assert.equal(await s.linkAudits(), 0);
});

check('a Team Lead links a Member of their own team, and their own person; an Officer links a Member on any team, and the Guild Master any Officer', async () => {
  const s = await world();
  for (const n of [1, 2, 3, 4, 5]) s.signup(n, DISCORD(n));
  assert.equal((await s.link('tl', 1, s.people.m1)).status, 200);
  assert.deepEqual([await s.discordOf(s.people.m1), await s.linkedTo(1)], [DISCORD(1), s.people.m1]);
  assert.equal((await s.link('tl', 2, s.people.tl)).status, 200);
  assert.equal(await s.discordOf(s.people.tl), DISCORD(2));
  assert.equal((await s.link('o1', 3, s.people.bravo)).status, 200);
  assert.deepEqual([await s.discordOf(s.people.bravo), await s.linkedTo(3)], [DISCORD(3), s.people.bravo]);
  assert.equal(await s.linkAudits(), 3);
  // An Officer does not outrank an equal Officer; the Guild Master does.
  await s.fail('o1', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 4, personId: s.people.o2 }, 403, 'seniority');
  assert.equal(await s.discordOf(s.people.o2), null);
  assert.equal((await s.link('gm', 4, s.people.o2)).status, 200);
  assert.equal(await s.discordOf(s.people.o2), DISCORD(4));
  // The Guild Master's own person is the Guild Master's to link.
  assert.equal((await s.link('gm', 5, s.people.gm)).status, 200);
  assert.equal(await s.discordOf(s.people.gm), DISCORD(5));
});

check('a link that gives no Discord ID keeps the old rule: the person already has it, or the sign-up carries none (the raid\'s team alone decides)', async () => {
  const s = await world();
  s.signup(1, DISCORD(1));
  assert.equal((await s.link('tl', 1, s.people.m1)).status, 200);
  // A second sign-up of the same Discord ID: the person has it, nothing is relinked, the Team Lead of the raid's team links it.
  s.signup(2, DISCORD(1));
  const again = await s.link('tl', 2, s.people.m1);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.relinked, 1);
  // A sign-up with no Discord ID links itself only and gives the person none.
  s.signup(3, null);
  const bare = await s.link('tl', 3, s.people.bravo);
  assert.equal(bare.status, 200, bare.text);
  assert.deepEqual([await s.discordOf(s.people.bravo), await s.linkedTo(3)], [null, s.people.bravo]);
});

check('the guard sits inside the batch: a person promoted between the read and the batch changes nothing (the route answers 409)', async () => {
  const s = await world();
  s.signup(1, DISCORD(1));
  s.signup(2, DISCORD(1));
  const db = s.w.db;
  const batch = db.batch.bind(db);
  let promote = null;
  db.batch = async (statements) => {
    if (promote && statements.some((statement) => /UPDATE raid_signups SET player_id/.test(statement.sql))) {
      const run = promote;
      promote = null;
      run();
    }
    return batch(statements);
  };
  // The Team Lead passes the pre-check on a Member's person; the Member's account becomes an Officer before the batch runs.
  promote = () => s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
    VALUES ('ra_hotfix', '${s.gid}', '${s.uids.m1}', 'officer', NULL, '${s.uids.gm}', 1)`);
  const stopped = await s.call('tl', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 1, personId: s.people.m1 });
  assert.equal(promote, null, 'the hook ran between the read and the batch');
  assert.deepEqual([stopped.status, stopped.json && stopped.json.error], [409, 'conflict'], stopped.text);
  assert.equal(await s.discordOf(s.people.m1), null, 'the person did not get the Discord ID');
  assert.equal((await s.w.rows('SELECT player_id FROM raid_signups WHERE player_id IS NOT NULL')).length, 0, 'no sign-up row followed');
  assert.equal(await s.linkAudits(), 0, 'no audit row');
  // The Member is an Officer now: the same Team Lead is refused up front, and so is an equal Officer; the Guild Master links it.
  await s.fail('tl', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 1, personId: s.people.m1 }, 403, 'seniority');
  await s.fail('o1', 'POST', `/raids/${s.raid}/signups/link`, { signupId: 1, personId: s.people.m1 }, 403, 'seniority');
  assert.equal((await s.link('gm', 1, s.people.m1)).status, 200);
  assert.deepEqual([await s.discordOf(s.people.m1), await s.linkedTo(1), await s.linkedTo(2)], [DISCORD(1), s.people.m1, s.people.m1]);
});

check('the statement builder: the sign-up rows follow the person only while the guard holds, and without a guard it is the statement it always was', async () => {
  const { linkSignupsStatement } = await load('worker/attendance-store.js');
  const { seniorityOk } = await load('worker/seniority.js');
  const s = await world();
  s.signup(1, DISCORD(9));
  s.signup(2, DISCORD(9));
  const attempt = (actor, personId) => s.w.db.batch([linkSignupsStatement(s.w.db, s.gid, personId, DISCORD(9), s.raid, 1, seniorityOk(s.gid, s.uids[actor], personId))]);
  assert.equal((await attempt('tl', s.people.gm))[0].meta.changes, 0, 'a Team Lead links nothing onto the Guild Master\'s person');
  assert.equal((await s.w.rows('SELECT player_id FROM raid_signups WHERE player_id IS NOT NULL')).length, 0);
  assert.equal((await attempt('gm', s.people.gm))[0].meta.changes, 2, 'the Guild Master\'s own person takes both rows with that Discord ID');
  s.exec('UPDATE raid_signups SET player_id = NULL');
  assert.equal((await s.w.db.batch([linkSignupsStatement(s.w.db, s.gid, s.people.m1, DISCORD(9), s.raid, 1)]))[0].meta.changes, 2);
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
