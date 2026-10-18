-- Raidsmith guild tracker, Phase 6: native sign-ups and the weekly raid schedule.
-- 0009 belongs to the Battle.net branch; migrations apply by file name, so the gap is harmless.
-- A native sign-up is a raid_signups row with source = 'raidsmith' (the source CHECK of 0003 already allows it), so the attendance
-- recompute reads it with every other source and nothing there changes. It is keyed by PERSON (one per person per raid), carries the
-- character and spec in Raid-Helper's words (class_name 'Warrior', spec_name 'Holy1'), and holds no Discord ID or nickname.
-- Times are INTEGER epoch ms; start_time is a guild-local 'HH:MM'.

-- Everyone holds Member, so this one row gives every signed-in person the right on the teams they have a character on.
INSERT INTO role_permissions (role_id, action, scope) VALUES ('member', 'signups.self', 'own_teams');

-- An officer closes sign-ups early; members cannot change a sign-up while this is 1 or after the raid's start.
ALTER TABLE raids ADD COLUMN signups_locked INTEGER NOT NULL DEFAULT 0 CHECK (signups_locked IN (0, 1));

ALTER TABLE raid_signups ADD COLUMN character_id TEXT REFERENCES characters(id) ON DELETE SET NULL;
ALTER TABLE raid_signups ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 120);
ALTER TABLE raid_signups ADD COLUMN updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE raid_signups ADD COLUMN created_at INTEGER;
ALTER TABLE raid_signups ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX raid_signups_raidsmith_person ON raid_signups(raid_id, player_id) WHERE source = 'raidsmith';

-- player_id goes NULL when the person is deleted (the plain FK of 0003). A native sign-up without a person means nothing: it goes too.
CREATE TRIGGER raid_signups_raidsmith_orphan AFTER UPDATE OF player_id ON raid_signups
WHEN NEW.source = 'raidsmith' AND NEW.player_id IS NULL
BEGIN
  DELETE FROM raid_signups WHERE raid_id = NEW.raid_id AND source = 'raidsmith' AND signup_id = NEW.signup_id;
END;

-- How many weeks "Create upcoming raids" fills, and whether an officer opening Raids fills them without asking.
ALTER TABLE teams ADD COLUMN schedule_weeks INTEGER NOT NULL DEFAULT 2 CHECK (schedule_weeks BETWEEN 1 AND 8);
ALTER TABLE teams ADD COLUMN schedule_auto INTEGER NOT NULL DEFAULT 0 CHECK (schedule_auto IN (0, 1));

-- One weekly slot of a team. A team has one raid per day (raids_team_day), so one slot per weekday.
CREATE TABLE team_schedules (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time  TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59'),
  zone        TEXT CHECK (zone IS NULL OR length(zone) <= 60),
  title       TEXT CHECK (title IS NULL OR length(title) <= 100),
  created_at  INTEGER NOT NULL,
  UNIQUE (team_id, weekday),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
