/**
 * PartyPlanner Web - rules data tests
 * Run: node tests/planner/rules-data-tests.js [--update]
 *
 * js/rules/catalog.js, tbc.js, classic.js and forever.js are the source of truth for the game rules (design:
 * tasks/reference/rules-data-refactor.md); Rulesets.compile() in js/rules.js turns each version file plus the shared catalog into the
 * ruleset the app reads. These checks guard a hand edit of the data:
 *   - the id snapshot tests/rules-ids-snapshot.json lists the buff and debuff ids per version (saved plans and share links
 *     store them, so a rename or a removal must be deliberate); `--update` rewrites it and prints what changed;
 *   - the compiled rulesets carry every key the app reads, and the data keeps the vocabulary the code relies on (buffType,
 *     scope, debuffType, totem elements, target schools with a pricing predicate, known roles, classes and specs, finite
 *     weights, symmetric exclusiveBuffs, existing references, spell ids, the Classic/Forever aura order, one utilities list
 *     per version, an icon / abbreviation / CSS class in the catalog for every buff and debuff id, known classes and specs
 *     in sourceClass / sourceSpec / preferSpec / tankAnchorOrder);
 *   - the conventions: every version holds exactly the keys of Rulesets.CONVENTIONS (js/rules.js) with the right types,
 *     the tank group's healer counts stay in order (tankGroupHealers and sustainHealers at or below tankGroupHealerMax),
 *     modeConfig holds exactly the four modes, openSlots exactly its five scalars, and the names js/*.js reads as
 *     rules.rules.<name> are that schema plus the structural rules (so a knob can be neither read without being listed
 *     nor listed without being read);
 *   - Rulesets.compile itself, on small synthetic data (matchers, sustain 0, the closed vocabularies, the conventions
 *     schema) and on the real data (pure: nothing shared with its inputs; the id-keyed tables and the rules object stay V8
 *     fast-properties objects, which keeps the optimizer's hot loops fast);
 *   - tools/rules-report.js: all four sections for every version within 160 columns, --json parses, a bad argument exits 2,
 *     and every conventions key has a comment above it.
 * One PASS line per check; exits 1 when a check fails. There is no Classic-vs-Forever comparison on purpose: they are
 * independent games and may drift.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = require('../load-app');

const VERSIONS = ['tbc', 'classic', 'forever'];
// The real module (same realm as this file, so assert.throws and deepStrictEqual compare errors and prototypes fairly).
// Rulesets.compile runs at load, so data it cannot read (an unknown buffType, exclusiveBuffs that do not list each other, ...)
// stops the page's scripts right here: report that as the failure it is, with compile's own message.
let logic;
try {
  logic = app.requireLogic(['State', 'Config', 'GameVersions', 'Rulesets', 'RulesData', 'SCHOOL_CASTERS'], '_pp_rules_data_logic.tmp.js');
} catch (e) {
  console.log(`FAIL  the page's scripts load and Rulesets.compile accepts every data file\n${String(e.message).replace(/^/gm, '      ')}`);
  console.log('\nRules data: 0 checks passed, 1 failed');
  process.exit(1);
}
const { State, Config, GameVersions, Rulesets, RulesData, SCHOOL_CASTERS } = logic;
const { catalog } = RulesData;

const SNAPSHOT_NAME = 'tests/rules-ids-snapshot.json';
const SNAPSHOT_FILE = path.join(app.ROOT, SNAPSHOT_NAME);

const args = process.argv.slice(2);
const update = args.includes('--update');
const unknownFlag = args.find(a => a !== '--update');
if (unknownFlag) {
  console.error(`rules-data-tests: unknown option ${unknownFlag}\nUsage: node tests/planner/rules-data-tests.js [--update]`);
  process.exit(2);
}

// ── The vocabulary the data files and the code agree on (tasks/reference/rules-data-refactor.md) ──
const BUFF_TYPES = ['totem', 'paladinAura', 'warriorShout', 'passive'];
const SCOPES = ['party', 'raid'];
const TOTEM_ELEMENTS = ['air', 'earth', 'water', 'fire'];
// The design doc's debuffType list plus physicalVulnerability (Blood Frenzy, Mangle, Hemorrhage, Expose Weakness, Hunter's
// Mark: the generator named it) and `other`. debuffType is descriptive only.
const DEBUFF_TYPES = ['armor', 'attackPower', 'magicVulnerability', 'physicalVulnerability', 'attackSpeed', 'hitChance',
  'holyVulnerability', 'healOnHit', 'manaOnHit', 'other'];
const SCHOOLS = ['shadow', 'fire', 'frost', 'nature', 'arcane'];
const ROLES = Object.values(catalog.roles);
const CLASSES = catalog.classes;
const specNames = cls => Object.values(catalog.specs[cls]).map(s => s.name);
const SPEC_KEYS = CLASSES.flatMap(cls => specNames(cls).map(name => `${cls}:${name}`));
const MODES = ['max_dps', 'tank_mit', 'balanced', 'relaxed'];
const MODE_WEIGHTS = ['dps', 'mit', 'structure', 'cohesion'];
const OPEN_SLOT_SCALARS = ['utilityBonus', 'specRepeat', 'classCrowd', 'classCrowdFree', 'tankDebuffScale'];
// The sections of a version file that rules.rules holds besides the conventions: structural rules read by the scorer and
// the page, not tuning knobs (tankAnchorOrder is compiled into tankAnchorRank).
const STRUCTURAL_RULES = ['tankAnchorRank', 'specAura', 'spreadProviders', 'exclusiveBuffs', 'healerGroupDps', 'stackPenalty', 'factionLock'];

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

/** Runs `collect(problem)` and fails with every problem it reported, not just the first. */
function noProblems(collect) {
  const problems = [];
  collect(message => problems.push(message));
  if (problems.length) throw new Error(problems.join('\n'));
}
const copy = value => JSON.parse(JSON.stringify(value));
const isFinitePositiveInt = value => Number.isInteger(value) && value > 0;
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const entriesOf = (version, section) => Object.entries(RulesData[version][section] || {});
const compiledOf = version => Rulesets[version];
// Rulesets.CONVENTIONS (js/rules.js) is the closed list of conventions keys: a scalar knob maps to its type name, modeConfig
// and openSlots to nested blocks of numbers. KNOBS is the scalar part: [key, type].
const SCHEMA = Rulesets.CONVENTIONS;
const KNOBS = Object.entries(SCHEMA).filter(([, type]) => typeof type === 'string');
const TYPE_TESTS = { number: isNumber, boolean: value => typeof value === 'boolean', 'number|null': value => value === null || isNumber(value) };
const TYPE_WORDS = { number: 'a finite number', boolean: 'a boolean', 'number|null': 'a finite number or null' };

// ── The id snapshot ─────────────────────────────────────────────
/** Sorted buff and debuff ids of every version, as the data files hold them. */
function currentIds() {
  const ids = {};
  for (const version of VERSIONS) {
    ids[version] = { buffs: Object.keys(RulesData[version].buffs).sort(), debuffs: Object.keys(RulesData[version].debuffs).sort() };
  }
  return ids;
}

