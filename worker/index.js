import {
  HttpError, errorBody, errorResponse, hasJsonContentType, isCrossSite, jsonResponse, readJsonBody,
} from './http.js';
import { defaultRandomBytes } from './ids.js';
import { checkRateLimit, rateLimitMessage } from './ratelimit.js';
import { createRouter, paramsAreValid } from './router.js';
import { loadSession } from './session.js';
import { callback, deleteMe, guildPageRedirect, login, logout, me, providers, updatePrefs } from './routes/auth.js';
import { lookupAccounts, patchMe, putReminderOptOut, setPersonAccount, unlinkDiscord } from './routes/accounts.js';
import { bnetCallback, bnetLogin, createClaims, disconnectBnet, getBnet, withdrawClaim } from './routes/bnet.js';
import { approveClaim, listClaims, rejectClaim } from './routes/bnet-claims.js';
import { commitBnetRoster, getBnetSettings, previewBnetRoster, putBnetSettings } from './routes/bnet-import.js';
import { runCron } from './scheduler.js';
import { claimGuild, createGuild, getGuild, patchGuild } from './routes/guild.js';
import { deleteGuild, dismissOnboarding, exportGuild } from './routes/guild-data.js';
import { blockPerson, getPeople, makeGuildMaster, restorePerson, setRoles, syncPerson } from './routes/people.js';
import { createRole, deleteRole, getRoles, resetRole, updateRole } from './routes/roles.js';
import { getDiscord, putMaps, syncEveryone } from './routes/discord.js';
import { createGuestLink, getGuestView, leaveGuest, listGuestLinks, redeemGuestLink, revokeGuestLink } from './routes/guests.js';
import { deleteViewAs, getViewerPreview, putViewAs } from './routes/dev-view-as.js';
import { getPublicSettings, getPublicView, putPublicSettings } from './routes/public.js';
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
import { commitCsv, previewCsv } from './routes/roster-import-csv.js';
import { closeIntent, deleteIntentPick, getIntent, openIntent, putIntentPick } from './routes/intent.js';
import { getRecruiting, putRecruitTargets } from './routes/recruiting.js';
import {
  acceptApplication, deleteApplication, getApplyForm, getApplySettings, listApplications, patchApplication, putApplySettings, submitApplication,
} from './routes/applications.js';
import {
  createRaid, deleteEvent, deleteManual, deletePlan, deleteRaid, deleteReport, getPlanner, getRaid, listRaids, patchRaid, putEvent, putManual, putPlan,
  putReport, recomputeRoute,
} from './routes/raids.js';
import {
  deleteDecision, getBackfillReports, getPersonAttendance, getPolicy, getReview, getTeamAttendance, postDecision, postUnmatched, putPolicy,
  putWclSettings,
} from './routes/attendance.js';
import { deleteDismissal, getAttention, getAttentionWeek, postDismissal } from './routes/attention.js';
import { getStanding, putStanding } from './routes/standing.js';
import { confirmSeat, declineSeat, getPublishedRoster, publishRoster, unpublishRoster } from './routes/roster-publish.js';
import { getAudit } from './routes/audit.js';
import { getNotifications, postTestNotification, putTeamNotifications } from './routes/notifications.js';
import { createCalendarLink, getCalendarFeed, getCalendarStatus, revokeCalendarLink } from './routes/calendar.js';
import { getTrialReview } from './routes/trial.js';
import { deleteNotice, getMyNotices, getNotices, postNotice, putNotice } from './routes/away.js';
import {
  LOOT_MAX_BODY, commitLoot, deleteLoot, getBalance, getLootAward, getLootFix, getLootHub, getLootItem, getLootItems, getLootPolicy, getLootRaids,
  getPersonLoot, getRaidLoot, patchLoot, postLootFixKeep, previewLoot, putLootPolicy,
} from './routes/loot.js';
import { getLootBoard, postManualAward, putLootList } from './routes/loot-board.js';
import { createApiKey, listApiKeys, revokeApiKey } from './routes/api-keys.js';
import { getApiData } from './routes/api-v1.js';
import { getTeamProgress } from './routes/progress.js';
import { dismissRankSuggestion, putPersonRank } from './routes/ranks.js';
import { getDuties, putDuties } from './routes/duties.js';
import { createJoinLink, deleteGuestSignup, listJoinLinks, revokeJoinLink, submitJoin, viewJoin } from './routes/join.js';
import { getLaunch, putLaunchStatus, putLaunchTeam } from './routes/launch.js';
import { commitPaste, previewPaste } from './routes/paste.js';
import { getPlanDoc, getRaidForEvent, putPlanDoc } from './routes/plan-doc.js';
import { PLAN_DOC_MAX_BODY } from './plan-doc.js';

