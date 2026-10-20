// Attendance metrics (pure): per person and window, from one team's stored rows. No D1, no clock (`today` is passed in),
// the input is never mutated. Rules: tasks/reference/guild-phase3-spec.md, "Metrics".
import { addDays, weekStart } from './attendance-calendar.js';
import { OUTCOMES } from './attendance-policy.js';

const PICK_OUTCOMES = new Set(['late', 'left_early', 'late_left']);
const SIGNUP_KINDS = new Set(['signed', 'late', 'standby', 'bench']);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round1 = (value) => Math.round(value * 10) / 10;

function cellCounts(cell, policy) {
  if (cell.preStart || typeof cell.credit !== 'number') return false;
  if (cell.outcome === 'no_signup' || cell.outcome === 'tentative') return false;
  if (cell.outcome === 'missed_notice' && policy.absence === 'excused') return false;
  if (cell.outcome === 'bench' && policy.bench === 'excluded') return false;
  return true;
}

function effectiveStart(person, firstAttended, policy) {
  const joined = person.joinedOn || null;
  if (!joined) return null; // no join date: no lower bound
  if (policy.effectiveStart === 'joinDate' || !firstAttended) return joined;
  return firstAttended > joined ? firstAttended : joined;
}

// input: {
//   people: [{ id, joinedOn, status?, leftOn? }], raids: [{ id, raidOn, hasSignups }],
//   rows: [{ raidId, playerId, outcome, credit, signupKind, attended, viaRaidId, viaTeamId? }]   // EFFECTIVE outcome / credit
//   borrowed: [{ playerId, raidId, raidOn, teamId }],   // host-side fill-in rows with credit 1 and credit_team_id = this team
//   policy (resolved), today (YYYY-MM-DD), resetDay (0..6; default policy.resetDay),
//   windowWeeks: a number of full reset weeks, or 'all' (default policy.window.defaultWeeks) }
// -> { windowWeeks, windowStart, weeks: [{ weekStart, raids: [{ id, raidOn }] }], awaitingReview,
//      people: { [id]: { pct, pctAll, signupRate, streak, streakFlag, lastAttended, counted, pending, start, cells[] } } }
// pct / pctAll / signupRate are 0..100 rounded to one decimal, or null. A cell is
// { raidId, date, weekStart, outcome, letter, credit, via, pending, preStart }; a pending cell's letter ends in "?",
// a pre-start cell's letter is ''.
export function teamMetrics(input) {
  const { policy, today } = input;
  const resetDay = Number.isInteger(input.resetDay) ? input.resetDay : policy.resetDay;
  const windowWeeks = input.windowWeeks === undefined ? policy.window.defaultWeeks : input.windowWeeks;
  const windowStart = windowWeeks === 'all' ? null : addDays(weekStart(today, resetDay), -7 * (windowWeeks - 1));
  const inWindow = (date) => date <= today && (windowStart === null || date >= windowStart);

  const raids = [...(input.raids || [])].sort((a, b) => byText(a.raidOn, b.raidOn) || byText(a.id, b.id));
  const raidById = new Map(raids.map((raid) => [raid.id, raid]));

  const weekMap = new Map();
  for (const raid of raids) {
    const start = weekStart(raid.raidOn, resetDay);
    if (!weekMap.has(start)) weekMap.set(start, []);
    weekMap.get(start).push({ id: raid.id, raidOn: raid.raidOn });
  }
  const weeks = [...weekMap.keys()].sort(byText).map((start) => ({ weekStart: start, raids: weekMap.get(start) }));

  const rowsByPlayer = new Map();
  for (const row of input.rows || []) {
    if (!raidById.has(row.raidId)) continue;
    if (!rowsByPlayer.has(row.playerId)) rowsByPlayer.set(row.playerId, []);
    rowsByPlayer.get(row.playerId).push(row);
  }
  const borrowedByPlayer = new Map();
  for (const item of input.borrowed || []) {
    if (!borrowedByPlayer.has(item.playerId)) borrowedByPlayer.set(item.playerId, []);
    borrowedByPlayer.get(item.playerId).push(item);
  }

  const pendingRaids = new Set();
  const people = {};
  for (const person of input.people || []) {
    const raw = [];
    for (const row of rowsByPlayer.get(person.id) || []) {
      const raid = raidById.get(row.raidId);
      raw.push({
        raidId: row.raidId, date: raid.raidOn, outcome: row.outcome, credit: typeof row.credit === 'number' ? row.credit : null,
        via: row.viaTeamId || row.viaRaidId || null, attendedFlag: row.attended === 1, signupKind: row.signupKind || null, ownRow: true,
      });
    }
    for (const item of borrowedByPlayer.get(person.id) || []) {
      raw.push({ raidId: item.raidId, date: item.raidOn, outcome: 'fill_in', credit: 1, via: item.teamId || null, attendedFlag: true, signupKind: null, ownRow: false });
    }
    raw.sort((a, b) => byText(a.date, b.date) || byText(a.raidId, b.raidId));

    let firstAttended = null;
    for (const cell of raw) {
      if (cell.attendedFlag || cell.outcome === 'fill_in' || cell.outcome === 'bench') { firstAttended = cell.date; break; }
    }
    const start = effectiveStart(person, firstAttended, policy);

    const cells = raw.map((cell) => {
      const preStart = start !== null && cell.date < start;
      const pending = cell.credit === null && PICK_OUTCOMES.has(cell.outcome);
      return {
        raidId: cell.raidId,
        date: cell.date,
        weekStart: weekStart(cell.date, resetDay),
        outcome: cell.outcome,
        letter: preStart ? '' : OUTCOMES[cell.outcome].letter + (pending ? '?' : ''),
        credit: cell.credit,
        via: cell.via,
        pending,
        preStart,
      };
    });

    let sum = 0, count = 0, sumAll = 0, countAll = 0, pendingCount = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const counts = cellCounts(cell, policy);
      if (counts) { sumAll += cell.credit; countAll++; }
      if (!inWindow(cell.date)) continue;
      if (counts) { sum += cell.credit; count++; }
      if (cell.pending && !cell.preStart) { pendingCount++; pendingRaids.add(cell.raidId); }
    }

    let streak = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (!cellCounts(cells[i], policy)) continue;
      if (cells[i].credit > 0) break;
      streak++;
    }
    let lastAttended = null;
    for (const cell of cells) if (typeof cell.credit === 'number' && cell.credit > 0 && (lastAttended === null || cell.date > lastAttended)) lastAttended = cell.date;

    const signedKinds = new Map();
    for (const cell of raw) if (cell.signupKind) signedKinds.set(cell.raidId, cell.signupKind);
    let rateRaids = 0, rateSigned = 0;
    for (const raid of raids) {
      if (!inWindow(raid.raidOn) || !raid.hasSignups) continue;
      if (start !== null && raid.raidOn < start) continue;
      if (person.status === 'inactive' && person.leftOn && raid.raidOn > person.leftOn) continue; // after they left
      rateRaids++;
      if (SIGNUP_KINDS.has(signedKinds.get(raid.id))) rateSigned++;
    }

    people[person.id] = {
      pct: count ? round1((sum / count) * 100) : null,
      pctAll: countAll ? round1((sumAll / countAll) * 100) : null,
      signupRate: rateRaids ? round1((rateSigned / rateRaids) * 100) : null,
      streak,
      streakFlag: policy.streakFlagAt > 0 && streak >= policy.streakFlagAt,
      lastAttended,
      counted: count,
      pending: pendingCount,
      start,
      cells,
    };
  }

  return { windowWeeks, windowStart, weeks, awaitingReview: pendingRaids.size, people };
}

