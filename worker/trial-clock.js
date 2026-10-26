// The Trial clock (user-hierarchy build, lane B4b; plan "Model" > Trial, U R3-Q6). A Trial character's dates start with its team's raids, not with the day the rank
// changed:
//
//   trial_start   the date of the FIRST raid of the character's own team that logged the character (raid_presence), on or after the day it entered Trial
//   trial_end     trial_start + teams.trial_days (14 by default); a Team Lead may edit it afterwards
//   written       by ONE set-based UPDATE ... WHERE trial_end IS NULL, so a clock that has started is never moved by a later run (a hand-set end date is final too)
//   restarted     entering Trial by a rank change clears both (worker/rank-map.js applyRankMap, and the officer rank edit); the clock then starts again at the next raid
//
// Where it runs: at the end of every raid recompute (worker/attendance-store.js recomputeRaid: a raid with a log is what starts a clock), and in every rank-map apply
// (the roster sync and a map edit; lane B9's flip backfill is the same statement). Each run is idempotent and independent of the order raids are recomputed in.
//
// "On or after the day it entered Trial": NOTHING stores the day a character entered Trial (no column; this lane adds no migration). Every writer of a rank sets
// characters.updated_at = now in the same statement, so the floor is the guild-local date of updated_at. A later edit of the character (a rename, a team move)
// moves the floor forward, which only ever matters before the clock has started. A column (characters.trial_since) would make it exact: the floor is ONE
// expression (FLOOR_SQL), so that is a one-line swap. See the lane report.
import { resolvedNameKeySql } from './name-alias.js';

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

// SQL (one placeholder: the offset modifier): the guild-local date the character last had its rank written.
const FLOOR_SQL = `date(characters.updated_at / 1000, 'unixepoch', ?)`;

// A presence row is the character's when its stored name, read as of the raid, is the name the character carries today (renames: worker/name-alias.js).
const PRESENCE_IS_CHARACTER = `${resolvedNameKeySql({ guild: 'rp.guild_id', nameKey: 'rp.name_key', realmKey: 'rp.realm_key', at: 'pr.starts_at' })} = characters.name_key`;

// SQL (one placeholder: the offset modifier): the date of the first raid of the character's team that logged it, on or after the floor; NULL when none.
// A scalar subquery on the UPDATE target (named `characters`).
const FIRST_RAID_SQL = `(SELECT MIN(pr.raid_on) FROM raid_presence rp JOIN raids pr ON pr.guild_id = rp.guild_id AND pr.id = rp.raid_id
     WHERE rp.guild_id = characters.guild_id AND rp.realm_key = characters.realm_key
       AND (rp.name_key = characters.name_key
            OR rp.name_key IN (SELECT nal.name_key FROM character_name_aliases nal WHERE nal.guild_id = characters.guild_id AND nal.character_id = characters.id))
       AND ${PRESENCE_IS_CHARACTER} AND pr.team_id = characters.team_id AND pr.raid_on >= ${FLOOR_SQL})`;

const CLOCK_SQL = `UPDATE characters
   SET trial_start = ${FIRST_RAID_SQL},
       trial_end = date(${FIRST_RAID_SQL}, '+' || (SELECT t.trial_days FROM teams t WHERE t.id = characters.team_id AND t.guild_id = characters.guild_id) || ' days')
 WHERE guild_id = ? AND core_rank = 'trial' AND team_id IS NOT NULL AND left_on IS NULL AND trial_end IS NULL
   AND ${FIRST_RAID_SQL} IS NOT NULL`;

// One statement for a db.batch: starts the clock of every Trial character of the guild that has none and has a qualifying raid. guards: [{ sql, params }] appended
// with AND (the batch guards of the caller). offsetMinutes: the guild zone's UTC offset (zoneOffsetMinutes).
export function trialClockStatement(db, guildId, { offsetMinutes = 0, guards = [] } = {}) {
  const modifier = offsetModifier(offsetMinutes);
  const sql = guards.length ? `${CLOCK_SQL} AND ${guards.map((guard) => guard.sql).join(' AND ')}` : CLOCK_SQL;
  return db.prepare(sql).bind(modifier, modifier, guildId, modifier, ...guards.flatMap((guard) => guard.params));
}
