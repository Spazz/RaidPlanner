// The one place that reads D1's `meta.changes` (tests/guild/guild-d1-changes-tests.js scans worker/ for any other read).
//
// meta.changes is NOT the number of rows the statement changed. Measured on D1 (the table in tests/d1-fake.js): it is SQLite's total_changes() delta, so it also counts every row a
// TRIGGER wrote (BEFORE, AFTER and nested ones) and every row a FOREIGN-KEY ACTION wrote (ON DELETE CASCADE, ON DELETE SET NULL, ON UPDATE CASCADE). One UPDATE of one players,
// characters or raid_signups row can say 2, 3 or 4; the delete of a guild says hundreds. The SQL function changes(), read inside the same batch, leaves those rows out and counts
// the statement's own rows only. So `meta.changes === 1` / `!== 1` refuses a write that happened, with a 409 after the data changed, whenever a trigger or a cascade runs.
//
// Two questions, two tools:
//   1. "Did the guarded write happen?"   -> wrote(result). A trigger or a cascade only runs after a direct row changed, so meta.changes >= 1 holds exactly when the statement's own
//      row count is >= 1. Every guard of the Worker is a single-row (or all-or-nothing) statement, so "at least one" is the whole question. The one gap, a BEFORE trigger that
//      writes before an INSERT OR IGNORE / ON CONFLICT DO NOTHING drops its row, is closed by never asking wrote() of such a statement: those sites ask for an exact count
//      (or read RETURNING) instead.
//   2. "How many rows did it change?"    -> the statement's OWN count, which meta.changes cannot give. Put directRowsStatement(db) right behind the counted statement in the
//      batch (a SELECT leaves changes() as the write left it, so the statements in between are safe; any INSERT / UPDATE / DELETE is not) and read it with directRows(result)
//      from the result at that position. A single statement outside a batch: countedRun(db, statement). A statement with RETURNING counts its returned rows (result.results.length).
// The SQL guards `... WHERE changes() = 1` inside a batch are exact and stay as they are.

// True when the statement changed at least one row of its own (and so any trigger or cascade it fired ran).
export function wrote(result) {
  return result.meta.changes >= 1;
}

// A statement that reads SQLite's changes(): the own-row count of the write just before it in the same batch.
export function directRowsStatement(db) {
  return db.prepare('SELECT changes() AS n');
}

// The own-row count out of the result of a directRowsStatement.
export function directRows(result) {
  return Number(result.results[0].n);
}

// Runs one write on its own and returns its own-row count (triggers and cascades left out): the write and the counter in one batch.
export async function countedRun(db, statement) {
  const results = await db.batch([statement, directRowsStatement(db)]);
  return directRows(results[1]);
}