/** What differs between a snapshot and the current ids, one line per added or removed id. */
function diffIds(snapshot, current) {
  const lines = [];
  for (const version of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    for (const kind of ['buffs', 'debuffs']) {
      const before = new Set((snapshot[version] || {})[kind] || []);
      const after = new Set((current[version] || {})[kind] || []);
      for (const id of [...after].filter(id => !before.has(id))) lines.push(`${version} ${kind.slice(0, -1)} added: ${id}`);
      for (const id of [...before].filter(id => !after.has(id))) lines.push(`${version} ${kind.slice(0, -1)} removed: ${id}`);
    }
  }
  return lines;
}

/** Stable layout, 2-space indent, the file's own line endings (the platform's for a new file) - like boards-tests.js. */
function serialize(ids, existingText) {
  const eol = existingText === null ? os.EOL : (existingText.includes('\r\n') ? '\r\n' : '\n');
  return (JSON.stringify(ids, null, 2) + '\n').replace(/\n/g, eol);
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return { ids: null, text: null, problem: `${SNAPSHOT_NAME} does not exist` };
  const text = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  try {
    const ids = JSON.parse(text);
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) throw new Error('expected an object keyed by version');
    return { ids, text, problem: null };
  } catch (e) {
    return { ids: null, text, problem: `${SNAPSHOT_NAME} cannot be read: ${e.message}` };
  }
}

let closing = '';
if (update) {
  const snapshot = loadSnapshot();
  const ids = currentIds();
  const changes = snapshot.ids ? diffIds(snapshot.ids, ids) : [];
  const text = serialize(ids, snapshot.text);
  const unchanged = snapshot.text !== null && snapshot.text.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n');
  if (snapshot.problem) console.log(`${snapshot.problem}; a new one is written.`);
  for (const line of changes) console.log(`snapshot: ${line}`);
  if (!unchanged) fs.writeFileSync(SNAPSHOT_FILE, text);
  closing = `${unchanged ? 'Snapshot unchanged' : 'Snapshot written'}: ${SNAPSHOT_NAME}`;
}

// ── Checks: the page and the registry ───────────────────────────
check('index.html loads the four data files, the catalog first, right before js/rules.js', () => {
  assert.deepStrictEqual(app.scripts.slice(1, 6), ['/js/rules/catalog.js', '/js/rules/tbc.js', '/js/rules/classic.js', '/js/rules/forever.js', '/js/rules.js']);
});

check('RulesData holds the shared catalog and one file per version; Rulesets is the registry of versions', () => {
  assert.deepStrictEqual(Object.keys(RulesData).sort(), ['catalog', ...VERSIONS].sort());
  assert.deepStrictEqual(Object.keys(Rulesets), VERSIONS, 'Rulesets lists exactly the versions (compile is not enumerable)');
  assert.equal(typeof Rulesets.compile, 'function');
  assert.equal(Object.keys(GameVersions).join(), VERSIONS.join());
});

// ── Checks: the id snapshot ─────────────────────────────────────
check(`ids: the buff and debuff ids of every version equal ${SNAPSHOT_NAME}`, () => {
  const snapshot = loadSnapshot();
  assert.ok(!snapshot.problem, `${snapshot.problem}; run node tests/planner/rules-data-tests.js --update to create it`);
  const changes = diffIds(snapshot.ids, currentIds());
  assert.deepStrictEqual(changes, [], `ids changed (saved plans and share links store them); if this is deliberate run node tests/planner/rules-data-tests.js --update\n${changes.join('\n')}`);
  return VERSIONS.map(v => `${v} ${snapshot.ids[v].buffs.length}+${snapshot.ids[v].debuffs.length}`).join(', ');
});

check('ids: the snapshot comparison reports an added, a removed and a renamed id', () => {
  const ids = currentIds();
  const edited = copy(ids);
  edited.tbc.buffs.push('NEW_BUFF');
  edited.classic.debuffs = edited.classic.debuffs.filter(id => id !== 'SUNDER_ARMOR');
  edited.forever.buffs = edited.forever.buffs.map(id => (id === 'WINDFURY' ? 'WINDFURY_TOTEM' : id));
  assert.deepStrictEqual(diffIds(ids, edited).sort(), [
    'classic debuff removed: SUNDER_ARMOR', 'forever buff added: WINDFURY_TOTEM', 'forever buff removed: WINDFURY', 'tbc buff added: NEW_BUFF',
  ]);
  assert.deepStrictEqual(diffIds(ids, copy(ids)), []);
});

