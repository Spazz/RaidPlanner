// Who belongs to a guild, and which roster person is whose. The ONE definition: every route that asks "is this account a member" or "is this
// person mine" builds its SQL from the fragments below (or calls the pure functions), so the rule cannot drift between files. A CI grep
// (tests/guild/guild-b5-membership-tests.js) pins that no other worker file reads user_servers or players.user_id for a membership decision.
//
//   member of a guild = NOT blocked there AND ( the guild's rank source lets the account in )      guilds.rank_source, read INSIDE the SQL
//
//   rank_source NULL      legacy (every guild before the flip, and any value this file does not know): in the guild's Discord server  OR  linked to a roster person
//   rank_source 'manual'  no Battle.net data (U R3-Q7), today's rule minus Discord: linked to a roster person
//   rank_source 'ingame'  the unsuspended Owner  OR  linked to a person with at least one character that is on the in-game roster (guild_roster, by identity key)
//                         and not Former (left_on IS NULL), any proof type. players.user_id ONLY: never players.discord_user_id, and Discord server membership
//                         grants nothing. A Social-ranked character on the roster keeps membership; a person with no character on the roster, or only Former
//                         ones, is not a member, and the roles stored for them grant nothing while that holds (loadGuildContext).
//
//   in the Discord server   a user_servers row for the guild's server (written at each Discord sign-in or link; Discord accounts only)
//   linked to a person      players.user_id = the account, set by an officer ("Link account" on the person page), by an approved Battle.net character claim, or
//                           (in-game guilds) by the sign-in match. A Discord ID match alone (players.discord_user_id) does NOT make someone a member: leaving the
//                           Discord server still ends a Discord member's access, exactly as before accounts existed.
//   blocked                 a guild_blocks row; it wins over every source, except on the unsuspended Owner (they cannot be blocked: a row on them is ignored)
//
//   my person = players.user_id is the account, and NOTHING else  (ownPlayerSql / isOwnPlayer; user decision 2026-10-26). A person's Discord ID
//               (players.discord_user_id) and names are bookkeeping: sign-ups, logs and loot keep following them and staff keep recording them, but they never make an
//               account the owner. players.user_id is written only by Battle.net proof, the account holder's own accepted application and an officer-approved
//               "This is me" claim (pinned by tests/guild/guild-identity-split-tests.js).
//
// The switch on the source is ONE CASE inside the fragment, keyed on the guild expression, so a request that races a flip reads the source once and cannot mix
// two rules. The pure forms (reachesOf / membershipOf) mirror the SQL for the places that already hold the facts; a parity test runs both over the whole matrix.
//
// The fragments take SQL EXPRESSIONS: a column (`u.id`, `g.discord_server_id`) or a column of a one-row derived table that carries the bound
// values, `FROM ..., (SELECT ? AS gid, ? AS sid) gc` with `gc.gid`. Do not pass a bare `?` for more than one expression of a fragment, and do not
// rely on the order of placeholders inside a fragment; the bound forms (boundMember, boundReaches) exist for guards that carry their own values. The server
// expression is used once (the legacy branch); the user and guild expressions several times: pass columns, or numbered parameters (?1) for those.
// (ownPlayerSql uses its user once, so a bare `?` for the user is fine there: bind the user once.) The aliases inside the fragments (mb, ms, ml, mx_*) are
// fixed: a caller must not use them for its own tables.

import { serverIdIsDiscordSql } from './discord-guard.js';
import { ownedGuildsSql, ownerCandidatesSql, ownerSql, seatHeldBySql } from './owner.js';

// Pure form of the rule, for the places that already hold the facts. `source` is guilds.rank_source (null = legacy; a value this file does not know is legacy too).
//   inServer         a user_servers row for the guild's Discord server
//   linked           players.user_id = the account on a person of the guild
//   owner            the unsuspended Owner (unsuspendedOwnerSql)
//   rosterCharacter  linked to a person with a character on the in-game roster that is not Former (rosterCharacterSql)
// -> true when the guild's source lets the account in (the block test is separate).
export function reachesOf({ source = null, inServer = false, linked = false, owner = false, rosterCharacter = false }) {
  if (source === 'ingame') return !!(owner || rosterCharacter);
  if (source === 'manual') return !!linked;
  return !!(inServer || linked);
}

