import { base64url } from './ids.js';
import { parseCookies, safeEqual, serializeCookie } from './http.js';

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

// -> { tokenHash, user, manageableServers, manageableUntil } or null when signed out or expired.
export async function loadSession({ db, request, now }) {
  const token = presentedToken(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db.prepare(
    `SELECT s.manageable_servers, s.manageable_until,
            u.id, u.discord_id, u.username, u.global_name, u.avatar, u.prefs, u.last_seen_at
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
      avatar: row.avatar,
      prefs: row.prefs,
    },
    manageableServers,
    manageableUntil,
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
