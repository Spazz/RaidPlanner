import { HttpError, jsonResponse, redirectResponse, safeEqual, parseCookies } from '../http.js';
import { auditStatement } from '../audit.js';
import {
  authorizeUrl, canonicalOrigin, exchangeCode, fetchDiscordGuilds, fetchDiscordUser,
  isAllowlisted, isConfigured, revokeToken, serverIconUrl,
} from '../discord.js';
import { base64url, isId, newId } from '../ids.js';
import { shapeRoles } from '../permissions.js';
import { FOREVER_RULESETS, GAME_VERSIONS, REALMS, REGIONS } from '../realms.js';
import { parsePrefs, personFromSession, toPerson } from '../person.js';
import {
  MANAGEABLE_TTL_MS, SESSION_TTL_MS, STATE_COOKIE, clearSessionCookie, clearStateCookie, hashToken,
  newSessionToken, presentedToken, readManageable, sessionCookie, signState, stateCookie, verifyState,
} from '../session.js';

// Fixed targets inside the app shell (index.html); the hash router reads them. No user input reaches a Location header.
const HOME_REDIRECT = '/#/';
const ERROR_REDIRECT = (reason) => `/#/signin?error=${reason}`;

// ---------------------------------------------------------------------------
// Sign in

export async function login(ctx) {
  const { env } = ctx;
  const canonical = canonicalOrigin(env);
  if (!isConfigured(env)) return redirectResponse(ERROR_REDIRECT('discord'));
  if (new URL(ctx.request.url).origin !== canonical) return redirectResponse(`${canonical}/auth/login`);
  const state = await signState(env, base64url(ctx.randomBytes(16)));
  return redirectResponse(authorizeUrl(env, state), [stateCookie(state)]);
}

// The old guild page address: the app shell lives at / now.
export function guildPageRedirect() {
  return redirectResponse(HOME_REDIRECT);
}

export async function callback(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const cookieState = parseCookies(ctx.request.headers.get('Cookie'))[STATE_COOKIE];
  const clear = clearStateCookie();
  const fail = (reason) => redirectResponse(ERROR_REDIRECT(reason), [clear]);

  const state = url.searchParams.get('state');
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('discord');
  // A state this Worker did not sign never reaches an outbound Discord call.
  if (!await verifyState(env, state)) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state');

  let discordUser;
  let servers;
  try {
    const accessToken = await exchangeCode(env, ctx.fetch, code);
    discordUser = await fetchDiscordUser(env, ctx.fetch, accessToken);
    servers = await fetchDiscordGuilds(env, ctx.fetch, accessToken);
    // The token is used only here; revoking it is best effort.
    await revokeToken(env, ctx.fetch, accessToken);
  } catch (error) {
    ctx.log(`sign-in: Discord step failed: ${error && error.message}`);
    return fail('discord');
  }

  const now = ctx.now();
  const token = newSessionToken(ctx.randomBytes);
  const tokenHash = await hashToken(token);
  const manageable = isAllowlisted(env, discordUser.id)
    ? servers.filter((server) => server.access).map((server) => ({ id: server.id, name: server.name, icon: server.icon, access: server.access }))
    : null;
  const earlier = presentedToken(ctx.request);
  const userByDiscordId = '(SELECT id FROM users WHERE discord_id = ?)';

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO users (id, discord_id, username, global_name, avatar, prefs, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET
           username = excluded.username, global_name = excluded.global_name,
           avatar = excluded.avatar, last_seen_at = excluded.last_seen_at`,
      ).bind(newId('u', ctx.randomBytes), discordUser.id, discordUser.username, discordUser.globalName, discordUser.avatar, now, now),
      // Membership is the servers that have a Raidsmith guild; one JSON parameter, never an IN list.
      db.prepare(`DELETE FROM user_servers WHERE user_id = ${userByDiscordId}`).bind(discordUser.id),
      db.prepare(
        `INSERT INTO user_servers (user_id, server_id, seen_at)
         SELECT ${userByDiscordId}, g.discord_server_id, ? FROM guilds g
          WHERE g.discord_server_id IN (SELECT value FROM json_each(?))`,
      ).bind(discordUser.id, now, JSON.stringify(servers.map((server) => server.id))),
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      // The creator's server list lives 30 minutes; no session keeps one longer.
      db.prepare(
        'UPDATE sessions SET manageable_servers = NULL, manageable_until = NULL WHERE manageable_until IS NOT NULL AND manageable_until <= ?',
      ).bind(now),
      ...(earlier ? [db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(earlier))] : []),
      db.prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, manageable_servers, manageable_until)
         VALUES (?, ${userByDiscordId}, ?, ?, ?, ?)`,
      ).bind(
        tokenHash, discordUser.id, now, now + SESSION_TTL_MS,
        manageable ? JSON.stringify(manageable) : null, manageable ? now + MANAGEABLE_TTL_MS : null,
      ),
    ]);
  } catch (error) {
    ctx.log(`sign-in: saving the session failed: ${error && error.message}`);
    return fail('discord');
  }
  return redirectResponse(HOME_REDIRECT, [clear, sessionCookie(token)]);
}

