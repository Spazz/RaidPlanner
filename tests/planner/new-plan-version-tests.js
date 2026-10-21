/**
 * Raidsmith - the game version of a new plan started from the landing (NewPlanVersion in js/storage.js)
 * Run: node tests/planner/new-plan-version-tests.js
 *
 * In a guild the landing's version tabs are hidden, so a new plan (paste import, Raid-Helper link, plain-text roster, random roster,
 * empty plan) is built in the guild's own version. The plan on the board is never switched silently: begin() runs at the moment an entry
 * point starts a NEW plan, and importFromText only calls it when the import replaces the open plan (or nothing is open).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../load-app');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

function env(guildVersion) {
  const window = guildVersion === undefined ? {} : { Guild: { app: { plannerGuildVersion: () => guildVersion } } };
  const ctx = app.sandbox(['State', 'PlanStore', 'NewPlanVersion', 'GameVersions'], { globals: { window, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  return ctx.api;
}
const player = { uid: 'p1', name: 'Arimyr', class: 'Mage', spec: 'Fire', role: 'ranged_dps' };

check('no guild (signed out, or on none): the open version is the target and begin() changes nothing', () => {
  const { State, NewPlanVersion } = env(undefined);
  State.gameVersion = 'classic'; State.roster = [player]; State.groups = [[player]];
  assert.equal(NewPlanVersion.target(), 'classic');
  assert.equal(NewPlanVersion.begin(), false);
  assert.equal(State.roster.length, 1, 'the open plan is untouched');
  assert.equal(env(null).NewPlanVersion.guildVersion(), null);
});

check('a guild on another version: begin() starts an empty plan on that version\'s default raid', () => {
  const { State, NewPlanVersion, GameVersions } = env('forever');
  State.gameVersion = 'tbc'; State.selectedRaid = 'bt'; State.roster = [player]; State.groups = [[player]]; State.rosterName = 'Old plan';
  assert.equal(NewPlanVersion.target(), 'forever');
  assert.equal(NewPlanVersion.begin(), true);
  assert.equal(State.gameVersion, 'forever');
  assert.equal(State.selectedRaid, GameVersions.forever.defaultRaid);
  assert.deepEqual([State.roster.length, State.groups.length, State.bench.length], [0, 0, 0], 'the new plan starts empty');
  assert.notEqual(State.rosterName, 'Old plan');
});

check('a guild on the version already open: begin() does nothing (the plan on the board stays, nothing is wiped)', () => {
  const { State, NewPlanVersion } = env('tbc');
  State.gameVersion = 'tbc'; State.roster = [player]; State.groups = [[player]];
  assert.equal(NewPlanVersion.begin(), false);
  assert.equal(State.roster.length, 1);
});

check('a version the planner does not know is ignored', () => {
  const { State, NewPlanVersion } = env('retail');
  State.gameVersion = 'tbc';
  assert.equal(NewPlanVersion.guildVersion(), null);
  assert.equal(NewPlanVersion.target(), 'tbc');
});

check('every landing entry point that starts a new plan goes through the guard; the guild reports its version', () => {
  const root = path.join(__dirname, '..', '..');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const appJs = read('js/app.js');
  const modals = read('js/modals.js');
  const random = appJs.slice(appJs.indexOf("getElementById('btn-landing-random').addEventListener"));
  assert(/confirmReplaceWithRandom\(\)\) return;\n\s*NewPlanVersion\.begin\(\);/.test(random), 'random roster: after the replace confirmation');
  const empty = appJs.slice(appJs.indexOf("getElementById('btn-landing-empty').addEventListener"));
  assert(/PlanStore\.startFresh\(\);\n\s*NewPlanVersion\.begin\(\);/.test(empty), 'empty plan');
  assert(/if \(previousPlan \|\| !hasLoadedWork\(\)\) NewPlanVersion\.begin\(\);/.test(modals), 'paste / Raid-Helper import: only when the import replaces the open plan, or none is open');
  assert(/parsePlainRoster\(jsonStr, NewPlanVersion\.target\(\)\)/.test(modals), 'plain-text parse uses the new plan\'s version');
  assert(/dialog\.close\(\);\n\s*NewPlanVersion\.begin\(\);\n\s*const result = Import\.importPlainRoster/.test(modals), 'plain-text roster: on confirm');
  assert(/app\.plannerGuildVersion = plannerGuildVersion;/.test(read('js/guild/app.js')));
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
