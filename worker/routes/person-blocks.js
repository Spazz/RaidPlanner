// Blocking a roster person who has no account (user-hierarchy build, lane B7a; plan "Blocks", sec A9-05).
//   POST   /api/guild/:gid/roster/:pid/block   { reason? }   writes a person_blocks marker + tombstones for the person's Discord id and identity keys, takes the
//                                                            person off every team and withdraws their upcoming sign-ups, audited as person.block
//   DELETE /api/guild/:gid/roster/:pid/block                 lifts it: the marker and the tombstones (by block_ref 'p:<player id>' and by the refs its keys hit)
//   -> { blocked: true | false, personId, tombstoneMissing }
// The permission is the one of an account block (guild.access). A person who HAS an account (players.user_id, or a user holding its Discord id) is blocked through
// the account (POST /people/:uid/block), never here: 409 has_account.
// The OUTRANKS test (A9-05): the blocker must be strictly senior to the rank the person would have once an account owns it, i.e. the hand roles of its owning
// account (none: it has no account) and the rank-map role of its characters' identity keys on the in-game roster. The Owner passes. An Officer cannot block
// the person whose character holds an Officer-mapped in-game rank, however the person has not signed in yet. The same test guards the unblock.
import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { blockEffectStatements } from '../block-effects.js';
import {
  MISSING_KEY_LINE, liftTombstoneStatements, matchedRefsOf, personBlockRef, personKeys, planTombstones, splitLiftableRefs, tombstoneDeleteStatement, tombstoneInsertStatements,
} from '../block-tombstones.js';
import { isId } from '../ids.js';
import { isOwner, ownerSql } from '../owner.js';
import { ROLE_RANK, loadGuildContext, requireAction } from '../permissions.js';
import { actorHolds, and } from './people.js';
import { wrote } from '../d1-changes.js';

const MAX_REASON = 200;

const notFound = () => new HttpError(404, 'not_found', 'That person was not found.');
const forbidden = () => new HttpError(403, 'forbidden', 'You cannot remove that person\'s access.');
const conflict = () => new HttpError(409, 'conflict', 'That changed while you were working on it. Reload and try again.');

// SQL: the rank the person would have (person, guild: SQL expressions; the bare form below takes placeholders in that order). 0 Guild Master, 1 Officer, 2 Team Lead, 3 Member.
// Exported with accountLessSql for worker/users-bulk.js, which asks the same question for many persons in one statement.
export const prospectiveRankSql = (personExpr, guildExpr) => `COALESCE((
    SELECT MIN(CASE m.role_id WHEN 'guild_master' THEN 0 WHEN 'officer' THEN 1 WHEN 'team_lead' THEN 2 ELSE 3 END)
      FROM characters c
      JOIN guild_roster gr ON gr.guild_id = c.guild_id AND gr.namespace = c.namespace AND gr.blizzard_realm_id = c.blizzard_realm_id AND gr.blizzard_char_id = c.blizzard_char_id
      JOIN source_rank_maps m ON m.guild_id = gr.guild_id AND m.source = 'ingame' AND m.source_key = CAST(gr.rank AS TEXT) AND m.team_id IS NULL
     WHERE c.player_id = ${personExpr} AND c.guild_id = ${guildExpr} AND c.left_on IS NULL
       AND EXISTS (SELECT 1 FROM guilds x WHERE x.id = c.guild_id AND x.rank_source = 'ingame')), ${ROLE_RANK.member})`;
const PROSPECTIVE_RANK_SQL = prospectiveRankSql('?', '?');

// The person has no account: no players.user_id and no user holds its Discord id (worker/seniority.js ACCOUNT_OF_PERSON, the one definition).
export const accountLessSql = (personExpr, guildExpr) => `NOT EXISTS (SELECT 1 FROM players x WHERE x.id = ${personExpr} AND x.guild_id = ${guildExpr}
    AND (x.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM users du WHERE du.discord_id = x.discord_user_id)))`;
const ACCOUNT_LESS_SQL = accountLessSql('?', '?');

// { sql, params }: true while the actor is the Owner or strictly senior to the person's prospective rank.
function actorOutranksPerson(guildId, actorId, playerId) {
  return { sql: outranksPersonSql('?', '?', '?'), params: [guildId, actorId, actorId, guildId, actorId, playerId, guildId] };
}

// The same over SQL expressions (guild, actor, person), for a statement that asks it of many persons. Bare placeholders come out in the order guild, actor, actor, guild, actor, person, guild.
export const outranksPersonSql = (guildExpr, actorExpr, personExpr) => {
  const actorRank = `COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ${guildExpr} AND ra.user_id = ${actorExpr}), ${ROLE_RANK.member})`;
  return `(${ownerSql(guildExpr, actorExpr)} OR ${actorRank} < ${prospectiveRankSql(personExpr, guildExpr)})`;
};

async function loadTarget(ctx, guildContext) {
  const { pid } = ctx.params;
  if (!isId('p', pid)) throw notFound();
  const guildId = guildContext.guild.id;
  const [person, blocked, rank, hasAccount] = await ctx.db.batch([
    ctx.db.prepare('SELECT id FROM players WHERE id = ? AND guild_id = ?').bind(pid, guildId),
    ctx.db.prepare('SELECT reason, tombstone_missing FROM person_blocks WHERE guild_id = ? AND player_id = ?').bind(guildId, pid),
    ctx.db.prepare(`SELECT ${PROSPECTIVE_RANK_SQL} AS rank`).bind(pid, guildId),
    ctx.db.prepare(`SELECT NOT (${ACCOUNT_LESS_SQL}) AS has_account`).bind(pid, guildId),
  ]);
  if (!person.results.length) throw notFound();
  return { pid, blocked: blocked.results[0] || null, prospectiveRank: rank.results[0].rank, hasAccount: hasAccount.results[0].has_account === 1 };
}

