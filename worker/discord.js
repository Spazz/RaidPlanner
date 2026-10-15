// Discord OAuth and the two API calls the sign-in needs. The fetch is injected.
const DEFAULT_BASE = 'https://discord.com';
const LOCAL_BASE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;
const SNOWFLAKE = /^\d{1,25}$/;
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

// DISCORD_API_BASE is honoured only for discord.com or a local fake; anything else is ignored.
export function apiBase(env) {
  const raw = typeof env.DISCORD_API_BASE === 'string' ? env.DISCORD_API_BASE.trim().replace(/\/+$/, '') : '';
  if (raw === DEFAULT_BASE || LOCAL_BASE.test(raw)) return raw;
  return DEFAULT_BASE;
}

// The origin the sign-in must run on, taken from DISCORD_REDIRECT_URI. Null when unset or invalid.
export function canonicalOrigin(env) {
  try {
    return new URL(env.DISCORD_REDIRECT_URI).origin;
  } catch {
    return null;
  }
}

export function isConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && canonicalOrigin(env));
}

export function authorizeUrl(env, state) {
  const query = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return `${apiBase(env)}/oauth2/authorize?${query}`;
}

async function postForm(fetchImpl, url, fields) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function exchangeCode(env, fetchImpl, code) {
  const response = await postForm(fetchImpl, `${apiBase(env)}/api/oauth2/token`, {
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.DISCORD_REDIRECT_URI,
  });
  if (!response.ok) throw new Error('token exchange failed');
  const body = await response.json();
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new Error('no access token');
  return body.access_token;
}

async function getJson(env, fetchImpl, path, accessToken) {
  const response = await fetchImpl(`${apiBase(env)}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`discord ${path} failed`);
  return response.json();
}

export async function fetchDiscordUser(env, fetchImpl, accessToken) {
  const body = await getJson(env, fetchImpl, '/api/v10/users/@me', accessToken);
  if (!body || typeof body.id !== 'string' || !SNOWFLAKE.test(body.id) || typeof body.username !== 'string' || !body.username) {
    throw new Error('unexpected user payload');
  }
  return {
    id: body.id,
    username: body.username.slice(0, 80),
    globalName: typeof body.global_name === 'string' && body.global_name ? body.global_name.slice(0, 80) : null,
    avatar: typeof body.avatar === 'string' ? body.avatar : null,
  };
}

// The person's servers, each with the access they hold there.
export async function fetchDiscordGuilds(env, fetchImpl, accessToken) {
  const body = await getJson(env, fetchImpl, '/api/v10/users/@me/guilds?limit=200', accessToken);
  if (!Array.isArray(body)) throw new Error('unexpected guilds payload');
  const servers = [];
  for (const entry of body) {
    if (!entry || typeof entry.id !== 'string' || !SNOWFLAKE.test(entry.id)) continue;
    servers.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 100) : '',
      icon: typeof entry.icon === 'string' ? entry.icon : null,
      access: accessOf(entry),
    });
  }
  return servers;
}

// "owner", "administrator", "manage_server", or null when the person cannot manage the server.
export function accessOf(entry) {
  if (entry.owner === true) return 'owner';
  let permissions = 0n;
  try { permissions = BigInt(entry.permissions); } catch { return null; }
  if (permissions & ADMINISTRATOR) return 'administrator';
  if (permissions & MANAGE_GUILD) return 'manage_server';
  return null;
}

export async function revokeToken(env, fetchImpl, accessToken) {
  try {
    await postForm(fetchImpl, `${apiBase(env)}/api/oauth2/token/revoke`, {
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      token: accessToken,
      token_type_hint: 'access_token',
    });
  } catch {
    // A failed revoke changes nothing: the token is never stored and expires on its own.
  }
}

const ICON_HASH = /^(?:a_)?[0-9a-f]{32}$/;
export function serverIconUrl(serverId, icon) {
  if (!SNOWFLAKE.test(serverId) || typeof icon !== 'string' || !ICON_HASH.test(icon)) return null;
  return `https://cdn.discordapp.com/icons/${serverId}/${icon}.png?size=64`;
}

export function avatarUrl(discordId, avatar) {
  if (!SNOWFLAKE.test(discordId) || typeof avatar !== 'string' || !ICON_HASH.test(avatar)) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
}

export function isAllowlisted(env, discordId) {
  if (typeof env.GUILD_CREATOR_ALLOWLIST !== 'string') return false;
  return env.GUILD_CREATOR_ALLOWLIST.split(',').map((id) => id.trim()).filter(Boolean).includes(discordId);
}