// ── Checks: the compiled rulesets ───────────────────────────────
check('compile: every version compiles and the ruleset carries every key the app reads', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      const rules = compiledOf(version);
      const where = key => `${version}.${key}`;
      const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      for (const key of ['buffs', 'debuffs', 'specs', 'raidHelperSpecMap', 'specIcons', 'totemElements', 'paladinAuras', 'bestAirTotem',
        'bestPaladinAura', 'rules', 'utilities', 'dpsValue', 'mitValue', 'sustainValue', 'dpsWeight', 'dpsWeightByRole', 'raids',
        'modeConfig', 'openSlots']) {
        if (!isObject(rules[key])) problem(`${where(key)} is not an object`);
      }
      for (const key of ['classList', 'cooldownTotems']) if (!Array.isArray(rules[key])) problem(`${where(key)} is not an array`);
      if (rules.shouts !== undefined && !Array.isArray(rules.shouts)) problem(`${where('shouts')} is not an array`);
      const shoutBuffs = entriesOf(version, 'buffs').filter(([, b]) => b.buffType === 'warriorShout').map(([id]) => id);
      if (JSON.stringify(rules.shouts || []) !== JSON.stringify(shoutBuffs)) problem(`${where('shouts')} is ${JSON.stringify(rules.shouts)}, the warriorShout buffs are ${JSON.stringify(shoutBuffs)}`);
      if (!isObject(rules.rules)) continue;

      if (typeof rules.rules.tankAnchorRank !== 'function') problem(`${where('rules.tankAnchorRank')} is not a function`);
      else if (!isNumber(rules.rules.tankAnchorRank({ class: 'WARRIOR' }))) problem(`${where('rules.tankAnchorRank')} does not return a number for a player`);
      if (!isObject(rules.rules.specAura)) problem(`${where('rules.specAura')} is not an object`);
      for (const [key, type] of KNOBS) {
        if (!(key in rules.rules)) problem(`${where(`rules.${key}`)} is missing from the compiled rules`);
        else if (!TYPE_TESTS[type](rules.rules[key])) problem(`${where(`rules.${key}`)} is not ${TYPE_WORDS[type]}`);
      }
      if ('factionLock' in rules.rules && typeof rules.rules.factionLock !== 'boolean') problem(`${where('rules.factionLock')} is not a boolean`);
      if ('healerGroupDps' in rules.rules && typeof rules.rules.healerGroupDps !== 'function') problem(`${where('rules.healerGroupDps')} is not a function`);
      for (const [i, entry] of (rules.rules.stackPenalty || []).entries()) {
        if (typeof entry.match !== 'function' || !isNumber(entry.weight)) problem(`${where(`rules.stackPenalty[${i}]`)} needs a match function and a numeric weight`);
      }
      for (const [i, entry] of (rules.rules.spreadProviders || []).entries()) {
        if (!CLASSES.includes(entry.class)) problem(`${where(`rules.spreadProviders[${i}]`)} names the unknown class ${entry.class}`);
      }
      for (const [i, set] of (rules.rules.exclusiveBuffs || []).entries()) {
        if (!Array.isArray(set) || set.length < 2) problem(`${where(`rules.exclusiveBuffs[${i}]`)} is not a set of two or more ids`);
      }

      for (const mode of MODES) {
        for (const weight of MODE_WEIGHTS) {
          if (!rules.modeConfig[mode] || !isNumber(rules.modeConfig[mode][weight])) problem(`${where(`modeConfig.${mode}.${weight}`)} is not a finite number`);
        }
      }
      for (const key of OPEN_SLOT_SCALARS) if (!isNumber(rules.openSlots[key])) problem(`${where(`openSlots.${key}`)} is not a finite number`);
      for (const [id, debuff] of Object.entries(rules.debuffs)) {
        if (!debuff.value || !isNumber(debuff.value.tier) || typeof debuff.value.who !== 'string') problem(`${where(`debuffs.${id}.value`)} needs a numeric tier and a who`);
      }
      for (const [id, utility] of Object.entries(rules.utilities)) {
        if (typeof utility.name !== 'string' || typeof utility.desc !== 'string' || !Array.isArray(utility.providers) || !utility.providers.length) problem(`${where(`utilities.${id}`)} needs a name, a desc and providers`);
        for (const provider of utility.providers || []) if (!CLASSES.includes(provider.class)) problem(`${where(`utilities.${id}`)} names the unknown class ${provider.class}`);
      }
      for (const [id, raid] of Object.entries(rules.raids)) {
        if (typeof raid.name !== 'string' || typeof raid.tier !== 'string' || !isFinitePositiveInt(raid.size) || !isFinitePositiveInt(raid.groups)) problem(`${where(`raids.${id}`)} needs a name, a tier, a size and a groups count`);
      }
    }
  });
});

check('buffs: buffType and scope are known; totemElement and cooldownTotem sit only on totems', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const [id, buff] of entriesOf(version, 'buffs')) {
        const where = `${version}.${id}`;
        if (!BUFF_TYPES.includes(buff.buffType)) problem(`${where} has buffType ${JSON.stringify(buff.buffType)}, expected one of ${BUFF_TYPES.join(', ')}`);
        if (!SCOPES.includes(buff.scope)) problem(`${where} has scope ${JSON.stringify(buff.scope)}, expected one of ${SCOPES.join(', ')}`);
        if (buff.buffType === 'totem') {
          if (!TOTEM_ELEMENTS.includes(buff.totemElement)) problem(`${where} is a totem with totemElement ${JSON.stringify(buff.totemElement)}, expected one of ${TOTEM_ELEMENTS.join(', ')}`);
        } else {
          if ('totemElement' in buff) problem(`${where} is not a totem but has a totemElement`);
          if ('cooldownTotem' in buff) problem(`${where} is not a totem but has cooldownTotem`);
        }
        if ('cooldownTotem' in buff && buff.cooldownTotem !== true) problem(`${where} cooldownTotem must be true when present`);
      }
    }
  });
});

check('debuffs: debuffType is known, targetRoles is non-empty, targetSchool only narrows casters', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const [id, debuff] of entriesOf(version, 'debuffs')) {
        const where = `${version}.${id}`;
        if (!DEBUFF_TYPES.includes(debuff.debuffType)) problem(`${where} has debuffType ${JSON.stringify(debuff.debuffType)}, expected one of ${DEBUFF_TYPES.join(', ')}`);
        if (!Array.isArray(debuff.targetRoles) || !debuff.targetRoles.length) problem(`${where} needs a non-empty targetRoles`);
        if ('targetSchool' in debuff) {
          if (!SCHOOLS.includes(debuff.targetSchool)) problem(`${where} has targetSchool ${JSON.stringify(debuff.targetSchool)}, expected one of ${SCHOOLS.join(', ')}`);
          if (JSON.stringify(debuff.targetRoles) !== JSON.stringify(['caster_dps'])) problem(`${where} has a targetSchool but targets ${JSON.stringify(debuff.targetRoles)}; a school narrows casters only`);
        }
      }
    }
  });
});

check('schools: every school a debuff may name has a predicate in SCHOOL_CASTERS (Open-slot pricing), and the code knows no other', () => {
  // OpenSlots._raidValue prices a school debuff for the players SCHOOL_CASTERS[school] picks, and for every DPS when the
  // school has no entry: a documented value without a predicate would be priced wrongly and silently.
  assert.deepStrictEqual(Object.keys(SCHOOL_CASTERS).sort(), [...SCHOOLS].sort(), 'SCHOOL_CASTERS (js/optimizer.js) and the school vocabulary (SCHOOLS here, tasks/reference/rules-data-refactor.md) list different schools');
  noProblems(problem => {
    for (const school of SCHOOLS) {
      if (typeof SCHOOL_CASTERS[school] !== 'function') { problem(`${school} has no predicate in SCHOOL_CASTERS`); continue; }
      if (!SPEC_KEYS.some(key => SCHOOL_CASTERS[school]({ class: key.split(':')[0], spec: key.split(':')[1] }))) problem(`the ${school} predicate matches no class and spec of the catalog`);
    }
    for (const version of VERSIONS) {
      for (const [id, debuff] of entriesOf(version, 'debuffs')) {
        if ('targetSchool' in debuff && typeof SCHOOL_CASTERS[debuff.targetSchool] !== 'function') problem(`${version}.${id} names the school ${JSON.stringify(debuff.targetSchool)}, which has no predicate in SCHOOL_CASTERS`);
      }
    }
  });
});

check('spellId: a positive integer or null, never repeated within a version', () => {
  const nulls = [];
  noProblems(problem => {
    for (const version of VERSIONS) {
      const owner = new Map();
      let missing = 0;
      for (const section of ['buffs', 'debuffs']) {
        for (const [id, entry] of entriesOf(version, section)) {
          const where = `${version}.${section}.${id}`;
          if (!('spellId' in entry)) { problem(`${where} has no spellId (use null when unknown)`); continue; }
          if (entry.spellId === null) { missing++; continue; }
          if (!isFinitePositiveInt(entry.spellId)) { problem(`${where} spellId ${JSON.stringify(entry.spellId)} is neither a positive integer nor null`); continue; }
          if (owner.has(entry.spellId)) problem(`${version}: spellId ${entry.spellId} is used by ${owner.get(entry.spellId)} and ${where}`);
          else owner.set(entry.spellId, where);
        }
      }
      nulls.push(`${version} ${missing} null of ${entriesOf(version, 'buffs').length + entriesOf(version, 'debuffs').length}`);
    }
  });
  return nulls.join(', ');
});

