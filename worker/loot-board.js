// Pre-raid loot board rules (pure): the re-validation of the browser's normalized TMB / softres rows and the board built from what was pasted.
// No D1, no fetch, no clock. The I/O is worker/routes/loot-board.js.
//
// What a board row is: one ITEM that has someone in line (a TMB prio, or a soft-reserve), with the people of this raid in line for it:
//   - TMB prio entries of people on the raid's roster, first-in-line first (order 1 before 2; no order last);
//   - then soft-reserve holders: guild members on the roster, and guests / pugs (a name no guild character carries);
//   - then TMB wishlist entries of roster people (shown for context, never a reason for a roll-off).
// A roll-off is when two or more different people are still in line at the top: the top prio tier of the TMB entries plus every soft-reserve
// holder, counted by person (one person on both lists counts once). An entry whose person already got the item on an earlier raid of the team
// (a Gargul award tagged MS or OS) is `received`: greyed out and never part of a roll-off. After the raid each award on it says whether it went
// the head of the line ('top': prio #1, or a soft-reserve holder; `kind` says which), to somebody else in line ('lower'), to somebody not in line
// ('elsewhere') or was disenchanted.
import { HttpError } from './http.js';
import { EXPECTED_KINDS, effectiveKind } from './signups-data.js';
import { resolveName } from './name-resolve.js';
import { allowsSurname, cleanCharacterName, nameKey } from './roster-data.js';

export const LIST_SOURCES = Object.freeze(['tmb', 'softres']);
export const MAX_LIST_ROWS = 5000;
export const MAX_ITEM_ID = 2147483647;
const KINDS = Object.freeze({ tmb: ['prio', 'wish'], softres: ['sr'] });
const MAX_PRIO = 9999;
const MAX_COPIES = 20;
// An attendance outcome that means the person was in the raid (a fill-in was never signed up, a late one still came).
const ATTENDED = Object.freeze(['present', 'late', 'left_early', 'late_left', 'fill_in']);
const SHOWN_UNMATCHED = 30;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (index, field, message) => new HttpError(400, 'bad_request', `Row ${index + 1}: ${message}`, { field: 'rows', index, rowField: field });

// null / undefined / empty -> null; otherwise the text without control characters, trimmed and cut to `max` characters.
function optionalText(value, max, index, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(index, field, `${field} must be text.`);
  const text = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, max).join('');
  return text || null;
}

export function isListSource(value) {
  return typeof value === 'string' && LIST_SOURCES.includes(value);
}

