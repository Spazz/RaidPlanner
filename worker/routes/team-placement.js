// Team placement (user-hierarchy build, lane B3): put a character on a team, take it off, move it, and read what leaving would end.
//   PUT    /api/guild/:gid/roster/:pid/characters/:cid/team           { teamId, fromTeamId?, removeSignups? }   place (a character on no team) or move
//   DELETE /api/guild/:gid/roster/:pid/characters/:cid/team           { fromTeamId?, removeSignups? }           release (take it off its team)
//   GET    /api/guild/:gid/roster/:pid/characters/:cid/team-signups                                              the upcoming sign-ups the Remove confirm lists
//   GET    /api/guild/:gid/roster/unassigned?q=&team=                                                           the characters on no team that can go on the team (what Add to team offers), at the end of this file
// Rights (roster.edit, team-scoped): place = on the target team; release = on the team the character is on (its Team Leads, officers, the Guild Master: D4);
// move = on BOTH, the current lead releases first (U R3-Q8: a lead of the target team alone gets 403 release_first). Both writes need roster.view too, and both
// check their rights BEFORE they answer anything about the person (a stale page's 409 and the no-change replies carry the person record). A release or a move also passes the
// Seniority guard (worker/seniority.js). Every write is the guarded statement of worker/team-place.js: one character per person per team (409 team_taken),
// the team and the character belong to the caller's guild, and a lost race changes nothing (409 conflict with the current record).
// removeSignups (default false, "ask each time"): the person's upcoming native sign-ups for the team and their standing sign-ups for it go with the
// character. Past raids, attendance and loot are never touched.
// Placing a character that has a request waiting for THIS team settles the request in the same batch, the way approveTeamRequest does (status approved, the person's other
// requests for that team withdrawn), with its own audit row: the request no longer waits in Needs you for a placement that already happened.
import { HttpError, jsonResponse } from '../http.js';
import { TEAM_ROSTER_RANKS } from '../team-roster.js';
import { isId } from '../ids.js';
import { ingameRankLabelSql } from '../rank-map.js';
import { allows, isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { nameKey } from '../roster-data.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { homeTeamOf, loadPersonData, loadTeamRequestFlags, personReply } from '../roster-view.js';
import { assertSenior, seniorityOk } from '../seniority.js';
import { weekFreeze } from '../attendance-store.js';
import { trialClockStatement, zoneOffsetMinutes } from '../trial-clock.js';
import { dropUpcomingSignupsStatements, droppedCounts, personLeftTeamSql, placeStatement, releaseStatement, staleStatement, upcomingSignupsOf } from '../team-place.js';
import { audit, bad, characterMoved, constraintOf, findCharacter, requireEdit, requireTarget, teamTaken } from './roster.js';
import { wrote } from '../d1-changes.js';

const CHANGED_ONE = { sql: 'changes() = 1', params: [] };

async function loadCharacter(ctx, guildContext) {
  const data = await loadPersonData(ctx.db, guildContext.guild.id, ctx.params.pid);
  if (!data || !homeTeamOf(data)) throw new HttpError(404, 'not_found', 'That person was not found.');
  return { data, current: findCharacter(data, ctx.params.cid).row };
}

function readFlags(body) {
  if (body.removeSignups !== undefined && typeof body.removeSignups !== 'boolean') throw bad('removeSignups must be true or false.', 'removeSignups');
  if (body.fromTeamId !== undefined && body.fromTeamId !== null && typeof body.fromTeamId !== 'string') throw bad('fromTeamId must be a team id or null.', 'fromTeamId');
  return { removeSignups: body.removeSignups === true, from: body.fromTeamId };
}

// The team the caller saw must still be the character's, else 409 with the current record (a stale page).
async function ensureFrom(ctx, guildContext, data, current, from) {
  if (from !== undefined && from !== current.team_id) {
    throw new HttpError(409, 'conflict', 'Someone moved this character. The page now shows the current record.', { current: await personReply(ctx, guildContext, data.player.id) });
  }
}

function mapPlaceError(error) {
  if (constraintOf(error) === 'team_taken') throw teamTaken();
  throw error;
}

export async function getTeamSignups(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { data, current } = await loadCharacter(ctx, guildContext);
  if (current.team_id === null) return jsonResponse({ team: null, signups: [], standing: [] });
  requireEdit(guildContext, current.team_id);
  const upcoming = await upcomingSignupsOf(ctx.db, guildContext.guild.id, data.player.id, current.team_id, ctx.now());
  return jsonResponse({ team: { id: current.team_id, name: current.team_name }, ...upcoming });
}

export async function putCharacterTeam(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const { data, current } = await loadCharacter(ctx, guildContext);
  requireAction(guildContext, 'roster.view');
  const team = await requireTarget(db, guild.id, body.teamId);
  requireEdit(guildContext, team.id);
  const { removeSignups, from } = readFlags(body);
  await ensureFrom(ctx, guildContext, data, current, from);
  if (current.team_id === team.id) return jsonResponse(await personReply(ctx, guildContext, data.player.id));
  const moving = current.team_id !== null;
  if (moving) {
    if (!allows(guildContext.can, 'roster.edit', current.team_id)) {
      throw new HttpError(403, 'release_first',
        `${current.name} is on ${current.team_name}. That team's Team Lead, or an officer, takes it off the team first.`, { teamId: current.team_id });
    }
    await assertSenior(db, guildContext, data.player.id);
  }
  if (data.characters.some((entry) => entry.row.id !== current.id && entry.row.team_id === team.id)) throw teamTaken();

  const now = ctx.now();
  const base = { guildId: guild.id, personId: data.player.id, characterId: current.id, now };
  const senior = moving ? seniorityOk(guild.id, ctx.session.user.id, data.player.id) : null;
  const statements = [
    placeStatement(db, { ...base, teamId: team.id, from: current.team_id, extra: senior }),
    audit(ctx, guildContext, moving ? 'character.move' : 'character.place', 'character', current.id,
      { teamId: current.team_id, personId: data.player.id }, { teamId: team.id, personId: data.player.id, removeSignups: moving && removeSignups }, CHANGED_ONE),
    staleStatement(db, guild.id, [nameKey(current.name)], [current.team_id, team.id], weekFreeze(guild.time_zone, now)),
  ];
  if (moving && removeSignups) {
    statements.push(...dropUpcomingSignupsStatements(db, { guildId: guild.id, personId: data.player.id, teamId: current.team_id, nowMs: now, left: personLeftTeamSql(guild.id, data.player.id, current.team_id) }));
  }
  // The character's request for THIS team (at most one waits per character) is approved by the placement itself.
  const waiting = await db.prepare("SELECT id FROM team_requests WHERE guild_id = ? AND character_id = ? AND team_id = ? AND status = 'pending'").bind(guild.id, current.id, team.id).first();
  const approvedAt = statements.length;
  if (waiting) statements.push(...approveWaitingRequestStatements(ctx, guildContext, { requestId: waiting.id, personId: data.player.id, characterId: current.id, teamId: team.id, now }));
  // A Trial placed on (or moved to) a team starts its clock at the placement (worker/trial-clock.js). Last, so the result indexes above stay.
  statements.push(trialClockStatement(db, guild.id, { offsetMinutes: zoneOffsetMinutes(guild.time_zone, now), characterId: current.id }));
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    mapPlaceError(error);
  }
  // wrote(), not a count of 1: D1's meta.changes also counts the row the characters_team_since_move trigger (migration 0040) writes (worker/d1-changes.js).
  if (!wrote(results[0])) return characterMoved(ctx, guildContext, data.player.id, current.id);
  const removed = moving && removeSignups ? droppedCounts(results, 3) : null;
  const approved = waiting && wrote(results[approvedAt]) ? { approvedRequestId: waiting.id, teamRequestFlags: await loadTeamRequestFlags(db, guildContext) } : {};
  return jsonResponse({ ...(await personReply(ctx, guildContext, data.player.id)), ...(removed ? { removed } : {}), ...approved });
}

