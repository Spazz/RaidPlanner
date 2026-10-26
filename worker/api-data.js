// The data behind the read-only API keys (PM wave 7): one reader per dataset, each answering flat rows for a spreadsheet. A reader sees what a MEMBER of the
// key's scope sees (scope.can is the Member role's read actions for it) and its queries name every column they return, so a field that is not listed here
// cannot reach a key. Never in them: officer notes, Discord IDs, nicknames or usernames, accounts, sign-up sources, attendance reasons or decisions,
// loot notes and tags, report codes. Reading is exactly worker/viewer.js's and the member pages' own queries, narrowed to flat columns.
//   scope = { guild (viewer.js loadGuildRow), teams: [{ id, name }] (the active teams the key reaches), can, params (URLSearchParams), now }
//   reader(db, scope) -> { columns: [names], rows: [{ [column]: value }], truncated?: true }
import { teamAttendanceData } from './routes/attendance.js';
import { lootAccess, lootPolicyRowsStatement, makeLootPolicyResolver } from './loot-store.js';
import { allows } from './permissions.js';
import { roleOf } from './roster-data.js';
import { API_DATASETS } from './api-keys.js';
import { notWonOffRosterSql, teamRosterSql } from './team-roster.js';

export const LOOT_ROW_CAP = 5000;
export const RAID_ROW_CAP = 500;
const QUALITY = ['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Artifact', 'Heirloom'];

// The teams of the scope the key may read this dataset for.
const teamsFor = (scope, dataset) => scope.teams.filter((team) => allows(scope.can, API_DATASETS[dataset].action, team.id));
const idsJson = (teams) => JSON.stringify(teams.map((team) => team.id));
const empty = (columns) => ({ columns, rows: [] });

const ROSTER_COLUMNS = ['team', 'character', 'realm', 'class', 'role', 'main_spec', 'off_spec', 'main', 'status', 'joined_on'];

async function readRoster(db, scope) {
  const teams = teamsFor(scope, 'roster');
  if (!teams.length) return empty(ROSTER_COLUMNS);
  // A team roster lists the characters on it (worker/team-roster.js: placed, still here, a raiding rank): a teamless, Social or Former character is left out.
  // `status` is the character's core rank (raider, trial or reserve).
  const result = await db.prepare(
    `SELECT t.name AS team_name, c.name, c.realm, c.class, c.main_spec, c.off_spec, c.is_main, c.core_rank, p.joined_on
       FROM characters c
       JOIN players p ON p.id = c.player_id AND p.guild_id = c.guild_id
       JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
      WHERE c.guild_id = ? AND c.team_id IN (SELECT value FROM json_each(?)) AND ${teamRosterSql('c')}
      ORDER BY t.name, c.is_main DESC, c.name, c.id`,
  ).bind(scope.guild.id, idsJson(teams)).all();
  return {
    columns: ROSTER_COLUMNS,
    rows: result.results.map((row) => ({
      team: row.team_name, character: row.name, realm: row.realm, class: row.class, role: row.main_spec ? roleOf(row.class, row.main_spec) : null,
      main_spec: row.main_spec, off_spec: row.off_spec, main: row.is_main === 1, status: row.core_rank, joined_on: row.joined_on,
    })),
  };
}

const ATTENDANCE_COLUMNS = ['team', 'name', 'class', 'status', 'rank', 'window_weeks', 'attendance_pct', 'raids_counted', 'signup_rate_pct', 'absence_streak', 'last_attended'];

// One row per person per team: the percentages of the team page's window (?window=8, 12 ... or all), without the cells, outcomes or reasons.
async function readAttendance(db, scope) {
  const teams = teamsFor(scope, 'attendance');
  const rows = [];
  for (const team of teams) {
    // rosterOnly: the people on the team's roster; `status` is the core rank of their roster character.
    const data = await teamAttendanceData(db, scope.guild, team, scope.params, scope.now, null, { rosterOnly: true });
    for (const person of data.people) {
      if (person.name === 'Unknown') continue;
      rows.push({
        team: team.name, name: person.name, class: person.class, status: person.rosterRank, rank: person.rank ? person.rank.name : null, window_weeks: data.window,
        attendance_pct: typeof person.pct === 'number' ? person.pct : null, raids_counted: person.counted || 0,
        signup_rate_pct: typeof person.signupRate === 'number' ? person.signupRate : null, absence_streak: person.streak || 0, last_attended: person.lastAttended || null,
      });
    }
  }
  return { columns: ATTENDANCE_COLUMNS, rows };
}

const LOOT_COLUMNS = ['raid_on', 'team', 'item_id', 'item', 'quality', 'winner', 'winner_class', 'roll_type', 'disenchanted'];

async function readLoot(db, scope) {
  const viewable = teamsFor(scope, 'loot');
  if (!viewable.length) return empty(LOOT_COLUMNS);
  const policyResult = await lootPolicyRowsStatement(db, scope.guild.id).all();
  const resolver = makeLootPolicyResolver(policyResult.results);
  // A team whose loot is private to each player shows nothing to a key (a key is nobody in particular), as on the public page.
  const teams = viewable.filter((team) => lootAccess({ can: scope.can }, resolver, team.id).level === 'full');
  if (!teams.length) return empty(LOOT_COLUMNS);
  const result = await db.prepare(
    `SELECT r.raid_on, t.name AS team_name, a.item_id, a.item_name, a.item_quality, a.winner_name, a.winner_name_key, a.winner_class, a.roll_type
       FROM loot_awards a
       JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
       JOIN teams t ON t.id = a.team_id AND t.guild_id = a.guild_id
      WHERE a.guild_id = ? AND a.team_id IN (SELECT value FROM json_each(?)) AND ${notWonOffRosterSql('a')}
      ORDER BY r.raid_on DESC, a.awarded_at DESC, a.id LIMIT ?`,
  ).bind(scope.guild.id, idsJson(teams), LOOT_ROW_CAP + 1).all();
  const truncated = result.results.length > LOOT_ROW_CAP;
  return {
    columns: LOOT_COLUMNS,
    truncated,
    rows: result.results.slice(0, LOOT_ROW_CAP).map((row) => ({
      raid_on: row.raid_on, team: row.team_name, item_id: row.item_id, item: row.item_name,
      quality: Number.isInteger(row.item_quality) && QUALITY[row.item_quality] ? QUALITY[row.item_quality] : null,
      winner: row.winner_name_key === null ? null : row.winner_name, winner_class: row.winner_name_key === null ? null : row.winner_class,
      roll_type: row.roll_type, disenchanted: row.winner_name_key === null,
    })),
  };
}

const RAID_COLUMNS = ['raid_on', 'team', 'zone', 'title', 'bosses_killed', 'present', 'bench', 'missed'];

// The raids that have started, newest first: the date, the zone, how many different bosses died and the attendance counts the Raids list shows.
async function readRaids(db, scope) {
  const teams = teamsFor(scope, 'raids');
  if (!teams.length) return empty(RAID_COLUMNS);
  const result = await db.prepare(
    `SELECT r.raid_on, t.name AS team_name, r.zone, COALESCE(r.title, r.event_title) AS title,
            (SELECT COUNT(DISTINCT p.encounter_id) FROM raid_pulls p WHERE p.raid_id = r.id AND p.kill = 1) AS bosses_killed,
            (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome IN ('present', 'late', 'left_early', 'late_left', 'fill_in')) AS present,
            (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome = 'bench') AS bench,
            (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id AND a.outcome IN ('missed', 'missed_notice')) AS missed
       FROM raids r JOIN teams t ON t.id = r.team_id AND t.guild_id = r.guild_id
      WHERE r.guild_id = ? AND r.team_id IN (SELECT value FROM json_each(?)) AND r.starts_at <= ?
      ORDER BY r.raid_on DESC, r.id LIMIT ?`,
  ).bind(scope.guild.id, idsJson(teams), scope.now, RAID_ROW_CAP + 1).all();
  const truncated = result.results.length > RAID_ROW_CAP;
  return {
    columns: RAID_COLUMNS,
    truncated,
    rows: result.results.slice(0, RAID_ROW_CAP).map((row) => ({
      raid_on: row.raid_on, team: row.team_name, zone: row.zone, title: row.title, bosses_killed: row.bosses_killed, present: row.present, bench: row.bench, missed: row.missed,
    })),
  };
}

export const READERS = { roster: readRoster, attendance: readAttendance, loot: readLoot, raids: readRaids };
