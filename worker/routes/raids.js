// Raids: one team's raid on one guild-local date, with its sources (a Raid-Helper event, Warcraft Logs reports, a Raidsmith
// plan, or officer-entered attendance). Every write recomputes the date's attendance through attendance-store.js.
import { HttpError, cleanText, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { raidAwayEffects, readNotices, realSignupsStatement, teamCharactersStatement, teamNoticesStatement } from '../away-store.js';
import { localDate, localTimeToMs } from '../attendance-calendar.js';
import {
  bumpDayStatement, loadAttendanceFlags, makePolicyResolver, policyRowsStatement, recomputeRaid,
} from '../attendance-store.js';
import { displayCharacter, loadRaidDetail, raidState, isStale } from '../attendance-view.js';
import { hasDiscord, requireDiscord } from '../discord-guard.js';
import { isId, newId } from '../ids.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { ownPlayerSql } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { RAID_SIZES, isRaidSize, raidSizeFields, zonesFor } from '../raid-zones.js';
import {
  WCL_GLOBAL_KEY, WCL_GLOBAL_LIMIT, WCL_RAID_LIMIT, WCL_RAID_WINDOW_MS, enforceRateLimit,
} from '../ratelimit.js';
import {
  RAID_HELPER_CLASS, RAID_HELPER_SPEC, allowsSurname, cleanCharacterName, cleanNickname, isRealDate, isSpecOf, nameKey, ownValue, realmKey, SINGLE_LINE_STRIP,
} from '../roster-data.js';
import { guildToday } from '../roster-view.js';
import { reconcileStanding, removeStandingOverRaidHelper } from '../standing.js';
import { MAX_CLOSE_HOURS, closedReason, closesAtOf, isCloseHours, plannerName, raidHelperSpecKey } from '../signups-data.js';
import { SLOT_TIME_SQL, windowFieldsOf } from '../signup-window.js';
import {
  fetchRaidHelperEvent, fetchWclPulls, parseRaidHelperSource, parseWclSource, requireWclConfigured,
} from '../sources.js';
import { bad, errorText } from './roster.js';

const FAR_MS = 18 * 60 * 60 * 1000;
const MAX_PLAN_PLAYERS = 80;
const MAX_MANUAL_PLAYERS = 80;
const PRESENCE_CHUNK = 400;
const PAGE_SIZE = 50;
const WCL_GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const EARLIEST_RAID_DATE = '2004-11-23'; // World of Warcraft's release: nothing was raided before it
const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TITLE = 100;
const SIGNUP_KINDS = ['signed', 'late', 'standby', 'bench', 'tentative', 'absence']; // the effective kinds of the Raids list counts (`signed` leaves standby out)
// The rows of a raid's merged sign-up list, for a query that names the raid_signups row `s`: a person's Raidsmith sign-up replaces their
// Raid-Helper one (worker/signups-data.js mergeSignups does the same in code).
export const MERGED_ROWS = `s.source IN ('raid_helper', 'raidsmith') AND NOT (s.source = 'raid_helper' AND s.player_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM raid_signups n WHERE n.raid_id = s.raid_id AND n.source = 'raidsmith' AND n.player_id = s.player_id))
  AND NOT (s.source = 'raid_helper' AND EXISTS (SELECT 1 FROM raid_signups n
    WHERE n.raid_id = s.raid_id AND n.rh_signup_id = s.signup_id))`;
export { plannerName }; // the Planner's name rule lives with the sign-up helpers (worker/signups-data.js); tests import it from here
const LIVE_ID = /^[0-9A-Za-z]{7}$/; // the id of a live share link (js/livesync.js LiveLinks.ID)

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const notFound = () => new HttpError(404, 'not_found', 'That raid does not exist.');

// ---------------------------------------------------------------------------
// Shared helpers

export function raidAudit(ctx, guildContext, action, raidId, before, after, guard = null) {
  return auditStatement(ctx, {
    guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType: 'raid', entityId: raidId, before, after,
  }, guard);
}

const raidExists = (raidId) => ({ sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ?)', params: [raidId] });

// The raid in this guild (404 for another guild's id) and the viewer's edit right on its team (403).
export async function loadRaid(ctx, guildContext, { edit = false } = {}) {
  const raid = await ctx.db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports,
            (SELECT COUNT(*) FROM raid_plan_doc d WHERE d.raid_id = r.id) AS plan_doc,
            (SELECT t.size FROM teams t WHERE t.id = r.team_id) AS team_size,
            (SELECT t.signup_close_hours FROM teams t WHERE t.id = r.team_id) AS team_close_hours,
            ${SLOT_TIME_SQL} AS slot_time
       FROM raids r WHERE r.id = ? AND r.guild_id = ?`,
  ).bind(ctx.params.rid, guildContext.guild.id).first();
  if (!raid) throw notFound();
  if (edit && !allows(guildContext.can, 'raids.edit', raid.team_id)) throw forbidden();
  // A raid with only a date has its member window start at the team slot time that day, else 18:00 (worker/signup-window.js).
  return Object.assign(raid, windowFieldsOf(raid, guildContext.guild.time_zone));
}

export async function raidReply(ctx, guildContext, raidId, status = 200) {
  return jsonResponse(await loadRaidDetail(ctx, guildContext, raidId), status);
}

// Recalculate the raid's date, then answer with the detail.
export async function recomputeAndReply(ctx, guildContext, raidId, status = 200) {
  await recomputeRaid(ctx, guildContext.guild, raidId);
  return raidReply(ctx, guildContext, raidId, status);
}

function uniqueKind(error) {
  const text = errorText(error);
  if (!/UNIQUE constraint failed/i.test(text)) return null;
  if (/raids\.team_id/.test(text)) return 'raid';
  if (/raids\.event_id|raids_event/.test(text)) return 'event';
  if (/raid_reports\.code|raid_reports_code|raid_reports\.guild_id/.test(text)) return 'report';
  return 'other';
}

// Any UNIQUE failure that is not one of the three named ones: a plain 409, never mislabelled as a report conflict.
const otherConflict = () => new HttpError(409, 'conflict', 'That conflicts with something already saved. Reload and try again.');

async function conflictFor(ctx, guild, kind, { teamId, raidOn, eventId, code }) {
  let row = null;
  if (kind === 'raid') row = await ctx.db.prepare('SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND raid_on = ?').bind(guild.id, teamId, raidOn).first();
  if (kind === 'event') row = await ctx.db.prepare('SELECT id FROM raids WHERE guild_id = ? AND event_id = ?').bind(guild.id, eventId).first();
  if (kind === 'other') return otherConflict();
  if (kind === 'report') row = await ctx.db.prepare('SELECT raid_id AS id FROM raid_reports WHERE guild_id = ? AND code = ?').bind(guild.id, code).first();
  const raidId = row ? row.id : null;
  if (kind === 'raid') return new HttpError(409, 'raid_exists', 'That team already has a raid on that date.', { raidId });
  if (kind === 'event') return new HttpError(409, 'event_exists', 'That Raid-Helper event is already on another raid.', { raidId });
  return new HttpError(409, 'report_exists', 'That report is already on a raid.', { raidId });
}

// WCL and event fetches share one per-user window; WCL also counts against the global window. Both fail closed.
export async function raidFetchRate(ctx, { wcl }) {
  const userId = ctx.session.user.id;
  await enforceRateLimit(ctx.db, userId, ctx.now(), { key: `wclraid:${userId}`, limit: WCL_RAID_LIMIT, windowMs: WCL_RAID_WINDOW_MS, failClosed: true });
  if (wcl) {
    await enforceRateLimit(ctx.db, userId, ctx.now(), { key: WCL_GLOBAL_KEY, limit: WCL_GLOBAL_LIMIT, windowMs: WCL_GLOBAL_WINDOW_MS, failClosed: true });
  }
}

const trimText = (value, max) => (typeof value === 'string'
  ? Array.from(value.replace(SINGLE_LINE_STRIP, '').trim()).slice(0, max).join('') : '');

// ---------------------------------------------------------------------------
// Sources -> statements

const KIND_OF_CLASS_NAME = { Absence: 'absence', Bench: 'bench', Tentative: 'tentative', Late: 'late' };

export function signupKind(className) {
  return Object.prototype.hasOwnProperty.call(KIND_OF_CLASS_NAME, className) ? KIND_OF_CLASS_NAME[className] : 'signed';
}

// Raid-Helper sign-ups -> statements that replace the raid's raid_helper rows. player_id comes from the Discord ID.
function eventSignupStatements(db, guild, raidId, event, guard) {
  const seen = new Set();
  const rows = [];
  for (const signUp of event.signUps) {
    if (seen.has(signUp.id)) continue;
    seen.add(signUp.id);
    rows.push({
      id: signUp.id,
      userId: signUp.userId,
      nickname: cleanNickname(signUp.name),
      kind: signupKind(signUp.className),
      className: trimText(signUp.className, 40) || null,
      specName: trimText(signUp.specName, 40) || null,
      position: signUp.position,
    });
  }
  const statements = [db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raid_helper'").bind(raidId)];
  if (rows.length) {
    statements.push(db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id, player_id)
       SELECT ?, 'raid_helper', json_extract(value, '$.id'), json_extract(value, '$.userId'), json_extract(value, '$.nickname'),
              json_extract(value, '$.kind'), json_extract(value, '$.className'), json_extract(value, '$.specName'), json_extract(value, '$.position'), ?,
              (SELECT p.id FROM players p WHERE p.guild_id = ? AND p.discord_user_id = json_extract(value, '$.userId'))
         FROM json_each(?) WHERE ${guard.sql}`,
    ).bind(raidId, guild.id, guild.id, JSON.stringify(rows), ...guard.params));
  }
  // Guest identity is local; availability and supplied class/spec still follow the imported sign-up.
  // Keep a removed sign-up as absent so existing log/loot identity is not erased.
  statements.push(db.prepare(`UPDATE raid_signups AS g SET
    kind = COALESCE((SELECT s.kind FROM raid_signups s WHERE s.raid_id = g.raid_id AND s.source = 'raid_helper' AND s.signup_id = g.rh_signup_id), 'absence'),
    class_name = COALESCE((SELECT s.class_name FROM raid_signups s WHERE s.raid_id = g.raid_id AND s.source = 'raid_helper' AND s.signup_id = g.rh_signup_id
      AND s.class_name NOT IN ('Absence', 'Bench', 'Tentative', 'Late')), g.class_name),
    spec_name = COALESCE((SELECT s.spec_name FROM raid_signups s WHERE s.raid_id = g.raid_id AND s.source = 'raid_helper' AND s.signup_id = g.rh_signup_id), g.spec_name)
    WHERE g.raid_id = ? AND g.source = 'raidsmith' AND g.guest = 1 AND g.rh_signup_id IS NOT NULL AND ${guard.sql}`)
    .bind(raidId, ...guard.params));
  return { statements, count: rows.length };
}

