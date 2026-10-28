#!/usr/bin/env node
/**
 * The host that tools/guild-smoke.js `up` starts detached, and that in turn runs the real background command (Wrangler, a fake):
 *
 *   node tools/guild-smoke-host.js --log <file> [--shell] -- <command> [args...]
 *
 * Why it exists (Windows): `up` must start the server so that it outlives `up`, which libuv only does for a detached child, and there
 * that means DETACHED_PROCESS: the process has NO console. Every console program such a process starts (workerd, esbuild, cmd.exe) is
 * then given a NEW, VISIBLE console window. So only this host is detached. It starts the real command NOT detached, with windowsHide
 * and no inherited stdio slot, which libuv turns into CREATE_NO_WINDOW: the command gets a console without a window, and the console
 * programs it starts inherit that console, so no window ever opens. (Not detaching `up`'s child directly is no fix: libuv puts every
 * non-detached child into a kill-on-close job object, so the server would die when `up` returns.)
 *
 * The host appends the command's stdout and stderr to --log, exits with the command's exit code (so `up` can see an early death) and
 * takes the command's tree down with it. A signal (Ctrl+C, close) makes it run `taskkill /T` on the command. However the host dies, every
 * descendant that Node started (libuv puts each non-detached child into a kill-on-close job object owned by its parent) dies with it, link
 * by link; a process started by cmd.exe (wrangler behind npx's cmd.exe) is not in a job, so only `taskkill /PID <host> /T /F`, which is what
 * `down` runs, reaches it through the parent chain. --shell runs [command, ...args].join(' ') through the shell; the caller quotes the
 * arguments for it.
 */
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const USAGE = 'usage: node tools/guild-smoke-host.js --log <file> [--shell] -- <command> [args...]';
const OUTPUT_FLUSH_WAIT_MS = 1000;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

// -> { log, shell, command, args }
function parseHostArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) throw new Error(`missing "--" before the command\n${USAGE}`);
  const [command, ...args] = argv.slice(separator + 1);
  if (!command) throw new Error(`no command after "--"\n${USAGE}`);
  const options = argv.slice(0, separator);
  let log = null;
  let shell = false;
  for (let index = 0; index < options.length; index++) {
    if (options[index] === '--shell') shell = true;
    else if (options[index] === '--log') {
      log = options[++index];
      if (!log) throw new Error(`--log needs a file\n${USAGE}`);
    } else throw new Error(`unknown option ${options[index]}\n${USAGE}`);
  }
  if (!log) throw new Error(`--log is required\n${USAGE}`);
  return { log, shell, command, args };
}

function stopTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

function main(argv) {
  let options;
  try {
    options = parseHostArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return process.exit(2);
  }
  const fd = fs.openSync(options.log, 'a');
  const write = (chunk) => { try { fs.writeSync(fd, chunk); } catch { /* the log is gone; keep serving */ } };
  const note = (text) => write(`[guild-smoke-host] ${text}\n`);

  const child = spawn(options.shell ? [options.command, ...options.args].join(' ') : options.command, options.shell ? [] : options.args, {
    cwd: process.cwd(), env: process.env, shell: options.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exitCode = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    fs.closeSync(fd);
    process.exit(exitCode === null ? 1 : exitCode);
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('error', (error) => { note(`could not start ${options.command}: ${error.message}`); exitCode = 1; finish(); });
  child.on('exit', (code, signal) => {
    exitCode = code === null ? 1 : code;
    if (signal) note(`the command ended on ${signal}`);
    setTimeout(finish, OUTPUT_FLUSH_WAIT_MS); // 'close' normally comes first; a grandchild holding a pipe must not keep the host alive
  });
  child.on('close', finish);
  for (const signal of STOP_SIGNALS) process.on(signal, () => stopTree(child));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseHostArgs };
