-- Raidsmith guild tracker, PM wave 8 (WoW Forever launch readiness). Spec: tasks/guild-pm-wave8-spec.md.
-- Nothing that other tables reference is rebuilt (D1 cannot switch foreign keys off). ADD COLUMN and new tables only, with ONE exception: notification_log
-- is a leaf (no table references it), so its kind CHECK is widened by a copy, which cannot fire any ON DELETE action.
--
-- 1. Forever surnames need almost no schema: characters.name / name_key and every other name column already hold any text, and the Worker's cleaner
--    (worker/roster-data.js cleanCharacterName) decides what a name may be per game version. The one CHECK that said "2 to 12 letters" is the pasted
--    TMB / softres list (raid_loot_lists.name): 0023_wave8_forever_names.sql widens it.
-- 2. Raid duties (Raid leader, Loot master, Logger, Plan maker, one free-text extra) and the "upload the log" nudge (a notification_log kind).
-- 3. The launch funnel: a team's "launch team" flag and the officer- or member-set parts of each person's row (level band, ready).
-- 4. The guest sign-up link of a raid and the guest flag of a native sign-up (a sign-up with no roster person).
-- 5. A pasted raid roster: the names that matched nobody wait in the review queue like unmatched log names.
-- Times are INTEGER epoch ms; booleans are 0/1.

-- ---------------------------------------------------------------------------
-- Raid duties

-- One person per duty per raid; 'extra' is the officer's own words (label), the four fixed duties have none.
CREATE TABLE raid_duties (
  raid_id    TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  duty       TEXT NOT NULL CHECK (duty IN ('leader', 'loot', 'logger', 'planner', 'extra')),
  player_id  TEXT NOT NULL,
  label      TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
  PRIMARY KEY (raid_id, duty),
  CHECK ((duty = 'extra') = (label IS NOT NULL)),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX raid_duties_player ON raid_duties(guild_id, player_id);

-- notification_log with one more kind, 'log_nudge'. A copy, then the old table goes: nothing references it.
CREATE TABLE notification_log_w8 (
  id           TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  team_id      TEXT NOT NULL,
  raid_id      TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('roster', 'loot', 'remind_24h', 'remind_2h', 'no_reply', 'confirm', 'log_nudge')),
  dedupe_key   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'retry', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  people       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
INSERT INTO notification_log_w8 (id, guild_id, team_id, raid_id, kind, dedupe_key, status, attempts, http_status, people, created_at, sent_at)
  SELECT id, guild_id, team_id, raid_id, kind, dedupe_key, status, attempts, http_status, people, created_at, sent_at FROM notification_log;
DROP TABLE notification_log;
ALTER TABLE notification_log_w8 RENAME TO notification_log;
CREATE UNIQUE INDEX notification_log_dedupe ON notification_log(guild_id, dedupe_key);
CREATE INDEX notification_log_created ON notification_log(created_at);

-- ---------------------------------------------------------------------------
-- Launch readiness funnel

-- A team that is shown the Launch funnel whatever the guild's game version (a WoW Forever guild always has it).
ALTER TABLE teams ADD COLUMN launch_team INTEGER NOT NULL DEFAULT 0 CHECK (launch_team IN (0, 1));

-- The parts of a person's funnel row that someone types in. Intent comes from the intent board, "character created" from the roster, and a level
-- from an approved Battle.net claim when there is one; level_band here (set by an officer or the person) wins over that.
CREATE TABLE launch_status (
  guild_id    TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  level_band  TEXT CHECK (level_band IS NULL OR level_band IN ('1-19', '20-39', '40-59', '60+')),
  ready       INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, player_id),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX launch_status_guild ON launch_status(guild_id, team_id);

-- ---------------------------------------------------------------------------
-- Guest sign-up links

-- An officer's link for ONE upcoming raid. The token is 32 random bytes shown once; only its SHA-256 is kept. The link stops working when the raid
-- starts (read from the raid, so it follows the raid if it moves), when it is revoked, and after max_uses guest sign-ups.
CREATE TABLE raid_join_links (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  raid_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  max_uses    INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 50),
  uses        INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at  INTEGER,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX raid_join_links_raid ON raid_join_links(guild_id, raid_id);

-- A guest sign-up is a native (source 'raidsmith') row with no person: nickname holds the character name the guest typed, class_name / spec_name the
-- Raid-Helper words, note the guest's note. The attendance reads only rows with a person, so a guest never gets a percentage.
ALTER TABLE raid_signups ADD COLUMN guest INTEGER NOT NULL DEFAULT 0 CHECK (guest IN (0, 1) AND (guest = 0 OR source = 'raidsmith'));
ALTER TABLE raid_signups ADD COLUMN join_link_id TEXT REFERENCES raid_join_links(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Pasted raid roster

-- The names of a pasted roster (a raid without a log) that matched no character and no guest: the attendance reads them like the names of a log
-- (unmatched until an officer links, adds or marks them as a guest), and a name that later belongs to a person counts that person present.
CREATE TABLE raid_manual_names (
  raid_id    TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  realm      TEXT,
  realm_key  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (raid_id, name_key, realm_key),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
