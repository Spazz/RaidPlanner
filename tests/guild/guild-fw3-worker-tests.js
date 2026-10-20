/**
 * Raidsmith guild tracker, design framework wave 3 (person pages, Away / My characters / Linked accounts, the read-only pages) - Worker tests
 * Run: node tests/guild/guild-fw3-worker-tests.js
 *
 *   - The guest sign-up (join) answer names the GUILD's time zone, so the page writes the raid's start the way the guild does ("8:00 PM ET"), not in the
 *     visitor's zone; the guest view and the public page carry it too (their loot awards have a time).
 *   - GET /auth/bnet marks each guild the viewer is already on the roster of (`onRoster`), so My characters can say what Battle.net adds instead of asking
 *     someone who is already listed to connect it.
 *   - The person loot answer carries `isMe` and the Main's class, which the page needs for its You line and its header.
 */
const assert = require('node:assert/strict');
const { adminOf, memberOf, makeWorld, signIn, person } = require('../guild-world');

const S1 = '900000000000000001';
const ALICE = person(1, 'Alice');
const BOB = person(2, 'Bob');
const CAROL = person(3, 'Carol');
const BODY = { serverId: S1, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario() {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const made = await w.call(alice, 'POST', '/api/guild', BODY);
  assert.equal(made.status, 201, made.text);
  const s = { w, guildId: made.json.guild.id, teamId: made.json.teams[0].id, jars: { alice }, ids: {} };
  s.jars.bob = (await signIn(w, BOB, [memberOf(S1)])).jar;
  s.jars.carol = (await signIn(w, CAROL, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body) => w.call(s.jars[who], method, `${s.path}${tail}`, body);
  s.addPerson = async (name, cls, spec, link) => {
    const res = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider' });
    assert.equal(res.status, 201, res.text);
    const pid = res.json.person.id;
    if (link) assert.equal((await s.call('alice', 'PUT', `/roster/${pid}/account`, { userId: s.ids[link] })).status, 200);
    return pid;
  };
  return s;
}

check('the guest sign-up answer carries the guild\'s time zone, and follows it when the Guild Master changes it', async () => {
  const s = await scenario();
  const raid = await s.call('alice', 'POST', '/raids', { teamId: s.teamId, raidOn: '2027-01-20', startTime: '20:00', zone: "Gruul's Lair" });
  assert.equal(raid.status, 201, raid.text);
  const rid = raid.json.raid.id;
  const link = await s.call('alice', 'POST', `/raids/${rid}/join-links`, { maxUses: 2 });
  assert.equal(link.status, 201, link.text);
  const token = link.json.created.token;
  const view = await s.w.call({}, 'POST', '/api/join/view', { token });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.guild.timeZone, 'America/New_York');
  assert.deepEqual(Object.keys(view.json.guild).sort(), ['gameVersion', 'name', 'realmKind', 'timeZone'], 'only what the form needs');
  // 20:00 in New York on Jan 20 is 01:00 UTC on Jan 21: the stamp is the same moment whatever zone the visitor is in.
  assert.equal(new Date(view.json.raid.startsAt).toISOString(), '2027-01-21T01:00:00.000Z');
  const moved = await s.w.call(s.jars.alice, 'PATCH', s.path, { timeZone: 'Europe/Berlin' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await s.w.call({}, 'POST', '/api/join/view', { token })).json.guild.timeZone, 'Europe/Berlin');
});

check('the guest view and the public page carry the guild\'s time zone', async () => {
  const s = await scenario();
  assert.equal((await s.call('alice', 'PUT', '/public', { enabled: true, sections: ['roster', 'loot'] })).status, 200);
  const pub = await s.w.call({}, 'GET', `/api/public/${s.guildId}`);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.guild.timeZone, 'America/New_York');
});

check('GET /auth/bnet marks the guilds the viewer is already on the roster of; an account on no roster gets false', async () => {
  const s = await scenario();
  const read = async (who) => (await s.w.call(s.jars[who], 'GET', '/auth/bnet')).json;
  assert.deepEqual((await read('bob')).guilds.map((g) => [g.guildName, g.onRoster]), [['Ember', false]], 'a member who is on no roster entry');
  await s.addPerson('Thornwick', 'WARRIOR', 'Arms', 'bob');
  assert.deepEqual((await read('bob')).guilds.map((g) => [g.guildName, g.onRoster]), [['Ember', true]], 'linked to a roster entry by an officer');
  assert.deepEqual((await read('carol')).guilds.map((g) => [g.guildName, g.onRoster]), [['Ember', false]], 'another account is not on it');
  assert.equal((await read('bob')).guilds[0].status, 'not_linked', 'Battle.net itself is still not connected');
});

check('the person loot answer carries isMe and the Main\'s class', async () => {
  const s = await scenario();
  const pid = await s.addPerson('Thornwick', 'WARRIOR', 'Arms', 'bob');
  const own = await s.call('bob', 'GET', `/loot/person/${pid}`);
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(own.json.person, { id: pid, name: 'Thornwick', class: 'WARRIOR', status: 'raider', isMe: true });
  const officer = await s.call('alice', 'GET', `/loot/person/${pid}`);
  assert.equal(officer.status, 200, officer.text);
  assert.equal(officer.json.person.isMe, false, 'an officer reading somebody else\'s loot');
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
