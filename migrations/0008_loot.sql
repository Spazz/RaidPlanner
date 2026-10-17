-- Raidsmith guild tracker, Phase 4: loot history. Awards imported from Gargul's Detailed (JSON) export, one raid each, and the
-- loot policy rows (who sees loot, how the balance counts). Matching an award to a character and a person happens on READ
-- (winner name + realm key -> characters, else attendance_guests, else unmatched), so linking a name fixes past awards too.
-- 0007 belongs to the roadmap branch (roadmap_ideas); migrations apply by file name, so the gap is harmless.
-- Times are INTEGER epoch ms; JSON is TEXT with json_valid checks. An award holds no Discord data: nothing to scrub on Delete my data.

INSERT INTO role_permissions (role_id, action, scope) VALUES
  ('guild_master', 'loot.view', 'guild'), ('officer', 'loot.view', 'guild'), ('team_lead', 'loot.view', 'team'), ('member', 'loot.view', 'own_teams'),
  ('guild_master', 'loot.edit', 'guild'), ('officer', 'loot.edit', 'guild'), ('team_lead', 'loot.edit', 'team'),
  ('guild_master', 'loot.policy', 'guild'), ('officer', 'loot.policy', 'guild');

CREATE TABLE loot_policies (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id    TEXT,                                   -- NULL = guild default
  policy     TEXT NOT NULL CHECK (json_valid(policy)),   -- an OVERRIDE object: only the keys set at this level
  version    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX loot_policies_scope ON loot_policies(guild_id, COALESCE(team_id, ''));

CREATE TABLE loot_awards (
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
  winner_name      TEXT NOT NULL CHECK (length(winner_name) BETWEEN 1 AND 64),
  winner_name_key  TEXT NOT NULL,
  winner_realm     TEXT CHECK (winner_realm IS NULL OR length(winner_realm) <= 40),   -- NULL for a ruleset (Forever) guild
  winner_realm_key TEXT NOT NULL DEFAULT '',       -- '' for a ruleset guild
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
  UNIQUE (guild_id, checksum),
  FOREIGN KEY (guild_id, team_id, raid_id) REFERENCES raids(guild_id, team_id, id) ON DELETE CASCADE   -- the award's team is its raid's team
);
CREATE INDEX loot_awards_team_time ON loot_awards(guild_id, team_id, awarded_at);
CREATE INDEX loot_awards_raid ON loot_awards(raid_id);
CREATE INDEX loot_awards_winner ON loot_awards(guild_id, winner_name_key, winner_realm_key);
CREATE INDEX loot_awards_item ON loot_awards(guild_id, item_id);
