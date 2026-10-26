// The person fields that used to live on `players`: status, trial_start, trial_end, left_on, left_reason. Since migration 0030 the CHARACTERS carry them
// (characters.core_rank, left_on, left_reason, trial_start, trial_end), and since lane B2 (release R2) the characters are the only source.
//
// READS: none. Every reader works from the character columns: worker/person-rank.js (personFields, the person-level answers), worker/person-rank-sql.js
// (the main's rank in SQL), worker/team-roster.js (the team-roster predicate).
//
// WRITES: the CHARACTER columns only. Since R4 (lane B4b) nothing writes players.status / trial_start / trial_end / left_on / left_reason: the mirror is gone, and
// tests/guild/guild-legacy-columns-tests.js allows no reader and no writer of them. The old columns stay in the schema (no migration). One exception that is not a
// value: players.status is NOT NULL with a CHECK and no default (migration 0002) and a table other tables reference is never rebuilt, so every INSERT INTO
// players still names it and gives the literal 'raider'. It is never read and never updated; the CI pins that literal and nothing else.
// The mapping a person's status writes onto the characters is migration 0030's:
//   status raider / trial / reserve -> that core_rank on EVERY character of the person, inactive -> social;
//   left_on + left_reason only when the person is inactive and the reason is left or kicked (else NULL; a break or an "other" is not kept);
//   trial_start / trial_end only on the person's main character and only while the status is trial (else NULL).
// In a guild whose rank source is the in-game roster the same columns are written by worker/rank-map.js applyRankMap instead (the officer edit is refused there).
// A character that joins a person later takes the person's rank and left date from the person's MAIN in the same statement (RANK_COLUMNS_SQL), so there is
// no read-then-write race between a new character and a status change.

// The five character columns a person status (and its dates) maps to: { coreRank, leftOn, leftReason, trialStart, trialEnd }. Pure. The trial dates are
// the MAIN character's; every other character of the person gets NULL for them.
export function characterRankColumns({ status, leftOn = null, leftReason = null, trialStart = null, trialEnd = null }) {
  const left = status === 'inactive' && (leftReason === 'left' || leftReason === 'kicked');
  const trial = status === 'trial';
  return {
    coreRank: status === 'inactive' ? 'social' : status,
    leftOn: left ? leftOn : null,
    leftReason: left ? leftReason : null,
    trialStart: trial ? trialStart : null,
    trialEnd: trial ? trialEnd : null,
  };
}

// ---------------------------------------------------------------------------
// A new character

// The last five values of an INSERT INTO characters (... core_rank, left_on, left_reason, trial_start, trial_end): the values given, else the person's main.
// Eight placeholders, bound with rankBinds(rank, personId). `rank` is characterRankColumns(...) for the first character of a new person (the main) and
// null for every later one (an alt takes core_rank, left_on and left_reason of the person's main and no trial dates).
export const RANK_COLUMNS_SQL = `COALESCE(?, (SELECT m.core_rank FROM characters m WHERE m.player_id = ? AND m.is_main = 1), 'raider'),
       COALESCE(?, (SELECT m.left_on FROM characters m WHERE m.player_id = ? AND m.is_main = 1)),
       COALESCE(?, (SELECT m.left_reason FROM characters m WHERE m.player_id = ? AND m.is_main = 1)), ?, ?`;

export function rankBinds(rank, personId) {
  const given = rank || {};
  const or = (value) => (value === undefined ? null : value);
  return [or(given.coreRank), personId, or(given.leftOn), personId, or(given.leftReason), personId, or(given.trialStart), or(given.trialEnd)];
}

// The same for a bulk INSERT ... SELECT ... FROM json_each(?) j whose items carry { playerId, coreRank?, leftOn?, leftReason?, trialStart?, trialEnd? }.
const mainOf = (column) => `(SELECT m.${column} FROM characters m WHERE m.player_id = json_extract(j.value, '$.playerId') AND m.is_main = 1)`;
export const IMPORTED_RANK_COLUMNS_SQL = `COALESCE(json_extract(j.value, '$.coreRank'), ${mainOf('core_rank')}, 'raider'),
              COALESCE(json_extract(j.value, '$.leftOn'), ${mainOf('left_on')}), COALESCE(json_extract(j.value, '$.leftReason'), ${mainOf('left_reason')}),
              json_extract(j.value, '$.trialStart'), json_extract(j.value, '$.trialEnd')`;

// ---------------------------------------------------------------------------
// An existing person

// One statement for a db.batch: every character of the person takes the rank, left date and reason of `columns` (characterRankColumns), the trial dates
// only on the main. guard: { sql, params } makes it conditional (the person writer repeats its own optimistic checks here, so a lost race changes nothing).
// updated_at = now (required) is the Trial clock's floor (worker/trial-clock.js): the day a rank was last written. guard: null for none.
export function setCharacterRanksStatement(db, guildId, personId, columns, guard, now) {
  return db.prepare(
    `UPDATE characters SET core_rank = ?, left_on = ?, left_reason = ?,
            trial_start = CASE WHEN is_main = 1 THEN ? END, trial_end = CASE WHEN is_main = 1 THEN ? END, updated_at = ?
      WHERE guild_id = ? AND player_id = ?${guard ? ` AND ${guard.sql}` : ''}`,
  ).bind(columns.coreRank, columns.leftOn, columns.leftReason, columns.trialStart, columns.trialEnd, now, guildId, personId, ...(guard ? guard.params : []));
}

// Two statements for a db.batch, AFTER the statements that moved the main from oldMainId to newMainId: the trial dates sit on the main, so they move with
// it. Both do nothing when the move did not happen (the old main is still the main). The copy also does nothing when the old main holds no trial dates:
// that is the loser of a race in which another request already made the same move (the dates left the old main with it), whose copy would overwrite the
// new main's dates with NULL.
export function trialDatesFollowMainStatements(db, oldMainId, newMainId) {
  return [
    db.prepare(
      `UPDATE characters SET trial_start = (SELECT o.trial_start FROM characters o WHERE o.id = ?1), trial_end = (SELECT o.trial_end FROM characters o WHERE o.id = ?1)
        WHERE id = ?2 AND is_main = 1
          AND EXISTS (SELECT 1 FROM characters o WHERE o.id = ?1 AND (o.trial_start IS NOT NULL OR o.trial_end IS NOT NULL))`,
    ).bind(oldMainId, newMainId),
    db.prepare('UPDATE characters SET trial_start = NULL, trial_end = NULL WHERE id = ? AND is_main = 0').bind(oldMainId),
  ];
}
