// Loot: awards imported from Gargul's Detailed (JSON) export onto a past raid, their tags and notes, and the four views
// (per raid, balance, by raid, by item, per person) plus the loot policy. Matching a winner to a person happens on read
// (loot-store.js). Rules: tasks/guild-phase4-spec.md.
import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isPlainObject, makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { displayCharacter, groupBy } from '../attendance-view.js';
import { collectRefs, describeRow } from '../audit-view.js';
import { isId, newId } from '../ids.js';
import { classifyAward, normalizedOf, parseEditedFields, readAwards } from '../loot-import.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { lootBalance } from '../loot-metrics.js';
import { DEFAULT_LOOT_POLICY, LOOT_TAGS, validateLootOverride } from '../loot-policy.js';
import {
  AWARD_SELECT, LOOT_LIST_CAP, awardView, lootAccess, lootPolicyRowsStatement, makeLootPolicyResolver, makeMatcher, matchStatements,
  ownPersonStatement, viewAwards,
} from '../loot-store.js';
import { isOwnPlayer } from '../membership.js';
import { announceLoot } from '../notify-run.js';
import { teamNotifyStatement } from '../notify-store.js';
import { allows, isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { allowsSurname, cleanCharacterName, nameKey, realmKey } from '../roster-data.js';
import { guildToday, viewerOf } from '../roster-view.js';
import { windowStartFor } from './attendance.js';
import { loadNames, parseJson } from './audit.js';
import { loadRaid } from './raids.js';
import { bad, errorText } from './roster.js';

// 500 awards of about 700 bytes at the most each.
export const LOOT_MAX_BODY = 512 * 1024;
const WRITE_CHUNK = 100;
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const MAX_NOTE = 200;

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const awardNotFound = () => new HttpError(404, 'not_found', 'That award does not exist.');

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------
// One raid: the list, the preview and the import

const raidAwardsStatement = (db, guildId, raidId) => db.prepare(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND a.raid_id = ?2 ORDER BY a.awarded_at, a.id`).bind(guildId, raidId);

export async function getRaidLoot(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  const [policyResult, awardResult, ownResult] = await db.batch([
    lootPolicyRowsStatement(db, guild.id),
    raidAwardsStatement(db, guild.id, raid.id),
    ownPersonStatement(db, guild.id, ctx.session.user.id),
  ]);
  const access = lootAccess(guildContext, makeLootPolicyResolver(policyResult.results), raid.team_id);
  if (access.level === 'none') throw forbidden();
  let awards = await viewAwards(db, guild.id, awardResult.results);
  if (access.level === 'own') {
    const ownId = ownResult.results.length ? ownResult.results[0].id : null;
    awards = awards.filter((award) => ownId !== null && award.match.personId === ownId);
  }
  return jsonResponse({ awards, canEdit: access.canEdit });
}

// What an import would do with each award: the cleaned awards, each classified against what the guild already holds and matched to a winner.
async function planImport(ctx, guildContext, raid, awards) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const checksums = JSON.stringify(awards.map((award) => award.checksum));
  const [existingResult, deletedResult, characterResult, guestResult] = await db.batch([
    db.prepare(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND a.checksum IN (SELECT value FROM json_each(?2))`).bind(guild.id, checksums),
    db.prepare('SELECT checksum, raid_id, deleted_at FROM loot_award_deletions WHERE guild_id = ?1 AND checksum IN (SELECT value FROM json_each(?2))').bind(guild.id, checksums),
    ...matchStatements(db, guild.id, awards.map((award) => award.nameKey)),
  ]);
  const existing = new Map(existingResult.results.map((row) => [row.checksum, row]));
  const tombstones = new Map(deletedResult.results.map((row) => [row.checksum, row]));
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  return awards.map((award) => {
    const stored = existing.get(award.checksum) || null;
    const classified = classifyAward(award, stored, raid, guild.time_zone, tombstones.get(award.checksum) || null);
    const matched = matcher({ winner_name_key: award.nameKey, winner_realm_key: award.realmKey, team_id: raid.team_id });
    return { award, stored, ...classified, matched };
  });
}

// The raid, the viewer's loot.edit on its team (403), a started raid (409): what a preview and an import both need.
async function loadImportTarget(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'loot.edit', raid.team_id)) throw forbidden();
  if (raid.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'That raid has not started yet. Import its loot afterwards.');
  return { guildContext, raid };
}