// -> 'blocked' | 'member' | 'none'. A block does not apply to the unsuspended Owner (facts.owner): see blockedSql.
export function membershipOf({ blocked, ...facts }) {
  if (blocked && !facts.owner) return 'blocked';
  return reachesOf(facts) ? 'member' : 'none';
}

// The 403 not_member message for a guild of this rank source. Only a legacy guild talks about its Discord server: in a 'manual' or 'ingame' guild the server grants
// nothing, so naming it would send the person to the wrong place.
export function notMemberMessage(source) {
  if (source === 'ingame') {
    return "Your account has no character on this guild's in-game roster. Connect Battle.net with a character that is in the guild, or ask an officer to link your account to a roster entry whose character is on the in-game roster.";
  }
  if (source === 'manual') {
    return 'No roster entry is linked to your account. Ask an officer to link your account to your roster entry in this guild.';
  }
  return "You are not in this guild's Discord server, and no roster entry is linked to your account. Sign in again if you just joined the server, or ask an officer to link your account to your roster entry.";
}

// A guild_blocks row blocks, EXCEPT on the Owner who is not suspended (plan "Owner": an unsuspended Owner cannot be blocked; a block row written while they were suspended,
// or by a tombstone match, is ignored the moment they are live again and counts again if they are suspended again). The Owner test is the one fragment of worker/owner.js,
// asked about the block row's own guild and user, so it adds no placeholder.
export const blockedSql = (userExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM guild_blocks mb WHERE mb.guild_id = ${guildExpr} AND mb.user_id = ${userExpr} AND NOT ${ownerSql('mb.guild_id', 'mb.user_id')})`;

// A guild without Discord (hasDiscord, worker/discord-guard.js: server id NULL or 'none:<guild>') has no server to be in. The guard is on the matched
// user_servers column, so the server expression is still used once (a bare `?` stays safe).
export const inServerSql = (userExpr, serverExpr) =>
  `EXISTS (SELECT 1 FROM user_servers ms WHERE ms.user_id = ${userExpr} AND ms.server_id = ${serverExpr} AND ${serverIdIsDiscordSql('ms.server_id')})`;

export const rosterLinkSql = (userExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM players ml WHERE ml.guild_id = ${guildExpr} AND ml.user_id = ${userExpr})`;

// The guild's rank source as the SQL reads it: 'ingame', 'manual', or '' (legacy: NULL, or a value this file does not know). One primary-key lookup.
export const rankSourceSql = (guildExpr) => `COALESCE((SELECT mx_rs.rank_source FROM guilds mx_rs WHERE mx_rs.id = ${guildExpr}), '')`;

// The person (a players.id expression, a person OF that guild) has a character on the guild's in-game roster that is not Former: the character's identity key
// (namespace, realm id, character id) is a guild_roster row of the guild and left_on is NULL. The rank (Social included) and the proof type do not matter.
// The characters are looked up by the person alone (characters_player...): a guild condition on them would let the planner walk every character of the guild instead.
export const personOnRosterSql = (personExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM characters mx_ch JOIN guild_roster mx_gr ON mx_gr.guild_id = ${guildExpr} AND mx_gr.namespace = mx_ch.namespace
            AND mx_gr.blizzard_realm_id = mx_ch.blizzard_realm_id AND mx_gr.blizzard_char_id = mx_ch.blizzard_char_id
           WHERE mx_ch.player_id = ${personExpr} AND mx_ch.left_on IS NULL)`;

// 'ingame': the account is linked (players.user_id, never the Discord ID) to a person who is on the roster.
export const rosterCharacterSql = (userExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM players mx_pl WHERE mx_pl.guild_id = ${guildExpr} AND mx_pl.user_id = ${userExpr} AND ${personOnRosterSql('mx_pl.id', guildExpr)})`;

