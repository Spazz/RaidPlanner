// Publishing the roster: an officer freezes the raid's plan placements as the roster; members see their own seat ("You're in Group 3 as Holy Paladin", "You're on
// the bench") and confirm it or say they cannot make it. A "can't make it" turns their sign-up into an Absence (a Raidsmith row, replacing a Raid-Helper one) and
// shows on Needs attention; confirming after that gives the old sign-up back. Answers are open until the raid starts: the lock and the deadline of ordinary
// sign-ups do not apply. Re-publishing keeps the answers of the seats that did not change. The pure half is worker/roster-publish.js.
import { HttpError, jsonResponse } from '../http.js';
import { effectiveKind } from '../signups-data.js';
import { ownPersonStatement } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { buildSeats, keptSeats, planChanged, rosterCounts } from '../roster-publish.js';
import { loadRaid, raidAudit } from './raids.js';
import { writeSignup } from './signups.js';

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const started = () => new HttpError(409, 'raid_started', 'This raid has started: its roster is frozen.');
const userName = (row) => (row ? row.display_name || row.global_name || row.username : null);

// The roster as the viewer may see it. Officers (raids.edit on the raid's team): everything. Everyone else: only whether it is published and their own seat.
async function rosterReply(ctx, guildContext, raid) {
  const { db } = ctx;
  const edit = allows(guildContext.can, 'raids.edit', raid.team_id);
  const published = raid.roster_published_at !== null && raid.roster_published_at !== undefined;
  const rosterSql = db.prepare('SELECT name, name_key, player_id, group_number, class, spec, status, responded_at FROM raid_roster WHERE raid_id = ? ORDER BY seq, name_key').bind(raid.id);
  if (!edit) {
    const [rosterResult, ownResult] = await db.batch([rosterSql, ownPersonStatement(db, guildContext.guild.id, ctx.session.user.id)]);
    const own = ownResult.results[0] || null;
    const seat = published && own ? rosterResult.results.find((row) => row.player_id === own.id) : null;
    return { published, publishedAt: published ? raid.roster_published_at : null, mine: seat ? { group: seat.group_number, name: seat.name, class: seat.class, spec: seat.spec, status: seat.status } : null };
  }
  const [rosterResult, planResult, userResult] = await db.batch([
    rosterSql,
    db.prepare('SELECT name_key, group_number FROM raid_plan WHERE raid_id = ?').bind(raid.id),
    db.prepare('SELECT display_name, global_name, username FROM users WHERE id = ?').bind(raid.roster_published_by || ''),
  ]);
  return {
    published,
    publishedAt: published ? raid.roster_published_at : null,
    publishedBy: published ? userName(userResult.results[0]) : null,
    entries: rosterResult.results.map((row) => ({
      name: row.name, personId: row.player_id, class: row.class, spec: row.spec, group: row.group_number, status: row.status, respondedAt: row.responded_at,
    })),
    counts: rosterCounts(rosterResult.results),
    planChanged: published && planChanged(rosterResult.results, planResult.results),
  };
}

export async function getPublishedRoster(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'raids.view');
  const raid = await loadRaid(ctx, guildContext);
  return jsonResponse(await rosterReply(ctx, guildContext, raid));
}

