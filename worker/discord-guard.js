// Does this guild have a Discord server? The ONE answer every Discord / Raid-Helper path asks first (user-hierarchy build, lane B1a-2).
//
// A guild that runs without Discord carries the placeholder `none:<guild_id>` in guilds.discord_server_id (column NOT NULL + UNIQUE, so the
// placeholder keeps it unique and non-null). A real server id is a Discord snowflake (digits only), so the two never collide.
//   hasDiscord(guild) = a server id is stored AND it does not start with 'none:'.
//
// Forms of the one rule:
//   hasDiscord(guild) / hasDiscordServerId(id)   for code that holds the guild row or the id
//   requireDiscord(guild)                         a route about Discord or Raid-Helper: 409 no_discord_server before any bot call or fetch
//   serverIdIsDiscordSql(column)                  for SQL: a fragment on the server-id COLUMN; the expression it guards is used once, so a bare `?`
//                                                 or a derived-table column (membership.js fragments) stays safe
// Every file that reads guilds.discord_server_id is listed in tests/guild/guild-has-discord-tests.js with how it is guarded; a new unguarded path
// fails that test.

import { HttpError } from './http.js';

export const NO_DISCORD_PREFIX = 'none:';

export const hasDiscordServerId = (serverId) => serverId !== null && serverId !== undefined && !String(serverId).startsWith(NO_DISCORD_PREFIX);

export const hasDiscord = (guild) => !!guild && hasDiscordServerId(guild.discord_server_id);

// The placeholder stored for a guild with no Discord server.
export const noDiscordServerId = (guildId) => `${NO_DISCORD_PREFIX}${guildId}`;

// SQL: true for a row whose server-id column is a real Discord server. NULL-safe (a NULL column is false).
export const serverIdIsDiscordSql = (column) => `(${column} IS NOT NULL AND substr(${column}, 1, ${NO_DISCORD_PREFIX.length}) != '${NO_DISCORD_PREFIX}')`;

// The refusal for a Discord or Raid-Helper action on a guild without Discord: 409 no_discord_server. Call it before any bot call or Raid-Helper fetch.
export function requireDiscord(guild) {
  if (!hasDiscord(guild)) throw new HttpError(409, 'no_discord_server', 'This guild does not use a Discord server, so Discord and Raid-Helper features are off.');
}