const countStatuses = (rows) => {
  const counts = { new: 0, update: 0, same: 0, otherRaid: 0, otherDay: 0, conflict: 0, deleted: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
};

export async function previewLoot(ctx) {
  const { guildContext, raid } = await loadImportTarget(ctx);
  const awards = readAwards(ctx.body.awards, guildContext.guild, await loadSurnameIndex(ctx.db, guildContext.guild));
  const rows = await planImport(ctx, guildContext, raid, awards);
  return jsonResponse({
    rows: rows.map((row) => ({
      ...normalizedOf(row.award), status: row.status, match: row.matched.match, tag: row.tag,
      ...(row.stored ? { awardId: row.stored.id } : {}),
      ...(row.status === 'conflict' ? { conflicts: row.conflicts } : {}),
      ...(row.status === 'deleted' ? { deleted: row.deleted } : {}),
    })),
    counts: countStatuses(rows),
  });
}

const INSERT_AWARDS = `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, source, checksum, item_id, item_name, item_quality, awarded_at,
    winner_name, winner_name_key, winner_realm, winner_realm_key, winner_class, roll_type, flags, tag, awarded_by, created_by, created_at, updated_at)
  SELECT json_extract(value, '$.id'), ?, ?, ?, 'gargul', json_extract(value, '$.checksum'), json_extract(value, '$.itemId'), json_extract(value, '$.itemName'),
         json_extract(value, '$.quality'), json_extract(value, '$.awardedAt'), json_extract(value, '$.name'), json_extract(value, '$.nameKey'),
         json_extract(value, '$.realm'), json_extract(value, '$.realmKey'), json_extract(value, '$.class'), json_extract(value, '$.rollType'),
         json_extract(value, '$.flags'), json_extract(value, '$.tag'), json_extract(value, '$.awardedBy'), ?, ?, ?
    FROM json_each(?)`;

// An officer's tag (tag_set_at) is never overwritten; the automatic one follows the award. The exception: an award that gains or loses
// its winner (Gargul edited it to or from a disenchant) takes the automatic tag again and forgets the officer's, because a no-winner award
// can only be DE. (SET expressions read the stored row, so `loot_awards.winner_name` below is the winner before this update.)
// The fields in $.edited (an officer's corrections: winner, item, raid) are not written. A conflict the officer resolved to the export has
// already left $.edited, and may carry $.moveRaidId / $.moveTeamId (an award an officer moved returns to the raid of the export).
// $.editedJson is the edited_fields the row ends with. Rows are found by checksum (unique in the guild): a moved award is on another raid.
const EDITED = (field) => `instr(json_extract(j.value, '$.edited'), '"${field}"') > 0`;
const WINNER_STATE_CHANGED = `(NOT (${EDITED('winner')}) AND (json_extract(j.value, '$.name') IS NULL) <> (loot_awards.winner_name IS NULL))`;
const keepOr = (field, column, value) => `${column} = CASE WHEN ${EDITED(field)} THEN loot_awards.${column} ELSE ${value} END`;
const UPDATE_AWARDS = `UPDATE loot_awards SET
    ${keepOr('item', 'item_id', "json_extract(j.value, '$.itemId')")}, ${keepOr('item', 'item_name', "json_extract(j.value, '$.itemName')")},
    ${keepOr('item', 'item_quality', "json_extract(j.value, '$.quality')")},
    awarded_at = json_extract(j.value, '$.awardedAt'),
    ${keepOr('winner', 'winner_name', "json_extract(j.value, '$.name')")}, ${keepOr('winner', 'winner_name_key', "json_extract(j.value, '$.nameKey')")},
    ${keepOr('winner', 'winner_realm', "json_extract(j.value, '$.realm')")}, ${keepOr('winner', 'winner_realm_key', "json_extract(j.value, '$.realmKey')")},
    ${keepOr('winner', 'winner_class', "json_extract(j.value, '$.class')")},
    roll_type = json_extract(j.value, '$.rollType'), flags = json_extract(j.value, '$.flags'), awarded_by = json_extract(j.value, '$.awardedBy'),
    tag = CASE WHEN loot_awards.tag_set_at IS NULL OR ${WINNER_STATE_CHANGED} THEN json_extract(j.value, '$.tag') ELSE loot_awards.tag END,
    tag_set_by = CASE WHEN ${WINNER_STATE_CHANGED} THEN NULL ELSE loot_awards.tag_set_by END,
    tag_set_at = CASE WHEN ${WINNER_STATE_CHANGED} THEN NULL ELSE loot_awards.tag_set_at END,
    raid_id = COALESCE(json_extract(j.value, '$.moveRaidId'), loot_awards.raid_id),
    team_id = COALESCE(json_extract(j.value, '$.moveTeamId'), loot_awards.team_id),
    edited_fields = json_extract(j.value, '$.editedJson'),
    updated_at = ?
  FROM json_each(?) j
  WHERE loot_awards.guild_id = ? AND loot_awards.checksum = json_extract(j.value, '$.checksum')`;

// The fields a write needs (flags as the JSON text that is stored).
const writeFields = (award) => ({
  checksum: award.checksum, itemId: award.itemId, itemName: award.itemName, quality: award.quality, awardedAt: award.awardedAt,
  name: award.winnerName, nameKey: award.nameKey, realm: award.storedRealm, realmKey: award.realmKey, class: award.winnerClass,
  rollType: award.rollType, flags: JSON.stringify(award.flags), awardedBy: award.awardedBy, tag: award.tag,
});

// resolutions: { [checksum]: 'officer' | 'export' } (default 'officer', the stored value stays). Anything else is a 400.
function readResolutions(value) {
  if (value === undefined || value === null) return new Map();
  if (!isPlainObject(value)) throw bad('resolutions must be an object of checksum -> "officer" or "export".', 'resolutions');
  const map = new Map();
  for (const [checksum, choice] of Object.entries(value)) {
    if (choice !== 'officer' && choice !== 'export') throw bad('A resolution is "officer" or "export".', 'resolutions');
    map.set(checksum, choice);
  }
  return map;
}

export async function commitLoot(ctx) {
  const { db, body } = ctx;
  const { guildContext, raid } = await loadImportTarget(ctx);
  const guild = guildContext.guild;
  if (body.includeOtherDay !== undefined && typeof body.includeOtherDay !== 'boolean') throw bad('includeOtherDay must be true or false.', 'includeOtherDay');
  const includeOtherDay = body.includeOtherDay === true;
  const resolutions = readResolutions(body.resolutions);
  const awards = readAwards(body.awards, guild, await loadSurnameIndex(db, guild));
  const rows = await planImport(ctx, guildContext, raid, awards);
  const choiceOf = (row) => resolutions.get(row.award.checksum) || 'officer';

  // 'export' on a conflict whose award sits on a team the viewer cannot edit would move it out of reach: that one stays the officer's.
  const exportConflict = (row) => row.status === 'conflict' && choiceOf(row) === 'export'
    && (!row.conflicts.some((conflict) => conflict.field === 'raid') || allows(guildContext.can, 'loot.edit', row.stored.team_id));
  const readded = rows.filter((row) => row.status === 'deleted' && choiceOf(row) === 'export');
  const toInsert = rows.filter((row) => row.status === 'new' || (row.status === 'otherDay' && includeOtherDay) || readded.includes(row));
  // Updates: plain updates, conflicts resolved to the export, and conflicts kept as the officer's whose other fields changed.
  const toUpdate = rows.filter((row) => row.status === 'update' || (row.status === 'conflict' && (exportConflict(row) || row.changed)));
  const exported = rows.filter(exportConflict);
  const result = {
    inserted: toInsert.length,
    updated: rows.filter((row) => row.status === 'update').length,
    unchanged: rows.filter((row) => row.status === 'same').length,
    skippedOtherRaid: rows.filter((row) => row.status === 'otherRaid').length,
    skippedOtherDay: includeOtherDay ? 0 : rows.filter((row) => row.status === 'otherDay').length,
    conflicts: { kept: rows.filter((row) => row.status === 'conflict').length - exported.length, exported: exported.length },
    deleted: { kept: rows.filter((row) => row.status === 'deleted').length - readded.length, readded: readded.length },
  };

  const now = ctx.now();
  const userId = ctx.session.user.id;
  const updateFields = (row) => {
    const fields = writeFields(row.award);
    const resolved = exportConflict(row) ? new Set(row.conflicts.map((conflict) => conflict.field)) : new Set();
    const edited = parseEditedFields(row.stored.edited_fields).filter((field) => !resolved.has(field));
    return {
      ...fields, edited: JSON.stringify(edited), editedJson: JSON.stringify(edited),
      ...(resolved.has('raid') ? { moveRaidId: raid.id, moveTeamId: raid.team_id } : {}),
    };
  };
  const statements = [];
  if (readded.length) {
    statements.push(db.prepare('DELETE FROM loot_award_deletions WHERE guild_id = ? AND checksum IN (SELECT value FROM json_each(?))')
      .bind(guild.id, JSON.stringify(readded.map((row) => row.award.checksum))));
  }
  for (const part of chunks(toInsert, WRITE_CHUNK)) {
    const json = JSON.stringify(part.map((row) => ({ id: newId('lo', ctx.randomBytes), ...writeFields(row.award) })));
    statements.push(db.prepare(INSERT_AWARDS).bind(guild.id, raid.id, raid.team_id, userId, now, now, json));
  }
  for (const part of chunks(toUpdate, WRITE_CHUNK)) {
    statements.push(db.prepare(UPDATE_AWARDS).bind(now, JSON.stringify(part.map(updateFields)), guild.id));
  }
  statements.push(auditStatement(ctx, {
    guildId: guild.id, actorUserId: userId, action: 'loot.import', entityType: 'raid', entityId: raid.id,
    after: { ...result, includeOtherDay },
  }));
  statements.push(teamNotifyStatement(db, raid.team_id)); // the team's Discord channel settings ride in the same round trip
  let written;
  try {
    written = await db.batch(statements);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'conflict', 'Someone else imported some of these awards. Reload and try again.');
    if (/FOREIGN KEY constraint failed/i.test(errorText(error))) throw new HttpError(404, 'not_found', 'That raid does not exist.');
    throw error;
  }
  // The team's Discord channel hears about the new awards when an officer set that up (a failed post never fails the import).
  await announceLoot(ctx, raid, toInsert.map((row) => ({ itemName: row.award.itemName, winnerName: row.award.winnerName, tag: row.award.tag })), written[written.length - 1].results[0] || null);
  const stored = await raidAwardsStatement(db, guild.id, raid.id).all();
  return jsonResponse({ ...result, awards: await viewAwards(db, guild.id, stored.results) });
}

