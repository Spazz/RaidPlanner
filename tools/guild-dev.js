#!/usr/bin/env node
/**
 * Runs the guild tracker locally: Wrangler (pinned) with the local D1 kept outside OneDrive.
 *   node tools/guild-dev.js migrate [wrangler args]   apply migrations/ to the local D1
 *   node tools/guild-dev.js dev     [wrangler args]   start the Worker, local D1 and static files
 * Other arguments pass straight through, e.g.
 *   npm run guild:dev -- --var DISCORD_API_BASE:http://127.0.0.1:8790 --port 8788
 * The local D1 lives in <home>/.raidsmith-dev/wrangler-state unless you point it elsewhere (a fresh
 * database for a check, say): `--state <dir>` or the RAIDSMITH_DEV_STATE environment variable.
 * Exactly one --persist-to reaches Wrangler. Nothing needs a Cloudflare login. Secrets come from .env at
 * the repo root (never printed here).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WRANGLER_VERSION = '4.146.0';
const STATE_ENV = 'RAIDSMITH_DEV_STATE';

function defaultStateDir() {
  return path.join(os.homedir(), '.raidsmith-dev', 'wrangler-state');
}

// The state dir when no argument names one: RAIDSMITH_DEV_STATE, else <home>/.raidsmith-dev/wrangler-state.
function stateDir(env = process.env) {
  const override = typeof env[STATE_ENV] === 'string' ? env[STATE_ENV].trim() : '';
  return override ? path.resolve(override) : defaultStateDir();
}

// Pulls `--name <value>` / `--name=<value>` out of an argument list -> { value, rest }.
function takeOption(args, name) {
  const rest = [];
  let value = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      if (i + 1 >= args.length) throw new Error(`${name} needs a directory`);
      value = args[++i];
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    } else {
      rest.push(arg);
    }
  }
  if (value !== null && !value.trim()) throw new Error(`${name} needs a directory`);
  return { value, rest };
}

// The one --persist-to directory: --state, then a --persist-to you passed, then RAIDSMITH_DEV_STATE, then the default.
function resolveState(extraArgs, env) {
  const state = takeOption(extraArgs, '--state');
  const persist = takeOption(state.rest, '--persist-to');
  const chosen = state.value ?? persist.value;
  return { dir: chosen !== null ? path.resolve(chosen) : stateDir(env), passthrough: persist.rest };
}

// Windows cmd.exe re-parses a command line, so an argument with spaces needs quotes there.
function quoteForShell(arg) {
  return /[\s"&|<>^()%!]/.test(arg) || arg === '' ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// npm ships npx as a script next to node itself. Running that script with node needs no shell, so a
// home directory with spaces cannot be split.
function npxScript() {
  const root = path.dirname(process.execPath);
  const candidates = [
    path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// -> { command, args, shell } for the call that runs Wrangler.
function buildCommand(mode, extraArgs = [], env = process.env) {
  if (mode !== 'migrate' && mode !== 'dev') throw new Error('usage: guild-dev.js migrate|dev [wrangler args]');
  const { dir, passthrough } = resolveState(extraArgs, env);
  const wrangler = mode === 'migrate' ? ['d1', 'migrations', 'apply', 'DB', '--local'] : ['dev'];
  const npxArgs = ['--yes', `wrangler@${WRANGLER_VERSION}`, ...wrangler, '--persist-to', dir, ...passthrough];
  const script = npxScript();
  if (script) return { command: process.execPath, args: [script, ...npxArgs], shell: false };
  // Fallback: npx on the PATH. On Windows that is npx.cmd, which needs a shell, so quote for it.
  if (process.platform === 'win32') return { command: 'npx', args: npxArgs.map(quoteForShell), shell: true };
  return { command: 'npx', args: npxArgs, shell: false };
}

function main(argv) {
  const [mode, ...extraArgs] = argv;
  let plan;
  try {
    plan = buildCommand(mode, extraArgs);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const child = spawn(plan.command, plan.args, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: plan.shell,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  child.on('error', (error) => { console.error(`could not start Wrangler: ${error.message}`); process.exit(1); });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  return null;
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}

module.exports = { WRANGLER_VERSION, STATE_ENV, stateDir, buildCommand, quoteForShell };
