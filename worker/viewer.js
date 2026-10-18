// The read-only view: what a guest link and the public page show. It is built from the permissions the viewer's ONE role resolves to
// (permissions.js resolveViewerPermissions: the same rows and scopes as everyone else, read actions only) and from queries that name exactly the
// columns they show, so a field that is not listed here cannot reach a visitor. Never in it: officer notes, Discord IDs, usernames or nicknames,
// accounts, sign-up sources or notes, attendance reasons and decisions, raid report codes, plan links, loot notes or tags.
//   { guild: { name, realm, realmKind, region, gameVersion, timeZone },   timeZone: so the times on the page carry the guild's zone
//     teams: [{ id, name }],                      the teams at least one section shows
//     sections: { roster?, raids?, progress?, attendance?, loot? }   each a list of { team, ... } for the teams the viewer may see }
// Cost: the roster, raids and loot of ALL the shown teams are read in one DB.batch (a handful of statements however many teams); attendance runs the
// team page's own computation once per team.
import { teamAttendanceData } from './routes/attendance.js';
import { displayCharacter, groupBy } from './attendance-view.js';
import { lootPolicyRowsStatement, makeLootPolicyResolver } from './loot-store.js';
import { SECTION_ACTIONS, allows } from './permissions.js';
import { buildProgress, publicProgress } from './progress.js';
import { progressPullsStatement } from './progress-store.js';
import { roleOf } from './roster-data.js';

// Every section the read-only view can build, in the page's order, and the read action each needs. A guest link shows the four of SECTION_ACTIONS (a role
// grants those); the public page can also tick Progress (PM wave 7: the team's boss kills), which rides on the raids read action.
export const VIEW_SECTIONS = { roster: 'roster.view', raids: 'raids.view', progress: 'raids.view', attendance: 'attendance.view', loot: 'loot.view' };

const MAX_VIEW_TEAMS = 12;
const UPCOMING_LIMIT = 20;
const RECENT_LIMIT = 10;
const LOOT_LIMIT = 50;

// The same guild columns loadGuildContext reads: the attendance rules need the region, the time zone and the Warcraft Logs link.
export async function loadGuildRow(db, guildId) {
  return db.prepare(
    `SELECT id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, wcl_guild_id, created_at, public_enabled, public_sections
       FROM guilds WHERE id = ?`,
  ).bind(guildId).first();
}

