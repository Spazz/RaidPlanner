import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isAllowlisted } from '../discord.js';
import { newId } from '../ids.js';
import { loadGuildContext } from '../permissions.js';
import { readManageable } from '../session.js';
import { loadTeams } from './teams.js';

const REGIONS = ['US', 'EU', 'KR', 'TW'];
const SNOWFLAKE = /^\d{1,25}$/;

export function guildView(row) {
  return {
    id: row.id,
    name: row.name,
    realm: row.realm,
    region: row.region,
    timeZone: row.time_zone,
    gameVersion: row.game_version,
    createdAt: row.created_at,
  };
}

// The body of GET /api/guild/:gid (and of the 201 from POST /api/guild).
export async function guildPayload(db, guildContext) {
  return {
    guild: guildView(guildContext.guild),
    teams: await loadTeams(db, guildContext.guild.id),
    me: { roles: guildContext.roles, can: guildContext.can },
  };
}

export async function getGuild(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  return jsonResponse(await guildPayload(ctx.db, guildContext));
}

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function createGuild(ctx) {
  const { db, env, body, session } = ctx;
  if (!isAllowlisted(env, session.user.discordId)) {
    throw new HttpError(403, 'not_allowed_to_create', 'Creating a guild is limited to approved accounts for now.');
  }
  const manageable = readManageable(session, ctx.now());
  if (manageable.stale) {
    throw new HttpError(403, 'reauth_required', 'Sign in with Discord again to pick a server.');
  }

  const serverId = typeof body.serverId === 'string' ? body.serverId : '';
  if (!SNOWFLAKE.test(serverId)) throw new HttpError(400, 'bad_request', 'Pick a Discord server.', { field: 'serverId' });
  const name = cleanText(body.name, 'name', { max: 60 });
  const realm = cleanText(body.realm, 'realm', { max: 40 });
  const teamName = cleanText(body.teamName, 'teamName', { max: 40 });
  if (!REGIONS.includes(body.region)) throw new HttpError(400, 'bad_request', 'Pick a region.', { field: 'region' });
  if (!validTimeZone(body.timeZone)) throw new HttpError(400, 'bad_request', 'Pick a valid time zone.', { field: 'timeZone' });

  if (!manageable.servers.some((server) => server.id === serverId)) {
    throw new HttpError(403, 'not_allowed_to_create', 'You can only create a guild for a Discord server you own or manage.');
  }
  const taken = await db.prepare('SELECT 1 AS found FROM guilds WHERE discord_server_id = ?').bind(serverId).first();
  if (taken) throw new HttpError(409, 'server_taken', 'That Discord server already has a guild.', { field: 'serverId' });

  const userId = session.user.id;
  const now = ctx.now();
  const guildId = newId('g', ctx.randomBytes);
  const teamId = newId('t', ctx.randomBytes);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO guilds (id, name, realm, region, discord_server_id, time_zone, game_version, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tbc-anniversary', ?, ?)`,
      ).bind(guildId, name, realm, body.region, serverId, body.timeZone, userId, now),
      db.prepare('INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES (?, ?, ?, 25, 0, ?)')
        .bind(teamId, guildId, teamName, now),
      db.prepare(
        `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
         VALUES (?, ?, ?, 'guild_master', NULL, ?, ?)`,
      ).bind(newId('ra', ctx.randomBytes), guildId, userId, userId, now),
      db.prepare(
        `INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, server_id) DO UPDATE SET seen_at = excluded.seen_at`,
      ).bind(userId, serverId, now),
      auditStatement(ctx, {
        guildId, actorUserId: userId, action: 'guild.create', entityType: 'guild', entityId: guildId, after: { teamId },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'server_taken', 'That Discord server already has a guild.', { field: 'serverId' });
    throw error;
  }
  const guildContext = await loadGuildContext(db, userId, guildId);
  return jsonResponse(await guildPayload(db, guildContext), 201);
}
