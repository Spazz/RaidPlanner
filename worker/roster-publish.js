// Publishing the roster, the pure half (no I/O): an officer presses "Publish roster" and the raid's plan placements are frozen as the roster (raid_roster) that
// members see and answer: who sits in which group, or on the bench (group 0), and whether they confirmed or said they cannot make it. The routes in
// worker/routes/roster-publish.js read the rows and call these.
import { signUpSpecLabel } from './signups-data.js';
import { isSpecOf } from './roster-data.js';

export const ROSTER_STATUSES = ['pending', 'confirmed', 'declined'];

// The seats of a plan. plan: [{ name, name_key, group_number }] in plan order; characters: the guild's characters whose name key is in the plan
// ({ id, player_id, name_key, class, main_spec, is_main, team_id }); signups: the people's sign-ups on this raid ({ player_id, source, spec_name });
// teamId: the raid's team. A plan name is matched to a person by the character name, a character on the raid's team first (then a Main, then the first by id);
// the class is the character's, the spec the one the person signed up with on this raid when it is a spec of that class, else the character's main spec.
// -> [{ name, nameKey, personId | null, className | null, spec | null, group, seq }]
export function buildSeats({ plan, characters, signups, teamId }) {
  const byKey = new Map();
  for (const character of characters) {
    if (!byKey.has(character.name_key)) byKey.set(character.name_key, []);
    byKey.get(character.name_key).push(character);
  }
  const signedSpec = new Map(); // personId -> spec label of their effective sign-up (a Raidsmith one replaces a Raid-Helper one)
  for (const row of [...signups].sort((a, b) => (a.source === 'raidsmith') - (b.source === 'raidsmith'))) {
    if (row.player_id) signedSpec.set(row.player_id, signUpSpecLabel(row));
  }
  const rank = (character) => [character.team_id === teamId ? 0 : 1, character.is_main === 1 ? 0 : 1, character.id];
  const compare = (a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    return 0;
  };
  return plan.map((entry, index) => {
    const character = [...(byKey.get(entry.name_key) || [])].sort(compare)[0] || null;
    let spec = null;
    if (character) {
      const signed = signedSpec.get(character.player_id);
      if (signed && isSpecOf(character.class, signed)) spec = signed;
      else if (character.main_spec && isSpecOf(character.class, character.main_spec)) spec = character.main_spec;
    }
    return {
      name: entry.name,
      nameKey: entry.name_key,
      personId: character ? character.player_id : null,
      className: character ? character.class : null,
      spec,
      group: entry.group_number,
      seq: index,
    };
  });
}

// How many of the new seats are the same seat as before (same name, same group): their answers are kept. existing: [{ name_key, group_number }]
export function keptSeats(seats, existing) {
  const before = new Map(existing.map((row) => [row.name_key, row.group_number]));
  return seats.filter((seat) => before.get(seat.nameKey) === seat.group).length;
}

// True when the plan as it is now differs from the published roster (a name added, removed or moved to another group).
export function planChanged(roster, plan) {
  const seats = new Set(roster.map((row) => `${row.name_key}|${row.group_number}`));
  const now = new Set(plan.map((row) => `${row.name_key}|${row.group_number}`));
  return seats.size !== now.size || [...now].some((seat) => !seats.has(seat));
}

export const rosterCounts = (rows) => ({
  pending: rows.filter((row) => row.status === 'pending').length,
  confirmed: rows.filter((row) => row.status === 'confirmed').length,
  declined: rows.filter((row) => row.status === 'declined').length,
  total: rows.length,
});
