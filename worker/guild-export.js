// "Export guild data" (Phase 8): the guild's roster, raids, attendance and loot as ONE JSON file, for a Guild Master who wants a copy or is leaving.
// Every query names the columns it exports, so a column that is not listed here cannot reach the file. Never in it:
//   - Discord IDs, nicknames or usernames of anybody (players.discord_user_id / discord_nickname, raid_signups.discord_user_id / nickname);
//   - accounts: user ids, account keys, sessions, role assignments, blocks, who linked whom;
//   - Battle.net data (links, character claims, rank labels) and Warcraft Logs / Raid-Helper settings;
//   - guest-link tokens and their hashes, calendar-link token hashes;
//   - the free text only some viewers may read: roster notes unless the exporter may read that person's notes (roster.notes.view for the team of
//     the person's main character, exactly like the person page), attendance decision reasons unless they may review that raid's team, loot notes
//     unless they may edit loot, sign-up notes (never).
// The people and raids keep their Raidsmith ids so the lists in the file refer to each other.
import { allows } from './permissions.js';

export const EXPORT_FORMAT = 'raidsmith-guild-export';
export const EXPORT_VERSION = 1;

// What the file leaves out, in words (also written into the file so whoever opens it knows).
export const EXPORT_EXCLUDES = [
  'Discord IDs, nicknames and usernames',
  'accounts, sign-in data and role assignments',
  'Battle.net data and character claims',
  'guest links and calendar links',
  'free-text notes the exporting person is not allowed to read',
];

const parseJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

const byTeamId = (rows) => {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.team_id)) map.set(row.team_id, []);
    map.get(row.team_id).push(row);
  }
  return map;
};

