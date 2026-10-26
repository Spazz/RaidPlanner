import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { blockEffectStatements } from '../block-effects.js';
import {
  MISSING_KEY_LINE, accountBlockRef, accountKeys, liftTombstoneStatements, matchedRefsOf, planTombstones, splitLiftableRefs, tombstoneDeleteStatement, tombstoneInsertStatements,
} from '../block-tombstones.js';
import { newId } from '../ids.js';
import { allOf, beginFreshAct, freshRequiredError } from '../fresh.js';
import { isOwner, liveRecipientGuard, moveSeatStatement, ownerGuard, ownerSql, readSeat, requireOwner, seatHeldBySql } from '../owner.js';
import { boundMember, memberCandidatesSql, reachesGuildSql } from '../membership.js';
import { botConfigured } from '../discord-bot.js';
import { requireDiscord } from '../discord-guard.js';
import { discordProblem, syncMember } from '../discord-sync.js';
import { assertMayGrant, loadRolesData } from '../roles-store.js';
import { ROLE_RANK, isCustomRole, loadGuildContext, rankOf, requireAction, requireAnyAction, shapeRoles } from '../permissions.js';
import { toPerson } from '../person.js';
import { visibleCharacterSql } from '../character-visibility.js';

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
          UNION SELECT user_id FROM effective_roles WHERE guild_id = gc.gid
          UNION SELECT user_id FROM guild_blocks WHERE guild_id = gc.gid
          UNION SELECT blocked_by FROM guild_blocks WHERE guild_id = gc.gid AND blocked_by IS NOT NULL)`,
    ).bind(guildId, serverId),
    db.prepare(
      `SELECT ra.user_id, ra.role_id, ra.team_id, ra.source, r.name AS role_name
         FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ?`,
    ).bind(guildId),
    db.prepare('SELECT user_id, blocked_by, reason, created_at, pending_review FROM guild_blocks WHERE guild_id = ?').bind(guildId),
    // The roster entry (the Main) of each person linked to an account (by an officer's link, or by the Discord ID they carry).
    db.prepare(
      `SELECT p.id AS person_id, p.discord_user_id, p.user_id, m.name, m.class FROM players p
         JOIN characters m ON m.player_id = p.id AND m.is_main = 1 AND ${visibleCharacterSql('m')}
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
      id: row.id, row, person: toPerson(row), isMember: row.is_member === 1, assignments: [], block: null, ignoredBlock: null,
      roster: rosterByUser.get(row.id) || (row.discord_id ? rosterByDiscord.get(row.discord_id) : null) || null,
    });
  }
  for (const assignment of assignmentResult.results) {
    const entry = byId.get(assignment.user_id);
    if (entry) entry.assignments.push(assignment);
  }
  for (const block of blockResult.results) {
    const entry = byId.get(block.user_id);
    if (!entry) continue;
    // A block row on the unsuspended Owner (the Owner row of the effective roles) is ignored, as worker/membership.js blockedSql ignores it: an Owner who is live cannot be removed.
    // The row is kept (it counts again when the Owner is suspended, and when the seat moves) and listed apart (ignoredBlock), so somebody can see it and restore it.
    if (entry.assignments.some((assignment) => assignment.source === 'owner')) entry.ignoredBlock = block;
    else entry.block = block;
  }
  for (const entry of byId.values()) {
    entry.roles = shapeRoles(entry.assignments);
    // What an officer set by hand: the Edit roles dialog changes these and only these. A role Discord gives is changed in Discord; a role the in-game rank gives (source
    // 'ingame') and the Owner's own row (source 'owner') are derived at read time and read-only here: no statement of the roles routes touches a row that is not 'manual'.
    entry.manualRoles = shapeRoles(entry.assignments.filter((assignment) => assignment.source === 'manual'));
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

// The actions on a row of the removed list. A row on the live Owner (ignoredBlock) blocks nobody, so there is no rank to outrank: whoever holds guild.access may restore it (also the
// Owner). A real block needs strict seniority. keepBlock (only present when true): the block waits for review (a tombstone match wrote it) and this viewer may decide it.
function removedActionsFor(guildContext, entry) {
  const allowed = guildContext.can['guild.access'] === 'guild' && (entry.ignoredBlock !== null && entry.block === null ? true : hierarchyAllows(guildContext, entry));
  return { restoreAccess: allowed, ...(allowed && entry.block && entry.block.pending_review === 1 ? { keepBlock: true } : {}) };
}

function actionsFor(guildContext, entry, sync = false) {
  const canAccess = guildContext.can['guild.access'] === 'guild';
  const canRoles = guildContext.can['guild.roles'] === 'guild';
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
    .filter((entry) => entry.block || entry.ignoredBlock)
    .sort((a, b) => (b.block || b.ignoredBlock).created_at - (a.block || a.ignoredBlock).created_at || a.id.localeCompare(b.id))
    .map((entry) => {
      const block = entry.block || entry.ignoredBlock;
      const remover = block.blocked_by ? model.byId.get(block.blocked_by) : null;
      return {
        person: entry.person,
        roles: entry.roles,
        removedBy: remover ? remover.person : null,
        removedAt: block.created_at,
        reason: block.reason ?? null,
        // Only present when true: a tombstone match wrote this block and an officer has not reviewed it yet (POST .../block/keep, or restore access).
        ...(entry.block && entry.block.pending_review === 1 ? { pendingReview: true } : {}),
        // Only present when true: the person is the live Owner, so the row blocks nobody and is kept apart; restore access removes it (the Owner is also listed in `people`).
        ...(entry.ignoredBlock && !entry.block ? { ignoredWhileOwner: true } : {}),
        actions: removedActionsFor(guildContext, entry),
      };
    });
  return { signedInCount: people.length, people, removed, discord: { configured: botConfigured(env), mapped: model.hasMaps } };
}

async function peopleReply(ctx, guildContext, extra = {}) {
  return jsonResponse({ ...peopleResponse(await loadModel(ctx.db, guildContext), guildContext, ctx.env), ...extra });
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
    sql: `EXISTS (SELECT 1 FROM effective_roles ra JOIN effective_role_permissions rp ON rp.guild_id = ra.guild_id AND rp.role_id = ra.role_id
            WHERE ra.guild_id = ? AND ra.user_id = ? AND rp.action = ? AND rp.scope = 'guild')`,
    params: [guildId, actorId, action],
  };
}

