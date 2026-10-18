// Attendance consolidation (pure): one outcome per person per raid from the evidence (sign-ups of any source, boss-pull
// presence from the merged Warcraft Logs reports or an officer's manual ticks, officer decisions) and the resolved
// policy; then the second pass that settles Other-team ("fill-in") cells across the raids of one guild-local date.
// No D1, no fetch, no clock, and the input is never mutated. The rule table is in tasks/guild-phase3-spec.md,
// "Consolidation".

// The strongest sign-up kind wins across sources (a plan placement beats a Raid-Helper Absence). A volunteer standby ranks below a plan's bench (a
// benched volunteer is benched) and above tentative; it is an expected kind like signed.
const KIND_RANK = { signed: 6, late: 5, bench: 4, standby: 3, tentative: 2, absence: 1 };
const REPLACEABLE_HOME_OUTCOMES = new Set(['missed', 'no_signup', 'tentative']);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameFlags = (a, b) => a.length === b.length && a.every((flag, i) => flag === b[i]);

function strongestKinds(signups) {
  const best = new Map();
  for (const signup of signups) {
    if (!signup || !signup.playerId || !KIND_RANK[signup.kind]) continue;
    const have = best.get(signup.playerId);
    if (!have || KIND_RANK[signup.kind] > KIND_RANK[have]) best.set(signup.playerId, signup.kind);
  }
  return best;
}

function isExpected(kind, policy) {
  if (kind === 'signed' || kind === 'late' || kind === 'standby') return true;
  if (kind === 'tentative' && policy.tentative === 'asSignedUp') return true;
  return false;
}

function splitKey(key) {
  const at = key.indexOf('|');
  return at < 0 ? { name: key, realm: null } : { name: key.slice(0, at), realm: key.slice(at + 1) || null };
}

// The auto result for one person: { outcome, credit, flags, kind } or null (no row).
function autoResult(ctx, person, kind) {
  const { policy, raid } = ctx;
  const inLog = ctx.inLog.has(person.playerId);
  const hasTeamChar = ctx.teamChars.has(person.playerId);
  const expected = isExpected(kind, policy)
    || (policy.expected.mode === 'statuses' && hasTeamChar && policy.expected.statuses.includes(person.status));
  const stats = ctx.stats.get(person.playerId);

  if (inLog) {
    if (!hasTeamChar) return { outcome: 'fill_in', credit: null, flags: [] }; // row 2
    const forgiven = kind === 'late' && policy.lateSignup === 'fullCreditNoFlag';
    const late = stats.missedFirst && !forgiven;
    const left = stats.missedLast;
    if (!late && !left) return { outcome: 'present', credit: 1, flags: [] }; // rows 3 and 4
    const flags = [];
    if (late) flags.push('late');
    if (left) flags.push('left_early');
    flags.sort();
    const outcome = late && left ? 'late_left' : late ? 'late' : 'left_early'; // row 5
    return { outcome, credit: null, flags };
  }
  if (kind === 'bench') return { outcome: 'bench', credit: policy.bench === 'excluded' ? null : 1, flags: [] }; // row 6
  if (kind === 'absence') return { outcome: 'missed_notice', credit: policy.absence === 'excused' ? null : 0, flags: [] }; // row 7
  if (expected) return { outcome: 'missed', credit: 0, flags: ['no_show'] }; // row 8
  if (kind === 'tentative') return { outcome: 'tentative', credit: null, flags: [] }; // row 9
  if (!kind && hasTeamChar && policy.noSignup === 'shown') return { outcome: 'no_signup', credit: null, flags: [] }; // row 10
  return null; // row 11
}

