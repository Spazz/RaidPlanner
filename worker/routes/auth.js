import { HttpError, isUniqueViolation, jsonResponse, redirectResponse, safeEqual, parseCookies } from '../http.js';
import { auditStatement } from '../audit.js';
import { matchAccountAtSignIn } from '../block-tombstones.js';
import { isConfigured as bnetConfigured } from '../battlenet.js';
import {
  authorizeUrl, canonicalOrigin, exchangeCode, fetchDiscordGuilds, fetchDiscordUser,
  creationIsOpen, isConfigured, mayCreateGuilds, revokeToken, serverIconUrl,
} from '../discord.js';
import { botConfigured } from '../discord-bot.js';
import { hasDiscordServerId, serverIdIsDiscordSql } from '../discord-guard.js';
import { syncSignIn } from '../discord-sync.js';
import { findUserByDiscord, loadIdentities, upsertDiscordAccountStatement } from '../identities.js';
import { base64url, isId, newId } from '../ids.js';
import { memberCandidatesSql, memberGuildsStatement, memberSql } from '../membership.js';
import { LIMITS } from '../limits.js';
import { shapeRoles } from '../permissions.js';
import { FOREVER_RULESETS, GAME_VERSIONS, REALMS, REGIONS } from '../realms.js';
import { parsePrefs, personFromSession, toPerson } from '../person.js';
import {
  FRESH_MODE, STATE_COOKIE, claimStateNonce, clearSessionCookie, clearStateCookie, discordStateMode, hashToken, loadSession, newSessionToken,
  presentedToken, readManageable, sessionCookie, signDiscordLinkState, signState, startSessionStatements, stateCookie, verifyDiscordLinkState,
  verifyState,
} from '../session.js';

// Fixed targets inside the app shell (index.html); the hash router reads them. No user input reaches a Location header.
const HOME_REDIRECT = '/#/';
const SIGNIN_REDIRECT = '/#/signin';
const LINKED_REDIRECT = '/#/linked';
const ERROR_REDIRECT = (reason) => `/#/signin?error=${reason}`;
const LINKED_ERROR_REDIRECT = (reason) => `/#/linked?error=${reason}`;

// ---------------------------------------------------------------------------
// Sign in and link

// GET /auth/providers: which sign-in buttons the sign-in page may show (a provider shows only when this server is set up for it).
export function providers(ctx) {
  return jsonResponse({ discord: isConfigured(ctx.env), bnet: bnetConfigured(ctx.env) });
}

// ?mode=link connects Discord to the signed-in account; without it this is the sign-in (and sign-up) with Discord.
export async function login(ctx) {
  const { env } = ctx;
  const url = new URL(ctx.request.url);
  const link = url.searchParams.get('mode') === 'link';
  const canonical = canonicalOrigin(env);
  if (!isConfigured(env)) return redirectResponse(link ? LINKED_ERROR_REDIRECT('not_configured') : ERROR_REDIRECT('discord'));
  if (url.origin !== canonical) return redirectResponse(`${canonical}/auth/login${link ? '?mode=link' : ''}`);
  const nonce = base64url(ctx.randomBytes(16));
  let state;
  if (link) {
    const session = await loadSession(ctx);
    if (!session) return redirectResponse(SIGNIN_REDIRECT);
    // Bound to the member who starts it, so a state copied into another browser is refused there.
    state = await signDiscordLinkState(env, session.user.id, nonce, ctx.now());
  } else {
    state = await signState(env, nonce, ctx.now());
  }
  return redirectResponse(authorizeUrl(env, state), [stateCookie(state)]);
}

// The old guild page address: the app shell lives at / now.
export function guildPageRedirect() {
  return redirectResponse(HOME_REDIRECT);
}

