// The pinned Blizzard target of a guild (migration 0031 guilds columns) and the guild's rank source. Every roster fetch for a pinned guild reads
// its target from here and from nowhere else: never guild.name, never guild.realm_slug (plan "Source/pin" rule 2). The pin columns are WRITTEN only
// by the creation-proof path, the setup pin and the flip (lanes B6b / B9 / B10); this lane only reads them.
//
//   touched   at least one of pinned_guild_slug / pinned_realm_slug / pinned_namespace is set: the guild is in pinned mode (a fetch never falls back
//             to the display name, even when the pin is incomplete).
//   target    all three of those are set: enough to ask Blizzard for the roster.
//   complete  target + blizzard_guild_id + blizzard_realm_id: enough to VALIDATE the answer (the response must name exactly that guild and realm),
//             which is what the scheduled and on-demand sync need. Only a complete pin is ever synced.

export const PIN_SQL = `SELECT id, game_version, region, time_zone, rank_source, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id,
       blizzard_realm_id, next_sync_at, last_good_sync_id, last_good_fetched_at, roster_hash
  FROM guilds WHERE id = ?`;

// The SQL for "this guild has a complete pin", for a WHERE on `guilds` (the lease claim and the scheduler's due list use the same text).
export const COMPLETE_PIN_SQL = `pinned_guild_slug IS NOT NULL AND pinned_realm_slug IS NOT NULL AND pinned_namespace IS NOT NULL
  AND blizzard_guild_id IS NOT NULL AND blizzard_realm_id IS NOT NULL`;

export function pinOf(row) {
  if (!row) return null;
  const target = row.pinned_guild_slug !== null && row.pinned_realm_slug !== null && row.pinned_namespace !== null;
  return {
    rankSource: row.rank_source === undefined ? null : row.rank_source,
    touched: row.pinned_guild_slug !== null || row.pinned_realm_slug !== null || row.pinned_namespace !== null,
    target,
    complete: target && row.blizzard_guild_id !== null && row.blizzard_realm_id !== null,
    guildSlug: row.pinned_guild_slug,
    realmSlug: row.pinned_realm_slug,
    namespace: row.pinned_namespace,
    blizzardGuildId: row.blizzard_guild_id,
    blizzardRealmId: row.blizzard_realm_id,
  };
}

// -> the guild's pin (see pinOf), or null when the guild does not exist.
export async function loadPin(db, guildId) {
  return pinOf(await db.prepare(PIN_SQL).bind(guildId).first());
}
