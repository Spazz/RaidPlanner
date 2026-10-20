/**
 * Raidsmith Web - rules data generator (one-off, GUARDED: it refuses to run)
 * Run: node tools/generate-rules-data.js   (throws at once, see the guard below)
 *
 * RECORD OF THE MAPPING, NOT A TOOL. This script wrote the data files on 2026-10-11 (Phase 1 of
 * tasks/reference/rules-data-refactor.md; its last run was at the start of Phase 2, before any hand edit, and left idealComp and
 * blessings out because they stay in code). It wrote js/rules/catalog.js, js/rules/tbc.js, js/rules/classic.js and js/rules/forever.js from the LIVE hand-written tables
 * (Config and Rulesets.tbc/classic/forever in js/rules.js, the optimizer's DPS_VALUE/MIT_VALUE/SUSTAIN_VALUE/DPS_WEIGHT*
 * tables, MODE_CONFIG, COOLDOWN_TOTEMS and the OpenSlots block), in the vocabulary of tasks/reference/rules-data-refactor.md. Since
 * Phase 2 those tables are gone from js/ and the data files are the source of truth, edited by hand: re-running the
 * generator would overwrite hand-written comments and spellIds, and the code below could not even find its inputs any
 * more. It is kept as documentation of how each field of the data files was derived from the old tables.
 *
 * Hand edits after the final run (all in the data files): Forever got its own copy of Classic's utilities list (it had
 * borrowed it through a getter fallback); the CONCENTRATION_AURA and RETRIBUTION_AURA entries of Classic and Forever were
 * swapped so the compiled paladinAuras keep today's order; spellId was filled from tasks/reference/research-spell-ids.md; the
 * comment blocks that explained the old tables moved next to the entries and sections they describe.
 *
 * When it ran, the page was loaded through tests/load-app.js WITHOUT its js/rules/*.js tags, so the output depended on
 * the old tables alone and a second run was byte for byte the same (files were rewritten only when their content changed).
 *
 * Mapping, per buff id (source: Rulesets[v].buffs[id] + totemElements/paladinAuras/shouts + the optimizer tables):
 *   name, desc copied; spellId null; scope 'party'
 *   buffType     'totem' (id in totemElements) | 'paladinAura' (in paladinAuras) | 'warriorShout' (in shouts) | 'passive'
 *   totemElement from totemElements; cooldownTotem true for ids in COOLDOWN_TOTEMS
 *   sourceClass, sourceSpec, preferSpec copied when present; targetRoles = benefitsRoles; priority copied
 *   weight       { dps: DPS_VALUE entry flattened (key + class + role maps merged into one), mitigation: MIT_VALUE entry,
 *                  sustain: SUSTAIN_VALUE number }, only the parts that exist
 *   exclusiveBuffs on BOTH members of each rules.exclusiveBuffs set (the other ids of the set)
 * Per debuff id:
 *   name, desc, sourceClass, sourceSpec, competesWith, supersededBy copied; spellId null
 *   debuffType   chosen by name (DEBUFF_TYPE_BY_NAME); 'other' when the name is not listed
 *   targetRoles, targetSchool, weight   from the Open-slot value (the entry's own `value`, else OpenSlots.DEBUFF_VALUE):
 *                'physical' -> melee_dps + ranged_dps, 'ranged' -> ranged_dps, 'caster' -> caster_dps, 'tank' -> tank,
 *                a school -> caster_dps + targetSchool, unlisted -> all DPS roles; weight = tier (unlisted: 2)
 * Version sections: specDpsWeight / roleDpsWeight (DPS_WEIGHT* tables), bestAirTotem, bestPaladinAura, specAura,
 *   spreadProviders, factionLock, tankAnchorOrder (tankAnchorRank applied to each class, then sorted),
 *   stackPenalty [{ class, spec?, weight }] and healerGroupDps [{ class, spec }] (each predicate tested against every
 *   class/spec of Config.Specs), conventions (every other number/flag of rules.rules + modeConfig + openSlots), raids,
 *   utilities (TBC and Classic; Forever borrowed Classic's list through a getter fallback and got its own copy by hand
 *   afterwards). idealComp and blessings are NOT written: the Ideal-comp builders (js/app.js) and the blessing catalog
 *   (Assignments.DEFAULT_BLESSINGS in js/analysis.js) stay in code for every version.
 * Shared catalog: classes, colours, roles, specs, spec icons, Raid-Helper maps, default roles, buff/debuff icons,
 *   abbreviations and CSS classes, unchanged.
 */
'use strict';

// The guard: nothing below this throw runs.
throw new Error(
  'tools/generate-rules-data.js ran once on 2026-10-11; js/rules/*.js are the source of truth. '
  + 'Re-running it would overwrite hand-written comments and spellIds.',
);

