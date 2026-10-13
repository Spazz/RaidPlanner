/**
 * PartyPlanner Web - brand-is-home tests (4.3.1)
 * Run: node brand-tests.js
 *
 * The era-band brand is the way home; the planner title bar starts with the plan name.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('app.css');
const appJs = read('js/app.js');

check('btn-home and title-home are gone', () => {
  assert.ok(!/btn-home/.test(html + appJs), 'btn-home left in html or app.js');
  assert.ok(!/title-home/.test(html + css), 'title-home left in html or css');
});

check('the brand is an <a href="/" id="brand-home"> with the aria-label', () => {
  const m = html.match(/<a [^>]*class="game-header-brand"[^>]*>/);
  assert.ok(m, 'no <a class="game-header-brand">');
  assert.match(m[0], /href="\/"/);
  assert.match(m[0], /id="brand-home"/);
  assert.match(m[0], /aria-label="Party Planner home: load a different plan"/);
});

check('the title bar holds an h1.sr-only', () => {
  const bar = html.slice(html.indexOf('<div class="title-bar">'));
  assert.match(bar.slice(0, 200), /^<div class="title-bar">\s*<h1 class="sr-only">Party Planner<\/h1>/);
});

check('brand has pointer, gold hover and focus-visible outline', () => {
  assert.match(css, /\.game-header-brand\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.game-header-brand:hover strong\s*\{[^}]*var\(--accent-gold-bright\)/);
  assert.match(css, /\.game-header-brand:focus-visible\s*\{[^}]*var\(--accent-gold\)/);
});

// Run the real handler with fake events.
function runHandler(event) {
  const start = appJs.indexOf("document.getElementById('brand-home').addEventListener('click', ");
  assert.ok(start >= 0, 'brand-home click handler missing');
  const end = appJs.indexOf('\n  });', start) + '\n  });'.length;
  const calls = [];
  let handler;
  const sandbox = {
    document: { getElementById: id => ({ addEventListener: (t, fn) => { if (id === 'brand-home' && t === 'click') handler = fn; } }) },
    showView: v => calls.push('showView:' + v),
    window: { scrollTo: () => calls.push('scrollTo') },
  };
  vm.runInNewContext(appJs.slice(start, end), sandbox);
  assert.ok(handler, 'handler not registered');
  const e = Object.assign({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, event, { preventDefault: () => calls.push('preventDefault') });
  handler(e);
  return calls;
}
check('a plain click prevents default, shows the landing and scrolls to the top', () => {
  assert.deepEqual(runHandler({}), ['preventDefault', 'showView:landing', 'scrollTo']);
});
check('ctrl, meta, shift, alt and middle clicks keep the browser default', () => {
  for (const ev of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.deepEqual(runHandler(ev), [], JSON.stringify(ev));
  }
});

check('the phone block gives the brand a 44px x 44px tap area', () => {
  const at = css.indexOf('@media (max-width: 600px)');
  const block = css.slice(css.indexOf('/* Version header: one 40px row', at));
  const m = block.match(/\.game-header-brand::before\s*\{([^}]*)\}/);
  assert.ok(m, 'no .game-header-brand::before in the phone block');
  assert.match(m[1], /width:\s*44px/);
  assert.match(m[1], /height:\s*44px/);
  assert.match(m[1], /position:\s*absolute/);
});

check('the plan name is larger and gold, with the underline-only hover', () => {
  const rule = css.match(/\.roster-name\s*\{([^}]*)\}/)[1];
  assert.match(rule, /font-size:\s*15px/);
  assert.match(rule, /font-weight:\s*700/);
  assert.match(rule, /color:\s*var\(--btn-primary-bg\)/, 'the plan name uses the Optimize button gold');
  assert.match(rule, /letter-spacing:\s*0\.08em/);
  assert.match(css, /\.roster-name:hover\s*\{[^}]*var\(--btn-primary-bg\)[^}]*underline/);
  assert.match(css, /\.roster-name svg\s*\{[^}]*opacity:\s*0\.7/);
  assert.match(css, /#phone-plan-name-slot \.roster-name\s*\{[^}]*font-size:\s*15px/);
  assert.match(css, /#roster-name-text\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/);
});

check('the Coverage summary rows keep a gap between label and count (narrow rail rows)', () => {
  assert.match(css, /\.sidebar-summary-row\s*\{[^}]*gap:\s*6px/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
