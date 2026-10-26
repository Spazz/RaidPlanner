// Fresh-auth and identity-change protection (user-hierarchy build, lane B6b part 2a; plan "Fresh-auth" and "Identity-change protection").
//
// FRESH-AUTH is a sign-in done just now, to prove that the person at the keyboard holds an identity linked to the signed-in account before a sensitive act. Parts:
//   start      POST /api/guild/:gid/fresh/start and POST /api/fresh/start (worker/routes/fresh.js) mint a purpose-bound OAuth state and return the authorize URL. The state
//              lives in worker/session.js (signFreshState): its MAC covers user, SESSION, provider, purpose, guild and the hash of the act's parameters, one key domain per purpose.
//   callback   the fresh mode of both OAuth callbacks (routes/auth.js, routes/bnet.js). The returned identity must EQUAL the identity linked to the session's account; a
//              callback never mints or rotates a session. It writes the GRANT on the session row: sessions.fresh_purpose / fresh_hash / fresh_at (one grant per session; a new
//              one replaces the old; 15 minutes; single use).
//   act        the act consumes the grant INSIDE ITS OWN BATCH (consumeFreshStatements): statement 1 = `UPDATE sessions SET fresh_* = NULL WHERE token_hash = ? AND ... AND
//              fresh_purpose = ? AND fresh_hash = ? AND fresh_at > ?`, statement 2 = a fresh_act_markers row inserted `WHERE changes() = 1`, and EVERY later statement of the act
//              carries `EXISTS (marker)`. Two parallel requests with one grant: the second's UPDATE changes nothing, so its marker is never written and none of its statements
//              applies. beginFreshAct below builds the pair and the guard; routes use it as
//                  const act = await beginFreshAct(ctx, { required, purpose, guildId, params });
//                  const results = await db.batch([...act.statements, firstWrite.bind(..., act.guard), ...]);
//                  if (!act.consumed(results)) throw freshRequiredError(purpose, params);
//              Later acts (the flip in lane B9, in-game creation in B10, the GM claim in part 2b, pin and source switch in part 3) do the same.
//
// IDENTITY RULE (a): for the purposes marked identityRule, an identity is accepted only if it is the account's FOUNDING identity (first linked within 60 s of users.created_at)
// or was first linked at least 7 days ago. users.discord_linked_at and bnet_links.first_linked_at carry the first-link time (migration 0031; the link UPSERT never moves it, only
// unlink + link does). The GM claim and in-game creation are exempt: their authority is live Blizzard data, not the identity's age.
//
// IDENTITY-CHANGE PROTECTION (b)/(c): on an account that holds the Owner seat or any stored or derived staff role anywhere, linking or unlinking either identity is itself a
// fresh-auth act (purpose identity_change, performed with an identity that passes (a)); every identity change nulls the account's grants and is audited in each guild the
// account is a member of (identity.change, never pruned).
import { auditEachMemberGuildStatement, failureAuditStatements } from './audit.js';
import { HttpError } from './http.js';
import { isId } from './ids.js';
import { markerGuard, newMarkerId } from './dry-run.js';
import { ownedGuildsSql } from './owner.js';
import { hashToken } from './session.js';

export const FRESH_TTL_MS = 15 * 60 * 1000;
export const FOUNDING_WINDOW_MS = 60 * 1000;
export const NEW_IDENTITY_MS = 7 * 24 * 60 * 60 * 1000;
// POST .../fresh/start: per account, fail closed (a limiter that cannot answer refuses).
export const FRESH_START_LIMIT = 10;
export const FRESH_START_WINDOW_MS = 10 * 60 * 1000;

export const IDENTITY_CHANGES = Object.freeze(['link_discord', 'unlink_discord', 'link_bnet', 'unlink_bnet']);

