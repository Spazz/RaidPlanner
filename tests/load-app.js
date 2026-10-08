/**
 * PartyPlanner Web - shared test loader
 *
 * Every suite tests the logic that lives in the app scripts, so they all need
 * the same three steps: read index.html, concatenate the classic <script src>
 * files it loads (js/*.js, in page order), and keep only the part above the
 * '// ── UI RENDERING' marker (pure logic, no DOM). This module does that once and
 * fails LOUDLY if the page no longer has the shape the suites rely on - a missing
 * marker would otherwise turn into indexOf() === -1 and silently slice the wrong
 * code, and a missing script file or a stray inline <script> would silently drop
 * code from every suite.
 *
 *   const app = require('./tests/load-app');
 *   const ctx = app.sandbox(['State', 'Config']);      // vm context, exports on ctx.api
 *   const PP  = app.requireLogic(['State', 'Config']); // CommonJS exports (stack-trace friendly)
 *   app.slice('const IdealComp = {', '// ── TAB SWITCHING'); // a chunk from past the split
 *   app.css;                                            // the local stylesheets (app.css), concatenated
 *
 * app.fromHtml(htmlText, readSource) builds the same API from any page text;
 * readSource(path) returns the text of a local script/stylesheet (loader-tests.js
 * passes it fake files; the default reads from the repo root).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const UI_MARKER = '// ── UI RENDERING';

/** Default source reader: a page path like "js/rules.js" resolves under the repo root. */
function readFromRoot(srcPath) {
  return fs.readFileSync(path.join(ROOT, srcPath), 'utf8');
}

/** Pulls an attribute value out of a tag's attribute text (double or single quoted), or null. */
function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

/** True for http(s):// and protocol-relative URLs, which are never loaded from disk. */
function isExternal(url) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

function fromHtml(html, readSource = readFromRoot) {
  // The app is the local <script src> files, in page order. An inline script with content
  // (analytics, a polyfill, a leftover chunk of the app, ...) must be a conscious decision,
  // not something a suite skips past.
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const inlineScripts = scriptTags.filter(m => attr(m[1], 'src') === null);
  if (inlineScripts.length) {
    throw new Error(`load-app: expected no inline <script> in index.html (the app lives in js/*.js), found ${inlineScripts.length}`);
  }
  const scripts = scriptTags.map(m => attr(m[1], 'src')).filter(src => !isExternal(src));
  if (!scripts.length) throw new Error('load-app: index.html loads no local <script src> files');

  /** Reads one local asset (script or stylesheet); fails loudly if it is missing or empty. */
  function readAsset(src) {
    const rel = src.split(/[?#]/)[0].replace(/^\//, '');
    let text;
    try {
      text = readSource(rel);
    } catch (err) {
      throw new Error(`load-app: cannot read "${src}" referenced by index.html: ${err.message}`);
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error(`load-app: "${src}" referenced by index.html is empty`);
    return text.endsWith('\n') ? text : text + '\n';
  }

  const script = scripts.map(readAsset).join('');

  // Every local stylesheet, in page order (the cascade order the browser applies).
  const stylesheets = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .filter(m => /\bstylesheet\b/i.test(attr(m[1], 'rel') || '') && attr(m[1], 'href') !== null)
    .map(m => attr(m[1], 'href'))
    .filter(href => !isExternal(href));
  const css = stylesheets.map(readAsset).join('');

  // The marker must appear exactly once, otherwise "everything above it" is ambiguous.
  const markerAt = script.indexOf(UI_MARKER);
  if (markerAt < 0) throw new Error(`load-app: marker "${UI_MARKER}" not found in the app scripts`);
  if (script.indexOf(UI_MARKER, markerAt + 1) >= 0) {
    throw new Error(`load-app: marker "${UI_MARKER}" appears more than once in the app scripts`);
  }
  const logic = script.slice(0, markerAt);

  /** Source between two markers of the full script (start inclusive, end exclusive). */
  function slice(startMarker, endMarker) {
    const start = script.indexOf(startMarker);
    if (start < 0) throw new Error(`load-app: slice start marker not found: ${startMarker}`);
    const end = script.indexOf(endMarker, start);
    if (end < 0) throw new Error(`load-app: slice end marker not found after start: ${endMarker}`);
    return script.slice(start, end);
  }

  /**
   * Runs the logic half (plus any extra source chunks from past the split) in a
   * fresh vm context and returns it; the requested bindings are on ctx.api.
   * `globals` adds sandbox globals beyond TextEncoder/TextDecoder/console.
   */
  function sandbox(names, { globals = {}, extraSource = '' } = {}) {
    const ctx = vm.createContext({ TextEncoder, TextDecoder, console, ...globals });
    vm.runInContext(logic + (extraSource ? '\n' + extraSource : '') + `\nglobalThis.api={${names.join(',')}};`, ctx);
    return ctx;
  }

  /** Compiles the FULL script (including UI wiring) to catch syntax errors outside the logic half. */
  function compileFull() {
    return new vm.Script(script);
  }

  /** Loads the logic half as a real CommonJS module exporting `names` (via a temp file, for readable stack traces). */
  function requireLogic(names, tmpName = '_pp_test_logic.tmp.js') {
    const tmpPath = path.join(os.tmpdir(), `${process.pid}${tmpName}`);
    fs.writeFileSync(tmpPath, `${logic}\nmodule.exports = { ${names.join(', ')} };`);
    try {
      return require(tmpPath);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  }

  return { html, script, scripts, css, stylesheets, logic, slice, sandbox, compileFull, requireLogic };
}

module.exports = { ...fromHtml(fs.readFileSync(INDEX_PATH, 'utf8')), INDEX_PATH, ROOT, fromHtml };