// The Owner term of the 'ingame' rule: the Owner row of the effective-roles view (worker/owner.js), i.e. the seat holder who is NOT suspended (an Owner with no valid
// Battle.net-proven character on the last good roster is suspended, U R4-Q3), the same fragment that decides isOwner. A suspended Owner keeps the seat and is a member
// only through a roster character of their own.
export const unsuspendedOwnerSql = (userExpr, guildExpr) => ownerSql(guildExpr, userExpr);

// "The source lets the account in" without the block test: for the screens that show blocked people apart from members (People and roles).
export const reachesGuildSql = (userExpr, guildExpr, serverExpr) =>
  `CASE ${rankSourceSql(guildExpr)}
     WHEN 'ingame' THEN (${unsuspendedOwnerSql(userExpr, guildExpr)} OR ${rosterCharacterSql(userExpr, guildExpr)})
     WHEN 'manual' THEN ${rosterLinkSql(userExpr, guildExpr)}
     ELSE (${inServerSql(userExpr, serverExpr)} OR ${rosterLinkSql(userExpr, guildExpr)})
   END`;

// The rule itself: a current, unblocked member.
export const memberSql = (userExpr, guildExpr, serverExpr) =>
  `(NOT ${blockedSql(userExpr, guildExpr)} AND ${reachesGuildSql(userExpr, guildExpr, serverExpr)})`;

// The account has SOME tie to the guild: a member, the seat holder (suspended or not), or the owner of a person or of a character proved by Battle.net in it (players.user_id,
// characters.proof_user_id). Not a membership decision: it says whose refused sign-in checks are written into the guild's own activity log (a stranger's are logged only, so nobody
// can fill another guild's log). The guild and server expressions are columns, the user expression is used four times.
export const guildTieSql = (userExpr, guildExpr, serverExpr) =>
  `(${memberSql(userExpr, guildExpr, serverExpr)} OR ${seatHeldBySql(guildExpr, userExpr)} OR ${rosterLinkSql(userExpr, guildExpr)}
    OR EXISTS (SELECT 1 FROM characters tc WHERE tc.guild_id = ${guildExpr} AND tc.proof_user_id = ${userExpr}))`;

// -> true when the account has a tie to the guild (guildTieSql). One statement, two numbered parameters.
export async function hasGuildTie(db, userId, guildId) {
  const row = await db.prepare(
    `SELECT 1 AS tied FROM guilds tg, (SELECT ?1 AS uid) tu WHERE tg.id = ?2 AND ${guildTieSql('tu.uid', 'tg.id', 'tg.discord_server_id')}`,
  ).bind(userId, guildId).first();
  return !!row;
}

// The accounts that can be members of a guild at all (a one-column subquery of user ids), per source: the Discord server's members only while the source is
// legacy, everyone linked to one of its people, and the Owner candidates (ownerCandidatesSql) only while it is 'ingame'. A SUPERSET: list screens start from
// this set and then apply memberSql / blockedSql. Three terms (D1 allows five).
export const memberCandidatesSql = (guildExpr, serverExpr) =>
  `SELECT user_id FROM user_servers WHERE server_id = ${serverExpr} AND ${serverIdIsDiscordSql('server_id')} AND ${rankSourceSql(guildExpr)} NOT IN ('ingame', 'manual')
   UNION SELECT user_id FROM players WHERE guild_id = ${guildExpr} AND user_id IS NOT NULL
   UNION SELECT user_id FROM (${ownerCandidatesSql(guildExpr)}) WHERE ${rankSourceSql(guildExpr)} = 'ingame'`;

// "My guilds": the guilds ONE account can be a member of, driven from the account's own rows instead of a pass over every guild. ?1 = the account. Each lookup is
// index-backed: user_servers (primary key user_id) then guilds.discord_server_id (unique), players_user, guilds_owner and idx_role_assignments_user. A SUPERSET of
// the member guilds of every source (the Discord server for legacy, the link for all, the Owner seat for 'ingame'); memberSql then decides.
const MY_GUILD_CANDIDATES_SQL = `SELECT mx_g.id AS guild_id FROM user_servers mx_us JOIN guilds mx_g ON mx_g.discord_server_id = mx_us.server_id
    WHERE mx_us.user_id = ?1 AND ${serverIdIsDiscordSql('mx_us.server_id')}
   UNION SELECT mx_p.guild_id FROM players mx_p WHERE mx_p.user_id = ?1
   UNION SELECT guild_id FROM (${ownedGuildsSql('?1')})`;
