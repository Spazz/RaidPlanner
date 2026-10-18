// Pure data and rules for the intent board and recruitment needs (no I/O). A pick or a roster main is counted under one of four raid roles.
// roster-data.js knows tank / healer / dps; recruiting also splits DPS into melee and ranged (casters and hunters), as the Planner's roles do
// (melee_dps -> melee; ranged_dps and caster_dps -> ranged). guild-wave3-worker-tests.js pins this against js/rules/catalog.js.
import { CLASS_IDS, ownValue, roleOf } from './roster-data.js';

export const RAID_ROLES = ['tank', 'healer', 'melee', 'ranged'];
export const RAID_ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee DPS', ranged: 'Ranged DPS' };

// The DPS specs that fight in melee; every other DPS spec is ranged.
const MELEE_DPS = {
  WARRIOR: ['Arms', 'Fury'],
  PALADIN: ['Retribution'],
  ROGUE: ['Assassination', 'Combat', 'Subtlety'],
  SHAMAN: ['Enhancement'],
  DRUID: ['Feral (DPS)'],
};

// 'tank' | 'healer' | 'melee' | 'ranged', or null for a class/spec the roster does not know.
export function raidRoleOf(classId, spec) {
  const role = roleOf(classId, spec);
  if (role === 'tank' || role === 'healer') return role;
  if (role !== 'dps') return null;
  const melee = ownValue(MELEE_DPS, classId);
  return melee && melee.includes(spec) ? 'melee' : 'ranged';
}

// How many people a raid of this size wants in each role. These are planning numbers chosen for this tool, not a game rule; an officer
// can set a team's own (teams.recruit_targets).
export const RECRUIT_DEFAULTS = {
  10: { tank: 2, healer: 3, melee: 3, ranged: 2 },
  20: { tank: 2, healer: 5, melee: 7, ranged: 6 },
  25: { tank: 3, healer: 6, melee: 8, ranged: 8 },
  40: { tank: 4, healer: 10, melee: 13, ranged: 13 },
};
export const MAX_TARGET = 99;

export function defaultTargets(size) {
  const found = ownValue(RECRUIT_DEFAULTS, String(size));
  return { ...(found || RECRUIT_DEFAULTS[25]) };
}

// -> { ok: true, value } with the four roles as whole numbers 0..99, or { ok: false, message }.
export function readTargets(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'Send a number for each role.' };
  const value = {};
  for (const role of RAID_ROLES) {
    const n = raw[role];
    if (!Number.isInteger(n) || n < 0 || n > MAX_TARGET) return { ok: false, message: `${RAID_ROLE_LABELS[role]} must be a whole number from 0 to ${MAX_TARGET}.` };
    value[role] = n;
  }
  return { ok: true, value };
}

// The stored JSON (or null) -> the four targets, falling back to the size's defaults for anything that does not read.
export function targetsOf(stored, size) {
  let parsed = null;
  try { parsed = stored ? JSON.parse(stored) : null; } catch { parsed = null; }
  const read = parsed ? readTargets(parsed) : { ok: false };
  return read.ok ? { targets: read.value, custom: true } : { targets: defaultTargets(size), custom: false };
}

// members: [{ class, spec }] -> { counts: { tank, healer, melee, ranged }, unknown } (unknown: no spec, or a spec the roster does not know).
export function countRoles(members) {
  const counts = { tank: 0, healer: 0, melee: 0, ranged: 0 };
  let unknown = 0;
  for (const member of members) {
    const role = member.spec ? raidRoleOf(member.class, member.spec) : null;
    if (role) counts[role] += 1;
    else unknown += 1;
  }
  return { counts, unknown };
}

// Target minus count per role: positive = still needed, negative = more than the target.
export function gapsOf(counts, targets) {
  return Object.fromEntries(RAID_ROLES.map((role) => [role, targets[role] - counts[role]]));
}

// Main picks -> the board's totals: by role, by class, and how many people picked.
export function pickTotals(picks) {
  const byRole = { tank: 0, healer: 0, melee: 0, ranged: 0 };
  const byClass = Object.fromEntries(CLASS_IDS.map((id) => [id, 0]));
  let mains = 0;
  let alts = 0;
  for (const pick of picks) {
    if (pick.kind === 'alt') { alts += 1; continue; }
    mains += 1;
    if (Object.prototype.hasOwnProperty.call(byRole, pick.role)) byRole[pick.role] += 1;
    if (Object.prototype.hasOwnProperty.call(byClass, pick.class)) byClass[pick.class] += 1;
  }
  return { mains, alts, byRole, byClass };
}
