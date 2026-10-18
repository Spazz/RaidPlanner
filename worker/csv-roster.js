// Roster CSV import, the pure half (no I/O): reading a CSV or TSV text, finding its columns, and turning each line into a roster row
// { name, class, spec, realm, team, isAlt, status, joinedOn, owner } with the problems that stop it and the notes that do not.
// worker/routes/roster-import-csv.js asks the database about the rows (who is on the roster already, which team a name is) and commits.
//
// Columns (header names are matched case-insensitively, ignoring spaces, dashes and underscores; the order does not matter):
//   name (character, character name)  class  spec (specialization)  realm (server)  team (raid team, raid group)
//   main/alt (type, is alt, is main)  status  joined (joined on, date joined, created at)
//   owner (player, member, username, discord, account): the person a character belongs to; rows sharing an owner are one person's characters
// A file with no recognised header row is read in that order: name, class, spec, realm, team, main/alt, status, joined.
// ThatsMyBIS "characters" exports are accepted by these names (name, class, spec, is_alt, raid_group, username / discord_username, created_at).
import { CLASSES, SPECS, allowsSurname, cleanCharacterName } from './roster-data.js';

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_CHARS = 200 * 1024;
export const CSV_FIELDS = ['name', 'class', 'spec', 'realm', 'team', 'mainalt', 'status', 'joined', 'owner'];
export const POSITIONAL = ['name', 'class', 'spec', 'realm', 'team', 'mainalt', 'status', 'joined'];

const HEADER_ALIASES = {
  name: ['name', 'character', 'charactername', 'char', 'charname'],
  class: ['class', 'classname', 'wowclass'],
  spec: ['spec', 'specialization', 'mainspec', 'specname'],
  realm: ['realm', 'server', 'realmname'],
  team: ['team', 'raidteam', 'raidgroup', 'raidgroupname', 'group', 'roster'],
  mainalt: ['mainalt', 'type', 'kind', 'alt', 'isalt', 'main', 'ismain'],
  status: ['status', 'memberstatus'],
  joined: ['joined', 'joinedon', 'datejoined', 'joindate', 'dateadded', 'createdat', 'added'],
  owner: ['owner', 'player', 'member', 'membername', 'username', 'discord', 'discordname', 'discordusername', 'account', 'mainname', 'maincharacter', 'mainchar'],
};
const FIELD_OF_HEADER = Object.fromEntries(Object.entries(HEADER_ALIASES).flatMap(([field, names]) => names.map((name) => [name, field])));
// Headers whose cell is a yes/no about the character instead of the words main / alt.
const BOOLEAN_ALT = { alt: 'alt', isalt: 'alt', main: 'main', ismain: 'main' };

const normHeader = (cell) => String(cell).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// Reading the text

function detectDelimiter(text) {
  let line = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '\n' || ch === '\r')) { if (line.trim()) break; line = ''; continue; }
    line += ch;
  }
  const count = (delimiter) => {
    let n = 0;
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) n += 1;
    }
    return n;
  };
  const best = [',', ';', '\t'].map((delimiter) => ({ delimiter, n: count(delimiter) })).sort((a, b) => b.n - a.n)[0];
  return best.n > 0 ? best.delimiter : ',';
}

// -> { ok: true, delimiter, records: string[][] } (blank lines dropped, at most CSV_MAX_ROWS + 1 records) or { ok: false, message }.
export function readCsvText(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'Paste or upload a CSV first.' };
  const text = raw.replace(/^﻿/, '');
  if (!text.trim()) return { ok: false, message: 'Paste or upload a CSV first.' };
  if (text.length > CSV_MAX_CHARS) return { ok: false, message: `That file is too large (at most ${Math.round(CSV_MAX_CHARS / 1024)} KB).` };
  const delimiter = detectDelimiter(text);
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      if (records.length > CSV_MAX_ROWS + 1) break;
      continue;
    }
    field += ch;
    fieldStarted = true;
  }
  if (inQuotes) return { ok: false, message: 'A quoted value in that file is never closed.' };
  if (field !== '' || row.length) endRow();
  if (!records.length) return { ok: false, message: 'That file has no rows.' };
  return { ok: true, delimiter, records };
}

