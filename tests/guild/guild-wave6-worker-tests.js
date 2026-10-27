/**
 * Raidsmith guild tracker - PM wave 6 Worker tests (the planner seed's sit-out history, the pending-claims count, date-only deadlines, the away cap
 * and the webhook test post).
 * Run: node tests/guild/guild-wave6-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js) with a fixed clock; Discord webhooks are answered by an injected fetch.
 * The pure rules are pinned directly; the routes and the SQL run over HTTP. Nothing touches the network.
 */
const assert = require('node:assert/strict');
const { ownPerson } = require('../guild-owner-fixture');
const { load, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000061';
const person = (n, name) => ({ id: `1100000000000006${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmsix'), m1: person(3, 'Memberone'), m2: person(4, 'Membertwo') };
const TZ = 'America/New_York';
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z (Friday 03:00 in New York): 2027-01-05 .. 2027-01-12 are past, 2027-01-16 (Saturday) is upcoming
const HOOK_ID = '123456789012345678';
const HOOK_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HOOK = `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`;
const HOOK_B = `https://discord.com/api/webhooks/${HOOK_ID}/zyxwvutsrqponmlkjihgfedcba9876543210EDCBA`;

const SPEC_OF = { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy' };
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A guild with a Guild Master and members (signed in, linked to a roster person on request); one team "Alpha" (a second, "Bravo", on request).
// net.webhook(url) -> the status Discord answers a post with (204 = fine); net.posts records every post.
async function scenario({ members = [], teams = 1 } = {}) {
  const net = { posts: [], webhook: () => 204 };
  const w = await makeWorld({
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const text = String(url);
      if (text.startsWith('https://discord.com/api/webhooks/')) {
        const status = net.webhook(text);
        net.posts.push({ url: text, status, body: JSON.parse(init.body), at: w.clock.now });
        return new Response(status === 204 ? null : '{"message":"nope"}', { status });
      }
      return discordFetch(url, init);
    },
  });
  w.clock.now = NOW;
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Six', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ,
    multipleTeams: teams > 1, ...(teams > 1 ? { teamNames: ['Alpha', 'Bravo'] } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  if (teams === 1) assert.equal((await w.call(jars.gm, 'PATCH', `/api/guild/${gid}/teams/${tids[0]}`, { name: 'Alpha' })).status, 200);
  const uids = {};
  for (const key of members) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, net, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) {
      w.advance(1000);
      return w.call(jars[who], method, `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // A raider on a team: { pid, cid }. link: the key of a signed-in member whose account becomes theirs.
    async person(name, { team = tids[0], cls = 'WARRIOR', link = null } = {}) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: cls, mainSpec: SPEC_OF[cls], offSpec: null, status: 'raider', ...(link ? { linkUserId: uids[link] } : {}) });
      if (link) ownPerson(w.db.sqlite, res.person.id, uids[link]); // the account owns it (players.user_id): linkUserId only records the Discord ID since the identity split
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    async raid(raidOn, { startTime = '20:00', team = tids[0] } = {}) {
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn, ...(startTime ? { startTime } : {}), zone: "Gruul's Lair" });
      return res.raid.id;
    },
    async audits(action) { return s.rows('SELECT actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', gid, action); },
  };
  return s;
}

// ---------------------------------------------------------------------------
// The planner seed: how often each person sat out the team's last raids

// An attendance row, as a recompute writes it: the person sat out ("bench" outcome).
const benchRow = (s, raidId, pid, outcome = 'bench') => s.exec(
  'INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 0)', raidId, s.gid, s.tid, pid, outcome,
);
// A name in the raid's saved plan: group 0 is the bench.
const planRow = (s, raidId, name, group) => s.exec('INSERT INTO raid_plan (raid_id, name, name_key, group_number) VALUES (?, ?, ?, ?)', raidId, name, name.toLowerCase(), group);

check('seed: benchedRecently counts the team\'s last four raids a person was benched in (an attendance Bench outcome or group 0 of the saved plan, once per raid); recentRaids says how many raids that is', async () => {
  const s = await scenario({ members: ['m1'] });
  const aldric = await s.person('Aldric');
  const brindle = await s.person('Brindle', { cls: 'MAGE' });
  const cassia = await s.person('Cassia', { cls: 'PRIEST' });
  const dunmar = await s.person('Dunmar');
  const upcoming = await s.raid('2027-01-16');
  // Before any earlier raid the seed carries no history at all.
  let seed = await s.ok('gm', 'GET', `/raids/${upcoming}/planner`);
  assert(!('recentRaids' in seed.raid) && seed.signups.every((row) => !('benchedRecently' in row)), JSON.stringify(seed.raid));
  // Six past raids: the oldest two are outside the window of four.
  const past = [];
  for (const day of ['2026-12-29', '2027-01-01', '2027-01-05', '2027-01-08', '2027-01-09', '2027-01-12']) past.push(await s.raid(day));
  const [r1, r2, r3, r4, r5, r6] = past;
  benchRow(s, r1, aldric.pid); benchRow(s, r2, aldric.pid);                  // too old to count
  benchRow(s, r3, aldric.pid); benchRow(s, r5, aldric.pid);                  // 2 recent
  benchRow(s, r6, brindle.pid, 'bench');                                     // 1 by attendance ...
  planRow(s, r6, 'Brindle', 0);                                              // ... and the plan says so too: once for that raid
  planRow(s, r4, 'Brindle', 0);                                              // a second raid, by the plan alone
  planRow(s, r5, 'Cassia', 3);                                               // seated: not benched
  benchRow(s, r6, cassia.pid, 'present');                                    // present: not benched
  await s.ok('gm', 'PUT', `/raids/${upcoming}/signups/${aldric.pid}`, { kind: 'signed' }, 200);
  await s.ok('gm', 'PUT', `/raids/${upcoming}/signups/${brindle.pid}`, { kind: 'signed' }, 200);
  await s.ok('gm', 'PUT', `/raids/${upcoming}/signups/${cassia.pid}`, { kind: 'signed' }, 200);
  await s.ok('gm', 'PUT', `/raids/${upcoming}/signups/${dunmar.pid}`, { kind: 'signed' }, 200);
  seed = await s.ok('gm', 'GET', `/raids/${upcoming}/planner`);
  assert.equal(seed.raid.recentRaids, 4);
  const byName = Object.fromEntries(seed.signups.map((row) => [row.name, row.benchedRecently]));
  assert.deepEqual(byName, { Aldric: 2, Brindle: 2, Cassia: 0, Dunmar: 0 });
});

check('seed: only raids of this team, before this one and already started count; a raid with fewer than four before it says how many', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.tids;
  const aldric = await s.person('Aldric', { team: alpha });
  const mine = await s.raid('2027-01-16', { team: alpha });
  const earlier = await s.raid('2027-01-12', { team: alpha });
  const otherTeam = await s.raid('2027-01-11', { team: bravo });
  const later = await s.raid('2027-01-23', { team: alpha });           // after this raid
  const sameDayEarlier = await s.raid('2027-01-16', { team: bravo });
  benchRow(s, earlier, aldric.pid);
  s.exec('INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 0)', otherTeam, s.gid, bravo, aldric.pid, 'bench');
  s.exec('INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 0)', sameDayEarlier, s.gid, bravo, aldric.pid, 'bench');
  planRow(s, later, 'Aldric', 0);
  await s.ok('gm', 'PUT', `/raids/${mine}/signups/${aldric.pid}`, { kind: 'signed' }, 200);
  const seed = await s.ok('gm', 'GET', `/raids/${mine}/planner`);
  assert.equal(seed.raid.recentRaids, 1, 'one earlier raid of Alpha');
  assert.deepEqual(seed.signups.map((row) => [row.name, row.benchedRecently]), [['Aldric', 1]]);
  // The Alpha raid on the 23rd sees the 12th only: the 16th has not started yet, and Bravo's raids are another team's.
  const next = await s.ok('gm', 'GET', `/raids/${later}/planner`);
  assert.equal(next.raid.recentRaids, 1);
  // Once the 16th has started it counts too (and so does its plan, here Aldric on the bench).
  planRow(s, mine, 'Aldric', 0);
  s.w.clock.now = at('2027-01-17', '12:00');
  const after = await s.ok('gm', 'GET', `/raids/${later}/planner`);
  assert.equal(after.raid.recentRaids, 2);
  await s.ok('gm', 'PUT', `/raids/${later}/signups/${aldric.pid}`, { kind: 'signed' }, 200);
  assert.deepEqual((await s.ok('gm', 'GET', `/raids/${later}/planner`)).signups.map((row) => [row.name, row.benchedRecently]), [['Aldric', 2]]);
});

check('seed: the virtual Away rows carry no history, and a Raid-Helper sign-up the Worker could not match to a person carries none either', async () => {
  const s = await scenario();
  await s.person('Aldric');
  const upcoming = await s.raid('2027-01-16');
  await s.raid('2027-01-12');
  s.exec("INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, class_name, spec_name) VALUES (?, 'raid_helper', 7, 'Pugger', 'signed', 7, ?, 'Mage', 'Fire')", upcoming, s.gid);
  const seed = await s.ok('gm', 'GET', `/raids/${upcoming}/planner`);
  assert.equal(seed.raid.recentRaids, 1);
  const pugger = seed.signups.find((row) => row.discordName === 'Pugger');
  assert(pugger && pugger.personId === null && !('benchedRecently' in pugger));
});

// ---------------------------------------------------------------------------
// Pending claims on the guild payload

const CLAIM = (n) => `cl_${String(n).padStart(22, 'A')}`;
async function addClaim(s, n, name, userKey = 'm1') {
  await s.exec(
    "INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 70, 'pending', ?)",
    CLAIM(n), s.gid, s.uids[userKey], name, name.toLowerCase(), NOW - n,
  );
  return CLAIM(n);
}

check('pending claims: the guild payload counts them for people who can decide claims (roster.edit) and sends 0 to everyone else; deciding one answers with the new count', async () => {
  const s = await scenario({ members: ['m1', 'm2'] });
  await s.person('Alma', { link: 'm1' });
  assert.equal((await s.ok('gm', 'GET', '')).pendingClaims, 0);
  await addClaim(s, 1, 'Mageone', 'm1');
  await addClaim(s, 2, 'Magetwo', 'm2');
  assert.equal((await s.ok('gm', 'GET', '')).pendingClaims, 2);
  assert.equal((await s.ok('m1', 'GET', '')).pendingClaims, 0, 'a member has no claims to decide');
  const rejected = await s.ok('gm', 'POST', `/claims/${CLAIM(1)}/reject`, {}, 200);
  assert.equal(rejected.pendingClaims, 1);
  assert.equal((await s.ok('gm', 'GET', '')).pendingClaims, 1);
  const approved = await s.ok('gm', 'POST', `/claims/${CLAIM(2)}/approve`, { expectedKind: 'new_person', teamId: s.tid, status: 'raider' }, 200);
  assert.equal(approved.pendingClaims, 0, JSON.stringify(approved));
  assert.equal((await s.ok('gm', 'GET', '')).pendingClaims, 0);
});

// ---------------------------------------------------------------------------
// Date-only raids: the sign-up window

const SAT = 6;
const slot = (weekday, startTime) => ({ weekday, startTime });
const at = (date, time) => Date.parse(`${date}T${time}:00-05:00`); // New York in January

check('window: signup-window.js - a date-only raid counts as starting at the team\'s slot time that weekday, else 18:00 guild time; a raid with a start time is as before', async () => {
  const { dateOnlyWindow, windowFieldsOf, closedReason, closesAtOf } = await load('worker/signup-window.js');
  assert.deepEqual(dateOnlyWindow('2027-01-16', '20:00', TZ), { at: at('2027-01-16', '20:00'), source: 'slot' });
  assert.deepEqual(dateOnlyWindow('2027-01-16', null, TZ), { at: at('2027-01-16', '18:00'), source: 'default' });
  // A slot time the clocks skip (02:30 on the spring-forward day 2027-03-14) falls back to the default.
  assert.deepEqual(dateOnlyWindow('2027-03-14', '02:30', TZ), { at: Date.parse('2027-03-14T18:00:00-04:00'), source: 'default' });
  assert.deepEqual(windowFieldsOf({ raid_on: '2027-01-16', time_known: 0, slot_time: '20:00' }, TZ), { window_starts_at: at('2027-01-16', '20:00'), window_source: 'slot' });
  for (const known of [1, null, undefined]) assert.deepEqual(windowFieldsOf({ raid_on: '2027-01-16', time_known: known, slot_time: '20:00' }, TZ), { window_starts_at: null, window_source: null });
  const noon = Date.UTC(2027, 0, 16, 12);
  const row = { starts_at: noon, signups_locked: 0, signup_close_hours: null, team_close_hours: 0, ...windowFieldsOf({ raid_on: '2027-01-16', time_known: 0, slot_time: '20:00' }, TZ) };
  assert.equal(closedReason(row, noon + 1000), null, 'noon UTC passes without closing it');
  assert.equal(closedReason(row, at('2027-01-16', '20:00')), 'started');
  assert.equal(closesAtOf({ ...row, signup_close_hours: 2 }), at('2027-01-16', '18:00'), 'the deadline hours count back from the window start');
  assert.equal(closedReason({ ...row, signup_close_hours: 2 }, at('2027-01-16', '18:00')), 'deadline');
  const timed = { starts_at: noon, signups_locked: 0, signup_close_hours: 1, team_close_hours: 0 };
  assert.equal(closesAtOf(timed), noon - 3600000);
  assert.equal(closedReason(timed, noon - 1), 'deadline');
});

check('window: a member can sign up for a date-only raid until the team\'s slot time that day (also after noon UTC), then the window shuts; the sign-ups view and the raid detail say which time and why', async () => {
  const s = await scenario({ members: ['m1'] });
  const alma = await s.person('Alma', { link: 'm1' });
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [slot(SAT, '20:00')] }, 200);
  const rid = await s.raid('2027-01-16', { startTime: null });
  const view = async () => (await s.ok('m1', 'GET', `/raids/${rid}/signups`)).raid;
  assert.equal((await s.rows('SELECT time_known FROM raids WHERE id = ?', rid))[0].time_known, 0);
  // 2027-01-16T15:00Z is 10:00 in New York: past noon UTC (the old window), before the 20:00 slot.
  s.w.clock.now = Date.parse('2027-01-16T15:00:00Z');
  const v = await view();
  assert.deepEqual([v.closed, v.closesAt, v.closesSource, v.timeKnown], [null, at('2027-01-16', '20:00'), 'slot', false]);
  const put = await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' });
  assert.equal(put.status, 200, put.text);
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}`)).raid.closesSource, 'slot');
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}`)).raid.closesAt, at('2027-01-16', '20:00'));
  // The Raids list agrees.
  const list = (await s.ok('m1', 'GET', `/raids?team=${s.tid}`)).upcoming;
  assert.deepEqual(list.length, 0, 'the list still treats noon UTC as the start of a date-only raid (upcoming = starts_at in the future)');
  // After the slot time the window is shut for members, but not for officers.
  s.w.clock.now = at('2027-01-16', '20:00') + 1000;
  const closed = await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'tentative' });
  assert.deepEqual([closed.status, closed.json.error, closed.json.reason], [409, 'signups_closed', 'started']);
  const gone = await s.call('m1', 'DELETE', `/raids/${rid}/signup`);
  assert.equal(gone.status, 409);
  assert.equal((await s.call('gm', 'PUT', `/raids/${rid}/signups/${alma.pid}`, { kind: 'bench' })).status, 200, 'an officer is not bound by the window');
});

check('window: the statements re-check the same time - a write that finds the window shut between the read and the write is refused', async () => {
  const s = await scenario({ members: ['m1'] });
  await s.person('Alma', { link: 'm1' });
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [slot(SAT, '20:00')] }, 200);
  const rid = await s.raid('2027-01-16', { startTime: null });
  s.w.clock.now = at('2027-01-16', '19:59');
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' })).status, 200);
  assert.equal((await s.call('m1', 'DELETE', `/raids/${rid}/signup`)).status, 200);
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' })).status, 200);
  s.w.clock.now = at('2027-01-16', '20:00');
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'tentative' })).status, 409);
});

check('window: with no slot on that weekday the window closes at 18:00 guild time (the view says so), and the team\'s deadline hours count back from there', async () => {
  const s = await scenario({ members: ['m1'] });
  await s.person('Alma', { link: 'm1' });
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [slot(0, '20:00')] }, 200); // Sundays only
  const rid = await s.raid('2027-01-16', { startTime: null });                              // a Saturday
  s.w.clock.now = at('2027-01-16', '12:00');
  let v = (await s.ok('m1', 'GET', `/raids/${rid}/signups`)).raid;
  assert.deepEqual([v.closed, v.closesAt, v.closesSource], [null, at('2027-01-16', '18:00'), 'default']);
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' })).status, 200);
  s.w.clock.now = at('2027-01-16', '18:00');
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'late' })).status, 409);
  // A team deadline of 3 hours: closed from 15:00.
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [slot(0, '20:00')], signupCloseHours: 3 }, 200);
  s.w.clock.now = at('2027-01-16', '14:59');
  v = (await s.ok('m1', 'GET', `/raids/${rid}/signups`)).raid;
  assert.deepEqual([v.closed, v.closesAt, v.closeHours], [null, at('2027-01-16', '15:00'), 3]);
  s.w.clock.now = at('2027-01-16', '15:00');
  v = (await s.ok('m1', 'GET', `/raids/${rid}/signups`)).raid;
  assert.deepEqual([v.closed, v.closesSource], ['deadline', 'default']);
  const failed = await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'tentative' });
  assert.deepEqual([failed.status, failed.json.reason, failed.json.closesAt], [409, 'deadline', at('2027-01-16', '15:00')]);
});

check('window: a raid with a start time, or a date-only raid whose time is known later, keeps its own start - no closesSource, and the window is the raid\'s start', async () => {
  const s = await scenario({ members: ['m1'] });
  await s.person('Alma', { link: 'm1' });
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [slot(SAT, '20:00')] }, 200);
  const rid = await s.raid('2027-01-16', { startTime: '21:30' });
  s.w.clock.now = at('2027-01-16', '21:00');
  const v = (await s.ok('m1', 'GET', `/raids/${rid}/signups`)).raid;
  assert.deepEqual([v.closed, v.closesAt, 'closesSource' in v], [null, at('2027-01-16', '21:30'), false]);
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}`)).raid.closesSource, undefined);
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' })).status, 200);
  s.w.clock.now = at('2027-01-16', '21:30');
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'tentative' })).status, 409);
  // A raid from before the column (time_known NULL) reads as timed.
  const old = await s.raid('2027-01-23', { startTime: null });
  s.exec('UPDATE raids SET time_known = NULL WHERE id = ?', old);
  assert.equal('closesSource' in (await s.ok('m1', 'GET', `/raids/${old}/signups`)).raid, false);
});

