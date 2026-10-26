// The in-game roster sync's two routes (hierarchy build, lane B4a-code). Both are dormant in practice: a guild has to carry a complete Blizzard pin
// (worker/roster-pin.js), and no flow writes one yet.
//   POST /api/guild/:gid/roster-sync   "Sync now": the Guild Master only for now (lane B6b ports this to the Owner / GM-tier check), POST only, a failClosed
//                                      per-account rate limit, and the SAME lease column as the cron (worker/roster-sync.js claimSyncLease): at most one
//                                      sync an hour per guild, whoever asks. Answers { status, reason, members, syncId, status page }.
//   GET  /api/guild/:gid/roster-sync   Sync status for the guild-edit permission (guild.teams, the one Guild settings > Battle.net uses): last good sync,
//                                      last attempt and its reason, the next scheduled sync. No member names, ids or hashes.
import { HttpError, jsonResponse } from '../http.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import { ROSTER_SYNC_LIMIT, ROSTER_SYNC_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { loadPin } from '../roster-pin.js';
import { claimSyncLease, loadSyncStatus, onDemandRetryAfter, syncGuild } from '../roster-sync.js';
import { requireBnetConfigured } from './bnet-import.js';

export async function postRosterSync(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!guildContext.isGuildMaster) throw new HttpError(403, 'forbidden', 'Only the Guild Master can sync the roster now.');
  const guildId = guildContext.guild.id;
  requireBnetConfigured(ctx.env);
  await enforceRateLimit(db, ctx.session.user.id, ctx.now(), {
    key: `rsync:${ctx.session.user.id}`, limit: ROSTER_SYNC_LIMIT, windowMs: ROSTER_SYNC_WINDOW_MS, failClosed: true,
  });
  const pin = await loadPin(db, guildId);
  if (!pin.complete) {
    throw new HttpError(409, 'not_pinned', 'This guild is not linked to a Battle.net guild yet, so there is no in-game roster to sync.');
  }
  if (!(await claimSyncLease(db, guildId, ctx.now(), { onDemand: true }))) {
    throw new HttpError(429, 'sync_too_soon', 'The roster was synced less than an hour ago. Try again later.', { retryAfter: await onDemandRetryAfter(db, guildId, ctx.now()) });
  }
  const result = await syncGuild(ctx, guildId);
  return jsonResponse({ ...result, sync: await loadSyncStatus(db, guildId) });
}

export async function getRosterSyncStatus(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.teams');
  return jsonResponse(await loadSyncStatus(ctx.db, guildContext.guild.id));
}
