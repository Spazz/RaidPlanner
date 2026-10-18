// Loot: awards imported from Gargul's Detailed (JSON) export onto a past raid, their tags and notes, and the four views
// (per raid, balance, by raid, by item, per person) plus the loot policy. Matching a winner to a person happens on read
// (loot-store.js). Rules: tasks/guild-phase4-spec.md.
import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isPlainObject, makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { displayCharacter, groupBy } from '../attendance-view.js';
import { isId, newId } from '../ids.js';
import { classifyAward, normalizedOf, readAwards } from '../loot-import.js';
import { loadSurnameIndex } from '../name-resolve.js';
import { lootBalance } from '../loot-metrics.js';
import { DEFAULT_LOOT_POLICY, LOOT_TAGS, validateLootOverride } from '../loot-policy.js';
import {
  AWARD_SELECT, LOOT_LIST_CAP, awardView, lootAccess, lootPolicyRowsStatement, makeLootPolicyResolver, makeMatcher, matchStatements,
  ownPersonStatement, viewAwards,
} from '../loot-store.js';
import { isOwnPlayer } from '../membership.js';
import { announceLoot } from '../notify-run.js';
import { teamNotifyStatement } from '../notify-store.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { guildToday, viewerOf } from '../roster-view.js';
import { windowStartFor } from './attendance.js';
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
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
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
  const [existingResult, characterResult, guestResult] = await db.batch([
    db.prepare(`${AWARD_SELECT} WHERE a.guild_id = ?1 AND a.checksum IN (SELECT value FROM json_each(?2))`)
      .bind(guild.id, JSON.stringify(awards.map((award) => award.checksum))),
    ...matchStatements(db, guild.id, awards.map((award) => award.nameKey)),
  ]);
  const existing = new Map(existingResult.results.map((row) => [row.checksum, row]));
  const matcher = makeMatcher(characterResult.results, guestResult.results);
  return awards.map((award) => {
    const { status, tag } = classifyAward(award, existing.get(award.checksum) || null, raid, guild.time_zone);
    const matched = matcher({ winner_name_key: award.nameKey, winner_realm_key: award.realmKey, team_id: raid.team_id });
    return { award, status, tag, matched };
  });
}

// The raid, the viewer's loot.edit on its team (403), a started raid (409): what a preview and an import both need.
async function loadImportTarget(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'loot.edit', raid.team_id)) throw forbidden();
  if (raid.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'That raid has not started yet. Import its loot afterwards.');
  return { guildContext, raid };
}

