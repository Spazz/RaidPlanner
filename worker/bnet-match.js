// The Battle.net sign-in match (user-hierarchy build, lane B6a part 2a; plan "Sign-in match", "Proof", "Who gets character rows per rank_source").
// What Battle.net proves is which characters an account owns. After every successful Battle.net callback (sign-in of an existing or a new account, and a link or
// re-link of the same Battle.net account) the callback hands its fresh snapshot to runBnetMatch, in the SAME request, after its own writes: a match that fails
// never fails the sign-in.
//
//   'ingame' guild (a guild where a snapshot character is a guild_roster row, found through guild_roster_identity)
//       the account's person = players.user_id = the account. With none:
//         exactly one UNOWNED person (no user_id; discord_user_id NULL or the account's own) holds a matched key ... the account is linked to that person
//         otherwise ........................ a person is created: its Main is the matched character with the best roster rank (lowest rank), joined_on = today
//                                            in the guild's time zone. (Deviation, see the contract: when two or more unowned persons hold matched keys and
//                                            no matched character is free, the one holding the best-ranked key is linked and the others join on later sign-ins.)
//       per matched key:  held by the account's person .. the proof is stamped
//                         held by another UNOWNED person .. joined into the account's person (reason 'bnet'), AT MOST ONE join per callback
//                         held by a person of ANOTHER account .. nothing (part 2b builds "Battle.net beats a link"); log `bnet match deferred: rehome`
//                         held by nobody, but a character with the same name + realm exists .. nothing (part 2b); log `bnet match deferred: collision`
//                         held by nobody, no such character .. a character is created under the account's person (name and class from the roster row, any level,
//                                            core_rank by newCoreRankSql, team NULL, owner_proof 'bnet')
//       Characters that are NOT on the roster get no rows (R4-Q5: they live only in the snapshot). A blocked account gets nothing in the guild.
//   legacy (rank_source NULL) and 'manual' guild
//       never a person, never a character, never players.user_id. Only where the account already has a linked person: a character of that person that holds a
//       snapshot key is re-stamped; one with no key whose name + realm match a snapshot character of the guild's own namespace takes the key and the proof.
//
// PROOF: owner_proof 'bnet', proof_user_id = the account, proof_bnet_account_id, proof_at = the snapshot's fetchedAt (the attested time, not the match time).
// MONOTONIC GUARD: a different Battle.net account overwrites a proof only when its proof_at is newer (`proof_bnet_account_id IS NULL OR = ? OR proof_at IS NULL OR
// proof_at < ?`); the same account may always rewrite. A superseded proof writes a `character.proof_supersede` audit row in the same batch, in front of the UPDATE
// that overwrites it and with the same conditions, so the row exists exactly when the proof changed hands.
//
// SET-BASED: every statement is one INSERT / UPDATE over json_each of the keyed snapshot characters, never one statement per character.
// BATCHES: reads (2 statements, one batch) -> one write batch per 'ingame' guild -> one for the legacy / manual stamping -> at most one join batch. A batch that
// fails (a unique violation from a concurrent sign-in, a cap trigger) rolls back alone; the sign-in stands and the match is redone at the next one.
// BUDGET: the whole callback stays within CALLBACK_STATEMENT_BUDGET D1 statements (batch members count one by one). The callback tells how many it has used;
// work that does not fit is deferred to the next sign-in (`bnet match deferred: budget`).
import { tombstoneMatchStatements } from './block-tombstones.js';
import { auditStatement } from './audit.js';
import { markPersonRaidsStale, markRaidsStale } from './attendance-store.js';
import { bnetSupport } from './battlenet.js';
import { isUniqueViolation } from './http.js';
import { newId } from './ids.js';
import { LIMITS } from './limits.js';
import { joinPersonsStatements } from './person-join.js';
import { ingameGuard, newCoreRankSql } from './rank-map.js';
import { CLASS_IDS, nameKey, realmKey } from './roster-data.js';
import { guildToday } from './roster-view.js';
import { resolveRealm } from './routes/roster.js';

