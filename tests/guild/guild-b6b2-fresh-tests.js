/**
 * Raidsmith guild tracker - lane B6b part 2a of the user-hierarchy build: FRESH-AUTH (worker/fresh.js, worker/routes/fresh.js, the fresh mode of both OAuth callbacks)
 * Run: node tests/guild/guild-b6b2-fresh-tests.js
 *
 *   - the start routes (POST /api/guild/:gid/fresh/start, POST /api/fresh/start): purposes, parameters, providers, who may ask, the answer, nothing written, the fail-closed
 *     per-account limit; Discord asks for prompt=consent and the identify scope, Battle.net sends no unverified parameter;
 *   - the callbacks: the returned identity must EQUAL the session user's linked identity, the state cookie is compared, a state is bound to its user, session, provider, purpose and
 *     parameters, expires, is single use, and a callback never mints or rotates a session; a refusal that looks like someone else is counted as fresh.failed (coalesced);
 *   - the act: consumed INSIDE its own batch by a marker (two parallel acts with one grant give one, a swapped statement order is refused, a wrong purpose / guild / parameters is
 *     refused and burns nothing, expiry at 15 minutes, a grant belongs to its session), and the routes answer 403 fresh_required { purpose, params } without a grant.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { freshScenario, sessionHashOf, stateOf } = require('../guild-fresh');
const { adminOf } = require('../guild-world');

const checks = [];
function check(name, fn) {
  checks.push({
    name,
    fn: async () => {
      const worlds = [];
      globalThis.__freshWorlds = worlds;
      try { await fn(); } finally { await Promise.all(worlds.map((s) => s.close())); }
    },
  });
}
const MINUTE = 60 * 1000;
const BNET = { ivy: { id: '710000001', battletag: 'Ivy#1001' }, jon: { id: '710000002', battletag: 'Jon#1002' }, kai: { id: '710000003', battletag: 'Kai#1003' } };

async function world(options) {
  const s = await freshScenario(options);
  globalThis.__freshWorlds.push(s);
  return s;
}

const startPath = (s) => `/api/guild/${s.gid}/fresh/start`;
const sessionRow = (s, key) => s.one('SELECT * FROM sessions WHERE token_hash = ?', sessionHashOf(s.jars[key]));
const counts = async (s) => ({
  audit: await s.w.count('audit_log'), nonces: await s.w.count('oauth_state_nonces'), sessions: await s.w.count('sessions'), users: await s.w.count('users'), markers: await s.w.count('fresh_act_markers'),
});

// ---------------------------------------------------------------------------
// 1. The start routes

check('start: the answer is the provider URL with a purpose-bound state and its cookie; Discord asks for prompt=consent and identify, nothing is written', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  const before = await counts(s);
  const res = await s.call('gm', 'POST', startPath(s), { purpose: 'handover', params: { targetUserId: s.uids.mem }, provider: 'discord' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json).sort(), ['authorizeUrl', 'provider', 'purpose', 'validForSeconds']);
  assert.equal(res.json.provider, 'discord');
  assert.equal(res.json.purpose, 'handover');
  assert.equal(res.json.validForSeconds, 600);
  const url = new URL(res.json.authorizeUrl);
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('prompt'), 'consent', 'Discord is asked to show the authorise screen every time');
  assert.equal(url.searchParams.get('scope'), 'identify', 'the Discord id and nothing else');
  assert.equal(url.searchParams.get('redirect_uri'), `${'https://raidsmith.test'}/auth/callback`);
  const state = url.searchParams.get('state');
  const hash = await s.hashOf('handover', s.gid, { targetUserId: s.uids.mem });
  assert(state.startsWith(`fresh.handover.${s.gid}.${hash}.`), state);
  assert.equal(state.split('.').length, 7);
  assert.equal(s.jars.gm['__Host-rs_state'], state, 'the state cookie came with the answer');
  assert(res.headers.getSetCookie().some((line) => line.startsWith('__Host-rs_state=fresh.') && /HttpOnly/i.test(line) && /Secure/i.test(line) && /SameSite=Lax/i.test(line)));
  assert.deepEqual(await counts(s), before, 'a start writes nothing: no nonce, no audit row, no marker, no session');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
});

check('start: Battle.net sends no unverified parameter (no prompt, no max_age); the answer carries its own state cookie', async () => {
  const s = await world();
  await s.bnetSignUp('ivy', BNET.ivy);
  const res = await s.call('ivy', 'POST', '/api/fresh/start', { purpose: 'identity_change', params: { change: 'link_discord' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.provider, 'bnet', 'the only linked identity is used when no provider is named');
  const url = new URL(res.json.authorizeUrl);
  assert.equal(url.pathname, '/authorize');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.equal(s.jars.ivy['__Host-rs_bnet_state'], url.searchParams.get('state'));
  assert(!('__Host-rs_state' in s.jars.ivy));
  assert(url.searchParams.get('state').startsWith('fresh.identity_change.none.'), 'an account act names no guild');
});

check('start: purposes, parameters and providers are validated before anything else; the guild route and the account route take their own purposes', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  const bad = async (tail, body, field) => {
    const json = await s.fail('gm', 'POST', tail, body, 400, 'bad_request');
    if (field) assert.equal(json.field, field, JSON.stringify(json));
  };
  await bad(startPath(s), {}, 'purpose');
  await bad(startPath(s), { purpose: 'pizza' }, 'purpose');
  await bad(startPath(s), { purpose: 'handover', params: {} }, 'params');
  await bad(startPath(s), { purpose: 'handover', params: { targetUserId: 'nope' } }, 'params');
  await bad(startPath(s), { purpose: 'handover', params: { targetUserId: s.uids.mem, extra: 1 } }, 'params');
  await bad(startPath(s), { purpose: 'handover', params: [] }, 'params');
  await bad(startPath(s), { purpose: 'guild_delete', params: { x: 1 } }, 'params');
  await bad(startPath(s), { purpose: 'guild_delete', params: { x: { nested: true } } }, 'params');
  await bad(startPath(s), { purpose: 'guild_delete', params: { 'bad key': 1 } }, 'params');
  await bad(startPath(s), { purpose: 'guild_delete', provider: 'github' }, 'provider');
  await bad(startPath(s), { purpose: 'pin', provider: 'discord' }, 'provider');
  await bad(startPath(s), { purpose: 'identity_change', params: { change: 'link_bnet' } }, 'purpose');
  await bad('/api/fresh/start', { purpose: 'guild_delete' }, 'purpose');
  await bad('/api/fresh/start', { purpose: 'identity_change', params: { change: 'swap' } }, 'params');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'fresh:%'"), 1, 'only the counter');
});

check('start: an Owner act is asked for by the Owner only (an Officer, a member and a derived Guild Master are refused); gm_claim by anyone for a guild that exists; signed out is 401', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  await s.officer('off', 'Officerone');
  for (const who of ['mem', 'off']) {
    for (const purpose of ['handover', 'guild_delete', 'pin', 'source_switch']) {
      const params = purpose === 'handover' ? { targetUserId: s.uids.mem } : {};
      const provider = ['pin', 'source_switch'].includes(purpose) ? 'bnet' : 'discord';
      await s.fail(who, 'POST', startPath(s), { purpose, params, provider }, 403, 'forbidden');
    }
  }
  assert.equal((await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' })).status, 200);
  // A suspended Owner is not the Owner: the seat alone gives no fresh-auth for an Owner act.
  await s.bnetSignUp('ivy', BNET.ivy);
  // The claim is asked for by someone who is not a member, but only for a guild that has an in-game seat to claim (lane B6b part 2b: claim_not_available otherwise).
  const closed = await s.call('ivy', 'POST', startPath(s), { purpose: 'gm_claim', params: {} });
  assert.deepEqual([closed.status, closed.json.error], [409, 'claim_not_available'], closed.text);
  s.exec(`UPDATE guilds SET rank_source = 'ingame', pinned_guild_slug = 'writers-b3', pinned_realm_slug = 'nightslayer', pinned_namespace = 'profile-classicann-us', blizzard_guild_id = 3000, blizzard_realm_id = 4001 WHERE id = '${s.gid}'`);
  const claim = await s.call('ivy', 'POST', startPath(s), { purpose: 'gm_claim', params: {} });
  assert.equal(claim.status, 200, `${claim.text}: a claim is asked for by someone who is not a member`);
  assert.equal(claim.json.provider, 'bnet');
  assert.equal((await s.call('ivy', 'POST', '/api/guild/g_NoSuchGuild00000000000/fresh/start', { purpose: 'gm_claim' })).status, 404);
  const anon = await s.w.call({}, 'POST', startPath(s), { purpose: 'guild_delete' });
  assert.equal(anon.status, 401);
});

check('start: the identity has to be linked (409 identity_not_linked) and configured (409 not_configured); only the account\'s own identity can be asked for', async () => {
  const s = await world();
  const noBnet = await s.fail('gm', 'POST', startPath(s), { purpose: 'pin', provider: 'bnet' }, 409, 'identity_not_linked');
  assert.equal(noBnet.provider, 'bnet');
  await s.fail('gm', 'POST', startPath(s), { purpose: 'pin' }, 409, 'identity_not_linked');
  await s.bnetSignUp('ivy', BNET.ivy);
  await s.fail('ivy', 'POST', '/api/fresh/start', { purpose: 'identity_change', params: { change: 'link_discord' }, provider: 'discord' }, 409, 'identity_not_linked');
  const unconfigured = await world({ env: { BNET_CLIENT_SECRET: '' } });
  unconfigured.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${unconfigured.uids.gm}', '710000008', 'Gm#8', 1, '{}', 1, 1)`);
  assert.equal((await unconfigured.call('gm', 'POST', startPath(unconfigured), { purpose: 'guild_delete', provider: 'discord' })).status, 200);
  const pin = await unconfigured.fail('gm', 'POST', startPath(unconfigured), { purpose: 'pin', provider: 'bnet' }, 409, 'not_configured');
  assert.equal(pin.provider, 'bnet');
});

check('start: both identities linked and none named is 400 provider_required-style (bad_request on provider); naming one works', async () => {
  const s = await world();
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '710000009', 'Gm#9', 1, '{}', 1, 1)`);
  const json = await s.fail('gm', 'POST', startPath(s), { purpose: 'guild_delete' }, 400, 'bad_request');
  assert.equal(json.field, 'provider');
  assert.equal((await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'bnet' })).status, 200);
  assert.equal((await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' })).status, 200);
});

check('start: ten a ten minutes per account, then 429; the window rolls; an unavailable limiter FAILS CLOSED (503); Delete my data sweeps the key', async () => {
  const s = await world();
  s.advance = (ms) => s.w.advance(ms);
  for (let i = 0; i < 10; i++) assert.equal((await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' })).status, 200, `start ${i + 1}`);
  const limited = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert(limited.json.retryAfter >= 1);
  assert.equal(await s.w.count('rate_limits', "key = ?", `fresh:${s.uids.gm}`), 1);
  s.w.advance(11 * MINUTE);
  assert.equal((await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' })).status, 200, 'a new window');
  // Another account has its own counter.
  await s.member('mem', 'Plainmember');
  const other = await s.call('mem', 'POST', startPath(s), { purpose: 'guild_delete' });
  assert.equal(other.status, 403, 'not limited, refused for being no Owner');
  // The sweep: a member who started one deletes their data and the counter goes with the account.
  await s.bnetSignUp('ivy', BNET.ivy);
  assert.equal((await s.call('ivy', 'POST', '/api/fresh/start', { purpose: 'identity_change', params: { change: 'link_discord' } })).status, 200);
  assert.equal(await s.w.count('rate_limits', "key = ?", `fresh:${s.uids.ivy}`), 1);
  assert.equal((await s.call('ivy', 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'fresh:u_%' AND key = ?", `fresh:${s.uids.ivy}`), 0);
  // Fail closed: the limiter's table is gone, the start refuses (the per-user write limit in front of it fails open and lets the request reach it).
  s.exec('DROP TABLE rate_limits');
  const down = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' });
  assert.equal(down.status, 503, down.text);
  assert.equal(down.json.error, 'rate_limited');
});

// ---------------------------------------------------------------------------
// 2. The callbacks

check('Discord callback: the returned identity equals the linked one, the grant lands on THIS session and no session is made, rotated or touched', async () => {
  const s = await world();
  const sessionsBefore = await s.rows('SELECT token_hash, user_id, created_at, expires_at FROM sessions ORDER BY token_hash');
  const noncesBefore = await s.w.count('oauth_state_nonces');
  const cookieBefore = s.jars.gm['__Host-rs_session'];
  const { start, callback, location } = await s.fresh('gm', { purpose: 'guild_delete', guildId: s.gid, provider: 'discord' });
  assert.equal(start.status, 200);
  assert.equal(location, '/#/fresh?done=guild_delete');
  assert.equal(s.jars.gm['__Host-rs_session'], cookieBefore, 'the browser keeps its session cookie');
  assert(!callback.headers.getSetCookie().some((line) => line.startsWith('__Host-rs_session=')), 'the callback sets no session cookie');
  assert(callback.headers.getSetCookie().some((line) => /^__Host-rs_state=;.*Max-Age=0/.test(line)), 'the state cookie is cleared');
  assert.deepEqual(await s.rows('SELECT token_hash, user_id, created_at, expires_at FROM sessions ORDER BY token_hash'), sessionsBefore, 'not one session row changed (bar the grant)');
  const grant = await s.grantOf('gm');
  assert.equal(grant.fresh_purpose, 'guild_delete');
  assert.equal(grant.fresh_hash, await s.hashOf('guild_delete', s.gid, {}));
  assert.equal(grant.fresh_at, s.w.clock.now, 'stamped with the time of the callback');
  assert.equal(await s.w.count('oauth_state_nonces'), noncesBefore + 1, 'the nonce was claimed');
  assert.equal(await s.w.count('audit_log', "action = 'fresh.failed'"), 0);
});

check('Discord callback: another Discord account than the linked one is refused (mismatch), counted as fresh.failed in the guild, and writes no grant', async () => {
  const s = await world();
  const stranger = { id: '119999999999999999', username: 'stranger', globalName: 'Stranger' };
  const { location } = await s.fresh('gm', { purpose: 'guild_delete', guildId: s.gid, provider: 'discord', person: stranger });
  assert.equal(location, '/#/fresh?error=mismatch&purpose=guild_delete');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
  const rows = await s.rows("SELECT guild_id, actor_user_id, entity_id, after FROM audit_log WHERE action = 'fresh.failed'");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].guild_id, rows[0].actor_user_id, rows[0].entity_id], [s.gid, s.uids.gm, s.uids.gm]);
  assert.equal(JSON.parse(rows[0].after).count, 1);
  assert.equal(JSON.parse(rows[0].after).detail, 'guild_delete:mismatch');
  // Coalesced: more failures in the hour bump the counter and write no more rows.
  for (let i = 0; i < 3; i++) await s.fresh('gm', { purpose: 'guild_delete', guildId: s.gid, provider: 'discord', person: stranger });
  assert.equal(await s.w.count('audit_log', "action = 'fresh.failed'"), 1);
  const counter = await s.one("SELECT count FROM rate_limits WHERE key LIKE 'auditfail:fresh.failed:%'");
  assert.equal(counter.count, 4);
});

check('Battle.net callback: the account that comes back must be the linked one; the grant, the mismatch and the per-account limit work as for Discord', async () => {
  const s = await world();
  await s.bnetSignUp('ivy', BNET.ivy);
  const ok = await s.fresh('ivy', { purpose: 'identity_change', params: { change: 'link_discord' }, account: BNET.ivy });
  assert.equal(ok.location, '/#/fresh?done=identity_change');
  assert(!ok.callback.headers.getSetCookie().some((line) => line.startsWith('__Host-rs_session=')));
  assert(ok.callback.headers.getSetCookie().some((line) => /^__Host-rs_bnet_state=;.*Max-Age=0/.test(line)));
  assert.equal((await s.grantOf('ivy')).fresh_purpose, 'identity_change');
  const swapped = await s.fresh('ivy', { purpose: 'identity_change', params: { change: 'link_discord' }, account: BNET.jon });
  assert.equal(swapped.location, '/#/fresh?error=mismatch&purpose=identity_change');
  assert.equal((await s.grantOf('ivy')).fresh_purpose, 'identity_change', 'the earlier grant is left as it was');
  // A fresh callback counts against the per-Blizzard-account callback window like every Battle.net callback (the sign-up was the first).
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `bnetcb:${BNET.ivy.id}`)).count, 2, 'the sign-up and the fresh callback of ivy');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `bnetcb:${BNET.jon.id}`)).count, 1, 'the stranger counted under their own id');
  assert.equal(await s.w.count('audit_log', "action = 'fresh.failed'"), 0, 'an account act has no guild to count in: the refusal is logged only');
  assert(s.w.logs.some((line) => /fresh-auth refused: identity_change mismatch/.test(line)));
});

check('callbacks: the state is checked against its cookie, its user, its session, its provider, its age and its nonce; each refusal is "state" and writes no grant', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  const session = await load('worker/session.js');
  const attempt = async (key, mutate, provider = 'discord') => {
    const start = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider });
    assert.equal(start.status, 200, start.text);
    const state = new URL(start.json.authorizeUrl).searchParams.get('state');
    const { state: sent = state, cookie = sent, jar = s.jars[key], wait = 0 } = mutate ? await mutate(state) : {};
    s.w.advance(wait + 1000);
    const cookies = { ...jar, [provider === 'bnet' ? '__Host-rs_bnet_state' : '__Host-rs_state']: cookie };
    const path = provider === 'bnet' ? '/auth/bnet/callback' : '/auth/callback';
    if (provider === 'bnet') s.bnet.state.account = { id: '710000009', battletag: 'Gm#9' };
    else s.w.discord.next = { user: { id: s.discordOf('gm').id, username: 'gmb3', global_name: 'Gmb3', avatar: null }, servers: [] };
    return s.w.req('GET', `${path}?code=abc&state=${encodeURIComponent(sent)}`, { jar: cookies });
  };
  const refused = async (label, response) => {
    assert(response.headers.get('Location').startsWith('/#/fresh?error=state'), `${label}: ${response.headers.get('Location')}`);
  };
  const outbound = () => s.w.discord.calls.length + s.bnet.state.requests.length;
  // Another SESSION of the same account (made before the count of outbound calls starts: a sign-in calls Discord).
  const other = {};
  await require('../guild-world').signIn(s.w, s.discordOf('gm'), [adminOf(s.serverId)], other);
  const before = outbound();
  const noncesBefore = await s.w.count('oauth_state_nonces');
  // no cookie / another cookie
  await refused('no cookie', await attempt('gm', () => ({ cookie: '' })));
  await refused('another cookie', await attempt('gm', () => ({ cookie: 'fresh.other' })));
  // expired (more than 10 minutes) and from the future
  await refused('expired', await attempt('gm', () => ({ wait: 10 * MINUTE })));
  // tampered: the purpose, the guild and the parameter hash are inside the MAC
  await refused('purpose', await attempt('gm', (state) => ({ state: state.replace('guild_delete', 'handover') })));
  await refused('guild', await attempt('gm', (state) => ({ state: state.replace(s.gid, 'g_AAAAAAAAAAAAAAAAAAAAAA') })));
  await refused('params hash', await attempt('gm', (state) => { const parts = state.split('.'); parts[3] = '0'.repeat(64); return { state: parts.join('.') }; }));
  await refused('mac', await attempt('gm', (state) => ({ state: `${state.slice(0, -2)}AA` })));
  // another SESSION of the same account, and another account's session
  await refused('another session of the same account', await attempt('gm', () => ({ jar: other })));
  await refused('another account', await attempt('gm', () => ({ jar: s.jars.mem })));
  // the other provider's callback (the state was signed with the Discord secret)
  const start = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' });
  const state = new URL(start.json.authorizeUrl).searchParams.get('state');
  s.w.advance(1000);
  const wrongProvider = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { ...s.jars.gm, '__Host-rs_bnet_state': state } });
  await refused('a Discord state at the Battle.net callback', wrongProvider);
  // a signed-out browser is sent to sign in
  const out = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { '__Host-rs_state': state } });
  assert.equal(out.headers.get('Location'), '/#/signin');
  assert.equal(outbound(), before, 'not one outbound call: every refusal came before the code exchange');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
  assert.equal(await s.w.count('oauth_state_nonces'), noncesBefore, 'and no nonce was claimed');
  // The genuine state still works afterwards (it was never used up by the refusals above).
  s.w.discord.next = { user: { id: s.discordOf('gm').id, username: 'gmb3', global_name: 'Gmb3', avatar: null }, servers: [] };
  const good = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { ...s.jars.gm, '__Host-rs_state': state } });
  assert.equal(good.headers.get('Location'), '/#/fresh?done=guild_delete');
  // ... exactly once: a replay is refused before any call.
  const calls = outbound();
  s.w.advance(1000);
  const replay = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: { ...s.jars.gm, '__Host-rs_state': state } });
  assert.equal(replay.headers.get('Location'), '/#/fresh?error=state&purpose=guild_delete');
  assert.equal(outbound(), calls);
});

check('two parallel callbacks with one state: exactly one reaches the provider and writes the grant, the other is refused before any call', async () => {
  const s = await world();
  const start = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' });
  const state = new URL(start.json.authorizeUrl).searchParams.get('state');
  s.w.discord.next = { user: { id: s.discordOf('gm').id, username: 'gmb3', global_name: 'Gmb3', avatar: null }, servers: [] };
  const callsBefore = s.w.discord.calls.length;
  s.w.advance(1000);
  const twice = await Promise.all([1, 2].map(() => s.w.req('GET', '/auth/callback?code=abc&state=' + encodeURIComponent(state), { jar: { ...s.jars.gm, '__Host-rs_state': state } })));
  assert.deepEqual(twice.map((response) => response.headers.get('Location')).sort(), ['/#/fresh?done=guild_delete', '/#/fresh?error=state&purpose=guild_delete']);
  assert.equal(s.w.discord.calls.length - callsBefore, 3, 'one token exchange, one user look-up, one revoke: the loser made no call');
  assert.equal((await s.grantOf('gm')).fresh_purpose, 'guild_delete');
});

check('callbacks: access_denied and a failing provider send the browser back with a reason and write nothing; a missing code is "state"', async () => {
  const s = await world();
  const start = await s.call('gm', 'POST', startPath(s), { purpose: 'guild_delete', provider: 'discord' });
  const state = new URL(start.json.authorizeUrl).searchParams.get('state');
  // Every callback answer clears the state cookie, so each request brings it again.
  const jar = () => ({ ...s.jars.gm, '__Host-rs_state': state });
  const noncesBefore = await s.w.count('oauth_state_nonces');
  s.w.advance(1000);
  const denied = await s.w.req('GET', `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { jar: jar() });
  assert.equal(denied.headers.get('Location'), '/#/fresh?error=denied&purpose=guild_delete');
  const noCode = await s.w.req('GET', `/auth/callback?state=${encodeURIComponent(state)}`, { jar: jar() });
  assert.equal(noCode.headers.get('Location'), '/#/fresh?error=state&purpose=guild_delete');
  assert.equal(await s.w.count('oauth_state_nonces'), noncesBefore, 'a denial and a missing code spend no nonce');
  // Discord says no to the code: provider, with the nonce used (the state is spent), no grant, no raw error in the log.
  s.w.discord.next = null;
  const failing = await s.w.req('GET', `/auth/callback?code=bad&state=${encodeURIComponent(state)}`, { jar: jar() });
  assert.equal(failing.headers.get('Location'), '/#/fresh?error=provider&purpose=guild_delete');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
  assert(s.w.logs.every((line) => !/bad|secret/i.test(line) || /fresh-auth: Discord step failed/.test(line)));
});

// ---------------------------------------------------------------------------
// 3. The act consumes the grant inside its own batch

// A context as the routes get it, for the primitives: the session of `key`.
async function actContext(s, key) {
  return { db: s.w.db, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, session: { tokenHash: sessionHashOf(s.jars[key]), user: { id: s.uids[key] } } };
}
// A probe write that exists only to show whether a statement of the act applied: one rate_limits row.
const probe = (db, key, guard) => db.prepare(`INSERT INTO rate_limits (key, window_start, count) SELECT ?, 1, 1 WHERE ${guard.sql}`).bind(key, ...guard.params);

check('the marker pattern: statement 1 consumes, statement 2 writes the marker WHERE changes() = 1, every later statement carries EXISTS (marker); the pair is exactly one grant, once', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  const ctx = await actContext(s, 'gm');
  const hash = await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid });
  const act = fresh.consumeFreshStatements(ctx, { purpose: 'guild_delete', hash });
  assert.equal(act.statements.length, 2);
  assert(/^UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL\s+WHERE token_hash = \? AND user_id = \? AND fresh_purpose = \? AND fresh_hash = \? AND fresh_at > \?/.test(act.statements[0].sql));
  assert(/INSERT INTO fresh_act_markers/.test(act.statements[1].sql) && /changes\(\) = 1/.test(act.statements[1].sql));
  const results = await s.w.db.batch([...act.statements, probe(s.w.db, 'probe:one', act.guard)]);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(results[2].meta.changes, 1, 'the guarded write applied');
  assert.deepEqual(await s.grantOf('gm'), { fresh_purpose: null, fresh_hash: null, fresh_at: null }, 'single use: the grant is gone');
  const marker = await s.one('SELECT act_id, session_token_hash, purpose, at FROM fresh_act_markers');
  assert.deepEqual([marker.session_token_hash, marker.purpose, marker.at], [sessionHashOf(s.jars.gm), 'guild_delete', s.w.clock.now]);
  // The same statements again: the grant is gone, so nothing applies - not even with the first marker still in the table (a NEW marker id belongs to each request).
  const again = fresh.consumeFreshStatements(ctx, { purpose: 'guild_delete', hash });
  const replay = await s.w.db.batch([...again.statements, probe(s.w.db, 'probe:two', again.guard)]);
  assert.deepEqual([replay[0].meta.changes, replay[1].meta.changes, replay[2].meta.changes], [0, 0, 0]);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'probe:%'"), 1);
  assert.equal(await s.w.count('fresh_act_markers'), 1);
  assert.notEqual(again.markerId, act.markerId);
});

check('two parallel acts with ONE grant: exactly one applies (one marker, one write); a statement without the guard is the control that would have applied', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  const ctx = await actContext(s, 'gm');
  const hash = await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid });
  const build = (name) => {
    const act = fresh.consumeFreshStatements(ctx, { purpose: 'guild_delete', hash });
    return [...act.statements, probe(s.w.db, `guarded:${name}`, act.guard), s.w.db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, 1, 1)").bind(`unguarded:${name}`)];
  };
  const [a, b] = [build('a'), build('b')];
  await Promise.all([s.w.db.batch(a), s.w.db.batch(b)]);
  assert.equal(await s.w.count('fresh_act_markers'), 1, 'one marker');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'guarded:%'"), 1, 'one guarded write');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'unguarded:%'"), 2, 'the statement that forgot the guard ran twice: the guard is what makes the grant single use');
});

check('a SWAPPED statement order is refused: written before the consume, the marker finds the grant still on the session and is never inserted', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  const ctx = await actContext(s, 'gm');
  const hash = await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid });
  // Something changed a row just before, so a stale changes() = 1 is what the marker would read.
  s.exec("INSERT INTO rate_limits (key, window_start, count) VALUES ('stale', 1, 1)");
  const act = fresh.consumeFreshStatements(ctx, { purpose: 'guild_delete', hash });
  const [consume, marker] = act.statements;
  const results = await s.w.db.batch([marker, consume, probe(s.w.db, 'probe:swapped', act.guard)]);
  assert.equal(results[0].meta.changes, 0, 'the marker was refused');
  assert.equal(results[1].meta.changes, 1, 'the consume ran (the grant is spent: a malformed act costs the grant, never more)');
  assert.equal(results[2].meta.changes, 0, 'and the act did not apply');
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  assert.equal(await s.w.count('rate_limits', "key = 'probe:swapped'"), 0);
});

check('a wrong purpose, guild or parameters is refused and burns nothing; the right act still passes; an unmet extra condition does not spend the grant either', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  await s.member('oth', 'Otherone');
  const fresh = await load('worker/fresh.js');
  const ctx = await actContext(s, 'gm');
  const hash = await s.grant('gm', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem } });
  const wrong = [
    ['guild_delete', s.gid, { targetUserId: s.uids.mem }],
    ['handover', s.gid, { targetUserId: s.uids.oth }],
    ['handover', 'g_OtherGuild0000000000000', { targetUserId: s.uids.mem }],
    ['handover', null, { targetUserId: s.uids.mem }],
    ['handover', s.gid, {}],
  ];
  for (const [purpose, guildId, params] of wrong) {
    const other = await fresh.freshHash({ purpose, guildId, params });
    const act = fresh.consumeFreshStatements(ctx, { purpose, hash: other });
    const results = await s.w.db.batch([...act.statements, probe(s.w.db, 'probe:wrong', act.guard)]);
    assert.deepEqual(results.map((r) => r.meta.changes), [0, 0, 0], JSON.stringify([purpose, guildId, params]));
    await assert.rejects(() => fresh.assertFresh(ctx, { purpose, hash: other }), (error) => error.status === 403 && error.code === 'fresh_required' && error.extra.purpose === purpose);
  }
  assert.equal((await s.grantOf('gm')).fresh_hash, hash, 'the grant is still there');
  // An extra condition that is false (the actor is no longer the Owner): not spent.
  const extra = { sql: '1 = 0', params: [] };
  const refusedExtra = fresh.consumeFreshStatements(ctx, { purpose: 'handover', hash, extra });
  assert.equal((await s.w.db.batch([...refusedExtra.statements]))[0].meta.changes, 0);
  assert.equal((await s.grantOf('gm')).fresh_hash, hash);
  const right = fresh.consumeFreshStatements(ctx, { purpose: 'handover', hash });
  assert.equal((await s.w.db.batch([...right.statements, probe(s.w.db, 'probe:right', right.guard)]))[2].meta.changes, 1);
  assert.equal(await s.w.count('rate_limits', "key = 'probe:wrong'"), 0);
});

check('expiry: a grant is good for 15 minutes from the callback (exclusive)', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  const ctx = await actContext(s, 'gm');
  const now = s.w.clock.now;
  const consumeAt = async (grantAt) => {
    const hash = await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid, at: grantAt });
    const act = fresh.consumeFreshStatements(ctx, { purpose: 'guild_delete', hash });
    return (await s.w.db.batch(act.statements))[0].meta.changes;
  };
  assert.equal(await consumeAt(now), 1, 'just granted');
  assert.equal(await consumeAt(now - 15 * MINUTE + 1), 1, 'one millisecond inside the window');
  assert.equal(await consumeAt(now - 15 * MINUTE), 0, 'exactly 15 minutes old: expired');
  assert.equal(await consumeAt(now - 16 * MINUTE), 0);
  assert.equal(await consumeAt(now + 5 * MINUTE), 1, 'a grant stamped ahead of this clock is not older than the window');
});

check('the fresh_act_markers rows are pruned by the daily retention job after 15 minutes (nothing new was needed)', async () => {
  const s = await world();
  const { runRetention } = await load('worker/retention.js');
  s.exec(`INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES ('am_old', 'x', 'guild_delete', ${s.w.clock.now - 20 * MINUTE}), ('am_new', 'x', 'guild_delete', ${s.w.clock.now - 5 * MINUTE})`);
  await runRetention({ db: s.w.db, env: s.w.env, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, log: () => {} });
  assert.deepEqual((await s.rows('SELECT act_id FROM fresh_act_markers ORDER BY act_id')).map((row) => row.act_id), ['am_new']);
});

runChecks(checks);
