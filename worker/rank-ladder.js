// Rank progression (PM wave 7), the pure half: an optional per-guild ladder of ranks (lowest first, e.g. Member -> Raider -> Core), each with the rules for
// EARNING it, and what those rules say about each person. A rank is a LABEL stored on the person (players.rank); it is separate from the Raider / Trial /
// Reserve / Inactive status, and an officer's choice always stands: the ladder only SUGGESTS a promotion or a review, and an officer accepts it with one
// click or dismisses it for 30 days. Nothing here reads a clock, D1 or the network; the policy stores the ladder (attendance-policy.js: ladder.ranks).
//
// A rank is { id, name, rules }, rules being any of (null or absent = that rule is off):
//   minAttendance      rolling attendance of the policy's default window, a fraction 0..1 (0.85 = 85%)
//   minRaids           raids attended (credit above 0, counted like the %) since `since`
//   minWeeksAttended   different raid weeks with at least one attended raid, since `since`
//   minWeeksSinceJoin  whole weeks since the person's join date
//   maxMissed          raids missed WITHOUT notice in the default window (at most)
//   since              'join' (count from the person's effective start) or 'rank' (count from the day they got their current rank); default 'join'
// A person with no rank is on the first rank; the first rank's rules are never used. A rank with no rules at all is given by hand only.
// Promote: the NEXT rank's rules are all met. Review: the person is under their CURRENT rank's sustained rules (minAttendance, maxMissed) over at least
// REVIEW_MIN_COUNTED counted raids; accepting it moves them down one rank. Only Raiders and Trials are judged (a reserve or an inactive person is not
// expected to come), and a person is judged on the team their Main character is on.
import { addDays, weekStart } from './attendance-calendar.js';
import { summarizeCells, teamMetrics } from './attendance-metrics.js';

export const REVIEW_MIN_COUNTED = 3;
export const DISMISS_DAYS = 30;
const JUDGED_STATUSES = ['raider', 'trial'];
const DAY_MS = 24 * 60 * 60 * 1000;

// The ranks of a resolved policy ([] when the guild has no ladder).
export function ladderOf(policy) {
  const ranks = policy && policy.ladder && Array.isArray(policy.ladder.ranks) ? policy.ladder.ranks : [];
  return ranks.length >= 2 ? ranks : [];
}

const isSet = (value) => value !== null && value !== undefined;
export const hasRules = (rules) => !!rules && ['minAttendance', 'minRaids', 'minWeeksAttended', 'minWeeksSinceJoin', 'maxMissed'].some((key) => isSet(rules[key]));
const tenths = (fraction) => Math.round(fraction * 1000);

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const percentText = (fraction) => `${Math.round(fraction * 1000) / 10}%`;
const countText = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the rules need to know about one person.
function factsOf(person, mine, input, sinceDate) {
  const { policy, today, resetDay } = input;
  const windowStart = addDays(weekStart(today, resetDay), -7 * (policy.window.defaultWeeks - 1));
  const cells = mine.cells || [];
  const inWindow = summarizeCells(cells, { policy, from: windowStart, to: today });
  const since = summarizeCells(cells, { policy, from: sinceDate, to: today });
  const weeks = new Set();
  for (const cell of cells) {
    if (summarizeCells([cell], { policy, from: sinceDate, to: today }).present > 0) weeks.add(cell.weekStart);
  }
  return {
    pct: mine.pct, counted: mine.counted, missedInWindow: inWindow.missed,
    raidsSince: since.present, weeksAttendedSince: weeks.size,
    weeksSinceJoin: person.joinedOn ? Math.floor(daysBetween(person.joinedOn, today) / 7) : null,
  };
}

// The day a rule counts from: the person's own effective start, or the day they got their current rank (when they have one).
function sinceOf(rules, person, mine) {
  if (rules && rules.since === 'rank' && person.rank && person.rankOn) return person.rankOn;
  return mine.start || person.joinedOn || null;
}

// The rules of a rank the person does NOT meet: [] when they meet them all. Each is a sentence ("8 raids attended (needs 10)").
function unmet(rules, person, mine, input) {
  const facts = factsOf(person, mine, input, sinceOf(rules, person, mine));
  const out = [];
  const where = rules.since === 'rank' ? 'since the current rank' : 'since joining';
  if (isSet(rules.minAttendance) && !(facts.pct !== null && Math.round(facts.pct * 10) >= tenths(rules.minAttendance))) {
    out.push(`attendance ${facts.pct === null ? 'not counted yet' : `${facts.pct}%`} (needs ${percentText(rules.minAttendance)})`);
  }
  if (isSet(rules.minRaids) && facts.raidsSince < rules.minRaids) out.push(`${countText(facts.raidsSince, 'raid', 'raids')} attended ${where} (needs ${rules.minRaids})`);
  if (isSet(rules.minWeeksAttended) && facts.weeksAttendedSince < rules.minWeeksAttended) {
    out.push(`${countText(facts.weeksAttendedSince, 'week', 'weeks')} attended ${where} (needs ${rules.minWeeksAttended})`);
  }
  if (isSet(rules.minWeeksSinceJoin) && !(facts.weeksSinceJoin !== null && facts.weeksSinceJoin >= rules.minWeeksSinceJoin)) {
    out.push(`${facts.weeksSinceJoin === null ? 'no join date' : countText(facts.weeksSinceJoin, 'week', 'weeks')} since joining (needs ${rules.minWeeksSinceJoin})`);
  }
  if (isSet(rules.maxMissed) && facts.missedInWindow > rules.maxMissed) out.push(`${countText(facts.missedInWindow, 'raid', 'raids')} missed without notice (allows ${rules.maxMissed})`);
  return out;
}

