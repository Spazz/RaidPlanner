// Dry-run approvals (user-hierarchy build, lane B4b; plan "Source/pin" > Dry-run approval). A change that rewrites many people at once (a rank-map edit now, the
// flip in lane B9) is first run DRY: the response lists what would change and carries a single-use token. The change itself is applied only by presenting that token.
//
//   the token      256 random bits, shown once; only its SHA-256 is stored (dry_run_approvals.token_hash)
//   bound to       the guild, the APPROVER's account, a state hash (what is being approved: see the caller), the stored roster's sync id, and 10 minutes
//   single use     consuming it is one guarded UPDATE (used_at IS NULL); the apply batch carries on only when that UPDATE changed a row
//   purpose        the state hash starts with the purpose ('rankmap:' here, 'flip:' for lane B9), so a token minted for one act is never valid for the other
// A token from another account, for another state, for another roster, expired or already used is refused (the caller answers 409 approval_invalid / approval_stale).
import { base64url } from './ids.js';
import { newSessionToken, hashToken } from './session.js';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

// -> { token, tokenHash } (the token goes to the approver once; the hash is what the database keeps).
export async function newApprovalToken(randomBytes) {
  const token = newSessionToken(randomBytes);
  return { token, tokenHash: await hashToken(token) };
}

// The roster sync id an approval binds to: the guild's last good sync, or '' before the first one.
export const rosterSyncIdOf = (guildRow) => (guildRow && guildRow.last_good_sync_id) || '';

// SQL for "the guild's stored roster is still the one the approval saw" (two placeholders: guild id, sync id; '' = no good sync yet).
export const SAME_ROSTER_SQL = `EXISTS (SELECT 1 FROM guilds WHERE id = ? AND COALESCE(last_good_sync_id, '') = ?)`;

// One statement for a db.batch: the approval row. The caller has already checked the approver may do the act.
export function insertApprovalStatement(db, { tokenHash, guildId, approverUserId, stateHash, rosterSyncId, now }) {
  return db.prepare(
    `INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(tokenHash, guildId, approverUserId, stateHash, rosterSyncId, now, now + APPROVAL_TTL_MS);
}

// -> the approval row for a presented token, or null.
export async function loadApproval(db, tokenHash) {
  return db.prepare(
    'SELECT token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at FROM dry_run_approvals WHERE token_hash = ?',
  ).bind(tokenHash).first();
}

// Why a loaded approval does not fit the act being asked for, or null when it does: 'invalid' (unknown, another guild, another account, used or expired:
// all one answer, so a presented token reveals nothing about someone else's) or 'stale' (it is the right account's live token, but the state it approved has
// moved on).
export function approvalProblem(row, { guildId, approverUserId, stateHash, rosterSyncId, now }) {
  if (!row || row.guild_id !== guildId || row.approver_user_id !== approverUserId || row.used_at !== null || row.expires_at <= now) return 'invalid';
  if (row.map_hash !== stateHash || row.roster_sync_id !== rosterSyncId) return 'stale';
  return null;
}

// One statement for a db.batch: consume the approval. Changes one row exactly when every binding still holds INSIDE the database (the approver, the state, the
// roster sync id, unused, unexpired, plus `extra`, e.g. the approver still holds the Owner seat). Every later statement of the act carries a marker written
// `WHERE changes() = 1` right after this one.
const CONSUME_SQL = `UPDATE dry_run_approvals SET used_at = ?
      WHERE token_hash = ? AND guild_id = ? AND approver_user_id = ? AND map_hash = ? AND roster_sync_id = ? AND used_at IS NULL AND expires_at > ?
        AND ${SAME_ROSTER_SQL}`;
export function consumeApprovalStatement(db, { tokenHash, guildId, approverUserId, stateHash, rosterSyncId, now }, extra = null) {
  const sql = extra ? `${CONSUME_SQL} AND ${extra.sql}` : CONSUME_SQL;
  return db.prepare(sql).bind(now, tokenHash, guildId, approverUserId, stateHash, rosterSyncId, now, guildId, rosterSyncId, ...(extra ? extra.params : []));
}

// One statement for a db.batch, right after consumeApprovalStatement: a marker row that exists only when the approval was consumed (changes() = 1). The act's
// other statements each carry `EXISTS (marker)`, so a refused or replayed token changes nothing at all. It uses fresh_act_markers (pruned after 15 minutes).
export function markerStatement(db, { markerId, tokenHash, purpose, now }) {
  return db.prepare('INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) SELECT ?, ?, ?, ? WHERE changes() = 1')
    .bind(markerId, tokenHash, purpose, now);
}

// { sql, params }: true once markerStatement wrote its row.
export const markerGuard = (markerId) => ({ sql: 'EXISTS (SELECT 1 FROM fresh_act_markers WHERE act_id = ?)', params: [markerId] });

// A fresh marker id for ONE request. Never derive it from the token: a replay would then find the first apply's marker and carry on.
export const newMarkerId = (randomBytes) => `am_${base64url(randomBytes(16))}`;