// The columns of a file: { header: boolean, columns: [field | null per column], altStyle: 'word' | 'alt' | 'main' }. The first record is a header
// when at least two of its cells (or the only one) are names a column can have; otherwise the positional order applies.
export function findColumns(firstRecord) {
  const fields = firstRecord.map((cell) => FIELD_OF_HEADER[normHeader(cell)] || null);
  const known = fields.filter(Boolean).length;
  if (known >= 2 || fields[0] === 'name' || (known === 1 && firstRecord.length === 1)) {
    const seen = new Set();
    const columns = fields.map((field) => (field && !seen.has(field) ? (seen.add(field), field) : null));
    const altIndex = firstRecord.findIndex((cell, i) => columns[i] === 'mainalt');
    const altStyle = altIndex >= 0 && BOOLEAN_ALT[normHeader(firstRecord[altIndex])] ? BOOLEAN_ALT[normHeader(firstRecord[altIndex])] : 'word';
    return { header: true, columns, altStyle };
  }
  return { header: false, columns: firstRecord.map((_, i) => POSITIONAL[i] || null), altStyle: 'word' };
}

// ---------------------------------------------------------------------------
// Cells

const CLASS_BY_TEXT = Object.fromEntries(CLASSES.flatMap((entry) => [[entry.id.toLowerCase(), entry.id], [entry.name.toLowerCase(), entry.id]]));
export const classOfText = (text) => CLASS_BY_TEXT[String(text).trim().toLowerCase()] || null;

// Short spec names people type. A name that is one spec of every class that has it ("Holy", "Restoration") resolves through the class.
const SPEC_ALIASES = {
  prot: 'Protection', protection: 'Protection', resto: 'Restoration', restoration: 'Restoration', ret: 'Retribution', retri: 'Retribution',
  enh: 'Enhancement', enhance: 'Enhancement', ele: 'Elemental', elem: 'Elemental', bm: 'Beast Mastery', beastmastery: 'Beast Mastery', 'beast mastery': 'Beast Mastery',
  mm: 'Marksmanship', marks: 'Marksmanship', sv: 'Survival', surv: 'Survival', disc: 'Discipline', sub: 'Subtlety', assa: 'Assassination', assassin: 'Assassination',
  destro: 'Destruction', demo: 'Demonology', affli: 'Affliction', aff: 'Affliction', boomkin: 'Balance', boomy: 'Balance', moonkin: 'Balance',
  feral: 'Feral (DPS)', cat: 'Feral (DPS)', 'feral combat': 'Feral (DPS)', 'feral dps': 'Feral (DPS)', 'feral (dps)': 'Feral (DPS)',
  bear: 'Feral (Tank)', guardian: 'Feral (Tank)', 'feral tank': 'Feral (Tank)', 'feral (tank)': 'Feral (Tank)',
};

// -> the roster's spec label for the class, or null.
export function specOfText(classId, text) {
  const wanted = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted || !SPECS[classId]) return null;
  const exact = SPECS[classId].find((spec) => spec.toLowerCase() === wanted);
  if (exact) return exact;
  const alias = SPEC_ALIASES[wanted] || SPEC_ALIASES[wanted.replace(/\s/g, '')];
  return alias && SPECS[classId].includes(alias) ? alias : null;
}

const STATUS_WORDS = {
  raider: 'raider', core: 'raider', member: 'raider', active: 'raider', main: 'raider',
  trial: 'trial', trialist: 'trial', probation: 'trial', recruit: 'trial', initiate: 'trial',
  reserve: 'reserve', bench: 'reserve', backup: 'reserve', standby: 'reserve', social: 'reserve',
};
export const statusOfText = (text) => STATUS_WORDS[String(text).trim().toLowerCase()] || null;

// 2026-10-18, 2026/10/18, or an ISO date-time (the date part). Anything else (12/10/2026 is a day or a month first?) is refused.
export function dateOfText(text) {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ].*)?$/.exec(String(text).trim());
  if (!match) return null;
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

const YES = new Set(['1', 'true', 'yes', 'y', 'x', 't']);
const NO = new Set(['0', 'false', 'no', 'n', 'f']);

// Whether the cell says the character is an alt: true / false, or null when the cell is blank. undefined: the cell is neither.
function altOfText(text, style) {
  const value = String(text).trim().toLowerCase();
  if (!value) return null;
  if (style === 'word') {
    if (value === 'alt' || value === 'secondary' || value === 'twink') return true;
    if (value === 'main' || value === 'primary') return false;
    return undefined;
  }
  const yes = YES.has(value);
  if (!yes && !NO.has(value)) return undefined;
  return style === 'alt' ? yes : !yes;
}

// ---------------------------------------------------------------------------
// Rows

