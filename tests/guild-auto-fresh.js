// Identity-change protection (lane B6b part 2a) makes linking and unlinking a sign-in identity a fresh-auth act on an account that holds the Owner seat or a staff role. The
// older suites link and unlink as their Guild Master all the time and are about something else, so their worlds are wrapped here: before such a request the session is
// given the matching grant straight in its row (no OAuth). The suites that ARE about fresh-auth (tests/guild/guild-b6b2-*.js) do not use this.
//   autoFresh(world)                                wraps world.req; world needs .db (the D1 stand-in), .clock ({ now }) and .req(method, path, { jar, ... })
//   grantIdentityChange(world, jar, change)         change: link_discord | unlink_discord | link_bnet | unlink_bnet
//   grantFor(world, jar, purpose, guildId, params)  any purpose: writes the grant on the session of the jar
//   Also wrapped: a hand-over (POST .../people/:uid/guild-master) and a guild delete (DELETE /api/guild/:gid) get their grant, so the older suites keep acting as the Owner.
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SESSION_COOKIE = '__Host-rs_session';
const ROUTES = [
  ['GET', /^\/auth\/login\?mode=link$/, 'link_discord'],
  ['GET', /^\/auth\/bnet\/login$/, 'link_bnet'],
  ['DELETE', /^\/auth\/discord$/, 'unlink_discord'],
  ['DELETE', /^\/auth\/bnet$/, 'unlink_bnet'],
];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const loadFresh = () => import(pathToFileURL(path.join(__dirname, '..', 'worker', 'fresh.js')).href);

async function grantFor(world, jar, purpose, guildId = null, params = {}, at) {
  if (!jar || !jar[SESSION_COOKIE]) return;
  const { freshHash } = await loadFresh();
  const hash = await freshHash({ purpose, guildId, params });
  world.db.sqlite.prepare('UPDATE sessions SET fresh_purpose = ?, fresh_hash = ?, fresh_at = ? WHERE token_hash = ?')
    .run(purpose, hash, at === undefined ? world.clock.now : at, sha256(jar[SESSION_COOKIE]));
}

// Only an account that is protected (the Owner seat or a staff role) needs the grant; leaving the others untouched keeps the old suites' "nothing else changed" dumps exact.
async function grantIdentityChange(world, jar, change) {
  if (!jar || !jar[SESSION_COOKIE]) return;
  const row = world.db.sqlite.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(sha256(jar[SESSION_COOKIE]));
  if (!row) return;
  const { isProtectedAccount } = await loadFresh();
  if (await isProtectedAccount(world.db, row.user_id)) await grantFor(world, jar, 'identity_change', null, { change });
}

// The Owner acts that need a fresh sign-in in every guild but a manual one: a hand-over and a guild delete. The grant is for exactly the act the request makes.
const OWNER_ACT_ROUTES = [
  ['POST', /^\/api\/guild\/(g_[A-Za-z0-9_-]{22})\/people\/(u_[A-Za-z0-9_-]{22})\/guild-master$/, (m) => ['handover', m[1], { targetUserId: m[2] }]],
  ['DELETE', /^\/api\/guild\/(g_[A-Za-z0-9_-]{22})$/, (m) => ['guild_delete', m[1], {}]],
];

function autoFresh(world) {
  const original = world.req.bind(world);
  world.req = async (method, urlPath, options = {}) => {
    const route = ROUTES.find(([verb, pattern]) => verb === method && pattern.test(urlPath));
    if (route) await grantIdentityChange(world, options.jar, route[2]);
    for (const [verb, pattern, describe] of OWNER_ACT_ROUTES) {
      const match = verb === method && pattern.exec(urlPath);
      if (match) {
        const [purpose, guildId, params] = describe(match);
        await grantFor(world, options.jar, purpose, guildId, params);
      }
    }
    return original(method, urlPath, options);
  };
  return world;
}

module.exports = { autoFresh, grantIdentityChange, grantFor, sha256, SESSION_COOKIE };
