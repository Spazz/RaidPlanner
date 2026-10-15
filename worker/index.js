import {
  HttpError, errorBody, errorResponse, hasJsonContentType, isCrossSite, jsonResponse, readJsonBody,
} from './http.js';
import { defaultRandomBytes } from './ids.js';
import { checkRateLimit } from './ratelimit.js';
import { createRouter } from './router.js';
import { loadSession } from './session.js';
import { callback, deleteMe, login, logout, me, updatePrefs } from './routes/auth.js';
import { createGuild, getGuild } from './routes/guild.js';
import { blockPerson, getPeople, makeGuildMaster, restorePerson, setRoles } from './routes/people.js';
import { createTeam, patchTeam } from './routes/teams.js';

const ROUTES = [
  { method: 'GET', path: '/auth/login', auth: false, handler: login },
  { method: 'GET', path: '/auth/callback', auth: false, handler: callback },
  { method: 'GET', path: '/auth/me', auth: true, handler: me },
  { method: 'DELETE', path: '/auth/me', auth: true, handler: deleteMe },
  { method: 'PATCH', path: '/auth/prefs', auth: true, handler: updatePrefs },
  { method: 'POST', path: '/auth/logout', auth: true, handler: logout },
  { method: 'POST', path: '/api/guild', auth: true, handler: createGuild },
  { method: 'GET', path: '/api/guild/:gid', auth: true, handler: getGuild },
  { method: 'POST', path: '/api/guild/:gid/teams', auth: true, handler: createTeam },
  { method: 'PATCH', path: '/api/guild/:gid/teams/:tid', auth: true, handler: patchTeam },
  { method: 'GET', path: '/api/guild/:gid/people', auth: true, handler: getPeople },
  { method: 'PUT', path: '/api/guild/:gid/people/:uid/roles', auth: true, handler: setRoles },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/guild-master', auth: true, handler: makeGuildMaster },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: blockPerson },
  { method: 'DELETE', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: restorePerson },
];

// deps: { db, env, fetch, now, randomBytes, log } -> { handle(request) }
export function createApp(deps) {
  const router = createRouter(ROUTES);
  const base = {
    db: deps.db,
    env: deps.env || {},
    fetch: deps.fetch || ((...args) => fetch(...args)),
    now: deps.now || Date.now,
    randomBytes: deps.randomBytes || defaultRandomBytes,
  };
  const log = deps.log || ((message) => console.error(message));

  async function dispatch(request) {
    const url = new URL(request.url);
    const match = router.resolve(request.method, url.pathname);
    if (!match) return errorResponse(404, 'not_found', 'Not found.');
    if (match.allowed) {
      return errorResponse(405, 'method_not_allowed', 'That method is not allowed here.', {}, { Allow: match.allowed.join(', ') });
    }

    const ctx = { ...base, request, params: match.params, body: {}, session: null };
    if (request.method !== 'GET') {
      if (isCrossSite(request)) throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
      if (!hasJsonContentType(request)) throw new HttpError(415, 'json_required', 'Content-Type must be application/json.');
      ctx.body = await readJsonBody(request);
    }
    if (match.route.auth) {
      ctx.session = await loadSession(ctx);
      if (!ctx.session) throw new HttpError(401, 'signed_out', 'Sign in to continue.');
      if (request.method !== 'GET') {
        const limit = await checkRateLimit(ctx.db, ctx.session.user.id, ctx.now());
        if (limit.limited) {
          throw new HttpError(429, 'rate_limited', 'Too many changes in a minute. Wait a moment and try again.',
            { retryAfter: limit.retryAfter });
        }
      }
    }
    return match.route.handler(ctx);
  }

  return {
    async handle(request) {
      try {
        return await dispatch(request);
      } catch (error) {
        if (error instanceof HttpError) {
          const headers = error.status === 429 ? { 'Retry-After': String(error.extra.retryAfter) } : {};
          return jsonResponse(errorBody(error.code, error.message, error.extra), error.status, headers);
        }
        // Never echo the error to the client.
        try { log(`worker error: ${error && error.message}`); } catch { /* logging must not throw */ }
        return errorResponse(500, 'server_error', 'Something went wrong on our side.');
      }
    },
  };
}

export default {
  fetch(request, env) {
    return createApp({ db: env.DB, env }).handle(request);
  },
};
