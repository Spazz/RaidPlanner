/**
 * PartyPlanner Web - index.html split tests
 * Run: node split-tests.js
 *
 * index.html is a thin page: two stylesheets (app.css, then guild.css for the shell around the planner) and the app
 * as ordered classic <script src> files under js/ (no build step, no defer/async/module); the planner's scripts
 * come first, then the guild shell's (js/guild/, the list in tests/guild-scripts.js).
 * These checks pin that shape:
 *   - the page references only root-absolute files that exist and are whitelisted in .gitignore
 *     (relative paths would break on the /<version>/<id> live-link rewrite)
 *   - the scripts compile, and run in page order with NO load-time dependency on a later file
 *     (function declarations hoist per file, so a top-level call into a later file is a
 *     ReferenceError/TypeError in the browser even though one big script would have worked)
 *   - optional PROOF OF NO CHANGE for the split commit itself:
 *       SPLIT_BASE_REF=<pre-split commit> node split-tests.js
 *     compares the files, concatenated in page order, with the inline <script>/<style> of
 *     index.html at that ref (modulo newlines at file boundaries) and the rest of the page
 *     byte for byte. It is opt-in because every later edit to the app legitimately differs.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const app = require('./tests/load-app');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

let passed = 0;
let skipped = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const ROOT = app.ROOT;
const read = relPath => fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const gitignoreLines = read('.gitignore').split('\n').map(l => l.trim());
const rel = src => src.replace(/^\//, '');

check('index.html carries no inline <script> or <style>', () => {
  assert.ok(!/<style\b/i.test(html), 'inline <style> found');
  assert.ok(![...html.matchAll(/<script\b([^>]*)>/gi)].some(m => !/\bsrc\s*=/.test(m[1])), 'inline <script> found');
});

check('the page links /app.css and /guild.css and loads every js file as a plain classic script', () => {
  assert.deepEqual(app.stylesheets, ['/app.css', '/guild.css']);
  assert.ok(app.scripts.length >= 6 && app.scripts.length <= 70, `${app.scripts.length} script files`);
  for (const src of app.scripts) assert.match(src, /^\/js\/(?:rules\/|guild\/)?[a-z0-9-]+\.js$/, `${src} must be root-absolute under /js/ (the rules data files under /js/rules/, the guild shell under /js/guild/)`);
  assert.equal(new Set(app.scripts).size, app.scripts.length, 'a script is loaded twice');
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    assert.ok(!/\b(?:defer|async)\b/i.test(m[1]) && !/type\s*=/i.test(m[1]), `script tag must be plain: ${m[0]}`);
  }
});

// js/rules/ holds the rules data files and js/guild/ the guild shell: one glob line whitelists each directory's
// scripts, every other file has its own line.
const DATA_DIR = 'js/rules';
const GUILD_DIR = 'js/guild';
const whitelisted = file => gitignoreLines.includes(`!${file}`)
  || ([DATA_DIR, GUILD_DIR].includes(path.posix.dirname(file)) && gitignoreLines.includes(`!${path.posix.dirname(file)}/*.js`));
const scriptsIn = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => `/${dir}/${f}`);

check('every referenced file exists, is non-empty and is whitelisted in .gitignore', () => {
  for (const src of [...app.scripts, ...app.stylesheets]) {
    assert.ok(fs.statSync(path.join(ROOT, rel(src))).size > 0, `${src} missing or empty`);
    assert.ok(whitelisted(rel(src)), `.gitignore has no "!${rel(src)}" line`);
  }
  assert.ok(gitignoreLines.includes('!js/'), '.gitignore must un-ignore the js/ directory');
  assert.ok(gitignoreLines.includes(`!${DATA_DIR}/`), `.gitignore must un-ignore the ${DATA_DIR}/ directory`);
  assert.ok(gitignoreLines.includes(`!${GUILD_DIR}/`), `.gitignore must un-ignore the ${GUILD_DIR}/ directory`);
  const onDisk = [...scriptsIn('js'), ...scriptsIn(DATA_DIR), ...scriptsIn(GUILD_DIR)].sort();
  assert.deepEqual(onDisk, [...app.scripts].sort(), 'js/, js/rules/ or js/guild/ holds a file the page does not load (or vice versa)');
});

check('the page ends with the guild scripts in the order of tests/guild-scripts.js', () => {
  const tail = GUILD_SCRIPTS.slice(1); // util.js is the page's first script
  assert.deepEqual(app.scripts.slice(app.scripts.length - tail.length), tail);
  assert.equal(app.scripts[0], GUILD_SCRIPTS[0]);
});

check('the page head still carries the fonts and icon links', () => {
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Barlow:[^"]+" rel="stylesheet">/);
  assert.ok(html.indexOf('fonts.googleapis.com') < html.indexOf('href="/app.css"'), 'app.css must come after the font link');
});

check('each file compiles alone, and so does their concatenation', () => {
  for (const src of app.scripts) new vm.Script(read(rel(src)), { filename: rel(src) });
  app.compileFull();
});

/** Mirrors the browser: one vm.Script per file, shared global scope, in page order. */
function runPage(order, globals) {
  const ctx = vm.createContext(globals);
  for (const src of order) new vm.Script(read(rel(src)), { filename: rel(src) }).runInContext(ctx);
  return ctx;
}

