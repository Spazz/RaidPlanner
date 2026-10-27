// THE FLIP (user-hierarchy build, lane B9; plan "Dry run (flip)" and "FLIP (lane B9)"): the one act that turns a guild from the legacy rule (the Discord server decides, the stored
// Guild Master is the Owner) to rank_source 'ingame' (the in-game roster decides, the seat holder is the Owner). The route is worker/routes/flip.js; this file holds the refusals and the
// ONE atomic db.batch, so a test can build it for any roster and count its statements.
//
// THE BATCH is a compare-and-set chain. A statement that does not apply changes nothing and leaves every later statement of the chain without its guard:
//   P0   the PREFLIGHT marker, written only while every condition of the act still holds INSIDE the database: the guild is legacy and pinned, the roster is the one the Owner approved
//        (sync id), the approver holds the stored Guild Master row, the approval is theirs, unused and unexpired and bound to the previewed state, they have a Battle.net-proven
//        character on the stored roster (they will not be suspended), every rank on the roster is mapped, the candidates for the name binding are the approved list (the Owner ticked a subset of
//        it: those are bound) and the rank changes are those of the ticked binding. The conditions are one statement so the fresh grant below is spent only when the act can apply.
//   F0-1 the fresh-auth pair (worker/fresh.js, purpose source_switch, params { from: null, to: 'ingame' }): consumes the session's grant (only with the Owner test and the preflight
//        marker) and writes its marker WHERE changes() = 1
//   S1   UPDATE guilds SET rank_source = 'ingame' WHERE ... rank_source IS NULL AND last_good_sync_id = ? AND EXISTS (the stored Guild Master row) AND the fresh marker
//        (the vacant seat is a condition of P0, which the fresh marker stands for)
//   S2   consume the approval (used_at IS NULL, the bindings repeated) WHERE changes() = 1, so only after S1 applied
//   S3   the flip marker, WHERE changes() = 1 (after S2)
//   every later statement carries EXISTS (flip marker):
//        the seat (owner_user_id, only WHERE owner_user_id IS NULL), the stored Guild Master row goes, Discord-given stored roles become hand-set (UPDATE OR IGNORE, then the leftovers
//        that already had a hand-set twin are deleted), the name-binding confirmations (set-based over json_each of the approved ids), one audit row per bound character (capped),
//        applyRankMap (stale marking BEFORE the rank UPDATE, then the Trial clock = the trial backfill WHERE trial_end IS NULL), and the audit row of the flip.
// The statement count does NOT depend on the roster: 16 statements for 6 members and for 506 (tests/guild/guild-b9-flip-tests.js).
//
// WHAT THE FLIP DOES NOT DO. It links nobody: a Discord ID recorded on a person is bookkeeping and the person's account claims it (user decision 2026-10-26, migration 0039; the dry run's
// `needsClaim` section lists them). It writes no pin column (the guild was pinned by the setup pin before: worker/guild-pin.js) and sends nothing to Blizzard or Discord.
import { auditManyStatement, auditStatement } from './audit.js';
import { consumeApprovalStatement, markerGuard, markerStatement, newMarkerId } from './dry-run.js';
import { boundIdsTextSql, rankMapCompleteSql, transitionsTextSql } from './flip-binding.js';
import { provenAfterSql } from './flip-preview.js';
import { HttpError } from './http.js';
import { moveSeatStatement, seatHolderSql } from './owner.js';
import { sourceSwitchParams } from './pin-target.js';
import { ingameGuard, rankMapApplyStatements, rankMapIncompleteError } from './rank-map.js';
import { COMPLETE_PIN_SQL } from './roster-pin.js';

export const FLIP_FRESH_PARAMS = sourceSwitchParams(null, 'ingame');
export const FLIP_CHECK_PURPOSE = 'flip_check';
export const FLIP_MARKER_PURPOSE = 'flip';
// Per-character audit rows of the name binding: the plan's cap for the per-person detail of a bulk act. The flip's own row carries the full count.
export const FLIP_AUDIT_DETAIL_CAP = 200;
// Fixed: P0, the fresh pair, S1-S3, seat, Guild Master row, Discord roles (2), binding, binding audit, applyRankMap (3), flip audit.
export const FLIP_BATCH_STATEMENTS = 16;

// The views the in-game rule reads (migration 0035). Without them every permission question fails, so the flip is refused up front.
export const ROLE_VIEWS = Object.freeze(['effective_roles', 'effective_roles_stored', 'effective_roles_ingame', 'effective_roles_owner', 'ingame_proven_characters']);

export async function missingRoleViews(db) {
  const result = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'view' AND name IN ('effective_roles', 'effective_roles_stored', 'effective_roles_ingame', 'effective_roles_owner', 'ingame_proven_characters')",
  ).all();
  const present = new Set(result.results.map((row) => row.name));
  return ROLE_VIEWS.filter((name) => !present.has(name));
}

export const rolesMissingError = (missing) => new HttpError(
  503, 'effective_roles_missing', 'The role views are not installed on this database yet, so the switch cannot run. Apply the pending migrations, then try again.', { views: missing },
);

