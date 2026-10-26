// The one redaction-aware builder for roster responses: the person record, the roster rows, the 409 `current`,
// and the nav-badge counts. Every response that shows a person goes through here, so a member never gets a
// field an officer would (notes, nicknames, flags) by taking a different route.
import { isOwnPlayer, memberSql } from './membership.js';
import { allows, isGranted } from './permissions.js';
import { toPerson } from './person.js';
import { characterOfRow, personFields } from './person-rank.js';
import { raidRoleOf } from './recruit-data.js';
import { roleOf, todayIn, trialFlag } from './roster-data.js';
import { isTeamRosterRow, onTeamRosterSql } from './team-roster.js';
import { visibleCharacterSql } from './character-visibility.js';

// Avatar URLs carry the user's Discord ID, so only the people who can open People and roles (where avatars are
// already shown) get them in roster responses; everyone else gets initials.
export function canSeeAvatars(can) {
  return allows(can, 'guild.access') || allows(can, 'guild.roles');
}

export function guildToday(guild, nowMs) {
  return todayIn(guild.time_zone, nowMs);
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

// The five person fields in the shape the players row had (status, trial_start, trial_end, left_on, left_reason), worked out from the person's characters
// (worker/person-rank.js personFields): the API still shows them on a person, the players row no longer decides them (lane B2). characters: shaped
// characters (characterOfRow).
export function personColumnsOf(characters) {
  const fields = personFields({ characters });
  return { status: fields.status, trial_start: fields.trialStart, trial_end: fields.trialEnd, left_on: fields.leftOn, left_reason: fields.leftReason };
}

// A teamless character (team_id NULL, from lane B2 on) has team { id: null, name: null, archived: false }: the shape stays, the id is null.
export function characterView(row) {
  return {
    id: row.id,
    name: row.name,
    realm: row.realm,
    class: row.class,
    mainSpec: row.main_spec,
    offSpec: row.off_spec,
    role: row.main_spec ? roleOf(row.class, row.main_spec) : null,
    isMain: row.is_main === 1,
    team: { id: row.team_id, name: row.team_name, archived: row.team_archived === 1 },
  };
}

// The player row, its characters (with their team), the accounts linked to the person and the notes editor. null when the person
// is not in this guild. An account is linked by an officer (players.user_id: the "link" arm) or by the Discord ID the person carries (the
// "discord" arm), and counts only while it is a member of the guild (worker/membership.js). linkedUser is the account of the Discord arm
// (what the Discord line of the record shows), accountUser the account the person belongs to (the link arm first).
export async function loadPersonData(db, guildId, personId) {
  const [playerResult, characterResult, userResult, editorResult] = await db.batch([
    // Every players column except the five person fields (status, trial and left dates): those come from the characters below.
    db.prepare(
      `SELECT id, guild_id, joined_on, discord_user_id, discord_nickname, notes, notes_updated_by, notes_updated_at, version, notes_version,
              created_by, created_at, updated_at, user_id, rank, rank_on
         FROM players WHERE id = ? AND guild_id = ?`,
    ).bind(personId, guildId),
    db.prepare(
      `SELECT c.id, c.team_id, c.name, c.realm, c.class, c.main_spec, c.off_spec, c.is_main, c.core_rank, c.left_on, c.left_reason, c.trial_start, c.trial_end,
              c.blizzard_char_id, t.name AS team_name, t.archived AS team_archived
         FROM characters c LEFT JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
        WHERE c.player_id = ? AND c.guild_id = ? AND ${visibleCharacterSql('c')}`,
    ).bind(personId, guildId),
    db.prepare(
      `SELECT u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar,
              COALESCE(u.id = p.user_id, 0) AS by_link, COALESCE(p.discord_user_id IS NOT NULL AND u.discord_id = p.discord_user_id, 0) AS by_discord
         FROM players p JOIN users u ON (u.id = p.user_id OR (p.discord_user_id IS NOT NULL AND u.discord_id = p.discord_user_id))
        WHERE p.id = ? AND p.guild_id = ?
          AND ${memberSql('u.id', 'p.guild_id', '(SELECT discord_server_id FROM guilds WHERE id = p.guild_id)')}
        ORDER BY by_link DESC, u.id`,
    ).bind(personId, guildId),
    db.prepare(
      `SELECT id, discord_id, username, global_name, display_name, avatar FROM users
        WHERE id = (SELECT notes_updated_by FROM players WHERE id = ? AND guild_id = ?)`,
    ).bind(personId, guildId),
  ]);
  const player = playerResult.results[0];
  if (!player) return null;
  Object.assign(player, personColumnsOf(characterResult.results.map(characterOfRow)));
  const characters = characterResult.results.map((row) => ({ row, view: characterView(row) }));
  characters.sort((a, b) => (b.row.is_main - a.row.is_main) || byName(a.view, b.view));
  const accounts = userResult.results;
  return {
    player,
    characters,
    linkedUser: accounts.find((row) => row.by_discord === 1) || null,
    accountUser: accounts[0] || null,
    notesUser: editorResult.results[0] || null,
  };
}

// The signed-in user as the ownership tests want them: { userId, discordId } (discordId is null for an account without Discord).
export function viewerOf(ctx) {
  return { userId: ctx.session.user.id, discordId: ctx.session.user.discordId };
}

export function signInOf(player, linkedUser) {
  if (linkedUser) return 'signed_in';
  return player.discord_user_id ? 'not_yet' : 'no_discord';
}

export function homeTeamOf(data) {
  const main = data.characters.find((entry) => entry.row.is_main === 1);
  return main ? main.view.team : null;
}

export function notesView(data, guildContext, home) {
  if (!home || !allows(guildContext.can, 'roster.notes.view', home.id)) return null;
  const { player } = data;
  return {
    text: player.notes || '',
    version: player.notes_version,
    updatedBy: data.notesUser ? toPerson(data.notesUser, { avatar: canSeeAvatars(guildContext.can) }) : null,
    updatedAt: player.notes_updated_at,
  };
}

// The person record for this viewer.
export function buildPersonRecord(guildContext, data, today, viewer) {
  const { player } = data;
  const home = homeTeamOf(data);
  const can = guildContext.can;
  const edit = !!home && allows(can, 'roster.edit', home.id);
  // The teams a delete must be allowed on: each character's own team; a character on no team is covered by the person's home team (as in deletePerson).
  const teamIds = [...new Set(data.characters.map((entry) => (entry.view.team.id === null && home ? home.id : entry.view.team.id)))];
  return {
    today,
    can: {
      edit,
      notesView: !!home && allows(can, 'roster.notes.view', home.id),
      notesEdit: !!home && allows(can, 'roster.notes.edit', home.id),
      delete: teamIds.every((teamId) => allows(can, 'roster.edit', teamId)),
      addCharacter: edit,
    },
    person: {
      id: player.id,
      status: player.status,
      joinedOn: player.joined_on,
      trialStart: player.trial_start,
      trialEnd: player.trial_end,
      leftOn: player.left_on,
      leftReason: player.left_reason,
      trialFlag: trialFlag(player.status, player.trial_end, today),
      isMe: isOwnPlayer(player, viewer),
      version: player.version,
      discord: {
        signIn: signInOf(player, data.linkedUser),
        user: data.linkedUser ? toPerson(data.linkedUser, { avatar: canSeeAvatars(can) }) : null,
        nickname: edit ? player.discord_nickname : null,
      },
      // The Raidsmith account the person belongs to: via 'link' (an officer linked it, or an approved claim did) or 'discord' (the Discord ID matches).
      // An officer can change a 'link'; a 'discord' one changes through the Discord account field.
      account: {
        user: data.accountUser ? toPerson(data.accountUser, { avatar: canSeeAvatars(can) }) : null,
        via: data.accountUser ? (data.accountUser.by_link === 1 ? 'link' : 'discord') : null,
        linked: !!player.user_id,
      },
      homeTeam: home && home.id ? { id: home.id, name: home.name } : null,
    },
    characters: data.characters.map((entry) => entry.view),
    notes: notesView(data, guildContext, home),
  };
}

// -> the person record, or null when the person is not in the guild.
export async function personRecordFor(ctx, guildContext, personId) {
  const data = await loadPersonData(ctx.db, guildContext.guild.id, personId);
  if (!data) return null;
  return buildPersonRecord(guildContext, data, guildToday(guildContext.guild, ctx.now()), viewerOf(ctx));
}

// { [teamId]: n }: trial flags per HOME team, for the teams the viewer can edit; {} for everyone else.
export async function loadRosterFlags(db, guildContext, today) {
  const scope = guildContext.can['roster.edit'];
  if (!scope || (Array.isArray(scope) && !scope.length)) return {};
  const guildId = guildContext.guild.id;
  const [teamResult, trialResult] = await db.batch([
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guildId),
    // A trial flag counts for the team of the person's main.
    db.prepare(
      `SELECT m.team_id, m.core_rank AS status, m.trial_end FROM characters m
        WHERE m.guild_id = ? AND m.is_main = 1 AND m.core_rank = 'trial' AND m.trial_end IS NOT NULL AND ${visibleCharacterSql('m')}`,
    ).bind(guildId),
  ]);
  const flags = {};
  for (const team of teamResult.results) {
    if (allows(guildContext.can, 'roster.edit', team.id)) flags[team.id] = 0;
  }
  for (const row of trialResult.results) {
    // A person whose main has no team (team_id NULL) counts for no team.
    if (row.team_id !== null && flags[row.team_id] !== undefined && trialFlag(row.status, row.trial_end, today)) flags[row.team_id]++;
  }
  return flags;
}

