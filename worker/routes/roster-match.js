// Match to roster (user-hierarchy build, lane B6a): POST /api/guild/:gid/roster/:pid/characters/:cid/match { namespace, blizzardRealmId, blizzardCharId }.
// After the flip an id-less character (hand-added, imported, claimed before it) is bound to its place on the in-game roster by an officer, or by its owner's Battle.net
// proof, and by nothing else. The officer picks the guild_roster row; the character takes that row's identity key, name, name_key and class and keeps everything else
// (team, specs when the class is the same, the person, owner_proof: it stays 'officer' or 'hand', never 'bnet').
//   rights    roster.edit on the character's team (the whole guild for a character on no team), the Seniority guard (worker/seniority.js) and, for a roster row whose
//             in-game rank the guild's map gives an elevated role (Guild Master, Officer, Team Lead), the Owner or an actor strictly senior to that role: the key makes
//             whoever owns the character that rank (403 `seniority`, rosterRowOk)
//   refused   409 already_bound (the character has an identity key) | 409 left_guild (left_on is set: a Former character is never bound) | 409 identity_taken (another
//             character of the guild holds that key) | 409 name_taken (another character already carries the roster row's name) | 404 not_found (no such row in THIS guild's
//             guild_roster, or no such character)
//   a rename (the row's name_key differs) writes a dated character_name_aliases row for the old key, as the roster sync's rename does, and marks the raids stale for the
//   old and the new key; in an in-game guild the rank map is applied in the same batch (the character is on the roster now, so it gets the rank of its row).
// EVERY statement carries the same guard (the character is still id-less and un-left under its old name and team, the roster row still says what the officer saw, the key
// is free, the Seniority guard), so a lost race changes nothing at all: 409 conflict with the current record.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { markRaidsStale, weekFreeze } from '../attendance-store.js';
import { isId } from '../ids.js';
import { loadGuildContext } from '../permissions.js';
import { ingameGuard, rankMapApplyStatements } from '../rank-map.js';
import { CLASS_IDS, isSpecOf } from '../roster-data.js';
import { homeTeamOf, loadPersonData, personReply } from '../roster-view.js';
import { assertMayMatchRow, assertSenior, rosterRowOk, seniorityOk } from '../seniority.js';
import { bad, characterMoved, constraintOf, findCharacter, findNameOwner, nameTaken, requireEdit } from './roster.js';
import { wrote } from '../d1-changes.js';

const notFound = (message) => new HttpError(404, 'not_found', message);

function readKey(body) {
  if (typeof body.namespace !== 'string' || !body.namespace || body.namespace.length > 64) throw bad('Pick a place on the in-game roster.', 'namespace');
  if (!Number.isInteger(body.blizzardRealmId) || body.blizzardRealmId < 1) throw bad('Pick a place on the in-game roster.', 'blizzardRealmId');
  if (!Number.isInteger(body.blizzardCharId) || body.blizzardCharId < 1) throw bad('Pick a place on the in-game roster.', 'blizzardCharId');
  return { namespace: body.namespace, realmId: body.blizzardRealmId, charId: body.blizzardCharId };
}

// The guard repeated in every statement: ?-placeholders only, bound in this order.
// The character is guarded as the officer saw it: its name, team, class and both specs (it has no version column), so an edit that lands between the read and the
// write makes the whole batch a no-op instead of being overwritten by values computed from the old record.
function matchGuard({ guildId, personId, current, row, key, senior, rowOk }) {
  return {
    sql: `EXISTS (SELECT 1 FROM characters mc WHERE mc.id = ? AND mc.guild_id = ? AND mc.player_id = ? AND mc.blizzard_char_id IS NULL AND mc.left_on IS NULL
                    AND mc.name_key = ? AND mc.team_id IS ? AND mc.class = ? AND mc.main_spec IS ? AND mc.off_spec IS ?)
          AND EXISTS (SELECT 1 FROM guild_roster mg WHERE mg.guild_id = ? AND mg.namespace = ? AND mg.blizzard_realm_id = ? AND mg.blizzard_char_id = ?
                        AND mg.name_key = ? AND mg.class = ?)
          AND NOT EXISTS (SELECT 1 FROM characters mo WHERE mo.guild_id = ? AND mo.namespace = ? AND mo.blizzard_realm_id = ? AND mo.blizzard_char_id = ?)
          AND ${senior.sql} AND ${rowOk.sql}`,
    params: [
      current.id, guildId, personId, current.name_key, current.team_id, current.class, current.main_spec, current.off_spec,
      guildId, key.namespace, key.realmId, key.charId, row.name_key, row.class,
      guildId, key.namespace, key.realmId, key.charId,
      ...senior.params,
      ...rowOk.params,
    ],
  };
}

