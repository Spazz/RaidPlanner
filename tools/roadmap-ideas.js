#!/usr/bin/env node
/**
 * Triage for the idea box on the Future enhancements page: reads and updates roadmap_ideas in the local D1 the dev
 * server uses. It runs `wrangler d1 execute --local` through tools/guild-dev.js, so it opens the same state dir
 * (--state <dir>, else RAIDSMITH_DEV_STATE, else ~/.raidsmith-dev/wrangler-state) and never talks to Cloudflare.
 *   node tools/roadmap-ideas.js list [--status new|added|declined|done] [--state <dir>]
 *   node tools/roadmap-ideas.js mark <ideaId> <added|declined|done> [--roadmap <itemId>] [--note "..."] [--state <dir>]
 * list prints a JSON array of ideas, newest first. mark changes that one idea (status, and the roadmap item and note
 * when given; --roadmap must be an id in js/guild/roadmap-data.js and goes with added or done) and prints it as JSON.
 * The table comes from migrations/0007_roadmap_ideas.sql: run `node tools/guild-dev.js migrate` first.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const guildDev = require('./guild-dev.js');

const ROOT = path.join(__dirname, '..');
const STATUSES = ['new', 'added', 'declined', 'done'];
const MARK_STATUSES = ['added', 'declined', 'done'];
const IDEA_ID = /^ri_[A-Za-z0-9_-]{22}$/;
const ITEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ITEM_ID = 80;
const MAX_NOTE = 300;
const USAGE = [
  'usage:',
  '  node tools/roadmap-ideas.js list [--status new|added|declined|done] [--state <dir>]',
  '  node tools/roadmap-ideas.js mark <ideaId> <added|declined|done> [--roadmap <itemId>] [--note "..."] [--state <dir>]',
].join('\n');
const COLUMNS = `id, title, details, area, status, roadmap_id AS roadmapId, triage_note AS triageNote, created_at AS createdAt, updated_at AS updatedAt`;

class UsageError extends Error {}

// Pulls `--name value` / `--name=value` pairs and positionals out of the arguments.
function splitArgs(args, flagNames) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!flagNames.includes(name)) throw new UsageError(`unknown option ${name}`);
    if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`${name} given twice`);
    if (eq >= 0) flags[name] = arg.slice(eq + 1);
    else if (i + 1 < args.length) flags[name] = args[++i];
    else throw new UsageError(`${name} needs a value`);
  }
  return { flags, positional };
}

// argv (without node and the script) -> { command: 'list', status, state } | { command: 'mark', id, status, roadmapId, note, state }.
// roadmapId and note are null when not given (the column stays as it is); a note of "" clears it.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'mark') throw new UsageError('say list or mark');
  const { flags, positional } = splitArgs(rest, command === 'list' ? ['--status', '--state'] : ['--roadmap', '--note', '--state']);
  const state = Object.prototype.hasOwnProperty.call(flags, '--state') ? flags['--state'] : null;
  if (state !== null && !state.trim()) throw new UsageError('--state needs a directory');
  if (command === 'list') {
    if (positional.length) throw new UsageError('list takes no arguments besides --status');
    const status = Object.prototype.hasOwnProperty.call(flags, '--status') ? flags['--status'] : null;
    if (status !== null && !STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(', ')}`);
    return { command, status, state };
  }
  if (positional.length !== 2) throw new UsageError('mark needs an idea id and a status');
  const [id, status] = positional;
  if (!IDEA_ID.test(id)) throw new UsageError(`${id} is not an idea id (ri_ and 22 characters)`);
  if (!MARK_STATUSES.includes(status)) throw new UsageError(`status must be one of ${MARK_STATUSES.join(', ')}`);
  let roadmapId = null;
  if (Object.prototype.hasOwnProperty.call(flags, '--roadmap')) {
    roadmapId = flags['--roadmap'];
    if (status === 'declined') throw new UsageError('--roadmap goes with added or done, not declined');
    if (!ITEM_ID.test(roadmapId) || roadmapId.length > MAX_ITEM_ID) throw new UsageError('--roadmap must be a kebab-case roadmap item id');
  }
  let note = null;
  if (Object.prototype.hasOwnProperty.call(flags, '--note')) {
    note = flags['--note'].trim();
    if (/[\u0000-\u001f\u007f]/.test(note)) throw new UsageError('--note must be one line of plain text');
    if (Array.from(note).length > MAX_NOTE) throw new UsageError(`--note can be at most ${MAX_NOTE} characters`);
  }
  return { command, id, status, roadmapId, note, state };
}

// Wrangler takes no bound parameters on the command line, so every value is validated above and quoted here.
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function buildSql(parsed, nowMs) {
  if (parsed.command === 'list') {
    return `SELECT ${COLUMNS} FROM roadmap_ideas${parsed.status ? ` WHERE status = ${quote(parsed.status)}` : ''} ORDER BY created_at DESC, rowid DESC`;
  }
  const sets = [`status = ${quote(parsed.status)}`];
  if (parsed.roadmapId !== null) sets.push(`roadmap_id = ${quote(parsed.roadmapId)}`);
  if (parsed.note !== null) sets.push(`triage_note = ${parsed.note ? quote(parsed.note) : 'NULL'}`);
  sets.push(`updated_at = ${Math.floor(nowMs)}`);
  return `UPDATE roadmap_ideas SET ${sets.join(', ')} WHERE id = ${quote(parsed.id)} RETURNING ${COLUMNS}`;
}

// The item ids in js/guild/roadmap-data.js (a classic script that fills window.Guild or globalThis.Guild).
function roadmapItemIds(file = path.join(ROOT, 'js', 'guild', 'roadmap-data.js')) {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const items = sandbox.Guild && sandbox.Guild.roadmap && Array.isArray(sandbox.Guild.roadmap.items) ? sandbox.Guild.roadmap.items : [];
  return Array.from(items, (item) => item.id);
}

// Wrangler's --json output: an array with one entry per statement; the rows are the first entry's `results`.
function parseRows(stdout) {
  const found = /(^|\n)\[/.exec(stdout);
  if (!found) throw new Error('Wrangler printed no JSON');
  const parsed = JSON.parse(stdout.slice(found.index + found[1].length));
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (!first || !Array.isArray(first.results)) throw new Error('Wrangler printed JSON in a shape this tool does not know');
  return first.results;
}

// deps: { exec(plan) -> { status, stdout, stderr }, now(), itemIds() } (each injectable for tests). Returns the exit code.
function run(argv, deps = {}, out = console) {
  const exec = deps.exec || ((plan) => spawnSync(plan.command, plan.args, {
    cwd: ROOT, encoding: 'utf8', shell: plan.shell, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  }));
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.command === 'mark' && parsed.roadmapId !== null && !(deps.itemIds || roadmapItemIds)().includes(parsed.roadmapId)) {
      throw new UsageError(`${parsed.roadmapId} is not an item id in js/guild/roadmap-data.js (add the item there first)`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    out.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const sql = buildSql(parsed, (deps.now || Date.now)());
  const plan = guildDev.buildCommand('execute', [...(parsed.state ? ['--state', parsed.state] : []), '--command', sql, '--json']);
  const result = exec(plan);
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    out.error(/no such table/i.test(text)
      ? 'The roadmap_ideas table is missing: run `node tools/guild-dev.js migrate` first.'
      : `Wrangler failed (exit ${result.status}):\n${text.trim()}`);
    return 1;
  }
  let rows;
  try {
    rows = parseRows(result.stdout || '');
  } catch (error) {
    out.error(`${error.message}:\n${text.trim()}`);
    return 1;
  }
  if (parsed.command === 'mark') {
    if (rows.length !== 1) {
      out.error(`No idea has the id ${parsed.id}. Run list to see them.`);
      return 1;
    }
    out.log(JSON.stringify(rows[0], null, 2));
    return 0;
  }
  out.log(JSON.stringify(rows, null, 2));
  return 0;
}

if (require.main === module) process.exit(run(process.argv.slice(2)));

module.exports = { STATUSES, MARK_STATUSES, USAGE, UsageError, parseArgs, buildSql, parseRows, roadmapItemIds, run };
