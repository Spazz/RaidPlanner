// The roster: the list for a team, the person record, people and their characters, and the linkable members.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId, newId } from '../ids.js';
import { memberCandidatesSql, memberSql } from '../membership.js';
import { allows, isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { toPerson } from '../person.js';
import {
  CLASS_IDS, CREATE_STATUSES, LEFT_REASONS, MULTI_LINE_STRIP, SINGLE_LINE_STRIP, STATUSES, cleanCharacterName, isRealDate, isSpecOf, nameKey, realmKey,
} from '../roster-data.js';
import { LIMITS } from '../limits.js';
import { findRealm } from '../realms.js';
import { markPersonRaidsStale, markRaidsStale } from '../attendance-store.js';
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
  const team = await db.prepare('SELECT id, name, archived FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw bad('That team does not exist in this guild.', field);
  if (team.archived === 1) throw bad('That team is archived.', field);
  return team;
}

export function readName(raw, field = 'name', extra = {}) {
  const name = cleanCharacterName(raw);
  if (!name) throw bad('A character name is 2 to 12 letters.', field, extra);
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

export function insertCharacter(db, guildId, row, now) {
  return db.prepare(
    `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.id, guildId, row.playerId, row.teamId, row.name, nameKey(row.name), row.realm, row.realmKey,
    row.class, row.mainSpec, row.offSpec, row.isMain ? 1 : 0, now, now);
}

// The two statements that move the Main (spec: "The Main invariant").
// homeTeamId / targetTeamId repeat the authorization inside the writes: the old Main must still be on the home
// team and the new Main still on the team the caller was authorized against.
export function makeMainStatements(db, playerId, characterId, now, { homeTeamId, targetTeamId }) {
  return [
    db.prepare(
      `UPDATE characters SET is_main = 0, updated_at = ? WHERE player_id = ? AND is_main = 1 AND team_id = ?
         AND EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id = ?)`,
    ).bind(now, playerId, homeTeamId, characterId, playerId, targetTeamId),
    db.prepare(
      `UPDATE characters SET is_main = 1, updated_at = ? WHERE id = ? AND player_id = ? AND team_id = ?
         AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND is_main = 1)`,
    ).bind(now, characterId, playerId, targetTeamId, playerId),
  ];
}

// Person writes below repeat the authorization inside the statement (SQL is written out, never interpolated):
// "AND EXISTS (... is_main = 1 AND team_id = ?)" = the Main is still on the home team the caller was authorized against.

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

function mapCreateError(error) {
  const kind = constraintOf(error);
  if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'roster.view');
  const teamId = new URL(ctx.request.url).searchParams.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const team = await ctx.db.prepare('SELECT id, name, archived FROM teams WHERE id = ? AND guild_id = ?')
    .bind(teamId, guildContext.guild.id).first();
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  const today = guildToday(guildContext.guild, ctx.now());
  const people = await loadRosterRows(ctx.db, guildContext, team, today, viewerOf(ctx));
  return jsonResponse({
    team: { id: team.id, name: team.name, archived: team.archived === 1 },
    today,
    can: { edit: allows(guildContext.can, 'roster.edit', team.id) },
    people,
  });
}

export async function getLinkable(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'roster.view');
  const record = await personRecordFor(ctx, guildContext, ctx.params.pid);
  if (!record) throw notFound();
  return jsonResponse(record);
}

// ---------------------------------------------------------------------------
// People

export async function createPerson(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const team = await requireTarget(db, guild.id, body.teamId);
  requireEdit(guildContext, team.id);
  const name = readName(body.name);
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
  const realm = realmColumns(guild);
  const owner = await findNameOwner(db, guild.id, nameKey(name), realm.key);
  if (owner) throw nameTaken(name, owner);

  const now = ctx.now();
  const playerId = newId('p', ctx.randomBytes);
  const characterId = newId('c', ctx.randomBytes);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, discord_user_id, version, notes_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      ).bind(playerId, guild.id, status, joinedOn, trialStart, trialEnd, link ? link.discord_id : null, ctx.session.user.id, now, now),
      insertCharacter(db, guild.id, {
        id: characterId, playerId, teamId: team.id, name, realm: realm.realm, realmKey: realm.key, class: classId, mainSpec, offSpec, isMain: true,
      }, now),
      audit(ctx, guildContext, 'person.create', 'person', playerId, null, {
        status, joinedOn, trialStart, trialEnd, version: 1, linked: !!link, characterId, teamId: team.id, class: classId, mainSpec, offSpec,
      }),
      // Raids whose logs name this character show "Recalculate".
      markRaidsStale(db, guild.id, [nameKey(name)], null, [team.id]),
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
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
  if (body.leftReason !== undefined && body.leftReason !== null && !LEFT_REASONS.includes(body.leftReason)) throw bad('Pick a reason.', 'leftReason');
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
    if (body.leftReason !== undefined && body.leftReason !== null) throw bad('A reason only applies to an inactive person.', 'leftReason');
  } else if (player.status !== 'inactive') {
    next.leftOn = leftOn === undefined ? guildToday(guildContext.guild, ctx.now()) : leftOn;
    next.leftReason = body.leftReason === undefined ? null : body.leftReason;
  } else {
    next.leftOn = leftOn === undefined ? player.left_on : leftOn;
    next.leftReason = body.leftReason === undefined ? player.left_reason : body.leftReason;
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
    let results;
    try {
      results = await db.batch([
        db.prepare(
          `UPDATE players SET status = ?, joined_on = ?, trial_start = ?, trial_end = ?, left_on = ?, left_reason = ?, discord_user_id = ?, discord_nickname = ?,
                  version = version + 1, updated_at = ?
            WHERE id = ? AND guild_id = ? AND version = ?
              AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id = ?)`,
        ).bind(next.status, next.joinedOn, next.trialStart, next.trialEnd, next.leftOn, next.leftReason, next.discordUserId, next.nickname, now,
          player.id, guildContext.guild.id, player.version, home.id),
        audit(ctx, guildContext, 'person.update', 'person', player.id,
          { ...before, version: player.version },
          { ...snapshot(next), version: player.version + 1, changed },
          CHANGED_ONE),
        // Status, join and left dates and the Discord link decide who is expected and which sign-ups are theirs: their teams' raids need recalculating.
        ...(changed.some((key) => ['status', 'joinedOn', 'leftOn', 'link'].includes(key)) ? [markPersonRaidsStale(db, guildContext.guild.id, player.id)] : []),
      ]);
    } catch (error) {
      mapCreateError(error);
    }
    if (results[0].meta.changes !== 1) {
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
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
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id = ?)`,
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  const teamIds = [...new Set(data.characters.map((entry) => entry.view.team.id))];
  for (const teamId of teamIds) requireEdit(guildContext, teamId);
  const { player } = data;
  // The write repeats the authorization: the Main is still on the home team and every character is still on a team
  // the caller was authorized against.
  const stillAuthorized = 'EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id = ?) AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND team_id NOT IN (SELECT value FROM json_each(?)))';
  const guardParams = [home.id, JSON.stringify(teamIds)];
  const exists = {
    sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND ' + stillAuthorized + ')',
    params: [player.id, guildContext.guild.id, ...guardParams],
  };
  const results = await db.batch([
    audit(ctx, guildContext, 'person.delete', 'person', player.id,
      { status: player.status, version: player.version, teamIds, homeTeamId: home.id, characterCount: data.characters.length }, null, exists),
    db.prepare(
      `DELETE FROM players WHERE id = ? AND guild_id = ?
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id = ?)
          AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND team_id NOT IN (SELECT value FROM json_each(?)))
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

export async function addCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const { data, home } = await loadEditable(ctx, guildContext);
  const team = await requireTarget(db, guild.id, body.teamId);
  requireEdit(guildContext, team.id);
  requireEdit(guildContext, home.id);
  const name = readName(body.name);
  const classId = readClass(body.class);
  const { mainSpec, offSpec } = readSpecs(body.mainSpec, body.offSpec, classId);
  if (body.makeMain !== undefined && typeof body.makeMain !== 'boolean') throw bad('makeMain must be true or false.', 'makeMain');
  const realm = realmColumns(guild);
  const owner = await findNameOwner(db, guild.id, nameKey(name), realm.key);
  if (owner) throw nameTaken(name, owner);

  const now = ctx.now();
  const player = data.player;
  const characterId = newId('c', ctx.randomBytes);
  const statements = [
    insertCharacter(db, guild.id, {
      id: characterId, playerId: player.id, teamId: team.id, name, realm: realm.realm, realmKey: realm.key, class: classId, mainSpec, offSpec, isMain: false,
    }, now),
    audit(ctx, guildContext, 'character.create', 'character', characterId, null,
      { personId: player.id, teamId: team.id, class: classId, mainSpec, offSpec, makeMain: body.makeMain === true }),
  ];
  if (body.makeMain === true) {
    statements.push(
      ...makeMainStatements(db, player.id, characterId, now, { homeTeamId: home.id, targetTeamId: team.id }),
      audit(ctx, guildContext, 'character.main', 'character', characterId,
        { mainCharacterId: data.characters.find((entry) => entry.row.is_main === 1).row.id }, { mainCharacterId: characterId }),
    );
  }
  statements.push(markRaidsStale(db, guild.id, [nameKey(name)], null, [team.id]));
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (constraintOf(error) === 'character_name') await nameConflict(ctx, guildContext, name, realm);
    mapCreateError(error);
  }
  if (body.makeMain === true && results[3].meta.changes !== 1) throw new HttpError(409, 'conflict', 'The Main could not be changed. Reload and try again.');
  return jsonResponse(await personReply(ctx, guildContext, player.id), 201);
}

export async function patchCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const { data } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const current = entry.row;
  requireEdit(guildContext, current.team_id);
  const keys = ['name', 'class', 'mainSpec', 'offSpec', 'teamId'];
  if (!keys.some((key) => body[key] !== undefined)) throw bad('Send a field to change.', 'name');

  const name = body.name === undefined ? current.name : readName(body.name);
  const classId = body.class === undefined ? current.class : readClass(body.class);
  const specs = readSpecs(
    body.mainSpec === undefined ? current.main_spec : body.mainSpec,
    body.offSpec === undefined ? current.off_spec : body.offSpec,
    classId,
  );
  let teamId = current.team_id;
  if (body.teamId !== undefined && body.teamId !== current.team_id) {
    const team = await requireTarget(db, guild.id, body.teamId);
    requireEdit(guildContext, team.id);
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
            WHERE id = ? AND player_id = ? AND guild_id = ? AND team_id = ?`,
        ).bind(name, nameKey(name), classId, specs.mainSpec, specs.offSpec, teamId, now, current.id, data.player.id, guild.id, current.team_id),
        audit(ctx, guildContext, 'character.update', 'character', current.id,
          { teamId: current.team_id, class: current.class, mainSpec: current.main_spec, offSpec: current.off_spec },
          { teamId, class: classId, mainSpec: specs.mainSpec, offSpec: specs.offSpec, changed },
          CHANGED_ONE),
        // A rename or a move changes which raids' results depend on this character.
        ...(changed.includes('name') || changed.includes('teamId') ? [markRaidsStale(db, guild.id, [nameKey(current.name), nameKey(name)], null, [current.team_id, teamId])] : []),
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { db } = ctx;
  const { data, home } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const target = entry.row;
  requireEdit(guildContext, home.id);
  requireEdit(guildContext, target.team_id);
  if (target.is_main === 1) return jsonResponse(await personReply(ctx, guildContext, data.player.id));
  const previous = data.characters.find((candidate) => candidate.row.is_main === 1).row;
  const now = ctx.now();
  const results = await db.batch([
    ...makeMainStatements(db, data.player.id, target.id, now, { homeTeamId: home.id, targetTeamId: target.team_id }),
    audit(ctx, guildContext, 'character.main', 'character', target.id, { mainCharacterId: previous.id }, { mainCharacterId: target.id },
      CHANGED_ONE),
  ]);
  if (results[1].meta.changes !== 1) return characterMoved(ctx, guildContext, data.player.id, target.id);
  return jsonResponse(await personReply(ctx, guildContext, data.player.id));
}

export async function removeCharacter(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const { db } = ctx;
  const { data } = await loadEditable(ctx, guildContext);
  const entry = findCharacter(data, ctx.params.cid);
  const target = entry.row;
  requireEdit(guildContext, target.team_id);
  const removable = {
    sql: 'EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id = ?)',
    params: [target.id, data.player.id, target.team_id],
  };
  const results = await db.batch([
    audit(ctx, guildContext, 'character.delete', 'character', target.id,
      { personId: data.player.id, teamId: target.team_id, class: target.class, mainSpec: target.main_spec, offSpec: target.off_spec }, null, removable),
    db.prepare('DELETE FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id = ? RETURNING id')
      .bind(target.id, data.player.id, target.team_id),
    markRaidsStale(db, guildContext.guild.id, [nameKey(target.name)], null, [target.team_id]),
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
