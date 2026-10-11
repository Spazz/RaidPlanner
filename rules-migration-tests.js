/**
 * PartyPlanner Web - rules data migration tests
 * Run: node rules-migration-tests.js
 *
 * Phase 1 of the rules data refactor (tasks/rules-data-refactor.md). js/rules/catalog.js, tbc.js, classic.js and
 * forever.js were written from the hand-written tables by tools/generate-rules-data.js; the app still reads those
 * tables. This suite pins that Rulesets.compile(RulesData.<version>, RulesData.catalog) rebuilds the live
 * Rulesets.<version> exactly, so the switch in Phase 2 cannot change behaviour:
 *   - plain data field by field with assert.deepStrictEqual (buffs, debuffs, slot tables, value tables, raids, ...),
 *     including the key order where the app iterates a table;
 *   - the predicate hooks by behaviour (tankAnchorRank on every class, healerGroupDps and every stackPenalty match on
 *     every class/spec pair), and the value tables through the app's own dpsValueFor / mitValueFor / dpsWeightFor and
 *     OpenSlots._raidValue with the compiled ruleset swapped in;
 *   - every catalog section against the Config table it came from;
 *   - compile itself: pure, and sensitive (an edited data copy is reported, not waved through).
 * Known, pinned difference: compile derives paladinAuras from the buffs in buff order, while the old Classic and
 * Forever tables list Concentration Aura before Retribution Aura (see KNOWN_AURA_ORDER_DIFFERENCE).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const VERSIONS = ['tbc', 'classic', 'forever'];
const NAMES = ['State', 'Config', 'GameVersions', 'Rulesets', 'RulesData', 'MODE_CONFIG', 'OpenSlots', 'COOLDOWN_TOTEMS', 'Assignments',
  'dpsValueFor', 'mitValueFor', 'dpsWeightFor'];
// The real module (same realm as this file, so deepStrictEqual compares prototypes fairly). IdealComp lives past the UI
// split, so its comparison runs in a vm context with that chunk appended (see idealcomp-tests.js).
const logic = app.requireLogic(NAMES, '_pp_rules_migration_logic.tmp.js');
const { State, Config, GameVersions, Rulesets, RulesData, MODE_CONFIG, OpenSlots, COOLDOWN_TOTEMS, Assignments, dpsValueFor, mitValueFor, dpsWeightFor } = logic;

// Fields compile adds on top of the live ruleset shape (the data files own raids and the cooldown flag, and the
// conventions carry modeConfig and openSlots); TBC alone also carries blessings. idealComp is compared separately.
const COMPILE_ONLY = ['cooldownTotems', 'modeConfig', 'openSlots', 'raids'];
// The old Classic and Forever paladinAuras tables list Concentration Aura before Retribution Aura, their buffs table the
// other way round. compile derives the aura table from buffType in buff order, so these two versions differ in key order
// (it decides tie-breaks between equally valued auras and the order of the aura picker). Phase 2 must settle it on purpose.
const KNOWN_AURA_ORDER_DIFFERENCE = ['classic', 'forever'];

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`PASS  ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n${String(e.message).replace(/^/gm, '      ')}`);
  }
}

const copy = value => JSON.parse(JSON.stringify(value));

// ── Probes ──────────────────────────────────────────────────────
const classSpecPairs = Object.entries(Rulesets.tbc.specs)
  .flatMap(([cls, specs]) => Object.values(specs).map(s => ({ class: cls, spec: s.name, role: s.role })));
// Every class/spec pair, each with its own role, no role and every other role, plus players the tables never list.
const matcherProbes = [
  ...classSpecPairs.flatMap(p => [p.role, undefined, 'tank', 'healer', 'melee_dps', 'ranged_dps', 'caster_dps'].map(role => ({ class: p.class, spec: p.spec, role }))),
  { class: 'NOCLASS', spec: 'Nospec', role: 'tank' },
  { class: 'SHAMAN', spec: 'Nospec', role: 'melee_dps' },
  { class: 'DRUID', spec: undefined, role: 'healer' },
];
const asPlayer = (p, i) => ({ uid: `probe${i}`, name: `${p.class}-${p.spec}`, ...p });
const probePlayers = classSpecPairs.map(asPlayer);

const sampleRaids = {
  mixed: [['WARRIOR', 'Protection', 'tank'], ['WARRIOR', 'Fury', 'melee_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps'],
    ['MAGE', 'Fire', 'caster_dps'], ['WARLOCK', 'Affliction', 'caster_dps'], ['PRIEST', 'Holy', 'healer'], ['SHAMAN', 'Restoration', 'healer'],
    ['DRUID', 'Feral', 'melee_dps'], ['PALADIN', 'Holy', 'healer']],
  casters: [['MAGE', 'Fire', 'caster_dps'], ['MAGE', 'Frost', 'caster_dps'], ['WARLOCK', 'Destruction', 'caster_dps'], ['PRIEST', 'Shadow', 'caster_dps'],
    ['SHAMAN', 'Elemental', 'caster_dps'], ['DRUID', 'Balance', 'caster_dps'], ['WARRIOR', 'Protection', 'tank'], ['PALADIN', 'Protection', 'tank']],
};
const raidsToPrice = [[], ...Object.values(sampleRaids).map(raid => raid.map(([cls, spec, role], i) => asPlayer({ class: cls, spec, role }, i)))];

/** Runs fn with `ruleset` standing in for Rulesets[version] and the app on that version, then puts everything back. */
function withRuleset(version, ruleset, fn) {
  const original = Rulesets[version];
  const gameVersion = State.gameVersion;
  Rulesets[version] = ruleset;
  State.gameVersion = version;
  try {
    return fn();
  } finally {
    Rulesets[version] = original;
    State.gameVersion = gameVersion;
  }
}