// ---------------------------------------------------------------------------
// The away cap

check('away cap: the 30-notice limit counts only current and future notices (a range that ended, a single day gone, a repeating notice that ended do not count; an open repeating one does)', async () => {
  const s = await scenario({ members: ['m1'] });
  const alma = await s.person('Alma', { link: 'm1' });
  let n = 0;
  const insert = (kind, startsOn, endsOn, weekday) => {
    n++;
    return s.exec(
      'INSERT INTO away_notices (id, guild_id, player_id, kind, at_time, starts_on, ends_on, weekday, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
      `an_${String(n).padStart(22, 'x')}`, s.gid, alma.pid, kind, kind === 'away' ? null : '21:00', startsOn, endsOn, weekday,
    );
  };
  // Today is 2027-01-15. Thirty notices that are over:
  for (let i = 0; i < 12; i++) await insert('away', `2026-11-${String(i + 1).padStart(2, '0')}`, `2026-11-${String(i + 1).padStart(2, '0')}`, null); // single days
  for (let i = 0; i < 12; i++) await insert('away', '2026-12-01', `2026-12-${String(i + 2).padStart(2, '0')}`, null);                              // ranges
  for (let i = 0; i < 6; i++) await insert('late', '2026-10-01', '2027-01-14', i);                                                                  // repeating, ended yesterday
  const mine = async () => (await s.ok('m1', 'GET', '/away/mine'));
  let list = await mine();
  assert.deepEqual([list.notices.length, list.active, list.max], [30, 0, 30]);
  // They do not block a new one; the list keeps them (the page folds them under Past).
  const body = (day) => ({ kind: 'away', from: day, to: day });
  assert.equal((await s.call('m1', 'POST', '/away', body('2027-02-01'))).status, 201);
  // Today and ahead count: today's single day, a running range, an open repeating notice, a repeating one ending today.
  await insert('away', '2027-01-15', '2027-01-15', null);
  await insert('away', '2027-01-10', '2027-01-20', null);
  await insert('late', '2027-01-01', null, 3);
  await insert('late', '2027-01-01', '2027-01-15', 2);
  list = await mine();
  assert.equal(list.active, 5);
  // Fill the rest of the 30 with notices ahead: the 31st current one is refused, and a past one removed or not does not matter.
  for (let day = 2; day < 27; day++) assert.equal((await s.call('m1', 'POST', '/away', body(`2027-03-${String(day).padStart(2, '0')}`))).status, 201, `day ${day}`);
  list = await mine();
  assert.equal(list.active, 30);
  const full = await s.call('m1', 'POST', '/away', body('2027-04-01'));
  assert.deepEqual([full.status, full.json.error, full.json.max], [409, 'too_many_notices', 30]);
  // Two of the thirty end today (the single day, the repeating one ending the 15th): the next day they no longer count and two places are free.
  s.w.clock.now = NOW + 24 * 3600 * 1000;
  assert.equal((await mine()).active, 28);
  assert.equal((await s.call('m1', 'POST', '/away', body('2027-04-01'))).status, 201);
  assert.equal((await s.call('m1', 'POST', '/away', body('2027-04-02'))).status, 201);
  assert.equal((await s.call('m1', 'POST', '/away', body('2027-04-03'))).status, 409);
});

