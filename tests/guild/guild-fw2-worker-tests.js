/**
 * Raidsmith guild tracker, design framework wave 2 (list pages on T1) - Worker tests
 * Run: node tests/guild/guild-fw2-worker-tests.js
 *
 *   - The guild payload names the viewer's teams: `me.mainTeamId` (the team of their Main) and `me.teamIds` (every team one of their characters is on). The
 *     member Home reads its team from them instead of from the shell's team picker.
 *   - The Loot balance marks the viewer's own row (`isMe`), which the page pins first.
 *   - The Attendance nav badge counts open FLAGS (the sum of the raids' open_flags), the same unit as the Review queue's header and the Home list.
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
  const s = { w, guildId: made.json.guild.id, teamId: made.json.teams[0].id, jars: { alice }, ids: {}, created: made.json };
  s.jars.bob = (await signIn(w, BOB, [memberOf(S1)])).jar;
  s.jars.carol = (await signIn(w, CAROL, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body) => w.call(s.jars[who], method, `${s.path}${tail}`, body);
  return s;
}

check('me.mainTeamId and me.teamIds: the team of the Main, every team a character is on (a new alt is on none); null and [] for an account on no roster', async () => {
  const s = await scenario();
  const second = await s.call('alice', 'POST', '/teams', { name: 'Weekend team' });
  assert.equal(second.status, 201, second.text);
  const weekendId = second.json.team ? second.json.team.id : second.json.id;
  assert(weekendId, JSON.stringify(second.json));
  const me = async (who) => (await s.call(who, 'GET', '')).json.me;
  assert.deepEqual([(await me('bob')).mainTeamId, (await me('bob')).teamIds], [null, []], 'on no roster yet');
  // Bob's Main is on the second team; he has an Alt, which starts on no team (U R3-Q1/R4-Q1), so the first team is not his.
  const added = await s.call('alice', 'POST', '/roster', { teamId: weekendId, name: 'Thornwick', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(added.status, 201, added.text);
  const pid = added.json.person.id;
  assert.equal((await s.call('alice', 'PUT', `/roster/${pid}/account`, { userId: s.ids.bob })).status, 200);
  const alt = await s.call('alice', 'POST', `/roster/${pid}/characters`, { name: 'Thornalt', class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId: s.teamId, makeMain: false });
  assert.equal(alt.status, 201, alt.text);
  const bob = await me('bob');
  assert.equal(bob.personId, pid);
  assert.equal(bob.mainTeamId, weekendId, 'the Main\'s team, not the first team');
  assert.deepEqual([...bob.teamIds].sort(), [weekendId], 'the teamless alt adds no team');
  // Placed on the first team (a team route, B3), the alt adds it: simulated here with the column itself.
  s.w.db.sqlite.exec(`UPDATE characters SET team_id = '${s.teamId}' WHERE name = 'Thornalt'`);
  assert.deepEqual([...(await me('bob')).teamIds].sort(), [s.teamId, weekendId].sort());
  assert.deepEqual([(await me('carol')).mainTeamId, (await me('carol')).teamIds], [null, []], 'another account is on no team');
  assert.equal((await s.call('alice', 'GET', '')).json.me.mainTeamId, null, 'the Guild Master who linked it is not on the roster');
});

check('the Loot balance marks the viewer\'s own row with isMe (the page pins it first); nobody else is marked', async () => {
  const s = await scenario();
  const mk = async (name, userKey) => {
    const added = await s.call('alice', 'POST', '/roster', { teamId: s.teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
    assert.equal(added.status, 201, added.text);
    if (userKey) assert.equal((await s.call('alice', 'PUT', `/roster/${added.json.person.id}/account`, { userId: s.ids[userKey] })).status, 200);
    return added.json.person.id;
  };
  const p1 = await mk('Aimer');
  const p2 = await mk('Brew', 'bob');
  const p3 = await mk('Cass', 'carol');
  // Members see the standings only when the team's loot rules switch them on.
  assert.equal((await s.call('alice', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { standings: true } }, version: 0 })).status, 200);
  // The balance needs raids with awards to list anyone; the people list itself is what carries isMe, so read it for the three viewers.
  let read = 0;
  for (const [who, mine] of [['alice', null], ['bob', p2], ['carol', p3]]) {
    const res = await s.call(who, 'GET', `/loot/balance?team=${s.teamId}`);
    assert.equal(res.status, 200, who + ': ' + res.text);
    read++;
    const marked = res.json.people.filter((p) => p.isMe).map((p) => p.personId);
    assert.deepEqual(marked, mine ? [mine] : [], `${who}: ${JSON.stringify(res.json.people.map((p) => [p.name, p.isMe]))}`);
    for (const p of res.json.people) assert.equal(typeof p.isMe, 'boolean');
  }
  assert.equal(read, 3, 'the Guild Master and both members read the balance');
  void p1;
});

check('attendanceFlags in the guild payload sums open_flags per team (flags, not raids); a team with raids but no flags is 0', async () => {
  const s = await scenario();
  const read = async () => (await s.call('alice', 'GET', '')).json.attendanceFlags;
  assert.deepEqual(await read(), { [s.teamId]: 0 });
  const now = Date.now();
  const insert = (id, flags, day) => s.w.db.sqlite.prepare(
    `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, title, log_mode, open_flags, policy_fp, version, created_by, created_at, updated_at, time_known)
     VALUES (?, ?, ?, ?, ?, 'Gruul', NULL, 'log', ?, 'x', 1, ?, ?, ?, 1)`).run(id, s.guildId, s.teamId, day, now, flags, s.ids.alice, now, now);
  insert('r_one', 3, '2026-10-01');
  insert('r_two', 2, '2026-10-02');
  insert('r_zero', 0, '2026-10-03');
  assert.deepEqual(await read(), { [s.teamId]: 5 }, '3 + 2 flags on two raids is 5, not 2');
  assert.deepEqual((await s.call('bob', 'GET', '')).json.attendanceFlags, {}, 'a member sees no count');
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
