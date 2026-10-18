// Who belongs to a guild, and which roster person is whose. The ONE definition: every route that asks "is this account a member" or "is this
// person mine" builds its SQL from the fragments below (or calls the pure functions), so the rule cannot drift between files.
//
//   member of a guild = NOT blocked there AND ( in the guild's Discord server  OR  linked to a roster person of the guild )
//
//   in the Discord server   a user_servers row for the guild's server (written at each Discord sign-in or link; Discord accounts only)
//   linked to a person      players.user_id = the account, set by an officer ("Link account" on the person page) or by an approved
//                           Battle.net character claim. A Discord ID match alone (players.discord_user_id) does NOT make someone a member:
//                           leaving the Discord server still ends a Discord member's access, exactly as before accounts existed.
//   blocked                 a guild_blocks row; it wins over both
//
//   my person = players.user_id is the account  OR  players.discord_user_id is the account's Discord ID  (ownPlayerSql / isOwnPlayer)
//
// The fragments take SQL EXPRESSIONS: a column (`u.id`, `g.discord_server_id`) or a column of a one-row derived table that carries the bound
// values, `FROM ..., (SELECT ? AS gid, ? AS sid) gc` with `gc.gid`. Do not pass a bare `?` for more than one expression of a fragment, and do not
// rely on the order of placeholders inside a fragment; the bound forms (boundMember, boundReaches) exist for guards that carry their own values.
// (ownPlayerSql repeats only its user, so a bare `?` for the user is fine there: bind the user twice.)

// Pure form of the rule, for the places that already hold the three facts.
// -> 'blocked' | 'member' | 'none'
export function membershipOf({ blocked, inServer, linked }) {
  if (blocked) return 'blocked';
  return inServer || linked ? 'member' : 'none';
}

export const blockedSql = (userExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM guild_blocks mb WHERE mb.guild_id = ${guildExpr} AND mb.user_id = ${userExpr})`;

export const inServerSql = (userExpr, serverExpr) =>
  `EXISTS (SELECT 1 FROM user_servers ms WHERE ms.user_id = ${userExpr} AND ms.server_id = ${serverExpr})`;

export const rosterLinkSql = (userExpr, guildExpr) =>
  `EXISTS (SELECT 1 FROM players ml WHERE ml.guild_id = ${guildExpr} AND ml.user_id = ${userExpr})`;

// "In the server or linked" without the block test: for the screens that show blocked people apart from members (People and roles).
export const reachesGuildSql = (userExpr, guildExpr, serverExpr) =>
  `(${inServerSql(userExpr, serverExpr)} OR ${rosterLinkSql(userExpr, guildExpr)})`;

// The rule itself: a current, unblocked member.
export const memberSql = (userExpr, guildExpr, serverExpr) =>
  `(NOT ${blockedSql(userExpr, guildExpr)} AND ${reachesGuildSql(userExpr, guildExpr, serverExpr)})`;

// The accounts that can be members of a guild at all (a one-column subquery of user ids): everyone in its Discord server plus everyone
// linked to one of its people. List screens start from this set and then apply memberSql / blockedSql.
export const memberCandidatesSql = (guildExpr, serverExpr) =>
  `SELECT user_id FROM user_servers WHERE server_id = ${serverExpr} UNION SELECT user_id FROM players WHERE guild_id = ${guildExpr} AND user_id IS NOT NULL`;

// A guard that carries its own values, for the statements that repeat an authorization inside the write: { sql, params }, true while the
// account is a current member (or, for boundReaches, in the server or linked whether or not it is blocked).
const VALUES = '(SELECT ? AS uid, ? AS gid, ? AS sid) b';
export function boundMember(userId, guildId, serverId) {
  return { sql: `EXISTS (SELECT 1 FROM ${VALUES} WHERE ${memberSql('b.uid', 'b.gid', 'b.sid')})`, params: [userId, guildId, serverId] };
}
export function boundReaches(userId, guildId, serverId) {
  return { sql: `EXISTS (SELECT 1 FROM ${VALUES} WHERE ${reachesGuildSql('b.uid', 'b.gid', 'b.sid')})`, params: [userId, guildId, serverId] };
}

// The person (a players row, alias given) belongs to the account; the account is an expression used twice.
export const ownPlayerSql = (playerAlias, userExpr) =>
  `(${playerAlias}.user_id = ${userExpr} OR (${playerAlias}.discord_user_id IS NOT NULL AND ${playerAlias}.discord_user_id = (SELECT du.discord_id FROM users du WHERE du.id = ${userExpr})))`;

// Pure form: player = { user_id, discord_user_id } (a players row), viewer = { userId, discordId } (the session's user).
export function isOwnPlayer(player, viewer) {
  if (!player || !viewer) return false;
  if (player.user_id && viewer.userId && player.user_id === viewer.userId) return true;
  return !!player.discord_user_id && !!viewer.discordId && player.discord_user_id === viewer.discordId;
}
