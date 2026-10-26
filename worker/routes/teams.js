import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import { toPerson } from '../person.js';
import { teamRosterSql } from '../team-roster.js';
import { LIMITS, TEAM_LIMIT_MESSAGE } from '../limits.js';
import { RAID_SIZES, defaultTeamSize, isRaidSize } from '../raid-zones.js';

const MAX_TEAM_NAME = 40;
export const MAX_ACTIVE_TEAMS = LIMITS.teams;
const TEAM_CAP_MESSAGE = TEAM_LIMIT_MESSAGE;
const ACTIVE_TEAM_COUNT = 'SELECT COUNT(*) AS n FROM teams WHERE guild_id = ? AND archived = 0';
const TEAM_NAME_TAKEN = 'Another active team in this guild already has that name.';
export const DEFAULT_TRIAL_DAYS = 14;
const TRIAL_DAYS_MESSAGE = 'Trial length is 1 to 90 days.';
const SIZE_MESSAGE = `size is ${RAID_SIZES.slice(0, -1).join(', ')} or ${RAID_SIZES[RAID_SIZES.length - 1]}.`;

// A team's raid size (10 / 20 / 25 / 40). teams.size has no CHECK (a column cannot get one without rebuilding the table), so the Worker holds the rule.
function readSize(value) {
  if (!isRaidSize(value)) throw new HttpError(400, 'bad_request', SIZE_MESSAGE, { field: 'size' });
  return value;
}

export function teamView(row, leads = [], players = 0) {
  // launchTeam (wave 8, the Roster's Launch tab) is there only for a team marked as a launch team.
  return { id: row.id, name: row.name, size: row.size, archived: row.archived === 1, trialDays: row.trial_days === undefined ? DEFAULT_TRIAL_DAYS : row.trial_days, players, leads, ...(row.launch_team === 1 ? { launchTeam: true } : {}) };
}

// Every team of the guild (archived ones included), with the unblocked Team Leads of each.
export async function loadTeams(db, guildId) {
  const [teamResult, leadResult, countResult] = await db.batch([
    db.prepare('SELECT id, name, size, archived, launch_team, trial_days FROM teams WHERE guild_id = ? ORDER BY created_at, id').bind(guildId),
    db.prepare(
      `SELECT DISTINCT ra.team_id, u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar
         FROM effective_roles ra JOIN users u ON u.id = ra.user_id
        WHERE ra.guild_id = ? AND ra.role_id = 'team_lead'
          AND NOT EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = ra.guild_id AND b.user_id = ra.user_id)
        ORDER BY u.username, u.id`,
    ).bind(guildId),
    // People with a character on the team's roster (worker/team-roster.js: placed, still here, a raiding rank), archived teams too.
    db.prepare(
      `SELECT c.team_id, COUNT(DISTINCT c.player_id) AS n FROM characters c
        WHERE c.guild_id = ? AND ${teamRosterSql('c')} GROUP BY c.team_id`,
    ).bind(guildId),
  ]);
  const counts = new Map(countResult.results.map((row) => [row.team_id, row.n]));
  return teamResult.results.map((team) => teamView(
    team,
    leadResult.results.filter((lead) => lead.team_id === team.id).map(toPerson),
    counts.get(team.id) || 0,
  ));
}

export async function createTeam(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.teams');
  const name = cleanText(ctx.body.name, 'name', { max: MAX_TEAM_NAME });
  const size = ctx.body.size === undefined ? defaultTeamSize(guildContext.guild.game_version) : readSize(ctx.body.size);
  const id = newId('t', ctx.randomBytes);
  const guildId = guildContext.guild.id;
  let results;
  try {
    results = await ctx.db.batch([
      // One guarded INSERT enforces the cap; the audit row follows only if the team exists.
      ctx.db.prepare(
        `INSERT INTO teams (id, guild_id, name, size, archived, created_at)
         SELECT ?, ?, ?, ?, 0, ? WHERE (${ACTIVE_TEAM_COUNT}) < ${MAX_ACTIVE_TEAMS}`,
      ).bind(id, guildId, name, size, ctx.now(), guildId),
      auditStatement(ctx, {
        guildId, actorUserId: ctx.session.user.id, action: 'team.create', entityType: 'team', entityId: id,
      }, { sql: 'EXISTS (SELECT 1 FROM teams WHERE id = ?)', params: [id] }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'team_name_taken', TEAM_NAME_TAKEN, { field: 'name' });
    throw error;
  }
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'team_limit', TEAM_CAP_MESSAGE, { field: 'name' });
  return jsonResponse({ team: teamView({ id, name, size, archived: 0 }) }, 201);
}

export async function patchTeam(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.teams');
  const current = await ctx.db.prepare('SELECT id, name, size, archived, trial_days FROM teams WHERE id = ? AND guild_id = ?')
    .bind(ctx.params.tid, guildContext.guild.id).first();
  if (!current) throw new HttpError(404, 'not_found', 'That team does not exist.');

  const { body } = ctx;
  if (body.name === undefined && body.archived === undefined && body.size === undefined && body.trialDays === undefined) {
    throw new HttpError(400, 'bad_request', 'Send a name, archived, size, trialDays, or any of them.');
  }
  const name = body.name === undefined ? current.name : cleanText(body.name, 'name', { max: MAX_TEAM_NAME });
  if (body.archived !== undefined && typeof body.archived !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'archived must be true or false.');
  }
  const archived = body.archived === undefined ? current.archived : (body.archived ? 1 : 0);
  const size = body.size === undefined ? current.size : readSize(body.size);
  if (body.trialDays !== undefined && (!Number.isInteger(body.trialDays) || body.trialDays < 1 || body.trialDays > 90)) {
    throw new HttpError(400, 'bad_request', TRIAL_DAYS_MESSAGE, { field: 'trialDays' });
  }
  const trialDays = body.trialDays === undefined ? current.trial_days : body.trialDays;

  if (current.archived === 1 && archived === 0) {
    const count = await ctx.db.prepare(ACTIVE_TEAM_COUNT).bind(guildContext.guild.id).first('n');
    if (count >= MAX_ACTIVE_TEAMS) throw new HttpError(409, 'team_limit', TEAM_CAP_MESSAGE, { field: 'name' });
  }

  const audit = (action, before, after) => auditStatement(ctx, {
    guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType: 'team', entityId: current.id, before, after,
  });
  const statements = [];
  if (name !== current.name) statements.push(audit('team.rename'));
  if (archived !== current.archived) statements.push(audit(archived ? 'team.archive' : 'team.restore'));
  if (size !== current.size) statements.push(audit('team.size', { size: current.size }, { size }));
  if (trialDays !== current.trial_days) statements.push(audit('team.trial_days', { trialDays: current.trial_days }, { trialDays }));
  if (statements.length) {
    try {
      await ctx.db.batch([
        ctx.db.prepare('UPDATE teams SET name = ?, archived = ?, size = ?, trial_days = ? WHERE id = ? AND guild_id = ?')
          .bind(name, archived, size, trialDays, current.id, guildContext.guild.id),
        ...statements,
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, 'team_name_taken', TEAM_NAME_TAKEN, { field: 'name' });
      throw error;
    }
  }
  const team = (await loadTeams(ctx.db, guildContext.guild.id)).find((entry) => entry.id === current.id);
  return jsonResponse({ team });
}
