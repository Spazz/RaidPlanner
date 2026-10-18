// Needs attention: GET /attention reads everything the guild home page lists in ONE batch (a handful of guild-wide statements, not one per
// team) and hands it to worker/attention.js. For officers and team leads (anyone holding review, roster, raid or loot editing for a team);
// each kind of item is limited to the teams the viewer holds the matching right for.
import { HttpError, jsonResponse } from '../http.js';
import { addDays } from '../attendance-calendar.js';
import { watchList } from '../attendance-metrics.js';
import { makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { displayCharacter, groupBy } from '../attendance-view.js';
import { LOOT_LOOKBACK_DAYS, SIGNUP_LOOKAHEAD_DAYS, TRIAL_DAYS, buildAttention } from '../attention.js';
import { onboardingStatement, shapeOnboarding } from '../onboarding.js';
import { allows, isGranted, loadGuildContext } from '../permissions.js';
import { effectiveRaidSize } from '../raid-zones.js';
import { guildToday } from '../roster-view.js';
import { MERGED_ROWS } from './raids.js';
import { metricsRaid, metricsRow } from './attendance.js';

const DAY_MS = 86400000;
const VIEW_ACTIONS = ['attendance.review', 'roster.edit', 'raids.edit', 'loot.edit'];
const READ_CAP = 200;

// Everyone who gets the page: the viewer holds at least one of the editing rights somewhere.
export const canSeeAttention = (can) => VIEW_ACTIONS.some((action) => isGranted(can[action]));

export async function getAttention(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const can = guildContext.can;
  if (!canSeeAttention(can)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const guild = guildContext.guild;
  const now = ctx.now();
  const today = guildToday(guild, now);
  const lootSince = addDays(today, -LOOT_LOOKBACK_DAYS);
  const trialUntil = addDays(today, TRIAL_DAYS);

  // The teams whose attendance the watch list reads: the ones the viewer may review. Teams come first (one tiny read) so the big reads are
  // limited to them; a Guild Master's list is every team.
  const teamResult = await db.prepare('SELECT id, name, size, archived FROM teams WHERE guild_id = ?').bind(guild.id).all();
  const teams = teamResult.results;
  const teamSizes = new Map(teams.map((team) => [team.id, team.size]));
  const watchTeams = teams.filter((team) => team.archived === 0 && allows(can, 'attendance.review', team.id)).map((team) => team.id);
  const watchJson = JSON.stringify(watchTeams);
  const bind = (sql, ...values) => db.prepare(sql).bind(guild.id, ...values);

  const [flagged, lootUnmatched, signupUnmatched, claims, trials, noLoot, upcoming, policyRows, raids, rows, borrowed, people, characters, rosterDeclined, onboarding] = await db.batch([
    bind(`SELECT id, team_id, raid_on, zone, title, event_title, open_flags FROM raids WHERE guild_id = ? AND open_flags > 0 ORDER BY raid_on DESC LIMIT ${READ_CAP}`),
    // Loot winners who match no character and no guest (a disenchant has no winner), per raid.
    bind(
      `SELECT a.raid_id, a.team_id, r.raid_on, r.zone, r.title, r.event_title, COUNT(DISTINCT a.winner_name_key || '|' || a.winner_realm_key) AS names
         FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
        WHERE a.guild_id = ?1 AND a.winner_name_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.name_key = a.winner_name_key AND c.realm_key = a.winner_realm_key)
          AND NOT EXISTS (SELECT 1 FROM attendance_guests g WHERE g.guild_id = ?1 AND g.name_key = a.winner_name_key AND g.realm_key = a.winner_realm_key)
        GROUP BY a.raid_id ORDER BY r.raid_on DESC LIMIT ${READ_CAP}`,
    ),
    // Raid-Helper sign-ups that are no person on the roster, on raids from two weeks back on (absences do not matter).
    bind(
      `SELECT s.raid_id, r.team_id, r.raid_on, r.zone, r.title, r.event_title, COUNT(*) AS n
         FROM raid_signups s JOIN raids r ON r.id = s.raid_id AND r.guild_id = s.guild_id
        WHERE s.guild_id = ?1 AND s.source = 'raid_helper' AND s.player_id IS NULL AND s.kind IN ('signed', 'late', 'bench', 'tentative') AND r.raid_on >= ?2
        GROUP BY s.raid_id ORDER BY r.raid_on LIMIT ${READ_CAP}`,
      lootSince,
    ),
    bind("SELECT COUNT(*) AS n FROM character_claims WHERE guild_id = ? AND status = 'pending'"),
    bind(
      `SELECT p.id, p.trial_end, c.name, c.class, c.team_id FROM players p JOIN characters c ON c.player_id = p.id AND c.is_main = 1
        WHERE p.guild_id = ? AND p.status = 'trial' AND p.trial_end IS NOT NULL AND p.trial_end <= ? ORDER BY p.trial_end, p.id LIMIT ${READ_CAP}`,
      trialUntil,
    ),
    // Raids of the last two weeks that happened (a log or hand-entered attendance) with no loot imported, in a team that has imported loot before.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.zone, r.title, r.event_title FROM raids r
        WHERE r.guild_id = ?1 AND r.starts_at <= ?2 AND r.raid_on >= ?3
          AND (r.log_mode = 'manual' OR EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = r.id))
          AND NOT EXISTS (SELECT 1 FROM loot_awards a WHERE a.raid_id = r.id)
          AND EXISTS (SELECT 1 FROM loot_awards b WHERE b.guild_id = ?1 AND b.team_id = r.team_id)
        ORDER BY r.raid_on DESC LIMIT ${READ_CAP}`,
      now, lootSince,
    ),
    // Raids in the next week with how many are signed up or late (the merged list: a Raidsmith sign-up replaces the Raid-Helper one). r.size is the
    // raid's own size (NULL = automatic): the effective one is worked out below.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.zone, r.size, r.title, r.event_title, r.signups_locked,
              COALESCE(r.signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = r.team_id), 0) AS close_hours,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind IN ('signed', 'late')) AS n_in
         FROM raids r WHERE r.guild_id = ?1 AND r.starts_at > ?2 AND r.starts_at <= ?3 ORDER BY r.starts_at, r.id LIMIT ${READ_CAP}`,
      now, now + SIGNUP_LOOKAHEAD_DAYS * DAY_MS,
    ),
    policyRowsStatement(db, guild.id),
    // The watch list's inputs, for the teams the viewer may review (the whole team history: a window's first-attended date needs it).
    bind(
      `SELECT id, team_id, raid_on, zone, event_synced, plan_synced, open_flags, policy_fp, log_mode,
              (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = raids.id) AS reports
         FROM raids WHERE guild_id = ? AND team_id IN (SELECT value FROM json_each(?)) ORDER BY raid_on, id`,
      watchJson,
    ),
    bind(
      `SELECT raid_id, player_id, team_id, outcome, credit, signup_kind, attended, via_raid_id FROM attendance
        WHERE guild_id = ? AND team_id IN (SELECT value FROM json_each(?))`,
      watchJson,
    ),
    bind(
      `SELECT a.raid_id, a.player_id, r.raid_on, r.team_id AS host_team_id, a.credit_team_id FROM attendance a JOIN raids r ON r.id = a.raid_id
        WHERE a.guild_id = ? AND a.credit_team_id IN (SELECT value FROM json_each(?)) AND a.credit = 1 AND a.outcome = 'fill_in'`,
      watchJson,
    ),
    bind("SELECT id, status, joined_on, left_on FROM players WHERE guild_id = ? AND status IN ('raider', 'trial')"),
    bind(
      `SELECT player_id, name, class, team_id, is_main FROM characters
        WHERE guild_id = ?1 AND player_id IN (SELECT id FROM players WHERE guild_id = ?1 AND status IN ('raider', 'trial'))`,
    ),
    // Upcoming raids with a published roster where someone said they cannot make it.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.zone, r.title, r.event_title, COUNT(*) AS n
         FROM raid_roster rr JOIN raids r ON r.id = rr.raid_id
        WHERE r.guild_id = ? AND r.starts_at > ? AND r.roster_published_at IS NOT NULL AND rr.status = 'declined'
        GROUP BY r.id ORDER BY r.starts_at, r.id LIMIT ${READ_CAP}`,
      now,
    ),
    // The setup checklist's flags, for the people who set the guild up (no statement for anyone else: `onboarding` is then undefined).
    ...[onboardingStatement(db, guildContext)].filter(Boolean),
  ]);

  // The watch list of each team: its people are those with a character on it or a row in its attendance.
  const resolver = makePolicyResolver(guild, policyRows.results);
  const resetDay = resolver.resetDay();
  const charactersByPlayer = groupBy(characters.results, 'player_id');
  const rowsByTeam = groupBy(rows.results, 'team_id');
  const raidsByTeam = groupBy(raids.results, 'team_id');
  const borrowedByTeam = groupBy(borrowed.results, 'credit_team_id');
  const playersById = new Map(people.results.map((row) => [row.id, row]));
  const watch = watchTeams.map((teamId) => {
    const teamRows = rowsByTeam.get(teamId) || [];
    const onTeam = new Set([...teamRows.map((row) => row.player_id), ...characters.results.filter((row) => row.team_id === teamId).map((row) => row.player_id)]);
    const members = [...onTeam].filter((id) => playersById.has(id)).map((id) => {
      const row = playersById.get(id);
      return { id, status: row.status, joinedOn: row.joined_on, leftOn: row.left_on };
    });
    const list = watchList({
      people: members,
      raids: (raidsByTeam.get(teamId) || []).map(metricsRaid),
      rows: teamRows.map((row) => metricsRow(row)),
      borrowed: (borrowedByTeam.get(teamId) || []).map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
      policy: resolver.resolved(teamId), today, resetDay,
    });
    return {
      teamId,
      entries: list.entries.map((entry) => {
        const character = displayCharacter(charactersByPlayer.get(entry.playerId) || [], teamId);
        return { ...entry, name: character ? character.name : 'Unknown', class: character ? character.class : null };
      }),
    };
  });

  const built = buildAttention({
    today, now, teams,
    allowsTeam: (action, teamId) => allows(can, action, teamId),
    granted: (action) => isGranted(can[action]),
    flaggedRaids: flagged.results,
    lootUnmatched: lootUnmatched.results,
    signupUnmatched: signupUnmatched.results,
    claims: claims.results[0] ? claims.results[0].n : 0,
    trials: trials.results,
    noLoot: noLoot.results,
    // Each raid is short against ITS size: its own, else its zone's in the guild's version, else the team's.
    upcoming: upcoming.results.map((row) => ({ ...row, size: effectiveRaidSize(row, teamSizes.get(row.team_id), guild.game_version) })),
    watch,
    rosterDeclined: rosterDeclined.results,
  });
  // The setup checklist (null for anyone who does not set the guild up, once dismissed, and once every step is done); it never counts toward `total`.
  return jsonResponse({ today, ...built, onboarding: shapeOnboarding(onboarding) });
}
