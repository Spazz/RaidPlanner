// Reads of a guild's roles and what each one holds, shared by the people, role editor, Discord mapping and guest link routes.
// A role's permissions are always the EFFECTIVE rows (migration 0014's effective_role_permissions view: the system rows with the guild's edits
// applied, plus its custom roles), never role_permissions directly.
import { HttpError } from './http.js';
import { canGrant } from './permissions.js';

export const MAX_CUSTOM_ROLES = 20;

// The actor may hand out a role (give it to a person, map a Discord role to it) only if it holds nothing they do not hold themselves; the Guild Master
// holds everything. teamId: the team the role is given for (null = the whole guild).
export function assertMayGrant(guildContext, rolesData, roleId, teamId) {
  if (guildContext.isGuildMaster) return;
  for (const permission of rolesData.permissions.get(roleId) || []) {
    if (!canGrant(guildContext.can, permission.action, permission.scope, teamId)) {
      throw new HttpError(403, 'forbidden', 'You cannot give a role that can do more than you can.');
    }
  }
}

// -> { custom: [{ id, name }] (the guild's own roles, by name), permissions: Map(roleId -> [{ action, scope }]), needsTeam(roleId), isCustom(roleId), nameOf(roleId) }
export async function loadRolesData(db, guildId) {
  const [roleResult, permissionResult] = await db.batch([
    db.prepare('SELECT id, name FROM roles WHERE guild_id = ? ORDER BY name COLLATE NOCASE, id').bind(guildId),
    db.prepare('SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ?').bind(guildId),
  ]);
  const permissions = new Map();
  for (const row of permissionResult.results) {
    if (!permissions.has(row.role_id)) permissions.set(row.role_id, []);
    permissions.get(row.role_id).push({ action: row.action, scope: row.scope });
  }
  const custom = roleResult.results.map((row) => ({ id: row.id, name: row.name }));
  return {
    custom,
    permissions,
    // A role that holds a team-scoped permission is given for one team (like Team Lead); the others are given to the whole guild.
    needsTeam: (roleId) => roleId === 'team_lead' || (permissions.get(roleId) || []).some((permission) => permission.scope === 'team'),
    isCustom: (roleId) => custom.some((role) => role.id === roleId),
    nameOf: (roleId) => (custom.find((role) => role.id === roleId) || {}).name || null,
  };
}
