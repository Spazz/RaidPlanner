// Succession of the Owner seat when its holder's account is deleted (user-hierarchy build, lane B6b part 2b; plan "Succession on Owner account delete").
//
// DELETE /auth/me keeps today's hand-over-first rule for an Owner who can hand over (an UNSUSPENDED seat holder, while other members exist: 409 hand_over_guild_master). A seat holder
// who cannot hand over, because they are suspended (an in-game guild whose roster no longer holds a character of theirs proved by Battle.net), and a seat holder whose guild gained a
// member after the impact was read, are SUCCEEDED inside the delete's own batch:
//   'ingame_gm'       the live in-game Guild Master: the account that derives guild_master from a Battle.net-proven rank-0 character on the stored roster (effective_roles_ingame)
//   'manual_officer'  else (an in-game guild) the earliest LIVE stored manual Officer: assigned by hand, earliest by its assignment time, with a character proved by Battle.net on the roster
//   'officer'         (a manual or legacy guild) the earliest stored manual Officer
//   'vacant'          else the seat is left empty (owner_user_id NULL): the in-game Guild Master takes it by claiming it (worker/gm-claim.js)
// Every successor is a current member who is not blocked. The guild is deleted only when no other member exists (worker/membership.js: derived members count). The seat write is
// owner.js moveSeatStatement, so it carries `AND owner_user_id IS <the deleted account>`: a hand-over or a claim that got in first wins and the succession changes nothing. The
// successor is worked out INSIDE the statement (SQL), so what the batch does is what holds when it runs, whatever deleteImpact showed the page.
import { newId } from './ids.js';
import { memberCandidatesSql, memberSql } from './membership.js';
import { liveRecipientSql, moveSeatStatement, seatHeldBySql, seatHolderSql } from './owner.js';

export const SUCCESSION_RULES = Object.freeze(['ingame_gm', 'manual_officer', 'officer', 'vacant']);

// SQL: somebody besides the departing account is a current, unblocked member of the guild (the test that decides whether a guild is deleted and whether a seat needs a successor).
// The expressions are columns (or one bound `?`), each used once.
export const othersExistSql = (guildExpr, serverExpr, departingExpr) =>
  `EXISTS (SELECT 1 FROM (${memberCandidatesSql(guildExpr, serverExpr)}) oc
            WHERE oc.user_id != ${departingExpr} AND ${memberSql('oc.user_id', guildExpr, serverExpr)})`;

// SQL: the account derives guild_master from the in-game rank: the rank map gives rank 0 the Guild Master role and the account has a VALID Battle.net-proven, not Former
// character on a rank-0 roster row. That is the guild_master row of effective_roles_ingame (migration 0035: the best rank wins, and rank 0 is the best there is), written out
// because the view cannot be asked cheaply by a correlated lookup (it is built for every guild first); the plain join view ingame_proven_characters is flattened by the planner and
// answers by guild and account. tests/guild/guild-b6b3-succession-tests.js runs this against the view over the cases where they could differ. Both expressions are columns.
const derivesGuildMasterSql = (guildExpr, userExpr) =>
  `(EXISTS (SELECT 1 FROM source_rank_maps im WHERE im.guild_id = ${guildExpr} AND im.source = 'ingame' AND im.team_id IS NULL AND im.source_key = '0' AND im.role_id = 'guild_master')
    AND EXISTS (SELECT 1 FROM ingame_proven_characters iv WHERE iv.guild_id = ${guildExpr} AND iv.user_id = ${userExpr} AND iv.roster_rank = 0 AND iv.left_on IS NULL))`;

// SQL (a one-column SELECT of at most one row): the live in-game Guild Master, a current member other than the departing account. The candidates are the accounts that proved
// the character on the guild's rank-0 roster row (the guild's own roster rows, found by the identity key); derivesGuildMasterSql decides.
export const liveGmSql = (guildExpr, serverExpr, departingExpr) =>
  `SELECT gc.proof_user_id FROM guild_roster gr
      JOIN characters gc ON gc.guild_id = gr.guild_id AND gc.namespace = gr.namespace AND gc.blizzard_realm_id = gr.blizzard_realm_id AND gc.blizzard_char_id = gr.blizzard_char_id
     WHERE gr.guild_id = ${guildExpr} AND gr.rank = 0 AND gc.owner_proof = 'bnet' AND gc.proof_user_id IS NOT NULL AND gc.proof_user_id != ${departingExpr}
       AND ${derivesGuildMasterSql(guildExpr, 'gc.proof_user_id')} AND ${memberSql('gc.proof_user_id', guildExpr, serverExpr)}
     ORDER BY gc.proof_user_id LIMIT 1`;