const fs = require('fs');
const path = require('path');
const app = require('../tests/load-app');

const GENERATED_ON = '2026-10-11';
const OUT_DIR = path.join(app.ROOT, 'js', 'rules');
const VERSIONS = ['tbc', 'classic', 'forever'];
const INDENT = '  ';
const MAX_WIDTH = 120;
const DATA_SCRIPT_TAGS = /<script src="\/js\/rules\/[^"]+"><\/script>\r?\n?/g;

const UNLISTED_CLASS = '<unlisted class>';
const UNLISTED_SPEC = '<unlisted spec>';
const PROBE_ROLES = [undefined, 'tank', 'healer', 'melee_dps', 'ranged_dps', 'caster_dps'];

const BUFF_KEYS = ['name', 'sourceClass', 'sourceSpec', 'preferSpec', 'benefitsRoles', 'priority', 'desc'];
const DEBUFF_KEYS = ['name', 'sourceClass', 'sourceSpec', 'desc', 'competesWith', 'supersededBy', 'value'];
const RAID_KEYS = ['name', 'size', 'groups', 'tier'];
const DPS_VALUE_PARTS = ['key', 'class', 'role'];
// rules.* keys with their own section; every other key must be a number or a flag and goes into `conventions`.
const STRUCTURAL_RULE_KEYS = ['tankAnchorRank', 'healerGroupDps', 'stackPenalty', 'specAura', 'spreadProviders', 'factionLock', 'exclusiveBuffs'];

// debuffType by display name (the design doc's list plus physicalVulnerability); a name missing here becomes 'other'.
const DEBUFF_TYPE_BY_NAME = {
  'Sunder Armor': 'armor', 'Expose Armor': 'armor', 'Faerie Fire': 'armor', 'Faerie Fire (Feral)': 'armor',
  'Curse of Recklessness': 'armor',
  'Demoralizing Shout': 'attackPower', 'Demoralizing Roar': 'attackPower', 'Curse of Weakness': 'attackPower',
  'Curse of the Elements': 'magicVulnerability', 'Shadow Weaving': 'magicVulnerability',
  'Improved Shadow Bolt': 'magicVulnerability', 'Improved Scorch': 'magicVulnerability',
  "Winter's Chill": 'magicVulnerability', 'Misery': 'magicVulnerability', 'Stormstrike': 'magicVulnerability',
  'Shadow Embrace': 'magicVulnerability',
  'Thunder Clap': 'attackSpeed',
  'Insect Swarm': 'hitChance', 'Scorpid Sting': 'hitChance',
  'Judgement of the Crusader': 'holyVulnerability',
  'Judgement of Light': 'healOnHit',
  'Judgement of Wisdom': 'manaOnHit',
  'Blood Frenzy': 'physicalVulnerability', 'Mangle': 'physicalVulnerability', 'Hemorrhage': 'physicalVulnerability',
  'Expose Weakness': 'physicalVulnerability', "Hunter's Mark": 'physicalVulnerability',
};

// The Open-slot `who` of a debuff -> the roles it helps.
const ROLES_BY_WHO = {
  physical: ['melee_dps', 'ranged_dps'], ranged: ['ranged_dps'], caster: ['caster_dps'], tank: ['tank'],
  all: ['melee_dps', 'ranged_dps', 'caster_dps'],
};
const DEBUFF_SCHOOLS = ['shadow', 'fire', 'frost', 'nature', 'arcane'];

const MECHANICS_IN_CODE = 'Mechanics that stay in code (their numbers live in `conventions`, their logic does not move): '
  + 'Ferocious Inspiration stacking per BM hunter, the Enhancement Windfury bonus, the Windfury-coverage cost, drums, '
  + 'Bloodlust (raid-wide, never a placement factor), the isolation constraint, hunter spreading with 2+ Enh, the '
  + 'healer cap, Open-slot choose() pricing. Also in code, not in these files: the Ideal-comp builders (js/app.js, '
  + 'faction-aware per version) and the blessing catalog (js/analysis.js, Assignments.DEFAULT_BLESSINGS).';

const clone = value => JSON.parse(JSON.stringify(value));
const isContainer = value => value !== null && typeof value === 'object';
function fail(message) { throw new Error(`generate-rules-data: ${message}`); }

// ── Live tables ─────────────────────────────────────────────────
/** The hand-written tables, from the page loaded without its data files (so a previous run can never feed this one). */
function loadLiveTables() {
  const page = app.fromHtml(app.html.replace(DATA_SCRIPT_TAGS, ''));
  const names = ['Config', 'GameVersions', 'Rulesets', 'MODE_CONFIG', 'OpenSlots', 'COOLDOWN_TOTEMS'];
  return page.sandbox(names).api;
}

