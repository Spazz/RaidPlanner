// The team progress board (PM wave 7): GET /api/guild/:gid/teams/:tid/progress. Per zone, each boss the team has pulled with its first kill, the wipes
// before it, the kills since, and the best clear time. Built only from the stored pulls (worker/progress.js, worker/progress-store.js): derived data,
// nothing of a report. For whoever may see the team's raids (raids.view).
import { HttpError, jsonResponse } from '../http.js';
import { allows, loadGuildContext } from '../permissions.js';
import { loadProgress } from '../progress-store.js';

export async function getTeamProgress(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await ctx.db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ?').bind(ctx.params.tid, guild.id).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist in this guild.');
  if (!allows(guildContext.can, 'raids.view', team.id)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  return jsonResponse({ team: { id: team.id, name: team.name }, ...(await loadProgress(ctx.db, guild, team.id)) });
}
