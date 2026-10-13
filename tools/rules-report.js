/**
 * Raidsmith Web - rules report (read-only)
 * Run: node tools/rules-report.js <tbc|classic|forever> [--json]
 *
 * Prints what the optimizer will use for one game version, so a hand edit of js/rules/<version>.js can be reviewed at a glance
 * (README.md, Editing the rules):
 *   (a) the buff-by-recipient DPS weight matrix: one row per buff with any DPS weight, one column per CLASS:Spec of the
 *       catalog (each spec as a player of its default role), a cell = dpsValueFor(buff, player), the weight the optimizer
 *       really uses (the buff's weight.dps for that recipient times the recipient's specDpsWeight / roleDpsWeight; the
 *       "dpsWeight" row shows that second factor); blank = 0;
 *   (b) the mitigation weights per tank spec (mitValueFor) and the sustain weights for healer groups;
 *   (c) the debuffs: id, name, debuffType, who profits, the Open-slot weight, competesWith / supersededBy;
 *   (d) every key of `conventions` flat: its value and the first clause of the comment above it in the data file.
 * Plain text in aligned columns, at most 160 columns wide; --json prints the same data as JSON. Read-only: it loads the
 * page through tests/load-app.js and changes nothing. A bad argument prints a usage line and exits 2.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSIONS = ['tbc', 'classic', 'forever'];
const USAGE = 'Usage: node tools/rules-report.js <tbc|classic|forever> [--json]';
const MAX_WIDTH = 160;

function usageError(message) {
  console.error(`rules-report: ${message}\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const unknownFlag = args.find(a => a.startsWith('-') && a !== '--json');
if (unknownFlag) usageError(`unknown option ${unknownFlag}`);
const positional = args.filter(a => !a.startsWith('-'));
if (positional.length !== 1) usageError(positional.length ? 'give exactly one version' : 'give a version');
const version = positional[0];
if (!VERSIONS.includes(version)) usageError(`unknown version "${version}"`);
const asJson = args.includes('--json');

const app = require('../tests/load-app');
const { State, Rulesets, RulesData, dpsValueFor, dpsWeightFor, mitValueFor } = app.requireLogic(
  ['State', 'Rulesets', 'RulesData', 'dpsValueFor', 'dpsWeightFor', 'mitValueFor'], '_pp_rules_report.tmp.js');
const { catalog } = RulesData;
const data = RulesData[version];
const ruleset = Rulesets[version];
State.gameVersion = version; // dpsValueFor / dpsWeightFor / mitValueFor read the ruleset of the version in play

const round = value => Number(value.toFixed(2));

// ── (a) buff by recipient ───────────────────────────────────────
/** Every CLASS:Spec of the catalog as a player of its default role, in catalog order. */
function recipients() {
  const list = [];
  for (const cls of catalog.classes) {
    for (const slot of Object.keys(catalog.specs[cls]).sort((a, b) => a - b)) {
      const { name, role } = catalog.specs[cls][slot];
      const words = name.split(' ');
      list.push({ key: `${cls}:${name}`, class: cls, spec: name, role, code: words.length > 1 ? words.map(w => w[0]).join('') : name.slice(0, 3) });
    }
  }
  return list;
}

function dpsMatrix(players) {
  const rows = [];
  for (const [id, buff] of Object.entries(data.buffs)) {
    const values = {};
    for (const p of players) {
      const value = round(dpsValueFor(id, { class: p.class, spec: p.spec, role: p.role }));
      if (value) values[p.key] = value;
    }
    if (Object.keys(values).length) rows.push({ id, name: buff.name, values });
  }
  return {
    columns: players.map(p => ({ key: p.key, role: p.role, dpsWeight: round(dpsWeightFor({ class: p.class, spec: p.spec, role: p.role })) })),
    rows,
  };
}

// ── (b) mitigation and sustain ──────────────────────────────────
function mitigationTable(players) {
  const named = new Set();
  for (const buff of Object.values(data.buffs)) for (const key of Object.keys((buff.weight || {}).mitigation || {})) if (key !== '*') named.add(key);
  const tanks = players.filter(p => p.role === 'tank' || named.has(p.key));
  const rows = [];
  for (const [id, buff] of Object.entries(data.buffs)) {
    const values = {};
    for (const p of tanks) {
      const value = round(mitValueFor(id, { class: p.class, spec: p.spec, role: 'tank' }));
      if (value) values[p.key] = value;
    }
    const sustain = ruleset.sustainValue[id];
    if (Object.keys(values).length || sustain) rows.push({ id, name: buff.name, values, sustain: sustain || 0 });
  }
  return { tanks: tanks.map(p => p.key), rows };
}

