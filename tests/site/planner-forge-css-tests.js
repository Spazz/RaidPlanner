/**
 * planner-forge.css is shared with the public `main` branch, where guild.css and the guild app do not exist.
 * It must stand on app.css alone: every custom property it reads is defined in app.css or in its own :root block, it
 * never styles the guild shell, and every page that loads guild.css loads it first.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const planner = read('planner-forge.css');
const app = read('app.css');

check('every var(--x) planner-forge.css reads is defined in app.css or in its own :root block', () => {
  const defined = new Set([...app.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  for (const m of planner.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const missing = [...new Set([...planner.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]))].filter(n => !defined.has(n));
  assert.deepEqual(missing, [], 'undefined custom properties: ' + missing.join(', '));
});

check('planner-forge.css does not style the guild shell, the guild pages or guild-only scopes', () => {
  const css = planner.replace(/\/\*[\s\S]*?\*\//g, '');
  const guildOnly = /\.gs-(scope|app|col|topbar|main|crumbs|rail|sidebar|nav|tab|tabs|drawer|home|settings-page|roster|rpg|rs|at|up|pr|lt)\b|#shell-|#gs-main|#planner-root|\.shell-section/;
  const bad = [...css.matchAll(/([^{}]+)\{/g)].map(m => m[1].trim()).filter(sel => guildOnly.test(sel.replace(/:not\([^()]*\)/g, '')));
  assert.deepEqual(bad, []);
});

check('the header says the file is shared with public main and must not depend on guild.css', () => {
  assert.match(planner.slice(0, 900), /SHARED WITH THE PUBLIC `main` BRANCH/);
  assert.match(planner.slice(0, 900), /self-contained/);
});

check('every page that loads guild.css loads planner-forge.css right before it, after app.css', () => {
  for (const page of ['index.html', 'faq.html', 'whats-new.html']) {
    assert(read(page).includes('<link rel="stylesheet" href="/app.css">\n<link rel="stylesheet" href="/planner-forge.css">\n<link rel="stylesheet" href="/guild.css">'), page);
  }
});

check('.gitignore whitelists planner-forge.css', () => {
  assert(read('.gitignore').split(/\r?\n/).includes('!planner-forge.css'));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nAll planner-forge.css checks passed');