check('logic files run one by one in page order (no top-level use of a later file)', () => {
  const uiIndex = app.scripts.findIndex(src => read(rel(src)).includes('// ── UI RENDERING'));
  assert.ok(uiIndex >= 3, 'the UI marker file should come after several logic files');
  runPage(app.scripts.slice(0, uiIndex), { TextEncoder, TextDecoder, console });
});

/** A DOM-less window where every property is a callable no-op, enough to execute the UI files' load-time wiring. */
function lenientBrowser() {
  const stub = () => new Proxy(function () {}, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* () {};
      if (key === 'length') return 0;
      if (key === 'then' || key === 'matches') return undefined;
      return stub();
    },
    set: () => true,
    apply: () => stub(),
    construct: () => stub(),
  });
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  // There is no #guild-root in the stub, so the guild shell loads its modules and does not boot.
  const doc = stub();
  const document = new Proxy(doc, { get: (target, key) => (key === 'getElementById' ? id => (id === 'guild-root' ? null : target.getElementById(id)) : target[key]) });
  const g = {
    TextEncoder, TextDecoder, console, URL, URLSearchParams, document,
    location: { search: '', hash: '', pathname: '/', href: 'http://localhost/' },
    navigator: { userAgent: '', clipboard: stub() }, localStorage: store, sessionStorage: store,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => stub(), history: { replaceState() {}, pushState() {} },
    fetch: () => Promise.reject(new Error('offline')), performance: { now: () => 0 },
    requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, scrollTo() {}, innerWidth: 1280, innerHeight: 800,
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    Blob: class {}, FileReader: class {}, Image: class {}, Event: class {}, CustomEvent: class {},
  };
  g.window = g;
  return g;
}

check('the whole page runs in page order against a lenient DOM stub, and exposes window.PP', () => {
  const ctx = runPage(app.scripts, lenientBrowser());
  assert.ok(ctx.window.PP && ctx.window.PP.State && ctx.window.PP.Optimizer, 'window.PP not exposed by the planner scripts');
  assert.ok(ctx.window.PP.shell && typeof ctx.window.PP.shell.setActive === 'function', 'window.PP.shell (the shell contract) is exposed');
});

check('the load-order check is sensitive: loading modals.js and app.js swapped fails', () => {
  // site-pages.js comes after app.js and is deliberately tolerant, so the swap is of the two scripts before it.
  const last = app.scripts.indexOf('/js/app.js');
  assert.equal(app.scripts[last - 1], '/js/modals.js');
  const swapped = [...app.scripts];
  [swapped[last - 1], swapped[last]] = [swapped[last], swapped[last - 1]];
  assert.throws(() => runPage(swapped, lenientBrowser()), /not defined|is not a function/);
});

const baseRef = process.env.SPLIT_BASE_REF;
if (!baseRef) {
  skipped++;
  console.log('SKIP  split equals the pre-split inline page (set SPLIT_BASE_REF=<commit> to run)');
} else {
  check(`split proof vs ${baseRef}: scripts, styles and the rest of the page are unchanged`, () => {
    const original = execFileSync('git', ['show', `${baseRef}:index.html`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\r\n/g, '\n');
    const scripts = [...original.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const styles = [...original.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    assert.equal(scripts.length, 1, 'the base page must hold exactly one inline script');
    assert.ok(styles.length >= 1);
    const edge = s => s.replace(/^\n+/, '').replace(/\n+$/, '');

    // Concatenated in page order == the original inline script / style blocks.
    assert.equal(edge(app.scripts.map(s => read(rel(s))).join('')), edge(scripts[0][1]), 'JS differs from the inline script');
    assert.equal(edge(app.stylesheets.map(s => read(rel(s))).join('')), edge(styles.map(m => m[1]).join('')), 'CSS differs from the inline styles');
    for (const src of app.scripts) assert.ok(read(rel(src)).endsWith('\n'), `${src} must end with a newline`);

    // Everything else in index.html is byte for byte the same once the inline blocks become tags.
    let first = true;
    const rebuilt = original
      .replace(/<style>[\s\S]*?<\/style>\n?/g, () => (first ? ((first = false), '<link rel="stylesheet" href="/app.css">\n') : ''))
      .replace(/<script>[\s\S]*?<\/script>/, app.scripts.map(s => `<script src="${s}"></script>`).join('\n'));
    assert.equal(html, rebuilt, 'index.html differs from the original outside its inline blocks');
  });
}

console.log(`\nSplit tests: ${passed} passed, 0 failed${skipped ? `, ${skipped} skipped` : ''}`);
