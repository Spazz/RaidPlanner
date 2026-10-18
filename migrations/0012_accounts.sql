-- Raidsmith guild tracker, Phase 7a: accounts with linked sign-ins. A Raidsmith account (a users row) is the person who signs in; Discord and
-- Battle.net are identities linked to it. (0010 is native sign-ups and 0011 the disenchanted loot items; this one runs after both.)
--
-- 1. users.discord_id becomes NULLABLE (an account made with Battle.net has no Discord yet), still UNIQUE when present.
--    SQLite cannot drop NOT NULL or UNIQUE from a column in place, and the usual rebuild (create, copy, DROP TABLE users, rename) is NOT safe
--    here: with foreign keys on, DROP TABLE runs an implicit DELETE of every row, which fires the ON DELETE actions of every table that
--    references users (sessions, roles, blocks, claims... CASCADE; created_by / updated_by / actor columns... SET NULL), and a D1 migration
--    cannot switch foreign keys off (only PRAGMA defer_foreign_keys, which defers violations, not actions). Migration 0010 (native sign-ups) also added
--    a column that references users. So users is altered IN PLACE instead:
--      - the old column is renamed account_key. It stays NOT NULL UNIQUE (nothing can change that) and now only has to differ per account:
--        existing rows keep their Discord ID in it, new accounts store their own users.id. Nothing reads it.
--      - a new nullable discord_id column takes over the name, and is filled from account_key. A unique index on it (SQLite lets NULLs repeat)
--        keeps "one account per Discord ID" and is the target of the sign-in upsert.
--    No row of any other table is touched, so no cascade can fire. Consequences: every INSERT INTO users must set account_key (this Worker does), so a Worker
--    from before this migration cannot sign anyone in once it ran: deploy the two together. A foreign key added later with ALTER TABLE ... ADD COLUMN ...
--    REFERENCES users(id) stays safe; only dropping users is not.
-- 2. users.display_name: the name the account chose in Linked accounts (<= 32 characters). NULL = use the Discord or Battle.net name.
-- 3. players.user_id: the Raidsmith account an officer linked to a roster person (or an approved Battle.net character claim linked). It is
--    how an account WITHOUT Discord belongs to a roster person; a Discord account is still matched through players.discord_user_id.
--    One person per account in a guild. The account's deletion clears it (the roster keeps the person).
-- The Battle.net identity stays in bnet_links (one row per account, one account per Battle.net account); worker/identities.js is the one place
-- that knows where each identity lives.

ALTER TABLE users RENAME COLUMN discord_id TO account_key;
ALTER TABLE users ADD COLUMN discord_id TEXT;
UPDATE users SET discord_id = account_key;
CREATE UNIQUE INDEX users_discord_id ON users(discord_id);
ALTER TABLE users ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 32);

ALTER TABLE players ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX players_guild_user ON players(guild_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX players_user ON players(user_id) WHERE user_id IS NOT NULL;
