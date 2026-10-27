// Block tombstones (user-hierarchy build, lane B7a; plan "Blocks", U R3-Q9, U R4-Q6, sec A9-05 / A9-08 / A9-11).
//
// A block row (guild_blocks, person_blocks) is deleted with its account (Delete my data) or person. A TOMBSTONE is what stays: an HMAC of each key the blocked
// person proved, so the same person coming back with the same Discord account, Battle.net account or Battle.net-proven character is recognised without
// Raidsmith keeping the key itself. The match at sign-in inserts a guild_blocks row marked pending_review (it ENFORCES at once; an officer reviews it).
//
//   typed value     bnet:<Battle.net account id>   discord:<Discord id>   idkey:<namespace>:<realm id>:<character id>      (the only three kinds)
//   HMAC            HMAC-SHA256(key, "raidsmith-tombstone/1\n<guild id>\n<typed value>"), base64url. The GUILD ID IS INSIDE the input: the same Discord id
//                   hashes differently in every guild, so a table dump links nothing across guilds. Stored in block_tombstones(guild_id, block_ref,
//                   key_version, hmac, created_at).
//   block_ref       ties the tombstones of one block together: 'u:<user id>' for an account block, 'p:<player id>' for an account-less person. Unblock deletes
//                   by block_ref (and by the refs the account's own keys hit: see matchedRefsOf).
//   keys (env)      TOMBSTONE_KEY .............. the current secret (a Worker secret, at least 16 characters; `openssl rand -base64 32`)
//                   TOMBSTONE_KEY_VERSION ...... its version, a whole number from 1 (default 1)
//                   TOMBSTONE_OLD_KEYS ......... retired secrets that stored tombstones still use: `<version>:<secret>,<version>:<secret>`
//                   New tombstones always use the current key; a match tries every version found in the guild's rows, so rotating is: set the new key and
//                   version, move the old pair into TOMBSTONE_OLD_KEYS. A version with no key available cannot be matched (an operator line says so).
//   unset key       a block still applies, flagged tombstone_missing = 1, with one operator error line (A9-08); the daily repair (repairTombstones) writes the
//                   tombstones once the key is set and clears the flag. The same job is the R4 backfill of blocks made before this build.
//   proven keys     only keys proven by Battle.net or an account are tombstoned (A9-05): an account's own Discord id, its Battle.net account id and the
//                   identity keys of the characters it proved through Battle.net (characters.owner_proof 'bnet', proof_user_id = the account). An account-less
//                   person has no proof: its Discord id and the identity keys Blizzard's roster gave its characters.
import { auditStatement } from './audit.js';
import { base64url, defaultRandomBytes } from './ids.js';
import { ownerGuard, ownerSql } from './owner.js';

export const MIN_KEY_LENGTH = 16;
export const MAX_VALUES = 100;
const HMAC_DOMAIN = 'raidsmith-tombstone/1';
const ENCODER = new TextEncoder();

export const accountBlockRef = (userId) => `u:${userId}`;
export const personBlockRef = (playerId) => `p:${playerId}`;

// ---------------------------------------------------------------------------
// The keyring

// -> { current: { version, secret } | null, keys: Map<version, secret>, problems: [text] }. Problems name versions, never a secret.
export function readKeyring(env) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const problems = [];
  const keys = new Map();
  let current = null;
  const secret = text(env && env.TOMBSTONE_KEY);
  if (secret) {
    const rawVersion = text(env.TOMBSTONE_KEY_VERSION);
    const version = rawVersion === '' ? 1 : Number(rawVersion);
    if (secret.length < MIN_KEY_LENGTH) problems.push(`TOMBSTONE_KEY is shorter than ${MIN_KEY_LENGTH} characters`);
    else if (!Number.isInteger(version) || version < 1 || version > 1000000) problems.push('TOMBSTONE_KEY_VERSION must be a whole number from 1');
    else {
      current = { version, secret };
      keys.set(version, secret);
    }
  }
  for (const part of text(env && env.TOMBSTONE_OLD_KEYS).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    const version = at > 0 ? Number(entry.slice(0, at)) : NaN;
    const oldSecret = at > 0 ? entry.slice(at + 1) : '';
    if (!Number.isInteger(version) || version < 1 || oldSecret.length < MIN_KEY_LENGTH) {
      problems.push(`TOMBSTONE_OLD_KEYS has an entry that is not <version>:<secret> with a secret of ${MIN_KEY_LENGTH}+ characters`);
      continue;
    }
    if (!keys.has(version)) keys.set(version, oldSecret);
  }
  return { current, keys, problems };
}

// For a health or status line: booleans and version numbers only, never a secret.
export function tombstoneKeyStatus(env) {
  const ring = readKeyring(env);
  return { configured: !!ring.current, version: ring.current ? ring.current.version : null, oldVersions: [...ring.keys.keys()].filter((v) => !ring.current || v !== ring.current.version).sort((a, b) => a - b) };
}

const importKey = (secret) => crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
async function hmacWith(cryptoKey, guildId, value) {
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(`${HMAC_DOMAIN}\n${guildId}\n${value}`))));
}

