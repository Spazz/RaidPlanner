// Attendance policy (pure): the defaults, the validation of an override object, the merge of guild and team
// overrides, the fingerprint of the keys that change stored results, and the outcome / flag / letter tables.
// A stored policy is an OVERRIDE (only the keys set at that level); the resolved policy is DEFAULT_POLICY <- guild
// override <- team override, merged per key (arrays replace). Nothing here reads a clock, D1 or the network.

const STATUSES = ['raider', 'trial', 'reserve'];

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_POLICY = deepFreeze({
  expected: { mode: 'signedUp', statuses: ['raider', 'trial'] },
  noSignup: 'shown',
  tentative: 'asNoSignup',
  absence: 'missedWithNotice',
  bench: 'full',
  lateSignup: 'fullCreditNoFlag',
  detection: { mode: 'pulls' },
  credit: {
    values: [
      { id: 'full', label: 'Full', value: 1 },
      { id: 'half', label: 'Half', value: 0.5 },
      { id: 'none', label: 'None', value: 0 },
    ],
  },
  fillIn: 'always',
  window: { defaultWeeks: 8, switchWeeks: [8, 12] },
  effectiveStart: 'laterOfJoinAndFirst',
  streakFlagAt: 4,
  resetDay: null,
  // The watch list on the team attendance page: below = flag a rolling % under this fraction, dropBy = flag a fall of this fraction against
  // the previous window of the same length. Each is a fraction 0..1, or null for off. Read live, so no raid ever goes stale over it.
  watch: { below: 0.75, dropBy: 0.15 },
});

// Reset day (0 = Sunday) by region: US Tuesday, EU Wednesday. KR / TW Thursday are unverified (spec, resolved item 8).
export const REGION_RESET_DAY = Object.freeze({ US: 2, EU: 3, KR: 4, TW: 4 });
const FALLBACK_RESET_DAY = REGION_RESET_DAY.US;

// ---------------------------------------------------------------------------
// Outcomes, flags, letters

// Every outcome a row can carry. letter: the grid cell; fixedCredit: the credit the outcome always has
// (null = decided by an officer or not counted).
export const OUTCOMES = Object.freeze({
  present: Object.freeze({ letter: 'P', label: 'Present', fixedCredit: 1 }),
  bench: Object.freeze({ letter: 'B', label: 'Bench', fixedCredit: 1 }),
  missed: Object.freeze({ letter: 'M', label: 'Missed', fixedCredit: 0 }),
  missed_notice: Object.freeze({ letter: 'N', label: 'Missed with notice', fixedCredit: 0 }),
  late: Object.freeze({ letter: 'L', label: 'Late', fixedCredit: null }),
  left_early: Object.freeze({ letter: 'E', label: 'Left early', fixedCredit: null }),
  late_left: Object.freeze({ letter: 'LE', label: 'Late and left early', fixedCredit: null }),
  fill_in: Object.freeze({ letter: 'F', label: 'Other team', fixedCredit: 1 }),
  tentative: Object.freeze({ letter: 'T', label: 'Tentative', fixedCredit: null }),
  no_signup: Object.freeze({ letter: '-', label: 'No sign-up', fixedCredit: null }),
});
export const OUTCOME_IDS = Object.freeze(Object.keys(OUTCOMES));
export const LETTERS = Object.freeze(Object.fromEntries(OUTCOME_IDS.map((id) => [id, OUTCOMES[id].letter])));
// Outcomes whose credit an officer picks from the policy's credit values.
export const CREDIT_PICK_OUTCOMES = Object.freeze(['late', 'left_early', 'late_left']);

// Person-row flags (no_show, late, left_early) and the raid-level flag (unmatched).
export const FLAG_TYPES = Object.freeze(['no_show', 'late', 'left_early', 'unmatched']);

// The outcomes an officer may decide a row into, given the row's current flags (spec, "Officer decisions").
// no_show -> missed, missed_notice, bench, present; late / left_early -> the matching outcome or present;
// no flags -> an override among the fixed-credit person outcomes.
export function decisionOutcomesFor(flags) {
  const set = new Set(Array.isArray(flags) ? flags : []);
  if (set.has('no_show')) return ['missed', 'missed_notice', 'bench', 'present'];
  if (set.has('late') && set.has('left_early')) return ['late_left', 'present'];
  if (set.has('late')) return ['late', 'present'];
  if (set.has('left_early')) return ['left_early', 'present'];
  return ['present', 'bench', 'missed', 'missed_notice'];
}

