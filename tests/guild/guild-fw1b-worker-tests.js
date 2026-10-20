/**
 * Raidsmith guild tracker, design framework wave 1 (Home and the Planner landing) - Worker tests
 * Run: node tests/guild/guild-fw1b-worker-tests.js
 *
 * The guild payload (GET /api/guild/:gid) says which roster person is the viewer's (`me.personId`, null when the account is on no roster): the member
 * Home and "My profile" open their pages from it. The person is the one worker/membership.js ownPersonStatement finds (linked to the account, or
 * carrying its Discord ID), so the payload cannot drift from what the sign-up, loot and away routes call "mine". The setup checklist's first step is
 * done as soon as the guild has an active team (Create a guild made one).
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

const meOf = async (w, jar) => (await w.call(jar, 'GET', '/auth/me')).json;

async function scenario() {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const made = await w.call(alice, 'POST', '/api/guild', BODY);
  assert.equal(made.status, 201, made.text);
  const s = { w, guildId: made.json.guild.id, teamId: made.json.teams[0].id, jars: { alice }, ids: {}, created: made.json };
  s.jars.bob = (await signIn(w, BOB, [memberOf(S1)])).jar;
  s.jars.carol = (await signIn(w, CAROL, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await meOf(w, s.jars[name])).user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body) => w.call(s.jars[who], method, `${s.path}${tail}`, body);
  return s;
}

const personIdOf = async (s, who) => (await s.call(who, 'GET', '')).json.me.personId;

check('me.personId: null until the account is linked to a roster person, then that person; other accounts stay null', async () => {
  const s = await scenario();
  assert.equal(s.created.me.personId, null, 'the create reply has the field too');
  for (const who of ['alice', 'bob', 'carol']) assert.equal(await personIdOf(s, who), null, `${who}: on no roster yet`);
  const added = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name: 'Thornwick', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(added.status, 201, added.text);
  const pid = added.json.person.id;
  assert.equal(await personIdOf(s, 'bob'), null, 'a roster person nobody linked is nobody\'s');
  const linked = await s.call('alice', 'PUT', `/roster/${pid}/account`, { userId: s.ids.bob });
  assert.equal(linked.status, 200, linked.text);
  assert.equal(await personIdOf(s, 'bob'), pid, 'the linked account has it');
  assert.equal(await personIdOf(s, 'carol'), null, 'another account does not');
  assert.equal(await personIdOf(s, 'alice'), null, 'neither does the Guild Master who linked it');
});

check('me.personId: a person that carries the account\'s Discord ID is the account\'s (the rule every "mine" route uses)', async () => {
  const s = await scenario();
  const added = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name: 'Mendra', class: 'PRIEST', mainSpec: 'Holy', offSpec: null, status: 'raider' });
  assert.equal(added.status, 201, added.text);
  const pid = added.json.person.id;
  const discordId = '800000000000000077';
  s.w.db.sqlite.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordId, s.ids.carol);
  s.w.db.sqlite.prepare('UPDATE players SET discord_user_id = ? WHERE id = ?').run(discordId, pid);
  assert.equal(await personIdOf(s, 'carol'), pid);
  assert.equal(await personIdOf(s, 'bob'), null);
});

check('setup checklist: step 1 (teams) is done in a new guild, and every other step starts open', async () => {
  const s = await scenario();
  const res = await s.call('alice', 'GET', '/attention');
  assert.equal(res.status, 200, res.text);
  const steps = Object.fromEntries(res.json.onboarding.steps.map((step) => [step.id, step.done]));
  assert.deepEqual(steps, { teams: true, roster: false, attendance: false, raid: false, officers: false, loot: false });
  assert.deepEqual([res.json.onboarding.done, res.json.onboarding.total], [1, 6]);
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
