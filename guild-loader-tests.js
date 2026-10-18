/**
 * Raidsmith guild shell - script loader tests
 * Run: node guild-loader-tests.js
 *
 * index.html, faq.html and whats-new.html load the guild shell through ONE tag, js/guild/load.js, which injects the
 * scripts js/guild/manifest.js lists (the one list; tests/guild-scripts.js reads the same file). These checks pin:
 *   - the manifest: root-absolute guild paths, files that exist, no duplicates, ui.js before app.js, app.js last
 *   - the loader on a fake document: manifest first, then every listed script in order, each with async = false (so the
 *     browser keeps the order), a failed file reported without stopping the rest, a missing manifest reported
 *   - the three pages: the loader is their last script tag and no page repeats a guild script
 *   - the CSP the loader depends on: script-src 'self' plus Wowhead's tooltip host (same-origin src, nothing inline) in _headers and vercel.json,
 *     and no CSP meta tag on the pages that could say otherwise
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GUILD_MANIFEST, GUILD_LOADER, guildScriptsOf } = require('./tests/guild-scripts');

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PAGES = ['index.html', 'faq.html', 'whats-new.html'];
const MANIFEST_SRC = '/js/guild/manifest.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/** Runs js/guild/load.js on a fake document. Returns the script elements it appended, in order, and the console errors. */
function runLoader({ windowObject = {} } = {}) {
  const appended = [];
  const errors = [];
  const document = {
    head: { appendChild(el) { appended.push(el); } },
    createElement(tag) {
      assert.equal(tag, 'script');
      return { async: true, src: '', onload: null, onerror: null };
    },
  };
  const window = windowObject;
  const sandbox = { document, window, console: { error: (message) => errors.push(String(message)) } };
  vm.runInNewContext(read('js/guild/load.js'), sandbox, { filename: 'js/guild/load.js' });
  return { appended, errors, window, fire: (el, type) => el['on' + type]() };
}

// ── The manifest ─────────────────────────────────────────────────
check('manifest: root-absolute /js/guild/ paths of files that exist, no duplicates, ui.js before app.js, app.js last', () => {
  assert(GUILD_MANIFEST.length > 20, 'a real list');
  for (const src of GUILD_MANIFEST) {
    assert.match(src, /^\/js\/guild\/[a-z0-9-]+\.js$/, src);
    assert(fs.statSync(path.join(ROOT, src.slice(1))).size > 0, src + ' exists');
  }
  assert.equal(new Set(GUILD_MANIFEST).size, GUILD_MANIFEST.length, 'a script is listed twice');
  assert.equal(GUILD_MANIFEST[GUILD_MANIFEST.length - 1], '/js/guild/app.js', 'app.js starts the shell, so it loads last');
  assert(GUILD_MANIFEST.indexOf('/js/guild/ui.js') < GUILD_MANIFEST.indexOf('/js/guild/app.js'));
  assert(!GUILD_MANIFEST.includes(GUILD_LOADER) && !GUILD_MANIFEST.includes(MANIFEST_SRC), 'the loader pair is not in the list it loads');
});

check('manifest.js in a browser (no module): sets window.Guild.manifest to the same list, keeping a Guild namespace that exists', () => {
  const window = { Guild: { api: 'kept' } };
  vm.runInNewContext(read('js/guild/manifest.js'), { window }, { filename: 'js/guild/manifest.js' });
  assert.deepEqual([...window.Guild.manifest], GUILD_MANIFEST);
  assert.equal(window.Guild.api, 'kept');
});

// ── The loader on a fake document ────────────────────────────────
check('loader: appends the manifest first (async = false) and nothing else until it has run', () => {
  const run = runLoader();
  assert.equal(run.appended.length, 1);
  assert.equal(run.appended[0].src, MANIFEST_SRC);
  assert.equal(run.appended[0].async, false);
});

check('loader: once the manifest ran it appends every listed script, in the manifest order, each with async = false', () => {
  const run = runLoader();
  run.window.Guild = { manifest: GUILD_MANIFEST.slice() }; // what manifest.js does when it runs
  run.fire(run.appended[0], 'load');
  assert.deepEqual(run.appended.slice(1).map((el) => el.src), GUILD_MANIFEST);
  assert(run.appended.every((el) => el.async === false), 'async = false keeps the execution order of injected scripts');
  assert.deepEqual(run.errors, []);
});

check('loader: a script that fails to load is reported by name and does not stop the rest', () => {
  const run = runLoader();
  run.window.Guild = { manifest: ['/js/guild/a.js', '/js/guild/b.js'] };
  run.fire(run.appended[0], 'load');
  run.fire(run.appended[1], 'error');
  assert.deepEqual(run.appended.slice(1).map((el) => el.src), ['/js/guild/a.js', '/js/guild/b.js']);
  assert.deepEqual(run.errors, ['Guild script failed to load: /js/guild/a.js']);
});

check('loader: a missing or broken manifest is reported and loads nothing more', () => {
  const failedFetch = runLoader();
  failedFetch.fire(failedFetch.appended[0], 'error');
  assert.equal(failedFetch.appended.length, 1);
  assert.deepEqual(failedFetch.errors, ['Guild script failed to load: ' + MANIFEST_SRC]);
  const empty = runLoader();
  empty.window.Guild = { manifest: [] };
  empty.fire(empty.appended[0], 'load');
  assert.equal(empty.appended.length, 1);
  assert.equal(empty.errors.length, 1);
  const wrong = runLoader();
  wrong.window.Guild = {};
  wrong.fire(wrong.appended[0], 'load');
  assert.equal(wrong.appended.length, 1);
  assert.equal(wrong.errors.length, 1);
});

check('loader: without a document it does nothing (Node, workers)', () => {
  assert.doesNotThrow(() => vm.runInNewContext(read('js/guild/load.js'), { console }));
});

// ── The pages ────────────────────────────────────────────────────
check('pages: the guild loader is each page\'s last script tag, it appears once, and no page repeats a guild script', () => {
  for (const page of PAGES) {
    const html = read(page);
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(tags[tags.length - 1], `<script src="${GUILD_LOADER}">`, page + ' ends with the loader tag');
    assert.equal(tags.filter((tag) => tag.includes(GUILD_LOADER)).length, 1, page + ' carries the loader once');
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="(\/js\/guild\/[^"]+)"/g)].map((m) => m[1]), [GUILD_LOADER], page);
    assert.deepEqual(guildScriptsOf(html), GUILD_MANIFEST, page + ' loads exactly the manifest');
    assert(!tags.some((tag) => /\b(?:async|defer|type)\b/.test(tag)), page + ': plain classic script tags');
  }
});

// ── The CSP the loader depends on ────────────────────────────────
check('CSP: script-src is \'self\' plus the Wowhead tooltip host in _headers and vercel.json (same-origin src is allowed, no inline code needed), and the pages have no CSP meta tag', () => {
  const headers = read('_headers').split('\n').find((line) => line.trim().startsWith('Content-Security-Policy:'));
  const vercel = JSON.parse(read('vercel.json')).headers[0].headers.find((header) => header.key === 'Content-Security-Policy').value;
  for (const policy of [headers.slice(headers.indexOf(':') + 1), vercel]) {
    const directive = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
    assert.equal(directive, "script-src 'self' https://wow.zamimg.com");
  }
  for (const page of PAGES) assert(!/http-equiv\s*=\s*["']?content-security-policy/i.test(read(page)), page + ' has a CSP meta tag');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
