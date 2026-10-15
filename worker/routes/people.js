import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { ROLE_RANK, loadGuildContext, requireAction, requireAnyAction, shapeRoles } from '../permissions.js';
import { toPerson } from '../person.js';

const MAX_TEAM_LEAD_TEAMS = 20;
const TEAM_ID = /^t_[A-Za-z0-9_-]{22}$/;
const MAX_REASON = 200;

// ---------------------------------------------------------------------------
// The people model: everyone who is in the guild's Discord server, holds a role, or is blocked.

async function loadModel(db, guildContext) {
  const guildId = guildContext.guild.id;
  const serverId = guildContext.guild.discord_server_id;
  const [userResult, assignmentResult, blockResult] = await db.batch([
    db.prepare(
      `SELECT u.id, u.discord_id, u.username, u.global_name, u.avatar, u.last_seen_at,
              EXISTS (SELECT 1 FROM user_servers us WHERE us.user_id = u.id AND us.server_id = ?) AS is_member
         FROM users u
        WHERE u.id IN (
          SELECT user_id FROM user_servers WHERE server_id = ?
          UNION SELECT user_id FROM role_assignments WHERE guild_id = ?
          UNION SELECT user_id FROM guild_blocks WHERE guild_id = ?
          UNION SELECT blocked_by FROM guild_blocks WHERE guild_id = ? AND blocked_by IS NOT NULL)`,
    ).bind(serverId, serverId, guildId, guildId, guildId),
    db.prepare('SELECT user_id, role_id, team_id FROM role_assignments WHERE guild_id = ?').bind(guildId),
    db.prepare('SELECT user_id, blocked_by, reason, created_at FROM guild_blocks WHERE guild_id = ?').bind(guildId),
  ]);

  const byId = new Map();
  for (const row of userResult.results) {
    byId.set(row.id, { id: row.id, row, person: toPerson(row), isMember: row.is_member === 1, assignments: [], block: null });
  }
  for (const assignment of assignmentResult.results) {
    const entry = byId.get(assignment.user_id);
    if (entry) entry.assignments.push(assignment);
  }
  for (const block of blockResult.results) {
    const entry = byId.get(block.user_id);
    if (entry) entry.block = block;
  }
  for (const entry of byId.values()) {
    entry.roles = shapeRoles(entry.assignments);
    entry.rank = entry.roles.length ? ROLE_RANK[entry.roles[0].role] : ROLE_RANK.member;
  }
  return { byId };
}

// Never yourself, never the Guild Master; strictly junior to the viewer (an Officer cannot act on an Officer).
function hierarchyAllows(guildContext, entry) {
  if (entry.id === guildContext.userId) return false;
  if (entry.rank === ROLE_RANK.guild_master) return false;
  return guildContext.rank < entry.rank;
}

function actionsFor(guildContext, entry) {
  const canAccess = guildContext.can['guild.access'] === 'guild';
  const canRoles = guildContext.can['guild.roles'] === 'guild';
  if (entry.block) return { restoreAccess: canAccess && hierarchyAllows(guildContext, entry) };
  const editable = canRoles && entry.isMember && entry.id !== guildContext.userId && entry.rank !== ROLE_RANK.guild_master;
  return {
    editRoles: editable,
    makeGuildMaster: editable && guildContext.isGuildMaster,
    removeAccess: canAccess && hierarchyAllows(guildContext, entry),
  };
}

function byRankThenName(a, b) {
  return a.rank - b.rank
    || a.person.displayName.toLowerCase().localeCompare(b.person.displayName.toLowerCase())
    || a.id.localeCompare(b.id);
}

function peopleResponse(model, guildContext) {
  const entries = [...model.byId.values()];
  const people = entries
    .filter((entry) => !entry.block && (entry.isMember || entry.roles.length))
    .sort(byRankThenName)
    .map((entry) => ({
      person: entry.person,
      roles: entry.roles,
      roster: null,
      lastSeenAt: entry.row.last_seen_at,
      isMe: entry.id === guildContext.userId,
      actions: actionsFor(guildContext, entry),
    }));
  const removed = entries
    .filter((entry) => entry.block)
    .sort((a, b) => b.block.created_at - a.block.created_at || a.id.localeCompare(b.id))
    .map((entry) => {
      const remover = entry.block.blocked_by ? model.byId.get(entry.block.blocked_by) : null;
      return {
        person: entry.person,
        roles: entry.roles,
        removedBy: remover ? remover.person : null,
        removedAt: entry.block.created_at,
        reason: entry.block.reason ?? null,
        actions: actionsFor(guildContext, entry),
      };
    });
  return { signedInCount: people.length, people, removed };
}

