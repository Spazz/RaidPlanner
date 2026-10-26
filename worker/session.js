import { base64url } from './ids.js';
import { parseCookies, safeEqual, serializeCookie } from './http.js';
import { readViewAs } from './view-as.js';

export const SESSION_COOKIE = '__Host-rs_session';
export const STATE_COOKIE = '__Host-rs_state';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MANAGEABLE_TTL_MS = 30 * 60 * 1000;
export const STATE_TTL_SECONDS = 10 * 60;
const LAST_SEEN_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(randomBytes) {
  return base64url(randomBytes(32));
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000, path: '/' });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, path: '/' });
}

export function stateCookie(state) {
  return serializeCookie(STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, path: '/' });
}

export function clearStateCookie() {
  return serializeCookie(STATE_COOKIE, '', { maxAge: 0, path: '/' });
}

export function presentedToken(request) {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null;
}

// -> { tokenHash, user, manageableServers, manageableUntil, viewAs } or null when signed out or expired. user.discordId is null for an account
// that has not linked Discord (it signed in with Battle.net).
export async function loadSession({ db, env, request, now }) {
  const token = presentedToken(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db.prepare(
    `SELECT s.manageable_servers, s.manageable_until,
            u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar, u.prefs, u.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(tokenHash, now()).first();
  if (!row) return null;
  let { manageable_servers: manageableServers, manageable_until: manageableUntil } = row;
  if (manageableServers && !(manageableUntil > now())) {
    // The creator's server list is kept for 30 minutes only; drop it as soon as it is seen stale.
    manageableServers = null;
    manageableUntil = null;
    try {
      await db.prepare('UPDATE sessions SET manageable_servers = NULL, manageable_until = NULL WHERE token_hash = ?')
        .bind(tokenHash).run();
    } catch {
      // best effort: the next request tries again
    }
  }
  if (now() - row.last_seen_at >= LAST_SEEN_INTERVAL_MS) {
    try {
      await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now(), row.id).run();
    } catch {
      // last_seen_at is a convenience; never fail a request over it.
    }
  }
  return {
    tokenHash,
    user: {
      id: row.id,
      discordId: row.discord_id,
      username: row.username,
      globalName: row.global_name,
      displayName: row.display_name,
      avatar: row.avatar,
      prefs: row.prefs,
    },
    manageableServers,
    manageableUntil,
    // Dev "View as" (worker/view-as.js): null unless DEV_VIEW_AS is on, the host is local and the cookie is well formed.
    viewAs: readViewAs(env, request),
  };
}

// The servers the person may create a guild for, kept on the session for 30 minutes after sign-in.
// -> { servers: [{ id, name, icon, access }], stale }
export function readManageable(session, nowMs) {
  let servers = [];
  try {
    const parsed = JSON.parse(session.manageableServers);
    if (Array.isArray(parsed)) servers = parsed;
  } catch {
    servers = [];
  }
  const stale = !session.manageableServers || !(session.manageableUntil > nowMs);
  return { servers: stale ? [] : servers, stale };
}

// ---------------------------------------------------------------------------
// OAuth states. Each MODE has its own shape and its own MAC key domain, so a state minted for one flow never verifies in another, and the callback
// learns the mode only from a state whose MAC checked out:
//   Discord sign-in    <nonce>.<issued>.<mac>            key raidsmith-state:
//   Discord link       link.<nonce>.<issued>.<mac>       key raidsmith-discord-link-state:   bound to the signed-in user
//   Battle.net link    <nonce>.<issued>.<mac>            key raidsmith-bnet-state:           bound to the signed-in user
//   Battle.net sign-in signin.<nonce>.<issued>.<mac>     key raidsmith-bnet-signin-state:
//   fresh-auth         fresh.<purpose>.<guild|none>.<params hash>.<nonce>.<issued>.<mac>   lane B6b part 2a (signFreshState below), key raidsmith-fresh-state:<purpose>,
//                      bound to the signed-in user AND the session that started it, the purpose, the guild and the SHA-256 of the act's parameters
// <issued> is the issue time in milliseconds and is part of the MAC'd text. A state is good for STATE_TTL_MS after it and not more than
// STATE_FUTURE_SKEW_MS before it; an older or future-dated state is refused like a bad MAC. The keys derive from the provider's client secret, so a
// state this Worker did not issue is refused before any outbound call. Single use is claimStateNonce: a callback claims the nonce AFTER the MAC and
// age checks and BEFORE the code exchange. The begin routes write nothing.

export const STATE_TTL_MS = STATE_TTL_SECONDS * 1000;
const STATE_FUTURE_SKEW_MS = 60 * 1000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ISSUED_PATTERN = /^(?:0|[1-9][0-9]{0,14})$/;

async function macOf(secret, domain, message) {
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}:${secret}`));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

// The text a MAC covers: the nonce and the issue time, behind the user id for a state bound to a user and behind any further bound facts (`bind`, fresh-auth only).
const macText = (userId, nonce, issuedAt, bind = []) => [...(userId === undefined ? [] : [userId]), ...bind, nonce, issuedAt].join('.');

// The last three dot-separated parts of any state are <nonce>.<issued>.<mac>, whatever the mode prefix -> { nonce, issuedAt, mac } or null.
function tailOf(parts) {
  if (parts.length < 3) return null;
  const [nonce, issued, mac] = parts.slice(-3);
  if (!NONCE_PATTERN.test(nonce) || !ISSUED_PATTERN.test(issued)) return null;
  return { nonce, issuedAt: Number(issued), mac };
}

// A state of exactly this mode's shape (mode null = no prefix) -> { nonce, issuedAt, mac }, else null.
function stateParts(state, mode) {
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== (mode ? 4 : 3) || (mode && parts[0] !== mode)) return null;
  return tailOf(parts);
}

