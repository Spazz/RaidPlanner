// The person join (user-hierarchy build, lane B6a; plan "Person join"): two roster persons become one. The survivor keeps its id, the loser's rows move to it, the loser
// is deleted. ONE module, two callers: the officer route (worker/routes/person-join.js) and the Battle.net sign-in match ("Battle.net proof joins two persons
// automatically"), which puts joinPersonsStatements() into its own batch. Nothing here writes: the function reads, decides and hands back prepared statements.
//
//   joinPersonsStatements(db, { guildId, aId, bId, actorUserId, now, reason: 'officer' | 'bnet', randomBytes?, guards?, expectedVersions?, lean? })
//     -> { survivorId, loserId, statements, counts, journalId, appliedIndex, deletedIndex, teamlessCharacterIds }   or throws HttpError
//   statements ... for db.batch, in order. appliedIndex = the position of the journal INSERT: wrote() is true when the batch applied and false when a guard
//                  refused it (a concurrent edit), in which case EVERY statement was a no-op. deletedIndex = the position of the DELETE of the loser.
//   guards ....... [{ sql, params }] repeated (AND) in every statement: the officer route passes the Seniority guard of both persons, the sign-in match its own.
//   expectedVersions { [personId]: players.version } the versions the caller saw; a difference throws 409 `conflict` before anything is built.
//   lean ......... the Battle.net sign-in match (a callback has a statement budget): the counts are read in ONE statement and a table the loser has no rows in gets no
//                  statements (2 reads + 8 to 10 writes for a loser with a few rows, against 2 + about 35). The journal row is inserted only while those tables are
//                  STILL empty for the loser and every later statement asks for the journal row, so a row that appeared after the count makes the whole batch a
//                  no-op (appliedIndex says so). The end state is the one of the full join (tests/guild/guild-b6a-match-tests.js compares them).
//
// WHO SURVIVES   the account-linked person (players.user_id), else the older one (created_at, then id).
// REFUSED        400 same person | 404 a person that is not in this guild | 409 join_owned_by_two: both persons are owned and the sets of owners differ (an owner is the
//                account of players.user_id, the account whose Discord ID the person carries, else the bare Discord ID: every identity the person has, wider on purpose than ownPlayerSql, which counts players.user_id only) |
//                409 join_too_many_characters: the two together hold more than LIMITS.charactersPerPerson |
//                409 join_blocked_person: the loser carries a person block (an account-less person an officer blocked) and the survivor belongs to an account. The block
//                would land on that account, so it is carried only by an OFFICER join whose actor is the Owner or strictly senior to the account, and the account is
//                neither the Owner nor GM-tier (worker/seniority.js blockCarryOk, checked here and again inside every statement). The Battle.net match never carries one.
//
// EVERY table that references players(id) is listed in JOIN_TABLES (tests/guild/guild-b6a-join-tests.js reads PRAGMA foreign_key_list over the whole schema and fails when
// a table references players and is in neither JOIN_TABLES nor JOIN_SKIPPED). The loser's rows move with UPDATE OR IGNORE; what is left (a row the survivor already
// has) is deleted with the loser by the foreign key's cascade. The survivor's row wins every clash except these two:  raid sign-ups (the confirmed one, else the newer) and the Main (the survivor's stays).
// Characters are moved with a plain UPDATE after the two clashes (one Main, one character per team) are resolved: a character is never silently dropped (the DELETE of
// the loser would cascade to it), an unexpected clash aborts the whole batch.
//
// ORDER   journal row -> audit row -> raids holding the loser's evidence marked stale -> children (characters first) -> the survivor's raids marked stale -> the loser's
//         unique fields cleared -> the survivor's own fields -> DELETE the loser. EVERY statement carries guild_id = ? and the version (and notes_version) of BOTH persons,
//         so a concurrent edit makes the whole batch a no-op; the journal INSERT comes first and its changes() says whether the batch applied. The survivor's own fields
//         come last: they bump its version, so the DELETE after them expects the new one.
//
// THE PLAYERS ROW (each field decided here):
//   id, guild_id, created_at, created_by, user_id ...... the survivor's (the loser never has a user_id: two account-linked persons are refused)
//   notes ............................................. the survivor's text, then a blank line, then the loser's (cut at 4000 characters); notes_version +1 and the
//                                                       editor fields only when the loser had notes
//   joined_on ......................................... the earliest of the two
//   rank, rank_on (the attendance ladder) ............. the survivor's
//   discord_user_id, discord_nickname ................. the survivor's; the survivor takes the loser's pair only when it has none AND it is owned by nobody or the
//                                                       loser's Discord ID is its own account's (a stranger's Discord ID never gains ownership of an account-linked person)
//   status, trial_start, trial_end, left_on, left_reason  legacy mirrors (worker/person-legacy.js): not read, not written; they go with the loser
//   version +1, updated_at ............................ the survivor's, set
// The audit log is never rewritten: audit rows that name the loser keep its id and the Activity view resolves it through person_joins (worker/routes/audit.js).
import { auditStatement } from './audit.js';
import { markPersonRaidsStale, weekFreeze } from './attendance-store.js';
import { HttpError } from './http.js';
import { defaultRandomBytes, newId } from './ids.js';
import { LIMITS } from './limits.js';
import { blockCarryOk } from './seniority.js';
import { isPlaceholderKey, placeholderCharacterSql, visibleCharacterSql } from './character-visibility.js';

