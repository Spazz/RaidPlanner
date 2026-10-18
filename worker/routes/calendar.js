// The calendar feed. A member makes ONE private link per team (POST /calendar), subscribes a calendar app to it, and can replace or turn it
// off at any time. The link is /cal/<token>.ics: 32 random bytes, only their SHA-256 is stored (so the URL is shown once, in the answer to
// the POST), and every fetch re-checks that the account is still a member of the guild (worker/membership.js: in its Discord server or linked to a
// roster person, and not blocked) and may see the team's raids.
// The feed itself is reached with no cookie, so GET /cal/:cal is the one route here without a session; everything else is a normal guild route.
import { HttpError, SECURITY_HEADERS, jsonResponse } from '../http.js';
import { addDays } from '../attendance-calendar.js';
import { raidAwayEffects, readNotices, realSignupsStatement, teamNoticesStatement } from '../away-store.js';
import { buildIcs, countsLine, FEED_AHEAD_DAYS, FEED_PAST_DAYS, raidEnd, signupKindLabel } from '../calendar-feed.js';
import { isId, newId } from '../ids.js';
import { ownPersonStatement } from '../membership.js';
import { allows, loadGuildContext } from '../permissions.js';
import { guildToday } from '../roster-view.js';
import { hashToken, newSessionToken } from '../session.js';
import { bad } from './roster.js';
import { MERGED_ROWS } from './raids.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_FILE = /^([A-Za-z0-9_-]{43})\.ics$/;
const LAST_USED_INTERVAL_MS = 10 * 60 * 1000;
const KINDS = ['signed', 'late', 'standby', 'bench', 'tentative', 'absence'];
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// The team of the request ({ team } query or { teamId } body) in this guild, and the viewer's right to see its raids.
async function readTeam(ctx, guildContext, raw) {
  if (!isId('t', raw)) throw bad('Pick a team.', 'team');
  const team = await ctx.db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ?').bind(raw, guildContext.guild.id).first();
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  if (!allows(guildContext.can, 'raids.view', team.id)) throw forbidden();
  return team;
}

const statusOf = (team, row) => ({ team: { id: team.id, name: team.name }, subscribed: !!row, createdAt: row ? row.created_at : null, lastUsedAt: row ? row.last_used_at : null });

export async function getCalendarStatus(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const team = await readTeam(ctx, guildContext, new URL(ctx.request.url).searchParams.get('team'));
  const row = await ctx.db.prepare('SELECT created_at, last_used_at FROM calendar_tokens WHERE user_id = ? AND team_id = ? AND guild_id = ?')
    .bind(ctx.session.user.id, team.id, guildContext.guild.id).first();
  return jsonResponse(statusOf(team, row));
}

// Makes the link, or replaces the old one (the old URL stops working at once). The only time the URL is ever in an answer.
export async function createCalendarLink(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const team = await readTeam(ctx, guildContext, ctx.body.teamId);
  const token = newSessionToken(ctx.randomBytes);
  const now = ctx.now();
  await ctx.db.prepare(
    `INSERT INTO calendar_tokens (id, token_hash, guild_id, team_id, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (user_id, team_id) DO UPDATE SET id = excluded.id, token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL`,
  ).bind(newId('ct', ctx.randomBytes), await hashToken(token), guildContext.guild.id, team.id, ctx.session.user.id, now).run();
  const url = new URL(ctx.request.url);
  return jsonResponse({
    ...statusOf(team, { created_at: now, last_used_at: null }),
    url: `${url.origin}/cal/${token}.ics`,
    webcalUrl: `webcal://${url.host}/cal/${token}.ics`,
  }, 201);
}

// Turning it off deletes the row; asking twice is fine.
export async function revokeCalendarLink(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const team = await readTeam(ctx, guildContext, ctx.body.teamId);
  await ctx.db.prepare('DELETE FROM calendar_tokens WHERE user_id = ? AND team_id = ? AND guild_id = ?').bind(ctx.session.user.id, team.id, guildContext.guild.id).run();
  return jsonResponse(statusOf(team, null));
}

// ---------------------------------------------------------------------------
// The feed

const notFound = () => new HttpError(404, 'not_found', 'That calendar link does not exist.');