// scope 'guild': the act belongs to a guild (it is in the state and the parameter hash); 'account': it does not. owner: the start route refuses anyone who is not the Owner
// (the act checks again inside its batch). providers: which identity may be used. identityRule: rule (a) applies.
export const FRESH_PURPOSES = Object.freeze({
  handover: { providers: ['bnet', 'discord'], identityRule: true, scope: 'guild', owner: true },
  guild_delete: { providers: ['bnet', 'discord'], identityRule: true, scope: 'guild', owner: true },
  pin: { providers: ['bnet'], identityRule: true, scope: 'guild', owner: true },
  source_switch: { providers: ['bnet'], identityRule: true, scope: 'guild', owner: true },
  gm_claim: { providers: ['bnet'], identityRule: false, scope: 'guild', owner: false },
  ingame_create: { providers: ['bnet'], identityRule: false, scope: 'account', owner: false },
  identity_change: { providers: ['bnet', 'discord'], identityRule: true, scope: 'account', owner: false },
});
export const isFreshPurpose = (purpose) => typeof purpose === 'string' && Object.prototype.hasOwnProperty.call(FRESH_PURPOSES, purpose);

export const ALWAYS = Object.freeze({ sql: '1 = 1', params: Object.freeze([]) });
export const allOf = (...guards) => ({
  sql: guards.map((guard) => `(${guard.sql})`).join(' AND '),
  params: guards.flatMap((guard) => [...guard.params]),
});

// ---------------------------------------------------------------------------
// Parameters and their hash

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('not a JSON value');
}

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const keysOf = (params) => Object.keys(params).sort().join(',');

// The sentence for params that do not fit the purpose, or null. The act's own parameters: small, flat, and exactly the ones the act reads.
export function paramsProblem(purpose, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object.';
  const entries = Object.entries(params);
  if (entries.length > 8) return 'params has too many entries.';
  for (const [key, value] of entries) {
    if (!PARAM_KEY.test(key)) return 'params has a key that is not a name.';
    const flat = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 200);
    if (!flat) return `params.${key} must be a short text, a number, true, false or null.`;
  }
  switch (purpose) {
    case 'handover': return keysOf(params) === 'targetUserId' && isId('u', params.targetUserId) ? null : 'A hand-over needs params { targetUserId }.';
    case 'identity_change': return keysOf(params) === 'change' && IDENTITY_CHANGES.includes(params.change) ? null : `An identity change needs params { change } (${IDENTITY_CHANGES.join(', ')}).`;
    case 'guild_delete':
    case 'gm_claim': return entries.length === 0 ? null : 'This act takes no params.';
    default: return null;
  }
}

// The SHA-256 (hex) of the act as the state and the grant bind it: purpose, guild (null for an account act) and params. The act recomputes it from ITS parameters, so a grant
// made for another purpose, another guild or other parameters never matches.
export function freshHash({ purpose, guildId = null, params = {} }) {
  return hashToken(canonicalJson({ guildId: guildId || null, params, purpose }));
}

// ---------------------------------------------------------------------------
// The grant and the act

export function freshRequiredError(purpose, params = null) {
  return new HttpError(403, 'fresh_required', 'Confirm it is you first: sign in again with Battle.net or Discord, then repeat this.', { purpose, ...(params ? { params } : {}) });
}

// Throws 403 fresh_required unless the session holds a grant for exactly this act that is still inside its 15 minutes. A read only: the act consumes the grant in its batch.
export async function assertFresh(ctx, { purpose, hash, params = null }) {
  const row = await ctx.db.prepare('SELECT fresh_purpose, fresh_hash, fresh_at FROM sessions WHERE token_hash = ? AND user_id = ?')
    .bind(ctx.session.tokenHash, ctx.session.user.id).first();
  if (!row || row.fresh_purpose !== purpose || row.fresh_hash !== hash || !(row.fresh_at > ctx.now() - FRESH_TTL_MS)) throw freshRequiredError(purpose, params);
}

