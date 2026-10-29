// A member's side of Battle.net: sign in or sign up with it, link it to an account (OAuth with a signed state: user-bound for a link, mode-bound
// for a sign-in), disconnect, the characters the link found, and the claims they make on those characters. The access token lives only inside the
// callback. Of what Battle.net gave, the account number and BattleTag are the account's sign-in identity (refreshed at every Battle.net sign-in or
// link, kept while linked); the character snapshot is the data under Blizzard's 30-day rule.
import { HttpError, isUniqueViolation, jsonResponse, parseCookies, redirectResponse, safeEqual } from '../http.js';
import { auditStatement } from '../audit.js';
import {
  BnetError, authorizeUrl, bnetSupport, canonicalOrigin, exchangeCode, fetchAccountCharacters, fetchUserInfo, isConfigured,
} from '../battlenet.js';
import { matchAccountAtSignIn, tombstoneNewBnetAccount } from '../block-tombstones.js';
import { runGmClaim } from '../gm-claim.js';
import { CALLBACK_STATEMENT_BUDGET, clearBnetProofStatement, loadIngameCombos, runBnetMatch } from '../bnet-match.js';
import {
  ALWAYS, allOf, beginIdentityChange, checkFreshIdentity, freshDoneRoute, freshErrorRoute, freshRequiredError, identityChangeBlocked, identityChangeStatements, isProtectedAccount, noteFreshFailure,
  protectedAccountSql, writeFreshGrant,
} from '../fresh.js';
import { CLAIM_BATCH_MAX, DATA_TTL_MS, loadMemberGuilds, parseSnapshot, realmDisplayName } from '../bnet-store.js';
import { bnetNameOf, findUserByBnet, hasBnetSql, hasDiscordSql, insertBnetAccountStatement } from '../identities.js';
import { base64url, isId, newId } from '../ids.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { ownPersonStatement, ownPlayerSql, personStanding } from '../membership.js';
import { loadGuildContext } from '../permissions.js';
import {
  BNET_CALLBACK_BUDGET, BNET_CALLBACK_BUDGET_KEY, BNET_CALLBACK_LIMIT, BNET_CALLBACK_WINDOW_MS, bnetCallbackKey, checkRateLimit, spendBudget,
} from '../ratelimit.js';
import { maxLevelOf } from '../realms.js';
import { cleanCharacterName, nameKey } from '../roster-data.js';
import {
  BNET_STATE_COOKIE, FRESH_MODE, bnetReturnRoute, bnetStateCookie, bnetStateMode, bnetStateReturn, claimStateNonce, clearBnetStateCookie, hashToken, loadSession, newSessionToken,
  presentedToken, sessionCookie, signBnetSigninState, signBnetState, startSessionStatements, verifyBnetSigninState, verifyBnetState, verifyFreshState,
} from '../session.js';
import { applyPicks, snapshotIdentity } from '../claim-apply.js';
import { autoAddMaxLevel } from '../bnet-auto-add.js';
import { bad, resolveRealm } from './roster.js';
import { viewerOf } from '../roster-view.js';
import { wrote } from '../d1-changes.js';

// Fixed targets inside the app shell; the hash router reads them. The only input that reaches a Location header is a link's return route, and only one that passed
// bnetReturnRoute and came back out of a MAC-verified state (session.js).
const SIGNIN_REDIRECT = '/#/signin';
const HOME_REDIRECT = '/#/';
const CHARACTERS_REDIRECT = '/#/characters';
const linkedRedirect = (reason) => `/#/linked?error=${reason}`;
const signinRedirect = (reason) => `/#/signin?error=${reason}`;
const MAX_COMBOS = 8;
const LINK_LIMIT = 10;
const LINK_WINDOW_MS = 10 * 60 * 1000;
// D1 statements a callback has used by the time the sign-in match starts (nonce, rate limits, look-ups, the Battle.net reads of the callback and its own writes);
// the match counts its own on top and stays inside CALLBACK_STATEMENT_BUDGET. tests/guild/guild-b6a-match-tests.js measures both modes and fails when one grows past this.
export const STATEMENTS_BEFORE_MATCH = { signin: 12, link: 10 };
// D1 statements the Battle.net fresh-auth callback has used when the GM claim starts (session and its last-seen touch, the nonce, the per-account and global callback counters; measured 4); the claim counts its own on top
// and stays inside CALLBACK_STATEMENT_BUDGET (tests/guild/guild-b6b3-claim-tests.js measures it and fails when it grows past this).
export const STATEMENTS_BEFORE_CLAIM = 5;