// True while the actor's best role is strictly senior to the target's (this also rules out the actor
// themself and the Guild Master). A person with no role counts as Member.
function actorOutranks(guildId, actorId, targetId) {
  const rank = `COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id
                            WHERE ra.guild_id = ? AND ra.user_id = ?), ${ROLE_RANK.member})`;
  return { sql: `${rank} < ${rank}`, params: [guildId, actorId, guildId, targetId] };
}

// True while the target still holds a role here (used when a change only removes roles).
function holderGuard(guildContext, userId) {
  return {
    sql: 'EXISTS (SELECT 1 FROM effective_roles WHERE guild_id = ? AND user_id = ?)',
    params: [guildContext.guild.id, userId],
  };
}

// SQL (plus params) that is true while the target is still an unblocked member and not the Guild Master.
function memberGuard(guildContext, userId) {
  const member = boundMember(userId, guildContext.guild.id, guildContext.guild.discord_server_id);
  return {
    sql: `${member.sql}
          AND NOT EXISTS (SELECT 1 FROM effective_roles WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
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
  // pin (optional): true writes a HAND row even for a role the person already holds through a derived row (the in-game rank, Discord); see setRoles.
  if (body.pin !== undefined && typeof body.pin !== 'boolean') throw new HttpError(400, 'bad_request', 'pin must be true or false.', { field: 'pin' });
  return { officer: body.officer, teamLeadTeamIds: unique, extra, pin: body.pin === true };
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
  // A role the person already holds through a DERIVED row (the in-game rank, a Discord role, the Owner row) is not copied into a hand row: the Edit roles dialog sends every role it
  // shows as ticked, so saving it unchanged would otherwise make a permanent Officer / Team Lead that outlives the in-game demotion. Only `pin: true` writes that hand row on purpose.
  const derivedHeld = (role, teamId) => target.assignments.some((row) => row.source !== 'manual' && row.role_id === role && (row.team_id || null) === teamId);
  const removedTeams = before.teamLeadTeamIds.filter((id) => !wanted.teamLeadTeamIds.includes(id));
  const addedTeams = wanted.teamLeadTeamIds.filter((id) => !before.teamLeadTeamIds.includes(id) && (wanted.pin || !derivedHeld('team_lead', id)));
  const officerChange = before.officer !== wanted.officer && !(wanted.officer && !wanted.pin && derivedHeld('officer', null));
  // What the hand roles are afterwards (the audit row records that, not the request's wish for a role a derived row already gives).
  const after = { ...wanted, officer: officerChange ? wanted.officer : before.officer, teamLeadTeamIds: wanted.teamLeadTeamIds.filter((id) => before.teamLeadTeamIds.includes(id) || addedTeams.includes(id)) };
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
    guildId, actorUserId: actorId, action: 'roles.set', entityType: 'user', entityId: userId, before: shown(before), after: shown(after),
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

// The target of a hand-over of the SEAT: a current, unblocked member other than the Owner. Unlike findRoleTarget there is no rank test: the in-game Guild Master (a derived Guild
// Master) is the natural recipient and ranks as a Guild Master already.
function findSeatTarget(model, userId, guildContext) {
  const entry = model.byId.get(userId);
  if (!entry || !isCurrentMember(entry)) throw notFound();
  if (entry.id === guildContext.userId) throw new HttpError(403, 'forbidden', 'You already hold the guild.');
  return entry;
}

// POST /api/guild/:gid/people/:uid/guild-master: hand the guild to a member. An Owner act that needs a FRESH sign-in (purpose handover, params { targetUserId }) in every guild
// except one whose rank source is 'manual' (session only: such a guild has no Battle.net proof to ask for; documented in tasks/open/b6b-api-contract.md). Without the grant:
// 403 fresh_required { purpose, params }.
//   seat set (owner_user_id)  ONLY the seat moves: `UPDATE guilds SET owner_user_id = <target> WHERE id = ? AND owner_user_id IS <the Owner>`. The recipient must be a member and, in
//                             an 'ingame' guild, live (a Battle.net-proven character on the roster: the guard sits in the batch). The previous Owner keeps what their own rank and
//                             stored roles give; NO Officer row is written for them (U R8-Q1).
//   no seat (legacy)          today's swap of the stored Guild Master row; the previous one becomes an Officer.
export async function makeGuildMaster(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  // An Owner act (plan "Owner-only acts"). The Owner passes the gate with or without a stored Guild Master role (review finding B4b/B5 F2: a seat-only Owner holds none), and a
  // Guild Master by role who does not hold the seat, or a suspended Owner, cannot hand the guild over.
  await requireOwner(ctx.db, guildContext, 'Only the Owner of the guild can hand it over.');
  const guildId = guildContext.guild.id;
  const seat = await readSeat(ctx.db, guildId);
  const model = await loadModel(ctx.db, guildContext);
  const target = seat.seatHolder ? findSeatTarget(model, ctx.params.uid, guildContext) : findRoleTarget(model, ctx.params.uid, guildContext);
  if (!isCurrentMember(target)) throw notFound();

  const oldMasterId = guildContext.userId;
  const targetId = target.id;
  const now = ctx.now();
  const asOwner = ownerGuard(guildId, oldMasterId);
  const recipient = boundMember(targetId, guildId, guildContext.guild.discord_server_id);
  if (seat.seatHolder && seat.rankSource === 'ingame') {
    const live = liveRecipientGuard(guildId, targetId);
    const row = await ctx.db.prepare(`SELECT ${live.sql} AS live`).bind(...live.params).first();
    if (!row || row.live !== 1) {
      throw new HttpError(409, 'recipient_not_live',
        'That person has no character proved by Battle.net on the in-game roster, so they could not hold the guild. Ask them to connect Battle.net first.', { field: 'uid' });
    }
  }
  const act = await beginFreshAct(ctx, {
    required: seat.rankSource !== 'manual', purpose: 'handover', guildId, params: { targetUserId: targetId }, extra: asOwner,
  });

  let results;
  let moved;
  try {
    if (seat.seatHolder) {
      // The audit row goes first, with the guards of the move, so it records the Owner as the Owner (the move changes who that is).
      const guards = allOf(act.guard, asOwner, recipient, liveRecipientGuard(guildId, targetId), { sql: seatHeldBySql('?', '?'), params: [guildId, oldMasterId] });
      results = await ctx.db.batch([
        ...act.statements,
        auditStatement(ctx, {
          guildId, actorUserId: oldMasterId, action: 'guild_master.transfer', entityType: 'user', entityId: targetId,
          before: { guildMasterUserId: oldMasterId }, after: { guildMasterUserId: targetId },
        }, guards),
        moveSeatStatement(ctx.db, { guildId, from: oldMasterId, to: targetId, guards: [guards] }),
      ]);
      moved = results[act.offset + 1].meta.changes;
    } else {
      const guard = allOf(memberGuard(guildContext, targetId), act.guard);
      const targetIsMaster = allOf({
        sql: `EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')`,
        params: [guildId, targetId],
      }, act.guard);
      results = await ctx.db.batch([
        ...act.statements,
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
      moved = results[act.offset].meta.changes;
    }
  } catch (error) {
    // A concurrent identical hand-over won the unique index: answer from the fresh state.
    if (!isUniqueViolation(error)) throw error;
    return peopleReply(ctx, await loadGuildContext(ctx.db, oldMasterId, guildId));
  }
  if (!act.consumed(results)) throw freshRequiredError('handover', { targetUserId: targetId });
  if (moved !== 1) {
    throw new HttpError(409, 'conflict', 'The guild changed while you were handing it over. Reload and try again.');
  }
  // The previous Owner is an Officer (legacy) or whatever their own rank makes them (seat); answer from fresh state. A previous Owner whom the guild's rank source no longer
  // counts as a member (a seat holder with no roster character of their own) gets the bare answer.
  let fresh;
  try {
    fresh = await loadGuildContext(ctx.db, oldMasterId, guildId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return jsonResponse({ handedOver: true });
    throw error;
  }
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
  // The Owner who is not suspended cannot be blocked, whoever asks (plan "Owner"); a SUSPENDED Owner is blockable like anyone (U R4-Q3) and any Guild Master tier principal
  // restores them. The Owner row of the effective roles is how the model tells the two apart.
  if (target.assignments.some((assignment) => assignment.source === 'owner')) throw new HttpError(403, 'forbidden', 'The Owner of the guild cannot be removed.');
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
  // ... and the same refusal inside the write: a hand-over that made the target the Owner between the read and the INSERT blocks nobody.
  const notOwner = { sql: `NOT ${ownerSql('?', '?')}`, params: [guildId, target.id, target.id] };
  const guard = and(actorHolds('guild.access', guildId, guildContext.userId), actorOutranks(guildId, guildContext.userId, target.id), notOwner);
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
  // A row on the live Owner blocks nobody: there is no rank to outrank, so the seniority test is the Owner test instead (also inside the batch below).
  const ignored = target.block === null && target.ignoredBlock !== null;
  if (!ignored && !hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot restore that person\'s access.');
  if (!target.block && !ignored) return peopleReply(ctx, guildContext);

  const guildId = guildContext.guild.id;
  const stillBlocked = {
    sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)',
    params: [guildId, target.id],
  };
  // The same actor guards as removing access, on the audit row, the tombstones and the DELETE.
  const guard = and(
    stillBlocked,
    actorHolds('guild.access', guildId, guildContext.userId),
    ignored ? { sql: ownerSql('?', '?'), params: [guildId, target.id, target.id] } : actorOutranks(guildId, guildContext.userId, target.id),
  );
  // Unblock deletes the block's tombstones by block_ref: the account's own, and the refs its keys hit (a pending-review block matched an earlier block's tombstones;
  // lifting it must lift those too, or the next sign-in would block it again) - but only the refs of blocks of the actor's rank or below, or made by the actor
  // (splitLiftableRefs): the earlier block of someone senior keeps its tombstones, and the answer says how many stayed.
  const own = accountBlockRef(target.id);
  const matched = (await matchedRefsOf(ctx.db, ctx.env, guildId, await accountKeys(ctx.db, target.id, guildId))).filter((ref) => ref !== own);
  const split = await splitLiftableRefs(ctx.db, guildId, matched, { owner: await isOwner(ctx.db, guildId, guildContext.userId), rank: guildContext.rank, actorId: guildContext.userId });
  const results = await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'access.restore', entityType: 'user',
      entityId: target.id, before: { blocked: true }, after: { blocked: false },
    }, guard),
    tombstoneDeleteStatement(ctx.db, { guildId, blockRefs: [own], guard }),
    ...liftTombstoneStatements(ctx.db, { guildId, actorId: guildContext.userId, split, guard }),
    ctx.db.prepare(`DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND ${guard.sql}`)
      .bind(guildId, target.id, ...guard.params),
  ]);
  if (results[results.length - 1].meta.changes !== 1) {
    // Someone else restoring first is fine. If the block is still there, the actor lost the right.
    const still = await ctx.db.prepare('SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?')
      .bind(guildId, target.id).first();
    if (still) throw conflict();
  }
  return peopleReply(ctx, guildContext, split.kept.length ? { tombstonesKept: split.kept.length } : {});
}

