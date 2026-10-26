// The roster: the list for a team, the person record, people and their characters, and the linkable members.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId, newId } from '../ids.js';
import { memberCandidatesSql, memberSql } from '../membership.js';
import { allows, isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { toPerson } from '../person.js';
import { RANK_COLUMNS_SQL, characterRankColumns, rankBinds, setCharacterRanksStatement, trialDatesFollowMainStatements } from '../person-legacy.js';
import {
  CLASS_IDS, CREATE_STATUSES, LEFT_REASONS, allowsSurname, MULTI_LINE_STRIP, SINGLE_LINE_STRIP, STATUSES, cleanCharacterName, isRealDate, isSpecOf, nameKey, realmKey,
} from '../roster-data.js';
import { LIMITS } from '../limits.js';
import { findRealm } from '../realms.js';
import { linkSignupsStatement, markPersonRaidsStale, markRaidsStale } from '../attendance-store.js';
import {
  canSeeAvatars, guildToday, homeTeamOf, loadPersonData, loadRosterFlags, loadRosterRows, personRecordFor, personReply, viewerOf,
} from '../roster-view.js';

const MAX_NOTES = 4000;
// An audit row guard for the statement right before it in the same batch: true only if that write changed one row.
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };

export const bad = (message, field, extra = {}) => new HttpError(400, 'bad_request', message, { field, ...extra });
const notFound = (message = 'That person was not found.') => new HttpError(404, 'not_found', message);
const forbidden = (extra = {}) => new HttpError(403, 'forbidden', 'You do not have permission to do that.', extra);

// ---------------------------------------------------------------------------
// Shared helpers (also used by roster-import.js)

export function errorText(error) {
  return [error && error.message, error && error.cause && error.cause.message]
    .filter((part) => part !== undefined && part !== null).map(String).join(' ');
}

// Which constraint a failed write hit: the cap triggers, or a unique index (D1 names the columns, not the index).
export function constraintOf(error) {
  const text = errorText(error);
  if (/person_limit/.test(text)) return 'person_limit';
  if (/character_limit/.test(text)) return 'character_limit';
  if (/guild_characters_cap/.test(text)) return 'guild_characters_cap';
  if (/UNIQUE constraint failed/i.test(text)) {
    if (/characters\.name_key|characters_guild_name/.test(text)) return 'character_name';
    if (/players\.discord_user_id|players_guild_discord/.test(text)) return 'discord';
    if (/players\.user_id|players_guild_user/.test(text)) return 'account';
    if (/characters\.blizzard_char_id|characters_identity/.test(text)) return 'identity_taken';
    if (/characters\.team_id, characters\.player_id|characters_team_person/.test(text)) return 'team_taken';
    if (/characters\.player_id|characters_one_main/.test(text)) return 'one_main';
  }
  if (/FOREIGN KEY constraint failed/i.test(text)) return 'foreign_key';
  return null;
}

// The cap triggers constraintOf names: people per guild, characters per person, characters per guild (worker/limits.js).
export const LIMIT_KINDS = ['person_limit', 'character_limit', 'guild_characters_cap'];

export function limitError(kind) {
  if (kind === 'person_limit') return new HttpError(409, 'person_limit', `A guild can have at most ${LIMITS.people} people.`);
  if (kind === 'guild_characters_cap') return new HttpError(409, 'guild_character_limit', `A guild can have at most ${LIMITS.characters} characters.`);
  return new HttpError(409, 'character_limit', `A person can have at most ${LIMITS.charactersPerPerson} characters.`);
}

export function requireEdit(guildContext, teamId, extra = {}) {
  if (!allows(guildContext.can, 'roster.edit', teamId)) throw forbidden(extra);
}

// A target team (create, import, add, move-to) must be active and in this guild.
export async function requireTarget(db, guildId, teamId, field = 'teamId') {
  if (!isId('t', teamId)) throw bad('Pick a team.', field);
  const team = await db.prepare('SELECT id, name, archived, trial_days FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw bad('That team does not exist in this guild.', field);
  if (team.archived === 1) throw bad('That team is archived.', field);
  return team;
}

// gameVersion: the guild's version; a Forever guild takes a first name and a surname ("Thrall Stormrage").
export function readName(raw, field = 'name', extra = {}, gameVersion = undefined) {
  const name = cleanCharacterName(raw, gameVersion);
  if (!name) throw bad(allowsSurname(gameVersion) ? 'A character name is 2 to 12 letters, or a first name and a surname of 2 to 12 letters each.' : 'A character name is 2 to 12 letters.', field, extra);
  return name;
}

export function readClass(raw, field = 'class', extra = {}) {
  if (typeof raw !== 'string' || !CLASS_IDS.includes(raw)) throw bad('Pick a class.', field, extra);
  return raw;
}

// undefined / null -> null; otherwise a spec label of the class.
export function readSpec(raw, classId, field) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !isSpecOf(classId, raw)) throw bad('That spec does not belong to the class.', field);
  return raw;
}

export function readSpecs(mainRaw, offRaw, classId) {
  const mainSpec = readSpec(mainRaw, classId, 'mainSpec');
  const offSpec = readSpec(offRaw, classId, 'offSpec');
  if (offSpec !== null && offSpec === mainSpec) throw bad('The off spec must differ from the main spec.', 'offSpec');
  return { mainSpec, offSpec };
}

