import { guestIdentityStatement, guestKeysFor } from '../guest-identity.js';
// Needs attention: GET /attention reads everything the guild home page lists in ONE batch (a handful of guild-wide statements, not one per
// team) and hands it to worker/attention.js. For officers and team leads (anyone holding review, roster, raid or loot editing for a team);
// each kind of item is limited to the teams the viewer holds the matching right for.
//
// Home redesign (round 2): the payload also carries `hidden` (what a shared dismissal hides now), `counts` (open watch entries and rank suggestions per
// team), the `week` block and `readiness: true` on the items that are facts about a raid, not to-dos; `total` counts open, unhidden to-dos only. The shapes are
// documented at the top of worker/attention.js.
//
// Home round 6: `week` is an OBJECT, { offset, start, end, resetDay, autoAdvanced, raids }: the guild's reset week (the policy's reset day, else the region's), each
// raid with its readiness facts, a status word, the roles grid's `people` and `openSeats`. GET /attention opens on the current week and jumps to the next one when
// the current has no raid left to start and the next has one (autoAdvanced true). The week arrows read:
//   GET    /api/guild/:gid/attention/week?offset=N    -> { week }   N = whole reset weeks from the current one, an integer -8..8 (absent = 0), never auto-jumps
// Same rights as /attention. 400 bad_request with `field: 'offset'` for anything else. The week's raids, sign-ups, seats, characters and Late notices are read in the
// same ONE batch as the rest (no per-raid queries).
//   POST   /api/guild/:gid/attention/dismissals          { itemId }   dismiss / snooze / mark Reviewed (watch) the item for every officer
//   DELETE /api/guild/:gid/attention/dismissals/:itemid               Restore it
// The server decides the mode, the snooze length (`until`) and the fingerprint from the item's kind (DISMISS_RULES); a client sends the item id only.
// 404: the viewer sees no such item. 400 not_dismissable: the kind clears when handled (review, claims, applications, the readiness facts, rank).
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { addDays, weekStart } from '../attendance-calendar.js';
import { watchList } from '../attendance-metrics.js';
import { ladderOf, rankReview } from '../rank-ladder.js';
import { makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { displayCharacter, groupBy } from '../attendance-view.js';
import { ATTENTION_VIEW_ACTIONS, LOOT_LOOKBACK_DAYS, SIGNUP_LOOKAHEAD_DAYS, TRIAL_DAYS, WEEK_OFFSET_MAX, DISMISS_RULES, buildAttention, dismissalUntil, findAttentionItem } from '../attention.js';
import { winnerNameKeySql } from '../name-alias.js';
import { onboardingStatement, shapeOnboarding } from '../onboarding.js';
import { ownerSql } from '../owner.js';
import { allows, isGranted, loadGuildContext } from '../permissions.js';
import { characterOfRow } from '../person-rank.js';
import { personRankSql } from '../person-rank-sql.js';
import { LOG_GRACE_HOURS, LOG_NUDGE_LOOKBACK_DAYS, RAID_DURATION_HOURS } from '../duties.js';
import { CONFIRM_HOURS } from '../notify.js';
import { effectiveRaidSize } from '../raid-zones.js';
import { guildToday, personColumnsOf } from '../roster-view.js';
import { MERGED_ROWS } from './raids.js';
import { metricsRaid, metricsRow } from './attendance.js';

const DAY_MS = 86400000;
const VIEW_ACTIONS = ATTENTION_VIEW_ACTIONS;
const READ_CAP = 200;
const WEEK_ROW_CAP = 4000;
// The in-game ranks on the stored roster that have no rank-map row (lane B4b), for the OWNER of an 'ingame' guild only: the rows are the ranks (?1 = the guild, ?2 = the
// viewer). Anyone else gets none, so the item reaches nobody else.
const UNMAPPED_RANKS_SQL = `SELECT g.rank AS rank, COUNT(*) AS members FROM guild_roster g
  WHERE g.guild_id = ?1 AND EXISTS (SELECT 1 FROM guilds x WHERE x.id = ?1 AND x.rank_source = 'ingame') AND ${ownerSql('?1', '?2')}
    AND NOT EXISTS (SELECT 1 FROM source_rank_maps m WHERE m.guild_id = g.guild_id AND m.source = 'ingame' AND m.source_key = CAST(g.rank AS TEXT))
  GROUP BY g.rank ORDER BY g.rank`;

// Blocks that wait for an officer (lane B7a), for the holders of guild.access only (?2 = 1 when the viewer holds it; anyone else gets none):
//   pending: blocks a tombstone match inserted (pending_review = 1; they ENFORCE already)
//   held: accounts that matched a block but were NOT blocked (the Owner, a Guild Master, an account ranking with or above the officer who blocked), the last 30 days
const BLOCK_REVIEW_SQL = `SELECT
    (SELECT COUNT(*) FROM guild_blocks WHERE guild_id = ?1 AND pending_review = 1 AND ?2 = 1) AS pending,
    (SELECT COUNT(DISTINCT entity_id) FROM audit_log WHERE guild_id = ?1 AND action = 'block.match_held' AND created_at > ?3 AND ?2 = 1) AS held`;
const BLOCK_REVIEW_DAYS = 30;

// Everyone who gets the page: the viewer holds at least one of the editing rights somewhere.
export const canSeeAttention = (can) => VIEW_ACTIONS.some((action) => isGranted(can[action]));

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// The signed-in viewer's context, checked: what the three routes below start with. The 4th argument is the dev View-as switch (a test pins it).
async function viewerContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!canSeeAttention(guildContext.can)) throw forbidden();
  return guildContext;
}

