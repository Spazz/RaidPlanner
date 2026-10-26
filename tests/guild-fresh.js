// Fixtures for the fresh-auth suites (lane B6b part 2a): the B3 scenario guild with Battle.net configured against tools/fake-battlenet.js, and helpers that drive the real
// OAuth flows (start route -> provider -> callback) or, for suites that are about something else, write a grant straight into the session row.
//   const s = await freshScenario();            the scenario of tests/guild-b3-world.js (+ s.bnet = the fake, s.close()); Discord people are s.discordOf(key)
//   await s.bnetSignUp(key, account)            a NEW account made by Battle.net sign-in (no Discord); s.jars[key] / s.uids[key] are set
//   await s.linkBnet(key, account)              link-mode Battle.net for a signed-in account -> the callback's Location
//   await s.linkDiscord(key)                    link-mode Discord for a signed-in account -> the callback's Location
//   await s.fresh(key, { purpose, params, guildId, provider, account })   the whole fresh flow: start, provider, callback -> { start, location }
//   await s.grant(key, { purpose, params, guildId })                      writes the grant on the session row (no OAuth): for suites about the act
//   await s.grantOf(key)                                                   -> { fresh_purpose, fresh_hash, fresh_at } of the session
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFakeBattlenet } = require('../tools/fake-battlenet');
const { ORIGIN, signIn } = require('./guild-world');
const { discord, load, scenario } = require('./guild-b3-world');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sessionHashOf = (jar) => sha256(jar['__Host-rs_session']);

const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');

async function freshScenario(options = {}) {
  const bnet = createFakeBattlenet();
  await new Promise((resolve) => bnet.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bnet.server.address().port}`;
  const s = await scenario({
    ...options,
    autoFresh: false,
    env: {
      BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`, BNET_API_BASE: base, ...(options.env || {}),
    },
    wrapFetch: (discordFetch) => (url, init) => {
      const host = new URL(String(url)).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? fetch(url, init) : discordFetch(url, init);
    },
  });
  s.bnet = bnet;
  s.discordOf = (key) => discord(key);
  s.close = async () => {
    const closed = new Promise((resolve) => bnet.server.close(resolve));
    bnet.server.closeAllConnections();
    await closed;
  };
  s.sessionHash = (key) => sessionHashOf(s.jars[key]);

  s.bnetSignUp = async (key, account) => {
    bnet.state.account = account;
    const jar = {};
    const login = await s.w.req('GET', '/auth/bnet/login?mode=signin', { jar });
    const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
    assert.equal(callback.headers.get('Location'), '/#/', 'the Battle.net sign-up worked');
    s.jars[key] = jar;
    s.uids[key] = (await s.w.call(jar, 'GET', '/auth/me')).json.user.id;
    return s.uids[key];
  };
  s.linkBnet = async (key, account) => {
    bnet.state.account = account;
    s.w.advance(2000);
    const login = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars[key] });
    if (!/authorize/.test(login.headers.get('Location') || '')) return login.headers.get('Location');
    const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar: s.jars[key] });
    return callback.headers.get('Location');
  };
  s.linkDiscord = async (key, person = discord(key)) => {
    s.w.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers: [] };
    s.w.advance(2000);
    const login = await s.w.req('GET', '/auth/login?mode=link', { jar: s.jars[key] });
    if (!/authorize/.test(login.headers.get('Location') || '')) return login.headers.get('Location');
    const callback = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar: s.jars[key] });
    return callback.headers.get('Location');
  };

  // The fresh flow end to end. provider 'discord' answers with the person of `key` (or `person`), 'bnet' with `account`. guildId given = the guild route, left out = the account route.
  s.fresh = async (key, { purpose, params = {}, guildId = null, provider, account, person, state: stateWanted } = {}) => {
    const path = guildId ? `/api/guild/${guildId}/fresh/start` : '/api/fresh/start';
    s.w.advance(2000);
    const start = await s.w.call(s.jars[key], 'POST', path, { purpose, params, ...(provider ? { provider } : {}) });
    if (start.status !== 200) return { start, location: null };
    const authorize = new URL(start.json.authorizeUrl);
    const state = stateWanted || authorize.searchParams.get('state');
    s.w.advance(2000);
    let callback;
    if (start.json.provider === 'discord') {
      const who = person || discord(key);
      s.w.discord.next = { user: { id: who.id, username: who.username, global_name: who.globalName, avatar: null }, servers: [] };
      callback = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[key] });
    } else {
      if (account) bnet.state.account = account;
      callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[key] });
    }
    return { start, callback, location: callback.headers.get('Location') };
  };

  s.hashOf = async (purpose, guildId, params) => (await load('worker/fresh.js')).freshHash({ purpose, guildId, params });
  s.grant = async (key, { purpose, params = {}, guildId = null, at } = {}) => {
    const hash = await s.hashOf(purpose, guildId, params);
    s.w.db.sqlite.prepare('UPDATE sessions SET fresh_purpose = ?, fresh_hash = ?, fresh_at = ? WHERE token_hash = ?')
      .run(purpose, hash, at === undefined ? s.w.clock.now : at, sessionHashOf(s.jars[key]));
    return hash;
  };
  s.grantOf = async (key) => s.one('SELECT fresh_purpose, fresh_hash, fresh_at FROM sessions WHERE token_hash = ?', sessionHashOf(s.jars[key]));
  return s;
}

module.exports = { freshScenario, sha256, sessionHashOf, stateOf, signIn };