check('references: exclusiveBuffs is symmetric; exclusiveBuffs, competesWith and supersededBy name entries of the same version', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      const buffs = RulesData[version].buffs;
      const debuffs = RulesData[version].debuffs;
      for (const [id, buff] of Object.entries(buffs)) {
        for (const other of buff.exclusiveBuffs || []) {
          if (!buffs[other]) { problem(`${version}.${id}.exclusiveBuffs names ${other}, which is not a buff of ${version}`); continue; }
          if (other === id) problem(`${version}.${id}.exclusiveBuffs lists itself`);
          if (!(buffs[other].exclusiveBuffs || []).includes(id)) problem(`${version}: ${id} lists ${other} in exclusiveBuffs but ${other} does not list ${id}`);
        }
      }
      for (const [id, debuff] of Object.entries(debuffs)) {
        for (const other of debuff.competesWith || []) if (!debuffs[other]) problem(`${version}.${id}.competesWith names ${other}, which is not a debuff of ${version}`);
        if (debuff.supersededBy !== undefined && !debuffs[debuff.supersededBy]) problem(`${version}.${id}.supersededBy names ${debuff.supersededBy}, which is not a debuff of ${version}`);
      }
    }
  });
});

check('roles: every targetRoles entry is a known role', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const section of ['buffs', 'debuffs']) {
        for (const [id, entry] of entriesOf(version, section)) {
          for (const role of entry.targetRoles || []) if (!ROLES.includes(role)) problem(`${version}.${section}.${id}.targetRoles has the unknown role ${JSON.stringify(role)}`);
        }
      }
    }
  });
});

check('weights: every weight.dps key is a CLASS:Spec, class or role, every weight.mitigation key a CLASS:Spec or *; all are finite numbers', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const [id, buff] of entriesOf(version, 'buffs')) {
        const weight = buff.weight || {};
        for (const [key, value] of Object.entries(weight.dps || {})) {
          if (!SPEC_KEYS.includes(key) && !CLASSES.includes(key) && !ROLES.includes(key)) problem(`${version}.${id}.weight.dps has the unknown key ${JSON.stringify(key)}`);
          if (!isNumber(value)) problem(`${version}.${id}.weight.dps.${key} is not a finite number`);
        }
        for (const [key, value] of Object.entries(weight.mitigation || {})) {
          if (key !== '*' && !SPEC_KEYS.includes(key)) problem(`${version}.${id}.weight.mitigation has the unknown key ${JSON.stringify(key)}`);
          if (!isNumber(value)) problem(`${version}.${id}.weight.mitigation.${key} is not a finite number`);
        }
        if ('sustain' in weight && !isNumber(weight.sustain)) problem(`${version}.${id}.weight.sustain is not a finite number`);
        const priorities = typeof buff.priority === 'number' ? [buff.priority] : Object.values(buff.priority || {});
        if (!priorities.length || !priorities.every(isNumber)) problem(`${version}.${id}.priority needs a number or a map of numbers`);
      }
      for (const [id, debuff] of entriesOf(version, 'debuffs')) {
        if (!isNumber(debuff.weight)) problem(`${version}.${id}.weight (the Open-slot tier) is not a finite number`);
      }
    }
  });
});

check('specDpsWeight keys are known CLASS:Spec, roleDpsWeight keys known roles; stackPenalty and conventions are finite numbers', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      const data = RulesData[version];
      for (const [key, value] of Object.entries(data.specDpsWeight || {})) {
        if (!SPEC_KEYS.includes(key)) problem(`${version}.specDpsWeight has the unknown spec ${JSON.stringify(key)}`);
        if (!isNumber(value)) problem(`${version}.specDpsWeight.${key} is not a finite number`);
      }
      for (const [key, value] of Object.entries(data.roleDpsWeight || {})) {
        if (!ROLES.includes(key)) problem(`${version}.roleDpsWeight has the unknown role ${JSON.stringify(key)}`);
        if (!isNumber(value)) problem(`${version}.roleDpsWeight.${key} is not a finite number`);
      }
      for (const [i, entry] of (data.stackPenalty || []).entries()) {
        if (!CLASSES.includes(entry.class) || (entry.spec !== undefined && !specNames(entry.class).includes(entry.spec))) problem(`${version}.stackPenalty[${i}] names an unknown class or spec`);
        if (!isNumber(entry.weight)) problem(`${version}.stackPenalty[${i}].weight is not a finite number`);
      }
      for (const [i, entry] of (data.healerGroupDps || []).entries()) {
        if (!CLASSES.includes(entry.class) || !specNames(entry.class).includes(entry.spec)) problem(`${version}.healerGroupDps[${i}] names an unknown class or spec`);
      }
      for (const [key, value] of Object.entries(data.conventions || {})) {
        if (key === 'modeConfig' || key === 'openSlots') continue;
        const isValid = typeof value === 'boolean' || isNumber(value) || (value === null && SCHEMA[key] === 'number|null');
        if (!isValid) problem(`${version}.conventions.${key} is neither a boolean nor a finite number (null is allowed only where Rulesets.CONVENTIONS says number|null)`);
      }
    }
  });
});

check('bestAirTotem, bestPaladinAura and specAura name existing buffs of the right buffType', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      const data = RulesData[version];
      const needs = (section, key, id, test, what) => {
        const buff = data.buffs[id];
        if (!buff) problem(`${version}.${section}.${key} names ${id}, which is not a buff of ${version}`);
        else if (!test(buff)) problem(`${version}.${section}.${key} names ${id}, which is not ${what}`);
      };
      for (const [role, id] of Object.entries(data.bestAirTotem || {})) {
        if (!ROLES.includes(role)) problem(`${version}.bestAirTotem has the unknown role ${JSON.stringify(role)}`);
        needs('bestAirTotem', role, id, b => b.buffType === 'totem' && b.totemElement === 'air', 'an air totem');
      }
      for (const [role, id] of Object.entries(data.bestPaladinAura || {})) {
        if (!ROLES.includes(role)) problem(`${version}.bestPaladinAura has the unknown role ${JSON.stringify(role)}`);
        needs('bestPaladinAura', role, id, b => b.buffType === 'paladinAura', 'a paladin aura');
      }
      for (const [spec, id] of Object.entries(data.specAura || {})) {
        if (!specNames('PALADIN').includes(spec)) problem(`${version}.specAura has the unknown Paladin spec ${JSON.stringify(spec)}`);
        needs('specAura', spec, id, b => b.buffType === 'paladinAura', 'a paladin aura');
      }
    }
  });
});