// D1 statements one Battle.net callback may run in all (a Worker invocation has a subrequest limit; the plan's invocation budget is 45, batch members counted
// one by one). worker/routes/bnet.js passes in what the callback has used before the match; tests/guild/guild-b6a-match-tests.js pins that the totals stay inside.
export const CALLBACK_STATEMENT_BUDGET = 45;
// The cheapest join: 3 reads (the pair, their characters, the counts) + the lean batch of an empty loser (journal, audit, team clear, move, stale marking, survivor,
// delete) + the proof stamping that follows it.
const JOIN_MIN_STATEMENTS = 14;
const CLASS_LIST = `(${CLASS_IDS.map((id) => `'${id}'`).join(', ')})`;
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const and = (...guards) => ({ sql: guards.map((guard) => `(${guard.sql})`).join(' AND '), params: guards.flatMap((guard) => guard.params) });
const keyOf = (namespace, realmId, charId) => `${namespace}|${realmId}|${charId}`;
const positive = (value) => Number.isInteger(value) && value > 0;

// ---------------------------------------------------------------------------
// The snapshot -> the keyed characters

// The snapshot's characters that carry an identity key (namespace + realm id + character id), one entry per key:
// [{ namespace, realmId, charId, name, nameKey, realm, realmKey, fetchedAt }]. A namespace that failed (error) or has no attested time gives none.
export function keyedCharacters(snapshot) {
  const found = new Map();
  for (const [namespace, entry] of Object.entries(snapshot && typeof snapshot === 'object' ? snapshot : {})) {
    if (!entry || entry.error || !Array.isArray(entry.characters) || !Number.isFinite(entry.fetchedAt)) continue;
    for (const character of entry.characters) {
      if (!character || typeof character.name !== 'string' || typeof character.realm !== 'string') continue;
      if (!positive(character.realmId) || !positive(character.characterId)) continue;
      const key = keyOf(namespace, character.realmId, character.characterId);
      if (found.has(key)) continue;
      found.set(key, {
        namespace, realmId: character.realmId, charId: character.characterId, name: character.name, nameKey: nameKey(character.name),
        realm: character.realm, realmKey: realmKey(character.realm), fetchedAt: entry.fetchedAt,
      });
    }
  }
  return [...found.values()];
}

// The profile namespaces of the guilds that run on the in-game roster, as guild-like rows ({ game_version, region }) for the callback's fan-out: a brand-new
// Battle.net account has no member guild, and these are how it becomes a member. One statement (the guilds table is small; the roster tables are not read).
export async function loadIngameCombos(db) {
  const result = await db.prepare(
    "SELECT game_version, region FROM guilds WHERE rank_source = 'ingame' GROUP BY game_version, region ORDER BY game_version, region",
  ).all();
  return result.results;
}

// ---------------------------------------------------------------------------
// Seams

// The block-tombstone match (lane B7a, worker/block-tombstones.js) runs per guild before its batch is built: a hit puts the pending-review block FIRST in
// the batch, so the person create / link (guarded by notBlocked) does nothing.

// ---------------------------------------------------------------------------
// Proof

// (A person's characters are read through characters_player: given only "guild_id = ? AND player_id = ?" the planner walks the whole guild by characters_guild_id.)
// The characters named by the keys list [[namespace, realm id, character id, proof_at], ...]: the same test in every proof statement.
const KEY_HIT = `json_extract(j.value, '$[0]') = characters.namespace AND json_extract(j.value, '$[1]') = characters.blizzard_realm_id
   AND json_extract(j.value, '$[2]') = characters.blizzard_char_id`;

