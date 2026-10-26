// Away notices: a member says they are away (a date range, or a repeating weekday), arriving late or leaving early, with an optional reason only they and
// the officers over them can read. Officers (raids.edit on a team the person has a character on) write them for anyone on their teams. A notice makes a
// virtual Absence on the sign-up panel, the Raids list, the calendar feed and the Planner seed, and counts as "missed with notice" in the attendance of a
// raid the person missed (worker/away.js holds the rules, worker/attendance-store.js and worker/routes/signups.js apply them).
// Writes are conditional INSERT / UPDATE / DELETE statements in one db.batch that re-check the person's ownership and the guild; the raids whose
// results depend on the notice are bumped in the same batch (no recompute that read the old notices may write over that) and recomputed afterwards.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { addDays } from '../attendance-calendar.js';
import { recomputeRaid } from '../attendance-store.js';
import { displayCharacter } from '../attendance-view.js';
import {
  MAX_NOTICES, TEAM_WINDOW_DAYS, countsTowardCap, coveredDates, noticeCovers, noticeOfRow, validateNotice,
} from '../away.js';
import { isId, newId } from '../ids.js';
import { reconcileStanding } from '../standing.js';
import { ownPersonStatement, ownPlayerSql } from '../membership.js';
import { allows, loadGuildContext } from '../permissions.js';
import { personOnTeamRosterSql } from '../team-roster.js';
import { guildToday } from '../roster-view.js';
import { bad } from './roster.js';

const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const RECOMPUTE_DATES = 20; // the newest dates recomputed in the request; the rest stay marked for recalculation
const RAID_SCAN_LIMIT = 1000;
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const notFound = () => new HttpError(404, 'not_found', 'That notice does not exist.');

const NOTICE_SELECT = 'SELECT id, player_id, kind, at_time, starts_on, ends_on, weekday, reason, created_at FROM away_notices';
const LIST_SQL = `${NOTICE_SELECT} WHERE guild_id = ? AND player_id = ? ORDER BY starts_on, created_at, id`;
const BY_ID_SQL = `${NOTICE_SELECT} WHERE id = ? AND guild_id = ?`;
// The notices that count toward the per-person cap (binds today, the guild-local date): current or still ahead - countsTowardCap in worker/away.js says the same.
const COUNTS_TOWARD_CAP_SQL = '((weekday IS NOT NULL AND ends_on IS NULL) OR COALESCE(ends_on, starts_on) >= ?)';

// The notice as the API shows it. `reason` only where the viewer is the person or an officer over them (every caller of this module is one of the two).
const noticeView = (row, mine) => ({
  id: row.id,
  personId: row.player_id,
  kind: row.kind,
  atTime: row.at_time,
  from: row.starts_on,
  to: row.ends_on,
  weekday: row.weekday,
  reason: row.reason,
  mine,
  createdAt: row.created_at,
});

// ---------------------------------------------------------------------------
// Who may act on whom

// { exists, own, officer, teamIds }: the person is in this guild; is the viewer's own; or has a character on a team the viewer holds raids.edit for.
async function personAccess(ctx, guildContext, personId, ownId) {
  const guildId = guildContext.guild.id;
  const [personResult, teamResult] = await ctx.db.batch([
    ctx.db.prepare('SELECT id FROM players WHERE id = ? AND guild_id = ?').bind(personId, guildId),
    ctx.db.prepare('SELECT DISTINCT team_id FROM characters WHERE guild_id = ? AND player_id = ?').bind(guildId, personId),
  ]);
  const exists = personResult.results.length === 1;
  const teamIds = teamResult.results.map((row) => row.team_id);
  return {
    exists,
    teamIds,
    own: exists && ownId === personId,
    officer: exists && teamIds.some((teamId) => allows(guildContext.can, 'raids.edit', teamId)),
  };
}

// The authorization again, inside the write: the person is the account's own, or has a character on a team the officer may edit raids of.
const OWN_GUARD = `EXISTS (SELECT 1 FROM players ap WHERE ap.id = ? AND ap.guild_id = ? AND ${ownPlayerSql('ap', '?')})`;
const OFFICER_GUARD = 'EXISTS (SELECT 1 FROM characters ac WHERE ac.guild_id = ? AND ac.player_id = ? AND (? = 1 OR ac.team_id IN (SELECT value FROM json_each(?))))';

function writeGuard(ctx, guildContext, personId, access) {
  if (access.officer) {
    const scope = guildContext.can['raids.edit'];
    return { sql: OFFICER_GUARD, params: [guildContext.guild.id, personId, scope === 'guild' ? 1 : 0, JSON.stringify(scope === 'guild' ? [] : scope)] };
  }
  return { sql: OWN_GUARD, params: [personId, guildContext.guild.id, ctx.session.user.id, ctx.session.user.id] };
}

