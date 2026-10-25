// The two roster imports: a Raid-Helper event and a Warcraft Logs report. A preview reads the source and
// stores nothing; a commit validates every row, then writes people and characters in one batch.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId, newId } from '../ids.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { memberSql } from '../membership.js';
import { allows, loadGuildContext } from '../permissions.js';
import { CORE_RANK_OF_IMPORTED_CHARACTER_SQL, syncCharacterRanksStatement } from '../person-legacy.js';
import { IMPORT_LIMIT, IMPORT_WINDOW_MS, WCL_GLOBAL_KEY, WCL_GLOBAL_LIMIT, enforceRateLimit } from '../ratelimit.js';
import {
  CREATE_STATUSES, RAID_HELPER_CLASS, RAID_HELPER_SPEC, WCL_CLASS, cleanCharacterName, cleanNickname, isSpecOf, nameKey,
  nicknameTokens, ownValue, realmKey, SINGLE_LINE_STRIP,
} from '../roster-data.js';
import { markRaidsStale } from '../attendance-store.js';
import { guildToday, loadRosterFlags } from '../roster-view.js';
import {
  fetchRaidHelperEvent, fetchWclReport, isEventId, isWclCode, isWclFlavour, parseRaidHelperSource, parseWclSource,
  requireWclConfigured,
} from '../sources.js';
import {
  bad, constraintOf, LIMIT_KINDS, limitError, nameTaken, readClass, readName, realmColumns, requireEdit, requireTarget, resolveRealm,
} from './roster.js';

const MAX_COMMIT_ROWS = 100;
const WCL_GLOBAL_WINDOW_MS = 10 * 60 * 1000;

export const indexed = (index) => ({ index });

export async function importRate(ctx) {
  const userId = ctx.session.user.id;
  await enforceRateLimit(ctx.db, userId, ctx.now(), { key: `imp:${userId}`, limit: IMPORT_LIMIT, windowMs: IMPORT_WINDOW_MS });
}

async function wclRate(ctx) {
  const userId = ctx.session.user.id;
  await enforceRateLimit(ctx.db, userId, ctx.now(), { key: `imp:${userId}`, limit: IMPORT_LIMIT, windowMs: IMPORT_WINDOW_MS, failClosed: true });
  await enforceRateLimit(ctx.db, userId, ctx.now(), { key: WCL_GLOBAL_KEY, limit: WCL_GLOBAL_LIMIT, windowMs: WCL_GLOBAL_WINDOW_MS, failClosed: true });
}

// The body-shape checks that need no database run before this; this is the first read.
export async function startImport(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const team = await requireTarget(ctx.db, guildContext.guild.id, ctx.body.teamId);
  requireEdit(guildContext, team.id);
  return { guildContext, team };
}

export function requireTeamId(body) {
  if (!isId('t', body.teamId)) throw bad('Pick a team.', 'teamId');
}

function readRows(body, field) {
  const rows = body[field];
  if (!Array.isArray(rows) || rows.length > MAX_COMMIT_ROWS) {
    throw bad(`Send at most ${MAX_COMMIT_ROWS} ${field}.`, field);
  }
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each row must be an object.', field, indexed(index));
  });
  return rows;
}

export function readDefaultStatus(raw, field, fallback, extra = {}) {
  const status = raw === undefined ? fallback : raw;
  if (!CREATE_STATUSES.includes(status)) throw bad('Pick raider, trial or reserve.', field, extra);
  return status;
}

// ---------------------------------------------------------------------------
// Lookups shared by the previews and commits (all set-based: one JSON parameter, no IN lists)