// -> [supersede audit, proof stamp] for a db.batch. scope: { sql, params } selects the characters (written in terms of `characters.`); guard: { sql, params } ANDed
// to both; keys: [[namespace, realm id, character id, proof_at]]. The audit row comes first because it reads the proof the stamp is about to overwrite.
export function proofStatements(db, { scope, guard, actorUserId, bnetAccountId, keys, now }) {
  const keysJson = JSON.stringify(keys);
  return [
    db.prepare(
      `INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at)
       SELECT 'al_' || lower(hex(randomblob(16))), characters.guild_id, ?, 'character.proof_supersede', 'character', characters.id,
              json_object('userId', characters.proof_user_id), json_object('userId', ?), ?
         FROM characters INDEXED BY characters_player
        WHERE ${scope.sql} AND characters.proof_bnet_account_id IS NOT NULL AND characters.proof_bnet_account_id != ?
          AND EXISTS (SELECT 1 FROM json_each(?) j WHERE ${KEY_HIT} AND (characters.proof_at IS NULL OR characters.proof_at < json_extract(j.value, '$[3]')))
          AND ${guard.sql}`,
    ).bind(actorUserId, actorUserId, now, ...scope.params, bnetAccountId, keysJson, ...guard.params),
    db.prepare(
      `UPDATE characters INDEXED BY characters_player SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = ?,
              proof_at = (SELECT json_extract(j.value, '$[3]') FROM json_each(?) j WHERE ${KEY_HIT})
        WHERE ${scope.sql} AND characters.blizzard_char_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(?) j WHERE ${KEY_HIT}
                        AND (characters.proof_bnet_account_id IS NULL OR characters.proof_bnet_account_id = ? OR characters.proof_at IS NULL
                             OR characters.proof_at < json_extract(j.value, '$[3]')))
          AND ${guard.sql}`,
    ).bind(actorUserId, bnetAccountId, keysJson, ...scope.params, keysJson, bnetAccountId, ...guard.params),
  ];
}

// Disconnecting Battle.net (and replacing the link, which is disconnect + link): every proof this account's link gave goes. Written before the DELETE of the
// link in the same batch, with the same condition (the account keeps Discord to sign in with), so a refused disconnect clears nothing.
export function clearBnetProofStatement(db, userId, guard) {
  return db.prepare(
    `UPDATE characters SET owner_proof = NULL, proof_user_id = NULL, proof_bnet_account_id = NULL, proof_at = NULL
      WHERE proof_user_id = ? AND proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = ?) AND ${guard.sql}`,
  ).bind(userId, userId, ...guard.params);
}

// ---------------------------------------------------------------------------
// The reads

// Every snapshot character that is on the roster of a guild running on the in-game roster, with the character that holds the key (if any) and the person of that
// character, and the character with the same name and realm when nobody holds the key. json_each (the snapshot) drives it: each key is one guild_roster_identity
// lookup, then primary-key and unique-index lookups (no scan of guild_roster, characters or players).
const MATCHES_SQL = `SELECT g.id AS guild_id, g.time_zone, g.game_version, g.region, g.realm, g.realm_kind,
       EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = g.id AND b.user_id = ?) AS blocked,
       gr.namespace, gr.blizzard_realm_id AS realm_id, gr.blizzard_char_id AS char_id, gr.name, gr.name_key, gr.class, gr.rank,
       ch.id AS character_id, ch.player_id AS holder_id, hp.user_id AS holder_user, hp.discord_user_id AS holder_discord, hp.version AS holder_version,
       CASE WHEN ch.id IS NOT NULL AND hp.user_id IS NULL THEN (SELECT COUNT(*) FROM characters hc WHERE hc.player_id = hp.id) END AS holder_characters,
       CASE WHEN ch.id IS NOT NULL AND hp.user_id IS NULL THEN EXISTS (SELECT 1 FROM characters hm WHERE hm.player_id = hp.id AND hm.is_main = 1) END AS holder_has_main,
       CASE WHEN ch.id IS NOT NULL AND hp.user_id IS NULL
            THEN (SELECT json_group_object(hq.id, hq.owner_proof) FROM characters hq WHERE hq.player_id = hp.id AND hq.owner_proof IN ('officer', 'hand')) END AS holder_proofs,
       co.id AS collider_id
  FROM json_each(?) j
  CROSS JOIN guild_roster gr ON gr.namespace = json_extract(j.value, '$[0]') AND gr.blizzard_realm_id = json_extract(j.value, '$[1]') AND gr.blizzard_char_id = json_extract(j.value, '$[2]')
  JOIN guilds g ON g.id = gr.guild_id AND g.rank_source = 'ingame'
  LEFT JOIN characters ch ON ch.guild_id = gr.guild_id AND ch.namespace = gr.namespace AND ch.blizzard_realm_id = gr.blizzard_realm_id AND ch.blizzard_char_id = gr.blizzard_char_id
  LEFT JOIN players hp ON hp.id = ch.player_id
  LEFT JOIN characters co ON ch.id IS NULL AND co.guild_id = gr.guild_id AND co.name_key = gr.name_key AND co.realm_key = json_extract(j.value, '$[3]')
 ORDER BY g.id, gr.rank, gr.name_key`;

