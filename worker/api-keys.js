// Read-only API keys (PM wave 7), the shared half: the datasets a key can read, its expiries and limits, the token's shape, and which datasets the built-in
// Member role lets a key read. A key stands in for a MEMBER of its scope (one team or the whole guild): it reads what that member could read, minus notes
// and Discord / account data. The routes are worker/routes/api-keys.js (officers make and turn off keys) and worker/routes/api-v1.js (the data itself).
import { resolveKeyPermissions } from './permissions.js';

const DAY = 24 * 60 * 60 * 1000;

// The datasets, each with the read action the Member role must hold for it.
export const API_DATASETS = Object.freeze({
  roster: Object.freeze({ label: 'Roster', action: 'roster.view' }),
  attendance: Object.freeze({ label: 'Attendance', action: 'attendance.view' }),
  loot: Object.freeze({ label: 'Loot', action: 'loot.view' }),
  raids: Object.freeze({ label: 'Raids', action: 'raids.view' }),
});
export const DATASET_IDS = Object.freeze(Object.keys(API_DATASETS));
export const FORMATS = Object.freeze(['csv', 'json']);

export const KEY_EXPIRES_IN = Object.freeze({ '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY, never: null });
export const KEY_PREFIX = 'rsk_';
export const KEY_PATTERN = /^rsk_[A-Za-z0-9_-]{43}$/;
export const MAX_KEY_NAME = 40;
export const MAX_ACTIVE_KEYS = 20;

// Per key: 60 requests an hour (a spreadsheet re-reads a link about once an hour).
export const KEY_RATE_LIMIT = 60;
export const KEY_RATE_WINDOW_MS = 60 * 60 * 1000;

export const keyStatus = (row, nowMs) => {
  if (row.revoked_at !== null) return 'revoked';
  return row.expires_at !== null && row.expires_at <= nowMs ? 'expired' : 'active';
};

export function parseDatasets(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? DATASET_IDS.filter((id) => list.includes(id)) : [];
  } catch {
    return [];
  }
}

// The Member role's rows in a guild (the guild's edits applied).
export const memberPermissionsStatement = (db, guildId) =>
  db.prepare("SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = 'member'").bind(guildId);

// What a key for this team (null = the whole guild) may read: { action: 'guild' | [teamIds] } (see permissions.js resolveKeyPermissions).
export function keyCan(memberRows, teamId, activeTeamIds) {
  return resolveKeyPermissions(memberRows, { teamId, activeTeamIds });
}

// Which datasets the Member role lets a key read for this scope: { roster: true, ... }.
export function availableDatasets(memberRows, teamId, activeTeamIds) {
  const can = keyCan(memberRows, teamId, activeTeamIds);
  return Object.fromEntries(DATASET_IDS.map((id) => [id, !!can[API_DATASETS[id].action]]));
}