// The three statements that settle a waiting request when its character was placed on the request's team (a batch's own placement ran just before): approve it while the
// character really sits on that team now, audit that (guarded by the approval), and withdraw the person's other open requests for the team (one character per person per team,
// so they can never be approved: the same closing approveTeamRequest does).
function approveWaitingRequestStatements(ctx, guildContext, { requestId, personId, characterId, teamId, now }) {
  const { db } = ctx;
  const guildId = guildContext.guild.id;
  return [
    db.prepare(
      `UPDATE team_requests SET status = 'approved', decided_by = ?, decided_at = ?
        WHERE id = ? AND guild_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM characters WHERE id = ? AND guild_id = ? AND team_id = ?)`,
    ).bind(ctx.session.user.id, now, requestId, guildId, characterId, guildId, teamId),
    audit(ctx, guildContext, 'team_request.approve', 'team_request', requestId, null, { teamId, characterId, personId, via: 'placement' }, CHANGED_ONE),
    db.prepare(
      `UPDATE team_requests SET status = 'withdrawn', decided_at = ?
        WHERE guild_id = ? AND team_id = ? AND status = 'pending' AND id != ?
          AND character_id IN (SELECT id FROM characters WHERE guild_id = ? AND player_id = ?)
          AND EXISTS (SELECT 1 FROM team_requests WHERE id = ? AND status = 'approved')`,
    ).bind(now, guildId, teamId, requestId, guildId, personId, requestId),
  ];
}

