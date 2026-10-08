/**
 * PartyPlanner Web - Live share link tests
 * Run: node share-tests.js
 *
 * Exercises api/share.js (the Vercel function behind /<version>/<id> links)
 * against an in-memory fake of the Upstash Redis REST API, so no network or
 * credentials are needed. A real share code from index.html's logic half is
 * round-tripped through the API to prove the two sides agree on the code
 * format, and LiveLinks (the per-plan link bookkeeping) is driven directly.
 */
const crypto = require('crypto');
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const share = require('./api/share.js');

const ENV = { PP_KV_REST_API_URL: 'https://fake.upstash.io', PP_KV_REST_API_TOKEN: 'test-token' };

// Minimal Upstash REST fake: POST [command, ...args] -> {result}.
function fakeUpstash({ failWith, failPipeline } = {}) {
  const store = new Map();
  const calls = [];
  const limiterCalls = [];
  const counters = new Map();
  const expiries = new Map();
  const fetch = async (url, init) => {
    if (url.endsWith('/pipeline')) {
      const commands = JSON.parse(init.body);
      limiterCalls.push({ url, auth: init.headers.Authorization, commands });
      if (failPipeline === 'throw') throw new Error('network down');
      if (failPipeline) return { ok: false, status: failPipeline, json: async () => ({ error: 'boom' }) };
      const results = commands.map(([cmd, key, value]) => {
        if (cmd === 'INCR') { counters.set(key, (counters.get(key) || 0) + 1); return { result: counters.get(key) }; }
        if (cmd === 'EXPIRE') { expiries.set(key, value); return { result: 1 }; }
        return { error: 'unsupported' };
      });
      return { ok: true, status: 200, json: async () => results };
    }
    const args = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, args });
    if (failWith) return { ok: false, status: failWith, json: async () => ({ error: 'boom' }) };
    const [cmd, key, value, ...opts] = args;
    let result = null;
    if (cmd === 'SET') {
      if (opts.includes('NX') && store.has(key)) result = null;
      else if (opts.includes('XX') && !store.has(key)) result = null;
      else { store.set(key, value); result = 'OK'; }
    } else if (cmd === 'GET') {
      result = store.has(key) ? store.get(key) : null;
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { store, calls, limiterCalls, counters, expiries, fetch };
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Writes carry the JSON Content-Type the browser client sends, unless a test overrides it.
async function call(handler, req) {
  const res = fakeRes();
  const writes = req.method === 'POST' || req.method === 'PUT';
  await handler({ query: {}, ...req, headers: { ...(writes ? { 'content-type': 'application/json' } : {}), ...req.headers } }, res);
  return res;
}

function makeHandler(redis, extra = {}) {
  return share.createHandler({ getEnv: () => ENV, fetch: redis.fetch, log: () => {}, now: () => 1000, ...extra });
}

function loadLogic() {
  return app.sandbox(['Import', 'State', 'LiveLinks'], { globals: { btoa, atob, escape, unescape } }).api;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

const TTL = String(30 * 24 * 60 * 60);

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

(async () => {
  await check('generateId returns 7 base62 characters', () => {
    for (let i = 0; i < 500; i++) assert.match(share.generateId(crypto.randomBytes), /^[0-9A-Za-z]{7}$/);
  });

  await check('generateId skips biased bytes (>= 248) instead of wrapping them', () => {
    const bytes = [255, 250, 248, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(share.generateId(() => Buffer.from(bytes)), '0123456');
  });

  await check('POST stores {code, updatedAt} with a 30-day TTL and NX, using the PP_ env vars', async () => {
    const redis = fakeUpstash();
    const res = await call(makeHandler(redis), { method: 'POST', body: { code: 'UFA6Mjp0ZXN0' } });
    assert.equal(res.statusCode, 201);
    assert.match(res.body.id, /^[0-9A-Za-z]{7}$/);
    assert.equal(res.body.updatedAt, 1000);
    const [set] = redis.calls;
    assert.equal(set.url, ENV.PP_KV_REST_API_URL);
    assert.equal(set.auth, 'Bearer test-token');
    assert.deepEqual(set.args, ['SET', 'pp:share:' + res.body.id, JSON.stringify({ code: 'UFA6Mjp0ZXN0', updatedAt: 1000 }), 'EX', TTL, 'NX']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  await check('POST accepts a JSON string body as well as a parsed one', async () => {
    const res = await call(makeHandler(fakeUpstash()), { method: 'POST', body: JSON.stringify({ code: 'abc_-123' }) });
    assert.equal(res.statusCode, 201);
  });

  await check('POST rejects missing, non-base64url and oversized codes without touching Redis', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    for (const body of [undefined, {}, { code: '' }, { code: 42 }, { code: 'has space' }, { code: 'a+b/c=' }, { code: '<script>' }, 'not json',
                        { code: 'A'.repeat(share.MAX_CODE_LENGTH + 1) }]) {
      const res = await call(handler, { method: 'POST', body });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)?.slice(0, 40)}`);
    }
    assert.equal(redis.calls.length, 0);
  });

  await check('POST retries on an ID collision and never overwrites the existing link', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:0000000', 'existing');
    const sequences = [Buffer.alloc(14, 0), Buffer.from([1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])];
    const handler = makeHandler(redis, { randomBytes: () => sequences.shift() });
    const res = await call(handler, { method: 'POST', body: { code: 'newcode' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, '1111111');
    assert.equal(redis.store.get('pp:share:0000000'), 'existing');
  });

  await check('POST gives up with 503 when every attempt collides', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:0000000', 'existing');
    const res = await call(makeHandler(redis, { randomBytes: () => Buffer.alloc(14, 0) }), { method: 'POST', body: { code: 'x' } });
    assert.equal(res.statusCode, 503);
    assert.equal(redis.calls.length, 5);
  });

  await check('GET returns the stored code and its updatedAt', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', JSON.stringify({ code: 'storedcode', updatedAt: 42 }));
    const res = await call(makeHandler(redis), { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { code: 'storedcode', updatedAt: 42 });
  });

  await check('GET still reads links saved before live updates (bare code) as updatedAt 0', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', 'UFA6MjpsZWdhY3k');
    const res = await call(makeHandler(redis), { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { code: 'UFA6MjpsZWdhY3k', updatedAt: 0 });
  });

  await check('GET treats a corrupted stored value as missing (404)', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', '{not json');
    redis.store.set('pp:share:bB3dE5g', JSON.stringify({ code: '<bad>', updatedAt: 1 }));
    const handler = makeHandler(redis);
    assert.equal((await call(handler, { method: 'GET', query: { id: 'aB3dE5g' } })).statusCode, 404);
    assert.equal((await call(handler, { method: 'GET', query: { id: 'bB3dE5g' } })).statusCode, 404);
  });

  await check('PUT overwrites the link, restarts the 30-day TTL (XX: only if it exists) and returns the new updatedAt', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', JSON.stringify({ code: 'old', updatedAt: 1 }));
    const res = await call(makeHandler(redis, { now: () => 5000 }), { method: 'PUT', body: { id: 'aB3dE5g', code: 'newer' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { updatedAt: 5000 });
    assert.deepEqual(redis.calls[0].args, ['SET', 'pp:share:aB3dE5g', JSON.stringify({ code: 'newer', updatedAt: 5000 }), 'EX', TTL, 'XX']);
    const read = await call(makeHandler(redis), { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.deepEqual(read.body, { code: 'newer', updatedAt: 5000 });
  });

  await check('PUT to an unknown or expired link is 404 and never creates it (SET ... XX)', async () => {
    const redis = fakeUpstash();
    const res = await call(makeHandler(redis), { method: 'PUT', body: JSON.stringify({ id: 'gone123', code: 'back' }) });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Link not found or expired' });
    assert.equal(redis.store.has('pp:share:gone123'), false, 'nothing was written');
    assert.deepEqual(redis.calls[0].args, ['SET', 'pp:share:gone123', JSON.stringify({ code: 'back', updatedAt: 1000 }), 'EX', TTL, 'XX']);
    const read = await call(makeHandler(redis), { method: 'GET', query: { id: 'gone123' } });
    assert.equal(read.statusCode, 404, 'still unknown afterwards');
  });

  await check('PUT still updates a link stored before live updates (bare code)', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', 'UFA6MjpsZWdhY3k');
    const res = await call(makeHandler(redis, { now: () => 7 }), { method: 'PUT', body: { id: 'aB3dE5g', code: 'fresh' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(redis.store.get('pp:share:aB3dE5g')), { code: 'fresh', updatedAt: 7 });
  });

  // ── S2: request validation ─────────────────────────────────────
  await check('POST/PUT without a JSON Content-Type are 415 and never reach Redis', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    const body = JSON.stringify({ id: 'aB3dE5g', code: 'abc' });
    for (const method of ['POST', 'PUT']) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', '']) {
        const res = await call(handler, { method, body, headers: { 'content-type': type } });
        assert.equal(res.statusCode, 415, `${method} ${JSON.stringify(type)}`);
      }
      const bare = fakeRes();
      await handler({ method, body, query: {} }, bare); // no Content-Type header at all
      assert.equal(bare.statusCode, 415, `${method} with no Content-Type`);
    }
    assert.equal(redis.calls.length, 0);
    assert.equal(redis.limiterCalls.length, 0);
  });

  await check('Content-Type is matched case-insensitively and may carry parameters', async () => {
    const handler = makeHandler(fakeUpstash());
    for (const type of ['application/json', 'Application/JSON', 'application/json; charset=utf-8', 'application/json;charset=UTF-8']) {
      const res = await call(handler, { method: 'POST', body: { code: 'abc' }, headers: { 'content-type': type } });
      assert.equal(res.statusCode, 201, type);
    }
  });

  await check('A cross-site or opaque Origin is 403 on POST and PUT, before any Redis call', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    const origins = ['https://evil.example', 'https://pp.example.evil.example', 'https://pp.example:8443', 'null', 'not a url', ''];
    for (const method of ['POST', 'PUT']) {
      for (const origin of origins) {
        const res = await call(handler, { method, body: { id: 'aB3dE5g', code: 'abc' }, headers: { host: 'pp.example', origin } });
        assert.equal(res.statusCode, 403, `${method} Origin ${JSON.stringify(origin)}`);
      }
    }
    const noHost = await call(handler, { method: 'POST', body: { code: 'abc' }, headers: { origin: 'https://pp.example' } });
    assert.equal(noHost.statusCode, 403, 'an Origin with no Host to compare against');
    assert.equal(redis.calls.length, 0);
  });

  await check('Same-host Origins (production, Vercel previews, localhost) and requests with no Origin are allowed', async () => {
    const handler = makeHandler(fakeUpstash());
    const cases = [
      { host: 'pp.example', origin: 'https://pp.example' },
      { host: 'PP.Example', origin: 'https://pp.example' },
      { host: 'party-planner-git-phase-2-team.vercel.app', origin: 'https://party-planner-git-phase-2-team.vercel.app' },
      { host: 'localhost:3000', origin: 'http://localhost:3000' },
      { host: 'pp.example' }, // curl / server-to-server: no Origin
      {},
    ];
    for (const headers of cases) {
      const res = await call(handler, { method: 'POST', body: { code: 'abc' }, headers });
      assert.equal(res.statusCode, 201, JSON.stringify(headers));
    }
  });

  await check('GET is not subject to the Origin or Content-Type checks', async () => {
    const res = await call(makeHandler(fakeUpstash()), { method: 'GET', query: { id: 'zzzzzzz' }, headers: { host: 'pp.example', origin: 'https://other.example' } });
    assert.equal(res.statusCode, 404);
  });

  await check('A body that is not a JSON object is 400 and never reaches Redis', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    for (const method of ['POST', 'PUT']) {
      for (const body of ['[1,2]', '"abc"', '5', 'null', 'true', 'not json', '', [], ['code'], 7, null, undefined, true]) {
        const res = await call(handler, { method, body });
        assert.equal(res.statusCode, 400, `${method} ${JSON.stringify(body)}`);
        assert.deepEqual(res.body, { error: 'Body must be a JSON object' }, `${method} ${JSON.stringify(body)}`);
      }
    }
    assert.equal(redis.calls.length, 0);
  });

  await check('PUT rejects bad IDs and codes without touching Redis', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    for (const body of [undefined, {}, { id: 'aB3dE5g' }, { code: 'abc' }, { id: '../etc', code: 'abc' }, { id: 'aB3dE5g', code: 'a b' },
                        { id: 'aB3dE5g', code: 'A'.repeat(share.MAX_CODE_LENGTH + 1) }]) {
      const res = await call(handler, { method: 'PUT', body });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)?.slice(0, 40)}`);
    }
    assert.equal(redis.calls.length, 0);
  });

  await check('GET returns 404 for an unknown or expired ID', async () => {
    const res = await call(makeHandler(fakeUpstash()), { method: 'GET', query: { id: 'zzzzzzz' } });
    assert.equal(res.statusCode, 404);
  });

  await check('GET rejects malformed IDs without touching Redis', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    for (const id of [undefined, '', 'short', 'toolong12', 'ab*defg', '../etc', ['aB3dE5g']]) {
      const res = await call(handler, { method: 'GET', query: { id } });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(id)}`);
    }
    assert.equal(redis.calls.length, 0);
  });

  const ipReq = (ip, extra = {}) => ({ headers: { 'x-forwarded-for': ip }, ...extra });
  const getReq = ip => ipReq(ip, { method: 'GET', query: { id: 'aB3dE5g' } });
  // PUT only updates an existing link, so rate-limit tests seed aB3dE5g first.
  const linked = redis => { redis.store.set('pp:share:aB3dE5g', JSON.stringify({ code: 'old', updatedAt: 1 })); return redis; };
  const putReq = ip => ipReq(ip, { method: 'PUT', body: { id: 'aB3dE5g', code: 'abc' } });

  await check('Rate limit: INCR + EXPIRE go out as one pipeline keyed by budget, first x-forwarded-for hop and window', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis, { now: () => 125000 }); // window 2 (60s windows)
    const res = await call(handler, getReq('203.0.113.9, 10.0.0.1, 10.0.0.2'));
    assert.equal(res.statusCode, 404);
    assert.equal(redis.limiterCalls.length, 1);
    assert.equal(redis.limiterCalls[0].url, ENV.PP_KV_REST_API_URL + '/pipeline');
    assert.equal(redis.limiterCalls[0].auth, 'Bearer test-token');
    assert.deepEqual(redis.limiterCalls[0].commands, [['INCR', 'pp:rl:read:203.0.113.9:2'], ['EXPIRE', 'pp:rl:read:203.0.113.9:2', '60']]);
  });

  await check('Rate limit: falls back to x-real-ip, and a request with no client IP is not limited or counted', async () => {
    const redis = fakeUpstash();
    const handler = makeHandler(redis);
    await call(handler, { method: 'GET', query: { id: 'aB3dE5g' }, headers: { 'x-real-ip': '198.51.100.7' } });
    assert.match(redis.limiterCalls[0].commands[0][1], /^pp:rl:read:198\.51\.100\.7:/);
    await call(handler, { method: 'GET', query: { id: 'aB3dE5g' }, headers: {} });
    await call(handler, { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.equal(redis.limiterCalls.length, 1);
  });

  await check('Rate limit: writes are capped at 60/min, then 429 with Retry-After and no Redis write', async () => {
    const redis = linked(fakeUpstash());
    const handler = makeHandler(redis, { now: () => 125000 }); // 55s left in the window
    for (let i = 0; i < 60; i++) assert.equal((await call(handler, putReq('203.0.113.9'))).statusCode, 200, `write ${i + 1}`);
    const writesBefore = redis.calls.length;
    const res = await call(handler, putReq('203.0.113.9'));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '55');
    assert.deepEqual(res.body, { error: 'Too many requests', retryAfter: 55 });
    assert.equal(redis.calls.length, writesBefore, 'a limited request never reaches the store');
    assert.equal((await call(handler, { ...ipReq('203.0.113.9'), method: 'POST', body: { code: 'abc' } })).statusCode, 429, 'POST shares the write budget');
  });

  await check('Rate limit: reads and writes have separate budgets (reads 240/min)', async () => {
    const redis = linked(fakeUpstash());
    const handler = makeHandler(redis);
    for (let i = 0; i < 60; i++) await call(handler, putReq('203.0.113.9'));
    assert.equal((await call(handler, putReq('203.0.113.9'))).statusCode, 429);
    assert.equal((await call(handler, getReq('203.0.113.9'))).statusCode, 200, 'reads still allowed after the write budget is spent');
    for (let i = 1; i < 240; i++) await call(handler, getReq('203.0.113.9'));
    assert.equal((await call(handler, getReq('203.0.113.9'))).statusCode, 429, 'the 241st read is limited');
  });

  await check('Rate limit: budgets are per IP and reset when the window rolls over', async () => {
    const redis = linked(fakeUpstash());
    let now = 125000;
    const handler = makeHandler(redis, { now: () => now, limits: { write: 2 } });
    await call(handler, putReq('203.0.113.9'));
    await call(handler, putReq('203.0.113.9'));
    assert.equal((await call(handler, putReq('203.0.113.9'))).statusCode, 429);
    assert.equal((await call(handler, putReq('203.0.113.10'))).statusCode, 200, 'another IP is unaffected');
    now = 180000; // next window
    assert.equal((await call(handler, putReq('203.0.113.9'))).statusCode, 200, 'fresh window');
  });

  await check('Rate limit: Retry-After is at least 1 second, even on the last millisecond of a window', async () => {
    const handler = makeHandler(fakeUpstash(), { now: () => 119999, limits: { read: 0 } });
    const res = await call(handler, getReq('203.0.113.9'));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '1');
  });

  await check('Rate limit: fails open when the limiter call errors, is rejected, or answers garbage', async () => {
    for (const failPipeline of ['throw', 500, 401]) {
      const redis = linked(fakeUpstash({ failPipeline }));
      const logged = [];
      const handler = makeHandler(redis, { log: (...a) => logged.push(a.join(' ')) });
      const res = await call(handler, putReq('203.0.113.9'));
      assert.equal(res.statusCode, 200, `limiter ${failPipeline} must not block the write`);
      assert(logged.some(l => /rate limiter failed/.test(l)), 'the failure is logged');
      assert(!logged.join().includes('test-token'));
    }
    const garbage = linked(fakeUpstash());
    const realFetch = garbage.fetch;
    garbage.fetch = async (url, init) => (url.endsWith('/pipeline') ? { ok: true, status: 200, json: async () => ({ oops: 1 }) } : realFetch(url, init));
    assert.equal((await call(makeHandler(garbage), putReq('203.0.113.9'))).statusCode, 200);
  });

  await check('Rate limit: the missing-env 503 and the 405 come before any limiter traffic', async () => {
    const redis = fakeUpstash();
    const noEnv = share.createHandler({ getEnv: () => ({}), fetch: redis.fetch, log: () => {} });
    assert.equal((await call(noEnv, getReq('203.0.113.9'))).statusCode, 503);
    assert.equal((await call(makeHandler(redis), ipReq('203.0.113.9', { method: 'DELETE' }))).statusCode, 405);
    assert.equal(redis.limiterCalls.length, 0);
  });

  await check('Other methods get 405 with an Allow header', async () => {
    const res = await call(makeHandler(fakeUpstash()), { method: 'DELETE' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET, POST, PUT');
  });

  await check('Missing PP_ env vars -> 503, no fetch, no crash', async () => {
    const redis = fakeUpstash();
    const handler = share.createHandler({ getEnv: () => ({}), fetch: redis.fetch, log: () => {} });
    const res = await call(handler, { method: 'POST', body: { code: 'abc' } });
    assert.equal(res.statusCode, 503);
    assert.equal(redis.calls.length, 0);
  });

  await check('Redis errors -> generic 503 that never leaks the token', async () => {
    const res = await call(makeHandler(fakeUpstash({ failWith: 401 })), { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.equal(res.statusCode, 503);
    assert(!JSON.stringify(res.body).includes('test-token'));
  });

  await check('Real share code from index.html round-trips through the API and keeps its game version', async () => {
    const { Import, State } = loadLogic();
    const classes = ['WARRIOR', 'PRIEST', 'MAGE', 'ROGUE', 'DRUID'];
    const specs = ['Arms', 'Holy', 'Frost', 'Combat', 'Feral']; // real specs: the importer drops unknown ones
    const players = Array.from({ length: 40 }, (_, i) => ({
      name: 'Player' + i, class: classes[i % 5], spec: specs[i % 5], role: 'melee_dps', groupNumber: 1 + Math.floor(i / 5),
    }));
    assert(Import.loadRoster({ gameVersion: 'forever', raid: 'f_ony', players }));
    State.notes = 'Pull at 8. Bring flasks, Onyxia fire resist gear, and a sense of humour. '.repeat(20);
    const code = Import.encodeSharePayload(Import.exportShareString());
    assert(code.length < share.MAX_CODE_LENGTH, `40-man code with long notes is ${code.length} chars`);

    const handler = makeHandler(fakeUpstash());
    const created = await call(handler, { method: 'POST', body: { code } });
    assert.equal(created.statusCode, 201);
    const fetched = await call(handler, { method: 'GET', query: { id: created.body.id } });
    assert.equal(fetched.body.code, code);

    State.gameVersion = 'tbc';
    State.selectedRaid = 'bt';
    const res = Import.importAddonString(Import.decodeSharePayload(fetched.body.code));
    assert.equal(res.success, true);
    assert.equal(State.gameVersion, 'forever');
    assert.equal(State.selectedRaid, 'f_ony');
    assert.equal(res.playerCount, 40);
  });

  await check('LiveLinks.planKey is version + planId, and null without a plan ID', () => {
    const { LiveLinks } = loadLogic();
    assert.equal(LiveLinks.planKey({ planId: 'event:123', gameVersion: 'forever' }), 'forever|event:123');
    assert.equal(LiveLinks.planKey({ planId: 'plan:abc' }), 'tbc|plan:abc');
    assert.equal(LiveLinks.planKey({ planId: null, gameVersion: 'tbc' }), null);
    assert.equal(LiveLinks.planKey(null), null);
  });

  await check('LiveLinks.bind/get/findById round-trip one plan per link', () => {
    const { LiveLinks } = loadLogic();
    const storage = memoryStorage();
    LiveLinks.bind(storage, 'tbc|plan:a', 'aB3dE5g', 'code1', 10);
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a').id, 'aB3dE5g');
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a').lastCode, 'code1');
    assert.equal(LiveLinks.findById(storage, 'aB3dE5g').planKey, 'tbc|plan:a');
    assert.equal(LiveLinks.get(storage, 'tbc|plan:other'), null);
    assert.equal(LiveLinks.findById(storage, 'zzzzzzz'), null);
    // Opening the same link into a different plan moves the binding over.
    LiveLinks.bind(storage, 'tbc|plan:b', 'aB3dE5g', 'code2', 20);
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a'), null);
    assert.equal(LiveLinks.findById(storage, 'aB3dE5g').planKey, 'tbc|plan:b');
  });

  await check('LiveLinks survives corrupted or missing storage and ignores malformed IDs', () => {
    const { LiveLinks } = loadLogic();
    assert.equal(LiveLinks.get(memoryStorage({ pp_live_links: '{oops' }), 'tbc|plan:a'), null);
    assert.equal(LiveLinks.get(memoryStorage({ pp_live_links: '[]' }), 'tbc|plan:a'), null);
    assert.equal(LiveLinks.get(null, 'tbc|plan:a'), null);
    const bad = memoryStorage({ pp_live_links: JSON.stringify({ 'tbc|plan:a': { id: '../etc' } }) });
    assert.equal(LiveLinks.get(bad, 'tbc|plan:a'), null);
  });

  await check('LiveLinks keeps only the most recently used bindings', () => {
    const { LiveLinks } = loadLogic();
    const storage = memoryStorage();
    LiveLinks.max = 3;
    for (let i = 0; i < 5; i++) LiveLinks.bind(storage, 'tbc|plan:' + i, 'abcdef' + i, 'c', i);
    const kept = Object.keys(LiveLinks.read(storage));
    assert.equal(kept.length, 3);
    assert(kept.includes('tbc|plan:4'), 'newest binding kept');
  });

  await check('LiveLinks.needsPush only when the on-screen code differs from the last sync', () => {
    const { LiveLinks } = loadLogic();
    const entry = { id: 'aB3dE5g', lastCode: 'same', updatedAt: 5 };
    assert.equal(LiveLinks.needsPush(entry, 'same'), false);
    assert.equal(LiveLinks.needsPush(entry, 'changed'), true);
    assert.equal(LiveLinks.needsPush(null, 'changed'), false);
    assert.equal(LiveLinks.needsPush(entry, ''), false);
  });

  await check('LiveLinks.shouldApply only for a newer remote with no local save waiting', () => {
    const { LiveLinks } = loadLogic();
    const entry = { id: 'aB3dE5g', lastCode: 'x', updatedAt: 100 };
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 200 }, false), true);
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 200 }, true), false, 'local save wins');
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 100 }, false), false, 'not newer');
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 50 }, false), false, 'older');
    assert.equal(LiveLinks.shouldApply(null, { code: 'y', updatedAt: 200 }, false), false);
  });

  await check('A remote edit applied through the share string keeps the plan bound and does not need re-pushing', async () => {
    const { Import, State, LiveLinks } = loadLogic();
    const storage = memoryStorage();
    const players = Array.from({ length: 10 }, (_, i) => ({ name: 'P' + i, class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 + Math.floor(i / 5) }));
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', players }));
    State.planId = 'event:999';
    const planKey = LiveLinks.planKey(State);
    const codeA = Import.encodeSharePayload(Import.exportShareString());
    LiveLinks.bind(storage, planKey, 'aB3dE5g', codeA, 100);

    // Someone else moves P0 to group 2 and saves.
    const moved = State.groups[0].shift(); moved.groupNumber = 2; State.groups[1].push(moved);
    const codeB = Import.encodeSharePayload(Import.exportShareString());
    assert.notEqual(codeA, codeB);

    // Back on this browser: apply B the way applyRemoteLiveCode does.
    State.groups[1].pop(); moved.groupNumber = 1; State.groups[0].unshift(moved);
    const keep = { planId: State.planId };
    assert(Import.importAddonString(Import.decodeSharePayload(codeB)).success);
    Object.assign(State, keep);
    const local = Import.encodeSharePayload(Import.exportShareString());
    LiveLinks.bind(storage, LiveLinks.planKey(State), 'aB3dE5g', local, 200);
    assert.equal(LiveLinks.planKey(State), planKey, 'plan key survives the import');
    assert.equal(local, codeB, 'share string round-trips byte-for-byte');
    assert.equal(LiveLinks.needsPush(LiveLinks.get(storage, planKey), local), false, 'no echo save');
    assert(State.groups[1].some(p => p.name === 'P0'));
  });

  console.log(`\nShare tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
