/**
 * PartyPlanner Web - Short share link API tests
 * Run: node share-tests.js
 *
 * Exercises api/share.js (the Vercel function behind /<version>/<id> links)
 * against an in-memory fake of the Upstash Redis REST API, so no network or
 * credentials are needed. The last check round-trips a real share code from
 * index.html's logic half through the API to prove the two sides agree on
 * the code format and that the stored code carries the game version.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const share = require('./api/share.js');

const ENV = { PP_KV_REST_API_URL: 'https://fake.upstash.io', PP_KV_REST_API_TOKEN: 'test-token' };

// Minimal Upstash REST fake: POST [command, ...args] -> {result}.
function fakeUpstash({ failWith } = {}) {
  const store = new Map();
  const calls = [];
  const fetch = async (url, init) => {
    const args = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, args });
    if (failWith) return { ok: false, status: failWith, json: async () => ({ error: 'boom' }) };
    const [cmd, key, value, ...opts] = args;
    let result = null;
    if (cmd === 'SET') {
      if (opts.includes('NX') && store.has(key)) result = null;
      else { store.set(key, value); result = 'OK'; }
    } else if (cmd === 'GET') {
      result = store.has(key) ? store.get(key) : null;
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { store, calls, fetch };
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function call(handler, req) {
  const res = fakeRes();
  await handler({ query: {}, ...req }, res);
  return res;
}

function makeHandler(redis, extra = {}) {
  return share.createHandler({ getEnv: () => ENV, fetch: redis.fetch, log: () => {}, ...extra });
}

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

  await check('POST stores the code with a 30-day TTL and NX, using the PP_ env vars', async () => {
    const redis = fakeUpstash();
    const res = await call(makeHandler(redis), { method: 'POST', body: { code: 'UFA6Mjp0ZXN0' } });
    assert.equal(res.statusCode, 201);
    assert.match(res.body.id, /^[0-9A-Za-z]{7}$/);
    const [set] = redis.calls;
    assert.equal(set.url, ENV.PP_KV_REST_API_URL);
    assert.equal(set.auth, 'Bearer test-token');
    assert.deepEqual(set.args, ['SET', 'pp:share:' + res.body.id, 'UFA6Mjp0ZXN0', 'EX', String(30 * 24 * 60 * 60), 'NX']);
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

  await check('GET returns the stored code', async () => {
    const redis = fakeUpstash();
    redis.store.set('pp:share:aB3dE5g', 'storedcode');
    const res = await call(makeHandler(redis), { method: 'GET', query: { id: 'aB3dE5g' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { code: 'storedcode' });
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

  await check('Other methods get 405 with an Allow header', async () => {
    const res = await call(makeHandler(fakeUpstash()), { method: 'DELETE' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET, POST');
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
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const ctx = vm.createContext({ TextEncoder, TextDecoder, console, btoa, atob, escape, unescape });
    vm.runInContext(script.split('// ── UI RENDERING')[0] + '\nglobalThis.api={Import,State};', ctx);
    const { Import, State } = ctx.api;
    const classes = ['WARRIOR', 'PRIEST', 'MAGE', 'ROGUE', 'DRUID'];
    const players = Array.from({ length: 40 }, (_, i) => ({
      name: 'Player' + i, class: classes[i % 5], spec: '', role: 'melee_dps', groupNumber: 1 + Math.floor(i / 5),
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

  console.log(`\nShare tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
