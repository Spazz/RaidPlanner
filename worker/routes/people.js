import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { blockEffectStatements } from '../block-effects.js';
import {
  MISSING_KEY_LINE, accountBlockRef, accountKeys, matchedRefsOf, planTombstones, tombstoneDeleteStatement, tombstoneInsertStatements,
} from '../block-tombstones.js';
import { newId } from '../ids.js';
import { requireOwner } from '../owner.js';
import { boundMember, memberCandidatesSql, reachesGuildSql } from '../membership.js';
import { botConfigured } from '../discord-bot.js';
import { requireDiscord } from '../discord-guard.js';
import { discordProblem, syncMember } from '../discord-sync.js';
import { assertMayGrant, loadRolesData } from '../roles-store.js';
import { ROLE_RANK, isCustomRole, loadGuildContext, rankOf, requireAction, requireAnyAction, shapeRoles } from '../permissions.js';
import { toPerson } from '../person.js';

const MAX_TEAM_LEAD_TEAMS = 20;
const TEAM_ID = /^t_[A-Za-z0-9_-]{22}$/;
const MAX_REASON = 200;
const MAX_EXTRA_ROLES = 40;

// ---------------------------------------------------------------------------
// The people model: everyone who is a member (by the guild's rank source, worker/membership.js), holds a role, or is blocked.

async function loadModel(db, guildContext) {
  const guildId = guildContext.guild.id;
  const serverId = guildContext.guild.discord_server_id;
  const [userResult, assignmentResult, blockResult, rosterResult, mapResult] = await db.batch([
    // is_member: the guild's rank source lets the account in (the block is read from guild_blocks below, not folded in here).
    db.prepare(
      `SELECT u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar, u.last_seen_at,
              ${reachesGuildSql('u.id', 'gc.gid', 'gc.sid')} AS is_member
         FROM users u, (SELECT ? AS gid, ? AS sid) gc
        WHERE u.id IN (
          SELECT user_id FROM (${memberCandidatesSql('gc.gid', 'gc.sid')})
          UNION SELECT user_id FROM role_assignments WHERE guild_id = gc.gid
          UNION SELECT user_id FROM guild_blocks WHERE guild_id = gc.gid
          UNION SELECT blocked_by FROM guild_blocks WHERE guild_id = gc.gid AND blocked_by IS NOT NULL)`,
    ).bind(guildId, serverId),
    db.prepare(
      `SELECT ra.user_id, ra.role_id, ra.team_id, ra.source, r.name AS role_name
         FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ?`,
    ).bind(guildId),
    db.prepare('SELECT user_id, blocked_by, reason, created_at FROM guild_blocks WHERE guild_id = ?').bind(guildId),
    // The roster entry (the Main) of each person linked to an account (by an officer's link, or by the Discord ID they carry).
    db.prepare(
      `SELECT p.id AS person_id, p.discord_user_id, p.user_id, m.name, m.class FROM players p
         JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ? AND (p.discord_user_id IS NOT NULL OR p.user_id IS NOT NULL)`,
    ).bind(guildId),
    db.prepare('SELECT COUNT(*) AS n FROM discord_role_maps WHERE guild_id = ?').bind(guildId),
  ]);
  const entryOf = (row) => ({ personId: row.person_id, name: row.name, class: row.class });
  const rosterByUser = new Map(rosterResult.results.filter((row) => row.user_id).map((row) => [row.user_id, entryOf(row)]));
  const rosterByDiscord = new Map(rosterResult.results.filter((row) => row.discord_user_id).map((row) => [row.discord_user_id, entryOf(row)]));

  const byId = new Map();
  for (const row of userResult.results) {
    byId.set(row.id, {
      id: row.id, row, person: toPerson(row), isMember: row.is_member === 1, assignments: [], block: null,
      roster: rosterByUser.get(row.id) || (row.discord_id ? rosterByDiscord.get(row.discord_id) : null) || null,
    });
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
    // What an officer set by hand: the Edit roles dialog changes these and only these (a role Discord gives is changed in Discord).
    entry.manualRoles = shapeRoles(entry.assignments.filter((assignment) => assignment.source !== 'discord'));
    entry.rank = rankOf(entry.assignments);
  }
  return { byId, hasMaps: mapResult.results[0].n > 0 };
}

