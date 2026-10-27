// The daily retention jobs of the hierarchy build (plan "Retention jobs" + "Fix as we go" > B4a-code / retention). Each rule is its own D1 call in its own
// try/catch, so one failing rule never blocks the others. Never throws.
//   roster_syncs ........... older than 90 days, EXCEPT the row guilds.last_good_sync_id names (the dry-run token and the status page read it). No FK or
//                            cascade connects guild_roster to roster_syncs, so a hundred days of failed syncs delete nothing the roster or permissions need.
//   rate_limits ............ rows whose window started more than the longest window ago (LONGEST_WINDOW_MS): dead for every key.
//   fresh_act_markers ...... older than 15 minutes (the fresh-auth freshness window; a marker only has to outlive its own batch).
//   dry_run_approvals ...... consumed more than 30 days ago (or never consumed and expired more than 30 days ago).
//   oauth_state_nonces ..... older than their 10-minute TTL.
//   audit_log (prunable) ... the PRUNABLE set (worker/audit.js: per-person sync detail, failed Guild Master claims, fresh-auth failures) older than 180 days, plus an
//                            hour of margin so a clock skew between the Worker and D1 never makes the statement ask for a row migration 0034's trigger still
//                            protects. Every other audit row is permanent. First, the hours that saw several failures are written as ONE counted summary row
//                            each (audit.js flushFailureCounters) BEFORE the rate_limits rule drops their counters.
// guild_roster is NOT touched here and NOT by worker/bnet-purge.js: the in-game roster is the guild's own public roster data, kept while the guild lives.
import { AUDIT_PRUNE_AFTER_MS, PRUNABLE_ACTIONS, flushFailureCounters } from './audit.js';
import { countedRun } from './d1-changes.js';
import { defaultRandomBytes } from './ids.js';
import { LONGEST_WINDOW_MS } from './ratelimit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ROSTER_SYNC_KEEP_MS = 90 * DAY_MS;
export const FRESH_MARKER_KEEP_MS = 15 * 60 * 1000;
export const APPROVAL_KEEP_MS = 30 * DAY_MS;
// Never shorter than STATE_TTL_MS (worker/session.js, the validity window of an OAuth state): claimStateNonce stores created_at no earlier than the state's
// issue time, so a nonce row outlives its state and a replay is refused by the age check once the row is gone. Pinned by tests/guild/guild-b6a-oauth-tests.js.
export const OAUTH_NONCE_TTL_MS = 10 * 60 * 1000;
export const AUDIT_PRUNE_MARGIN_MS = 60 * 60 * 1000;
export const AUDIT_PRUNE_BATCH = 5000;

// name -> (nowMs) -> { sql, values }
export const RETENTION_RULES = {
  rosterSyncs: (now) => ({
    sql: `DELETE FROM roster_syncs WHERE started_at < ?
            AND NOT EXISTS (SELECT 1 FROM guilds g WHERE g.id = roster_syncs.guild_id AND g.last_good_sync_id = roster_syncs.id)`,
    values: [now - ROSTER_SYNC_KEEP_MS],
  }),
  rateLimits: (now) => ({ sql: 'DELETE FROM rate_limits WHERE window_start < ?', values: [now - LONGEST_WINDOW_MS] }),
  freshActMarkers: (now) => ({ sql: 'DELETE FROM fresh_act_markers WHERE at < ?', values: [now - FRESH_MARKER_KEEP_MS] }),
  dryRunApprovals: (now) => ({
    sql: 'DELETE FROM dry_run_approvals WHERE (used_at IS NOT NULL AND used_at < ?) OR (used_at IS NULL AND expires_at < ?)',
    values: [now - APPROVAL_KEEP_MS, now - APPROVAL_KEEP_MS],
  }),
  oauthStateNonces: (now) => ({ sql: 'DELETE FROM oauth_state_nonces WHERE created_at < ?', values: [now - OAUTH_NONCE_TTL_MS] }),
  auditPrunable: (now) => ({
    sql: `DELETE FROM audit_log WHERE id IN (
            SELECT id FROM audit_log WHERE action IN (${PRUNABLE_ACTIONS.map(() => '?').join(', ')}) AND created_at < ? ORDER BY created_at LIMIT ${AUDIT_PRUNE_BATCH})`,
    values: [...PRUNABLE_ACTIONS, now - AUDIT_PRUNE_AFTER_MS - AUDIT_PRUNE_MARGIN_MS],
  }),
};

// deps: { db, now, log, randomBytes? } -> { <rule>: rows deleted | null (the rule failed), failureSummaries: rows written | null }. Only a failure is logged: the daily run's log lines are pinned by tests and a
// routine delete is not news.
export async function runRetention({ db, now, log, randomBytes = defaultRandomBytes }) {
  const nowMs = now();
  const deleted = {};
  // First: it reads the counters the rateLimits rule below deletes.
  try {
    deleted.failureSummaries = await flushFailureCounters({ db, now, randomBytes });
  } catch (error) {
    deleted.failureSummaries = null;
    try { log(`retention: failureSummaries failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  for (const [name, rule] of Object.entries(RETENTION_RULES)) {
    try {
      const { sql, values } = rule(nowMs);
      deleted[name] = await countedRun(db, db.prepare(sql).bind(...values));
    } catch (error) {
      deleted[name] = null;
      try { log(`retention: ${name} failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    }
  }
  return deleted;
}
