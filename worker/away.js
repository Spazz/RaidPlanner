// Away notices, the pure half (no I/O, no clock): which raid dates a notice covers, what the notices of a guild do to one raid (who is Away, who is
// Late or Leaving early), the people an attendance recompute counts as "away with notice", and the checks of what a person or an officer may write.
// worker/routes/away.js reads and writes the rows and calls these. Dates are guild-local YYYY-MM-DD strings (they compare as text); all date
// arithmetic goes through worker/attendance-calendar.js, which works on the calendar and never on a machine's time zone.
//
// A notice is { from, to, weekday }: a RANGE (weekday null) covers every date from `from` to `to`; a RECURRING notice (weekday 0 = Sunday ... 6) covers
// every such weekday from `from` to `to`, `to` null = open-ended. Kinds: 'away' (the whole raid), 'late' and 'leaving' (the time they arrive / leave).
import { addDays, daysBetween, weekdayOf } from './attendance-calendar.js';
import { isGoneOn } from './person-rank.js';
import { SINGLE_LINE_STRIP, isRealDate } from './roster-data.js';

export const AWAY_KINDS = ['away', 'late', 'leaving'];
export const MAX_NOTICES = 30;        // per person, counting only the notices that are current or still ahead (countsTowardCap)
export const MAX_RANGE_DAYS = 366;    // a date range ends at most this many days after it starts
export const REASON_MAX = 120;
export const TEAM_WINDOW_DAYS = 28;   // the officers' "Away" list: the next four weeks
export const EARLIEST_DATE = '2004-11-23'; // World of Warcraft's release: an officer cannot date a notice before it
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// A away_notices row -> the notice the pure functions read: { id, personId, kind, atTime, from, to, weekday, createdAt }.
export const noticeOfRow = (row) => ({
  id: row.id,
  personId: row.player_id,
  kind: row.kind,
  atTime: row.at_time ?? null,
  from: row.starts_on,
  to: row.ends_on ?? null,
  weekday: row.weekday ?? null,
  createdAt: row.created_at ?? null,
});

// ---------------------------------------------------------------------------
// Coverage

// True when the notice covers the guild-local date `raidOn`.
export function noticeCovers(notice, raidOn) {
  if (typeof raidOn !== 'string' || raidOn < notice.from) return false;
  const to = notice.to ?? null;
  if (notice.weekday === null || notice.weekday === undefined) return to === null ? raidOn === notice.from : raidOn <= to; // a range has an end; without one only its first day
  if (to !== null && raidOn > to) return false;
  return weekdayOf(raidOn) === notice.weekday;
}

// Whether the notice counts toward the per-person cap (MAX_NOTICES) on the guild-local date `today`: while it is current or still ahead. A repeating
// notice with no end always is; any other ends on its last day (`to`, else its first day), and one that ended before today no longer counts.
// routes/away.js repeats this in SQL (COUNTS_TOWARD_CAP_SQL), so the two must agree.
export function countsTowardCap(notice, today) {
  const to = notice.to ?? null;
  if (notice.weekday !== null && notice.weekday !== undefined && to === null) return true;
  return (to ?? notice.from) >= today;
}

// The notices of a list that cover `raidOn`.
export const coveringNotices = (notices, raidOn) => notices.filter((notice) => noticeCovers(notice, raidOn));

