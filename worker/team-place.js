// Putting a character on a team, taking it off, moving it (user-hierarchy build, lane B3). The ONE place that writes characters.team_id for these acts: the team
// routes (worker/routes/team-placement.js), the approval of a team request, an accepted application and the claim code share these statements.
//
// A character sits on one team at most, and a person has one character per team (U R3-Q1/R4-Q1; unique index characters_team_person, migration 0032 is the
// backstop). Every statement is GUARDED: it matches only while the character belongs to the person and the guild the caller loaded, is on the team the
// caller saw (`from`; null = on no team), the team is an active team of THE SAME guild, and the person has no other character on it. A lost race changes
// nothing (changes() = 0), and the caller answers 409.
//   place    a character on no team gets a team                         authorized by roster.edit on the TARGET team
//   release  a character leaves its team                                authorized by roster.edit on the team it is on (its Team Leads, officers, Guild Master)
//   move     release + place in ONE statement (the character never sits on no team in between, so nothing else can claim it half way)
//            authorized by roster.edit on BOTH teams: the current lead releases first (U R3-Q8); a lead of the target team alone is told to ask.
import { markRaidsStale } from './attendance-store.js';

// -> a statement. `from`: the team the character must be on now (null = none). `extra`: { sql, params } another guard (the Seniority guard of a move).
const PLACE_SQL = `UPDATE characters SET team_id = ?, updated_at = ?
      WHERE id = ? AND player_id = ? AND guild_id = ? AND team_id IS ?
        AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)
        AND NOT EXISTS (SELECT 1 FROM characters o WHERE o.player_id = characters.player_id AND o.team_id = ? AND o.id != characters.id)`;
const RELEASE_SQL = `UPDATE characters SET team_id = NULL, updated_at = ?
      WHERE id = ? AND player_id = ? AND guild_id = ? AND team_id IS ? AND team_id IS NOT NULL`;
const guarded = (sql, extra) => (extra ? `${sql} AND ${extra.sql}` : sql);

export function placeStatement(db, { guildId, personId, characterId, teamId, from = null, now, extra = null }) {
  return db.prepare(guarded(PLACE_SQL, extra)).bind(teamId, now, characterId, personId, guildId, from, teamId, guildId, teamId, ...(extra ? extra.params : []));
}

export function releaseStatement(db, { guildId, personId, characterId, from, now, extra = null }) {
  return db.prepare(guarded(RELEASE_SQL, extra)).bind(now, characterId, personId, guildId, from, ...(extra ? extra.params : []));
}

// The person's upcoming sign-ups for a team: the native sign-ups (not a guest's, not a Raid-Helper row, which lives in Discord) on the team's raids that have
// not started, and the person's standing sign-ups for the team. Leaving the team ends both.
export async function upcomingSignupsOf(db, guildId, personId, teamId, nowMs) {
  const [signupResult, standingResult] = await db.batch([
    db.prepare(
      `SELECT s.raid_id, s.signup_id, s.kind, s.standby, s.standing, s.character_id, r.raid_on, r.starts_at, r.zone, COALESCE(r.title, r.event_title) AS title
         FROM raid_signups s JOIN raids r ON r.id = s.raid_id AND r.guild_id = s.guild_id
        WHERE s.guild_id = ? AND s.source = 'raidsmith' AND s.guest = 0 AND s.player_id = ? AND r.team_id = ? AND r.starts_at > ?
        ORDER BY r.starts_at, r.id`,
    ).bind(guildId, personId, teamId, nowMs),
    db.prepare('SELECT weekday, kind FROM standing_signups WHERE guild_id = ? AND team_id = ? AND player_id = ? ORDER BY weekday').bind(guildId, teamId, personId),
  ]);
  return {
    signups: signupResult.results.map((row) => ({
      raidId: row.raid_id, raidOn: row.raid_on, startsAt: row.starts_at, zone: row.zone, title: row.title,
      kind: row.kind === 'signed' && row.standby === 1 ? 'standby' : row.kind, standing: row.standing === 1,
    })),
    standing: standingResult.results.map((row) => ({ weekday: row.weekday, kind: row.kind })),
  };
}

// The statements that drop the same, for a db.batch AFTER the statement that took the character off the team. `left` ({ sql, params }) says the person no
// longer has a character on the team (the batch's own release may have lost a race, then nothing here may run).
const DROP_SIGNUPS_SQL = `DELETE FROM raid_signups WHERE guild_id = ? AND source = 'raidsmith' AND guest = 0 AND player_id = ?
         AND raid_id IN (SELECT id FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at > ?)`;
const DROP_STANDING_SQL = 'DELETE FROM standing_signups WHERE guild_id = ? AND team_id = ? AND player_id = ?';
// The team's upcoming raids read their sign-ups: stale and re-versioned.
const BUMP_UPCOMING_SQL = "UPDATE raids SET policy_fp = '', version = version + 1 WHERE guild_id = ? AND team_id = ? AND starts_at > ?";

export function dropUpcomingSignupsStatements(db, { guildId, personId, teamId, nowMs, left }) {
  return [
    db.prepare(guarded(DROP_SIGNUPS_SQL, left)).bind(guildId, personId, guildId, teamId, nowMs, ...left.params),
    db.prepare(guarded(DROP_STANDING_SQL, left)).bind(guildId, teamId, personId, ...left.params),
    db.prepare(guarded(BUMP_UPCOMING_SQL, left)).bind(guildId, teamId, nowMs, ...left.params),
  ];
}

// "The person has no character on the team": the guard for the statements above.
export const personLeftTeamSql = (guildId, personId, teamId) => ({
  sql: 'NOT EXISTS (SELECT 1 FROM characters lc WHERE lc.guild_id = ? AND lc.player_id = ? AND lc.team_id = ?)',
  params: [guildId, personId, teamId],
});

// Raids whose results depend on this character or on these teams' rosters.
export const staleStatement = (db, guildId, nameKeys, teamIds) => markRaidsStale(db, guildId, nameKeys, null, teamIds.filter(Boolean));
