import { newId } from './ids.js';
import { ownerSql } from './owner.js';

// The audited actions (nothing else writes the log).
export const AUDIT_ACTIONS = [
  'guild.create',
  'guild.update',
  'team.create',
  'team.rename',
  'team.archive',
  'team.restore',
  'roles.set',
  'guild_master.transfer',
  'access.remove',
  'access.restore',
  'account.delete',
  'guild.delete',
  'guild.export',
  'guild.claim',
  'guild_master.auto_promote',
  'person.create',
  'person.update',
  'person.delete',
  'person.notes',
  'character.create',
  'character.update',
  'character.delete',
  'character.main',
  'character.place',
  'character.release',
  'character.move',
  'team_request.create',
  'team_request.withdraw',
  'team_request.approve',
  'team_request.reject',
  'roster.import',
  'raid.create',
  'raid.delete',
  'raid.event',
  'raid.report',
  'raid.plan',
  'raid.plan_edit',
  'raid.manual',
  'attendance.decide',
  'attendance.undo',
  'attendance.link',
  'attendance.guest',
  'policy.update',
  'wcl.settings',
  'loot.import',
  'loot.update',
  'loot.delete',
  'loot.list',
  'loot.add',
  'loot.policy',
  'bnet.link',
  'bnet.unlink',
  'discord.link',
  'discord.unlink',
  'person.account_link',
  'person.account_unlink',
  'bnet.settings',
  'rank_map.update',
  'claim.create',
  'claim.withdraw',
  'claim.approve',
  'claim.reject',
  'character.claim',
  'signup.set',
  'signup.remove',
  'signup.link',
  'signup.lock',
  'schedule.update',
  'schedule.fill',
  'role.create',
  'role.update',
  'role.delete',
  'role.reset',
  'discord.maps',
  'roles.discord_sync',
  'guest.create',
  'guest.revoke',
  'public.update',
  'team.size',
  'team.trial_days',
  'raid.settings',
  'roster.publish',
  'roster.unpublish',
  'roster.decline',
  'away.set',
  'away.remove',
  'intent.open',
  'intent.close',
  'intent.pick',
  'intent.unpick',
  'recruiting.targets',
  'apply.settings',
  'application.submit',
  'application.update',
  'application.accept',
  'application.delete',
  'notify.update',
  'notify.disabled',
  'notify.test',
  'apikey.create',
  'apikey.revoke',
  'person.rank',
  'rank.dismiss',
  'duties.set',
  'launch.update',
  'launch.team',
  'attention.dismiss',
  'attention.restore',
  'join.create',
  'join.revoke',
  'signup.guest',
  'signup.guest_remove',
  'signup.guest_resolve',
  'signup.guests_clear',
  'signup.open',
  'signup.open_withdraw',
  'person.join',
  'character.match_roster',
  // Lane B7a: blocks and tombstones, and the rows the prune/coalesce rules know by name (PRUNABLE_ACTIONS below).
  'person.block',
  'person.unblock',
  'block.match',
  'block.match_held',
  'person.core_rank',
  'person.ingame_rank',
  'person.former',
  'guild.claim_failed',
  'fresh.failed',
];

// The PRUNABLE set (plan "Audit"): per-person detail of a sync run and failures. The daily job deletes these past AUDIT_PRUNE_AFTER_MS; every other row is
// permanent. migrations/0034_audit_log_trigger.sql repeats the list (the trigger refuses a delete outside it) and a test keeps the two equal.
export const PRUNABLE_ACTIONS = Object.freeze(['person.core_rank', 'person.ingame_rank', 'person.former', 'guild.claim_failed', 'fresh.failed']);
export const AUDIT_PRUNE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
// The failures that coalesce to one counted row per user, guild and hour (failureAuditStatements).
export const COALESCED_FAILURE_ACTIONS = Object.freeze(['fresh.failed', 'guild.claim_failed']);
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

const COLUMNS = 'id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role';

// The actor snapshot of a row (migration 0031 columns), computed by the INSERT itself so it holds what the database says when the row is written:
//   actor_short_id  the first 8 characters of the id after its prefix (u_ab12CD34...): enough to tell two former members apart, nothing to look up
//   actor_role      'owner' (the Owner seat, worker/owner.js), else the best built-in role the actor holds in the row's guild (guild_master, officer,
//                   team_lead), else 'member'; NULL for a row with no actor or no guild (an account's own sign-in)
// Both survive the account's deletion (the foreign key sets actor_user_id NULL). Placeholders in order: actor | actor, guild | guild, actor, actor | guild, actor.
const SNAPSHOT_SQL = `substr(?, 3, 8),
  CASE WHEN ? IS NULL OR ? IS NULL THEN NULL
       WHEN ${ownerSql('?', '?')} THEN 'owner'
       ELSE COALESCE((SELECT ra.role_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                       WHERE ra.guild_id = ? AND ra.user_id = ? AND ra.role_id IN ('guild_master', 'officer', 'team_lead') ORDER BY r.rank LIMIT 1), 'member') END`;
