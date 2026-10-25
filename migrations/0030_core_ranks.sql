-- Raidsmith user hierarchy, B0: core ranks, proof and identity-key columns on characters; characters.team_id becomes optional.
-- Schema + backfill ONLY.
--
-- 1. core_ranks: lookup table (id, label, sort), four rows. Behaviour flags live in code, not here (no CHECK list on characters.core_rank).
-- 2. characters is REBUILT ONCE (CHECK/NOT NULL cannot be altered in place). D1 cannot switch foreign keys off and two tables reference it
--    (raid_signups.character_id 0010, standing_signups.character_id 0015, both ON DELETE SET NULL), so their links are saved to side
--    tables first, DROP TABLE nulls them, and they are restored afterwards. Same ids, same columns, same indexes, same triggers.
--    Documented exception to agent-brief's "never rebuild a table others reference".
--    New columns:
--      core_rank          FK core_ranks, DEFAULT 'raider' so today's INSERTs keep working until lane B2
--      left_on            TEXT YYYY-MM-DD, same CHECK as players.left_on
--      left_reason        same CHECK as players.left_reason
--      trial_start/_end   TEXT YYYY-MM-DD with the same checks as players.trial_start / trial_end
--      owner_proof        nullable, DEFAULT 'officer' (old code inserting between this apply and the push), CHECK bnet|officer|hand
--      proof_user_id      FK users(id) ON DELETE SET NULL; proof_bnet_account_id; proof_at (INTEGER)
--      namespace, blizzard_char_id, blizzard_realm_id   the identity key; all NULL here (filled by the roster sync / sign-in match)
--    team_id is now NULLABLE (composite FK to teams kept; SQLite does not enforce a composite FK when one column is NULL).
-- 3. Backfill from players (players.status stays untouched, legacy): raider / trial / reserve -> that core_rank on EVERY character of the
--    person; inactive -> social, with left_on and left_reason set only when left_reason is 'left' or 'kicked' (break / other / NULL: both
--    stay NULL). players.trial_start / trial_end are copied onto the person's MAIN character only while status = trial.
--    owner_proof = 'officer' on every existing row; the other proof columns and the identity key stay NULL.
-- 4. NOT done here: alts stay on their main's team and there is no unique (team, person) index (lane B2); the partial unique identity
--    index on (guild_id, namespace, blizzard_realm_id, blizzard_char_id) is 0031's.
--
-- RERUN SAFETY. wrangler records the file in d1_migrations only after it ends cleanly, so a rerun is only ever needed after a stop that left
-- partial state. Everything except the DROP + RENAME is idempotent: CREATE ... IF NOT EXISTS, INSERT OR IGNORE for core_ranks, the side tables
-- are created IF NOT EXISTS and refilled ONLY WHEN EMPTY (a rerun never overwrites saved links with nulled ones), the copy into characters_new
-- is INSERT OR REPLACE. DROP TABLE characters cannot be guarded in SQL. What a rerun does after a stop:
--   - before DROP TABLE characters (core_ranks, side tables, characters_new created or filled, characters untouched): the rerun skips what
--     exists, refills empty side tables, refreshes characters_new and runs on to the end.
--   - after DROP TABLE characters, before ALTER TABLE ... RENAME: characters is gone, every link in raid_signups / standing_signups is NULL;
--     the side tables hold the links and characters_new the complete copy. The rerun fails at the copy ("no such table: characters") and
--     changes nothing. It CANNOT recover: recovery = Time Travel restore. (Rehearsed alternative: run the file's tail, ALTER TABLE ... RENAME
--     to the end, by hand.)
--   - after the RENAME, or after the indexes, triggers, link restore or either side-table DROP: the rerun re-copies the renamed table into a
--     fresh characters_new (backfill re-derived from players, same result), drops and renames again, recreates indexes and triggers and
--     restores the links from the side tables (kept if still there, otherwise refilled from the already restored links). It runs to the end.
--   - after the last statement (PRAGMA): nothing is left to do; a rerun repeats the rebuild with the same result.
-- Every rerun that gets past the copy re-derives the new characters columns from players (core_rank, left_on, left_reason, trial dates,
-- owner_proof = 'officer', the rest NULL). Run this file in a quiet window, and never rerun it once code has written ranks, proofs or
-- identity keys.

CREATE TABLE IF NOT EXISTS core_ranks (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  sort   INTEGER NOT NULL
);
INSERT OR IGNORE INTO core_ranks (id, label, sort) VALUES
  ('raider',  'Raider',  1),
  ('trial',   'Trial',   2),
  ('reserve', 'Reserve', 3),
  ('social',  'Social',  4);

PRAGMA defer_foreign_keys = true;

