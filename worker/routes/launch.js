// The Launch funnel of a team (Roster > Launch): who has picked what to play, has the character, is at which level band and is ready - for the launch of a
// new WoW version. A Forever guild always has it; any other version for a team marked as a launch team.
//   GET /api/guild/:gid/launch?team=            (roster.view)  the funnel: a row per person of the team, the totals per stage and role, the gap to the raid size
//   PUT /api/guild/:gid/launch/:pid             (the person, or roster.edit on the team)  { teamId, levelBand?: band | null, ready?: boolean }
//   PUT /api/guild/:gid/teams/:tid/launch       (guild.teams)  { enabled }: mark the team as a launch team (or not)
// Every write answers with the funnel it changed, in the shape of the GET. Intent comes from the intent board (worker/routes/intent.js), the character from
// the roster, a level from an approved Battle.net claim; the level band and the ready tick are what is typed in (worker/launch-data.js).
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId } from '../ids.js';
import { LEVEL_BANDS, funnelRow, funnelTotals, launchEnabled } from '../launch-data.js';
import { ownPersonStatement } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { targetsOf } from '../recruit-data.js';
import { personOnTeamRosterSql, rosterRankOnTeamSql } from '../team-roster.js';
import { bad } from './roster.js';

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

async function loadTeam(db, guildId, teamId) {
  const team = await db.prepare('SELECT id, name, size, archived, recruit_targets, launch_team FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist in this guild.');
  return team;
}

async function viewerPerson(ctx, guildContext) {
  const row = await ownPersonStatement(ctx.db, guildContext.guild.id, ctx.session.user.id).first();
  return row ? row.id : null;
}

// The funnel of one team. -> the GET's payload.
export async function funnelPayload(ctx, guildContext, team) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const enabled = launchEnabled(guild, team);
  const base = {
    team: { id: team.id, name: team.name, size: team.size, archived: team.archived === 1, launchTeam: team.launch_team === 1 },
    enabled,
    gameVersion: guild.game_version,
    canEdit: allows(guildContext.can, 'roster.edit', team.id),
    canMark: allows(guildContext.can, 'guild.teams', team.id),
    myPersonId: await viewerPerson(ctx, guildContext),
    levelBands: LEVEL_BANDS,
  };
  if (!enabled) return { ...base, rows: [], totals: null, round: null };
  const [peopleResult, characterResult, roundResult, statusResult, claimResult] = await db.batch([
    db.prepare(
      `SELECT p.id, ${rosterRankOnTeamSql('p.id', '?2')} AS status, m.name, m.class FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ?1 AND ${personOnTeamRosterSql('p.id', '?2')}
        ORDER BY m.name_key, p.id`,
    ).bind(guild.id, team.id),
    db.prepare('SELECT player_id, class FROM characters WHERE guild_id = ? AND team_id = ?').bind(guild.id, team.id),
    db.prepare(
      `SELECT id, title, status FROM intent_rounds WHERE guild_id = ? AND team_id = ? ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT 1`,
    ).bind(guild.id, team.id),
    db.prepare('SELECT player_id, level_band, ready FROM launch_status WHERE guild_id = ? AND team_id = ?').bind(guild.id, team.id),
    // The highest level an approved Battle.net claim gave a character of the team.
    db.prepare(
      `SELECT c.player_id, MAX(cl.level) AS level FROM characters c
         JOIN character_claims cl ON cl.guild_id = c.guild_id AND cl.name_key = c.name_key AND cl.realm_key = c.realm_key AND cl.status = 'approved' AND cl.level IS NOT NULL
        WHERE c.guild_id = ? AND c.team_id = ? GROUP BY c.player_id`,
    ).bind(guild.id, team.id),
  ]);
  const round = roundResult.results[0] || null;
  const picks = round
    ? (await db.prepare("SELECT player_id, class, spec, role FROM intent_picks WHERE round_id = ? AND guild_id = ? AND kind = 'main'").bind(round.id, guild.id).all()).results
    : [];
  const pickBy = new Map(picks.map((row) => [row.player_id, row]));
  const classesBy = new Map();
  for (const row of characterResult.results) {
    if (!classesBy.has(row.player_id)) classesBy.set(row.player_id, []);
    classesBy.get(row.player_id).push(row.class);
  }
  const statusBy = new Map(statusResult.results.map((row) => [row.player_id, row]));
  const levelBy = new Map(claimResult.results.map((row) => [row.player_id, row.level]));
  const rows = peopleResult.results.map((person) => ({
    ...funnelRow(person, pickBy.get(person.id) || null, classesBy.get(person.id) || [], statusBy.get(person.id) || null, levelBy.get(person.id) || null),
    mine: person.id === base.myPersonId,
  }));
  return {
    ...base,
    round: round ? { id: round.id, title: round.title, status: round.status } : null,
    rows,
    totals: funnelTotals(rows, team.size, targetsOf(team.recruit_targets, team.size).targets),
  };
}