export async function getAttention(ctx) {
  const guildContext = await viewerContext(ctx);
  const { input, onboarding, today } = await readAttentionInput(ctx, guildContext);
  // The setup checklist (null for anyone who does not set the guild up, once dismissed, and once every step is done); it never counts toward `total`.
  return jsonResponse({ today, ...buildAttention(input), onboarding: shapeOnboarding(onboarding) });
}

// GET /attention/week?offset=N -> { week }: another reset week for the arrows (no auto-jump). Same rights as /attention.
export async function getAttentionWeek(ctx) {
  const guildContext = await viewerContext(ctx);
  const raw = new URL(ctx.request.url).searchParams.get('offset');
  const offset = raw === null ? 0 : /^-?\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(offset) || Math.abs(offset) > WEEK_OFFSET_MAX) {
    throw new HttpError(400, 'bad_request', `Send a whole number of weeks from -${WEEK_OFFSET_MAX} to ${WEEK_OFFSET_MAX}.`, { field: 'offset' });
  }
  const { input } = await readAttentionInput(ctx, guildContext, offset);
  return jsonResponse({ week: buildAttention(input).week });
}

// Reads everything buildAttention takes, in ONE batch (after one tiny read of the teams and the policy, which the week window needs). `weekOffset`: an integer
// = that reset week only; left out = this week and the next (buildAttention picks, see the auto-jump). -> { input, onboarding, today }
async function readAttentionInput(ctx, guildContext, weekOffset) {
  const { db } = ctx;
  const can = guildContext.can;
  const guild = guildContext.guild;
  const now = ctx.now();
  const today = guildToday(guild, now);
  const lootSince = addDays(today, -LOOT_LOOKBACK_DAYS);
  const trialUntil = addDays(today, TRIAL_DAYS);

  // The teams whose attendance the watch list reads: the ones the viewer may review. Teams come first (one tiny read) so the big reads are
  // limited to them; a Guild Master's list is every team.
  const [teamResult, policyResult] = await db.batch([db.prepare('SELECT id, name, size, archived FROM teams WHERE guild_id = ?').bind(guild.id), policyRowsStatement(db, guild.id)]);
  const teams = teamResult.results;
  const resolver = makePolicyResolver(guild, policyResult.results);
  const resetDay = resolver.resetDay();
  // The reset weeks the week block reads: the one asked for, else this one and the next (the auto-jump looks at both).
  const hasOffset = Number.isInteger(weekOffset);
  const weekFrom = addDays(weekStart(today, resetDay), hasOffset ? 7 * weekOffset : 0);
  const weekTo = addDays(weekFrom, hasOffset ? 6 : 13);
  const weekRaidIds = 'SELECT id FROM raids WHERE guild_id = ?1 AND raid_on >= ?2 AND raid_on <= ?3';
  const teamSizes = new Map(teams.map((team) => [team.id, team.size]));
  const watchTeams = teams.filter((team) => team.archived === 0 && allows(can, 'attendance.review', team.id)).map((team) => team.id);
  const watchJson = JSON.stringify(watchTeams);
  const bind = (sql, ...values) => db.prepare(sql).bind(guild.id, ...values);

  const [flagged, lootUnmatched, signupUnmatched, claims, trials, noLoot, upcoming, raids, rows, borrowed, people, characters, rosterDeclined, applications, teamRequests, unmappedRanks, rosterPending, eventMoved, webhooksOff, dismissals, logMissing, attentionDismissals, weekRaids, weekSignups, weekRoster, weekCharacters, weekLate, guestIdentities, blockReview, onboarding] = await db.batch([
    bind(`SELECT id, team_id, raid_on, zone, title, event_title, open_flags FROM raids WHERE guild_id = ? AND open_flags > 0 ORDER BY raid_on DESC LIMIT ${READ_CAP}`),
    // Loot winners who match no character and no guest (a disenchant has no winner), per raid.
    bind(
      `SELECT a.raid_id, a.team_id, r.raid_on, r.zone, r.title, r.event_title, COUNT(DISTINCT a.winner_name_key || '|' || a.winner_realm_key) AS names,
              GROUP_CONCAT(DISTINCT a.winner_name_key || '|' || a.winner_realm_key) AS keys
         FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
        WHERE a.guild_id = ?1 AND a.winner_name_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key)
          AND NOT EXISTS (SELECT 1 FROM attendance_guests g WHERE g.guild_id = ?1 AND g.name_key = a.winner_name_key AND g.realm_key = a.winner_realm_key)
        GROUP BY a.raid_id ORDER BY r.raid_on DESC LIMIT ${READ_CAP}`,
    ),
    // Raid-Helper sign-ups that are no person on the roster, on raids from two weeks back on (absences do not matter).
    bind(
      `SELECT s.raid_id, r.team_id, r.raid_on, r.zone, r.title, r.event_title, COUNT(*) AS n
         FROM raid_signups s JOIN raids r ON r.id = s.raid_id AND r.guild_id = s.guild_id
        WHERE s.guild_id = ?1 AND s.source = 'raid_helper' AND s.player_id IS NULL AND s.kind IN ('signed', 'late', 'bench', 'tentative') AND r.raid_on >= ?2 AND ${MERGED_ROWS}
        GROUP BY s.raid_id ORDER BY r.raid_on LIMIT ${READ_CAP}`,
      lootSince,
    ),
    bind("SELECT COUNT(*) AS n FROM character_claims WHERE guild_id = ? AND status = 'pending'"),
    // Trial is per character on its team (the Trial clock, worker/trial-clock.js, writes the dates): a Trial alt counts, a character on no team has no team to review it.
    bind(
      `SELECT c.player_id AS id, c.id AS character_id, c.is_main, c.trial_end, c.name, c.class, c.team_id FROM characters c
        WHERE c.guild_id = ? AND c.core_rank = 'trial' AND c.left_on IS NULL AND c.team_id IS NOT NULL AND c.trial_end IS NOT NULL AND c.trial_end <= ?
        ORDER BY c.trial_end, c.player_id, c.id LIMIT ${READ_CAP}`,
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
    // The raiding people (their main is a Raider or on Trial); status and left date come from their characters below.
    bind(`SELECT id, joined_on, rank, rank_on FROM players WHERE guild_id = ? AND ${personRankSql('players.id')} IN ('raider', 'trial')`),
    bind(
      `SELECT id, player_id, name, class, team_id, is_main, core_rank, left_on, left_reason, trial_start, trial_end FROM characters
        WHERE guild_id = ?1 AND ${personRankSql('characters.player_id')} IN ('raider', 'trial')`,
    ),
    // Upcoming raids with a published roster where someone said they cannot make it.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.zone, r.title, r.event_title, COUNT(*) AS n
         FROM raid_roster rr JOIN raids r ON r.id = rr.raid_id
        WHERE r.guild_id = ? AND r.starts_at > ? AND r.roster_published_at IS NOT NULL AND rr.status = 'declined'
        GROUP BY r.id ORDER BY r.starts_at, r.id LIMIT ${READ_CAP}`,
      now,
    ),
    // Applications nobody has looked at yet, per team.
    bind("SELECT team_id, COUNT(*) AS n FROM applications WHERE guild_id = ? AND status = 'new' GROUP BY team_id"),
    // Pending team requests (D6): a person asked for one of their characters to be placed on the team.
    bind("SELECT team_id, COUNT(*) AS n FROM team_requests WHERE guild_id = ? AND status = 'pending' GROUP BY team_id"),
    // In-game ranks on the stored roster with no rank-map row (lane B4b): their characters are Social until mapped. Rows come back ONLY for the Owner of an 'ingame' guild.
    bind(UNMAPPED_RANKS_SQL, guildContext.userId),
    // Upcoming raids with a published roster that start within CONFIRM_HOURS and still have seats nobody has answered.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.zone, r.title, r.event_title, COUNT(*) AS n
         FROM raid_roster rr JOIN raids r ON r.id = rr.raid_id
        WHERE r.guild_id = ? AND r.starts_at > ? AND r.starts_at <= ? AND r.roster_published_at IS NOT NULL AND rr.status = 'pending' AND rr.player_id IS NOT NULL
        GROUP BY r.id ORDER BY r.starts_at, r.id LIMIT ${READ_CAP}`,
      now, now + CONFIRM_HOURS * 3600000,
    ),
    // Upcoming raids whose Raid-Helper event the automatic refresh found on another day (it never moves a raid).
    bind(
      `SELECT id, team_id, raid_on, starts_at, zone, title, event_title, event_moved_on FROM raids
        WHERE guild_id = ? AND starts_at > ? AND event_moved_on IS NOT NULL ORDER BY starts_at, id LIMIT ${READ_CAP}`,
      now,
    ),
    // Teams whose Discord webhook Discord refused (404/401): the Worker switched it off.
    bind("SELECT team_id, disabled_status FROM team_notifications WHERE guild_id = ? AND webhook_url IS NOT NULL AND webhook_state = 'disabled'"),
    // Rank suggestions an officer dismissed for 30 days (PM wave 7).
    bind('SELECT player_id, kind, to_rank, until FROM rank_dismissals WHERE guild_id = ? AND until > ?', now),
    // Past raids whose Logger (a raid duty) has not uploaded a log: five hours after the start, within the look-back (PM wave 8).
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.zone, r.title, r.event_title,
              (SELECT c.name FROM characters c WHERE c.player_id = d.player_id ORDER BY c.is_main DESC, c.name_key LIMIT 1) AS logger_name
         FROM raids r JOIN raid_duties d ON d.raid_id = r.id AND d.guild_id = r.guild_id AND d.duty = 'logger'
        WHERE r.guild_id = ? AND r.time_known = 1 AND r.log_mode = 'log' AND r.starts_at <= ? AND r.starts_at > ?
          AND NOT EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = r.id)
        ORDER BY r.starts_at DESC, r.id LIMIT ${READ_CAP}`,
      now - (RAID_DURATION_HOURS + LOG_GRACE_HOURS) * 3600000, now - LOG_NUDGE_LOOKBACK_DAYS * DAY_MS,
    ),
    // Home redesign: the shared dismissals still in force (a snooze that ran out is gone from the read), with the name of the officer who made them.
    bind(
      `SELECT d.item_id, d.kind, d.team_id, d.mode, d.until, d.fingerprint, d.dismissed_by, d.created_at, COALESCE(u.display_name, u.global_name, u.username) AS by_name
         FROM attention_dismissals d LEFT JOIN users u ON u.id = d.dismissed_by WHERE d.guild_id = ? AND (d.until IS NULL OR d.until > ?)`,
      now,
    ),
    // Home redesign: the Week block's raids (the reset week(s) in the guild's days; archived teams and teams the viewer cannot see are dropped in
    // buildAttention), with the sign-up count and the line-up answers. The sign-up count is the same merged count as `upcoming`'s.
    bind(
      `SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.zone, r.size, r.title, r.event_title, r.signups_locked, r.roster_published_at, r.event_moved_on,
              COALESCE(r.signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = r.team_id), 0) AS close_hours,
              (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND ${MERGED_ROWS} AND s.kind IN ('signed', 'late')) AS n_in,
              (SELECT COUNT(*) FROM raid_roster rr WHERE rr.raid_id = r.id AND rr.status = 'confirmed') AS confirmed,
              (SELECT COUNT(*) FROM raid_roster rr WHERE rr.raid_id = r.id AND rr.status = 'declined') AS declined,
              (SELECT COUNT(*) FROM raid_roster rr WHERE rr.raid_id = r.id AND rr.status = 'pending' AND rr.player_id IS NOT NULL) AS pending
         FROM raids r WHERE r.guild_id = ?1 AND r.raid_on >= ?2 AND r.raid_on <= ?3 ORDER BY r.starts_at, r.id LIMIT ${READ_CAP}`,
      weekFrom, weekTo,
    ),
    // Round 6 (the roles grid): the merged sign-ups, the published seats (the bench is group 0: left out), the people's characters and the Late notices of
    // those raids, one statement each for ALL of the window's raids.
    bind(
      `SELECT s.raid_id, s.source, s.signup_id, s.nickname, s.kind, s.standby, s.guest, s.class_name, s.spec_name, s.position, s.player_id, s.character_id
         FROM raid_signups s WHERE s.raid_id IN (${weekRaidIds}) AND ${MERGED_ROWS} ORDER BY s.raid_id, s.position, s.source, s.signup_id LIMIT ${WEEK_ROW_CAP}`,
      weekFrom, weekTo,
    ),
    bind(
      `SELECT raid_id, name, player_id, group_number, class, spec, status FROM raid_roster
        WHERE guild_id = ?1 AND group_number > 0 AND raid_id IN (${weekRaidIds}) ORDER BY raid_id, group_number, seq LIMIT ${WEEK_ROW_CAP}`,
      weekFrom, weekTo,
    ),
    bind(
      `SELECT id, player_id, name, class, is_main, team_id FROM characters
        WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM raid_signups WHERE player_id IS NOT NULL AND raid_id IN (${weekRaidIds})) LIMIT ${WEEK_ROW_CAP}`,
      weekFrom, weekTo,
    ),
    bind(
      `SELECT id, player_id, kind, at_time, starts_on, ends_on, weekday, created_at FROM away_notices
        WHERE guild_id = ?1 AND kind = 'late' AND starts_on <= ?3 AND (ends_on IS NULL OR ends_on >= ?2) LIMIT ${READ_CAP}`,
      weekFrom, weekTo,
    ),
    guestIdentityStatement(db, guild.id),
    db.prepare(BLOCK_REVIEW_SQL).bind(guild.id, isGranted(can['guild.access']) ? 1 : 0, now - BLOCK_REVIEW_DAYS * DAY_MS),
    // The setup checklist's flags, for the people who set the guild up (no statement for anyone else: `onboarding` is then undefined).
    ...[onboardingStatement(db, guildContext)].filter(Boolean),
  ]);

  // The watch list of each team: its people are those with a character on it or a row in its attendance.
  const charactersByPlayer = groupBy(characters.results, 'player_id');
  const rowsByTeam = groupBy(rows.results, 'team_id');
  const raidsByTeam = groupBy(raids.results, 'team_id');
  const borrowedByTeam = groupBy(borrowed.results, 'credit_team_id');
  const playersById = new Map(people.results.map((row) => [row.id, row]));
  const dismissalByPlayer = new Map(dismissals.results.map((row) => [row.player_id, row]));
  const mainTeamOf = (playerId) => {
    const main = (charactersByPlayer.get(playerId) || []).find((entry) => entry.is_main === 1);
    return main ? main.team_id : null;
  };
  const ranks = [];
  const watch = watchTeams.map((teamId) => {
    const teamRows = rowsByTeam.get(teamId) || [];
    const onTeam = new Set([...teamRows.map((row) => row.player_id), ...characters.results.filter((row) => row.team_id === teamId).map((row) => row.player_id)]);
    const members = [...onTeam].filter((id) => playersById.has(id)).map((id) => {
      const row = playersById.get(id);
      const fields = personColumnsOf((charactersByPlayer.get(id) || []).map(characterOfRow));
      return { id, status: fields.status, joinedOn: row.joined_on, leftOn: fields.left_on, rank: row.rank, rankOn: row.rank_on };
    });
    const policy = resolver.resolved(teamId);
    const input = {
      people: members,
      raids: (raidsByTeam.get(teamId) || []).map(metricsRaid),
      rows: teamRows.map((row) => metricsRow(row)),
      borrowed: (borrowedByTeam.get(teamId) || []).map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
      policy, today, resetDay,
    };
    const list = watchList(input);
    const nameOf = (playerId) => {
      const character = displayCharacter(charactersByPlayer.get(playerId) || [], teamId);
      return { name: character ? character.name : 'Unknown', class: character ? character.class : null };
    };
    // PM wave 7: the rank ladder's suggestions for this team's raiders and trials (a person is judged on the team of their Main).
    const ladder = ladderOf(policy);
    if (ladder.length) {
      const review = rankReview({ ...input, ladder, nowMs: now, teamId, homeTeamOf: mainTeamOf, dismissals: dismissalByPlayer });
      const entries = [];
      for (const [playerId, entry] of review) if (entry.suggestion) entries.push({ playerId, ...nameOf(playerId), ...entry.suggestion });
      if (entries.length) ranks.push({ teamId, entries });
    }
    return { teamId, entries: list.entries.map((entry) => ({ ...entry, ...nameOf(entry.playerId) })) };
  });

  const input = {
    today, now, teams,
    allowsTeam: (action, teamId) => allows(can, action, teamId),
    granted: (action) => isGranted(can[action]),
    flaggedRaids: flagged.results,
    lootUnmatched: lootUnmatched.results.map(row => {
      const known = guestKeysFor(guestIdentities.results, row.raid_id);
      const keys = String(row.keys || '').split(',').filter(key => key && !known.has(key));
      return { ...row, names: keys.length, keys: keys.join(',') };
    }).filter(row => row.names > 0),
    signupUnmatched: signupUnmatched.results,
    claims: claims.results[0] ? claims.results[0].n : 0,
    trials: trials.results,
    noLoot: noLoot.results,
    // Each raid is short against ITS size: its own, else its zone's in the guild's version, else the team's.
    upcoming: upcoming.results.map((row) => ({ ...row, size: effectiveRaidSize(row, teamSizes.get(row.team_id), guild.game_version) })),
    watch,
    ranks,
    rosterDeclined: rosterDeclined.results,
    applications: applications.results,
    teamRequests: teamRequests.results,
    unmappedRanks: unmappedRanks.results,
    blockReview: blockReview.results[0],
    rosterPending: rosterPending.results,
    eventMoved: eventMoved.results,
    webhooksOff: webhooksOff.results,
    logMissing: logMissing.results,
    dismissals: attentionDismissals.results,
    weekRaids: weekRaids.results.map((row) => ({ ...row, size: effectiveRaidSize(row, teamSizes.get(row.team_id), guild.game_version) })),
    resetDay,
    weekOffset: hasOffset ? weekOffset : undefined,
    timeZone: guild.time_zone,
    weekData: { signups: weekSignups.results, roster: weekRoster.results, characters: weekCharacters.results, lateNotices: weekLate.results },
  };
  return { input, onboarding, today };
}

// The id of one kind inside an item id ('no_loot:r_..' -> the raid id), or null.
const idOf = (itemId, prefix) => String(itemId).split(':').find((part) => part.startsWith(`${prefix}_`)) || null;

// What the audit row names about an item: the sentence looks up the raid, person and team by these ids.
function auditFacts(itemId, kind, teamId) {
  const raidId = idOf(itemId, 'r');
  const personId = idOf(itemId, 'p');
  return { itemId, kind, ...(teamId ? { teamId } : {}), ...(raidId ? { raidId } : {}), ...(personId ? { personId } : {}) };
}

export async function postDismissal(ctx) {
  const guildContext = await viewerContext(ctx);
  const itemId = ctx.body && ctx.body.itemId;
  if (typeof itemId !== 'string' || !itemId || itemId.length > 120) throw new HttpError(400, 'bad_request', 'Send the id of the item.', { field: 'itemId' });
  const { input } = await readAttentionInput(ctx, guildContext);
  const found = findAttentionItem(input, itemId);
  if (!found) throw new HttpError(404, 'not_found', 'That item was not found.');
  if (!found.rule) throw new HttpError(400, 'not_dismissable', 'That item clears when it is handled.');
  const { item } = found.entry;
  const guild = guildContext.guild;
  const now = ctx.now();
  const until = dismissalUntil(item.kind, now);
  const mode = found.rule.mode;
  await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO attention_dismissals (id, guild_id, item_id, kind, team_id, mode, until, fingerprint, dismissed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, item_id) DO UPDATE SET kind = excluded.kind, team_id = excluded.team_id, mode = excluded.mode, until = excluded.until,
         fingerprint = excluded.fingerprint, dismissed_by = excluded.dismissed_by, created_at = excluded.created_at`,
    ).bind(newId('ad', ctx.randomBytes), guild.id, item.id, item.kind, item.teamId, mode, until, found.entry.fingerprint, guildContext.userId, now),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: guildContext.userId, action: 'attention.dismiss', entityType: 'attention', entityId: item.id,
      after: { ...auditFacts(item.id, item.kind, item.teamId), mode, until, ...(found.rule.days ? { days: found.rule.days } : {}) },
    }),
  ]);
  return jsonResponse({ ok: true, itemId: item.id, mode, until });
}

