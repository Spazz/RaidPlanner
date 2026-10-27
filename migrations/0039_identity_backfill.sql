-- Raidsmith user hierarchy, identity split (migration 0039): one-time backfill of players.user_id, and the flag that keeps a backfilled link from being a membership.
--
-- WHY. User decision 2026-10-26: "my person" (ownership of a roster person) comes ONLY from players.user_id. A person's Discord ID (players.discord_user_id) and names are
-- bookkeeping that sign-ups, logs and loot follow; they never make an account the owner. Until now worker/membership.js ownPlayerSql ALSO counted a person that
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
-- THE FLAG. players.user_id_backfilled = 1 marks a link this file wrote from a Discord ID match alone. The link is the person's owner ("my person") and nothing more: in a
-- legacy guild a link counted as a membership by itself, so a backfilled account that later left the Discord server would have kept its access through the link. The legacy
-- rule of worker/membership.js therefore ignores a backfilled link (a Discord ID match alone never makes a member: leaving the server still ends a Discord member's access).
-- Two triggers clear the flag the moment the link is confirmed by the account holder's own proof: players.user_id changes (an unlink, a Delete my data, a new owner; the new
-- link then comes from a Battle.net proof, an accepted application or an approved claim), or a Battle.net proof of this very account lands on a character of the person.
-- Every other link, including the ones written before this file, has the flag 0 and counts as before. 'manual' and 'ingame' guilds never read the flag.
-- The triggers are created AFTER the backfill, so the backfill's own change of user_id does not clear what it just set.
--
-- THE PROOF TRIGGER. players_user_change_clears_proof (0031) wipes owner_proof / proof_* on every character of a person whenever players.user_id changes, which is right for a
-- change of owner and wrong here: the account behind the person does not change, and the characters that an officer or the player themself attested ('officer', 'hand') on
-- a Discord-owned person must keep that attestation. The trigger is dropped for the UPDATE and created again right after it, with the same text as 0031. (A person
-- with a Battle.net proof always has a user_id already, so nothing proved by Battle.net is in scope.)
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live). The previous code owns a person by user_id OR by Discord ID: for the
-- account just linked the answer is the same person either way. Membership does not move (see (b) and the flag), the new column has a default the previous code never has to
-- supply (its INSERTs name their columns), the new triggers only write that column, and the only rows the backfill touches are persons whose user_id was NULL. version and
-- updated_at are left alone on purpose: nobody edited the person, and an open page must not hit a conflict because of it. The backfill statement is idempotent: a rerun
-- finds user_id set and links nothing more (the ALTER is not; a migration file is applied once).
--
-- ROLLBACK (the Discord ID is still on every person, so the links can be recomputed; the ones the backfill wrote are the rows with user_id_backfilled = 1, until a proof or a
-- change of owner clears the flag): none needed. The previous release behaves the same with or without the links and ignores the column.

ALTER TABLE players ADD COLUMN user_id_backfilled INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS players_user_change_clears_proof;

UPDATE players
   SET user_id = (SELECT u.id FROM users u WHERE u.discord_id = players.discord_user_id),
       user_id_backfilled = 1
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

-- A new owner (or none) is no backfilled link. The inner UPDATE names user_id_backfilled only, so it does not fire this trigger again.
CREATE TRIGGER IF NOT EXISTS players_user_change_clears_backfill AFTER UPDATE OF user_id ON players
WHEN OLD.user_id IS NOT NEW.user_id AND NEW.user_id_backfilled = 1
BEGIN
  UPDATE players SET user_id_backfilled = 0 WHERE id = NEW.id;
END;

-- A Battle.net proof of the very account behind a backfilled link confirms it: the account holder proved a character of the person.
CREATE TRIGGER IF NOT EXISTS characters_bnet_proof_confirms_link AFTER INSERT ON characters
WHEN NEW.owner_proof = 'bnet' AND NEW.proof_user_id IS NOT NULL
BEGIN
  UPDATE players SET user_id_backfilled = 0 WHERE id = NEW.player_id AND user_id = NEW.proof_user_id AND user_id_backfilled = 1;
END;

CREATE TRIGGER IF NOT EXISTS characters_bnet_proof_update_confirms_link AFTER UPDATE OF owner_proof, proof_user_id ON characters
WHEN NEW.owner_proof = 'bnet' AND NEW.proof_user_id IS NOT NULL
BEGIN
  UPDATE players SET user_id_backfilled = 0 WHERE id = NEW.player_id AND user_id = NEW.proof_user_id AND user_id_backfilled = 1;
END;