// The browser's normalized rows of one list -> the cleaned rows the Worker stores, or a 400 naming the first bad one. An empty list is allowed (it clears
// the source). TMB rows: { name, itemId, kind: 'prio' | 'wish', prio?: whole number | null, itemName? }. Softres rows: { name, itemId, copies?, itemName? }.
// The same person on the same item twice is one row (TMB: the best order; softres: the copies added up, at most 20).
// -> [{ source, kind, name, nameKey, itemId, itemName, prio, copies }]
export function readListRows(source, list, names = {}) {
  if (!isListSource(source)) throw new HttpError(400, 'bad_request', 'Pick TMB or softres.', { field: 'source' });
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_request', 'Send the rows as a list.', { field: 'rows' });
  if (list.length > MAX_LIST_ROWS) throw new HttpError(400, 'bad_request', `Send at most ${MAX_LIST_ROWS} rows at a time.`, { field: 'rows' });
  const merged = new Map();
  list.forEach((raw, index) => {
    if (!isPlainObject(raw)) throw invalid(index, 'row', 'each row must be an object.');
    const name = resolveName(names.surnames || null, cleanCharacterName(raw.name, names.gameVersion), names.realmKey || '');
    if (!name) throw invalid(index, 'name', allowsSurname(names.gameVersion) ? 'the character needs a name (a first name and optional surname, 2 to 12 letters each).' : 'the character needs a name (2 to 12 letters).');
    if (!Number.isInteger(raw.itemId) || raw.itemId < 1 || raw.itemId > MAX_ITEM_ID) throw invalid(index, 'itemId', 'itemId must be a positive whole number.');
    let kind = 'sr';
    let prio = null;
    let copies = 1;
    if (source === 'tmb') {
      kind = raw.kind;
      if (!KINDS.tmb.includes(kind)) throw invalid(index, 'kind', 'kind must be prio or wish.');
      if (raw.prio !== undefined && raw.prio !== null) {
        if (!(Number.isInteger(raw.prio) && raw.prio >= 0 && raw.prio <= MAX_PRIO)) throw invalid(index, 'prio', `prio must be a whole number from 0 to ${MAX_PRIO}.`);
        prio = raw.prio;
      }
    } else if (raw.copies !== undefined && raw.copies !== null) {
      if (!(Number.isInteger(raw.copies) && raw.copies >= 1 && raw.copies <= MAX_COPIES)) throw invalid(index, 'copies', `copies must be a whole number from 1 to ${MAX_COPIES}.`);
      copies = raw.copies;
    }
    const itemName = optionalText(raw.itemName, 100, index, 'itemName');
    const key = nameKey(name);
    const id = `${kind}|${raw.itemId}|${key}`;
    const earlier = merged.get(id);
    if (!earlier) {
      merged.set(id, { source, kind, name, nameKey: key, itemId: raw.itemId, itemName, prio, copies });
      return;
    }
    if (kind === 'sr') earlier.copies = Math.min(MAX_COPIES, earlier.copies + copies);
    else if (prio !== null && (earlier.prio === null || prio < earlier.prio)) earlier.prio = prio;
    if (!earlier.itemName) earlier.itemName = itemName;
  });
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Who is expected on the raid

// signupRows: raid_signups rows { source, player_id, kind, standby } of ANY source (Raid-Helper, Raidsmith, the plan); attendanceRows: { player_id, outcome };
// teamPeopleIds: the ids of the team's people who are not inactive. -> { ids: Set of person ids, source: 'signups' | 'team' }.
// A person with a Raidsmith sign-up counts by it alone (it replaces their Raid-Helper row, as everywhere else); the plan's placement and the raid's
// attendance add people on top. When nothing at all says who comes, every active person of the team is expected.
export function expectedPeople({ signupRows, attendanceRows, teamPeopleIds }) {
  const native = new Set(signupRows.filter((row) => row.source === 'raidsmith' && row.player_id).map((row) => row.player_id));
  const ids = new Set();
  for (const row of signupRows) {
    if (!row.player_id) continue;
    if (row.source === 'raid_helper' && native.has(row.player_id)) continue;
    if (EXPECTED_KINDS.includes(effectiveKind(row))) ids.add(row.player_id);
  }
  for (const row of attendanceRows) if (row.player_id && ATTENDED.includes(row.outcome)) ids.add(row.player_id);
  if (ids.size) return { ids, source: 'signups' };
  return { ids: new Set(teamPeopleIds), source: 'team' };
}

// ---------------------------------------------------------------------------
// The board

const KIND_ORDER = { prio: 0, sr: 1, wish: 2 };
const orderOf = (entry) => (entry.prio === null ? Number.POSITIVE_INFINITY : entry.prio);
const byEntry = (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.kind === 'sr' ? 0 : orderOf(a) - orderOf(b)) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
const contestKey = (entry) => (entry.personId ? `p:${entry.personId}` : `n:${entry.nameKey}`);

// rows: the stored list rows { source, kind, name, name_key, item_id, item_name, prio, copies }.
// characters: Map nameKey -> { player_id, name, class } (the character a list name belongs to, if any).
// expected: Set of person ids. receivedKeys: Set of `${itemId}|${nameKey}` the team already awarded on an earlier raid.
// itemNames: Map itemId -> name (from past awards). awards: the awards of THIS raid { item_id, tag, winner_name, winner_name_key } with `personId` filled in
// when the winner is a roster character. -> { items, unmatched }
export function buildBoard({ rows, characters, expected, receivedKeys, itemNames, awards }) {
  const byItem = new Map();
  for (const row of rows) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
    byItem.get(row.item_id).push(row);
  }
  const awardsByItem = new Map();
  for (const award of awards) {
    if (!awardsByItem.has(award.item_id)) awardsByItem.set(award.item_id, []);
    awardsByItem.get(award.item_id).push(award);
  }
  const unmatched = new Set();
  const items = [];
  for (const [itemId, itemRows] of byItem) {
    const line = [];
    let omitted = 0;
    for (const row of itemRows) {
      const character = characters.get(row.name_key) || null;
      const personId = character ? character.player_id : null;
      if (row.kind !== 'sr') {
        if (row.kind === 'prio' && !character) unmatched.add(row.name);
        if (!personId || !expected.has(personId)) { omitted += 1; continue; }
      } else if (personId && !expected.has(personId)) {
        omitted += 1;
        continue;
      }
      line.push({
        key: `${row.kind}:${row.name_key}`,
        name: character ? character.name : row.name,
        nameKey: row.name_key,
        personId,
        class: character ? character.class : null,
        kind: row.kind,
        prio: row.kind === 'sr' ? null : row.prio,
        copies: row.copies,
        guest: row.kind === 'sr' && !personId,
        received: receivedKeys.has(`${itemId}|${row.name_key}`),
        top: false,
      });
    }
    line.sort(byEntry);
    if (!line.some((entry) => entry.kind !== 'wish')) continue; // only wishlists in line: not an item of this raid
    const active = line.filter((entry) => entry.kind !== 'wish' && !entry.received);
    const activePrio = active.filter((entry) => entry.kind === 'prio');
    const best = activePrio.length ? Math.min(...activePrio.map(orderOf)) : null;
    for (const entry of active) if (entry.kind === 'sr' || orderOf(entry) === best) entry.top = true;
    const contenders = new Set(active.filter((entry) => entry.top).map(contestKey));
    const name = itemRows.find((row) => row.item_name)?.item_name || itemNames.get(itemId) || null;
    const results = (awardsByItem.get(itemId) || []).map((award) => {
      let result;
      if (award.winner_name_key === null) result = 'disenchanted';
      else {
        const same = (entry) => (award.personId ? entry.personId === award.personId : entry.nameKey === award.winner_name_key);
        const head = line.find((entry) => entry.top && same(entry));
        if (head) result = 'top';
        else if (line.some((entry) => entry.kind !== 'wish' && same(entry))) result = 'lower';
        else result = 'elsewhere';
        return { winner: award.winner_name, personId: award.personId || null, tag: award.tag, result, kind: head ? head.kind : null };
      }
      return { winner: award.winner_name, personId: award.personId || null, tag: award.tag, result, kind: null };
    });
    items.push({
      itemId, itemName: name, contested: contenders.size >= 2, done: active.length === 0, line, omitted, results,
    });
  }
  items.sort((a, b) => (b.contested ? 1 : 0) - (a.contested ? 1 : 0) || (a.done ? 1 : 0) - (b.done ? 1 : 0)
    || String(a.itemName || '\uffff').localeCompare(String(b.itemName || '\uffff')) || a.itemId - b.itemId);
  return { items, unmatched: [...unmatched].sort().slice(0, SHOWN_UNMATCHED) };
}
