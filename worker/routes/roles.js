// The role editor (Guild settings > Roles). A role is a bundle of (action, scope) pairs over the actions in worker/permissions.js.
//   - The guild's own roles ("custom": Loot council, Raid leader...) are made, renamed, edited and deleted here. They live in `roles` with the guild's id.
//   - The built-in roles can be edited per guild (Officer, Team Lead, Member, Guest, Public) and reset to their defaults: the edit is a row set in
//     role_overrides / role_override_permissions that replaces the system rows for this guild only. The Guild Master role is fixed: it always holds
//     every action, so there is always someone who can manage roles (the last-Guild-Master guard).
//   - Every permission is checked against the rules in permissions.js (permissionProblem): scopes the routes honour, staff-only actions, read-only
//     Guest and Public. Only a Guild Master edits the built-in roles; someone the Guild Master gave `guild.roles` manages custom roles, and only
//     with permissions they hold themselves (no handing out more than you have).
//   - All routes need guild.roles. Every change answers with the full role list.
import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import {
  ACTIONS, ACTION_INFO, BUILTIN_ROLES, EVERYONE_ROLES, VIEWER_ROLES, isCustomRole, isGranted, loadGuildContext, permissionProblem, requireAction,
} from '../permissions.js';
import { MAX_CUSTOM_ROLES } from '../roles-store.js';

const MAX_NAME = 32;
const BUILTIN_NAMES = { guild_master: 'Guild Master', officer: 'Officer', team_lead: 'Team Lead', member: 'Member', guest: 'Guest', public: 'Public' };
const BUILTIN_NOTES = {
  guild_master: 'Always holds every action. This role cannot be changed.',
  officer: 'Assigned by the Guild Master. Runs the guild day to day.',
  team_lead: 'Given for one team. Team scope means that team.',
  member: 'Everyone in the guild holds Member. Its own-teams scope means the teams they have a character on.',
  guest: 'What a guest link grants unless you pick another role. Read-only: a guest link never writes.',
  public: 'The most the public page can show. Turn the page on in Public page.',
};

const bad = (message, field) => new HttpError(400, 'bad_request', message, field ? { field } : {});

// ---------------------------------------------------------------------------
// The answer: the action catalogue, then every role with what it holds.

function allowedScopes(roleId, custom) {
  return Object.fromEntries(ACTIONS.map((action) => [action, ACTION_INFO[action].scopes.filter((scope) => permissionProblem(roleId, custom, action, scope) === null)]));
}

export async function rolesPayload(db, guildContext, nowMs) {
  const guildId = guildContext.guild.id;
  const [customResult, permissionResult, overrideResult, holderResult, mapResult, linkResult] = await db.batch([
    db.prepare('SELECT id, name FROM roles WHERE guild_id = ? ORDER BY name COLLATE NOCASE, id').bind(guildId),
    db.prepare('SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ?').bind(guildId),
    db.prepare('SELECT role_id FROM role_overrides WHERE guild_id = ?').bind(guildId),
    db.prepare('SELECT role_id, COUNT(DISTINCT user_id) AS n FROM effective_roles WHERE guild_id = ? GROUP BY role_id').bind(guildId),
    db.prepare('SELECT role_id, COUNT(*) AS n FROM discord_role_maps WHERE guild_id = ? GROUP BY role_id').bind(guildId),
    db.prepare(
      `SELECT role_id, COUNT(*) AS n FROM guest_links
        WHERE guild_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY role_id`,
    ).bind(guildId, nowMs),
  ]);
  const permissions = new Map();
  for (const row of permissionResult.results) {
    if (!permissions.has(row.role_id)) permissions.set(row.role_id, {});
    permissions.get(row.role_id)[row.action] = row.scope;
  }
  const customized = new Set(overrideResult.results.map((row) => row.role_id));
  const count = (result, roleId) => (result.results.find((row) => row.role_id === roleId) || { n: 0 }).n;
  const entry = (id, name, custom) => {
    const held = permissions.get(id) || {};
    return {
      id,
      name,
      kind: custom ? 'custom' : 'builtin',
      fixed: id === 'guild_master',
      customized: customized.has(id),
      assignable: custom || id === 'officer' || id === 'team_lead',
      note: custom ? null : BUILTIN_NOTES[id],
      needsTeam: id === 'team_lead' || Object.values(held).includes('team'),
      permissions: held,
      allowed: id === 'guild_master' ? {} : allowedScopes(id, custom),
      holders: count(holderResult, id),
      mapped: count(mapResult, id),
      links: count(linkResult, id),
    };
  };
  return {
    actions: ACTIONS.map((action) => ({ action, ...ACTION_INFO[action] })),
    roles: [
      ...BUILTIN_ROLES.map((id) => entry(id, BUILTIN_NAMES[id], false)),
      ...customResult.results.map((row) => entry(row.id, row.name, true)),
    ],
    limits: { customRoles: MAX_CUSTOM_ROLES, nameLength: MAX_NAME },
    canEditBuiltin: guildContext.isGuildMaster,
  };
}