// ---------------------------------------------------------------------------
// One award: tag, note, delete

async function loadAward(ctx, guildContext) {
  const row = await ctx.db.prepare(`${AWARD_SELECT} WHERE a.id = ? AND a.guild_id = ?`).bind(ctx.params.aid, guildContext.guild.id).first();
  if (!row) throw awardNotFound();
  if (!allows(guildContext.can, 'loot.edit', row.team_id)) throw forbidden();
  return row;
}

const AWARD_EDIT_KEYS = ['raidId', 'itemId', 'itemName', 'winnerName', 'winnerRealm', 'disenchanted'];
const MAX_ITEM_ID = 2147483647;
const staleAward = (current) => new HttpError(409, 'stale', 'Someone changed this award. Reload to see it.', { current });
const currentView = async (db, guildId, row) => (await viewAwards(db, guildId, [row]))[0];

// The winner a PATCH asks for: { name, nameKey, realm, realmKey } cleaned like an import's (character name rules, guild realm, Forever surname).
async function cleanWinner(ctx, guild, body) {
  const cleaned = cleanCharacterName(body.winnerName, guild.game_version);
  if (!cleaned) throw bad(allowsSurname(guild.game_version) ? 'The winner needs a character name (a first name and optional surname, 2 to 12 letters each).' : 'The winner needs a character name (2 to 12 letters).', 'winnerName');
  let realm = null;
  let key = '';
  if (guild.realm_kind !== 'ruleset') {
    if (body.winnerRealm !== undefined && body.winnerRealm !== null && typeof body.winnerRealm !== 'string') throw bad('The realm must be text.', 'winnerRealm');
    realm = (typeof body.winnerRealm === 'string' ? body.winnerRealm.trim() : '') || guild.realm;
    key = realmKey(realm);
    if (!key || Array.from(realm).length > 40) throw bad('The winner\'s realm is not valid.', 'winnerRealm');
  }
  const name = resolveName(await loadSurnameIndex(ctx.db, guild), cleaned, key);
  return { name, nameKey: nameKey(name), realm, realmKey: key };
}

// PATCH /loot/:aid { tag?, note?, winnerName? | disenchanted?: true, winnerRealm?, itemId?, itemName?, raidId?, updatedAt }
// A change to the winner / item / raid REQUIRES updatedAt (the award's version): another save since then is a 409 `stale`. A tag or note
// change may send it too and is then checked the same way. The changed fields join edited_fields (the import keeps them), and one
// loot.update audit row carries every before/after.
export async function patchLoot(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const award = await loadAward(ctx, guildContext);
  const hasTag = body.tag !== undefined;
  const hasNote = body.note !== undefined;
  const editsAward = AWARD_EDIT_KEYS.some((key) => body[key] !== undefined);
  if (!hasTag && !hasNote && !editsAward) throw bad('Send a tag, a note, or a change to the award.', 'tag');
  if (body.updatedAt !== undefined && !Number.isInteger(body.updatedAt)) throw bad('updatedAt is the number the award last showed.', 'updatedAt');
  if (editsAward && body.updatedAt === undefined) throw bad('Send the updatedAt you last saw.', 'updatedAt');
  if (body.updatedAt !== undefined && body.updatedAt !== award.updated_at) throw staleAward(await currentView(db, guild.id, award));
  if (hasTag && !(typeof body.tag === 'string' && LOOT_TAGS.includes(body.tag))) throw bad('Pick MS, OS, DE or BANK.', 'tag');
  if (body.disenchanted !== undefined && typeof body.disenchanted !== 'boolean') throw bad('disenchanted must be true or false.', 'disenchanted');
  const hasWinnerName = body.winnerName !== undefined && body.winnerName !== null && String(body.winnerName).trim() !== '';
  if (body.disenchanted === true && hasWinnerName) throw bad('Pick a winner or disenchant the item, not both.', 'winnerName');
  let note = null;
  if (hasNote && body.note !== null) note = cleanText(body.note, 'note', { min: 0, max: MAX_NOTE }) || null;

  // The winner.
  const wasDisenchanted = award.winner_name === null;
  let winner = { name: award.winner_name, nameKey: award.winner_name_key, realm: award.winner_realm, realmKey: award.winner_realm_key, class: award.winner_class };
  const changed = [];
  if (body.disenchanted === true) {
    if (!wasDisenchanted) { winner = { name: null, nameKey: null, realm: null, realmKey: '', class: null }; changed.push('winner'); }
  } else if (hasWinnerName) {
    const next = await cleanWinner(ctx, guild, body);
    if (next.nameKey !== award.winner_name_key || next.realmKey !== award.winner_realm_key) {
      winner = { ...next, class: null }; // the export's class belonged to the old winner; the roster character's class shows on read
      changed.push('winner');
    }
  } else if (body.winnerName !== undefined || (body.disenchanted === false && wasDisenchanted)) {
    throw bad('Pick the winner, or disenchant the item when nobody won it.', 'winnerName');
  }
  // The tag follows the winner: nobody won -> DE; a winner on a former DE award -> a non-DE tag (MS unless one is sent).
  const winnerStateChanged = (winner.name === null) !== wasDisenchanted;
  let tag = hasTag ? body.tag : award.tag;
  if (winner.name === null && tag !== 'DE') {
    if (hasTag) throw bad('A disenchanted item can only be tagged DE.', 'tag');
    tag = 'DE';
  }
  if (winner.name !== null && wasDisenchanted) {
    if (hasTag && body.tag === 'DE') throw bad('Give the new winner a tag other than DE.', 'tag');
    if (!hasTag) tag = 'MS';
  }
  const tagSet = hasTag || winnerStateChanged;

  // The item.
  let item = { id: award.item_id, name: award.item_name, quality: award.item_quality };
  if (body.itemName !== undefined && body.itemName !== null && typeof body.itemName !== 'string') throw bad('The item name must be text.', 'itemName');
  const itemName = body.itemName === undefined ? undefined : (cleanText(body.itemName, 'itemName', { min: 0, max: 100 }) || null);
  if (body.itemId !== undefined) {
    if (!Number.isInteger(body.itemId) || body.itemId < 1 || body.itemId > MAX_ITEM_ID) throw bad('Enter the item id (a number, or paste the Wowhead link).', 'itemId');
    if (body.itemId !== award.item_id) item = { id: body.itemId, name: itemName === undefined ? null : itemName, quality: null };
    else if (itemName !== undefined) item.name = itemName;
  } else if (itemName !== undefined) item.name = itemName;
  if (item.id !== award.item_id || item.name !== award.item_name) changed.push('item');

  // The raid (and with it the team).
  let raidId = award.raid_id;
  let teamId = award.team_id;
  if (body.raidId !== undefined) {
    if (!isId('r', body.raidId)) throw bad('Pick a raid.', 'raidId');
    if (body.raidId !== award.raid_id) {
      const target = await db.prepare('SELECT id, team_id, starts_at FROM raids WHERE id = ? AND guild_id = ?').bind(body.raidId, guild.id).first();
      if (!target) throw new HttpError(404, 'not_found', 'That raid does not exist.', { field: 'raidId' });
      if (!allows(guildContext.can, 'loot.edit', target.team_id)) throw forbidden();
      if (target.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'That raid has not started yet. Move the award afterwards.');
      raidId = target.id;
      teamId = target.team_id;
      changed.push('raid');
    }
  }

  if (tag !== award.tag) changed.push('tag');
  if (hasNote) changed.push('note');
  const fieldsChanged = ['winner', 'item', 'raid'].filter((field) => changed.includes(field));
  if (!changed.length && !hasTag) return jsonResponse({ award: await currentView(db, guild.id, award) }); // nothing differs: no write
  const edited = [...new Set([...parseEditedFields(award.edited_fields), ...fieldsChanged])];
  const now = ctx.now();
  const userId = ctx.session.user.id;
  const results = await db.batch([
    // A tag set by hand records who and when (the import then leaves it alone); a note change leaves the tag fields untouched.
    db.prepare(
      `UPDATE loot_awards SET
         raid_id = ?1, team_id = ?2, item_id = ?3, item_name = ?4, item_quality = ?5,
         winner_name = ?6, winner_name_key = ?7, winner_realm = ?8, winner_realm_key = ?9, winner_class = ?10,
         tag = ?11,
         tag_set_by = CASE WHEN ?12 = 1 THEN ?13 ELSE tag_set_by END,
         tag_set_at = CASE WHEN ?12 = 1 THEN ?14 ELSE tag_set_at END,
         note = CASE WHEN ?15 = 1 THEN ?16 ELSE note END,
         edited_fields = ?17,
         edited_by = CASE WHEN ?18 = 1 THEN ?13 ELSE edited_by END,
         edited_at = CASE WHEN ?18 = 1 THEN ?14 ELSE edited_at END,
         updated_at = ?19
       WHERE id = ?20 AND guild_id = ?21 AND updated_at = ?22`,
    ).bind(
      raidId, teamId, item.id, item.name, item.quality, winner.name, winner.nameKey, winner.realm, winner.realmKey, winner.class,
      tag, tagSet ? 1 : 0, userId, now, hasNote ? 1 : 0, note, JSON.stringify(edited), fieldsChanged.length ? 1 : 0, now,
      award.id, guild.id, award.updated_at,
    ),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: userId, action: 'loot.update', entityType: 'loot', entityId: award.id,
      // Ids, the tag and which fields changed; a character name or item only when that field itself was edited (the history sentence needs the old and new).
      before: {
        raidId: award.raid_id, teamId: award.team_id, tag: award.tag, tagSetBy: award.tag_set_at === null ? null : 'officer',
        ...(changed.includes('winner') ? { winnerName: award.winner_name } : {}),
        ...(changed.includes('item') ? { itemId: award.item_id, itemName: award.item_name } : {}),
      },
      after: {
        raidId, teamId, tag, tagSetBy: tagSet || award.tag_set_at !== null ? 'officer' : null, noteChanged: hasNote, changed,
        ...(changed.includes('winner') ? { winnerName: winner.name } : {}),
        ...(changed.includes('item') ? { itemId: item.id, itemName: item.name } : {}),
      },
    }, CHANGED_ONE),
  ]);
  const fresh = await db.prepare(`${AWARD_SELECT} WHERE a.id = ? AND a.guild_id = ?`).bind(award.id, guild.id).first();
  if (!fresh) throw awardNotFound();
  if (results[0].meta.changes !== 1) throw staleAward(await currentView(db, guild.id, fresh));
  return jsonResponse({ award: await currentView(db, guild.id, fresh) });
}