// The account (its Discord ID) and every person it is linked to, with the guild's source and the person's size.
const ACCOUNT_SQL = `SELECT u.discord_id, p.id AS person_id, p.guild_id, p.version, g.rank_source, g.game_version, g.region, g.realm, g.realm_kind, g.time_zone,
       EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = p.guild_id AND b.user_id = u.id) AS blocked,
       (SELECT COUNT(*) FROM characters c WHERE c.player_id = p.id) AS characters,
       EXISTS (SELECT 1 FROM characters m WHERE m.player_id = p.id AND m.is_main = 1) AS has_main
  FROM users u LEFT JOIN players p ON p.user_id = u.id LEFT JOIN guilds g ON g.id = p.guild_id
 WHERE u.id = ? ORDER BY p.guild_id`;

// ---------------------------------------------------------------------------
// Planning one 'ingame' guild (pure)

// What the key's holder is to this account: mine | other (a person of another account: the Discord ID counts as an owner) | unowned, or for a key nobody holds:
// collision (a character with that name and realm exists) | free.
function kindOf(row, { userId, discordId, personId }) {
  if (!row.character_id) return row.collider_id ? 'collision' : 'free';
  if (row.holder_user === userId || (personId && row.holder_id === personId)) return 'mine';
  if (row.holder_user) return 'other';
  if (row.holder_discord && row.holder_discord !== discordId) return 'other';
  return 'unowned';
}

const byRank = (a, b) => a.rank - b.rank || (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0);

// -> null (nothing to do in this guild) or the plan: { guild, person: { id, kind: 'existing' | 'link' | 'create', ... }, inserts, keys, stamp, joinCandidates, deferred }.
function planGuild(rows, { account, mine, byKey, userId, ids }) {
  const guild = { id: rows[0].guild_id, time_zone: rows[0].time_zone, game_version: rows[0].game_version, region: rows[0].region, realm: rows[0].realm, realm_kind: rows[0].realm_kind };
  if (rows[0].blocked) return null;
  const deferred = new Set();
  const personId = mine ? mine.person_id : null;
  const classified = rows.map((row) => ({ row, kind: kindOf(row, { userId, discordId: account.discord_id, personId }) }));
  if (classified.some((entry) => entry.kind === 'other')) deferred.add('rehome');
  if (classified.some((entry) => entry.kind === 'collision')) deferred.add('collision');

  // The characters nobody holds that can be created: a class Raidsmith knows and a realm the guild accepts.
  const free = [];
  for (const { row, kind } of classified) {
    if (kind !== 'free' || !CLASS_IDS.includes(row.class)) continue;
    const item = byKey.get(keyOf(row.namespace, row.realm_id, row.char_id));
    const realm = item ? resolveRealm(guild, item.realm) : null;
    if (realm) free.push({ row, item, realm });
  }
  free.sort((a, b) => byRank(a.row, b.row));

  // The unowned persons that hold matched keys, best-ranked first.
  const unowned = new Map();
  for (const { row, kind } of classified) {
    if (kind !== 'unowned') continue;
    const entry = unowned.get(row.holder_id) || {
      id: row.holder_id, rank: row.rank, nameKey: row.name_key, version: row.holder_version, characters: row.holder_characters, hasMain: row.holder_has_main === 1, proofs: row.holder_proofs,
    };
    if (byRank(row, { rank: entry.rank, name_key: entry.nameKey }) < 0) { entry.rank = row.rank; entry.nameKey = row.name_key; }
    unowned.set(row.holder_id, entry);
  }
  const unownedList = [...unowned.values()].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));

  let person = null;
  if (mine) {
    person = { id: mine.person_id, kind: 'existing', version: mine.version, characters: mine.characters, hasMain: mine.has_main === 1 };
  } else if (unownedList.length === 1 || (unownedList.length >= 2 && !free.length)) {
    const target = unownedList[0];
    person = { id: target.id, kind: 'link', version: target.version, characters: target.characters, hasMain: target.hasMain, proofs: target.proofs };
  } else if (free.length) {
    person = { id: ids.person(), kind: 'create', version: 1, characters: 0, hasMain: false };
  }
  if (!person) return { guild, person: null, deferred };

  const room = Math.max(0, LIMITS.charactersPerPerson - person.characters);
  if (free.length > room) deferred.add('cap');
  const inserts = free.slice(0, room).map((entry, index) => ({ ...entry, id: ids.character(), isMain: !person.hasMain && index === 0 ? 1 : 0 }));
  const keys = rows.map((row) => [row.namespace, row.realm_id, row.char_id, byKey.get(keyOf(row.namespace, row.realm_id, row.char_id)).fetchedAt]);
  const hasMine = classified.some((entry) => entry.kind === 'mine');
  return {
    guild,
    person,
    inserts,
    keys,
    stamp: hasMine || person.kind === 'link',
    joinCandidates: unownedList.filter((entry) => entry.id !== person.id),
    deferred,
  };
}