// What a new character's realm columns hold for this guild.
export function realmColumns(guild, realmText = null) {
  if (guild.realm_kind === 'ruleset') return { realm: null, key: '' };
  const realm = realmText || guild.realm;
  return { realm, key: realmKey(realm) };
}

// The realm columns for a realm typed in a request, or null when it is not acceptable. A ruleset guild has no
// realm (NULL, key ''). A realm guild accepts its own realm (any spelling with the same key) or a realm of its
// game version and region (case-insensitive), and stores the canonical name. Control and bidi characters are
// stripped first; a realm whose key is empty is refused.
export function resolveRealm(guild, rawRealm) {
  if (guild.realm_kind === 'ruleset') return { realm: null, key: '' };
  if (rawRealm === undefined || rawRealm === null) return { realm: guild.realm, key: realmKey(guild.realm) };
  if (typeof rawRealm !== 'string') return null;
  const text = rawRealm.replace(SINGLE_LINE_STRIP, '').trim();
  if (!text || Array.from(text).length > 40) return null;
  const key = realmKey(text);
  if (!key) return null;
  const guildKey = realmKey(guild.realm);
  if (guildKey && key === guildKey) return { realm: guild.realm, key: guildKey };
  const listed = findRealm(guild.game_version, guild.region, text);
  if (!listed) return null;
  const listedKey = realmKey(listed.name);
  return listedKey ? { realm: listed.name, key: listedKey } : null;
}

export async function findNameOwner(db, guildId, key, realmKeyValue) {
  const row = await db.prepare(
    `SELECT c.id AS character_id, c.player_id,
            (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name
       FROM characters c WHERE c.guild_id = ? AND c.name_key = ? AND c.realm_key = ?`,
  ).bind(guildId, key, realmKeyValue).first();
  return row ? { characterId: row.character_id, personId: row.player_id, name: row.main_name } : null;
}

export function nameTaken(name, owner, extra = {}) {
  return new HttpError(409, 'name_taken', `${name} is already on the roster.`,
    { field: 'name', owner: owner ? { personId: owner.personId, name: owner.name } : null, ...extra });
}

// -> { id, discord_id } of a member with a Discord account that the officer may link to a person (the person takes its Discord ID).
// 409 already_linked when that member already belongs to another person of the guild, by Discord ID or by an officer's account link.
export async function resolveLinkUser(db, guildContext, userId, exceptPlayerId = null, personAccountId = null) {
  if (!isId('u', userId)) throw bad('Pick a member to link.', 'linkUserId');
  const guildId = guildContext.guild.id;
  const user = await db.prepare(
    `SELECT u.id, u.discord_id FROM users u, (SELECT ? AS gid, ? AS sid) gc
      WHERE u.id = ? AND u.discord_id IS NOT NULL AND ${memberSql('u.id', 'gc.gid', 'gc.sid')}`,
  ).bind(guildId, guildContext.guild.discord_server_id, userId).first();
  if (!user) throw bad('That member is not in this guild\'s Discord server.', 'linkUserId');
  // A person an officer linked to one account is not also another account's through its Discord ID.
  if (personAccountId && personAccountId !== user.id) {
    throw new HttpError(409, 'already_linked', 'That person is linked to a different Raidsmith account. Unlink it first.', { field: 'linkUserId' });
  }
  const other = await db.prepare(
    'SELECT id FROM players WHERE guild_id = ? AND id != ? AND (discord_user_id = ? OR user_id = ?)',
  ).bind(guildId, exceptPlayerId || '', user.discord_id, user.id).first();
  if (other) throw new HttpError(409, 'already_linked', 'That member is already linked to another person.', { field: 'linkUserId' });
  return user;
}

// The rank columns come from row.rank for the first character of a new person (characterRankColumns of the status it starts with) and from the person's
// main for every later one (worker/person-legacy.js RANK_COLUMNS_SQL, in the same statement). row.teamId may be null: the character sits on no team.
export function insertCharacter(db, guildId, row, now) {
  return db.prepare(
    `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at,
                             core_rank, left_on, left_reason, trial_start, trial_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${RANK_COLUMNS_SQL})`,
  ).bind(row.id, guildId, row.playerId, row.teamId || null, row.name, nameKey(row.name), row.realm, row.realmKey,
    row.class, row.mainSpec, row.offSpec, row.isMain ? 1 : 0, now, now, ...rankBinds(row.rank, row.playerId));
}

// The two statements that move the Main (spec: "The Main invariant").
// homeTeamId / targetTeamId repeat the authorization inside the writes: the old Main must still be on the home
// team and the new Main still on the team the caller was authorized against. Either may be null (a character on no team): `IS ?` matches NULL, `= ?` never does.
export function makeMainStatements(db, playerId, characterId, now, { homeTeamId, targetTeamId }) {
  return [
    db.prepare(
      `UPDATE characters SET is_main = 0, updated_at = ? WHERE player_id = ? AND is_main = 1 AND team_id IS ?
         AND EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id IS ?)`,
    ).bind(now, playerId, homeTeamId, characterId, playerId, targetTeamId),
    db.prepare(
      `UPDATE characters SET is_main = 1, updated_at = ? WHERE id = ? AND player_id = ? AND team_id IS ?
         AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND is_main = 1)`,
    ).bind(now, characterId, playerId, targetTeamId, playerId),
  ];
}

