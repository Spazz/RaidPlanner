// The pre-raid loot board and manual awards (PM wave 5). An officer pastes the ThatsMyBIS (TMB) prio export and / or the softres.it export on a
// raid (upcoming or past); the browser decodes and normalizes them (js/guild/tmb.js, softres.js) and the Worker keeps the rows the board needs. The
// board (GET) lines the pasted prios and soft-reserves up against the people expected on the raid. A manual award is a loot_awards row with
// manual = 1 and a checksum no Gargul export can produce. Rules: worker/loot-board.js; spec: tasks/reference/guild-pm-wave5-spec.md.
import { HttpError, cleanText, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { LIST_SOURCES, buildBoard, expectedPeople, isListSource, readListRows } from '../loot-board.js';
import { LOOT_TAGS } from '../loot-policy.js';
import { AWARD_SELECT, lootAccess, lootPolicyRowsStatement, makeLootPolicyResolver, viewAwards } from '../loot-store.js';
import { allows, loadGuildContext } from '../permissions.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { allowsSurname, cleanCharacterName, nameKey, realmKey } from '../roster-data.js';
import { signUpClassId } from '../signups-data.js';
import { loadRaid } from './raids.js';
import { bad } from './roster.js';

const WRITE_CHUNK = 250;
const MAX_NOTE = 200;
const MAX_ITEM_ID = 2147483647;

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------
// The board

// Everything the board reads, in one batch, then the board itself. raid: the raids row.
async function boardFor(ctx, guildContext, raid, access) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const [listResult, importResult, signupResult, attendanceResult, teamResult, hereResult, earlierResult, namesResult, characterResult] = await db.batch([
    db.prepare('SELECT source, kind, name, name_key, item_id, item_name, prio, copies FROM raid_loot_lists WHERE raid_id = ? ORDER BY source, position').bind(raid.id),
    db.prepare('SELECT source, row_count, imported_at FROM raid_loot_imports WHERE raid_id = ?').bind(raid.id),
    db.prepare('SELECT source, player_id, kind, standby, guest, nickname, class_name, spec_name FROM raid_signups WHERE raid_id = ? AND (player_id IS NOT NULL OR guest = 1)').bind(raid.id),
    db.prepare('SELECT player_id, outcome FROM attendance WHERE raid_id = ? AND guild_id = ?').bind(raid.id, guild.id),
    db.prepare(
      `SELECT p.id AS player_id FROM players p WHERE p.guild_id = ?1 AND p.status != 'inactive'
          AND EXISTS (SELECT 1 FROM characters c WHERE c.player_id = p.id AND c.guild_id = ?1 AND c.team_id = ?2)`,
    ).bind(guild.id, raid.team_id),
    db.prepare('SELECT item_id, tag, winner_name, winner_name_key FROM loot_awards WHERE raid_id = ? AND guild_id = ? ORDER BY awarded_at, id').bind(raid.id, guild.id),
    db.prepare(
      `SELECT a.item_id, a.winner_name_key FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
        WHERE a.guild_id = ?1 AND a.team_id = ?2 AND r.raid_on < ?3 AND a.winner_name_key IS NOT NULL AND a.tag IN ('MS', 'OS')
          AND a.item_id IN (SELECT item_id FROM raid_loot_lists WHERE raid_id = ?4)`,
    ).bind(guild.id, raid.team_id, raid.raid_on, raid.id),
    db.prepare(
      `SELECT item_id, MAX(item_name) AS item_name FROM loot_awards
        WHERE guild_id = ?1 AND item_name IS NOT NULL AND item_id IN (SELECT item_id FROM raid_loot_lists WHERE raid_id = ?2) GROUP BY item_id`,
    ).bind(guild.id, raid.id),
    db.prepare(
      `SELECT player_id, name, name_key, class, team_id, is_main FROM characters
        WHERE guild_id = ?1 AND name_key IN (SELECT name_key FROM raid_loot_lists WHERE raid_id = ?2
                                             UNION SELECT winner_name_key FROM loot_awards WHERE raid_id = ?2 AND guild_id = ?1 AND winner_name_key IS NOT NULL)`,
    ).bind(guild.id, raid.id),
  ]);

  // The character a pasted name belongs to: the one on the raid's team, else the first.
  const characters = new Map();
  for (const row of characterResult.results) {
    const known = characters.get(row.name_key);
    if (!known || (known.team_id !== raid.team_id && row.team_id === raid.team_id)) characters.set(row.name_key, row);
  }
  const expected = expectedPeople({
    signupRows: signupResult.results, attendanceRows: attendanceResult.results, teamPeopleIds: teamResult.results.map((row) => row.player_id),
  });
  const board = buildBoard({
    rows: listResult.results,
    characters,
    guestClasses: new Map(signupResult.results.filter(row => row.source === 'raidsmith' && row.guest === 1).map(row => [nameKey(row.nickname), signUpClassId(row)])),
    expected: expected.ids,
    receivedKeys: new Set(earlierResult.results.map((row) => `${row.item_id}|${row.winner_name_key}`)),
    itemNames: new Map(namesResult.results.map((row) => [row.item_id, row.item_name])),
    awards: hereResult.results.map((row) => ({ ...row, personId: row.winner_name_key && characters.has(row.winner_name_key) ? characters.get(row.winner_name_key).player_id : null })),
  });
  const lists = Object.fromEntries(LIST_SOURCES.map((source) => {
    const meta = importResult.results.find((row) => row.source === source);
    return [source, meta ? { rows: meta.row_count, importedAt: meta.imported_at } : null];
  }));
  return {
    raid: { id: raid.id, raidOn: raid.raid_on, upcoming: raid.starts_at > ctx.now() },
    canEdit: access.canEdit,
    roster: { source: expected.source, people: expected.ids.size },
    lists,
    ...board,
  };
}

