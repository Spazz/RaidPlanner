// The automatic Raid-Helper refresh: the 15-minute scheduler asks Raid-Helper again about the event of every upcoming raid that has one, every 2 h inside the last
// 48 h before the start and every 12 h before that (worker/notify.js refreshDue), and replaces the raid's Raid-Helper sign-ups exactly as an officer's refresh does
// (routes/raids.js eventLinkStatements). It NEVER moves a raid: when Raid-Helper says the event is on another guild-local day, the raid stays where it is and
// raids.event_moved_on records the event's date, which Needs attention shows and the officer settles by hand (the 409 event_other_day rule of PUT .../event).
// ctx: { db, env, fetch, now, randomBytes, log } (the scheduler's; no session).
import { localDate } from './attendance-calendar.js';
import { recomputeRaid } from './attendance-store.js';
import { hasDiscord } from './discord-guard.js';
import { MAX_GUILDS_PER_RUN, MAX_REFRESHES_PER_RUN, refreshDue } from './notify.js';
import { eventLinkStatements } from './routes/raids.js';
import { fetchRaidHelperEvent } from './sources.js';
import { reconcileStanding } from './standing.js';

const CANDIDATES = 200; // the nearest raids with an event are looked at first; the rest wait for a later run
const GUILD_COLUMNS = 'id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, wcl_guild_id, created_at';

// -> 'refreshed' | 'moved' | 'failed'. Every answer stamps event_checked_at, so a dead event is not asked about every 15 minutes.
async function refreshOne(ctx, guild, raid) {
  const { db } = ctx;
  const stamp = () => db.prepare('UPDATE raids SET event_checked_at = ? WHERE id = ? AND guild_id = ?').bind(ctx.now(), raid.id, guild.id).run();
  // Raid-Helper events live in a Discord server: a guild without one never asks Raid-Helper.
  if (!hasDiscord(guild)) {
    await stamp();
    return 'failed';
  }
  let event;
  try {
    event = await fetchRaidHelperEvent(ctx, raid.event_id);
  } catch {
    await stamp();
    return 'failed';
  }
  // Only an event from the guild's own Discord server, or the other server an officer accepted when linking it.
  if (event.serverId !== guild.discord_server_id && (raid.event_server === null || event.serverId !== raid.event_server)) {
    await stamp();
    return 'failed';
  }
  // An officer may have unlinked or replaced the event while Raid-Helper was answering: then this answer is not for the raid any more.
  const current = await db.prepare('SELECT event_id FROM raids WHERE id = ? AND guild_id = ?').bind(raid.id, guild.id).first();
  if (!current || current.event_id !== raid.event_id) return 'failed';
  const eventDate = event.startTime ? localDate(event.startTime, guild.time_zone) : null;
  if (raid.reports === 0 && eventDate !== null && eventDate !== raid.raid_on) {
    await db.prepare('UPDATE raids SET event_moved_on = ?, event_checked_at = ? WHERE id = ? AND guild_id = ?').bind(eventDate, ctx.now(), raid.id, guild.id).run();
    return 'moved';
  }
  const built = eventLinkStatements(ctx, guild, raid, event, raid.event_id, { eventDate });
  try {
    await db.batch(built.statements);
  } catch {
    await stamp();
    return 'failed';
  }
  // People the event dropped have no Raid-Helper row any more: the standing sign-ups follow; then the date is recalculated.
  await reconcileStanding(ctx, guild, { raidIds: [raid.id] });
  await recomputeRaid(ctx, guild, raid.id);
  return 'refreshed';
}

// -> { due, refreshed, moved, failed }. Bounded: at most maxRefreshes asks to Raid-Helper and maxGuilds guilds per run. Never throws.
export async function refreshDueEvents(ctx, { maxRefreshes = MAX_REFRESHES_PER_RUN, maxGuilds = MAX_GUILDS_PER_RUN } = {}) {
  const totals = { due: 0, refreshed: 0, moved: 0, failed: 0 };
  try {
    const now = ctx.now();
    const rows = (await ctx.db.prepare(
      `SELECT r.id, r.guild_id, r.team_id, r.raid_on, r.starts_at, r.event_id, r.event_server, r.event_synced, r.event_checked_at,
              (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports
         FROM raids r WHERE r.event_id IS NOT NULL AND r.starts_at > ? ORDER BY r.starts_at, r.id LIMIT ?`,
    ).bind(now, CANDIDATES).all()).results;
    const due = rows.filter((row) => refreshDue(row, now));
    totals.due = due.length;
    const guilds = new Map();
    let asked = 0;
    for (const raid of due) {
      if (asked >= maxRefreshes) break;
      if (!guilds.has(raid.guild_id)) {
        if (guilds.size >= maxGuilds) continue;
        guilds.set(raid.guild_id, await ctx.db.prepare(`SELECT ${GUILD_COLUMNS} FROM guilds WHERE id = ?`).bind(raid.guild_id).first());
      }
      const guild = guilds.get(raid.guild_id);
      if (!guild || !hasDiscord(guild)) continue; // no guild, or one without a Discord server: nothing to ask Raid-Helper
      asked++;
      const result = await refreshOne(ctx, guild, raid);
      totals[result]++;
    }
  } catch (error) {
    try { ctx.log(`event refresh failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  return totals;
}