// ---------------------------------------------------------------------------
// Account

// SQL fragment: the user (a column expression) is a current, unblocked member of the guild.
// One definition feeds both the delete-impact query and the statements the delete batch runs,
// so what /auth/me predicts is what DELETE /auth/me does.
function currentMemberSql(userExpr, guildIdExpr, serverIdExpr) {
  return `(EXISTS (SELECT 1 FROM user_servers us WHERE us.user_id = ${userExpr} AND us.server_id = ${serverIdExpr})
      AND NOT EXISTS (SELECT 1 FROM guild_blocks bl WHERE bl.guild_id = ${guildIdExpr} AND bl.user_id = ${userExpr}))`;
}

// The Officer who would become Guild Master: earliest assigned_at among current, unblocked members.
// `?` is the departing user (excluded).
const SUCCESSOR_SQL = `SELECT so.user_id FROM role_assignments so
      WHERE so.guild_id = g.id AND so.role_id = 'officer' AND so.user_id != ?
        AND ${currentMemberSql('so.user_id', 'g.id', 'g.discord_server_id')}
      ORDER BY so.assigned_at, so.id LIMIT 1`;

const OTHERS_SQL = `EXISTS (SELECT 1 FROM user_servers us
         WHERE us.server_id = g.discord_server_id AND us.user_id != ?
           AND NOT EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = g.id AND b.user_id = us.user_id))`;

// Guilds the person leads, split three ways:
//  - handOverFirst: others have joined and the person is still a current member (they must hand over)
//  - autoPromote:   others have joined but the person has left the server or is blocked; the earliest
//                   Officer who is a current member takes over (to = null: no one can, the guild has no GM)
//  - guildsDeleted: nobody else has joined
async function deleteImpact(db, userId) {
  const result = await db.prepare(
    `SELECT g.id, g.name, g.discord_server_id,
            ${OTHERS_SQL} AS has_others,
            ${currentMemberSql('?', 'g.id', 'g.discord_server_id')} AS self_member,
            (${SUCCESSOR_SQL}) AS successor_id
       FROM guilds g
       JOIN role_assignments ra ON ra.guild_id = g.id AND ra.role_id = 'guild_master' AND ra.user_id = ?
      ORDER BY g.name, g.id`,
  ).bind(userId, userId, userId, userId, userId).all();
  const rows = result.results;
  const successorIds = [...new Set(rows.map((row) => row.successor_id).filter(Boolean))];
  const people = new Map();
  if (successorIds.length) {
    const found = await db.prepare(
      'SELECT id, discord_id, username, global_name, avatar FROM users WHERE id IN (SELECT value FROM json_each(?))',
    ).bind(JSON.stringify(successorIds)).all();
    for (const row of found.results) people.set(row.id, row);
  }
  const brief = (row) => ({ id: row.id, name: row.name });
  return {
    handOverFirst: rows.filter((row) => row.has_others === 1 && row.self_member === 1).map(brief),
    guildsDeleted: rows.filter((row) => row.has_others !== 1).map(brief),
    autoPromote: rows.filter((row) => row.has_others === 1 && row.self_member !== 1).map((row) => ({
      ...brief(row),
      to: row.successor_id && people.has(row.successor_id) ? toPerson(people.get(row.successor_id)) : null,
    })),
    // Server ids of the deleted guilds, for the batch (never sent to the browser).
    deletedServerIds: rows.filter((row) => row.has_others !== 1).map((row) => row.discord_server_id),
  };
}