// The viewer may act on this person: the Owner, or strictly senior to the prospective rank. The write repeats it.
async function assertOutranks(ctx, guildContext, target) {
  if (await isOwner(ctx.db, guildContext.guild.id, guildContext.userId)) return;
  if (!(guildContext.rank < target.prospectiveRank)) throw forbidden();
}

// tombstonesKept: how many refs of earlier blocks the actor may not lift (a senior's) kept their tombstones when this unblock lifted the person's own (only present when > 0).
const answer = (pid, blocked, tombstoneMissing, tombstonesKept = 0) => jsonResponse({ blocked, personId: pid, tombstoneMissing, ...(tombstonesKept > 0 ? { tombstonesKept } : {}) });

export async function blockRosterPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const reason = ctx.body.reason === undefined || ctx.body.reason === null ? null : (cleanText(ctx.body.reason, 'reason', { min: 0, max: MAX_REASON }) || null);
  const target = await loadTarget(ctx, guildContext);
  if (target.hasAccount) {
    throw new HttpError(409, 'has_account', 'That person has an account. Remove the account\'s access instead.');
  }
  await assertOutranks(ctx, guildContext, target);
  if (target.blocked) return answer(target.pid, true, target.blocked.tombstone_missing === 1);

  const guildId = guildContext.guild.id;
  const actorId = guildContext.userId;
  const now = ctx.now();
  const plan = await planTombstones(ctx.env, guildId, await personKeys(ctx.db, guildId, target.pid));
  if (plan.missing) ctx.log(MISSING_KEY_LINE);
  const guard = and(
    { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ?)', params: [target.pid, guildId] },
    { sql: ACCOUNT_LESS_SQL, params: [target.pid, guildId] },
    actorHolds('guild.access', guildId, actorId),
    actorOutranksPerson(guildId, actorId, target.pid),
  );
  const written = {
    sql: 'EXISTS (SELECT 1 FROM person_blocks WHERE guild_id = ? AND player_id = ? AND blocked_by = ? AND created_at = ?)',
    params: [guildId, target.pid, actorId, now],
  };
  let results;
  try {
    results = await ctx.db.batch([
      ctx.db.prepare(
        `INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      ).bind(guildId, target.pid, actorId, reason, plan.missing ? 1 : 0, now, ...guard.params),
      ...tombstoneInsertStatements(ctx.db, { guildId, blockRef: personBlockRef(target.pid), plan, now, guard: written }),
      ...(await blockEffectStatements(ctx.db, { guildId, target: { playerId: target.pid }, nowMs: now, guard: written, timeZone: guildContext.guild.time_zone })),
      // The reason text stays out of the audit log.
      auditStatement(ctx, {
        guildId, actorUserId: actorId, action: 'person.block', entityType: 'person', entityId: target.pid,
        before: { blocked: false }, after: { blocked: true, reasonSet: reason !== null },
      }, written),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return answer(target.pid, true, false);
  }
  if (!wrote(results[0])) throw conflict();
  return answer(target.pid, true, plan.missing);
}

export async function unblockRosterPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const target = await loadTarget(ctx, guildContext);
  await assertOutranks(ctx, guildContext, target);
  if (!target.blocked) return answer(target.pid, false, false);

  const guildId = guildContext.guild.id;
  const actorId = guildContext.userId;
  // The person's own ref always goes; the refs its keys matched (earlier blocks of the same person) only when the block that wrote them is of the actor's rank or below, or the actor's own.
  const own = personBlockRef(target.pid);
  const matched = (await matchedRefsOf(ctx.db, ctx.env, guildId, await personKeys(ctx.db, guildId, target.pid))).filter((ref) => ref !== own);
  const split = await splitLiftableRefs(ctx.db, guildId, matched, { owner: await isOwner(ctx.db, guildId, actorId), rank: guildContext.rank, actorId });
  const guard = and(
    { sql: 'EXISTS (SELECT 1 FROM person_blocks WHERE guild_id = ? AND player_id = ?)', params: [guildId, target.pid] },
    actorHolds('guild.access', guildId, actorId),
    actorOutranksPerson(guildId, actorId, target.pid),
  );
  const results = await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: actorId, action: 'person.unblock', entityType: 'person', entityId: target.pid, before: { blocked: true }, after: { blocked: false },
    }, guard),
    tombstoneDeleteStatement(ctx.db, { guildId, blockRefs: [own], guard }),
    ...liftTombstoneStatements(ctx.db, { guildId, actorId, split, guard }),
    ctx.db.prepare(`DELETE FROM person_blocks WHERE guild_id = ? AND player_id = ? AND ${guard.sql}`).bind(guildId, target.pid, ...guard.params),
  ]);
  if (!wrote(results[results.length - 1])) {
    // Someone lifting it first is fine; if the marker is still there, the actor lost the right.
    const still = await ctx.db.prepare('SELECT 1 AS found FROM person_blocks WHERE guild_id = ? AND player_id = ?').bind(guildId, target.pid).first();
    if (still) throw conflict();
  }
  return answer(target.pid, false, false, split.kept.length);
}
