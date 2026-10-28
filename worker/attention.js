// Needs attention, the pure half (no I/O, no clock): turns the rows worker/routes/attention.js read into the one list of open work an officer
// or team lead sees on the guild home page. Each item carries the fields its sentence needs and a `link` (a pages route without the guild id).
// Which items a viewer gets follows their rights per team: `allowsTeam(action, teamId)` and `granted(action)` come from the permission check.
//
// Home redesign, round 2 (Week on desktop, Briefing on phones): to-dos can be dismissed, snoozed or (the watch list) marked Reviewed, SHARED by every
// officer of the guild. The dismissals come in as input (`attention_dismissals` rows, newest state wins) and `now` is input too, so this stays pure.
// What a dismissal does is decided here, never by the client: see DISMISS_RULES (mode, snooze length, the fingerprint a hidden item is compared with).
//
// Home round 6: the `week` block is the guild's RESET week, an object (see the buildAttention doc below), and each raid carries the roles grid's `people` and
// `openSeats`. The window, the clock and every row come in as input; this file does no I/O.
import { addDays, localTimeToMs, weekStart } from './attendance-calendar.js';
import { noticeOfRow, raidNoticeEffects } from './away.js';
import { EXPECTED_KINDS, mergeSignups, roleGroup } from './signups-data.js';

export const ATTENTION_KINDS = ['review', 'loot_unmatched', 'signup_unmatched', 'claims', 'applications', 'team_requests', 'unmapped_ranks', 'block_review', 'claim_review', 'trial', 'watch', 'rank', 'no_loot', 'low_signups', 'log_missing', 'roster_declined', 'roster_pending', 'event_moved', 'webhook_off', 'unlocked'];
export const KIND_CAP = 10;              // items shown per kind; the rest are counted in `more`
export const INFO_KINDS = ['unlocked'];  // listed with severity 'info'
// Readiness FACTS about a raid: the Week view builds the raid's sentence from them (or from `week`). They stay in `items`, marked `readiness: true`,
// but are not to-dos and are never counted in `total`.
export const READINESS_KINDS = ['low_signups', 'roster_declined', 'roster_pending', 'unlocked'];
// `watch` and `rank` are no Home to-dos any more (they live on the Attendance and Ranks pages): never in `items`, only counted in `counts`.
export const OFF_HOME_KINDS = ['watch', 'rank'];
// One item stands for many asks (an item of `claims` is every pending character claim of the guild, one of `team_requests` every pending request of a team), and
// each ask is a to-do on Home (Approve / Reject on its own row), so `total` counts the asks, not the items.
export const COUNT_EACH_KINDS = ['claims', 'team_requests'];
export const ATTENTION_VIEW_ACTIONS = ['attendance.review', 'roster.edit', 'raids.edit', 'loot.edit'];
export const TRIAL_DAYS = 7;
export const LOOT_LOOKBACK_DAYS = 14;
export const SIGNUP_LOOKAHEAD_DAYS = 7;
export const UNLOCKED_MINUTES = 60;
export const WEEK_OFFSET_MAX = 8;        // GET /attention/week?offset=N: whole reset weeks from the current one, -8 .. 8
const DEFAULT_RESET_DAY = 2;             // Tuesday (the US reset), when the input carries none
export const WATCH_RETURN_POINTS = 5;    // a reviewed watch entry comes back after a further drop of this many points
const DAY_MS = 86400000;