// Statement 2 of a fresh act: the marker row, inserted only when the consuming UPDATE just before it changed a row (`changes() = 1`) AND the grant it spent is really gone from the
// session. The second condition is what makes a SWAPPED order refuse deterministically: written before the consume, the marker would read a stale changes() but would still find
// the grant on the session, so no marker is written and no statement of the act applies. (worker/dry-run.js markerStatement has only the first condition; the dry-run tokens
// keep it. The table, the marker id and the guard are the same.)
function freshMarkerStatement(db, { markerId, tokenHash, purpose, hash, now }) {
  return db.prepare(
    `INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at)
     SELECT ?, ?, ?, ? WHERE changes() = 1
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND fresh_purpose = ? AND fresh_hash = ?)`,
  ).bind(markerId, tokenHash, purpose, now, tokenHash, purpose, hash);
}

// The two statements that open a fresh act and the guard every later statement carries. `extra` ({ sql, params }): more conditions inside the consuming UPDATE (the actor is
// still the Owner, ...); a grant is not spent when they fail. Statement 1 changes one row exactly when the grant is this session's, for this purpose and these parameters, and
// fresh; statement 2 writes the marker `WHERE changes() = 1`. They must stay adjacent and in this order (a test swaps them and sees the act refused).
export function consumeFreshStatements(ctx, { purpose, hash, extra = null }) {
  const { db, session } = ctx;
  const now = ctx.now();
  const markerId = newMarkerId(ctx.randomBytes);
  return {
    markerId,
    guard: markerGuard(markerId),
    statements: [
      db.prepare(
        `UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL
          WHERE token_hash = ? AND user_id = ? AND fresh_purpose = ? AND fresh_hash = ? AND fresh_at > ?${extra ? ` AND (${extra.sql})` : ''}`,
      ).bind(session.tokenHash, session.user.id, purpose, hash, now - FRESH_TTL_MS, ...(extra ? extra.params : [])),
      freshMarkerStatement(db, { markerId, tokenHash: session.tokenHash, purpose, hash, now }),
    ],
  };
}

// The whole opening of an act. required false (a guild whose rank source needs no fresh sign-in): nothing to consume, the guard is always true.
// -> { required, statements (0 or 2), guard, offset (the index of the act's first own statement in the batch), consumed(results) }
export async function beginFreshAct(ctx, { required = true, purpose, guildId = null, params = {}, extra = null }) {
  if (!required) return { required: false, statements: [], guard: ALWAYS, offset: 0, consumed: () => true };
  const hash = await freshHash({ purpose, guildId, params });
  await assertFresh(ctx, { purpose, hash, params });
  const consume = consumeFreshStatements(ctx, { purpose, hash, extra });
  return { required: true, statements: consume.statements, guard: consume.guard, offset: 2, consumed: (results) => results[0].meta.changes === 1 };
}

// ---------------------------------------------------------------------------
// Where the callbacks send the browser (fixed app routes; the purpose is one the MAC'd state named, never user input)
export const FRESH_ROUTE = '/#/fresh';
export const freshDoneRoute = (purpose) => `${FRESH_ROUTE}?done=${purpose}`;
export const freshErrorRoute = (reason, purpose = null) => `${FRESH_ROUTE}?error=${reason}${purpose ? `&purpose=${purpose}` : ''}`;

// A failed check that looks like someone else at the keyboard (the provider returned another identity than the account's, or one that is too new): counted with the
// coalescing helper of lane B7a (one audit row per user, guild and hour plus a counter) in the state's guild; an account act has no guild and is logged only. Best effort.
export async function noteFreshFailure(ctx, { userId, guildId, purpose, reason }) {
  try {
    if (guildId) await ctx.db.batch(failureAuditStatements(ctx, { guildId, userId, action: 'fresh.failed', detail: `${purpose}:${reason}` }));
    else ctx.log(`fresh-auth refused: ${purpose} ${reason}`);
  } catch (error) {
    ctx.log(`fresh-auth failure not counted: ${error && error.message}`);
  }
}