CREATE TABLE IF NOT EXISTS _sig_char (
  raid_id       TEXT NOT NULL,
  source        TEXT NOT NULL,
  signup_id     INTEGER NOT NULL,
  character_id  TEXT NOT NULL,
  PRIMARY KEY (raid_id, source, signup_id)
);
INSERT INTO _sig_char (raid_id, source, signup_id, character_id)
SELECT raid_id, source, signup_id, character_id FROM raid_signups
WHERE character_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _sig_char);

CREATE TABLE IF NOT EXISTS _std_char (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL
);
INSERT INTO _std_char (id, character_id)
SELECT id, character_id FROM standing_signups
WHERE character_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _std_char);

CREATE TABLE IF NOT EXISTS characters_new (
  id                     TEXT PRIMARY KEY,
  guild_id               TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  player_id              TEXT NOT NULL,
  team_id                TEXT,
  name                   TEXT NOT NULL,
  name_key               TEXT NOT NULL,
  realm                  TEXT,                       -- NULL for a ruleset (Forever) guild
  realm_key              TEXT NOT NULL DEFAULT '',   -- '' for a ruleset guild
  class                  TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  main_spec              TEXT,
  off_spec               TEXT,
  is_main                INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  core_rank              TEXT NOT NULL DEFAULT 'raider' REFERENCES core_ranks(id),
  left_on                TEXT CHECK (left_on IS NULL OR date(left_on) IS left_on),
  left_reason            TEXT CHECK (left_reason IS NULL OR left_reason IN ('left', 'kicked', 'break', 'other')),
  trial_start            TEXT CHECK (trial_start IS NULL OR date(trial_start) IS trial_start),
  trial_end              TEXT CHECK (trial_end IS NULL OR date(trial_end) IS trial_end),
  owner_proof            TEXT DEFAULT 'officer' CHECK (owner_proof IS NULL OR owner_proof IN ('bnet', 'officer', 'hand')),
  proof_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  proof_bnet_account_id  TEXT,
  proof_at               INTEGER,
  namespace              TEXT,
  blizzard_char_id       INTEGER,
  blizzard_realm_id      INTEGER,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE RESTRICT,
  CHECK (trial_start IS NULL OR trial_end IS NULL OR trial_end >= trial_start)
);

INSERT OR REPLACE INTO characters_new (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main,
                                       created_at, updated_at, core_rank, left_on, left_reason, trial_start, trial_end, owner_proof)
SELECT c.id, c.guild_id, c.player_id, c.team_id, c.name, c.name_key, c.realm, c.realm_key, c.class, c.main_spec, c.off_spec, c.is_main,
       c.created_at, c.updated_at,
       CASE p.status WHEN 'inactive' THEN 'social' ELSE p.status END,
       CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_on END,
       CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_reason END,
       CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_start END,
       CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_end END,
       'officer'
FROM characters c JOIN players p ON p.id = c.player_id;

DROP TABLE characters;
ALTER TABLE characters_new RENAME TO characters;

CREATE UNIQUE INDEX IF NOT EXISTS characters_guild_name ON characters(guild_id, name_key, realm_key);
CREATE UNIQUE INDEX IF NOT EXISTS characters_one_main ON characters(player_id) WHERE is_main = 1;
CREATE INDEX IF NOT EXISTS characters_player ON characters(player_id);
CREATE INDEX IF NOT EXISTS characters_team ON characters(team_id);
CREATE INDEX IF NOT EXISTS characters_unassigned ON characters(guild_id) WHERE team_id IS NULL;
CREATE INDEX IF NOT EXISTS characters_core_rank ON characters(guild_id, core_rank);

CREATE TRIGGER IF NOT EXISTS characters_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE player_id = NEW.player_id) >= 20
  BEGIN SELECT RAISE(ABORT, 'character_limit'); END;
CREATE TRIGGER IF NOT EXISTS characters_guild_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE guild_id = NEW.guild_id) >= 5000
  BEGIN SELECT RAISE(ABORT, 'guild_characters_cap'); END;

UPDATE raid_signups SET character_id = (SELECT s.character_id FROM _sig_char s
  WHERE s.raid_id = raid_signups.raid_id AND s.source = raid_signups.source AND s.signup_id = raid_signups.signup_id)
WHERE EXISTS (SELECT 1 FROM _sig_char s WHERE s.raid_id = raid_signups.raid_id AND s.source = raid_signups.source AND s.signup_id = raid_signups.signup_id);
UPDATE standing_signups SET character_id = (SELECT s.character_id FROM _std_char s WHERE s.id = standing_signups.id)
WHERE EXISTS (SELECT 1 FROM _std_char s WHERE s.id = standing_signups.id);

DROP TABLE IF EXISTS _sig_char;
DROP TABLE IF EXISTS _std_char;

PRAGMA defer_foreign_keys = false;