// A Warcraft Logs pull list -> presence rows keyed by character name + realm. Names that are not WoW names are skipped.
function presenceRows(guild, pulls, surnames) {
  const isRealmGuild = guild.realm_kind !== 'ruleset';
  const rows = [];
  for (const pull of pulls) {
    const seen = new Set();
    for (const player of pull.players) {
      const cleaned = cleanCharacterName(player.name, guild.game_version);
      if (!cleaned) continue;
      // A realm guild reads a missing server as the guild's own realm.
      const realm = isRealmGuild ? (player.server || guild.realm) : null;
      const realmKeyValue = isRealmGuild ? realmKey(realm) : '';
      if (isRealmGuild && !realmKeyValue) continue;
      const name = resolveName(surnames, cleaned, realmKeyValue); // Forever: a log that prints only the first word still meets "First Surname"
      const key = `${nameKey(name)}|${realmKeyValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([pull.fightId, name, nameKey(name), realm, realmKeyValue, player.class]);
    }
  }
  return rows;
}

// The statements that add (or refresh) one report on a raid. Only derived data is written: the report row, its boss pulls and
// who was in each pull. `guard` makes them conditional on the raid being there.
function reportStatements(db, guild, raidId, report, flavour, code, now, guard, surnames = null) {
  const pulls = report.pulls.map((pull) => ({
    fightId: pull.fightId, encounterId: pull.encounterId, name: pull.name, kill: pull.kill ? 1 : 0, startedAt: pull.startedAt, endedAt: pull.endedAt,
  }));
  const presence = presenceRows(guild, report.pulls, surnames);
  const statements = [
    db.prepare('DELETE FROM raid_reports WHERE raid_id = ? AND code = ?').bind(raidId, code),
    db.prepare(
      `INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    ).bind(raidId, guild.id, code, flavour, report.startTime, report.endTime, report.owner, now, ...guard.params),
    db.prepare(
      `INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at)
       SELECT ?, ?, json_extract(value, '$.fightId'), json_extract(value, '$.encounterId'), json_extract(value, '$.name'),
              json_extract(value, '$.kill'), json_extract(value, '$.startedAt'), json_extract(value, '$.endedAt')
         FROM json_each(?)`,
    ).bind(raidId, code, JSON.stringify(pulls)),
  ];
  for (let i = 0; i < presence.length; i += PRESENCE_CHUNK) {
    statements.push(db.prepare(
      `INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class)
       SELECT pl.id, ?, ?, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'),
              json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
         FROM json_each(?) j JOIN raid_pulls pl ON pl.raid_id = ? AND pl.report_code = ? AND pl.fight_id = json_extract(j.value, '$[0]')`,
    ).bind(raidId, guild.id, JSON.stringify(presence.slice(i, i + PRESENCE_CHUNK)), raidId, code));
  }
  return { statements, pulls: pulls.length, presence: presence.length };
}

// Fetches and validates one report: -> { flavour, code, report }.
async function readReport(ctx, guild, source) {
  const { flavour, code } = parseWclSource(source, guild.game_version);
  requireWclConfigured(ctx.env);
  return { flavour, code };
}

async function fetchReport(ctx, flavour, code) {
  await raidFetchRate(ctx, { wcl: true });
  const report = await fetchWclPulls(ctx, flavour, code);
  if (!report.pulls.length) throw new HttpError(400, 'no_pulls', 'That report has no boss pulls yet.', { field: 'source' });
  return report;
}

const noonUtc = (date) => Date.parse(`${date}T12:00:00Z`);

// ---------------------------------------------------------------------------
// Reads

