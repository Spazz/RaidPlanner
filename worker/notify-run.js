// Which Discord channel posts go out, and the data behind them: the scheduler's pass over the upcoming raids of teams that have a usable webhook (raid
// reminders 24 h and 2 h before, people who have not answered, rostered people who have not confirmed), and the two posts a route makes the moment something
// happens (the roster is published, loot is imported). Bounded per run: at most MAX_GUILDS_PER_RUN guilds and MAX_MESSAGES_PER_RUN messages, nearest raids first.
// ctx: { db, env, fetch, now, randomBytes, log }. Nothing here throws.
import { raidAwayEffects, readNotices, teamNoticesStatement } from './away-store.js';
import { canonicalOrigin } from './discord.js';
import {
  MAX_GUILDS_PER_RUN, MAX_MESSAGES_PER_RUN, NOREPLY_HOURS, confirmBody, dedupeKeyOf, dueKinds, lootBody, noReplyBody, raidLink, reminderBody, rosterBody,
} from './notify.js';
import { loadTeamNotify, notifyOnce, usable } from './notify-store.js';
import { effectiveRaidSize } from './raid-zones.js';
import { MERGED_ROWS } from './routes/raids.js';
import { HOUR_MS, MAX_CLOSE_HOURS, closesAtOf } from './signup-window.js';

const CANDIDATES = 500;
// The farthest a no-reply reminder can open: the deadline is up to MAX_CLOSE_HOURS before the start and the lead time up to the largest option before that.
const HORIZON_MS = (MAX_CLOSE_HOURS + Math.max(...NOREPLY_HOURS) + 1) * HOUR_MS;

// Both come from the person's account when it has one (a Discord sign-in), else from the Discord ID an import stored. The opt-out is the account's.
const MENTION_COLUMNS = `COALESCE((SELECT u.discord_id FROM users u WHERE u.id = p.user_id), p.discord_user_id) AS discord_id,
  EXISTS (SELECT 1 FROM reminder_optouts o WHERE o.user_id = COALESCE(p.user_id, (SELECT u2.id FROM users u2 WHERE u2.discord_id = p.discord_user_id))) AS opted_out`;

const personOf = (row) => ({ name: row.name, discordId: row.discord_id || null, optedOut: row.opted_out === 1 });

// ---------------------------------------------------------------------------
// The data of a message

async function signupCounts(db, raidId) {
  const rows = (await db.prepare(
    `SELECT s.kind, s.standby, COUNT(*) AS n FROM raid_signups s WHERE s.raid_id = ? AND ${MERGED_ROWS} GROUP BY s.kind, s.standby`,
  ).bind(raidId).all()).results;
  const counts = { signed: 0, late: 0, tentative: 0, absence: 0 };
  for (const row of rows) {
    if (row.kind === 'signed' && row.standby === 0) counts.signed += row.n;
    else if (row.kind === 'late') counts.late += row.n;
    else if (row.kind === 'tentative') counts.tentative += row.n;
    else if (row.kind === 'absence') counts.absence += row.n;
  }
  return counts;
}

// Raiders and trials with a character on the raid's team who have no sign-up on the raid (Raid-Helper, Raidsmith or a standing one) and no away, late or
// leaving-early notice that covers its date: the people the raid is still waiting for. [{ name, discordId, optedOut }], by name.
export async function noReplyPeople(ctx, raid) {
  const { db } = ctx;
  const [peopleResult, noticeResult] = await db.batch([
    db.prepare(
      `SELECT p.id, ${MENTION_COLUMNS},
              (SELECT c.name FROM characters c WHERE c.player_id = p.id AND c.team_id = ?2 ORDER BY c.is_main DESC, c.id LIMIT 1) AS name
         FROM players p
        WHERE p.guild_id = ?1 AND p.status IN ('raider', 'trial')
          AND EXISTS (SELECT 1 FROM characters c WHERE c.player_id = p.id AND c.team_id = ?2)
          AND NOT EXISTS (SELECT 1 FROM raid_signups s WHERE s.raid_id = ?3 AND s.player_id = p.id AND s.source IN ('raid_helper', 'raidsmith'))
        ORDER BY name, p.id`,
    ).bind(raid.guild_id, raid.team_id, raid.id),
    teamNoticesStatement(db, raid.guild_id, raid.team_id, null, raid.raid_on, raid.raid_on),
  ]);
  const candidates = peopleResult.results;
  const effects = raidAwayEffects(readNotices(noticeResult.results), raid.raid_on);
  const answered = new Set([...effects.away.map((entry) => entry.personId), ...effects.notes.keys()]);
  return candidates.filter((row) => !answered.has(row.id)).map(personOf);
}