// -> { rows, unmatched, openFlags }. evidence is described in the spec; two optional extras:
//   evidence.logPlayers: { [key]: { name, realm, class } } for the unmatched entries (else the name comes from the key)
//   evidence.manualKeys: the keys of the names a pasted roster listed (a manual raid only): see below
//   people[].homeTeamId: the team of the person's Main, used for the Other-team credit of a manual tick
export function consolidateRaid(evidence, policy) {
  const raid = evidence.raid || {};
  const empty = { rows: [], unmatched: [], openFlags: 0 };
  if (!raid.manual && !raid.hasLog) return empty; // "Awaiting log": nothing is guessed from sign-ups alone

  const people = [...(evidence.people || [])].sort((a, b) => byText(a.playerId, b.playerId));
  const pulls = [...(evidence.pulls || [])]
    .map((pull) => ({ startedAt: pull.startedAt, keys: new Set(pull.keys || []) }))
    .sort((a, b) => a.startedAt - b.startedAt || byText([...a.keys].sort().join(','), [...b.keys].sort().join(',')));
  const guests = new Set(evidence.guests || []);
  const decisions = evidence.decisions || {};
  const logPlayers = evidence.logPlayers || {};
  const kinds = strongestKinds(evidence.signups || []);
  const manualSet = new Set(evidence.manualPresent || []);

  const personByKey = new Map();
  const teamChars = new Set();
  for (const person of people) {
    for (const character of person.characters || []) {
      if (!personByKey.has(character.key)) personByKey.set(character.key, person.playerId);
      if (character.teamId === raid.teamId) teamChars.add(person.playerId);
    }
  }

  // Presence per person across the sorted pulls, and the unmatched log keys.
  const stats = new Map(people.map((person) => [person.playerId, { pullsPresent: 0, missedFirst: false, missedLast: false, perKey: new Map() }]));
  const unmatchedCounts = new Map();
  pulls.forEach((pull) => {
    const seen = new Set();
    for (const key of pull.keys) {
      const owner = personByKey.get(key);
      if (owner === undefined) {
        if (!guests.has(key)) unmatchedCounts.set(key, (unmatchedCounts.get(key) || 0) + 1);
        continue;
      }
      const entry = stats.get(owner);
      entry.perKey.set(key, (entry.perKey.get(key) || 0) + 1);
      seen.add(owner);
    }
    for (const owner of seen) stats.get(owner).pullsPresent++;
  });

  // A pasted roster (wave 8, a raid with hand-entered attendance): a name that belongs to a person counts that person present, a name nobody owns
  // (and no guest) is unmatched like a log name, once.
  if (raid.manual) {
    for (const key of evidence.manualKeys || []) {
      const owner = personByKey.get(key);
      if (owner !== undefined) manualSet.add(owner);
      else if (!guests.has(key)) unmatchedCounts.set(key, 1);
    }
  }

  const inLog = new Set();
  if (raid.manual) {
    for (const person of people) if (manualSet.has(person.playerId)) inLog.add(person.playerId);
  } else {
    const first = pulls[0];
    const last = pulls[pulls.length - 1];
    for (const person of people) {
      const entry = stats.get(person.playerId);
      if (entry.pullsPresent === 0) continue;
      inLog.add(person.playerId);
      const presentIn = (pull) => (person.characters || []).some((character) => pull.keys.has(character.key));
      entry.missedFirst = !presentIn(first);
      entry.missedLast = !presentIn(last);
    }
  }

  const ctx = { policy, raid, inLog, teamChars, stats };
  const rows = [];
  for (const person of people) {
    const kind = kinds.get(person.playerId) || null;
    const entry = stats.get(person.playerId);
    // Inactive people have no row unless they signed up or raided; one with a left-on date is still expected up to and including that day.
    const leftYet = person.status === 'inactive' && !(person.leftOn && raid.raidOn <= person.leftOn);
    if (leftYet && !kind && !inLog.has(person.playerId)) continue;
    const auto = autoResult(ctx, person, kind);
    if (!auto) continue;

    const decision = decisions[person.playerId];
    const hasDecision = !!decision;
    const decisionValid = hasDecision && Array.isArray(decision.flags) && sameFlags([...decision.flags].sort(), auto.flags);
    const outcome = decisionValid ? decision.outcome : auto.outcome;
    const credit = decisionValid ? (typeof decision.credit === 'number' ? decision.credit : null) : auto.credit;

    let creditTeamId = null;
    if (outcome === 'fill_in') {
      let best = null;
      for (const character of person.characters || []) {
        const count = entry.perKey.get(character.key) || 0;
        if (!best || count > best.count || (count === best.count && byText(character.teamId, best.teamId) < 0)) best = { count, teamId: character.teamId };
      }
      if (raid.manual && person.homeTeamId) creditTeamId = person.homeTeamId;
      else creditTeamId = best ? best.teamId : null;
    }

    rows.push({
      playerId: person.playerId,
      outcome,
      credit,
      autoOutcome: auto.outcome,
      autoCredit: auto.credit,
      signupKind: kind,
      attended: inLog.has(person.playerId) ? 1 : 0,
      presenceSource: raid.manual ? 'officer' : 'log',
      viaRaidId: null,
      pullsPresent: raid.manual ? 0 : entry.pullsPresent,
      pullsTotal: raid.manual ? 0 : pulls.length,
      missedFirst: entry.missedFirst ? 1 : 0,
      missedLast: entry.missedLast ? 1 : 0,
      flags: auto.flags,
      creditTeamId,
      needsReview: auto.flags.length > 0 && !decisionValid ? 1 : 0,
      decisionValid,
      decisionStale: hasDecision && !decisionValid,
    });
  }

  const unmatched = [...unmatchedCounts.keys()].sort(byText).map((key) => {
    const known = logPlayers[key] || {};
    const parts = splitKey(key);
    return {
      key,
      name: known.name || parts.name,
      realm: known.realm !== undefined ? known.realm : parts.realm,
      class: known.class || null,
      pullsPresent: unmatchedCounts.get(key),
    };
  });
  return { rows, unmatched, openFlags: rows.filter((row) => row.needsReview).length + unmatched.length };
}