// Who may read the board: whoever may see this team's loot in full (the loot visibility setting; an editor always). 403 for the rest.
async function boardTarget(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext);
  const policy = await lootPolicyRowsStatement(db, guildContext.guild.id).all();
  const access = lootAccess(guildContext, makeLootPolicyResolver(policy.results), raid.team_id);
  if (access.level !== 'full') throw forbidden();
  return { guildContext, raid, access };
}

export async function getLootBoard(ctx) {
  const { guildContext, raid, access } = await boardTarget(ctx);
  return jsonResponse(await boardFor(ctx, guildContext, raid, access));
}

// ---------------------------------------------------------------------------
// The pasted lists

const INSERT_ROWS = `INSERT INTO raid_loot_lists (raid_id, guild_id, source, position, kind, name, name_key, item_id, item_name, prio, copies)
  SELECT ?, ?, ?, json_extract(value, '$.position'), json_extract(value, '$.kind'), json_extract(value, '$.name'), json_extract(value, '$.nameKey'),
         json_extract(value, '$.itemId'), json_extract(value, '$.itemName'), json_extract(value, '$.prio'), json_extract(value, '$.copies')
    FROM json_each(?)`;

// PUT .../loot-lists { source: 'tmb' | 'softres', rows: [...] }: replaces the raid's rows of that source; an empty list clears it. loot.edit on the raid's team.
export async function putLootList(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'loot.edit', raid.team_id)) throw forbidden();
  if (!isListSource(body.source)) throw bad('Pick TMB or softres.', 'source');
  const source = body.source;
  const rows = readListRows(source, body.rows, {
    gameVersion: guild.game_version, surnames: await loadSurnameIndex(db, guild), realmKey: guild.realm_kind !== 'ruleset' ? realmKey(guild.realm) : '',
  });
  const now = ctx.now();
  const userId = ctx.session.user.id;
  const statements = [db.prepare('DELETE FROM raid_loot_lists WHERE raid_id = ? AND source = ?').bind(raid.id, source)];
  let offset = 0;
  for (const part of chunks(rows, WRITE_CHUNK)) {
    const json = JSON.stringify(part.map((row, i) => ({ position: offset + i, kind: row.kind, name: row.name, nameKey: row.nameKey, itemId: row.itemId, itemName: row.itemName, prio: row.prio, copies: row.copies })));
    offset += part.length;
    statements.push(db.prepare(INSERT_ROWS).bind(raid.id, guild.id, source, json));
  }
  if (rows.length) {
    statements.push(db.prepare(
      `INSERT INTO raid_loot_imports (raid_id, guild_id, source, row_count, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (raid_id, source) DO UPDATE SET row_count = excluded.row_count, imported_by = excluded.imported_by, imported_at = excluded.imported_at`,
    ).bind(raid.id, guild.id, source, rows.length, userId, now));
  } else {
    statements.push(db.prepare('DELETE FROM raid_loot_imports WHERE raid_id = ? AND source = ?').bind(raid.id, source));
  }
  const items = new Set(rows.map((row) => row.itemId)).size;
  const people = new Set(rows.map((row) => row.nameKey)).size;
  statements.push(auditStatement(ctx, {
    guildId: guild.id, actorUserId: userId, action: 'loot.list', entityType: 'raid', entityId: raid.id, after: { source, rows: rows.length, items, people },
  }));
  try {
    await db.batch(statements);
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error && error.message) + String(error && error.cause && error.cause.message))) throw new HttpError(404, 'not_found', 'That raid does not exist.');
    throw error;
  }
  return jsonResponse(await boardFor(ctx, guildContext, raid, { canEdit: true, level: 'full' }));
}