// Restore: the row goes and the item is open again. Needs the kind's rights for the row's team (the item itself may be gone by now, so the row decides).
export async function deleteDismissal(ctx) {
  const guildContext = await viewerContext(ctx);
  let itemId;
  try { itemId = decodeURIComponent(ctx.params.itemid); } catch { throw new HttpError(404, 'not_found', 'That item is not hidden.'); } // a malformed % escape
  const guild = guildContext.guild;
  const row = await ctx.db.prepare('SELECT item_id, kind, team_id, mode, until FROM attention_dismissals WHERE guild_id = ? AND item_id = ?').bind(guild.id, itemId).first();
  if (!row) throw new HttpError(404, 'not_found', 'That item is not hidden.');
  const rule = DISMISS_RULES[row.kind];
  const held = (action) => (row.team_id ? allows(guildContext.can, action, row.team_id) : isGranted(guildContext.can[action]));
  if (!rule || !rule.actions.every(held)) throw forbidden();
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM attention_dismissals WHERE guild_id = ? AND item_id = ?').bind(guild.id, itemId),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: guildContext.userId, action: 'attention.restore', entityType: 'attention', entityId: itemId,
      before: { ...auditFacts(itemId, row.kind, row.team_id), mode: row.mode, until: row.until },
    }),
  ]);
  return jsonResponse({ ok: true });
}
