/**
 * PartyPlanner Web - run every test suite
 * Run: npm test   (or: node tests/run-all.js [name-filter])
 *
 * Each suite is a standalone script at the repo root that exits non-zero on
 * failure. They run one after another as child processes; output is shown only
 * for failing suites. Exits 1 if any suite fails, so CI and the Vercel
 * ignoreCommand gate can rely on the exit code.
 *
 * Suites are discovered by file name so a new one cannot be forgotten:
 *   tests.js, *-tests.js, *-scenarios.js   -> suites
 *   scenarios.js                           -> fixture data for scenario-tests.js (not run)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITE_PATTERN = /^(?:.+-tests|tests|.+-scenarios)\.js$/;
const filter = process.argv[2] || '';

const suites = fs.readdirSync(ROOT)
  .filter(name => SUITE_PATTERN.test(name) && name.includes(filter))
  .sort();
if (!suites.length) {
  console.error(`run-all: no test suites found in ${ROOT}${filter ? ` matching "${filter}"` : ''}`);
  process.exit(1);
}

const results = suites.map(name => {
  const started = process.hrtime.bigint();
  const run = spawnSync(process.execPath, [name], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const ok = run.status === 0 && !run.error;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(32)} ${seconds.toFixed(2)}s`);
  if (!ok) {
    if (run.error) console.log(`      could not run: ${run.error.message}`);
    else if (run.status === null) console.log(`      killed by signal ${run.signal}`);
    if (run.stdout) console.log(run.stdout.trimEnd().replace(/^/gm, '      | '));
    if (run.stderr) console.log(run.stderr.trimEnd().replace(/^/gm, '      | '));
  }
  return { name, ok, seconds };
});

const failed = results.filter(r => !r.ok);
const total = results.reduce((sum, r) => sum + r.seconds, 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${total.toFixed(2)}s`);
if (failed.length) {
  console.log(`Failed: ${failed.map(r => r.name).join(', ')}`);
  process.exit(1);
}
