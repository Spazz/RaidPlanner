// Away notices, the reading half of the views: the statements that put a team's notices, the characters that name the people and the real sign-ups that
// outrank a notice into a db.batch, and the shaping of their rows for worker/away.js. The sign-up panel, the Raids list, the calendar feed and the
// Planner seed all read through here, so they agree on who is away. Nothing here selects a notice's reason: it is not part of any of those views.
// Dates are guild-local YYYY-MM-DD and bounds are inclusive.
import { noticeOfRow, raidNoticeEffects } from './away.js';
import { ownPlayerSql } from './membership.js';
import { notInactiveSql } from './person-legacy.js';

// The notices that can touch the dates from..to of the people who have a character on the team and are not inactive. `own` marks the viewer's own person.
export function teamNoticesStatement(db, guildId, teamId, userId, from, to) {
  return db.prepare(
    `SELECT n.id, n.player_id, n.kind, n.at_time, n.starts_on, n.ends_on, n.weekday, n.created_at,
            n.player_id IN (SELECT id FROM players WHERE guild_id = ?1 AND ${ownPlayerSql('players', '?5')}) AS own
       FROM away_notices n JOIN players p ON p.id = n.player_id AND p.guild_id = n.guild_id
      WHERE n.guild_id = ?1 AND ${notInactiveSql('p')} AND n.starts_on <= ?3 AND (n.ends_on IS NULL OR n.ends_on >= ?2)
        AND n.player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?4)`,
  ).bind(guildId, from, to, teamId, userId);
}

// Their characters on the team: the name a person is shown by.
export function teamCharactersStatement(db, guildId, teamId, from, to) {
  return db.prepare(
    `SELECT id, player_id, name, class, main_spec, is_main, team_id FROM characters
      WHERE guild_id = ?1 AND team_id = ?2
        AND player_id IN (SELECT player_id FROM away_notices WHERE guild_id = ?1 AND starts_on <= ?4 AND (ends_on IS NULL OR ends_on >= ?3))`,
  ).bind(guildId, teamId, from, to);
}

// Which of those people already have a real (Raidsmith or Raid-Helper) sign-up on the team's raids that start after `now`: [{ raid_id, player_id }].
export function realSignupsStatement(db, guildId, teamId, now, from, to) {
  return db.prepare(
    `SELECT s.raid_id, s.player_id FROM raid_signups s
      WHERE s.source IN ('raid_helper', 'raidsmith') AND s.player_id IS NOT NULL
        AND s.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND starts_at > ?3)
        AND s.player_id IN (SELECT player_id FROM away_notices WHERE guild_id = ?1 AND starts_on <= ?5 AND (ends_on IS NULL OR ends_on >= ?4))`,
  ).bind(guildId, teamId, now, from, to);
}

// A teamNoticesStatement result -> notices for worker/away.js, each with `own` (true for the viewer's own person).
export const readNotices = (rows) => rows.map((row) => ({ ...noticeOfRow(row), own: row.own === 1 }));

// characters rows -> Map personId -> [rows].
export function charactersByPerson(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.player_id)) map.set(row.player_id, []);
    map.get(row.player_id).push(row);
  }
  return map;
}

// What the notices do to one raid on `raidOn`: { away: [{ personId, noticeId }] (the people with no real sign-up), notes: Map personId -> { kind, atTime } }.
// `real`: a Set of the person ids that have a real sign-up on this raid (a real sign-up always wins over a notice).
export function raidAwayEffects(notices, raidOn, real = new Set()) {
  const effects = raidNoticeEffects(notices, raidOn, new Set(notices.map((notice) => notice.personId)));
  return { away: effects.away.filter((entry) => !real.has(entry.personId)), notes: effects.notes };
}
