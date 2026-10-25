import { HttpError } from './http.js';
import { isId } from './ids.js';
import { blockedSql, inServerSql, membershipOf, ownPlayerSql, rosterLinkSql } from './membership.js';

export const ACTIONS = [
  'roster.view', 'roster.edit', 'roster.notes.view', 'roster.notes.edit',
  'raids.view', 'raids.edit', 'signups.self', 'attendance.view', 'attendance.review', 'attendance.policy',
  'loot.view', 'loot.edit', 'loot.policy',
  'guild.teams', 'guild.roles', 'guild.access', 'audit.view',
];

// What the role editor may do with each action. scopes: the scopes a role can give it (only the ones the routes honour: an action whose routes do
// not check the team lists 'guild' alone). view: a read action, the only kind a guest link or the public page can ever carry. staff: only the
// Officer role (and the fixed Guild Master) may hold it, never Member, Guest, Public, Team Lead or a custom role.
const info = (label, group, scopes, flags = {}) => ({ label, group, scopes, view: false, staff: false, ...flags });
export const ACTION_INFO = {
  'roster.view': info('See the roster', 'Roster', ['guild'], { view: true }),
  'roster.edit': info('Edit the roster', 'Roster', ['guild', 'team']),
  'roster.notes.view': info('Read officer notes', 'Roster', ['guild', 'team']),
  'roster.notes.edit': info('Write officer notes', 'Roster', ['guild', 'team']),
  'raids.view': info('See raids', 'Raids', ['guild'], { view: true }),
  'raids.edit': info('Create and edit raids', 'Raids', ['guild', 'team']),
  'signups.self': info('Sign themselves up for raids', 'Raids', ['guild', 'team', 'own_teams']),
  'attendance.view': info('See attendance', 'Attendance', ['guild', 'team', 'own_teams'], { view: true }),
  'attendance.review': info('Review attendance', 'Attendance', ['guild', 'team']),
  'attendance.policy': info('Change the attendance rules', 'Attendance', ['guild']),
  'loot.view': info('See loot', 'Loot', ['guild', 'team', 'own_teams'], { view: true }),
  'loot.edit': info('Import and edit loot', 'Loot', ['guild', 'team']),
  'loot.policy': info('Change the loot rules', 'Loot', ['guild']),
  'guild.teams': info('Manage teams', 'Guild settings', ['guild']),
  'guild.roles': info('Manage roles, Discord mapping and the public page', 'Guild settings', ['guild'], { staff: true }),
  'guild.access': info('Remove access, sync Discord roles, guest links', 'Guild settings', ['guild'], { staff: true }),
  'audit.view': info('See the activity log', 'Guild settings', ['guild'], { staff: true }),
};

// Lower is more senior. Member is implied, never stored. A custom role ranks as Member: holding one never moves a person up the hierarchy.
export const ROLE_RANK = { guild_master: 0, officer: 1, team_lead: 2, member: 3 };

// The built-in roles. Member, Guest and Public are held without being assigned to anyone (Member by everyone, Guest by a guest link, Public by the
// public page); Guild Master is fixed.
export const BUILTIN_ROLES = ['guild_master', 'officer', 'team_lead', 'member', 'guest', 'public'];
export const VIEWER_ROLES = ['guest', 'public'];
export const EVERYONE_ROLES = ['member', 'guest', 'public'];

// The four sections a guest link or the public page can show, and the read action each one needs.
export const SECTION_ACTIONS = { roster: 'roster.view', raids: 'raids.view', attendance: 'attendance.view', loot: 'loot.view' };

export const isCustomRole = (roleId) => isId('cr', roleId);

// Why this (action, scope) may not be given to this role, or null. `custom`: the role is one of the guild's own.
export function permissionProblem(roleId, custom, action, scope) {
  const spec = Object.prototype.hasOwnProperty.call(ACTION_INFO, action) ? ACTION_INFO[action] : null;
  if (!spec) return `${action} is not an action.`;
  if (!spec.scopes.includes(scope)) return `${spec.label} cannot be given at the "${scope}" scope.`;
  if (spec.staff && (custom || roleId === 'team_lead' || EVERYONE_ROLES.includes(roleId))) return `${spec.label} is for the Officer role only.`;
  if (VIEWER_ROLES.includes(roleId) && !spec.view) return `${roleId === 'guest' ? 'Guest' : 'Public'} can only read: "${spec.label}" is not allowed.`;
  if (roleId === 'public' && scope !== 'guild') return 'The public page is not tied to a team: use the whole-guild scope.';
  if (roleId === 'guest' && scope === 'own_teams') return 'A guest has no characters: use the team or whole-guild scope.';
  // Officer and Member are held without a team: a team-scoped permission would grant nothing to a person who holds them.
  if ((roleId === 'officer' || roleId === 'member') && scope === 'team') return 'This role is held without a team: use the whole-guild scope.';
  return null;
}