export async function listRaids(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'raids.view');
  const params = new URL(ctx.request.url).searchParams;
  const teamId = params.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const before = params.get('before');
  if (before !== null && !isRealDate(before)) throw bad('before needs a date.', 'before');
  const guild = guildContext.guild;
  const now = ctx.now();
  const today = guildToday(guild, now);
  const [teamResult, raidResult, policyResult, upcomingResult, mineResult, scheduleResult, noticeResult, realResult, seatResult] = await ctx.db.batch([
    ctx.db.prepare('SELECT id, name, archived, size, signup_close_hours FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guild.id),
    ctx.db.prepare(
      `SELECT r.id, r.raid_on, r.starts_at, r.time_known, r.zone, r.size, r.log_mode, r.open_flags, r.policy_fp, r.team_id, r.event_synced, r.plan_synced,
              (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports,
              (SELECT COUNT(*) FROM raid_pulls p WHERE p.raid_id = r.id) AS pulls,
              (SELECT COUNT(*) FROM raid_pulls p WHERE p.raid_id = r.id AND p.kill = 1) AS kills,
              (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome IN ('present', 'late', 'left_early', 'late_left', 'fill_in')) AS present,
              (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome = 'bench') AS bench,
              (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome IN ('missed', 'missed_notice')) AS missed
         FROM raids r WHERE r.guild_id = ? AND r.team_id = ? AND (? IS NULL OR r.raid_on < ?) AND r.starts_at <= ?
        ORDER BY r.raid_on DESC LIMIT ?`,
    ).bind(guild.id, teamId, before, before, now, PAGE_SIZE + 1),
    policyRowsStatement(ctx.db, guild.id),
    // Raids that have not started: all of them, soonest first, outside the paging of the past ones.
    ctx.db.prepare(
      `SELECT r.id, r.raid_on, r.starts_at, r.time_known, r.zone, r.size, r.signup_close_hours, r.title, r.event_title, r.event_id, r.event_server, r.event_synced, r.event_moved_on, r.plan_synced, r.plan_live, r.signups_locked,
              ${SLOT_TIME_SQL} AS slot_time,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'signed' AND s.standby = 0) AS n_signed,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'late') AS n_late,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'signed' AND s.standby = 1) AS n_standby,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'bench') AS n_bench,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'tentative') AS n_tentative,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind = 'absence') AS n_absence
         FROM raids r WHERE r.guild_id = ? AND r.team_id = ? AND r.starts_at > ?
        ORDER BY r.starts_at, r.id`,
    ).bind(guild.id, teamId, now),
    // The viewer's own sign-up on each upcoming raid (their Raidsmith one wins over their Raid-Helper one, as in the merged list).
    ctx.db.prepare(
      `SELECT s.raid_id, s.source, CASE WHEN s.kind = 'signed' AND s.standby = 1 THEN 'standby' ELSE s.kind END AS kind, s.standing, c.name AS character_name
         FROM raid_signups s LEFT JOIN characters c ON c.id = s.character_id
        WHERE s.player_id IN (SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')}) AND s.source IN ('raid_helper', 'raidsmith')
          AND s.raid_id IN (SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at > ?)`,
    ).bind(guild.id, ctx.session.user.id, ctx.session.user.id, guild.id, teamId, now),
    ctx.db.prepare('SELECT schedule_weeks, schedule_auto, (SELECT COUNT(*) FROM team_schedules x WHERE x.team_id = teams.id) AS slots FROM teams WHERE id = ? AND guild_id = ?')
      .bind(teamId, guild.id),
    // Away notices from today on (worker/away.js): a virtual Absence on each upcoming raid they cover, for the people who have no real sign-up there.
    teamNoticesStatement(ctx.db, guild.id, teamId, ctx.session.user.id, today, '9999-12-31'),
    realSignupsStatement(ctx.db, guild.id, teamId, now, today, '9999-12-31'),
    // The viewer's own seat on each published roster of the upcoming raids.
    ctx.db.prepare(
      `SELECT rr.raid_id, rr.group_number, rr.status FROM raid_roster rr
        WHERE rr.player_id IN (SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')})
          AND rr.raid_id IN (SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at > ?) ORDER BY rr.seq`,
    ).bind(guild.id, ctx.session.user.id, ctx.session.user.id, guild.id, teamId, now),
  ]);
  const team = teamResult.results[0];
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  const resolver = makePolicyResolver(guild, policyResult.results);
  const seeCounts = allows(guildContext.can, 'attendance.view', team.id);
  const canEdit = allows(guildContext.can, 'raids.edit', team.id);
  const canSelf = allows(guildContext.can, 'signups.self', team.id);
  const mine = new Map();
  for (const row of mineResult.results) {
    if (!mine.has(row.raid_id) || row.source === 'raidsmith') mine.set(row.raid_id, { kind: row.kind, source: row.source, characterName: row.source === 'raidsmith' ? row.character_name : null, ...(row.source === 'raidsmith' && row.standing === 1 ? { standing: true } : {}) });
  }
  const scheduleRow = scheduleResult.results[0];
  const seats = new Map();
  for (const row of seatResult.results) if (!seats.has(row.raid_id)) seats.set(row.raid_id, { group: row.group_number, status: row.status });
  // `mine` of a raid with a published roster says where the viewer sits (a person who is seated but has no sign-up gets kind null).
  const withSeat = (row, own) => (seats.has(row.id) ? { ...(own || { kind: null, source: null, characterName: null }), roster: seats.get(row.id) } : own);
  const notices = readNotices(noticeResult.results);
  const realByRaid = new Map();
  for (const row of realResult.results) {
    if (!realByRaid.has(row.raid_id)) realByRaid.set(row.raid_id, new Set());
    realByRaid.get(row.raid_id).add(row.player_id);
  }
  const awayOf = (row) => raidAwayEffects(notices, row.raid_on, realByRaid.get(row.id)).away;
  const ownPeople = new Set(notices.filter((notice) => notice.own).map((notice) => notice.personId));
  const page = raidResult.results.slice(0, PAGE_SIZE);
  const rowCloseHours = (row) => row.signup_close_hours ?? team.signup_close_hours; // a raid's own sign-up deadline, else the team's
  // What the sign-up window reads of a row: a raid with only a date starts its window at the team slot time that day, else 18:00 (worker/signup-window.js).
  const windowOf = (row) => ({ starts_at: row.starts_at, signups_locked: row.signups_locked, ...windowFieldsOf(row, guild.time_zone) });
  return jsonResponse({
    team: { id: team.id, name: team.name, archived: team.archived === 1, size: team.size, signupCloseHours: team.signup_close_hours },
    today,
    can: { edit: canEdit, signup: canSelf },
    // The weekly schedule, for those who can create raids from it: how many slots, the weeks it fills and whether opening Raids fills them.
    schedule: canEdit && scheduleRow ? { slots: scheduleRow.slots, weeks: scheduleRow.schedule_weeks, auto: scheduleRow.schedule_auto === 1 } : null,
    hasMore: raidResult.results.length > PAGE_SIZE,
    upcoming: upcomingResult.results.map((row) => ({
      id: row.id,
      raidOn: row.raid_on,
      startsAt: row.starts_at,
      timeKnown: row.time_known !== 0, // 0 = only the date is known (starts_at is noon UTC); NULL = a raid from before the column, read as timed
      upcoming: true,
      zone: row.zone,
      ...raidSizeFields(row, team.size, guild.game_version),
      title: row.title || row.event_title || null,
      eventSourced: row.event_id !== null,
      eventId: row.event_id,
      eventSyncedAt: row.event_id !== null ? row.event_synced : null, // when the sign-ups were last read from Raid-Helper (an officer's refresh or the automatic one)
      eventMovedOn: canEdit ? row.event_moved_on : null, // the date Raid-Helper has the event on when that is not the raid's (the automatic refresh never moves a raid)
      otherServer: hasDiscord(guild) && row.event_server !== null && row.event_server !== guild.discord_server_id,
      signups: seeCounts ? Object.fromEntries(SIGNUP_KINDS.map((kind) => [kind, row[`n_${kind}`] + (kind === 'absence' ? awayOf(row).length : 0)])) : null,
      locked: row.signups_locked === 1,
      signupsOpen: !closedReason(windowOf(row), now, rowCloseHours(row)),
      closesAt: closesAtOf(windowOf(row), rowCloseHours(row)),
      closeHours: rowCloseHours(row),
      mine: withSeat(row, mine.get(row.id) || (awayOf(row).some((entry) => ownPeople.has(entry.personId)) ? { kind: 'absence', source: 'away', characterName: null } : null)),
      planned: row.plan_synced !== null,
      planLive: canEdit ? row.plan_live : null, // the id is an edit link to the plan: only for those who may edit
    })),
    raids: page.map((row) => {
      const state = raidState(row, row.reports, resolver);
      return {
        id: row.id,
        raidOn: row.raid_on,
        startsAt: row.starts_at,
        timeKnown: row.time_known !== 0,
        upcoming: false,
        zone: row.zone,
        ...raidSizeFields(row, team.size, guild.game_version),
        bosses: { kills: row.kills, pulls: row.pulls },
        sources: { event: row.event_synced !== null, reports: row.reports, plan: row.plan_synced !== null },
        counts: seeCounts ? { present: row.present, bench: row.bench, missed: row.missed } : null,
        openFlags: row.open_flags,
        state,
        stale: isStale(state),
      };
    }),
  });
}

export async function getRaid(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'raids.view');
  return raidReply(ctx, guildContext, ctx.params.rid);
}

// ---------------------------------------------------------------------------
// Create

function readOptionalDate(value) {
  if (value === undefined || value === null) return null;
  if (!isRealDate(value)) throw bad('raidOn needs a date.', 'raidOn');
  if (value < EARLIEST_RAID_DATE) throw bad('That date is before World of Warcraft existed.', 'raidOn');
  return value;
}

const present = (value) => value !== undefined && value !== null && value !== '';

// A raid's own size: left out or null = automatic (the zone's size, else the team's), otherwise one of the sizes a raid can have.
function readRaidSize(value) {
  if (value === undefined || value === null) return null;
  if (!isRaidSize(value)) throw bad(`size is ${RAID_SIZES.slice(0, -1).join(', ')} or ${RAID_SIZES[RAID_SIZES.length - 1]}.`, 'size');
  return value;
}

