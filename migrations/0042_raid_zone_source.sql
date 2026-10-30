-- Raidsmith raid zones: where a raid's zone came from. Additive only, no table rebuild.
--
--  raids.zone_source   'hand' (an officer picked the zone(s) at creation or in Raid settings), 'log' (a Warcraft Logs report said), 'event' (inferred from the
--                      Raid-Helper event). Precedence hand > log > event: the event and the log only fill a zone that is NULL-sourced or event-sourced, a
--                      hand-set zone is never touched. NULL = unknown (a raid made by the previous release after this migration ran).
--  Backfill: a raid with a zone is 'log' when it has a report row, else 'hand' (before this migration only a hand pick or a log could set a zone).
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE: the column is nullable and every INSERT INTO raids names its columns.
ALTER TABLE raids ADD COLUMN zone_source TEXT CHECK (zone_source IS NULL OR zone_source IN ('hand', 'event', 'log'));

UPDATE raids SET zone_source = CASE WHEN EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = raids.id) THEN 'log' ELSE 'hand' END
 WHERE zone IS NOT NULL;
