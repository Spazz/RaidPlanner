// The Worker's two Cron Triggers (wrangler.jsonc triggers.crons), one dispatcher. The `scheduled` handler in worker/index.js hands the event's cron string here.
//   17 4 * * *     daily: the 30-day rule for Battle.net data (worker/bnet-purge.js), then the notification log's 90-day prune, then the expired share links,
//                  then the hierarchy retention jobs (worker/retention.js: roster sync log, rate limits, fresh-auth markers, dry-run approvals, OAuth nonces, the
//                  prunable audit rows and the failure summaries), then the tombstone repair (worker/block-tombstones.js: the R4 backfill of blocks that have no tombstones).
//   */15 * * * *   every 15 minutes: the Raid-Helper refresh of upcoming raids (worker/event-refresh.js), THEN the Discord posts (worker/notify-run.js), so a
//                  reminder is built from sign-ups that are at most a refresh old. Each run is bounded (see worker/notify.js) and every message is once-only
//                  (notification_log), so a run that is repeated, overlapping or retried by Cloudflare sends nothing twice. The Logger's nudge (wave 8: a raid
//                  with a named Logger and no report 5 hours after its start) is one more message kind of the same run. LAST, in its own try/catch (so a failure in the
//                  half above never skips it, and it never skips them): the in-game roster sync of every pinned guild that is due (worker/roster-sync.js; dormant
//                  while no guild has a pin).
// Locally the dev tool starts Wrangler with --test-scheduled:  curl "http://127.0.0.1:<port>/__scheduled?cron=*/15+*+*+*+*"
// An unknown cron string does nothing but log a line (it used to run the daily work, which would have run the 90-day retention on a typo'd trigger).
import { runScheduled as runBnetPurge } from './bnet-purge.js';
import { repairTombstones } from './block-tombstones.js';
import { refreshDueEvents } from './event-refresh.js';
import { runNotifications } from './notify-run.js';
import { pruneNotificationLog } from './notify-store.js';
import { runRetention } from './retention.js';
import { runRosterSyncs } from './roster-sync.js';
import { sweepShareLinks } from './share.js';

export const DAILY_CRON = '17 4 * * *';
export const FREQUENT_CRON = '*/15 * * * *';

// deps: { db, env, fetch, now, randomBytes, log }. Never throws.
export async function runDaily(deps) {
  const purged = await runBnetPurge({ db: deps.db, now: deps.now, log: deps.log });
  try {
    await pruneNotificationLog(deps.db, deps.now());
  } catch (error) {
    try { deps.log(`notification log prune failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  try {
    await sweepShareLinks(deps.db, deps.now());
  } catch (error) {
    try { deps.log(`share link sweep failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  await runRetention({ db: deps.db, now: deps.now, log: deps.log, randomBytes: deps.randomBytes });
  // Never throws. Needs TOMBSTONE_KEY (the Worker env): without it the repair logs one operator line and leaves the blocks flagged.
  await repairTombstones({ db: deps.db, env: deps.env, now: deps.now, log: deps.log });
  return purged;
}

// The roster sync half of the 15-minute run: -> its summary ({ attempted, applied, unchanged, failed, superseded }), or null when it failed. Logs one line
// only when it attempted a guild, so a platform with no pinned guild logs nothing.
export async function runRosterSyncHalf(deps) {
  try {
    const summary = await runRosterSyncs(deps);
    if (summary.attempted) {
      deps.log(`roster sync: ${summary.attempted} guild${summary.attempted === 1 ? '' : 's'} attempted, ${summary.applied} replaced, ${summary.unchanged} unchanged, ${summary.failed + summary.superseded} not applied`);
    }
    return summary;
  } catch (error) {
    try { deps.log(`roster sync run failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}

// -> { refresh, posts } (what the Discord half did), or null when it failed. The roster sync half runs either way and reports through the log.
export async function runFrequent(deps) {
  let halves = null;
  try {
    const refresh = await refreshDueEvents(deps);
    const posts = await runNotifications(deps);
    deps.log(`scheduler: ${refresh.refreshed} event${refresh.refreshed === 1 ? '' : 's'} refreshed (${refresh.moved} on another day), ${posts.sent} post${posts.sent === 1 ? '' : 's'} sent`);
    halves = { refresh, posts };
  } catch (error) {
    try { deps.log(`scheduler failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  await runRosterSyncHalf(deps);
  return halves;
}

export function runCron(deps) {
  if (deps.cron === FREQUENT_CRON) return runFrequent(deps);
  if (deps.cron === DAILY_CRON) return runDaily(deps);
  try { deps.log(`scheduler: unknown cron "${String(deps.cron).slice(0, 40)}" ignored`); } catch { /* logging must not throw */ }
  return Promise.resolve(null);
}