// A raid's own sign-up deadline in hours before the start: null = the team's.
function readRaidCloseHours(value) {
  if (value === null) return null;
  if (!isCloseHours(value)) throw bad(`signupCloseHours is a whole number of hours from 0 to ${MAX_CLOSE_HOURS}, or null for the team default.`, 'signupCloseHours');
  return value;
}

// A hand-made raid's optional start time ('HH:MM', guild-local), title and zone (one of the version's raid names).
function readStartTime(value) {
  if (!present(value)) return null;
  if (typeof value !== 'string' || !START_TIME.test(value)) throw bad('startTime needs a time like 20:00.', 'startTime');
  return value;
}

function readTitle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw bad('title must be text.', 'title');
  return trimText(value, MAX_TITLE) || null;
}

function readZone(value, guild) {
  if (!present(value)) return null;
  if (typeof value !== 'string' || !zonesFor(guild.game_version).includes(value)) throw bad('Pick a zone from the list.', 'zone');
  return value;
}
const MAX_CREATE_REPORTS = 10;

// The report sources of a create: reportSource (one) and/or reportSources (a list), parsed and de-duplicated by code.
function readReportSources(ctx, guild, body) {
  let sources = [];
  if (present(body.reportSource)) sources.push(body.reportSource);
  if (body.reportSources !== undefined && body.reportSources !== null) {
    if (!Array.isArray(body.reportSources)) throw bad('reportSources must be a list.', 'reportSources');
    sources = sources.concat(body.reportSources);
  }
  if (sources.length > MAX_CREATE_REPORTS) throw bad(`Add at most ${MAX_CREATE_REPORTS} reports at once.`, 'reportSources');
  const parsed = [];
  for (const source of sources) {
    const one = parseWclSource(source, guild.game_version);
    if (!parsed.some((entry) => entry.code === one.code)) parsed.push(one);
  }
  if (parsed.length) requireWclConfigured(ctx.env);
  return parsed;
}

// The first of these report codes that already sits on a raid of the guild (for the 409 on a create).
async function firstTakenCode(db, guildId, fetched) {
  for (const entry of fetched) {
    const row = await db.prepare('SELECT 1 AS taken FROM raid_reports WHERE guild_id = ? AND code = ?').bind(guildId, entry.code).first();
    if (row) return entry.code;
  }
  return fetched.length ? fetched[0].code : null;
}

export async function createRaid(ctx) {
  const { body, db } = ctx;
  if (!isId('t', body.teamId)) throw bad('Pick a team.', 'teamId');
  const eventId = present(body.eventSource) ? parseRaidHelperSource(body.eventSource) : null;
  const raidOnInput = readOptionalDate(body.raidOn);
  const startTimeInput = readStartTime(body.startTime);
  const titleInput = readTitle(body.title);
  const sizeInput = readRaidSize(body.size);
  if (body.acceptOtherServer !== undefined && typeof body.acceptOtherServer !== 'boolean') throw bad('acceptOtherServer must be true or false.', 'acceptOtherServer');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const teamId = body.teamId;
  if (!allows(guildContext.can, 'raids.edit', teamId)) throw forbidden();
  const parsedReports = readReportSources(ctx, guild, body);
  const zoneInput = readZone(body.zone, guild);

  let event = null;
  if (eventId) {
    requireDiscord(guild); // a Raid-Helper event lives in a Discord server
    await raidFetchRate(ctx, { wcl: false });
    event = await fetchRaidHelperEvent(ctx, eventId);
    if (event.serverId !== guild.discord_server_id && body.acceptOtherServer !== true) {
      throw new HttpError(409, 'other_server', 'That event was posted in a different Discord server.');
    }
  }
  // Everything is fetched and parsed before the first write: a failed source leaves nothing behind.
  const fetched = [];
  for (const parsed of parsedReports) fetched.push({ ...parsed, report: await fetchReport(ctx, parsed.flavour, parsed.code) });
  fetched.sort((a, b) => a.report.pulls[0].startedAt - b.report.pulls[0].startedAt || (a.code < b.code ? -1 : 1));
  const firstReport = fetched.length ? fetched[0].report : null;

  const anchorMs = event && event.startTime ? event.startTime : (firstReport ? firstReport.pulls[0].startedAt : null);
  const raidOn = anchorMs !== null ? localDate(anchorMs, guild.time_zone) : raidOnInput;
  if (!raidOn) throw bad('Say which date this raid was on.', 'raidOn');
  if (raidOn < EARLIEST_RAID_DATE) throw bad('That date is before World of Warcraft existed.', 'raidOn');
  const timeKnown = anchorMs !== null || startTimeInput !== null ? 1 : 0; // otherwise only the date is known and starts_at is noon UTC
  let startsAt = anchorMs !== null ? anchorMs : noonUtc(raidOn);
  // No event or report to say when: the typed start time (guild-local) on the raid's date.
  if (anchorMs === null && startTimeInput !== null) {
    const typed = localTimeToMs(raidOn, startTimeInput, guild.time_zone);
    if (typed === null) throw bad('That time does not exist on that date (the clocks change).', 'startTime');
    startsAt = typed;
  }
  const raidId = newId('r', ctx.randomBytes);
  const now = ctx.now();
  const guard = raidExists(raidId);
  const statements = [
    db.prepare(
      `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, event_id, event_title, title, event_server, event_synced,
                          log_mode, open_flags, policy_fp, version, created_by, created_at, updated_at, size, time_known)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'log', 0, '', 1, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)`,
    ).bind(raidId, guild.id, teamId, raidOn, startsAt, zoneInput || (firstReport ? firstReport.zone : null), event ? eventId : null, event ? event.title : null, titleInput,
      event ? event.serverId : null, event ? now : null, ctx.session.user.id, now, now, sizeInput, timeKnown, teamId, guild.id),
  ];
  let eventCount = 0;
  if (event) {
    const built = eventSignupStatements(db, guild, raidId, event, guard);
    statements.push(...built.statements);
    eventCount = built.count;
  }
  const surnames = await loadSurnameIndex(db, guild);
  for (const entry of fetched) {
    const built = reportStatements(db, guild, raidId, entry.report, entry.flavour, entry.code, now, guard, surnames);
    statements.push(...built.statements);
  }
  const reportCount = fetched.length;
  // A new raid changes the fill-in pass of the other teams' raids on the same date: they show "Recalculate" (only when the raid went in).
  statements.push(
    bumpDayStatement(db, guild.id, raidOn, raidId, guard),
    raidAudit(ctx, guildContext, 'raid.create', raidId, null, { teamId, raidOn, event: !!event, reports: reportCount, signups: eventCount }, guard),
  );
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const kind = uniqueKind(error);
    if (kind) throw await conflictFor(ctx, guild, kind, { teamId, raidOn, eventId, code: kind === 'report' ? await firstTakenCode(db, guild.id, fetched) : null });
    throw error;
  }
  if (results[0].meta.changes !== 1) throw bad('That team does not exist in this guild.', 'teamId');
  // An upcoming raid starts with the standing sign-ups of its team's weekday (people with a Raid-Helper row from the event keep that).
  if (startsAt > now) await reconcileStanding(ctx, guild, { raidIds: [raidId] });
  if (!event && !reportCount) return raidReply(ctx, guildContext, raidId, 201);
  // The raid and its evidence are saved. A recompute that fails leaves the raid stale ("needs recalculation"), never half-created.
  let recomputeFailed = false;
  try {
    await recomputeRaid(ctx, guild, raidId);
  } catch {
    recomputeFailed = true;
  }
  const reply = await loadRaidDetail(ctx, guildContext, raidId);
  return jsonResponse(recomputeFailed ? { ...reply, recomputeFailed: true } : reply, 201);
}

// ---------------------------------------------------------------------------
// Raid-Helper event