export const approvalInvalidError = () => new HttpError(409, 'approval_invalid', 'That approval is not valid any more. Run the dry run again.');
export const approvalStaleError = () => new HttpError(409, 'approval_stale', 'The roster, the characters or the guild changed since the dry run. Run the dry run again.');
export const alreadyIngameError = () => new HttpError(409, 'already_ingame', 'This guild already takes its members from the in-game roster.');

// ---------------------------------------------------------------------------
// The refusals that come from the facts alone (shared by the dry run's `blockers` and the flip route, in this order).
// guild: previewFlip's guild { rankSource, pinComplete, hasGoodSync }; owner, ranks: its `owner` and `ranks` payloads.
// -> [{ status, code, message, extra }]: the first one is what the route throws; the dry run lists them all.
export function flipBlockers({ guild, owner, ranks }) {
  const list = [];
  const add = (status, code, message, extra = {}) => list.push({ status, code, message, extra });
  if (guild.rankSource === 'ingame') {
    const error = alreadyIngameError();
    add(error.status, error.code, error.message);
  } else if (guild.rankSource !== null) {
    add(409, 'source_not_legacy', 'Only a guild that takes its members from the Discord server can be switched to the in-game roster here.');
  }
  if (!guild.pinComplete) add(409, 'not_pinned', 'Link the guild to its in-game guild first (Guild setup), then switch.');
  if (!guild.hasGoodSync) add(409, 'no_good_sync', 'The in-game roster has not been fetched yet. Fetch it first (Guild setup), then switch.');
  if (!owner.exists) {
    add(409, 'no_owner', 'This guild has no Owner yet, so there is nobody to switch it over.');
  } else if (!owner.live) {
    add(409, 'owner_would_be_suspended', 'You would be suspended after the switch: none of your characters is proved by Battle.net on the in-game roster. Sign in with Battle.net first so your character is proved, then run the dry run again.');
  }
  if (ranks.unmapped.length) {
    const error = rankMapIncompleteError(ranks.unmapped);
    add(error.status, error.code, error.message, error.extra);
  }
  return list;
}

export const blockerError = (blocker) => new HttpError(blocker.status, blocker.code, blocker.message, blocker.extra);

// ---------------------------------------------------------------------------
// The batch

// The roster row an id-less character is bound to, one column of it (the same match as worker/flip-binding.js nameMatchSql; the approved id list is what limits the update).
const rosterColumn = (column) => `(SELECT gr.${column} FROM guild_roster gr JOIN guilds ng ON ng.id = gr.guild_id
     WHERE gr.guild_id = characters.guild_id AND gr.name_key = characters.name_key AND gr.class = characters.class
       AND (ng.realm_kind = 'ruleset' OR characters.realm_key = replace(gr.realm_slug, '-', '')))`;

// The preflight statement (see P0 above). All parameters are numbered, so the guild is written wherever it is needed.
export function preflightStatement(db, { guildId, checkId, tokenHash, now, rosterSyncId, approverUserId, stateHash, idsText, transitionsText, confirmedJson }) {
  return db.prepare(
    `INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at)
     SELECT ?2, ?3, '${FLIP_CHECK_PURPOSE}', ?4
      WHERE EXISTS (SELECT 1 FROM guilds fg WHERE fg.id = ?1 AND fg.rank_source IS NULL AND fg.last_good_sync_id = ?5 AND ${COMPLETE_PIN_SQL})
        AND ${seatHolderSql('?1')} IS NULL
        AND EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ?1 AND role_id = 'guild_master' AND user_id = ?6)
        AND EXISTS (SELECT 1 FROM dry_run_approvals WHERE token_hash = ?3 AND guild_id = ?1 AND approver_user_id = ?6 AND map_hash = ?7 AND roster_sync_id = ?5 AND used_at IS NULL AND expires_at > ?4)
        AND EXISTS (SELECT 1 FROM (${provenAfterSql('?1')}) pv WHERE pv.user_id = ?6)
        AND ${rankMapCompleteSql('?1')}
        AND ${boundIdsTextSql('?1')} = ?8
        AND ${transitionsTextSql('?1', '?10')} = ?9`,
  ).bind(guildId, checkId, tokenHash, now, rosterSyncId, approverUserId, stateHash, idsText, transitionsText, confirmedJson);
}

