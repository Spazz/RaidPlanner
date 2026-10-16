-- Raidsmith guild tracker, Phase 2: people (players) and their characters.
-- Officer-picked dates (joined, trial start and end) are calendar dates in the guild's time zone, TEXT YYYY-MM-DD;
-- instants stay INTEGER epoch ms. (date(x) IS x, not = : date() is NULL for text that is no date, and a NULL CHECK passes.)

CREATE TABLE players (
  id                TEXT PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('raider', 'trial', 'reserve', 'inactive')),
  joined_on         TEXT CHECK (joined_on IS NULL OR date(joined_on) IS joined_on),
  trial_start       TEXT CHECK (trial_start IS NULL OR date(trial_start) IS trial_start),
  trial_end         TEXT CHECK (trial_end IS NULL OR date(trial_end) IS trial_end),
  discord_user_id   TEXT CHECK (discord_user_id IS NULL OR (discord_user_id NOT GLOB '*[^0-9]*' AND length(discord_user_id) BETWEEN 17 AND 20)),
  discord_nickname  TEXT CHECK (discord_nickname IS NULL OR length(discord_nickname) <= 64),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  notes_updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes_updated_at  INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,
  notes_version     INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (guild_id, id),
  CHECK (trial_start IS NULL OR trial_end IS NULL OR trial_end >= trial_start)
);
CREATE UNIQUE INDEX players_guild_discord ON players(guild_id, discord_user_id) WHERE discord_user_id IS NOT NULL;
CREATE INDEX players_discord ON players(discord_user_id) WHERE discord_user_id IS NOT NULL;

CREATE TABLE characters (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  realm       TEXT,                       -- NULL for a ruleset (Forever) guild
  realm_key   TEXT NOT NULL DEFAULT '',   -- '' for a ruleset guild
  class       TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  main_spec   TEXT,
  off_spec    TEXT,
  is_main     INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX characters_guild_name ON characters(guild_id, name_key, realm_key);
CREATE UNIQUE INDEX characters_one_main ON characters(player_id) WHERE is_main = 1;
CREATE INDEX characters_player ON characters(player_id);
CREATE INDEX characters_team ON characters(team_id);

CREATE TRIGGER players_cap BEFORE INSERT ON players
  WHEN (SELECT count(*) FROM players WHERE guild_id = NEW.guild_id) >= 1000
  BEGIN SELECT RAISE(ABORT, 'person_limit'); END;
CREATE TRIGGER characters_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE player_id = NEW.player_id) >= 20
  BEGIN SELECT RAISE(ABORT, 'character_limit'); END;