// -> the export object. guildContext: loadGuildContext's result for the exporting person.
export async function buildGuildExport(db, guildContext, nowMs) {
  const guild = guildContext.guild;
  const can = guildContext.can;
  const gid = guild.id;
  const [
    teams, schedules, players, characters, raids, reports, attendance, decisions, signups, awards, attendancePolicies, lootPolicies,
  ] = (await db.batch([
    db.prepare('SELECT id, name, size, archived, created_at FROM teams WHERE guild_id = ? ORDER BY created_at, id').bind(gid),
    db.prepare('SELECT team_id, weekday, start_time, zone, title FROM team_schedules WHERE guild_id = ? ORDER BY team_id, weekday').bind(gid),
    db.prepare(
      `SELECT id, status, joined_on, trial_start, trial_end, left_on, left_reason, notes, rank, rank_on, created_at
         FROM players WHERE guild_id = ? ORDER BY created_at, id`,
    ).bind(gid),
    db.prepare(
      `SELECT id, player_id, team_id, name, realm, class, main_spec, off_spec, is_main
         FROM characters WHERE guild_id = ? ORDER BY player_id, is_main DESC, name_key, id`,
    ).bind(gid),
    db.prepare(
      `SELECT id, team_id, raid_on, starts_at, zone, title, event_title, size, log_mode, manual_reason, created_at
         FROM raids WHERE guild_id = ? ORDER BY starts_at, id`,
    ).bind(gid),
    db.prepare('SELECT raid_id, code, flavour, started_at, ended_at FROM raid_reports WHERE guild_id = ? ORDER BY raid_id, code').bind(gid),
    db.prepare(
      `SELECT raid_id, team_id, player_id, outcome, credit, signup_kind, attended, presence_source, flags, pulls_present, pulls_total
         FROM attendance WHERE guild_id = ? ORDER BY raid_id, player_id`,
    ).bind(gid),
    db.prepare(
      `SELECT d.raid_id, d.player_id, d.outcome, d.credit, d.reason, d.decided_at, r.team_id
         FROM attendance_decisions d JOIN raids r ON r.id = d.raid_id AND r.guild_id = d.guild_id
        WHERE d.guild_id = ? ORDER BY d.raid_id, d.player_id`,
    ).bind(gid),
    db.prepare(
      `SELECT raid_id, source, signup_id, kind, class_name, spec_name, position, player_id
         FROM raid_signups WHERE guild_id = ? ORDER BY raid_id, source, signup_id`,
    ).bind(gid),
    db.prepare(
      `SELECT id, raid_id, team_id, item_id, item_name, item_quality, awarded_at, winner_name, winner_realm, winner_class, roll_type, flags, tag, note, awarded_by
         FROM loot_awards WHERE guild_id = ? ORDER BY awarded_at, id`,
    ).bind(gid),
    db.prepare('SELECT team_id, policy FROM attendance_policies WHERE guild_id = ? ORDER BY team_id').bind(gid),
    db.prepare('SELECT team_id, policy FROM loot_policies WHERE guild_id = ? ORDER BY team_id').bind(gid),
  ])).map((result) => result.results);

  const scheduleByTeam = byTeamId(schedules);
  const charactersByPlayer = new Map();
  for (const row of characters) {
    if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
    charactersByPlayer.get(row.player_id).push(row);
  }
  // The person's home team is the team of their main character (the person page's rule for who may read the notes).
  const homeTeamOf = (playerId) => {
    const main = (charactersByPlayer.get(playerId) || []).find((row) => row.is_main === 1);
    return main ? main.team_id : null;
  };

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    excludes: EXPORT_EXCLUDES,
    guild: {
      name: guild.name,
      realm: guild.realm,
      realmKind: guild.realm_kind,
      region: guild.region,
      timeZone: guild.time_zone,
      gameVersion: guild.game_version,
      createdAt: guild.created_at,
    },
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      size: team.size,
      archived: team.archived === 1,
      schedule: (scheduleByTeam.get(team.id) || []).map((slot) => ({ weekday: slot.weekday, startTime: slot.start_time, zone: slot.zone, title: slot.title })),
    })),
    people: players.map((player) => {
      const homeTeam = homeTeamOf(player.id);
      const notesAllowed = homeTeam !== null && allows(can, 'roster.notes.view', homeTeam);
      return {
        id: player.id,
        status: player.status,
        joinedOn: player.joined_on,
        trialStart: player.trial_start,
        trialEnd: player.trial_end,
        leftOn: player.left_on,
        leftReason: player.left_reason,
        ...(player.rank ? { rank: player.rank, rankOn: player.rank_on } : {}), // PM wave 7: the rank id (the names are in the attendance policy's ladder)
        ...(notesAllowed && player.notes ? { notes: player.notes } : {}),
        characters: (charactersByPlayer.get(player.id) || []).map((row) => ({
          id: row.id,
          name: row.name,
          realm: row.realm,
          class: row.class,
          mainSpec: row.main_spec,
          offSpec: row.off_spec,
          isMain: row.is_main === 1,
          teamId: row.team_id,
        })),
      };
    }),
    raids: raids.map((raid) => ({
      id: raid.id,
      teamId: raid.team_id,
      raidOn: raid.raid_on,
      startsAt: raid.starts_at,
      zone: raid.zone,
      title: raid.title,
      eventTitle: raid.event_title,
      size: raid.size,
      attendanceBy: raid.log_mode === 'manual' ? 'hand' : 'log',
      manualReason: raid.log_mode === 'manual' ? raid.manual_reason : null,
      reports: reports.filter((report) => report.raid_id === raid.id).map((report) => ({
        code: report.code, flavour: report.flavour, startedAt: report.started_at, endedAt: report.ended_at,
      })),
    })),
    attendance: attendance.map((row) => ({
      raidId: row.raid_id,
      teamId: row.team_id,
      personId: row.player_id,
      outcome: row.outcome,
      credit: row.credit,
      signupKind: row.signup_kind,
      attended: row.attended === 1,
      presenceSource: row.presence_source,
      flags: parseJson(row.flags, []),
      pullsPresent: row.pulls_present,
      pullsTotal: row.pulls_total,
    })),
    attendanceDecisions: decisions
      .filter((row) => allows(can, 'attendance.review', row.team_id))
      .map((row) => ({
        raidId: row.raid_id, personId: row.player_id, outcome: row.outcome, credit: row.credit, reason: row.reason, decidedAt: row.decided_at,
      })),
    signups: signups.map((row) => ({
      raidId: row.raid_id,
      source: row.source,
      kind: row.kind,
      className: row.class_name,
      specName: row.spec_name,
      position: row.position,
      personId: row.player_id,
    })),
    loot: awards.map((row) => ({
      id: row.id,
      raidId: row.raid_id,
      teamId: row.team_id,
      itemId: row.item_id,
      itemName: row.item_name,
      itemQuality: row.item_quality,
      awardedAt: row.awarded_at,
      winner: row.winner_name,
      winnerRealm: row.winner_realm,
      winnerClass: row.winner_class,
      rollType: row.roll_type,
      flags: parseJson(row.flags, []),
      tag: row.tag,
      awardedBy: row.awarded_by,
      ...(row.note && allows(can, 'loot.edit', row.team_id) ? { note: row.note } : {}),
    })),
    attendanceRules: attendancePolicies.map((row) => ({ teamId: row.team_id, rules: parseJson(row.policy, {}) })),
    lootRules: lootPolicies.map((row) => ({ teamId: row.team_id, rules: parseJson(row.policy, {}) })),
  };
}
