-- Raidsmith guild tracker, Phase 7: Discord role mapping, the role editor, guest links and the public page.
-- 0013 belongs to PM wave 1; migrations apply by file name, so the gap is harmless.
-- Times are INTEGER epoch ms; JSON is TEXT with json_valid checks. Nothing here holds a Discord ID of a person: a mapping names a Discord ROLE
-- (a snowflake of the server, not of a user), and a Discord-given role assignment only says which Raidsmith role it came from.
--
-- 1. Two more built-in roles that are never assigned to a person: Guest (what a guest link grants unless the officer picks a custom role) and
--    Public (the ceiling of what the public page may show). Both are read-only by rule (worker/permissions.js ACTION_INFO) and seeded here
--    with their defaults; a guild can change them (section 4). The public page itself stays OFF until a Guild Master turns it on (section 7).
-- 2. Custom roles live in `roles` with guild_id set (system roles have guild_id NULL) and their permissions in `role_permissions`, like the
--    built-in ones. Their rank is the Member rank (3): holding a custom role never raises a person in the hierarchy that decides who may
--    change whose roles or access. A guild's custom roles go with the guild (trigger below), since roles.guild_id has no foreign key.
-- 3. Where a role assignment came from: 'manual' (an officer, or the guild's creation) or 'discord' (the mapping, applied at sign-in and by
--    Sync now). A person can hold the same role from both; the sync only ever touches 'discord' rows, so a manual assignment stays and wins.
--    A Discord-sourced assignment can never be the Guild Master (or a role that is not assignable).

INSERT INTO roles (id, guild_id, name, rank) VALUES
  ('guest',  NULL, 'Guest',  4),
  ('public', NULL, 'Public', 5);

INSERT INTO role_permissions (role_id, action, scope) VALUES
  ('guest', 'roster.view',     'guild'),
  ('guest', 'raids.view',      'guild'),
  ('guest', 'attendance.view', 'team'),
  ('public', 'roster.view',     'guild'),
  ('public', 'raids.view',      'guild'),
  ('public', 'attendance.view', 'guild'),
  ('public', 'loot.view',       'guild');

CREATE UNIQUE INDEX roles_guild_name ON roles(guild_id, name COLLATE NOCASE) WHERE guild_id IS NOT NULL;

ALTER TABLE role_assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'discord') AND (source = 'manual' OR role_id NOT IN ('guild_master', 'member', 'guest', 'public')));
-- One row per (person, role, team, source): the same role from an officer and from Discord are two rows, and the sync never touches the manual one.
DROP INDEX idx_role_assignments_unique;
CREATE UNIQUE INDEX idx_role_assignments_unique ON role_assignments(guild_id, user_id, role_id, COALESCE(team_id, ''), source);

CREATE TRIGGER guilds_delete_custom_roles BEFORE DELETE ON guilds
BEGIN
  DELETE FROM role_assignments WHERE guild_id = OLD.id;
  DELETE FROM roles WHERE guild_id = OLD.id;
END;

-- 4. Per-guild edits of a built-in role. A (guild, role) pair with a row in role_overrides uses ITS permission rows (possibly none) instead of the
--    system rows in role_permissions; "Reset to default" deletes the override. The effective permissions of every role in every guild are the
--    view below: the Worker, and every guard that asks "does this person still hold the right", read it and never role_permissions directly.
CREATE TABLE role_overrides (
  guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE role_override_permissions (
  guild_id  TEXT NOT NULL,
  role_id   TEXT NOT NULL,
  action    TEXT NOT NULL,
  scope     TEXT NOT NULL CHECK (scope IN ('guild', 'team', 'own_teams')),
  PRIMARY KEY (guild_id, role_id, action),
  FOREIGN KEY (guild_id, role_id) REFERENCES role_overrides(guild_id, role_id) ON DELETE CASCADE
);

-- Three parts, each one an index-friendly query for a given guild (a single "r.guild_id = g.id OR r.guild_id IS NULL" join made the planner scan every
-- permission row on every request): the system roles the guild has not edited, the guild's own roles, and the guild's edits.
CREATE INDEX roles_guild ON roles(guild_id);
CREATE VIEW effective_role_permissions AS
  SELECT g.id AS guild_id, rp.role_id, rp.action, rp.scope
    FROM guilds g CROSS JOIN roles r CROSS JOIN role_permissions rp
   WHERE r.guild_id IS NULL AND rp.role_id = r.id
     AND NOT EXISTS (SELECT 1 FROM role_overrides o WHERE o.guild_id = g.id AND o.role_id = r.id)
  UNION ALL
  SELECT r.guild_id, rp.role_id, rp.action, rp.scope
    FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
   WHERE r.guild_id IS NOT NULL
  UNION ALL
  SELECT guild_id, role_id, action, scope FROM role_override_permissions;

-- 5. Discord roles -> Raidsmith roles. One Raidsmith role per Discord role (a person with several mapped Discord roles gets all of them).
--    role_id is Officer, Team Lead (with a team) or one of the guild's custom roles; never the Guild Master. The sync reads this on every
--    sign-in and on Sync now.
CREATE TABLE discord_role_maps (
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  discord_role_id  TEXT NOT NULL CHECK (discord_role_id NOT GLOB '*[^0-9]*' AND length(discord_role_id) BETWEEN 1 AND 25),
  role_id          TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE CHECK (role_id NOT IN ('guild_master', 'member', 'guest', 'public')),
  team_id          TEXT,
  PRIMARY KEY (guild_id, discord_role_id),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX discord_role_maps_role ON discord_role_maps(role_id);

-- 6. Guest links. The token (32 random bytes) is shown once, when the link is made; only its SHA-256 is stored. A link grants ONE role, to one
--    team or (team_id NULL) every team, and nothing else: it is never an account. Revoking keeps the row (uses and last use stay readable).
CREATE TABLE guest_links (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  team_id       TEXT,
  label         TEXT CHECK (label IS NULL OR length(label) <= 40),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX guest_links_guild ON guest_links(guild_id, created_at);

-- 7. The public page: off by default; the sections are the ones a Guild Master ticked (roster, raids, attendance, loot), and the built-in
--    Public role is the ceiling (a section the Public role does not allow stays closed).
ALTER TABLE guilds ADD COLUMN public_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_enabled IN (0, 1));
ALTER TABLE guilds ADD COLUMN public_sections TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(public_sections));