// DELETE /loot/:aid. A Gargul award leaves a tombstone (loot_award_deletions) in the same batch, so a re-import asks before it comes back.
export async function deleteLoot(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const award = await loadAward(ctx, guildContext);
  const now = ctx.now();
  const results = await db.batch([
    db.prepare(
      `INSERT OR REPLACE INTO loot_award_deletions (guild_id, checksum, raid_id, team_id, item_id, winner_name, deleted_by, deleted_at)
       SELECT guild_id, checksum, raid_id, team_id, item_id, winner_name, ?3, ?4 FROM loot_awards WHERE id = ?1 AND guild_id = ?2 AND manual = 0`,
    ).bind(award.id, guild.id, ctx.session.user.id, now),
    db.prepare('DELETE FROM loot_awards WHERE id = ? AND guild_id = ?').bind(award.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'loot.delete', entityType: 'loot', entityId: award.id,
      before: { raidId: award.raid_id, itemId: award.item_id, tag: award.tag },
    }, CHANGED_ONE),
  ]);
  if (results[1].meta.changes !== 1) throw awardNotFound();
  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Team views: balance, by raid, by item

// The statements every team view reads, then `extra`. -> the parsed results, the access, the matcher.
async function loadTeamLoot(ctx, extra = () => []) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const params = new URL(ctx.request.url).searchParams;
  const teamId = params.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const bind = (sql) => db.prepare(sql).bind(guild.id, teamId);
  const results = await db.batch([
    db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guild.id),
    lootPolicyRowsStatement(db, guild.id),
    ownPersonStatement(db, guild.id, ctx.session.user.id),
    ...extra(bind, db, guild),
  ]);
  const team = results[0].results[0];
  if (!team) throw bad('That team does not exist in this guild.', 'team');
  const resolver = makeLootPolicyResolver(results[1].results);
  return {
    guildContext, guild, params, team, resolver, access: lootAccess(guildContext, resolver, team.id),
    ownPersonId: results[2].results.length ? results[2].results[0].id : null, rest: results.slice(3),
  };
}