function isCurrent(issuedAt, now) {
  if (!Number.isFinite(now)) return false;
  const age = now - issuedAt;
  return age >= -STATE_FUTURE_SKEW_MS && age <= STATE_TTL_MS;
}

// The two halves every mode is built from. The fresh-auth pair (signFreshState / verifyFreshState below) adds `bind`: more facts the MAC covers.
async function signStateWith({ secret, domain, mode, userId, nonce, issuedAt, bind }) {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('issuedAt must be a millisecond timestamp');
  return `${mode ? `${mode}.` : ''}${nonce}.${issuedAt}.${await macOf(secret, domain, macText(userId, nonce, issuedAt, bind))}`;
}

async function verifyStateWith({ secret, domain, mode, userId, state, now }) {
  const parts = stateParts(state, mode);
  if (!parts || !secret || !isCurrent(parts.issuedAt, now)) return false;
  return safeEqual(parts.mac, await macOf(secret, domain, macText(userId, parts.nonce, parts.issuedAt)));
}

// Single use. The first call for a state's nonce records its SHA-256 and returns true; every later call (a replay) returns false. Call it only for a
// state that passed its verify, before any outbound call. The row's created_at is never earlier than the state's issue time, so the retention job
// (OAUTH_NONCE_TTL_MS = STATE_TTL_MS) cannot drop a nonce while its state could still pass the age check. A D1 failure returns false too: a state
// that cannot be shown unused is refused.
export async function claimStateNonce(db, state, now) {
  const tail = typeof state === 'string' ? tailOf(state.split('.')) : null;
  if (!tail || !Number.isFinite(now)) return false;
  try {
    const result = await db.prepare(
      'INSERT INTO oauth_state_nonces (nonce_hash, created_at, used_at) VALUES (?, ?, ?) ON CONFLICT(nonce_hash) DO NOTHING',
    ).bind(await hashToken(tail.nonce), Math.max(now, tail.issuedAt), now).run();
    return result.meta.changes === 1;
  } catch {
    return false;
  }
}

// Discord sign-in.
export function signState(env, nonce, issuedAt) {
  return signStateWith({ secret: env.DISCORD_CLIENT_SECRET, domain: 'raidsmith-state', mode: null, nonce, issuedAt });
}

export function verifyState(env, state, now) {
  return verifyStateWith({ secret: env.DISCORD_CLIENT_SECRET, domain: 'raidsmith-state', mode: null, state, now });
}