// ---------------------------------------------------------------------------
// Validation

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWeeks = (value) => Number.isInteger(value) && value >= 1 && value <= 52;
export const oneOf = (allowed, reserved = []) => (value) => {
  if (typeof value !== 'string') return `must be one of: ${allowed.join(', ')}`;
  if (reserved.includes(value)) return `"${value}" is reserved and not built yet`;
  return allowed.includes(value) ? null : `must be one of: ${allowed.join(', ')}`;
};

function checkStatuses(value) {
  if (!Array.isArray(value) || value.length > STATUSES.length) return `must be a list of: ${STATUSES.join(', ')}`;
  const seen = new Set();
  for (const entry of value) {
    if (!STATUSES.includes(entry)) return `must only contain: ${STATUSES.join(', ')}`;
    if (seen.has(entry)) return 'must not repeat a status';
    seen.add(entry);
  }
  return null;
}

function checkCreditValues(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) return 'must be a list of 2 to 5 credit values';
  const ids = new Set();
  for (const entry of value) {
    if (!isPlainObject(entry)) return 'each entry must be { id, label, value }';
    for (const key of Object.keys(entry)) if (!['id', 'label', 'value'].includes(key)) return `unknown key "${key}" in a credit value`;
    if (typeof entry.id !== 'string' || !/^[a-z]{2,12}$/.test(entry.id)) return 'id must be 2 to 12 lower-case letters';
    if (ids.has(entry.id)) return 'ids must be unique';
    ids.add(entry.id);
    // The rule http.js cleanText applies to every other piece of officer text: trimmed, 1 to 12 characters, no control characters.
    if (typeof entry.label !== 'string') return 'label must be 1 to 12 characters';
    const label = entry.label.trim();
    const labelLength = Array.from(label).length;
    if (labelLength < 1 || labelLength > 12 || /[\u0000-\u001f\u007f]/.test(label)) return 'label must be 1 to 12 characters of plain text';
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value < 0 || entry.value > 1) return 'value must be a number from 0 to 1';
  }
  return null;
}

function checkSwitchWeeks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return 'must be a list of 1 to 3 week counts';
  if (!value.every(isWeeks)) return 'each week count must be a whole number from 1 to 52';
  if (new Set(value).size !== value.length) return 'must not repeat a week count';
  return null;
}

// A watch threshold: null (off) or a fraction from 0 to 1 with at most three decimals (75.5% is 0.755).
function checkWatchFraction(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return 'must be a number from 0 to 1, or null to turn it off';
  return Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-9 ? null : 'must have at most three decimals';
}

// The schema: a function is a leaf validator (returns an error message or null), an object is a nested section.
const SCHEMA = {
  expected: { mode: oneOf(['signedUp', 'statuses']), statuses: checkStatuses },
  noSignup: oneOf(['shown', 'hidden']),
  tentative: oneOf(['asNoSignup', 'asSignedUp']),
  absence: oneOf(['missedWithNotice', 'excused']),
  bench: oneOf(['full', 'excluded']),
  lateSignup: oneOf(['fullCreditNoFlag', 'flagLikeOthers']),
  detection: { mode: oneOf(['pulls'], ['kills', 'share', 'minutes']) },
  credit: { values: checkCreditValues },
  fillIn: oneOf(['always', 'homeIfNoRaid', 'recordOnly']),
  window: {
    defaultWeeks: (value) => (isWeeks(value) ? null : 'must be a whole number from 1 to 52'),
    switchWeeks: checkSwitchWeeks,
  },
  effectiveStart: oneOf(['laterOfJoinAndFirst', 'joinDate']),
  streakFlagAt: (value) => (Number.isInteger(value) && value >= 0 && value <= 20 ? null : 'must be a whole number from 0 (off) to 20'),
  resetDay: (value) => (value === null || (Number.isInteger(value) && value >= 0 && value <= 6) ? null : 'must be null (from the region) or a whole number from 0 (Sunday) to 6'),
  watch: { below: checkWatchFraction, dropBy: checkWatchFraction },
};

