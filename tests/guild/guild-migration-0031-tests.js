/**
 * Raidsmith guild tracker - migration 0031 tests (hierarchy schema: guilds pin/owner/sync columns, fresh-auth, rank map, roster, blocks, proof trigger)
 * Run: node tests/guild/guild-migration-0031-tests.js
 *
 * Builds a database at migration 0030, seeds a populated world (guilds, accounts with and without Discord, Battle.net links, sessions, blocks,
 * audit rows, people with proven characters, sign-ups), applies migrations/0031_hierarchy_schema.sql on the node:sqlite D1 stand-in (foreign
 * keys ON) and checks: every new table and column, row counts and old columns untouched, both backfills, the CHECKs, the unique and partial
 * identity indexes, the composite tenant foreign keys, every foreign key to users (ON DELETE SET NULL), the proof-clearing trigger (fires only
 * when players.user_id really changes), the old release's statements still working on the new schema, the guild-delete path, the rerunnable
 * tail of the file and PRAGMA foreign_key_check.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createD1Fake } = require('../d1-fake');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const MIGRATION_0031 = fs.readFileSync(path.join(MIGRATIONS, '0031_hierarchy_schema.sql'), 'utf8');

const exec = (db, sql) => db.sqlite.exec(sql);
const rows = (db, sql) => db.sqlite.prepare(sql).all().map((row) => ({ ...row }));
const one = (db, sql) => Object.values(db.sqlite.prepare(sql).get())[0];
const columns = (db, table) => rows(db, `PRAGMA table_info(${table})`).map((r) => r.name);

function worldAt0030() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0031-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0031')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

function seed(db) {
  exec(db, `
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES
      ('g1', 'G1', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1),
      ('g2', 'G2', 'R', 'realm', 'US', 'd2', 'America/Chicago', 'tbc', 1);
    INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1), ('t2', 'g2', 'T2', 25, 0, 1);
    INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at) VALUES ('r1', 'g1', 't1', '2026-10-10', 1000, 1, 1);
    INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES
      ('u_disc', 'ak1', '110000000000000001', 'Disc', 100, 900),
      ('u_both', 'ak2', '110000000000000002', 'Both', 200, 900),
      ('u_bnet', 'bnet:3', NULL, 'Bnet', 300, 900);
    INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot_at) VALUES ('u_both', '77', 'Both#1', 250, 260), ('u_bnet', '78', 'Bnet#2', 300, 300);
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('s1', 'u_disc', 1, 99999);
    INSERT INTO team_notifications (team_id, guild_id, updated_at) VALUES ('t1', 'g1', 5);
    INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('g1', 'u_bnet', 'u_disc', 'spam', 7);
    INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, created_at) VALUES ('a1', 'g1', 'u_disc', 'x.y', 'guild', 9);
    INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES
      ('p1', 'g1', 'raider', 'u_disc', 1, 1), ('p2', 'g1', 'raider', 'u_both', 1, 1), ('p3', 'g1', 'raider', NULL, 1, 1), ('p4', 'g2', 'raider', NULL, 1, 1);
    INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at, owner_proof, proof_user_id, proof_bnet_account_id, proof_at) VALUES
      ('c1', 'g1', 'p1', 't1', 'One', 'one', 'MAGE', 1, 1, 1, 'bnet', 'u_disc', '77', 50),
      ('c1b', 'g1', 'p1', 't1', 'OneAlt', 'onealt', 'ROGUE', 0, 1, 1, 'bnet', 'u_disc', '77', 50),
      ('c2', 'g1', 'p2', 't1', 'Two', 'two', 'MAGE', 1, 1, 1, 'bnet', 'u_both', '77', 50),
      ('c3', 'g1', 'p3', 't1', 'Three', 'three', 'MAGE', 1, 1, 1, 'officer', NULL, NULL, NULL),
      ('c4', 'g2', 'p4', 't2', 'Four', 'four', 'MAGE', 1, 1, 1, 'officer', NULL, NULL, NULL);
    INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('r1', 'raidsmith', 1, 'signed', 0, 'g1', 'p1'), ('r1', 'raidsmith', 2, 'signed', 1, 'g1', 'p3');
  `);
}

const NEW_TABLES = {
  fresh_act_markers: ['act_id', 'session_token_hash', 'purpose', 'at'],
  oauth_state_nonces: ['nonce_hash', 'created_at', 'used_at'],
  source_rank_maps: ['guild_id', 'source', 'source_key', 'label', 'core_rank', 'role_id', 'team_id'],
  guild_roster: ['guild_id', 'namespace', 'blizzard_realm_id', 'blizzard_char_id', 'name', 'name_key', 'realm_slug', 'class', 'level', 'rank'],
  roster_syncs: ['id', 'guild_id', 'started_at', 'finished_at', 'good', 'http_status', 'reason', 'counts'],
  character_name_aliases: ['id', 'guild_id', 'character_id', 'name_key', 'realm_key', 'renamed_at'],
  person_joins: ['id', 'guild_id', 'survivor_player_id', 'loser_player_id', 'counts', 'joined_by', 'joined_at'],
  block_tombstones: ['guild_id', 'block_ref', 'key_version', 'hmac', 'created_at'],
  person_blocks: ['guild_id', 'player_id', 'blocked_by', 'reason', 'tombstone_missing', 'created_at'],
  dry_run_approvals: ['token_hash', 'guild_id', 'approver_user_id', 'map_hash', 'roster_sync_id', 'created_at', 'expires_at', 'used_at'],
};
const NEW_COLUMNS = {
  guilds: ['rank_source', 'owner_user_id', 'pinned_guild_slug', 'pinned_realm_slug', 'pinned_namespace', 'blizzard_realm_id', 'blizzard_guild_id', 'next_sync_at',
    'last_good_sync_id', 'last_good_fetched_at', 'roster_hash'],
  users: ['discord_linked_at'],
  bnet_links: ['first_linked_at'],
  sessions: ['fresh_purpose', 'fresh_hash', 'fresh_at'],
  team_notifications: ['set_by', 'set_at'],
  guild_blocks: ['pending_review', 'tombstone_missing'],
  audit_log: ['actor_short_id', 'actor_role'],
};
const NEW_INDEXES = [
  'guilds_owner', 'guilds_next_sync', 'guilds_blizzard_identity', 'fresh_act_markers_at', 'oauth_state_nonces_created', 'guild_roster_identity', 'roster_syncs_guild_started',
  'characters_identity', 'characters_identity_lookup', 'characters_player_proof', 'characters_proof_user', 'characters_guild_id', 'character_name_aliases_character',
  'character_name_aliases_name', 'person_joins_loser', 'person_joins_survivor', 'block_tombstones_lookup', 'dry_run_approvals_guild', 'raid_signups_player',
];
// Every foreign key to users that 0031 adds (all ON DELETE SET NULL).
const NEW_USER_FKS = ['dry_run_approvals.approver_user_id', 'guilds.owner_user_id', 'person_blocks.blocked_by', 'person_joins.joined_by', 'team_notifications.set_by'];

const foreignKeysToUsers = (db) => rows(db,
  `SELECT m.name || '.' || f."from" AS fk, f.on_delete AS on_delete FROM sqlite_master m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND f."table" = 'users' ORDER BY 1`);
const tableNames = (db) => rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
const dump = (db, table, skip = []) => rows(db, `SELECT * FROM ${table} ORDER BY 1, 2`).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !skip.includes(k))));

const before = worldAt0030();
seed(before);
const db = worldAt0030();
seed(db);
const tablesBefore = tableNames(db);
const countsBefore = Object.fromEntries(tablesBefore.map((t) => [t, one(db, `SELECT COUNT(*) FROM ${t}`)]));
const columnsBefore = Object.fromEntries(Object.keys(NEW_COLUMNS).map((t) => [t, columns(db, t)]));
const dumpsBefore = Object.fromEntries(Object.keys(NEW_COLUMNS).map((t) => [t, dump(db, t)]));
const userFksBefore = foreignKeysToUsers(db);
const indexesBefore = rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
exec(db, MIGRATION_0031);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('every pre-existing table keeps its row count; the new tables are empty and are exactly the planned ones', () => {
  for (const [table, n] of Object.entries(countsBefore)) assert.equal(one(db, `SELECT COUNT(*) FROM ${table}`), n, table);
  assert.deepEqual(tableNames(db).filter((t) => !tablesBefore.includes(t)), Object.keys(NEW_TABLES).sort());
  for (const table of Object.keys(NEW_TABLES)) assert.equal(one(db, `SELECT COUNT(*) FROM ${table}`), 0, table);
});
check('every new table has exactly its planned columns', () => {
  for (const [table, cols] of Object.entries(NEW_TABLES)) assert.deepEqual(columns(db, table), cols, table);
});
check('every altered table gained exactly its planned columns, after the old ones', () => {
  for (const [table, cols] of Object.entries(NEW_COLUMNS)) assert.deepEqual(columns(db, table), [...columnsBefore[table], ...cols], table);
});
check('the old columns of every altered table are untouched (guild_blocks.blocked_by already existed, nothing added for it)', () => {
  for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
    assert.deepEqual(dump(db, table, cols), dumpsBefore[table], table);
  }
  assert.ok(columnsBefore.guild_blocks.includes('blocked_by'));
  assert.equal(NEW_COLUMNS.guild_blocks.includes('blocked_by'), false);
});
check('characters has no new column: 0031 only indexes it', () => {
  assert.deepEqual(columns(db, 'characters'), columns(before, 'characters'));
});
check('backfill: users.discord_linked_at = created_at where discord_id is set, NULL otherwise', () => {
  assert.deepEqual(rows(db, 'SELECT id, discord_linked_at FROM users ORDER BY id'), [
    { id: 'u_bnet', discord_linked_at: null }, { id: 'u_both', discord_linked_at: 200 }, { id: 'u_disc', discord_linked_at: 100 },
  ]);
});
check('backfill: bnet_links.first_linked_at = linked_at on every link', () => {
  assert.deepEqual(rows(db, 'SELECT user_id, first_linked_at, linked_at FROM bnet_links ORDER BY user_id'), [
    { user_id: 'u_bnet', first_linked_at: 300, linked_at: 300 }, { user_id: 'u_both', first_linked_at: 250, linked_at: 250 },
  ]);
});
check('defaults: next_sync_at is 0 and every other guilds column NULL on existing guilds; sessions, notifications, blocks, audit stay as they were', () => {
  const g = rows(db, 'SELECT * FROM guilds ORDER BY id');
  for (const row of g) {
    assert.equal(row.next_sync_at, 0);
    for (const c of NEW_COLUMNS.guilds.filter((x) => x !== 'next_sync_at')) assert.equal(row[c], null, c);
  }
  assert.deepEqual(rows(db, 'SELECT fresh_purpose, fresh_hash, fresh_at FROM sessions'), [{ fresh_purpose: null, fresh_hash: null, fresh_at: null }]);
  assert.deepEqual(rows(db, 'SELECT set_by, set_at FROM team_notifications'), [{ set_by: null, set_at: null }]);
  assert.deepEqual(rows(db, 'SELECT pending_review, tombstone_missing, blocked_by FROM guild_blocks'), [{ pending_review: 0, tombstone_missing: 0, blocked_by: 'u_disc' }]);
  assert.deepEqual(rows(db, 'SELECT actor_short_id, actor_role FROM audit_log'), [{ actor_short_id: null, actor_role: null }]);
});
check('every planned index exists; the last-seen decision: raid_signups_player added, loot_awards_winner / attendance_player / applications_user already existed', () => {
  const names = rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  for (const n of NEW_INDEXES) assert.ok(names.includes(n), n);
  assert.deepEqual(names.filter((n) => !indexesBefore.includes(n) && !n.startsWith('sqlite_autoindex')).sort(), NEW_INDEXES.slice().sort(), 'no unplanned index');
  for (const n of ['loot_awards_winner', 'attendance_player', 'raid_roster_player', 'applications_user']) assert.ok(indexesBefore.includes(n), `${n} existed before 0031`);
  assert.equal(indexesBefore.includes('raid_signups_player'), false);
  assert.deepEqual(names.filter((n) => n.startsWith('loot_awards_')).sort(), indexesBefore.filter((n) => n.startsWith('loot_awards_')).sort(), 'no new loot_awards index');
});
check('lookup indexes serve their queries (query plan)', () => {
  const plan = (sql) => rows(db, `EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(' | ');
  assert.match(plan("SELECT raid_id FROM raid_signups WHERE player_id = 'p1'"), /raid_signups_player/);
  assert.match(plan("SELECT id FROM characters WHERE namespace = 'n' AND blizzard_realm_id = 1 AND blizzard_char_id = 2"), /characters_identity/);
  assert.match(plan("SELECT id FROM characters WHERE player_id = 'p1' AND owner_proof = 'bnet'"), /characters_player_proof/);
  assert.match(plan("SELECT id FROM characters WHERE proof_user_id = 'u_disc'"), /characters_proof_user/);
  assert.match(plan("SELECT id FROM guilds WHERE owner_user_id = 'u_disc'"), /guilds_owner/);
  assert.match(plan('SELECT id FROM guilds WHERE next_sync_at <= 5 ORDER BY next_sync_at'), /guilds_next_sync/);
  assert.match(plan("SELECT 1 FROM guild_roster WHERE namespace = 'n' AND blizzard_realm_id = 1 AND blizzard_char_id = 2"), /guild_roster_identity/);
});

// ---- CHECKs ----
check('source_rank_maps: only source_key 0 may map to guild_master; other roles and NULL are fine', () => {
  exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('g1', 'ingame', '0', 'Guild Master', 'raider', 'guild_master')");
  assert.throws(() => exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('g1', 'ingame', '1', 'Officer', 'raider', 'guild_master')"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE source_rank_maps SET source_key = '5' WHERE source_key = '0'"), /CHECK/);
  exec(db, `INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES
    ('g1', 'ingame', '1', 'Officer', 'raider', 'officer'), ('g1', 'ingame', '2', 'Raider', 'raider', NULL), ('g1', 'ingame', '9', 'Alt', 'social', NULL)`);
  exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('g1', 'discord', '12345', 'Role', 'reserve', 'team_lead')");
  assert.throws(() => exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank) VALUES ('g1', 'ingame', '2', 'Dup', 'raider')"), /UNIQUE/);
});
check('source_rank_maps: core_rank is a foreign key to core_ranks, role_id to roles', () => {
  assert.throws(() => exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank) VALUES ('g1', 'ingame', '3', 'Bad', 'nope')"), /FOREIGN KEY/);
  assert.throws(() => exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('g1', 'ingame', '3', 'Bad', 'raider', 'nope')"), /FOREIGN KEY/);
});
check('source_rank_maps: team_id is reserved and NULL, a team of the same guild is accepted, a team of another guild is refused', () => {
  exec(db, "UPDATE source_rank_maps SET team_id = 't1' WHERE source_key = '2'");
  assert.throws(() => exec(db, "UPDATE source_rank_maps SET team_id = 't2' WHERE source_key = '9'"), /FOREIGN KEY/);
  exec(db, "UPDATE source_rank_maps SET team_id = NULL WHERE source_key = '2'");
});
check('guilds: the identity is unique per (game_version, region, realm id, guild id); unpinned guilds never collide', () => {
  exec(db, "UPDATE guilds SET blizzard_realm_id = 4, blizzard_guild_id = 99 WHERE id = 'g1'");
  assert.throws(() => exec(db, "UPDATE guilds SET blizzard_realm_id = 4, blizzard_guild_id = 99 WHERE id = 'g2'"), /UNIQUE/);
  exec(db, "UPDATE guilds SET region = 'EU', blizzard_realm_id = 4, blizzard_guild_id = 99 WHERE id = 'g2'");
  exec(db, "UPDATE guilds SET game_version = 'classic' WHERE id = 'g2'");
  exec(db, "UPDATE guilds SET region = 'US', game_version = 'tbc', blizzard_realm_id = 5, blizzard_guild_id = 99 WHERE id = 'g2'");
  exec(db, "UPDATE guilds SET blizzard_realm_id = NULL, blizzard_guild_id = NULL WHERE id IN ('g1', 'g2')");
  exec(db, "UPDATE guilds SET game_version = 'tbc', region = 'US' WHERE id = 'g2'");
});
check('guilds: id and slug CHECKs (positive ids, realm slug shape, lengths)', () => {
  assert.throws(() => exec(db, "UPDATE guilds SET blizzard_guild_id = 0 WHERE id = 'g1'"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE guilds SET blizzard_realm_id = -1 WHERE id = 'g1'"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE guilds SET pinned_realm_slug = 'Bad Realm' WHERE id = 'g1'"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE guilds SET pinned_guild_slug = '' WHERE id = 'g1'"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE guilds SET pinned_namespace = '' WHERE id = 'g1'"), /CHECK/);
  exec(db, "UPDATE guilds SET pinned_guild_slug = 'vindicated', pinned_realm_slug = 'dreamscythe', pinned_namespace = 'profile-classicann-us', rank_source = 'ingame', next_sync_at = 5, roster_hash = 'h', last_good_sync_id = 's', last_good_fetched_at = 9 WHERE id = 'g1'");
  exec(db, "UPDATE guilds SET pinned_guild_slug = NULL, pinned_realm_slug = NULL, pinned_namespace = NULL, rank_source = NULL, next_sync_at = 0, roster_hash = NULL, last_good_sync_id = NULL, last_good_fetched_at = NULL WHERE id = 'g1'");
});
check('guilds.rank_source is plain TEXT: a later source needs no migration', () => {
  exec(db, "UPDATE guilds SET rank_source = 'discord' WHERE id = 'g1'");
  exec(db, "UPDATE guilds SET rank_source = NULL WHERE id = 'g1'");
});
check('guild_roster: PK is the identity key, name + realm is unique, rank 0-9, positive ids, no sync id', () => {
  assert.equal(columns(db, 'guild_roster').includes('sync_id'), false);
  const ins = (cid, name, rank = 3, realm = 11) => exec(db, `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    VALUES ('g1', 'profile-classicann-us', ${realm}, ${cid}, '${name}', '${name.toLowerCase()}', 'dreamscythe', 'MAGE', 70, ${rank})`);
  ins(1, 'Aaa');
  assert.throws(() => ins(1, 'Bbb'), /UNIQUE/, 'same identity key');
  assert.throws(() => ins(2, 'Aaa'), /UNIQUE/, 'same name + realm slug');
  ins(2, 'Bbb', 0, 12);
  assert.throws(() => ins(3, 'Ccc', 10), /CHECK/);
  assert.throws(() => ins(3, 'Ccc', -1), /CHECK/);
  assert.throws(() => ins(0, 'Ccc'), /CHECK/);
  exec(db, "INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, rank) VALUES ('g2', 'profile-classicann-us', 11, 1, 'Aaa', 'aaa', 'dreamscythe', 'MAGE', 1)");
});
check('guild_roster: the atomic replace (DELETE the guild, INSERT ... SELECT json_each, one batch) leaves a whole roster and survives a mid-batch failure', async () => {
  const members = JSON.stringify([
    { r: 11, c: 1, n: 'Aaa', rank: 1 }, { r: 11, c: 5, n: 'Eee', rank: 2 }, { r: 12, c: 2, n: 'Bbb', rank: 0 },
  ]);
  const insert = () => db.prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    SELECT 'g1', 'profile-classicann-us', json_extract(j.value, '$.r'), json_extract(j.value, '$.c'), json_extract(j.value, '$.n'), lower(json_extract(j.value, '$.n')), 'dreamscythe', 'MAGE', 70, json_extract(j.value, '$.rank')
    FROM json_each(?) j`).bind(members);
  const before1 = rows(db, "SELECT * FROM guild_roster WHERE guild_id = 'g1' ORDER BY blizzard_char_id");
  await assert.rejects(db.batch([db.prepare("DELETE FROM guild_roster WHERE guild_id = 'g1'").bind(), insert(), db.prepare("INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, rank) VALUES ('g1', 'n', 1, 1, 'X', 'x', 's', 'MAGE', 99)").bind()]), /CHECK/);
  assert.deepEqual(rows(db, "SELECT * FROM guild_roster WHERE guild_id = 'g1' ORDER BY blizzard_char_id"), before1, 'a failing batch changes nothing');
  await db.batch([db.prepare("DELETE FROM guild_roster WHERE guild_id = 'g1'").bind(), insert()]);
  assert.deepEqual(rows(db, "SELECT blizzard_char_id, name, rank FROM guild_roster WHERE guild_id = 'g1' ORDER BY blizzard_char_id"),
    [{ blizzard_char_id: 1, name: 'Aaa', rank: 1 }, { blizzard_char_id: 2, name: 'Bbb', rank: 0 }, { blizzard_char_id: 5, name: 'Eee', rank: 2 }]);
  assert.equal(one(db, "SELECT COUNT(*) FROM guild_roster WHERE guild_id = 'g2'"), 1, 'the other guild is untouched');
});
check('roster_syncs: good is 0/1, counts is JSON, no FK from guild_roster to it', () => {
  exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts) VALUES ('rs1', 'g1', 1, 2, 1, 200, NULL, '{\"members\":3}')");
  exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, good, reason) VALUES ('rs2', 'g1', 3, 0, 'truncated')");
  assert.throws(() => exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, good) VALUES ('rs3', 'g1', 3, 2)"), /CHECK/);
  assert.throws(() => exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, good, counts) VALUES ('rs3', 'g1', 3, 1, 'nope')"), /CHECK/);
  assert.throws(() => exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, good) VALUES ('rs3', 'nope', 3, 1)"), /FOREIGN KEY/);
  assert.equal(rows(db, "SELECT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.name = 'guild_roster' AND f.\"table\" = 'roster_syncs'").length, 0);
  exec(db, "DELETE FROM roster_syncs WHERE id IN ('rs1', 'rs2')");
});
check('characters: the identity key is unique per guild where blizzard_char_id is set (partial), NULLs repeat, other guilds may repeat it', () => {
  const set = (id, ns, realm, ch) => exec(db, `UPDATE characters SET namespace = ${ns}, blizzard_realm_id = ${realm}, blizzard_char_id = ${ch} WHERE id = '${id}'`);
  set('c1', "'profile-classicann-us'", 11, 1);
  assert.throws(() => set('c2', "'profile-classicann-us'", 11, 1), /UNIQUE/);
  set('c2', "'profile-classicann-us'", 11, 2);
  set('c4', "'profile-classicann-us'", 11, 1);
  set('c1b', "'profile-classicann-eu'", 11, 1);
  assert.throws(() => set('c3', "'profile-classicann-eu'", 11, 1), /UNIQUE/);
  set('c3', 'NULL', 'NULL', 'NULL');
  assert.equal(one(db, 'SELECT COUNT(*) FROM characters WHERE blizzard_char_id IS NULL'), 1);
  assert.equal(one(db, "SELECT sql FROM sqlite_master WHERE name = 'characters_identity'").includes('WHERE blizzard_char_id IS NOT NULL'), true);
  for (const id of ['c1', 'c1b', 'c2', 'c4']) set(id, 'NULL', 'NULL', 'NULL');
});
check('characters_guild_id: the composite parent key is unique', () => {
  assert.throws(() => exec(db, `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c1', 'g1', 'p1', 't1', 'Dup', 'dup', 'MAGE', 1, 1)`), /UNIQUE/);
});
check('character_name_aliases: composite tenant key (a character of another guild is refused), cascades with the character', () => {
  exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('al1', 'g1', 'c3', 'oldthree', '', 10)");
  assert.throws(() => exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, renamed_at) VALUES ('al2', 'g2', 'c3', 'x', 10)"), /FOREIGN KEY/);
  assert.throws(() => exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, renamed_at) VALUES ('al2', 'g1', 'c4', 'x', 10)"), /FOREIGN KEY/);
  exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, renamed_at) VALUES ('al3', 'g1', 'c3', 'oldthree', 20)");
  assert.equal(one(db, "SELECT realm_key FROM character_name_aliases WHERE id = 'al3'"), '', 'realm_key defaults to the ruleset value');
  exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c_tmp', 'g1', 'p3', 't1', 'Tmp', 'tmp', 'MAGE', 1, 1)");
  exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, renamed_at) VALUES ('al4', 'g1', 'c_tmp', 'before', 5)");
  exec(db, "DELETE FROM characters WHERE id = 'c_tmp'");
  assert.equal(one(db, "SELECT COUNT(*) FROM character_name_aliases WHERE id = 'al4'"), 0);
  exec(db, "DELETE FROM character_name_aliases");
});
check('person_blocks: composite tenant key to players, flags 0/1, reason length, cascades with the person', () => {
  exec(db, "INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, created_at) VALUES ('g1', 'p3', 'u_disc', 'x', 1)");
  assert.throws(() => exec(db, "INSERT INTO person_blocks (guild_id, player_id, created_at) VALUES ('g1', 'p4', 1)"), /FOREIGN KEY/);
  assert.throws(() => exec(db, "INSERT INTO person_blocks (guild_id, player_id, created_at) VALUES ('g1', 'p3', 1)"), /UNIQUE/);
  assert.throws(() => exec(db, "UPDATE person_blocks SET tombstone_missing = 2"), /CHECK/);
  assert.throws(() => exec(db, `UPDATE person_blocks SET reason = '${'x'.repeat(201)}'`), /CHECK/);
  assert.equal(one(db, 'SELECT tombstone_missing FROM person_blocks'), 0);
  exec(db, "INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_tmp', 'g1', 'raider', 1, 1)");
  exec(db, "INSERT INTO person_blocks (guild_id, player_id, created_at) VALUES ('g1', 'p_tmp', 1)");
  exec(db, "DELETE FROM players WHERE id = 'p_tmp'");
  assert.equal(one(db, "SELECT COUNT(*) FROM person_blocks WHERE player_id = 'p_tmp'"), 0);
  exec(db, 'DELETE FROM person_blocks');
});
check('guild_blocks: pending_review and tombstone_missing are 0/1', () => {
  exec(db, "UPDATE guild_blocks SET pending_review = 1, tombstone_missing = 1");
  assert.throws(() => exec(db, "UPDATE guild_blocks SET pending_review = 2"), /CHECK/);
  assert.throws(() => exec(db, "UPDATE guild_blocks SET tombstone_missing = -1"), /CHECK/);
  exec(db, "UPDATE guild_blocks SET pending_review = 0, tombstone_missing = 0");
});
check('block_tombstones: one row per (guild, block_ref, key_version, hmac); two blocks may share an hmac; lookups by (guild, hmac)', () => {
  const ins = (ref, v, h) => exec(db, `INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('g1', '${ref}', ${v}, '${h}', 1)`);
  ins('b1', 1, 'aa');
  ins('b2', 1, 'aa');
  ins('b1', 2, 'aa');
  assert.throws(() => ins('b1', 1, 'aa'), /UNIQUE/);
  assert.throws(() => ins('b3', 0, 'bb'), /CHECK/);
  assert.throws(() => ins('b3', 1, ''), /CHECK/);
  exec(db, "DELETE FROM block_tombstones WHERE guild_id = 'g1' AND block_ref = 'b1'");
  assert.equal(one(db, 'SELECT COUNT(*) FROM block_tombstones'), 1, 'unblock deletes by block_ref and leaves the other block');
  exec(db, 'DELETE FROM block_tombstones');
});
check('dry_run_approvals, fresh_act_markers, oauth_state_nonces: single-use rows keyed by hash / act id / nonce', () => {
  exec(db, "INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at) VALUES ('th', 'g1', 'u_disc', 'mh', 'rs9', 1, 601000)");
  assert.throws(() => exec(db, "INSERT INTO dry_run_approvals (token_hash, guild_id, map_hash, roster_sync_id, created_at, expires_at) VALUES ('th', 'g1', 'mh', 'rs9', 1, 2)"), /UNIQUE/);
  assert.equal(one(db, "SELECT COUNT(*) FROM dry_run_approvals WHERE used_at IS NULL"), 1);
  exec(db, "INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES ('act1', 's1', 'claim', 5)");
  assert.throws(() => exec(db, "INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES ('act1', 's1', 'claim', 6)"), /UNIQUE/);
  exec(db, "INSERT INTO oauth_state_nonces (nonce_hash, created_at) VALUES ('n1', 5)");
  assert.throws(() => exec(db, "INSERT INTO oauth_state_nonces (nonce_hash, created_at) VALUES ('n1', 6)"), /UNIQUE/);
  assert.equal(rows(db, "UPDATE oauth_state_nonces SET used_at = 7 WHERE nonce_hash = 'n1' AND used_at IS NULL RETURNING nonce_hash").length, 1);
  assert.equal(rows(db, "UPDATE oauth_state_nonces SET used_at = 8 WHERE nonce_hash = 'n1' AND used_at IS NULL RETURNING nonce_hash").length, 0, 'a replayed nonce matches nothing');
  exec(db, 'DELETE FROM dry_run_approvals; DELETE FROM fresh_act_markers; DELETE FROM oauth_state_nonces');
});
check('person_joins: ids, counts JSON, lookup by loser and survivor', () => {
  exec(db, "INSERT INTO person_joins (id, guild_id, survivor_player_id, loser_player_id, counts, joined_by, joined_at) VALUES ('pj1', 'g1', 'p1', 'p_gone', '{\"raid_signups\":2}', 'u_disc', 5)");
  assert.throws(() => exec(db, "INSERT INTO person_joins (id, guild_id, survivor_player_id, loser_player_id, counts, joined_at) VALUES ('pj2', 'g1', 'p1', 'p_g2', 'nope', 5)"), /CHECK/);
  assert.equal(one(db, "SELECT survivor_player_id FROM person_joins WHERE guild_id = 'g1' AND loser_player_id = 'p_gone'"), 'p1');
  exec(db, 'DELETE FROM person_joins');
});

// ---- foreign keys to users ----
check('every foreign key to users that 0031 adds is ON DELETE SET NULL, and the list grew by exactly those', () => {
  const after = foreignKeysToUsers(db);
  const added = after.filter((fk) => !userFksBefore.some((b) => b.fk === fk.fk));
  assert.deepEqual(added.map((fk) => fk.fk).sort(), NEW_USER_FKS);
  for (const fk of added) assert.equal(fk.on_delete, 'SET NULL', fk.fk);
  assert.deepEqual(after.filter((fk) => userFksBefore.some((b) => b.fk === fk.fk)), userFksBefore, 'the old ones are unchanged');
});
check('deleting an account SETs NULL in every new user column and removes nothing else', () => {
  exec(db, `INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES ('u_x', 'ak_x', 'X', 1, 1);
    UPDATE guilds SET owner_user_id = 'u_x' WHERE id = 'g1';
    UPDATE team_notifications SET set_by = 'u_x', set_at = 5;
    INSERT INTO person_joins (id, guild_id, survivor_player_id, loser_player_id, joined_by, joined_at) VALUES ('pj9', 'g1', 'p1', 'pz', 'u_x', 1);
    INSERT INTO person_blocks (guild_id, player_id, blocked_by, created_at) VALUES ('g1', 'p3', 'u_x', 1);
    INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at) VALUES ('thx', 'g1', 'u_x', 'm', 's', 1, 2);`);
  exec(db, "DELETE FROM users WHERE id = 'u_x'");
  assert.equal(one(db, "SELECT owner_user_id FROM guilds WHERE id = 'g1'"), null);
  assert.deepEqual(rows(db, 'SELECT set_by, set_at FROM team_notifications'), [{ set_by: null, set_at: 5 }]);
  assert.equal(one(db, "SELECT joined_by FROM person_joins WHERE id = 'pj9'"), null);
  assert.equal(one(db, "SELECT blocked_by FROM person_blocks WHERE player_id = 'p3'"), null);
  assert.equal(one(db, "SELECT approver_user_id FROM dry_run_approvals WHERE token_hash = 'thx'"), null);
  exec(db, 'DELETE FROM person_joins; DELETE FROM person_blocks; DELETE FROM dry_run_approvals');
});

// ---- the proof-clearing trigger ----
const proofs = (d = db) => rows(d, 'SELECT id, owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters ORDER BY id');
const restamp = () => exec(db, `UPDATE characters SET owner_proof = 'bnet', proof_user_id = 'u_disc', proof_bnet_account_id = '77', proof_at = 50 WHERE player_id = 'p1'`);
const cleared = (id) => ({ id, owner_proof: null, proof_user_id: null, proof_bnet_account_id: null, proof_at: null });
check('trigger: exists, AFTER UPDATE OF user_id ON players WHEN OLD.user_id IS NOT NEW.user_id', () => {
  const t = rows(db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'players_user_change_clears_proof'");
  assert.equal(t.length, 1);
  assert.match(t[0].sql, /AFTER UPDATE OF user_id ON players/);
  assert.match(t[0].sql, /WHEN OLD\.user_id IS NOT NEW\.user_id/);
});
check('trigger: a rewrite that keeps user_id, or an update of another column, keeps every proof', () => {
  restamp();
  const snapshot = proofs();
  exec(db, "UPDATE players SET user_id = 'u_disc' WHERE id = 'p1'");
  exec(db, "UPDATE players SET user_id = user_id WHERE id = 'p1'");
  exec(db, "UPDATE players SET notes = 'hello', updated_at = 99 WHERE id = 'p1'");
  exec(db, "UPDATE players SET user_id = NULL WHERE id = 'p3'");
  assert.deepEqual(proofs(), snapshot);
});
check('trigger: NULL -> account clears that person\'s proofs (all of them), and only theirs', () => {
  restamp();
  exec(db, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = 'u_disc', proof_bnet_account_id = '77', proof_at = 50 WHERE id = 'c3'");
  const others = proofs().filter((r) => !['c3'].includes(r.id));
  exec(db, "UPDATE players SET user_id = 'u_bnet' WHERE id = 'p3'");
  assert.deepEqual(proofs().filter((r) => r.id === 'c3'), [cleared('c3')]);
  assert.deepEqual(proofs().filter((r) => r.id !== 'c3'), others, 'other people\'s characters keep their proofs');
  exec(db, "UPDATE players SET user_id = NULL WHERE id = 'p3'");
  exec(db, "UPDATE characters SET owner_proof = 'officer' WHERE id = 'c3'");
});
check('trigger: account -> another account, and account -> NULL, clear every character of the person', () => {
  restamp();
  exec(db, "UPDATE players SET user_id = 'u_bnet' WHERE id = 'p1'");
  assert.deepEqual(proofs().filter((r) => r.id.startsWith('c1')), [cleared('c1'), cleared('c1b')]);
  restamp();
  exec(db, "UPDATE players SET user_id = NULL WHERE id = 'p1'");
  assert.deepEqual(proofs().filter((r) => r.id.startsWith('c1')), [cleared('c1'), cleared('c1b')]);
  exec(db, "UPDATE players SET user_id = 'u_disc' WHERE id = 'p1'");
  restamp();
});
check('trigger: a proof written in the same statement batch AFTER the relink survives (the restamp pattern of the account-link writers)', async () => {
  await db.batch([
    db.prepare("UPDATE players SET user_id = 'u_bnet' WHERE id = 'p1'").bind(),
    db.prepare("UPDATE characters SET owner_proof = 'officer' WHERE player_id = 'p1'").bind(),
  ]);
  assert.deepEqual(proofs().filter((r) => r.id.startsWith('c1')).map((r) => r.owner_proof), ['officer', 'officer']);
  exec(db, "UPDATE players SET user_id = 'u_disc' WHERE id = 'p1'");
  restamp();
});
check('trigger: deleting the account (players.user_id SET NULL by the foreign key) clears the proofs too', () => {
  exec(db, "INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES ('u_gone', 'ak_gone', 'Gone', 1, 1)");
  exec(db, "UPDATE players SET user_id = 'u_gone' WHERE id = 'p3'");
  exec(db, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = 'u_gone', proof_bnet_account_id = '5', proof_at = 5 WHERE id = 'c3'");
  exec(db, "DELETE FROM users WHERE id = 'u_gone'");
  assert.deepEqual(proofs().filter((r) => r.id === 'c3'), [cleared('c3')]);
  assert.equal(one(db, "SELECT user_id FROM players WHERE id = 'p3'"), null);
  exec(db, "UPDATE characters SET owner_proof = 'officer' WHERE id = 'c3'");
});

// ---- the previous release's statements on the new schema ----
check('old release: its INSERTs (no new columns named) and UPDATEs still work and the new columns take their defaults', () => {
  exec(db, `INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_by, created_at) VALUES ('g_old', 'Old', 'R', 'realm', 'US', 'd_old', 'America/Chicago', 'tbc', 'u_disc', 1)`);
  assert.deepEqual(rows(db, "SELECT rank_source, owner_user_id, next_sync_at, roster_hash FROM guilds WHERE id = 'g_old'"), [{ rank_source: null, owner_user_id: null, next_sync_at: 0, roster_hash: null }]);
  exec(db, "INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u_old', 'ak_old', '999', 'Old', 5, 5)");
  assert.equal(one(db, "SELECT discord_linked_at FROM users WHERE id = 'u_old'"), null, 'the window repair in the file header fills this');
  exec(db, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot_at) VALUES ('u_old', '555', 'Old#1', 5, 5) ON CONFLICT(user_id) DO UPDATE SET linked_at = excluded.linked_at");
  assert.equal(one(db, "SELECT first_linked_at FROM bnet_links WHERE user_id = 'u_old'"), null);
  exec(db, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot_at) VALUES ('u_old', '555', 'Old#1', 9, 9) ON CONFLICT(user_id) DO UPDATE SET linked_at = excluded.linked_at");
  exec(db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, manageable_servers, manageable_until) VALUES ('s_old', 'u_old', 1, 2, NULL, NULL)");
  exec(db, "INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at) VALUES ('a_old', 'g_old', 'u_old', 'x', 'guild', 'g_old', NULL, NULL, 5)");
  exec(db, "INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('g_old', 'u_old', 'u_disc', NULL, 1)");
  exec(db, "INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t_old', 'g_old', 'TO', 25, 0, 1)");
  exec(db, "INSERT INTO team_notifications (team_id, guild_id, updated_at) VALUES ('t_old', 'g_old', 1)");
  exec(db, "INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_old', 'g_old', 'raider', 1, 1)");
  exec(db, "INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, created_at, updated_at) VALUES ('c_old', 'g_old', 'p_old', 't_old', 'Old', 'old', 'MAGE', 1, 1)");
  assert.equal(one(db, "SELECT owner_proof FROM characters WHERE id = 'c_old'"), 'officer');
  // The window repair from the file header is idempotent and fills exactly the rows the old release wrote.
  exec(db, `UPDATE users SET discord_linked_at = created_at WHERE discord_id IS NOT NULL AND discord_linked_at IS NULL;
    UPDATE bnet_links SET first_linked_at = linked_at WHERE first_linked_at IS NULL;`);
  assert.equal(one(db, "SELECT discord_linked_at FROM users WHERE id = 'u_old'"), 5);
  assert.equal(one(db, "SELECT first_linked_at FROM bnet_links WHERE user_id = 'u_old'"), 9);
});
check('old release: deleting a guild (custom roles trigger + cascades) works with rank-map rows that reference its custom role', () => {
  exec(db, "INSERT INTO roles (id, guild_id, name, rank) VALUES ('role_custom', 'g_old', 'Custom', 3)");
  exec(db, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id) VALUES ('g_old', 'ingame', '4', 'Custom rank', 'raider', 'role_custom', 't_old')");
  exec(db, "INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, rank) VALUES ('g_old', 'n', 1, 1, 'A', 'a', 's', 'MAGE', 1)");
  exec(db, "INSERT INTO roster_syncs (id, guild_id, started_at, good) VALUES ('rs_old', 'g_old', 1, 1)");
  exec(db, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, renamed_at) VALUES ('al_old', 'g_old', 'c_old', 'x', 1)");
  exec(db, "INSERT INTO person_joins (id, guild_id, survivor_player_id, loser_player_id, joined_at) VALUES ('pj_old', 'g_old', 'p_old', 'p_x', 1)");
  exec(db, "INSERT INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES ('g_old', 'b', 1, 'h', 1)");
  exec(db, "INSERT INTO person_blocks (guild_id, player_id, created_at) VALUES ('g_old', 'p_old', 1)");
  exec(db, "INSERT INTO dry_run_approvals (token_hash, guild_id, map_hash, roster_sync_id, created_at, expires_at) VALUES ('th_old', 'g_old', 'm', 's', 1, 2)");
  // Deleting the custom role first SETs the map's role_id NULL (it never blocks the delete).
  exec(db, "DELETE FROM roles WHERE id = 'role_custom'");
  assert.equal(one(db, "SELECT role_id FROM source_rank_maps WHERE guild_id = 'g_old'"), null);
  exec(db, "INSERT INTO roles (id, guild_id, name, rank) VALUES ('role_custom2', 'g_old', 'Custom2', 3)");
  exec(db, "UPDATE source_rank_maps SET role_id = 'role_custom2'");
  exec(db, "DELETE FROM guilds WHERE id = 'g_old'");
  for (const table of ['source_rank_maps', 'guild_roster', 'roster_syncs', 'character_name_aliases', 'person_joins', 'block_tombstones', 'person_blocks', 'dry_run_approvals', 'characters', 'teams']) {
    assert.equal(one(db, `SELECT COUNT(*) FROM ${table} WHERE guild_id = 'g_old'`), 0, table);
  }
  assert.equal(one(db, "SELECT COUNT(*) FROM roles WHERE guild_id = 'g_old'"), 0);
  exec(db, "DELETE FROM users WHERE id = 'u_old'");
});
check('the tail of the file is rerunnable: every CREATE is IF NOT EXISTS and both backfills carry an IS NULL guard', () => {
  const tail = MIGRATION_0031.split('\n').filter((line) => !/^ALTER TABLE/.test(line)).join('\n');
  const snapshot = () => JSON.stringify({
    schema: rows(db, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"),
    users: dump(db, 'users'), links: dump(db, 'bnet_links'),
  });
  const first = snapshot();
  exec(db, tail);
  assert.equal(snapshot(), first);
  assert.doesNotMatch(MIGRATION_0031.replace(/^--.*$/gm, ''), /CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER)(?! IF NOT EXISTS)/);
});
check('PRAGMA foreign_key_check is clean on the migrated seed, and on a bare 0001..0031 database', () => {
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  const fresh = createD1Fake();
  assert.deepEqual(rows(fresh, 'PRAGMA foreign_key_check'), []);
  for (const table of Object.keys(NEW_TABLES)) assert.deepEqual(columns(fresh, table), NEW_TABLES[table], table);
  for (const [table, cols] of Object.entries(NEW_COLUMNS)) assert.deepEqual(columns(fresh, table).slice(-cols.length), cols, table);
});

// The test runner awaits async checks in order.
(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed += 1; console.log(`ok   ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