// { [teamId]: n }: New applications wanting each active team, for the teams the viewer can edit; {} for everyone else. One query.
export async function loadApplicationFlags(db, guildContext) {
  if (!isGranted(guildContext.can['roster.edit'])) return {};
  const result = await db.prepare(
    `SELECT t.id, (SELECT COUNT(*) FROM applications a WHERE a.guild_id = t.guild_id AND a.team_id = t.id AND a.status = 'new') AS n
       FROM teams t WHERE t.guild_id = ? AND t.archived = 0`,
  ).bind(guildContext.guild.id).all();
  const flags = {};
  for (const team of result.results) {
    if (allows(guildContext.can, 'roster.edit', team.id)) flags[team.id] = team.n;
  }
  return flags;
}

// { [teamId]: n }: pending team requests (a person asked for a character to be placed on the team), for the active teams the viewer can edit; {} for everyone
// else. The badge counts these and nothing else (D6): the characters on no team are a list, not a to-do. One query.
export async function loadTeamRequestFlags(db, guildContext) {
  if (!isGranted(guildContext.can['roster.edit'])) return {};
  const result = await db.prepare(
    `SELECT t.id, (SELECT COUNT(*) FROM team_requests q WHERE q.guild_id = t.guild_id AND q.team_id = t.id AND q.status = 'pending') AS n
       FROM teams t WHERE t.guild_id = ? AND t.archived = 0`,
  ).bind(guildContext.guild.id).all();
  const flags = {};
  for (const team of result.results) {
    if (allows(guildContext.can, 'roster.edit', team.id)) flags[team.id] = team.n;
  }
  return flags;
}

