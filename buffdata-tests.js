/**
 * PartyPlanner Web - buff/debuff data tests
 * Run: node buffdata-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> runs in a sandboxed context and the pieces under test are pulled
 * out through globalThis.api.
 *
 * Covers: Rulesets' benefitsRoles agreeing with the DPS_VALUE/MIT_VALUE tables
 * the optimizer scores with (one assertion per ruleset, so a future edit that
 * drifts either side fails here), the TBC talent/spec gates on raid debuffs
 * (Misery = Shadow Priest, Hunter's Mark = any Hunter), Unleashed Rage being
 * melee-only, the Totem of Wrath tooltip, and the Open-slot Hunter's Mark credit
 * (earned once by any Hunter spec; a Marksmanship pick earns nothing extra for Improved Hunter's Mark).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'Rulesets', 'OpenSlots', 'getRaidDebuffCoverage', 'dpsValueFor', 'nextUid']);
const { State, Config, Rulesets, OpenSlots, getRaidDebuffCoverage, dpsValueFor, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function player(cls, spec) {
  const role = Rulesets.tbc.specs[cls] && Object.values(Rulesets.tbc.specs[cls]).find(s => s.name === spec).role;
  return { uid: nextUid(), name: `${cls}-${spec}`, class: cls, spec, role };
}

// The roles a buff is worth anything to, as the optimizer's tables see it:
// the same key -> class -> role resolution as dpsValueFor, plus the tank
// mitigation table. Recipient DPS weight only scales a value, never zeroes it.
function valuedRoles(rules, buffId) {
  const dv = (rules.dpsValue || {})[buffId] || {};
  const mv = (rules.mitValue || {})[buffId] || {};
  const roles = new Set();
  for (const [cls, specs] of Object.entries(rules.specs)) {
    for (const s of Object.values(specs)) {
      const key = `${cls}:${s.name}`;
      let base = 0;
      if (dv.key && dv.key[key] != null) base = dv.key[key];
      else if (dv.class && dv.class[cls] != null) base = dv.class[cls];
      else if (dv.role && dv.role[s.role] != null) base = dv.role[s.role];
      if (base > 0) roles.add(s.role);
      const mit = mv[key] != null ? mv[key] : (mv['*'] || 0);
      if (s.role === 'tank' && mit > 0) roles.add('tank');
    }
  }
  return [...roles].sort();
}

for (const version of Object.keys(Rulesets)) {
  check(`${version}: every buff's benefitsRoles matches the roles DPS_VALUE/MIT_VALUE give it value`, () => {
    const rules = Rulesets[version];
    const drift = [];
    for (const [id, buff] of Object.entries(rules.buffs)) {
      if (!buff.benefitsRoles) continue;
      const declared = [...buff.benefitsRoles].sort();
      const valued = valuedRoles(rules, id);
      if (declared.join() !== valued.join()) drift.push(`${id}: benefitsRoles [${declared}] vs valued [${valued}]`);
    }
    assert.deepEqual(drift, []);
  });
}

check('Misery is a Shadow Priest talent: Shadow covers it, Discipline and Holy do not', () => {
  State.gameVersion = 'tbc';
  assert.equal(Config.Debuffs.MISERY.sourceSpec, 'Shadow');
  assert(getRaidDebuffCoverage([[player('PRIEST', 'Shadow')]]).has('MISERY'));
  assert(!getRaidDebuffCoverage([[player('PRIEST', 'Discipline')]]).has('MISERY'));
  assert(!getRaidDebuffCoverage([[player('PRIEST', 'Holy')]]).has('MISERY'));
});

check("Hunter's Mark is covered by any Hunter spec, not only Marksmanship", () => {
  State.gameVersion = 'tbc';
  assert.equal(Config.Debuffs.HUNTERS_MARK.sourceSpec, undefined);
  for (const spec of ['Beast Mastery', 'Marksmanship', 'Survival']) {
    assert(getRaidDebuffCoverage([[player('HUNTER', spec)]]).has('HUNTERS_MARK'), `${spec} Hunter applies Hunter's Mark`);
  }
  assert(!getRaidDebuffCoverage([[player('ROGUE', 'Combat')]]).has('HUNTERS_MARK'));
});

check('Unleashed Rage is melee-only: ranged and casters get no value, melee and tanks do', () => {
  State.gameVersion = 'tbc';
  const ur = Config.Buffs.UNLEASHED_RAGE;
  assert(!ur.benefitsRoles.includes('ranged_dps'));
  assert.equal(dpsValueFor('UNLEASHED_RAGE', player('HUNTER', 'Beast Mastery')), 0);
  assert.equal(dpsValueFor('UNLEASHED_RAGE', player('MAGE', 'Fire')), 0);
  assert(dpsValueFor('UNLEASHED_RAGE', player('ROGUE', 'Combat')) > 0);
  assert(dpsValueFor('UNLEASHED_RAGE', player('WARRIOR', 'Protection')) > 0);
});

check('Totem of Wrath describes the TBC effect: +3% spell hit and +3% spell crit, no spell power', () => {
  const desc = Config.Buffs.TOTEM_OF_WRATH.desc;
  assert(/spell hit chance[^.]*by 3%/i.test(desc), desc);
  assert(/spell critical strike chance by 3%/i.test(desc), desc);
  assert(!/spell power/i.test(desc), desc);
});

function openSlotBoard() {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  State.groups = [];
  State.bench = [];
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
}
const value = (candidate, raid) => OpenSlots._raidValue(candidate, raid, 'max_dps');

check("Open slots: with no Hunter in the raid every Hunter spec earns Hunter's Mark credit", () => {
  openSlotBoard();
  const raid = [player('WARRIOR', 'Fury'), player('ROGUE', 'Combat'), player('MAGE', 'Fire')];
  // BM and Marksmanship bring the same debuffs; only the picks' own DPS weight
  // differs (a few tenths), not a whole Hunter's Mark tier (~8).
  const bm = value(player('HUNTER', 'Beast Mastery'), raid), mm = value(player('HUNTER', 'Marksmanship'), raid);
  assert(Math.abs(bm - mm) < 1, `BM ${bm} vs MM ${mm}`);
});

check("Open slots: a Marksmanship pick earns no Improved Hunter's Mark credit once any Hunter covers the base spell", () => {
  openSlotBoard();
  const raid = [player('WARRIOR', 'Fury'), player('ROGUE', 'Combat'), player('HUNTER', 'Beast Mastery')];
  // Both candidates are the raid's 2nd Hunter and bring the same debuffs; the only difference is that
  // BM repeats its spec (-SPEC_REPEAT). Every TBC raid hunter build has Improved Hunter's Mark (user decision 2026-10-10).
  const gap = value(player('HUNTER', 'Marksmanship'), raid) - value(player('HUNTER', 'Beast Mastery'), raid);
  assert(Math.abs(gap - OpenSlots.SPEC_REPEAT) < 1e-9, `gap ${gap} must be exactly the spec-repeat cost`);
});

check("Open slots: a second Marksmanship pick adds no Hunter's Mark credit over a second BM one", () => {
  openSlotBoard();
  const raid = [player('WARRIOR', 'Fury'), player('ROGUE', 'Combat'), player('HUNTER', 'Beast Mastery'), player('HUNTER', 'Marksmanship')];
  const mm = value(player('HUNTER', 'Marksmanship'), raid);
  const bm = value(player('HUNTER', 'Beast Mastery'), raid);
  assert(Math.abs(mm - bm) < 1e-9, `MM ${mm} vs BM ${bm}`);
});

console.log(`\nBuff data tests: ${passed} passed, 0 failed, ${passed} total`);
