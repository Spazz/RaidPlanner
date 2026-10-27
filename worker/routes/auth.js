import { HttpError, isUniqueViolation, jsonResponse, redirectResponse, safeEqual, parseCookies } from '../http.js';
import { auditStatement } from '../audit.js';
import { matchAccountAtSignIn, tombstoneNewDiscordAccount } from '../block-tombstones.js';
import { isConfigured as bnetConfigured } from '../battlenet.js';
import {
  authorizeUrl, canonicalOrigin, exchangeCode, fetchDiscordGuilds, fetchDiscordUser,
  creationIsOpen, isConfigured, mayCreateGuilds, revokeToken, serverIconUrl,
} from '../discord.js';
import { botConfigured } from '../discord-bot.js';
import { hasDiscordServerId, serverIdIsDiscordSql } from '../discord-guard.js';
import { syncSignIn } from '../discord-sync.js';
import {
  ALWAYS, allOf, beginAccountDelete, beginIdentityChange, freshDoneRoute, freshErrorRoute, freshRequiredError, identityChangeBlocked, identityChangeStatements, isProtectedAccount, noteFreshFailure,
  writeFreshGrant,
} from '../fresh.js';
import { findUserByDiscord, loadIdentities, upsertDiscordAccountStatement } from '../identities.js';
import { base64url, isId, newId } from '../ids.js';
import { memberGuildsStatement, memberSql } from '../membership.js';
import { hasOwnerSql, ownedGuildsSql, ownerSql, seatHeldBySql } from '../owner.js';
import { liveGmSql, manualSeatKeptGuard, officerSuccessorSql, othersExistSql, ruleOf, successionStatements } from '../succession.js';
import { LIMITS } from '../limits.js';
import { shapeRoles } from '../permissions.js';
import { FOREVER_RULESETS, GAME_VERSIONS, REALMS, REGIONS } from '../realms.js';
import { parsePrefs, personFromSession } from '../person.js';
import { VIEWERS, personFor, viewerAtTier } from '../redact.js';
import {
  FRESH_MODE, STATE_COOKIE, claimStateNonce, clearSessionCookie, clearStateCookie, discordStateMode, hashToken, loadSession, newSessionToken,
  presentedToken, readManageable, sessionCookie, signDiscordLinkState, signState, startSessionStatements, stateCookie, verifyDiscordLinkState,
  verifyFreshState, verifyState,
} from '../session.js';
import { wrote } from '../d1-changes.js';

// Fixed targets inside the app shell (index.html); the hash router reads them. No user input reaches a Location header.
const HOME_REDIRECT = '/#/';
const SIGNIN_REDIRECT = '/#/signin';
const LINKED_REDIRECT = '/#/linked';
const ERROR_REDIRECT = (reason) => `/#/signin?error=${reason}`;
const LINKED_ERROR_REDIRECT = (reason) => `/#/linked?error=${reason}`;
// The reader of the successor in the delete dialog is the guild's own Guild Master (the stored one of a guild without a seat) leaving it: the tier that sees an avatar and a handle.
const guildMasterView = viewerAtTier('guild_master');

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
    // A first link on an account that holds the Owner seat or any staff role needs a fresh grant for this change first (worker/fresh.js identity-change protection).
    if (!session.user.discordId && (await identityChangeBlocked({ ...ctx, session }, { userId: session.user.id, change: 'link_discord' }))) return redirectResponse(LINKED_ERROR_REDIRECT('fresh_required'));
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
  // Fresh-auth (worker/fresh.js): its own callback, which never starts or rotates a session.
  if (mode === FRESH_MODE) return discordFreshCallback(ctx, { url, state, cookieState, now, clear });

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

