// The person fields that live on `players` today and move to the characters of the person (migration 0030 added characters.core_rank,
// left_on, left_reason, trial_start and trial_end): players.status, trial_start, trial_end, left_on, left_reason.
//
// READS. This module is the ONE place whose SQL reads them (CI: tests/guild/guild-legacy-columns-tests.js). Every other Worker file asks it for a
// fragment and gets a row key named like the column (status, trial_start, trial_end, left_on, left_reason), so lane R2 (the readers switch to the
// character columns) changes these functions and nothing else. Every fragment takes the alias of the players table in the caller's statement and
// holds fixed text, never request data.
//
// WRITES (dual write R1 -> R2). Every writer of the five fields appends syncCharacterRanksStatement to its batch, and every INSERT INTO characters
// names core_rank, so the character columns always equal what migration 0030's backfill (and tools/hierarchy/rederive.sql) derives from players.
//   status raider / trial / reserve -> that core_rank on EVERY character of the person, inactive -> social;
//   left_on + left_reason only when the person is inactive and the reason is left or kicked (else NULL);
//   trial_start / trial_end only on the person's main character and only while the status is trial (else NULL).

const COLUMN = Object.freeze({
  status: 'status',
  trialStart: 'trial_start',
  trialEnd: 'trial_end',
  leftOn: 'left_on',
  leftReason: 'left_reason',
});

export const LEGACY_FIELDS = Object.freeze(Object.keys(COLUMN));

function columnOf(field) {
  if (!Object.prototype.hasOwnProperty.call(COLUMN, field)) throw new Error(`Unknown person field: ${field}`);
  return COLUMN[field];
}

// ---------------------------------------------------------------------------
// Reads

// One column, for a WHERE or ORDER BY term: legacyColumnSql('p', 'trialEnd') -> "p.trial_end".
export const legacyColumnSql = (alias, field) => `${alias}.${columnOf(field)}`;

// A select list: legacyColumnsSql('p', 'status', 'leftOn') -> "p.status, p.left_on" (the row keys are status and left_on).
export const legacyColumnsSql = (alias, ...fields) => fields.map((field) => legacyColumnSql(alias, field)).join(', ');

// All five: status, trial_start, trial_end, left_on, left_reason.
export const legacyPersonColumnsSql = (alias) => legacyColumnsSql(alias, ...LEGACY_FIELDS);

// The predicates the readers share.
export const notInactiveSql = (alias) => `${alias}.status != 'inactive'`;
export const raidingSql = (alias) => `${alias}.status IN ('raider', 'trial')`;
export const onTrialSql = (alias) => `${alias}.status = 'trial'`;

// ---------------------------------------------------------------------------
// Dual write

// The core rank the characters of a person carry, as a value of an INSERT INTO characters: the status of the players row `personIdExpr` names
// ('inactive' -> 'social'). 'raider' (the column default) when that player does not exist, so the foreign key reports it as it always did.
export const coreRankOfPersonSql = (personIdExpr) =>
  `COALESCE((SELECT CASE dp.status WHEN 'inactive' THEN 'social' ELSE dp.status END FROM players dp WHERE dp.id = ${personIdExpr}), 'raider')`;

// The same for a bulk INSERT ... SELECT ... FROM json_each(?) whose items carry the person as $.playerId.
export const CORE_RANK_OF_IMPORTED_CHARACTER_SQL = coreRankOfPersonSql("json_extract(value, '$.playerId')");

// Written out in full: the same five expressions as tools/hierarchy/rederive.sql (a test runs both over every status / reason combination).
const SYNC_CHARACTER_RANKS = `UPDATE characters SET
  core_rank   = (SELECT CASE p.status WHEN 'inactive' THEN 'social' ELSE p.status END FROM players p WHERE p.id = characters.player_id),
  left_on     = (SELECT CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_on END FROM players p WHERE p.id = characters.player_id),
  left_reason = (SELECT CASE WHEN p.status = 'inactive' AND p.left_reason IN ('left', 'kicked') THEN p.left_reason END FROM players p WHERE p.id = characters.player_id),
  trial_start = (SELECT CASE WHEN p.status = 'trial' AND characters.is_main = 1 THEN p.trial_start END FROM players p WHERE p.id = characters.player_id),
  trial_end   = (SELECT CASE WHEN p.status = 'trial' AND characters.is_main = 1 THEN p.trial_end END FROM players p WHERE p.id = characters.player_id)
WHERE guild_id = ? AND player_id IN (SELECT value FROM json_each(?))`;

// One statement for a db.batch: re-derives the five character columns of these persons from their players rows. Idempotent. Append it after the
// last write of a batch that creates a person or a character, changes a status or a date, or moves a main.
// personIds: one id or an array (a bulk import).
export function syncCharacterRanksStatement(db, guildId, personIds) {
  const ids = Array.isArray(personIds) ? personIds : [personIds];
  return db.prepare(SYNC_CHARACTER_RANKS).bind(guildId, JSON.stringify(ids));
}
