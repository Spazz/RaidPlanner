// The daily retention jobs of the hierarchy build (plan "Retention jobs" + "Fix as we go" > B4a-code / retention). Each rule is its own D1 call in its own
// try/catch, so one failing rule never blocks the others. Never throws.
//   roster_syncs ........... older than 90 days, EXCEPT the row guilds.last_good_sync_id names (the dry-run token and the status page read it). No FK or
//                            cascade connects guild_roster to roster_syncs, so a hundred days of failed syncs delete nothing the roster or permissions need.
//   rate_limits ............ rows whose window started more than the longest window ago (LONGEST_WINDOW_MS): dead for every key.
//   fresh_act_markers ...... older than 15 minutes (the fresh-auth freshness window; a marker only has to outlive its own batch).
//   dry_run_approvals ...... consumed more than 30 days ago (or never consumed and expired more than 30 days ago).
//   oauth_state_nonces ..... older than their 10-minute TTL.
// guild_roster is NOT touched here and NOT by worker/bnet-purge.js: the in-game roster is the guild's own public roster data, kept while the guild lives.
import { LONGEST_WINDOW_MS } from './ratelimit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ROSTER_SYNC_KEEP_MS = 90 * DAY_MS;
export const FRESH_MARKER_KEEP_MS = 15 * 60 * 1000;
export const APPROVAL_KEEP_MS = 30 * DAY_MS;
// Never shorter than STATE_TTL_MS (worker/session.js, the validity window of an OAuth state): claimStateNonce stores created_at no earlier than the state's
// issue time, so a nonce row outlives its state and a replay is refused by the age check once the row is gone. Pinned by tests/guild/guild-b6a-oauth-tests.js.
export const OAUTH_NONCE_TTL_MS = 10 * 60 * 1000;

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
};

// deps: { db, now, log } -> { <rule>: rows deleted | null (the rule failed) }. Only a failure is logged: the daily run's log lines are pinned by tests and a
// routine delete is not news.
export async function runRetention({ db, now, log }) {
  const nowMs = now();
  const deleted = {};
  for (const [name, rule] of Object.entries(RETENTION_RULES)) {
    try {
      const { sql, values } = rule(nowMs);
      deleted[name] = (await db.prepare(sql).bind(...values).run()).meta.changes;
    } catch (error) {
      deleted[name] = null;
      try { log(`retention: ${name} failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    }
  }
  return deleted;
}
