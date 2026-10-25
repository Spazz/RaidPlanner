// The officers' side of character claims: the pending list (each with what approving it would do), approve and reject.
// A member never writes the roster: a claim is a request, and Approve is an ordinary roster write made by someone with roster.edit.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { CLAIM_BLOCKED_TEXT, planClaims } from '../bnet-store.js';
import { isId, newId } from '../ids.js';
import { allows, isGranted, loadGuildContext } from '../permissions.js';
import { toPerson } from '../person.js';
import { coreRankOfPersonSql, syncCharacterRanksStatement } from '../person-legacy.js';
import { CREATE_STATUSES } from '../roster-data.js';
import { markPersonRaidsStale, markRaidsStale } from '../attendance-store.js';
import { canSeeAvatars, guildToday, loadPendingClaims, loadRosterFlags } from '../roster-view.js';
import { bad, constraintOf, limitError, requireTarget } from './roster.js';

const MAX_LIST = 200;
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const PENDING = (id) => ({ sql: "EXISTS (SELECT 1 FROM character_claims WHERE id = ? AND status = 'pending')", params: [id] });

// Whether the viewer's roster.edit reaches what approving this plan would write.
function canDecide(guildContext, plan) {
  const can = guildContext.can;
  if (plan.kind === 'blocked') return false;
  if (plan.kind === 'add_alt' || plan.kind === 'link_person') return allows(can, 'roster.edit', plan.homeTeamId);
  return isGranted(can['roster.edit']);
}

const planView = (guildContext, plan) => ({
  kind: plan.kind,
  reason: plan.reason,
  message: plan.reason ? CLAIM_BLOCKED_TEXT[plan.reason] : null,
  person: plan.person,
  defaultTeamId: plan.defaultTeamId,
  canDecide: canDecide(guildContext, plan),
});

async function loadPendingClaim(db, guildId, claimId) {
  if (!isId('cl', claimId)) throw new HttpError(404, 'not_found', 'That claim was not found.');
  const claim = await db.prepare(
    `SELECT cl.id, cl.guild_id, cl.user_id, cl.name, cl.name_key, cl.realm, cl.realm_key, cl.class, cl.level, cl.status, cl.created_at, u.discord_id
       FROM character_claims cl JOIN users u ON u.id = cl.user_id WHERE cl.id = ? AND cl.guild_id = ?`,
  ).bind(claimId, guildId).first();
  if (!claim) throw new HttpError(404, 'not_found', 'That claim was not found.');
  if (claim.status !== 'pending') throw new HttpError(409, 'claim_decided', 'Someone already decided this claim. Reload to see it.');
  return claim;
}

export async function listClaims(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw forbidden();
  const guild = guildContext.guild;
  const result = await ctx.db.prepare(
    `SELECT cl.id, cl.user_id, cl.name, cl.name_key, cl.realm, cl.realm_key, cl.class, cl.level, cl.created_at,
            u.discord_id, u.username, u.global_name, u.display_name, u.avatar
       FROM character_claims cl JOIN users u ON u.id = cl.user_id
      WHERE cl.guild_id = ? AND cl.status = 'pending' ORDER BY cl.created_at, cl.id LIMIT ?`,
  ).bind(guild.id, MAX_LIST).all();
  const plans = await planClaims(ctx.db, guild, result.results);
  const showAvatar = canSeeAvatars(guildContext.can);
  return jsonResponse({
    claims: result.results.map((row) => ({
      id: row.id,
      character: { name: row.name, realm: row.realm, class: row.class, level: row.level },
      claimedAt: row.created_at,
      claimant: toPerson(row, { avatar: showAvatar }),
      plan: planView(guildContext, plans.get(row.id)),
    })),
  });
}

const JOIN_GUARD_ERRORS = {
  person_limit: () => limitError('person_limit'),
  character_limit: () => limitError('character_limit'),
  guild_characters_cap: () => limitError('guild_characters_cap'),
};

