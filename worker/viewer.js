// The read-only view: what a guest link and the public page show. It is built from the permissions the viewer's ONE role resolves to
// (permissions.js resolveViewerPermissions: the same rows and scopes as everyone else, read actions only) and from queries that name exactly the
// columns they show, so a field that is not listed here cannot reach a visitor. Never in it: officer notes, Discord IDs, nicknames or usernames,
// accounts, sign-up sources or notes, attendance reasons and decisions, raid report codes, plan links, loot notes or tags.
//   { guild: { name, realm, realmKind, region, gameVersion },
//     teams: [{ id, name }],                      the teams at least one section shows
//     sections: { roster?, raids?, attendance?, loot? }   each a list of { team, ... } for the teams the viewer may see }
import { teamAttendanceData } from './routes/attendance.js';
import { displayCharacter, groupBy } from './attendance-view.js';
import { SECTION_ACTIONS, allows } from './permissions.js';
import { roleOf } from './roster-data.js';

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

async function rosterSection(db, guild, team) {
  const result = await db.prepare(
    `SELECT c.player_id, c.name, c.class, c.main_spec, c.team_id, c.is_main
       FROM characters c JOIN players p ON p.id = c.player_id
      WHERE c.guild_id = ?1 AND p.status != 'inactive'
        AND c.player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`,
  ).bind(guild.id, team.id).all();
  const people = [...groupBy(result.results, 'player_id').values()]
    .map((characters) => displayCharacter(characters, team.id))
    .map((character) => ({ name: character.name, class: character.class, role: character.main_spec ? roleOf(character.class, character.main_spec) : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { team, people };
}

async function raidsSection(db, guild, team, nowMs) {
  const [upcoming, recent] = await db.batch([
    db.prepare(
      `SELECT raid_on, starts_at, zone, title FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at > ? ORDER BY starts_at, id LIMIT ?`,
    ).bind(guild.id, team.id, nowMs, UPCOMING_LIMIT),
    db.prepare(
      `SELECT raid_on, starts_at, zone, title FROM raids WHERE guild_id = ? AND team_id = ? AND starts_at <= ? ORDER BY starts_at DESC, id LIMIT ?`,
    ).bind(guild.id, team.id, nowMs, RECENT_LIMIT),
  ]);
  const shape = (row) => ({ raidOn: row.raid_on, startsAt: row.starts_at, zone: row.zone, title: row.title });
  return { team, upcoming: upcoming.results.map(shape), recent: recent.results.map(shape) };
}

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

async function lootSection(db, guild, team) {
  const result = await db.prepare(
    `SELECT item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_class
       FROM loot_awards WHERE guild_id = ? AND team_id = ? ORDER BY awarded_at DESC, id LIMIT ?`,
  ).bind(guild.id, team.id, LOOT_LIMIT).all();
  return {
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
  };
}

// guild: loadGuildRow's row. can: { action: 'guild' | [teamIds] } from resolveViewerPermissions.
export async function buildView(db, guild, can, nowMs) {
  const teamRows = (await db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guild.id).all()).results;
  const builders = {
    roster: (team) => rosterSection(db, guild, team),
    raids: (team) => raidsSection(db, guild, team, nowMs),
    attendance: (team) => attendanceSection(db, guild, team, nowMs),
    loot: (team) => lootSection(db, guild, team),
  };
  const sections = {};
  const shown = new Set();
  for (const [section, action] of Object.entries(SECTION_ACTIONS)) {
    const teams = teamRows.filter((team) => allows(can, action, team.id)).slice(0, MAX_VIEW_TEAMS).map((team) => ({ id: team.id, name: team.name }));
    if (!teams.length) continue;
    sections[section] = await Promise.all(teams.map((team) => builders[section](team)));
    for (const team of teams) shown.add(team.id);
  }
  return {
    guild: { name: guild.name, realm: guild.realm, realmKind: guild.realm_kind, region: guild.region, gameVersion: guild.game_version },
    teams: teamRows.filter((team) => shown.has(team.id)).map((team) => ({ id: team.id, name: team.name })),
    sections,
  };
}
