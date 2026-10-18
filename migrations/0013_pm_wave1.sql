-- Raidsmith guild tracker, PM wave 1 (officer tools): the calendar feed.
-- 0012 belongs to the accounts branch; migrations apply by file name, so the gap is harmless.
-- A calendar link is a private, revocable, per-person-per-team URL (/cal/<token>.ics). The token is 32 random bytes; only its SHA-256 is
-- stored, so the URL is shown once (when it is made) and never again. One link per person per team: making a new one replaces the old.
-- Revoking deletes the row. Deleting the person's account, the team or the guild deletes it too (the cascades below).
-- Times are INTEGER epoch ms.

CREATE TABLE calendar_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  UNIQUE (user_id, team_id),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX calendar_tokens_guild ON calendar_tokens(guild_id);
