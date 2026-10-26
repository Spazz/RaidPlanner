// Recruitment needs: for one team, the active roster (Raider and Trial Mains) counted by role against officer-set targets, with the team's open
// intent round laid over it when there is one (a person who picked a main for the round counts as that pick). Which raid buffs and debuffs the
// roster covers is worked out in the browser with the Planner's rules (js/analysis.js rosterBuffCoverage); this route hands over the class/spec
// lists, the raid days of the weekly schedule and where the application page is.
//   GET /api/guild/:gid/recruiting?team=              (roster.edit on the team)
//   PUT /api/guild/:gid/teams/:tid/recruiting         (roster.edit on the team)  { targets: { tank, healer, melee, ranged } | null }  null = the defaults
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId } from '../ids.js';
import { allows, loadGuildContext } from '../permissions.js';
import { RAID_ROLES, countRoles, defaultTargets, gapsOf, readTargets, targetsOf } from '../recruit-data.js';
import { isSpecOf } from '../roster-data.js';
import { onTeamRosterSql } from '../team-roster.js';
import { bad } from './roster.js';

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

async function loadTeam(db, guildId, teamId) {
  const team = await db.prepare('SELECT id, name, size, archived, recruit_targets FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist in this guild.');
  return team;
}

// members: [{ class, spec }] -> the section a page draws: counts, what is unknown, the gaps against the targets, and the specs for the buff check.
function sectionOf(members, targets) {
  const { counts, unknown } = countRoles(members);
  return {
    people: members.length,
    counts,
    unknown,
    gaps: gapsOf(counts, targets),
    specs: members.filter((member) => member.spec && isSpecOf(member.class, member.spec)).map((member) => ({ class: member.class, spec: member.spec })),
  };
}

async function recruitingPayload(ctx, guildContext, team) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const { targets, custom } = targetsOf(team.recruit_targets, team.size);
  const [mainResult, roundResult, scheduleResult, guildResult] = await db.batch([
    db.prepare(
      `SELECT m.player_id AS id, m.class, m.main_spec FROM characters m
        WHERE m.guild_id = ? AND m.is_main = 1 AND ${onTeamRosterSql('m', '?')} AND m.core_rank IN ('raider', 'trial') ORDER BY m.name_key, m.player_id`,
    ).bind(guild.id, team.id),
    db.prepare(
      `SELECT r.id, r.title, k.player_id, k.class, k.spec FROM intent_rounds r LEFT JOIN intent_picks k ON k.round_id = r.id AND k.kind = 'main'
        WHERE r.guild_id = ? AND r.team_id = ? AND r.status = 'open'`,
    ).bind(guild.id, team.id),
    db.prepare('SELECT weekday, start_time, zone, title FROM team_schedules WHERE team_id = ? ORDER BY weekday').bind(team.id),
    db.prepare('SELECT apply_enabled FROM guilds WHERE id = ?').bind(guild.id),
  ]);
  const roster = mainResult.results.map((row) => ({ id: row.id, class: row.class, spec: row.main_spec }));
  let intent = null;
  if (roundResult.results.length) {
    const picks = new Map(roundResult.results.filter((row) => row.player_id).map((row) => [row.player_id, { class: row.class, spec: row.spec }]));
    const planned = roster.map((member) => picks.get(member.id) || member);
    const replaced = roster.filter((member) => picks.has(member.id)).length;
    intent = { roundId: roundResult.results[0].id, title: roundResult.results[0].title, replaced, ...sectionOf(planned, targets) };
  }
  return {
    team: { id: team.id, name: team.name, size: team.size },
    guild: {
      id: guild.id, name: guild.name, realm: guild.realm, realmKind: guild.realm_kind, region: guild.region, gameVersion: guild.game_version,
      applyEnabled: guildResult.results[0].apply_enabled === 1, applyPath: `/#/apply/${guild.id}`,
    },
    targets,
    defaultTargets: defaultTargets(team.size),
    customTargets: custom,
    roster: sectionOf(roster, targets),
    intent,
    schedule: scheduleResult.results.map((row) => ({ weekday: row.weekday, startTime: row.start_time, zone: row.zone, title: row.title })),
  };
}

export async function getRecruiting(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const teamId = new URL(ctx.request.url).searchParams.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const team = await loadTeam(ctx.db, guildContext.guild.id, teamId);
  if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  return jsonResponse(await recruitingPayload(ctx, guildContext, team));
}

export async function putRecruitTargets(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await loadTeam(ctx.db, guild.id, ctx.params.tid);
  if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  let stored = null;
  if (ctx.body.targets !== null) {
    const read = readTargets(ctx.body.targets);
    if (!read.ok) throw bad(read.message, 'targets');
    stored = JSON.stringify(Object.fromEntries(RAID_ROLES.map((role) => [role, read.value[role]])));
  }
  const before = targetsOf(team.recruit_targets, team.size);
  const after = targetsOf(stored, team.size);
  if (JSON.stringify(before.targets) !== JSON.stringify(after.targets) || before.custom !== after.custom) {
    await ctx.db.batch([
      ctx.db.prepare('UPDATE teams SET recruit_targets = ? WHERE id = ? AND guild_id = ?').bind(stored, team.id, guild.id),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'recruiting.targets', entityType: 'team', entityId: team.id,
        before: { custom: before.custom }, after: { custom: after.custom, teamId: team.id },
      }),
    ]);
  }
  return jsonResponse(await recruitingPayload(ctx, guildContext, { ...team, recruit_targets: stored }));
}