export function walk(schema, value, path, errors) {
  for (const key of Object.keys(value)) {
    const here = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      errors.push({ path: here, message: 'unknown setting' });
      continue;
    }
    const rule = schema[key];
    if (typeof rule === 'function') {
      const message = rule(value[key]);
      if (message) errors.push({ path: here, message });
    } else if (!isPlainObject(value[key])) {
      errors.push({ path: here, message: 'must be an object' });
    } else {
      walk(rule, value[key], here, errors);
    }
  }
}

// Checks an override object. scope: 'guild' | 'team' (a team override may not carry resetDay). base: the policy this
// override sits on (default DEFAULT_POLICY), used for the cross-key rule that switchWeeks includes defaultWeeks.
// Returns { ok, errors: [{ path, message }] }; the first error's path is the field the route names.
export function validateOverride(override, scope = 'guild', base = DEFAULT_POLICY) {
  if (!isPlainObject(override)) return { ok: false, errors: [{ path: '', message: 'policy must be an object' }] };
  if (scope !== 'guild' && scope !== 'team') return { ok: false, errors: [{ path: '', message: 'scope must be guild or team' }] };
  let errors = [];
  walk(SCHEMA, override, '', errors);
  if (scope === 'team' && Object.prototype.hasOwnProperty.call(override, 'resetDay')) {
    errors = errors.filter((error) => error.path !== 'resetDay');
    errors.push({ path: 'resetDay', message: 'the reset day is set for the whole guild, not per team' });
  }
  if (!errors.some((error) => error.path.startsWith('window.'))) {
    const windowOverride = isPlainObject(override.window) ? override.window : {};
    const baseWindow = base && isPlainObject(base.window) ? base.window : DEFAULT_POLICY.window;
    const defaultWeeks = windowOverride.defaultWeeks !== undefined ? windowOverride.defaultWeeks : baseWindow.defaultWeeks;
    const switchWeeks = windowOverride.switchWeeks !== undefined ? windowOverride.switchWeeks : baseWindow.switchWeeks;
    if ((windowOverride.defaultWeeks !== undefined || windowOverride.switchWeeks !== undefined) && !switchWeeks.includes(defaultWeeks)) {
      errors.push({ path: windowOverride.switchWeeks !== undefined ? 'window.switchWeeks' : 'window.defaultWeeks', message: 'the window switch must include the default window' });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Resolve and fingerprint

export function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)]));
  return value;
}

export function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}

// The reset day the region implies (what the settings page shows next to "from region").
export function regionResetDay(region) {
  return Object.prototype.hasOwnProperty.call(REGION_RESET_DAY, region) ? REGION_RESET_DAY[region] : FALLBACK_RESET_DAY;
}

// DEFAULT_POLICY <- guild override <- team override. Pass null / undefined for a missing level. The result is a fresh
// object whose resetDay is always a number (the guild's override, else the region's day).
export function resolvePolicy(guildOverride, teamOverride, region) {
  const resolved = clone(DEFAULT_POLICY);
  if (isPlainObject(guildOverride)) mergeInto(resolved, guildOverride);
  if (isPlainObject(teamOverride)) {
    const { resetDay, ...rest } = teamOverride; // a team override never moves the reset day
    mergeInto(resolved, rest);
  }
  if (resolved.resetDay === null || resolved.resetDay === undefined) resolved.resetDay = regionResetDay(region);
  return resolved;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// 8 hex characters (FNV-1a, 32 bit) of the keys that change stored outcomes. window, effectiveStart and streakFlagAt
// are read live and never make a raid stale.
export function consolidationFingerprint(resolved) {
  const picked = {
    expected: resolved.expected,
    noSignup: resolved.noSignup,
    tentative: resolved.tentative,
    absence: resolved.absence,
    bench: resolved.bench,
    lateSignup: resolved.lateSignup,
    detection: resolved.detection,
    creditValues: resolved.credit && resolved.credit.values,
    fillIn: resolved.fillIn,
    resetDay: resolved.resetDay,
  };
  const text = canonical(picked);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
