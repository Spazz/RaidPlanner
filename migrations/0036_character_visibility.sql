-- Raidsmith user hierarchy, release R4 (migration 0036): the retired placeholders count for nothing, and a person can be deleted without walking its guild.
-- TRIGGERS AND ONE INDEX; no table, no column, no data, no rebuild. (Plan "Migrations": 0036 is the orchestrator's addition to the plan after lane B6a part 2b.)
--
-- BACKGROUND. A re-home (worker/rehome.js) leaves the old person a retired PLACEHOLDER: a Former character whose name_key is `~ph:<its own id>` (worker/character-visibility.js
-- visibleCharacterSql keeps everything else). It is hidden from every list and count. Three places of the schema did not know that yet:
--
--   1. characters_cap (migration 0030) counted EVERY row of a person, so the placeholders used up the 20 characters a person may have. It now counts the visible
--      characters only, and a placeholder itself is never refused by it. (worker/bnet-match.js stopped its inserts at the person's ROWS because of this; the code now reads
--      the same number the limit does.)
--   2. characters_one_main is unique per person (a Main is_main = 1). A person whose only Main is a placeholder has no Main anyone can see. A character inserted into such
--      a person becomes its Main and the placeholder gives the Main up. Two triggers, because the unique index is checked when the row is inserted, before any AFTER trigger runs:
--        characters_placeholder_main_before   BEFORE INSERT of a visible Main: the placeholder steps down first, so the new row does not collide with it
--        characters_placeholder_main_after    AFTER INSERT of a visible non-Main: the placeholder steps down, then the new row takes the Main
--      A person that has a visible Main is never touched (the placeholder is then not its Main), and neither is an insert of a placeholder.
--   3. characters has a composite foreign key (guild_id, player_id) -> players(guild_id, id) ON DELETE CASCADE and no index that starts with both columns, so deleting a
--      person made SQLite walk every character of its guild (`SEARCH characters USING INDEX characters_guild_id (guild_id=?)`, the child lookup of the cascade). The index
--      characters_guild_player (guild_id, player_id) turns that into a lookup of the person's own rows (tests/guild/guild-migration-0036-tests.js reads the query plan).
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live):
--   - the previous code never writes a `~ph:` name_key (only the re-home and the retire of lane B6a do), so on every row it can see the rewritten characters_cap counts what
--     the old one counted, and the two placeholder triggers have nothing to act on (their WHEN clauses need a placeholder Main). If the new release is rolled back after it
--     made placeholders, the previous code sees them as ordinary Former characters; an insert of its own into such a person then takes the Main by the trigger, which is what
--     a person without a visible Main needs.
--   - no existing statement changes meaning: the triggers only fire on INSERT, the index only adds an access path.
--   - the index is built over the existing rows once, which is a read of the characters table; every later insert and delete maintains it (a row more per write).
-- Every statement is IF NOT EXISTS or DROP IF EXISTS first, so a rerun is harmless.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS characters_guild_player;
--   DROP TRIGGER IF EXISTS characters_placeholder_main_before;
--   DROP TRIGGER IF EXISTS characters_placeholder_main_after;
--   DROP TRIGGER IF EXISTS characters_cap;
--   CREATE TRIGGER characters_cap BEFORE INSERT ON characters
--     WHEN (SELECT count(*) FROM characters WHERE player_id = NEW.player_id) >= 20
--     BEGIN SELECT RAISE(ABORT, 'character_limit'); END;

DROP TRIGGER IF EXISTS characters_cap;
CREATE TRIGGER characters_cap BEFORE INSERT ON characters
  WHEN substr(NEW.name_key, 1, 4) <> '~ph:'
   AND (SELECT count(*) FROM characters WHERE player_id = NEW.player_id AND substr(name_key, 1, 4) <> '~ph:') >= 20
  BEGIN SELECT RAISE(ABORT, 'character_limit'); END;

CREATE TRIGGER IF NOT EXISTS characters_placeholder_main_before BEFORE INSERT ON characters
  WHEN NEW.is_main = 1 AND substr(NEW.name_key, 1, 4) <> '~ph:'
   AND EXISTS (SELECT 1 FROM characters WHERE player_id = NEW.player_id AND is_main = 1 AND substr(name_key, 1, 4) = '~ph:')
  BEGIN
    UPDATE characters SET is_main = 0 WHERE player_id = NEW.player_id AND is_main = 1 AND substr(name_key, 1, 4) = '~ph:';
  END;

CREATE TRIGGER IF NOT EXISTS characters_placeholder_main_after AFTER INSERT ON characters
  WHEN NEW.is_main = 0 AND substr(NEW.name_key, 1, 4) <> '~ph:'
   AND EXISTS (SELECT 1 FROM characters WHERE player_id = NEW.player_id AND is_main = 1 AND substr(name_key, 1, 4) = '~ph:')
  BEGIN
    UPDATE characters SET is_main = 0 WHERE player_id = NEW.player_id AND is_main = 1 AND substr(name_key, 1, 4) = '~ph:';
    UPDATE characters SET is_main = 1 WHERE id = NEW.id;
  END;

CREATE INDEX IF NOT EXISTS characters_guild_player ON characters(guild_id, player_id);