// The dismiss / snooze / reviewed policy per kind. The SERVER decides all of it; a client only names the item.
//   mode: 'dismiss' (hidden until its fingerprint changes) | 'snooze' (hidden for `days`, or until its fingerprint changes) | 'reviewed' (watch only)
//   actions: every right the viewer needs for the item's team, to dismiss it and to restore it
//   fingerprint (what a hidden item is compared with; built in collect() below):
//     loot_unmatched: the sorted unmatched winner keys (the count when the keys were not read) | signup_unmatched: the count
//     event_moved: the Raid-Helper event's date | no_loot, log_missing: the raid id (so they never come back) | trial: the trial end date
//     webhook_off: Discord's disabled status | watch: JSON { pct, raidId } (the % and the newest missed raid id when it was reviewed)
//     claim_review: the audit id of the claim (a later claim brings the item back)
export const DISMISS_RULES = Object.freeze({
  claim_review: Object.freeze({ mode: 'dismiss', actions: ['guild.access'] }),
  loot_unmatched: Object.freeze({ mode: 'dismiss', actions: ['loot.edit', 'attendance.review'] }),
  signup_unmatched: Object.freeze({ mode: 'dismiss', actions: ['roster.edit'] }),
  event_moved: Object.freeze({ mode: 'dismiss', actions: ['raids.edit'] }),
  no_loot: Object.freeze({ mode: 'dismiss', actions: ['loot.edit'] }),
  log_missing: Object.freeze({ mode: 'dismiss', actions: ['raids.edit'] }),
  trial: Object.freeze({ mode: 'snooze', days: 3, actions: ['roster.edit'] }),
  webhook_off: Object.freeze({ mode: 'snooze', days: 7, actions: ['guild.teams'] }),
  watch: Object.freeze({ mode: 'reviewed', actions: ['attendance.review'] }),
});

// The `until` (ms; null = until the fingerprint changes) a new dismissal of this kind gets.
export function dismissalUntil(kind, now) {
  const rule = DISMISS_RULES[kind];
  return rule && rule.days ? now + rule.days * DAY_MS : null;
}

export const watchFingerprint = (pct, latestMissedRaidId) => JSON.stringify({ pct, raidId: latestMissedRaidId || null });

// A reviewed watch entry stays hidden while the % is above (the stored % - 5 points) and no newer raid was missed.
export function watchStaysReviewed(storedFingerprint, pct, latestMissedRaidId) {
  let stored;
  try { stored = JSON.parse(storedFingerprint); } catch { return false; }
  if (!stored || typeof stored.pct !== 'number' || typeof pct !== 'number') return false;
  return pct > stored.pct - WATCH_RETURN_POINTS && (stored.raidId || null) === (latestMissedRaidId || null);
}

