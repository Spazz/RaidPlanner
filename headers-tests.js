/**
 * PartyPlanner Web - Security header tests
 * Run: node headers-tests.js
 *
 * vercel.json must parse and ship the security headers on every route. The CSP
 * is enforcing (no Report-Only twin): style-src carries no 'unsafe-inline', which
 * csp-tests.js backs by failing on any inline style="..." or on*="..." attribute.
 * This suite also checks the hosts the page really loads from are allowed.
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
const CSP = headers['Content-Security-Policy'];

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

check('The CSP is enforced, not Report-Only', () => {
  assert(headers['Content-Security-Policy'], 'enforcing header present');
  assert(!('Content-Security-Policy-Report-Only' in headers), 'no report-only twin: it would hide a regression behind the enforcing policy');
});

check('No directive allows inline code: style-src has no unsafe-inline and nothing allows unsafe-eval', () => {
  const policy = parsePolicy(CSP);
  for (const [name, sources] of Object.entries(policy)) {
    assert(!sources.includes("'unsafe-inline'"), `${name} must not allow 'unsafe-inline'`);
    assert(!sources.includes("'unsafe-eval'"), `${name} must not allow 'unsafe-eval'`);
  }
  assert(!('style-src-attr' in policy) || !policy['style-src-attr'].includes("'unsafe-inline'"));
});

check('The CSP carries the expected directives', () => {
  const policy = parsePolicy(CSP);
  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['style-src'], ["'self'", 'https://fonts.googleapis.com']);
  assert.deepEqual(policy['font-src'], ['https://fonts.gstatic.com']);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:']);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'self'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
});

check('script-src allows no inline script, eval or remote script host', () => {
  const sources = parsePolicy(CSP)['script-src'];
  assert.deepEqual(sources, ["'self'"]);
  const whole = CSP;
  assert(!/unsafe-eval|unsafe-inline|\*/.test(whole), 'no wildcard or unsafe keyword anywhere');
});

check('connect-src allows this site and the Raid-Helper hosts the import fetches from', () => {
  const sources = parsePolicy(CSP)['connect-src'];
  assert(sources.includes("'self'"), 'the /api/share calls');
  assert(sources.includes('https://raid-helper.dev'), 'the events API (normalizeImportSource)');
  assert(sources.includes('https://raid-helper.xyz'));
});

check('Every external host index.html and js/ load a resource from is allowed by the policy', () => {
  const policy = parsePolicy(CSP);
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
