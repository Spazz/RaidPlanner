// Native sign-ups, the pure half (no I/O): the kinds, the Raid-Helper vocabulary a native row is stored in, the role groups of the list,
// the merge of Raidsmith and Raid-Helper rows by person, and the counts. worker/routes/signups.js reads the rows and calls these.
import { displayCharacter } from './attendance-view.js';
import {
  RAID_HELPER_CLASS, RAID_HELPER_SPEC, SPEC_ROLE, nameKey, ownValue, roleOf,
} from './roster-data.js';

// A member picks one of these for themselves; Bench is an officer's call. 'standby' ("happy to sit out if needed") is a Raidsmith sign-up
// stored as kind 'signed' + raid_signups.standby = 1 (so the kind CHECK and every older reader stay valid); every reader that needs the
// kind derives the EFFECTIVE one: effectiveKind() here, `CASE WHEN s.kind = 'signed' AND s.standby = 1 THEN 'standby' ELSE s.kind END` in SQL.
export const SELF_KINDS = ['signed', 'late', 'standby', 'tentative', 'absence'];
export const SIGNUP_KINDS = ['signed', 'late', 'standby', 'tentative', 'bench', 'absence'];
export const NOTE_MAX = 120;

// The kinds that count as coming to the raid: the people "expected" in the counts, the role and class tallies and the attendance.
export const EXPECTED_KINDS = ['signed', 'late', 'standby'];

// The effective kind of a raid_signups row ({ kind, standby }): 'signed' with standby = 1 is 'standby', anything else is its kind.
export const effectiveKind = (row) => (row.kind === 'signed' && row.standby === 1 ? 'standby' : row.kind);

// The stored form of an effective kind: { kind, standby } for the kind column and the standby column.
export const storedKind = (kind) => (kind === 'standby' ? { kind: 'signed', standby: 1 } : { kind, standby: 0 });

export const ROLE_GROUPS = ['tank', 'healer', 'melee', 'ranged'];

// The Raid-Helper class name of a class id ('PALADIN' -> 'Paladin'): how a native row stores its class.
const CLASS_NAME_OF = Object.fromEntries(Object.entries(RAID_HELPER_CLASS).map(([name, id]) => [id, name]));
export const raidHelperClassName = (classId) => ownValue(CLASS_NAME_OF, classId) || null;

// The Raid-Helper spec key of a class + spec label ('PALADIN', 'Holy' -> 'Holy1'): the first key that stands for it.
export function raidHelperSpecKey(classId, spec) {
  if (!classId || !spec) return null;
  for (const [key, entry] of Object.entries(RAID_HELPER_SPEC)) {
    if (entry.class === classId && entry.spec === spec) return key;
  }
  return null;
}

// The class a Raid-Helper-worded row stands for (its spec decides first, as in the Planner's import), or null for Absence/Bench/no class.
export function signUpClassId(row) {
  const spec = ownValue(RAID_HELPER_SPEC, row.spec_name);
  return spec ? spec.class : (ownValue(RAID_HELPER_CLASS, row.class_name) || null);
}

// The spec label ('Holy') of a Raid-Helper-worded row, or null.
export function signUpSpecLabel(row) {
  const spec = ownValue(RAID_HELPER_SPEC, row.spec_name);
  return spec ? spec.spec : null;
}

// The name the Planner shows for a sign-up. characters: the person's characters ({ name, class, is_main }), [] when the
// sign-up is not on the roster. Their Main when it is of the signed-up class; else their Alt of that class (several: the one
// named like the Discord nickname, else the first by name); otherwise their Main; not on the roster (or no Main): the Discord nickname.
export function plannerName(row, characters) {
  const list = Array.isArray(characters) ? characters : [];
  const main = list.find((character) => character.is_main === 1);
  if (!main) return row.nickname;
  const classId = signUpClassId(row);
  if (!classId || main.class === classId) return main.name;
  const alts = classId ? list.filter((character) => character.is_main !== 1 && character.class === classId) : [];
  if (!alts.length) return main.name;
  const nick = nameKey(row.nickname || '');
  const sorted = [...alts].sort((a, b) => (nameKey(a.name) < nameKey(b.name) ? -1 : nameKey(a.name) > nameKey(b.name) ? 1 : 0));
  // Forever: a Discord nickname that is just the first word of an Alt's "First Surname" names that Alt too (after the full key).
  const named = sorted.find((character) => nameKey(character.name) === nick) || (nick ? sorted.find((character) => nameKey(character.name).startsWith(`${nick} `)) : null);
  return (named || sorted[0]).name;
}

