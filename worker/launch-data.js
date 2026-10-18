// The Launch funnel (wave 8), the pure half: the stages a person goes through to be ready for the launch of a new WoW version, how a row and the team's
// totals are worked out from what the guild already knows (the intent board, the roster, a Battle.net claim's level) and what someone typed in
// (launch_status). The routes are worker/routes/launch.js.
//   intent picked  ->  character created  ->  level band  ->  attuned / ready
// - intent: the person has a main pick in the team's current (else latest) intent round.
// - character: they have a character on the team; once they picked, one of the class they picked.
// - level: a band is known - typed by an officer or the person, else from an approved Battle.net claim's level.
// - ready: the manual tick ("attuned / ready").
// Each stage is counted on its own; a person's `stage` is how far they have come in a row from the first.
import { RAID_ROLES, defaultTargets } from './recruit-data.js';

export const STAGES = ['intent', 'character', 'level', 'ready'];
export const LEVEL_BANDS = ['1-19', '20-39', '40-59', '60+'];
const TOP_BAND = LEVEL_BANDS[LEVEL_BANDS.length - 1];

// A Forever guild always has the funnel; any other version only for a team marked as a launch team.
export const launchEnabled = (guild, team) => guild.game_version === 'forever' || team.launch_team === 1;

// A character level (from Battle.net) -> its band.
export function bandOfLevel(level) {
  if (!Number.isInteger(level) || level < 1) return null;
  if (level < 20) return LEVEL_BANDS[0];
  if (level < 40) return LEVEL_BANDS[1];
  if (level < 60) return LEVEL_BANDS[2];
  return TOP_BAND;
}

// person: { id, status, name, class }; pick: the person's main pick { class, spec, role } | null; characterClasses: classes of their characters on the team;
// status: the launch_status row { level_band, ready } | null; bnetLevel: the highest level of an approved claim on one of their characters | null.
export function funnelRow(person, pick, characterClasses, status, bnetLevel) {
  const typed = status && LEVEL_BANDS.includes(status.level_band) ? status.level_band : null;
  const fromBnet = bandOfLevel(bnetLevel);
  const band = typed || fromBnet;
  const flags = {
    intent: !!pick,
    character: characterClasses.length > 0 && (!pick || characterClasses.includes(pick.class)),
    level: band !== null,
    ready: !!status && status.ready === 1,
  };
  let stage = 0;
  while (stage < STAGES.length && flags[STAGES[stage]]) stage += 1;
  return {
    personId: person.id,
    name: person.name || 'Unknown',
    class: person.class || null,
    status: person.status,
    role: pick ? pick.role : null,
    intent: pick ? { class: pick.class, spec: pick.spec } : null,
    level: band === null ? null : { band, source: typed ? 'manual' : 'battlenet' },
    ready: flags.ready,
    flags,
    stage,
  };
}

// rows (funnelRow results), size (the team's raid size), targets (the team's role targets, else its size's defaults) ->
// { people, stages: { intent, character, level, topLevel, ready }, gap (size - ready, never below 0), roles: [{ role, people, intent, character, level, ready, target, gap }] }.
// The people with no pick have no role: they are in the totals and in the 'none' line.
export function funnelTotals(rows, size, targets) {
  const count = (list, key) => list.filter((row) => row.flags[key]).length;
  const wanted = targets || defaultTargets(size);
  const line = (role, list, target) => ({
    role, people: list.length, intent: count(list, 'intent'), character: count(list, 'character'), level: count(list, 'level'), ready: count(list, 'ready'),
    target, gap: target === null ? null : Math.max(0, target - count(list, 'ready')),
  });
  return {
    people: rows.length,
    stages: {
      intent: count(rows, 'intent'), character: count(rows, 'character'), level: count(rows, 'level'),
      topLevel: rows.filter((row) => row.level && row.level.band === TOP_BAND).length, ready: count(rows, 'ready'),
    },
    gap: Math.max(0, size - count(rows, 'ready')),
    roles: [...RAID_ROLES.map((role) => line(role, rows.filter((row) => row.role === role), wanted[role])), line('none', rows.filter((row) => !row.role), null)],
  };
}