const reply = async (ctx, guildContext, status = 200) => jsonResponse(await rolesPayload(ctx.db, guildContext, ctx.now()), status);

// ---------------------------------------------------------------------------
// Reading what the request asks for

// { "loot.edit": "guild", ... } -> [[action, scope]] checked against the rules for this role. An unknown action, a scope the action does not take
// and every other rule in permissionProblem are a 400.
function readPermissions(value, roleId, custom) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('permissions must be an object of action: scope.', 'permissions');
  const entries = Object.entries(value);
  if (entries.length > ACTIONS.length) throw bad('Too many permissions.', 'permissions');
  return entries.map(([action, scope]) => {
    if (typeof scope !== 'string') throw bad(`Pick a scope for ${action}.`, 'permissions');
    const problem = permissionProblem(roleId, custom, action, scope);
    if (problem) throw bad(problem, 'permissions');
    return [action, scope];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}

// Invisible and direction-changing characters (zero-width, bidi marks) let a name look like another, so a name has none; and a built-in name is
// compared after Unicode compatibility folding (a full-width "Officer" is still Officer).
const FORMAT_CHARS = /[\p{Cf}\p{Zl}\p{Zp}]/u;

function readName(value) {
  const name = cleanText(value, 'name', { max: MAX_NAME });
  if (FORMAT_CHARS.test(name)) throw bad('Use plain letters, numbers and spaces in the name.', 'name');
  const folded = name.normalize('NFKC').toLowerCase();
  if (Object.values(BUILTIN_NAMES).some((builtin) => builtin.toLowerCase() === folded)) {
    throw new HttpError(409, 'role_name_taken', 'That name belongs to a built-in role.', { field: 'name' });
  }
  return name;
}

// Whether the editor may hand out this pair: never more than they hold (a team scope needs the action at any scope; guild scope needs it guild-wide).
function mayHandOut(guildContext, action, scope) {
  if (guildContext.isGuildMaster) return true;
  const held = guildContext.can[action];
  return scope === 'guild' ? held === 'guild' : isGranted(held);
}

function assertMayHandOut(guildContext, pairs) {
  if (pairs.some(([action, scope]) => !mayHandOut(guildContext, action, scope))) {
    throw new HttpError(403, 'forbidden', 'You cannot give a role more than you can do yourself.');
  }
}

const asMap = (pairs) => Object.fromEntries(pairs);
const nameTaken = () => new HttpError(409, 'role_name_taken', 'Another role in this guild already has that name.', { field: 'name' });

async function currentPermissions(db, guildId, roleId) {
  const result = await db.prepare('SELECT action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = ?').bind(guildId, roleId).all();
  return result.results.map((row) => [row.action, row.scope]).sort((a, b) => a[0].localeCompare(b[0]));
}

// The guild's own role with this id, or a 404 (another guild's role, a built-in id, or nothing).
async function findCustomRole(db, guildId, roleId) {
  const role = isCustomRole(roleId)
    ? await db.prepare('SELECT id, name FROM roles WHERE id = ? AND guild_id = ?').bind(roleId, guildId).first()
    : null;
  if (!role) throw new HttpError(404, 'not_found', 'That role does not exist.');
  return role;
}

// ---------------------------------------------------------------------------
// Handlers

export async function getRoles(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  return reply(ctx, guildContext);
}

export async function createRole(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const name = readName(ctx.body.name);
  const pairs = readPermissions(ctx.body.permissions, null, true);
  assertMayHandOut(guildContext, pairs);
  const guildId = guildContext.guild.id;
  const id = newId('cr', ctx.randomBytes);
  const created = { sql: 'EXISTS (SELECT 1 FROM roles WHERE id = ? AND guild_id = ?)', params: [id, guildId] };
  let results;
  try {
    results = await ctx.db.batch([
      // One guarded INSERT enforces the cap; everything after it follows only if the role exists.
      ctx.db.prepare(
        'INSERT INTO roles (id, guild_id, name, rank) SELECT ?, ?, ?, 3 WHERE (SELECT COUNT(*) FROM roles WHERE guild_id = ?) < ?',
      ).bind(id, guildId, name, guildId, MAX_CUSTOM_ROLES),
      ctx.db.prepare(
        `INSERT INTO role_permissions (role_id, action, scope)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE ${created.sql}`,
      ).bind(id, JSON.stringify(pairs), ...created.params),
      auditStatement(ctx, {
        guildId, actorUserId: guildContext.userId, action: 'role.create', entityType: 'role', entityId: id, after: { name, permissions: asMap(pairs) },
      }, created),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken();
    throw error;
  }
  if (results[0].meta.changes !== 1) throw bad(`A guild can have at most ${MAX_CUSTOM_ROLES} roles of its own. Delete one first.`, 'name');
  return reply(ctx, guildContext, 201);
}

export async function updateRole(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const guildId = guildContext.guild.id;
  const roleId = ctx.params.rolid;
  if (roleId === 'guild_master') throw new HttpError(400, 'fixed_role', 'The Guild Master role always holds every action and cannot be changed.');
  const builtin = BUILTIN_ROLES.includes(roleId);
  if (builtin && !guildContext.isGuildMaster) throw new HttpError(403, 'forbidden', 'Only the Guild Master can change the built-in roles.');
  const custom = builtin ? null : await findCustomRole(ctx.db, guildId, roleId);
  const pairs = readPermissions(ctx.body.permissions, roleId, !builtin);
  let name = custom ? custom.name : BUILTIN_NAMES[roleId];
  if (ctx.body.name !== undefined) {
    if (builtin) {
      if (ctx.body.name !== BUILTIN_NAMES[roleId]) throw bad('A built-in role keeps its name.', 'name');
    } else {
      name = readName(ctx.body.name);
    }
  }

  const before = await currentPermissions(ctx.db, guildId, roleId);
  const beforeMap = asMap(before);
  // Nothing changed: nothing to write (and nothing for the audit log).
  if (JSON.stringify(before) === JSON.stringify(pairs) && name === (custom ? custom.name : BUILTIN_NAMES[roleId])) return reply(ctx, guildContext);
  // An editor who is not the Guild Master may only add or widen what they hold, and may only touch a role that holds nothing beyond them.
  assertMayHandOut(guildContext, pairs.filter(([action, scope]) => beforeMap[action] !== scope));
  if (!guildContext.isGuildMaster) assertMayHandOut(guildContext, before);
  // A role given for one team (it holds a team-scoped permission) cannot switch to guild-wide, or back, while people hold it or Discord roles map to it.
  if (!builtin) {
    const needs = (list) => list.some(([, scope]) => scope === 'team');
    if (needs(before) !== needs(pairs)) {
      const inUse = await ctx.db.prepare(
        `SELECT (SELECT COUNT(*) FROM effective_roles WHERE guild_id = ?1 AND role_id = ?2) + (SELECT COUNT(*) FROM discord_role_maps WHERE guild_id = ?1 AND role_id = ?2) AS n`,
      ).bind(guildId, roleId).first('n');
      if (inUse > 0) {
        throw new HttpError(409, 'role_in_use', 'People hold this role, or Discord roles map to it. Remove it from them first, then change whether it is given for one team.');
      }
    }
  }

  const statements = [];
  const still = custom
    ? { sql: 'EXISTS (SELECT 1 FROM roles WHERE id = ? AND guild_id = ?)', params: [roleId, guildId] }
    : { sql: 'EXISTS (SELECT 1 FROM guilds WHERE id = ?)', params: [guildId] };
  if (custom) {
    statements.push(
      ctx.db.prepare('UPDATE roles SET name = ? WHERE id = ? AND guild_id = ?').bind(name, roleId, guildId),
      ctx.db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND EXISTS (SELECT 1 FROM roles WHERE id = ? AND guild_id = ?)').bind(roleId, roleId, guildId),
      ctx.db.prepare(
        `INSERT INTO role_permissions (role_id, action, scope)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE ${still.sql}`,
      ).bind(roleId, JSON.stringify(pairs), ...still.params),
    );
  } else {
    statements.push(
      ctx.db.prepare('INSERT OR IGNORE INTO role_overrides (guild_id, role_id) VALUES (?, ?)').bind(guildId, roleId),
      ctx.db.prepare('DELETE FROM role_override_permissions WHERE guild_id = ? AND role_id = ?').bind(guildId, roleId),
      ctx.db.prepare(
        `INSERT INTO role_override_permissions (guild_id, role_id, action, scope)
         SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`,
      ).bind(guildId, roleId, JSON.stringify(pairs)),
    );
  }
  statements.push(auditStatement(ctx, {
    guildId, actorUserId: guildContext.userId, action: 'role.update', entityType: 'role', entityId: roleId,
    before: { name: custom ? custom.name : BUILTIN_NAMES[roleId], permissions: beforeMap }, after: { name, permissions: asMap(pairs) },
  }, still));
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken();
    throw error;
  }
  return reply(ctx, guildContext);
}

// A built-in role goes back to the system defaults.
export async function resetRole(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const guildId = guildContext.guild.id;
  const roleId = ctx.params.rolid;
  if (roleId === 'guild_master') throw new HttpError(400, 'fixed_role', 'The Guild Master role always holds every action and cannot be changed.');
  if (!BUILTIN_ROLES.includes(roleId)) throw new HttpError(400, 'bad_request', 'Only a built-in role can be reset to its defaults.');
  if (!guildContext.isGuildMaster) throw new HttpError(403, 'forbidden', 'Only the Guild Master can change the built-in roles.');
  const before = await currentPermissions(ctx.db, guildId, roleId);
  await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'role.reset', entityType: 'role', entityId: roleId, before: { permissions: asMap(before) },
    }),
    ctx.db.prepare('DELETE FROM role_overrides WHERE guild_id = ? AND role_id = ?').bind(guildId, roleId),
  ]);
  return reply(ctx, guildContext);
}

