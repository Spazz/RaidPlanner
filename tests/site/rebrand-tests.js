/**
 * Raidsmith - rebrand tests (4.4.1)
 * Run: node tests/site/rebrand-tests.js
 *
 * The app used to be called Party Planner. These checks pin what the rename must keep working
 * (old backup files, old PP share codes, the version pair) and what it adds (the Optimize ember
 * glow, a reduced-motion rule), and guard against the old name creeping back into visible text.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = require('../load-app');

const ctx = app.sandbox(['APP_VERSION', 'CHANGELOG', 'DataBackup', 'Import', 'State']);
const { APP_VERSION, CHANGELOG, DataBackup, Import } = ctx.api;
const read = rel => fs.readFileSync(path.join(app.ROOT, rel), 'utf8');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS  ' + name); }

check('APP_VERSION, package.json and the newest changelog entry agree, and the 4.4.1 rebrand entry exists', () => {
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
  assert.equal(CHANGELOG[0].version, APP_VERSION);
  assert.equal(CHANGELOG.find(e => e.version === '4.4.1').title, 'Party Planner is now Raidsmith');
  assert.equal(JSON.parse(read('package.json')).name, 'raidsmith-web');
});

check('backups: export writes the raidsmith schema; old and new files both validate; others do not', () => {
  const built = DataBackup.build({ length: 1, key: () => 'pp_sidebar_expanded', getItem: () => '1' });
  assert.equal(built.schema, 'raidsmith-backup');
  for (const schema of ['raidsmith-backup', 'party-planner-backup']) {
    const r = DataBackup.validate({ schema, version: 1, data: { pp_sidebar_expanded: '1' } });
    assert.equal(r.valid, true, schema + ': ' + JSON.stringify(r.errors));
  }
  const other = DataBackup.validate({ schema: 'something-else', version: 1, data: { pp_sidebar_expanded: '1' } });
  assert.equal(other.valid, false);
  assert.match(other.errors[0], /Raidsmith backup/);
  assert.match(DataBackup.validate([]).errors[0], /Raidsmith backup/);
});

check('an existing PP:2 share code still imports, and a non-PP string says Raidsmith', () => {
  const code = 'PP:2:bt:Legacy%20Raid::Tanky.WR.Prot.T,Healy.PR.Holy.H::::';
  const preview = Import.previewShareString(code);
  assert.deepEqual({ ok: preview.success, name: preview.name, n: preview.playerCount }, { ok: true, name: 'Legacy Raid', n: 2 });
  const r = Import.importAddonString(code);
  assert.equal(r.success, true);
  assert.equal(r.playerCount, 2);
  assert.equal(Import.previewShareString('XX:2:bt').error, 'Not a Raidsmith share link');
  assert.equal(Import.importAddonString('XX:2:bt').error, 'Not a Raidsmith export string');
});

// ── The Optimize ember glow ──────────────────────────────────────────
const script = app.script.replace(/\r\n/g, '\n');
const css = app.css.replace(/\r\n/g, '\n');
const html = app.html.replace(/\r\n/g, '\n');
const HANDLER_START = "document.getElementById('btn-optimize').addEventListener('click'";

check('fireEmber restarts the animation: class removed, reflow forced, class added, removed again after ~1.3s', () => {
  const src = script.slice(script.indexOf('let emberTimer'), script.indexOf(HANDLER_START));
  const log = [];
  const timers = [];
  const btn = { classList: { remove: c => log.push('remove:' + c), add: c => log.push('add:' + c) } };
  Object.defineProperty(btn, 'offsetWidth', { get() { log.push('reflow'); return 1; } });
  const box = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, out: null };
  vm.runInNewContext(src + '\nout = fireEmber;', box);
  box.out(btn);
  assert.deepEqual(log, ['remove:firing', 'reflow', 'add:firing']);
  assert.equal(timers[0].ms, 1300);
  timers[0].fn();
  assert.equal(log[log.length - 1], 'remove:firing');
  box.out(null); // a missing or mock button never throws
  box.out({});
});

check('only the Optimize click handler fires the ember, and only when something was rebuilt', () => {
  const calls = script.match(/fireEmber\(/g) || [];
  assert.equal(calls.length, 2, 'the definition and one call');
  const handler = script.slice(script.indexOf(HANDLER_START), script.indexOf("document.getElementById('btn-clear').addEventListener"));
  assert.match(handler, /if \(pushed && \(entry \|\| overridesReset > 0\)\) fireEmber\(document\.getElementById\('btn-optimize'\)\);/);
  const early = handler.slice(0, handler.indexOf('Optimizer.optimize()'));
  assert(!early.includes('fireEmber'), 'no glow on the not-modeled / empty-roster early returns');
});

check('five sparks live inside #btn-optimize and nowhere else; no inline styles carry them', () => {
  assert.equal((html.match(/class="spark"/g) || []).length, 5);
  const btn = html.match(/<button[^>]*id="btn-optimize"[\s\S]*?<\/button>/)[0];
  assert.equal((btn.match(/class="spark"/g) || []).length, 5);
  assert(!/style=/.test(btn), 'the CSP allows no inline style attributes');
  assert.match(css, /#btn-optimize\.firing\s*\{[^}]*animation:\s*ember 1\.1s ease-out/);
  assert.match(css, /@keyframes ember/);
  assert.match(css, /@keyframes spark/);
  for (let i = 2; i <= 6; i++) assert(css.includes(`#btn-optimize .spark:nth-child(${i}) { --dx:`), 'spark ' + i);
  assert(!/\.firing/.test(css.replace(/#btn-optimize\.firing/g, '')), '.firing only ever applies to #btn-optimize');
});

check('prefers-reduced-motion drops the spark animation and keeps a static glow', () => {
  const at = css.indexOf('@media (prefers-reduced-motion: reduce) {\n  #btn-optimize');
  assert(at >= 0, 'a reduced-motion block for the ember exists');
  const body = css.slice(at, css.indexOf('\n}\n', at) + 3);
  assert.match(body, /#btn-optimize\.firing\s*\{\s*animation:\s*none;\s*box-shadow:/);
  assert.match(body, /#btn-optimize\.firing \.spark\s*\{\s*animation:\s*none/);
});

check('molten is for primary buttons; text that reads --btn-primary-bg stays gold', () => {
  assert.match(css, /--molten:\s*#ec7f1f/);
  assert.match(css, /--molten-hover:\s*#f7993f/);
  assert.match(css, /--text-on-molten:\s*#1d1206/);
  assert.match(css, /\.btn-primary \{\s*background: linear-gradient\(180deg, var\(--molten-hover\), var\(--molten\)\)/);
  assert.match(css, /--btn-primary-bg: var\(--accent-gold\)/);
  // dark text on #ec7f1f must clear WCAG AA for normal text (4.5:1)
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (lum('#ec7f1f') + 0.05) / (lum('#1d1206') + 0.05);
  assert(ratio >= 4.5, 'contrast ' + ratio.toFixed(2));
});

check('the hero wordmark is the anvil svg (the shell draws the other brand marks) and the favicon is a gold anvil data URI', () => {
  assert.equal((html.match(/<svg class="mark-svg"/g) || []).length, 1);
  assert(!/game-header-mark"[^>]*>P</.test(html));
  const icon = html.match(/<link rel="icon" href="([^"]*)">/)[1];
  assert(icon.startsWith('data:image/svg+xml,') && icon.includes('%23e0b53d') && !icon.includes('&#9733;'));
});

// ── The old name stays out of visible text ───────────────────────────
check('no visible text or source outside history and compat strings still says "Party Planner"', () => {
  const OLD = /party[\s-]?planner/i;
  // The folder is still called PartyPlannerWeb, so paths that name it are fine.
  const allowed = line => /formerly/i.test(line) || line.includes("'party-planner-backup'");
  // Tracked files only: CI runs on a clean checkout.
  const files = ['index.html', 'package.json', 'README.md', 'app.css', 'worker/share.js',
    ...fs.readdirSync(path.join(app.ROOT, 'js')).filter(f => f.endsWith('.js') && f !== 'changelog.js').map(f => 'js/' + f),
    ...fs.readdirSync(path.join(app.ROOT, 'js', 'rules')).map(f => 'js/rules/' + f)];
  const offenders = [];
  for (const rel of files) {
    read(rel).split(/\r?\n/).forEach((line, i) => { if (OLD.test(line.replace(/PartyPlannerWeb/g, '')) && !allowed(line)) offenders.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
  // changelog history may name the old app; the newest entry only as "Party Planner is now Raidsmith" in its title
  for (const line of CHANGELOG[0].changes) assert(!OLD.test(line), line);
});

check('og-image.png is 1200x630', () => {
  const buf = fs.readFileSync(path.join(app.ROOT, 'og-image.png'));
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
});

console.log(`\n${passed} rebrand checks passed`);