check('catalog: every buff id has an icon, an abbreviation and a CSS class; every debuff id an abbreviation and an icon or the documented text fallback', () => {
  // catalog.js documents the fallback for debuffs only ("entries left blank fall back to the text abbreviation"); a buff without
  // an icon, an abbreviation or a CSS class would render as an empty badge.
  const filled = (table, id) => typeof catalog[table][id] === 'string' && catalog[table][id].trim() !== '';
  const buffIds = new Set();
  const debuffIds = new Set();
  const textFallback = new Set();
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const id of Object.keys(RulesData[version].buffs)) {
        buffIds.add(id);
        for (const table of ['buffIcons', 'buffAbbreviations', 'buffCSSClass']) {
          if (!filled(table, id)) problem(`${version}.buffs.${id} has no entry in catalog.${table}`);
        }
      }
      for (const id of Object.keys(RulesData[version].debuffs)) {
        debuffIds.add(id);
        if (!filled('debuffAbbreviations', id)) problem(`${version}.debuffs.${id} has no entry in catalog.debuffAbbreviations`);
        if (!filled('debuffIcons', id)) textFallback.add(id);
      }
    }
  });
  return `${buffIds.size} buff ids, ${debuffIds.size} debuff ids, ${textFallback.size} debuffs show their abbreviation instead of an icon`;
});

check('sourceClass is a known class; sourceSpec and preferSpec are specs of that class', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      for (const section of ['buffs', 'debuffs']) {
        for (const [id, entry] of entriesOf(version, section)) {
          const where = `${version}.${section}.${id}`;
          if (!CLASSES.includes(entry.sourceClass)) { problem(`${where}.sourceClass is ${JSON.stringify(entry.sourceClass)}, which is not a class of the catalog`); continue; }
          for (const field of ['sourceSpec', 'preferSpec']) {
            if (field in entry && !specNames(entry.sourceClass).includes(entry[field])) problem(`${where}.${field} is ${JSON.stringify(entry[field])}, which is not a ${entry.sourceClass} spec (${specNames(entry.sourceClass).join(', ')})`);
          }
        }
      }
    }
  });
});

check('tankAnchorOrder names known classes, each once', () => {
  noProblems(problem => {
    for (const version of VERSIONS) {
      const order = RulesData[version].tankAnchorOrder;
      if (!Array.isArray(order) || !order.length) { problem(`${version}.tankAnchorOrder must be a non-empty list of classes`); continue; }
      for (const cls of order) if (!CLASSES.includes(cls)) problem(`${version}.tankAnchorOrder names ${JSON.stringify(cls)}, which is not a class of the catalog`);
      if (new Set(order).size !== order.length) problem(`${version}.tankAnchorOrder lists a class twice`);
    }
  });
});

check('conventions: every version holds exactly the keys of Rulesets.CONVENTIONS, with the right types (null only where the schema says number|null); tankGroupHealers and sustainHealers stay at or below tankGroupHealerMax', () => {
  // The schema itself: three scalar types, null allowed for one key, the two nested blocks.
  assert.deepStrictEqual([...new Set(KNOBS.map(([, type]) => type))].sort(), ['boolean', 'number', 'number|null'], 'the scalar types of Rulesets.CONVENTIONS');
  assert.deepStrictEqual(KNOBS.filter(([, type]) => type === 'number|null').map(([key]) => key), ['healerCapOverFloor'], 'only healerCapOverFloor may be null');
  assert.deepStrictEqual(Object.keys(SCHEMA).filter(key => typeof SCHEMA[key] !== 'string').sort(), ['modeConfig', 'openSlots'], 'the nested blocks of Rulesets.CONVENTIONS');
  noProblems(problem => {
    for (const version of VERSIONS) {
      const conventions = RulesData[version].conventions;
      if (!conventions || typeof conventions !== 'object') { problem(`${version} has no conventions block`); continue; }
      for (const key of Object.keys(conventions)) if (!(key in SCHEMA)) problem(`${version}.conventions.${key} is not a key of Rulesets.CONVENTIONS (misspelled?)`);
      for (const [key, type] of KNOBS) {
        if (!(key in conventions)) problem(`${version}.conventions.${key} is missing (every version file lists every key)`);
        else if (!TYPE_TESTS[type](conventions[key])) problem(`${version}.conventions.${key} is ${JSON.stringify(conventions[key])}, expected ${TYPE_WORDS[type]}`);
      }
      // The tank group's healer counts are ordered (Optimizer.groupScore): tankGroupHealerMax is where the group is full, the extra-
      // healer pull starts and each further healer costs tankGroupHealerOverflowCost, so neither the core (tankGroupHealers) nor the
      // number of healers counted for weight.sustain (sustainHealers) may lie above it.
      const { tankGroupHealers, sustainHealers, tankGroupHealerMax } = conventions;
      if (isNumber(tankGroupHealers) && isNumber(tankGroupHealerMax) && tankGroupHealers > tankGroupHealerMax) {
        problem(`${version}.conventions.tankGroupHealers is ${tankGroupHealers}, above tankGroupHealerMax ${tankGroupHealerMax}: the core cannot be larger than the group's maximum`);
      }
      if (isNumber(sustainHealers) && isNumber(tankGroupHealerMax) && sustainHealers > tankGroupHealerMax) {
        problem(`${version}.conventions.sustainHealers is ${sustainHealers}, above tankGroupHealerMax ${tankGroupHealerMax}: weight.sustain would count healers the group no longer holds`);
      }
    }
  });
  return `${KNOBS.length} knobs + modeConfig + openSlots in each of ${VERSIONS.length} files`;
});

check('conventions: modeConfig holds exactly the four modes, each with the four weights; openSlots exactly its five scalars (schema, data files and compiled rulesets)', () => {
  const sorted = list => [...list].sort();
  assert.deepStrictEqual(Object.keys(SCHEMA.modeConfig), MODES, 'Rulesets.CONVENTIONS.modeConfig lists the modes');
  for (const mode of MODES) assert.deepStrictEqual(Object.keys(SCHEMA.modeConfig[mode]), MODE_WEIGHTS, `Rulesets.CONVENTIONS.modeConfig.${mode}`);
  assert.deepStrictEqual(Object.keys(SCHEMA.openSlots), OPEN_SLOT_SCALARS, 'Rulesets.CONVENTIONS.openSlots');
  noProblems(problem => {
    for (const version of VERSIONS) {
      const { modeConfig, openSlots } = RulesData[version].conventions;
      if (JSON.stringify(sorted(Object.keys(modeConfig))) !== JSON.stringify(sorted(MODES))) problem(`${version}.conventions.modeConfig holds ${Object.keys(modeConfig).join(', ')}, expected ${MODES.join(', ')}`);
      for (const mode of MODES) {
        const weights = modeConfig[mode] || {};
        if (JSON.stringify(sorted(Object.keys(weights))) !== JSON.stringify(sorted(MODE_WEIGHTS))) problem(`${version}.conventions.modeConfig.${mode} holds ${Object.keys(weights).join(', ')}, expected ${MODE_WEIGHTS.join(', ')}`);
      }
      if (JSON.stringify(sorted(Object.keys(openSlots))) !== JSON.stringify(sorted(OPEN_SLOT_SCALARS))) problem(`${version}.conventions.openSlots holds ${Object.keys(openSlots).join(', ')}, expected ${OPEN_SLOT_SCALARS.join(', ')}`);
      const compiled = compiledOf(version);
      if (JSON.stringify(compiled.modeConfig) !== JSON.stringify(modeConfig)) problem(`${version}: the compiled modeConfig differs from the data file`);
      if (JSON.stringify(compiled.openSlots) !== JSON.stringify(openSlots)) problem(`${version}: the compiled openSlots differ from the data file`);
    }
  });
});