// ---------------------------------------------------------------------------
// The statements of one guild

const CREATE_PERSON_SQL = `INSERT INTO players (id, guild_id, status, joined_on, discord_user_id, discord_nickname, user_id, version, notes_version, created_by, created_at, updated_at)
       SELECT ?, ?, 'raider', ?, NULL, NULL, ?, 1, 0, ?, ?, ? WHERE `;
const LINK_PERSON_SQL = `UPDATE players SET user_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND guild_id = ? AND user_id IS NULL AND version = ?
          AND (discord_user_id IS NULL OR discord_user_id = (SELECT discord_id FROM users WHERE id = ?)) AND `;
const RESTORE_PROOFS_SQL = `UPDATE characters INDEXED BY characters_player SET owner_proof = (SELECT j.value FROM json_each(?) j WHERE j.key = characters.id)
        WHERE guild_id = ? AND player_id = ? AND owner_proof IS NULL AND id IN (SELECT key FROM json_each(?)) AND `;
const INSERT_CHARACTERS_SQL = `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at,
                        core_rank, left_on, left_reason, trial_start, trial_end, owner_proof, proof_user_id, proof_bnet_account_id, proof_at,
                        namespace, blizzard_realm_id, blizzard_char_id)
WITH rank_map AS (SELECT CAST(source_key AS INTEGER) AS rank, core_rank FROM source_rank_maps WHERE guild_id = ? AND source = 'ingame' AND team_id IS NULL)
SELECT x.id, x.guild_id, ?, NULL, x.name, x.name_key, x.realm, x.realm_key, x.class, NULL, NULL, x.is_main, ?, ?,
       ${newCoreRankSql('x')}, NULL, NULL, NULL, NULL, 'bnet', ?, ?, x.proof_at, x.namespace, x.blizzard_realm_id, x.blizzard_char_id
  FROM (SELECT json_extract(j.value, '$[0]') AS id, gr.guild_id AS guild_id, gr.namespace AS namespace, gr.blizzard_realm_id AS blizzard_realm_id,
               gr.blizzard_char_id AS blizzard_char_id, gr.name AS name, gr.name_key AS name_key, gr.class AS class,
               json_extract(j.value, '$[1]') AS realm, json_extract(j.value, '$[2]') AS realm_key, json_extract(j.value, '$[3]') AS is_main, json_extract(j.value, '$[4]') AS proof_at
          FROM json_each(?) j
          CROSS JOIN guild_roster gr ON gr.guild_id = ? AND gr.namespace = json_extract(j.value, '$[5]') AND gr.blizzard_realm_id = json_extract(j.value, '$[6]')
                              AND gr.blizzard_char_id = json_extract(j.value, '$[7]')
         WHERE gr.class IN ${CLASS_LIST}
           AND NOT EXISTS (SELECT 1 FROM characters h WHERE h.guild_id = gr.guild_id AND h.namespace = gr.namespace
                                                         AND h.blizzard_realm_id = gr.blizzard_realm_id AND h.blizzard_char_id = gr.blizzard_char_id)) x
 WHERE `;

const personIsMine = (personId, guildId, userId) => ({
  sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND user_id = ?)', params: [personId, guildId, userId],
});
const notBlocked = (guildId, userId) => ({
  sql: 'NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)', params: [guildId, userId],
});
const hasNoPerson = (guildId, userId) => ({
  sql: 'NOT EXISTS (SELECT 1 FROM players WHERE guild_id = ? AND user_id = ?)', params: [guildId, userId],
});

