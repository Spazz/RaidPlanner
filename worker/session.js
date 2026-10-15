import { base64url } from './ids.js';
import { parseCookies, serializeCookie } from './http.js';

export const SESSION_COOKIE = '__Host-rs_session';
export const STATE_COOKIE = 'rs_state';
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
  return serializeCookie(STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, path: '/auth' });
}

export function clearStateCookie() {
  return serializeCookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth' });
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
    manageableServers: row.manageable_servers,
    manageableUntil: row.manageable_until,
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
