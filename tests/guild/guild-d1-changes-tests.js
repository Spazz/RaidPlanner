/**
 * Raidsmith guild tracker - D1 meta.changes (lane D1 "change counts")
 * Run: node tests/guild/guild-d1-changes-tests.js
 *
 * Real D1 reports SQLite's total_changes() delta in meta.changes: the statement's own rows PLUS every row a trigger or a foreign-key action wrote (measured on local D1,
 * wrangler 4.146.0; the full table is in the header of tests/d1-fake.js). The SQL function changes() counts the statement's own rows only. This suite
 *   1. pins every measured case on the fake (tests/d1-fake.js reports meta.changes exactly as D1 does, so the suites see what production sees),
 *   2. pins the helper (worker/d1-changes.js: wrote, directRowsStatement, directRows, countedRun),
 *   3. scans worker/ for any other read of meta.changes (CI source scan, with a self-test of the detector on seeded sources).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { workerFiles } = require('../worker-sql');

const ROOT = path.join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// 1. The fake: the schema of the probe that measured D1, one table per trigger / cascade shape

const SCHEMA = [
  'CREATE TABLE t_plain (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE other (id INTEGER PRIMARY KEY, grp INTEGER, n INTEGER DEFAULT 0)',
  'CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)',
  'CREATE TABLE t_au (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TRIGGER t_au_tr AFTER UPDATE ON t_au BEGIN UPDATE other SET n = n + 1 WHERE grp = 1; END',
  'CREATE TABLE t_ai (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_ai_tr AFTER INSERT ON t_ai BEGIN INSERT INTO log (note) VALUES ('ai'); END",
  'CREATE TABLE t_ai3 (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_ai3_tr AFTER INSERT ON t_ai3 BEGIN INSERT INTO log (note) VALUES ('a'); INSERT INTO log (note) VALUES ('b'); INSERT INTO log (note) VALUES ('c'); END",
  'CREATE TABLE t_bu (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TRIGGER t_bu_tr BEFORE UPDATE ON t_bu BEGIN UPDATE other SET n = n + 1 WHERE grp = 2; END',
  'CREATE TABLE t_bi (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_bi_tr BEFORE INSERT ON t_bi BEGIN INSERT INTO log (note) VALUES ('b1'); INSERT INTO log (note) VALUES ('b2'); END",
  'CREATE TABLE t_ad (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TRIGGER t_ad_tr AFTER DELETE ON t_ad BEGIN DELETE FROM other WHERE grp = 3; END',
  'CREATE TABLE t_bd (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_bd_tr BEFORE DELETE ON t_bd BEGIN INSERT INTO log (note) VALUES ('bd'); END",
  'CREATE TABLE t_when (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_when_tr AFTER UPDATE ON t_when WHEN new.v = 'never' BEGIN UPDATE other SET n = n + 1 WHERE grp = 1; END",
  'CREATE TABLE t_zero (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TRIGGER t_zero_tr AFTER UPDATE ON t_zero BEGIN UPDATE other SET n = n + 1 WHERE grp = 999; END',
  'CREATE TABLE t_n1 (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE t_n2 (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_n1_tr AFTER UPDATE ON t_n1 BEGIN UPDATE t_n2 SET v = 'x' WHERE id = 1; END",
  "CREATE TRIGGER t_n2_tr AFTER UPDATE ON t_n2 BEGIN INSERT INTO log (note) VALUES ('n2'); END",
  'CREATE TABLE t_up (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_up_ai AFTER INSERT ON t_up BEGIN INSERT INTO log (note) VALUES ('up_ai'); END",
  "CREATE TRIGGER t_up_au AFTER UPDATE ON t_up BEGIN INSERT INTO log (note) VALUES ('up_au'); END",
  'CREATE TABLE t_rep (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE t_rep_tr (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_rep_tr_ai AFTER INSERT ON t_rep_tr BEGIN INSERT INTO log (note) VALUES ('rep'); END",
  'CREATE TABLE t_src (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE t_dst (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE t_dst_tr (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_dst_tr_ai AFTER INSERT ON t_dst_tr BEGIN INSERT INTO log (note) VALUES ('x'); END",
  'CREATE TABLE p_cas (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE c_cas (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p_cas(id) ON DELETE CASCADE)',
  'CREATE TABLE p_nul (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE c_nul (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p_nul(id) ON DELETE SET NULL)',
  'CREATE TABLE p_ucas (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE c_ucas (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p_ucas(id) ON UPDATE CASCADE)',
  'CREATE TABLE p_ct (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE c_ct (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p_ct(id) ON DELETE CASCADE)',
  "CREATE TRIGGER c_ct_tr AFTER DELETE ON c_ct BEGIN INSERT INTO log (note) VALUES ('ct'); END",
  'CREATE TABLE t_trunc (id INTEGER PRIMARY KEY, v TEXT)',
  'CREATE TABLE t_multi (id INTEGER PRIMARY KEY, v TEXT)',
  "CREATE TRIGGER t_multi_tr AFTER UPDATE ON t_multi BEGIN INSERT INTO log (note) VALUES ('m'); END",
  // seeds (the triggers above only write the log table, which no case reads)
  'INSERT INTO other (grp, n) VALUES (1,0),(1,0),(1,0),(2,0),(2,0),(3,0),(3,0)',
  "INSERT INTO t_plain VALUES (1,'a'),(2,'b')",
  "INSERT INTO t_au VALUES (1,'a'),(2,'b')",
  "INSERT INTO t_bu VALUES (1,'a')",
  "INSERT INTO t_ad VALUES (1,'a'),(2,'b')",
  "INSERT INTO t_bd VALUES (1,'a')",
  "INSERT INTO t_when VALUES (1,'a')",
  "INSERT INTO t_zero VALUES (1,'a')",
  "INSERT INTO t_n1 VALUES (1,'a')",
  "INSERT INTO t_n2 VALUES (1,'a')",
  "INSERT INTO t_up VALUES (1,'a')",
  "INSERT INTO t_rep VALUES (1,'a')",
  "INSERT INTO t_rep_tr VALUES (1,'a')",
  "INSERT INTO t_src VALUES (1,'a'),(2,'b'),(3,'c')",
  "INSERT INTO p_cas VALUES (1,'a'),(2,'b')",
  'INSERT INTO c_cas (pid) VALUES (1),(1),(1),(2)',
  "INSERT INTO p_nul VALUES (1,'a')",
  'INSERT INTO c_nul (pid) VALUES (1),(1)',
  "INSERT INTO p_ucas VALUES (1,'a')",
  'INSERT INTO c_ucas (pid) VALUES (1),(1)',
  "INSERT INTO p_ct VALUES (1,'a')",
  'INSERT INTO c_ct (pid) VALUES (1),(1)',
  "INSERT INTO t_trunc VALUES (1,'a'),(2,'b'),(3,'c')",
  "INSERT INTO t_multi VALUES (1,'a'),(2,'b'),(3,'c')",
];

let schemaDir = null;
function schemaFolder() {
  if (schemaDir) return schemaDir;
  schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-d1changes-'));
  fs.writeFileSync(path.join(schemaDir, '0001_probe.sql'), `${SCHEMA.join(';\n')};\n`);
  return schemaDir;
}
const freshDb = () => createD1Fake({ migrationsDir: schemaFolder() });

// Every case of the measured table: [name, sql, meta.changes on D1, SQL changes() right after it (null: not measured)]. One fresh database per case.
const SINGLE_CASES = [
  ['UPDATE 1 row, no trigger', "UPDATE t_plain SET v = 'z' WHERE id = 1", 1, 1],
  ['UPDATE 1 row, AFTER UPDATE trigger updating 3 other rows', "UPDATE t_au SET v = 'z' WHERE id = 1", 4, 1],
  ['UPDATE 1 row, BEFORE UPDATE trigger updating 2 other rows', "UPDATE t_bu SET v = 'z' WHERE id = 1", 3, 1],
  ['UPDATE 0 rows, so the trigger never fires', "UPDATE t_au SET v = 'z' WHERE id = 99", 0, 0],
  ['UPDATE 1 row, trigger WHEN false', "UPDATE t_when SET v = 'z' WHERE id = 1", 1, 1],
  ['UPDATE 1 row, trigger fires and writes nothing', "UPDATE t_zero SET v = 'z' WHERE id = 1", 1, 1],
  ['UPDATE 1 row, nested triggers (table 1 updates table 2, whose trigger inserts)', "UPDATE t_n1 SET v = 'z' WHERE id = 1", 3, 1],
  ['UPDATE 3 rows, a trigger inserting 1 row per row', "UPDATE t_multi SET v = 'z'", 6, 3],
  ['UPDATE 1 parent row, ON UPDATE CASCADE to 2 child rows', 'UPDATE p_ucas SET id = 5 WHERE id = 1', 3, 1],
  ['INSERT 1 row, no trigger', "INSERT INTO t_plain VALUES (10,'n')", 1, 1],
  ['INSERT 1 row, AFTER INSERT trigger inserting 1 row', "INSERT INTO t_ai VALUES (1,'a')", 2, 1],
  ['INSERT 1 row, AFTER INSERT trigger inserting 3 rows', "INSERT INTO t_ai3 VALUES (1,'a')", 4, 1],
  ['INSERT 1 row, BEFORE INSERT trigger inserting 2 rows', "INSERT INTO t_bi VALUES (1,'a')", 3, 1],
  ['INSERT ... SELECT 3 rows, no trigger', "INSERT INTO t_dst SELECT * FROM t_src", 3, 3],
  ['INSERT ... SELECT 3 rows, an AFTER INSERT trigger per row', 'INSERT INTO t_dst_tr SELECT * FROM t_src', 6, null],
  ['INSERT ... ON CONFLICT DO UPDATE, insert path, AFTER INSERT trigger', "INSERT INTO t_up VALUES (2,'n') ON CONFLICT(id) DO UPDATE SET v = excluded.v", 2, 1],
  ['INSERT ... ON CONFLICT DO UPDATE, update path, AFTER UPDATE trigger', "INSERT INTO t_up VALUES (1,'n') ON CONFLICT(id) DO UPDATE SET v = excluded.v", 2, 1],
  ['INSERT ... ON CONFLICT DO NOTHING on a conflict', "INSERT INTO t_plain VALUES (1,'n') ON CONFLICT(id) DO NOTHING", 0, 0],
  ['INSERT OR REPLACE over 1 existing row (the replaced row is not counted)', "INSERT OR REPLACE INTO t_rep VALUES (1,'n')", 1, 1],
  ['INSERT OR REPLACE over 1 existing row, AFTER INSERT trigger', "INSERT OR REPLACE INTO t_rep_tr VALUES (1,'n')", 2, null],
  ['INSERT ... RETURNING with a 3-row trigger', "INSERT INTO t_ai3 VALUES (2,'a') RETURNING id", 4, 1],
  ['UPDATE ... RETURNING with a 3-row trigger', "UPDATE t_au SET v = 'y' WHERE id = 2 RETURNING id", 4, 1],
  ['DELETE 1 row, no trigger', 'DELETE FROM t_plain WHERE id = 2', 1, 1],
  ['DELETE 1 row, AFTER DELETE trigger deleting 2 rows', 'DELETE FROM t_ad WHERE id = 1', 3, 1],
  ['DELETE 1 row, BEFORE DELETE trigger inserting 1 row', 'DELETE FROM t_bd WHERE id = 1', 2, 1],
  ['DELETE 1 parent row with 3 ON DELETE CASCADE children', 'DELETE FROM p_cas WHERE id = 1', 4, 1],
  ['DELETE 1 parent row with 2 ON DELETE SET NULL children', 'DELETE FROM p_nul WHERE id = 1', 3, 1],
  ['DELETE 1 parent row, 2 cascade children that have an AFTER DELETE trigger', 'DELETE FROM p_ct WHERE id = 1', 5, 1],
  ['DELETE FROM t (no WHERE, 3 rows)', 'DELETE FROM t_trunc', 3, 3],
  ['SELECT', 'SELECT count(*) AS n FROM other', 0, null],
];

for (const [name, sql, changes, direct] of SINGLE_CASES) {
  check(`fake: meta.changes ${changes}${direct === null ? '' : `, changes() ${direct}`}: ${name}`, async () => {
    const db = freshDb();
    const result = await db.prepare(sql).run();
    assert.equal(result.meta.changes, changes, 'meta.changes of the single statement');
    assert(Number.isInteger(result.meta.changes));
    if (direct !== null) {
      const batchDb = freshDb();
      const [first, second] = await batchDb.batch([batchDb.prepare(sql), batchDb.prepare('SELECT changes() AS n')]);
      assert.equal(first.meta.changes, changes, 'meta.changes of the same statement inside a batch');
      assert.equal(second.meta.changes, 0, 'a SELECT changes nothing');
      assert.deepEqual(second.results, [{ n: direct }], 'SQL changes() counts the statement\'s own rows only');
    }
  });
}

check('fake: a guarded INSERT ... SELECT WHERE changes() = 1 behind a trigger-firing UPDATE still applies (the SQL guards stay exact)', async () => {
  const db = freshDb();
  const results = await db.batch([
    db.prepare("UPDATE t_au SET v = 'q' WHERE id = 1"),
    db.prepare('SELECT changes() AS n'),
    db.prepare("INSERT INTO log (note) SELECT 'guarded' WHERE changes() = 1"),
  ]);
  assert.deepEqual(results.map((one) => one.meta.changes), [4, 0, 1]);
  assert.deepEqual(results[1].results, [{ n: 1 }]);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM log WHERE note = 'guarded'").first()).n, 1);
});

check('fake: UPDATE ... AND changes() = 1 chained behind a plain UPDATE; the second one says 4 with its trigger rows', async () => {
  const db = freshDb();
  const results = await db.batch([
    db.prepare("UPDATE t_plain SET v = 'g' WHERE id = 1"),
    db.prepare("UPDATE t_au SET v = 'g' WHERE id = 1 AND changes() = 1"),
    db.prepare('SELECT changes() AS n'),
  ]);
  assert.deepEqual(results.map((one) => one.meta.changes), [1, 4, 0]);
  assert.deepEqual(results[2].results, [{ n: 1 }]);
});

check('fake: the other measured batches (INSERT with a 3-row trigger, cascade delete, 3-row UPDATE, upsert)', async () => {
  const cases = [
    [["INSERT INTO t_ai3 VALUES (3,'a')"], 4, 1],
    [['DELETE FROM p_cas WHERE id = 2'], 2, 1],
    [["UPDATE t_multi SET v = 'w'"], 6, 3],
    [["INSERT INTO t_up VALUES (1,'m') ON CONFLICT(id) DO UPDATE SET v = excluded.v"], 2, 1],
  ];
  for (const [sqls, changes, direct] of cases) {
    const db = freshDb();
    const results = await db.batch([...sqls.map((sql) => db.prepare(sql)), db.prepare('SELECT changes() AS n')]);
    assert.equal(results[0].meta.changes, changes, sqls[0]);
    assert.deepEqual(results[1].results, [{ n: direct }], sqls[0]);
  }
});

check('fake: a statement that wrote nothing at all reports 0 (a SELECT leaves changes() stale, the delta does not)', async () => {
  const db = freshDb();
  await db.prepare("UPDATE t_plain SET v = 'z' WHERE id = 1").run();
  assert.equal((await db.prepare('SELECT count(*) AS n FROM other').run()).meta.changes, 0);
  assert.equal((await db.prepare("UPDATE t_plain SET v = 'z' WHERE id = 99").run()).meta.changes, 0);
});

check('fake: every migration of the Worker still runs, and one UPDATE of a characters row says more than 1 when the 0040 trigger fires', async () => {
  const db = createD1Fake();
  const now = 1_700_000_000_000;
  await db.batch([
    db.prepare(
      "INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at) VALUES ('g1', 'G', 'R', 'realm', 'US', '900000000000000001', 'UTC', 'tbc', ?)",
    ).bind(now),
    db.prepare("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'Alpha', 25, 0, ?)").bind(now),
    db.prepare("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p1', 'g1', 'raider', ?, ?)").bind(now, now),
    db.prepare(
      `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
       VALUES ('c1', 'g1', 'p1', NULL, 'Aldric', 'aldric', 'MAGE', 1, ?, ?)`,
    ).bind(now, now),
  ]);
  const [move, direct] = await db.batch([
    db.prepare("UPDATE characters SET team_id = 't1' WHERE id = 'c1'"),
    db.prepare('SELECT changes() AS n'),
  ]);
  assert(move.meta.changes > 1, `the team_since / trial triggers (0040) wrote rows too: ${move.meta.changes}`);
  assert.deepEqual(direct.results, [{ n: 1 }]);
});

// ---------------------------------------------------------------------------
// 2. The helper

check('helper: wrote() is "at least one row of its own", whatever the triggers and cascades add', async () => {
  const { wrote } = await load('worker/d1-changes.js');
  const db = freshDb();
  for (const [sql, expected] of [
    ["UPDATE t_au SET v = 'z' WHERE id = 1", true], // 4
    ["UPDATE t_au SET v = 'z' WHERE id = 99", false], // 0
    ['DELETE FROM p_cas WHERE id = 1', true], // 4
    ['DELETE FROM p_cas WHERE id = 99', false], // 0
    ["INSERT INTO t_ai3 VALUES (9,'a')", true], // 4
    ["INSERT INTO t_plain VALUES (1,'n') ON CONFLICT(id) DO NOTHING", false], // 0
    ["UPDATE t_plain SET v = 'z' WHERE id = 1", true], // 1
  ]) {
    assert.equal(wrote(await db.prepare(sql).run()), expected, sql);
  }
});

check('helper: directRowsStatement + directRows give the statement\'s own rows; countedRun does it for one statement', async () => {
  const { directRows, directRowsStatement, countedRun } = await load('worker/d1-changes.js');
  const db = freshDb();
  const results = await db.batch([
    db.prepare("UPDATE t_multi SET v = 'z'"), directRowsStatement(db), // 3 own rows, 6 reported
    db.prepare('DELETE FROM p_cas WHERE id = 1'), directRowsStatement(db), // 1 own row, 4 reported
    db.prepare('DELETE FROM p_cas WHERE id = 99'), directRowsStatement(db), // 0
  ]);
  assert.deepEqual([results[0].meta.changes, results[2].meta.changes, results[4].meta.changes], [6, 4, 0]);
  assert.deepEqual([directRows(results[1]), directRows(results[3]), directRows(results[5])], [3, 1, 0]);
  assert.equal(typeof directRows(results[1]), 'number');
  const alone = freshDb();
  assert.equal(await countedRun(alone, alone.prepare("UPDATE t_multi SET v = 'z'")), 3);
  assert.equal(await countedRun(alone, alone.prepare('DELETE FROM t_trunc')), 3);
  assert.equal(await countedRun(alone, alone.prepare('DELETE FROM p_cas WHERE id = 1')), 1);
  assert.equal(await countedRun(alone, alone.prepare('DELETE FROM p_cas WHERE id = 99')), 0);
  assert.equal(await countedRun(alone, alone.prepare("INSERT INTO t_ai3 VALUES (7,'a')")), 1);
});

// ---------------------------------------------------------------------------
// 3. The source scan: worker/ reads meta.changes only in worker/d1-changes.js

// The source with comments blanked and string / template TEXT blanked (the ${...} expressions of a template stay code); line breaks stay.
function codeOnly(source) {
  const n = source.length;
  let i = 0;
  let out = '';
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  function regexEnd(start) {
    const before = source.slice(Math.max(0, start - 40), start).trimEnd();
    if (!(before === '' || /[=(,:;!&|?{}[+\-*%<>~^]$/.test(before) || /\b(return|typeof|case)$/.test(before))) return -1;
    let j = start + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n' && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j++;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j++;
    }
    return j + 1;
  }
  function quoted(quote) {
    out += quote;
    i++;
    while (i < n && source[i] !== quote && source[i] !== '\n') {
      if (source[i] === '\\') { out += '  '; i += 2; continue; }
      out += ' ';
      i++;
    }
    out += quote;
    i++;
  }
  function template() {
    out += '`';
    i++;
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === '`') { out += '`'; i++; return; }
      if (ch === '$' && source[i + 1] === '{') { out += '${'; i += 2; code(true); continue; }
      out += ch === '\n' ? '\n' : ' ';
      i++;
    }
    throw new Error('unterminated template literal');
  }
  function code(inExpression) {
    let depth = 0;
    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === '/' && next === '/') { while (i < n && source[i] !== '\n') { out += ' '; i++; } continue; }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        out += blank(source.slice(i, stop));
        i = stop;
        continue;
      }
      if (ch === '`') { template(); continue; }
      if (ch === "'" || ch === '"') { quoted(ch); continue; }
      if (ch === '/') {
        const stop = regexEnd(i);
        if (stop > 0) { out += blank(source.slice(i, stop)); i = stop; continue; }
      }
      if (inExpression) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          if (depth === 0) { out += '}'; i++; return; }
          depth--;
        }
      }
      out += ch;
      i++;
    }
  }
  code(false);
  return out;
}

// The reads of D1's change count that bypass the helper, as [{ line, text }] of one source. Every read of meta.changes goes through worker/d1-changes.js.
const BYPASS = [
  /\.\s*changes\b(?!\s*\()/, // x.meta.changes, meta?.changes, anything.changes
  /\bchanges\b\s*(?=[,}])/, // { changes } shorthand / destructuring
  /\bmeta\s*:\s*\{[^}]*\bchanges\b/, // { meta: { changes: n } }
  /\bmeta\s*\??\.?\s*\[/, // meta['changes']
];
function bypasses(source) {
  const code = codeOnly(source.replace(/\r\n/g, '\n'));
  const found = [];
  code.split('\n').forEach((text, index) => {
    if (BYPASS.some((pattern) => pattern.test(text))) found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

check('scan: the detector finds every way of reading meta.changes (seeded sources)', () => {
  for (const bad of [
    'if (results[0].meta.changes !== 1) throw x;',
    'return result.meta.changes;',
    'const n = (await db.prepare(sql).run()).meta.changes;',
    'if (!results[0].meta.changes) return;',
    'const moved = result?.meta?.changes;',
    'const { changes } = result.meta;',
    'const { meta: { changes } } = await q;',
    'const { meta: { changes: n } } = await q;',
    "const n = result.meta['changes'];",
    'if (`${results[0].meta.changes}` === "1") {}',
    'const n = results[i].meta\n  .changes;', // the dot leads the continuation line
  ]) {
    assert(bypasses(bad).length > 0, `not detected: ${bad}`);
  }
  for (const fine of [
    '// results[0].meta.changes !== 1',
    '/* meta.changes */ const x = 1;',
    "const sql = 'UPDATE t SET a = 1 WHERE changes() = 1';",
    "const message = 'Too many changes in a minute.';",
    'const sql = `SELECT changes() AS n`;',
    'const view = { changes: { map: 1, characters: 2 }, mapChanges: [] };',
    'if (wrote(results[0])) {}',
    'const n = directRows(results[1]);',
    'const re = /meta.changes/;',
    '`${wrote(results[0])}`',
  ]) {
    assert.deepEqual(bypasses(fine), [], `falsely flagged: ${fine}`);
  }
});

check('scan: worker/ reads meta.changes only in worker/d1-changes.js', () => {
  const files = workerFiles();
  assert(files.includes('worker/d1-changes.js') && files.length > 100, 'the scan sees the Worker sources');
  const offenders = [];
  let helperReads = 0;
  for (const rel of files) {
    const found = bypasses(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (rel === 'worker/d1-changes.js') { helperReads = found.length; continue; }
    for (const one of found) offenders.push(`${rel}:${one.line}: ${one.text.slice(0, 120)}`);
  }
  assert(helperReads >= 1, 'the helper itself reads meta.changes (the detector would otherwise be blind)');
  assert.deepEqual(offenders, [], `use wrote() or the changes() counter of worker/d1-changes.js:\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 12).join('\n      ') : error}`);
    }
  }
  if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