// ---------------------------------------------------------------------------
// The webhook test post

const testPath = (s, tid = s.tid) => `/teams/${tid}/notifications/test`;
async function withWebhook(opts = {}) {
  const s = await scenario(opts);
  await s.ok('gm', 'PUT', `/teams/${s.tid}/notifications`, { webhookUrl: HOOK, roleMention: '<@&123456789012345678>', roster: true }, 200);
  return s;
}

check('test post: sends one plain embed to the saved webhook (no ping, no role, no link), answers sent, and never repeats the address', async () => {
  const s = await withWebhook({ members: ['m1'] });
  const res = await s.call('gm', 'POST', testPath(s), {});
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.json.result, res.json.status], ['sent', 204]);
  assert.equal(res.json.team.webhook.state, 'ok');
  assert(!res.text.includes(HOOK_TOKEN), 'the address is a secret');
  assert.equal(s.net.posts.length, 1);
  const post = s.net.posts[0];
  assert.equal(post.url, HOOK);
  assert.equal(post.body.content, '', 'the role mention of the settings is not used');
  assert.deepEqual(post.body.allowed_mentions, { parse: [], users: [], roles: [] });
  assert.equal(post.body.embeds.length, 1);
  assert.match(post.body.embeds[0].title, /^Test post: Alpha$/);
  assert(!/@everyone|@here|<@/.test(JSON.stringify(post.body)));
  assert.equal(post.body.embeds[0].url, undefined);
  // Audited by outcome, never the address; it shows in the Activity log words.
  const audits = await s.audits('notify.test');
  assert.equal(audits.length, 1);
  assert.deepEqual(JSON.parse(audits[0].after), { teamId: s.tid, result: 'sent' });
  assert(!JSON.stringify(audits).includes(HOOK_TOKEN));
  const { AUDIT_ACTIONS } = await load('worker/audit.js');
  const { ACTION_GROUP, describeRow, unmappedActions } = await load('worker/audit-view.js');
  assert(AUDIT_ACTIONS.includes('notify.test') && unmappedActions().length === 0);
  assert.equal(ACTION_GROUP['notify.test'], 'settings');
  const sentence = describeRow({ action: 'notify.test', entity_type: 'team', entity_id: s.tid, before: null, after: JSON.parse(audits[0].after) }, { team: () => 'Alpha' });
  assert.equal(sentence, 'Sent a test post to the Discord webhook of Alpha: it arrived');
  // Nothing was written to the message log (a test post is not a once-only message).
  assert.equal(await s.w.count('notification_log'), 0);
});