// Persons of this guild by Discord ID -> Map(discordId -> { id, name, class, mainSpec, homeTeamId, nickname, charKeys:Set }).
async function loadPersonsByDiscord(db, guildId, discordIds) {
  const json = JSON.stringify(discordIds);
  const [personResult, keyResult] = await db.batch([
    db.prepare(
      `SELECT p.id, p.discord_user_id, p.discord_nickname, m.name, m.class, m.main_spec, m.team_id
         FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ? AND p.discord_user_id IN (SELECT value FROM json_each(?))`,
    ).bind(guildId, json),
    db.prepare(
      `SELECT c.player_id, c.name_key FROM characters c
        WHERE c.guild_id = ? AND c.player_id IN (
          SELECT p.id FROM players p WHERE p.guild_id = ? AND p.discord_user_id IN (SELECT value FROM json_each(?)))`,
    ).bind(guildId, guildId, json),
  ]);
  const byDiscord = new Map();
  const byId = new Map();
  for (const row of personResult.results) {
    const person = {
      id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, homeTeamId: row.team_id,
      nickname: row.discord_nickname, charKeys: new Set(),
    };
    byDiscord.set(row.discord_user_id, person);
    byId.set(row.id, person);
  }
  for (const row of keyResult.results) byId.get(row.player_id).charKeys.add(row.name_key);
  return byDiscord;
}

// Discord IDs (of these) that belong to an account that is a member of this guild (worker/membership.js) -> Set.
async function loadSignedIn(db, guild, discordIds) {
  const result = await db.prepare(
    `SELECT u.discord_id FROM users u, (SELECT ? AS gid, ? AS sid) gc
      WHERE u.discord_id IN (SELECT value FROM json_each(?)) AND ${memberSql('u.id', 'gc.gid', 'gc.sid')}`,
  ).bind(guild.id, guild.discord_server_id, JSON.stringify(discordIds)).all();
  return new Set(result.results.map((row) => row.discord_id));
}

// Existing characters of the guild with any of these name keys on this realm key -> Map(nameKey -> { personId, name }).
async function loadNameOwners(db, guildId, realmKeyValue, nameKeys) {
  const result = await db.prepare(
    `SELECT c.name_key, c.player_id,
            (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name
       FROM characters c
      WHERE c.guild_id = ? AND c.realm_key = ? AND c.name_key IN (SELECT value FROM json_each(?))`,
  ).bind(guildId, realmKeyValue, JSON.stringify(nameKeys)).all();
  return new Map(result.results.map((row) => [row.name_key, { personId: row.player_id, name: row.main_name }]));
}

const takenOf = (owners, name) => {
  const owner = owners.get(nameKey(name));
  return owner ? { personId: owner.personId, name: owner.name } : null;
};

// ---------------------------------------------------------------------------
// Raid-Helper preview

// One sign-up -> { classId, spec, note } (the planner's _resolveRaidHelperEntry rules, without guessing a spec).
function resolveSignUp(signUp) {
  const info = ownValue(RAID_HELPER_SPEC, signUp.specName);
  const classId = info ? info.class : (ownValue(RAID_HELPER_CLASS, signUp.className) || null);
  let note = null;
  if (signUp.className === 'Absence') note = 'absence';
  else if (signUp.className === 'Tentative') note = 'tentative';
  else if (signUp.className === 'Late') note = 'late';
  else if (signUp.className === 'Bench') note = 'bench';
  else if (!classId) note = 'no_class';
  return { classId, spec: info ? info.spec : null, note };
}

// One group per Discord user (a sign-up without a Discord ID stands alone). The class-bearing sign-up wins,
// else the lowest position; the other sign-ups' names join the row's Alt suggestions.
function groupSignUps(signUps) {
  const groups = new Map();
  const ordered = [];
  for (const signUp of signUps) {
    const key = signUp.userId || `solo:${signUp.id}`;
    if (!groups.has(key)) { groups.set(key, []); ordered.push(key); }
    groups.get(key).push({ signUp, resolved: resolveSignUp(signUp) });
  }
  return ordered.map((key) => {
    const members = groups.get(key);
    const byPosition = (a, b) => a.signUp.position - b.signUp.position;
    const withClass = members.filter((member) => member.resolved.classId).sort(byPosition);
    const chosen = withClass.length ? withClass[0] : [...members].sort(byPosition)[0];
    const others = members.filter((member) => member !== chosen).sort(byPosition);
    return { chosen, others };
  }).sort((a, b) => a.chosen.signUp.position - b.chosen.signUp.position);
}

