// The setup pin: the Owner links the guild to its in-game guild (user-hierarchy build, lane B6b part 3a; plan "Source/pin" rules (1) and (3)).
//   POST /api/guild/:gid/bnet/pin   body { guildName, realmSlug }   Owner only, behind the operator allowlist SETUP_PIN_GUILDS, needs a consumed `pin` fresh-auth grant
//     -> 200 { pinned: true, mode: 'first' | 're_pin', guildName, guildSlug, realmSlug, namespace, rankSource, sync: { status, reason, members, syncId } }
//   403 pin_not_open (SETUP_PIN_GUILDS unset, empty or without this guild; '*' opens it for every guild) | forbidden (not the Owner: an Officer, a derived Guild Master, a suspended
//       Owner) | fresh_required { purpose: 'pin', params } (no grant for exactly this target, or older than 15 minutes, or the character read of the callback is missing) |
//       pin_not_on_roster (none of the Owner's Battle.net characters is on that guild's live roster)
//   400 bad_request { field: guildName | realmSlug } | 404 bnet_guild_not_found | 409 bnet_unsupported | pin_taken (another Raidsmith guild holds that Blizzard guild) | pin_locked (a re-pin to
//       a DIFFERENT Blizzard guild) | roster_too_large (above the 1,200 fetch limit) | roster_over_caps (more members than a guild holds people) | conflict (the guild moved while this ran)
//   429 / 503 rate_limited (6 tries per 10 minutes per Owner, fail closed) | 502 bnet_unavailable | bnet_guild_refused | bnet_roster_invalid | 503 bnet_not_configured
//
// THE FLOW (cheap before expensive; nothing is spent until the batch):
//   allowlist -> Owner (worker/owner-gate.js: no membership test first) -> body -> the guild and its pin -> the grant is READ (403 fresh_required before any Blizzard call) -> rate limit
//   -> ONE Blizzard fetch of the roster of the target named in the BODY (the only fetch whose target is not a stored pin: it is the pin being decided) -> decision on live data only
//   -> ONE db.batch: consume the grant (marker pattern, worker/fresh.js), write the pin, audit it -> the first sync of the fetched roster in the same invocation.
//
// THE DECISION trusts only live Blizzard data: the roster that was just fetched (assessRoster: the sync's own validity rules; a response that is not GOOD pins nothing), and the
// account's characters that the pin's fresh-auth callback read from Blizzard when the person confirmed it was them (worker/pin-proof.js). One of those characters must be a member of
// the roster (identity key: namespace, realm id, character id). No character row, person, proof or officer link of the guild is read for the decision.
// A guild that has a Blizzard guild id already is LOCKED to it: a re-pin (after a Blizzard rename or a realm move) must name the SAME Blizzard guild, else 409 pin_locked.
// THE FIRST SYNC. The fetched roster is applied in the same invocation (worker/roster-sync.js settleFetchedRoster, the part of a sync after the fetch: no second fetch, no second
// parse). The pin sets the guild's sync lease one interval ahead, so the scheduler has nothing to do for it. A sync that fails leaves the pin standing and says so in `sync`
// ({ status: 'failed', reason }) and hands the lease back (roster-sync.js releaseSyncLease), so Sync now or the next scheduled sync tries again AT ONCE, without the hour a lease
// would otherwise hold it back.
// Statements and Blizzard requests: measured in tests/guild/guild-b6b-p3a-tests.js (a 1,200-member roster stays inside the 45 D1 statements of Workers Free).
import { HttpError, isUniqueViolation, jsonResponse } from '../http.js';
import { BnetError, assessRoster, bnetSupport, fetchGuildRosterBySlug, rosterHttpError, rosterInvalidHttpError } from '../battlenet.js';
import { parseSnapshot } from '../bnet-store.js';
import { allOf, beginFreshAct, freshRequiredError, identityGuard } from '../fresh.js';
import { expectedPinGuard, pinAuditStatement, setupPinStatement } from '../guild-pin.js';
import { newId } from '../ids.js';
import { LIMITS } from '../limits.js';
import { ownerGuard } from '../owner.js';
import { requireOwnerFirst } from '../owner-gate.js';
import { characterOnRoster, livePinCharacters } from '../pin-proof.js';
import { PIN_NOT_OPEN_MESSAGE, canonicalPinParams, pinOpen, readPinTarget } from '../pin-target.js';
import { PIN_LIMIT, PIN_WINDOW_MS, enforceRateLimit, pinKey } from '../ratelimit.js';
import { PIN_SQL, pinOf } from '../roster-pin.js';
import { SYNC_INTERVAL_MS, releaseSyncLease, settleFetchedRoster } from '../roster-sync.js';
import { requireBnetConfigured } from './bnet-import.js';
import { bad } from './roster.js';

