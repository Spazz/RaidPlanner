// The reserved name keys of the user-hierarchy build (lane B6a part 2b) and the ONE SQL helper that keeps the hidden ones out of every list.
//
// A real character name is letters only (cleanCharacterName: \p{L}\p{M}), so no real name_key can start with `~`. Two kinds of character carry a reserved key:
//
//   a RETIRED PLACEHOLDER   `~ph:<its own id>`   made by a re-home (worker/rehome.js): the character that moved to another person leaves this one behind, so the old
//                           person keeps a Former character that the evidence dated before the re-home resolves to (a dated character_name_aliases row maps the
//                           moved character's name_key to it). HIDDEN from every roster, picker, Users list and count, and not counted in the 20-character cap.
//   a RETIRED NAME          `~was:<its own id>`  a REAL Former character whose name moved to a dated alias because a roster character took the name (the name
//                           collision at the sign-in match). It stays visible as a Former character; only its live key left the name space.
//
// The key carries the character's OWN id (not the moved character's): a character can be re-homed twice, and one id would then collide with itself on the
// unique (guild_id, name_key, realm_key) index. Nothing here reads or writes the database.
export const PLACEHOLDER_PREFIX = '~ph:';
export const RETIRED_NAME_PREFIX = '~was:';

export const placeholderKey = (characterId) => `${PLACEHOLDER_PREFIX}${characterId}`;
export const retiredNameKey = (characterId) => `${RETIRED_NAME_PREFIX}${characterId}`;
export const isPlaceholderKey = (key) => typeof key === 'string' && key.startsWith(PLACEHOLDER_PREFIX);

// SQL: true for every character that belongs in a list (roster, person page, picker, count). `alias` is the characters alias of the statement (a bare column name
// when the statement reads `FROM characters` without one: pass 'characters'). Fixed text, no parameters, so it fits statements with anonymous or numbered ones.
export const visibleCharacterSql = (alias = 'characters') => `substr(${alias}.name_key, 1, ${PLACEHOLDER_PREFIX.length}) <> '${PLACEHOLDER_PREFIX}'`;

// SQL: true for the retired placeholders only (the readers that must SEE them, and the ORDER BY that puts them last).
export const placeholderCharacterSql = (alias = 'characters') => `substr(${alias}.name_key, 1, ${PLACEHOLDER_PREFIX.length}) = '${PLACEHOLDER_PREFIX}'`;
