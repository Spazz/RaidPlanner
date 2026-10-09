/**
 * PartyPlanner Web - CSP readiness tests
 * Run: node csp-tests.js
 *
 * The policy (vercel.json) forbids inline style attributes (no 'unsafe-inline' in style-src)
 * and inline scripts, so the markup and every HTML template string must stay free of them:
 *   - no style="..." and no on*="..." attribute in index.html or in js/*.js
 *   - class colours reach the DOM as classes (cc-<class> / pref-<class>), and app.css defines every one
 *   - imports only fetch the Raid-Helper hosts the CSP's connect-src allows
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0, failed = 0;
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

const ROOT = __dirname;
const sources = [['index.html', fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')]]
  .concat(fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
    .map(f => ['js/' + f, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')]));

// An HTML attribute assignment as it appears in markup or a template string: ` style="`, ` style='`,
// ` style=\"`, ` style=${...}` (and the same for any on<event>= handler). Plain JS such as
// `el.style.color = x` or `el.onclick = fn` never has a quote or ${ right after the equals sign.
const INLINE_STYLE = /[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/;
const INLINE_HANDLER = /[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i;
const SET_ATTRIBUTE = /setAttribute\(\s*['"`](?:style|on[a-z]+)['"`]/i;

function offenders(re) {
  const found = [];
  for (const [file, text] of sources) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  return found;
}

check('No inline style="..." attribute in index.html or any HTML template string', () => {
  assert.deepEqual(offenders(INLINE_STYLE), []);
});

check('No inline on*="..." event-handler attribute in index.html or any HTML template string', () => {
  assert.deepEqual(offenders(INLINE_HANDLER), []);
});

check('No setAttribute("style" / "on...") call (CSSOM el.style.x = ... is the allowed route)', () => {
  assert.deepEqual(offenders(SET_ATTRIBUTE), []);
});

check('The scan itself catches the forms it exists for', () => {
  for (const bad of ['<p style="color:red">', "<p style='x'>", '`<p style=${s}>`', '"<p style=\\"x\\">"']) {
    assert(INLINE_STYLE.test(bad), bad);
  }
  for (const bad of ['<button onclick="go()">', "<a onmouseover='x'>"]) assert(INLINE_HANDLER.test(bad), bad);
  for (const ok of ['el.style.color = c;', "ghost.style.setProperty('--x', v)", 'btn.onclick = () => go();', 'const style = 1;']) {
    assert(!INLINE_STYLE.test(ok) && !INLINE_HANDLER.test(ok), ok);
  }
});

// ── Class colours as classes ──────────────────────────────────────
const colorCtx = app.sandbox(['Config', 'classColorClass', 'preferredColorClass'],
  { extraSource: app.slice('function isKnownClass(', '// ONE capture-phase listener') });
const { Config, classColorClass, preferredColorClass } = colorCtx.api;

check('classColorClass / preferredColorClass map every class to a class app.css defines', () => {
  for (const cls of Object.keys(Config.ClassColors)) {
    const cc = classColorClass(cls);
    assert.equal(cc, 'cc-' + cls.toLowerCase());
    assert(new RegExp(`\\.${cc}\\s*\\{[^}]*color:\\s*var\\(--class-${cls.toLowerCase()}\\)`).test(app.css), `${cc} rule`);
    const pref = preferredColorClass(cls);
    assert.equal(pref, ' pref-' + cls.toLowerCase());
    assert(new RegExp(`\\.${pref.trim()}\\s*\\{\\s*--preferred-color:\\s*var\\(--class-${cls.toLowerCase()}\\)`).test(app.css), `${pref} rule`);
  }
});

check('--class-* tokens in app.css match Config.ClassColors', () => {
  for (const [cls, hex] of Object.entries(Config.ClassColors)) {
    const m = app.css.match(new RegExp(`--class-${cls.toLowerCase()}:\\s*(#[0-9a-fA-F]{6})`));
    assert(m, `--class-${cls.toLowerCase()} token`);
    assert.equal(m[1].toLowerCase(), hex.toLowerCase(), cls);
  }
});

check('An unknown class falls back to a neutral colour class that exists, never a made-up class name', () => {
  for (const cls of [undefined, null, '', 'DEATHKNIGHT', 'constructor', '__proto__', '"><img>']) {
    assert.equal(preferredColorClass(cls), '', String(cls));
    for (const fallback of [undefined, 'primary', 'secondary', 'muted']) {
      const cc = classColorClass(cls, fallback);
      assert.equal(cc, 'cc-unknown-' + (fallback || 'primary'), `${cls}/${fallback}`);
      assert(new RegExp(`\\.${cc}\\s*\\{[^}]*color:\\s*var\\(--text-(?:primary|secondary|muted)\\)`).test(app.css), `${cc} rule`);
    }
  }
});

check('Every var(--x) used in app.css is defined in app.css (or carries a fallback)', () => {
  const defined = new Set([...app.css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const missing = [...app.css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)]
    .filter(m => m[2] === ')' && !defined.has(m[1])).map(m => m[1]);
  assert.deepEqual([...new Set(missing)], [], 'undefined CSS custom properties');
});

// ── Imports only fetch Raid-Helper ────────────────────────────────
const importCtx = app.sandbox(['normalizeImportSource'], { extraSource: app.slice('function normalizeImportSource(', '// Numbers every import') });
const normalize = importCtx.api.normalizeImportSource;
const API = id => `https://raid-helper.dev/api/v4/events/${id}`;

check('Event IDs and Raid-Helper event/raidplan links resolve to the events API', () => {
  assert.deepEqual({ ...normalize('1234567890') }, { url: API('1234567890'), eventId: '1234567890' });
  assert.deepEqual({ ...normalize('https://raid-helper.dev/event/1234567890') }, { url: API('1234567890'), eventId: '1234567890' });
  assert.deepEqual({ ...normalize('https://raid-helper.xyz/event/1234567890?x=1') }, { url: API('1234567890'), eventId: '1234567890' });
  assert.deepEqual({ ...normalize('  HTTPS://Raid-Helper.DEV/raidplan/1234567890  ') }, { url: API('1234567890'), eventId: '1234567890' });
});

check('Page links on a raid-helper subdomain (www.) and with trailing text still resolve to the events API', () => {
  for (const url of ['https://www.raid-helper.dev/event/1234567890', 'https://www.raid-helper.xyz/raidplan/1234567890', 'https://raid-helper.dev/event/1234567890 tonight', 'https://raid-helper.dev/event/1234567890\nsee you there']) {
    assert.deepEqual({ ...normalize(url) }, { url: API('1234567890'), eventId: '1234567890' }, url);
  }
});

check('An explicit Raid-Helper API link is fetched as pasted (upgraded to https)', () => {
  assert.deepEqual({ ...normalize(API('55555555') + '?includeAllUsers=true') }, { url: API('55555555') + '?includeAllUsers=true', eventId: '55555555' });
  assert.deepEqual({ ...normalize('http://raid-helper.xyz/api/raidplan/99') }, { url: 'https://raid-helper.xyz/api/raidplan/99', eventId: null });
});

check('Any other host is refused with a message that points at the event link / ID / JSON', () => {
  for (const url of ['https://example.com/roster.json', 'https://evil.example/?u=raid-helper.dev/api/v4/events/1', 'https://raid-helper.dev.evil.example/api/v4/events/1',
    'https://raid-helper.com/api/v4/events/1', 'https://raid-helper.dev@evil.example/api/x', 'https://raid-helper.dev:8443/api/x', 'https://www.raid-helper.dev/api/v4/events/1', 'https://www.raid-helper.dev.evil.example/event/123456', 'https://xraid-helper.dev/event/123456',
    'http://127.0.0.1/api/share', 'https://raid-helper.devx/event/123456', 'https://']) {
    const r = normalize(url);
    assert.equal(r.url, undefined, `${url} must not be fetched`);
    assert.match(r.error, /Raid-Helper/, url);
    assert.match(r.error, /event link or ID/, url);
    assert.match(r.error, /JSON/, url);
  }
});

check('A Raid-Helper link that is not an event or API link is refused too', () => {
  for (const url of ['https://raid-helper.dev/', 'https://raid-helper.dev/about', 'https://raid-helper.xyz/event/abc']) {
    const r = normalize(url);
    assert.equal(r.url, undefined, url);
    assert(r.error, url);
  }
});

check('Pasted JSON, text and addon strings are untouched', () => {
  for (const text of ['{"signUps":[]}', 'PP:2:abc', 'Name Mage Fire\nOther Priest Holy', 'see raid-helper.dev/event/123456 for details']) {
    assert.deepEqual({ ...normalize(text) }, { text });
  }
  assert.deepEqual({ ...normalize('') }, { text: '' });
  assert.deepEqual({ ...normalize(null) }, { text: '' });
});

console.log(`\nCSP readiness tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
