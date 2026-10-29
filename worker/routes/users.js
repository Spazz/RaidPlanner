// The Users list of a guild and the page of one user (user-hierarchy build, lane B7b part 1; plan "Users API/UI"), and Manage users (part 2). worker/users-list.js has the queries.
//   GET  /api/guild/:gid/users?segment=members|former|nonmembers|blocked&sort=user|main|permission|lastSeen&dir=asc|desc&offset=&limit=&q=&rank=&from=     (+ battlenetOnly, ownerSeat, coreRanks)
//   GET  /api/guild/:gid/users/:ukey     (+ battlenetOnly, ownerSeat)     ukey: u_ account, p_ person, n_ name, r_ in-game roster member that no character carries
//   POST /api/guild/:gid/users/block | /users/unblock     { keys: [ukey, ...], reason? }       worker/users-bulk.js
//   POST /api/guild/:gid/users/add-to-person              { person: ukey, names: [{ key, class? }] }   worker/users-add-to-person.js
// The gate of the reads is the People list's (guild.access or guild.roles), the rate limit is per user and shared by both routes (a read of the whole guild is not free). Manage users
// (the three writes) is guild.access: Officers and up (Add to a person also needs roster.edit for the whole guild, it writes the roster); its own per-user limit counts the writes.
import { HttpError, jsonResponse } from '../http.js';
import { loadGuildContext, requireAction, requireAnyAction } from '../permissions.js';
import { seatHolderSql } from '../owner.js';
import { CORE_RANK_IDS } from '../rank-map.js';
import { USERS_LIMIT, USERS_WINDOW_MS, USERS_WRITE_LIMIT, USERS_WRITE_WINDOW_MS, enforceRateLimit, usersKey, usersWriteKey } from '../ratelimit.js';
import { addToPerson, parseAddBody } from '../users-add-to-person.js';
import { bulkBlock, bulkUnblock, readKeys, readReason } from '../users-bulk.js';
import { listUsers, parseUsersQuery } from '../users-list.js';
import { loadUserDetail } from '../users-detail.js';

async function usersContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAnyAction(guildContext, ['guild.access', 'guild.roles']);
  return guildContext;
}

const limitUsers = (ctx, guildContext) => enforceRateLimit(ctx.db, guildContext.userId, ctx.now(), { key: usersKey(guildContext.userId), limit: USERS_LIMIT, windowMs: USERS_WINDOW_MS });

// Facts of the guild the pages need beside the rows, from ONE statement (the list carries all three, the page of one user the first two):
//   battlenetOnly  the guild's ranks come from the in-game roster, so characters reach an account only through Battle.net and "Add to a person" is refused (409 battlenet_only): the page shows
//                  no such button, and says where a character's rank comes from. The same word the My characters read uses (routes/bnet.js).
//   ownerSeat      the guild has an Owner seat (owner.js seatHolderSql): a hand-over moves the seat and makes nobody an Officer; a guild with no seat (a legacy one) swaps the stored Guild Master
//                  row and the previous one becomes an Officer (routes/people.js makeGuildMaster), which the hand-over dialog says.
//   coreRanks      (list only) the core ranks the rank filter offers, in the order of CORE_RANK_IDS: in an in-game guild the ranks its rank map gives (an unmapped rank is Social); elsewhere
//                  all four. The rank map itself is the Owner's to read (routes/rank-map.js), the Users page is for everyone who holds guild.access.
const GUILD_FACTS_SQL = `SELECT g.rank_source AS rank_source, (${seatHolderSql('g.id')} IS NOT NULL) AS seated,
       (SELECT group_concat(m.core_rank) FROM (SELECT DISTINCT core_rank FROM source_rank_maps WHERE guild_id = g.id AND source = 'ingame' AND team_id IS NULL) m) AS mapped
  FROM guilds g WHERE g.id = ?`;

async function guildFacts(db, guildId) {
  const row = await db.prepare(GUILD_FACTS_SQL).bind(guildId).first();
  const battlenetOnly = !!row && row.rank_source === 'ingame';
  const mapped = new Set(((row && row.mapped) || '').split(',').concat('social'));
  return { battlenetOnly, ownerSeat: !!row && row.seated === 1, coreRanks: CORE_RANK_IDS.filter((id) => !battlenetOnly || mapped.has(id)) };
}

export async function getUsers(ctx) {
  const guildContext = await usersContext(ctx);
  const query = parseUsersQuery(new URL(ctx.request.url).searchParams);
  await limitUsers(ctx, guildContext);
  const [reply, facts] = await Promise.all([listUsers(ctx, guildContext, query), guildFacts(ctx.db, guildContext.guild.id)]);
  return jsonResponse({ ...reply, ...facts });
}

export async function getUser(ctx) {
  const guildContext = await usersContext(ctx);
  await limitUsers(ctx, guildContext);
  const [detail, { battlenetOnly, ownerSeat }] = await Promise.all([loadUserDetail(ctx, guildContext, ctx.params.ukey), guildFacts(ctx.db, guildContext.guild.id)]);
  return jsonResponse({ ...detail, battlenetOnly, ownerSeat });
}

// ---------------------------------------------------------------------------
// Manage users: the writes. The gate is guild.access (Officers and up), checked before the body is read; the per-user write limit after the body is shaped and before anything is read
// from the database (a refused caller writes nothing but the counter).

async function manageContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  return guildContext;
}

const limitWrites = (ctx, guildContext) => enforceRateLimit(ctx.db, guildContext.userId, ctx.now(), { key: usersWriteKey(guildContext.userId), limit: USERS_WRITE_LIMIT, windowMs: USERS_WRITE_WINDOW_MS });

export async function blockUsers(ctx) {
  const guildContext = await manageContext(ctx);
  const request = { keys: readKeys(ctx.body), reason: readReason(ctx.body) };
  await limitWrites(ctx, guildContext);
  return jsonResponse(await bulkBlock(ctx, guildContext, request));
}

export async function unblockUsers(ctx) {
  const guildContext = await manageContext(ctx);
  const request = { keys: readKeys(ctx.body) };
  await limitWrites(ctx, guildContext);
  return jsonResponse(await bulkUnblock(ctx, guildContext, request));
}

export async function addNamesToPerson(ctx) {
  const guildContext = await manageContext(ctx);
  // A new alt belongs to no team, so the right to edit the roster has to cover the whole guild (a Team Lead's team scope is not enough).
  if (guildContext.can['roster.edit'] !== 'guild') throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const request = parseAddBody(ctx.body);
  await limitWrites(ctx, guildContext);
  return jsonResponse(await addToPerson(ctx, guildContext, request));
}
