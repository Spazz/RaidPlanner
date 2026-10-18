// A member's side of Battle.net: sign in or sign up with it, link it to an account (OAuth with a signed state: user-bound for a link, mode-bound
// for a sign-in), disconnect, the characters the link found, and the claims they make on those characters. The access token lives only inside the
// callback. Of what Battle.net gave, the account number and BattleTag are the account's sign-in identity (refreshed at every Battle.net sign-in or
// link, kept while linked); the character snapshot is the data under Blizzard's 30-day rule.
import { HttpError, isUniqueViolation, jsonResponse, parseCookies, redirectResponse, safeEqual } from '../http.js';
import { auditStatement } from '../audit.js';
import {
  BnetError, authorizeUrl, bnetSupport, canonicalOrigin, exchangeCode, fetchAccountCharacters, fetchUserInfo, isConfigured,
} from '../battlenet.js';
import { CLAIM_BATCH_MAX, DATA_TTL_MS, loadMemberGuilds, parseSnapshot, realmDisplayName } from '../bnet-store.js';
import { bnetNameOf, findUserByBnet, hasDiscordSql, insertBnetAccountStatement } from '../identities.js';
import { base64url, isId, newId } from '../ids.js';
import { isOwnPlayer } from '../membership.js';
import { loadGuildContext } from '../permissions.js';
import { checkRateLimit } from '../ratelimit.js';
import { cleanCharacterName, nameKey } from '../roster-data.js';
import {
  BNET_STATE_COOKIE, bnetStateCookie, bnetStateMode, clearBnetStateCookie, hashToken, loadSession, newSessionToken, presentedToken, sessionCookie,
  signBnetSigninState, signBnetState, startSessionStatements, verifyBnetSigninState, verifyBnetState,
} from '../session.js';
import { bad, resolveRealm } from './roster.js';
import { viewerOf } from '../roster-view.js';

// Fixed targets inside the app shell; the hash router reads them. No user input reaches a Location header.
const SIGNIN_REDIRECT = '/#/signin';
const HOME_REDIRECT = '/#/';
const CHARACTERS_REDIRECT = '/#/characters';
const linkedRedirect = (reason) => `/#/linked?error=${reason}`;
const signinRedirect = (reason) => `/#/signin?error=${reason}`;
const MAX_COMBOS = 8;
const MAX_PENDING_PER_GUILD = 20;
const LINK_LIMIT = 10;
const LINK_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Link

// ?mode=signin starts a sign-in or sign-up (nobody needs to be signed in); without it the signed-in member links Battle.net to their account.
export async function bnetLogin(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const signin = url.searchParams.get('mode') === 'signin';
  const failTo = signin ? signinRedirect : linkedRedirect;
  let session = null;
  if (!signin) {
    session = await loadSession(ctx);
    if (!session) return redirectResponse(SIGNIN_REDIRECT);
  }
  if (!isConfigured(env)) return redirectResponse(failTo('not_configured'));
  const canonical = canonicalOrigin(env);
  if (url.origin !== canonical) return redirectResponse(`${canonical}/auth/bnet/login${signin ? '?mode=signin' : ''}`);
  if (signin) {
    const state = await signBnetSigninState(env, base64url(ctx.randomBytes(16)));
    return redirectResponse(authorizeUrl(env, state), [bnetStateCookie(state)]);
  }
  const limit = await checkRateLimit(db, session.user.id, ctx.now(), { key: `bnet:${session.user.id}`, limit: LINK_LIMIT, windowMs: LINK_WINDOW_MS });
  if (limit.limited) return redirectResponse(linkedRedirect('busy'));
  const state = await signBnetState(env, session.user.id, base64url(ctx.randomBytes(16)));
  return redirectResponse(authorizeUrl(env, state), [bnetStateCookie(state)]);
}

// The distinct profile namespaces (game version + region) among the person's guilds, with Battle.net support: [{ key, version, region, namespace }].
function namespacesOf(guilds) {
  const found = new Map();
  for (const guild of guilds) {
    const support = bnetSupport(guild.game_version, guild.region);
    if (support.supported && !found.has(support.namespace)) {
      found.set(support.namespace, { namespace: support.namespace, version: guild.game_version, region: guild.region });
    }
  }
  return [...found.values()].slice(0, MAX_COMBOS);
}

