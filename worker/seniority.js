// The Seniority guard (user-hierarchy build, lane B3; U round 8, arch A9-18). A junior can never delete, move, release, relink or rename a senior's person
// or characters. One helper, two forms of the same SQL: assertSenior() reads the answer for a clean 403 before the write, and seniorityOk() / seniorityDeleteOk()
// are the fragments every guarded write repeats INSIDE its batch (so an actor demoted, or a target promoted, between the read and the write changes nothing).
//
//   target account   the account of the person (ONE definition: players.user_id, else the user whose discord_id equals players.discord_user_id)
//   rank             lower is more senior: Guild Master 0, Officer 1, Team Lead 2, Member 3 (a custom role ranks as Member; an account holding nothing is a Member). Read from
//                    the EFFECTIVE ROLES view (effective_roles, migration 0035): stored roles + the roles derived from the in-game rank + the Owner's own row, so a derived
//                    Officer outranks a Member and a suspended Owner (who keeps only the seat) ranks by their own derived roles
//   Owner            the Owner of worker/owner.js: the seat holder who is not suspended; while owner_user_id IS NULL and rank_source IS NULL (every guild before the flip)
//                    the holder of the stored guild_master row
//   the actor passes when the person has no account, is the actor's own, or the actor is the Owner, or the target is NOT the Owner and the actor is strictly
//   senior or GM-tier (rank 0). Equal rank is refused: there is no Officer exemption. The Owner's person is changed only by the Owner (or by the sync).
//   Deleting a Battle.net-proven character (owner_proof 'bnet'), or a person holding one, is GM-tier / Owner only: leaving the guild is the sync's job.
//
// Lane B6b moved RANK_SQL and OWNER_SQL onto the effective-roles view (arch A9-18); the interface (seniorityOk, seniorityDeleteOk, assertSenior) is unchanged.
import { HttpError } from './http.js';
import { ownerSql } from './owner.js';
import { ROLE_RANK } from './permissions.js';

// The account of a person, as a scalar subquery on the bound person id and guild id (two placeholders: person, guild).
const ACCOUNT_OF_PERSON_SQL = `SELECT COALESCE(tp.user_id, (SELECT du.id FROM users du WHERE du.discord_id = tp.discord_user_id)) FROM players tp WHERE tp.id = ? AND tp.guild_id = ?`;

// The three expressions below take a COLUMN of the derived row s (s.gid, s.aid, s.tid), never a bare `?`.
const RANK_SQL = (user) => `COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = s.gid AND ra.user_id = ${user}), ${ROLE_RANK.member})`;
const OWNER_SQL = (user) => ownerSql('s.gid', user); // the ONE Owner test (worker/owner.js, the owner row of the effective-roles view)
const GM_TIER_SQL = (user) => `(${OWNER_SQL(user)} OR ${RANK_SQL(user)} = ${ROLE_RANK.guild_master})`;

const MAY_ACT_SQL = `s.tid IS NULL OR s.tid = s.aid OR ${OWNER_SQL('s.aid')}
    OR (NOT ${OWNER_SQL('s.tid')} AND (${RANK_SQL('s.aid')} < ${RANK_SQL('s.tid')} OR ${RANK_SQL('s.aid')} = ${ROLE_RANK.guild_master}))`;

const FROM_SQL = `FROM (SELECT ? AS gid, ? AS aid, (${ACCOUNT_OF_PERSON_SQL}) AS tid) s`;
const bindsOf = (guildId, actorId, personId) => [guildId, actorId, personId, guildId];

// { sql, params }: true while the actor may change this person (or any of their characters).
export function seniorityOk(guildId, actorId, personId) {
  return { sql: `EXISTS (SELECT 1 ${FROM_SQL} WHERE ${MAY_ACT_SQL})`, params: bindsOf(guildId, actorId, personId) };
}

// The same for a DELETE: also true only for a GM-tier actor when the person (characterId null) or that one character is Battle.net-proven.
const PROVEN_SQL = `EXISTS (SELECT 1 FROM characters pc WHERE pc.player_id = ? AND pc.guild_id = s.gid AND pc.owner_proof = 'bnet' AND (? IS NULL OR pc.id = ?))`;
export function seniorityDeleteOk(guildId, actorId, personId, characterId = null) {
  return {
    sql: `EXISTS (SELECT 1 ${FROM_SQL} WHERE (${MAY_ACT_SQL}) AND (NOT ${PROVEN_SQL} OR ${GM_TIER_SQL('s.aid')}))`,
    params: [...bindsOf(guildId, actorId, personId), personId, characterId, characterId],
  };
}