const COMMIT_MAX_BODY = 64 * 1024;
const PLAN_MAX_BODY = 32 * 1024;
// The body limits of the CSV roster commit (500 rows) and of a public application (eight long answers).
const CSV_MAX_BODY = 256 * 1024;
const APPLY_MAX_BODY = 32 * 1024;

export const ROUTES = [
  { method: 'GET', path: '/guild', auth: false, handler: guildPageRedirect },
  { method: 'GET', path: '/guild/', auth: false, handler: guildPageRedirect },
  { method: 'GET', path: '/auth/login', auth: false, handler: login },
  { method: 'GET', path: '/auth/callback', auth: false, handler: callback },
  { method: 'GET', path: '/auth/providers', auth: false, handler: providers },
  { method: 'GET', path: '/auth/me', auth: true, handler: me },
  { method: 'DELETE', path: '/auth/me', auth: true, handler: deleteMe },
  { method: 'PATCH', path: '/auth/prefs', auth: true, handler: updatePrefs },
  // Accounts (Phase 7a): the name the account shows, and Discord as a linked sign-in (/auth/login?mode=link connects it, this disconnects it).
  { method: 'PATCH', path: '/api/me', auth: true, handler: patchMe },
  { method: 'DELETE', path: '/auth/discord', auth: true, handler: unlinkDiscord },
  // PM wave 4: "Don't mention me in reminders" (the Discord channel reminders list this account by name only).
  { method: 'PUT', path: '/auth/reminders', auth: true, handler: putReminderOptOut },
  // Battle.net link (Phase 5). login and callback are browser navigations: they read the session themselves and redirect instead of answering JSON.
  { method: 'GET', path: '/auth/bnet/login', auth: false, handler: bnetLogin },
  { method: 'GET', path: '/auth/bnet/callback', auth: false, handler: bnetCallback },
  { method: 'GET', path: '/auth/bnet', auth: true, handler: getBnet },
  { method: 'DELETE', path: '/auth/bnet', auth: true, handler: disconnectBnet },
  { method: 'POST', path: '/auth/logout', auth: true, handler: logout },
  { method: 'POST', path: '/api/guild', auth: true, handler: createGuild },
  { method: 'GET', path: '/api/guild/:gid', auth: true, handler: getGuild },
  // Guild settings > General: the Guild Master edits the name, the realm (not a ruleset) and the time zone.
  { method: 'PATCH', path: '/api/guild/:gid', auth: true, handler: patchGuild },
  { method: 'POST', path: '/api/guild/:gid/claim', auth: true, handler: claimGuild },
  // Phase 8: the Guild Master's copy of the guild's data, deleting the guild, and hiding the setup checklist on Home.
  { method: 'GET', path: '/api/guild/:gid/export', auth: true, handler: exportGuild },
  { method: 'DELETE', path: '/api/guild/:gid', auth: true, handler: deleteGuild },
  { method: 'POST', path: '/api/guild/:gid/onboarding/dismiss', auth: true, handler: dismissOnboarding },
  { method: 'POST', path: '/api/guild/:gid/teams', auth: true, handler: createTeam },
  { method: 'PATCH', path: '/api/guild/:gid/teams/:tid', auth: true, handler: patchTeam },
  { method: 'GET', path: '/api/guild/:gid/people', auth: true, handler: getPeople },
  { method: 'PUT', path: '/api/guild/:gid/people/:uid/roles', auth: true, handler: setRoles },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/guild-master', auth: true, handler: makeGuildMaster },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/sync', auth: true, handler: syncPerson },
  { method: 'POST', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: blockPerson },
  { method: 'DELETE', path: '/api/guild/:gid/people/:uid/block', auth: true, handler: restorePerson },
  // Roles, Discord role mapping, guest links and the public page (Phase 7). The guest and public routes need no account: they answer read-only views.
  { method: 'GET', path: '/api/guild/:gid/roles', auth: true, handler: getRoles },
  { method: 'POST', path: '/api/guild/:gid/roles', auth: true, handler: createRole },
  { method: 'PUT', path: '/api/guild/:gid/roles/:rolid', auth: true, handler: updateRole },
  { method: 'DELETE', path: '/api/guild/:gid/roles/:rolid', auth: true, handler: deleteRole },
  { method: 'POST', path: '/api/guild/:gid/roles/:rolid/reset', auth: true, handler: resetRole },
  { method: 'GET', path: '/api/guild/:gid/discord', auth: true, handler: getDiscord },
  { method: 'PUT', path: '/api/guild/:gid/discord/maps', auth: true, handler: putMaps },
  { method: 'POST', path: '/api/guild/:gid/discord/sync', auth: true, handler: syncEveryone },
  { method: 'GET', path: '/api/guild/:gid/guest-links', auth: true, handler: listGuestLinks },
  { method: 'POST', path: '/api/guild/:gid/guest-links', auth: true, handler: createGuestLink },
  { method: 'DELETE', path: '/api/guild/:gid/guest-links/:lid', auth: true, handler: revokeGuestLink },
  { method: 'GET', path: '/api/guild/:gid/public', auth: true, handler: getPublicSettings },
  { method: 'PUT', path: '/api/guild/:gid/public', auth: true, handler: putPublicSettings },
  { method: 'POST', path: '/auth/guest', auth: false, handler: redeemGuestLink },
  { method: 'DELETE', path: '/auth/guest', auth: false, handler: leaveGuest },
  { method: 'GET', path: '/api/guest', auth: false, handler: getGuestView },
  { method: 'GET', path: '/api/public/:gid', auth: false, handler: getPublicView },
  { method: 'GET', path: '/api/guild/:gid/roster', auth: true, handler: getRoster },
  { method: 'POST', path: '/api/guild/:gid/roster', auth: true, handler: createPerson },
  // Literal paths are registered before `:pid`, so "linkable" and "import" are never read as a person id.
  { method: 'GET', path: '/api/guild/:gid/roster/linkable', auth: true, handler: getLinkable },
  { method: 'GET', path: '/api/guild/:gid/accounts', auth: true, handler: lookupAccounts },
  { method: 'POST', path: '/api/guild/:gid/roster/import/raid-helper/preview', auth: true, handler: previewRaidHelper },
  { method: 'POST', path: '/api/guild/:gid/roster/import/raid-helper/commit', auth: true, handler: commitRaidHelper, maxBody: COMMIT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/roster/import/wcl/preview', auth: true, handler: previewWcl },
  { method: 'POST', path: '/api/guild/:gid/roster/import/wcl/commit', auth: true, handler: commitWcl, maxBody: COMMIT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/roster/import/bnet/preview', auth: true, handler: previewBnetRoster },
  { method: 'POST', path: '/api/guild/:gid/roster/import/bnet/commit', auth: true, handler: commitBnetRoster, maxBody: COMMIT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/roster/import/csv/preview', auth: true, handler: previewCsv, maxBody: CSV_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/roster/import/csv/commit', auth: true, handler: commitCsv, maxBody: CSV_MAX_BODY },
  { method: 'GET', path: '/api/guild/:gid/roster/:pid', auth: true, handler: getPerson },
  { method: 'GET', path: '/api/guild/:gid/roster/:pid/trial', auth: true, handler: getTrialReview },
  { method: 'PATCH', path: '/api/guild/:gid/roster/:pid', auth: true, handler: patchPerson },
  { method: 'DELETE', path: '/api/guild/:gid/roster/:pid', auth: true, handler: deletePerson },
  { method: 'PUT', path: '/api/guild/:gid/roster/:pid/account', auth: true, handler: setPersonAccount },
  { method: 'PUT', path: '/api/guild/:gid/roster/:pid/notes', auth: true, handler: saveNotes },
  { method: 'POST', path: '/api/guild/:gid/roster/:pid/characters', auth: true, handler: addCharacter },
  { method: 'PATCH', path: '/api/guild/:gid/roster/:pid/characters/:cid', auth: true, handler: patchCharacter },
  { method: 'DELETE', path: '/api/guild/:gid/roster/:pid/characters/:cid', auth: true, handler: removeCharacter },
  { method: 'POST', path: '/api/guild/:gid/roster/:pid/characters/:cid/main', auth: true, handler: makeMain },
  { method: 'GET', path: '/api/guild/:gid/raids', auth: true, handler: listRaids },
  { method: 'POST', path: '/api/guild/:gid/raids', auth: true, handler: createRaid },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid', auth: true, handler: getRaid },
  { method: 'PATCH', path: '/api/guild/:gid/raids/:rid', auth: true, handler: patchRaid },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid', auth: true, handler: deleteRaid },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/event', auth: true, handler: putEvent },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/event', auth: true, handler: deleteEvent },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/reports', auth: true, handler: putReport },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/reports/:code', auth: true, handler: deleteReport },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/planner', auth: true, handler: getPlanner },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/plan', auth: true, handler: putPlan, maxBody: PLAN_MAX_BODY },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/plan', auth: true, handler: deletePlan },
  // The Planner's whole plan of the raid (autosave + poll), and the lookup the Raid-Helper import uses to attach a plan to a raid.
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/plan-doc', auth: true, handler: getPlanDoc },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/plan-doc', auth: true, handler: putPlanDoc, maxBody: PLAN_DOC_MAX_BODY },
  { method: 'GET', path: '/api/guild/:gid/raid-for-event', auth: true, handler: getRaidForEvent },
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
  // The published roster of a raid: officers publish it, members see their own seat and answer it. Literal paths come before nothing else under /roster.
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/roster', auth: true, handler: getPublishedRoster },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/roster', auth: true, handler: publishRoster },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/roster', auth: true, handler: unpublishRoster },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/roster/confirm', auth: true, handler: confirmSeat },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/roster/decline', auth: true, handler: declineSeat },
  // Standing sign-ups (PM wave 2): a member's own weekday entries, which become sign-ups on the team's upcoming raids.
  { method: 'GET', path: '/api/guild/:gid/standing', auth: true, handler: getStanding },
  { method: 'PUT', path: '/api/guild/:gid/teams/:tid/standing', auth: true, handler: putStanding },
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
  // PM wave 5: the pasted TMB / softres lists and the board built from them, and an award made by hand (a literal path, so never read as an award id).
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/loot-board', auth: true, handler: getLootBoard },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/loot-lists', auth: true, handler: putLootList, maxBody: LOOT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/loot/manual', auth: true, handler: postManualAward },
  // Literal paths are registered before `:aid`, so "balance", "raids", "items", "person" and "policy" are never read as an award id.
  { method: 'GET', path: '/api/guild/:gid/loot/balance', auth: true, handler: getBalance },
  { method: 'GET', path: '/api/guild/:gid/loot/raids', auth: true, handler: getLootRaids },
  { method: 'GET', path: '/api/guild/:gid/loot/items', auth: true, handler: getLootItems },
  { method: 'GET', path: '/api/guild/:gid/loot/hub', auth: true, handler: getLootHub },
  { method: 'GET', path: '/api/guild/:gid/loot/items/:lootitem', auth: true, handler: getLootItem },
  { method: 'GET', path: '/api/guild/:gid/loot/a/:aid', auth: true, handler: getLootAward },
  { method: 'GET', path: '/api/guild/:gid/loot/fix', auth: true, handler: getLootFix },
  { method: 'POST', path: '/api/guild/:gid/loot/fix/keep', auth: true, handler: postLootFixKeep },
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
  { method: 'GET', path: '/api/guild/:gid/attention/week', auth: true, handler: getAttentionWeek },
  { method: 'POST', path: '/api/guild/:gid/attention/dismissals', auth: true, handler: postDismissal },
  { method: 'DELETE', path: '/api/guild/:gid/attention/dismissals/:itemid', auth: true, handler: deleteDismissal },
  { method: 'GET', path: '/api/guild/:gid/calendar', auth: true, handler: getCalendarStatus },
  { method: 'POST', path: '/api/guild/:gid/calendar', auth: true, handler: createCalendarLink },
  { method: 'DELETE', path: '/api/guild/:gid/calendar', auth: true, handler: revokeCalendarLink },
  { method: 'GET', path: '/cal/:cal', auth: false, handler: getCalendarFeed },
  // PM wave 2: away notices. The literal /away/mine is registered before /away/:nid.
  { method: 'GET', path: '/api/guild/:gid/away/mine', auth: true, handler: getMyNotices },
  { method: 'GET', path: '/api/guild/:gid/away', auth: true, handler: getNotices },
  { method: 'POST', path: '/api/guild/:gid/away', auth: true, handler: postNotice },
  { method: 'PUT', path: '/api/guild/:gid/away/:nid', auth: true, handler: putNotice },
  { method: 'DELETE', path: '/api/guild/:gid/away/:nid', auth: true, handler: deleteNotice },
  // PM wave 3 (recruiting and the WoW Forever launch): the class and spec intent board, recruitment needs and the applications inbox. The apply form is
  // public (no session needed; a signed-in applicant's account is kept). The literal /applications/settings is registered before /applications/:apid.
  { method: 'GET', path: '/api/guild/:gid/intent', auth: true, handler: getIntent },
  { method: 'POST', path: '/api/guild/:gid/teams/:tid/intent', auth: true, handler: openIntent },
  { method: 'PATCH', path: '/api/guild/:gid/intent/:iid', auth: true, handler: closeIntent },
  { method: 'PUT', path: '/api/guild/:gid/intent/:iid/picks/:pid', auth: true, handler: putIntentPick },
  { method: 'DELETE', path: '/api/guild/:gid/intent/:iid/picks/:pid', auth: true, handler: deleteIntentPick },
  { method: 'GET', path: '/api/guild/:gid/recruiting', auth: true, handler: getRecruiting },
  { method: 'PUT', path: '/api/guild/:gid/teams/:tid/recruiting', auth: true, handler: putRecruitTargets },
  { method: 'GET', path: '/api/apply/:gid', auth: false, handler: getApplyForm },
  { method: 'POST', path: '/api/apply/:gid', auth: false, handler: submitApplication, maxBody: APPLY_MAX_BODY },
  { method: 'GET', path: '/api/guild/:gid/applications/settings', auth: true, handler: getApplySettings },
  { method: 'PUT', path: '/api/guild/:gid/applications/settings', auth: true, handler: putApplySettings },
  { method: 'GET', path: '/api/guild/:gid/applications', auth: true, handler: listApplications },
  { method: 'PATCH', path: '/api/guild/:gid/applications/:apid', auth: true, handler: patchApplication },
  { method: 'POST', path: '/api/guild/:gid/applications/:apid/accept', auth: true, handler: acceptApplication },
  { method: 'DELETE', path: '/api/guild/:gid/applications/:apid', auth: true, handler: deleteApplication },
  // PM wave 4: the Discord channel webhook of a team and what is posted to it. The webhook address is never sent back.
  { method: 'GET', path: '/api/guild/:gid/notifications', auth: true, handler: getNotifications },
  { method: 'PUT', path: '/api/guild/:gid/teams/:tid/notifications', auth: true, handler: putTeamNotifications },
  { method: 'POST', path: '/api/guild/:gid/teams/:tid/notifications/test', auth: true, handler: postTestNotification },
  // PM wave 7: read-only API keys (Guild settings > Data access), the data they open (no session: the key is the credential, and it is the one place a
  // key may sit in the address, for CSV), the team progress board, and the rank ladder's accept / dismiss. /api/v1/:dataset is classified in the isolation suite.
  { method: 'GET', path: '/api/guild/:gid/api-keys', auth: true, handler: listApiKeys },
  { method: 'POST', path: '/api/guild/:gid/api-keys', auth: true, handler: createApiKey },
  { method: 'DELETE', path: '/api/guild/:gid/api-keys/:kid', auth: true, handler: revokeApiKey },
  { method: 'GET', path: '/api/v1/:dataset', auth: false, handler: getApiData },
  { method: 'GET', path: '/api/guild/:gid/teams/:tid/progress', auth: true, handler: getTeamProgress },
  { method: 'PUT', path: '/api/guild/:gid/roster/:pid/rank', auth: true, handler: putPersonRank },
  { method: 'POST', path: '/api/guild/:gid/roster/:pid/rank/dismiss', auth: true, handler: dismissRankSuggestion },
  // PM wave 8 (WoW Forever launch readiness): raid duties, the Launch funnel, guest sign-up links (the two /api/join routes need no session; they are classified
  // in the isolation suite) and a pasted raid roster. The literal /manual/paste/preview is registered before /manual/paste.
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/duties', auth: true, handler: getDuties },
  { method: 'PUT', path: '/api/guild/:gid/raids/:rid/duties', auth: true, handler: putDuties },
  { method: 'GET', path: '/api/guild/:gid/launch', auth: true, handler: getLaunch },
  { method: 'PUT', path: '/api/guild/:gid/launch/:pid', auth: true, handler: putLaunchStatus },
  { method: 'PUT', path: '/api/guild/:gid/teams/:tid/launch', auth: true, handler: putLaunchTeam },
  { method: 'GET', path: '/api/guild/:gid/raids/:rid/join-links', auth: true, handler: listJoinLinks },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/join-links', auth: true, handler: createJoinLink },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/join-links/:jid', auth: true, handler: revokeJoinLink },
  { method: 'DELETE', path: '/api/guild/:gid/raids/:rid/guests/:sid', auth: true, handler: deleteGuestSignup },
  { method: 'POST', path: '/api/join/view', auth: false, handler: viewJoin, maxBody: APPLY_MAX_BODY },
  { method: 'POST', path: '/api/join', auth: false, handler: submitJoin, maxBody: APPLY_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/manual/paste/preview', auth: true, handler: previewPaste, maxBody: COMMIT_MAX_BODY },
  { method: 'POST', path: '/api/guild/:gid/raids/:rid/manual/paste', auth: true, handler: commitPaste, maxBody: COMMIT_MAX_BODY },
  // App-wide (no guild): the idea box on the Future enhancements page.
  { method: 'GET', path: '/api/roadmap/ideas', auth: true, handler: listIdeas },
  { method: 'POST', path: '/api/roadmap/ideas', auth: true, handler: createIdea },
  // Dev-only "View as" (worker/view-as.js): 404 unless DEV_VIEW_AS=1 on a local host, and Guild Master only. a signed-in caller on a closed gate gets the plain 404.
  { method: 'PUT', path: '/api/dev/view-as', auth: true, handler: putViewAs },
  { method: 'DELETE', path: '/api/dev/view-as', auth: true, handler: deleteViewAs },
  { method: 'GET', path: '/api/dev/guild/:gid/viewer', auth: true, handler: getViewerPreview },
];

// deps: { db, env, fetch, now, randomBytes, log, routes? } -> { handle(request) }. routes replaces ROUTES (the isolation suite adds a deliberately leaky route to see its walker catch it).
export function createApp(deps) {
  const router = createRouter(deps.routes || ROUTES);
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
  // The Cron Triggers (wrangler.jsonc triggers.crons): daily the 30-day rule for Battle.net data, every 15 minutes the Raid-Helper refresh and the Discord
  // posts (worker/scheduler.js picks by event.cron).
  scheduled(event, env, ctx) {
    ctx.waitUntil(runCron({
      cron: event.cron, db: env.DB, env, fetch: (...args) => fetch(...args), now: Date.now, randomBytes: defaultRandomBytes, log: (message) => console.log(message),
    }));
  },
};
