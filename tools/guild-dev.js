#!/usr/bin/env node
/**
 * Runs the guild tracker locally: Wrangler (pinned) with the local D1 kept outside OneDrive.
 *   node tools/guild-dev.js migrate [wrangler args]   apply migrations/ to the local D1
 *   node tools/guild-dev.js dev     [wrangler args]   start the Worker, local D1 and static files
 * Other arguments pass straight through, e.g.
 *   npm run guild:dev -- --var DISCORD_API_BASE:http://127.0.0.1:8790 --port 8788
 * Nothing needs a Cloudflare login. Secrets come from .env at the repo root (never printed here).
 */
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WRANGLER_VERSION = '4.146.0';

function stateDir() {
  return path.join(os.homedir(), '.raidsmith-dev', 'wrangler-state');
}

// -> { command, args } for the npx call that runs Wrangler.
function buildCommand(mode, extraArgs = []) {
  if (mode !== 'migrate' && mode !== 'dev') throw new Error('usage: guild-dev.js migrate|dev [wrangler args]');
  const wrangler = mode === 'migrate' ? ['d1', 'migrations', 'apply', 'DB', '--local'] : ['dev'];
  return {
    command: 'npx',
    args: ['--yes', `wrangler@${WRANGLER_VERSION}`, ...wrangler, '--persist-to', stateDir(), ...extraArgs],
  };
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
    shell: process.platform === 'win32',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  return null;
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}

module.exports = { WRANGLER_VERSION, stateDir, buildCommand };
