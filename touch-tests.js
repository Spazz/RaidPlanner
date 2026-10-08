/**
 * PartyPlanner Web - Touch drag listener scoping tests (Phase 2, G5 / B15)
 * Run: node touch-tests.js
 *
 * The long-press touch drag needs a NON-passive touchmove listener (to stop the page
 * scrolling under the finger). A permanent one on document slows every scroll, so it is
 * registered when a finger lands on a draggable slot and removed when the press becomes
 * a scroll, the drag ends, or the touch is cancelled. This suite runs the real
 * initTouchDrag IIFE against a minimal fake DOM.
 */
const assert = require('node:assert/strict');
const vm = require('vm');
const app = require('./tests/load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function makeEnv() {
  const listeners = [];   // live registrations: { type, fn, passive, capture }
  const timers = [];
  const slotClasses = new Set();
  const slot = {
    dataset: { group: '0', slot: '0' },
    classList: { add: c => slotClasses.add(c), remove: c => slotClasses.delete(c), contains: c => slotClasses.has(c) },
    closest: sel => (sel === '.player-slot[draggable="true"]' || sel === '.player-slot') ? slot : null,
  };
  const stub = () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, contains: () => false });
  const ghost = stub();
  const document = {
    getElementById: id => id === 'drag-ghost' ? ghost : stub(),
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, passive: !!(opts && opts.passive), capture: opts === true || !!(opts && opts.capture) });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    elementFromPoint: () => null,
    querySelectorAll: () => [],
  };
  const ctx = vm.createContext({
    document, console, Math, Date,
    window: { innerHeight: 800, scrollBy() {} },
    navigator: {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    State: { groups: [[{ uid: 'a', name: 'Alpha-Realm', class: 'MAGE' }]], bench: [], unplaced: [] },
    Config: { ClassColors: {} },
    RosterEdit: {}, UnplacedDialog: {}, commit() {}, showToast() {}, moveGroupPlayer: () => false,
  });
  vm.runInContext(app.slice('(function initTouchDrag() {', '// ── BUFF OVERRIDE SYSTEM'), ctx);

  const fire = (type, e) => listeners.filter(l => l.type === type).forEach(l => l.fn(e));
  const touch = (x, y) => ({ clientX: x, clientY: y });
  return {
    slot, ghost, listeners, slotClasses,
    moveListeners: () => listeners.filter(l => l.type === 'touchmove'),
    start: (x = 100, y = 100) => fire('touchstart', { touches: [touch(x, y)], target: slot }),
    move: (x, y) => { const e = { touches: [touch(x, y)], prevented: false, preventDefault() { this.prevented = true; } }; fire('touchmove', e); return e; },
    end: (x = 100, y = 100) => fire('touchend', { changedTouches: [touch(x, y)] }),
    cancel: () => fire('touchcancel', {}),
    longPress: () => { const t = timers.filter(x => x.fn).pop(); t.fn(); t.fn = null; },
  };
}

check('no touchmove listener exists until a finger lands on a draggable slot', () => {
  const env = makeEnv();
  assert.equal(env.moveListeners().length, 0);
});

check('touchstart on a slot registers one non-passive touchmove listener', () => {
  const env = makeEnv();
  env.start();
  const moves = env.moveListeners();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].passive, false);
  env.start();   // a second touchstart must not stack another listener
  assert.equal(env.moveListeners().length, 1);
});

check('the touchstart listener itself stays passive', () => {
  const env = makeEnv();
  const starts = env.listeners.filter(l => l.type === 'touchstart');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].passive, true);
});

check('a quick tap removes the listener again', () => {
  const env = makeEnv();
  env.start();
  env.end();
  assert.equal(env.moveListeners().length, 0);
});

check('moving past the tolerance before the long press (a scroll) removes the listener and never blocks it', () => {
  const env = makeEnv();
  env.start(100, 100);
  const e = env.move(100, 160);
  assert.equal(e.prevented, false);
  assert.equal(env.moveListeners().length, 0);
});

check('a small wobble during the press keeps the listener', () => {
  const env = makeEnv();
  env.start(100, 100);
  env.move(103, 102);
  assert.equal(env.moveListeners().length, 1);
});

check('after the long press the drag blocks page scroll, then drop removes the listener', () => {
  const env = makeEnv();
  env.start();
  env.longPress();
  assert(env.slotClasses.has('dragging'), 'drag started');
  assert.equal(env.moveListeners().length, 1);
  const e = env.move(140, 220);
  assert.equal(e.prevented, true, 'touchmove during an active drag must preventDefault');
  assert.equal(env.ghost.style.left, '152px');
  env.end(140, 220);
  assert.equal(env.slotClasses.has('dragging'), false);
  assert.equal(env.moveListeners().length, 0);
});

check('touchcancel during a drag removes the listener', () => {
  const env = makeEnv();
  env.start();
  env.longPress();
  env.cancel();
  assert.equal(env.moveListeners().length, 0);
  assert.equal(env.slotClasses.has('dragging'), false);
});

check('touchcancel during the press removes the listener', () => {
  const env = makeEnv();
  env.start();
  env.cancel();
  assert.equal(env.moveListeners().length, 0);
});

check('several drags in a row never leave more than one listener', () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) {
    env.start(); env.longPress(); env.move(150, 150); env.end(150, 150);
    env.start(); env.end();
    env.start(); env.move(100, 200);
    assert.equal(env.moveListeners().length, 0);
  }
});

console.log(`\n${passed} checks passed`);