// { sql, params }: true while a person block may be carried onto this ACCOUNT by this actor (the officer join: the block follows the person onto the account of the
// person it is joined into). The actor must be the Owner or strictly senior to the account, and the account must be neither the Owner nor GM-tier: a block never lands
// on an account that is not the actor's to block. Plain `?` placeholders only.
export function blockCarryOk(guildId, actorId, accountId) {
  const rank = (user) => `COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ? AND ra.user_id = ${user}), ${ROLE_RANK.member})`;
  return {
    sql: `(NOT ${ownerSql('?', '?')} AND ${rank('?')} > ${ROLE_RANK.guild_master} AND (${ownerSql('?', '?')} OR ${rank('?')} < ${rank('?')}))`,
    params: [guildId, accountId, accountId, guildId, accountId, guildId, actorId, actorId, guildId, actorId, guildId, accountId],
  };
}

// The role rank (0 Guild Master .. 3 Member) the guild's rank map gives the in-game rank of a roster row; 3 for a rank with no map row or no elevated role. Plain `?`
// placeholders: guild, namespace, realm id, character id.
const ROSTER_ROW_ROLE_RANK_SQL = `COALESCE((SELECT CASE m.role_id WHEN 'guild_master' THEN 0 WHEN 'officer' THEN 1 WHEN 'team_lead' THEN 2 ELSE 3 END
    FROM guild_roster rr JOIN source_rank_maps m ON m.guild_id = rr.guild_id AND m.source = 'ingame' AND m.team_id IS NULL AND m.source_key = CAST(rr.rank AS TEXT)
   WHERE rr.guild_id = ? AND rr.namespace = ? AND rr.blizzard_realm_id = ? AND rr.blizzard_char_id = ?), ${ROLE_RANK.member})`;

// { sql, params }: true while the actor may give a character the identity key of this roster row (Match to roster). A row whose in-game rank maps to an elevated role
// (Guild Master, Officer, Team Lead) puts whoever owns that character at that rank once an account is linked, so it is the Owner's or a strictly more senior actor's;
// every other row stays open to whoever may edit the character.
export function rosterRowOk(guildId, actorId, key) {
  const row = [guildId, key.namespace, key.realmId, key.charId];
  const actorRank = `COALESCE((SELECT MIN(r.rank) FROM effective_roles ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = ? AND ra.user_id = ?), ${ROLE_RANK.member})`;
  return {
    sql: `(${ROSTER_ROW_ROLE_RANK_SQL} >= ${ROLE_RANK.member} OR ${ownerSql('?', '?')} OR ${actorRank} < ${ROSTER_ROW_ROLE_RANK_SQL})`,
    params: [...row, guildId, actorId, actorId, guildId, actorId, ...row],
  };
}

export const SENIORITY_MESSAGE = 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.';
export const ROSTER_ROW_MESSAGE = 'That place on the in-game roster holds a rank above yours, so only someone more senior can give a character its key.';
export const PROVEN_MESSAGE = 'That character is proven by Battle.net: only the Guild Master can remove it. It leaves the roster when it leaves the guild.';

// Throws 403 `seniority` when the actor may not touch the person. `remove`: null for a change, 'person' for deleting the person, a character id for removing it.
export async function assertSenior(db, guildContext, personId, { remove = null } = {}) {
  const guildId = guildContext.guild.id;
  // The rank the write itself will see is the stored one; a dev View-as stand-in changes what the actor may do, never whom they outrank.
  const actorId = guildContext.userId;
  const guard = remove === null ? seniorityOk(guildId, actorId, personId) : seniorityDeleteOk(guildId, actorId, personId, remove === 'person' ? null : remove);
  const plain = remove === null ? null : seniorityOk(guildId, actorId, personId);
  const sql = `SELECT ${guard.sql} AS ok${plain ? `, ${plain.sql} AS plain` : ''}`;
  const row = await db.prepare(sql).bind(...guard.params, ...(plain ? plain.params : [])).first();
  if (row.ok === 1) return;
  if (plain && row.plain === 1) throw new HttpError(403, 'seniority', PROVEN_MESSAGE);
  throw new HttpError(403, 'seniority', SENIORITY_MESSAGE);
}

// assertSenior for several persons in ONE statement (a route that touches two persons, the join): the same answer as one assertSenior per person, one D1 read.
export async function assertSeniorAll(db, guildContext, personIds) {
  const guildId = guildContext.guild.id;
  const guards = personIds.map((personId) => seniorityOk(guildId, guildContext.userId, personId));
  const row = await db.prepare(`SELECT ${guards.map((guard, index) => `${guard.sql} AS ok${index}`).join(', ')}`).bind(...guards.flatMap((guard) => guard.params)).first();
  if (guards.some((_, index) => row[`ok${index}`] !== 1)) throw new HttpError(403, 'seniority', SENIORITY_MESSAGE);
}

// Throws 403 `seniority` when the actor may not give a character the key of this roster row (rosterRowOk).
export async function assertMayMatchRow(db, guildContext, key) {
  const guard = rosterRowOk(guildContext.guild.id, guildContext.userId, key);
  const row = await db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first();
  if (!row || row.ok !== 1) throw new HttpError(403, 'seniority', ROSTER_ROW_MESSAGE);
}