// The newest awards of the team, the characters their winners belong to, and the guests: the matcher's input.
const teamAwardStatements = (bind, db, guild) => [
  bind(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND a.team_id = ?2 ORDER BY a.awarded_at DESC, a.id LIMIT ${LOOT_LIST_CAP}`),
  bind(`SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN
          (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT winner_name_key FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2))`),
  db.prepare('SELECT name_key, realm_key FROM attendance_guests WHERE guild_id = ?').bind(guild.id),
];

// The awards the viewer may see with their match: everything for 'full', only the viewer's own person's for 'own'.
function visibleAwards(loaded, awardResult, characterResult, guestResult) {
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  const awards = awardResult.results.map((row) => ({ row, matched: matcher(row) }));
  if (loaded.access.level === 'full') return awards;
  return awards.filter((entry) => loaded.ownPersonId !== null && entry.matched.match.personId === loaded.ownPersonId);
}

const readWeeks = (params, policy) => {
  const raw = params.get('weeks');
  if (raw === null || raw === '') return policy.window.defaultWeeks;
  const weeks = Number(raw);
  if (!Number.isInteger(weeks) || !policy.window.switchWeeks.includes(weeks)) throw bad('Pick one of the offered windows.', 'weeks');
  return weeks;
};

// Standings: an editor of the team always, everyone else only when the team's loot rules switch visibility.standings on.
const canSeeStandings = (loaded) => loaded.access.canEdit || loaded.resolver.resolved(loaded.team.id).visibility.standings === true;
// Item lookup, the same way (visibility.itemLookup).
const canLookUpItems = (loaded) => loaded.access.canEdit || loaded.resolver.resolved(loaded.team.id).visibility.itemLookup === true;

const balanceStatements = (bind, db, guild) => [
    policyRowsStatement(db, guild.id),
    bind('SELECT id, raid_on FROM raids WHERE guild_id = ?1 AND team_id = ?2'),
    bind('SELECT raid_id, player_id, outcome, attended, credit FROM attendance WHERE guild_id = ?1 AND team_id = ?2'),
    bind(`SELECT p.id, p.status FROM players p WHERE p.guild_id = ?1
            AND p.id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`),
    bind(`SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1
            AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`),
    bind('SELECT raid_id, tag, winner_name_key, winner_realm_key FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2 AND winner_name_key IS NOT NULL'),
];

export async function getBalance(ctx) {
  const loaded = await loadTeamLoot(ctx, balanceStatements);
  const { guildContext, team, access } = loaded;
  // Under "own loot only" a viewer sees their row and the team average, so they must be on the team.
  if (access.level === 'none' || (access.level === 'own' && !allows(guildContext.can, 'loot.view', team.id))) throw forbidden();
  if (!canSeeStandings(loaded)) throw forbidden();
  return jsonResponse(buildBalance(ctx, loaded, loaded.rest));
}

// The balance payload of a loaded team (the statements of balanceStatements, in order, as `rest`).
function buildBalance(ctx, loaded, rest) {
  const { guild, team, access } = loaded;
  const [attendancePolicyResult, raidResult, rowResult, peopleResult, characterResult, awardResult] = rest;
  const attendanceResolver = makePolicyResolver(guild, attendancePolicyResult.results);
  const attendancePolicy = attendanceResolver.resolved(team.id);
  const weeks = readWeeks(loaded.params, attendancePolicy);
  const today = guildToday(guild, ctx.now());
  const windowStart = windowStartFor(today, attendanceResolver.resetDay(), weeks);
  const policy = loaded.resolver.resolved(team.id);

  const charactersByPlayer = groupBy(characterResult.results, 'player_id');
  const personOfKey = new Map(characterResult.results.map((row) => [`${row.name_key}|${row.realm_key}`, row.player_id]));
  const people = peopleResult.results.map((row) => {
    const character = displayCharacter(charactersByPlayer.get(row.id) || [], team.id);
    return { id: row.id, name: character ? character.name : 'Unknown', class: character ? character.class : null, status: row.status };
  });
  const awards = awardResult.results
    .map((row) => ({ raidId: row.raid_id, tag: row.tag, personId: personOfKey.get(`${row.winner_name_key}|${row.winner_realm_key}`) }))
    .filter((award) => award.personId !== undefined);
  const balance = lootBalance({
    people,
    raids: raidResult.results.map((row) => ({ id: row.id, raidOn: row.raid_on })),
    rows: rowResult.results.map((row) => ({ raidId: row.raid_id, playerId: row.player_id, outcome: row.outcome, attended: row.attended, credit: row.credit })),
    awards,
    countTags: policy.balance.countTags,
    windowStart,
    today,
  });
  const own = access.level === 'own';
  return {
    team: { id: team.id, name: team.name },
    window: { weeks, switchWeeks: attendancePolicy.window.switchWeeks, from: windowStart },
    mode: policy.balance.mode,
    countTags: policy.balance.countTags,
    scope: own ? 'own' : 'team',
    // `isMe` marks the viewer's own row: the page pins it first ("You").
    people: (own ? balance.people.filter((person) => person.personId === loaded.ownPersonId) : balance.people)
      .map((person) => ({ ...person, isMe: loaded.ownPersonId !== null && person.personId === loaded.ownPersonId })),
    teamAverage: balance.teamAverage,
  };
}

export async function getLootRaids(ctx) {
  const loaded = await loadTeamLoot(ctx, (bind, db, guild) => [
    ...teamAwardStatements(bind, db, guild),
    bind(`SELECT id, raid_on, title, event_title, zone FROM raids WHERE guild_id = ?1 AND team_id = ?2
            AND id IN (SELECT raid_id FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2)`),
  ]);
  if (loaded.access.level === 'none') throw forbidden();
  const [awardResult, characterResult, guestResult, raidResult] = loaded.rest;
  const countTags = loaded.resolver.resolved(loaded.team.id).balance.countTags;
  const byRaid = new Map();
  for (const entry of visibleAwards(loaded, awardResult, characterResult, guestResult)) {
    if (!byRaid.has(entry.row.raid_id)) byRaid.set(entry.row.raid_id, []);
    byRaid.get(entry.row.raid_id).push(entry);
  }
  const raids = raidResult.results.flatMap((raid) => {
    const entries = byRaid.get(raid.id) || [];
    if (!entries.length) return [];
    return [{
      raidId: raid.id,
      raidOn: raid.raid_on,
      title: raid.title || raid.event_title || null,
      zone: raid.zone,
      awards: entries.length,
      counted: entries.filter((entry) => entry.matched.match.kind === 'character' && countTags.includes(entry.row.tag)).length,
      unmatched: entries.filter((entry) => entry.matched.match.kind === 'unmatched').length,
      disenchanted: entries.filter((entry) => entry.matched.match.kind === 'disenchanted').length,
    }];
  }).sort((a, b) => (a.raidOn < b.raidOn ? 1 : a.raidOn > b.raidOn ? -1 : a.raidId.localeCompare(b.raidId)));
  return jsonResponse({ raids });
}

export async function getLootItems(ctx) {
  const loaded = await loadTeamLoot(ctx, teamAwardStatements);
  if (loaded.access.level === 'none') throw forbidden();
  const [awardResult, characterResult, guestResult] = loaded.rest;
  const items = new Map(); // the awards arrive newest first, so the groups do too
  for (const { row, matched } of visibleAwards(loaded, awardResult, characterResult, guestResult)) {
    if (!items.has(row.item_id)) {
      items.set(row.item_id, { itemId: row.item_id, itemName: null, quality: null, count: 0, lastAwardedAt: row.awarded_at, awards: [] });
    }
    const item = items.get(row.item_id);
    item.count++;
    if (item.itemName === null && row.item_name !== null) item.itemName = row.item_name;
    if (item.quality === null && row.item_quality !== null) item.quality = row.item_quality;
    // The winner and the tag's origin ride along (beyond the spec's list): a guest or a name the roster does not know has no person in
    // `match`, so the By item list could not name them otherwise.
    item.awards.push({
      id: row.id, raidId: row.raid_id, raidOn: row.raid_on, awardedAt: row.awarded_at, tag: row.tag, tagSetBy: row.tag_set_at === null ? null : 'officer',
      winner: { name: row.winner_name, realm: row.winner_realm, class: row.winner_class || matched.characterClass }, match: matched.match,
    });
  }
  return jsonResponse({ items: [...items.values()] });
}

// ---------------------------------------------------------------------------
// One person

export async function getPersonLoot(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const personId = ctx.params.pid;
  const bind = (sql) => db.prepare(sql).bind(guild.id, personId);
  const [playerResult, characterResult, awardResult, policyResult, guestResult] = await db.batch([
    bind('SELECT id, status, discord_user_id, user_id FROM players WHERE guild_id = ?1 AND id = ?2'),
    bind('SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id = ?2'),
    bind(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.player_id = ?2
            AND c.name_key = a.winner_name_key AND c.realm_key = a.winner_realm_key) ORDER BY a.awarded_at DESC, a.id LIMIT ${LOOT_LIST_CAP}`),
    lootPolicyRowsStatement(db, guild.id),
    db.prepare('SELECT name_key, realm_key FROM attendance_guests WHERE guild_id = ?').bind(guild.id),
  ]);
  const player = playerResult.results[0];
  if (!player) throw new HttpError(404, 'not_found', 'That person was not found.');
  const resolver = makeLootPolicyResolver(policyResult.results);
  const isMe = isOwnPlayer(player, viewerOf(ctx));
  // Someone else's loot is shown per team, where the viewer may see the whole team.
  const teamIds = new Set([...characterResult.results.map((row) => row.team_id), ...awardResult.results.map((row) => row.team_id)]);
  const visibleTeams = new Set([...teamIds].filter((teamId) => lootAccess(guildContext, resolver, teamId).level === 'full'));
  if (!isMe && !visibleTeams.size) throw forbidden();
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  const awards = awardResult.results.filter((row) => isMe || visibleTeams.has(row.team_id)).map((row) => awardView(row, matcher(row)));
  const totals = Object.fromEntries(LOOT_TAGS.map((tag) => [tag, awards.filter((award) => award.tag === tag).length]));
  const home = displayCharacter(characterResult.results, null);
  return jsonResponse({ person: { id: player.id, name: home ? home.name : 'Unknown', class: home ? home.class : null, status: player.status, isMe }, awards, totals });
}