// -> { statements, personAt }: the write batch of one guild. personAt = the position of the statement that makes the account's person (create / link), whose
// meta.changes is 1 when it happened; null for an existing person.
function guildStatements(ctx, plan, { userId, bnetAccountId, now, tombstone }) {
  const { db } = ctx;
  const guildId = plan.guild.id;
  const P = plan.person.id;
  const ingame = ingameGuard(guildId);
  const mine = and(ingame, personIsMine(P, guildId, userId));
  const statements = [...tombstone];
  let personAt = null;

  if (plan.person.kind === 'create') {
    const guard = and(ingame, hasNoPerson(guildId, userId), notBlocked(guildId, userId));
    personAt = statements.length;
    statements.push(db.prepare(CREATE_PERSON_SQL + guard.sql).bind(P, guildId, guildToday(plan.guild, now), userId, userId, now, now, ...guard.params));
    statements.push(auditStatement(ctx, {
      guildId, actorUserId: userId, action: 'person.match_create', entityType: 'person', entityId: P, after: { characters: plan.inserts.length, source: 'bnet' },
    }, CHANGED_ONE));
  } else if (plan.person.kind === 'link') {
    const guard = and(ingame, hasNoPerson(guildId, userId), notBlocked(guildId, userId));
    personAt = statements.length;
    statements.push(db.prepare(LINK_PERSON_SQL + guard.sql).bind(userId, now, P, guildId, plan.person.version, userId, ...guard.params));
    statements.push(auditStatement(ctx, {
      guildId, actorUserId: userId, action: 'person.match_link', entityType: 'person', entityId: P, after: { userId, source: 'bnet' },
    }, CHANGED_ONE));
    // The DB trigger cleared the proofs of the person's characters with the user change: the ones that were typed or linked by an officer get theirs back,
    // then the stamp below puts the Battle.net proof on the matched ones.
    if (plan.person.proofs) {
      statements.push(db.prepare(RESTORE_PROOFS_SQL + mine.sql).bind(plan.person.proofs, guildId, P, plan.person.proofs, ...mine.params));
    }
  }

  if (plan.inserts.length) {
    const items = plan.inserts.map(({ id, realm, row, isMain, item }) => [id, realm.realm, realm.key, isMain, item.fetchedAt, row.namespace, row.realm_id, row.char_id]);
    statements.push(db.prepare(INSERT_CHARACTERS_SQL + mine.sql).bind(guildId, P, now, now, userId, bnetAccountId, JSON.stringify(items), guildId, ...mine.params));
  }
  if (plan.person.kind !== 'existing') statements.push(markPersonRaidsStale(db, guildId, P, mine));
  else if (plan.inserts.length) statements.push(markRaidsStale(db, guildId, plan.inserts.map((entry) => entry.row.name_key), null, [], mine));

  if (plan.stamp) {
    statements.push(...proofStatements(db, {
      scope: { sql: 'characters.guild_id = ? AND characters.player_id = ?', params: [guildId, P] }, guard: mine, actorUserId: userId, bnetAccountId, keys: plan.keys, now,
    }));
  }
  return { statements, personAt };
}

// ---------------------------------------------------------------------------
// Legacy and manual guilds: proof stamping on the account's own linked person, nothing else

