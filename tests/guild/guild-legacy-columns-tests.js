/**
 * Raidsmith guild tracker - the CI greps of the user-hierarchy build (dual write R1 -> R2 in lane B1a-1, readers moved to the characters in lane B2, the mirror
 * deleted in lane B4b)
 * Run: node tests/guild/guild-legacy-columns-tests.js
 *
 * Static checks over worker/*.js (no database):
 *   1. every INSERT INTO characters names core_rank (migration 0030 defaults it to 'raider', which must never be what a writer gets by accident);
 *   2. core_rank is written only by the allowed paths (ALLOWED_CORE_RANK_WRITERS);
 *   3. the legacy person fields (players.status, trial_start, trial_end, left_on, left_reason) are READ nowhere: since R2 every reader works from the
 *      character columns (LEGACY_READ_ALLOWLIST is empty);
 *   4. and WRITTEN nowhere (R4, lane B4b): no UPDATE sets one, no INSERT names a date or reason field, and the one INSERT that must name status (the column is
 *      NOT NULL without a default) gives the inert literal 'raider' and nothing else;
 *   5. writer guards on the home or target team use `IS ?`: a character or Main on no team must not make a write silently match nothing.
 * The detectors run on seeded SQL first, so a broken detector fails here instead of passing everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Files that may READ the legacy players fields. R1: the shared helper only; R2 (lane B2) emptied this list.
const LEGACY_READ_ALLOWLIST = [];

// Files that may WRITE characters.core_rank, and how. Later lanes add applyRankMap and the officer rank edit here, on purpose.
const ALLOWED_CORE_RANK_WRITERS = {
  'worker/person-legacy.js': 'a status change: the person-wide UPDATE of the rank columns (setCharacterRanksStatement)',
  'worker/routes/roster.js': 'insertCharacter (person create, add character, application accept, attendance link)',
  'worker/claim-apply.js': 'applyClaimPlan: a claimed character (new person, alt), whoever decides - the claimant, or an officer approving a claim',
  'worker/routes/roster-import.js': 'writeImport (Raid-Helper, Warcraft Logs, CSV and Battle.net roster imports)',
  'worker/rank-map.js': 'applyRankMap: the in-game roster and the rank map decide the rank of every character (roster sync batch, rank-map edit)',
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
function readsLegacyField(sqlText) {
  if (isWrite(sqlText)) return false;
  // `<expression> AS status` names a result column (the roster rows keep the key the API always had); it reads nothing.
  const sql = sqlText.replace(new RegExp(`\\bAS\\s+(${FIELDS.join('|')})\\b`, 'gi'), 'AS alias');
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
  const update = /^\s*(?:WITH\b[\s\S]*?\s)?UPDATE\s+players\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
  return !!update && new RegExp(`\\b(${field})\\s*=`).test(update[1]);
}

// What is wrong with a statement that writes a legacy players field, as text (empty = fine): an UPDATE players SET ... one; an INSERT INTO players naming a date or
// reason field; an INSERT naming status with anything but the inert literal 'raider' at that position. Lane B4b deleted the mirror: this is the zero-writers check.
function legacyWriteProblems(sql) {
  const out = [];
  if (/^\s*(?:WITH\b[\s\S]*?\s)?UPDATE\s+players\s+SET\b/i.test(sql)) {
    if (writesLegacyField(sql)) out.push('UPDATE players SET names a legacy field');
    return out;
  }
  if (!/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+players\b/i.test(sql)) return out;
  const parts = insertParts(sql);
  if (!parts) return ['an INSERT INTO players this check cannot read'];
  parts.columns.forEach((column, index) => {
    if (!FIELDS.includes(column)) return;
    if (column !== 'status') out.push(`INSERT INTO players names ${column}`);
    else if (parts.values[index] !== '\'raider\'') out.push(`INSERT INTO players gives status ${parts.values[index]} (only the literal 'raider')`);
  });
  return out;
}

// INSERT INTO t (a, b) VALUES (x, y) | SELECT x, y ... -> { columns: ['a', 'b'], values: ['x', 'y'] } (top-level commas only), or null.
function insertParts(sql) {
  const open = sql.indexOf('(');
  const close = open < 0 ? -1 : closingParen(sql, open);
  if (close < 0) return null;
  const columns = sql.slice(open + 1, close).split(',').map((name) => name.trim());
  const rest = sql.slice(close + 1);
  let list;
  const values = /^\s*VALUES\s*\(/i.exec(rest);
  if (values) {
    const start = values[0].length - 1;
    const end = closingParen(rest, start);
    if (end < 0) return null;
    list = rest.slice(start + 1, end);
  } else {
    const select = /^\s*SELECT\s+/i.exec(rest);
    if (!select) return null;
    const body = rest.slice(select[0].length);
    const stop = topLevelIndex(body, /^(FROM|WHERE)\b/i);
    list = stop < 0 ? body : body.slice(0, stop);
  }
  return { columns, values: splitTopLevel(list) };
}

// Walks text outside quotes; fn(index, depth, char) returning true stops. -> the stop index, or -1.
function walk(text, fn, from = 0) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (fn(i, depth, ch)) return i;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return -1;
}
const closingParen = (text, open) => walk(text, (i, depth, ch) => ch === ')' && depth === 1, open);
const topLevelIndex = (text, pattern) => walk(text, (i, depth) => depth === 0 && (i === 0 || /\W/.test(text[i - 1])) && pattern.test(text.slice(i)));
function splitTopLevel(text) {
  const items = [];
  let from = 0;
  walk(text, (i, depth, ch) => {
    if (ch === ',' && depth === 0) { items.push(text.slice(from, i).trim()); from = i + 1; }
    return false;
  });
  items.push(text.slice(from).trim());
  return items;
}

// A write of characters.core_rank: INSERT INTO characters naming it in its column list, or UPDATE characters SET ... core_rank =.
function writesCoreRank(sql) {
  if (/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+characters\b/i.test(sql)) return /\bcore_rank\b/.test(columnList(sql));
  // A leading WITH (a CTE in front of the UPDATE, as applyRankMap's) must not hide the statement from this check.
  const update = /^\s*(?:WITH\b[\s\S]*?\s)?UPDATE\s+characters\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
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
    'SELECT p.status AS status FROM players p',
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
    'SELECT p.id, (SELECT mr.core_rank FROM characters mr WHERE mr.player_id = p.id) AS status, p.joined_on FROM players p WHERE p.guild_id = ?',
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
  assert(writesCoreRank('WITH rank_map AS (SELECT 1 AS rank)\nUPDATE characters SET core_rank = (SELECT 1), updated_at = ? WHERE guild_id = ?'));
  assert(!writesCoreRank('WITH changed AS (SELECT id FROM characters)\nUPDATE raids SET policy_fp = \'\' WHERE id IN (SELECT id FROM changed)'));

  // The zero-writers check: the placeholder form passes, every other way to write a legacy field is a problem.
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, guild_id, status, joined_on) VALUES (?, ?, \'raider\', ?)'), []);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, guild_id, status, joined_on, discord_user_id) SELECT json_extract(value, \'$.id\'), ?, \'raider\', COALESCE(json_extract(value, \'$.joinedOn\'), ?), json_extract(value, \'$.discord\') FROM json_each(?)'), []);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, guild_id, status, joined_on) SELECT ?, ?, \'raider\', ? WHERE '), []);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, guild_id, status, joined_on) VALUES (?, ?, ?, ?)'), ['INSERT INTO players gives status ? (only the literal \'raider\')']);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, guild_id, status, joined_on) VALUES (?, ?, \'trial\', ?)'), ['INSERT INTO players gives status \'trial\' (only the literal \'raider\')']);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, status, trial_start, trial_end) VALUES (?, \'raider\', ?, NULL)'), ['INSERT INTO players names trial_start', 'INSERT INTO players names trial_end']);
  assert.deepEqual(legacyWriteProblems('INSERT INTO players (id, left_on) VALUES (?, ?)'), ['INSERT INTO players names left_on']);
  assert.deepEqual(legacyWriteProblems('UPDATE players SET status = ?, version = version + 1 WHERE id = ?'), ['UPDATE players SET names a legacy field']);
  assert.deepEqual(legacyWriteProblems('UPDATE players SET left_reason = ? WHERE id = ?'), ['UPDATE players SET names a legacy field']);
  assert.deepEqual(legacyWriteProblems('UPDATE players SET joined_on = ?, discord_user_id = ?, version = version + 1 WHERE id = ? AND status = \'trial\''), []);
  assert.deepEqual(legacyWriteProblems('SELECT status FROM players'), []);
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
    const inComments = raw.split(/\r?\n/).filter((l) => /^\s*\/\//.test(l) && /INTO\s+characters\b/i.test(l)).length;
    assert.equal(mentions - inComments, literal, `${rel}: an INSERT INTO characters outside a plain SQL literal`);
  }
  assert.equal(seen, 3, 'the three character inserts today: roster.js insertCharacter, claim-apply.js, roster-import.js writeImport');
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

check('the legacy players fields are read nowhere (R2: the allowlist is empty)', () => {
  assert.deepEqual(LEGACY_READ_ALLOWLIST, [], 'the allowlist went to zero with lane B2');
  const violations = [];
  for (const rel of workerFiles()) {
    for (const { line, sql } of sqlLiterals(rel)) {
      if (readsLegacyField(sql)) violations.push(`${rel}:${line}: ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepEqual(violations, [], `read the character columns instead (worker/person-rank.js, worker/person-rank-sql.js, worker/team-roster.js):\n${violations.join('\n')}`);
});

check('the legacy players fields are written nowhere (R4: the mirror is gone; the only INSERT of status gives the inert literal)', () => {
  const problems = [];
  const inserters = [];
  for (const rel of workerFiles()) {
    for (const { line, sql } of sqlLiterals(rel)) {
      for (const problem of legacyWriteProblems(sql)) problems.push(`${rel}:${line}: ${problem}`);
      if (/^\s*INSERT\s+(OR\s+\w+\s+)?INTO\s+players\b/i.test(sql)) inserters.push(rel);
    }
  }
  assert.deepEqual(problems, [], `write the character columns instead (worker/person-legacy.js); players.status is the placeholder 'raider' only:\n${problems.join('\n')}`);
  // The five places that create a person: roster.js (create), applications.js (accept), attendance.js (unmatched name -> person), claim-apply.js (new person), roster-import.js.
  assert.deepEqual(inserters, [
    'worker/claim-apply.js', 'worker/routes/applications.js', 'worker/routes/attendance.js', 'worker/routes/roster-import.js', 'worker/routes/roster.js',
  ]);
});

check('writer guards on the home or target team use IS ?, never = ? (a character or Main on no team must not make a write silently match nothing)', () => {
  const GUARDED = ['worker/routes/roster.js', 'worker/routes/accounts.js', 'worker/routes/bnet-claims.js', 'worker/claim-apply.js', 'worker/team-place.js'];
  const hits = [];
  for (const rel of GUARDED) {
    for (const { line, sql } of sqlLiterals(rel)) {
      if (/\bis_main\b/.test(sql) && /\b(?:AND|WHERE)\s+team_id\s*=\s*\?/i.test(sql)) hits.push(`${rel}:${line}: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      if (/\bteam_id\s+NOT\s+IN\b/i.test(sql) && !/\bteam_id\s+IS\s+NOT\s+NULL\b/i.test(sql)) hits.push(`${rel}:${line}: NOT IN without the NULL case`);
    }
  }
  assert.deepEqual(hits, []);
});

check('the status mapping and the person-level SQL name exactly what the readers and writers use', async () => {
  const { pathToFileURL } = require('node:url');
  const legacy = await import(pathToFileURL(path.join(ROOT, 'worker/person-legacy.js')).href);
  assert.deepEqual(Object.keys(legacy).sort(), ['IMPORTED_RANK_COLUMNS_SQL', 'RANK_COLUMNS_SQL', 'characterRankColumns', 'rankBinds', 'setCharacterRanksStatement', 'trialDatesFollowMainStatements']);
  const map = legacy.characterRankColumns;
  assert.deepEqual(map({ status: 'raider', leftOn: '2027-01-01', leftReason: 'left', trialStart: '2027-01-01', trialEnd: '2027-02-01' }), { coreRank: 'raider', leftOn: null, leftReason: null, trialStart: null, trialEnd: null });
  assert.deepEqual(map({ status: 'trial', trialStart: '2027-01-01', trialEnd: '2027-02-01' }), { coreRank: 'trial', leftOn: null, leftReason: null, trialStart: '2027-01-01', trialEnd: '2027-02-01' });
  assert.deepEqual(map({ status: 'reserve' }), { coreRank: 'reserve', leftOn: null, leftReason: null, trialStart: null, trialEnd: null });
  assert.deepEqual(map({ status: 'inactive', leftOn: '2027-01-01', leftReason: 'kicked' }), { coreRank: 'social', leftOn: '2027-01-01', leftReason: 'kicked', trialStart: null, trialEnd: null });
  assert.deepEqual(map({ status: 'inactive', leftOn: '2027-01-01', leftReason: 'break' }), { coreRank: 'social', leftOn: null, leftReason: null, trialStart: null, trialEnd: null });
  assert.deepEqual(map({ status: 'inactive', leftOn: '2027-01-01' }), { coreRank: 'social', leftOn: null, leftReason: null, trialStart: null, trialEnd: null });
  assert.deepEqual(legacy.rankBinds(null, 'p1'), [null, 'p1', null, 'p1', null, 'p1', null, null]);
  assert.deepEqual(legacy.rankBinds(map({ status: 'trial', trialStart: '2027-01-01' }), 'p1'), ['trial', 'p1', null, 'p1', null, 'p1', '2027-01-01', null]);
  assert.equal((legacy.RANK_COLUMNS_SQL.match(/\?/g) || []).length, 8, 'eight placeholders, one per bind of rankBinds');
  const sqlHelpers = await import(pathToFileURL(path.join(ROOT, 'worker/person-rank-sql.js')).href);
  assert.match(sqlHelpers.personRankSql('p.id'), /^\(SELECT mr\.core_rank FROM characters mr WHERE mr\.player_id = p\.id ORDER BY mr\.is_main DESC, mr\.id LIMIT 1\)$/);
  assert.match(sqlHelpers.personStatusSql('p.id'), /CASE mr\.core_rank WHEN 'social' THEN 'inactive' ELSE mr\.core_rank END/);
  const roster = await import(pathToFileURL(path.join(ROOT, 'worker/team-roster.js')).href);
  assert.match(roster.personOnTeamRosterSql('p.id', '?2'), /^EXISTS \(SELECT 1 FROM characters rc WHERE rc\.player_id = p\.id AND \(rc\.team_id = \?2 AND \(rc\.team_id IS NOT NULL AND rc\.left_on IS NULL/);
  assert.match(roster.rosterRankOnTeamSql('p.id', '?2'), /^\(SELECT rc\.core_rank FROM characters rc WHERE rc\.player_id = p\.id AND .* ORDER BY rc\.is_main DESC, rc\.id LIMIT 1\)$/);
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
