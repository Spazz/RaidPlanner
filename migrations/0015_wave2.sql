-- Raidsmith guild tracker, PM wave 2 (sign-up lifecycle + raid sizes): ALL the schema of the wave in one file, so the lanes that build on it
-- (away notices, volunteer standby, standing sign-ups, publishing the roster) share one reviewed foundation. Spec: tasks/guild-pm-wave2-spec.md.
-- 0014 belongs to the Discord roles branch; migrations apply by file name, so the gap is harmless.
-- Nothing that other tables reference is rebuilt (D1 cannot switch foreign keys off: a DROP TABLE would fire every ON DELETE action that points at it).
-- Everything is ALTER TABLE ... ADD COLUMN, an UPDATE of the new column, or a new table, so no existing row is touched but the time_known backfill.
-- A CHECK that cannot be added to an existing column (teams.size has none) is enforced by the Worker instead. Times are INTEGER epoch ms; raid dates
-- and notice dates are guild-local TEXT YYYY-MM-DD; clock times are TEXT 'HH:MM'; booleans are 0/1.

-- ---------------------------------------------------------------------------
-- Raids

-- The raid's own size, 10 / 20 / 25 / 40. NULL = automatic: the zone's size in the guild's game version (worker/raid-zones.js), else the team's size.
ALTER TABLE raids ADD COLUMN size INTEGER CHECK (size IS NULL OR size IN (10, 20, 25, 40));
-- Hours before the start at which a MEMBER's sign-up window closes (officers are never bound). NULL = the team's number.
ALTER TABLE raids ADD COLUMN signup_close_hours INTEGER CHECK (signup_close_hours IS NULL OR signup_close_hours BETWEEN 0 AND 72);
-- 1 = starts_at is a real start time (an event, a report, a typed time or a schedule slot), 0 = only the date is known (starts_at is noon UTC),
-- NULL = unknown, read as a real time (every raid made before this migration that no event or report anchors).
ALTER TABLE raids ADD COLUMN time_known INTEGER CHECK (time_known IS NULL OR time_known IN (0, 1));
-- The published roster (raid_roster below): when, and by whom. NULL = nothing published.
ALTER TABLE raids ADD COLUMN roster_published_at INTEGER;
ALTER TABLE raids ADD COLUMN roster_published_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- An event or a report always gave the start time of the raids that have one.
UPDATE raids SET time_known = 1
 WHERE event_id IS NOT NULL OR EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = raids.id);

-- ---------------------------------------------------------------------------
-- Teams

-- Hours before a raid's start at which members' sign-ups close. 0 = at the start, as before.
ALTER TABLE teams ADD COLUMN signup_close_hours INTEGER NOT NULL DEFAULT 0 CHECK (signup_close_hours BETWEEN 0 AND 72);

-- ---------------------------------------------------------------------------
-- Sign-ups

-- Volunteer standby ("happy to sit out if needed") is a Raidsmith sign-up of kind 'signed' with standby = 1, so the kind CHECK of 0003 and every
-- reader that predates this migration stay valid. Every NEW reader derives the effective kind:
--   CASE WHEN s.kind = 'signed' AND s.standby = 1 THEN 'standby' ELSE s.kind END
-- The CHECK keeps the pair honest: a write that changes the kind away from 'signed' must clear standby in the same statement.
ALTER TABLE raid_signups ADD COLUMN standby INTEGER NOT NULL DEFAULT 0
  CHECK (standby IN (0, 1) AND (standby = 0 OR (kind = 'signed' AND source = 'raidsmith')));
-- 1 = created by a standing sign-up (below) and not edited since; any edit through the sign-up routes sets it back to 0, so it is never auto-removed.
ALTER TABLE raid_signups ADD COLUMN standing INTEGER NOT NULL DEFAULT 0
  CHECK (standing IN (0, 1) AND (standing = 0 OR source = 'raidsmith'));

-- ---------------------------------------------------------------------------
-- Away notices