export async function deleteCharacterTeam(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const { data, current } = await loadCharacter(ctx, guildContext);
  requireAction(guildContext, 'roster.view');
  // A character on no team is edited by whoever edits the person (its home team), as everywhere else.
  requireEdit(guildContext, current.team_id !== null ? current.team_id : homeTeamOf(data).id);
  const { removeSignups, from } = readFlags(body);
  await ensureFrom(ctx, guildContext, data, current, from);
  if (current.team_id === null) return jsonResponse(await personReply(ctx, guildContext, data.player.id));
  await assertSenior(db, guildContext, data.player.id);

  const now = ctx.now();
  const senior = seniorityOk(guild.id, ctx.session.user.id, data.player.id);
  const statements = [
    releaseStatement(db, { guildId: guild.id, personId: data.player.id, characterId: current.id, from: current.team_id, now, extra: senior }),
    audit(ctx, guildContext, 'character.release', 'character', current.id,
      { teamId: current.team_id, personId: data.player.id }, { teamId: null, personId: data.player.id, removeSignups }, CHANGED_ONE),
    staleStatement(db, guild.id, [nameKey(current.name)], [current.team_id], weekFreeze(guild.time_zone, now)),
  ];
  if (removeSignups) {
    statements.push(...dropUpcomingSignupsStatements(db, { guildId: guild.id, personId: data.player.id, teamId: current.team_id, nowMs: now, left: personLeftTeamSql(guild.id, data.player.id, current.team_id) }));
  }
  const results = await db.batch(statements);
  // wrote(), not a count of 1: D1's meta.changes also counts the row the characters_team_since_move trigger (migration 0040) writes (worker/d1-changes.js).
  if (!wrote(results[0])) return characterMoved(ctx, guildContext, data.player.id, current.id);
  const removed = removeSignups ? droppedCounts(results, 3) : null;
  return jsonResponse({ ...(await personReply(ctx, guildContext, data.player.id)), ...(removed ? { removed } : {}) });
}

// ---------------------------------------------------------------------------
// The characters that can be placed: the list "Add to team" offers (U roster decision: it lists only characters with no team)
//   GET /api/guild/:gid/roster/unassigned?q=&team=   roster.edit anywhere (on the team, with ?team=)
//     -> { characters: [{ id, name, class, mainSpec, realm, isMain, status, inGameRank, trialEnd, person: { id, name }, requestedTeamId }], more }
// A character that would show on no roster view is left out (U R6-Q2): Social and Former characters (a left-on date, or a rank that does not raid). With ?team= the persons that
// already have a character on that team are left out too (one character per person per team). q: the start of a character name. Sorted by name. status: the core rank the
// placement gives it. inGameRank: the label the guild's rank map gives it (null: not on the in-game roster). trialEnd: null on a Trial whose clock the placement starts.
// requestedTeamId: the team a member already asked for (a pending team request).
const UNASSIGNED_LIMIT = 100;
const RAIDING = TEAM_ROSTER_RANKS.map((rank) => `'${rank}'`).join(', ');
const UNASSIGNED_SQL = (withTeam) => `SELECT c.id, c.name, c.class, c.main_spec, c.realm, c.is_main, c.core_rank, c.trial_end, c.player_id, m.name AS main_name,
       ${ingameRankLabelSql('c')} AS ingame_rank,
       (SELECT q.team_id FROM team_requests q WHERE q.character_id = c.id AND q.status = 'pending') AS requested_team_id
  FROM characters c LEFT JOIN characters m ON m.player_id = c.player_id AND m.guild_id = c.guild_id AND m.is_main = 1
 WHERE c.guild_id = ? AND c.team_id IS NULL AND c.left_on IS NULL AND c.core_rank IN (${RAIDING}) AND c.name_key LIKE ? ESCAPE '!' AND ${visibleCharacterSql('c')}
   ${withTeam ? 'AND NOT EXISTS (SELECT 1 FROM characters h WHERE h.player_id = c.player_id AND h.guild_id = c.guild_id AND h.team_id = ?)' : ''}
 ORDER BY c.name_key, c.id LIMIT ?`;

export async function listUnassigned(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const query = new URL(ctx.request.url).searchParams;
  const raw = query.get('q');
  const prefix = nameKey(raw === null ? '' : raw).replace(/[!%_]/g, (char) => `!${char}`);
  const teamId = query.get('team');
  if (teamId !== null) {
    if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
    requireEdit(guildContext, teamId);
    const team = await ctx.db.prepare('SELECT id FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildContext.guild.id).first();
    if (!team) throw bad('That team does not exist in this guild.', 'team');
  }
  const binds = [guildContext.guild.id, `${prefix}%`, ...(teamId === null ? [] : [teamId]), UNASSIGNED_LIMIT + 1];
  const result = await ctx.db.prepare(UNASSIGNED_SQL(teamId !== null)).bind(...binds).all();
  return jsonResponse({
    characters: result.results.slice(0, UNASSIGNED_LIMIT).map((row) => ({
      id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, realm: row.realm, isMain: row.is_main === 1,
      status: row.core_rank, inGameRank: row.ingame_rank === undefined ? null : row.ingame_rank, trialEnd: row.trial_end,
      person: { id: row.player_id, name: row.main_name }, requestedTeamId: row.requested_team_id,
    })),
    more: result.results.length > UNASSIGNED_LIMIT,
  });
}