// Never yourself, never the Guild Master; strictly junior to the viewer (an Officer cannot act on an Officer).
function hierarchyAllows(guildContext, entry) {
  if (entry.id === guildContext.userId) return false;
  if (entry.rank === ROLE_RANK.guild_master) return false;
  return guildContext.rank < entry.rank;
}

function actionsFor(guildContext, entry, sync = false) {
  const canAccess = guildContext.can['guild.access'] === 'guild';
  const canRoles = guildContext.can['guild.roles'] === 'guild';
  if (entry.block) return { restoreAccess: canAccess && hierarchyAllows(guildContext, entry) };
  const editable = canRoles && entry.isMember && entry.id !== guildContext.userId && entry.rank !== ROLE_RANK.guild_master;
  return {
    editRoles: editable,
    makeGuildMaster: editable && guildContext.isGuildMaster,
    removeAccess: canAccess && hierarchyAllows(guildContext, entry),
    // Only present when true: Sync now (apply the Discord role mapping to this person) needs the bot, a mapping and a person who has Discord.
    ...(sync && canAccess && entry.isMember && !!entry.row.discord_id && entry.rank !== ROLE_RANK.guild_master ? { syncDiscord: true } : {}),
  };
}

function byRankThenName(a, b) {
  return a.rank - b.rank
    || a.person.displayName.toLowerCase().localeCompare(b.person.displayName.toLowerCase())
    || a.id.localeCompare(b.id);
}

