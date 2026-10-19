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
// Sign-in state: nonce + "." + HMAC-SHA256(key, nonce). The key is derived from the Discord client
// secret, so a state the Worker did not issue is rejected before any outbound Discord call.

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

async function stateMac(env, nonce) {
  const secret = new TextEncoder().encode(`raidsmith-state:${env.DISCORD_CLIENT_SECRET}`);
  const keyBytes = await crypto.subtle.digest('SHA-256', secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce));
  return base64url(new Uint8Array(mac));
}

export async function signState(env, nonce) {
  return `${nonce}.${await stateMac(env, nonce)}`;
}

export async function verifyState(env, state) {
  if (typeof state !== 'string' || !env.DISCORD_CLIENT_SECRET) return false;
  const parts = state.split('.');
  if (parts.length !== 2 || !NONCE_PATTERN.test(parts[0])) return false;
  return safeEqual(parts[1], await stateMac(env, parts[0]));
}

// ---------------------------------------------------------------------------
// Battle.net link state: the same nonce + MAC idea, but keyed from the Battle.net client secret and BOUND TO THE SIGNED-IN USER, so a
// state copied from one member's browser is refused in another's. Its own short-lived cookie, apart from the sign-in one.

export const BNET_STATE_COOKIE = '__Host-rs_bnet_state';

export function bnetStateCookie(state) {
  return serializeCookie(BNET_STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, path: '/' });
}

export function clearBnetStateCookie() {
  return serializeCookie(BNET_STATE_COOKIE, '', { maxAge: 0, path: '/' });
}

async function bnetStateMac(env, userId, nonce) {
  const secret = new TextEncoder().encode(`raidsmith-bnet-state:${env.BNET_CLIENT_SECRET}`);
  const keyBytes = await crypto.subtle.digest('SHA-256', secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${userId}.${nonce}`));
  return base64url(new Uint8Array(mac));
}

export async function signBnetState(env, userId, nonce) {
  return `${nonce}.${await bnetStateMac(env, userId, nonce)}`;
}

export async function verifyBnetState(env, userId, state) {
  if (typeof state !== 'string' || !env.BNET_CLIENT_SECRET || typeof userId !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 2 || !NONCE_PATTERN.test(parts[0])) return false;
  return safeEqual(parts[1], await bnetStateMac(env, userId, parts[0]));
}

// ---------------------------------------------------------------------------
// The other sign-in states (accounts, Phase 7a). Each MODE has its own shape and its own key domain, so a state minted for one flow never
// verifies in another, and the callback learns the mode only from a state whose MAC checked out:
//   Discord sign-in   nonce.mac                (above)                     key raidsmith-state:
//   Discord link      link.nonce.mac           bound to the signed-in user key raidsmith-discord-link-state:
//   Battle.net link   nonce.mac                (above, bound to the user)  key raidsmith-bnet-state:
//   Battle.net signin signin.nonce.mac                                     key raidsmith-bnet-signin-state:

async function macOf(secret, domain, message) {
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}:${secret}`));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

// "link.<nonce>.<mac>" -> { nonce, mac } for a state of that mode, else null.
function modeParts(state, mode) {
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== mode || !NONCE_PATTERN.test(parts[1])) return null;
  return { nonce: parts[1], mac: parts[2] };
}

// Which Discord flow a state belongs to ('link' | 'signin'), by shape only. The callback verifies the MAC of that mode before it trusts it.
export function discordStateMode(state) {
  return modeParts(state, 'link') ? 'link' : 'signin';
}

export async function signDiscordLinkState(env, userId, nonce) {
  return `link.${nonce}.${await macOf(env.DISCORD_CLIENT_SECRET, 'raidsmith-discord-link-state', `${userId}.${nonce}`)}`;
}

export async function verifyDiscordLinkState(env, userId, state) {
  const parts = modeParts(state, 'link');
  if (!parts || !env.DISCORD_CLIENT_SECRET || typeof userId !== 'string') return false;
  return safeEqual(parts.mac, await macOf(env.DISCORD_CLIENT_SECRET, 'raidsmith-discord-link-state', `${userId}.${parts.nonce}`));
}

// Which Battle.net flow a state belongs to ('signin' | 'link'), by shape only.
export function bnetStateMode(state) {
  return modeParts(state, 'signin') ? 'signin' : 'link';
}

export async function signBnetSigninState(env, nonce) {
  return `signin.${nonce}.${await macOf(env.BNET_CLIENT_SECRET, 'raidsmith-bnet-signin-state', nonce)}`;
}

export async function verifyBnetSigninState(env, state) {
  const parts = modeParts(state, 'signin');
  if (!parts || !env.BNET_CLIENT_SECRET) return false;
  return safeEqual(parts.mac, await macOf(env.BNET_CLIENT_SECRET, 'raidsmith-bnet-signin-state', parts.nonce));
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
