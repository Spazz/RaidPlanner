// The Guild Master's claim of the Owner seat (user-hierarchy build, lane B6b part 2b; plan "Owner", "Fresh-auth" acceptance (4), U R3-Q3, U R6-Q1, U R7-Q1).
//
// The in-game Guild Master may take the seat at any time: when it is vacant, when a previous Owner is suspended or when a live Owner is simply someone else. The authority is
// LIVE BLIZZARD DATA and nothing the guild stored:
//   the claimant's Battle.net account (fresh OAuth, done a moment ago) lists a character whose identity key (namespace, realm id, character id) is the LIVE roster's single rank-0
//   member, and that roster is the one of the guild's pinned Blizzard guild (assessRoster: the sync's own validity rules, the Blizzard guild and realm id of the pin, exactly one
//   rank 0). The decision reads no characters, players, guild_blocks or tombstones: a squatter who typed the GM's name, linked the GM's character to an account, blocked the GM's
//   account or left a tombstone on the GM's key changes nothing about WHETHER the claim is allowed, and the claim then removes what stood in the way. (The preflight does ask the
//   Owner view whether the caller already is the live Owner and whether the seat holder is suspended: that is the seat's own state; it can turn the Owner's own claim away and
//   word the audit row, it never lets anyone in or keeps the real GM out.)
//
// THE GRANT. The claim EXECUTES INSIDE the Battle.net fresh-auth callback that holds the user's access token (routes/bnet.js bnetFreshCallback), so nothing is left on the session
// for a later request: for purpose gm_claim the callback writes NO grant (sessions.fresh_* is untouched; a grant of another purpose stays what it was). The callback itself is the
// fresh proof (a purpose-bound MAC'd state, the state cookie, a single-use nonce, the Battle.net account that came back is the one linked to the signed-in account: checkFreshIdentity),
// and the act's own marker below keeps the batch all-or-nothing the way the grant's marker does for the other acts (worker/fresh.js).
//
// THE BATCH (one db.batch, in this order; the first two statements must stay adjacent and in this order, a test swaps them):
//   1  moveSeatStatement: guilds.owner_user_id from the seat AS READ (NULL included) to the claimant, `AND owner_user_id IS <seat as read>`, the claimant still holds this Battle.net
//      account, the pin is still the one the roster was fetched for. A race (two claims, a hand-over in between, a re-pin) changes no row.
//   2  the marker, fresh_act_markers `WHERE changes() = 1 AND the seat is now the claimant's`: the second condition makes a swapped order refuse deterministically.
//   Every later statement carries EXISTS (marker), so a lost race applies NOTHING (the answer is /#/fresh?error=conflict&purpose=gm_claim):
//   3  deletes the claimant's guild_blocks row in this guild
//   4  deletes the guild's tombstones of the claimant's keys (Battle.net account id, Discord id, identity keys of the claimant's live characters on this roster; every key version the
//      keyring holds, worker/block-tombstones.js tombstoneHmacsAllVersions) and of the claimant's own block ref
//   5  deletes the guild's outstanding dry_run_approvals (an old rank-map or flip token answers 409 approval_invalid: the dry run is re-armed)
//   6  unpublishes the public page (guilds.public_enabled 0)
//   7  the claimant's person and the GM character (worker/bnet-match.js claimCharacterStatements): the person is made or linked when there is none, a typed name is bound to the key,
//      a character on another person is re-homed (worker/rehome.js, reason 'gm_claim'; the old person keeps every row and gets a placeholder), the proof is stamped (owner_proof
//      'bnet', proof_user_id = the claimant): the claimant is LIVE (not suspended) the moment the batch commits, unless this part had to be skipped (see THE STORED ROSTER)
//   8  the audit row guild.claim (never pruned): the previous holder (or null), whether that holder was suspended, actor_role 'owner'
// Bearer artifacts (API keys, guest links, raid join links, team webhooks) are NOT touched (U R7-Q1); stored roles, rank-map permissions and hand-links stay live and are listed for
// the new Owner (routes/claim-review.js, U R6-Q1).
//
// THE STORED ROSTER. Liveness reads the STORED roster (guild_roster). When it does not hold the GM's key (the GM is new since the last sync) the fetched roster, which passed
// assessRoster, is applied first as one good sync (replaceStoredRoster: U R5-Q6 trusts one good response). That is one batch of its own BEFORE the claim batch, because the claim's
// character statements insert from guild_roster; it costs about 18 D1 statements on a 1,200-member roster. A callback has 45: when the roster apply or the character part does not fit
// what is left, that part is skipped (`gm claim deferred: budget`), the claim still happens and the claimant is the Owner without a proven character until the next sign-in match.
import { auditStatement } from './audit.js';
import { BnetError, assessRoster, bnetSupport, fetchAccountCharacters, fetchGuildRosterBySlug } from './battlenet.js';
import { tombstoneHmacsAllVersions } from './block-tombstones.js';
import { CALLBACK_STATEMENT_BUDGET, claimCharacterStatements, keyedCharacters, readClaimFacts, readClaimRows } from './bnet-match.js';
import { realmDisplayName } from './bnet-store.js';
import { markerGuard, newMarkerId } from './dry-run.js';
import { checkFreshIdentity, freshAccountKey, freshSessionKey, identityGuard, noteFreshFailure } from './fresh.js';
import { HttpError } from './http.js';
import { newId } from './ids.js';
import { moveSeatStatement, ownerSql, seatHeldBySql, seatHolderSql } from './owner.js';
import { bnetCallbackKey, refundRateLimit } from './ratelimit.js';
import { pinOf } from './roster-pin.js';
import { replaceStoredRoster, rosterHash } from './roster-sync.js';