const ownPersonId = async (ctx, guildContext) => {
  const own = await ownPersonStatement(ctx.db, guildContext.guild.id, ctx.session.user.id).first();
  return own ? own.id : null;
};

// ---------------------------------------------------------------------------
// After a write

// The raids whose attendance results the notices touch: this person's team raids that have a log or hand-entered attendance and fall on a date the old
// or the new Away notice covers, newest first. Late and Leaving notices change no result. -> [{ id, raid_on }]
async function affectedRaids(ctx, guildContext, personId, before, after) {
  const away = [before, after].filter((notice) => notice && notice.kind === 'away');
  if (!away.length) return [];
  const since = away.map((notice) => notice.from).sort()[0];
  const rows = await ctx.db.prepare(
    `SELECT id, raid_on FROM raids
      WHERE guild_id = ?1 AND raid_on >= ?2 AND team_id IN (SELECT team_id FROM characters WHERE guild_id = ?1 AND player_id = ?3)
        AND (log_mode = 'manual' OR EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = raids.id))
      ORDER BY raid_on DESC, id LIMIT ?4`,
  ).bind(guildContext.guild.id, since, personId, RAID_SCAN_LIMIT).all();
  return rows.results.filter((row) => away.some((notice) => noticeCovers(notice, row.raid_on)));
}

