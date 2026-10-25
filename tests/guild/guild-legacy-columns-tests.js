/**
 * Raidsmith guild tracker - the CI greps of the user-hierarchy build, lane B1a-1 (dual write R1 -> R2)
 * Run: node tests/guild/guild-legacy-columns-tests.js
 *
 * Static checks over worker/*.js (no database):
 *   1. every INSERT INTO characters names core_rank (migration 0030 defaults it to 'raider', which must never be what a writer gets by accident);
 *   2. core_rank is written only by the allowed paths (ALLOWED_CORE_RANK_WRITERS: the dual write and the three character inserts);
 *   3. the legacy person fields (players.status, trial_start, trial_end, left_on, left_reason) are READ only in worker/person-legacy.js
 *      (LEGACY_READ_ALLOWLIST); every other reader asks that module for a SQL fragment. Lane R2 switches the readers to the character
 *      columns inside that one module and empties the allowlist;
 *   4. every file that writes players.status / trial_start / trial_end / left_on / left_reason also appends the character-column sync
 *      (syncCharacterRanksStatement), so a new writer cannot forget the dual write.
 * The detectors run on seeded SQL first, so a broken detector fails here instead of passing everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Files that may READ the legacy players fields. R1: the shared helper only. R2 empties this list.
const LEGACY_READ_ALLOWLIST = ['worker/person-legacy.js'];

// Files that may WRITE characters.core_rank, and how. Later lanes add applyRankMap and the officer rank edit here, on purpose.
const ALLOWED_CORE_RANK_WRITERS = {
  'worker/person-legacy.js': 'the dual write: UPDATE characters ... from players (syncCharacterRanksStatement)',
  'worker/routes/roster.js': 'insertCharacter (person create, add character, application accept, attendance link)',
  'worker/routes/bnet-claims.js': 'approving a Battle.net claim (new person, alt)',
  'worker/routes/roster-import.js': 'writeImport (Raid-Helper, Warcraft Logs, CSV and Battle.net roster imports)',
};

const FIELDS = ['status', 'trial_start', 'trial_end', 'left_on', 'left_reason'];
const PLAYER_ALIASES = ['players', 'p', 'pl', 'ap', 'pp'];

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Reading the source: every string literal (template literals keep their text, each ${...} becomes a NUL)

function literalsOf(source) {
  const out = [];
  const n = source.length;
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  function skipString(start) {
    const quote = source[start];
    let j = start + 1;
    while (j < n && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    return { text: source.slice(start + 1, j), end: j + 1 };
  }
  // A '/' after an operator or an opening bracket starts a regular expression literal (it can hold a quote): returns the index after it, or -1.
  function skipRegex(i) {
    const before = source.slice(Math.max(0, i - 40), i).trimEnd();
    if (!(before === '' || /[=(,:;!&|?{}[+\-*%<>~^]$/.test(before) || /\b(return|typeof|case)$/.test(before))) return -1;
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n' && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j++;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j++;
    }
    return j + 1;
  }
  function readTemplate(start) {
    let text = '';
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
      if (ch === '`') return { text, end: j + 1 };
      if (ch === '$' && source[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < n && depth) {
          const c = source[j];
          if (c === '`') { const inner = readTemplate(j); out.push({ text: inner.text, line: lineOf(j) }); j = inner.end; continue; }
          if (c === '\'' || c === '"') { const s = skipString(j); out.push({ text: s.text, line: lineOf(j) }); j = s.end; continue; }
          if (c === '/' && source[j + 1] !== '/' && source[j + 1] !== '*') { const after = skipRegex(j); if (after > 0) { j = after; continue; } }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
        text += '\u0000';
        continue;
      }
      text += ch;
      j++;
    }
    throw new Error('unterminated template literal');
  }
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === '`') { const t = readTemplate(i); out.push({ text: t.text, line: lineOf(i) }); i = t.end; continue; }
    if (ch === '\'' || ch === '"') { const s = skipString(i); out.push({ text: s.text, line: lineOf(i) }); i = s.end; continue; }
    if (ch === '/') {
      const after = skipRegex(i);
      if (after > 0) { i = after; continue; }
    }
    i++;
  }
  return out;
}

function workerFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('worker');
  return files.sort();
}

// SQL-looking literals of one file: [{ line, sql }] with the interpolations blanked to "?".
function sqlLiterals(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  let literals;
  try {
    literals = literalsOf(source);
  } catch (error) {
    throw new Error(`${rel}: ${error.message}`);
  }
  return literals
    .map(({ text, line }) => ({ line, sql: text.replace(/\u0000/g, '?') }))
    .filter(({ sql }) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/.test(sql));
}

// ---------------------------------------------------------------------------
// The detectors

const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

// A READ of a legacy players field: a field qualified by a players alias, or a bare field in a statement that selects from players, or players.*.
function readsLegacyField(sql) {
  if (isWrite(sql)) return false;
  const aliases = new Set(PLAYER_ALIASES);
  const SKIP = /^(WHERE|JOIN|ON|LEFT|INNER|SET|GROUP|ORDER|LIMIT|USING|CROSS|AND|OR|UNION|SELECT)$/i;
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+players\b(?:\s+(?:AS\s+)?(\w+))?/gi)) if (match[1] && !SKIP.test(match[1])) aliases.add(match[1]);
  const fromPlayers = /\b(?:FROM|JOIN)\s+players\b/i.test(sql);
  const field = FIELDS.join('|');
  for (const match of sql.matchAll(new RegExp(`(?:\\b(\\w+)\\.)?\\b(${field})\\b`, 'g'))) {
    const qualifier = match[1];
    if (qualifier) {
      if (aliases.has(qualifier)) return true;
    } else if (fromPlayers) {
      return true;
    }
  }
  if (fromPlayers && /\bSELECT\s+\*\s+FROM\s+players\b/i.test(sql)) return true;
  for (const alias of aliases) if (new RegExp(`\\b${alias}\\.\\*`).test(sql) && fromPlayers) return true;
  return false;
}

// A write of players.<legacy field>: INSERT INTO players naming one, or UPDATE players SET ... one.
function writesLegacyField(sql) {
  const field = FIELDS.join('|');
  if (/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+players\b/i.test(sql)) {
    const cut = sql.search(/\bVALUES\b|\bSELECT\b/i);
    return new RegExp(`\\b(${field})\\b`).test(cut < 0 ? sql : sql.slice(0, cut));
  }
  const update = /^\s*UPDATE\s+players\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
  return !!update && new RegExp(`\\b(${field})\\s*=`).test(update[1]);
}

// A write of characters.core_rank: INSERT INTO characters naming it in its column list, or UPDATE characters SET ... core_rank =.
function writesCoreRank(sql) {
  if (/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+characters\b/i.test(sql)) return /\bcore_rank\b/.test(columnList(sql));
  const update = /^\s*UPDATE\s+characters\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
  return !!update && /\bcore_rank\s*=/.test(update[1]);
}

const columnList = (sql) => {
  const open = sql.indexOf('(');
  const close = open < 0 ? -1 : sql.indexOf(')', open);
  return open < 0 || close < 0 ? '' : sql.slice(open, close);
};

// ---------------------------------------------------------------------------
// Self-tests of the detectors

check('the detectors flag what they must and nothing else (seeded SQL)', () => {
  const reads = [
    'SELECT p.status FROM players p WHERE p.guild_id = ?',
    'SELECT id, status FROM players WHERE guild_id = ?',
    'SELECT * FROM players WHERE id = ?',
    'SELECT p.* FROM players p WHERE p.id = ?',
    'SELECT m.team_id, p.trial_end FROM players p JOIN characters m ON m.player_id = p.id WHERE p.status = \'trial\'',
    'SELECT player_id FROM characters WHERE player_id IN (SELECT id FROM players WHERE guild_id = ? AND status IN (\'raider\', \'trial\'))',
    'SELECT x.id FROM players AS x WHERE x.left_on IS NULL',
    'SELECT c.id FROM characters c JOIN players pl ON pl.id = c.player_id WHERE pl.left_reason = \'kicked\'',
    'SELECT ap.status FROM something s',
  ];
  for (const sql of reads) assert(readsLegacyField(sql), `should flag: ${sql}`);
  const quiet = [
    'SELECT ?, p.joined_on FROM players p WHERE p.guild_id = ?',
    'SELECT id, ?, joined_on FROM players WHERE guild_id = ? AND ?',
    'SELECT rr.status FROM raid_roster rr WHERE rr.player_id IN (SELECT id FROM players WHERE guild_id = ?)',
    'SELECT n.id FROM away_notices n JOIN players p ON p.id = n.player_id WHERE n.status = \'x\'',
    'UPDATE players SET status = ?, left_on = ? WHERE id = ?',
    'INSERT INTO players (id, guild_id, status, trial_start) VALUES (?, ?, ?, ?)',
    'SELECT id, name FROM characters WHERE guild_id = ?',
    'SELECT cl.status FROM character_claims cl WHERE cl.guild_id = ?',
  ];
  for (const sql of quiet) assert(!readsLegacyField(sql), `should not flag: ${sql}`);

  assert(writesLegacyField('INSERT INTO players (id, guild_id, status, joined_on) VALUES (?, ?, ?, ?)'));
  assert(writesLegacyField('INSERT INTO players (id, trial_start) SELECT ?, ? WHERE ?'));
  assert(writesLegacyField('UPDATE players SET status = ?, version = version + 1 WHERE id = ?'));
  assert(!writesLegacyField('UPDATE players SET notes = ? WHERE id = ? AND status = \'trial\''));
  assert(!writesLegacyField('UPDATE players SET rank = ?, rank_on = ? WHERE id = ?'));
  assert(!writesLegacyField('INSERT INTO players (id, guild_id, joined_on) VALUES (?, ?, ?)'));

  assert(writesCoreRank('INSERT INTO characters (id, core_rank) VALUES (?, ?)'));
  assert(writesCoreRank('UPDATE characters SET core_rank = ? WHERE id = ?'));
  assert(writesCoreRank('UPDATE characters SET\n  core_rank   = (SELECT 1),\n  left_on = ?'));
  assert(!writesCoreRank('INSERT INTO characters (id, name) VALUES (?, ?)'));
  assert(!writesCoreRank('UPDATE characters SET name = ? WHERE id = ?'));
  assert(!writesCoreRank('SELECT core_rank FROM characters'));
});

check('the literal reader sees comments, nested templates and regexes the way the CI relies on', () => {
  const found = literalsOf([
    '// a comment with `backticks` and \'quotes\'',
    'const a = `SELECT ${x(\'one\')} FROM t WHERE y = ${`inner ${z}`}`;',
    'const re = /\'/g;',
    'const b = "double";',
    '/* block `comment` */ const c = \'single\';',
  ].join('\n')).map((entry) => entry.text);
  assert.deepEqual(found, ['one', 'inner \u0000', 'SELECT \u0000 FROM t WHERE y = \u0000', 'double', 'single']);
});