// [{ role, name?, teamId?, fromDiscord? }]: built-in roles first (Guild Master, Officer, Team Lead, by team id), then the guild's own roles by name.
// One entry per role and team: a role a person holds both by hand and from Discord shows once, as theirs (manual wins); fromDiscord marks a role that
// only Discord gives. assignments: [{ role_id, team_id, source?, role_name? }]. Guest and Public are never listed.
export function shapeRoles(assignments) {
  const merged = new Map();
  for (const assignment of assignments) {
    const builtin = Object.prototype.hasOwnProperty.call(ROLE_RANK, assignment.role_id);
    if (!builtin && !isCustomRole(assignment.role_id)) continue;
    const key = `${assignment.role_id}|${assignment.team_id || ''}`;
    const entry = merged.get(key) || { role: assignment.role_id, builtin, name: assignment.role_name, teamId: assignment.team_id || null, manual: false };
    if (assignment.source !== 'discord') entry.manual = true;
    merged.set(key, entry);
  }
  return [...merged.values()]
    .sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      const byRank = a.builtin ? ROLE_RANK[a.role] - ROLE_RANK[b.role] : String(a.name || '').localeCompare(String(b.name || '')) || a.role.localeCompare(b.role);
      return byRank || String(a.teamId || '').localeCompare(String(b.teamId || ''));
    })
    .map((entry) => ({
      role: entry.role,
      ...(entry.builtin ? {} : { name: entry.name || 'Custom role' }),
      ...(entry.teamId ? { teamId: entry.teamId } : {}),
      ...(entry.manual ? {} : { fromDiscord: true }),
    }));
}

// The hierarchy rank of a set of assignments: the best built-in role; custom roles do not count (a person with none is a plain Member).
export function rankOf(assignments) {
  let best = ROLE_RANK.member;
  for (const assignment of assignments) {
    if (Object.prototype.hasOwnProperty.call(ROLE_RANK, assignment.role_id) && ROLE_RANK[assignment.role_id] < best) best = ROLE_RANK[assignment.role_id];
  }
  return best;
}

// Pure. assignments: [{ role_id, team_id, source?, role_name? }]; rolePermissions: [{ role_id, action, scope }] (the guild's EFFECTIVE rows: loadGuildContext
// reads them from the effective_role_permissions view, which already applies a guild's edits to the built-in roles and adds its custom roles).
// -> { roles: [{ role, name?, teamId?, fromDiscord? }], can: { action: 'guild' | [teamIds] }, rank }
// Every signed-in, unblocked member holds Member. An action that is not allowed is absent from `can`. A row whose scope the action does not
// take (see ACTION_INFO) grants nothing, whatever the table says.
// `own_teams` resolves to the team ids of the viewer's own characters (ownTeamIds); it merges with team scope.
export function resolvePermissions(assignments, rolePermissions, ownTeamIds = []) {
  const held = [{ role_id: 'member', team_id: null }, ...assignments.filter((assignment) => !VIEWER_ROLES.includes(assignment.role_id))];
  const guildWide = new Set();
  const teamScoped = new Map();
  for (const assignment of held) {
    for (const permission of rolePermissions) {
      if (permission.role_id !== assignment.role_id) continue;
      const spec = Object.prototype.hasOwnProperty.call(ACTION_INFO, permission.action) ? ACTION_INFO[permission.action] : null;
      if (!spec || !spec.scopes.includes(permission.scope)) continue;
      if (permission.scope === 'guild') {
        guildWide.add(permission.action);
        continue;
      }
      if (!teamScoped.has(permission.action)) teamScoped.set(permission.action, new Set());
      if (permission.scope === 'team' && assignment.team_id) teamScoped.get(permission.action).add(assignment.team_id);
      if (permission.scope === 'own_teams') for (const teamId of ownTeamIds) if (teamId) teamScoped.get(permission.action).add(teamId);
    }
  }
  const can = {};
  for (const action of ACTIONS) {
    if (guildWide.has(action)) can[action] = 'guild';
    else if (teamScoped.has(action)) can[action] = [...teamScoped.get(action)].sort();
  }
  return { roles: shapeRoles(assignments), can, rank: rankOf(assignments) };
}