check('test post: needs guild.teams and a saved, working webhook; a member, a lead of another team and another guild\'s team are refused', async () => {
  const s = await scenario({ members: ['m1'] });
  assert.equal((await s.call('m1', 'POST', testPath(s), {})).status, 403);
  const none = await s.call('gm', 'POST', testPath(s), {});
  assert.deepEqual([none.status, none.json.error], [409, 'no_webhook']);
  assert.equal((await s.call('gm', 'POST', testPath(s, 't_AAAAAAAAAAAAAAAAAAAAAA'), {})).status, 404);
  await s.ok('gm', 'PUT', `/teams/${s.tid}/notifications`, { webhookUrl: HOOK }, 200);
  s.net.webhook = () => 404;
  const refused = await s.call('gm', 'POST', testPath(s), {});
  assert.deepEqual([refused.status, refused.json.result], [200, 'disabled']);
  const off = await s.call('gm', 'POST', testPath(s), {});
  assert.deepEqual([off.status, off.json.error], [409, 'webhook_off']);
  assert.equal(s.net.posts.length, 1, 'a switched-off webhook is not posted to again');
  assert.equal((await s.call('m1', 'POST', testPath(s), {})).status, 403);
  // Neither refusal used up one of the five (the limiter is only reached with something to post).
  await s.ok('gm', 'PUT', `/teams/${s.tid}/notifications`, { webhookUrl: HOOK_B }, 200);
  s.net.webhook = () => 204;
  assert.equal((await s.call('gm', 'POST', testPath(s), {})).json.result, 'sent');
  assert.equal((await s.rows('SELECT count FROM rate_limits WHERE key = ?', `ntest:${s.tid}`))[0].count, 2, 'only the two posts that went out were counted');
});

