// The alias read helper (user-hierarchy build, lane B1a-2): ONE function every join from a stored NAME to a character goes through.
//
// A paid rename keeps the character (same Blizzard id) and changes its name: characters.name_key becomes the new key and the OLD key is written to
// character_name_aliases (migration 0031) with renamed_at, the time of the rename. Evidence stored under the old name (a boss-pull log line, a pasted
// roster, a plan seat, a loot award) must still credit the same character, while a NEW character that later takes the old name must not inherit it:
//
//   evidence dated on or before an alias's renamed_at   the ALIAS wins: the name resolves to the character that carried it
//   evidence dated after it                              the LIVE name_key wins: the name resolves to whoever carries it now
//
// resolvedNameKeySql() builds a SQL expression that turns the evidence's stored name_key into the name_key a characters row carries today:
//   COALESCE((alias of that name with renamed_at >= the evidence time -> the aliased character's live name_key), the stored name_key)
// so every existing join keeps its shape and only swaps the evidence side: `c.name_key = a.winner_name_key` becomes `c.name_key = <resolved>`.
// With no alias rows the subquery finds nothing and the expression is the stored name_key itself: results are identical to before aliases existed.
// A realm never changes in a rename (a realm move is a different character), so the realm_key of the character is the evidence's own realm_key.
//
// Times are milliseconds: raids.starts_at for raid evidence, loot_awards.awarded_at for loot, the same unit as character_name_aliases.renamed_at.
// Several aliases for one name (two characters carried it at different times): the earliest renamed_at at or after the evidence time is the one that
// carried the name when the evidence was made.
//
//   resolvedNameKeySql({ guild, nameKey, realmKey, at })
//     guild     SQL expression of the guild id            (`rp.guild_id`, `?1`; never a bare `?` that the statement binds elsewhere)
//     nameKey   SQL expression of the stored name_key      (`rp.name_key`)
//     realmKey  SQL expression of the stored realm_key, or null for evidence that has no realm (a plan seat)
//     at        SQL expression of the evidence time in ms  (`r.starts_at`, `a.awarded_at`)
// Fixed text built from the caller's own column expressions, never request data.

export function resolvedNameKeySql({ guild, nameKey, realmKey = null, at }) {
  const realm = realmKey ? ` AND nal.realm_key = ${realmKey}` : '';
  return `COALESCE((SELECT nlc.name_key FROM character_name_aliases nal
                      JOIN characters nlc ON nlc.guild_id = nal.guild_id AND nlc.id = nal.character_id
                     WHERE nal.guild_id = ${guild} AND nal.name_key = ${nameKey}${realm} AND nal.renamed_at >= ${at}
                     ORDER BY nal.renamed_at, nal.id LIMIT 1), ${nameKey})`;
}

// The loot winner of an award row (alias `a` by default): the winner's name_key as the character carries it today, dated at the award.
export const winnerNameKeySql = (alias = 'a') => resolvedNameKeySql({
  guild: `${alias}.guild_id`, nameKey: `${alias}.winner_name_key`, realmKey: `${alias}.winner_realm_key`, at: `${alias}.awarded_at`,
});