const MY_GUILDS_SQL = `SELECT g.id, g.name, g.realm, g.realm_kind, g.realm_slug, g.region, g.game_version FROM (${MY_GUILD_CANDIDATES_SQL}) mx_c
      JOIN guilds g ON g.id = mx_c.guild_id
     WHERE ${memberSql('?1', 'g.id', 'g.discord_server_id')}
     ORDER BY g.name, g.id`;

// The ids of the guilds ONE account (?1) is a member of, as a sub-select another statement can read (one column, guild_id): the audit rows of an identity change are written
// in each of them (worker/audit.js auditEachMemberGuildStatement). Same candidates and same rule as "My guilds"; the caller binds ?1.
export const MEMBER_GUILD_IDS_SQL = `SELECT mg.id AS guild_id FROM (${MY_GUILD_CANDIDATES_SQL}) mgc JOIN guilds mg ON mg.id = mgc.guild_id WHERE ${memberSql('?1', 'mg.id', 'mg.discord_server_id')}`;

// The statement behind GET /auth/me and loadMemberGuilds: the account's member guilds (id, name, realm, realm_kind, realm_slug, region, game_version), by name.
export const memberGuildsStatement = (db, userId) => db.prepare(MY_GUILDS_SQL).bind(userId);

// A guard that carries its own values, for the statements that repeat an authorization inside the write: { sql, params } , true while the
// account is a current member (or, for boundReaches, passes the source's test whether or not it is blocked).
const VALUES = '(SELECT ? AS uid, ? AS gid, ? AS sid) b';
export function boundMember(userId, guildId, serverId) {
  return { sql: `EXISTS (SELECT 1 FROM ${VALUES} WHERE ${memberSql('b.uid', 'b.gid', 'b.sid')})`, params: [userId, guildId, serverId] };
}
export function boundReaches(userId, guildId, serverId) {
  return { sql: `EXISTS (SELECT 1 FROM ${VALUES} WHERE ${reachesGuildSql('b.uid', 'b.gid', 'b.sid')})`, params: [userId, guildId, serverId] };
}

// The person (a players row, alias given) belongs to the account: players.user_id is the account. The Discord ID the person carries is bookkeeping and never
// decides this (user decision 2026-10-26). The account is an expression used once.
export const ownPlayerSql = (playerAlias, userExpr) => `(${playerAlias}.user_id = ${userExpr})`;

// The roster person who is the account's in a guild (players.user_id = the account), as a statement that returns { id } or nothing. Every route that
// asks "which person am I" (sign-ups, loot, the Raids list) reads it from here.
export function ownPersonStatement(db, guildId, userId) {
  return db.prepare(`SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')}`).bind(guildId, userId);
}

// Pure form: player = { user_id } (a players row), viewer = { userId } (the session's user). Other fields of either (discord ids) are ignored on purpose.
export function isOwnPlayer(player, viewer) {
  if (!player || !viewer) return false;
  return !!player.user_id && !!viewer.userId && player.user_id === viewer.userId;
}

// How a person stands for an account that wants to claim one of its characters ("This is me"): player = { user_id, discord_user_id }, viewer = { userId, discordId }.
//   'yours'  players.user_id is the viewer
//   'taken'  another account owns it, or it records a Discord ID that is not the viewer's (bookkeeping for somebody else)
//   'open'   nobody owns it. It may record the viewer's own Discord ID: that makes the claim a likely one, never an ownership (user decision 2026-10-26).
export function personStanding(player, viewer) {
  if (isOwnPlayer(player, viewer)) return 'yours';
  if (player.user_id) return 'taken';
  if (player.discord_user_id && player.discord_user_id !== (viewer && viewer.discordId)) return 'taken';
  return 'open';
}
