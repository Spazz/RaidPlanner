/**
 * PartyPlanner Web - shared test loader
 *
 * Every suite tests the logic that lives inline in index.html, so they all
 * need the same three steps: read index.html, cut out the one inline app
 * <script>, and keep only the part above the '// ── UI RENDERING' marker
 * (pure logic, no DOM). This module does that once and fails LOUDLY if the
 * page no longer has the shape the suites rely on - a missing marker would
 * otherwise turn into indexOf() === -1 and silently slice the wrong code.
 *
 *   const app = require('./tests/load-app');
 *   const ctx = app.sandbox(['State', 'Config']);      // vm context, exports on ctx.api
 *   const PP  = app.requireLogic(['State', 'Config']); // CommonJS exports (stack-trace friendly)
 *   app.slice('const IdealComp = {', '// ── TAB SWITCHING'); // a chunk from past the split
 *
 * app.fromHtml(htmlText) builds the same API from any page text (used by loader-tests.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const UI_MARKER = '// ── UI RENDERING';

function fromHtml(html) {
  // Exactly one inline <script> (no src=) carries the app. A second one (analytics,
  // a polyfill, ...) must be a conscious decision, not something a suite skips past.
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1]));
  if (inlineScripts.length !== 1) {
    throw new Error(`load-app: expected exactly 1 inline <script> in index.html, found ${inlineScripts.length}`);
  }
  const script = inlineScripts[0][2];
  if (!script.trim()) throw new Error('load-app: the inline <script> in index.html is empty');

  // The marker must appear exactly once, otherwise "everything above it" is ambiguous.
  const markerAt = script.indexOf(UI_MARKER);
  if (markerAt < 0) throw new Error(`load-app: marker "${UI_MARKER}" not found in the inline script`);
  if (script.indexOf(UI_MARKER, markerAt + 1) >= 0) {
    throw new Error(`load-app: marker "${UI_MARKER}" appears more than once in the inline script`);
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

  return { html, script, logic, slice, sandbox, compileFull, requireLogic };
}

module.exports = { ...fromHtml(fs.readFileSync(INDEX_PATH, 'utf8')), INDEX_PATH, fromHtml };
