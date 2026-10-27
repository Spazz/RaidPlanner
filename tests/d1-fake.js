/**
 * A stand-in for Cloudflare D1 on node:sqlite, so the Worker's SQL runs for real in `npm test`.
 * It copies the D1 behaviours that bite (see tasks/reference/guild-phase1-spec.md, "D1 fake parity"):
 *   - plain-object rows; first() is null without a row; first(col) throws on an unknown column
 *   - all()/run() return { results, success, meta: { changes, last_row_id, ... } }; RETURNING works
 *   - rejects a wrong number of bindings, undefined, booleans, objects, BigInt, named parameters
 *   - rejects more than 100 bound parameters, SQL over 100 KB, a compound SELECT (UNION / INTERSECT / EXCEPT) of more than 5 terms
 *     at one nesting level (node:sqlite exposes no setLimit; D1's limit is 5, SQLite's own 500), and BEGIN / SAVEPOINT / ATTACH / PRAGMA in prepared SQL
 *   - errors start with "D1_ERROR: "; batch() runs in order and rolls back everything on the first error
 *   - foreign keys ON; the real migration files run in order
 *   - triggers (RAISE(ABORT) rolls a batch back whole), composite foreign keys, partial unique indexes and json_each run
 *     natively; guild-roster-worker-tests.js pins each of them ('schema' and 'd1 fake parity' checks)
 *   - meta.changes is SQLite's total_changes() delta, NOT changes() (next paragraph); tests/guild/guild-d1-changes-tests.js pins every case
 *
 * meta.changes on real D1 (measured 2026-10-27 on local D1, wrangler 4.146.0, through a Worker binding, one statement per call):
 *   It is the delta of total_changes(): the statement's own rows PLUS every row a trigger or a foreign-key action wrote. The SQL function
 *   changes() read in the same batch counts the statement's own rows only, so a guard like `... WHERE changes() = 1` is exact.
 *     case                                                                       meta.changes   SQL changes() after it
 *     UPDATE 1 row, no trigger                                                        1              1
 *     UPDATE 1 row, AFTER UPDATE trigger updating 3 other rows                        4              1
 *     UPDATE 1 row, BEFORE UPDATE trigger updating 2 other rows                       3              1
 *     UPDATE 0 rows (nothing matches), so the trigger never fires                     0              0
 *     UPDATE 1 row, trigger WHEN false / a trigger that fires and writes nothing     1 / 1          1
 *     UPDATE 1 row, nested triggers (table 1 trigger updates table 2, whose inserts)  3              1
 *     UPDATE 3 rows, a trigger inserting 1 row per row                                6              3
 *     UPDATE 1 parent row, ON UPDATE CASCADE to 2 child rows                          3              1
 *     INSERT 1 row, no trigger                                                        1              1
 *     INSERT 1 row, AFTER INSERT trigger inserting 1 row / 3 rows                     2 / 4          1
 *     INSERT 1 row, BEFORE INSERT trigger inserting 2 rows                            3              1
 *     INSERT ... SELECT 3 rows, no trigger / an AFTER INSERT trigger per row          3 / 6          3 / not measured
 *     INSERT ... ON CONFLICT DO UPDATE with AFTER INSERT + AFTER UPDATE triggers      2 (both paths) 1
 *     INSERT ... ON CONFLICT DO NOTHING (conflict)                                    0              0
 *     INSERT OR REPLACE over 1 existing row, no trigger (replaced row not counted)    1              1
 *     INSERT OR REPLACE over 1 existing row, AFTER INSERT trigger                     2              not measured
 *     INSERT / UPDATE ... RETURNING, a 3-row trigger (RETURNING gives 1 row)          4 / 4          1
 *     DELETE 1 row, no trigger                                                        1              1
 *     DELETE 1 row, AFTER DELETE trigger deleting 2 rows                              3              1
 *     DELETE 1 row, BEFORE DELETE trigger inserting 1 row                             2              1
 *     DELETE 1 parent row with 3 ON DELETE CASCADE children                           4              1
 *     DELETE 1 parent row with 2 ON DELETE SET NULL children                          3              1
 *     DELETE 1 parent row, 2 cascade children that have an AFTER DELETE trigger       5              1
 *     DELETE FROM t (no WHERE, 3 rows, no trigger)                                    3              3
 *     SELECT                                                                          0              (unchanged inside a batch)
 *   The earlier belief "D1 does not count foreign-key cascades" was wrong: it counts ON DELETE CASCADE, ON DELETE SET NULL and ON UPDATE
 *   CASCADE rows, BEFORE and AFTER trigger rows and nested trigger rows. rows_written is a different number on D1 (it also counts index and
 *   sqlite_sequence writes) and is not mirrored here. Production D1 is assumed to report the same; worker/ does not depend on it
 *   (worker/d1-changes.js reads only "at least one direct row", or an exact count taken from RETURNING / SQL changes()).
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_BOUND_PARAMETERS = 100;
const MAX_COMPOUND_TERMS = 5; // D1: "too many terms in compound SELECT" above this
const MAX_SQL_BYTES = 100_000;
const FORBIDDEN_STATEMENT = /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA)\b/i;

function d1Error(message) {
  return new Error(`D1_ERROR: ${message}`);
}

// The SQL with string literals, quoted identifiers and comments blanked out, for scanning.
function scrub(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// The largest number of terms in any one compound SELECT (operators at one parenthesis level + 1), counted on scrubbed SQL.
function maxCompoundTerms(scrubbed) {
  const stack = [0];
  let most = 1;
  for (const match of scrubbed.matchAll(/\(|\)|\b(?:UNION|INTERSECT|EXCEPT)\b/gi)) {
    const token = match[0];
    if (token === '(') stack.push(0);
    else if (token === ')') { if (stack.length > 1) stack.pop(); }
    else {
      stack[stack.length - 1] += 1;
      most = Math.max(most, stack[stack.length - 1] + 1);
    }
  }
  return most;
}

function countParameters(scrubbed) {
  if (/[:@$][A-Za-z_]/.test(scrubbed)) throw d1Error('named parameters are not supported');
  let numbered = 0;
  let bare = 0;
  for (const match of scrubbed.matchAll(/\?(\d+)?/g)) {
    if (match[1]) numbered = Math.max(numbered, Number(match[1]));
    else bare++;
  }
  return numbered || bare;
}

function checkValue(value, index) {
  if (value === null || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw d1Error(`Type 'number' at index ${index} is not a finite number`);
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  throw d1Error(`Type '${value === undefined ? 'undefined' : typeof value}' not supported for value '${String(value)}'`);
}

class FakeStatement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
    this.parameterCount = owner.parameterCountOf(sql);
  }

  bind(...values) {
    if (values.length > MAX_BOUND_PARAMETERS) throw d1Error(`too many SQL variables (${values.length} > ${MAX_BOUND_PARAMETERS})`);
    values.forEach(checkValue);
    return new FakeStatement(this.owner, this.sql, values);
  }

  execute() {
    return this.owner.execute(this);
  }

  async first(column) {
    const { results } = this.owner.execute(this);
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.prototype.hasOwnProperty.call(row, column)) throw d1Error(`no such column: ${column}`);
    return row[column];
  }

  async all() {
    return this.owner.execute(this);
  }

  async run() {
    return this.owner.execute(this);
  }

  async raw() {
    return this.owner.execute(this).results.map((row) => Object.values(row));
  }
}

class D1Fake {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.statementLog = [];
  }

  parameterCountOf(sql) {
    return countParameters(scrub(sql));
  }

  prepare(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw d1Error('empty SQL');
    if (Buffer.byteLength(sql) > MAX_SQL_BYTES) throw d1Error('statement too long (over 100 KB)');
    const terms = maxCompoundTerms(scrub(sql));
    if (terms > MAX_COMPOUND_TERMS) throw d1Error(`too many terms in compound SELECT (${terms} > ${MAX_COMPOUND_TERMS}): SQLITE_ERROR`);
    if (FORBIDDEN_STATEMENT.test(scrub(sql))) throw d1Error('BEGIN, SAVEPOINT, ATTACH and PRAGMA are not allowed in prepared SQL');
    return new FakeStatement(this, sql);
  }

  execute(statement) {
    const { sql, values } = statement;
    if (values.length !== statement.parameterCount) {
      throw d1Error(`Wrong number of parameter bindings for SQL query: expected ${statement.parameterCount}, got ${values.length}`);
    }
    // rowsRead: the rows the statement RETURNED (the stand-in's rows_read; the budget suites sum it per request). Set once the statement ran.
    const logged = { sql, values, rowsRead: 0 };
    this.statementLog.push(logged);
    try {
      const prepared = this.sqlite.prepare(sql);
      const before = this.sqlite.prepare('SELECT total_changes() AS n').get().n;
      const rows = prepared.all(...values).map((row) => ({ ...row }));
      logged.rowsRead = rows.length;
      const after = this.sqlite.prepare('SELECT total_changes() AS n').get().n;
      // D1 reports the total_changes() delta: the statement's own rows plus the rows its triggers and its foreign-key actions wrote
      // (measured, see the header). SQLite's changes() leaves those out. A statement that wrote nothing reports 0.
      const changes = after - before;
      const lastRowId = this.sqlite.prepare('SELECT last_insert_rowid() AS id').get().id;
      return {
        results: rows,
        success: true,
        meta: { changes, last_row_id: Number(lastRowId), duration: 0, rows_read: rows.length, rows_written: after - before },
      };
    } catch (error) {
      if (error && /^D1_ERROR/.test(error.message)) throw error;
      throw d1Error(`${error.message}: SQLITE_ERROR`);
    }
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.some((entry) => !(entry instanceof FakeStatement))) {
      throw d1Error('batch() takes prepared statements');
    }
    const results = [];
    this.sqlite.exec('BEGIN');
    try {
      for (const statement of statements) results.push(this.execute(statement));
      this.sqlite.exec('COMMIT');
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
    return results;
  }

  close() {
    this.sqlite.close();
  }
}

// A database with every migration applied, in file-name order.
function createD1Fake({ migrationsDir = path.join(__dirname, '..', 'migrations') } = {}) {
  const db = new D1Fake();
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) db.sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  return db;
}

module.exports = { createD1Fake, MAX_BOUND_PARAMETERS, MAX_COMPOUND_TERMS, maxCompoundTerms, scrub };
