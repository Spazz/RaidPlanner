/**
 * Raidsmith - live share links on the Worker (migration 0028, worker/share.js) - Worker tests
 * Run: node tests/guild/guild-share-worker-tests.js [name-filter]
 *
 * The port of the old Vercel/Upstash function, over the D1 stand-in with an injected clock:
 *   - create / read / update, the request and response shapes js/app.js relies on ({id, updatedAt}, {code, updatedAt}, {error: sentence})
 *   - expiry: 30 days after the last save, a read does not extend it, an update does, an expired link is 404 (and is not created by a PUT)
 *   - validation: ids, codes, JSON object bodies, Content-Type (415), cross-site (403), methods (405), size (413)
 *   - the per-IP rate limit in D1 (writes 60/min, reads 240/min, Retry-After, separate budgets, window roll-over, no IP stored)
 *   - the daily cron sweeps expired links and old limiter rows
 *   - /tbc/<id>, /classic/<id>, /forever/<id> answer with the front page, nothing else does
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');

const ROOT = path.join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const ORIGIN = 'https://raidsmith.test';
const DAY = 24 * 60 * 60 * 1000;
const START = 1_800_000_000_000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function makeShare({ randomBytes } = {}) {
  const { createApp } = await load('worker/index.js');
  const db = createD1Fake();
  const clock = { now: START };
  const logs = [];
  const app = createApp({ db, env: {}, now: () => clock.now, log: (message) => logs.push(message), ...(randomBytes ? { randomBytes } : {}) });
  const send = async (method, pathAndQuery, { body, headers = {}, ip } = {}) => {
    const init = { method, headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers } };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', ...init.headers };
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await app.handle(new Request(`${ORIGIN}${pathAndQuery}`, init));
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  return { db, clock, logs, send, app };
}

const CODE = 'UFA6Mjp0ZXN0_-';
const post = (s, code = CODE, extra = {}) => s.send('POST', '/api/share', { body: { code }, ...extra });
const put = (s, id, code = CODE, extra = {}) => s.send('PUT', '/api/share', { body: { id, code }, ...extra });
const get = (s, id, extra = {}) => s.send('GET', `/api/share?id=${id}`, extra);
const rows = (s) => s.db.sqlite.prepare('SELECT * FROM share_links').all();

check('schema: share_links(id, code, updated_at, expires_at), id is 7 characters, code at most 32 KB', async () => {
  const s = await makeShare();
  const columns = s.db.sqlite.prepare('PRAGMA table_info(share_links)').all().map((c) => c.name);
  assert.deepEqual(columns, ['id', 'code', 'updated_at', 'expires_at']);
  assert.throws(() => s.db.sqlite.prepare("INSERT INTO share_links VALUES ('short', 'x', 1, 2)").run());
  assert.throws(() => s.db.sqlite.prepare('INSERT INTO share_links VALUES (?, ?, 1, 2)').run('abcdefg', 'x'.repeat(32769)));
});

check('POST creates a link: 201 {id, updatedAt}, 7 base62 characters, stored with a 30-day expiry, no-store', async () => {
  const s = await makeShare();
  const res = await post(s);
  assert.equal(res.status, 201, res.text);
  assert.match(res.json.id, /^[0-9A-Za-z]{7}$/);
  assert.equal(res.json.updatedAt, START);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(rows(s).map((r) => ({ ...r })), [{ id: res.json.id, code: CODE, updated_at: START, expires_at: START + 30 * DAY }]);
});

check('GET returns {code, updatedAt}; unknown id is 404 {error}; malformed id is 400', async () => {
  const s = await makeShare();
  const { id } = (await post(s)).json;
  const res = await get(s, id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { code: CODE, updatedAt: START });
  const unknown = await get(s, 'zzzzzzz');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: 'Link not found or expired' });
  for (const bad of ['', 'abc', 'abcdefgh', 'abc-def', '../etc/x']) assert.equal((await get(s, bad)).status, 400, bad);
  assert.equal((await s.send('GET', '/api/share')).status, 400);
});

check('PUT overwrites, answers {updatedAt} and restarts the 30-day clock; a GET does not', async () => {
  const s = await makeShare();
  const { id } = (await post(s)).json;
  s.clock.now = START + 10 * DAY;
  await get(s, id);
  assert.equal(rows(s)[0].expires_at, START + 30 * DAY, 'a read leaves the expiry alone');
  const res = await put(s, id, 'NEWCODE_1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { updatedAt: START + 10 * DAY });
  assert.deepEqual(await get(s, id).then((r) => r.json), { code: 'NEWCODE_1', updatedAt: START + 10 * DAY });
  assert.equal(rows(s)[0].expires_at, START + 40 * DAY);
});

check('expiry: after 30 days without a save the link is 404, and a PUT never creates or revives it', async () => {
  const s = await makeShare();
  const { id } = (await post(s)).json;
  s.clock.now = START + 30 * DAY - 1;
  assert.equal((await get(s, id)).status, 200, 'still live one millisecond before');
  s.clock.now = START + 30 * DAY;
  assert.equal((await get(s, id)).status, 404);
  const revived = await put(s, id);
  assert.equal(revived.status, 404);
  assert.deepEqual(revived.json, { error: 'Link not found or expired' });
  assert.equal((await put(s, 'neverMade'.slice(0, 7))).status, 404, 'an id nobody made is not created');
  assert.equal(rows(s).length, 1, 'the PUTs inserted nothing');
});

check('POST retries on an id collision and never overwrites a live link; an expired row is reused', async () => {
  const fixed = [0, 1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0];
  const queue = [fixed, [10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0, 0, 0, 0]];
  const s = await makeShare({ randomBytes: () => Uint8Array.from(queue.length > 1 ? queue.shift() : queue[0]) });
  const first = await post(s, 'FIRST');
  assert.equal(first.json.id, '0123456');
  queue.unshift(fixed); // the next POST collides once, then gets the second id
  const second = await post(s, 'SECOND');
  assert.equal(second.status, 201);
  assert.equal(second.json.id, 'ABCDEFG');
  assert.equal((await get(s, '0123456')).json.code, 'FIRST', 'the live link is untouched');
  s.clock.now = START + 31 * DAY; // both rows are expired now, unswept
  queue.unshift(fixed);
  const third = await post(s, 'THIRD');
  assert.equal(third.json.id, '0123456', 'an expired id is free');
  assert.equal((await get(s, '0123456')).json.code, 'THIRD');
});

check('POST gives up with 503 when every attempt collides', async () => {
  const s = await makeShare({ randomBytes: () => Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0]) });
  assert.equal((await post(s, 'A')).status, 201);
  const res = await post(s, 'B');
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'Could not allocate a link ID' });
});

check('validation: codes (missing, empty, characters, 32 KB) and ids, with the old sentences', async () => {
  const s = await makeShare();
  for (const code of [undefined, '', 'has space', 'a/b', 'a=b', 5, null, 'x'.repeat(32 * 1024 + 1)]) {
    const res = await s.send('POST', '/api/share', { body: { code } });
    assert.equal(res.status, 400, String(code).slice(0, 20));
    assert.deepEqual(res.json, { error: 'Invalid share code' });
  }
  assert.equal((await post(s, 'x'.repeat(32 * 1024))).status, 201, 'exactly 32 KB is fine');
  const { id } = (await post(s)).json;
  assert.deepEqual((await put(s, 'bad', CODE)).json, { error: 'Invalid link ID' });
  assert.deepEqual((await put(s, id, 'no good')).json, { error: 'Invalid share code' });
  assert.equal((await s.send('PUT', '/api/share', { body: { code: CODE } })).status, 400, 'a PUT without an id');
});

check('bodies: not JSON, an array, a string or null are 400 {Body must be a JSON object}; far too large is 413', async () => {
  const s = await makeShare();
  for (const body of ['{oops', '[]', '"text"', 'null', '5', '']) {
    const res = await s.send('POST', '/api/share', { body: body === '' ? undefined : body, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 400, body);
    assert.deepEqual(res.json, { error: 'Body must be a JSON object' });
  }
  const huge = await s.send('POST', '/api/share', { body: JSON.stringify({ code: 'x'.repeat(40 * 1024) }) });
  assert.equal(huge.status, 413);
  assert.equal(rows(s).length, 0);
});

check('writes need a JSON Content-Type (415, parameters and case are fine) and refuse a cross-site request (403); GET is exempt', async () => {
  const s = await makeShare();
  const bare = await s.send('POST', '/api/share', { body: JSON.stringify({ code: CODE }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(bare.status, 415);
  assert.deepEqual(bare.json, { error: 'Content-Type must be application/json' });
  assert.equal((await s.send('POST', '/api/share', { body: { code: CODE }, headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } })).status, 201);
  for (const origin of ['https://evil.example', 'null']) {
    const res = await s.send('POST', '/api/share', { body: { code: CODE }, headers: { Origin: origin } });
    assert.equal(res.status, 403, origin);
    assert.deepEqual(res.json, { error: 'Cross-site requests are not allowed' });
  }
  assert.equal((await s.send('PUT', '/api/share', { body: { id: 'abcdefg', code: CODE }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await s.send('POST', '/api/share', { body: { code: CODE }, headers: { Origin: ORIGIN } })).status, 201, 'same origin');
  const { id } = (await post(s)).json;
  assert.equal((await get(s, id, { headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' } })).status, 200);
  assert.equal(rows(s).length, 3, 'the refused writes stored nothing');
});

check('other methods get 405 with Allow; unknown sub-paths are 404', async () => {
  const s = await makeShare();
  for (const method of ['DELETE', 'PATCH']) {
    const res = await s.send(method, '/api/share', { body: {} });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'GET, POST, PUT');
  }
  assert.equal((await s.send('GET', '/api/share/abcdefg')).status, 404);
});

check('rate limit: writes are capped at 60/min per IP, then 429 with Retry-After and nothing stored; reads have their own 240/min', async () => {
  const s = await makeShare();
  const ip = '203.0.113.9';
  const { id } = (await post(s, CODE, { ip })).json;
  s.clock.now = START + 5000;
  for (let i = 1; i < 60; i++) assert.equal((await put(s, id, CODE, { ip })).status, 200, `write ${i + 1}`);
  const count = rows(s).length;
  const limited = await post(s, 'OTHER', { ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '55');
  assert.deepEqual(limited.json, { error: 'Too many requests', retryAfter: 55 });
  assert.equal(rows(s).length, count, 'a limited request never reaches the table');
  assert.equal((await put(s, id, CODE, { ip })).status, 429);
  assert.equal((await get(s, id, { ip })).status, 200, 'reads still allowed after the write budget is spent');
  for (let i = 1; i < 240; i++) await get(s, id, { ip });
  assert.equal((await get(s, id, { ip })).status, 429, 'the 241st read is limited');
});

check('rate limit: per IP, resets when the window ends, and a request with no client IP is not limited or counted', async () => {
  const s = await makeShare();
  const ip = '203.0.113.9';
  const { id } = (await post(s, CODE, { ip })).json;
  for (let i = 1; i < 60; i++) await put(s, id, CODE, { ip });
  assert.equal((await put(s, id, CODE, { ip })).status, 429);
  assert.equal((await put(s, id, CODE, { ip: '203.0.113.10' })).status, 200, 'another IP is unaffected');
  s.clock.now = START + 61 * 1000;
  assert.equal((await put(s, id, CODE, { ip })).status, 200, 'a fresh window');
  const before = s.db.sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n;
  for (let i = 0; i < 70; i++) assert.equal((await put(s, id, CODE)).status, 200, 'no CF-Connecting-IP: not limited');
  assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, before, 'and not counted');
});

check('rate limit: the table holds a hash of the IP, never the address', async () => {
  const s = await makeShare();
  await post(s, CODE, { ip: '203.0.113.9' });
  await get(s, 'abcdefg', { ip: '2001:db8::7' });
  const keys = s.db.sqlite.prepare("SELECT key FROM rate_limits WHERE key LIKE 'share:%'").all().map((r) => r.key);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.match(key, /^share:(?:read|write):[0-9a-f]{16}$/);
  assert(!keys.join(' ').includes('203.0.113') && !keys.join(' ').includes('2001'));
});

check('a database failure is a generic 503 {error} and is logged without the code', async () => {
  const s = await makeShare();
  s.db.sqlite.exec('DROP TABLE share_links');
  const res = await get(s, 'abcdefg');
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'Short links are unavailable' });
  assert(s.logs.some((line) => /^share: /.test(line)));
  const write = await post(s, 'SECRETCODE');
  assert.equal(write.status, 503);
  assert(!s.logs.join(' ').includes('SECRETCODE'));
});

check('the daily cron deletes expired links and old limiter rows, and leaves live ones', async () => {
  const s = await makeShare();
  const { runDaily } = await load('worker/scheduler.js');
  const live = (await post(s, 'LIVE', { ip: '203.0.113.9' })).json.id;
  s.clock.now = START + 20 * DAY;
  const old = (await post(s, 'OLDER')).json.id;
  s.db.sqlite.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').run(START + 25 * DAY, old);
  s.clock.now = START + 26 * DAY;
  await get(s, live, { ip: '203.0.113.10' });
  await runDaily({ db: s.db, env: {}, now: () => s.clock.now, log: () => {} });
  assert.deepEqual(rows(s).map((r) => r.id), [live], 'only the 20-day-old save survives');
  const limits = s.db.sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'share:%'").get().n;
  assert.equal(limits, 1, 'the limiter row of the past window is gone, the current one stays');
  const { sweepShareLinks } = await load('worker/share.js');
  assert.deepEqual(await sweepShareLinks(s.db, s.clock.now), { links: 0, limits: 0 }, 'a second sweep finds nothing');
});

check('/tbc/<id>, /classic/<id>, /forever/<id> answer with the front page; other paths and methods do not', async () => {
  const { default: worker } = await load('worker/index.js');
  const asked = [];
  const env = { DB: createD1Fake(), ASSETS: { fetch: async (request) => { asked.push(new URL(request.url).pathname); return new Response('<html>front page</html>', { headers: { 'Content-Type': 'text/html' } }); } } };
  for (const version of ['tbc', 'classic', 'forever']) {
    const res = await worker.fetch(new Request(`${ORIGIN}/${version}/aB3dE5g`), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<html>front page</html>');
  }
  assert.deepEqual(asked, ['/', '/', '/'], 'the assets are asked for the front page, not for the link path');
  for (const other of ['/tbc', '/tbc/', '/tbc/a/b', '/wotlk/aB3dE5g', '/faq.html', '/app.css']) {
    asked.length = 0;
    await worker.fetch(new Request(`${ORIGIN}${other}`), env);
    assert.deepEqual(asked, [], `${other} is not rewritten`);
  }
  const post404 = await worker.fetch(new Request(`${ORIGIN}/tbc/aB3dE5g`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  assert.equal(post404.status, 404, 'only GET and HEAD are the page');
  const api = await worker.fetch(new Request(`${ORIGIN}/api/share?id=abcdefg`), env);
  assert.equal(api.status, 404, 'the API still answers through the Worker (no such link)');
});

async function main() {
  const filter = process.argv[2];
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error.stack.split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