// The dates from windowFrom to windowTo (inclusive) that the notice covers, oldest first, at most `cap`.
export function coveredDates(notice, windowFrom, windowTo, cap = TEAM_WINDOW_DAYS) {
  const dates = [];
  for (let day = windowFrom > notice.from ? windowFrom : notice.from; day <= windowTo && dates.length < cap; day = addDays(day, 1)) {
    if (notice.to !== null && day > notice.to) break;
    if (noticeCovers(notice, day)) dates.push(day);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// The effects on one raid

const KIND_ORDER = { late: 0, leaving: 1 };

// What the notices do to one raid on `raidOn`. notices: [{ id, personId, kind, atTime, from, to, weekday }] of any people; eligible: a Set of the person ids
// with a character on the raid's team who are not inactive (nobody else is affected). ->
//   away  [{ personId, noticeId }]  everyone an Away notice covers, sorted by person id (the first notice by id when several)
//   notes Map personId -> { kind, atTime, noticeId }  the Late / Leaving notice that covers them (a Late one before a Leaving one, then the earlier time)
export function raidNoticeEffects(notices, raidOn, eligible) {
  const away = new Map();
  const notes = new Map();
  for (const notice of notices) {
    if (!eligible.has(notice.personId) || !noticeCovers(notice, raidOn)) continue;
    if (notice.kind === 'away') {
      const have = away.get(notice.personId);
      if (!have || notice.id < have.noticeId) away.set(notice.personId, { personId: notice.personId, noticeId: notice.id });
      continue;
    }
    const have = notes.get(notice.personId);
    const better = !have || KIND_ORDER[notice.kind] < KIND_ORDER[have.kind]
      || (notice.kind === have.kind && (notice.atTime < have.atTime || (notice.atTime === have.atTime && notice.id < have.noticeId)));
    if (better) notes.set(notice.personId, { kind: notice.kind, atTime: notice.atTime, noticeId: notice.id });
  }
  return { away: [...away.values()].sort((a, b) => (a.personId < b.personId ? -1 : 1)), notes };
}

// The extra sign-ups an attendance recompute adds for one raid: { playerId, kind: 'absence', source: 'away' } for each person an Away notice covers who
// has a character on the raid's team, was still in the guild on that date (not inactive, or inactive with a left-on date on or after it), and whose
// notice was filed before the raid began (createdAt <= startsAt). The weakest rank: it only matters for a person with no other sign-up kind and no
// presence in the log. notices: [{ personId, kind, from, to, weekday, createdAt }]; raid: { raidOn, teamId, startsAt };
// people: [{ playerId, characters: [{ teamId, coreRank, leftOn }] }] (worker/person-rank.js: "gone" is read off all the characters, never a person status).
export function attendanceAwaySignups(notices, raid, people) {
  const eligible = new Map();
  for (const person of people) {
    if (!(person.characters || []).some((character) => character.teamId === raid.teamId)) continue;
    if (!isGoneOn(person, raid.raidOn)) eligible.set(person.playerId, true);
  }
  const covered = new Set();
  for (const notice of notices) {
    if (notice.kind !== 'away' || !eligible.has(notice.personId)) continue;
    if (!(notice.createdAt <= raid.startsAt) || !noticeCovers(notice, raid.raidOn)) continue;
    covered.add(notice.personId);
  }
  return [...covered].sort().map((playerId) => ({ playerId, kind: 'absence', source: 'away' }));
}

// True when `after` covers a date before `today` that `before` did not: an edit that would move a notice back over raids that have already happened.
export function addsPastCoverage(before, after, today) {
  const last = addDays(today, -1);
  const end = after.to !== null && after.to < last ? after.to : last;
  for (let day = after.from; day <= end; day = addDays(day, 1)) {
    if (noticeCovers(after, day) && !noticeCovers(before, day)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Input

const fail = (field, message) => ({ ok: false, field, message });

// The body of a POST / PUT -> { ok: true, value: { kind, from, to, weekday, atTime, reason } } or { ok: false, field, message }.
// today: the guild's date today; officer: an officer writing (any real date after the game's release, and past coverage may change); otherwise a member
// (`from` not before today). current: the stored notice a PUT replaces ({ from, to, weekday } as noticeOfRow): a member may keep its start, but cannot
// change it to cover days that have already passed (the raids of those days may have been counted without it).
export function validateNotice(body, { today, officer, current = null }) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof input.kind !== 'string' || !AWAY_KINDS.includes(input.kind)) return fail('kind', 'Pick away, late or leaving.');
  const weekday = input.weekday === undefined || input.weekday === null ? null : input.weekday;
  if (weekday !== null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) return fail('weekday', 'weekday is 0 (Sunday) to 6 (Saturday), or left out for a date range.');
  if (!isRealDate(input.from)) return fail('from', 'from needs a date like 2027-01-20.');
  const from = input.from;
  if (from < EARLIEST_DATE) return fail('from', 'That date is before World of Warcraft existed.');
  const keepsStart = !!current && current.from === from;
  if (!officer && from < today && !keepsStart) return fail('from', 'A notice cannot start before today.');
  let to = null;
  if (input.to !== undefined && input.to !== null) {
    if (!isRealDate(input.to)) return fail('to', 'to needs a date like 2027-01-27.');
    to = input.to;
    if (to < from) return fail('to', 'The end cannot be before the start.');
  }
  if (weekday === null) {
    if (to === null) return fail('to', 'A date range needs an end date.');
    if (daysBetween(from, to) > MAX_RANGE_DAYS) return fail('to', `A date range is at most ${MAX_RANGE_DAYS} days. Use a repeating weekday for longer.`);
  }
  let atTime = null;
  if (input.kind !== 'away') {
    if (typeof input.atTime !== 'string' || !TIME.test(input.atTime)) return fail('atTime', `Say what time you ${input.kind === 'late' ? 'arrive' : 'leave'} (HH:MM, 00:00 to 23:59).`);
    atTime = input.atTime;
  }
  let reason = null;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== 'string') return fail('reason', 'reason must be text.');
    const text = input.reason.replace(SINGLE_LINE_STRIP, '').trim();
    if (Array.from(text).length > REASON_MAX) return fail('reason', `A reason is at most ${REASON_MAX} characters.`);
    reason = text || null;
  }
  const value = { kind: input.kind, from, to, weekday, atTime, reason };
  if (!officer && current && addsPastCoverage(current, value, today)) return fail('from', 'A notice cannot be changed to cover days that have already passed. Add a new notice for the future instead.');
  return { ok: true, value };
}
