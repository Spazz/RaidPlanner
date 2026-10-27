import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { mayCreateGuilds } from '../discord.js';
import { hasDiscord } from '../discord-guard.js';
import { newId } from '../ids.js';
import { GUILD_LIMIT_MESSAGE, LIMITS } from '../limits.js';
import { ownPersonStatement } from '../membership.js';
import { hasOwnerSql, legacyClaimClosedSql } from '../owner.js';
import { loadGuildContext } from '../permissions.js';
import { defaultTeamSize } from '../raid-zones.js';
import { viewerFor } from '../redact.js';
import { readManageable } from '../session.js';
import { FOREVER_RULESETS, REGIONS, findRealm, isVersion } from '../realms.js';
import { loadPin } from '../roster-pin.js';
import { rosterOptions } from '../roster-data.js';
import { guildToday, loadApplicationFlags, loadPendingClaims, loadRosterFlags, loadTeamRequestFlags } from '../roster-view.js';
import { loadAttendanceFlags } from '../attendance-store.js';
import { isTeamRosterRow } from '../team-roster.js';
import { loadTeams } from './teams.js';
import { devPayload } from './dev-view-as.js';
import { wrote } from '../d1-changes.js';

const SINGLE_TEAM_NAME = 'Main team';
const MAX_TEAMS_AT_CREATE = LIMITS.teams;
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
  // The roster person who is the viewer's (null when the account is on no roster yet): the member Home and "My profile" open their pages.
  const own = await ownPersonStatement(db, guildContext.guild.id, guildContext.userId).first();
  // The teams the viewer's characters are on, and the team of their Main: the member Home reads its team from these, not from the shell's team picker.
  // Only characters on a team roster count (worker/team-roster.js), the same rule that gives team access (ownTeamIds in permissions.js).
  const ownCharacters = own
    ? ((await db.prepare('SELECT team_id, is_main, core_rank, left_on FROM characters WHERE guild_id = ? AND player_id = ?').bind(guildContext.guild.id, own.id).all()).results || []).filter(isTeamRosterRow)
    : [];
  const mainRow = ownCharacters.find((row) => row.is_main === 1);
  return {
    // The Discord server's id is shown on Guild settings > General (read-only, to the Guild Master only). A guild without Discord has none: null, never the
    // placeholder.
    guild: guildContext.isGuildMaster
      ? { ...guildView(guildContext.guild), discordServerId: hasDiscord(guildContext.guild) ? guildContext.guild.discord_server_id : null }
      : guildView(guildContext.guild),
    teams: await loadTeams(db, guildContext.guild.id, viewerFor(guildContext)),
    me: {
      roles: guildContext.roles, can: guildContext.can, personId: own ? own.id : null,
      mainTeamId: mainRow ? mainRow.team_id : null,
      teamIds: [...new Set(ownCharacters.map((row) => row.team_id).filter(Boolean))],
    },
    rosterOptions: rosterOptions(),
    rosterFlags: await loadRosterFlags(db, guildContext, guildToday(guildContext.guild, nowMs)),
    applicationFlags: await loadApplicationFlags(db, guildContext),
    teamRequestFlags: await loadTeamRequestFlags(db, guildContext),
    attendanceFlags: await loadAttendanceFlags(db, guildContext),
    pendingClaims: await loadPendingClaims(db, guildContext),
  };
}