check('code and schema agree: every rules.rules.<name> that js/*.js reads is a conventions key or a structural rule, and every conventions key is read', () => {
  // Reads are found by the form the code uses: `<ruleset>.rules.<name>`, `.rules?.<name>` (rules.rules.x, activeRules().rules.x,
  // ruleset.rules.x). Comments are stripped first, so a comment that mentions a knob does not count as a read.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const sources = new Map();
  for (const file of fs.readdirSync(path.join(app.ROOT, 'js')).filter(name => name.endsWith('.js')).sort()) {
    sources.set(file, stripComments(fs.readFileSync(path.join(app.ROOT, 'js', file), 'utf8')));
  }
  const reads = new Map(); // name -> files that read it
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/\.rules\??\.([A-Za-z_$][\w$]*)/g)) {
      if (!reads.has(match[1])) reads.set(match[1], new Set());
      reads.get(match[1]).add(file);
    }
  }
  noProblems(problem => {
    for (const [name, files] of reads) {
      if (!KNOBS.some(([key]) => key === name) && !STRUCTURAL_RULES.includes(name)) problem(`js/${[...files][0]} reads rules.${name}, which is neither a key of Rulesets.CONVENTIONS nor a structural rule (${STRUCTURAL_RULES.join(', ')})`);
    }
    for (const [key] of KNOBS) if (!reads.has(key)) problem(`Rulesets.CONVENTIONS lists ${key}, but no file in js/ reads rules.${key}`);
    for (const name of STRUCTURAL_RULES) if (!reads.has(name)) problem(`the structural rule ${name} is no longer read anywhere in js/ (drop it from this list)`);
    // The nested blocks are read through the compiled ruleset's modeConfig (cfg.<weight>) and openSlots, not through rules.rules.
    const optimizer = sources.get('optimizer.js') || '';
    if (!/\.modeConfig\b/.test(optimizer)) problem('js/optimizer.js no longer reads the ruleset\'s modeConfig');
    if (!/\.openSlots\b/.test(optimizer)) problem('js/optimizer.js no longer reads the ruleset\'s openSlots');
    for (const weight of MODE_WEIGHTS) if (!new RegExp(`\\bcfg\\.${weight}\\b`).test(optimizer)) problem(`Rulesets.CONVENTIONS lists the mode weight ${weight}, but js/optimizer.js never reads cfg.${weight}`);
    // Each scalar must be named at least twice with the comments gone: once destructured from openSlots and once where it
    // is used, so a use site reverted to a literal fails here even while the destructuring still names the scalar.
    for (const scalar of OPEN_SLOT_SCALARS) {
      const mentions = (optimizer.match(new RegExp(`\\b${scalar}\\b`, 'g')) || []).length;
      if (mentions === 0) problem(`Rulesets.CONVENTIONS lists the Open-slot scalar ${scalar}, but js/optimizer.js never reads it`);
      else if (mentions < 2) problem(`js/optimizer.js names the Open-slot scalar ${scalar} only once (destructured from openSlots but never used)`);
    }
  });
  return `${reads.size} names read across the ${sources.size} files of js/`;
});

check('Classic and Forever paladinAuras keep the key order Devotion, Concentration, Retribution (then Sanctity)', () => {
  const reason = 'the order is behaviour, not style: a paladin keeps the EARLIER aura on a value tie (Optimizer.resolveBuffSources), and the aura picker and the sidebar buff list show them in this order';
  assert.deepStrictEqual(Object.keys(Rulesets.classic.paladinAuras), ['DEVOTION_AURA', 'CONCENTRATION_AURA', 'RETRIBUTION_AURA', 'SANCTITY_AURA'], `classic: ${reason}`);
  assert.deepStrictEqual(Object.keys(Rulesets.forever.paladinAuras), ['DEVOTION_AURA', 'CONCENTRATION_AURA', 'RETRIBUTION_AURA'], `forever: ${reason}`);
});

check('raids: ids are unique across versions, GameVersions lists each version\'s own raids in order, Config.Raids is their merge', () => {
  const all = VERSIONS.flatMap(version => Object.keys(RulesData[version].raids));
  assert.equal(new Set(all).size, all.length, 'a raid id is defined by two versions');
  for (const version of VERSIONS) {
    assert.deepStrictEqual(GameVersions[version].raids, Object.keys(RulesData[version].raids), `GameVersions.${version}.raids`);
    assert.ok(GameVersions[version].raids.includes(GameVersions[version].defaultRaid), `${version}: the default raid ${GameVersions[version].defaultRaid} is one of its raids`);
  }
  assert.deepStrictEqual(Object.keys(Config.Raids), all, 'Config.Raids lists tbc, classic, forever');
  for (const version of VERSIONS) {
    for (const [id, raid] of Object.entries(RulesData[version].raids)) assert.deepStrictEqual(Config.Raids[id], raid, id);
  }
  return `${all.length} raids`;
});

check('utilities: every version owns its list, Config.Utilities reads the active version only (no fallback to another version)', () => {
  const saved = State.gameVersion;
  try {
    for (const version of VERSIONS) {
      assert.ok(Object.keys(RulesData[version].utilities || {}).length, `${version} has no utilities in its data file`);
      State.gameVersion = version;
      assert.equal(Config.Utilities, Rulesets[version].utilities, `${version}: Config.Utilities`);
    }
    assert.notEqual(Rulesets.forever.utilities, Rulesets.classic.utilities, 'Forever has its own object');
    // Take each version's list away in turn: the accessor must answer with an empty list, never with a borrowed one (Forever
    // used to read Classic's through a getter fallback, so editing Classic changed Forever).
    for (const version of VERSIONS) {
      const own = Rulesets[version].utilities;
      Rulesets[version].utilities = undefined;
      try {
        State.gameVersion = version;
        assert.deepStrictEqual(Config.Utilities, {}, `${version}: Config.Utilities without its own list must be empty, it reads another version's list`);
      } finally {
        Rulesets[version].utilities = own;
      }
    }
  } finally {
    State.gameVersion = saved;
  }
});

