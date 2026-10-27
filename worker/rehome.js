// The re-home (user-hierarchy build, lane B6a part 2b; plan "Re-home (bnet beats link, collision, GM claim)"): ONE character leaves the person that holds it and
// joins another, WITHOUT the old person losing its history. Three triggers, one module: the Battle.net sign-in match ("Battle.net beats a link" and the name
// collision, worker/bnet-match.js) and the Guild Master's claim (lane B6b).
//
//   rehomeStatements(db, { guildId, characterId, toPersonId, actorUserId, now, reason: 'bnet_beats_link' | 'collision' | 'gm_claim', guards?, randomBytes?, toPlanned? })
//     -> { statements, appliedIndex, auditId, fromPersonId, toPersonId, placeholderId, wasMain }      or throws HttpError
//   statements ... for the caller's db.batch, in order (13 to 14). wrote(results[appliedIndex]) is true when the re-home applied and false when a guard refused it,
//                  in which case EVERY statement was a no-op. One read (a single statement) happens before; nothing is written by the function itself.
//   toPlanned .... { version, characters } when the new person is made or linked EARLIER IN THE SAME BATCH (the GM claim: the claimant may have no person yet): the read finds no
//                  such person (or the version it has now), so the caller says what the person will be when the opening statement runs. Left out, the read decides.
//   guards ....... [{ sql, params }] (anonymous `?` only) ANDed into the OPENING statement. The later statements ask for that statement's audit row instead of
//                  repeating the guards (a batch is one transaction), so a refused opening makes the whole batch a no-op.
//
// WHAT HAPPENS (in this order, one batch):
//   1. the audit row `character.rehome` (guarded: the character is still on the old person, both persons are at the versions just read, the new person has room
//      for one more VISIBLE character, the caller's guards) - its id is the marker of every later statement;
//   2. the old person's UPCOMING sign-ups naming the character go (raid_signups, standing_signups), and so do its seats in the published rosters of upcoming raids
//      (raid_roster); those raids are marked stale, and so are the raids of the character's team and the raids logging its name; its pending team request is
//      withdrawn (it asked for a place on a team as the old person's character);
//   3. the character moves. It becomes the new person's Main only when the new person has no VISIBLE Main (a retired placeholder Main steps down first, in the
//      same batch: the person must keep a Main the lists can see); a team the new person already has a character on is cleared (one character per team and
//      person); characters.updated_at stays; a moved character that goes teamless loses team_since by trigger (migration 0040);
//   4. when the old person has no Main left another visible character takes over (not yet Former first, best core rank, a team-less one last);
//   5. the old person ALWAYS gets a retired PLACEHOLDER (worker/character-visibility.js): Former (left_on = today in the guild's zone), Social, no identity key, no
//      team, hidden from every list and count; Main only when the person has no other Main left;
//   6. a dated character_name_aliases row maps the moved character's name_key + realm_key to the placeholder (renamed_at = now), so evidence dated on or before
//      now resolves to the placeholder - the old person - and evidence dated after it to the moved character - the new one. The aliases the moved character
//      already had follow the placeholder (older names of the old person's evidence);
//   7. both persons' versions move on.
// The old person is NEVER deleted (its attendance, decisions, away notices, intent picks, duties, loot stay on it). The new person's cap counts visible characters.
import { markRaidsStale, weekFreeze } from './attendance-store.js';
import { auditStatement } from './audit.js';
import { isPlaceholderKey, placeholderCharacterSql, placeholderKey, visibleCharacterSql } from './character-visibility.js';
import { HttpError } from './http.js';
import { defaultRandomBytes, newId } from './ids.js';
import { LIMITS } from './limits.js';
import { guildToday } from './roster-view.js';

export const REHOME_REASONS = Object.freeze(['bnet_beats_link', 'collision', 'gm_claim']);

const BY_PERSON = 'INDEXED BY characters_player';

