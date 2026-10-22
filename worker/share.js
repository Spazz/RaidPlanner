// Live share links (migration 0028, table share_links): stores a plan's share code under a random 7-character id so the Planner can hand out
// /<version>/<id>. Anyone holding the link can update it; the latest save wins. This is the port of the old Vercel function (api/share.js) with
// the same request and response shapes, so js/app.js and js/guild/plan-source.js are unchanged.
//
//   POST /api/share   body {"code"}         -> 201 {"id", "updatedAt"}
//   PUT  /api/share   body {"id", "code"}   -> 200 {"updatedAt"} | 404 (never creates an ID)
//   GET  /api/share?id=<id>                 -> 200 {"code", "updatedAt"} | 404
//
// Errors are {"error": "<sentence>"} (the Planner shows that sentence), not the guild API's {error, message} pair.
// Links expire 30 days after their last save (a read does not extend them); the daily cron deletes expired rows (sweepShareLinks).
//
// Per-IP fixed-window rate limit in the existing D1 `rate_limits` table (writes and reads have separate budgets): over budget -> 429 with
// Retry-After. The client IP is Cloudflare's CF-Connecting-IP; without it the request is not limited. The key holds a SHA-256 prefix of the IP,
// never the address itself (rate_limits promises "no IP addresses are stored"). If the limiter itself fails the request goes through (fail open).
//
// POST/PUT only take a JSON Content-Type (else 415) and a JSON object body (else 400), and refuse a cross-site request (403).
import { HttpError, hasJsonContentType, isCrossSite, jsonResponse, readJsonBody } from './http.js';
import { checkRateLimit } from './ratelimit.js';

export const SHARE_PATH = '/api/share';
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CODE_LENGTH = 32 * 1024;
export const RATE_WINDOW_MS = 60 * 1000;
export const RATE_LIMITS = { write: 60, read: 240 }; // requests per IP per window; a polling tab reads 4/min
export const RATE_SWEEP_AGE_MS = 10 * 60 * 1000;
const ID_LENGTH = 7;
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_ID_ATTEMPTS = 5;
const MAX_BODY_BYTES = MAX_CODE_LENGTH + 1024;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = new RegExp(`^[0-9A-Za-z]{${ID_LENGTH}}$`);
// Example paths of what the Worker answers outside ROUTES (tests/guild/guild-config-tests.js checks run_worker_first against ROUTES plus these).
export const WORKER_PATHS = [SHARE_PATH, `${SHARE_PATH}/x`, '/tbc/x', '/classic/x', '/forever/x'];
const SPA_PATH = /^\/(?:tbc|classic|forever)\/[^/]+$/;

const reply = (status, body, headers) => jsonResponse(body, status, headers);

// Rejection sampling keeps every character equally likely (256 % 62 != 0).
export function generateId(randomBytes) {
  const limit = 256 - (256 % ID_ALPHABET.length);
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(ID_LENGTH * 2)) {
      if (byte >= limit) continue;
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (id.length === ID_LENGTH) break;
    }
  }
  return id;
}

const validCode = (code) => typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_LENGTH && CODE_PATTERN.test(code);
const validId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

async function ipKey(ip) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function limited(deps, request) {
  const ip = (request.headers.get('CF-Connecting-IP') || '').trim().slice(0, 64);
  if (!ip) return null;
  const budget = request.method === 'GET' ? 'read' : 'write';
  const result = await checkRateLimit(deps.db, null, deps.now(), {
    key: `share:${budget}:${await ipKey(ip)}`, limit: deps.limits[budget], windowMs: RATE_WINDOW_MS,
  });
  return result.limited ? result.retryAfter : null;
}