// Body: { expectedKind, teamId (add_alt and new_person), status (new_person: raider | trial | reserve) }.
export async function approveClaim(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw forbidden();
  const guild = guildContext.guild;
  if (typeof body.expectedKind !== 'string') throw bad('Send what the page showed for this claim.', 'expectedKind');
  const claim = await loadPendingClaim(db, guild.id, ctx.params.clid);
  const plan = (await planClaims(db, guild, [claim])).get(claim.id);
  if (body.expectedKind !== plan.kind) {
    throw new HttpError(409, 'claim_changed', 'The roster changed since you loaded this claim. Reload to see what approving it does now.');
  }
  if (plan.kind === 'blocked') throw new HttpError(409, 'claim_blocked', CLAIM_BLOCKED_TEXT[plan.reason]);
  if (!canDecide(guildContext, plan)) throw forbidden();

  const now = ctx.now();
  const userId = ctx.session.user.id;
  const pending = PENDING(claim.id);
  const writes = [];
  let team = null;
  let personId = plan.person ? plan.person.id : null;
  // core_rank from the person's players row (dual write, worker/person-legacy.js); the writes end with syncCharacterRanksStatement for the rest.
  const insertCharacter = (playerId, isMain) => db.prepare(
    `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at, core_rank)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ${coreRankOfPersonSql('?')} WHERE ${pending.sql}`,
  ).bind(newId('c', ctx.randomBytes), guild.id, playerId, team.id, claim.name, claim.name_key, claim.realm, claim.realm_key, claim.class,
    isMain ? 1 : 0, now, now, playerId, ...pending.params);

  if (plan.kind === 'add_alt') {
    team = await requireTarget(db, guild.id, body.teamId);
    if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
    writes.push(insertCharacter(plan.person.id, false), syncCharacterRanksStatement(db, guild.id, plan.person.id));
  } else if (plan.kind === 'new_person') {
    team = await requireTarget(db, guild.id, body.teamId);
    if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
    const status = body.status === undefined ? 'trial' : body.status;
    if (!CREATE_STATUSES.includes(status)) throw bad('Pick raider, trial or reserve.', 'status');
    personId = newId('p', ctx.randomBytes);
    const today = guildToday(guild, now);
    writes.push(db.prepare(
      `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, discord_user_id, discord_nickname, user_id, version, notes_version, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 1, 0, ?, ?, ? WHERE ${pending.sql}`,
    ).bind(personId, guild.id, status, today, status === 'trial' ? today : null, claim.discord_id, claim.user_id, userId, now, now, ...pending.params));
    writes.push(insertCharacter(personId, true), syncCharacterRanksStatement(db, guild.id, personId));
  } else if (plan.kind === 'link_person') {
    writes.push(db.prepare(
      `UPDATE players SET discord_user_id = ?, user_id = ?, discord_nickname = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND guild_id = ? AND discord_user_id IS NULL AND user_id IS NULL AND ${pending.sql}
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id = ?)`,
    ).bind(claim.discord_id, claim.user_id, now, plan.person.id, guild.id, ...pending.params, plan.homeTeamId));
    writes.push(markPersonRaidsStale(db, guild.id, plan.person.id));
  }
  if (team) writes.push(markRaidsStale(db, guild.id, [claim.name_key], null, [team.id]));

  // The decision lands only if the claim is still pending and (for a link) the person really belongs to the claimant's account now.
  const linked = plan.kind === 'link_person'
    ? { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND user_id = ?)', params: [plan.person.id, claim.user_id] }
    : { sql: '1 = 1', params: [] };
  const decided = { sql: `${pending.sql} AND ${linked.sql}`, params: [...pending.params, ...linked.params] };
  let results;
  try {
    results = await db.batch([
      ...writes,
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: userId, action: 'claim.approve', entityType: 'claim', entityId: claim.id,
        after: { outcome: plan.kind, teamId: team ? team.id : null, personId },
      }, decided),
      db.prepare(
        `UPDATE character_claims SET status = 'approved', team_id = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND guild_id = ? AND status = 'pending' AND ${linked.sql}`,
      ).bind(team ? team.id : null, userId, now, claim.id, guild.id, ...linked.params),
    ]);
  } catch (error) {
    const kind = constraintOf(error);
    if (JOIN_GUARD_ERRORS[kind]) throw JOIN_GUARD_ERRORS[kind]();
    if (kind === 'character_name') throw new HttpError(409, 'name_taken', 'That character was added to the roster while you were deciding. Reload.');
    if (kind === 'discord' || kind === 'account') throw new HttpError(409, 'claim_changed', 'The claimant was linked to a person while you were deciding. Reload.');
    if (kind === 'foreign_key') throw new HttpError(404, 'not_found', 'The person or team for this claim no longer exists.');
    throw error;
  }
  if (results[results.length - 1].meta.changes !== 1) {
    throw new HttpError(409, 'claim_decided', 'Someone already decided this claim, or the roster changed under it. Reload to see it.');
  }
  return jsonResponse({
    claim: { id: claim.id, status: 'approved' },
    outcome: plan.kind,
    personId,
    rosterFlags: await loadRosterFlags(db, guildContext, guildToday(guild, now)),
    pendingClaims: await loadPendingClaims(db, guildContext),
  });
}

export async function rejectClaim(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw forbidden();
  const claim = await loadPendingClaim(db, guildContext.guild.id, ctx.params.clid);
  const now = ctx.now();
  const pending = PENDING(claim.id);
  const results = await db.batch([
    auditStatement(ctx, {
      guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action: 'claim.reject', entityType: 'claim', entityId: claim.id,
    }, pending),
    db.prepare(
      `UPDATE character_claims SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND status = 'pending'`,
    ).bind(ctx.session.user.id, now, claim.id, guildContext.guild.id),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(409, 'claim_decided', 'Someone already decided this claim. Reload to see it.');
  return jsonResponse({ claim: { id: claim.id, status: 'rejected' }, pendingClaims: await loadPendingClaims(db, guildContext) });
}
