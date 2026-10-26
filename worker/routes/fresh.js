// Fresh-auth, the start step (lane B6b part 2a; the plan: "Fresh-auth"). worker/fresh.js says what fresh-auth is and how an act consumes it.
//   POST /api/guild/:gid/fresh/start   { purpose, params, provider? }   handover, guild_delete, pin, source_switch (the Owner), gm_claim (anyone; the claim itself decides)
//   POST /api/fresh/start              { purpose, params, provider? }   ingame_create, identity_change (acts that belong to no guild)
// -> 200 { authorizeUrl, provider, purpose, validForSeconds }. The browser then goes to authorizeUrl; the state cookie comes with this answer. The callback
// (routes/auth.js discordFreshCallback, routes/bnet.js bnetFreshCallback) writes the grant and redirects to /#/fresh?done=<purpose> or /#/fresh?error=<reason>. gm_claim writes no
// grant: the Battle.net callback runs the claim itself (worker/gm-claim.js) and redirects to /#/fresh?done=gm_claim, or ?error=not_gm | conflict | provider | mismatch | ...
// and &purpose=gm_claim.
//   provider: 'bnet' | 'discord'. Battle.net for gm_claim, ingame_create, pin, source_switch; Battle.net OR Discord (the account's choice) for handover, guild_delete and
//   identity_change. Left out, the account's only linked identity is used; with both linked, 400 provider_required.
// Writes nothing (the state is stateless until its callback claims the nonce). One per account per 10 minutes x 10, FAIL CLOSED: a limiter that cannot answer refuses (503).
// Errors: 400 bad_request (purpose, params, provider), 403 forbidden (not the Owner / not a member) or identity_too_new { provider, eligibleAt }, 404 not_found (gm_claim for a
// guild that does not exist), 409 not_configured | identity_not_linked | wrong_origin | claim_not_available (gm_claim: the guild's rank source is not 'ingame' or its pin is
// incomplete) | already_owner (gm_claim: the caller holds the seat and is not suspended), 429 / 503 rate_limited.
import { HttpError, jsonResponse } from '../http.js';
import { authorizeUrl as bnetAuthorizeUrl, canonicalOrigin as bnetOrigin, isConfigured as bnetConfigured } from '../battlenet.js';
import { authorizeUrl as discordAuthorizeUrl, canonicalOrigin as discordOrigin, isConfigured as discordConfigured } from '../discord.js';
import {
  FRESH_PURPOSES, FRESH_START_LIMIT, FRESH_START_WINDOW_MS, freshHash, identityStanding, isFreshPurpose, loadIdentityRow, paramsProblem,
} from '../fresh.js';
import { claimPreflight } from '../gm-claim.js';
import { base64url } from '../ids.js';
import { requireOwner } from '../owner.js';
import { loadGuildContext } from '../permissions.js';
import { checkRateLimit } from '../ratelimit.js';
import { STATE_TTL_SECONDS, bnetStateCookie, signFreshState, stateCookie } from '../session.js';

const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });

export const freshKey = (userId) => `fresh:${userId}`;

