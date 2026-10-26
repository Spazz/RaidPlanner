// The guild the lane B3 suites (tests/guild/guild-b3-*-tests.js) share: the Worker over the D1 stand-in, a Discord guild made through the API, and helpers for
// accounts with roles, roster people, characters and the raw database. Nothing here is a test.
//   const s = await scenario({ teams: ['Alpha', 'Bravo'] });
//   s.call(who, method, tail, body)       -> { status, json, text }   `who` is a key of s.jars; tail is under /api/guild/<gid> unless it starts with /api/ or /auth/
//   s.ok(who, method, tail, body, status) -> json, asserting the status (200, 201 for a POST)
//   s.member(key) / s.officer(key) / s.lead(key, teamIds)    sign the account in (a Discord member of the server) and give it the role; -> its user id
//   s.person(body, who) / s.alt(pid, name, body, who)        roster writes; s.link(pid, key) links the account to the person (an officer's link)
//   s.rows(sql, ...values) / s.exec(sql)                     the database; s.teamOf(characterId)
const assert = require('node:assert/strict');
const { adminOf, load, makeWorld, memberOf, signIn } = require('./guild-world');

const STEP = 2000;
const SERVER = '900000000000000091';
const KEYS = ['gm'];
const discord = (key, name) => {
  if (!KEYS.includes(key)) KEYS.push(key);
  return { id: `11000000000009${String(KEYS.indexOf(key) + 1).padStart(4, '0')}`, username: (name || key).toLowerCase(), globalName: name || key };
};

async function scenario({ teams = ['Alpha', 'Bravo'], env = {}, serverId = SERVER, wrapFetch } = {}) {
  const w = await makeWorld({ env, wrapFetch });
  const jars = { gm: (await signIn(w, discord('gm', 'Gmb3'), [adminOf(serverId)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId, name: 'Writers B3', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: true, teamNames: teams,
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const uids = { gm: (await w.call(jars.gm, 'GET', '/auth/me')).json.user.id };
  const s = {
    w, gid, tids, jars, uids, base: `/api/guild/${gid}`, serverId,
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // The error body of a request that must fail: { status, error, field }
    async fail(who, method, tail, body, status, error) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status, `${who} ${method} ${tail} answered ${res.status}: ${res.text}`);
      if (error) assert.equal(res.json && res.json.error, error, `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    one: async (sql, ...values) => (await w.rows(sql, ...values))[0],
    exec: (sql) => w.db.sqlite.exec(sql),
    async member(key, name) {
      jars[key] = (await signIn(w, discord(key, name), [memberOf(serverId)])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      return uids[key];
    },
    // A signed-in account that is in NO server of the guild and is linked to no person: not a member.
    async outsider(key, name) {
      jars[key] = (await signIn(w, discord(key, name), [])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      return uids[key];
    },
    async officer(key, name) {
      const id = await s.member(key, name);
      await s.ok('gm', 'PUT', `/people/${id}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
      return id;
    },
    async lead(key, teamIds, name) {
      const id = await s.member(key, name);
      await s.ok('gm', 'PUT', `/people/${id}/roles`, { officer: false, teamLeadTeamIds: teamIds }, 200);
      return id;
    },
    // A roster person with a Main on teams[0] (teamId: null = no team).
    async person(body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', '/roster', { teamId: tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null, ...body });
      return { pid: res.person.id, cid: res.characters[0].id, res };
    },
    async alt(pid, name, body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', `/roster/${pid}/characters`, { class: 'ROGUE', mainSpec: 'Combat', offSpec: null, name, ...body });
      return res.characters.find((c) => c.name === name).id;
    },
    // An officer's account link (players.user_id).
    async link(pid, key, who = 'gm') {
      return s.ok(who, 'PUT', `/roster/${pid}/account`, { userId: uids[key] }, 200);
    },
    teamOf: async (characterId) => (await s.one('SELECT team_id FROM characters WHERE id = ?', characterId)).team_id,
    // Put a character on a team with the column itself (a fixture; the team routes are what the tests exercise).
    setTeam: (characterId, teamId) => s.exec(`UPDATE characters SET team_id = ${teamId ? `'${teamId}'` : 'NULL'} WHERE id = '${characterId}'`),
    setOwner: (key) => s.exec(`UPDATE guilds SET owner_user_id = ${key ? `'${uids[key]}'` : 'NULL'} WHERE id = '${gid}'`),
  };
  return s;
}

function runChecks(checks) {
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
}

module.exports = { scenario, runChecks, load, STEP, SERVER, discord };
