import {
  HttpError, errorBody, errorResponse, hasJsonContentType, isCrossSite, jsonResponse, readJsonBody,
} from './http.js';
import { defaultRandomBytes } from './ids.js';
import { checkRateLimit, rateLimitMessage } from './ratelimit.js';
import { createRouter, paramsAreValid } from './router.js';
import { loadSession } from './session.js';
import { callback, deleteMe, guildPageRedirect, login, logout, me, updatePrefs } from './routes/auth.js';
import { claimGuild, createGuild, getGuild } from './routes/guild.js';
import { blockPerson, getPeople, makeGuildMaster, restorePerson, setRoles } from './routes/people.js';
import { createTeam, patchTeam } from './routes/teams.js';
import {
  addCharacter, createPerson, deletePerson, getLinkable, getPerson, getRoster, makeMain, patchCharacter, patchPerson,
  removeCharacter, saveNotes,
} from './routes/roster.js';
import { commitRaidHelper, commitWcl, previewRaidHelper, previewWcl } from './routes/roster-import.js';
import {
  createRaid, deleteEvent, deleteManual, deletePlan, deleteRaid, deleteReport, getPlanner, getRaid, listRaids, putEvent, putManual, putPlan,
  putReport, recomputeRoute,
} from './routes/raids.js';
import {
  deleteDecision, getBackfillReports, getPersonAttendance, getPolicy, getReview, getTeamAttendance, postDecision, postUnmatched, putPolicy,
  putWclSettings,
} from './routes/attendance.js';

const COMMIT_MAX_BODY = 64 * 1024;
const PLAN_MAX_BODY = 32 * 1024;

