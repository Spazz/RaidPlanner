// The one redaction-aware builder for roster responses: the person record, the roster rows, the 409 `current`,
// and the nav-badge counts. Every response that shows a person goes through here, so a member never gets a
// field an officer would (notes, nicknames, flags) by taking a different route.
import { isOwnPlayer, memberSql } from './membership.js';
import { allows, isGranted } from './permissions.js';
import { toPerson } from './person.js';
import { roleOf, todayIn, trialFlag } from './roster-data.js';

// Avatar URLs carry the user's Discord ID, so only the people who can open People and roles (where avatars are
// already shown) get them in roster responses; everyone else gets initials.
export function canSeeAvatars(can) {
  return allows(can, 'guild.access') || allows(can, 'guild.roles');
}

export function guildToday(guild, nowMs) {
  return todayIn(guild.time_zone, nowMs);
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

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
    db.prepare('SELECT * FROM players WHERE id = ? AND guild_id = ?').bind(personId, guildId),
    db.prepare(
      `SELECT c.id, c.team_id, c.name, c.realm, c.class, c.main_spec, c.off_spec, c.is_main,
              t.name AS team_name, t.archived AS team_archived
         FROM characters c JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
        WHERE c.player_id = ? AND c.guild_id = ?`,
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
  const teamIds = [...new Set(data.characters.map((entry) => entry.view.team.id))];
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
      homeTeam: home ? { id: home.id, name: home.name } : null,
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
    db.prepare(
      `SELECT m.team_id, p.status, p.trial_end FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ? AND p.status = 'trial' AND p.trial_end IS NOT NULL`,
    ).bind(guildId),
  ]);
  const flags = {};
  for (const team of teamResult.results) {
    if (allows(guildContext.can, 'roster.edit', team.id)) flags[team.id] = 0;
  }
  for (const row of trialResult.results) {
    if (flags[row.team_id] !== undefined && trialFlag(row.status, row.trial_end, today)) flags[row.team_id]++;
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

// GET /roster?team=: every person with a character on the team.
export async function loadRosterRows(db, guildContext, team, today, viewer) {
  const guildId = guildContext.guild.id;
  const [rowResult, userResult] = await db.batch([
    db.prepare(
      `SELECT p.id AS player_id, p.status, p.joined_on, p.trial_start, p.trial_end, p.left_on, p.left_reason, p.discord_user_id, p.user_id, p.version,
              c.id, c.team_id, c.name, c.realm, c.class, c.main_spec, c.off_spec, c.is_main,
              t.name AS team_name, t.archived AS team_archived
         FROM players p JOIN characters c ON c.player_id = p.id JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
        WHERE p.guild_id = ? AND p.id IN (SELECT player_id FROM characters WHERE team_id = ? AND guild_id = ?)`,
    ).bind(guildId, team.id, guildId),
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
    const onTeam = characters.filter((entry) => entry.row.team_id === team.id);
    const shownEntry = onTeam.find((entry) => entry.row.is_main === 1) || onTeam.sort((a, b) => byName(a.view, b.view))[0];
    const shown = shownEntry.view;
    people.push({
      id: player.player_id,
      status: player.status,
      joinedOn: player.joined_on,
      trialStart: player.trial_start,
      trialEnd: player.trial_end,
      leftOn: player.left_on,
      leftReason: player.left_reason,
      trialFlag: trialFlag(player.status, player.trial_end, today),
      version: player.version,
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