// Discord link, bound to the member who starts it, so a state copied into another browser is refused there.
export function signDiscordLinkState(env, userId, nonce, issuedAt) {
  if (typeof userId !== 'string') throw new TypeError('a link state is bound to a user id');
  return signStateWith({ secret: env.DISCORD_CLIENT_SECRET, domain: 'raidsmith-discord-link-state', mode: 'link', userId, nonce, issuedAt });
}

export async function verifyDiscordLinkState(env, userId, state, now) {
  if (typeof userId !== 'string') return false;
  return verifyStateWith({ secret: env.DISCORD_CLIENT_SECRET, domain: 'raidsmith-discord-link-state', mode: 'link', userId, state, now });
}

// Battle.net link, bound to the signed-in user too. Its own short-lived cookie, apart from the sign-in one.
export const BNET_STATE_COOKIE = '__Host-rs_bnet_state';

export function bnetStateCookie(state) {
  return serializeCookie(BNET_STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, path: '/' });
}

export function clearBnetStateCookie() {
  return serializeCookie(BNET_STATE_COOKIE, '', { maxAge: 0, path: '/' });
}

export function signBnetState(env, userId, nonce, issuedAt) {
  if (typeof userId !== 'string') throw new TypeError('a link state is bound to a user id');
  return signStateWith({ secret: env.BNET_CLIENT_SECRET, domain: 'raidsmith-bnet-state', mode: null, userId, nonce, issuedAt });
}

export async function verifyBnetState(env, userId, state, now) {
  if (typeof userId !== 'string') return false;
  return verifyStateWith({ secret: env.BNET_CLIENT_SECRET, domain: 'raidsmith-bnet-state', mode: null, userId, state, now });
}

// Battle.net sign-in.
export function signBnetSigninState(env, nonce, issuedAt) {
  return signStateWith({ secret: env.BNET_CLIENT_SECRET, domain: 'raidsmith-bnet-signin-state', mode: 'signin', nonce, issuedAt });
}

export function verifyBnetSigninState(env, state, now) {
  return verifyStateWith({ secret: env.BNET_CLIENT_SECRET, domain: 'raidsmith-bnet-signin-state', mode: 'signin', state, now });
}

// Fresh-auth (lane B6b part 2a, worker/fresh.js): a sign-in done NOW to prove the person at the keyboard holds an identity linked to the signed-in account, before a
// sensitive act. The state is minted by POST /api/guild/:gid/fresh/start (or /api/fresh/start), and its MAC covers
//   the provider's secret (DISCORD_CLIENT_SECRET / BNET_CLIENT_SECRET: a state for one provider never verifies at the other),
//   a key DOMAIN PER PURPOSE (raidsmith-fresh-state:<purpose>),
//   the user, the SESSION (its token hash: a state copied into another browser or session is refused), the provider, the purpose, the guild ("none" for an account act),
//   the SHA-256 of the act's parameters (worker/fresh.js freshHash: the hand-over target, the identity change, ...), the nonce and the issue time.
// The same 10-minute window and single-use nonce as every other state. The callbacks learn purpose, guild and parameter hash only from a state whose MAC checked out.
const FRESH_DOMAIN = 'raidsmith-fresh-state';
const FRESH_PURPOSE_PATTERN = /^[a-z][a-z_]{2,23}$/;
const FRESH_GUILD_PATTERN = /^(?:none|g_[A-Za-z0-9_-]{22})$/;
const FRESH_HASH_PATTERN = /^[0-9a-f]{64}$/;
const FRESH_PROVIDERS = ['discord', 'bnet'];

function freshSecret(env, provider) {
  if (provider === 'discord') return env.DISCORD_CLIENT_SECRET;
  if (provider === 'bnet') return env.BNET_CLIENT_SECRET;
  return undefined;
}

