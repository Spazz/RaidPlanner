// The Users list of a guild and the page of one user (user-hierarchy build, lane B7b part 1; plan "Users API/UI"). Read only; worker/users-list.js has the queries.
//   GET /api/guild/:gid/users?segment=members|former|nonmembers|blocked&sort=user|main|permission|lastSeen&dir=asc|desc&offset=&limit=&q=&rank=&from=
//   GET /api/guild/:gid/users/:ukey
// The gate is the People list's (guild.access or guild.roles), the rate limit is per user and shared by both routes (a read of the whole guild is not free).
import { jsonResponse } from '../http.js';
import { loadGuildContext, requireAnyAction } from '../permissions.js';
import { USERS_LIMIT, USERS_WINDOW_MS, enforceRateLimit, usersKey } from '../ratelimit.js';
import { listUsers, parseUsersQuery } from '../users-list.js';
import { loadUserDetail } from '../users-detail.js';

async function usersContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAnyAction(guildContext, ['guild.access', 'guild.roles']);
  return guildContext;
}

const limitUsers = (ctx, guildContext) => enforceRateLimit(ctx.db, guildContext.userId, ctx.now(), { key: usersKey(guildContext.userId), limit: USERS_LIMIT, windowMs: USERS_WINDOW_MS });

export async function getUsers(ctx) {
  const guildContext = await usersContext(ctx);
  const query = parseUsersQuery(new URL(ctx.request.url).searchParams);
  await limitUsers(ctx, guildContext);
  return jsonResponse(await listUsers(ctx, guildContext, query));
}

export async function getUser(ctx) {
  const guildContext = await usersContext(ctx);
  await limitUsers(ctx, guildContext);
  return jsonResponse(await loadUserDetail(ctx, guildContext, ctx.params.ukey));
}
