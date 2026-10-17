import { HttpError } from './http.js';

export const ACTIONS = [
  'roster.view', 'roster.edit', 'roster.notes.view', 'roster.notes.edit',
  'raids.view', 'raids.edit', 'attendance.view', 'attendance.review', 'attendance.policy',
  'loot.view', 'loot.edit', 'loot.policy',
  'guild.teams', 'guild.roles', 'guild.access', 'audit.view',
];

// Lower is more senior. Member is implied, never stored.
export const ROLE_RANK = { guild_master: 0, officer: 1, team_lead: 2, member: 3 };

// [{ role, teamId? }] ordered Guild Master, Officer, Team Lead, then by team id.
export function shapeRoles(assignments) {
  return assignments
    .filter((assignment) => assignment.role_id in ROLE_RANK)
    .map((assignment) => (assignment.team_id ? { role: assignment.role_id, teamId: assignment.team_id } : { role: assignment.role_id }))
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || String(a.teamId || '').localeCompare(String(b.teamId || '')));
}

// Pure. assignments: [{ role_id, team_id }]; rolePermissions: [{ role_id, action, scope }].
// -> { roles: [{ role, teamId? }], can: { action: 'guild' | [teamIds] }, rank }
// Every signed-in, unblocked member holds Member. An action that is not allowed is absent from `can`.
// `own_teams` resolves to the team ids of the viewer's own characters (ownTeamIds); it merges with team scope.
export function resolvePermissions(assignments, rolePermissions, ownTeamIds = []) {
  const held = [{ role_id: 'member', team_id: null }, ...assignments];
  const guildWide = new Set();
  const teamScoped = new Map();
  for (const assignment of held) {
    for (const permission of rolePermissions) {
      if (permission.role_id !== assignment.role_id) continue;
      if (permission.scope === 'guild') {
        guildWide.add(permission.action);
        continue;
      }
      if (!teamScoped.has(permission.action)) teamScoped.set(permission.action, new Set());
      if (permission.scope === 'team' && assignment.team_id) teamScoped.get(permission.action).add(assignment.team_id);
      if (permission.scope === 'own_teams') for (const teamId of ownTeamIds) teamScoped.get(permission.action).add(teamId);
    }
  }
  const can = {};
  for (const action of ACTIONS) {
    if (guildWide.has(action)) can[action] = 'guild';
    else if (teamScoped.has(action)) can[action] = [...teamScoped.get(action)].sort();
  }
  const roles = shapeRoles(assignments);
  return { roles, can, rank: roles.length ? ROLE_RANK[roles[0].role] : ROLE_RANK.member };
}

// True when `can` allows the action: guild-wide, or (with a team) that team.
export function allows(can, action, teamId) {
  const scope = can[action];
  if (!scope) return false;
  if (scope === 'guild') return true;
  return teamId !== undefined && scope.includes(teamId);
}

// An action is granted by 'guild', or by a non-empty list of team ids. An empty list grants nothing.
export function isGranted(scope) {
  return scope === 'guild' || (Array.isArray(scope) && scope.length > 0);
}

export function requireAction(guildContext, action) {
  if (!isGranted(guildContext.can[action])) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
}

export function requireAnyAction(guildContext, actions) {
  if (!actions.some((action) => isGranted(guildContext.can[action]))) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  }
}

// One DB.batch loads everything a guild route needs. Order of checks:
// guild exists (404) -> blocked (403 access_removed) -> in the guild's Discord server (403 not_member).
// The guild id always comes from the URL.
export async function loadGuildContext(db, userId, guildId) {
  const [guildResult, blockResult, memberResult, assignmentResult, permissionResult, ownTeamResult] = await db.batch([
    db.prepare(
      `SELECT id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, wcl_guild_id, created_at
         FROM guilds WHERE id = ?`,
    ).bind(guildId),
    db.prepare('SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guildId, userId),
    db.prepare(
      `SELECT 1 AS found FROM user_servers
        WHERE user_id = ? AND server_id = (SELECT discord_server_id FROM guilds WHERE id = ?)`,
    ).bind(userId, guildId),
    db.prepare('SELECT role_id, team_id FROM role_assignments WHERE guild_id = ? AND user_id = ?').bind(guildId, userId),
    db.prepare('SELECT role_id, action, scope FROM role_permissions').bind(),
    // The teams of the characters of the person linked to this user (the Discord ID matches).
    db.prepare(
      `SELECT DISTINCT c.team_id FROM characters c JOIN players p ON p.id = c.player_id
        WHERE p.guild_id = ? AND p.discord_user_id = (SELECT discord_id FROM users WHERE id = ?)`,
    ).bind(guildId, userId),
  ]);
  const guild = guildResult.results[0];
  if (!guild) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  if (blockResult.results.length) {
    throw new HttpError(403, 'access_removed', 'An officer has removed your access to this guild.');
  }
  if (!memberResult.results.length) {
    throw new HttpError(403, 'not_member', 'You are not in this guild\'s Discord server. Sign in again if you just joined.');
  }
  const resolved = resolvePermissions(assignmentResult.results, permissionResult.results, ownTeamResult.results.map((row) => row.team_id));
  return {
    userId,
    guild,
    roles: resolved.roles,
    can: resolved.can,
    rank: resolved.rank,
    isGuildMaster: resolved.rank === ROLE_RANK.guild_master,
  };
}