// One callback for both modes. The mode comes from the state alone, and only a state whose MAC checked out for that mode is believed.
export async function callback(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const cookieState = parseCookies(ctx.request.headers.get('Cookie'))[STATE_COOKIE];
  const clear = clearStateCookie();
  const state = url.searchParams.get('state');
  const mode = discordStateMode(state);
  const now = ctx.now();
  const fail = (reason) => redirectResponse(mode === 'link' ? LINKED_ERROR_REDIRECT(reason) : ERROR_REDIRECT(reason), [clear]);
  // B6b seam: the fresh-auth callback replaces this refusal. Until then a fresh-shaped state ends here, before the session, the cookie or the MAC.
  if (mode === FRESH_MODE) return fail('state');

  let session = null;
  if (mode === 'link') {
    session = await loadSession(ctx);
    if (!session) return redirectResponse(ERROR_REDIRECT('state'), [clear]);
  }
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('discord');
  // A state this Worker did not sign for this flow (and, for a link, for THIS member) never reaches an outbound Discord call.
  const genuine = mode === 'link' ? await verifyDiscordLinkState(env, session.user.id, state, now) : await verifyState(env, state, now);
  if (!genuine) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state');
  // Single use: a replayed state is refused here, before the first outbound call (the begin step wrote nothing, the first callback writes the row).
  if (!(await claimStateNonce(db, state, now))) return fail('state');

  let discordUser;
  let servers;
  try {
    const accessToken = await exchangeCode(env, ctx.fetch, code);
    discordUser = await fetchDiscordUser(env, ctx.fetch, accessToken);
    servers = await fetchDiscordGuilds(env, ctx.fetch, accessToken);
    // The token is used only here; revoking it is best effort.
    await revokeToken(env, ctx.fetch, accessToken);
  } catch (error) {
    ctx.log(`${mode === 'link' ? 'link' : 'sign-in'}: Discord step failed: ${error && error.message}`);
    return fail('discord');
  }

  // The servers the account owns or administers, and nothing else of the list (never the permission bits): the session keeps them for 30 minutes
  // so the create page and POST /api/guild can check the server the person picks. Kept for any Discord account when creation is open.
  const manageable = mayCreateGuilds(env, discordUser.id)
    ? servers.filter((server) => server.access).map((server) => ({ id: server.id, name: server.name, icon: server.icon, access: server.access }))
    : null;
  try {
    if (mode === 'signin') return await finishSignin(ctx, discordUser, servers, manageable, clear);
    return await finishLink(ctx, session, discordUser, servers, manageable, clear, fail);
  } catch (error) {
    if (mode === 'link' && isUniqueViolation(error)) return fail('discord_taken');
    ctx.log(`${mode === 'link' ? 'link' : 'sign-in'}: saving failed: ${error && error.message}`);
    return fail('discord');
  }
}

// Replaces the account's servers that have a Raidsmith guild: one JSON parameter, never an IN list. userSql names the account.
function serverStatements(db, userSql, userParams, servers, now, guard = { sql: '1 = 1', params: [] }) {
  return [
    db.prepare(`DELETE FROM user_servers WHERE user_id = ${userSql} AND ${guard.sql}`).bind(...userParams, ...guard.params),
    // Membership is the servers that have a Raidsmith guild (a guild without Discord has no server: serverIdIsDiscordSql).
    db.prepare(
      `INSERT INTO user_servers (user_id, server_id, seen_at)
       SELECT ${userSql}, g.discord_server_id, ? FROM guilds g
        WHERE g.discord_server_id IN (SELECT value FROM json_each(?)) AND ${serverIdIsDiscordSql('g.discord_server_id')} AND ${guard.sql}`,
    ).bind(...userParams, now, JSON.stringify(servers.map((server) => server.id)), ...guard.params),
  ];
}

// Sign in with Discord: the account that holds this Discord ID signs in; a Discord ID nobody holds becomes a NEW account. Either way the browser
// gets a NEW session and the one it presented is deleted (no session fixation).
async function finishSignin(ctx, discordUser, servers, manageable, clear) {
  const { db } = ctx;
  const now = ctx.now();
  const token = newSessionToken(ctx.randomBytes);
  const tokenHash = await hashToken(token);
  const earlier = presentedToken(ctx.request);
  const user = { sql: '(SELECT id FROM users WHERE discord_id = ?)', params: [discordUser.id] };
  await db.batch([
    upsertDiscordAccountStatement(db, { newUserId: newId('u', ctx.randomBytes), discord: discordUser, now }),
    ...serverStatements(db, user.sql, user.params, servers, now),
    ...startSessionStatements(db, { userId: user, tokenHash, earlierHash: earlier ? await hashToken(earlier) : null, now, manageable }),
  ]);
  const signedInAs = await findUserByDiscord(db, discordUser.id);
  // A returning blocked person: a block survives Delete my data, so the new account is matched against the tombstones of every guild it reaches and, on a
  // hit, blocked for review (sec A9-11, worker/block-tombstones.js). Best effort: a failure is logged and never blocks the sign-in.
  if (signedInAs) await matchAccountAtSignIn(ctx, signedInAs);
  // The roles Discord gives in the guilds that mapped them. Best effort: a failure never blocks the sign-in (worker/discord-sync.js).
  if (botConfigured(ctx.env) && signedInAs) await syncSignIn(ctx, signedInAs);
  return redirectResponse(HOME_REDIRECT, [clear, sessionCookie(token)]);
}

