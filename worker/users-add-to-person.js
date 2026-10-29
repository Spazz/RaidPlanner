// "Add to a person" of the Users page (user-hierarchy build, lane B7b part 2; H-Q34: no manual merge, a log-only sighting resolves when its character joins a person - an owner's
// claim or an officer's "Add to a person"; H-Q45: Manage users).
//   POST /api/guild/:gid/users/add-to-person   { person: ukey (an account's or an account-less person's), names: [{ key: 'n_...', class? }] }
//   -> { person: { key, name }, done: [{ key, name, characterId }], skipped: [{ key, name, reason, message }], cap }
// A NAME of the Users list (a loot winner, a log name, a pasted name, a sign-up nickname, an application: a sighting that no character of the guild carries) becomes a character of
// the person - an alt, on no team, with the rank and left date of the person's Main (what the attendance page's "Add as alt" writes). Loot is keyed by name and realm and lines up by
// itself; attendance is per person, so the raids whose log names it are marked out of date. It is BOOKKEEPING: it proves nothing and it never touches players.user_id (an account
// reaches a person only through Battle.net, the holder's own application or an approved claim; a parallel lane guards that column). The character carries no Blizzard id and no proof.
// In an in-game guild (rank_source 'ingame') the roster is Blizzard's and characters reach an account only through Battle.net: 409 `battlenet_only`.
// The write is one INSERT ... SELECT over all the names plus one audit row per character; every statement carries the guards (the actor still holds guild.access and, guild-wide,
// roster.edit; the guild is still not in-game; the Seniority guard of worker/seniority.js on the person; the person exists), so a lost race writes nothing.
import { HttpError } from './http.js';
import { auditStatement } from './audit.js';
import { wrote } from './d1-changes.js';
import { markRaidsStale, weekFreeze } from './attendance-store.js';
import { visibleCharacterSql } from './character-visibility.js';
import { newId } from './ids.js';
import { LIMITS } from './limits.js';
import { IMPORTED_RANK_COLUMNS_SQL } from './person-legacy.js';
import { CLASS_IDS, cleanCharacterName, nameKey } from './roster-data.js';
import { actorHolds } from './routes/people.js';
import { constraintOf, limitError, LIMIT_KINDS, resolveRealm } from './routes/roster.js';
import { SENIORITY_MESSAGE, seniorityOk } from './seniority.js';
import { BULK_MAX_KEYS } from './users-bulk.js';
import { namesCtes, newScope, personOfAccountSql, viewerOf } from './users-list.js';
import { parseUserKey } from './users-detail.js';

export const ADD_MAX_NAMES = 10;

export const ADD_SKIP_MESSAGES = Object.freeze({
  not_found: 'That name is not in the list of names seen (it may be on the roster already).',
  not_a_name: 'Only a name seen in a log, loot or a sign-up can be added to a person.',
  bad_name: 'That name cannot be a character name (2 to 12 letters, or a first name and a surname on WoW Forever).',
  bad_realm: 'That name was seen on a realm this guild does not take.',
  class_needed: 'Pick this character\'s class.',
  character_limit: `A person can have at most ${LIMITS.charactersPerPerson} characters.`,
  over_cap: `Only ${ADD_MAX_NAMES} names are added at a time. Send these again.`,
  conflict: 'That changed while you were working on it. Reload and try again.',
});

const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });
const notFound = (message) => new HttpError(404, 'not_found', message);

// -> { person: { kind, id }, names: [{ key, class }] } (names distinct by key, request order). 400 for a body that is not this shape.
export function parseAddBody(body) {
  const object = body && typeof body === 'object' ? body : {};
  const person = typeof object.person === 'string' ? parseUserKey(object.person) : null;
  if (!person || person.kind === 'name' || person.kind === 'roster') throw bad('Pick the person to add the names to.', 'person');
  if (!Array.isArray(object.names) || !object.names.length) throw bad('Pick at least one name.', 'names');
  if (object.names.length > BULK_MAX_KEYS) throw bad(`At most ${BULK_MAX_KEYS} names in one request.`, 'names');
  const seen = new Set();
  const names = [];
  for (const entry of object.names) {
    const item = typeof entry === 'string' ? { key: entry } : entry;
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key || item.key.length > 600) throw bad('Every name is a key from the Users list.', 'names');
    if (item.class !== undefined && item.class !== null && !(typeof item.class === 'string' && CLASS_IDS.includes(item.class))) throw bad('Pick one of the nine classes.', 'class');
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    names.push({ key: item.key, class: item.class || null });
  }
  return { person, names };
}

