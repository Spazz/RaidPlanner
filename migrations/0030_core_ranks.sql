-- Raidsmith user hierarchy, B0: core ranks on characters, characters.team_id becomes optional. Schema + backfill ONLY.
--
-- 1. core_ranks: lookup table. Behaviour lives in its flags, not in code enums (no CHECK list on characters.core_rank).
-- 2. characters is REBUILT (CHECK/NOT NULL cannot be altered in place). D1 cannot switch foreign keys off and two tables reference it
--    (raid_signups.character_id 0010, standing_signups.character_id 0015, both ON DELETE SET NULL), so their links are saved to side
--    tables first, DROP TABLE nulls them, and they are restored afterwards. Same ids, same columns, same indexes, same triggers.
--    New columns: core_rank (FK core_ranks, DEFAULT 'raider' so today's INSERTs keep working until lane B2), source_rank_key,
--    left_on (TEXT YYYY-MM-DD, same CHECK as players.left_on; copied straight from it), trial_start / trial_end
--    (TEXT YYYY-MM-DD with the same checks as players.trial_start / trial_end). team_id is now NULLABLE (composite FK to teams kept; SQLite
--    does not enforce a composite FK when one column is NULL).
-- 3. Backfill from players (players.status stays untouched, legacy): raider / trial / reserve -> that core_rank on EVERY character of the
--    person; inactive -> social, with left_on set only when left_reason is 'left' or 'kicked' (break / other / NULL: left_on stays NULL).
--    players.trial_start / trial_end are copied onto the person's MAIN character only while status = trial.
-- 4. NOT done here: alts stay on their main's team and there is no unique (team, person) index. Both land with the code in lane B2.

CREATE TABLE core_ranks (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  sort               INTEGER NOT NULL,
  expected_at_raids  INTEGER NOT NULL DEFAULT 0 CHECK (expected_at_raids IN (0, 1)),
  runs_trial         INTEGER NOT NULL DEFAULT 0 CHECK (runs_trial IN (0, 1)),
  hidden_by_default  INTEGER NOT NULL DEFAULT 0 CHECK (hidden_by_default IN (0, 1))
);
INSERT INTO core_ranks (id, label, sort, expected_at_raids, runs_trial, hidden_by_default) VALUES
  ('raider',  'Raider',  1, 1, 0, 0),
  ('trial',   'Trial',   2, 1, 1, 0),
  ('reserve', 'Reserve', 3, 0, 0, 0),
  ('social',  'Social',  4, 0, 0, 1);

PRAGMA defer_foreign_keys = true;

CREATE TABLE _sig_char AS SELECT raid_id, source, signup_id, character_id FROM raid_signups WHERE character_id IS NOT NULL;
CREATE TABLE _std_char AS SELECT id, character_id FROM standing_signups WHERE character_id IS NOT NULL;

CREATE TABLE characters_new (
  id              TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL,
  team_id         TEXT,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL,
  realm           TEXT,                       -- NULL for a ruleset (Forever) guild
  realm_key       TEXT NOT NULL DEFAULT '',   -- '' for a ruleset guild
  class           TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  main_spec       TEXT,
  off_spec        TEXT,
  is_main         INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  core_rank       TEXT NOT NULL DEFAULT 'raider' REFERENCES core_ranks(id),
  source_rank_key TEXT,
  left_on         TEXT CHECK (left_on IS NULL OR date(left_on) IS left_on),
  trial_start     TEXT CHECK (trial_start IS NULL OR date(trial_start) IS trial_start),
  trial_end       TEXT CHECK (trial_end IS NULL OR date(trial_end) IS trial_end),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE RESTRICT,
  CHECK (trial_start IS NULL OR trial_end IS NULL OR trial_end >= trial_start)
);

INSERT INTO characters_new (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main,
                            created_at, updated_at, core_rank, source_rank_key, left_on, trial_start, trial_end)
SELECT c.id, c.guild_id, c.player_id, c.team_id, c.name, c.name_key, c.realm, c.realm_key, c.class, c.main_spec, c.off_spec, c.is_main,
       c.created_at, c.updated_at,
       CASE p.status WHEN 'inactive' THEN 'social' ELSE p.status END,
       NULL,
       CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_on END,
       CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_start END,
       CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_end END
FROM characters c JOIN players p ON p.id = c.player_id;

DROP TABLE characters;
ALTER TABLE characters_new RENAME TO characters;

CREATE UNIQUE INDEX characters_guild_name ON characters(guild_id, name_key, realm_key);
CREATE UNIQUE INDEX characters_one_main ON characters(player_id) WHERE is_main = 1;
CREATE INDEX characters_player ON characters(player_id);
CREATE INDEX characters_team ON characters(team_id);
CREATE INDEX characters_unassigned ON characters(guild_id) WHERE team_id IS NULL;
CREATE INDEX characters_core_rank ON characters(guild_id, core_rank);

CREATE TRIGGER characters_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE player_id = NEW.player_id) >= 20
  BEGIN SELECT RAISE(ABORT, 'character_limit'); END;
CREATE TRIGGER characters_guild_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE guild_id = NEW.guild_id) >= 5000
  BEGIN SELECT RAISE(ABORT, 'guild_characters_cap'); END;

UPDATE raid_signups SET character_id = (SELECT s.character_id FROM _sig_char s
  WHERE s.raid_id = raid_signups.raid_id AND s.source = raid_signups.source AND s.signup_id = raid_signups.signup_id)
WHERE EXISTS (SELECT 1 FROM _sig_char s WHERE s.raid_id = raid_signups.raid_id AND s.source = raid_signups.source AND s.signup_id = raid_signups.signup_id);
UPDATE standing_signups SET character_id = (SELECT s.character_id FROM _std_char s WHERE s.id = standing_signups.id)
WHERE EXISTS (SELECT 1 FROM _std_char s WHERE s.id = standing_signups.id);

DROP TABLE _sig_char;
DROP TABLE _std_char;

PRAGMA defer_foreign_keys = false;