// The team a write on this character is authorized against: its own, else the home team of its person (an alt on no team is edited by whoever edits the person).
const editTeamOf = (row, home) => (row.team_id !== null && row.team_id !== undefined ? row.team_id : home.id);

// Person writes below repeat the authorization inside the statement (SQL is written out, never interpolated):
// "AND EXISTS (... is_main = 1 AND team_id IS ?)" = the Main is still on the home team the caller was authorized against (NULL for a Main on no team).

function audit(ctx, guildContext, action, entityType, entityId, before, after, guard = null) {
  return auditStatement(ctx, {
    guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType, entityId, before, after,
  }, guard);
}

async function conflict(ctx, guildContext, personId, message, pick = (record) => record) {
  const record = await personRecordFor(ctx, guildContext, personId);
  if (!record) throw notFound();
  throw new HttpError(409, 'conflict', message, { current: pick(record) });
}

// One character per person per team (unique index characters_team_person, migration 0032; the writers below check first, the index is the backstop).
const teamTaken = () => new HttpError(409, 'team_taken', 'That person already has a character on that team.', { field: 'teamId' });

function mapCreateError(error) {
  const kind = constraintOf(error);
  if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
  if (kind === 'team_taken') throw teamTaken();
  if (kind === 'discord' || kind === 'account') throw new HttpError(409, 'already_linked', 'That member is already linked to another person.', { field: 'linkUserId' });
  if (kind === 'foreign_key') throw notFound('That person or team no longer exists.');
  throw error;
}

async function nameConflict(ctx, guildContext, name, realm) {
  const owner = await findNameOwner(ctx.db, guildContext.guild.id, nameKey(name), realm.key);
  throw nameTaken(name, owner);
}

// ---------------------------------------------------------------------------
// Reads

export async function getRoster(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'roster.view');
  const query = new URL(ctx.request.url).searchParams;
  const teamId = query.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  // ?status=inactive is the Roster page's Inactive filter: the team's placed Social / Former people, for whoever may view the roster, exactly as before the
  // default list left them out. RETIRED when the Users page ships (R4, lane B8a); see loadRosterRows.
  const status = query.get('status');
  if (status !== null && status !== 'inactive') throw bad('The only filter is inactive.', 'status');
  const team = await ctx.db.prepare('SELECT id, name, archived, trial_days FROM teams WHERE id = ? AND guild_id = ?')
    .bind(teamId, guildContext.guild.id).first();
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  const today = guildToday(guildContext.guild, ctx.now());
  const people = await loadRosterRows(ctx.db, guildContext, team, today, viewerOf(ctx), { inactive: status === 'inactive' });
  return jsonResponse({
    team: { id: team.id, name: team.name, archived: team.archived === 1, trialDays: team.trial_days },
    today,
    can: { edit: allows(guildContext.can, 'roster.edit', team.id) },
    ...(status === 'inactive' ? { filter: 'inactive' } : {}),
    people,
  });
}

export async function getLinkable(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw forbidden();
  // Members with a Discord account who belong to no person of this guild yet (neither by Discord ID nor by an officer's account link).
  const guildId = guildContext.guild.id;
  const serverId = guildContext.guild.discord_server_id;
  const result = await ctx.db.prepare(
    `SELECT u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar FROM users u, (SELECT ? AS gid, ? AS sid) gc
      WHERE u.id IN (${memberCandidatesSql('gc.gid', 'gc.sid')}) AND u.discord_id IS NOT NULL AND ${memberSql('u.id', 'gc.gid', 'gc.sid')}
        AND NOT EXISTS (SELECT 1 FROM players p WHERE p.guild_id = gc.gid AND (p.discord_user_id = u.discord_id OR p.user_id = u.id))
      ORDER BY u.username, u.id LIMIT 1000`,
  ).bind(guildId, serverId).all();
  const showAvatar = canSeeAvatars(guildContext.can);
  return jsonResponse({ users: result.results.map((row) => toPerson(row, { avatar: showAvatar })) });
}

export async function getPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'roster.view');
  const record = await personRecordFor(ctx, guildContext, ctx.params.pid);
  if (!record) throw notFound();
  return jsonResponse(record);
}

// ---------------------------------------------------------------------------
// People

async function readFromSignup(db, guildContext, value, link) {
  if (value === undefined || value === null) return null;
  const guildId = guildContext.guild.id;
  if (typeof value !== 'object' || !isId('r', value.raidId) || !Number.isInteger(value.signupId)) throw bad('Pick a sign-up to link.', 'fromSignup');
  const row = await db.prepare(
    `SELECT s.discord_user_id, r.team_id FROM raid_signups s JOIN raids r ON r.id = s.raid_id AND r.guild_id = s.guild_id
      WHERE s.guild_id = ? AND s.raid_id = ? AND s.source = 'raid_helper' AND s.signup_id = ? AND s.player_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM raid_signups n WHERE n.raid_id = s.raid_id AND n.rh_signup_id = s.signup_id)`,
  ).bind(guildId, value.raidId, value.signupId).first();
  if (!row) throw new HttpError(409, 'already_linked', 'That sign-up is already linked to a person.', { field: 'fromSignup' });
  requireEdit(guildContext, row.team_id);
  const discordId = row.discord_user_id || null;
  if (discordId && !link) {
    const owner = await db.prepare('SELECT id FROM players WHERE guild_id = ? AND discord_user_id = ?').bind(guildId, discordId).first();
    if (owner) throw new HttpError(409, 'already_linked', 'Another person already has this Discord account.', { field: 'fromSignup' });
  }
  return { raidId: value.raidId, signupId: value.signupId, discordId: link && link.discord_id !== discordId ? null : discordId };
}