// The character, both persons' versions, how many visible characters the new person holds, the aliases the character carries, the guild's zone. One statement.
const READ_SQL = `SELECT c.id, c.player_id, c.name, c.name_key, c.realm, c.realm_key, c.class, c.is_main, c.team_id,
       (SELECT p.version FROM players p WHERE p.id = c.player_id AND p.guild_id = c.guild_id) AS from_version,
       (SELECT p.version FROM players p WHERE p.id = ?3 AND p.guild_id = c.guild_id) AS to_version,
       (SELECT COUNT(*) FROM characters v ${BY_PERSON} WHERE v.guild_id = c.guild_id AND v.player_id = ?3 AND ${visibleCharacterSql('v')}) AS to_characters,
       (SELECT COUNT(*) FROM character_name_aliases a WHERE a.guild_id = c.guild_id AND a.character_id = c.id) AS aliases,
       (SELECT g.time_zone FROM guilds g WHERE g.id = c.guild_id) AS time_zone
  FROM characters c WHERE c.id = ?1 AND c.guild_id = ?2`;

const INSERT_PLACEHOLDER_SQL = `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at,
                        core_rank, left_on, left_reason, trial_start, trial_end, owner_proof, proof_user_id, proof_bnet_account_id, proof_at,
                        namespace, blizzard_realm_id, blizzard_char_id)
SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL,
       CASE WHEN EXISTS (SELECT 1 FROM characters m ${BY_PERSON} WHERE m.player_id = ? AND m.is_main = 1) THEN 0 ELSE 1 END, ?, ?,
       'social', ?, 'other', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
 WHERE `;

