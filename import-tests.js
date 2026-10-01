/**
 * PartyPlanner Web - Raid-Helper import tests (class-only sign-ups, backlog #2)
 * Run: node import-tests.js
 *
 * Same vm loader pattern as classic-tests.js/forever-tests.js: the logic half
 * of index.html's <script> is executed in a sandboxed context and the pieces
 * under test are pulled out through globalThis.api.
 *
 * Covers the 2026-09-26 "Raid-Helper class-only sign-ups silently guess the
 * wrong role" fix:
 *   - Import._resolveRaidHelperEntry defaults a class-only (or unresolvable-
 *     spec) sign-up to Config.DefaultRoleForClass[class] instead of a blanket
 *     'melee_dps', for every class in that table, and flags it needsReview
 *     the same way parsePlainRoster flags its own defaulted spec.
 *   - A normal class+spec sign-up is never flagged (no regression).
 *   - The flag survives into State (both "slots" and "signUps" import shapes,
 *     plus the Raid-Helper re-sync diff/apply path) so it's visible on the
 *     player card, not just during resolution.
 *   - Tank/Bench/Tentative/Absence categorization is untouched.
 *   - Tank/healer floor math sees the corrected role, not the old blanket
 *     melee_dps guess.
 *   - RosterEdit.UpdatePlayer clears the flag once a leader picks a real spec.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({ TextEncoder, TextDecoder, console });
vm.runInContext(script.split('// ── UI RENDERING')[0] + '\nglobalThis.api={State,Config,GameVersions,Rulesets,Import,Optimizer,RosterEdit,getGroupBuffs,getMissingBuffInsights,getRaidDebuffCoverage,Faction,enforceRaidCapacity,nextUid};', ctx);
const { State, Config, GameVersions, Rulesets, Import, Optimizer, RosterEdit, getGroupBuffs, getMissingBuffInsights, getRaidDebuffCoverage, Faction, enforceRaidCapacity, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function resetState(version) {
  State.gameVersion = version || 'tbc';
  State.selectedRaid = Config.RaidOrder[0];
  State.groups = [[]];
  State.bench = [];
  State.roster = [];
  State.buffOverrides = {};
}

// ── 1. Class-only sign-ups: per-class default role + needsReview ──
const EXPECTED_DEFAULT_ROLE = {
  Warrior: 'melee_dps', Paladin: 'healer', Hunter: 'ranged_dps', Rogue: 'melee_dps',
  Priest: 'healer', Shaman: 'healer', Mage: 'caster_dps', Warlock: 'caster_dps', Druid: 'healer',
};

for (const [className, expectedRole] of Object.entries(EXPECTED_DEFAULT_ROLE)) {
  check(`_resolveRaidHelperEntry: class-only ${className} defaults to ${expectedRole} and needs review`, () => {
    const { classFile, specName, role, needsReview, reviewReason } =
      Import._resolveRaidHelperEntry({ className, specName: undefined });
    assert.equal(classFile, className.toUpperCase(), 'classFile should resolve from className');
    assert.equal(role, expectedRole, `role should match Config.DefaultRoleForClass.${className.toUpperCase()}`);
    assert.equal(needsReview, true, 'a class-only sign-up must be flagged for review');
    assert(specName && specName !== 'Unknown', 'a real spec name should be defaulted in, not "Unknown"');
    assert(typeof reviewReason === 'string' && reviewReason.length > 0, 'reviewReason should explain the default');
  });
}

check('Config.DefaultRoleForClass matches the backlog table exactly', () => {
  // Cross-realm objects from the vm context aren't reference-equal to a
  // plain object literal here even when every field matches (Object.prototype
  // differs across realms), so compare via JSON rather than assert.deepEqual.
  assert.equal(JSON.stringify(Config.DefaultRoleForClass, Object.keys(Config.DefaultRoleForClass).sort()), JSON.stringify({
    WARRIOR: 'melee_dps', PALADIN: 'healer', HUNTER: 'ranged_dps', ROGUE: 'melee_dps',
    PRIEST: 'healer', SHAMAN: 'healer', MAGE: 'caster_dps', WARLOCK: 'caster_dps', DRUID: 'healer',
  }, Object.keys(Config.DefaultRoleForClass).sort()));
});

// ── 2. Normal class+spec sign-up: no regression ──
check('_resolveRaidHelperEntry: a normal class+spec sign-up is never flagged', () => {
  const { classFile, specName, role, needsReview, reviewReason } =
    Import._resolveRaidHelperEntry({ className: 'Priest', specName: 'Holy' });
  assert.equal(classFile, 'PRIEST');
  assert.equal(specName, 'Holy');
  assert.equal(role, 'healer');
  assert.equal(needsReview, false);
  assert.equal(reviewReason, null);
});

// ── 3. Unrecognized spec name on a known class: same treatment, different reason ──
check('_resolveRaidHelperEntry: an unrecognized spec name on a known class still resolves and flags', () => {
  const { classFile, role, needsReview, reviewReason } =
    Import._resolveRaidHelperEntry({ className: 'Shaman', specName: 'NotARealSpec' });
  assert.equal(classFile, 'SHAMAN');
  assert.equal(role, 'healer');
  assert.equal(needsReview, true);
  assert(reviewReason.includes('NotARealSpec'), 'reason should name the unrecognized spec');
});

// ── 4. Tank/Bench/Tentative/Late/Absence categorization ──
check('Raid-Helper Absence entries are held unplaced with an absent status', () => {
  const e = Import._readRaidHelperEntry({ className: 'Absence', specName: 'Absence', name: 'Gone' }, 'x');
  assert.equal(e.status, 'absent');
  assert.equal(e.category, 'unplaced');
  assert.equal(e.class, null, 'an Absence carries no class');
  assert.equal(e.needsReview, false, 'a classless entry is not flagged as a defaulted spec');
});
check('Raid-Helper Tentative/Bench/Late entries categorize as bench with their status, real spec resolved (not flagged)', () => {
  assert.equal(Import._readRaidHelperEntry({ className: 'Tentative', specName: 'Fire' }, 'x').category, 'bench');
  assert.equal(Import._readRaidHelperEntry({ className: 'Bench', specName: 'Fire' }, 'x').status, 'bench');
  const late = Import._readRaidHelperEntry({ className: 'Late', specName: 'Fire' }, 'x');
  assert.equal(late.status, 'late');
  assert.equal(late.category, 'bench', 'Late is held on the bench, never seated by the optimizer');
  assert.equal(Import._readRaidHelperEntry({ className: 'Mage', specName: 'Fire' }, 'x').category, 'raider');
  const t = Import._resolveRaidHelperEntry({ className: 'Tentative', specName: 'Fire' });
  assert.equal(t.classFile, 'MAGE');
  assert.equal(t.role, 'caster_dps');
  assert.equal(t.needsReview, false, 'a Tentative sign-up with a real spec must not be flagged');
});
check('Raid-Helper Tank entries with a resolvable spec still get role=tank (unaffected by the default-role fallback)', () => {
  const { classFile, role, needsReview } = Import._resolveRaidHelperEntry({ className: 'Tank', specName: 'Protection' });
  assert.equal(classFile, 'WARRIOR');
  assert.equal(role, 'tank');
  assert.equal(needsReview, false);
});
check('A Tank entry with no resolvable spec at all is still skipped (className "Tank" maps to no class)', () => {
  const { classFile } = Import._resolveRaidHelperEntry({ className: 'Tank', specName: undefined });
  assert.equal(classFile, null, 'no class is known for a bare Tank/Bench slot, so it stays unresolved, not guessed');
});

// ── 5. The flag survives into State: "signUps" import shape ──
function importSignUps(spec) {
  const signUps = [];
  let i = 0;
  for (const [name, className, specName] of spec) signUps.push({ name, className, specName, id: i++ });
  return Import.importRaidHelper(JSON.stringify({ signUps }));
}

check('_importRaidHelperSignUps: a class-only Priest lands seated with needsReview + reviewReason set', () => {
  resetState('tbc');
  const res = importSignUps([
    ['Tank1', 'Warrior', 'Protection'],
    ['Heal1', 'Priest', 'Holy'],
    ['Heal2', 'Priest', undefined], // class-only
    ['DPS1', 'Mage', 'Fire'],
  ]);
  assert.equal(res.success, true, res.error);
  const all = State.groups.flat().concat(State.bench || []);
  const flagged = all.find(p => p.name === 'Heal2');
  const clean = all.find(p => p.name === 'Heal1');
  assert(flagged, 'class-only sign-up should still be seated, not dropped');
  assert.equal(flagged.class, 'PRIEST');
  assert.equal(flagged.role, 'healer');
  assert.equal(flagged.needsReview, true);
  assert(typeof flagged.reviewReason === 'string' && flagged.reviewReason.length > 0);
  assert(!clean.needsReview, 'a confidently-resolved sign-up must not carry the flag');
});

// ── 6. The flag survives into State: "slots" import shape ──
check('_importRaidHelperSlots: a class-only Shaman lands seated with needsReview set', () => {
  resetState('classic');
  const res = Import.importRaidHelper(JSON.stringify({
    slots: [
      { name: 'Tank1', className: 'Warrior', specName: 'Protection', groupNumber: 1 },
      { name: 'Shammy', className: 'Shaman', specName: undefined, groupNumber: 1 },
    ],
  }));
  assert.equal(res.success, true, res.error);
  const shammy = State.groups.flat().find(p => p.name === 'Shammy');
  assert(shammy, 'class-only slot sign-up should still be seated');
  assert.equal(shammy.class, 'SHAMAN');
  assert.equal(shammy.role, 'healer');
  assert.equal(shammy.needsReview, true);
});

// ── 7. Tank/healer floor math treats a class-only healer sanely ──
check('A class-only Priest/Druid/Paladin counts toward the healer floor, not the melee_dps pool', () => {
  resetState('tbc');
  State.optimizerMode = 'balanced';
  const res = importSignUps([
    ['Tank1', 'Warrior', 'Protection'], ['Tank2', 'Warrior', 'Protection'],
    ['Heal1', 'Priest', undefined],   // class-only -> should resolve to healer
    ['Heal2', 'Druid', undefined],    // class-only -> should resolve to healer
    ['Heal3', 'Paladin', undefined],  // class-only -> should resolve to healer
    ['DPS1', 'Mage', 'Fire'], ['DPS2', 'Warlock', 'Destruction'], ['DPS3', 'Rogue', 'Combat'],
    ['DPS4', 'Warrior', 'Fury'], ['DPS5', 'Hunter', 'Marksmanship'],
  ]);
  assert.equal(res.success, true, res.error);
  const seated = State.groups.flat();
  const healerCount = seated.filter(p => p.role === 'healer').length;
  const meleeCount = seated.filter(p => p.role === 'melee_dps' && ['PRIEST', 'DRUID', 'PALADIN'].includes(p.class)).length;
  assert.equal(healerCount, 3, `expected the 3 class-only healers to count as healers, got ${healerCount} healer(s)`);
  assert.equal(meleeCount, 0, 'no class-only healer-default class should have landed in melee_dps');
  const floors = Optimizer.floorsFor(seated.length);
  assert(healerCount >= (floors.healer || 0) || seated.length < (floors.healer || 0),
    'healer floor accounting should reflect the corrected roles');
});

// ── 8. Re-sync diff/apply carries the flag through too ──
check('diffRaidHelperSignUps + applyRaidHelperSync: an added class-only sign-up carries needsReview', () => {
  resetState('tbc');
  State.roster = []; State.groups = [[]]; State.bench = [];
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({
    signUps: [{ name: 'NewGuy', className: 'Druid', specName: undefined, id: 1 }],
  }));
  assert.equal(diff.success, true);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].needsReview, true);
  const result = Import.applyRaidHelperSync(diff);
  const seated = State.groups.flat().concat(State.bench || []);
  const added = seated.find(p => p.name === 'NewGuy');
  assert(added, 'the added sign-up should have been folded into State');
  assert.equal(added.needsReview, true);
  assert.equal(added.role, 'healer');
});

check('diffRaidHelperSignUps + applyRaidHelperSync: a changed sign-up that gains a real spec clears needsReview', () => {
  resetState('tbc');
  const player = { uid: nextUid(), name: 'Fixable', class: 'DRUID', spec: 'Unknown', role: 'healer',
    needsReview: true, reviewReason: 'No spec chosen on Raid-Helper — defaulted to Restoration (healer)', groupNumber: 1 };
  State.groups = [[player]];
  State.bench = [];
  State.roster = State.groups.flat();
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({
    signUps: [{ name: 'Fixable', className: 'Druid', specName: 'Feral', id: 1 }],
  }));
  assert.equal(diff.changed.length, 1, 'a resolved spec differing from the defaulted one should be a change');
  Import.applyRaidHelperSync(diff);
  assert.equal(player.spec, 'Feral');
  assert.equal(player.role, 'melee_dps');
  assert(!player.needsReview, 'gaining a confidently-resolved spec should clear the flag');
});

// ── 9. RosterEdit.UpdatePlayer clears the flag on a manual fix ──
check('RosterEdit.UpdatePlayer clears needsReview once the leader picks an explicit spec', () => {
  resetState('tbc');
  const player = { uid: nextUid(), name: 'NeedsFix', class: 'SHAMAN', spec: 'Restoration', role: 'healer',
    needsReview: true, reviewReason: 'No spec chosen on Raid-Helper — defaulted to Restoration (healer)', groupNumber: 1 };
  State.groups = [[player]];
  State.bench = [];
  State.roster = State.groups.flat();
  const result = RosterEdit.UpdatePlayer(player.uid, { class: 'SHAMAN', spec: 'Enhancement' });
  assert.equal(result.success, true, result.error);
  assert.equal(player.role, 'melee_dps');
  assert(!player.needsReview, 'an explicit spec pick should clear the review flag');
  assert(!player.reviewReason);
});
check('RosterEdit.UpdatePlayer leaves needsReview alone when nothing about the spec changed (e.g. a pure rename)', () => {
  resetState('tbc');
  const player = { uid: nextUid(), name: 'SameSpec', class: 'PALADIN', spec: 'Holy', role: 'healer',
    needsReview: true, reviewReason: 'No spec chosen on Raid-Helper — defaulted to Holy (healer)', groupNumber: 1 };
  State.groups = [[player]];
  State.bench = [];
  State.roster = State.groups.flat();
  RosterEdit.UpdatePlayer(player.uid, { name: 'StillSameSpec', class: 'PALADIN', spec: 'Holy' });
  assert.equal(player.needsReview, true, 'renaming alone should not silently clear an unresolved review flag');
});

console.log(`\nImport tests (Raid-Helper class-only sign-ups): ${passed} passed, 0 failed, ${passed} total`);