// ---------------------------------------------------------------------------
// A manual award

// An id like a version-4 UUID from the injected random bytes: 'm-' + 36 characters = the 38 a checksum may hold (8 to 40, printable).
function manualChecksum(randomBytes) {
  const bytes = randomBytes(16);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `m-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// POST .../loot/manual { itemId, itemName?, winnerName?, winnerRealm?, tag?, note? }: one award made by hand on a raid that has started (loot.edit on its team).
// The winner is any character name: a roster character is matched on read like a Gargul winner, any other name goes the unmatched / guest way. No winner
// is a disenchant (tag DE). -> 201 { award } (the award view of GET /raids/:rid/loot, with manual: true).
export async function postManualAward(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'loot.edit', raid.team_id)) throw forbidden();
  if (raid.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'That raid has not started yet. Add its loot afterwards.');
  if (!Number.isInteger(body.itemId) || body.itemId < 1 || body.itemId > MAX_ITEM_ID) throw bad('Enter the item id (a number, or paste the Wowhead link).', 'itemId');
  let itemName = null;
  if (body.itemName !== undefined && body.itemName !== null) itemName = cleanText(body.itemName, 'itemName', { min: 0, max: 100 }) || null;
  const tag = body.tag === undefined || body.tag === null ? 'MS' : body.tag;
  if (!(typeof tag === 'string' && LOOT_TAGS.includes(tag))) throw bad('Pick MS, OS, DE or BANK.', 'tag');
  let note = null;
  if (body.note !== undefined && body.note !== null) note = cleanText(body.note, 'note', { min: 0, max: MAX_NOTE }) || null;

  const hasWinner = body.winnerName !== undefined && body.winnerName !== null && String(body.winnerName).trim() !== '';
  let winner = { name: null, nameKey: null, realm: null, realmKey: '' };
  if (hasWinner) {
    const cleaned = cleanCharacterName(body.winnerName, guild.game_version);
    if (!cleaned) throw bad(allowsSurname(guild.game_version) ? 'The winner needs a character name (a first name and optional surname, 2 to 12 letters each).' : 'The winner needs a character name (2 to 12 letters).', 'winnerName');
    let name = cleaned;
    let realm = null;
    let key = '';
    if (guild.realm_kind !== 'ruleset') {
      if (body.winnerRealm !== undefined && body.winnerRealm !== null && typeof body.winnerRealm !== 'string') throw bad('The realm must be text.', 'winnerRealm');
      realm = (typeof body.winnerRealm === 'string' ? body.winnerRealm.trim() : '') || guild.realm;
      key = realmKey(realm);
      if (!key || Array.from(realm).length > 40) throw bad('The winner\'s realm is not valid.', 'winnerRealm');
    }
    name = resolveName(await loadSurnameIndex(db, guild), cleaned, key);
    winner = { name, nameKey: nameKey(name), realm, realmKey: key };
  } else if (tag !== 'DE') {
    throw bad('Pick the winner, or tag the item DE when nobody won it.', 'winnerName');
  }

  const id = newId('lo', ctx.randomBytes);
  const now = ctx.now();
  const userId = ctx.session.user.id;
  await db.batch([
    db.prepare(
      `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, source, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key,
          winner_realm, winner_realm_key, winner_class, roll_type, flags, tag, tag_set_by, tag_set_at, note, awarded_by, created_by, created_at, updated_at, manual)
       VALUES (?, ?, ?, ?, 'gargul', ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
    ).bind(id, guild.id, raid.id, raid.team_id, manualChecksum(ctx.randomBytes), body.itemId, itemName, now, winner.name, winner.nameKey, winner.realm, winner.realmKey, tag, userId, now, note, userId, now, now),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: userId, action: 'loot.add', entityType: 'loot', entityId: id, after: { raidId: raid.id, itemId: body.itemId, tag, manual: true },
    }),
  ]);
  const fresh = await db.prepare(`${AWARD_SELECT} WHERE a.id = ? AND a.guild_id = ?`).bind(id, guild.id).first();
  const [award] = await viewAwards(db, guild.id, [fresh]);
  return jsonResponse({ award }, 201);
}
