// The Owner seat test (user-hierarchy build, lane B4b; plan "Model" > Owner-only acts). ONE definition of "is this account the Owner of this guild", in SQL
// and as a route guard, so a hand-over, a guild delete, a rank-map change and the Seniority guard (worker/seniority.js) can never disagree about who the
// Owner is.
//
//   owner_user_id = the account                       the seat (set by the flip, a hand-over, a claim or a guild created without Discord)
//   owner_user_id IS NULL and the account holds the   every guild before the flip: the Guild Master row IS the Owner seat
//   stored guild_master row
//
// This is the SEAT test only. Lane B6b rewrites it to read the owner view (the same single fragment then also decides whether the Owner is SUSPENDED), and
// the suspended-Owner assertions of the gates below belong to B6b's acceptance. A derived Guild Master (a Guild Master by role who does not hold the seat) is
// not the Owner: it passes every Guild Master gate and fails every Owner gate.
import { HttpError } from './http.js';

export const OWNER_ONLY_MESSAGE = 'Only the Owner of the guild can do that.';

// SQL: true when the account (an expression for the user id) is the Owner of the guild (an expression for the guild id). Both are fixed column expressions or
// numbered parameters (?1); the user expression is written twice, so a bare `?` is only right when the caller binds it twice (ownerGuard does). Fixed text,
// no request data.
export const ownerSql = (guildExpr, userExpr) => `EXISTS (SELECT 1 FROM guilds og WHERE og.id = ${guildExpr} AND (og.owner_user_id = ${userExpr}
    OR (og.owner_user_id IS NULL AND EXISTS (SELECT 1 FROM role_assignments gm WHERE gm.guild_id = og.id AND gm.user_id = ${userExpr} AND gm.role_id = 'guild_master'))))`;

// { sql, params } for a guarded write inside a db.batch: the same test with the guild and the account bound (three placeholders: guild, user, user).
export function ownerGuard(guildId, userId) {
  return { sql: ownerSql('?', '?'), params: [guildId, userId, userId] };
}

// True when the account holds the Owner seat of the guild.
export async function isOwner(db, guildId, userId) {
  const guard = ownerGuard(guildId, userId);
  const row = await db.prepare(`SELECT ${guard.sql} AS owner`).bind(...guard.params).first();
  return !!row && row.owner === 1;
}

// Throws 403 unless the signed-in account holds the Owner seat. A dev "View as" stand-in never exercises an Owner act: it shows what a lower role sees.
export async function requireOwner(db, guildContext, message = OWNER_ONLY_MESSAGE) {
  if (guildContext.viewAs) throw new HttpError(403, 'forbidden', message);
  if (!(await isOwner(db, guildContext.guild.id, guildContext.userId))) throw new HttpError(403, 'forbidden', message);
}