// Connect Discord to the signed-in account. A Discord ID that belongs to ANOTHER account is refused (accounts are never merged); so is a second,
// different Discord ID on an account that already has one, and a Discord ID that would put two roster people of one guild on the account.
async function finishLink(ctx, session, discordUser, servers, manageable, clear, fail) {
  const { db } = ctx;
  const userId = session.user.id;
  const now = ctx.now();
  const holder = await findUserByDiscord(db, discordUser.id);
  if (holder && holder !== userId) return fail('discord_taken');
  if (session.user.discordId && session.user.discordId !== discordUser.id) return fail('has_discord');
  const clash = {
    sql: `NOT EXISTS (SELECT 1 FROM players a JOIN players b ON b.guild_id = a.guild_id AND b.id != a.id
                       WHERE a.user_id = ? AND b.discord_user_id = ?)`,
    params: [userId, discordUser.id],
  };
  const stillClear = await db.prepare(`SELECT ${clash.sql} AS clear`).bind(...clash.params).first();
  if (!stillClear || stillClear.clear !== 1) return fail('roster_conflict');

  // The later statements apply only if the account really holds this Discord ID now (the UPDATE is guarded the same way).
  const linked = { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND discord_id = ?)', params: [userId, discordUser.id] };
  const firstLink = !session.user.discordId;
  const results = await db.batch([
    db.prepare(
      `UPDATE users SET discord_id = ?, username = ?, global_name = ?, avatar = ?, last_seen_at = ?
        WHERE id = ? AND (discord_id IS NULL OR discord_id = ?) AND ${clash.sql}`,
    ).bind(discordUser.id, discordUser.username, discordUser.globalName, discordUser.avatar, now, userId, discordUser.id, ...clash.params),
    ...serverStatements(db, '?', [userId], servers, now, linked),
    // The creator's server list lives 30 minutes on this session, like after a sign-in.
    ...(manageable ? [db.prepare(
      `UPDATE sessions SET manageable_servers = ?, manageable_until = ? WHERE token_hash = ? AND ${linked.sql}`,
    ).bind(JSON.stringify(manageable), now + 30 * 60 * 1000, session.tokenHash, ...linked.params)] : []),
    ...(firstLink ? [auditStatement(ctx, {
      guildId: null, actorUserId: userId, action: 'discord.link', entityType: 'user', entityId: userId,
    }, linked)] : []),
  ]);
  if (results[0].meta.changes !== 1) return fail('roster_conflict');
  // The Discord id just joined this account: match it (and the account's other keys) against the tombstones of the guilds it reaches (sec A9-11).
  await matchAccountAtSignIn(ctx, userId);
  await syncSignIn(ctx, userId);
  return redirectResponse(LINKED_REDIRECT, [clear]);
}

// ---------------------------------------------------------------------------
// Account

// The member rule (worker/membership.js) for the guilds' lists below, with the departing or asking user as an expression.
// The Officer who would become Guild Master: earliest assigned_at among current, unblocked members. `userExpr` is the departing user (excluded).
// Only an Officer an officer made by hand counts: a role Discord gives (source 'discord') never decides who owns the guild.
const successorSql = (userExpr) => `SELECT so.user_id FROM role_assignments so
      WHERE so.guild_id = g.id AND so.role_id = 'officer' AND so.source = 'manual' AND so.user_id != ${userExpr}
        AND ${memberSql('so.user_id', 'g.id', 'g.discord_server_id')}
      ORDER BY so.assigned_at, so.id LIMIT 1`;