// ---------------------------------------------------------------------------
// The greps

check('every INSERT INTO characters in worker/ names core_rank', () => {
  let seen = 0;
  for (const rel of workerFiles()) {
    for (const { line, sql } of sqlLiterals(rel)) {
      if (!/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+characters\b/i.test(sql)) continue;
      seen++;
      assert(/\bcore_rank\b/.test(columnList(sql)), `${rel}:${line}: INSERT INTO characters does not name core_rank`);
    }
    // No INSERT INTO characters hidden outside a plain literal (concatenation, a helper building the text).
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const mentions = (raw.match(/INTO\s+characters\b/gi) || []).length;
    const literal = sqlLiterals(rel).filter(({ sql }) => /^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+characters\b/i.test(sql)).length;
    const inComments = raw.split('\n').filter((l) => /^\s*\/\//.test(l) && /INTO\s+characters\b/i.test(l)).length;
    assert.equal(mentions - inComments, literal, `${rel}: an INSERT INTO characters outside a plain SQL literal`);
  }
  assert.equal(seen, 3, 'the three character inserts today: roster.js insertCharacter, bnet-claims.js, roster-import.js writeImport');
});

check('core_rank is written only by the allowed paths', () => {
  const writers = new Map();
  for (const rel of workerFiles()) {
    for (const { line, sql } of sqlLiterals(rel)) {
      if (!writesCoreRank(sql)) continue;
      if (!writers.has(rel)) writers.set(rel, []);
      writers.get(rel).push(line);
    }
  }
  for (const [rel, lines] of writers) assert(Object.prototype.hasOwnProperty.call(ALLOWED_CORE_RANK_WRITERS, rel), `${rel}:${lines.join(',')}: writes characters.core_rank but is not an allowed writer`);
  for (const rel of Object.keys(ALLOWED_CORE_RANK_WRITERS)) assert(writers.has(rel), `${rel} is on the allowlist but writes no core_rank (remove the entry)`);
});

check('the legacy players fields are read only in the allowlisted shared helper', () => {
  const violations = [];
  const used = new Set();
  for (const rel of workerFiles()) {
    for (const { line, sql } of sqlLiterals(rel)) {
      if (!readsLegacyField(sql)) continue;
      if (LEGACY_READ_ALLOWLIST.includes(rel)) used.add(rel);
      else violations.push(`${rel}:${line}: ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepEqual(violations, [], `route these reads through worker/person-legacy.js:\n${violations.join('\n')}`);
  // The allowlist names real files that really read the legacy fields: a stale entry would hide a future violation.
  for (const rel of LEGACY_READ_ALLOWLIST) assert(fs.existsSync(path.join(ROOT, rel)), `${rel} does not exist`);
  assert.deepEqual([...used], LEGACY_READ_ALLOWLIST, 'the helper still holds the legacy reads');
});

check('every writer of players.status / trial_start / trial_end / left_on / left_reason also appends the character-column sync', () => {
  const writers = [];
  for (const rel of workerFiles()) {
    if (LEGACY_READ_ALLOWLIST.includes(rel)) continue;
    const lines = sqlLiterals(rel).filter(({ sql }) => writesLegacyField(sql)).map(({ line }) => line);
    if (lines.length) writers.push({ rel, lines });
  }
  // Today: roster.js (create, patch), applications.js (accept), attendance.js (unmatched -> person), bnet-claims.js (new person), roster-import.js (imports).
  assert.deepEqual(writers.map((w) => w.rel), [
    'worker/routes/applications.js', 'worker/routes/attendance.js', 'worker/routes/bnet-claims.js', 'worker/routes/roster-import.js', 'worker/routes/roster.js',
  ]);
  for (const { rel, lines } of writers) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(/\bsyncCharacterRanksStatement\(/.test(source), `${rel}:${lines.join(',')}: writes a legacy person field without syncCharacterRanksStatement`);
  }
});

check('the legacy-field helpers name exactly the columns the CI watches', async () => {
  const { pathToFileURL } = require('node:url');
  const helper = await import(pathToFileURL(path.join(ROOT, 'worker/person-legacy.js')).href);
  assert.deepEqual(helper.LEGACY_FIELDS, ['status', 'trialStart', 'trialEnd', 'leftOn', 'leftReason']);
  assert.equal(helper.legacyPersonColumnsSql('p'), 'p.status, p.trial_start, p.trial_end, p.left_on, p.left_reason');
  assert.equal(helper.legacyColumnsSql('p', 'status', 'leftOn'), 'p.status, p.left_on');
  assert.equal(helper.legacyColumnSql('players', 'trialEnd'), 'players.trial_end');
  assert.equal(helper.notInactiveSql('p'), "p.status != 'inactive'");
  assert.equal(helper.raidingSql('p'), "p.status IN ('raider', 'trial')");
  assert.equal(helper.onTrialSql('p'), "p.status = 'trial'");
  assert.throws(() => helper.legacyColumnSql('p', 'nope'), /Unknown person field/);
  for (const column of FIELDS) assert(helper.legacyPersonColumnsSql('p').includes(column), column);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
