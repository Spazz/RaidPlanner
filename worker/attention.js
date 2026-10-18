// Needs attention, the pure half (no I/O, no clock): turns the rows worker/routes/attention.js read into the one list of open work an officer
// or team lead sees on the guild home page. Each item carries the fields its sentence needs and a `link` (a pages route without the guild id).
// Which items a viewer gets follows their rights per team: `allowsTeam(action, teamId)` and `granted(action)` come from the permission check.

export const ATTENTION_KINDS = ['review', 'loot_unmatched', 'signup_unmatched', 'claims', 'trial', 'watch', 'no_loot', 'low_signups', 'roster_declined', 'unlocked'];
export const KIND_CAP = 10;              // items shown per kind; the rest are counted in `more`
export const INFO_KINDS = ['unlocked'];  // listed, but not part of the open-work count
export const TRIAL_DAYS = 7;
export const LOOT_LOOKBACK_DAYS = 14;
export const SIGNUP_LOOKAHEAD_DAYS = 7;
export const UNLOCKED_MINUTES = 60;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A trial's days left: negative once it ended.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// input: {
//   today, now, teams: [{ id, name, size, archived }], allowsTeam(action, teamId), granted(action),
//   flaggedRaids: [{ id, team_id, raid_on, zone, title, event_title, open_flags }],
//   lootUnmatched: [{ raid_id, team_id, raid_on, zone, title, event_title, names }],
//   signupUnmatched: [{ raid_id, team_id, raid_on, zone, title, event_title, n }],
//   claims: number, trials: [{ id, trial_end, name, class, team_id }],
//   noLoot: [{ id, team_id, raid_on, zone, title, event_title }],
//   rosterDeclined: [{ id, team_id, raid_on, starts_at, zone, title, event_title, n }]   (upcoming raids with a published roster: n seats said "can't make it")
//   upcoming: [{ id, team_id, raid_on, starts_at, zone, title, event_title, signups_locked, n_in, size (the raid's effective size; the team's when left out),
//                close_hours (the sign-up deadline in hours before the start; 0 or left out = at the start) }],
//   watch: [{ teamId, entries: [{ playerId, name, class, pct, previousPct, drop, reasons }] }] }
// -> { items, more: { kind: n }, total } (total counts the 'action' items only, hidden ones included)
export function buildAttention(input) {
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const live = (teamId) => {
    const team = teamById.get(teamId);
    return !!team && team.archived === 0;
  };
  const here = (action, teamId) => live(teamId) && input.allowsTeam(action, teamId);
  const base = (kind, teamId, severity = 'action') => ({ kind, severity, teamId: teamId || null, teamName: teamId && teamById.has(teamId) ? teamById.get(teamId).name : null });
  const raidFields = (row) => ({ raidId: row.id || row.raid_id, date: row.raid_on, zone: row.zone || null, title: row.title || row.event_title || null });
  const groups = {};
  const add = (kind, item, order) => { (groups[kind] = groups[kind] || []).push({ item, order }); };

  for (const row of input.flaggedRaids) {
    if (!here('attendance.review', row.team_id)) continue;
    add('review', { ...base('review', row.team_id), ...raidFields(row), count: row.open_flags, id: `review:${row.id}`, link: { name: 'raid', rid: row.id } }, [-dateNumber(row.raid_on)]);
  }
  for (const row of input.lootUnmatched) {
    if (!(here('loot.edit', row.team_id) && here('attendance.review', row.team_id))) continue;
    add('loot_unmatched', { ...base('loot_unmatched', row.team_id), ...raidFields(row), count: row.names, id: `loot_unmatched:${row.raid_id}`, link: { name: 'review' } }, [-dateNumber(row.raid_on)]);
  }
  for (const row of input.signupUnmatched) {
    if (!here('roster.edit', row.team_id)) continue;
    add('signup_unmatched', { ...base('signup_unmatched', row.team_id), ...raidFields(row), count: row.n, id: `signup_unmatched:${row.raid_id}`, link: { name: 'raid', rid: row.raid_id } }, [dateNumber(row.raid_on)]);
  }
  if (input.claims > 0 && input.granted('roster.edit')) {
    add('claims', { ...base('claims', null), count: input.claims, id: 'claims', link: { name: 'review' } }, [0]);
  }
  for (const row of input.trials) {
    if (!here('roster.edit', row.team_id)) continue;
    const days = daysBetween(input.today, row.trial_end);
    if (days > TRIAL_DAYS) continue;
    add('trial', {
      ...base('trial', row.team_id), personId: row.id, name: row.name, class: row.class, trialEnd: row.trial_end, days, ended: days < 0,
      id: `trial:${row.id}`, link: { name: 'person', pid: row.id },
    }, [days]);
  }
  for (const list of input.watch) {
    if (!here('attendance.review', list.teamId)) continue;
    for (const entry of list.entries) {
      add('watch', {
        ...base('watch', list.teamId), personId: entry.playerId, name: entry.name, class: entry.class, pct: entry.pct, previousPct: entry.previousPct,
        drop: entry.drop, reasons: entry.reasons, id: `watch:${list.teamId}:${entry.playerId}`, link: { name: 'personatt', pid: entry.playerId },
      }, [entry.pct]);
    }
  }
  for (const row of input.noLoot) {
    if (!here('loot.edit', row.team_id)) continue;
    add('no_loot', { ...base('no_loot', row.team_id), ...raidFields(row), id: `no_loot:${row.id}`, link: { name: 'raid', rid: row.id } }, [-dateNumber(row.raid_on)]);
  }
  for (const row of input.upcoming) {
    if (!here('raids.edit', row.team_id)) continue;
    const team = teamById.get(row.team_id);
    const fields = { ...raidFields(row), startsAt: row.starts_at };
    const size = row.size ?? team.size;
    if (row.n_in < size) {
      add('low_signups', { ...base('low_signups', row.team_id), ...fields, expected: row.n_in, size, id: `low_signups:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
    }
    const minutes = Math.ceil((row.starts_at - input.now) / 60000);
    const deadlinePassed = (row.close_hours || 0) > 0 && row.starts_at - row.close_hours * 3600000 <= input.now; // members are shut out already
    if (row.signups_locked === 0 && !deadlinePassed && minutes > 0 && minutes <= UNLOCKED_MINUTES) {
      add('unlocked', { ...base('unlocked', row.team_id, 'info'), ...fields, minutes, id: `unlocked:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
    }
  }

  for (const row of input.rosterDeclined || []) {
    if (!here('raids.edit', row.team_id)) continue;
    add('roster_declined', { ...base('roster_declined', row.team_id), ...raidFields(row), startsAt: row.starts_at, count: row.n, id: `roster_declined:${row.id}`, link: { name: 'raid', rid: row.id } }, [row.starts_at]);
  }

  const items = [];
  const more = {};
  for (const kind of ATTENTION_KINDS) {
    const list = (groups[kind] || []).sort((a, b) => compareOrder(a.order, b.order) || byText(a.item.id, b.item.id));
    if (list.length > KIND_CAP) more[kind] = list.length - KIND_CAP;
    for (const entry of list.slice(0, KIND_CAP)) items.push(entry.item);
  }
  // The count is of everything open, including what the per-kind cap leaves out of the list.
  const hidden = Object.keys(more).filter((kind) => !INFO_KINDS.includes(kind)).reduce((sum, kind) => sum + more[kind], 0);
  return { items, more, total: items.filter((item) => item.severity === 'action').length + hidden };
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