const OWNER_MESSAGE = 'Only the Owner of the guild can link it to its in-game guild.';
// The grant's session and the account's Battle.net link in one read: when the grant was written, and the characters the pin's callback read at that time.
const PROOF_SQL = `SELECT s.fresh_at AS fresh_at, b.bnet_account_id AS bnet_account_id, b.snapshot AS snapshot
  FROM sessions s JOIN bnet_links b ON b.user_id = s.user_id WHERE s.token_hash = ? AND s.user_id = ?`;
// Another Raidsmith guild that holds this Blizzard guild (the unique index guilds_blizzard_identity answers it).
const TAKEN_SQL = 'SELECT id FROM guilds WHERE game_version = ? AND region = ? AND blizzard_realm_id = ? AND blizzard_guild_id = ? AND id != ?';

export async function postBnetPin(ctx) {
  const { db, env, body, session } = ctx;
  const userId = session.user.id;
  const guildId = ctx.params.gid;
  if (!pinOpen(env, guildId)) throw new HttpError(403, 'pin_not_open', PIN_NOT_OPEN_MESSAGE);
  await requireOwnerFirst(db, { userId, guildId, viewAs: session.viewAs }, OWNER_MESSAGE);
  const read = readPinTarget(body);
  if (read.problem) throw bad(read.problem, read.field);
  const { target } = read;
  requireBnetConfigured(env);

  const guild = await db.prepare(PIN_SQL).bind(guildId).first();
  if (!guild) throw new HttpError(404, 'not_found', 'That guild does not exist.');
  const support = bnetSupport(guild.game_version, guild.region);
  if (!support.supported) throw new HttpError(409, 'bnet_unsupported', support.message);
  const current = pinOf(guild);
  const params = canonicalPinParams(target);
  const expected = {
    rankSource: current.rankSource, guildSlug: current.guildSlug, realmSlug: current.realmSlug, namespace: current.namespace,
    blizzardGuildId: current.blizzardGuildId, blizzardRealmId: current.blizzardRealmId,
  };

  // The grant is read BEFORE the Blizzard call: a request without one costs Blizzard nothing. The batch below consumes it.
  const proofRow = await db.prepare(PROOF_SQL).bind(session.tokenHash, userId).first();
  if (!proofRow) throw freshRequiredError('pin', params);
  const act = await beginFreshAct(ctx, {
    purpose: 'pin', guildId, params,
    extra: allOf(ownerGuard(guildId, userId), identityGuard('bnet', userId, proofRow.bnet_account_id, { rule: true, nowMs: ctx.now() }), expectedPinGuard(guildId, expected)),
  });
  await enforceRateLimit(db, userId, ctx.now(), { key: pinKey(userId), limit: PIN_LIMIT, windowMs: PIN_WINDOW_MS, failClosed: true });

  const startedAt = ctx.now();
  let roster;
  try {
    roster = await fetchGuildRosterBySlug(ctx, guild.region, support.namespace, target.realmSlug, target.guildSlug, target.guildName);
  } catch (error) {
    if (!(error instanceof BnetError)) throw error;
    ctx.log(`bnet pin: ${error.kind}: ${error.message}`);
    throw rosterHttpError(error);
  }

  // The decision.
  if (roster.guildId === null || roster.guildRealmId === null) throw rosterInvalidHttpError('guild_id_missing');
  if (current.blizzardGuildId !== null && roster.guildId !== current.blizzardGuildId) {
    throw new HttpError(409, 'pin_locked', 'This guild is linked to another in-game guild already. It can only be linked again to the same in-game guild, after that guild was renamed or moved to another realm.');
  }
  if (roster.truncated) throw new HttpError(409, 'roster_too_large', 'That in-game guild has more members than Raidsmith can read from Battle.net (1,200), so it cannot be linked.');
  const verdict = assessRoster(roster);
  if (!verdict.good) {
    ctx.log(`bnet pin: not good: ${verdict.reason}`);
    throw rosterInvalidHttpError(verdict.reason);
  }
  if (roster.members.length > LIMITS.people) {
    throw new HttpError(409, 'roster_over_caps', `That in-game guild has ${roster.members.length} members and a guild on Raidsmith holds at most ${LIMITS.people} people, so it cannot be linked.`);
  }
  const live = livePinCharacters(parseSnapshot(proofRow.snapshot)[support.namespace], proofRow.fresh_at);
  if (!live) throw freshRequiredError('pin', params);
  if (!characterOnRoster(roster, live.characters, support.namespace)) {
    throw new HttpError(403, 'pin_not_on_roster', 'None of the characters on your Battle.net account is in that in-game guild, so this guild cannot be linked to it.');
  }
  const taken = await db.prepare(TAKEN_SQL).bind(guild.game_version, guild.region, roster.guildRealmId, roster.guildId, guildId).first();
  if (taken) throw pinTaken();

  const pin = { guildSlug: target.guildSlug, realmSlug: target.realmSlug, namespace: support.namespace, blizzardGuildId: roster.guildId, blizzardRealmId: roster.guildRealmId };
  const mode = current.blizzardGuildId === null ? 'first' : 're_pin';
  const leasedUntil = ctx.now() + SYNC_INTERVAL_MS;
  let results;
  try {
    results = await db.batch([
      ...act.statements,
      setupPinStatement(db, { guildId, pin, expected, nextSyncAt: leasedUntil, guards: [act.guard] }),
      pinAuditStatement(ctx, {
        guildId, userId, guard: act.guard,
        before: { pinned: current.complete, guildSlug: current.guildSlug, realmSlug: current.realmSlug },
        after: { guildSlug: pin.guildSlug, realmSlug: pin.realmSlug, namespace: pin.namespace, rePin: mode === 're_pin' },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw pinTaken();
    throw error;
  }
  // Lost the race (a hand-over, a flip, another pin, a spent grant): nothing was written and the grant is as it was.
  if (!act.consumed(results)) throw freshRequiredError('pin', params);
  if (results[act.offset].meta.changes !== 1) throw new HttpError(409, 'conflict', 'The guild changed while it was being linked. Reload and try again.');

  const pinned = pinOf({
    rank_source: guild.rank_source, pinned_guild_slug: pin.guildSlug, pinned_realm_slug: pin.realmSlug, pinned_namespace: pin.namespace,
    blizzard_guild_id: pin.blizzardGuildId, blizzard_realm_id: pin.blizzardRealmId,
  });
  const sync = await settleFetchedRoster(ctx, { guildId, guild, pin: pinned, roster, startedAt, syncId: newId('rs', ctx.randomBytes) });
  // A first sync that FAILED hands the lease back: the guild is due now, so "Sync now" (and the next cron tick) retries at once instead of after the hour the pin's lease implies.
  // The release only undoes THIS pin's lease (a claim made since moved the column). Best effort: the pin stands either way.
  if (sync.status === 'failed') {
    try {
      await releaseSyncLease(db, guildId, { leasedUntil, nowMs: ctx.now() });
    } catch (error) {
      ctx.log(`bnet pin: the lease of the failed first sync could not be released: ${error && error.message}`);
    }
  }
  return jsonResponse({
    pinned: true, mode, guildName: roster.guildName, guildSlug: pin.guildSlug, realmSlug: pin.realmSlug, namespace: pin.namespace, rankSource: guild.rank_source,
    sync: { status: sync.status, reason: sync.reason, members: sync.members, syncId: sync.syncId },
  });
}

const pinTaken = () => new HttpError(409, 'pin_taken', 'Another guild on Raidsmith is already linked to that in-game guild.');