// SQL: the earliest stored Officer somebody made by hand (a role Discord gives, or the in-game rank gives, never decides who owns the guild), a current member, and live (in an
// in-game guild: a character proved by Battle.net on the stored roster; elsewhere nothing more is asked, owner.js liveRecipientSql).
export const officerSuccessorSql = (guildExpr, serverExpr, departingExpr) =>
  `SELECT so.user_id FROM effective_roles_stored so
    WHERE so.guild_id = ${guildExpr} AND so.role_id = 'officer' AND so.source = 'manual' AND so.user_id != ${departingExpr}
      AND ${memberSql('so.user_id', guildExpr, serverExpr)} AND ${liveRecipientSql(guildExpr, 'so.user_id')}
    ORDER BY so.assigned_at, so.id LIMIT 1`;

// The rule that chose `to` (null = vacant) in a guild of this rank source, for the page and for the tests; the audit row works the same out in SQL.
export const ruleOf = ({ gmId = null, officerId = null, rankSource = null }) => {
  if (gmId) return 'ingame_gm';
  if (officerId) return rankSource === 'ingame' ? 'manual_officer' : 'officer';
  return 'vacant';
};

// The audit row of a succession (bound: id, actor, the departed account, time, the actor's short id, the guild): written exactly when the seat write just before it changed a row,
// with the seat holder as it is NOW (the successor, or NULL = vacant) and the rule that chose them worked out the way the successor was.
const SUCCESSION_AUDIT_SQL = `INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role)
       SELECT ?, g.id, ?, 'guild.succession', 'guild', g.id, json_object('guildMasterUserId', ?),
              json_object('guildMasterUserId', ${seatHolderSql('g.id')},
                          'rule', CASE WHEN ${seatHolderSql('g.id')} IS NULL THEN 'vacant'
                                       WHEN ${derivesGuildMasterSql('g.id', seatHolderSql('g.id'))} THEN 'ingame_gm'
                                       WHEN g.rank_source = 'ingame' THEN 'manual_officer' ELSE 'officer' END),
              ?, substr(?, 3, 8), 'owner'
         FROM guilds g WHERE g.id = ? AND changes() = 1`;

// The two statements of one guild's succession for the deleting account's batch: the seat moves (only while it is still the departing account's AND somebody else is a member) to
// whoever qualifies when the batch runs, and the audit row `guild.succession` (never pruned) is written exactly when the seat moved: from, to (or vacant) and the rule that chose.
// `guard` ({ sql, params }): the delete's own marker (worker/fresh.js beginAccountDelete), on both statements.
export function successionStatements(ctx, { guildId, departingUserId, guard = null }) {
  const { db } = ctx;
  const guildExpr = 'guilds.id';
  const serverExpr = 'guilds.discord_server_id';
  const successor = {
    sql: `(SELECT COALESCE((${liveGmSql(guildExpr, serverExpr, 'dep.uid')}), (${officerSuccessorSql(guildExpr, serverExpr, 'dep.uid')})) FROM (SELECT ? AS uid) dep)`,
    params: [departingUserId],
  };
  const hasOthers = { sql: othersExistSql(guildExpr, serverExpr, '?'), params: [departingUserId] };
  return [
    moveSeatStatement(db, { guildId, from: departingUserId, to: successor, guards: [hasOthers, ...(guard ? [guard] : [])] }),
    db.prepare(guard ? `${SUCCESSION_AUDIT_SQL} AND ${guard.sql}` : SUCCESSION_AUDIT_SQL)
      .bind(newId('al', ctx.randomBytes), departingUserId, departingUserId, ctx.now(), departingUserId, guildId, ...(guard ? guard.params : [])),
  ];
}

// { sql, params }: no MANUAL guild would be left with an EMPTY Owner seat when this account is deleted. A manual guild has no claim (the in-game Guild Master claims an in-game seat
// only) and a hand-over needs an Owner, so an empty seat there can never be filled again. The seat of a manual guild the account holds is emptied when somebody else is a member (the
// guild is not deleted) and no stored manual Officer can take it (officerSuccessorSql): the delete is refused ("Hand the guild over first."). An Owner who is seen with other members at
// the read is refused there already (deleteImpact handOverFirst); this guard is the same test INSIDE the write, for the member who joined in between. It is the `extra` of the delete's
// opening statement (worker/fresh.js beginAccountDelete), so a failing test writes no marker and nothing of the batch applies, and a fresh grant is not spent.
export function manualSeatKeptGuard(departingUserId) {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM guilds eg WHERE ${seatHeldBySql('eg.id', '?')} AND eg.rank_source = 'manual'
            AND ${othersExistSql('eg.id', 'eg.discord_server_id', '?')}
            AND NOT EXISTS (${officerSuccessorSql('eg.id', 'eg.discord_server_id', '?')}))`,
    params: [departingUserId, departingUserId, departingUserId],
  };
}
