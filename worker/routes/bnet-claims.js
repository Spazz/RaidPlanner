// The officers' side of character claims that did not apply at once: the pending list (each with what approving it would do), approve, reject, and the one-off
// apply for claims that were waiting when claims began to apply at once. A member adds their own characters at once (worker/claim-apply.js); a claim stays
// a request only for a conflict, and Approve is an ordinary roster write made by someone with roster.edit.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { CLAIM_BLOCKED_TEXT, planClaims } from '../bnet-store.js';
import { isId } from '../ids.js';
import { applyClaimPlan, planPicks } from '../claim-apply.js';
import { allows, isGranted, loadGuildContext } from '../permissions.js';
import { toPerson } from '../person.js';
import { CREATE_STATUSES } from '../roster-data.js';
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

// The statements that close a claim as approved, after its outcome was written: the audit row (only while the claim was pending and, for a link, the person
// really is the claimant's now) and the claim itself.
function decideStatements(ctx, guild, claim, plan, applied, { teamId, userId, now, via = null }) {
  const { db } = ctx;
  const pending = PENDING(claim.id);
  const linked = plan.kind === 'link_person'
    ? { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND user_id = ?)', params: [plan.person.id, claim.user_id] }
    : { sql: '1 = 1', params: [] };
  const decided = { sql: `${pending.sql} AND ${linked.sql}`, params: [...pending.params, ...linked.params] };
  return [
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: userId, action: 'claim.approve', entityType: 'claim', entityId: claim.id,
      after: { outcome: plan.kind, teamId, personId: applied ? applied.personId : (plan.person ? plan.person.id : null), ...(via ? { via } : {}) },
    }, decided),
    db.prepare(
      `UPDATE character_claims SET status = 'approved', team_id = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND guild_id = ? AND status = 'pending' AND ${linked.sql}`,
    ).bind(teamId, userId, now, claim.id, guild.id, ...linked.params),
  ];
}

function mapDecideError(error) {
  const kind = constraintOf(error);
  if (JOIN_GUARD_ERRORS[kind]) return JOIN_GUARD_ERRORS[kind]();
  if (kind === 'character_name') return new HttpError(409, 'name_taken', 'That character was added to the roster while you were deciding. Reload.');
  if (kind === 'discord' || kind === 'account') return new HttpError(409, 'claim_changed', 'The claimant was linked to a person while you were deciding. Reload.');
  if (kind === 'foreign_key') return new HttpError(404, 'not_found', 'The person or team for this claim no longer exists.');
  return error;
}

const characterOf = (claim) => ({ name: claim.name, realm: claim.realm, realmKey: claim.realm_key, class: claim.class });
const claimantOf = (claim) => ({ userId: claim.user_id, discordId: claim.discord_id });

// Body: { expectedKind, teamId (new_person: the main's team, none = no team), status (new_person: raider | trial | reserve) }. An alt (add_alt) starts on no team
// (U R3-Q1/R4-Q1): a teamId sent with it is ignored. Since claims apply at once (worker/claim-apply.js) only a conflict, or a claim that was already waiting,
// reaches this route; the outcome is written by the same applyClaimPlan.
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
  let team = null;
  let status = 'trial';
  if (plan.kind === 'new_person') {
    team = body.teamId === undefined || body.teamId === null ? null : await requireTarget(db, guild.id, body.teamId);
    if (!allows(guildContext.can, 'roster.edit', team ? team.id : null)) throw forbidden();
    status = body.status === undefined ? 'trial' : body.status;
    if (!CREATE_STATUSES.includes(status)) throw bad('Pick raider, trial or reserve.', 'status');
  }
  // 'already' writes nothing but the decision; the other outcomes are the shared writes, each carrying the "still pending" guard.
  const applied = plan.kind === 'already' ? null : applyClaimPlan(ctx, {
    guild, plan, claimant: claimantOf(claim), character: characterOf(claim), source: 'bnet', now, actorId: userId, guard: PENDING(claim.id), team, status,
  });
  let results;
  try {
    results = await db.batch([
      ...(applied ? [...applied.writes, ...applied.stale] : []),
      ...decideStatements(ctx, guild, claim, plan, applied, { teamId: team ? team.id : null, userId, now }),
    ]);
  } catch (error) {
    throw mapDecideError(error);
  }
  if (results[results.length - 1].meta.changes !== 1) {
    throw new HttpError(409, 'claim_decided', 'Someone already decided this claim, or the roster changed under it. Reload to see it.');
  }
  return jsonResponse({
    claim: { id: claim.id, status: 'approved' },
    outcome: plan.kind,
    personId: applied ? applied.personId : plan.person.id,
    rosterFlags: await loadRosterFlags(db, guildContext, guildToday(guild, now)),
    pendingClaims: await loadPendingClaims(db, guildContext),
  });
}