export async function me(ctx) {
  const { db, session, env } = ctx;
  const userId = session.user.id;
  const [guildResult, assignmentResult, removedResult] = await db.batch([
    db.prepare(
      `SELECT g.id, g.name, g.realm, g.region FROM guilds g
         JOIN user_servers us ON us.server_id = g.discord_server_id AND us.user_id = ?
        WHERE NOT EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = g.id AND b.user_id = ?)
        ORDER BY g.name, g.id`,
    ).bind(userId, userId),
    db.prepare('SELECT guild_id, role_id, team_id FROM role_assignments WHERE user_id = ?').bind(userId),
    db.prepare(
      `SELECT g.id, g.name FROM guild_blocks b JOIN guilds g ON g.id = b.guild_id
        WHERE b.user_id = ? ORDER BY g.name, g.id`,
    ).bind(userId),
  ]);
  const guilds = guildResult.results.map((guild) => ({
    id: guild.id,
    name: guild.name,
    realm: guild.realm,
    region: guild.region,
    roles: shapeRoles(assignmentResult.results.filter((row) => row.guild_id === guild.id)),
  }));

  let create = { allowed: false };
  if (isAllowlisted(env, session.user.discordId)) {
    const manageable = readManageable(session, ctx.now());
    let servers = [];
    let claimable = [];
    if (manageable.servers.length) {
      // A stale list was already dropped by loadSession; readManageable returns no servers for it.
      const taken = await db.prepare(
        `SELECT g.id, g.name, g.discord_server_id,
                EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.guild_id = g.id AND ra.role_id = 'guild_master') AS has_master
           FROM guilds g WHERE g.discord_server_id IN (SELECT value FROM json_each(?))`,
      ).bind(JSON.stringify(manageable.servers.map((server) => server.id))).all();
      const takenIds = new Set(taken.results.map((row) => row.discord_server_id));
      servers = manageable.servers
        .filter((server) => !takenIds.has(server.id))
        .map((server) => ({ id: server.id, name: server.name, iconUrl: serverIconUrl(server.id, server.icon), access: server.access }));
      const serverNames = new Map(manageable.servers.map((server) => [server.id, server.name]));
      claimable = taken.results
        .filter((row) => row.has_master !== 1)
        .map((row) => ({ guildId: row.id, guildName: row.name, serverId: row.discord_server_id, serverName: serverNames.get(row.discord_server_id) || '' }));
    }
    create = {
      allowed: true,
      stale: manageable.stale,
      servers,
      claimable,
      options: { versions: GAME_VERSIONS, regions: REGIONS, realms: REALMS, rulesets: FOREVER_RULESETS },
    };
  }

  const impact = await deleteImpact(db, userId);

  return jsonResponse({
    user: { ...personFromSession(session.user), prefs: parsePrefs(session.user.prefs) },
    guilds,
    create,
    deleteImpact: { handOverFirst: impact.handOverFirst, guildsDeleted: impact.guildsDeleted, autoPromote: impact.autoPromote },
    removedFrom: removedResult.results.map((row) => ({ id: row.id, name: row.name })),
  });
}

export async function updatePrefs(ctx) {
  const { db, session, body } = ctx;
  const prefs = parsePrefs(session.user.prefs);
  let changed = false;
  if (body.sidebarCollapsed !== undefined) {
    if (typeof body.sidebarCollapsed !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'sidebarCollapsed must be true or false.', { field: 'sidebarCollapsed' });
    }
    prefs.sidebarCollapsed = body.sidebarCollapsed;
    changed = true;
  }
  if (body.planSidebarCollapsed !== undefined) {
    if (typeof body.planSidebarCollapsed !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'planSidebarCollapsed must be true or false.', { field: 'planSidebarCollapsed' });
    }
    prefs.planSidebarCollapsed = body.planSidebarCollapsed;
    changed = true;
  }
  if (body.lastGuildId !== undefined) {
    if (body.lastGuildId !== null) {
      const belongs = isId('g', body.lastGuildId) && await db.prepare(
        `SELECT 1 AS found FROM guilds g
           JOIN user_servers us ON us.server_id = g.discord_server_id AND us.user_id = ?
          WHERE g.id = ? AND NOT EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = g.id AND b.user_id = ?)`,
      ).bind(session.user.id, body.lastGuildId, session.user.id).first();
      if (!belongs) throw new HttpError(400, 'bad_request', 'lastGuildId must be a guild you belong to.', { field: 'lastGuildId' });
    }
    prefs.lastGuildId = body.lastGuildId;
    changed = true;
  }
  if (!changed) throw new HttpError(400, 'bad_request', 'Send sidebarCollapsed, planSidebarCollapsed, lastGuildId, or any of them.');
  await db.prepare('UPDATE users SET prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), session.user.id).run();
  return jsonResponse({ prefs });
}

export async function logout(ctx) {
  await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(ctx.session.tokenHash).run();
  return jsonResponse({ ok: true }, 200, {}, [clearSessionCookie()]);
}