// Pure. What someone holding ONE role and no account may do: a guest link (roleId = the link's role) or the public page ('public'). The same rows
// and scopes as everyone else, then confined: only the read actions (view) survive, a link for one team narrows every grant to that team, and a
// link for the whole guild gives a team-scoped grant every active team. -> { action: 'guild' | [teamIds] }, never an empty list.
export function resolveViewerPermissions(rolePermissions, roleId, { teamId = null, activeTeamIds = [] } = {}) {
  const everyTeam = [...activeTeamIds].sort();
  const can = {};
  for (const permission of rolePermissions) {
    if (permission.role_id !== roleId) continue;
    const spec = Object.prototype.hasOwnProperty.call(ACTION_INFO, permission.action) ? ACTION_INFO[permission.action] : null;
    // A guest or the public has no characters, so "their own teams" reaches nothing.
    if (!spec || !spec.view || !spec.scopes.includes(permission.scope) || permission.scope === 'own_teams') continue;
    let reach;
    if (teamId) reach = everyTeam.includes(teamId) ? [teamId] : [];
    else reach = permission.scope === 'guild' ? 'guild' : everyTeam;
    if (reach === 'guild' || reach.length) can[permission.action] = reach;
  }
  return can;
}

// Pure. What a read-only API key may read (PM wave 7): what the built-in Member role holds of the read actions, for the key's one team or (teamId null)
// every active team. The same rows as everyone else (the guild's edits to Member apply), then confined like a viewer: read actions only. A Member
// grant on "their own teams" reaches the key's teams, since the key stands in for a member of that scope. -> { action: 'guild' | [teamIds] }.
export function resolveKeyPermissions(rolePermissions, { teamId = null, activeTeamIds = [] } = {}) {
  const everyTeam = [...activeTeamIds].sort();
  const reachTeams = teamId ? (everyTeam.includes(teamId) ? [teamId] : []) : everyTeam;
  const can = {};
  for (const permission of rolePermissions) {
    if (permission.role_id !== 'member') continue;
    const spec = Object.prototype.hasOwnProperty.call(ACTION_INFO, permission.action) ? ACTION_INFO[permission.action] : null;
    if (!spec || !spec.view || !spec.scopes.includes(permission.scope)) continue;
    const reach = permission.scope === 'guild' && !teamId ? 'guild' : reachTeams;
    if (reach === 'guild' || reach.length) can[permission.action] = reach;
  }
  return can;
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

// Whether a person whose `can` is given may hand out this (action, scope, team): never more than they hold themselves.
export function canGrant(can, action, scope, teamId = null) {
  const held = can[action];
  if (held === 'guild') return true;
  if (!isGranted(held)) return false;
  if (scope === 'guild') return false;
  if (scope === 'team') return !!teamId && held.includes(teamId);
  return true;
}

export function requireAction(guildContext, action) {
  if (!isGranted(guildContext.can[action])) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
}

export function requireAnyAction(guildContext, actions) {
  if (!actions.some((action) => isGranted(guildContext.can[action]))) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  }
}

// The guild's effective permission rows (system rows with the guild's edits applied, plus its custom roles): the ONE source for any code that
// asks what a role may do in a guild. See migration 0014 (the effective_role_permissions view).
export const effectivePermissionsStatement = (db, guildId) =>
  db.prepare('SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ?').bind(guildId);