// One person across the teams they may be shown.
// input: { person: { id, joinedOn }, teams: [{ teamId, raids, rows, borrowed, policy, resetDay }], today, windowWeeks? }
// -> { teams: [{ teamId, metrics, cells }] } with cells newest first (the history list). Each team uses its own policy.
export function personHistory(input) {
  const teams = (input.teams || []).map((team) => {
    const result = teamMetrics({
      people: [input.person],
      raids: team.raids,
      rows: team.rows,
      borrowed: team.borrowed,
      policy: team.policy,
      today: input.today,
      resetDay: team.resetDay,
      windowWeeks: input.windowWeeks,
    });
    const metrics = result.people[input.person.id];
    return { teamId: team.teamId, windowStart: result.windowStart, metrics, cells: [...metrics.cells].reverse() };
  });
  return { teams };
}

// ---------------------------------------------------------------------------
// Cell summaries and the watch list

// One person's cells over a date range, counted by the same rules as the rolling %.
// cells: teamMetrics cells; opts: { policy, from (YYYY-MM-DD | null = from the start), to (YYYY-MM-DD) }.
// -> { raids (counted), pct (0..100, one decimal, or null), present (counted with credit), missed, missedNotice, late, leftEarly, fillIns, pending }
// missedNotice is counted even when the policy excuses it (the % leaves it out, the officer still wants to see it).
export function summarizeCells(cells, opts) {
  const { policy, from = null, to } = opts;
  const out = { raids: 0, pct: null, present: 0, missed: 0, missedNotice: 0, late: 0, leftEarly: 0, fillIns: 0, pending: 0 };
  let sum = 0;
  for (const cell of cells || []) {
    if (cell.preStart || cell.date > to || (from !== null && cell.date < from)) continue;
    if (cell.outcome === 'missed_notice') out.missedNotice++;
    if (cell.outcome === 'fill_in') out.fillIns++;
    if (cell.outcome === 'late' || cell.outcome === 'late_left') out.late++;
    if (cell.outcome === 'left_early' || cell.outcome === 'late_left') out.leftEarly++;
    if (cell.pending) out.pending++;
    if (!cellCounts(cell, policy)) continue;
    out.raids++;
    sum += cell.credit;
    if (cell.credit > 0) out.present++;
    if (cell.outcome === 'missed') out.missed++;
  }
  out.pct = out.raids ? round1((sum / out.raids) * 100) : null;
  return out;
}