// The account's characters in each profile namespace among `guilds` -> the snapshot ({ namespace: { fetchedAt, characters | error } }). The
// token is used for these calls and nowhere else. A namespace that fails is recorded as such; the sign-in or link still stands.
async function buildSnapshot(ctx, accessToken, guilds, now) {
  const results = await Promise.all(namespacesOf(guilds).map(async (combo) => {
    try {
      const found = await fetchAccountCharacters(ctx, accessToken, combo.region, combo.namespace);
      return {
        namespace: combo.namespace,
        entry: {
          fetchedAt: now,
          characters: found.map((character) => ({
            name: character.name,
            realm: realmDisplayName(combo.version, combo.region, character.realmSlug, character.realmName),
            realmSlug: character.realmSlug,
            class: character.class,
            level: character.level,
          })),
        },
      };
    } catch (error) {
      ctx.log(`bnet: ${combo.namespace} failed: ${error && error.message}`);
      return { namespace: combo.namespace, entry: { fetchedAt: now, error: error instanceof BnetError && error.kind === 'denied' ? 'denied' : 'unavailable' } };
    }
  }));
  const snapshot = {};
  for (const result of results) snapshot[result.namespace] = result.entry;
  return snapshot;
}

// One callback for both modes. The mode comes from the state alone, and only a state whose MAC checked out for that mode is believed.
export async function bnetCallback(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get('state');
  const mode = bnetStateMode(state);
  const clear = clearBnetStateCookie();
  const fail = (reason) => redirectResponse((mode === 'signin' ? signinRedirect : linkedRedirect)(reason), [clear]);
  let session = null;
  if (mode === 'link') {
    session = await loadSession(ctx);
    if (!session) return redirectResponse(SIGNIN_REDIRECT, [clear]);
  }
  const cookieState = parseCookies(ctx.request.headers.get('Cookie'))[BNET_STATE_COOKIE];
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('not_configured');
  // A state this Worker did not sign for this flow (and, for a link, for THIS member) never reaches an outbound Battle.net call.
  const genuine = mode === 'signin' ? await verifyBnetSigninState(env, state) : await verifyBnetState(env, session.user.id, state);
  if (!genuine) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state');

  let info;
  let snapshot;
  const now = ctx.now();
  try {
    const accessToken = await exchangeCode(ctx, code);
    info = await fetchUserInfo(ctx, accessToken);
    // Whose characters to look for: the member linking, or whoever already signs in with this Battle.net account (nobody yet: a new account).
    const userId = mode === 'link' ? session.user.id : await findUserByBnet(db, info.id);
    snapshot = await buildSnapshot(ctx, accessToken, userId ? await loadMemberGuilds(db, userId) : [], now);
  } catch (error) {
    ctx.log(`bnet ${mode}: Battle.net step failed: ${error && error.message}`);
    return fail('bnet');
  }

  try {
    if (mode === 'signin') return await finishSignin(ctx, info, snapshot, now, clear);
    // The same Battle.net account again refreshes its link; a DIFFERENT one never replaces it (disconnect first): swapping the sign-in of an
    // account is not something a stolen session should be able to do in one step. The rows after the first apply only if the link is this one.
    const here = { sql: 'EXISTS (SELECT 1 FROM bnet_links WHERE user_id = ? AND bnet_account_id = ?)', params: [session.user.id, info.id] };
    const saved = await db.batch([
      db.prepare(
        `INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET battletag = excluded.battletag,
           linked_at = excluded.linked_at, snapshot = excluded.snapshot, snapshot_at = excluded.snapshot_at
         WHERE bnet_links.bnet_account_id = excluded.bnet_account_id`,
      ).bind(session.user.id, info.id, info.battletag, now, JSON.stringify(snapshot), now),
      // An account without Discord is named after its BattleTag; a new BattleTag renames it.
      db.prepare(`UPDATE users SET username = ? WHERE id = ? AND discord_id IS NULL AND ${here.sql}`)
        .bind(bnetNameOf(info.battletag), session.user.id, ...here.params),
      auditStatement(ctx, { guildId: null, actorUserId: session.user.id, action: 'bnet.link', entityType: 'user', entityId: session.user.id }, here),
    ]);
    if (saved[0].meta.changes !== 1) return fail('has_bnet');
  } catch (error) {
    if (isUniqueViolation(error)) return fail('taken');
    ctx.log(`bnet ${mode}: saving failed: ${error && error.message}`);
    return fail('bnet');
  }
  return redirectResponse(CHARACTERS_REDIRECT, [clear]);
}