// ---------------------------------------------------------------------------
// Link

// ?mode=signin starts a sign-in or sign-up (nobody needs to be signed in); without it the signed-in member links Battle.net to their account.
// A link may also say ?return=<app route> (bnetReturnRoute: "#/g/<gid>/setup"): the callback then ends there instead of on My characters. A sign-in ignores it (its landing is
// the sign-in's own); a value that fails the rule is dropped without a word and the link ends on My characters as before.
export async function bnetLogin(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const signin = url.searchParams.get('mode') === 'signin';
  const returnTo = signin ? null : bnetReturnRoute(url.searchParams.get('return'));
  const failTo = signin ? signinRedirect : linkedRedirect;
  let session = null;
  if (!signin) {
    session = await loadSession(ctx);
    if (!session) return redirectResponse(SIGNIN_REDIRECT);
  }
  if (!isConfigured(env)) return redirectResponse(failTo('not_configured'));
  const canonical = canonicalOrigin(env);
  if (url.origin !== canonical) return redirectResponse(`${canonical}/auth/bnet/login${signin ? '?mode=signin' : returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`);
  if (signin) {
    const state = await signBnetSigninState(env, base64url(ctx.randomBytes(16)), ctx.now());
    return redirectResponse(authorizeUrl(env, state), [bnetStateCookie(state)]);
  }
  const limit = await checkRateLimit(db, session.user.id, ctx.now(), { key: `bnet:${session.user.id}`, limit: LINK_LIMIT, windowMs: LINK_WINDOW_MS });
  if (limit.limited) return redirectResponse(linkedRedirect('busy'));
  // A first link on an account that holds the Owner seat or any staff role needs a fresh grant for this change first (worker/fresh.js identity-change protection).
  const linked = await db.prepare('SELECT 1 AS found FROM bnet_links WHERE user_id = ?').bind(session.user.id).first();
  if (!linked && (await identityChangeBlocked({ ...ctx, session }, { userId: session.user.id, change: 'link_bnet' }))) return redirectResponse(linkedRedirect('fresh_required'));
  const state = await signBnetState(env, session.user.id, base64url(ctx.randomBytes(16)), ctx.now(), returnTo);
  return redirectResponse(authorizeUrl(env, state), [bnetStateCookie(state)]);
}

// The distinct profile namespaces (game version + region) among the guilds, with Battle.net support: [{ namespace, version, region }], in the order given.
// Callers put the guilds that run on the in-game roster FIRST: they are how a Battle.net account becomes a member, so the cap keeps them.
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
            // The identity key (namespace + realm id + character id): the sign-in match finds the character on a guild's in-game roster through it.
            characterId: character.characterId,
            realmId: character.realmId,
            namespace: combo.namespace,
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

