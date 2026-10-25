-- Raidsmith user hierarchy, lane S (R1): the schema every later hierarchy lane writes to. Schema + two backfills ONLY, no table rebuild.
-- ALTER TABLE ... ADD COLUMN (nullable, or NOT NULL with a DEFAULT), new tables, new indexes and ONE trigger. No Worker behaviour reads or
-- writes any of it until the lane that owns it ships (plan: tasks/todo.md, PLAN v9, "Model" + "Migrations" + "Fix as we go").
--
-- WHAT EACH PART IS FOR
--  guilds             rank_source        NULL = legacy guild (today's rules) | 'ingame' | 'manual'; later 'discord'. Plain TEXT, no CHECK list: a
--                                        CHECK on an added column can never be changed again without rebuilding guilds, which is forbidden.
--                     owner_user_id      the Owner seat (FK users, SET NULL). Set only by the flip / guild creation / hand-over.
--                     pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_realm_id, blizzard_guild_id
--                                        the pinned Blizzard target: every roster fetch reads ONLY these (never guild.name / realm_slug).
--                                        (game_version, region, blizzard_realm_id, blizzard_guild_id) is unique: one Raidsmith guild per Blizzard
--                                        guild. NULLs are distinct in a unique index, so unpinned guilds never collide.
--                     next_sync_at       the sync lease / schedule (DEFAULT 0 = due). last_good_sync_id = the roster_syncs row of the last GOOD
--                                        sync (plain TEXT, no FK: roster_syncs rows are pruned and the prune keeps the row this names).
--                                        last_good_fetched_at = the fetch time of the roster in guild_roster (the monotonic-guard value, Fix as
--                                        we go B4a-code). roster_hash = hash of that roster (an unchanged hash writes no roster rows).
--  users              discord_linked_at  when the Discord identity was first attached (identity-change protection, plan "Identity-change").
--  bnet_links         first_linked_at    when this Battle.net account was first linked; the link UPSERT never touches it (only unlink + link does).
--  sessions           fresh_purpose, fresh_hash, fresh_at   the session's fresh-auth grant: purpose, hash of the act's parameters, grant time.
--  fresh_act_markers  per-act marker rows: the act's first statement consumes the grant, the second inserts a marker WHERE changes() = 1 and every
--                     later statement of the act carries EXISTS (marker). No FK: rows are ephemeral (retention prunes them past 15 minutes) and the
--                     flip reuses the table (purpose 'flip'). (act_id, session_token_hash, purpose, at)
--  oauth_state_nonces single-use OAuth state nonces (nonce_hash PK, created_at, used_at); a replayed state is refused before the code exchange.
--  team_notifications set_by, set_at     who last changed the team's webhook/notification settings (display only).
--  source_rank_maps   in-game (later Discord) rank -> core rank + permission role (+ reserved team). PK (guild_id, source, source_key).
--                     CHECK (role_id <> 'guild_master' OR source_key = '0'): only in-game rank 0 may map to Guild Master. role_id NULL = no
--                     permission role (Member). role_id is FK roles SET NULL (never RESTRICT: the guilds_delete_custom_roles trigger deletes the
--                     guild's roles BEFORE the guild's cascade reaches this table). Code validates that role_id is a system role or this guild's.
--                     team_id is reserved (ranks-set-team), composite FK (guild_id, team_id) -> teams.
--  guild_roster       the guild's CURRENT in-game roster, atomically replaced by each changed good sync (DELETE the guild's rows + INSERT ... SELECT
--                     json_each in one batch). No sync_id: "on the roster" = a row here. PK = the identity key (guild_id, namespace, realm id, char id);
--                     unique (guild_id, name_key, realm_slug).
--  roster_syncs       one row per sync attempt (good or not): the audit trail of the roster fetch, pruned after 90 days except last_good_sync_id.
--  character_name_aliases  old name_key of a renamed (or re-homed) character, dated; evidence on or before renamed_at resolves through it.
--                     realm_key (not in the plan's column list) is added so two characters named alike on different realms never share an alias;
--                     '' for a ruleset guild, like characters.realm_key.
--  person_joins       one row per officer person join: survivor, loser, per-table counts (kept as long as the guild; the Activity view resolves old ids).
--  block_tombstones   HMACs of the keys of a block (typed bnet:/discord:/idkey: values, guild id inside the HMAC), so a block survives the person's
--                     account deletion and re-entry. block_ref ties them to their block (unblock deletes by block_ref). key_version supports key rotation.
--  person_blocks      block marker for an account-less roster person (composite FK -> players); tombstone_missing flags a block written while
--                     TOMBSTONE_KEY was unset (the R4 repair script finds it).
--  guild_blocks       + pending_review (a tombstone match inserted this block: it ENFORCES but sits in the officer review queue) and
--                     tombstone_missing. blocked_by already exists since 0001 (FK users, ON DELETE SET NULL): nothing to add.
--  dry_run_approvals  single-use flip/rank-map approval: PK = hash of the token, bound to guild, approver user, map hash, roster sync id and expiry.
--  audit_log          + actor_short_id, actor_role: the actor snapshot (short id + role at the time) that survives the account's deletion.
--  characters         + the identity-key unique index (partial: all keys are NULL until the roster sync / sign-in match fills them), the lookup
--                     indexes, characters(guild_id, id) UNIQUE (the parent key for composite tenant FKs from the new tables), and
--                     characters(proof_user_id) so deleting an account does not scan characters for the SET NULL of proof_user_id.
--  players            the proof-clearing TRIGGER: any real change of players.user_id nulls owner_proof, proof_user_id, proof_bnet_account_id and
--                     proof_at on that person's characters (a proof belongs to the account that earned it).
--
-- INDEXES FOR THE USERS LIST "LAST SEEN" LOOKUPS (checked against the schema at 0030):
--   raid_signups by player ...... MISSING (only raid_signups_discord, raid_signups_guest_resolution, raid_signups_raidsmith_person exist, none leads
--                                 with player_id) -> ADDED here: raid_signups_player (player_id, raid_id) WHERE player_id IS NOT NULL.
--   loot_awards by winner key ... EXISTS (0008 loot_awards_winner on (guild_id, winner_name_key, winner_realm_key)) -> nothing added.
--   attendance by player ........ EXISTS (attendance_player; raid_roster_player on (player_id, raid_id)) -> nothing added.
--   applications by account ..... EXISTS (applications_user) -> nothing added.
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live, so the old Worker runs on the new schema):
--   - every added column is nullable or has a DEFAULT, and every INSERT in the old Worker names its columns (no INSERT without a column list,
--     no SELECT * into a fixed-width structure), so none of the old statements changes meaning; old code never reads the new columns.
--   - every new table is empty and unread by the old code; the new indexes only add maintenance work. Two of them are unique, over columns
--     that are NULL on every existing row (guilds identity, characters identity), so they cannot reject an old write; the third unique one,
--     characters(guild_id, id), repeats the primary key plus a column.
--   - FK columns to users are ON DELETE SET NULL, so the old Delete-my-data path (DELETE FROM users) works unchanged; new tables that reference
--     guilds cascade with it, and the old guild-delete path (the guilds_delete_custom_roles trigger + cascades) works unchanged.
--   - the trigger only fires on UPDATEs of players.user_id that change the value, and only rewrites proof columns of that person's characters.
--     The old code never reads those columns, so the only effect of an old-code relink is that the person's characters end with owner_proof
--     NULL instead of 'officer' (and no proof_*): characters.owner_proof is nullable, which is why 0030 made it so.
--   WINDOW REPAIR (the R1 re-derive, run right before and after the push; both statements are idempotent): rows the previous release wrote
--   between this apply and the push carry NULL where the new code expects a value:
--     UPDATE users SET discord_linked_at = created_at WHERE discord_id IS NOT NULL AND discord_linked_at IS NULL;
--     UPDATE bnet_links SET first_linked_at = linked_at WHERE first_linked_at IS NULL;
--     UPDATE characters SET owner_proof = 'officer' WHERE owner_proof IS NULL AND player_id IN (SELECT id FROM players WHERE user_id IS NOT NULL);
--
-- RERUN. wrangler records the file only after it ends cleanly. ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS, so a rerun after a stop part
-- way through fails at the first ALTER already applied; recovery = Time Travel bookmark, or run the statements after the last one that applied.
-- Every CREATE below is IF NOT EXISTS and both backfills carry an IS NULL guard, so the tail of the file is rerunnable.