function assertKnownKeys(label, entry, allowed) {
  const unknown = Object.keys(entry).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${label} has fields the data model has no place for: ${unknown.join(', ')}`);
}

// ── Buffs ───────────────────────────────────────────────────────
/** DPS_VALUE entry { key, class, role } -> one map: 'CLASS:Spec' keys, bare class names and role names side by side. */
function flattenDpsValue(label, entry) {
  assertKnownKeys(`${label} dpsValue`, entry, DPS_VALUE_PARTS);
  if (!entry.role) fail(`${label} dpsValue has no role map; Rulesets.compile always rebuilds one`);
  const flat = {};
  for (const part of DPS_VALUE_PARTS) {
    const names = Object.keys(entry[part] || {});
    if (entry[part] && !names.length && part !== 'role') fail(`${label} dpsValue.${part} is an empty map; it would not round-trip`);
    for (const name of names) {
      if (name in flat) fail(`${label} dpsValue lists "${name}" twice`);
      if (typeof entry[part][name] !== 'number') fail(`${label} dpsValue.${part}.${name} is not a number`);
      flat[name] = entry[part][name];
    }
  }
  return flat;
}

function buildWeight(version, id, rules) {
  const label = `${version}.${id}`;
  const weight = {};
  if (rules.dpsValue[id]) weight.dps = flattenDpsValue(label, rules.dpsValue[id]);
  if (rules.mitValue[id]) weight.mitigation = clone(rules.mitValue[id]);
  if (rules.sustainValue[id] !== undefined) weight.sustain = rules.sustainValue[id];
  return Object.keys(weight).length ? weight : null;
}

/** Each exclusive set becomes a list on every member: the other ids, in the set's order. */
function exclusiveBuffsByMember(version, rules) {
  const buffIds = Object.keys(rules.buffs);
  const byMember = {};
  for (const set of rules.rules.exclusiveBuffs || []) {
    for (const id of set) {
      if (!rules.buffs[id]) fail(`${version}: exclusive set [${set}] names ${id}, which is not a buff`);
      if (byMember[id]) fail(`${version}: ${id} is in two exclusive sets; the lists could not be told apart`);
      byMember[id] = set.filter(other => other !== id);
    }
    // Rulesets.compile rebuilds a set as [first member in buff order, ...its list]; ties pick the first member of the set.
    const first = buffIds.find(id => set.includes(id));
    if (first !== set[0]) fail(`${version}: exclusive set [${set}] lists ${set[0]} first but ${first} comes first in the buffs`);
  }
  return byMember;
}

function buildBuffs(version, rules, tables) {
  const shouts = rules.shouts || [];
  const exclusive = exclusiveBuffsByMember(version, rules);
  const buffs = {};
  for (const [id, buff] of Object.entries(rules.buffs)) {
    const label = `${version}.${id}`;
    assertKnownKeys(label, buff, BUFF_KEYS);
    const element = rules.totemElements[id];
    const slots = [element && 'totem', rules.paladinAuras[id] && 'paladinAura', shouts.includes(id) && 'warriorShout'].filter(Boolean);
    if (slots.length > 1) fail(`${label} sits in more than one slot table (${slots.join(', ')})`);
    if (tables.COOLDOWN_TOTEMS.has(id) && !element) fail(`${label} is a cooldown totem without a totem element`);

    const entry = { name: buff.name, spellId: null, desc: buff.desc, buffType: slots[0] || 'passive' };
    if (element) entry.totemElement = element;
    if (tables.COOLDOWN_TOTEMS.has(id)) entry.cooldownTotem = true;
    entry.scope = 'party';
    entry.sourceClass = buff.sourceClass;
    if (buff.sourceSpec) entry.sourceSpec = buff.sourceSpec;
    if (buff.preferSpec) entry.preferSpec = buff.preferSpec;
    entry.targetRoles = [...buff.benefitsRoles];
    entry.priority = clone(buff.priority);
    const weight = buildWeight(version, id, rules);
    if (weight) entry.weight = weight;
    if (exclusive[id]) entry.exclusiveBuffs = exclusive[id];
    buffs[id] = entry;
  }
  for (const table of ['dpsValue', 'mitValue', 'sustainValue']) {
    const orphans = Object.keys(rules[table]).filter(id => !rules.buffs[id]);
    if (orphans.length) fail(`${version}.${table} has ids that are not buffs of the version: ${orphans.join(', ')}`);
  }
  return buffs;
}

// ── Debuffs ─────────────────────────────────────────────────────
function debuffTarget(label, { tier, who }) {
  if (ROLES_BY_WHO[who]) return { targetRoles: [...ROLES_BY_WHO[who]], weight: tier };
  if (DEBUFF_SCHOOLS.includes(who)) return { targetRoles: ['caster_dps'], targetSchool: who, weight: tier };
  return fail(`${label}: unknown Open-slot target "${who}"`);
}

function buildDebuffs(version, rules, tables, report) {
  const debuffs = {};
  for (const [id, debuff] of Object.entries(rules.debuffs)) {
    const label = `${version}.${id}`;
    assertKnownKeys(label, debuff, DEBUFF_KEYS);
    const listed = debuff.value || tables.OpenSlots.DEBUFF_VALUE[id];
    if (!listed) report.defaultWeight.push(`${label} (${debuff.name})`);
    const target = debuffTarget(label, listed || { tier: 2, who: 'all' });
    const debuffType = DEBUFF_TYPE_BY_NAME[debuff.name];
    if (!debuffType) report.otherType.push(`${label} (${debuff.name})`);

    const entry = { name: debuff.name, spellId: null, desc: debuff.desc, debuffType: debuffType || 'other', sourceClass: debuff.sourceClass };
    if (debuff.sourceSpec) entry.sourceSpec = debuff.sourceSpec;
    entry.targetRoles = target.targetRoles;
    if (target.targetSchool) entry.targetSchool = target.targetSchool;
    entry.weight = target.weight;
    if (debuff.competesWith) entry.competesWith = [...debuff.competesWith];
    if (debuff.supersededBy) entry.supersededBy = debuff.supersededBy;
    debuffs[id] = entry;
  }
  return debuffs;
}

// ── Rules: predicates become data ───────────────────────────────
function probePlayers(specsByClass) {
  const players = [];
  for (const [cls, specs] of Object.entries(specsByClass)) {
    for (const spec of Object.values(specs)) players.push({ class: cls, spec: spec.name });
  }
  return players;
}

/** A predicate's answer for a player, or null when it changes with the player's role (data cannot express that). */
function answer(predicate, player) {
  const answers = new Set(PROBE_ROLES.map(role => !!predicate({ ...player, role })));
  return answers.size === 1 ? [...answers][0] : null;
}

/**
 * Which players does `predicate` accept? { classes: [whole classes], pairs: [{ class, spec }] }, or { problem } when the
 * predicate cannot be written as class/spec matchers (it looks at the role, accepts unlisted classes or specs only in
 * part, ...).
 */
function deriveMatches(label, predicate, specsByClass) {
  if (answer(predicate, { class: UNLISTED_CLASS, spec: UNLISTED_SPEC }) !== false) return { problem: `${label}: accepts a player of an unlisted class, or depends on the role` };
  const matches = { classes: [], pairs: [] };
  for (const [cls, specs] of Object.entries(specsByClass)) {
    const names = Object.values(specs).map(spec => spec.name);
    const answers = names.map(spec => answer(predicate, { class: cls, spec }));
    const unlistedSpec = answer(predicate, { class: cls, spec: UNLISTED_SPEC });
    if (answers.includes(null) || unlistedSpec === null) return { problem: `${label}: the answer for ${cls} depends on the role` };
    const accepted = names.filter((_, i) => answers[i]);
    if (accepted.length === names.length && unlistedSpec) matches.classes.push(cls);
    else if (unlistedSpec) return { problem: `${label}: accepts a ${cls} of an unlisted spec but not every listed spec` };
    else accepted.forEach(spec => matches.pairs.push({ class: cls, spec }));
  }
  if (!matches.classes.length && !matches.pairs.length) return { problem: `${label}: accepts no player at all` };
  return matches;
}

function deriveStackPenalty(version, rules, specsByClass, report) {
  const entries = [];
  (rules.rules.stackPenalty || []).forEach(({ match, weight }, index) => {
    const label = `${version}.rules.stackPenalty[${index}]`;
    const matches = deriveMatches(label, match, specsByClass);
    const count = matches.problem ? 0 : matches.classes.length + matches.pairs.length;
    if (matches.problem || count !== 1) {
      report.inexpressible.push(matches.problem || `${label}: accepts ${count} class/spec groups, an entry holds one`);
      return;
    }
    entries.push(matches.classes.length ? { class: matches.classes[0], weight } : { class: matches.pairs[0].class, spec: matches.pairs[0].spec, weight });
  });
  return entries;
}

function deriveHealerGroupDps(version, rules, specsByClass, report) {
  const label = `${version}.rules.healerGroupDps`;
  const matches = deriveMatches(label, rules.rules.healerGroupDps, specsByClass);
  if (matches.problem || matches.classes.length) {
    report.inexpressible.push(matches.problem || `${label}: accepts every spec of ${matches.classes.join(', ')}; the list holds { class, spec } pairs`);
    return [];
  }
  return matches.pairs;
}

/** tankAnchorRank(p) -> the classes that rank ahead of every other class, best first. */
function deriveTankAnchorOrder(version, rules, specsByClass) {
  const label = `${version}.rules.tankAnchorRank`;
  const rank = rules.rules.tankAnchorRank;
  const unlisted = rank({ class: UNLISTED_CLASS });
  const ranked = [];
  for (const cls of Object.keys(specsByClass)) {
    for (const player of [{ class: cls }, ...probePlayers({ [cls]: specsByClass[cls] }).flatMap(p => PROBE_ROLES.map(role => ({ ...p, role })))]) {
      if (rank(player) !== rank({ class: cls })) fail(`${label} ranks ${cls} differently by spec or role`);
    }
    if (rank({ class: cls }) !== unlisted) ranked.push({ cls, rank: rank({ class: cls }) });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  ranked.forEach((entry, index) => { if (entry.rank !== index) fail(`${label}: the ranks ${ranked.map(e => e.rank)} are not 0..n-1`); });
  if (unlisted !== ranked.length) fail(`${label}: unlisted classes rank ${unlisted}, expected ${ranked.length}`);
  return ranked.map(entry => entry.cls);
}

function buildConventions(version, rules, tables) {
  const conventions = {};
  for (const [key, value] of Object.entries(rules.rules)) {
    if (STRUCTURAL_RULE_KEYS.includes(key)) continue;
    if (typeof value !== 'number' && typeof value !== 'boolean') fail(`${version}.rules.${key} is a ${typeof value}; conventions hold numbers and flags`);
    conventions[key] = value;
  }
  conventions.modeConfig = clone(tables.MODE_CONFIG);
  const slots = tables.OpenSlots;
  conventions.openSlots = { utilityBonus: slots.UTILITY_BONUS, specRepeat: slots.SPEC_REPEAT, classCrowd: slots.CLASS_CROWD, classCrowdFree: slots.CLASS_CROWD_FREE };
  return conventions;
}

function buildRaids(version, tables) {
  const raids = {};
  for (const id of tables.GameVersions[version].raids) {
    const raid = tables.Config.Raids[id];
    if (!raid) fail(`${version}: raid ${id} is not in Config.Raids`);
    assertKnownKeys(`${version}.raids.${id}`, raid, RAID_KEYS);
    raids[id] = clone(raid);
  }
  return raids;
}

/** Classic and Forever reuse the TBC class/spec tables; the catalog holds them once, so they must really be the same. */
function assertSharedWithTbc(version, rules, tbc) {
  for (const key of ['specs', 'raidHelperSpecMap', 'classList', 'specIcons']) {
    if (JSON.stringify(rules[key]) !== JSON.stringify(tbc[key])) fail(`${version}.${key} differs from TBC's, so it cannot come from the shared catalog`);
  }
}

