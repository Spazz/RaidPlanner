-- Raidsmith user hierarchy, the Trial clock (migration 0040): when a character entered its team, and when it became a Trial.
--
-- WHY. User decision 2026-10-26 (replaces H-Q24 and R3-Q6): a Trial's clock starts from the time the character ENTERED THE TEAM, not from the first raid of the team that
-- logged it. Nothing stored the team entry, so the clock used characters.updated_at as a stand-in floor and any edit of the character (a rename, a spec change) moved it.
--
-- WHAT. Two nullable columns on characters (epoch ms, like created_at / updated_at):
--   team_since   the instant the character was placed on its CURRENT team; NULL while it is on no team.
--   trial_since  the instant the character's core_rank became 'trial'; NULL while it is not a Trial. (A Trial can not start before the character was a Trial: the clock
--                starts at the later of the two instants, worker/trial-clock.js.)
-- Both are kept by TRIGGERS, so no writer changes and every writer (the officer edits, team placement, the claim and sign-in paths, the rank-map apply, imports) is
-- covered, including the previous release's code. Every writer of team_id and core_rank already sets updated_at = now in the same statement, and created_at = now on an
-- INSERT, which is the instant the triggers copy (a trigger has no access to the Worker's clock, and a wall clock inside a trigger would break the tests' fixed clock):
--   characters_since_insert       AFTER INSERT                    team_since = created_at when it has a team; trial_since = created_at when it is a Trial
--   characters_team_since_move    AFTER UPDATE OF team_id         a DIFFERENT team (or none): team_since = updated_at, NULL when the team is NULL. A rename, a spec edit or an
--                                                                 UPDATE that names team_id with the value it already has leaves it.
--   characters_trial_restart      AFTER UPDATE OF team_id         a Trial that LEAVES a team (for another team or for none) loses trial_start / trial_end, unless the same UPDATE wrote
--                                                                 them: the clock restarts on the new team (user decision). A hand-set date is final for the clock, not for a move.
--                                                                 Entering a team from none keeps the dates (Make Main hands the Main's dates to a teamless alt just before that
--                                                                 alt takes the home team).
--   characters_trial_since_rank   AFTER UPDATE OF core_rank       a changed rank: trial_since = updated_at when it became 'trial', NULL otherwise.
-- All four update only team_since / trial_since / the two trial dates, never team_id or core_rank, so none of them can fire another one (also with recursive triggers on).
-- changes() / meta.changes of the outer statement do not count trigger writes, so no caller that counts rows is affected.
--
-- BACKFILL, in this order, only rows whose column is still NULL (so a rerun and a row the triggers already stamped are left alone):
--   team_since   a character on a team gets, first that applies,
--                  1. a Trial with a typed or clock-written trial_start: that date at 12:00 UTC (noon, so the guild-local date is the same date in every zone from UTC-11 to
--                     UTC+11; the clock only ever reads the date, and trial_start itself is untouched),
--                  2. the starts_at of the FIRST raid of its current team that logged it (raid_presence under its current name, or any old name in character_name_aliases):
--                     it was on the team by then (an upper bound; a character that raided with another team and moved has the move after that team's last raid at the earliest),
--                  3. created_at (a lower bound; right for a character never moved).
--   trial_since  a Trial gets updated_at: the last write of its rank, which is exactly the floor the old clock used (it is also moved by later edits, a one-time inexactness
--                that only matters to a Trial whose clock has not started; every rank change from now on is stamped exactly by the trigger).
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live): two nullable columns, no rebuild, and the old Worker names its columns
-- in every INSERT. The old Worker keeps its updated_at floor and ignores the new columns; the triggers keep them right meanwhile. The triggers are created BEFORE the
-- backfill so a character written during the deploy window is stamped by a trigger and the backfill skips it.

ALTER TABLE characters ADD COLUMN team_since INTEGER;
ALTER TABLE characters ADD COLUMN trial_since INTEGER;

DROP TRIGGER IF EXISTS characters_since_insert;
CREATE TRIGGER characters_since_insert AFTER INSERT ON characters
  WHEN NEW.team_id IS NOT NULL OR NEW.core_rank = 'trial'
  BEGIN
    UPDATE characters
       SET team_since = COALESCE(team_since, CASE WHEN team_id IS NOT NULL THEN created_at END),
           trial_since = COALESCE(trial_since, CASE WHEN core_rank = 'trial' THEN created_at END)
     WHERE id = NEW.id;
  END;

DROP TRIGGER IF EXISTS characters_team_since_move;
CREATE TRIGGER characters_team_since_move AFTER UPDATE OF team_id ON characters
  WHEN NEW.team_id IS NOT OLD.team_id
  BEGIN
    UPDATE characters SET team_since = CASE WHEN NEW.team_id IS NULL THEN NULL ELSE NEW.updated_at END WHERE id = NEW.id;
  END;

DROP TRIGGER IF EXISTS characters_trial_restart;
CREATE TRIGGER characters_trial_restart AFTER UPDATE OF team_id ON characters
  WHEN OLD.team_id IS NOT NULL AND NEW.team_id IS NOT OLD.team_id AND NEW.core_rank = 'trial'
   AND NEW.trial_start IS OLD.trial_start AND NEW.trial_end IS OLD.trial_end
   AND (NEW.trial_start IS NOT NULL OR NEW.trial_end IS NOT NULL)
  BEGIN
    UPDATE characters SET trial_start = NULL, trial_end = NULL WHERE id = NEW.id;
  END;

DROP TRIGGER IF EXISTS characters_trial_since_rank;
CREATE TRIGGER characters_trial_since_rank AFTER UPDATE OF core_rank ON characters
  WHEN NEW.core_rank IS NOT OLD.core_rank
  BEGIN
    UPDATE characters SET trial_since = CASE WHEN NEW.core_rank = 'trial' THEN NEW.updated_at END WHERE id = NEW.id;
  END;

-- BACKFILL (tests/guild/guild-trial-clock-tests.js runs everything after this line again over crafted rows).
UPDATE characters SET team_since = COALESCE(
    CASE WHEN core_rank = 'trial' AND trial_start IS NOT NULL THEN CAST(strftime('%s', trial_start || ' 12:00:00') AS INTEGER) * 1000 END,
    (SELECT MIN(r.starts_at) FROM raid_presence rp JOIN raids r ON r.guild_id = rp.guild_id AND r.id = rp.raid_id
      WHERE rp.guild_id = characters.guild_id AND rp.realm_key = characters.realm_key AND r.team_id = characters.team_id
        AND (rp.name_key = characters.name_key
             OR rp.name_key IN (SELECT a.name_key FROM character_name_aliases a WHERE a.guild_id = characters.guild_id AND a.character_id = characters.id))),
    created_at)
 WHERE team_id IS NOT NULL AND team_since IS NULL;

UPDATE characters SET trial_since = updated_at WHERE core_rank = 'trial' AND trial_since IS NULL;
