-- Raidsmith guild tracker, loot follow-up: disenchanted items. Gargul marks one with the winner "||de||"; the import now records it as
-- an award with NO winner: winner_name and winner_name_key are NULL, winner_realm / winner_class are NULL, winner_realm_key stays '', and the
-- tag is DE (the only tag a no-winner award may hold). Matching reads the NULL key as match.kind 'disenchanted'.
-- SQLite cannot drop NOT NULL in place, so the table is rebuilt (create, copy, drop, rename, indexes). Nothing references loot_awards, so the
-- drop cascades nowhere; defer_foreign_keys is the guard Cloudflare documents for table rebuilds inside a D1 migration.
-- Every column, default, CHECK, FK and index of 0008 is kept. Gaps in the numbering are harmless: migrations apply by file name.

PRAGMA defer_foreign_keys = true;

CREATE TABLE loot_awards_new (
  id               TEXT PRIMARY KEY,
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  raid_id          TEXT NOT NULL,
  team_id          TEXT NOT NULL,                  -- the raid's team, copied (team queries without a join)
  source           TEXT NOT NULL DEFAULT 'gargul' CHECK (source IN ('gargul')),
  checksum         TEXT NOT NULL CHECK (length(checksum) BETWEEN 8 AND 40 AND checksum NOT GLOB '*[^!-~]*'),   -- Gargul's stable award id: printable, no spaces
  item_id          INTEGER NOT NULL CHECK (item_id > 0),
  item_name        TEXT CHECK (item_name IS NULL OR length(item_name) <= 100),
  item_quality     INTEGER CHECK (item_quality IS NULL OR item_quality BETWEEN 0 AND 7),
  awarded_at       INTEGER NOT NULL,
  winner_name      TEXT CHECK (winner_name IS NULL OR length(winner_name) BETWEEN 1 AND 64),   -- NULL = disenchanted (no winner)
  winner_name_key  TEXT,                                                                       -- NULL exactly when winner_name is NULL
  winner_realm     TEXT CHECK (winner_realm IS NULL OR length(winner_realm) <= 40),   -- NULL for a ruleset (Forever) guild, and for a disenchant
  winner_realm_key TEXT NOT NULL DEFAULT '',       -- '' for a ruleset guild, and for a disenchant
  winner_class     TEXT CHECK (winner_class IS NULL OR winner_class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  roll_type        TEXT CHECK (roll_type IS NULL OR length(roll_type) <= 24),
  flags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),   -- Gargul flags, e.g. ["OS","SR"]
  tag              TEXT NOT NULL DEFAULT 'MS' CHECK (tag IN ('MS', 'OS', 'DE', 'BANK')),
  tag_set_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  tag_set_at       INTEGER,                        -- NULL = the tag is automatic (an import may change it); set = an officer chose it (kept). Survives the officer's account being deleted
  note             TEXT CHECK (note IS NULL OR length(note) <= 200),
  awarded_by       TEXT CHECK (awarded_by IS NULL OR length(awarded_by) <= 64),
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (tag_set_by IS NULL OR tag_set_at IS NOT NULL),
  CHECK ((winner_name IS NULL) = (winner_name_key IS NULL)),
  CHECK (winner_name IS NOT NULL OR tag = 'DE'),   -- an award nobody won can only be a disenchant
  UNIQUE (guild_id, checksum),
  FOREIGN KEY (guild_id, team_id, raid_id) REFERENCES raids(guild_id, team_id, id) ON DELETE CASCADE   -- the award's team is its raid's team
);

INSERT INTO loot_awards_new (
  id, guild_id, raid_id, team_id, source, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm,
  winner_realm_key, winner_class, roll_type, flags, tag, tag_set_by, tag_set_at, note, awarded_by, created_by, created_at, updated_at
) SELECT
  id, guild_id, raid_id, team_id, source, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm,
  winner_realm_key, winner_class, roll_type, flags, tag, tag_set_by, tag_set_at, note, awarded_by, created_by, created_at, updated_at
FROM loot_awards;

DROP TABLE loot_awards;
ALTER TABLE loot_awards_new RENAME TO loot_awards;

CREATE INDEX loot_awards_team_time ON loot_awards(guild_id, team_id, awarded_at);
CREATE INDEX loot_awards_raid ON loot_awards(raid_id);
CREATE INDEX loot_awards_winner ON loot_awards(guild_id, winner_name_key, winner_realm_key);
CREATE INDEX loot_awards_item ON loot_awards(guild_id, item_id);

PRAGMA defer_foreign_keys = false;
