/**
 * A stand-in for Cloudflare D1 on node:sqlite, so the Worker's SQL runs for real in `npm test`.
 * It copies the D1 behaviours that bite (see tasks/guild-phase1-spec.md, "D1 fake parity"):
 *   - plain-object rows; first() is null without a row; first(col) throws on an unknown column
 *   - all()/run() return { results, success, meta: { changes, last_row_id, ... } }; RETURNING works
 *   - rejects a wrong number of bindings, undefined, booleans, objects, BigInt, named parameters
 *   - rejects more than 100 bound parameters, and BEGIN / SAVEPOINT / ATTACH / PRAGMA in prepared SQL
 *   - errors start with "D1_ERROR: "; batch() runs in order and rolls back everything on the first error
 *   - foreign keys ON; the real migration files run in order
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_BOUND_PARAMETERS = 100;
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
    if (FORBIDDEN_STATEMENT.test(scrub(sql))) throw d1Error('BEGIN, SAVEPOINT, ATTACH and PRAGMA are not allowed in prepared SQL');
    return new FakeStatement(this, sql);
  }

  execute(statement) {
    const { sql, values } = statement;
    if (values.length !== statement.parameterCount) {
      throw d1Error(`Wrong number of parameter bindings for SQL query: expected ${statement.parameterCount}, got ${values.length}`);
    }
    this.statementLog.push({ sql, values });
    try {
      const prepared = this.sqlite.prepare(sql);
      const before = this.sqlite.prepare('SELECT total_changes() AS n').get().n;
      const rows = prepared.all(...values).map((row) => ({ ...row }));
      const after = this.sqlite.prepare('SELECT total_changes() AS n').get().n;
      const lastRowId = this.sqlite.prepare('SELECT last_insert_rowid() AS id').get().id;
      return {
        results: rows,
        success: true,
        meta: { changes: after - before, last_row_id: Number(lastRowId), duration: 0, rows_read: rows.length, rows_written: after - before },
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

module.exports = { createD1Fake, MAX_BOUND_PARAMETERS };