// Ranged damage: all of Hunter, Mage and Warlock, and these specs. Every other damage spec is melee.
const RANGED_CLASSES = ['HUNTER', 'MAGE', 'WARLOCK'];
const RANGED_SPECS = { PRIEST: ['Shadow'], SHAMAN: ['Elemental'], DRUID: ['Balance'] };
// A class signed up without a spec: only these say which group they are in; the rest are "no role yet".
const CLASS_ONLY_GROUP = { ROGUE: 'melee', HUNTER: 'ranged', MAGE: 'ranged', WARLOCK: 'ranged' };

// 'tank' | 'healer' | 'melee' | 'ranged' for a class + spec, or null when the spec is unknown and the class does not say.
export function roleGroup(classId, spec) {
  if (!classId) return null;
  const role = spec ? roleOf(classId, spec) : null;
  if (role === 'tank' || role === 'healer') return role;
  if (role === 'dps') {
    if (RANGED_CLASSES.includes(classId) || (ownValue(RANGED_SPECS, classId) || []).includes(spec)) return 'ranged';
    return 'melee';
  }
  return ownValue(CLASS_ONLY_GROUP, classId) || null;
}

// Specs a person may sign up with on a character: its main spec and off spec first, then every other spec of the class.
export function specChoices(character) {
  const all = Object.keys(ownValue(SPEC_ROLE, character.class) || {});
  const first = [character.main_spec, character.off_spec].filter((spec, i, list) => spec && all.includes(spec) && list.indexOf(spec) === i);
  return first.concat(all.filter((spec) => !first.includes(spec)));
}

// When a member's window closes and why it is closed ('started' | 'locked' | 'deadline' | null): worker/signup-window.js. Officers are not bound by it.
export { MAX_CLOSE_HOURS, closeHoursOf, closedReason, closesAtOf, isCloseHours, windowFieldsOf } from './signup-window.js';

const ROLE_ORDER = { tank: 0, healer: 1, melee: 2, ranged: 3 };