const APPLY_LIMIT = 50;

// POST /claims/apply (roster.edit for the whole guild): the one-off for claims that were already waiting when claims began to apply at once (D2e). Every
// pending claim whose outcome is no conflict is applied as an officer's approval would (a new person is a Trial with no team), a claim for a character
// already on the claimant's record is closed, and conflicts stay. A claim typed by hand (no level) never links a person: that waits for a person to decide.
// -> { applied, closed, left, more }   (at most 50 claims per call; more = true when there are others waiting)
export async function applyPendingClaims(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (guildContext.can['roster.edit'] !== 'guild') throw forbidden();
  const guild = guildContext.guild;
  const result = await db.prepare(
    `SELECT cl.id, cl.guild_id, cl.user_id, cl.name, cl.name_key, cl.realm, cl.realm_key, cl.class, cl.level, cl.created_at, u.discord_id
       FROM character_claims cl JOIN users u ON u.id = cl.user_id
      WHERE cl.guild_id = ? AND cl.status = 'pending' ORDER BY cl.user_id, cl.created_at, cl.id LIMIT ?`,
  ).bind(guild.id, APPLY_LIMIT + 1).all();
  const claims = result.results.slice(0, APPLY_LIMIT);
  const byUser = new Map();
  for (const claim of claims) byUser.set(claim.user_id, [...(byUser.get(claim.user_id) || []), claim]);
  const now = ctx.now();
  const userId = ctx.session.user.id;
  const counts = { applied: 0, closed: 0, left: 0 };
  for (const list of byUser.values()) {
    const claimant = claimantOf(list[0]);
    const picks = list.map((claim, index) => ({ index, name: claim.name, realm: { realm: claim.realm, key: claim.realm_key }, class: claim.class, level: claim.level }));
    // A claim with a level came from a Battle.net list; one without was typed by hand.
    const source = list.every((claim) => claim.level !== null) ? 'bnet' : 'hand';
    const planned = await planPicks(ctx, guild, claimant, picks, { source });
    const statements = [];
    const keys = [];
    planned.forEach((entry, i) => {
      const claim = list[i];
      if (entry.kind === 'conflict' || entry.kind === 'taken') { counts.left++; return; }
      const applied = entry.kind === 'already' ? null : applyClaimPlan(ctx, {
        guild, plan: entry.plan, claimant, character: characterOf(claim), source, now, actorId: userId, personId: entry.personId, guard: PENDING(claim.id),
      });
      if (applied) statements.push(...applied.writes, ...applied.stale);
      statements.push(...decideStatements(ctx, guild, claim, entry.plan, applied, { teamId: null, userId, now, via: 'apply' }));
      keys.push({ at: statements.length - 1, closed: !applied });
    });
    if (!statements.length) continue;
    let results;
    try {
      results = await db.batch(statements);
    } catch (error) {
      throw mapDecideError(error);
    }
    for (const key of keys) {
      if (results[key.at].meta.changes === 1) counts[key.closed ? 'closed' : 'applied']++; else counts.left++;
    }
  }
  return jsonResponse({ ...counts, more: result.results.length > APPLY_LIMIT, pendingClaims: await loadPendingClaims(db, guildContext) });
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