async function peopleReply(ctx, guildContext) {
  return jsonResponse(peopleResponse(await loadModel(ctx.db, guildContext), guildContext));
}

function notFound() {
  return new HttpError(404, 'not_found', 'That person was not found.');
}

// The target must be a member, hold a role, or already be blocked. Anyone else is a 404.
function findTarget(model, userId) {
  const entry = model.byId.get(userId);
  if (!entry || !(entry.isMember || entry.roles.length || entry.block)) throw notFound();
  return entry;
}

// Role changes need a current, unblocked member who is not the Guild Master.
function findRoleTarget(model, userId, guildContext) {
  const entry = model.byId.get(userId);
  if (!entry || entry.block || !entry.isMember) throw notFound();
  if (entry.id === guildContext.userId || entry.rank === ROLE_RANK.guild_master) {
    throw new HttpError(403, 'forbidden', 'You cannot change that person\'s roles.');
  }
  return entry;
}

// SQL (plus params) that is true while the target is still an unblocked member and not the Guild Master.
function memberGuard(guildContext, userId) {
  return {
    sql: `EXISTS (SELECT 1 FROM user_servers WHERE user_id = ? AND server_id = ?)
          AND NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)
          AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
    params: [userId, guildContext.guild.discord_server_id, guildContext.guild.id, userId, guildContext.guild.id, userId],
  };
}

function summarize(entry) {
  return {
    officer: entry.roles.some((role) => role.role === 'officer'),
    teamLeadTeamIds: entry.roles.filter((role) => role.role === 'team_lead').map((role) => role.teamId).sort(),
  };
}

// ---------------------------------------------------------------------------
// Handlers

export async function getPeople(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAnyAction(guildContext, ['guild.access', 'guild.roles']);
  return peopleReply(ctx, guildContext);
}

function parseRolesBody(body) {
  if (typeof body.officer !== 'boolean') throw new HttpError(400, 'bad_request', 'officer must be true or false.', { field: 'officer' });
  const ids = body.teamLeadTeamIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !TEAM_ID.test(id))) {
    throw new HttpError(400, 'bad_request', 'teamLeadTeamIds must be a list of team ids.', { field: 'teamLeadTeamIds' });
  }
  const unique = [...new Set(ids)].sort();
  if (unique.length > MAX_TEAM_LEAD_TEAMS) {
    throw new HttpError(400, 'bad_request', `A person can lead at most ${MAX_TEAM_LEAD_TEAMS} teams.`, { field: 'teamLeadTeamIds' });
  }
  return { officer: body.officer, teamLeadTeamIds: unique };
}

export async function setRoles(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.roles');
  const wanted = parseRolesBody(ctx.body);
  const model = await loadModel(ctx.db, guildContext);
  const target = findRoleTarget(model, ctx.params.uid, guildContext);

  // Every team must belong to this guild and be active; any other id makes the request a 400.
  if (wanted.teamLeadTeamIds.length) {
    const valid = await ctx.db.prepare(
      'SELECT id FROM teams WHERE guild_id = ? AND archived = 0 AND id IN (SELECT value FROM json_each(?))',
    ).bind(guildContext.guild.id, JSON.stringify(wanted.teamLeadTeamIds)).all();
    if (valid.results.length !== wanted.teamLeadTeamIds.length) {
      throw new HttpError(400, 'bad_request', 'One of those teams does not exist or is archived.', { field: 'teamLeadTeamIds' });
    }
  }

  const before = summarize(target);
  const removedTeams = before.teamLeadTeamIds.filter((id) => !wanted.teamLeadTeamIds.includes(id));
  const addedTeams = wanted.teamLeadTeamIds.filter((id) => !before.teamLeadTeamIds.includes(id));
  const officerChange = before.officer !== wanted.officer;
  if (!officerChange && !removedTeams.length && !addedTeams.length) return peopleReply(ctx, guildContext);

  const guildId = guildContext.guild.id;
  const userId = target.id;
  const actorId = ctx.session.user.id;
  const now = ctx.now();
  const guard = memberGuard(guildContext, userId);
  const statements = [];
  const insert = (teamId, role) => ctx.db.prepare(
    `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}${teamId ? ' AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)' : ''}`,
  ).bind(newId('ra', ctx.randomBytes), guildId, userId, role, teamId, actorId, now, ...guard.params, ...(teamId ? [teamId, guildId] : []));

  if (officerChange && !wanted.officer) {
    statements.push(ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'officer' AND ${guard.sql}`,
    ).bind(guildId, userId, ...guard.params));
  }
  if (removedTeams.length) {
    statements.push(ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'team_lead'
         AND team_id IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
    ).bind(guildId, userId, JSON.stringify(removedTeams), ...guard.params));
  }
  if (officerChange && wanted.officer) statements.push(insert(null, 'officer'));
  for (const teamId of addedTeams) statements.push(insert(teamId, 'team_lead'));
  statements.push(auditStatement(ctx, {
    guildId, actorUserId: actorId, action: 'roles.set', entityType: 'user', entityId: userId, before, after: wanted,
  }, guard));

  const results = await ctx.db.batch(statements);
  if (results[results.length - 1].meta.changes !== 1) throw notFound();
  return peopleReply(ctx, guildContext);
}

