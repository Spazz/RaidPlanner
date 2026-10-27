// The flip (user-hierarchy build, lanes B5 and B9). OWNER ONLY, like the rank map: the flip changes how the whole guild is let in.
//
//   POST /api/guild/:gid/flip/dry-run   no body -> { token, expiresAt, rankSource, rosterSyncId, access, needsClaim, permissions, owner, nameBinding, ranks, blockers }
//                                       READS and mints a token (worker/dry-run.js), bound to this Owner, the previewed lists (state hash 'flip:...' = every section's hashPart), the stored
//                                       roster's sync id and 10 minutes. `blockers` lists what the flip would refuse today ([] = it can run): the same refusals, codes and texts as below.
//                                       403 forbidden (not the Owner) | 409 already_ingame | 429 (10 dry runs per 10 minutes)
//   POST /api/guild/:gid/flip           body { token } -> { ok, rankSource: 'ingame', ownerUserId, applied }   (worker/flip.js: ONE atomic batch)
//                                       needs the fresh sign-in of purpose source_switch, params { from: null, to: 'ingame' } (Battle.net, worker/fresh.js)
//                                       400 approval_required | 403 forbidden | 403 fresh_required | 404 | 503 effective_roles_missing
//                                       409 already_ingame | source_not_legacy | not_pinned | no_good_sync | no_owner | owner_would_be_suspended | rank_map_incomplete | approval_invalid | approval_stale
// The order of the refusals: the facts the guild row alone shows (cheap), then the fresh sign-in, then the preview-based ones (the Owner would be suspended, an unmapped rank), then the
// approval. A guild whose rank_source is already 'ingame' has nothing to preview or flip.
import { HttpError, jsonResponse } from '../http.js';
import { APPROVAL_TTL_MS, approvalProblem, insertApprovalStatement, loadApproval, markerGuard, newApprovalToken, newMarkerId } from '../dry-run.js';
import { allOf, beginFreshAct } from '../fresh.js';
import { FLIP_FRESH_PARAMS, alreadyIngameError, approvalInvalidError, approvalStaleError, blockerError, flipBlockers, flipStatements, missingRoleViews, rolesMissingError } from '../flip.js';
import { previewFlip } from '../flip-preview.js';
import { requireOwnerFirst } from '../owner-gate.js';
import { ownerGuard } from '../owner.js';
import { FLIP_DRY_RUN_LIMIT, FLIP_DRY_RUN_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { hashToken } from '../session.js';
import { wrote } from '../d1-changes.js';

const alreadyIngame = () => new HttpError(409, 'already_ingame', 'This guild already takes its members from the in-game roster, so there is nothing left to preview.');

export async function dryRunFlip(ctx) {
  const { db } = ctx;
  // The Owner question comes FIRST (worker/owner-gate.js): an Owner who is no member under the guild's rule today (not in the Discord server, linked to no person) can run the dry
  // run that tells them what the flip would do to them (B5 open point (c)). Anybody else is refused as before: 404, 403 not_member / access_removed, 403 forbidden.
  const guildId = ctx.params.gid;
  const approverUserId = ctx.session.user.id;
  await requireOwnerFirst(db, { userId: approverUserId, guildId, viewAs: ctx.session.viewAs }, 'Only the Owner of the guild can run the flip dry run.');
  // Nothing to preview once the guild is in-game: refused before the rate limit and the reads (the preview re-checks inside its own snapshot below).
  const row = await db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guildId).first();
  if (row && row.rank_source === 'ingame') throw alreadyIngame();
  await enforceRateLimit(db, approverUserId, ctx.now(), { key: `flip:${approverUserId}`, limit: FLIP_DRY_RUN_LIMIT, windowMs: FLIP_DRY_RUN_WINDOW_MS });
  const preview = await previewFlip(db, guildId);
  // The preview reads the guild row in its own snapshot: a flip that landed between the Owner check and here is seen as it is.
  if (!preview.guild) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  if (preview.guild.rankSource === 'ingame') throw alreadyIngame();
  const { token, tokenHash } = await newApprovalToken(ctx.randomBytes);
  const now = ctx.now();
  await insertApprovalStatement(db, { tokenHash, guildId, approverUserId, stateHash: preview.stateHash, rosterSyncId: preview.guild.rosterSyncId, now }).run();
  const blockers = flipBlockers({ guild: preview.guild, owner: preview.payload.owner, ranks: preview.payload.ranks });
  return jsonResponse({
    token,
    expiresAt: now + APPROVAL_TTL_MS,
    rankSource: preview.guild.rankSource,
    rosterSyncId: preview.guild.rosterSyncId,
    ...preview.payload,
    blockers: blockers.map((blocker) => ({ code: blocker.code, message: blocker.message, ...blocker.extra })),
  });
}

