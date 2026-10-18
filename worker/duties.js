// Raid duties (wave 8): who leads, who masters the loot, who uploads the log, who makes the plan - set by an officer per raid, shown on the raid page
// and in the Discord roster post. Four fixed duties plus one free-text extra. The pure half (the rules, the sentences) and the reads; the routes are
// worker/routes/duties.js. The log nudge (a Logger who has not uploaded a log) is worked out here too: when it is due and what it says.
import { HttpError } from './http.js';
import { isId } from './ids.js';
import { MULTI_LINE_STRIP } from './roster-data.js';

export const FIXED_DUTIES = Object.freeze([
  { id: 'leader', label: 'Raid leader' },
  { id: 'loot', label: 'Loot master' },
  { id: 'logger', label: 'Logger' },
  { id: 'planner', label: 'Plan maker' },
]);
export const EXTRA_DUTY = 'extra';
export const EXTRA_LABEL_MAX = 40;
const ORDER = [...FIXED_DUTIES.map((duty) => duty.id), EXTRA_DUTY];
const FIXED_LABEL = Object.fromEntries(FIXED_DUTIES.map((duty) => [duty.id, duty.label]));

// A raid is expected to run about three hours; the Logger gets two more before anyone is nudged. Raids older than the look-back are not nudged at all.
export const RAID_DURATION_HOURS = 3;
export const LOG_GRACE_HOURS = 2;
export const LOG_NUDGE_LOOKBACK_DAYS = 7;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
export const logDueAt = (startsAt) => startsAt + (RAID_DURATION_HOURS + LOG_GRACE_HOURS) * HOUR_MS;

const invalid = (message, field = 'duties') => new HttpError(400, 'bad_request', message, { field });

// The body's duties -> [{ duty, personId, label | null }] in display order. [] clears every duty. A duty named twice, an unknown duty or an 'extra' without words is a 400.
export function readDuties(list) {
  if (!Array.isArray(list)) throw invalid('Send the duties as a list.');
  if (list.length > ORDER.length) throw invalid(`A raid has at most ${ORDER.length} duties.`);
  const seen = new Set();
  const rows = list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('Each duty must be an object.');
    if (typeof entry.duty !== 'string' || !ORDER.includes(entry.duty)) throw invalid('Pick Raid leader, Loot master, Logger, Plan maker or your own duty.');
    if (seen.has(entry.duty)) throw invalid('Each duty goes to one person.');
    seen.add(entry.duty);
    if (!isId('p', entry.personId)) throw invalid('Pick a person for each duty.');
    let label = null;
    if (entry.duty === EXTRA_DUTY) {
      const text = typeof entry.label === 'string' ? entry.label.replace(MULTI_LINE_STRIP, ' ').replace(/\s+/g, ' ').trim() : '';
      const length = Array.from(text).length;
      if (length < 1 || length > EXTRA_LABEL_MAX) throw invalid(`Name your own duty in 1 to ${EXTRA_LABEL_MAX} characters.`);
      label = text;
    } else if (entry.label !== undefined && entry.label !== null) {
      throw invalid('Only your own duty has a name.');
    }
    return { duty: entry.duty, personId: entry.personId, label };
  });
  return rows.sort((a, b) => ORDER.indexOf(a.duty) - ORDER.indexOf(b.duty));
}

// The shown name of a duty: "Logger", or the officer's own words for the extra.
export const dutyLabel = (row) => (row.duty === EXTRA_DUTY ? row.label : FIXED_LABEL[row.duty] || row.duty);

// Rows of raid_duties joined with a name (raid_id, duty, player_id, label, name, class) -> [{ duty, label, personId, name, class }] in display order.
export function dutiesView(rows) {
  return [...rows]
    .sort((a, b) => ORDER.indexOf(a.duty) - ORDER.indexOf(b.duty))
    .map((row) => ({ duty: row.duty, label: dutyLabel(row), personId: row.player_id, name: row.name || 'Unknown', class: row.class || null }));
}

// "Raid leader: Aldric - Loot master: Brenna": the one line the raid page header and the roster post carry. '' without duties.
export function dutiesLine(view, separator = ' - ') {
  return view.map((entry) => `${entry.label}: ${entry.name}`).join(separator);
}

// The SQL that reads the duties of a raid with the name each person goes by on the raid's team (their character there, Main first). Bound (guildId, raidId).
export const DUTIES_SQL = `SELECT d.raid_id, d.duty, d.player_id, d.label,
    (SELECT c.name FROM characters c WHERE c.player_id = d.player_id ORDER BY c.is_main DESC, c.name_key LIMIT 1) AS name,
    (SELECT c.class FROM characters c WHERE c.player_id = d.player_id ORDER BY c.is_main DESC, c.name_key LIMIT 1) AS class
  FROM raid_duties d JOIN raids r ON r.id = d.raid_id AND r.guild_id = d.guild_id
  WHERE d.guild_id = ?1 AND d.raid_id = ?2`;

export async function loadDuties(db, guildId, raidId) {
  const result = await db.prepare(DUTIES_SQL).bind(guildId, raidId).all();
  return dutiesView(result.results);
}

// Whether a raid's log is overdue (the nudge and Needs attention): it has started, it is not a hand-entered raid, it has no report, and the Logger's time is up.
// raid: { starts_at, time_known, log_mode, reports }
export function logOverdue(raid, nowMs) {
  if (raid.time_known === 0 || raid.log_mode === 'manual' || raid.reports > 0) return false;
  return nowMs >= logDueAt(raid.starts_at) && nowMs < raid.starts_at + LOG_NUDGE_LOOKBACK_DAYS * DAY_MS;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'Tue Oct 21' for a guild-local YYYY-MM-DD (calendar arithmetic only, no time zone).
export function shortDay(raidOn) {
  const at = Date.parse(`${raidOn}T00:00:00Z`);
  if (!Number.isFinite(at)) return String(raidOn);
  const date = new Date(at);
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export const nudgeText = (raidOn) => `Upload the log for ${shortDay(raidOn)}`;
