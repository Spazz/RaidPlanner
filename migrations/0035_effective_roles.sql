-- Raidsmith user hierarchy, release R4 (migration 0035, lane B6b): the EFFECTIVE ROLES view. VIEWS ONLY: no table, no column, no index, no trigger, no data, no rebuild.
-- (Plan "Model": EFFECTIVE ROLES = ONE SQL view shaped like role_assignments, built with UNION ALL; "Migrations": 0035 = the effective-roles view only.
-- Migration 0036 already exists (character visibility); migrations apply by file name, so the order of the numbers on disk is harmless.)
--
-- WHAT A READER GETS. Every reader of "which roles does this account hold in this guild" (permissions, rank, the Seniority guard, the People lists, the audit
-- snapshot, ...) reads effective_roles instead of role_assignments. One row per (guild_id, user_id, role_id, team_id, source):
--
--   source 'manual' | 'discord'   the STORED rows (role_assignments). A stored guild_master row counts only while guilds.owner_user_id IS NULL AND guilds.rank_source IS NULL
--                                 (every guild before the flip): once the seat is set or the rank source is chosen, the Owner is the seat and a Guild Master row left behind
--                                 grants nothing (review finding B4b/B5 F1, first half).
--   source 'ingame'               the roles DERIVED from the in-game rank, only in a guild whose rank_source is 'ingame': the account's Battle.net-proven characters that are
--                                 VALID (below) each carry the in-game rank of their guild_roster row; the highest-ranked valid character wins (every character tied at that
--                                 rank counts), and the account gets the role the guild's rank map (source_rank_maps, role_id) gives that rank. guild_master only for the map
--                                 row with source_key '0' (the table's CHECK says the same). A team-scoped role (team_lead) is held for the team the character is placed on
--                                 (characters.team_id) and not at all when it has no team. A rank with no map row, or a map row with no role, gives nothing.
--   source 'owner'                one guild_master row for the Owner: guilds.owner_user_id while NOT SUSPENDED; else, while owner_user_id IS NULL AND rank_source IS NULL,
--                                 the holder of the stored guild_master row. SUSPENSION exists only for rank_source 'ingame': the seat holder has no VALID Battle.net-proven
--                                 character on the stored roster. The same view answers worker/owner.js isOwner / ownerSql, so the Owner row and the Owner test cannot drift.
--
-- A VALID Battle.net-proven character (view ingame_proven_characters) is one that
--   owner_proof = 'bnet'                                      a proof by an officer or by hand ('officer' | 'hand') never gives a permission or Owner liveness
--   (a)  proof_user_id = players.user_id, and not NULL        the proof belongs to the account that holds the person NOW (written with = and IS NOT NULL: NULL = NULL is not a match)
--   (b)  its identity key is a guild_roster row of the guild  (namespace, blizzard_realm_id, blizzard_char_id): it is on the last good roster
--   (d)  an INNER JOIN to bnet_links: the account's CURRENT Battle.net link has bnet_account_id = proof_bnet_account_id (a removed or replaced link proves nothing)
-- (c), the write-time monotonic guard, is a rule of the writers and has no read-time form.
--
-- SHAPE. effective_roles_stored, effective_roles_ingame and effective_roles_owner (one view per source) and effective_roles on top: a UNION ALL of the three, so a Discord
-- source later adds ONE view and ONE term (D1 allows 5 terms in a compound SELECT; each of these has at most 3). Every view has plain joins and no aggregate, DISTINCT only in the
-- ingame one, no LIMIT: a lookup by (guild_id, user_id) or by user_id alone is answered from the account's own rows (players_user, characters_player, guild_roster's primary
-- key, bnet_links, source_rank_maps' primary key, guilds_owner), never by a pass over characters, guild_roster, players or role_assignments (tests/guild/guild-b6b-views-tests.js
-- reads EXPLAIN QUERY PLAN on a 1,200-member in-game guild). effective_roles_stored also carries id and assigned_at (the stored row's), which the top view leaves out.
--
-- ONE RULE FOR A TABLE THESE VIEWS READ (agent-brief.md): a migration that rebuilds players, characters, guild_roster, source_rank_maps, bnet_links, guilds or role_assignments
-- DROPs the views below BEFORE the rebuild and CREATEs them again AFTER it, in the same migration (a RENAME of a rebuilt table would otherwise rewrite or break them).
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live): a view is inert, the previous code never names one of these views, and
-- no statement of the previous code changes meaning. Dropping a view the previous code does not know cannot break it either.
-- Every statement is DROP IF EXISTS first, so a rerun is harmless.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS effective_roles;
--   DROP VIEW IF EXISTS effective_roles_owner;
--   DROP VIEW IF EXISTS effective_roles_ingame;
--   DROP VIEW IF EXISTS effective_roles_stored;
--   DROP VIEW IF EXISTS ingame_proven_characters;