const readToken = (body) => {
  const presented = body && body.token;
  if (typeof presented !== 'string' || !presented || presented.length > 200) {
    throw new HttpError(400, 'approval_required', 'Run the dry run first and send its token.', { field: 'token' });
  }
  return presented;
};

// Why a batch that changed nothing refused, read after the fact: the guild moved on (a parallel flip), the approval is gone, the grant is gone, or the state moved.
async function refusalAfterBatch(ctx, { guildId, approverUserId, tokenHash, now, reassertFresh }) {
  const guild = await ctx.db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guildId).first();
  if (guild && guild.rank_source === 'ingame') return alreadyIngameError();
  const approval = await loadApproval(ctx.db, tokenHash);
  if (!approval || approval.guild_id !== guildId || approval.approver_user_id !== approverUserId || approval.used_at !== null || approval.expires_at <= now) return approvalInvalidError();
  await reassertFresh();
  return approvalStaleError();
}

export async function flipGuild(ctx) {
  const { db } = ctx;
  const guildId = ctx.params.gid;
  const approverUserId = ctx.session.user.id;
  const missing = await missingRoleViews(db);
  if (missing.length) throw rolesMissingError(missing);
  await requireOwnerFirst(db, { userId: approverUserId, guildId, viewAs: ctx.session.viewAs }, 'Only the Owner of the guild can switch the guild to the in-game roster.');
  const tokenHash = await hashToken(readToken(ctx.body));

  // The facts the guild row alone shows. (The Owner gate passed, so the guild exists.)
  const row = await db.prepare(
    `SELECT rank_source, time_zone, last_good_sync_id,
            pinned_guild_slug IS NOT NULL AND pinned_realm_slug IS NOT NULL AND pinned_namespace IS NOT NULL AND blizzard_guild_id IS NOT NULL AND blizzard_realm_id IS NOT NULL AS pin_complete
       FROM guilds WHERE id = ?`,
  ).bind(guildId).first();
  if (!row) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  const cheap = flipBlockers({
    guild: { rankSource: row.rank_source, pinComplete: row.pin_complete === 1, hasGoodSync: !!row.last_good_sync_id }, owner: { exists: true, live: true }, ranks: { unmapped: [] },
  });
  if (cheap.length) throw blockerError(cheap[0]);

  // The fresh sign-in (403 fresh_required without it). Its consuming UPDATE carries the Owner test and the preflight marker, so the grant is spent only when the flip can apply.
  const checkId = newMarkerId(ctx.randomBytes);
  const freshOptions = { required: true, purpose: 'source_switch', guildId, params: FLIP_FRESH_PARAMS, extra: allOf(ownerGuard(guildId, approverUserId), markerGuard(checkId)) };
  const act = await beginFreshAct(ctx, freshOptions);

  const preview = await previewFlip(db, guildId);
  if (!preview.guild) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  const blockers = flipBlockers({ guild: preview.guild, owner: preview.payload.owner, ranks: preview.payload.ranks });
  if (blockers.length) throw blockerError(blockers[0]);

  const now = ctx.now();
  const problem = approvalProblem(await loadApproval(db, tokenHash), { guildId, approverUserId, stateHash: preview.stateHash, rosterSyncId: preview.guild.rosterSyncId, now });
  if (problem) {
    // A token that was spent a moment ago by a flip that has just landed reads as invalid or stale here; the Owner is told what happened.
    const moved = await db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guildId).first();
    if (moved && moved.rank_source === 'ingame') throw alreadyIngameError();
    throw problem === 'invalid' ? approvalInvalidError() : approvalStaleError();
  }

  const plan = flipStatements(ctx, { guildId, approverUserId, timeZone: row.time_zone, preview, tokenHash, checkId, act });
  const results = await db.batch(plan.statements);
  if (!wrote(results[plan.flippedAt])) {
    throw await refusalAfterBatch(ctx, { guildId, approverUserId, tokenHash, now, reassertFresh: () => beginFreshAct(ctx, freshOptions) });
  }
  return jsonResponse({ ok: true, rankSource: 'ingame', ownerUserId: approverUserId, applied: plan.applied });
}