// The writes that put an event on a raid: its details, the sign-ups it carries and the standing sign-ups that give way to them (one db.batch, in this order;
// the audit row, when there is one, goes last). `otherDay` / `eventDate` come from putEvent: an officer asked for the raid to move to the event's date.
// The automatic refresh (worker/event-refresh.js) passes otherDay false: it never moves a raid. A raid WITHOUT a log follows its event's start time while the
// event stays on the raid's date (an upcoming raid, or one that never had an anchor). Clears the "event is on another day" flag and stamps the check.
export function eventLinkStatements(ctx, guild, raid, event, eventId, { otherDay = false, eventDate = null, audit = null } = {}) {
  const { db } = ctx;
  const now = ctx.now();
  const anchorless = raid.event_synced === null && raid.reports === 0;
  // An upcoming raid follows its event's start time while the event stays on the raid's date (a re-import after a reschedule).
  const retime = otherDay || anchorless || (raid.starts_at > now && event.startTime && eventDate === raid.raid_on);
  const guard = raidExists(raid.id);
  const built = eventSignupStatements(db, guild, raid.id, event, guard);
  // The raids of the two dates keep their fill-ins honest: the old date loses this raid, the new date gains it.
  const neighbours = otherDay ? [bumpDayStatement(db, guild.id, raid.raid_on, raid.id, guard), bumpDayStatement(db, guild.id, eventDate, raid.id, guard)] : [];
  const statements = [
    db.prepare(
      `UPDATE raids SET event_id = ?, event_title = ?, event_server = ?, event_synced = ?, event_checked_at = ?, event_moved_on = NULL,
              starts_at = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE starts_at END,
              time_known = CASE WHEN ? = 1 AND ? IS NOT NULL THEN 1 ELSE time_known END,
              raid_on = CASE WHEN ? = 1 THEN ? ELSE raid_on END, updated_at = ?, version = version + 1, policy_fp = ''
        WHERE id = ? AND guild_id = ?`,
    ).bind(eventId, event.title, event.serverId, now, now, retime ? 1 : 0, event.startTime, event.startTime, retime ? 1 : 0, event.startTime, otherDay ? 1 : 0, eventDate, now, raid.id, guild.id),
    ...neighbours,
    ...built.statements,
    removeStandingOverRaidHelper(db, raid.id, guard), // a real Raid-Helper sign-up wins over a standing one
  ];
  if (audit) statements.push(audit(built.count, guard));
  return { statements, count: built.count };
}

// Link, replace or refresh the raid's Raid-Helper event. A raid without a log follows its event: on the same guild-local day the start time
// follows (an upcoming raid, or one that never had an anchor); on ANOTHER day the raid is asked to move, and only moveRaid: true moves
// BOTH starts_at and raid_on (409 event_other_day carries the two dates for the page to ask with). The team's one-raid-per-day rule (the
// raids_team_day index) stands: a date the team already has a raid on is 409 raid_date_taken. A raid WITH a log keeps its date and time.
export async function putEvent(ctx) {
  const { body, db } = ctx;
  const eventId = parseRaidHelperSource(body.source);
  if (body.acceptOtherServer !== undefined && typeof body.acceptOtherServer !== 'boolean') throw bad('acceptOtherServer must be true or false.', 'acceptOtherServer');
  if (body.moveRaid !== undefined && typeof body.moveRaid !== 'boolean') throw bad('moveRaid must be true or false.', 'moveRaid');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  requireDiscord(guild); // a Raid-Helper event lives in a Discord server
  await raidFetchRate(ctx, { wcl: false });
  const event = await fetchRaidHelperEvent(ctx, eventId);
  if (event.serverId !== guild.discord_server_id && body.acceptOtherServer !== true) {
    throw new HttpError(409, 'other_server', 'That event was posted in a different Discord server.');
  }
  const eventDate = event.startTime ? localDate(event.startTime, guild.time_zone) : null;
  const otherDay = raid.reports === 0 && eventDate !== null && eventDate !== raid.raid_on;
  if (otherDay && body.moveRaid !== true) {
    throw new HttpError(
      409, 'event_other_day',
      `That event is on ${eventDate} and the raid is on ${raid.raid_on}. Send moveRaid to move the raid to the event's date.`,
      { eventStartsAt: event.startTime, eventDate, raidDate: raid.raid_on },
    );
  }
  if (otherDay) {
    const taken = await db.prepare('SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND raid_on = ? AND id != ?').bind(guild.id, raid.team_id, eventDate, raid.id).first();
    if (taken) throw new HttpError(409, 'raid_date_taken', `That team already has a raid on ${eventDate}, so this raid cannot move there.`, { raidId: taken.id, eventDate });
  }
  const built = eventLinkStatements(ctx, guild, raid, event, eventId, {
    otherDay,
    eventDate,
    audit: (count, guard) => raidAudit(
      ctx, guildContext, 'raid.event', raid.id,
      otherDay ? { event: raid.event_id !== null, raidOn: raid.raid_on } : { event: raid.event_id !== null },
      otherDay ? { eventId, signups: count, raidOn: eventDate } : { eventId, signups: count },
      guard,
    ),
  });
  try {
    await db.batch(built.statements);
  } catch (error) {
    const kind = uniqueKind(error);
    if (kind === 'event') throw await conflictFor(ctx, guild, 'event', { eventId });
    if (kind === 'raid') {
      const row = await db.prepare('SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND raid_on = ?').bind(guild.id, raid.team_id, eventDate).first();
      throw new HttpError(409, 'raid_date_taken', `That team already has a raid on ${eventDate}, so this raid cannot move there.`, { raidId: row ? row.id : null, eventDate });
    }
    if (kind) throw otherConflict();
    throw error;
  }
  // The raid may have moved to another weekday, and people the event dropped have no Raid-Helper row any more: the standing sign-ups follow.
  await reconcileStanding(ctx, guild, { raidIds: [raid.id] });
  // The old date's other raids lose this one as a neighbour: recalculate their day too (the new date is recalculated by the reply below).
  if (otherDay) {
    const sibling = await db.prepare('SELECT id FROM raids WHERE guild_id = ? AND raid_on = ? ORDER BY id LIMIT 1').bind(guild.id, raid.raid_on).first();
    if (sibling) await recomputeRaid(ctx, guild, sibling.id);
  }
  return recomputeAndReply(ctx, guildContext, raid.id);
}

export async function deleteEvent(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.event_id !== null) {
    const now = ctx.now();
    await db.batch([
      db.prepare(
        `UPDATE raids SET event_id = NULL, event_title = NULL, event_server = NULL, event_synced = NULL, event_checked_at = NULL, event_moved_on = NULL, updated_at = ?, version = version + 1, policy_fp = ''
          WHERE id = ? AND guild_id = ?`,
      ).bind(now, raid.id, guildContext.guild.id),
      db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raid_helper'").bind(raid.id),
      raidAudit(ctx, guildContext, 'raid.event', raid.id, { event: true }, { event: false }),
    ]);
    await reconcileStanding(ctx, guildContext.guild, { raidIds: [raid.id] }); // with the Raid-Helper rows gone the standing sign-ups apply again
  }
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Warcraft Logs reports

export async function putReport(ctx) {
  const { body, db } = ctx;
  if (body.confirmFar !== undefined && typeof body.confirmFar !== 'boolean') throw bad('confirmFar must be true or false.', 'confirmFar');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const { flavour, code } = await readReport(ctx, guild, body.source);
  if (raid.log_mode === 'manual') throw new HttpError(409, 'raid_is_manual', 'Remove the manual attendance before adding a report.');
  const existing = await db.prepare('SELECT raid_id FROM raid_reports WHERE guild_id = ? AND code = ?').bind(guild.id, code).first();
  if (existing && existing.raid_id !== raid.id) {
    throw new HttpError(409, 'report_exists', 'That report is already on another raid.', { raidId: existing.raid_id });
  }
  const refreshing = !!existing;
  const report = await fetchReport(ctx, flavour, code);

  const first = report.pulls[0].startedAt;
  const others = raid.reports - (refreshing ? 1 : 0);
  const anchored = raid.event_synced !== null || others > 0;
  if (body.confirmFar !== true) {
    const apart = anchored ? Math.abs(first - raid.starts_at) > FAR_MS : localDate(first, guild.time_zone) !== raid.raid_on;
    if (apart) {
      throw new HttpError(409, 'report_not_same_night', 'That report does not look like it is from the same night as this raid.', {
        field: 'source', hoursApart: anchored ? Math.round(Math.abs(first - raid.starts_at) / 3600000) : null,
      });
    }
  }
  const now = ctx.now();
  const guard = { sql: "EXISTS (SELECT 1 FROM raids WHERE id = ? AND log_mode = 'log')", params: [raid.id] };
  const built = reportStatements(db, guild, raid.id, report, flavour, code, now, guard, await loadSurnameIndex(db, guild));
  try {
    await db.batch([
      ...built.statements,
      db.prepare(
        `UPDATE raids SET zone = COALESCE(zone, ?), starts_at = CASE WHEN ? = 1 THEN ? ELSE starts_at END, time_known = CASE WHEN ? = 1 THEN 1 ELSE time_known END,
                updated_at = ?, version = version + 1, policy_fp = ''
          WHERE id = ? AND guild_id = ? AND log_mode = 'log'`,
      ).bind(report.zone, anchored ? 0 : 1, first, anchored ? 0 : 1, now, raid.id, guild.id),
      raidAudit(ctx, guildContext, 'raid.report', raid.id, { refreshed: refreshing }, { code, flavour, pulls: built.pulls }, guard),
    ]);
  } catch (error) {
    const kind = uniqueKind(error);
    if (kind === 'report') throw await conflictFor(ctx, guild, 'report', { code });
    if (kind) throw otherConflict();
    // The raid went manual (or was deleted) between the read and the write: the guarded report row was skipped.
    if (/FOREIGN KEY constraint failed/i.test(errorText(error))) {
      throw new HttpError(409, 'raid_is_manual', 'This raid changed while the report was loading. Reload and try again.');
    }
    throw error;
  }
  return recomputeAndReply(ctx, guildContext, raid.id);
}