const snapshotParams = (actorUserId, guildId) => [actorUserId, actorUserId, guildId, guildId, actorUserId, actorUserId, guildId, actorUserId];

// The audit INSERT, ready to go into the same DB.batch as the write it describes.
// before/after hold internal IDs and flags only. A guard ({ sql, params }) makes the row
// conditional (it is written only when the guarded write applied).
export function auditStatement({ db, randomBytes, now }, entry, guard = null) {
  const actorUserId = entry.actorUserId ?? null;
  const guildId = entry.guildId ?? null;
  const values = [
    newId('al', randomBytes),
    guildId,
    actorUserId,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    now(),
  ];
  const where = guard ? ` WHERE ${guard.sql}` : '';
  return db.prepare(`INSERT INTO audit_log (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SNAPSHOT_SQL}${where}`)
    .bind(...values, ...snapshotParams(actorUserId, guildId), ...(guard ? guard.params : []));
}

// ---------------------------------------------------------------------------
// Failure coalescing (plan "Audit": repeated failures by one user in one guild become ONE counted row per hour)
//
// audit_log rows are never updated (migrations/0034), so the count cannot live in the row. The first failure of an hour inserts the row (count 1); every
// failure bumps a counter in rate_limits (key auditfail:<action>:<guild>:<user>:<hour>); the daily retention job (flushFailureCounters, called by
// worker/retention.js) writes ONE summary row per hour that saw more than one failure ({ count, windowStart, coalesced: true }) and drops the counter. So an
// attacker who fails ten thousand times in an hour leaves two rows, not ten thousand.
export const FAILURE_KEY_PREFIX = 'auditfail:';
export const failureCounterKey = (action, guildId, userId, bucket) => `${FAILURE_KEY_PREFIX}${action}:${guildId}:${userId}:${bucket}`;

// -> two statements for the caller's batch (the refusal itself is thrown after the batch). ctx: { db, randomBytes, now }.
export function failureAuditStatements(ctx, { guildId, userId, action, detail = null }) {
  if (!COALESCED_FAILURE_ACTIONS.includes(action)) throw new Error(`failureAuditStatements: ${action} is not a coalesced failure action`);
  if (!guildId || !userId) throw new Error('failureAuditStatements: a guild and a user are required');
  const bucket = Math.floor(ctx.now() / FAILURE_WINDOW_MS);
  const windowStart = bucket * FAILURE_WINDOW_MS;
  const key = failureCounterKey(action, guildId, userId, bucket);
  return [
    ctx.db.prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1',
    ).bind(key, windowStart),
    auditStatement(ctx, {
      guildId, actorUserId: userId, action, entityType: 'user', entityId: userId, after: { count: 1, windowStart, ...(detail ? { detail } : {}) },
    }, { sql: '(SELECT count FROM rate_limits WHERE key = ?) = 1', params: [key] }),
  ];
}

// The summary rows of the hours that saw more than one failure, for the daily job. deps: { db, now, randomBytes } -> number of summaries written.
export async function flushFailureCounters({ db, now, randomBytes }) {
  const nowMs = now();
  const due = await db.prepare(
    `SELECT key, window_start, count FROM rate_limits WHERE substr(key, 1, ${FAILURE_KEY_PREFIX.length}) = ? AND window_start <= ? ORDER BY window_start, key LIMIT 500`,
  ).bind(FAILURE_KEY_PREFIX, nowMs - FAILURE_WINDOW_MS).all();
  let written = 0;
  for (const row of due.results) {
    const [action, guildId, userId] = row.key.slice(FAILURE_KEY_PREFIX.length).split(':');
    const statements = [];
    if (row.count > 1 && COALESCED_FAILURE_ACTIONS.includes(action) && guildId && userId) {
      // The guild must still exist (its rows cascade away with it); the account may be gone since: the actor is then NULL and the id stays as entity_id.
      statements.push(db.prepare(
        `INSERT INTO audit_log (${COLUMNS})
         SELECT ?, g.id, (SELECT u.id FROM users u WHERE u.id = ?), ?, 'user', ?, NULL, ?, ?, substr(?, 3, 8), NULL FROM guilds g WHERE g.id = ?`,
      ).bind(newId('al', randomBytes), userId, action, userId, JSON.stringify({ count: row.count, windowStart: row.window_start, coalesced: true }),
        row.window_start + FAILURE_WINDOW_MS - 1, userId, guildId));
    }
    statements.push(db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(row.key));
    const results = await db.batch(statements);
    if (statements.length === 2 && results[0].meta.changes === 1) written++;
  }
  return written;
}
