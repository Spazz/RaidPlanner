// The flip dry run (user-hierarchy build, lane B5). OWNER ONLY, like the rank map: the flip changes how the whole guild is let in. This route only READS and mints a token;
// the flip itself (lane B9) consumes the token inside its own batch. What the dry run computes is worker/flip-preview.js (sections lanes B6b and B9 extend); the token is
// worker/dry-run.js, bound to this Owner, the previewed lists (state hash 'flip:...'), the stored roster's sync id and 10 minutes.
//
//   POST /api/guild/:gid/flip/dry-run   no body -> { token, expiresAt, rankSource, rosterSyncId, access: { members, loses, gains }, discordOwned }
//                                       403 forbidden (not the Owner) | 409 already_ingame | 429 (10 dry runs per 10 minutes)
// A guild whose rank_source is already 'ingame' has nothing to preview.
import { HttpError, jsonResponse } from '../http.js';
import { APPROVAL_TTL_MS, insertApprovalStatement, newApprovalToken } from '../dry-run.js';
import { previewFlip } from '../flip-preview.js';
import { requireOwner } from '../owner.js';
import { loadGuildContext } from '../permissions.js';
import { FLIP_DRY_RUN_LIMIT, FLIP_DRY_RUN_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';

const alreadyIngame = () => new HttpError(409, 'already_ingame', 'This guild already takes its members from the in-game roster, so there is nothing left to preview.');

export async function dryRunFlip(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  await requireOwner(db, guildContext, 'Only the Owner of the guild can run the flip dry run.');
  const guildId = guildContext.guild.id;
  const approverUserId = guildContext.userId;
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
  return jsonResponse({
    token,
    expiresAt: now + APPROVAL_TTL_MS,
    rankSource: preview.guild.rankSource,
    rosterSyncId: preview.guild.rosterSyncId,
    ...preview.payload,
  });
}
