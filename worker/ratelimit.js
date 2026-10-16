import { HttpError } from './http.js';

export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60 * 1000;
export const IMPORT_LIMIT = 10;
export const IMPORT_WINDOW_MS = 10 * 60 * 1000;
export const WCL_GLOBAL_LIMIT = 60;
export const WCL_GLOBAL_KEY = 'wcl:global';
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
  return /^(?:imp|wcl):/.test(key)
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
  throw new HttpError(429, 'rate_limited', rateLimitMessage(key), { retryAfter: result.retryAfter });
}
