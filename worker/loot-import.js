// Loot import rules (pure): the re-validation of the browser's normalized Gargul awards, the automatic tag, the "is this
// award from the raid's day" test and the comparison with a stored award. No D1, no fetch, no clock.
import { addDays, localDate } from './attendance-calendar.js';
import { HttpError } from './http.js';
import { resolveName } from './name-resolve.js';
import { CLASS_IDS, SINGLE_LINE_STRIP, allowsSurname, cleanCharacterName, nameKey, realmKey } from './roster-data.js';

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
// -> [{ checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, disenchanted, rollType, flags, awardedBy,
//       nameKey, storedRealm, realmKey, tag }]  (nameKey / storedRealm / realmKey / tag are what the Worker adds)
// A disenchanted item (disenchanted: true, which Gargul writes as the winner "||de||") has NO winner: winnerName / winnerRealm /
// winnerClass must be null or absent, nameKey and storedRealm are null, realmKey is '' and the tag is DE. Any other award needs a winner.
export function readAwards(list, guild, surnames = null) {
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
    if (raw.disenchanted !== undefined && raw.disenchanted !== null && typeof raw.disenchanted !== 'boolean') throw invalid(index, 'disenchanted', 'disenchanted must be true or false.');
    const disenchanted = raw.disenchanted === true;
    // Nobody won a disenchanted item; any other award needs a character name.
    let name = null;
    let winnerClass = null;
    if (disenchanted) {
      for (const field of ['winnerName', 'winnerRealm', 'winnerClass']) {
        if (raw[field] !== undefined && raw[field] !== null) throw invalid(index, field, 'a disenchanted item has no winner.');
      }
    } else {
      name = cleanCharacterName(raw.winnerName, guild.game_version);
      if (!name) throw invalid(index, 'winnerName', allowsSurname(guild.game_version) ? 'the winner needs a character name (a first name and optional surname, 2 to 12 letters each).' : 'the winner needs a character name (2 to 12 letters).');
      winnerClass = raw.winnerClass === undefined ? null : raw.winnerClass;
      if (winnerClass !== null && !(typeof winnerClass === 'string' && CLASS_IDS.includes(winnerClass))) throw invalid(index, 'winnerClass', 'winnerClass must be a class.');
    }
    if (raw.flags !== undefined && raw.flags !== null && !Array.isArray(raw.flags)) throw invalid(index, 'flags', 'flags must be a list.');
    // Flags this version does not know are dropped, not refused: a newer Gargul can add one.
    const flags = AWARD_FLAGS.filter((flag) => (raw.flags || []).includes(flag));
    const winnerRealm = disenchanted ? null : optionalText(raw.winnerRealm, 40, index, 'winnerRealm');
    const rollType = optionalText(raw.rollType, 24, index, 'rollType');

    // A realm guild reads a missing realm as its own; a ruleset guild has no realm at all; a disenchant has no winner, so none.
    const storedRealm = isRealmGuild && !disenchanted ? (winnerRealm || guild.realm) : null;
    const realmKeyValue = storedRealm === null ? '' : realmKey(storedRealm);
    if (storedRealm !== null && !realmKeyValue) throw invalid(index, 'winnerRealm', 'the winner\'s realm is not valid.');

    if (name !== null) name = resolveName(surnames, name, realmKeyValue); // Forever: Gargul prints "Thrall", the roster has "Thrall Stormrage"

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
      disenchanted,
      rollType,
      flags,
      awardedBy: optionalText(raw.awardedBy, 64, index, 'awardedBy'),
      nameKey: disenchanted ? null : nameKey(name),
      storedRealm,
      realmKey: realmKeyValue,
      tag: disenchanted ? 'DE' : autoTag(flags, rollType),
    });
  });
  return awards;
}

// The normalized fields the preview echoes back (without what the Worker adds).
export function normalizedOf(award) {
  const { checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, disenchanted, rollType, flags, awardedBy } = award;
  return { checksum, itemId, itemName, quality, awardedAt, winnerName, winnerRealm, winnerClass, disenchanted, rollType, flags, awardedBy };
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

// The fields an officer can correct by hand on an award (loot_awards.edited_fields). An import never overwrites one of these.
export const EDITABLE_FIELDS = Object.freeze(['winner', 'item', 'raid']);

export function parseEditedFields(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? EDITABLE_FIELDS.filter((field) => value.includes(field)) : [];
  } catch {
    return [];
  }
}

