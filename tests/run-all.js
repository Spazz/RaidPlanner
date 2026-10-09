/**
 * PartyPlanner Web - run every test suite
 * Run: npm test   (or: node tests/run-all.js [name-filter])
 *
 * Each suite is a standalone script at the repo root that exits non-zero on
 * failure. They run as child processes, a few at a time; output is shown only
 * for failing suites. Exits 1 if any suite fails, so CI can rely on the exit code.
 *
 * Suites are discovered by file name so a new one cannot be forgotten:
 *   tests.js, *-tests.js, *-scenarios.js   -> suites
 *   scenarios.js                           -> fixture data for scenario-tests.js (not run)
 * A slow suite named in tests/shards.js runs as several `--shard i/n` processes.
 * PP_TEST_JOBS sets how many processes run at once (default: up to 3, never more than
 * the CPU count; 1 runs everything one after another).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SHARDS } = require('./shards');

const ROOT = path.join(__dirname, '..');
const SUITE_PATTERN = /^(?:.+-tests|tests|.+-scenarios)\.js$/;
const filter = process.argv[2] || '';
const jobs = Math.max(1, Number(process.env.PP_TEST_JOBS) || Math.min(3, os.cpus().length));

const suites = fs.readdirSync(ROOT)
  .filter(name => SUITE_PATTERN.test(name) && name.includes(filter))
  .sort();
if (!suites.length) {
  console.error(`run-all: no test suites found in ${ROOT}${filter ? ` matching "${filter}"` : ''}`);
  process.exit(1);
}

// One unit per process: a plain suite, or one shard of a sharded suite.
const units = suites.flatMap(name => {
  const count = SHARDS[name] || 0;
  if (!count) return [{ label: name, args: [name] }];
  return Array.from({ length: count }, (_, i) => ({ label: `${name} [${i + 1}/${count}]`, args: [name, '--shard', `${i + 1}/${count}`] }));
});

function runUnit(unit) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, unit.args, { cwd: ROOT });
    let stdout = '', stderr = '', error = null;
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { error = err; });
    child.on('close', (status, signal) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      resolve({ ...unit, ok: status === 0 && !error, status, signal, error, stdout, stderr, seconds });
    });
  });
}

function report(r) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(32)} ${r.seconds.toFixed(2)}s`);
  if (r.ok) return;
  if (r.error) console.log(`      could not run: ${r.error.message}`);
  else if (r.status === null) console.log(`      killed by signal ${r.signal}`);
  if (r.stdout) console.log(r.stdout.trimEnd().replace(/^/gm, '      | '));
  if (r.stderr) console.log(r.stderr.trimEnd().replace(/^/gm, '      | '));
}

async function main() {
  const started = Date.now();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < units.length) {
      const result = await runUnit(units[next++]);
      results.push(result);
      report(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, units.length) }, worker));

  const failed = results.filter(r => !r.ok);
  const cpu = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${((Date.now() - started) / 1000).toFixed(2)}s (${cpu.toFixed(2)}s of suite time, ${jobs} at a time)`);
  if (failed.length) {
    console.log(`Failed: ${failed.map(r => r.label).join(', ')}`);
    process.exit(1);
  }
}

main();