// GET /cal/<token>.ics. Anything wrong with the link (unknown, revoked, malformed, the person gone or blocked or no longer allowed to see the
// team) is the same plain 404, so the answer tells a guesser nothing.
export async function getCalendarFeed(ctx) {
  const match = FEED_FILE.exec(ctx.params.cal || '');
  if (!match) throw notFound();
  const { db } = ctx;
  const link = await db.prepare('SELECT id, guild_id, team_id, user_id, last_used_at FROM calendar_tokens WHERE token_hash = ?').bind(await hashToken(match[1])).first();
  if (!link) throw notFound();
  let guildContext;
  try {
    guildContext = await loadGuildContext(db, link.user_id, link.guild_id);
  } catch (error) {
    if (error instanceof HttpError) throw notFound();
    throw error;
  }
  const can = guildContext.can;
  if (!allows(can, 'raids.view', link.team_id)) throw notFound();
  const guild = guildContext.guild;
  const now = ctx.now();
  const from = now - FEED_PAST_DAYS * DAY_MS;
  const to = now + FEED_AHEAD_DAYS * DAY_MS;
  const seeCounts = allows(can, 'attendance.view', link.team_id);
  // "Me" is the membership rule's (worker/membership.js): the person linked to the account or carrying its Discord ID.
  const own = await ownPersonStatement(db, guild.id, link.user_id).first();
  const today = guildToday(guild, now);
  const [teamResult, raidResult, countResult, mineResult, noticeResult, realResult] = await db.batch([
    db.prepare('SELECT name FROM teams WHERE id = ? AND guild_id = ?').bind(link.team_id, guild.id),
    db.prepare(
      `SELECT r.id, r.raid_on, r.starts_at, r.time_known, r.zone, r.title, r.event_title, (SELECT MAX(p.ended_at) FROM raid_pulls p WHERE p.raid_id = r.id) AS last_pull_end
         FROM raids r WHERE r.guild_id = ? AND r.team_id = ? AND r.starts_at >= ? AND r.starts_at <= ? ORDER BY r.starts_at, r.id`,
    ).bind(guild.id, link.team_id, from, to),
    db.prepare(
      `SELECT s.raid_id, CASE WHEN s.kind = 'signed' AND s.standby = 1 THEN 'standby' ELSE s.kind END AS kind, COUNT(*) AS n FROM raid_signups s
        WHERE s.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND starts_at >= ?3 AND starts_at <= ?4) AND ${MERGED_ROWS}
        GROUP BY s.raid_id, s.kind, s.standby`,
    ).bind(guild.id, link.team_id, from, to),
    // The viewer's own sign-up on each raid (their Raidsmith one wins over their Raid-Helper one, as in the merged list).
    db.prepare(
      `SELECT s.raid_id, s.source, CASE WHEN s.kind = 'signed' AND s.standby = 1 THEN 'standby' ELSE s.kind END AS kind FROM raid_signups s
        WHERE s.player_id = ?1 AND s.source IN ('raid_helper', 'raidsmith')
          AND s.raid_id IN (SELECT id FROM raids WHERE guild_id = ?2 AND team_id = ?3 AND starts_at >= ?4 AND starts_at <= ?5)`,
    ).bind(own ? own.id : null, guild.id, link.team_id, from, to),
    // Away notices (worker/away.js): a person who is away and has no sign-up on an upcoming raid counts as can't come, and the viewer's own says so.
    teamNoticesStatement(db, guild.id, link.team_id, link.user_id, today, '9999-12-31'),
    realSignupsStatement(db, guild.id, link.team_id, now, today, '9999-12-31'),
  ]);
  const counts = new Map();
  for (const row of countResult.results) {
    if (!counts.has(row.raid_id)) counts.set(row.raid_id, Object.fromEntries(KINDS.map((kind) => [kind, 0])));
    counts.get(row.raid_id)[row.kind] = row.n;
  }
  const mine = new Map();
  for (const row of mineResult.results) if (!mine.has(row.raid_id) || row.source === 'raidsmith') mine.set(row.raid_id, row.kind);
  const notices = readNotices(noticeResult.results);
  const realByRaid = new Map();
  for (const row of realResult.results) {
    if (!realByRaid.has(row.raid_id)) realByRaid.set(row.raid_id, new Set());
    realByRaid.get(row.raid_id).add(row.player_id);
  }
  const ownPeople = new Set(notices.filter((notice) => notice.own).map((notice) => notice.personId));
  const canSignUp = allows(can, 'signups.self', link.team_id);
  const origin = new URL(ctx.request.url).origin;
  const team = teamResult.results[0];

  const events = raidResult.results.map((raid) => {
    const page = `${origin}/#/g/${guild.id}/raids/r/${raid.id}`;
    const lines = [];
    // time_known 0 = only the date is known (starts_at is noon UTC): an all-day event on the raid's own date. NULL is a raid from before the column: timed.
    const allDay = raid.time_known === 0;
    if (allDay) lines.push('Start time not set yet');
    const away = raid.starts_at > now ? raidAwayEffects(notices, raid.raid_on, realByRaid.get(raid.id)).away : [];
    const shown = counts.get(raid.id) || Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    const countText = seeCounts ? countsLine({ ...shown, absence: shown.absence + away.length }) : null;
    if (countText) lines.push(countText);
    if (mine.has(raid.id)) lines.push(`Your sign-up: ${signupKindLabel(mine.get(raid.id))}`);
    else if (away.some((entry) => ownPeople.has(entry.personId))) lines.push('Your sign-up: Away (notice)');
    else if (canSignUp && raid.starts_at > now) lines.push('Your sign-up: not yet');
    lines.push(page);
    return {
      uid: `${raid.id}@raidsmith`,
      ...(allDay
        ? { allDay: true, startDate: raid.raid_on, endDate: addDays(raid.raid_on, 1) }
        : { start: raid.starts_at, end: raidEnd(raid.starts_at, raid.last_pull_end) }),
      summary: raid.title || raid.event_title || raid.zone || 'Raid',
      description: lines.join('\n'),
      url: page,
    };
  });
  const body = buildIcs({ name: `${guild.name} - ${team ? team.name : 'Raids'}`, stamp: now, events });

  if (!(link.last_used_at > now - LAST_USED_INTERVAL_MS)) {
    try {
      await db.prepare('UPDATE calendar_tokens SET last_used_at = ? WHERE id = ?').bind(now, link.id).run();
    } catch {
      // last_used_at is a convenience; never fail a calendar fetch over it.
    }
  }
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'text/calendar; charset=utf-8');
  headers.set('Cache-Control', 'private, max-age=900');
  headers.set('Content-Disposition', 'inline; filename="raidsmith.ics"');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(body, { status: 200, headers });
}