const ROUTES = [
  { method: 'GET', path: '/guild', auth: false, handler: guildPageRedirect },
  { method: 'GET', path: '/guild/', auth: false, handler: guildPageRedirect },
  { method: 'GET', path: '/auth/login', auth: false, handler: login },
  { method: 'GET', path: '/auth/callback', auth: false, handler: callback },
  { method: 'GET', path: '/auth/me', auth: true, handler: me },
  { method: 'DELETE', path: '/auth/me', auth: true, handler: deleteMe },
  { method: 'PATCH', path: '/auth/prefs', auth: true, handler: updatePrefs },
  { method: 'POST', path: '/auth/logout', auth: true, handler: logout },
  { method: 'POST', path: '/api/guild', auth: true, handler: createGuild },
  { method: 'GET', path: '/api/guild/:gid', auth: true, handler: getGuild },
  { method: 'POST', path: '/api/guild/:gid/claim', auth: true, handler: claimGuild },
  { method: 'POST', path: '/api/guild/:gid/teams', auth: true, handler: createTeam },
  { method: 'PATCH', path: '/api/guild/:gid/teams/:tid', auth: true, handler: patchTeam },
  { method: 'GET', path: '/api/guild/:gid/people', auth: true, handler: getPeople },
  { method: 'PUT', path: '/api/guild/:gid/people/:uid/roles', auth: true, handler: setRoles },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/guild-master', auth: true, handler: makeGuildMaster },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: blockPerson },
  { method: 'DELETE', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: restorePerson },
  { method: 'GET', path: '/api/guild/:gid/roster', auth: true, handler: getRoster },
  { method: 'POST', path: '/api/guild/:gid/roster', auth: true, handler: createPerson },
  // Literal paths are registered before `:pid`, so "linkable" and "import" are never read as a person id.
  { method: 'GET', path: '/api/guild/:gid/roster/linkable', auth: true, handler: getLinkable },
  { method: 'POST', path: '/api/guild/:gid/roster/import/raid-helper/preview', auth: true, handler: previewRaidHelper },
  { method: 'POST', path: '/api/guild/:gid/roster/import/raid-helper/commit', auth: true, handler: commitRaidHelper, maxBody: COMMIT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/roster/import/wcl/preview', auth: true, handler: previewWcl },
  { method: 'POST', path: '/api/guild/:gid/roster/import/wcl/commit', auth: true, handler: commitWcl, maxBody: COMMIT_MAX_BODY },
  { method: 'GET', path: '/api/guild/:gid/roster/:pid', auth: true, handler: getPerson },
  { method: 'PATCH', path: '/api/guild/:gid/roster/:pid', auth: true, handler: patchPerson },
  { method: 'DELETE', path: '/api/guild/:gid/roster/:pid', auth: true, handler: deletePerson },
  { method: 'PUT', path: '/api/guild/:gid/roster/:pid/notes', auth: true, handler: saveNotes },
  { method: 'POST', path: '/api/guild/:gid/roster/:pid/characters', auth: true, handler: addCharacter },
  { method: 'PATCH', path: '/api/guild/:gid/roster/:pid/characters/:cid', auth: true, handler: patchCharacter },
  { method: 'DELETE', path: '/api/guild/:gid/roster/:pid/characters/:cid', auth: true, handler: removeCharacter },
  { method: 'POST', path: '/api/guild/:gid/roster/:pid/characters/:cid/main', auth: true, handler: makeMain },
  { method: 'GET', path: '/api/guild/:gid/raids', auth: true, handler: listRaids },
  { method: 'POST', path: '/api/guild/:gid/raids', auth: true, handler: createRaid },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid', auth: true, handler: getRaid },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid', auth: true, handler: deleteRaid },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/event', auth: true, handler: putEvent },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/event', auth: true, handler: deleteEvent },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/reports', auth: true, handler: putReport },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/reports/:code', auth: true, handler: deleteReport },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/planner', auth: true, handler: getPlanner },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/plan', auth: true, handler: putPlan, maxBody: PLAN_MAX_BODY },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/plan', auth: true, handler: deletePlan },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/manual', auth: true, handler: putManual, maxBody: PLAN_MAX_BODY },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/manual', auth: true, handler: deleteManual },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/recompute', auth: true, handler: recomputeRoute },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/decisions', auth: true, handler: postDecision },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/decisions/:pid', auth: true, handler: deleteDecision },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/unmatched', auth: true, handler: postUnmatched },
  { method: 'GET', path: '/api/guild/:gid/attendance/policy', auth: true, handler: getPolicy },
  { method: 'PUT', path: '/api/guild/:gid/attendance/policy', auth: true, handler: putPolicy },
  { method: 'PUT', path: '/api/guild/:gid/attendance/wcl', auth: true, handler: putWclSettings },
  { method: 'GET', path: '/api/guild/:gid/attendance/review', auth: true, handler: getReview },
  { method: 'GET', path: '/api/guild/:gid/attendance/team', auth: true, handler: getTeamAttendance },
  { method: 'GET', path: '/api/guild/:gid/attendance/person/:pid', auth: true, handler: getPersonAttendance },
  { method: 'GET', path: '/api/guild/:gid/attendance/backfill/reports', auth: true, handler: getBackfillReports },
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
  // Handlers log through this: it never throws and never gets secrets, codes or tokens.
  base.log = (message) => { try { log(message); } catch { /* logging must not throw */ } };

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
      ctx.body = await readJsonBody(request, match.route.maxBody);
    }
    if (match.route.auth) {
      ctx.session = await loadSession(ctx);
      if (!ctx.session) throw new HttpError(401, 'signed_out', 'Sign in to continue.');
      if (!paramsAreValid(match.params)) throw new HttpError(404, 'not_found', 'Not found.');
      if (request.method !== 'GET') {
        const limit = await checkRateLimit(ctx.db, ctx.session.user.id, ctx.now());
        if (limit.limited) {
          throw new HttpError(429, 'rate_limited', rateLimitMessage(`w:${ctx.session.user.id}`), { retryAfter: limit.retryAfter });
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
          const headers = error.extra.retryAfter !== undefined && (error.status === 429 || error.status === 503) ? { 'Retry-After': String(error.extra.retryAfter) } : {};
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