// Sign in with Battle.net: the account that holds this Battle.net account signs in (its BattleTag and snapshot refreshed); a Battle.net
// account nobody holds becomes a NEW account. Either way the browser gets a NEW session and the one it presented is deleted.
async function finishSignin(ctx, info, snapshot, now, clear) {
  const { db } = ctx;
  const existingId = await findUserByBnet(db, info.id);
  const userId = existingId || newId('u', ctx.randomBytes);
  const token = newSessionToken(ctx.randomBytes);
  const earlier = presentedToken(ctx.request);
  const writes = existingId
    ? [
      db.prepare('UPDATE bnet_links SET battletag = ?, snapshot = ?, snapshot_at = ? WHERE user_id = ? AND bnet_account_id = ?')
        .bind(info.battletag, JSON.stringify(snapshot), now, userId, info.id),
      db.prepare('UPDATE users SET last_seen_at = ?, username = CASE WHEN discord_id IS NULL THEN ? ELSE username END WHERE id = ?')
        .bind(now, bnetNameOf(info.battletag), userId),
    ]
    : [
      insertBnetAccountStatement(db, { userId, battletag: info.battletag, now }),
      db.prepare('INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, info.id, info.battletag, now, JSON.stringify(snapshot), now),
      auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'bnet.link', entityType: 'user', entityId: userId }),
    ];
  try {
    await db.batch([
      ...writes,
      // The session is for whoever holds this Battle.net account at the moment of writing (a link deleted since the look-up gives no session).
      ...startSessionStatements(db, {
        userId: existingId ? { sql: '(SELECT user_id FROM bnet_links WHERE bnet_account_id = ?)', params: [info.id] } : { sql: '?', params: [userId] },
        tokenHash: await hashToken(token), earlierHash: earlier ? await hashToken(earlier) : null, now, manageable: null,
      }),
    ]);
  } catch (error) {
    // Two first sign-ins with one Battle.net account at once: the second finds the account the first made on its next try.
    ctx.log(`bnet signin: saving failed: ${error && error.message}`);
    return redirectResponse(signinRedirect('bnet'), [clear]);
  }
  return redirectResponse(HOME_REDIRECT, [clear, sessionCookie(token)]);
}

export async function disconnectBnet(ctx) {
  const { db, session } = ctx;
  // The last identity cannot go: the link is deleted only while the account keeps a Discord to sign in with.
  const results = await db.batch([
    db.prepare(`DELETE FROM bnet_links WHERE user_id = ? AND ${hasDiscordSql('?')}`).bind(session.user.id, session.user.id),
    auditStatement(ctx, { guildId: null, actorUserId: session.user.id, action: 'bnet.unlink', entityType: 'user', entityId: session.user.id },
      { sql: 'changes() = 1', params: [] }),
  ]);
  if (results[0].meta.changes === 1) return jsonResponse({ ok: true, removed: true });
  const link = await db.prepare('SELECT 1 AS found FROM bnet_links WHERE user_id = ?').bind(session.user.id).first();
  if (link) {
    throw new HttpError(409, 'last_identity', 'Battle.net is the only way you sign in to this account. Connect Discord first, or delete your data on the privacy page.');
  }
  return jsonResponse({ ok: true, removed: false });
}

// ---------------------------------------------------------------------------
// The member's view: link status and, per guild, the characters they can claim

// Characters of the guild with these name keys -> Map("nameKey|realmKey" -> { discord_user_id, user_id })
async function loadOwners(db, guildId, names) {
  if (!names.length) return new Map();
  const result = await db.prepare(
    `SELECT c.name_key, c.realm_key, p.discord_user_id, p.user_id FROM characters c JOIN players p ON p.id = c.player_id
      WHERE c.guild_id = ? AND c.name_key IN (SELECT value FROM json_each(?))`,
  ).bind(guildId, JSON.stringify(names)).all();
  return new Map(result.results.map((row) => [`${row.name_key}|${row.realm_key}`, row]));
}

