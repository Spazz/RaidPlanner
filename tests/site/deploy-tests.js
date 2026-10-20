/**
 * PartyPlanner Web - deploy manifest tests
 * Run: node tests/site/deploy-tests.js
 *
 * .vercelignore keeps tests and docs off the production site. This checks the list
 * can never exclude a file the running page needs: every script, stylesheet and
 * icon index.html references, the ?dev scenario picker's scenarios.js, the og:image,
 * the icon set, vercel.json and the api functions. It also checks the files meant to
 * stay out really are excluded, so a renamed suite does not slip into the deploy.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../load-app');
const { guildScriptsOf } = require('../guild-scripts');

const ROOT = app.ROOT;
const lines = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// The subset of .gitignore syntax the file uses: leading "/" anchors to the root, a
// trailing "/" is a directory, "*" matches within one path segment. Negation is not
// supported on purpose (a "!" line would need real gitignore semantics, so fail loudly).
function toRegex(pattern) {
  assert(!pattern.startsWith('!'), `unsupported negation in .vercelignore: ${pattern}`);
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const dir = pattern.endsWith('/');
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dir ? '/.*' : '(?:/.*)?'}$`);
}
const matchers = lines.map(toRegex);
const ignored = (file) => matchers.some(re => re.test(file));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

/** Every file the running site needs, as repo-relative paths. */
function runtimeFiles() {
  const files = new Set(['index.html', 'faq.html', 'whats-new.html', 'vercel.json', 'package.json', 'scenarios.js', 'og-image.png']);
  for (const src of [...app.scripts, ...app.stylesheets]) files.add(src.split(/[?#]/)[0].replace(/^\//, ''));
  for (const page of ['faq.html', 'whats-new.html']) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of text.matchAll(/<script src="([^"]+)"/g)) files.add(m[1].replace(/^\//, ''));
    for (const src of guildScriptsOf(text)) files.add(src.replace(/^\//, '')); // what the loader tag injects
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'icons'))) files.add(`icons/${name}`);
  for (const name of fs.readdirSync(path.join(ROOT, 'api'))) files.add(`api/${name}`);
  return [...files].sort();
}

check('the manifest parses and uses only supported syntax', () => {
  assert(lines.length > 0);
  for (const re of matchers) assert(re instanceof RegExp);
});

check('no file the page loads at runtime is excluded', () => {
  const files = runtimeFiles();
  assert(files.length > 80, 'icons and scripts were found');
  const excluded = files.filter(ignored);
  assert.equal(JSON.stringify(excluded), '[]');
});

check('every runtime file named in the page, the dev picker and the head exists', () => {
  for (const file of runtimeFiles()) assert(fs.existsSync(path.join(ROOT, file)), file);
  assert(/script\.src = '\/scenarios\.js'/.test(app.script), '?dev still loads /scenarios.js');
  assert(app.html.includes('https://raidsmith.vercel.app/og-image.png'));
});

check('tests, CI, docs and reference data stay out of the deploy', () => {
  const suites = ['tests/planner', 'tests/guild', 'tests/site']
    .flatMap(dir => fs.readdirSync(path.join(ROOT, dir)).filter(n => /^(?:.+-tests|tests|.+-scenarios)\.js$/.test(n)).map(n => `${dir}/${n}`));
  assert(suites.includes('tests/planner/tests.js') && suites.includes('tests/planner/classic-forever-scenarios.js') && suites.includes('tests/site/deploy-tests.js'));
  for (const suite of suites) assert(ignored(suite), `${suite} should not be deployed`);
  for (const file of ['tests/run-all.js', 'tests/load-app.js', '.github/workflows/test.yml', 'gruul_dps_data.txt', 'README.md', 'CHANGELOG.md', 'tools/generate-rules-data.js', 'tools/rules-report.js']) {
    assert(ignored(file), `${file} should not be deployed`);
  }
});

check('scenarios.js is not mistaken for a *-scenarios.js suite', () => {
  assert(!ignored('scenarios.js'));
  assert(ignored('tests/planner/classic-forever-scenarios.js'));
});

console.log(`\nDeploy tests: ${passed} passed, 0 failed, ${passed} total`);