// POST /api/guild/:gid/people/:uid/block/keep (lane B7b): an officer decides a block a tombstone match wrote (guild_blocks.pending_review = 1: it ENFORCED from the first moment and
// sat in the review queue, attention kind block_review). Keep makes it a block like any other: the officer becomes `blocked_by`, the account's OWN tombstones are written (the match
// only enforced), the person leaves every team and the upcoming sign-ups are withdrawn (worker/block-effects.js: the match did none of it). Restoring access instead is the existing
// DELETE .../block. The same gate and seniority as blocking: guild.access, strictly senior to the target (never yourself, never the Guild Master), and never the live Owner.
// 404 when the person has no block waiting for review (no row, an unsuspended Owner whose row is ignored, or a block already kept); 409 `conflict` when it changed under the write.
// One batch, every statement under the same guard, the UPDATE last (so the guards read the state before it). Answers like blockPerson: the People payload.
export async function keepBlock(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const model = await loadModel(ctx.db, guildContext);
  const target = model.byId.get(ctx.params.uid);
  if (!target || !target.block || target.block.pending_review !== 1) throw new HttpError(404, 'not_found', 'No block is waiting for review for that person.');
  if (!hierarchyAllows(guildContext, target)) throw new HttpError(403, 'forbidden', 'You cannot decide that person\'s removal.');

  const guildId = guildContext.guild.id;
  const actorId = guildContext.userId;
  const now = ctx.now();
  const plan = await planTombstones(ctx.env, guildId, await accountKeys(ctx.db, target.id, guildId));
  if (plan.missing) ctx.log(MISSING_KEY_LINE);
  const guard = and(
    { sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND pending_review = 1)', params: [guildId, target.id] },
    actorHolds('guild.access', guildId, actorId),
    actorOutranks(guildId, actorId, target.id),
    { sql: `NOT ${ownerSql('?', '?')}`, params: [guildId, target.id, target.id] },
  );
  const results = await ctx.db.batch([
    auditStatement(ctx, {
      guildId, actorUserId: actorId, action: 'block.keep', entityType: 'user', entityId: target.id, before: { pendingReview: true }, after: { pendingReview: false },
    }, guard),
    ...tombstoneInsertStatements(ctx.db, { guildId, blockRef: accountBlockRef(target.id), plan, now, guard }),
    ...(await blockEffectStatements(ctx.db, { guildId, target: { userId: target.id }, nowMs: now, guard })),
    ctx.db.prepare(
      `UPDATE guild_blocks SET pending_review = 0, blocked_by = ?, tombstone_missing = ? WHERE guild_id = ? AND user_id = ? AND pending_review = 1 AND ${guard.sql}`,
    ).bind(actorId, plan.missing ? 1 : 0, guildId, target.id, ...guard.params),
  ]);
  if (results[results.length - 1].meta.changes !== 1) throw conflict();
  return peopleReply(ctx, guildContext);
}