// The merged list of one raid. rows: raid_signups rows of the Raid-Helper and Raidsmith sources (not the plan's);
// charactersByPlayer: Map personId -> [character rows]; opts: { teamId, seeNicknames, myPlayerId, away, notes }.
// A person with a Raidsmith sign-up is listed once, by it: it replaces their Raid-Helper row. Raid-Helper rows with no person stay as they are.
// opts.away: [{ personId }] the people an Away notice covers who have no sign-up at all: each is listed as a VIRTUAL Absence (source 'away', key
// `a:<personId>`, never stored; a real sign-up always wins, so a person with a row is skipped). opts.notes: Map personId -> { kind, atTime } of Late / Leaving
// notices: a real entry of that person carries `notice: { kind, atTime }`.
export function mergeSignups(rows, charactersByPlayer, opts) {
  const native = new Map();
  for (const row of rows) if (row.source === 'raidsmith' && row.player_id) native.set(row.player_id, row);
  const characterRows = (playerId) => (playerId && charactersByPlayer.get(playerId)) || [];
  const entries = [];
  for (const row of rows) {
    if (row.source === 'raid_helper' && row.player_id && native.has(row.player_id)) continue;
    const characters = characterRows(row.player_id);
    const chosen = row.source === 'raidsmith' ? characters.find((character) => character.id === row.character_id) : null;
    const shown = chosen || displayCharacter(characters, opts.teamId);
    const classId = row.source === 'raidsmith' ? (ownValue(RAID_HELPER_CLASS, row.class_name) || null) : signUpClassId(row);
    const spec = signUpSpecLabel(row);
    let name;
    // A guest (wave 8: signed up from a guest link, no person) is listed by the character name the guest typed.
    const guest = row.source === 'raidsmith' && row.guest === 1;
    if (guest) name = row.nickname;
    else if (row.source === 'raidsmith') name = shown ? shown.name : null;
    else if (row.player_id && characters.length) name = plannerName(row, characters);
    else name = opts.seeNicknames ? row.nickname : null;
    const group = row.source === 'raid_helper' && row.class_name === 'Tank' ? 'tank' : roleGroup(classId, spec);
    entries.push({
      key: row.player_id ? `p:${row.player_id}` : `x:${row.source}:${row.signup_id}`,
      personId: row.player_id || null,
      source: row.source,
      kind: effectiveKind(row),
      name,
      classId,
      className: classId ? raidHelperClassName(classId) : null,
      spec,
      role: group,
      characterId: chosen ? chosen.id : null,
      note: row.note || null,
      updatedAt: row.updated_at === undefined ? null : row.updated_at,
      matched: !!row.player_id,
      isMe: !!opts.myPlayerId && row.player_id === opts.myPlayerId,
      nickname: opts.seeNicknames && row.source === 'raid_helper' ? row.nickname : null,
      ...(guest ? { guest: true } : {}),
      ...(row.source === 'raidsmith' && row.standing === 1 ? { standing: true } : {}), // made by a standing sign-up and not edited since (the key is only there then)
    });
  }
  const listed = new Set(entries.map((entry) => entry.personId).filter(Boolean));
  for (const { personId } of opts.away || []) {
    if (listed.has(personId)) continue;
    listed.add(personId);
    const shown = displayCharacter(characterRows(personId), opts.teamId);
    const classId = shown ? shown.class : null;
    entries.push({
      key: `a:${personId}`,
      personId,
      source: 'away',
      kind: 'absence',
      name: shown ? shown.name : null,
      classId,
      className: classId ? raidHelperClassName(classId) : null,
      spec: null,
      role: classId ? roleGroup(classId, null) : null,
      characterId: null,
      note: null,
      updatedAt: null,
      matched: true,
      isMe: !!opts.myPlayerId && personId === opts.myPlayerId,
      nickname: null,
    });
  }
  if (opts.notes) {
    for (const entry of entries) {
      const note = entry.personId && entry.source !== 'away' ? opts.notes.get(entry.personId) : null;
      if (note) entry.notice = { kind: note.kind, atTime: note.atTime };
    }
  }
  entries.sort((a, b) => {
    const ar = a.role === null ? 9 : ROLE_ORDER[a.role];
    const br = b.role === null ? 9 : ROLE_ORDER[b.role];
    return ar - br || String(a.classId).localeCompare(String(b.classId)) || String(a.name).localeCompare(String(b.name)) || a.key.localeCompare(b.key);
  });
  return entries;
}

// { signed, late, standby, tentative, bench, absence, expected, byRole, byClass } of a merged list (`signed` leaves the standby people out of it). The
// role and class counts are of the people expected to come (signed + late + standby).
export function countSignups(entries) {
  const counts = { signed: 0, late: 0, standby: 0, tentative: 0, bench: 0, absence: 0, expected: 0, byRole: { tank: 0, healer: 0, melee: 0, ranged: 0, none: 0 }, byClass: {} };
  for (const entry of entries) {
    counts[entry.kind] += 1;
    if (!EXPECTED_KINDS.includes(entry.kind)) continue;
    counts.expected += 1;
    counts.byRole[entry.role || 'none'] += 1;
    if (entry.classId) counts.byClass[entry.classId] = (counts.byClass[entry.classId] || 0) + 1;
  }
  return counts;
}
