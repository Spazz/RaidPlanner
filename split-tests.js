/**
 * PartyPlanner Web - index.html split tests
 * Run: node split-tests.js
 *
 * index.html is a thin page: one stylesheet (app.css) and the app as ordered
 * classic <script src> files under js/ (no build step, no defer/async/module).
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

check('the page links /app.css and loads every js file as a plain classic script', () => {
  assert.deepEqual(app.stylesheets, ['/app.css']);
  assert.ok(app.scripts.length >= 6 && app.scripts.length <= 12, `${app.scripts.length} script files`);
  for (const src of app.scripts) assert.match(src, /^\/js\/[a-z0-9-]+\.js$/, `${src} must be root-absolute under /js/`);
  assert.equal(new Set(app.scripts).size, app.scripts.length, 'a script is loaded twice');
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    assert.ok(!/\b(?:defer|async)\b/i.test(m[1]) && !/type\s*=/i.test(m[1]), `script tag must be plain: ${m[0]}`);
  }
});

check('every referenced file exists, is non-empty and is whitelisted in .gitignore', () => {
  for (const src of [...app.scripts, ...app.stylesheets]) {
    assert.ok(fs.statSync(path.join(ROOT, rel(src))).size > 0, `${src} missing or empty`);
    assert.ok(gitignoreLines.includes(`!${rel(src)}`), `.gitignore has no "!${rel(src)}" line`);
  }
  assert.ok(gitignoreLines.includes('!js/'), '.gitignore must un-ignore the js/ directory');
  const onDisk = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => `/js/${f}`).sort();
  assert.deepEqual(onDisk, [...app.scripts].sort(), 'js/ holds a file the page does not load (or vice versa)');
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
  const g = {
    TextEncoder, TextDecoder, console, URL, URLSearchParams, document: stub(),
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
  assert.ok(ctx.window.PP && ctx.window.PP.State && ctx.window.PP.Optimizer, 'window.PP not exposed by the last script');
});

check('the load-order check is sensitive: loading the last two scripts swapped fails', () => {
  const last = app.scripts.length - 1;
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