export async function getGuild(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const payload = await guildPayload(ctx.db, guildContext, ctx.now());
  // Dev "View as": the option lists and the current stand-in, only on a local run with the flag, to a real Guild Master.
  const dev = await devPayload(ctx, guildContext);
  return jsonResponse(dev ? { ...payload, dev } : payload);
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
  // Without an allowlist any Discord account may try; the server it picks must be one it owns or administers (checked below against the sign-in's list).
  if (!mayCreateGuilds(env, session.user.discordId)) {
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
  const made = await db.prepare('SELECT COUNT(*) AS n FROM guilds WHERE created_by = ?').bind(session.user.id).first('n');
  if (made >= LIMITS.guildsPerAccount) throw new HttpError(409, 'guild_limit', GUILD_LIMIT_MESSAGE);

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
        'INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).bind(teamIds[i], guildId, teamName, defaultTeamSize(gameVersion), now)),
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

// PATCH /api/guild/:gid: the Guild Master edits the guild's name, its realm (a realm guild; 409 pinned once the guild is linked to its in-game guild) and its time zone. Everything else about the guild is fixed
// when it is created (game version, region, Discord server, and the ruleset of a Forever guild), because the buff and comp rules, the Battle.net
// lookups and the sign-in all hang on it. Validation is the create route's. One audit row ('guild.update') carries only the values that changed.
const FIXED_FIELDS = Object.freeze({
  gameVersion: 'The game version is set when the guild is created. To change it, create a new guild.',
  region: 'The region is set when the guild is created. To change it, create a new guild.',
  serverId: 'The Discord server is set when the guild is created.',
});

export async function patchGuild(ctx) {
  const { db, body, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  if (!guildContext.isGuildMaster) {
    throw new HttpError(403, 'forbidden', 'Only the Guild Master can change the name, realm or time zone of the guild.');
  }
  const guild = guildContext.guild;
  for (const [field, message] of Object.entries(FIXED_FIELDS)) {
    if (body[field] !== undefined) throw new HttpError(400, 'bad_request', message, { field });
  }
  if (body.name === undefined && body.realm === undefined && body.timeZone === undefined) {
    throw new HttpError(400, 'bad_request', 'Send a name, a realm, a time zone, or any of them.');
  }
  const name = body.name === undefined ? guild.name : cleanText(body.name, 'name', { max: 60 });
  let { realm, realm_slug: realmSlug } = guild;
  if (body.realm !== undefined) {
    if (guild.realm_kind === 'ruleset') {
      throw new HttpError(400, 'bad_request', 'The ruleset is set when the guild is created. To change it, create a new guild.', { field: 'realm' });
    }
    const read = readRealm({ realm: body.realm, region: guild.region }, guild.game_version);
    realm = read.realm;
    realmSlug = read.realmSlug;
    // PINNED (plan "Source/pin" rule 3): once the guild is linked to its in-game guild its Blizzard target is the pin; the realm the guild lives on is not changed here (the name and the
    // time zone are; a re-link after a realm move is the Owner's setup pin, worker/routes/bnet-pin.js).
    if ((realm !== guild.realm || realmSlug !== guild.realm_slug) && (await loadPin(db, guild.id)).touched) {
      throw new HttpError(409, 'pinned', 'This guild is linked to its in-game guild, so its realm cannot be changed here. The Owner can link it again to the same in-game guild.', { field: 'realm' });
    }
  }
  let timeZone = guild.time_zone;
  if (body.timeZone !== undefined) {
    timeZone = canonicalTimeZone(body.timeZone);
    if (!timeZone) throw new HttpError(400, 'bad_request', 'Pick a valid time zone.', { field: 'timeZone' });
  }

  const before = {};
  const after = {};
  if (name !== guild.name) { before.name = guild.name; after.name = name; }
  if (realm !== guild.realm) { before.realm = guild.realm; after.realm = realm; }
  if (timeZone !== guild.time_zone) { before.timeZone = guild.time_zone; after.timeZone = timeZone; }
  if (Object.keys(after).length) {
    await db.batch([
      db.prepare('UPDATE guilds SET name = ?, realm = ?, realm_slug = ?, time_zone = ? WHERE id = ?').bind(name, realm, realmSlug, timeZone, guild.id),
      auditStatement(ctx, { guildId: guild.id, actorUserId: session.user.id, action: 'guild.update', entityType: 'guild', entityId: guild.id, before, after }),
    ]);
  }
  const fresh = await loadGuildContext(db, session.user.id, guild.id, session.viewAs);
  return jsonResponse(await guildPayload(db, fresh, ctx.now()));
}

// POST /api/guild/:gid/claim: a person who may create guilds (worker/discord.js mayCreateGuilds) and manages the guild's Discord server takes a guild
// that has no Guild Master. It needs no existing membership row; it writes one.
export async function claimGuild(ctx) {
  const { db, env, session } = ctx;
  if (!session.user.discordId) {
    throw new HttpError(403, 'not_allowed_to_create', 'Claiming a guild needs a Discord account: connect Discord on Linked accounts first.');
  }
  if (!mayCreateGuilds(env, session.user.discordId)) {
    throw new HttpError(403, 'not_allowed_to_create', 'Claiming a guild is limited to approved accounts for now.');
  }
  const manageable = readManageable(session, ctx.now());
  if (manageable.stale) throw new HttpError(403, 'reauth_required', 'Sign in with Discord again to claim a guild.');

  const guild = await db.prepare('SELECT id, discord_server_id FROM guilds WHERE id = ?').bind(ctx.params.gid).first();
  // A claim runs through the Discord server the claimer manages: a guild without one cannot be claimed this way.
  if (!guild || !hasDiscord(guild) || !manageable.servers.some((server) => server.id === guild.discord_server_id)) {
    throw new HttpError(404, 'not_found', 'That guild does not exist.');
  }
  const userId = session.user.id;
  // CLOSED once the guild has a rank source or an Owner seat (review finding B4b/B5 F1): the seat of such a guild is taken only by its in-game Guild Master (lane B6b part 2b), never
  // by a Discord-server administrator. A guild whose Owner deleted their account (the foreign key empties the seat) stays closed through its rank source.
  const closed = await db.prepare(`SELECT ${legacyClaimClosedSql('?')} AS closed`).bind(guild.id).first();
  if (closed && closed.closed === 1) {
    throw new HttpError(403, 'claim_closed', 'This guild takes its Guild Master from the in-game guild roster, so a Discord server administrator cannot claim it. The in-game Guild Master claims it with Battle.net.');
  }
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
          WHERE NOT ${hasOwnerSql('?')}
            AND NOT ${legacyClaimClosedSql('?')}
            AND NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)`,
      ).bind(rowId, guild.id, userId, userId, now, guild.id, guild.id, guild.id, guild.id, userId),
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
  if (!wrote(results[0])) throw conflict();
  const guildContext = await loadGuildContext(db, userId, guild.id);
  return jsonResponse(await guildPayload(db, guildContext, ctx.now()));
}
