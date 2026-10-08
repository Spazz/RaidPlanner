/**
 * PartyPlanner Web - Security header tests
 * Run: node headers-tests.js
 *
 * vercel.json must parse and ship the security headers on every route. The CSP
 * is Report-Only for now (violations are logged in the browser console, nothing
 * is blocked); this suite fails if it is ever made enforcing by accident, and
 * checks the hosts the page really loads from are allowed so enforcement later
 * does not break the app.
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

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

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
const rule = (config.headers || []).find(entry => entry.source === '/(.*)');
const headers = Object.fromEntries(((rule && rule.headers) || []).map(h => [h.key, h.value]));

// Directive name -> its source list, from a CSP value.
function parsePolicy(value) {
  const policy = {};
  for (const part of String(value || '').split(';').map(p => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    assert(!(name in policy), `duplicate directive ${name}`);
    policy[name] = sources;
  }
  return policy;
}

check('vercel.json parses and still rewrites /<version>/<id> to index.html', () => {
  assert.deepEqual(config.rewrites, [{ source: '/:version(tbc|classic|forever)/:id', destination: '/index.html' }]);
});

check('A catch-all rule applies the security headers to every route', () => {
  assert(rule, 'headers rule for /(.*)');
  assert.equal((config.headers || []).length, 1, 'one rule, so no route is missed or double-set');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

check('The CSP ships as Report-Only and is not enforced yet', () => {
  assert(headers['Content-Security-Policy-Report-Only'], 'report-only header present');
  assert(!('Content-Security-Policy' in headers), 'enforcing header must not be set until the inline-style reports are cleared');
});

check('The CSP carries the expected directives', () => {
  const policy = parsePolicy(headers['Content-Security-Policy-Report-Only']);
  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['style-src'], ["'self'", 'https://fonts.googleapis.com']);
  assert.deepEqual(policy['font-src'], ['https://fonts.gstatic.com']);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:', 'https://wow.zamimg.com']);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'self'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
});

check('script-src allows no inline script, eval or remote script host', () => {
  const sources = parsePolicy(headers['Content-Security-Policy-Report-Only'])['script-src'];
  assert.deepEqual(sources, ["'self'"]);
  const whole = headers['Content-Security-Policy-Report-Only'];
  assert(!/unsafe-eval|unsafe-inline|\*/.test(whole), 'no wildcard or unsafe keyword anywhere');
});

check('connect-src allows this site and the Raid-Helper hosts the import fetches from', () => {
  const sources = parsePolicy(headers['Content-Security-Policy-Report-Only'])['connect-src'];
  assert(sources.includes("'self'"), 'the /api/share calls');
  assert(sources.includes('https://raid-helper.dev'), 'the events API (normalizeImportSource)');
  assert(sources.includes('https://raid-helper.xyz'));
});

check('Every external host index.html and js/ load a resource from is allowed by the policy', () => {
  const policy = parsePolicy(headers['Content-Security-Policy-Report-Only']);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Stylesheets and scripts named in index.html's own tags.
  for (const tag of html.match(/<(?:link|script)\b[^>]*>/g) || []) {
    const url = (tag.match(/\b(?:href|src)="(https?:\/\/[^"]+)"/) || [])[1];
    if (!url) continue;
    const origin = new URL(url).origin;
    const directive = /rel="stylesheet"/.test(tag) ? 'style-src' : /<script/.test(tag) ? 'script-src' : null;
    if (directive) assert(policy[directive].includes(origin), `${directive} must allow ${origin}`);
  }
  // Remote icon images the scripts build (none expected now that the icons are self-hosted).
  const iconHosts = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, 'js'))) {
    const source = fs.readFileSync(path.join(__dirname, 'js', file), 'utf8');
    for (const m of source.matchAll(/(https:\/\/[a-z0-9.-]+)\/images\//g)) iconHosts.add(m[1]);
  }
  assert(!iconHosts.has('https://wow.zamimg.com'), 'icons are self-hosted under /icons/ (icons-tests.js), not loaded from the CDN');
  for (const host of iconHosts) assert(policy['img-src'].includes(host), `img-src must allow ${host}`);
});

check('Header values are single-line strings with no stray whitespace', () => {
  for (const h of rule.headers) {
    assert.equal(typeof h.value, 'string');
    assert.equal(h.value, h.value.trim(), h.key);
    assert(!/[\r\n]/.test(h.value), h.key);
  }
});

console.log(`\nHeader tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
