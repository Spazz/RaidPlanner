export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60 * 1000;

// Fixed window per user, one UPSERT ... RETURNING. Fails open: if D1 errors, the request goes through.
export async function checkRateLimit(db, userId, nowMs, { limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS } = {}) {
  try {
    const cutoff = nowMs - windowMs;
    const row = await db.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count, window_start`,
    ).bind(`w:${userId}`, nowMs, cutoff, cutoff, nowMs).first();
    if (!row || row.count <= limit) return { limited: false };
    return { limited: true, retryAfter: Math.max(1, Math.ceil((row.window_start + windowMs - nowMs) / 1000)) };
  } catch {
    return { limited: false };
  }
}
