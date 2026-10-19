// Dev-only "View as": a Guild Master on a LOCAL run sees the app with the rights of another role. Three gates, all of which must hold, or this whole
// feature does not exist (dev routes answer 404, the cookie is ignored, the guild payload carries nothing):
//   1. env.DEV_VIEW_AS === '1' (never set in wrangler.jsonc; a pin test fails if it is),
//   2. the request's host is 127.0.0.1 or localhost,
//   3. (in loadGuildContext) the person's REAL rank in that guild is Guild Master. A stand-in can only narrow rights, never widen them.
import { parseCookies } from './http.js';
import { isId } from './ids.js';
import { isCustomRole } from './permissions.js';

export const VIEW_AS_COOKIE = '__Host-rs_viewas';
export const VIEW_AS_BUILTIN_ROLES = ['officer', 'team_lead', 'member'];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function viewAsEnabled(env, request) {
  if (!env || env.DEV_VIEW_AS !== '1') return false;
  try {
    return LOCAL_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

// "<gid>:<roleId>[:<teamId>]" -> { guildId, roleId, teamId } or null for anything malformed. Shape only: the rights check validates the rest.
export function parseViewAs(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const [guildId, roleId, teamId = null] = parts;
  if (!isId('g', guildId)) return null;
  if (!VIEW_AS_BUILTIN_ROLES.includes(roleId) && !isCustomRole(roleId)) return null;
  if (teamId !== null && !isId('t', teamId)) return null;
  return { guildId, roleId, teamId };
}

export const viewAsCookieValue = ({ guildId, roleId, teamId }) => `${guildId}:${roleId}${teamId ? `:${teamId}` : ''}`;

// The stand-in from the request, or null when the flag/host gate is closed or the cookie is absent/malformed.
export function readViewAs(env, request) {
  if (!viewAsEnabled(env, request)) return null;
  return parseViewAs(parseCookies(request.headers.get('Cookie'))[VIEW_AS_COOKIE]);
}
