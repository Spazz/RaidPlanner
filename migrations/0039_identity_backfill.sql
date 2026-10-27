-- Raidsmith user hierarchy, identity split (migration 0039): one-time backfill of players.user_id, and nothing else.
--
-- WHY. User decision 2026-10-26: "my person" (ownership of a roster person) comes ONLY from players.user_id. A person's Discord ID (players.discord_user_id) and names are
-- bookkeeping that sign-ups, logs and loot keep following; they never make an account the owner. Until now worker/membership.js ownPlayerSql ALSO counted a person that
-- carried the account's Discord ID, so every such person was somebody's by ownership without any link. This file gives those accounts the link, so the release that drops
-- the Discord branch changes nobody's ownership.
--
-- WHAT. For a person with players.user_id NULL and a discord_user_id, the account whose users.discord_id equals it becomes the person's user_id, unless
--   (a) the account already owns a person in that guild (players_guild_user is UNIQUE: one account, one person per guild; the Discord person stays bookkeeping), or
--   (b) the link would let the account into a guild it is not in today. Membership (worker/membership.js) reads players.user_id, so an unconditional backfill would let an
--       account that left the Discord server of a legacy guild back in, and would make every Discord-only person's account a member of every manual or in-game guild.
--       The backfill therefore links only an account that is a member of the guild TODAY, by the guild's own rank source and with the block test:
--         legacy (rank_source NULL, or a value this release does not know)  in the guild's Discord server (user_servers, a real server id) and not blocked
--         'manual'                                                           nobody: membership there needs a link, and an account without one is no member
--         'ingame'                                                           the unsuspended Owner (a row of effective_roles_owner), whom a block never touches
--       A block row on the unsuspended Owner is ignored, exactly as blockedSql ignores it. Everybody else is left as they are; their person is bookkeeping and the
--       player claims it ("This is me") when they come back.
--   One person per Discord ID per guild is a unique index (players_guild_discord) and users.discord_id is unique, so the person-to-account match is always 1:1; the
--   COUNT guard below says so in SQL and skips a row if that ever stopped being true.
--
-- THE PROOF TRIGGER. players_user_change_clears_proof (0031) wipes owner_proof / proof_* on every character of a person whenever players.user_id changes, which is right for a
-- change of owner and wrong here: the account behind the person does not change, and the characters that an officer or the player themself attested ('officer', 'hand') on
-- a Discord-owned person must keep that attestation. The trigger is dropped for the UPDATE and created again right after it, with the same text as 0031. (A person
-- with a Battle.net proof always has a user_id already, so nothing proved by Battle.net is in scope.)
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live). The previous code owns a person by user_id OR by Discord ID: for the
-- account just linked the answer is the same person either way. Membership does not move (see (b)), no schema changes, no column or index is added, and the only rows touched
-- are persons whose user_id was NULL. version and updated_at are left alone on purpose: nobody edited the person, and an open page must not hit a conflict because of it.
-- The statement is idempotent: a rerun finds user_id set and links nothing more (and the trigger is created IF NOT EXISTS).
--
-- ROLLBACK (the Discord ID is still on every person, so the links can be recomputed; this clears the ones the backfill wrote, which cannot be told apart from an officer's
-- or a Battle.net link afterwards, so a rollback is a decision for a person, not a blind statement):
--   none. The previous release behaves the same with or without the links.

DROP TRIGGER IF EXISTS players_user_change_clears_proof;

UPDATE players
   SET user_id = (SELECT u.id FROM users u WHERE u.discord_id = players.discord_user_id)
 WHERE players.user_id IS NULL
   AND players.discord_user_id IS NOT NULL
   AND (SELECT COUNT(*) FROM players c WHERE c.guild_id = players.guild_id AND c.discord_user_id = players.discord_user_id) = 1
   AND (SELECT COUNT(*) FROM users u WHERE u.discord_id = players.discord_user_id) = 1
   AND EXISTS (
     SELECT 1 FROM users u
      WHERE u.discord_id = players.discord_user_id
        AND NOT EXISTS (SELECT 1 FROM players o WHERE o.guild_id = players.guild_id AND o.user_id = u.id)
        AND CASE COALESCE((SELECT g.rank_source FROM guilds g WHERE g.id = players.guild_id), '')
              WHEN 'ingame' THEN EXISTS (SELECT 1 FROM effective_roles_owner eo WHERE eo.guild_id = players.guild_id AND eo.user_id = u.id)
              WHEN 'manual' THEN 0
              ELSE (NOT EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = players.guild_id AND b.user_id = u.id
                                  AND NOT EXISTS (SELECT 1 FROM effective_roles_owner bo WHERE bo.guild_id = b.guild_id AND bo.user_id = b.user_id))
                    AND EXISTS (SELECT 1 FROM guilds sg JOIN user_servers us ON us.server_id = sg.discord_server_id
                                 WHERE sg.id = players.guild_id AND us.user_id = u.id
                                   AND sg.discord_server_id IS NOT NULL AND substr(sg.discord_server_id, 1, 5) != 'none:'))
            END
   );

CREATE TRIGGER IF NOT EXISTS players_user_change_clears_proof AFTER UPDATE OF user_id ON players
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  UPDATE characters SET owner_proof = NULL, proof_user_id = NULL, proof_bnet_account_id = NULL, proof_at = NULL WHERE player_id = NEW.id;
END;