// The seats of the published roster that nobody has answered yet, in roster order (the bench last).
export async function unconfirmedPeople(db, raidId) {
  const rows = (await db.prepare(
    `SELECT rr.name, rr.player_id, ${MENTION_COLUMNS}
       FROM raid_roster rr LEFT JOIN players p ON p.id = rr.player_id
      WHERE rr.raid_id = ? AND rr.status = 'pending'
      ORDER BY rr.group_number = 0, rr.group_number, rr.seq, rr.name_key`,
  ).bind(raidId).all()).results;
  return rows.map(personOf);
}

async function rosterSeats(db, raidId) {
  const rows = (await db.prepare('SELECT name, group_number, class, spec FROM raid_roster WHERE raid_id = ? ORDER BY group_number, seq, name_key').bind(raidId).all()).results;
  return rows.map((row) => ({ name: row.name, group: row.group_number, className: row.class, spec: row.spec }));
}

// ---------------------------------------------------------------------------
// The scheduler's pass

function builderFor(ctx, kind, row, origin) {
  const link = raidLink(origin, row.guild_id, row.id);
  const roleId = row.role_mention;
  if (kind === 'remind_24h' || kind === 'remind_2h') {
    return async () => ({
      body: reminderBody(kind, row, {
        teamName: row.team_name, link, roleId, size: effectiveRaidSize(row, row.team_size, row.game_version), counts: await signupCounts(ctx.db, row.id),
      }),
      people: 0,
    });
  }
  if (kind === 'no_reply') {
    return async () => {
      const people = await noReplyPeople(ctx, row);
      if (!people.length) return null;
      const closesAt = closesAtOf(row, row.signup_close_hours ?? row.team_close_hours ?? 0);
      return { body: noReplyBody(row, { teamName: row.team_name, link, roleId, people, closesAt }), people: people.length };
    };
  }
  return async () => { // confirm
    const people = await unconfirmedPeople(ctx.db, row.id);
    if (!people.length) return null;
    return { body: confirmBody(row, { teamName: row.team_name, link, roleId, people }), people: people.length };
  };
}