function uniqueNames(lists) {
  const seen = new Set();
  const names = [];
  for (const list of lists) {
    for (const name of list) {
      if (seen.has(nameKey(name))) continue;
      seen.add(nameKey(name));
      names.push(name);
    }
  }
  return names;
}

export async function previewRaidHelper(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  const eventId = parseRaidHelperSource(body.source);
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);
  const event = await fetchRaidHelperEvent(ctx, eventId);

  const groups = groupSignUps(event.signUps);
  const realm = realmColumns(guild);
  const tokenLists = groups.map((group) => uniqueNames([
    nicknameTokens(group.chosen.signUp.name),
    ...group.others.map((other) => nicknameTokens(other.signUp.name)),
  ]));
  const discordIds = [...new Set(groups.map((group) => group.chosen.signUp.userId).filter(Boolean))];
  const allKeys = [...new Set(tokenLists.flat().map(nameKey))];
  const [people, owners, signedResult] = await Promise.all([
    loadPersonsByDiscord(db, guild.id, discordIds),
    loadNameOwners(db, guild.id, realm.key, allKeys),
    loadSignedIn(db, guild, discordIds),
  ]);
  const signedIn = signedResult;

  const rows = groups.map((group, i) => {
    const { signUp, resolved } = group.chosen;
    const tokens = tokenLists[i];
    const person = signUp.userId ? people.get(signUp.userId) : null;
    const base = {
      signupId: signUp.id,
      nickname: signUp.name,
      signedIn: !!signUp.userId && signedIn.has(signUp.userId),
    };
    if (person) {
      return {
        ...base,
        kind: 'on_roster',
        person: { id: person.id, name: person.name },
        canAddAlts: allows(guildContext.can, 'roster.edit', team.id) && allows(guildContext.can, 'roster.edit', person.homeTeamId),
        main: { name: person.name, class: person.class, spec: person.mainSpec, note: null, taken: null },
        alts: tokens.filter((name) => !person.charKeys.has(nameKey(name))).map((name) => ({ name, taken: takenOf(owners, name) })),
        ticked: false,
      };
    }
    const isNew = !!signUp.userId;
    return {
      ...base,
      kind: isNew ? 'new' : 'no_discord',
      person: null,
      canAddAlts: false,
      main: {
        name: tokens[0] || null,
        class: resolved.classId,
        spec: resolved.spec,
        note: resolved.note,
        taken: tokens[0] ? takenOf(owners, tokens[0]) : null,
      },
      alts: tokens.slice(1).map((name) => ({ name, taken: takenOf(owners, name) })),
      ticked: isNew,
    };
  });

  return jsonResponse({
    event: {
      id: event.id,
      title: event.title,
      startTime: event.startTime,
      otherServer: event.serverId !== guild.discord_server_id,
    },
    rows,
  });
}

// ---------------------------------------------------------------------------
// Shared commit writer

// entries: [{ name, realmKey, index }] -> 400 name_taken for a repeat inside the request, 409 name_taken for a name
// the roster already holds (owner included).
export async function checkNames(db, guildId, entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = `${nameKey(entry.name)}|${entry.realmKey}`;
    if (seen.has(key)) {
      throw new HttpError(400, 'name_taken', `${entry.name} appears twice in this import.`, { field: 'name', ...indexed(entry.index) });
    }
    seen.add(key);
  }
  if (!entries.length) return;
  const result = await db.prepare(
    `SELECT c.name_key, c.realm_key, c.player_id,
            (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name
       FROM characters c WHERE c.guild_id = ? AND c.name_key IN (SELECT value FROM json_each(?))`,
  ).bind(guildId, JSON.stringify([...new Set(entries.map((entry) => nameKey(entry.name)))])).all();
  const existing = new Map(result.results.map((row) => [`${row.name_key}|${row.realm_key}`, row]));
  for (const entry of entries) {
    const row = existing.get(`${nameKey(entry.name)}|${entry.realmKey}`);
    if (row) throw nameTaken(entry.name, { personId: row.player_id, name: row.main_name }, indexed(entry.index));
  }
}

