/**
 * Raidsmith guild UI - back links go to the previous in-app page (Fix batch 1, F3).
 * Run: node guild-backnav-tests.js
 *
 * The trail lives in G.router (visit / rendered / previous / back); the page head (ui.pageHeadHtml) and the phone header
 * (G.shell.slots) read it; a plain click on either link calls history.back() (handler 'back-prev' in app.js).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

const calls = [];
const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
sandbox.window = { history: { back: () => calls.push('back') }, location: { hash: '' } };
const G = sandbox.Guild;
const R = G.router;

const A = '#/g/g1/loot';
const B = '#/g/g1/loot/standings';
const C = '#/g/g1/loot/p/p1';
// A page visit as app.js does it: the address changes, the page draws and gives its h1.
function open(hash, name, opts) { R.visit(hash, opts); R.rendered(hash, name); }
const fixedBack = { href: '#/g/g1/loot', label: 'Loot' };
const head = () => G.ui.pageHeadHtml({ title: 'Standings', back: fixedBack });

check('no previous page (direct link, new tab): both back links keep the fixed parent and its label', () => {
  R.resetTrail();
  open(B, 'Standings');
  assert.equal(R.previous(), null);
  const out = head();
  assert(out.includes('<a class="gs-back-link" href="#/g/g1/loot"><') && out.includes('<span>Loot</span>') && !out.includes('data-action="back-prev"'));
});

check('a previous in-app page: the page head shows its name and points at it; a query-only change is not a page', () => {
  R.resetTrail();
  open(A, 'Loot');
  open(B, 'Standings');
  open(B + '?sort=name', 'Standings'); // same page, another query
  open(B + '?sort=due', 'Standings');
  assert.deepEqual(JSON.parse(JSON.stringify(R.previous())), { hash: A, name: 'Loot' });
  open(C, 'Thoren');
  assert.deepEqual(JSON.parse(JSON.stringify(R.previous())), { hash: B + '?sort=due', name: 'Standings' }, 'the previous page is the last address of that page');
  const out = G.ui.pageHeadHtml({ title: 'Thoren', back: { href: '#/g/g1/loot', label: 'Loot' } });
  assert(out.includes('href="#/g/g1/loot/standings?sort=due"') && out.includes('data-action="back-prev"') && out.includes('aria-label="Back to Standings"') && out.includes('<span>Standings</span>'));
  assert(!out.includes('<span>Loot</span>'));
  assert(!G.ui.pageHeadHtml({ title: 'Home' }).includes('gs-back-link'), 'a page with no back link keeps none');
  assert(/r\.section === 'home' \? 'Home'/.test(require('fs').readFileSync(require('path').join(__dirname, 'js/guild/app.js'), 'utf8')), 'Home is named "Home" in the trail, not by its h1 question');
});

check('a plain click calls history.back() with no new entry; a modified click is left to the browser; back/back does not bounce', () => {
  R.resetTrail();
  open(A, 'Loot');
  open(B, 'Standings');
  open(C, 'Thoren');
  const click = G.handlers.click['back-prev'];
  let prevented = 0;
  calls.length = 0;
  click({}, { button: 0, preventDefault: () => { prevented++; } });
  assert.deepEqual(calls, ['back']);
  assert.equal(prevented, 1, 'the link is not followed (that would add an entry)');
  click({}, { button: 0, ctrlKey: true, preventDefault: () => { prevented++; } });
  click({}, { button: 1, preventDefault: () => { prevented++; } });
  assert.deepEqual([calls.length, prevented], [1, 1], 'ctrl-click and middle-click open the address instead');
  // The browser lands on Standings: the trail pops, so the page before Standings is Loot, not Thoren.
  open(B, 'Standings');
  assert.deepEqual(JSON.parse(JSON.stringify(R.previous())), { hash: A, name: 'Loot' });
  click({}, { button: 0, preventDefault() {} });
  open(A, 'Loot');
  assert.equal(R.previous(), null, 'back at the first page: nothing before it, the fixed parent shows again');
  assert.equal(calls.length, 2);
});

check('the browser Back button pops the trail too; a replaced entry swaps the top instead of adding one', () => {
  R.resetTrail();
  open(A, 'Loot');
  open(B, 'Standings');
  open(C, 'Thoren');
  open(B, 'Standings', { history: true });
  assert.deepEqual(JSON.parse(JSON.stringify(R.previous())), { hash: A, name: 'Loot' });
  open('#/g/g1/loot/fix', 'Needs fixing', { replace: true });
  assert.deepEqual(JSON.parse(JSON.stringify(R.previous())), { hash: A, name: 'Loot' }, 'a redirect replaced Standings; the page before is still Loot');
});

check('a previous page that was never drawn (no name) is not offered', () => {
  R.resetTrail();
  R.visit(A);
  open(B, 'Standings');
  assert.equal(R.previous(), null);
});

check('the phone header back link follows the same trail', () => {
  R.resetTrail();
  const gd = { guild: { id: 'g1', name: 'Guild' }, teams: [], me: { can: {} } };
  const ctx = (route) => ({ page: 'app', route, guildData: gd, guildId: 'g1', me: { user: { id: 'u' } }, guilds: [gd] });
  const lead = (route) => G.shell.slots(ctx(route)).lead || '';
  const route = { name: 'settings', gid: 'g1', tab: 'teams' };
  const fixed = lead(route);
  assert(fixed.includes('aria-label="Back to Settings"') && !fixed.includes('data-action="back-prev"'), fixed.slice(0, 300));
  open('#/g/g1/raids', 'Raids');
  open('#/g/g1/settings/teams', 'Teams');
  const out = lead(route);
  assert(out.includes('aria-label="Back to Raids"') && out.includes('data-action="back-prev"') && out.includes('href="#/g/g1/raids"') && out.includes('&lsaquo; Raids'), out.slice(0, 300));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