const withoutValue = debuffs => Object.fromEntries(Object.entries(debuffs).map(([id, debuff]) => {
  const { value, ...rest } = debuff;
  return [id, rest];
}));
// exclusiveBuffs sets are disjoint and resolved one by one, so only each set's own order matters (a tie keeps the first).
const sortedSets = sets => sets.map(set => [...set]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

// ── One version: compile against the live ruleset ───────────────
/** Compiles `data` and compares it with the live Rulesets[version]; returns every difference found, not just the first. */
function compareVersion(version, data = RulesData[version], catalog = RulesData.catalog) {
  const live = Rulesets[version];
  const problems = [];
  let assertions = 0;
  const field = (name, fn) => {
    assertions++;
    try {
      fn();
    } catch (e) {
      problems.push(`${version}.${name}: ${String(e.message).split('\n').slice(0, 16).join('\n    ')}`);
    }
  };

  let compiled;
  try {
    compiled = Rulesets.compile(data, catalog);
  } catch (e) {
    return { problems: [`${version}: compile threw ${e.message}`], assertions: 1, compiled: null };
  }

  field('fields', () => {
    const liveFields = Object.keys(live).filter(key => key !== 'idealComp');
    const expectedExtra = [...COMPILE_ONLY, ...(version === 'tbc' ? ['blessings'] : [])].sort();
    assert.deepStrictEqual(liveFields.filter(key => !(key in compiled)), [], 'live fields compile does not produce');
    assert.deepStrictEqual(Object.keys(compiled).filter(key => key !== 'idealComp' && !liveFields.includes(key)).sort(), expectedExtra);
  });

  field('buffs', () => {
    assert.deepStrictEqual(Object.keys(compiled.buffs), Object.keys(live.buffs), 'buff ids or their order');
    assert.deepStrictEqual(compiled.buffs, live.buffs);
  });
  field('debuffs (without value)', () => {
    assert.deepStrictEqual(Object.keys(compiled.debuffs), Object.keys(live.debuffs), 'debuff ids or their order');
    assert.deepStrictEqual(withoutValue(compiled.debuffs), withoutValue(live.debuffs));
  });
  field('debuff Open-slot values', () => {
    for (const [id, debuff] of Object.entries(live.debuffs)) {
      // What OpenSlots._raidValue prices: the entry's own value, else the OpenSlots.DEBUFF_VALUE tier, else tier 2 for every DPS.
      const effective = debuff.value || OpenSlots.DEBUFF_VALUE[id] || { tier: 2, who: 'all' };
      assert.deepStrictEqual(compiled.debuffs[id].value, effective, id);
    }
  });

  field('specs, raidHelperSpecMap, classList, specIcons', () => {
    assert.deepStrictEqual(compiled.specs, live.specs);
    assert.deepStrictEqual(Object.keys(compiled.specs), Object.keys(live.specs));
    assert.deepStrictEqual(compiled.raidHelperSpecMap, live.raidHelperSpecMap);
    assert.deepStrictEqual(compiled.classList, live.classList);
    assert.deepStrictEqual(compiled.specIcons, live.specIcons);
  });

  field('totemElements', () => {
    assert.deepStrictEqual(compiled.totemElements, live.totemElements);
    assert.deepStrictEqual(Object.keys(compiled.totemElements), Object.keys(live.totemElements), 'key order');
  });
  field('paladinAuras', () => {
    assert.deepStrictEqual(compiled.paladinAuras, live.paladinAuras);
    const compiledOrder = Object.keys(compiled.paladinAuras);
    assert.deepStrictEqual(compiledOrder, Object.keys(compiled.buffs).filter(id => compiled.paladinAuras[id]), 'derived in buff order');
    if (KNOWN_AURA_ORDER_DIFFERENCE.includes(version)) {
      assert.notDeepStrictEqual(compiledOrder, Object.keys(live.paladinAuras), 'the known aura order difference is gone: drop the exemption');
    } else {
      assert.deepStrictEqual(compiledOrder, Object.keys(live.paladinAuras), 'key order');
    }
  });
  field('shouts', () => assert.deepStrictEqual(compiled.shouts, live.shouts));
  field('bestAirTotem, bestPaladinAura', () => {
    assert.deepStrictEqual(compiled.bestAirTotem, live.bestAirTotem);
    assert.deepStrictEqual(compiled.bestPaladinAura, live.bestPaladinAura);
  });

  field('rules: fields', () => assert.deepStrictEqual(Object.keys(compiled.rules).sort(), Object.keys(live.rules).sort()));
  field('rules: numbers, flags and tables', () => {
    for (const [key, value] of Object.entries(live.rules)) {
      if (typeof value === 'function' || key === 'stackPenalty' || key === 'exclusiveBuffs') continue;
      assert.deepStrictEqual(compiled.rules[key], value, key);
    }
  });
  field('rules.exclusiveBuffs', () => {
    const liveSets = live.rules.exclusiveBuffs || [];
    const compiledSets = compiled.rules.exclusiveBuffs || [];
    for (const sets of [liveSets, compiledSets]) {
      const members = sets.flat();
      assert.equal(new Set(members).size, members.length, 'sets must be disjoint, or their order would matter');
    }
    assert.deepStrictEqual(sortedSets(compiledSets), sortedSets(liveSets));
  });
  field('rules.tankAnchorRank', () => {
    for (const p of matcherProbes) assert.equal(compiled.rules.tankAnchorRank(p), live.rules.tankAnchorRank(p), `${p.class}:${p.spec}`);
  });
  field('rules.healerGroupDps', () => {
    assert.equal(typeof compiled.rules.healerGroupDps, typeof live.rules.healerGroupDps);
    if (!live.rules.healerGroupDps) return;
    for (const p of matcherProbes) assert.equal(compiled.rules.healerGroupDps(p), live.rules.healerGroupDps(p), `${p.class}:${p.spec}`);
  });
  field('rules.stackPenalty', () => {
    const liveEntries = live.rules.stackPenalty || [];
    const compiledEntries = compiled.rules.stackPenalty || [];
    assert.equal(compiledEntries.length, liveEntries.length, 'entry count');
    liveEntries.forEach((entry, i) => {
      assert.equal(compiledEntries[i].weight, entry.weight, `entry ${i} weight`);
      for (const p of matcherProbes) assert.equal(compiledEntries[i].match(p), entry.match(p), `entry ${i} on ${p.class}:${p.spec}`);
    });
  });

  field('utilities', () => {
    assert.deepStrictEqual(compiled.utilities, live.utilities);
    assert.deepStrictEqual(Object.keys(compiled.utilities || {}), Object.keys(live.utilities || {}), 'checklist order');
  });
  field('dpsValue, mitValue, sustainValue', () => {
    assert.deepStrictEqual(compiled.dpsValue, live.dpsValue);
    assert.deepStrictEqual(compiled.mitValue, live.mitValue);
    assert.deepStrictEqual(compiled.sustainValue, live.sustainValue);
  });
  field('dpsWeight, dpsWeightByRole', () => {
    assert.deepStrictEqual(compiled.dpsWeight, live.dpsWeight);
    assert.deepStrictEqual(compiled.dpsWeightByRole, live.dpsWeightByRole);
  });
  field('cooldownTotems', () => {
    assert.deepStrictEqual(compiled.cooldownTotems, Object.keys(live.totemElements).filter(id => COOLDOWN_TOTEMS.has(id)));
  });
  field('raids', () => {
    const ids = GameVersions[version].raids;
    assert.deepStrictEqual(Object.keys(compiled.raids), ids, 'raid ids or their order');
    for (const id of ids) assert.deepStrictEqual(compiled.raids[id], Config.Raids[id], id);
  });
  field('modeConfig, openSlots', () => {
    assert.deepStrictEqual(compiled.modeConfig, MODE_CONFIG);
    assert.deepStrictEqual(Object.keys(compiled.modeConfig), Object.keys(MODE_CONFIG), 'max_dps first');
    assert.deepStrictEqual(compiled.openSlots, {
      utilityBonus: OpenSlots.UTILITY_BONUS, specRepeat: OpenSlots.SPEC_REPEAT, classCrowd: OpenSlots.CLASS_CROWD, classCrowdFree: OpenSlots.CLASS_CROWD_FREE,
    });
  });

  // The value tables as the app's own functions read them, with the compiled ruleset standing in for the live one.
  field('scoring through dpsValueFor / mitValueFor / dpsWeightFor', () => {
    const ids = Object.keys(live.buffs);
    const score = () => probePlayers.map(p => [dpsWeightFor(p), ...ids.map(id => dpsValueFor(id, p)), ...ids.map(id => mitValueFor(id, p))]);
    assert.deepStrictEqual(withRuleset(version, compiled, score), withRuleset(version, live, score));
  });
  field('Open-slot pricing through OpenSlots._raidValue', () => {
    const hybrid = { ...live, debuffs: compiled.debuffs };
    const price = () => probePlayers.map(candidate => raidsToPrice.map(raid => OpenSlots._raidValue(candidate, raid, 'max_dps')));
    assert.deepStrictEqual(withRuleset(version, hybrid, price), withRuleset(version, live, price));
  });

  return { problems, assertions, compiled };
}

// ── Checks ──────────────────────────────────────────────────────
check('index.html loads the four data files, the catalog first, right before js/rules.js', () => {
  assert.deepStrictEqual(app.scripts.slice(0, 5), ['/js/rules/catalog.js', '/js/rules/tbc.js', '/js/rules/classic.js', '/js/rules/forever.js', '/js/rules.js']);
});

check('RulesData holds the shared catalog and one file per version', () => {
  assert.deepStrictEqual(Object.keys(RulesData).sort(), ['catalog', ...VERSIONS].sort());
  assert.deepStrictEqual(Object.keys(Rulesets), VERSIONS, 'Rulesets is still the plain registry of versions (compile is not enumerable)');
  assert.equal(typeof Rulesets.compile, 'function');
});

check('catalog: every section equals the Config table it came from', () => {
  const { catalog } = RulesData;
  const tbc = Rulesets.tbc;
  const sections = {
    classes: tbc.classList,
    classColors: Config.ClassColors,
    roles: Config.Roles,
    specs: tbc.specs,
    specIcons: tbc.specIcons,
    raidHelperClassMap: Config.RaidHelperClassMap,
    defaultRoleForClass: Config.DefaultRoleForClass,
    raidHelperSpecMap: tbc.raidHelperSpecMap,
    buffIcons: Config.BuffIcons,
    buffAbbreviations: Config.BuffAbbreviations,
    buffCSSClass: Config.BuffCSSClass,
    debuffIcons: Config.DebuffIcons,
    debuffAbbreviations: Config.DebuffAbbreviations,
  };
  assert.deepStrictEqual(Object.keys(catalog), Object.keys(sections), 'catalog sections');
  for (const [name, source] of Object.entries(sections)) {
    assert.deepStrictEqual(catalog[name], source, name);
    assert.deepStrictEqual(Object.keys(catalog[name]), Object.keys(source), `${name} key order`);
  }
  return `${Object.keys(sections).length} sections`;
});

for (const version of VERSIONS) {
  check(`${version}: Rulesets.compile(RulesData.${version}, RulesData.catalog) rebuilds the live Rulesets.${version}`, () => {
    const { problems, assertions } = compareVersion(version);
    if (problems.length) throw new Error(`\n${problems.join('\n')}`);
    return `${assertions} assertions`;
  });
}

check('tbc: the compiled blessings equal the default catalog; Classic and Forever carry none', () => {
  assert.deepStrictEqual(Rulesets.compile(RulesData.tbc, RulesData.catalog).blessings, Assignments.DEFAULT_BLESSINGS);
  for (const version of ['classic', 'forever']) {
    assert.equal(Rulesets.compile(RulesData[version], RulesData.catalog).blessings, undefined, version);
    assert.equal(Rulesets[version].blessings, undefined, `${version}: the live ruleset has none either`);
  }
});

check('tbc: the compiled idealComp builds the compositions IdealComp.build25Man / build10Man build', () => {
  const ctx = app.sandbox(['Rulesets', 'RulesData'], { extraSource: app.slice('const IdealComp = {', '// ── TAB SWITCHING') });
  const { Rulesets: vmRulesets, RulesData: vmData } = ctx.api;
  const compiled = vmRulesets.compile(vmData.tbc, vmData.catalog).idealComp;
  const live = vmRulesets.tbc.idealComp;
  assert.deepStrictEqual(Object.keys(compiled).sort(), Object.keys(live).sort());
  const seats = groups => JSON.parse(JSON.stringify(groups.map(group => group.map(({ uid, ...rest }) => rest))));
  for (const name of Object.keys(live)) {
    const built = compiled[name]();
    assert.deepStrictEqual(seats(built), seats(live[name]()), name);
    const uids = built.flat().map(p => p.uid);
    assert.equal(new Set(uids).size, uids.length, `${name}: uids are unique`);
    assert.notDeepStrictEqual(compiled[name]().flat().map(p => p.uid), uids, `${name}: every call builds fresh players`);
  }
  for (const version of ['classic', 'forever']) {
    assert.equal(vmRulesets.compile(vmData[version], vmData.catalog).idealComp, undefined, `${version}: TBC only for now`);
  }
  return `${Object.keys(live).length} builders`;
});

check('compile is pure: the inputs are unchanged and the result shares nothing with them', () => {
  for (const version of VERSIONS) {
    const snapshot = () => JSON.stringify([RulesData[version], RulesData.catalog]);
    const before = snapshot();
    const first = Rulesets.compile(RulesData[version], RulesData.catalog);
    const second = Rulesets.compile(RulesData[version], RulesData.catalog);
    assert.equal(snapshot(), before, `${version}: compile changed its input`);
    assert.equal(JSON.stringify(first), JSON.stringify(second), `${version}: a second compile differs (functions aside)`);
    const seen = new Set();
    const scribble = value => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      Object.values(value).forEach(scribble);
      if (Array.isArray(value)) value.push('scribble'); else value.scribble = true;
    };
    scribble(first);
    assert.equal(snapshot(), before, `${version}: the compiled ruleset shares objects with the data`);
    assert.equal(JSON.stringify(second).includes('scribble'), false, `${version}: two compiles share objects`);
  }
});

