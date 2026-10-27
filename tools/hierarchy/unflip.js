#!/usr/bin/env node
/**
 * UNFLIP (user-hierarchy build, lane B9): takes ONE guild back from the in-game rank source to the legacy rule, so a bad flip needs no Time Travel restore.
 *
 *   node tools/hierarchy/unflip.js --guild <g_...> [--out <file.sql>] [--facts <file.json>] [--state <dir> [--apply]]
 *
 * What it undoes (MEMBERSHIP AND PERMISSIONS only):  guilds.rank_source back to NULL, the stored Guild Master row recreated from guilds.owner_user_id, owner_user_id back to NULL, and one
 * `guild.source_switch` audit row. What it leaves exactly as the flip and the syncs made it: core_rank, left_on, the Trial dates, the identity keys the name binding wrote, every person
 * and character the in-game sign-in match created (a person it made stays linked: it is on the in-game roster, so it counts as a member under the legacy rule too), joins, tombstones,
 * and the roles the flip made hand-set (they were Discord-given; the Discord role sync never takes a hand-set row away). The pin (blizzard_guild_id and the other pin columns) stays, so a
 * second flip needs no new pin.
 *
 * Every statement is GUARDED (the guild is 'ingame', has a seat, and the stored Guild Master row exists for that seat before the seat is cleared), so a second run changes nothing and a
 * run against a guild that is not flipped changes nothing either.
 *
 * Modes
 *   (default)         print the SQL to stdout; with --out write it to a file for `wrangler d1 execute <db> --remote --file <file>`. THIS TOOL NEVER TOUCHES A REMOTE DATABASE: the person
 *                     running it on live does that, after checking the guild with the query `--facts` describes (below).
 *   --facts <file>    the JSON that `wrangler d1 execute <db> --remote --json --command "<the facts query this tool prints with --print-facts-query>"` returned (or one bare row).
 *                     The tool refuses, with a message, when the guild is not 'ingame', has no Owner seat (owner_user_id NULL) or has a stored Guild Master row for another account.
 *   --state <dir>     a LOCAL wrangler state (the same directory guild-dev.js uses): the tool reads the facts itself and refuses on them. With --apply it runs the SQL there too.
 *   --print-facts-query   print the facts query for the guild and exit.
 * Exit codes: 0 done / printed, 1 refused or failed, 2 usage.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUILD_ID = /^g_[A-Za-z0-9_-]{22}$/;

// The one query that tells whether an unflip makes sense for the guild (run it on the target database).
function factsSql(guildId) {
  return `SELECT g.id AS id, g.rank_source AS rank_source, g.owner_user_id AS owner_user_id, `
    + `(SELECT r.user_id FROM role_assignments r WHERE r.guild_id = g.id AND r.role_id = 'guild_master') AS stored_master_user FROM guilds g WHERE g.id = '${guildId}'`;
}

// -> the sentence that says why the guild cannot be unflipped, or null.
function refusalFor(facts, guildId) {
  if (!facts || !facts.id) return `There is no guild ${guildId} in this database.`;
  if (facts.rank_source !== 'ingame') {
    return `Guild ${guildId} is not on the in-game roster (rank_source is ${facts.rank_source === null ? 'NULL' : `'${facts.rank_source}'`}), so there is nothing to undo.`;
  }
  if (facts.owner_user_id === null || facts.owner_user_id === undefined) {
    return `Guild ${guildId} has no Owner seat (owner_user_id is NULL), so the stored Guild Master row cannot be recreated and the legacy rule would leave the guild without an Owner. `
      + 'Restore the seat first, or go back to the Time Travel bookmark taken before the flip.';
  }
  if (facts.stored_master_user && facts.stored_master_user !== facts.owner_user_id) {
    return `Guild ${guildId} already has a stored Guild Master row for another account than its Owner seat. Remove that row first, then run the unflip again.`;
  }
  return null;
}

// Wrangler's --json answer ([{ results: [...] }]) or a bare row or array of rows -> the first row, or null.
function parseFacts(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let value;
  try {
    value = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  const first = Array.isArray(value) ? value[0] : value;
  if (first && Array.isArray(first.results)) return first.results[0] || null;
  return first && typeof first === 'object' && 'id' in first ? first : null;
}

// The SQL of the unflip for one guild. `guildId` has been checked against GUILD_ID (it is pasted into the text; nothing else is).
function buildUnflipSql(guildId) {
  if (!GUILD_ID.test(guildId)) throw new Error('not a guild id');
  const flipped = `g.id = '${guildId}' AND g.rank_source = 'ingame' AND g.owner_user_id IS NOT NULL`;
  return `-- Raidsmith UNFLIP of guild ${guildId} (tools/hierarchy/unflip.js). Every statement is guarded: a second run, or a run against a guild that is not flipped, changes nothing.
-- 1. the stored Guild Master row again, for the account that holds the seat (idx_role_assignments_one_gm: at most one such row per guild)
INSERT OR IGNORE INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at, source)
SELECT 'ra_' || lower(hex(randomblob(11))), g.id, g.owner_user_id, 'guild_master', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'manual'
  FROM guilds g WHERE ${flipped};
-- 2. the audit row, only while the guild is still flipped and its row exists (so it is written once)
INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role)
SELECT 'al_' || lower(hex(randomblob(16))), g.id, NULL, 'guild.source_switch', 'guild', g.id, '{"rankSource":"ingame"}', '{"rankSource":null,"unpinned":false,"unflip":true}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL
  FROM guilds g WHERE ${flipped}
   AND EXISTS (SELECT 1 FROM role_assignments r WHERE r.guild_id = g.id AND r.role_id = 'guild_master' AND r.user_id = g.owner_user_id);
-- 3. the legacy rule again: no rank source, no seat (the stored row of step 1 is the Owner from here on)
UPDATE guilds SET rank_source = NULL, owner_user_id = NULL
 WHERE id = '${guildId}' AND rank_source = 'ingame' AND owner_user_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM role_assignments r WHERE r.guild_id = guilds.id AND r.role_id = 'guild_master' AND r.user_id = guilds.owner_user_id);
`;
}

// ---------------------------------------------------------------------------
// Local state (guild-dev.js runs Wrangler against it; windowsHide keeps a console window from opening)

function wrangler(args) {
  const { buildCommand } = require('../guild-dev');
  const plan = buildCommand('execute', args);
  return spawnSync(plan.command, plan.args, {
    cwd: path.join(__dirname, '..', '..'), shell: plan.shell, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

function readLocalFacts(stateDir, guildId) {
  const result = wrangler(['--state', stateDir, '--json', '--command', factsSql(guildId)]);
  if (result.status !== 0) throw new Error(`could not read the guild from ${stateDir}: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  return parseFacts(result.stdout);
}

function applyLocal(stateDir, sql) {
  const file = path.join(os.tmpdir(), `unflip-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(file, sql);
  try {
    const result = wrangler(['--state', stateDir, '--file', file]);
    if (result.status !== 0) throw new Error(`the SQL did not apply: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------

function takeArgs(argv) {
  const options = { guild: null, out: null, facts: null, state: null, apply: false, printFactsQuery: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--print-facts-query') options.printFactsQuery = true;
    else if (['--guild', '--out', '--facts', '--state'].includes(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = takeArgs(argv);
    if (!options.guild || !GUILD_ID.test(options.guild)) throw new Error('--guild needs a guild id (g_ and 22 characters)');
    if (options.apply && !options.state) throw new Error('--apply needs --state <dir>: this tool applies to a local state only; a remote database is changed by running the SQL file there yourself');
    if (options.state && options.facts) throw new Error('give --state or --facts, not both');
  } catch (error) {
    stderr.write(`${error.message}\n${fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n').replace(/^ \* ?/gm, '')}\n`);
    return 2;
  }
  if (options.printFactsQuery) {
    stdout.write(`${factsSql(options.guild)}\n`);
    return 0;
  }
  try {
    let facts;
    let checked = true;
    if (options.state) facts = readLocalFacts(path.resolve(options.state), options.guild);
    else if (options.facts) facts = parseFacts(fs.readFileSync(options.facts, 'utf8'));
    else checked = false;
    if (checked) {
      const refusal = refusalFor(facts, options.guild);
      if (refusal) {
        stderr.write(`REFUSED: ${refusal}\n`);
        return 1;
      }
    } else {
      stderr.write('Note: the guild was not checked (no --state or --facts). The SQL is guarded, so it changes nothing unless the guild is flipped and has an Owner seat.\n');
    }
    const sql = buildUnflipSql(options.guild);
    if (options.apply) {
      applyLocal(path.resolve(options.state), sql);
      const after = readLocalFacts(path.resolve(options.state), options.guild);
      stdout.write(`Unflipped ${options.guild}: rank_source ${after && after.rank_source === null ? 'NULL' : JSON.stringify(after && after.rank_source)}, owner_user_id ${after && after.owner_user_id === null ? 'NULL' : 'still set'}, stored Guild Master row for ${after && after.stored_master_user ? 'the former Owner' : 'nobody (check the guild)'}.\n`);
      return after && after.rank_source === null && after.owner_user_id === null && after.stored_master_user ? 0 : 1;
    }
    if (options.out) {
      fs.writeFileSync(options.out, sql);
      stdout.write(`Wrote ${options.out}. Run it with: wrangler d1 execute <db> --remote --file ${options.out}\n`);
    } else {
      stdout.write(sql);
    }
    return 0;
  } catch (error) {
    stderr.write(`FAILED: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { GUILD_ID, factsSql, refusalFor, parseFacts, buildUnflipSql, main };