// ---------------------------------------------------------------------------
// The identity rule (a)

// row: the account's identity facts (loadIdentityRow) -> { held, id, linkedAt, passes, eligibleAt }. passes: founding (first linked within 60 s of the account's creation) or
// first linked at least 7 days ago. A first-link time that is missing (a link written by code from before the column existed) never passes for Discord; Battle.net falls back to
// the time of the link (linked_at, which a refresh only moves later).
export function identityStanding(row, provider, nowMs) {
  const id = provider === 'discord' ? row.discord_id : row.bnet_account_id;
  const linkedAt = provider === 'discord' ? row.discord_linked_at : row.bnet_first_linked_at;
  if (!id) return { held: false, id: null, linkedAt: null, passes: false, eligibleAt: null };
  if (linkedAt === null || linkedAt === undefined) return { held: true, id, linkedAt: null, passes: false, eligibleAt: null };
  const founding = linkedAt <= row.created_at + FOUNDING_WINDOW_MS;
  const old = linkedAt <= nowMs - NEW_IDENTITY_MS;
  return { held: true, id, linkedAt, passes: founding || old, eligibleAt: founding ? linkedAt : linkedAt + NEW_IDENTITY_MS };
}

export function loadIdentityRow(db, userId) {
  return db.prepare(
    `SELECT u.created_at, u.discord_id, u.discord_linked_at, b.bnet_account_id, COALESCE(b.first_linked_at, b.linked_at) AS bnet_first_linked_at
       FROM users u LEFT JOIN bnet_links b ON b.user_id = u.id WHERE u.id = ?`,
  ).bind(userId).first();
}

