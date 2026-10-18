import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isAllowlisted } from '../discord.js';
import { newId } from '../ids.js';
import { loadGuildContext } from '../permissions.js';
import { readManageable } from '../session.js';
import { FOREVER_RULESETS, REGIONS, findRealm, isVersion } from '../realms.js';
import { rosterOptions } from '../roster-data.js';
import { guildToday, loadRosterFlags } from '../roster-view.js';
import { loadAttendanceFlags } from '../attendance-store.js';
import { loadTeams } from './teams.js';

const SINGLE_TEAM_NAME = 'Main team';
const MAX_TEAMS_AT_CREATE = 10;
const MIN_TEAMS_WHEN_SEVERAL = 2;
const SNOWFLAKE = /^\d{1,25}$/;

export function guildView(row) {
  return {
    id: row.id,
    name: row.name,
    realm: row.realm,
    realmKind: row.realm_kind,
    realmSlug: row.realm_slug,
    region: row.region,
    timeZone: row.time_zone,
    gameVersion: row.game_version,
    createdAt: row.created_at,
  };
}

// The body of GET /api/guild/:gid (and of the 201 from POST /api/guild).
export async function guildPayload(db, guildContext, nowMs = Date.now()) {
  return {
    guild: guildView(guildContext.guild),
    teams: await loadTeams(db, guildContext.guild.id),
    me: { roles: guildContext.roles, can: guildContext.can },
    rosterOptions: rosterOptions(),
    rosterFlags: await loadRosterFlags(db, guildContext, guildToday(guildContext.guild, nowMs)),
    attendanceFlags: await loadAttendanceFlags(db, guildContext),
  };
}

export async function getGuild(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  return jsonResponse(await guildPayload(ctx.db, guildContext, ctx.now()));
}

// IANA names only (Area/Location, UTC, Etc/GMT+5); offsets like "+05:00" are not names.
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// -> the canonical IANA name (what is stored), or null.
function canonicalTimeZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !TIME_ZONE_NAME.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// -> { realm, realmKind, realmSlug } for the chosen version and region.
function readRealm(body, gameVersion) {
  if (gameVersion === 'forever') {
    if (typeof body.realm !== 'string' || !FOREVER_RULESETS.includes(body.realm)) {
      throw new HttpError(400, 'bad_request', 'Pick a ruleset.', { field: 'realm' });
    }
    return { realm: body.realm, realmKind: 'ruleset', realmSlug: null };
  }
  const typed = cleanText(body.realm, 'realm', { max: 64 });
  const listed = findRealm(gameVersion, body.region, typed);
  return { realm: listed ? listed.name : typed, realmKind: 'realm', realmSlug: listed ? listed.slug : null };
}

