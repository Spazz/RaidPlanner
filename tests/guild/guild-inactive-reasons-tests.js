/**
 * Raidsmith guild tracker - U B2-Q1 (user 2026-10-25): an Inactive person's reason is Left guild or Kicked only
 * Run: node tests/guild/guild-inactive-reasons-tests.js
 *
 * Static checks (no database; the behaviour is in guild-roster-worker-tests.js, guild-b2-writers-tests.js, guild-roster-ui-tests.js and guild-wave1-ui-tests.js):
 *   - the Worker's reason list is exactly left + kicked, and PATCH /roster/:pid is the ONLY route that takes a reason (a trial End, the Details form and the
 *     CSV / Raid-Helper / Battle.net imports all go through it or send none), so one validation covers every write path;
 *   - the UI offers only those two, and the trial End sends no reason.
 * Old Break / Other values stay in players.left_reason (migration 0030's mapping, mismatch.sql, rederive.sql are untouched).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
const listed = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.js')).map((name) => `${dir}/${name}`);

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('the Worker takes exactly Left guild and Kicked', async () => {
  const data = await import(pathToFileURL(path.join(ROOT, 'worker/roster-data.js')).href);
  assert.deepEqual(data.LEFT_REASONS, ['left', 'kicked']);
});

check('only PATCH /roster/:pid reads a reason from a request', () => {
  const readers = [];
  for (const file of listed('worker/routes')) {
    read(file).forEach((line, index) => { if (/\bleftReason\b/.test(line)) readers.push(`${file}:${index + 1}`); });
  }
  assert.ok(readers.length > 0 && readers.every((spot) => spot.startsWith('worker/routes/roster.js:')), `leftReason is read outside roster.js: ${readers.join(', ')}`);
  // The validation sits next to the list it checks.
  assert.ok(read('worker/routes/roster.js').some((line) => /LEFT_REASONS\.includes\(leftReason\)/.test(line) && /throw bad\(.*'leftReason'\)/.test(line)));
});

check('the CSV and import routes read no reason and write none of their own', () => {
  for (const file of ['worker/routes/roster-import.js', 'worker/routes/roster-import-csv.js', 'worker/csv-roster.js', 'worker/routes/bnet-import.js', 'worker/routes/bnet-claims.js']) {
    read(file).forEach((line, index) => assert.ok(!/\bleftReason\b|'break'|'other'/.test(line), `${file}:${index + 1} ${line.trim()}`));
  }
});

check('the UI offers Left guild and Kicked, and the trial End sends no reason', () => {
  const ui = read('js/guild/ui.js');
  const line = ui.find((text) => /const LEFT_REASONS = \{/.test(text));
  assert.ok(line, 'LEFT_REASONS');
  assert.equal(line.trim(), "const LEFT_REASONS = { left: 'Left guild', kicked: 'Kicked' };");
  const trial = read('js/guild/pages-person-trial.js');
  assert.ok(!trial.some((text) => /leftReason|reason Other/.test(text)), 'the trial End names no reason');
  assert.ok(trial.some((text) => /G\.api\.trial\.update\(c\.gid, c\.pid, \{ expectedVersion: c\.rec\.person\.version, status: 'inactive' \}\)/.test(text)));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
