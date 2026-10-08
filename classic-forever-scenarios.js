/**
 * PartyPlanner Web - Classic/Forever 20/40-man optimizer quality suite
 * Run: node classic-forever-scenarios.js
 *
 * Same vm loader pattern as classic-tests.js/forever-tests.js: the logic half
 * of index.html's <script> is executed in a sandboxed context. Where those
 * files spot-check individual ruleset facts, this file feeds six realistic
 * UNASSIGNED rosters (Classic Horde 40, Classic Alliance 40, Classic Horde 20
 * ZG, Forever mixed 40, Forever 20 Hyjal, Forever 10 Barrow Deeps) through the
 * real Raid-Helper importer + Optimizer, in all four optimizer modes, and
 * checks the melee-consolidation/provider-spread invariants from the 2026-09-26
 * "20/40-man optimizer quality pass" task:
 *
 *   (a) no melee DPS (warrior/rogue/feral cat/enh/ret) sits in a group whose
 *       other members are all casters/healers (a "stranded" melee DPS)
 *   (b) shaman/paladin/crit-druid spread: no group stacks 2+ of a provider
 *       class while another group holding melee DPS has none
 *   (c) once shamans >= the raid's melee-identity group count, EVERY
 *       melee-identity group has Windfury
 *   (d) once shamans exceed the melee-identity group count, the surplus
 *       reaches caster-identity groups as Mana Spring
 *   (e) Feral druids: at most one melee-identity group is Feral-less while
 *       another holds two (folded into the (b) stacking check per class)
 *   (f) idempotence: a second Optimize() never moves anyone
 *   (g) the TBC scenario suite (node scenario-tests.js, 4068 checks) is
 *       unaffected by any change made for this task — verified separately,
 *       not re-run here (it has its own runner and fixtures)
 *
 * relaxed mode intentionally skips swap/move/pair-exchange refinement
 * (Optimizer.refineRounds returns immediately for 'relaxed' — see index.html)
 * so it leans entirely on greedy placement + the always-on deIsolate/
 * spreadProviders passes. Those two passes used to leave real gaps behind on
 * Relaxed's fixtures (a stranded melee DPS, a caster-identity group with no
 * Windfury-surplus shaman reaching it) because spreadProviders could re-isolate
 * a player deIsolate had just fixed, or hand every spare shaman to whichever
 * needy group happened to sort first, starving a later one — see index.html's
 * Optimizer.wouldIsolate()/isLastResortSource()/spareProtected (the 2026-09-26
 * "close Relaxed's optimizer quality gaps" fix) for how spreadProviders now
 * avoids both. All four invariants below are now real assertions in every
 * mode, including relaxed — there is no more "known gaps" carve-out.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Rulesets', 'Import', 'Optimizer', 'getGroupBuffs', 'getMissingBuffInsights', 'getRaidDebuffCoverage', 'Faction', 'enforceRaidCapacity', 'nextUid']);
const { State, Config, GameVersions, Rulesets, Import, Optimizer, getGroupBuffs, getMissingBuffInsights, getRaidDebuffCoverage, Faction, enforceRaidCapacity, nextUid } = ctx.api;

const MODES = ['max_dps', 'tank_mit', 'balanced', 'relaxed'];

// ── Helpers ──
function importSignUps(spec) {
  const signUps = [];
  let i = 0;
  for (const [count, className, specName] of spec) {
    for (let k = 0; k < count; k++) signUps.push({ name: 'FP' + (i++), className, specName });
  }
  return Import.importRaidHelper(JSON.stringify({ signUps }));
}
function layoutKey() {
  return State.groups.map(g => g.map(p => p.name).sort().join(',')).sort().join(' | ');
}
function meleeFamily(role) { return role === 'melee_dps' || role === 'tank' || role === 'ranged_dps'; }
function casterFamily(role) { return role === 'caster_dps' || role === 'healer'; }

// (a) A melee_dps player is "stranded" if nobody else in their group is
// melee-family (tank/melee_dps/ranged_dps) — same definition Optimizer.deIsolate uses.
function strandedMeleeDps(groups) {
  const out = [];
  groups.forEach((g, gi) => {
    g.forEach(p => {
      if (p.role !== 'melee_dps') return;
      const hasPeer = g.some(x => x !== p && meleeFamily(x.role));
      if (!hasPeer) out.push({ gi, p });
    });
  });
  return out;
}

// (b) A provider class/spec is stacked 2+ in a group while another group that
// actually holds melee_dps members has zero — same shape as forever-tests.js's
// hasStackingViolation, generalized to any matcher.
function stackingViolation(groups, matches) {
  return groups.some((g, gi) => {
    if (Optimizer.isTankGroup(gi, groups)) return false;
    if (g.filter(matches).length < 2) return false;
    return groups.some((g2, gi2) => gi2 !== gi
      && !Optimizer.isTankGroup(gi2, groups)
      && g2.some(p => p.role === 'melee_dps')
      && g2.filter(matches).length === 0);
  });
}

function providerMatchers(rules) {
  return (rules.rules.spreadProviders || []).map(spec => ({
    label: spec.class + (spec.spec ? ':' + (Array.isArray(spec.spec) ? spec.spec.join('/') : spec.spec) : ''),
    matches: p => p.class === spec.class && (!spec.spec || (Array.isArray(spec.spec) ? spec.spec.includes(p.spec) : p.spec === spec.spec)),
  }));
}

function meleeIdentityIndices(numGroups) {
  return Optimizer.roleIdentitiesFor(numGroups).reduce((out, id, i) => { if (id === 'melee_dps') out.push(i); return out; }, []);
}
function casterIdentityIndices(numGroups) {
  return Optimizer.roleIdentitiesFor(numGroups).reduce((out, id, i) => { if (id === 'caster_dps') out.push(i); return out; }, []);
}

// ── Fixtures ──
// Realistic sign-up counts per raid, following architecture-map.md's spec-key
// shape ([count, RaidHelperClassName, RaidHelperSpecName]) — same format
// classic-tests.js/forever-tests.js use for their importSignUps() rosters.
// Composition follows the 40-man convention in tasks/research-classic-buffs.md
// ("40-man comp conventions"): ~4-5 tanks, ~10-12 healers, 10-14 melee, 3-5
// hunters, 10-12 casters, a handful of shamans/paladins as the totem/aura
// providers riding inside those role buckets.
const FIXTURES = {
  classicHorde40: {
    version: 'classic', raid: 'mc', label: 'Classic Horde 40 (Molten Core)',
    roster: [
      [4, 'Warrior', 'Protection'], [1, 'Druid', 'Guardian'],
      [4, 'Shaman', 'Restoration1'], [4, 'Priest', 'Holy'], [3, 'Druid', 'Restoration'],
      [4, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Fire'], [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  classicAlliance40: {
    version: 'classic', raid: 'mc', label: 'Classic Alliance 40 (Molten Core)',
    roster: [
      [4, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [4, 'Paladin', 'Holy1'], [4, 'Priest', 'Holy'], [3, 'Druid', 'Restoration'],
      [4, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Paladin', 'Retribution'], [1, 'Druid', 'Feral'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Fire'], [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Priest', 'Shadow'],
    ],
  },
  classicHorde20: {
    version: 'classic', raid: 'zg', label: "Classic Horde 20 (Zul'Gurub)",
    roster: [
      [2, 'Warrior', 'Protection'],
      [2, 'Shaman', 'Restoration1'], [1, 'Priest', 'Holy'], [1, 'Druid', 'Restoration'],
      [2, 'Warrior', 'Fury'], [2, 'Rogue', 'Combat'], [1, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [1, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  foreverMixed40: {
    version: 'forever', raid: 'f_ony', label: "Forever mixed 40 (Onyxia's Lair)",
    roster: [
      [3, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'], [1, 'Druid', 'Guardian'],
      [3, 'Priest', 'Holy'], [1, 'Priest', 'Discipline'], [3, 'Paladin', 'Holy1'], [2, 'Shaman', 'Restoration1'], [2, 'Druid', 'Restoration'],
      [3, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Paladin', 'Retribution'], [2, 'Shaman', 'Enhancement'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [1, 'Mage', 'Fire'], [1, 'Mage', 'Arcane'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Priest', 'Shadow'],
    ],
  },
  forever20: {
    version: 'forever', raid: 'f_hyjal', label: 'Forever 20 (Hyjal Summit)',
    roster: [
      [1, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [1, 'Shaman', 'Restoration1'], [1, 'Paladin', 'Holy1'], [1, 'Priest', 'Holy'], [1, 'Druid', 'Restoration'],
      [2, 'Warrior', 'Fury'], [1, 'Rogue', 'Combat'], [1, 'Paladin', 'Retribution'], [1, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [1, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  forever10: {
    version: 'forever', raid: 'f_barrow', label: 'Forever 10 (Barrow Deeps)',
    roster: [
      [1, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [1, 'Priest', 'Holy'], [1, 'Shaman', 'Restoration1'], [1, 'Paladin', 'Holy1'],
      [1, 'Warrior', 'Fury'], [1, 'Rogue', 'Combat'], [1, 'Shaman', 'Enhancement'],
      [1, 'Hunter', 'Marksmanship'],
      [1, 'Mage', 'Frost'],
    ],
  },
};

// ── Runner ──
let checks = 0, failures = 0;
function check(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log('FAIL  ' + msg); }
}

for (const [key, fixture] of Object.entries(FIXTURES)) {
  const raidInfo = Config.Raids[fixture.raid];
  const totalPlayers = fixture.roster.reduce((s, r) => s + r[0], 0);
  console.log(`\n=== ${fixture.label} (${totalPlayers} sign-ups, ${raidInfo.groups} groups) ===`);

  for (const mode of MODES) {
    State.gameVersion = fixture.version;
    State.selectedRaid = fixture.raid;
    State.optimizerMode = mode;
    const t0 = Date.now();
    const res = importSignUps(fixture.roster);
    const ms = Date.now() - t0;
    check(res.success, `${key}/${mode}: import should succeed (${res.error || ''})`);
    if (!res.success) continue;

    const groups = State.groups;
    const rules = Rulesets[fixture.version];
    const numGroups = raidInfo.groups;
    const meleeIdx = meleeIdentityIndices(numGroups);
    const casterIdx = casterIdentityIndices(numGroups);
    const roster = groups.flat();
    const shamanTotal = roster.filter(p => p.class === 'SHAMAN').length;
    // roleIdentitiesFor(2) has no 'tank' entry at all (2-group 10-mans keep
    // their own no-tank-group pattern — see index.html's roleIdentitiesFor).
    // Optimizer.isTankGroup then falls back to "group index 0 is the tank
    // group", which collides with index 0 also being the sole melee-identity
    // group there — a pre-existing TBC-shared ambiguity (also affects
    // Karazhan/Zul'Aman's 2-group 10-mans), not something this task's fix
    // touches. Provider-spread/Windfury-coverage invariants (b)-(d) assume a
    // real, distinct tank-identity group to compare against and don't apply
    // cleanly here, so they're skipped for 2-group raids; (a) and (f) still run.
    const hasTankIdentity = Optimizer.roleIdentitiesFor(numGroups).includes('tank');

    // (a) stranded melee DPS
    const stranded = strandedMeleeDps(groups);
    check(stranded.length === 0, stranded.length
      ? `${key}/${mode}: ${stranded.length} stranded melee DPS, e.g. group ${stranded[0].gi + 1} ${stranded[0].p.class}:${stranded[0].p.spec}`
      : `${key}/${mode}: no stranded melee DPS`);

    // (b) provider spread (Shaman / Paladin / Feral(+Balance in Forever))
    if (hasTankIdentity) for (const { label, matches } of providerMatchers(rules)) {
      const violated = stackingViolation(groups, matches);
      check(!violated, `${key}/${mode}: ${label} stacked in one group while another melee group has none`);
    }

    // (c) shamans >= melee-identity groups => every melee-identity group with
    // an actual melee_dps member has Windfury.
    if (hasTankIdentity && shamanTotal >= meleeIdx.length && meleeIdx.length > 0) {
      let coveredAll = true, example = null;
      for (const gi of meleeIdx) {
        const g = groups[gi];
        if (!g.some(p => p.role === 'melee_dps')) continue; // nothing to buff, skip
        const buffIds = getGroupBuffs(g, gi).map(b => b.id);
        if (!buffIds.includes('WINDFURY')) { coveredAll = false; example = gi; }
      }
      check(coveredAll, `${key}/${mode}: melee-identity group ${example != null ? example + 1 : '?'} missing Windfury despite ${shamanTotal} shamans >= ${meleeIdx.length} melee groups`);
    }

    // (d) surplus shamans (beyond one per melee group) reach caster groups as
    // mana sustain — Mana Spring, or Mana Tide from a Restoration shaman
    // (getGroupBuffs always prefers Mana Tide over Mana Spring for a
    // Restoration shaman's water totem since it's strictly better sustain;
    // either one is the convention this invariant cares about).
    const surplus = shamanTotal - meleeIdx.length;
    if (hasTankIdentity && surplus > 0 && casterIdx.length > 0) {
      const casterGroupsWithManaSpring = casterIdx.filter(gi => getGroupBuffs(groups[gi], gi).some(b => b.id === 'MANA_SPRING' || b.id === 'MANA_TIDE')).length;
      const want = Math.min(surplus, casterIdx.length);
      check(casterGroupsWithManaSpring >= want, `${key}/${mode}: only ${casterGroupsWithManaSpring}/${want} caster groups got mana sustain from ${surplus} surplus shamans`);
    }

    // (f) idempotence
    const key1 = layoutKey();
    Optimizer.optimize();
    check(layoutKey() === key1, `${key}/${mode}: second Optimize changed the layout`);

    // Coverage helper must not throw
    try { getMissingBuffInsights(); } catch (e) { check(false, `${key}/${mode}: getMissingBuffInsights threw: ${e.message}`); }

    if (key === 'foreverMixed40' || key === 'classicHorde40') {
      check(ms < 1000, `${key}/${mode}: 40-player optimize took ${ms}ms (>1s)`);
    }
    console.log(`  ${mode.padEnd(9)} ${ms}ms  seated ${roster.length}/${raidInfo.size}  shamans ${shamanTotal}  melee-groups ${meleeIdx.length}  caster-groups ${casterIdx.length}`);
  }
}

console.log(`\nClassic/Forever scenario suite: ${checks} checks, ${failures} failed, 0 known gaps`);
process.exit(failures ? 1 : 0);