// One tombstone: HMAC-SHA256 of the guild id and the typed value under one secret.
export async function tombstoneHmac(secret, guildId, typedValue) {
  return hmacWith(await importKey(secret), guildId, typedValue);
}

// ---------------------------------------------------------------------------
// Typed values

const BNET_ID = /^\d{1,20}$/;
const DISCORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDKEY = /^idkey:[A-Za-z0-9._-]{1,64}:\d{1,10}:\d{1,12}$/;

export const kindOfValue = (value) => value.slice(0, value.indexOf(':'));

function identityValueOf(entry) {
  if (typeof entry === 'string') return IDKEY.test(entry) ? entry : null;
  if (!entry || typeof entry !== 'object') return null;
  const realm = entry.realmId ?? entry.blizzardRealmId;
  const char = entry.charId ?? entry.blizzardCharId;
  const value = `idkey:${entry.namespace}:${realm}:${char}`;
  return IDKEY.test(value) ? value : null;
}

// keys = { bnetAccountId?, discordId?, identityKeys?: [ 'idkey:<ns>:<realm>:<char>' | { namespace, realmId | blizzardRealmId, charId | blizzardCharId } ] }
// -> the distinct, well-formed typed values (a malformed one is dropped, never hashed), at most MAX_VALUES.
export function typedValuesOf(keys) {
  const out = new Set();
  if (!keys || typeof keys !== 'object') return [];
  if (keys.bnetAccountId !== undefined && keys.bnetAccountId !== null && BNET_ID.test(String(keys.bnetAccountId))) out.add(`bnet:${keys.bnetAccountId}`);
  if (keys.discordId !== undefined && keys.discordId !== null && DISCORD_ID.test(String(keys.discordId))) out.add(`discord:${keys.discordId}`);
  for (const entry of Array.isArray(keys.identityKeys) ? keys.identityKeys : []) {
    const value = identityValueOf(entry);
    if (value) out.add(value);
  }
  return [...out].slice(0, MAX_VALUES);
}

// ---------------------------------------------------------------------------
// The keys of an account / a person, from the database

const IDENTITY_COLUMNS = 'c.namespace AS namespace, c.blizzard_realm_id AS realmId, c.blizzard_char_id AS charId';
const HAS_IDENTITY = 'c.blizzard_char_id IS NOT NULL AND c.namespace IS NOT NULL AND c.blizzard_realm_id IS NOT NULL';

// The account's keys. guildId null = across guilds (the sign-in match); a guild id = the characters it proved in that guild (a block).
export async function accountKeys(db, userId, guildId = null) {
  const [account, proven] = await db.batch([
    db.prepare('SELECT u.discord_id AS discordId, (SELECT b.bnet_account_id FROM bnet_links b WHERE b.user_id = u.id) AS bnetAccountId FROM users u WHERE u.id = ?').bind(userId),
    db.prepare(
      `SELECT DISTINCT ${IDENTITY_COLUMNS} FROM characters c
        WHERE c.proof_user_id = ? AND c.owner_proof = 'bnet' AND ${HAS_IDENTITY} AND (? IS NULL OR c.guild_id = ?) LIMIT ${MAX_VALUES}`,
    ).bind(userId, guildId, guildId),
  ]);
  const row = account.results[0] || {};
  return { discordId: row.discordId || null, bnetAccountId: row.bnetAccountId || null, identityKeys: proven.results };
}

// An account-less person's keys: its Discord id and the identity keys of its characters (Blizzard's roster gave them).
export async function personKeys(db, guildId, playerId) {
  const [person, characters] = await db.batch([
    db.prepare('SELECT discord_user_id AS discordId FROM players WHERE id = ? AND guild_id = ?').bind(playerId, guildId),
    db.prepare(`SELECT DISTINCT ${IDENTITY_COLUMNS} FROM characters c WHERE c.guild_id = ? AND c.player_id = ? AND ${HAS_IDENTITY} LIMIT ${MAX_VALUES}`).bind(guildId, playerId),
  ]);
  const row = person.results[0] || {};
  return { discordId: row.discordId || null, bnetAccountId: null, identityKeys: characters.results };
}