// ── Checks: Rulesets.compile on synthetic data ──────────────────
/** A minimal valid version: one buff of each slot type, one debuff and a complete conventions block (a copy of TBC's); `edit` changes it before use. */
function synthetic(edit = () => {}) {
  const buff = (extra) => ({
    name: 'Test buff', spellId: null, desc: 'x', scope: 'party', sourceClass: 'SHAMAN', targetRoles: ['melee_dps'], priority: 1, weight: { dps: { melee_dps: 1 } }, ...extra,
  });
  const data = {
    buffs: {
      TOTEM: buff({ buffType: 'totem', totemElement: 'air', weight: { dps: { melee_dps: 1 }, sustain: 0 } }),
      AURA: buff({ buffType: 'paladinAura', sourceClass: 'PALADIN' }),
      SHOUT: buff({ buffType: 'warriorShout', sourceClass: 'WARRIOR' }),
      PASSIVE: buff({ buffType: 'passive', sourceClass: 'DRUID' }),
    },
    debuffs: {
      ARMOR: { name: 'Test debuff', spellId: null, desc: 'x', debuffType: 'armor', sourceClass: 'WARRIOR', targetRoles: ['melee_dps', 'ranged_dps'], weight: 3 },
    },
    healerGroupDps: [{ class: 'WARLOCK', spec: 'Affliction' }, { class: 'PRIEST', spec: 'Shadow' }],
    conventions: copy(RulesData.tbc.conventions),
  };
  edit(data);
  return data;
}

check('compile (synthetic): a two-matcher healerGroupDps matches a player of either spec and no other', () => {
  const { healerGroupDps } = Rulesets.compile(synthetic(), catalog).rules;
  const matching = ['WARLOCK:Affliction', 'PRIEST:Shadow'];
  for (const key of SPEC_KEYS) {
    const [cls, spec] = key.split(':');
    for (const role of [undefined, 'caster_dps', 'healer']) {
      assert.equal(healerGroupDps({ class: cls, spec, role }), matching.includes(key), `${key}${role ? ` as ${role}` : ''}`);
    }
  }
  assert.equal(healerGroupDps({ class: 'WARLOCK', spec: undefined }), false, 'a warlock without a spec');
  assert.equal(healerGroupDps({ class: 'NOCLASS', spec: 'Affliction' }), false, 'an unknown class');
});

check('compile (synthetic): an empty healerGroupDps matches nobody and an empty stackPenalty adds nothing; every version lists both sections', () => {
  // Classic and Forever write the TBC-only sections as [] (an absent section would read the same, but an explicit one is editable).
  const compiled = Rulesets.compile(synthetic(data => { data.healerGroupDps = []; data.stackPenalty = []; }), catalog);
  assert.equal(typeof compiled.rules.healerGroupDps, 'function', 'an empty list still compiles to a matcher');
  for (const key of SPEC_KEYS) {
    const [cls, spec] = key.split(':');
    assert.equal(compiled.rules.healerGroupDps({ class: cls, spec, role: 'caster_dps' }), false, key);
  }
  assert.deepStrictEqual(compiled.rules.stackPenalty, [], 'an empty list compiles to no penalty');
  for (const version of VERSIONS) {
    for (const section of ['healerGroupDps', 'stackPenalty']) assert.ok(Array.isArray(RulesData[version][section]), `${version}.${section} is listed (as [] when the version has none)`);
  }
});

check('compile (synthetic): weight.sustain 0 is kept as 0, not dropped', () => {
  const compiled = Rulesets.compile(synthetic(), catalog);
  assert.ok('TOTEM' in compiled.sustainValue, 'the entry is there');
  assert.strictEqual(compiled.sustainValue.TOTEM, 0);
  assert.ok(!('AURA' in compiled.sustainValue), 'a buff without weight.sustain has no entry');
});

check('compile (synthetic): an unknown buffType, debuffType or scope throws; so does a totem without totemElement', () => {
  const bad = edit => () => Rulesets.compile(synthetic(edit), catalog);
  assert.doesNotThrow(bad(() => {}));
  assert.throws(bad(data => { data.buffs.TOTEM.buffType = 'nonsense'; }), /TOTEM has unknown buffType "nonsense"/);
  assert.throws(bad(data => { delete data.buffs.PASSIVE.buffType; }), /PASSIVE has unknown buffType "undefined"/);
  assert.throws(bad(data => { data.debuffs.ARMOR.debuffType = 'nonsense'; }), /ARMOR has unknown debuffType "nonsense"/);
  assert.throws(bad(data => { data.buffs.AURA.scope = 'galaxy'; }), /AURA has unknown scope "galaxy"/);
  assert.throws(bad(data => { delete data.buffs.AURA.scope; }), /AURA has unknown scope "undefined"/);
  assert.throws(bad(data => { delete data.buffs.TOTEM.totemElement; }), /totem TOTEM has no totemElement/);
  assert.doesNotThrow(bad(data => { data.buffs.AURA.scope = 'raid'; data.debuffs.ARMOR.debuffType = 'other'; }), 'raid and other are in the vocabulary');
});

check('compile (synthetic): derives the slot tables from buffType and refuses data it cannot read faithfully', () => {
  const compiled = Rulesets.compile(synthetic(data => { data.buffs.TOTEM.cooldownTotem = true; }), catalog);
  assert.deepStrictEqual(compiled.totemElements, { TOTEM: 'air' });
  assert.deepStrictEqual(Object.keys(compiled.paladinAuras), ['AURA']);
  assert.deepStrictEqual(compiled.shouts, ['SHOUT']);
  assert.deepStrictEqual(compiled.cooldownTotems, ['TOTEM']);
  assert.deepStrictEqual(compiled.debuffs.ARMOR.value, { tier: 3, who: 'physical' });
  const bad = edit => () => Rulesets.compile(synthetic(edit), catalog);
  assert.throws(bad(data => { data.buffs.TOTEM.weight.dps.NOT_A_KEY = 1; }), /no CLASS:Spec key, class or role/);
  assert.throws(bad(data => { data.debuffs.ARMOR.targetRoles = ['healer']; }), /no group for/);
  assert.throws(bad(data => { data.debuffs.ARMOR.targetRoles = ['tank']; data.debuffs.ARMOR.targetSchool = 'fire'; }), /narrows casters only/);
  assert.throws(bad(data => { delete data.buffs.TOTEM.targetRoles; }), /no targetRoles list/);
  assert.throws(bad(data => { data.buffs.TOTEM.exclusiveBuffs = ['PASSIVE']; }), /do not list each other/);
  assert.throws(() => Rulesets.compile(null, catalog), TypeError);
  assert.throws(() => Rulesets.compile(synthetic()), TypeError);
});

