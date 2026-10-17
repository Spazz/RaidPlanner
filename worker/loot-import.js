// Loot import rules (pure): the re-validation of the browser's normalized Gargul awards, the automatic tag, the "is this
// award from the raid's day" test and the comparison with a stored award. No D1, no fetch, no clock.
import { addDays, localDate } from './attendance-calendar.js';
import { HttpError } from './http.js';
import { CLASS_IDS, SINGLE_LINE_STRIP, cleanCharacterName, nameKey, realmKey } from './roster-data.js';

export const MAX_AWARDS = 500;
// Gargul's flags, in the order they are stored.
export const AWARD_FLAGS = Object.freeze(['OS', 'SR', 'WL', 'PL', 'TMB']);

const CHECKSUM = /^[\x21-\x7e]{8,40}$/;
const MAX_ITEM_ID = 2147483647;
const EARLIEST_MS = Date.UTC(2004, 10, 23); // World of Warcraft's release: nothing was awarded before it
const LATEST_MS = Date.UTC(2100, 0, 1);
const NEXT_DAY_CUTOFF_HOUR = 6;             // a raid that crosses midnight: awards until 06:00 the next local day still belong to it

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalid = (index, field, message) => new HttpError(400, 'bad_request', `Award ${index + 1}: ${message}`, { field: 'awards', index, awardField: field });

// null / undefined / empty -> null; otherwise the text without control characters, trimmed and cut to `max` characters.
function optionalText(value, max, index, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(index, field, `${field} must be text.`);
  const text = Array.from(value.replace(SINGLE_LINE_STRIP, '').trim()).slice(0, max).join('');
  return text || null;
}

// Off-spec when Gargul flagged it, or the winning roll type names it ("OS", "off-spec", "Off Spec").
export function autoTag(flags, rollType) {
  if (Array.isArray(flags) && flags.includes('OS')) return 'OS';
  if (typeof rollType === 'string' && /\b(os|off[\s_-]?spec)\b/i.test(rollType)) return 'OS';
  return 'MS';
}

// The browser's normalized awards -> the cleaned awards the Worker stores, or a 400 naming the first bad one.
// The same checksum twice in one paste counts once (the first). guild: { realm, realm_kind }.
// -> [{ checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, rollType, flags, awardedBy,
//       nameKey, storedRealm, realmKey, tag }]  (nameKey / storedRealm / realmKey / tag are what the Worker adds)
export function readAwards(list, guild) {
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_request', 'Send the awards as a list.', { field: 'awards' });
  if (!list.length) throw new HttpError(400, 'bad_request', 'Send at least one award.', { field: 'awards' });
  if (list.length > MAX_AWARDS) throw new HttpError(400, 'bad_request', `Send at most ${MAX_AWARDS} awards at a time.`, { field: 'awards' });
  const isRealmGuild = guild.realm_kind !== 'ruleset';
  const seen = new Set();
  const awards = [];
  list.forEach((raw, index) => {
    if (!isPlainObject(raw)) throw invalid(index, 'award', 'each award must be an object.');
    if (typeof raw.checksum !== 'string' || !CHECKSUM.test(raw.checksum)) throw invalid(index, 'checksum', 'checksum must be 8 to 40 characters without spaces.');
    if (!Number.isInteger(raw.itemId) || raw.itemId < 1 || raw.itemId > MAX_ITEM_ID) throw invalid(index, 'itemId', 'itemId must be a positive whole number.');
    if (!Number.isInteger(raw.awardedAt) || raw.awardedAt < EARLIEST_MS || raw.awardedAt > LATEST_MS) throw invalid(index, 'awardedAt', 'awardedAt must be a time in milliseconds.');
    const quality = raw.quality === undefined ? null : raw.quality;
    if (quality !== null && !(Number.isInteger(quality) && quality >= 0 && quality <= 7)) throw invalid(index, 'quality', 'quality must be a whole number from 0 to 7.');
    const name = cleanCharacterName(raw.winnerName);
    if (!name) throw invalid(index, 'winnerName', 'the winner needs a character name (2 to 12 letters).');
    const winnerClass = raw.winnerClass === undefined ? null : raw.winnerClass;
    if (winnerClass !== null && !(typeof winnerClass === 'string' && CLASS_IDS.includes(winnerClass))) throw invalid(index, 'winnerClass', 'winnerClass must be a class.');
    if (raw.flags !== undefined && raw.flags !== null && !Array.isArray(raw.flags)) throw invalid(index, 'flags', 'flags must be a list.');
    // Flags this version does not know are dropped, not refused: a newer Gargul can add one.
    const flags = AWARD_FLAGS.filter((flag) => (raw.flags || []).includes(flag));
    const winnerRealm = optionalText(raw.winnerRealm, 40, index, 'winnerRealm');
    const rollType = optionalText(raw.rollType, 24, index, 'rollType');

    // A realm guild reads a missing realm as its own; a ruleset guild has no realm at all.
    const storedRealm = isRealmGuild ? (winnerRealm || guild.realm) : null;
    const realmKeyValue = isRealmGuild ? realmKey(storedRealm) : '';
    if (isRealmGuild && !realmKeyValue) throw invalid(index, 'winnerRealm', 'the winner\'s realm is not valid.');

    if (seen.has(raw.checksum)) return;
    seen.add(raw.checksum);
    awards.push({
      checksum: raw.checksum,
      itemId: raw.itemId,
      itemName: optionalText(raw.itemName, 100, index, 'itemName'),
      quality,
      awardedAt: raw.awardedAt,
      winnerName: name,
      winnerRealm,
      winnerClass,
      rollType,
      flags,
      awardedBy: optionalText(raw.awardedBy, 64, index, 'awardedBy'),
      nameKey: nameKey(name),
      storedRealm,
      realmKey: realmKeyValue,
      tag: autoTag(flags, rollType),
    });
  });
  return awards;
}

