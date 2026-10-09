/**
 * PartyPlanner Web - Touch drag listener scoping tests (Phase 2, G5 / B15)
 * Run: node touch-tests.js
 *
 * The long-press touch drag needs a NON-passive touchmove listener (to stop the page
 * scrolling under the finger). Browsers decide at touchstart whether a touch can be
 * cancelled, so the listener cannot be added mid-gesture: it is permanent but scoped to the
 * drag containers (#groups-container, #bench-section), never document, and it ignores
 * moves unless a press or drag is in progress. This suite runs the real initTouchDrag IIFE
 * against a minimal fake DOM.
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
  const lookups = { count: 0 };
  const frames = [];      // pending animation frames (run on demand by flushFrames)
  const slotClasses = new Set();
  const slot = {
    dataset: { group: '0', slot: '0' },
    classList: { add: c => slotClasses.add(c), remove: c => slotClasses.delete(c), contains: c => slotClasses.has(c) },
    closest: sel => (sel === '.player-slot[draggable="true"]' || sel === '.player-slot') ? slot : null,
  };
  const stub = () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, contains: () => false });
  const containerListeners = [];   // registrations on the drag containers: { id, type, fn, passive }
  const container = id => {
    const el = stub();
    el.addEventListener = (type, fn, opts) => containerListeners.push({ id, type, fn, passive: !!(opts && opts.passive) });
    return el;
  };
  const containers = { 'groups-container': container('groups-container'), 'bench-section': container('bench-section') };
  const ghost = stub();
  const document = {
    getElementById: id => id === 'drag-ghost' ? ghost : (containers[id] || stub()),
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, passive: !!(opts && opts.passive), capture: opts === true || !!(opts && opts.capture) });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    elementFromPoint: () => { lookups.count++; return null; },
    querySelectorAll: () => [],
  };
  const ctx = vm.createContext({
    document, console, Math, Date,
    window: { innerHeight: 800, scrollBy() {} },
    navigator: {},
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: id => { frames[id - 1] = null; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    State: { groups: [[{ uid: 'a', name: 'Alpha-Realm', class: 'MAGE' }]], bench: [], unplaced: [] },
    Config: { ClassColors: {} },
    RosterEdit: {}, UnplacedDialog: {}, commit() {}, showToast() {}, moveGroupPlayer: () => false,
  });
  vm.runInContext(app.slice('const DragGhost', '(function initDragDrop'), ctx);
  vm.runInContext(app.slice('(function initTouchDrag() {', '// ── BUFF OVERRIDE SYSTEM'), ctx);

  const fire = (type, e) => {
    listeners.filter(l => l.type === type).forEach(l => l.fn(e));
    // touchmove is delivered to the container the touch started in (a slot is inside one)
    if (type === 'touchmove') containerListeners.filter(l => l.type === 'touchmove' && l.id === 'groups-container').forEach(l => l.fn(e));
  };
  const touch = (x, y) => ({ clientX: x, clientY: y });
  return {
    slot, ghost, listeners, slotClasses, lookups,
    moveListeners: () => containerListeners.filter(l => l.type === 'touchmove'),
    start: (x = 100, y = 100) => fire('touchstart', { touches: [touch(x, y)], target: slot }),
    move: (x, y) => { const e = { touches: [touch(x, y)], prevented: false, preventDefault() { this.prevented = true; } }; fire('touchmove', e); return e; },
    end: (x = 100, y = 100) => fire('touchend', { changedTouches: [touch(x, y)] }),
    cancel: () => fire('touchcancel', {}),
    flushFrames: () => { const pending = frames.splice(0).filter(Boolean); pending.forEach(fn => fn()); },
    longPress: () => { const t = timers.filter(x => x.fn).pop(); t.fn(); t.fn = null; },
  };
}

check('no touchmove listener is ever registered on document', () => {
  const env = makeEnv();
  env.start(); env.longPress(); env.move(140, 220); env.end(140, 220);
  assert.equal(env.listeners.filter(l => l.type === 'touchmove').length, 0);
});

check('non-passive touchmove listeners exist from startup on both drag containers', () => {
  const env = makeEnv();
  const moves = env.moveListeners();
  assert.deepEqual(moves.map(l => l.id).sort(), ['bench-section', 'groups-container']);
  assert(moves.every(l => l.passive === false), 'must be non-passive so preventDefault works');
  env.start();   // registration does not change per touch
  assert.equal(env.moveListeners().length, 2);
});

check('the touchstart listener itself stays passive', () => {
  const env = makeEnv();
  const starts = env.listeners.filter(l => l.type === 'touchstart');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].passive, true);
});

check('with no press or drag, touchmove is ignored so plain scrolls are never blocked', () => {
  const env = makeEnv();
  const e = env.move(100, 300);
  assert.equal(e.prevented, false);
});

check('moving past the tolerance before the long press (a scroll) is never blocked', () => {
  const env = makeEnv();
  env.start(100, 100);
  const e = env.move(100, 160);
  assert.equal(e.prevented, false);
  const e2 = env.move(100, 220);
  assert.equal(e2.prevented, false, 'a cancelled press stays a scroll');
});

check('a small wobble during the press does not block or cancel', () => {
  const env = makeEnv();
  env.start(100, 100);
  const e = env.move(103, 102);
  assert.equal(e.prevented, false);
  env.longPress();
  assert(env.slotClasses.has('dragging'), 'press survived the wobble');
});

check('after the long press the drag blocks page scroll, and ends on drop', () => {
  const env = makeEnv();
  env.start();
  env.longPress();
  assert(env.slotClasses.has('dragging'), 'drag started');
  const e = env.move(140, 220);
  assert.equal(e.prevented, true, 'touchmove during an active drag must preventDefault');
  env.flushFrames();
  assert.equal(env.ghost.style.transform, 'translate(152px, 210px)', 'the ghost follows the finger (by transform, applied on the next frame)');
  env.end(140, 220);
  assert.equal(env.slotClasses.has('dragging'), false);
  assert.equal(env.move(140, 300).prevented, false, 'after the drop, scrolling is free again');
});

check('touchcancel during a drag ends it and scrolling is free again', () => {
  const env = makeEnv();
  env.start();
  env.longPress();
  env.cancel();
  assert.equal(env.slotClasses.has('dragging'), false);
  assert.equal(env.move(100, 300).prevented, false);
});

check('touchcancel during the press cancels it', () => {
  const env = makeEnv();
  env.start();
  env.cancel();
  assert.equal(env.move(100, 300).prevented, false);
});

check('during a drag, drop-target lookups run once per frame from the newest finger position', () => {
  const env = makeEnv();
  env.start();
  env.longPress();
  env.flushFrames(); // anything queued by the press itself
  const before = env.lookups.count;
  for (let i = 0; i < 10; i++) env.move(120 + i, 200 + i);
  assert.equal(env.lookups.count, before, 'touchmove no longer looks up the target synchronously');
  env.flushFrames();
  assert.equal(env.lookups.count, before + 1, 'one lookup for ten moves');
  env.move(130, 210);
  env.end(130, 210); // the drop does its own lookup; the queued highlight is dropped
  const afterDrop = env.lookups.count;
  env.flushFrames();
  assert.equal(env.lookups.count, afterDrop, 'no highlight work after the drag ended');
});

console.log(`
${passed} checks passed`);
