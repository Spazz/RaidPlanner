/**
 * Raidsmith guild tracker, design framework wave 1 - Worker tests for Guild settings > General (PATCH /api/guild/:gid)
 * Run: node guild-general-worker-tests.js
 *
 * The Guild Master edits the guild's name, realm (realm guilds) and time zone; nobody else does; the game version, region, Discord server and a
 * Forever ruleset are fixed; validation is the create route's; one 'guild.update' audit row carries only what changed, with a plain sentence in
 * the Activity log. Same harness as the other Worker suites: the Worker over the node:sqlite D1 stand-in (tests/d1-fake.js), Discord faked.
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, makeWorld, signIn, person } = require('./tests/guild-world');

const S1 = '900000000000000001';
const S2 = '900000000000000002';
const ALICE = person(1, 'Alice');
const BOB = person(2, 'Bob');
const CAROL = person(3, 'Carol');
const OFFICER = { officer: true, teamLeadTeamIds: [] };
const BODY = { serverId: S1, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const meOf = async (w, jar) => (await w.call(jar, 'GET', '/auth/me')).json;

// Alice (an administrator of S1) creates "Ember"; Bob is an officer, Carol a plain member.
async function scenario(over = {}) {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1), adminOf(S2)])).jar;
  const made = await w.call(alice, 'POST', '/api/guild', { ...BODY, ...over });
  assert.equal(made.status, 201, made.text);
  const s = { w, guildId: made.json.guild.id, jars: { alice }, ids: {} };
  s.jars.bob = (await signIn(w, BOB, [memberOf(S1)])).jar;
  s.jars.carol = (await signIn(w, CAROL, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await meOf(w, s.jars[name])).user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body) => w.call(s.jars[who], method, `${s.path}${tail}`, body);
  const roles = await s.call('alice', 'PUT', `/people/${s.ids.bob}/roles`, OFFICER);
  assert.equal(roles.status, 200, roles.text);
  return s;
}

const auditRows = (s) => s.w.rows("SELECT action, entity_type, entity_id, before, after, actor_user_id FROM audit_log WHERE guild_id = ? AND action = 'guild.update' ORDER BY created_at, id", s.guildId);

check('the Guild Master changes the name, the realm and the time zone; the reply is the guild payload and one audit row keeps only what changed', async () => {
  const s = await scenario();
  const res = await s.call('alice', 'PATCH', '', { name: '  Ember Raiders ', realm: 'Dreamscythe', timeZone: 'America/Chicago' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.guild.name, 'Ember Raiders', 'the name is trimmed');
  assert.equal(res.json.guild.realm, 'Dreamscythe');
  assert.equal(res.json.guild.realmSlug, 'dreamscythe', 'a listed realm keeps its slug');
  assert.equal(res.json.guild.timeZone, 'America/Chicago');
  assert.equal(res.json.guild.gameVersion, 'tbc');
  assert(res.json.me && res.json.teams, 'the reply is the whole guild payload');
  const get = await s.call('alice', 'GET', '');
  assert.equal(get.json.guild.name, 'Ember Raiders');
  const rows = await auditRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_type, 'guild');
  assert.equal(rows[0].entity_id, s.guildId);
  assert.equal(rows[0].actor_user_id, s.ids.alice);
  assert.deepEqual(JSON.parse(rows[0].before), { name: 'Ember', realm: 'Nightslayer', timeZone: 'America/New_York' });
  assert.deepEqual(JSON.parse(rows[0].after), { name: 'Ember Raiders', realm: 'Dreamscythe', timeZone: 'America/Chicago' });
});

check('a single field changes alone, an unlisted realm is kept as typed, and a repeat that changes nothing writes no audit row', async () => {
  const s = await scenario();
  assert.equal((await s.call('alice', 'PATCH', '', { timeZone: 'Europe/Berlin' })).json.guild.timeZone, 'Europe/Berlin');
  const typed = await s.call('alice', 'PATCH', '', { realm: 'Some Private Realm' });
  assert.equal(typed.status, 200, typed.text);
  assert.equal(typed.json.guild.realm, 'Some Private Realm');
  assert.equal(typed.json.guild.realmSlug, null, 'no slug for a realm that is not on the list');
  assert.equal(typed.json.guild.name, 'Ember', 'the other fields stay');
  const again = await s.call('alice', 'PATCH', '', { realm: 'Some Private Realm', timeZone: 'Europe/Berlin' });
  assert.equal(again.status, 200);
  assert.equal((await auditRows(s)).length, 2, 'only the two real changes are audited');
  const rows = await auditRows(s);
  assert.deepEqual(JSON.parse(rows[0].after), { timeZone: 'Europe/Berlin' });
  assert.deepEqual(JSON.parse(rows[1].after), { realm: 'Some Private Realm' });
});

check('only the Guild Master edits: an officer and a member get 403 and nothing changes', async () => {
  const s = await scenario();
  for (const who of ['bob', 'carol']) {
    const res = await s.call(who, 'PATCH', '', { name: 'Hijacked' });
    assert.equal(res.status, 403, who);
    assert.equal(res.json.error, 'forbidden');
  }
  assert.equal((await s.call('alice', 'GET', '')).json.guild.name, 'Ember');
  assert.equal((await auditRows(s)).length, 0);
  const stranger = (await signIn(s.w, person(9, 'Stranger'), [memberOf(S2)])).jar;
  assert.equal((await s.w.call(stranger, 'PATCH', s.path, { name: 'Nope' })).status, 403, 'a person outside the guild');
  assert.equal((await s.w.call({}, 'PATCH', s.path, { name: 'Nope' })).status, 401, 'signed out');
});

check('validation is the create route\'s: an empty body, a blank or long or control-character name, a bad zone and a non-text realm are 400 with the field', async () => {
  const s = await scenario();
  const bad = async (body, field) => {
    const res = await s.call('alice', 'PATCH', '', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    if (field) assert.equal(res.json.field, field, JSON.stringify(body));
  };
  await bad({});
  await bad({ name: '   ' }, 'name');
  await bad({ name: 'x'.repeat(61) }, 'name');
  await bad({ name: 'Line\nbreak' }, 'name');
  await bad({ name: 42 }, 'name');
  await bad({ timeZone: 'Mars/Olympus' }, 'timeZone');
  await bad({ timeZone: '+05:00' }, 'timeZone');
  await bad({ timeZone: '' }, 'timeZone');
  await bad({ realm: '' }, 'realm');
  await bad({ realm: 'y'.repeat(65) }, 'realm');
  await bad({ realm: 7 }, 'realm');
  assert.equal((await s.call('alice', 'GET', '')).json.guild.name, 'Ember', 'a refused request changes nothing');
  assert.equal((await auditRows(s)).length, 0);
  const ok = await s.call('alice', 'PATCH', '', { name: 'x'.repeat(60) });
  assert.equal(ok.status, 200, 'the longest allowed name');
});

check('the game version, region, Discord server are fixed, and so is the ruleset of a Forever guild', async () => {
  const s = await scenario();
  for (const [field, value] of [['gameVersion', 'classic'], ['region', 'EU'], ['serverId', S2]]) {
    const res = await s.call('alice', 'PATCH', '', { name: 'Fine', [field]: value });
    assert.equal(res.status, 400, field);
    assert.equal(res.json.field, field);
  }
  assert.equal((await s.call('alice', 'GET', '')).json.guild.name, 'Ember', 'the valid name beside a fixed field is not applied');
  const forever = await scenario({ gameVersion: 'forever', realm: 'Normal', serverId: S1 });
  const ruleset = await forever.call('alice', 'PATCH', '', { realm: 'PvP' });
  assert.equal(ruleset.status, 400);
  assert.equal(ruleset.json.field, 'realm');
  assert.equal((await forever.call('alice', 'GET', '')).json.guild.realm, 'Normal');
  const renamed = await forever.call('alice', 'PATCH', '', { name: 'Forever Crew', timeZone: 'America/Denver' });
  assert.equal(renamed.status, 200, 'name and zone are still editable on a ruleset guild');
  assert.equal(renamed.json.guild.realmKind, 'ruleset');
});

check('the Activity log reads the change as a sentence in the Settings group', async () => {
  const s = await scenario();
  await s.call('alice', 'PATCH', '', { name: 'Ember Raiders', timeZone: 'America/Chicago' });
  const log = await s.call('alice', 'GET', '/audit?type=settings');
  assert.equal(log.status, 200, log.text);
  const row = log.json.rows.find((entry) => entry.action === 'guild.update');
  assert(row, 'the row is in the Settings group');
  assert.equal(row.text, 'Changed the name from "Ember" to "Ember Raiders" and the time zone from America/New_York to America/Chicago');
});

check('the guild payload carries the Discord server id for the Guild Master only (Guild settings > General shows it read-only)', async () => {
  const s = await scenario();
  assert.equal((await s.call('alice', 'GET', '')).json.guild.discordServerId, S1);
  assert.equal((await s.call('bob', 'GET', '')).json.guild.discordServerId, undefined, 'an officer');
  assert.equal((await s.call('carol', 'GET', '')).json.guild.discordServerId, undefined, 'a member');
  const patched = await s.call('alice', 'PATCH', '', { name: 'Ember Two' });
  assert.equal(patched.json.guild.discordServerId, S1, 'the PATCH reply is the same payload');
});

check('describeRow: one sentence per combination, and the old name stays when a before value is missing', async () => {
  const { describeRow } = await load('worker/audit-view.js');
  const row = (before, after) => ({ action: 'guild.update', entityType: 'guild', entityId: 'g_1', before, after });
  assert.equal(describeRow(row({ realm: 'A' }, { realm: 'B' })), 'Changed the realm from A to B');
  assert.equal(describeRow(row({ name: 'A', realm: 'B', timeZone: 'UTC' }, { name: 'C', realm: 'D', timeZone: 'Europe/Paris' })),
    'Changed the name from "A" to "C", the realm from B to D and the time zone from UTC to Europe/Paris');
  assert.equal(describeRow(row(null, null)), 'Changed the guild settings');
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