// -> { statements, ... } (see the header).
export async function rehomeStatements(db, {
  guildId, characterId, toPersonId, actorUserId, now, reason, guards = [], randomBytes = defaultRandomBytes, toPlanned = null,
}) {
  if (!REHOME_REASONS.includes(reason)) throw new Error('rehomeStatements: reason is bnet_beats_link, collision or gm_claim');
  const row = (await db.prepare(READ_SQL).bind(characterId, guildId, toPersonId).first()) || null;
  if (!row) throw new HttpError(404, 'not_found', 'That character was not found.');
  if (isPlaceholderKey(row.name_key)) throw new HttpError(400, 'bad_request', 'A retired placeholder is not moved.');
  const toVersion = toPlanned ? toPlanned.version : row.to_version;
  const toCharacters = toPlanned ? toPlanned.characters : row.to_characters;
  if (toVersion === null) throw new HttpError(404, 'not_found', 'That person was not found.');
  if (row.player_id === toPersonId) throw new HttpError(400, 'bad_request', 'That character already belongs to that person.');
  if (toCharacters >= LIMITS.charactersPerPerson) {
    throw new HttpError(409, 'rehome_too_many_characters', `That person already has ${toCharacters} characters, and a person can have at most ${LIMITS.charactersPerPerson}.`);
  }
  const from = row.player_id;
  const to = toPersonId;
  const wasMain = row.is_main === 1;
  const placeholderId = newId('c', randomBytes);
  const auditId = newId('al', randomBytes);
  const today = guildToday({ time_zone: row.time_zone }, now);

  // The opening guard.
  const opening = {
    sql: `EXISTS (SELECT 1 FROM characters WHERE id = ? AND guild_id = ? AND player_id = ?)
          AND EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND version = ?)
          AND EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND version = ?)
          AND (SELECT COUNT(*) FROM characters v ${BY_PERSON} WHERE v.guild_id = ? AND v.player_id = ? AND ${visibleCharacterSql('v')}) < ${LIMITS.charactersPerPerson}
          ${guards.map((guard) => `AND ${guard.sql}`).join(' ')}`,
    params: [characterId, guildId, from, from, guildId, row.from_version, to, guildId, toVersion, guildId, to, ...guards.flatMap((guard) => guard.params)],
  };
  // Every later statement: the opening applied.
  const marker = { sql: 'EXISTS (SELECT 1 FROM audit_log WHERE id = ?)', params: [auditId] };
  const guarded = (sql, params) => db.prepare(sql + ' AND ' + marker.sql).bind(...params, ...marker.params);
  const ctx = { db, randomBytes, now: () => now };

  const statements = [];
  statements.push(auditStatement(ctx, {
    id: auditId,
    guildId,
    actorUserId,
    action: 'character.rehome',
    entityType: 'character',
    entityId: characterId,
    before: { personId: from, teamId: row.team_id, wasMain },
    // (No placeholder id: the Activity view and its CSV hand `before` and `after` to the page, and a retired placeholder is never shown. The id is in the return value.)
    after: { personId: to, reason },
  }, opening));

  // 2. Upcoming sign-ups and published-roster seats that name the character leave; their raids, and the raids of its team and log lines, are stale. Its pending
  // team request is withdrawn. (The stale marking of the first statement reads the rows the next two delete.)
  const upcoming = 'SELECT id FROM raids WHERE guild_id = ? AND starts_at > ?';
  statements.push(guarded(
    `UPDATE raids SET policy_fp = '', version = version + 1
      WHERE guild_id = ? AND starts_at > ?
        AND (id IN (SELECT s.raid_id FROM raid_signups s WHERE s.player_id = ? AND s.character_id = ?)
             OR id IN (SELECT rr.raid_id FROM raid_roster rr WHERE rr.player_id = ? AND rr.name_key = ?))`,
    [guildId, now, from, characterId, from, row.name_key],
  ));
  statements.push(guarded(
    `DELETE FROM raid_signups WHERE player_id = ? AND character_id = ? AND guild_id = ? AND raid_id IN (${upcoming})`,
    [from, characterId, guildId, guildId, now],
  ));
  statements.push(guarded('DELETE FROM standing_signups WHERE guild_id = ? AND player_id = ? AND character_id = ?', [guildId, from, characterId]));
  statements.push(guarded(
    `DELETE FROM raid_roster WHERE guild_id = ? AND player_id = ? AND name_key = ? AND raid_id IN (${upcoming})`,
    [guildId, from, row.name_key, guildId, now],
  ));
  statements.push(guarded(
    "UPDATE team_requests SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE guild_id = ? AND character_id = ? AND status = 'pending'",
    [actorUserId ?? null, now, guildId, characterId],
  ));
  statements.push(markRaidsStale(db, guildId, [row.name_key], null, row.team_id ? [row.team_id] : [], marker, weekFreeze(row.time_zone, now)));

  // 3. The move. A retired placeholder that is the new person's Main steps down first (the unique Main index refuses two, and the person needs a Main the lists can
  // see): the triggers of migration 0036 act on INSERT only, a move is an UPDATE. Then the moved character is the Main exactly when the person has no VISIBLE Main.
  statements.push(guarded(
    `UPDATE characters INDEXED BY characters_player SET is_main = 0
      WHERE guild_id = ? AND player_id = ? AND is_main = 1 AND ${placeholderCharacterSql('characters')}
        AND NOT EXISTS (SELECT 1 FROM characters m ${BY_PERSON} WHERE m.player_id = ? AND m.is_main = 1 AND ${visibleCharacterSql('m')})`,
    [guildId, to, to],
  ));
  statements.push(guarded(
    `UPDATE characters SET player_id = ?,
            is_main = CASE WHEN EXISTS (SELECT 1 FROM characters m ${BY_PERSON} WHERE m.player_id = ? AND m.is_main = 1 AND ${visibleCharacterSql('m')}) THEN 0 ELSE 1 END,
            team_id = CASE WHEN team_id IS NOT NULL AND EXISTS (SELECT 1 FROM characters t ${BY_PERSON} WHERE t.player_id = ? AND t.team_id = characters.team_id)
                           THEN NULL ELSE team_id END
      WHERE id = ? AND guild_id = ? AND player_id = ?`,
    [to, to, to, characterId, guildId, from],
  ));

  // 4. The old person's Main. Always planned (it does nothing while the person has a Main): the character may have become the Main since it was read.
  statements.push(guarded(
    `UPDATE characters SET is_main = 1
      WHERE guild_id = ? AND id = (SELECT p.id FROM characters p ${BY_PERSON} WHERE p.guild_id = ? AND p.player_id = ? AND ${visibleCharacterSql('p')}
                                    ORDER BY p.left_on IS NOT NULL, CASE p.core_rank WHEN 'raider' THEN 0 WHEN 'trial' THEN 1 WHEN 'reserve' THEN 2 ELSE 3 END,
                                             p.team_id IS NULL, p.created_at, p.id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM characters m ${BY_PERSON} WHERE m.player_id = ? AND m.is_main = 1)`,
    [guildId, guildId, from, from],
  ));

  // 5. The placeholder.
  statements.push(db.prepare(INSERT_PLACEHOLDER_SQL + marker.sql).bind(
    placeholderId, guildId, from, row.name, placeholderKey(placeholderId), row.realm, row.realm_key, row.class, from, now, now, today, ...marker.params,
  ));

  // 6. The dated alias, and the older aliases of the moved character.
  statements.push(db.prepare(
    `INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at)
     SELECT 'na_' || lower(hex(randomblob(16))), ?, ?, ?, ?, ? WHERE ` + marker.sql,
  ).bind(guildId, placeholderId, row.name_key, row.realm_key, now, ...marker.params));
  if (row.aliases > 0) {
    statements.push(guarded('UPDATE character_name_aliases SET character_id = ? WHERE guild_id = ? AND character_id = ?', [placeholderId, guildId, characterId]));
  }

  // 7. Both persons moved on.
  statements.push(guarded('UPDATE players SET version = version + 1, updated_at = ? WHERE guild_id = ? AND id IN (?, ?)', [now, guildId, from, to]));

  return { statements, appliedIndex: 0, auditId, fromPersonId: from, toPersonId: to, placeholderId, wasMain };
}

