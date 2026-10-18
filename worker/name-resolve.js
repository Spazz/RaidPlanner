// WoW Forever surnames (wave 8): a character may be "Thrall Stormrage", but a log, a loot export, a sign-up or a plan often prints only the
// first word. An incoming ONE-word name resolves to the guild's character with that first word when exactly one has it - after the full
// key was tried first (a character that is itself just "Thrall" wins). Two or more candidates: the name is left alone, so it stays
// unmatched / in the review queue exactly as an unknown name does today. TBC and Classic guilds get no index and no change.
import { allowsSurname, nameKey } from './roster-data.js';

// -> null for a guild whose version has no surnames, else { exact: Set("nameKey|realmKey"), byFirst: Map("firstWordKey|realmKey" -> [{ name, nameKey }]) }.
export async function loadSurnameIndex(db, guild) {
  if (!guild || !allowsSurname(guild.game_version)) return null;
  const result = await db.prepare('SELECT name, name_key, realm_key FROM characters WHERE guild_id = ?').bind(guild.id).all();
  const exact = new Set();
  const byFirst = new Map();
  for (const row of result.results) {
    exact.add(`${row.name_key}|${row.realm_key}`);
    const space = row.name_key.indexOf(' ');
    if (space < 0) continue;
    const slot = `${row.name_key.slice(0, space)}|${row.realm_key}`;
    if (!byFirst.has(slot)) byFirst.set(slot, []);
    const list = byFirst.get(slot);
    if (!list.some((entry) => entry.nameKey === row.name_key)) list.push({ name: row.name, nameKey: row.name_key });
  }
  return { exact, byFirst };
}

// The name to store for an incoming (already cleaned) name: the full surname form when it is a unique first-word match, else the name itself.
export function resolveName(index, name, realmKeyValue = '') {
  if (!index || typeof name !== 'string' || name.includes(' ')) return name;
  const key = nameKey(name);
  if (index.exact.has(`${key}|${realmKeyValue}`)) return name;
  const found = index.byFirst.get(`${key}|${realmKeyValue}`);
  return found && found.length === 1 ? found[0].name : name;
}