// Deleting a custom role takes it from everyone who holds it and removes the Discord mappings and guest links that used it.
export async function deleteRole(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const guildId = guildContext.guild.id;
  const roleId = ctx.params.rolid;
  if (roleId === 'guild_master') throw new HttpError(400, 'fixed_role', 'The Guild Master role always holds every action and cannot be changed.');
  if (BUILTIN_ROLES.includes(roleId)) throw new HttpError(400, 'builtin_role', 'A built-in role cannot be deleted.');
  const role = await findCustomRole(ctx.db, guildId, roleId);
  const permissions = await currentPermissions(ctx.db, guildId, roleId);
  if (!guildContext.isGuildMaster) assertMayHandOut(guildContext, permissions);
  const counts = await ctx.db.prepare(
    `SELECT (SELECT COUNT(DISTINCT user_id) FROM effective_roles WHERE guild_id = ?1 AND role_id = ?2) AS holders,
            (SELECT COUNT(*) FROM discord_role_maps WHERE guild_id = ?1 AND role_id = ?2) AS mapped,
            (SELECT COUNT(*) FROM guest_links WHERE guild_id = ?1 AND role_id = ?2) AS links`,
  ).bind(guildId, roleId).first();
  const here = { sql: 'EXISTS (SELECT 1 FROM roles WHERE id = ? AND guild_id = ?)', params: [roleId, guildId] };
  await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'role.delete', entityType: 'role', entityId: roleId,
      before: { name: role.name, permissions: asMap(permissions) }, after: { holders: counts.holders, mapped: counts.mapped, links: counts.links },
    }, here),
    ctx.db.prepare(`DELETE FROM role_assignments WHERE guild_id = ? AND role_id = ? AND ${here.sql}`).bind(guildId, roleId, ...here.params),
    // The role's rows in role_permissions, discord_role_maps, guest_links and role_overrides go with it (ON DELETE CASCADE).
    ctx.db.prepare('DELETE FROM roles WHERE id = ? AND guild_id = ?').bind(roleId, guildId),
  ]);
  return reply(ctx, guildContext);
}

export { EVERYONE_ROLES, VIEWER_ROLES };
