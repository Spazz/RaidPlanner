// Live share links: stores a plan's share code under a random ID so the
// planner can hand out /<version>/<id> instead of the full #r=<code> fragment.
// Anyone holding the link can update it; the latest save wins.
//
//   POST /api/share   body {"code"}         -> 201 {"id", "updatedAt"}
//   PUT  /api/share   body {"id", "code"}   -> 200 {"updatedAt"} | 404 (never creates an ID)
//   GET  /api/share?id=<id>                 -> 200 {"code", "updatedAt"} | 404
//
// Backed by Upstash Redis over its REST API (plain fetch, no dependencies).
// Links expire 30 days after their last save. The token never leaves this
// function.
//
// Per-IP fixed-window rate limit (writes and reads have separate budgets):
// over budget -> 429 with Retry-After. The client IP is the first
// x-forwarded-for hop (Vercel sets it; it does not pass a client-supplied
// value through), else x-real-ip; without either the request is not limited.
// If the limiter itself fails the request goes through (fail open).
//
// POST/PUT only take a JSON Content-Type (else 415) and a JSON object body
// (else 400), and refuse a cross-site Origin (403): the Origin host must equal
// the request's Host header, which also admits Vercel preview hosts. Requests
// without an Origin header (curl, same-origin GETs) pass.

const crypto = require('crypto');

const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CODE_LENGTH = 32 * 1024;
const ID_LENGTH = 7;
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_ID_ATTEMPTS = 5;
const KEY_PREFIX = 'pp:share:';
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMITS = { write: 60, read: 240 }; // requests per IP per window; a polling tab reads 4/min
const RATE_KEY_PREFIX = 'pp:rl:';
const MAX_IP_LENGTH = 64;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = new RegExp(`^[0-9A-Za-z]{${ID_LENGTH}}$`);

// Rejection sampling keeps every character equally likely (256 % 62 != 0).
function generateId(randomBytes) {
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

function createRedis(env, fetchImpl) {
  const url = env.PP_KV_REST_API_URL;
  const token = env.PP_KV_REST_API_TOKEN;
  if (!url || !token) return null;

  async function command(args) {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(`Redis ${args[0]} failed (${resp.status})`);
    return data.result;
  };

  // Several commands in one round trip -> an array of results.
  command.pipeline = async function pipeline(commands) {
    const resp = await fetchImpl(url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !Array.isArray(data) || data.length !== commands.length || data.some(item => !item || item.error)) {
      throw new Error(`Redis pipeline failed (${resp.status})`);
    }
    return data.map(item => item.result);
  };

  return command;
}

function clientIp(req) {
  const headers = (req && req.headers) || {};
  const first = value => (Array.isArray(value) ? value[0] : value);
  const forwarded = first(headers['x-forwarded-for']);
  const candidate = (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || first(headers['x-real-ip']);
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, MAX_IP_LENGTH) : null;
}

// Fixed window: one counter per (budget, IP, window number). INCR + EXPIRE go
// out as one pipeline; the key rotates every window, so re-arming the expiry
// on each hit cannot stretch a window. Resolves to {limited, retryAfter}.
async function checkRateLimit(redis, req, deps) {
  const ip = clientIp(req);
  if (!ip) return { limited: false };
  const budget = req.method === 'GET' ? 'read' : 'write';
  const windowMs = RATE_WINDOW_SECONDS * 1000;
  const now = deps.now();
  const key = `${RATE_KEY_PREFIX}${budget}:${ip}:${Math.floor(now / windowMs)}`;
  const [count] = await redis.pipeline([['INCR', key], ['EXPIRE', key, String(RATE_WINDOW_SECONDS)]]);
  if (!(Number(count) > deps.limits[budget])) return { limited: false };
  return { limited: true, retryAfter: Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)) };
}