// The pending character claims of the guild, for the Attendance nav badge (the Review queue lists them): the same count the Needs attention item shows.
// Only for people who can decide claims (roster.edit anywhere); 0 for everyone else.
export async function loadPendingClaims(db, guildContext) {
  if (!isGranted(guildContext.can['roster.edit'])) return 0;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM character_claims WHERE guild_id = ? AND status = 'pending'").bind(guildContext.guild.id).first();
  return row ? row.n : 0;
}

// The reply for a person: the record plus the refreshed nav-badge counts.
export async function personReply(ctx, guildContext, personId) {
  const record = await personRecordFor(ctx, guildContext, personId);
  if (!record) return null;
  const rosterFlags = await loadRosterFlags(ctx.db, guildContext, record.today);
  return { ...record, rosterFlags };
}

// The people of the team's Roster list, by the character that puts them there (?1 = guild, ?2 = team):
//   default   a character on the team's roster (worker/team-roster.js: placed, still here, a raiding rank); a Social or Former character is never listed
//   inactive  the team's PLACED Social / Former people: a character placed on the team and none of the person's on its roster
// The inactive list is the Roster page's Inactive filter, kept working exactly as before (same rows, same audience: whoever may view the roster) so that an
// officer can still reach and reactivate an inactive person. RETIRED when the Users page ships (R4, lane B8a): delete `inactive` here, the `status` query
// of GET /roster and the page's request for it.
const ROSTER_MEMBERS_SQL = `SELECT rc.player_id FROM characters rc WHERE rc.guild_id = ?1 AND ${onTeamRosterSql('rc', '?2')}`;
const INACTIVE_MEMBERS_SQL = `SELECT rc.player_id FROM characters rc WHERE rc.guild_id = ?1 AND rc.team_id = ?2
       AND NOT EXISTS (SELECT 1 FROM characters rr WHERE rr.guild_id = ?1 AND rr.player_id = rc.player_id AND ${onTeamRosterSql('rr', '?2')})`;