// The same for MANY accounts / persons at once, as the statements of a db.batch (the Users page's bulk Block and Unblock stay inside one request's statement budget however many
// names they take). -> [statement, statement]; decode with keysOfAccounts / keysOfPersons. An account's identity keys are capped at MAX_VALUES each by typedValuesOf, so the
// read is capped at MAX_VALUES rows per account.
export function accountKeysStatements(db, userIds, guildId) {
  const list = JSON.stringify(userIds);
  return [
    db.prepare('SELECT u.id AS id, u.discord_id AS discordId, (SELECT b.bnet_account_id FROM bnet_links b WHERE b.user_id = u.id) AS bnetAccountId FROM users u WHERE u.id IN (SELECT value FROM json_each(?))').bind(list),
    db.prepare(
      `SELECT DISTINCT c.proof_user_id AS id, ${IDENTITY_COLUMNS} FROM characters c
        WHERE c.proof_user_id IN (SELECT value FROM json_each(?)) AND c.owner_proof = 'bnet' AND ${HAS_IDENTITY} AND c.guild_id = ? LIMIT ?`,
    ).bind(list, guildId, MAX_VALUES * userIds.length),
  ];
}
export function personKeysStatements(db, playerIds, guildId) {
  const list = JSON.stringify(playerIds);
  return [
    db.prepare('SELECT id, discord_user_id AS discordId FROM players WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?))').bind(guildId, list),
    db.prepare(`SELECT DISTINCT c.player_id AS id, ${IDENTITY_COLUMNS} FROM characters c WHERE c.guild_id = ? AND c.player_id IN (SELECT value FROM json_each(?)) AND ${HAS_IDENTITY} LIMIT ?`).bind(guildId, list, MAX_VALUES * playerIds.length),
  ];
}
// [heads, identity rows] -> Map<id, keys> (the shape accountKeys / personKeys return)
export function keysOfMany([heads, identities]) {
  const out = new Map();
  for (const row of heads.results) out.set(row.id, { discordId: row.discordId || null, bnetAccountId: row.bnetAccountId || null, identityKeys: [] });
  for (const row of identities.results) {
    const keys = out.get(row.id);
    if (keys && keys.identityKeys.length < MAX_VALUES) keys.identityKeys.push({ namespace: row.namespace, realmId: row.realmId, charId: row.charId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing and deleting

// Plans the tombstones of a block. -> { missing, version, hmacs: [base64url], kinds: [bnet|discord|idkey], problems }.
// missing: there ARE keys to tombstone but no usable TOMBSTONE_KEY (the caller flags the block tombstone_missing = 1 and logs the operator line).
export async function planTombstones(env, guildId, keys) {
  const values = typedValuesOf(keys);
  if (!values.length) return { missing: false, version: null, hmacs: [], kinds: [], problems: [] };
  const ring = readKeyring(env);
  if (!ring.current) return { missing: true, version: null, hmacs: [], kinds: [], problems: ring.problems };
  const key = await importKey(ring.current.secret);
  const hmacs = [];
  for (const value of values) hmacs.push(await hmacWith(key, guildId, value));
  return { missing: false, version: ring.current.version, hmacs, kinds: values.map(kindOfValue), problems: [] };
}

// Every HMAC the given keys have in the guild under EVERY key version of the keyring (the current secret and the retired ones): what the GM claim deletes, since a tombstone
// keeps the version it was written with. [] when there is no key at all (nothing could have been written that this Worker can match). Same derivation as planTombstones.
export async function tombstoneHmacsAllVersions(env, guildId, keys) {
  const values = typedValuesOf(keys);
  const ring = readKeyring(env);
  if (!values.length || !ring.keys.size) return [];
  const out = new Set();
  for (const secret of ring.keys.values()) {
    const key = await importKey(secret);
    for (const value of values) out.add(await hmacWith(key, guildId, value));
  }
  return [...out];
}

export const MISSING_KEY_LINE ='block: TOMBSTONE_KEY is not set or not valid, so this block was written WITHOUT tombstones (flagged tombstone_missing); set the Worker secret and the daily repair will add them';

// One statement inserting a plan's tombstones under a block_ref, only while `guard` ({ sql, params }) holds (the block row this call wrote is there). [] when nothing to write.
export function tombstoneInsertStatements(db, { guildId, blockRef, plan, now, guard }) {
  if (!plan.hmacs.length) return [];
  return [db.prepare(
    `INSERT OR IGNORE INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at)
     SELECT ?, ?, ?, value, ? FROM json_each(?) WHERE ${guard.sql}`,
  ).bind(guildId, blockRef, plan.version, now, JSON.stringify(plan.hmacs), ...guard.params)];
}

// Deletes every tombstone of the given block refs of the guild, only while `guard` holds.
export function tombstoneDeleteStatement(db, { guildId, blockRefs, guard }) {
  return db.prepare(
    `DELETE FROM block_tombstones WHERE guild_id = ? AND block_ref IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
  ).bind(guildId, JSON.stringify(blockRefs), ...guard.params);
}

// The refs whose tombstones the given keys hit (in every key version the guild's rows use): an unblock deletes these as well as its own ref, so lifting a
// block really lifts it (a pending-review block, or a block moved to another ref by a person join, would otherwise match again at the next sign-in).
export async function matchedRefsOf(db, env, guildId, keys) {
  const { hits } = await findHits(db, env, guildId, keys);
  return hits ? [...new Set(hits.rows.map((row) => row.block_ref))] : [];
}

// Which of the matched refs an unblock may lift: the Owner any; everyone else the refs of a block made by someone of EQUAL or lower rank than theirs (the actor_role
// snapshot of the audit row that wrote it, blockerRanksOf: an Officer lifts an Officer's memory, a Team Lead or a Member never a senior's), and the refs of a block the
// actor made THEMSELVES, whatever rank the snapshot says (a Guild Master who was demoted lifts their own). A ref the actor may not lift keeps its tombstones - the block
// it belongs to is the senior one's to lift - so an Officer lifting a pending match cannot wipe the memory of a Guild Master's block.
// -> { lift (by rank), byBlocker (made by the actor, not liftable by rank), kept, minBlockerRank } (minBlockerRank: the guard value of liftGuard, over `lift`).
export async function splitLiftableRefs(db, guildId, refs, { owner, rank, actorId = null }) {
  if (!refs.length) return { lift: [], byBlocker: [], kept: [], minBlockerRank: null };
  if (owner) return { lift: [...refs], byBlocker: [], kept: [], minBlockerRank: null };
  const { ranks, blockers } = await blockerRanksOf(db, guildId, refs);
  const lift = refs.filter((ref) => rank <= ranks.get(ref));
  const byBlocker = refs.filter((ref) => !lift.includes(ref) && actorId && blockers.get(ref) === actorId);
  return {
    lift,
    byBlocker,
    kept: refs.filter((ref) => !lift.includes(ref) && !byBlocker.includes(ref)),
    minBlockerRank: lift.length ? Math.min(...lift.map((ref) => ranks.get(ref))) : null,
  };
}

// The same test inside the batch: the actor is (still) the Owner or ranks equal to or above the most senior block among the refs being lifted. (A null
// minBlockerRank is -1, a rank nobody has: the Owner path of the read stays the Owner's.)
export function liftGuard(guildId, actorId, minBlockerRank) {
  const owner = ownerGuard(guildId, actorId);
  return {
    sql: `(${owner.sql} OR COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ? AND ra.user_id = ?), 3) <= ?)`,
    params: [...owner.params, guildId, actorId, minBlockerRank === null || minBlockerRank === undefined ? -1 : minBlockerRank],
  };
}

// The same test for the refs of blocks the actor made: every one of them has an audit row (access.remove for 'u:', person.block for 'p:') written by the actor.
export function madeByGuard(guildId, actorId, refs) {
  return {
    sql: `(SELECT COUNT(*) FROM json_each(?) mr WHERE EXISTS (SELECT 1 FROM audit_log al WHERE al.guild_id = ? AND al.actor_user_id = ?
            AND al.action = CASE substr(mr.value, 1, 2) WHEN 'u:' THEN 'access.remove' ELSE 'person.block' END AND al.entity_id = substr(mr.value, 3))) = ?`,
    params: [JSON.stringify(refs), guildId, actorId, refs.length],
  };
}

const andGuards = (...guards) => ({ sql: guards.map((entry) => `(${entry.sql})`).join(' AND '), params: guards.flatMap((entry) => entry.params) });

// The DELETEs of the matched refs an unblock lifts (0 to 2 statements for the unblock's batch): the ones its rank allows and the ones the actor made. `guard`
// ({ sql, params }) is the unblock's own guard.
export function liftTombstoneStatements(db, { guildId, actorId, split, guard }) {
  const out = [];
  if (split.lift.length) out.push(tombstoneDeleteStatement(db, { guildId, blockRefs: split.lift, guard: andGuards(guard, liftGuard(guildId, actorId, split.minBlockerRank)) }));
  if (split.byBlocker.length) out.push(tombstoneDeleteStatement(db, { guildId, blockRefs: split.byBlocker, guard: andGuards(guard, madeByGuard(guildId, actorId, split.byBlocker)) }));
  return out;
}

// ---------------------------------------------------------------------------
// The match

// -> { hits: { rows: [{ block_ref, hmac }], kindOf: Map<hmac, kind> } | null, reads } (null: no keys / no tombstones / no key; reads: the D1 statements it ran, for a
// caller with a statement budget). `log` gets at most one operator line.
async function findHits(db, env, guildId, keys, log = null) {
  const values = typedValuesOf(keys);
  if (!values.length) return { hits: null, reads: 0 };
  const versionResult = await db.prepare('SELECT DISTINCT key_version FROM block_tombstones WHERE guild_id = ?').bind(guildId).all();
  const versions = versionResult.results.map((row) => row.key_version);
  if (!versions.length) return { hits: null, reads: 1 };
  const ring = readKeyring(env);
  const kindOf = new Map();
  for (const version of versions) {
    const secret = ring.keys.get(version);
    if (!secret) {
      if (log) log(`tombstone match: the guild has tombstones of key version ${version} and no TOMBSTONE_KEY / TOMBSTONE_OLD_KEYS entry for it, so they cannot be matched`);
      continue;
    }
    const key = await importKey(secret);
    for (const value of values) kindOf.set(await hmacWith(key, guildId, value), kindOfValue(value));
  }
  if (!kindOf.size) return { hits: null, reads: 1 };
  const found = await db.prepare(
    'SELECT DISTINCT block_ref, hmac FROM block_tombstones WHERE guild_id = ? AND hmac IN (SELECT value FROM json_each(?)) LIMIT 50',
  ).bind(guildId, JSON.stringify([...kindOf.keys()])).all();
  return { hits: { rows: found.results, kindOf }, reads: 2 };
}

// matchedRefsOf for many targets with ONE read of the key versions and ONE read of the hits (an unblock of many names): keysByTarget is a Map<target id, keys>. -> { refs: Map<target id,
// [block_ref]> (a target's own ref is NOT removed here: the caller drops it), reads }. At most 50 hits per target.
export async function matchedRefsOfMany(db, env, guildId, keysByTarget) {
  const wanted = new Map(); // target -> typed values
  for (const [target, keys] of keysByTarget) {
    const values = typedValuesOf(keys);
    if (values.length) wanted.set(target, values);
  }
  const refs = new Map([...keysByTarget.keys()].map((target) => [target, []]));
  if (!wanted.size) return { refs, reads: 0 };
  const versionResult = await db.prepare('SELECT DISTINCT key_version FROM block_tombstones WHERE guild_id = ?').bind(guildId).all();
  const versions = versionResult.results.map((row) => row.key_version);
  if (!versions.length) return { refs, reads: 1 };
  const ring = readKeyring(env);
  const targetsOf = new Map(); // hmac -> Set<target>
  for (const version of versions) {
    const secret = ring.keys.get(version);
    if (!secret) continue;
    const key = await importKey(secret);
    for (const [target, values] of wanted) {
      for (const value of values) {
        const hmac = await hmacWith(key, guildId, value);
        if (!targetsOf.has(hmac)) targetsOf.set(hmac, new Set());
        targetsOf.get(hmac).add(target);
      }
    }
  }
  if (!targetsOf.size) return { refs, reads: 1 };
  const found = await db.prepare(
    'SELECT DISTINCT block_ref, hmac FROM block_tombstones WHERE guild_id = ? AND hmac IN (SELECT value FROM json_each(?)) LIMIT ?',
  ).bind(guildId, JSON.stringify([...targetsOf.keys()]), 50 * wanted.size).all();
  for (const row of found.results) {
    for (const target of targetsOf.get(row.hmac) || []) {
      const list = refs.get(target);
      if (!list.includes(row.block_ref)) list.push(row.block_ref);
    }
  }
  return { refs, reads: 2 };
}

// Ranks, lower is more senior: what an audit row's actor_role snapshot means.
const SNAPSHOT_RANK = { owner: 0, guild_master: 0, officer: 1, team_lead: 2, member: 3 };
const DEFAULT_BLOCKER_RANK = SNAPSHOT_RANK.officer; // a block with no readable snapshot (made before the snapshot existed) counts as an Officer's
const HELD_REPEAT_MS = 24 * 60 * 60 * 1000;
export const MATCH_REASON = 'Matched an earlier block of the same person';
// The audit action that wrote the block a ref belongs to ('u:' = an account block, 'p:' = an account-less person's).
const BLOCK_ACTION = { 'u:': 'access.remove', 'p:': 'person.block' };

// The rank of the officer who made each block, from the audit row that wrote it (the snapshot survives the blocker's own account deletion), and who that was
// (actor_user_id, null once the account is gone). ONE statement for all the refs, however many:
// -> { ranks: Map<ref, rank>, blockers: Map<ref, user id | null>, reads } (reads 0 when no ref names a block kind).
export async function blockerRanksOf(db, guildId, refs) {
  const ranks = new Map(refs.map((ref) => [ref, DEFAULT_BLOCKER_RANK]));
  const blockers = new Map(refs.map((ref) => [ref, null]));
  const wanted = refs.filter((ref) => BLOCK_ACTION[ref.slice(0, 2)]);
  if (!wanted.length) return { ranks, blockers, reads: 0 };
  const found = await db.prepare(
    `SELECT action, entity_id, actor_role, actor_user_id FROM audit_log
      WHERE guild_id = ? AND action IN ('access.remove', 'person.block') AND entity_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT 500`,
  ).bind(guildId, JSON.stringify(wanted.map((ref) => ref.slice(2)))).all();
  const settled = new Set();
  for (const row of found.results) {
    const ref = `${row.action === 'access.remove' ? 'u:' : 'p:'}${row.entity_id}`;
    if (!ranks.has(ref) || settled.has(ref)) continue; // the newest row of a ref decides
    settled.add(ref);
    blockers.set(ref, row.actor_user_id || null);
    if (Object.prototype.hasOwnProperty.call(SNAPSHOT_RANK, row.actor_role)) ranks.set(ref, SNAPSHOT_RANK[row.actor_role]);
  }
  return { ranks, blockers, reads: 1 };
}

const RANK_OF_ROLE_SQL = `CASE m.role_id WHEN 'guild_master' THEN 0 WHEN 'officer' THEN 1 WHEN 'team_lead' THEN 2 ELSE 3 END`;

// The rank an account would have in the guild (A9-05): the roles the account effectively holds (effective_roles: stored, derived from the in-game rank, the Owner's row) + the
// rank-map rank of its identity keys on the stored roster ('ingame' guilds). -> { owner, rank, reads } with rank 0..3, 3 = Member.
export async function prospectiveRankOf(db, guildId, userId, identityKeys) {
  const account = await db.prepare(
    `SELECT ${ownerSql('?1', '?2')} AS owner,
            COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id
                       WHERE ra.guild_id = ?1 AND ra.user_id = ?2 AND ra.role_id IN ('guild_master', 'officer', 'team_lead')), 3) AS handRank,
            (SELECT rank_source FROM guilds WHERE id = ?1) AS source`,
  ).bind(guildId, userId).first();
  let rank = account.handRank;
  let reads = 1;
  const identities = typedValuesOf({ identityKeys }).map((value) => value.split(':')).map(([, namespace, realm, char]) => ({ ns: namespace, realm: Number(realm), char: Number(char) }));
  if (account.source === 'ingame' && identities.length) {
    const mapped = await db.prepare(
      `SELECT MIN(${RANK_OF_ROLE_SQL}) AS rank
         FROM json_each(?2) k
         JOIN guild_roster gr ON gr.guild_id = ?1 AND gr.namespace = json_extract(k.value, '$.ns')
                             AND gr.blizzard_realm_id = json_extract(k.value, '$.realm') AND gr.blizzard_char_id = json_extract(k.value, '$.char')
         JOIN source_rank_maps m ON m.guild_id = gr.guild_id AND m.source = 'ingame' AND m.source_key = CAST(gr.rank AS TEXT) AND m.team_id IS NULL`,
    ).bind(guildId, JSON.stringify(identities)).first();
    reads++;
    if (mapped && mapped.rank !== null && mapped.rank < rank) rank = mapped.rank;
  }
  return { owner: account.owner === 1, rank, reads };
}

// The most D1 statements planTombstoneMatch can run for ONE guild: the version list, the hits, the account's block, its rank (2) and the blockers' ranks = 6 reads,
// and up to 2 statements for the caller's batch (the block and its audit row). A caller with a statement budget reserves this before it calls.
export const TOMBSTONE_MATCH_READS = 6;
export const TOMBSTONE_MATCH_STATEMENTS = TOMBSTONE_MATCH_READS + 2;

// The plan of a tombstone match for ONE guild: the statements to run in a batch by the caller (sign-in / link / Battle.net proof) and how many D1 reads it took to
// decide. Nothing is written here.
//   db, { guildId, userId (the matched account), keys (see typedValuesOf), env (the Worker env: the key source), now, randomBytes, log,
//         personBlocks: [player id] }  -> Promise<{ statements, reads }>
//   personBlocks: persons of the guild that hold a person_blocks row and that the account's keys matched through the roster (the Battle.net match found a character
//   of such a person for a key of the account). They are a hit like a tombstone's, with the ref 'p:<player id>'.
//   no hit, or the account is already blocked here .................................... []
//   a hit on the Owner or an account that holds a Guild Master role ................... audit 'block.match_held' (reason owner | gm), NO block
//   a hit on an account equal or senior to the officer who made the block (A9-05) ..... audit 'block.match_held' (reason senior), NO block
//   any other hit ..................................................................... a guild_blocks row (pending_review = 1, blocked_by NULL) + audit 'block.match'
// A pending-review block ENFORCES (worker/membership.js treats any guild_blocks row as blocked) and shows in the officers' review queue (attention kind block_review).
export async function planTombstoneMatch(db, { guildId, userId, keys, env, now = Date.now, randomBytes = defaultRandomBytes, log = null, personBlocks = [] }) {
  if (!guildId || !userId) return { statements: [], reads: 0 };
  const { hits, reads: hitReads } = await findHits(db, env, guildId, keys, log);
  let reads = hitReads;
  const tombstoneRows = hits ? hits.rows : [];
  const heldPersons = [...new Set(personBlocks)];
  if (!tombstoneRows.length && !heldPersons.length) return { statements: [], reads };
  const already = await db.prepare('SELECT 1 AS blocked FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guildId, userId).first();
  reads++;
  if (already) return { statements: [], reads };
  // The account's own ref is never a reason (an inconsistent leftover of its own block).
  const own = accountBlockRef(userId);
  const refs = [...new Set([...tombstoneRows.map((row) => row.block_ref), ...heldPersons.map(personBlockRef)].filter((ref) => ref !== own))];
  if (!refs.length) return { statements: [], reads };
  const hitHmacs = [...new Set(tombstoneRows.map((row) => row.hmac))];
  const kinds = [...new Set([...tombstoneRows.map((row) => hits.kindOf.get(row.hmac)), ...(heldPersons.length ? ['person'] : [])])].sort();

  const ctx = { db, now, randomBytes };
  const nowMs = now();
  // The hit is still there: the tombstones it matched, or the person blocks it matched (a block lifted since leaves the batch a no-op).
  const still = [];
  const stillParams = [];
  if (hitHmacs.length) {
    still.push('EXISTS (SELECT 1 FROM block_tombstones WHERE guild_id = ? AND hmac IN (SELECT value FROM json_each(?)))');
    stillParams.push(guildId, JSON.stringify(hitHmacs));
  }
  if (heldPersons.length) {
    still.push('EXISTS (SELECT 1 FROM person_blocks WHERE guild_id = ? AND player_id IN (SELECT value FROM json_each(?)))');
    stillParams.push(guildId, JSON.stringify(heldPersons));
  }
  const stillMatches = { sql: `(${still.join(' OR ')})`, params: stillParams };
  const account = await prospectiveRankOf(db, guildId, userId, keys && keys.identityKeys);
  reads += account.reads;
  const blockers = await blockerRanksOf(db, guildId, refs);
  reads += blockers.reads;
  const blockerRank = Math.min(...blockers.ranks.values());
  const heldReason = account.owner ? 'owner' : account.rank === 0 ? 'gm' : account.rank <= blockerRank ? 'senior' : null;

  if (heldReason) {
    // One review item per account and day, however often it signs in.
    return {
      reads,
      statements: [auditStatement(ctx, {
        guildId, actorUserId: null, action: 'block.match_held', entityType: 'user', entityId: userId, after: { reason: heldReason, refs: refs.length, kinds },
      }, {
        sql: `${stillMatches.sql} AND NOT EXISTS (SELECT 1 FROM audit_log WHERE guild_id = ? AND action = 'block.match_held' AND entity_id = ? AND created_at > ?)`,
        params: [...stillMatches.params, guildId, userId, nowMs - HELD_REPEAT_MS],
      })],
    };
  }
  const notOwner = `NOT ${ownerSql('?', '?')}`;
  return {
    reads,
    statements: [
      db.prepare(
        `INSERT OR IGNORE INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review, tombstone_missing)
         SELECT ?, ?, NULL, ?, ?, 1, 0 WHERE ${stillMatches.sql} AND ${notOwner}`,
      ).bind(guildId, userId, MATCH_REASON, nowMs, ...stillMatches.params, guildId, userId, userId),
      auditStatement(ctx, {
        guildId, actorUserId: null, action: 'block.match', entityType: 'user', entityId: userId, after: { refs: refs.length, kinds },
      }, {
        sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND pending_review = 1 AND blocked_by IS NULL AND created_at = ?)',
        params: [guildId, userId, nowMs],
      }),
    ],
  };
}

// The statements alone (the Discord sign-in and link callbacks, tests).
export async function tombstoneMatchStatements(db, options) {
  return (await planTombstoneMatch(db, options)).statements;
}

// ---------------------------------------------------------------------------
// The Discord sign-in and link callbacks (sec A9-11)

const CANDIDATE_GUILDS_SQL = `SELECT DISTINCT c.guild_id AS guild_id FROM (
    SELECT guild_id FROM players WHERE user_id = ?1
    UNION SELECT guild_id FROM players WHERE ?2 IS NOT NULL AND discord_user_id = ?2
    UNION SELECT g.id FROM user_servers us JOIN guilds g ON g.discord_server_id = us.server_id WHERE us.user_id = ?1
    UNION SELECT guild_id FROM effective_roles WHERE user_id = ?1
  ) c WHERE EXISTS (SELECT 1 FROM block_tombstones t WHERE t.guild_id = c.guild_id) LIMIT 25`;

// The guilds that have tombstones and that the account reaches or could reach: through a Discord server with a Raidsmith guild, a person linked to the account
// or carrying its Discord id, or a stored role.
export async function candidateGuildIds(db, userId, discordId) {
  const result = await db.prepare(CANDIDATE_GUILDS_SQL).bind(userId, discordId || null).all();
  return result.results.map((row) => row.guild_id);
}

// The statements of a pass that reads the account's keys (2), lists the guilds (1) and matches ONE guild (the most planTombstoneMatch runs).
export const MATCH_PASS_MIN_STATEMENTS = 3 + TOMBSTONE_MATCH_STATEMENTS;

// Runs the match for an account in every guild with tombstones that it reaches, and batches the result. Never throws: a failure here is logged and the sign-in
// goes on (the next sign-in matches again). ctx: { db, env, now, randomBytes, log }. -> number of guilds that got a statement.
//   options.budget .... the D1 statements the pass may run in all, reads and its one batch counted one by one (the Battle.net callbacks have what the sign-in match left
//                       of their 45); a guild that does not fit waits for the next sign-in. Default: no budget (the Discord callbacks).
//   options.skip ...... guild ids the caller has matched already (the Battle.net match does its in-game guilds itself)
//   options.onDeferred  called once when a guild had to wait
export async function matchAccountAtSignIn(ctx, userId, { budget = Infinity, skip = [], onDeferred = null } = {}) {
  try {
    let left = budget;
    if (left < MATCH_PASS_MIN_STATEMENTS) {
      if (onDeferred) onDeferred();
      return 0;
    }
    const keys = await accountKeys(ctx.db, userId);
    left -= 2;
    const skipped = new Set(skip);
    const guildIds = (await candidateGuildIds(ctx.db, userId, keys.discordId)).filter((guildId) => !skipped.has(guildId));
    left -= 1;
    const statements = [];
    let touched = 0;
    for (const guildId of guildIds) {
      if (left < TOMBSTONE_MATCH_STATEMENTS) {
        if (onDeferred) onDeferred();
        break;
      }
      const plan = await planTombstoneMatch(ctx.db, { guildId, userId, keys, env: ctx.env, now: ctx.now, randomBytes: ctx.randomBytes, log: ctx.log });
      left -= plan.reads + plan.statements.length;
      if (plan.statements.length) touched++;
      statements.push(...plan.statements);
    }
    if (statements.length) await ctx.db.batch(statements);
    return touched;
  } catch (error) {
    try { ctx.log(`tombstone match failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Backfill and repair (the daily cron; the R4 backfill of blocks made before this build is this same job)

export const REPAIR_LIMIT = 25;

// Writes the tombstones of blocks that have none (made before this build, or while TOMBSTONE_KEY was unset: tombstone_missing = 1) from the account's CURRENT
// keys, REPAIR_LIMIT blocks a run (account and person blocks together) in random order (so a block with no keys never starves the others). Pending-review blocks are not repaired: an officer decides
// them first. deps: { db, env, now, log } -> { repaired, noKeys } or null when the key is unset (one operator line). Logs counts when it did anything. Never throws.
export async function repairTombstones({ db, env, now, log }) {
  try {
    const ring = readKeyring(env);
    const waiting = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM guild_blocks gb WHERE gb.pending_review = 0 AND (gb.tombstone_missing = 1 OR NOT EXISTS
                (SELECT 1 FROM block_tombstones t WHERE t.guild_id = gb.guild_id AND t.block_ref = 'u:' || gb.user_id)))
            + (SELECT COUNT(*) FROM person_blocks pb WHERE pb.tombstone_missing = 1 OR NOT EXISTS
                (SELECT 1 FROM block_tombstones t WHERE t.guild_id = pb.guild_id AND t.block_ref = 'p:' || pb.player_id)) AS n`,
    ).first();
    if (!waiting || waiting.n === 0) return { repaired: 0, noKeys: 0 };
    if (!ring.current) {
      log(`tombstone repair: TOMBSTONE_KEY is not set or not valid; ${waiting.n} block${waiting.n === 1 ? ' waits' : 's wait'} for tombstones${ring.problems.length ? ` (${ring.problems.join('; ')})` : ''}`);
      return null;
    }
    // REPAIR_LIMIT blocks in all, account blocks and person blocks drawn together: a run is at most 2 + 4 * REPAIR_LIMIT D1 statements (the count, this read, and per
    // block its keys (2) and its batch (2)), where two limits of their own would have made it twice that.
    const due = await db.prepare(
      `SELECT kind, guild_id, id FROM (
         SELECT 'u' AS kind, gb.guild_id AS guild_id, gb.user_id AS id FROM guild_blocks gb
          WHERE gb.pending_review = 0 AND (gb.tombstone_missing = 1 OR NOT EXISTS
                  (SELECT 1 FROM block_tombstones t WHERE t.guild_id = gb.guild_id AND t.block_ref = 'u:' || gb.user_id))
         UNION ALL
         SELECT 'p', pb.guild_id, pb.player_id FROM person_blocks pb
          WHERE pb.tombstone_missing = 1 OR NOT EXISTS (SELECT 1 FROM block_tombstones t WHERE t.guild_id = pb.guild_id AND t.block_ref = 'p:' || pb.player_id))
        ORDER BY RANDOM() LIMIT ?`,
    ).bind(REPAIR_LIMIT).all();
    const nowMs = now();
    let repaired = 0;
    let noKeys = 0;
    const work = due.results.map((row) => (row.kind === 'u'
      ? {
        guildId: row.guild_id, ref: accountBlockRef(row.id), keys: () => accountKeys(db, row.id, row.guild_id),
        exists: { sql: 'EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)', params: [row.guild_id, row.id] },
        clear: db.prepare('UPDATE guild_blocks SET tombstone_missing = 0 WHERE guild_id = ? AND user_id = ? AND tombstone_missing = 1').bind(row.guild_id, row.id),
      }
      : {
        guildId: row.guild_id, ref: personBlockRef(row.id), keys: () => personKeys(db, row.guild_id, row.id),
        exists: { sql: 'EXISTS (SELECT 1 FROM person_blocks WHERE guild_id = ? AND player_id = ?)', params: [row.guild_id, row.id] },
        clear: db.prepare('UPDATE person_blocks SET tombstone_missing = 0 WHERE guild_id = ? AND player_id = ? AND tombstone_missing = 1').bind(row.guild_id, row.id),
      }));
    for (const item of work) {
      const plan = await planTombstones(env, item.guildId, await item.keys());
      if (!plan.hmacs.length) {
        noKeys++;
        await item.clear.run();
        continue;
      }
      await db.batch([...tombstoneInsertStatements(db, { guildId: item.guildId, blockRef: item.ref, plan, now: nowMs, guard: item.exists }), item.clear]);
      repaired++;
    }
    if (repaired) log(`tombstone repair: ${repaired} block${repaired === 1 ? '' : 's'} repaired, ${noKeys} with no keys to tombstone, ${Math.max(0, waiting.n - repaired - noKeys)} still waiting`);
    return { repaired, noKeys };
  } catch (error) {
    try { log(`tombstone repair failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}