-- ---- guilds -------------------------------------------------------------------------------------------------------------------------
ALTER TABLE guilds ADD COLUMN rank_source TEXT;
ALTER TABLE guilds ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE guilds ADD COLUMN pinned_guild_slug TEXT CHECK (pinned_guild_slug IS NULL OR length(pinned_guild_slug) BETWEEN 1 AND 100);
ALTER TABLE guilds ADD COLUMN pinned_realm_slug TEXT CHECK (pinned_realm_slug IS NULL OR (length(pinned_realm_slug) BETWEEN 1 AND 50 AND pinned_realm_slug NOT GLOB '*[^a-z0-9-]*'));
ALTER TABLE guilds ADD COLUMN pinned_namespace TEXT CHECK (pinned_namespace IS NULL OR length(pinned_namespace) BETWEEN 1 AND 64);
ALTER TABLE guilds ADD COLUMN blizzard_realm_id INTEGER CHECK (blizzard_realm_id IS NULL OR blizzard_realm_id > 0);
ALTER TABLE guilds ADD COLUMN blizzard_guild_id INTEGER CHECK (blizzard_guild_id IS NULL OR blizzard_guild_id > 0);
ALTER TABLE guilds ADD COLUMN next_sync_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN last_good_sync_id TEXT;
ALTER TABLE guilds ADD COLUMN last_good_fetched_at INTEGER;
ALTER TABLE guilds ADD COLUMN roster_hash TEXT;
CREATE INDEX IF NOT EXISTS guilds_owner ON guilds(owner_user_id);
CREATE INDEX IF NOT EXISTS guilds_next_sync ON guilds(next_sync_at);
CREATE UNIQUE INDEX IF NOT EXISTS guilds_blizzard_identity ON guilds(game_version, region, blizzard_realm_id, blizzard_guild_id);

