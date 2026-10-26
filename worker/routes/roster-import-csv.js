// The CSV roster import: an officer pastes or uploads a CSV (name, class, spec, realm, team, main/alt, status, joined, owner), sees what each line
// would do, answers the questions it leaves (an alt with no main in the file: alt of whom, or a person of its own), and commits. Like the other
// imports, a preview reads and stores nothing; a commit checks every row again, then writes people and characters in one batch (writeImport).
//   POST /api/guild/:gid/roster/import/csv/preview  { teamId, text, defaultStatus? }
//   POST /api/guild/:gid/roster/import/csv/commit   { teamId, rows: [{ line, action: new | alt | skip, name, class, spec?, realm?, teamId?, status?, joinedOn?, personId?, withLine? }] }
// The columns, the problems and the grouping rules are worker/csv-roster.js.
import { HttpError, jsonResponse } from '../http.js';
import { isId, newId } from '../ids.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { allows } from '../permissions.js';
import { CSV_MAX_ROWS, findColumns, mapRows, planRows, readCsvText } from '../csv-roster.js';
import { CREATE_STATUSES, isRealDate, isSpecOf, nameKey } from '../roster-data.js';
import {
  checkNames, importRate, indexed, loadGuildKeys, loadNicknameIndex, readDefaultStatus, requireTeamId, startImport, writeImport,
} from './roster-import.js';
import { bad, readClass, readName, resolveRealm } from './roster.js';

// A row may start Social (status 'inactive': the characters take core_rank 'social'); the file-wide starting status stays Raider / Trial / Reserve.
const CSV_STATUSES = [...CREATE_STATUSES, 'inactive'];

const forbidden = (extra) => new HttpError(403, 'forbidden', 'You do not have permission to add to that team.', extra);

export async function previewCsv(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  const read = readCsvText(body.text);
  if (!read.ok) throw bad(read.message, 'text');
  const defaultStatus = readDefaultStatus(body.defaultStatus, 'defaultStatus', 'raider');
  const layout = findColumns(read.records[0]);
  const data = layout.header ? read.records.slice(1) : read.records;
  if (!data.length) throw bad('That file has a header row but no characters.', 'text');
  if (data.length > CSV_MAX_ROWS) throw bad(`Import at most ${CSV_MAX_ROWS} characters at a time.`, 'text');
  if (!layout.columns.includes('name') || !layout.columns.includes('class')) throw bad('The file needs a name column and a class column.', 'text');

  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);
  const teams = (await db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guild.id).all()).results;
  const rows = mapRows(data, layout, {
    defaultTeam: { id: team.id, name: team.name }, teams, realmGuild: guild.realm_kind !== 'ruleset', defaultStatus, gameVersion: guild.game_version,
  }, layout.header ? 2 : 1);
  const [keys, nicknames, surnames] = await Promise.all([loadGuildKeys(db, guild.id), loadNicknameIndex(db, guildContext, team), loadSurnameIndex(db, guild)]);

  const seen = new Set();
  for (const row of rows) {
    row.taken = null;
    row.suggestion = null;
    if (row.problems.length) continue;
    const realm = resolveRealm(guild, row.realm);
    if (!realm) { row.problems.push(`"${String(row.realm).slice(0, 30)}" is not a realm this guild accepts.`); continue; }
    row.realm = realm.realm;
    row.realmKey = realm.key;
    if (!allows(guildContext.can, 'roster.edit', row.teamId)) { row.problems.push(`You cannot add to ${row.teamName}.`); continue; }
    row.name = resolveName(surnames, row.name, realm.key); // Forever: a one-word name that is one roster character's first word is that character
    const key = `${nameKey(row.name)}|${realm.key}`;
    if (seen.has(key)) { row.problems.push('This character is in the file twice.'); continue; }
    seen.add(key);
    const owner = keys.get(key);
    if (owner) row.taken = { personId: owner.id, name: owner.name };
  }
  const plan = planRows(rows);
  for (const row of rows) {
    const step = plan.get(row.line);
    row.action = step.action;
    row.withLine = step.withLine;
    row.needsDecision = step.needsDecision;
    if (!step.needsDecision || !row.owner) continue;
    // Whose alt could this be? A character of that name on the roster, or one person whose Discord nickname names it.
    const named = keys.get(`${nameKey(resolveName(surnames, row.owner, row.realmKey))}|${row.realmKey}`);
    const candidates = nicknames.get(nameKey(row.owner)) || [];
    if (named) row.suggestion = { personId: named.id, name: named.name };
    else if (candidates.length === 1) row.suggestion = { personId: candidates[0].personId, name: candidates[0].name };
  }
  const count = (action) => rows.filter((row) => row.action === action && !row.problems.length && !row.taken).length;
  return jsonResponse({
    header: layout.header,
    columns: layout.columns.filter(Boolean),
    team: { id: team.id, name: team.name },
    rows: rows.map((row) => ({
      line: row.line, name: row.name, class: row.class, spec: row.spec, realm: row.realm, teamId: row.teamId, teamName: row.teamName, status: row.status,
      joinedOn: row.joinedOn, owner: row.owner, isAlt: row.isAlt, problems: row.problems, notes: row.notes, taken: row.taken,
      action: row.action, withLine: row.withLine, needsDecision: row.needsDecision, suggestion: row.suggestion,
    })),
    totals: { rows: rows.length, people: count('new'), alts: count('alt'), taken: rows.filter((row) => row.taken).length, problems: rows.filter((row) => row.problems.length).length },
  });
}

