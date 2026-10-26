// The in-game rank map (user-hierarchy build, lane B4b): which core rank and which permission role each in-game rank gives. OWNER ONLY (plan "Owner-only acts"):
// a Guild Master by role who does not hold the Owner seat reads and changes nothing here. The rules and the SQL are worker/rank-map.js; the approval token is
// worker/dry-run.js.
//
//   GET  /api/guild/:gid/rank-map           the editor's data: ten rows (rank 0-9: name, core rank, role, members on the stored roster, mapped or not), the ranks on the
//                                           roster that have no row yet (`unmapped`: their characters are Social until mapped), the suggested names, the choices
//   POST /api/guild/:gid/rank-map/dry-run   body { ranks: [{ rank, label, coreRank, roleId }] } -> what the map would do ({ changes }) and a single-use `token`
//                                           bound to this Owner, this proposed map, the characters it would move, the stored roster and 10 minutes. Writes only the token.
//   PUT  /api/guild/:gid/rank-map           body { ranks, token }: the SAME ranks as the dry run, with its token. One atomic batch: consume the token, replace the map,
//                                           applyRankMap, audit. 409 approval_invalid (unknown, another account's, used, expired) or approval_stale (the map, the
//                                           characters or the roster moved since the dry run: run it again). Only rank 0 may map to Guild Master (400 rank_zero_only).
// While the guild's rank source is not 'ingame' the map is stored and applies to nothing (`applies: false`): lane B9's flip applies it first.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { RANK_COUNT, loadBnetSettings } from '../bnet-store.js';
import {
  APPROVAL_TTL_MS, approvalProblem, consumeApprovalStatement, insertApprovalStatement, loadApproval, markerGuard, markerStatement, newApprovalToken, newMarkerId, rosterSyncIdOf,
} from '../dry-run.js';
import { isOwner, ownerGuard, requireOwner } from '../owner.js';
import { loadGuildContext } from '../permissions.js';
import { RANK_MAP_LIMIT, RANK_MAP_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { hashToken } from '../session.js';
import {
  APPLY_UPDATE_INDEX, CORE_RANK_IDS, CORE_RANK_LABELS, MAPPABLE_BUILTIN_ROLES, gapsOfMap, ingameGuard, loadRankMap, loadRosterRanks, mapChanges, mapStateHash,
  approvedTransitionsGuard, normalizeRankMap, previewMap, rankMapApplyStatements, replaceMapStatements, suggestedLabels,
} from '../rank-map.js';

const BUILTIN_ROLE_NAMES = { officer: 'Officer', team_lead: 'Team Lead', guild_master: 'Guild Master' };

async function ownerContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  await requireOwner(ctx.db, guildContext, 'Only the Owner of the guild can read or change the rank map.');
  return guildContext;
}

// The guild row the map needs (loadGuildContext's guild has no source columns).
const loadGuildRow = (db, guildId) => db.prepare('SELECT id, rank_source, last_good_sync_id, time_zone FROM guilds WHERE id = ?').bind(guildId).first();

const loadCustomRoles = async (db, guildId) =>
  (await db.prepare('SELECT id, name FROM roles WHERE guild_id = ? ORDER BY name, id').bind(guildId).all()).results;

// The editor's data (the body of GET, and of the PUT answer).
async function rankMapPayload(db, guildRow) {
  const [map, rosterRanks, settings, customRoles] = await Promise.all([
    loadRankMap(db, guildRow.id), loadRosterRanks(db, guildRow.id), loadBnetSettings(db, guildRow.id), loadCustomRoles(db, guildRow.id),
  ]);
  const suggestions = suggestedLabels(settings.rankLabels);
  const members = new Map(rosterRanks.map((entry) => [entry.rank, entry.members]));
  const ranks = Array.from({ length: RANK_COUNT }, (_, rank) => {
    const row = map.find((entry) => entry.rank === rank);
    return {
      rank, mapped: !!row, label: row ? row.label : suggestions[rank], coreRank: row ? row.coreRank : null, roleId: row ? row.roleId : null, members: members.get(rank) || 0,
    };
  });
  return {
    source: 'ingame',
    rankSource: guildRow.rank_source,
    applies: guildRow.rank_source === 'ingame',
    rosterSyncId: guildRow.last_good_sync_id,
    ranks,
    unmapped: gapsOfMap(rosterRanks, map),
    complete: gapsOfMap(rosterRanks, map).length === 0,
    coreRanks: CORE_RANK_IDS.map((id) => ({ id, label: CORE_RANK_LABELS[id] })),
    // Guild Master is offered for rank 0 only.
    roles: [
      ...MAPPABLE_BUILTIN_ROLES.map((id) => ({ id, name: BUILTIN_ROLE_NAMES[id], rankZeroOnly: id === 'guild_master' })),
      ...customRoles.map((role) => ({ id: role.id, name: role.name, custom: true })),
    ],
  };
}

export async function getRankMap(ctx) {
  const guildContext = await ownerContext(ctx);
  return jsonResponse(await rankMapPayload(ctx.db, await loadGuildRow(ctx.db, guildContext.guild.id)));
}

// body.ranks -> the canonical proposed map (400 on the first problem).
async function readProposed(ctx, guildId) {
  const customRoles = await loadCustomRoles(ctx.db, guildId);
  return normalizeRankMap(ctx.body && ctx.body.ranks, customRoles.map((role) => role.id));
}