// ── (c) debuffs ─────────────────────────────────────────────────
function debuffTable() {
  return Object.entries(data.debuffs).map(([id, d]) => ({
    id,
    name: d.name,
    debuffType: d.debuffType,
    targets: d.targetSchool ? `${d.targetRoles.join('+')} (${d.targetSchool})` : d.targetRoles.join('+'),
    weight: d.weight,
    competesWith: d.competesWith || [],
    supersededBy: d.supersededBy || null,
  }));
}

// ── (d) conventions with the first clause of their comment ──────
/** path -> text of the last paragraph of the comment block right above that entry of the conventions block in the data file. */
function conventionComments() {
  const lines = fs.readFileSync(path.join(app.ROOT, 'js', 'rules', `${version}.js`), 'utf8').split(/\r?\n/);
  const start = lines.findIndex(l => l === '  conventions: {');
  const comments = new Map();
  if (start < 0) return comments;
  const stack = [];
  for (let i = start + 1; i < lines.length && lines[i] !== '  },'; i++) {
    const open = /^( *)([A-Za-z_]\w*): \{$/.exec(lines[i]);
    const leaf = /^( *)([A-Za-z_]\w*): (?!\{$).+$/.exec(lines[i]);
    const close = /^( *)\},?$/.exec(lines[i]);
    if (close) { stack.pop(); continue; }
    const entry = open || leaf;
    if (!entry) continue;
    const entryPath = [...stack, entry[2]].join('.');
    const block = [];
    for (let j = i - 1; j > start && /^\s*\/\//.test(lines[j]); j--) block.unshift(lines[j].replace(/^\s*\/\/ ?/, ''));
    const paragraph = [];
    for (let j = block.length - 1; j >= 0 && block[j].trim() !== ''; j--) paragraph.unshift(block[j].trim());
    if (paragraph.length) comments.set(entryPath, paragraph.join(' '));
    if (open) stack.push(entry[2]);
  }
  return comments;
}

function firstClause(text) {
  if (!text) return '';
  const cut = [text.indexOf(';'), text.search(/\. /)].filter(at => at >= 0);
  return (cut.length ? text.slice(0, Math.min(...cut)) : text).replace(/\.$/, '').trim();
}

function flatten(value, prefix, out) {
  for (const [key, inner] of Object.entries(value)) {
    const entryPath = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === 'object') flatten(inner, entryPath, out);
    else out.push({ key: entryPath, value: inner });
  }
  return out;
}

function conventionsTable() {
  const comments = conventionComments();
  const noteFor = entryPath => {
    for (let at = entryPath; at; at = at.includes('.') ? at.slice(0, at.lastIndexOf('.')) : '') {
      if (comments.has(at)) return firstClause(comments.get(at));
    }
    return '';
  };
  return flatten(data.conventions, '', []).map(({ key, value }) => ({ key, value, note: noteFor(key) }));
}

// ── Build ───────────────────────────────────────────────────────
const players = recipients();
const report = {
  version,
  file: `js/rules/${version}.js`,
  dpsWeights: dpsMatrix(players),
  mitigation: mitigationTable(players),
  debuffs: debuffTable(),
  conventions: conventionsTable(),
};

// ── Plain text ──────────────────────────────────────────────────
const out = [];
const fit = line => (line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH - 3)}...` : line).replace(/\s+$/, '');
const say = (line = '') => out.push(fit(line));
const shown = value => (value === null ? 'null' : String(value));

function printDpsMatrix() {
  const { columns, rows } = report.dpsWeights;
  const labelWidth = Math.max(4, ...rows.map(r => r.id.length));
  const cellWidth = widthFor(labelWidth, columns.length, rows.flatMap(r => Object.values(r.values)), columns.map(c => c.dpsWeight));
  const fmt = value => (value === undefined || value === 0 ? '' : String(roundTo(value, cellWidth.decimals)));
  const classHeader = [];
  for (const cls of catalog.classes) classHeader.push(` ${cls}`.padEnd(3 * (cellWidth.width + 1)));
  say('(a) Buff by recipient: the DPS weight the optimizer uses (dpsValueFor = weight.dps of the buff x the recipient\'s DPS weight).');
  say(`    One column per CLASS:Spec, each as a player of its default role; blank = 0${cellWidth.decimals < 2 ? '; rounded to 1 decimal to fit 160 columns (--json is exact)' : ''}.`);
  say();
  say(`${''.padEnd(labelWidth)}${classHeader.join('')}`);
  say(`${'buff'.padEnd(labelWidth)}${players.map(p => ` ${p.code.padStart(cellWidth.width)}`).join('')}`);
  say(`${'dpsWeight'.padEnd(labelWidth)}${columns.map(c => ` ${fmt(c.dpsWeight).padStart(cellWidth.width)}`).join('')}`);
  for (const row of rows) say(`${row.id.padEnd(labelWidth)}${columns.map(c => ` ${fmt(row.values[c.key]).padStart(cellWidth.width)}`).join('')}`);
  say();
}

function roundTo(value, decimals) {
  return Number(value.toFixed(decimals));
}

/** The column width for the matrix, and how many decimals fit in MAX_WIDTH. */
function widthFor(labelWidth, columnCount, cells, weights) {
  for (const decimals of [2, 1]) {
    const longest = Math.max(3, ...[...cells, ...weights].map(v => String(roundTo(v, decimals)).length));
    if (labelWidth + columnCount * (longest + 1) <= MAX_WIDTH) return { width: longest, decimals };
  }
  return { width: 3, decimals: 1 };
}

function printMitigation() {
  const { tanks, rows } = report.mitigation;
  const labelWidth = Math.max(4, ...rows.map(r => r.id.length));
  const width = Math.max(...tanks.map(t => t.length), 7);
  say('(b) Mitigation weight per tank spec (mitValueFor: the spec\'s own key, else the \'*\' fallback) and the sustain weight of healer groups.');
  say();
  say(`${'buff'.padEnd(labelWidth)}${tanks.map(t => ` ${t.padStart(width)}`).join('')} ${'sustain'.padStart(7)}`);
  for (const row of rows) {
    say(`${row.id.padEnd(labelWidth)}${tanks.map(t => ` ${(row.values[t] === undefined ? '' : String(row.values[t])).padStart(width)}`).join('')} ${(row.sustain ? String(row.sustain) : '').padStart(7)}`);
  }
  say();
}

function printDebuffs() {
  const rows = report.debuffs;
  const col = (key, min) => Math.max(min, ...rows.map(r => String(r[key]).length));
  const idW = col('id', 2), nameW = col('name', 4), typeW = col('debuffType', 10), targetW = col('targets', 7);
  say('(c) Debuffs: who profits, the Open-slot weight, and the slots they compete for.');
  say();
  say(`${'id'.padEnd(idW)} ${'name'.padEnd(nameW)} ${'debuffType'.padEnd(typeW)} ${'targets'.padEnd(targetW)} weight  competesWith / supersededBy`);
  for (const r of rows) {
    const slots = [r.competesWith.length ? `competes with ${r.competesWith.join(', ')}` : '', r.supersededBy ? `superseded by ${r.supersededBy}` : ''].filter(Boolean).join('; ');
    const head = `${r.id.padEnd(idW)} ${r.name.padEnd(nameW)} ${r.debuffType.padEnd(typeW)} ${r.targets.padEnd(targetW)} ${String(r.weight).padStart(6)}  `;
    // A long slot list continues on the next lines, under its own column.
    const [first, ...more] = wrapWords(slots, Math.max(20, MAX_WIDTH - head.length));
    say(`${head}${first || ''}`);
    for (const line of more) say(`${' '.repeat(head.length)}${line}`);
  }
  say();
}

/** Greedy word wrap to `width` columns; always returns at least one (possibly empty) line. */
function wrapWords(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines;
}

function printConventions() {
  const rows = report.conventions;
  const keyW = Math.max(...rows.map(r => r.key.length));
  const valueW = Math.max(...rows.map(r => shown(r.value).length));
  say(`(d) Conventions (${report.file}, conventions): every tuning number and flag, with the first clause of the comment above it.`);
  say();
  say(`${'key'.padEnd(keyW)} ${'value'.padStart(valueW)}  what it is`);
  for (const r of rows) say(`${r.key.padEnd(keyW)} ${shown(r.value).padStart(valueW)}  ${r.note}`);
}

function printText() {
  say(`Rules report: ${version} (${report.file}). Read-only; node boards-tests.js shows who moves after an edit.`);
  say();
  printDpsMatrix();
  printMitigation();
  printDebuffs();
  printConventions();
  console.log(out.join('\n'));
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else printText();