DROP VIEW IF EXISTS effective_roles;
DROP VIEW IF EXISTS effective_roles_owner;
DROP VIEW IF EXISTS effective_roles_ingame;
DROP VIEW IF EXISTS effective_roles_stored;
DROP VIEW IF EXISTS ingame_proven_characters;

-- The valid Battle.net-proven characters of the accounts of an in-game guild, with the in-game rank of each (its guild_roster row). Only guilds whose rank_source is 'ingame'.
-- CROSS JOIN fixes the join order (SQLite never reorders it): the account's own person first (players_guild_user / players_user), then the guild's rank source (a primary-key
-- lookup that ends a guild that is not in-game at once), then only that person's characters, then the roster row, then the link. Left to itself the planner may start from
-- guilds or guild_roster, which is a pass over a whole table.
CREATE VIEW ingame_proven_characters AS
SELECT pp.guild_id AS guild_id, pp.user_id AS user_id, pc.id AS character_id, pc.team_id AS team_id, pr.rank AS roster_rank
  FROM players pp
  CROSS JOIN guilds pg ON pg.id = pp.guild_id AND pg.rank_source = 'ingame'
  CROSS JOIN characters pc ON pc.player_id = pp.id AND pc.guild_id = pp.guild_id
                          AND pc.owner_proof = 'bnet' AND pc.proof_user_id IS NOT NULL AND pc.proof_user_id = pp.user_id
  CROSS JOIN guild_roster pr ON pr.guild_id = pp.guild_id AND pr.namespace = pc.namespace
                            AND pr.blizzard_realm_id = pc.blizzard_realm_id AND pr.blizzard_char_id = pc.blizzard_char_id
  CROSS JOIN bnet_links pb ON pb.user_id = pp.user_id AND pb.bnet_account_id = pc.proof_bnet_account_id
 WHERE pp.user_id IS NOT NULL;

-- The stored rows. A stored guild_master row counts only while the guild has neither an Owner seat nor a rank source (a guild before the flip).
CREATE VIEW effective_roles_stored AS
SELECT sa.guild_id AS guild_id, sa.user_id AS user_id, sa.role_id AS role_id, sa.team_id AS team_id, sa.source AS source, sa.id AS id, sa.assigned_at AS assigned_at
  FROM role_assignments sa
 WHERE sa.role_id <> 'guild_master'
    OR EXISTS (SELECT 1 FROM guilds sg WHERE sg.id = sa.guild_id AND sg.owner_user_id IS NULL AND sg.rank_source IS NULL);

-- The roles the rank map gives the best valid character(s) of the account. DISTINCT only collapses characters tied at the best rank that map to the same row.
CREATE VIEW effective_roles_ingame AS
SELECT DISTINCT iv.guild_id AS guild_id, iv.user_id AS user_id, im.role_id AS role_id,
       CASE WHEN im.role_id = 'team_lead' THEN iv.team_id END AS team_id, 'ingame' AS source
  FROM ingame_proven_characters iv
  CROSS JOIN source_rank_maps im ON im.guild_id = iv.guild_id AND im.source = 'ingame' AND im.team_id IS NULL AND im.source_key = CAST(iv.roster_rank AS TEXT)
 WHERE im.role_id IS NOT NULL
   AND (im.role_id <> 'guild_master' OR im.source_key = '0')
   AND (im.role_id <> 'team_lead' OR iv.team_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM ingame_proven_characters ib WHERE ib.guild_id = iv.guild_id AND ib.user_id = iv.user_id AND ib.roster_rank < iv.roster_rank);

-- The Owner: ONE guild_master row. The seat holder while not suspended (suspension = rank_source 'ingame' and no valid proven character); else, in a guild before the flip, the
-- holder of the stored guild_master row. worker/owner.js reads this view for isOwner, ownerSql, ownerGuard and the candidate sets.
CREATE VIEW effective_roles_owner AS
SELECT og.id AS guild_id, og.owner_user_id AS user_id, 'guild_master' AS role_id, NULL AS team_id, 'owner' AS source
  FROM guilds og
 WHERE og.owner_user_id IS NOT NULL
   AND (og.rank_source IS NOT 'ingame'
        OR EXISTS (SELECT 1 FROM ingame_proven_characters ov WHERE ov.guild_id = og.id AND ov.user_id = og.owner_user_id))
UNION ALL
SELECT oa.guild_id, oa.user_id, 'guild_master', NULL, 'owner'
  FROM role_assignments oa
  CROSS JOIN guilds ol ON ol.id = oa.guild_id AND ol.owner_user_id IS NULL AND ol.rank_source IS NULL
 WHERE oa.role_id = 'guild_master';

-- Everything an account holds in a guild, with where it comes from.
CREATE VIEW effective_roles AS
SELECT guild_id, user_id, role_id, team_id, source FROM effective_roles_stored
UNION ALL
SELECT guild_id, user_id, role_id, team_id, source FROM effective_roles_ingame
UNION ALL
SELECT guild_id, user_id, role_id, team_id, source FROM effective_roles_owner;