function readCommitRows(body) {
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length > CSV_MAX_ROWS) throw bad(`Send at most ${CSV_MAX_ROWS} rows.`, 'rows');
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each row must be an object.', 'rows', indexed(index));
    if (!['new', 'alt', 'skip'].includes(row.action)) throw bad('Pick new, alt or skip.', 'action', indexed(index));
    if (!Number.isInteger(row.line) || row.line < 1) throw bad('Each row needs its line number.', 'line', indexed(index));
  });
  if (new Set(rows.map((row) => row.line)).size !== rows.length) throw bad('Each row needs its own line number.', 'rows');
  return rows;
}

export async function commitCsv(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  const rows = readCommitRows(body);
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);
  const teamRows = (await db.prepare('SELECT id, archived FROM teams WHERE guild_id = ?').bind(guild.id).all()).results;
  const activeTeams = new Set(teamRows.filter((row) => row.archived === 0).map((row) => row.id));

  const plan = { people: [], characters: [], nicknameUpdates: [], source: 'csv', ref: `${rows.length} rows` };
  const nameEntries = [];
  const personOfLine = new Map();
  const wanted = rows.map((row, index) => ({ row, index })).filter((entry) => entry.row.action !== 'skip');
  const read = new Map();
  for (const { row, index } of wanted) {
    const extra = indexed(index);
    const name = readName(row.name, 'name', extra, guild.game_version);
    const classId = readClass(row.class, 'class', extra);
    let mainSpec = null;
    if (row.spec !== undefined && row.spec !== null) {
      if (typeof row.spec !== 'string' || !isSpecOf(classId, row.spec)) throw bad('That spec does not belong to the class.', 'spec', extra);
      mainSpec = row.spec;
    }
    const realm = resolveRealm(guild, row.realm === undefined ? null : row.realm);
    if (!realm) throw bad('That realm is not valid.', 'realm', extra);
    const teamId = row.teamId === undefined || row.teamId === null ? team.id : row.teamId;
    if (!isId('t', teamId) || !activeTeams.has(teamId)) throw bad('That team does not exist in this guild.', 'teamId', extra);
    if (!allows(guildContext.can, 'roster.edit', teamId)) throw forbidden(extra);
    const status = readDefaultStatus(row.status, 'status', 'raider', extra, CSV_STATUSES);
    if (row.joinedOn !== undefined && row.joinedOn !== null && !isRealDate(row.joinedOn)) throw bad('Joined needs a date.', 'joinedOn', extra);
    read.set(index, { name, classId, mainSpec, realm, teamId, status, joinedOn: row.joinedOn || null });
    nameEntries.push({ name, realmKey: realm.key, index });
  }
  // New people first, so an alt can name the line of its main.
  for (const { row, index } of wanted) {
    if (row.action !== 'new') continue;
    const value = read.get(index);
    const playerId = newId('p', ctx.randomBytes);
    personOfLine.set(row.line, playerId);
    plan.people.push({ id: playerId, status: value.status, discord: null, nickname: null, joinedOn: value.joinedOn });
    plan.characters.push({
      id: newId('c', ctx.randomBytes), playerId, name: value.name, realm: value.realm.realm, realmKey: value.realm.key, class: value.classId,
      mainSpec: value.mainSpec, offSpec: null, isMain: true, teamId: value.teamId,
    });
  }
  const existing = [...new Set(wanted.filter(({ row }) => row.action === 'alt' && row.personId !== undefined && row.personId !== null).map(({ row }) => row.personId))];
  const homeByPerson = new Map();
  if (existing.length) {
    if (existing.some((id) => !isId('p', id))) throw bad('Pick the person this character belongs to.', 'personId');
    const result = await db.prepare(
      `SELECT p.id, m.team_id FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1 WHERE p.guild_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
    ).bind(guild.id, JSON.stringify(existing)).all();
    for (const row of result.results) homeByPerson.set(row.id, row.team_id);
  }
  for (const { row, index } of wanted) {
    if (row.action !== 'alt') continue;
    const extra = indexed(index);
    const value = read.get(index);
    let playerId;
    if (row.personId !== undefined && row.personId !== null) {
      if (!homeByPerson.has(row.personId)) throw new HttpError(404, 'not_found', 'That person was not found.', extra);
      if (!allows(guildContext.can, 'roster.edit', homeByPerson.get(row.personId))) throw new HttpError(403, 'forbidden', 'You do not have permission to add to that person.', extra);
      playerId = row.personId;
    } else if (Number.isInteger(row.withLine) && personOfLine.has(row.withLine)) {
      playerId = personOfLine.get(row.withLine);
    } else {
      throw bad('Pick the person this alt belongs to, or add it as a new person.', 'personId', extra);
    }
    plan.characters.push({
      id: newId('c', ctx.randomBytes), playerId, name: value.name, realm: value.realm.realm, realmKey: value.realm.key, class: value.classId,
      mainSpec: null, offSpec: null, isMain: false, teamId: value.teamId,
    });
  }
  await checkNames(db, guild.id, nameEntries);
  const written = await writeImport(ctx, guildContext, team, plan);
  return jsonResponse(written.body, written.status);
}
