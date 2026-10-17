// Read side of the raids: the raid detail every raid route answers with, the shared character-display rule and
// the redaction (nicknames, reasons, other teams' attendance) by permission.
import { HttpError } from './http.js';
import { allows } from './permissions.js';
import { findUnmatched, makePolicyResolver, presenceKey } from './attendance-store.js';

export const OUTCOME_PRESENT = ['present', 'late', 'left_early', 'late_left', 'fill_in'];

// 'stale' = a log is stored but its results are not (a recompute failed or never ran): never shown as reviewed.
// attendance_rows is the raid's stored attendance row count; a query that does not select it skips the empty-rows check.
export function raidState(raid, reports) {
  if (raid.log_mode === 'manual') return raid.open_flags > 0 ? 'to_review' : 'manual';
  if (!reports) return 'awaiting_log';
  if (raid.policy_fp === '' || raid.attendance_rows === 0) return 'stale';
  return raid.open_flags > 0 ? 'to_review' : 'reviewed';
}

// A raid with no log has no results to go stale; every other raid is stale when its fingerprint differs from the team's current one.
export function isStale(raid, state, resolver) {
  return state === 'stale' || (state !== 'awaiting_log' && raid.policy_fp !== resolver.fingerprint(raid.team_id));
}

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

const userName = (row) => row.global_name || row.username;
const parseFlags = (text) => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; } };

// One read batch + the shaping. -> the raid detail object (see tasks/guild-phase3-spec.md, API), or throws 404.
export async function loadRaidDetail(ctx, guildContext, raidId) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const bind = (sql) => db.prepare(sql).bind(guild.id, raidId);
  const [raidResult, reportResult, pullResult, signupResult, planResult, attendanceResult, characterResult, presenceResult, guestResult,
    policyResult, userResult, teamResult, flagResult, decisionResult, manualResult] = await db.batch([
    bind(`SELECT r.*, t.name AS team_name, (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports,
                 (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id) AS attendance_rows
            FROM raids r JOIN teams t ON t.id = r.team_id AND t.guild_id = r.guild_id WHERE r.guild_id = ?1 AND r.id = ?2`),
    bind(`SELECT code, flavour, started_at, ended_at, owner, synced_at,
                 (SELECT COUNT(*) FROM raid_pulls p WHERE p.raid_id = raid_reports.raid_id AND p.report_code = raid_reports.code) AS pulls
            FROM raid_reports WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY started_at, code`),
    bind('SELECT encounter_name, kill, started_at FROM raid_pulls WHERE raid_id = ?2 ORDER BY started_at, id'),
    bind('SELECT source, signup_id, kind, class_name, spec_name, position, player_id, nickname FROM raid_signups WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY position, source, signup_id'),
    bind('SELECT name, name_key, group_number FROM raid_plan WHERE raid_id = ?2 ORDER BY rowid'),
    bind('SELECT * FROM attendance WHERE raid_id = ?2 AND guild_id = ?1'),
    bind(`SELECT c.player_id, c.name, c.name_key, c.realm_key, c.class, c.team_id, c.is_main FROM characters c
           WHERE c.guild_id = ?1 AND (c.player_id IN (SELECT player_id FROM attendance WHERE raid_id = ?2)
              OR c.name_key IN (SELECT name_key FROM raid_presence WHERE raid_id = ?2)
              OR c.name_key IN (SELECT name_key FROM raid_plan WHERE raid_id = ?2))`),
    bind(`SELECT name, name_key, realm, realm_key, class, COUNT(*) AS pulls FROM raid_presence
           WHERE raid_id = ?2 AND guild_id = ?1 GROUP BY name_key, realm_key`),
    db.prepare('SELECT name_key, realm_key FROM attendance_guests WHERE guild_id = ?').bind(guild.id),
    db.prepare('SELECT id, team_id, policy, version FROM attendance_policies WHERE guild_id = ?').bind(guild.id),
    bind(`SELECT id, username, global_name FROM users WHERE id IN (SELECT decided_by FROM attendance_decisions WHERE raid_id = ?2 AND decided_by IS NOT NULL)
             OR id = (SELECT manual_by FROM raids WHERE id = ?2 AND guild_id = ?1)`),
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guild.id),
    db.prepare('SELECT team_id, COUNT(*) AS n FROM raids WHERE guild_id = ? AND open_flags > 0 GROUP BY team_id').bind(guild.id),
    bind('SELECT player_id, reason, flags, decided_by, decided_at FROM attendance_decisions WHERE raid_id = ?2 AND guild_id = ?1'),
    bind('SELECT player_id FROM raid_manual WHERE raid_id = ?2 AND guild_id = ?1 ORDER BY player_id'),
  ]);
  const raid = raidResult.results[0];
  if (!raid) throw new HttpError(404, 'not_found', 'That raid does not exist.');
  const can = guildContext.can;
  const teamId = raid.team_id;
  const seeAttendance = allows(can, 'attendance.view', teamId);
  const review = allows(can, 'attendance.review', teamId);
  const seeNicknames = allows(can, 'roster.edit', teamId);
  const resolver = makePolicyResolver(guild, policyResult.results);
  const state = raidState(raid, raid.reports);
  const users = new Map(userResult.results.map((row) => [row.id, row]));
  const decisions = new Map(decisionResult.results.map((row) => [row.player_id, row]));

  const charactersByPlayer = groupBy(characterResult.results, 'player_id');
  const characterKeys = new Set(characterResult.results.map((row) => presenceKey(row.name_key, row.realm_key)));
  // The character query is narrowed to this raid's names; a character with the same name on another realm key still matches only by key.
  const guestKeys = new Set(guestResult.results.map((row) => presenceKey(row.name_key, row.realm_key)));

  const planByPlayer = new Map();
  const charactersByName = groupBy(characterResult.results, 'name_key');
  for (const entry of planResult.results) {
    for (const character of charactersByName.get(entry.name_key) || []) {
      if (!planByPlayer.has(character.player_id)) planByPlayer.set(character.player_id, entry.group_number === 0 ? 'bench' : `G${entry.group_number}`);
    }
  }

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
      zone: raid.zone,
      state,
      openFlags: raid.open_flags,
      stale: isStale(raid, state, resolver),
      version: raid.version,
      manual: raid.log_mode === 'manual'
        ? {
          reason: raid.manual_reason, by: manualBy ? userName(manualBy) : null, at: raid.manual_at,
          presentPlayerIds: seeAttendance ? manualResult.results.map((row) => row.player_id) : [],
        }
        : null,
    },
    can: { edit: allows(can, 'raids.edit', teamId), review, seeAttendance, seeNicknames },
    sources: {
      event: raid.event_id ? {
        id: raid.event_id, title: raid.event_title, syncedAt: raid.event_synced, signups: raidHelperSignups,
        otherServer: raid.event_server !== null && raid.event_server !== guild.discord_server_id,
      } : null,
      reports: reportResult.results.map((row) => ({ code: row.code, flavour: row.flavour, startedAt: row.started_at, pulls: row.pulls })),
      plan: raid.plan_synced !== null && raid.plan_synced !== undefined
        ? { label: raid.plan_label, players: planNames.length, unmatched: seeAttendance ? planNames.filter((entry) => !matchedPlanKeys.has(entry.name_key)).map((entry) => entry.name) : [] }
        : null,
    },
    pulls: pullResult.results.map((row) => ({ encounter: row.encounter_name, kill: row.kill === 1, startedAt: row.started_at })),
    people,
    unmatched,
    signups,
    attendanceFlags: flagTeams,
  };
}