export async function getLaunch(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'roster.view');
  const teamId = new URL(ctx.request.url).searchParams.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const team = await loadTeam(ctx.db, guildContext.guild.id, teamId);
  if (!allows(guildContext.can, 'roster.view', team.id)) throw forbidden();
  return jsonResponse(await funnelPayload(ctx, guildContext, team));
}

export async function putLaunchStatus(ctx) {
  const { db, body } = ctx;
  if (!isId('t', body.teamId)) throw bad('Pick a team.', 'teamId');
  if (body.levelBand !== undefined && body.levelBand !== null && !LEVEL_BANDS.includes(body.levelBand)) throw bad(`Pick a level band: ${LEVEL_BANDS.join(', ')}.`, 'levelBand');
  if (body.ready !== undefined && typeof body.ready !== 'boolean') throw bad('ready must be true or false.', 'ready');
  if (body.levelBand === undefined && body.ready === undefined) throw bad('Send a level band, the ready tick, or both.', 'levelBand');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await loadTeam(db, guild.id, body.teamId);
  if (!launchEnabled(guild, team)) throw new HttpError(409, 'launch_off', 'The Launch funnel is not on for this team.');
  const person = await db.prepare('SELECT id FROM players WHERE id = ? AND guild_id = ?').bind(ctx.params.pid, guild.id).first();
  if (!person) throw new HttpError(404, 'not_found', 'That person was not found.');
  const own = await viewerPerson(ctx, guildContext);
  if (own !== person.id && !allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  const onTeam = await db.prepare(`SELECT ${personOnTeamRosterSql('?1', '?2')} AS on_team`).bind(person.id, team.id).first();
  if (!onTeam.on_team) throw new HttpError(409, 'not_on_team', 'Only people on this team are in its funnel.');
  const existing = await db.prepare('SELECT level_band, ready FROM launch_status WHERE team_id = ? AND player_id = ?').bind(team.id, person.id).first();
  const levelBand = body.levelBand === undefined ? (existing ? existing.level_band : null) : body.levelBand;
  const ready = body.ready === undefined ? (existing ? existing.ready : 0) : (body.ready ? 1 : 0);
  const now = ctx.now();
  await db.batch([
    db.prepare(
      `INSERT INTO launch_status (guild_id, team_id, player_id, level_band, ready, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, player_id) DO UPDATE SET level_band = excluded.level_band, ready = excluded.ready, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(guild.id, team.id, person.id, levelBand, ready, ctx.session.user.id, now),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'launch.update', entityType: 'person', entityId: person.id,
      before: existing ? { levelBand: existing.level_band, ready: existing.ready === 1 } : null, after: { teamId: team.id, levelBand, ready: ready === 1 },
    }),
  ]);
  return jsonResponse(await funnelPayload(ctx, guildContext, team));
}

export async function putLaunchTeam(ctx) {
  const { db, body } = ctx;
  if (typeof body.enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await loadTeam(db, guild.id, ctx.params.tid);
  if (!allows(guildContext.can, 'guild.teams', team.id)) throw forbidden();
  const next = body.enabled ? 1 : 0;
  if (team.launch_team !== next) {
    await db.batch([
      db.prepare('UPDATE teams SET launch_team = ? WHERE id = ? AND guild_id = ?').bind(next, team.id, guild.id),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'launch.team', entityType: 'team', entityId: team.id,
        before: { launchTeam: team.launch_team === 1 }, after: { launchTeam: next === 1 },
      }),
    ]);
  }
  return jsonResponse(await funnelPayload(ctx, guildContext, { ...team, launch_team: next }));
}
