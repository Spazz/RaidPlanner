-- Raidsmith user hierarchy, release R2: what migration 0032 (unique character per person per team) will change. Read-only; counts only (no names, ids or values).
--
-- One row, four counts, worked out with the SAME rule 0032 applies: a person with several characters on ONE team keeps the Main there, else the earliest created
-- (created_at, then id); every other character on that team would get team_id NULL.
--   characters_made_teamless       how many characters 0032 takes off their team
--   people_affected                how many people they belong to
--   standing_signups_naming_them   standing sign-ups (the weekly "I'm in") whose chosen character is one of them. They stay valid: since B2 a member may bring
--                                  any of their characters (U R4-Q1), also one on no team.
--   upcoming_signups_naming_them   Raidsmith / Raid-Helper sign-ups on raids that have not started yet whose character is one of them. Same: still valid.
-- Run it before the push that carries 0032 and tell the user the numbers (0032 is applied alone, after B2 is live; the first teamless row is the point of no
-- return of release R2). After 0032 every count is 0.
--   npx wrangler d1 execute raidsmith --remote --file tools/hierarchy/r2-report.sql        (--local --persist-to <state> for a local database)

WITH made_teamless AS (
  SELECT c.id, c.player_id FROM characters c
   WHERE c.team_id IS NOT NULL
     AND c.id != (SELECT k.id FROM characters k WHERE k.team_id = c.team_id AND k.player_id = c.player_id
                   ORDER BY k.is_main DESC, k.created_at, k.id LIMIT 1)
)
SELECT
  (SELECT COUNT(*) FROM made_teamless) AS characters_made_teamless,
  (SELECT COUNT(DISTINCT player_id) FROM made_teamless) AS people_affected,
  (SELECT COUNT(*) FROM standing_signups s WHERE s.character_id IN (SELECT id FROM made_teamless)) AS standing_signups_naming_them,
  (SELECT COUNT(*) FROM raid_signups s JOIN raids r ON r.id = s.raid_id
    WHERE s.character_id IN (SELECT id FROM made_teamless) AND r.starts_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) AS upcoming_signups_naming_them;
