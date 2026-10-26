import { HttpError } from './http.js';

export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60 * 1000;
export const IMPORT_LIMIT = 10;
export const IMPORT_WINDOW_MS = 10 * 60 * 1000;
// The idea box on the Future enhancements page (per user).
export const IDEA_LIMIT = 20;
export const IDEA_WINDOW_MS = 60 * 60 * 1000;
// Guild data exports (per user): a whole-guild read.
export const EXPORT_LIMIT = 5;
export const EXPORT_WINDOW_MS = 15 * 60 * 1000;
// Guild settings > Notifications "Send a test post" (per team): five an hour.
export const TEST_POST_LIMIT = 5;
export const TEST_POST_WINDOW_MS = 60 * 60 * 1000;
export const WCL_GLOBAL_LIMIT = 60;
export const WCL_GLOBAL_KEY = 'wcl:global';
// Raid report fetches and the backfill list (per user): one report per request, a backfill is a dozen of them.
export const WCL_RAID_LIMIT = 40;
export const WCL_RAID_WINDOW_MS = 10 * 60 * 1000;
// On-demand roster sync (per user): the per-guild once-an-hour interval is the lease's (worker/roster-sync.js); this caps one account's clicks.
export const ROSTER_SYNC_LIMIT = 6;
export const ROSTER_SYNC_WINDOW_MS = 60 * 60 * 1000;
// Rank-map dry runs (per Owner): each one reads every character of the guild and writes an approval token.
export const RANK_MAP_LIMIT = 10;
export const RANK_MAP_WINDOW_MS = 10 * 60 * 1000;
// The longest windowMs any caller passes (api keys, join and apply cookies, ideas, test posts, on-demand syncs: one hour). A rate_limits row whose window
// started longer ago than this is dead for every key, so the daily retention job (worker/retention.js) deletes it. A test pins that no *_WINDOW_MS
// constant in worker/ is longer; raising a window means raising this.
export const LONGEST_WINDOW_MS = 60 * 60 * 1000;
const UNAVAILABLE_RETRY_SECONDS = 30;

// Fixed window per key (default `w:<userId>`), one UPSERT ... RETURNING.
// Fails open (the default): if D1 errors, the request goes through. With failClosed the request is refused
// instead and the result says `unavailable`.
export async function checkRateLimit(db, userId, nowMs, { limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, key, failClosed = false } = {}) {
  try {
    const cutoff = nowMs - windowMs;
    const row = await db.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count, window_start`,
    ).bind(key || `w:${userId}`, nowMs, cutoff, cutoff, nowMs).first();
    if (!row || row.count <= limit) return { limited: false };
    return { limited: true, retryAfter: Math.max(1, Math.ceil((row.window_start + windowMs - nowMs) / 1000)) };
  } catch {
    return failClosed ? { limited: true, unavailable: true, retryAfter: UNAVAILABLE_RETRY_SECONDS } : { limited: false };
  }
}

// The 429 message depends on the window: import routes talk about imports.
export function rateLimitMessage(key) {
  if (/^idea:/.test(key)) return 'You have suggested a lot of ideas this hour. Come back a little later.';
  if (/^acct:/.test(key)) return 'Too many account look-ups. Wait a few minutes and try again.';
  if (/^exp:/.test(key)) return 'Too many guild data exports. Wait a few minutes and try again.';
  if (/^ntest:/.test(key)) return 'That team has had five test posts this hour. Try again later.';
  if (/^rsync:/.test(key)) return 'Too many roster syncs. Try again in a little while.';
  if (/^rmap:/.test(key)) return 'Too many rank map dry runs. Try again in a few minutes.';
  if (/^char:/.test(key)) return 'You have added a lot of characters this hour. Try again a little later.';
  if (/^open:/.test(key)) return 'You have signed up for a lot of open raids this hour. Try again a little later.';
  if (/^api:/.test(key)) return 'This key has reached its limit of 60 requests an hour. Try again later.';
  return /^(?:imp|wcl|wclraid):/.test(key)
    ? 'Too many imports. Wait a moment and try again.'
    : 'Too many changes in a minute. Wait a moment and try again.';
}

// Runs one window and throws the HttpError for a limited result (429, or 503 when the limiter itself failed closed).
export async function enforceRateLimit(db, userId, nowMs, options) {
  const result = await checkRateLimit(db, userId, nowMs, options);
  if (!result.limited) return;
  const key = options.key || `w:${userId}`;
  if (result.unavailable) {
    throw new HttpError(503, 'rate_limited', 'Imports are paused for a moment. Try again shortly.', { retryAfter: result.retryAfter });
  }
  if (key === WCL_GLOBAL_KEY) {
    const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
    throw new HttpError(429, 'rate_limited',
      `Warcraft Logs imports are busy for everyone right now. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      { retryAfter: result.retryAfter });
  }
  throw new HttpError(429, 'rate_limited', rateLimitMessage(key), { retryAfter: result.retryAfter });
}