// -> the team names to create. One team is always "Main team"; several need 2-10 unique names.
function readTeamNames(body) {
  if (typeof body.multipleTeams !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'Say whether your guild runs more than one raid team.', { field: 'multipleTeams' });
  }
  if (!body.multipleTeams) return [SINGLE_TEAM_NAME];
  const raw = body.teamNames;
  if (!Array.isArray(raw) || raw.length < MIN_TEAMS_WHEN_SEVERAL || raw.length > MAX_TEAMS_AT_CREATE) {
    throw new HttpError(400, 'bad_request', `Enter ${MIN_TEAMS_WHEN_SEVERAL} to ${MAX_TEAMS_AT_CREATE} team names.`, { field: 'teamNames' });
  }
  const seen = new Set();
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new HttpError(400, 'bad_request', 'Each team name must be text.', { field: 'teamNames', index });
    }
    let name;
    try {
      name = cleanText(entry, 'teamNames', { max: 40 });
    } catch {
      throw new HttpError(400, 'bad_request', 'Each team name must be 1 to 40 characters of plain text.', { field: 'teamNames', index });
    }
    if (seen.has(name.toLowerCase())) {
      throw new HttpError(400, 'bad_request', 'Each team needs a different name.', { field: 'teamNames', index });
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

export async function createGuild(ctx) {
  const { db, env, body, session } = ctx;
  if (!session.user.discordId) {
    throw new HttpError(403, 'not_allowed_to_create', 'Creating a guild needs a Discord account: connect Discord on Linked accounts first.');
  }
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
  if (!isVersion(body.gameVersion)) throw new HttpError(400, 'bad_request', 'Pick a game version.', { field: 'gameVersion' });
  const gameVersion = body.gameVersion;
  if (!REGIONS.includes(body.region)) throw new HttpError(400, 'bad_request', 'Pick a region.', { field: 'region' });
  const { realm, realmKind, realmSlug } = readRealm(body, gameVersion);
  const teamNames = readTeamNames(body);
  const timeZone = canonicalTimeZone(body.timeZone);
  if (!timeZone) throw new HttpError(400, 'bad_request', 'Pick a valid time zone.', { field: 'timeZone' });

  if (!manageable.servers.some((server) => server.id === serverId)) {
    throw new HttpError(403, 'not_allowed_to_create', 'You can only create a guild for a Discord server you own or manage.');
  }
  const taken = await db.prepare('SELECT 1 AS found FROM guilds WHERE discord_server_id = ?').bind(serverId).first();
  if (taken) throw new HttpError(409, 'server_taken', 'That Discord server already has a guild.', { field: 'serverId' });

  const userId = session.user.id;
  const now = ctx.now();
  const guildId = newId('g', ctx.randomBytes);
  const teamIds = teamNames.map(() => newId('t', ctx.randomBytes));
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO guilds (id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(guildId, name, realm, realmKind, realmSlug, body.region, serverId, timeZone, gameVersion, userId, now),
      ...teamNames.map((teamName, i) => db.prepare(
        'INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES (?, ?, ?, 25, 0, ?)',
      ).bind(teamIds[i], guildId, teamName, now)),
      db.prepare(
        `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
         VALUES (?, ?, ?, 'guild_master', NULL, ?, ?)`,
      ).bind(newId('ra', ctx.randomBytes), guildId, userId, userId, now),
      db.prepare(
        `INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, server_id) DO UPDATE SET seen_at = excluded.seen_at`,
      ).bind(userId, serverId, now),
      auditStatement(ctx, {
        guildId, actorUserId: userId, action: 'guild.create', entityType: 'guild', entityId: guildId, after: { teamId: teamIds[0], teamIds },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'server_taken', 'That Discord server already has a guild.', { field: 'serverId' });
    throw error;
  }
  const guildContext = await loadGuildContext(db, userId, guildId);
  return jsonResponse(await guildPayload(db, guildContext, ctx.now()), 201);
}

// POST /api/guild/:gid/claim: an allowlisted person who manages the guild's Discord server takes a guild
// that has no Guild Master. It needs no existing membership row; it writes one.
export async function claimGuild(ctx) {
  const { db, env, session } = ctx;
  if (!session.user.discordId) {
    throw new HttpError(403, 'not_allowed_to_create', 'Claiming a guild needs a Discord account: connect Discord on Linked accounts first.');
  }
  if (!isAllowlisted(env, session.user.discordId)) {
    throw new HttpError(403, 'not_allowed_to_create', 'Claiming a guild is limited to approved accounts for now.');
  }
  const manageable = readManageable(session, ctx.now());
  if (manageable.stale) throw new HttpError(403, 'reauth_required', 'Sign in with Discord again to claim a guild.');

  const guild = await db.prepare('SELECT id, discord_server_id FROM guilds WHERE id = ?').bind(ctx.params.gid).first();
  if (!guild || !manageable.servers.some((server) => server.id === guild.discord_server_id)) {
    throw new HttpError(404, 'not_found', 'That guild does not exist.');
  }
  const userId = session.user.id;
  const blocked = await db.prepare('SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guild.id, userId).first();
  if (blocked) throw new HttpError(403, 'access_removed', 'An officer has removed your access to this guild.');

  const conflict = () => new HttpError(409, 'conflict', 'That guild already has a Guild Master. Reload and try again.');
  const now = ctx.now();
  // The Guild Master row this request inserts, found by its own id: true only if the INSERT applied.
  const rowId = newId('ra', ctx.randomBytes);
  const inserted = { sql: 'EXISTS (SELECT 1 FROM role_assignments WHERE id = ?)', params: [rowId] };
  let results;
  try {
    results = await db.batch([
      // One guarded INSERT decides; the rows after it follow only if it applied.
      db.prepare(
        `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
         SELECT ?, ?, ?, 'guild_master', NULL, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master')
            AND NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)`,
      ).bind(rowId, guild.id, userId, userId, now, guild.id, guild.id, userId),
      db.prepare(
        `INSERT INTO user_servers (user_id, server_id, seen_at) SELECT ?, ?, ? WHERE ${inserted.sql}
         ON CONFLICT(user_id, server_id) DO UPDATE SET seen_at = excluded.seen_at`,
      ).bind(userId, guild.discord_server_id, now, ...inserted.params),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: userId, action: 'guild.claim', entityType: 'guild', entityId: guild.id,
        after: { guildMasterUserId: userId },
      }, inserted),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict();
    throw error;
  }
  if (results[0].meta.changes !== 1) throw conflict();
  const guildContext = await loadGuildContext(db, userId, guild.id);
  return jsonResponse(await guildPayload(db, guildContext, ctx.now()));
}