// The member's latest claim on each character of the guild -> Map("nameKey|realmKey" -> { id, status }).
async function loadLatestClaims(db, guildId, userId) {
  const result = await db.prepare(
    'SELECT id, name_key, realm_key, status FROM character_claims WHERE guild_id = ? AND user_id = ? ORDER BY created_at, id',
  ).bind(guildId, userId).all();
  return new Map(result.results.map((row) => [`${row.name_key}|${row.realm_key}`, { id: row.id, status: row.status }]));
}

// state: new (not on the roster) | on_roster (on a person nobody linked) | yours (on your person) | taken (on someone else's linked person) | other_realm
// viewer: { userId, discordId } - a person is yours when it is linked to your account or carries your Discord ID.
function characterView(guild, character, owners, viewer, claims) {
  const resolved = resolveRealm(guild, character.realm);
  const base = { name: character.name, realm: character.realm, realmSlug: character.realmSlug, class: character.class, level: character.level };
  if (!resolved) return { ...base, state: 'other_realm', claim: null, claimable: false };
  const key = `${nameKey(character.name)}|${resolved.key}`;
  const owner = owners.get(key);
  let state = 'new';
  if (owner) state = isOwnPlayer(owner, viewer) ? 'yours' : (owner.discord_user_id || owner.user_id ? 'taken' : 'on_roster');
  const claim = claims.get(key) || null;
  return { ...base, state, claim, claimable: (state === 'new' || state === 'on_roster') && !(claim && claim.status === 'pending') };
}

const byLevelThenName = (a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name);

export async function getBnet(ctx) {
  const { db, env, session } = ctx;
  const link = await db.prepare('SELECT battletag, linked_at, snapshot, snapshot_at FROM bnet_links WHERE user_id = ?').bind(session.user.id).first();
  const snapshot = link ? parseSnapshot(link.snapshot) : {};
  // A snapshot past Blizzard's 30 days is not shown even before the daily purge clears it; the link itself (the sign-in identity) stays.
  const expired = link ? link.snapshot_at + DATA_TTL_MS <= ctx.now() : false;
  const guilds = [];
  for (const guild of await loadMemberGuilds(db, session.user.id)) {
    const support = bnetSupport(guild.game_version, guild.region);
    const view = {
      guildId: guild.id, guildName: guild.name, gameVersion: guild.game_version, region: guild.region, realm: guild.realm, realmKind: guild.realm_kind,
      supportLabel: support.label, status: 'ok', message: null, characters: [],
    };
    guilds.push(view);
    if (!support.supported) { view.status = 'unsupported'; view.message = support.message; continue; }
    if (!link) { view.status = 'not_linked'; continue; }
    if (expired) { view.status = 'expired'; continue; }
    const entry = snapshot[support.namespace];
    if (!entry) { view.status = 'needs_refresh'; continue; }
    if (entry.error) { view.status = 'unavailable'; continue; }
    const characters = Array.isArray(entry.characters) ? entry.characters : [];
    const [owners, claims] = await Promise.all([
      loadOwners(db, guild.id, [...new Set(characters.map((character) => nameKey(character.name)))]),
      loadLatestClaims(db, guild.id, session.user.id),
    ]);
    view.characters = characters.map((character) => characterView(guild, character, owners, viewerOf(ctx), claims)).sort(byLevelThenName);
  }
  return jsonResponse({
    configured: isConfigured(env),
    link: link ? { battletag: link.battletag, linkedAt: link.linked_at, fetchedAt: link.snapshot_at, expiresAt: link.snapshot_at + DATA_TTL_MS, expired } : null,
    guilds,
  });
}

// ---------------------------------------------------------------------------
// Claims (member side)