// { sql, params }: the account holds this identity NOW (and, with rule, it passes (a) at nowMs). The same test as identityStanding, inside the write that depends on it.
export function identityGuard(provider, userId, identityId, { rule, nowMs }) {
  if (provider === 'discord') {
    return {
      sql: `EXISTS (SELECT 1 FROM users fu WHERE fu.id = ? AND fu.discord_id = ?${rule
        ? ' AND fu.discord_linked_at IS NOT NULL AND (fu.discord_linked_at <= fu.created_at + ? OR fu.discord_linked_at <= ?)' : ''})`,
      params: [userId, identityId, ...(rule ? [FOUNDING_WINDOW_MS, nowMs - NEW_IDENTITY_MS] : [])],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM bnet_links fb JOIN users fu ON fu.id = fb.user_id WHERE fb.user_id = ? AND fb.bnet_account_id = ?${rule
      ? ' AND (COALESCE(fb.first_linked_at, fb.linked_at) <= fu.created_at + ? OR COALESCE(fb.first_linked_at, fb.linked_at) <= ?)' : ''})`,
    params: [userId, identityId, ...(rule ? [FOUNDING_WINDOW_MS, nowMs - NEW_IDENTITY_MS] : [])],
  };
}

// The callback side: write the grant for a verified state. parsed: { purpose, guildId, paramsHash } from verifyFreshState. identityId: what the provider returned.
// -> { ok: true } | { ok: false, reason: 'provider' | 'mismatch' | 'identity_new' }. Never touches the session's token, cookie or expiry.
export async function writeFreshGrant(ctx, { session, provider, identityId, parsed, nowMs }) {
  const spec = FRESH_PURPOSES[parsed.purpose];
  if (!spec || !spec.providers.includes(provider)) return { ok: false, reason: 'provider' };
  const row = await loadIdentityRow(ctx.db, session.user.id);
  if (!row) return { ok: false, reason: 'mismatch' };
  const standing = identityStanding(row, provider, nowMs);
  if (!standing.held || standing.id !== identityId) return { ok: false, reason: 'mismatch' };
  if (spec.identityRule && !standing.passes) return { ok: false, reason: 'identity_new' };
  // The identity is checked again inside the write: a swap between the read and the UPDATE grants nothing.
  const holds = identityGuard(provider, session.user.id, identityId, { rule: spec.identityRule, nowMs });
  const result = await ctx.db.prepare(
    `UPDATE sessions SET fresh_purpose = ?, fresh_hash = ?, fresh_at = ? WHERE token_hash = ? AND user_id = ? AND expires_at > ? AND ${holds.sql}`,
  ).bind(parsed.purpose, parsed.paramsHash, nowMs, session.tokenHash, session.user.id, nowMs, ...holds.params).run();
  return result.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------
// Identity-change protection

// SQL: the account holds the Owner seat of a guild (suspended or not, or the stored Guild Master of a guild before the flip) or any staff role (GM-tier, Officer, Team Lead,
// stored or derived: the effective-roles view) in any guild. The user expression is written three times: bind the account three times.
export const protectedAccountSql = (userExpr) =>
  `(EXISTS (SELECT 1 FROM (${ownedGuildsSql(userExpr)}) pa_owned)
    OR EXISTS (SELECT 1 FROM effective_roles pa_er WHERE pa_er.user_id = ${userExpr} AND pa_er.role_id IN ('guild_master', 'officer', 'team_lead')))`;
export const protectedGuard = (userId) => ({ sql: protectedAccountSql('?'), params: [userId, userId, userId] });

export async function isProtectedAccount(db, userId) {
  const guard = protectedGuard(userId);
  const row = await db.prepare(`SELECT ${guard.sql} AS protected`).bind(...guard.params).first();
  return !!row && row.protected === 1;
}

// The begin of an identity-change batch (link or unlink of Discord or Battle.net). A PROTECTED account must hold a fresh grant for exactly this change (purpose
// identity_change, params { change }); the act then consumes it inside the batch. Any other account needs none, but its statements carry NOT protected, so an account that became
// staff between the read and the write changes nothing. `protectedAccount`: the answer when the caller has already read it. -> the same shape as beginFreshAct plus { protectedAccount }.
export async function beginIdentityChange(ctx, { userId, change, protectedAccount: known }) {
  const protectedAccount = known === undefined ? await isProtectedAccount(ctx.db, userId) : known;
  if (protectedAccount) {
    return { ...(await beginFreshAct(ctx, { required: true, purpose: 'identity_change', params: { change } })), protectedAccount: true };
  }
  const guard = protectedGuard(userId);
  return {
    required: false, protectedAccount: false, statements: [], offset: 0, consumed: () => true,
    guard: { sql: `NOT ${guard.sql}`, params: guard.params },
  };
}

// For a begin route that only checks (the Discord and Battle.net link starts): true when this account must show a fresh grant for this change and does not hold one.
export async function identityChangeBlocked(ctx, { userId, change }) {
  if (!(await isProtectedAccount(ctx.db, userId))) return false;
  try {
    await assertFresh(ctx, { purpose: 'identity_change', hash: await freshHash({ purpose: 'identity_change', params: { change } }) });
    return false;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'fresh_required') return true;
    throw error;
  }
}

export const clearGrantsStatement = (db, userId, guard = ALWAYS) =>
  db.prepare(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = ? AND fresh_purpose IS NOT NULL AND ${guard.sql}`).bind(userId, ...guard.params);

// The two statements every identity change writes before the change itself (membership is read BEFORE a Discord disconnect deletes the server rows): the audit row in each
// guild the account is a member of (identity.change: { provider, change: 'link' | 'unlink' }) and the nulling of every grant the account's sessions hold (c).
// `guard` is the change's own condition (the identity is there to unlink, or not there to link) together with the act's guard.
export function identityChangeStatements(ctx, { userId, provider, change, guard }) {
  return [
    auditEachMemberGuildStatement(ctx, { actorUserId: userId, action: 'identity.change', entityType: 'user', entityId: userId, after: { provider, change } }, guard),
    clearGrantsStatement(ctx.db, userId, guard),
  ];
}