// The raid id of the newest counted missed cell in [from, to] (cells run oldest first), or null.
function latestMissedRaid(cells, policy, from, to) {
  let found = null;
  for (const cell of cells || []) {
    if (cell.preStart || cell.date > to || (from !== null && from !== undefined && cell.date < from)) continue;
    if ((cell.outcome === 'missed' || cell.outcome === 'missed_notice') && cellCounts(cell, policy)) found = cell.raidId;
  }
  return found;
}

// A drop is only judged when the previous window counted at least this many raids (one raid at 100% then one at 0% is noise).
export const WATCH_MIN_PREVIOUS = 2;

// Who is on a team's watch list: the rolling % under policy.watch.below, or fallen by policy.watch.dropBy or more against the previous window
// of the same length (the windowWeeks reset weeks that end the day before this window starts). input is teamMetrics' input, plus
// statuses (default raider and trial: a reserve or an inactive person is not expected to come). No window ('all') has no previous window.
// -> { below, dropBy, windowWeeks, previousFrom, entries: [{ playerId, pct, previousPct, drop, counted, missed, missedNotice, reasons, latestMissedRaidId }] },
// latestMissedRaidId: the newest raid of the window the person missed (outcome missed or missed_notice, counted), or null: a Reviewed mark comes back when it changes.
// lowest % first. Thresholds are fractions (0.75 is 75%); null is off, and with both off the list is empty.
export function watchList(input) {
  const policy = input.policy;
  const watch = (policy && policy.watch) || {};
  const below = typeof watch.below === 'number' ? watch.below : null;
  const dropBy = typeof watch.dropBy === 'number' ? watch.dropBy : null;
  const windowWeeks = input.windowWeeks === undefined ? policy.window.defaultWeeks : input.windowWeeks;
  const result = { below, dropBy, windowWeeks, previousFrom: null, entries: [] };
  if (below === null && dropBy === null) return result;

  const statuses = input.statuses || ['raider', 'trial'];
  const people = (input.people || []).filter((person) => statuses.includes(person.status));
  const current = teamMetrics({ ...input, people, windowWeeks });
  let previous = null;
  if (dropBy !== null && windowWeeks !== 'all' && current.windowStart) {
    previous = teamMetrics({ ...input, people, today: addDays(current.windowStart, -1), windowWeeks });
    result.previousFrom = previous.windowStart;
  }

  for (const person of people) {
    const mine = current.people[person.id];
    if (!mine || mine.pct === null) continue;
    const before = previous && previous.people[person.id];
    const previousPct = before && before.counted >= WATCH_MIN_PREVIOUS ? before.pct : null;
    const fall = previousPct === null ? 0 : Math.round((previousPct - mine.pct) * 10) / 10;
    const reasons = [];
    // Percentages carry one decimal: compare in tenths of a point so 74.9 is under 75 and 75.0 is not.
    if (below !== null && Math.round(mine.pct * 10) < Math.round(below * 1000)) reasons.push('below');
    if (dropBy !== null && fall > 0 && Math.round(fall * 10) >= Math.round(dropBy * 1000)) reasons.push('drop');
    if (!reasons.length) continue;
    const counts = summarizeCells(mine.cells, { policy, from: current.windowStart, to: input.today });
    result.entries.push({
      playerId: person.id, pct: mine.pct, previousPct, drop: fall > 0 ? fall : null, counted: mine.counted,
      missed: counts.missed, missedNotice: counts.missedNotice, reasons, latestMissedRaidId: latestMissedRaid(mine.cells, policy, current.windowStart, input.today),
    });
  }
  result.entries.sort((a, b) => a.pct - b.pct || byText(a.playerId, b.playerId));
  return result;
}