async function create(deps, body) {
  if (!validCode(body.code)) return reply(400, { error: 'Invalid share code' });
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId(deps.randomBytes);
    const updatedAt = deps.now();
    // Never overwrite a live link if two IDs collide; an expired row that the sweep has not removed yet is free to take.
    const result = await deps.db.prepare(
      `INSERT INTO share_links (id, code, updated_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at, expires_at = excluded.expires_at
         WHERE share_links.expires_at <= excluded.updated_at`,
    ).bind(id, body.code, updatedAt, updatedAt + TTL_MS).run();
    if (result.meta.changes === 1) return reply(201, { id, updatedAt });
  }
  return reply(503, { error: 'Could not allocate a link ID' });
}

// Overwrites an existing link and restarts its 30-day clock. An unknown or expired ID is 404 and is never created here, so a caller cannot pick an
// ID; the client POSTs a fresh link instead.
async function update(deps, body) {
  if (!validId(body.id)) return reply(400, { error: 'Invalid link ID' });
  if (!validCode(body.code)) return reply(400, { error: 'Invalid share code' });
  const updatedAt = deps.now();
  const result = await deps.db.prepare('UPDATE share_links SET code = ?, updated_at = ?, expires_at = ? WHERE id = ? AND expires_at > ?')
    .bind(body.code, updatedAt, updatedAt + TTL_MS, body.id, updatedAt).run();
  if (result.meta.changes !== 1) return reply(404, { error: 'Link not found or expired' });
  return reply(200, { updatedAt });
}

async function read(deps, id) {
  if (!validId(id)) return reply(400, { error: 'Invalid link ID' });
  const row = await deps.db.prepare('SELECT code, updated_at FROM share_links WHERE id = ? AND expires_at > ?').bind(id, deps.now()).first();
  if (!row) return reply(404, { error: 'Link not found or expired' });
  return reply(200, { code: row.code, updatedAt: row.updated_at });
}

// deps: { db, now, randomBytes, log, limits? }. Never throws.
export async function handleShare(deps, request) {
  const method = request.method;
  if (!['GET', 'POST', 'PUT'].includes(method)) return reply(405, { error: 'Method not allowed' }, { Allow: 'GET, POST, PUT' });
  const handlerDeps = { ...deps, limits: { ...RATE_LIMITS, ...deps.limits } };
  try {
    if (method !== 'GET') {
      if (isCrossSite(request)) return reply(403, { error: 'Cross-site requests are not allowed' });
      if (!hasJsonContentType(request)) return reply(415, { error: 'Content-Type must be application/json' });
    }
    const retryAfter = await limited(handlerDeps, request);
    if (retryAfter !== null) return reply(429, { error: 'Too many requests', retryAfter }, { 'Retry-After': String(retryAfter) });
    if (method === 'GET') return await read(handlerDeps, new URL(request.url).searchParams.get('id'));
    let body;
    try {
      body = await readJsonBody(request, MAX_BODY_BYTES);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return reply(error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'Body too large' : 'Body must be a JSON object' });
    }
    return await (method === 'POST' ? create : update)(handlerDeps, body);
  } catch (error) {
    try { deps.log(`share: ${error && error.message}`); } catch { /* logging must not throw */ }
    return reply(503, { error: 'Short links are unavailable' });
  }
}

// GET /<version>/<id> is the Planner page (what vercel.json's rewrite did): the Worker answers it with the site's front page.
export function isSharePagePath(request) {
  return (request.method === 'GET' || request.method === 'HEAD') && SPA_PATH.test(new URL(request.url).pathname);
}

export function servePlannerPage(request, env) {
  return env.ASSETS.fetch(new Request(new URL('/', request.url), { method: request.method, headers: request.headers }));
}

// The daily cron: links 30 days past their last save, and the rate-limit rows of past windows. -> { links, limits }
export async function sweepShareLinks(db, nowMs) {
  const results = await db.batch([
    db.prepare('DELETE FROM share_links WHERE expires_at <= ?').bind(nowMs),
    db.prepare("DELETE FROM rate_limits WHERE key LIKE 'share:%' AND window_start <= ?").bind(nowMs - RATE_SWEEP_AGE_MS),
  ]);
  return { links: results[0].meta.changes, limits: results[1].meta.changes };
}