// Everything the token is bound to, read fresh: -> { stored, preview, stateHash, rosterSyncId }.
async function stateOf(db, guildRow, proposed) {
  const [stored, preview] = await Promise.all([loadRankMap(db, guildRow.id), previewMap(db, guildRow.id, proposed)]);
  return { stored, preview, stateHash: await mapStateHash(stored, proposed, preview), rosterSyncId: rosterSyncIdOf(guildRow) };
}

export async function dryRunRankMap(ctx) {
  const { db } = ctx;
  const guildContext = await ownerContext(ctx);
  const guildId = guildContext.guild.id;
  const proposed = await readProposed(ctx, guildId);
  await enforceRateLimit(db, guildContext.userId, ctx.now(), { key: `rmap:${guildContext.userId}`, limit: RANK_MAP_LIMIT, windowMs: RANK_MAP_WINDOW_MS });
  const guildRow = await loadGuildRow(db, guildId);
  const { stored, preview, stateHash, rosterSyncId } = await stateOf(db, guildRow, proposed);
  const { token, tokenHash } = await newApprovalToken(ctx.randomBytes);
  const now = ctx.now();
  await insertApprovalStatement(db, { tokenHash, guildId, approverUserId: guildContext.userId, stateHash, rosterSyncId, now }).run();
  return jsonResponse({
    token,
    expiresAt: now + APPROVAL_TTL_MS,
    applies: guildRow.rank_source === 'ingame',
    ranks: proposed,
    changes: { map: mapChanges(stored, proposed), characters: preview },
    unmapped: gapsOfMap(await loadRosterRanks(db, guildId), proposed),
  });
}

const approvalInvalid = () => new HttpError(409, 'approval_invalid', 'That approval is not valid any more. Run the dry run again.');
const approvalStale = () => new HttpError(409, 'approval_stale', 'The rank map, the characters or the roster changed since the dry run. Run the dry run again.');

export async function putRankMap(ctx) {
  const { db } = ctx;
  const guildContext = await ownerContext(ctx);
  const guildId = guildContext.guild.id;
  const approverUserId = guildContext.userId;
  const proposed = await readProposed(ctx, guildId);
  const presented = ctx.body && ctx.body.token;
  if (typeof presented !== 'string' || !presented || presented.length > 200) {
    throw new HttpError(400, 'approval_required', 'Run the dry run first and send its token.', { field: 'token' });
  }
  const tokenHash = await hashToken(presented);
  const guildRow = await loadGuildRow(db, guildId);
  const { stored, preview, stateHash, rosterSyncId } = await stateOf(db, guildRow, proposed);
  const now = ctx.now();
  const problem = approvalProblem(await loadApproval(db, tokenHash), { guildId, approverUserId, stateHash, rosterSyncId, now });
  if (problem === 'invalid') throw approvalInvalid();
  if (problem === 'stale') throw approvalStale();

  const markerId = newMarkerId(ctx.randomBytes);
  const marker = markerGuard(markerId);
  const guards = [marker, ingameGuard(guildId)];
  const owner = ownerGuard(guildId, approverUserId);
  // The characters the map would change are recomputed inside the batch and must be the ones the Owner approved (a character edited after the check above and before
  // the batch ran would otherwise be moved without approval).
  const approved = approvedTransitionsGuard(guildId, proposed, preview.transitions);
  const statements = [
    // 0: consume the token. Changes one row only while every binding still holds inside the database, the approver still holds the Owner seat and the transitions
    // of the map over the characters AS THEY ARE NOW are the approved ones.
    consumeApprovalStatement(db, { tokenHash, guildId, approverUserId, stateHash, rosterSyncId, now }, { sql: `${owner.sql} AND ${approved.sql}`, params: [...owner.params, ...approved.params] }),
    // 1: the marker every later statement carries.
    markerStatement(db, { markerId, tokenHash, purpose: 'rank_map', now }),
    // 2-3: the map. 4-6: applyRankMap (nothing happens to a character while the guild's rank source is not 'ingame').
    ...replaceMapStatements(db, guildId, proposed, marker),
    ...rankMapApplyStatements(db, { guildId, now, timeZone: guildContext.guild.time_zone }, guards),
    auditStatement(ctx, {
      guildId, actorUserId: approverUserId, action: 'rank_map.update', entityType: 'guild', entityId: guildId,
      before: { ranks: stored.length },
      after: { ranks: proposed.length, mapChanges: mapChanges(stored, proposed).length, charactersChanged: preview.changed, becomesTrial: preview.becomesTrial, approverUserId },
    }, marker),
  ];
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) {
    // Nothing was written. The token is still the Owner's live one when the state moved under the batch (a character, the roster or the map): run the dry run again.
    // A token that is used or expired, or an approver who lost the seat meanwhile, is not valid any more.
    const again = await loadApproval(db, tokenHash);
    const live = again && again.guild_id === guildId && again.approver_user_id === approverUserId && again.used_at === null && again.expires_at > now;
    throw live && (await isOwner(db, guildId, approverUserId)) ? approvalStale() : approvalInvalid();
  }
  const updateAt = 2 + 2 + APPLY_UPDATE_INDEX; // consume, marker, the two map statements, then the stale marking and the rank UPDATE
  const applied = { mapRows: proposed.length, characters: results[updateAt].meta.changes };
  return jsonResponse({ ...(await rankMapPayload(db, await loadGuildRow(db, guildId))), applied });
}