// Whether a stored dismissal row still hides a collected entry at `now`: same kind, not expired, and the fingerprint still matches.
export function dismissalHides(row, entry, now) {
  if (!row || row.kind !== entry.item.kind) return false;
  if (row.until !== null && row.until !== undefined && row.until <= now) return false;
  if (entry.item.kind === 'watch') return watchStaysReviewed(row.fingerprint, entry.item.pct, entry.item.latestMissedRaidId);
  return row.fingerprint === entry.fingerprint;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A trial's days left: negative once it ended.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// input: {
//   today, now, teams: [{ id, name, size, archived }], allowsTeam(action, teamId), granted(action),
//   flaggedRaids: [{ id, team_id, raid_on, zone, title, event_title, open_flags }],
//   lootUnmatched: [{ raid_id, team_id, raid_on, zone, title, event_title, names, keys (the unmatched winners' keys, comma separated; optional) }],
//   signupUnmatched: [{ raid_id, team_id, raid_on, zone, title, event_title, n }],
//   claims: number, trials: [{ id (the person), character_id, is_main, trial_end, name, class, team_id }],
//   noLoot: [{ id, team_id, raid_on, zone, title, event_title }],
//   applications: [{ team_id, n }]   (applications still marked New, per team)
//   teamRequests: [{ team_id, n }]   (pending team requests, per team: a person asked for a character to be placed on the team)
//   blockReview: { pending, held }   (lane B7a: blocks a tombstone match inserted that wait for an officer, and matches that were held back; the route reads them ONLY for a holder of guild.access)
//   unmappedRanks: [{ rank, members }]   (in-game ranks on the stored roster with no row in the rank map; the route reads them ONLY for the Owner of an 'ingame' guild)
//   claimReview: { id, at } | null   (lane B6b part 2b: the audit row of the Guild Master claim that made the viewer the Owner, until they dismiss the item; the route reads it ONLY for the Owner who made the latest claim)
//   rosterDeclined: [{ id, team_id, raid_on, starts_at, zone, title, event_title, n }]   (upcoming raids with a published roster: n seats said "can't make it")
//   rosterPending: [{ id, team_id, raid_on, starts_at, zone, title, event_title, n }]   (upcoming raids that start within CONFIRM_HOURS with a published roster: n seats have not answered)
//   logMissing: [{ id, team_id, raid_on, zone, title, event_title, logger_name }]   (PM wave 8: past raids whose Logger has not uploaded a log, 5 hours after the start)
//   eventMoved: [{ id, team_id, raid_on, starts_at, zone, title, event_title, event_moved_on }]   (upcoming raids whose Raid-Helper event is on another day: the refresh does not move a raid)
//   webhooksOff: [{ team_id, disabled_status }]   (teams whose Discord webhook Discord refused: the Worker switched it off)
//   upcoming: [{ id, team_id, raid_on, starts_at, zone, title, event_title, signups_locked, n_in, size (the raid's effective size; the team's when left out),
//                close_hours (the sign-up deadline in hours before the start; 0 or left out = at the start) }],
//   watch: [{ teamId, entries: [{ playerId, name, class, pct, previousPct, drop, reasons, latestMissedRaidId }] }],
//   ranks: [{ teamId, entries: [{ playerId, name, class, kind ('promote' | 'review'), from: { id, name }, to: { id, name }, reasons: [text] }] }]   (PM wave 7: the rank ladder's suggestions),
//   dismissals: [{ item_id, kind, team_id, mode, until, fingerprint, dismissed_by, created_at, by_name }]   (attention_dismissals: shared by every officer),
//   weekRaids: [{ id, team_id, raid_on, starts_at, zone, size (effective), title, event_title, signups_locked, roster_published_at, close_hours, n_in,
//                 confirmed, declined, pending, event_moved_on }]   (raids of the weeks the route read; the reset week is cut out here, in the guild's days),
//   resetDay: 0 (Sunday) .. 6, the guild's raid reset day (the policy's override, else the region's; 2 when left out),
//   weekOffset: whole reset weeks from the current one (an integer), or left out = the current one, jumping to the next when it is over (see `week`),
//   timeZone: the guild's IANA zone (turns a Late notice's HH:MM into `lateAt`),
//   weekData: { signups: [raid_signups rows of the week's raids: raid_id, source, signup_id, nickname, kind, standby, guest, class_name, spec_name, position, player_id, character_id],
//               characters: [{ id, player_id, name, class, is_main, team_id }] (of those sign-ups' people), roster: [raid_roster rows: raid_id, name, player_id, group_number,
//               class, spec, status], lateNotices: [away_notices rows of kind 'late' that can touch the week] }   (optional: no people without it) }
// -> {
//   items:  the open, unhidden Home items (never `watch` or `rank`): { kind, severity, teamId, teamName, id, link, raidId?, ..., readiness?: true },
//   more:   { kind: n }   open items the per-kind cap leaves out of `items`,
//   total:  open, unhidden to-dos only (readiness facts are not counted; items beyond the cap are; an item of COUNT_EACH_KINDS counts every ask in it),
//   hidden: [{ item, mode: 'dismiss' | 'snooze', until: ms | null, by: { name }, at: ms }]   (what a dismissal hides now: the Hidden list with Restore; newest first),
//   counts: { [teamId]: { watchOpen, rankOpen } }   (watch entries still open after "Reviewed", and rank suggestions, per team the viewer may review),
//   week:   { offset, start, end, resetDay, autoAdvanced, raids }
//           the guild's RESET week: `start` is the guild date of the reset day on or before today (+ 7 x offset) and `end` is start + 6. `offset` is 0 for the
//           current week. With no explicit `weekOffset`: when no raid of the current week starts after `now` and the next week has a raid, the next week comes
//           back with offset 1 and autoAdvanced true (the offset route never does that). `raids` is every raid of a live team the viewer can see (any of
//           ATTENTION_VIEW_ACTIONS) whose guild date is in start..end, by start time:
//           { raidId, teamId, teamName, date, startsAt, zone, title, size, signed, lineupPublished, confirmed, cantCome, noAnswer, signupsCloseAt,
//             signupsLocked (the raid's own lock flag), eventMovedOn, status, people, openSeats }
//           status: a raid that has started: 'done' (no open to-do tied to it) | 'todo'; an upcoming one: 'short' (signed < size) | 'ready' (full and the line-up
//           is published) | 'open'. Every raid to-do keeps its `raidId`, so a page can attach it to its day.
//           people: [{ name, classId, spec, role ('tank' | 'healer' | 'melee' | 'ranged'; null when neither the spec nor the class says), state, lateAt? }],
//           grouped tank, healer, melee, ranged, null last, and by name inside a group. The source and the states:
//             line-up published: the SEATED players (the bench, group 0, is left out); state 'confirmed' | 'no_answer' | 'cant_come' from the seat's answer;
//             not published: the merged sign-ups; state 'signed' | 'late' | 'tentative' | 'standby' | 'cant_come' (an Absence); a Bench entry is left out;
//             a raid that has started: the same source, but only the people who were expected (seated, or signed / late / standby), all with state 'listed'.
//           lateAt (epoch ms, guild zone): only on an upcoming raid, for a person whose sign-up is Late and who has a Late notice with a time that covers the day.
//           openSeats: max(0, size - counted), counted = the seated players (published) or the signed / late / standby sign-ups (not published).
// }
export function buildAttention(input) {
  const { groups, counts, teamById } = collect(input);
  const now = input.now;
  const byItem = new Map((input.dismissals || []).map((row) => [row.item_id, row]));
  const items = [];
  const more = {};
  const hidden = [];
  const openTodoRaids = new Set();
  let total = 0;
  for (const kind of ATTENTION_KINDS) {
    if (OFF_HOME_KINDS.includes(kind)) continue;
    const open = [];
    const list = (groups[kind] || []).sort((a, b) => compareOrder(a.order, b.order) || byText(a.item.id, b.item.id));
    for (const entry of list) {
      const row = byItem.get(entry.item.id);
      if (dismissalHides(row, entry, now)) {
        hidden.push({ item: entry.item, mode: row.mode, until: row.until === undefined ? null : row.until, by: { name: row.by_name || 'Former member' }, at: row.created_at });
      } else {
        open.push(entry);
      }
    }
    if (open.length > KIND_CAP) more[kind] = open.length - KIND_CAP;
    for (const entry of open.slice(0, KIND_CAP)) items.push(entry.item);
    if (READINESS_KINDS.includes(kind)) continue;
    total += COUNT_EACH_KINDS.includes(kind) ? open.reduce((sum, entry) => sum + Math.max(1, Math.floor(Number(entry.item.count) || 1)), 0) : open.length;
    for (const entry of open) if (entry.item.raidId) openTodoRaids.add(entry.item.raidId); // uncapped: the cap must not turn a raid "done"
  }
  hidden.sort((a, b) => b.at - a.at || byText(a.item.id, b.item.id));
  for (const entry of groups.watch || []) {
    if (!dismissalHides(byItem.get(entry.item.id), entry, now)) counts[entry.item.teamId].watchOpen++;
  }
  return { items, more, total, hidden, counts, week: buildWeek(input, teamById, openTodoRaids) };
}

// What the dismissal routes act on: { entry: { item, fingerprint }, rule } for an item this viewer sees (watch, rank and the readiness kinds included,
// hidden or not, uncapped); rule is undefined for a kind that cannot be dismissed. null when the viewer sees no such item.
export function findAttentionItem(input, itemId) {
  const { groups } = collect(input);
  for (const kind of Object.keys(groups)) {
    for (const entry of groups[kind]) if (entry.item.id === itemId) return { entry, rule: DISMISS_RULES[kind] };
  }
  return null;
}

const ROLE_RANK = { tank: 0, healer: 1, melee: 2, ranged: 3 };
const SEAT_STATE = { confirmed: 'confirmed', pending: 'no_answer', declined: 'cant_come' };
const SIGNUP_STATE = { signed: 'signed', late: 'late', tentative: 'tentative', standby: 'standby', absence: 'cant_come' };

function groupRows(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

// The roles grid of one raid: { people, openSeats } (the shape documented above). `data` is the week's rows, grouped.
function raidPeople(row, size, lineupPublished, started, data, timeZone) {
  const entries = mergeSignups(data.signups.get(row.id) || [], data.charactersByPlayer, { teamId: row.team_id, seeNicknames: true });
  const kindOf = new Map(entries.filter((entry) => entry.personId).map((entry) => [entry.personId, entry.kind]));
  const notes = started ? new Map() : raidNoticeEffects(data.lateNotices, row.raid_on, new Set(kindOf.keys())).notes;
  const lateAtOf = (personId) => {
    const note = personId ? notes.get(personId) : null;
    if (!note || note.kind !== 'late' || !note.atTime || kindOf.get(personId) !== 'late' || !timeZone) return undefined;
    const at = localTimeToMs(row.raid_on, note.atTime, timeZone);
    return at === null ? undefined : at;
  };
  let people;
  let counted;
  if (lineupPublished) {
    const seats = (data.roster.get(row.id) || []).filter((seat) => seat.group_number > 0);
    counted = seats.length;
    people = seats.map((seat) => ({
      name: seat.name, classId: seat.class || null, spec: seat.spec || null, role: roleGroup(seat.class, seat.spec) || null,
      state: started ? 'listed' : SEAT_STATE[seat.status] || 'no_answer', lateAt: started ? undefined : lateAtOf(seat.player_id),
    }));
  } else {
    const expected = entries.filter((entry) => EXPECTED_KINDS.includes(entry.kind));
    counted = expected.length;
    people = (started ? expected : entries.filter((entry) => SIGNUP_STATE[entry.kind])).map((entry) => ({
      name: entry.name || 'Unknown', classId: entry.classId || null, spec: entry.spec || null, role: entry.role || null,
      state: started ? 'listed' : SIGNUP_STATE[entry.kind], lateAt: entry.kind === 'late' ? lateAtOf(entry.personId) : undefined,
    }));
  }
  people = people.map(({ lateAt, ...person }) => (lateAt === undefined ? person : { ...person, lateAt }));
  people.sort((a, b) => (a.role === null ? 9 : ROLE_RANK[a.role]) - (b.role === null ? 9 : ROLE_RANK[b.role]) || byText(a.name, b.name));
  return { people, openSeats: Math.max(0, size - counted) };
}

function buildWeek(input, teamById, openTodoRaids) {
  const resetDay = Number.isInteger(input.resetDay) ? input.resetDay : DEFAULT_RESET_DAY;
  const current = weekStart(input.today, resetDay);
  const visible = (input.weekRaids || []).filter((row) => {
    const team = teamById.get(row.team_id);
    return team && team.archived === 0 && ATTENTION_VIEW_ACTIONS.some((action) => input.allowsTeam(action, row.team_id));
  });
  const window = (offset) => ({ start: addDays(current, 7 * offset), end: addDays(current, 7 * offset + 6) });
  const rowsOf = (offset) => {
    const { start, end } = window(offset);
    return visible.filter((row) => row.raid_on >= start && row.raid_on <= end);
  };
  const explicit = Number.isInteger(input.weekOffset);
  let offset = explicit ? input.weekOffset : 0;
  let autoAdvanced = false;
  if (!explicit && !rowsOf(0).some((row) => row.starts_at > input.now) && rowsOf(1).length) {
    offset = 1;
    autoAdvanced = true;
  }
  const weekData = input.weekData || {};
  const data = {
    signups: groupRows(weekData.signups, 'raid_id'), roster: groupRows(weekData.roster, 'raid_id'), lateNotices: (weekData.lateNotices || []).map(noticeOfRow),
    charactersByPlayer: groupRows(weekData.characters, 'player_id'),
  };
  const raids = [];
  for (const row of rowsOf(offset)) {
    const team = teamById.get(row.team_id);
    const signed = row.n_in || 0;
    const size = row.size ?? team.size;
    const lineupPublished = row.roster_published_at !== null && row.roster_published_at !== undefined;
    const started = row.starts_at <= input.now;
    let status;
    if (started) status = openTodoRaids.has(row.id) ? 'todo' : 'done';
    else if (signed < size) status = 'short';
    else status = lineupPublished ? 'ready' : 'open';
    raids.push({
      raidId: row.id, teamId: row.team_id, teamName: team.name, date: row.raid_on, startsAt: row.starts_at, zone: row.zone || null,
      title: row.title || row.event_title || null, size, signed, lineupPublished, confirmed: row.confirmed || 0, cantCome: row.declined || 0, noAnswer: row.pending || 0,
      signupsCloseAt: row.starts_at - (row.close_hours || 0) * 3600000, signupsLocked: row.signups_locked === 1, eventMovedOn: row.event_moved_on || null, status,
      ...raidPeople(row, size, lineupPublished, started, data, input.timeZone),
    });
  }
  raids.sort((a, b) => a.startsAt - b.startsAt || byText(a.raidId, b.raidId));
  return { offset, ...window(offset), resetDay, autoAdvanced, raids };
}

// Every item the viewer may see, uncapped and unfiltered: { groups: { kind: [{ item, order, fingerprint }] }, counts, teamById }
function collect(input) {
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const live = (teamId) => {
    const team = teamById.get(teamId);
    return !!team && team.archived === 0;
  };
  const here = (action, teamId) => live(teamId) && input.allowsTeam(action, teamId);
  const base = (kind, teamId, severity = 'action') => ({ kind, severity, teamId: teamId || null, teamName: teamId && teamById.has(teamId) ? teamById.get(teamId).name : null });
  const raidFields = (row) => ({ raidId: row.id || row.raid_id, date: row.raid_on, zone: row.zone || null, title: row.title || row.event_title || null });
  const groups = {};
  const counts = {};
  const countsOf = (teamId) => (counts[teamId] = counts[teamId] || { watchOpen: 0, rankOpen: 0 });
  const add = (kind, item, order, fingerprint = null) => { (groups[kind] = groups[kind] || []).push({ item, order, fingerprint }); };

  for (const row of input.flaggedRaids) {
    if (!here('attendance.review', row.team_id)) continue;
    add('review', { ...base('review', row.team_id), ...raidFields(row), count: row.open_flags, id: `review:${row.id}`, link: { name: 'raid', rid: row.id } }, [-dateNumber(row.raid_on)]);
  }
  for (const row of input.lootUnmatched) {
    if (!(here('loot.edit', row.team_id) && here('attendance.review', row.team_id))) continue;
    const keys = typeof row.keys === 'string' && row.keys ? row.keys.split(',').sort().join(',') : String(row.names);
    add('loot_unmatched', { ...base('loot_unmatched', row.team_id), ...raidFields(row), count: row.names, id: `loot_unmatched:${row.raid_id}`, link: { name: 'review' } }, [-dateNumber(row.raid_on)], keys);
  }
  for (const row of input.signupUnmatched) {
    if (!here('roster.edit', row.team_id)) continue;
    add('signup_unmatched', { ...base('signup_unmatched', row.team_id), ...raidFields(row), count: row.n, id: `signup_unmatched:${row.raid_id}`, link: { name: 'raid', rid: row.raid_id, focus: 'signups-unmatched' } }, [dateNumber(row.raid_on)], String(row.n));
  }
  if (input.claims > 0 && input.granted('roster.edit')) {
    add('claims', { ...base('claims', null), count: input.claims, id: 'claims', link: { name: 'review' } }, [0]);
  }
  for (const row of input.applications || []) {
    if (!here('roster.edit', row.team_id)) continue;
    add('applications', { ...base('applications', row.team_id), count: row.n, id: `applications:${row.team_id}`, link: { name: 'applications' } }, [0]);
  }
  for (const row of input.teamRequests || []) {
    if (!here('roster.edit', row.team_id)) continue;
    add('team_requests', { ...base('team_requests', row.team_id), count: row.n, id: `team_requests:${row.team_id}`, link: { name: 'teamrequests' } }, [0]);
  }
  // The Owner's gap in the rank map (lane B4b): characters of these ranks are Social until the ranks are mapped. One item for the guild, never dismissable.
  if ((input.unmappedRanks || []).length) {
    const ranks = input.unmappedRanks.map((row) => row.rank).sort((a, b) => a - b);
    add('unmapped_ranks', {
      ...base('unmapped_ranks', null), count: ranks.length, ranks, characters: input.unmappedRanks.reduce((total, row) => total + row.members, 0),
      id: 'unmapped_ranks', link: { name: 'settings', tab: 'battlenet' },
    }, [0], ranks.join(','));
  }
  // Blocks a tombstone match made or held back (lane B7a): one item for the guild, for the holders of guild.access, never dismissable (a pending block stays until an
  // officer keeps it or lifts it).
  if (input.blockReview && (input.blockReview.pending > 0 || input.blockReview.held > 0) && input.granted('guild.access')) {
    const { pending, held } = input.blockReview;
    add('block_review', {
      ...base('block_review', null), count: pending + held, pending, held, id: 'block_review', link: { name: 'users', segment: 'blocked' },
    }, [0], `${pending}:${held}`);
  }
  // The new Owner's review of what the previous Owner left live after a Guild Master claim (lane B6b part 2b, U R6-Q1): one item for the guild, dismissable (a later claim brings it back).
  if (input.claimReview && input.granted('guild.access')) {
    add('claim_review', { ...base('claim_review', null), id: 'claim_review', claimedAt: input.claimReview.at, link: { name: 'settings', tab: 'claimreview' } }, [0], input.claimReview.id);
  }
  // A Trial is per CHARACTER on its team (a Raider main on A can have a Trial alt on B): one item per Trial character. The id stays `trial:<person>` for the
  // main (what a snooze has always been keyed by) and adds the team for an alt.
  for (const row of input.trials) {
    if (!here('roster.edit', row.team_id)) continue;
    const days = daysBetween(input.today, row.trial_end);
    if (days > TRIAL_DAYS) continue;
    add('trial', {
      ...base('trial', row.team_id), personId: row.id, name: row.name, class: row.class, trialEnd: row.trial_end, days, ended: days < 0,
      id: row.is_main === 0 ? `trial:${row.id}:${row.team_id}` : `trial:${row.id}`, link: { name: 'person', pid: row.id },
    }, [days], row.trial_end);
  }
  for (const list of input.watch) {
    if (!here('attendance.review', list.teamId)) continue;
    countsOf(list.teamId);
    for (const entry of list.entries) {
      add('watch', {
        ...base('watch', list.teamId), personId: entry.playerId, name: entry.name, class: entry.class, pct: entry.pct, previousPct: entry.previousPct,
        drop: entry.drop, reasons: entry.reasons, latestMissedRaidId: entry.latestMissedRaidId || null, id: `watch:${list.teamId}:${entry.playerId}`,
        link: { name: 'personatt', pid: entry.playerId },
      }, [entry.pct], watchFingerprint(entry.pct, entry.latestMissedRaidId));
    }
  }
  for (const list of input.ranks || []) {
    if (!here('attendance.review', list.teamId)) continue;
    countsOf(list.teamId).rankOpen += list.entries.length;
    for (const entry of list.entries) {
      add('rank', {
        ...base('rank', list.teamId), personId: entry.playerId, name: entry.name, class: entry.class, suggestion: entry.kind, from: entry.from, to: entry.to,
        reasons: entry.reasons, id: `rank:${list.teamId}:${entry.playerId}`, link: { name: 'personatt', pid: entry.playerId },
      }, [entry.kind === 'review' ? 1 : 0, entry.name]);
    }
  }
  for (const row of input.noLoot) {
    if (!here('loot.edit', row.team_id)) continue;
    add('no_loot', { ...base('no_loot', row.team_id), ...raidFields(row), id: `no_loot:${row.id}`, link: { name: 'raid', rid: row.id } }, [-dateNumber(row.raid_on)], row.id);
  }
  for (const row of input.upcoming) {
    if (!here('raids.edit', row.team_id)) continue;
    const team = teamById.get(row.team_id);
    const fields = { ...raidFields(row), startsAt: row.starts_at };
    const size = row.size ?? team.size;
    if (row.n_in < size) {
      add('low_signups', { ...base('low_signups', row.team_id), ...fields, expected: row.n_in, size, readiness: true, id: `low_signups:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
    }
    const minutes = Math.ceil((row.starts_at - input.now) / 60000);
    const deadlinePassed = (row.close_hours || 0) > 0 && row.starts_at - row.close_hours * 3600000 <= input.now; // members are shut out already
    if (row.signups_locked === 0 && !deadlinePassed && minutes > 0 && minutes <= UNLOCKED_MINUTES) {
      add('unlocked', { ...base('unlocked', row.team_id, 'info'), ...fields, minutes, readiness: true, id: `unlocked:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
    }
  }

  for (const row of input.rosterDeclined || []) {
    if (!here('raids.edit', row.team_id)) continue;
    add('roster_declined', { ...base('roster_declined', row.team_id), ...raidFields(row), startsAt: row.starts_at, count: row.n, readiness: true, id: `roster_declined:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
  }

  for (const row of input.rosterPending || []) {
    if (!here('raids.edit', row.team_id)) continue;
    add('roster_pending', { ...base('roster_pending', row.team_id), ...raidFields(row), startsAt: row.starts_at, count: row.n, readiness: true, id: `roster_pending:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
  }
  for (const row of input.logMissing || []) {
    if (!here('raids.edit', row.team_id)) continue;
    add('log_missing', { ...base('log_missing', row.team_id), ...raidFields(row), loggerName: row.logger_name || null, id: `log_missing:${row.id}`, link: { name: 'raid', rid: row.id } }, [-dateNumber(row.raid_on)], row.id);
  }
  for (const row of input.eventMoved || []) {
    if (!here('raids.edit', row.team_id)) continue;
    add('event_moved', { ...base('event_moved', row.team_id), ...raidFields(row), startsAt: row.starts_at, eventDate: row.event_moved_on, id: `event_moved:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at], row.event_moved_on);
  }
  for (const row of input.webhooksOff || []) {
    if (!here('guild.teams', row.team_id)) continue;
    add('webhook_off', { ...base('webhook_off', row.team_id), status: row.disabled_status, id: `webhook_off:${row.team_id}`, link: { name: 'settings', tab: 'notifications' } }, [0], String(row.disabled_status ?? ''));
  }
  return { groups, counts, teamById };
}

function dateNumber(date) {
  return Date.parse(`${date}T00:00:00Z`) / 86400000;
}

function compareOrder(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
