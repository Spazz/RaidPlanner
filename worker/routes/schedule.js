// The weekly raid schedule of a team: its slots (weekday, start time, zone, optional title), how many weeks "Create upcoming raids"
// fills (1 to 8) and whether an officer opening the Raids page fills them without asking. Filling creates a plain upcoming raid per
// date and skips dates the team already has a raid on, so it can be run again and again. No cron: the browser asks.
// Spec: tasks/guild-phase6-signups-spec.md.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { zonesFor } from '../raid-zones.js';
import { SINGLE_LINE_STRIP } from '../roster-data.js';
import { guildToday } from '../roster-view.js';
import { MAX_SCHEDULE_WEEKS, MAX_SLOTS, START_TIME, planScheduledRaids } from '../schedule-plan.js';
import { bad } from './roster.js';

const MAX_TITLE = 100;
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// The team in this guild (404 for another guild's) and the viewer's raids.edit on it when `edit`.
async function loadTeam(ctx, guildContext, edit) {
  const team = await ctx.db.prepare(
    'SELECT id, name, archived, schedule_weeks, schedule_auto FROM teams WHERE id = ? AND guild_id = ?',
  ).bind(ctx.params.tid, guildContext.guild.id).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist.');
  if (edit && !allows(guildContext.can, 'raids.edit', team.id)) throw forbidden();
  return team;
}

const readSlots = async (db, teamId) => (await db.prepare(
  'SELECT id, weekday, start_time, zone, title FROM team_schedules WHERE team_id = ? ORDER BY weekday',
).bind(teamId).all()).results;

function view(guildContext, team, slotRows) {
  const guild = guildContext.guild;
  return {
    team: { id: team.id, name: team.name, archived: team.archived === 1 },
    slots: slotRows.map((row) => ({ id: row.id, weekday: row.weekday, startTime: row.start_time, zone: row.zone, title: row.title })),
    weeks: team.schedule_weeks,
    auto: team.schedule_auto === 1,
    can: { edit: allows(guildContext.can, 'raids.edit', team.id) },
    timeZone: guild.time_zone,
    zones: zonesFor(guild.game_version),
  };
}

export async function getSchedule(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'raids.view');
  const team = await loadTeam(ctx, guildContext, false);
  return jsonResponse(view(guildContext, team, await readSlots(ctx.db, team.id)));
}

function readWeeks(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SCHEDULE_WEEKS) throw bad(`${field} is 1 to ${MAX_SCHEDULE_WEEKS} weeks.`, field);
  return value;
}

function readSlotBody(body, guild) {
  if (!Array.isArray(body.slots) || body.slots.length > MAX_SLOTS) throw bad(`Send a list of at most ${MAX_SLOTS} slots.`, 'slots');
  const zones = zonesFor(guild.game_version);
  const seen = new Set();
  return body.slots.map((slot, index) => {
    const fail = (message, field) => new HttpError(400, 'bad_request', message, { field: 'slots', index, slotField: field });
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw fail('Each slot must be an object.', null);
    if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) throw fail('Pick a weekday.', 'weekday');
    if (seen.has(slot.weekday)) throw fail('A team has one raid per day: use each weekday once.', 'weekday');
    seen.add(slot.weekday);
    if (typeof slot.startTime !== 'string' || !START_TIME.test(slot.startTime)) throw fail('Enter a start time like 20:00.', 'startTime');
    if (slot.zone !== undefined && slot.zone !== null && slot.zone !== '' && (typeof slot.zone !== 'string' || !zones.includes(slot.zone))) throw fail('Pick a zone from the list.', 'zone');
    let title = null;
    if (slot.title !== undefined && slot.title !== null) {
      if (typeof slot.title !== 'string') throw fail('The title must be text.', 'title');
      title = slot.title.replace(SINGLE_LINE_STRIP, '').trim();
      if (Array.from(title).length > MAX_TITLE) throw fail(`A title is at most ${MAX_TITLE} characters.`, 'title');
    }
    return { weekday: slot.weekday, startTime: slot.startTime, zone: slot.zone || null, title: title || null };
  });
}

// PUT .../schedule: replaces the slots; `weeks` and `auto` are kept when left out.
export async function putSchedule(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const team = await loadTeam(ctx, guildContext, true);
  const slots = readSlotBody(body, guildContext.guild);
  const weeks = body.weeks === undefined ? team.schedule_weeks : readWeeks(body.weeks, 'weeks');
  if (body.auto !== undefined && typeof body.auto !== 'boolean') throw bad('auto must be true or false.', 'auto');
  const auto = body.auto === undefined ? team.schedule_auto === 1 : body.auto;
  if (team.archived === 1) throw new HttpError(409, 'team_archived', 'Restore the team before changing its schedule.');
  const guild = guildContext.guild;
  const now = ctx.now();
  const rows = slots.map((slot) => ({ id: newId('ts', ctx.randomBytes), ...slot }));
  const before = await readSlots(db, team.id);
  await db.batch([
    db.prepare('DELETE FROM team_schedules WHERE team_id = ? AND guild_id = ?').bind(team.id, guild.id),
    db.prepare(
      `INSERT INTO team_schedules (id, guild_id, team_id, weekday, start_time, zone, title, created_at)
       SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.weekday'), json_extract(value, '$.startTime'),
              json_extract(value, '$.zone'), json_extract(value, '$.title'), ? FROM json_each(?)`,
    ).bind(guild.id, team.id, now, JSON.stringify(rows)),
    db.prepare('UPDATE teams SET schedule_weeks = ?, schedule_auto = ? WHERE id = ? AND guild_id = ?').bind(weeks, auto ? 1 : 0, team.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'schedule.update', entityType: 'team', entityId: team.id,
      before: { slots: before.length, weeks: team.schedule_weeks, auto: team.schedule_auto === 1 }, after: { slots: slots.length, weeks, auto },
    }),
  ]);
  const fresh = { ...team, schedule_weeks: weeks, schedule_auto: auto ? 1 : 0 };
  return jsonResponse(view(guildContext, fresh, await readSlots(db, team.id)));
}

