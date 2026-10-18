// The calendar feed, the pure half (no I/O, no clock): an iCalendar (RFC 5545) document for a team's raids. Text values are escaped, content
// lines are folded at 75 octets without splitting a UTF-8 character, and every line ends in CRLF. worker/routes/calendar.js reads the raids
// and calls buildIcs().

export const FEED_PAST_DAYS = 30;
export const FEED_AHEAD_DAYS = 60;
export const DEFAULT_RAID_MS = 3 * 60 * 60 * 1000; // a raid with no known end lasts three hours
export const MAX_RAID_MS = 12 * 60 * 60 * 1000;    // a known end further out than this is not believed (a report left open)

const CRLF = '\r\n';
const encoder = new TextEncoder();

// RFC 5545 TEXT: backslash, semicolon and comma are escaped, a line break is the two characters "\n"; other control characters go.
export function escapeText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Folds one content line: no physical line is longer than 75 octets (the leading space of a continuation counts), and a multi-byte
// character is never cut. Returns the line with CRLF breaks inside it (no trailing CRLF).
export function foldLine(line) {
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      out.push(current);
      current = ' ';
      size = 1;
      limit = 75;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join(CRLF);
}

// 20261017T200000Z
export function formatUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// When a raid ends: its last pull when a log says so and that is plausible, else three hours after the start.
export function raidEnd(startsAt, lastPullEnd) {
  if (Number.isFinite(lastPullEnd) && lastPullEnd > startsAt && lastPullEnd - startsAt <= MAX_RAID_MS) return lastPullEnd;
  return startsAt + DEFAULT_RAID_MS;
}

// The DATE form of an all-day event: 20261017 for the date 2026-10-17.
export function formatDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  return date.replace(/-/g, '');
}

// input: { name, stamp (epoch ms: DTSTAMP of every event), events: [{ uid, start, end (epoch ms), summary, description, url }] }
// An event with allDay: true has no time: it carries startDate and endDate ('YYYY-MM-DD'; endDate is the day AFTER, as RFC 5545 reads a DATE end)
// instead of start / end, and is written as DTSTART;VALUE=DATE and DTEND;VALUE=DATE (a raid whose start time nobody has set yet).
export function buildIcs(input) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Raidsmith//Raid calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(input.name)}`,
    `X-WR-CALNAME:${escapeText(input.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const stamp = formatUtc(input.stamp);
  for (const event of input.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      ...(event.allDay
        ? [`DTSTART;VALUE=DATE:${formatDate(event.startDate)}`, `DTEND;VALUE=DATE:${formatDate(event.endDate)}`]
        : [`DTSTART:${formatUtc(event.start)}`, `DTEND:${formatUtc(event.end)}`]),
      `SUMMARY:${escapeText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

const KIND_LABEL = { signed: 'Signed', late: 'Late', standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Can\'t come' };
export const signupKindLabel = (kind) => KIND_LABEL[kind] || kind;

// The sign-up counts of a raid as one line: "Signed 21, Late 2, Standby 1" (only what is not zero), or "No sign-ups yet".
// counts: { signed (standby left out), late, standby, tentative, bench, absence }; null when the viewer may not see counts.
export function countsLine(counts) {
  if (!counts) return null;
  const parts = ['signed', 'late', 'standby', 'bench', 'tentative', 'absence'].filter((kind) => counts[kind] > 0).map((kind) => `${KIND_LABEL[kind]} ${counts[kind]}`);
  return parts.length ? parts.join(', ') : 'No sign-ups yet';
}
