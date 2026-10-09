/**
 * PartyPlanner Web - Navigation redesign tests
 * Run: node nav-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> (everything above the '// ── UI RENDERING' split marker — pure
 * data/logic, no `document`) runs in a sandboxed context and the pieces
 * under test are pulled out through globalThis.api. Covers the pure logic
 * behind the optimizer strategies: each MODE_CONFIG mode leans the way its
 * name says. The strategy picker UI is gone since the nav slim-down
 * (Optimize always runs Max DPS), but the modes stay for the optimizer's own
 * scoring and old saved plans.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['MODE_CONFIG']);
const { MODE_CONFIG } = ctx.api;

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

check('max_dps is the mode with the single highest dps weight — its copy calling out damage checks out', () => {
  const maxDpsWeight = MODE_CONFIG.max_dps.dps;
  for (const [mode, cfg] of Object.entries(MODE_CONFIG)) {
    if (mode === 'max_dps') continue;
    assert.ok(maxDpsWeight > cfg.dps, `max_dps.dps (${maxDpsWeight}) should exceed ${mode}.dps (${cfg.dps})`);
  }
});

check('tank_mit is the mode with the single highest mitigation weight — its "protect tanks first" copy checks out', () => {
  const tankMitWeight = MODE_CONFIG.tank_mit.mit;
  for (const [mode, cfg] of Object.entries(MODE_CONFIG)) {
    if (mode === 'tank_mit') continue;
    assert.ok(tankMitWeight > cfg.mit, `tank_mit.mit (${tankMitWeight}) should exceed ${mode}.mit (${cfg.mit})`);
  }
});

check('relaxed has the single lowest dps weight and single highest cohesion weight of any mode — the "keeps role groups together, skips fine-tuning" copy checks out', () => {
  const relaxed = MODE_CONFIG.relaxed;
  for (const [mode, cfg] of Object.entries(MODE_CONFIG)) {
    if (mode === 'relaxed') continue;
    assert.ok(relaxed.dps < cfg.dps, `relaxed.dps (${relaxed.dps}) should be < ${mode}.dps (${cfg.dps})`);
    assert.ok(relaxed.cohesion > cfg.cohesion, `relaxed.cohesion (${relaxed.cohesion}) should be > ${mode}.cohesion (${cfg.cohesion})`);
  }
});

// ── Menu placement on short viewports (nav slim-down) ──
// A fake trigger/menu at a given zoom scale; returns where Menu.position put the menu.
function placeMenu({ viewport, trigger, menuHeight, scale = 1.5 }) {
  const window = { innerWidth: 1280, innerHeight: viewport };
  const menu = {
    style: {},
    getBoundingClientRect() {
      const max = this.style.maxHeight ? parseFloat(this.style.maxHeight) * scale : Infinity;
      return { width: 280, height: Math.min(menuHeight, max) };
    },
  };
  const triggerEl = { offsetWidth: 32, getBoundingClientRect: () => ({ left: 1200, width: 32 * scale, top: trigger.top, bottom: trigger.bottom }) };
  const menuCtx = app.sandbox(['Menu'], { globals: { window }, extraSource: app.slice('const Menu = {', 'Menu._onDocMouseDown') });
  menuCtx.api.Menu.position(triggerEl, menu);
  const top = parseFloat(menu.style.top) * scale;
  const height = menu.getBoundingClientRect().height;
  return { top, bottom: top + height, height, maxHeight: menu.style.maxHeight };
}

check('a menu taller than the room below the trigger scrolls instead of running off a 620px viewport', () => {
  const placed = placeMenu({ viewport: 620, trigger: { top: 60, bottom: 100 }, menuHeight: 760 });
  assert.ok(placed.top >= 100, 'opens below the trigger, never over it');
  assert.ok(placed.bottom <= 620 - 8 + 0.5, `fits the viewport (bottom ${placed.bottom})`);
  assert.ok(placed.maxHeight, 'max-height is set so the menu scrolls');
  assert.ok(Math.abs(parseFloat(placed.maxHeight) * 1.5 - (620 - 100 - 12)) < 0.5, 'max-height is in the menu\'s zoomed CSS px');
});

check('a menu that fits keeps its natural height, and one near the bottom opens above without covering the trigger', () => {
  const fits = placeMenu({ viewport: 900, trigger: { top: 60, bottom: 100 }, menuHeight: 400 });
  assert.equal(fits.maxHeight, '');
  assert.equal(fits.top, 104);
  const low = placeMenu({ viewport: 620, trigger: { top: 560, bottom: 600 }, menuHeight: 760 });
  assert.ok(low.bottom <= 560 + 0.5, 'opens above and ends at or above the trigger');
  assert.ok(low.top >= 8 - 0.5, 'stays on screen');
});

console.log(`\nNav tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