// Another member can use the guild: somebody besides `userExpr` whom the guild's rank source lets in and who is not blocked (worker/membership.js).
const othersSql = (userExpr) => `EXISTS (SELECT 1 FROM (${memberCandidatesSql('g.id', 'g.discord_server_id')}) oc
         WHERE oc.user_id != ${userExpr} AND ${memberSql('oc.user_id', 'g.id', 'g.discord_server_id')})`;

// Guilds the person leads, split three ways:
//  - handOverFirst: others have joined and the person is still a current member (they must hand over)
//  - autoPromote:   others have joined but the person has left the server or is blocked; the earliest
//                   Officer who is a current member takes over (to = null: no one can, the guild has no GM)
//  - guildsDeleted: nobody else has joined
async function deleteImpact(db, userId) {
  const result = await db.prepare(
    `SELECT g.id, g.name, g.discord_server_id,
            ${othersSql('m.uid')} AS has_others,
            ${memberSql('m.uid', 'g.id', 'g.discord_server_id')} AS self_member,
            (${successorSql('m.uid')}) AS successor_id
       FROM (SELECT ? AS uid) m
       JOIN role_assignments ra ON ra.user_id = m.uid AND ra.role_id = 'guild_master'
       JOIN guilds g ON g.id = ra.guild_id
      ORDER BY g.name, g.id`,
  ).bind(userId).all();
  const rows = result.results;
  const successorIds = [...new Set(rows.map((row) => row.successor_id).filter(Boolean))];
  const people = new Map();
  if (successorIds.length) {
    const found = await db.prepare(
      'SELECT id, discord_id, username, global_name, display_name, avatar FROM users WHERE id IN (SELECT value FROM json_each(?))',
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
    deletedServerIds: rows.filter((row) => row.has_others !== 1 && hasDiscordServerId(row.discord_server_id)).map((row) => row.discord_server_id),
  };
}

// What /auth/me tells the page about starting or claiming a guild (Phase 8). allowed is true when the create page has something to offer:
//   allowlist set    the account is on it (the pilot's override); the page works from the servers the sign-in kept
//   allowlist empty  the account owns or administers a Discord server that is free for a new guild, or one whose guild has no Guild Master
// allowed false carries a reason the page words: needs_discord (the account has no Discord sign-in), not_approved (an allowlist is set and this
// account is not on it), reauth (open creation, and the server list kept from the sign-in has expired), no_server (open creation, and the account
// owns or administers no server that is free).
async function createPayload(ctx) {
  const { db, env, session } = ctx;
  if (!session.user.discordId) return { allowed: false, reason: 'needs_discord' };
  if (!mayCreateGuilds(env, session.user.discordId)) return { allowed: false, reason: 'not_approved' };
  const manageable = readManageable(session, ctx.now());
  let servers = [];
  let claimable = [];
  if (manageable.servers.length) {
    // A stale list was already dropped by loadSession; readManageable returns no servers for it.
    const taken = await db.prepare(
      `SELECT g.id, g.name, g.discord_server_id,
              EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.guild_id = g.id AND ra.role_id = 'guild_master') AS has_master
         FROM guilds g WHERE g.discord_server_id IN (SELECT value FROM json_each(?)) AND ${serverIdIsDiscordSql('g.discord_server_id')}`,
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
  if (creationIsOpen(env) && !servers.length && !claimable.length) {
    return { allowed: false, reason: manageable.stale ? 'reauth' : 'no_server' };
  }
  const created = await db.prepare('SELECT COUNT(*) AS n FROM guilds WHERE created_by = ?').bind(session.user.id).first('n');
  return {
    allowed: true,
    stale: manageable.stale,
    servers,
    claimable,
    limit: { created, max: LIMITS.guildsPerAccount },
    options: { versions: GAME_VERSIONS, regions: REGIONS, realms: REALMS, rulesets: FOREVER_RULESETS },
  };
}

export async function me(ctx) {
  const { db, session, env } = ctx;
  const userId = session.user.id;
  const [guildResult, assignmentResult, removedResult, optOutResult] = await db.batch([
    // My guilds: driven from the account's own rows (its Discord servers, its linked people, the Owner seat), never a pass over every guild.
    memberGuildsStatement(db, userId),
    db.prepare(
      `SELECT ra.guild_id, ra.role_id, ra.team_id, ra.source, r.name AS role_name
         FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = ?`,
    ).bind(userId),
    db.prepare(
      `SELECT g.id, g.name FROM guild_blocks b JOIN guilds g ON g.id = b.guild_id
        WHERE b.user_id = ? ORDER BY g.name, g.id`,
    ).bind(userId),
    db.prepare('SELECT 1 AS found FROM reminder_optouts WHERE user_id = ?').bind(userId),
  ]);
  const guilds = guildResult.results.map((guild) => ({
    id: guild.id,
    name: guild.name,
    realm: guild.realm,
    region: guild.region,
    roles: shapeRoles(assignmentResult.results.filter((row) => row.guild_id === guild.id)),
  }));

  const create = await createPayload(ctx);

  const impact = await deleteImpact(db, userId);
  const identities = await loadIdentities(db, userId);

  return jsonResponse({
    user: { ...personFromSession(session.user), prefs: parsePrefs(session.user.prefs) },
    // The sign-ins linked to this account (null = not linked), and what the Linked accounts page needs besides: the name the person chose
    // (null = none) and which providers this server is set up for. Nothing here is a token, a secret or another person's data.
    identities: { discord: identities.discord, bnet: identities.bnet },
    account: {
      customName: identities.customName, available: { discord: isConfigured(env), bnet: bnetConfigured(env) },
      // "Don't mention me in reminders" (Discord channel reminders list this account by name only).
      reminderOptOut: optOutResult.results.length > 0,
    },
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
        `SELECT 1 AS found FROM guilds g, (SELECT ? AS uid) c WHERE g.id = ? AND ${memberSql('c.uid', 'g.id', 'g.discord_server_id')}`,
      ).bind(session.user.id, body.lastGuildId).first();
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
  const noOthers = (guildId) => ({ sql: `EXISTS (SELECT 1 FROM guilds g WHERE g.id = ? AND NOT ${othersSql('?')})`, params: [guildId, userId] });
  const statements = [
    auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'account.delete', entityType: 'user', entityId: userId }),
    ...expected.map((guildId) => auditStatement(ctx, {
      guildId: null, actorUserId: userId, action: 'guild.delete', entityType: 'guild', entityId: guildId,
    }, noOthers(guildId))),
  ];
  if (expected.length) {
    statements.push(db.prepare(
      `DELETE FROM guilds WHERE id IN (
         SELECT g.id FROM guilds g WHERE g.id IN (SELECT value FROM json_each(?)) AND NOT ${othersSql('?')})`,
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
         SELECT ?, g.id, (${successorSql('?')}), 'guild_master', NULL, NULL, ? FROM guilds g
          WHERE g.id = ? AND (${successorSql('?')}) IS NOT NULL
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
  // The free-text notes this account wrote on Raidsmith sign-ups go with it, whichever sign-in made them (the sign-up itself stays with the guild;
  // updated_by is cleared when the account row goes, so this runs first).
  statements.push(db.prepare("UPDATE raid_signups SET note = NULL WHERE source = 'raidsmith' AND updated_by = ?").bind(userId));
  // The reasons the account wrote on away notices go the same way; the notices stay with the person (they still excuse the raids they covered).
  statements.push(db.prepare('UPDATE away_notices SET reason = NULL WHERE created_by = ?').bind(userId));
  // The applications this account sent go with it (the inbox row is the applicant's own data; a person an officer made from one stays on the roster),
  // and so do the notes it wrote on intent picks (the picks stay with the person).
  statements.push(db.prepare('DELETE FROM applications WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('UPDATE intent_picks SET note = NULL WHERE updated_by = ?').bind(userId));
  // The guest sign-ups the account made on open raids go with it (the row names the character the account typed; guest_user_id would only be unlinked).
  statements.push(db.prepare('DELETE FROM raid_signups WHERE guest = 1 AND guest_user_id = ?').bind(userId));
  // Team requests still waiting go with the account (the decided rows stay, unlinked: requested_by and decided_by are ON DELETE SET NULL).
  statements.push(db.prepare("DELETE FROM team_requests WHERE requested_by = ? AND status = 'pending'").bind(userId));
  // A BLOCK SURVIVES the account (sec A9-05 / A9-11). The tombstones keep what the account PROVED; the keys an officer attested on the person's characters (typed in,
  // matched to the roster by an officer) are the person's, so in every guild where the account is blocked and has a person (linked, or carrying its Discord ID) that
  // person gets a person_blocks marker with the block's blocked_by and reason, and a person.block audit row that keeps the original blocker's rank snapshot. The
  // sign-in match honours the marker (worker/bnet-match.js). These run before the link below is cut and before the account row (and its guild_blocks) goes.
  statements.push(
    db.prepare(
      `INSERT OR IGNORE INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at)
       SELECT b.guild_id, p.id, b.blocked_by, b.reason, b.tombstone_missing, b.created_at FROM guild_blocks b JOIN players p ON p.guild_id = b.guild_id AND (p.user_id = ?1 OR (p.discord_user_id IS NOT NULL AND p.discord_user_id = (SELECT du.discord_id FROM users du WHERE du.id = ?1))) WHERE b.user_id = ?1`,
    ).bind(userId),
    db.prepare(
      `INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role)
       SELECT 'al_' || lower(hex(randomblob(16))), b.guild_id, b.blocked_by, 'person.block', 'person', p.id, NULL, '{"blocked":true,"viaAccountDelete":true}', ?2,
              a.actor_short_id, a.actor_role
         FROM guild_blocks b JOIN players p ON p.guild_id = b.guild_id AND (p.user_id = ?1 OR (p.discord_user_id IS NOT NULL AND p.discord_user_id = (SELECT du.discord_id FROM users du WHERE du.id = ?1)))
         LEFT JOIN audit_log a ON a.id = (SELECT x.id FROM audit_log x WHERE x.guild_id = b.guild_id AND x.action = 'access.remove' AND x.entity_id = b.user_id
                                           ORDER BY x.created_at DESC LIMIT 1)
        WHERE b.user_id = ?1 AND EXISTS (SELECT 1 FROM person_blocks pb WHERE pb.guild_id = b.guild_id AND pb.player_id = p.id)`,
    ).bind(userId, now),
  );
  // The roster people linked to this account stay (officers own the roster); the link goes. The version moves so an officer's open page sees it.
  statements.push(db.prepare(
    'UPDATE players SET user_id = NULL, version = version + 1, updated_at = ? WHERE user_id = ?',
  ).bind(now, userId));
  // The Battle.net callback window of the account's Blizzard id (key bnetcb:<id>) goes with it; this reads bnet_links, so it runs before the user row (and its link) is deleted.
  statements.push(db.prepare("DELETE FROM rate_limits WHERE key IN (SELECT 'bnetcb:' || bnet_account_id FROM bnet_links WHERE user_id = ?)").bind(userId));
  // Sessions, servers, roles, blocks, the Battle.net link and the claims cascade; actor columns become NULL (roadmap_ideas.submitted_by too: the ideas stay, unlinked).
  statements.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
  // A person linked through the Discord ID stays too, unlinked; an account that never had Discord has nothing to clear here.
  if (session.user.discordId) {
    statements.push(db.prepare(
      `UPDATE players SET discord_user_id = NULL, discord_nickname = NULL, version = version + 1, updated_at = ?
        WHERE discord_user_id = ?`,
    ).bind(now, session.user.discordId));
    // Raid sign-ups keep the person link (outcomes recompute the same) but lose the Discord ID and nickname.
    statements.push(db.prepare('UPDATE raid_signups SET discord_user_id = NULL, nickname = NULL WHERE discord_user_id = ?').bind(session.user.discordId));
  }
  statements.push(db.prepare('DELETE FROM rate_limits WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(`w:${userId}`, `imp:${userId}`, `wclraid:${userId}`, `idea:${userId}`, `bnet:${userId}`, `acct:${userId}`, `exp:${userId}`, `rsync:${userId}`, `char:${userId}`, `open:${userId}`));
  await db.batch(statements);
  return jsonResponse({ ok: true }, 200, {}, [clearSessionCookie()]);
}
