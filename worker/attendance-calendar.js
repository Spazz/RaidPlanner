// Attendance calendar helpers (pure). Raid dates are guild-local calendar dates, TEXT YYYY-MM-DD; all date
// arithmetic here works on those strings in UTC, so it never depends on the machine's time zone or a DST change.
// Only localDate() touches an instant, and it needs the guild's time zone to say which local day it falls on.

const DAY_MS = 86400000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toDayNumber(date) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new RangeError(`not a real date: ${date}`);
  return time / DAY_MS;
}

function fromDayNumber(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

// The guild-local date (YYYY-MM-DD) of an instant (epoch ms) in an IANA time zone.
export function localDate(ms, timeZone) {
  if (!Number.isFinite(ms)) throw new RangeError('localDate needs an epoch ms');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

// date + days (negative goes back).
export function addDays(date, days) {
  return fromDayNumber(toDayNumber(date) + days);
}

// to - from, in whole days.
export function daysBetween(from, to) {
  return toDayNumber(to) - toDayNumber(from);
}

// 0 = Sunday ... 6 = Saturday.
export function weekdayOf(date) {
  return (((toDayNumber(date) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)
}

// The reset week a date belongs to, named by its first day: the date of `resetDay` (0 = Sunday ... 6) on or before it.
export function weekStart(date, resetDay) {
  if (!Number.isInteger(resetDay) || resetDay < 0 || resetDay > 6) throw new RangeError('resetDay must be 0..6');
  const back = (weekdayOf(date) - resetDay + 7) % 7;
  return addDays(date, -back);
}