check('compile (synthetic): a misspelled, a missing and a mistyped conventions key each throw, naming the key', () => {
  const bad = edit => () => Rulesets.compile(synthetic(edit), catalog);
  assert.doesNotThrow(bad(() => {}), 'a complete conventions block compiles');
  assert.throws(bad(data => { data.conventions.hunterSpred = data.conventions.hunterSpread; delete data.conventions.hunterSpread; }),
    /conventions\.hunterSpred is not a known key.*conventions\.hunterSpread is missing/, 'a misspelled key shows the unknown name and the missing one');
  assert.throws(bad(data => { data.conventions.nonsense = 1; }), /conventions\.nonsense is not a known key/);
  assert.throws(bad(data => { delete data.conventions.rotationSearch; }), /conventions\.rotationSearch is missing/);
  assert.throws(bad(data => { delete data.conventions.healerCapOverFloor; }), /conventions\.healerCapOverFloor is missing/, 'absent is not the same as null');
  assert.throws(bad(data => { data.conventions.hunterSpread = '2'; }), /conventions\.hunterSpread must be a number, not "2"/);
  assert.throws(bad(data => { data.conventions.hunterSpread = null; }), /conventions\.hunterSpread must be a number, not null/);
  assert.throws(bad(data => { data.conventions.cohesionMatch = NaN; }), /conventions\.cohesionMatch must be a number, not NaN/);
  assert.throws(bad(data => { data.conventions.rotationSearch = 1; }), /conventions\.rotationSearch must be a boolean, not 1/);
  assert.throws(bad(data => { data.conventions.healerCapOverFloor = 'one'; }), /conventions\.healerCapOverFloor must be a number or null, not "one"/);
  assert.doesNotThrow(bad(data => { data.conventions.healerCapOverFloor = null; }), 'null is the no-cap value of healerCapOverFloor');
  assert.throws(bad(data => { delete data.conventions.modeConfig.relaxed; }), /conventions\.modeConfig\.relaxed is missing/);
  assert.throws(bad(data => { data.conventions.modeConfig.max_dps.dps = '1'; }), /conventions\.modeConfig\.max_dps\.dps must be a number, not "1"/);
  assert.throws(bad(data => { data.conventions.modeConfig.max_dps.cohesionn = 1; }), /conventions\.modeConfig\.max_dps\.cohesionn is not a known key/);
  assert.throws(bad(data => { delete data.conventions.openSlots.specRepeat; }), /conventions\.openSlots\.specRepeat is missing/);
  assert.throws(bad(data => { data.conventions.openSlots = 5; }), /conventions\.openSlots must be an object, not 5/);
  assert.throws(bad(data => { delete data.conventions; }), /conventions must be an object, not undefined/, 'compile requires a conventions block');
});

check('compile: the id-keyed tables are V8 fast-properties objects (in dictionary mode Object.entries(Config.Buffs), the optimizer\'s hot loop, runs 2.6x slower)', () => {
  // Rulesets.compile fills these tables with keyed stores (out[id] = ...), which makes V8 turn one into a dictionary-mode
  // object once it passes roughly 16-20 ids, and then re-creates each of them as a fresh object. The Phase 2 switch-over
  // shipped without that and made every Optimize about 1.5x slower with all other checks green. V8 reports an object's mode
  // only to natives syntax, so the flag is switched on for this check alone; a Node that refuses it skips the check.
  const v8 = require('v8');
  const tables = ['buffs', 'debuffs', 'dpsValue', 'mitValue', 'sustainValue', 'totemElements', 'paladinAuras', 'rules'];
  v8.setFlagsFromString('--allow-natives-syntax');
  try {
    let isFast;
    try {
      isFast = new Function('table', 'return %HasFastProperties(table)');
      isFast({});
    } catch (e) {
      return `skipped, this Node cannot report object shapes: ${e.message}`;
    }
    // The real rulesets as the page compiled them at load, and one far bigger than any real version.
    const many = Rulesets.compile(synthetic(data => {
      for (let i = 0; i < 40; i++) {
        const weight = { dps: { melee_dps: 1 }, mitigation: { '*': 1 }, sustain: 1 };
        data.buffs[`TOTEM_${i}`] = { ...data.buffs.TOTEM, weight };
        data.buffs[`AURA_${i}`] = { ...data.buffs.AURA, weight };
        data.debuffs[`DEBUFF_${i}`] = { ...data.debuffs.ARMOR };
      }
    }), catalog);
    const rulesets = [...VERSIONS.map(version => [version, Rulesets[version]]), ['synthetic', many]];
    noProblems(problem => {
      for (const [label, ruleset] of rulesets) {
        for (const table of tables) {
          if (!isFast(ruleset[table])) problem(`${label}.${table} (${Object.keys(ruleset[table]).length} ids) is a dictionary-mode object: Rulesets.compile must re-create it`);
        }
      }
    });
    return `${rulesets.length * tables.length} tables`;
  } finally {
    v8.setFlagsFromString('--no-allow-natives-syntax');
  }
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

// ── Checks: the rules report ────────────────────────────────────
check('tools/rules-report.js prints its four sections for every version within 160 columns, --json parses, a bad argument exits 2', () => {
  const { spawnSync } = require('child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(app.ROOT, 'tools', 'rules-report.js'), ...args], { encoding: 'utf8' });
  const sections = ['(a) Buff by recipient', '(b) Mitigation weight', '(c) Debuffs', '(d) Conventions'];
  noProblems(problem => {
    for (const version of VERSIONS) {
      const text = run(version);
      if (text.status !== 0) { problem(`${version}: exit ${text.status}: ${text.stderr}`); continue; }
      for (const heading of sections) if (!text.stdout.includes(heading)) problem(`${version}: the report has no "${heading}" section`);
      const widest = Math.max(...text.stdout.split('\n').map(line => line.length));
      if (widest > 160) problem(`${version}: a report line is ${widest} columns wide, the limit is 160`);
      let json;
      try { json = JSON.parse(run(version, '--json').stdout); } catch (e) { problem(`${version}: --json is not JSON: ${e.message}`); continue; }
      if (json.version !== version) problem(`${version}: --json reports version ${json.version}`);
      // Every number and flag of `conventions` is listed, each with the first clause of the comment above it in the data file.
      const flat = [];
      const walk = (value, prefix) => { for (const [key, inner] of Object.entries(value)) (inner !== null && typeof inner === 'object' ? walk(inner, `${prefix}${key}.`) : flat.push(`${prefix}${key}`)); };
      walk(RulesData[version].conventions, '');
      if (JSON.stringify(json.conventions.map(row => row.key)) !== JSON.stringify(flat)) problem(`${version}: the report lists ${json.conventions.length} conventions, the data file holds ${flat.length}`);
      for (const row of json.conventions) if (!row.note) problem(`${version}.conventions.${row.key} has no comment above it in js/rules/${version}.js`);
      if (!json.dpsWeights.rows.length || !json.debuffs.length) problem(`${version}: the report is missing its buff rows or debuffs`);
    }
  });
  for (const args of [[], ['nonsense'], ['tbc', '--bogus'], ['tbc', 'classic']]) {
    const bad = run(...args);
    assert.equal(bad.status, 2, `rules-report ${args.join(' ') || '(no argument)'} should exit 2, exited ${bad.status}`);
    assert.match(bad.stderr, /Usage: node tools\/rules-report\.js/);
  }
});

if (closing) console.log(`\n${closing}`);
console.log(`\nRules data: ${passed} checks passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
