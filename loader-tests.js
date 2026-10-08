/**
 * PartyPlanner Web - test loader tests
 * Run: node loader-tests.js
 *
 * tests/load-app.js is what every other suite trusts to hand it the real app
 * code. These checks prove it refuses (instead of silently slicing the wrong
 * code) when index.html stops having the shape the suites expect: the app is
 * the ordered <script src> files, with the '// ── UI RENDERING' marker once.
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
const tag = src => `<script src="${src}"></script>`;
/** A fake page loading `files` (name -> source) in object order, with an optional extra head chunk. */
const pageOf = (files, before = '') => ({
  html: `<html>${before}${Object.keys(files).map(tag).join('')}</html>`,
  read: p => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  },
});
const load = (files, before) => { const p = pageOf(files, before); return app.fromHtml(p.html, p.read); };
const GOOD = { 'js/a.js': 'const A = 1;', 'js/b.js': `${MARKER}\nconst B = 2;\n// END` };

check('the real index.html loads: ordered script files, logic half stops at the marker', () => {
  assert.ok(app.scripts.length >= 2 && app.scripts.every(s => /^\/js\/[\w-]+\.js$/.test(s)), app.scripts.join());
  assert.ok(app.logic.length > 1000 && app.logic.length < app.script.length);
  assert.ok(!app.logic.includes(MARKER));
  assert.ok(app.script.includes(MARKER));
  assert.ok(app.css.length > 1000 && app.stylesheets.includes('/app.css'));
});

check('real-page chunks the suites slice out exist', () => {
  assert.match(app.slice('const IdealComp = {', '// ── TAB SWITCHING'), /^const IdealComp = \{/);
  assert.ok(app.slice('function normalizeImportSource(', '// Fetch roster JSON').length > 0);
});

check('a well-formed page exposes bindings from the logic half only, joined across files', () => {
  const good = load(GOOD);
  assert.deepEqual(good.scripts, ['js/a.js', 'js/b.js']);
  assert.equal(good.sandbox(['A']).api.A, 1);
  assert.throws(() => good.sandbox(['B']), /B is not defined/, 'code below the marker is not loaded');
  assert.equal(good.requireLogic(['A']).A, 1);
  assert.equal(good.sandbox(['A', 'B'], { extraSource: good.slice('const B', '// END') }).api.B, 2);
});

check('files are concatenated in page order, and a file without a trailing newline cannot glue onto the next', () => {
  const two = load({ 'js/a.js': 'const A = 1; // no newline', 'js/b.js': `const B = A + 1;\n${MARKER}\n` });
  assert.equal(two.sandbox(['A', 'B']).api.B, 2);
  assert.throws(() => load({ 'js/b.js': 'const B = A + 1;\nconst X = 1;', 'js/a.js': `const A = 1;\n${MARKER}\n` }).sandbox(['B']), /A/);
});

check('query strings and a missing leading slash resolve to the same file', () => {
  const html = `<script src="/js/a.js?v=2"></script><script src="js/b.js"></script>`;
  const files = { 'js/a.js': 'const A = 1;', 'js/b.js': `${MARKER}\n` };
  assert.equal(app.fromHtml(html, p => files[p]).sandbox(['A']).api.A, 1);
});

check('a missing split marker throws instead of slicing with -1', () => {
  assert.throws(() => load({ 'js/a.js': 'const A = 1;' }), /marker .* not found/);
});

check('a duplicated split marker throws, even when it is spread over two files', () => {
  assert.throws(() => load({ 'js/a.js': `a\n${MARKER}\nb\n${MARKER}\nc` }), /more than once/);
  assert.throws(() => load({ 'js/a.js': `${MARKER}\n`, 'js/b.js': `${MARKER}\n` }), /more than once/);
});

check('an inline script, or a page with no local scripts, throws; external src scripts are ignored', () => {
  assert.throws(() => app.fromHtml('<p>nothing</p>'), /no local <script src>/);
  assert.throws(() => app.fromHtml(`${tag('js/a.js')}<script>x</script>`, () => 'a'), /no inline <script>.*found 1/);
  assert.throws(() => app.fromHtml('<script>const A = 1;\n' + MARKER + '</script>', () => 'a'), /found 1/);
  const files = { 'js/a.js': `const A = 1;\n${MARKER}\n` };
  const withCdn = load(files, '<script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script>');
  assert.deepEqual(withCdn.scripts, ['js/a.js']);
  assert.equal(withCdn.sandbox(['A']).api.A, 1);
});

check('a script file that is missing or empty throws, naming the file', () => {
  assert.throws(() => app.fromHtml(`${tag('/js/gone.js')}`, () => { throw new Error('ENOENT'); }), /cannot read "\/js\/gone.js"/);
  assert.throws(() => load({ 'js/a.js': '  \n ' }), /"js\/a.js" referenced by index.html is empty/);
});

check('local stylesheets are concatenated in page order; external ones are ignored', () => {
  const html = `<link rel="stylesheet" href="https://fonts.example/f.css"><link rel="icon" href="/x.ico">`
    + `<link href='/one.css' rel='stylesheet'><link rel="stylesheet" href="/two.css">${tag('js/a.js')}`;
  const files = { 'one.css': 'a{}', 'two.css': 'b{}', 'js/a.js': `${MARKER}\n` };
  const page = app.fromHtml(html, p => files[p]);
  assert.deepEqual(page.stylesheets, ['/one.css', '/two.css']);
  assert.equal(page.css, 'a{}\nb{}\n');
});

check('slice throws on a missing start or end marker, and on an end marker before the start', () => {
  const good = load(GOOD);
  assert.throws(() => good.slice('nope', '// END'), /start marker not found/);
  assert.throws(() => good.slice('const B', 'nope'), /end marker not found/);
  assert.throws(() => good.slice('const B', 'const A'), /end marker not found after start/);
});

console.log(`\nLoader tests: ${passed} passed, 0 failed, ${passed} total`);
