-- Raidsmith user hierarchy, guest limit: an OPTIONAL per-raid cap on guest sign-ups, set by an officer. Additive only, no table rebuild.
--
--  raids.guest_limit   the most guests (join-link guests and open-raid guests together) the raid takes. NULL = no limit (the default, and every raid
--                      that exists today). 1 to 100 when set; an officer sets and clears it where "Open to guests" is set (raids.edit on the raid's team).
--                      It replaces the fixed 15-guest cap the guest routes had. A join link keeps its own officer-set use limit (raid_join_links.max_uses).
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE: the column is nullable, and every INSERT INTO raids in that code names its columns, so none of it breaks.
-- The previous code ignores the column and keeps its fixed cap until the new code is live.
ALTER TABLE raids ADD COLUMN guest_limit INTEGER CHECK (guest_limit IS NULL OR (guest_limit BETWEEN 1 AND 100));