/** Compile derives these three tables from buffType, in buff order; note where the old tables listed them differently. */
function noteOrderDifferences(version, rules, report) {
  const derived = {
    totemElements: Object.keys(rules.buffs).filter(id => rules.totemElements[id]),
    paladinAuras: Object.keys(rules.buffs).filter(id => rules.paladinAuras[id]),
    shouts: Object.keys(rules.buffs).filter(id => (rules.shouts || []).includes(id)),
  };
  for (const [table, ids] of Object.entries(derived)) {
    const old = table === 'shouts' ? rules.shouts || [] : Object.keys(rules[table]);
    if (old.join() !== ids.join()) report.orderDifferences.push(`${version}.${table}: old order [${old}] vs buff order [${ids}]`);
  }
}

// ── Text output ─────────────────────────────────────────────────
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INTEGER_KEY = /^(?:0|[1-9][0-9]*)$/;

// Written with String.fromCharCode so this file holds no literal line-separator character (editors and tools mangle those).
const LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
function quote(text) {
  const escaped = text.replace(/[\\']/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
    .replace(LINE_SEPARATORS, ch => String.fromCharCode(92) + 'u' + ch.charCodeAt(0).toString(16));
  return `'${escaped}'`;
}
const keyLiteral = key => (IDENTIFIER.test(key) || INTEGER_KEY.test(key) ? key : quote(key));

function scalarLiteral(value, decimals) {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return decimals && Number.isInteger(value) ? value.toFixed(1) : String(value);
  return fail(`cannot write a ${typeof value} (${String(value)})`);
}

function inline(value, path, decimals) {
  if (Array.isArray(value)) return value.length ? `[${value.map(item => inline(item, [...path, '[]'], decimals)).join(', ')}]` : '[]';
  if (isContainer(value)) {
    const entries = Object.entries(value);
    return entries.length ? `{ ${entries.map(([key, item]) => `${keyLiteral(key)}: ${inline(item, [...path, key], decimals)}`).join(', ')} }` : '{}';
  }
  return scalarLiteral(value, decimals(path));
}

/**
 * One value as text. In the first `expand` levels (counted from this value) a map with two or more entries, and a list
 * holding maps or lists, gets one entry per line; below that, and for everything else, a map or list stays on one line
 * when it fits MAX_WIDTH. `decimals(path)` prints whole numbers as 1.0 where the table is a float scale.
 */
function block(value, depth, prefixWidth, expand, path, decimals) {
  const compact = inline(value, path, decimals);
  if (!isContainer(value) || !Object.keys(value).length) return compact;
  const nested = Object.values(value).some(isContainer);
  const fits = depth * INDENT.length + prefixWidth + compact.length + 1 <= MAX_WIDTH;
  const forced = expand > 0 && (nested || (!Array.isArray(value) && Object.keys(value).length > 1));
  if (fits && !forced) return compact;
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    return `[\n${value.map(item => `${pad}${block(item, depth + 1, 0, expand - 1, [...path, '[]'], decimals)},`).join('\n')}\n${close}]`;
  }
  const rows = Object.entries(value).map(([key, item]) => {
    const prefix = `${keyLiteral(key)}: `;
    return `${pad}${prefix}${block(item, depth + 1, prefix.length, expand - 1, [...path, key], decimals)},`;
  });
  return `{\n${rows.join('\n')}\n${close}}`;
}

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
const commentLines = (text, indent) => wrap(text, MAX_WIDTH - indent.length - 3).map(line => `${indent}// ${line}`);

function headerComment({ title, summary, research }) {
  const paragraphs = [
    summary,
    'Source of truth: this file IS the source of truth for these rules and is edited by hand. It was generated once on '
      + GENERATED_ON + ' from the then-live tables by tools/generate-rules-data.js (now a guarded record of the mapping, which '
      + "refuses to run). Rulesets.compile() in js/rules.js turns it into the app's tables at load. Ids never change: saved plans "
      + 'and share links store them, and rules-data-tests.js pins them. Every number is explained: see README.md, Editing the rules. '
      + 'Design and vocabulary: tasks/reference/rules-data-refactor.md.',
    `Research behind the numbers: ${research}`,
    MECHANICS_IN_CODE,
  ];
  const rule = '='.repeat(64);
  const body = paragraphs.flatMap((text, i) => [...(i ? [''] : []), ...wrap(text, 106)]).map(line => (line ? `   ${line}` : ''));
  return ['/* ' + rule, `   RAIDSMITH WEB - rules data: ${title}`, '   ' + '-'.repeat(64), ...body, '   ' + rule + ' */'].join('\n');
}

/** A whole data file: header, the RulesData namespace line, then `RulesData.<name> = { sections };`. */
function renderDataFile({ name, header, sections }) {
  const lines = [
    headerComment(header),
    '',
    '// The shared namespace: a top-level var is a window property in the browser and a plain binding in the Node test loaders.',
    "var RulesData = typeof RulesData === 'undefined' ? {} : RulesData;",
    '',
    `RulesData.${name} = {`,
  ];
  sections.forEach((section, index) => {
    if (index) lines.push('');
    if (section.comment) lines.push(...commentLines(section.comment, INDENT));
    const prefix = `${keyLiteral(section.key)}: `;
    const decimals = section.decimals || (() => false);
    const body = section.text !== undefined ? section.text : block(section.value, 1, prefix.length, section.expand === undefined ? 1 : section.expand, [], decimals);
    lines.push(`${INDENT}${prefix}${body},`);
  });
  lines.push('};', '');
  return lines.join('\n');
}

function writeIfChanged(file, text) {
  const content = text.replace(/\n/g, '\r\n');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return { status: 'unchanged', lines: content.split('\r\n').length - 1 };
  fs.writeFileSync(file, content);
  return { status: existing === null ? 'created' : 'rewritten', lines: content.split('\r\n').length - 1 };
}

// ── The four files ──────────────────────────────────────────────
function catalogFile(tables) {
  const { Config, Rulesets } = tables;
  const tbc = Rulesets.tbc;
  const drums = 'Not a buff entry: the group-card drum icon reuses these lookup maps (see getDrumsCoverage).';
  const withDrumsNote = text => text.replace(/^(\s*)DRUMS:/m, (_, pad) => `${pad}// ${drums}\n${pad}DRUMS:`);
  const map = (key, comment, value, extra = {}) => ({ key, comment, value: clone(value), expand: 1, ...extra });
  const sections = [
    map('classes', 'Class ids in display order (the TBC list; Classic and Forever reuse it).', tbc.classList),
    map('classColors', 'Class colours (hex).', Config.ClassColors),
    map('roles', 'Role ids, keyed by their constant name.', Config.Roles),
    map('specs', 'Specs per class by talent-tree slot: the spec name and the role it fills.', tbc.specs, { expand: 2 }),
    map('specIcons', 'Icon slugs (icons/<slug>.jpg) for the spec markers.', tbc.specIcons, { expand: 2 }),
    map('raidHelperClassMap', 'Raid-Helper class name -> class id (Tank and Bench carry no class).', Config.RaidHelperClassMap),
    map('defaultRoleForClass', 'Role assumed for a Raid-Helper sign-up that names a class but no spec.', Config.DefaultRoleForClass),
    map('raidHelperSpecMap', 'Raid-Helper spec name -> class, spec and role.', tbc.raidHelperSpecMap),
    map('buffIcons', 'Icon slugs (icons/<slug>.jpg) per buff id.', Config.BuffIcons),
    map('buffAbbreviations', 'Short badge label per buff id.', Config.BuffAbbreviations),
    map('buffCSSClass', 'Badge CSS class per buff id.', Config.BuffCSSClass),
    map('debuffIcons', 'Icon slugs (icons/<slug>.jpg) per debuff id.', Config.DebuffIcons),
    map('debuffAbbreviations', 'Short label per debuff id.', Config.DebuffAbbreviations),
  ];
  for (const section of sections.filter(s => ['buffIcons', 'buffAbbreviations', 'buffCSSClass'].includes(s.key))) {
    section.text = withDrumsNote(block(section.value, 1, section.key.length + 2, 1, [], () => false));
  }
  return {
    file: 'catalog.js',
    name: 'catalog',
    header: {
      title: 'shared catalog',
      summary: 'Pure data shared by every game version: classes, roles, specs and their icons, the Raid-Helper maps, and the icon, '
        + 'abbreviation and CSS-class lookups of every buff and debuff id (including the ids that only Classic or Forever use). '
        + 'The per-version files (tbc.js, classic.js, forever.js) own everything else. Rulesets.compile() takes this catalog as its second argument.',
      research: 'tasks/reference/research-*.md (see the version files).',
    },
    sections,
  };
}

function versionFile(version, tables, report) {
  const { Rulesets } = tables;
  const rules = Rulesets[version];
  const tbc = Rulesets.tbc;
  const specsByClass = tbc.specs;
  if (version !== 'tbc') assertSharedWithTbc(version, rules, tbc);
  noteOrderDifferences(version, rules, report);

  const sections = [
    {
      key: 'buffs', expand: 4, value: buildBuffs(version, rules, tables),
      comment: 'Party buffs the optimizer places, in display order. buffType drives the slot rule in code: one totem per element per '
        + 'shaman, one aura per paladin, one shout per warrior; a passive is always on when its provider is present. weight.dps is what '
        + 'a recipient gains: the exact CLASS:Spec key first, then the bare class name, then the role name, else 0 (multiplied by the '
        + "recipient's specDpsWeight); weight.dps: {} (a buff worth nothing to any recipient's DPS) is written out on purpose, the key "
        + "is explicit; weight.mitigation is the value to a tank (per CLASS:Spec, '*' = any tank); weight.sustain is one "
        + 'number for healer groups. exclusiveBuffs lists the ids that share one slot per party with this one (the better-valued member '
        + 'wins). priority only orders the buff list per role in the UI. spellId is the max-rank spell, a verification handle.',
    },
    {
      key: 'debuffs', expand: 2, value: buildDebuffs(version, rules, tables, report),
      comment: 'Raid debuffs, applied to the enemy. weight is the Open-slot tier (same scale as weight.dps); targetRoles, and targetSchool '
        + 'which narrows casters to one school, say who profits. competesWith and supersededBy model the non-stacking debuff slots. '
        + 'debuffType is descriptive only.',
    },
    {
      key: 'specDpsWeight', value: clone(rules.dpsWeight), decimals: () => true,
      comment: "Expected DPS output per CLASS:Spec relative to the raid's top spec (1.0). A party buff is worth what it multiplies, so a "
        + 'top DPS is placed where it gets buffed before its buff goes to a weaker group.',
    },
    {
      key: 'roleDpsWeight', value: clone(rules.dpsWeightByRole), decimals: () => true,
      comment: 'Weight for a role when the spec has no entry above (0.8 when the role is missing too).',
    },
    { key: 'bestAirTotem', value: clone(rules.bestAirTotem), comment: 'Default air totem per recipient role.' },
    { key: 'bestPaladinAura', value: clone(rules.bestPaladinAura), comment: 'Default paladin aura per recipient role.' },
    { key: 'specAura', value: clone(rules.rules.specAura), comment: 'The aura a paladin spec runs when several auras are valued equally.' },
  ];
  if (rules.rules.spreadProviders) {
    sections.push({
      key: 'spreadProviders', value: clone(rules.rules.spreadProviders),
      comment: 'Providers spread one per group instead of two stacking in one group while another group has none '
        + '(Optimizer.spreadProviders). spec may be a list; no spec = any spec of the class.',
    });
  }
  if ('factionLock' in rules.rules) {
    sections.push({
      key: 'factionLock', value: rules.rules.factionLock,
      comment: 'true: Shaman is Horde-only and Paladin Alliance-only; false: both classes exist on both factions.',
    });
  }
  sections.push({
    key: 'tankAnchorOrder', value: deriveTankAnchorOrder(version, rules, specsByClass),
    comment: 'Tank classes in the order they are picked to anchor the healer/tank group, first wins; every other class ranks after them.',
  });
  if (rules.rules.stackPenalty) {
    sections.push({
      key: 'stackPenalty', value: deriveStackPenalty(version, rules, specsByClass, report),
      comment: 'Penalty weight for a second copy of the same party-buff provider in one group; the penalty is triangular (a third copy costs '
        + 'more than the second) and every matching entry adds. A matcher is { class, spec? }: no spec = every spec of the class.',
    });
  }
  if (rules.rules.healerGroupDps) {
    sections.push({
      key: 'healerGroupDps', value: deriveHealerGroupDps(version, rules, specsByClass, report),
      comment: 'DPS specs the healer/tank group takes as its one overflow seat (exempt from the DPS-guest penalty there).',
    });
  }
  sections.push({
    key: 'conventions', expand: 2, value: buildConventions(version, rules, tables),
    decimals: path => path[0] === 'modeConfig',
    comment: 'Every tuning number and flag the optimizer reads (rules.* before this file), plus modeConfig (objective weights per optimizer '
      + 'mode: only max_dps is supported, the other entries stay so old plans and share links validate) and openSlots (Open-slot pricing scalars).',
  });
  sections.push({ key: 'raids', value: buildRaids(version, tables), comment: 'Raids of this version in picker order; planning templates last.' });
  if (rules.utilities) {
    sections.push({
      key: 'utilities', expand: 2, value: clone(rules.utilities),
      comment: 'Class-presence utility checklist for the readiness sidebar: one-off or in-combat abilities, not always-on party auras. '
        + 'providers lists { class, spec?, note? }; no spec = any spec of the class.',
    });
  }
  const research = {
    tbc: 'tasks/reference/research-synergy-sheet.md (Lokgol TBC synergy tiers) and gruul_dps_data.txt (DPS weights).',
    classic: 'tasks/reference/research-classic-buffs.md (Classic Era buffs, debuffs and raids).',
    forever: 'tasks/reference/research-forever.md (WoW Forever beta audit of 2026-10-10 against build 1.60.1.70338).',
  }[version];
  const summaries = {
    tbc: 'WoW TBC: party buffs and raid debuffs with their weights, the optimizer tuning numbers, raids and utilities.',
    classic: 'WoW Classic Era: party buffs and raid debuffs with their weights, the optimizer tuning numbers, raids and utilities. Faction-aware: Horde shamans, Alliance paladins.',
    forever: 'WoW Forever (beta): party buffs and raid debuffs with their weights, the optimizer tuning numbers and raids. Rules follow the beta data of 2026-10-10 (build 1.60.1.70338); Forever has no faction lock.',
  };
  return {
    file: `${version}.js`,
    name: version,
    header: { title: { tbc: 'TBC', classic: 'Classic Era', forever: 'WoW Forever (beta)' }[version], summary: summaries[version], research },
    sections,
  };
}

// ── Main ────────────────────────────────────────────────────────
function main() {
  const tables = loadLiveTables();
  const report = { otherType: [], defaultWeight: [], inexpressible: [], orderDifferences: [] };
  const files = [catalogFile(tables), ...VERSIONS.map(version => versionFile(version, tables, report))];
  if (report.inexpressible.length) {
    console.error(`Matchers that cannot be expressed as { class, spec }:\n  ${report.inexpressible.join('\n  ')}`);
    fail('nothing was written');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of files) {
    const { status, lines } = writeIfChanged(path.join(OUT_DIR, spec.file), renderDataFile(spec));
    console.log(`${status.padEnd(9)} js/rules/${spec.file}  ${lines} lines`);
  }
  const list = items => (items.length ? `\n  ${items.join('\n  ')}` : ' none');
  console.log(`\ndebuffType 'other':${list(report.otherType)}`);
  console.log(`weight default 2 (no Open-slot tier listed):${list(report.defaultWeight)}`);
  console.log(`matchers that cannot be expressed as { class, spec }:${list(report.inexpressible)}`);
  console.log(`slot tables whose old key order differs from the buff order:${list(report.orderDifferences)}`);
}

main();