// ---------------------------------------------------------------------------
// Loot page (redesign): hub, one item, one award record, Needs fixing

const HUB_NIGHTS = 3;
const HUB_STANDINGS = 5;
const FIX_DISMISS_KIND = 'loot_dupe';
const dupeKey = (raidId, itemId, winnerKey) => `loot-dupe:${raidId}:${itemId}:${winnerKey}`;
const raidSummary = (raid) => ({ id: raid.id, raidOn: raid.raid_on, title: raid.title || raid.event_title || null, zone: raid.zone });

// The dismissals of "Keep both" for a team (attention_dismissals rows of kind loot_dupe): a statement bound to (guild, team).
const dupeDismissalsStatement = (bind) => bind(`SELECT item_id FROM attention_dismissals WHERE guild_id = ?1 AND kind = '${FIX_DISMISS_KIND}' AND team_id = ?2`);

// entries: [{ row, matched }] of one team. -> { duplicates, unknown } for Needs fixing.
//   duplicates: the same raid + item id + winner key (winner not null) on 2 or more awards, unless dismissed with "Keep both".
//   unknown: a winner with no roster character and no guest (match.kind 'unmatched').
function findFixes(entries, dismissedKeys) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.row.winner_name_key === null) continue;
    const key = dupeKey(entry.row.raid_id, entry.row.item_id, entry.row.winner_name_key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const duplicates = [...groups.entries()]
    .filter(([key, list]) => list.length > 1 && !dismissedKeys.has(key))
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => a.row.awarded_at - b.row.awarded_at || a.row.id.localeCompare(b.row.id));
      const first = sorted[0].row;
      return {
        key, raidId: first.raid_id, raidOn: first.raid_on, itemId: first.item_id, itemName: sorted.map((e) => e.row.item_name).find((n) => n) || null,
        winnerKey: first.winner_name_key, winnerName: first.winner_name, awards: sorted.map((e) => awardView(e.row, e.matched)),
      };
    })
    .sort((a, b) => (a.raidOn < b.raidOn ? 1 : a.raidOn > b.raidOn ? -1 : a.key.localeCompare(b.key)));
  const unknown = entries.filter((entry) => entry.matched.match.kind === 'unmatched')
    .sort((a, b) => b.row.awarded_at - a.row.awarded_at || a.row.id.localeCompare(b.row.id)).map((e) => awardView(e.row, e.matched));
  return { duplicates, unknown };
}

const raidsWithAwardsStatement = (bind) => bind(`SELECT id, raid_on, title, event_title, zone FROM raids WHERE guild_id = ?1 AND team_id = ?2
            AND id IN (SELECT raid_id FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2)`);

// GET /loot/hub?team=  -> { team, can: { edit, rules, standings, itemLookup }, me, nights, standingsTop, fix }
//   me: { personId, totals: { MS, OS, DE, BANK }, byNight: [{ raid, awards }] } | null (the viewer has no person); every award to the viewer's person on this team, newest night first.
//   nights: the latest 3 nights with loot, [{ raid: { id, raidOn, title, zone }, awards: [award view] }], awards filtered to the viewer's level.
//   standingsTop: the first 5 rows of the balance (isMe marks the viewer's) or null when the viewer may not see standings.
//   fix: { duplicates, unknown } (counts) for an editor, else null.
export async function getLootHub(ctx) {
  const loaded = await loadTeamLoot(ctx, (bind, db, guild) => [
    ...teamAwardStatements(bind, db, guild),
    raidsWithAwardsStatement(bind),
    dupeDismissalsStatement(bind),
  ]);
  const { guildContext, guild, team, access } = loaded;
  if (access.level === 'none') throw forbidden();
  const [awardResult, characterResult, guestResult, raidResult, dismissalResult] = loaded.rest;
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  const entries = awardResult.results.map((row) => ({ row, matched: matcher(row) }));
  const visible = access.level === 'full' ? entries : entries.filter((entry) => loaded.ownPersonId !== null && entry.matched.match.personId === loaded.ownPersonId);
  const raids = [...raidResult.results].sort((a, b) => (a.raid_on < b.raid_on ? 1 : a.raid_on > b.raid_on ? -1 : a.id.localeCompare(b.id)));
  const groupByRaid = (list) => {
    const byRaid = new Map();
    for (const entry of list) {
      if (!byRaid.has(entry.row.raid_id)) byRaid.set(entry.row.raid_id, []);
      byRaid.get(entry.row.raid_id).push(entry);
    }
    return byRaid;
  };
  const nightsOf = (list) => {
    const byRaid = groupByRaid(list);
    return raids.filter((raid) => byRaid.has(raid.id)).map((raid) => ({
      raid: raidSummary(raid),
      awards: byRaid.get(raid.id).sort((a, b) => a.row.awarded_at - b.row.awarded_at || a.row.id.localeCompare(b.row.id)).map((e) => awardView(e.row, e.matched)),
    }));
  };

  const can = {
    edit: access.canEdit,
    rules: isGranted(guildContext.can['loot.policy']),
    standings: canSeeStandings(loaded),
    itemLookup: canLookUpItems(loaded),
  };
  let me = null;
  if (loaded.ownPersonId !== null) {
    const mine = entries.filter((entry) => entry.matched.match.personId === loaded.ownPersonId);
    const byNight = nightsOf(mine);
    const awards = byNight.flatMap((night) => night.awards);
    me = { personId: loaded.ownPersonId, totals: Object.fromEntries(LOOT_TAGS.map((tag) => [tag, awards.filter((award) => award.tag === tag).length])), byNight };
  }
  let standingsTop = null;
  if (can.standings && !(access.level === 'own' && !allows(guildContext.can, 'loot.view', team.id))) {
    const bind = (sql) => ctx.db.prepare(sql).bind(guild.id, team.id);
    const balanceResults = await ctx.db.batch(balanceStatements(bind, ctx.db, guild));
    standingsTop = buildBalance(ctx, loaded, balanceResults).people.slice(0, HUB_STANDINGS);
  }
  let fix = null;
  if (access.canEdit) {
    const found = findFixes(entries, new Set(dismissalResult.results.map((row) => row.item_id)));
    fix = { duplicates: found.duplicates.length, unknown: found.unknown.length };
  }
  return jsonResponse({ team: { id: team.id, name: team.name }, can, me, nights: nightsOf(visible).slice(0, HUB_NIGHTS), standingsTop, fix });
}

