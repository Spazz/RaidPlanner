-- Raidsmith guild tracker, PM wave 7: read-only API keys (CSV and JSON links) and the rank ladder. ADD COLUMN and new tables only.
-- 0020 is unused (the gap is harmless: migrations apply by file name). The team progress board needs no table: it is derived from raid_pulls (0003).

-- 1. Read-only API keys. The token ("rsk_" + 32 random bytes in base64url) is shown once, when the key is made; only its SHA-256 is stored, like a
--    guest link. A key reads ONE team (team_id) or every team (team_id NULL) and only the datasets in `datasets` (a JSON array of roster / attendance /
--    loot / raids), with what the built-in Member role may see of them: no notes, no Discord or account data. Revoking keeps the row (uses and the
--    last use stay readable). Deleting the guild or the team deletes the key.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  team_id       TEXT,
  datasets      TEXT NOT NULL CHECK (json_valid(datasets) AND json_type(datasets) = 'array'),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX api_keys_guild ON api_keys(guild_id, created_at);

-- 2. Rank progression. A rank is a LABEL on the person (the id of a rank of the guild's ladder in the attendance policy), separate from the
--    Raider / Trial / Reserve / Inactive status. NULL = the ladder's first rank. rank_on is the day the person got the rank (the ladder's "since
--    promotion" rules count from it).
ALTER TABLE players ADD COLUMN rank TEXT CHECK (rank IS NULL OR length(rank) BETWEEN 2 AND 12);
ALTER TABLE players ADD COLUMN rank_on TEXT CHECK (rank_on IS NULL OR date(rank_on) IS rank_on);

-- 3. A dismissed rank suggestion: hidden until `until` (30 days) for that person and that suggestion (kind + target rank). One row per person.
CREATE TABLE rank_dismissals (
  guild_id      TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('promote', 'review')),
  to_rank       TEXT NOT NULL CHECK (length(to_rank) BETWEEN 2 AND 12),
  until         INTEGER NOT NULL,
  dismissed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, player_id),
  FOREIGN KEY (guild_id, player_id) REFERENCES players(guild_id, id) ON DELETE CASCADE
);
