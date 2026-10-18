// The team progress board, the reads: the pulls of one team's raids (or of several teams' in one batch) and the board built from them.
// The pure half is worker/progress.js. Only derived data is read: encounter, kill flag, times, and the raid's date and zone.
import { buildProgress } from './progress.js';

// The cap on pulls read for one team: far above a real team's history (a night is some 50 to 100 pulls), a guard on the response time.
export const PROGRESS_PULL_CAP = 30000;

export const progressPullsStatement = (db, guildId, teamId) => db.prepare(
  `SELECT p.raid_id, r.raid_on, r.zone, p.encounter_id, p.encounter_name, p.kill, p.started_at, p.ended_at
     FROM raid_pulls p JOIN raids r ON r.id = p.raid_id
    WHERE r.guild_id = ? AND r.team_id = ?
    ORDER BY p.started_at DESC, p.id DESC LIMIT ?`,
).bind(guildId, teamId, PROGRESS_PULL_CAP);

// -> the board of one team: { zones: [...] } (see progress.js buildProgress)
export async function loadProgress(db, guild, teamId) {
  const result = await progressPullsStatement(db, guild.id, teamId).all();
  return buildProgress(result.results, guild.game_version);
}