// The normalized fields the preview echoes back (without what the Worker adds).
export function normalizedOf(award) {
  const { checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, rollType, flags, awardedBy } = award;
  return { checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, rollType, flags, awardedBy };
}

function localHour(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).formatToParts(new Date(ms));
  return Number(parts.find((part) => part.type === 'hour').value);
}

// True when the award falls on the raid's guild-local date, or on the next local day before 06:00 (a raid across midnight).
export function onRaidDay(awardedAt, raidOn, timeZone) {
  const day = localDate(awardedAt, timeZone);
  if (day === raidOn) return true;
  return day === addDays(raidOn, 1) && localHour(awardedAt, timeZone) < NEXT_DAY_CUTOFF_HOUR;
}

const sameFlags = (stored, flags) => {
  try { return JSON.stringify(JSON.parse(stored)) === JSON.stringify(flags); } catch { return false; }
};

// The stored award row has the item / winner fields this award would write (the tag is compared by the caller).
function sameFields(row, award) {
  return row.item_id === award.itemId && row.item_name === award.itemName && row.item_quality === award.quality
    && row.awarded_at === award.awardedAt && row.winner_name === award.winnerName && row.winner_name_key === award.nameKey
    && row.winner_realm === award.storedRealm && row.winner_realm_key === award.realmKey && row.winner_class === award.winnerClass
    && row.roll_type === award.rollType && row.awarded_by === award.awardedBy && sameFlags(row.flags, award.flags);
}

// What an import does with one award. existing: the stored row with the award's checksum in this guild, or null.
// raid: { id, raid_on }. -> { status: 'new' | 'update' | 'same' | 'otherRaid' | 'otherDay', tag }
//   otherRaid: the checksum is on another raid (skipped); same / update: it is on THIS raid (an update keeps the officer's tag and note);
//   otherDay: new, but not from the raid's day (written only when the officer ticks them in); new: written.
export function classifyAward(award, existing, raid, timeZone) {
  if (existing && existing.raid_id !== raid.id) return { status: 'otherRaid', tag: existing.tag };
  if (existing) {
    const tag = existing.tag_set_at === null ? award.tag : existing.tag;
    const changed = !sameFields(existing, award) || tag !== existing.tag;
    return { status: changed ? 'update' : 'same', tag };
  }
  return { status: onRaidDay(award.awardedAt, raid.raid_on, timeZone) ? 'new' : 'otherDay', tag: award.tag };
}