// A guard of the single routes ({ sql, params } with bare ?) as numbered placeholders of the statement being built.
function numbered(add, guard) {
  let at = 0;
  return guard.sql.replace(/\?/g, () => add(guard.params[at++]));
}

function scoped(db, build) {
  const values = [];
  const add = (value) => { values.push(value === undefined ? null : value); return `?${values.length}`; };
  const sql = build(add);
  return db.prepare(sql).bind(...values);
}

export async function addToPerson(ctx, guildContext, { person, names }) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const actorId = guildContext.userId;
  const now = ctx.now();
  const todo = names.map((name) => ({ ...name, parsed: parseUserKey(name.key) }));
  const outcome = new Map();
  let taken = 0;
  for (const name of todo) {
    if (!name.parsed || name.parsed.kind !== 'name') outcome.set(name.key, { reason: name.parsed ? 'not_a_name' : 'not_found', name: null });
    else if (taken >= ADD_MAX_NAMES) outcome.set(name.key, { reason: 'over_cap', name: null });
    else taken++;
  }
  const asked = todo.filter((name) => !outcome.has(name.key));

  // The facts, one batch: the guild's source, the person (an account's is the one its link or Discord id gives) with how many characters it has and whether the actor may change
  // it, and the names asked about (the list's own CTE: a name that no character of the guild carries, seen in a source this viewer may see).
  const scope = newScope(guild, now, { signIn: false, viewer: viewerOf(guildContext) });
  const g = scope.g();
  const personExpr = person.kind === 'account'
    ? personOfAccountSql(g, scope.add(person.id), `(SELECT du.discord_id FROM users du WHERE du.id = ${scope.add(person.id)})`)
    : scope.add(person.id);
  // (The statements are built apart from prepare(): the interpolations are placeholders, the list's own CTE text and a fixed helper, never request data.)
  const personSql = `SELECT p.id AS id, (SELECT COUNT(*) FROM characters c WHERE c.player_id = p.id) AS characters,
            COALESCE((SELECT m.name FROM characters m WHERE m.player_id = p.id AND m.is_main = 1 AND ${visibleCharacterSql('m')}), p.discord_nickname, 'Unnamed') AS name
       FROM players p WHERE p.guild_id = ${g} AND p.id = ${personExpr}`;
  const statements = [db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guild.id), db.prepare(personSql).bind(...scope.values)];
  if (asked.length) {
    const sc = newScope(guild, now, { signIn: false, viewer: viewerOf(guildContext) });
    const namesSql = `WITH RECURSIVE ${namesCtes(sc)} SELECT nk, nm, rlm, cls FROM nm WHERE nk IN (SELECT value FROM json_each(${sc.add(JSON.stringify(asked.map((name) => name.parsed.nameKey)))}))`;
    statements.push(db.prepare(namesSql).bind(...sc.values));
  }
  const results = await db.batch(statements);
  const source = results[0].results[0];
  // In-game: Blizzard's roster gives the characters, and an account gets one only through Battle.net.
  if (source && source.rank_source === 'ingame') {
    throw new HttpError(409, 'battlenet_only', 'In this guild characters reach an account only through Battle.net, so a name is not added to a person by hand.');
  }
  const target = results[1].results[0];
  if (!target) throw notFound(person.kind === 'account' ? 'That account has no person on the roster to add characters to.' : 'That person was not found.');
  // The Seniority guard of the person (a junior never changes a senior's characters), read here for a clean 403 and repeated inside the write.
  const senior = seniorityOk(guild.id, actorId, target.id);
  const check = await db.prepare(`SELECT ${senior.sql} AS ok`).bind(...senior.params).first();
  if (!check || check.ok !== 1) throw new HttpError(403, 'seniority', SENIORITY_MESSAGE);

  const found = new Map(asked.length ? results[2].results.map((row) => [row.nk, row]) : []);
  const additions = [];
  let room = LIMITS.charactersPerPerson - target.characters;
  for (const name of asked) {
    const row = found.get(name.parsed.nameKey);
    if (!row) { outcome.set(name.key, { reason: 'not_found', name: null }); continue; }
    const clean = cleanCharacterName(row.nm, guild.game_version);
    if (!clean || nameKey(clean) !== name.parsed.nameKey) { outcome.set(name.key, { reason: 'bad_name', name: row.nm }); continue; }
    const realm = resolveRealm(guild, row.rlm || null);
    if (!realm) { outcome.set(name.key, { reason: 'bad_realm', name: clean }); continue; }
    const classId = row.cls || name.class;
    if (!classId) { outcome.set(name.key, { reason: 'class_needed', name: clean }); continue; }
    if (room <= 0) { outcome.set(name.key, { reason: 'character_limit', name: clean }); continue; }
    room--;
    additions.push({ key: name.key, id: newId('c', ctx.randomBytes), playerId: target.id, name: clean, nameKey: name.parsed.nameKey, realm: realm.realm, realmKey: realm.key, class: classId });
  }

  if (additions.length) {
    const guard = (add) => [
      `EXISTS (SELECT 1 FROM players WHERE id = ${add(target.id)} AND guild_id = ${add(guild.id)})`,
      `EXISTS (SELECT 1 FROM guilds WHERE id = ${add(guild.id)} AND rank_source IS NOT 'ingame')`,
      numbered(add, actorHolds('guild.access', guild.id, actorId)),
      numbered(add, actorHolds('roster.edit', guild.id, actorId)),
      numbered(add, senior),
    ].join(' AND ');
    const inserted = (characterId) => ({ sql: 'EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ?)', params: [characterId, target.id] });
    const batch = [
      scoped(db, (add) => `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at,
                                core_rank, left_on, left_reason, trial_start, trial_end)
          SELECT json_extract(j.value, '$.id'), ${add(guild.id)}, json_extract(j.value, '$.playerId'), NULL, json_extract(j.value, '$.name'), json_extract(j.value, '$.nameKey'),
                 json_extract(j.value, '$.realm'), json_extract(j.value, '$.realmKey'), json_extract(j.value, '$.class'), NULL, NULL, 0, ${add(now)}, ${add(now)},
                 ${IMPORTED_RANK_COLUMNS_SQL}
            FROM json_each(${add(JSON.stringify(additions.map((one) => ({ id: one.id, playerId: one.playerId, name: one.name, nameKey: one.nameKey, realm: one.realm, realmKey: one.realmKey, class: one.class }))))}) j
           WHERE ${guard(add)}`),
      // The raids whose log names these characters now belong to a person: their results are out of date.
      markRaidsStale(db, guild.id, additions.map((one) => one.nameKey), null, [], { sql: 'EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ?)', params: [additions[0].id, target.id] }, weekFreeze(guild.time_zone, now)),
      ...additions.map((one) => auditStatement(ctx, {
        guildId: guild.id, actorUserId: actorId, action: 'character.create', entityType: 'character', entityId: one.id,
        after: { personId: target.id, teamId: null, class: one.class, mainSpec: null, offSpec: null, makeMain: false, via: 'users' },
      }, inserted(one.id))),
    ];
    let outcomeOfBatch;
    try {
      outcomeOfBatch = await db.batch(batch);
    } catch (error) {
      const kind = constraintOf(error);
      if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
      if (kind === 'character_name' || kind === 'foreign_key') throw new HttpError(409, 'conflict', ADD_SKIP_MESSAGES.conflict);
      throw error;
    }
    // One INSERT ... SELECT under one guard: it wrote every name or none (a guard that said no between the read and the write).
    const written = wrote(outcomeOfBatch[0]);
    for (const one of additions) outcome.set(one.key, written ? { done: true, name: one.name, characterId: one.id } : { reason: 'conflict', name: one.name });
  }

  const done = [];
  const skipped = [];
  for (const name of todo) {
    const entry = outcome.get(name.key);
    if (entry.done) done.push({ key: name.key, name: entry.name, characterId: entry.characterId });
    else skipped.push({ key: name.key, name: entry.name, reason: entry.reason, message: ADD_SKIP_MESSAGES[entry.reason] });
  }
  return { person: { key: person.id, name: target.name }, done, skipped, cap: ADD_MAX_NAMES };
}