// plan: { people: [{ id, status, discord, nickname, joinedOn? }], characters: [{ id, playerId, name, realm, realmKey, class, mainSpec, offSpec, isMain, teamId? }],
//         nicknameUpdates: [{ id, nickname }], source, ref }
// joinedOn (a person's join date) and teamId (a character's team) are optional: without them the person joined today and the character is on `team`.
export async function writeImport(ctx, guildContext, team, plan) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const now = ctx.now();
  const today = guildToday(guild, now);
  // Nothing to create and nothing to refresh: no batch, no audit row.
  if (!plan.people.length && !plan.characters.length && !plan.nicknameUpdates.length) {
    return { status: 200, body: { people: 0, characters: 0, rosterFlags: await loadRosterFlags(db, guildContext, today) } };
  }
  const statements = [];
  if (plan.people.length) {
    statements.push(db.prepare(
      `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, discord_user_id, discord_nickname, version, notes_version, created_by, created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.status'), COALESCE(json_extract(value, '$.joinedOn'), ?),
              CASE WHEN json_extract(value, '$.status') = 'trial' THEN COALESCE(json_extract(value, '$.joinedOn'), ?) END, NULL,
              json_extract(value, '$.discord'), json_extract(value, '$.nickname'), 1, 0, ?, ?, ?
         FROM json_each(?)`,
    ).bind(guild.id, today, today, ctx.session.user.id, now, now, JSON.stringify(plan.people)));
  }
  if (plan.characters.length) {
    statements.push(db.prepare(
      `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at, core_rank)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.playerId'), COALESCE(json_extract(value, '$.teamId'), ?), json_extract(value, '$.name'), json_extract(value, '$.nameKey'),
              json_extract(value, '$.realm'), json_extract(value, '$.realmKey'), json_extract(value, '$.class'), json_extract(value, '$.mainSpec'),
              json_extract(value, '$.offSpec'), json_extract(value, '$.isMain'), ?, ?, ${CORE_RANK_OF_IMPORTED_CHARACTER_SQL}
         FROM json_each(?)`,
    ).bind(guild.id, team.id, now, now, JSON.stringify(plan.characters.map((character) => ({
      ...character, nameKey: nameKey(character.name), isMain: character.isMain ? 1 : 0,
    })))));
  }
  // Dual write (worker/person-legacy.js): the character columns of every person the import touches follow their players rows.
  const personIds = [...new Set([...plan.people.map((person) => person.id), ...plan.characters.map((character) => character.playerId)])];
  if (personIds.length) statements.push(syncCharacterRanksStatement(db, guild.id, personIds));
  if (plan.nicknameUpdates.length) {
    const json = JSON.stringify(plan.nicknameUpdates);
    statements.push(db.prepare(
      `UPDATE players SET discord_nickname = (SELECT json_extract(value, '$.nickname') FROM json_each(?) WHERE json_extract(value, '$.id') = players.id),
              updated_at = ?
        WHERE guild_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    ).bind(json, now, guild.id, json));
  }
  // Raids whose logs name a new character show "Recalculate".
  if (plan.characters.length) {
    const teamIds = [team.id, ...plan.characters.map((character) => character.teamId).filter(Boolean)];
    statements.push(markRaidsStale(db, guild.id, plan.characters.map((character) => nameKey(character.name)), null, teamIds));
  }
  statements.push(auditStatement(ctx, {
    guildId: guild.id, actorUserId: ctx.session.user.id, action: 'roster.import', entityType: 'team', entityId: team.id,
    after: { source: plan.source, ref: plan.ref, people: plan.people.length, characters: plan.characters.length },
  }));
  try {
    await db.batch(statements);
  } catch (error) {
    const kind = constraintOf(error);
    if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
    if (kind === 'character_name') {
      throw new HttpError(409, 'name_taken', 'A character name was taken while you were importing. Preview again.', { field: 'name' });
    }
    if (kind === 'discord') {
      throw new HttpError(409, 'already_on_roster', 'Someone in this import joined the roster while you were working. Preview again.');
    }
    if (kind === 'foreign_key') throw new HttpError(404, 'not_found', 'A person or team in this import no longer exists.');
    throw error;
  }
  return {
    status: 201,
    body: {
      people: plan.people.length,
      characters: plan.characters.length,
      rosterFlags: await loadRosterFlags(db, guildContext, today),
    },
  };
}

// ---------------------------------------------------------------------------
// Raid-Helper commit

function readCharacterPart(raw, index, field, { withSpec, gameVersion }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('That character is missing.', field, indexed(index));
  const name = readName(raw.name, `${field}.name`, indexed(index), gameVersion);
  const classId = readClass(raw.class, `${field}.class`, indexed(index));
  let mainSpec = null;
  if (withSpec && raw.spec !== undefined && raw.spec !== null) {
    if (typeof raw.spec !== 'string' || !isSpecOf(classId, raw.spec)) throw bad('That spec does not belong to the class.', `${field}.spec`, indexed(index));
    mainSpec = raw.spec;
  }
  return { name, classId, mainSpec };
}

export async function commitRaidHelper(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  if (!isEventId(body.eventId)) throw bad('That event ID is not valid.', 'eventId');
  const status = readDefaultStatus(body.defaultStatus, 'defaultStatus', 'raider');
  if (body.acceptOtherServer !== undefined && typeof body.acceptOtherServer !== 'boolean') {
    throw bad('acceptOtherServer must be true or false.', 'acceptOtherServer');
  }
  const rows = readRows(body, 'rows');
  const seenSignUps = new Set();
  rows.forEach((row, index) => {
    if (!Number.isInteger(row.signupId) || seenSignUps.has(row.signupId)) throw bad('Each row needs its own signupId.', 'signupId', indexed(index));
    seenSignUps.add(row.signupId);
    if (row.alts !== undefined && !Array.isArray(row.alts)) throw bad('alts must be a list.', 'alts', indexed(index));
  });
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);
  const event = await fetchRaidHelperEvent(ctx, body.eventId);
  if (event.serverId !== guild.discord_server_id && body.acceptOtherServer !== true) {
    throw new HttpError(409, 'other_server', 'That event was posted in a different Discord server.');
  }
  const bySignUp = new Map(event.signUps.map((signUp) => [signUp.id, signUp]));
  const resolvedRows = rows.map((row, index) => {
    const signUp = bySignUp.get(row.signupId);
    if (!signUp) throw new HttpError(409, 'event_changed', 'The event changed since you loaded it.', indexed(index));
    return { row, index, signUp };
  });
  const discordIds = resolvedRows.map((entry) => entry.signUp.userId).filter(Boolean);
  if (new Set(discordIds).size !== discordIds.length) throw bad('Two rows belong to the same Discord member.', 'rows');
  const people = await loadPersonsByDiscord(db, guild.id, discordIds);
  const realm = realmColumns(guild);

  const plan = { people: [], characters: [], nicknameUpdates: [], source: 'raid_helper', ref: body.eventId };
  const nameEntries = [];
  const newCharacter = (playerId, part, isMain, index) => {
    nameEntries.push({ name: part.name, realmKey: realm.key, index });
    plan.characters.push({
      id: newId('c', ctx.randomBytes), playerId, name: part.name, realm: realm.realm, realmKey: realm.key,
      class: part.classId, mainSpec: isMain ? part.mainSpec : null, offSpec: null, isMain,
    });
  };
  for (const { row, index, signUp } of resolvedRows) {
    const existing = signUp.userId ? people.get(signUp.userId) : null;
    const alts = (row.alts || []).map((alt) => readCharacterPart(alt, index, 'alts', { withSpec: false, gameVersion: guild.game_version }));
    const nickname = cleanNickname(signUp.name);
    if (existing) {
      if (row.main !== undefined && row.main !== null) {
        throw new HttpError(409, 'already_on_roster', `${existing.name} is already on the roster.`, indexed(index));
      }
      if (!allows(guildContext.can, 'roster.edit', team.id) || !allows(guildContext.can, 'roster.edit', existing.homeTeamId)) {
        throw new HttpError(403, 'forbidden', 'You do not have permission to add to that person.', indexed(index));
      }
      for (const alt of alts) newCharacter(existing.id, alt, false, index);
      if (nickname !== existing.nickname) plan.nicknameUpdates.push({ id: existing.id, nickname });
      continue;
    }
    if (row.main === undefined || row.main === null) throw bad('Every new person needs a Main.', 'main', indexed(index));
    const main = readCharacterPart(row.main, index, 'main', { withSpec: true, gameVersion: guild.game_version });
    const playerId = newId('p', ctx.randomBytes);
    plan.people.push({ id: playerId, status, discord: signUp.userId, nickname });
    newCharacter(playerId, main, true, index);
    for (const alt of alts) newCharacter(playerId, alt, false, index);
  }
  await checkNames(db, guild.id, nameEntries);
  const written = await writeImport(ctx, guildContext, team, plan);
  return jsonResponse(written.body, written.status);
}

// ---------------------------------------------------------------------------
// Warcraft Logs preview

export async function loadGuildKeys(db, guildId) {
  const result = await db.prepare(
    `SELECT c.name_key, c.realm_key, c.player_id,
            (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name
       FROM characters c WHERE c.guild_id = ?`,
  ).bind(guildId).all();
  return new Map(result.results.map((row) => [`${row.name_key}|${row.realm_key}`, { id: row.player_id, name: row.main_name }]));
}

// People in the viewer's scope whose stored nickname has the name as a token -> Map(nameKey -> [person]).
export async function loadNicknameIndex(db, guildContext, team) {
  const result = await db.prepare(
    `SELECT p.id, p.discord_nickname, m.name AS main_name, m.team_id
       FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
      WHERE p.guild_id = ? AND p.discord_nickname IS NOT NULL`,
  ).bind(guildContext.guild.id).all();
  const index = new Map();
  for (const row of result.results) {
    if (!allows(guildContext.can, 'roster.edit', team.id) || !allows(guildContext.can, 'roster.edit', row.team_id)) continue;
    for (const token of nicknameTokens(row.discord_nickname)) {
      const key = nameKey(token);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ personId: row.id, name: row.main_name });
    }
  }
  return index;
}

export async function previewWcl(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  requireWclConfigured(ctx.env);
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  const { flavour, code } = parseWclSource(body.source, guild.game_version);
  await wclRate(ctx);
  const report = await fetchWclReport(ctx, flavour, code);

  const isRealmGuild = guild.realm_kind !== 'ruleset';
  const guildRealmKey = isRealmGuild ? realmKey(guild.realm) : '';
  const [keys, nicknames, surnames] = await Promise.all([loadGuildKeys(db, guild.id), loadNicknameIndex(db, guildContext, team), loadSurnameIndex(db, guild)]);
  const matched = [];
  const toDecide = [];
  const seen = new Set();
  for (const actor of report.actors) {
    const classId = ownValue(WCL_CLASS, actor.subType);
    const cleaned = classId ? cleanCharacterName(actor.name, guild.game_version) : null;
    if (!cleaned) continue;
    // A realm the commit would accept is shown in its canonical spelling; any other realm is shown as sent (cleaned)
    // and counts as another realm, which the commit refuses.
    const resolved = isRealmGuild ? resolveRealm(guild, actor.server || null) : null;
    const rawRealm = isRealmGuild ? String(actor.server || '').replace(SINGLE_LINE_STRIP, '').trim() : null;
    const realmText = isRealmGuild ? (resolved ? resolved.realm : rawRealm) : null;
    const actorRealmKey = isRealmGuild ? (resolved ? resolved.key : realmKey(rawRealm)) : '';
    if (isRealmGuild && !actorRealmKey) continue;
    const name = resolveName(surnames, cleaned, actorRealmKey); // Forever: a log's "Thrall" is the roster's "Thrall Stormrage" when only one has that first name
    const key = `${nameKey(name)}|${actorRealmKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = keys.get(key);
    if (owner) {
      matched.push({ name, class: classId, person: { id: owner.id, name: owner.name } });
      continue;
    }
    const candidates = nicknames.get(nameKey(name)) || [];
    toDecide.push({
      key,
      name,
      realm: realmText,
      class: classId,
      otherRealm: isRealmGuild && (!resolved || resolved.key !== guildRealmKey),
      suggestion: candidates.length === 1 ? { personId: candidates[0].personId, name: candidates[0].name } : null,
    });
  }
  matched.sort((a, b) => a.name.localeCompare(b.name));
  toDecide.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({
    report: { code, flavour, title: report.title, zone: report.zone, startTime: report.startTime },
    matched,
    toDecide,
  });
}

// ---------------------------------------------------------------------------
// Warcraft Logs commit

export async function commitWcl(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  const report = body.report;
  if (!report || typeof report !== 'object' || !isWclCode(report.code) || !isWclFlavour(report.flavour)) {
    throw bad('That report is not valid.', 'report');
  }
  const decisions = readRows(body, 'decisions');
  const actions = decisions.map((decision, index) => {
    if (!['alt', 'new', 'skip'].includes(decision.action)) throw bad('Pick alt, new or skip.', 'action', indexed(index));
    return { decision, index };
  });
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);

  const plan = { people: [], characters: [], nicknameUpdates: [], source: 'wcl', ref: `${report.flavour}:${report.code}` };
  const nameEntries = [];
  const alts = [];
  const created = [];
  for (const { decision, index } of actions) {
    if (decision.action === 'skip') continue;
    const name = readName(decision.name, 'name', indexed(index), guild.game_version);
    const classId = readClass(decision.class, 'class', indexed(index));
    // A ruleset guild ignores `realm`; a realm guild accepts only its own realm or one on its realm list.
    const realm = resolveRealm(guild, decision.realm);
    if (!realm) throw bad('That realm is not valid.', 'realm', indexed(index));
    const character = { name, realm: realm.realm, realmKey: realm.key, class: classId, mainSpec: null, offSpec: null };
    nameEntries.push({ name, realmKey: realm.key, index });
    if (decision.action === 'alt') {
      if (!isId('p', decision.personId)) throw bad('Pick the person this character belongs to.', 'personId', indexed(index));
      alts.push({ index, personId: decision.personId, character });
    } else {
      const status = readDefaultStatus(decision.status, 'status', 'trial', indexed(index));
      created.push({ index, status, character });
    }
  }
  const personIds = [...new Set(alts.map((entry) => entry.personId))];
  const homeByPerson = new Map();
  if (personIds.length) {
    const result = await db.prepare(
      `SELECT p.id, m.team_id FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
    ).bind(guild.id, JSON.stringify(personIds)).all();
    for (const row of result.results) homeByPerson.set(row.id, row.team_id);
  }
  for (const entry of alts) {
    if (!homeByPerson.has(entry.personId)) throw new HttpError(404, 'not_found', 'That person was not found.', indexed(entry.index));
    if (!allows(guildContext.can, 'roster.edit', homeByPerson.get(entry.personId))) {
      throw new HttpError(403, 'forbidden', 'You do not have permission to add to that person.', indexed(entry.index));
    }
    plan.characters.push({ id: newId('c', ctx.randomBytes), playerId: entry.personId, ...entry.character, isMain: false });
  }
  for (const entry of created) {
    const playerId = newId('p', ctx.randomBytes);
    plan.people.push({ id: playerId, status: entry.status, discord: null, nickname: null });
    plan.characters.push({ id: newId('c', ctx.randomBytes), playerId, ...entry.character, isMain: true });
  }
  await checkNames(db, guild.id, nameEntries);
  const written = await writeImport(ctx, guildContext, team, plan);
  return jsonResponse(written.body, written.status);
}
