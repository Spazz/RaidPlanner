import {
  HttpError, errorBody, errorResponse, hasJsonContentType, isCrossSite, jsonResponse, readJsonBody,
} from './http.js';
import { defaultRandomBytes } from './ids.js';
import { checkRateLimit, rateLimitMessage } from './ratelimit.js';
import { createRouter, paramsAreValid } from './router.js';
import { loadSession } from './session.js';
import { callback, deleteMe, guildPageRedirect, login, logout, me, updatePrefs } from './routes/auth.js';
import { bnetCallback, bnetLogin, createClaims, disconnectBnet, getBnet, withdrawClaim } from './routes/bnet.js';
import { approveClaim, listClaims, rejectClaim } from './routes/bnet-claims.js';
import { commitBnetRoster, getBnetSettings, previewBnetRoster, putBnetSettings } from './routes/bnet-import.js';
import { runScheduled } from './bnet-purge.js';
import { claimGuild, createGuild, getGuild } from './routes/guild.js';
import { blockPerson, getPeople, makeGuildMaster, restorePerson, setRoles } from './routes/people.js';
import { createTeam, patchTeam } from './routes/teams.js';
import { createScheduledRaids, getSchedule, putSchedule } from './routes/schedule.js';
import {
  deleteMySignup, deletePersonSignup, getMySignup, getSignups, lockSignups, putMySignup, putPersonSignup, unlockSignups,
} from './routes/signups.js';
import { createIdea, listIdeas } from './routes/roadmap.js';
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
import { getAttention } from './routes/attention.js';
import { getAudit } from './routes/audit.js';
import { createCalendarLink, getCalendarFeed, getCalendarStatus, revokeCalendarLink } from './routes/calendar.js';
import { getTrialReview } from './routes/trial.js';
import {
  LOOT_MAX_BODY, commitLoot, deleteLoot, getBalance, getLootItems, getLootPolicy, getLootRaids, getPersonLoot, getRaidLoot, patchLoot,
  previewLoot, putLootPolicy,
} from './routes/loot.js';

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
  // Battle.net link (Phase 5). login and callback are browser navigations: they read the session themselves and redirect instead of answering JSON.
  { method: 'GET', path: '/auth/bnet/login', auth: false, handler: bnetLogin },
  { method: 'GET', path: '/auth/bnet/callback', auth: false, handler: bnetCallback },
  { method: 'GET', path: '/auth/bnet', auth: true, handler: getBnet },
  { method: 'DELETE', path: '/auth/bnet', auth: true, handler: disconnectBnet },
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
  { method: 'POST', path: '/api/guild/:gid/roster/import/bnet/preview', auth: true, handler: previewBnetRoster },
  { method: 'POST', path: '/api/guild/:gid/roster/import/bnet/commit', auth: true, handler: commitBnetRoster, maxBody: COMMIT_MAX_BODY },
  { method: 'GET', path: '/api/guild/:gid/roster/:pid', auth: true, handler: getPerson },
  { method: 'GET', path: '/api/guild/:gid/roster/:pid/trial', auth: true, handler: getTrialReview },
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
  // Native sign-ups. Literal paths (lock, unlock) are registered before `:pid`.
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/signups', auth: true, handler: getSignups },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/signups/lock', auth: true, handler: lockSignups },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/signups/unlock', auth: true, handler: unlockSignups },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/signups/:pid', auth: true, handler: putPersonSignup },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/signups/:pid', auth: true, handler: deletePersonSignup },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/signup', auth: true, handler: getMySignup },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/signup', auth: true, handler: putMySignup },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/signup', auth: true, handler: deleteMySignup },
  // The weekly raid schedule of a team.
  { method: 'GET', path: '/api/guild/:gid/teams/:tid/schedule', auth: true, handler: getSchedule },
  { method: 'PUT', path: '/api/guild/:gid/teams/:tid/schedule', auth: true, handler: putSchedule },
  { method: 'POST', path: '/api/guild/:gid/teams/:tid/schedule/raids', auth: true, handler: createScheduledRaids },
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
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/loot', auth: true, handler: getRaidLoot },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/loot/preview', auth: true, handler: previewLoot, maxBody: LOOT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/loot', auth: true, handler: commitLoot, maxBody: LOOT_MAX_BODY },
  // Literal paths are registered before `:aid`, so "balance", "raids", "items", "person" and "policy" are never read as an award id.
  { method: 'GET', path: '/api/guild/:gid/loot/balance', auth: true, handler: getBalance },
  { method: 'GET', path: '/api/guild/:gid/loot/raids', auth: true, handler: getLootRaids },
  { method: 'GET', path: '/api/guild/:gid/loot/items', auth: true, handler: getLootItems },
  { method: 'GET', path: '/api/guild/:gid/loot/person/:pid', auth: true, handler: getPersonLoot },
  { method: 'GET', path: '/api/guild/:gid/loot/policy', auth: true, handler: getLootPolicy },
  { method: 'PUT', path: '/api/guild/:gid/loot/policy', auth: true, handler: putLootPolicy },
  { method: 'PATCH', path: '/api/guild/:gid/loot/:aid', auth: true, handler: patchLoot },
  { method: 'DELETE', path: '/api/guild/:gid/loot/:aid', auth: true, handler: deleteLoot },
  // Battle.net (Phase 5): character claims and the guild's Battle.net settings.
  { method: 'GET', path: '/api/guild/:gid/claims', auth: true, handler: listClaims },
  { method: 'POST', path: '/api/guild/:gid/claims', auth: true, handler: createClaims },
  { method: 'DELETE', path: '/api/guild/:gid/claims/:clid', auth: true, handler: withdrawClaim },
  { method: 'POST', path: '/api/guild/:gid/claims/:clid/approve', auth: true, handler: approveClaim },
  { method: 'POST', path: '/api/guild/:gid/claims/:clid/reject', auth: true, handler: rejectClaim },
  { method: 'GET', path: '/api/guild/:gid/bnet', auth: true, handler: getBnetSettings },
  { method: 'PUT', path: '/api/guild/:gid/bnet', auth: true, handler: putBnetSettings },
  // PM wave 1 (officer tools): the Activity log, the Needs attention home and the calendar feed. The feed file itself needs no session:
  // the unguessable token in its address is the credential (worker/routes/calendar.js).
  { method: 'GET', path: '/api/guild/:gid/audit', auth: true, handler: getAudit },
  { method: 'GET', path: '/api/guild/:gid/attention', auth: true, handler: getAttention },
  { method: 'GET', path: '/api/guild/:gid/calendar', auth: true, handler: getCalendarStatus },
  { method: 'POST', path: '/api/guild/:gid/calendar', auth: true, handler: createCalendarLink },
  { method: 'DELETE', path: '/api/guild/:gid/calendar', auth: true, handler: revokeCalendarLink },
  { method: 'GET', path: '/cal/:cal', auth: false, handler: getCalendarFeed },
  // App-wide (no guild): the idea box on the Future enhancements page.
  { method: 'GET', path: '/api/roadmap/ideas', auth: true, handler: listIdeas },
  { method: 'POST', path: '/api/roadmap/ideas', auth: true, handler: createIdea },
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
  // The daily Cron Trigger (wrangler.jsonc triggers.crons): the 30-day rule for Battle.net data.
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled({ db: env.DB, now: Date.now, log: (message) => console.log(message) }));
  },
};
