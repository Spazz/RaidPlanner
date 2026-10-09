/**
 * PartyPlanner Web - rendering and performance tests
 * Run: node perf-tests.js
 *
 * Correctness checks for the performance work, plus a timing section that only WARNS:
 *   - group cards are built in an array and assigned to innerHTML once (no `innerHTML +=`,
 *     which re-parses and rebuilds everything already drawn), and icon load errors are
 *     handled by one capture-phase listener rather than a handler per image
 *   - ?dev wraps Optimize and Compare in performance.mark/measure; production does not
 *   - the drag ghost moves by transform, one move per animation frame
 *   - timings of Optimize on big rosters are printed against a budget; going over prints a
 *     WARN line and never fails the suite (machines differ; look at the trend instead)
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('./tests/load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('no script builds a container with innerHTML += (cards go into an array, assigned once)', () => {
  assert.equal(/innerHTML\s*\+=/.test(app.script), false);
  const assignments = app.script.match(/container\.innerHTML = cards\.join\(''\);/g) || [];
  assert.equal(assignments.length, 2, 'renderGroups and renderIdealComp each assign once');
  assert.equal((app.script.match(/cards\.push\(/g) || []).length, 2);
});

check('icon load errors are handled by a single capture-phase listener, never per-image onerror', () => {
  const listeners = app.script.match(/document\.addEventListener\('error'[^\n]*\btrue\)/g) || [];
  assert.equal(listeners.length, 1);
  assert.equal(/\sonerror=["']/.test(app.script + app.html), false, 'no inline onerror attribute in any markup');
});

function devEnv({ search, hasPerformance = true }) {
  const log = [];
  const performance = hasPerformance ? {
    mark: name => log.push(['mark', name]),
    measure: (name, from, to) => log.push(['measure', name, from, to]),
    clearMarks: name => log.push(['clear', name]),
  } : undefined;
  const api = app.sandbox(['devMeasure', 'devPerfEnabled'], { globals: { location: { search }, performance } }).api;
  return { log, api };
}

check('devMeasure marks and measures only under ?dev, and returns the result', () => {
  const dev = devEnv({ search: '?dev' });
  assert.equal(dev.api.devPerfEnabled(), true);
  assert.equal(dev.api.devMeasure('pp:test', () => 42), 42);
  assert.equal(JSON.stringify(dev.log.filter(e => e[0] !== 'clear')),
    JSON.stringify([['mark', 'pp:test:start'], ['mark', 'pp:test:end'], ['measure', 'pp:test', 'pp:test:start', 'pp:test:end']]));

  for (const search of ['', '?x=1', '?developer', '?v=1&dev', '?dev=1']) {
    const env = devEnv({ search });
    const expected = /[?&]dev(?:[&=]|$)/.test(search);
    assert.equal(env.api.devPerfEnabled(), expected, search);
    env.api.devMeasure('pp:test', () => 1);
    assert.equal(env.log.length > 0, expected, search);
  }
});

check('devMeasure measures a failing call, rethrows, and tolerates a missing performance API', () => {
  const dev = devEnv({ search: '?dev' });
  assert.throws(() => dev.api.devMeasure('pp:boom', () => { throw new Error('boom'); }), /boom/);
  assert(dev.log.some(e => e[0] === 'measure' && e[1] === 'pp:boom'), 'still measured');
  const bare = devEnv({ search: '?dev', hasPerformance: false });
  assert.equal(bare.api.devMeasure('pp:test', () => 7), 7);
  const node = app.sandbox(['devMeasure']).api; // no location at all, as in these suites
  assert.equal(node.devMeasure('pp:test', () => 8), 8);
});

check('Optimize and Compare run inside devMeasure', () => {
  assert(/optimize\(\) \{\s*devMeasure\('pp:optimize'/.test(app.script));
  assert(/function compareOptimizerModes\(\) \{\s*return devMeasure\('pp:compare', computeOptimizerModeComparison\);/.test(app.script));
});

function ghostEnv() {
  const style = {};
  const frames = [];
  const document = { getElementById: id => (id === 'drag-ghost' ? { style } : null) };
  const globals = {
    document,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
  };
  const api = app.sandbox(['DragGhost'], { globals, extraSource: app.slice('const DragGhost', '(function initDragDrop') }).api;
  const flush = () => { const pending = frames.splice(0).filter(Boolean); pending.forEach(fn => fn()); return pending.length; };
  return { api, style, frames, flush };
}

check('the drag ghost moves by transform, one write per animation frame, using the newest position', () => {
  const env = ghostEnv();
  for (let i = 1; i <= 50; i++) env.api.DragGhost.move(i, i * 2);
  assert.equal(env.frames.length, 1, 'one frame requested for 50 moves');
  assert.equal(env.style.transform, undefined, 'nothing written before the frame');
  assert.equal(env.flush(), 1);
  assert.equal(env.style.transform, 'translate(62px, 90px)');
  assert.equal('left' in env.style || 'top' in env.style, false, 'no layout-triggering left/top');
  env.api.DragGhost.move(10, 10);
  assert.equal(env.flush(), 1, 'the next frame is scheduled again');
  assert.equal(env.style.transform, 'translate(22px, 0px)');
});

check('the ghost starts under the pointer, and stop() cancels a pending move', () => {
  const env = ghostEnv();
  env.api.DragGhost.start(100, 200);
  assert.equal(env.style.transform, 'translate(112px, 190px)');
  env.api.DragGhost.move(300, 300);
  env.api.DragGhost.stop();
  assert.equal(env.flush(), 0);
  assert.equal(env.style.transform, 'translate(112px, 190px)');
});

check('no drag handler writes the ghost position with left/top, and touch highlights are coalesced per frame', () => {
  assert.equal(/ghost\.style\.(?:left|top)\b/.test(app.script), false);
  assert(/\.drag-ghost \{[^}]*left: 0; top: 0; will-change: transform;/.test(app.css));
  const touch = app.slice('(function initTouchDrag()', '// Android raises a context menu');
  assert(touch.includes('queueHighlight(t.clientX, t.clientY)'));
  assert(!/highlight\(targetAt\(t\.clientX, t\.clientY\)\);\s*\n\s*\n\s*const h = window\.innerHeight/.test(touch), 'touchmove no longer highlights synchronously');
  assert(touch.includes('cancelAnimationFrame(highlightFrame)'), 'ending a drag drops a pending highlight');
});

// ── Timing: warn only ──────────────────────────────────────────
// Budgets are loose on purpose (a slow CI box should not cry wolf). A WARN is a prompt to
// look, not a failure; this section can never fail the suite, even if it throws.
const BUDGET_MS = { optimize: 400, compare: 1500 };
try {
  const PP = app.requireLogic(['Import', 'Optimizer', 'State', 'compareOptimizerModes'], '_pp_perf_logic.tmp.js');
  const Scenarios = require('./scenarios.js');
  const { Import, Optimizer, State, compareOptimizerModes } = PP;
  const time = fn => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const warnings = [];
  const report = (label, ms, budget) => {
    const over = ms > budget;
    console.log(`${over ? 'WARN' : 'info'}  ${label}: ${ms.toFixed(0)} ms (budget ${budget} ms)`);
    if (over) warnings.push(label);
  };
  for (const id of ['F01', 'F27', 'F28']) {
    const scenario = Scenarios.scenarios.find(s => s.id === id);
    State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
    State.selectedRaid = scenario.raid || 'bt'; State.optimizerMode = 'max_dps';
    Import.importRaidHelper(JSON.stringify(Scenarios.toRaidHelperJson(scenario)));
    report(`Optimize ${id} (${scenario.entries.length} sign-ups)`, time(() => Optimizer.optimize()), BUDGET_MS.optimize);
    report(`Compare all modes ${id}`, time(() => compareOptimizerModes()), BUDGET_MS.compare);
  }
  if (warnings.length) console.log(`WARN  ${warnings.length} timing budget(s) exceeded (not a failure): ${warnings.join('; ')}`);
} catch (err) {
  console.log('WARN  timing section skipped: ' + err.message);
}

console.log(`\nPerf tests: ${passed} passed, 0 failed, ${passed} total`);