function peopleResponse(model, guildContext, env) {
  // sync: the person's Discord roles can be read (the bot token is set) and there is a mapping to apply.
  const sync = botConfigured(env) && model.hasMaps;
  const entries = [...model.byId.values()];
  const people = entries
    .filter((entry) => !entry.block && (entry.isMember || entry.roles.length))
    .sort(byRankThenName)
    .map((entry) => ({
      person: entry.person,
      roles: entry.roles,
      roster: entry.roster,
      lastSeenAt: entry.row.last_seen_at,
      isMe: entry.id === guildContext.userId,
      actions: actionsFor(guildContext, entry, sync),
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
  return { signedInCount: people.length, people, removed, discord: { configured: botConfigured(env), mapped: model.hasMaps } };
}

async function peopleReply(ctx, guildContext) {
  return jsonResponse(peopleResponse(await loadModel(ctx.db, guildContext), guildContext, ctx.env));
}

function conflict() {
  return new HttpError(409, 'conflict', 'That changed while you were working on it. Reload and try again.');
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

function isCurrentMember(entry) {
  return entry.isMember && !entry.block;
}

// Role changes reach a current, unblocked member, or anyone who still holds a role here (so a demotion
// always works). The person is never the viewer or the Guild Master.
function findRoleTarget(model, userId, guildContext) {
  const entry = model.byId.get(userId);
  if (!entry || !(isCurrentMember(entry) || entry.assignments.length)) throw notFound();
  if (entry.id === guildContext.userId || entry.rank === ROLE_RANK.guild_master) {
    throw new HttpError(403, 'forbidden', 'You cannot change that person\'s roles.');
  }
  return entry;
}

export const and = (...guards) => ({
  sql: guards.map((guard) => `(${guard.sql})`).join(' AND '),
  params: guards.flatMap((guard) => guard.params),
});

// True while the acting user still holds a role that grants the action guild-wide.
export function actorHolds(action, guildId, actorId) {
  return {
    sql: `EXISTS (SELECT 1 FROM role_assignments ra JOIN effective_role_permissions rp ON rp.guild_id = ra.guild_id AND rp.role_id = ra.role_id
            WHERE ra.guild_id = ? AND ra.user_id = ? AND rp.action = ? AND rp.scope = 'guild')`,
    params: [guildId, actorId, action],
  };
}

// True while the actor's best role is strictly senior to the target's (this also rules out the actor
// themself and the Guild Master). A person with no role counts as Member.
function actorOutranks(guildId, actorId, targetId) {
  const rank = `COALESCE((SELECT MIN(r.rank) FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                            WHERE ra.guild_id = ? AND ra.user_id = ?), ${ROLE_RANK.member})`;
  return { sql: `${rank} < ${rank}`, params: [guildId, actorId, guildId, targetId] };
}

// True while the target still holds a role here (used when a change only removes roles).
function holderGuard(guildContext, userId) {
  return {
    sql: 'EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ?)',
    params: [guildContext.guild.id, userId],
  };
}

// SQL (plus params) that is true while the target is still an unblocked member and not the Guild Master.
function memberGuard(guildContext, userId) {
  const member = boundMember(userId, guildContext.guild.id, guildContext.guild.discord_server_id);
  return {
    sql: `${member.sql}
          AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
    params: [...member.params, guildContext.guild.id, userId],
  };
}

// What the Edit roles dialog edits: the roles an officer set by hand (a role only Discord gives is changed in Discord).
function summarize(entry) {
  const manual = entry.manualRoles;
  return {
    officer: manual.some((role) => role.role === 'officer'),
    teamLeadTeamIds: manual.filter((role) => role.role === 'team_lead').map((role) => role.teamId).sort(),
    extra: manual.filter((role) => isCustomRole(role.role)).map((role) => ({ roleId: role.role, teamId: role.teamId || null })).sort(byPairKey),
  };
}

const pairKey = (pair) => `${pair.roleId}|${pair.teamId || ''}`;
const byPairKey = (a, b) => pairKey(a).localeCompare(pairKey(b));

// ---------------------------------------------------------------------------
// Handlers

export async function getPeople(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
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
  // roles (optional): the guild's own roles the person holds by hand, [{ roleId, teamId | null }]. Left out = the person's custom roles stay as they are.
  let extra;
  if (body.roles !== undefined) {
    const list = body.roles;
    const bad = !Array.isArray(list) || list.length > MAX_EXTRA_ROLES || list.some((entry) => !entry || typeof entry !== 'object'
      || !isCustomRole(entry.roleId) || (entry.teamId !== null && entry.teamId !== undefined && !(typeof entry.teamId === 'string' && TEAM_ID.test(entry.teamId))));
    if (bad) throw new HttpError(400, 'bad_request', 'roles must be a list of { roleId, teamId } for this guild\'s own roles.', { field: 'roles' });
    extra = [...new Map(list.map((entry) => [pairKey({ roleId: entry.roleId, teamId: entry.teamId }), { roleId: entry.roleId, teamId: entry.teamId || null }])).values()].sort(byPairKey);
  }
  return { officer: body.officer, teamLeadTeamIds: unique, extra };
}

export async function setRoles(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const wanted = parseRolesBody(ctx.body);
  const model = await loadModel(ctx.db, guildContext);
  const target = findRoleTarget(model, ctx.params.uid, guildContext);
  const rolesData = await loadRolesData(ctx.db, guildContext.guild.id);

  // The guild's own roles must be this guild's, and be given with a team exactly when they hold a team-scoped permission.
  for (const pair of wanted.extra || []) {
    if (!rolesData.isCustom(pair.roleId)) throw new HttpError(400, 'bad_request', 'That role does not exist in this guild.', { field: 'roles' });
    if (rolesData.needsTeam(pair.roleId) !== (pair.teamId !== null)) {
      throw new HttpError(400, 'bad_request', rolesData.needsTeam(pair.roleId) ? 'That role is given for one team: pick the team.' : 'That role is for the whole guild: leave the team out.', { field: 'roles' });
    }
  }
  // Every team must belong to this guild and be active; any other id makes the request a 400.
  const wantedTeamIds = [...new Set([...wanted.teamLeadTeamIds, ...(wanted.extra || []).map((pair) => pair.teamId).filter(Boolean)])];
  if (wantedTeamIds.length) {
    const valid = await ctx.db.prepare(
      'SELECT id FROM teams WHERE guild_id = ? AND archived = 0 AND id IN (SELECT value FROM json_each(?))',
    ).bind(guildContext.guild.id, JSON.stringify(wantedTeamIds)).all();
    if (valid.results.length !== wantedTeamIds.length) {
      throw new HttpError(400, 'bad_request', 'One of those teams does not exist or is archived.', { field: wanted.teamLeadTeamIds.length ? 'teamLeadTeamIds' : 'roles' });
    }
  }

  const before = summarize(target);
  const removedTeams = before.teamLeadTeamIds.filter((id) => !wanted.teamLeadTeamIds.includes(id));
  const addedTeams = wanted.teamLeadTeamIds.filter((id) => !before.teamLeadTeamIds.includes(id));
  const officerChange = before.officer !== wanted.officer;
  const heldExtra = new Set(before.extra.map(pairKey));
  const wantedExtra = new Set((wanted.extra || []).map(pairKey));
  const removedExtra = wanted.extra ? before.extra.filter((pair) => !wantedExtra.has(pairKey(pair))) : [];
  const addedExtra = (wanted.extra || []).filter((pair) => !heldExtra.has(pairKey(pair)));
  if (!officerChange && !removedTeams.length && !addedTeams.length && !removedExtra.length && !addedExtra.length) return peopleReply(ctx, guildContext);
  // Grants need a current, unblocked member; removing roles works for anyone who holds one.
  const grants = (officerChange && wanted.officer) || addedTeams.length > 0 || addedExtra.length > 0;
  if (grants && !isCurrentMember(target)) throw notFound();
  if (officerChange && wanted.officer) assertMayGrant(guildContext, rolesData, 'officer', null);
  for (const teamId of addedTeams) assertMayGrant(guildContext, rolesData, 'team_lead', teamId);
  for (const pair of addedExtra) assertMayGrant(guildContext, rolesData, pair.roleId, pair.teamId);

  const guildId = guildContext.guild.id;
  const userId = target.id;
  const actorId = ctx.session.user.id;
  const now = ctx.now();
  const guard = and(
    grants ? memberGuard(guildContext, userId) : holderGuard(guildContext, userId),
    actorHolds('guild.roles', guildId, actorId),
    actorOutranks(guildId, actorId, userId),
  );
  // The audit rows keep the old shape (officer, teamLeadTeamIds) and add roles only when the request set the guild's own roles.
  const shown = (summary) => ({ officer: summary.officer, teamLeadTeamIds: summary.teamLeadTeamIds, ...(wanted.extra ? { roles: summary.extra } : {}) });
  // The audit row goes first: it is evaluated against the state the guard was built for, before the
  // deletes below remove the very roles the guard looks at.
  const statements = [auditStatement(ctx, {
    guildId, actorUserId: actorId, action: 'roles.set', entityType: 'user', entityId: userId, before: shown(before), after: shown(wanted),
  }, guard)];
  // Only what an officer set by hand is touched (source 'manual'): a role Discord gives is the sync's.
  const insert = (teamId, role) => {
    const roleCheck = isCustomRole(role) ? ' AND EXISTS (SELECT 1 FROM roles WHERE id = ? AND guild_id = ?)' : '';
    return ctx.db.prepare(
      `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_by, assigned_at)
       SELECT ?, ?, ?, ?, ?, 'manual', ?, ? WHERE ${guard.sql}${teamId ? ' AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)' : ''}${roleCheck}`,
    ).bind(newId('ra', ctx.randomBytes), guildId, userId, role, teamId, actorId, now, ...guard.params, ...(teamId ? [teamId, guildId] : []), ...(isCustomRole(role) ? [role, guildId] : []));
  };

  if (officerChange && !wanted.officer) {
    statements.push(ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'officer' AND source = 'manual' AND ${guard.sql}`,
    ).bind(guildId, userId, ...guard.params));
  }
  if (removedTeams.length) {
    statements.push(ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'team_lead' AND source = 'manual'
         AND team_id IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
    ).bind(guildId, userId, JSON.stringify(removedTeams), ...guard.params));
  }
  for (const pair of removedExtra) {
    statements.push(ctx.db.prepare(
      `DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = ? AND COALESCE(team_id, '') = ? AND source = 'manual' AND ${guard.sql}`,
    ).bind(guildId, userId, pair.roleId, pair.teamId || '', ...guard.params));
  }
  if (officerChange && wanted.officer) statements.push(insert(null, 'officer'));
  for (const teamId of addedTeams) statements.push(insert(teamId, 'team_lead'));
  for (const pair of addedExtra) statements.push(insert(pair.teamId, pair.roleId));

  let results;
  try {
    results = await ctx.db.batch(statements);
  } catch (error) {
    // A concurrent identical grant won the unique index: answer from the fresh state.
    if (isUniqueViolation(error)) return peopleReply(ctx, guildContext);
    throw error;
  }
  if (results[0].meta.changes !== 1) throw conflict();
  return peopleReply(ctx, guildContext);
}

