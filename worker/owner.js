// The Owner (user-hierarchy build, lanes B4b and B6b; plan "Model" > Owner-only acts). ONE definition of "is this account the Owner of this guild", in SQL and as a route
// guard, so a hand-over, a guild delete, a rank-map change, the Seniority guard (worker/seniority.js), the audit snapshot and the member test of an in-game guild can never
// disagree about who the Owner is.
//
// The definition lives in ONE place, the view effective_roles_owner (migration 0035). Every function below asks that view, so suspension cannot drift between "the Owner's row
// among the effective roles" and "isOwner":
//
//   owner_user_id = the account AND NOT SUSPENDED         the seat (set by the flip, a hand-over, a claim or a guild created without Discord).
//                                                          Suspension exists only for rank_source 'ingame': the seat holder has no VALID Battle.net-proven character
//                                                          (proof_user_id = players.user_id, its identity key a guild_roster row of the guild, the account's current bnet_links
//                                                          id = proof_bnet_account_id) on the stored roster. A suspended Owner keeps the seat and nothing else: the powers drop to
//                                                          their own derived rank (U R4-Q3 / R5-Q2).
//   else, while owner_user_id IS NULL AND rank_source IS NULL    every guild before the flip: the holder of the stored guild_master row IS the Owner. Once the seat is set or
//                                                          the rank source is chosen, a stored guild_master row left behind grants nothing (review finding B4b/B5 F1).
//
// A Guild Master by role who does not hold the seat (a DERIVED Guild Master: the in-game rank 0 maps to Guild Master) is not the Owner: it passes every Guild Master gate and
// fails every Owner gate. ownerOf() below is the pure mirror of the rule for tests and for places that already hold the facts; a parity test runs it against the SQL.
import { HttpError } from './http.js';

export const OWNER_ONLY_MESSAGE = 'Only the Owner of the guild can do that.';

// Pure mirror of the rule above. userId: the account asked about. Facts: ownerUserId (guilds.owner_user_id), rankSource (guilds.rank_source), storedMasterUserId (the holder of the
// stored guild_master row, or null), hasValidProvenCharacter (the SEAT HOLDER has a valid Battle.net-proven character on the stored roster).
export function ownerOf({ userId, ownerUserId = null, rankSource = null, storedMasterUserId = null, hasValidProvenCharacter = false }) {
  if (!userId) return false;
  if (ownerUserId !== null) return ownerUserId === userId && (rankSource !== 'ingame' || hasValidProvenCharacter);
  return rankSource === null && storedMasterUserId === userId;
}

// SQL: true when the account (an expression for the user id) is the Owner of the guild (an expression for the guild id): a row of effective_roles_owner. Both are fixed column
// expressions or numbered parameters (?1); the guild expression is written once and the user expression TWICE (the second time as a NULL guard), so a bare `?` is only right when the
// caller binds the account twice (ownerGuard does: guild, user, user). Fixed text, no request data.
export const ownerSql = (guildExpr, userExpr) =>
  `EXISTS (SELECT 1 FROM effective_roles_owner eo WHERE eo.guild_id = ${guildExpr} AND eo.user_id = ${userExpr} AND ${userExpr} IS NOT NULL)`;

// SQL: a one-column compound (user_id) of the accounts that can pass ownerSql for a guild: the seat holder (suspended or not) and the Owner row of the view. A SUPERSET (ownerSql
// itself decides): for the candidate sets of worker/membership.js. The guild expression is written twice, so a bare `?` is only right when the caller binds it twice; numbered
// parameters (?1) repeat freely.
export const ownerCandidatesSql = (guildExpr) => `SELECT ocg.owner_user_id AS user_id FROM guilds ocg WHERE ocg.id = ${guildExpr} AND ocg.owner_user_id IS NOT NULL
    UNION SELECT oce.user_id FROM effective_roles_owner oce WHERE oce.guild_id = ${guildExpr}`;

// SQL: a one-column compound (guild_id) of the guilds an account holds the Owner seat of, suspended or not, or is the Owner of by the stored Guild Master row of a guild before the
// flip: the "owner" candidate set of "my guilds" (worker/membership.js) and the guilds an account deletion has to settle. Index-backed: guilds_owner and
// idx_role_assignments_user. The user expression is written twice (see above).
export const ownedGuildsSql = (userExpr) => `SELECT oug.id AS guild_id FROM guilds oug WHERE oug.owner_user_id = ${userExpr}
    UNION SELECT oue.guild_id FROM effective_roles_owner oue WHERE oue.user_id = ${userExpr}`;

// SQL: true when the guild has an Owner at all (a seat holder, suspended or not; or, before the flip, a stored Guild Master): "does this guild still need a claim". The guild
// expression is written twice.
export const hasOwnerSql = (guildExpr) => `(EXISTS (SELECT 1 FROM guilds hg WHERE hg.id = ${guildExpr} AND hg.owner_user_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM effective_roles_owner he WHERE he.guild_id = ${guildExpr}))`;

// { sql, params } for a guarded write inside a db.batch: the same test with the guild and the account bound (three placeholders: guild, user, user).
export function ownerGuard(guildId, userId) {
  return { sql: ownerSql('?', '?'), params: [guildId, userId, userId] };
}

// True when the account is the Owner of the guild (holds the seat and is not suspended).
export async function isOwner(db, guildId, userId) {
  const guard = ownerGuard(guildId, userId);
  const row = await db.prepare(`SELECT ${guard.sql} AS owner`).bind(...guard.params).first();
  return !!row && row.owner === 1;
}

// Throws 403 unless the signed-in account is the Owner. A dev "View as" stand-in never exercises an Owner act: it shows what a lower role sees.
export async function requireOwner(db, guildContext, message = OWNER_ONLY_MESSAGE) {
  if (guildContext.viewAs) throw new HttpError(403, 'forbidden', message);
  if (!(await isOwner(db, guildContext.guild.id, guildContext.userId))) throw new HttpError(403, 'forbidden', message);
}
