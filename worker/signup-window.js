// A member's sign-up window, the pure half (no I/O): when it closes and why it is closed. A raid's window closes at its start, or earlier when it has a
// deadline: `signup_close_hours` hours before the start, the raid's own number when an officer set one, else its team's. An officer closes it early with
// the lock. Officers (raids.edit) are never bound by any of it. worker/routes/signups.js repeats the same arithmetic in SQL inside every member write
// (WINDOW_OPEN_SQL), so the two must agree: closed when `starts_at - hours * 3600000 <= now`.
// A raids row as these read it: { starts_at, signups_locked, signup_close_hours (the raid's, NULL = the team's), team_close_hours (the team's) }.
//
// A raid with only a date (time_known 0) keeps noon UTC in starts_at, which says nothing about when its members' window closes. Such a raid counts as
// starting at the team's schedule slot time on its weekday, else at 18:00 guild-local (dateOnlyWindow); windowFieldsOf puts that instant on the row as
// `window_starts_at` (and which of the two it was as `window_source`), and every function here and the SQL guard of worker/routes/signups.js read the
// window's start from it, `starts_at` for any other raid.
import { localTimeToMs } from './attendance-calendar.js';

export const MAX_CLOSE_HOURS = 72; // a window closes at most three days before the start
export const HOUR_MS = 3600000;
export const isCloseHours = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_CLOSE_HOURS;

export const DATE_ONLY_CLOSE_TIME = '18:00'; // guild-local: where a raid with only a date closes when its team has no schedule slot on that weekday

// The SQL for the team's schedule slot time on a raid's weekday (raids aliased `r`), or NULL: add `${SLOT_TIME_SQL} AS slot_time` to a raids query.
// team_schedules.weekday counts from 0 = Sunday, like strftime('%w').
export const SLOT_TIME_SQL = "(SELECT s.start_time FROM team_schedules s WHERE s.team_id = r.team_id AND s.weekday = CAST(strftime('%w', r.raid_on) AS INTEGER))";

// Where a date-only raid's window starts: { at (epoch ms), source: 'slot' | 'default' }. slotTime: 'HH:MM' of the team's slot that weekday, or null. A slot
// time that does not exist that day (the skipped hour of a spring-forward day) falls back to the default; null only when even that cannot be placed.
export function dateOnlyWindow(raidOn, slotTime, timeZone) {
  const tries = slotTime ? [['slot', slotTime], ['default', DATE_ONLY_CLOSE_TIME]] : [['default', DATE_ONLY_CLOSE_TIME]];
  for (const [source, time] of tries) {
    let at = null;
    try { at = localTimeToMs(raidOn, time, timeZone); } catch { at = null; }
    if (at !== null) return { at, source };
  }
  return null;
}

// The window fields of a raids row ({ raid_on, time_known, slot_time }) in the guild's time zone: { window_starts_at, window_source }, both null for a raid with a
// start time. Spread them onto the row the window functions read.
export function windowFieldsOf(raid, timeZone) {
  const window = raid.time_known === 0 ? dateOnlyWindow(raid.raid_on, raid.slot_time ?? null, timeZone) : null;
  return { window_starts_at: window ? window.at : null, window_source: window ? window.source : null };
}

// The instant the window counts the raid as starting: its slot time or the default for a raid with only a date, else the raid's start.
export const windowStartOf = (raid) => raid.window_starts_at ?? raid.starts_at;

// The hours before the start at which the window closes: the raid's own, else the team's, else 0 (at the start).
export const closeHoursOf = (raid) => raid.signup_close_hours ?? raid.team_close_hours ?? 0;

// The instant (epoch ms) the window closes: from then on a member cannot write.
export const closesAtOf = (raid, hours = closeHoursOf(raid)) => windowStartOf(raid) - hours * HOUR_MS;

// Why a member cannot change a sign-up on this raid: 'started' | 'locked' | 'deadline' | null (open). The start comes first (nothing else matters once the
// raid is on), then an officer's lock, then the deadline. `hours` is the effective deadline (closeHoursOf(raid) when left out).
export function closedReason(raid, now, hours = closeHoursOf(raid)) {
  if (windowStartOf(raid) <= now) return 'started';
  if (raid.signups_locked === 1) return 'locked';
  if (closesAtOf(raid, hours) <= now) return 'deadline';
  return null;
}