// Sync now: apply the Discord role mapping to one person, then answer with the people list and what changed.
export async function syncPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  requireDiscord(guildContext.guild);
  const model = await loadModel(ctx.db, guildContext);
  const target = findTarget(model, ctx.params.uid);
  if (!isCurrentMember(target)) throw notFound();
  if (!target.row.discord_id) throw new HttpError(409, 'no_discord', 'That person has not connected Discord, so there are no Discord roles to read.');
  if (!botConfigured(ctx.env)) throw discordProblem('not_configured');
  if (!model.hasMaps) throw new HttpError(409, 'no_mapping', 'Map a Discord role to a Raidsmith role first (Guild settings > Discord roles).');
  const result = await syncMember(ctx, guildContext.guild, target.id, { actorId: guildContext.userId });
  if (result.status === 'failed') throw discordProblem(result.reason);
  const fresh = peopleResponse(await loadModel(ctx.db, guildContext), guildContext, ctx.env);
  return jsonResponse({ ...fresh, sync: { status: result.status, reason: result.reason || null, added: result.added || 0, removed: result.removed || 0 } });
}

export async function makeGuildMaster(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  // An Owner act (plan "Owner-only acts"): a Guild Master by role who does not hold the Owner seat cannot hand the guild over.
  await requireOwner(ctx.db, guildContext, 'Only the Owner of the guild can hand it over.');
  const model = await loadModel(ctx.db, guildContext);
  const target = findRoleTarget(model, ctx.params.uid, guildContext);
  if (!isCurrentMember(target)) throw notFound();

  const guildId = guildContext.guild.id;
  const oldMasterId = guildContext.userId;
  const targetId = target.id;
  const now = ctx.now();
  const guard = memberGuard(guildContext, targetId);
  const targetIsMaster = {
    sql: `EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
    params: [guildId, targetId],
  };

  let results;
  try {
    results = await ctx.db.batch([
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
  } catch (error) {
    // A concurrent identical hand-over won the unique index: answer from the fresh state.
    if (!isUniqueViolation(error)) throw error;
    return peopleReply(ctx, await loadGuildContext(ctx.db, oldMasterId, guildId));
  }
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const reason = parseReason(ctx.body);
  const model = await loadModel(ctx.db, guildContext);
  const target = findTarget(model, ctx.params.uid);
  if (!hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot remove that person\'s access.');
  if (target.block) return peopleReply(ctx, guildContext);

  const guildId = guildContext.guild.id;
  const now = ctx.now();
  // The tombstones of the keys this account proved (Discord id, Battle.net id, Battle.net-proven characters): they outlive the block row, so Delete my data
  // and a fresh account do not undo the block (worker/block-tombstones.js). No usable TOMBSTONE_KEY: the block still applies, flagged for the daily repair.
  const plan = await planTombstones(ctx.env, guildId, await accountKeys(ctx.db, target.id, guildId));
  if (plan.missing) ctx.log(MISSING_KEY_LINE);
  // One guarded INSERT: the actor still holds the right and still outranks the target (an Officer cannot
  // remove an Officer or the Guild Master). Everything else in the batch follows only if THIS call's block row was written.
  const guard = and(actorHolds('guild.access', guildId, guildContext.userId), actorOutranks(guildId, guildContext.userId, target.id));
  const written = {
    sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND blocked_by = ? AND created_at = ?)',
    params: [guildId, target.id, guildContext.userId, now],
  };
  let results;
  try {
    results = await ctx.db.batch([
      ctx.db.prepare(
        `INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, tombstone_missing)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      ).bind(guildId, target.id, guildContext.userId, reason, now, plan.missing ? 1 : 0, ...guard.params),
      ...tombstoneInsertStatements(ctx.db, { guildId, blockRef: accountBlockRef(target.id), plan, now, guard: written }),
      // A block takes the person off every team and withdraws their upcoming sign-ups (plan M11).
      ...(await blockEffectStatements(ctx.db, { guildId, target: { userId: target.id }, nowMs: now, guard: written })),
      // The reason text stays out of the audit log.
      auditStatement(ctx, {
        guildId, actorUserId: guildContext.userId, action: 'access.remove', entityType: 'user',
        entityId: target.id, before: { blocked: false }, after: { blocked: true, reasonSet: reason !== null },
      }, written),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return peopleReply(ctx, guildContext);
  }
  if (results[0].meta.changes !== 1) throw conflict();
  return peopleReply(ctx, guildContext);
}

