// Discord REST calls made AS THE RAIDSMITH BOT (DISCORD_BOT_TOKEN), for the role mapping. The bot is silent and HTTP-only: officers add it to their
// Discord server with an invite link (scope `bot`, permissions 0, so it can do nothing in the server), and the Worker only ever READS from Discord with it:
//   GET /guilds/{id}/roles                 the roles of the server (to map them)
//   GET /guilds/{id}/members/{user_id}     one member's role ids (no privileged intent: the Server Members Intent is not needed for a single fetch)
// The token goes to apiBase(env) only (discord.com or a local fake) and is never logged, returned or stored. The fetch is injected.
import { apiBase } from './discord.js';
import { hasDiscordServerId } from './discord-guard.js';

const SNOWFLAKE = /^\d{1,25}$/;
const MAX_ROLES = 250;
const CALL_TIMEOUT_MS = 3000;

export function botConfigured(env) {
  return typeof env.DISCORD_BOT_TOKEN === 'string' && env.DISCORD_BOT_TOKEN.trim() !== '';
}

// The link an officer opens to add the bot to their server: pre-selects the server and asks for no permissions at all. null without a client id.
export function inviteUrl(env, serverId) {
  if (!hasDiscordServerId(serverId)) return null; // a guild without Discord has no server to invite the bot to
  if (typeof env.DISCORD_CLIENT_ID !== 'string' || !env.DISCORD_CLIENT_ID || !SNOWFLAKE.test(String(serverId))) return null;
  const query = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, scope: 'bot', permissions: '0', guild_id: String(serverId), disable_guild_select: 'true',
  });
  return `${apiBase(env)}/oauth2/authorize?${query}`;
}

// -> { ok: true, body } or { ok: false, reason }.
//   reason: 'bad_token' (Discord refused the token), 'bot_missing' (the bot is not in the server, or may not see it), 'unknown_member',
//   'rate_limited', 'unavailable' (network, 5xx, an answer we cannot read).
async function botGet(env, fetchImpl, path) {
  let response;
  try {
    // A call that stalls must not hold a sign-in: give up after a few seconds (the next sign-in tries again).
    response = await fetchImpl(`${apiBase(env)}${path}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN.trim()}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.ok) return body === null ? { ok: false, reason: 'unavailable' } : { ok: true, body };
  if (response.status === 401) return { ok: false, reason: 'bad_token' };
  if (response.status === 403) return { ok: false, reason: 'bot_missing' };
  if (response.status === 404) {
    // 10007 Unknown Member (the person is not in the server); 10004 Unknown Guild (the bot cannot see the server).
    return { ok: false, reason: body && body.code === 10007 ? 'unknown_member' : 'bot_missing' };
  }
  if (response.status === 429) return { ok: false, reason: 'rate_limited' };
  return { ok: false, reason: 'unavailable' };
}

const colorOf = (value) => (Number.isInteger(value) && value > 0 && value <= 0xffffff ? `#${value.toString(16).padStart(6, '0')}` : null);

// The server's roles, highest first, without @everyone (its id is the server's) -> { ok: true, roles: [{ id, name, color, position, managed }] }.
export async function fetchServerRoles(env, fetchImpl, serverId) {
  if (!hasDiscordServerId(serverId)) return { ok: false, reason: 'no_server' }; // a guild without Discord: no call at all
  if (!botConfigured(env)) return { ok: false, reason: 'not_configured' };
  if (!SNOWFLAKE.test(String(serverId))) return { ok: false, reason: 'bot_missing' };
  const result = await botGet(env, fetchImpl, `/api/v10/guilds/${serverId}/roles`);
  if (!result.ok) return result;
  if (!Array.isArray(result.body)) return { ok: false, reason: 'unavailable' };
  const roles = result.body
    .filter((role) => role && typeof role.id === 'string' && SNOWFLAKE.test(role.id) && role.id !== String(serverId) && typeof role.name === 'string')
    .slice(0, MAX_ROLES)
    .map((role) => ({
      id: role.id, name: role.name.slice(0, 100), color: colorOf(role.color), position: Number.isInteger(role.position) ? role.position : 0, managed: role.managed === true,
    }))
    .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
  return { ok: true, roles };
}

// One member's role ids -> { ok: true, roleIds, absent }. A person who is not in the server has no roles (absent: true) - that is an answer, not a failure.
export async function fetchMemberRoleIds(env, fetchImpl, serverId, discordUserId) {
  if (!hasDiscordServerId(serverId)) return { ok: false, reason: 'no_server' }; // a guild without Discord: no call at all
  if (!botConfigured(env)) return { ok: false, reason: 'not_configured' };
  if (!SNOWFLAKE.test(String(serverId)) || !SNOWFLAKE.test(String(discordUserId))) return { ok: false, reason: 'unavailable' };
  const result = await botGet(env, fetchImpl, `/api/v10/guilds/${serverId}/members/${discordUserId}`);
  if (!result.ok) return result.reason === 'unknown_member' ? { ok: true, roleIds: [], absent: true } : result;
  if (!result.body || !Array.isArray(result.body.roles)) return { ok: false, reason: 'unavailable' };
  const roleIds = [...new Set(result.body.roles.filter((id) => typeof id === 'string' && SNOWFLAKE.test(id)))].slice(0, MAX_ROLES);
  return { ok: true, roleIds, absent: false };
}
