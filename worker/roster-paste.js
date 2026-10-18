// A pasted raid roster (wave 8, "Paste raid roster" on a raid without a log), the pure half: the names in whatever an officer copied - plain lists (one per line
// or comma separated), the in-game /who output, a raid frame copied from an addon (lines like "Group 1: Aldric, Brenna"), "Name (Class)", "Name - Class",
// "Name-Realm" - and how each is matched to the guild's characters the way the Warcraft Logs import matches a log's names: the full name first, then, for a
// Forever guild and a one-word name, the one character that has it as its first word. Nothing here reads a database; worker/routes/paste.js does.
import { SINGLE_LINE_STRIP, STOP_WORDS, allowsSurname, cleanCharacterName, nameKey } from './roster-data.js';
import { resolveName } from './name-resolve.js';

export const MAX_PASTE_CHARS = 20000;
export const MAX_PASTE_LINES = 400;
export const MAX_PASTE_NAMES = 80;
const IGNORED_SHOWN = 10;

// WoW chat and addon markup: hyperlinks keep their text, colour codes and textures go.
function stripMarkup(line) {
  return line
    .replace(/\|H[^|]*\|h(.*?)\|h/g, '$1')
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\|T.*?\|t/g, '')
    .replace(SINGLE_LINE_STRIP, (char) => (char === '\t' ? char : ''));
}

const TIMESTAMP = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?\]?\s+/;
const SUMMARY = /^\W*(?:\d+\s+(?:players?|members?|people)\b|total\b|(?:raid|party|guild)\s+(?:roster|members?|list)\b|name\s*(?:,|\t|$))/i;
const GROUP_PREFIX = /^\s*(?:sub)?(?:group|party)\s*#?\d+\s*[:\-]\s*/i;
const WHO_LINE = /^\s*\[?\s*([^\]\[:,]+?)\s*\]?\s*:\s*(?:level|lvl|lv)\s*\d+/i;
const LIST_MARKER = /^\s*(?:\d{1,3}[.)]|[-*>])\s+/;
const PIECE_SPLIT = /[,;\t|]+/;

// One piece of a line ("Aldric", "Aldric (Warrior)", "Aldric - Warrior", "[Tank] Aldric", "Aldric-Maladath", "Thrall Stormrage") ->
// { names: [candidate names, most specific first], realm: text | null } or null when it holds no word.
function candidatesOf(piece, forever) {
  let text = piece.replace(/\([^)]*\)/g, ' ').trim();
  const bracket = /^\[([^\]]+)\]\s*(.*)$/.exec(text);
  if (bracket) text = /^(?:tank|healer|heals|dps|melee|ranged|caster|dd|rdps|mdps)$/i.test(bracket[1].trim()) ? bracket[2] : bracket[1];
  text = text.replace(/\[[^\]]*\]/g, ' ').replace(/^[@*\s]+/, '').trim();
  const spaced = text.split(/\s+[-–—]\s+/)[0]; // "Aldric - Warrior"
  const head = (spaced || text).trim();
  if (!head) return null;
  const dash = head.indexOf('-');
  const namePart = (dash < 0 ? head : head.slice(0, dash)).trim();
  const realm = dash < 0 ? null : head.slice(dash + 1).trim() || null;
  const words = namePart.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const names = [];
  if (forever && words.length >= 2 && !STOP_WORDS.has(words[1].toLowerCase()) && !/^\d+$/.test(words[1])) names.push(`${words[0]} ${words[1]}`);
  names.push(words[0]);
  return { names, realm };
}

// text -> { entries: [{ names, realm, line }], ignored: [{ line, text }], ignoredCount, tooLong } (entries in order, a name once).
export function parsePastedRoster(text, { gameVersion } = {}) {
  const forever = allowsSurname(gameVersion);
  const raw = typeof text === 'string' ? text.slice(0, MAX_PASTE_CHARS) : '';
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_PASTE_LINES);
  const entries = [];
  const ignored = [];
  let ignoredCount = 0;
  const seen = new Set();
  const ignore = (line, shown) => {
    ignoredCount += 1;
    if (ignored.length < IGNORED_SHOWN) ignored.push({ line, text: shown.slice(0, 60) });
  };
  lines.forEach((original, index) => {
    const line = index + 1;
    let work = stripMarkup(original).replace(TIMESTAMP, '').trim();
    if (!work || SUMMARY.test(work)) return;
    work = work.replace(GROUP_PREFIX, '').trim();
    if (!work) return;
    const who = WHO_LINE.exec(work);
    const pieces = who ? [who[1]] : work.replace(LIST_MARKER, '').split(PIECE_SPLIT);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const found = candidatesOf(trimmed, forever);
      // A class, spec or role in its own column ("Hale  Paladin  Tank") is not a name.
      if (found && found.names.every((name) => STOP_WORDS.has(name.toLowerCase()))) continue;
      const valid = found ? found.names.filter((name) => cleanCharacterName(name, gameVersion)) : [];
      if (!found || !valid.length) { ignore(line, trimmed); continue; }
      const key = nameKey(cleanCharacterName(valid[valid.length - 1], gameVersion));
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ names: valid.map((name) => cleanCharacterName(name, gameVersion)), realm: found.realm, line });
    }
  });
  return { entries: entries.slice(0, MAX_PASTE_NAMES), ignored, ignoredCount, tooLong: entries.length > MAX_PASTE_NAMES };
}

// Matches parsed entries to the guild's characters. characters: Map("nameKey|realmKey" -> { personId, name, class }) of the guild;
// guests: Set("nameKey|realmKey"); surnames: worker/name-resolve.js loadSurnameIndex (null for a version without surnames);
// realmOf(text | null) -> { realm, key } (the guild's realm for no text; another realm's own key for one the guild does not accept, which matches nobody here).
// -> { matched: [{ name, personId, class }], guests: [{ name }], unmatched: [{ name, realm, realmKey }] } - a person once, by their first-listed character.
export function matchPasted(entries, { characters, guests, surnames, realmOf }) {
  const matched = [];
  const guestList = [];
  const unmatched = [];
  const people = new Set();
  const used = new Set();
  for (const entry of entries) {
    const realm = realmOf(entry.realm);
    const realmKeyValue = realm.key;
    let hit = null;
    let chosen = entry.names[0]; // nothing matched: the most specific name is the one to keep for review
    for (const candidate of entry.names) {
      const resolved = resolveName(surnames, candidate, realmKeyValue);
      const found = characters.get(`${nameKey(resolved)}|${realmKeyValue}`);
      if (found) { hit = found; chosen = resolved; break; }
    }
    if (hit) {
      if (people.has(hit.personId)) continue;
      people.add(hit.personId);
      matched.push({ name: hit.name, personId: hit.personId, class: hit.class });
      continue;
    }
    const resolved = resolveName(surnames, chosen, realmKeyValue);
    const key = `${nameKey(resolved)}|${realmKeyValue}`;
    if (used.has(key)) continue;
    used.add(key);
    if (guests.has(key)) guestList.push({ name: resolved });
    else unmatched.push({ name: resolved, realm: realm.realm, realmKey: realmKeyValue });
  }
  return { matched, guests: guestList, unmatched };
}