export const JOIN_REASONS = Object.freeze(['officer', 'bnet']);
export const MAX_NOTES = 4000;
// The tables whose rows make a raid stale when they move (step 3 of the statements).
const EVIDENCE_TABLES = Object.freeze(['attendance', 'raid_manual', 'raid_signups', 'attendance_decisions', 'raid_roster', 'raid_duties']);

// A table that references players(id) by a foreign key -> how the join treats it. 'keyed': UPDATE OR IGNORE, what is left goes with the loser by the cascade (keys = the other columns of the
// unique key the person id is part of). 'plain': every row moves (no unique key holds the person id). 'special': see the statements below.
export const JOIN_TABLES = Object.freeze({
  characters: { how: 'special', note: 'the Main steps down and a clashing team is cleared first, then every character moves' },
  raid_signups: { how: 'special', note: 'unique (raid, person) for native sign-ups: the confirmed one wins, else the newer' },
  raid_manual: { how: 'keyed', keys: ['raid_id'] },
  attendance: { how: 'keyed', keys: ['raid_id'] },
  attendance_decisions: { how: 'keyed', keys: ['raid_id'] },
  away_notices: { how: 'plain' },
  standing_signups: { how: 'keyed', keys: ['team_id', 'weekday'] },
  raid_roster: { how: 'plain' },
  intent_picks: { how: 'keyed', keys: ['round_id', 'kind'] },
  applications: { how: 'plain' },
  rank_dismissals: { how: 'keyed', keys: [] },
  launch_status: { how: 'keyed', keys: ['team_id'] },
  raid_duties: { how: 'plain' },
  person_blocks: { how: 'special', note: 'carried to the survivor\'s account as a guild_blocks row when it has one, else moved' },
});
// A table that references players(id) and is NOT joined, with the reason. Empty today: the test fails for a table that is in neither list.
export const JOIN_SKIPPED = Object.freeze({});
// Rows that hold a person id without a foreign key, or reach it through another row (reported in the counts, listed so nobody forgets them).
export const JOIN_LOGICAL = Object.freeze({
  attention_dismissals: 'item ids trial:<person>, trial:<person>:<team> and watch:<team>:<person> are re-keyed',
  character_name_aliases: 'the alias rows belong to a character id; the characters move, the aliases follow (counted)',
  audit_log: 'never rewritten: the Activity view resolves the loser id through person_joins',
  person_joins: 'the journal itself: survivor_player_id / loser_player_id are plain columns',
});

const DISMISSAL_KINDS = "('trial', 'watch')";
const CONFLICT_MESSAGE = 'Someone changed one of these people. Reload and try again.';
const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });

// ---------------------------------------------------------------------------
// Reading

