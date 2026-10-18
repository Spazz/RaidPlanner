// The weekly raid schedule, the pure half (no I/O): which dates the next N weeks hold for a team's slots and when each starts.
// All date arithmetic is on guild-local YYYY-MM-DD strings (attendance-calendar.js), so a daylight-saving change never moves a raid
// to the wrong day; only localTimeToMs touches an instant, and it knows the time zone.
import { addDays, localTimeToMs, weekdayOf } from './attendance-calendar.js';

export const MAX_SCHEDULE_WEEKS = 8;
export const DEFAULT_SCHEDULE_WEEKS = 2;
export const MAX_SLOTS = 7; // one per weekday: a team has one raid per day
export const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// slots: [{ weekday 0..6, startTime 'HH:MM', zone, title }]; today: the guild's date today; weeks: 1..8.
// -> [{ raidOn, weekday, startsAt | null, zone, title, skip: 'past' | 'no_such_time' | null }] soonest first. The window is `weeks` x 7 days from
// today (today included). 'past': today's slot has already started. 'no_such_time': the wall time does not exist that day (the skipped
// hour when the clocks go forward).
export function planScheduledRaids({ slots, today, weeks, now, timeZone }) {
  const found = [];
  for (let offset = 0; offset < weeks * 7; offset++) {
    const raidOn = addDays(today, offset);
    const weekday = weekdayOf(raidOn);
    for (const slot of slots) {
      if (slot.weekday !== weekday) continue;
      const startsAt = localTimeToMs(raidOn, slot.startTime, timeZone);
      let skip = null;
      if (startsAt === null) skip = 'no_such_time';
      else if (startsAt <= now) skip = 'past';
      found.push({ raidOn, weekday, startsAt, zone: slot.zone || null, title: slot.title || null, skip });
    }
  }
  return found;
}
