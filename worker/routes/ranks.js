// Rank progression (PM wave 7), the writes: an officer sets a person's rank (by hand, or by accepting the ladder's suggestion) or dismisses a suggestion for
// 30 days. A rank is a label on the person (players.rank, the id of a rank of the guild's ladder in the attendance policy, worker/rank-ladder.js); it is
// separate from the roster status. Needs attendance.review for the team the page was opened on (the person must have a character there).
//   PUT  /api/guild/:gid/roster/:pid/rank          { teamId, rank: <rank id> | null, via?: 'accept' | 'manual', expectedRank?: <the rank id the page showed> | null }
//   POST /api/guild/:gid/roster/:pid/rank/dismiss  { teamId, kind: 'promote' | 'review', to: <rank id> }
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { isId } from '../ids.js';
import { allows, loadGuildContext } from '../permissions.js';
import { DISMISS_DAYS, ladderOf } from '../rank-ladder.js';
import { guildToday } from '../roster-view.js';

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });

// The person, the team they are being ranked from and the guild's ladder, all checked. -> { guildContext, guild, person, team, ranks }
async function loadTarget(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const teamId = ctx.body.teamId;
  if (!isId('t', teamId)) throw bad('Pick a team.', 'teamId');
  const [personResult, teamResult, characterResult, policyResult] = await ctx.db.batch([
    ctx.db.prepare('SELECT id, status, rank, rank_on FROM players WHERE id = ? AND guild_id = ?').bind(ctx.params.pid, guild.id),
    ctx.db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guild.id),
    ctx.db.prepare('SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ? AND guild_id = ? LIMIT 1').bind(ctx.params.pid, teamId, guild.id),
    policyRowsStatement(ctx.db, guild.id),
  ]);
  const person = personResult.results[0];
  if (!person) throw new HttpError(404, 'not_found', 'That person was not found.');
  const team = teamResult.results[0];
  if (!team) throw bad('That team does not exist in this guild.', 'teamId');
  if (!allows(guildContext.can, 'attendance.review', team.id)) throw forbidden();
  if (!characterResult.results.length) throw bad('That person has no character on this team.', 'teamId');
  const ranks = ladderOf(makePolicyResolver(guild, policyResult.results).resolved(null));
  return { guildContext, guild, person, team, ranks };
}

const rankView = (ranks, id) => {
  const found = ranks.find((rank) => rank.id === id);
  return found ? { id: found.id, name: found.name } : null;
};

export async function putPersonRank(ctx) {
  const { guildContext, guild, person, team, ranks } = await loadTarget(ctx);
  const { body } = ctx;
  const rank = body.rank === undefined ? undefined : body.rank;
  if (rank === undefined || (rank !== null && typeof rank !== 'string')) throw bad('Send the rank id, or null to clear it.', 'rank');
  if (!ranks.length) throw bad('This guild has no rank ladder. Set one up in the attendance settings first.', 'rank');
  if (rank !== null && !ranks.some((entry) => entry.id === rank)) throw bad('That rank is not on the ladder.', 'rank');
  const via = body.via === undefined ? 'manual' : body.via;
  if (via !== 'accept' && via !== 'manual') throw bad('via is accept or manual.', 'via');
  if (body.expectedRank !== undefined && body.expectedRank !== person.rank) {
    throw new HttpError(409, 'conflict', 'Someone changed this rank. Reload and look again.', { rank: rankView(ranks, person.rank) });
  }
  const now = ctx.now();
  const today = guildToday(guild, now);
  if (rank === person.rank) return jsonResponse({ ok: true, changed: false, rank: rankView(ranks, rank), rankOn: person.rank_on });
  const rankOn = rank === null ? null : today;
  const stillTheSame = { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND rank IS ?)', params: [person.id, guild.id, rank] };
  const results = await ctx.db.batch([
    ctx.db.prepare('UPDATE players SET rank = ?, rank_on = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND rank IS ?')
      .bind(rank, rankOn, now, person.id, guild.id, person.rank),
    ctx.db.prepare('DELETE FROM rank_dismissals WHERE guild_id = ? AND player_id = ?').bind(guild.id, person.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: guildContext.userId, action: 'person.rank', entityType: 'person', entityId: person.id,
      before: { rank: person.rank, rankName: (rankView(ranks, person.rank) || {}).name || null },
      after: { rank, rankName: (rankView(ranks, rank) || {}).name || null, via, teamId: team.id },
    }, stillTheSame),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'conflict', 'Someone changed this rank. Reload and look again.');
  return jsonResponse({ ok: true, changed: true, rank: rankView(ranks, rank), rankOn });
}

export async function dismissRankSuggestion(ctx) {
  const { guildContext, guild, person, team, ranks } = await loadTarget(ctx);
  const { body } = ctx;
  if (body.kind !== 'promote' && body.kind !== 'review') throw bad('kind is promote or review.', 'kind');
  if (typeof body.to !== 'string' || !ranks.some((entry) => entry.id === body.to)) throw bad('That rank is not on the ladder.', 'to');
  const now = ctx.now();
  const until = now + DISMISS_DAYS * 24 * 60 * 60 * 1000;
  const stored = { sql: 'EXISTS (SELECT 1 FROM rank_dismissals WHERE guild_id = ? AND player_id = ? AND until = ?)', params: [guild.id, person.id, until] };
  await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, dismissed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, player_id) DO UPDATE SET kind = excluded.kind, to_rank = excluded.to_rank, until = excluded.until,
         dismissed_by = excluded.dismissed_by, created_at = excluded.created_at`,
    ).bind(guild.id, person.id, body.kind, body.to, until, guildContext.userId, now),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: guildContext.userId, action: 'rank.dismiss', entityType: 'person', entityId: person.id,
      after: { kind: body.kind, to: body.to, toName: rankView(ranks, body.to).name, until, teamId: team.id },
    }, stored),
  ]);
  return jsonResponse({ ok: true, until });
}
