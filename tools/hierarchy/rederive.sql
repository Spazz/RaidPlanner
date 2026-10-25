-- Raidsmith user hierarchy: re-derive the person fields on the characters from `players`.
--
-- Sets characters.core_rank, left_on, left_reason, trial_start and trial_end from players.status / left_on / left_reason / trial_start / trial_end
-- with the mapping of migration 0030 (and worker/person-legacy.js, the dual write):
--   core_rank     the person's status (raider / trial / reserve), 'social' when the status is inactive; on EVERY character of the person
--   left_on       the person's left_on, only when the status is inactive and left_reason is left or kicked, else NULL
--   left_reason   the person's left_reason, under the same condition, else NULL
--   trial_start   the person's trial_start, only on the person's main character and only while the status is trial, else NULL
--   trial_end     the same for trial_end
--
-- Idempotent: running it again changes nothing. One statement, so it applies whole or not at all.
-- Run it right before and right after the R1 push and right before the B2 push, then run mismatch.sql: all five counts must be 0.
--   npx wrangler d1 execute raidsmith --remote --file tools/hierarchy/rederive.sql        (--local --persist-to <state> for a local database)
-- NEVER run it once the readers use the character columns (R2): from then on the characters are the source and this would overwrite them.

UPDATE characters SET
  core_rank   = (SELECT CASE p.status WHEN 'inactive' THEN 'social' ELSE p.status END
                   FROM players p WHERE p.id = characters.player_id),
  left_on     = (SELECT CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_on END
                   FROM players p WHERE p.id = characters.player_id),
  left_reason = (SELECT CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_reason END
                   FROM players p WHERE p.id = characters.player_id),
  trial_start = (SELECT CASE WHEN p.status = 'trial' AND characters.is_main = 1 THEN p.trial_start END
                   FROM players p WHERE p.id = characters.player_id),
  trial_end   = (SELECT CASE WHEN p.status = 'trial' AND characters.is_main = 1 THEN p.trial_end END
                   FROM players p WHERE p.id = characters.player_id)
WHERE player_id IN (SELECT id FROM players);
