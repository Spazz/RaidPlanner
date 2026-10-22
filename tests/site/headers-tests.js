/**
 * PartyPlanner Web - Security header tests
 * Run: node tests/site/headers-tests.js
 *
 * _headers (the Worker's static-asset headers) is the ONLY place a CSP is set (vercel.json is gone) and ships the security headers on every route. The CSP
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

const ROOT = path.join(__dirname, '..', '..');
// _headers: "/*" then indented "Name: value" lines (comments start with #).
const headerLines = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
const rule = headerLines[0].trim() === '/*' ? { headers: headerLines.slice(1).map(line => ({ key: line.slice(0, line.indexOf(':')).trim(), value: line.slice(line.indexOf(':') + 1).trim() })) } : null;
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

check('There is exactly one CSP source: _headers (no vercel.json, no api/, no CSP meta tag, no CSP set by the Worker pages)', () => {
  assert(!fs.existsSync(path.join(ROOT, 'vercel.json')), 'vercel.json is retired');
  assert(!fs.existsSync(path.join(ROOT, '.vercelignore')) && !fs.existsSync(path.join(ROOT, 'api')));
  assert.equal(headerLines.filter(line => /^\s*Content-Security-Policy\s*:/i.test(line)).length, 1, 'one CSP line in _headers');
  assert.equal(headerLines.filter(line => line.trim() === '/*').length, 1, 'one catch-all rule');
  for (const page of ['index.html', 'faq.html', 'whats-new.html']) {
    assert(!/http-equiv=["']Content-Security-Policy/i.test(fs.readFileSync(path.join(ROOT, page), 'utf8')), `${page} has no CSP meta tag`);
  }
});

check('The catch-all rule applies the security headers to every route', () => {
  assert(rule, 'headers rule for /*');
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
  assert.deepEqual(policy['script-src'], ["'self'", 'https://wow.zamimg.com']);
  assert.deepEqual(policy['style-src'], ["'self'", 'https://fonts.googleapis.com', 'https://wow.zamimg.com']);
  assert.deepEqual(policy['font-src'], ['https://fonts.gstatic.com']);
  assert.deepEqual(policy['style-src-attr'], ["'unsafe-hashes'", "'sha256-P8KEFiQjXYUW3n8OFx902OxKLCCDvr9cCfMQRT5lRXQ='"], 'one inline style value of the Wowhead tooltip markup, by hash');
  assert.deepEqual(policy['img-src'], ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://wow.zamimg.com'], 'the Discord CDN is for the guild app avatars');
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'self'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
});

check('script-src allows no inline script, eval or remote script host except the Wowhead tooltip script host (guild item pages)', () => {
  const sources = parsePolicy(CSP)['script-src'];
  assert.deepEqual(sources, ["'self'", 'https://wow.zamimg.com']);
  const whole = CSP;
  assert(!/unsafe-eval|unsafe-inline|\*/.test(whole), 'no wildcard or unsafe keyword anywhere');
});

check('connect-src allows this site, the Raid-Helper hosts the import fetches from and the Wowhead tooltip data', () => {
  const sources = parsePolicy(CSP)['connect-src'];
  assert(sources.includes("'self'"), 'the /api/share calls');
  assert(sources.includes('https://raid-helper.dev'), 'the events API (normalizeImportSource)');
  assert(sources.includes('https://raid-helper.xyz'));
  assert.deepEqual(sources, ["'self'", 'https://raid-helper.dev', 'https://raid-helper.xyz', 'https://nether.wowhead.com'], 'plus the Wowhead tooltip data host, nothing else');
});

check('Every external host index.html and js/ load a resource from is allowed by the policy', () => {
  const policy = parsePolicy(CSP);
  const html = ['index.html', 'faq.html', 'whats-new.html'].map(f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')).join('\n');
  // Stylesheets and scripts named in the pages' own tags.
  for (const tag of html.match(/<(?:link|script)\b[^>]*>/g) || []) {
    const url = (tag.match(/\b(?:href|src)="(https?:\/\/[^"]+)"/) || [])[1];
    if (!url) continue;
    const origin = new URL(url).origin;
    const directive = /rel="stylesheet"/.test(tag) ? 'style-src' : /<script/.test(tag) ? 'script-src' : null;
    if (directive) assert(policy[directive].includes(origin), `${directive} must allow ${origin}`);
  }
  // Remote icon images the scripts build (none expected now that the icons are self-hosted).
  const iconHosts = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, '..', '..', 'js'), { recursive: true }).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'js', file), 'utf8');
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