check('compile refuses data it cannot rebuild faithfully', () => {
  const bad = edit => { const data = copy(RulesData.tbc); edit(data); return () => Rulesets.compile(data, RulesData.catalog); };
  assert.throws(bad(data => { data.buffs.WINDFURY.buffType = 'nonsense'; }), /unknown buffType/);
  assert.throws(bad(data => { delete data.buffs.WINDFURY.totemElement; }), /no totemElement/);
  assert.throws(bad(data => { data.buffs.WINDFURY.weight.dps.NOT_A_KEY = 1; }), /no CLASS:Spec key, class or role/);
  assert.throws(bad(data => { data.debuffs.SUNDER_ARMOR.targetRoles = ['healer']; }), /no group for/);
  assert.throws(bad(data => { data.debuffs.IMPROVED_SCORCH.targetRoles = ['tank']; }), /narrows casters only/);
  const forever = copy(RulesData.forever);
  delete forever.buffs.GRACE_OF_AIR.exclusiveBuffs;
  assert.throws(() => Rulesets.compile(forever, RulesData.catalog), /do not list each other/);
  assert.throws(() => Rulesets.compile(null, RulesData.catalog), TypeError);
  assert.throws(() => Rulesets.compile(RulesData.tbc), TypeError);
});

check('the comparison is sensitive: an edited copy of the data is reported', () => {
  const edited = (version, edit) => { const data = copy(RulesData[version]); edit(data); return compareVersion(version, data).problems.join('\n'); };
  assert.match(edited('tbc', data => { data.buffs.WINDFURY.weight.dps['PALADIN:Retribution'] = 13; }), /tbc\.dpsValue/);
  assert.match(edited('tbc', data => { data.buffs.WINDFURY.weight.dps['PALADIN:Retribution'] = 13; }), /scoring through dpsValueFor/);
  assert.match(edited('tbc', data => { data.buffs.WINDFURY.priority = 99; }), /tbc\.buffs/);
  assert.match(edited('tbc', data => { data.tankAnchorOrder = ['WARRIOR', 'PALADIN']; }), /tbc\.rules\.tankAnchorRank/);
  assert.match(edited('tbc', data => { data.stackPenalty[1].spec = 'Elemental'; }), /tbc\.rules\.stackPenalty/);
  assert.match(edited('tbc', data => { data.healerGroupDps[0].spec = 'Destruction'; }), /tbc\.rules\.healerGroupDps/);
  assert.match(edited('tbc', data => { data.debuffs.SUNDER_ARMOR.weight = 5; }), /tbc\.debuff Open-slot values/);
  assert.match(edited('tbc', data => { data.debuffs.SUNDER_ARMOR.weight = 5; }), /Open-slot pricing through OpenSlots\._raidValue/);
  assert.match(edited('tbc', data => { data.raids.bt.size = 40; }), /tbc\.raids/);
  assert.match(edited('tbc', data => { data.conventions.hunterSpread = 3; }), /tbc\.rules: numbers, flags and tables/);
  assert.match(edited('tbc', data => { data.conventions.modeConfig.max_dps.mit = 0.3; }), /tbc\.modeConfig, openSlots/);
  assert.match(edited('forever', data => { delete data.buffs.WINDFURY.exclusiveBuffs; delete data.buffs.GRACE_OF_AIR.exclusiveBuffs; }), /forever\.rules\.exclusiveBuffs/);
  assert.match(edited('forever', data => { data.buffs.GRACE_OF_AIR.exclusiveBuffs = []; }), /compile threw/);
  assert.match(edited('classic', data => { data.buffs.MANA_TIDE.cooldownTotem = false; }), /classic\.cooldownTotems/);
  assert.match(edited('classic', data => { data.buffs = Object.fromEntries(Object.entries(data.buffs).reverse()); }), /classic\.buffs/);
});

console.log(`\nRules migration: ${passed} checks passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
