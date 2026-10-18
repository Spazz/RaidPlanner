-- Raidsmith guild tracker, PM wave 3 (recruiting and the WoW Forever launch). ADD COLUMN and new tables only: guilds, teams, players and users are
-- referenced by almost every table and D1 cannot rebuild them.
--
-- 1. The class and spec intent board: a team's "Intent" round (an officer opens it, members say what they plan to play) and one pick per person,
--    kind ('main' | 'alt'). The role of a pick follows from its spec (worker/recruit-data.js), stored so the board adds up without a join.
-- 2. Recruitment needs: the officer-set role targets of a team (NULL = the defaults for its raid size).
-- 3. The applications inbox: a guild's switch and questions (guilds columns), and one row per application. The public form works signed out; a
--    signed-in applicant's account is kept (user_id) so Accept can link it and "Delete my data" can remove the application.

-- ---------------------------------------------------------------------------
-- Intent board

CREATE TABLE intent_rounds (
  id          TEXT PRIMARY KEY,                                   -- 'ir_' + 22 characters
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  closes_on   TEXT CHECK (closes_on IS NULL OR date(closes_on) IS closes_on),   -- guild-local calendar date; a reminder, nothing closes by itself
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  UNIQUE (guild_id, id),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
-- A team has at most one open round (the Worker checks first; this makes a race harmless).
CREATE UNIQUE INDEX intent_rounds_one_open ON intent_rounds(team_id) WHERE status = 'open';
CREATE INDEX intent_rounds_team ON intent_rounds(guild_id, team_id, created_at);

CREATE TABLE intent_picks (
  round_id    TEXT NOT NULL,
  guild_id    TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('main', 'alt')),
  class       TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  spec        TEXT NOT NULL CHECK (length(spec) BETWEEN 1 AND 40),
  role        TEXT NOT NULL CHECK (role IN ('tank', 'healer', 'melee', 'ranged')),
  note        TEXT CHECK (note IS NULL OR length(note) <= 120),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (round_id, player_id, kind),
  FOREIGN KEY (guild_id, round_id) REFERENCES intent_rounds(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX intent_picks_player ON intent_picks(guild_id, player_id);

-- ---------------------------------------------------------------------------
-- Recruitment needs

-- {"tank":3,"healer":6,"melee":8,"ranged":8}; NULL = the defaults of the team's raid size (worker/recruit-data.js).
ALTER TABLE teams ADD COLUMN recruit_targets TEXT CHECK (recruit_targets IS NULL OR (json_valid(recruit_targets) AND json_type(recruit_targets) = 'object'));

-- ---------------------------------------------------------------------------
-- Applications

ALTER TABLE guilds ADD COLUMN apply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (apply_enabled IN (0, 1));
-- [{ "id", "label", "type": "short" | "long" | "choice", "options": [..], "required": 0 | 1 }], at most 8 (the Worker holds the rule).
ALTER TABLE guilds ADD COLUMN apply_questions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(apply_questions) AND json_type(apply_questions) = 'array');

CREATE TABLE applications (
  id           TEXT PRIMARY KEY,                                  -- 'am_' + 22 characters
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL,                                     -- the team the applicant asked for
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'accepted', 'declined')),
  char_name    TEXT NOT NULL CHECK (length(char_name) BETWEEN 2 AND 40),
  name_key     TEXT NOT NULL,
  realm        TEXT,                                              -- NULL for a ruleset (Forever) guild
  realm_key    TEXT NOT NULL DEFAULT '',
  class        TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  spec         TEXT CHECK (spec IS NULL OR length(spec) <= 40),
  contact      TEXT CHECK (contact IS NULL OR length(contact) <= 100),
  -- [{ "label", "type", "answer" }]: the questions as the applicant saw them, so editing the questions later changes no old application.
  answers      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers) AND json_type(answers) = 'array'),
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,       -- the signed-in applicant's account; deleting the account deletes the application
  notes        TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  reviewed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  INTEGER,
  player_id    TEXT REFERENCES players(id) ON DELETE SET NULL,    -- the person Accept created
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (guild_id, id),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX applications_guild_status ON applications(guild_id, status, created_at);
CREATE INDEX applications_user ON applications(user_id) WHERE user_id IS NOT NULL;

-- A guild keeps at most 500 applications (the inbox is not an archive): the Worker answers a full inbox with a clear message.
CREATE TRIGGER applications_cap BEFORE INSERT ON applications
  WHEN (SELECT count(*) FROM applications WHERE guild_id = NEW.guild_id) >= 500
  BEGIN SELECT RAISE(ABORT, 'applications_cap'); END;
