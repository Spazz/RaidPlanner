/**
 * PartyPlanner Web - windowsHide guard
 * Run: node tests/site/windows-hide-tests.js
 *
 * On Windows a Node child process started without windowsHide: true opens a console window, so a test run
 * pops blank windows on the desktop. This suite reads every .js file under tests/ and tools/ and checks that
 * each child_process call passes windowsHide: true inside its options. A failure names file:line.
 * The call text runs from the opening parenthesis to its matching closing one (string literals are skipped).
 * It also pins the second half of the rule: a detached process has no console, so a console program started detached opens a visible
 * window for every console child it starts. The only detached spawn allowed launches tools/guild-smoke-host.js, which runs the real
 * command inside a console without a window.
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
// A detached process has no console on Windows (libuv: DETACHED_PROCESS), so every console program it starts gets its own VISIBLE console
// window, whatever windowsHide the code passes. Only tools/guild-smoke-host.js may be detached: it starts the real command not detached,
// hidden and without an inherited stdio slot (CREATE_NO_WINDOW), and that console is inherited all the way down the tree.
const DETACHED = /\bdetached\s*:\s*true\b/g;
const HOST_SPAWN = /^\(\s*process\.execPath\s*,\s*\[\s*HOST_SCRIPT\b/;
const HOST_DECLARATION = /\bconst\s+HOST_SCRIPT\s*=\s*path\.join\(\s*__dirname\s*,\s*'guild-smoke-host\.js'\s*\)/;
const HOST_FILE = 'tools/guild-smoke-host.js';
const NO_INHERITED_STDIO = /stdio\s*:\s*\[\s*'ignore'\s*,\s*'pipe'\s*,\s*'pipe'\s*\]/;

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
    const text = callText(src, openIndex);
    calls.push({ name, line, text, start: openIndex, end: openIndex + text.length });
  }
  return calls;
}

const scanned = SCAN_DIRS
  .flatMap(dir => jsFiles(path.join(ROOT, dir)))
  .filter(file => path.resolve(file) !== SELF);
const relative = file => path.relative(ROOT, file).replace(/\\/g, '/');
const calls = scanned.flatMap(file => childProcessCalls(file)
  .map(call => ({ ...call, where: `${relative(file)}:${call.line}` })));

// Every `detached: true` in the scanned files, with the child_process call around it (null when it is not inside one).
const detachedSpawns = scanned.flatMap(file => {
  const src = fs.readFileSync(file, 'utf8');
  const fileCalls = childProcessCalls(file);
  return [...src.matchAll(DETACHED)].map(match => ({
    where: `${relative(file)}:${src.slice(0, match.index).split('\n').length}`,
    src,
    call: fileCalls.find(call => call.start <= match.index && match.index < call.end) || null,
  }));
});

check('the scan finds the child_process call sites', () => {
  assert(calls.length >= 10, `only ${calls.length} child_process calls found; the scan is broken`);
});

check('every child_process call in tests/ and tools/ passes windowsHide: true', () => {
  const offenders = calls.filter(call => !HIDES_WINDOW.test(call.text)).map(call => `${call.where} ${call.name}(`);
  assert.deepEqual(offenders, [], `these calls open a console window on Windows (add windowsHide: true):\n  ${offenders.join('\n  ')}`);
});

check('the scan finds the detached spawn that launches the host', () => {
  assert(detachedSpawns.length >= 1, 'no `detached: true` found; the scan is broken or the host launch was removed');
});

check('a detached: true spawn only ever launches the host script (never a console program: it would open a window per console child)', () => {
  const offenders = detachedSpawns
    .filter(({ call, src }) => !call || call.name !== 'spawn' || !HOST_SPAWN.test(call.text) || !HOST_DECLARATION.test(src))
    .map(({ where }) => where);
  assert.deepEqual(offenders, [], `these detached spawns must be spawn(process.execPath, [HOST_SCRIPT, ...]) with HOST_SCRIPT = path.join(__dirname, 'guild-smoke-host.js'):\n  ${offenders.join('\n  ')}`);
});

check('the host starts its command not detached, hidden, and with no inherited stdio slot (otherwise the console window comes back)', () => {
  const hostSpawns = calls.filter(call => call.where.startsWith(`${HOST_FILE}:`) && call.name === 'spawn');
  assert(hostSpawns.length >= 1, `${HOST_FILE} has no spawn call`);
  for (const call of hostSpawns) {
    assert(HIDES_WINDOW.test(call.text), `${call.where} must pass windowsHide: true`);
    assert(NO_INHERITED_STDIO.test(call.text), `${call.where} must use stdio: ['ignore', 'pipe', 'pipe'] (an inherited fd stops libuv adding CREATE_NO_WINDOW)`);
    assert(!/\bdetached\b/.test(call.text), `${call.where} must not be detached`);
  }
});

console.log(`\n${passed} checks passed`);