// -> { statements, flippedAt, applied }. checkId: the preflight marker's id, which the fresh act's consuming UPDATE must already carry (worker/routes/flip.js passes it to beginFreshAct).
// `act` is beginFreshAct's answer (its two statements and its guard). preview: previewFlip's answer for THIS request, the whole dry-run state the approval covers. effective: the same
// lines for the characters the Owner confirmed (the second pass of previewFlip; the preview itself when they confirmed every candidate). confirmedIds: the ids to bind.
export function flipStatements(ctx, { guildId, approverUserId, timeZone, preview, effective, confirmedIds, tokenHash, checkId, act }) {
  const { db } = ctx;
  const now = ctx.now();
  const { rosterSyncId } = preview.guild;
  const approvedIdsText = JSON.stringify(preview.hashParts.boundByName.ids);
  const ids = [...confirmedIds].sort();
  const idsJson = JSON.stringify(ids);
  const transitionsText = JSON.stringify(effective.payload.ranks.transitions.map((entry) => [entry.from, entry.to, entry.count]));
  const markerId = newMarkerId(ctx.randomBytes);
  const marker = markerGuard(markerId);
  const approval = { tokenHash, guildId, approverUserId, stateHash: preview.stateHash, rosterSyncId, now };
  const { access, ranks, needsClaim } = effective.payload;
  const { permissions, owner } = preview.payload;
  // What the result banner shows. The access and rank lines are those of the confirmed binding; the batch itself re-checks the rank changes (the preflight statement).
  const counts = {
    membersBefore: access.members.today,
    membersAfter: access.members.afterFlip,
    stay: access.members.today - access.loses.count,
    gains: access.gains.count,
    loses: access.loses.count,
    rankChanges: ranks.changed,
    becameTrial: ranks.becomesTrial,
    becameSocial: ranks.becomesSocial,
    discordRolesMadeManual: permissions.discordRoles.count - permissions.discordRoles.withHandTwin,
    discordRolesDropped: permissions.discordRoles.withHandTwin,
    newPermissions: permissions.gains.count,
    lostPermissions: permissions.loses.count,
    needsClaim: needsClaim.count,
    boundByName: ids.length,
  };
  const applied = { ...counts, owner: { userId: approverUserId, live: owner.live === true } };

  const statements = [
    preflightStatement(db, { guildId, checkId, tokenHash, now, rosterSyncId, approverUserId, stateHash: preview.stateHash, idsText: approvedIdsText, transitionsText, confirmedJson: idsJson }),
    ...act.statements,
  ];
  // S1: the compare-and-set of the rank source.
  statements.push(db.prepare(
    `UPDATE guilds SET rank_source = 'ingame'
      WHERE id = ? AND rank_source IS NULL AND last_good_sync_id = ?
        AND EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ?) AND ${act.guard.sql}`,
  ).bind(guildId, rosterSyncId, guildId, approverUserId, ...act.guard.params));
  // S2 and S3: the approval is spent only if S1 applied; the marker exists only if the approval was spent.
  statements.push(consumeApprovalStatement(db, approval, { sql: 'changes() = 1', params: [] }));
  const flippedAt = statements.length;
  statements.push(markerStatement(db, { markerId, tokenHash, purpose: FLIP_MARKER_PURPOSE, now }));
  statements.push(
    // The seat: set from the stored Guild Master row's holder (the approver, S1 checked it), only while nobody holds it.
    moveSeatStatement(db, { guildId, from: null, to: approverUserId, guards: [marker] }),
    db.prepare(`DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND ${marker.sql}`).bind(guildId, ...marker.params),
    // The Discord role sync stops writing roles once a guild has a rank source, so the roles it gave become hand-set ones; a role the account already holds by hand has no use for a twin.
    db.prepare(`UPDATE OR IGNORE role_assignments SET source = 'manual' WHERE guild_id = ? AND source = 'discord' AND ${marker.sql}`).bind(guildId, ...marker.params),
    db.prepare(`DELETE FROM role_assignments WHERE guild_id = ? AND source = 'discord' AND ${marker.sql}`).bind(guildId, ...marker.params),
    // The name binding: identity keys for the approved characters, from the roster row that carries their name and realm.
    db.prepare(
      `UPDATE characters SET namespace = ${rosterColumn('namespace')}, blizzard_realm_id = ${rosterColumn('blizzard_realm_id')}, blizzard_char_id = ${rosterColumn('blizzard_char_id')}, updated_at = ?
        WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?)) AND blizzard_char_id IS NULL AND left_on IS NULL AND owner_proof IS NOT 'hand' AND ${marker.sql}`,
    ).bind(now, guildId, idsJson, ...marker.params),
    auditManyStatement(ctx, {
      guildId, actorUserId: approverUserId, action: 'character.match_roster', entityType: 'character', before: null, after: { via: 'flip' },
    }, (add) => `SELECT j.value AS entity_id FROM json_each(${add(idsJson)}) j WHERE EXISTS (SELECT 1 FROM fresh_act_markers WHERE act_id = ${add(markerId)}) LIMIT ${FLIP_AUDIT_DETAIL_CAP}`),
    // The first applyRankMap: the stale marking, the rank UPDATE, the Trial clock (the trial backfill). It reads the keys written just above.
    ...rankMapApplyStatements(db, { guildId, now, timeZone }, [marker, ingameGuard(guildId)]),
    auditStatement(ctx, {
      guildId, actorUserId: approverUserId, action: 'guild.source_switch', entityType: 'guild', entityId: guildId,
      before: { rankSource: null },
      after: { rankSource: 'ingame', unpinned: false, flip: true, ownerUserId: approverUserId, ...counts },
    }, marker),
  );
  return { statements, flippedAt, applied };
}