// A row of the list below: is that character on a team roster? (Its rank columns are aliased character_*, so they never shadow the person's own left_on.)
const isOnRoster = (row) => isTeamRosterRow({ team_id: row.team_id, left_on: row.character_left_on, core_rank: row.character_core_rank });

// GET /roster?team=: every person with a character on the team's roster. A Social or Former character is never listed; the person's other characters still
// come with them (the Main, the alt count). options.inactive (GET /roster?team=&status=inactive): the team's placed Social / Former people instead.
export async function loadRosterRows(db, guildContext, team, today, viewer, { inactive = false } = {}) {
  const guildId = guildContext.guild.id;
  const rowsSql = `SELECT p.id AS player_id, p.joined_on, p.discord_user_id, p.user_id, p.version,
              c.id, c.team_id, c.name, c.realm, c.class, c.main_spec, c.off_spec, c.is_main, c.core_rank AS character_core_rank, c.left_on AS character_left_on,
              c.left_reason AS character_left_reason, c.trial_start AS character_trial_start, c.trial_end AS character_trial_end,
              t.name AS team_name, t.archived AS team_archived
         FROM players p JOIN characters c ON c.player_id = p.id LEFT JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
        WHERE p.guild_id = ?1 AND p.id IN (${inactive ? INACTIVE_MEMBERS_SQL : ROSTER_MEMBERS_SQL}) AND ${visibleCharacterSql('c')}`;
  const [rowResult, userResult] = await db.batch([
    db.prepare(rowsSql).bind(guildId, team.id),
    // Signed in = the person's account (linked by an officer, or matching the Discord ID they carry) is a member of this guild.
    db.prepare(
      `SELECT p.id AS player_id FROM players p JOIN users u ON (u.id = p.user_id OR (p.discord_user_id IS NOT NULL AND u.discord_id = p.discord_user_id))
        WHERE p.guild_id = ? AND ${memberSql('u.id', 'p.guild_id', '?')}`,
    ).bind(guildId, guildContext.guild.discord_server_id),
  ]);
  const signedIn = new Set(userResult.results.map((row) => row.player_id));
  const byPlayer = new Map();
  for (const row of rowResult.results) {
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, { player: row, characters: [] });
    byPlayer.get(row.player_id).characters.push({ row, view: characterView(row) });
  }
  const people = [];
  for (const { player, characters } of byPlayer.values()) {
    const main = characters.find((entry) => entry.row.is_main === 1);
    if (!main) continue;
    const onTeam = characters.filter((entry) => entry.row.team_id === team.id && (inactive || isOnRoster(entry.row)));
    if (!onTeam.length) continue;
    // The person's status and dates come from ALL their characters (the main's rank), not from the one that put them on this list.
    const fields = personColumnsOf(characters.map((entry) => characterOfRow({
      id: entry.row.id, team_id: entry.row.team_id, is_main: entry.row.is_main, core_rank: entry.row.character_core_rank, left_on: entry.row.character_left_on,
      left_reason: entry.row.character_left_reason, trial_start: entry.row.character_trial_start, trial_end: entry.row.character_trial_end,
    })));
    const shownEntry = onTeam.find((entry) => entry.row.is_main === 1) || onTeam.sort((a, b) => byName(a.view, b.view))[0];
    const shown = shownEntry.view;
    people.push({
      id: player.player_id,
      status: fields.status,
      joinedOn: player.joined_on,
      trialStart: fields.trial_start,
      trialEnd: fields.trial_end,
      leftOn: fields.left_on,
      leftReason: fields.left_reason,
      trialFlag: trialFlag(fields.status, fields.trial_end, today),
      version: player.version,
      raidRole: shown.mainSpec ? raidRoleOf(shown.class, shown.mainSpec) : null,
      shown: { id: shown.id, name: shown.name, class: shown.class, mainSpec: shown.mainSpec, offSpec: shown.offSpec, role: shown.role, isMain: shown.isMain },
      main: { id: main.view.id, name: main.view.name, class: main.view.class, team: { id: main.view.team.id, name: main.view.team.name } },
      names: onTeam.map((entry) => entry.view.name).sort((a, b) => a.localeCompare(b)),
      altCount: characters.length - 1,
      signIn: signedIn.has(player.player_id) ? 'signed_in' : (player.discord_user_id || player.user_id ? 'not_yet' : 'no_discord'),
      isMe: isOwnPlayer(player, viewer),
    });
  }
  people.sort((a, b) => a.shown.name.localeCompare(b.shown.name) || a.id.localeCompare(b.id));
  return people;
}