export async function deleteMe(ctx) {
  const { db, session, body } = ctx;
  const userId = session.user.id;
  const impact = await deleteImpact(db, userId);
  if (impact.handOverFirst.length) {
    throw new HttpError(409, 'hand_over_guild_master',
      'Hand the Guild Master role to someone else before you delete your data.', { guilds: impact.handOverFirst });
  }
  const echoed = body.deleteGuildIds;
  if (!Array.isArray(echoed) || echoed.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'bad_request', 'deleteGuildIds must be a list of guild ids.', { field: 'deleteGuildIds' });
  }
  const expected = impact.guildsDeleted.map((guild) => guild.id).sort();
  const received = [...new Set(echoed)].sort();
  if (expected.length !== received.length || expected.some((id, i) => id !== received[i])) {
    throw new HttpError(409, 'confirm_mismatch', 'The guilds that would be deleted changed. Review the list and confirm again.',
      { guilds: impact.guildsDeleted });
  }

  const now = ctx.now();
  // A guild is deleted only while nobody else is a current member (the same test as the impact query).
  const noOthers = (guildId) => ({ sql: `EXISTS (SELECT 1 FROM guilds g WHERE g.id = ? AND NOT ${OTHERS_SQL})`, params: [guildId, userId] });
  const statements = [
    auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'account.delete', entityType: 'user', entityId: userId }),
    ...expected.map((guildId) => auditStatement(ctx, {
      guildId: null, actorUserId: userId, action: 'guild.delete', entityType: 'guild', entityId: guildId,
    }, noOthers(guildId))),
  ];
  if (expected.length) {
    statements.push(db.prepare(
      `DELETE FROM guilds WHERE id IN (
         SELECT g.id FROM guilds g WHERE g.id IN (SELECT value FROM json_each(?)) AND NOT ${OTHERS_SQL})`,
    ).bind(JSON.stringify(expected), userId));
    // Servers whose guild is gone keep no membership rows (blocked people included).
    statements.push(db.prepare(
      `DELETE FROM user_servers WHERE server_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM guilds WHERE discord_server_id = user_servers.server_id)`,
    ).bind(JSON.stringify(impact.deletedServerIds)));
  }
  for (const guild of impact.autoPromote) {
    const toId = guild.to ? guild.to.id : null;
    statements.push(
      db.prepare("DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ?").bind(guild.id, userId),
      db.prepare(
        `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
         SELECT ?, g.id, (${SUCCESSOR_SQL}), 'guild_master', NULL, NULL, ? FROM guilds g
          WHERE g.id = ? AND (${SUCCESSOR_SQL}) IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM role_assignments x WHERE x.guild_id = g.id AND x.role_id = 'guild_master')`,
      ).bind(newId('ra', ctx.randomBytes), userId, now, guild.id, userId),
      // The new Guild Master does not also keep the Officer row.
      db.prepare(
        `DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'officer'
           AND user_id IN (SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master')`,
      ).bind(guild.id, guild.id),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: userId, action: 'guild_master.auto_promote', entityType: 'guild', entityId: guild.id,
        before: { guildMasterUserId: userId }, after: { guildMasterUserId: toId },
      }, toId
        ? { sql: "EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ?)", params: [guild.id, toId] }
        : { sql: "NOT EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master')", params: [guild.id] }),
    );
  }
  // The free-text notes this account wrote on Raidsmith sign-ups go with it (the sign-up itself stays with the guild; updated_by is cleared below).
  statements.push(db.prepare("UPDATE raid_signups SET note = NULL WHERE source = 'raidsmith' AND updated_by = ?").bind(userId));
  // Sessions, servers, roles and blocks cascade; actor columns become NULL (roadmap_ideas.submitted_by too: the ideas stay, unlinked).
  statements.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
  // The person on a roster who was linked to this account stays (officers own the roster); the link goes.
  statements.push(db.prepare(
    `UPDATE players SET discord_user_id = NULL, discord_nickname = NULL, version = version + 1, updated_at = ?
      WHERE discord_user_id = ?`,
  ).bind(now, session.user.discordId));
  // Raid sign-ups keep the person link (outcomes recompute the same) but lose the Discord ID and nickname.
  statements.push(db.prepare('UPDATE raid_signups SET discord_user_id = NULL, nickname = NULL WHERE discord_user_id = ?').bind(session.user.discordId));
  statements.push(db.prepare('DELETE FROM rate_limits WHERE key IN (?, ?, ?, ?)').bind(`w:${userId}`, `imp:${userId}`, `wclraid:${userId}`, `idea:${userId}`));
  await db.batch(statements);
  return jsonResponse({ ok: true }, 200, {}, [clearSessionCookie()]);
}
