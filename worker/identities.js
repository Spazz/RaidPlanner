// Linked sign-in identities. A Raidsmith account (a users row) has one or more of them; today:
//   discord   the account's own columns: users.discord_id (NULL until linked, UNIQUE) with the profile it came with (username, global_name, avatar)
//   bnet      a bnet_links row (one per account, one account per Battle.net account): the Battle.net account id and BattleTag
// Every route asks about identities through this module, so a generic user_identities table can replace the two homes later by changing
// only this file. Nothing here reads a token: the access tokens of both providers are used inside their callbacks and dropped.
export const PROVIDERS = ['discord', 'bnet'];

// "Thrall#1234" -> "Thrall": the part people recognise; the number only tells namesakes apart. The name an account made with Battle.net shows.
export function bnetNameOf(battletag) {
  const name = String(battletag).replace(/#\d+$/, '').trim();
  return Array.from(name).slice(0, 80).join('') || 'Player';
}

// -> { customName: string | null, discord: { username, globalName } | null, bnet: { battletag, linkedAt, refreshedAt } | null }
export async function loadIdentities(db, userId) {
  const [userResult, bnetResult] = await db.batch([
    db.prepare('SELECT discord_id, username, global_name, display_name FROM users WHERE id = ?').bind(userId),
    db.prepare('SELECT battletag, linked_at, snapshot_at FROM bnet_links WHERE user_id = ?').bind(userId),
  ]);
  const user = userResult.results[0];
  const link = bnetResult.results[0];
  return {
    customName: user ? user.display_name : null,
    discord: user && user.discord_id ? { username: user.username, globalName: user.global_name } : null,
    bnet: link ? { battletag: link.battletag, linkedAt: link.linked_at, refreshedAt: link.snapshot_at } : null,
  };
}

export const identityCount = (identities) => (identities.discord ? 1 : 0) + (identities.bnet ? 1 : 0);

// The account that holds this Discord ID / Battle.net account, or null.
export async function findUserByDiscord(db, discordId) {
  const row = await db.prepare('SELECT id FROM users WHERE discord_id = ?').bind(discordId).first();
  return row ? row.id : null;
}

export async function findUserByBnet(db, bnetAccountId) {
  const row = await db.prepare('SELECT user_id FROM bnet_links WHERE bnet_account_id = ?').bind(bnetAccountId).first();
  return row ? row.user_id : null;
}

// SQL guards for "this account would still have another way to sign in" (the last-identity rule). The user is an expression.
export const hasDiscordSql = (userExpr) => `EXISTS (SELECT 1 FROM users hd WHERE hd.id = ${userExpr} AND hd.discord_id IS NOT NULL)`;
export const hasBnetSql = (userExpr) => `EXISTS (SELECT 1 FROM bnet_links hb WHERE hb.user_id = ${userExpr})`;

// A Discord sign-in: the account that holds this Discord ID gets its profile refreshed; a Discord ID nobody holds becomes a NEW account
// (newUserId, whose own id is its account_key, see 0012). The conflict target is the unique index on users.discord_id.
// discord_linked_at (identity-change protection, plan "Identity-change") is written by the INSERT only: a returning sign-in never touches it, so the age of the
// Discord identity is the age of its first link. A new account's value equals its created_at. Kept as a record only: nothing reads it since the age rule (a) was removed (2026-10-29).
export function upsertDiscordAccountStatement(db, { newUserId, discord, now }) {
  return db.prepare(
    `INSERT INTO users (id, account_key, discord_id, username, global_name, avatar, prefs, created_at, last_seen_at, discord_linked_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET
       username = excluded.username, global_name = excluded.global_name,
       avatar = excluded.avatar, last_seen_at = excluded.last_seen_at`,
  ).bind(newUserId, newUserId, discord.id, discord.username, discord.globalName, discord.avatar, now, now, now);
}

// The INSERT of a new account made with Battle.net (no Discord yet): named after the BattleTag without its number; account_key is its own id.
export function insertBnetAccountStatement(db, { userId, battletag, now }) {
  return db.prepare(
    `INSERT INTO users (id, account_key, discord_id, username, global_name, avatar, prefs, created_at, last_seen_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, '{}', ?, ?)`,
  ).bind(userId, userId, bnetNameOf(battletag), now, now);
}
