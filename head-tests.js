/**
 * PartyPlanner Web - page head and stylesheet polish tests
 * Run: node head-tests.js
 *
 * The <head> that link previews and browsers read (version-neutral title and
 * description, Open Graph / Twitter card with a real 1200x630 PNG), the font
 * preconnects, and the two accessibility blocks in app.css: a global
 * prefers-reduced-motion rule and a larger buff-icon hit area on touch screens.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('./tests/load-app');

const SITE = 'https://raid-planner-theta.vercel.app';
const head = app.html.slice(app.html.indexOf('<head>'), app.html.indexOf('</head>'));
const metaContent = (attrName, attrValue) => {
  const m = head.match(new RegExp('<meta\\s+' + attrName + '="' + attrValue + '"\\s+content="([^"]*)"'));
  return m ? m[1] : null;
};

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('title and description name no single game version', () => {
  const title = head.match(/<title>([^<]*)<\/title>/)[1];
  const description = metaContent('name', 'description');
  assert(description, 'description present');
  for (const text of [title, description, metaContent('property', 'og:title'), metaContent('property', 'og:description')]) {
    assert(!/^TBC\b|\bTBC (raid|group)|Multi-version/i.test(text), `version-specific copy: ${text}`);
    assert(/Classic/.test(description) && /TBC/.test(description) && /Forever/.test(description), 'description names every supported version');
  }
});

check('Open Graph and Twitter card tags are complete and absolute', () => {
  for (const p of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
    assert(metaContent('property', p), p);
  }
  assert.equal(metaContent('property', 'og:image'), `${SITE}/og-image.png`);
  assert.equal(metaContent('name', 'twitter:card'), 'summary_large_image');
  assert.equal(metaContent('name', 'twitter:image'), `${SITE}/og-image.png`);
  assert(metaContent('name', 'twitter:title') && metaContent('name', 'twitter:description'));
  assert.equal(metaContent('property', 'og:image:width'), '1200');
  assert.equal(metaContent('property', 'og:image:height'), '630');
});

check('og-image.png is a 1200x630 PNG', () => {
  const png = fs.readFileSync(path.join(app.ROOT, 'og-image.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert(png.length < 300 * 1024, 'small enough for a link preview');
});

check('both font hosts are preconnected (gstatic with crossorigin)', () => {
  assert(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/.test(head));
  assert(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/.test(head));
  assert(head.indexOf('rel="preconnect"') < head.indexOf('fonts.googleapis.com/css2'), 'preconnect comes before the stylesheet');
});

check('app.css has a global prefers-reduced-motion block that ends animations and transitions', () => {
  const m = app.css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/);
  assert(m, 'global block');
  assert(/animation-duration: 0\.01ms !important/.test(m[1]));
  assert(/transition-duration: 0\.01ms !important/.test(m[1]));
  assert(/scroll-behavior: auto !important/.test(m[1]));
});

check('touch screens get a larger buff-icon hit area without overlapping neighbours', () => {
  const block = app.css.match(/@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\n\}/)[0];
  const inset = Number(block.match(/\.buff-icon::before \{[^}]*inset: -(\d+)px/)[1]);
  const gap = Number(block.match(/\.buff-bar \{ gap: (\d+)px/)[1]);
  assert(24 + 2 * inset >= 32, 'target is at least 32px');
  assert(gap >= 2 * inset, 'neighbouring hit areas do not overlap');
});

console.log(`\nHead tests: ${passed} passed, 0 failed, ${passed} total`);