// POST .../roster: freezes the raid's plan as the roster. 409 no_plan (nothing planned), 409 raid_started. Publishing again re-reads the plan: a seat with the same
// name and group keeps its answer, a new or moved seat is pending, a name no longer planned goes.
export async function publishRoster(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const now = ctx.now();
  if (raid.starts_at <= now) throw started();
  const [planResult, characterResult, signupResult, rosterResult] = await db.batch([
    db.prepare('SELECT name, name_key, group_number FROM raid_plan WHERE raid_id = ? ORDER BY rowid').bind(raid.id),
    db.prepare(
      `SELECT id, player_id, name_key, class, main_spec, is_main, team_id FROM characters
        WHERE guild_id = ? AND name_key IN (SELECT name_key FROM raid_plan WHERE raid_id = ?)`,
    ).bind(guild.id, raid.id),
    db.prepare("SELECT player_id, source, spec_name FROM raid_signups WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') AND player_id IS NOT NULL").bind(raid.id),
    db.prepare('SELECT name_key, group_number FROM raid_roster WHERE raid_id = ?').bind(raid.id),
  ]);
  if (!planResult.results.length) throw new HttpError(409, 'no_plan', 'This raid has no plan yet. Save the plan from the Planner first.');
  const seats = buildSeats({ plan: planResult.results, characters: characterResult.results, signups: signupResult.results, teamId: raid.team_id });
  const kept = keptSeats(seats, rosterResult.results);

  const guard = { sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ? AND guild_id = ? AND starts_at > ?)', params: [raid.id, guild.id, now] };
  const results = await db.batch([
    db.prepare(
      `DELETE FROM raid_roster WHERE raid_id = ? AND name_key NOT IN (SELECT json_extract(value, '$.nameKey') FROM json_each(?)) AND ${guard.sql}`,
    ).bind(raid.id, JSON.stringify(seats), ...guard.params),
    // An unchanged seat (same name, same group) keeps status, answer time and what to restore; a moved one is pending again, but a declined one remembers that
    // its sign-up is still an Absence (prev_kind is then never NULL), so confirming it later still gives the sign-up back.
    db.prepare(
      `INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, class, spec, status, prev_kind, responded_at, seq)
       SELECT ?, ?, json_extract(value, '$.nameKey'), json_extract(value, '$.name'), json_extract(value, '$.personId'), json_extract(value, '$.group'),
              json_extract(value, '$.className'), json_extract(value, '$.spec'), 'pending', NULL, NULL, json_extract(value, '$.seq')
         FROM json_each(?) WHERE ${guard.sql}
       ON CONFLICT (raid_id, name_key) DO UPDATE SET
         name = excluded.name, player_id = excluded.player_id, class = excluded.class, spec = excluded.spec, seq = excluded.seq,
         prev_kind = CASE WHEN raid_roster.group_number != excluded.group_number AND raid_roster.status = 'declined' THEN COALESCE(raid_roster.prev_kind, 'signed') ELSE raid_roster.prev_kind END,
         status = CASE WHEN raid_roster.group_number = excluded.group_number THEN raid_roster.status ELSE 'pending' END,
         responded_at = CASE WHEN raid_roster.group_number = excluded.group_number THEN raid_roster.responded_at ELSE NULL END,
         group_number = excluded.group_number`,
    ).bind(raid.id, guild.id, JSON.stringify(seats), ...guard.params),
    db.prepare('UPDATE raids SET roster_published_at = ?, roster_published_by = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND starts_at > ?')
      .bind(now, ctx.session.user.id, now, raid.id, guild.id, now),
    raidAudit(ctx, guildContext, 'roster.publish', raid.id, null, { players: seats.length, kept }, { sql: 'changes() = 1', params: [] }),
  ]);
  if (results[2].meta.changes !== 1) throw started();
  return jsonResponse(await rosterReply(ctx, guildContext, { ...raid, roster_published_at: now, roster_published_by: ctx.session.user.id }));
}

// DELETE .../roster: takes the published roster back (the answers go with it; sign-ups that "can't make it" turned into Absences stay as they are).
export async function unpublishRoster(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.roster_published_at !== null) {
    await db.batch([
      db.prepare('DELETE FROM raid_roster WHERE raid_id = ?').bind(raid.id),
      db.prepare('UPDATE raids SET roster_published_at = NULL, roster_published_by = NULL, updated_at = ? WHERE id = ? AND guild_id = ?').bind(ctx.now(), raid.id, guildContext.guild.id),
      raidAudit(ctx, guildContext, 'roster.unpublish', raid.id, { published: true }, { published: false }),
    ]);
  }
  return jsonResponse(await rosterReply(ctx, guildContext, { ...raid, roster_published_at: null, roster_published_by: null }));
}

