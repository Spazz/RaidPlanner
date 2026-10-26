-- Raidsmith user hierarchy, lane B2 (release R2, pushed ALONE after B2 is live): one character per person per team (U R3-Q1/R4-Q1).
--
-- 1. Resolve the real duplicates: a person with several characters on ONE team keeps the Main there, else the earliest created (created_at, then id); the
--    others get team_id NULL (they become alts on no team, which is what every new alt is since B2).
-- 2. Record every character that changed, with the team it had, in the side table characters_team_before_0032 BEFORE the UPDATE (rollback below).
-- 3. The unique index characters_team_person ON characters (team_id, player_id) WHERE team_id IS NOT NULL. A character on no team is outside it.
--
-- No table rebuild: a side table, one UPDATE and one index only. Safe for B2's own code, which never places a second character of a person on a team
-- (a new alt starts on no team, a new Main steps the previous one off a shared team, patchCharacter and the imports check first) and maps the index error
-- (team_taken, a 409) for the race. It is NOT written for the code of release R1, which still adds alts to the Main's team: B2 must be live first.
-- Workers Builds applies this file on the push; tools/hierarchy/r2-report.sql counts what it will change (counts only) BEFORE that push.
--
-- RERUN SAFETY. Every statement is idempotent: the side table is CREATE IF NOT EXISTS, the INSERT OR IGNORE keeps the first record of a character, the UPDATE
-- finds no duplicate once the first run resolved them (it never touches a character the side table merely mentions), the index is CREATE IF NOT EXISTS.
-- Remote D1 applies a migration file atomically, so a failed run changes nothing.
--
-- ROLLBACK (data only; the Worker needs no change: it has no unique-index dependency). Run by hand, in this order:
--   DROP INDEX IF EXISTS characters_team_person;
--   UPDATE characters SET team_id = (SELECT b.old_team_id FROM characters_team_before_0032 b WHERE b.character_id = characters.id)
--    WHERE id IN (SELECT character_id FROM characters_team_before_0032)
--      AND team_id IS NULL
--      AND EXISTS (SELECT 1 FROM teams t WHERE t.id = (SELECT b.old_team_id FROM characters_team_before_0032 b WHERE b.character_id = characters.id) AND t.guild_id = characters.guild_id);
--   -- then keep or drop the side table: DROP TABLE characters_team_before_0032;
-- (A character that was placed on a team again since carries a team_id and is left alone; a team that was deleted since is skipped by the EXISTS.)

CREATE TABLE IF NOT EXISTS characters_team_before_0032 (
  character_id  TEXT PRIMARY KEY,
  old_team_id   TEXT NOT NULL
);

INSERT OR IGNORE INTO characters_team_before_0032 (character_id, old_team_id)
SELECT c.id, c.team_id FROM characters c
 WHERE c.team_id IS NOT NULL
   AND c.id != (SELECT k.id FROM characters k WHERE k.team_id = c.team_id AND k.player_id = c.player_id
                 ORDER BY k.is_main DESC, k.created_at, k.id LIMIT 1);

UPDATE characters SET team_id = NULL
 WHERE team_id IS NOT NULL
   AND id != (SELECT k.id FROM characters k WHERE k.team_id = characters.team_id AND k.player_id = characters.player_id
               ORDER BY k.is_main DESC, k.created_at, k.id LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS characters_team_person ON characters (team_id, player_id) WHERE team_id IS NOT NULL;
