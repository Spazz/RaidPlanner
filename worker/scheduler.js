// The Worker's two Cron Triggers (wrangler.jsonc triggers.crons), one dispatcher. The `scheduled` handler in worker/index.js hands the event's cron string here.
//   17 4 * * *     daily: the 30-day rule for Battle.net data (worker/bnet-purge.js), then the notification log's 90-day prune.
//   */15 * * * *   every 15 minutes: the Raid-Helper refresh of upcoming raids (worker/event-refresh.js), THEN the Discord posts (worker/notify-run.js), so a
//                  reminder is built from sign-ups that are at most a refresh old. Each run is bounded (see worker/notify.js) and every message is once-only
//                  (notification_log), so a run that is repeated, overlapping or retried by Cloudflare sends nothing twice.
// Locally the dev tool starts Wrangler with --test-scheduled:  curl "http://127.0.0.1:<port>/__scheduled?cron=*/15+*+*+*+*"
// An unknown cron string runs the daily work (what the only trigger did before this one existed).
import { runScheduled as runBnetPurge } from './bnet-purge.js';
import { refreshDueEvents } from './event-refresh.js';
import { runNotifications } from './notify-run.js';
import { pruneNotificationLog } from './notify-store.js';

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
  return purged;
}

// -> { refresh, posts } (what each half did), or null when the run itself failed.
export async function runFrequent(deps) {
  try {
    const refresh = await refreshDueEvents(deps);
    const posts = await runNotifications(deps);
    deps.log(`scheduler: ${refresh.refreshed} event${refresh.refreshed === 1 ? '' : 's'} refreshed (${refresh.moved} on another day), ${posts.sent} post${posts.sent === 1 ? '' : 's'} sent`);
    return { refresh, posts };
  } catch (error) {
    try { deps.log(`scheduler failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}

export function runCron(deps) {
  return deps.cron === FREQUENT_CRON ? runFrequent(deps) : runDaily(deps);
}
