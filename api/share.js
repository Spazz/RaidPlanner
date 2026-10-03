// Live share links: stores a plan's share code under a random ID so the
// planner can hand out /<version>/<id> instead of the full #r=<code> fragment.
// Anyone holding the link can update it; the latest save wins.
//
//   POST /api/share   body {"code"}         -> 201 {"id", "updatedAt"}
//   PUT  /api/share   body {"id", "code"}   -> 200 {"updatedAt"}
//   GET  /api/share?id=<id>                 -> 200 {"code", "updatedAt"} | 404
//
// Backed by Upstash Redis over its REST API (plain fetch, no dependencies).
// Links expire 30 days after their last save. The token never leaves this
// function.

const crypto = require('crypto');

const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CODE_LENGTH = 32 * 1024;
const ID_LENGTH = 7;
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_ID_ATTEMPTS = 5;
const KEY_PREFIX = 'pp:share:';
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

  return async function command(args) {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(`Redis ${args[0]} failed (${resp.status})`);
    return data.result;
  };
}

function parseBody(body) {
  if (typeof body !== 'string') return body || {};
  try { return JSON.parse(body) || {}; } catch { return {}; }
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

function store(redis, id, code, updatedAt, onlyIfNew) {
  const args = ['SET', KEY_PREFIX + id, JSON.stringify({ code, updatedAt }), 'EX', String(TTL_SECONDS)];
  if (onlyIfNew) args.push('NX');
  return redis(args);
}

async function handleCreate(req, res, redis, deps) {
  const { code } = parseBody(req.body);
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid share code' });

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId(deps.randomBytes);
    const updatedAt = deps.now();
    // NX: never overwrite an existing link if two IDs ever collide.
    if (await store(redis, id, code, updatedAt, true) === 'OK') return res.status(201).json({ id, updatedAt });
  }
  return res.status(503).json({ error: 'Could not allocate a link ID' });
}

// Overwrites unconditionally and restarts the 30-day clock. An expired ID is
// simply re-created, so a plan someone is still editing never loses its link.
async function handleUpdate(req, res, redis, deps) {
  const { id, code } = parseBody(req.body);
  if (!validId(id)) return res.status(400).json({ error: 'Invalid link ID' });
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid share code' });

  const updatedAt = deps.now();
  await store(redis, id, code, updatedAt, false);
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
  const handlerDeps = { randomBytes: deps.randomBytes || crypto.randomBytes, now: deps.now || Date.now };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const handle = HANDLERS[req.method];
    if (!handle) {
      res.setHeader('Allow', Object.keys(HANDLERS).join(', '));
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const redis = createRedis(getEnv(), fetchImpl);
    if (!redis) {
      log('share: PP_KV_REST_API_URL / PP_KV_REST_API_TOKEN not configured');
      return res.status(503).json({ error: 'Short links are unavailable' });
    }

    try {
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
