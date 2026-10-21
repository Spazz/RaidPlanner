/**
 * PartyPlanner Web - windowsHide guard
 * Run: node tests/site/windows-hide-tests.js
 *
 * On Windows a Node child process started without windowsHide: true opens a console window, so a test run
 * pops blank windows on the desktop. This suite reads every .js file under tests/ and tools/ and checks that
 * each child_process call passes windowsHide: true inside its options. A failure names file:line.
 * The call text runs from the opening parenthesis to its matching closing one (string literals are skipped).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['tests', 'tools'];
const SELF = path.resolve(__filename);
const CALL = /(?<![\w$.])(spawn|spawnSync|execFile|execFileSync|execSync|fork|exec)\s*\(/g;
const CHILD_PROCESS_IMPORT = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g;
const IMPORT_ONLY = new Set(['exec']);
const HIDES_WINDOW = /windowsHide\s*:\s*true/;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function endOfString(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote) return i;
  }
  return src.length;
}

function callText(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = endOfString(src, i); continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return src.slice(openIndex, i + 1);
  }
  return src.slice(openIndex);
}

function childProcessCalls(file) {
  const src = fs.readFileSync(file, 'utf8');
  const imported = new Set([...src.matchAll(CHILD_PROCESS_IMPORT)].flatMap(m => m[1].split(',').map(n => n.trim())));
  const calls = [];
  for (const match of src.matchAll(CALL)) {
    const name = match[1];
    if (IMPORT_ONLY.has(name) && !imported.has(name)) continue;
    const openIndex = match.index + match[0].length - 1;
    const line = src.slice(0, match.index).split('\n').length;
    calls.push({ name, line, text: callText(src, openIndex) });
  }
  return calls;
}

const scanned = SCAN_DIRS
  .flatMap(dir => jsFiles(path.join(ROOT, dir)))
  .filter(file => path.resolve(file) !== SELF);
const calls = scanned.flatMap(file => childProcessCalls(file)
  .map(call => ({ ...call, where: `${path.relative(ROOT, file).replace(/\\/g, '/')}:${call.line}` })));

check('the scan finds the child_process call sites', () => {
  assert(calls.length >= 10, `only ${calls.length} child_process calls found; the scan is broken`);
});

check('every child_process call in tests/ and tools/ passes windowsHide: true', () => {
  const offenders = calls.filter(call => !HIDES_WINDOW.test(call.text)).map(call => `${call.where} ${call.name}(`);
  assert.deepEqual(offenders, [], `these calls open a console window on Windows (add windowsHide: true):\n  ${offenders.join('\n  ')}`);
});

console.log(`\n${passed} checks passed`);
