// The proof the setup pin asks for (user-hierarchy build, lane B6b part 3a; plan "Source/pin" rule (1)): the Owner has a Battle.net-proven character on the LIVE roster of the guild
// they want to pin. Pure functions; the reads and the Blizzard calls are in worker/routes/bnet-pin.js and worker/routes/bnet.js.
//
// WHERE THE ACCOUNT'S CHARACTERS COME FROM. The pin's fresh-auth callback (routes/bnet.js bnetFreshCallback, purpose 'pin') holds the Owner's Battle.net token for that one request, reads
// the account's characters in the guild's namespace from Blizzard and writes them into that namespace's entry of the link's snapshot together with the time it read them
// (`fetchedAt`), then writes the grant. The pin route is a later request with no token, so it reads that entry back and trusts it only when it is at least as new as the grant:
// the characters are the ones Blizzard listed when the person confirmed it was them, at most 15 minutes ago. Nothing the guild stored (a character row, an officer's link, a
// proof stamped earlier) decides the pin: a squatter who typed a name or hand-linked a character changes nothing here.

// -> { characters } | null. row: { fresh_at, snapshot (the link's JSON text) }. namespace: the guild's. null = the grant was not written by a pin callback that read the characters
// (the entry is missing, failed, or older than the grant).
export function livePinCharacters(entry, freshAt) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.characters)) return null;
  if (typeof entry.fetchedAt !== 'number' || typeof freshAt !== 'number' || entry.fetchedAt < freshAt) return null;
  return { characters: entry.characters };
}

const keyOf = (realmId, characterId) => `${realmId}:${characterId}`;

// -> the roster member that is one of the account's own characters (same namespace, realm id and character id: the identity key), or null. roster: parseGuildRoster's answer.
export function characterOnRoster(roster, characters, namespace) {
  const own = new Set();
  for (const character of characters) {
    if (!character || character.namespace !== namespace) continue;
    if (!Number.isSafeInteger(character.realmId) || !Number.isSafeInteger(character.characterId)) continue;
    own.add(keyOf(character.realmId, character.characterId));
  }
  return roster.members.find((member) => member.namespace === namespace && own.has(keyOf(member.realmId, member.characterId))) || null;
}