// What makes a person under their current rank (the sustained rules only): attendance under the minimum, too many misses.
function sustainedProblems(rules, mine, input) {
  const facts = factsOf({ joinedOn: null }, mine, input, null);
  const out = [];
  if (facts.counted < REVIEW_MIN_COUNTED) return out;
  if (isSet(rules.minAttendance) && facts.pct !== null && Math.round(facts.pct * 10) < tenths(rules.minAttendance)) out.push(`attendance ${facts.pct}% (the rank asks ${percentText(rules.minAttendance)})`);
  if (isSet(rules.maxMissed) && facts.missedInWindow > rules.maxMissed) out.push(`${countText(facts.missedInWindow, 'raid', 'raids')} missed without notice (the rank allows ${rules.maxMissed})`);
  return out;
}

// input: teamMetrics' input (people, raids, rows, borrowed, policy, today, resetDay), where people carry { rank, rankOn } as well, plus
//   ladder: the ranks (ladderOf(policy)); nowMs; dismissals: Map playerId -> { kind, to_rank, until };
//   homeTeamOf(playerId) -> the team id of the person's Main (null = unknown), and teamId: the team being judged (a person is judged on their Main's team);
//   metrics: teamMetrics' answer for the policy's default window, when the caller has it already.
// -> Map playerId -> { rank: { id, name, index, set }, suggestion: null | { kind: 'promote' | 'review', from: { id, name }, to: { id, name }, reasons: [text] } }
export function rankReview(input) {
  const ranks = input.ladder;
  const out = new Map();
  if (!Array.isArray(ranks) || ranks.length < 2) return out;
  const { policy } = input;
  const metrics = input.metrics && input.metrics.windowWeeks === policy.window.defaultWeeks ? input.metrics
    : teamMetrics({ ...input, windowWeeks: policy.window.defaultWeeks });
  for (const person of input.people || []) {
    const found = ranks.findIndex((rank) => rank.id === person.rank);
    const index = found >= 0 ? found : 0;
    const entry = { rank: { id: ranks[index].id, name: ranks[index].name, index, set: found >= 0 }, suggestion: null };
    out.set(person.id, entry);
    const mine = metrics.people[person.id];
    const home = input.homeTeamOf ? input.homeTeamOf(person.id) : input.teamId;
    if (!mine || !JUDGED_STATUSES.includes(person.status) || (home && input.teamId && home !== input.teamId)) continue;

    let suggestion = null;
    if (index > 0) {
      const problems = sustainedProblems(ranks[index].rules || {}, mine, input);
      if (problems.length) suggestion = { kind: 'review', from: { id: ranks[index].id, name: ranks[index].name }, to: { id: ranks[index - 1].id, name: ranks[index - 1].name }, reasons: problems };
    }
    if (!suggestion && index < ranks.length - 1) {
      const next = ranks[index + 1];
      const rules = next.rules || {};
      if (hasRules(rules) && !unmet(rules, person, mine, input).length) {
        suggestion = { kind: 'promote', from: { id: ranks[index].id, name: ranks[index].name }, to: { id: next.id, name: next.name }, reasons: describeMet(rules) };
      }
    }
    const dismissed = input.dismissals && input.dismissals.get(person.id);
    if (suggestion && dismissed && dismissed.until > input.nowMs && dismissed.kind === suggestion.kind && dismissed.to_rank === suggestion.to.id) suggestion = null;
    entry.suggestion = suggestion;
  }
  return out;
}

// "Meets: ..." lines for a promotion: the rules that were set.
function describeMet(rules) {
  const out = [];
  if (isSet(rules.minAttendance)) out.push(`attendance of ${percentText(rules.minAttendance)} or more`);
  if (isSet(rules.minRaids)) out.push(`${countText(rules.minRaids, 'raid', 'raids')} attended ${rules.since === 'rank' ? 'since the current rank' : 'since joining'}`);
  if (isSet(rules.minWeeksAttended)) out.push(`${countText(rules.minWeeksAttended, 'week', 'weeks')} attended ${rules.since === 'rank' ? 'since the current rank' : 'since joining'}`);
  if (isSet(rules.minWeeksSinceJoin)) out.push(`${countText(rules.minWeeksSinceJoin, 'week', 'weeks')} since joining`);
  if (isSet(rules.maxMissed)) out.push(`at most ${countText(rules.maxMissed, 'miss', 'misses')} without notice`);
  return out;
}
