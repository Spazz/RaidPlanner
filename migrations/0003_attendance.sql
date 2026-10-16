-- Raidsmith guild tracker, Phase 3: attendance. Raids (one team, one guild-local date), three evidence sources
-- (sign-ups, Warcraft Logs presence per boss pull, the plan), the policy rows and the consolidated result.
-- 0001 and 0002 are never edited: the Raid nights -> Raids rename of the permission actions is an UPDATE here.
-- Times are INTEGER epoch ms; raid dates are guild-local TEXT YYYY-MM-DD; booleans 0/1; JSON is TEXT with json_valid checks.

UPDATE role_permissions SET action = 'raids.view' WHERE action = 'nights.view';
UPDATE role_permissions SET action = 'raids.edit' WHERE action = 'nights.edit';
INSERT INTO role_permissions (role_id, action, scope) VALUES
  ('guild_master', 'attendance.policy', 'guild'), ('officer', 'attendance.policy', 'guild');

ALTER TABLE guilds ADD COLUMN wcl_guild_id INTEGER CHECK (wcl_guild_id IS NULL OR wcl_guild_id > 0);
ALTER TABLE teams  ADD COLUMN wcl_uploaders TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(wcl_uploaders));

CREATE TABLE attendance_policies (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id    TEXT,                                   -- NULL = guild default
  policy     TEXT NOT NULL CHECK (json_valid(policy)),   -- an OVERRIDE object: only the keys set at this level
  version    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX attendance_policies_scope ON attendance_policies(guild_id, COALESCE(team_id, ''));

CREATE TABLE raids (
  id             TEXT PRIMARY KEY,
  guild_id       TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL,
  raid_on        TEXT NOT NULL CHECK (date(raid_on) IS raid_on),   -- guild-local date: event start, else first pull
  starts_at      INTEGER NOT NULL,                                 -- event start, else first pull (sort key)
  zone           TEXT CHECK (zone IS NULL OR length(zone) <= 60),
  event_id       TEXT CHECK (event_id IS NULL OR (event_id NOT GLOB '*[^0-9]*' AND length(event_id) BETWEEN 6 AND 25)),
  event_title    TEXT CHECK (event_title IS NULL OR length(event_title) <= 100),
  event_server   TEXT,
  event_synced   INTEGER,
  plan_label     TEXT CHECK (plan_label IS NULL OR length(plan_label) <= 80),
  plan_synced    INTEGER,
  log_mode       TEXT NOT NULL DEFAULT 'log' CHECK (log_mode IN ('log', 'manual')),   -- manual = "No log - attendance entered by hand"
  manual_reason  TEXT CHECK (manual_reason IS NULL OR length(manual_reason) BETWEEN 3 AND 200),
  manual_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  manual_at      INTEGER,
  open_flags     INTEGER NOT NULL DEFAULT 0,      -- undecided flagged rows + unmatched names; maintained by recompute
  policy_fp      TEXT NOT NULL DEFAULT '',        -- fingerprint of the consolidation rules used; '' = needs recalculating
  computed_at    INTEGER,
  version        INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (guild_id, id),
  CHECK (log_mode = 'log' OR manual_reason IS NOT NULL),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX raids_team_day ON raids(team_id, raid_on);                         -- one team, one date, one raid
CREATE UNIQUE INDEX raids_event ON raids(guild_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX raids_flags ON raids(team_id) WHERE open_flags > 0;

CREATE TABLE raid_reports (                        -- which WCL reports are merged; no report content
  raid_id     TEXT NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  guild_id    TEXT NOT NULL,
  code        TEXT NOT NULL CHECK (length(code) = 16 AND code NOT GLOB '*[^A-Za-z0-9]*'),
  flavour     TEXT NOT NULL CHECK (flavour IN ('www', 'classic', 'fresh')),
  started_at  INTEGER NOT NULL, ended_at INTEGER,
  owner       TEXT CHECK (owner IS NULL OR length(owner) <= 40),      -- uploader name, for the backfill filter
  synced_at   INTEGER NOT NULL,
  PRIMARY KEY (raid_id, code)
);
CREATE UNIQUE INDEX raid_reports_code ON raid_reports(guild_id, code);                 -- a report backs one raid

CREATE TABLE raid_pulls (                          -- one row per boss pull (derived)
  id             INTEGER PRIMARY KEY,
  raid_id        TEXT NOT NULL,
  report_code    TEXT NOT NULL,
  fight_id       INTEGER NOT NULL,
  encounter_id   INTEGER NOT NULL,
  encounter_name TEXT NOT NULL CHECK (length(encounter_name) <= 60),
  kill           INTEGER NOT NULL CHECK (kill IN (0, 1)),
  started_at     INTEGER NOT NULL,                -- ABSOLUTE ms: report start + fight offset (orders merged reports)
  ended_at       INTEGER NOT NULL,
  UNIQUE (raid_id, report_code, fight_id),
  FOREIGN KEY (raid_id, report_code) REFERENCES raid_reports(raid_id, code) ON DELETE CASCADE
);
CREATE INDEX raid_pulls_raid ON raid_pulls(raid_id, started_at);

CREATE TABLE raid_presence (                       -- the character was in this pull
  pull_id    INTEGER NOT NULL REFERENCES raid_pulls(id) ON DELETE CASCADE,
  raid_id    TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  realm      TEXT,
  realm_key  TEXT NOT NULL DEFAULT '',
  class      TEXT CHECK (class IS NULL OR class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  PRIMARY KEY (pull_id, name_key, realm_key)
);
CREATE INDEX raid_presence_raid ON raid_presence(raid_id);
CREATE INDEX raid_presence_name ON raid_presence(guild_id, name_key);      -- retro-matching after an Alt link

CREATE TABLE raid_signups (
  raid_id          TEXT NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  source           TEXT NOT NULL DEFAULT 'raid_helper' CHECK (source IN ('raid_helper', 'plan', 'raidsmith')),   -- 'raidsmith' reserved, not built
  signup_id        INTEGER NOT NULL,              -- Raid-Helper sign-up id; plan rows: ordinal in the plan
  discord_user_id  TEXT,                          -- NULL after Delete my data
  nickname         TEXT CHECK (nickname IS NULL OR length(nickname) <= 64),   -- NULL after Delete my data
  kind             TEXT NOT NULL CHECK (kind IN ('signed', 'late', 'bench', 'tentative', 'absence')),
  class_name       TEXT, spec_name TEXT,          -- source strings, display only
  position         INTEGER NOT NULL,
  guild_id         TEXT NOT NULL,
  player_id        TEXT,                          -- Raid-Helper: from the Discord ID at ingest, survives the scrub; plan: from the character match
  PRIMARY KEY (raid_id, source, signup_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL   -- plain FK: SQLite has no column-list SET NULL and guild_id must survive; the guild match is the triggers below
);
CREATE INDEX raid_signups_discord ON raid_signups(discord_user_id) WHERE discord_user_id IS NOT NULL;

-- A sign-up's person must belong to the sign-up's guild (the composite FK of the draft cannot SET NULL one column).
CREATE TRIGGER raid_signups_same_guild_insert BEFORE INSERT ON raid_signups
WHEN NEW.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND guild_id = NEW.guild_id)
BEGIN SELECT RAISE(ABORT, 'signup_person_guild'); END;
CREATE TRIGGER raid_signups_same_guild_update BEFORE UPDATE OF player_id, guild_id ON raid_signups
WHEN NEW.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND guild_id = NEW.guild_id)
BEGIN SELECT RAISE(ABORT, 'signup_person_guild'); END;

CREATE TABLE raid_manual (                         -- who was present on a manual raid (log_mode = 'manual')
  raid_id    TEXT NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  guild_id   TEXT NOT NULL,
  player_id  TEXT NOT NULL,
  PRIMARY KEY (raid_id, player_id),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);

CREATE TABLE raid_plan (                           -- names + group sent by the browser; its placements are also written as raid_signups (source 'plan') by recompute
  raid_id       TEXT NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  group_number  INTEGER NOT NULL CHECK (group_number BETWEEN 0 AND 8),   -- 0 = bench
  PRIMARY KEY (raid_id, name_key)
);

CREATE TABLE attendance (                          -- the consolidated result; recomputed, decisions kept
  raid_id           TEXT NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  guild_id          TEXT NOT NULL,
  team_id           TEXT NOT NULL,                 -- the raid's team (team queries without a join)
  player_id         TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('present','bench','missed','missed_notice','late','left_early','late_left','fill_in','no_signup','tentative')),
  credit            REAL CHECK (credit IS NULL OR (credit >= 0 AND credit <= 1)),   -- NULL = pending / not counted
  signup_kind       TEXT,
  attended          INTEGER NOT NULL DEFAULT 0,    -- in at least one boss pull, or ticked on a manual raid
  presence_source   TEXT NOT NULL DEFAULT 'log' CHECK (presence_source IN ('log', 'officer')),
  via_raid_id       TEXT,                          -- Other-team cell on a home raid: the host raid that replaced it
  pulls_present     INTEGER NOT NULL DEFAULT 0, pulls_total INTEGER NOT NULL DEFAULT 0,
  missed_first      INTEGER NOT NULL DEFAULT 0, missed_last INTEGER NOT NULL DEFAULT 0,
  flags             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),    -- sorted types, e.g. ["left_early"]
  credit_team_id    TEXT,                          -- host-side fill_in row only: the team that receives the credit
  needs_review      INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  decided_outcome   TEXT, decided_credit REAL, decided_credit_id TEXT,
  decided_reason    TEXT CHECK (decided_reason IS NULL OR length(decided_reason) BETWEEN 3 AND 200),
  decided_flags     TEXT,                          -- the flags the decision answered; differs from flags -> reopened
  decided_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        INTEGER,
  PRIMARY KEY (raid_id, player_id),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX attendance_player ON attendance(player_id);
CREATE INDEX attendance_credit_team ON attendance(credit_team_id) WHERE credit_team_id IS NOT NULL;
CREATE INDEX attendance_review ON attendance(raid_id) WHERE needs_review = 1;

CREATE TABLE attendance_guests (                   -- characters an officer marked "guest"
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name_key   TEXT NOT NULL, realm_key TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name_key, realm_key)
);
