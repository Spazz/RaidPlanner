-- Raidsmith guild tracker, Phase 5: Battle.net. A member links their Battle.net account (OAuth, scopes openid + wow.profile), sees their
-- characters for the guilds they belong to, and CLAIMS characters; officers approve or reject the claims. Officers can also import a
-- guild's roster from Battle.net. (0008 is the loot migration, built in parallel: this number leaves it room.)
--
-- Blizzard's API terms allow storing Battle.net data for 30 days at most: the daily Cron Trigger (worker/bnet-purge.js) deletes every
-- link whose snapshot is older, and the claims it fed. The access token is used inside the sign-in callback and never stored.

-- One link per Raidsmith user, and one Raidsmith user per Battle.net account (a second user linking the same account is refused).
-- snapshot: { "<profile namespace>": { fetchedAt, characters: [{ name, realm, realmSlug, class, level }] | error } }, one entry per
-- game version + region among the user's guilds at link time. snapshot_at is the refresh time the 30-day rule counts from.
CREATE TABLE bnet_links (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bnet_account_id  TEXT NOT NULL CHECK (length(bnet_account_id) BETWEEN 1 AND 20 AND bnet_account_id NOT GLOB '*[^0-9]*'),
  battletag        TEXT NOT NULL CHECK (length(battletag) BETWEEN 1 AND 64),
  linked_at        INTEGER NOT NULL,
  snapshot         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(snapshot) AND json_type(snapshot) = 'object'),
  snapshot_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX bnet_links_account ON bnet_links(bnet_account_id);
CREATE INDEX bnet_links_snapshot_at ON bnet_links(snapshot_at);

-- A member's request that a character is theirs. Approved: the character joins the claimant's roster person (an Alt, or a new person
-- with it as Main), or the claimant's Discord account is linked to the person who already holds it. realm is NULL for a ruleset guild.
CREATE TABLE character_claims (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  realm       TEXT,
  realm_key   TEXT NOT NULL DEFAULT '',
  class       TEXT NOT NULL CHECK (class IN ('WARRIOR','PALADIN','HUNTER','ROGUE','PRIEST','SHAMAN','MAGE','WARLOCK','DRUID')),
  level       INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 100),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  decided_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at  INTEGER,
  created_at  INTEGER NOT NULL,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One open claim per character in a guild.
CREATE UNIQUE INDEX character_claims_pending ON character_claims(guild_id, name_key, realm_key) WHERE status = 'pending';
CREATE INDEX character_claims_guild ON character_claims(guild_id, status, created_at);
CREATE INDEX character_claims_user ON character_claims(user_id, guild_id);

-- Guild Battle.net settings. bnet_guild_name: the in-game guild name when it differs from the Raidsmith guild's name. bnet_realm_slug: the
-- realm a RULESET guild (WoW Forever) lives on (realm guilds use their own realm). bnet_rank_labels: ten labels, index = Battle.net rank
-- number (0 is the guild master); an empty entry falls back to "Rank N".
ALTER TABLE guilds ADD COLUMN bnet_guild_name TEXT CHECK (bnet_guild_name IS NULL OR length(bnet_guild_name) BETWEEN 1 AND 32);
ALTER TABLE guilds ADD COLUMN bnet_realm_slug TEXT CHECK (bnet_realm_slug IS NULL OR (length(bnet_realm_slug) BETWEEN 1 AND 50 AND bnet_realm_slug NOT GLOB '*[^a-z0-9-]*'));
ALTER TABLE guilds ADD COLUMN bnet_rank_labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bnet_rank_labels) AND json_type(bnet_rank_labels) = 'array');