-- ---- accounts, sessions, fresh-auth, OAuth state -----------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN discord_linked_at INTEGER;
UPDATE users SET discord_linked_at = created_at WHERE discord_id IS NOT NULL AND discord_linked_at IS NULL;

ALTER TABLE bnet_links ADD COLUMN first_linked_at INTEGER;
UPDATE bnet_links SET first_linked_at = linked_at WHERE first_linked_at IS NULL;

ALTER TABLE sessions ADD COLUMN fresh_purpose TEXT;
ALTER TABLE sessions ADD COLUMN fresh_hash TEXT;
ALTER TABLE sessions ADD COLUMN fresh_at INTEGER;

CREATE TABLE IF NOT EXISTS fresh_act_markers (
  act_id              TEXT PRIMARY KEY,
  session_token_hash  TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fresh_act_markers_at ON fresh_act_markers(at);

CREATE TABLE IF NOT EXISTS oauth_state_nonces (
  nonce_hash  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_state_nonces_created ON oauth_state_nonces(created_at);

-- ---- team notifications ------------------------------------------------------------------------------------------------------------------
ALTER TABLE team_notifications ADD COLUMN set_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE team_notifications ADD COLUMN set_at INTEGER;

-- ---- rank map -----------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_rank_maps (
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  source_key  TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 32),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  core_rank   TEXT NOT NULL REFERENCES core_ranks(id),
  role_id     TEXT REFERENCES roles(id) ON DELETE SET NULL,
  team_id     TEXT,
  PRIMARY KEY (guild_id, source, source_key),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  CHECK (role_id <> 'guild_master' OR source_key = '0')
);

-- ---- roster sync --------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_roster (
  guild_id           TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  namespace          TEXT NOT NULL,
  blizzard_realm_id  INTEGER NOT NULL CHECK (blizzard_realm_id > 0),
  blizzard_char_id   INTEGER NOT NULL CHECK (blizzard_char_id > 0),
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL,
  realm_slug         TEXT NOT NULL,
  class              TEXT NOT NULL,
  level              INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 100),
  rank               INTEGER NOT NULL CHECK (rank BETWEEN 0 AND 9),
  PRIMARY KEY (guild_id, namespace, blizzard_realm_id, blizzard_char_id),
  UNIQUE (guild_id, name_key, realm_slug)
);
CREATE INDEX IF NOT EXISTS guild_roster_identity ON guild_roster(namespace, blizzard_realm_id, blizzard_char_id);