// -> { sent, retry, failed, disabled, guilds }. Messages already in notification_log (sent, final-failed, or claimed) are never sent again.
// A message whose webhook was refused is left as a 'retry': once an officer saves a new address the next run delivers it if the raid has not started.
export async function runNotifications(ctx, { maxMessages = MAX_MESSAGES_PER_RUN, maxGuilds = MAX_GUILDS_PER_RUN } = {}) {
  const totals = { sent: 0, retry: 0, failed: 0, disabled: 0, guilds: 0 };
  try {
    const now = ctx.now();
    const rows = (await ctx.db.prepare(
      `SELECT r.id, r.guild_id, r.team_id, r.raid_on, r.starts_at, r.time_known, r.zone, COALESCE(r.title, r.event_title) AS title, r.size, r.signups_locked,
              r.signup_close_hours, r.roster_published_at, t.name AS team_name, t.size AS team_size, t.signup_close_hours AS team_close_hours,
              g.game_version, n.webhook_url, n.role_mention, n.post_reminders, n.post_noreply, n.noreply_hours, n.post_confirm
         FROM raids r
         JOIN team_notifications n ON n.team_id = r.team_id AND n.webhook_url IS NOT NULL AND n.webhook_state = 'ok'
                                  AND (n.post_reminders = 1 OR n.post_noreply = 1 OR n.post_confirm = 1)
         JOIN teams t ON t.id = r.team_id AND t.archived = 0
         JOIN guilds g ON g.id = r.guild_id
        WHERE r.starts_at > ? AND r.starts_at <= ? ORDER BY r.starts_at, r.id LIMIT ?`,
    ).bind(now, now + HORIZON_MS, CANDIDATES).all()).results;
    const origin = canonicalOrigin(ctx.env);
    const guilds = new Set();
    const dead = new Set(); // teams whose webhook Discord just refused
    let messages = 0;
    for (const row of rows) {
      if (messages >= maxMessages) break;
      if (!guilds.has(row.guild_id)) {
        if (guilds.size >= maxGuilds) continue;
        guilds.add(row.guild_id);
      }
      if (dead.has(row.team_id)) continue;
      for (const kind of dueKinds(row, row, now)) {
        if (messages >= maxMessages) break;
        const outcome = await notifyOnce(ctx, {
          guildId: row.guild_id, teamId: row.team_id, raidId: row.id, kind, dedupeKey: dedupeKeyOf(kind, row.id), webhookUrl: row.webhook_url,
          build: builderFor(ctx, kind, row, origin),
        });
        if (Object.prototype.hasOwnProperty.call(totals, outcome.result)) { totals[outcome.result]++; messages++; }
        if (outcome.result === 'disabled') { dead.add(row.team_id); break; }
      }
    }
    totals.guilds = guilds.size;
  } catch (error) {
    try { ctx.log(`notifications failed: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// The posts a route makes itself

async function teamName(db, teamId) {
  const row = await db.prepare('SELECT name FROM teams WHERE id = ?').bind(teamId).first();
  return row ? row.name : '';
}

// The roster was just published: raid is the raids row (with roster_published_at set to this publish's time). Every publish is a post of its own.
export async function announceRoster(ctx, raid) {
  try {
    const settings = await loadTeamNotify(ctx.db, raid.team_id);
    if (!usable(settings, ctx.env) || settings.post_roster !== 1) return null;
    const name = await teamName(ctx.db, raid.team_id);
    const origin = canonicalOrigin(ctx.env);
    return await notifyOnce(ctx, {
      guildId: raid.guild_id, teamId: raid.team_id, raidId: raid.id, kind: 'roster', dedupeKey: `roster:${raid.id}:${raid.roster_published_at}`, webhookUrl: settings.webhook_url,
      build: async () => {
        const seats = await rosterSeats(ctx.db, raid.id);
        if (!seats.length) return null;
        return { body: rosterBody(raid, { teamName: name, link: raidLink(origin, raid.guild_id, raid.id), roleId: settings.role_mention, seats }), people: seats.length };
      },
    });
  } catch (error) {
    try { ctx.log(`roster post failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}

// Loot was just imported: awards are the NEW ones of the import, [{ itemName, winnerName | null, tag | null }]. An import that added nothing posts nothing.
// settings: the team's team_notifications row when the route already read it (null = none), else it is read here.
export async function announceLoot(ctx, raid, awards, settings = undefined) {
  try {
    if (!awards.length) return null;
    if (settings === undefined) settings = await loadTeamNotify(ctx.db, raid.team_id);
    if (!usable(settings, ctx.env) || settings.post_loot !== 1) return null;
    const name = await teamName(ctx.db, raid.team_id);
    const origin = canonicalOrigin(ctx.env);
    return await notifyOnce(ctx, {
      guildId: raid.guild_id, teamId: raid.team_id, raidId: raid.id, kind: 'loot', dedupeKey: `loot:${raid.id}:${ctx.now()}`, webhookUrl: settings.webhook_url,
      build: async () => ({ body: lootBody(raid, { teamName: name, link: raidLink(origin, raid.guild_id, raid.id), roleId: settings.role_mention, awards }), people: 0 }),
    });
  } catch (error) {
    try { ctx.log(`loot post failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}
