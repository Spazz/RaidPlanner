/**
 * Raidsmith guild tracker - lane B6a of the user-hierarchy build: the person join and Match to roster
 * (worker/person-join.js, worker/routes/person-join.js, worker/routes/roster-match.js)
 * Run: node tests/guild/guild-b6a-join-tests.js
 *
 *   - the FK introspection: every table that references players(id) is joined by the module or is on its reasoned skip list (PRAGMA foreign_key_list over the schema);
 *   - one rich join with a clash in every keyed table, with the per-table counts of the journal row and no row left on the loser;
 *   - the survivor rules, the three refusals (owned by two, same person, another guild, the 20-character cap), the players fields, the Main and team clashes;
 *   - the Seniority guard (route and inside the batch), a concurrent edit making the whole batch a no-op, the module as a caller's statements (reason 'bnet');
 *   - a recompute of an old raid after the join credits the survivor; the audit row and the Activity view (the loser's id resolves through person_joins);
 *   - Match to roster: the happy path with a rename alias, in-game rank, each refusal, the rights and the guard.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { createD1Fake } = require('../d1-fake');
const { makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const NAMESPACE = 'profile-classicann-us';
const REALM_ID = 4001;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The world

const run = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).run(...values);
const all = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).all(...values);
const one = (s, sql, ...values) => all(s, sql, ...values)[0];
const uid = (s, key) => s.uids[key];

// A guild with three teams, an Officer pair, a Team Lead of Alpha and two members.
async function world({ teams = ['Alpha', 'Bravo', 'Charlie'] } = {}) {
  const s = await scenario({ teams });
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.lead('tl', [s.tids[0]], 'Leadone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  return s;
}

const versionsOf = (s, a, b) => ({ version: one(s, 'SELECT version FROM players WHERE id = ?', a).version, otherVersion: one(s, 'SELECT version FROM players WHERE id = ?', b).version });
// POST /roster/:a/join with the versions as they are now.
async function join(s, who, a, b, extra = {}) {
  return s.call(who, 'POST', `/roster/${a}/join`, { otherPersonId: b, ...versionsOf(s, a, b), ...extra });
}

const raidCounter = { n: 0 };
// A raid on a team (a date of January 2027, before the world's clock: a PAST raid).
async function raid(s, teamId, day) {
  const res = await s.ok('gm', 'POST', '/raids', { teamId, raidOn: `2027-01-${String(day).padStart(2, '0')}`, startTime: '20:00', zone: "Gruul's Lair" });
  return res.raid.id;
}

// Every row of the person in the tables of JOIN_TABLES.
async function rowsOf(s, personId) {
  const { JOIN_TABLES } = await load('worker/person-join.js');
  const out = {};
  for (const table of Object.keys(JOIN_TABLES)) out[table] = one(s, `SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ? AND player_id = ?`, s.gid, personId).n;
  return out;
}

// ---------------------------------------------------------------------------
// The FK introspection

check('every table that references players(id) is joined by the module or is on its reasoned skip list', async () => {
  const { JOIN_TABLES, JOIN_SKIPPED, JOIN_LOGICAL } = await load('worker/person-join.js');
  const db = createD1Fake();
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const referencing = tables.filter((table) => db.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all().some((fk) => fk.table === 'players'));
  assert(referencing.length >= 14, `the schema should show at least the 14 known tables, saw ${referencing.join(', ')}`);
  for (const table of referencing) {
    assert(JOIN_TABLES[table] || JOIN_SKIPPED[table], `${table} references players(id) and is neither joined (JOIN_TABLES) nor skipped with a reason (JOIN_SKIPPED)`);
    if (JOIN_SKIPPED[table]) assert(String(JOIN_SKIPPED[table]).length > 10, `${table}: the skip needs a reason`);
  }
  for (const table of [...Object.keys(JOIN_TABLES), ...Object.keys(JOIN_SKIPPED)]) {
    assert(referencing.includes(table), `${table} is listed by the module but no longer references players(id)`);
  }
  // The listed logical references are real tables or the audit log.
  for (const table of Object.keys(JOIN_LOGICAL)) assert(tables.includes(table), `${table} is not a table`);
  // Every joined table has the columns the statements use.
  for (const [table, spec] of Object.entries(JOIN_TABLES)) {
    const columns = db.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const column of ['guild_id', 'player_id', ...(spec.keys || [])]) assert(columns.includes(column), `${table} has no column ${column}`);
  }
});

// ---------------------------------------------------------------------------
// The rich join: a clash in every keyed table

const LOSE_DISCORD = '110000000000009901';
async function richWorld() {
  const s = await world();
  const [alpha, bravo, charlie] = s.tids;
  const L = await s.person({ name: 'Losemain' }); // older, no account
  const S = await s.person({ name: 'Survmain' }); // newer, linked to m1: survives
  await s.link(S.pid, 'm1');
  const survAlt = await s.alt(S.pid, 'Survalt');
  s.setTeam(survAlt, bravo);
  const loseAlt = await s.alt(L.pid, 'Losealt');
  s.setTeam(loseAlt, bravo); // the same team as Survalt
  const loseCharlie = await s.alt(L.pid, 'Losecharlie');
  s.setTeam(loseCharlie, charlie);
  const loseFree = await s.alt(L.pid, 'Losefree'); // on no team
  const g = s.gid;
  const r = {};
  for (let i = 1; i <= 7; i++) r[i] = await raid(s, alpha, i);
  run(s, "UPDATE raids SET policy_fp = 'x'");

  // attendance: r1 both (S present, L missed), r2 only L
  const att = (raidId, pid, outcome) => run(s, 'INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 1)', raidId, g, alpha, pid, outcome);
  att(r[1], S.pid, 'present'); att(r[1], L.pid, 'missed'); att(r[2], L.pid, 'present');
  const decide = (raidId, pid, outcome) => run(s, "INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, reason, flags, decided_at) VALUES (?, ?, ?, ?, 0, 'Told us', '[]', 1)", raidId, pid, g, outcome);
  decide(r[1], S.pid, 'bench'); decide(r[1], L.pid, 'missed_notice'); decide(r[2], L.pid, 'bench');
  const manual = (raidId, pid) => run(s, 'INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES (?, ?, ?)', raidId, g, pid);
  manual(r[1], S.pid); manual(r[1], L.pid); manual(r[6], L.pid);
  // native sign-ups (signup_id 1 = the survivor's, 2 = the loser's)
  const signup = (raidId, pid, id, updated) => run(s, "INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, created_at, updated_at) VALUES (?, 'raidsmith', ?, 'signed', 1, ?, ?, 1, ?)", raidId, id, g, pid, updated);
  signup(r[1], S.pid, 1, 100); signup(r[1], L.pid, 2, 200); // r1: the survivor's seat is confirmed -> the survivor's stays although the loser's is newer
  signup(r[2], S.pid, 1, 100); signup(r[2], L.pid, 2, 200); // r2: neither confirmed, the loser's is newer -> the loser's wins
  signup(r[3], S.pid, 1, 300); signup(r[3], L.pid, 2, 200); // r3: the survivor's is newer -> the survivor's stays
  signup(r[4], S.pid, 1, 100); signup(r[4], L.pid, 2, 200); // r4: the loser's seat is confirmed -> the loser's wins
  signup(r[5], L.pid, 2, 200); // r5: only the loser: moves
  run(s, "INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, discord_user_id) VALUES (?, 'raid_helper', 7001, 'signed', 1, ?, ?, ?)", r[1], g, L.pid, LOSE_DISCORD);
  const seat = (raidId, pid, key, status) => run(s, 'INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, status) VALUES (?, ?, ?, ?, ?, 1, ?)', raidId, g, key, key, pid, status);
  seat(r[1], S.pid, 'survmain', 'confirmed'); seat(r[4], L.pid, 'losemain', 'confirmed'); seat(r[2], L.pid, 'losemain', 'pending');
  // away notices (no unique key), standing sign-ups (team, person, weekday), the spec poll, an application, a rank suggestion, the launch funnel, a duty
  const away = (id, pid) => run(s, "INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, 'away', '2027-02-01', '2027-02-05', 1, 1)", id, g, pid);
  away('an_surv0000000000000001', S.pid); away('an_lose0000000000000001', L.pid); away('an_lose0000000000000002', L.pid);
  const standing = (id, pid, weekday) => run(s, "INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'signed', 1, 1)", id, g, alpha, pid, weekday);
  standing('sg_surv0000000000000001', S.pid, 2); standing('sg_lose0000000000000001', L.pid, 2); standing('sg_lose0000000000000002', L.pid, 4);
  run(s, "INSERT INTO intent_rounds (id, guild_id, team_id, title, status, created_at) VALUES ('ir_round00000000000001', ?, ?, 'Round', 'open', 1)", g, alpha);
  const pick = (pid, kind) => run(s, "INSERT INTO intent_picks (round_id, guild_id, player_id, kind, class, spec, role, updated_at) VALUES ('ir_round00000000000001', ?, ?, ?, 'MAGE', 'Fire', 'ranged', 1)", g, pid, kind);
  pick(S.pid, 'main'); pick(L.pid, 'main'); pick(L.pid, 'alt');
  run(s, "INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, class, answers, player_id, created_at, updated_at) VALUES ('am_app00000000000000001', ?, ?, 'accepted', 'Losemain', 'losemain', 'MAGE', '[]', ?, 1, 1)", g, alpha, L.pid);
  const dismissal = (pid) => run(s, "INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, 'promote', 'core', 9999999999999, 1)", g, pid);
  dismissal(S.pid); dismissal(L.pid);
  const launch = (pid, team) => run(s, 'INSERT INTO launch_status (guild_id, team_id, player_id, ready, updated_at) VALUES (?, ?, ?, 1, 1)', g, team, pid);
  launch(S.pid, alpha); launch(L.pid, alpha); launch(L.pid, bravo);
  run(s, "INSERT INTO raid_duties (raid_id, guild_id, duty, player_id) VALUES (?, ?, 'leader', ?)", r[1], g, L.pid);
  run(s, "INSERT INTO raid_duties (raid_id, guild_id, duty, player_id) VALUES (?, ?, 'loot', ?)", r[2], g, S.pid);
  run(s, "INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, created_at) VALUES (?, ?, ?, 'Spammed the channel', 5)", g, L.pid, uid(s, 'gm'));
  const attention = (id, item, kind, team) => run(s, "INSERT INTO attention_dismissals (id, guild_id, item_id, kind, team_id, mode, until, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, 'snooze', 9999999999999, 'fp', 1)", id, g, item, kind, team);
  attention('ad_a', `trial:${S.pid}`, 'trial', alpha); attention('ad_b', `trial:${L.pid}`, 'trial', alpha);
  attention('ad_c', `trial:${L.pid}:${bravo}`, 'trial', bravo); attention('ad_d', `watch:${alpha}:${L.pid}`, 'watch', alpha);
  attention('ad_e', `review:${r[1]}`, 'review', alpha);
  run(s, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('na_old0000000000000001', ?, ?, 'oldfree', 'nightslayer', 5)", g, loseFree);
  return { s, S, L, r, alpha, bravo, charlie, ids: { survAlt, loseAlt, loseCharlie, loseFree } };
}

check('a rich join: a clash in every keyed table, the survivor\'s row wins (the confirmed or newer sign-up excepted), per-table counts, nothing left on the loser', async () => {
  const { s, S, L, r, alpha, bravo, charlie } = await richWorld();
  const survivorVersion = one(s, 'SELECT version FROM players WHERE id = ?', S.pid).version;
  const res = await join(s, 'o1', L.pid, S.pid); // the officer opens the OLDER person: the survivor is still the linked one
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.survivorId, S.pid);
  assert.equal(res.json.loserId, L.pid);
  assert.equal(res.json.person.id, S.pid, 'the reply is the survivor\'s person record');
  assert.equal(res.json.characters.length, 6);

  const expected = {
    characters: { moved: 4, dropped: 0, teamCleared: 2, mainDemoted: 1 },
    raid_signups: { moved: 4, dropped: 4 },
    raid_manual: { moved: 1, dropped: 1 },
    attendance: { moved: 1, dropped: 1 },
    attendance_decisions: { moved: 1, dropped: 1 },
    away_notices: { moved: 2, dropped: 0 },
    standing_signups: { moved: 1, dropped: 1 },
    raid_roster: { moved: 2, dropped: 0 },
    intent_picks: { moved: 1, dropped: 1 },
    applications: { moved: 1, dropped: 0 },
    rank_dismissals: { moved: 0, dropped: 1 },
    launch_status: { moved: 1, dropped: 1 },
    raid_duties: { moved: 1, dropped: 0 },
    person_blocks: { moved: 0, dropped: 0, guildBlocks: 1 },
    attention_dismissals: { moved: 2, dropped: 1 },
    character_name_aliases: { moved: 1, dropped: 0 },
  };
  assert.deepEqual(res.json.counts, expected);
  const journal = all(s, 'SELECT * FROM person_joins');
  assert.equal(journal.length, 1);
  assert.deepEqual(JSON.parse(journal[0].counts), expected);
  assert.deepEqual([journal[0].survivor_player_id, journal[0].loser_player_id, journal[0].joined_by, journal[0].guild_id], [S.pid, L.pid, uid(s, 'o1'), s.gid]);

  // nothing of the loser is left anywhere
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', L.pid).n, 0);
  const { JOIN_TABLES } = await load('worker/person-join.js');
  for (const table of Object.keys(JOIN_TABLES)) assert.equal(one(s, `SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`, L.pid).n, 0, `${table} still names the loser`);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM attention_dismissals WHERE instr(item_id, ?) > 0', L.pid).n, 0);

  // characters: the survivor's Main stays the only Main, the survivor's teams stay, the loser's clashing teams are cleared, the free team moves
  const chars = Object.fromEntries(all(s, 'SELECT name, team_id, is_main FROM characters WHERE player_id = ?', S.pid).map((row) => [row.name, [row.team_id, row.is_main]]));
  assert.deepEqual(chars, {
    Survmain: [alpha, 1], Survalt: [bravo, 0], Losemain: [null, 0], Losealt: [null, 0], Losecharlie: [charlie, 0], Losefree: [null, 0],
  });
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ? AND is_main = 1', S.pid).n, 1);
  assert.equal(one(s, 'SELECT c.player_id FROM character_name_aliases a JOIN characters c ON c.id = a.character_id WHERE a.id = ?', 'na_old0000000000000001').player_id, S.pid, 'the alias follows its character');

  // sign-ups: the confirmed one, else the newer, else the survivor's
  const signupIds = Object.fromEntries(all(s, "SELECT raid_id, signup_id FROM raid_signups WHERE source = 'raidsmith' AND player_id = ?", S.pid).map((row) => [row.raid_id, row.signup_id]));
  assert.deepEqual(signupIds, { [r[1]]: 1, [r[2]]: 2, [r[3]]: 1, [r[4]]: 2, [r[5]]: 2 });
  assert.equal(one(s, "SELECT COUNT(*) AS n FROM raid_signups WHERE source = 'raid_helper' AND player_id = ?", S.pid).n, 1);
  // the other keyed tables: the survivor's row wins
  assert.equal(one(s, 'SELECT outcome FROM attendance WHERE raid_id = ? AND player_id = ?', r[1], S.pid).outcome, 'present');
  assert.equal(one(s, 'SELECT outcome FROM attendance WHERE raid_id = ? AND player_id = ?', r[2], S.pid).outcome, 'present', 'the loser\'s row moved');
  assert.equal(one(s, 'SELECT outcome FROM attendance_decisions WHERE raid_id = ? AND player_id = ?', r[1], S.pid).outcome, 'bench');
  assert.equal(one(s, 'SELECT outcome FROM attendance_decisions WHERE raid_id = ? AND player_id = ?', r[2], S.pid).outcome, 'bench', 'no decision of the survivor: the loser\'s moves');
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM raid_manual WHERE player_id = ?', S.pid).n, 2);
  assert.deepEqual(all(s, 'SELECT weekday FROM standing_signups WHERE player_id = ? ORDER BY weekday', S.pid).map((row) => row.weekday), [2, 4]);
  assert.equal(one(s, 'SELECT id FROM standing_signups WHERE player_id = ? AND weekday = 2', S.pid).id, 'sg_surv0000000000000001');
  assert.deepEqual(all(s, 'SELECT kind FROM intent_picks WHERE player_id = ? ORDER BY kind', S.pid).map((row) => row.kind), ['alt', 'main']);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM applications WHERE player_id = ?', S.pid).n, 1);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM rank_dismissals WHERE player_id = ?', S.pid).n, 1);
  assert.deepEqual(all(s, 'SELECT team_id FROM launch_status WHERE player_id = ?', S.pid).map((row) => row.team_id).sort(), [alpha, bravo].sort());
  assert.deepEqual(all(s, 'SELECT duty FROM raid_duties WHERE player_id = ? ORDER BY duty', S.pid).map((row) => row.duty), ['leader', 'loot']);
  assert.deepEqual(all(s, 'SELECT status FROM raid_roster WHERE player_id = ?', S.pid).map((row) => row.status).sort(), ['confirmed', 'confirmed', 'pending']);
  // the dismissed items are re-keyed to the survivor, the unrelated one is untouched
  assert.deepEqual(all(s, 'SELECT item_id FROM attention_dismissals').map((row) => row.item_id).sort(), [
    `review:${r[1]}`, `trial:${S.pid}`, `trial:${S.pid}:${bravo}`, `watch:${alpha}:${S.pid}`,
  ].sort());
  // the block: the survivor's account is blocked, the person_blocks row went with the loser
  const block = one(s, 'SELECT * FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, uid(s, 'm1'));
  assert.deepEqual([block.blocked_by, block.reason, block.created_at], [uid(s, 'gm'), 'Spammed the channel', 5]);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM person_blocks').n, 0);
  // stale marking: every raid that held the loser's rows, and the survivor's team raids with evidence; a raid with no evidence stays as it was
  const fps = Object.fromEntries(all(s, 'SELECT id, policy_fp FROM raids').map((row) => [row.id, row.policy_fp]));
  for (const i of [1, 2, 3, 4, 5, 6]) assert.equal(fps[r[i]], '', `raid ${i} is stale`);
  assert.equal(fps[r[7]], 'x', 'a raid with no evidence at all is not touched');
  // the survivor's row
  assert.equal(one(s, 'SELECT version FROM players WHERE id = ?', S.pid).version, survivorVersion + 1);
});

// ---------------------------------------------------------------------------
// Survivors, refusals, the cap, the players fields

const pid22 = (tag) => `p_${(tag + '0'.repeat(22)).slice(0, 22)}`;
const tablesToWatch = async () => {
  const { JOIN_TABLES } = await load('worker/person-join.js');
  return ['players', 'characters', 'raids', 'audit_log', 'person_joins', 'guild_blocks', 'attention_dismissals', 'character_name_aliases', ...Object.keys(JOIN_TABLES)];
};
// Every row of every table a join could touch, as one string: a refused or lost join leaves it exactly as it was.
async function snapshot(s) {
  return JSON.stringify((await tablesToWatch()).map((table) => all(s, `SELECT * FROM ${table}`)));
}
const mk = (s, name, extra = {}) => s.person({ name, ...extra });

check('the survivor is the account-linked person, else the older one (created_at, then id), whichever one the officer opens', async () => {
  const s = await world();
  const older = await mk(s, 'Olda');
  const newer = await mk(s, 'Newb');
  let res = await join(s, 'o1', newer.pid, older.pid);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.json.survivorId, res.json.loserId], [older.pid, newer.pid], 'neither linked: the older');
  // the same created_at: the lower id
  const c = await mk(s, 'Tiec');
  const d = await mk(s, 'Tied');
  run(s, 'UPDATE players SET created_at = 1 WHERE id IN (?, ?)', c.pid, d.pid);
  const [low, high] = [c.pid, d.pid].sort();
  res = await join(s, 'o1', high, low);
  assert.deepEqual([res.json.survivorId, res.json.loserId], [low, high], 'the same age: the lower id');
  // the newer person is the one linked to an account: it survives
  const e = await mk(s, 'Olde');
  const f = await mk(s, 'Newf');
  await s.link(f.pid, 'm1');
  res = await join(s, 'o1', e.pid, f.pid);
  assert.deepEqual([res.json.survivorId, res.json.loserId], [f.pid, e.pid], 'the linked person');
  assert.equal(one(s, 'SELECT user_id FROM players WHERE id = ?', f.pid).user_id, uid(s, 'm1'), 'and it keeps its account');
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM person_joins').n, 3);
});

check('refused: both persons owned by different accounts, the same person twice, a person of another guild, a missing or malformed body; nothing changes', async () => {
  const s = await world();
  const a = await mk(s, 'Linka');
  const b = await mk(s, 'Linkb');
  await s.link(a.pid, 'm1');
  await s.link(b.pid, 'm2');
  const refused = async (call, status, error) => {
    const before = await snapshot(s);
    const res = await call();
    assert.equal(res.status, status, res.text);
    if (error) assert.equal(res.json.error, error, res.text);
    assert.equal(await snapshot(s), before, 'a refused join changes nothing');
    return res;
  };
  await refused(() => join(s, 'o1', a.pid, b.pid), 409, 'join_owned_by_two');
  // one person owned through the account link, the other through its Discord ID (which is another account's)
  const c = await mk(s, 'Discc');
  run(s, 'UPDATE players SET discord_user_id = (SELECT discord_id FROM users WHERE id = ?) WHERE id = ?', uid(s, 'm2'), c.pid);
  await refused(() => join(s, 'o1', a.pid, c.pid), 409, 'join_owned_by_two');
  // two Discord IDs nobody has signed in with
  const d = await mk(s, 'Unknd');
  const e = await mk(s, 'Unkne');
  run(s, "UPDATE players SET discord_user_id = '110000000000008801' WHERE id = ?", d.pid);
  run(s, "UPDATE players SET discord_user_id = '110000000000008802' WHERE id = ?", e.pid);
  await refused(() => join(s, 'o1', d.pid, e.pid), 409, 'join_owned_by_two');
  // the same person
  await refused(() => join(s, 'o1', a.pid, a.pid, { version: 1, otherVersion: 1 }), 400, 'bad_request');
  // another guild's person: 404
  run(s, "INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g_otherguild0000000000001', 'Other', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1)");
  const foreign = pid22('foreign');
  run(s, "INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES (?, 'g_otherguild0000000000001', 'raider', 1, 1)", foreign);
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/join`, { otherPersonId: foreign, version: 1, otherVersion: 1 }), 404, 'not_found');
  await refused(() => s.call('o1', 'POST', `/roster/${foreign}/join`, { otherPersonId: a.pid, version: 1, otherVersion: 1 }), 404, 'not_found');
  await refused(() => s.call('o1', 'POST', `/roster/${pid22('nobody')}/join`, { otherPersonId: a.pid, version: 1, otherVersion: 1 }), 404, 'not_found');
  // the body
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/join`, { version: 1, otherVersion: 1 }), 400, 'bad_request');
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/join`, { otherPersonId: b.pid, version: 'one', otherVersion: 1 }), 400, 'bad_request');
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/join`, { otherPersonId: b.pid, version: 1 }), 400, 'bad_request');
  // an account that may edit one team only, and a member
  const freeA = await mk(s, 'Freea');
  const freeB = await mk(s, 'Freeb');
  await refused(() => join(s, 'tl', freeA.pid, freeB.pid), 403, 'forbidden');
  await refused(() => join(s, 'm1', a.pid, b.pid), 403, 'forbidden');
});

// Characters of a person, added by the row (the cap trigger counts only inserts, and 20 is allowed).
function addCharacters(s, personId, count, prefix) {
  for (let i = 0; i < count; i++) {
    run(s, `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank)
            VALUES (?, ?, ?, NULL, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 0, 1, 1, 'raider')`,
    `c_${prefix}${String(i).padStart(2, '0')}`.padEnd(24, '0'), s.gid, personId, `${prefix}${i}`, `${prefix}${i}`.toLowerCase());
  }
}

check('the 20-character cap: 20 together join, 21 are refused with join_too_many_characters and nothing changes', async () => {
  const s = await world();
  const a = await mk(s, 'Capa');
  const b = await mk(s, 'Capb');
  addCharacters(s, a.pid, 10, 'aa'); // 11 with the Main
  addCharacters(s, b.pid, 10, 'bb'); // 11: 22 together
  let before = await snapshot(s);
  let res = await join(s, 'o1', a.pid, b.pid);
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'join_too_many_characters');
  assert.equal(await snapshot(s), before);
  run(s, "DELETE FROM characters WHERE name = 'bb9' OR name = 'bb8'"); // 20 together
  res = await join(s, 'o1', a.pid, b.pid);
  assert.equal(res.status, 200, res.text);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ?', res.json.survivorId).n, 20);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ? AND is_main = 1', res.json.survivorId).n, 1);
});

check('the players row: notes appended (cut at 4000), earliest joined_on, the survivor\'s rank, the survivor\'s own Discord pair, version bumped, the loser gone', async () => {
  const s = await world();
  const a = await mk(s, 'Fielda');
  const b = await mk(s, 'Fieldb');
  run(s, "UPDATE players SET notes = 'First note', notes_version = 2, joined_on = '2026-05-01', rank = 'core', rank_on = '2026-06-01', discord_user_id = '110000000000007701', discord_nickname = 'Anick' WHERE id = ?", a.pid);
  run(s, "UPDATE players SET notes = 'Second note', notes_version = 5, joined_on = '2026-03-01', rank = 'trial', rank_on = '2026-02-01', discord_user_id = '110000000000007702', discord_nickname = 'Bnick' WHERE id = ?", b.pid);
  // both carry a Discord ID: two unmatched Discord identities are two owners
  assert.equal((await join(s, 'o1', a.pid, b.pid)).status, 409);
  run(s, 'UPDATE players SET discord_user_id = NULL, discord_nickname = NULL WHERE id = ?', b.pid);
  const res = await join(s, 'o1', a.pid, b.pid);
  assert.equal(res.status, 200, res.text);
  const row = one(s, 'SELECT * FROM players WHERE id = ?', a.pid);
  assert.equal(row.notes, 'First note\n\nSecond note');
  assert.equal(row.notes_version, 3);
  assert.equal(row.notes_updated_by, uid(s, 'o1'));
  assert.equal(row.joined_on, '2026-03-01');
  assert.deepEqual([row.rank, row.rank_on], ['core', '2026-06-01']);
  assert.deepEqual([row.discord_user_id, row.discord_nickname], ['110000000000007701', 'Anick']);
  assert.equal(row.version, 2);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', b.pid).n, 0);

  // only the loser has notes / an earlier date / no joined_on at all; the 4000-character cap
  const c = await mk(s, 'Fieldc');
  const d = await mk(s, 'Fieldd');
  run(s, 'UPDATE players SET notes = ? WHERE id = ?', 'x'.repeat(3000), c.pid);
  run(s, "UPDATE players SET notes = ?, joined_on = '2026-01-01' WHERE id = ?", 'y'.repeat(2000), d.pid);
  const joined = await join(s, 'o1', c.pid, d.pid);
  assert.equal(joined.status, 200, joined.text);
  const cut = one(s, 'SELECT notes, notes_version, joined_on FROM players WHERE id = ?', c.pid);
  assert.equal(cut.notes.length, 4000);
  assert.equal(cut.notes.startsWith(`${'x'.repeat(3000)}\n\n${'y'.repeat(998)}`), true);
  assert.deepEqual([cut.notes_version, cut.joined_on], [1, '2026-01-01']);
  const e = await mk(s, 'Fielde');
  const f = await mk(s, 'Fieldf');
  run(s, "UPDATE players SET notes = 'Only the loser' WHERE id = ?", f.pid);
  await join(s, 'o1', e.pid, f.pid);
  assert.equal(one(s, 'SELECT notes FROM players WHERE id = ?', e.pid).notes, 'Only the loser');
  const g = await mk(s, 'Fieldg');
  const h = await mk(s, 'Fieldh');
  run(s, "UPDATE players SET notes = 'Only the survivor' WHERE id = ?", g.pid);
  await join(s, 'o1', g.pid, h.pid);
  assert.deepEqual([one(s, 'SELECT notes, notes_version FROM players WHERE id = ?', g.pid).notes, one(s, 'SELECT notes_version FROM players WHERE id = ?', g.pid).notes_version], ['Only the survivor', 0]);
});

check('the Discord pair: the survivor keeps its own; takes the loser\'s when it has none and nobody owns it, or the ID is its account\'s own; never a stranger\'s ID for an account-linked person', async () => {
  const s = await world();
  const discordOf = (key) => one(s, 'SELECT discord_id FROM users WHERE id = ?', uid(s, key)).discord_id;
  // the same account twice: user_id on one, its Discord ID on the other; the linked one survives (although newer) and takes the pair
  const owner = await mk(s, 'Sameowner');
  run(s, 'UPDATE players SET discord_user_id = ?, discord_nickname = ? WHERE id = ?', discordOf('m1'), 'Nick', owner.pid);
  const linked = await mk(s, 'Linkedone');
  run(s, 'UPDATE players SET user_id = ? WHERE id = ?', uid(s, 'm1'), linked.pid); // the route refuses an account whose Discord ID another person carries
  let res = await join(s, 'o1', linked.pid, owner.pid);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.survivorId, linked.pid);
  assert.deepEqual([discordOf('m1'), 'Nick'], [one(s, 'SELECT discord_user_id FROM players WHERE id = ?', linked.pid).discord_user_id, one(s, 'SELECT discord_nickname FROM players WHERE id = ?', linked.pid).discord_nickname]);
  assert.equal(one(s, 'SELECT user_id FROM players WHERE id = ?', linked.pid).user_id, uid(s, 'm1'));
  // an account-linked person and a person that carries a stranger's Discord ID are two owners: refused, so the stranger's ID never reaches the linked person
  const m2person = await mk(s, 'Linkedtwo');
  await s.link(m2person.pid, 'm2');
  const stranger = await mk(s, 'Strangerd');
  run(s, "UPDATE players SET discord_user_id = '110000000000006601', discord_nickname = 'Stranger' WHERE id = ?", stranger.pid);
  res = await join(s, 'o1', m2person.pid, stranger.pid);
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'join_owned_by_two');
  assert.deepEqual(Object.values(one(s, 'SELECT discord_user_id, discord_nickname FROM players WHERE id = ?', m2person.pid)), [null, null]);
  // nobody owns the survivor: it takes the loser's pair (the loser's unique field is cleared first)
  const bare = await mk(s, 'Barea');
  const holder = await mk(s, 'Holderb');
  run(s, "UPDATE players SET discord_user_id = '110000000000006602', discord_nickname = 'Holder' WHERE id = ?", holder.pid);
  res = await join(s, 'o1', bare.pid, holder.pid);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.survivorId, bare.pid);
  assert.deepEqual(Object.values(one(s, 'SELECT discord_user_id, discord_nickname FROM players WHERE id = ?', bare.pid)), ['110000000000006602', 'Holder']);
});

// ---------------------------------------------------------------------------
// The Seniority guard, concurrent edits, the module as a caller's statements

async function planFor(s, a, b, extra = {}) {
  const { joinPersonsStatements } = await load('worker/person-join.js');
  return joinPersonsStatements(s.w.db, {
    guildId: s.gid, aId: a, bId: b, actorUserId: uid(s, 'o1'), now: s.w.clock.now, reason: 'officer', randomBytes: s.w.randomBytes, ...extra,
  });
}

check('the Seniority guard: an Officer cannot join an equal or senior person, a Team Lead cannot join at all, a junior with the right still cannot touch a senior\'s person', async () => {
  const s = await world();
  const own = {};
  for (const [key, name] of Object.entries({ o2: 'Otwoperson', m1: 'Moneperson', gm: 'Gmperson', tl: 'Tlperson' })) {
    own[key] = await mk(s, name);
    await s.link(own[key].pid, key);
  }
  const free = async (name) => (await mk(s, name)).pid;
  const refused = async (who, a, b, status, error) => {
    const before = await snapshot(s);
    const res = await join(s, who, a, b);
    assert.equal(res.status, status, `${who}: ${res.text}`);
    assert.equal(res.json.error, error);
    assert.equal(await snapshot(s), before);
  };
  // an Officer: not an equal Officer's person, not the Guild Master's, either way round
  await refused('o1', await free('Freeone'), own.o2.pid, 403, 'seniority');
  await refused('o1', own.o2.pid, await free('Freetwo'), 403, 'seniority');
  await refused('o1', await free('Freethree'), own.gm.pid, 403, 'seniority');
  // a Team Lead of Alpha is no guild-wide editor: refused before the guard, a senior's person or not
  await refused('tl', await free('Freefour'), own.o2.pid, 403, 'forbidden');
  // a Member's person is below an Officer: allowed
  const ok = await join(s, 'o1', await free('Freefive'), own.m1.pid);
  assert.equal(ok.status, 200, ok.text);
  // the Guild Master may join an Officer's person
  assert.equal((await join(s, 'gm', await free('Freesix'), own.o2.pid)).status, 200);

  // a custom role that holds roster.edit for the whole guild ranks as a Member: it joins people nobody owns, not an Officer's, not an equal Member's
  const made = await s.ok('gm', 'POST', '/roles', { name: 'Roster keeper', permissions: { 'roster.edit': 'guild' } });
  const roleId = made.roles.find((role) => role.name === 'Roster keeper').id;
  await s.member('cm', 'Custommember');
  run(s, "INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES ('ra_keeper000000000000001', ?, ?, ?, NULL, 1)", s.gid, uid(s, 'cm'), roleId);
  const officerPerson = await mk(s, 'Oneperson');
  await s.link(officerPerson.pid, 'o1');
  const memberPerson = await mk(s, 'Mtwoperson');
  await s.link(memberPerson.pid, 'm2');
  await refused('cm', await free('Freeseven'), officerPerson.pid, 403, 'seniority');
  await refused('cm', await free('Freeeight'), memberPerson.pid, 403, 'seniority');
  assert.equal((await join(s, 'cm', await free('Freenine'), await free('Freeten'))).status, 200);
});

check('the Seniority guard sits inside the batch: a promotion between the read and the write makes every statement a no-op', async () => {
  const s = await world();
  const target = await mk(s, 'Promoted');
  await s.link(target.pid, 'm2');
  const other = await mk(s, 'Otherfree');
  const { seniorityOk } = await load('worker/seniority.js');
  const plan = await planFor(s, other.pid, target.pid, { guards: [seniorityOk(s.gid, uid(s, 'o1'), other.pid), seniorityOk(s.gid, uid(s, 'o1'), target.pid)] });
  // the target's account becomes an Officer (equal to the actor) after the plan was read
  await s.ok('gm', 'PUT', `/people/${uid(s, 'm2')}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  const before = await snapshot(s);
  const results = await s.w.db.batch(plan.statements);
  assert.equal(results[plan.appliedIndex].meta.changes, 0);
  assert(results.every((result) => result.meta.changes === 0), 'every statement is a no-op');
  assert.equal(await snapshot(s), before);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', plan.loserId).n, 1);
});

check('a concurrent edit makes the whole batch a no-op: a version bump, a notes edit, a character added past the cap; a stale page gets 409 with the current record', async () => {
  const s = await world();
  const read = async (name1, name2) => {
    const a = await mk(s, name1);
    const b = await mk(s, name2);
    return { a, b, plan: await planFor(s, a.pid, b.pid) };
  };
  const noop = async (plan) => {
    const before = await snapshot(s);
    const results = await s.w.db.batch(plan.statements);
    assert.equal(results[plan.appliedIndex].meta.changes, 0);
    assert(results.every((result) => result.meta.changes === 0), 'every statement is a no-op');
    assert.equal(await snapshot(s), before);
  };
  // the survivor was edited (version moved)
  let t = await read('Racea', 'Raceb');
  run(s, 'UPDATE players SET version = version + 1 WHERE id = ?', t.plan.survivorId);
  await noop(t.plan);
  // the loser was edited
  t = await read('Racec', 'Raced');
  run(s, 'UPDATE players SET version = version + 1 WHERE id = ?', t.plan.loserId);
  await noop(t.plan);
  // a notes edit does not bump version, but notes_version
  t = await read('Racee', 'Racef');
  run(s, "UPDATE players SET notes = 'late', notes_version = notes_version + 1 WHERE id = ?", t.plan.loserId);
  await noop(t.plan);
  // a character added to a person after the read, past the cap
  t = await read('Raceg', 'Raceh');
  addCharacters(s, t.plan.survivorId, 19, 'rc');
  await noop(t.plan);
  // the person is gone
  t = await read('Racei', 'Racej');
  run(s, 'DELETE FROM players WHERE id = ?', t.plan.loserId);
  await noop(t.plan);

  // through the route: the page that sent the old version gets 409 and the record as it is now
  const a = await mk(s, 'Stalea');
  const b = await mk(s, 'Staleb');
  const stale = versionsOf(s, a.pid, b.pid);
  run(s, 'UPDATE players SET version = version + 1 WHERE id = ?', b.pid);
  const before = await snapshot(s);
  const res = await s.call('o1', 'POST', `/roster/${a.pid}/join`, { otherPersonId: b.pid, ...stale });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'conflict');
  assert.equal(res.json.current.person.id, a.pid);
  assert.equal(await snapshot(s), before);
});

check('the module hands a caller its statements (reason bnet): they run inside the caller\'s own batch, extra guards are honoured, the audit row says how it was proved', async () => {
  const s = await world();
  const a = await mk(s, 'Biga');
  const b = await mk(s, 'Bigb');
  const c = await mk(s, 'Bigc');
  const d = await mk(s, 'Bigd');
  const { joinPersonsStatements, JOIN_REASONS } = await load('worker/person-join.js');
  assert.deepEqual([...JOIN_REASONS], ['officer', 'bnet']);
  await assert.rejects(() => joinPersonsStatements(s.w.db, { guildId: s.gid, aId: a.pid, bId: b.pid, actorUserId: null, now: 1, reason: 'magic' }), /officer or bnet/);
  // a caller's guard that fails: nothing happens, whatever else the caller batched
  const stuck = await planFor(s, a.pid, b.pid, { reason: 'bnet', guards: [{ sql: '0 = 1', params: [] }] });
  const marker = () => s.w.db.prepare("UPDATE guilds SET name = 'Renamed by the caller' WHERE id = ? AND EXISTS (SELECT 1 FROM person_joins)").bind(s.gid);
  const stuckResults = await s.w.db.batch([...stuck.statements, marker()]);
  assert.equal(stuckResults[stuck.appliedIndex].meta.changes, 0);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', stuck.loserId).n, 1);
  assert.notEqual(one(s, 'SELECT name FROM guilds WHERE id = ?', s.gid).name, 'Renamed by the caller');
  // a caller's guard that holds: the join and the caller's own statement land together
  const live = await planFor(s, c.pid, d.pid, { reason: 'bnet', actorUserId: uid(s, 'm1'), guards: [{ sql: 'EXISTS (SELECT 1 FROM users WHERE id = ?)', params: [uid(s, 'm1')] }] });
  const results = await s.w.db.batch([...live.statements, marker()]);
  assert.equal(results[live.appliedIndex].meta.changes, 1);
  assert.equal(results[live.deletedIndex].meta.changes, 1);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', live.loserId).n, 0);
  assert.equal(one(s, 'SELECT name FROM guilds WHERE id = ?', s.gid).name, 'Renamed by the caller');
  const audit = one(s, "SELECT * FROM audit_log WHERE action = 'person.join'");
  assert.deepEqual([audit.entity_type, audit.entity_id, audit.actor_user_id], ['person', live.survivorId, uid(s, 'm1')]);
  assert.equal(JSON.parse(audit.after).via, 'bnet');
  assert.equal(one(s, 'SELECT joined_by FROM person_joins WHERE loser_player_id = ?', live.loserId).joined_by, uid(s, 'm1'));
  // the same person twice and a person that is not in the guild are refused by the module itself
  await assert.rejects(() => planFor(s, a.pid, a.pid), (error) => error.status === 400);
  await assert.rejects(() => planFor(s, a.pid, pid22('nobody')), (error) => error.status === 404);
});

// ---------------------------------------------------------------------------
// A recompute of an old raid, the audit log and the Activity view

// A two-pull log on the raid with these names present in both (as the name-alias suite does).
function addLog(s, raidId, names) {
  const raidRow = one(s, 'SELECT starts_at FROM raids WHERE id = ?', raidId);
  const code = `${raidId.slice(2, 10)}xxxxxxxx`.replace(/[^A-Za-z0-9]/g, 'x');
  run(s, "INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES (?, ?, ?, 'www', ?, 1)", raidId, s.gid, code, raidRow.starts_at);
  let fight = 0;
  for (const offset of [0, 600000]) {
    fight++;
    const pull = run(s, "INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 'Boss', 0, ?, ?)",
      raidId, code, fight, raidRow.starts_at + offset, raidRow.starts_at + offset + 1000).lastInsertRowid;
    for (const name of names) {
      run(s, "INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE')", pull, raidId, s.gid, name, name.toLowerCase());
    }
  }
}
const attendanceOf = (s, raidId) => Object.fromEntries(all(s, 'SELECT player_id, outcome, attended FROM attendance WHERE raid_id = ?', raidId).map((row) => [row.player_id, [row.outcome, row.attended]]));

check('a recompute of an old raid after the join credits the survivor: the loser\'s log name is a character of the survivor now', async () => {
  const s = await world();
  const L = await mk(s, 'Logloser');
  const S = await mk(s, 'Logsurv');
  await s.link(S.pid, 'm1');
  const raidId = await raid(s, s.tids[0], 10);
  addLog(s, raidId, ['Logloser']);
  await s.ok('gm', 'POST', `/raids/${raidId}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, raidId)[L.pid], ['present', 1], 'before the join the log credits the loser');
  assert.notEqual(one(s, 'SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, '');

  const res = await join(s, 'o1', L.pid, S.pid);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.survivorId, S.pid);
  assert.equal(one(s, 'SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, '', 'the raid is stale');
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM attendance WHERE player_id = ?', L.pid).n, 0, 'no stored row names the loser');
  await s.ok('gm', 'POST', `/raids/${raidId}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, raidId), { [S.pid]: ['present', 1] }, 'the survivor was in the log; the stored result is a cache the recompute rewrites');
  // and from the log alone, with no stored result at all
  run(s, 'DELETE FROM attendance WHERE raid_id = ?', raidId);
  await s.ok('gm', 'POST', `/raids/${raidId}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, raidId), { [S.pid]: ['present', 1] });
  const page = await s.ok('gm', 'GET', `/raids/${raidId}`);
  assert.deepEqual(page.unmatched, []);
  assert.deepEqual(page.people.filter((person) => person.outcome === 'present').map((person) => person.name), ['Logsurv'], 'shown under the survivor\'s Main');
});

check('audit: one person.join row with both ids and no names; the Activity view reads the loser\'s id as the person that took its place, along a chain, and old rows stay as written', async () => {
  const s = await world();
  const A = await mk(s, 'Chaina');
  const B = await mk(s, 'Chainb');
  const C = await mk(s, 'Chainc');
  for (const person of [B, C]) {
    const res = await s.call('o1', 'PATCH', `/roster/${person.pid}`, { expectedVersion: one(s, 'SELECT version FROM players WHERE id = ?', person.pid).version, joinedOn: '2026-01-01' });
    assert.equal(res.status, 200, res.text);
  }
  const rows = async () => (await s.ok('gm', 'GET', '/audit')).rows;
  const sentence = async (action, entity) => (await rows()).find((row) => row.action === action && row.entityId === entity);
  assert.equal((await sentence('person.update', C.pid)).text, 'Updated Chainc: join date', 'before the join the row names its own person');
  assert.equal((await join(s, 'o1', B.pid, C.pid)).status, 200); // the older, B, survives
  assert.equal((await sentence('person.update', C.pid)).text, 'Updated Chainb: join date', 'the loser\'s id reads as the survivor');
  assert.equal((await sentence('person.update', B.pid)).text, 'Updated Chainb: join date');
  const first = await sentence('person.join', B.pid);
  assert.equal(first.text, 'Joined the person with Chainc into Chainb');
  assert.equal(first.group, 'roster');
  assert.equal(first.actor.displayName.length > 0, true);
  // the survivor of that join is joined into A later: both older ids chase the chain to the end
  assert.equal((await join(s, 'o1', A.pid, B.pid)).status, 200);
  assert.equal((await sentence('person.update', C.pid)).text, 'Updated Chaina: join date');
  assert.equal((await sentence('person.update', B.pid)).text, 'Updated Chaina: join date');
  assert.equal((await sentence('person.join', B.pid)).text, 'Joined the person with Chainc into Chaina');
  assert.equal((await sentence('person.join', A.pid)).text, 'Joined the person with Chainb and Chainc into Chaina', 'B carried the character of C by then');
  // the log itself holds ids and flags: nothing was rewritten, no name is in it
  const stored = all(s, "SELECT * FROM audit_log WHERE action = 'person.join' ORDER BY created_at");
  assert.equal(stored.length, 2);
  assert.deepEqual([stored[0].entity_id, JSON.parse(stored[0].before).personId, JSON.parse(stored[0].after).personId], [B.pid, C.pid, B.pid]);
  assert.equal(JSON.parse(stored[0].after).via, 'officer');
  assert.deepEqual(JSON.parse(stored[0].before).characterIds.length, 1);
  for (const row of stored) for (const name of ['Chaina', 'Chainb', 'Chainc']) assert.equal(`${row.before} ${row.after}`.includes(name), false, `no name in the audit row (${name})`);
  assert.equal(one(s, "SELECT entity_id FROM audit_log WHERE action = 'person.update' AND entity_id = ?", C.pid).entity_id, C.pid, 'old rows keep the loser\'s id');
  // the Roster group filter includes the new action
  const filtered = await s.ok('gm', 'GET', '/audit?group=roster');
  assert(filtered.rows.some((row) => row.action === 'person.join'));
});

// ---------------------------------------------------------------------------
// Match to roster

const rosterRow = (s, key, { name, cls = 'MAGE', rank = 4, guild = s.gid } = {}) => run(s,
  `INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
   VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', ?, 70, ?)`, guild, NAMESPACE, REALM_ID, key, name, name.toLowerCase(), cls, rank);
const matchBody = (key) => ({ namespace: NAMESPACE, blizzardRealmId: REALM_ID, blizzardCharId: key });
const match = (s, who, pid, cid, key) => s.call(who, 'POST', `/roster/${pid}/characters/${cid}/match`, matchBody(key));
const characterRow = (s, cid) => one(s, 'SELECT * FROM characters WHERE id = ?', cid);
const matchSnapshot = (s) => JSON.stringify(['characters', 'guild_roster', 'character_name_aliases', 'audit_log', 'raids'].map((table) => all(s, `SELECT * FROM ${table}`)));

check('Match to roster: the character takes the row\'s key, name, name_key and class; a rename is dated in character_name_aliases and the old raids keep crediting it', async () => {
  const s = await world();
  const person = await mk(s, 'Foo');
  const raidId = await raid(s, s.tids[0], 12);
  addLog(s, raidId, ['Foo']);
  await s.ok('gm', 'POST', `/raids/${raidId}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, raidId)[person.pid], ['present', 1]);
  assert.notEqual(one(s, 'SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, '');
  rosterRow(s, 9001, { name: 'Bar', cls: 'ROGUE' });
  const before = characterRow(s, person.cid);
  assert.equal(before.blizzard_char_id, null);
  const versionBefore = one(s, 'SELECT version FROM players WHERE id = ?', person.pid).version;

  const res = await match(s, 'o1', person.pid, person.cid, 9001);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.person.id, person.pid);
  assert.deepEqual(res.json.characters.map((character) => [character.name, character.class, character.mainSpec]), [['Bar', 'ROGUE', null]]);
  const after = characterRow(s, person.cid);
  assert.deepEqual([after.name, after.name_key, after.class, after.main_spec, after.off_spec], ['Bar', 'bar', 'ROGUE', null, null], 'a new class clears the specs');
  assert.deepEqual([after.namespace, after.blizzard_realm_id, after.blizzard_char_id], [NAMESPACE, REALM_ID, 9001]);
  assert.deepEqual([after.owner_proof, after.proof_user_id, after.proof_bnet_account_id, after.team_id, after.is_main, after.core_rank, after.realm_key],
    [before.owner_proof, before.proof_user_id, before.proof_bnet_account_id, before.team_id, before.is_main, before.core_rank, before.realm_key], 'proof, team, Main and rank stay as they were');
  assert.notEqual(after.owner_proof, 'bnet');
  assert.equal(one(s, 'SELECT version FROM players WHERE id = ?', person.pid).version, versionBefore);
  // the alias: the old key, dated at the match
  const aliases = all(s, 'SELECT * FROM character_name_aliases WHERE character_id = ?', person.cid);
  assert.equal(aliases.length, 1);
  assert.deepEqual([aliases[0].name_key, aliases[0].realm_key, aliases[0].renamed_at, aliases[0].guild_id], ['foo', 'nightslayer', s.w.clock.now, s.gid]);
  // the raid logged under the old name is stale; recomputed it still credits the character
  assert.equal(one(s, 'SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, '');
  await s.ok('gm', 'POST', `/raids/${raidId}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, raidId)[person.pid], ['present', 1], 'the old raid\'s Foo is still this character (now Bar)');
  // a NEW Foo after the match is not Bar
  const newcomer = await mk(s, 'Foo');
  assert.notEqual(newcomer.cid, person.cid);
  // the audit row: ids and flags only
  const audit = one(s, "SELECT * FROM audit_log WHERE action = 'character.match_roster'");
  assert.deepEqual([audit.entity_type, audit.entity_id, audit.actor_user_id], ['character', person.cid, uid(s, 'o1')]);
  assert.deepEqual(JSON.parse(audit.after), { personId: person.pid, teamId: s.tids[0], namespace: NAMESPACE, blizzardRealmId: REALM_ID, blizzardCharId: 9001, renamed: true, classChanged: true });
  assert.equal(`${audit.before} ${audit.after}`.includes('Foo') || `${audit.before} ${audit.after}`.includes('Bar'), false);
  const activity = (await s.ok('gm', 'GET', '/audit?group=roster')).rows.find((row) => row.action === 'character.match_roster');
  assert.equal(activity.text, 'Matched Bar to its place on the in-game roster and took its name');

  // the same name and class: no alias, the specs stay
  const same = await mk(s, 'Keepspec');
  rosterRow(s, 9002, { name: 'Keepspec', cls: 'MAGE' });
  const kept = await match(s, 'o1', same.pid, same.cid, 9002);
  assert.equal(kept.status, 200, kept.text);
  assert.deepEqual(kept.json.characters.map((character) => [character.name, character.mainSpec]), [['Keepspec', 'Fire']]);
  assert.equal(one(s, 'SELECT COUNT(*) AS n FROM character_name_aliases WHERE character_id = ?', same.cid).n, 0);
  assert.equal(JSON.parse(one(s, "SELECT after FROM audit_log WHERE action = 'character.match_roster' AND entity_id = ?", same.cid).after).renamed, false);
  assert.equal(characterRow(s, same.cid).blizzard_char_id, 9002);
});

check('Match to roster refuses: a character that has a key or left, a key another character holds, a row that is not in this guild\'s roster, a name another character carries, a bad body; nothing changes', async () => {
  const s = await world();
  const a = await mk(s, 'Matcha');
  const refused = async (call, status, error) => {
    const before = matchSnapshot(s);
    const res = await call();
    assert.equal(res.status, status, res.text);
    assert.equal(res.json.error, error, res.text);
    assert.equal(matchSnapshot(s), before, 'a refused match changes nothing');
  };
  rosterRow(s, 9101, { name: 'Matcha' });
  // already keyed
  const keyed = await mk(s, 'Keyedone');
  run(s, 'UPDATE characters SET namespace = ?, blizzard_realm_id = ?, blizzard_char_id = 9100 WHERE id = ?', NAMESPACE, REALM_ID, keyed.cid);
  await refused(() => match(s, 'o1', keyed.pid, keyed.cid, 9101), 409, 'already_bound');
  // left the guild
  const gone = await mk(s, 'Goneone');
  run(s, "UPDATE characters SET left_on = '2027-01-01', left_reason = 'left' WHERE id = ?", gone.cid);
  await refused(() => match(s, 'o1', gone.pid, gone.cid, 9101), 409, 'left_guild');
  // the key is held by another character of the guild (the roster row is real)
  run(s, 'UPDATE characters SET namespace = ?, blizzard_realm_id = ?, blizzard_char_id = 9101 WHERE id = ?', NAMESPACE, REALM_ID, gone.cid);
  await refused(() => match(s, 'o1', a.pid, a.cid, 9101), 409, 'identity_taken');
  run(s, 'UPDATE characters SET blizzard_char_id = NULL, namespace = NULL, blizzard_realm_id = NULL WHERE id = ?', gone.cid);
  // no such row; a row of ANOTHER guild's roster with the same key
  await refused(() => match(s, 'o1', a.pid, a.cid, 9999), 404, 'not_found');
  run(s, "INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g_otherguild0000000000001', 'Other', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1)");
  rosterRow(s, 9200, { name: 'Elsewhere', guild: 'g_otherguild0000000000001' });
  await refused(() => match(s, 'o1', a.pid, a.cid, 9200), 404, 'not_found');
  // no such character, or a character of another person
  await refused(() => match(s, 'o1', a.pid, keyed.cid, 9101), 404, 'not_found');
  await refused(() => match(s, 'o1', pid22('nobody'), a.cid, 9101), 404, 'not_found');
  // the row's name is another character's
  await mk(s, 'Takenone');
  rosterRow(s, 9300, { name: 'Takenone' });
  await refused(() => match(s, 'o1', a.pid, a.cid, 9300), 409, 'name_taken');
  // the body
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/characters/${a.cid}/match`, {}), 400, 'bad_request');
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/characters/${a.cid}/match`, { namespace: NAMESPACE, blizzardRealmId: 'x', blizzardCharId: 9101 }), 400, 'bad_request');
  await refused(() => s.call('o1', 'POST', `/roster/${a.pid}/characters/${a.cid}/match`, { namespace: NAMESPACE, blizzardRealmId: REALM_ID, blizzardCharId: 0 }), 400, 'bad_request');
  // a class the game knows but Raidsmith does not
  rosterRow(s, 9400, { name: 'Deathknight', cls: 'DEATHKNIGHT' });
  await refused(() => match(s, 'o1', a.pid, a.cid, 9400), 409, 'roster_class_unknown');
  // and the happy path still works afterwards
  assert.equal((await match(s, 'o1', a.pid, a.cid, 9101)).status, 200);
});

check('Match to roster: roster.edit on the character\'s team (the whole guild for one on no team) and the Seniority guard, before and inside the batch', async () => {
  const s = await world();
  const [alpha, bravo] = s.tids;
  const own = await mk(s, 'Alphaone'); // on Alpha
  const bravoPerson = await mk(s, 'Bravoone', { teamId: bravo });
  const teamless = await s.alt(own.pid, 'Freealt'); // an alt on no team
  const refused = async (call, status, error) => {
    const before = matchSnapshot(s);
    const res = await call();
    assert.equal(res.status, status, res.text);
    assert.equal(res.json.error, error, res.text);
    assert.equal(matchSnapshot(s), before);
  };
  for (const [key, name] of [[9501, 'Rowone'], [9502, 'Rowtwo'], [9503, 'Rowthree'], [9504, 'Rowfour'], [9505, 'Rowfive'], [9506, 'Rowsix']]) rosterRow(s, key, { name });
  // a member, and a Team Lead of another team
  await refused(() => match(s, 'm1', own.pid, own.cid, 9501), 403, 'forbidden');
  await refused(() => match(s, 'tl', bravoPerson.pid, bravoPerson.cid, 9502), 403, 'forbidden');
  // a Team Lead of Alpha matches an Alpha character, not one on no team
  await refused(() => match(s, 'tl', own.pid, teamless, 9503), 403, 'forbidden');
  assert.equal((await match(s, 'tl', own.pid, own.cid, 9501)).status, 200);
  assert.equal((await match(s, 'o1', own.pid, teamless, 9503)).status, 200, 'an officer edits every team');
  // the Seniority guard: an Officer\'s or the Guild Master\'s person is out of reach for a Team Lead and an equal Officer
  const officerPerson = await mk(s, 'Officerp');
  await s.link(officerPerson.pid, 'o2');
  await refused(() => match(s, 'tl', officerPerson.pid, officerPerson.cid, 9504), 403, 'seniority');
  await refused(() => match(s, 'o1', officerPerson.pid, officerPerson.cid, 9504), 403, 'seniority');
  assert.equal((await match(s, 'gm', officerPerson.pid, officerPerson.cid, 9504)).status, 200);
  // inside the batch: the target's account is promoted after the read
  const target = await mk(s, 'Promotedp');
  await s.link(target.pid, 'm2');
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => /UPDATE characters SET name = /.test(statement.sql))) {
      fired = true;
      run(s, "INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES ('ra_promoted00000000000001', ?, ?, 'officer', NULL, 1)", s.gid, uid(s, 'm2'));
    }
    return real(statements);
  };
  try {
    const before = matchSnapshot(s);
    const res = await match(s, 'o1', target.pid, target.cid, 9505);
    assert.equal(fired, true);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'conflict');
    assert.equal(matchSnapshot(s), before, 'the guard inside the batch stopped every statement');
  } finally {
    s.w.db.batch = real;
  }
});

check('Match to roster in an in-game guild: the character is on the roster now and takes the rank of its row in the same batch; in another guild its rank is left alone', async () => {
  const s = await world();
  const hand = await mk(s, 'Handadded');
  const other = await mk(s, 'Handother');
  run(s, "UPDATE characters SET core_rank = 'social' WHERE id IN (?, ?)", hand.cid, other.cid);
  rosterRow(s, 9601, { name: 'Handadded', rank: 3 });
  rosterRow(s, 9602, { name: 'Handother', rank: 3 });
  // not in-game (a legacy guild): the character is bound, its rank untouched
  assert.equal((await match(s, 'gm', other.pid, other.cid, 9602)).status, 200);
  assert.equal(characterRow(s, other.cid).core_rank, 'social');
  // in-game: rank 3 is a Raider. The Guild Master is the Owner of the flipped guild and must be LIVE (a Battle.net-proven character on the roster) to go on acting.
  const owned = await mk(s, 'Gmowner');
  await s.link(owned.pid, 'gm');
  makeProven(s, 'gm', owned, { rank: 4 });
  run(s, "UPDATE guilds SET rank_source = 'ingame', owner_user_id = ? WHERE id = ?", s.uids.gm, s.gid);
  run(s, "DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid);
  run(s, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES (?, 'ingame', '3', 'Core', 'raider', NULL)", s.gid);
  const res = await match(s, 'gm', hand.pid, hand.cid, 9601);
  assert.equal(res.status, 200, res.text);
  const row = characterRow(s, hand.cid);
  assert.deepEqual([row.blizzard_char_id, row.core_rank], [9601, 'raider']);
});

runChecks(checks);
