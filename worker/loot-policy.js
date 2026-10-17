// Loot policy (pure): the defaults, the validation of an override object and the merge of guild and team overrides.
// Same model as attendance-policy.js: a stored policy is an OVERRIDE (only the keys set at that level); the resolved policy is
// DEFAULT_LOOT_POLICY <- guild override <- team override, merged per key (arrays replace). Nothing here reads a clock or D1.
import { clone, deepFreeze, isPlainObject, mergeInto, oneOf, walk } from './attendance-policy.js';

// The tag an award carries. DE and Bank are set by hand; MS and OS are what an import assigns.
export const LOOT_TAGS = Object.freeze(['MS', 'OS', 'DE', 'BANK']);
// The tags a balance may count (DE and Bank are never a player's gear).
export const COUNT_TAGS = Object.freeze(['MS', 'OS']);

export const DEFAULT_LOOT_POLICY = deepFreeze({
  visibility: { members: 'ownTeams' },
  balance: { mode: 'perRaid', countTags: ['MS'] },
});

function checkCountTags(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > COUNT_TAGS.length) return `must be a list of at least one of: ${COUNT_TAGS.join(', ')}`;
  const seen = new Set();
  for (const entry of value) {
    if (!COUNT_TAGS.includes(entry)) return `must only contain: ${COUNT_TAGS.join(', ')}`;
    if (seen.has(entry)) return 'must not repeat a tag';
    seen.add(entry);
  }
  return null;
}

// The schema: a function is a leaf validator (returns an error message or null), an object is a nested section.
const SCHEMA = {
  visibility: { members: oneOf(['own', 'ownTeams', 'guild']) },
  balance: { mode: oneOf(['perRaid', 'count']), countTags: checkCountTags },
};

// Checks an override object (unknown keys, other values, an empty or foreign countTags are rejected).
// scope: 'guild' | 'team' (both take the same keys). Returns { ok, errors: [{ path, message }] }; the first error's path is the field the route names.
export function validateLootOverride(override, scope = 'guild') {
  if (!isPlainObject(override)) return { ok: false, errors: [{ path: '', message: 'policy must be an object' }] };
  if (scope !== 'guild' && scope !== 'team') return { ok: false, errors: [{ path: '', message: 'scope must be guild or team' }] };
  const errors = [];
  walk(SCHEMA, override, '', errors);
  return { ok: errors.length === 0, errors };
}

// DEFAULT_LOOT_POLICY <- guild override <- team override. Pass null / undefined for a missing level. A fresh object.
export function resolveLootPolicy(guildOverride, teamOverride) {
  const resolved = clone(DEFAULT_LOOT_POLICY);
  if (isPlainObject(guildOverride)) mergeInto(resolved, guildOverride);
  if (isPlainObject(teamOverride)) mergeInto(resolved, teamOverride);
  return resolved;
}