export async function makeGuildMaster(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.roles');
  if (!guildContext.isGuildMaster) throw new HttpError(403, 'forbidden', 'Only the Guild Master can hand over the guild.');
  const model = await loadModel(ctx.db, guildContext);
  const target = findRoleTarget(model, ctx.params.uid, guildContext);

  const guildId = guildContext.guild.id;
  const oldMasterId = guildContext.userId;
  const targetId = target.id;
  const now = ctx.now();
  const guard = memberGuard(guildContext, targetId);
  const targetIsMaster = {
    sql: `EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
    params: [guildId, targetId],
  };

  const results = await ctx.db.batch([
    // The swap: one guarded UPDATE. Zero changes means the target or the viewer changed under us.
    ctx.db.prepare(
      `UPDATE role_assignments SET user_id = ?, assigned_by = ?, assigned_at = ?
        WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ? AND ${guard.sql}`,
    ).bind(targetId, oldMasterId, now, guildId, oldMasterId, ...guard.params),
    // The new Guild Master's other rows are dropped; the old one becomes an Officer.
    ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id != 'guild_master' AND ${targetIsMaster.sql}`,
    ).bind(guildId, targetId, ...targetIsMaster.params),
    ctx.db.prepare(
      `INSERT OR IGNORE INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
       SELECT ?, ?, ?, 'officer', NULL, ?, ? WHERE ${targetIsMaster.sql}`,
    ).bind(newId('ra', ctx.randomBytes), guildId, oldMasterId, targetId, now, ...targetIsMaster.params),
    auditStatement(ctx, {
      guildId, actorUserId: oldMasterId, action: 'guild_master.transfer', entityType: 'user', entityId: targetId,
      before: { guildMasterUserId: oldMasterId }, after: { guildMasterUserId: targetId },
    }, targetIsMaster),
  ]);
  if (results[0].meta.changes !== 1) {
    throw new HttpError(409, 'conflict', 'The guild changed while you were handing it over. Reload and try again.');
  }
  // The viewer is an Officer now; answer from fresh state.
  const fresh = await loadGuildContext(ctx.db, oldMasterId, guildId);
  return peopleReply(ctx, fresh);
}

function parseReason(body) {
  if (body.reason === undefined || body.reason === null) return null;
  return cleanText(body.reason, 'reason', { min: 0, max: MAX_REASON }) || null;
}

export async function blockPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.access');
  const reason = parseReason(ctx.body);
  const model = await loadModel(ctx.db, guildContext);
  const target = findTarget(model, ctx.params.uid);
  if (!hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot remove that person\'s access.');
  if (target.block) return peopleReply(ctx, guildContext);

  try {
    await ctx.db.batch([
      ctx.db.prepare('INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(guildContext.guild.id, target.id, guildContext.userId, reason, ctx.now()),
      // The reason text stays out of the audit log.
      auditStatement(ctx, {
        guildId: guildContext.guild.id, actorUserId: guildContext.userId, action: 'access.remove', entityType: 'user',
        entityId: target.id, before: { blocked: false }, after: { blocked: true, reasonSet: reason !== null },
      }),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return peopleReply(ctx, guildContext);
}

export async function restorePerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.access');
  const model = await loadModel(ctx.db, guildContext);
  const target = findTarget(model, ctx.params.uid);
  if (!hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot restore that person\'s access.');
  if (!target.block) return peopleReply(ctx, guildContext);

  const stillBlocked = {
    sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)',
    params: [guildContext.guild.id, target.id],
  };
  await ctx.db.batch([
    auditStatement(ctx, {
      guildId: guildContext.guild.id, actorUserId: guildContext.userId, action: 'access.restore', entityType: 'user',
      entityId: target.id, before: { blocked: true }, after: { blocked: false },
    }, stillBlocked),
    ctx.db.prepare('DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guildContext.guild.id, target.id),
  ]);
  return peopleReply(ctx, guildContext);
}