export async function restorePerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const model = await loadModel(ctx.db, guildContext);
  const target = findTarget(model, ctx.params.uid);
  if (!hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot restore that person\'s access.');
  if (!target.block) return peopleReply(ctx, guildContext);

  const guildId = guildContext.guild.id;
  const stillBlocked = {
    sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)',
    params: [guildId, target.id],
  };
  // The same actor guards as removing access, on the audit row, the tombstones and the DELETE.
  const guard = and(
    stillBlocked,
    actorHolds('guild.access', guildId, guildContext.userId),
    actorOutranks(guildId, guildContext.userId, target.id),
  );
  // Unblock deletes the block's tombstones by block_ref: the account's own, and every ref its keys hit (a pending-review block matched an earlier block's
  // tombstones; lifting it must lift those too, or the next sign-in would block it again).
  const refs = [...new Set([accountBlockRef(target.id), ...(await matchedRefsOf(ctx.db, ctx.env, guildId, await accountKeys(ctx.db, target.id, guildId)))])];
  const results = await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'access.restore', entityType: 'user',
      entityId: target.id, before: { blocked: true }, after: { blocked: false },
    }, guard),
    tombstoneDeleteStatement(ctx.db, { guildId, blockRefs: refs, guard }),
    ctx.db.prepare(`DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND ${guard.sql}`)
      .bind(guildId, target.id, ...guard.params),
  ]);
  if (results[2].meta.changes !== 1) {
    // Someone else restoring first is fine. If the block is still there, the actor lost the right.
    const still = await ctx.db.prepare('SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?')
      .bind(guildId, target.id).first();
    if (still) throw conflict();
  }
  return peopleReply(ctx, guildContext);
}