const NOT_INGAME = (guildExpr) => `COALESCE((SELECT rank_source FROM guilds WHERE id = ${guildExpr}), '') != 'ingame'`;
// A character of the person with no key whose name + realm are a snapshot character of the guild's own namespace takes the key and the proof; nobody else in the
// guild may hold that key. items: [[guild id, namespace, realm id, character id, name_key, realm_key, proof_at]].
const KEY_STAMP_SQL = `WITH cand AS (
  SELECT c.id AS cid, json_extract(j.value, '$[1]') AS ns, json_extract(j.value, '$[2]') AS rid, json_extract(j.value, '$[3]') AS chid, json_extract(j.value, '$[6]') AS at
    FROM json_each(?) j
    JOIN characters c ON c.guild_id = json_extract(j.value, '$[0]') AND c.name_key = json_extract(j.value, '$[4]') AND c.realm_key = json_extract(j.value, '$[5]')
   WHERE c.blizzard_char_id IS NULL AND c.player_id IN (SELECT id FROM players WHERE guild_id = c.guild_id AND user_id = ?) AND ${NOT_INGAME('c.guild_id')}
     AND NOT EXISTS (SELECT 1 FROM characters o WHERE o.guild_id = c.guild_id AND o.namespace = json_extract(j.value, '$[1]')
                                                   AND o.blizzard_realm_id = json_extract(j.value, '$[2]') AND o.blizzard_char_id = json_extract(j.value, '$[3]')))
UPDATE characters SET namespace = (SELECT ns FROM cand WHERE cid = characters.id), blizzard_realm_id = (SELECT rid FROM cand WHERE cid = characters.id),
       blizzard_char_id = (SELECT chid FROM cand WHERE cid = characters.id), owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = ?,
       proof_at = (SELECT at FROM cand WHERE cid = characters.id)
 WHERE id IN (SELECT cid FROM cand)`;

function legacyStatements(db, persons, items, { userId, bnetAccountId, now }) {
  const guilds = persons.filter((person) => person.rank_source !== 'ingame' && !person.blocked && person.realm_kind !== 'ruleset')
    .map((person) => ({ guildId: person.guild_id, namespace: bnetSupport(person.game_version, person.region).namespace }))
    .filter((guild) => guild.namespace);
  if (!guilds.length) return [];
  const stamps = guilds.flatMap((guild) => items.filter((item) => item.namespace === guild.namespace)
    .map((item) => [guild.guildId, item.namespace, item.realmId, item.charId, item.nameKey, item.realmKey, item.fetchedAt]));
  if (!stamps.length) return [];
  const guildIds = JSON.stringify(guilds.map((guild) => guild.guildId));
  const keys = items.map((item) => [item.namespace, item.realmId, item.charId, item.fetchedAt]);
  const scope = {
    // (The account's persons come first, by players_user: a subquery that mentions the character would only be a filter, and the planner would walk every character.)
    sql: `characters.player_id IN (SELECT id FROM players WHERE user_id = ?) AND characters.guild_id IN (SELECT value FROM json_each(?))
          AND ${NOT_INGAME('characters.guild_id')}`,
    params: [userId, guildIds],
  };
  return [
    ...proofStatements(db, { scope, guard: { sql: '1 = 1', params: [] }, actorUserId: userId, bnetAccountId, keys, now }),
    db.prepare(KEY_STAMP_SQL).bind(JSON.stringify(stamps), userId, userId, bnetAccountId),
  ];
}

// ---------------------------------------------------------------------------
// The match

// Runs a write batch; a failure rolls it back alone. -> the results, or null (logged).
async function writeBatch(ctx, statements) {
  try {
    return await ctx.db.batch(statements);
  } catch (error) {
    // A concurrent sign-in of the same account made the person or the character first (players_guild_user, characters_identity), or a cap trigger fired: the
    // sign-in stands and the next one redoes the match.
    ctx.log(isUniqueViolation(error) ? 'bnet match deferred: race' : `bnet match failed: ${error && error.message}`);
    return null;
  }
}

