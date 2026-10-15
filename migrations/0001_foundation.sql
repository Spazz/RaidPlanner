-- Raidsmith guild tracker, Phase 1 foundation.
-- Every ID is random TEXT. Discord snowflakes are TEXT, compared as strings.
-- Times are epoch ms INTEGER; booleans are 0/1; JSON is TEXT.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  discord_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  global_name   TEXT,
  avatar        TEXT,
  prefs         TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash          TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  manageable_servers  TEXT,
  manageable_until    INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Holds only servers that have a Raidsmith guild (the sign-in replaces the set).
CREATE TABLE user_servers (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE INDEX idx_user_servers_server ON user_servers(server_id);

CREATE TABLE guilds (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  realm               TEXT NOT NULL,
  region              TEXT NOT NULL CHECK (region IN ('US', 'EU', 'KR', 'TW')),
  discord_server_id   TEXT NOT NULL UNIQUE,
  time_zone           TEXT NOT NULL,
  game_version        TEXT NOT NULL DEFAULT 'tbc-anniversary',
  created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL
);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 25,
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at  INTEGER NOT NULL,
  UNIQUE (guild_id, id)
);
CREATE UNIQUE INDEX idx_teams_active_name ON teams(guild_id, name COLLATE NOCASE) WHERE archived = 0;

CREATE TABLE roles (
  id        TEXT PRIMARY KEY,
  guild_id  TEXT,
  name      TEXT NOT NULL,
  rank      INTEGER NOT NULL
);

CREATE TABLE role_permissions (
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  action   TEXT NOT NULL,
  scope    TEXT NOT NULL CHECK (scope IN ('guild', 'team', 'own_teams', 'own')),
  PRIMARY KEY (role_id, action)
);

-- Member is never stored: it is implied by being in the guild's Discord server.
CREATE TABLE role_assignments (
  id           TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  team_id      TEXT,
  assigned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_role_assignments_unique ON role_assignments(guild_id, user_id, role_id, COALESCE(team_id, ''));
CREATE UNIQUE INDEX idx_role_assignments_one_gm ON role_assignments(guild_id) WHERE role_id = 'guild_master';
CREATE INDEX idx_role_assignments_user ON role_assignments(user_id);

CREATE TABLE guild_blocks (
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_guild_blocks_user ON guild_blocks(user_id);

CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  guild_id       TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  before         TEXT,
  after          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_audit_guild ON audit_log(guild_id, created_at);

-- No IP addresses are stored: the key is w:<userId>.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- System roles (plan section 6). guild_id NULL = system role. Rank: lower is senior.
INSERT INTO roles (id, guild_id, name, rank) VALUES
  ('guild_master', NULL, 'Guild Master', 0),
  ('officer',      NULL, 'Officer',      1),
  ('team_lead',    NULL, 'Team Lead',    2),
  ('member',       NULL, 'Member',       3);

INSERT INTO role_permissions (role_id, action, scope) VALUES
  ('guild_master', 'roster.view',        'guild'),
  ('guild_master', 'roster.edit',        'guild'),
  ('guild_master', 'roster.notes.view',  'guild'),
  ('guild_master', 'roster.notes.edit',  'guild'),
  ('guild_master', 'nights.view',        'guild'),
  ('guild_master', 'nights.edit',        'guild'),
  ('guild_master', 'attendance.view',    'guild'),
  ('guild_master', 'attendance.review',  'guild'),
  ('guild_master', 'guild.teams',        'guild'),
  ('guild_master', 'guild.roles',        'guild'),
  ('guild_master', 'guild.access',       'guild'),
  ('guild_master', 'audit.view',         'guild'),
  ('officer', 'roster.view',        'guild'),
  ('officer', 'roster.edit',        'guild'),
  ('officer', 'roster.notes.view',  'guild'),
  ('officer', 'roster.notes.edit',  'guild'),
  ('officer', 'nights.view',        'guild'),
  ('officer', 'nights.edit',        'guild'),
  ('officer', 'attendance.view',    'guild'),
  ('officer', 'attendance.review',  'guild'),
  ('officer', 'guild.teams',        'guild'),
  ('officer', 'guild.access',       'guild'),
  ('team_lead', 'roster.edit',        'team'),
  ('team_lead', 'roster.notes.view',  'team'),
  ('team_lead', 'roster.notes.edit',  'team'),
  ('team_lead', 'nights.edit',        'team'),
  ('team_lead', 'attendance.view',    'team'),
  ('team_lead', 'attendance.review',  'team'),
  ('member', 'roster.view',      'guild'),
  ('member', 'nights.view',      'guild'),
  ('member', 'attendance.view',  'own_teams');
