/**
 * PartyPlanner Web - test loader tests
 * Run: node loader-tests.js
 *
 * tests/load-app.js is what every other suite trusts to hand it the real app
 * code. These checks prove it refuses (instead of silently slicing the wrong
 * code) when index.html stops having the shape the suites expect.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const MARKER = '// ── UI RENDERING';
const page = (script, before = '') => `<html>${before}<script>${script}</script></html>`;
const GOOD = page(`const A = 1;\n${MARKER}\nconst B = 2;\n// END`);

check('the real index.html loads: one script, logic half stops at the marker', () => {
  assert.ok(app.logic.length > 1000 && app.logic.length < app.script.length);
  assert.ok(!app.logic.includes(MARKER));
  assert.ok(app.script.includes(MARKER));
});

check('real-page chunks the suites slice out exist', () => {
  assert.match(app.slice('const IdealComp = {', '// ── TAB SWITCHING'), /^const IdealComp = \{/);
  assert.ok(app.slice('function normalizeImportSource(', '// Fetch roster JSON').length > 0);
});

check('a well-formed page exposes bindings from the logic half only', () => {
  const good = app.fromHtml(GOOD);
  assert.equal(good.sandbox(['A']).api.A, 1);
  assert.throws(() => good.sandbox(['B']), /B is not defined/, 'code below the marker is not loaded');
  assert.equal(good.requireLogic(['A']).A, 1);
  assert.equal(good.sandbox(['A', 'B'], { extraSource: good.slice('const B', '// END') }).api.B, 2);
});

check('a missing split marker throws instead of slicing with -1', () => {
  assert.throws(() => app.fromHtml(page('const A = 1;')), /marker .* not found/);
});

check('a duplicated split marker throws', () => {
  assert.throws(() => app.fromHtml(page(`a\n${MARKER}\nb\n${MARKER}\nc`)), /more than once/);
});

check('zero or several inline scripts throw; external src scripts are ignored', () => {
  assert.throws(() => app.fromHtml('<p>nothing</p>'), /found 0/);
  assert.throws(() => app.fromHtml(page('a', `<script>x</script>`) ), /found 2/);
  assert.equal(app.fromHtml(page(`const A = 1;\n${MARKER}\n`, '<script src="x.js"></script>')).sandbox(['A']).api.A, 1);
});

check('an empty inline script throws', () => {
  assert.throws(() => app.fromHtml(page('  \n ')), /empty/);
});

check('slice throws on a missing start or end marker, and on an end marker before the start', () => {
  const good = app.fromHtml(GOOD);
  assert.throws(() => good.slice('nope', '// END'), /start marker not found/);
  assert.throws(() => good.slice('const B', 'nope'), /end marker not found/);
  assert.throws(() => good.slice('const B', 'const A'), /end marker not found after start/);
});

console.log(`\nLoader tests: ${passed} passed, 0 failed, ${passed} total`);