// GET /loot/items/:lootitem?team=  -> { team, item: { itemId, itemName, quality }, counts: { total, MS, OS, DE, BANK }, drops: [award view + raidTitle] }
// An editor of the team, or anyone with loot access when the team's rules switch visibility.itemLookup on; level 'own' sees only their own drops.
// 404 when there is nothing to show (no drops of that item on the team, or none of the viewer's own).
export async function getLootItem(ctx) {
  const itemId = Number(ctx.params.lootitem);
  if (!Number.isInteger(itemId) || itemId < 1 || itemId > MAX_ITEM_ID) throw bad('That is not an item id.', 'itemId');
  const teamParam = new URL(ctx.request.url).searchParams.get('team');
  const loaded = await loadTeamLoot(ctx, (bind, db, guild) => [
    db.prepare(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND a.team_id = ?2 AND a.item_id = ?3 ORDER BY a.awarded_at DESC, a.id LIMIT ?4`).bind(guild.id, teamParam, itemId, LOOT_LIST_CAP),
    db.prepare(
      `SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN
         (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT winner_name_key FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2 AND item_id = ?3))`,
    ).bind(guild.id, teamParam, itemId),
    db.prepare('SELECT name_key, realm_key FROM attendance_guests WHERE guild_id = ?').bind(guild.id),
    db.prepare(`SELECT id, raid_on, title, event_title, zone FROM raids WHERE guild_id = ?1 AND id IN (SELECT raid_id FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2 AND item_id = ?3)`)
      .bind(guild.id, teamParam, itemId),
  ]);
  if (loaded.access.level === 'none' || !canLookUpItems(loaded)) throw forbidden();
  const [awardResult, characterResult, guestResult, raidResult] = loaded.rest;
  const raids = new Map(raidResult.results.map((raid) => [raid.id, raid]));
  const drops = visibleAwards(loaded, awardResult, characterResult, guestResult).map(({ row, matched }) => {
    const raid = raids.get(row.raid_id);
    return { ...awardView(row, matched), raidTitle: raid ? raid.title || raid.event_title || null : null };
  });
  if (!drops.length) throw new HttpError(404, 'not_found', 'Nobody has received that item yet.');
  const counts = { total: drops.length, ...Object.fromEntries(LOOT_TAGS.map((tag) => [tag, drops.filter((drop) => drop.tag === tag).length])) };
  return jsonResponse({
    team: { id: loaded.team.id, name: loaded.team.name },
    item: { itemId, itemName: drops.map((drop) => drop.itemName).find((name) => name) || null, quality: drops.map((drop) => drop.quality).find((q) => q !== null) ?? null },
    counts,
    drops,
  });
}

// GET /loot/a/:aid  -> { award, raid, origin, history, canEdit: true }   (loot.edit on the award's team, else 403)
//   raid: { id, raidOn, title, zone, teamId, teamName }; origin: { kind: 'gargul' | 'manual', at, by, awardedBy, text };
//   history: this award's audit rows newest first, [{ id, at, by: { id, displayName } | null, action, text }] (text from audit-view.js, e.g. "Winner changed from Drenna to Healthas").
export async function getLootAward(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const row = await loadAward(ctx, guildContext);
  const [raidResult, teamResult, auditResult] = await db.batch([
    db.prepare('SELECT id, raid_on, title, event_title, zone, team_id FROM raids WHERE id = ? AND guild_id = ?').bind(row.raid_id, guild.id),
    db.prepare('SELECT id, name, archived FROM teams WHERE guild_id = ?').bind(guild.id),
    db.prepare(
      `SELECT id, actor_user_id, action, entity_type, entity_id, before, after, created_at FROM audit_log
        WHERE guild_id = ?1 AND entity_type = 'loot' AND entity_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 50`,
    ).bind(guild.id, row.id),
  ]);
  const raid = raidResult.results[0];
  const parsed = auditResult.results.map((entry) => ({
    id: entry.id, at: entry.created_at, actor: entry.actor_user_id, action: entry.action, entityType: entry.entity_type, entityId: entry.entity_id,
    before: parseJson(entry.before), after: parseJson(entry.after),
  }));
  const names = await loadNames(db, guild.id, collectRefs([...parsed, { actor: row.created_by, entityType: null, entityId: null, before: null, after: null }]), teamResult.results);
  const team = teamResult.results.find((entry) => entry.id === row.team_id);
  const createdBy = row.created_by && names.users.has(row.created_by) ? names.users.get(row.created_by) : null;
  const origin = row.manual === 1
    ? { kind: 'manual', at: row.created_at, by: createdBy, awardedBy: row.awarded_by, text: `Added by hand${createdBy ? ` by ${createdBy}` : ''}` }
    : { kind: 'gargul', at: row.created_at, by: createdBy, awardedBy: row.awarded_by, text: `Imported from Gargul${row.awarded_by ? ` (awarded by ${row.awarded_by})` : ''}` };
  const history = parsed.map((entry) => ({
    id: entry.id, at: entry.at, action: entry.action, text: describeRow(entry, names),
    by: entry.actor && names.users.has(entry.actor) ? { id: entry.actor, displayName: names.users.get(entry.actor) } : null,
  }));
  return jsonResponse({
    award: (await viewAwards(db, guild.id, [row]))[0],
    raid: { ...(raid ? raidSummary(raid) : { id: row.raid_id, raidOn: row.raid_on, title: null, zone: null }), teamId: row.team_id, teamName: team ? team.name : null },
    origin,
    history,
    canEdit: true,
  });
}

// GET /loot/fix?team=  -> { team, duplicates: [{ key, raidId, raidOn, itemId, itemName, winnerKey, winnerName, awards }], unknown: [award view] }   (loot.edit on the team, else 403)
export async function getLootFix(ctx) {
  const loaded = await loadTeamLoot(ctx, (bind, db, guild) => [...teamAwardStatements(bind, db, guild), dupeDismissalsStatement(bind)]);
  if (!loaded.access.canEdit) throw forbidden();
  const [awardResult, characterResult, guestResult, dismissalResult] = loaded.rest;
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  const entries = awardResult.results.map((row) => ({ row, matched: matcher(row) }));
  const found = findFixes(entries, new Set(dismissalResult.results.map((row) => row.item_id)));
  return jsonResponse({ team: { id: loaded.team.id, name: loaded.team.name }, ...found });
}

// POST /loot/fix/keep { raidId, itemId, winnerKey }  -> { ok: true, key }. "Keep both" on a possible duplicate: the group stays out of Needs fixing.
// Stored in attention_dismissals (shared by every officer) as item 'loot-dupe:<raid_id>:<item_id>:<winner_name_key>', kind loot_dupe.
export async function postLootFixKeep(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  if (!isId('r', body.raidId)) throw bad('Pick a raid.', 'raidId');
  if (!Number.isInteger(body.itemId) || body.itemId < 1 || body.itemId > MAX_ITEM_ID) throw bad('Send the item id.', 'itemId');
  if (typeof body.winnerKey !== 'string' || !body.winnerKey || body.winnerKey.length > 64) throw bad('Send the winner key.', 'winnerKey');
  const raid = await db.prepare('SELECT id, team_id FROM raids WHERE id = ? AND guild_id = ?').bind(body.raidId, guild.id).first();
  if (!raid) throw new HttpError(404, 'not_found', 'That raid does not exist.');
  if (!allows(guildContext.can, 'loot.edit', raid.team_id)) throw forbidden();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM loot_awards WHERE guild_id = ? AND raid_id = ? AND item_id = ? AND winner_name_key = ?')
    .bind(guild.id, raid.id, body.itemId, body.winnerKey).first();
  if (!count || count.n < 2) throw new HttpError(404, 'not_found', 'That is not a possible duplicate.');
  const key = dupeKey(raid.id, body.itemId, body.winnerKey);
  const now = ctx.now();
  await db.batch([
    db.prepare(
      `INSERT INTO attention_dismissals (id, guild_id, item_id, kind, team_id, mode, until, fingerprint, dismissed_by, created_at) VALUES (?, ?, ?, ?, ?, 'dismiss', NULL, 'keep-both', ?, ?)
       ON CONFLICT (guild_id, item_id) DO UPDATE SET dismissed_by = excluded.dismissed_by, created_at = excluded.created_at`,
    ).bind(newId('ad', ctx.randomBytes), guild.id, key, FIX_DISMISS_KIND, raid.team_id, ctx.session.user.id, now),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attention.dismiss', entityType: 'attention', entityId: key,
      after: { kind: FIX_DISMISS_KIND, mode: 'dismiss', raidId: raid.id, teamId: raid.team_id },
    }),
  ]);
  return jsonResponse({ ok: true, key });
}

// ---------------------------------------------------------------------------
// Policy

function policyView(guildPolicyRows, teams) {
  const resolver = makeLootPolicyResolver(guildPolicyRows);
  const view = {
    defaults: DEFAULT_LOOT_POLICY,
    guild: resolver.overrides.guild,
    teams: resolver.overrides.teams,
    resolved: Object.fromEntries(teams.map((team) => [team.id, resolver.resolved(team.id)])),
    versions: resolver.versions,
  };
  return { view, resolver };
}

async function readPolicy(ctx, guildId) {
  const [policyResult, teamResult] = await ctx.db.batch([
    lootPolicyRowsStatement(ctx.db, guildId),
    ctx.db.prepare('SELECT id FROM teams WHERE guild_id = ? ORDER BY created_at, id').bind(guildId),
  ]);
  return policyView(policyResult.results, teamResult.results);
}

export async function getLootPolicy(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  return jsonResponse((await readPolicy(ctx, guildContext.guild.id)).view);
}

export async function putLootPolicy(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'loot.policy');
  const guild = guildContext.guild;
  const teamId = body.teamId === undefined ? null : body.teamId;
  if (teamId !== null && !isId('t', teamId)) throw bad('Pick a team.', 'teamId');
  // The attendance policy names these `policy` and `expectedVersion`; both spellings are read.
  const override = body.override !== undefined ? body.override : body.policy;
  const expected = body.version !== undefined ? body.version : body.expectedVersion;
  if (!isPlainObject(override)) throw new HttpError(400, 'policy_invalid', 'The policy must be an object.', { field: 'override', errors: [{ path: 'override', message: 'The policy must be an object.' }] });
  if (!Number.isInteger(expected) || expected < 0) throw bad('Send the version you last saw.', 'version');
  const { view, resolver } = await readPolicy(ctx, guild.id);
  if (teamId !== null && !(teamId in view.resolved)) throw bad('That team does not exist in this guild.', 'teamId');
  const { errors } = validateLootOverride(override, teamId === null ? 'guild' : 'team');
  if (errors.length) throw new HttpError(400, 'policy_invalid', errors[0].message, { field: errors[0].path, errors });

  const existingId = teamId === null ? resolver.ids.guild : resolver.ids.teams[teamId] || null;
  const version = teamId === null ? resolver.versions.guild : (resolver.versions.teams[teamId] || 0);
  const stale = (current) => new HttpError(409, 'stale', 'Someone else changed the loot settings. The page now shows their version.', { current });
  if (expected !== version) throw stale(view);

  const before = teamId === null ? resolver.overrides.guild : (resolver.overrides.teams[teamId] || {});
  const keys = [...new Set([...Object.keys(before), ...Object.keys(override)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(override[key])).sort();
  const now = ctx.now();
  const entryId = existingId || newId('lp', ctx.randomBytes);
  const audit = auditStatement(ctx, {
    guildId: guild.id, actorUserId: ctx.session.user.id, action: 'loot.policy', entityType: 'policy', entityId: entryId,
    before: { scope: teamId || 'guild', version, changed: keys },
    after: { scope: teamId || 'guild', version: version + 1, changed: keys, values: Object.fromEntries(keys.filter((key) => key in override).map((key) => [key, override[key]])) },
  }, CHANGED_ONE);
  const policyJson = JSON.stringify(override);
  let results;
  try {
    results = await db.batch([
      existingId
        ? db.prepare('UPDATE loot_policies SET policy = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND version = ?')
          .bind(policyJson, ctx.session.user.id, now, existingId, guild.id, version)
        : db.prepare('INSERT INTO loot_policies (id, guild_id, team_id, policy, version, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
          .bind(entryId, guild.id, teamId, policyJson, ctx.session.user.id, now),
      audit,
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw stale((await readPolicy(ctx, guild.id)).view);
    throw error;
  }
  if (results[0].meta.changes !== 1) throw stale((await readPolicy(ctx, guild.id)).view);
  return jsonResponse((await readPolicy(ctx, guild.id)).view);
}