// The stored award row has the item / winner fields this award would write. The columns of a field the officer edited are left out
// (an import does not write them); the tag is compared by the caller.
function sameFields(row, award, edited) {
  const winnerOk = edited.includes('winner') || (row.winner_name === award.winnerName && row.winner_name_key === award.nameKey
    && row.winner_realm === award.storedRealm && row.winner_realm_key === award.realmKey && row.winner_class === award.winnerClass);
  const itemOk = edited.includes('item') || (row.item_id === award.itemId && row.item_name === award.itemName && row.item_quality === award.quality);
  return winnerOk && itemOk && row.awarded_at === award.awardedAt && row.roll_type === award.rollType && row.awarded_by === award.awardedBy
    && sameFlags(row.flags, award.flags);
}

// True when an award gains or loses its winner between the stored row and the incoming one (a Gargul award edited to or from a
// disenchant). The tag of a no-winner award is DE by rule, not an officer's choice, so such a change drops the officer's tag.
// Never when the officer edited the winner: then the import does not touch the winner at all.
const winnerStateChanged = (existing, award, edited) => !edited.includes('winner') && (existing.winner_name === null) !== (award.winnerName === null);

const winnerText = (name) => (name === null || name === undefined ? 'Disenchanted' : name);
const itemText = (name, id) => (name ? `${name}` : `item ${id}`);

// The edited fields on which the export disagrees with the stored award: [{ field, export, officer }] (display texts).
// `raid` is the raid being imported onto: an award an officer moved sits on another raid, and the export says it belongs here.
function findConflicts(award, existing, raid, edited) {
  const conflicts = [];
  if (edited.includes('winner') && (existing.winner_name_key !== award.nameKey || existing.winner_realm_key !== award.realmKey)) {
    conflicts.push({ field: 'winner', export: winnerText(award.winnerName), officer: winnerText(existing.winner_name) });
  }
  if (edited.includes('item') && existing.item_id !== award.itemId) {
    conflicts.push({ field: 'item', export: itemText(award.itemName, award.itemId), officer: itemText(existing.item_name, existing.item_id) });
  }
  if (edited.includes('raid') && existing.raid_id !== raid.id) {
    conflicts.push({ field: 'raid', export: raid.raid_on, officer: existing.raid_on });
  }
  return conflicts;
}

// What an import does with one award. existing: the stored row with the award's checksum in this guild, or null.
// raid: { id, raid_on }. deleted: the loot_award_deletions row of this checksum, or null.
// -> { status: 'new' | 'update' | 'same' | 'otherRaid' | 'otherDay' | 'conflict' | 'deleted', tag, conflicts?, edited?, deleted? }
//   otherRaid: the checksum is on another raid nobody moved (skipped); same / update: it is on THIS raid (an update keeps the officer's tag and note,
//   and the fields the officer edited, unless the award gained or lost its winner); otherDay: new, but not from the raid's day (written only when
//   the officer ticks them in); new: written.
//   conflict: the stored award (on this raid, or on another because an officer moved it) has fields in edited_fields that the export disagrees with;
//   `conflicts` lists them, `changed` says whether any other field differs. The fields nobody edited update as in "update" either way.
//   deleted: an officer deleted this award (a tombstone); it is not brought back unless the officer asks.
export function classifyAward(award, existing, raid, timeZone, deleted = null) {
  if (existing) {
    const edited = parseEditedFields(existing.edited_fields);
    if (existing.raid_id !== raid.id && !edited.includes('raid')) return { status: 'otherRaid', tag: existing.tag };
    const conflicts = findConflicts(award, existing, raid, edited);
    if (conflicts.length) return { status: 'conflict', tag: existing.tag, conflicts, changed: !sameFields(existing, award, edited) };
    const tag = existing.tag_set_at === null || winnerStateChanged(existing, award, edited) ? award.tag : existing.tag;
    const changed = !sameFields(existing, award, edited) || tag !== existing.tag;
    return { status: changed ? 'update' : 'same', tag };
  }
  if (deleted) return { status: 'deleted', tag: award.tag, deleted: { at: deleted.deleted_at, raidId: deleted.raid_id } };
  return { status: onRaidDay(award.awardedAt, raid.raid_on, timeZone) ? 'new' : 'otherDay', tag: award.tag };
}
