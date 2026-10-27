// The Seniority guard (user-hierarchy build, lane B3; U round 8, arch A9-18). A junior can never delete, move, release, relink or rename a senior's person
// or characters. One helper, two forms of the same SQL: assertSenior() reads the answer for a clean 403 before the write, and seniorityOk() / seniorityDeleteOk()
// are the fragments every guarded write repeats INSIDE its batch (so an actor demoted, or a target promoted, between the read and the write changes nothing).
//
//   target account   the account of the person (ONE definition: players.user_id, else the user whose discord_id equals players.discord_user_id)
//   rank             lower is more senior: Guild Master 0, Officer 1, Team Lead 2, Member 3 (a custom role ranks as Member; an account holding nothing is a Member)
//   Owner            guilds.owner_user_id = the account; while owner_user_id IS NULL (every guild before the flip) the holder of the stored guild_master row
//   the actor passes when the person has no account, is the actor's own, or the actor is the Owner, or the target is NOT the Owner and the actor is strictly
//   senior or GM-tier (rank 0). Equal rank is refused: there is no Officer exemption. The Owner's person is changed only by the Owner (or by the sync).
//   Deleting a Battle.net-proven character (owner_proof 'bnet'), or a person holding one, is GM-tier / Owner only: leaving the guild is the sync's job.
//
// B6b (the effective-roles view) changes only where RANK_SQL and OWNER_SQL read from; the interface (seniorityOk, seniorityDeleteOk, assertSenior) stays.
import { HttpError } from './http.js';
import { ROLE_RANK } from './permissions.js';

// The account of a person, as a scalar subquery on the bound person id and guild id (two placeholders: person, guild).
const ACCOUNT_OF_PERSON_SQL = `SELECT COALESCE(tp.user_id, (SELECT du.id FROM users du WHERE du.discord_id = tp.discord_user_id)) FROM players tp WHERE tp.id = ? AND tp.guild_id = ?`;

// The three expressions below take a COLUMN of the derived row s (s.gid, s.aid, s.tid), never a bare `?`.
const RANK_SQL = (user) => `COALESCE((SELECT MIN(r.rank) FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.guild_id = s.gid AND ra.user_id = ${user}), ${ROLE_RANK.member})`;
const OWNER_SQL = (user) => `EXISTS (SELECT 1 FROM guilds og WHERE og.id = s.gid AND (og.owner_user_id = ${user}
    OR (og.owner_user_id IS NULL AND EXISTS (SELECT 1 FROM role_assignments gm WHERE gm.guild_id = og.id AND gm.user_id = ${user} AND gm.role_id = 'guild_master'))))`;
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

export const SENIORITY_MESSAGE = 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.';
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
