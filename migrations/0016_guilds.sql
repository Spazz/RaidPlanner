-- Raidsmith guild tracker, Phase 8: opening Raidsmith to other guilds. Three additions, no existing row is touched.
--
-- 1. A guild holds at most 5000 characters, whichever path adds them (a person, an import, a claim, an attendance row). The other two caps are
--    already triggers (players_cap: 1000 people per guild, characters_cap: 20 characters per person); this one is the same kind, so it covers
--    every insert path and a race between two requests. The message must not contain "character_limit" (worker/routes/roster.js constraintOf
--    tests that text for the per-person cap).
-- 2. One account may create at most 5 guilds (guilds.created_by): the count behind that limit, and behind /auth/me, reads this index.
-- 3. The checklist card on the guild's Home can be dismissed by the people who set the guild up: one nullable column on guilds (NULL = shown).
--    ALTER TABLE ADD COLUMN only: guilds is referenced by almost every table and D1 cannot rebuild it.

CREATE TRIGGER characters_guild_cap BEFORE INSERT ON characters
  WHEN (SELECT count(*) FROM characters WHERE guild_id = NEW.guild_id) >= 5000
  BEGIN SELECT RAISE(ABORT, 'guild_characters_cap'); END;

CREATE INDEX guilds_created_by ON guilds(created_by);

ALTER TABLE guilds ADD COLUMN onboarding_dismissed_at INTEGER;
