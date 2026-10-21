// The Planner plan of a guild raid, stored whole (migration 0027, raid_plan_doc). The pure half: the validator, the fingerprint of what the raid page
// reads, and the projection of the plan into the old raid_plan rows / plan_label. No I/O. tasks/open/guild-plans-db-plan.md sections 2 and 3.
//
// planShapeProblem is js/storage.js PlanStore.valid, clause for clause (tests/guild/guild-plandoc-parity-tests.js runs both over shared fixtures and
// pins VERSION_RAIDS to GameVersions[].raids). The limits and the identity rules on top of it are the server's own.
import { cleanCharacterName, nameKey, realmKey, SINGLE_LINE_STRIP } from './roster-data.js';
import { resolveName } from './name-resolve.js';

export const PLAN_DOC_SCHEMA = 1; // PlanStore.schemaVersion
export const PLAN_DOC_MAX_CHARS = 262144; // the CHECK on raid_plan_doc.data
export const PLAN_DOC_MAX_BODY = PLAN_DOC_MAX_CHARS + 2048; // the PUT body: the plan plus {baseRev, schemaVersion, source}
export const MAX_DOC_GROUPS = 8;
export const MAX_DOC_PLAYERS = 200;
export const MAX_PROJECTED_PLAYERS = 80; // the old raid_plan cap (readPlan)
export const PLAN_LABEL_MAX = 80;
export const AUDIT_EDIT_WINDOW_MS = 30 * 60 * 1000; // one Activity-log row per actor per raid per half hour of editing
export const PLAN_SOURCES = ['planner', 'local', 'live', 'legacy', 'signups']; // where the first write of a raid's plan came from (audit after.source)

// The Planner's raid keys per game version (js/rules/*.js via GameVersions[version].raids).
export const VERSION_RAIDS = {
  tbc: ['kara', 'gruul', 'mag', 'ssc', 'tk', 'za', 'hyjal', 'bt', 'swp'],
  classic: ['mc', 'ony', 'bwl', 'zg', 'aq20', 'aq40', 'naxx', 'classic10', 'classic20', 'classic40'],
  forever: ['f_barrow', 'f_hyjal', 'f_ony', 'forever10', 'forever20', 'forever40'],
};
// Retired strategies still validate (old plans and links name them); the Planner runs Max DPS regardless (PlanStore.valid).
const OPTIMIZER_MODES = ['max_dps', 'tank_mit', 'balanced', 'relaxed'];

// String caps (characters). Generous: they exist to refuse junk, not to trim a real plan.
const MAX_NOTES = 2000;
const MAX_ROSTER_NAME = 300;
const MAX_UID = 80;
const MAX_PLAYER_NAME = 80;
const MAX_PLAYER_TEXT = 60; // class, spec, role

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const problem = (field, message) => ({ field, message });

// The version a plan belongs to: its own gameVersion, else the one that owns its raid, else TBC (PlanStore.valid).
function effectiveVersion(data) {
  if (data.gameVersion) return data.gameVersion;
  const owner = Object.keys(VERSION_RAIDS).find((version) => VERSION_RAIDS[version].includes(data.selectedRaid));
  return owner || 'tbc';
}

const seatedPlayerOk = (p) => p && typeof p.uid === 'string' && typeof p.name === 'string' && typeof p.class === 'string'
  && typeof p.spec === 'string' && typeof p.role === 'string';

// PlanStore.valid, as a reason: null when the plan has the shape the Planner reads, else the first field that does not.
export function planShapeProblem(data) {
  if (!data || typeof data.planId !== 'string') return problem('planId', 'The plan needs a planId.');
  const version = effectiveVersion(data);
  if (!has(VERSION_RAIDS, version) || !VERSION_RAIDS[version].includes(data.selectedRaid)) {
    return problem('selectedRaid', 'The plan names a raid its game version does not have.');
  }
  if (typeof data.rosterName !== 'string') return problem('rosterName', 'The plan needs a name.');
  if (!Array.isArray(data.groups) || !data.groups.every(Array.isArray)) return problem('groups', 'groups must be a list of lists.');
  if (!OPTIMIZER_MODES.includes(data.optimizerMode)) return problem('optimizerMode', 'Unknown optimizer mode.');
  if (data.notes !== undefined && typeof data.notes !== 'string') return problem('notes', 'notes must be text.');
  if (data.sizeBenched !== undefined && !Array.isArray(data.sizeBenched)) return problem('sizeBenched', 'sizeBenched must be a list.');
  if (data.backups !== undefined && !isPlainObject(data.backups)) return problem('backups', 'backups must be an object.');
  if (data.playerConstraints !== undefined && !Array.isArray(data.playerConstraints)) return problem('playerConstraints', 'playerConstraints must be a list.');
  if (data.drummers !== undefined && !Array.isArray(data.drummers)) return problem('drummers', 'drummers must be a list.');
  if (data.unplaced !== undefined && !Array.isArray(data.unplaced)) return problem('unplaced', 'unplaced must be a list.');
  if (!isPlainObject(data.buffOverrides)) return problem('buffOverrides', 'buffOverrides must be an object.');
  if (!Array.isArray(data.bench)) return problem('bench', 'bench must be a list.');
  if (![...data.groups.flat(), ...data.bench].every(seatedPlayerOk)) return problem('players', 'Every player needs a uid, name, class, spec and role.');
  return null;
}