// ctx: { db, now, randomBytes, log }.   input: { userId, bnetAccountId, snapshot, now, spent }  spent = D1 statements the callback has used so far.
// -> { statements: the total the callback has used, deferred: ['rehome', ...], joined: boolean }
export async function runBnetMatch(ctx, { userId, bnetAccountId, snapshot, now, spent }) {
  const { db } = ctx;
  let used = spent;
  const deferred = new Set();
  const outcome = () => {
    for (const reason of deferred) ctx.log(`bnet match deferred: ${reason}`);
    return { statements: used, deferred: [...deferred], joined };
  };
  let joined = false;
  const items = keyedCharacters(snapshot);
  if (!items.length) return outcome();
  const room = (count) => used + count <= CALLBACK_STATEMENT_BUDGET;
  if (!room(2)) { deferred.add('budget'); return outcome(); }

  const byKey = new Map(items.map((item) => [keyOf(item.namespace, item.realmId, item.charId), item]));
  const [matches, accountRows] = await db.batch([
    db.prepare(MATCHES_SQL).bind(userId, JSON.stringify(items.map((item) => [item.namespace, item.realmId, item.charId, item.realmKey]))),
    db.prepare(ACCOUNT_SQL).bind(userId),
  ]);
  used += 2;
  if (!accountRows.results.length) return outcome();
  const account = accountRows.results[0];
  const persons = accountRows.results.filter((row) => row.person_id);

  // ---- the 'ingame' guilds, one batch each
  const guildRows = new Map();
  for (const row of matches.results) guildRows.set(row.guild_id, [...(guildRows.get(row.guild_id) || []), row]);
  const ids = { person: () => newId('p', ctx.randomBytes), character: () => newId('c', ctx.randomBytes) };
  const ready = [];
  for (const [guildId, rows] of guildRows) {
    const plan = planGuild(rows, { account, mine: persons.find((person) => person.guild_id === guildId), byKey, userId, ids });
    if (!plan) continue;
    for (const reason of plan.deferred) deferred.add(reason);
    if (!plan.person) continue;
    const tombstone = await tombstoneMatchStatements(db, {
      guildId, userId, env: ctx.env, now: ctx.now, randomBytes: ctx.randomBytes, log: ctx.log,
      keys: { bnetAccountId, identityKeys: plan.keys.map((key) => `idkey:${key[0]}:${key[1]}:${key[2]}`) },
    });
    used += tombstone.length ? 6 : 1; // its reads: 1 when the guild has no tombstones, up to 6 on a hit
    const { statements, personAt } = guildStatements(ctx, plan, { userId, bnetAccountId, now, tombstone });
    if (!room(statements.length)) { deferred.add('budget'); continue; }
    used += statements.length;
    const results = await writeBatch(ctx, statements);
    if (!results) continue;
    if (personAt !== null && results[personAt].meta.changes !== 1) continue;
    if (plan.joinCandidates.length) ready.push({ plan, personId: plan.person.id });
  }

  // ---- legacy and manual guilds: only the stamping
  const legacy = legacyStatements(db, persons, items, { userId, bnetAccountId, now });
  if (legacy.length) {
    if (room(legacy.length)) {
      used += legacy.length;
      await writeBatch(ctx, legacy);
    } else {
      deferred.add('budget');
    }
  }

  // ---- at most one join per callback; the rest wait for the next sign-in
  const target = ready[0];
  if (target) {
    const spare = ready.length > 1 || target.plan.joinCandidates.length > 1;
    if (spare) deferred.add('join');
    if (!room(JOIN_MIN_STATEMENTS)) {
      deferred.add('budget');
    } else {
      const guildId = target.plan.guild.id;
      const other = target.plan.joinCandidates[0];
      const stillUnowned = {
        sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND user_id IS NULL AND (discord_user_id IS NULL OR discord_user_id = (SELECT discord_id FROM users WHERE id = ?)))',
        params: [other.id, userId],
      };
      const guard = and(ingameGuard(guildId), personIsMine(target.personId, guildId, userId), stillUnowned);
      let join = null;
      try {
        join = await joinPersonsStatements(db, {
          guildId, aId: target.personId, bId: other.id, actorUserId: userId, now, reason: 'bnet', randomBytes: ctx.randomBytes, guards: [guard], lean: true,
        });
      } catch (error) {
        // The pair cannot be joined (two accounts own them, too many characters together, a person gone): leave it to an officer.
        deferred.add('join');
        ctx.log(`bnet match: join refused: ${error && error.code ? error.code : error && error.message}`);
      }
      used += 3;
      if (join) {
        const stamps = proofStatements(db, {
          scope: { sql: 'characters.guild_id = ? AND characters.player_id = ?', params: [guildId, target.personId] },
          guard: and(ingameGuard(guildId), personIsMine(target.personId, guildId, userId)), actorUserId: userId, bnetAccountId, keys: target.plan.keys, now,
        });
        const statements = [...join.statements, ...stamps];
        if (!room(statements.length)) {
          deferred.add('budget');
        } else {
          used += statements.length;
          const results = await writeBatch(ctx, statements);
          if (results && results[join.appliedIndex].meta.changes === 1) joined = true;
          else if (results) deferred.add('join');
        }
      }
    }
  }
  return outcome();
}