-- A member's (or an officer's) notice that a person is away, late or leaving early. Two shapes:
--   range:     weekday IS NULL, covers every date from starts_on to ends_on (ends_on is then required);
--   recurring: weekday 0-6 (0 = Sunday), covers every such weekday from starts_on to ends_on (NULL = open-ended).
-- A raid is covered when its guild-local raid_on falls in that set (worker/away.js noticeCovers). The reason is the person's own text: shown only to
-- them and to officers over them. at_time is the arrival ('late') or departure ('leaving') time, guild-local.
CREATE TABLE away_notices (
  id          TEXT PRIMARY KEY,                                   -- 'an_' + 22 characters
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('away', 'late', 'leaving')),
  at_time     TEXT CHECK (at_time IS NULL OR (at_time GLOB '[0-2][0-9]:[0-5][0-9]' AND at_time <= '23:59')),
  starts_on   TEXT NOT NULL CHECK (date(starts_on) IS starts_on),
  ends_on     TEXT CHECK (ends_on IS NULL OR date(ends_on) IS ends_on),
  weekday     INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  reason      TEXT CHECK (reason IS NULL OR length(reason) <= 120),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (kind = 'away' OR at_time IS NOT NULL),                   -- Late and Leaving say when
  CHECK (weekday IS NOT NULL OR ends_on IS NOT NULL),             -- a range has an end; only a recurring notice may be open-ended
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX away_notices_player ON away_notices(guild_id, player_id);
CREATE INDEX away_notices_starts ON away_notices(guild_id, starts_on);

-- ---------------------------------------------------------------------------
-- Standing sign-ups

-- "I'm in for every <weekday> raid of team X": one row per person, team and weekday of one of the team's schedule slots. The reconcile pass turns
-- these into Raidsmith sign-ups (standing = 1) on the team's upcoming raids of that weekday. kind is the sign-up kind they start with.
CREATE TABLE standing_signups (
  id            TEXT PRIMARY KEY,                                 -- 'sg_' + 22 characters
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  kind          TEXT NOT NULL CHECK (kind IN ('signed', 'late')),
  character_id  TEXT REFERENCES characters(id) ON DELETE SET NULL, -- NULL = the person's character on the team, chosen when the sign-up is made
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (team_id, player_id, weekday),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX standing_signups_slot ON standing_signups(team_id, weekday);
CREATE INDEX standing_signups_player ON standing_signups(guild_id, player_id);
CREATE INDEX standing_signups_character ON standing_signups(character_id) WHERE character_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The published roster

-- A snapshot of the raid's plan placements, taken when an officer presses Publish roster: who sits in which group (0 = the bench). One row per
-- character name (the plan's own key), matched to a person when the name is a roster character. status is the person's answer; prev_kind is the
-- sign-up kind to restore when someone who declined confirms again. seq keeps the plan's order. Deleting the raid removes its roster.
-- player_id is a plain FK with SET NULL, the pattern of raid_signups: a composite (guild_id, player_id) key cannot set just one column to NULL
-- (guild_id must survive), so the guild match is the two triggers below. A person removed from the roster leaves their seat, unmatched.
CREATE TABLE raid_roster (
  raid_id       TEXT NOT NULL,
  guild_id      TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  player_id     TEXT REFERENCES players(id) ON DELETE SET NULL,
  group_number  INTEGER NOT NULL CHECK (group_number BETWEEN 0 AND 8),   -- 0 = bench
  class         TEXT CHECK (class IS NULL OR class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  spec          TEXT CHECK (spec IS NULL OR length(spec) <= 40),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
  prev_kind     TEXT CHECK (prev_kind IS NULL OR prev_kind IN ('signed', 'late', 'standby', 'tentative', 'bench', 'absence')),
  responded_at  INTEGER,
  seq           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (raid_id, name_key),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX raid_roster_raid_player ON raid_roster(raid_id, player_id);
CREATE INDEX raid_roster_player ON raid_roster(player_id, raid_id) WHERE player_id IS NOT NULL;

CREATE TRIGGER raid_roster_same_guild_insert BEFORE INSERT ON raid_roster
WHEN NEW.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND guild_id = NEW.guild_id)
BEGIN SELECT RAISE(ABORT, 'roster_person_guild'); END;
CREATE TRIGGER raid_roster_same_guild_update BEFORE UPDATE OF player_id, guild_id ON raid_roster
WHEN NEW.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND guild_id = NEW.guild_id)
BEGIN SELECT RAISE(ABORT, 'roster_person_guild'); END;