export async function matchToRoster(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const data = await loadPersonData(db, guild.id, ctx.params.pid);
  if (!data || !homeTeamOf(data)) throw notFound('That person was not found.');
  const current = findCharacter(data, ctx.params.cid).row;
  requireEdit(guildContext, current.team_id);
  const key = readKey(body);
  if (current.blizzard_char_id !== null && current.blizzard_char_id !== undefined) {
    throw new HttpError(409, 'already_bound', 'This character is already linked to Battle.net.');
  }
  if (current.left_on) throw new HttpError(409, 'left_guild', 'This character has left the guild. A character that left is never matched to the roster.');
  await assertSenior(db, guildContext, data.player.id);
  await assertMayMatchRow(db, guildContext, key);

  const [rowResult, holderResult, sourceResult, keysResult] = await db.batch([
    db.prepare('SELECT name, name_key, class FROM guild_roster WHERE guild_id = ? AND namespace = ? AND blizzard_realm_id = ? AND blizzard_char_id = ?')
      .bind(guild.id, key.namespace, key.realmId, key.charId),
    db.prepare('SELECT id FROM characters WHERE guild_id = ? AND namespace = ? AND blizzard_realm_id = ? AND blizzard_char_id = ?')
      .bind(guild.id, key.namespace, key.realmId, key.charId),
    db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guild.id),
    db.prepare('SELECT name_key, realm_key FROM characters WHERE id = ? AND guild_id = ?').bind(current.id, guild.id),
  ]);
  const row = rowResult.results[0];
  const stored = keysResult.results[0];
  if (!stored) throw notFound('That character was not found.');
  const old = {
    id: current.id, name_key: stored.name_key, realm_key: stored.realm_key, team_id: current.team_id, class: current.class, main_spec: current.main_spec ?? null, off_spec: current.off_spec ?? null,
  };
  if (!row) throw notFound('That character is not on the in-game roster.');
  if (holderResult.results.length) throw new HttpError(409, 'identity_taken', 'Another character of this guild is already linked to that place on the roster.', { field: 'blizzardCharId' });
  if (!CLASS_IDS.includes(row.class)) throw new HttpError(409, 'roster_class_unknown', 'The roster row names a class Raidsmith does not know.');
  const owner = row.name_key === old.name_key ? null : await findNameOwner(db, guild.id, row.name_key, old.realm_key);
  if (owner && owner.characterId !== current.id) throw nameTaken(row.name, owner);

  const now = ctx.now();
  const actorId = ctx.session.user.id;
  const renamed = row.name_key !== old.name_key;
  const classChanged = row.class !== current.class;
  // The specs belong to a class: a different class clears them (a spec is chosen again on the person page).
  const mainSpec = classChanged || !isSpecOf(row.class, current.main_spec) ? null : current.main_spec;
  const offSpec = classChanged || !isSpecOf(row.class, current.off_spec) ? null : current.off_spec;
  const guard = matchGuard({
    guildId: guild.id, personId: data.player.id, current: old, row, key, senior: seniorityOk(guild.id, actorId, data.player.id), rowOk: rosterRowOk(guild.id, actorId, key),
  });
  const guarded = (sql, params) => db.prepare(sql + ' AND ' + guard.sql).bind(...params, ...guard.params);

  const statements = [markRaidsStale(db, guild.id, [old.name_key, row.name_key], null, current.team_id ? [current.team_id] : [], guard, weekFreeze(guild.time_zone, now))];
  if (renamed) {
    statements.push(db.prepare(
      `INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at)
       SELECT 'na_' || lower(hex(randomblob(16))), ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    ).bind(guild.id, current.id, old.name_key, old.realm_key, now, ...guard.params));
  }
  statements.push(auditStatement(ctx, {
    guildId: guild.id,
    actorUserId: actorId,
    action: 'character.match_roster',
    entityType: 'character',
    entityId: current.id,
    before: { personId: data.player.id, teamId: current.team_id },
    after: { personId: data.player.id, teamId: current.team_id, namespace: key.namespace, blizzardRealmId: key.realmId, blizzardCharId: key.charId, renamed, classChanged },
  }, guard));
  const updateAt = statements.length;
  statements.push(guarded(
    `UPDATE characters SET name = ?, name_key = ?, class = ?, main_spec = ?, off_spec = ?, namespace = ?, blizzard_realm_id = ?, blizzard_char_id = ?, updated_at = ?
      WHERE id = ? AND guild_id = ? AND player_id = ?`,
    [row.name, row.name_key, row.class, mainSpec, offSpec, key.namespace, key.realmId, key.charId, now, current.id, guild.id, data.player.id],
  ));
  // In an in-game guild the character is on the roster now: it takes the core rank of its row (the same writer the roster sync uses). The guards make it a no-op
  // when the match did not apply or the guild is not (or no longer) in-game.
  if (sourceResult.results[0] && sourceResult.results[0].rank_source === 'ingame') {
    const applied = { sql: 'EXISTS (SELECT 1 FROM characters ac WHERE ac.id = ? AND ac.blizzard_char_id = ? AND ac.updated_at = ?)', params: [current.id, key.charId, now] };
    statements.push(...rankMapApplyStatements(db, { guildId: guild.id, now, timeZone: guild.time_zone }, [ingameGuard(guild.id), applied]));
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const kind = constraintOf(error);
    if (kind === 'identity_taken') throw new HttpError(409, 'identity_taken', 'Another character of this guild is already linked to that place on the roster.', { field: 'blizzardCharId' });
    if (kind === 'character_name') throw nameTaken(row.name, await findNameOwner(db, guild.id, row.name_key, old.realm_key));
    throw error;
  }
  if (!wrote(results[updateAt])) return characterMoved(ctx, guildContext, data.player.id, current.id);
  return jsonResponse(await personReply(ctx, guildContext, data.player.id));
}
