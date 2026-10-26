-- Raidsmith user hierarchy: how many characters disagree with `players`, per field. Read-only; counts only (no names, ids or values).
-- R1-R3 TOOL. Since R4 (lane B4b) the Worker no longer writes the players fields (status / trial / left dates): a person created after the R4 push shows as a
-- mismatch BY DESIGN, and rederive.sql would overwrite the live ranks with stale values. Do not run either against a database that runs R4 code.
--
-- One row, five counts: core_rank, left_on, left_reason, trial_start, trial_end. Each counts the characters whose column differs (NULL-safe) from what
-- tools/hierarchy/rederive.sql would set. All five are 0 = in sync.
--   npx wrangler d1 execute raidsmith --remote --file tools/hierarchy/mismatch.sql        (--local --persist-to <state> for a local database)

SELECT
  COALESCE(SUM(c.core_rank   IS NOT (CASE p.status WHEN 'inactive' THEN 'social' ELSE p.status END)), 0) AS core_rank,
  COALESCE(SUM(c.left_on     IS NOT (CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_on END)), 0) AS left_on,
  COALESCE(SUM(c.left_reason IS NOT (CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_reason END)), 0) AS left_reason,
  COALESCE(SUM(c.trial_start IS NOT (CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_start END)), 0) AS trial_start,
  COALESCE(SUM(c.trial_end   IS NOT (CASE WHEN p.status = 'trial' AND c.is_main = 1 THEN p.trial_end END)), 0) AS trial_end
FROM characters c JOIN players p ON p.id = c.player_id;
