import { guestIdentityStatement, guestKeysFor } from './guest-identity.js';
// Read side of the raids: the raid detail every raid route answers with, the shared character-display rule and
// the redaction (nicknames, reasons, other teams' attendance) by permission.
import { hasDiscord } from './discord-guard.js';
import { HttpError } from './http.js';
import { allows } from './permissions.js';
import { EVIDENCE_NAME_KEY, PLAN_NAME_KEY, findUnmatched, makePolicyResolver, presenceKey } from './attendance-store.js';
import { DUTIES_SQL, dutiesView } from './duties.js';
import { raidSizeFields } from './raid-zones.js';
import { roleGroup, signUpRole } from './roster-data.js';
import { SLOT_TIME_SQL, closeHoursOf, closesAtOf, windowFieldsOf } from './signup-window.js';

export const OUTCOME_PRESENT = ['present', 'late', 'left_early', 'late_left', 'fill_in'];

// 'stale' = the stored results do not match the raid's inputs or its team's current policy (a recompute failed or never ran,
// or the policy/roster changed since): never shown as reviewed.
// With a resolver, a live fingerprint mismatch is stale too.
export function raidState(raid, reports, resolver = null) {
  const manual = raid.log_mode === 'manual';
  if (!manual && !reports) return 'awaiting_log';
  if (resolver && raid.policy_fp !== resolver.fingerprint(raid.team_id)) return 'stale';
  if (manual) return raid.open_flags > 0 ? 'to_review' : 'manual';
  if (raid.policy_fp === '') return 'stale';
  return raid.open_flags > 0 ? 'to_review' : 'reviewed';
}

export const isStale = (state) => state === 'stale';

// The character a person is shown as on a team: the Main there, else the first by name there, else their Main elsewhere.
export function displayCharacter(characters, teamId) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const onTeam = characters.filter((character) => character.team_id === teamId).sort((a, b) => (b.is_main - a.is_main) || byName(a, b));
  if (onTeam.length) return onTeam[0];
  return characters.find((character) => character.is_main === 1) || [...characters].sort(byName)[0] || null;
}

export function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

const userName = (row) => row.display_name || row.global_name || row.username;
const parseFlags = (text) => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; } };