// Per team: the statements that read it, and how to shape their results (shape(team, results, guild)). `results` are the results of this section's own
// statements, in order.
const SECTION_READS = {
  roster: {
    statements: (db, guild, team) => [db.prepare(
      `SELECT c.player_id, c.name, c.class, c.main_spec, c.team_id, c.is_main
         FROM characters c JOIN players p ON p.id = c.player_id
        WHERE c.guild_id = ?1 AND p.status != 'inactive'
          AND c.player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`,
    ).bind(guild.id, team.id)],
    shape: (team, [result]) => ({
      team,
      people: [...groupBy(result.results, 'player_id').values()]
        .map((characters) => displayCharacter(characters, team.id))
        .map((character) => ({ name: character.name, class: character.class, role: character.main_spec ? roleOf(character.class, character.main_spec) : null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  },
  raids: {
    statements: (db, guild, team, nowMs) => [
      db.prepare('SELECT raid_on, starts_at, zone, title FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at > ? ORDER BY starts_at, id LIMIT ?')
        .bind(guild.id, team.id, nowMs, UPCOMING_LIMIT),
      db.prepare('SELECT raid_on, starts_at, zone, title FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at <= ? ORDER BY starts_at DESC, id LIMIT ?')
        .bind(guild.id, team.id, nowMs, RECENT_LIMIT),
    ],
    shape: (team, [upcoming, recent]) => {
      const shape = (row) => ({ raidOn: row.raid_on, startsAt: row.starts_at, zone: row.zone, title: row.title });
      return { team, upcoming: upcoming.results.map(shape), recent: recent.results.map(shape) };
    },
  },
  // PM wave 7: the team's boss kills, from the stored pulls (worker/progress.js). No raid ids, no report codes.
  progress: {
    statements: (db, guild, team) => [progressPullsStatement(db, guild.id, team.id)],
    shape: (team, [result], guild) => ({ team, ...publicProgress(buildProgress(result.results, guild.game_version)) }),
  },
  loot: {
    statements: (db, guild, team) => [db.prepare(
      `SELECT item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_class
         FROM loot_awards WHERE guild_id = ? AND team_id = ? ORDER BY awarded_at DESC, id LIMIT ?`,
    ).bind(guild.id, team.id, LOOT_LIMIT)],
    shape: (team, [result]) => ({
      team,
      awards: result.results.map((row) => ({
        itemId: row.item_id,
        itemName: row.item_name,
        quality: row.item_quality,
        awardedAt: row.awarded_at,
        winner: row.winner_name_key === null ? null : row.winner_name,
        winnerClass: row.winner_name_key === null ? null : row.winner_class,
        disenchanted: row.winner_name_key === null,
      })),
    }),
  },
};

// Percentages only (the team page's window and rules): a name, a class and how often they came. Not the cells, outcomes, reasons or sign-up kinds.
async function attendanceSection(db, guild, team, nowMs) {
  const data = await teamAttendanceData(db, guild, team, new URLSearchParams(), nowMs, null);
  return {
    team,
    window: data.window,
    raids: data.weeks.reduce((sum, week) => sum + week.raids.length, 0),
    people: data.people
      .filter((person) => person.status !== 'inactive' && person.name !== 'Unknown')
      .map((person) => ({ name: person.name, class: person.class, pct: typeof person.pct === 'number' ? person.pct : null, counted: person.counted || 0 })),
  };
}

// guild: loadGuildRow's row. can: { action: 'guild' | [teamIds] } from resolveViewerPermissions. only: the sections to build (the public page's ticked
// ones; two sections can share a read action, so `can` alone cannot say), default the four a guest link can show.
export async function buildView(db, guild, can, nowMs, { only = Object.keys(SECTION_ACTIONS) } = {}) {
  const [teamResult, lootPolicyResult] = await db.batch([
    db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guild.id),
    lootPolicyRowsStatement(db, guild.id),
  ]);
  const teamRows = teamResult.results;
  const lootPolicy = makeLootPolicyResolver(lootPolicyResult.results);
  const visible = {};
  const shown = new Set();
  for (const [section, action] of Object.entries(VIEW_SECTIONS)) {
    if (!only.includes(section)) continue;
    let teams = teamRows.filter((team) => allows(can, action, team.id)).slice(0, MAX_VIEW_TEAMS).map((team) => ({ id: team.id, name: team.name }));
    // A team whose loot is private to each player ("own": a person sees only their own awards) shows no loot to someone who is nobody in particular.
    if (section === 'loot') teams = teams.filter((team) => lootPolicy.resolved(team.id).visibility.members !== 'own');
    if (teams.length) visible[section] = teams;
  }

  // One batch for everything the roster, raids and loot of every shown team need.
  const reads = [];
  for (const section of ['roster', 'raids', 'progress', 'loot']) {
    for (const team of visible[section] || []) {
      const statements = SECTION_READS[section].statements(db, guild, team, nowMs);
      reads.push({ section, team, from: 0, count: statements.length, statements });
    }
  }
  const all = reads.flatMap((read) => read.statements);
  const results = all.length ? await db.batch(all) : [];
  const sections = {};
  let at = 0;
  for (const read of reads) {
    const slice = results.slice(at, at + read.count);
    at += read.count;
    if (!sections[read.section]) sections[read.section] = [];
    sections[read.section].push(SECTION_READS[read.section].shape(read.team, slice, guild));
  }
  if (visible.attendance) sections.attendance = await Promise.all(visible.attendance.map((team) => attendanceSection(db, guild, team, nowMs)));

  const shownTeams = new Set(Object.values(visible).flatMap((teams) => teams.map((team) => team.id)));
  // Keep the sections in the page's order whatever order they were built in.
  const ordered = {};
  for (const section of Object.keys(VIEW_SECTIONS)) if (sections[section]) ordered[section] = sections[section];
  return {
    guild: { name: guild.name, realm: guild.realm, realmKind: guild.realm_kind, region: guild.region, gameVersion: guild.game_version, timeZone: guild.time_zone },
    teams: teamRows.filter((team) => shownTeams.has(team.id)).map((team) => ({ id: team.id, name: team.name })),
    sections: ordered,
  };
}
