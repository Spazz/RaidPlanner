/**
 * Raidsmith guild tracker - lane B6b of the user-hierarchy build, part 1: the READ BUDGETS of the effective-roles view (plan "Model": "Read budgets")
 * Run: node tests/guild/guild-b6b-budgets-tests.js
 *
 * The D1 stand-in counts returned rows in rows_read, so the budget is proved two other ways, on a FLIPPED in-game guild of 1,200 members (rank source 'ingame', rank map set,
 * guild_roster filled, every third character proven by Battle.net so its account derives a role) among 2,000 other guilds:
 *   - EXPLAIN QUERY PLAN of every statement the request ran shows no SCAN of characters, guild_roster, players, role_assignments (or guilds), the views included (their aliases
 *     are read from the view definitions);
 *   - a statement-count assertion from the stand-in's statementLog: the view adds no statement (a view is inline), so each request costs what it cost before.
 * Requests: loadGuildContext, GET /auth/me, the calendar feed, an API-key call, My guilds.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { flip, makeProven } = require('../guild-ingame');
const { scansSince, statementsSince } = require('../guild-plans');
const { NAMESPACE, REALM_ID } = require('../guild-seat');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const MEMBERS = 1200;
const OTHER_GUILDS = 2000;

// The flipped guild: the Owner 'own' (live), a derived Officer 'dof', a derived Team Lead 'dtl' and a plain member 'mem' signed in for real; 1,200 more members written straight
// into the tables. Returns the world with the numbers it measured.
async function bigWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  s.people = {};
  for (const [key, name, rank] of [['own', 'Seatowner', 4], ['dof', 'Derivedoff', 1], ['dtl', 'Derivedlead', 2], ['mem', 'Plainmember', 5]]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
    makeProven(s, key, s.people[key], { rank, proof: key === 'mem' ? 'officer' : 'bnet', link: key !== 'mem' });
  }
  flip(s, { owner: 'own' });
  const sqlite = s.w.db.sqlite;
  sqlite.exec('DROP TRIGGER players_cap'); // a guild holds 1,000 people; the fixture is bigger on purpose
  sqlite.exec('BEGIN');
  const user = sqlite.prepare('INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES (?, ?, ?, 1, 1)');
  const person = sqlite.prepare("INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES (?, ?, 'raider', ?, 1, 1)");
  const character = sqlite.prepare(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
      owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
    VALUES (?, ?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 1, 1, 1, 'raider', NULL, ?, ?, ?, ?, ?, ?, ?)`);
  const link = sqlite.prepare("INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)");
  const roster = sqlite.prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`);
  for (let i = 0; i < MEMBERS; i++) {
    const id = `u_bulk${String(i).padStart(5, '0')}`;
    const proven = i % 3 === 0;
    const charId = 20000 + i;
    user.run(id, id, id);
    person.run(`p_bulk${i}`, s.gid, id);
    character.run(`c_bulk${i}`, s.gid, `p_bulk${i}`, i % 2 === 0 ? s.alpha : s.bravo, `Bulk${i}`, `bulk${i}`,
      proven ? 'bnet' : 'officer', proven ? id : null, proven ? String(600000 + i) : null, proven ? 1 : null, NAMESPACE, REALM_ID, charId);
    if (proven) link.run(id, String(600000 + i), `Bulk${i}#1`);
    roster.run(s.gid, NAMESPACE, REALM_ID, charId, `Bulk${i}`, `bulk${i}`, i % 10);
  }
  // Other guilds of every rank source, crowding guilds.
  const guild = sqlite.prepare(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
    VALUES (?, ?, 'Nightslayer', 'realm', 'US', ?, 'America/New_York', 'tbc', 1, ?)`);
  for (let i = 0; i < OTHER_GUILDS; i++) guild.run(`g_B${String(i).padStart(21, '0')}`, `Big ${String(i).padStart(4, '0')}`, `8${String(i).padStart(17, '0')}`, [null, 'manual', 'ingame'][i % 3]);
  sqlite.exec('COMMIT');
  return s;
}

const dump = (label, found) => assert.deepEqual(found.map((entry) => `${entry.table}: ${entry.detail} :: ${entry.sql}`), [], label);

check('the fixture is what the budgets are about: 1,200 members, every third one proven by Battle.net (about a hundred derived roles), an Owner that is live', async () => {
  const s = await bigWorld();
  const count = (sql, ...values) => s.w.db.sqlite.prepare(sql).get(...values).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM players WHERE guild_id = ?', s.gid), MEMBERS + 4);
  assert.equal(count('SELECT COUNT(*) AS n FROM guild_roster WHERE guild_id = ?', s.gid), MEMBERS + 4);
  assert.equal(count('SELECT COUNT(*) AS n FROM guilds'), OTHER_GUILDS + 1);
  const derived = count("SELECT COUNT(*) AS n FROM effective_roles WHERE guild_id = ? AND source = 'ingame'", s.gid);
  assert(derived > 100, `${derived} derived rows`);
  assert.equal(count("SELECT COUNT(*) AS n FROM effective_roles WHERE guild_id = ? AND source = 'owner'", s.gid), 1);
  assert.equal((await s.ok('own', 'GET', '')).me.roles[0].role, 'guild_master');
});

check('the plan checker sees a scan inside a view: a lookup with no guild and no account walks the tables, a lookup by account does not', async () => {
  const s = await bigWorld();
  const db = s.w.db;
  const from = db.statementLog.length;
  await db.prepare("SELECT guild_id FROM effective_roles WHERE role_id = 'officer'").bind().all();
  const found = scansSince(db, from);
  assert(found.length > 0, 'the full pass is reported');
  assert(found.every((entry) => ['players', 'characters', 'guild_roster', 'role_assignments', 'guilds'].includes(entry.table)));
  const mark = db.statementLog.length;
  await db.prepare('SELECT role_id FROM effective_roles WHERE guild_id = ? AND user_id = ?').bind(s.gid, s.uids.dof).all();
  await db.prepare('SELECT guild_id, role_id FROM effective_roles WHERE user_id = ?').bind(s.uids.dof).all();
  assert.deepEqual(scansSince(db, mark), []);
});

check('loadGuildContext on the flipped guild: no table walked, the same five statements a legacy guild costs, for the Owner, a derived Officer and a plain member', async () => {
  const s = await bigWorld();
  const { loadGuildContext } = await load('worker/permissions.js');
  const db = s.w.db;
  const measured = {};
  for (const key of ['own', 'dof', 'dtl', 'mem']) {
    const from = db.statementLog.length;
    const context = await loadGuildContext(db, s.uids[key], s.gid);
    measured[key] = statementsSince(db, from);
    dump(`loadGuildContext for ${key}`, scansSince(db, from));
    assert.equal(context.userId, s.uids[key]);
  }
  assert.deepEqual(measured, { own: 5, dof: 5, dtl: 5, mem: 5 });
  // A legacy guild costs the same five: the view is inline, it adds no statement.
  const legacy = await scenario();
  const mark = legacy.w.db.statementLog.length;
  await (await load('worker/permissions.js')).loadGuildContext(legacy.w.db, legacy.uids.gm, legacy.gid);
  assert.equal(statementsSince(legacy.w.db, mark), 5);
  console.log(`      measured: loadGuildContext ${JSON.stringify(measured)} statements`);
  // And the answer is right under the load: the derived Team Lead of Alpha, scoped to Alpha.
  const lead = await loadGuildContext(db, s.uids.dtl, s.gid);
  assert.deepEqual(lead.can['roster.edit'], [s.alpha]);
});

check('GET /auth/me and My guilds (memberGuildsStatement) on the flipped guild: no table walked, a fixed statement count', async () => {
  const s = await bigWorld();
  const db = s.w.db;
  const measured = {};
  for (const key of ['own', 'dof', 'mem']) {
    const from = db.statementLog.length;
    const me = await s.ok(key, 'GET', '/auth/me');
    measured[key] = statementsSince(db, from);
    dump(`GET /auth/me for ${key}`, scansSince(db, from));
    assert.deepEqual(me.guilds.map((guild) => guild.id), [s.gid]);
  }
  const roles = (await s.ok('dof', 'GET', '/auth/me')).guilds[0].roles;
  assert.deepEqual(roles, [{ role: 'officer', fromRank: true }]);
  const base = measured.mem;
  // The view adds no statement: every account costs the same.
  assert.deepEqual(measured, { own: base, dof: base, mem: base });
  console.log(`      measured: GET /auth/me ${base} statements (session and CSRF reads included)`);
  assert.equal(base, 8, 'GET /auth/me costs 8 statements');
  const { memberGuildsStatement } = await load('worker/membership.js');
  for (const key of ['own', 'dof', 'dtl', 'mem']) {
    const from = db.statementLog.length;
    const result = await memberGuildsStatement(db, s.uids[key]).all();
    assert.equal(statementsSince(db, from), 1, 'My guilds is ONE statement');
    dump(`My guilds for ${key}`, scansSince(db, from));
    assert.deepEqual(result.results.map((row) => row.id), [s.gid], key);
  }
});

check('the calendar feed on the flipped guild: no table walked, a fixed statement count; the member is still checked on every fetch', async () => {
  const s = await bigWorld();
  const db = s.w.db;
  const made = await s.ok('dof', 'POST', '/calendar', { teamId: s.alpha }, 201);
  const feedPath = new URL(made.url).pathname;
  const fetchFeed = () => s.w.call({}, 'GET', feedPath);
  const from = db.statementLog.length;
  const res = await fetchFeed();
  assert.equal(res.status, 200, res.text);
  dump('GET /cal/<token>.ics', scansSince(db, from));
  const count = statementsSince(db, from);
  console.log(`      measured: calendar feed ${count} statements`);
  assert.equal(count, 14, 'the calendar feed costs 14 statements');
  // The same link stops working the moment the account is not a member any more (the view and the member rule are read every time).
  s.exec(`DELETE FROM guild_roster WHERE guild_id = '${s.gid}' AND blizzard_char_id = (SELECT blizzard_char_id FROM characters WHERE id = '${s.people.dof.cid}')`);
  assert.equal((await fetchFeed()).status, 404);
});

check('an API-key call on the flipped guild: no table walked, a fixed statement count', async () => {
  const s = await bigWorld();
  const db = s.w.db;
  const key = await s.ok('own', 'POST', '/api-keys', { name: 'Budget key', teamId: null, datasets: ['roster', 'raids'], expiresIn: 'never' }, 201);
  const token = key.created.token;
  assert(typeof token === 'string' && token.startsWith('rsk_'));
  const measured = {};
  for (const dataset of ['raids', 'roster']) {
    const from = db.statementLog.length;
    const res = await s.w.call({}, 'GET', `/api/v1/${dataset}.json`, undefined, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, res.text);
    measured[dataset] = statementsSince(db, from);
    dump(`GET /api/v1/${dataset}.json`, scansSince(db, from));
  }
  console.log(`      measured: API-key call ${JSON.stringify(measured)} statements`);
  assert.deepEqual(measured, { raids: 7, roster: 7 });
});

runChecks(checks);
