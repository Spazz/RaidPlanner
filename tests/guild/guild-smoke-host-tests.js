/**
 * Raidsmith guild tracker - smoke host tests
 * Run: node tests/guild/guild-smoke-host-tests.js
 *
 * tools/guild-smoke-host.js is the one process guild-smoke starts detached; it runs the real command (Wrangler, a fake) not detached, windowless,
 * with piped output, so on Windows no console window ever opens for the command or its children. These checks pin what `up` and `down` rely on:
 * the argument parsing, the command's exit code coming back as the host's, the log being appended to (never truncated), the command going down with
 * the host, and the startDetached / killTree pair around it. They run small node scripts, never Wrangler.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const host = require('../../tools/guild-smoke-host.js');
const smoke = require('../../tools/guild-smoke.js');

const HOST = path.join(__dirname, '..', '..', 'tools', 'guild-smoke-host.js');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-smoke-host-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const scripts = {
  exit: (code) => writeScript(`exit-${code}.js`, `process.exit(${code});`),
  talk: writeScript('talk.js', "process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n');"),
  sleeper: writeScript('sleeper.js', "process.stdout.write('pid=' + process.pid + '\\n'); setInterval(() => {}, 1000);"),
};
function writeScript(name, source) {
  const file = path.join(WORK, name);
  fs.writeFileSync(file, source);
  return file;
}

function logPath(name) { return path.join(WORK, `${name}.log`); }
const readLog = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

async function until(label, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Runs the host (not detached) to its end. -> { code, stderr }
function runHost(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

check('parseHostArgs: --log, --shell and the command with its arguments after "--"', () => {
  assert.deepEqual(host.parseHostArgs(['--log', 'a.log', '--', 'node', 'x.js', '--port', '1']), { log: 'a.log', shell: false, command: 'node', args: ['x.js', '--port', '1'] });
  assert.deepEqual(host.parseHostArgs(['--shell', '--log', 'a.log', '--', 'npx', '--yes']), { log: 'a.log', shell: true, command: 'npx', args: ['--yes'] });
  // Only the first "--" separates: a later one belongs to the command.
  assert.deepEqual(host.parseHostArgs(['--log', 'a.log', '--', 'node', 'x.js', '--', 'y']).args, ['x.js', '--', 'y']);
});

check('parseHostArgs: a missing separator, command or log, and unknown options are errors', () => {
  assert.throws(() => host.parseHostArgs(['--log', 'a.log', 'node']), /missing "--"/);
  assert.throws(() => host.parseHostArgs(['--log', 'a.log', '--']), /no command/);
  assert.throws(() => host.parseHostArgs(['--', 'node']), /--log is required/);
  assert.throws(() => host.parseHostArgs(['--log', '--', 'node']), /--log needs a file|--log is required/);
  assert.throws(() => host.parseHostArgs(['--log', 'a.log', '--detach', '--', 'node']), /unknown option --detach/);
});

check('the host exits with the command\'s exit code (0 and non-zero), so `up` sees an early death', async () => {
  const ok = await runHost(['--log', logPath('exit-0'), '--', process.execPath, scripts.exit(0)]);
  assert.equal(ok.code, 0);
  const bad = await runHost(['--log', logPath('exit-7'), '--', process.execPath, scripts.exit(7)]);
  assert.equal(bad.code, 7);
});

check('the host appends the command\'s stdout and stderr to the log and keeps what was there', async () => {
  const log = logPath('append');
  fs.writeFileSync(log, 'earlier line\n');
  assert.equal((await runHost(['--log', log, '--', process.execPath, scripts.talk])).code, 0);
  assert.equal((await runHost(['--log', log, '--', process.execPath, scripts.talk])).code, 0);
  const text = readLog(log);
  assert.ok(text.startsWith('earlier line\n'), text);
  assert.equal(text.split('out-line').length - 1, 2, text);
  assert.equal(text.split('err-line').length - 1, 2, text);
});

check('a command that cannot start is logged and gives a non-zero exit', async () => {
  const log = logPath('missing');
  const result = await runHost(['--log', log, '--', path.join(WORK, 'no-such-program')]);
  assert.notEqual(result.code, 0);
  assert.match(readLog(log), /could not start .*no-such-program/);
});

check('--shell runs the joined command line through the shell', async () => {
  const log = logPath('shell');
  assert.equal((await runHost(['--log', log, '--shell', '--', 'echo', 'shell-ok'])).code, 0);
  assert.match(readLog(log), /shell-ok/);
});

check('bad host arguments: usage on stderr and exit 2', async () => {
  const result = await runHost(['--log', logPath('bad')]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /missing "--"/);
});

check('the command goes down with the host (its tree is not left running)', async () => {
  const log = logPath('tree');
  const child = spawn(process.execPath, [HOST, '--log', log, '--', process.execPath, scripts.sleeper], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise((resolve) => child.on('close', resolve));
  try {
    await until('the command to report its pid', () => /pid=\d+/.test(readLog(log)));
    const commandPid = Number(/pid=(\d+)/.exec(readLog(log))[1]);
    assert.ok(isAlive(commandPid), 'the command runs while the host runs');
    assert.notEqual(commandPid, child.pid, 'the command is a child of the host, not the host');
    child.kill(); // Windows: TerminateProcess, no handler runs; elsewhere SIGTERM, which the host forwards
    await closed;
    await until('the command to end with the host', () => !isAlive(commandPid));
  } finally {
    child.kill();
  }
});

check('startDetached: the pid is the host\'s, the command\'s exit code reaches exited(), its output reaches the log', async () => {
  const log = logPath('detached-exit');
  const started = smoke.startDetached({ command: process.execPath, args: [scripts.exit(3)], shell: false }, log);
  assert.ok(started.pid > 0);
  await until('exited() to report', () => started.exited() !== null);
  assert.equal(started.exited(), 3);
  const talking = smoke.startDetached({ command: process.execPath, args: [scripts.talk], shell: false }, logPath('detached-talk'));
  await until('the output in the log', () => /err-line/.test(readLog(logPath('detached-talk'))));
  await until('exited() to report', () => talking.exited() !== null);
  assert.equal(talking.exited(), 0);
});

check('startDetached + killTree: the host and its command both end (what `down` does with the stored pid)', async () => {
  const log = logPath('detached-tree');
  const started = smoke.startDetached({ command: process.execPath, args: [scripts.sleeper], shell: false }, log);
  try {
    await until('the command to report its pid', () => /pid=\d+/.test(readLog(log)));
    const commandPid = Number(/pid=(\d+)/.exec(readLog(log))[1]);
    assert.ok(isAlive(started.pid) && isAlive(commandPid));
    assert.equal(started.exited(), null, 'a running command leaves exited() null');
    smoke.killTree(started.pid);
    await until('the host and the command to end', () => !isAlive(started.pid) && !isAlive(commandPid));
  } finally {
    smoke.killTree(started.pid);
  }
});

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error.message}`);
    }
  }
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* a process still holds a log; the OS temp folder is cleaned later */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