// Marks the affected raids out of date, inside the notice write's batch. `guard` ({ sql, params }) makes it conditional on the write applying.
function bumpStatement(db, guildId, affected, guard) {
  return db.prepare(
    `UPDATE raids SET policy_fp = '', version = version + 1 WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
  ).bind(guildId, JSON.stringify(affected.map((row) => row.id)), ...guard.params);
}

// The ONE place that follows a notice write: the newest affected dates are recalculated now (one raid per date recalculates the whole date); older ones keep
// the stale mark the bump gave them. The standing sign-up reconcile of a person's raids belongs here too.
export async function afterAwayChange(ctx, guildContext, personId, affected) {
  // A standing sign-up gives way to an Away notice that covers its raid, and comes back when the notice goes; first, so the recalculation below reads the result.
  await reconcileStanding(ctx, guildContext.guild, { personId });
  const dates = new Set();
  for (const raid of affected) {
    if (dates.has(raid.raid_on)) continue;
    if (dates.size >= RECOMPUTE_DATES) break;
    dates.add(raid.raid_on);
    await recomputeRaid(ctx, guildContext.guild, raid.id);
  }
}

async function listFor(ctx, guildContext, personId) {
  return (await ctx.db.prepare(LIST_SQL).bind(guildContext.guild.id, personId).all()).results;
}

const tooMany = (forSelf) => new HttpError(
  409, 'too_many_notices', forSelf ? `You can have at most ${MAX_NOTICES} notices. Remove one you no longer need first.` : `A person can have at most ${MAX_NOTICES} notices.`, { max: MAX_NOTICES },
);

function readInput(ctx, today, access, current = null) {
  const checked = validateNotice(ctx.body, { today, officer: access.officer, current });
  if (!checked.ok) throw bad(checked.message, checked.field);
  return checked.value;
}

// ---------------------------------------------------------------------------
// Reads

// GET /away/mine -> { today, timeZone, personId | null, notices: [notice], max }. Anyone in the guild; a viewer with no roster person has none.
export async function getMyNotices(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const personId = await ownPersonId(ctx, guildContext);
  const rows = personId ? await listFor(ctx, guildContext, personId) : [];
  const today = guildToday(guild, ctx.now());
  return jsonResponse({
    today, timeZone: guild.time_zone, personId, notices: rows.map((row) => noticeView(row, true)), max: MAX_NOTICES,
    active: rows.filter((row) => countsTowardCap(noticeOfRow(row), today)).length, // the count the cap applies to: notices that ended are not in it
  });
}

// GET /away?team=<tid> (raids.edit on the team): who is away, late or leaving in the next four weeks, one entry per notice.
async function getTeamNotices(ctx, guildContext, teamId) {
  const guild = guildContext.guild;
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const team = await ctx.db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guild.id).first();
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  if (!allows(guildContext.can, 'raids.edit', team.id)) throw forbidden();
  const today = guildToday(guild, ctx.now());
  const until = addDays(today, TEAM_WINDOW_DAYS); // the day after the last day shown
  const last = addDays(today, TEAM_WINDOW_DAYS - 1);
  const [noticeResult, characterResult] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT n.id, n.player_id, n.kind, n.at_time, n.starts_on, n.ends_on, n.weekday, n.reason, n.created_at
         FROM away_notices n
        WHERE n.guild_id = ?1 AND n.starts_on <= ?2 AND (n.ends_on IS NULL OR n.ends_on >= ?3)
          AND ${personOnTeamRosterSql('n.player_id', '?4')}`,
    ).bind(guild.id, last, today, team.id),
    ctx.db.prepare('SELECT id, player_id, name, class, is_main, team_id FROM characters WHERE guild_id = ? AND team_id = ?').bind(guild.id, team.id),
  ]);
  const charactersByPlayer = new Map();
  for (const row of characterResult.results) {
    if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
    charactersByPlayer.get(row.player_id).push(row);
  }
  const entries = [];
  for (const row of noticeResult.results) {
    const notice = noticeOfRow(row);
    const dates = coveredDates(notice, today, last);
    if (!dates.length) continue;
    const shown = displayCharacter(charactersByPlayer.get(row.player_id) || [], team.id);
    entries.push({
      noticeId: row.id, personId: row.player_id, name: shown ? shown.name : 'Unknown', class: shown ? shown.class : null, kind: row.kind, atTime: row.at_time,
      from: row.starts_on, to: row.ends_on, weekday: row.weekday, reason: row.reason, dates,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.from.localeCompare(b.from) || a.noticeId.localeCompare(b.noticeId));
  return jsonResponse({ team: { id: team.id, name: team.name }, today, until, entries });
}

// GET /away?person=<pid> (the person themselves, or raids.edit for a team they have a character on) -> { personId, today, notices }.
async function getPersonNotices(ctx, guildContext, personId) {
  if (!isId('p', personId)) throw bad('Pick a person.', 'person');
  const access = await personAccess(ctx, guildContext, personId, await ownPersonId(ctx, guildContext));
  if (!(access.own || access.officer)) throw forbidden();
  const rows = await listFor(ctx, guildContext, personId);
  return jsonResponse({ personId, today: guildToday(guildContext.guild, ctx.now()), notices: rows.map((row) => noticeView(row, access.own)) });
}

export async function getNotices(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const query = new URL(ctx.request.url).searchParams;
  const team = query.get('team');
  const person = query.get('person');
  if ((team === null) === (person === null)) throw bad('Send team or person.', 'team');
  return team !== null ? getTeamNotices(ctx, guildContext, team) : getPersonNotices(ctx, guildContext, person);
}

// ---------------------------------------------------------------------------
// Writes

// The audit row of an officer's write on someone else's notice: ids and the kind only (never a reason or a name).
const awayAudit = (ctx, guildContext, action, personId, before, after, guard) => auditStatement(ctx, {
  guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType: 'person', entityId: personId, before, after,
}, guard);

// POST /away { personId?, kind, from, to?, weekday?, atTime?, reason? } -> 201 { notice, notices }
export async function postNotice(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const requested = ctx.body && typeof ctx.body === 'object' ? ctx.body.personId : undefined;
  if (requested !== undefined && requested !== null && !isId('p', requested)) throw bad('personId must be a person id.', 'personId');
  const ownId = await ownPersonId(ctx, guildContext);
  const personId = requested || ownId;
  if (!personId) throw forbidden();
  const access = await personAccess(ctx, guildContext, personId, ownId);
  if (!access.own && !access.officer) throw forbidden();
  const today = guildToday(guild, ctx.now());
  const input = readInput(ctx, today, access);

  const id = newId('an', ctx.randomBytes);
  const now = ctx.now();
  const guard = writeGuard(ctx, guildContext, personId, access);
  const affected = await affectedRaids(ctx, guildContext, personId, null, { kind: input.kind, from: input.from, to: input.to, weekday: input.weekday });
  const forOther = !access.own;
  const statements = [
    db.prepare(
      `INSERT INTO away_notices (id, guild_id, player_id, kind, at_time, starts_on, ends_on, weekday, reason, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guard.sql} AND (SELECT COUNT(*) FROM away_notices WHERE guild_id = ? AND player_id = ? AND ${COUNTS_TOWARD_CAP_SQL}) < ?
       RETURNING id`,
    ).bind(id, guild.id, personId, input.kind, input.atTime, input.from, input.to, input.weekday, input.reason, ctx.session.user.id, now, now, ...guard.params, guild.id, personId, today, MAX_NOTICES),
  ];
  if (forOther) statements.push(awayAudit(ctx, guildContext, 'away.set', personId, null, { kind: input.kind, personId }, CHANGED_ONE));
  if (affected.length) statements.push(bumpStatement(db, guild.id, affected, { sql: 'EXISTS (SELECT 1 FROM away_notices WHERE id = ?)', params: [id] }));
  const results = await db.batch(statements);
  if (!results[0].results.length) {
    const taken = await db.prepare(`SELECT COUNT(*) AS n FROM away_notices WHERE guild_id = ? AND player_id = ? AND ${COUNTS_TOWARD_CAP_SQL}`).bind(guild.id, personId, today).first('n');
    throw taken >= MAX_NOTICES ? tooMany(access.own) : forbidden();
  }
  await afterAwayChange(ctx, guildContext, personId, affected);
  const rows = await listFor(ctx, guildContext, personId);
  const notices = rows.map((row) => noticeView(row, access.own));
  return jsonResponse({ notice: notices.find((notice) => notice.id === id), notices }, 201);
}

// The notice of the route and the viewer's access to its person (404 for a notice that is not theirs to touch, so ids are not probed).
async function loadOwnedNotice(ctx, guildContext) {
  const row = await ctx.db.prepare(BY_ID_SQL).bind(ctx.params.nid, guildContext.guild.id).first();
  if (!row) throw notFound();
  const access = await personAccess(ctx, guildContext, row.player_id, await ownPersonId(ctx, guildContext));
  if (!access.own && !access.officer) throw notFound();
  return { row, access };
}

// PUT /away/:nid replaces kind, from, to, weekday, atTime and reason -> { notice, notices }
export async function putNotice(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const { row, access } = await loadOwnedNotice(ctx, guildContext);
  const before = noticeOfRow(row);
  const input = readInput(ctx, guildToday(guild, ctx.now()), access, before);
  const now = ctx.now();
  const guard = writeGuard(ctx, guildContext, row.player_id, access);
  const affected = await affectedRaids(ctx, guildContext, row.player_id, before, { kind: input.kind, from: input.from, to: input.to, weekday: input.weekday });
  const statements = [];
  // The bump comes first and tests what the update tests: the notice is there and the viewer may still touch its person.
  if (affected.length) {
    statements.push(bumpStatement(db, guild.id, affected, {
      sql: `EXISTS (SELECT 1 FROM away_notices WHERE id = ? AND guild_id = ? AND player_id = ? AND ${guard.sql})`, params: [row.id, guild.id, row.player_id, ...guard.params],
    }));
  }
  const at = statements.length;
  statements.push(db.prepare(
    `UPDATE away_notices SET kind = ?, at_time = ?, starts_on = ?, ends_on = ?, weekday = ?, reason = ?, updated_at = ?
      WHERE id = ? AND guild_id = ? AND player_id = ? AND ${guard.sql} RETURNING id`,
  ).bind(input.kind, input.atTime, input.from, input.to, input.weekday, input.reason, now, row.id, guild.id, row.player_id, ...guard.params));
  if (!access.own) statements.push(awayAudit(ctx, guildContext, 'away.set', row.player_id, { kind: row.kind }, { kind: input.kind, personId: row.player_id }, CHANGED_ONE));
  const results = await db.batch(statements);
  if (!results[at].results.length) throw notFound();
  await afterAwayChange(ctx, guildContext, row.player_id, affected);
  const notices = (await listFor(ctx, guildContext, row.player_id)).map((entry) => noticeView(entry, access.own));
  return jsonResponse({ notice: notices.find((notice) => notice.id === row.id), notices });
}

// DELETE /away/:nid -> { deleted: true, notices }
export async function deleteNotice(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const { row, access } = await loadOwnedNotice(ctx, guildContext);
  const before = noticeOfRow(row);
  const guard = writeGuard(ctx, guildContext, row.player_id, access);
  const affected = await affectedRaids(ctx, guildContext, row.player_id, before, null);
  const statements = [];
  if (affected.length) {
    statements.push(bumpStatement(db, guild.id, affected, {
      sql: `EXISTS (SELECT 1 FROM away_notices WHERE id = ? AND guild_id = ? AND player_id = ? AND ${guard.sql})`, params: [row.id, guild.id, row.player_id, ...guard.params],
    }));
  }
  const at = statements.length;
  statements.push(db.prepare(`DELETE FROM away_notices WHERE id = ? AND guild_id = ? AND player_id = ? AND ${guard.sql} RETURNING id`).bind(row.id, guild.id, row.player_id, ...guard.params));
  if (!access.own) statements.push(awayAudit(ctx, guildContext, 'away.remove', row.player_id, { kind: row.kind, personId: row.player_id }, null, CHANGED_ONE));
  const results = await db.batch(statements);
  if (!results[at].results.length) throw notFound();
  await afterAwayChange(ctx, guildContext, row.player_id, affected);
  const notices = (await listFor(ctx, guildContext, row.player_id)).map((entry) => noticeView(entry, access.own));
  return jsonResponse({ deleted: true, notices });
}