// One read batch + the shaping. -> the raid detail object (see tasks/reference/guild-phase3-spec.md, API), or throws 404.
export async function loadRaidDetail(ctx, guildContext, raidId) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const bind = (sql) => db.prepare(sql).bind(guild.id, raidId);
  const [raidResult, reportResult, pullResult, signupResult, planResult, attendanceResult, characterResult, presenceResult, guestResult,
    policyResult, userResult, teamResult, flagResult, decisionResult, manualResult, dutyResult, laterResult] = await db.batch([
    bind(`SELECT r.*, t.name AS team_name, t.size AS team_size, t.signup_close_hours AS team_close_hours, (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports,
                 (SELECT COUNT(*) FROM raid_plan_doc d WHERE d.raid_id = r.id) AS plan_doc,
                 ${SLOT_TIME_SQL} AS slot_time
            FROM raids r JOIN teams t ON t.id = r.team_id AND t.guild_id = r.guild_id WHERE r.guild_id = ?1 AND r.id = ?2`),
    bind(`SELECT code, flavour, started_at, ended_at, owner, synced_at,
                 (SELECT COUNT(*) FROM raid_pulls p WHERE p.raid_id = raid_reports.raid_id AND p.report_code = raid_reports.code) AS pulls
            FROM raid_reports WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY started_at, code`),
    bind('SELECT encounter_name, kill, started_at FROM raid_pulls WHERE raid_id = ?2 ORDER BY started_at, id'),
    bind("SELECT source, signup_id, CASE WHEN kind = 'signed' AND standby = 1 THEN 'standby' ELSE kind END AS kind, class_name, spec_name, position, player_id, nickname FROM raid_signups WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY position, source, signup_id"),
    // Every stored name also carries match_name_key: the name as the characters carry it today (worker/name-alias.js), dated at the raid, so a renamed
    // character keeps its old raids.
    bind(`SELECT pl.name, pl.name_key, pl.group_number, ${PLAN_NAME_KEY} AS match_name_key
            FROM raid_plan pl JOIN raids pr ON pr.id = pl.raid_id WHERE pl.raid_id = ?2 ORDER BY pl.rowid`),
    bind('SELECT * FROM attendance WHERE raid_id = ?2 AND guild_id = ?1'),
    bind(`SELECT c.player_id, c.name, c.name_key, c.realm_key, c.class, c.main_spec, c.team_id, c.is_main FROM characters c
           WHERE c.guild_id = ?1 AND (c.player_id IN (SELECT player_id FROM attendance WHERE raid_id = ?2)
              OR c.name_key IN (SELECT ${EVIDENCE_NAME_KEY} FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id = ?2)
              OR c.name_key IN (SELECT ${EVIDENCE_NAME_KEY} FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id = ?2)
              OR c.name_key IN (SELECT ${PLAN_NAME_KEY} FROM raid_plan pl JOIN raids pr ON pr.id = pl.raid_id WHERE pl.raid_id = ?2))`),
    // The log's names, then the names of a pasted roster that matched nobody (wave 8; pulls 0 tells them apart).
    bind(`SELECT rp.name, rp.name_key, rp.realm, rp.realm_key, rp.class, COUNT(*) AS pulls, ${EVIDENCE_NAME_KEY} AS match_name_key
            FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id
           WHERE rp.raid_id = ?2 AND rp.guild_id = ?1 GROUP BY rp.name_key, rp.realm_key
          UNION ALL SELECT rp.name, rp.name_key, rp.realm, rp.realm_key, NULL, 0, ${EVIDENCE_NAME_KEY}
            FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id = ?2 AND rp.guild_id = ?1`),
    guestIdentityStatement(db, guild.id),
    db.prepare('SELECT id, team_id, policy, version FROM attendance_policies WHERE guild_id = ?').bind(guild.id),
    bind(`SELECT id, username, global_name, display_name FROM users WHERE id IN (SELECT decided_by FROM attendance_decisions WHERE raid_id = ?2 AND decided_by IS NOT NULL)
             OR id = (SELECT manual_by FROM raids WHERE id = ?2 AND guild_id = ?1)`),
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guild.id),
    db.prepare('SELECT team_id, SUM(open_flags) AS n FROM raids WHERE guild_id = ? AND open_flags > 0 GROUP BY team_id').bind(guild.id),
    bind('SELECT player_id, reason, flags, decided_by, decided_at FROM attendance_decisions WHERE raid_id = ?2 AND guild_id = ?1'),
    bind('SELECT player_id FROM raid_manual WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY player_id'),
    bind(DUTIES_SQL),
    // People who joined the guild after this raid's day: the raid page leaves them out of "Everyone" unless they took part (they were not on the roster that day).
    bind('SELECT id FROM players WHERE guild_id = ?1 AND joined_on > (SELECT raid_on FROM raids WHERE id = ?2 AND guild_id = ?1)'),
  ]);
  const raid = raidResult.results[0];
  if (!raid) throw new HttpError(404, 'not_found', 'That raid does not exist.');
  Object.assign(raid, windowFieldsOf(raid, guild.time_zone)); // a raid with only a date: its member window starts at the team slot time that day, else 18:00
  const can = guildContext.can;
  const teamId = raid.team_id;
  const seeAttendance = allows(can, 'attendance.view', teamId);
  const review = allows(can, 'attendance.review', teamId);
  const seeNicknames = allows(can, 'roster.edit', teamId);
  const resolver = makePolicyResolver(guild, policyResult.results);
  const state = raidState(raid, raid.reports, resolver);
  const users = new Map(userResult.results.map((row) => [row.id, row]));
  const decisions = new Map(decisionResult.results.map((row) => [row.player_id, row]));

  const charactersByPlayer = groupBy(characterResult.results, 'player_id');
  const characterKeys = new Set(characterResult.results.map((row) => presenceKey(row.name_key, row.realm_key)));
  // The character query is narrowed to this raid's names; a character with the same name on another realm key still matches only by key.
  const guestKeys = guestKeysFor(guestResult.results, raid.id);

  const planByPlayer = new Map();
  const charactersByName = groupBy(characterResult.results, 'name_key');
  for (const entry of planResult.results) {
    for (const character of charactersByName.get(entry.match_name_key || entry.name_key) || []) {
      if (!planByPlayer.has(character.player_id)) planByPlayer.set(character.player_id, entry.group_number === 0 ? 'bench' : `G${entry.group_number}`);
    }
  }

  // The role of a person on this raid: the role of their sign-up, else their main character's spec, else the class alone, else null (a "No role" line).
  const signupRoleByPlayer = new Map();
  for (const row of [...signupResult.results].sort((x, y) => Number(y.source === 'raidsmith') - Number(x.source === 'raidsmith'))) {
    if (row.player_id && !signupRoleByPlayer.has(row.player_id)) {
      const role = signUpRole(row);
      if (role) signupRoleByPlayer.set(row.player_id, role);
    }
  }
  const roleOfPerson = (playerId, character) => {
    const main = (charactersByPlayer.get(playerId) || []).find((c) => c.is_main === 1);
    return signupRoleByPlayer.get(playerId)
      || (main && main.main_spec ? roleGroup(main.class, main.main_spec) : null)
      || (character && character.class ? roleGroup(character.class, null) : null)
      || (main ? roleGroup(main.class, null) : null)
      || null;
  };

  const joinedLater = new Set(laterResult.results.map((row) => row.id));
  let people = null;
  if (seeAttendance) {
    people = attendanceResult.results.map((row) => {
      const character = displayCharacter(charactersByPlayer.get(row.player_id) || [], teamId);
      const flags = parseFlags(row.flags);
      const made = decisions.get(row.player_id) || null;
      const decided = !!made;
      const decidedBy = decided && made.decided_by ? users.get(made.decided_by) : null;
      const applied = decided && JSON.stringify([...parseFlags(made.flags)].sort()) === JSON.stringify([...flags].sort());
      return {
        playerId: row.player_id,
        name: character ? character.name : 'Unknown',
        class: character ? character.class : null,
        role: roleOfPerson(row.player_id, character),
        signup: row.signup_kind,
        plan: planByPlayer.get(row.player_id) || null,
        pulls: { present: row.pulls_present, total: row.pulls_total, missedFirst: row.missed_first === 1, missedLast: row.missed_last === 1 },
        outcome: row.outcome,
        credit: row.credit,
        pending: row.needs_review === 1 && row.credit === null,
        needsReview: row.needs_review === 1,
        flags,
        via: row.via_raid_id,
        source: row.presence_source,
        ...(joinedLater.has(row.player_id) ? { joinedAfter: true } : {}), // joined the guild after this raid's day
        decision: decided ? (review
          ? { reason: made.reason, by: decidedBy ? userName(decidedBy) : null, at: made.decided_at, applied }
          : { at: made.decided_at, applied }) : null,
      };
    }).sort((a, b) => (Number(b.needsReview) - Number(a.needsReview)) || a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId));
  }

  const unmatched = seeAttendance ? findUnmatched(presenceResult.results, characterKeys, guestKeys) : [];
  const signups = seeAttendance ? signupResult.results.map((row) => ({
    source: row.source,
    kind: row.kind,
    className: row.class_name,
    specName: row.spec_name,
    position: row.position,
    playerId: row.player_id,
    matched: row.player_id !== null,
    nickname: seeNicknames ? row.nickname : null,
  })) : [];
  const raidHelperSignups = signupResult.results.filter((row) => row.source === 'raid_helper').length;
  const planNames = planResult.results;
  const matchedPlanKeys = new Set(characterResult.results.map((row) => row.name_key));

  const flagTeams = {};
  for (const team of teamResult.results) if (allows(can, 'attendance.review', team.id)) flagTeams[team.id] = 0;
  for (const row of flagResult.results) if (flagTeams[row.team_id] !== undefined) flagTeams[row.team_id] = row.n;
  const manualBy = raid.manual_by ? users.get(raid.manual_by) : null;

  return {
    raid: {
      id: raid.id,
      team: { id: raid.team_id, name: raid.team_name },
      teamId: raid.team_id,
      raidOn: raid.raid_on,
      startsAt: raid.starts_at,
      timeKnown: raid.time_known !== 0, // false: only the date is known and startsAt is noon UTC
      upcoming: raid.starts_at > ctx.now(),
      title: raid.title || raid.event_title || null,
      zone: raid.zone,
      ...raidSizeFields(raid, raid.team_size, guild.game_version),
      planLive: allows(can, 'raids.edit', teamId) ? raid.plan_live || null : null, // an edit link to the plan: only for those who may edit
      state,
      openFlags: raid.open_flags,
      stale: isStale(state),
      version: raid.version,
      signupsLocked: raid.signups_locked === 1,
      closesAt: closesAtOf(raid), // when members' sign-ups close: the start less the deadline (the raid's own, else the team's)
      // 'slot' | 'default' for a raid with only a date (the team slot time that day, else 18:00 guild time); a raid with a start time has no closesSource
      ...(raid.window_source ? { closesSource: raid.window_source } : {}),
      closeHours: closeHoursOf(raid),
      closeHoursOverride: raid.signup_close_hours,
      teamCloseHours: raid.team_close_hours, // the team's default, for the page that edits the raid's own
      manual: raid.log_mode === 'manual'
        ? {
          reason: review ? raid.manual_reason : null, by: review && manualBy ? userName(manualBy) : null, at: raid.manual_at,
          presentPlayerIds: seeAttendance ? manualResult.results.map((row) => row.player_id) : [],
        }
        : null,
    },
    can: { edit: allows(can, 'raids.edit', teamId), review, seeAttendance, seeNicknames },
    sources: {
      event: raid.event_id ? {
        id: raid.event_id, title: raid.event_title, syncedAt: raid.event_synced, signups: raidHelperSignups,
        otherServer: hasDiscord(guild) && raid.event_server !== null && raid.event_server !== guild.discord_server_id,
      } : null,
      reports: reportResult.results.map((row) => ({ code: row.code, flavour: row.flavour, startedAt: row.started_at, pulls: row.pulls })),
      plan: raid.plan_synced !== null && raid.plan_synced !== undefined
        ? { label: raid.plan_label, players: planNames.length, full: raid.plan_doc > 0, unmatched: seeAttendance ? planNames.filter((entry) => !matchedPlanKeys.has(entry.match_name_key || entry.name_key)).map((entry) => entry.name) : [] }
        : null,
      planDoc: raid.plan_doc > 0, // a full Planner plan exists, even when nobody is seated in it (then `plan` is null: the line-up projection is empty)
    },
    pulls: pullResult.results.map((row) => ({ encounter: row.encounter_name, kill: row.kill === 1, startedAt: row.started_at })),
    people,
    unmatched,
    signups,
    attendanceFlags: flagTeams,
    duties: dutiesView(dutyResult.results),
  };
}