export async function createPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  // No teamId = a person whose main sits on no team (D1: an officer may do that; roster.edit for the whole guild is what allows(…, null) asks).
  const team = body.teamId === undefined || body.teamId === null ? null : await requireTarget(db, guild.id, body.teamId);
  requireEdit(guildContext, team ? team.id : null);
  const name = readName(body.name, 'name', {}, guild.game_version);
  const classId = readClass(body.class);
  const { mainSpec, offSpec } = readSpecs(body.mainSpec, body.offSpec, classId);
  const status = body.status === undefined ? 'raider' : body.status;
  if (!CREATE_STATUSES.includes(status)) throw bad('Pick raider, trial or reserve.', 'status');
  const today = guildToday(guild, ctx.now());
  const joinedOn = body.joinedOn === undefined || body.joinedOn === null ? today : body.joinedOn;
  if (!isRealDate(joinedOn)) throw bad('Joined needs a date.', 'joinedOn');
  let trialStart = null;
  let trialEnd = null;
  if (status === 'trial') {
    trialStart = joinedOn;
    if (body.trialEnd !== undefined && body.trialEnd !== null) {
      if (!isRealDate(body.trialEnd) || body.trialEnd < trialStart) throw bad('The trial end needs a date on or after the trial start.', 'trialEnd');
      trialEnd = body.trialEnd;
    }
  }
  const link = body.linkUserId === undefined || body.linkUserId === null ? null : await resolveLinkUser(db, guildContext, body.linkUserId);
  // A person made from a Raid-Helper sign-up nobody is linked to ({ raidId, signupId }) takes that sign-up's Discord ID, and the sign-ups with it follow.
  const fromSignup = await readFromSignup(db, guildContext, body.fromSignup, link);
  const realm = realmColumns(guild);
  const owner = await findNameOwner(db, guild.id, nameKey(name), realm.key);
  if (owner) throw nameTaken(name, owner);

  const now = ctx.now();
  const playerId = newId('p', ctx.randomBytes);
  const characterId = newId('c', ctx.randomBytes);
  try {
    await db.batch([
      // The players row (its status and dates are the mirror of the main's rank, worker/person-legacy.js) has to exist before its first character does.
      db.prepare(
        `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, discord_user_id, version, notes_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      ).bind(playerId, guild.id, status, joinedOn, trialStart, trialEnd, link ? link.discord_id : (fromSignup ? fromSignup.discordId : null), ctx.session.user.id, now, now),
      insertCharacter(db, guild.id, {
        id: characterId, playerId, teamId: team ? team.id : null, name, realm: realm.realm, realmKey: realm.key, class: classId, mainSpec, offSpec, isMain: true,
        rank: characterRankColumns({ status, trialStart, trialEnd }),
      }, now),
      audit(ctx, guildContext, 'person.create', 'person', playerId, null, {
        status, joinedOn, trialStart, trialEnd, version: 1, linked: !!link, characterId, teamId: team ? team.id : null, class: classId, mainSpec, offSpec,
      }),
      // Raids whose logs name this character show "Recalculate".
      markRaidsStale(db, guild.id, [nameKey(name)], null, team ? [team.id] : []),
      ...(fromSignup ? [linkSignupsStatement(db, guild.id, playerId, fromSignup.discordId, fromSignup.raidId, fromSignup.signupId), markPersonRaidsStale(db, guild.id, playerId)] : []),
    ]);
  } catch (error) {
    if (constraintOf(error) === 'character_name') await nameConflict(ctx, guildContext, name, realm);
    mapCreateError(error);
  }
  return jsonResponse(await personReply(ctx, guildContext, playerId), 201);
}

async function loadEditable(ctx, guildContext) {
  const data = await loadPersonData(ctx.db, guildContext.guild.id, ctx.params.pid);
  if (!data) throw notFound();
  const home = homeTeamOf(data);
  if (!home) throw notFound();
  return { data, home };
}

function readDateField(body, key, field = key) {
  if (body[key] === undefined) return undefined;
  if (body[key] === null) return null;
  if (!isRealDate(body[key])) throw bad('That needs a date.', field);
  return body[key];
}

export async function patchPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  requireEdit(guildContext, home.id);
  const { player } = data;
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) throw bad('Send the version you last saw.', 'expectedVersion');
  if (body.expectedVersion !== player.version) {
    return conflict(ctx, guildContext, player.id, 'Someone else changed this person. The page now shows their version.');
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) throw bad('Pick a status.', 'status');
  const joinedOn = readDateField(body, 'joinedOn');
  const trialStart = readDateField(body, 'trialStart');
  const trialEnd = readDateField(body, 'trialEnd');
  const leftOn = readDateField(body, 'leftOn');
  // No reason is null or an empty string (a cleared select); a sent reason is Left guild or Kicked.
  const leftReason = body.leftReason === '' ? null : body.leftReason;
  if (leftReason !== undefined && leftReason !== null && !LEFT_REASONS.includes(leftReason)) throw bad('Pick Left guild or Kicked.', 'leftReason');
  let link;
  if (body.linkUserId !== undefined && body.linkUserId !== null) link = await resolveLinkUser(db, guildContext, body.linkUserId, player.id, player.user_id);
  const keys = ['status', 'joinedOn', 'trialStart', 'trialEnd', 'linkUserId', 'leftOn', 'leftReason'];
  if (!keys.some((key) => body[key] !== undefined)) throw bad('Send a field to change.', 'status');

  const next = {
    status: body.status === undefined ? player.status : body.status,
    joinedOn: joinedOn === undefined ? player.joined_on : joinedOn,
    trialStart: trialStart === undefined ? player.trial_start : trialStart,
    trialEnd: trialEnd === undefined ? player.trial_end : trialEnd,
    leftOn: null,
    leftReason: null,
    discordUserId: player.discord_user_id,
    nickname: player.discord_nickname,
  };
  // Left on / reason belong to Inactive only: set on the way in (left on defaults to today), kept while inactive, cleared on the way out.
  if (next.status !== 'inactive') {
    if (leftOn !== undefined && leftOn !== null) throw bad('Left on only applies to an inactive person.', 'leftOn');
    if (leftReason !== undefined && leftReason !== null) throw bad('A reason only applies to an inactive person.', 'leftReason');
  } else if (player.status !== 'inactive') {
    next.leftOn = leftOn === undefined ? guildToday(guildContext.guild, ctx.now()) : leftOn;
    next.leftReason = leftReason === undefined ? null : leftReason;
  } else {
    next.leftOn = leftOn === undefined ? player.left_on : leftOn;
    next.leftReason = leftReason === undefined ? player.left_reason : leftReason;
    // A break keeps no left date on the characters: switching it to Left or Kicked without a date starts today, as entering Inactive does.
    if (leftOn === undefined && !next.leftOn && (next.leftReason === 'left' || next.leftReason === 'kicked')) next.leftOn = guildToday(guildContext.guild, ctx.now());
  }
  if (next.trialStart && next.trialEnd && next.trialEnd < next.trialStart) {
    throw bad('The trial end must be on or after the trial start.', 'trialEnd');
  }
  if (body.linkUserId === null) {
    next.discordUserId = null;
  } else if (link) {
    next.discordUserId = link.discord_id;
  }
  if (next.discordUserId !== player.discord_user_id) next.nickname = null;

  const changed = [];
  if (next.status !== player.status) changed.push('status');
  if (next.joinedOn !== player.joined_on) changed.push('joinedOn');
  if (next.trialStart !== player.trial_start) changed.push('trialStart');
  if (next.trialEnd !== player.trial_end) changed.push('trialEnd');
  if (next.leftOn !== player.left_on) changed.push('leftOn');
  if (next.leftReason !== player.left_reason) changed.push('leftReason');
  if (next.discordUserId !== player.discord_user_id) changed.push('link');
  if (changed.length) {
    const now = ctx.now();
    const snapshot = (state) => ({
      status: state.status, joinedOn: state.joinedOn, trialStart: state.trialStart, trialEnd: state.trialEnd,
      leftOn: state.leftOn, leftReason: state.leftReason, linked: !!state.discordUserId,
    });
    const before = snapshot({
      status: player.status, joinedOn: player.joined_on, trialStart: player.trial_start, trialEnd: player.trial_end,
      leftOn: player.left_on, leftReason: player.left_reason, discordUserId: player.discord_user_id,
    });
    // The interim status contract (user-hierarchy build): a change of status, trial dates or left date writes the person's rank on EVERY character first
    // (Inactive = Social; the dates by migration 0030's mapping), and the players row follows as the mirror a rollback to R1 reads. Both statements carry
    // the same optimistic checks (version, the main still on the home team), so a lost race changes neither. The mirror writes a field only when that field
    // changed: `next` comes from the characters, which cannot carry what an old players row holds (a Break, a left date without Left or Kicked, trial dates
    // on a person who is not on trial), so an unrelated PATCH must not wipe it. The UPDATE keeps the stored value itself (no read of the legacy column).
    const mirrored = (key, value) => [changed.includes(key) ? 1 : 0, value];
    const statements = [];
    if (changed.some((key) => ['status', 'trialStart', 'trialEnd', 'leftOn', 'leftReason'].includes(key))) {
      const unchanged = {
        sql: `EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND version = ?)
              AND EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND is_main = 1 AND team_id IS ?)`,
        params: [player.id, guildContext.guild.id, player.version, player.id, home.id],
      };
      statements.push(setCharacterRanksStatement(db, guildContext.guild.id, player.id, characterRankColumns(next), unchanged));
    }
    const playersAt = statements.length;
    statements.push(
      db.prepare(
        `UPDATE players SET status = CASE WHEN ? THEN ? ELSE status END, joined_on = ?,
                trial_start = CASE WHEN ? THEN ? ELSE trial_start END, trial_end = CASE WHEN ? THEN ? ELSE trial_end END,
                left_on = CASE WHEN ? THEN ? ELSE left_on END, left_reason = CASE WHEN ? THEN ? ELSE left_reason END,
                discord_user_id = ?, discord_nickname = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND guild_id = ? AND version = ?
            AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)`,
      ).bind(...mirrored('status', next.status), next.joinedOn, ...mirrored('trialStart', next.trialStart), ...mirrored('trialEnd', next.trialEnd),
        ...mirrored('leftOn', next.leftOn), ...mirrored('leftReason', next.leftReason), next.discordUserId, next.nickname, now,
        player.id, guildContext.guild.id, player.version, home.id),
      audit(ctx, guildContext, 'person.update', 'person', player.id,
        { ...before, version: player.version },
        { ...snapshot(next), version: player.version + 1, changed },
        CHANGED_ONE),
      // Status, join and left dates and the Discord link decide who is expected and which sign-ups are theirs: their teams' raids need recalculating.
      ...(changed.some((key) => ['status', 'joinedOn', 'leftOn', 'link'].includes(key)) ? [markPersonRaidsStale(db, guildContext.guild.id, player.id)] : []),
    );
    let results;
    try {
      results = await db.batch(statements);
    } catch (error) {
      mapCreateError(error);
    }
    if (results[playersAt].meta.changes !== 1) {
      return conflict(ctx, guildContext, player.id, 'Someone else changed this person. The page now shows their version.');
    }
  }
  return jsonResponse(await personReply(ctx, guildContext, player.id));
}

function cleanNotes(raw) {
  if (typeof raw !== 'string') throw bad('Notes must be text.', 'text');
  const text = raw.replace(/\r\n?/g, '\n').replace(MULTI_LINE_STRIP, '').trimEnd();
  if (Array.from(text).length > MAX_NOTES) throw bad(`Notes can be at most ${MAX_NOTES} characters.`, 'text');
  return text;
}

export async function saveNotes(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  if (!allows(guildContext.can, 'roster.notes.edit', home.id)) throw forbidden();
  const { player } = data;
  const text = cleanNotes(body.text);
  if (!Number.isInteger(body.expectedNotesVersion) || body.expectedNotesVersion < 0) {
    throw bad('Send the notes version you last saw.', 'expectedNotesVersion');
  }
  const stale = () => conflict(ctx, guildContext, player.id, 'Someone else changed these notes. The page now shows their version.',
    (record) => ({ notes: record.notes }));
  if (body.expectedNotesVersion !== player.notes_version) return stale();
  const now = ctx.now();
  const results = await db.batch([
    db.prepare(
      `UPDATE players SET notes = ?, notes_updated_by = ?, notes_updated_at = ?, notes_version = notes_version + 1, updated_at = ?
        WHERE id = ? AND guild_id = ? AND notes_version = ?
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)`,
    ).bind(text || null, ctx.session.user.id, now, now, player.id, guildContext.guild.id, player.notes_version, home.id),
    audit(ctx, guildContext, 'person.notes', 'person', player.id, { notesVersion: player.notes_version },
      { notesVersion: player.notes_version + 1 },
      CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) return stale();
  const record = await personRecordFor(ctx, guildContext, player.id);
  return jsonResponse({ notes: record.notes, rosterFlags: await loadRosterFlags(db, guildContext, record.today) });
}

export async function deletePerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  const teamIds = [...new Set(data.characters.map((entry) => entry.view.team.id))];
  // A character on no team is covered by the person's home team (editTeamOf): whoever may edit the Main may delete its alts.
  for (const teamId of new Set(data.characters.map((entry) => editTeamOf(entry.row, home)))) requireEdit(guildContext, teamId);
  const { player } = data;
  // The write repeats the authorization: the Main is still on the home team (which may be none) and every character that sits on a team is still on a
  // team the caller was authorized against.
  const placedTeamIds = teamIds.filter((teamId) => teamId !== null);
  const stillAuthorized = `EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)
    AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND team_id IS NOT NULL AND team_id NOT IN (SELECT value FROM json_each(?)))`;
  const guardParams = [home.id, JSON.stringify(placedTeamIds)];
  const exists = {
    sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND ' + stillAuthorized + ')',
    params: [player.id, guildContext.guild.id, ...guardParams],
  };
  const results = await db.batch([
    audit(ctx, guildContext, 'person.delete', 'person', player.id,
      { status: player.status, version: player.version, teamIds, homeTeamId: home.id, characterCount: data.characters.length }, null, exists),
    db.prepare(
      `DELETE FROM players WHERE id = ? AND guild_id = ?
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)
          AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND team_id IS NOT NULL AND team_id NOT IN (SELECT value FROM json_each(?)))
        RETURNING id`,
    ).bind(player.id, guildContext.guild.id, ...guardParams),
    markRaidsStale(db, guildContext.guild.id, data.characters.map((entry) => nameKey(entry.row.name)), null, teamIds),
  ]);
  if (results[1].results.length !== 1) {
    return conflict(ctx, guildContext, player.id, 'Someone moved this person. The page now shows their current record.');
  }
  const today = guildToday(guildContext.guild, ctx.now());
  return jsonResponse({ deleted: true, rosterFlags: await loadRosterFlags(db, guildContext, today) });
}

// ---------------------------------------------------------------------------
// Characters

function findCharacter(data, characterId) {
  const entry = data.characters.find((candidate) => candidate.row.id === characterId);
  if (!entry) throw notFound('That character was not found.');
  return entry;
}

// A guarded character write changed nothing: 404 when the person or character is gone, else 409 with the current record.
async function characterMoved(ctx, guildContext, personId, characterId) {
  const reread = await loadPersonData(ctx.db, guildContext.guild.id, personId);
  if (!reread || !reread.characters.some((entry) => entry.row.id === characterId)) throw notFound('That character was not found.');
  return conflict(ctx, guildContext, personId, 'Someone moved this character. The page now shows the current record.');
}

// After a new character was inserted as an alt (on no team): the statements that make it the person's Main on `teamId` (null = no team). The Main swap comes
// first and everything after it only acts when the swap happened (the previous Main is an alt by then; the new character is the Main), so a lost race changes
// nothing. One character per person per team: the previous Main steps off the team when it sits there (an alt from now on, and alts start teamless); the caller
// has refused the request when another character holds the team. -> { statements, swapAt } (swapAt: the write whose changes() says the swap happened).
export function newMainStatements(db, { playerId, characterId, previousMain, teamId, now }) {
  const statements = makeMainStatements(db, playerId, characterId, now, { homeTeamId: previousMain.team_id, targetTeamId: null });
  const swapAt = statements.length - 1;
  if (teamId) {
    if (previousMain.team_id === teamId) {
      statements.push(db.prepare('UPDATE characters SET team_id = NULL, updated_at = ? WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id IS ?')
        .bind(now, previousMain.id, playerId, teamId));
    }
    statements.push(db.prepare('UPDATE characters SET team_id = ?, updated_at = ? WHERE id = ? AND player_id = ? AND is_main = 1 AND team_id IS NULL')
      .bind(teamId, now, characterId, playerId));
  }
  return { statements, swapAt };
}

// A new character joins a person. It starts on NO team (U R3-Q1/R4-Q1: new alts start teamless; placing it on a team is the team routes' job) whatever teamId
// says, except a new MAIN: it takes the team asked for (none = no team), and the previous Main, an alt from now on, steps off that team when it sits there.
// Another character on the asked-for team refuses the request (one character per person per team).
export async function addCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const { data, home } = await loadEditable(ctx, guildContext);
  requireEdit(guildContext, home.id);
  if (body.makeMain !== undefined && typeof body.makeMain !== 'boolean') throw bad('makeMain must be true or false.', 'makeMain');
  const makeMain = body.makeMain === true;
  // A teamId that is sent must name a team of this guild that takes people; only a new Main uses it.
  const asked = body.teamId === undefined || body.teamId === null ? null : await requireTarget(db, guild.id, body.teamId);
  const team = makeMain ? asked : null;
  if (team) requireEdit(guildContext, team.id);
  const name = readName(body.name, 'name', {}, guild.game_version);
  const classId = readClass(body.class);
  const { mainSpec, offSpec } = readSpecs(body.mainSpec, body.offSpec, classId);
  const realm = realmColumns(guild);
  const owner = await findNameOwner(db, guild.id, nameKey(name), realm.key);
  if (owner) throw nameTaken(name, owner);

  const now = ctx.now();
  const player = data.player;
  const characterId = newId('c', ctx.randomBytes);
  const previous = data.characters.find((entry) => entry.row.is_main === 1).row;
  if (team && data.characters.some((entry) => entry.row.team_id === team.id && entry.row.id !== previous.id)) throw teamTaken();
  const statements = [
    insertCharacter(db, guild.id, {
      id: characterId, playerId: player.id, teamId: null, name, realm: realm.realm, realmKey: realm.key, class: classId, mainSpec, offSpec, isMain: false,
    }, now),
    audit(ctx, guildContext, 'character.create', 'character', characterId, null,
      { personId: player.id, teamId: team ? team.id : null, class: classId, mainSpec, offSpec, makeMain }),
  ];
  let mainAt = -1;
  if (makeMain) {
    const main = newMainStatements(db, { playerId: player.id, characterId, previousMain: previous, teamId: team ? team.id : null, now });
    mainAt = statements.length + main.swapAt;
    statements.push(
      ...main.statements,
      audit(ctx, guildContext, 'character.main', 'character', characterId, { mainCharacterId: previous.id }, { mainCharacterId: characterId }),
      // The trial dates sit on the Main character: they move with it.
      ...trialDatesFollowMainStatements(db, previous.id, characterId),
    );
  }
  statements.push(markRaidsStale(db, guild.id, [nameKey(name)], null, team ? [team.id] : []));
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (constraintOf(error) === 'character_name') await nameConflict(ctx, guildContext, name, realm);
    mapCreateError(error);
  }
  if (makeMain && results[mainAt].meta.changes !== 1) throw new HttpError(409, 'conflict', 'The Main could not be changed. Reload and try again.');
  return jsonResponse(await personReply(ctx, guildContext, player.id), 201);
}

export async function patchCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const { data, home } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const current = entry.row;
  requireEdit(guildContext, editTeamOf(current, home));
  const keys = ['name', 'class', 'mainSpec', 'offSpec', 'teamId'];
  if (!keys.some((key) => body[key] !== undefined)) throw bad('Send a field to change.', 'name');

  const name = body.name === undefined ? current.name : readName(body.name, 'name', {}, guild.game_version);
  const classId = body.class === undefined ? current.class : readClass(body.class);
  // A character bound to its Battle.net identity keeps the name and class the game gives it (a paid rename arrives through the roster sync).
  if (current.blizzard_char_id !== null && current.blizzard_char_id !== undefined) {
    if (name !== current.name) throw bad('This character is linked to Battle.net: its name comes from the game and cannot be changed here.', 'name');
    if (classId !== current.class) throw bad('This character is linked to Battle.net: its class comes from the game and cannot be changed here.', 'class');
  }
  const specs = readSpecs(
    body.mainSpec === undefined ? current.main_spec : body.mainSpec,
    body.offSpec === undefined ? current.off_spec : body.offSpec,
    classId,
  );
  // A character on a team may move to another; a character on NO team is never placed here (placing is the team routes' job), so its teamId is left alone.
  let teamId = current.team_id;
  if (current.team_id !== null && body.teamId !== undefined && body.teamId !== current.team_id) {
    const team = await requireTarget(db, guild.id, body.teamId);
    requireEdit(guildContext, team.id);
    if (data.characters.some((other) => other.row.id !== current.id && other.row.team_id === team.id)) throw teamTaken();
    teamId = team.id;
  }
  if (name !== current.name) {
    const owner = await findNameOwner(db, guild.id, nameKey(name), realmColumns(guild, current.realm).key);
    if (owner && owner.characterId !== current.id) throw nameTaken(name, owner);
  }

  const changed = [];
  if (name !== current.name) changed.push('name');
  if (classId !== current.class) changed.push('class');
  if (specs.mainSpec !== current.main_spec) changed.push('mainSpec');
  if (specs.offSpec !== current.off_spec) changed.push('offSpec');
  if (teamId !== current.team_id) changed.push('teamId');
  if (changed.length) {
    const now = ctx.now();
    let results;
    try {
      results = await db.batch([
        db.prepare(
          `UPDATE characters SET name = ?, name_key = ?, class = ?, main_spec = ?, off_spec = ?, team_id = ?, updated_at = ?
            WHERE id = ? AND player_id = ? AND guild_id = ? AND team_id IS ?`,
        ).bind(name, nameKey(name), classId, specs.mainSpec, specs.offSpec, teamId, now, current.id, data.player.id, guild.id, current.team_id),
        audit(ctx, guildContext, 'character.update', 'character', current.id,
          { teamId: current.team_id, class: current.class, mainSpec: current.main_spec, offSpec: current.off_spec },
          { teamId, class: classId, mainSpec: specs.mainSpec, offSpec: specs.offSpec, changed },
          CHANGED_ONE),
        // A rename or a move changes which raids' results depend on this character.
        ...(changed.includes('name') || changed.includes('teamId')
          ? [markRaidsStale(db, guild.id, [nameKey(current.name), nameKey(name)], null, [current.team_id, teamId].filter(Boolean))] : []),
      ]);
    } catch (error) {
      if (constraintOf(error) === 'character_name') await nameConflict(ctx, guildContext, name, realmColumns(guild, current.realm));
      mapCreateError(error);
    }
    if (results[0].meta.changes !== 1) return characterMoved(ctx, guildContext, data.player.id, current.id);
  }
  return jsonResponse(await personReply(ctx, guildContext, data.player.id));
}

export async function makeMain(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const target = entry.row;
  requireEdit(guildContext, home.id);
  requireEdit(guildContext, editTeamOf(target, home));
  if (target.is_main === 1) return jsonResponse(await personReply(ctx, guildContext, data.player.id));
  const previous = data.characters.find((candidate) => candidate.row.is_main === 1).row;
  const now = ctx.now();
  const results = await db.batch([
    ...makeMainStatements(db, data.player.id, target.id, now, { homeTeamId: home.id, targetTeamId: target.team_id }),
    audit(ctx, guildContext, 'character.main', 'character', target.id, { mainCharacterId: previous.id }, { mainCharacterId: target.id },
      CHANGED_ONE),
    // The trial dates sit on the main character: they move with it.
    ...trialDatesFollowMainStatements(db, previous.id, target.id),
  ]);
  if (results[1].meta.changes !== 1) return characterMoved(ctx, guildContext, data.player.id, target.id);
  return jsonResponse(await personReply(ctx, guildContext, data.player.id));
}

export async function removeCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const target = entry.row;
  requireEdit(guildContext, editTeamOf(target, home));
  const removable = {
    sql: 'EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id IS ?)',
    params: [target.id, data.player.id, target.team_id],
  };
  const results = await db.batch([
    audit(ctx, guildContext, 'character.delete', 'character', target.id,
      { personId: data.player.id, teamId: target.team_id, class: target.class, mainSpec: target.main_spec, offSpec: target.off_spec }, null, removable),
    db.prepare('DELETE FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id IS ? RETURNING id')
      .bind(target.id, data.player.id, target.team_id),
    markRaidsStale(db, guildContext.guild.id, [nameKey(target.name)], null, target.team_id ? [target.team_id] : []),
  ]);
  if (results[1].results.length !== 1) {
    const reread = await loadPersonData(db, guildContext.guild.id, data.player.id);
    const again = reread && reread.characters.find((candidate) => candidate.row.id === target.id);
    if (again && again.row.is_main === 1) {
      throw new HttpError(409, 'main_character', 'Make another character the Main before removing this one.');
    }
    return characterMoved(ctx, guildContext, data.player.id, target.id);
  }
  return jsonResponse(await personReply(ctx, guildContext, data.player.id));
}