// The fresh-auth callback for Discord: the Discord account that comes back must be the one linked to the signed-in account. It reads the Discord id and nothing else (scope
// identify), never mints or rotates a session, and ends on a fixed app route. Order: session, state cookie (compared with the state), MAC of THIS user and THIS session, the
// age window, the single-use nonce, the exchange, then the grant (worker/fresh.js writeFreshGrant: identity equality, rule (a), the write).
async function discordFreshCallback(ctx, { url, state, cookieState, now, clear }) {
  const { env, db } = ctx;
  const session = await loadSession(ctx);
  if (!session) return redirectResponse(SIGNIN_REDIRECT, [clear]);
  const fail = (reason, purpose = null) => redirectResponse(freshErrorRoute(reason, purpose), [clear]);
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('not_configured');
  const parsed = await verifyFreshState(env, { provider: 'discord', userId: session.user.id, tokenHash: session.tokenHash, state, now });
  if (!parsed) return fail('state');
  if (url.searchParams.get('error')) return fail('denied', parsed.purpose);
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state', parsed.purpose);
  if (!(await claimStateNonce(db, state, now))) return fail('state', parsed.purpose);
  let discordUser;
  try {
    const accessToken = await exchangeCode(env, ctx.fetch, code);
    discordUser = await fetchDiscordUser(env, ctx.fetch, accessToken);
    await revokeToken(env, ctx.fetch, accessToken);
  } catch (error) {
    ctx.log(`fresh-auth: Discord step failed: ${error && error.message}`);
    return fail('provider', parsed.purpose);
  }
  const granted = await writeFreshGrant(ctx, { session, provider: 'discord', identityId: discordUser.id, parsed, nowMs: now });
  if (!granted.ok) {
    await noteFreshFailure(ctx, { userId: session.user.id, guildId: parsed.guildId, purpose: parsed.purpose, reason: granted.reason });
    return fail(granted.reason, parsed.purpose);
  }
  return redirectResponse(freshDoneRoute(parsed.purpose), [clear]);
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
  // A FIRST link is an identity change (worker/fresh.js): an account that holds the Owner seat or any staff role must show a fresh grant for exactly this change (the begin
  // route already asked; this is the authoritative check, inside the batch), and every account's change nulls its grants and is audited in each guild it is a member of.
  // A refresh of the same Discord account is not a change.
  let act = null;
  if (firstLink) {
    try {
      act = await beginIdentityChange({ ...ctx, session }, { userId, change: 'link_discord' });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'fresh_required') return fail('fresh_required');
      throw error;
    }
  }
  const gate = act ? act.guard : ALWAYS;
  const results = await db.batch([
    ...(act ? [
      ...act.statements,
      ...identityChangeStatements(ctx, { userId, provider: 'discord', change: 'link', guard: allOf(gate, { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND discord_id IS NULL)', params: [userId] }) }),
    ] : []),
    db.prepare(
      // discord_linked_at starts with the first link (or a row whose value is missing) and is never moved by a refresh of the same Discord account; unlink clears it.
      // Whether this is a first link or a refresh was decided BEFORE the batch (the grant above belongs to the first link): a refresh only ever updates the account that still holds
      // this very Discord id, so a link removed in between is not silently made again here, without a grant, an audit row or the nulling of other sessions' grants.
      `UPDATE users SET discord_id = ?, username = ?, global_name = ?, avatar = ?, last_seen_at = ?,
              discord_linked_at = CASE WHEN discord_id IS NULL OR discord_linked_at IS NULL THEN ? ELSE discord_linked_at END
        WHERE id = ? AND ${firstLink ? '(discord_id IS NULL OR discord_id = ?)' : 'discord_id = ?'} AND ${clash.sql} AND ${gate.sql}`,
    ).bind(discordUser.id, discordUser.username, discordUser.globalName, discordUser.avatar, now, now, userId, discordUser.id, ...clash.params, ...gate.params),
    ...serverStatements(db, '?', [userId], servers, now, allOf(linked, gate)),
    // The creator's server list lives 30 minutes on this session, like after a sign-in.
    ...(manageable ? [db.prepare(
      `UPDATE sessions SET manageable_servers = ?, manageable_until = ? WHERE token_hash = ? AND ${linked.sql} AND ${gate.sql}`,
    ).bind(JSON.stringify(manageable), now + 30 * 60 * 1000, session.tokenHash, ...linked.params, ...gate.params)] : []),
    ...(firstLink ? [auditStatement(ctx, {
      guildId: null, actorUserId: userId, action: 'discord.link', entityType: 'user', entityId: userId,
    }, allOf(linked, gate))] : []),
  ]);
  if (act && !act.consumed(results)) return fail('fresh_required');
  if (!wrote(results[act ? act.offset + 2 : 0])) return fail(await linkNotWrittenReason(db, { userId, discordId: discordUser.id, firstLink }));
  // A BLOCKED account that links a NEW Discord account (a first link): the new Discord id is tombstoned for each of its blocks, the way a new Battle.net account is (worker/block-tombstones.js).
  if (firstLink) await tombstoneNewDiscordAccount(ctx, { userId, discordId: discordUser.id });
  // The Discord id just joined this account: match it (and the account's other keys) against the tombstones of the guilds it reaches (sec A9-11).
  await matchAccountAtSignIn(ctx, userId);
  await syncSignIn(ctx, userId);
  return redirectResponse(LINKED_REDIRECT, [clear]);
}

// Why the Discord link UPDATE changed no row: a first link by an account that became staff since the read needs its grant (fresh_required); a refresh whose link is gone by now
// (disconnected in another tab) is a lost race, 'state' ("that link expired, connect again"); anything else is the roster clash the check before the batch looks for.
async function linkNotWrittenReason(db, { userId, discordId, firstLink }) {
  if (firstLink) return (await isProtectedAccount(db, userId)) ? 'fresh_required' : 'roster_conflict';
  const held = await db.prepare('SELECT 1 AS found FROM users WHERE id = ? AND discord_id = ?').bind(userId, discordId).first();
  return held ? 'roster_conflict' : 'state';
}

// ---------------------------------------------------------------------------
// Account

// The member rule (worker/membership.js) for the guilds' lists below, with the departing or asking user as an expression.
// The Officer who would become Guild Master: earliest assigned_at among current, unblocked members. `userExpr` is the departing user (excluded).
// Only an Officer an officer made by hand counts: a role Discord gives (source 'discord') and a role the in-game rank gives (source 'ingame') never decide who owns the guild.
// Read from effective_roles_stored (the stored rows with their assignment time; the top view leaves the time out).
const successorSql = (userExpr) => `SELECT so.user_id FROM effective_roles_stored so
      WHERE so.guild_id = g.id AND so.role_id = 'officer' AND so.source = 'manual' AND so.user_id != ${userExpr}
        AND ${memberSql('so.user_id', 'g.id', 'g.discord_server_id')}
      ORDER BY so.assigned_at, so.id LIMIT 1`;

// Another member can use the guild: somebody besides `userExpr` whom the guild's rank source lets in and who is not blocked (worker/membership.js).
const othersSql = (userExpr) => othersExistSql('g.id', 'g.discord_server_id', userExpr);

// Guilds the person leads (the Owner of worker/owner.js: the seat holder, suspended or not, or the stored Guild Master of a guild before the flip), split four ways:
//  - handOverFirst: others have joined and the person is a current member who does not hold the seat (a guild before the flip), or HOLDS THE SEAT AND IS NOT SUSPENDED: they must
//                   hand over first (lane B6b part 2a)
//  - succession:    others have joined and the person holds the seat but is SUSPENDED (an in-game guild, no character of theirs proved by Battle.net on the roster): they cannot hand
//                   over, so the seat passes on inside the delete (worker/succession.js: the live in-game Guild Master, else the earliest live manual Officer, else vacant; lane
//                   B6b part 2b). `to` names who takes it (null = vacant), `rule` why.
//  - autoPromote:   others have joined but the person has left the server or is blocked and holds no seat (a guild before the flip); the earliest
//                   Officer who is a current member takes over (to = null: no one can, the guild has no GM)
//  - guildsDeleted: nobody else has joined
// seatGuildIds: every guild whose seat the person holds that is not handOverFirst; the delete's batch repeats the succession for each of them (it does nothing unless somebody
// else is a member when it runs). deletedServerIds: for the batch (never sent to the browser).
async function deleteImpact(db, userId) {
  const result = await db.prepare(
    `SELECT g.id, g.name, g.discord_server_id, g.rank_source,
            ${othersSql('m.uid')} AS has_others,
            ${memberSql('m.uid', 'g.id', 'g.discord_server_id')} AS self_member,
            ${seatHeldBySql('g.id', 'm.uid')} AS seat_holder,
            ${ownerSql('g.id', 'm.uid')} AS owner_live,
            (${successorSql('m.uid')}) AS successor_id
       FROM (SELECT ?1 AS uid) m
       JOIN (${ownedGuildsSql('?1')}) owned_by_me
       JOIN guilds g ON g.id = owned_by_me.guild_id
      ORDER BY g.name, g.id`,
  ).bind(userId).all();
  const rows = result.results;
  // Who would take the seat of a SUSPENDED seat holder's guild: asked only for those guilds (one more statement for a suspended Owner, none for anyone else).
  const suspendedIds = rows.filter((row) => row.has_others === 1 && row.seat_holder === 1 && row.owner_live !== 1).map((row) => row.id);
  const successors = new Map();
  if (suspendedIds.length) {
    const found = await db.prepare(
      `SELECT g.id, (${liveGmSql('g.id', 'g.discord_server_id', 'm.uid')}) AS gm_id, (${officerSuccessorSql('g.id', 'g.discord_server_id', 'm.uid')}) AS officer_id
         FROM (SELECT ?1 AS uid) m JOIN guilds g ON g.id IN (SELECT value FROM json_each(?2))`,
    ).bind(userId, JSON.stringify(suspendedIds)).all();
    for (const row of found.results) successors.set(row.id, row);
  }
  // Names are looked up only for a guild the account is still a member of (a seat holder who is no member any more is told the rule, never who: the earliest Officer is not public).
  const memberGuildIds = new Set(rows.filter((row) => row.self_member === 1).map((row) => row.id));
  const successorIds = [...new Set([
    ...rows.map((row) => row.successor_id),
    ...[...successors.entries()].filter(([guildId]) => memberGuildIds.has(guildId)).flatMap(([, row]) => [row.gm_id, row.officer_id]),
  ].filter(Boolean))];
  const people = new Map();
  if (successorIds.length) {
    const found = await db.prepare(
      'SELECT id, discord_id, username, global_name, display_name, avatar FROM users WHERE id IN (SELECT value FROM json_each(?))',
    ).bind(JSON.stringify(successorIds)).all();
    for (const row of found.results) people.set(row.id, row);
  }
  const brief = (row) => ({ id: row.id, name: row.name });
  const mustHandOver = (row) => row.has_others === 1 && (row.seat_holder === 1 ? row.owner_live === 1 : row.self_member === 1);
  const successor = (row) => {
    const { gm_id: gmId = null, officer_id: officerId = null } = successors.get(row.id) || {};
    const toId = gmId || officerId || null;
    // to: null = nobody qualifies (the seat stays vacant until the Guild Master in game claims it); { userId: null, name: null } = somebody does but the account is not a member any more.
    return {
      guild: brief(row),
      to: !toId ? null : people.has(toId) && row.self_member === 1 ? { userId: toId, name: personFor(people.get(toId), VIEWERS.lookup).displayName } : { userId: null, name: null },
      rule: ruleOf({ gmId, officerId, rankSource: row.rank_source }),
    };
  };
  return {
    handOverFirst: rows.filter(mustHandOver).map(brief),
    guildsDeleted: rows.filter((row) => row.has_others !== 1).map(brief),
    autoPromote: rows.filter((row) => row.has_others === 1 && row.self_member !== 1 && row.seat_holder !== 1).map((row) => ({
      ...brief(row),
      to: row.successor_id && people.has(row.successor_id) ? personFor(people.get(row.successor_id), guildMasterView) : null,
    })),
    succession: rows.filter((row) => row.has_others === 1 && row.seat_holder === 1 && row.owner_live !== 1).map(successor),
    seatGuildIds: rows.filter((row) => row.seat_holder === 1 && !mustHandOver(row)).map((row) => row.id),
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
              ${hasOwnerSql('g.id')} AS has_master
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
         FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = ?`,
    ).bind(userId),
    db.prepare(
      // A block row on the unsuspended Owner is ignored (worker/membership.js blockedSql), so the account is not told it was removed.
      `SELECT g.id, g.name FROM guild_blocks b JOIN guilds g ON g.id = b.guild_id
        WHERE b.user_id = ? AND NOT ${ownerSql('b.guild_id', 'b.user_id')} ORDER BY g.name, g.id`,
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
    deleteImpact: { handOverFirst: impact.handOverFirst, guildsDeleted: impact.guildsDeleted, autoPromote: impact.autoPromote, succession: impact.succession },
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

// The marker guard (one bare `?`) for a statement that numbers its own placeholders: the same test with the placeholder numbered `n`.
const numbered = (guard, n) => guard.sql.replace('?', `?${n}`);

// 409 hand_over_guild_master: the account holds the Owner seat of guilds that have other members, so the seat must be handed over before the account goes. `guilds` can be empty
// when the state moved once more since the check (the answer is the same).
const handOverFirstError = (guilds) => new HttpError(409, 'hand_over_guild_master', 'Hand the guild over first.', { guilds });

export async function deleteMe(ctx) {
  const { db, session, body } = ctx;
  const userId = session.user.id;
  const impact = await deleteImpact(db, userId);
  if (impact.handOverFirst.length) throw handOverFirstError(impact.handOverFirst);
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
  // A protected account (Owner seat, Officer, Team Lead) or a delete that takes a guild with it needs a fresh sign-in (purpose account_delete): 403 fresh_required without one.
  // The grant is consumed in the batch below and EVERY statement of the batch carries the marker (worker/fresh.js beginAccountDelete), so the delete is all or nothing. The marker is
  // also written only while no MANUAL guild's seat would be left empty (manualSeatKeptGuard: a member who joined after the read; the read refuses the Owner of a guild with members).
  const seatKept = manualSeatKeptGuard(userId);
  const act = await beginAccountDelete(ctx, { userId, deletesGuild: expected.length > 0, extra: seatKept });
  const guard = act.guard;
  // A guild is deleted only while nobody else is a current member (the same test as the impact query).
  const noOthers = (guildId) => ({ sql: `EXISTS (SELECT 1 FROM guilds g WHERE g.id = ? AND NOT ${othersSql('?')})`, params: [guildId, userId] });
  const statements = [
    ...act.statements,
    auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'account.delete', entityType: 'user', entityId: userId }, guard),
    ...expected.map((guildId) => auditStatement(ctx, {
      guildId: null, actorUserId: userId, action: 'guild.delete', entityType: 'guild', entityId: guildId,
    }, allOf(guard, noOthers(guildId)))),
    // A seat holder who is not handing over (suspended), or whose guild gained a member after the read, passes the seat on first (lane B6b part 2b, worker/succession.js).
    ...impact.seatGuildIds.flatMap((guildId) => successionStatements(ctx, { guildId, departingUserId: userId, guard })),
  ];
  if (expected.length) {
    statements.push(db.prepare(
      `DELETE FROM guilds WHERE id IN (
         SELECT g.id FROM guilds g WHERE g.id IN (SELECT value FROM json_each(?)) AND NOT ${othersSql('?')}) AND ${guard.sql}`,
    ).bind(JSON.stringify(expected), userId, ...guard.params));
    // Servers whose guild is gone keep no membership rows (blocked people included).
    statements.push(db.prepare(
      `DELETE FROM user_servers WHERE server_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM guilds WHERE discord_server_id = user_servers.server_id) AND ${guard.sql}`,
    ).bind(JSON.stringify(impact.deletedServerIds), ...guard.params));
  }
  for (const guild of impact.autoPromote) {
    const toId = guild.to ? guild.to.id : null;
    statements.push(
      db.prepare(`DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ? AND ${guard.sql}`).bind(guild.id, userId, ...guard.params),
      db.prepare(
        `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
         SELECT ?, g.id, (${successorSql('?')}), 'guild_master', NULL, NULL, ? FROM guilds g
          WHERE g.id = ? AND (${successorSql('?')}) IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM role_assignments x WHERE x.guild_id = g.id AND x.role_id = 'guild_master') AND ${guard.sql}`,
      ).bind(newId('ra', ctx.randomBytes), userId, now, guild.id, userId, ...guard.params),
      // The new Guild Master does not also keep the Officer row.
      db.prepare(
        `DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'officer'
           AND user_id IN (SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master') AND ${guard.sql}`,
      ).bind(guild.id, guild.id, ...guard.params),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: userId, action: 'guild_master.auto_promote', entityType: 'guild', entityId: guild.id,
        before: { guildMasterUserId: userId }, after: { guildMasterUserId: toId },
      }, allOf(guard, toId
        ? { sql: "EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master' AND user_id = ?)", params: [guild.id, toId] }
        : { sql: "NOT EXISTS (SELECT 1 FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master')", params: [guild.id] })),
    );
  }
  // The free-text notes this account wrote on Raidsmith sign-ups go with it, whichever sign-in made them (the sign-up itself stays with the guild;
  // updated_by is cleared when the account row goes, so this runs first).
  statements.push(db.prepare(`UPDATE raid_signups SET note = NULL WHERE source = 'raidsmith' AND updated_by = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  // The reasons the account wrote on away notices go the same way; the notices stay with the person (they still excuse the raids they covered).
  statements.push(db.prepare(`UPDATE away_notices SET reason = NULL WHERE created_by = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  // The applications this account sent go with it (the inbox row is the applicant's own data; a person an officer made from one stays on the roster),
  // and so do the notes it wrote on intent picks (the picks stay with the person).
  statements.push(db.prepare(`DELETE FROM applications WHERE user_id = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  statements.push(db.prepare(`UPDATE intent_picks SET note = NULL WHERE updated_by = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  // The guest sign-ups the account made on open raids go with it (the row names the character the account typed; guest_user_id would only be unlinked).
  statements.push(db.prepare(`DELETE FROM raid_signups WHERE guest = 1 AND guest_user_id = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  // Team requests still waiting go with the account (the decided rows stay, unlinked: requested_by and decided_by are ON DELETE SET NULL).
  statements.push(db.prepare(`DELETE FROM team_requests WHERE requested_by = ? AND status = 'pending' AND ${guard.sql}`).bind(userId, ...guard.params));
  // A BLOCK SURVIVES the account (sec A9-05 / A9-11). The tombstones keep what the account PROVED; the keys an officer attested on the person's characters (typed in,
  // matched to the roster by an officer) are the person's, so in every guild where the account is blocked and has a person (linked, or carrying its Discord ID) that
  // person gets a person_blocks marker with the block's blocked_by and reason, and a person.block audit row that keeps the original blocker's rank snapshot. The
  // sign-in match honours the marker (worker/bnet-match.js). These run before the link below is cut and before the account row (and its guild_blocks) goes.
  statements.push(
    db.prepare(
      `INSERT OR IGNORE INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at)
       SELECT b.guild_id, p.id, b.blocked_by, b.reason, b.tombstone_missing, b.created_at FROM guild_blocks b JOIN players p ON p.guild_id = b.guild_id AND (p.user_id = ?1 OR (p.discord_user_id IS NOT NULL AND p.discord_user_id = (SELECT du.discord_id FROM users du WHERE du.id = ?1))) WHERE b.user_id = ?1 AND ${numbered(guard, 2)}`,
    ).bind(userId, ...guard.params),
    db.prepare(
      `INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role)
       SELECT 'al_' || lower(hex(randomblob(16))), b.guild_id, b.blocked_by, 'person.block', 'person', p.id, NULL, '{"blocked":true,"viaAccountDelete":true}', ?2,
              a.actor_short_id, a.actor_role
         FROM guild_blocks b JOIN players p ON p.guild_id = b.guild_id AND (p.user_id = ?1 OR (p.discord_user_id IS NOT NULL AND p.discord_user_id = (SELECT du.discord_id FROM users du WHERE du.id = ?1)))
         LEFT JOIN audit_log a ON a.id = (SELECT x.id FROM audit_log x WHERE x.guild_id = b.guild_id AND x.action = 'access.remove' AND x.entity_id = b.user_id
                                           ORDER BY x.created_at DESC LIMIT 1)
        WHERE b.user_id = ?1 AND EXISTS (SELECT 1 FROM person_blocks pb WHERE pb.guild_id = b.guild_id AND pb.player_id = p.id) AND ${numbered(guard, 3)}`,
    ).bind(userId, now, ...guard.params),
  );
  // The roster people linked to this account stay (officers own the roster); the link goes. The version moves so an officer's open page sees it.
  statements.push(db.prepare(
    `UPDATE players SET user_id = NULL, version = version + 1, updated_at = ? WHERE user_id = ? AND ${guard.sql}`,
  ).bind(now, userId, ...guard.params));
  // The rate-limit windows keyed by what the account's rows hold go with it: the Battle.net callback window of its Blizzard id (bnetcb:<id>) and the fresh-start window of each of
  // its sessions (fresh:s:<token hash>). This reads bnet_links and sessions, so it runs before the user row (and with it both) is deleted.
  statements.push(db.prepare(
    `DELETE FROM rate_limits WHERE key IN (SELECT 'bnetcb:' || bnet_account_id FROM bnet_links WHERE user_id = ?1
                                           UNION ALL SELECT 'fresh:s:' || token_hash FROM sessions WHERE user_id = ?1) AND ${numbered(guard, 2)}`,
  ).bind(userId, ...guard.params));
  // Sessions, servers, roles, blocks, the Battle.net link and the claims cascade; actor columns become NULL (roadmap_ideas.submitted_by too: the ideas stay, unlinked).
  statements.push(db.prepare(`DELETE FROM users WHERE id = ? AND ${guard.sql}`).bind(userId, ...guard.params));
  // A person linked through the Discord ID stays too, unlinked; an account that never had Discord has nothing to clear here.
  if (session.user.discordId) {
    statements.push(db.prepare(
      `UPDATE players SET discord_user_id = NULL, discord_nickname = NULL, version = version + 1, updated_at = ?
        WHERE discord_user_id = ? AND ${guard.sql}`,
    ).bind(now, session.user.discordId, ...guard.params));
    // Raid sign-ups keep the person link (outcomes recompute the same) but lose the Discord ID and nickname.
    statements.push(db.prepare(`UPDATE raid_signups SET discord_user_id = NULL, nickname = NULL WHERE discord_user_id = ? AND ${guard.sql}`).bind(session.user.discordId, ...guard.params));
  }
  statements.push(db.prepare(`DELETE FROM rate_limits WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AND ${guard.sql}`)
    .bind(`w:${userId}`, `imp:${userId}`, `wclraid:${userId}`, `idea:${userId}`, `bnet:${userId}`, `acct:${userId}`, `exp:${userId}`, `rsync:${userId}`, `char:${userId}`, `open:${userId}`, `fresh:${userId}`, `users:${userId}`, `usersw:${userId}`, `people:${userId}`, ...guard.params));
  const results = await db.batch(statements);
  if (!act.consumed(results)) {
    // Nothing applied. A manual guild's seat that the delete would have emptied (a member joined after the read) is not a lost grant: say so, and the grant is still good.
    const kept = await db.prepare(`SELECT ${seatKept.sql} AS kept`).bind(...seatKept.params).first();
    if (kept && kept.kept !== 1) throw handOverFirstError((await deleteImpact(db, userId)).handOverFirst);
    throw freshRequiredError('account_delete', {});
  }
  return jsonResponse({ ok: true }, 200, {}, [clearSessionCookie()]);
}