export async function startFresh(ctx) {
  const { db, env, session, body } = ctx;
  const userId = session.user.id;
  const guildId = ctx.params.gid || null;
  const purpose = body.purpose;
  if (!isFreshPurpose(purpose)) throw bad(`purpose must be one of ${Object.keys(FRESH_PURPOSES).join(', ')}.`, 'purpose');
  const spec = FRESH_PURPOSES[purpose];
  if (spec.scope === 'guild' && !guildId) throw bad('That act belongs to a guild: start it under /api/guild/<id>/fresh/start.', 'purpose');
  if (spec.scope === 'account' && guildId) throw bad('That act belongs to the account, not to a guild: start it under /api/fresh/start.', 'purpose');
  const params = body.params === undefined ? {} : body.params;
  const problem = paramsProblem(purpose, params);
  if (problem) throw bad(problem, 'params');
  if (body.provider !== undefined && body.provider !== 'bnet' && body.provider !== 'discord') throw bad('provider must be bnet or discord.', 'provider');

  // Per account, fail closed, before any read.
  const limit = await checkRateLimit(db, userId, ctx.now(), { key: freshKey(userId), limit: FRESH_START_LIMIT, windowMs: FRESH_START_WINDOW_MS, failClosed: true });
  if (limit.limited) {
    if (limit.unavailable) throw new HttpError(503, 'rate_limited', 'Sign-in checks are paused for a moment. Try again shortly.', { retryAfter: limit.retryAfter });
    throw new HttpError(429, 'rate_limited', 'Too many sign-in checks. Wait a few minutes and try again.', { retryAfter: limit.retryAfter });
  }

  // Who may even ask. The act checks again inside its own batch; this only spares the others a trip to the provider.
  if (spec.owner) {
    const guildContext = await loadGuildContext(db, userId, guildId, session.viewAs);
    await requireOwner(db, guildContext);
  } else if (purpose === 'gm_claim') {
    // Anyone may ask (the claim's authority is live Blizzard data, decided in the callback), but not for a guild that has no in-game seat to claim or whose seat is theirs.
    await claimPreflight(db, { guildId, userId });
  }

  const row = await loadIdentityRow(db, userId);
  if (!row) throw new HttpError(401, 'signed_out', 'Sign in to continue.');
  const options = spec.providers.filter((candidate) => identityStanding(row, candidate, ctx.now()).held);
  let provider = body.provider;
  if (provider === undefined) {
    if (options.length > 1) throw bad('Say which sign-in to use: bnet or discord.', 'provider');
    provider = options[0] || spec.providers[0];
  }
  if (!spec.providers.includes(provider)) {
    throw bad(`That act is confirmed with ${spec.providers.map((name) => (name === 'bnet' ? 'Battle.net' : 'Discord')).join(' or ')}.`, 'provider');
  }
  const standing = identityStanding(row, provider, ctx.now());
  if (!standing.held) {
    throw new HttpError(409, 'identity_not_linked', `Connect ${provider === 'bnet' ? 'Battle.net' : 'Discord'} to your account first, then repeat this.`, { provider });
  }
  if (spec.identityRule && !standing.passes) {
    throw new HttpError(403, 'identity_too_new',
      `That sign-in was connected to this account recently. Use the sign-in the account was made with, or wait until ${new Date(standing.eligibleAt).toISOString().slice(0, 10)}.`,
      { provider, ...(standing.eligibleAt ? { eligibleAt: standing.eligibleAt } : {}) });
  }

  const configured = provider === 'bnet' ? bnetConfigured(env) : discordConfigured(env);
  if (!configured) throw new HttpError(409, 'not_configured', `${provider === 'bnet' ? 'Battle.net' : 'Discord'} sign-in is not set up on this server.`, { provider });
  const canonical = provider === 'bnet' ? bnetOrigin(env) : discordOrigin(env);
  if (new URL(ctx.request.url).origin !== canonical) {
    throw new HttpError(409, 'wrong_origin', `Start this from ${canonical}.`, { provider });
  }

  const state = await signFreshState(env, {
    provider, userId, tokenHash: session.tokenHash, purpose, guildId, paramsHash: await freshHash({ purpose, guildId, params }),
    nonce: base64url(ctx.randomBytes(16)), issuedAt: ctx.now(),
  });
  const authorizeUrl = provider === 'bnet' ? bnetAuthorizeUrl(env, state, { fresh: true }) : discordAuthorizeUrl(env, state, { fresh: true });
  return jsonResponse({ authorizeUrl, provider, purpose, validForSeconds: STATE_TTL_SECONDS }, 200, {}, [provider === 'bnet' ? bnetStateCookie(state) : stateCookie(state)]);
}