// Pass 2. day = { raidOn, raids: [ { raidId, teamId, rows, unmatchedCount? } ] } -- EVERY raid of the guild on that
// guild-local date, each with its freshly consolidated rows. policyFor(teamId) -> the resolved policy of that team (the
// HOME team's fillIn decides). Returns { raids: [ { raidId, teamId, rows, openFlags } ] } in the input order, with new row
// objects (the input is untouched). Exactly one cell counts per person per date.
export function resolveFillIns(day, policyFor) {
  const raids = (day.raids || []).map((raid) => ({
    raidId: raid.raidId,
    teamId: raid.teamId,
    unmatchedCount: raid.unmatchedCount || 0,
    rows: (raid.rows || []).map((row) => ({ ...row, flags: [...row.flags] })),
  }));
  const raidOfTeam = new Map();
  for (const raid of [...raids].sort((a, b) => byText(a.raidId, b.raidId))) if (!raidOfTeam.has(raid.teamId)) raidOfTeam.set(raid.teamId, raid);

  // A home cell an earlier pass already turned into an Other-team cell counts for its person.
  const counted = new Set();
  for (const raid of raids) for (const row of raid.rows) if (row.outcome === 'fill_in' && row.viaRaidId) counted.add(row.playerId);

  const hosts = [];
  for (const raid of raids) {
    for (const row of raid.rows) if (row.outcome === 'fill_in' && !row.viaRaidId) { row.credit = null; hosts.push({ raid, row }); }
  }
  hosts.sort((a, b) => byText(a.raid.raidId, b.raid.raidId) || byText(a.row.playerId, b.row.playerId));

  for (const { raid, row } of hosts) {
    const homeTeamId = row.creditTeamId;
    if (!homeTeamId || counted.has(row.playerId)) continue;
    const mode = (policyFor(homeTeamId) || {}).fillIn || 'always';
    if (mode === 'recordOnly') continue;
    const homeRaid = raidOfTeam.get(homeTeamId);
    if (!homeRaid) {
      row.credit = 1; // an extra counted cell on this date
      counted.add(row.playerId);
      continue;
    }
    if (mode === 'homeIfNoRaid') continue;
    const homeRow = homeRaid.rows.find((candidate) => candidate.playerId === row.playerId);
    if (homeRow && REPLACEABLE_HOME_OUTCOMES.has(homeRow.outcome) && !homeRow.decisionValid) {
      homeRow.outcome = 'fill_in';
      homeRow.credit = 1;
      homeRow.flags = [];
      homeRow.needsReview = 0;
      homeRow.viaRaidId = raid.raidId;
      counted.add(row.playerId); // the replaced home cell is the one that counts
    }
  }

  return {
    raids: raids.map((raid) => ({
      raidId: raid.raidId,
      teamId: raid.teamId,
      rows: raid.rows,
      openFlags: raid.rows.filter((row) => row.needsReview).length + raid.unmatchedCount,
    })),
  };
}
