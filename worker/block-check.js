// The block check of every write a signed-in NON-member can make in a guild (user-hierarchy build, lane B3; plan "Blocks"): an open-raid sign-up, an
// application. (A claim or a team request needs membership, and loadGuildContext refuses a blocked member with the same answer.) ONE function, so the
// tombstone match of lane B7 (a block also covers the keys it was made with, so a new account of a blocked person is caught) is added in one place.
//   today: guild_blocks (the account is blocked here)  ->  403 access_removed
import { HttpError } from './http.js';

export const BLOCKED_MESSAGE = 'An officer has removed your access to this guild.';

// -> true when the account is blocked in the guild.
export async function isBlocked(db, guildId, userId) {
  if (!userId) return false;
  const row = await db.prepare('SELECT 1 AS blocked FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guildId, userId).first();
  return !!row;
}

// Throws 403 access_removed for a blocked account.
export async function assertNotBlocked(db, guildId, userId) {
  if (await isBlocked(db, guildId, userId)) throw new HttpError(403, 'access_removed', BLOCKED_MESSAGE);
}