export const CLAIM_PURPOSE = 'gm_claim';
// The head of the claim batch (seat, marker, four deletes / updates) plus its audit row: what must fit before anything else is spent.
const CLAIM_HEAD_STATEMENTS = 7;

// One read: the guild, its pin, the seat, whether the seat holder is suspended, whether the caller is the live Owner already. (?1 the guild, ?2 the caller.)
const PREFLIGHT_SQL = `SELECT g.id, g.game_version, g.region, g.realm, g.realm_kind, g.time_zone, g.rank_source, g.public_enabled, g.roster_hash,
       g.pinned_guild_slug, g.pinned_realm_slug, g.pinned_namespace, g.blizzard_guild_id, g.blizzard_realm_id,
       ${seatHolderSql('g.id')} AS seat_holder,
       CASE WHEN ${seatHolderSql('g.id')} IS NULL THEN 0 WHEN ${ownerSql('g.id', seatHolderSql('g.id'))} THEN 0 ELSE 1 END AS seat_suspended,
       ${ownerSql('g.id', '?2')} AS caller_is_owner
  FROM guilds g WHERE g.id = ?1`;

// -> { row, pin, support } for a guild that can be claimed by this account, else throws: 404 not_found (no such guild), 409 claim_not_available (the guild does not run on the
// in-game roster or its pin is incomplete), 409 already_owner (the caller holds the seat and is not suspended). Used by POST .../fresh/start and again by the callback.
export async function claimPreflight(db, { guildId, userId }) {
  const row = await db.prepare(PREFLIGHT_SQL).bind(guildId, userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  const pin = pinOf(row);
  const support = bnetSupport(row.game_version, row.region);
  if (row.rank_source !== 'ingame' || !pin.complete || !support.supported || support.namespace !== pin.namespace) {
    throw new HttpError(409, 'claim_not_available', 'This guild does not run on its in-game roster yet, so there is no Guild Master seat to claim.');
  }
  if (row.caller_is_owner === 1) throw new HttpError(409, 'already_owner', 'You hold the Owner seat of this guild already.');
  return { row, pin, support };
}

const PIN_MISMATCHES = Object.freeze(['guild_id_mismatch', 'realm_id_mismatch']);

// The decision, pure. roster: parseGuildRoster's answer, characters: fetchAccountCharacters' answer for the pin's namespace, pin: pinOf(guild).
// -> { ok: true, gm (the roster's rank-0 member), mine (the claimant's own entry for it) } | { ok: false, reason, malformed? } with reason the roster rule that failed (assessRoster:
// guild_id_mismatch, realm_id_mismatch, several_rank_zero, ...) or 'not_rank_zero' (the roster is fine and its Guild Master is somebody else's character). `malformed` is true for
// a roster that is broken in itself (cut off, members missing, duplicate names or ids, an invalid row, no rank 0 or several): the rules of assessRoster that are about the SHAPE of the
// answer. A roster of another Blizzard guild or realm than the pin (guild_id_mismatch, realm_id_mismatch) is well formed, and stays a refusal of the claim.
export function claimVerdict({ roster, characters, pin }) {
  const assessed = assessRoster(roster, { guildId: pin.blizzardGuildId, realmId: pin.blizzardRealmId });
  if (!assessed.good) return { ok: false, reason: assessed.reason, ...(PIN_MISMATCHES.includes(assessed.reason) ? {} : { malformed: true }) };
  const gm = roster.members.find((member) => member.rank === 0);
  const mine = characters.find((entry) => entry.namespace === gm.namespace && entry.realmId === gm.realmId && entry.characterId === gm.characterId);
  return mine ? { ok: true, gm, mine } : { ok: false, reason: 'not_rank_zero' };
}

const pinHolds = (guildId, pin) => ({
  sql: `EXISTS (SELECT 1 FROM guilds WHERE id = ? AND rank_source = 'ingame' AND pinned_guild_slug = ? AND pinned_realm_slug = ? AND pinned_namespace = ?
                  AND blizzard_guild_id = ? AND blizzard_realm_id = ?)`,
  params: [guildId, pin.guildSlug, pin.realmSlug, pin.namespace, pin.blizzardGuildId, pin.blizzardRealmId],
});

// Statement 2 of the claim: written only when the seat move just before it changed a row AND the seat is the claimant's now. (worker/fresh.js explains the second condition:
// a marker written BEFORE the move would otherwise read a stale changes().)
export const claimMarkerStatement = (db, { markerId, tokenHash, nowMs, guildId, userId }) => db.prepare(
  `INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at)
   SELECT ?, ?, 'gm_claim', ? WHERE changes() = 1 AND ${seatHeldBySql('?', '?')}`,
).bind(markerId, tokenHash, nowMs, guildId, userId);

// The statements of the claim before the character part: the seat, the marker and the four deletes/updates (see the header). `hmacs`: the tombstone hashes of the claimant's keys.
// -> { statements (6), guard }.
export function claimHeadStatements(ctx, { guildId, userId, from, bnetAccountId, pin, markerId, tokenHash, nowMs, hmacs }) {
  const { db } = ctx;
  const guard = markerGuard(markerId);
  return {
    guard,
    statements: [
      moveSeatStatement(db, { guildId, from, to: userId, guards: [identityGuard('bnet', userId, bnetAccountId, { rule: false, nowMs }), pinHolds(guildId, pin)] }),
      claimMarkerStatement(db, { markerId, tokenHash, nowMs, guildId, userId }),
      db.prepare(`DELETE FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND ${guard.sql}`).bind(guildId, userId, ...guard.params),
      db.prepare(
        `DELETE FROM block_tombstones WHERE guild_id = ? AND (hmac IN (SELECT value FROM json_each(?)) OR block_ref = ?) AND ${guard.sql}`,
      ).bind(guildId, JSON.stringify(hmacs), `u:${userId}`, ...guard.params),
      db.prepare(`DELETE FROM dry_run_approvals WHERE guild_id = ? AND used_at IS NULL AND ${guard.sql}`).bind(guildId, ...guard.params),
      db.prepare(`UPDATE guilds SET public_enabled = 0 WHERE id = ? AND public_enabled = 1 AND ${guard.sql}`).bind(guildId, ...guard.params),
    ],
  };
}

// The audit row of the claim, last in the batch. actor_role is recorded as 'owner': the claimant took the seat in this very batch.
export const claimAuditStatement = (ctx, { guildId, userId, from, suspended, unpublished, guard }) => auditStatement(ctx, {
  guildId, actorUserId: userId, action: 'guild.claim', entityType: 'guild', entityId: guildId, actorRole: 'owner',
  before: { guildMasterUserId: from, suspended },
  after: { guildMasterUserId: userId, via: 'gm_claim', ...(unpublished ? { unpublished: true } : {}) },
}, guard);

// The claim, inside the Battle.net fresh-auth callback. input: { session, parsed ({ purpose, guildId }), accessToken, info ({ id, battletag }), now, spent (the D1 statements the
// callback has used so far) }. -> { ok: true, deferred: [reason] } | { ok: false, reason: 'mismatch' | 'identity_new' | 'provider' | 'not_gm' | 'conflict' } (the redirect reasons of
// worker/fresh.js plus not_gm and conflict). A refused verdict is counted with B7a's helper (audit guild.claim_failed, one row per user, guild and hour); a roster that is
// malformed in itself is 'provider' (try again later) and counts nothing (see claimVerdict).
export async function runGmClaim(ctx, { session, parsed, accessToken, info, now, spent }) {
  const { db } = ctx;
  const userId = session.user.id;
  const guildId = parsed.guildId;
  let used = spent;
  const fits = (count) => used + count <= CALLBACK_STATEMENT_BUDGET;
  const deferred = new Set();

  // The Battle.net account that came back must be the one linked to this account (the same check the grants make, and again inside the batch).
  const identity = await checkFreshIdentity(ctx, { session, provider: 'bnet', identityId: info.id, purpose: CLAIM_PURPOSE, nowMs: now });
  used += 1;
  if (!identity.ok) {
    if (identity.reason !== 'provider') await noteFreshFailure(ctx, { userId, guildId, purpose: CLAIM_PURPOSE, reason: identity.reason });
    return identity;
  }

  // The guild may have changed since the start step (flipped back, re-pinned, the caller became the Owner): a conflict, nothing is fetched.
  let guild;
  try {
    guild = await claimPreflight(db, { guildId, userId });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ok: false, reason: 'conflict' };
  }
  used += 1;
  const { row, pin } = guild;

  // LIVE DATA: the claimant's characters (their own token) and the guild's roster by the stored pin (the client token). Nothing a squatter can write is read.
  const startedAt = ctx.now();
  let characters;
  let roster;
  try {
    [characters, roster] = await Promise.all([
      fetchAccountCharacters(ctx, accessToken, row.region, pin.namespace),
      fetchGuildRosterBySlug(ctx, row.region, pin.namespace, pin.realmSlug, pin.guildSlug),
    ]);
  } catch (error) {
    ctx.log(`gm claim: Blizzard step failed: ${error instanceof BnetError ? error.kind : ''} ${error && error.message}`);
    return { ok: false, reason: 'provider' };
  }
  const verdict = claimVerdict({ roster, characters, pin });
  if (!verdict.ok && verdict.malformed) {
    // A roster Blizzard sent cut off, with duplicate names or without exactly one rank 0 says nothing about the claimant: it is a Battle.net problem ("try again later"), not a failed
    // claim. Nothing is counted against the claimant: no guild.claim_failed row, no failure counter, and the attempt limits this attempt spent are given back (the start budget of the
    // session and of the account, the callback window of their Blizzard account), so retrying a broken answer never locks out a real Guild Master. The platform-wide callback
    // tripwire (bnetcb:global) is nobody's and stays counted.
    ctx.log(`gm claim: the roster is not usable: ${verdict.reason}`);
    await refundRateLimit(db, [freshSessionKey(session.tokenHash), freshAccountKey(userId), bnetCallbackKey(info.id)]);
    return { ok: false, reason: 'provider' };
  }
  if (!verdict.ok) {
    ctx.log(`gm claim: refused: ${verdict.reason}`);
    await noteFreshFailure(ctx, { userId, guildId, purpose: CLAIM_PURPOSE, reason: verdict.reason, action: 'guild.claim_failed' });
    return { ok: false, reason: 'not_gm' };
  }
  const { gm, mine } = verdict;

  // The GM's character as the sign-in match keys it, and the claimant's keys in this guild (what a tombstone of theirs would hold).
  const realm = realmDisplayName(row.game_version, row.region, mine.realmSlug, mine.realmName);
  const item = keyedCharacters({
    [gm.namespace]: { fetchedAt: startedAt, characters: [{ name: mine.name, realm, realmSlug: mine.realmSlug, class: mine.class, level: mine.level, characterId: gm.characterId, realmId: gm.realmId, namespace: gm.namespace }] },
  })[0];
  const idkey = (entry) => `idkey:${entry.namespace}:${entry.realmId}:${entry.characterId}`;
  const onRoster = new Set(roster.members.map(idkey));
  const hmacs = await tombstoneHmacsAllVersions(ctx.env, guildId, {
    bnetAccountId: info.id, discordId: session.user.discordId || null, identityKeys: characters.filter((entry) => onRoster.has(idkey(entry))).map(idkey),
  });

  const markerId = newMarkerId(ctx.randomBytes);
  const input = { guildId, userId, from: row.seat_holder, bnetAccountId: info.id, pin, markerId, tokenHash: session.tokenHash, nowMs: now, hmacs };
  const head = claimHeadStatements(ctx, input);
  const audit = claimAuditStatement(ctx, { guildId, userId, from: row.seat_holder, suspended: row.seat_suspended === 1, unpublished: row.public_enabled === 1, guard: head.guard });

  // The character part (a convenience that keeps the claimant live, see the header): the stored roster must hold the GM's key, so the fetched one is applied first when it does
  // not (one batch of its own), then the person and the character are planned. Whatever goes wrong here costs the part, never the claim.
  let chars = [];
  try {
    let facts = await readClaimFacts(db, { guildId, userId, item });
    used += 2;
    if (!facts.rows.length) {
      const hash = await rosterHash(roster);
      if (hash !== row.roster_hash) {
        const applied = await replaceStoredRoster(ctx, {
          guildId, guild: row, pin, roster, hash, startedAt, syncId: newId('rs', ctx.randomBytes), fits: (count) => fits(count + CLAIM_HEAD_STATEMENTS),
        });
        if (applied.status === 'skipped') deferred.add('budget');
        used += applied.statements;
        if (applied.status === 'applied' || applied.status === 'superseded') {
          facts = { ...facts, rows: await readClaimRows(db, { guildId, userId, item }) };
          used += 1;
        }
      }
    }
    const characterPart = await claimCharacterStatements(ctx, facts, { guildId, userId, bnetAccountId: info.id, item, now, gate: head.guard });
    used += characterPart.reads;
    for (const reason of characterPart.deferred) deferred.add(reason);
    chars = characterPart.statements;
    if (!fits(head.statements.length + chars.length + 1)) {
      if (chars.length) deferred.add('budget');
      chars = [];
    }
  } catch (error) {
    ctx.log(`gm claim: the character part could not be planned: ${error && error.message}`);
    deferred.add('character');
  }
  for (const reason of deferred) ctx.log(`gm claim deferred: ${reason}`);

  const run = async (character) => {
    const results = await db.batch([...head.statements, ...character, audit]);
    return results[0].meta.changes === 1;
  };
  try {
    return (await run(chars)) ? { ok: true, deferred: [...deferred] } : { ok: false, reason: 'conflict' };
  } catch (error) {
    ctx.log(`gm claim: the batch failed and rolled back: ${error && error.message}`);
    if (!chars.length) return { ok: false, reason: 'conflict' };
  }
  // The character part is a convenience that keeps the claimant live; the seat is the authority. A part that cannot be written (a cap trigger, a unique clash with a concurrent
  // sign-in) must not cost the claim: it is retried once without it, and the next sign-in match places the character.
  deferred.add('character');
  ctx.log('gm claim deferred: character');
  try {
    return (await run([])) ? { ok: true, deferred: [...deferred] } : { ok: false, reason: 'conflict' };
  } catch (error) {
    ctx.log(`gm claim: the batch failed again: ${error && error.message}`);
    return { ok: false, reason: 'conflict' };
  }
}
