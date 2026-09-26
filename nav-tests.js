/**
 * PartyPlanner Web - Navigation redesign tests
 * Run: node nav-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> (everything above the '// ── UI RENDERING' split marker — pure
 * data/logic, no `document`) runs in a sandboxed context and the pieces
 * under test are pulled out through globalThis.api. Covers the pure logic
 * introduced for the Plan-mode nav redesign: the optimizer-strategy menu's
 * copy (STRATEGY_DESCRIPTIONS/strategyLabel), kept in lockstep with
 * MODE_CONFIG so the split-button menu can never list a strategy the
 * optimizer doesn't have, or vice versa.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({ TextEncoder, TextDecoder, console });
vm.runInContext(
  script.split('// ── UI RENDERING')[0] +
  '\nglobalThis.api={MODE_CONFIG,STRATEGY_DESCRIPTIONS,strategyLabel};',
  ctx
);
const { MODE_CONFIG, STRATEGY_DESCRIPTIONS, strategyLabel } = ctx.api;

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

check('Every MODE_CONFIG strategy has exactly one STRATEGY_DESCRIPTIONS entry (no stragglers either way)', () => {
  const modeKeys = Object.keys(MODE_CONFIG).sort();
  const descKeys = Object.keys(STRATEGY_DESCRIPTIONS).sort();
  assert.deepEqual(descKeys, modeKeys);
});

check('Every strategy description has a non-empty label and description', () => {
  for (const [mode, desc] of Object.entries(STRATEGY_DESCRIPTIONS)) {
    assert.ok(desc.label && desc.label.trim().length > 0, `${mode}: label`);
    assert.ok(desc.description && desc.description.trim().length > 0, `${mode}: description`);
  }
});

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

check('strategyLabel() returns the matching label for every known mode', () => {
  for (const mode of Object.keys(MODE_CONFIG)) {
    assert.equal(strategyLabel(mode), STRATEGY_DESCRIPTIONS[mode].label);
  }
});

check('strategyLabel() falls back to Max DPS for an unknown/legacy mode string', () => {
  assert.equal(strategyLabel('not_a_real_mode'), STRATEGY_DESCRIPTIONS.max_dps.label);
  assert.equal(strategyLabel(undefined), STRATEGY_DESCRIPTIONS.max_dps.label);
});

console.log(`\nNav tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