// One DB.batch loads everything a guild route needs. Order of checks:
// guild exists (404) -> blocked (403 access_removed) -> a member: in the guild's Discord server or linked to one of its people (403 not_member).
// The membership rule is worker/membership.js's. The guild id always comes from the URL.
// viewAs (dev only, from session.viewAs; see worker/view-as.js): { guildId, roleId, teamId } or null. Honoured ONLY for this guild and ONLY when the
// person's real rank is Guild Master; then can / roles / rank / isGuildMaster are those of ONE stand-in assignment (a stale role or team: real rights).
// Route code passes `session.viewAs` as the 4th argument on every call made for the signed-in user (a test pins it); system lookups for another user omit it.
export async function loadGuildContext(db, userId, guildId, viewAs = null) {
  const [guildResult, standingResult, assignmentResult, permissionResult, ownTeamResult] = await db.batch([
    db.prepare(
      `SELECT id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, wcl_guild_id, created_at
         FROM guilds WHERE id = ?`,
    ).bind(guildId),
    db.prepare(
      `SELECT ${blockedSql('c.uid', 'g.id')} AS blocked, ${inServerSql('c.uid', 'g.discord_server_id')} AS in_server,
              ${rosterLinkSql('c.uid', 'g.id')} AS linked
         FROM (SELECT ? AS uid) c, guilds g WHERE g.id = ?`,
    ).bind(userId, guildId),
    db.prepare(
      `SELECT ra.role_id, ra.team_id, ra.source, r.name AS role_name
         FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
        WHERE ra.guild_id = ? AND ra.user_id = ?`,
    ).bind(guildId, userId),
    effectivePermissionsStatement(db, guildId),
    // The teams of the characters of the person who is this user's (linked to the account, or matching its Discord ID). A teamless character
    // (team_id NULL) is on no team and grants no team scope.
    db.prepare(
      `SELECT DISTINCT c.team_id FROM characters c JOIN players p ON p.id = c.player_id
        WHERE p.guild_id = ? AND c.team_id IS NOT NULL AND ${ownPlayerSql('p', '?')}`,
    ).bind(guildId, userId, userId),
  ]);
  const guild = guildResult.results[0];
  if (!guild) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  const standing = standingResult.results[0];
  const membership = membershipOf({ blocked: standing.blocked === 1, inServer: standing.in_server === 1, linked: standing.linked === 1 });
  if (membership === 'blocked') {
    throw new HttpError(403, 'access_removed', 'An officer has removed your access to this guild.');
  }
  if (membership !== 'member') {
    throw new HttpError(403, 'not_member', "You are not in this guild's Discord server, and no roster entry is linked to your account. Sign in again if you just joined the server, or ask an officer to link your account to your roster entry.");
  }
  const ownTeamIds = ownTeamResult.results.map((row) => row.team_id).filter((teamId) => teamId !== null);
  const resolved = resolvePermissions(assignmentResult.results, permissionResult.results, ownTeamIds);
  const real = {
    userId,
    guild,
    roles: resolved.roles,
    can: resolved.can,
    rank: resolved.rank,
    isGuildMaster: resolved.rank === ROLE_RANK.guild_master,
  };
  if (!viewAs || viewAs.guildId !== guildId || !real.isGuildMaster) return real;
  const standIn = await standInFor(db, guildId, viewAs);
  if (!standIn) return real;
  const viewed = resolvePermissions(standIn.assignments, permissionResult.results, ownTeamIds);
  return {
    ...real,
    roles: viewed.roles,
    can: viewed.can,
    rank: viewed.rank,
    isGuildMaster: viewed.rank === ROLE_RANK.guild_master,
    realRank: real.rank,
    viewAs: { roleId: viewAs.roleId, roleName: standIn.roleName, teamId: standIn.teamId, teamName: standIn.teamName },
  };
}

const VIEW_AS_NAMES = { officer: 'Officer', team_lead: 'Team Lead', member: 'Member' };

// The ONE assignment a viewed role stands for, with the names the dev bar shows; null when the role or team no longer exists in this guild (stale cookie).
// Member is held by everyone, so it stands for no assignment at all.
async function standInFor(db, guildId, { roleId, teamId }) {
  const builtin = Object.prototype.hasOwnProperty.call(VIEW_AS_NAMES, roleId);
  if (!builtin && !isCustomRole(roleId)) return null;
  let roleName = VIEW_AS_NAMES[roleId];
  if (!builtin) {
    const role = await db.prepare('SELECT name FROM roles WHERE id = ? AND guild_id = ?').bind(roleId, guildId).first();
    if (!role) return null;
    roleName = role.name;
  }
  let teamName = null;
  if (teamId) {
    const team = await db.prepare('SELECT name FROM teams WHERE id = ? AND guild_id = ? AND archived = 0').bind(teamId, guildId).first();
    if (!team) return null;
    teamName = team.name;
  }
  if (roleId === 'team_lead' && !teamId) return null;
  // Officer and Member are held without a team.
  const scopedTeam = roleId === 'officer' || roleId === 'member' ? null : teamId || null;
  return {
    roleName,
    teamId: scopedTeam,
    teamName: scopedTeam ? teamName : null,
    assignments: roleId === 'member' ? [] : [{ role_id: roleId, team_id: scopedTeam, source: 'manual', role_name: roleName }],
  };
}