export async function createClaims(ctx) {
  const { db, body, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const wanted = body.characters;
  if (!Array.isArray(wanted) || wanted.length < 1 || wanted.length > CLAIM_BATCH_MAX) {
    throw bad(`Pick 1 to ${CLAIM_BATCH_MAX} characters.`, 'characters');
  }
  const support = bnetSupport(guild.game_version, guild.region);
  if (!support.supported) throw new HttpError(409, 'bnet_unsupported', support.message);
  const link = await db.prepare('SELECT snapshot, snapshot_at FROM bnet_links WHERE user_id = ?').bind(session.user.id).first();
  if (!link) throw new HttpError(409, 'bnet_not_linked', 'Connect your Battle.net account first.');
  const entry = link.snapshot_at + DATA_TTL_MS <= ctx.now() ? null : parseSnapshot(link.snapshot)[support.namespace];
  if (!entry || entry.error || !Array.isArray(entry.characters)) {
    throw new HttpError(409, 'bnet_refresh', 'Connect Battle.net again to load your characters for this guild.');
  }

  const seen = new Set();
  const picked = wanted.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.realmSlug !== 'string') {
      throw bad('Pick a character from your list.', 'characters', { index });
    }
    const found = entry.characters.find((character) => nameKey(character.name) === nameKey(raw.name) && character.realmSlug === raw.realmSlug);
    if (!found) throw bad('That character is not on your Battle.net list for this guild.', 'characters', { index });
    const name = cleanCharacterName(found.name);
    const realm = resolveRealm(guild, found.realm);
    if (!name) throw bad('That character name cannot be added to a roster.', 'characters', { index });
    if (!realm) throw bad('That character is on a different realm than this guild.', 'characters', { index });
    const key = `${nameKey(name)}|${realm.key}`;
    if (seen.has(key)) throw bad('That character is in the list twice.', 'characters', { index });
    seen.add(key);
    return { index, name, realm, character: found, key };
  });

  const [owners, pending, open] = await Promise.all([
    loadOwners(db, guild.id, picked.map((entryRow) => nameKey(entryRow.name))),
    db.prepare("SELECT name_key, realm_key FROM character_claims WHERE guild_id = ? AND status = 'pending'").bind(guild.id).all(),
    db.prepare("SELECT COUNT(*) AS n FROM character_claims WHERE guild_id = ? AND user_id = ? AND status = 'pending'").bind(guild.id, session.user.id).first(),
  ]);
  const pendingKeys = new Set(pending.results.map((row) => `${row.name_key}|${row.realm_key}`));
  if (open.n + picked.length > MAX_PENDING_PER_GUILD) {
    throw new HttpError(409, 'claim_limit', `You can have at most ${MAX_PENDING_PER_GUILD} claims waiting for officers in one guild.`);
  }
  for (const item of picked) {
    const owner = owners.get(item.key);
    if (owner && isOwnPlayer(owner, viewerOf(ctx))) {
      throw new HttpError(409, 'already_yours', `${item.name} is already on your record in this guild.`, { field: 'characters', index: item.index });
    }
    if (owner && (owner.discord_user_id || owner.user_id)) {
      throw new HttpError(409, 'name_taken', `${item.name} is already on someone else's record in this guild.`, { field: 'characters', index: item.index });
    }
    if (pendingKeys.has(item.key)) {
      throw new HttpError(409, 'claim_pending', `${item.name} already has a claim waiting for officers.`, { field: 'characters', index: item.index });
    }
  }

  const now = ctx.now();
  const claims = picked.map((item) => ({ id: newId('cl', ctx.randomBytes), item }));
  try {
    await db.batch(claims.flatMap(({ id, item }) => [
      db.prepare(
        `INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(id, guild.id, session.user.id, item.name, nameKey(item.name), item.realm.realm, item.realm.key, item.character.class, item.character.level, now),
      auditStatement(ctx, { guildId: guild.id, actorUserId: session.user.id, action: 'claim.create', entityType: 'claim', entityId: id }),
    ]));
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'claim_pending', 'One of those characters already has a claim waiting for officers.');
    throw error;
  }
  return jsonResponse({
    claims: claims.map(({ id, item }) => ({
      id, name: item.name, realm: item.realm.realm, class: item.character.class, level: item.character.level, status: 'pending',
    })),
  }, 201);
}

export async function withdrawClaim(ctx) {
  const { db, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid);
  if (!isId('cl', ctx.params.clid)) throw new HttpError(404, 'not_found', 'That claim was not found.');
  const results = await db.batch([
    db.prepare("DELETE FROM character_claims WHERE id = ? AND guild_id = ? AND user_id = ? AND status = 'pending'")
      .bind(ctx.params.clid, guildContext.guild.id, session.user.id),
    auditStatement(ctx, {
      guildId: guildContext.guild.id, actorUserId: session.user.id, action: 'claim.withdraw', entityType: 'claim', entityId: ctx.params.clid,
    }, { sql: 'changes() = 1', params: [] }),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(404, 'not_found', 'That claim is not waiting any more.');
  return jsonResponse({ ok: true });
}