// Every lookup of characters by person names the index: with only "guild_id = ? AND player_id = ?" to go on the planner takes characters_guild_id and walks the
// whole guild (a 1,200-member guild reads 1,200 rows per statement, and a join runs this in about 35 statements).
const BY_PERSON = 'INDEXED BY characters_player';
// The two persons and their characters in ONE statement (the characters of each person as a JSON list): a join request is that much shorter.
const PERSONS_SQL = `SELECT p.id, p.version, p.notes_version, p.created_at, p.user_id, p.discord_user_id, p.discord_nickname, p.joined_on, p.notes,
       (SELECT u.id FROM users u WHERE u.discord_id = p.discord_user_id) AS discord_account_id,
       (SELECT u.discord_id FROM users u WHERE u.id = p.user_id) AS user_discord_id,
       (SELECT g.time_zone FROM guilds g WHERE g.id = p.guild_id) AS time_zone,
       (SELECT json_group_array(json_object('id', c.id, 'player_id', c.player_id, 'team_id', c.team_id, 'is_main', c.is_main, 'name_key', c.name_key))
          FROM characters c ${BY_PERSON} WHERE c.guild_id = p.guild_id AND c.player_id = p.id) AS characters
  FROM players p WHERE p.guild_id = ? AND p.id IN (?, ?)`;