export async function deleteReport(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const results = await db.batch([
    db.prepare('DELETE FROM raid_reports WHERE raid_id = ? AND code = ? RETURNING code').bind(raid.id, ctx.params.code),
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1, updated_at = ? WHERE id = ? AND guild_id = ? AND changes() = 1")
      .bind(ctx.now(), raid.id, guildContext.guild.id),
    raidAudit(ctx, guildContext, 'raid.report', raid.id, { code: ctx.params.code }, { removed: true }, CHANGED_ONE),
  ]);
  if (results[0].results.length !== 1) throw new HttpError(404, 'not_found', 'That report is not on this raid.');
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Plan

function readPlan(body, guild, surnames) {
  const label = cleanText(body.label, 'label', { min: 1, max: 80 });
  const players = body.players;
  if (!Array.isArray(players) || !players.length || players.length > MAX_PLAN_PLAYERS) {
    throw new HttpError(400, 'plan_invalid', `Send 1 to ${MAX_PLAN_PLAYERS} players.`, { field: 'players' });
  }
  const seen = new Set();
  const rows = players.map((entry, index) => {
    const fail = (message) => new HttpError(400, 'plan_invalid', message, { field: 'players', index });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('Each player must be an object.');
    const cleaned = cleanCharacterName(entry.name, guild.game_version);
    if (!cleaned) throw fail(allowsSurname(guild.game_version) ? 'A character name is 2 to 12 letters, or a first name and a surname.' : 'A character name is 2 to 12 letters.');
    const name = resolveName(surnames, cleaned, guild.realm_kind !== 'ruleset' ? realmKey(guild.realm) : ''); // Forever: "Thrall" in a plan is the roster's "Thrall Stormrage" when only one has that first name
    if (!Number.isInteger(entry.group) || entry.group < 0 || entry.group > 8) throw fail('A group is 0 (bench) to 8.');
    if (seen.has(nameKey(name))) throw fail(`${name} is in the plan twice.`);
    seen.add(nameKey(name));
    return { name, nameKey: nameKey(name), group: entry.group };
  });
  // The live share link the plan came from. Left out, the raid keeps no live link (a pasted long link or code has none).
  const live = body.live === undefined || body.live === null ? null : body.live;
  if (live !== null && (typeof live !== 'string' || !LIVE_ID.test(live))) throw bad('live must be a live link id.', 'live');
  return { label, rows, live };
}

export async function putPlan(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { label, rows, live } = readPlan(ctx.body, guildContext.guild, await loadSurnameIndex(db, guildContext.guild));
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const now = ctx.now();
  const guard = raidExists(raid.id);
  await db.batch([
    db.prepare('DELETE FROM raid_plan WHERE raid_id = ?').bind(raid.id),
    // A pasted plan replaces the raid's whole Planner plan too (the raid page warned first when sources.plan.full).
    db.prepare('DELETE FROM raid_plan_doc WHERE raid_id = ? AND guild_id = ?').bind(raid.id, guildContext.guild.id),
    db.prepare(
      `INSERT INTO raid_plan (raid_id, name, name_key, group_number)
       SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.nameKey'), json_extract(value, '$.group') FROM json_each(?) WHERE ${guard.sql}`,
    ).bind(raid.id, JSON.stringify(rows), ...guard.params),
    db.prepare('UPDATE raids SET plan_label = ?, plan_live = ?, plan_synced = ?, updated_at = ?, version = version + 1, policy_fp = \'\' WHERE id = ? AND guild_id = ?')
      .bind(label, live, now, now, raid.id, guildContext.guild.id),
    raidAudit(ctx, guildContext, 'raid.plan', raid.id, { plan: raid.plan_synced !== null, ...(raid.plan_doc > 0 ? { full: true } : {}) }, { players: rows.length, live: live !== null, source: 'legacy' }),
  ]);
  return recomputeAndReply(ctx, guildContext, raid.id);
}

export async function deletePlan(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.plan_synced !== null || raid.plan_doc > 0) {
    const now = ctx.now();
    await db.batch([
      db.prepare('DELETE FROM raid_plan WHERE raid_id = ?').bind(raid.id),
      db.prepare('DELETE FROM raid_plan_doc WHERE raid_id = ? AND guild_id = ?').bind(raid.id, guildContext.guild.id),
      db.prepare('UPDATE raids SET plan_label = NULL, plan_live = NULL, plan_synced = NULL, updated_at = ?, version = version + 1, policy_fp = \'\' WHERE id = ? AND guild_id = ?')
        .bind(now, raid.id, guildContext.guild.id),
      raidAudit(ctx, guildContext, 'raid.plan', raid.id, { plan: true, ...(raid.plan_doc > 0 ? { full: true } : {}) }, { plan: false }),
    ]);
  }
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Planner seed

// GET /raids/:rid/planner: what the Planner needs to plan this raid - the raid, its live plan link and the sign-ups with the name each
// one gets in the Planner. For those who may edit the raid. The sign-ups are the merged list: a person's Raidsmith sign-up replaces
// their Raid-Helper one. A Raidsmith row is worded as Raid-Helper words it (the meta class for Late/Bench/Tentative/Absence, the
// class otherwise, and the spec key), so the Planner's existing Raid-Helper code reads it unchanged; its name is the character chosen.
// A row of a person that carries no spec of its own (a Raid-Helper Absence, an Away notice's virtual row, a class-only sign-up) takes the main spec of the
// character it shows, written as the Raid-Helper spec key; the sign-up's own spec always wins, and the meta class (the status) is never changed.
const META_CLASS = { late: 'Late', bench: 'Bench', tentative: 'Tentative', absence: 'Absence' };

// The guild's note on a sign-up in the seed (js/state.js SignupMarker): { kind, text } with printable ASCII only, at most 60 characters.
// 'away' (an Away notice: a virtual Absence row), 'also' (signed up for another raid of the guild starting within four hours), 'late' / 'leaving'
// (the person's Late / Leaving notice), 'standby' (a volunteer standby). A row carries the strongest of its markers, in that order.
const MARKER_MAX = 60;
const ALSO_WINDOW_MS = 4 * 60 * 60 * 1000;
// Fair bench: the seed says, per person, how many of the team last FAIR_RAIDS raids before this one they sat on the bench (an attendance Bench outcome, or
// group 0 in the raid saved plan), so Optimize can bench the people who have sat out least (js/optimizer.js refineFairness). The raids counted are the team own,
// already started, and earlier than this one.
const FAIR_RAIDS = 4;
const RECENT_RAIDS_SQL = `SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND id != ? AND starts_at < ? AND starts_at <= ? ORDER BY starts_at DESC, id DESC LIMIT ${FAIR_RAIDS}`;
// The spec key a row falls back to: the main spec of the character it shows, as a Raid-Helper spec key; the row's own spec key when it has one that reads.
// A row whose class is a playable class only takes a character of that class. -> the key; the row own specName (maybe null) when nothing applies.
function profileSpecKey(row, character) {
  if (ownValue(RAID_HELPER_SPEC, row.specName)) return row.specName;
  if (!character || !character.main_spec || !isSpecOf(character.class, character.main_spec)) return row.specName;
  const rowClass = ownValue(RAID_HELPER_CLASS, row.className);
  if (rowClass && rowClass !== character.class) return row.specName;
  return raidHelperSpecKey(character.class, character.main_spec) || row.specName;
}
const marker = (kind, text) => ({ kind, text: text.replace(/[^\x20-\x7e]/g, '').trim().slice(0, MARKER_MAX) });

export async function getPlanner(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const guild = guildContext.guild;
  // The notices only matter for a raid that has not started; "also in another raid" also needs a known start time on this raid (and, in the query, the other).
  const upcoming = raid.starts_at > ctx.now();
  const statements = [
    ctx.db.prepare(
      `SELECT s.source, s.signup_id, s.nickname, s.kind, s.standby, s.guest, s.class_name, s.spec_name, s.position, s.player_id, s.character_id FROM raid_signups s
        WHERE s.raid_id = ? AND ${MERGED_ROWS} ORDER BY s.position, s.source, s.signup_id`,
    ).bind(raid.id),
    ctx.db.prepare(
      `SELECT id, player_id, name, class, main_spec, is_main, team_id FROM characters
        WHERE guild_id = ? AND player_id IN (SELECT player_id FROM raid_signups WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') AND player_id IS NOT NULL)`,
    ).bind(guild.id, raid.id),
  ];
  const noticesAt = statements.length;
  if (upcoming) {
    statements.push(
      teamNoticesStatement(ctx.db, guild.id, raid.team_id, ctx.session.user.id, raid.raid_on, raid.raid_on),
      teamCharactersStatement(ctx.db, guild.id, raid.team_id, raid.raid_on, raid.raid_on),
    );
  }
  const alsoAt = statements.length;
  if (upcoming && raid.time_known !== 0) {
    // The people of this raid who are also signed up (signed, late or standby) for another raid of the guild that starts within four hours of it.
    statements.push(ctx.db.prepare(
      `SELECT s.player_id, r.starts_at, t.name AS team_name FROM raid_signups s JOIN raids r ON r.id = s.raid_id JOIN teams t ON t.id = r.team_id
        WHERE r.guild_id = ?1 AND r.id != ?2 AND r.time_known IS NOT 0 AND r.starts_at >= ?3 - ?4 AND r.starts_at <= ?3 + ?4
          AND ${MERGED_ROWS} AND s.kind IN ('signed', 'late') AND s.player_id IN (SELECT player_id FROM raid_signups WHERE raid_id = ?2 AND player_id IS NOT NULL)`,
    ).bind(guild.id, raid.id, raid.starts_at, ALSO_WINDOW_MS));
  }
  const fairAt = statements.length;
  const recentBinds = [guild.id, raid.team_id, raid.id, raid.starts_at, ctx.now()];
  statements.push(
    ctx.db.prepare(RECENT_RAIDS_SQL).bind(...recentBinds),
    ctx.db.prepare(`SELECT a.player_id, a.raid_id FROM attendance a WHERE a.raid_id IN (${RECENT_RAIDS_SQL}) AND a.outcome = 'bench'`).bind(...recentBinds),
    ctx.db.prepare(
      `SELECT c.player_id, p.raid_id FROM raid_plan p JOIN characters c ON c.guild_id = ? AND c.name_key = p.name_key
        WHERE p.raid_id IN (${RECENT_RAIDS_SQL}) AND p.group_number = 0 AND c.player_id IS NOT NULL`,
    ).bind(guild.id, ...recentBinds),
  );
  const results = await ctx.db.batch(statements);
  const [signupResult, characterResult] = results;
  const recentRaids = results[fairAt].results.length;
  // personId -> the recent raids they sat out (either source counts once per raid)
  const benchedIn = new Map();
  for (const row of [...results[fairAt + 1].results, ...results[fairAt + 2].results]) {
    if (!benchedIn.has(row.player_id)) benchedIn.set(row.player_id, new Set());
    benchedIn.get(row.player_id).add(row.raid_id);
  }
  const charactersByPlayer = new Map();
  for (const row of characterResult.results) {
    if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
    charactersByPlayer.get(row.player_id).push(row);
  }
  let effects = { away: [], notes: new Map() };
  const also = new Map(); // personId -> the team of the nearest other raid (the earlier team name when two are as near)
  if (upcoming) {
    const known = new Set(characterResult.results.map((row) => row.id));
    for (const row of results[noticesAt + 1].results) {
      if (known.has(row.id)) continue;
      if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
      charactersByPlayer.get(row.player_id).push(row);
    }
    effects = raidAwayEffects(readNotices(results[noticesAt].results), raid.raid_on, new Set(signupResult.results.map((row) => row.player_id).filter(Boolean)));
    const nearest = new Map();
    for (const row of results[alsoAt] ? results[alsoAt].results : []) {
      const gap = Math.abs(row.starts_at - raid.starts_at);
      const have = nearest.get(row.player_id);
      if (!have || gap < have.gap || (gap === have.gap && row.team_name < have.team)) nearest.set(row.player_id, { gap, team: row.team_name });
    }
    for (const [personId, { team }] of nearest) also.set(personId, team);
  }

  // The marker of a real row: the strongest that applies (an 'away' marker belongs to the virtual row below).
  const markerOf = (personId, kind) => {
    if (personId && also.has(personId) && (kind === 'signed' || kind === 'late' || kind === 'standby')) {
      const team = marker('also', also.get(personId)).text; // the team name as the Planner can print it
      return marker('also', team ? `Also in: ${team} raid` : 'Also in: another team raid');
    }
    const note = personId ? effects.notes.get(personId) : null;
    if (note) return marker(note.kind, `${note.kind === 'late' ? 'Late' : 'Leaves'}: ${note.atTime}`);
    return kind === 'standby' ? marker('standby', 'Standby') : null;
  };
  const withMarker = (row) => {
    const found = markerOf(row.personId, row.kind);
    return found ? { ...row, marker: found } : row;
  };

  const signups = signupResult.results.map((row) => {
    const characters = row.player_id ? charactersByPlayer.get(row.player_id) : null;
    if (row.source === 'raidsmith') {
      const chosen = (characters || []).find((character) => character.id === row.character_id);
      const shown = chosen || displayCharacter(characters || [], raid.team_id);
      const guest = row.guest === 1; // a guest from a sign-up link: the name the guest typed, no person
      // A volunteer standby is worded as signed (its class and spec) and says 'standby' in kind.
      const kind = row.kind === 'signed' && row.standby === 1 ? 'standby' : row.kind;
      return withMarker({
        key: `rs${row.signup_id}`,
        name: guest ? row.nickname : (shown ? shown.name : 'Unknown'),
        discordName: null,
        personId: row.player_id,
        ...(guest ? { guest: true } : {}),
        className: kind === 'signed' || kind === 'standby' ? row.class_name : META_CLASS[kind],
        specName: guest ? row.spec_name : profileSpecKey({ className: row.class_name, specName: row.spec_name }, shown),
        kind,
        position: row.position,
      });
    }
    const name = plannerName(row, characters);
    return withMarker({
      key: row.signup_id,
      name,
      discordName: row.nickname,
      personId: row.player_id,
      className: row.class_name,
      specName: row.player_id ? profileSpecKey({ className: row.class_name, specName: row.spec_name }, (characters || []).find((character) => character.name === name)) : row.spec_name,
      kind: row.kind,
      position: row.position,
    });
  });
  // The sit-out history of each real row's person, when the team has had a raid before this one (a first raid sends none, so the Planner stays as it was).
  if (recentRaids > 0) {
    for (const row of signups) if (row.personId) row.benchedRecently = benchedIn.has(row.personId) ? benchedIn.get(row.personId).size : 0;
  }
  // The people an Away notice covers who have no sign-up: one virtual Absence row each, after every real row.
  effects.away.forEach(({ personId }, index) => {
    const shown = displayCharacter(charactersByPlayer.get(personId) || [], raid.team_id);
    signups.push({
      key: `aw${personId}`,
      name: shown ? shown.name : 'Unknown',
      discordName: null,
      personId,
      source: 'away',
      className: 'Absence',
      specName: profileSpecKey({ className: 'Absence', specName: null }, shown),
      kind: 'absence',
      position: 1000 + index,
      marker: marker('away', 'Away: notice'),
    });
  });

  return jsonResponse({
    raid: {
      id: raid.id,
      raidOn: raid.raid_on,
      startsAt: raid.starts_at,
      title: raid.title || raid.event_title || null,
      zone: raid.zone,
      eventId: raid.event_id,
      teamId: raid.team_id,
      timeKnown: raid.time_known !== 0, // false: only the date is known and startsAt is noon UTC
      ...raidSizeFields(raid, raid.team_size, guild.game_version),
      gameVersion: guild.game_version,
      timeZone: guild.time_zone,
      ...(recentRaids > 0 ? { recentRaids } : {}), // how many raids benchedRecently counts out of (at most four)
    },
    livePlan: raid.plan_live,
    signups,
  });
}

// ---------------------------------------------------------------------------
// Manual attendance ("No log")

export async function putManual(ctx) {
  const { body, db } = ctx;
  const reason = cleanText(body.reason, 'reason', { min: 3, max: 200 });
  const ids = body.presentPlayerIds;
  if (!Array.isArray(ids) || ids.length > MAX_MANUAL_PLAYERS || ids.some((id) => !isId('p', id)) || new Set(ids).size !== ids.length) {
    throw bad(`Send at most ${MAX_MANUAL_PLAYERS} different people.`, 'presentPlayerIds');
  }
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'Enter attendance by hand once the raid has happened.');
  if (raid.reports > 0) throw new HttpError(409, 'raid_has_log', 'This raid has a report. Remove it before entering attendance by hand.');
  if (ids.length) {
    const found = await db.prepare('SELECT COUNT(*) AS n FROM players WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?))').bind(guild.id, JSON.stringify(ids)).first('n');
    if (found !== ids.length) throw bad('Someone in that list is not on this guild\'s roster.', 'presentPlayerIds');
  }
  await saveManual(ctx, guildContext, raid, { ids, reason });
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// Puts the raid in hand-entered attendance with these people present (the whole list is replaced). names (wave 8, a pasted roster): the names that matched
// nobody, [{ name, realm, realmKey }], replace the raid's earlier ones; left out (null), the raid keeps the names it has. 409 raid_has_log when a report
// arrived in between. The caller has checked the raid has started and has no report, and recomputes after.
export async function saveManual(ctx, guildContext, raid, { ids, reason, names = null }) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const now = ctx.now();
  const guard = { sql: "EXISTS (SELECT 1 FROM raids WHERE id = ? AND log_mode = 'manual')", params: [raid.id] };
  const statements = [
    db.prepare(
      `UPDATE raids SET log_mode = 'manual', manual_reason = ?, manual_by = ?, manual_at = ?, updated_at = ?, version = version + 1, policy_fp = ''
        WHERE id = ? AND guild_id = ? AND NOT EXISTS (SELECT 1 FROM raid_reports WHERE raid_id = raids.id)`,
    ).bind(reason, ctx.session.user.id, now, now, raid.id, guild.id),
    db.prepare('DELETE FROM raid_manual WHERE raid_id = ?').bind(raid.id),
    db.prepare(
      `INSERT INTO raid_manual (raid_id, guild_id, player_id)
       SELECT ?, ?, value FROM json_each(?) WHERE ${guard.sql}`,
    ).bind(raid.id, guild.id, JSON.stringify(ids), ...guard.params),
  ];
  if (names) {
    statements.push(
      db.prepare('DELETE FROM raid_manual_names WHERE raid_id = ?').bind(raid.id),
      db.prepare(
        `INSERT OR IGNORE INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key)
         SELECT ?, ?, json_extract(value, '$.name'), json_extract(value, '$.nameKey'), json_extract(value, '$.realm'), json_extract(value, '$.realmKey')
           FROM json_each(?) WHERE ${guard.sql}`,
      ).bind(raid.id, guild.id, JSON.stringify(names.map((entry) => ({ ...entry, nameKey: nameKey(entry.name) }))), ...guard.params),
    );
  }
  statements.push(raidAudit(
    ctx, guildContext, 'raid.manual', raid.id, { manual: raid.log_mode === 'manual' },
    { manual: true, present: ids.length, reason, ...(names ? { paste: true, unmatched: names.length } : {}) },
    { sql: "EXISTS (SELECT 1 FROM raids WHERE id = ? AND log_mode = 'manual' AND manual_at = ?)", params: [raid.id, now] },
  ));
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'raid_has_log', 'This raid has a report. Remove it before entering attendance by hand.');
}