CREATE TABLE IF NOT EXISTS roster_syncs (
  id           TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  good         INTEGER NOT NULL CHECK (good IN (0, 1)),
  http_status  INTEGER,
  reason       TEXT,
  counts       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts))
);
CREATE INDEX IF NOT EXISTS roster_syncs_guild_started ON roster_syncs(guild_id, started_at);

-- ---- characters: identity key, proof, tenant parent key ----------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS characters_identity ON characters(guild_id, namespace, blizzard_realm_id, blizzard_char_id) WHERE blizzard_char_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS characters_identity_lookup ON characters(namespace, blizzard_realm_id, blizzard_char_id);
CREATE INDEX IF NOT EXISTS characters_player_proof ON characters(player_id, owner_proof);
CREATE INDEX IF NOT EXISTS characters_proof_user ON characters(proof_user_id) WHERE proof_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS characters_guild_id ON characters(guild_id, id);

CREATE TABLE IF NOT EXISTS character_name_aliases (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  realm_key     TEXT NOT NULL DEFAULT '',
  renamed_at    INTEGER NOT NULL,
  FOREIGN KEY (guild_id, character_id) REFERENCES characters(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS character_name_aliases_character ON character_name_aliases(guild_id, character_id);
CREATE INDEX IF NOT EXISTS character_name_aliases_name ON character_name_aliases(guild_id, name_key, realm_key, renamed_at);

-- The proof-clearing trigger. FK actions (DELETE FROM users -> players.user_id SET NULL) are UPDATEs too; whether they fire it is pinned by
-- tests/guild/guild-migration-0031-tests.js.
CREATE TRIGGER IF NOT EXISTS players_user_change_clears_proof AFTER UPDATE OF user_id ON players
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  UPDATE characters SET owner_proof = NULL, proof_user_id = NULL, proof_bnet_account_id = NULL, proof_at = NULL WHERE player_id = NEW.id;
END;

-- ---- person join --------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_joins (
  id                  TEXT PRIMARY KEY,
  guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  survivor_player_id  TEXT NOT NULL,
  loser_player_id     TEXT NOT NULL,
  counts              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts)),
  joined_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  joined_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS person_joins_loser ON person_joins(guild_id, loser_player_id);
CREATE INDEX IF NOT EXISTS person_joins_survivor ON person_joins(guild_id, survivor_player_id);

-- ---- blocks -------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE guild_blocks ADD COLUMN pending_review INTEGER NOT NULL DEFAULT 0 CHECK (pending_review IN (0, 1));
ALTER TABLE guild_blocks ADD COLUMN tombstone_missing INTEGER NOT NULL DEFAULT 0 CHECK (tombstone_missing IN (0, 1));

CREATE TABLE IF NOT EXISTS block_tombstones (
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  block_ref    TEXT NOT NULL,
  key_version  INTEGER NOT NULL CHECK (key_version >= 1),
  hmac         TEXT NOT NULL CHECK (length(hmac) > 0),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, block_ref, key_version, hmac)
);
CREATE INDEX IF NOT EXISTS block_tombstones_lookup ON block_tombstones(guild_id, hmac, key_version);

CREATE TABLE IF NOT EXISTS person_blocks (
  guild_id           TEXT NOT NULL,
  player_id          TEXT NOT NULL,
  blocked_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason             TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  tombstone_missing  INTEGER NOT NULL DEFAULT 0 CHECK (tombstone_missing IN (0, 1)),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (guild_id, player_id),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);

-- ---- dry-run approvals --------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dry_run_approvals (
  token_hash        TEXT PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  approver_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  map_hash          TEXT NOT NULL,
  roster_sync_id    TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  used_at           INTEGER
);
CREATE INDEX IF NOT EXISTS dry_run_approvals_guild ON dry_run_approvals(guild_id, created_at);

-- ---- audit actor snapshot -----------------------------------------------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN actor_short_id TEXT;
ALTER TABLE audit_log ADD COLUMN actor_role TEXT;

-- ---- last-seen lookups (see header: only the missing one) ---------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS raid_signups_player ON raid_signups(player_id, raid_id) WHERE player_id IS NOT NULL;