// The server's limits on a plan that has the right shape.
function planLimitProblem(data) {
  if (data.groups.length > MAX_DOC_GROUPS) return problem('groups', `A plan has at most ${MAX_DOC_GROUPS} groups.`);
  const players = [...data.groups.flat(), ...data.bench];
  if (players.length + (Array.isArray(data.unplaced) ? data.unplaced.length : 0) > MAX_DOC_PLAYERS) {
    return problem('players', `A plan holds at most ${MAX_DOC_PLAYERS} players.`);
  }
  const long = (text, max) => text.length > max;
  if (players.some((p) => long(p.uid, MAX_UID) || long(p.name, MAX_PLAYER_NAME) || long(p.class, MAX_PLAYER_TEXT) || long(p.spec, MAX_PLAYER_TEXT) || long(p.role, MAX_PLAYER_TEXT))) {
    return problem('players', 'A player field is too long.');
  }
  if (long(data.rosterName, MAX_ROSTER_NAME)) return problem('rosterName', `The plan name is at most ${MAX_ROSTER_NAME} characters.`);
  if (typeof data.notes === 'string' && long(data.notes, MAX_NOTES)) return problem('notes', `Notes are at most ${MAX_NOTES} characters.`);
  return null;
}

// Whether `plan` may be stored as the plan of raid `raidId` in a guild on `gameVersion`: null, or { field, message } for the 400 plan_invalid.
export function planDocProblem(plan, { raidId, gameVersion }) {
  if (!isPlainObject(plan)) return problem('plan', 'plan must be an object.');
  const shape = planShapeProblem(plan);
  if (shape) return shape;
  if (plan.planId !== `raid:${raidId}`) return problem('planId', 'The plan belongs to another raid.');
  if (plan.gameVersion !== gameVersion) return problem('gameVersion', "The plan is for another game version than the guild's.");
  return planLimitProblem(plan);
}

// cyrb53: 53 bits of a string, enough that two different line-ups never share a fingerprint in practice.
function hash53(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const seatsOf = (plan) => {
  const seats = [];
  plan.groups.forEach((group, index) => { for (const p of group) seats.push({ name: p.name, group: index + 1 }); });
  for (const p of plan.bench) seats.push({ name: p.name, group: 0 });
  return seats;
};

// What the raid page and attendance read from a plan: its name and who sits in which group (bench = 0). Order inside a group does not count, so
// shuffling a group never re-projects. Everything else in the plan (buffs, notes, assignments) is not part of the line-up.
export function lineupFp(plan) {
  const entries = seatsOf(plan).map((seat) => `${seat.group}|${seat.name.trim().toLowerCase()}`).sort();
  return hash53(`${plan.rosterName.trim()}\n${entries.join('\n')}`);
}

const labelOf = (plan) => Array.from(plan.rosterName.replace(SINGLE_LINE_STRIP, '').trim()).slice(0, PLAN_LABEL_MAX).join('') || 'Raid plan';

// The plan as the old readers see it: { label, rows: [{ name, nameKey, group }], seated }. Groups become 1..n, the bench 0, unplaced players are left
// out; names are cleaned like the legacy PUT cleans them, a name that does not clean or repeats is skipped (the seat wins over the bench), 80 at most.
// `seated` counts the players in a group; a plan nobody sits in projects as no plan at all (label null, no rows).
// guild: { game_version, realm, realm_kind }; surnames: loadSurnameIndex's result.
export function projectPlan(plan, guild, surnames) {
  const realm = guild.realm_kind !== 'ruleset' ? realmKey(guild.realm) : '';
  const seen = new Set();
  const rows = [];
  let seated = 0;
  for (const seat of seatsOf(plan)) {
    if (rows.length >= MAX_PROJECTED_PLAYERS) break;
    const cleaned = cleanCharacterName(seat.name, guild.game_version);
    if (!cleaned) continue;
    const name = resolveName(surnames, cleaned, realm);
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, nameKey: key, group: seat.group });
    if (seat.group > 0) seated++;
  }
  if (seated === 0) return { label: null, rows: [], seated: 0 };
  return { label: labelOf(plan), rows, seated };
}