// records: the data records (header dropped). layout: findColumns' result. context: { defaultTeam: { id, name }, teams: [{ id, name }], realmGuild: boolean,
// defaultStatus, gameVersion }. -> [{ line, name, class, spec, realm, teamId, teamName, isAlt, status, joinedOn, owner, problems: [], notes: [] }]
export function mapRows(records, layout, context, firstLine) {
  const teamByName = new Map(context.teams.map((team) => [team.name.trim().toLowerCase(), team]));
  return records.map((record, i) => {
    const cell = (field) => {
      const index = layout.columns.indexOf(field);
      return index >= 0 && index < record.length ? String(record[index]).trim() : '';
    };
    const problems = [];
    const notes = [];
    const rawName = cell('name');
    const name = rawName ? cleanCharacterName(rawName, context.gameVersion) : null;
    if (!rawName) problems.push('The character has no name.');
    else if (!name) problems.push(`"${rawName.slice(0, 20)}" is not a character name (2 to 12 letters${allowsSurname(context.gameVersion) ? ', or a first name and a surname' : ''}).`);

    const rawClass = cell('class');
    const classId = rawClass ? classOfText(rawClass) : null;
    if (!rawClass) problems.push('The class is missing.');
    else if (!classId) problems.push(`"${rawClass.slice(0, 20)}" is not a class.`);

    let spec = null;
    const rawSpec = cell('spec');
    if (rawSpec && classId) {
      spec = specOfText(classId, rawSpec);
      if (!spec) notes.push(`The spec "${rawSpec.slice(0, 20)}" is not one of the class, so no spec is set.`);
      else if (/^feral$/i.test(rawSpec.trim())) notes.push('Feral was read as Feral (DPS).');
    }

    let team = context.defaultTeam;
    const rawTeam = cell('team');
    if (rawTeam) {
      team = teamByName.get(rawTeam.toLowerCase()) || null;
      if (!team) problems.push(`There is no active team called "${rawTeam.slice(0, 30)}".`);
    }

    const rawStatus = cell('status');
    let status = context.defaultStatus;
    if (rawStatus) {
      status = statusOfText(rawStatus);
      if (!status) problems.push(`The status "${rawStatus.slice(0, 20)}" is not Raider, Trial or Reserve.`);
    }

    const rawJoined = cell('joined');
    let joinedOn = null;
    if (rawJoined) {
      joinedOn = dateOfText(rawJoined);
      if (!joinedOn) problems.push(`"${rawJoined.slice(0, 20)}" is not a date. Use 2026-10-18.`);
    }

    const rawAlt = cell('mainalt');
    let isAlt = null;
    if (rawAlt) {
      isAlt = altOfText(rawAlt, layout.altStyle);
      if (isAlt === undefined) { isAlt = null; problems.push(`"${rawAlt.slice(0, 20)}" is not Main or Alt.`); }
    }

    let realm = null;
    if (context.realmGuild) {
      realm = cell('realm') || null;
    }
    const owner = cell('owner').slice(0, 64) || null;

    return {
      line: firstLine + i, name, class: classId, spec, realm, teamId: team ? team.id : null, teamName: team ? team.name : null,
      isAlt, status, joinedOn, owner, problems, notes,
    };
  });
}

// Rows with the same owner (case-insensitive) are one person's characters; an owner that is the name of another row's character (the main) puts
// the row with that character. For each row that has no problem and is not already on the roster
// (taken), says what the file means: { action: 'new' | 'alt' | 'skip', withLine: line of the row it belongs to (alt of a new row), needsDecision }.
// An alt row with no main in the file needs a decision (alt of a person already on the roster, or a person of its own).
export function planRows(rows) {
  const plan = new Map();
  const groups = new Map();
  const live = rows.filter((row) => !row.problems.length && !row.taken);
  const byName = new Map(live.map((row) => [row.name.toLowerCase(), row]));
  const keyOf = (row) => {
    if (!row.owner) return `solo:${row.line}`;
    const target = byName.get(row.owner.toLowerCase());
    if (target && target !== row && !target.owner) return `solo:${target.line}`;
    return `owner:${row.owner.toLowerCase()}`;
  };
  rows.forEach((row) => {
    if (row.problems.length || row.taken) { plan.set(row.line, { action: 'skip', withLine: null, needsDecision: false }); return; }
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  for (const members of groups.values()) {
    const main = members.find((row) => row.isAlt !== true) || null;
    if (main) {
      plan.set(main.line, { action: 'new', withLine: null, needsDecision: false });
      for (const row of members) {
        if (row === main) continue;
        plan.set(row.line, { action: 'alt', withLine: main.line, needsDecision: false });
      }
      continue;
    }
    for (const row of members) plan.set(row.line, { action: 'alt', withLine: null, needsDecision: true });
  }
  return plan;
}