check('test post: Discord refusing the webhook (404 / 401 / 403) switches it off like a real post, with the Needs attention reason; other failures are only reported', async () => {
  for (const status of [404, 401, 403]) {
    const s = await withWebhook();
    s.net.webhook = () => status;
    const res = await s.call('gm', 'POST', testPath(s), {});
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.result, res.json.status, res.json.team.webhook.state, res.json.team.webhook.disabledStatus], ['disabled', status, 'disabled', status]);
    const stored = (await s.rows('SELECT webhook_state, disabled_status FROM team_notifications'))[0];
    assert.deepEqual([stored.webhook_state, stored.disabled_status], ['disabled', status]);
    const disabled = await s.audits('notify.disabled');
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].actor_user_id, s.uids.gm || disabled[0].actor_user_id);
    assert.deepEqual(JSON.parse(disabled[0].after), { teamId: s.tid, status });
    assert.equal(JSON.parse((await s.audits('notify.test'))[0].after).result, 'disabled');
    const attention = await s.ok('gm', 'GET', '/attention');
    assert(attention.items.some((item) => item.kind === 'webhook_off'), 'Needs attention lists the dead webhook');
  }
  for (const status of [429, 500, 400]) {
    const s = await withWebhook();
    s.net.webhook = () => status;
    const res = await s.call('gm', 'POST', testPath(s), {});
    assert.deepEqual([res.status, res.json.result, res.json.status, res.json.team.webhook.state], [200, 'failed', status, 'ok'], String(status));
  }
  // A network failure: no answer at all.
  const s = await scenario();
  await s.ok('gm', 'PUT', `/teams/${s.tid}/notifications`, { webhookUrl: HOOK }, 200);
  s.net.webhook = () => { throw new Error('offline'); };
  const res = await s.call('gm', 'POST', testPath(s), {});
  assert.deepEqual([res.status, res.json.result, res.json.status, res.json.team.webhook.state], [200, 'failed', null, 'ok']);
});

