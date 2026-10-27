// The Trial clock (user-hierarchy build, lane B4b; rewritten for the user decision of 2026-10-26, which replaces H-Q24 and R3-Q6). A Trial character's dates start
// when the character ENTERED ITS TEAM, not with the first raid and not with an edit of the character:
//
//   trial_start   the guild-local date of the later of two instants: characters.team_since (the character was placed on its current team) and characters.trial_since (its
//                 rank became Trial; a trial cannot start before the character was a Trial). Entering Trial while already on the team therefore starts today, being placed on
//                 a team while already a Trial starts at the placement, and a team move restarts the clock on the new team.
//   trial_end     trial_start + teams.trial_days (14 by default); a Team Lead may edit it afterwards
//   written       by ONE set-based UPDATE ... WHERE trial_end IS NULL, so a clock that has started is never moved by a later run
//   kept          a hand-set date is never overwritten by the clock: trial_end set = the row is skipped; trial_start set (typed by an officer, or the start of an accepted
//                 application) = kept, and only the end is filled from it. The only things that clear the dates are a rank change (worker/rank-map.js applyRankMap, the
//                 officer rank edit: both write NULL dates and the clock starts again) and a team move (trigger characters_trial_restart, migration 0040).
//
// team_since and trial_since are kept by triggers (migration 0040), so no writer sets them. The clock reads them with a fallback to created_at for team_since, so a row
// the triggers never stamped (none after the backfill) still gets its dates.
//
// Where it runs: at the end of every raid recompute (worker/attendance-store.js recomputeRaid), in every rank-map apply (the roster sync and a map edit; lane B9's flip
// backfill is the same statement), and, scoped to the character or person that just changed, in the writers that start a clock themselves (the officer rank edit, a team
// placement, a team move). It no longer depends on a raid being logged. Each run is idempotent and independent of the order anything happens in.

// The UTC offset, in minutes, of an IANA time zone at an instant (epoch ms). 0 for a zone the runtime does not know.
export function zoneOffsetMinutes(timeZone, ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type) => Number(parts.find((part) => part.type === type).value);
    const wall = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

// The SQLite date modifier for an offset: '-240 minutes'.
export const offsetModifier = (minutes) => `${Number.isFinite(minutes) ? Math.trunc(minutes) : 0} minutes`;

// SQL (one placeholder: the offset modifier) on the UPDATE target (named `characters`): the guild-local date the clock starts on.
const START_SQL = `date(MAX(COALESCE(characters.team_since, characters.created_at), COALESCE(characters.trial_since, 0)) / 1000, 'unixepoch', ?)`;

const CLOCK_SQL = `UPDATE characters
   SET trial_start = COALESCE(trial_start, ${START_SQL}),
       trial_end = date(COALESCE(trial_start, ${START_SQL}), '+' || (SELECT t.trial_days FROM teams t WHERE t.id = characters.team_id AND t.guild_id = characters.guild_id) || ' days')
 WHERE guild_id = ? AND core_rank = 'trial' AND team_id IS NOT NULL AND left_on IS NULL AND trial_end IS NULL`;

// One statement for a db.batch: starts the clock of every Trial character of the guild that has none. offsetMinutes: the guild zone's UTC offset (zoneOffsetMinutes).
// personId / characterId: only that person's / that character's clock (the writers that start one). guards: [{ sql, params }] appended with AND (the batch guards of
// the caller).
export function trialClockStatement(db, guildId, { offsetMinutes = 0, guards = [], personId = null, characterId = null } = {}) {
  const modifier = offsetModifier(offsetMinutes);
  const scope = [];
  if (personId) scope.push({ sql: 'player_id = ?', params: [personId] });
  if (characterId) scope.push({ sql: 'id = ?', params: [characterId] });
  const extra = [...scope, ...guards];
  const sql = extra.length ? `${CLOCK_SQL} AND ${extra.map((guard) => guard.sql).join(' AND ')}` : CLOCK_SQL;
  return db.prepare(sql).bind(modifier, modifier, guildId, ...extra.flatMap((guard) => guard.params));
}
