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
// Flip dry runs (per Owner): each one reads every account and person of the guild and writes an approval token.
export const FLIP_DRY_RUN_LIMIT = 10;
export const FLIP_DRY_RUN_WINDOW_MS = 10 * 60 * 1000;
// The Users list and a user's page (GET /api/guild/:gid/users and /users/:ukey, per user, one key for both): a page of the list is a few statements, so the limit sits far above
// what a person paging and sorting reaches (a request every half second for a minute) and below a script that walks the list.
export const USERS_LIMIT = 120;
export const USERS_WINDOW_MS = 60 * 1000;
export const usersKey = (userId) => `users:${userId}`;
// Battle.net OAuth callbacks (worker/routes/bnet.js), checked after the token exchange and user info, before the snapshot fan-out of Blizzard calls.
// Per Blizzard account id: a limit that answers 'busy'. Global: a budget that NEVER refuses (a gate would let a few accounts stop everyone); the callback
// that takes the window's count past it logs one ALARM line for the operator.
export const BNET_CALLBACK_LIMIT = 10;
export const BNET_CALLBACK_WINDOW_MS = 10 * 60 * 1000;
export const BNET_CALLBACK_BUDGET = 300;
export const BNET_CALLBACK_BUDGET_KEY = 'bnetcb:global';
export const bnetCallbackKey = (bnetAccountId) => `bnetcb:${bnetAccountId}`;
// The longest windowMs any caller passes (api keys, join and apply cookies, ideas, test posts, on-demand syncs: one hour). A rate_limits row whose window
// started longer ago than this is dead for every key, so the daily retention job (worker/retention.js) deletes it. A test pins that no *_WINDOW_MS
// constant in worker/ is longer; raising a window means raising this.
export const LONGEST_WINDOW_MS = 60 * 60 * 1000;
const UNAVAILABLE_RETRY_SECONDS = 30;

// Counts one hit into the key's fixed window (a new window starts once the old one is windowMs old): one UPSERT ... RETURNING -> { count, window_start }.
function bumpWindow(db, key, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  return db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
     RETURNING count, window_start`,
  ).bind(key, nowMs, cutoff, cutoff, nowMs).first();
}

// Fixed window per key (default `w:<userId>`), one UPSERT ... RETURNING.
// Fails open (the default): if D1 errors, the request goes through. With failClosed the request is refused
// instead and the result says `unavailable`.
export async function checkRateLimit(db, userId, nowMs, { limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, key, failClosed = false } = {}) {
  try {
    const row = await bumpWindow(db, key || `w:${userId}`, nowMs, windowMs);
    if (!row || row.count <= limit) return { limited: false };
    return { limited: true, retryAfter: Math.max(1, Math.ceil((row.window_start + windowMs - nowMs) / 1000)) };
  } catch {
    return failClosed ? { limited: true, unavailable: true, retryAfter: UNAVAILABLE_RETRY_SECONDS } : { limited: false };
  }
}

// A budget that never refuses: counts into the same fixed window as checkRateLimit and says when it has run out -> { spent, alarm }. spent: this window's
// count is past `limit`. alarm: true for exactly ONE call per window (the first past the limit), so the caller can log one operator line per window.
// If D1 errors the budget is not spent (it is a tripwire, never a gate).
export async function spendBudget(db, nowMs, { key, limit, windowMs }) {
  try {
    const row = await bumpWindow(db, key, nowMs, windowMs);
    if (!row) return { spent: false, alarm: false };
    return { spent: row.count > limit, alarm: row.count === limit + 1 };
  } catch {
    return { spent: false, alarm: false };
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
  if (/^users:/.test(key)) return 'Too many look-ups of the users list. Wait a moment and try again.';
  if (/^flip:/.test(key)) return 'Too many flip dry runs. Try again in a few minutes.';
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
