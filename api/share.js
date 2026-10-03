// Short share links: stores a share code under a random ID so the planner can
// hand out /s/<id> instead of the full #r=<code> fragment.
//
//   POST /api/share   body {"code": "<base64url share code>"}  -> 201 {"id"}
//   GET  /api/share?id=<id>                                    -> 200 {"code"} | 404
//
// Backed by Upstash Redis over its REST API (plain fetch, no dependencies).
// Links expire after 30 days. The token never leaves this function.

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

function readCode(body) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  const code = body && body.code;
  if (typeof code !== 'string') return null;
  if (!code || code.length > MAX_CODE_LENGTH) return null;
  if (!CODE_PATTERN.test(code)) return null;
  return code;
}

async function handleCreate(req, res, redis, randomBytes) {
  const code = readCode(req.body);
  if (!code) return res.status(400).json({ error: 'Invalid share code' });

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId(randomBytes);
    // NX: never overwrite an existing link if two IDs ever collide.
    const result = await redis(['SET', KEY_PREFIX + id, code, 'EX', String(TTL_SECONDS), 'NX']);
    if (result === 'OK') return res.status(201).json({ id });
  }
  return res.status(503).json({ error: 'Could not allocate a link ID' });
}

async function handleRead(req, res, redis) {
  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid link ID' });

  const code = await redis(['GET', KEY_PREFIX + id]);
  if (typeof code !== 'string') return res.status(404).json({ error: 'Link not found or expired' });
  return res.status(200).json({ code });
}

function createHandler(deps = {}) {
  const getEnv = deps.getEnv || (() => process.env);
  const fetchImpl = deps.fetch || ((...args) => fetch(...args));
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const log = deps.log || console.error;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const redis = createRedis(getEnv(), fetchImpl);
    if (!redis) {
      log('share: PP_KV_REST_API_URL / PP_KV_REST_API_TOKEN not configured');
      return res.status(503).json({ error: 'Short links are unavailable' });
    }

    try {
      return req.method === 'POST'
        ? await handleCreate(req, res, redis, randomBytes)
        : await handleRead(req, res, redis);
    } catch (err) {
      log('share:', err.message);
      return res.status(503).json({ error: 'Short links are unavailable' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.generateId = generateId;
module.exports.TTL_SECONDS = TTL_SECONDS;
module.exports.MAX_CODE_LENGTH = MAX_CODE_LENGTH;
