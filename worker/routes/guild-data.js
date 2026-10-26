// Guild lifecycle routes (Phase 8): the Guild Master's copy of the guild's data and the guild's deletion, plus dismissing the setup checklist.
//   GET    /api/guild/:gid/export                 (Guild Master)  the guild's data as one JSON file (worker/guild-export.js says what is and is not in it)
//   DELETE /api/guild/:gid                        (Owner)         body { confirmName }: the guild's name, typed; deletes the guild and everything in it
//   POST   /api/guild/:gid/onboarding/dismiss     (whoever sets the guild up)  hides the checklist card on Home for everyone
import { HttpError, SECURITY_HEADERS, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { hasDiscord } from '../discord-guard.js';
import { buildGuildExport } from '../guild-export.js';
import { sees } from '../onboarding.js';
import { requireOwner } from '../owner.js';
import { loadGuildContext } from '../permissions.js';
import { EXPORT_LIMIT, EXPORT_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { todayIn } from '../roster-data.js';
import { slugOf } from './audit.js';

function requireGuildMaster(guildContext) {
  if (!guildContext.isGuildMaster) throw new HttpError(403, 'forbidden', 'Only the Guild Master can do that.');
}

export async function exportGuild(ctx) {
  const { db, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  requireGuildMaster(guildContext);
  const guild = guildContext.guild;
  // A whole-guild read: a few a quarter hour is plenty.
  await enforceRateLimit(db, session.user.id, ctx.now(), { key: `exp:${session.user.id}`, limit: EXPORT_LIMIT, windowMs: EXPORT_WINDOW_MS });
  const data = await buildGuildExport(db, guildContext, ctx.now());
  await db.batch([
    auditStatement(ctx, { guildId: guild.id, actorUserId: session.user.id, action: 'guild.export', entityType: 'guild', entityId: guild.id }),
  ]);
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Content-Disposition', `attachment; filename="raidsmith-guild-${slugOf(guild.name)}-${todayIn(guild.time_zone, ctx.now())}.json"`);
  return new Response(JSON.stringify(data), { status: 200, headers });
}

// The Discord server of a deleted guild keeps no membership rows (blocked people included), exactly like when an account deletes its last guild.
export async function deleteGuild(ctx) {
  const { db, session, body } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  // An Owner act (plan "Owner-only acts"): a Guild Master by role who does not hold the Owner seat cannot delete the guild.
  await requireOwner(db, guildContext, 'Only the Owner of the guild can delete it.');
  const guild = guildContext.guild;
  const typed = typeof body.confirmName === 'string' ? body.confirmName.trim() : '';
  if (typed !== guild.name) {
    throw new HttpError(400, 'confirm_mismatch', 'Type the guild name exactly as shown to delete the guild.', { field: 'confirmName' });
  }
  await db.batch([
    // guild_id stays NULL: the row would go with the guild otherwise (the same record deleting an account leaves).
    auditStatement(ctx, { guildId: null, actorUserId: session.user.id, action: 'guild.delete', entityType: 'guild', entityId: guild.id }),
    db.prepare('DELETE FROM guilds WHERE id = ?').bind(guild.id),
    // A guild without Discord has no server membership rows to clear.
    ...(hasDiscord(guild) ? [db.prepare('DELETE FROM user_servers WHERE server_id = ? AND NOT EXISTS (SELECT 1 FROM guilds WHERE discord_server_id = user_servers.server_id)')
      .bind(guild.discord_server_id)] : []),
  ]);
  return jsonResponse({ ok: true });
}

export async function dismissOnboarding(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!sees(guildContext)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  await ctx.db.prepare('UPDATE guilds SET onboarding_dismissed_at = ? WHERE id = ? AND onboarding_dismissed_at IS NULL')
    .bind(ctx.now(), guildContext.guild.id).run();
  return jsonResponse({ ok: true });
}