// The account's characters in the namespace of ONE guild, read now and written into the link's snapshot (that namespace's entry only: the other entries and snapshot_at stay, so
// the 30-day rule still counts from their own fetch). The setup pin's decision reads the entry back (worker/pin-proof.js). -> { ok: true } | { ok: false, reason }.
async function refreshPinCharacters(ctx, { userId, bnetAccountId, guildId, accessToken, now }) {
  const guild = await ctx.db.prepare('SELECT game_version, region FROM guilds WHERE id = ?').bind(guildId).first();
  if (!guild) return { ok: false, reason: 'conflict' };
  const entries = Object.entries(await buildSnapshot(ctx, accessToken, [guild], now));
  if (entries.length !== 1 || entries[0][1].error) return { ok: false, reason: 'provider' };
  const [namespace, entry] = entries[0];
  const written = await ctx.db.prepare(
    `UPDATE bnet_links SET snapshot = json_set(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, ?, json(?)) WHERE user_id = ? AND bnet_account_id = ?`,
  ).bind(`$."${namespace}"`, JSON.stringify(entry), userId, bnetAccountId).run();
  return wrote(written) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// After the token exchange and user info, before the snapshot fan-out of Blizzard calls: one Blizzard account may come back BNET_CALLBACK_LIMIT times
// per window (false = refuse it). Then the global budget is counted; it never refuses, and the call that takes the window past it logs the one
// ALARM line the operator watches for (a gate here would let a few accounts stop everyone).
async function callbackAllowed(ctx, bnetAccountId, now) {
  const own = await checkRateLimit(ctx.db, bnetAccountId, now, {
    key: bnetCallbackKey(bnetAccountId), limit: BNET_CALLBACK_LIMIT, windowMs: BNET_CALLBACK_WINDOW_MS,
  });
  if (own.limited) return false;
  const budget = await spendBudget(ctx.db, now, { key: BNET_CALLBACK_BUDGET_KEY, limit: BNET_CALLBACK_BUDGET, windowMs: BNET_CALLBACK_WINDOW_MS });
  if (budget.alarm) {
    ctx.log(`ALARM bnet_callback_budget: more than ${BNET_CALLBACK_BUDGET} Battle.net callbacks in ${BNET_CALLBACK_WINDOW_MS / 60000} minutes (not refused)`);
  }
  return true;
}

// The fresh-auth callback for Battle.net: the Battle.net account that comes back must be the one linked to the signed-in account. It reads the account number and nothing else
// (no snapshot, no character fan-out; the exceptions are the GM claim, which runs here, and the setup pin, which reads the account's characters in ONE namespace), counts against the same per-Blizzard-account callback limit as every Battle.net callback, never mints or rotates a session, and ends on a
// fixed app route. Same order as the Discord one (routes/auth.js). Blizzard offers no forced re-login parameter (worker/battlenet.js authorizeUrl says what that weakens).
async function bnetFreshCallback(ctx, { url, state, now, clear }) {
  const { env, db } = ctx;
  const session = await loadSession(ctx);
  if (!session) return redirectResponse(SIGNIN_REDIRECT, [clear]);
  const fail = (reason, purpose = null) => redirectResponse(freshErrorRoute(reason, purpose), [clear]);
  const cookieState = parseCookies(ctx.request.headers.get('Cookie'))[BNET_STATE_COOKIE];
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('not_configured');
  const parsed = await verifyFreshState(env, { provider: 'bnet', userId: session.user.id, tokenHash: session.tokenHash, state, now });
  if (!parsed) return fail('state');
  if (url.searchParams.get('error')) return fail('denied', parsed.purpose);
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state', parsed.purpose);
  if (!(await claimStateNonce(db, state, now))) return fail('state', parsed.purpose);
  let info;
  let accessToken;
  try {
    accessToken = await exchangeCode(ctx, code);
    info = await fetchUserInfo(ctx, accessToken);
    if (!(await callbackAllowed(ctx, info.id, now))) return fail('busy', parsed.purpose);
  } catch (error) {
    ctx.log(`fresh-auth: Battle.net step failed: ${error && error.message}`);
    return fail('provider', parsed.purpose);
  }
  // The GM claim runs HERE, with the token in hand, and writes no grant (worker/gm-claim.js says why and what it does instead).
  if (parsed.purpose === 'gm_claim') {
    const claimed = await runGmClaim(ctx, { session, parsed, accessToken, info, now, spent: STATEMENTS_BEFORE_CLAIM });
    return claimed.ok ? redirectResponse(freshDoneRoute(parsed.purpose), [clear]) : fail(claimed.reason, parsed.purpose);
  }
  // The setup pin reads the account's characters in the guild's namespace afresh HERE, with the token in hand: the pin route (a later request) decides on them and on the live roster
  // (worker/routes/bnet-pin.js). The grant below is written only when that read worked.
  if (parsed.purpose === 'pin') {
    const identity = await checkFreshIdentity(ctx, { session, provider: 'bnet', identityId: info.id, purpose: parsed.purpose });
    if (!identity.ok) {
      await noteFreshFailure(ctx, { userId: session.user.id, guildId: parsed.guildId, purpose: parsed.purpose, reason: identity.reason });
      return fail(identity.reason, parsed.purpose);
    }
    const refreshed = await refreshPinCharacters(ctx, { userId: session.user.id, bnetAccountId: info.id, guildId: parsed.guildId, accessToken, now });
    if (!refreshed.ok) return fail(refreshed.reason, parsed.purpose);
  }
  const granted = await writeFreshGrant(ctx, { session, provider: 'bnet', identityId: info.id, parsed, nowMs: now });
  if (!granted.ok) {
    await noteFreshFailure(ctx, { userId: session.user.id, guildId: parsed.guildId, purpose: parsed.purpose, reason: granted.reason });
    return fail(granted.reason, parsed.purpose);
  }
  return redirectResponse(freshDoneRoute(parsed.purpose), [clear]);
}

// One callback for both modes. The mode comes from the state alone, and only a state whose MAC checked out for that mode is believed.
export async function bnetCallback(ctx) {
  const { env, db } = ctx;
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get('state');
  const mode = bnetStateMode(state);
  const now = ctx.now();
  const clear = clearBnetStateCookie();
  const fail = (reason) => redirectResponse((mode === 'link' ? linkedRedirect : signinRedirect)(reason), [clear]);
  // Fresh-auth (worker/fresh.js): its own callback, which never starts or rotates a session.
  if (mode === FRESH_MODE) return bnetFreshCallback(ctx, { url, state, now, clear });
  let session = null;
  if (mode === 'link') {
    session = await loadSession(ctx);
    if (!session) return redirectResponse(SIGNIN_REDIRECT, [clear]);
  }
  const cookieState = parseCookies(ctx.request.headers.get('Cookie'))[BNET_STATE_COOKIE];
  if (!cookieState || !state || !safeEqual(state, cookieState)) return fail('state');
  if (!isConfigured(env)) return fail('not_configured');
  // A state this Worker did not sign for this flow (and, for a link, for THIS member) never reaches an outbound Battle.net call.
  const genuine = mode === 'signin' ? await verifyBnetSigninState(env, state, now) : await verifyBnetState(env, session.user.id, state, now);
  if (!genuine) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return fail('state');
  // Single use: a replayed state is refused here, before the first outbound call (the begin step wrote nothing, the first callback writes the row).
  if (!(await claimStateNonce(db, state, now))) return fail('state');

  let info;
  let snapshot;
  try {
    const accessToken = await exchangeCode(ctx, code);
    info = await fetchUserInfo(ctx, accessToken);
    if (!(await callbackAllowed(ctx, info.id, now))) return fail('busy');
    // Whose characters to look for: the member linking, or whoever already signs in with this Battle.net account (nobody yet: a new account). The namespaces
    // are the ones of the guilds that run on the in-game roster (first: a new account has no member guild, and these are how it becomes one) and of the guilds
    // the account is a member of.
    const userId = mode === 'link' ? session.user.id : await findUserByBnet(db, info.id);
    const memberGuilds = userId ? await loadMemberGuilds(db, userId) : [];
    snapshot = await buildSnapshot(ctx, accessToken, [...(await loadIngameCombos(db)), ...memberGuilds], now);
  } catch (error) {
    ctx.log(`bnet ${mode}: Battle.net step failed: ${error && error.message}`);
    return fail('bnet');
  }

  // A BLOCKED account that links a NEW Battle.net account (a first link): the new account id is tombstoned for each of its blocks after the save (worker/block-tombstones.js).
  let tombstoneNewLink = false;
  // The identity-change statements of a FIRST link (the grant check, its audit row) come on top of the three writes STATEMENTS_BEFORE_MATCH counts.
  let firstLinkExtra = 0;
  try {
    if (mode === 'signin') return await finishSignin(ctx, info, snapshot, now, clear);
    // The same Battle.net account again refreshes its link; a DIFFERENT one never replaces it (disconnect first): swapping the sign-in of an
    // account is not something a stolen session should be able to do in one step. The rows after the first apply only if the link is this one.
    const here = { sql: 'EXISTS (SELECT 1 FROM bnet_links WHERE user_id = ? AND bnet_account_id = ?)', params: [session.user.id, info.id] };
    // A FIRST link (the account has no Battle.net yet) is an identity change (worker/fresh.js): an account that holds the Owner seat or any staff role must show a fresh grant for
    // exactly this change (the begin route already asked; this is the authoritative check, inside the batch), and every account's change nulls its grants and is audited in
    // each guild it is a member of. A refresh of the same Battle.net account is not a change.
    const userId = session.user.id;
    const state = await db.prepare(
      `SELECT (SELECT bnet_account_id FROM bnet_links WHERE user_id = ?1) AS linked, ${protectedAccountSql('?1')} AS protected,
              EXISTS (SELECT 1 FROM guild_blocks WHERE user_id = ?1 AND pending_review = 0) AS blocked`,
    ).bind(userId).first();
    const first = !state.linked;
    let act = null;
    if (first) {
      try {
        act = await beginIdentityChange({ ...ctx, session }, { userId, change: 'link_bnet', protectedAccount: state.protected === 1 });
      } catch (error) {
        if (error instanceof HttpError && error.code === 'fresh_required') return fail('fresh_required');
        throw error;
      }
    }
    const gate = act ? act.guard : ALWAYS;
    // A link that already exists when the first-link INSERT runs (a race) is a refresh like any other: first_linked_at is only ever filled in, never moved.
    const linkUpdate = `ON CONFLICT(user_id) DO UPDATE SET battletag = excluded.battletag,
           linked_at = excluded.linked_at, snapshot = excluded.snapshot, snapshot_at = excluded.snapshot_at,
           first_linked_at = COALESCE(bnet_links.first_linked_at, bnet_links.linked_at)
         WHERE bnet_links.bnet_account_id = excluded.bnet_account_id`;
    const linkValues = [userId, info.id, info.battletag, now, JSON.stringify(snapshot), now, now];
    const saved = await db.batch([
      ...(act ? [
        ...act.statements,
        ...identityChangeStatements(ctx, { userId, provider: 'bnet', change: 'link', guard: allOf(gate, { sql: 'NOT EXISTS (SELECT 1 FROM bnet_links WHERE user_id = ?)', params: [userId] }) }),
      ] : []),
      // The first link is an INSERT ... SELECT so the act's guard can sit on it. A refresh is an UPDATE of the row of THIS Battle.net account and nothing else, so a link that went away
      // since the read is never made again here without the grant, the audit row and the nulling of other sessions' grants. The first-link time is written by the INSERT; a refresh
      // fills it in once when it is missing (a link written before the column existed) with the time of the link as it stands BEFORE this refresh overwrites it, then it ages.
      first
        ? db.prepare(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql} ${linkUpdate}`).bind(...linkValues, ...gate.params)
        : db.prepare(
          `UPDATE bnet_links SET battletag = ?, linked_at = ?, snapshot = ?, snapshot_at = ?, first_linked_at = COALESCE(first_linked_at, linked_at) WHERE user_id = ? AND bnet_account_id = ?`,
        ).bind(info.battletag, now, JSON.stringify(snapshot), now, userId, info.id),
      // An account without Discord is named after its BattleTag; a new BattleTag renames it.
      db.prepare(`UPDATE users SET username = ? WHERE id = ? AND discord_id IS NULL AND ${here.sql} AND ${gate.sql}`)
        .bind(bnetNameOf(info.battletag), userId, ...here.params, ...gate.params),
      auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'bnet.link', entityType: 'user', entityId: userId }, allOf(here, gate)),
    ]);
    if (act && !act.consumed(saved)) return fail('fresh_required');
    firstLinkExtra = Math.max(0, saved.length - 3);
    if (!wrote(saved[act ? act.offset + 2 : 0])) {
      // Nothing was linked. A first link: the account became staff between the read and the write (fresh_required), or another Battle.net account is linked already. A refresh: another
      // Battle.net account is linked now (has_bnet), or none is any more (it was disconnected since the read: a lost race, 'state' = connect again).
      if (first) return fail((await isProtectedAccount(db, userId)) ? 'fresh_required' : 'has_bnet');
      const linkedNow = await db.prepare('SELECT 1 AS found FROM bnet_links WHERE user_id = ?').bind(userId).first();
      return fail(linkedNow ? 'has_bnet' : 'state');
    }
    tombstoneNewLink = first && state.blocked === 1;
  } catch (error) {
    if (isUniqueViolation(error)) return fail('taken');
    ctx.log(`bnet ${mode}: saving failed: ${error && error.message}`);
    return fail('bnet');
  }
  // The statements this adds count against the callback's budget, ahead of the match below; an account that blocks nowhere costs none.
  const tombstoned = tombstoneNewLink ? await tombstoneNewBnetAccount(ctx, { userId: session.user.id, bnetAccountId: info.id }) : 0;
  // A first link and the same Battle.net account again ("Re-verify with Battle.net") both prove the account's characters afresh.
  await matchAfterCallback(ctx, { userId: session.user.id, bnetAccountId: info.id, snapshot, now, spent: STATEMENTS_BEFORE_MATCH.link + firstLinkExtra + tombstoned });
  // The state was verified above, so the route it carries is the one the member's own begin step signed.
  const returnTo = bnetStateReturn(state);
  return redirectResponse(returnTo ? `/${returnTo}` : CHARACTERS_REDIRECT, [clear]);
}

// The sign-in match runs after the callback's own writes and never fails the callback: whatever it could not do waits for the next sign-in. Then the tombstone match
// for the guilds the in-game match did not handle itself (legacy and manual guilds, and the in-game ones it had nothing to do in): the account's Battle.net id and
// proven characters are keys of a block like its Discord id is (sec A9-11). It takes what the match left of the callback's CALLBACK_STATEMENT_BUDGET; a guild that does
// not fit waits for the next callback. Last, the max-level rule (worker/bnet-auto-add.js): the characters at the level cap join the member's profile with what is left of the budget.
async function matchAfterCallback(ctx, input) {
  let matched = null;
  try {
    matched = await runBnetMatch(ctx, input);
  } catch (error) {
    ctx.log(`bnet match failed: ${error && error.message}`);
    return null;
  }
  const tombstones = { statements: 0 };
  await matchAccountAtSignIn(ctx, input.userId, {
    budget: CALLBACK_STATEMENT_BUDGET - matched.statements,
    skip: matched.tombstoned,
    onDeferred: () => ctx.log('bnet match deferred: budget'),
    report: tombstones,
  });
  try {
    await autoAddMaxLevel(ctx, { userId: input.userId, snapshot: input.snapshot, spent: matched.statements + tombstones.statements });
  } catch (error) {
    ctx.log(`bnet auto-add failed: ${error && error.message}`);
  }
  return matched;
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
      db.prepare('INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, info.id, info.battletag, now, JSON.stringify(snapshot), now, now),
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
  await matchAfterCallback(ctx, { userId, bnetAccountId: info.id, snapshot, now, spent: STATEMENTS_BEFORE_MATCH.signin });
  return redirectResponse(HOME_REDIRECT, [clear, sessionCookie(token)]);
}

export async function disconnectBnet(ctx) {
  const { db, session } = ctx;
  const userId = session.user.id;
  // The last identity cannot go: the link is deleted only while the account keeps a Discord to sign in with.
  const standing = await db.prepare(`SELECT EXISTS (SELECT 1 FROM bnet_links WHERE user_id = ?1) AS linked, ${hasDiscordSql('?1')} AS discord`).bind(userId).first();
  if (!standing.linked) return jsonResponse({ ok: true, removed: false });
  if (!standing.discord) {
    throw new HttpError(409, 'last_identity', 'Battle.net is the only way you sign in to this account. Connect Discord first, or delete your data on the privacy page.');
  }
  // Identity-change protection (worker/fresh.js): on an account that holds the Owner seat or any staff role this is a fresh-auth act (403 fresh_required { purpose:
  // 'identity_change', params: { change: 'unlink_bnet' } } until the grant is there); every account's change nulls its grants and is audited in each guild the account is a member of.
  const act = await beginIdentityChange(ctx, { userId, change: 'unlink_bnet' });
  // Every proof the link gave goes with it (a proof belongs to the Battle.net account that earned it); the clearing is written first, with the same condition, so a refused
  // disconnect clears nothing.
  const keepsDiscord = allOf({ sql: hasDiscordSql('?'), params: [userId] }, { sql: hasBnetSql('?'), params: [userId] }, act.guard);
  const results = await db.batch([
    ...act.statements,
    ...identityChangeStatements(ctx, { userId, provider: 'bnet', change: 'unlink', guard: keepsDiscord }),
    clearBnetProofStatement(db, userId, keepsDiscord),
    db.prepare(`DELETE FROM bnet_links WHERE user_id = ? AND ${keepsDiscord.sql}`).bind(userId, ...keepsDiscord.params),
    auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'bnet.unlink', entityType: 'user', entityId: userId },
      { sql: 'changes() = 1', params: [] }),
  ]);
  if (!act.consumed(results)) throw freshRequiredError('identity_change', { change: 'unlink_bnet' });
  if (wrote(results[act.offset + 3])) return jsonResponse({ ok: true, removed: true });
  throw new HttpError(409, 'conflict', 'That changed while you were working on it. Reload and try again.');
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
// viewer: { userId, discordId } - a person is yours only when it is linked to your account (players.user_id); one that records only your Discord ID is on_roster, claimable with This is me.
function characterView(guild, character, owners, viewer, claims) {
  const resolved = resolveRealm(guild, character.realm);
  const base = { name: character.name, realm: character.realm, realmSlug: character.realmSlug, class: character.class, level: character.level };
  if (!resolved) return { ...base, state: 'other_realm', claim: null, claimable: false };
  const key = `${nameKey(character.name)}|${resolved.key}`;
  const owner = owners.get(key);
  let state = 'new';
  if (owner) state = { yours: 'yours', taken: 'taken', open: 'on_roster' }[personStanding(owner, viewer)];
  const claim = claims.get(key) || null;
  return { ...base, state, claim, claimable: (state === 'new' || state === 'on_roster') && !(claim && claim.status === 'pending') };
}

const byLevelThenName = (a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name);

// The characters on the viewer's own record in a guild (worker/membership.js ownPlayerSql), the ones still in the guild (not Former), each with its team and the team request
// waiting for it: [{ id, name, class, mainSpec, isMain, team: { id, name } | null, request: { id, team: { id, name }, createdAt } | null, realm }] (My characters' cards). The Main
// comes first, the rest by name. The level is not stored on a character: the caller reads it from the Battle.net snapshot.
async function loadProfileCharacters(db, guildId, userId) {
  const result = await db.prepare(
    `SELECT c.id, c.name, c.name_key, c.realm, c.realm_key, c.class, c.main_spec, c.is_main, c.team_id, t.name AS team_name,
            q.id AS request_id, q.team_id AS request_team_id, rt.name AS request_team_name, q.created_at AS request_at
       FROM players p
       JOIN characters c ON c.player_id = p.id AND c.guild_id = p.guild_id
       LEFT JOIN teams t ON t.guild_id = c.guild_id AND t.id = c.team_id
       LEFT JOIN team_requests q ON q.guild_id = c.guild_id AND q.character_id = c.id AND q.status = 'pending'
       LEFT JOIN teams rt ON rt.guild_id = q.guild_id AND rt.id = q.team_id
      WHERE p.guild_id = ? AND ${ownPlayerSql('p', '?')} AND c.left_on IS NULL AND ${visibleCharacterSql('c')}`,
  ).bind(guildId, userId).all();
  return result.results.map((row) => ({
    id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, isMain: row.is_main === 1, realm: row.realm, realmKey: row.realm_key, nameKey: row.name_key,
    team: row.team_id ? { id: row.team_id, name: row.team_name } : null,
    request: row.request_id && !row.team_id ? { id: row.request_id, team: { id: row.request_team_id, name: row.request_team_name }, createdAt: row.request_at } : null,
  })).sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name));
}

// The level a profile character has on Battle.net's list for the guild's namespace: Map("nameKey|realmKey" -> level). Empty without a list.
function levelsOf(guild, characters) {
  const levels = new Map();
  for (const character of characters) {
    const resolved = resolveRealm(guild, character.realm);
    if (resolved && Number.isInteger(character.level)) levels.set(`${nameKey(character.name)}|${resolved.key}`, character.level);
  }
  return levels;
}

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
      supportLabel: support.label, status: 'ok', message: null, characters: [], maxLevel: maxLevelOf(guild.game_version), profile: [],
      // Is the viewer on this guild's roster already? My characters then says what Battle.net adds instead of asking them to connect it to see their own roster entry.
      onRoster: !!(await ownPersonStatement(db, guild.id, session.user.id).first()),
      // An in-game guild takes characters from Battle.net only (POST /me/characters answers 409 battlenet_only), so My characters offers no "This is me" there.
      battlenetOnly: (await db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guild.id).first() || {}).rank_source === 'ingame',
    };
    guilds.push(view);
    const profile = await loadProfileCharacters(db, guild.id, session.user.id);
    const entryOf = support.supported && link && !expired ? snapshot[support.namespace] : null;
    const listed = entryOf && !entryOf.error && Array.isArray(entryOf.characters) ? entryOf.characters : [];
    const levels = levelsOf(guild, listed);
    view.profile = profile.map(({ realmKey: key, nameKey: name, realm, ...card }) => ({ ...card, level: levels.has(`${name}|${key}`) ? levels.get(`${name}|${key}`) : null }));
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
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
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

  // Applied at once (D2): the character joins the member's own record, or the member's account is linked to the person that holds it (D2b); only a conflict
  // goes to the officers as a pending claim. One batch, worker/claim-apply.js.
  const result = await applyPicks(ctx, guildContext, picked.map((item) => ({
    index: item.index, name: item.name, realm: item.realm, class: item.character.class, level: item.character.level, identity: snapshotIdentity(item.character, support.namespace),
  })), { source: 'bnet', field: 'characters' });
  return jsonResponse(result, 201);
}

export async function withdrawClaim(ctx) {
  const { db, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  if (!isId('cl', ctx.params.clid)) throw new HttpError(404, 'not_found', 'That claim was not found.');
  const results = await db.batch([
    db.prepare("DELETE FROM character_claims WHERE id = ? AND guild_id = ? AND user_id = ? AND status = 'pending'")
      .bind(ctx.params.clid, guildContext.guild.id, session.user.id),
    auditStatement(ctx, {
      guildId: guildContext.guild.id, actorUserId: session.user.id, action: 'claim.withdraw', entityType: 'claim', entityId: ctx.params.clid,
    }, { sql: 'changes() = 1', params: [] }),
  ]);
  if (!wrote(results[0])) throw new HttpError(404, 'not_found', 'That claim is not waiting any more.');
  return jsonResponse({ ok: true });
}
