// A member's sign-up window, the pure half (no I/O): when it closes and why it is closed. A raid's window closes at its start, or earlier when it has a
// deadline: `signup_close_hours` hours before the start, the raid's own number when an officer set one, else its team's. An officer closes it early with
// the lock. Officers (raids.edit) are never bound by any of it. worker/routes/signups.js repeats the same arithmetic in SQL inside every member write
// (WINDOW_OPEN_SQL), so the two must agree: closed when `starts_at - hours * 3600000 <= now`.
// A raids row as these read it: { starts_at, signups_locked, signup_close_hours (the raid's, NULL = the team's), team_close_hours (the team's) }.

export const MAX_CLOSE_HOURS = 72; // a window closes at most three days before the start
export const HOUR_MS = 3600000;
export const isCloseHours = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_CLOSE_HOURS;

// The hours before the start at which the window closes: the raid's own, else the team's, else 0 (at the start).
export const closeHoursOf = (raid) => raid.signup_close_hours ?? raid.team_close_hours ?? 0;

// The instant (epoch ms) the window closes: from then on a member cannot write.
export const closesAtOf = (raid, hours = closeHoursOf(raid)) => raid.starts_at - hours * HOUR_MS;

// Why a member cannot change a sign-up on this raid: 'started' | 'locked' | 'deadline' | null (open). The start comes first (nothing else matters once the
// raid is on), then an officer's lock, then the deadline. `hours` is the effective deadline (closeHoursOf(raid) when left out).
export function closedReason(raid, now, hours = closeHoursOf(raid)) {
  if (raid.starts_at <= now) return 'started';
  if (raid.signups_locked === 1) return 'locked';
  if (closesAtOf(raid, hours) <= now) return 'deadline';
  return null;
}