// ---------------------------------------------------------------------------
// A name given up (the name collision at the sign-in match, "R holds a different key and that key is gone from the roster")

// A REAL character whose name a roster character now carries: it becomes Former (left_on = today when it was not), its live name_key becomes a reserved one
// (`~was:<id>`, still visible) and the name it carried goes to a dated alias, so the evidence it has keeps resolving to it and the name is free for the roster
// character. The caller passes what it READ about the character; every statement is guarded by it.
//   expected: { nameKey, realmKey, blizzardCharId: number | null }  the character as the caller saw it (the id is null for an unkeyed Former one)
//   -> [update, alias, audit, stale marking] for the caller's batch; wrote(results[0]) when it applied.
export function retireNameStatements(db, { guildId, characterId, expected, actorUserId, now, timeZone, guards = [], randomBytes = defaultRandomBytes, teamId = null }) {
  const today = guildToday({ time_zone: timeZone }, now);
  const key = `~was:${characterId}`;
  const guard = {
    sql: `EXISTS (SELECT 1 FROM characters c WHERE c.id = ? AND c.guild_id = ? AND c.name_key = ? AND c.realm_key = ? AND c.blizzard_char_id IS ?
                    AND (c.blizzard_char_id IS NULL OR NOT EXISTS (SELECT 1 FROM guild_roster g WHERE g.guild_id = c.guild_id AND g.namespace = c.namespace
                                                                      AND g.blizzard_realm_id = c.blizzard_realm_id AND g.blizzard_char_id = c.blizzard_char_id)))
          ${guards.map((entry) => `AND ${entry.sql}`).join(' ')}`,
    params: [characterId, guildId, expected.nameKey, expected.realmKey, expected.blizzardCharId ?? null, ...guards.flatMap((entry) => entry.params)],
  };
  const moved = { sql: 'EXISTS (SELECT 1 FROM characters WHERE id = ? AND guild_id = ? AND name_key = ?)', params: [characterId, guildId, key] };
  const ctx = { db, randomBytes, now: () => now };
  return [
    db.prepare(
      `UPDATE characters SET name_key = ?, left_on = COALESCE(left_on, ?), left_reason = COALESCE(left_reason, 'other')
        WHERE id = ? AND guild_id = ? AND ${guard.sql}`,
    ).bind(key, today, characterId, guildId, ...guard.params),
    db.prepare(
      `INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at)
       SELECT 'na_' || lower(hex(randomblob(16))), ?, ?, ?, ?, ? WHERE ` + moved.sql,
    ).bind(guildId, characterId, expected.nameKey, expected.realmKey, now, ...moved.params),
    auditStatement(ctx, {
      guildId, actorUserId, action: 'character.name_retire', entityType: 'character', entityId: characterId, before: { teamId }, after: { retired: true },
    }, moved),
    markRaidsStale(db, guildId, [expected.nameKey], null, teamId ? [teamId] : [], moved, weekFreeze(timeZone, now)),
  ];
}