// The request body as a plain object, or null for anything else (a JSON array,
// string, number or null, or text that is not JSON).
function parseBody(body) {
  let value = body;
  if (typeof body === 'string') {
    try { value = JSON.parse(body); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function headerValue(req, name) {
  const value = ((req && req.headers) || {})[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasJsonContentType(req) {
  const type = headerValue(req, 'content-type');
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type.trim());
}

// True when the request carries no Origin header or one naming this host.
function isSameSiteOrigin(req) {
  const origin = headerValue(req, 'origin');
  if (origin === undefined) return true;
  const host = headerValue(req, 'host');
  if (typeof origin !== 'string' || typeof host !== 'string' || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.trim().toLowerCase(); } catch { return false; }
}

function validCode(code) {
  return typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_LENGTH && CODE_PATTERN.test(code);
}

function validId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// Stored as JSON {code, updatedAt}. Links created before live updates hold a
// bare share code; those read back with updatedAt 0.
function parseStored(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('{')) {
    try {
      const value = JSON.parse(raw);
      return validCode(value.code) ? { code: value.code, updatedAt: Number(value.updatedAt) || 0 } : null;
    } catch { return null; }
  }
  return validCode(raw) ? { code: raw, updatedAt: 0 } : null;
}

// condition: 'NX' (only if absent), 'XX' (only if present) or none.
function store(redis, id, code, updatedAt, condition) {
  const args = ['SET', KEY_PREFIX + id, JSON.stringify({ code, updatedAt }), 'EX', String(TTL_SECONDS)];
  if (condition) args.push(condition);
  return redis(args);
}

async function handleCreate(req, res, redis, deps) {
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: 'Body must be a JSON object' });
  const { code } = body;
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid share code' });

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId(deps.randomBytes);
    const updatedAt = deps.now();
    // NX: never overwrite an existing link if two IDs ever collide.
    if (await store(redis, id, code, updatedAt, 'NX') === 'OK') return res.status(201).json({ id, updatedAt });
  }
  return res.status(503).json({ error: 'Could not allocate a link ID' });
}

// Overwrites an existing link and restarts its 30-day clock. An unknown or
// expired ID is 404 and is never created here (XX), so a caller cannot pick an
// ID; the client POSTs a fresh link instead.
async function handleUpdate(req, res, redis, deps) {
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: 'Body must be a JSON object' });
  const { id, code } = body;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid link ID' });
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid share code' });

  const updatedAt = deps.now();
  if (await store(redis, id, code, updatedAt, 'XX') !== 'OK') return res.status(404).json({ error: 'Link not found or expired' });
  return res.status(200).json({ updatedAt });
}

async function handleRead(req, res, redis) {
  const id = req.query && req.query.id;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid link ID' });

  const value = parseStored(await redis(['GET', KEY_PREFIX + id]));
  if (!value) return res.status(404).json({ error: 'Link not found or expired' });
  return res.status(200).json(value);
}

const HANDLERS = { GET: handleRead, POST: handleCreate, PUT: handleUpdate };

function createHandler(deps = {}) {
  const getEnv = deps.getEnv || (() => process.env);
  const fetchImpl = deps.fetch || ((...args) => fetch(...args));
  const log = deps.log || console.error;
  const handlerDeps = {
    randomBytes: deps.randomBytes || crypto.randomBytes,
    now: deps.now || Date.now,
    limits: { ...RATE_LIMITS, ...deps.limits },
  };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const handle = HANDLERS[req.method];
    if (!handle) {
      res.setHeader('Allow', Object.keys(HANDLERS).join(', '));
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.method !== 'GET') {
      if (!isSameSiteOrigin(req)) return res.status(403).json({ error: 'Cross-site requests are not allowed' });
      if (!hasJsonContentType(req)) return res.status(415).json({ error: 'Content-Type must be application/json' });
    }

    const redis = createRedis(getEnv(), fetchImpl);
    if (!redis) {
      log('share: PP_KV_REST_API_URL / PP_KV_REST_API_TOKEN not configured');
      return res.status(503).json({ error: 'Short links are unavailable' });
    }

    try {
      let limit = { limited: false };
      try { limit = await checkRateLimit(redis, req, handlerDeps); } catch (err) { log('share: rate limiter failed, allowing request:', err.message); }
      if (limit.limited) {
        res.setHeader('Retry-After', String(limit.retryAfter));
        return res.status(429).json({ error: 'Too many requests', retryAfter: limit.retryAfter });
      }
      return await handle(req, res, redis, handlerDeps);
    } catch (err) {
      log('share:', err.message);
      return res.status(503).json({ error: 'Short links are unavailable' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.generateId = generateId;
module.exports.parseStored = parseStored;
module.exports.TTL_SECONDS = TTL_SECONDS;
module.exports.MAX_CODE_LENGTH = MAX_CODE_LENGTH;
module.exports.RATE_LIMITS = RATE_LIMITS;
module.exports.RATE_WINDOW_SECONDS = RATE_WINDOW_SECONDS;