const countStatuses = (rows) => {
  const counts = { new: 0, update: 0, same: 0, otherRaid: 0, otherDay: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
};

export async function previewLoot(ctx) {
  const { guildContext, raid } = await loadImportTarget(ctx);
  const awards = readAwards(ctx.body.awards, guildContext.guild, await loadSurnameIndex(ctx.db, guildContext.guild));
  const rows = await planImport(ctx, guildContext, raid, awards);
  return jsonResponse({
    rows: rows.map((row) => ({ ...normalizedOf(row.award), status: row.status, match: row.matched.match, tag: row.tag })),
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
const UPDATE_AWARDS = `UPDATE loot_awards SET
    item_id = json_extract(j.value, '$.itemId'), item_name = json_extract(j.value, '$.itemName'), item_quality = json_extract(j.value, '$.quality'),
    awarded_at = json_extract(j.value, '$.awardedAt'), winner_name = json_extract(j.value, '$.name'), winner_name_key = json_extract(j.value, '$.nameKey'),
    winner_realm = json_extract(j.value, '$.realm'), winner_realm_key = json_extract(j.value, '$.realmKey'), winner_class = json_extract(j.value, '$.class'),
    roll_type = json_extract(j.value, '$.rollType'), flags = json_extract(j.value, '$.flags'), awarded_by = json_extract(j.value, '$.awardedBy'),
    tag = CASE WHEN loot_awards.tag_set_at IS NULL OR (json_extract(j.value, '$.name') IS NULL) <> (loot_awards.winner_name IS NULL)
               THEN json_extract(j.value, '$.tag') ELSE loot_awards.tag END,
    tag_set_by = CASE WHEN (json_extract(j.value, '$.name') IS NULL) <> (loot_awards.winner_name IS NULL) THEN NULL ELSE loot_awards.tag_set_by END,
    tag_set_at = CASE WHEN (json_extract(j.value, '$.name') IS NULL) <> (loot_awards.winner_name IS NULL) THEN NULL ELSE loot_awards.tag_set_at END,
    updated_at = ?
  FROM json_each(?) j
  WHERE loot_awards.guild_id = ? AND loot_awards.raid_id = ? AND loot_awards.checksum = json_extract(j.value, '$.checksum')`;

// The fields a write needs (flags as the JSON text that is stored).
const writeFields = (award) => ({
  checksum: award.checksum, itemId: award.itemId, itemName: award.itemName, quality: award.quality, awardedAt: award.awardedAt,
  name: award.winnerName, nameKey: award.nameKey, realm: award.storedRealm, realmKey: award.realmKey, class: award.winnerClass,
  rollType: award.rollType, flags: JSON.stringify(award.flags), awardedBy: award.awardedBy, tag: award.tag,
});

export async function commitLoot(ctx) {
  const { db, body } = ctx;
  const { guildContext, raid } = await loadImportTarget(ctx);
  const guild = guildContext.guild;
  if (body.includeOtherDay !== undefined && typeof body.includeOtherDay !== 'boolean') throw bad('includeOtherDay must be true or false.', 'includeOtherDay');
  const includeOtherDay = body.includeOtherDay === true;
  const awards = readAwards(body.awards, guild, await loadSurnameIndex(db, guild));
  const rows = await planImport(ctx, guildContext, raid, awards);

  const toInsert = rows.filter((row) => row.status === 'new' || (row.status === 'otherDay' && includeOtherDay));
  const toUpdate = rows.filter((row) => row.status === 'update');
  const result = {
    inserted: toInsert.length,
    updated: toUpdate.length,
    unchanged: rows.filter((row) => row.status === 'same').length,
    skippedOtherRaid: rows.filter((row) => row.status === 'otherRaid').length,
    skippedOtherDay: includeOtherDay ? 0 : rows.filter((row) => row.status === 'otherDay').length,
  };

  const now = ctx.now();
  const userId = ctx.session.user.id;
  const statements = [];
  for (const part of chunks(toInsert, WRITE_CHUNK)) {
    const json = JSON.stringify(part.map((row) => ({ id: newId('lo', ctx.randomBytes), ...writeFields(row.award) })));
    statements.push(db.prepare(INSERT_AWARDS).bind(guild.id, raid.id, raid.team_id, userId, now, now, json));
  }
  for (const part of chunks(toUpdate, WRITE_CHUNK)) {
    statements.push(db.prepare(UPDATE_AWARDS).bind(now, JSON.stringify(part.map((row) => writeFields(row.award))), guild.id, raid.id));
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

export async function patchLoot(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const award = await loadAward(ctx, guildContext);
  const hasTag = body.tag !== undefined;
  const hasNote = body.note !== undefined;
  if (!hasTag && !hasNote) throw bad('Send a tag, a note, or both.', 'tag');
  if (hasTag && !(typeof body.tag === 'string' && LOOT_TAGS.includes(body.tag))) throw bad('Pick MS, OS, DE or BANK.', 'tag');
  // Nobody won a disenchanted item, so it cannot be MS, OS or Bank.
  if (hasTag && award.winner_name === null && body.tag !== 'DE') throw bad('A disenchanted item can only be tagged DE.', 'tag');
  let note = null;
  if (hasNote && body.note !== null) note = cleanText(body.note, 'note', { min: 0, max: MAX_NOTE }) || null;
  const now = ctx.now();
  const userId = ctx.session.user.id;
  const results = await db.batch([
    // A tag set by hand records who and when (the import then leaves it alone); a note change leaves the tag fields untouched.
    db.prepare(
      `UPDATE loot_awards SET
         tag = CASE WHEN ?1 = 1 THEN ?2 ELSE tag END,
         tag_set_by = CASE WHEN ?1 = 1 THEN ?3 ELSE tag_set_by END,
         tag_set_at = CASE WHEN ?1 = 1 THEN ?4 ELSE tag_set_at END,
         note = CASE WHEN ?5 = 1 THEN ?6 ELSE note END,
         updated_at = ?4
       WHERE id = ?7 AND guild_id = ?8`,
    ).bind(hasTag ? 1 : 0, hasTag ? body.tag : null, userId, now, hasNote ? 1 : 0, note, award.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: userId, action: 'loot.update', entityType: 'loot', entityId: award.id,
      before: { raidId: award.raid_id, tag: award.tag, tagSetBy: award.tag_set_at === null ? null : 'officer' },
      after: { raidId: award.raid_id, tag: hasTag ? body.tag : award.tag, tagSetBy: hasTag || award.tag_set_at !== null ? 'officer' : null, noteChanged: hasNote },
    }, CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) throw awardNotFound();
  const fresh = await db.prepare(`${AWARD_SELECT} WHERE a.id = ? AND a.guild_id = ?`).bind(award.id, guild.id).first();
  const [view] = await viewAwards(db, guild.id, [fresh]);
  return jsonResponse({ award: view });
}

export async function deleteLoot(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const award = await loadAward(ctx, guildContext);
  const results = await db.batch([
    db.prepare('DELETE FROM loot_awards WHERE id = ? AND guild_id = ?').bind(award.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'loot.delete', entityType: 'loot', entityId: award.id,
      before: { raidId: award.raid_id, itemId: award.item_id, tag: award.tag },
    }, CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) throw awardNotFound();
  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Team views: balance, by raid, by item

// The statements every team view reads, then `extra`. -> the parsed results, the access, the matcher.
async function loadTeamLoot(ctx, extra = () => []) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
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

export async function getBalance(ctx) {
  const loaded = await loadTeamLoot(ctx, (bind, db, guild) => [
    policyRowsStatement(db, guild.id),
    bind('SELECT id, raid_on FROM raids WHERE guild_id = ?1 AND team_id = ?2'),
    bind('SELECT raid_id, player_id, outcome, attended, credit FROM attendance WHERE guild_id = ?1 AND team_id = ?2'),
    bind(`SELECT p.id, p.status FROM players p WHERE p.guild_id = ?1
            AND p.id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`),
    bind(`SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1
            AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)`),
    bind('SELECT raid_id, tag, winner_name_key, winner_realm_key FROM loot_awards WHERE guild_id = ?1 AND team_id = ?2 AND winner_name_key IS NOT NULL'),
  ]);
  const { guildContext, guild, team, access } = loaded;
  // Under "own loot only" a viewer sees their row and the team average, so they must be on the team.
  if (access.level === 'none' || (access.level === 'own' && !allows(guildContext.can, 'loot.view', team.id))) throw forbidden();
  const [attendancePolicyResult, raidResult, rowResult, peopleResult, characterResult, awardResult] = loaded.rest;
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
  return jsonResponse({
    team: { id: team.id, name: team.name },
    window: { weeks, switchWeeks: attendancePolicy.window.switchWeeks, from: windowStart },
    mode: policy.balance.mode,
    countTags: policy.balance.countTags,
    scope: own ? 'own' : 'team',
    people: own ? balance.people.filter((person) => person.personId === loaded.ownPersonId) : balance.people,
    teamAverage: balance.teamAverage,
  });
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
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
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
  return jsonResponse({ person: { id: player.id, name: home ? home.name : 'Unknown', status: player.status }, awards, totals });
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
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  return jsonResponse((await readPolicy(ctx, guildContext.guild.id)).view);
}

export async function putLootPolicy(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
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