export async function deleteManual(ctx) {
  const { body, db } = ctx;
  const reason = cleanText(body.reason, 'reason', { min: 3, max: 200 });
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.log_mode !== 'manual') throw new HttpError(409, 'conflict', 'This raid has no manual attendance.');
  await db.batch([
    db.prepare(
      `UPDATE raids SET log_mode = 'log', manual_reason = NULL, manual_by = NULL, manual_at = NULL, updated_at = ?, version = version + 1, policy_fp = ''
        WHERE id = ? AND guild_id = ?`,
    ).bind(ctx.now(), raid.id, guildContext.guild.id),
    db.prepare('DELETE FROM raid_manual WHERE raid_id = ?').bind(raid.id),
    db.prepare('DELETE FROM raid_manual_names WHERE raid_id = ?').bind(raid.id),
    raidAudit(ctx, guildContext, 'raid.manual', raid.id, { manual: true }, { manual: false, reason }),
  ]);
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Settings

// PATCH /raids/:rid { size?, signupCloseHours? }: the raid's own size and sign-up deadline (hours before the start). null clears the override, so the zone's
// size / the team's deadline apply again; a key left out is kept. Neither changes a result, so nothing is recalculated. -> the raid detail.
export async function patchRaid(ctx) {
  const { body, db } = ctx;
  const hasSize = body.size !== undefined;
  const hasHours = body.signupCloseHours !== undefined;
  if (!hasSize && !hasHours) throw new HttpError(400, 'bad_request', 'Send size, signupCloseHours, or both.');
  const size = hasSize ? readRaidSize(body.size) : null;
  const hours = hasHours ? readRaidCloseHours(body.signupCloseHours) : null;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const nextSize = hasSize ? size : raid.size;
  const nextHours = hasHours ? hours : raid.signup_close_hours;
  if (nextSize !== raid.size || nextHours !== raid.signup_close_hours) {
    await db.batch([
      // CASE keeps the key that was not sent at whatever it is now, so two officers changing different keys do not undo each other.
      db.prepare(
        `UPDATE raids SET size = CASE WHEN ? = 1 THEN ? ELSE size END, signup_close_hours = CASE WHEN ? = 1 THEN ? ELSE signup_close_hours END, updated_at = ?
          WHERE id = ? AND guild_id = ?`,
      ).bind(hasSize ? 1 : 0, size, hasHours ? 1 : 0, hours, ctx.now(), raid.id, guildContext.guild.id),
      raidAudit(
        ctx, guildContext, 'raid.settings', raid.id,
        { size: raid.size, signupCloseHours: raid.signup_close_hours }, { size: nextSize, signupCloseHours: nextHours }, CHANGED_ONE,
      ),
    ]);
  }
  return raidReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Recompute, delete

export async function recomputeRoute(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  return recomputeAndReply(ctx, guildContext, raid.id);
}

export async function deleteRaid(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const results = await db.batch([
    raidAudit(ctx, guildContext, 'raid.delete', raid.id, { teamId: raid.team_id, raidOn: raid.raid_on, reports: raid.reports }, null, raidExists(raid.id)),
    // Raids of other teams on the same date lose a host or a home raid: stale, re-versioned, and recalculated below.
    bumpDayStatement(db, guildContext.guild.id, raid.raid_on, raid.id),
    db.prepare('DELETE FROM raids WHERE id = ? AND guild_id = ? RETURNING id').bind(raid.id, guildContext.guild.id),
  ]);
  if (results[2].results.length !== 1) throw notFound();
  const sibling = await db.prepare('SELECT id FROM raids WHERE guild_id = ? AND raid_on = ? ORDER BY id LIMIT 1').bind(guildContext.guild.id, raid.raid_on).first();
  if (sibling) await recomputeRaid(ctx, guildContext.guild, sibling.id);
  return jsonResponse({ deleted: true, attendanceFlags: await loadAttendanceFlags(db, guildContext) });
}