check('test post: five an hour per team - the sixth is a 429 with retryAfter, another team is counted on its own, and the hour passes', async () => {
  const s = await scenario({ teams: 2 });
  const [alpha, bravo] = s.tids;
  for (const tid of [alpha, bravo]) await s.ok('gm', 'PUT', `/teams/${tid}/notifications`, { webhookUrl: tid === alpha ? HOOK : HOOK_B }, 200);
  s.w.clock.now = NOW;
  for (let i = 0; i < 5; i++) {
    const res = await s.call('gm', 'POST', testPath(s, alpha), {});
    assert.equal(res.status, 200, `post ${i + 1}: ${res.text}`);
  }
  const limited = await s.call('gm', 'POST', testPath(s, alpha), {});
  assert.deepEqual([limited.status, limited.json.error], [429, 'rate_limited']);
  assert(limited.json.retryAfter > 0 && limited.json.retryAfter <= 3600);
  assert.match(limited.json.message, /five test posts this hour/);
  assert.equal(s.net.posts.length, 5, 'the refused one sent nothing');
  assert.equal((await s.call('gm', 'POST', testPath(s, bravo), {})).status, 200, 'Bravo has its own five');
  s.w.clock.now += 61 * 60 * 1000;
  assert.equal((await s.call('gm', 'POST', testPath(s, alpha), {})).status, 200, 'a new hour');
});

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  const only = process.argv[2];
  for (const { name, fn } of checks) {
    if (only && !name.includes(only)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
