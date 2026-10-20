// Loot balance (pure): per roster person, the raids they could have won loot in (attendedForLoot) and the items they received, over the attendance window and
// all-time. No D1, no clock (`today` is passed in), the input is never mutated. Rules: tasks/reference/guild-phase4-spec.md, section 4.
import { LOOT_TAGS } from './loot-policy.js';

const round3 = (value) => Math.round(value * 1000) / 1000;

// A raid in which the person could have won loot: the effective outcome (the consolidated attendance row, an officer-decided
// Present included) is Attended (present), late, left early, or late and left early. Bench, every absence, a pending sign-up and an
// Other-team cell (fill_in: raiding for another team) do not count.
const LOOT_OUTCOMES = new Set(['present', 'late', 'left_early', 'late_left']);
export function attendedForLoot(row) {
  return LOOT_OUTCOMES.has(row.outcome);
}

const emptyItems = () => Object.fromEntries(LOOT_TAGS.map((tag) => [tag, { window: 0, all: 0 }]));

// input: {
//   people: [{ id, name, class, status }],               // the team's roster people
//   raids: [{ id, raidOn }],                             // the team's raids
//   rows: [{ raidId, playerId, outcome, attended, credit }],   // the team's attendance rows (effective outcome / credit)
//   awards: [{ raidId, personId, tag }],                 // the team's awards that match a character of a person (guests, unmatched left out)
//   countTags: ['MS'], windowStart: 'YYYY-MM-DD' | null, today: 'YYYY-MM-DD' }
// -> { people: [{ personId, name, class, status, raids, items, counted, perRaid, vsTeam }], teamAverage: { window, all } }
// raids / items / counted / perRaid are { window, all } (items: one per tag). perRaid is counted / raids, null with no raids;
// teamAverage is the mean perRaid of the people with at least one raid; vsTeam is the person's window perRaid minus the window
// average (null when either is null). A person who is Inactive is listed only when they received something in the window.
export function lootBalance(input) {
  const { countTags, windowStart, today } = input;
  const raidOn = new Map((input.raids || []).map((raid) => [raid.id, raid.raidOn]));
  const inWindow = (date) => date <= today && (windowStart === null || date >= windowStart);

  const attended = new Map(); // personId -> Set of raid ids
  for (const row of input.rows || []) {
    if (!raidOn.has(row.raidId) || !attendedForLoot(row)) continue;
    if (!attended.has(row.playerId)) attended.set(row.playerId, new Set());
    attended.get(row.playerId).add(row.raidId);
  }
  const items = new Map(); // personId -> { tag: { window, all } }
  for (const award of input.awards || []) {
    const date = raidOn.get(award.raidId);
    if (date === undefined || !LOOT_TAGS.includes(award.tag)) continue;
    if (!items.has(award.personId)) items.set(award.personId, emptyItems());
    const counts = items.get(award.personId)[award.tag];
    counts.all++;
    if (inWindow(date)) counts.window++;
  }

  const rows = [];
  for (const person of input.people || []) {
    const mine = items.get(person.id) || emptyItems();
    if (person.status === 'inactive' && !LOOT_TAGS.some((tag) => mine[tag].window > 0)) continue;
    const raidIds = attended.get(person.id) || new Set();
    const raids = { window: 0, all: raidIds.size };
    for (const raidId of raidIds) if (inWindow(raidOn.get(raidId))) raids.window++;
    const counted = {
      window: countTags.reduce((sum, tag) => sum + mine[tag].window, 0),
      all: countTags.reduce((sum, tag) => sum + mine[tag].all, 0),
    };
    rows.push({
      person,
      raids,
      items: mine,
      counted,
      perRaid: {
        window: raids.window > 0 ? counted.window / raids.window : null,
        all: raids.all > 0 ? counted.all / raids.all : null,
      },
    });
  }

  const average = (key) => {
    const values = rows.map((row) => row.perRaid[key]).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const mean = { window: average('window'), all: average('all') };
  const rounded = (value) => (value === null ? null : round3(value));

  return {
    people: rows.map((row) => ({
      personId: row.person.id,
      name: row.person.name,
      class: row.person.class,
      status: row.person.status,
      raids: row.raids,
      items: row.items,
      counted: row.counted,
      perRaid: { window: rounded(row.perRaid.window), all: rounded(row.perRaid.all) },
      vsTeam: row.perRaid.window !== null && mean.window !== null ? round3(row.perRaid.window - mean.window) : null,
    })).sort((a, b) => a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId)),
    teamAverage: { window: rounded(mean.window), all: rounded(mean.all) },
  };
}