// POST .../schedule/raids: creates the raids of the next `weeks` weeks (the team's own number when left out) that the team does not
// have yet. -> { created: [{ raidId, raidOn, startsAt, zone, title }], skipped: [{ raidOn, reason, raidId? }], weeks, today }.
// reason: 'exists' (the team has a raid that date), 'past' (today's slot has started), 'no_such_time' (the clocks skip that wall time).
export async function createScheduledRaids(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const team = await loadTeam(ctx, guildContext, true);
  const guild = guildContext.guild;
  const weeks = body.weeks === undefined ? team.schedule_weeks : readWeeks(body.weeks, 'weeks');
  if (team.archived === 1) throw new HttpError(409, 'team_archived', 'Restore the team before creating its raids.');
  const slotRows = await readSlots(db, team.id);
  if (!slotRows.length) throw new HttpError(409, 'no_schedule', 'This team has no weekly slots yet.');
  const now = ctx.now();
  const today = guildToday(guild, now);
  const planned = planScheduledRaids({
    slots: slotRows.map((row) => ({ weekday: row.weekday, startTime: row.start_time, zone: row.zone, title: row.title })),
    today, weeks, now, timeZone: guild.time_zone,
  });
  const last = planned.length ? planned[planned.length - 1].raidOn : today;
  const existing = new Map((await db.prepare('SELECT id, raid_on FROM raids WHERE team_id = ? AND guild_id = ? AND raid_on BETWEEN ? AND ?')
    .bind(team.id, guild.id, today, last).all()).results.map((row) => [row.raid_on, row.id]));
  const skipped = [];
  const toCreate = [];
  for (const entry of planned) {
    if (existing.has(entry.raidOn)) skipped.push({ raidOn: entry.raidOn, reason: 'exists', raidId: existing.get(entry.raidOn) });
    else if (entry.skip) skipped.push({ raidOn: entry.raidOn, reason: entry.skip });
    else toCreate.push({ id: newId('r', ctx.randomBytes), raidOn: entry.raidOn, startsAt: entry.startsAt, zone: entry.zone, title: entry.title });
  }
  let created = [];
  if (toCreate.length) {
    const ids = toCreate.map((row) => row.id);
    const dates = toCreate.map((row) => row.raidOn);
    await db.batch([
      // Each insert is conditional on the team still having no raid that date (two officers pressing the button at once create it once).
      db.prepare(
        `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, title, log_mode, open_flags, policy_fp, version, created_by, created_at, updated_at)
         SELECT json_extract(j.value, '$.id'), ?, ?, json_extract(j.value, '$.raidOn'), json_extract(j.value, '$.startsAt'), json_extract(j.value, '$.zone'),
                json_extract(j.value, '$.title'), 'log', 0, '', 1, ?, ?, ?
           FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)
            AND NOT EXISTS (SELECT 1 FROM raids x WHERE x.team_id = ? AND x.raid_on = json_extract(j.value, '$.raidOn'))`,
      ).bind(guild.id, team.id, ctx.session.user.id, now, now, JSON.stringify(toCreate), team.id, guild.id, team.id),
      // A new raid on a date changes the fill-in pass of the other teams' raids that date: they show Recalculate.
      db.prepare(
        `UPDATE raids SET policy_fp = '', version = version + 1
          WHERE guild_id = ? AND team_id != ? AND raid_on IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM raids x WHERE x.id IN (SELECT value FROM json_each(?)))`,
      ).bind(guild.id, team.id, JSON.stringify(dates), JSON.stringify(ids)),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'schedule.fill', entityType: 'team', entityId: team.id,
        before: null, after: { weeks, dates },
      }, { sql: 'EXISTS (SELECT 1 FROM raids x WHERE x.id IN (SELECT value FROM json_each(?)))', params: [JSON.stringify(ids)] }),
    ]);
    const made = (await db.prepare('SELECT id FROM raids WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()).results.map((row) => row.id);
    created = toCreate.filter((row) => made.includes(row.id)).map((row) => ({ raidId: row.id, raidOn: row.raidOn, startsAt: row.startsAt, zone: row.zone, title: row.title }));
    // A date another request created first: the team has a raid there now.
    for (const row of toCreate.filter((entry) => !made.includes(entry.id))) skipped.push({ raidOn: row.raidOn, reason: 'exists' });
  }
  skipped.sort((a, b) => (a.raidOn < b.raidOn ? -1 : a.raidOn > b.raidOn ? 1 : 0));
  return jsonResponse({ created, skipped, weeks, today });
}
