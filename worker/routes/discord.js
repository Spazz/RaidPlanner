// Guild settings > Discord roles: the bot invite link, the guild's Discord roles, and which Raidsmith role each one gives.
//   GET  /api/guild/:gid/discord        (guild.roles)  bot status, the server's roles, the mapping, and what a role can be mapped to
//   PUT  /api/guild/:gid/discord/maps   (guild.roles)  replace the whole mapping
//   POST /api/guild/:gid/discord/sync   (guild.access) Sync everyone who signed in, 25 people per call (repeat with `next` until it is null)
// One Raidsmith role per Discord role; a person with several mapped Discord roles gets all of them. The mapping is applied at every sign-in and by
// Sync now (worker/discord-sync.js). The Guild Master cannot be mapped; @everyone is not offered (everyone in the server is a Member already).
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { botConfigured, fetchServerRoles, inviteUrl } from '../discord-bot.js';
import { requireDiscord } from '../discord-guard.js';
import { discordProblem, syncGuildMembers } from '../discord-sync.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import { assertMayGrant, loadRolesData } from '../roles-store.js';

const SNOWFLAKE = /^\d{1,25}$/;
const TEAM_ID = /^t_[A-Za-z0-9_-]{22}$/;
const MAX_MAPS = 250;
const STAFF_TARGETS = [{ roleId: 'officer', name: 'Officer' }, { roleId: 'team_lead', name: 'Team Lead' }];

const bad = (message, field) => new HttpError(400, 'bad_request', message, field ? { field } : {});

const tupleKey = (roleId, teamId) => `${roleId}|${teamId || ''}`;

// The (role, team) tuples whose set of Discord roles differs between two mappings: [{ discordRoleId, roleId, teamId }] -> ['officer|', 'team_lead|t_..'].
function changedTuples(before, after) {
  const sets = (maps) => {
    const out = new Map();
    for (const map of maps) {
      const key = tupleKey(map.roleId, map.teamId);
      out.set(key, [...(out.get(key) || []), map.discordRoleId].sort().join(','));
    }
    return out;
  };
  const was = sets(before);
  const now = sets(after);
  return [...new Set([...was.keys(), ...now.keys()])].filter((key) => was.get(key) !== now.get(key));
}

async function loadMaps(db, guildId) {
  const result = await db.prepare(
    'SELECT discord_role_id, role_id, team_id FROM discord_role_maps WHERE guild_id = ? ORDER BY discord_role_id',
  ).bind(guildId).all();
  return result.results.map((row) => ({ discordRoleId: row.discord_role_id, roleId: row.role_id, teamId: row.team_id }));
}

// What a Discord role can be mapped to: Officer, Team Lead (for a team) and the guild's own roles; needsTeam says whether the mapping needs a team.
function targetsOf(rolesData) {
  return [
    ...STAFF_TARGETS.map((target) => ({ ...target, needsTeam: rolesData.needsTeam(target.roleId), custom: false })),
    ...rolesData.custom.map((role) => ({ roleId: role.id, name: role.name, needsTeam: rolesData.needsTeam(role.id), custom: true })),
  ];
}

export async function getDiscord(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const guild = guildContext.guild;
  requireDiscord(guild); // a guild without a Discord server has no roles to read and no bot to invite
  const [maps, rolesData] = await Promise.all([loadMaps(ctx.db, guild.id), loadRolesData(ctx.db, guild.id)]);
  // inServer: true/false once the bot has answered, null when it could not be asked (no token, or Discord did not answer).
  const bot = { configured: botConfigured(ctx.env), inviteUrl: inviteUrl(ctx.env, guild.discord_server_id), inServer: null, problem: null };
  let roles = [];
  if (bot.configured) {
    const result = await fetchServerRoles(ctx.env, ctx.fetch, guild.discord_server_id);
    if (result.ok) {
      bot.inServer = true;
      roles = result.roles;
    } else {
      bot.inServer = result.reason === 'bot_missing' ? false : null;
      bot.problem = result.reason;
    }
  }
  return jsonResponse({ bot, roles, maps, targets: targetsOf(rolesData) });
}

// The mapping as sent: [{ discordRoleId, roleId, teamId }] -> the same, checked against this guild.
function readMaps(body) {
  if (!Array.isArray(body.maps) || body.maps.length > MAX_MAPS) throw bad(`maps must be a list of at most ${MAX_MAPS} entries.`, 'maps');
  const seen = new Set();
  return body.maps.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.discordRoleId !== 'string' || !SNOWFLAKE.test(entry.discordRoleId)) {
      throw bad('Each entry needs a Discord role id.', 'maps');
    }
    if (typeof entry.roleId !== 'string') throw bad('Each entry needs a Raidsmith role.', 'maps');
    if (entry.teamId !== null && entry.teamId !== undefined && !(typeof entry.teamId === 'string' && TEAM_ID.test(entry.teamId))) throw bad('teamId must be a team.', 'maps');
    if (seen.has(entry.discordRoleId)) throw bad('A Discord role can be mapped once.', 'maps');
    seen.add(entry.discordRoleId);
    return { discordRoleId: entry.discordRoleId, roleId: entry.roleId, teamId: entry.teamId || null };
  });
}