// facts: { provider, userId, tokenHash, purpose, guildId (null = an account act), paramsHash, nonce, issuedAt }
export function signFreshState(env, facts) {
  const { provider, userId, tokenHash, purpose, guildId, paramsHash, nonce, issuedAt } = facts;
  if (!FRESH_PROVIDERS.includes(provider)) throw new TypeError('unknown fresh-auth provider');
  if (typeof userId !== 'string' || typeof tokenHash !== 'string') throw new TypeError('a fresh-auth state is bound to a user and a session');
  if (!FRESH_PURPOSE_PATTERN.test(purpose) || !FRESH_HASH_PATTERN.test(paramsHash) || !FRESH_GUILD_PATTERN.test(guildId || 'none')) throw new TypeError('bad fresh-auth facts');
  const guild = guildId || 'none';
  return signStateWith({
    secret: freshSecret(env, provider), domain: `${FRESH_DOMAIN}:${purpose}`, mode: `${FRESH_MODE}.${purpose}.${guild}.${paramsHash}`, userId, nonce, issuedAt,
    bind: [provider, tokenHash, purpose, guild, paramsHash],
  });
}

// -> { purpose, guildId (null = none), paramsHash } for a state this Worker signed for exactly this provider, user and session, still in its window; else null.
export async function verifyFreshState(env, { provider, userId, tokenHash, state, now }) {
  const secret = freshSecret(env, provider);
  if (!secret || typeof userId !== 'string' || typeof tokenHash !== 'string' || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 7 || parts[0] !== FRESH_MODE) return null;
  const [, purpose, guild, paramsHash] = parts;
  const tail = tailOf(parts);
  if (!tail || !FRESH_PURPOSE_PATTERN.test(purpose) || !FRESH_GUILD_PATTERN.test(guild) || !FRESH_HASH_PATTERN.test(paramsHash)) return null;
  if (!isCurrent(tail.issuedAt, now)) return null;
  const expected = await macOf(secret, `${FRESH_DOMAIN}:${purpose}`, macText(userId, tail.nonce, tail.issuedAt, [provider, tokenHash, purpose, guild, paramsHash]));
  if (!safeEqual(tail.mac, expected)) return null;
  return { purpose, guildId: guild === 'none' ? null : guild, paramsHash };
}

// Which flow a state belongs to, by shape only; the callback verifies the MAC of that mode before it trusts it. A state starting "fresh." is its own
// mode and is recognised BEFORE the default branch of both functions, so it can never be taken for a link or a sign-in (verifyStateWith needs the
// exact shape of its own mode, and "fresh" is not a nonce). The fresh-auth callbacks (routes/auth.js discordFreshCallback, routes/bnet.js bnetFreshCallback) take it from there.
export const FRESH_MODE = 'fresh';
const isFreshShaped = (state) => typeof state === 'string' && state.startsWith(`${FRESH_MODE}.`);

// 'link' | 'signin' | 'fresh'
export function discordStateMode(state) {
  if (isFreshShaped(state)) return FRESH_MODE;
  return stateParts(state, 'link') ? 'link' : 'signin';
}

// 'signin' | 'link' | 'fresh'
export function bnetStateMode(state) {
  if (isFreshShaped(state)) return FRESH_MODE;
  return stateParts(state, 'signin') ? 'signin' : 'link';
}

// Starting a session. The statements for one sign-in, to go into the same DB.batch as the user write:
// expired sessions and stale creator lists are swept, the session the browser presented (if any) is deleted so a sign-in never keeps an
// earlier token alive (session fixation), and the new session is inserted for the user the SQL expression `userId` names.
// manageable: the creator's server list ([...] or null) kept 30 minutes on this session.
export function startSessionStatements(db, { userId, tokenHash, earlierHash, now, manageable }) {
  return [
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare(
      'UPDATE sessions SET manageable_servers = NULL, manageable_until = NULL WHERE manageable_until IS NOT NULL AND manageable_until <= ?',
    ).bind(now),
    ...(earlierHash ? [db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(earlierHash)] : []),
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, manageable_servers, manageable_until)
       VALUES (?, ${userId.sql}, ?, ?, ?, ?)`,
    ).bind(
      tokenHash, ...userId.params, now, now + SESSION_TTL_MS,
      manageable ? JSON.stringify(manageable) : null, manageable ? now + MANAGEABLE_TTL_MS : null,
    ),
  ];
}