// The owners of a person as a set of keys: the account of players.user_id, the account whose Discord ID the person carries, else the bare Discord ID.
function ownerKeysOf(person) {
  const keys = new Set();
  if (person.user_id) keys.add(`u:${person.user_id}`);
  if (person.discord_user_id) keys.add(person.discord_account_id ? `u:${person.discord_account_id}` : `d:${person.discord_user_id}`);
  return keys;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((key) => b.has(key));

// -> [survivor, loser]
function pickSurvivor(a, b) {
  if (a.user_id && !b.user_id) return [a, b];
  if (b.user_id && !a.user_id) return [b, a];
  const aOlder = a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
  return aOlder ? [a, b] : [b, a];
}

async function loadPlan(db, guildId, aId, bId) {
  const personResult = await db.prepare(PERSONS_SQL).bind(guildId, aId, bId).all();
  const characterResult = { results: personResult.results.flatMap((row) => JSON.parse(row.characters)) };
  const a = personResult.results.find((row) => row.id === aId);
  const b = personResult.results.find((row) => row.id === bId);
  if (!a || !b) throw new HttpError(404, 'not_found', 'That person was not found.');
  const aKeys = ownerKeysOf(a);
  const bKeys = ownerKeysOf(b);
  if (aKeys.size && bKeys.size && !sameSet(aKeys, bKeys)) {
    throw new HttpError(409, 'join_owned_by_two', 'Both people belong to an account, and not to the same one. Only people of one account, or people nobody owns yet, can be joined.');
  }
  const [survivor, loser] = pickSurvivor(a, b);
  const charactersOf = (person) => characterResult.results.filter((row) => row.player_id === person.id);
  const survivorCharacters = charactersOf(survivor);
  const loserCharacters = charactersOf(loser);
  // (A retired placeholder, worker/character-visibility.js, is not counted in the cap.)
  const together = [...survivorCharacters, ...loserCharacters].filter((row) => !isPlaceholderKey(row.name_key)).length;
  if (together > LIMITS.charactersPerPerson) {
    throw new HttpError(409, 'join_too_many_characters',
      `Together they have ${together} characters, and a person can have at most ${LIMITS.charactersPerPerson}. Remove some first.`);
  }
  return { survivor, loser, survivorCharacters, loserCharacters };
}

// ---------------------------------------------------------------------------
// The guard and the statements

// The sign-up the survivor keeps in a raid both signed up for (native sign-ups, unique per raid and person): the confirmed one (a confirmed seat on the raid's
// published roster), else the newer (updated_at, then created_at); a tie stays with the survivor. `s` = the survivor's row, `l` = the loser's row (aliases of the SQL).
const CONFIRMED = (row) => `EXISTS (SELECT 1 FROM raid_roster cr WHERE cr.raid_id = ${row}.raid_id AND cr.player_id = ${row}.player_id AND cr.status = 'confirmed')`;
const loserSignupWins = (s, l) =>
  `(${CONFIRMED(l)} > ${CONFIRMED(s)}
     OR (${CONFIRMED(l)} = ${CONFIRMED(s)} AND COALESCE(${l}.updated_at, ${l}.created_at, 0) > COALESCE(${s}.updated_at, ${s}.created_at, 0)))`;

const keyJoin = (keys) => keys.map((key) => ` AND s.${key} = l.${key}`).join('');

// Counts of the loser's rows per table, read just before the batch (the batch itself moves whatever rows exist when it runs). ONE statement for all tables (one
// scalar subquery per table, each answering a JSON object): a read costs a callback with a statement budget one statement, not one per table.
function countStatement(db, guildId, survivorId, loserId) {
  const names = [];
  const parts = [];
  const bound = [];
  const add = (name, columns, sql, ...params) => {
    names.push(name);
    parts.push(`(SELECT json_object(${columns.map((column) => `'${column}', ${column}`).join(', ')}) FROM (${sql})) AS c_${name}`);
    bound.push(...params);
  };
  const PLAIN = ['total', 'clash'];
  add('characters', ['total', 'team_cleared', 'main_demoted'],
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(l.team_id IS NOT NULL AND l.team_id IN (SELECT s.team_id FROM characters s WHERE s.player_id = ? AND s.team_id IS NOT NULL)), 0) AS team_cleared,
            COALESCE(SUM(l.is_main = 1 AND ${visibleCharacterSql('l')} AND EXISTS (SELECT 1 FROM characters m WHERE m.player_id = ? AND m.is_main = 1 AND ${visibleCharacterSql('m')})), 0) AS main_demoted
       FROM characters l ${BY_PERSON} WHERE l.guild_id = ? AND l.player_id = ?`, survivorId, survivorId, guildId, loserId);
  add('raid_signups', ['total', 'clash', 'loser_wins'],
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(l.source = 'raidsmith' AND EXISTS (SELECT 1 FROM raid_signups s WHERE s.raid_id = l.raid_id AND s.source = 'raidsmith' AND s.player_id = ?)), 0) AS clash,
            COALESCE(SUM(l.source = 'raidsmith' AND EXISTS (SELECT 1 FROM raid_signups s WHERE s.raid_id = l.raid_id AND s.source = 'raidsmith' AND s.player_id = ?
                                                    AND ${loserSignupWins('s', 'l')})), 0) AS loser_wins
       FROM raid_signups l WHERE l.guild_id = ? AND l.player_id = ?`, survivorId, survivorId, guildId, loserId);
  for (const [table, spec] of Object.entries(JOIN_TABLES)) {
    if (spec.how === 'keyed') {
      add(table, PLAIN,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(EXISTS (SELECT 1 FROM ${table} s WHERE s.guild_id = l.guild_id AND s.player_id = ?${keyJoin(spec.keys)})), 0) AS clash
           FROM ${table} l WHERE l.guild_id = ? AND l.player_id = ?`, survivorId, guildId, loserId);
    } else if (spec.how === 'plain') {
      add(table, PLAIN, `SELECT COUNT(*) AS total, 0 AS clash FROM ${table} WHERE guild_id = ? AND player_id = ?`, guildId, loserId);
    }
  }
  add('person_blocks', PLAIN, 'SELECT COUNT(*) AS total, 0 AS clash FROM person_blocks WHERE guild_id = ? AND player_id = ?', guildId, loserId);
  add('attention_dismissals', PLAIN,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(EXISTS (SELECT 1 FROM attention_dismissals x WHERE x.guild_id = d.guild_id AND x.item_id = replace(d.item_id, ?, ?))), 0) AS clash
       FROM attention_dismissals d WHERE d.guild_id = ? AND d.kind IN ${DISMISSAL_KINDS} AND instr(d.item_id, ?) > 0`, loserId, survivorId, guildId, loserId);
  add('character_name_aliases', PLAIN,
    `SELECT COUNT(*) AS total, 0 AS clash FROM character_name_aliases WHERE guild_id = ? AND character_id IN (SELECT id FROM characters ${BY_PERSON} WHERE guild_id = ? AND player_id = ?)`,
    guildId, guildId, loserId);
  const text = `SELECT ${parts.join(',\n       ')}`;
  return { names, statement: db.prepare(text).bind(...bound) };
}

// -> { counts, totals }. counts: { table: { moved, dropped, ... } } where moved = the loser's rows that now belong to the survivor, dropped = rows removed because both
// persons had one (either side's). totals: { table: the loser's rows } (a lean join reads it to leave the empty tables out).
function countsOf(names, result, { survivorAccount }) {
  const row = result.results[0];
  const rows = Object.fromEntries(names.map((name) => [name, JSON.parse(row[`c_${name}`])]));
  const counts = {};
  const totals = {};
  for (const name of names) {
    counts[name] = { moved: rows[name].total - (rows[name].clash || 0), dropped: rows[name].clash || 0 };
    totals[name] = rows[name].total;
  }
  const signups = rows.raid_signups;
  counts.raid_signups = { moved: signups.total - (signups.clash - signups.loser_wins), dropped: signups.clash };
  const characters = rows.characters;
  counts.characters = { moved: characters.total, dropped: 0, teamCleared: characters.team_cleared, mainDemoted: characters.main_demoted };
  const blocks = rows.person_blocks;
  counts.person_blocks = { moved: survivorAccount ? 0 : blocks.total, dropped: 0, guildBlocks: survivorAccount ? blocks.total : 0 };
  counts.character_name_aliases = { moved: rows.character_name_aliases.total, dropped: 0 };
  return { counts, totals };
}

const ACCOUNT_OF_SURVIVOR_SQL = 'COALESCE(sp.user_id, (SELECT u.id FROM users u WHERE u.discord_id = sp.discord_user_id))';

function combinedNotes(survivorNotes, loserNotes) {
  if (!loserNotes) return survivorNotes;
  if (!survivorNotes) return loserNotes;
  return Array.from(`${survivorNotes}\n\n${loserNotes}`).slice(0, MAX_NOTES).join('');
}

export async function joinPersonsStatements(db, {
  guildId, aId, bId, actorUserId, now, reason, randomBytes = defaultRandomBytes, guards = [], expectedVersions = null, lean = false,
}) {
  if (!JOIN_REASONS.includes(reason)) throw new Error('joinPersonsStatements: reason is officer or bnet');
  if (aId === bId) throw bad('Pick two different people to join.', 'otherPersonId');
  const { survivor, loser, survivorCharacters, loserCharacters } = await loadPlan(db, guildId, aId, bId);
  if (expectedVersions) {
    for (const person of [survivor, loser]) {
      if (expectedVersions[person.id] !== undefined && expectedVersions[person.id] !== person.version) throw new HttpError(409, 'conflict', CONFLICT_MESSAGE);
    }
  }
  const S = survivor.id;
  const L = loser.id;

  const survivorTeams = new Set(survivorCharacters.map((row) => row.team_id).filter((id) => id !== null));
  const teamlessCharacterIds = loserCharacters.filter((row) => row.team_id !== null && survivorTeams.has(row.team_id)).map((row) => row.id);
  const survivorHasMain = survivorCharacters.some((row) => row.is_main === 1 && !isPlaceholderKey(row.name_key));
  const survivorHasHiddenMain = survivorCharacters.some((row) => row.is_main === 1 && isPlaceholderKey(row.name_key));
  const survivorAccount = !!(survivor.user_id || survivor.discord_account_id);

  const countRead = countStatement(db, guildId, S, L);
  const [countResult] = await db.batch([countRead.statement]);
  const { counts, totals } = countsOf(countRead.names, countResult, { survivorAccount });

  // A person block on the loser lands on the survivor's account (step 8): only an officer who outranks that account may carry it there.
  let carryGuard = null;
  if (totals.person_blocks > 0 && survivorAccount) {
    const blocked = new HttpError(409, 'join_blocked_person',
      'One of these people is blocked, and joining them would put that block on an account you do not outrank. Ask someone more senior, or lift the block first.');
    if (reason !== 'officer') throw blocked;
    const guard = blockCarryOk(guildId, actorUserId, survivor.user_id || survivor.discord_account_id);
    const allowed = await db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first();
    if (!allowed || allowed.ok !== 1) throw blocked;
    carryGuard = guard;
  }
  const callerGuards = carryGuard ? [...guards, carryGuard] : guards;

  // LEAN (the Battle.net sign-in match, which has a statement budget): a table the loser has no rows in gets no statements. The journal row is inserted only while
  // the loser STILL has none there (a row that appeared after the count makes the batch a no-op: appliedIndex says so, and the caller tries again later), and
  // every other statement asks for the journal row instead of repeating the check (a batch is one transaction, nothing else changes those tables inside it).
  const skipped = new Set(lean ? Object.keys(totals).filter((name) => name !== 'characters' && name !== 'character_name_aliases' && totals[name] === 0) : []);
  const journalId = newId('pj', randomBytes);
  const emptyGuards = [...skipped].map((name) => (name === 'attention_dismissals'
    ? { sql: `NOT EXISTS (SELECT 1 FROM attention_dismissals WHERE guild_id = ? AND kind IN ${DISMISSAL_KINDS} AND instr(item_id, ?) > 0)`, params: [guildId, L] }
    : { sql: `NOT EXISTS (SELECT 1 FROM ${name} WHERE guild_id = ? AND player_id = ?)`, params: [guildId, L] }));
  const journalMarker = { sql: 'EXISTS (SELECT 1 FROM person_joins WHERE id = ?)', params: [journalId] };

  // The survivor's own fields.
  const notes = combinedNotes(survivor.notes, loser.notes);
  const notesChanged = !!loser.notes && notes !== survivor.notes;
  const joinedOn = [survivor.joined_on, loser.joined_on].filter(Boolean).sort()[0] || null;
  const transferDiscord = !!loser.discord_user_id && !survivor.discord_user_id && (!survivor.user_id || loser.discord_user_id === survivor.user_discord_id);

  // The guard of every statement: the guild, the versions of BOTH persons (notes_version too: a notes edit does not bump version), the 20-character cap, and the
  // caller's own guards. After the survivor's own fields were written its version (and notes_version) are the new ones.
  const guardFor = (survivorVersion, survivorNotesVersion, more = []) => ({
    sql: `(SELECT COUNT(*) FROM characters ${BY_PERSON} WHERE guild_id = ? AND player_id IN (?, ?) AND ${visibleCharacterSql('characters')}) <= ${LIMITS.charactersPerPerson}
          AND EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND version = ? AND notes_version = ?)
          AND EXISTS (SELECT 1 FROM players WHERE id = ? AND guild_id = ? AND version = ? AND notes_version = ?)
          ${[...more, ...callerGuards].map((guard) => `AND ${guard.sql}`).join(' ')}`,
    params: [guildId, S, L, S, guildId, survivorVersion, survivorNotesVersion, L, guildId, loser.version, loser.notes_version, ...[...more, ...callerGuards].flatMap((guard) => guard.params)],
  });
  const afterVersion = survivor.version + 1;
  const afterNotesVersion = survivor.notes_version + (notesChanged ? 1 : 0);
  const journalGuard = guardFor(survivor.version, survivor.notes_version, emptyGuards);
  const guard = guardFor(survivor.version, survivor.notes_version, lean ? [journalMarker] : []);
  const guardAfter = guardFor(afterVersion, afterNotesVersion, lean ? [journalMarker] : []);
  const statements = [];
  const guarded = (sql, params, using = guard) => statements.push(db.prepare(sql + ' AND ' + using.sql).bind(...params, ...using.params));

  // 1. The journal row: its changes() says whether the batch applied.
  const opening = lean ? journalGuard : guard;
  statements.push(db.prepare(
    `INSERT INTO person_joins (id, guild_id, survivor_player_id, loser_player_id, counts, joined_by, joined_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${opening.sql}`,
  ).bind(journalId, guildId, S, L, JSON.stringify(counts), actorUserId ?? null, now, ...opening.params));

  // 2. The audit row (ids and counts only; the Activity view resolves the names and the loser's id).
  statements.push(auditStatement({ db, randomBytes, now: () => now }, {
    guildId,
    actorUserId,
    action: 'person.join',
    entityType: 'person',
    entityId: S,
    // The Activity view hands this to the page: the loser's VISIBLE characters by id and how many retired placeholders it had (their ids are never shown).
    before: {
      personId: L,
      characterIds: loserCharacters.filter((row) => !isPlaceholderKey(row.name_key)).map((row) => row.id),
      ...(loserCharacters.some((row) => isPlaceholderKey(row.name_key)) ? { placeholders: loserCharacters.filter((row) => isPlaceholderKey(row.name_key)).length } : {}),
    },
    after: { personId: S, joinId: journalId, via: reason, teamlessCharacterIds },
  }, guard));

  // 3. Raids that hold one of the loser's own rows (results, ticks, decisions, sign-ups, seats, duties): stale, before the rows move.
  if (!EVIDENCE_TABLES.every((name) => skipped.has(name))) guarded(
    `UPDATE raids SET policy_fp = '', version = version + 1
      WHERE guild_id = ?
        AND (id IN (SELECT raid_id FROM attendance WHERE guild_id = ? AND player_id = ?)
          OR id IN (SELECT raid_id FROM raid_manual WHERE guild_id = ? AND player_id = ?)
          OR id IN (SELECT raid_id FROM raid_signups WHERE guild_id = ? AND player_id = ?)
          OR id IN (SELECT raid_id FROM attendance_decisions WHERE guild_id = ? AND player_id = ?)
          OR id IN (SELECT raid_id FROM raid_roster WHERE guild_id = ? AND player_id = ?)
          OR id IN (SELECT raid_id FROM raid_duties WHERE guild_id = ? AND player_id = ?))`,
    [guildId, guildId, L, guildId, L, guildId, L, guildId, L, guildId, L, guildId, L],
  );

  // 4. Characters: one Main (the survivor's stays), one character per team (the survivor's stays, the loser's goes teamless), then all of them move.
  // (A character that goes teamless here loses team_since and, as a Trial, its trial dates by trigger, migration 0040; a join writes no rank, so trial_since stays.)
  if (survivorHasMain) {
    guarded(`UPDATE characters ${BY_PERSON} SET is_main = 0 WHERE guild_id = ? AND player_id = ? AND is_main = 1`, [guildId, L]);
  } else if (survivorHasHiddenMain) {
    // The survivor's only Main is a retired placeholder: the loser's visible Main takes over.
    guarded(`UPDATE characters ${BY_PERSON} SET is_main = 0 WHERE guild_id = ? AND player_id = ? AND is_main = 1 AND ${placeholderCharacterSql('characters')}`, [guildId, S]);
  }
  guarded(
    `UPDATE characters ${BY_PERSON} SET team_id = NULL
      WHERE guild_id = ? AND player_id = ? AND team_id IS NOT NULL
        AND team_id IN (SELECT s.team_id FROM characters s WHERE s.player_id = ? AND s.team_id IS NOT NULL)`,
    [guildId, L, S],
  );
  guarded(`UPDATE characters ${BY_PERSON} SET player_id = ? WHERE guild_id = ? AND player_id = ?`, [S, guildId, L]);

  // 5. Native sign-ups: where both signed up for a raid the winner stays; the rest move.
  if (!skipped.has('raid_signups')) {
    guarded(
      `DELETE FROM raid_signups
        WHERE guild_id = ? AND source = 'raidsmith' AND player_id = ?
          AND EXISTS (SELECT 1 FROM raid_signups l WHERE l.raid_id = raid_signups.raid_id AND l.source = 'raidsmith' AND l.player_id = ?
                        AND ${loserSignupWins('raid_signups', 'l')})`,
      [guildId, S, L],
    );
    guarded('UPDATE OR IGNORE raid_signups SET player_id = ? WHERE guild_id = ? AND player_id = ?', [S, guildId, L]);
    guarded('DELETE FROM raid_signups WHERE guild_id = ? AND player_id = ?', [guildId, L]);
  }

  // 6. The other tables, in the order of JOIN_TABLES.
  for (const [table, spec] of Object.entries(JOIN_TABLES)) {
    if (skipped.has(table)) continue;
    if (spec.how === 'keyed') {
      // What the UPDATE leaves behind is a row the survivor already has: it goes with the loser at step 12 (the composite foreign key cascades; tests/guild/
      // guild-hier-review-fixes-tests.js pins that every keyed table does), so no statement of its own is spent on it.
      guarded(`UPDATE OR IGNORE ${table} SET player_id = ? WHERE guild_id = ? AND player_id = ?`, [S, guildId, L]);
    } else if (spec.how === 'plain') {
      guarded(`UPDATE ${table} SET player_id = ? WHERE guild_id = ? AND player_id = ?`, [S, guildId, L]);
    }
  }

  // 7. Dismissed Needs-attention items name the person inside their id.
  const rekey = `kind IN ${DISMISSAL_KINDS} AND instr(item_id, ?) > 0`;
  if (!skipped.has('attention_dismissals')) {
    guarded(`UPDATE OR IGNORE attention_dismissals SET item_id = replace(item_id, ?, ?) WHERE guild_id = ? AND ${rekey}`, [L, S, guildId, L]);
    guarded(`DELETE FROM attention_dismissals WHERE guild_id = ? AND ${rekey}`, [guildId, L]);
  }

  // 8. A block on the loser: the survivor's account is blocked when it has one (the block follows the person), else the block moves with the person.
  if (!skipped.has('person_blocks')) {
    guarded(
      `INSERT OR IGNORE INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, tombstone_missing)
       SELECT pb.guild_id, ${ACCOUNT_OF_SURVIVOR_SQL}, pb.blocked_by, pb.reason, pb.created_at, pb.tombstone_missing
         FROM person_blocks pb JOIN players sp ON sp.id = ? AND sp.guild_id = pb.guild_id
        WHERE pb.guild_id = ? AND pb.player_id = ? AND ${ACCOUNT_OF_SURVIVOR_SQL} IS NOT NULL`,
      [S, guildId, L],
    );
    guarded(
      `UPDATE OR IGNORE person_blocks SET player_id = ?
        WHERE guild_id = ? AND player_id = ? AND NOT EXISTS (SELECT 1 FROM players sp WHERE sp.id = ? AND sp.guild_id = ? AND ${ACCOUNT_OF_SURVIVOR_SQL} IS NOT NULL)`,
      [S, guildId, L, S, guildId],
    );
  }

  // 9. The survivor now holds every character: its raids (every raid of its teams with evidence, and the raids naming its characters) are stale.
  statements.push(markPersonRaidsStale(db, guildId, S, guard, weekFreeze(survivor.time_zone, now)));

  // 10. The loser's unique fields go, so the survivor can take the Discord pair.
  if (transferDiscord) {
    guarded('UPDATE players SET discord_user_id = NULL, discord_nickname = NULL WHERE id = ? AND guild_id = ?', [L, guildId]);
  }

  // 11. The survivor's own fields (its version moves on: the statements after this one use the new one).
  const sets = ['joined_on = ?', 'version = version + 1', 'updated_at = ?'];
  const setParams = [joinedOn, now];
  if (notesChanged) {
    sets.push('notes = ?', 'notes_updated_by = ?', 'notes_updated_at = ?', 'notes_version = notes_version + 1');
    setParams.push(notes, actorUserId ?? null, now);
  }
  if (transferDiscord) {
    sets.push('discord_user_id = ?', 'discord_nickname = COALESCE(discord_nickname, ?)');
    setParams.push(loser.discord_user_id, loser.discord_nickname);
  }
  guarded(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`, [...setParams, S, guildId]);

  // 12. The loser. Never while a character still names it (the DELETE would cascade to it).
  const deletedIndex = statements.length;
  guarded('DELETE FROM players WHERE id = ? AND guild_id = ? AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ?)', [L, guildId, L], guardAfter);

  return { survivorId: S, loserId: L, statements, counts, journalId, appliedIndex: 0, deletedIndex, teamlessCharacterIds, skippedTables: [...skipped] };
}