export async function putMaps(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.roles');
  const guild = guildContext.guild;
  requireDiscord(guild);
  const maps = readMaps(ctx.body);
  const rolesData = await loadRolesData(ctx.db, guild.id);
  const targets = new Map(targetsOf(rolesData).map((target) => [target.roleId, target]));
  for (const map of maps) {
    // @everyone has the server's id: everyone is a Member already, and mapping it would hand a role to the whole server.
    if (map.discordRoleId === guild.discord_server_id) throw bad('@everyone cannot be mapped.', 'maps');
    const target = targets.get(map.roleId);
    if (!target) throw bad(map.roleId === 'guild_master' ? 'The Guild Master cannot be given by a Discord role.' : 'That Raidsmith role cannot be mapped.', 'maps');
    if (target.needsTeam !== (map.teamId !== null)) {
      throw bad(target.needsTeam ? `${target.name} is given for one team: pick the team.` : `${target.name} is for the whole guild: leave the team out.`, 'maps');
    }
    assertMayGrant(guildContext, rolesData, map.roleId, map.teamId);
  }
  const teamIds = [...new Set(maps.map((map) => map.teamId).filter(Boolean))];
  if (teamIds.length) {
    const valid = await ctx.db.prepare(
      'SELECT id FROM teams WHERE guild_id = ? AND archived = 0 AND id IN (SELECT value FROM json_each(?))',
    ).bind(guild.id, JSON.stringify(teamIds)).all();
    if (valid.results.length !== teamIds.length) throw bad('One of those teams does not exist or is archived.', 'maps');
  }

  const before = await loadMaps(ctx.db, guild.id);
  const actorId = guildContext.userId;
  const statements = [
    auditStatement(ctx, { guildId: guild.id, actorUserId: actorId, action: 'discord.maps', entityType: 'guild', entityId: guild.id, before: { maps: before }, after: { maps } }),
    ctx.db.prepare('DELETE FROM discord_role_maps WHERE guild_id = ?').bind(guild.id),
    ...(maps.length ? [ctx.db.prepare(
      `INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id)
       SELECT ?, json_extract(value, '$.discordRoleId'), json_extract(value, '$.roleId'), json_extract(value, '$.teamId') FROM json_each(?)`,
    ).bind(guild.id, JSON.stringify(maps))] : []),
    // What Discord gave through a mapping that changed goes at once: a Raidsmith role (and team) whose set of Discord roles is no longer the same
    // (dropped, re-pointed to another Discord role, or one of two removed) is cleared for everybody, and the next sign-in or Sync now gives it back to
    // those who still hold a mapped Discord role. Roles set by hand are never touched.
    ctx.db.prepare(
      `DELETE FROM role_assignments
        WHERE guild_id = ? AND source = 'discord'
          AND (role_id || '|' || COALESCE(team_id, '')) IN (SELECT value FROM json_each(?))`,
    ).bind(guild.id, JSON.stringify(changedTuples(before, maps))),
  ];
  let results;
  try {
    results = await ctx.db.batch(statements);
  } catch {
    // A role or team deleted while the request ran (the foreign keys refuse a mapping to something that is gone).
    throw new HttpError(409, 'conflict', 'A role or team changed while you were working on it. Reload and try again.');
  }
  return jsonResponse({ maps: await loadMaps(ctx.db, guild.id), cleared: results[results.length - 1].meta.changes });
}

export async function syncEveryone(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  requireDiscord(guildContext.guild);
  if (!botConfigured(ctx.env)) throw discordProblem('not_configured');
  const after = ctx.body.after === undefined || ctx.body.after === null ? '' : ctx.body.after;
  if (typeof after !== 'string' || (after !== '' && !/^u_[A-Za-z0-9_-]{22}$/.test(after))) throw bad('after must be a person id from the previous call.', 'after');
  const has = await ctx.db.prepare('SELECT COUNT(*) AS n FROM discord_role_maps WHERE guild_id = ?').bind(guildContext.guild.id).first('n');
  if (!has) throw new HttpError(409, 'no_mapping', 'Map a Discord role to a Raidsmith role first (Guild settings > Discord roles).');
  const summary = await syncGuildMembers(ctx, guildContext.guild, { actorId: guildContext.userId, after });
  // A problem that stopped the run before anyone was read is the answer; after some were, the counts and the problem go back together.
  if (summary.problem && summary.changed + summary.unchanged === 0) throw discordProblem(summary.problem);
  return jsonResponse(summary);
}