// ---------------------------------------------------------------------------
// A member answers

// The viewer's seat on a raid whose roster is published, with the person and their effective sign-up on the raid.
async function answerContext(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'signups.self', raid.team_id)) throw forbidden();
  const person = await ownPersonStatement(db, guildContext.guild.id, ctx.session.user.id).first();
  if (!person) throw forbidden();
  if (raid.roster_published_at === null) throw new HttpError(409, 'roster_not_published', 'This raid has no published roster.');
  if (raid.starts_at <= ctx.now()) throw started();
  const [seatResult, signupResult] = await db.batch([
    db.prepare('SELECT name_key, status, prev_kind FROM raid_roster WHERE raid_id = ? AND player_id = ? ORDER BY seq').bind(raid.id, person.id),
    db.prepare("SELECT source, kind, standby FROM raid_signups WHERE raid_id = ? AND player_id = ? AND source IN ('raid_helper', 'raidsmith')").bind(raid.id, person.id),
  ]);
  const seat = seatResult.results[0];
  if (!seat) throw new HttpError(409, 'not_on_roster', 'You are not on this roster.');
  const real = signupResult.results.find((row) => row.source === 'raidsmith') || signupResult.results[0] || null;
  return { guildContext, raid, personId: person.id, seat, current: real ? effectiveKind(real) : null };
}

// POST .../roster/decline: "I can't make it". The seat is declined, the sign-up becomes an Absence (what it was is remembered), the officers see it.
export async function declineSeat(ctx) {
  const { guildContext, raid, personId, seat, current } = await answerContext(ctx);
  const now = ctx.now();
  // What to give back on a later Confirm: the sign-up as it was; a person who is already Absent keeps what was remembered before.
  const remembered = current === 'absence' ? seat.prev_kind : current;
  const results = await ctx.db.batch([
    ctx.db.prepare(`UPDATE raid_roster SET status = 'declined', responded_at = ?, prev_kind = ? WHERE raid_id = ? AND player_id = ? AND EXISTS (SELECT 1 FROM raids WHERE id = ? AND starts_at > ?)`)
      .bind(now, remembered, raid.id, personId, raid.id, now),
    raidAudit(ctx, guildContext, 'roster.decline', raid.id, null, { personId }, { sql: 'changes() > 0', params: [] }),
  ]);
  if (results[0].meta.changes < 1) throw started();
  await writeSignup(ctx, guildContext, raid, personId, { kind: 'absence', hasCharacter: false, characterId: null, hasSpec: false, spec: null, hasNote: false, note: null }, true, { roster: true });
  return jsonResponse(await rosterReply(ctx, guildContext, raid));
}

// POST .../roster/confirm: "I'll be there". A person who had declined (or whose declined seat was moved) and is still Absent gets their old sign-up back.
export async function confirmSeat(ctx) {
  const { guildContext, raid, personId, seat, current } = await answerContext(ctx);
  const now = ctx.now();
  const restore = current === 'absence' && (seat.status === 'declined' || seat.prev_kind !== null);
  if (restore) {
    await writeSignup(ctx, guildContext, raid, personId, { kind: seat.prev_kind || 'signed', hasCharacter: false, characterId: null, hasSpec: false, spec: null, hasNote: false, note: null }, true, { roster: true });
  }
  const results = await ctx.db.batch([
    ctx.db.prepare(`UPDATE raid_roster SET status = 'confirmed', responded_at = ?, prev_kind = NULL WHERE raid_id = ? AND player_id = ? AND EXISTS (SELECT 1 FROM raids WHERE id = ? AND starts_at > ?)`)
      .bind(now, raid.id, personId, raid.id, now),
  ]);
  if (results[0].meta.changes < 1) throw started();
  return jsonResponse(await rosterReply(ctx, guildContext, raid));
}
