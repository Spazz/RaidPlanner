-- Raidsmith user hierarchy, lane B7b part 1 (migration 0038): the two indexes the Users list needs. INDEXES ONLY: no table, no column, no trigger, no view, no data, no rebuild.
-- (0037 is reserved for the parallel lane B6b part 2b; the gap is on purpose. Migrations apply by file name, so the order of the numbers on disk is harmless.)
--
-- WHAT THE USERS LIST READS (worker/users-list.js). A request never walks a whole table of a guild's history (the plan checker in tests/guild/guild-b7b-users-tests.js reads
-- EXPLAIN QUERY PLAN of every statement). Almost every lookup already had an index: players_guild_user / players_guild_discord, characters_player / characters_one_main /
-- characters_guild_name, attendance_player, raid_signups_player (0031), loot_awards_winner, applications_user / applications_guild_status, raid_presence_name,
-- character_name_aliases_name, user_servers' primary key and idx_user_servers_server, role_assignments' unique index, guild_blocks' primary key. Two lookups had none:
--
--   raid_signups_guest_account   the open-raid guest sign-ups of ONE ACCOUNT (raid_signups.guest_user_id, 0033). The only index on that column is raid_signups_guest_user
--                                (raid_id, guest_user_id), which a lookup by the account alone cannot use: "is this account a guest signer of the guild", "when did it sign up last".
--                                (The open-raid hourly cap of worker/routes/open-raids.js asks the same question per account and has walked the table until now.)
--   raid_signups_unresolved      the sign-ups of a guild that name nobody: no person (player_id NULL) and no account (guest_user_id NULL) but a typed name or Discord nickname,
--                                i.e. the guests of a guest link and the Raid-Helper sign-ups that match no person. They are the "Guest sign-up" and "Raid-Helper" sightings of the
--                                Users list (non-members that resolve to no character). A guild's sign-ups are tens of thousands of rows; this partial index holds only the unresolved
--                                ones, led by the guild, so the list reads them without touching the rest. (guild_id, nickname, raid_id) because the grouping is by name and
--                                the raid is what dates a sighting.
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live): the previous code never names either index and no statement of it changes
-- meaning; an index only adds an access path and some maintenance work on a raid_signups write (a row more per write of a guest or unresolved sign-up, one for a guest account).
-- Both are built over the existing rows once (a read of raid_signups). Every statement is IF NOT EXISTS, so a rerun is harmless.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS raid_signups_guest_account;
--   DROP INDEX IF EXISTS raid_signups_unresolved;

CREATE INDEX IF NOT EXISTS raid_signups_guest_account ON raid_signups(guest_user_id) WHERE guest_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS raid_signups_unresolved ON raid_signups(guild_id, nickname, raid_id) WHERE player_id IS NULL AND guest_user_id IS NULL AND nickname IS NOT NULL;
